import { Router, Request, Response } from 'express';
import pool from '../db/pool';
import { authenticate } from '../middleware/auth';
import { reserveDocumentNumberWithClient } from './documentNumbers';

/**
 * /api/quote-conversions
 *
 * Backend-enforced "convert this quote to a job at most once", added
 * 2026-08-18 as part of the production stabilisation pass.
 *
 * Background: the production integrity audit confirmed a real historical
 * incident — quote SQ-00014 ended up referenced by TWO different jobs. The
 * only protection against this in the frontend (handleConvertToJob in
 * index.html) is a same-tab ref lock plus a check against that browser
 * tab's own local `jobs` array. Neither guard can see another session's
 * conversion that hasn't been saved/synced yet, so two people (or one
 * person in two tabs) converting the same quote at nearly the same moment
 * could both succeed, each minting their own client-side job number
 * (getNextJobNum), producing two jobs for one quote — sometimes with a
 * duplicate job NUMBER as well, since job numbers were never backend-
 * reserved either (see documentNumbers.ts Phase 3).
 *
 * This endpoint closes that gap with a real database-level guarantee: a
 * UNIQUE(quote_id) constraint on the new `quote_conversions` table (see
 * database/migrations/005_quote_conversions.sql). The frontend calls this
 * BEFORE building/saving the new job. Exactly one caller can ever win the
 * INSERT for a given quote_id — every other caller (concurrent or a later
 * accidental double-click that slipped past the frontend's own guards)
 * gets a clear 409, never a second job number.
 *
 * Retry safety: if a caller reserves a job number here and then the
 * FOLLOW-UP save (POST/PUT to /api/platform-state, actually creating the
 * job) fails or times out, the quote_conversions row now exists but no job
 * was ever actually created. A naive unique-constraint-only design would
 * permanently block that quote from ever being converted. Instead, this
 * endpoint checks live platform_state for a job matching the previously-
 * reserved number: if none exists, it hands back the SAME job number again
 * (reused:true) rather than erroring — safe to retry indefinitely, and
 * still impossible to ever produce two DIFFERENT job numbers for the same
 * quote. If a job with that number DOES already exist live, this is a
 * genuine already-converted quote and the caller gets 409.
 *
 * This route does not touch platform_state at all except to read it for
 * that live-existence check — it never writes quotes/jobs itself. The
 * frontend is still responsible for actually creating and saving the job
 * (via forceSaveSections), exactly as before; this only gates the number/
 * idempotency step ahead of that save.
 */

const router = Router();
router.use(authenticate);

function up(v: unknown): string {
  return (v === undefined || v === null ? '' : String(v)).trim().toUpperCase();
}

// POST /api/quote-conversions/reserve
// body: { quoteId: string | number }
// → 200 { jobNumber: 'SNS-00142', reused: false }
// → 200 { jobNumber: 'SNS-00142', reused: true }   (safe retry of a prior, never-completed reservation)
// → 400 missing quoteId
// → 409 { error, jobNumber } (this quote has a job already live under that number)
// → 500 reservation failed
router.post('/reserve', async (req: Request, res: Response): Promise<void> => {
  const rawQuoteId = req.body && req.body.quoteId;
  if (rawQuoteId === undefined || rawQuoteId === null || String(rawQuoteId).trim() === '') {
    res.status(400).json({ error: 'quoteId is required.' });
    return;
  }
  const quoteId = String(rawQuoteId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jobNumber = await reserveDocumentNumberWithClient(client, 'ALL', 'job');
    await client.query(
      `INSERT INTO quote_conversions (quote_id, job_number) VALUES ($1, $2)`,
      [quoteId, jobNumber]
    );
    await client.query('COMMIT');
    res.json({ jobNumber, reused: false });
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => undefined);

    // 23505 = unique_violation on quote_conversions.quote_id — a
    // reservation already exists for this quote (this session retrying, a
    // genuinely concurrent duplicate attempt, or an already-converted
    // quote). Look it up and decide which, using live platform_state as
    // the source of truth for whether a job actually exists.
    if (err && err.code === '23505') {
      try {
        const existingRes = await pool.query(
          'SELECT job_number FROM quote_conversions WHERE quote_id = $1',
          [quoteId]
        );
        const existingJobNumber = existingRes.rowCount ? String(existingRes.rows[0].job_number) : null;

        if (!existingJobNumber) {
          // Shouldn't happen (the conflict implies a row exists) — fail closed.
          res.status(500).json({ error: 'Failed to reserve a job number for this quote.' });
          return;
        }

        const stateRes = await pool.query('SELECT data FROM platform_state WHERE id = 1');
        const data = stateRes.rowCount ? stateRes.rows[0].data || {} : {};
        const jobs = Array.isArray(data.jobs) ? data.jobs : [];
        const jobExists = jobs.some((j: any) => j && up(j.num) === up(existingJobNumber));

        if (jobExists) {
          res.status(409).json({
            error: 'This quote has already been converted to a job.',
            jobNumber: existingJobNumber,
          });
        } else {
          // Reservation exists, but no job was ever actually saved with it
          // — a prior attempt's save must have failed/timed out. Safe to
          // hand the SAME number back out for a genuine retry.
          res.json({ jobNumber: existingJobNumber, reused: true });
        }
      } catch (lookupErr) {
        console.error('POST /api/quote-conversions/reserve lookup after conflict failed:', lookupErr);
        res.status(500).json({ error: 'Failed to reserve a job number for this quote.' });
      }
      return;
    }

    console.error('POST /api/quote-conversions/reserve failed:', err);
    res.status(500).json({ error: 'Failed to reserve a job number for this quote.' });
  } finally {
    client.release();
  }
});

export default router;
