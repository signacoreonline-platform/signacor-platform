-- 005_quote_conversions.sql
--
-- Production stabilisation (2026-08-18) — closes the confirmed SQ-00014
-- double-conversion bug: two sessions converting the SAME quote to a job at
-- nearly the same time could both succeed, because the only guard against
-- re-converting an already-converted quote was a client-side check against
-- each session's own (possibly stale) local `jobs` array — nothing in the
-- database ever enforced "this quote may be converted at most once".
--
-- One row per quote (by the quote's own client-generated `id`, stored as
-- TEXT since platform_state ids are JS numbers/Date.now() values, not
-- database-native integers). The UNIQUE constraint on quote_id is the real
-- protection: two concurrent INSERT attempts for the same quote_id can
-- never both succeed, regardless of what either session's local state
-- looked like at the time. See backend/src/routes/quoteConversions.ts for
-- how this is used.
--
-- This table is bookkeeping only — it does not replace or duplicate
-- anything in platform_state, and nothing here is ever renumbered, merged,
-- or used to repair historical data. A row simply records "job number X was
-- reserved for quote Y" so a retry (e.g. after a network timeout) can be
-- told to reuse that same number instead of minting — and potentially
-- creating a job with — a different one.
--
-- Idempotent and additive only:
--   - never drops or truncates anything
--   - never deletes existing rows
--   - safe to re-run

CREATE TABLE IF NOT EXISTS quote_conversions (
  id           BIGSERIAL PRIMARY KEY,
  quote_id     TEXT NOT NULL,
  job_number   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (quote_id)
);

CREATE INDEX IF NOT EXISTS idx_quote_conversions_job_number
  ON quote_conversions (job_number);
