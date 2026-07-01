"""
Connector registry — maps sources.source_type to a connector class.

Adding a new connector (Sprints 3-50) = implement BaseConnector + register here.
Nothing else in the hub, schema, or downstream learning changes.
"""
from __future__ import annotations
from typing import Dict, Type

from .base import BaseConnector
from .sql import SqlConnector
from .mqtt import MqttConnector
from .modbus import ModbusConnector

_REGISTRY: Dict[str, Type[BaseConnector]] = {
    SqlConnector.source_type: SqlConnector,
    MqttConnector.source_type: MqttConnector,
    ModbusConnector.source_type: ModbusConnector,
}


def get_connector(source_type: str, source_id: str, config: dict) -> BaseConnector:
    cls = _REGISTRY.get(source_type)
    if cls is None:
        raise ValueError(f"Unknown source_type '{source_type}'. "
                         f"Available: {', '.join(_REGISTRY)}")
    return cls(source_id, config or {})


def available_source_types() -> list[str]:
    return list(_REGISTRY)
