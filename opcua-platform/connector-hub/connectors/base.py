"""
Connector SDK — the uniform contract every connector implements.

A connector translates one protocol (OPC UA, SQL, MQTT, Modbus, ...) into
normalized Readings landed in the SAME tag_values pipeline. Downstream code
(twin, detectors, templates) is therefore connector-agnostic.

Two execution shapes:
  - poll/batch  : implement poll() -> list[Reading]
  - subscribe   : implement subscribe(on_reading) for push sources

Optional write() for sources that support actuation; many are read-only.

Permissive OSS only.
"""
from __future__ import annotations
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional


# Normalized quality (matches the platform convention used everywhere else)
QUALITY_GOOD = 192
QUALITY_UNCERTAIN = 64
QUALITY_BAD = 0


@dataclass
class Reading:
    """A single normalized value from any source."""
    stream_key: str
    value: Any
    quality: int = QUALITY_GOOD
    ts: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def numeric(self) -> Optional[float]:
        if isinstance(self.value, bool):
            return 1.0 if self.value else 0.0
        if isinstance(self.value, (int, float)):
            return float(self.value)
        try:
            return float(self.value)
        except (TypeError, ValueError):
            return None


@dataclass
class StreamSpec:
    """A discoverable point within a source (returned by discover())."""
    stream_key: str
    display_name: str
    data_type: str = "Double"
    unit: Optional[str] = None
    meta: Dict[str, Any] = field(default_factory=dict)


@dataclass
class WriteOutcome:
    success: bool
    error: str = ""
    value_written: Any = None


@dataclass
class ConnectorStatus:
    connected: bool
    detail: str = ""
    streams_active: int = 0


class BaseConnector(ABC):
    """Uniform connector interface. Subclasses implement a protocol."""

    #: connector key matching sources.source_type
    source_type: str = "base"
    #: 'poll' | 'subscribe' | 'batch'
    mode: str = "poll"
    #: whether this connector can write back
    writable: bool = False

    def __init__(self, source_id: str, config: Dict[str, Any]):
        self.source_id = source_id
        self.config = config or {}

    # ── lifecycle ──────────────────────────────────────────────────────────
    @abstractmethod
    async def connect(self) -> None:
        """Establish the connection. Raise on failure."""
        raise NotImplementedError

    async def disconnect(self) -> None:
        """Tear down cleanly. Default no-op."""
        return None

    @abstractmethod
    async def health(self) -> ConnectorStatus:
        raise NotImplementedError

    # ── discovery ──────────────────────────────────────────────────────────
    async def discover(self) -> List[StreamSpec]:
        """List available points/topics/registers. Optional (return [])."""
        return []

    # ── data acquisition (implement ONE of poll/subscribe per mode) ─────────
    async def poll(self, stream_keys: List[str]) -> List[Reading]:
        """Poll the given streams once. For mode='poll'/'batch'."""
        return []

    async def subscribe(self, stream_keys: List[str],
                        on_reading: Callable[[Reading], Any]) -> None:
        """Push readings via on_reading as they arrive. For mode='subscribe'."""
        return None

    # ── optional write ─────────────────────────────────────────────────────
    async def write(self, stream_key: str, value: Any) -> WriteOutcome:
        if not self.writable:
            return WriteOutcome(success=False, error="source is not writable")
        raise NotImplementedError
