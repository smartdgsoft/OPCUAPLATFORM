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


class AssetUpdate(BaseModel):
    parent_id: Optional[str] = None
    level_id: Optional[int] = None
    name: Optional[str] = None
    description: Optional[str] = None
    location: Optional[str] = None


class AssetLevel(BaseModel):
    id: int
    name: str


class TagMap(BaseModel):
    tag_id: str


@router.get("/", response_model=List[AssetOut])
async def list_assets(
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(get_current_user),
):
    rows = await pool.fetch(
        "SELECT id::text, parent_id::text, level_id, name, description, location FROM assets ORDER BY level_id, name"
    )
    return [AssetOut(**dict(r)) for r in rows]


@router.get("/levels", response_model=List[AssetLevel])
async def list_levels(
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(get_current_user),
):
    rows = await pool.fetch("SELECT id, name FROM asset_levels ORDER BY id")
    return [AssetLevel(**dict(r)) for r in rows]


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


@router.put("/{asset_id}", response_model=AssetOut)
async def update_asset(
    asset_id: str,
    body: AssetUpdate,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    existing = await pool.fetchrow(
        "SELECT id::text, parent_id::text, level_id, name, description, location FROM assets WHERE id = $1::uuid",
        asset_id,
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Asset not found")

    # Prevent an asset from being its own parent.
    if body.parent_id and body.parent_id == asset_id:
        raise HTTPException(status_code=400, detail="An asset cannot be its own parent")

    merged = dict(existing)
    for field in ("parent_id", "level_id", "name", "description", "location"):
        val = getattr(body, field)
        if val is not None:
            merged[field] = val

    row = await pool.fetchrow(
        """UPDATE assets
           SET parent_id = $2::uuid, level_id = $3, name = $4,
               description = $5, location = $6
           WHERE id = $1::uuid
           RETURNING id::text, parent_id::text, level_id, name, description, location""",
        asset_id, merged["parent_id"], merged["level_id"],
        merged["name"], merged["description"], merged["location"],
    )
    return AssetOut(**dict(row))


@router.delete("/{asset_id}", status_code=204)
async def delete_asset(
    asset_id: str,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    # Block deletion if the asset has children (avoid orphaning the tree).
    child = await pool.fetchval(
        "SELECT 1 FROM assets WHERE parent_id = $1::uuid LIMIT 1", asset_id
    )
    if child:
        raise HTTPException(
            status_code=409,
            detail="Asset has child assets. Delete or reassign them first.",
        )
    # Unmap any tags pointing at this asset, then delete it.
    await pool.execute(
        "UPDATE tags SET asset_id = NULL WHERE asset_id = $1::uuid", asset_id
    )
    result = await pool.execute("DELETE FROM assets WHERE id = $1::uuid", asset_id)
    if result.endswith("0"):
        raise HTTPException(status_code=404, detail="Asset not found")
    return None


@router.post("/{asset_id}/tags", status_code=204)
async def map_tag_to_asset(
    asset_id: str,
    body: TagMap,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    asset = await pool.fetchval("SELECT 1 FROM assets WHERE id = $1::uuid", asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    result = await pool.execute(
        "UPDATE tags SET asset_id = $1::uuid WHERE id = $2::uuid",
        asset_id, body.tag_id,
    )
    if result.endswith("0"):
        raise HTTPException(status_code=404, detail="Tag not found")
    return None


@router.delete("/{asset_id}/tags/{tag_id}", status_code=204)
async def unmap_tag_from_asset(
    asset_id: str,
    tag_id: str,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(require_roles("ADMIN", "ENGINEER")),
):
    result = await pool.execute(
        "UPDATE tags SET asset_id = NULL WHERE id = $1::uuid AND asset_id = $2::uuid",
        tag_id, asset_id,
    )
    if result.endswith("0"):
        raise HTTPException(status_code=404, detail="Tag not mapped to this asset")
    return None
