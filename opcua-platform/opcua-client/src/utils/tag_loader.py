"""Load active tag configuration from TimescaleDB."""
from __future__ import annotations
from typing import List, Dict
import asyncpg


async def load_tags_from_db(postgres_dsn: str) -> List[Dict]:
    """
    Fetch all active tags with their metadata from the database.
    Returns a list of dicts used by the OPC UA subscription manager.
    """
    dsn = postgres_dsn.replace("postgresql+asyncpg://", "postgresql://")
    conn = await asyncpg.connect(dsn)
    try:
        rows = await conn.fetch("""
            SELECT
                t.id::text       AS tag_id,
                t.node_id,
                t.display_name,
                t.engineering_unit,
                t.data_type,
                t.deadband_value,
                t.deadband_pct,
                t.sample_interval_ms
            FROM tags t
            WHERE t.is_active = TRUE
            ORDER BY t.display_name
        """)
        return [dict(r) for r in rows]
    finally:
        await conn.close()
