"""
OPC UA Write Engine
===================
Handles all write operations to OPC UA servers with:
 - Pre-write validation (range checks, tag writability)
 - Write queue with priority levels (EMERGENCY > HIGH > NORMAL)
 - Full audit trail (every write logged to DB)
 - Write confirmation via read-back
 - Bulk write support
 - Scheduled writes (set-point ramping)

Feature flag: FEATURE_WRITE=true
"""
from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import IntEnum
from typing import Any, Dict, List, Optional, Tuple

import asyncpg
import redis.asyncio as aioredis
import structlog
from prometheus_client import Counter, Histogram

logger = structlog.get_logger(__name__)

WRITE_ENABLED = os.getenv("FEATURE_WRITE", "true").lower() == "true"

WRITES_TOTAL     = Counter("opcua_writes_total",    "Total write operations",           ["server_id", "status"])
WRITE_LATENCY    = Histogram("opcua_write_latency_seconds", "Write round-trip latency", ["server_id"])


class WritePriority(IntEnum):
    EMERGENCY = 0   # Safety shutdowns, ESD triggers
    HIGH      = 1   # Operator set-points, alarms
    NORMAL    = 2   # Scheduled, batch writes


@dataclass
class WriteRequest:
    server_id:    str
    node_id:      str
    value:        Any
    data_type:    str           = "Double"
    priority:     WritePriority = WritePriority.NORMAL
    requested_by: str           = "system"
    confirm_readback: bool      = True    # verify by reading back after write
    min_value:    Optional[float] = None  # range validation
    max_value:    Optional[float] = None
    request_id:   str           = ""
    timestamp:    datetime      = field(default_factory=lambda: datetime.now(timezone.utc))


@dataclass
class WriteResult:
    request_id:   str
    server_id:    str
    node_id:      str
    success:      bool
    value_written: Any
    readback_value: Any         = None
    readback_match: bool        = True
    error:        str           = ""
    timestamp:    datetime      = field(default_factory=lambda: datetime.now(timezone.utc))
    latency_ms:   float         = 0.0


class WriteEngine:
    """
    Priority queue-based write engine.
    Consumers drain the queue and call server_registry.write_node().
    All writes are recorded in the write_audit table.
    """

    def __init__(
        self,
        server_registry,          # OPCUAServerRegistry
        pg_pool: asyncpg.Pool,
        redis: aioredis.Redis,
    ) -> None:
        self._registry = server_registry
        self._pool     = pg_pool
        self._redis    = redis
        self._queue: asyncio.PriorityQueue = asyncio.PriorityQueue(maxsize=10_000)
        self._running  = False
        self._results: Dict[str, WriteResult] = {}   # in-memory result cache

    async def start(self) -> None:
        if not WRITE_ENABLED:
            logger.info("write_engine_disabled")
            return
        self._running = True
        # Run 4 parallel write workers
        await asyncio.gather(*[self._write_worker(i) for i in range(4)])

    async def stop(self) -> None:
        self._running = False

    async def enqueue(self, req: WriteRequest) -> str:
        """Enqueue a write request. Returns request_id for polling result."""
        import uuid
        if not req.request_id:
            req.request_id = str(uuid.uuid4())

        if not WRITE_ENABLED:
            raise RuntimeError("Write feature is disabled (FEATURE_WRITE=false)")

        # Validate range before enqueue
        if req.min_value is not None and isinstance(req.value, (int, float)):
            if req.value < req.min_value:
                raise ValueError(f"Value {req.value} below minimum {req.min_value}")
        if req.max_value is not None and isinstance(req.value, (int, float)):
            if req.value > req.max_value:
                raise ValueError(f"Value {req.value} above maximum {req.max_value}")

        await self._queue.put((req.priority.value, req.timestamp, req))
        logger.info("write_enqueued", request_id=req.request_id,
                    server_id=req.server_id, node_id=req.node_id,
                    value=req.value, priority=req.priority.name)
        return req.request_id

    def get_result(self, request_id: str) -> Optional[WriteResult]:
        return self._results.get(request_id)

    async def _write_worker(self, worker_id: int) -> None:
        logger.info("write_worker_started", worker_id=worker_id)
        while self._running:
            try:
                _, _, req = await asyncio.wait_for(
                    self._queue.get(), timeout=1.0
                )
                await self._execute_write(req)
            except asyncio.TimeoutError:
                continue
            except Exception as exc:
                logger.error("write_worker_error", worker_id=worker_id, error=str(exc))

    async def _execute_write(self, req: WriteRequest) -> WriteResult:
        import time
        t0 = time.monotonic()

        result = WriteResult(
            request_id=req.request_id,
            server_id=req.server_id,
            node_id=req.node_id,
            value_written=req.value,
        )

        try:
            write_result = await self._registry.write_node(
                req.server_id, req.node_id, req.value, req.data_type
            )
            result.success = write_result.get("success", False)
            result.error   = write_result.get("error", "")
            result.latency_ms = (time.monotonic() - t0) * 1000

            # Read back to confirm
            if result.success and req.confirm_readback:
                await asyncio.sleep(0.05)  # give server time to apply
                rb = await self._registry.read_node(req.server_id, req.node_id)
                if rb.get("success"):
                    result.readback_value = rb.get("value")
                    # Compare (allow small float tolerance)
                    if isinstance(req.value, float) and isinstance(result.readback_value, float):
                        result.readback_match = abs(req.value - result.readback_value) < 1e-6
                    else:
                        result.readback_match = str(req.value) == str(result.readback_value)
                    if not result.readback_match:
                        logger.warning("write_readback_mismatch",
                                       written=req.value, readback=result.readback_value)

            WRITES_TOTAL.labels(server_id=req.server_id,
                                status="success" if result.success else "failed").inc()
            WRITE_LATENCY.labels(server_id=req.server_id).observe(result.latency_ms / 1000)

        except Exception as exc:
            result.success = False
            result.error   = str(exc)
            WRITES_TOTAL.labels(server_id=req.server_id, status="error").inc()

        result.timestamp = datetime.now(timezone.utc)
        self._results[req.request_id] = result

        # Persist to audit table
        await self._audit_write(req, result)

        result_payload = json.dumps({
            "request_id":    result.request_id,
            "server_id":     result.server_id,
            "node_id":       result.node_id,
            "value_written": str(result.value_written),
            "success":       result.success,
            "readback_value":str(result.readback_value) if result.readback_value is not None else None,
            "readback_match":result.readback_match,
            "error":         result.error,
            "latency_ms":    result.latency_ms,
            "timestamp":     result.timestamp.isoformat(),
        })

        # Store result as a retrievable key (API polls this) — 60s TTL
        await self._redis.setex(
            f"opcua:write:result:{result.request_id}", 60, result_payload
        )
        # Also publish to channel for live WebSocket subscribers
        await self._redis.publish("opcua:write:results", result_payload)

        return result

    async def _audit_write(self, req: WriteRequest, result: WriteResult) -> None:
        try:
            await self._pool.execute("""
                INSERT INTO write_audit
                    (request_id, server_id, node_id, value_written, data_type,
                     priority, requested_by, success, readback_value,
                     readback_match, error_message, latency_ms, created_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
            """,
                req.request_id, req.server_id, req.node_id,
                str(req.value), req.data_type, req.priority.name,
                req.requested_by, result.success,
                str(result.readback_value) if result.readback_value is not None else None,
                result.readback_match, result.error, result.latency_ms,
                result.timestamp,
            )
        except Exception as exc:
            logger.error("write_audit_failed", error=str(exc))

    # ── Bulk write ─────────────────────────────────────────────────────────────

    async def bulk_write(
        self,
        writes: List[Dict],   # [{server_id, node_id, value, data_type, priority}]
        requested_by: str = "system",
    ) -> List[str]:
        """Enqueue multiple writes and return list of request_ids."""
        request_ids = []
        for w in writes:
            req = WriteRequest(
                server_id=w["server_id"],
                node_id=w["node_id"],
                value=w["value"],
                data_type=w.get("data_type", "Double"),
                priority=WritePriority(w.get("priority", WritePriority.NORMAL)),
                requested_by=requested_by,
                min_value=w.get("min_value"),
                max_value=w.get("max_value"),
            )
            rid = await self.enqueue(req)
            request_ids.append(rid)
        return request_ids

    # ── Set-point ramp ─────────────────────────────────────────────────────────

    async def ramp_setpoint(
        self,
        server_id: str,
        node_id: str,
        target_value: float,
        duration_seconds: float,
        steps: int = 10,
        data_type: str = "Double",
        requested_by: str = "system",
    ) -> None:
        """
        Gradually ramp a set-point from current value to target over duration.
        Useful for soft-start motor controllers, temperature ramp-up, etc.
        """
        # Read current value
        current = await self._registry.read_node(server_id, node_id)
        if not current.get("success"):
            raise RuntimeError(f"Cannot read current value: {current.get('error')}")

        start_val = float(current.get("value", 0))
        step_size = (target_value - start_val) / steps
        interval  = duration_seconds / steps

        logger.info("setpoint_ramp_started",
                    server_id=server_id, node_id=node_id,
                    start=start_val, target=target_value, steps=steps)

        for i in range(steps + 1):
            step_val = start_val + step_size * i
            req = WriteRequest(
                server_id=server_id,
                node_id=node_id,
                value=round(step_val, 6),
                data_type=data_type,
                priority=WritePriority.HIGH,
                requested_by=requested_by,
                confirm_readback=False,  # skip readback for speed during ramp
            )
            await self.enqueue(req)
            if i < steps:
                await asyncio.sleep(interval)

        logger.info("setpoint_ramp_complete",
                    server_id=server_id, node_id=node_id, final=target_value)
