"""
Kafka producer for high-throughput OPC UA data ingestion.
Replaces the direct asyncpg COPY when KAFKA_ENABLED=true.

Architecture at scale:
  OPC UA Client → Kafka (3 brokers, RF=3) → N consumers → TimescaleDB
                                          ↘ Redis (live cache, pub/sub)

Benefits:
 - Decouples collection from persistence (client never blocks on DB)
 - Consumers scale independently (add workers to increase DB write throughput)
 - Kafka retains 7 days of raw events (replayable)
 - Consumer group auto-rebalances across partitions
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from typing import List, Optional

import structlog
from aiokafka import AIOKafkaProducer
from aiokafka.errors import KafkaConnectionError, KafkaError
from prometheus_client import Counter, Histogram

from src.models.data_models import TagValue

logger = structlog.get_logger(__name__)

KAFKA_MSGS_SENT    = Counter("opcua_kafka_messages_sent_total", "Messages sent to Kafka")
KAFKA_SEND_ERRORS  = Counter("opcua_kafka_send_errors_total",   "Kafka send errors")
KAFKA_SEND_LATENCY = Histogram("opcua_kafka_send_latency_seconds", "Kafka produce latency")

KAFKA_BOOTSTRAP    = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "kafka-1:9092,kafka-2:9092,kafka-3:9092")
KAFKA_TOPIC        = os.getenv("KAFKA_TOPIC", "opcua.tag.values")
INSTANCE_ID        = os.getenv("CLIENT_INSTANCE_ID", "client-1")


class KafkaTagProducer:
    """
    Async Kafka producer for tag values.
    Uses lz4 compression and idempotent delivery (exactly-once semantics).
    Partitions by tag_id so values for the same tag always go to the same partition
    → preserves ordering per tag for consumers.
    """

    def __init__(self) -> None:
        self._producer: Optional[AIOKafkaProducer] = None
        self._running = False

    async def start(self) -> None:
        self._producer = AIOKafkaProducer(
            bootstrap_servers=KAFKA_BOOTSTRAP,
            value_serializer=lambda v: json.dumps(v).encode("utf-8"),
            key_serializer=lambda k: k.encode("utf-8") if k else None,
            compression_type="lz4",
            acks="all",                  # wait for all ISR replicas
            enable_idempotence=True,     # exactly-once delivery
            max_batch_size=131072,       # 128 KB batch
            linger_ms=5,                 # 5ms batching window
            request_timeout_ms=30000,
            retry_backoff_ms=100,
            max_block_ms=60000,
        )
        await self._producer.start()
        self._running = True
        logger.info("kafka_producer_started", brokers=KAFKA_BOOTSTRAP, topic=KAFKA_TOPIC)

    async def stop(self) -> None:
        self._running = False
        if self._producer:
            await self._producer.stop()

    async def send_batch(self, batch: List[TagValue]) -> None:
        """Send a batch of TagValues. Each message is keyed by tag_id for partition affinity."""
        if not self._producer or not self._running:
            raise RuntimeError("Producer not started")

        t0 = time.monotonic()
        errors = 0

        # aiokafka sends are async — fire all, then flush
        futures = []
        for tv in batch:
            payload = {
                "tag_id":          str(tv.tag_id),
                "node_id":         tv.node_id,
                "time":            tv.time.isoformat(),
                "value_num":       tv.value_num,
                "value_bool":      tv.value_bool,
                "value_str":       tv.value_str,
                "quality":         tv.quality,
                "source_timestamp": tv.source_timestamp.isoformat() if tv.source_timestamp else None,
                "producer":        INSTANCE_ID,
            }
            try:
                fut = await self._producer.send(
                    KAFKA_TOPIC,
                    key=str(tv.tag_id),
                    value=payload,
                )
                futures.append(fut)
            except KafkaError as exc:
                KAFKA_SEND_ERRORS.inc()
                errors += 1
                logger.error("kafka_send_error", error=str(exc), tag_id=str(tv.tag_id))

        # Await all sends to confirm delivery to brokers
        for fut in futures:
            try:
                await fut
                KAFKA_MSGS_SENT.inc()
            except Exception as exc:
                KAFKA_SEND_ERRORS.inc()
                errors += 1
                logger.error("kafka_delivery_error", error=str(exc))

        elapsed = time.monotonic() - t0
        KAFKA_SEND_LATENCY.observe(elapsed)

        if errors:
            logger.warning("kafka_batch_partial_failure", total=len(batch), errors=errors)
        else:
            logger.debug("kafka_batch_sent", count=len(batch), elapsed_ms=round(elapsed * 1000))
