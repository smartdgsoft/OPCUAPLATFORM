"""
Task Scheduler — Feature flag: FEATURE_SCHEDULER=true
Handles: periodic reads, scheduled writes, setpoint ramps, cron jobs.
"""
from __future__ import annotations
import asyncio, json
from datetime import datetime, timezone
import asyncpg, redis.asyncio as aioredis
import structlog

logger = structlog.get_logger(__name__)

class TaskScheduler:
    def __init__(self, registry, write_engine, pool: asyncpg.Pool, redis: aioredis.Redis):
        self._registry     = registry
        self._write_engine = write_engine
        self._pool         = pool
        self._redis        = redis
        self._running      = False

    async def start(self) -> None:
        self._running = True
        logger.info("scheduler_started")
        await asyncio.gather(
            self._run_periodic_reads(),
            self._command_listener(),
        )

    async def _run_periodic_reads(self) -> None:
        """Poll non-subscribed nodes on a schedule (e.g. slow-changing diagnostics)."""
        while self._running:
            try:
                rows = await self._pool.fetch("""
                    SELECT t.id::text AS tag_id, t.node_id, t.server_id::text,
                           t.sample_interval_ms
                    FROM tags t
                    WHERE t.is_active = TRUE AND t.use_polling = TRUE
                """)
                for r in rows:
                    val = await self._registry.read_node(r["server_id"], r["node_id"])
                    if val.get("success"):
                        await self._redis.setex(
                            f"tag:live:{r['tag_id']}", 300,
                            json.dumps({"tag_id": r["tag_id"],
                                        "node_id": r["node_id"],
                                        "value": val.get("value"),
                                        "quality": val.get("quality", 192),
                                        "ts": datetime.now(timezone.utc).isoformat()}))
            except Exception as exc:
                logger.error("periodic_read_error", error=str(exc))
            await asyncio.sleep(5)

    async def _command_listener(self) -> None:
        """Accept ramp / scheduled write commands from API."""
        pubsub = self._redis.pubsub()
        await pubsub.subscribe("opcua:scheduler:commands")
        async for msg in pubsub.listen():
            if msg["type"] != "message": continue
            try:
                cmd = json.loads(msg["data"])
                if cmd.get("cmd") == "ramp" and self._write_engine:
                    asyncio.create_task(self._write_engine.ramp_setpoint(
                        server_id=cmd["server_id"],
                        node_id=cmd["node_id"],
                        target_value=float(cmd["target_value"]),
                        duration_seconds=float(cmd["duration_seconds"]),
                        steps=int(cmd.get("steps", 10)),
                        data_type=cmd.get("data_type", "Double"),
                        requested_by=cmd.get("requested_by", "scheduler"),
                    ))
                    logger.info("ramp_scheduled", **{k:cmd[k] for k in ["node_id","target_value","duration_seconds"]})
            except Exception as exc:
                logger.error("scheduler_command_error", error=str(exc))
