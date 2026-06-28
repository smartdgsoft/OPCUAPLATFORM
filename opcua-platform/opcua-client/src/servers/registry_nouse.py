"""
OPC UA Server Registry
======================
Manages N simultaneous OPC UA server connections.
Each server has its own:
 - Connection config (URL, security, credentials)
 - Subscription (read)
 - Write channel
 - Method call channel
 - Health status

Feature flag: FEATURE_MULTI_SERVER=true (default: single server)
"""
from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from uuid import UUID

import asyncpg
import redis.asyncio as aioredis
import structlog
from asyncua import Client, Node, ua
from prometheus_client import Counter, Gauge

logger = structlog.get_logger(__name__)

MULTI_SERVER_ENABLED = os.getenv("FEATURE_MULTI_SERVER", "false").lower() == "true"

SERVER_CONNECTED   = Gauge("opcua_server_connected",   "Server connection status", ["server_id"])
SERVER_RECONNECTS  = Counter("opcua_server_reconnects", "Reconnect count",          ["server_id"])


@dataclass
class ServerConfig:
    """Runtime config for a single OPC UA server."""
    id: str                           # UUID from DB
    name: str
    endpoint_url: str
    security_mode: str  = "None"      # None | Sign | SignAndEncrypt
    security_policy: str = "None"     # None | Basic256Sha256 | Aes128Sha256RsaOaep
    username: Optional[str] = None
    password: Optional[str] = None
    certificate_path: Optional[str] = None
    private_key_path: Optional[str] = None
    publish_interval_ms: int = 1000
    enabled: bool = True
    tags: List[Dict] = field(default_factory=list)


@dataclass
class ServerState:
    config: ServerConfig
    client: Optional[Client] = None
    connected: bool = False
    last_connected: Optional[datetime] = None
    last_error: Optional[str] = None
    reconnect_count: int = 0
    subscription = None


class OPCUAServerRegistry:
    """
    Central registry for all configured OPC UA servers.
    Provides a unified interface to:
      - read (subscribe) from any server
      - write values to any server
      - call methods on any server
    """

    def __init__(
        self,
        ingest_queue: asyncio.Queue,
        pg_pool: asyncpg.Pool,
        redis: aioredis.Redis,
    ) -> None:
        self._queue   = ingest_queue
        self._pool    = pg_pool
        self._redis   = redis
        self._servers: Dict[str, ServerState] = {}
        self._running = False

    # ── Lifecycle ────────────────────────────────────────────────────────────

    async def start(self) -> None:
        self._running = True
        configs = await self._load_server_configs()
        for cfg in configs:
            self._servers[cfg.id] = ServerState(config=cfg)
            asyncio.create_task(self._connection_loop(cfg.id))

        # Listen for dynamic server add/remove via Redis
        asyncio.create_task(self._command_listener())
        logger.info("registry_started", server_count=len(configs))

    async def stop(self) -> None:
        self._running = False
        for state in self._servers.values():
            if state.client:
                try:
                    await state.client.disconnect()
                except Exception:
                    pass

    async def _load_server_configs(self) -> List[ServerConfig]:
        if not MULTI_SERVER_ENABLED:
            # Single-server mode: read from environment
            return [ServerConfig(
                id="default",
                name=os.getenv("OPC_SERVER_NAME", "Default Server"),
                endpoint_url=os.getenv("OPC_SERVER_URL", "opc.tcp://localhost:4840"),
                security_mode=os.getenv("OPC_SECURITY_MODE", "None"),
                security_policy=os.getenv("OPC_SECURITY_POLICY", "None"),
                username=os.getenv("OPC_USERNAME") or None,
                password=os.getenv("OPC_PASSWORD") or None,
                certificate_path=os.getenv("OPC_CERTIFICATE_PATH") or None,
                private_key_path=os.getenv("OPC_PRIVATE_KEY_PATH") or None,
                publish_interval_ms=int(os.getenv("PUBLISH_INTERVAL_MS", "1000")),
            )]

        # Multi-server mode: load from database
        rows = await self._pool.fetch("""
            SELECT id::text, name, endpoint_url, security_mode, security_policy,
                   username, password_encrypted, certificate_path, private_key_path,
                   publish_interval_ms, enabled
            FROM opc_servers WHERE enabled = TRUE ORDER BY name
        """)
        configs = []
        for r in rows:
            cfg = ServerConfig(
                id=r["id"],
                name=r["name"],
                endpoint_url=r["endpoint_url"],
                security_mode=r["security_mode"],
                security_policy=r["security_policy"],
                username=r["username"],
                password=r["password_encrypted"],  # decrypted at runtime
                certificate_path=r["certificate_path"],
                private_key_path=r["private_key_path"],
                publish_interval_ms=r["publish_interval_ms"],
                enabled=r["enabled"],
            )
            # Load tags for this server
            tag_rows = await self._pool.fetch("""
                SELECT id::text AS tag_id, node_id, display_name, deadband_value,
                       deadband_pct, sample_interval_ms
                FROM tags WHERE server_id = $1::uuid AND is_active = TRUE
            """, r["id"])
            cfg.tags = [dict(t) for t in tag_rows]
            configs.append(cfg)
        return configs

    # ── Connection management ─────────────────────────────────────────────────

    async def _connection_loop(self, server_id: str) -> None:
        """Per-server reconnect loop."""
        from tenacity import AsyncRetrying, stop_never, wait_exponential
        state = self._servers[server_id]
        cfg = state.config

        while self._running and cfg.enabled:
            try:
                async for attempt in AsyncRetrying(
                    stop=stop_never,
                    wait=wait_exponential(multiplier=1, min=2, max=60),
                    reraise=False,
                ):
                    with attempt:
                        SERVER_RECONNECTS.labels(server_id=server_id).inc()
                        await self._connect(server_id)
            except Exception as exc:
                state.last_error = str(exc)
                SERVER_CONNECTED.labels(server_id=server_id).set(0)
                await self._publish_server_status(server_id, False, str(exc))
                await asyncio.sleep(5)

    async def _connect(self, server_id: str) -> None:
        from src.client.opc_client import OPCUASubHandler
        state = self._servers[server_id]
        cfg = state.config

        client = Client(url=cfg.endpoint_url, timeout=10)

        if cfg.security_mode != "None" and cfg.certificate_path:
            await client.set_security_string(
                f"{cfg.security_policy},{cfg.security_mode},"
                f"{cfg.certificate_path},{cfg.private_key_path}"
            )
        if cfg.username:
            client.set_user(cfg.username)
            client.set_password(cfg.password or "")

        async with client:
            state.client = client
            state.connected = True
            state.last_connected = datetime.now(timezone.utc)
            SERVER_CONNECTED.labels(server_id=server_id).set(1)
            await self._publish_server_status(server_id, True)
            logger.info("server_connected", server_id=server_id, url=cfg.endpoint_url)

            # Set up subscriptions
            if cfg.tags:
                tag_map: Dict[int, Dict] = {}
                deadband_map: Dict[int, float] = {}
                handler = OPCUASubHandler(self._queue, tag_map, deadband_map)
                sub = await client.create_subscription(cfg.publish_interval_ms, handler)
                state.subscription = sub

                for tag in cfg.tags:
                    node = client.get_node(tag["node_id"])
                    try:
                        params = ua.MonitoringParameters(
                            sampling_interval=float(tag.get("sample_interval_ms", 1000)),
                            queue_size=10,
                            discard_oldest=True,
                        )
                        handle = await sub.subscribe_data_change(node, monitoring_parameters=params)
                        tag_map[handle] = tag
                        deadband_map[handle] = tag.get("deadband_value", 0.0)
                    except Exception as exc:
                        logger.error("subscribe_failed", node_id=tag["node_id"], error=str(exc))

            # Keepalive
            while self._running and cfg.enabled:
                await asyncio.sleep(5)
                await client.get_namespace_array()

    # ── Write ─────────────────────────────────────────────────────────────────

    async def write_node(
        self,
        server_id: str,
        node_id: str,
        value: Any,
        data_type: str = "Double",
    ) -> dict:
        """
        Write a value to an OPC UA node.
        Returns: {success, timestamp, error}
        """
        state = self._servers.get(server_id)
        if not state or not state.connected or not state.client:
            return {"success": False, "error": f"Server {server_id} not connected"}

        try:
            node = state.client.get_node(node_id)
            ua_value = _to_ua_value(value, data_type)
            dv = ua.DataValue(ua.Variant(ua_value, _ua_type(data_type)))
            dv.SourceTimestamp = datetime.now(timezone.utc)
            await node.write_value(dv)

            ts = datetime.now(timezone.utc).isoformat()
            logger.info("node_written", server_id=server_id, node_id=node_id, value=value)

            # Record write to audit log via Redis
            await self._redis.lpush("opcua:write:log", json.dumps({
                "server_id": server_id, "node_id": node_id,
                "value": str(value), "ts": ts,
            }))

            return {"success": True, "timestamp": ts}

        except Exception as exc:
            logger.error("write_failed", server_id=server_id, node_id=node_id, error=str(exc))
            return {"success": False, "error": str(exc)}

    # ── Read ──────────────────────────────────────────────────────────────────

    async def read_node(self, server_id: str, node_id: str) -> dict:
        """Direct (non-subscribed) read of a node value. Returns JSON-safe values."""
        state = self._servers.get(server_id)
        if not state or not state.connected or not state.client:
            return {"success": False, "error": "Not connected"}

        try:
            node = state.client.get_node(node_id)
            dv = await node.read_data_value()
            raw_val = dv.Value.Value if dv.Value else None
            # Coerce to JSON-safe type
            if isinstance(raw_val, (bool, int, float, str)) or raw_val is None:
                safe_val = raw_val
            else:
                safe_val = str(raw_val)
            return {
                "success": True,
                "node_id": node_id,
                "value": safe_val,
                "quality": dv.StatusCode.value if dv.StatusCode else 0,
                "source_timestamp": dv.SourceTimestamp.isoformat() if dv.SourceTimestamp else None,
                "server_timestamp": dv.ServerTimestamp.isoformat() if dv.ServerTimestamp else None,
            }
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    # ── Method calls ──────────────────────────────────────────────────────────

    async def call_method(
        self,
        server_id: str,
        object_node_id: str,
        method_node_id: str,
        input_args: List[Any],
        arg_types: List[str],
    ) -> dict:
        """
        Call an OPC UA Method node.
        object_node_id: the Object that owns the method
        method_node_id: the Method node itself
        input_args: list of argument values
        arg_types:  list of OPC UA type names for each arg
        """
        state = self._servers.get(server_id)
        if not state or not state.connected or not state.client:
            return {"success": False, "error": "Not connected"}

        try:
            obj_node = state.client.get_node(object_node_id)
            ua_args = [
                ua.Variant(_to_ua_value(v, t), _ua_type(t))
                for v, t in zip(input_args, arg_types)
            ]
            results = await obj_node.call_method(method_node_id, *ua_args)
            ts = datetime.now(timezone.utc).isoformat()
            logger.info("method_called", server_id=server_id,
                        method=method_node_id, results=str(results))
            return {
                "success": True,
                "results": results if isinstance(results, list) else [results],
                "timestamp": ts,
            }
        except Exception as exc:
            logger.error("method_failed", server_id=server_id,
                         method=method_node_id, error=str(exc))
            return {"success": False, "error": str(exc)}

    # ── Browse ────────────────────────────────────────────────────────────────

    async def browse(self, server_id: str, node_id: str = "i=85") -> List[dict]:
        state = self._servers.get(server_id)
        if not state or not state.connected or not state.client:
            return []

        node = state.client.get_node(node_id)
        children = await node.get_children()
        result = []
        for child in children[:200]:
            try:
                dn = await child.read_display_name()
                nc = await child.read_node_class()
                kids = await child.get_children()
                dt = None
                if nc.name == "Variable":
                    try:
                        dt = str(await child.read_data_type())
                    except Exception:
                        pass
                result.append({
                    "node_id": str(child.nodeid),
                    "display_name": dn.Text,
                    "node_class": nc.name,
                    "data_type": dt,
                    "children_count": len(kids),
                })
            except Exception:
                continue
        return result

    # ── Status ────────────────────────────────────────────────────────────────

    async def get_server_info(self, server_id: str) -> dict:
        """Read server identity (build info + namespaces) from a connected server."""
        from asyncua import ua
        state = self._servers.get(server_id)
        if not state or not state.connected or not state.client:
            return {"success": False, "error": "Not connected"}
        try:
            client = state.client
            name = sw = bn = mfr = None
            try:
                status_node = client.get_node(ua.NodeId(2256, 0))  # ServerStatus
                status = await status_node.read_value()
                if hasattr(status, "BuildInfo"):
                    name = str(status.BuildInfo.ProductName)
                    sw   = str(status.BuildInfo.SoftwareVersion)
                    bn   = str(status.BuildInfo.BuildNumber)
                    mfr  = str(status.BuildInfo.ManufacturerName)
            except Exception:
                pass
            try:
                ns_array = await client.get_namespace_array()
            except Exception:
                ns_array = []
            return {
                "success": True,
                "endpoint_url": state.config.endpoint_url,
                "server_name": name,
                "software_version": sw,
                "build_number": bn,
                "manufacturer": mfr,
                "namespaces": ns_array,
            }
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    def get_all_status(self) -> List[dict]:
        return [
            {
                "server_id": sid,
                "name": s.config.name,
                "endpoint_url": s.config.endpoint_url,
                "connected": s.connected,
                "last_connected": s.last_connected.isoformat() if s.last_connected else None,
                "last_error": s.last_error,
                "reconnect_count": s.reconnect_count,
                "tag_count": len(s.config.tags),
            }
            for sid, s in self._servers.items()
        ]

    # ── Helpers ───────────────────────────────────────────────────────────────

    async def _publish_server_status(self, server_id: str, connected: bool, error: str = "") -> None:
        await self._redis.set(
            f"opcua:server:{server_id}:status",
            json.dumps({
                "connected": connected,
                "ts": datetime.now(timezone.utc).isoformat(),
                "error": error,
            }),
            ex=60,
        )
        await self._redis.publish("opcua:server:events", json.dumps({
            "server_id": server_id,
            "event": "connected" if connected else "disconnected",
            "error": error,
            "ts": datetime.now(timezone.utc).isoformat(),
        }))

    async def _command_listener(self) -> None:
        """Listen for dynamic commands via Redis: add/remove server, browse, read."""
        pubsub = self._redis.pubsub()
        await pubsub.subscribe("opcua:commands")
        async for msg in pubsub.listen():
            if msg["type"] != "message":
                continue
            try:
                cmd = json.loads(msg["data"])
                action = cmd.get("cmd")

                if action == "add_server":
                    cfg = ServerConfig(**cmd["config"])
                    self._servers[cfg.id] = ServerState(config=cfg)
                    asyncio.create_task(self._connection_loop(cfg.id))
                    logger.info("server_added_dynamically", server_id=cfg.id)

                elif action == "remove_server":
                    sid = cmd.get("server_id")
                    if sid in self._servers:
                        self._servers[sid].config.enabled = False
                        if self._servers[sid].client:
                            try:
                                await self._servers[sid].client.disconnect()
                            except Exception:
                                pass
                        logger.info("server_disabled", server_id=sid)

                elif action == "browse":
                    sid = cmd.get("server_id", "default")
                    node_id = cmd.get("node_id", "i=85")
                    result = await self.browse(sid, node_id)
                    await self._redis.setex(
                        f"opcua:browse:{sid}:{node_id}", 30, json.dumps(result)
                    )

                elif action == "read":
                    sid = cmd.get("server_id", "default")
                    node_id = cmd.get("node_id")
                    request_id = cmd.get("request_id", "")
                    result = await self.read_node(sid, node_id)
                    if request_id:
                        await self._redis.setex(
                            f"opcua:read:result:{request_id}", 30, json.dumps(result, default=str)
                        )

                elif action == "restart":
                    # Force reconnect all servers
                    logger.info("restart_command_received")
                    for sid, st in list(self._servers.items()):
                        if st.client:
                            try:
                                await st.client.disconnect()
                            except Exception:
                                pass
                        st.connected = False
                    # Connection loops will auto-reconnect

                elif action == "server_info":
                    sid = cmd.get("server_id", "default")
                    request_id = cmd.get("request_id", "")
                    info = await self.get_server_info(sid)
                    if request_id:
                        await self._redis.setex(
                            f"opcua:serverinfo:{request_id}", 30,
                            json.dumps(info, default=str)
                        )

            except Exception as exc:
                logger.error("command_error", error=str(exc))


# ── OPC UA type helpers ────────────────────────────────────────────────────

def _to_ua_value(value: Any, data_type: str) -> Any:
    mapping = {
        "Boolean": bool, "Int16": int, "Int32": int, "Int64": int,
        "UInt16": int, "UInt32": int, "UInt64": int,
        "Float": float, "Double": float, "String": str, "Byte": int,
    }
    cast = mapping.get(data_type, str)
    return cast(value)


def _ua_type(data_type: str) -> ua.VariantType:
    mapping = {
        "Boolean": ua.VariantType.Boolean,
        "Int16":   ua.VariantType.Int16,
        "Int32":   ua.VariantType.Int32,
        "Int64":   ua.VariantType.Int64,
        "UInt16":  ua.VariantType.UInt16,
        "UInt32":  ua.VariantType.UInt32,
        "UInt64":  ua.VariantType.UInt64,
        "Float":   ua.VariantType.Float,
        "Double":  ua.VariantType.Double,
        "String":  ua.VariantType.String,
        "Byte":    ua.VariantType.Byte,
    }
    return mapping.get(data_type, ua.VariantType.Double)
