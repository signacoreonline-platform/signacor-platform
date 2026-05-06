import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { query } from '../db/pool';

const router = Router();
router.use(authenticate);

// ── MATERIALS ────────────────────────────────────────────────────────────────

router.get('/materials', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { search, category, limit = 100, offset = 0 } = req.query;
    const conditions: string[] = ['is_active = true'];
    const params: unknown[] = [];
    let p = 1;
    if (search) {
      conditions.push(`(name ILIKE $${p} OR sku ILIKE $${p} OR description ILIKE $${p})`);
      params.push(`%${search}%`); p++;
    }
    if (category) { conditions.push(`category = $${p++}`); params.push(category); }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const result = await query(
      `SELECT * FROM materials ${where} ORDER BY category, name LIMIT $${p++} OFFSET $${p++}`,
      [...params, limit, offset]
    );
    const count = await query(`SELECT COUNT(*) FROM materials ${where}`, params);
    res.json({ materials: result.rows, total: parseInt(count.rows[0].count) });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

router.get('/materials/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [matRes, movRes] = await Promise.all([
      query('SELECT * FROM materials WHERE id = $1', [req.params.id]),
      query(`SELECT sm.*, u.first_name || ' ' || u.last_name AS created_by_name
             FROM stock_movements sm
             LEFT JOIN users u ON u.id = sm.created_by
             WHERE sm.material_id = $1 ORDER BY sm.created_at DESC LIMIT 50`, [req.params.id]),
    ]);
    if (!matRes.rows[0]) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ ...matRes.rows[0], movements: movRes.rows });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

router.post('/materials', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { sku, name, description, unit, cost_price, sell_price, roll_width_m, category, stock_qty, reorder_level, location } = req.body;
    // Find Signacore company ID
    const coRes = await query(`SELECT id FROM companies WHERE role = 'supplier' LIMIT 1`);
    const supplier_id = coRes.rows[0]?.id;
    const result = await query(
      `INSERT INTO materials (supplier_id, sku, name, description, unit, cost_price, sell_price, roll_width_m, category, stock_qty, reorder_level, location)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [supplier_id, sku || null, name, description || null, unit || 'm2', cost_price || 0, sell_price || 0,
       roll_width_m || null, category || 'other', stock_qty || 0, reorder_level || 0, location || null]
    );
    res.status(201).json(result.rows[0]);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

router.patch('/materials/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const fields = ['sku','name','description','unit','cost_price','sell_price','roll_width_m','category','reorder_level','location','is_active'];
    const updates: string[] = []; const params: unknown[] = []; let p = 1;
    for (const f of fields) if (req.body[f] !== undefined) { updates.push(`${f} = $${p++}`); params.push(req.body[f]); }
    if (!updates.length) { res.status(400).json({ error: 'No fields to update' }); return; }
    params.push(req.params.id);
    const result = await query(`UPDATE materials SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`, params);
    res.json(result.rows[0]);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// ── STOCK MOVEMENTS ──────────────────────────────────────────────────────────

router.get('/movements', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { material_id, job_id, limit = 100 } = req.query;
    const conditions: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    if (material_id) { conditions.push(`sm.material_id = $${p++}`); params.push(material_id); }
    if (job_id) { conditions.push(`sm.job_id = $${p++}`); params.push(job_id); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await query(
      `SELECT sm.*, m.name AS material_name, m.unit,
              u.first_name || ' ' || u.last_name AS created_by_name
       FROM stock_movements sm
       JOIN materials m ON m.id = sm.material_id
       LEFT JOIN users u ON u.id = sm.created_by
       ${where}
       ORDER BY sm.created_at DESC LIMIT $${p}`,
      [...params, limit]
    );
    res.json(result.rows);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

router.post('/movements', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { material_id, movement_type, quantity, unit_cost, reference, job_id, notes } = req.body;
    // Validate stock doesn't go negative for 'out'
    if (['out','write_off'].includes(movement_type)) {
      const matRes = await query('SELECT stock_qty FROM materials WHERE id = $1', [material_id]);
      if ((matRes.rows[0]?.stock_qty ?? 0) < quantity) {
        res.status(400).json({ error: 'Insufficient stock' });
        return;
      }
    }
    const result = await query(
      `INSERT INTO stock_movements (material_id, movement_type, quantity, unit_cost, reference, job_id, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [material_id, movement_type, quantity, unit_cost || null, reference || null, job_id || null, notes || null, req.user?.id]
    );
    res.status(201).json(result.rows[0]);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// Low stock report
router.get('/low-stock', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await query(
      `SELECT * FROM materials WHERE stock_qty <= reorder_level AND is_active = true ORDER BY (stock_qty - reorder_level) ASC`
    );
    res.json(result.rows);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

export default router;
