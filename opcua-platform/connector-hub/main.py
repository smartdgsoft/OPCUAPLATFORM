"""
Connector Hub Service
=====================
Runs all enabled non-OPC-UA sources. For each source it instantiates the right
connector, polls or subscribes, and lands normalized Readings into the SAME
pipeline OPC UA uses: tag_values (history) + Redis tag:live:{tag_id} (live).

To reuse the existing pipeline, each stream is bridged to a tags row (created on
demand). Thus the twin, detectors, and problem templates see connector data
identically to OPC UA data — the connectivity abstraction's whole payoff.

Gated by FEATURE_CONNECTOR_HUB. Deploy-on-demand. Permissive OSS only.
"""
from __future__ import annotations
import asyncio
import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import asyncpg
import redis.asyncio as aioredis
import structlog
from prometheus_client import start_http_server, Counter, Gauge

from connectors import get_connector
from connectors.base import Reading

logger = structlog.get_logger(__name__)

POSTGRES_DSN = os.getenv(
    "POSTGRES_DSN",
    "postgresql://opcua_admin:changeme_strong_pass@timescaledb:5432/opcua",
).replace("postgresql+asyncpg://", "postgresql://")
REDIS_URL = os.getenv("REDIS_URL", "redis://:redis_pass@redis:6379/0")
POLL_TICK_S = float(os.getenv("HUB_POLL_TICK_S", "2"))
REDIS_TTL_S = int(os.getenv("HUB_REDIS_TTL_S", "30"))
METRICS_PORT = int(os.getenv("HUB_METRICS_PORT", "9094"))

READINGS = Counter("hub_readings_total", "Readings ingested", ["source_type"])
SOURCE_ERRORS = Counter("hub_source_errors_total", "Source errors", ["source_type"])
ACTIVE_SOURCES = Gauge("hub_active_sources", "Connected sources")


class SourceRunner:
    """Holds a live connector + its stream->tag bridge, and its poll schedule."""
    def __init__(self, row: Dict[str, Any]):
        self.id = row["id"]
        self.name = row["name"]
        self.source_type = row["source_type"]
        self.mode = row["mode"]
        self.config = row["config"] if isinstance(row["config"], dict) else json.loads(row["config"])
        self.poll_interval_ms = row["poll_interval_ms"] or 5000
        self.connector = get_connector(self.source_type, self.id, self.config)
        self.connected = False
        self.last_poll = 0.0
        self.tag_cache: Dict[str, str] = {}  # stream_key -> tag_id


async def ensure_tag_for_stream(pool: asyncpg.Pool, source_id: str, source_name: str,
                                reading: Reading, source_type: str) -> Optional[str]:
    """Find or create the streams row + bridging tags row for a stream_key.
    Returns the tag_id used to land values into the existing pipeline."""
    # 1. existing stream?
    row = await pool.fetchrow(
        "SELECT id::text, tag_id::text FROM streams WHERE source_id=$1::uuid AND stream_key=$2",
        source_id, reading.stream_key)
    if row and row["tag_id"]:
        return row["tag_id"]

    # 2. create the bridging tags row (node_id namespaced to avoid clashes with OPC)
    node_id = f"src:{source_id[:8]}:{reading.stream_key}"
    display = f"{source_name} · {reading.stream_key}"
    tag_id = await pool.fetchval(
        """INSERT INTO tags (node_id, display_name, data_type, is_active, tags_meta)
           VALUES ($1,$2,'Double',TRUE,$3)
           ON CONFLICT (node_id) DO UPDATE SET display_name=EXCLUDED.display_name
           RETURNING id::text""",
        node_id, display, json.dumps({"source_id": source_id, "source_type": source_type,
                                      "stream_key": reading.stream_key}))

    # 3. create/link the streams row
    if row:
        await pool.execute("UPDATE streams SET tag_id=$2::uuid WHERE id=$1::uuid",
                           row["id"], tag_id)
    else:
        await pool.execute(
            """INSERT INTO streams (source_id, stream_key, display_name, tag_id)
               VALUES ($1::uuid,$2,$3,$4::uuid)
               ON CONFLICT (source_id, stream_key) DO UPDATE SET tag_id=EXCLUDED.tag_id""",
            source_id, reading.stream_key, display, tag_id)
    return tag_id


async def land_reading(pool: asyncpg.Pool, redis: aioredis.Redis, runner: SourceRunner,
                       reading: Reading) -> None:
    tag_id = runner.tag_cache.get(reading.stream_key)
    if not tag_id:
        tag_id = await ensure_tag_for_stream(pool, runner.id, runner.name, reading, runner.source_type)
        if not tag_id:
            return
        runner.tag_cache[reading.stream_key] = tag_id

    num = reading.numeric()
    # history (same hypertable as OPC UA)
    await pool.execute(
        """INSERT INTO tag_values (time, tag_id, value_num, value_str, quality)
           VALUES ($1,$2::uuid,$3,$4,$5)""",
        reading.ts, tag_id, num,
        None if num is not None else str(reading.value), reading.quality)
    # live cache (same key format the twin/detectors read)
    await redis.set(f"tag:live:{tag_id}",
                    json.dumps({"value": num if num is not None else reading.value,
                                "quality": reading.quality, "ts": reading.ts.isoformat()}),
                    ex=REDIS_TTL_S)
    READINGS.labels(source_type=runner.source_type).inc()


async def run_source(pool: asyncpg.Pool, redis: aioredis.Redis, runner: SourceRunner) -> None:
    """Connect once, then poll on the source's interval (subscribe mode TODO per connector)."""
    if not runner.connected:
        try:
            await runner.connector.connect()
            runner.connected = True
            await pool.execute(
                "UPDATE sources SET last_status='connected', last_error=NULL, last_seen=NOW() WHERE id=$1::uuid",
                runner.id)
            logger.info("source_connected", source=runner.name, type=runner.source_type)
        except Exception as exc:
            SOURCE_ERRORS.labels(source_type=runner.source_type).inc()
            await pool.execute(
                "UPDATE sources SET last_status='error', last_error=$2 WHERE id=$1::uuid",
                runner.id, str(exc))
            logger.error("source_connect_failed", source=runner.name, error=str(exc))
            return

    # poll mode
    if runner.mode in ("poll", "batch"):
        now = asyncio.get_event_loop().time()
        if (now - runner.last_poll) * 1000 < runner.poll_interval_ms:
            return
        runner.last_poll = now
        try:
            # which streams to fetch (configured value columns, or all)
            stream_keys = list(runner.tag_cache.keys())
            readings = await runner.connector.poll(stream_keys)
            for r in readings:
                await land_reading(pool, redis, runner, r)
            if readings:
                await pool.execute("UPDATE sources SET last_seen=NOW() WHERE id=$1::uuid", runner.id)
        except Exception as exc:
            SOURCE_ERRORS.labels(source_type=runner.source_type).inc()
            await pool.execute(
                "UPDATE sources SET last_status='error', last_error=$2 WHERE id=$1::uuid",
                runner.id, str(exc))
            logger.error("source_poll_failed", source=runner.name, error=str(exc))


async def main() -> None:
    structlog.configure(processors=[structlog.processors.JSONRenderer()])
    start_http_server(METRICS_PORT)
    logger.info("connector_hub_starting", metrics_port=METRICS_PORT)

    pool = await asyncpg.create_pool(POSTGRES_DSN, min_size=2, max_size=8)
    redis = aioredis.from_url(REDIS_URL, decode_responses=True)

    runners: Dict[str, SourceRunner] = {}
    while True:
        try:
            rows = await pool.fetch(
                """SELECT id::text, name, source_type, mode, config, poll_interval_ms
                   FROM sources WHERE enabled = TRUE""")
            current_ids = set()
            for row in rows:
                current_ids.add(row["id"])
                if row["id"] not in runners:
                    try:
                        runners[row["id"]] = SourceRunner(dict(row))
                    except Exception as exc:
                        logger.error("source_init_failed", source=row["name"], error=str(exc))
                        continue
                await run_source(pool, redis, runners[row["id"]])

            # drop runners for disabled/removed sources
            for sid in list(runners.keys()):
                if sid not in current_ids:
                    try:
                        await runners[sid].connector.disconnect()
                    except Exception:
                        pass
                    del runners[sid]

            ACTIVE_SOURCES.set(sum(1 for r in runners.values() if r.connected))
        except Exception as exc:
            logger.error("hub_loop_error", error=str(exc))
        await asyncio.sleep(POLL_TICK_S)


if __name__ == "__main__":
    asyncio.run(main())
