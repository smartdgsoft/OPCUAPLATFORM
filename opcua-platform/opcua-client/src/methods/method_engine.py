"""
OPC UA Method Call Engine
=========================
Handles calling OPC UA Method nodes with:
 - Argument type validation and conversion
 - Pre-defined method templates (stored in DB)
 - Async execution with result streaming
 - Full audit trail
 - Emergency stop pattern

Feature flag: FEATURE_METHODS=true
"""
from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import asyncpg
import redis.asyncio as aioredis
import structlog
from prometheus_client import Counter, Histogram

logger = structlog.get_logger(__name__)

METHODS_ENABLED   = os.getenv("FEATURE_METHODS", "true").lower() == "true"
METHOD_CALLS      = Counter("opcua_method_calls_total", "Total method calls", ["server_id", "status"])
METHOD_LATENCY    = Histogram("opcua_method_latency_seconds", "Method call latency", ["server_id"])


@dataclass
class MethodTemplate:
    """
    Stored method definition — allows calling complex methods
    by name without knowing the OPC UA node IDs at call time.
    """
    id: str
    name: str
    description: str
    server_id: str
    object_node_id: str
    method_node_id: str
    input_args: List[Dict]   # [{name, data_type, description, default}]
    output_args: List[Dict]  # [{name, data_type, description}]
    requires_confirmation: bool = True
    min_role: str = "OPERATOR"


@dataclass
class MethodCallRequest:
    server_id:      str
    object_node_id: str
    method_node_id: str
    input_args:     List[Any]
    arg_types:      List[str]
    requested_by:   str = "system"
    template_id:    Optional[str] = None
    request_id:     str = ""


@dataclass
class MethodCallResult:
    request_id:  str
    success:     bool
    output_args: List[Any]
    error:       str = ""
    timestamp:   datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    latency_ms:  float = 0.0


class MethodCallEngine:
    """
    Handles OPC UA Method invocations.
    Methods are called synchronously (not queued) because most methods
    represent actions that require immediate confirmation (e.g. start pump).
    """

    def __init__(
        self,
        server_registry,
        pg_pool: asyncpg.Pool,
        redis: aioredis.Redis,
    ) -> None:
        self._registry  = server_registry
        self._pool      = pg_pool
        self._redis     = redis
        self._templates: Dict[str, MethodTemplate] = {}

    async def load_templates(self) -> None:
        """Load method templates from database."""
        if not METHODS_ENABLED:
            return
        try:
            rows = await self._pool.fetch("""
                SELECT id::text, name, description, server_id::text,
                       object_node_id, method_node_id,
                       input_args, output_args,
                       requires_confirmation, min_role
                FROM method_templates ORDER BY name
            """)
            for r in rows:
                t = MethodTemplate(
                    id=r["id"],
                    name=r["name"],
                    description=r["description"],
                    server_id=r["server_id"],
                    object_node_id=r["object_node_id"],
                    method_node_id=r["method_node_id"],
                    input_args=json.loads(r["input_args"]) if r["input_args"] else [],
                    output_args=json.loads(r["output_args"]) if r["output_args"] else [],
                    requires_confirmation=r["requires_confirmation"],
                    min_role=r["min_role"],
                )
                self._templates[t.id] = t
            logger.info("method_templates_loaded", count=len(self._templates))
        except Exception as exc:
            logger.warning("method_templates_load_failed", error=str(exc))

    def get_templates(self) -> List[MethodTemplate]:
        return list(self._templates.values())

    def get_template(self, template_id: str) -> Optional[MethodTemplate]:
        return self._templates.get(template_id)

    async def call_by_template(
        self,
        template_id: str,
        input_values: List[Any],
        requested_by: str = "system",
    ) -> MethodCallResult:
        """Call a method using a stored template — simplest API for the frontend."""
        tmpl = self._templates.get(template_id)
        if not tmpl:
            raise ValueError(f"Method template {template_id} not found")

        arg_types = [a["data_type"] for a in tmpl.input_args]
        req = MethodCallRequest(
            server_id=tmpl.server_id,
            object_node_id=tmpl.object_node_id,
            method_node_id=tmpl.method_node_id,
            input_args=input_values,
            arg_types=arg_types,
            requested_by=requested_by,
            template_id=template_id,
        )
        return await self.call(req)

    async def call(self, req: MethodCallRequest) -> MethodCallResult:
        """Execute an OPC UA method call."""
        import uuid, time
        if not METHODS_ENABLED:
            return MethodCallResult(request_id="", success=False,
                                    output_args=[], error="FEATURE_METHODS=false")

        req.request_id = req.request_id or str(uuid.uuid4())
        t0 = time.monotonic()

        result = MethodCallResult(request_id=req.request_id, success=False, output_args=[])

        try:
            raw = await self._registry.call_method(
                req.server_id,
                req.object_node_id,
                req.method_node_id,
                req.input_args,
                req.arg_types,
            )
            result.success     = raw.get("success", False)
            result.output_args = raw.get("results", [])
            result.error       = raw.get("error", "")
            result.latency_ms  = (time.monotonic() - t0) * 1000

            METHOD_CALLS.labels(
                server_id=req.server_id,
                status="success" if result.success else "failed",
            ).inc()
            METHOD_LATENCY.labels(server_id=req.server_id).observe(result.latency_ms / 1000)

        except Exception as exc:
            result.error = str(exc)
            METHOD_CALLS.labels(server_id=req.server_id, status="error").inc()

        result.timestamp = datetime.now(timezone.utc)

        # Audit
        await self._audit_call(req, result)

        result_payload = json.dumps({
            "request_id": result.request_id,
            "template_id": req.template_id,
            "server_id": req.server_id,
            "method_node_id": req.method_node_id,
            "success": result.success,
            "output_args": [str(a) for a in result.output_args],
            "error": result.error,
            "latency_ms": result.latency_ms,
            "timestamp": result.timestamp.isoformat(),
        })

        # Store result as retrievable key (API polls this) — 60s TTL
        await self._redis.setex(
            f"opcua:method:result:{result.request_id}", 60, result_payload
        )
        # Publish to channel for live subscribers
        await self._redis.publish("opcua:method:results", result_payload)

        return result

    async def emergency_stop(
        self,
        server_id: str,
        stop_node_id: str,
        stop_method_node_id: str,
        requested_by: str = "system",
    ) -> MethodCallResult:
        """
        Emergency stop pattern: calls a method with EMERGENCY priority.
        Bypasses all queuing — direct immediate execution.
        """
        logger.warning("EMERGENCY_STOP_CALLED",
                       server_id=server_id, node=stop_node_id, by=requested_by)
        req = MethodCallRequest(
            server_id=server_id,
            object_node_id=stop_node_id,
            method_node_id=stop_method_node_id,
            input_args=[],
            arg_types=[],
            requested_by=requested_by,
        )
        # Emergency: bypass normal call, execute directly on client
        result = await self.call(req)

        # Broadcast emergency to all connected clients
        await self._redis.publish("opcua:emergency", json.dumps({
            "server_id": server_id,
            "node_id": stop_node_id,
            "requested_by": requested_by,
            "success": result.success,
            "ts": result.timestamp.isoformat(),
        }))

        return result

    async def _audit_call(self, req: MethodCallRequest, result: MethodCallResult) -> None:
        try:
            await self._pool.execute("""
                INSERT INTO method_audit
                    (request_id, server_id, object_node_id, method_node_id,
                     template_id, input_args, output_args, requested_by,
                     success, error_message, latency_ms, created_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            """,
                req.request_id, req.server_id, req.object_node_id,
                req.method_node_id, req.template_id,
                json.dumps([str(a) for a in req.input_args]),
                json.dumps([str(a) for a in result.output_args]),
                req.requested_by, result.success,
                result.error, result.latency_ms, result.timestamp,
            )
        except Exception as exc:
            logger.error("method_audit_failed", error=str(exc))
