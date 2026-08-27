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
  createInvoiceForJob, ensureInvoiceForJob, finalizeProformaToInvoice, createInvoiceFromQuote, createJob,
  recordPayment, updateJob, deleteJob, updatePayment, deletePayment, getPaymentMethod,
  createCreditNote, updateCreditNote, deleteCreditNote,
  createPurchaseOrder, updatePurchaseOrder,
  createSupplier, updateSupplier, deleteSupplier,
  createInventoryItem, updateInventoryItem, adjustInventoryStock, deleteInventoryItem,
  createManualInvoice, updateInvoice, deleteInvoice,
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
    // POST-MIGRATION STABILIZATION (2026-08-24) — BUG 2. This handler used to
    // destructure only seven fields, silently discarding every contact/identity
    // field the Quote form collects even though rel_quotes has a column for
    // each. Widened to the full createQuote input; all the added fields are
    // optional, so existing callers are unaffected.
    const {
      companyCode, customerId, customerNameRaw, lines, discountPct, setupFee, notes,
      contactPerson, email, phone, address, vatNumber, terms, salesperson, preparedBy,
      poRef, reference, quoteDate, validUntil, status,
    } = req.body || {};
    if (!companyCode || !customerNameRaw || !Array.isArray(lines) || lines.length === 0) {
      res.status(400).json({ error: '"companyCode", "customerNameRaw" and a non-empty "lines" array are required' }); return;
    }
    const result = await createQuote({
      companyCode, customerId, customerNameRaw, lines, discountPct, setupFee, notes,
      contactPerson, email, phone, address, vatNumber, terms, salesperson, preparedBy,
      poRef, reference, quoteDate, validUntil, status,
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
    const { expectedVersion: _ev, expectedJobVersion, resyncJobLines: _rsjl, ...patch } = req.body || {};
    const result = await updateQuoteWithJobSync(id, expectedVersion, patch, {
      expectedJobVersion: expectedJobVersion !== undefined ? Number(expectedJobVersion) : undefined,
    });
    res.json({ success: true, rowVersion: result.quoteRowVersion, jobId: result.jobId, jobRowVersion: result.jobRowVersion });
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
      contactPerson, email, phone, address, vatNumber, reference, salesperson, dueDate,
    } = req.body || {};
    if (!companyCode || typeof companyCode !== 'string') {
      res.status(400).json({ error: '"companyCode" is required' }); return;
    }
    if (!customerNameRaw || typeof customerNameRaw !== 'string' || !customerNameRaw.trim()) {
      res.status(400).json({ error: '"customerNameRaw" (the client) is required' }); return;
    }
    const result = await createJob({
      companyCode, customerId, customerNameRaw, description, status, stage, value, notes,
      contactPerson, email, phone, address, vatNumber, reference, salesperson, dueDate,
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
    res.json({ success: true, rowVersion: result.rowVersion });
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
      reference, status, issueDate, dueDate, lines,
    } = req.body || {};
    if (!companyCode || typeof companyCode !== 'string') {
      res.status(400).json({ error: '"companyCode" is required' }); return;
    }
    if (!Array.isArray(lines) || lines.length === 0) {
      res.status(400).json({ error: 'a non-empty "lines" array is required' }); return;
    }
    const result = await createManualInvoice({
      companyCode, customerId, contactName, contactEmail, contactAddress,
      reference, status, issueDate, dueDate, lines,
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

// Gated on BOTH sections, exactly like POST /jobs/:id/create-invoice above —
// the operation this one reverses. Deleting an invoice now also reverses the
// invoice linkage the create stamped onto rel_jobs (see services.ts
// deleteInvoice), so it is a two-section write. With "jobs" still on JSON
// authority that write would land in a table nothing reads, leaving the
// reported leftover unfixed while silently diverging rel_jobs from the JSON
// the reconciliation gate compares against before cutover. Refusing with the
// standard not_cut_over conflict is the honest answer; the frontend surfaces
// it through the existing catch as "The invoice was NOT deleted."
router.delete('/invoices/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireCutOver('jobs', res)) || !(await requireCutOver('accInvoices', res))) return;
  try {
    const id = Number(req.params.id);
    const expectedVersion = Number(req.body?.expectedVersion);
    if (!Number.isFinite(id) || !Number.isFinite(expectedVersion)) {
      res.status(400).json({ error: '"id" (path) and "expectedVersion" (body) must be numbers' }); return;
    }
    const result = await deleteInvoice(id, expectedVersion);
    // `clearedJobs` reports the jobs whose own invoice linkage this delete
    // reversed (see services.ts deleteInvoice) — id + rowVersion so the client
    // can drop the job-derived invoice row it synthesises from job.invoiceNum
    // immediately, and keep its optimistic-concurrency baseline for that job
    // honest, instead of waiting on the coalesced authoritative re-read.
    // `ambiguousJobs` names the jobs a historical numbering collision left
    // sharing this invoice number when the invoice carried no job_id to
    // disambiguate them. Nothing was cleared for them on purpose — that is a
    // human decision (see LegacyInvoiceConflictError) — so the client must
    // say so rather than let the leftover look like a bug.
    res.json({
      success: true, deleted: result.deleted,
      clearedJobs: result.clearedJobs, ambiguousJobs: result.ambiguousJobs,
      creditReleased: result.creditReleased,
    });
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
    const { companyCode, type, contactName, date, amount, reason, appliedTo, notes, status } = req.body || {};
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
    const result = await createCreditNote({ companyCode, type, contactName, date, amount: Number(amount), reason, appliedTo, notes, status });
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
