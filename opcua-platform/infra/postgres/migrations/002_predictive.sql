-- ================================================================
-- Predictive Module — model registry & lifecycle schema
-- Idempotent migration. Apply with:
--   docker compose exec -T timescaledb psql -U opcua_admin -d opcua \
--     < infra/postgres/migrations/002_predictive.sql
--
-- Backbone for an enterprise predictive module: every model is
-- versioned, reproducible, auditable, and assigned per-twin. Detection
-- methods are pluggable (univariate, multivariate, forecast, rul) behind
-- a common interface; this schema is method-agnostic.
-- ================================================================

-- A model definition: one configured predictive model attached to a twin.
-- method identifies the pluggable detector. config holds method-specific
-- parameters (window sizes, thresholds, which signals, etc).
CREATE TABLE IF NOT EXISTS pred_models (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    twin_id       UUID NOT NULL REFERENCES twin_definitions(id) ON DELETE CASCADE,
    name          VARCHAR(255) NOT NULL,
    -- pluggable detector key: 'univariate_drift' | 'multivariate' |
    -- 'forecast' | 'rul' | (future methods)
    method        VARCHAR(64)  NOT NULL,
    description   TEXT,
    enabled       BOOLEAN      NOT NULL DEFAULT TRUE,
    -- method-specific configuration (thresholds, windows, signal selection)
    config        JSONB        NOT NULL DEFAULT '{}',
    -- scoring cadence + optional scheduled retrain
    score_interval_s   INTEGER  NOT NULL DEFAULT 30,
    retrain_cron       VARCHAR(64),          -- null = manual retrain only
    -- training data window (hours of history used to fit a version)
    train_window_hours INTEGER  NOT NULL DEFAULT 168,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(twin_id, name)
);
CREATE INDEX IF NOT EXISTS idx_pred_models_twin ON pred_models(twin_id);

-- A trained, versioned model artifact. Parameters are stored as JSON
-- (means, stds, covariance, coefficients, thresholds...) so a version is
-- fully reproducible and portable without binary blobs. status controls
-- the lifecycle; exactly one version per model should be 'active'.
CREATE TABLE IF NOT EXISTS pred_model_versions (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    model_id         UUID NOT NULL REFERENCES pred_models(id) ON DELETE CASCADE,
    version          INTEGER NOT NULL,           -- monotonic per model
    status           VARCHAR(16) NOT NULL DEFAULT 'trained', -- trained|active|retired|failed
    -- learned parameters (method-specific), reproducible
    parameters       JSONB NOT NULL DEFAULT '{}',
    -- training provenance
    trained_at       TIMESTAMPTZ DEFAULT NOW(),
    trained_by       VARCHAR(255),
    train_start      TIMESTAMPTZ,
    train_end        TIMESTAMPTZ,
    train_sample_count INTEGER,
    -- quality metrics from training/validation (method-specific)
    metrics          JSONB NOT NULL DEFAULT '{}',
    notes            TEXT,
    UNIQUE(model_id, version)
);
CREATE INDEX IF NOT EXISTS idx_pred_versions_model ON pred_model_versions(model_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_pred_versions_active
    ON pred_model_versions(model_id) WHERE status = 'active';

-- Full audit trail: every lifecycle event (train, activate, rollback,
-- retire, config change, score-batch). Enterprise governance requirement.
CREATE TABLE IF NOT EXISTS pred_audit (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    model_id     UUID REFERENCES pred_models(id) ON DELETE CASCADE,
    version_id   UUID REFERENCES pred_model_versions(id) ON DELETE SET NULL,
    event        VARCHAR(64) NOT NULL,    -- trained|activated|rolled_back|retired|config_changed|scored|error
    actor        VARCHAR(255),            -- user or 'system'
    detail       TEXT,
    payload      JSONB NOT NULL DEFAULT '{}',
    created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pred_audit_model ON pred_audit(model_id, created_at DESC);

-- Model self-monitoring: track input drift so we know when a live model
-- is no longer valid for the current process (triggers a retrain).
CREATE TABLE IF NOT EXISTS pred_model_drift (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    model_id     UUID NOT NULL REFERENCES pred_models(id) ON DELETE CASCADE,
    version_id   UUID REFERENCES pred_model_versions(id) ON DELETE SET NULL,
    drift_score  DOUBLE PRECISION,        -- 0 = identical to training distribution
    drifted      BOOLEAN DEFAULT FALSE,
    detail       JSONB NOT NULL DEFAULT '{}',
    created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pred_drift_model ON pred_model_drift(model_id, created_at DESC);
