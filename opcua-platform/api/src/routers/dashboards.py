"""
Dashboards API — config-driven operations screens.
Feature flag: FEATURE_DASHBOARDS

A dashboard is a stored layout config (widgets + bindings) in a single JSONB
column. This router is pure CRUD over that config; the actual widget DATA is
fetched by the frontend from existing endpoints (tags /live, WS /live, history,
alarms, assets). No new data endpoints are needed here.
"""
from __future__ import annotations
import json
from datetime import datetime
from typing import Any, Dict, List, Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from src.auth.jwt import UserOut, require_roles, get_current_user
from src.db.database import get_pool

router = APIRouter()


def _row(r: asyncpg.Record) -> Dict[str, Any]:
    d = dict(r)
    for k in ("id",):
        if d.get(k) is not None:
            d[k] = str(d[k])
    for k in ("created_at", "updated_at"):
        if d.get(k):
            d[k] = d[k].isoformat()
    # asyncpg returns JSONB as a string — parse it so the frontend gets an object
    if isinstance(d.get("layout"), str):
        d["layout"] = json.loads(d["layout"])
    return d


class DashboardCreate(BaseModel):
    name: str
    description: Optional[str] = None
    demo_mode: bool = False
    layout: Dict[str, Any] = {"grid": {"cols": 12, "row_height": 40}, "widgets": []}
    is_default: bool = False


class DashboardUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    demo_mode: Optional[bool] = None
    layout: Optional[Dict[str, Any]] = None
    is_default: Optional[bool] = None


@router.get("")
async def list_dashboards(
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(get_current_user),
):
    rows = await pool.fetch(
        """SELECT id, name, description, demo_mode, is_default, created_at, updated_at
           FROM dashboards ORDER BY is_default DESC, name""")
    # list view omits the (potentially large) layout for speed
    out = []
    for r in rows:
        d = dict(r)
        d["id"] = str(d["id"])
        for k in ("created_at", "updated_at"):
            if d.get(k):
                d[k] = d[k].isoformat()
        out.append(d)
    return out


@router.get("/{dashboard_id}")
async def get_dashboard(
    dashboard_id: str,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(get_current_user),
):
    r = await pool.fetchrow("SELECT * FROM dashboards WHERE id=$1::uuid", dashboard_id)
    if not r:
        raise HTTPException(404, "dashboard not found")
    return _row(r)


@router.post("", status_code=201)
async def create_dashboard(
    body: DashboardCreate,
    pool: asyncpg.Pool = Depends(get_pool),
    user: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    if body.is_default:
        await pool.execute("UPDATE dashboards SET is_default=FALSE WHERE is_default")
    did = await pool.fetchval(
        """INSERT INTO dashboards (name, description, demo_mode, layout, is_default, created_by)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id::text""",
        body.name, body.description, body.demo_mode, json.dumps(body.layout),
        body.is_default, user.username)
    return {"id": did}


@router.put("/{dashboard_id}")
async def update_dashboard(
    dashboard_id: str,
    body: DashboardUpdate,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    cur = await pool.fetchrow("SELECT * FROM dashboards WHERE id=$1::uuid", dashboard_id)
    if not cur:
        raise HTTPException(404, "dashboard not found")
    name = body.name if body.name is not None else cur["name"]
    desc = body.description if body.description is not None else cur["description"]
    demo = body.demo_mode if body.demo_mode is not None else cur["demo_mode"]
    layout = json.dumps(body.layout) if body.layout is not None else cur["layout"]
    is_def = body.is_default if body.is_default is not None else cur["is_default"]
    if body.is_default:
        await pool.execute("UPDATE dashboards SET is_default=FALSE WHERE is_default AND id<>$1::uuid",
                           dashboard_id)
    await pool.execute(
        """UPDATE dashboards SET name=$2, description=$3, demo_mode=$4, layout=$5,
               is_default=$6, updated_at=NOW() WHERE id=$1::uuid""",
        dashboard_id, name, desc, demo, layout, is_def)
    r = await pool.fetchrow("SELECT * FROM dashboards WHERE id=$1::uuid", dashboard_id)
    return _row(r)


@router.delete("/{dashboard_id}", status_code=204)
async def delete_dashboard(
    dashboard_id: str,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    res = await pool.execute("DELETE FROM dashboards WHERE id=$1::uuid", dashboard_id)
    if res.endswith("0"):
        raise HTTPException(404, "dashboard not found")
    return None


@router.post("/seed/fevicol", status_code=201)
async def seed_fevicol(
    pool: asyncpg.Pool = Depends(get_pool),
    user: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    """Seed the demo 'Fevicol SH — Line 1' dashboard (matches the NEXUS OPS design).
    Idempotent: replaces any existing dashboard with the same name."""
    from src.dashboards_seed import FEVICOL_LAYOUT
    await pool.execute("DELETE FROM dashboards WHERE name=$1", "Fevicol SH — Production Line 1")
    did = await pool.fetchval(
        """INSERT INTO dashboards (name, description, demo_mode, layout, is_default, created_by)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id::text""",
        "Fevicol SH — Production Line 1",
        "Mahul Works, Mumbai — adhesive manufacturing operations overview",
        True, json.dumps(FEVICOL_LAYOUT), True, user.username)
    return {"id": did, "name": "Fevicol SH — Production Line 1"}
