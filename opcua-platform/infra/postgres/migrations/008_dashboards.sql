-- ================================================================
-- Dashboards — config-driven operations screens
-- Idempotent. Apply with:
--   docker compose exec -T timescaledb psql -U opcua_admin -d opcua \
--     < infra/postgres/migrations/008_dashboards.sql
--
-- A dashboard is a stored CONFIG, not hardcoded UI. The entire layout —
-- widgets, their grid positions, and each widget's data binding — lives in a
-- single JSONB column so the schema NEVER changes as widget types evolve.
-- The frontend renders any such config; a new plant/line is just a new row.
--
-- layout JSON shape (the contract the frontend depends on):
--   {
--     "grid": { "cols": 12, "row_height": 40 },
--     "widgets": [{
--        "id": "w1",
--        "type": "kpi|gauge|sparkline|trend|alarm_list|equipment_list|batch_bar|schematic|text",
--        "title": "Viscosity",
--        "pos": { "x":0, "y":0, "w":2, "h":3 },
--        "binding": {
--           "mode": "live|history|alarms|assets|static",
--           "tag_id": "...", "stream_key": "...",       -- both supported; tag_id wins, stream_key is portable fallback
--           "tag_ids": [...], "stream_keys": [...],      -- multi (trend)
--           "resolution": "raw|min1|hour1|day1", "range": "1H|6H|24H|7D",
--           "filter": { ... },                            -- alarms/assets
--           "spec": { "min":4500, "max":5200, "warn":..., "crit":..., "unit":"cP" }
--        },
--        "demo": { "value":4850, "series":[...], "rows":[...] },   -- per-widget fallback
--        "options": { "color":"#e8a830", "decimals":0, ... }       -- schematic stores nodes/edges here
--     }]
--   }
-- ================================================================

CREATE TABLE IF NOT EXISTS dashboards (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name         VARCHAR(200) NOT NULL,
    description  TEXT,
    demo_mode    BOOLEAN NOT NULL DEFAULT FALSE,   -- global fallback: force unbound widgets to demo
    layout       JSONB NOT NULL DEFAULT '{"grid":{"cols":12,"row_height":40},"widgets":[]}',
    is_default   BOOLEAN NOT NULL DEFAULT FALSE,   -- the landing dashboard
    created_by   VARCHAR(255),
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dashboards_default ON dashboards(is_default) WHERE is_default;
