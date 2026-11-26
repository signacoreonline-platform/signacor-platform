-- 023_customer_account_receipts.sql  (2026-11-26)
--
-- CUSTOMER PAYMENTS ON ACCOUNT (money received before any document exists).
--
-- A payment on account is a receipt recorded directly against a customer (by
-- its stable platform_state customer id, the same customer_ref link used since
-- migration 021) in one company. It is NOT a quote, job, invoice or credit
-- note, and no placeholder document is created. Its whole unallocated amount
-- is spendable payment credit through the customer-credit workflow of
-- migration 022: allocations (rel_credit_allocations) and recorded refunds
-- (rel_credit_refunds) reference it with source_type 'account_receipt'.
--
-- Available = amount - active allocations - active refunds. A receipt is
-- never deleted: one with no active use can be VOIDED (kept, marked, excluded
-- from credit, statements and cash received).
--
-- Additive and repeat-safe:
--   * CREATE TABLE / INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS;
--   * the two source_type CHECK constraints on rel_credit_allocations and
--     rel_credit_refunds (created by 022) are WIDENED to also allow
--     'account_receipt'. Widening = replacing the CHECK with a superset rule;
--     every existing row satisfies the new rule, no row is read, changed or
--     removed, and the step is skipped once the new constraints exist.
-- No table is dropped, no data is updated or deleted.

CREATE TABLE IF NOT EXISTS rel_account_receipts (
  id                 BIGSERIAL PRIMARY KEY,
  company_code       TEXT NOT NULL,
  customer_ref       TEXT NOT NULL,          -- platform_state customer id (as text), see 021
  customer_name      TEXT,                   -- the customer's name when recorded (display / audit only)
  amount             NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  receipt_date       DATE NOT NULL,
  method             TEXT NOT NULL,
  reference          TEXT NOT NULL,
  notes              TEXT,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','voided')),
  client_request_id  TEXT,
  created_by         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  voided_by          TEXT,
  voided_at          TIMESTAMPTZ,
  void_reason        TEXT,
  row_version        INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rel_account_receipts_request ON rel_account_receipts (client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rel_account_receipts_customer ON rel_account_receipts (company_code, customer_ref);
CREATE INDEX IF NOT EXISTS idx_rel_account_receipts_date ON rel_account_receipts (company_code, receipt_date);

ALTER TABLE rel_credit_allocations ADD COLUMN IF NOT EXISTS source_account_receipt_id BIGINT;
ALTER TABLE rel_credit_refunds     ADD COLUMN IF NOT EXISTS source_account_receipt_id BIGINT;
CREATE INDEX IF NOT EXISTS idx_rel_credit_allocations_source_account ON rel_credit_allocations (source_account_receipt_id) WHERE source_account_receipt_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rel_credit_refunds_source_account ON rel_credit_refunds (source_account_receipt_id) WHERE source_account_receipt_id IS NOT NULL;

DO $$
DECLARE t TEXT; c RECORD;
BEGIN
  FOREACH t IN ARRAY ARRAY['rel_credit_allocations','rel_credit_refunds'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_source_kind_chk') THEN
      -- the 022 rules that only know 'payment' / 'credit_note'
      FOR c IN SELECT conname FROM pg_constraint
                WHERE conrelid = t::regclass AND contype = 'c'
                  AND pg_get_constraintdef(oid) LIKE '%source_type%'
                  AND pg_get_constraintdef(oid) NOT LIKE '%account_receipt%' LOOP
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c.conname);
      END LOOP;
      EXECUTE format($f$ALTER TABLE %I ADD CONSTRAINT %I CHECK (source_type IN ('payment','credit_note','account_receipt'))$f$, t, t || '_source_type_chk');
      EXECUTE format($f$ALTER TABLE %I ADD CONSTRAINT %I CHECK (
           (source_type = 'payment' AND source_payment_id IS NOT NULL)
        OR (source_type = 'credit_note' AND source_credit_note_id IS NOT NULL)
        OR (source_type = 'account_receipt' AND source_account_receipt_id IS NOT NULL))$f$, t, t || '_source_kind_chk');
    END IF;
  END LOOP;
END $$;
