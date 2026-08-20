-- 006_quote_conversions_audit_trail.sql
--
-- 2026-08-20 data-safety hardening, Part 9 (SQ-00168 case): a
-- quote_conversions reservation whose job is missing live is no longer
-- silently reused (see backend/src/routes/quoteConversions.ts POST
-- /reassign) — it is reassigned to a NEW job number only after explicit
-- user confirmation. Reassignment UPDATEs the existing row's job_number
-- rather than deleting/replacing the row (the UNIQUE(quote_id) constraint
-- from 005_quote_conversions.sql is unchanged and still enforces "at most
-- one reservation per quote").
--
-- These three nullable columns preserve WHAT the previous number was and
-- WHEN/WHY it changed, so a later question like "why does this quote's
-- reservation not match what was originally issued?" (exactly the question
-- this investigation needed to answer for SQ-00168) can still be answered
-- after the fact. Without them, a reassignment would be indistinguishable
-- from the original reservation — this is the minimal addition needed to
-- keep that history, nothing more.
--
-- Idempotent and additive only:
--   - never drops or truncates anything
--   - never touches existing rows' job_number/quote_id/created_at
--   - safe to re-run

ALTER TABLE quote_conversions ADD COLUMN IF NOT EXISTS superseded_job_number TEXT;
ALTER TABLE quote_conversions ADD COLUMN IF NOT EXISTS superseded_at         TIMESTAMPTZ;
ALTER TABLE quote_conversions ADD COLUMN IF NOT EXISTS reassigned_reason     TEXT;
