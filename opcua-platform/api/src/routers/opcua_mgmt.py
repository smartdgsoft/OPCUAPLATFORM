"""
OPC UA Client Management Router
All OPC UA operations are routed THROUGH the client service (single connection
owner) via Redis, avoiding competing connections to the same server.
"""
from __future__ import annotations
import asyncio, json, os, uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import asyncpg
import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from src.auth.jwt import UserOut, get_current_user, require_roles
from src.db.database import get_pool, get_redis
from src.config.settings import settings

router = APIRouter()


class ConnectionStatus(BaseModel):
    connected: bool
    server_url: str
    security_mode: str
    security_policy: str
    last_seen: Optional[str]
    reconnect_count: int
    queue_depth: int
    rows_written_total: float
    rows_buffered_total: float
    client_alive: bool


class ClientMetrics(BaseModel):
    values_received_total: float
    values_filtered_total: float
    rows_written_total: float
    rows_buffered_total: float
    write_errors_total: float
    queue_depth: float
    connection_status: float
    reconnect_total: float


async def _fetch_client_metrics() -> Dict[str, float]:
    """Pull metrics from the OPC UA client Prometheus endpoint."""
    import httpx
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get("http://opcua-client:9090/metrics")
            metrics: Dict[str, float] = {}
            for line in resp.text.splitlines():
                if line.startswith("#"):
                    continue
                parts = line.split()
                if len(parts) == 2:
                    try:
                        metrics[parts[0]] = float(parts[1])
                    except ValueError:
                        pass
            return metrics
    except Exception:
        return {}


@router.get("/status", response_model=ConnectionStatus)
async def get_connection_status(
    redis: aioredis.Redis = Depends(get_redis),
    _: UserOut = Depends(get_current_user),
):
    metrics = await _fetch_client_metrics()
    heartbeat = await redis.get("opcua:client:heartbeat")
    servers_raw = await redis.get("opcua:client:servers")

    connected = metrics.get("opcua_connection_status", 0) == 1
    last_seen = None
    if servers_raw:
        try:
            servers = json.loads(servers_raw)
            if servers:
                last_seen = servers[0].get("last_connected")
                connected = connected or any(s.get("connected") for s in servers)
        except Exception:
            pass

    return ConnectionStatus(
        connected=connected,
        server_url=settings.opc_server_url,
        security_mode=settings.opc_security_mode,
        security_policy=settings.opc_security_policy,
        last_seen=last_seen,
        reconnect_count=int(metrics.get("opcua_reconnect_total", 0)),
        queue_depth=int(metrics.get("opcua_queue_depth", 0)),
        rows_written_total=metrics.get("opcua_rows_written_total", 0),
        rows_buffered_total=metrics.get("opcua_rows_buffered_total", 0),
        client_alive=heartbeat == "ok",
    )


@router.get("/metrics", response_model=ClientMetrics)
async def get_client_metrics(_: UserOut = Depends(get_current_user)):
    m = await _fetch_client_metrics()
    return ClientMetrics(
        values_received_total=m.get("opcua_values_received_total", 0),
        values_filtered_total=m.get("opcua_values_filtered_total", 0),
        rows_written_total=m.get("opcua_rows_written_total", 0),
        rows_buffered_total=m.get("opcua_rows_buffered_total", 0),
        write_errors_total=m.get("opcua_write_errors_total", 0),
        queue_depth=m.get("opcua_queue_depth", 0),
        connection_status=m.get("opcua_connection_status", 0),
        reconnect_total=m.get("opcua_reconnect_total", 0),
    )


@router.get("/servers")
async def get_servers_status(
    redis: aioredis.Redis = Depends(get_redis),
    _: UserOut = Depends(get_current_user),
):
    """Live status of all connected servers (from client heartbeat)."""
    raw = await redis.get("opcua:client:servers")
    return json.loads(raw) if raw else []


@router.get("/browse")
async def browse_address_space(
    node_id: str = Query("i=85"),
    server_id: str = Query("default"),
    redis: aioredis.Redis = Depends(get_redis),
    _: UserOut = Depends(get_current_user),
):
    """Browse via the client (single connection owner)."""
    # Trigger browse on the client
    await redis.publish("opcua:commands", json.dumps({
        "cmd": "browse", "server_id": server_id, "node_id": node_id,
    }))
    # Poll for result
    key = f"opcua:browse:{server_id}:{node_id}"
    for _ in range(30):
        raw = await redis.get(key)
        if raw:
            return json.loads(raw)
        await asyncio.sleep(0.2)
    raise HTTPException(504, "Browse timeout — is the client connected to this server?")


@router.get("/subscriptions")
async def get_subscriptions(
    pool: asyncpg.Pool = Depends(get_pool),
    redis: aioredis.Redis = Depends(get_redis),
    _: UserOut = Depends(get_current_user),
):
    """All active subscribed tags with live values from Redis cache."""
    rows = await pool.fetch("""
        SELECT t.id::text AS tag_id, t.node_id, t.display_name,
               t.engineering_unit, t.sample_interval_ms, t.deadband_value, t.is_active
        FROM tags t WHERE t.is_active = TRUE ORDER BY t.display_name
    """)
    keys = [f"tag:live:{r['tag_id']}" for r in rows]
    live_vals = await redis.mget(*keys) if keys else []
    result = []
    for row, raw in zip(rows, live_vals):
        live = json.loads(raw) if raw else {}
        result.append({
            "tag_id": row["tag_id"], "node_id": row["node_id"],
            "display_name": row["display_name"],
            "engineering_unit": row["engineering_unit"],
            "sample_interval_ms": row["sample_interval_ms"],
            "deadband_value": row["deadband_value"],
            "last_value": live.get("value"), "last_quality": live.get("quality"),
            "last_ts": live.get("ts"), "is_active": row["is_active"],
        })
    return result


@router.get("/node-value")
async def read_node_value(
    node_id: str = Query(...),
    server_id: str = Query("default"),
    redis: aioredis.Redis = Depends(get_redis),
    _: UserOut = Depends(get_current_user),
):
    """Read a node value via the client (no competing connection)."""
    request_id = str(uuid.uuid4())
    await redis.publish("opcua:commands", json.dumps({
        "cmd": "read", "server_id": server_id,
        "node_id": node_id, "request_id": request_id,
    }))
    for _ in range(25):
        raw = await redis.get(f"opcua:read:result:{request_id}")
        if raw:
            return json.loads(raw)
        await asyncio.sleep(0.2)
    raise HTTPException(504, "Read timeout — is the client connected?")


@router.get("/server-info")
async def get_server_info(
    server_id: str = Query("default"),
    server_url: Optional[str] = Query(None),
    redis: aioredis.Redis = Depends(get_redis),
    _: UserOut = Depends(get_current_user),
):
    """Read server identity via the client (no competing connection)."""
    request_id = str(uuid.uuid4())
    await redis.publish("opcua:commands", json.dumps({
        "cmd": "server_info", "server_id": server_id, "request_id": request_id,
    }))
    for _ in range(25):
        raw = await redis.get(f"opcua:serverinfo:{request_id}")
        if raw:
            data = json.loads(raw)
            if not data.get("success"):
                raise HTTPException(503, data.get("error", "Cannot read server info"))
            return data
        await asyncio.sleep(0.2)
    raise HTTPException(504, "Server-info timeout — is the client connected?")


@router.get("/endpoints")
async def discover_endpoints(
    server_url: str = Query(..., description="opc.tcp://host:port"),
    _: UserOut = Depends(get_current_user),
):
    """
    Discover endpoints. This is the ONE place a transient connection is acceptable
    because discovery happens BEFORE the client subscribes (e.g. when adding a new
    server) and uses an anonymous, security-None discovery channel.
    """
    from asyncua import Client
    try:
        client = Client(url=server_url, timeout=5)
        endpoints = await client.connect_and_get_server_endpoints()
        result = []
        for ep in endpoints:
            sm = ep.SecurityMode.name if hasattr(ep.SecurityMode, "name") else str(ep.SecurityMode)
            sp = str(ep.SecurityPolicyUri).split("#")[-1] if ep.SecurityPolicyUri else "None"
            result.append({
                "endpoint_url": ep.EndpointUrl or server_url,
                "security_mode": sm,
                "security_policy": sp,
                "transport_profile": str(ep.TransportProfileUri).split("#")[-1] if ep.TransportProfileUri else "",
            })
        return result
    except Exception as exc:
        raise HTTPException(503, f"Endpoint discovery failed: {exc}")


@router.post("/restart")
async def restart_client(
    redis: aioredis.Redis = Depends(get_redis),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    await redis.publish("opcua:commands", json.dumps({
        "cmd": "restart", "ts": datetime.now(timezone.utc).isoformat()
    }))
    return {"message": "Restart signal sent to OPC UA client"}
