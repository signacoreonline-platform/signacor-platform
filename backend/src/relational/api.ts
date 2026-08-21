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
  ConcurrencyConflictError, BusinessRuleError, LegacyInvoiceConflictError,
  createCustomer, updateCustomer,
  createQuote, convertQuoteToJob, updateQuote, updateQuoteWithJobSync,
  createInvoiceForJob, finalizeProformaToInvoice,
  recordPayment, updateJob, updatePayment, deletePayment, getPaymentMethod,
  createCreditNote, updateCreditNote, deleteCreditNote,
  createPurchaseOrder, updatePurchaseOrder,
  createSupplier, updateSupplier, deleteSupplier,
  createInventoryItem, updateInventoryItem, adjustInventoryStock, deleteInventoryItem,
} from './services';

const router = Router();
router.use(authenticate);

function handleServiceError(err: unknown, res: Response): void {
  if (err instanceof ConcurrencyConflictError) {
    // STAGE 3 FOLLOW-UP (record-scoped concurrency): `table`/`id` exposed
    // alongside the pre-existing `conflict`/`type`/`error` shape (purely
    // additive — no existing consumer reads these two fields, so nothing
    // that already handles `{conflict:true, type:'stale_record'}` changes
    // behavior) so a caller editing a multi-record transaction (e.g. a quote
    // with a linked-job sync) can tell WHICH of the two records actually
    // conflicted, instead of only knowing that "something" did.
    res.status(409).json({ conflict: true, type: 'stale_record', error: err.message, table: err.table, id: err.id });
    return;
  }
  // STAGE 3 Phase 6 — checked BEFORE BusinessRuleError even though
  // LegacyInvoiceConflictError does not currently extend it (kept as a
  // sibling Error subclass, not a subtype, so this ordering is not
  // load-bearing — but ordering it first keeps the two visually adjacent
  // and makes it obvious at a glance that a legacy conflict is reported
  // with its own `type`, never folded into the generic 'business_rule'
  // shape a caller might otherwise treat as auto-retryable.
  if (err instanceof LegacyInvoiceConflictError) {
    res.status(409).json({ conflict: false, type: 'legacy_conflict', error: err.message, detail: err.detail });
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
    res.status(201).json({ success: true, id: result.id, quoteNumber: result.quoteNumber, rowVersion: result.rowVersion });
  } catch (err) { handleServiceError(err, res); }
});

// STAGE 3: this is the ONE endpoint for "edit a quote" — it always goes
// through updateQuoteWithJobSync (services.ts), which behaves identically to
// a plain field/lines patch when the quote has no linked job, and ADDITIONALLY
// cascades onto the linked job's display fields when it does. No separate
// "sync" endpoint exists, per the "do not create duplicate endpoints for the
// same operation" instruction. An optional `expectedJobVersion` in the body
// lets the caller assert the linked job's row hasn't changed either; if
// omitted, the job side is updated without a version check (still correct —
// the version check is a defense against a stale CLIENT read, not a
// correctness requirement of the cascade itself).
router.put('/quotes/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('quotes', res))) return;
  try {
    const id = Number(req.params.id);
    const expectedVersion = Number(req.body?.expectedVersion);
    if (!Number.isFinite(id) || !Number.isFinite(expectedVersion)) {
      res.status(400).json({ error: '"id" (path) and "expectedVersion" (body) must be numbers' }); return;
    }
    const { expectedVersion: _ev, expectedJobVersion, ...patch } = req.body || {};
    const result = await updateQuoteWithJobSync(id, expectedVersion, patch, {
      expectedJobVersion: expectedJobVersion !== undefined ? Number(expectedJobVersion) : undefined,
    });
    res.json({ success: true, rowVersion: result.quoteRowVersion, jobId: result.jobId, jobRowVersion: result.jobRowVersion });
  } catch (err) { handleServiceError(err, res); }
});

router.post('/quotes/:id/convert-to-job', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('quotes', res)) || !(await requireCutOver('jobs', res))) return;
  try {
    const quoteId = Number(req.params.id);
    if (!Number.isFinite(quoteId)) { res.status(400).json({ error: '"id" must be a number' }); return; }
    const result = await convertQuoteToJob(quoteId);
    res.status(201).json({ success: true, jobId: result.jobId, jobNumber: result.jobNumber, jobRowVersion: result.jobRowVersion });
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
    res.status(201).json({ success: true, invoiceId: result.invoiceId, invoiceNumber: result.invoiceNumber, jobRowVersion: result.jobRowVersion });
  } catch (err) { handleServiceError(err, res); }
});

// ── PAYMENTS ────────────────────────────────────────────────────────────────
// owner.type in {job, invoice, quote} — gated on that OWNER's section being
// cut over (payments has no independent JSON section of its own; see
// read.ts's SECTION_JSON_KEY comment).
//
// STAGE 3 Phase 5 — CREDIT PAYMENT / CREDIT NOTE CROSS-AUTHORITY DEPENDENCY.
// A method:'Credit' payment does not just write a rel_payments row under
// the owner's section — services.ts's recordPayment() ALSO locks and
// deducts matching rel_credit_notes rows (oldest-first funding) in the SAME
// transaction. If the owner's section (jobs/accInvoices/quotes) is cut over
// but "creditNotes" is NOT, that credit-note deduction happens invisibly:
// the live JSON-rendered Credit Notes page keeps reading platform_state.
// creditNotes, which never reflects the relational used_amount that was
// just consumed — a customer's available credit silently drifts out of
// sync between the two authorities, exactly the "one business operation,
// two authorities disagreeing" hazard the migration brief calls out. This
// is deliberately NOT a static cutoverCli dependency group (unlike
// quotes->jobs/inventory/purchaseOrders): most payments never use method
// 'Credit', so requiring creditNotes cut over before ANY job/invoice/quote
// payment could be recorded would be needlessly conservative. Instead it
// is checked per-request, only when method is actually 'Credit' — the one
// case that genuinely crosses into creditNotes' authority.
router.post('/payments', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { ownerType, ownerId, amount, date, method, reference, notes } = req.body || {};
    if (!['job', 'invoice', 'quote'].includes(ownerType)) {
      res.status(400).json({ error: '"ownerType" must be one of job, invoice, quote' }); return;
    }
    const ownerSection: CutoverSection = ownerType === 'job' ? 'jobs' : ownerType === 'invoice' ? 'accInvoices' : 'quotes';
    if (!(await requireCutOver(ownerSection, res))) return;
    if (method === 'Credit' && !(await isSectionCutOver('creditNotes'))) {
      res.status(409).json({
        conflict: true, type: 'cutover_dependency',
        error: `A Credit-method payment against "${ownerSection}" (relational-authoritative) would deduct from rel_credit_notes, but "creditNotes" is NOT cut over — its live JSON copy would silently go stale. Refusing to cross-write JSON and relational in one business operation. Enable "creditNotes" cutover first, then retry this Credit payment.`,
      });
      return;
    }
    const id = Number(ownerId);
    const amt = Number(amount);
    if (!Number.isFinite(id) || !Number.isFinite(amt)) {
      res.status(400).json({ error: '"ownerId" and "amount" must be numbers' }); return;
    }
    const result = await recordPayment({ type: ownerType, id }, amt, { date, method, reference, notes });
    res.status(201).json({ success: true, paymentId: result.paymentId, rowVersion: result.rowVersion, creditApplied: result.creditApplied });
  } catch (err) { handleServiceError(err, res); }
});

// PUT/DELETE gated on the SAME owner-section rule as POST above — a payment
// has no independent JSON section of its own (see read.ts SECTION_JSON_KEY).
router.put('/payments/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const ownerSection = req.body?.ownerSection as CutoverSection | undefined;
    if (!ownerSection || !(await requireCutOver(ownerSection, res))) {
      if (!ownerSection) res.status(400).json({ error: '"ownerSection" (jobs/accInvoices/quotes) is required in the body so this route can check the double gate' });
      return;
    }
    const id = Number(req.params.id);
    const expectedVersion = Number(req.body?.expectedVersion);
    if (!Number.isFinite(id) || !Number.isFinite(expectedVersion)) {
      res.status(400).json({ error: '"id" (path) and "expectedVersion" (body) must be numbers' }); return;
    }
    const { amount, date, method, reference, notes } = req.body || {};
    const result = await updatePayment(id, expectedVersion, { amount, date, method, reference, notes });
    res.json({ success: true, rowVersion: result.rowVersion });
  } catch (err) { handleServiceError(err, res); }
});

router.delete('/payments/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const ownerSection = req.body?.ownerSection as CutoverSection | undefined;
    if (!ownerSection || !(await requireCutOver(ownerSection, res))) {
      if (!ownerSection) res.status(400).json({ error: '"ownerSection" (jobs/accInvoices/quotes) is required in the body so this route can check the double gate' });
      return;
    }
    const id = Number(req.params.id);
    // MIGRATION CLOSURE Item 1: expectedVersion is now required in the body,
    // exactly like PUT /payments/:id above — deletePayment can no longer be
    // called without a version to check.
    const expectedVersion = Number(req.body?.expectedVersion);
    if (!Number.isFinite(id) || !Number.isFinite(expectedVersion)) {
      res.status(400).json({ error: '"id" (path) and "expectedVersion" (body) must be numbers' }); return;
    }
    // STAGE 3 Phase 5 — deleting a Credit-funded payment releases usage back
    // onto rel_credit_notes (see services.ts deletePayment) — the SAME
    // cross-authority hazard as recording one. Check BEFORE deleting.
    const method = await getPaymentMethod(id);
    if (method === 'Credit' && !(await isSectionCutOver('creditNotes'))) {
      res.status(409).json({
        conflict: true, type: 'cutover_dependency',
        error: `Deleting this Credit-funded payment would release usage back onto rel_credit_notes, but "creditNotes" is NOT cut over — its live JSON copy would silently go stale. Refusing to cross-write JSON and relational in one business operation. Enable "creditNotes" cutover first, then retry this delete.`,
      });
      return;
    }
    const result = await deletePayment(id, expectedVersion);
    res.json({ success: true, deleted: result.deleted, creditReleased: result.creditReleased });
  } catch (err) { handleServiceError(err, res); }
});

// ── CREDIT NOTES ─────────────────────────────────────────────────────────
router.post('/credit-notes', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('creditNotes', res))) return;
  try {
    const { type, contactName, date, amount, reason, appliedTo, notes, status } = req.body || {};
    if (!['customer', 'supplier'].includes(type) || !contactName || !Number.isFinite(Number(amount))) {
      res.status(400).json({ error: '"type" (customer/supplier), "contactName" and a numeric "amount" are required' }); return;
    }
    const result = await createCreditNote({ type, contactName, date, amount: Number(amount), reason, appliedTo, notes, status });
    res.status(201).json({ success: true, id: result.id, creditNumber: result.creditNumber, rowVersion: result.rowVersion });
  } catch (err) { handleServiceError(err, res); }
});

router.put('/credit-notes/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('creditNotes', res))) return;
  try {
    const id = Number(req.params.id);
    const expectedVersion = Number(req.body?.expectedVersion);
    if (!Number.isFinite(id) || !Number.isFinite(expectedVersion)) {
      res.status(400).json({ error: '"id" (path) and "expectedVersion" (body) must be numbers' }); return;
    }
    const { expectedVersion: _ev, ...patch } = req.body || {};
    const result = await updateCreditNote(id, expectedVersion, patch);
    res.json({ success: true, rowVersion: result.rowVersion });
  } catch (err) { handleServiceError(err, res); }
});

router.delete('/credit-notes/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('creditNotes', res))) return;
  try {
    const id = Number(req.params.id);
    const expectedVersion = Number(req.body?.expectedVersion);
    if (!Number.isFinite(id) || !Number.isFinite(expectedVersion)) {
      res.status(400).json({ error: '"id" (path) and "expectedVersion" (body) must be numbers' }); return;
    }
    const result = await deleteCreditNote(id, expectedVersion);
    res.json({ success: true, deleted: result.deleted });
  } catch (err) { handleServiceError(err, res); }
});

// ── PURCHASE ORDERS ──────────────────────────────────────────────────────
router.post('/purchase-orders', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('purchaseOrders', res))) return;
  try {
    const { companyCode, supplierId, jobId, jobNumberRaw, quoteId, quoteNumberRaw, orderDate, notes, items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: 'a non-empty "items" array is required' }); return;
    }
    const result = await createPurchaseOrder({ companyCode, supplierId, jobId, jobNumberRaw, quoteId, quoteNumberRaw, orderDate, notes, items });
    res.status(201).json({ success: true, id: result.id, poNumber: result.poNumber, rowVersion: result.rowVersion });
  } catch (err) { handleServiceError(err, res); }
});

router.put('/purchase-orders/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('purchaseOrders', res))) return;
  try {
    const id = Number(req.params.id);
    const expectedVersion = Number(req.body?.expectedVersion);
    if (!Number.isFinite(id) || !Number.isFinite(expectedVersion)) {
      res.status(400).json({ error: '"id" (path) and "expectedVersion" (body) must be numbers' }); return;
    }
    const { supplierId, status, notes } = req.body || {};
    const result = await updatePurchaseOrder(id, expectedVersion, { supplierId, status, notes });
    res.json({ success: true, rowVersion: result.rowVersion });
  } catch (err) { handleServiceError(err, res); }
});

// ── SUPPLIERS ────────────────────────────────────────────────────────────
router.post('/suppliers', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('suppliers', res))) return;
  try {
    const { name, contactPerson, phone, email, address, city, postalCode, vatNumber, accountNumber, notes, paymentTerms } = req.body || {};
    if (!name || typeof name !== 'string') { res.status(400).json({ error: '"name" is required' }); return; }
    const result = await createSupplier({ name, contactPerson, phone, email, address, city, postalCode, vatNumber, accountNumber, notes, paymentTerms });
    res.status(201).json({ success: true, id: result.id, rowVersion: result.rowVersion });
  } catch (err) { handleServiceError(err, res); }
});

router.put('/suppliers/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('suppliers', res))) return;
  try {
    const id = Number(req.params.id);
    const expectedVersion = Number(req.body?.expectedVersion);
    if (!Number.isFinite(id) || !Number.isFinite(expectedVersion)) {
      res.status(400).json({ error: '"id" (path) and "expectedVersion" (body) must be numbers' }); return;
    }
    const { expectedVersion: _ev, ...patch } = req.body || {};
    const result = await updateSupplier(id, expectedVersion, patch);
    res.json({ success: true, rowVersion: result.rowVersion });
  } catch (err) { handleServiceError(err, res); }
});

router.delete('/suppliers/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('suppliers', res))) return;
  try {
    const id = Number(req.params.id);
    const expectedVersion = Number(req.body?.expectedVersion);
    if (!Number.isFinite(id) || !Number.isFinite(expectedVersion)) {
      res.status(400).json({ error: '"id" (path) and "expectedVersion" (body) must be numbers' }); return;
    }
    const result = await deleteSupplier(id, expectedVersion);
    res.json({ success: true, deleted: result.deleted });
  } catch (err) { handleServiceError(err, res); }
});

// ── INVENTORY ────────────────────────────────────────────────────────────
router.post('/inventory', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('inventory', res))) return;
  try {
    const { sku, name, category, unit, cost, sell, stock, reorder, supplierId } = req.body || {};
    if (!name || typeof name !== 'string') { res.status(400).json({ error: '"name" is required' }); return; }
    const result = await createInventoryItem({ sku, name, category, unit, cost, sell, stock, reorder, supplierId });
    res.status(201).json({ success: true, id: result.id, rowVersion: result.rowVersion });
  } catch (err) { handleServiceError(err, res); }
});

router.put('/inventory/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('inventory', res))) return;
  try {
    const id = Number(req.params.id);
    const expectedVersion = Number(req.body?.expectedVersion);
    if (!Number.isFinite(id) || !Number.isFinite(expectedVersion)) {
      res.status(400).json({ error: '"id" (path) and "expectedVersion" (body) must be numbers' }); return;
    }
    const { expectedVersion: _ev, ...patch } = req.body || {};
    const result = await updateInventoryItem(id, expectedVersion, patch);
    res.json({ success: true, rowVersion: result.rowVersion });
  } catch (err) { handleServiceError(err, res); }
});

router.post('/inventory/:id/adjust', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('inventory', res))) return;
  try {
    const id = Number(req.params.id);
    const expectedVersion = Number(req.body?.expectedVersion);
    const delta = Number(req.body?.delta);
    if (!Number.isFinite(id) || !Number.isFinite(expectedVersion) || !Number.isFinite(delta)) {
      res.status(400).json({ error: '"id" (path), "expectedVersion" and "delta" (body) must be numbers' }); return;
    }
    const result = await adjustInventoryStock(id, expectedVersion, delta);
    res.json({ success: true, rowVersion: result.rowVersion, newStock: result.newStock });
  } catch (err) { handleServiceError(err, res); }
});

// MIGRATION CLOSURE Item 3: soft delete (services.ts's deleteInventoryItem
// flips is_active false — never a physical DELETE) under the same
// row-scoped expectedVersion discipline as PUT above.
router.delete('/inventory/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('inventory', res))) return;
  try {
    const id = Number(req.params.id);
    const expectedVersion = Number(req.body?.expectedVersion);
    if (!Number.isFinite(id) || !Number.isFinite(expectedVersion)) {
      res.status(400).json({ error: '"id" (path) and "expectedVersion" (body) must be numbers' }); return;
    }
    const result = await deleteInventoryItem(id, expectedVersion);
    res.json({ success: true, deactivated: result.deactivated });
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
