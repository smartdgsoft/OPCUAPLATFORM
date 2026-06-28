"""Asset hierarchy CRUD."""
from __future__ import annotations
from typing import List, Optional
import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from src.auth.jwt import UserOut, get_current_user, require_roles
from src.db.database import get_pool

router = APIRouter()


class AssetOut(BaseModel):
    id: str
    parent_id: Optional[str]
    level_id: int
    name: str
    description: Optional[str]
    location: Optional[str]


class AssetCreate(BaseModel):
    parent_id: Optional[str] = None
    level_id: int
    name: str
    description: Optional[str] = None
    location: Optional[str] = None


@router.get("/", response_model=List[AssetOut])
async def list_assets(
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(get_current_user),
):
    rows = await pool.fetch(
        "SELECT id::text, parent_id::text, level_id, name, description, location FROM assets ORDER BY level_id, name"
    )
    return [AssetOut(**dict(r)) for r in rows]


@router.get("/{asset_id}/tags")
async def get_asset_tags(
    asset_id: str,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(get_current_user),
):
    rows = await pool.fetch(
        """SELECT id::text, node_id, display_name, engineering_unit, is_active
           FROM tags WHERE asset_id = $1::uuid ORDER BY display_name""",
        asset_id,
    )
    return [dict(r) for r in rows]


@router.post("/", response_model=AssetOut, status_code=201)
async def create_asset(
    body: AssetCreate,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    row = await pool.fetchrow(
        """INSERT INTO assets (parent_id, level_id, name, description, location)
           VALUES ($1::uuid, $2, $3, $4, $5)
           RETURNING id::text, parent_id::text, level_id, name, description, location""",
        body.parent_id, body.level_id, body.name, body.description, body.location,
    )
    return AssetOut(**dict(row))
