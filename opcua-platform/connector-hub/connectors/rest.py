"""
REST API connector.

Polls an HTTP(S) endpoint on an interval and turns the JSON response into
normalized Readings. REST APIs vary a lot, so this connector supports the common
shapes seen in industrial/IoT REST endpoints:

Auth (config.auth):
  none                         — no auth
  bearer   + token             — Authorization: Bearer <token>
  api_key  + header + key      — <header>: <key>   (e.g. X-API-Key)
  basic    + username+password — HTTP Basic

Response mapping (config.mapping):
  A) "fields"  — the response is one object; pull named fields as streams.
       fields: ["temperature", "pressure"]  or  {"temperature":"temp_c", ...}
       (dotted paths allowed, e.g. "data.sensors.temp")
       stream_key = the field name.

  B) "array"   — the response (or a nested path) is a LIST of records, each a
       reading. Natural per-unit attribution.
       array_path: "data.readings"          # where the list lives ("" = root)
       key_field:  "nozzle"                 # namespaces the stream_key
       value_field:"weight"
       name_field: "metric"   (optional; combined with key -> weight:nozzle=3)
       ts_field:   "timestamp" (optional; ISO8601)

Config also: url, method (GET/POST), headers{}, params{}, json_body{}, verify_tls.

Permissive OSS only: httpx (BSD).
"""
from __future__ import annotations
import base64
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import structlog

from .base import (BaseConnector, Reading, StreamSpec, ConnectorStatus,
                   WriteOutcome, QUALITY_GOOD, QUALITY_BAD)

logger = structlog.get_logger(__name__)


def _dig(obj: Any, path: str) -> Any:
    """Walk a dotted path into nested dicts/lists. '' returns obj."""
    if path == "" or path is None:
        return obj
    cur = obj
    for part in str(path).split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        elif isinstance(cur, list) and part.isdigit() and int(part) < len(cur):
            cur = cur[int(part)]
        else:
            return None
    return cur


class RestConnector(BaseConnector):
    source_type = "rest"
    mode = "poll"
    writable = False

    def __init__(self, source_id: str, config: Dict[str, Any]):
        super().__init__(source_id, config)
        self._client = None
        self._connected = False
        self._last_ok = False

    # ── lifecycle ──────────────────────────────────────────────────────────
    async def connect(self) -> None:
        try:
            import httpx  # noqa
        except ImportError as exc:
            raise RuntimeError("httpx not installed in connector-hub image") from exc
        if not self.config.get("url"):
            raise ValueError("REST source requires 'url'")
        import httpx
        verify = self.config.get("verify_tls", True)
        self._client = httpx.AsyncClient(timeout=15.0, verify=verify,
                                         headers=self._auth_headers())
        # validate with one request
        await self._fetch()
        self._connected = True
        logger.info("rest_connected", url=self.config.get("url"))

    def _auth_headers(self) -> Dict[str, str]:
        headers = dict(self.config.get("headers", {}) or {})
        auth = self.config.get("auth", {}) or {}
        kind = (auth.get("type") or "none").lower()
        if kind == "bearer" and auth.get("token"):
            headers["Authorization"] = f"Bearer {auth['token']}"
        elif kind == "api_key" and auth.get("key"):
            headers[auth.get("header", "X-API-Key")] = auth["key"]
        elif kind == "basic" and auth.get("username"):
            raw = f"{auth['username']}:{auth.get('password','')}".encode()
            headers["Authorization"] = "Basic " + base64.b64encode(raw).decode()
        return headers

    async def _fetch(self) -> Any:
        method = (self.config.get("method") or "GET").upper()
        url = self.config["url"]
        params = self.config.get("params") or {}
        if method == "POST":
            resp = await self._client.post(url, params=params, json=self.config.get("json_body"))
        else:
            resp = await self._client.get(url, params=params)
        resp.raise_for_status()
        self._last_ok = True
        return resp.json()

    async def disconnect(self) -> None:
        if self._client:
            try:
                await self._client.aclose()
            except Exception:
                pass
        self._connected = False

    async def health(self) -> ConnectorStatus:
        return ConnectorStatus(connected=self._connected and self._last_ok,
                               detail="ok" if self._last_ok else "no successful fetch yet")

    # ── poll: fetch + map to readings ───────────────────────────────────────
    async def poll(self, stream_keys: List[str]) -> List[Reading]:
        if not self._client:
            return []
        try:
            data = await self._fetch()
        except Exception as exc:
            self._last_ok = False
            logger.error("rest_fetch_failed", error=str(exc))
            return []
        mapping = self.config.get("mapping", {}) or {}
        mode = (mapping.get("mode") or "fields").lower()
        now = datetime.now(timezone.utc)
        out: List[Reading] = []

        if mode == "array":
            arr = _dig(data, mapping.get("array_path", ""))
            if not isinstance(arr, list):
                return []
            key_field = mapping.get("key_field")
            value_field = mapping.get("value_field", "value")
            name_field = mapping.get("name_field")
            ts_field = mapping.get("ts_field")
            for rec in arr:
                if not isinstance(rec, dict):
                    continue
                val = _dig(rec, value_field)
                if val is None:
                    continue
                # build stream_key: [name:]key=<keyval>  (namespaced per unit)
                base = str(_dig(rec, name_field)) if name_field else (value_field)
                if key_field is not None:
                    kv = _dig(rec, key_field)
                    stream_key = f"{base}:{key_field}={kv}"
                else:
                    stream_key = base
                ts = now
                if ts_field:
                    raw_ts = _dig(rec, ts_field)
                    ts = _parse_ts(raw_ts) or now
                out.append(Reading(stream_key=stream_key, value=val, quality=QUALITY_GOOD, ts=ts))
        else:
            # fields mode: pull named fields from the (single) object
            fields = mapping.get("fields", [])
            # allow root path to focus into a sub-object first
            root = _dig(data, mapping.get("object_path", ""))
            if isinstance(fields, dict):
                items = fields.items()               # {stream_key: json_path}
            else:
                items = [(f, f) for f in fields]      # [field] -> path == name
            for stream_key, path in items:
                val = _dig(root, path)
                if val is not None:
                    out.append(Reading(stream_key=stream_key, value=val,
                                       quality=QUALITY_GOOD, ts=now))
        return out


def _parse_ts(raw: Any) -> Optional[datetime]:
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        # epoch seconds (or ms)
        v = float(raw)
        if v > 1e12:
            v /= 1000.0
        return datetime.fromtimestamp(v, tz=timezone.utc)
    try:
        s = str(raw).replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except Exception:
        return None
