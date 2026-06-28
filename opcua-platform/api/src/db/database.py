"""Async database connection management using asyncpg pool."""
from __future__ import annotations
from typing import Optional
import asyncpg
import redis.asyncio as aioredis
from src.config.settings import settings

_pg_pool: Optional[asyncpg.Pool] = None
_redis: Optional[aioredis.Redis] = None


async def init_db() -> None:
    global _pg_pool, _redis
    _pg_pool = await asyncpg.create_pool(
        dsn=settings.pg_dsn_sync,
        min_size=5,
        max_size=20,
        command_timeout=60,
    )
    _redis = aioredis.from_url(settings.redis_url, decode_responses=True)


async def close_db() -> None:
    global _pg_pool, _redis
    if _pg_pool:
        await _pg_pool.close()
    if _redis:
        await _redis.aclose()


def get_pool() -> asyncpg.Pool:
    if _pg_pool is None:
        raise RuntimeError("Database pool not initialized")
    return _pg_pool


def get_redis() -> aioredis.Redis:
    if _redis is None:
        raise RuntimeError("Redis not initialized")
    return _redis
