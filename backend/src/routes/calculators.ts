import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { query } from '../db/pool';

const router = Router();
router.use(authenticate);

// ============================================================
// VINYL CALCULATOR
// ============================================================

// Waste factors per surface type
const WASTE_FACTORS: Record<string, number> = {
  flat: 1.10,
  curved: 1.20,
  contour: 1.35,
};

router.post('/vinyl/calculate', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const {
      width_mm, height_mm, quantity = 1,
      surface_type = 'flat',
      roll_width_m = 1.37,
      vinyl_cost_per_m2 = 0,
      laminate_cost_per_m2 = 0,
      sell_price_per_m2 = 0,
    } = req.body;

    const waste_factor = WASTE_FACTORS[surface_type] || 1.10;

    // Convert mm to m
    const width_m = width_mm / 1000;
    const height_m = height_mm / 1000;

    // Raw area per panel (m2)
    const area_per_unit = width_m * height_m;
    const total_area_m2 = area_per_unit * quantity;

    // Apply waste factor
    const area_with_waste = total_area_m2 * waste_factor;

    // How many side-by-side panels fit in a 1.37m roll?
    // We cut from roll: each panel occupies height_m of roll length
    // Panels per row = floor(roll_width / panel_width)
    const panels_per_row = Math.max(1, Math.floor(roll_width_m / width_m));
    const total_panels = quantity;
    const rows_needed = Math.ceil(total_panels / panels_per_row);
    const roll_length_used = rows_needed * height_m * waste_factor;

    // Costs
    const vinyl_cost = area_with_waste * vinyl_cost_per_m2;
    const laminate_cost = area_with_waste * laminate_cost_per_m2;
    const total_material_cost = vinyl_cost + laminate_cost;

    // Revenue
    const total_sell_price = area_with_waste * sell_price_per_m2;
    const margin_percent = total_sell_price > 0
      ? ((total_sell_price - total_material_cost) / total_sell_price) * 100
      : 0;

    res.json({
      area_per_unit: parseFloat(area_per_unit.toFixed(4)),
      total_area_m2: parseFloat(total_area_m2.toFixed(4)),
      waste_factor,
      area_with_waste: parseFloat(area_with_waste.toFixed(4)),
      panels_per_row,
      rows_needed,
      roll_length_used: parseFloat(roll_length_used.toFixed(4)),
      vinyl_cost: parseFloat(vinyl_cost.toFixed(2)),
      laminate_cost: parseFloat(laminate_cost.toFixed(2)),
      total_material_cost: parseFloat(total_material_cost.toFixed(2)),
      total_sell_price: parseFloat(total_sell_price.toFixed(2)),
      margin_percent: parseFloat(margin_percent.toFixed(2)),
    });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

router.post('/vinyl/save', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const d = req.body;
    const result = await query(
      `INSERT INTO vinyl_calculations
        (job_id, created_by, name, surface_type, width_mm, height_mm, quantity, roll_width_m, waste_factor,
         area_m2, area_with_waste, panels_required, roll_length_used, vinyl_cost, laminate_cost,
         total_material_cost, sell_price_per_m2, total_sell_price, margin_percent, material_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING *`,
      [d.job_id || null, req.user?.id, d.name || null, d.surface_type, d.width_mm, d.height_mm,
       d.quantity, d.roll_width_m, d.waste_factor, d.total_area_m2, d.area_with_waste,
       d.rows_needed, d.roll_length_used, d.vinyl_cost, d.laminate_cost, d.total_material_cost,
       d.sell_price_per_m2, d.total_sell_price, d.margin_percent, d.material_id || null, d.notes || null]
    );
    res.status(201).json(result.rows[0]);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

router.get('/vinyl', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { job_id } = req.query;
    const sql = job_id
      ? 'SELECT * FROM vinyl_calculations WHERE job_id = $1 ORDER BY created_at DESC'
      : 'SELECT * FROM vinyl_calculations ORDER BY created_at DESC LIMIT 50';
    const params = job_id ? [job_id] : [];
    const result = await query(sql, params);
    res.json(result.rows);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// ============================================================
// VEHICLE WRAP CALCULATOR
// ============================================================

// Standard wrap areas in m2 for common panel types
// Values are computed from width_mm × height_mm defaults in the schema
const FULL_WRAP_STANDARD_M2 = {
  hood: (1500 * 1200) / 1e6,
  roof: (1600 * 1400) / 1e6,
  trunk: (1500 * 900) / 1e6,
  door_front: 2 * (900 * 1100) / 1e6,    // ×2 sides
  door_rear: 2 * (800 * 1100) / 1e6,
  fender_front: 2 * (700 * 500) / 1e6,
  fender_rear: 2 * (800 * 500) / 1e6,
  bumper_front: (1800 * 450) / 1e6,
  bumper_rear: (1800 * 450) / 1e6,
  mirrors: 2 * (250 * 200) / 1e6,
  pillars: 0.5,
};

router.post('/vehicle/calculate', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const {
      panels = {},           // override individual panel dims {hood: {w_mm, h_mm}, ...}
      custom_areas = [],     // [{label, w_mm, h_mm, qty}]
      wrap_type = 'full',
      vinyl_cost_per_m2 = 0,
      laminate_cost_per_m2 = 0,
      labour_rate_per_hour = 0,
      roll_width_m = 1.37,
      sell_price = 0,
    } = req.body;

    const WRAP_WASTE = 1.15; // 15% wrap waste

    // Calculate area per panel
    let total_area_m2 = 0;
    const panel_breakdown: Record<string, number> = {};

    if (wrap_type === 'full') {
      for (const [key, default_m2] of Object.entries(FULL_WRAP_STANDARD_M2)) {
        const override = (panels as Record<string, {w_mm: number, h_mm: number}>)[key];
        const panel_m2 = override
          ? (override.w_mm * override.h_mm) / 1e6
          : (default_m2 as number);
        panel_breakdown[key] = panel_m2;
        total_area_m2 += panel_m2;
      }
    } else {
      // For partial wraps, only count what's specified in panels
      for (const [key, dims] of Object.entries(panels as Record<string, {w_mm: number, h_mm: number}>)) {
        const panel_m2 = (dims.w_mm * dims.h_mm) / 1e6;
        panel_breakdown[key] = panel_m2;
        total_area_m2 += panel_m2;
      }
    }

    // Custom areas
    for (const area of custom_areas as {label: string, w_mm: number, h_mm: number, qty: number}[]) {
      const a_m2 = (area.w_mm * area.h_mm * (area.qty || 1)) / 1e6;
      panel_breakdown[area.label] = a_m2;
      total_area_m2 += a_m2;
    }

    const vinyl_area_m2 = total_area_m2 * WRAP_WASTE;

    // Roll layout
    const roll_length_m = vinyl_area_m2 / roll_width_m;

    // Labour estimate: full wrap ~8h, partial ~4h per side, custom ~proportional
    const labour_hours = wrap_type === 'full' ? 8 : Math.max(2, total_area_m2 * 1.5);

    // Costs
    const vinyl_cost = vinyl_area_m2 * vinyl_cost_per_m2;
    const laminate_cost = vinyl_area_m2 * laminate_cost_per_m2;
    const labour_cost = labour_hours * labour_rate_per_hour;
    const total_cost = vinyl_cost + laminate_cost + labour_cost;

    const margin_percent = sell_price > 0
      ? ((sell_price - total_cost) / sell_price) * 100
      : 0;

    res.json({
      panel_breakdown,
      total_area_m2: parseFloat(total_area_m2.toFixed(4)),
      vinyl_area_m2: parseFloat(vinyl_area_m2.toFixed(4)),
      roll_length_m: parseFloat(roll_length_m.toFixed(4)),
      labour_hours: parseFloat(labour_hours.toFixed(2)),
      vinyl_cost: parseFloat(vinyl_cost.toFixed(2)),
      laminate_cost: parseFloat(laminate_cost.toFixed(2)),
      labour_cost: parseFloat(labour_cost.toFixed(2)),
      total_cost: parseFloat(total_cost.toFixed(2)),
      margin_percent: parseFloat(margin_percent.toFixed(2)),
    });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

router.post('/vehicle/save', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const d = req.body;
    const result = await query(
      `INSERT INTO vehicle_calculations
        (job_id, created_by, name, vehicle_make, vehicle_model, vehicle_year, wrap_type,
         custom_areas, total_area_m2, vinyl_area_m2, roll_length_m,
         labour_hours, labour_cost, vinyl_cost, laminate_cost, total_cost, sell_price, margin_percent, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING *`,
      [d.job_id || null, req.user?.id, d.name || null, d.vehicle_make || null, d.vehicle_model || null,
       d.vehicle_year || null, d.wrap_type, d.custom_areas ? JSON.stringify(d.custom_areas) : null,
       d.total_area_m2, d.vinyl_area_m2, d.roll_length_m, d.labour_hours, d.labour_cost,
       d.vinyl_cost, d.laminate_cost, d.total_cost, d.sell_price || 0, d.margin_percent || 0, d.notes || null]
    );
    res.status(201).json(result.rows[0]);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

router.get('/vehicle', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { job_id } = req.query;
    const sql = job_id
      ? 'SELECT * FROM vehicle_calculations WHERE job_id = $1 ORDER BY created_at DESC'
      : 'SELECT * FROM vehicle_calculations ORDER BY created_at DESC LIMIT 50';
    const result = await query(sql, job_id ? [job_id] : []);
    res.json(result.rows);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

export default router;
