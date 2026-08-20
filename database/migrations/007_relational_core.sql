-- 007_relational_core.sql
--
-- JSONB -> RELATIONAL MIGRATION, PHASE 1: additive schema only.
--
-- Adds new relational tables that will eventually become the authoritative
-- store for the critical business chain currently living entirely inside
-- platform_state.data (customer -> quote -> job -> invoice -> payment,
-- plus credit notes / purchase orders / inventory / suppliers). Nothing in
-- this migration touches platform_state or platform_state_backups, and
-- nothing here changes what the live application actually reads or writes
-- today — see relational_cutover below, which every new table's authority
-- is gated behind, and which defaults every section to FALSE (JSON remains
-- authoritative for everything until a human explicitly flips a row here
-- AND the backend has RELATIONAL_AUTHORITY_ENABLED=true set, see
-- backend/src/relational/cutover.ts).
--
-- DESIGN NOTES (read before extending this file):
--
-- 1. Every table below carries:
--      source_id     TEXT — the record's original id AS IT APPEARS in
--                     platform_state.data (stringified; JS ids are numbers
--                     or Date.now()+Math.random() floats, never native
--                     Postgres integers/UUIDs). This is the deterministic
--                     link back to the JSON source the backfill/
--                     reconciliation tools rely on. It is NOT reused as the
--                     primary key — `id` (BIGSERIAL) is the real relational
--                     PK, exactly per the "identity preservation" section of
--                     the migration brief: preserve the source id in a
--                     dedicated field, keep a separate internal PK.
--      row_version   INTEGER — optimistic-concurrency token for row-level
--                     relational writes (see backend/src/relational/*
--                     services). Bumped on every UPDATE.
--      legacy_data   JSONB — the ENTIRE original JSON record, verbatim.
--                     Every column this schema does NOT model is still
--                     fully recoverable from this field — nothing is ever
--                     silently dropped just because this schema doesn't
--                     understand it yet (per the migration brief's
--                     "preserve unknown legacy fields" requirement).
--      created_at / updated_at
--
-- 2. Company ownership ("co" in the JSON — jobs/quotes/purchaseOrders/
--    accInvoices all carry it; customers/suppliers/inventory do NOT, they
--    are shared across companies in the real data model observed in
--    index.html) is stored as company_code TEXT, a loose reference to
--    companies(code) — NOT a hard FK. The live app's co values are opaque
--    small integers-as-strings ('1','2','3','4') whose exact business
--    mapping is not fully re-derived here (backend/src/routes/
--    documentNumbers.ts's VALID_COMPANIES=['1','2','4'] already shows the
--    mapping is not simply "1 row per schema.sql seed company" — company 3
--    is excluded from per-company invoice/quote numbering for reasons this
--    migration does not re-litigate). A hard FK would risk rejecting
--    legitimate historical data over a mapping this migration cannot
--    verify; companies is a lookup/reporting aid, not an enforced
--    constraint.
--
-- 3. Foreign keys that cross entities the LIVE JSON links only by loose
--    string matching (jobs.client is a plain company-name STRING, not a
--    customers[].id) are nullable and populated best-effort by the backfill
--    tool via name matching — never invented, never guessed when
--    ambiguous. The raw string is always ALSO preserved in a *_raw column
--    and in legacy_data, so no information is lost even when a match
--    cannot be made.
--
-- 4. Idempotent and additive only:
--      - never drops or truncates anything
--      - never touches platform_state or platform_state_backups
--      - safe to re-run (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT
--        EXISTS throughout)

-- =============================================================================
-- CUTOVER CONTROL — defaults every section to OFF. Read by both the backend
-- relational routes (refuse to serve as authoritative until enabled) and by
-- platformState.ts (refuses to let platform_state.data ever overwrite a
-- section once it is cut over). See backend/src/relational/cutover.ts.
-- =============================================================================
CREATE TABLE IF NOT EXISTS relational_cutover (
  section      TEXT PRIMARY KEY,
  enabled      BOOLEAN NOT NULL DEFAULT FALSE,
  enabled_at   TIMESTAMPTZ,
  enabled_by   TEXT,
  notes        TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO relational_cutover (section, enabled) VALUES
  ('customers', FALSE), ('suppliers', FALSE), ('inventory', FALSE),
  ('quickRates', FALSE), ('quotes', FALSE), ('jobs', FALSE),
  ('accInvoices', FALSE), ('payments', FALSE), ('creditNotes', FALSE),
  ('purchaseOrders', FALSE), ('employees', FALSE), ('leaveRequests', FALSE),
  ('disciplinary', FALSE)
ON CONFLICT (section) DO NOTHING;

-- =============================================================================
-- BACKFILL / RECONCILIATION BOOKKEEPING (audit trail — never used to
-- reconstruct or repair anything, purely observational)
-- =============================================================================
CREATE TABLE IF NOT EXISTS relational_backfill_runs (
  id            BIGSERIAL PRIMARY KEY,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ,
  mode          TEXT NOT NULL CHECK (mode IN ('dry_run','apply')),
  source        TEXT NOT NULL, -- 'platform_state' | a file path (local testing only)
  summary       JSONB,
  ok            BOOLEAN
);

CREATE TABLE IF NOT EXISTS relational_legacy_conflicts (
  id              BIGSERIAL PRIMARY KEY,
  backfill_run_id BIGINT REFERENCES relational_backfill_runs(id),
  collection      TEXT NOT NULL,
  source_id       TEXT,
  document_number TEXT,
  conflict_type   TEXT NOT NULL, -- 'duplicate_source_id' | 'ambiguous_group' | 'unresolved_company' | ...
  detail          JSONB,
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_relational_legacy_conflicts_collection ON relational_legacy_conflicts (collection);

-- =============================================================================
-- COMPANIES — lookup only (see design note 2 above). Seeded with the four
-- codes actually observed in the live JSON's `co` field; names left NULL
-- (not guessed) until confirmed.
-- =============================================================================
CREATE TABLE IF NOT EXISTS rel_companies (
  code        TEXT PRIMARY KEY,
  name        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO rel_companies (code, name) VALUES ('1', NULL), ('2', NULL), ('3', NULL), ('4', NULL)
ON CONFLICT (code) DO NOTHING;

-- =============================================================================
-- CUSTOMERS
-- =============================================================================
CREATE TABLE IF NOT EXISTS rel_customers (
  id              BIGSERIAL PRIMARY KEY,
  source_id       TEXT NOT NULL,
  company_name    TEXT NOT NULL,
  contact_person  TEXT,
  email           TEXT,
  phone           TEXT,
  address         TEXT,
  vat_number      TEXT,
  notes           TEXT,
  row_version     INTEGER NOT NULL DEFAULT 1,
  legacy_data     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id)
);
CREATE INDEX IF NOT EXISTS idx_rel_customers_name ON rel_customers (LOWER(company_name));

-- =============================================================================
-- SUPPLIERS
-- =============================================================================
CREATE TABLE IF NOT EXISTS rel_suppliers (
  id              BIGSERIAL PRIMARY KEY,
  source_id       TEXT NOT NULL,
  name            TEXT NOT NULL,
  contact_person  TEXT,
  phone           TEXT,
  email           TEXT,
  city            TEXT,
  postal_code     TEXT,
  payment_terms   TEXT,
  account_number  TEXT,
  notes           TEXT,
  row_version     INTEGER NOT NULL DEFAULT 1,
  legacy_data     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id)
);
CREATE INDEX IF NOT EXISTS idx_rel_suppliers_name ON rel_suppliers (LOWER(name));

-- =============================================================================
-- INVENTORY ITEMS (materials) and QUICK RATE ITEMS (separate collection,
-- same shape in the JSON, kept as its own table — see backfill notes on
-- known historical duplicate ids in both).
-- =============================================================================
CREATE TABLE IF NOT EXISTS rel_inventory_items (
  id              BIGSERIAL PRIMARY KEY,
  source_id       TEXT NOT NULL,
  sku             TEXT,
  name            TEXT NOT NULL,
  category        TEXT,
  unit            TEXT,
  cost            NUMERIC(14,4) NOT NULL DEFAULT 0,
  sell            NUMERIC(14,4) NOT NULL DEFAULT 0,
  stock_qty       NUMERIC(14,4) NOT NULL DEFAULT 0,
  reorder_level   NUMERIC(14,4) NOT NULL DEFAULT 0,
  supplier_id     BIGINT REFERENCES rel_suppliers(id),
  supplier_source_id TEXT,
  row_version     INTEGER NOT NULL DEFAULT 1,
  legacy_data     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id)
);

CREATE TABLE IF NOT EXISTS rel_quick_rate_items (
  id              BIGSERIAL PRIMARY KEY,
  source_id       TEXT NOT NULL,
  sku             TEXT,
  name            TEXT NOT NULL,
  category        TEXT,
  unit            TEXT,
  cost            NUMERIC(14,4) NOT NULL DEFAULT 0,
  sell            NUMERIC(14,4) NOT NULL DEFAULT 0,
  stock_qty       NUMERIC(14,4) NOT NULL DEFAULT 0,
  reorder_level   NUMERIC(14,4) NOT NULL DEFAULT 0,
  supplier_id     BIGINT REFERENCES rel_suppliers(id),
  supplier_source_id TEXT,
  row_version     INTEGER NOT NULL DEFAULT 1,
  legacy_data     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id)
);

-- =============================================================================
-- QUOTES + LINE ITEMS
-- =============================================================================
CREATE TABLE IF NOT EXISTS rel_quotes (
  id                  BIGSERIAL PRIMARY KEY,
  source_id           TEXT NOT NULL,
  quote_number        TEXT NOT NULL,
  company_code        TEXT NOT NULL,
  customer_id         BIGINT REFERENCES rel_customers(id),
  customer_name_raw   TEXT,
  contact_person      TEXT,
  email               TEXT,
  phone               TEXT,
  address             TEXT,
  vat_number          TEXT,
  status              TEXT,
  notes               TEXT,
  terms               TEXT,
  salesperson         TEXT,
  prepared_by         TEXT,
  po_ref              TEXT,
  reference           TEXT,
  setup_fee           NUMERIC(14,2) NOT NULL DEFAULT 0,
  discount_pct        NUMERIC(6,3)  NOT NULL DEFAULT 0,
  subtotal            NUMERIC(14,2) NOT NULL DEFAULT 0,
  vat_amount          NUMERIC(14,2) NOT NULL DEFAULT 0,
  total               NUMERIC(14,2) NOT NULL DEFAULT 0,
  proforma_num        TEXT,
  converted_job_source_id TEXT,
  converted_job_id    BIGINT, -- FK to rel_jobs added after rel_jobs exists (see below)
  row_version         INTEGER NOT NULL DEFAULT 1,
  legacy_data         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id),
  UNIQUE (company_code, quote_number)
);

CREATE TABLE IF NOT EXISTS rel_quote_line_items (
  id                BIGSERIAL PRIMARY KEY,
  quote_id          BIGINT NOT NULL REFERENCES rel_quotes(id) ON DELETE CASCADE,
  line_index        INTEGER NOT NULL,
  description       TEXT,
  qty               NUMERIC(14,4) NOT NULL DEFAULT 1,
  unit_price        NUMERIC(14,4) NOT NULL DEFAULT 0,
  subtotal          NUMERIC(14,2) NOT NULL DEFAULT 0,
  inventory_item_id BIGINT REFERENCES rel_inventory_items(id),
  inventory_source_id TEXT,
  legacy_data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (quote_id, line_index)
);

-- =============================================================================
-- JOBS + LINE ITEMS
-- =============================================================================
CREATE TABLE IF NOT EXISTS rel_jobs (
  id                BIGSERIAL PRIMARY KEY,
  source_id         TEXT NOT NULL,
  job_number        TEXT NOT NULL,
  company_code      TEXT NOT NULL,
  customer_id       BIGINT REFERENCES rel_customers(id),
  customer_name_raw TEXT,
  contact_person    TEXT,
  email             TEXT,
  phone             TEXT,
  address           TEXT,
  vat_number        TEXT,
  description       TEXT,
  status            TEXT,
  stage             INTEGER,
  value             NUMERIC(14,2) NOT NULL DEFAULT 0,
  quote_id          BIGINT REFERENCES rel_quotes(id),
  quote_number_raw  TEXT,
  invoice_num       TEXT,
  invoice_date      DATE,
  invoice_due       DATE,
  invoice_created   BOOLEAN NOT NULL DEFAULT FALSE,
  invoice_status    TEXT,
  setup_fee         NUMERIC(14,2) NOT NULL DEFAULT 0,
  discount_pct      NUMERIC(6,3)  NOT NULL DEFAULT 0,
  salesperson       TEXT,
  prepared_by       TEXT,
  po_ref            TEXT,
  reference         TEXT,
  notes             TEXT,
  row_version       INTEGER NOT NULL DEFAULT 1,
  legacy_data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id),
  UNIQUE (job_number)
);

CREATE TABLE IF NOT EXISTS rel_job_line_items (
  id                BIGSERIAL PRIMARY KEY,
  job_id            BIGINT NOT NULL REFERENCES rel_jobs(id) ON DELETE CASCADE,
  line_index        INTEGER NOT NULL,
  description       TEXT,
  qty               NUMERIC(14,4) NOT NULL DEFAULT 1,
  unit_price        NUMERIC(14,4) NOT NULL DEFAULT 0,
  subtotal          NUMERIC(14,2) NOT NULL DEFAULT 0,
  inventory_item_id BIGINT REFERENCES rel_inventory_items(id),
  inventory_source_id TEXT,
  legacy_data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (job_id, line_index)
);

-- Now that rel_jobs exists, wire quotes.converted_job_id for real.
-- (PostgreSQL has no "ADD CONSTRAINT IF NOT EXISTS" — guard manually so this
-- migration stays safe to re-run.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_rel_quotes_converted_job'
  ) THEN
    ALTER TABLE rel_quotes
      ADD CONSTRAINT fk_rel_quotes_converted_job
      FOREIGN KEY (converted_job_id) REFERENCES rel_jobs(id);
  END IF;
END $$;

-- =============================================================================
-- INVOICES (accInvoices) + LINE ITEMS
-- Distinct from rel_jobs.invoice_num/invoice_date/invoice_status above — the
-- live application genuinely represents "this job's invoice" two different
-- ways depending on how it was created (see index.html createInvoiceNow vs
-- createInvoiceFromQuote): either fields embedded directly on the job, or a
-- freestanding accInvoices record the job later links to (job_id below).
-- This migration preserves that duality rather than silently collapsing it;
-- see the handoff notes for exactly how a UI/API consuming this data tells
-- the two apart (job_id IS NOT NULL vs job.invoice_num populated with no
-- corresponding rel_invoices row).
-- =============================================================================
CREATE TABLE IF NOT EXISTS rel_invoices (
  id                BIGSERIAL PRIMARY KEY,
  source_id         TEXT NOT NULL,
  invoice_number    TEXT NOT NULL,
  company_code      TEXT NOT NULL,
  customer_id       BIGINT REFERENCES rel_customers(id),
  contact_name      TEXT,
  contact_email     TEXT,
  contact_address   TEXT,
  job_id            BIGINT REFERENCES rel_jobs(id),
  job_number_raw    TEXT,
  quote_id          BIGINT REFERENCES rel_quotes(id),
  quote_number_raw  TEXT,
  reference         TEXT,
  status            TEXT,
  issue_date        DATE,
  due_date          DATE,
  row_version       INTEGER NOT NULL DEFAULT 1,
  legacy_data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id),
  UNIQUE (company_code, invoice_number)
);

CREATE TABLE IF NOT EXISTS rel_invoice_line_items (
  id              BIGSERIAL PRIMARY KEY,
  invoice_id      BIGINT NOT NULL REFERENCES rel_invoices(id) ON DELETE CASCADE,
  line_index      INTEGER NOT NULL,
  description     TEXT,
  qty             NUMERIC(14,4) NOT NULL DEFAULT 1,
  unit_amount     NUMERIC(14,4) NOT NULL DEFAULT 0,
  account_code    TEXT,
  tax_type        TEXT,
  legacy_data     JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (invoice_id, line_index)
);

-- =============================================================================
-- PAYMENTS — generalized: a payment belongs to exactly one of a job
-- (job.payments[]), a quote (quote.payments[] — deposits recorded before any
-- invoice exists), or an invoice (accInvoices[].payments[]). owner_type +
-- owner_id together identify the parent relational row.
-- =============================================================================
CREATE TABLE IF NOT EXISTS rel_payments (
  id              BIGSERIAL PRIMARY KEY,
  source_id       TEXT, -- payment sub-records don't always carry a stable id in the JSON
  owner_type      TEXT NOT NULL CHECK (owner_type IN ('job','quote','invoice')),
  owner_id        BIGINT NOT NULL,
  line_index      INTEGER NOT NULL, -- position within the owner's payments[] array — used as the identity fallback when source_id is absent
  amount          NUMERIC(14,2) NOT NULL,
  payment_date    DATE,
  method          TEXT,
  reference       TEXT,
  notes           TEXT,
  row_version     INTEGER NOT NULL DEFAULT 1,
  legacy_data     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner_type, owner_id, line_index)
);
CREATE INDEX IF NOT EXISTS idx_rel_payments_owner ON rel_payments (owner_type, owner_id);

-- =============================================================================
-- CREDIT NOTES
-- =============================================================================
CREATE TABLE IF NOT EXISTS rel_credit_notes (
  id                BIGSERIAL PRIMARY KEY,
  source_id         TEXT NOT NULL,
  credit_number     TEXT NOT NULL,
  note_type         TEXT NOT NULL CHECK (note_type IN ('customer','supplier')),
  contact_name_raw  TEXT NOT NULL,
  customer_id       BIGINT REFERENCES rel_customers(id),
  supplier_id       BIGINT REFERENCES rel_suppliers(id),
  note_date         DATE,
  amount            NUMERIC(14,2) NOT NULL DEFAULT 0,
  used_amount       NUMERIC(14,2) NOT NULL DEFAULT 0,
  reason            TEXT,
  applied_to        TEXT,
  notes             TEXT,
  status            TEXT,
  row_version       INTEGER NOT NULL DEFAULT 1,
  legacy_data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id)
);

-- =============================================================================
-- PURCHASE ORDERS + ITEMS
-- =============================================================================
CREATE TABLE IF NOT EXISTS rel_purchase_orders (
  id                BIGSERIAL PRIMARY KEY,
  source_id         TEXT NOT NULL,
  po_number         TEXT NOT NULL,
  company_code      TEXT,
  supplier_id       BIGINT REFERENCES rel_suppliers(id),
  supplier_source_id TEXT,
  job_id            BIGINT REFERENCES rel_jobs(id),
  job_number_raw    TEXT,
  quote_id          BIGINT REFERENCES rel_quotes(id),
  quote_number_raw  TEXT,
  order_date        DATE,
  status            TEXT,
  notes             TEXT,
  row_version       INTEGER NOT NULL DEFAULT 1,
  legacy_data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id),
  UNIQUE (po_number)
);

CREATE TABLE IF NOT EXISTS rel_purchase_order_items (
  id                BIGSERIAL PRIMARY KEY,
  po_id             BIGINT NOT NULL REFERENCES rel_purchase_orders(id) ON DELETE CASCADE,
  line_index        INTEGER NOT NULL,
  inventory_item_id BIGINT REFERENCES rel_inventory_items(id),
  inventory_source_id TEXT,
  sku               TEXT,
  name              TEXT,
  unit              TEXT,
  qty_needed        NUMERIC(14,4) NOT NULL DEFAULT 0,
  qty_ordered       NUMERIC(14,4) NOT NULL DEFAULT 0,
  unit_cost         NUMERIC(14,4) NOT NULL DEFAULT 0,
  legacy_data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (po_id, line_index)
);

-- =============================================================================
-- EMPLOYEES / LEAVE REQUESTS / DISCIPLINARY (lower priority tier — schema
-- only for now; see handoff for backfill status)
-- =============================================================================
CREATE TABLE IF NOT EXISTS rel_employees (
  id              BIGSERIAL PRIMARY KEY,
  source_id       TEXT NOT NULL,
  full_name       TEXT,
  role            TEXT,
  company_code    TEXT,
  row_version     INTEGER NOT NULL DEFAULT 1,
  legacy_data     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id)
);

CREATE TABLE IF NOT EXISTS rel_leave_requests (
  id              BIGSERIAL PRIMARY KEY,
  source_id       TEXT NOT NULL,
  employee_id     BIGINT REFERENCES rel_employees(id),
  employee_source_id TEXT,
  start_date      DATE,
  end_date        DATE,
  status          TEXT,
  row_version     INTEGER NOT NULL DEFAULT 1,
  legacy_data     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id)
);

CREATE TABLE IF NOT EXISTS rel_disciplinary_records (
  id              BIGSERIAL PRIMARY KEY,
  source_id       TEXT NOT NULL,
  employee_id     BIGINT REFERENCES rel_employees(id),
  employee_source_id TEXT,
  record_date     DATE,
  notes           TEXT,
  row_version     INTEGER NOT NULL DEFAULT 1,
  legacy_data     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id)
);

-- =============================================================================
-- INDEXES for common lookups
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_rel_quotes_company        ON rel_quotes (company_code);
CREATE INDEX IF NOT EXISTS idx_rel_quotes_customer        ON rel_quotes (customer_id);
CREATE INDEX IF NOT EXISTS idx_rel_jobs_company           ON rel_jobs (company_code);
CREATE INDEX IF NOT EXISTS idx_rel_jobs_customer          ON rel_jobs (customer_id);
CREATE INDEX IF NOT EXISTS idx_rel_jobs_quote             ON rel_jobs (quote_id);
CREATE INDEX IF NOT EXISTS idx_rel_invoices_job           ON rel_invoices (job_id);
CREATE INDEX IF NOT EXISTS idx_rel_invoices_quote         ON rel_invoices (quote_id);
CREATE INDEX IF NOT EXISTS idx_rel_invoices_customer      ON rel_invoices (customer_id);
CREATE INDEX IF NOT EXISTS idx_rel_purchase_orders_supplier ON rel_purchase_orders (supplier_id);
CREATE INDEX IF NOT EXISTS idx_rel_credit_notes_customer  ON rel_credit_notes (customer_id);
CREATE INDEX IF NOT EXISTS idx_rel_credit_notes_supplier  ON rel_credit_notes (supplier_id);

-- =============================================================================
-- updated_at triggers (reuses update_updated_at() if schema.sql was ever
-- applied; defined fresh here too since schema.sql is NOT part of the
-- migration runner and may not exist in a given environment — see
-- backend/src/db/migrate.ts / database/schema.sql's own header).
-- =============================================================================
CREATE OR REPLACE FUNCTION rel_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'rel_customers','rel_suppliers','rel_inventory_items','rel_quick_rate_items',
    'rel_quotes','rel_jobs','rel_invoices','rel_payments','rel_credit_notes',
    'rel_purchase_orders','rel_employees','rel_leave_requests','rel_disciplinary_records'
  ]
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%I_touch ON %I; CREATE TRIGGER trg_%I_touch BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION rel_touch_updated_at();',
      t, t, t, t
    );
  END LOOP;
END $$;
