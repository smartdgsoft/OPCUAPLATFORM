"""
Digital Twin Evaluator Service
==============================
A dedicated long-running service (like opcua-client) that:
  1. Loads enabled twin definitions + their signals from Postgres.
  2. For each signal, resolves an operating envelope:
       - manual:  operator-entered min/max/target
       - learned: derived from TimescaleDB history (sigma or percentile),
                  refreshed periodically and written back to twin_signals.
  3. Reads the live value (Redis tag:live:{tag_id}), computes per-signal
     health (good/warning/bad/stale/unknown), and a per-asset rollup.
  4. Writes twin state to Redis (twin:state:{twin_id}) for the API/UI.

Gated by FEATURE_DIGITAL_TWIN. Deploy-on-demand: only runs where licensed.

This service implements the built-in 'status' tier and is the reference
implementation of docs/DIGITAL_TWIN_PLUGIN_CONTRACT.md.
"""
from __future__ import annotations
import asyncio
import json
import os
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional

import asyncpg
import redis.asyncio as aioredis
import structlog
from prometheus_client import start_http_server, Gauge, Counter

logger = structlog.get_logger(__name__)

# ── Config (env) ────────────────────────────────────────────────────────────
POSTGRES_DSN = os.getenv(
    "POSTGRES_DSN",
    "postgresql://opcua_admin:changeme_strong_pass@timescaledb:5432/opcua",
).replace("postgresql+asyncpg://", "postgresql://")
REDIS_URL = os.getenv("REDIS_URL", "redis://:redis_pass@redis:6379/0")
EVAL_INTERVAL_S = float(os.getenv("TWIN_EVAL_INTERVAL_S", "5"))
LEARN_REFRESH_S = float(os.getenv("TWIN_LEARN_REFRESH_S", "3600"))  # hourly
STALE_AFTER_S = float(os.getenv("TWIN_STALE_AFTER_S", "30"))
METRICS_PORT = int(os.getenv("TWIN_METRICS_PORT", "9092"))
STATE_TTL_S = int(os.getenv("TWIN_STATE_TTL_S", "30"))

# ── Metrics ─────────────────────────────────────────────────────────────────
SIGNALS_EVALUATED = Counter("twin_signals_evaluated_total", "Signals evaluated")
TWINS_ACTIVE = Gauge("twin_active_count", "Active twin definitions")
EVAL_ERRORS = Counter("twin_eval_errors_total", "Evaluation errors")


# ── Health computation ──────────────────────────────────────────────────────
def compute_health(
    value: Optional[float],
    vmin: Optional[float],
    vmax: Optional[float],
    warn_fraction: float,
    stale: bool,
) -> str:
    if stale:
        return "stale"
    if value is None or vmin is None or vmax is None:
        return "unknown"
    if value < vmin or value > vmax:
        return "bad"
    span = vmax - vmin
    if span > 0 and warn_fraction and warn_fraction > 0:
        band = span * warn_fraction
        if value < vmin + band or value > vmax - band:
            return "warning"
    return "good"


ROLLUP_ORDER = {"bad": 4, "warning": 3, "stale": 2, "unknown": 1, "good": 0}


def rollup(states: List[str]) -> str:
    if not states:
        return "unknown"
    return max(states, key=lambda s: ROLLUP_ORDER.get(s, 0))


# ── Learned-envelope computation ────────────────────────────────────────────
async def learn_envelope(pool: asyncpg.Pool, sig: Dict[str, Any]) -> Optional[Dict[str, float]]:
    """Derive min/max/target from history for one signal."""
    window_hours = sig.get("learn_window_hours") or 168
    method = (sig.get("learn_method") or "sigma").lower()
    since = datetime.now(tz=timezone.utc) - timedelta(hours=window_hours)

    if method == "percentile":
        p_low = sig.get("learn_p_low") or 1.0
        p_high = sig.get("learn_p_high") or 99.0
        row = await pool.fetchrow(
            """
            SELECT percentile_cont($3) WITHIN GROUP (ORDER BY value_num) AS lo,
                   percentile_cont($4) WITHIN GROUP (ORDER BY value_num) AS hi,
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY value_num) AS mid,
                   COUNT(*) AS n
            FROM tag_values
            WHERE tag_id = $1::uuid AND time >= $2 AND value_num IS NOT NULL
            """,
            sig["tag_id"], since, p_low / 100.0, p_high / 100.0,
        )
        if not row or not row["n"] or row["lo"] is None:
            return None
        return {"min": float(row["lo"]), "max": float(row["hi"]),
                "target": float(row["mid"]), "n": int(row["n"])}

    # default: sigma (mean ± k*std)
    k = sig.get("learn_k") or 3.0
    row = await pool.fetchrow(
        """
        SELECT AVG(value_num) AS mean, STDDEV_SAMP(value_num) AS std, COUNT(*) AS n
        FROM tag_values
        WHERE tag_id = $1::uuid AND time >= $2 AND value_num IS NOT NULL
        """,
        sig["tag_id"], since,
    )
    if not row or not row["n"] or row["mean"] is None:
        return None
    mean = float(row["mean"])
    std = float(row["std"] or 0.0)
    return {"min": mean - k * std, "max": mean + k * std,
            "target": mean, "n": int(row["n"])}


async def refresh_learned_bounds(pool: asyncpg.Pool) -> None:
    """Recompute learned envelopes for all learned-mode signals."""
    sigs = await pool.fetch(
        """SELECT id::text, tag_id::text, learn_method, learn_window_hours,
                  learn_k, learn_p_low, learn_p_high
           FROM twin_signals WHERE envelope_mode = 'learned'"""
    )
    for s in sigs:
        try:
            res = await learn_envelope(pool, dict(s))
            if res:
                await pool.execute(
                    """UPDATE twin_signals
                       SET learned_min=$2, learned_max=$3, learned_target=$4,
                           learned_at=NOW(), learned_sample_count=$5
                       WHERE id=$1::uuid""",
                    s["id"], res["min"], res["max"], res["target"], res["n"],
                )
                logger.info("learned_bounds_updated", signal_id=s["id"],
                            min=res["min"], max=res["max"], n=res["n"])
        except Exception as exc:
            logger.error("learn_failed", signal_id=s["id"], error=str(exc))


# ── Evaluation cycle ────────────────────────────────────────────────────────
async def evaluate_once(pool: asyncpg.Pool, redis: aioredis.Redis) -> None:
    twins = await pool.fetch(
        """SELECT d.id::text AS twin_id, d.asset_id::text, d.name, d.model_type,
                  a.name AS asset_name
           FROM twin_definitions d JOIN assets a ON a.id = d.asset_id
           WHERE d.enabled = TRUE"""
    )
    TWINS_ACTIVE.set(len(twins))

    for twin in twins:
        try:
            sigs = await pool.fetch(
                """SELECT s.id::text, s.tag_id::text, s.role, s.label, s.unit,
                          s.envelope_mode, s.manual_min, s.manual_max, s.manual_target,
                          s.warn_fraction, s.learned_min, s.learned_max, s.learned_target,
                          t.display_name, t.engineering_unit
                   FROM twin_signals s JOIN tags t ON t.id = s.tag_id
                   WHERE s.twin_id = $1::uuid ORDER BY s.sort_order, t.display_name""",
                twin["twin_id"],
            )
            tag_ids = [s["tag_id"] for s in sigs]
            live_raw = await redis.mget(*[f"tag:live:{tid}" for tid in tag_ids]) if tag_ids else []

            signal_states = []
            now = datetime.now(tz=timezone.utc)
            for s, raw in zip(sigs, live_raw):
                live = json.loads(raw) if raw else {}
                value = live.get("value")
                ts = live.get("ts")
                stale = True
                if ts:
                    try:
                        t = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                        stale = (now - t).total_seconds() > STALE_AFTER_S
                    except Exception:
                        stale = True

                mode = s["envelope_mode"]
                if mode == "learned":
                    vmin, vmax, vtarget = s["learned_min"], s["learned_max"], s["learned_target"]
                else:
                    vmin, vmax, vtarget = s["manual_min"], s["manual_max"], s["manual_target"]

                health = compute_health(
                    value if isinstance(value, (int, float)) else None,
                    vmin, vmax, s["warn_fraction"] or 0.0, stale,
                )
                SIGNALS_EVALUATED.inc()
                signal_states.append({
                    "signal_id": s["id"], "tag_id": s["tag_id"],
                    "label": s["label"] or s["display_name"],
                    "role": s["role"], "unit": s["unit"] or s["engineering_unit"],
                    "value": value, "min": vmin, "max": vmax, "target": vtarget,
                    "mode": mode, "health": health, "stale": stale,
                })

            asset_health = rollup([s["health"] for s in signal_states])
            state = {
                "twin_id": twin["twin_id"], "asset_id": twin["asset_id"],
                "asset_name": twin["asset_name"], "name": twin["name"],
                "model_type": twin["model_type"], "health": asset_health,
                "signals": signal_states, "evaluated_at": now.isoformat(),
            }
            await redis.set(f"twin:state:{twin['twin_id']}", json.dumps(state), ex=STATE_TTL_S)
        except Exception as exc:
            EVAL_ERRORS.inc()
            logger.error("twin_eval_failed", twin_id=twin["twin_id"], error=str(exc))


# ── Main ────────────────────────────────────────────────────────────────────
async def main() -> None:
    structlog.configure(processors=[structlog.processors.JSONRenderer()])
    start_http_server(METRICS_PORT)
    logger.info("twin_evaluator_starting", eval_interval_s=EVAL_INTERVAL_S,
                learn_refresh_s=LEARN_REFRESH_S, metrics_port=METRICS_PORT)

    pool = await asyncpg.create_pool(POSTGRES_DSN, min_size=2, max_size=6)
    redis = aioredis.from_url(REDIS_URL, decode_responses=True)

    # Learn bounds at startup, then on a slower schedule.
    try:
        await refresh_learned_bounds(pool)
    except Exception as exc:
        logger.error("initial_learn_failed", error=str(exc))

    last_learn = asyncio.get_event_loop().time()
    while True:
        try:
            await evaluate_once(pool, redis)
            if asyncio.get_event_loop().time() - last_learn >= LEARN_REFRESH_S:
                await refresh_learned_bounds(pool)
                last_learn = asyncio.get_event_loop().time()
        except Exception as exc:
            logger.error("eval_cycle_error", error=str(exc))
        await asyncio.sleep(EVAL_INTERVAL_S)


if __name__ == "__main__":
    asyncio.run(main())
