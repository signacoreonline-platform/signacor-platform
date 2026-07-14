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

/**
 * ── Backup-before-save + wipe protection ─────────────────────────────
 *
 * Added 2026-07-14 after confirmed loss of June/July business data.
 *
 * Every PUT below now:
 *   1. Locks the platform_state row and reads what is CURRENTLY live.
 *   2. Runs detectWipe() to reject payloads that look like an accidental
 *      wipe/partial/filtered/empty save relative to what's live right now.
 *   3. Inserts the CURRENT (pre-overwrite) state into platform_state_backups.
 *      If that insert fails, the whole PUT is rolled back and fails —
 *      the live row is never overwritten without a successful backup first.
 *   4. Only then performs the existing UPSERT.
 *
 * None of this changes what gets stored in platform_state.data or how
 * company/role filtering works — it only guards the write path.
 */

// Every array-type section persisted inside platform_state.data (mirrors
// STATE_SECTIONS in the frontend's index.html).
const STATE_ARRAY_KEYS = [
  'jobs', 'inventory', 'quotes', 'customers', 'suppliers', 'assets',
  'employees', 'leaveRequests', 'disciplinary', 'savedCalcs', 'purchaseOrders',
  'savedImports', 'bankTxns', 'chartOfAccounts', 'accInvoices', 'accBills',
  'completeProducts', 'payrollRecords', 'quickRates', 'proposedProjects', 'creditNotes',
];

// Sections whose sudden loss is most consequential for the business — used
// for the "obvious wipe" guard. Smaller/optional lists are intentionally left
// out so trimming them never trips the guard.
const CRITICAL_KEYS = ['jobs', 'customers', 'suppliers', 'inventory', 'quotes', 'accInvoices', 'accBills', 'creditNotes'];

function arr(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

// Counts records per `co` (company) tag, for sections that carry one
// (jobs, quotes, purchaseOrders, etc.). Sections with no `co` field on their
// records simply produce an empty count map and are skipped by that check.
function countByCo(list: any[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of list) {
    if (item && item.co !== undefined && item.co !== null) {
      const key = String(item.co);
      out[key] = (out[key] || 0) + 1;
    }
  }
  return out;
}

function buildRecordCounts(data: Record<string, any>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const k of STATE_ARRAY_KEYS) counts[k] = arr(data[k]).length;
  return counts;
}

// Returns null if the incoming payload looks safe, or a short human-readable
// reason if it looks like it would wipe/partially-wipe existing data.
// Deliberately conservative: small/normal edits and deletions must never
// trip this guard — only clearly-accidental full/partial wipes should.
function detectWipe(existingData: Record<string, any> | null, incomingData: any): string | null {
  if (!existingData || typeof existingData !== 'object' || Object.keys(existingData).length === 0) {
    return null; // nothing live yet to protect — first-ever save, allow it
  }
  if (!incomingData || typeof incomingData !== 'object' || Array.isArray(incomingData)) {
    return 'incoming payload is not a valid state object';
  }

  // Whole-state shape check: if the live data clearly has real records in it,
  // an incoming payload with NONE of the expected sections present as arrays
  // looks like an empty/default/broken state, not a real edit.
  const existingHasData = STATE_ARRAY_KEYS.some((k) => arr(existingData[k]).length > 0);
  const incomingHasAnySection = STATE_ARRAY_KEYS.some((k) => Array.isArray(incomingData[k]));
  if (existingHasData && !incomingHasAnySection) {
    return 'incoming payload has none of the expected data sections (looks like an empty/default state)';
  }

  for (const k of CRITICAL_KEYS) {
    const existingList = arr(existingData[k]);
    const existingLen = existingList.length;
    const incomingIsArray = Array.isArray(incomingData[k]);
    const incomingLen = incomingIsArray ? incomingData[k].length : 0;

    // A previously-populated critical section missing entirely from the
    // payload (not even sent as an empty array) is always suspicious.
    if (existingLen >= 3 && !incomingIsArray) {
      return `"${k}" is missing from the incoming payload (currently has ${existingLen} record(s))`;
    }
    // Dropping to zero from a meaningful size.
    if (existingLen >= 5 && incomingLen === 0) {
      return `"${k}" would drop from ${existingLen} record(s) to 0`;
    }
    // Dramatic drop (more than 80%) from a meaningful size — catches
    // "invoices basically disappeared" without blocking small cleanups.
    if (existingLen >= 10 && incomingLen <= existingLen * 0.2) {
      return `"${k}" would drop from ${existingLen} record(s) to ${incomingLen} (over 80% loss)`;
    }
    // One company's entire slice of a shared section vanishing while the
    // section itself is not empty — e.g. a single-company filtered view
    // saved as though it were the whole database.
    if (incomingIsArray && existingLen > 0) {
      const existingByCo = countByCo(existingList);
      const incomingByCo = countByCo(incomingData[k]);
      for (const co of Object.keys(existingByCo)) {
        if (existingByCo[co] >= 3 && !incomingByCo[co]) {
          return `"${k}" would lose all ${existingByCo[co]} record(s) for company "${co}"`;
        }
      }
    }
  }
  return null;
}

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

    // Row lock — any concurrent PUT to id=1 now waits for this transaction to
    // commit before it can read/merge, instead of racing against it. This also
    // gives us the "before" snapshot used for both the wipe check and the
    // automatic backup below.
    const existingRes = await client.query(
      'SELECT data FROM platform_state WHERE id = 1 FOR UPDATE'
    );
    const existingData: Record<string, any> | null = existingRes.rowCount ? (existingRes.rows[0].data || {}) : null;

    // ── Save protection: block obvious wipe/partial/empty saves ──────────
    const wipeReason = detectWipe(existingData, data);
    if (wipeReason) {
      await client.query('ROLLBACK');
      console.warn('PUT /api/platform-state BLOCKED — possible data loss:', wipeReason);
      res.status(409).json({
        error: 'Save blocked to protect existing data',
        reason: wipeReason,
      });
      return;
    }

    // ── Backup-before-save: snapshot whatever is currently live BEFORE it is
    //    overwritten. If this fails, the whole PUT fails safely — live data
    //    is never overwritten without a successful backup first.
    if (existingData !== null) {
      try {
        const serialized = JSON.stringify(existingData);
        const recordCounts = JSON.stringify(buildRecordCounts(existingData));
        const source = (req.get('x-signacore-client') || req.get('user-agent') || null);
        await client.query(
          `INSERT INTO platform_state_backups (data, reason, data_size_bytes, record_counts, source)
           VALUES ($1::jsonb, 'before-put', $2, $3::jsonb, $4)`,
          [serialized, Buffer.byteLength(serialized, 'utf8'), recordCounts, source]
        );
      } catch (backupErr) {
        await client.query('ROLLBACK').catch(() => undefined);
        console.error('PUT /api/platform-state: backup-before-save FAILED — aborting save to protect data:', backupErr);
        res.status(500).json({ error: 'Backup failed — save aborted to protect existing data' });
        return;
      }

      // Conservative retention: keep at least the most recent 100 backups,
      // only ever deleting older rows, and only after a new backup was just
      // written successfully above. Best-effort — never fails the save.
      try {
        await client.query(
          `DELETE FROM platform_state_backups
           WHERE id IN (
             SELECT id FROM platform_state_backups
             ORDER BY created_at DESC
             OFFSET 100
           )`
        );
      } catch (pruneErr) {
        console.warn('platform_state_backups retention prune skipped:', pruneErr);
      }
    }

    if (Array.isArray(data.creditNotes)) {
      const existingNotes = Array.isArray(existingData && existingData.creditNotes) ? existingData!.creditNotes : [];

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
