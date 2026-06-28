"""
Kafka Consumer — TimescaleDB batch writer
=========================================
Run as many instances as needed (add kafka-consumer-N to docker-compose.scale.yml).
Each instance is a member of the same consumer group → Kafka auto-assigns partitions.
12 partitions → up to 12 parallel consumers writing to DB.

Throughput target: ~100k rows/sec per consumer instance on modern hardware.
"""
from __future__ import annotations

import asyncio
import json
import os
import signal
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from uuid import UUID

import asyncpg
import redis.asyncio as aioredis
import structlog
from aiokafka import AIOKafkaConsumer
from prometheus_client import Counter, Gauge, Histogram, start_http_server

logger = structlog.get_logger(__name__)

# ── Config ─────────────────────────────────────────────────────────────────
KAFKA_BOOTSTRAP  = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "kafka-1:9092,kafka-2:9092,kafka-3:9092")
KAFKA_TOPIC      = os.getenv("KAFKA_TOPIC",              "opcua.tag.values")
KAFKA_GROUP_ID   = os.getenv("KAFKA_GROUP_ID",           "opcua-db-writers")
CONSUMER_ID      = os.getenv("KAFKA_CONSUMER_INSTANCE",  "consumer-1")
POSTGRES_DSN     = os.getenv("POSTGRES_DSN",             "postgresql://opcua_admin:changeme@pgbouncer:5432/opcua")
REDIS_URL        = os.getenv("REDIS_URL",                "redis://:redis_pass@redis-master:6379/0")
BATCH_SIZE       = int(os.getenv("BATCH_INSERT_SIZE",    "2000"))
BATCH_TIMEOUT_MS = int(os.getenv("BATCH_TIMEOUT_MS",     "500"))
METRICS_PORT     = int(os.getenv("METRICS_PORT",         "9091"))

# ── Prometheus ─────────────────────────────────────────────────────────────
ROWS_WRITTEN    = Counter("consumer_rows_written_total",   "Rows written to TimescaleDB", ["consumer"])
BATCH_LATENCY   = Histogram("consumer_batch_latency_sec", "Batch write time", ["consumer"])
LAG_GAUGE       = Gauge("consumer_kafka_lag",              "Estimated Kafka consumer lag",   ["consumer"])
MSGS_CONSUMED   = Counter("consumer_messages_consumed",    "Kafka messages consumed",        ["consumer"])
WRITE_ERRORS    = Counter("consumer_write_errors_total",   "DB write errors",                ["consumer"])


class KafkaConsumerWorker:
    def __init__(self) -> None:
        self._consumer: Optional[AIOKafkaConsumer] = None
        self._pg_pool:  Optional[asyncpg.Pool]     = None
        self._redis:    Optional[aioredis.Redis]   = None
        self._running = False
        self._buffer: List[Dict[str, Any]]         = []

    async def start(self) -> None:
        # DB pool
        dsn = POSTGRES_DSN.replace("postgresql+asyncpg://", "postgresql://")
        self._pg_pool = await asyncpg.create_pool(
            dsn=dsn, min_size=3, max_size=10, command_timeout=60,
        )
        # Redis
        self._redis = aioredis.from_url(REDIS_URL, decode_responses=True)

        # Kafka consumer
        self._consumer = AIOKafkaConsumer(
            KAFKA_TOPIC,
            bootstrap_servers=KAFKA_BOOTSTRAP,
            group_id=KAFKA_GROUP_ID,
            client_id=f"{KAFKA_GROUP_ID}-{CONSUMER_ID}",
            auto_offset_reset="earliest",
            enable_auto_commit=False,       # manual commit after DB write
            max_poll_records=BATCH_SIZE,
            fetch_max_bytes=52428800,       # 50 MB
            max_partition_fetch_bytes=10485760,  # 10 MB per partition
            session_timeout_ms=30000,
            heartbeat_interval_ms=10000,
            value_deserializer=lambda v: json.loads(v.decode("utf-8")),
        )
        await self._consumer.start()
        self._running = True
        logger.info("consumer_started", consumer_id=CONSUMER_ID, topic=KAFKA_TOPIC, group=KAFKA_GROUP_ID)

        await self._consume_loop()

    async def stop(self) -> None:
        self._running = False
        if self._consumer:
            await self._consumer.stop()
        if self._pg_pool:
            await self._pg_pool.close()
        if self._redis:
            await self._redis.aclose()

    async def _consume_loop(self) -> None:
        batch: List[Dict] = []
        deadline = asyncio.get_event_loop().time() + (BATCH_TIMEOUT_MS / 1000)

        while self._running:
            try:
                # Poll with short timeout to allow batching
                result = await asyncio.wait_for(
                    self._consumer.getmany(max_records=BATCH_SIZE, timeout_ms=100),
                    timeout=1.0,
                )
                for tp, messages in result.items():
                    for msg in messages:
                        batch.append(msg.value)
                        MSGS_CONSUMED.labels(consumer=CONSUMER_ID).inc()

            except asyncio.TimeoutError:
                pass
            except Exception as exc:
                logger.error("consume_error", error=str(exc))
                await asyncio.sleep(1)
                continue

            now = asyncio.get_event_loop().time()
            flush = len(batch) >= BATCH_SIZE or (batch and now >= deadline)

            if flush:
                await self._write_batch(batch)
                await self._consumer.commit()
                batch = []
                deadline = asyncio.get_event_loop().time() + (BATCH_TIMEOUT_MS / 1000)

    async def _write_batch(self, batch: List[Dict]) -> None:
        if not batch:
            return

        t0 = time.monotonic()

        # ── Redis live cache update ─────────────────────────────────
        try:
            pipe = self._redis.pipeline(transaction=False)
            for msg in batch:
                live_payload = json.dumps({
                    "tag_id":   msg["tag_id"],
                    "node_id":  msg.get("node_id", ""),
                    "value":    msg.get("value_num"),
                    "quality":  msg.get("quality", 192),
                    "ts":       msg["time"],
                })
                pipe.setex(f"tag:live:{msg['tag_id']}", 300, live_payload)
                pipe.publish("tag:updates", live_payload)
            await pipe.execute()
        except Exception as exc:
            logger.warning("redis_update_failed", error=str(exc))

        # ── TimescaleDB batch insert via COPY ──────────────────────
        try:
            async with self._pg_pool.acquire() as conn:
                records = []
                for msg in batch:
                    try:
                        records.append((
                            datetime.fromisoformat(msg["time"]),
                            msg["tag_id"],
                            msg.get("value_num"),
                            msg.get("value_bool"),
                            msg.get("value_str"),
                            int(msg.get("quality", 192)),
                            datetime.fromisoformat(msg["source_timestamp"])
                                if msg.get("source_timestamp") else None,
                        ))
                    except Exception:
                        continue

                await conn.copy_records_to_table(
                    "tag_values",
                    records=records,
                    columns=["time", "tag_id", "value_num", "value_bool",
                             "value_str", "quality", "source_timestamp"],
                )

            ROWS_WRITTEN.labels(consumer=CONSUMER_ID).inc(len(records))
            elapsed = time.monotonic() - t0
            BATCH_LATENCY.labels(consumer=CONSUMER_ID).observe(elapsed)
            logger.debug("batch_written",
                         consumer=CONSUMER_ID,
                         count=len(records),
                         elapsed_ms=round(elapsed * 1000))

        except Exception as exc:
            WRITE_ERRORS.labels(consumer=CONSUMER_ID).inc()
            logger.error("db_write_error", consumer=CONSUMER_ID, error=str(exc), count=len(batch))
            await asyncio.sleep(2)   # back-pressure on error


async def main() -> None:
    import logging
    logging.basicConfig(level=logging.INFO)

    start_http_server(METRICS_PORT)
    logger.info("metrics_server_started", port=METRICS_PORT)

    worker = KafkaConsumerWorker()

    stop_event = asyncio.Event()
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop_event.set)

    task = asyncio.create_task(worker.start())
    await stop_event.wait()
    await worker.stop()
    task.cancel()


if __name__ == "__main__":
    asyncio.run(main())
