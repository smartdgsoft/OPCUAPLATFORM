"""Tag registry CRUD and live value endpoints."""
from __future__ import annotations

import json
from typing import List, Optional

import asyncpg
import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from src.auth.jwt import UserOut, get_current_user, require_roles
from src.db.database import get_pool, get_redis

router = APIRouter()


class TagOut(BaseModel):
    id: str
    node_id: str
    display_name: str
    description: Optional[str]
    engineering_unit: Optional[str]
    data_type: str
    deadband_value: float
    sample_interval_ms: int
    is_active: bool
    asset_id: Optional[str]


class TagCreate(BaseModel):
    node_id: str
    display_name: str
    description: Optional[str] = None
    engineering_unit: Optional[str] = None
    data_type: str = "Double"
    deadband_value: float = 0.0
    sample_interval_ms: int = 1000
    asset_id: Optional[str] = None


class TagLiveValue(BaseModel):
    tag_id: str
    node_id: str
    value: Optional[float]
    quality: int
    ts: str


@router.get("/", response_model=List[TagOut])
async def list_tags(
    asset_id: Optional[str] = Query(None),
    active_only: bool = Query(True),
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(get_current_user),
):
    where_clauses = ["1=1"]
    params = []
    if active_only:
        where_clauses.append("t.is_active = TRUE")
    if asset_id:
        params.append(asset_id)
        where_clauses.append(f"t.asset_id = ${len(params)}::uuid")

    where = " AND ".join(where_clauses)
    rows = await pool.fetch(
        f"""SELECT id::text, node_id, display_name, description,
                   engineering_unit, data_type, deadband_value,
                   sample_interval_ms, is_active, asset_id::text
            FROM tags t WHERE {where} ORDER BY display_name""",
        *params,
    )
    return [TagOut(**dict(r)) for r in rows]


@router.get("/live", response_model=List[TagLiveValue])
async def get_live_values(
    tag_ids: List[str] = Query(...),
    redis: aioredis.Redis = Depends(get_redis),
    _: UserOut = Depends(get_current_user),
):
    """Fetch latest cached value for multiple tags from Redis."""
    keys = [f"tag:live:{tid}" for tid in tag_ids]
    values = await redis.mget(*keys)
    result = []
    for tid, raw in zip(tag_ids, values):
        if raw:
            data = json.loads(raw)
            result.append(TagLiveValue(**data))
    return result


@router.post("/", response_model=TagOut, status_code=201)
async def create_tag(
    body: TagCreate,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    row = await pool.fetchrow(
        """INSERT INTO tags
           (node_id, display_name, description, engineering_unit, data_type,
            deadband_value, sample_interval_ms, asset_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::uuid)
           RETURNING id::text, node_id, display_name, description, engineering_unit,
                     data_type, deadband_value, sample_interval_ms, is_active, asset_id::text""",
        body.node_id, body.display_name, body.description, body.engineering_unit,
        body.data_type, body.deadband_value, body.sample_interval_ms, body.asset_id,
    )
    return TagOut(**dict(row))


@router.delete("/{tag_id}", status_code=204)
async def deactivate_tag(
    tag_id: str,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    result = await pool.execute(
        "UPDATE tags SET is_active = FALSE WHERE id = $1::uuid", tag_id
    )
    if result == "UPDATE 0":
        raise HTTPException(404, "Tag not found")
