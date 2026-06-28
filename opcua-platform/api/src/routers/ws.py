"""
WebSocket endpoint for real-time tag value streaming.
Clients subscribe to specific tag_ids. Redis pub/sub broadcasts updates.
"""
from __future__ import annotations

import asyncio
import json
from typing import Set

import redis.asyncio as aioredis
import structlog
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query

from src.db.database import get_redis

router = APIRouter()
logger = structlog.get_logger(__name__)


class ConnectionManager:
    def __init__(self):
        # tag_id -> set of websocket connections
        self._subscribers: dict[str, Set[WebSocket]] = {}

    def subscribe(self, ws: WebSocket, tag_ids: list[str]) -> None:
        for tid in tag_ids:
            self._subscribers.setdefault(tid, set()).add(ws)

    def unsubscribe(self, ws: WebSocket) -> None:
        for tag_id, conns in list(self._subscribers.items()):
            conns.discard(ws)
            if not conns:
                del self._subscribers[tag_id]

    async def broadcast(self, tag_id: str, message: str) -> None:
        dead = set()
        for ws in self._subscribers.get(tag_id, set()):
            try:
                await ws.send_text(message)
            except Exception:
                dead.add(ws)
        for ws in dead:
            self.unsubscribe(ws)


manager = ConnectionManager()


@router.websocket("/live")
async def ws_live(
    websocket: WebSocket,
    tag_ids: str = Query(..., description="Comma-separated tag UUIDs"),
):
    """
    Connect with ?tag_ids=uuid1,uuid2,...
    Receives JSON messages: {tag_id, node_id, value, quality, ts}
    """
    await websocket.accept()
    requested = [t.strip() for t in tag_ids.split(",") if t.strip()]
    manager.subscribe(websocket, requested)
    logger.info("ws_client_connected", tag_count=len(requested))

    redis: aioredis.Redis = get_redis()
    pubsub = redis.pubsub()
    await pubsub.subscribe("tag:updates")

    async def _redis_listener():
        async for message in pubsub.listen():
            if message["type"] != "message":
                continue
            try:
                data = json.loads(message["data"])
                tag_id = data.get("tag_id")
                if tag_id in requested:
                    await websocket.send_text(message["data"])
            except Exception:
                pass

    listener_task = asyncio.create_task(_redis_listener())

    try:
        # Keep connection alive; handle ping/pong or client messages
        while True:
            try:
                msg = await asyncio.wait_for(websocket.receive_text(), timeout=30)
                # Client can send {"type": "subscribe", "tag_ids": [...]} to add tags
                if msg:
                    cmd = json.loads(msg)
                    if cmd.get("type") == "subscribe":
                        new_ids = cmd.get("tag_ids", [])
                        requested.extend(new_ids)
                        manager.subscribe(websocket, new_ids)
            except asyncio.TimeoutError:
                # Send heartbeat
                await websocket.send_text(json.dumps({"type": "heartbeat"}))

    except WebSocketDisconnect:
        logger.info("ws_client_disconnected")
    finally:
        listener_task.cancel()
        manager.unsubscribe(websocket)
        await pubsub.unsubscribe("tag:updates")
