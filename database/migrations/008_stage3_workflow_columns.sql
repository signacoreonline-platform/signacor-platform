-- 008_stage3_workflow_columns.sql
--
-- STAGE 3 — additive-only schema support for completing generic job/quote
-- editing, cost-breakdown persistence, and supplier fields that Stage 2's
-- rel_* tables (007_relational_core.sql) had no column for and were
-- silently dropping to each row's own legacy_data JSONB only.
--
-- This migration does NOT touch document_number_counters — credit-note
-- numbering (Stage 3 Phase 6) reuses the EXISTING doc_type-is-free-text
-- design from 003_document_number_counters.sql (no CHECK constraint on
-- doc_type there), so no migration is required for it; see
-- backend/src/routes/documentNumbers.ts VALID_DOC_TYPES/GLOBAL_DOC_TYPES.
--
-- Idempotent and additive only:
--   - every change is ADD COLUMN IF NOT EXISTS
--   - never drops, renames, or retypes an existing column
--   - never touches historical row data
--   - safe to re-run

-- Job/quote line items always carry a `unit` field in the live JSON
-- (index.html line-item editors) with nowhere relational to live except
-- each row's legacy_data — add a real column so Stage 3's generic
-- job/quote-edit services can read/write it directly instead of reaching
-- into JSONB for an ordinary field.
ALTER TABLE rel_job_line_items   ADD COLUMN IF NOT EXISTS unit TEXT;
ALTER TABLE rel_quote_line_items ADD COLUMN IF NOT EXISTS unit TEXT;

-- JobDetail's cost-breakdown editor (saveCosts()) always writes a fixed
-- 9-key object — {materials, labour, machine_time, design, delivery,
-- franchise_royalty, subcontracting, printing, other} — onto job.breakdown.
-- rel_jobs had no relational home for this at all. Stored as JSONB (not
-- exploded into 9 columns) because it is always read/written as one whole
-- object by the frontend, never queried per-field.
ALTER TABLE rel_jobs ADD COLUMN IF NOT EXISTS breakdown JSONB NOT NULL DEFAULT '{}'::jsonb;

-- AddEditSupplierModal's real field set includes address and vatNumber;
-- rel_suppliers was missing both (contactPerson/phone/email/city/
-- postalCode/accountNumber/paymentTerms/notes already existed and already
-- matched the frontend's real field names — no rename needed for those).
ALTER TABLE rel_suppliers ADD COLUMN IF NOT EXISTS address    TEXT;
ALTER TABLE rel_suppliers ADD COLUMN IF NOT EXISTS vat_number TEXT;
