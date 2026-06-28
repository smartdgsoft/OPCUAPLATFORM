"""
Enterprise OPC UA Client
- Async subscription to monitored items
- Automatic reconnection with exponential backoff
- Dead-band filtering
- Batch buffering to TimescaleDB
- Redis pub/sub for live updates
- Prometheus metrics
"""
from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

import structlog
from asyncua import Client, Node, ua
from prometheus_client import Counter, Gauge, Histogram
from tenacity import (
    AsyncRetrying,
    retry_if_exception_type,
    stop_never,
    wait_exponential,
)

from src.config.settings import settings
from src.models.data_models import TagValue

logger = structlog.get_logger(__name__)

# ── Prometheus metrics ───────────────────────────────────────────────
VALUES_RECEIVED   = Counter("opcua_values_received_total", "Tag values received", ["node_id"])
VALUES_FILTERED   = Counter("opcua_values_filtered_total", "Values dropped by deadband")
CONNECTION_STATUS = Gauge("opcua_connection_status", "1=connected 0=disconnected")
RECONNECT_COUNT   = Counter("opcua_reconnect_total", "Number of reconnection attempts")
WRITE_LATENCY     = Histogram("opcua_client_ingest_latency_seconds", "Time from OPC UA timestamp to DB write")


class OPCUASubHandler:
    """
    Subscription data change handler.
    Applies dead-band filtering and pushes values to the ingest queue.
    asyncua uses duck-typing — any object with datachange_notification works.

    NOTE: We resolve tags by NODE ID, not by ClientHandle, because the handle
    returned by subscribe_data_change does not reliably match the ClientHandle
    that arrives in notifications across asyncua versions.
    """

    def __init__(
        self,
        queue: asyncio.Queue,
        tag_map: Dict[str, Dict],         # node_id (str) -> tag metadata
        deadband_map: Dict[str, float],   # node_id (str) -> deadband value
    ) -> None:
        self._queue = queue
        self._tag_map = tag_map
        self._deadband_map = deadband_map
        self._last_values: Dict[str, float] = {}

    def datachange_notification(
        self, node: Node, val: Any, data: Any
    ) -> None:
        try:
            # Resolve the tag by node id — reliable across asyncua versions.
            node_id_str = node.nodeid.to_string()
            tag_meta = self._tag_map.get(node_id_str)
            if tag_meta is None:
                return

            raw_value = val
            node_id = tag_meta["node_id"]
            try:
                VALUES_RECEIVED.labels(node_id=node_id).inc()
            except Exception:
                pass

            # ── Dead-band filter ─────────────────────────────────────────
            deadband = self._deadband_map.get(node_id_str, 0.0)
            if deadband and isinstance(raw_value, (int, float)) and not isinstance(raw_value, bool):
                last = self._last_values.get(node_id_str)
                if last is not None and abs(raw_value - last) < deadband:
                    VALUES_FILTERED.inc()
                    return
                self._last_values[node_id_str] = float(raw_value)

            # ── Quality + source timestamp (best-effort) ─────────────────
            quality = 192  # Good
            source_ts = None
            try:
                mi = getattr(data, "monitored_item", None)
                if mi is not None and getattr(mi, "Value", None) is not None:
                    mv = mi.Value
                    sc = getattr(mv, "StatusCode", None)
                    if sc is not None and hasattr(sc, "value"):
                        quality = sc.value & 0xFFFF
                    st = getattr(mv, "SourceTimestamp", None)
                    if st:
                        source_ts = st
            except Exception:
                pass

            tv = TagValue(
                time=datetime.now(tz=timezone.utc),
                tag_id=tag_meta["tag_id"],
                node_id=node_id,
                raw_value=raw_value,
                quality=quality,
                source_timestamp=source_ts,
            )

            try:
                self._queue.put_nowait(tv)
            except asyncio.QueueFull:
                logger.warning("ingest_queue_full", node_id=node_id)
        except Exception as exc:
            logger.error("datachange_handler_error", error=str(exc))

    def event_notification(self, event: ua.EventNotificationList) -> None:
        logger.debug("opc_event", event=event)


class OPCUAClientManager:
    """
    Manages the lifecycle of the OPC UA client connection,
    subscriptions, and reconnection strategy.
    """

    def __init__(
        self,
        ingest_queue: asyncio.Queue,
        on_connected: Optional[Callable] = None,
        on_disconnected: Optional[Callable] = None,
    ) -> None:
        self._queue = ingest_queue
        self._on_connected = on_connected
        self._on_disconnected = on_disconnected
        self._client: Optional[Client] = None
        self._subscription = None
        self._tag_map: Dict[int, Dict] = {}
        self._deadband_map: Dict[int, float] = {}
        self._tags: List[Dict] = []
        self._running = False

    def set_tags(self, tags: List[Dict]) -> None:
        """Set tag list from DB before starting."""
        self._tags = tags

    async def start(self) -> None:
        self._running = True
        await self._connection_loop()

    async def stop(self) -> None:
        self._running = False
        await self._disconnect()

    async def _connection_loop(self) -> None:
        """Reconnect loop with exponential backoff via tenacity."""
        while self._running:
            try:
                async for attempt in AsyncRetrying(
                    stop=stop_never,
                    wait=wait_exponential(multiplier=1, min=2, max=60),
                    retry=retry_if_exception_type(Exception),
                    reraise=False,
                ):
                    with attempt:
                        RECONNECT_COUNT.inc()
                        await self._connect_and_run()
            except Exception as exc:
                logger.error("connection_loop_error", error=str(exc))
                await asyncio.sleep(settings.reconnect_delay_s)
            finally:
                CONNECTION_STATUS.set(0)
                if self._on_disconnected:
                    asyncio.create_task(self._on_disconnected())

    async def _connect_and_run(self) -> None:
        logger.info("connecting", url=settings.opc_server_url)
        client = Client(url=settings.opc_server_url)

        # ── Security ──────────────────────────────────────────────────
        if settings.opc_security_mode != "None":
            await client.set_security_string(
                f"{settings.opc_security_policy},{settings.opc_security_mode},"
                f"{settings.opc_certificate_path},{settings.opc_private_key_path}"
            )

        if settings.opc_username:
            client.set_user(settings.opc_username)
            client.set_password(settings.opc_password or "")

        async with client:
            self._client = client
            logger.info("connected", url=settings.opc_server_url)
            CONNECTION_STATUS.set(1)

            if self._on_connected:
                asyncio.create_task(self._on_connected())

            await self._setup_subscription()

            # Keep alive — wait until disconnect
            while self._running:
                await asyncio.sleep(5)
                # Ping server
                try:
                    await client.get_namespace_array()
                except Exception:
                    logger.warning("server_ping_failed_reconnecting")
                    raise

    async def _setup_subscription(self) -> None:
        if not self._client:
            return

        handler = OPCUASubHandler(
            queue=self._queue,
            tag_map=self._tag_map,
            deadband_map=self._deadband_map,
        )

        self._subscription = await self._client.create_subscription(
            period=settings.publish_interval_ms,
            handler=handler,
        )

        nodes_to_monitor = []
        for tag in self._tags:
            node = self._client.get_node(tag["node_id"])
            nodes_to_monitor.append(
                (
                    node,
                    tag,
                    ua.MonitoringParameters(
                        sampling_interval=float(tag.get("sample_interval_ms", 1000)),
                        queue_size=10,
                        discard_oldest=True,
                        filter=ua.DataChangeFilter(
                            trigger=ua.DataChangeTrigger.StatusValue,
                            deadband_type=ua.DeadbandType.Absolute
                            if tag.get("deadband_value", 0) > 0
                            else ua.DeadbandType.None_,
                            deadband_value=tag.get("deadband_value", 0.0),
                        ),
                    ),
                )
            )

        for node, tag, params in nodes_to_monitor:
            try:
                handle = await self._subscription.subscribe_data_change(
                    node, monitoring_parameters=params
                )
                self._tag_map[handle] = tag
                self._deadband_map[handle] = tag.get("deadband_value", 0.0)
                logger.debug("subscribed", node_id=tag["node_id"], handle=handle)
            except Exception as exc:
                logger.error(
                    "subscribe_failed", node_id=tag["node_id"], error=str(exc)
                )

        logger.info("subscription_ready", tag_count=len(self._tag_map))

    async def _disconnect(self) -> None:
        if self._subscription:
            try:
                await self._subscription.delete()
            except Exception:
                pass
        self._subscription = None
        self._client = None
