import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { query } from '../db/pool';

const router = Router();
router.use(authenticate);

router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { from_company, to_company, job_id, status, limit = 50, offset = 0 } = req.query;
    const conditions: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    if (from_company) { conditions.push(`it.from_company_id = $${p++}`); params.push(from_company); }
    if (to_company) { conditions.push(`it.to_company_id = $${p++}`); params.push(to_company); }
    if (job_id) { conditions.push(`it.job_id = $${p++}`); params.push(job_id); }
    if (status) { conditions.push(`it.status = $${p++}`); params.push(status); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `
      SELECT it.*, fc.short_name AS from_company_name, tc.short_name AS to_company_name,
             j.job_number, j.title AS job_title
      FROM intercompany_transactions it
      JOIN companies fc ON fc.id = it.from_company_id
      JOIN companies tc ON tc.id = it.to_company_id
      LEFT JOIN jobs j ON j.id = it.job_id
      ${where}
      ORDER BY it.transaction_date DESC, it.created_at DESC
      LIMIT $${p++} OFFSET $${p++}
    `;
    const result = await query(sql, [...params, limit, offset]);
    const countResult = await query(
      `SELECT COUNT(*) FROM intercompany_transactions it ${where}`,
      params
    );
    res.json({ transactions: result.rows, total: parseInt(countResult.rows[0].count) });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

router.get('/summary', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await query(`
      SELECT
        fc.short_name AS from_company,
        tc.short_name AS to_company,
        COUNT(*) AS transaction_count,
        SUM(it.amount) AS total_amount,
        SUM(it.vat_amount) AS total_vat,
        SUM(it.total_amount) AS total_with_vat,
        SUM(CASE WHEN it.status = 'paid' THEN it.total_amount ELSE 0 END) AS paid_amount,
        SUM(CASE WHEN it.status != 'paid' THEN it.total_amount ELSE 0 END) AS outstanding_amount
      FROM intercompany_transactions it
      JOIN companies fc ON fc.id = it.from_company_id
      JOIN companies tc ON tc.id = it.to_company_id
      GROUP BY fc.short_name, tc.short_name
      ORDER BY total_amount DESC
    `);
    res.json(result.rows);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { from_company_id, to_company_id, job_id, transaction_type, amount, vat_rate = 0.15, description, reference_no, transaction_date, notes } = req.body;
    const vat_amount = amount * vat_rate;
    const total_amount = amount + vat_amount;

    const numRes = await query(`SELECT 'ICT-' || LPAD(nextval('job_number_seq')::text, 6, '0') AS num`);
    const transaction_no = numRes.rows[0].num;

    const result = await query(
      `INSERT INTO intercompany_transactions
        (transaction_no, from_company_id, to_company_id, job_id, transaction_type, amount, vat_amount, total_amount, description, reference_no, transaction_date, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [transaction_no, from_company_id, to_company_id, job_id || null, transaction_type, amount, vat_amount, total_amount, description, reference_no || null, transaction_date, notes || null, req.user?.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === '23514') {
      res.status(400).json({ error: 'Cannot create transaction to/from same company' });
      return;
    }
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/:id/status', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { status } = req.body;
    const result = await query(
      `UPDATE intercompany_transactions SET status = $1 WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );
    res.json(result.rows[0]);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

export default router;
