-- 021_customer_links.sql  (2026-11-24)
--
-- STABLE CUSTOMER LINKS ON DOCUMENTS
--
-- The customer record is the source of truth. Customers stay platform_state
-- authoritative (they are permanently blocked from relational cutover), so a
-- document's stable link is the customer's platform_state `id`, stored as
-- text exactly as the dashboard and the integration API already express it
-- (ids can be integers or Date.now()+Math.random() floats).
--
-- `customer_ref` is deliberately a NEW column rather than a reuse of the
-- existing `customer_id`: that column is a foreign key to rel_customers, a
-- one-off backfill snapshot that is never updated and holds no customer
-- created since the backfill. Existing `customer_id` values are left exactly
-- as they are.
--
-- Additive and idempotent only:
--   - ADD COLUMN IF NOT EXISTS (nullable, no default, no rewrite of data);
--   - CREATE INDEX / TABLE IF NOT EXISTS;
--   - no DROP, TRUNCATE, DELETE or UPDATE. Existing rows keep customer_ref
--     NULL until a link is set by the dashboard or by the manually-run,
--     backed-up backfill script (backend/src/scripts/backfill-customer-links.ts).

ALTER TABLE rel_quotes       ADD COLUMN IF NOT EXISTS customer_ref TEXT;
ALTER TABLE rel_jobs         ADD COLUMN IF NOT EXISTS customer_ref TEXT;
ALTER TABLE rel_invoices     ADD COLUMN IF NOT EXISTS customer_ref TEXT;
ALTER TABLE rel_credit_notes ADD COLUMN IF NOT EXISTS customer_ref TEXT;

CREATE INDEX IF NOT EXISTS idx_rel_quotes_customer_ref       ON rel_quotes (customer_ref);
CREATE INDEX IF NOT EXISTS idx_rel_jobs_customer_ref         ON rel_jobs (customer_ref);
CREATE INDEX IF NOT EXISTS idx_rel_invoices_customer_ref     ON rel_invoices (customer_ref);
CREATE INDEX IF NOT EXISTS idx_rel_credit_notes_customer_ref ON rel_credit_notes (customer_ref);

-- Audit evidence for every change of which customer owns a transaction chain
-- (dashboard reassignment, first-time linking, and the backfill script). The
-- documents' own historical snapshots and cancellation markers are never
-- rewritten by a reassignment of a cancelled invoice; this table records who
-- moved what, from which customer to which, and when.
CREATE TABLE IF NOT EXISTS customer_link_audit (
  id            BIGSERIAL PRIMARY KEY,
  at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor         TEXT,
  action        TEXT NOT NULL,          -- 'reassign' | 'link' | 'backfill'
  company_code  TEXT,
  from_refs     JSONB NOT NULL DEFAULT '[]'::jsonb,
  to_ref        TEXT,
  members       JSONB NOT NULL DEFAULT '[]'::jsonb,
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_customer_link_audit_to_ref ON customer_link_audit (to_ref);
