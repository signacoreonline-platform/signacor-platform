-- =============================================================================
-- SIGNACORE GROUP PLATFORM — PostgreSQL Schema
-- =============================================================================
-- Four companies:
--   1. Uniontech Holdings SA         (import/export)
--   2. Signacore National Supply Group (raw material warehouse/wholesale)
--   3. Signarama Garden Route         (signage franchise, main ops)
--   4. Cover X Transform              (labour subcontractor)
-- =============================================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================================
-- ENUMERATIONS
-- =============================================================================

CREATE TYPE company_role AS ENUM (
  'holding',
  'supplier',
  'franchise',
  'subcontractor'
);

CREATE TYPE job_status AS ENUM (
  'lead',
  'brief',
  'design',
  'quote_sent',
  'quote_approved',
  'deposit_received',
  'in_production',
  'installation',
  'completed',
  'invoiced',
  'paid',
  'cancelled'
);

CREATE TYPE cost_category AS ENUM (
  'materials',        -- from Signacore
  'labour',           -- Cover X Transform
  'machine_time',     -- in-house machines
  'design',           -- design work
  'delivery',         -- logistics
  'franchise_royalty' -- 6% of revenue
);

CREATE TYPE surface_type AS ENUM (
  'flat',
  'curved',
  'contour'
);

CREATE TYPE wrap_type AS ENUM (
  'full',
  'partial',
  'roof_only',
  'bonnet_only',
  'doors_only',
  'custom'
);

CREATE TYPE transaction_type AS ENUM (
  'invoice',
  'payment',
  'transfer',
  'adjustment',
  'intercompany_charge'
);

CREATE TYPE payment_status AS ENUM (
  'pending',
  'partial',
  'paid',
  'overdue',
  'cancelled'
);

CREATE TYPE quote_status AS ENUM (
  'draft',
  'sent',
  'approved',
  'declined',
  'expired'
);

-- =============================================================================
-- COMPANIES (4 entities in the group)
-- =============================================================================

CREATE TABLE companies (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            VARCHAR(200) NOT NULL,
  short_name      VARCHAR(50)  NOT NULL,
  registration_no VARCHAR(50),
  vat_no          VARCHAR(30),
  role            company_role NOT NULL,
  address         TEXT,
  city            VARCHAR(100),
  province        VARCHAR(50),
  postal_code     VARCHAR(10),
  phone           VARCHAR(30),
  email           VARCHAR(100),
  website         VARCHAR(200),
  logo_url        VARCHAR(500),
  bank_name       VARCHAR(100),
  bank_account    VARCHAR(30),
  bank_branch     VARCHAR(20),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the four group companies
INSERT INTO companies (name, short_name, registration_no, role, city, province) VALUES
  ('Uniontech Holdings SA', 'Uniontech', '2010/012345/07', 'holding', 'George', 'Western Cape'),
  ('Signacore National Supply Group', 'Signacore', '2015/023456/07', 'supplier', 'George', 'Western Cape'),
  ('Signarama Garden Route', 'Signarama GR', '2018/034567/07', 'franchise', 'George', 'Western Cape'),
  ('Cover X Transform', 'Cover X', '2020/045678/07', 'subcontractor', 'George', 'Western Cape');

-- =============================================================================
-- USERS / STAFF
-- =============================================================================

CREATE TABLE users (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id   UUID NOT NULL REFERENCES companies(id),
  email        VARCHAR(200) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  first_name   VARCHAR(100) NOT NULL,
  last_name    VARCHAR(100) NOT NULL,
  role         VARCHAR(50) NOT NULL DEFAULT 'staff', -- admin | manager | staff | designer | estimator
  phone        VARCHAR(30),
  avatar_url   VARCHAR(500),
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  last_login   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- CLIENTS / CONTACTS
-- =============================================================================

CREATE TABLE clients (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_name     VARCHAR(200) NOT NULL,
  trading_name     VARCHAR(200),
  contact_person   VARCHAR(150),
  email            VARCHAR(200),
  phone            VARCHAR(30),
  mobile           VARCHAR(30),
  address          TEXT,
  city             VARCHAR(100),
  province         VARCHAR(50),
  postal_code      VARCHAR(10),
  vat_no           VARCHAR(30),
  credit_limit     NUMERIC(12,2) DEFAULT 0,
  payment_terms    INTEGER DEFAULT 30, -- days
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  notes            TEXT,
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- PRODUCT / MATERIAL CATALOGUE (Signacore supplies)
-- =============================================================================

CREATE TABLE materials (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  supplier_id     UUID NOT NULL REFERENCES companies(id), -- always Signacore
  sku             VARCHAR(50) UNIQUE,
  name            VARCHAR(200) NOT NULL,
  description     TEXT,
  unit            VARCHAR(20) NOT NULL DEFAULT 'm2', -- m2, lm, each, kg, litre
  cost_price      NUMERIC(12,4) NOT NULL DEFAULT 0,
  sell_price      NUMERIC(12,4) NOT NULL DEFAULT 0,
  roll_width_m    NUMERIC(6,4),  -- for vinyl (typically 1.37)
  category        VARCHAR(100),  -- vinyl, substrate, ink, hardware, etc.
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- MACHINES / EQUIPMENT (for machine time costing)
-- =============================================================================

CREATE TABLE machines (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID NOT NULL REFERENCES companies(id),
  name            VARCHAR(200) NOT NULL,
  machine_type    VARCHAR(100), -- large_format_printer, cutter, router, laminator, etc.
  hourly_rate     NUMERIC(12,2) NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- JOBS (core entity — full lifecycle)
-- =============================================================================

CREATE TABLE jobs (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_number           VARCHAR(30) NOT NULL UNIQUE,
  title                VARCHAR(300) NOT NULL,
  client_id            UUID NOT NULL REFERENCES clients(id),
  primary_company_id   UUID NOT NULL REFERENCES companies(id), -- Signarama GR
  assigned_to          UUID REFERENCES users(id),
  status               job_status NOT NULL DEFAULT 'lead',

  -- Dates per lifecycle stage
  lead_date            DATE,
  brief_date           DATE,
  design_date          DATE,
  quote_date           DATE,
  quote_approved_date  DATE,
  deposit_date         DATE,
  production_start     DATE,
  production_end       DATE,
  installation_date    DATE,
  invoice_date         DATE,
  payment_date         DATE,
  deadline             DATE,

  -- Revenue
  quote_amount         NUMERIC(14,2) NOT NULL DEFAULT 0,
  deposit_amount       NUMERIC(14,2) NOT NULL DEFAULT 0,
  deposit_received     NUMERIC(14,2) NOT NULL DEFAULT 0,
  invoice_amount       NUMERIC(14,2) NOT NULL DEFAULT 0,
  amount_paid          NUMERIC(14,2) NOT NULL DEFAULT 0,

  -- Franchise royalty rate (default 6%)
  royalty_rate         NUMERIC(5,4) NOT NULL DEFAULT 0.06,

  -- Description / scope
  description          TEXT,
  location             TEXT,
  special_instructions TEXT,
  internal_notes       TEXT,

  -- Flags
  has_installation     BOOLEAN NOT NULL DEFAULT FALSE,
  has_vehicle_wrap     BOOLEAN NOT NULL DEFAULT FALSE,
  has_vinyl_work       BOOLEAN NOT NULL DEFAULT FALSE,

  created_by           UUID REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-increment job number sequence
CREATE SEQUENCE job_number_seq START 1000;

-- =============================================================================
-- JOB STAGE HISTORY (audit trail of status changes)
-- =============================================================================

CREATE TABLE job_stage_history (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id       UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  from_status  job_status,
  to_status    job_status NOT NULL,
  changed_by   UUID REFERENCES users(id),
  notes        TEXT,
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- JOB COST ENTRIES (6 categories)
-- =============================================================================

CREATE TABLE job_costs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  category        cost_category NOT NULL,
  supplier_id     UUID REFERENCES companies(id),   -- which group company supplies
  material_id     UUID REFERENCES materials(id),   -- optional if materials category
  machine_id      UUID REFERENCES machines(id),    -- optional if machine_time category
  description     VARCHAR(500) NOT NULL,
  quantity        NUMERIC(12,4) NOT NULL DEFAULT 1,
  unit            VARCHAR(20) NOT NULL DEFAULT 'each',
  unit_cost       NUMERIC(12,4) NOT NULL DEFAULT 0,
  total_cost      NUMERIC(14,2) GENERATED ALWAYS AS (quantity * unit_cost) STORED,
  invoice_ref     VARCHAR(100),  -- reference to supplier invoice
  is_actual       BOOLEAN NOT NULL DEFAULT FALSE, -- FALSE = estimated, TRUE = actual
  notes           TEXT,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- QUOTES
-- =============================================================================

CREATE TABLE quotes (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id           UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  quote_number     VARCHAR(30) NOT NULL UNIQUE,
  version          INTEGER NOT NULL DEFAULT 1,
  status           quote_status NOT NULL DEFAULT 'draft',
  subtotal         NUMERIC(14,2) NOT NULL DEFAULT 0,
  vat_rate         NUMERIC(5,4) NOT NULL DEFAULT 0.15, -- 15% VAT
  vat_amount       NUMERIC(14,2) NOT NULL DEFAULT 0,
  total            NUMERIC(14,2) NOT NULL DEFAULT 0,
  valid_until      DATE,
  notes            TEXT,
  terms            TEXT,
  sent_at          TIMESTAMPTZ,
  approved_at      TIMESTAMPTZ,
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE quote_line_items (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  quote_id        UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  description     VARCHAR(500) NOT NULL,
  quantity        NUMERIC(12,4) NOT NULL DEFAULT 1,
  unit            VARCHAR(20) NOT NULL DEFAULT 'each',
  unit_price      NUMERIC(12,4) NOT NULL DEFAULT 0,
  total_price     NUMERIC(14,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
  cost_category   cost_category,
  sort_order      INTEGER DEFAULT 0
);

-- =============================================================================
-- INVOICES
-- =============================================================================

CREATE TABLE invoices (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id           UUID NOT NULL REFERENCES jobs(id),
  invoice_number   VARCHAR(30) NOT NULL UNIQUE,
  issued_by        UUID NOT NULL REFERENCES companies(id), -- Signarama GR
  issued_to        UUID NOT NULL REFERENCES clients(id),
  issue_date       DATE NOT NULL,
  due_date         DATE NOT NULL,
  subtotal         NUMERIC(14,2) NOT NULL DEFAULT 0,
  vat_rate         NUMERIC(5,4) NOT NULL DEFAULT 0.15,
  vat_amount       NUMERIC(14,2) NOT NULL DEFAULT 0,
  total            NUMERIC(14,2) NOT NULL DEFAULT 0,
  amount_paid      NUMERIC(14,2) NOT NULL DEFAULT 0,
  status           payment_status NOT NULL DEFAULT 'pending',
  payment_ref      VARCHAR(100),
  notes            TEXT,
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- INTERCOMPANY TRANSACTIONS
-- =============================================================================

CREATE TABLE intercompany_transactions (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_no    VARCHAR(30) NOT NULL UNIQUE,
  from_company_id   UUID NOT NULL REFERENCES companies(id),
  to_company_id     UUID NOT NULL REFERENCES companies(id),
  job_id            UUID REFERENCES jobs(id),  -- linked job if applicable
  transaction_type  transaction_type NOT NULL,
  amount            NUMERIC(14,2) NOT NULL,
  vat_amount        NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_amount      NUMERIC(14,2) NOT NULL,
  description       TEXT NOT NULL,
  reference_no      VARCHAR(100),
  transaction_date  DATE NOT NULL,
  status            payment_status NOT NULL DEFAULT 'pending',
  notes             TEXT,
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT no_self_transaction CHECK (from_company_id != to_company_id)
);

-- =============================================================================
-- ARCHITECTURAL VINYL CALCULATOR — SAVED CALCULATIONS
-- =============================================================================

CREATE TABLE vinyl_calculations (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id            UUID REFERENCES jobs(id),
  created_by        UUID REFERENCES users(id),
  name              VARCHAR(200),
  surface_type      surface_type NOT NULL DEFAULT 'flat',

  -- Dimensions
  width_mm          NUMERIC(10,2) NOT NULL,
  height_mm         NUMERIC(10,2) NOT NULL,
  quantity          INTEGER NOT NULL DEFAULT 1,

  -- Roll spec
  roll_width_m      NUMERIC(6,4) NOT NULL DEFAULT 1.37,
  roll_length_m     NUMERIC(8,2),

  -- Waste factors per surface type
  -- flat=1.10, curved=1.20, contour=1.35
  waste_factor      NUMERIC(6,4) NOT NULL DEFAULT 1.10,

  -- Calculated outputs
  area_m2           NUMERIC(10,4),         -- raw area
  area_with_waste   NUMERIC(10,4),         -- area × waste_factor
  panels_required   INTEGER,               -- number of roll panels
  roll_length_used  NUMERIC(10,4),         -- linear metres from roll
  vinyl_cost        NUMERIC(12,2),
  laminate_cost     NUMERIC(12,2),
  total_material_cost NUMERIC(12,2),

  -- Pricing
  sell_price_per_m2 NUMERIC(12,2),
  total_sell_price  NUMERIC(12,2),
  margin_percent    NUMERIC(6,2),

  material_id       UUID REFERENCES materials(id),
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- VEHICLE WRAP CALCULATOR — SAVED CALCULATIONS
-- =============================================================================

CREATE TABLE vehicle_calculations (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id            UUID REFERENCES jobs(id),
  created_by        UUID REFERENCES users(id),
  name              VARCHAR(200),
  vehicle_make      VARCHAR(100),
  vehicle_model     VARCHAR(100),
  vehicle_year      INTEGER,
  wrap_type         wrap_type NOT NULL DEFAULT 'full',

  -- Standard panel dimensions (mm) — can be overridden per vehicle
  hood_w            NUMERIC(8,2) DEFAULT 1500,
  hood_h            NUMERIC(8,2) DEFAULT 1200,
  roof_w            NUMERIC(8,2) DEFAULT 1600,
  roof_h            NUMERIC(8,2) DEFAULT 1400,
  trunk_w           NUMERIC(8,2) DEFAULT 1500,
  trunk_h           NUMERIC(8,2) DEFAULT 900,
  door_front_w      NUMERIC(8,2) DEFAULT 900,
  door_front_h      NUMERIC(8,2) DEFAULT 1100,
  door_rear_w       NUMERIC(8,2) DEFAULT 800,
  door_rear_h       NUMERIC(8,2) DEFAULT 1100,
  fender_front_w    NUMERIC(8,2) DEFAULT 700,
  fender_front_h    NUMERIC(8,2) DEFAULT 500,
  fender_rear_w     NUMERIC(8,2) DEFAULT 800,
  fender_rear_h     NUMERIC(8,2) DEFAULT 500,
  bumper_front_w    NUMERIC(8,2) DEFAULT 1800,
  bumper_front_h    NUMERIC(8,2) DEFAULT 450,
  bumper_rear_w     NUMERIC(8,2) DEFAULT 1800,
  bumper_rear_h     NUMERIC(8,2) DEFAULT 450,
  mirror_each_w     NUMERIC(8,2) DEFAULT 250,
  mirror_each_h     NUMERIC(8,2) DEFAULT 200,
  pillars_total_m2  NUMERIC(8,4) DEFAULT 0.5,
  custom_areas      JSONB,  -- [{label, w_mm, h_mm, qty}]

  -- Calculated outputs
  total_area_m2     NUMERIC(10,4),
  vinyl_area_m2     NUMERIC(10,4),   -- with 15% wrap waste
  panels_required   INTEGER,
  roll_length_m     NUMERIC(10,4),
  vinyl_cost        NUMERIC(12,2),
  laminate_cost     NUMERIC(12,2),
  labour_hours      NUMERIC(8,2),
  labour_cost       NUMERIC(12,2),
  total_cost        NUMERIC(12,2),
  sell_price        NUMERIC(12,2),
  margin_percent    NUMERIC(6,2),

  material_id       UUID REFERENCES materials(id),
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- PROFIT SUMMARY VIEW
-- =============================================================================

CREATE OR REPLACE VIEW job_profit_summary AS
SELECT
  j.id,
  j.job_number,
  j.title,
  j.status,
  j.client_id,
  c.company_name AS client_name,
  j.primary_company_id,
  j.invoice_amount AS revenue,
  j.amount_paid,

  -- Cost breakdowns by category
  COALESCE(SUM(CASE WHEN jc.category = 'materials'        THEN jc.total_cost ELSE 0 END), 0) AS cost_materials,
  COALESCE(SUM(CASE WHEN jc.category = 'labour'           THEN jc.total_cost ELSE 0 END), 0) AS cost_labour,
  COALESCE(SUM(CASE WHEN jc.category = 'machine_time'     THEN jc.total_cost ELSE 0 END), 0) AS cost_machine_time,
  COALESCE(SUM(CASE WHEN jc.category = 'design'           THEN jc.total_cost ELSE 0 END), 0) AS cost_design,
  COALESCE(SUM(CASE WHEN jc.category = 'delivery'         THEN jc.total_cost ELSE 0 END), 0) AS cost_delivery,
  COALESCE(SUM(CASE WHEN jc.category = 'franchise_royalty' THEN jc.total_cost ELSE 0 END), 0) AS cost_royalty,

  -- Totals
  COALESCE(SUM(jc.total_cost), 0) AS total_cost,
  j.invoice_amount - COALESCE(SUM(jc.total_cost), 0) AS gross_profit,
  CASE
    WHEN j.invoice_amount > 0
    THEN ROUND(((j.invoice_amount - COALESCE(SUM(jc.total_cost), 0)) / j.invoice_amount) * 100, 2)
    ELSE 0
  END AS margin_percent,

  j.invoice_date,
  j.deadline,
  j.created_at

FROM jobs j
JOIN clients c ON c.id = j.client_id
LEFT JOIN job_costs jc ON jc.job_id = j.id
GROUP BY j.id, c.company_name;

-- =============================================================================
-- GROUP CONSOLIDATED VIEW
-- =============================================================================

CREATE OR REPLACE VIEW group_consolidated AS
SELECT
  comp.id AS company_id,
  comp.short_name AS company,
  comp.role,
  COUNT(DISTINCT j.id) AS total_jobs,
  COALESCE(SUM(j.invoice_amount), 0) AS total_revenue,
  COALESCE(SUM(jc_totals.total_costs), 0) AS total_costs,
  COALESCE(SUM(j.invoice_amount), 0) - COALESCE(SUM(jc_totals.total_costs), 0) AS gross_profit,
  CASE
    WHEN COALESCE(SUM(j.invoice_amount), 0) > 0
    THEN ROUND(((COALESCE(SUM(j.invoice_amount), 0) - COALESCE(SUM(jc_totals.total_costs), 0))
         / COALESCE(SUM(j.invoice_amount), 0)) * 100, 2)
    ELSE 0
  END AS margin_percent
FROM companies comp
LEFT JOIN jobs j ON j.primary_company_id = comp.id AND j.status != 'cancelled'
LEFT JOIN (
  SELECT job_id, SUM(total_cost) AS total_costs FROM job_costs GROUP BY job_id
) jc_totals ON jc_totals.job_id = j.id
GROUP BY comp.id, comp.short_name, comp.role;

-- =============================================================================
-- INDEXES
-- =============================================================================

CREATE INDEX idx_jobs_status          ON jobs(status);
CREATE INDEX idx_jobs_client          ON jobs(client_id);
CREATE INDEX idx_jobs_company         ON jobs(primary_company_id);
CREATE INDEX idx_jobs_deadline        ON jobs(deadline);
CREATE INDEX idx_jobs_invoice_date    ON jobs(invoice_date);
CREATE INDEX idx_job_costs_job        ON job_costs(job_id);
CREATE INDEX idx_job_costs_category   ON job_costs(category);
CREATE INDEX idx_intercompany_from    ON intercompany_transactions(from_company_id);
CREATE INDEX idx_intercompany_to      ON intercompany_transactions(to_company_id);
CREATE INDEX idx_intercompany_job     ON intercompany_transactions(job_id);
CREATE INDEX idx_invoices_job         ON invoices(job_id);
CREATE INDEX idx_stage_history_job    ON job_stage_history(job_id);

-- =============================================================================
-- UPDATED_AT TRIGGER
-- =============================================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_companies_updated BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_users_updated     BEFORE UPDATE ON users     FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_clients_updated   BEFORE UPDATE ON clients   FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_jobs_updated      BEFORE UPDATE ON jobs      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_job_costs_updated BEFORE UPDATE ON job_costs FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_quotes_updated    BEFORE UPDATE ON quotes    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_invoices_updated  BEFORE UPDATE ON invoices  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_intercompany_upd  BEFORE UPDATE ON intercompany_transactions FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_materials_updated BEFORE UPDATE ON materials FOR EACH ROW EXECUTE FUNCTION update_updated_at();
