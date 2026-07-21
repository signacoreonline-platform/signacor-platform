import { Router, Request, Response } from 'express';
import pool from '../db/pool';

/**
 * /api/document-numbers
 *
 * Backend-authoritative, atomic document-number reservation.
 *
 * Phase 1 (this file): invoice numbers only ("invoice" doc type), scoped
 * per company — Signacore Holdings (co:1) and Original Signacore (co:2)
 * each have their own independent counter (see
 * database/migrations/003_document_number_counters.sql). This deliberately
 * replaces the old frontend max(existing)+1 generators (getNextInvoiceNum,
 * nextInvNum in index.html), which were not atomic across simultaneous
 * users/sessions and produced a confirmed duplicate — INV-00057, issued to
 * two different co:2 jobs. That historical duplicate is left untouched by
 * this change; it is not renumbered or repaired.
 *
 * The frontend calls POST /reserve, gets back a number, and uses it when
 * creating the invoice. Nothing else about invoice creation, editing, or
 * the quote/job workflow is changed by this route.
 */

const router = Router();

const VALID_COMPANIES = ['1', '2'];
const VALID_DOC_TYPES = ['invoice'] as const;
type DocType = (typeof VALID_DOC_TYPES)[number];

const PREFIX: Record<DocType, string> = { invoice: 'INV-' };

function formatNumber(docType: DocType, n: number): string {
  return PREFIX[docType] + String(n).padStart(5, '0');
}

function escapeForRegex(s: string): string {
  return s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
}

// Scans the live platform_state for every existing number already used by
// this company for this doc type, across BOTH invoice sources (job-derived
// invoices and manual accInvoices). Only records whose `co` field strictly
// equals the requested company are counted — a record with a missing/null
// company marker is never silently claimed by either company here.
function scanExistingNumbers(data: Record<string, any> | null | undefined, company: string, docType: DocType): Set<string> {
  const found = new Set<string>();
  if (!data || docType !== 'invoice') return found;

  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  for (const j of jobs) {
    if (j && String(j.co) === company && typeof j.invoiceNum === 'string' && j.invoiceNum.trim()) {
      found.add(j.invoiceNum.trim().toUpperCase());
    }
  }

  const accInvoices = Array.isArray(data.accInvoices) ? data.accInvoices : [];
  for (const i of accInvoices) {
    if (i && String(i.co) === company && typeof i.number === 'string' && i.number.trim()) {
      found.add(i.number.trim().toUpperCase());
    }
  }

  return found;
}

function highestNumericValue(numbers: Set<string>, docType: DocType): number {
  const re = new RegExp('^' + escapeForRegex(PREFIX[docType]) + '(\\d+)$');
  let max = 0;
  for (const n of numbers) {
    const m = re.exec(n);
    if (m) {
      const val = parseInt(m[1], 10);
      if (!isNaN(val) && val > max) max = val;
    }
  }
  return max;
}

// POST /api/document-numbers/reserve
// body: { company: 1 | 2 | '1' | '2', docType?: 'invoice' }
// → 200 { number: 'INV-00066', company: '1', docType: 'invoice' }
// → 400 invalid company/docType
// → 500 reservation failed (no number issued, nothing to roll back on the caller's side)
router.post('/reserve', async (req: Request, res: Response): Promise<void> => {
  const rawCompany = req.body && req.body.company;
  const rawDocType = (req.body && req.body.docType) || 'invoice';

  const company = rawCompany === undefined || rawCompany === null ? '' : String(rawCompany);
  const docType = String(rawDocType) as DocType;

  if (!VALID_COMPANIES.includes(company)) {
    res.status(400).json({ error: 'Invalid or missing company. Must be 1 or 2.' });
    return;
  }
  if (!(VALID_DOC_TYPES as readonly string[]).includes(docType)) {
    res.status(400).json({ error: `Unsupported docType "${docType}". Only "invoice" is supported.` });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Seed the counter row on first-ever use for this company/docType,
    // WITHOUT overwriting one that already exists. ON CONFLICT DO NOTHING
    // makes a concurrent first-request race harmless: at most one insert
    // wins, every request then proceeds to the row lock below.
    const existingRowRes = await client.query(
      'SELECT 1 FROM document_number_counters WHERE company = $1 AND doc_type = $2',
      [company, docType]
    );

    if (existingRowRes.rowCount === 0) {
      const stateRes = await client.query('SELECT data FROM platform_state WHERE id = 1');
      const data = stateRes.rowCount ? stateRes.rows[0].data || {} : {};
      const seedValue = highestNumericValue(scanExistingNumbers(data, company, docType), docType);

      await client.query(
        `INSERT INTO document_number_counters (company, doc_type, last_number)
         VALUES ($1, $2, $3)
         ON CONFLICT (company, doc_type) DO NOTHING`,
        [company, docType, seedValue]
      );
    }

    // Row lock — concurrent reservations for this company/docType now queue
    // on this lock instead of racing for the same next number.
    const lockedRes = await client.query(
      'SELECT last_number FROM document_number_counters WHERE company = $1 AND doc_type = $2 FOR UPDATE',
      [company, docType]
    );
    if (lockedRes.rowCount === 0) {
      await client.query('ROLLBACK');
      console.error('document-numbers/reserve: counter row missing after seed for', company, docType);
      res.status(500).json({ error: 'Failed to reserve a document number' });
      return;
    }

    let candidate = (lockedRes.rows[0].last_number || 0) + 1;

    // Extra safety net beyond the atomic counter itself: confirm the
    // candidate isn't already present anywhere in this company's live
    // invoice records (job-derived or accInvoices) before handing it out.
    // Guards against any historical or otherwise-created number sitting
    // above the counter. Never touches or repairs existing duplicates.
    const stateRes2 = await client.query('SELECT data FROM platform_state WHERE id = 1');
    const liveData = stateRes2.rowCount ? stateRes2.rows[0].data || {} : {};
    const liveNumbers = scanExistingNumbers(liveData, company, docType);

    let guard = 0;
    while (liveNumbers.has(formatNumber(docType, candidate).toUpperCase()) && guard < 1000) {
      candidate += 1;
      guard += 1;
    }

    await client.query(
      `UPDATE document_number_counters SET last_number = $1, updated_at = NOW()
       WHERE company = $2 AND doc_type = $3`,
      [candidate, company, docType]
    );

    await client.query('COMMIT');

    res.json({ number: formatNumber(docType, candidate), company, docType });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('POST /api/document-numbers/reserve failed:', err);
    res.status(500).json({ error: 'Failed to reserve a document number' });
  } finally {
    client.release();
  }
});

export default router;
