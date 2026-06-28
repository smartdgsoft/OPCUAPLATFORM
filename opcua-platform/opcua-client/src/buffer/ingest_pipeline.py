"""
Ingest pipeline — Kafka-aware.
KAFKA_ENABLED=true  → OPC UA → Kafka → N consumers → TimescaleDB  (scale path)
KAFKA_ENABLED=false → OPC UA → TimescaleDB directly               (simple path)
"""
from __future__ import annotations
import asyncio, json, os, sqlite3, time
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

import asyncpg
import redis.asyncio as aioredis
import structlog
from prometheus_client import Counter, Gauge, Histogram

from src.config.settings import settings
from src.models.data_models import TagValue

logger = structlog.get_logger(__name__)
KAFKA_ENABLED = os.getenv("KAFKA_ENABLED", "false").lower() == "true"

ROWS_WRITTEN  = Counter("opcua_rows_written_total",    "Rows written to TimescaleDB")
ROWS_BUFFERED = Counter("opcua_rows_buffered_total",   "Rows in local SQLite buffer")
WRITE_ERRORS  = Counter("opcua_write_errors_total",    "DB write errors")
QUEUE_DEPTH   = Gauge("opcua_queue_depth",             "Ingest queue size")
BATCH_LATENCY = Histogram("opcua_batch_write_seconds", "Batch write time")


class LocalBuffer:
    def __init__(self, path: str) -> None:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._path = path
        self._conn: Optional[sqlite3.Connection] = None

    def open(self) -> None:
        self._conn = sqlite3.connect(self._path)
        self._conn.execute("""CREATE TABLE IF NOT EXISTS buffer (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            time TEXT NOT NULL, tag_id TEXT NOT NULL,
            value_num REAL, value_bool INTEGER, value_str TEXT,
            quality INTEGER DEFAULT 192, source_ts TEXT)""")
        self._conn.commit()

    def write(self, rows: List[TagValue]) -> None:
        if not self._conn: return
        self._conn.executemany(
            "INSERT INTO buffer (time,tag_id,value_num,value_bool,value_str,quality,source_ts) VALUES (?,?,?,?,?,?,?)",
            [(r.time.isoformat(), str(r.tag_id), r.value_num,
              int(r.value_bool) if r.value_bool is not None else None,
              r.value_str, r.quality,
              r.source_timestamp.isoformat() if r.source_timestamp else None)
             for r in rows])
        self._conn.commit()
        ROWS_BUFFERED.inc(len(rows))

    def drain(self, limit=5000):
        if not self._conn: return []
        rows = self._conn.execute(
            "SELECT id,time,tag_id,value_num,value_bool,value_str,quality,source_ts FROM buffer ORDER BY id LIMIT ?",
            (limit,)).fetchall()
        return [{"id":r[0],"time":r[1],"tag_id":r[2],"value_num":r[3],
                 "value_bool":r[4],"value_str":r[5],"quality":r[6],"source_ts":r[7]} for r in rows]

    def delete(self, ids):
        if not self._conn or not ids: return
        self._conn.execute(f"DELETE FROM buffer WHERE id IN ({','.join('?'*len(ids))})", ids)
        self._conn.commit()


class IngestPipeline:
    def __init__(self, queue: asyncio.Queue) -> None:
        self._queue = queue
        self._pg_pool: Optional[asyncpg.Pool] = None
        self._redis:   Optional[aioredis.Redis] = None
        self._kafka_prod = None
        self._local_buffer = LocalBuffer(settings.local_buffer_path)
        self._running = False

    async def start(self) -> None:
        self._running = True
        self._local_buffer.open()
        self._redis = aioredis.from_url(settings.redis_url, decode_responses=True)

        if KAFKA_ENABLED:
            from src.kafka.producer import KafkaTagProducer
            self._kafka_prod = KafkaTagProducer()
            await self._kafka_prod.start()
            logger.info("ingest_mode", mode="kafka")
        else:
            dsn = settings.postgres_dsn.replace("postgresql+asyncpg://", "postgresql://")
            self._pg_pool = await asyncpg.create_pool(dsn=dsn, min_size=2, max_size=10, command_timeout=30)
            logger.info("ingest_mode", mode="direct_db")

        tasks = [self._drain_loop()]
        if not KAFKA_ENABLED:
            tasks.append(self._replay_buffer_loop())
        await asyncio.gather(*tasks)

    async def stop(self) -> None:
        self._running = False
        if self._kafka_prod: await self._kafka_prod.stop()
        if self._pg_pool:    await self._pg_pool.close()
        if self._redis:      await self._redis.aclose()

    async def _drain_loop(self) -> None:
        batch: List[TagValue] = []
        while self._running:
            deadline = asyncio.get_event_loop().time() + settings.buffer_flush_interval_s
            while asyncio.get_event_loop().time() < deadline:
                timeout = deadline - asyncio.get_event_loop().time()
                try:
                    item = await asyncio.wait_for(self._queue.get(), timeout=max(0.01, timeout))
                    batch.append(item)
                    if len(batch) >= settings.batch_insert_size: break
                except asyncio.TimeoutError:
                    break
            QUEUE_DEPTH.set(self._queue.qsize())
            if batch:
                await self._write_batch(batch)
                batch = []

    async def _write_batch(self, batch: List[TagValue]) -> None:
        t0 = time.monotonic()
        try:
            pipe = self._redis.pipeline(transaction=False)
            for tv in batch:
                payload = json.dumps(tv.to_redis_payload())
                pipe.setex(f"tag:live:{tv.tag_id}", settings.redis_tag_ttl_s, payload)
                pipe.publish("tag:updates", payload)
            await pipe.execute()
        except Exception as exc:
            logger.warning("redis_publish_failed", error=str(exc))

        if KAFKA_ENABLED and self._kafka_prod:
            try:
                await self._kafka_prod.send_batch(batch)
                ROWS_WRITTEN.inc(len(batch))
            except Exception as exc:
                WRITE_ERRORS.inc()
                logger.error("kafka_send_failed", error=str(exc))
                self._local_buffer.write(batch)
            return

        try:
            async with self._pg_pool.acquire() as conn:
                await conn.copy_records_to_table(
                    "tag_values",
                    records=[(tv.time, str(tv.tag_id), tv.value_num, tv.value_bool,
                              tv.value_str, tv.quality, tv.source_timestamp) for tv in batch],
                    columns=["time","tag_id","value_num","value_bool","value_str","quality","source_timestamp"])
            ROWS_WRITTEN.inc(len(batch))
            BATCH_LATENCY.observe(time.monotonic() - t0)
        except Exception as exc:
            WRITE_ERRORS.inc()
            logger.error("db_write_failed", error=str(exc))
            self._local_buffer.write(batch)

    async def _replay_buffer_loop(self) -> None:
        while self._running:
            await asyncio.sleep(30)
            buffered = self._local_buffer.drain(5000)
            if not buffered or not self._pg_pool: continue
            try:
                async with self._pg_pool.acquire() as conn:
                    await conn.copy_records_to_table(
                        "tag_values",
                        records=[(r["time"],r["tag_id"],r["value_num"],
                                  bool(r["value_bool"]) if r["value_bool"] is not None else None,
                                  r["value_str"],r["quality"],r.get("source_ts")) for r in buffered],
                        columns=["time","tag_id","value_num","value_bool","value_str","quality","source_timestamp"])
                self._local_buffer.delete([r["id"] for r in buffered])
                logger.info("buffer_replayed", count=len(buffered))
            except Exception as exc:
                logger.error("buffer_replay_failed", error=str(exc))
