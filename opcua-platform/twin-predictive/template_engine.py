"""
Problem Template Engine.

Runs configured problem instances. For each enabled instance on its cadence:
  1. resolve stream bindings (tag_id -> label/unit/role/stream_key)
  2. load train-window history + recent window
  3. refresh the template's model (learn/refresh) and persist it
  4. evaluate -> outputs (detect/predict/prescribe)
  5. persist outputs; mirror into twin_outputs if the asset has a twin
  6. for actionable 'prescribe' outputs -> create a closed-loop recommendation
     (pending human approval) — never actuates directly

Honest maturity/confidence is carried on every output.

Runs inside the twin-predictive service. Permissive OSS only.
"""
from __future__ import annotations
import json
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional

import asyncpg
import pandas as pd
import structlog

from templates import get_template

logger = structlog.get_logger(__name__)


async def _bindings(pool: asyncpg.Pool, config: Dict[str, Any]) -> Dict[str, Any]:
    """Resolve each input tag_id to its label/unit/stream_key for nicer output."""
    tag_ids = [i["tag_id"] for i in config.get("inputs", []) if i.get("tag_id")]
    if not tag_ids:
        return {}
    rows = await pool.fetch(
        """SELECT t.id::text AS tag_id, t.display_name, t.engineering_unit,
                  s.stream_key
           FROM tags t LEFT JOIN streams s ON s.tag_id = t.id
           WHERE t.id = ANY($1::uuid[])""", tag_ids)
    out = {}
    for r in rows:
        out[r["tag_id"]] = {"label": r["display_name"], "unit": r["engineering_unit"],
                            "stream_key": r["stream_key"] or r["display_name"]}
    return out


async def _load(pool: asyncpg.Pool, tag_ids: List[str],
                start: datetime, end: datetime) -> pd.DataFrame:
    if not tag_ids:
        return pd.DataFrame(columns=["time", "tag_id", "value"])
    rows = await pool.fetch(
        """SELECT time, tag_id::text AS tag_id, value_num AS value
           FROM tag_values WHERE tag_id = ANY($1::uuid[]) AND time>=$2 AND time<=$3
                 AND value_num IS NOT NULL ORDER BY time""",
        tag_ids, start, end)
    if not rows:
        return pd.DataFrame(columns=["time", "tag_id", "value"])
    df = pd.DataFrame(rows, columns=["time", "tag_id", "value"])
    df["time"] = pd.to_datetime(df["time"], utc=True)
    df["value"] = df["value"].astype(float)
    return df


async def _twin_for_asset(pool: asyncpg.Pool, asset_id: Optional[str]) -> Optional[str]:
    if not asset_id:
        return None
    return await pool.fetchval(
        "SELECT id::text FROM twin_definitions WHERE asset_id=$1::uuid LIMIT 1", asset_id)


async def _create_recommendation(pool: asyncpg.Pool, instance: Dict[str, Any],
                                 twin_id: Optional[str], output) -> Optional[str]:
    """Turn an actionable prescribe output into a pending closed-loop rec.
    Requires the closed_loop tables; if absent, skip gracefully.
    Deduplicates: if a pending rec already exists for this twin+target tag,
    do not create another (prevents one recommendation per eval cycle)."""
    if not output.target_tag_id or not output.target_server_id:
        return None
    try:
        # dedup: is there already a pending rec FROM THIS INSTANCE for this target?
        # Scoped by instance_id so an unrelated rule targeting the same tag
        # does not suppress this solver's recommendation.
        existing = await pool.fetchval(
            """SELECT id::text FROM cl_recommendations
               WHERE target_tag_id=$1::uuid AND status='pending'
               AND instance_id IS NOT DISTINCT FROM $2::uuid
               LIMIT 1""",
            output.target_tag_id, instance.get("id"))
        if existing:
            return existing  # reuse; don't spam a new one each cycle
        clamps = output.clamps or {}
        rid = await pool.fetchval(
            """INSERT INTO cl_recommendations
               (rule_id, twin_id, instance_id, source_tag_id, source_value, target_tag_id,
                target_server_id, current_value, recommended_value, clamped,
                severity, title, detail, rationale, status, expires_at)
               VALUES (NULL,$1::uuid,$2::uuid,NULL,NULL,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,$10,$11,'pending',$12)
               RETURNING id::text""",
            twin_id, instance.get("id"), output.target_tag_id, output.target_server_id,
            output.payload.get("current_setting"), output.value,
            bool(output.payload.get("clamped")),
            output.severity, output.title, output.detail,
            json.dumps(output.payload),
            datetime.now(tz=timezone.utc) + timedelta(minutes=30))
        return rid
    except asyncpg.UndefinedTableError:
        return None
    except Exception as exc:
        logger.error("rec_create_failed", error=str(exc))
        return None


async def run_instance(pool: asyncpg.Pool, inst_row: asyncpg.Record) -> int:
    """Run one problem instance once. Returns number of outputs produced."""
    instance = dict(inst_row)
    config = instance["config"] if isinstance(instance["config"], dict) else json.loads(instance["config"])
    try:
        template = get_template(instance["template_key"])
    except ValueError as exc:
        await pool.execute(
            "UPDATE problem_instances SET last_status='error', last_error=$2 WHERE id=$1::uuid",
            instance["id"], str(exc))
        return 0

    bindings = await _bindings(pool, config)
    tag_ids = list(bindings.keys())
    if not tag_ids:
        await pool.execute(
            "UPDATE problem_instances SET last_status='no_inputs' WHERE id=$1::uuid",
            instance["id"])
        return 0

    end = datetime.now(tz=timezone.utc)
    train_hours = int(config.get("model", {}).get("train_window_hours", 168))
    history = await _load(pool, tag_ids, end - timedelta(hours=train_hours), end)

    # 1. refresh model
    try:
        model = template.refresh_model(config, history, bindings)
    except Exception as exc:
        await pool.execute(
            "UPDATE problem_instances SET last_status='error', last_error=$2 WHERE id=$1::uuid",
            instance["id"], f"model: {exc}")
        logger.error("instance_model_failed", instance=instance["name"], error=str(exc))
        return 0

    # persist model state (new active version)
    nextv = await pool.fetchval(
        "SELECT COALESCE(MAX(version),0)+1 FROM problem_model_state WHERE instance_id=$1::uuid",
        instance["id"])
    await pool.execute(
        "UPDATE problem_model_state SET is_active=FALSE WHERE instance_id=$1::uuid",
        instance["id"])
    await pool.execute(
        """INSERT INTO problem_model_state (instance_id, version, parameters, metrics, sample_count, is_active)
           VALUES ($1::uuid,$2,$3,$4,$5,TRUE)""",
        instance["id"], nextv, json.dumps(model.parameters), json.dumps(model.metrics),
        model.sample_count)

    # 2. evaluate on recent window
    recent_min = int(config.get("model", {}).get("score_window_minutes", 15))
    recent = await _load(pool, tag_ids, end - timedelta(minutes=recent_min), end)
    try:
        outputs = template.evaluate(config, model, recent, bindings)
    except Exception as exc:
        await pool.execute(
            "UPDATE problem_instances SET last_status='error', last_error=$2 WHERE id=$1::uuid",
            instance["id"], f"eval: {exc}")
        logger.error("instance_eval_failed", instance=instance["name"], error=str(exc))
        return 0

    twin_id = await _twin_for_asset(pool, instance.get("asset_id"))

    written = 0
    for o in outputs:
        # change-detection: skip writing if the last output for this
        # (type, unit) is materially the same — avoids re-logging the identical
        # finding every eval cycle. A new row is written only when the value
        # moves meaningfully or the severity changes.
        last = await pool.fetchrow(
            """SELECT severity, value FROM problem_outputs
               WHERE instance_id=$1::uuid AND output_type=$2
                 AND unit_key IS NOT DISTINCT FROM $3
               ORDER BY created_at DESC LIMIT 1""",
            instance["id"], o.output_type, o.unit_key)
        if last is not None:
            prev_val = last["value"]
            same_sev = last["severity"] == o.severity
            # "material" change = value moved > 1% (or > 0.01 abs for tiny values)
            if prev_val is not None and o.value is not None:
                denom = max(abs(prev_val), 1e-6)
                moved = abs(o.value - prev_val) / denom
                unchanged = moved < 0.01
            else:
                unchanged = (prev_val == o.value)
            if same_sev and unchanged:
                # still refresh the pending recommendation for prescribe, but
                # don't write a duplicate output row
                if o.actionable and o.output_type == "prescribe":
                    await _create_recommendation(pool, instance, twin_id, o)
                continue

        rec_id = None
        if o.actionable and o.output_type == "prescribe":
            rec_id = await _create_recommendation(pool, instance, twin_id, o)

        await pool.execute(
            """INSERT INTO problem_outputs
               (instance_id, output_type, severity, unit_key, title, detail,
                value, confidence, maturity, payload, recommendation_id)
               VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)""",
            instance["id"], o.output_type, o.severity, o.unit_key, o.title, o.detail,
            o.value, o.confidence, o.maturity, json.dumps(o.payload),
            rec_id)

        # mirror to the twin's Module Outputs panel if linked
        if twin_id:
            try:
                await pool.execute(
                    """INSERT INTO twin_outputs
                       (twin_id, module, output_type, severity, title, detail, payload, requires_approval)
                       VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8)""",
                    twin_id, f"template:{instance['template_key']}",
                    "recommendation" if o.output_type == "prescribe" else o.output_type,
                    o.severity, o.title, o.detail,
                    json.dumps({**o.payload, "confidence": o.confidence, "maturity": o.maturity}),
                    bool(o.actionable))
            except Exception:
                pass
        written += 1

    await pool.execute(
        """UPDATE problem_instances
           SET maturity=$2, confidence=$3, last_eval_at=NOW(), last_status='ok', last_error=NULL
           WHERE id=$1::uuid""",
        instance["id"], model.maturity, model.confidence)

    if written:
        logger.info("instance_evaluated", instance=instance["name"],
                    outputs=written, maturity=model.maturity)
    return written


async def eval_pass(pool: asyncpg.Pool) -> None:
    """Evaluate all enabled instances that are due."""
    rows = await pool.fetch(
        """SELECT id::text, template_key, name, asset_id::text, config,
                  eval_interval_s, last_eval_at
           FROM problem_instances WHERE enabled = TRUE""")
    now = datetime.now(tz=timezone.utc)
    for r in rows:
        last = r["last_eval_at"]
        if last and (now - last).total_seconds() < (r["eval_interval_s"] or 60):
            continue
        try:
            await run_instance(pool, r)
        except Exception as exc:
            logger.error("instance_run_error", instance=r["name"], error=str(exc))
