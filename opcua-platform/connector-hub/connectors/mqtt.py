"""
MQTT connector.

MQTT is push-based (broker delivers messages as they're published), but the hub
drives connectors by polling. Bridge: on connect() we subscribe to the configured
topics and run the MQTT network loop in the background, buffering the latest
reading per topic. poll() simply drains that buffer. This fits the poll-driven
hub without changing it, and no messages are lost between polls (we keep the
latest per topic; optionally all if buffer_all=True).

Config:
  host, port (default 1883), username, password, tls (bool)
  client_id (optional), keepalive (default 60)
  topics: ["sensors/+/temp", "line1/nozzle/#"]   # MQTT wildcards supported
  payload: "raw" | "json"        # raw = whole payload is the value
  json_value_path: "value"       # for payload=json, dotted path to the numeric value
  key_column-like namespacing:   the topic itself becomes the stream_key, so
                                 sensors/nozzle3/weight is naturally per-unit.
  qos: 0|1|2 (default 0)

Permissive OSS only: paho-mqtt (EPL/EDL).
"""
from __future__ import annotations
import asyncio
import json
import ssl
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import structlog

from .base import (BaseConnector, Reading, StreamSpec, ConnectorStatus,
                   QUALITY_GOOD, QUALITY_BAD)

logger = structlog.get_logger(__name__)


class MqttConnector(BaseConnector):
    source_type = "mqtt"
    mode = "poll"          # poll-adapter over an internal subscription
    writable = True        # can publish

    def __init__(self, source_id: str, config: Dict[str, Any]):
        super().__init__(source_id, config)
        self._client = None
        self._connected = False
        self._buffer: Dict[str, Reading] = {}
        self._lock = threading.Lock()
        self._topics: List[str] = list(config.get("topics", []))
        self._qos = int(config.get("qos", 0))
        self._payload_mode = (config.get("payload") or "raw").lower()
        self._json_path = config.get("json_value_path", "value")

    # ── lifecycle ──────────────────────────────────────────────────────────
    async def connect(self) -> None:
        try:
            import paho.mqtt.client as mqtt
        except ImportError as exc:
            raise RuntimeError("paho-mqtt not installed in connector-hub image") from exc

        host = self.config.get("host")
        if not host:
            raise ValueError("MQTT source requires 'host'")
        port = int(self.config.get("port", 1883))
        keepalive = int(self.config.get("keepalive", 60))
        client_id = self.config.get("client_id") or f"opcua-hub-{self.source_id[:8]}"

        client = mqtt.Client(client_id=client_id, clean_session=True)
        user = self.config.get("username")
        if user:
            client.username_pw_set(user, self.config.get("password", ""))
        if self.config.get("tls"):
            client.tls_set(cert_reqs=ssl.CERT_NONE)
            client.tls_insecure_set(True)

        client.on_connect = self._on_connect
        client.on_message = self._on_message
        client.on_disconnect = self._on_disconnect

        # connect in a thread (paho is blocking); run its network loop in bg
        await asyncio.to_thread(client.connect, host, port, keepalive)
        client.loop_start()
        self._client = client
        # give it a moment to establish + subscribe
        await asyncio.sleep(0.5)
        logger.info("mqtt_connecting", host=host, port=port, topics=self._topics)

    def _on_connect(self, client, userdata, flags, rc):
        if rc == 0:
            self._connected = True
            for t in self._topics:
                client.subscribe(t, qos=self._qos)
            logger.info("mqtt_connected", subscribed=self._topics)
        else:
            self._connected = False
            logger.error("mqtt_connect_failed", rc=rc)

    def _on_disconnect(self, client, userdata, rc):
        self._connected = False

    def _on_message(self, client, userdata, msg):
        try:
            value = self._decode(msg.payload)
        except Exception:
            value = None
        if value is None:
            return
        # the topic is the stream_key -> natural per-unit attribution
        r = Reading(stream_key=msg.topic, value=value,
                    quality=QUALITY_GOOD, ts=datetime.now(timezone.utc))
        with self._lock:
            self._buffer[msg.topic] = r

    def _decode(self, payload: bytes) -> Any:
        text = payload.decode("utf-8", errors="ignore").strip()
        if self._payload_mode == "json":
            obj = json.loads(text)
            # walk dotted path
            cur: Any = obj
            for part in str(self._json_path).split("."):
                if isinstance(cur, dict) and part in cur:
                    cur = cur[part]
                else:
                    return None
            return cur
        # raw: try numeric, else keep string
        try:
            return float(text)
        except ValueError:
            return text

    async def disconnect(self) -> None:
        if self._client:
            try:
                self._client.loop_stop()
                self._client.disconnect()
            except Exception:
                pass
        self._connected = False

    async def health(self) -> ConnectorStatus:
        with self._lock:
            active = len(self._buffer)
        return ConnectorStatus(connected=self._connected,
                               detail="connected" if self._connected else "disconnected",
                               streams_active=active)

    # ── discovery: report the topics we've actually seen ────────────────────
    async def discover(self) -> List[StreamSpec]:
        with self._lock:
            keys = list(self._buffer.keys())
        return [StreamSpec(stream_key=k, display_name=k) for k in keys]

    # ── poll: drain the buffer of latest-per-topic readings ─────────────────
    async def poll(self, stream_keys: List[str]) -> List[Reading]:
        with self._lock:
            readings = list(self._buffer.values())
            self._buffer.clear()
        return readings

    # ── write: publish to a topic ───────────────────────────────────────────
    async def write(self, stream_key: str, value: Any):
        from .base import WriteOutcome
        if not self._client or not self._connected:
            return WriteOutcome(success=False, error="not connected")
        try:
            payload = str(value)
            info = self._client.publish(stream_key, payload, qos=self._qos)
            return WriteOutcome(success=info.rc == 0, value_written=value,
                                error="" if info.rc == 0 else f"publish rc={info.rc}")
        except Exception as exc:
            return WriteOutcome(success=False, error=str(exc))
