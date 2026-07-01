"""
Connectivity Management API
Feature flag: FEATURE_CONNECTOR_HUB

Manage data sources (connectors) and their streams. The connector hub service
runs them; this API configures them. Mutations are RBAC-gated.
"""
from __future__ import annotations
import json
from typing import Any, Dict, List, Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from src.auth.jwt import UserOut, require_roles, get_current_user
from src.db.database import get_pool

router = APIRouter()

# Connector catalog — grows as Sprints 3-50 land. 'available' reflects what the
# running hub image actually supports today.
CONNECTOR_CATALOG = [
    {"key": "opcua",       "name": "OPC UA",            "mode": "subscribe", "available": True,  "note": "Built-in (connector #1)"},
    {"key": "sql",         "name": "SQL Database",      "mode": "poll",      "available": True,  "note": "Postgres/MySQL/SQL Server/SQLite via SQLAlchemy"},
    {"key": "mqtt",        "name": "MQTT",              "mode": "subscribe", "available": False, "note": "planned"},
    {"key": "modbus_tcp",  "name": "Modbus TCP",        "mode": "poll",      "available": False, "note": "planned"},
    {"key": "rest",        "name": "REST",              "mode": "poll",      "available": False, "note": "planned"},
]


class SourceCreate(BaseModel):
    name: str
    source_type: str
    mode: str = "poll"
    config: Dict[str, Any] = {}
    poll_interval_ms: int = 5000
    writable: bool = False
    description: Optional[str] = None


class SourceUpdate(BaseModel):
    name: Optional[str] = None
    config: Optional[Dict[str, Any]] = None
    poll_interval_ms: Optional[int] = None
    enabled: Optional[bool] = None
    writable: Optional[bool] = None
    description: Optional[str] = None


@router.get("/types")
async def list_types(_: UserOut = Depends(get_current_user)):
    return CONNECTOR_CATALOG


@router.get("/sources")
async def list_sources(
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(get_current_user),
):
    rows = await pool.fetch(
        """SELECT id::text, name, source_type, mode, config, poll_interval_ms,
                  enabled, writable, description, last_status, last_error, last_seen
           FROM sources ORDER BY name""")
    out = []
    for r in rows:
        d = dict(r)
        if d.get("last_seen"):
            d["last_seen"] = d["last_seen"].isoformat()
        # asyncpg returns JSONB as a string; parse so the client edit form pre-fills
        if isinstance(d.get("config"), str):
            try:
                d["config"] = json.loads(d["config"])
            except Exception:
                d["config"] = {}
        sc = await pool.fetchval("SELECT COUNT(*) FROM streams WHERE source_id=$1::uuid", d["id"])
        d["stream_count"] = sc
        out.append(d)
    return out


@router.post("/sources", status_code=201)
async def create_source(
    body: SourceCreate,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    valid = {c["key"] for c in CONNECTOR_CATALOG if c["available"]}
    if body.source_type not in valid:
        raise HTTPException(400, f"source_type not available. Available: {sorted(valid)}")
    try:
        sid = await pool.fetchval(
            """INSERT INTO sources (name, source_type, mode, config, poll_interval_ms, writable, description)
               VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id::text""",
            body.name, body.source_type, body.mode, json.dumps(body.config),
            body.poll_interval_ms, body.writable, body.description)
    except asyncpg.UniqueViolationError:
        raise HTTPException(409, "A source with this name already exists")
    return {"id": sid}


@router.put("/sources/{source_id}")
async def update_source(
    source_id: str,
    body: SourceUpdate,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(400, "No fields to update")
    sets, vals = [], []
    for k, v in fields.items():
        vals.append(json.dumps(v) if k == "config" else v)
        sets.append(f"{k} = ${len(vals)}" + ("::jsonb" if k == "config" else ""))
    vals.append(source_id)
    row = await pool.fetchrow(
        f"""UPDATE sources SET {', '.join(sets)}, updated_at=NOW()
            WHERE id=${len(vals)}::uuid RETURNING id::text""", *vals)
    if not row:
        raise HTTPException(404, "Source not found")
    return {"id": row["id"]}


@router.delete("/sources/{source_id}", status_code=204)
async def delete_source(
    source_id: str,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    res = await pool.execute("DELETE FROM sources WHERE id=$1::uuid", source_id)
    if res.endswith("0"):
        raise HTTPException(404, "Source not found")
    return None


@router.get("/sources/{source_id}/streams")
async def list_streams(
    source_id: str,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(get_current_user),
):
    rows = await pool.fetch(
        """SELECT id::text, stream_key, display_name, engineering_unit,
                  data_type, tag_id::text, is_active, asset_id::text
           FROM streams WHERE source_id=$1::uuid ORDER BY stream_key""", source_id)
    return [dict(r) for r in rows]
