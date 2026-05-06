import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { query } from '../db/pool';

const router = Router();
router.use(authenticate);

// GET /api/jobs — list with filters
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { status, client_id, company_id, search, limit = 50, offset = 0 } = req.query;
    const conditions: string[] = [];
    const params: unknown[] = [];
    let p = 1;

    if (status) { conditions.push(`j.status = $${p++}`); params.push(status); }
    if (client_id) { conditions.push(`j.client_id = $${p++}`); params.push(client_id); }
    if (company_id) { conditions.push(`j.primary_company_id = $${p++}`); params.push(company_id); }
    if (search) {
      conditions.push(`(j.title ILIKE $${p} OR j.job_number ILIKE $${p} OR c.company_name ILIKE $${p})`);
      params.push(`%${search}%`);
      p++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `
      SELECT j.*, c.company_name AS client_name,
             u.first_name || ' ' || u.last_name AS assigned_to_name,
             COALESCE(jps.total_cost, 0) AS total_cost,
             COALESCE(jps.gross_profit, 0) AS gross_profit,
             COALESCE(jps.margin_percent, 0) AS margin_percent
      FROM jobs j
      JOIN clients c ON c.id = j.client_id
      LEFT JOIN users u ON u.id = j.assigned_to
      LEFT JOIN job_profit_summary jps ON jps.id = j.id
      ${where}
      ORDER BY j.created_at DESC
      LIMIT $${p++} OFFSET $${p++}
    `;
    params.push(limit, offset);
    const result = await query(sql, params);

    const countSql = `
      SELECT COUNT(*) FROM jobs j JOIN clients c ON c.id = j.client_id ${where}
    `;
    const countResult = await query(countSql, params.slice(0, -2));

    res.json({ jobs: result.rows, total: parseInt(countResult.rows[0].count) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/jobs/:id
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [jobRes, costsRes, historyRes, quotesRes, invoicesRes] = await Promise.all([
      query(`
        SELECT j.*, c.company_name AS client_name, c.contact_person, c.email AS client_email,
               c.phone AS client_phone,
               u.first_name || ' ' || u.last_name AS assigned_to_name,
               jps.cost_materials, jps.cost_labour, jps.cost_machine_time,
               jps.cost_design, jps.cost_delivery, jps.cost_royalty,
               jps.total_cost, jps.gross_profit, jps.margin_percent
        FROM jobs j
        JOIN clients c ON c.id = j.client_id
        LEFT JOIN users u ON u.id = j.assigned_to
        LEFT JOIN job_profit_summary jps ON jps.id = j.id
        WHERE j.id = $1
      `, [req.params.id]),
      query(`SELECT jc.*, m.name AS material_name, mc.name AS machine_name
             FROM job_costs jc
             LEFT JOIN materials m ON m.id = jc.material_id
             LEFT JOIN machines mc ON mc.id = jc.machine_id
             WHERE jc.job_id = $1 ORDER BY jc.category, jc.created_at`, [req.params.id]),
      query(`SELECT jsh.*, u.first_name || ' ' || u.last_name AS changed_by_name
             FROM job_stage_history jsh
             LEFT JOIN users u ON u.id = jsh.changed_by
             WHERE jsh.job_id = $1 ORDER BY jsh.changed_at DESC`, [req.params.id]),
      query(`SELECT * FROM quotes WHERE job_id = $1 ORDER BY created_at DESC`, [req.params.id]),
      query(`SELECT * FROM invoices WHERE job_id = $1 ORDER BY created_at DESC`, [req.params.id]),
    ]);

    if (!jobRes.rows[0]) { res.status(404).json({ error: 'Job not found' }); return; }
    res.json({
      ...jobRes.rows[0],
      costs: costsRes.rows,
      stage_history: historyRes.rows,
      quotes: quotesRes.rows,
      invoices: invoicesRes.rows,
    });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/jobs
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const {
      title, client_id, primary_company_id, assigned_to, description,
      location, deadline, quote_amount, has_installation, has_vehicle_wrap, has_vinyl_work,
    } = req.body;

    const numResult = await query(
      `SELECT 'SGR-' || LPAD(nextval('job_number_seq')::text, 5, '0') AS job_number`
    );
    const job_number = numResult.rows[0].job_number;

    const result = await query(
      `INSERT INTO jobs (
        job_number, title, client_id, primary_company_id, assigned_to,
        description, location, deadline, quote_amount, has_installation,
        has_vehicle_wrap, has_vinyl_work, status, lead_date, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'lead',NOW(),$13)
      RETURNING *`,
      [job_number, title, client_id, primary_company_id, assigned_to || null,
       description || null, location || null, deadline || null,
       quote_amount || 0, has_installation || false, has_vehicle_wrap || false,
       has_vinyl_work || false, req.user?.id || null]
    );

    // Add stage history entry
    await query(
      `INSERT INTO job_stage_history (job_id, to_status, changed_by, notes)
       VALUES ($1, 'lead', $2, 'Job created')`,
      [result.rows[0].id, req.user?.id]
    );

    res.status(201).json(result.rows[0]);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/jobs/:id — update job
router.patch('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const fields = [
      'title','description','location','deadline','quote_amount',
      'deposit_amount','deposit_received','invoice_amount','amount_paid',
      'assigned_to','special_instructions','internal_notes',
      'has_installation','has_vehicle_wrap','has_vinyl_work','royalty_rate',
    ];
    const updates: string[] = [];
    const params: unknown[] = [];
    let p = 1;

    for (const field of fields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = $${p++}`);
        params.push(req.body[field]);
      }
    }
    if (!updates.length) { res.status(400).json({ error: 'No fields to update' }); return; }

    params.push(req.params.id);
    const result = await query(
      `UPDATE jobs SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`,
      params
    );
    if (!result.rows[0]) { res.status(404).json({ error: 'Job not found' }); return; }
    res.json(result.rows[0]);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/jobs/:id/status — advance lifecycle stage
router.patch('/:id/status', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { status, notes } = req.body;
    const jobRes = await query('SELECT * FROM jobs WHERE id = $1', [req.params.id]);
    if (!jobRes.rows[0]) { res.status(404).json({ error: 'Job not found' }); return; }

    const oldStatus = jobRes.rows[0].status;

    // Date field to set per stage
    const dateFields: Record<string, string> = {
      brief: 'brief_date',
      design: 'design_date',
      quote_sent: 'quote_date',
      quote_approved: 'quote_approved_date',
      deposit_received: 'deposit_date',
      in_production: 'production_start',
      installation: 'installation_date',
      invoiced: 'invoice_date',
    };

    const dateField = dateFields[status];
    const extraSet = dateField ? `, ${dateField} = NOW()` : '';

    const result = await query(
      `UPDATE jobs SET status = $1${extraSet} WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );

    await query(
      `INSERT INTO job_stage_history (job_id, from_status, to_status, changed_by, notes)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.params.id, oldStatus, status, req.user?.id, notes || null]
    );

    // Auto-calculate franchise royalty when invoiced
    if (status === 'invoiced') {
      const job = result.rows[0];
      const royaltyAmount = job.invoice_amount * job.royalty_rate;
      if (royaltyAmount > 0) {
        await query(
          `INSERT INTO job_costs (job_id, category, description, quantity, unit, unit_cost, is_actual, created_by)
           VALUES ($1, 'franchise_royalty', 'Franchise royalty (6% of revenue)', 1, 'lump sum', $2, true, $3)
           ON CONFLICT DO NOTHING`,
          [req.params.id, royaltyAmount, req.user?.id]
        );
      }
    }

    res.json(result.rows[0]);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/jobs/:id/costs — add cost entry
router.post('/:id/costs', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { category, description, quantity, unit, unit_cost, supplier_id, material_id, machine_id, is_actual, notes, invoice_ref } = req.body;
    const result = await query(
      `INSERT INTO job_costs (job_id, category, description, quantity, unit, unit_cost, supplier_id, material_id, machine_id, is_actual, notes, invoice_ref, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [req.params.id, category, description, quantity, unit, unit_cost,
       supplier_id || null, material_id || null, machine_id || null,
       is_actual || false, notes || null, invoice_ref || null, req.user?.id]
    );
    res.status(201).json(result.rows[0]);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/jobs/:id/costs/:costId
router.delete('/:id/costs/:costId', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await query('DELETE FROM job_costs WHERE id = $1 AND job_id = $2', [req.params.costId, req.params.id]);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/jobs/:id/profit
router.get('/:id/profit', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await query('SELECT * FROM job_profit_summary WHERE id = $1', [req.params.id]);
    if (!result.rows[0]) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(result.rows[0]);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
