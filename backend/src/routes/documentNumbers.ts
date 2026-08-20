import { Router, Request, Response } from 'express';
import { PoolClient } from 'pg';
import pool from '../db/pool';
import { authenticate } from '../middleware/auth';

/**
 * /api/document-numbers
 *
 * Backend-authoritative, atomic document-number reservation.
 * (History: see git blame / earlier versions of this file for Phases 1–3 —
 * per-company invoice numbers, then quote numbers, then global job/PO
 * numbers, all replacing the old frontend max(existing)+1 generators.)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 2026-08-20 DATA-SAFETY HARDENING — RECOVERABLE NUMBER COLLISIONS
 * ══════════════════════════════════════════════════════════════════════
 * Previously, a collision on a document number was either impossible
 * (auto-generated numbers always skip occupied ones) or, for a manually
 * typed number, a dead end: the frontend's own duplicate check
 * (quoteNumberExists/invoiceNumberExists) just threw up an alert and
 * refused to proceed — see index.html. That is never allowed to delete,
 * overwrite, or silently steal the existing document; it just left the
 * user stuck.
 *
 * Two new capabilities close that gap without weakening anything above:
 *   - POST /check — read-only. Tells the caller whether a specific number
 *     is free, and if not, who owns it and what the next safe number would
 *     be (a PREVIEW only — nothing is reserved by this call).
 *   - POST /reserve now also accepts an optional `requestedNumber`. If the
 *     caller wants that EXACT number and it is currently free, it is
 *     atomically claimed (the counter is advanced to at least that value).
 *     If it collides, this returns the same structured conflict shape as
 *     /check instead of failing generically — the caller can then offer
 *     the suggested number and retry with THAT as `requestedNumber` once
 *     the user explicitly confirms. Nothing is ever auto-reassigned
 *     without a second, caller-initiated request.
 * A manually requested number below the counter's current frontier is
 * still honoured if free (a genuine numbering gap) — the counter itself
 * only ever moves forward, matching its existing "never regress" contract.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 2026-08-20 FORWARD-ONLY PRO-##### PROFORMA NUMBERING
 * ══════════════════════════════════════════════════════════════════════
 * New business rule (index.html QuoteViewModal's new "Reserve Proforma
 * Number" action): a NEW proforma reserves a real invoice number from this
 * SAME atomic 'invoice' pool — there is no separate PRO counter — and
 * displays/stores it as quote.proformaNum = "PRO-#####", where the numeric
 * suffix IS the exact invoice number reserved (PRO-00042 <=> INV-00042).
 * The frontend does this by calling POST /reserve with docType:'invoice'
 * exactly as it always has (via reserveInvoiceNumber()) and then swapping
 * the "INV-" prefix for "PRO-" for display/storage — nothing new is added
 * to this endpoint's contract for that half of the flow.
 *
 * What DOES need to change here: scanExistingNumbers()/findOwner() below,
 * for docType 'invoice', already treat quote.proformaNum as occupying an
 * invoice slot (this is what already made a LEGACY INV-style proformaNum
 * block other invoices from reusing that number). That existing check
 * compared the stored proformaNum to the candidate INV-##### string
 * literally, which is correct for legacy INV-style values but would MISS a
 * new PRO-##### value entirely (it doesn't equal "INV-#####" as a string),
 * silently letting some other invoice creation path claim the exact number
 * a live PRO reservation depends on. deriveReservedInvoiceNumber() below
 * closes that gap: it derives the implied INV-##### for BOTH legacy
 * (INV-style, unchanged) and new-style (PRO-style) proformaNum values, and
 * both scanExistingNumbers and findOwner now check the derived value too.
 *
 * Legacy quotes are never rewritten by this — their proformaNum keeps
 * whatever value it already had (see index.html resolveProformaInvoiceNumber
 * for the matching frontend-side derivation used at finalisation).
 */

const router = Router();
router.use(authenticate);

const VALID_COMPANIES = ['1', '2', '4'];
const VALID_DOC_TYPES = ['invoice', 'quote', 'job', 'po'] as const;
type DocType = (typeof VALID_DOC_TYPES)[number];

const GLOBAL_DOC_TYPES: ReadonlySet<DocType> = new Set(['job', 'po']);
const GLOBAL_COMPANY = 'ALL';

const PREFIX: Record<DocType, string> = { invoice: 'INV-', quote: 'SQ-', job: 'SNS-', po: 'PO-' };
const DOC_LABEL: Record<DocType, string> = { invoice: 'invoice', quote: 'quote', job: 'job', po: 'purchase order' };

function formatNumber(docType: DocType, n: number): string {
  return PREFIX[docType] + String(n).padStart(5, '0');
}

function parseNumericValue(docType: DocType, formatted: string): number | null {
  const re = new RegExp('^' + escapeForRegex(PREFIX[docType]) + '(\\d+)$', 'i');
  const m = re.exec((formatted || '').trim());
  if (!m) return null;
  const v = parseInt(m[1], 10);
  return isNaN(v) ? null : v;
}

function escapeForRegex(s: string): string {
  return s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
}

// 2026-08-20 forward-only PRO numbering: given a quote's proformaNum value
// (in ANY form it may legitimately take), returns the INV-##### invoice
// number it implies is reserved — or null if the value implies no
// reservation at all (should not normally happen; a defensive fallback).
//   - New-style "PRO-00042"  -> "INV-00042" (the suffix IS the reservation)
//   - Legacy   "INV-00033"   -> "INV-00033" (already IS the invoice number,
//     unchanged behaviour from before this feature existed)
//   - Anything else (unrecognised/custom legacy format) -> null; the raw
//     value is still separately added verbatim by scanExistingNumbers, so
//     this only ever ADDS a recognised equivalence, never removes the
//     pre-existing literal-match behaviour.
function deriveReservedInvoiceNumber(raw: string): string | null {
  const v = (raw || '').trim().toUpperCase();
  if (!v) return null;
  const proMatch = /^PRO-(\d+)$/.exec(v);
  if (proMatch) return PREFIX.invoice + proMatch[1];
  if (v.startsWith(PREFIX.invoice)) return v;
  return null;
}

// Scans the live platform_state for every existing number already used for
// this doc type (and, for invoice/quote, this company specifically), and
// separately returns a best-effort "owner" descriptor for a specific
// requested number (used by /check and the collision response of
// /reserve) — id/client/co only, never the full record.
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
    const quotesForInvoice = Array.isArray(data.quotes) ? data.quotes : [];
    for (const q of quotesForInvoice) {
      if (q && String(q.co) === company && typeof q.proformaNum === 'string' && q.proformaNum.trim()) {
        const raw = q.proformaNum.trim().toUpperCase();
        found.add(raw); // preserves prior literal-match behaviour unchanged
        // 2026-08-20: a PRO-##### proformaNum implies the same-suffix
        // INV-##### is reserved too — add that derived equivalent so it
        // actually blocks the auto-candidate loop / manual requests below.
        const implied = deriveReservedInvoiceNumber(raw);
        if (implied) found.add(implied);
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

// Best-effort owner lookup for a specific occupied number — small,
// identity-only projection (id/client/co/documentType), never the full
// record. Checks every collection that can hold this doc type's numbers
// (mirrors scanExistingNumbers' sources).
function findOwner(data: Record<string, any> | null | undefined, company: string, docType: DocType, target: string): { documentType: string; number: string; id: any; client: string | null } | null {
  if (!data) return null;
  const up = target.trim().toUpperCase();

  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  const quotes = Array.isArray(data.quotes) ? data.quotes : [];
  const accInvoices = Array.isArray(data.accInvoices) ? data.accInvoices : [];
  const pos = Array.isArray(data.purchaseOrders) ? data.purchaseOrders : [];

  if (docType === 'invoice') {
    const job = jobs.find((j: any) => j && String(j.co) === company && (j.invoiceNum || '').trim().toUpperCase() === up);
    if (job) return { documentType: 'job invoice', number: up, id: job.id, client: job.client ?? null };
    const inv = accInvoices.find((i: any) => i && String(i.co) === company && (i.number || '').trim().toUpperCase() === up);
    if (inv) return { documentType: 'invoice', number: up, id: inv.id, client: inv.client ?? null };
    // 2026-08-20: matches a quote whose proformaNum literally equals `up`
    // (legacy behaviour, unchanged) OR whose proformaNum is a PRO-#####
    // value implying `up` as its reserved invoice number (new behaviour).
    const q = quotes.find((qq: any) => {
      if (!qq || String(qq.co) !== company || typeof qq.proformaNum !== 'string') return false;
      const raw = qq.proformaNum.trim().toUpperCase();
      if (!raw) return false;
      return raw === up || deriveReservedInvoiceNumber(raw) === up;
    });
    if (q) return { documentType: 'quote proforma reservation', number: up, id: q.id, client: q.client ?? null };
  } else if (docType === 'quote') {
    const q = quotes.find((qq: any) => qq && String(qq.co) === company && (qq.num || '').trim().toUpperCase() === up);
    if (q) return { documentType: 'quote', number: up, id: q.id, client: q.client ?? null };
  } else if (docType === 'job') {
    const j = jobs.find((jj: any) => jj && (jj.num || '').trim().toUpperCase() === up);
    if (j) return { documentType: 'job', number: up, id: j.id, client: j.client ?? null };
  } else if (docType === 'po') {
    const p = pos.find((pp: any) => pp && (pp.num || '').trim().toUpperCase() === up);
    if (p) return { documentType: 'purchase order', number: up, id: p.id, client: p.client ?? null };
  }
  return null;
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

// Seeds the counter row (if missing) and returns it locked FOR UPDATE.
// Shared by every function below that needs the counter under lock.
async function lockCounterRow(client: PoolClient, company: string, docType: DocType): Promise<number> {
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
  const lockedRes = await client.query(
    'SELECT last_number FROM document_number_counters WHERE company = $1 AND doc_type = $2 FOR UPDATE',
    [company, docType]
  );
  if (lockedRes.rowCount === 0) {
    throw new Error(`document number counter row missing after seed for ${company}/${docType}`);
  }
  return lockedRes.rows[0].last_number || 0;
}

// Core atomic reservation. MUST be called between BEGIN and COMMIT on
// `client`. Throws on failure; callers roll back in their own catch block.
// `requestedNumber` (2026-08-20 hardening): if provided and currently free,
// that EXACT number is claimed instead of the next auto candidate — the
// counter only ever moves forward, so a requested number below the current
// frontier is honoured without changing the counter, while one at/above it
// advances the counter to match. If occupied, throws a `NumberConflictError`
// (see below) instead of silently substituting a different number.
export class NumberConflictError extends Error {
  conflict: { requestedNumber: string; conflictType: string; owner: ReturnType<typeof findOwner>; suggestedNumber: string };
  constructor(payload: NumberConflictError['conflict']) {
    super(`Number ${payload.requestedNumber} is already in use`);
    this.name = 'NumberConflictError';
    this.conflict = payload;
  }
}

async function reserveDocumentNumberWithClient(
  client: PoolClient,
  companyIn: string,
  docType: DocType,
  requestedNumber?: string | null
): Promise<string> {
  const company = GLOBAL_DOC_TYPES.has(docType) ? GLOBAL_COMPANY : companyIn;
  const lastNumber = await lockCounterRow(client, company, docType);
  let candidate = lastNumber + 1;

  const stateRes2 = await client.query('SELECT data FROM platform_state WHERE id = 1');
  const liveData = stateRes2.rowCount ? stateRes2.rows[0].data || {} : {};
  const liveNumbers = scanExistingNumbers(liveData, company, docType);

  if (requestedNumber && requestedNumber.trim()) {
    const requestedUp = requestedNumber.trim().toUpperCase();
    if (liveNumbers.has(requestedUp)) {
      // Occupied — never silently substitute. Compute what WOULD be offered
      // instead (same skip-loop as the auto path) purely for the response.
      let suggestion = candidate;
      let guard = 0;
      while (liveNumbers.has(formatNumber(docType, suggestion).toUpperCase()) && guard < 1000) { suggestion += 1; guard += 1; }
      throw new NumberConflictError({
        requestedNumber: requestedUp,
        conflictType: `existing_${docType}`,
        owner: findOwner(liveData, company, docType, requestedUp),
        suggestedNumber: formatNumber(docType, suggestion),
      });
    }
    const requestedVal = parseNumericValue(docType, requestedUp);
    if (requestedVal !== null && requestedVal >= candidate) {
      await client.query(
        `UPDATE document_number_counters SET last_number = $1, updated_at = NOW() WHERE company = $2 AND doc_type = $3`,
        [requestedVal, company, docType]
      );
    }
    // requestedVal below the frontier (a genuine free gap) or non-numeric
    // (custom format) — free and not colliding, so it's granted as-is
    // without moving the counter.
    return requestedUp;
  }

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

// Read-only preview of what the NEXT auto-reserved number would be, without
// reserving/advancing anything. Used by /check and by other routes (see
// quoteConversions.ts) that need to suggest a number without committing to
// it until the user confirms.
async function peekNextNumber(company: string, docType: DocType): Promise<string> {
  const effectiveCompany = GLOBAL_DOC_TYPES.has(docType) ? GLOBAL_COMPANY : company;
  const counterRes = await pool.query(
    'SELECT last_number FROM document_number_counters WHERE company = $1 AND doc_type = $2',
    [effectiveCompany, docType]
  );
  const stateRes = await pool.query('SELECT data FROM platform_state WHERE id = 1');
  const liveData = stateRes.rowCount ? stateRes.rows[0].data || {} : {};
  const liveNumbers = scanExistingNumbers(liveData, effectiveCompany, docType);
  let candidate = counterRes.rowCount
    ? (counterRes.rows[0].last_number || 0) + 1
    : highestNumericValue(liveNumbers, docType) + 1;
  let guard = 0;
  while (liveNumbers.has(formatNumber(docType, candidate).toUpperCase()) && guard < 1000) { candidate += 1; guard += 1; }
  return formatNumber(docType, candidate);
}

function validateCompanyAndDocType(rawCompany: unknown, rawDocType: unknown, res: Response): { company: string; docType: DocType } | null {
  const docType = String(rawDocType || 'invoice') as DocType;
  if (!(VALID_DOC_TYPES as readonly string[]).includes(docType)) {
    res.status(400).json({ error: `Unsupported docType "${docType}". Must be one of ${VALID_DOC_TYPES.join(', ')}.` });
    return null;
  }
  const company = rawCompany === undefined || rawCompany === null ? '' : String(rawCompany);
  if (!GLOBAL_DOC_TYPES.has(docType) && !VALID_COMPANIES.includes(company)) {
    res.status(400).json({ error: `Invalid or missing company. Must be one of ${VALID_COMPANIES.join(', ')}.` });
    return null;
  }
  return { company, docType };
}

// POST /api/document-numbers/reserve
// body: { company, docType?, requestedNumber? }
// → 200 { number, company, docType }
// → 409 { conflict:true, requestedNumber, conflictType, owner, suggestedNumber } (requestedNumber occupied)
// → 400 invalid company/docType
// → 500 reservation failed
router.post('/reserve', async (req: Request, res: Response): Promise<void> => {
  const validated = validateCompanyAndDocType(req.body?.company, req.body?.docType, res);
  if (!validated) return;
  const { company, docType } = validated;
  const requestedNumber = typeof req.body?.requestedNumber === 'string' ? req.body.requestedNumber : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const number = await reserveDocumentNumberWithClient(client, company, docType, requestedNumber);
    await client.query('COMMIT');
    res.json({ number, company: GLOBAL_DOC_TYPES.has(docType) ? GLOBAL_COMPANY : company, docType });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (err instanceof NumberConflictError) {
      res.status(409).json({ conflict: true, ...err.conflict, docType, canReassign: true });
      return;
    }
    console.error('POST /api/document-numbers/reserve failed:', err);
    res.status(500).json({ error: 'Failed to reserve a document number' });
  } finally {
    client.release();
  }
});

// POST /api/document-numbers/check — READ ONLY.
// body: { company, docType?, requestedNumber }
// → 200 { available: true }
// → 200 { available: false, conflict: true, requestedNumber, conflictType, owner, suggestedNumber }
router.post('/check', async (req: Request, res: Response): Promise<void> => {
  const validated = validateCompanyAndDocType(req.body?.company, req.body?.docType, res);
  if (!validated) return;
  const { company, docType } = validated;
  const requestedNumber = typeof req.body?.requestedNumber === 'string' ? req.body.requestedNumber.trim() : '';
  if (!requestedNumber) {
    res.status(400).json({ error: 'requestedNumber is required.' });
    return;
  }
  try {
    const effectiveCompany = GLOBAL_DOC_TYPES.has(docType) ? GLOBAL_COMPANY : company;
    const stateRes = await pool.query('SELECT data FROM platform_state WHERE id = 1');
    const liveData = stateRes.rowCount ? stateRes.rows[0].data || {} : {};
    const liveNumbers = scanExistingNumbers(liveData, effectiveCompany, docType);
    const up = requestedNumber.toUpperCase();
    if (!liveNumbers.has(up)) {
      res.json({ available: true });
      return;
    }
    const suggestedNumber = await peekNextNumber(company, docType);
    res.json({
      available: false,
      conflict: true,
      requestedNumber: up,
      conflictType: `existing_${docType}`,
      owner: findOwner(liveData, effectiveCompany, docType, up),
      suggestedNumber,
      canReassign: true,
    });
  } catch (err) {
    console.error('POST /api/document-numbers/check failed:', err);
    res.status(500).json({ error: 'Failed to check number availability' });
  }
});

export default router;
export { reserveDocumentNumberWithClient, peekNextNumber, findOwner, scanExistingNumbers, deriveReservedInvoiceNumber };
export type { DocType };
