"""Alarm definitions and events endpoints."""
from __future__ import annotations
from datetime import datetime
from typing import List, Optional
import asyncpg
from fastapi import APIRouter, Depends, Query, HTTPException
from pydantic import BaseModel
from src.auth.jwt import UserOut, get_current_user, require_roles
from src.db.database import get_pool

router = APIRouter()


class AlarmDefOut(BaseModel):
    id: str
    tag_id: str
    name: str
    severity: int
    condition_type: str
    limit_value: Optional[float]
    deadband: float
    message: Optional[str]
    is_active: bool


class AlarmDefCreate(BaseModel):
    tag_id: str
    name: str
    severity: int = 500
    condition_type: str   # HIGH | HIGH_HIGH | LOW | LOW_LOW | BOOL
    limit_value: Optional[float] = None
    deadband: float = 0.0
    message: Optional[str] = None
    notify_email: List[str] = []


class AlarmEventOut(BaseModel):
    id: str
    alarm_def_id: str
    tag_id: str
    triggered_at: datetime
    cleared_at: Optional[datetime]
    ack_at: Optional[datetime]
    ack_by: Optional[str]
    trigger_value: Optional[float]
    severity: Optional[int]
    message: Optional[str]
    state: str


@router.get("/definitions", response_model=List[AlarmDefOut])
async def list_alarm_definitions(
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(get_current_user),
):
    rows = await pool.fetch(
        """SELECT id::text, tag_id::text, name, severity, condition_type,
                  limit_value, deadband, message, is_active
           FROM alarm_definitions ORDER BY name"""
    )
    return [AlarmDefOut(**dict(r)) for r in rows]


@router.post("/definitions", response_model=AlarmDefOut, status_code=201)
async def create_alarm_definition(
    body: AlarmDefCreate,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    row = await pool.fetchrow(
        """INSERT INTO alarm_definitions
           (tag_id, name, severity, condition_type, limit_value, deadband, message, notify_email)
           VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8)
           RETURNING id::text, tag_id::text, name, severity, condition_type,
                     limit_value, deadband, message, is_active""",
        body.tag_id, body.name, body.severity, body.condition_type,
        body.limit_value, body.deadband, body.message, body.notify_email,
    )
    return AlarmDefOut(**dict(row))


@router.get("/events", response_model=List[AlarmEventOut])
async def list_alarm_events(
    state: Optional[str] = Query(None, description="ACTIVE | ACKNOWLEDGED | CLEARED"),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    limit: int = Query(200, le=1000),
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(get_current_user),
):
    clauses = ["1=1"]
    params: list = []
    if state:
        params.append(state)
        clauses.append(f"state = ${len(params)}")
    if start:
        params.append(start)
        clauses.append(f"triggered_at >= ${len(params)}")
    if end:
        params.append(end)
        clauses.append(f"triggered_at <= ${len(params)}")
    params.append(limit)

    rows = await pool.fetch(
        f"""SELECT id::text, alarm_def_id::text, tag_id::text,
                   triggered_at, cleared_at, ack_at, ack_by,
                   trigger_value, severity, message, state
            FROM alarm_events WHERE {" AND ".join(clauses)}
            ORDER BY triggered_at DESC LIMIT ${len(params)}""",
        *params,
    )
    return [AlarmEventOut(**dict(r)) for r in rows]


@router.post("/events/{event_id}/acknowledge", response_model=AlarmEventOut)
async def acknowledge_alarm(
    event_id: str,
    pool: asyncpg.Pool = Depends(get_pool),
    user: UserOut = Depends(require_roles("ADMIN", "ENGINEER", "OPERATOR")),
):
    row = await pool.fetchrow(
        """UPDATE alarm_events SET state = 'ACKNOWLEDGED', ack_at = NOW(), ack_by = $1
           WHERE id = $2::uuid AND state = 'ACTIVE'
           RETURNING id::text, alarm_def_id::text, tag_id::text,
                     triggered_at, cleared_at, ack_at, ack_by,
                     trigger_value, severity, message, state""",
        user.username, event_id,
    )
    if not row:
        raise HTTPException(404, "Event not found or already acknowledged")
    return AlarmEventOut(**dict(row))
