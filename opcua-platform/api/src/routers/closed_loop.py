"""
Closed-Loop ADVISORY Management API
Feature flag: FEATURE_CLOSED_LOOP_ADVISORY

Manages advisory rules and the human approval workflow for setpoint
recommendations. APPROVAL IS THE ONLY PATH TO ACTUATION, and it routes through
the existing write-control mechanism (FEATURE_WRITE + RBAC + clamps + audit).
The advisory engine itself never actuates.
"""
from __future__ import annotations
import json
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import asyncpg
import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from src.auth.jwt import UserOut, require_roles, get_current_user
from src.db.database import get_pool, get_redis

router = APIRouter()

WRITE_ENABLED = __import__("os").getenv("FEATURE_WRITE", "true").lower() == "true"


# ── Schemas ─────────────────────────────────────────────────────────────────
class RuleCreate(BaseModel):
    twin_id: str
    name: str
    description: Optional[str] = None
    trigger_type: str = "threshold"      # threshold | anomaly
    source_tag_id: Optional[str] = None
    trigger_op: Optional[str] = None     # > < >= <= == !=
    trigger_value: Optional[float] = None
    target_tag_id: Optional[str] = None
    target_server_id: Optional[str] = None
    action_type: str = "set_value"       # set_value | adjust | proportional
    action_value: Optional[float] = None
    source_target: Optional[float] = None
    gain: Optional[float] = 1.0
    safety_min: Optional[float] = None
    safety_max: Optional[float] = None
    max_step: Optional[float] = None
    cooldown_s: int = 300
    severity: str = "warning"


class RuleUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    enabled: Optional[bool] = None
    trigger_type: Optional[str] = None
    source_tag_id: Optional[str] = None
    trigger_op: Optional[str] = None
    trigger_value: Optional[float] = None
    target_tag_id: Optional[str] = None
    target_server_id: Optional[str] = None
    action_type: Optional[str] = None
    action_value: Optional[float] = None
    source_target: Optional[float] = None
    gain: Optional[float] = None
    safety_min: Optional[float] = None
    safety_max: Optional[float] = None
    max_step: Optional[float] = None
    cooldown_s: Optional[int] = None
    severity: Optional[str] = None


class Decision(BaseModel):
    note: Optional[str] = None


# ── Rules CRUD ──────────────────────────────────────────────────────────────
@router.get("/rules")
async def list_rules(
    twin_id: Optional[str] = None,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(get_current_user),
):
    q = """SELECT r.*, d.name AS twin_name FROM cl_rules r
           JOIN twin_definitions d ON d.id = r.twin_id"""
    rows = await (pool.fetch(q + " WHERE r.twin_id=$1::uuid ORDER BY r.name", twin_id)
                  if twin_id else pool.fetch(q + " ORDER BY d.name, r.name"))
    out = []
    for r in rows:
        d = dict(r)
        for k in ("id", "twin_id", "source_tag_id", "target_tag_id", "target_server_id"):
            if d.get(k) is not None:
                d[k] = str(d[k])
        for k in ("created_at", "updated_at"):
            if d.get(k) is not None:
                d[k] = d[k].isoformat()
        out.append(d)
    return out


@router.post("/rules", status_code=201)
async def create_rule(
    body: RuleCreate,
    pool: asyncpg.Pool = Depends(get_pool),
    user: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    twin = await pool.fetchval("SELECT 1 FROM twin_definitions WHERE id=$1::uuid", body.twin_id)
    if not twin:
        raise HTTPException(404, "Twin not found")
    if body.trigger_op and body.trigger_op not in (">", "<", ">=", "<=", "==", "!="):
        raise HTTPException(400, "Invalid trigger_op")
    try:
        rid = await pool.fetchval(
            """INSERT INTO cl_rules
               (twin_id, name, description, trigger_type, source_tag_id, trigger_op,
                trigger_value, target_tag_id, target_server_id, action_type, action_value,
                source_target, gain, safety_min, safety_max, max_step, cooldown_s, severity)
               VALUES ($1::uuid,$2,$3,$4,$5::uuid,$6,$7,$8::uuid,$9::uuid,$10,$11,$12,$13,
                       $14,$15,$16,$17,$18)
               RETURNING id::text""",
            body.twin_id, body.name, body.description, body.trigger_type,
            body.source_tag_id, body.trigger_op, body.trigger_value,
            body.target_tag_id, body.target_server_id, body.action_type, body.action_value,
            body.source_target, body.gain, body.safety_min, body.safety_max, body.max_step,
            body.cooldown_s, body.severity)
    except asyncpg.UniqueViolationError:
        raise HTTPException(409, "A rule with this name already exists for the twin")
    return {"id": rid}


@router.put("/rules/{rule_id}")
async def update_rule(
    rule_id: str,
    body: RuleUpdate,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(400, "No fields to update")
    sets, vals = [], []
    uuid_fields = {"source_tag_id", "target_tag_id", "target_server_id"}
    for k, v in fields.items():
        vals.append(v)
        sets.append(f"{k} = ${len(vals)}" + ("::uuid" if k in uuid_fields else ""))
    vals.append(rule_id)
    row = await pool.fetchrow(
        f"""UPDATE cl_rules SET {', '.join(sets)}, updated_at=NOW()
            WHERE id=${len(vals)}::uuid RETURNING id::text""", *vals)
    if not row:
        raise HTTPException(404, "Rule not found")
    return {"id": row["id"]}


@router.delete("/rules/{rule_id}", status_code=204)
async def delete_rule(
    rule_id: str,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    res = await pool.execute("DELETE FROM cl_rules WHERE id=$1::uuid", rule_id)
    if res.endswith("0"):
        raise HTTPException(404, "Rule not found")
    return None


# ── Recommendations ─────────────────────────────────────────────────────────
@router.get("/recommendations")
async def list_recommendations(
    twin_id: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 100,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(get_current_user),
):
    clauses, params = [], []
    if twin_id:
        params.append(twin_id); clauses.append(f"twin_id=${len(params)}::uuid")
    if status:
        params.append(status); clauses.append(f"status=${len(params)}")
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    params.append(min(limit, 500))
    rows = await pool.fetch(
        f"""SELECT * FROM cl_recommendations {where}
            ORDER BY created_at DESC LIMIT ${len(params)}""", *params)
    out = []
    for r in rows:
        d = dict(r)
        for k in ("id", "rule_id", "twin_id", "source_tag_id", "target_tag_id", "target_server_id"):
            if d.get(k) is not None:
                d[k] = str(d[k])
        for k in ("created_at", "decided_at", "applied_at", "expires_at"):
            if d.get(k) is not None:
                d[k] = d[k].isoformat()
        out.append(d)
    return out


@router.post("/recommendations/{rec_id}/approve")
async def approve_recommendation(
    rec_id: str,
    body: Decision,
    pool: asyncpg.Pool = Depends(get_pool),
    redis: aioredis.Redis = Depends(get_redis),
    user: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    """Approve a recommendation and ACTUATE via the existing write path.

    This is the ONLY path from a recommendation to a physical write. It requires
    FEATURE_WRITE (the same gate as all actuation), ADMIN/ENGINEER role, and
    re-applies the rule's safety clamps as write-path min/max. Fully audited on
    both the recommendation and the write side.
    """
    rec = await pool.fetchrow(
        "SELECT * FROM cl_recommendations WHERE id=$1::uuid", rec_id)
    if not rec:
        raise HTTPException(404, "Recommendation not found")
    if rec["status"] != "pending":
        raise HTTPException(409, f"Recommendation is '{rec['status']}', not pending")
    if rec["expires_at"] and rec["expires_at"] < datetime.now(tz=timezone.utc):
        await pool.execute("UPDATE cl_recommendations SET status='expired' WHERE id=$1::uuid", rec_id)
        raise HTTPException(409, "Recommendation has expired; a fresh one is required")

    if not WRITE_ENABLED:
        raise HTTPException(503, "Actuation requires FEATURE_WRITE=true (write feature is disabled)")
    if not rec["target_tag_id"] or not rec["target_server_id"]:
        raise HTTPException(422, "Recommendation has no writable target configured")

    # Resolve the target node_id for the write.
    node_id = await pool.fetchval(
        "SELECT node_id FROM tags WHERE id=$1::uuid", rec["target_tag_id"])
    if not node_id:
        raise HTTPException(422, "Target tag not found")

    # Pull the rule's safety clamps to pass to the write path.
    clamps = await pool.fetchrow(
        "SELECT safety_min, safety_max FROM cl_rules WHERE id=$1::uuid", rec["rule_id"])

    # Mark approved first (audit), then issue the write through the existing path.
    await pool.execute(
        """UPDATE cl_recommendations
           SET status='approved', decided_by=$2, decided_at=NOW(), decision_note=$3
           WHERE id=$1::uuid""",
        rec_id, user.username, body.note)

    request_id = str(uuid.uuid4())
    cmd = {
        "server_id": str(rec["target_server_id"]),
        "node_id": node_id,
        "value": rec["recommended_value"],
        "priority": 2,
        "requested_by": f"closed_loop:{user.username}",
        "request_id": request_id,
        "min_value": clamps["safety_min"] if clamps else None,
        "max_value": clamps["safety_max"] if clamps else None,
        "confirm_readback": True,
    }
    await redis.publish("opcua:write:commands", json.dumps(cmd))

    # brief wait for the write result
    import asyncio
    result = None
    for _ in range(20):
        raw = await redis.get(f"opcua:write:result:{request_id}")
        if raw:
            result = json.loads(raw)
            break
        await asyncio.sleep(0.1)

    applied_ok = bool(result and result.get("status") in ("ok", "success", "written"))
    await pool.execute(
        """UPDATE cl_recommendations
           SET status=$2, write_request_id=$3, applied_at=NOW()
           WHERE id=$1::uuid""",
        rec_id, "applied" if applied_ok else "failed", request_id)

    return {
        "status": "applied" if applied_ok else "failed",
        "write_request_id": request_id,
        "value": rec["recommended_value"],
        "write_result": result or {"status": "queued",
                                    "message": "poll /write/result/{request_id}"},
    }


@router.post("/recommendations/{rec_id}/reject")
async def reject_recommendation(
    rec_id: str,
    body: Decision,
    pool: asyncpg.Pool = Depends(get_pool),
    user: UserOut = Depends(require_roles("ADMIN", "ENGINEER", "OPERATOR")),
):
    rec = await pool.fetchrow(
        "SELECT status FROM cl_recommendations WHERE id=$1::uuid", rec_id)
    if not rec:
        raise HTTPException(404, "Recommendation not found")
    if rec["status"] != "pending":
        raise HTTPException(409, f"Recommendation is '{rec['status']}', not pending")
    await pool.execute(
        """UPDATE cl_recommendations
           SET status='rejected', decided_by=$2, decided_at=NOW(), decision_note=$3
           WHERE id=$1::uuid""",
        rec_id, user.username, body.note)
    return {"status": "rejected"}
