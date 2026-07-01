"""
Modbus TCP connector.

Classic industrial poll-based protocol: read registers from a PLC/device on an
interval. Fits the hub's poll mode directly. Each configured register becomes a
stream, so per-unit attribution works if you map registers to units.

Config:
  host, port (default 502), unit_id (default 1)
  registers: [
    { "name": "nozzle3_weight", "address": 100, "type": "holding",
      "data_type": "float32", "scale": 1.0, "offset": 0.0, "word_order": "big" },
    ...
  ]
  types: holding | input | coil | discrete
  data_type: int16 | uint16 | int32 | uint32 | float32 | bool
  scale/offset: value = raw * scale + offset  (engineering conversion)

stream_key = register name -> use names like "weight:nozzle=3" for attribution.

Permissive OSS only: pymodbus (BSD).
"""
from __future__ import annotations
import asyncio
import struct
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import structlog

from .base import (BaseConnector, Reading, StreamSpec, ConnectorStatus,
                   WriteOutcome, QUALITY_GOOD, QUALITY_BAD)

logger = structlog.get_logger(__name__)


class ModbusConnector(BaseConnector):
    source_type = "modbus_tcp"
    mode = "poll"
    writable = True

    def __init__(self, source_id: str, config: Dict[str, Any]):
        super().__init__(source_id, config)
        self._client = None
        self._connected = False
        self._unit = int(config.get("unit_id", 1))
        self._registers: List[Dict[str, Any]] = list(config.get("registers", []))
        self._by_name = {r["name"]: r for r in self._registers if r.get("name")}

    # ── lifecycle ──────────────────────────────────────────────────────────
    async def connect(self) -> None:
        try:
            from pymodbus.client import AsyncModbusTcpClient
        except ImportError as exc:
            raise RuntimeError("pymodbus not installed in connector-hub image") from exc
        host = self.config.get("host")
        if not host:
            raise ValueError("Modbus source requires 'host'")
        port = int(self.config.get("port", 502))
        self._client = AsyncModbusTcpClient(host, port=port)
        ok = await self._client.connect()
        if not ok:
            raise ConnectionError(f"could not connect to Modbus {host}:{port}")
        self._connected = True
        logger.info("modbus_connected", host=host, port=port, registers=len(self._registers))

    async def disconnect(self) -> None:
        if self._client:
            try:
                self._client.close()
            except Exception:
                pass
        self._connected = False

    async def health(self) -> ConnectorStatus:
        connected = bool(self._client and self._client.connected)
        self._connected = connected
        return ConnectorStatus(connected=connected,
                               detail="connected" if connected else "disconnected",
                               streams_active=len(self._registers))

    async def discover(self) -> List[StreamSpec]:
        return [StreamSpec(stream_key=r["name"], display_name=r["name"],
                           data_type=r.get("data_type", "Double"),
                           unit=r.get("unit"))
                for r in self._registers if r.get("name")]

    # ── poll: read each configured register ─────────────────────────────────
    async def poll(self, stream_keys: List[str]) -> List[Reading]:
        if not self._client or not self._connected:
            return []
        out: List[Reading] = []
        for reg in self._registers:
            name = reg.get("name")
            if not name:
                continue
            try:
                val = await self._read_register(reg)
            except Exception as exc:
                logger.error("modbus_read_failed", register=name, error=str(exc))
                out.append(Reading(stream_key=name, value=0, quality=QUALITY_BAD))
                continue
            if val is None:
                out.append(Reading(stream_key=name, value=0, quality=QUALITY_BAD))
                continue
            scale = float(reg.get("scale", 1.0)); offset = float(reg.get("offset", 0.0))
            eng = val * scale + offset if isinstance(val, (int, float)) else val
            out.append(Reading(stream_key=name, value=eng,
                               quality=QUALITY_GOOD, ts=datetime.now(timezone.utc)))
        return out

    async def _read_register(self, reg: Dict[str, Any]) -> Optional[Any]:
        addr = int(reg["address"])
        rtype = (reg.get("type") or "holding").lower()
        dtype = (reg.get("data_type") or "uint16").lower()
        count = 2 if dtype in ("int32", "uint32", "float32") else 1

        if rtype == "holding":
            rr = await self._client.read_holding_registers(addr, count=count, slave=self._unit)
        elif rtype == "input":
            rr = await self._client.read_input_registers(addr, count=count, slave=self._unit)
        elif rtype == "coil":
            rr = await self._client.read_coils(addr, count=1, slave=self._unit)
            return bool(rr.bits[0]) if not rr.isError() else None
        elif rtype == "discrete":
            rr = await self._client.read_discrete_inputs(addr, count=1, slave=self._unit)
            return bool(rr.bits[0]) if not rr.isError() else None
        else:
            return None

        if rr.isError():
            return None
        regs = rr.registers
        return self._decode(regs, dtype, reg.get("word_order", "big"))

    @staticmethod
    def _decode(regs: List[int], dtype: str, word_order: str) -> Any:
        if not regs:
            return None
        if dtype in ("int16", "uint16"):
            v = regs[0]
            if dtype == "int16" and v >= 0x8000:
                v -= 0x10000
            return v
        # 32-bit types: combine two 16-bit words
        if len(regs) < 2:
            return None
        hi, lo = (regs[0], regs[1]) if word_order == "big" else (regs[1], regs[0])
        raw = (hi << 16) | lo
        if dtype == "uint32":
            return raw
        if dtype == "int32":
            return raw - 0x100000000 if raw >= 0x80000000 else raw
        if dtype == "float32":
            return struct.unpack(">f", struct.pack(">I", raw))[0]
        return raw

    # ── write: write a holding register (with reverse scaling) ──────────────
    async def write(self, stream_key: str, value: Any) -> WriteOutcome:
        if not self._client or not self._connected:
            return WriteOutcome(success=False, error="not connected")
        reg = self._by_name.get(stream_key)
        if not reg:
            return WriteOutcome(success=False, error=f"unknown register '{stream_key}'")
        try:
            scale = float(reg.get("scale", 1.0)); offset = float(reg.get("offset", 0.0))
            raw = int(round((float(value) - offset) / scale)) if scale else int(value)
            rr = await self._client.write_register(int(reg["address"]), raw, slave=self._unit)
            if rr.isError():
                return WriteOutcome(success=False, error="modbus write error")
            return WriteOutcome(success=True, value_written=value)
        except Exception as exc:
            return WriteOutcome(success=False, error=str(exc))
