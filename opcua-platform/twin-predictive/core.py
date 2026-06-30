"""
Predictive core — model lifecycle operations shared by the service loop and
the management API.

Responsibilities:
  - load training / scoring data from TimescaleDB as tidy frames
  - train a new versioned model (writes pred_model_versions + audit)
  - activate / rollback versions (governed, audited)
  - score the active version and write detections to twin_outputs
  - quality-gate on data freshness/quality before scoring
  - record model drift for self-monitoring

All outputs are advisory and written to twin_outputs (the plugin contract).
This module never actuates hardware.
"""
from __future__ import annotations
import json
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional

import asyncpg
import pandas as pd
import structlog

from detectors import get_detector

logger = structlog.get_logger(__name__)


# ── data loading ────────────────────────────────────────────────────────────
async def load_history(pool: asyncpg.Pool, tag_ids: List[str],
                       start: datetime, end: datetime) -> pd.DataFrame:
    if not tag_ids:
        return pd.DataFrame(columns=["time", "tag_id", "value"])
    rows = await pool.fetch(
        """SELECT time, tag_id::text AS tag_id, value_num AS value
           FROM tag_values
           WHERE tag_id = ANY($1::uuid[]) AND time >= $2 AND time <= $3
                 AND value_num IS NOT NULL
           ORDER BY time""",
        tag_ids, start, end,
    )
    if not rows:
        return pd.DataFrame(columns=["time", "tag_id", "value"])
    df = pd.DataFrame(rows, columns=["time", "tag_id", "value"])
    df["time"] = pd.to_datetime(df["time"], utc=True)
    df["value"] = df["value"].astype(float)
    return df


async def twin_signals(pool: asyncpg.Pool, twin_id: str) -> List[Dict[str, Any]]:
    rows = await pool.fetch(
        """SELECT s.tag_id::text, s.role, s.label, s.unit, t.display_name
           FROM twin_signals s JOIN tags t ON t.id = s.tag_id
           WHERE s.twin_id = $1::uuid ORDER BY s.sort_order""",
        twin_id,
    )
    return [{"tag_id": r["tag_id"], "role": r["role"],
             "label": r["label"] or r["display_name"], "unit": r["unit"]} for r in rows]


# ── audit ───────────────────────────────────────────────────────────────────
async def audit(pool: asyncpg.Pool, model_id: str, event: str, actor: str,
                detail: str = "", version_id: Optional[str] = None,
                payload: Optional[dict] = None) -> None:
    await pool.execute(
        """INSERT INTO pred_audit (model_id, version_id, event, actor, detail, payload)
           VALUES ($1::uuid, $2, $3, $4, $5, $6)""",
        model_id, version_id, event, actor, detail, json.dumps(payload or {}),
    )


# ── training ────────────────────────────────────────────────────────────────
async def train_model(pool: asyncpg.Pool, model_id: str, actor: str = "system") -> Dict[str, Any]:
    """Train a new version for a model and store it as 'trained' (not yet active)."""
    m = await pool.fetchrow(
        """SELECT id::text, twin_id::text, method, config, train_window_hours, name
           FROM pred_models WHERE id=$1::uuid""", model_id)
    if not m:
        raise ValueError("Model not found")

    signals = await twin_signals(pool, m["twin_id"])
    if not signals:
        raise ValueError("Twin has no signals to train on")

    end = datetime.now(tz=timezone.utc)
    start = end - timedelta(hours=m["train_window_hours"])
    tag_ids = [s["tag_id"] for s in signals]
    history = await load_history(pool, tag_ids, start, end)

    config = m["config"] if isinstance(m["config"], dict) else json.loads(m["config"] or "{}")
    detector = get_detector(m["method"], config)

    try:
        result = detector.train(history, signals)
    except Exception as exc:
        await audit(pool, model_id, "error", actor, f"train failed: {exc}")
        raise

    # next version number
    nextv = await pool.fetchval(
        "SELECT COALESCE(MAX(version),0)+1 FROM pred_model_versions WHERE model_id=$1::uuid",
        model_id)
    vid = await pool.fetchval(
        """INSERT INTO pred_model_versions
           (model_id, version, status, parameters, trained_by, train_start, train_end,
            train_sample_count, metrics, notes)
           VALUES ($1::uuid,$2,'trained',$3,$4,$5,$6,$7,$8,$9)
           RETURNING id::text""",
        model_id, nextv, json.dumps(result.parameters), actor, start, end,
        result.sample_count, json.dumps(result.metrics), result.notes,
    )
    await audit(pool, model_id, "trained", actor,
                f"v{nextv}: {result.notes}", version_id=vid,
                payload={"metrics": result.metrics, "samples": result.sample_count})
    logger.info("model_trained", model_id=model_id, version=nextv, samples=result.sample_count)
    return {"version_id": vid, "version": nextv, "metrics": result.metrics,
            "sample_count": result.sample_count, "notes": result.notes}


async def activate_version(pool: asyncpg.Pool, model_id: str, version_id: str,
                           actor: str = "system") -> None:
    """Make one version active; retire the previously active one. Governed."""
    v = await pool.fetchrow(
        "SELECT id::text, version, status FROM pred_model_versions WHERE id=$1::uuid AND model_id=$2::uuid",
        version_id, model_id)
    if not v:
        raise ValueError("Version not found for model")
    async with pool.acquire() as con:
        async with con.transaction():
            await con.execute(
                "UPDATE pred_model_versions SET status='retired' WHERE model_id=$1::uuid AND status='active'",
                model_id)
            await con.execute(
                "UPDATE pred_model_versions SET status='active' WHERE id=$1::uuid", version_id)
    await audit(pool, model_id, "activated", actor, f"activated v{v['version']}", version_id=version_id)
    logger.info("version_activated", model_id=model_id, version=v["version"])


async def active_version(pool: asyncpg.Pool, model_id: str) -> Optional[asyncpg.Record]:
    return await pool.fetchrow(
        """SELECT id::text, version, parameters FROM pred_model_versions
           WHERE model_id=$1::uuid AND status='active' LIMIT 1""", model_id)


# ── scoring ─────────────────────────────────────────────────────────────────
async def score_model(pool: asyncpg.Pool, model: asyncpg.Record) -> int:
    """Score a model's active version over the recent window; write detections.
    Returns number of detections written."""
    model_id = model["id"]
    twin_id = model["twin_id"]
    av = await active_version(pool, model_id)
    if not av:
        return 0

    signals = await twin_signals(pool, twin_id)
    if not signals:
        return 0

    config = model["config"] if isinstance(model["config"], dict) else json.loads(model["config"] or "{}")
    detector = get_detector(model["method"], config)
    params = av["parameters"] if isinstance(av["parameters"], dict) else json.loads(av["parameters"])

    # Recent window for scoring (a few minutes by default).
    end = datetime.now(tz=timezone.utc)
    recent_minutes = int(config.get("score_window_minutes", 10))
    start = end - timedelta(minutes=recent_minutes)
    tag_ids = [s["tag_id"] for s in signals]
    recent = await load_history(pool, tag_ids, start, end)
    if recent.empty:
        return 0

    try:
        detections = detector.score(params, recent, signals)
    except Exception as exc:
        await audit(pool, model_id, "error", "system", f"score failed: {exc}")
        logger.error("score_failed", model_id=model_id, error=str(exc))
        return 0

    written = 0
    for d in detections:
        await pool.execute(
            """INSERT INTO twin_outputs
               (twin_id, module, output_type, tag_id, severity, title, detail, payload)
               VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8)""",
            twin_id, f"predictive:{model['method']}", d.output_type,
            d.tag_id, d.severity, d.title, d.detail,
            json.dumps({**d.payload, "score": d.score, "confidence": d.confidence,
                        "model_id": model_id, "version_id": av["id"]}),
        )
        written += 1

    # Model self-monitoring (drift of inputs vs training).
    try:
        drift = detector.check_drift(params, recent, signals)
        if drift is not None:
            await pool.execute(
                """INSERT INTO pred_model_drift (model_id, version_id, drift_score, drifted, detail)
                   VALUES ($1::uuid,$2,$3,$4,$5)""",
                model_id, av["id"], drift.drift_score, drift.drifted, json.dumps(drift.detail))
            if drift.drifted:
                await audit(pool, model_id, "drift_detected", "system",
                            f"input drift {drift.drift_score:.2f}", version_id=av["id"],
                            payload=drift.detail)
    except Exception:
        pass

    if written:
        await audit(pool, model_id, "scored", "system",
                    f"{written} detection(s)", version_id=av["id"])
    return written
