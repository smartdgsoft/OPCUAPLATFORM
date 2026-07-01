-- ============================================================
-- Nozzle Giveaway — live demo data for the source-attributed
-- setpoint template (Step 3).
--
-- Creates a 'fills' table simulating a 4-nozzle filling line where:
--   - each nozzle has a fill SETTING (e.g. dwell ms) that varies slightly
--   - WEIGHT = gain * setting + noise, with a per-nozzle gain ~5 g/unit
--   - Nozzle 3 is set a bit low, so it UNDER-fills (target 250g, ~244g)
--
-- Because the setting varies, the template can LEARN the gain from history,
-- then prescribe the corrective setting for nozzle 3.
--
-- Run against the SAME database your SQL connector points at (your platform
-- TimescaleDB is fine for a demo):
--   docker compose exec -T timescaledb psql -U opcua_admin -d opcua < nozzle_demo_setup.sql
-- ============================================================

DROP TABLE IF EXISTS fills;
CREATE TABLE fills (
    ts       TIMESTAMPTZ NOT NULL,
    nozzle   INTEGER     NOT NULL,
    setting  DOUBLE PRECISION NOT NULL,   -- fill setting (e.g. dwell ms)
    weight   DOUBLE PRECISION NOT NULL    -- measured weight (g) from check-weigher
);

-- Generate ~1000 fills per nozzle over the last 48h, 4 nozzles.
-- gain = 5 g per setting-unit. target weight 250 => nominal setting 50.
-- Nozzle 3 runs at setting ~48.8 => ~244g (under-fills, giveaway/reject risk).
INSERT INTO fills (ts, nozzle, setting, weight)
SELECT
    NOW() - (i || ' seconds')::interval           AS ts,
    n                                             AS nozzle,
    s                                             AS setting,
    5.0 * s + (random() - 0.5) * 2.0              AS weight   -- gain 5, small noise
FROM generate_series(0, 3600*48, 48) AS i,        -- one fill per 48s over 48h
LATERAL (SELECT (i / 48) % 4 + 1 AS n) nz,
LATERAL (
    SELECT CASE
        WHEN n = 3 THEN 48.8 + (random()-0.5)*1.2   -- nozzle 3 low + jitter (learnable)
        ELSE            50.0 + (random()-0.5)*1.2    -- others on target + jitter
    END AS s
) st;

CREATE INDEX idx_fills_ts ON fills(ts);

-- sanity: per-nozzle average weight (nozzle 3 should be ~244, others ~250)
SELECT nozzle, round(avg(weight)::numeric,1) AS avg_weight,
       round(avg(setting)::numeric,2) AS avg_setting, count(*) AS n
FROM fills GROUP BY nozzle ORDER BY nozzle;
