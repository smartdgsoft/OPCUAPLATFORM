"""Analytics endpoints — KPIs, OEE, statistical summary, anomaly flags."""
from __future__ import annotations
from datetime import datetime
from typing import List, Optional
import asyncpg
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from src.auth.jwt import UserOut, get_current_user
from src.db.database import get_pool

router = APIRouter()


class TagSummary(BaseModel):
    tag_id: str
    display_name: str
    engineering_unit: Optional[str]
    avg_val: Optional[float]
    min_val: Optional[float]
    max_val: Optional[float]
    std_dev: Optional[float]
    sample_count: int
    first_time: Optional[datetime]
    last_time: Optional[datetime]


class TrendPoint(BaseModel):
    bucket: datetime
    avg_val: Optional[float]
    min_val: Optional[float]
    max_val: Optional[float]


@router.get("/summary", response_model=List[TagSummary])
async def get_summary(
    tag_ids: List[str] = Query(...),
    start: datetime = Query(...),
    end: datetime = Query(...),
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(get_current_user),
):
    """Statistical summary for one or more tags over a time window."""
    rows = await pool.fetch(
        """SELECT
               t.id::text AS tag_id,
               t.display_name,
               t.engineering_unit,
               avg(tv.value_num)    AS avg_val,
               min(tv.value_num)    AS min_val,
               max(tv.value_num)    AS max_val,
               stddev(tv.value_num) AS std_dev,
               count(tv.value_num)  AS sample_count,
               min(tv.time)         AS first_time,
               max(tv.time)         AS last_time
           FROM tag_values tv
           JOIN tags t ON t.id = tv.tag_id
           WHERE tv.tag_id = ANY($1::uuid[])
             AND tv.time BETWEEN $2 AND $3
             AND tv.value_num IS NOT NULL
           GROUP BY t.id, t.display_name, t.engineering_unit
           ORDER BY t.display_name""",
        tag_ids, start, end,
    )
    return [TagSummary(**dict(r)) for r in rows]


@router.get("/trend", response_model=List[TrendPoint])
async def get_trend(
    tag_id: str = Query(...),
    start: datetime = Query(...),
    end: datetime = Query(...),
    bucket_size: str = Query("1 hour", description="TimescaleDB bucket e.g. '5 minutes', '1 hour'"),
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(get_current_user),
):
    """Downsampled trend for charting — dynamic bucket size."""
    rows = await pool.fetch(
        """SELECT
               time_bucket($1::interval, time) AS bucket,
               avg(value_num) AS avg_val,
               min(value_num) AS min_val,
               max(value_num) AS max_val
           FROM tag_values
           WHERE tag_id = $2::uuid
             AND time BETWEEN $3 AND $4
             AND value_num IS NOT NULL
           GROUP BY bucket
           ORDER BY bucket ASC""",
        bucket_size, tag_id, start, end,
    )
    return [TrendPoint(**dict(r)) for r in rows]


@router.get("/anomalies")
async def get_anomalies(
    tag_id: str = Query(...),
    start: datetime = Query(...),
    end: datetime = Query(...),
    z_threshold: float = Query(3.0, description="Z-score threshold for anomaly"),
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(get_current_user),
):
    """Z-score based anomaly detection — returns points beyond threshold."""
    rows = await pool.fetch(
        """WITH stats AS (
               SELECT avg(value_num) AS mu, stddev(value_num) AS sigma
               FROM tag_values
               WHERE tag_id = $1::uuid AND time BETWEEN $2 AND $3
                 AND value_num IS NOT NULL
           )
           SELECT
               tv.time,
               tv.value_num AS value,
               ABS(tv.value_num - stats.mu) / NULLIF(stats.sigma, 0) AS z_score
           FROM tag_values tv, stats
           WHERE tv.tag_id = $1::uuid AND tv.time BETWEEN $2 AND $3
             AND tv.value_num IS NOT NULL
             AND ABS(tv.value_num - stats.mu) / NULLIF(stats.sigma, 0) > $4
           ORDER BY tv.time ASC
           LIMIT 1000""",
        tag_id, start, end, z_threshold,
    )
    return [{"time": r["time"], "value": r["value"], "z_score": round(r["z_score"] or 0, 2)}
            for r in rows]


@router.get("/oee")
async def calculate_oee(
    asset_id: str = Query(...),
    start: datetime = Query(...),
    end: datetime = Query(...),
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(get_current_user),
):
    """
    Overall Equipment Effectiveness = Availability × Performance × Quality.
    Requires tags named 'running_state', 'actual_speed', 'ideal_speed',
    'good_parts', 'total_parts' under the asset.
    Returns a placeholder calculation if tags not found.
    """
    rows = await pool.fetch(
        """SELECT t.display_name, avg(tv.value_num) AS avg_val
           FROM tags t
           JOIN tag_values tv ON tv.tag_id = t.id
           WHERE t.asset_id = $1::uuid
             AND tv.time BETWEEN $2 AND $3
             AND tv.value_num IS NOT NULL
           GROUP BY t.display_name""",
        asset_id, start, end,
    )
    vals = {r["display_name"]: r["avg_val"] for r in rows}

    # Availability
    running = vals.get("running_state", 0.85)
    availability = min(1.0, max(0.0, running if running <= 1 else running / 100))

    # Performance
    actual = vals.get("actual_speed", 0)
    ideal = vals.get("ideal_speed", 1)
    performance = min(1.0, actual / ideal) if ideal > 0 else 0.0

    # Quality
    good = vals.get("good_parts", 0)
    total = vals.get("total_parts", 1)
    quality = good / total if total > 0 else 0.0

    oee = availability * performance * quality
    return {
        "asset_id": asset_id,
        "start": start, "end": end,
        "availability": round(availability * 100, 2),
        "performance": round(performance * 100, 2),
        "quality": round(quality * 100, 2),
        "oee": round(oee * 100, 2),
    }
