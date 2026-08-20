/**
 * REST endpoints over the Stage 1 relational business services
 * (backend/src/relational/services.ts). Stage 2 Phase 2.
 *
 * Audited before exposing (per the Stage 2 brief): services.ts functions
 * are used AS-IS below — this file is a thin HTTP adapter (request
 * parsing, auth, cutover-gating, error -> status-code mapping) and does
 * not re-implement or alter any business rule inside services.ts.
 *
 * ── Why every route checks isSectionCutOver() first ────────────────────
 * The rel_* tables are always live (services.ts, backfill.ts and this
 * router can all read/write them regardless of cutover state — that's
 * necessary for reconciliation, testing, and pre-cutover verification).
 * But EXPOSING them over HTTP as if they were the live, authoritative
 * business data for a section the double-gate has not actually enabled
 * for would let a client silently create relational records nobody reads
 * back (GET /api/platform-state still serves JSON for that section) and
 * nobody else editing through the JSON UI would ever see. So every
 * mutating route below re-checks the SAME double gate platformState.ts
 * uses before it will act — a request against a not-yet-cut-over section
 * gets a clear 409 `not_cut_over`, never a silent accept into a table
 * nothing is currently reading from.
 *
 * ── Response shape ───────────────────────────────────────────────────────
 * Every success response is `{ success: true, ...minimal fields }` — never
 * the full row, never legacy_data, never any other record's data. This is
 * the "minimal, non-blob response payload" the brief asks for: a client
 * needing the full up-to-date record shape re-reads it from
 * GET /api/platform-state (which, once a section is cut over, is served by
 * backend/src/relational/read.ts — the same authoritative representation).
 *
 * ── Concurrency ───────────────────────────────────────────────────────────
 * ConcurrencyConflictError from services.ts -> HTTP 409 with
 * `{ conflict: true, type: 'stale_record' }`, matching the shape/spirit of
 * platformState.ts's own 409 stale-revision response so the frontend's one
 * persistence abstraction (Phase 4) can handle both the same way.
 */
import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { isSectionCutOver, CutoverSection } from './cutover';
import {
  ConcurrencyConflictError, BusinessRuleError,
  createCustomer, updateCustomer,
  createQuote, convertQuoteToJob, updateQuote,
  createInvoiceForJob, finalizeProformaToInvoice,
  recordPayment, updateJob,
} from './services';

const router = Router();
router.use(authenticate);

function handleServiceError(err: unknown, res: Response): void {
  if (err instanceof ConcurrencyConflictError) {
    res.status(409).json({ conflict: true, type: 'stale_record', error: err.message });
    return;
  }
  if (err instanceof BusinessRuleError) {
    res.status(409).json({ conflict: false, type: 'business_rule', error: err.message });
    return;
  }
  console.error('[relational-api] unexpected error:', err);
  res.status(500).json({ error: 'Internal error' });
}

async function requireCutOver(section: CutoverSection, res: Response): Promise<boolean> {
  if (await isSectionCutOver(section)) return true;
  res.status(409).json({
    conflict: true, type: 'not_cut_over',
    error: `"${section}" is not currently cut over to relational authority — this endpoint refuses to act as if it were live.`,
  });
  return false;
}

// ── CUSTOMERS ──────────────────────────────────────────────────────────────
router.post('/customers', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('customers', res))) return;
  try {
    const { companyName, contactPerson, email, phone, address, vatNumber, notes } = req.body || {};
    if (!companyName || typeof companyName !== 'string') {
      res.status(400).json({ error: '"companyName" is required' }); return;
    }
    const result = await createCustomer({ companyName, contactPerson, email, phone, address, vatNumber, notes });
    res.status(201).json({ success: true, id: result.id, rowVersion: result.rowVersion });
  } catch (err) { handleServiceError(err, res); }
});

router.put('/customers/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('customers', res))) return;
  try {
    const id = Number(req.params.id);
    const expectedVersion = Number(req.body?.expectedVersion);
    if (!Number.isFinite(id) || !Number.isFinite(expectedVersion)) {
      res.status(400).json({ error: '"id" (path) and "expectedVersion" (body) must be numbers' }); return;
    }
    const { companyName, contactPerson, email, phone, address, vatNumber, notes } = req.body || {};
    const result = await updateCustomer(id, expectedVersion, { companyName, contactPerson, email, phone, address, vatNumber, notes });
    res.json({ success: true, rowVersion: result.rowVersion });
  } catch (err) { handleServiceError(err, res); }
});

// ── QUOTES ─────────────────────────────────────────────────────────────────
router.post('/quotes', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('quotes', res))) return;
  try {
    const { companyCode, customerId, customerNameRaw, lines, discountPct, setupFee, notes } = req.body || {};
    if (!companyCode || !customerNameRaw || !Array.isArray(lines) || lines.length === 0) {
      res.status(400).json({ error: '"companyCode", "customerNameRaw" and a non-empty "lines" array are required' }); return;
    }
    const result = await createQuote({ companyCode, customerId, customerNameRaw, lines, discountPct, setupFee, notes });
    res.status(201).json({ success: true, id: result.id, quoteNumber: result.quoteNumber });
  } catch (err) { handleServiceError(err, res); }
});

router.put('/quotes/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('quotes', res))) return;
  try {
    const id = Number(req.params.id);
    const expectedVersion = Number(req.body?.expectedVersion);
    if (!Number.isFinite(id) || !Number.isFinite(expectedVersion)) {
      res.status(400).json({ error: '"id" (path) and "expectedVersion" (body) must be numbers' }); return;
    }
    const { expectedVersion: _ev, ...patch } = req.body || {};
    const result = await updateQuote(id, expectedVersion, patch);
    res.json({ success: true, rowVersion: result.rowVersion });
  } catch (err) { handleServiceError(err, res); }
});

router.post('/quotes/:id/convert-to-job', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('quotes', res)) || !(await requireCutOver('jobs', res))) return;
  try {
    const quoteId = Number(req.params.id);
    if (!Number.isFinite(quoteId)) { res.status(400).json({ error: '"id" must be a number' }); return; }
    const result = await convertQuoteToJob(quoteId);
    res.status(201).json({ success: true, jobId: result.jobId, jobNumber: result.jobNumber });
  } catch (err) { handleServiceError(err, res); }
});

router.post('/quotes/:id/finalize-proforma', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('quotes', res)) || !(await requireCutOver('accInvoices', res))) return;
  try {
    const quoteId = Number(req.params.id);
    if (!Number.isFinite(quoteId)) { res.status(400).json({ error: '"id" must be a number' }); return; }
    const result = await finalizeProformaToInvoice(quoteId);
    res.status(201).json({ success: true, invoiceId: result.invoiceId, invoiceNumber: result.invoiceNumber });
  } catch (err) { handleServiceError(err, res); }
});

// ── JOBS ─────────────────────────────────────────────────────────────────
router.put('/jobs/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('jobs', res))) return;
  try {
    const id = Number(req.params.id);
    const expectedVersion = Number(req.body?.expectedVersion);
    if (!Number.isFinite(id) || !Number.isFinite(expectedVersion)) {
      res.status(400).json({ error: '"id" (path) and "expectedVersion" (body) must be numbers' }); return;
    }
    const { expectedVersion: _ev, ...patch } = req.body || {};
    const result = await updateJob(id, expectedVersion, patch);
    res.json({ success: true, rowVersion: result.rowVersion });
  } catch (err) { handleServiceError(err, res); }
});

router.post('/jobs/:id/create-invoice', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('jobs', res)) || !(await requireCutOver('accInvoices', res))) return;
  try {
    const jobId = Number(req.params.id);
    if (!Number.isFinite(jobId)) { res.status(400).json({ error: '"id" must be a number' }); return; }
    const result = await createInvoiceForJob(jobId);
    res.status(201).json({ success: true, invoiceId: result.invoiceId, invoiceNumber: result.invoiceNumber });
  } catch (err) { handleServiceError(err, res); }
});

// ── PAYMENTS ────────────────────────────────────────────────────────────────
// owner.type in {job, invoice, quote} — gated on that OWNER's section being
// cut over (payments has no independent JSON section of its own; see
// read.ts's SECTION_JSON_KEY comment).
router.post('/payments', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { ownerType, ownerId, amount, date, method, reference, notes } = req.body || {};
    if (!['job', 'invoice', 'quote'].includes(ownerType)) {
      res.status(400).json({ error: '"ownerType" must be one of job, invoice, quote' }); return;
    }
    const ownerSection: CutoverSection = ownerType === 'job' ? 'jobs' : ownerType === 'invoice' ? 'accInvoices' : 'quotes';
    if (!(await requireCutOver(ownerSection, res))) return;
    const id = Number(ownerId);
    const amt = Number(amount);
    if (!Number.isFinite(id) || !Number.isFinite(amt)) {
      res.status(400).json({ error: '"ownerId" and "amount" must be numbers' }); return;
    }
    const result = await recordPayment({ type: ownerType, id }, amt, { date, method, reference, notes });
    res.status(201).json({ success: true, paymentId: result.paymentId });
  } catch (err) { handleServiceError(err, res); }
});

// ── STATUS — which sections are actually live right now (non-sensitive) ───
router.get('/status', async (_req: AuthRequest, res: Response): Promise<void> => {
  const { ALL_SECTIONS } = await import('./cutover');
  const status: Record<string, boolean> = {};
  for (const s of ALL_SECTIONS) status[s] = await isSectionCutOver(s);
  res.json({ sections: status });
});

export default router;
