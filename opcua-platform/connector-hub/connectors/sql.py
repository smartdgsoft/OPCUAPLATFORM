"""
SQL Database connector.

Polls a customer's existing database / historian on an interval and turns query
result rows into normalized Readings. This is the highest-leverage first
connector: it lets the learning engine consume data the customer ALREADY has,
with no new field hardware.

Config (sources.config JSONB):
{
  "dsn": "postgresql://user:pass@host:5432/db",   # SQLAlchemy URL
                                                    # mysql+pymysql://..., mssql+pyodbc://...
  "query": "SELECT ts, weight, nozzle FROM fills WHERE ts > :since ORDER BY ts",
  "timestamp_column": "ts",        # which column is the reading time (optional)
  "value_columns": ["weight"],     # columns to emit as streams (one stream each)
  "key_column": null,              # optional: a column whose value namespaces the
                                   #   stream_key, e.g. 'nozzle' -> weight:nozzle=3
  "incremental_column": "ts",      # for :since incremental polling (optional)
  "since_lookback_s": 3600         # initial lookback window
}

stream_key convention:
  - simple:        "<value_column>"               e.g. "weight"
  - keyed:         "<value_column>:<key>=<val>"   e.g. "weight:nozzle=3"

Permissive OSS only: SQLAlchemy (+ the customer's chosen DB driver).
"""
from __future__ import annotations
import asyncio
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional

import structlog
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

from .base import (
    BaseConnector, Reading, StreamSpec, ConnectorStatus,
    QUALITY_GOOD, QUALITY_BAD,
)

logger = structlog.get_logger(__name__)


class SqlConnector(BaseConnector):
    source_type = "sql"
    mode = "poll"
    writable = False

    def __init__(self, source_id: str, config: Dict[str, Any]):
        super().__init__(source_id, config)
        self._engine: Optional[Engine] = None
        self._since: Optional[datetime] = None

    # ── lifecycle ──────────────────────────────────────────────────────────
    async def connect(self) -> None:
        dsn = self.config.get("dsn")
        if not dsn:
            raise ValueError("SQL source requires a 'dsn' in config")
        # create_engine is sync; pool_pre_ping keeps long-lived connections sane.
        self._engine = await asyncio.to_thread(
            create_engine, dsn, pool_pre_ping=True, pool_size=2, max_overflow=2)
        # validate connectivity early
        await asyncio.to_thread(self._test)
        lookback = int(self.config.get("since_lookback_s", 3600))
        self._since = datetime.now(tz=timezone.utc) - timedelta(seconds=lookback)
        logger.info("sql_connected", source_id=self.source_id)

    def _test(self) -> None:
        assert self._engine is not None
        with self._engine.connect() as con:
            con.execute(text("SELECT 1"))

    async def disconnect(self) -> None:
        if self._engine is not None:
            await asyncio.to_thread(self._engine.dispose)
            self._engine = None

    async def health(self) -> ConnectorStatus:
        if self._engine is None:
            return ConnectorStatus(connected=False, detail="not connected")
        try:
            await asyncio.to_thread(self._test)
            return ConnectorStatus(connected=True, detail="ok")
        except Exception as exc:
            return ConnectorStatus(connected=False, detail=str(exc))

    # ── discovery ──────────────────────────────────────────────────────────
    async def discover(self) -> List[StreamSpec]:
        """Run the query once and infer streams from the value columns."""
        rows = await self._run_query(limit_probe=True)
        specs: List[StreamSpec] = []
        seen = set()
        for r in rows:
            for sk in self._row_stream_keys(r):
                if sk not in seen:
                    seen.add(sk)
                    specs.append(StreamSpec(stream_key=sk, display_name=sk))
        return specs

    # ── polling ────────────────────────────────────────────────────────────
    async def poll(self, stream_keys: List[str]) -> List[Reading]:
        rows = await self._run_query()
        readings: List[Reading] = []
        ts_col = self.config.get("timestamp_column")
        wanted = set(stream_keys) if stream_keys else None

        max_ts = self._since
        for row in rows:
            ts = self._row_ts(row, ts_col)
            for value_col in self.config.get("value_columns", []):
                sk = self._stream_key_for(row, value_col)
                if wanted is not None and sk not in wanted:
                    continue
                val = row.get(value_col)
                if val is None:
                    continue
                readings.append(Reading(stream_key=sk, value=val,
                                        quality=QUALITY_GOOD, ts=ts))
            if ts and (max_ts is None or ts > max_ts):
                max_ts = ts

        # advance incremental watermark so next poll only gets new rows
        if self.config.get("incremental_column") and max_ts:
            self._since = max_ts
        return readings

    # ── helpers ────────────────────────────────────────────────────────────
    async def _run_query(self, limit_probe: bool = False) -> List[Dict[str, Any]]:
        if self._engine is None:
            raise RuntimeError("SQL source not connected")
        query = self.config.get("query")
        if not query:
            raise ValueError("SQL source requires a 'query' in config")
        params: Dict[str, Any] = {}
        if ":since" in query and self._since is not None:
            params["since"] = self._since
        return await asyncio.to_thread(self._execute, query, params, limit_probe)

    def _execute(self, query: str, params: Dict[str, Any], limit_probe: bool) -> List[Dict[str, Any]]:
        assert self._engine is not None
        with self._engine.connect() as con:
            result = con.execute(text(query), params)
            cols = list(result.keys())
            rows = []
            for i, row in enumerate(result):
                rows.append(dict(zip(cols, row)))
                if limit_probe and i >= 50:
                    break
            return rows

    def _row_ts(self, row: Dict[str, Any], ts_col: Optional[str]) -> datetime:
        if ts_col and row.get(ts_col) is not None:
            v = row[ts_col]
            if isinstance(v, datetime):
                return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
        return datetime.now(tz=timezone.utc)

    def _stream_key_for(self, row: Dict[str, Any], value_col: str) -> str:
        key_col = self.config.get("key_column")
        if key_col and row.get(key_col) is not None:
            return f"{value_col}:{key_col}={row[key_col]}"
        return value_col

    def _row_stream_keys(self, row: Dict[str, Any]) -> List[str]:
        return [self._stream_key_for(row, vc) for vc in self.config.get("value_columns", [])]
