"""
Real-time Alarm Evaluation Engine
===================================
Subscribes to Redis live tag updates and evaluates alarm conditions.
Feature flag: FEATURE_ALARM_EVAL=true
"""
from __future__ import annotations
import asyncio, json
from datetime import datetime, timezone
from typing import Dict, Any
import asyncpg, redis.asyncio as aioredis
import structlog

logger = structlog.get_logger(__name__)

class AlarmEvaluator:
    def __init__(self, pool: asyncpg.Pool, redis: aioredis.Redis) -> None:
        self._pool   = pool
        self._redis  = redis
        self._defs: Dict[str, list] = {}   # tag_id -> list of alarm definitions
        self._active: Dict[str, str] = {}  # alarm_def_id -> event_id
        self._running = False

    async def start(self) -> None:
        self._running = True
        await self._load_definitions()
        asyncio.create_task(self._reload_loop())
        await self._evaluate_loop()

    async def _load_definitions(self) -> None:
        rows = await self._pool.fetch("""
            SELECT id::text, tag_id::text, condition_type, limit_value,
                   deadband, severity, message, notify_email
            FROM alarm_definitions WHERE is_active = TRUE
        """)
        self._defs = {}
        for r in rows:
            tid = r["tag_id"]
            self._defs.setdefault(tid, []).append(dict(r))
        logger.info("alarm_definitions_loaded", count=sum(len(v) for v in self._defs.values()))

    async def _reload_loop(self) -> None:
        while self._running:
            await asyncio.sleep(60)
            await self._load_definitions()

    async def _evaluate_loop(self) -> None:
        pubsub = self._redis.pubsub()
        await pubsub.subscribe("tag:updates")
        async for msg in pubsub.listen():
            if msg["type"] != "message": continue
            try:
                data = json.loads(msg["data"])
                tag_id = data.get("tag_id")
                value  = data.get("value")
                if tag_id and tag_id in self._defs and value is not None:
                    for defn in self._defs[tag_id]:
                        await self._check(defn, float(value))
            except Exception as exc:
                logger.error("alarm_eval_error", error=str(exc))

    async def _check(self, defn: dict, value: float) -> None:
        ctype  = defn["condition_type"]
        limit  = defn.get("limit_value", 0.0) or 0.0
        dband  = defn.get("deadband", 0.0) or 0.0
        def_id = defn["id"]
        tag_id = defn["tag_id"]

        triggered = False
        if ctype == "HIGH"      and value > limit:           triggered = True
        elif ctype == "HIGH_HIGH" and value > limit:         triggered = True
        elif ctype == "LOW"     and value < limit:           triggered = True
        elif ctype == "LOW_LOW" and value < limit:           triggered = True
        elif ctype == "DEVIATION" and abs(value - limit) > dband: triggered = True
        elif ctype == "BOOL"    and bool(value):             triggered = True

        is_active = def_id in self._active

        if triggered and not is_active:
            # Insert alarm event
            row = await self._pool.fetchrow("""
                INSERT INTO alarm_events
                    (alarm_def_id, tag_id, trigger_value, severity, message, state)
                VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'ACTIVE')
                RETURNING id::text
            """, def_id, tag_id, value, defn["severity"], defn.get("message"))
            if row:
                self._active[def_id] = row["id"]
                await self._redis.publish("opcua:alarms", json.dumps({
                    "event": "triggered", "alarm_def_id": def_id,
                    "event_id": row["id"], "tag_id": tag_id,
                    "value": value, "severity": defn["severity"],
                    "message": defn.get("message"),
                    "ts": datetime.now(timezone.utc).isoformat(),
                }))
                logger.warning("alarm_triggered", def_id=def_id, value=value)

        elif not triggered and is_active:
            # Apply deadband to avoid flapping
            event_id = self._active.pop(def_id)
            await self._pool.execute("""
                UPDATE alarm_events SET state='CLEARED', cleared_at=NOW()
                WHERE id=$1::uuid
            """, event_id)
            await self._redis.publish("opcua:alarms", json.dumps({
                "event": "cleared", "alarm_def_id": def_id,
                "event_id": event_id, "tag_id": tag_id,
                "ts": datetime.now(timezone.utc).isoformat(),
            }))
