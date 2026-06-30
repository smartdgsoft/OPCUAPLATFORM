"""
Predictive Model Management API
Feature flag: FEATURE_TWIN_PREDICTIVE

Enterprise model lifecycle over HTTP: configure models, train versions,
activate/rollback, inspect versions/metrics/audit, trigger scoring. All
mutations are RBAC-gated and audited. Advisory-only outputs.
"""
from __future__ import annotations
import json
from typing import Any, Dict, List, Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from src.auth.jwt import UserOut, require_roles, get_current_user
from src.db.database import get_pool, get_redis

router = APIRouter()

AVAILABLE_METHODS = ["univariate_drift", "multivariate"]


# ── Schemas ─────────────────────────────────────────────────────────────────
class ModelCreate(BaseModel):
    twin_id: str
    name: str
    method: str
    description: Optional[str] = None
    config: Dict[str, Any] = {}
    score_interval_s: int = 30
    retrain_cron: Optional[str] = None
    train_window_hours: int = 168


class ModelUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    enabled: Optional[bool] = None
    config: Optional[Dict[str, Any]] = None
    score_interval_s: Optional[int] = None
    retrain_cron: Optional[str] = None
    train_window_hours: Optional[int] = None


# ── helpers ─────────────────────────────────────────────────────────────────
async def _audit(pool, model_id, event, actor, detail="", version_id=None, payload=None):
    await pool.execute(
        """INSERT INTO pred_audit (model_id, version_id, event, actor, detail, payload)
           VALUES ($1::uuid,$2,$3,$4,$5,$6)""",
        model_id, version_id, event, actor, detail, json.dumps(payload or {}))


# ── methods catalog ─────────────────────────────────────────────────────────
@router.get("/methods")
async def list_methods(_: UserOut = Depends(get_current_user)):
    return [
        {"key": "univariate_drift", "name": "Univariate Drift / Anomaly",
         "needs_labels": False, "min_signals": 1,
         "description": "Per-signal statistical drift detection (z-score + EWMA). Works day one."},
        {"key": "multivariate", "name": "Multivariate Relationship Anomaly",
         "needs_labels": False, "min_signals": 2,
         "description": "Detects broken relationships between signals (Mahalanobis distance)."},
    ]


# ── model CRUD ──────────────────────────────────────────────────────────────
@router.get("/models")
async def list_models(
    twin_id: Optional[str] = None,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(get_current_user),
):
    if twin_id:
        rows = await pool.fetch(
            """SELECT m.id::text, m.twin_id::text, m.name, m.method, m.description,
                      m.enabled, m.config, m.score_interval_s, m.retrain_cron,
                      m.train_window_hours, d.name AS twin_name
               FROM pred_models m JOIN twin_definitions d ON d.id=m.twin_id
               WHERE m.twin_id=$1::uuid ORDER BY m.name""", twin_id)
    else:
        rows = await pool.fetch(
            """SELECT m.id::text, m.twin_id::text, m.name, m.method, m.description,
                      m.enabled, m.config, m.score_interval_s, m.retrain_cron,
                      m.train_window_hours, d.name AS twin_name
               FROM pred_models m JOIN twin_definitions d ON d.id=m.twin_id
               ORDER BY d.name, m.name""")
    out = []
    for r in rows:
        d = dict(r)
        av = await pool.fetchrow(
            """SELECT version, trained_at, train_sample_count, metrics
               FROM pred_model_versions WHERE model_id=$1::uuid AND status='active' LIMIT 1""",
            d["id"])
        d["active_version"] = av["version"] if av else None
        d["active_trained_at"] = av["trained_at"].isoformat() if av and av["trained_at"] else None
        vc = await pool.fetchval(
            "SELECT COUNT(*) FROM pred_model_versions WHERE model_id=$1::uuid", d["id"])
        d["version_count"] = vc
        out.append(d)
    return out


@router.post("/models", status_code=201)
async def create_model(
    body: ModelCreate,
    pool: asyncpg.Pool = Depends(get_pool),
    user: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    if body.method not in AVAILABLE_METHODS:
        raise HTTPException(400, f"Unknown method. Available: {AVAILABLE_METHODS}")
    twin = await pool.fetchval("SELECT 1 FROM twin_definitions WHERE id=$1::uuid", body.twin_id)
    if not twin:
        raise HTTPException(404, "Twin not found")
    try:
        row = await pool.fetchrow(
            """INSERT INTO pred_models
               (twin_id, name, method, description, config, score_interval_s,
                retrain_cron, train_window_hours)
               VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8)
               RETURNING id::text, name, method""",
            body.twin_id, body.name, body.method, body.description,
            json.dumps(body.config), body.score_interval_s, body.retrain_cron,
            body.train_window_hours)
    except asyncpg.UniqueViolationError:
        raise HTTPException(409, "A model with this name already exists for the twin")
    await _audit(pool, row["id"], "config_changed", user.username, "model created")
    return dict(row)


@router.put("/models/{model_id}")
async def update_model(
    model_id: str,
    body: ModelUpdate,
    pool: asyncpg.Pool = Depends(get_pool),
    user: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(400, "No fields to update")
    sets, vals = [], []
    for k, v in fields.items():
        vals.append(json.dumps(v) if k == "config" else v)
        sets.append(f"{k} = ${len(vals)}" + ("::jsonb" if k == "config" else ""))
    vals.append(model_id)
    row = await pool.fetchrow(
        f"""UPDATE pred_models SET {', '.join(sets)}, updated_at=NOW()
            WHERE id=${len(vals)}::uuid RETURNING id::text, name""", *vals)
    if not row:
        raise HTTPException(404, "Model not found")
    await _audit(pool, model_id, "config_changed", user.username, "model updated")
    return dict(row)


@router.delete("/models/{model_id}", status_code=204)
async def delete_model(
    model_id: str,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    res = await pool.execute("DELETE FROM pred_models WHERE id=$1::uuid", model_id)
    if res.endswith("0"):
        raise HTTPException(404, "Model not found")
    return None


# ── versions & lifecycle ────────────────────────────────────────────────────
@router.get("/models/{model_id}/versions")
async def list_versions(
    model_id: str,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(get_current_user),
):
    rows = await pool.fetch(
        """SELECT id::text, version, status, trained_at, trained_by, train_start,
                  train_end, train_sample_count, metrics, notes
           FROM pred_model_versions WHERE model_id=$1::uuid ORDER BY version DESC""",
        model_id)
    out = []
    for r in rows:
        d = dict(r)
        for k in ("trained_at", "train_start", "train_end"):
            if d.get(k) is not None:
                d[k] = d[k].isoformat()
        out.append(d)
    return out


@router.post("/models/{model_id}/train")
async def train_now(
    model_id: str,
    pool: asyncpg.Pool = Depends(get_pool),
    redis=Depends(get_redis),
    user: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    """Request training of a new version. The predictive service performs the
    fit (it owns the ML dependencies) and writes the version; this keeps the
    API lightweight. Returns immediately with a queued status."""
    m = await pool.fetchrow(
        """SELECT id::text, twin_id::text, method FROM pred_models WHERE id=$1::uuid""",
        model_id)
    if not m:
        raise HTTPException(404, "Model not found")
    if m["method"] not in AVAILABLE_METHODS:
        raise HTTPException(400, "Model method not available in this build")

    signals = await pool.fetchval(
        "SELECT COUNT(*) FROM twin_signals WHERE twin_id=$1::uuid", m["twin_id"])
    if not signals:
        raise HTTPException(422, "Twin has no signals to train on")

    await _audit(pool, model_id, "train_requested", user.username, "queued for service")
    await redis.publish("predictive:commands", json.dumps({
        "cmd": "train", "model_id": model_id, "actor": user.username}))
    return {"status": "queued", "model_id": model_id,
            "detail": "Training requested; the predictive service will fit and store a new version."}


@router.post("/models/{model_id}/versions/{version_id}/activate")
async def activate(
    model_id: str,
    version_id: str,
    pool: asyncpg.Pool = Depends(get_pool),
    user: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    v = await pool.fetchrow(
        "SELECT version FROM pred_model_versions WHERE id=$1::uuid AND model_id=$2::uuid",
        version_id, model_id)
    if not v:
        raise HTTPException(404, "Version not found for model")
    async with pool.acquire() as con:
        async with con.transaction():
            await con.execute(
                "UPDATE pred_model_versions SET status='retired' WHERE model_id=$1::uuid AND status='active'",
                model_id)
            await con.execute(
                "UPDATE pred_model_versions SET status='active' WHERE id=$1::uuid", version_id)
    await _audit(pool, model_id, "activated", user.username, f"activated v{v['version']}", version_id=version_id)
    return {"status": "active", "version": v["version"]}


@router.post("/models/{model_id}/rollback")
async def rollback(
    model_id: str,
    pool: asyncpg.Pool = Depends(get_pool),
    user: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    """Activate the most recent previously-retired version (one step back)."""
    prev = await pool.fetchrow(
        """SELECT id::text, version FROM pred_model_versions
           WHERE model_id=$1::uuid AND status='retired'
           ORDER BY version DESC LIMIT 1""", model_id)
    if not prev:
        raise HTTPException(404, "No previous version to roll back to")
    async with pool.acquire() as con:
        async with con.transaction():
            await con.execute(
                "UPDATE pred_model_versions SET status='retired' WHERE model_id=$1::uuid AND status='active'",
                model_id)
            await con.execute(
                "UPDATE pred_model_versions SET status='active' WHERE id=$1::uuid", prev["id"])
    await _audit(pool, model_id, "rolled_back", user.username,
                 f"rolled back to v{prev['version']}", version_id=prev["id"])
    return {"status": "active", "version": prev["version"]}


# ── audit & drift ───────────────────────────────────────────────────────────
@router.get("/models/{model_id}/audit")
async def get_audit(
    model_id: str,
    limit: int = 100,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(get_current_user),
):
    rows = await pool.fetch(
        """SELECT event, actor, detail, payload, created_at
           FROM pred_audit WHERE model_id=$1::uuid ORDER BY created_at DESC LIMIT $2""",
        model_id, min(limit, 500))
    out = []
    for r in rows:
        d = dict(r)
        d["created_at"] = d["created_at"].isoformat() if d["created_at"] else None
        out.append(d)
    return out


@router.get("/models/{model_id}/drift")
async def get_drift(
    model_id: str,
    limit: int = 50,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(get_current_user),
):
    rows = await pool.fetch(
        """SELECT drift_score, drifted, detail, created_at
           FROM pred_model_drift WHERE model_id=$1::uuid ORDER BY created_at DESC LIMIT $2""",
        model_id, min(limit, 200))
    out = []
    for r in rows:
        d = dict(r)
        d["created_at"] = d["created_at"].isoformat() if d["created_at"] else None
        out.append(d)
    return out
