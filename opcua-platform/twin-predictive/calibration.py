"""
Gain Calibration engine.

Computes a unit's gain (output-per-unit-of-setting) from a controlled experiment
where the setting is stepped through several values and the measured response is
recorded at each. This is the trustworthy way to get gain when passive history
has no setting-variation to learn from.

Two modes share the same math:
  manual    — operator enters each (setting, measured) point via the API/UI.
              This module just computes gain from the collected points.
  automated — this module issues each setting value through the approved write
              path (publishing to the write-command bus), waits for the line to
              settle, reads back the measured stream, records the point, then
              moves to the next step. Gains the same computation at the end.

Gain = slope of measured vs setting (least squares). R² reports fit quality;
a low R² means the relationship isn't linear/stable and the gain shouldn't be
trusted — reported honestly rather than hidden.

Permissive OSS only: numpy.
"""
from __future__ import annotations
import asyncio
import json
import uuid
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional

import asyncpg
import numpy as np
import structlog

logger = structlog.get_logger(__name__)


# ── gain computation (shared by both modes) ─────────────────────────────────
def compute_gain(points: List[Dict[str, float]]) -> Dict[str, Any]:
    """Least-squares fit of measured vs setting. points: [{setting, measured}].
    Returns {gain, intercept, r_squared, n}. Needs >= 2 distinct settings."""
    if len(points) < 2:
        return {"gain": None, "intercept": None, "r_squared": None, "n": len(points),
                "error": "need at least 2 points"}
    x = np.array([p["setting_value"] for p in points], dtype=float)
    y = np.array([p["measured_value"] for p in points], dtype=float)
    if np.ptp(x) < 1e-9:
        return {"gain": None, "intercept": None, "r_squared": None, "n": len(x),
                "error": "settings did not vary — cannot compute gain"}
    slope, intercept = np.polyfit(x, y, 1)
    y_pred = slope * x + intercept
    ss_res = float(np.sum((y - y_pred) ** 2))
    ss_tot = float(np.sum((y - np.mean(y)) ** 2))
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 1e-12 else 1.0
    return {"gain": float(slope), "intercept": float(intercept),
            "r_squared": float(r2), "n": int(len(x)), "error": None}


async def recompute_and_store(pool: asyncpg.Pool, calibration_id: str) -> Dict[str, Any]:
    """Recompute gain from all points of a calibration and persist the result."""
    rows = await pool.fetch(
        "SELECT setting_value, measured_value FROM calibration_points WHERE calibration_id=$1::uuid",
        calibration_id)
    points = [{"setting_value": r["setting_value"], "measured_value": r["measured_value"]} for r in rows]
    res = compute_gain(points)
    await pool.execute(
        """UPDATE calibrations
           SET computed_gain=$2, intercept=$3, r_squared=$4, n_points=$5,
               status=CASE WHEN $2 IS NULL THEN status ELSE 'computed' END,
               error=$6, updated_at=NOW()
           WHERE id=$1::uuid""",
        calibration_id, res["gain"], res["intercept"], res["r_squared"], res["n"], res["error"])
    return res


async def apply_calibration(pool: asyncpg.Pool, calibration_id: str) -> Dict[str, Any]:
    """Write the computed gain into the instance config so the template uses it.
    Stored under action.calibrated_gain_map keyed by measurement tag_id, with the
    highest priority (template prefers calibrated over learned/datasheet)."""
    cal = await pool.fetchrow("SELECT * FROM calibrations WHERE id=$1::uuid", calibration_id)
    if not cal:
        return {"ok": False, "error": "calibration not found"}
    if cal["computed_gain"] is None:
        return {"ok": False, "error": "no computed gain to apply — collect points and compute first"}

    meas_tag = str(cal["measurement_tag_id"]) if cal["measurement_tag_id"] else None
    if not meas_tag:
        return {"ok": False, "error": "calibration has no measurement tag to key the gain"}

    # merge into config.action.calibrated_gain_map
    inst = await pool.fetchrow("SELECT config FROM problem_instances WHERE id=$1::uuid", cal["instance_id"])
    config = inst["config"] if isinstance(inst["config"], dict) else json.loads(inst["config"])
    action = config.get("action") or {}
    gain_map = action.get("calibrated_gain_map") or {}
    gain_map[meas_tag] = {"gain": cal["computed_gain"], "r_squared": cal["r_squared"],
                          "calibrated_at": datetime.now(tz=timezone.utc).isoformat(),
                          "calibration_id": calibration_id}
    action["calibrated_gain_map"] = gain_map
    config["action"] = action

    await pool.execute(
        "UPDATE problem_instances SET config=$2, updated_at=NOW() WHERE id=$1::uuid",
        cal["instance_id"], json.dumps(config))
    await pool.execute(
        "UPDATE calibrations SET status='applied', completed_at=NOW(), updated_at=NOW() WHERE id=$1::uuid",
        calibration_id)
    logger.info("calibration_applied", calibration_id=calibration_id,
                gain=cal["computed_gain"], measurement_tag=meas_tag)
    return {"ok": True, "gain": cal["computed_gain"], "r_squared": cal["r_squared"]}


# ── automated run (issues writes, reads back) ───────────────────────────────
async def _latest_measured(pool: asyncpg.Pool, redis, tag_id: str) -> Optional[float]:
    """Read the freshest value for a tag: try Redis live cache, fall back to DB."""
    try:
        raw = await redis.get(f"tag:live:{tag_id}")
        if raw:
            d = json.loads(raw)
            if d.get("value") is not None:
                return float(d["value"])
    except Exception:
        pass
    row = await pool.fetchrow(
        "SELECT value_num FROM tag_values WHERE tag_id=$1::uuid AND value_num IS NOT NULL ORDER BY time DESC LIMIT 1",
        tag_id)
    return float(row["value_num"]) if row and row["value_num"] is not None else None


async def _issue_setting_write(redis, setting_tag_id: str, server_id: str, value: float) -> None:
    """Publish a write command to the same bus the write engine consumes.
    (Reuses the existing opcua write path — never writes directly.)"""
    cmd = {"command_id": str(uuid.uuid4()), "server_id": server_id,
           "tag_id": setting_tag_id, "value": value,
           "source": "calibration", "ts": datetime.now(tz=timezone.utc).isoformat()}
    await redis.publish("opcua:write:commands", json.dumps(cmd))


async def run_automated(pool: asyncpg.Pool, redis, calibration_id: str) -> Dict[str, Any]:
    """Drive an automated calibration: for each planned setting step, write it,
    wait to settle, sample the measured stream, record the averaged point.
    Then compute + return the gain. Does NOT auto-apply — a human reviews/applies."""
    cal = await pool.fetchrow("SELECT * FROM calibrations WHERE id=$1::uuid", calibration_id)
    if not cal:
        return {"ok": False, "error": "not found"}
    if not cal["setting_tag_id"] or not cal["target_server_id"] or not cal["measurement_tag_id"]:
        return {"ok": False, "error": "automated mode needs setting_tag, target_server, measurement_tag"}

    plan = cal["plan"] if isinstance(cal["plan"], dict) else json.loads(cal["plan"])
    steps: List[float] = [float(s) for s in plan.get("steps", [])]
    settle_s = float(plan.get("settle_s", 10))
    samples = int(plan.get("samples_per_step", 10))
    sample_gap_s = float(plan.get("sample_gap_s", 1.0))
    if len(steps) < 2:
        return {"ok": False, "error": "plan needs >= 2 setting steps"}

    setting_tag = str(cal["setting_tag_id"]); meas_tag = str(cal["measurement_tag_id"])
    server = str(cal["target_server_id"])

    await pool.execute("UPDATE calibrations SET status='running', updated_at=NOW() WHERE id=$1::uuid",
                       calibration_id)
    try:
        for i, sv in enumerate(steps):
            await _issue_setting_write(redis, setting_tag, server, sv)
            await asyncio.sleep(settle_s)  # let the process respond
            vals: List[float] = []
            for _ in range(samples):
                mv = await _latest_measured(pool, redis, meas_tag)
                if mv is not None:
                    vals.append(mv)
                await asyncio.sleep(sample_gap_s)
            if not vals:
                continue
            arr = np.array(vals, dtype=float)
            await pool.execute(
                """INSERT INTO calibration_points
                   (calibration_id, step_index, setting_value, measured_value, measured_std, n_samples, source)
                   VALUES ($1::uuid,$2,$3,$4,$5,$6,'measured')""",
                calibration_id, i, sv, float(arr.mean()),
                float(arr.std(ddof=1)) if arr.size > 1 else 0.0, int(arr.size))
        res = await recompute_and_store(pool, calibration_id)
        logger.info("calibration_automated_done", calibration_id=calibration_id,
                    gain=res.get("gain"), r2=res.get("r_squared"))
        return {"ok": True, **res}
    except Exception as exc:
        await pool.execute(
            "UPDATE calibrations SET status='failed', error=$2, updated_at=NOW() WHERE id=$1::uuid",
            calibration_id, str(exc))
        logger.error("calibration_automated_failed", calibration_id=calibration_id, error=str(exc))
        return {"ok": False, "error": str(exc)}
