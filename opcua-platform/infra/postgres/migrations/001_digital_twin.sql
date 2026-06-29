-- ================================================================
-- Digital Twin module — schema migration
-- Idempotent: safe to run repeatedly on an existing database.
-- Apply with:
--   docker compose exec -T timescaledb psql -U opcua_admin -d opcua \
--     < infra/postgres/migrations/001_digital_twin.sql
-- ================================================================

-- A twin definition is attached to one asset and selects a model type.
CREATE TABLE IF NOT EXISTS twin_definitions (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    asset_id     UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    name         VARCHAR(255) NOT NULL,
    description  TEXT,
    -- 'status' is the built-in tier. On-demand modules register their own
    -- type strings here (e.g. 'adhesive_predictive', 'closed_loop_advisory').
    model_type   VARCHAR(64)  NOT NULL DEFAULT 'status',
    enabled      BOOLEAN      NOT NULL DEFAULT TRUE,
    config       JSONB        NOT NULL DEFAULT '{}',
    created_at   TIMESTAMPTZ  DEFAULT NOW(),
    updated_at   TIMESTAMPTZ  DEFAULT NOW(),
    UNIQUE(asset_id, name)
);
CREATE INDEX IF NOT EXISTS idx_twin_defs_asset ON twin_definitions(asset_id);

-- Each twinned signal = a tag plus its role and expected operating envelope.
-- envelope_mode: 'manual' (operator-entered bounds) or 'learned'
-- (bounds derived from history by the evaluator).
CREATE TABLE IF NOT EXISTS twin_signals (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    twin_id        UUID NOT NULL REFERENCES twin_definitions(id) ON DELETE CASCADE,
    tag_id         UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    -- Freeform role: temperature, pressure, viscosity, flow, humidity,
    -- status, filter_dp, ... anything. UI styles known roles, others generic.
    role           VARCHAR(64),
    label          VARCHAR(255),
    unit           VARCHAR(50),
    envelope_mode  VARCHAR(16) NOT NULL DEFAULT 'manual',  -- manual | learned

    -- Manual envelope bounds (used when envelope_mode='manual').
    manual_min     DOUBLE PRECISION,
    manual_max     DOUBLE PRECISION,
    manual_target  DOUBLE PRECISION,
    -- Optional warning band as a fraction of the min..max span (0..0.5).
    -- e.g. 0.1 => values within 10% of a bound are 'warning' before 'bad'.
    warn_fraction  DOUBLE PRECISION DEFAULT 0.1,

    -- Learned envelope configuration (used when envelope_mode='learned').
    -- method: 'sigma' (mean ± k*std) or 'percentile' (p_low..p_high).
    learn_method      VARCHAR(16) DEFAULT 'sigma',
    learn_window_hours INTEGER    DEFAULT 168,   -- baseline lookback (7 days)
    learn_k            DOUBLE PRECISION DEFAULT 3.0,   -- for 'sigma'
    learn_p_low        DOUBLE PRECISION DEFAULT 1.0,   -- for 'percentile'
    learn_p_high       DOUBLE PRECISION DEFAULT 99.0,  -- for 'percentile'

    -- Last learned bounds, written back by the evaluator.
    learned_min        DOUBLE PRECISION,
    learned_max        DOUBLE PRECISION,
    learned_target     DOUBLE PRECISION,
    learned_at         TIMESTAMPTZ,
    learned_sample_count INTEGER,

    sort_order     INTEGER DEFAULT 0,
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(twin_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_twin_signals_twin ON twin_signals(twin_id);
CREATE INDEX IF NOT EXISTS idx_twin_signals_tag  ON twin_signals(tag_id);

-- Outputs written by on-demand modules (predictive / closed-loop) and read
-- by the UI's "Module Outputs" panel. The status tier does not write here;
-- this table is the documented seam for plugged-in modules.
CREATE TABLE IF NOT EXISTS twin_outputs (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    twin_id      UUID NOT NULL REFERENCES twin_definitions(id) ON DELETE CASCADE,
    module       VARCHAR(64) NOT NULL,        -- which module produced this
    output_type  VARCHAR(64) NOT NULL,        -- prediction | anomaly | recommendation | health
    -- Optional target tag for a recommendation (e.g. suggested setpoint).
    tag_id       UUID REFERENCES tags(id) ON DELETE SET NULL,
    severity     VARCHAR(16),                 -- info | warning | critical
    title        VARCHAR(255),
    detail       TEXT,
    payload      JSONB NOT NULL DEFAULT '{}', -- numbers, horizons, setpoints...
    -- For closed-loop recommendations routed through the approval gate.
    requires_approval BOOLEAN DEFAULT FALSE,
    approved          BOOLEAN,
    approved_by       VARCHAR(255),
    created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_twin_outputs_twin ON twin_outputs(twin_id, created_at DESC);
