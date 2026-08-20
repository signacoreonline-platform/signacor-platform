import { Router, Request, Response } from 'express';
import pool from '../db/pool';
import { authenticate } from '../middleware/auth';
import { reserveDocumentNumberWithClient, peekNextNumber } from './documentNumbers';

/**
 * /api/quote-conversions
 *
 * Backend-enforced "convert this quote to a job at most once" (see
 * database/migrations/005_quote_conversions.sql for the original
 * UNIQUE(quote_id) design and why it exists).
 *
 * ══════════════════════════════════════════════════════════════════════
 * 2026-08-20 DATA-SAFETY HARDENING — RECOVERABLE MISSING-DOCUMENT CASE
 * ══════════════════════════════════════════════════════════════════════
 * SQ-00168 is the confirmed case this closes: a quote_conversions row
 * exists (job_number reserved), but the job it names is not live — most
 * likely because the earlier save-race described in platformState.ts
 * removed it, or because the original save after reservation never
 * completed. The PREVIOUS behaviour here silently returned
 * `{ jobNumber: <old number>, reused: true }` and let the frontend build a
 * brand-new job under that same, potentially-contaminated number with NO
 * user visibility into what happened.
 *
 * That is no longer automatic. When this endpoint finds a reservation
 * whose job is missing live, it now returns a structured, RECOVERABLE
 * conflict (`type: 'reservation_missing_document'`) instead — the caller
 * must show the user what happened and get EXPLICIT confirmation before
 * anything changes. Only POST /reassign (below), called after that
 * confirmation, actually reassigns the reservation to a new number — and
 * even then it re-verifies under lock that the old number still has no
 * live job (defends against a second, slower TOCTOU race: someone else
 * saving the missing job between the conflict response and the user's
 * confirmation click).
 *
 * Audit trail: reassignment does not delete the original reservation row —
 * it updates job_number in place but preserves the number it's replacing
 * in `superseded_job_number`/`superseded_at`/`reassigned_reason` (see
 * database/migrations/006_quote_conversions_audit_trail.sql, a minimal
 * additive migration — three nullable columns, no data touched, safe to
 * re-run). This is genuinely necessary: without it, a reassignment would
 * be indistinguishable from the original reservation, and nobody could
 * later answer "why does this quote's reserved job number not match what
 * was first issued?" — exactly the kind of question this investigation
 * itself needed to answer for SQ-00168.
 */

const router = Router();
router.use(authenticate);

function up(v: unknown): string {
  return (v === undefined || v === null ? '' : String(v)).trim().toUpperCase();
}

async function liveJobExists(quoteId: string, jobNumber: string): Promise<boolean> {
  const stateRes = await pool.query('SELECT data FROM platform_state WHERE id = 1');
  const data = stateRes.rowCount ? stateRes.rows[0].data || {} : {};
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  return jobs.some((j: any) => j && up(j.num) === up(jobNumber));
}

// POST /api/quote-conversions/reserve
// body: { quoteId: string | number }
// → 200 { jobNumber: 'SNS-00142', reused: false }               (brand-new reservation)
// → 400 missing quoteId
// → 409 { error, jobNumber }                                     (job genuinely already exists live — real duplicate-conversion attempt)
// → 409 { conflict:true, type:'reservation_missing_document', quoteId, previousJobNumber, suggestedNumber, canReassign:true }
//        (a reservation exists but no live job matches it — 2026-08-20: no longer silently reused)
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

    if (err && err.code === '23505') {
      try {
        const existingRes = await pool.query(
          'SELECT job_number FROM quote_conversions WHERE quote_id = $1',
          [quoteId]
        );
        const existingJobNumber = existingRes.rowCount ? String(existingRes.rows[0].job_number) : null;

        if (!existingJobNumber) {
          res.status(500).json({ error: 'Failed to reserve a job number for this quote.' });
          return;
        }

        const jobExists = await liveJobExists(quoteId, existingJobNumber);

        if (jobExists) {
          res.status(409).json({
            error: 'This quote has already been converted to a job.',
            jobNumber: existingJobNumber,
          });
        } else {
          // 2026-08-20 hardening: reservation exists, job does not — this is
          // now a RECOVERABLE conflict requiring explicit user confirmation
          // via POST /reassign, never an automatic reuse. See header comment.
          const suggestedNumber = await peekNextNumber('ALL', 'job');
          res.status(409).json({
            conflict: true,
            type: 'reservation_missing_document',
            quoteId,
            previousJobNumber: existingJobNumber,
            suggestedNumber,
            canReassign: true,
            error: `The previous job-number reservation ${existingJobNumber} no longer has a matching job. Confirm to assign a new number.`,
          });
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

// POST /api/quote-conversions/reassign — 2026-08-20 hardening.
// body: { quoteId: string | number, confirm: true, reason?: string }
// Only reachable AFTER the caller has shown the user the
// 'reservation_missing_document' conflict from /reserve and gotten
// explicit confirmation — `confirm !== true` is rejected outright, this is
// never called automatically.
// → 200 { jobNumber: <new>, reused:false, reassignedFrom: <old> }
// → 409 { error, jobNumber } — the old number turned out to have a live job
//        after all (re-checked under lock — a second session saved it in
//        the window between the conflict and this confirmation)
// → 400 missing quoteId/confirm, or no existing reservation to reassign
// → 500 failure
router.post('/reassign', async (req: Request, res: Response): Promise<void> => {
  const rawQuoteId = req.body && req.body.quoteId;
  const confirm = req.body && req.body.confirm === true;
  const reason = typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim() : 'missing-document reassignment confirmed by user';

  if (rawQuoteId === undefined || rawQuoteId === null || String(rawQuoteId).trim() === '') {
    res.status(400).json({ error: 'quoteId is required.' });
    return;
  }
  if (!confirm) {
    res.status(400).json({ error: 'confirm:true is required — this endpoint never reassigns without explicit confirmation.' });
    return;
  }
  const quoteId = String(rawQuoteId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the existing reservation row so a concurrent /reserve retry or
    // /reassign call for the SAME quote can't race this one.
    const existingRes = await client.query(
      'SELECT job_number FROM quote_conversions WHERE quote_id = $1 FOR UPDATE',
      [quoteId]
    );
    if (existingRes.rowCount === 0) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'No existing reservation found for this quote — nothing to reassign. Use /reserve instead.' });
      return;
    }
    const oldJobNumber = String(existingRes.rows[0].job_number);

    // Re-verify under lock — closes the TOCTOU window between the original
    // conflict response and this confirmation click.
    const jobExistsNow = await liveJobExists(quoteId, oldJobNumber);
    if (jobExistsNow) {
      await client.query('ROLLBACK');
      res.status(409).json({
        error: `Job ${oldJobNumber} now exists live for this quote (created by another session since the conflict was shown) — this quote is already converted. Refresh and open the existing job instead.`,
        jobNumber: oldJobNumber,
      });
      return;
    }

    const newJobNumber = await reserveDocumentNumberWithClient(client, 'ALL', 'job');
    await client.query(
      `UPDATE quote_conversions
       SET job_number = $1, superseded_job_number = $2, superseded_at = NOW(), reassigned_reason = $3
       WHERE quote_id = $4`,
      [newJobNumber, oldJobNumber, reason, quoteId]
    );

    await client.query('COMMIT');
    console.log(`[quote-conversions] REASSIGNED quoteId=${quoteId} ${oldJobNumber} -> ${newJobNumber} reason="${reason}"`);
    res.json({ jobNumber: newJobNumber, reused: false, reassignedFrom: oldJobNumber });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('POST /api/quote-conversions/reassign failed:', err);
    res.status(500).json({ error: 'Failed to reassign a job number for this quote.' });
  } finally {
    client.release();
  }
});

export default router;
