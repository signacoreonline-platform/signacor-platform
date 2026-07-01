import { Router, Request, Response } from 'express';
import { query } from '../db/pool';
import pool from '../db/pool';

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
//
// Every section of `data` is stored as a plain last-write-wins replace,
// EXCEPT `creditNotes`, which gets a small atomic merge below. Credit notes
// are a shared financial record any logged-in role (Admin, Accounts,
// Assistant) can create at any moment, and the frontend's optimistic save
// flow (GET latest → merge locally → PUT full state) has an unavoidable
// race: if two browsers/devices save around the same time, the second PUT
// can be built from a GET that was issued before the first PUT committed,
// so it silently overwrites the row with a creditNotes array that doesn't
// yet include the other session's brand-new note. That is the confirmed
// root cause of credit notes disappearing shortly after creation — no
// amount of client-side merging fully closes it, because the frontend's
// "freshest fetch" can still be stale relative to another session's
// in-flight write. Locking this row for the duration of the transaction and
// re-merging creditNotes against whatever is *actually* in the database
// right now (not what some client fetched a moment ago) removes the race
// entirely — concurrent PUTs simply queue on the row lock instead of racing.
//
// The optional `data._knownCreditNoteIds` array tells us which credit note
// ids the saving client already knew about before this edit (its own last
// sync point). A note id present in the CURRENT database row but absent
// from both the incoming payload and `_knownCreditNoteIds` was added by a
// different session since this client last synced, and must be preserved.
// A note id the client used to know about but omitted from the incoming
// array was a deliberate delete by that client and stays deleted. If the
// caller omits `_knownCreditNoteIds` (older cached frontend, or any other
// caller), we fail safe toward never losing data: everything currently
// stored is preserved unless the incoming array already re-includes it.
router.put('/', async (req: Request, res: Response): Promise<void> => {
  const body = req.body || {};
  if (!('data' in body)) {
    res.status(400).json({ error: 'Request body must include "data"' });
    return;
  }

  const client = await pool.connect();
  try {
    const data = { ...(body.data || {}) };
    const knownCreditNoteIds = Array.isArray(data._knownCreditNoteIds) ? data._knownCreditNoteIds : null;
    delete data._knownCreditNoteIds;

    await client.query('BEGIN');

    if (Array.isArray(data.creditNotes)) {
      // Row lock — any concurrent PUT to id=1 now waits for this transaction
      // to commit before it can read/merge, instead of racing against it.
      const existingRes = await client.query(
        'SELECT data FROM platform_state WHERE id = 1 FOR UPDATE'
      );
      const existingData = existingRes.rowCount ? (existingRes.rows[0].data || {}) : {};
      const existingNotes = Array.isArray(existingData.creditNotes) ? existingData.creditNotes : [];

      const incomingIds = new Set(data.creditNotes.map((c: any) => c && c.id));
      const knownIds = new Set(knownCreditNoteIds ?? []); // fail-safe: empty = "nothing confirmed deleted"
      const addedElsewhere = existingNotes.filter(
        (c: any) => c && !incomingIds.has(c.id) && !knownIds.has(c.id)
      );
      if (addedElsewhere.length) {
        data.creditNotes = [...data.creditNotes, ...addedElsewhere];
      }
    }

    await client.query(
      `INSERT INTO platform_state (id, data, updated_at)
       VALUES (1, $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE
         SET data = EXCLUDED.data,
             updated_at = NOW()`,
      [JSON.stringify(data)]
    );

    await client.query('COMMIT');
    res.json({ success: true, data });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('PUT /api/platform-state failed:', err);
    res.status(500).json({ error: 'Failed to save platform state' });
  } finally {
    client.release();
  }
});

export default router;
