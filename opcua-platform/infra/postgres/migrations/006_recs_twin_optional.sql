-- ================================================================
-- Allow Closed-Loop recommendations that aren't tied to a digital twin.
-- Problem-solver prescriptions (e.g. nozzle giveaway) route to the approval
-- queue directly; requiring a twin was too restrictive.
--
-- Idempotent. Apply with:
--   docker compose exec -T timescaledb psql -U opcua_admin -d opcua \
--     < infra/postgres/migrations/006_recs_twin_optional.sql
-- ================================================================

-- Make twin_id nullable on cl_recommendations (was NOT NULL).
ALTER TABLE cl_recommendations ALTER COLUMN twin_id DROP NOT NULL;

-- Add an optional link back to the problem instance that produced the rec,
-- so the UI can show provenance ("from solver: Nozzle Giveaway").
ALTER TABLE cl_recommendations
    ADD COLUMN IF NOT EXISTS instance_id UUID REFERENCES problem_instances(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cl_recs_instance ON cl_recommendations(instance_id);
