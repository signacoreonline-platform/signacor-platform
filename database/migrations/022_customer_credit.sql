-- 022_customer_credit.sql  (2026-11-26)
--
-- CUSTOMER PAYMENT CREDIT, CREDIT-NOTE ALLOCATIONS AND RECORDED REFUNDS.
--
-- Additive and repeat-safe: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT
-- EXISTS / CREATE INDEX IF NOT EXISTS only. No existing row is updated,
-- deleted or re-derived; no table is dropped.
--
-- THE MODEL
--   * A RECEIPT stays exactly what it is today: one rel_payments row with its
--     original amount, date, method, reference, owner (quote/job/invoice) and
--     therefore company and customer. It is never copied or edited.
--   * rel_payments.entry_kind says what a row is. NULL = a historical row; its
--     kind is derived from its method exactly as before ('credit...' = a
--     credit-note payment, anything else = a receipt). New rows always set it:
--       'receipt'            money received
--       'credit_note'        a "Credit" payment funded by credit note(s)
--       'payment_credit_in'  + side of applying payment credit to a document
--       'payment_credit_out' - side, on the document whose receipt funded it
--       'refund'             - recorded refund of a receipt's payment credit
--   * rel_payments.credit_eligible is the TRANSITION MARKER. Only receipts
--     recorded after this migration are marked true. Every historical row keeps
--     the default false, so apparent historical excess (including suspected
--     duplicate payments) is never exposed as spendable payment credit.
--   * rel_credit_allocations records every use of credit — from a receipt's
--     payment credit or from one specific credit note — with the company, the
--     customer link, the amount, who/when, an idempotency key, and reversal.
--   * rel_credit_refunds records refunds of available credit (recording only;
--     it does not move money through a bank).
--   * rel_credit_notes.refunded_amount: credit-note credit refunded to the
--     customer. Available credit-note credit = amount - used_amount - refunded_amount.

ALTER TABLE rel_payments ADD COLUMN IF NOT EXISTS entry_kind TEXT;
ALTER TABLE rel_payments ADD COLUMN IF NOT EXISTS credit_eligible BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE rel_payments ADD COLUMN IF NOT EXISTS credit_link_id BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rel_payments_entry_kind_chk') THEN
    ALTER TABLE rel_payments ADD CONSTRAINT rel_payments_entry_kind_chk
      CHECK (entry_kind IS NULL OR entry_kind IN ('receipt','credit_note','payment_credit_in','payment_credit_out','refund'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_rel_payments_credit_eligible ON rel_payments (credit_eligible) WHERE credit_eligible;
CREATE INDEX IF NOT EXISTS idx_rel_payments_credit_link ON rel_payments (credit_link_id) WHERE credit_link_id IS NOT NULL;

ALTER TABLE rel_credit_notes ADD COLUMN IF NOT EXISTS refunded_amount NUMERIC(14,2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS rel_credit_allocations (
  id                        BIGSERIAL PRIMARY KEY,
  company_code              TEXT NOT NULL,
  customer_ref              TEXT NOT NULL,
  source_type               TEXT NOT NULL CHECK (source_type IN ('payment','credit_note')),
  source_payment_id         BIGINT,          -- the receipt (rel_payments.id) for source_type 'payment'
  source_credit_note_id     BIGINT,          -- the credit note for source_type 'credit_note'
  target_owner_type         TEXT NOT NULL CHECK (target_owner_type IN ('quote','job','invoice')),
  target_owner_id           BIGINT NOT NULL,
  target_number             TEXT,
  amount                    NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  target_payment_id         BIGINT,          -- the + row on the target document
  source_offset_payment_id  BIGINT,          -- the - row on the source document (payment source only)
  status                    TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','reversed')),
  legacy                    BOOLEAN NOT NULL DEFAULT false,
  client_request_id         TEXT,
  notes                     TEXT,
  created_by                TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reversed_by               TEXT,
  reversed_at               TIMESTAMPTZ,
  reversal_reason           TEXT,
  row_version               INTEGER NOT NULL DEFAULT 1,
  CHECK ((source_type = 'payment' AND source_payment_id IS NOT NULL)
      OR (source_type = 'credit_note' AND source_credit_note_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rel_credit_allocations_request ON rel_credit_allocations (client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rel_credit_allocations_customer ON rel_credit_allocations (company_code, customer_ref);
CREATE INDEX IF NOT EXISTS idx_rel_credit_allocations_source_payment ON rel_credit_allocations (source_payment_id) WHERE source_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rel_credit_allocations_source_note ON rel_credit_allocations (source_credit_note_id) WHERE source_credit_note_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rel_credit_allocations_target_payment ON rel_credit_allocations (target_payment_id) WHERE target_payment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS rel_credit_refunds (
  id                        BIGSERIAL PRIMARY KEY,
  company_code              TEXT NOT NULL,
  customer_ref              TEXT NOT NULL,
  source_type               TEXT NOT NULL CHECK (source_type IN ('payment','credit_note')),
  source_payment_id         BIGINT,
  source_credit_note_id     BIGINT,
  amount                    NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  refund_date               DATE,
  method                    TEXT,
  reference                 TEXT,
  notes                     TEXT,
  ledger_payment_id         BIGINT,          -- the - row on the receipt's document (payment source only)
  status                    TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','reversed')),
  client_request_id         TEXT,
  created_by                TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reversed_by               TEXT,
  reversed_at               TIMESTAMPTZ,
  reversal_reason           TEXT,
  row_version               INTEGER NOT NULL DEFAULT 1,
  CHECK ((source_type = 'payment' AND source_payment_id IS NOT NULL)
      OR (source_type = 'credit_note' AND source_credit_note_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rel_credit_refunds_request ON rel_credit_refunds (client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rel_credit_refunds_customer ON rel_credit_refunds (company_code, customer_ref);
