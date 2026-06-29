"""
Digital Twin Management API
Feature flag: FEATURE_DIGITAL_TWIN

Built-in 'status' tier. On-demand modules (predictive, closed-loop) write to
twin_outputs per docs/DIGITAL_TWIN_PLUGIN_CONTRACT.md.
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


# ── Schemas ─────────────────────────────────────────────────────────────────
class TwinCreate(BaseModel):
    asset_id: str
    name: str
    description: Optional[str] = None
    model_type: str = "status"


class TwinUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    enabled: Optional[bool] = None


class SignalCreate(BaseModel):
    tag_id: str
    role: Optional[str] = None
    label: Optional[str] = None
    unit: Optional[str] = None
    envelope_mode: str = "manual"          # manual | learned
    manual_min: Optional[float] = None
    manual_max: Optional[float] = None
    manual_target: Optional[float] = None
    warn_fraction: Optional[float] = 0.1
    learn_method: Optional[str] = "sigma"  # sigma | percentile
    learn_window_hours: Optional[int] = 168
    learn_k: Optional[float] = 3.0
    learn_p_low: Optional[float] = 1.0
    learn_p_high: Optional[float] = 99.0


class SignalUpdate(BaseModel):
    role: Optional[str] = None
    label: Optional[str] = None
    unit: Optional[str] = None
    envelope_mode: Optional[str] = None
    manual_min: Optional[float] = None
    manual_max: Optional[float] = None
    manual_target: Optional[float] = None
    warn_fraction: Optional[float] = None
    learn_method: Optional[str] = None
    learn_window_hours: Optional[int] = None
    learn_k: Optional[float] = None
    learn_p_low: Optional[float] = None
    learn_p_high: Optional[float] = None


# ── Twin definitions ────────────────────────────────────────────────────────
@router.get("/")
async def list_twins(
    redis: aioredis.Redis = Depends(get_redis),
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(get_current_user),
):
    rows = await pool.fetch(
        """SELECT d.id::text, d.asset_id::text, d.name, d.description,
                  d.model_type, d.enabled, a.name AS asset_name
           FROM twin_definitions d JOIN assets a ON a.id = d.asset_id
           ORDER BY a.name, d.name"""
    )
    twins = [dict(r) for r in rows]
    # enrich with live health from Redis state
    for t in twins:
        raw = await redis.get(f"twin:state:{t['id']}")
        st = json.loads(raw) if raw else {}
        t["health"] = st.get("health", "unknown")
        t["signal_count"] = len(st.get("signals", []))
        t["evaluated_at"] = st.get("evaluated_at")
    return twins


@router.post("/", status_code=201)
async def create_twin(
    body: TwinCreate,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    asset = await pool.fetchval("SELECT 1 FROM assets WHERE id=$1::uuid", body.asset_id)
    if not asset:
        raise HTTPException(404, "Asset not found")
    try:
        row = await pool.fetchrow(
            """INSERT INTO twin_definitions (asset_id, name, description, model_type)
               VALUES ($1::uuid, $2, $3, $4)
               RETURNING id::text, asset_id::text, name, description, model_type, enabled""",
            body.asset_id, body.name, body.description, body.model_type,
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(409, "A twin with this name already exists for the asset")
    return dict(row)


@router.get("/{twin_id}")
async def get_twin(
    twin_id: str,
    redis: aioredis.Redis = Depends(get_redis),
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(get_current_user),
):
    d = await pool.fetchrow(
        """SELECT d.id::text, d.asset_id::text, d.name, d.description,
                  d.model_type, d.enabled, a.name AS asset_name
           FROM twin_definitions d JOIN assets a ON a.id = d.asset_id
           WHERE d.id=$1::uuid""",
        twin_id,
    )
    if not d:
        raise HTTPException(404, "Twin not found")

    sigs = await pool.fetch(
        """SELECT s.id::text, s.tag_id::text, s.role, s.label, s.unit,
                  s.envelope_mode, s.manual_min, s.manual_max, s.manual_target,
                  s.warn_fraction, s.learn_method, s.learn_window_hours, s.learn_k,
                  s.learn_p_low, s.learn_p_high, s.learned_min, s.learned_max,
                  s.learned_target, s.learned_at, s.learned_sample_count, s.sort_order,
                  t.display_name, t.node_id, t.engineering_unit
           FROM twin_signals s JOIN tags t ON t.id = s.tag_id
           WHERE s.twin_id=$1::uuid ORDER BY s.sort_order, t.display_name""",
        twin_id,
    )

    raw = await redis.get(f"twin:state:{twin_id}")
    state = json.loads(raw) if raw else {}
    live_by_sig = {s["signal_id"]: s for s in state.get("signals", [])}

    out = dict(d)
    out["health"] = state.get("health", "unknown")
    out["evaluated_at"] = state.get("evaluated_at")
    out["signals"] = []
    for s in sigs:
        sd = dict(s)
        for k in ("learned_at",):
            if sd.get(k) is not None:
                sd[k] = sd[k].isoformat()
        live = live_by_sig.get(sd["id"], {})
        sd["live_value"] = live.get("value")
        sd["live_health"] = live.get("health", "unknown")
        sd["stale"] = live.get("stale", True)
        out["signals"].append(sd)
    return out


@router.put("/{twin_id}")
async def update_twin(
    twin_id: str,
    body: TwinUpdate,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(400, "No fields to update")
    sets, vals = [], []
    for k, v in fields.items():
        vals.append(v); sets.append(f"{k} = ${len(vals)}")
    vals.append(twin_id)
    row = await pool.fetchrow(
        f"""UPDATE twin_definitions SET {', '.join(sets)}, updated_at=NOW()
            WHERE id=${len(vals)}::uuid
            RETURNING id::text, asset_id::text, name, description, model_type, enabled""",
        *vals,
    )
    if not row:
        raise HTTPException(404, "Twin not found")
    return dict(row)


@router.delete("/{twin_id}", status_code=204)
async def delete_twin(
    twin_id: str,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    res = await pool.execute("DELETE FROM twin_definitions WHERE id=$1::uuid", twin_id)
    if res.endswith("0"):
        raise HTTPException(404, "Twin not found")
    return None


# ── Signals ─────────────────────────────────────────────────────────────────
@router.post("/{twin_id}/signals", status_code=201)
async def add_signal(
    twin_id: str,
    body: SignalCreate,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    twin = await pool.fetchval("SELECT 1 FROM twin_definitions WHERE id=$1::uuid", twin_id)
    if not twin:
        raise HTTPException(404, "Twin not found")
    try:
        row = await pool.fetchrow(
            """INSERT INTO twin_signals
               (twin_id, tag_id, role, label, unit, envelope_mode,
                manual_min, manual_max, manual_target, warn_fraction,
                learn_method, learn_window_hours, learn_k, learn_p_low, learn_p_high)
               VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
               RETURNING id::text""",
            twin_id, body.tag_id, body.role, body.label, body.unit, body.envelope_mode,
            body.manual_min, body.manual_max, body.manual_target, body.warn_fraction,
            body.learn_method, body.learn_window_hours, body.learn_k,
            body.learn_p_low, body.learn_p_high,
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(409, "This tag is already a signal on this twin")
    return {"id": row["id"]}


@router.put("/signals/{signal_id}")
async def update_signal(
    signal_id: str,
    body: SignalUpdate,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(400, "No fields to update")
    sets, vals = [], []
    for k, v in fields.items():
        vals.append(v); sets.append(f"{k} = ${len(vals)}")
    vals.append(signal_id)
    row = await pool.fetchrow(
        f"""UPDATE twin_signals SET {', '.join(sets)}
            WHERE id=${len(vals)}::uuid RETURNING id::text""",
        *vals,
    )
    if not row:
        raise HTTPException(404, "Signal not found")
    return {"id": row["id"]}


@router.delete("/signals/{signal_id}", status_code=204)
async def delete_signal(
    signal_id: str,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    res = await pool.execute("DELETE FROM twin_signals WHERE id=$1::uuid", signal_id)
    if res.endswith("0"):
        raise HTTPException(404, "Signal not found")
    return None


@router.post("/signals/{signal_id}/learn")
async def learn_signal_now(
    signal_id: str,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    """Recompute the learned envelope for one signal immediately from history."""
    s = await pool.fetchrow(
        """SELECT id::text, tag_id::text, learn_method, learn_window_hours,
                  learn_k, learn_p_low, learn_p_high
           FROM twin_signals WHERE id=$1::uuid""",
        signal_id,
    )
    if not s:
        raise HTTPException(404, "Signal not found")

    from datetime import datetime, timezone, timedelta
    window = s["learn_window_hours"] or 168
    method = (s["learn_method"] or "sigma").lower()
    since = datetime.now(tz=timezone.utc) - timedelta(hours=window)

    if method == "percentile":
        row = await pool.fetchrow(
            """SELECT percentile_cont($3) WITHIN GROUP (ORDER BY value_num) AS lo,
                      percentile_cont($4) WITHIN GROUP (ORDER BY value_num) AS hi,
                      percentile_cont(0.5) WITHIN GROUP (ORDER BY value_num) AS mid,
                      COUNT(*) AS n
               FROM tag_values
               WHERE tag_id=$1::uuid AND time>=$2 AND value_num IS NOT NULL""",
            s["tag_id"], since, (s["learn_p_low"] or 1.0) / 100.0,
            (s["learn_p_high"] or 99.0) / 100.0,
        )
        if not row or not row["n"] or row["lo"] is None:
            raise HTTPException(422, "Not enough history to learn an envelope")
        lo, hi, mid, n = float(row["lo"]), float(row["hi"]), float(row["mid"]), int(row["n"])
    else:
        k = s["learn_k"] or 3.0
        row = await pool.fetchrow(
            """SELECT AVG(value_num) AS mean, STDDEV_SAMP(value_num) AS std, COUNT(*) AS n
               FROM tag_values
               WHERE tag_id=$1::uuid AND time>=$2 AND value_num IS NOT NULL""",
            s["tag_id"], since,
        )
        if not row or not row["n"] or row["mean"] is None:
            raise HTTPException(422, "Not enough history to learn an envelope")
        mean, std, n = float(row["mean"]), float(row["std"] or 0.0), int(row["n"])
        lo, hi, mid = mean - k * std, mean + k * std, mean

    await pool.execute(
        """UPDATE twin_signals
           SET learned_min=$2, learned_max=$3, learned_target=$4,
               learned_at=NOW(), learned_sample_count=$5, envelope_mode='learned'
           WHERE id=$1::uuid""",
        signal_id, lo, hi, mid, n,
    )
    return {"learned_min": lo, "learned_max": hi, "learned_target": mid, "sample_count": n}


# ── Module outputs (read) ───────────────────────────────────────────────────
@router.get("/{twin_id}/outputs")
async def get_twin_outputs(
    twin_id: str,
    limit: int = 50,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(get_current_user),
):
    """Outputs produced by on-demand modules (predictive/closed-loop)."""
    rows = await pool.fetch(
        """SELECT id::text, module, output_type, tag_id::text, severity, title,
                  detail, payload, requires_approval, approved, approved_by, created_at
           FROM twin_outputs WHERE twin_id=$1::uuid
           ORDER BY created_at DESC LIMIT $2""",
        twin_id, min(limit, 200),
    )
    out = []
    for r in rows:
        d = dict(r)
        if d.get("created_at") is not None:
            d["created_at"] = d["created_at"].isoformat()
        if isinstance(d.get("payload"), str):
            try:
                d["payload"] = json.loads(d["payload"])
            except Exception:
                pass
        out.append(d)
    return out
