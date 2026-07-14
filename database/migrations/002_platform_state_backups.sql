-- 002_platform_state_backups.sql
-- Backup-before-save support for platform_state.
--
-- Creates platform_state_backups if it does not already exist, and safely
-- adds any missing columns if it DOES already exist (e.g. from a previous
-- manual run of backend/src/db/seedPlatformStateFromIndex.ts, which created
-- a smaller version of this table with only id/backed_up_at/data).
--
-- Idempotent and additive only:
--   - never drops or truncates anything
--   - never deletes existing backup rows
--   - safe to re-run
--
-- Every PUT to /api/platform-state now inserts the FULL previous
-- platform_state.data into this table BEFORE overwriting it (see
-- backend/src/routes/platformState.ts).

CREATE TABLE IF NOT EXISTS platform_state_backups (
  id           BIGSERIAL PRIMARY KEY,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data         JSONB NOT NULL
);

-- Additive columns (safe no-ops if already present).
ALTER TABLE platform_state_backups ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE platform_state_backups ADD COLUMN IF NOT EXISTS reason         TEXT NOT NULL DEFAULT 'before-put';
ALTER TABLE platform_state_backups ADD COLUMN IF NOT EXISTS data_size_bytes BIGINT;
ALTER TABLE platform_state_backups ADD COLUMN IF NOT EXISTS record_counts  JSONB;
ALTER TABLE platform_state_backups ADD COLUMN IF NOT EXISTS source         TEXT;

CREATE INDEX IF NOT EXISTS idx_platform_state_backups_created_at
  ON platform_state_backups (created_at DESC);
