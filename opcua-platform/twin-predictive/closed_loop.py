"""
Closed-Loop ADVISORY engine.

Evaluates advisory rules against live data and writes RECOMMENDATIONS. It does
NOT actuate. Every recommendation is 'pending' and must be approved by a human
through the API, which then routes actuation through the existing write-control
path (FEATURE_WRITE + RBAC + clamps + audit).

This engine has no Redis write-command publisher and no OPC UA client — by
construction it cannot move a setpoint. That is the safety boundary.

Run inside the twin-predictive service loop (it already has DB + live access).
Permissive OSS only.
"""
from __future__ import annotations
import json
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional

import asyncpg
import redis.asyncio as aioredis
import structlog

logger = structlog.get_logger(__name__)

_OPS = {
    ">":  lambda a, b: a > b,
    "<":  lambda a, b: a < b,
    ">=": lambda a, b: a >= b,
    "<=": lambda a, b: a <= b,
    "==": lambda a, b: a == b,
    "!=": lambda a, b: a != b,
}


async def _live_value(redis: aioredis.Redis, tag_id: str) -> Optional[float]:
    raw = await redis.get(f"tag:live:{tag_id}")
    if not raw:
        return None
    try:
        v = json.loads(raw).get("value")
        return float(v) if isinstance(v, (int, float)) else None
    except Exception:
        return None


def _clamp(value: float, lo: Optional[float], hi: Optional[float]) -> tuple[float, bool]:
    clamped = False
    if lo is not None and value < lo:
        value, clamped = lo, True
    if hi is not None and value > hi:
        value, clamped = hi, True
    return value, clamped


def _compute_recommendation(rule: Dict[str, Any], source_val: Optional[float],
                            target_val: Optional[float]) -> Optional[float]:
    """Compute the raw proposed setpoint (pre-clamp). None = cannot compute."""
    atype = rule["action_type"]
    if atype == "set_value":
        return rule.get("action_value")
    if atype == "adjust":
        if target_val is None or rule.get("action_value") is None:
            return None
        return target_val + rule["action_value"]
    if atype == "proportional":
        # Move target to reduce error between source and its desired value.
        if source_val is None or target_val is None or rule.get("source_target") is None:
            return None
        error = rule["source_target"] - source_val
        gain = rule.get("gain") or 1.0
        return target_val + gain * error
    return None


async def evaluate_rules(pool: asyncpg.Pool, redis: aioredis.Redis) -> int:
    """Evaluate all enabled advisory rules; write pending recommendations.
    Returns count of recommendations created."""
    rules = await pool.fetch(
        """SELECT r.*, d.name AS twin_name
           FROM cl_rules r JOIN twin_definitions d ON d.id = r.twin_id
           WHERE r.enabled = TRUE"""
    )
    created = 0
    now = datetime.now(tz=timezone.utc)

    for r in rules:
        rule = dict(r)
        rid = rule["id"]

        # cooldown: skip if a recent recommendation exists for this rule
        last = await pool.fetchval(
            "SELECT MAX(created_at) FROM cl_recommendations WHERE rule_id=$1::uuid", rid)
        if last and (now - last).total_seconds() < (rule["cooldown_s"] or 0):
            continue

        source_val = await _live_value(redis, str(rule["source_tag_id"])) if rule["source_tag_id"] else None

        # ── trigger evaluation ──
        fired = False
        if rule["trigger_type"] == "threshold":
            op = _OPS.get(rule["trigger_op"] or "")
            if op and source_val is not None and rule["trigger_value"] is not None:
                fired = op(source_val, rule["trigger_value"])
        elif rule["trigger_type"] == "anomaly":
            # fire if a recent anomaly output exists for this twin on the source tag
            anom = await pool.fetchval(
                """SELECT 1 FROM twin_outputs
                   WHERE twin_id=$1::uuid AND output_type='anomaly'
                         AND created_at > $2
                         AND ($3::uuid IS NULL OR tag_id = $3::uuid)
                   LIMIT 1""",
                rule["twin_id"], now - timedelta(minutes=5),
                rule["source_tag_id"])
            fired = bool(anom)

        if not fired:
            continue

        # ── compute proposed setpoint ──
        target_val = await _live_value(redis, str(rule["target_tag_id"])) if rule["target_tag_id"] else None
        raw_value = _compute_recommendation(rule, source_val, target_val)
        if raw_value is None:
            continue

        # max_step limit relative to current target
        if rule.get("max_step") is not None and target_val is not None:
            step = raw_value - target_val
            if abs(step) > rule["max_step"]:
                raw_value = target_val + (rule["max_step"] if step > 0 else -rule["max_step"])

        # safety clamps (always applied)
        value, clamped = _clamp(raw_value, rule.get("safety_min"), rule.get("safety_max"))

        expires = now + timedelta(seconds=max(rule["cooldown_s"] or 300, 300))
        await pool.execute(
            """INSERT INTO cl_recommendations
               (rule_id, twin_id, source_tag_id, source_value, target_tag_id,
                target_server_id, current_value, recommended_value, clamped,
                severity, title, detail, rationale, status, expires_at)
               VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',$14)""",
            rid, rule["twin_id"], rule["source_tag_id"], source_val,
            rule["target_tag_id"], rule["target_server_id"], target_val, value, clamped,
            rule["severity"], f"Recommended setpoint: {rule['name']}",
            (f"Suggest setting target to {value:.4g} "
             f"(source={source_val:.4g} triggered {rule['trigger_op'] or rule['trigger_type']} "
             f"{rule['trigger_value'] if rule['trigger_value'] is not None else ''})"),
            json.dumps({
                "rule": rule["name"], "trigger_type": rule["trigger_type"],
                "source_value": source_val, "target_current": target_val,
                "raw_value": raw_value, "clamped": clamped,
                "safety_min": rule.get("safety_min"), "safety_max": rule.get("safety_max"),
                "action_type": rule["action_type"],
            }),
            expires,
        )

        # Also surface in the twin's Module Outputs panel as a recommendation
        # that requires approval (advisory; the engine never applies it).
        await pool.execute(
            """INSERT INTO twin_outputs
               (twin_id, module, output_type, tag_id, severity, title, detail,
                payload, requires_approval)
               VALUES ($1::uuid,'closed_loop_advisory','recommendation',$2,$3,$4,$5,$6,TRUE)""",
            rule["twin_id"], rule["target_tag_id"], rule["severity"],
            f"Setpoint recommendation: {rule['name']}",
            f"Proposed {value:.4g} (requires approval)",
            json.dumps({"recommended_value": value, "clamped": clamped,
                        "source_value": source_val, "rule": rule["name"]}),
        )
        created += 1
        logger.info("recommendation_created", rule=rule["name"],
                    twin=rule["twin_name"], value=value, clamped=clamped)

    return created
