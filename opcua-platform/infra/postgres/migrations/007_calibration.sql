-- ================================================================
-- Gain Calibration — schema
-- Idempotent. Apply with:
--   docker compose exec -T timescaledb psql -U opcua_admin -d opcua \
--     < infra/postgres/migrations/007_calibration.sql
--
-- The source-attributed-setpoint template needs a gain (output-per-unit-of-
-- setting) to prescribe. It can LEARN gain from history — but only if the
-- history contains setting-variation. Real lines run at a fixed setting, so
-- there's nothing to learn from. Calibration solves this: a controlled routine
-- that deliberately steps the setting through several values, measures the
-- response at each, and computes gain by regression. The result is the most
-- trustworthy gain source (a designed experiment, not passive inference).
--
-- Two modes, same tables:
--   manual    — operator steps the setting by hand, enters/reads measured points
--   automated — platform issues setting writes (through the approved write path)
--               and reads back the measured response
-- ================================================================

-- A calibration run for one unit (e.g. nozzle 3) of a problem instance.
CREATE TABLE IF NOT EXISTS calibrations (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    instance_id   UUID NOT NULL REFERENCES problem_instances(id) ON DELETE CASCADE,
    unit_key      VARCHAR(128),                 -- which unit, e.g. 'weight:nozzle=3' (null = whole)
    measurement_tag_id UUID,                    -- the measured output stream (weight)
    setting_tag_id     UUID,                    -- the setting stream/control point
    target_server_id   UUID,                    -- server for automated writes (null for manual)
    mode          VARCHAR(16) NOT NULL DEFAULT 'manual',  -- manual | automated
    status        VARCHAR(16) NOT NULL DEFAULT 'planned', -- planned|running|collecting|computed|applied|failed|cancelled
    -- plan: the setting values to step through, and dwell/samples per step
    plan          JSONB NOT NULL DEFAULT '{}',  -- {steps:[..], dwell_s, samples_per_step, settle_s}
    -- result
    computed_gain DOUBLE PRECISION,
    r_squared     DOUBLE PRECISION,             -- fit quality 0..1
    intercept     DOUBLE PRECISION,
    n_points      INTEGER DEFAULT 0,
    notes         TEXT,
    error         TEXT,
    created_by    VARCHAR(255),
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    completed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_calibrations_instance ON calibrations(instance_id, created_at DESC);

-- Individual measured points collected during a calibration (setting -> measured).
CREATE TABLE IF NOT EXISTS calibration_points (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    calibration_id UUID NOT NULL REFERENCES calibrations(id) ON DELETE CASCADE,
    step_index    INTEGER NOT NULL,             -- which planned step
    setting_value DOUBLE PRECISION NOT NULL,    -- the setting applied
    measured_value DOUBLE PRECISION NOT NULL,   -- the resulting measured output (mean over samples)
    measured_std  DOUBLE PRECISION,             -- spread of the samples
    n_samples     INTEGER DEFAULT 1,
    source        VARCHAR(16) DEFAULT 'manual', -- manual | measured
    created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_calibration_points_run ON calibration_points(calibration_id, step_index);

-- When a calibration is APPLIED, its gain is written into the instance config
-- under action.calibrated_gain_map so the template uses it (highest priority).
-- (No schema change needed for that — it lives in problem_instances.config.)
