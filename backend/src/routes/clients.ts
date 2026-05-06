import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { query } from '../db/pool';

const router = Router();
router.use(authenticate);

router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { search, limit = 50, offset = 0 } = req.query;
    const params: unknown[] = [];
    const conditions: string[] = ['is_active = true'];
    let p = 1;
    if (search) {
      conditions.push(`(company_name ILIKE $${p} OR contact_person ILIKE $${p} OR email ILIKE $${p})`);
      params.push(`%${search}%`);
      p++;
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const result = await query(
      `SELECT * FROM clients ${where} ORDER BY company_name LIMIT $${p++} OFFSET $${p++}`,
      [...params, limit, offset]
    );
    const count = await query(`SELECT COUNT(*) FROM clients ${where}`, params);
    res.json({ clients: result.rows, total: parseInt(count.rows[0].count) });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [clientRes, jobsRes] = await Promise.all([
      query('SELECT * FROM clients WHERE id = $1', [req.params.id]),
      query(`SELECT j.id, j.job_number, j.title, j.status, j.invoice_amount,
                    j.invoice_date, jps.gross_profit, jps.margin_percent
             FROM jobs j LEFT JOIN job_profit_summary jps ON jps.id = j.id
             WHERE j.client_id = $1 ORDER BY j.created_at DESC`, [req.params.id]),
    ]);
    if (!clientRes.rows[0]) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ ...clientRes.rows[0], jobs: jobsRes.rows });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { company_name, trading_name, contact_person, email, phone, mobile, address, city, province, postal_code, vat_no, payment_terms, notes } = req.body;
    const result = await query(
      `INSERT INTO clients (company_name, trading_name, contact_person, email, phone, mobile, address, city, province, postal_code, vat_no, payment_terms, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [company_name, trading_name || null, contact_person || null, email || null, phone || null, mobile || null, address || null, city || null, province || null, postal_code || null, vat_no || null, payment_terms || 30, notes || null, req.user?.id]
    );
    res.status(201).json(result.rows[0]);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

router.patch('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const fields = ['company_name','trading_name','contact_person','email','phone','mobile','address','city','province','postal_code','vat_no','payment_terms','notes','is_active'];
    const updates: string[] = []; const params: unknown[] = []; let p = 1;
    for (const f of fields) if (req.body[f] !== undefined) { updates.push(`${f} = $${p++}`); params.push(req.body[f]); }
    if (!updates.length) { res.status(400).json({ error: 'No fields to update' }); return; }
    params.push(req.params.id);
    const result = await query(`UPDATE clients SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`, params);
    res.json(result.rows[0]);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

export default router;
