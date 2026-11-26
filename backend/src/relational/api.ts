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
import pool from '../db/pool';
import {
  ConcurrencyConflictError, BusinessRuleError, LegacyInvoiceConflictError,
  createCustomer, updateCustomer,
  createQuote, convertQuoteToJob, updateQuote, updateQuoteWithJobSync,
  createInvoiceForJob, ensureInvoiceForJob, finalizeProformaToInvoice, createInvoiceFromQuote, createJob,
  recordPayment, updateJob, deleteJob, updatePayment, deletePayment, getPaymentMethod,
  createCreditNote, updateCreditNote, deleteCreditNote,
  createPurchaseOrder, updatePurchaseOrder,
  createSupplier, updateSupplier, deleteSupplier,
  createInventoryItem, updateInventoryItem, adjustInventoryStock, deleteInventoryItem,
  createManualInvoice, updateInvoice, cancelInvoice, normalizeCustomerRef,
} from './services';
import { previewCustomerReassignment, reassignCustomerChain, MemberType } from './customerLinks';
import {
  applyCredit, reverseCreditAllocation, recordCreditRefund, reverseCreditRefund,
  getCustomerCredit, getCreditSummary, getDocumentCredit,
} from './customerCredit';

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
    // 2026-11-26: an ambiguous historical credit payment names its candidate notes so the user can choose.
    const candidates = (err as any).candidates;
    res.status(409).json({ conflict: false, type: 'business_rule', error: err.message, ...(Array.isArray(candidates) ? { candidates } : {}) });
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
    // POST-MIGRATION STABILIZATION (2026-08-24) — BUG 2. This handler used to
    // destructure only seven fields, silently discarding every contact/identity
    // field the Quote form collects even though rel_quotes has a column for
    // each. Widened to the full createQuote input; all the added fields are
    // optional, so existing callers are unaffected.
    // migration 015 (2026-09-21): `depositPct` is the optional custom deposit
    // percentage. Accepted here so the very FIRST save of a quote already
    // carries it (the same reason BUG 2 widened this handler) instead of
    // needing a follow-up edit. Validated/normalised in services.ts
    // (validateQuoteDepositPct) — out-of-range or non-numeric is refused
    // there with a readable message, never clamped.
    // PUT /quotes/:id needs no equivalent change: it rest-spreads the body
    // into `patch`, and updateQuoteWithJobSync's colMap is the whitelist.
    const {
      companyCode, customerId, customerNameRaw, lines, discountPct, setupFee, notes,
      contactPerson, email, phone, address, vatNumber, terms, salesperson, preparedBy,
      poRef, reference, quoteDate, validUntil, status, depositPct, customerRef,
    } = req.body || {};
    if (!companyCode || !customerNameRaw || !Array.isArray(lines) || lines.length === 0) {
      res.status(400).json({ error: '"companyCode", "customerNameRaw" and a non-empty "lines" array are required' }); return;
    }
    const result = await createQuote({
      companyCode, customerId, customerNameRaw, lines, discountPct, setupFee, notes,
      contactPerson, email, phone, address, vatNumber, terms, salesperson, preparedBy,
      poRef, reference, quoteDate, validUntil, status, depositPct, customerRef: normalizeCustomerRef(customerRef),
    });
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
    // ── BLOCKER 2 (2026-08-24) — `resyncJobLines` is stripped here and is
    // deliberately NOT forwarded. A quote edit over HTTP can never rewrite the
    // linked job's production line items, no matter what the client sends.
    // The service still supports an explicit resync (services.ts opts), but no
    // HTTP surface exposes it, because no UI workflow asks for one; the shipped
    // edit patch resends `lines` unconditionally, so an exposed flag would be
    // one stray field away from deleting production lines again.
    //
    // LINKED INVOICE (2026-08-27): `expectedInvoiceVersion` IS forwarded, and
    // is the opposite kind of field — it can only ever make a save FAIL safely
    // (a stale linked invoice is detected instead of overwritten), never make
    // it write something extra. The synchronisation itself is not opt-in: an
    // issued invoice describing a superseded version of the same sale is the
    // defect, so keeping the linked invoice current is part of what saving a
    // quote MEANS. What it may touch is bounded inside
    // syncLinkedInvoiceFromQuoteTx, not by a client flag.
    const {
      expectedVersion: _ev, expectedJobVersion, resyncJobLines: _rsjl,
      expectedInvoiceVersion, ...patch
    } = req.body || {};
    const result = await updateQuoteWithJobSync(id, expectedVersion, patch, {
      expectedJobVersion: expectedJobVersion !== undefined ? Number(expectedJobVersion) : undefined,
      expectedInvoiceVersion: expectedInvoiceVersion !== undefined ? Number(expectedInvoiceVersion) : undefined,
    });
    res.json({
      success: true, rowVersion: result.quoteRowVersion, jobId: result.jobId, jobRowVersion: result.jobRowVersion,
      // Reported so a caller can SEE what happened to the linked invoice —
      // including the two anomalies that deliberately do not fail the save
      // ('ambiguous', 'company-mismatch') and the two that mean there was
      // nothing to do ('no-linked-invoice', 'unchanged').
      invoiceSync: result.invoice,
    });
  } catch (err) { handleServiceError(err, res); }
});

// ── ADMIN REVISION OF A CONVERTED QUOTE (2026-11-10) ───────────────────────
// The controlled Quote -> Job -> Invoice reconciliation workflow that the
// CONVERTED-JOB FINANCIAL CONSISTENCY GUARD (services.ts) refers to as
// "belongs to the planned Transaction Troubleshooter". A customer changes the
// order after the quote has become a job (and possibly been invoiced); an
// ADMIN edits the quote and the change is pulled through:
//
//   quote lines/discount/setup fee  ->  rel_quotes (+ recomputed totals)
//                                   ->  rel_job_line_items REPLACED from the
//                                       quote lines (explicit resyncJobLines)
//                                   ->  rel_jobs.value recomputed
//                                   ->  linked invoice lines rebuilt from the
//                                       quote (syncLinkedInvoiceFromQuoteTx)
//
// ONE transaction (updateQuoteWithJobSync) — every existing guard still runs
// unchanged and a refusal rolls back the quote, the job and the invoice
// together. No rel_payments row is created, changed or deleted; only the
// outstanding balance moves, through recomputeOwnerPaymentStatus.
//
// WHY A SEPARATE ROUTE and not a flag on PUT /quotes/:id: BLOCKER 2
// (2026-08-24) deliberately strips `resyncJobLines` from that route because
// the ordinary edit patch always carries `lines`. That stays true. This route
// is the ONLY HTTP surface that can ask for a job-line resync, it is
// admin-only (role read from the AUTHENTICATED session, never the body), and
// it requires an explicit `confirmPullThrough: true` so a stray call can never
// replace production lines by accident.
router.put('/quotes/:id/admin-revise', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('quotes', res)) || !(await requireCutOver('jobs', res))) return;
  const actor = req.user;
  if (!actor || actor.role !== 'admin') {
    res.status(403).json({ conflict: false, type: 'forbidden', error: 'Only an admin can revise a quote that has already been converted to a job or invoiced.' });
    return;
  }
  try {
    const id = Number(req.params.id);
    const expectedVersion = Number(req.body?.expectedVersion);
    if (!Number.isFinite(id) || !Number.isFinite(expectedVersion)) {
      res.status(400).json({ error: '"id" (path) and "expectedVersion" (body) must be numbers' }); return;
    }
    if (req.body?.confirmPullThrough !== true) {
      res.status(400).json({ error: '"confirmPullThrough": true is required — this revision replaces the linked job\'s line items.' }); return;
    }
    const {
      expectedVersion: _ev, expectedJobVersion, resyncJobLines: _rsjl, confirmPullThrough: _cpt,
      expectedInvoiceVersion, ...patch
    } = req.body || {};
    if (!Array.isArray((patch as any).lines) || (patch as any).lines.length === 0) {
      res.status(400).json({ error: 'An admin revision must carry the quote\'s full, non-empty "lines" array.' }); return;
    }
    const result = await updateQuoteWithJobSync(id, expectedVersion, patch, {
      expectedJobVersion: expectedJobVersion !== undefined ? Number(expectedJobVersion) : undefined,
      expectedInvoiceVersion: expectedInvoiceVersion !== undefined ? Number(expectedInvoiceVersion) : undefined,
      resyncJobLines: true,
    });
    if (result.jobId === null) {
      // Nothing to pull through to — the save itself is an ordinary quote
      // edit and has committed; say so rather than pretend a revision ran.
      res.json({ success: true, rowVersion: result.quoteRowVersion, jobId: null, jobRowVersion: null, invoiceSync: result.invoice, pulledThrough: false });
      return;
    }
    console.log(`[admin-revise] quote ${id} revised by ${actor.email || actor.id}: job ${result.jobId} lines resynced; invoice ${result.invoice.invoiceNumber || '-'} ${result.invoice.reason}`);
    res.json({
      success: true, rowVersion: result.quoteRowVersion, jobId: result.jobId, jobRowVersion: result.jobRowVersion,
      invoiceSync: result.invoice, pulledThrough: true,
    });
  } catch (err) { handleServiceError(err, res); }
});

// CUTOVER BLOCKER COMPLETION — "quote status actions" named blocker
// (mark sent / approve / decline / admin reinstate). Deliberately its OWN
// route rather than folded into PUT /quotes/:id above: that route calls
// updateQuoteWithJobSync, whose colMap intentionally EXCLUDES status (see
// services.ts's comment on updateQuoteWithJobSync — a plain field/lines edit
// must never be able to smuggle in a status change, and a status change must
// never re-cascade quote display fields onto the linked job). This route
// calls the plain updateQuote() instead (services.ts), whose own colMap DOES
// include status, and touches nothing else.
router.patch('/quotes/:id/status', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('quotes', res))) return;
  try {
    const id = Number(req.params.id);
    const expectedVersion = Number(req.body?.expectedVersion);
    const { status } = req.body || {};
    if (!Number.isFinite(id) || !Number.isFinite(expectedVersion)) {
      res.status(400).json({ error: '"id" (path) and "expectedVersion" (body) must be numbers' }); return;
    }
    if (!status || typeof status !== 'string') {
      res.status(400).json({ error: '"status" is required' }); return;
    }
    const result = await updateQuote(id, expectedVersion, { status });
    res.json({ success: true, rowVersion: result.rowVersion });
  } catch (err) { handleServiceError(err, res); }
});

router.post('/quotes/:id/convert-to-job', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('quotes', res)) || !(await requireCutOver('jobs', res))) return;
  try {
    const quoteId = Number(req.params.id);
    if (!Number.isFinite(quoteId)) { res.status(400).json({ error: '"id" must be a number' }); return; }
    const result = await convertQuoteToJob(quoteId);
    // POST-MIGRATION STABILIZATION (2026-08-24) — BUG 3. `quoteRowVersion` is
    // new: converting bumps the QUOTE's row_version too, and without reporting
    // it the client kept a stale expectedVersion and 409'd on its very next
    // edit of that quote. Purely additive to the response shape.
    res.status(201).json({ success: true, jobId: result.jobId, jobNumber: result.jobNumber, jobRowVersion: result.jobRowVersion, quoteRowVersion: result.quoteRowVersion });
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

// DIRECT-INVOICE-FROM-QUOTE REPAIR (2026-08-25). index.html's "Create Invoice
// from Quote" button used to POST to /finalize-proforma above, which exists
// only to finalise an EXISTING PRO-##### reservation and therefore refused
// every approved quote that had never had a proforma printed or emailed
// (`quote 371 has no proforma reservation to finalise`). This is the direct
// path that was missing: it finalises the reservation when there is one, and
// otherwise reserves a fresh invoice number from the same atomic counter every
// other invoice uses. Deliberately its OWN route rather than a flag on the one
// above, so /finalize-proforma's strict "there must be a reservation" contract
// — relied on by the proforma numbering suites — stays exactly as it is. See
// services.ts's createInvoiceFromQuoteTx for the full rationale.
router.post('/quotes/:id/create-invoice', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('quotes', res)) || !(await requireCutOver('accInvoices', res))) return;
  try {
    const quoteId = Number(req.params.id);
    if (!Number.isFinite(quoteId)) { res.status(400).json({ error: '"id" must be a number' }); return; }
    const result = await createInvoiceFromQuote(quoteId);
    // `reused` tells the client this quote ALREADY had an invoice and none was
    // created — it must then open that one rather than adding a second record
    // to its local accInvoices, which would show as a duplicate until the next
    // authoritative refresh. 200 (not 201) says the same thing in HTTP terms.
    res.status(result.reused ? 200 : 201).json({
      success: true, invoiceId: result.invoiceId, invoiceNumber: result.invoiceNumber, reused: result.reused,
    });
  } catch (err) { handleServiceError(err, res); }
});

// ── JOBS ─────────────────────────────────────────────────────────────────
// POST-MIGRATION STABILIZATION (2026-08-24) — FRONTEND AUDIT (BUG 8). The Jobs
// page's "➕ Add New Job" action (a job that never came from a quote) had no
// relational endpoint at all, so once "jobs" cut over it silently lost every
// job created that way. See services.ts's createJob for the full rationale.
router.post('/jobs', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('jobs', res))) return;
  try {
    const {
      companyCode, customerId, customerNameRaw, description, status, stage, value, notes,
      contactPerson, email, phone, address, vatNumber, reference, salesperson, dueDate, customerRef,
    } = req.body || {};
    if (!companyCode || typeof companyCode !== 'string') {
      res.status(400).json({ error: '"companyCode" is required' }); return;
    }
    if (!customerNameRaw || typeof customerNameRaw !== 'string' || !customerNameRaw.trim()) {
      res.status(400).json({ error: '"customerNameRaw" (the client) is required' }); return;
    }
    const result = await createJob({
      companyCode, customerId, customerNameRaw, description, status, stage, value, notes,
      contactPerson, email, phone, address, vatNumber, reference, salesperson, dueDate, customerRef: normalizeCustomerRef(customerRef),
    });
    res.status(201).json({ success: true, id: result.id, jobNumber: result.jobNumber, rowVersion: result.rowVersion });
  } catch (err) { handleServiceError(err, res); }
});

router.put('/jobs/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('jobs', res))) return;
  try {
    const id = Number(req.params.id);
    const expectedVersion = Number(req.body?.expectedVersion);
    if (!Number.isFinite(id) || !Number.isFinite(expectedVersion)) {
      res.status(400).json({ error: '"id" (path) and "expectedVersion" (body) must be numbers' }); return;
    }
    const { expectedVersion: _ev, depositWaivedBy: _ignoredActor, ...patch } = req.body || {};
    // POST-MIGRATION STABILIZATION (2026-08-24): the deposit-waiver actor is
    // taken from the AUTHENTICATED session and the body's value is discarded.
    // Leaving it caller-supplied would have made attribution for a
    // financial-control override forgeable by any client, and — since the UI
    // never sent it — would have left deposit_waived_by permanently NULL, so the
    // audit record migration 012 exists to create was never actually written.
    if ((patch as any).depositWaived !== undefined) {
      const actor = req.user as any;
      (patch as any).depositWaivedBy = (actor && (actor.email || actor.id)) || null;
    }
    const result = await updateJob(id, expectedVersion, patch);
    // 2026-09-07 — CANONICAL DISCOUNT CASCADE. A save that changes the
    // transaction's commercial content now also writes the discount through to
    // the chain's head quote and rebuilds the linked invoice's lines, in the
    // SAME transaction (see services.ts's updateJob). Both of those bump a
    // row_version the caller is still holding the OLD value of, so they are
    // reported back — exactly as convertQuoteToJob/deleteJob already report
    // `unlinkedQuotes` — and the client refreshes its expected versions instead
    // of discovering they went stale on its next save (a spurious 409).
    res.json({
      success: true,
      rowVersion: result.rowVersion,
      quoteId: result.quoteId,
      quoteRowVersion: result.quoteRowVersion,
      invoices: result.invoices,
    });
  } catch (err) { handleServiceError(err, res); }
});

router.post('/jobs/:id/create-invoice', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('jobs', res)) || !(await requireCutOver('accInvoices', res))) return;
  try {
    const jobId = Number(req.params.id);
    if (!Number.isFinite(jobId)) { res.status(400).json({ error: '"id" must be a number' }); return; }
    const result = await createInvoiceForJob(jobId);
    // 2026-08-23 (production cutover repair): jobStage/jobStatus reflect
    // what createInvoiceForJob ACTUALLY did to the job (see its own
    // comment) — the stage/status bump to Invoiced(9) only happens when the
    // job had already reached INSTALL_STAGE; otherwise these come back
    // unchanged from the job's stage/status before this call. The frontend
    // must reflect these exact values rather than assuming stage 9 —
    // duplicating that assumption client-side is exactly the kind of
    // same-root-cause drift this repair closes.
    res.status(201).json({ success: true, invoiceId: result.invoiceId, invoiceNumber: result.invoiceNumber, created: result.created, reused: result.reused, jobRowVersion: result.jobRowVersion, jobStage: result.jobStage, jobStatus: result.jobStatus });
  } catch (err) { handleServiceError(err, res); }
});

// ── COMPLETED → AUTO-INVOICE (2026-08-25) ──────────────────────────────────
// "This job has reached Completed — make sure exactly one valid invoice exists
// for it." Deliberately a SEPARATE endpoint from POST /jobs/:id/create-invoice
// above rather than a flag on it, for the same reason PATCH /quotes/:id/status
// is separate from PUT /quotes/:id: the two have different contracts on an
// already-invoiced job (the explicit action refuses it and says so; this one
// resolves and reuses), and a caller must choose that contract explicitly
// rather than have it inferred. BOTH go through services.ts's single
// jobInvoiceTx writer — same numbering pool, same historical-pieces
// protection, same job-total consistency guard, same row locks.
//
// Gated on BOTH 'jobs' and 'accInvoices', identically to create-invoice: an
// automatic step must never be able to write where the explicit one may not.
// `created` tells the client whether a document was actually raised, so the UI
// can say "Invoice INV-00112 created" versus silently reusing what was there.
router.post('/jobs/:id/ensure-invoice', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('jobs', res)) || !(await requireCutOver('accInvoices', res))) return;
  try {
    const jobId = Number(req.params.id);
    if (!Number.isFinite(jobId)) { res.status(400).json({ error: '"id" must be a number' }); return; }
    const result = await ensureInvoiceForJob(jobId);
    // 200, not 201: this endpoint's success frequently means "nothing was
    // created, the existing invoice was resolved" — the honest status for an
    // idempotent ensure. `created` carries the distinction.
    res.status(200).json({ success: true, invoiceId: result.invoiceId, invoiceNumber: result.invoiceNumber, created: result.created, reused: result.reused, jobRowVersion: result.jobRowVersion, jobStage: result.jobStage, jobStatus: result.jobStatus });
  } catch (err) { handleServiceError(err, res); }
});

// CUTOVER BLOCKER COMPLETION — "job deletion" named blocker. Mirrors every
// other DELETE route's expectedVersion-in-body / handleServiceError pattern.
// services.ts's deleteJob() itself refuses (BusinessRuleError -> 409
// business_rule) when an invoice or PO still FK-references this job, and
// reverts a converted-from quote back to 'approved' in the same transaction
// — see services.ts for the full rationale.
router.delete('/jobs/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('jobs', res))) return;
  try {
    const id = Number(req.params.id);
    const expectedVersion = Number(req.body?.expectedVersion);
    if (!Number.isFinite(id) || !Number.isFinite(expectedVersion)) {
      res.status(400).json({ error: '"id" (path) and "expectedVersion" (body) must be numbers' }); return;
    }
    const result = await deleteJob(id, expectedVersion);
    // POST-MIGRATION STABILIZATION (2026-08-24) — BUG 3, same stale-version
    // class as convert-to-job: unlinking a converted quote bumps its
    // row_version. Reported back so the client can stay in step. Additive.
    res.json({ success: true, deleted: result.deleted, unlinkedQuotes: result.unlinkedQuotes });
  } catch (err) { handleServiceError(err, res); }
});

// ── ACC INVOICES ─────────────────────────────────────────────────────────
// CUTOVER BLOCKER COMPLETION — "manual invoicing" / "invoice deletion" named
// blockers. Distinct from POST /jobs/:id/create-invoice above (which derives
// an invoice FROM a job's own lines) — these three routes are for a
// standalone/manual invoice (AccountingPage's "new invoice" flow) and for
// editing/deleting any accInvoices row regardless of how it was created.
router.post('/invoices', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('accInvoices', res))) return;
  try {
    const {
      companyCode, customerId, contactName, contactEmail, contactAddress,
      reference, status, issueDate, dueDate, lines, customerRef,
    } = req.body || {};
    if (!companyCode || typeof companyCode !== 'string') {
      res.status(400).json({ error: '"companyCode" is required' }); return;
    }
    if (!Array.isArray(lines) || lines.length === 0) {
      res.status(400).json({ error: 'a non-empty "lines" array is required' }); return;
    }
    const result = await createManualInvoice({
      companyCode, customerId, contactName, contactEmail, contactAddress,
      reference, status, issueDate, dueDate, lines, customerRef: normalizeCustomerRef(customerRef),
    });
    res.status(201).json({ success: true, id: result.id, invoiceNumber: result.invoiceNumber, rowVersion: result.rowVersion });
  } catch (err) { handleServiceError(err, res); }
});

router.put('/invoices/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('accInvoices', res))) return;
  try {
    const id = Number(req.params.id);
    const expectedVersion = Number(req.body?.expectedVersion);
    if (!Number.isFinite(id) || !Number.isFinite(expectedVersion)) {
      res.status(400).json({ error: '"id" (path) and "expectedVersion" (body) must be numbers' }); return;
    }
    const { expectedVersion: _ev, ...patch } = req.body || {};
    const result = await updateInvoice(id, expectedVersion, patch);
    res.json({ success: true, rowVersion: result.rowVersion });
  } catch (err) { handleServiceError(err, res); }
});

// ── CANCEL INVOICE (2026-11-19) ─────────────────────────────────────────────
// An invoice is never deleted any more. Both routes below run the SAME
// server-side operation (services.ts cancelInvoice): the invoice row, its
// number and its original lines are kept, status becomes 'void', who/when/why
// is recorded, and the job's invoice linkage is released so a replacement can
// be raised — all in one transaction.
//
//   POST   /invoices/:id/cancel   the route the dashboard uses.
//   DELETE /invoices/:id          kept ONLY so a browser tab still running an
//                                 older index.html cannot hard-delete: it now
//                                 cancels too, and answers `deleted: false`.
//
// Gated on BOTH sections, exactly like POST /jobs/:id/create-invoice — the
// operation this one reverses on the job side. With "jobs" still on JSON
// authority the linkage write would land in a table nothing reads.
//
// ADMIN ONLY, from the signed session — the record says "Cancelled by Admin",
// so the server has to know that it was. A Holdings admin can only cancel a
// Holdings invoice. Safe to repeat: a second request finds the invoice already
// cancelled, writes nothing and returns the same record.
async function handleCancelInvoice(req: AuthRequest, res: Response, legacyDeleteRoute: boolean): Promise<void> {
  if (!(await requireCutOver('jobs', res)) || !(await requireCutOver('accInvoices', res))) return;
  const actor = req.user;
  if (!actor || actor.role !== 'admin') {
    res.status(403).json({ conflict: false, type: 'forbidden', error: 'Only an admin can cancel an invoice. The invoice was not changed.' });
    return;
  }
  try {
    const id = Number(req.params.id);
    const rawVersion = req.body?.expectedVersion;
    const expectedVersion = (rawVersion === undefined || rawVersion === null || rawVersion === '') ? null : Number(rawVersion);
    if (!Number.isFinite(id) || (expectedVersion !== null && !Number.isFinite(expectedVersion))) {
      res.status(400).json({ error: '"id" (path) must be a number and "expectedVersion" (body), when sent, must be a number' }); return;
    }
    // A reason is REQUIRED on the real route. The legacy DELETE route cannot
    // carry one (an older page sends only expectedVersion), so the service
    // records its default wording there.
    const reasonText = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!legacyDeleteRoute && !reasonText) {
      res.status(400).json({ error: 'A cancellation reason is required. The invoice was not changed.' }); return;
    }
    // COMPANY ISOLATION: a company-bound admin never reaches another company's invoice.
    if (actor.co !== undefined && actor.co !== null) {
      const co = await pool.query('SELECT company_code FROM rel_invoices WHERE id = $1', [id]);
      if ((co.rowCount ?? 0) > 0 && String(co.rows[0].company_code) !== String(actor.co)) {
        res.status(403).json({ conflict: false, type: 'forbidden', error: 'This invoice belongs to another company. The invoice was not changed.' });
        return;
      }
    }
    const result = await cancelInvoice(id, expectedVersion, {
      reason: reasonText || null,
      replacedBy: typeof req.body?.replacedBy === 'string' ? req.body.replacedBy : null,
      actor: { id: actor.id, email: actor.email, role: actor.role },
      via: legacyDeleteRoute ? 'api:DELETE /invoices/:id (cancelled, not deleted)' : 'api:POST /invoices/:id/cancel',
    });
    if (!result.alreadyCancelled) {
      console.log(`[cancel-invoice] ${result.invoiceNumber} (id ${result.invoiceId}) cancelled by ${actor.email || actor.id}; jobs released: ${result.clearedJobs.map((j) => j.jobNumber).join(', ') || '-'}`);
    }
    // `clearedJobs` / `ambiguousJobs` keep the meaning they had on the delete
    // route (see services.ts): jobs whose own invoice linkage was released, and
    // jobs left untouched because a historical numbering collision makes the
    // owner a human decision. `creditReleased` is always 0 — cancelling never
    // removes a payment, so no credit is ever released by it.
    res.json({
      success: true, cancelled: true, deleted: false, alreadyCancelled: result.alreadyCancelled,
      invoiceId: result.invoiceId, invoiceNumber: result.invoiceNumber, status: result.status,
      rowVersion: result.rowVersion, marker: result.marker,
      clearedJobs: result.clearedJobs, ambiguousJobs: result.ambiguousJobs, creditReleased: 0,
    });
  } catch (err) { handleServiceError(err, res); }
}
router.post('/invoices/:id/cancel', (req: AuthRequest, res: Response): Promise<void> => handleCancelInvoice(req, res, false));
router.delete('/invoices/:id', (req: AuthRequest, res: Response): Promise<void> => handleCancelInvoice(req, res, true));

// ── CUSTOMER LINKS (021, 2026-11-24) ─────────────────────────────────────────
// Change which customer owns a whole quote -> job -> invoice chain (or link an
// unlinked one). GET previews the members, the target customer and any
// conflict; POST applies it in ONE transaction, re-checking every member's
// row version from the preview. See customerLinks.ts for the full contract.
// Who may: any signed-in editor for a quote-only chain; once the chain holds a
// job or an invoice (financial documents), admin or accounts only, matching
// the existing "only an admin can edit a converted quote" rule. A company-bound
// user (Holdings) can only act on their own company's chain.
const CHAIN_SECTIONS: Record<MemberType, CutoverSection> = { quote: 'quotes', job: 'jobs', invoice: 'accInvoices' };
function parseAnchor(src: any): { type: MemberType; id: number } | null {
  const type = String(src?.anchorType || '') as MemberType;
  const id = Number(src?.anchorId);
  if (!['quote', 'job', 'invoice'].includes(type) || !Number.isFinite(id)) return null;
  return { type, id };
}
async function chainGate(req: AuthRequest, res: Response, anchor: { type: MemberType; id: number }): Promise<boolean> {
  for (const s of ['quotes', 'jobs', 'accInvoices'] as CutoverSection[]) { if (!(await requireCutOver(s, res))) return false; }
  if (!CHAIN_SECTIONS[anchor.type]) { res.status(400).json({ error: 'Unknown document type.' }); return false; }
  return true;
}
function chainAllowed(req: AuthRequest, res: Response, preview: { companyCode: string | null; members: Array<{ type: string }> }): boolean {
  const actor = req.user;
  if (!actor || actor.role === 'factory') { res.status(403).json({ conflict: false, type: 'forbidden', error: 'This login cannot change the customer on documents.' }); return false; }
  const financial = preview.members.some((m) => m.type !== 'quote');
  if (financial && !['admin', 'accounts'].includes(String(actor.role))) {
    res.status(403).json({ conflict: false, type: 'forbidden', error: 'Only an admin or accounts login can change the customer of a quote that has a job or invoice. Nothing was changed.' }); return false;
  }
  if (actor.co !== undefined && actor.co !== null && String(preview.companyCode ?? '') !== String(actor.co)) {
    res.status(403).json({ conflict: false, type: 'forbidden', error: 'These documents belong to another company. Nothing was changed.' }); return false;
  }
  return true;
}
router.get('/customer-links/preview', async (req: AuthRequest, res: Response): Promise<void> => {
  const anchor = parseAnchor(req.query);
  if (!anchor) { res.status(400).json({ error: '"anchorType" (quote/job/invoice) and a numeric "anchorId" are required' }); return; }
  if (!(await chainGate(req, res, anchor))) return;
  try {
    const preview = await previewCustomerReassignment(anchor.type, anchor.id, req.query.customerRef);
    if (!chainAllowed(req, res, preview)) return;
    res.json({ success: true, preview });
  } catch (err) { handleServiceError(err, res); }
});
router.post('/customer-links/reassign', async (req: AuthRequest, res: Response): Promise<void> => {
  const anchor = parseAnchor(req.body);
  if (!anchor) { res.status(400).json({ error: '"anchorType" (quote/job/invoice) and a numeric "anchorId" are required' }); return; }
  const expected = req.body?.expectedVersions;
  if (!expected || typeof expected !== 'object') { res.status(400).json({ error: '"expectedVersions" from the preview is required' }); return; }
  if (!(await chainGate(req, res, anchor))) return;
  try {
    const preview = await previewCustomerReassignment(anchor.type, anchor.id, req.body?.customerRef);
    if (!chainAllowed(req, res, preview)) return;
    const result = await reassignCustomerChain(anchor.type, anchor.id, req.body?.customerRef, expected, req.user ? { id: req.user.id, email: req.user.email } : null);
    console.log(`[customer-links] ${anchor.type} ${anchor.id}: ${result.members.length} document(s) now belong to customer ${result.target.ref} (${result.target.companyName}) — by ${req.user?.email || req.user?.id}`);
    res.json({ success: true, result });
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
    const { ownerType, ownerId, amount, date, method, reference, notes, clientRequestId, creditNoteId } = req.body || {};
    if (!['job', 'invoice', 'quote'].includes(ownerType)) {
      res.status(400).json({ error: '"ownerType" must be one of job, invoice, quote' }); return;
    }
    const ownerSection: CutoverSection = ownerType === 'job' ? 'jobs' : ownerType === 'invoice' ? 'accInvoices' : 'quotes';
    if (!(await requireCutOver(ownerSection, res))) return;
    if (String(method || '').trim().toLowerCase().startsWith('credit') && !(await isSectionCutOver('creditNotes'))) {
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
    // 2026-09-07 — ACCIDENTAL DUPLICATE PROTECTION. `clientRequestId` identifies
    // ONE payment submission attempt (see services.ts's recordPayment and
    // migration 014). A retry of that same submission — after a timeout, a lost
    // response, or a double-click — returns the payment the first attempt
    // already persisted rather than creating a second one. Two genuinely
    // separate payments carry different keys and are both recorded, so the
    // legitimate "R5,000 twice on the same day" case is untouched. A caller that
    // sends no key behaves exactly as before.
    const result = await recordPayment({ type: ownerType, id }, amt, {
      date, method, reference, notes, clientRequestId,
      creditNoteId: creditNoteId == null || creditNoteId === '' ? null : Number(creditNoteId),
      actor: req.user ? { id: req.user.id, email: req.user.email, role: req.user.role, co: req.user.co } : null,
    });
    // 201 on a real create, 200 on a recognised replay — an honest distinction
    // the client can act on, while both are ordinary successes carrying the same
    // canonical payment id.
    res.status(result.deduplicated ? 200 : 201).json({
      success: true,
      paymentId: result.paymentId,
      rowVersion: result.rowVersion,
      creditApplied: result.creditApplied,
      deduplicated: result.deduplicated === true,
    });
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
    if (String(method || '').trim().toLowerCase().startsWith('credit') && !(await isSectionCutOver('creditNotes'))) {
      res.status(409).json({
        conflict: true, type: 'cutover_dependency',
        error: `Deleting this Credit-funded payment would release usage back onto rel_credit_notes, but "creditNotes" is NOT cut over — its live JSON copy would silently go stale. Refusing to cross-write JSON and relational in one business operation. Enable "creditNotes" cutover first, then retry this delete.`,
      });
      return;
    }
    const releaseTo = req.body?.releaseToCreditNoteId;
    const result = await deletePayment(id, expectedVersion, {
      releaseToCreditNoteId: releaseTo == null || releaseTo === '' ? null : Number(releaseTo),
      actor: req.user ? { id: req.user.id, email: req.user.email, role: req.user.role, co: req.user.co } : null,
    });
    res.json({ success: true, deleted: result.deleted, creditReleased: result.creditReleased });
  } catch (err) { handleServiceError(err, res); }
});

// ── CUSTOMER CREDIT (022, 2026-11-26) ───────────────────────────────────────
// Payment credit (overpaid receipts), credit-note credit, allocations and
// recorded refunds. See customerCredit.ts for every rule. Reads are open to any
// signed-in login for its own company; applying, reversing and refunding credit
// is for an admin or accounts login. A Holdings login sees and acts only on
// Holdings (company 1); an original-company login never on Holdings.
const CREDIT_SECTIONS: CutoverSection[] = ['quotes', 'jobs', 'accInvoices', 'creditNotes'];
async function creditGate(res: Response): Promise<boolean> {
  for (const s of CREDIT_SECTIONS) { if (!(await requireCutOver(s, res))) return false; }
  return true;
}
function creditActor(req: AuthRequest) {
  return req.user ? { id: req.user.id, email: req.user.email, role: req.user.role, co: req.user.co } : null;
}
function companyAllowed(req: AuthRequest, code: unknown): boolean {
  const c = String(code ?? '');
  if (!req.user) return false;
  return Number(req.user.co) === 1 ? c === '1' : c !== '1';
}
function denyCompany(res: Response): void {
  res.status(403).json({ conflict: false, type: 'forbidden', error: 'That customer credit belongs to another company.' });
}
function creditWriter(req: AuthRequest, res: Response): boolean {
  if (!req.user || !['admin', 'accounts'].includes(String(req.user.role))) {
    res.status(403).json({ conflict: false, type: 'forbidden', error: 'Only an admin or accounts login can apply, reverse or refund customer credit.' });
    return false;
  }
  return true;
}
async function ownerCompany(type: string, id: number): Promise<string | null> {
  const table = type === 'invoice' ? 'rel_invoices' : type === 'job' ? 'rel_jobs' : type === 'quote' ? 'rel_quotes' : null;
  if (!table || !Number.isFinite(id)) return null;
  const r = await pool.query(`SELECT company_code FROM ${table} WHERE id = $1`, [id]);
  return r.rowCount ? String(r.rows[0].company_code ?? '') : null;
}
async function allowedCompanies(req: AuthRequest): Promise<string[]> {
  if (Number(req.user?.co) === 1) return ['1'];
  const r = await pool.query(
    `SELECT DISTINCT company_code AS c FROM (
       SELECT company_code FROM rel_invoices UNION SELECT company_code FROM rel_jobs UNION SELECT company_code FROM rel_quotes UNION SELECT company_code FROM rel_credit_notes
     ) x WHERE company_code IS NOT NULL AND company_code <> '1'`);
  return r.rows.map((x: any) => String(x.c));
}

router.get('/customer-credit/summary', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await creditGate(res))) return;
  try {
    const allowed = await allowedCompanies(req);
    const want = req.query.companyCode ? [String(req.query.companyCode)] : allowed;
    if (want.some((c) => !allowed.includes(c) && !companyAllowed(req, c))) { denyCompany(res); return; }
    const summary = await getCreditSummary(want.filter((c) => companyAllowed(req, c)));
    res.json({ success: true, companies: allowed, ...summary });
  } catch (err) { handleServiceError(err, res); }
});
router.get('/customer-credit', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await creditGate(res))) return;
  const companyCode = String(req.query.companyCode || '');
  const customerRef = normalizeCustomerRef(req.query.customerRef);
  if (!companyCode || !customerRef) { res.status(400).json({ error: '"companyCode" and "customerRef" are required' }); return; }
  if (!companyAllowed(req, companyCode)) { denyCompany(res); return; }
  try { res.json({ success: true, credit: await getCustomerCredit(companyCode, customerRef) }); }
  catch (err) { handleServiceError(err, res); }
});
router.get('/customer-credit/document', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await creditGate(res))) return;
  const ownerType = String(req.query.ownerType || '');
  const ownerId = Number(req.query.ownerId);
  if (!['invoice', 'job', 'quote'].includes(ownerType) || !Number.isFinite(ownerId)) { res.status(400).json({ error: '"ownerType" (invoice/job/quote) and a numeric "ownerId" are required' }); return; }
  try {
    const co = await ownerCompany(ownerType, ownerId);
    if (co === null) { res.status(404).json({ error: 'Document not found' }); return; }
    if (!companyAllowed(req, co)) { denyCompany(res); return; }
    res.json({ success: true, ...(await getDocumentCredit(ownerType as any, ownerId)) });
  } catch (err) { handleServiceError(err, res); }
});
router.post('/credit-allocations', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await creditGate(res))) return;
  if (!creditWriter(req, res)) return;
  const { sourceType, sourceId, targetType, targetId, amount, clientRequestId, notes } = req.body || {};
  const tId = Number(targetId); const sId = Number(sourceId);
  if (!['payment', 'credit_note'].includes(sourceType) || !Number.isFinite(sId) || !['invoice', 'job'].includes(targetType) || !Number.isFinite(tId)) {
    res.status(400).json({ error: '"sourceType" (payment/credit_note), numeric "sourceId", "targetType" (invoice/job) and numeric "targetId" are required' }); return;
  }
  try {
    const co = await ownerCompany(targetType, tId);
    if (co === null) { res.status(404).json({ error: 'Document not found' }); return; }
    if (!companyAllowed(req, co)) { denyCompany(res); return; }
    const result = await applyCredit({ sourceType, sourceId: sId, targetType, targetId: tId, amount, clientRequestId, notes: notes ?? null, actor: creditActor(req) });
    res.status(result.deduplicated ? 200 : 201).json({ success: true, ...result });
  } catch (err) { handleServiceError(err, res); }
});
router.post('/credit-allocations/:id/reverse', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await creditGate(res))) return;
  if (!creditWriter(req, res)) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: 'numeric id required' }); return; }
  try {
    const r = await pool.query('SELECT company_code FROM rel_credit_allocations WHERE id = $1', [id]);
    if (!r.rowCount) { res.status(404).json({ error: 'Allocation not found' }); return; }
    if (!companyAllowed(req, r.rows[0].company_code)) { denyCompany(res); return; }
    const ev = req.body?.expectedVersion;
    res.json({ success: true, ...(await reverseCreditAllocation(id, { expectedVersion: ev == null ? null : Number(ev), reason: req.body?.reason ?? null, actor: creditActor(req) })) });
  } catch (err) { handleServiceError(err, res); }
});
router.post('/credit-refunds', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await creditGate(res))) return;
  if (!creditWriter(req, res)) return;
  const { sourceType, sourceId, amount, date, method, reference, notes, clientRequestId } = req.body || {};
  const sId = Number(sourceId);
  if (!['payment', 'credit_note'].includes(sourceType) || !Number.isFinite(sId)) { res.status(400).json({ error: '"sourceType" (payment/credit_note) and numeric "sourceId" are required' }); return; }
  try {
    let co: string | null = null;
    if (sourceType === 'payment') {
      const p = await pool.query('SELECT owner_type, owner_id FROM rel_payments WHERE id = $1', [sId]);
      if (p.rowCount) co = await ownerCompany(p.rows[0].owner_type, Number(p.rows[0].owner_id));
    } else {
      const n = await pool.query('SELECT company_code FROM rel_credit_notes WHERE id = $1', [sId]);
      if (n.rowCount) co = String(n.rows[0].company_code ?? '');
    }
    if (co === null) { res.status(404).json({ error: 'Credit source not found' }); return; }
    if (!companyAllowed(req, co)) { denyCompany(res); return; }
    const result = await recordCreditRefund({ sourceType, sourceId: sId, amount, date, method: method ?? null, reference: reference ?? null, notes: notes ?? null, clientRequestId, actor: creditActor(req) });
    res.status(result.deduplicated ? 200 : 201).json({ success: true, ...result });
  } catch (err) { handleServiceError(err, res); }
});
router.post('/credit-refunds/:id/reverse', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await creditGate(res))) return;
  if (!creditWriter(req, res)) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: 'numeric id required' }); return; }
  try {
    const r = await pool.query('SELECT company_code FROM rel_credit_refunds WHERE id = $1', [id]);
    if (!r.rowCount) { res.status(404).json({ error: 'Refund not found' }); return; }
    if (!companyAllowed(req, r.rows[0].company_code)) { denyCompany(res); return; }
    res.json({ success: true, ...(await reverseCreditRefund(id, { reason: req.body?.reason ?? null, actor: creditActor(req) })) });
  } catch (err) { handleServiceError(err, res); }
});

// ── CREDIT NOTES ─────────────────────────────────────────────────────────
router.post('/credit-notes', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('creditNotes', res))) return;
  try {
    const { companyCode, type, contactName, date, amount, reason, appliedTo, notes, status, customerRef } = req.body || {};
    // 2026-08-23 (credit note company-isolation repair): companyCode is now
    // required, matching createManualInvoice's own validation ("companyCode"
    // is required) — the same convention already used elsewhere, not a new
    // stricter rule invented for this one section.
    if (!companyCode || typeof companyCode !== 'string') {
      res.status(400).json({ error: '"companyCode" is required' }); return;
    }
    if (!['customer', 'supplier'].includes(type) || !contactName || !Number.isFinite(Number(amount))) {
      res.status(400).json({ error: '"type" (customer/supplier), "contactName" and a numeric "amount" are required' }); return;
    }
    const result = await createCreditNote({ companyCode, type, contactName, date, amount: Number(amount), reason, appliedTo, notes, status, customerRef: normalizeCustomerRef(customerRef) });
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
    if (patch.customerRef !== undefined) patch.customerRef = normalizeCustomerRef(patch.customerRef);
    const result = await updateCreditNote(id, expectedVersion, patch, creditActor(req));
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

// ── TARGETED AUTHORITATIVE READ (RELIABILITY PHASE 1, 2026-08-26) ──────────
// GET /api/relational/sections?names=quotes,jobs
//
// WHY THIS EXISTS. Until now the ONLY way to re-read authoritative relational
// data was GET /api/platform-state, which assembles EVERY section (relational
// and JSON alike) and ships the whole multi-megabyte blob. That endpoint was
// therefore called after every single relational mutation, and by every poll
// that decided to reload, in order to pick up — typically — one changed
// section.
//
// This route answers the same question for just the sections asked for, using
// getAuthoritativeJson() — the EXACT function the platform-state read overlay
// calls (backend/src/relational/read.ts). There is deliberately no second
// assembly path and no second shape: whatever /api/platform-state would have
// returned under the key `quotes` is exactly what this returns under `quotes`.
// If that ever stops being true it is because read.ts changed, and both callers
// change together.
//
// It is a READ: it writes nothing, reserves no document number, and opens no
// transaction of its own. It is gated by the SAME double gate every other route
// here uses — a section that is not cut over is omitted from `data` and named
// in `notCutOver`, never quietly served from the JSON copy. Mixing the two
// authorities in one payload is how a caller ends up unable to tell which one
// it is holding.
//
// purchaseOrders would be accepted here on the same terms as any other section,
// but the frontend deliberately never asks for it in Phase 1 — see
// backend/src/routes/freshness.ts for why its authority state needs a person's
// decision first.
router.get('/sections', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const raw = typeof req.query.names === 'string' ? req.query.names : '';
    const requested = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (requested.length === 0) {
      res.status(400).json({ error: '"names" is required, e.g. ?names=quotes,jobs' });
      return;
    }
    if (requested.length > 20) {
      res.status(400).json({ error: 'too many sections requested' });
      return;
    }
    const { ALL_SECTIONS } = await import('./cutover');
    const { getAuthoritativeJson, SECTION_JSON_KEY } = await import('./read');
    const known = new Set<string>(ALL_SECTIONS as readonly string[]);

    const data: Record<string, any[]> = {};
    const notCutOver: string[] = [];
    const unknown: string[] = [];
    for (const name of requested) {
      if (!known.has(name)) { unknown.push(name); continue; }
      const section = name as CutoverSection;
      if (!(await isSectionCutOver(section))) { notCutOver.push(name); continue; }
      const jsonKey = SECTION_JSON_KEY[section];
      // 'payments' has no standalone array — it is embedded in its owner's
      // record by read.ts, so there is nothing to return for it here.
      if (!jsonKey) { notCutOver.push(name); continue; }
      data[jsonKey] = await getAuthoritativeJson(section);
    }
    res.json({
      data,
      ...(notCutOver.length ? { notCutOver } : {}),
      ...(unknown.length ? { unknown } : {}),
    });
  } catch (err) {
    console.error('GET /api/relational/sections failed:', err);
    res.status(500).json({ error: 'Failed to read the requested sections' });
  }
});

// ── STATUS — which sections are actually live right now (non-sensitive) ───
router.get('/status', async (_req: AuthRequest, res: Response): Promise<void> => {
  const { ALL_SECTIONS } = await import('./cutover');
  const status: Record<string, boolean> = {};
  for (const s of ALL_SECTIONS) status[s] = await isSectionCutOver(s);
  res.json({ sections: status });
});

export default router;
