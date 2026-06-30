-- ================================================================
-- Unified Connectivity Framework — sources & streams
-- Idempotent migration. Apply with:
--   docker compose exec -T timescaledb psql -U opcua_admin -d opcua \
--     < infra/postgres/migrations/004_connectivity.sql
--
-- DESIGN: Every connector (OPC UA, SQL, MQTT, Modbus, ...) is a "source"
-- that produces normalized Readings into the SAME tag_values hypertable.
-- 'sources' generalizes opc_servers; 'streams' generalizes tags. Existing OPC
-- UA continues to work via tags/opc_servers untouched — this is ADDITIVE.
-- New connectors use sources/streams. Both write tag_values, so the twin,
-- detectors, and problem templates are connector-agnostic.
-- ================================================================

-- A configured connector instance. config JSONB holds protocol-specific
-- settings (broker+topic for MQTT, DSN+query for SQL, host+registers for
-- Modbus, etc) so one table serves all 50 connector types.
CREATE TABLE IF NOT EXISTS sources (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name          VARCHAR(255) NOT NULL,
    -- connector key: 'opcua' | 'sql' | 'mqtt' | 'modbus_tcp' | 'rest' | ...
    source_type   VARCHAR(64)  NOT NULL,
    -- 'subscribe' (push) | 'poll' (request/response) | 'batch' (file/query import)
    mode          VARCHAR(16)  NOT NULL DEFAULT 'poll',
    config        JSONB        NOT NULL DEFAULT '{}',
    poll_interval_ms INTEGER   DEFAULT 5000,   -- for poll/batch modes
    enabled       BOOLEAN      NOT NULL DEFAULT TRUE,
    writable      BOOLEAN      NOT NULL DEFAULT FALSE,  -- can this source accept writes?
    description   TEXT,
    -- live status mirror (also kept in Redis for the UI)
    last_status   VARCHAR(32),
    last_error    TEXT,
    last_seen     TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(name)
);
CREATE INDEX IF NOT EXISTS idx_sources_type ON sources(source_type);

-- A point within a source (generalizes tags). stream_key is the protocol
-- address: OPC NodeId, MQTT topic, SQL column, Modbus register, etc.
-- Streams link to assets exactly like tags do, and get a tag_id so they can
-- reuse the existing tag_values pipeline + all downstream learning.
CREATE TABLE IF NOT EXISTS streams (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_id       UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    asset_id        UUID REFERENCES assets(id) ON DELETE SET NULL,
    -- protocol address within the source
    stream_key      VARCHAR(512) NOT NULL,
    display_name    VARCHAR(255) NOT NULL,
    description     TEXT,
    engineering_unit VARCHAR(50),
    data_type       VARCHAR(50) DEFAULT 'Double',
    deadband_value  DOUBLE PRECISION DEFAULT 0.0,
    sample_interval_ms INTEGER DEFAULT 1000,
    -- Bridge to the existing pipeline: each stream maps to a tags row so
    -- tag_values, Redis live cache, twin signals, and detectors all work
    -- unchanged. Created automatically when a stream is added.
    tag_id          UUID REFERENCES tags(id) ON DELETE SET NULL,
    is_active       BOOLEAN DEFAULT TRUE,
    stream_meta     JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(source_id, stream_key)
);
CREATE INDEX IF NOT EXISTS idx_streams_source ON streams(source_id);
CREATE INDEX IF NOT EXISTS idx_streams_asset  ON streams(asset_id);
CREATE INDEX IF NOT EXISTS idx_streams_tag    ON streams(tag_id);

-- OPC UA is "connector #1": optionally register existing OPC servers as
-- sources for a unified view, without moving their data. (Read-only mirror;
-- the OPC UA client keeps its own opc_servers/tags pipeline.)
-- This is a convenience, not a dependency.
