import { Router, Request, Response } from 'express';
import { PoolClient } from 'pg';
import pool from '../db/pool';
import { authenticate } from '../middleware/auth';

/**
 * /api/document-numbers
 *
 * Backend-authoritative, atomic document-number reservation.
 *
 * Phase 1: invoice numbers ("invoice" doc type), scoped per company —
 * Signacore Holdings (co:1) and Original Signacore (co:2) each have their
 * own independent counter (see
 * database/migrations/003_document_number_counters.sql). This deliberately
 * replaces the old frontend max(existing)+1 generators (getNextInvoiceNum,
 * nextInvNum in index.html), which were not atomic across simultaneous
 * users/sessions and produced a confirmed duplicate — INV-00057, issued to
 * two different co:2 jobs. That historical duplicate is left untouched by
 * this change; it is not renumbered or repaired.
 *
 * Phase 2 (2026-07-29): quote numbers ("quote" doc type) added on the same
 * table/pattern, for the same reason — the frontend's client-side
 * getNextQuoteNum(quotes) max()+1 generator was not atomic across
 * simultaneous users/sessions either, and produced a confirmed duplicate
 * (SQ-00130, issued to both a Cut & Style quote and a Hennies quote). No new
 * table or migration was needed: document_number_counters was already
 * generic on (company, doc_type). That historical SQ-00130 duplicate is
 * left untouched by this change; it is not renumbered or repaired here.
 *
 * Phase 3 (2026-08-18, production stabilisation): job numbers ("job") and
 * purchase-order numbers ("po") added, for the same reason again — the
 * frontend's getNextJobNum/getNextPONum client-side max()+1 scans were the
 * confirmed mechanism behind the SQ-00014 double-conversion (two sessions'
 * local `jobs` arrays disagreed, each independently minted the same "next"
 * job number). Unlike invoices/quotes, job and PO numbers are NOT
 * company-scoped in this application (a single "SNS-"/"PO-" sequence is
 * shared across all companies — see index.html's getNextJobNum/getNextPONum,
 * which scan the whole array with no `co` filter) — so these two doc types
 * always use the fixed sentinel company value GLOBAL_COMPANY ('ALL')
 * rather than the caller-supplied company, and `scanExistingNumbers` never
 * filters them by `co`. No new table needed here either — same generic
 * (company, doc_type) row shape, just a company value of 'ALL' instead of
 * '1'/'2'/'4'.
 *
 * The frontend calls POST /reserve with { company, docType }, gets back a
 * number, and uses it when creating the invoice/quote/job/PO. Nothing else
 * about record creation/editing is changed by this route.
 *
 * ── Authentication (added 2026-08-06, audit finding B1) ──────────────────
 * Requires a valid, backend-issued JWT (Authorization: Bearer <token>) the
 * same way /api/platform-state now does — previously this endpoint was also
 * unauthenticated, letting anyone burn/skip numbers from either company's
 * counter with a direct API call. See platformState.ts for the fuller note.
 */

const router = Router();
router.use(authenticate);

// 2026-08-18: was ['1','2'] — missing company 4 ("Cover X Transform"),
// which exists in the frontend's INITIAL_COMPANIES and is selectable in
// CreateQuoteModal/AddJobModal today. Any quote/invoice number reservation
// for company 4 was hard-failing with a 400 before this fix, blocking
// quote/invoice creation for that company entirely — not a data-integrity
// bug itself, but a directly-adjacent "currently-unsafe path" surfaced
// while tracing company (`co`) propagation for this stabilisation pass.
const VALID_COMPANIES = ['1', '2', '4'];
const VALID_DOC_TYPES = ['invoice', 'quote', 'job', 'po'] as const;
type DocType = (typeof VALID_DOC_TYPES)[number];

// Job and PO numbers are global (not per-company) — see the Phase 3 note
// above. Any request for these doc types is always reserved against this
// fixed sentinel row, regardless of what `company` the caller sends.
const GLOBAL_DOC_TYPES: ReadonlySet<DocType> = new Set(['job', 'po']);
const GLOBAL_COMPANY = 'ALL';

const PREFIX: Record<DocType, string> = { invoice: 'INV-', quote: 'SQ-', job: 'SNS-', po: 'PO-' };

function formatNumber(docType: DocType, n: number): string {
  return PREFIX[docType] + String(n).padStart(5, '0');
}

function escapeForRegex(s: string): string {
  return s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
}

// Scans the live platform_state for every existing number already used for
// this doc type (and, for invoice/quote, this company specifically). For
// invoices this covers THREE sources (job-derived invoices, manual
// accInvoices, and — 2026-08-17 follow-up to the INV-00068/INV-00033 fix —
// any quote's persisted legacy proformaNum, which is a RESERVED future
// invoice number and must not be handed out to a different customer); for
// quotes it covers the `quotes` array's own `num`; for jobs, `jobs[].num`;
// for POs, `purchaseOrders[].num`. Invoice/quote scans only count records
// whose `co` field strictly equals the requested company — a record with a
// missing/null company marker is never silently claimed by either company
// here. Job/PO scans deliberately do NOT filter by `co` at all (see the
// Phase 3 note above — those numbers are shared across every company).
function scanExistingNumbers(data: Record<string, any> | null | undefined, company: string, docType: DocType): Set<string> {
  const found = new Set<string>();
  if (!data) return found;

  if (docType === 'invoice') {
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

    // A quote's proformaNum reserves that exact number for its own eventual
    // real invoice (see index.html's resolveProformaInvoiceNumber()) — the
    // atomic counter must never hand it to another quote/job in the
    // meantime. This never blocks the quote that OWNS the proformaNum from
    // reusing it: that path goes through resolveProformaInvoiceNumber()
    // directly and never calls /reserve for that number in the first place.
    const quotesForInvoice = Array.isArray(data.quotes) ? data.quotes : [];
    for (const q of quotesForInvoice) {
      if (q && String(q.co) === company && typeof q.proformaNum === 'string' && q.proformaNum.trim()) {
        found.add(q.proformaNum.trim().toUpperCase());
      }
    }
  } else if (docType === 'quote') {
    const quotes = Array.isArray(data.quotes) ? data.quotes : [];
    for (const q of quotes) {
      if (q && String(q.co) === company && typeof q.num === 'string' && q.num.trim()) {
        found.add(q.num.trim().toUpperCase());
      }
    }
  } else if (docType === 'job') {
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    for (const j of jobs) {
      if (j && typeof j.num === 'string' && j.num.trim()) {
        found.add(j.num.trim().toUpperCase());
      }
    }
  } else if (docType === 'po') {
    const pos = Array.isArray(data.purchaseOrders) ? data.purchaseOrders : [];
    for (const p of pos) {
      if (p && typeof p.num === 'string' && p.num.trim()) {
        found.add(p.num.trim().toUpperCase());
      }
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

// Core atomic reservation, factored out so other routes (see
// routes/quoteConversions.ts) can reserve a job number inside their OWN
// transaction on the same client, rather than making a second HTTP call to
// this route from the backend. MUST be called between BEGIN and COMMIT on
// `client` — it does not manage the transaction itself. Throws on failure;
// callers are expected to ROLLBACK in their own catch block.
async function reserveDocumentNumberWithClient(client: PoolClient, companyIn: string, docType: DocType): Promise<string> {
  const company = GLOBAL_DOC_TYPES.has(docType) ? GLOBAL_COMPANY : companyIn;

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
    throw new Error(`document number counter row missing after seed for ${company}/${docType}`);
  }

  let candidate = (lockedRes.rows[0].last_number || 0) + 1;

  // Extra safety net beyond the atomic counter itself: confirm the
  // candidate isn't already present anywhere in the relevant live records
  // before handing it out. Guards against any historical or otherwise-
  // created number sitting above the counter. Never touches or repairs
  // existing duplicates.
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

  return formatNumber(docType, candidate);
}

// POST /api/document-numbers/reserve
// body: { company: 1 | 2 | 4 | '1' | '2' | '4', docType?: 'invoice' | 'quote' | 'job' | 'po' }
//   `company` is required for docType invoice/quote; ignored (job/PO are
//   global) for docType job/po.
// → 200 { number: 'INV-00066', company: '1', docType: 'invoice' }
// → 400 invalid company/docType
// → 500 reservation failed (no number issued, nothing to roll back on the caller's side)
router.post('/reserve', async (req: Request, res: Response): Promise<void> => {
  const rawCompany = req.body && req.body.company;
  const rawDocType = (req.body && req.body.docType) || 'invoice';

  const docType = String(rawDocType) as DocType;
  if (!(VALID_DOC_TYPES as readonly string[]).includes(docType)) {
    res.status(400).json({ error: `Unsupported docType "${docType}". Must be one of ${VALID_DOC_TYPES.join(', ')}.` });
    return;
  }

  const company = rawCompany === undefined || rawCompany === null ? '' : String(rawCompany);
  if (!GLOBAL_DOC_TYPES.has(docType) && !VALID_COMPANIES.includes(company)) {
    res.status(400).json({ error: `Invalid or missing company. Must be one of ${VALID_COMPANIES.join(', ')}.` });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const number = await reserveDocumentNumberWithClient(client, company, docType);
    await client.query('COMMIT');
    res.json({ number, company: GLOBAL_DOC_TYPES.has(docType) ? GLOBAL_COMPANY : company, docType });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('POST /api/document-numbers/reserve failed:', err);
    res.status(500).json({ error: 'Failed to reserve a document number' });
  } finally {
    client.release();
  }
});

export default router;
export { reserveDocumentNumberWithClient };
export type { DocType };
