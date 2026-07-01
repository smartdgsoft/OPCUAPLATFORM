-- ================================================================
-- Problem Template Engine — schema
-- Idempotent migration. Apply with:
--   docker compose exec -T timescaledb psql -U opcua_admin -d opcua \
--     < infra/postgres/migrations/005_problem_templates.sql
--
-- A Problem Template is a declarative description of a problem's slots
-- (inputs, attribution, model, objective, action). The engine reads an
-- INSTANCE of a template (template + concrete stream bindings + config) and
-- runs it: gather inputs -> (attribute) -> learn/refresh -> evaluate ->
-- emit detect|predict|prescribe -> (if action) recommendation + approval.
--
-- Two starter templates ship as code (condition_monitoring,
-- source_attributed_setpoint); this schema stores INSTANCES the user creates.
-- ================================================================

-- A configured instance of a problem template, bound to concrete streams.
CREATE TABLE IF NOT EXISTS problem_instances (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    template_key  VARCHAR(64)  NOT NULL,   -- 'condition_monitoring' | 'source_attributed_setpoint' | ...
    name          VARCHAR(255) NOT NULL,
    asset_id      UUID REFERENCES assets(id) ON DELETE SET NULL,
    enabled       BOOLEAN NOT NULL DEFAULT TRUE,

    -- the declarative slots, as JSON (validated by the template at run time)
    -- inputs:      [ { tag_id, role } ]          role: measurement|setting|context
    -- attribution: { enabled, method, unit_count, ... }   (optional)
    -- model:       { method, train_window_hours, confidence_required, ... }
    -- objective:   { type, target, bounds, ... }   type: detect|predict|prescribe
    -- action:      { target_tag_id, target_server_id, gain_source, clamps, ... } (optional)
    config        JSONB NOT NULL DEFAULT '{}',

    -- maturity: honest state of what the model can do given available data.
    -- 'cold_start' (no/low history) | 'warming' (accumulating) | 'mature'
    maturity      VARCHAR(16) NOT NULL DEFAULT 'cold_start',
    confidence    DOUBLE PRECISION DEFAULT 0.0,   -- 0..1 current overall confidence

    eval_interval_s INTEGER NOT NULL DEFAULT 60,
    last_eval_at  TIMESTAMPTZ,
    last_status   VARCHAR(32),
    last_error    TEXT,

    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(name)
);
CREATE INDEX IF NOT EXISTS idx_problem_instances_template ON problem_instances(template_key);

-- Learned model state per instance (the template's model slot output).
-- Stored as portable JSON parameters, versioned, like pred_model_versions.
CREATE TABLE IF NOT EXISTS problem_model_state (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    instance_id   UUID NOT NULL REFERENCES problem_instances(id) ON DELETE CASCADE,
    version       INTEGER NOT NULL DEFAULT 1,
    parameters    JSONB NOT NULL DEFAULT '{}',
    metrics       JSONB NOT NULL DEFAULT '{}',
    sample_count  INTEGER DEFAULT 0,
    trained_at    TIMESTAMPTZ DEFAULT NOW(),
    is_active     BOOLEAN DEFAULT TRUE,
    UNIQUE(instance_id, version)
);
CREATE INDEX IF NOT EXISTS idx_problem_model_instance ON problem_model_state(instance_id, version DESC);

-- Outputs produced by an instance evaluation (detect/predict/prescribe).
-- These mirror into twin_outputs when an asset/twin is linked; this table is
-- the template engine's own record with richer per-problem detail.
CREATE TABLE IF NOT EXISTS problem_outputs (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    instance_id   UUID NOT NULL REFERENCES problem_instances(id) ON DELETE CASCADE,
    output_type   VARCHAR(32) NOT NULL,   -- detect | predict | prescribe | health
    severity      VARCHAR(16),            -- info | warning | critical
    unit_key      VARCHAR(128),           -- which attributed unit (e.g. nozzle=3), null = whole
    title         VARCHAR(255),
    detail        TEXT,
    value         DOUBLE PRECISION,       -- prescribed setpoint | predicted metric | score
    confidence    DOUBLE PRECISION,
    maturity      VARCHAR(16),
    payload       JSONB NOT NULL DEFAULT '{}',
    -- if this output is an actionable prescription, link to a recommendation
    recommendation_id UUID,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_problem_outputs_instance ON problem_outputs(instance_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_problem_outputs_type ON problem_outputs(output_type, created_at DESC);
