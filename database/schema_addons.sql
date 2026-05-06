-- =============================================================================
-- SCHEMA ADDITIONS — Inventory, Stock Movements, Import Shipments
-- Run AFTER schema.sql
-- =============================================================================

-- ── Update cost_category enum to 8 categories ────────────────────────────────
-- NOTE: In PostgreSQL you cannot remove enum values easily.
-- We add the two new values to the existing enum.
ALTER TYPE cost_category ADD VALUE IF NOT EXISTS 'subcontract';
ALTER TYPE cost_category ADD VALUE IF NOT EXISTS 'other';

-- ── INVENTORY — stock quantities and reorder levels ───────────────────────────
-- Extend materials table with stock tracking
ALTER TABLE materials
  ADD COLUMN IF NOT EXISTS stock_qty       NUMERIC(12,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reorder_level   NUMERIC(12,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS location        VARCHAR(100),
  ADD COLUMN IF NOT EXISTS barcode         VARCHAR(100),
  ADD COLUMN IF NOT EXISTS last_received   TIMESTAMPTZ;

-- ── STOCK MOVEMENTS ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_movements (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  material_id     UUID NOT NULL REFERENCES materials(id),
  movement_type   VARCHAR(20) NOT NULL CHECK (movement_type IN ('in','out','adjustment','write_off')),
  quantity        NUMERIC(12,4) NOT NULL,
  unit_cost       NUMERIC(12,4),
  total_value     NUMERIC(14,2) GENERATED ALWAYS AS (quantity * COALESCE(unit_cost, 0)) STORED,
  reference       VARCHAR(100),  -- PO number, job number, etc.
  job_id          UUID REFERENCES jobs(id),
  notes           TEXT,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_material ON stock_movements(material_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_job      ON stock_movements(job_id);

-- Stock movement trigger: update materials.stock_qty automatically
CREATE OR REPLACE FUNCTION update_stock_qty()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.movement_type IN ('in') THEN
    UPDATE materials SET stock_qty = stock_qty + NEW.quantity, last_received = NOW() WHERE id = NEW.material_id;
  ELSIF NEW.movement_type IN ('out','write_off') THEN
    UPDATE materials SET stock_qty = stock_qty - NEW.quantity WHERE id = NEW.material_id;
  ELSIF NEW.movement_type = 'adjustment' THEN
    -- quantity can be positive or negative
    UPDATE materials SET stock_qty = stock_qty + NEW.quantity WHERE id = NEW.material_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_stock_movement ON stock_movements;
CREATE TRIGGER trg_stock_movement
  AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION update_stock_qty();

-- ── IMPORT SHIPMENTS (Uniontech Holdings) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS import_shipments (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reference               VARCHAR(50) NOT NULL UNIQUE,
  supplier_name           VARCHAR(200) NOT NULL,
  origin_country          VARCHAR(100),
  invoice_currency        VARCHAR(10) NOT NULL DEFAULT 'USD',
  invoice_amount_foreign  NUMERIC(14,4) NOT NULL,
  exchange_rate           NUMERIC(12,6) NOT NULL,
  invoice_amount_zar      NUMERIC(14,2) NOT NULL,  -- foreign × rate
  freight_cost            NUMERIC(14,2) NOT NULL DEFAULT 0,
  insurance_cost          NUMERIC(14,2) NOT NULL DEFAULT 0,
  customs_duty_rate       NUMERIC(6,4) NOT NULL DEFAULT 0.20, -- e.g. 0.20 = 20%
  customs_duty_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,   -- computed: CIF × rate
  vat_on_import           NUMERIC(14,2) NOT NULL DEFAULT 0,   -- 15% on (CIF + duty)
  agent_fees              NUMERIC(14,2) NOT NULL DEFAULT 0,
  clearing_fees           NUMERIC(14,2) NOT NULL DEFAULT 0,
  inland_transport        NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_landed_cost       NUMERIC(14,2) NOT NULL DEFAULT 0,
  landed_cost_factor      NUMERIC(8,6) NOT NULL DEFAULT 1,    -- total / invoice_zar
  arrival_date            DATE,
  status                  VARCHAR(30) NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','in_transit','customs','received','cancelled')),
  notes                   TEXT,
  created_by              UUID REFERENCES users(id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_import_shipments_status ON import_shipments(status);

-- Link shipment line items to materials
CREATE TABLE IF NOT EXISTS import_shipment_items (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shipment_id   UUID NOT NULL REFERENCES import_shipments(id) ON DELETE CASCADE,
  material_id   UUID REFERENCES materials(id),
  description   VARCHAR(300) NOT NULL,
  quantity      NUMERIC(12,4) NOT NULL,
  unit          VARCHAR(20) NOT NULL DEFAULT 'each',
  unit_cost_foreign NUMERIC(12,4) NOT NULL,
  unit_cost_zar     NUMERIC(12,4) NOT NULL,
  unit_landed_cost  NUMERIC(12,4),   -- unit_cost_zar × landed_cost_factor
  total_landed_cost NUMERIC(14,2)
);

CREATE TRIGGER trg_import_shipments_updated
  BEFORE UPDATE ON import_shipments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── WHOLESALE PRICE TIERS (Signacore to external clients) ────────────────────
CREATE TABLE IF NOT EXISTS price_tiers (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            VARCHAR(100) NOT NULL, -- e.g. 'Group', 'Trade', 'Retail'
  description     TEXT,
  discount_rate   NUMERIC(5,4) NOT NULL DEFAULT 0, -- 0.20 = 20% discount off sell price
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO price_tiers (name, description, discount_rate) VALUES
  ('Group',  'Internal group companies — cost price',                 0),
  ('Trade',  'Registered trade customers — 15% below retail',        0.15),
  ('Retail', 'Standard retail pricing',                               0),
  ('Premium','Premium/branded products — 10% above standard retail',  -0.10)
ON CONFLICT DO NOTHING;

-- ── EXTENDED JOB COST CATEGORIES VIEW ────────────────────────────────────────
-- Re-create the profit summary view to include all 8 cost categories
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

  COALESCE(SUM(CASE WHEN jc.category = 'materials'         THEN jc.total_cost ELSE 0 END), 0) AS cost_materials,
  COALESCE(SUM(CASE WHEN jc.category = 'labour'            THEN jc.total_cost ELSE 0 END), 0) AS cost_labour,
  COALESCE(SUM(CASE WHEN jc.category = 'machine_time'      THEN jc.total_cost ELSE 0 END), 0) AS cost_machine_time,
  COALESCE(SUM(CASE WHEN jc.category = 'design'            THEN jc.total_cost ELSE 0 END), 0) AS cost_design,
  COALESCE(SUM(CASE WHEN jc.category = 'delivery'          THEN jc.total_cost ELSE 0 END), 0) AS cost_delivery,
  COALESCE(SUM(CASE WHEN jc.category = 'franchise_royalty' THEN jc.total_cost ELSE 0 END), 0) AS cost_royalty,
  COALESCE(SUM(CASE WHEN jc.category = 'subcontract'       THEN jc.total_cost ELSE 0 END), 0) AS cost_subcontract,
  COALESCE(SUM(CASE WHEN jc.category = 'other'             THEN jc.total_cost ELSE 0 END), 0) AS cost_other,

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
