"""
Write API Router
Proxies write commands to the OPC UA client via Redis pub/sub.
Feature flag: FEATURE_WRITE must be enabled on both API and client.
"""
from __future__ import annotations
import json, os, uuid
from datetime import datetime
from typing import Any, List, Optional

import asyncpg, redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from src.auth.jwt import UserOut, require_roles, get_current_user
from src.db.database import get_pool, get_redis

router = APIRouter()
WRITE_ENABLED = os.getenv("FEATURE_WRITE", "true").lower() == "true"


class WriteNodeRequest(BaseModel):
    server_id:        str
    node_id:          str
    value:            Any
    data_type:        str    = "Double"
    priority:         int    = 2    # 0=EMERGENCY, 1=HIGH, 2=NORMAL
    confirm_readback: bool   = True
    min_value:        Optional[float] = None
    max_value:        Optional[float] = None
    comment:          Optional[str]   = None


class BulkWriteRequest(BaseModel):
    writes: List[WriteNodeRequest]


class RampRequest(BaseModel):
    server_id:        str
    node_id:          str
    target_value:     float
    duration_seconds: float  = Field(ge=1, le=3600)
    steps:            int    = Field(default=10, ge=2, le=100)
    data_type:        str    = "Double"


class WriteAuditFilter(BaseModel):
    server_id:  Optional[str] = None
    node_id:    Optional[str] = None
    start:      Optional[datetime] = None
    end:        Optional[datetime] = None
    success:    Optional[bool] = None
    limit:      int = 100


def _check_write_enabled():
    if not WRITE_ENABLED:
        raise HTTPException(503, "Write feature is disabled (FEATURE_WRITE=false in .env)")


@router.post("/node")
async def write_node(
    req: WriteNodeRequest,
    pool: asyncpg.Pool = Depends(get_pool),
    redis: aioredis.Redis = Depends(get_redis),
    user: UserOut = Depends(require_roles("ADMIN", "ENGINEER", "OPERATOR")),
):
    """
    Write a single value to an OPC UA node.
    OPERATOR can write; ENGINEER and ADMIN can write with EMERGENCY priority.
    """
    _check_write_enabled()

    # OPERATOR cannot send EMERGENCY writes
    if req.priority == 0 and user.role == "OPERATOR":
        raise HTTPException(403, "OPERATOR role cannot send EMERGENCY priority writes")

    request_id = str(uuid.uuid4())
    cmd = {
        "server_id": req.server_id,
        "node_id": req.node_id,
        "value": req.value,
        "data_type": req.data_type,
        "priority": req.priority,
        "requested_by": user.username,
        "request_id": request_id,
        "min_value": req.min_value,
        "max_value": req.max_value,
        "confirm_readback": req.confirm_readback,
    }
    await redis.publish("opcua:write:commands", json.dumps(cmd))

    # Wait briefly for result (polling Redis result key)
    import asyncio
    for _ in range(20):
        raw = await redis.get(f"opcua:write:result:{request_id}")
        if raw:
            return json.loads(raw)
        await asyncio.sleep(0.1)

    return {"request_id": request_id, "status": "queued",
            "message": "Write enqueued — poll /write/result/{request_id}"}


@router.get("/result/{request_id}")
async def get_write_result(
    request_id: str,
    redis: aioredis.Redis = Depends(get_redis),
    _: UserOut = Depends(get_current_user),
):
    raw = await redis.get(f"opcua:write:result:{request_id}")
    if not raw:
        return {"request_id": request_id, "status": "pending"}
    return json.loads(raw)


@router.post("/bulk")
async def bulk_write(
    req: BulkWriteRequest,
    redis: aioredis.Redis = Depends(get_redis),
    user: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    """Bulk write — ENGINEER+ only. Returns list of request_ids."""
    _check_write_enabled()
    if len(req.writes) > 500:
        raise HTTPException(400, "Bulk write limited to 500 nodes per request")

    request_ids = []
    for w in req.writes:
        rid = str(uuid.uuid4())
        cmd = {
            "server_id": w.server_id, "node_id": w.node_id, "value": w.value,
            "data_type": w.data_type, "priority": w.priority,
            "requested_by": user.username, "request_id": rid,
            "min_value": w.min_value, "max_value": w.max_value,
            "confirm_readback": w.confirm_readback,
        }
        await redis.publish("opcua:write:commands", json.dumps(cmd))
        request_ids.append(rid)

    return {"request_ids": request_ids, "count": len(request_ids), "status": "queued"}


@router.post("/ramp")
async def ramp_setpoint(
    req: RampRequest,
    redis: aioredis.Redis = Depends(get_redis),
    user: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    """Gradually ramp a set-point to target over a duration — ENGINEER+ only."""
    _check_write_enabled()
    cmd = {
        "cmd": "ramp",
        "server_id": req.server_id,
        "node_id": req.node_id,
        "target_value": req.target_value,
        "duration_seconds": req.duration_seconds,
        "steps": req.steps,
        "data_type": req.data_type,
        "requested_by": user.username,
    }
    await redis.publish("opcua:scheduler:commands", json.dumps(cmd))
    return {"status": "ramp_scheduled", "target": req.target_value,
            "duration_seconds": req.duration_seconds, "steps": req.steps}


@router.get("/audit")
async def get_write_audit(
    server_id: Optional[str] = None,
    node_id: Optional[str] = None,
    success: Optional[bool] = None,
    limit: int = 100,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    """Full write audit log — ENGINEER+ only."""
    clauses = ["1=1"]
    params: list = []
    if server_id:
        params.append(server_id); clauses.append(f"server_id = ${len(params)}")
    if node_id:
        params.append(node_id); clauses.append(f"node_id = ${len(params)}")
    if success is not None:
        params.append(success); clauses.append(f"success = ${len(params)}")
    params.append(min(limit, 1000))
    rows = await pool.fetch(
        f"SELECT request_id, server_id, node_id, value_written, data_type, "
        f"priority, requested_by, success, readback_value, readback_match, "
        f"error_message, latency_ms, created_at "
        f"FROM write_audit WHERE {' AND '.join(clauses)} "
        f"ORDER BY created_at DESC LIMIT ${len(params)}",
        *params,
    )
    return [dict(r) for r in rows]
