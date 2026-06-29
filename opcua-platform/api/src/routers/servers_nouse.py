"""
Multi-Server Management API
Feature flag: FEATURE_MULTI_SERVER
"""
from __future__ import annotations
import json, os
from typing import List, Optional

import asyncpg, redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from src.auth.jwt import UserOut, require_roles, get_current_user
from src.db.database import get_pool, get_redis

router = APIRouter()
MULTI_SERVER = os.getenv("FEATURE_MULTI_SERVER", "false").lower() == "true"


class ServerCreate(BaseModel):
    name:                str
    endpoint_url:        str
    security_mode:       str  = "None"
    security_policy:     str  = "None"
    username:            Optional[str] = None
    password:            Optional[str] = None
    certificate_path:    Optional[str] = None
    private_key_path:    Optional[str] = None
    publish_interval_ms: int  = 1000
    description:         Optional[str] = None


@router.get("/")
async def list_servers(
    redis: aioredis.Redis = Depends(get_redis),
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(get_current_user),
):
    """List all configured servers with live status from Redis."""
    if MULTI_SERVER:
        rows = await pool.fetch("""
            SELECT id::text, name, endpoint_url, security_mode, security_policy,
                   publish_interval_ms, enabled, description, created_at
            FROM opc_servers ORDER BY name
        """)
        servers = [dict(r) for r in rows]
    else:
        servers = [{
            "id": "default",
            "name": os.getenv("OPC_SERVER_NAME", "Default Server"),
            "endpoint_url": os.getenv("OPC_SERVER_URL", "opc.tcp://localhost:4840"),
            "security_mode": os.getenv("OPC_SECURITY_MODE", "None"),
            "security_policy": os.getenv("OPC_SECURITY_POLICY", "None"),
            "enabled": True,
            "description": "Single-server mode",
        }]

    # Enrich with live status
    raw = await redis.get("opcua:client:servers")
    if raw:
        status_map = {s["server_id"]: s for s in json.loads(raw)}
        for s in servers:
            live = status_map.get(s["id"], {})
            s["connected"]      = live.get("connected", False)
            s["last_connected"] = live.get("last_connected")
            s["last_error"]     = live.get("last_error")
            s["reconnect_count"]= live.get("reconnect_count", 0)
            s["tag_count"]      = live.get("tag_count", 0)
    return servers


@router.post("/")
async def add_server(
    req: ServerCreate,
    pool: asyncpg.Pool = Depends(get_pool),
    redis: aioredis.Redis = Depends(get_redis),
    _: UserOut = Depends(require_roles("ADMIN")),
):
    """Add a new OPC UA server — ADMIN only. Requires FEATURE_MULTI_SERVER=true."""
    if not MULTI_SERVER:
        raise HTTPException(503, "Set FEATURE_MULTI_SERVER=true to manage multiple servers")

    row = await pool.fetchrow("""
        INSERT INTO opc_servers
            (name, endpoint_url, security_mode, security_policy,
             username, password_encrypted, certificate_path, private_key_path,
             publish_interval_ms, description)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING id::text, name, endpoint_url
    """, req.name, req.endpoint_url, req.security_mode, req.security_policy,
        req.username, req.password, req.certificate_path, req.private_key_path,
        req.publish_interval_ms, req.description,
    )
    server_id = row["id"]
    # Notify OPC UA client to connect to new server
    await redis.publish("opcua:commands", json.dumps({
        "cmd": "add_server",
        "config": {
            "id": server_id,
            "name": req.name,
            "endpoint_url": req.endpoint_url,
            "security_mode": req.security_mode,
            "security_policy": req.security_policy,
            "username": req.username,
            "password": req.password,
            "certificate_path": req.certificate_path,
            "private_key_path": req.private_key_path,
            "publish_interval_ms": req.publish_interval_ms,
        }
    }))
    return dict(row)


@router.delete("/{server_id}")
async def remove_server(
    server_id: str,
    pool: asyncpg.Pool = Depends(get_pool),
    redis: aioredis.Redis = Depends(get_redis),
    _: UserOut = Depends(require_roles("ADMIN")),
):
    """Disable a server connection — ADMIN only."""
    await pool.execute(
        "UPDATE opc_servers SET enabled=FALSE WHERE id=$1::uuid", server_id
    )
    await redis.publish("opcua:commands", json.dumps({
        "cmd": "remove_server", "server_id": server_id
    }))
    return {"status": "disabled", "server_id": server_id}


@router.get("/{server_id}/browse")
async def browse_server(
    server_id: str,
    node_id: str = "i=85",
    redis: aioredis.Redis = Depends(get_redis),
    _: UserOut = Depends(get_current_user),
):
    """Browse the address space of a specific server via the client."""
    await redis.publish("opcua:commands", json.dumps({
        "cmd": "browse", "server_id": server_id, "node_id": node_id
    }))
    import asyncio
    key = f"opcua:browse:{server_id}:{node_id}"
    for _ in range(30):
        raw = await redis.get(key)
        if raw:
            return json.loads(raw)
        await asyncio.sleep(0.2)
    raise HTTPException(504, "Browse timeout — server may not be connected")
