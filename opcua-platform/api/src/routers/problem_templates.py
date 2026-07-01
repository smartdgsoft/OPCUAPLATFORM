"""
Problem Templates Management API
Feature flag: FEATURE_PROBLEM_TEMPLATES

Configure problem instances (template + stream bindings + objective + action)
and read their outputs. The template engine (in the predictive service) runs
them. Prescriptions route to the closed-loop approval queue.
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

# Catalog mirrors the templates registered in the engine. 'available' = shipped.
TEMPLATE_CATALOG = [
    {"key": "condition_monitoring", "name": "Condition Monitoring (Predictive Maintenance)",
     "objective_types": ["detect", "predict"], "available": True,
     "description": "Learns healthy baselines, tracks degradation trend, predicts "
                    "time-to-threshold. Works day one, no failure history needed."},
    {"key": "source_attributed_setpoint", "name": "Source-Attributed Setpoint (Giveaway / Multi-Unit)",
     "objective_types": ["detect", "prescribe"], "available": True,
     "description": "Monitors a measured output per unit (nozzle/lane/head), detects "
                    "which unit drifts, and prescribes the corrective setting via a "
                    "learned gain. Advisory — routes to approval."},
]


class InstanceCreate(BaseModel):
    template_key: str
    name: str
    asset_id: Optional[str] = None
    config: Dict[str, Any] = {}
    eval_interval_s: int = 60


class InstanceUpdate(BaseModel):
    name: Optional[str] = None
    asset_id: Optional[str] = None
    config: Optional[Dict[str, Any]] = None
    enabled: Optional[bool] = None
    eval_interval_s: Optional[int] = None


@router.get("/templates")
async def list_templates(_: UserOut = Depends(get_current_user)):
    return TEMPLATE_CATALOG


@router.get("/instances")
async def list_instances(
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(get_current_user),
):
    rows = await pool.fetch(
        """SELECT i.id::text, i.template_key, i.name, i.asset_id::text, i.enabled,
                  i.config, i.maturity, i.confidence, i.eval_interval_s,
                  i.last_eval_at, i.last_status, i.last_error, a.name AS asset_name
           FROM problem_instances i LEFT JOIN assets a ON a.id = i.asset_id
           ORDER BY i.name""")
    out = []
    for r in rows:
        d = dict(r)
        if d.get("last_eval_at"):
            d["last_eval_at"] = d["last_eval_at"].isoformat()
        oc = await pool.fetchval(
            "SELECT COUNT(*) FROM problem_outputs WHERE instance_id=$1::uuid", d["id"])
        d["output_count"] = oc
        out.append(d)
    return out


@router.post("/instances", status_code=201)
async def create_instance(
    body: InstanceCreate,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    valid = {t["key"] for t in TEMPLATE_CATALOG if t["available"]}
    if body.template_key not in valid:
        raise HTTPException(400, f"template not available. Available: {sorted(valid)}")
    if not body.config.get("inputs"):
        raise HTTPException(422, "config.inputs is required (at least one stream binding)")
    try:
        iid = await pool.fetchval(
            """INSERT INTO problem_instances (template_key, name, asset_id, config, eval_interval_s)
               VALUES ($1,$2,$3::uuid,$4,$5) RETURNING id::text""",
            body.template_key, body.name, body.asset_id, json.dumps(body.config),
            body.eval_interval_s)
    except asyncpg.UniqueViolationError:
        raise HTTPException(409, "An instance with this name already exists")
    return {"id": iid}


@router.put("/instances/{instance_id}")
async def update_instance(
    instance_id: str,
    body: InstanceUpdate,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(400, "No fields to update")
    sets, vals = [], []
    for k, v in fields.items():
        if k == "config":
            vals.append(json.dumps(v)); sets.append(f"config = ${len(vals)}::jsonb")
        elif k == "asset_id":
            vals.append(v); sets.append(f"asset_id = ${len(vals)}::uuid")
        else:
            vals.append(v); sets.append(f"{k} = ${len(vals)}")
    vals.append(instance_id)
    row = await pool.fetchrow(
        f"""UPDATE problem_instances SET {', '.join(sets)}, updated_at=NOW()
            WHERE id=${len(vals)}::uuid RETURNING id::text""", *vals)
    if not row:
        raise HTTPException(404, "Instance not found")
    return {"id": row["id"]}


@router.delete("/instances/{instance_id}", status_code=204)
async def delete_instance(
    instance_id: str,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    res = await pool.execute("DELETE FROM problem_instances WHERE id=$1::uuid", instance_id)
    if res.endswith("0"):
        raise HTTPException(404, "Instance not found")
    return None


@router.get("/instances/{instance_id}/outputs")
async def list_outputs(
    instance_id: str,
    limit: int = 100,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(get_current_user),
):
    rows = await pool.fetch(
        """SELECT output_type, severity, unit_key, title, detail, value, confidence,
                  maturity, payload, recommendation_id::text, created_at
           FROM problem_outputs WHERE instance_id=$1::uuid
           ORDER BY created_at DESC LIMIT $2""", instance_id, min(limit, 500))
    out = []
    for r in rows:
        d = dict(r)
        d["created_at"] = d["created_at"].isoformat() if d["created_at"] else None
        out.append(d)
    return out


@router.get("/instances/{instance_id}/model")
async def get_model_state(
    instance_id: str,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(get_current_user),
):
    row = await pool.fetchrow(
        """SELECT version, parameters, metrics, sample_count, trained_at
           FROM problem_model_state WHERE instance_id=$1::uuid AND is_active=TRUE LIMIT 1""",
        instance_id)
    if not row:
        return {"trained": False}
    d = dict(row)
    d["trained"] = True
    d["trained_at"] = d["trained_at"].isoformat() if d["trained_at"] else None
    return d
