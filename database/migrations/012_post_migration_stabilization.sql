-- =============================================================================
-- 012 — POST-MIGRATION STABILIZATION (2026-08-24)
-- =============================================================================
-- Additive only. No DROP, no TRUNCATE, no DELETE, no UPDATE of existing rows,
-- no change to any historical migration, no change to any cutover flag.
-- Every statement is idempotent (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF
-- NOT EXISTS) so Render's `npm run migrate && npm start` can run it safely,
-- and re-run it safely, without a backup step (nothing existing is touched).
--
-- WHY THIS MIGRATION IS REQUIRED (three genuinely structural gaps found by the
-- post-migration production stabilization pass — none of them is expressible
-- through platform_state JSON any more, because all four affected sections
-- (quotes, jobs) are relational-authoritative):
--
-- 1) rel_jobs.deposit_waived / _at / _by
--    BUSINESS RULE CORRECTION (BUG 5): a Job may progress past "Deposit
--    Received" even when no deposit has been received — some clients pay
--    during production, on completion, or after completion. Until now the
--    ONLY way stage 5 could ever be reached was the automatic
--    "totalPaid > 0" bump, so an unpaid job was hard-blocked at stage 4
--    forever. The correction must NOT be implemented by fabricating a
--    payment, marking an invoice paid, or classifying the job as
--    zero-value — all of which would corrupt financial totals. It therefore
--    needs a first-class, explicitly-recorded business decision of its own:
--    "the payment requirement was consciously overridden for this job".
--    A boolean + timestamp + actor is the smallest honest representation,
--    and it is what lets the lifecycle UI distinguish
--       "Deposit Received (payment recorded)"
--    from
--       "Progressed without payment (override)"
--    without either of them lying about money.
--
-- 2) rel_quotes.quote_date / valid_until
--    Two fields the Quote form has always captured ("Quote Date",
--    "Valid Until") had NO relational column at all. Backfilled quotes kept
--    them only inside legacy_data; every quote CREATED relationally after
--    cutover lost them permanently, and the Job detail screen's
--    "Quote date / Valid until" line rendered as "—" for those quotes.
--    This is silent post-cutover data loss on a field users actively fill
--    in, so it gets real columns rather than a display-side workaround.
--
-- 3) Supporting index on rel_payments(owner_type, owner_id)
--    read.ts's paymentsFor() runs one of these lookups per job, per quote
--    and per invoice on EVERY authoritative read of those sections. Purely a
--    performance/lock-footprint improvement; changes no behavior and no data.
-- =============================================================================

-- ── 1) JOB DEPOSIT / PAYMENT-REQUIREMENT OVERRIDE ────────────────────────────
ALTER TABLE rel_jobs ADD COLUMN IF NOT EXISTS deposit_waived      BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE rel_jobs ADD COLUMN IF NOT EXISTS deposit_waived_at   TIMESTAMPTZ;
ALTER TABLE rel_jobs ADD COLUMN IF NOT EXISTS deposit_waived_by   TEXT;

COMMENT ON COLUMN rel_jobs.deposit_waived IS
  'TRUE when a user explicitly chose "Continue without payment" to progress this job past the Deposit Received stage. Purely a lifecycle/business-decision flag: it never implies money was received, never affects value/invoice_status/payment totals, and is never set automatically.';

-- ── 2) QUOTE DATE / VALIDITY ────────────────────────────────────────────────
ALTER TABLE rel_quotes ADD COLUMN IF NOT EXISTS quote_date  DATE;
ALTER TABLE rel_quotes ADD COLUMN IF NOT EXISTS valid_until DATE;

-- ── 3) PAYMENT LOOKUP INDEX (read-path performance only) ────────────────────
CREATE INDEX IF NOT EXISTS idx_rel_payments_owner
  ON rel_payments (owner_type, owner_id, line_index);
