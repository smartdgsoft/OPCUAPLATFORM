"""
Predictive Service
==================
On-demand enterprise predictive module. Runs a scoring loop over all enabled
models' active versions, writing advisory detections to twin_outputs (surfaced
in the Digital Twin "Module Outputs" panel). Optionally retrains on a cadence.

Pluggable methods (univariate drift, multivariate, ...) via the detector
registry. Permissive OSS only. Advisory-only — never actuates hardware.

Gated by FEATURE_TWIN_PREDICTIVE. Deploy-on-demand: only runs where licensed
by configuration (a plain feature flag — no license/billing machinery).
"""
from __future__ import annotations
import asyncio
import json
import os
from datetime import datetime, timezone

import asyncpg
import redis.asyncio as aioredis
import structlog
from prometheus_client import start_http_server, Counter, Gauge

from core import score_model, train_model, activate_version, active_version
from closed_loop import evaluate_rules
from template_engine import eval_pass as template_eval_pass

logger = structlog.get_logger(__name__)

POSTGRES_DSN = os.getenv(
    "POSTGRES_DSN",
    "postgresql://opcua_admin:changeme_strong_pass@timescaledb:5432/opcua",
).replace("postgresql+asyncpg://", "postgresql://")
REDIS_URL = os.getenv("REDIS_URL", "redis://:redis_pass@redis:6379/0")
SCORE_INTERVAL_S = float(os.getenv("PRED_SCORE_INTERVAL_S", "30"))
RETRAIN_CHECK_S = float(os.getenv("PRED_RETRAIN_CHECK_S", "3600"))
ADVISORY_ENABLED = os.getenv("FEATURE_CLOSED_LOOP_ADVISORY", "false").lower() == "true"
TEMPLATES_ENABLED = os.getenv("FEATURE_PROBLEM_TEMPLATES", "false").lower() == "true"
METRICS_PORT = int(os.getenv("PRED_METRICS_PORT", "9093"))

DETECTIONS = Counter("pred_detections_total", "Detections written", ["method", "severity"])
MODELS_SCORED = Counter("pred_models_scored_total", "Model scoring passes")
ACTIVE_MODELS = Gauge("pred_active_models", "Models with an active version")
SCORE_ERRORS = Counter("pred_score_errors_total", "Scoring errors")
RECOMMENDATIONS = Counter("cl_recommendations_total", "Advisory recommendations created")


async def score_pass(pool: asyncpg.Pool) -> None:
    models = await pool.fetch(
        """SELECT id::text, twin_id::text, method, config, name, score_interval_s
           FROM pred_models WHERE enabled = TRUE"""
    )
    active = 0
    for m in models:
        try:
            av = await active_version(pool, m["id"])
            if not av:
                continue
            active += 1
            n = await score_model(pool, m)
            MODELS_SCORED.inc()
            if n:
                logger.info("scored", model=m["name"], method=m["method"], detections=n)
        except Exception as exc:
            SCORE_ERRORS.inc()
            logger.error("score_pass_error", model_id=m["id"], error=str(exc))
    ACTIVE_MODELS.set(active)


async def maybe_retrain(pool: asyncpg.Pool) -> None:
    """Auto-retrain models that declare a retrain cadence and are due.

    Simple cadence check (retrain_cron stores an interval-hours integer for
    now; a full cron parser can be added later without touching callers).
    """
    models = await pool.fetch(
        """SELECT id::text, name, retrain_cron FROM pred_models
           WHERE enabled = TRUE AND retrain_cron IS NOT NULL AND retrain_cron <> ''"""
    )
    for m in models:
        try:
            hours = int(str(m["retrain_cron"]).strip())
        except ValueError:
            continue  # non-integer cadence: skip (reserved for future cron)
        last = await pool.fetchval(
            """SELECT MAX(trained_at) FROM pred_model_versions WHERE model_id=$1::uuid""",
            m["id"])
        due = (last is None) or (
            (datetime.now(tz=timezone.utc) - last).total_seconds() >= hours * 3600)
        if due:
            try:
                res = await train_model(pool, m["id"], actor="scheduler")
                logger.info("auto_retrained", model=m["name"], version=res["version"])
            except Exception as exc:
                logger.error("auto_retrain_failed", model_id=m["id"], error=str(exc))


async def handle_commands(pool: asyncpg.Pool, redis: aioredis.Redis) -> None:
    """Listen for train requests from the API and perform them here (the
    service owns the ML dependencies). First version trains -> auto-activated
    so the model starts scoring; later retrains stay 'trained' until activated."""
    pubsub = redis.pubsub()
    await pubsub.subscribe("predictive:commands")
    logger.info("command_listener_ready", channel="predictive:commands")
    async for msg in pubsub.listen():
        if msg.get("type") != "message":
            continue
        try:
            data = json.loads(msg["data"])
        except Exception:
            continue
        if data.get("cmd") != "train":
            continue
        model_id = data.get("model_id")
        actor = data.get("actor", "api")
        try:
            res = await train_model(pool, model_id, actor=actor)
            # Auto-activate if this model has no active version yet.
            av = await active_version(pool, model_id)
            if not av:
                await activate_version(pool, model_id, res["version_id"], actor=actor)
                logger.info("first_version_auto_activated", model_id=model_id, version=res["version"])
        except Exception as exc:
            logger.error("train_command_failed", model_id=model_id, error=str(exc))


async def main() -> None:
    structlog.configure(processors=[structlog.processors.JSONRenderer()])
    start_http_server(METRICS_PORT)
    logger.info("predictive_service_starting",
                score_interval_s=SCORE_INTERVAL_S, metrics_port=METRICS_PORT,
                advisory_enabled=ADVISORY_ENABLED)

    pool = await asyncpg.create_pool(POSTGRES_DSN, min_size=2, max_size=8)
    redis = aioredis.from_url(REDIS_URL, decode_responses=True)

    # Run the command listener alongside the scoring loop.
    listener = asyncio.create_task(handle_commands(pool, redis))

    last_retrain_check = 0.0
    while True:
        try:
            await score_pass(pool)
            if ADVISORY_ENABLED:
                try:
                    n = await evaluate_rules(pool, redis)
                    if n:
                        RECOMMENDATIONS.inc(n)
                except Exception as exc:
                    logger.error("advisory_error", error=str(exc))
            if TEMPLATES_ENABLED:
                try:
                    await template_eval_pass(pool)
                except Exception as exc:
                    logger.error("template_engine_error", error=str(exc))
            now = asyncio.get_event_loop().time()
            if now - last_retrain_check >= RETRAIN_CHECK_S:
                await maybe_retrain(pool)
                last_retrain_check = now
        except Exception as exc:
            logger.error("loop_error", error=str(exc))
        await asyncio.sleep(SCORE_INTERVAL_S)


if __name__ == "__main__":
    asyncio.run(main())
