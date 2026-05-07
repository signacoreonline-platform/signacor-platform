-- 001_platform_state.sql
-- Stores the full dashboard state as a single JSONB blob (id = 1).
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS platform_state (
  id INTEGER PRIMARY KEY DEFAULT 1,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO platform_state (id, data)
VALUES (1, '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;
