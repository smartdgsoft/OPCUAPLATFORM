"""
Gain Calibration API
Feature flag: FEATURE_PROBLEM_TEMPLATES (calibration is part of the template system)

Endpoints to plan and run a gain calibration for a unit of a problem instance,
in either manual (operator-entered points) or automated (platform-driven) mode,
then apply the computed gain into the instance config.
"""
from __future__ import annotations
import json
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from src.auth.jwt import UserOut, require_roles, get_current_user
from src.db.database import get_pool, get_redis

router = APIRouter()


def _gain(points: List[Dict[str, float]]) -> Dict[str, Any]:
    """Least-squares gain of measured vs setting, in plain Python (no numpy —
    the API service is lean; the twin-predictive service has the heavier math).
    Returns {gain, intercept, r_squared, n, error}."""
    n = len(points)
    if n < 2:
        return {"gain": None, "intercept": None, "r_squared": None, "n": n,
                "error": "need at least 2 points"}
    xs = [float(p["setting_value"]) for p in points]
    ys = [float(p["measured_value"]) for p in points]
    if max(xs) - min(xs) < 1e-9:
        return {"gain": None, "intercept": None, "r_squared": None, "n": n,
                "error": "settings did not vary — cannot compute gain"}
    mx = sum(xs) / n
    my = sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    slope = sxy / sxx
    intercept = my - slope * mx
    ss_tot = sum((y - my) ** 2 for y in ys)
    ss_res = sum((y - (slope * x + intercept)) ** 2 for x, y in zip(xs, ys))
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 1e-12 else 1.0
    return {"gain": float(slope), "intercept": float(intercept),
            "r_squared": float(r2), "n": n, "error": None}


class CalibrationCreate(BaseModel):
    instance_id: str
    unit_key: Optional[str] = None
    measurement_tag_id: Optional[str] = None
    setting_tag_id: Optional[str] = None
    target_server_id: Optional[str] = None
    mode: str = "manual"                 # manual | automated
    plan: Dict[str, Any] = {}            # {steps:[...], settle_s, samples_per_step, sample_gap_s}
    notes: Optional[str] = None


class PointIn(BaseModel):
    step_index: int = 0
    setting_value: float
    measured_value: float
    n_samples: int = 1


@router.get("/instances/{instance_id}/calibrations")
async def list_calibrations(
    instance_id: str,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(get_current_user),
):
    rows = await pool.fetch(
        """SELECT id::text, unit_key, mode, status, computed_gain, r_squared,
                  n_points, notes, error, created_at, completed_at
           FROM calibrations WHERE instance_id=$1::uuid ORDER BY created_at DESC""",
        instance_id)
    out = []
    for r in rows:
        d = dict(r)
        for k in ("created_at", "completed_at"):
            if d.get(k):
                d[k] = d[k].isoformat()
        out.append(d)
    return out


@router.post("/calibrations", status_code=201)
async def create_calibration(
    body: CalibrationCreate,
    pool: asyncpg.Pool = Depends(get_pool),
    user: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    if body.mode not in ("manual", "automated"):
        raise HTTPException(400, "mode must be manual or automated")
    if body.mode == "automated" and not (body.setting_tag_id and body.target_server_id and body.measurement_tag_id):
        raise HTTPException(422, "automated mode requires measurement_tag_id, setting_tag_id, target_server_id")
    cid = await pool.fetchval(
        """INSERT INTO calibrations
           (instance_id, unit_key, measurement_tag_id, setting_tag_id, target_server_id,
            mode, plan, notes, created_by, status)
           VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,$9,'planned')
           RETURNING id::text""",
        body.instance_id, body.unit_key, body.measurement_tag_id, body.setting_tag_id,
        body.target_server_id, body.mode, json.dumps(body.plan), body.notes, user.username)
    return {"id": cid}


@router.get("/calibrations/{calibration_id}")
async def get_calibration(
    calibration_id: str,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(get_current_user),
):
    cal = await pool.fetchrow("SELECT * FROM calibrations WHERE id=$1::uuid", calibration_id)
    if not cal:
        raise HTTPException(404, "calibration not found")
    d = dict(cal)
    for k in ("id", "instance_id", "measurement_tag_id", "setting_tag_id", "target_server_id"):
        if d.get(k) is not None:
            d[k] = str(d[k])
    for k in ("created_at", "updated_at", "completed_at"):
        if d.get(k):
            d[k] = d[k].isoformat()
    if isinstance(d.get("plan"), str):
        d["plan"] = json.loads(d["plan"])
    pts = await pool.fetch(
        """SELECT step_index, setting_value, measured_value, measured_std, n_samples, source
           FROM calibration_points WHERE calibration_id=$1::uuid ORDER BY step_index, created_at""",
        calibration_id)
    d["points"] = [dict(p) for p in pts]
    return d


@router.post("/calibrations/{calibration_id}/points")
async def add_point(
    calibration_id: str,
    body: PointIn,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    """Manual mode: operator records one (setting, measured) point."""
    cal = await pool.fetchrow("SELECT id FROM calibrations WHERE id=$1::uuid", calibration_id)
    if not cal:
        raise HTTPException(404, "calibration not found")
    await pool.execute(
        """INSERT INTO calibration_points
           (calibration_id, step_index, setting_value, measured_value, n_samples, source)
           VALUES ($1::uuid,$2,$3,$4,$5,'manual')""",
        calibration_id, body.step_index, body.setting_value, body.measured_value, body.n_samples)
    await pool.execute("UPDATE calibrations SET status='collecting', updated_at=NOW() WHERE id=$1::uuid",
                       calibration_id)
    # recompute on each point so the UI can show gain forming
    rows = await pool.fetch(
        "SELECT setting_value, measured_value FROM calibration_points WHERE calibration_id=$1::uuid",
        calibration_id)
    res = _gain([{"setting_value": r["setting_value"], "measured_value": r["measured_value"]} for r in rows])
    await pool.execute(
        """UPDATE calibrations SET computed_gain=$2, intercept=$3, r_squared=$4, n_points=$5,
               status=CASE WHEN $2 IS NULL THEN status ELSE 'computed' END, error=$6, updated_at=NOW()
           WHERE id=$1::uuid""",
        calibration_id, res["gain"], res["intercept"], res["r_squared"], res["n"], res["error"])
    return res


@router.post("/calibrations/{calibration_id}/run")
async def run_automated(
    calibration_id: str,
    pool: asyncpg.Pool = Depends(get_pool),
    redis=Depends(get_redis),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    """Automated mode: enqueue a command for the twin-predictive service to drive
    the setting steps through the write path and measure the response."""
    cal = await pool.fetchrow("SELECT mode, status FROM calibrations WHERE id=$1::uuid", calibration_id)
    if not cal:
        raise HTTPException(404, "calibration not found")
    if cal["mode"] != "automated":
        raise HTTPException(400, "this calibration is not in automated mode")
    await redis.publish("calibration:commands",
                        json.dumps({"action": "run", "calibration_id": calibration_id}))
    await pool.execute("UPDATE calibrations SET status='running', updated_at=NOW() WHERE id=$1::uuid",
                       calibration_id)
    return {"status": "queued", "message": "Automated calibration started — the platform will "
            "step the setting and measure the response. Watch status for completion."}


@router.post("/calibrations/{calibration_id}/apply")
async def apply_gain(
    calibration_id: str,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    """Write the computed gain into the instance config (highest-priority source)."""
    cal = await pool.fetchrow("SELECT * FROM calibrations WHERE id=$1::uuid", calibration_id)
    if not cal:
        raise HTTPException(404, "calibration not found")
    if cal["computed_gain"] is None:
        raise HTTPException(400, "no computed gain — collect at least 2 varied points first")
    meas_tag = str(cal["measurement_tag_id"]) if cal["measurement_tag_id"] else None
    if not meas_tag:
        raise HTTPException(400, "calibration has no measurement tag to key the gain")

    inst = await pool.fetchrow("SELECT config FROM problem_instances WHERE id=$1::uuid", cal["instance_id"])
    config = inst["config"] if isinstance(inst["config"], dict) else json.loads(inst["config"])
    action = config.get("action") or {}
    gain_map = action.get("calibrated_gain_map") or {}
    gain_map[meas_tag] = {"gain": cal["computed_gain"], "r_squared": cal["r_squared"],
                          "calibrated_at": datetime.now(tz=timezone.utc).isoformat(),
                          "calibration_id": calibration_id}
    action["calibrated_gain_map"] = gain_map
    config["action"] = action
    await pool.execute("UPDATE problem_instances SET config=$2, updated_at=NOW() WHERE id=$1::uuid",
                       cal["instance_id"], json.dumps(config))
    await pool.execute("UPDATE calibrations SET status='applied', completed_at=NOW(), updated_at=NOW() WHERE id=$1::uuid",
                       calibration_id)
    return {"ok": True, "gain": cal["computed_gain"], "r_squared": cal["r_squared"]}


@router.delete("/calibrations/{calibration_id}", status_code=204)
async def delete_calibration(
    calibration_id: str,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    res = await pool.execute("DELETE FROM calibrations WHERE id=$1::uuid", calibration_id)
    if res.endswith("0"):
        raise HTTPException(404, "calibration not found")
    return None
