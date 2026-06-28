"""
OPC UA Method Call API Router
Feature flag: FEATURE_METHODS
"""
from __future__ import annotations
import json, os, uuid
from typing import Any, List, Optional

import asyncpg, redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from src.auth.jwt import UserOut, require_roles, get_current_user
from src.db.database import get_pool, get_redis

router = APIRouter()
METHODS_ENABLED = os.getenv("FEATURE_METHODS", "true").lower() == "true"


class CallMethodRequest(BaseModel):
    server_id:      str
    object_node_id: str
    method_node_id: str
    input_args:     List[Any] = []
    arg_types:      List[str] = []


class CallTemplateRequest(BaseModel):
    template_id: str
    input_args:  List[Any] = []


class EmergencyStopRequest(BaseModel):
    server_id:         str
    stop_node_id:      str
    stop_method_node_id: str
    reason:            Optional[str] = None


class CreateTemplateRequest(BaseModel):
    name:               str
    description:        str
    server_id:          str
    object_node_id:     str
    method_node_id:     str
    input_args:         List[dict] = []   # [{name, data_type, description, default}]
    output_args:        List[dict] = []
    requires_confirmation: bool = True
    min_role:           str = "OPERATOR"


def _check_enabled():
    if not METHODS_ENABLED:
        raise HTTPException(503, "Method feature is disabled (FEATURE_METHODS=false in .env)")


@router.get("/templates")
async def list_templates(
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(get_current_user),
):
    """List all defined method templates."""
    rows = await pool.fetch("""
        SELECT id::text, name, description, server_id::text,
               object_node_id, method_node_id, input_args, output_args,
               requires_confirmation, min_role, created_at
        FROM method_templates ORDER BY name
    """)
    return [dict(r) for r in rows]


@router.post("/templates")
async def create_template(
    req: CreateTemplateRequest,
    pool: asyncpg.Pool = Depends(get_pool),
    redis: aioredis.Redis = Depends(get_redis),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    """Define a reusable method template."""
    _check_enabled()
    row = await pool.fetchrow("""
        INSERT INTO method_templates
            (name, description, server_id, object_node_id, method_node_id,
             input_args, output_args, requires_confirmation, min_role)
        VALUES ($1,$2,$3::uuid,$4,$5,$6,$7,$8,$9)
        RETURNING id::text, name
    """, req.name, req.description, req.server_id,
        req.object_node_id, req.method_node_id,
        json.dumps(req.input_args), json.dumps(req.output_args),
        req.requires_confirmation, req.min_role,
    )
    # Reload templates in client
    await redis.publish("opcua:commands", json.dumps({"cmd": "reload_templates"}))
    return dict(row)


@router.post("/call/template")
async def call_by_template(
    req: CallTemplateRequest,
    redis: aioredis.Redis = Depends(get_redis),
    user: UserOut = Depends(get_current_user),
):
    """Call an OPC UA method using a saved template."""
    _check_enabled()
    request_id = str(uuid.uuid4())
    await redis.publish("opcua:method:commands", json.dumps({
        "template_id": req.template_id,
        "input_args": req.input_args,
        "requested_by": user.username,
        "request_id": request_id,
    }))
    return await _wait_result(redis, request_id)


@router.post("/call")
async def call_method_direct(
    req: CallMethodRequest,
    redis: aioredis.Redis = Depends(get_redis),
    user: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    """Call an OPC UA method directly by node IDs — ENGINEER+ only."""
    _check_enabled()
    request_id = str(uuid.uuid4())
    await redis.publish("opcua:method:commands", json.dumps({
        "server_id": req.server_id,
        "object_node_id": req.object_node_id,
        "method_node_id": req.method_node_id,
        "input_args": req.input_args,
        "arg_types": req.arg_types,
        "requested_by": user.username,
        "request_id": request_id,
    }))
    return await _wait_result(redis, request_id)


@router.post("/emergency-stop")
async def emergency_stop(
    req: EmergencyStopRequest,
    redis: aioredis.Redis = Depends(get_redis),
    user: UserOut = Depends(require_roles("ADMIN", "ENGINEER", "OPERATOR")),
):
    """
    Emergency stop — highest priority, no queue, immediate execution.
    Broadcasts stop event to all connected WebSocket clients.
    """
    _check_enabled()
    request_id = str(uuid.uuid4())
    await redis.publish("opcua:method:commands", json.dumps({
        "cmd": "emergency_stop",
        "server_id": req.server_id,
        "object_node_id": req.stop_node_id,
        "method_node_id": req.stop_method_node_id,
        "input_args": [],
        "arg_types": [],
        "requested_by": user.username,
        "request_id": request_id,
        "reason": req.reason,
        "priority": 0,  # EMERGENCY
    }))
    # Broadcast immediately to all clients
    await redis.publish("opcua:emergency", json.dumps({
        "server_id": req.server_id, "requested_by": user.username,
        "reason": req.reason, "request_id": request_id,
    }))
    return await _wait_result(redis, request_id)


@router.get("/audit")
async def get_method_audit(
    server_id: Optional[str] = None,
    limit: int = 100,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    clauses = ["1=1"]
    params: list = []
    if server_id:
        params.append(server_id); clauses.append(f"server_id = ${len(params)}")
    params.append(min(limit, 1000))
    rows = await pool.fetch(
        f"SELECT request_id, server_id, object_node_id, method_node_id, "
        f"template_id, input_args, output_args, requested_by, success, "
        f"error_message, latency_ms, created_at "
        f"FROM method_audit WHERE {' AND '.join(clauses)} "
        f"ORDER BY created_at DESC LIMIT ${len(params)}", *params,
    )
    return [dict(r) for r in rows]


async def _wait_result(redis, request_id: str, timeout_s: float = 5.0) -> dict:
    import asyncio
    for _ in range(int(timeout_s / 0.15)):
        raw = await redis.get(f"opcua:method:result:{request_id}")
        if raw:
            return json.loads(raw)
        await asyncio.sleep(0.15)
    return {"request_id": request_id, "status": "pending",
            "message": "Method call enqueued — result not yet available"}
