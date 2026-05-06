import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { query } from '../db/pool';

const router = Router();
router.use(authenticate);

// GET /api/companies
router.get('/', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await query('SELECT * FROM companies WHERE is_active = true ORDER BY name');
    res.json(result.rows);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/companies/:id
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await query('SELECT * FROM companies WHERE id = $1', [req.params.id]);
    if (!result.rows[0]) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(result.rows[0]);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/companies/:id/summary
router.get('/:id/summary', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await query(
      `SELECT * FROM group_consolidated WHERE company_id = $1`,
      [req.params.id]
    );
    res.json(result.rows[0] || {});
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/companies/group/consolidated
router.get('/group/consolidated', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await query('SELECT * FROM group_consolidated ORDER BY company');
    res.json(result.rows);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
