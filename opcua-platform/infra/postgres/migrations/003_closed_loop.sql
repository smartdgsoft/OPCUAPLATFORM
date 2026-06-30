-- ================================================================
-- Closed-Loop ADVISORY module — schema
-- Idempotent migration. Apply with:
--   docker compose exec -T timescaledb psql -U opcua_admin -d opcua \
--     < infra/postgres/migrations/003_closed_loop.sql
--
-- SAFETY MODEL (enforced in architecture, not just convention):
--   This module RECOMMENDS setpoints. It NEVER actuates. Recommendations
--   are written as 'pending' and require human approval. On approval, the
--   actuation goes through the EXISTING write-control path (FEATURE_WRITE +
--   RBAC + min/max clamps + write audit). The advisory engine has no write
--   path to OPC UA servers.
-- ================================================================

-- An advisory rule attached to a twin. When its trigger condition holds,
-- it proposes a recommended setpoint for a target (writable) tag.
CREATE TABLE IF NOT EXISTS cl_rules (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    twin_id       UUID NOT NULL REFERENCES twin_definitions(id) ON DELETE CASCADE,
    name          VARCHAR(255) NOT NULL,
    description   TEXT,
    enabled       BOOLEAN NOT NULL DEFAULT TRUE,

    -- TRIGGER: evaluate a source signal/tag against a condition.
    -- trigger_type: 'threshold' (source compared to a value) or
    -- 'anomaly' (fire when the twin has a recent anomaly output on the source).
    trigger_type   VARCHAR(32) NOT NULL DEFAULT 'threshold',
    source_tag_id  UUID REFERENCES tags(id) ON DELETE SET NULL,
    -- for threshold: operator + value (e.g. '>' 26.0)
    trigger_op     VARCHAR(4),                 -- '>' '<' '>=' '<=' '==' '!='
    trigger_value  DOUBLE PRECISION,

    -- TARGET: the writable tag the recommendation would set.
    target_tag_id  UUID REFERENCES tags(id) ON DELETE SET NULL,
    target_server_id UUID,                     -- which server the target lives on

    -- RECOMMENDATION: how to compute the proposed setpoint.
    -- action_type: 'set_value' (propose a fixed value) or
    -- 'adjust' (propose current_target + delta) or
    -- 'proportional' (target moves to bring source toward source_target).
    action_type    VARCHAR(32) NOT NULL DEFAULT 'set_value',
    action_value   DOUBLE PRECISION,           -- the value or delta
    source_target  DOUBLE PRECISION,           -- desired source value (proportional)
    gain           DOUBLE PRECISION DEFAULT 1.0, -- proportional gain

    -- SAFETY CLAMPS — always applied to any proposed value, and passed to the
    -- write path as min_value/max_value on approval.
    safety_min     DOUBLE PRECISION,
    safety_max     DOUBLE PRECISION,
    max_step       DOUBLE PRECISION,           -- max change per recommendation

    -- GOVERNANCE
    requires_approval BOOLEAN NOT NULL DEFAULT TRUE,  -- advisory default; cannot be bypassed in UI
    cooldown_s     INTEGER NOT NULL DEFAULT 300,      -- min seconds between recs for this rule
    severity       VARCHAR(16) DEFAULT 'warning',

    created_at     TIMESTAMPTZ DEFAULT NOW(),
    updated_at     TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(twin_id, name)
);
CREATE INDEX IF NOT EXISTS idx_cl_rules_twin ON cl_rules(twin_id);

-- A generated recommendation. Lifecycle: pending -> approved -> applied,
-- or pending -> rejected. 'applied' records the write request_id from the
-- existing write path, closing the audit loop.
CREATE TABLE IF NOT EXISTS cl_recommendations (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    rule_id         UUID NOT NULL REFERENCES cl_rules(id) ON DELETE CASCADE,
    twin_id         UUID NOT NULL REFERENCES twin_definitions(id) ON DELETE CASCADE,

    -- what was observed
    source_tag_id   UUID,
    source_value    DOUBLE PRECISION,
    -- what is proposed
    target_tag_id   UUID,
    target_server_id UUID,
    current_value   DOUBLE PRECISION,          -- target's value at recommendation time
    recommended_value DOUBLE PRECISION,        -- post-clamp proposed setpoint
    clamped         BOOLEAN DEFAULT FALSE,      -- whether safety clamps altered it

    severity        VARCHAR(16),
    title           VARCHAR(255),
    detail          TEXT,
    rationale       JSONB NOT NULL DEFAULT '{}',

    -- governance / lifecycle
    status          VARCHAR(16) NOT NULL DEFAULT 'pending', -- pending|approved|rejected|applied|failed|expired
    decided_by      VARCHAR(255),
    decided_at      TIMESTAMPTZ,
    decision_note   TEXT,
    write_request_id VARCHAR(64),              -- links to write-control audit
    applied_at      TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,

    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cl_recs_twin ON cl_recommendations(twin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cl_recs_status ON cl_recommendations(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cl_recs_rule ON cl_recommendations(rule_id, created_at DESC);
