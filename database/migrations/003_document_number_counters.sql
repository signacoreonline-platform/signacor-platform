-- 003_document_number_counters.sql
-- Backend-authoritative, atomic document-number counters.
--
-- Added to close a race condition in the old client-side "max existing
-- number + 1" invoice numbering (getNextInvoiceNum / nextInvNum in
-- index.html), which was not atomic across simultaneous users/sessions and
-- produced a confirmed duplicate: INV-00057 issued to two different co:2
-- jobs. That historical duplicate is untouched by this migration — it is
-- not renumbered, merged, or repaired here.
--
-- One row per (company, doc_type) combination, e.g. ('1','invoice'),
-- ('2','invoice'). Numbering is independent per company by design — each
-- company's counter is seeded only from that company's own existing
-- records (see backend/src/routes/documentNumbers.ts) and only ever
-- advances from there. It is intentionally NOT pre-populated with any
-- invoice number here — the reservation endpoint seeds last_number from the
-- live platform_state the first time a company requests a number.
--
-- Idempotent and additive only:
--   - never drops or truncates anything
--   - never deletes existing rows
--   - safe to re-run

CREATE TABLE IF NOT EXISTS document_number_counters (
  id           BIGSERIAL PRIMARY KEY,
  company      TEXT NOT NULL,
  doc_type     TEXT NOT NULL,
  last_number  INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company, doc_type)
);

CREATE INDEX IF NOT EXISTS idx_document_number_counters_company_doctype
  ON document_number_counters (company, doc_type);
