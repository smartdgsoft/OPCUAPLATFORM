"""
Historical data queries.
Automatically routes to raw or pre-aggregated views based on time range.
"""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import List, Optional

import asyncpg
from fastapi import APIRouter, Depends, Query, HTTPException
from pydantic import BaseModel

from src.auth.jwt import UserOut, get_current_user
from src.db.database import get_pool

router = APIRouter()


class Resolution(str, Enum):
    raw = "raw"
    min1 = "1min"
    hour1 = "1hour"
    day1 = "1day"
    auto = "auto"


class TagHistoryPoint(BaseModel):
    time: datetime
    avg_val: Optional[float]
    min_val: Optional[float]
    max_val: Optional[float]
    last_val: Optional[float]
    sample_count: Optional[int]


class TagHistoryResponse(BaseModel):
    tag_id: str
    node_id: str
    display_name: str
    engineering_unit: Optional[str]
    resolution: str
    data: List[TagHistoryPoint]


def _choose_table(start: datetime, end: datetime, resolution: Resolution) -> tuple[str, str]:
    """Choose the best aggregate table based on time range."""
    if resolution != Resolution.auto:
        tables = {
            Resolution.raw:   ("tag_values",      "time"),
            Resolution.min1:  ("tag_values_1min",  "bucket"),
            Resolution.hour1: ("tag_values_1hour", "bucket"),
            Resolution.day1:  ("tag_values_1day",  "bucket"),
        }
        return tables[resolution]

    delta_hours = (end - start).total_seconds() / 3600
    if delta_hours <= 3:
        return "tag_values", "time"
    elif delta_hours <= 48:
        return "tag_values_1min", "bucket"
    elif delta_hours <= 720:
        return "tag_values_1hour", "bucket"
    else:
        return "tag_values_1day", "bucket"


@router.get("/{tag_id}", response_model=TagHistoryResponse)
async def get_tag_history(
    tag_id: str,
    start: datetime = Query(..., description="ISO8601 start time"),
    end: datetime = Query(..., description="ISO8601 end time"),
    resolution: Resolution = Query(Resolution.auto),
    limit: int = Query(10000, le=50000),
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(get_current_user),
):
    tag_row = await pool.fetchrow(
        "SELECT id::text, node_id, display_name, engineering_unit FROM tags WHERE id = $1::uuid",
        tag_id,
    )
    if not tag_row:
        raise HTTPException(404, "Tag not found")

    table, time_col = _choose_table(start, end, resolution)

    if table == "tag_values":
        # Raw data
        rows = await pool.fetch(
            f"""SELECT time AS time,
                       value_num AS avg_val,
                       value_num AS min_val,
                       value_num AS max_val,
                       value_num AS last_val,
                       1 AS sample_count
                FROM {table}
                WHERE tag_id = $1::uuid AND time BETWEEN $2 AND $3
                ORDER BY time ASC LIMIT $4""",
            tag_id, start, end, limit,
        )
    else:
        rows = await pool.fetch(
            f"""SELECT {time_col} AS time,
                       avg_val, min_val, max_val, last_val, sample_count
                FROM {table}
                WHERE tag_id = $1::uuid AND {time_col} BETWEEN $2 AND $3
                ORDER BY {time_col} ASC LIMIT $4""",
            tag_id, start, end, limit,
        )

    return TagHistoryResponse(
        tag_id=tag_row["id"],
        node_id=tag_row["node_id"],
        display_name=tag_row["display_name"],
        engineering_unit=tag_row["engineering_unit"],
        resolution=table,
        data=[TagHistoryPoint(**dict(r)) for r in rows],
    )


@router.get("/multi/query", response_model=List[TagHistoryResponse])
async def get_multi_tag_history(
    tag_ids: List[str] = Query(...),
    start: datetime = Query(...),
    end: datetime = Query(...),
    resolution: Resolution = Query(Resolution.auto),
    limit: int = Query(5000, le=20000),
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(get_current_user),
):
    """Fetch history for multiple tags in one request."""
    results = []
    for tag_id in tag_ids:
        r = await get_tag_history(tag_id, start, end, resolution, limit, pool, _)
        results.append(r)
    return results
