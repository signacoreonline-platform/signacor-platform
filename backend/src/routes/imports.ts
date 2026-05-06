import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { query } from '../db/pool';

const router = Router();
router.use(authenticate);

// Helper: compute all landed cost values from inputs
function computeLandedCost(data: {
  invoice_amount_foreign: number;
  exchange_rate: number;
  freight_cost: number;
  insurance_cost: number;
  customs_duty_rate: number;
  agent_fees: number;
  clearing_fees: number;
  inland_transport: number;
}) {
  const invoiceZAR = data.invoice_amount_foreign * data.exchange_rate;
  const cif = invoiceZAR + data.freight_cost + data.insurance_cost;
  const customsDutyAmount = cif * data.customs_duty_rate;
  const vatOnImport = (cif + customsDutyAmount) * 0.15;
  const totalLandedCost = invoiceZAR + data.freight_cost + data.insurance_cost
    + customsDutyAmount + vatOnImport + data.agent_fees + data.clearing_fees + data.inland_transport;
  const landedCostFactor = invoiceZAR > 0 ? totalLandedCost / invoiceZAR : 1;
  return { invoiceZAR, customsDutyAmount, vatOnImport, totalLandedCost, landedCostFactor };
}

// GET /api/imports/shipments
router.get('/shipments', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await query(
      `SELECT * FROM import_shipments ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// GET /api/imports/shipments/:id
router.get('/shipments/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [shipRes, itemsRes] = await Promise.all([
      query('SELECT * FROM import_shipments WHERE id = $1', [req.params.id]),
      query(`SELECT isi.*, m.name AS material_name
             FROM import_shipment_items isi
             LEFT JOIN materials m ON m.id = isi.material_id
             WHERE isi.shipment_id = $1`, [req.params.id]),
    ]);
    if (!shipRes.rows[0]) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ ...shipRes.rows[0], items: itemsRes.rows });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// POST /api/imports/shipments
router.post('/shipments', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const {
      reference, supplier_name, origin_country, invoice_currency,
      invoice_amount_foreign, exchange_rate,
      freight_cost = 0, insurance_cost = 0, customs_duty_rate = 0.20,
      agent_fees = 0, clearing_fees = 0, inland_transport = 0,
      arrival_date, notes,
    } = req.body;

    const computed = computeLandedCost({
      invoice_amount_foreign, exchange_rate, freight_cost, insurance_cost,
      customs_duty_rate, agent_fees, clearing_fees, inland_transport,
    });

    const result = await query(
      `INSERT INTO import_shipments (
        reference, supplier_name, origin_country, invoice_currency,
        invoice_amount_foreign, exchange_rate, invoice_amount_zar,
        freight_cost, insurance_cost, customs_duty_rate, customs_duty_amount,
        vat_on_import, agent_fees, clearing_fees, inland_transport,
        total_landed_cost, landed_cost_factor, arrival_date, notes, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      RETURNING *`,
      [
        reference, supplier_name, origin_country || null, invoice_currency || 'USD',
        invoice_amount_foreign, exchange_rate, computed.invoiceZAR,
        freight_cost, insurance_cost, customs_duty_rate, computed.customsDutyAmount,
        computed.vatOnImport, agent_fees, clearing_fees, inland_transport,
        computed.totalLandedCost, computed.landedCostFactor,
        arrival_date || null, notes || null, req.user?.id,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'Reference already exists' });
      return;
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/imports/shipments/:id/status
router.patch('/shipments/:id/status', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { status } = req.body;
    const result = await query(
      `UPDATE import_shipments SET status = $1 WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );
    // If received, update any linked materials with new landed costs
    if (status === 'received') {
      await query(
        `UPDATE materials m
         SET cost_price = isi.unit_landed_cost, last_received = NOW()
         FROM import_shipment_items isi
         WHERE isi.shipment_id = $1 AND isi.material_id = m.id AND isi.unit_landed_cost IS NOT NULL`,
        [req.params.id]
      );
    }
    res.json(result.rows[0]);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// POST /api/imports/shipments/:id/items
router.post('/shipments/:id/items', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { material_id, description, quantity, unit, unit_cost_foreign } = req.body;
    const shipRes = await query('SELECT * FROM import_shipments WHERE id = $1', [req.params.id]);
    if (!shipRes.rows[0]) { res.status(404).json({ error: 'Shipment not found' }); return; }

    const ship = shipRes.rows[0];
    const unit_cost_zar = unit_cost_foreign * ship.exchange_rate;
    const unit_landed_cost = unit_cost_zar * ship.landed_cost_factor;
    const total_landed_cost = unit_landed_cost * quantity;

    const result = await query(
      `INSERT INTO import_shipment_items
        (shipment_id, material_id, description, quantity, unit, unit_cost_foreign, unit_cost_zar, unit_landed_cost, total_landed_cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.params.id, material_id || null, description, quantity, unit || 'each', unit_cost_foreign, unit_cost_zar, unit_landed_cost, total_landed_cost]
    );
    res.status(201).json(result.rows[0]);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// GET /api/imports/calculate — quick landed cost calculation (no save)
router.post('/calculate', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const {
      invoice_amount_foreign, exchange_rate,
      freight_cost = 0, insurance_cost = 0, customs_duty_rate = 0.20,
      agent_fees = 0, clearing_fees = 0, inland_transport = 0,
    } = req.body;
    const computed = computeLandedCost({
      invoice_amount_foreign, exchange_rate, freight_cost, insurance_cost,
      customs_duty_rate, agent_fees, clearing_fees, inland_transport,
    });
    res.json({
      invoice_zar: parseFloat(computed.invoiceZAR.toFixed(2)),
      cif: parseFloat((computed.invoiceZAR + freight_cost + insurance_cost).toFixed(2)),
      customs_duty: parseFloat(computed.customsDutyAmount.toFixed(2)),
      vat_on_import: parseFloat(computed.vatOnImport.toFixed(2)),
      total_landed_cost: parseFloat(computed.totalLandedCost.toFixed(2)),
      landed_cost_factor: parseFloat(computed.landedCostFactor.toFixed(6)),
    });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

export default router;
