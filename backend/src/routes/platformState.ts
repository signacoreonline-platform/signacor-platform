import { Router, Request, Response } from 'express';
import { query } from '../db/pool';

/**
 * /api/platform-state
 *
 * Stores the entire dashboard JSON state in PostgreSQL.
 * Single-row table (id = 1) holding a JSONB blob — see
 * database/migrations/001_platform_state.sql.
 *
 * The static dashboard (root index.html) calls these endpoints to
 * load and save its full state. The database is the source of truth;
 * localStorage in the browser is only an emergency fallback.
 */
const router = Router();

// GET /api/platform-state — returns { data: <jsonb>, updated_at: <iso> }
router.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await query(
      'SELECT data, updated_at FROM platform_state WHERE id = 1'
    );

    if (result.rowCount === 0) {
      // No row yet — create the seed row and return empty data.
      await query(
        `INSERT INTO platform_state (id, data)
         VALUES (1, '{}'::jsonb)
         ON CONFLICT (id) DO NOTHING`
      );
      res.json({ data: {}, updated_at: null });
      return;
    }

    const row = result.rows[0];
    res.json({ data: row.data ?? {}, updated_at: row.updated_at });
  } catch (err) {
    console.error('GET /api/platform-state failed:', err);
    res.status(500).json({ error: 'Failed to load platform state' });
  }
});

// PUT /api/platform-state — body: { data: <any-json> }
router.put('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const body = req.body || {};
    if (!('data' in body)) {
      res.status(400).json({ error: 'Request body must include "data"' });
      return;
    }

    const data = body.data;
    // UPSERT into id = 1
    await query(
      `INSERT INTO platform_state (id, data, updated_at)
       VALUES (1, $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE
         SET data = EXCLUDED.data,
             updated_at = NOW()`,
      [JSON.stringify(data)]
    );

    res.json({ success: true, data });
  } catch (err) {
    console.error('PUT /api/platform-state failed:', err);
    res.status(500).json({ error: 'Failed to save platform state' });
  }
});

export default router;
