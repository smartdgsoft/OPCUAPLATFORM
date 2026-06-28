-- ================================================================
-- OPC UA Platform — TimescaleDB Schema
-- ================================================================

-- Enable TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ────────────────────────────────────────────
-- Asset hierarchy (ISA-95 inspired)
-- ────────────────────────────────────────────
CREATE TABLE asset_levels (
    id          SMALLINT PRIMARY KEY,
    name        VARCHAR(50) NOT NULL  -- Enterprise, Site, Area, WorkCenter, WorkUnit
);
INSERT INTO asset_levels VALUES (1,'Enterprise'),(2,'Site'),(3,'Area'),(4,'WorkCenter'),(5,'WorkUnit');

CREATE TABLE assets (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    parent_id   UUID REFERENCES assets(id),
    level_id    SMALLINT NOT NULL REFERENCES asset_levels(id),
    name        VARCHAR(255) NOT NULL,
    description TEXT,
    location    VARCHAR(255),
    metadata    JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_assets_parent ON assets(parent_id);
CREATE INDEX idx_assets_level  ON assets(level_id);

-- ────────────────────────────────────────────
-- Tag / node registry
-- ────────────────────────────────────────────
CREATE TABLE tags (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    asset_id        UUID REFERENCES assets(id),
    node_id         VARCHAR(512) NOT NULL,        -- OPC UA NodeId e.g. ns=2;i=1001
    display_name    VARCHAR(255) NOT NULL,
    description     TEXT,
    engineering_unit VARCHAR(50),                 -- °C, bar, rpm, kWh ...
    data_type       VARCHAR(50) DEFAULT 'Double', -- Double, Float, Int32, Bool, String
    deadband_value  DOUBLE PRECISION DEFAULT 0.0, -- absolute deadband
    deadband_pct    DOUBLE PRECISION DEFAULT 0.0, -- percentage deadband
    sample_interval_ms INTEGER DEFAULT 1000,
    is_active       BOOLEAN DEFAULT TRUE,
    tags_meta       JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(node_id)
);

CREATE INDEX idx_tags_asset    ON tags(asset_id);
CREATE INDEX idx_tags_node_id  ON tags(node_id);
CREATE INDEX idx_tags_active   ON tags(is_active) WHERE is_active = TRUE;

-- ────────────────────────────────────────────
-- Raw tag values — hypertable (time series core)
-- ────────────────────────────────────────────
CREATE TABLE tag_values (
    time            TIMESTAMPTZ NOT NULL,
    tag_id          UUID NOT NULL REFERENCES tags(id),
    value_num       DOUBLE PRECISION,
    value_bool      BOOLEAN,
    value_str       TEXT,
    quality         SMALLINT DEFAULT 192,   -- 192 = OPC UA Good
    source_timestamp TIMESTAMPTZ
);

-- Convert to hypertable, partition by 1 day
SELECT create_hypertable('tag_values', 'time',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists => TRUE
);

-- Compress chunks older than 7 days
ALTER TABLE tag_values SET (
    timescaledb.compress,
    timescaledb.compress_orderby = 'time DESC',
    timescaledb.compress_segmentby = 'tag_id'
);
SELECT add_compression_policy('tag_values', INTERVAL '7 days');

-- Retention: drop raw data older than 2 years
SELECT add_retention_policy('tag_values', INTERVAL '2 years');

-- Indexes on hypertable
CREATE INDEX idx_tv_tag_time ON tag_values(tag_id, time DESC);

-- ────────────────────────────────────────────
-- Continuous aggregates — 1-minute, 1-hour, 1-day
-- ────────────────────────────────────────────
CREATE MATERIALIZED VIEW tag_values_1min
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 minute', time) AS bucket,
    tag_id,
    avg(value_num)  AS avg_val,
    min(value_num)  AS min_val,
    max(value_num)  AS max_val,
    last(value_num, time) AS last_val,
    count(*)        AS sample_count
FROM tag_values
WHERE value_num IS NOT NULL
GROUP BY 1, 2
WITH NO DATA;

SELECT add_continuous_aggregate_policy('tag_values_1min',
    start_offset => INTERVAL '10 minutes',
    end_offset   => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute'
);

CREATE MATERIALIZED VIEW tag_values_1hour
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', bucket) AS bucket,
    tag_id,
    avg(avg_val)   AS avg_val,
    min(min_val)   AS min_val,
    max(max_val)   AS max_val,
    last(last_val, bucket) AS last_val,
    sum(sample_count) AS sample_count
FROM tag_values_1min
GROUP BY 1, 2
WITH NO DATA;

SELECT add_continuous_aggregate_policy('tag_values_1hour',
    start_offset => INTERVAL '2 hours',
    end_offset   => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour'
);

CREATE MATERIALIZED VIEW tag_values_1day
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 day', bucket) AS bucket,
    tag_id,
    avg(avg_val)   AS avg_val,
    min(min_val)   AS min_val,
    max(max_val)   AS max_val,
    last(last_val, bucket) AS last_val,
    sum(sample_count) AS sample_count
FROM tag_values_1hour
GROUP BY 1, 2
WITH NO DATA;

SELECT add_continuous_aggregate_policy('tag_values_1day',
    start_offset => INTERVAL '2 days',
    end_offset   => INTERVAL '1 day',
    schedule_interval => INTERVAL '1 day'
);

-- ────────────────────────────────────────────
-- Alarm definitions & events
-- ────────────────────────────────────────────
CREATE TABLE alarm_definitions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tag_id          UUID NOT NULL REFERENCES tags(id),
    name            VARCHAR(255) NOT NULL,
    severity        SMALLINT NOT NULL DEFAULT 500, -- 0-1000, OPC UA convention
    condition_type  VARCHAR(50) NOT NULL,          -- HIGH, HIGH_HIGH, LOW, LOW_LOW, DEVIATION, BOOL
    limit_value     DOUBLE PRECISION,
    deadband        DOUBLE PRECISION DEFAULT 0,
    message         TEXT,
    is_active       BOOLEAN DEFAULT TRUE,
    notify_email    TEXT[],
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE alarm_events (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    alarm_def_id    UUID NOT NULL REFERENCES alarm_definitions(id),
    tag_id          UUID NOT NULL REFERENCES tags(id),
    triggered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cleared_at      TIMESTAMPTZ,
    ack_at          TIMESTAMPTZ,
    ack_by          VARCHAR(255),
    trigger_value   DOUBLE PRECISION,
    severity        SMALLINT,
    message         TEXT,
    state           VARCHAR(20) DEFAULT 'ACTIVE'  -- ACTIVE | ACKNOWLEDGED | CLEARED
);

CREATE INDEX idx_alarm_events_state ON alarm_events(state) WHERE state != 'CLEARED';
CREATE INDEX idx_alarm_events_time  ON alarm_events(triggered_at DESC);

-- ────────────────────────────────────────────
-- Users & RBAC
-- ────────────────────────────────────────────
CREATE TABLE roles (
    id      SMALLINT PRIMARY KEY,
    name    VARCHAR(50) UNIQUE NOT NULL  -- ADMIN, ENGINEER, OPERATOR, VIEWER
);
INSERT INTO roles VALUES (1,'ADMIN'),(2,'ENGINEER'),(3,'OPERATOR'),(4,'VIEWER');

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email           VARCHAR(255) UNIQUE NOT NULL,
    username        VARCHAR(100) UNIQUE NOT NULL,
    hashed_password VARCHAR(255) NOT NULL,
    full_name       VARCHAR(255),
    role_id         SMALLINT NOT NULL DEFAULT 4 REFERENCES roles(id),
    is_active       BOOLEAN DEFAULT TRUE,
    last_login      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Default admin (password: Admin@123 — CHANGE IN PRODUCTION)
INSERT INTO users (email, username, hashed_password, full_name, role_id)
VALUES (
    'admin@opcua.local',
    'admin',
    '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQyCgaJ5BnSomCvhJxCslL.Iy',
    'System Administrator',
    1
);

-- ────────────────────────────────────────────
-- Audit log
-- ────────────────────────────────────────────
CREATE TABLE audit_log (
    id          BIGSERIAL,
    time        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_id     UUID REFERENCES users(id),
    action      VARCHAR(100) NOT NULL,
    resource    VARCHAR(255),
    detail      JSONB,
    ip_address  INET
);
SELECT create_hypertable('audit_log', 'time', if_not_exists => TRUE);

-- ────────────────────────────────────────────
-- Seed sample assets and tags for demo
-- ────────────────────────────────────────────
INSERT INTO assets (id, level_id, name, description) VALUES
  ('11111111-0000-0000-0000-000000000001', 1, 'ACME Manufacturing', 'Enterprise root'),
  ('11111111-0000-0000-0000-000000000002', 2, 'Plant Alpha',  'Main production plant');

INSERT INTO assets (parent_id, level_id, name, description) VALUES
  ('11111111-0000-0000-0000-000000000002', 3, 'Assembly Line 1', 'Primary assembly'),
  ('11111111-0000-0000-0000-000000000002', 3, 'Boiler Room',     'Steam generation');

INSERT INTO tags (node_id, display_name, engineering_unit, data_type, sample_interval_ms,
                  asset_id, description)
SELECT
  'ns=2;i=' || (1000 + g)::text,
  CASE g
    WHEN 1 THEN 'Motor Speed'
    WHEN 2 THEN 'Inlet Temperature'
    WHEN 3 THEN 'Outlet Pressure'
    WHEN 4 THEN 'Power Consumption'
    WHEN 5 THEN 'Valve Position'
  END,
  CASE g
    WHEN 1 THEN 'rpm'
    WHEN 2 THEN '°C'
    WHEN 3 THEN 'bar'
    WHEN 4 THEN 'kW'
    WHEN 5 THEN '%'
  END,
  'Double',
  1000,
  (SELECT id FROM assets WHERE name = 'Assembly Line 1' LIMIT 1),
  'Demo tag ' || g::text
FROM generate_series(1,5) g;

-- ================================================================
-- WRITE & METHOD EXTENSIONS (added for full-control mode)
-- ================================================================

-- ── Multi-server support ──────────────────────────────────────────────────
CREATE TABLE opc_servers (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                 VARCHAR(255) NOT NULL,
    endpoint_url         VARCHAR(512) NOT NULL,
    security_mode        VARCHAR(50)  DEFAULT 'None',
    security_policy      VARCHAR(100) DEFAULT 'None',
    username             VARCHAR(255),
    password_encrypted   VARCHAR(512),
    certificate_path     TEXT,
    private_key_path     TEXT,
    publish_interval_ms  INTEGER DEFAULT 1000,
    enabled              BOOLEAN DEFAULT TRUE,
    description          TEXT,
    created_at           TIMESTAMPTZ DEFAULT NOW(),
    updated_at           TIMESTAMPTZ DEFAULT NOW()
);

-- Add server_id to tags for multi-server support
ALTER TABLE tags ADD COLUMN IF NOT EXISTS server_id UUID REFERENCES opc_servers(id);
ALTER TABLE tags ADD COLUMN IF NOT EXISTS use_polling BOOLEAN DEFAULT FALSE;

-- ── Write audit table ─────────────────────────────────────────────────────
CREATE TABLE write_audit (
    id              BIGSERIAL,
    time            TIMESTAMPTZ DEFAULT NOW(),
    request_id      VARCHAR(36)  NOT NULL,
    server_id       VARCHAR(255) NOT NULL,
    node_id         VARCHAR(512) NOT NULL,
    value_written   TEXT,
    data_type       VARCHAR(50),
    priority        VARCHAR(20)  DEFAULT 'NORMAL',
    requested_by    VARCHAR(255),
    success         BOOLEAN,
    readback_value  TEXT,
    readback_match  BOOLEAN,
    error_message   TEXT,
    latency_ms      DOUBLE PRECISION,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
SELECT create_hypertable('write_audit', 'time', if_not_exists => TRUE);
CREATE INDEX idx_write_audit_node   ON write_audit(node_id, time DESC);
CREATE INDEX idx_write_audit_server ON write_audit(server_id, time DESC);
CREATE INDEX idx_write_audit_user   ON write_audit(requested_by, time DESC);

-- ── Method templates ───────────────────────────────────────────────────────
CREATE TABLE method_templates (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                  VARCHAR(255) NOT NULL,
    description           TEXT,
    server_id             UUID REFERENCES opc_servers(id),
    object_node_id        VARCHAR(512) NOT NULL,
    method_node_id        VARCHAR(512) NOT NULL,
    input_args            JSONB DEFAULT '[]',
    output_args           JSONB DEFAULT '[]',
    requires_confirmation BOOLEAN DEFAULT TRUE,
    min_role              VARCHAR(20) DEFAULT 'OPERATOR',
    created_at            TIMESTAMPTZ DEFAULT NOW()
);

-- ── Method call audit ─────────────────────────────────────────────────────
CREATE TABLE method_audit (
    id              BIGSERIAL,
    time            TIMESTAMPTZ DEFAULT NOW(),
    request_id      VARCHAR(36)  NOT NULL,
    server_id       VARCHAR(255) NOT NULL,
    object_node_id  VARCHAR(512),
    method_node_id  VARCHAR(512),
    template_id     UUID REFERENCES method_templates(id),
    input_args      JSONB,
    output_args     JSONB,
    requested_by    VARCHAR(255),
    success         BOOLEAN,
    error_message   TEXT,
    latency_ms      DOUBLE PRECISION,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
SELECT create_hypertable('method_audit', 'time', if_not_exists => TRUE);
CREATE INDEX idx_method_audit_server ON method_audit(server_id, time DESC);
CREATE INDEX idx_method_audit_user   ON method_audit(requested_by, time DESC);

-- ── Scheduled tasks ───────────────────────────────────────────────────────
CREATE TABLE scheduled_tasks (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(255) NOT NULL,
    task_type       VARCHAR(50)  NOT NULL, -- READ | WRITE | METHOD | RAMP
    server_id       UUID REFERENCES opc_servers(id),
    node_id         VARCHAR(512),
    value           TEXT,
    data_type       VARCHAR(50)  DEFAULT 'Double',
    cron_expr       VARCHAR(100),          -- e.g. '*/5 * * * *'
    enabled         BOOLEAN DEFAULT TRUE,
    last_run        TIMESTAMPTZ,
    next_run        TIMESTAMPTZ,
    created_by      VARCHAR(255),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Seed default server for single-server mode ────────────────────────────
INSERT INTO opc_servers (id, name, endpoint_url, enabled, description)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'Default Server',
    'opc.tcp://localhost:4840',
    TRUE,
    'Default single-server mode connection'
) ON CONFLICT DO NOTHING;

-- Update existing tags to reference default server
UPDATE tags SET server_id = '00000000-0000-0000-0000-000000000001'
WHERE server_id IS NULL;
