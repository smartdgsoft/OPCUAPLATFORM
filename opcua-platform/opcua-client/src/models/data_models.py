"""Shared data models for the OPC UA client service."""
from __future__ import annotations
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional
from uuid import UUID


@dataclass(slots=True)
class TagValue:
    """Represents a single tag measurement."""
    time: datetime
    tag_id: UUID
    node_id: str
    raw_value: Any
    quality: int = 192
    source_timestamp: Optional[datetime] = None

    @property
    def value_num(self) -> Optional[float]:
        if isinstance(self.raw_value, bool):
            return None
        if isinstance(self.raw_value, (int, float)):
            return float(self.raw_value)
        return None

    @property
    def value_bool(self) -> Optional[bool]:
        if isinstance(self.raw_value, bool):
            return self.raw_value
        return None

    @property
    def value_str(self) -> Optional[str]:
        if isinstance(self.raw_value, str):
            return self.raw_value
        return None

    def to_db_row(self) -> dict:
        return {
            "time": self.time,
            "tag_id": str(self.tag_id),
            "value_num": self.value_num,
            "value_bool": self.value_bool,
            "value_str": self.value_str,
            "quality": self.quality,
            "source_timestamp": self.source_timestamp,
        }

    def to_redis_payload(self) -> dict:
        return {
            "tag_id": str(self.tag_id),
            "node_id": self.node_id,
            "value": self.raw_value if not isinstance(self.raw_value, bool)
                     else int(self.raw_value),
            "quality": self.quality,
            "ts": self.time.isoformat(),
        }
