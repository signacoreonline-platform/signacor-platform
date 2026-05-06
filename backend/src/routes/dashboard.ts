import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { query } from '../db/pool';

const router = Router();
router.use(authenticate);

// GET /api/dashboard/overview — group-level KPIs
router.get('/overview', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [kpiRes, statusRes, monthlyRes, topJobsRes, consolidatedRes] = await Promise.all([
      // Overall KPIs
      query(`
        SELECT
          COUNT(DISTINCT j.id) AS total_jobs,
          COUNT(DISTINCT CASE WHEN j.status NOT IN ('invoiced','paid','cancelled') THEN j.id END) AS active_jobs,
          COALESCE(SUM(j.invoice_amount), 0) AS total_revenue,
          COALESCE(SUM(j.amount_paid), 0) AS total_collected,
          COALESCE(SUM(jc.total_cost), 0) AS total_costs,
          COALESCE(SUM(j.invoice_amount) - SUM(jc.total_cost), 0) AS gross_profit,
          CASE WHEN COALESCE(SUM(j.invoice_amount), 0) > 0
            THEN ROUND(((COALESCE(SUM(j.invoice_amount), 0) - COALESCE(SUM(jc.total_cost), 0))
                       / COALESCE(SUM(j.invoice_amount), 0)) * 100, 2)
            ELSE 0 END AS avg_margin
        FROM jobs j
        LEFT JOIN job_costs jc ON jc.job_id = j.id
        WHERE j.status != 'cancelled'
      `),
      // Jobs by status
      query(`
        SELECT status, COUNT(*) AS count,
               COALESCE(SUM(invoice_amount), 0) AS value
        FROM jobs WHERE status != 'cancelled'
        GROUP BY status ORDER BY status
      `),
      // Revenue by month (last 12 months)
      query(`
        SELECT
          DATE_TRUNC('month', invoice_date) AS month,
          COUNT(*) AS jobs,
          SUM(invoice_amount) AS revenue,
          SUM(invoice_amount - COALESCE((
            SELECT SUM(total_cost) FROM job_costs WHERE job_id = j.id
          ), 0)) AS profit
        FROM jobs j
        WHERE invoice_date >= NOW() - INTERVAL '12 months'
          AND status NOT IN ('cancelled')
        GROUP BY DATE_TRUNC('month', invoice_date)
        ORDER BY month
      `),
      // Top 10 jobs by revenue
      query(`
        SELECT j.id, j.job_number, j.title, j.status,
               c.company_name AS client_name,
               j.invoice_amount AS revenue,
               jps.gross_profit, jps.margin_percent
        FROM jobs j
        JOIN clients c ON c.id = j.client_id
        LEFT JOIN job_profit_summary jps ON jps.id = j.id
        WHERE j.status NOT IN ('cancelled')
        ORDER BY j.invoice_amount DESC LIMIT 10
      `),
      // Group consolidated
      query('SELECT * FROM group_consolidated'),
    ]);

    res.json({
      kpis: kpiRes.rows[0],
      jobs_by_status: statusRes.rows,
      monthly_revenue: monthlyRes.rows,
      top_jobs: topJobsRes.rows,
      group_consolidated: consolidatedRes.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/dashboard/pipeline — active jobs in pipeline
router.get('/pipeline', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await query(`
      SELECT j.id, j.job_number, j.title, j.status, j.deadline,
             c.company_name AS client_name, j.quote_amount,
             j.has_installation, j.has_vehicle_wrap, j.has_vinyl_work,
             u.first_name || ' ' || u.last_name AS assigned_to_name,
             jps.gross_profit, jps.margin_percent, jps.total_cost
      FROM jobs j
      JOIN clients c ON c.id = j.client_id
      LEFT JOIN users u ON u.id = j.assigned_to
      LEFT JOIN job_profit_summary jps ON jps.id = j.id
      WHERE j.status NOT IN ('paid','cancelled')
      ORDER BY j.deadline ASC NULLS LAST, j.created_at DESC
    `);
    res.json(result.rows);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// GET /api/dashboard/overdue — overdue invoices
router.get('/overdue', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await query(`
      SELECT i.*, c.company_name AS client_name, j.job_number, j.title AS job_title,
             (i.total - i.amount_paid) AS outstanding
      FROM invoices i
      JOIN jobs j ON j.id = i.job_id
      JOIN clients c ON c.id = i.issued_to
      WHERE i.due_date < NOW() AND i.status NOT IN ('paid','cancelled')
      ORDER BY i.due_date ASC
    `);
    res.json(result.rows);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

export default router;
