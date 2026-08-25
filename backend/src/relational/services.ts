/**
 * Record-level relational business services for the critical chain:
 *   CUSTOMER -> QUOTE -> JOB -> INVOICE (incl. PRO-#####/INV-##### reuse
 *   from the SAME atomic pool, unchanged from documentNumbers.ts) -> PAYMENT
 *
 * These operate ONLY on the rel_* tables added by
 * database/migrations/007_relational_core.sql. They do not read or write
 * platform_state, and are safe to call regardless of the relational cutover
 * flags (see cutover.ts) — cutover only controls whether platformState.ts
 * defers to these tables; the tables themselves are always live and always
 * usable, e.g. by these services, by tests, or (once built — see handoff
 * "remaining work") by a future frontend.
 *
 * CONCURRENCY:
 *   - Row-level optimistic concurrency via `row_version` on every table:
 *     every update service takes an `expectedVersion` and does
 *     `UPDATE ... WHERE id = $1 AND row_version = $2`; a 0-row result means
 *     someone else changed the record first, and the caller gets a
 *     structured conflict, never a silent overwrite. This is scoped to the
 *     ONE row being changed — editing job A never blocks a concurrent edit
 *     to unrelated job B, unlike the platform_state single-blob revision
 *     token.
 *   - Document numbering reuses the EXISTING backend-atomic reservation
 *     system unchanged (backend/src/routes/documentNumbers.ts /
 *     reserveDocumentNumberWithClient) — this migration does not
 *     reimplement or duplicate that logic. PRO-#####/INV-##### continue to
 *     share the same pool exactly as before: finalizing a proforma consumes
 *     the SAME reservation, never mints a second number.
 *   - "Convert quote to job" and "same quote converted twice" reuse the
 *     EXISTING quote_conversions UNIQUE(quote_id) table unchanged.
 */
import { PoolClient } from 'pg';
import pool from '../db/pool';
import { reserveDocumentNumberWithClient } from '../routes/documentNumbers';
import { restoreId } from './read';
// HISTORICAL PIECES PROTECTION (2026-08-25). The invoice writers below no
// longer read `pieces` straight off a source line — see EFFECTIVE_QTY_SQL.
// migration013Recovery owns the ONE algorithm that decides what a NULL piece
// count really means for a given line, and these are its two entry points for
// invoicing. Nothing in this file re-implements that matching.
import {
  resolveDocument013ForInvoicing, effectivePiecesByLineId, Document013Resolution,
} from './migration013Recovery';

export class ConcurrencyConflictError extends Error {
  constructor(public table: string, public id: number) {
    super(`${table} id=${id} was changed by someone else — refresh and retry.`);
    this.name = 'ConcurrencyConflictError';
  }
}
export class BusinessRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BusinessRuleError';
  }
}
// STAGE 3 Phase 6 — createInvoiceForJob's legacy branch (a job that already
// carries an invoiceNum from historical/backfilled JSON data, or from an
// earlier partial relational write, but was never actually invoiced
// relationally) throws THIS distinct error type — never BusinessRuleError —
// specifically when adopting the job's existing invoice number would
// collide with a DIFFERENT invoice that already owns it. api.ts maps this
// to HTTP 409 with `type: 'legacy_conflict'` so callers can tell "this is
// blocked because of an un-migrated historical numbering collision" apart
// from an ordinary business-rule refusal (e.g. "already invoiced"). Never
// auto-resolved — always requires a human decision, same posture as
// backfill.ts's duplicate-source-id quarantine.
export class LegacyInvoiceConflictError extends Error {
  constructor(message: string, public detail?: Record<string, unknown>) {
    super(message);
    this.name = 'LegacyInvoiceConflictError';
  }
}

// ── POST-MIGRATION STABILIZATION (2026-08-24) — SHARED PATCH-VALUE NORMALISER ─
// Several colMap-driven updates below map a frontend field onto a DATE column
// (rel_jobs.due_date, rel_invoices.issue_date/due_date, rel_quotes.quote_date/
// valid_until). A cleared date input sends '' — which PostgreSQL rejects with
// 22007 invalid_datetime_format. That is neither a ConcurrencyConflictError nor
// a BusinessRuleError, so api.ts's handleServiceError mapped it to a bare
// `500 {error:'Internal error'}` — the SAME opaque failure users reported for
// quote saves, arriving on a different screen with no way to tell the two
// apart. Normalised at the one shared point every colMap loop already passes
// through, so clearing a date means NULL (what the UI implies) instead of a
// server error, and so no future colMap entry can reintroduce the same class of
// 500 by forgetting the coercion at its own call site.
const DATE_COLUMNS = new Set([
  'due_date', 'issue_date', 'invoice_date', 'invoice_due', 'quote_date', 'valid_until', 'payment_date', 'note_date', 'order_date',
]);
function normalizeColumnValue(col: string, value: any): any {
  if (DATE_COLUMNS.has(col) && (value === '' || value === undefined)) return null;
  return value;
}

// ── CUSTOMERS — simplest full CRUD, demonstrates row-level optimistic
//    concurrency end to end. ──────────────────────────────────────────────
export interface CustomerInput {
  companyName: string;
  contactPerson?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  vatNumber?: string | null;
  notes?: string | null;
}

// 2026-08-20 STAGE 2 fix (Phase 2/3 REST + read-layer integration audit):
// source_id for a FRESH record (never existed in JSON) is set to the SAME
// value as its own internal PK (as text), not an arbitrary 'rel-N' string.
// This was found during REST-endpoint testing: backend/src/relational/
// read.ts's restoreId() turns a numeric-looking source_id back into a JS
// number for GET /api/platform-state, so a source_id of the SHAPE 'rel-5'
// would come back from GET as the STRING "rel-5" while the REST create
// response returned the raw numeric PK (5, or "5" as pg's BIGINT string
// representation) — two different-looking values for what a caller would
// reasonably expect to be "the same id", for the same record, right after
// creating it. Using the PK itself (as text) for a fresh row's source_id
// makes GET and the REST create/update responses agree on the same id for
// every relationally-created record — exactly the same PK, string-shaped
// either way (a BIGINT column, so pg always returns it as a numeric
// string) — with zero risk of ever colliding with a BACKFILLED record's
// real historical id (those are large timestamp-derived numbers/floats
// from `Date.now()+Math.random()`-style JS ids, this migration's own
// BIGSERIAL sequences start at 1). Nothing about backfill.ts changes —
// this only affects rows created fresh through these services, after
// cutover, which never had a JSON id to preserve in the first place.
export async function createCustomer(input: CustomerInput): Promise<{ id: number; rowVersion: number }> {
  const res = await pool.query(
    `WITH new_id AS (SELECT nextval('rel_customers_id_seq') AS id)
     INSERT INTO rel_customers (id, source_id, company_name, contact_person, email, phone, address, vat_number, notes, legacy_data)
     SELECT new_id.id, new_id.id::text, $1, $2, $3, $4, $5, $6, $7, '{}'::jsonb FROM new_id
     RETURNING id, row_version`,
    [input.companyName, input.contactPerson ?? null, input.email ?? null, input.phone ?? null, input.address ?? null, input.vatNumber ?? null, input.notes ?? null]
  );
  return { id: res.rows[0].id, rowVersion: res.rows[0].row_version };
}

export async function updateCustomer(
  id: number,
  expectedVersion: number,
  patch: Partial<CustomerInput>
): Promise<{ rowVersion: number }> {
  const sets: string[] = [];
  const vals: any[] = [];
  const colMap: Record<string, string> = {
    companyName: 'company_name', contactPerson: 'contact_person', email: 'email',
    phone: 'phone', address: 'address', vatNumber: 'vat_number', notes: 'notes',
  };
  for (const [k, col] of Object.entries(colMap)) {
    if ((patch as any)[k] !== undefined) {
      vals.push((patch as any)[k]);
      sets.push(`${col} = $${vals.length}`);
    }
  }
  if (sets.length === 0) {
    const cur = await pool.query('SELECT row_version FROM rel_customers WHERE id = $1', [id]);
    if (cur.rowCount === 0) throw new BusinessRuleError(`customer ${id} not found`);
    return { rowVersion: cur.rows[0].row_version };
  }
  vals.push(id);
  const idIdx = vals.length;
  vals.push(expectedVersion);
  const verIdx = vals.length;
  const res = await pool.query(
    `UPDATE rel_customers SET ${sets.join(', ')}, row_version = row_version + 1, updated_at = NOW()
     WHERE id = $${idIdx} AND row_version = $${verIdx}
     RETURNING row_version`,
    vals
  );
  if (res.rowCount === 0) {
    const exists = await pool.query('SELECT id FROM rel_customers WHERE id = $1', [id]);
    if (exists.rowCount === 0) throw new BusinessRuleError(`customer ${id} not found`);
    throw new ConcurrencyConflictError('rel_customers', id);
  }
  return { rowVersion: res.rows[0].row_version };
}

// ── CREATE QUOTE ───────────────────────────────────────────────────────────
// BEGIN; reserve/validate document number; insert quote; insert quote
// items; COMMIT — exactly the shape described in the migration brief.
export interface QuoteLineInput {
  description: string; qty: number; unitPrice: number; unit?: string | null; inventoryItemId?: number | null;
  // migration 013 — see LINE_EXTRAS below.
  sqmL?: number | string | null; sqmW?: number | string | null; pieces?: number | string | null;
  cpId?: number | string | null; cpLinked?: boolean | null;
}
export interface CreateQuoteInput {
  companyCode: string;
  customerId?: number | null;
  customerNameRaw: string;
  lines: QuoteLineInput[];
  discountPct?: number;
  setupFee?: number;
  notes?: string | null;
  // POST-MIGRATION STABILIZATION (2026-08-24) — BUG 2 (quote information does
  // not carry through). Every field below already had a real rel_quotes column
  // (007_relational_core.sql) or gets one in migration 012 (quoteDate /
  // validUntil), and every one of them is captured by the Quote form — but
  // createQuote accepted NONE of them, so a quote created after cutover
  // persisted only company/customer/lines/discount/setupFee/notes. Contact
  // person, email, phone, address, VAT number, salesperson, reference, PO ref,
  // quote date and validity existed in the browser until the next reload and
  // then vanished — and, because convertQuoteToJob copies FROM these columns,
  // whatever was missing here was missing on the Job and Job Card too. Accepted
  // here (all optional, so existing callers are unaffected) rather than patched
  // in later by an edit, so the very first save is already complete.
  contactPerson?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  vatNumber?: string | null;
  terms?: string | null;
  salesperson?: string | null;
  preparedBy?: string | null;
  poRef?: string | null;
  reference?: string | null;
  quoteDate?: string | null;
  validUntil?: string | null;
  status?: string | null;
}

export async function createQuote(input: CreateQuoteInput): Promise<{ id: number; quoteNumber: string; rowVersion: number }> {
  // Everything the caller can get wrong is checked BEFORE a transaction opens,
  // so a bad value is a readable refusal instead of a raw Postgres error the
  // client renders as "Internal error" — and no document number is burnt.
  if (!input.companyCode || !String(input.companyCode).trim()) {
    throw new BusinessRuleError('A company is required to create a quote.');
  }
  if (!input.customerNameRaw || !String(input.customerNameRaw).trim()) {
    throw new BusinessRuleError('A client name is required to create a quote.');
  }
  validateQuoteHeader(input);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertCustomerExists(client, input.customerId);
    const quoteNumber = await reserveDocumentNumberWithClient(client, input.companyCode, 'quote');

    // migration 013: pieces x qty x unitPrice — the SAME formula the form uses.
    const subtotal = input.lines.reduce((s, l) => s + lineSubtotal(l.pieces, l.qty, l.unitPrice), 0);
    const discountPct = input.discountPct || 0;
    const discAmt = subtotal * (discountPct / 100);
    const setupFee = input.setupFee || 0;
    const afterDisc = subtotal - discAmt + setupFee;
    const vatAmount = afterDisc * 0.15;
    const total = afterDisc + vatAmount;

    const insertRes = await client.query(
      `WITH new_id AS (SELECT nextval('rel_quotes_id_seq') AS id)
       INSERT INTO rel_quotes (id, source_id, quote_number, company_code, customer_id, customer_name_raw,
         contact_person, email, phone, address, vat_number, terms, salesperson, prepared_by, po_ref, reference,
         quote_date, valid_until, notes, setup_fee, discount_pct, subtotal, vat_amount, total, status, legacy_data)
       SELECT new_id.id, new_id.id::text, $1, $2, $3, $4,
         $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15::date, $16::date, $17, $18, $19, $20, $21, $22, COALESCE($23, 'draft'), '{}'::jsonb FROM new_id
       RETURNING id, row_version`,
      [quoteNumber, input.companyCode, input.customerId ?? null, input.customerNameRaw,
       input.contactPerson ?? null, input.email ?? null, input.phone ?? null, input.address ?? null,
       input.vatNumber ?? null, input.terms ?? null, input.salesperson ?? null, input.preparedBy ?? null,
       input.poRef ?? null, input.reference ?? null,
       input.quoteDate || null, input.validUntil || null,
       input.notes ?? null, setupFee, discountPct, subtotal, vatAmount, total, input.status || null]
    );
    const quoteId = insertRes.rows[0].id;
    const quoteRowVersion = insertRes.rows[0].row_version;

    for (let i = 0; i < input.lines.length; i++) {
      const l = input.lines[i];
      const qty = Number(l.qty) || 0;
      const unitPrice = Number(l.unitPrice) || 0;
      // Same resolveInventoryRef() fix as replaceQuoteLinesTx — createQuote had
      // the identical raw-itemId-into-a-FK-column defect (BUG 3 root cause #1).
      const inv = await resolveInventoryRef(client, l.inventoryItemId);
      const ex = lineExtras(l as any);
      await client.query(
        `INSERT INTO rel_quote_line_items (quote_id, line_index, description, qty, unit_price, unit, subtotal, inventory_item_id, inventory_source_id,
           sqm_l, sqm_w, pieces, complete_product_source_id, complete_product_linked, legacy_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, '{}'::jsonb)`,
        [quoteId, i, sanitizeText(l.description) ?? null, qty, unitPrice, sanitizeText(l.unit) ?? null,
         lineSubtotal(l.pieces, qty, unitPrice), inv.fk, inv.sourceId,
         ex.sqmL, ex.sqmW, ex.pieces, ex.cpId, ex.cpLinked]
      );
    }

    await client.query('COMMIT');
    return { id: quoteId, quoteNumber, rowVersion: quoteRowVersion };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ── CONVERT QUOTE -> JOB ────────────────────────────────────────────────────
// BEGIN; lock/check quote; ensure not already converted; reserve SNS
// atomically (reusing quote_conversions' UNIQUE(quote_id) exactly as
// documentNumbers/quoteConversions already enforce for the JSON path);
// insert job; record quote->job relationship; COMMIT.
//
// STAGE 3 (2026-08-20): extended to reproduce index.html's
// handleConvertToJob side effect of inventory deduction inside this SAME
// transaction, closing the gap where the relational conversion path
// silently skipped it. Reproduced exactly as audited, not redesigned:
//   - deduction: sum each linked inventory item's consumed qty across the
//     quote's lines, floor the resulting stock at 0 (Math.max(0, ...)).
//
// 2026-08-21 PURCHASE ORDER MIGRATION POLICY CHANGE: this function USED TO
// also auto-generate one purchase order per distinct low-stock supplier
// group in the same transaction (reproducing the old JSON
// handleConvertToJob behavior verbatim). That business rule has been
// deliberately REMOVED, not merely disabled — a quote being converted to a
// job (or inventory dropping below its reorder point as a result) no
// longer creates a Purchase Order automatically, under any circumstance.
// Purchasing is now always a separate, manual, optional user decision (see
// createPurchaseOrder below, and index.html's new "Create Purchase Order"
// action on the Job detail view) — never an automatic side effect of
// converting a quote. Inventory deduction itself is UNCHANGED; only the
// auto-PO half of the old side effect is gone. The transaction shape is
// now exactly: BEGIN -> claim quote conversion -> reserve SNS -> create job
// -> create job items -> perform valid inventory deduction -> mark quote
// converted -> COMMIT — no purchase-order writes anywhere in it.
export interface InventoryAdjustment { itemId: number; sourceId: number | string; consumed: number; newStock: number }

export async function convertQuoteToJob(quoteId: number): Promise<{
  jobId: number;
  jobNumber: string;
  jobRowVersion: number;
  quoteRowVersion: number;
  inventoryAdjustments: InventoryAdjustment[];
}> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const quoteRes = await client.query('SELECT * FROM rel_quotes WHERE id = $1 FOR UPDATE', [quoteId]);
    if (quoteRes.rowCount === 0) throw new BusinessRuleError(`quote ${quoteId} not found`);
    const quote = quoteRes.rows[0];
    if (quote.converted_job_id) {
      throw new BusinessRuleError(`quote ${quoteId} (${quote.quote_number}) has already been converted to job id ${quote.converted_job_id}`);
    }

    // Reuse the SAME cross-database uniqueness guarantee the JSON path
    // relies on (quote_conversions UNIQUE(quote_id)) so a quote can never be
    // converted twice even under concurrent relational + JSON activity
    // during the transition period.
    let jobNumber: string;
    try {
      jobNumber = await reserveDocumentNumberWithClient(client, 'ALL', 'job');
      await client.query(`INSERT INTO quote_conversions (quote_id, job_number) VALUES ($1, $2)`, [`rel:${quoteId}`, jobNumber]);
    } catch (err: any) {
      if (err && err.code === '23505') {
        throw new BusinessRuleError(`quote ${quoteId} already has an in-flight/duplicate conversion attempt`);
      }
      throw err;
    }

    const lineItemsRes = await client.query('SELECT * FROM rel_quote_line_items WHERE quote_id = $1 ORDER BY line_index', [quoteId]);

    // ── POST-MIGRATION STABILIZATION (2026-08-24) — BUG 2 ROOT CAUSE ─────────
    // "Quote information does not fully carry to the Job / Job Card."
    //
    // This INSERT used to copy only company/customer/description/value/
    // setup_fee/discount_pct/notes. Every OTHER quote identity field —
    // contact_person, email, phone, address, vat_number, salesperson,
    // prepared_by, po_ref, reference — was dropped, even though rel_jobs has
    // had a real column for each of them since 007_relational_core.sql. Because
    // a converted job's legacy_data is '{}', read.ts's `?? legacyBase(r).x`
    // fallbacks had nothing to fall back TO, so those fields hydrated as null
    // forever. The frontend masked this on the Job detail screen (which reads
    // contact/email/tel/address/vatNum live off the SOURCE QUOTE, not the job),
    // which is exactly why it went unnoticed — but the Job Card, the invoice
    // builders, and anything reading job.contact/email/address got blanks.
    //
    // `description` is now the quote's own description-bearing text when it has
    // one, and only falls back to the historic "From Quote <num>" label when it
    // does not — the label was previously unconditional, discarding whatever
    // the quote actually described.
    //
    // Nothing about numbering, the conversion guard, inventory deduction or the
    // no-auto-PO policy changes here — this adds columns to one INSERT.
    const derivedDesc = (() => {
      const lineDescs = lineItemsRes.rows
        .map((l: any) => (l.description == null ? '' : String(l.description).trim()))
        .filter(Boolean)
        .slice(0, 2)
        .join(', ');
      return lineDescs
        ? `From Quote ${quote.quote_number} — ${lineDescs}`
        : `From Quote ${quote.quote_number}`;
    })();

    const jobRes = await client.query(
      `WITH new_id AS (SELECT nextval('rel_jobs_id_seq') AS id)
       INSERT INTO rel_jobs (id, source_id, job_number, company_code, customer_id, customer_name_raw,
         contact_person, email, phone, address, vat_number,
         salesperson, prepared_by, po_ref, reference,
         description, status, stage, value, quote_id, quote_number_raw, setup_fee, discount_pct, notes, legacy_data)
       SELECT new_id.id, new_id.id::text, $1, $2, $3, $4,
         $5, $6, $7, $8, $9,
         $10, $11, $12, $13,
         $14, 'quote_approved', 4, $15, $16, $17, $18, $19, $20, '{}'::jsonb FROM new_id
       RETURNING id, row_version`,
      [jobNumber, quote.company_code, quote.customer_id, quote.customer_name_raw,
       quote.contact_person, quote.email, quote.phone, quote.address, quote.vat_number,
       quote.salesperson, quote.prepared_by, quote.po_ref, quote.reference,
       derivedDesc, quote.total, quoteId, quote.quote_number,
       quote.setup_fee, quote.discount_pct, quote.notes]
    );
    const jobId = jobRes.rows[0].id;
    const jobRowVersion = jobRes.rows[0].row_version;

    for (const l of lineItemsRes.rows) {
      await client.query(
        `INSERT INTO rel_job_line_items (job_id, line_index, description, qty, unit_price, unit, subtotal, inventory_item_id, inventory_source_id,
           sqm_l, sqm_w, pieces, complete_product_source_id, complete_product_linked, legacy_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [jobId, l.line_index, l.description, l.qty, l.unit_price, l.unit, l.subtotal,
         l.inventory_item_id, l.inventory_source_id,
         // migration 013: the quote line's dimensions, piece count and
         // complete-product link are the Job Card's specification — carried
         // across as real columns now, not smuggled through legacy_data.
         l.sqm_l, l.sqm_w, l.pieces, l.complete_product_source_id, l.complete_product_linked,
         // Carry the QUOTE line's legacy_data across verbatim so per-line
         // extras the relational schema does not model (sqmL/sqmW/pQty/
         // sizeText/cpLinked — the sizing fields the printed Job Card reads via
         // lineSizeText()) survive conversion instead of being replaced with an
         // empty object, which is what silently blanked the Job Card's
         // dimension line for every relationally-converted job.
         (() => {
           // Carry the quote line's legacy extras (sqmL/sqmW/pQty/sizeText/
           // cpLinked — what the printed Job Card's lineSizeText() reads) but
           // NEVER its `id`: read.ts spreads legacyBase(l) before overlaying the
           // modelled columns, so an inherited id would surface on the job line
           // as an identity it never had.
           const src = l.legacy_data && typeof l.legacy_data === 'object' && !Array.isArray(l.legacy_data) ? { ...l.legacy_data } : {};
           delete (src as any).id;
           return src;
         })()]
      );
    }

    // ── Inventory deduction (Stage 3) ─────────────────────────────────────
    const consumption = new Map<number, number>();
    for (const l of lineItemsRes.rows) {
      if (l.inventory_item_id != null) {
        consumption.set(l.inventory_item_id, (consumption.get(l.inventory_item_id) || 0) + Number(l.qty || 0));
      }
    }
    const inventoryAdjustments: InventoryAdjustment[] = [];
    for (const [invItemId, consumed] of consumption.entries()) {
      if (consumed <= 0) continue;
      const invRes = await client.query('SELECT id, source_id, stock_qty FROM rel_inventory_items WHERE id = $1 FOR UPDATE', [invItemId]);
      if (invRes.rowCount === 0) continue; // referenced item no longer exists — matches the JSON .map()'s forgiving skip-if-not-found behavior
      const invRow = invRes.rows[0];
      const newStock = Math.max(0, Number(invRow.stock_qty) - consumed);
      await client.query(
        `UPDATE rel_inventory_items SET stock_qty = $1, row_version = row_version + 1, updated_at = NOW() WHERE id = $2`,
        [newStock, invItemId]
      );
      inventoryAdjustments.push({ itemId: invItemId, sourceId: restoreId(invRow.source_id), consumed, newStock });
    }

    // 2026-08-21 PURCHASE ORDER MIGRATION POLICY CHANGE: the automatic
    // low-stock PO generation that used to run here (one PO per distinct
    // low-stock supplier group, re-scanning ALL inventory post-deduction)
    // has been deliberately REMOVED — see this function's header comment.
    // If stock is now low after deduction, that's it: no PO is created.
    // Any low-stock indication in the UI is informational only; purchasing
    // is a separate, manual, optional action (createPurchaseOrder below).

    // STAGE 3 FIX: converted_job_id (the FK) was already being set, but
    // read.ts's buildQuotesJson renders convertedJobId from
    // converted_job_source_id (TEXT) — which this UPDATE never populated,
    // so a freshly-converted quote's convertedJobId always rendered as null
    // via GET /api/platform-state (silently falling through to
    // legacyBase(r).convertedJobId, also null for a non-backfilled quote).
    // Fresh jobs always have source_id === their own id as text (the
    // Stage 2 id-consistency convention), so jobId::text is exactly right.
    // POST-MIGRATION STABILIZATION (2026-08-24) — BUG 3 ROOT CAUSE #2: this
    // UPDATE bumps the QUOTE's row_version, but the function (and therefore
    // POST /quotes/:id/convert-to-job) never told the caller the new value. The
    // frontend consequently kept the pre-conversion `_relRowVersion` on that
    // quote, so the NEXT edit or status change on it sent a stale
    // expectedVersion and came back 409 stale_record — for a conflict the user
    // had caused entirely by themselves, one action earlier. And because a
    // purely relational write never bumps platform_state's `_autoSavedAt`, the
    // 30s poll's staleness check can't heal it either: the quote stays
    // unsaveable for the rest of the session. Returned now, and applied by the
    // frontend, so the client's version tracks the server's.
    const quoteUpdRes = await client.query(
      `UPDATE rel_quotes SET status = 'converted', converted_job_id = $1::bigint, converted_job_source_id = $1::text, row_version = row_version + 1, updated_at = NOW() WHERE id = $2 RETURNING row_version`,
      [jobId, quoteId]
    );
    const quoteRowVersion = quoteUpdRes.rows[0].row_version;

    // ── POST-MIGRATION STABILIZATION (2026-08-24) — BUG 6, second vector ─────
    // The JSON conversion path always relinked a pre-existing quote invoice
    // onto the new job (index.html: `{...i, reference:jobNum, jobId, jobNum}`),
    // but the relational path never did — convertQuoteToJob touched
    // rel_invoices nowhere. So a quote that had already been finalised to an
    // invoice (finalizeProformaToInvoice) produced, after conversion, an
    // invoice with no job link and no `reference`: invisible to
    // getJobManualInvoice(), which is the lookup the "reuse the existing manual
    // invoice instead of creating a second one" rule depends on. The job would
    // later mint a SECOND invoice number for work already invoiced — the same
    // duplicate class as INV-00099, arriving by a different route. Relinked
    // here, in the same transaction as the conversion, matching the JSON path's
    // long-standing behavior. COALESCE/NULLIF so a manually-typed reference is
    // never overwritten.
    await client.query(
      `UPDATE rel_invoices
         SET job_id = $1, job_number_raw = $2, reference = COALESCE(NULLIF(reference, ''), $2)
       WHERE quote_id = $3 AND job_id IS NULL AND COALESCE(status, '') <> 'void'`,
      [jobId, jobNumber, quoteId]
    );

    await client.query('COMMIT');
    return { jobId, jobNumber, jobRowVersion, quoteRowVersion, inventoryAdjustments };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ── CREATE JOB (standalone, not from a quote) ───────────────────────────────
// POST-MIGRATION STABILIZATION (2026-08-24) — FRONTEND AUDIT (BUG 8), JOBS /
// CREATE. Until now the ONLY way a rel_jobs row could come into existence was
// convertQuoteToJob. But the Jobs page has always had its own "➕ Add New Job"
// action for work that never went through a quote (a walk-in, a callout, an
// internal job), and that path was never wired relationally — it pushed a job
// into local state and left the debounced JSON autosave to persist it. With
// "jobs" cut over, platformState.ts strips the section from every JSON save, so
// the job appeared in the list, survived until the next reload, and then was
// simply gone. No error, no record, nothing to recover: the exact silent-loss
// class this migration exists to eliminate, and the last one still open.
//
// Deliberately minimal and consistent with every sibling create in this file:
// the SNS-##### number comes from the same atomic reservation
// (reserveDocumentNumberWithClient, docType 'job') convertQuoteToJob already
// uses — never a client-side max()+1 — and the row is written in one
// transaction with legacy_data '{}'. It creates no quote link, no invoice, no
// inventory movement and no purchase order: a standalone job is exactly that.
export interface CreateJobInput {
  companyCode: string;
  customerId?: number | null;
  customerNameRaw: string;
  description?: string | null;
  status?: string | null;
  stage?: number | null;
  value?: number;
  notes?: string | null;
  contactPerson?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  vatNumber?: string | null;
  reference?: string | null;
  salesperson?: string | null;
  dueDate?: string | null;
}
export async function createJob(input: CreateJobInput): Promise<{ id: number; jobNumber: string; rowVersion: number }> {
  if (!input.customerNameRaw || !String(input.customerNameRaw).trim()) {
    throw new BusinessRuleError('"customerNameRaw" (the client) is required to create a job');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jobNumber = await reserveDocumentNumberWithClient(client, 'ALL', 'job');
    const res = await client.query(
      `WITH new_id AS (SELECT nextval('rel_jobs_id_seq') AS id)
       INSERT INTO rel_jobs (id, source_id, job_number, company_code, customer_id, customer_name_raw,
         contact_person, email, phone, address, vat_number, reference, salesperson,
         description, status, stage, value, notes, due_date, legacy_data)
       SELECT new_id.id, new_id.id::text, $1, $2, $3, $4,
         $5, $6, $7, $8, $9, $10, $11,
         $12, COALESCE($13, 'lead'), COALESCE($14, 0), $15, $16, $17::date, '{}'::jsonb FROM new_id
       RETURNING id, row_version`,
      [jobNumber, input.companyCode, input.customerId ?? null, String(input.customerNameRaw).trim(),
       input.contactPerson ?? null, input.email ?? null, input.phone ?? null, input.address ?? null,
       input.vatNumber ?? null, input.reference ?? null, input.salesperson ?? null,
       input.description ?? null, input.status || null,
       Number.isFinite(Number(input.stage)) ? Number(input.stage) : null,
       Number(input.value) || 0, input.notes ?? null, input.dueDate || null]
    );
    await client.query('COMMIT');
    return { id: res.rows[0].id, jobNumber, rowVersion: res.rows[0].row_version };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ── CREATE INVOICE (for a job) ──────────────────────────────────────────────
// BEGIN; validate/reserve INV; insert invoice; insert invoice items; link
// job/quote; COMMIT.
//
// STAGE 3 Phase 6 — LEGACY INVOICE BRANCH: a job whose invoice_num is
// already set (from historical JSON — e.g. a job invoiced before Stage 3
// existed, backfilled with invoiceNum populated but invoiceCreated=false —
// or from an earlier partial relational write) used to unconditionally
// refuse via BusinessRuleError, with no relational-safe way to actually
// invoice it. That is fixed below: if invoice_created is already true, the
// old refusal still applies unchanged (genuinely already invoiced). If not,
// this function safely ADOPTS the job's existing invoice_num — never mints
// a fresh one, never renumbers, never silently overwrites another invoice's
// number — by relinking the matching rel_invoices row if one already
// exists (job_id NULL or already this job), or creating exactly one new
// rel_invoices row using that EXACT number if none exists yet. If the
// number already belongs to a DIFFERENT job's invoice, this is a genuine
// historical numbering collision and is refused with a structured
// LegacyInvoiceConflictError (-> HTTP 409 `legacy_conflict`) rather than
// silently reassigned — the same "never auto-resolve a historical
// collision" posture backfill.ts uses for duplicate source ids.
// 2026-08-23 (production cutover repair — JOB FINANCIAL + LIFECYCLE REPAIR):
// this function used to unconditionally set `status = 'invoiced', stage = 9`
// on EVERY call, regardless of the job's actual current stage. That is only
// correct when the job has already organically reached the invoice-ready
// point of its own workflow (Installation, stage 7, or later — the SAME
// threshold index.html's JobDetail "Create Invoice" button and
// getPendingJobInvoices() already use to decide a job is "invoice-ready").
// index.html deliberately ALSO offers an earlier "Create Invoice Now —
// without waiting for the job to reach the Installation stage" action
// (QuotesPage, for a quote's linked job) for genuine early-invoicing needs.
// Calling that intentional feature on a job still at, say, Quote Approved
// (stage 4) used to jump `stage` straight to 9 (Invoiced) as a side effect —
// fabricating Deposit Received / In Production / Installation / Completed
// as already done, none of which had actually happened. Those are
// event-driven facts (a real payment for Deposit Received; a real
// user-driven advanceStage click for the rest) and must never be implied
// merely by an invoice existing. INVOICE LINKAGE (invoice_num/invoice_date/
// invoice_created/invoice_status, and the rel_invoices row itself, plus its
// job_id foreign key) is UNCONDITIONAL and unchanged below — only the
// stage/status bump is now conditional on the job already being at or past
// INSTALL_STAGE. A job invoiced early keeps its true current stage and
// continues its normal lifecycle from there; a job invoiced once it has
// genuinely reached Installation/Completed still gets the SAME one-step
// jump straight to Invoiced this function always intentionally provided
// (skipping a separate manual "Completed" click was already, and remains,
// the deliberate design — see BASE_LOCKED_STAGES in index.html, which locks
// stage 9 from ever being reached via the manual "Advance" button at all).
// POST-MIGRATION STABILIZATION (2026-08-24): shared writer for an invoice's
// lines derived from a job.
//
// A job converted from a quote always has rel_job_line_items. A job created
// DIRECTLY (createJob — the Jobs page's "Add New Job", which has no line-item
// editor) has none, and its invoice was therefore written with zero lines and
// rendered as R0.00 on every screen: the same "invoice with no value" symptom
// the duplicate-INV report was about, arriving through a different path.
//
// When the job has no lines, one line is synthesised from the job's own
// description and value so the invoice states the amount the job actually
// carries. rel_jobs.value is VAT-INCLUSIVE (convertQuoteToJob stores the
// quote's total, and updateQuoteWithJobSync computes afterDisc * 1.15), while
// an invoice line's unit_amount is VAT-EXCLUSIVE and the '15%' tax_type adds
// the VAT back — so the value is divided by 1.15 here to avoid charging VAT
// twice. A zero-value job still produces no line, exactly as before.

// ── JOB/QUOTE -> INVOICE FINANCIAL CONSISTENCY REPAIR (2026-08-25) ──────────
//
// CONFIRMED PRODUCTION DEFECT (Audio Access — SQ-00108 / SNS-00110 /
// INV-00103). An invoice derived from a job or a quote used to be written as
// a plain `qty x unit_price` copy of the source lines. That silently dropped
// EVERY other component of the document's commercial value:
//
//   * `pieces` (migration 013)  — the piece count. `lineSubtotal()` below is
//     THE line formula for quotes and jobs: pieces x qty x unitPrice. Copying
//     only qty x unit_price under-billed every multi-piece line by a factor of
//     `pieces`. On SNS-00110 (5 lines, pieces=2) that turned a R7,300.27 job
//     into a R3,506.39 invoice.
//   * `setup_fee`   — the job/quote carries it as a document-level column and
//     it was never represented on the invoice at all.
//   * `discount_pct`— likewise; an invoice for a discounted job was billed at
//     the UNDISCOUNTED line total, i.e. the customer was over-charged.
//
// The representation used here is NOT invented: it is the convention
// index.html's own Quote -> Invoice action (createInvoiceFromQuote) has always
// used on the JSON side — "discount/setup fee reproduced as their own
// adjustment lines so the invoice subtotal, VAT and total match the quote
// precisely (subtotal - discAmt + setupFee, then *1.15)". This makes the
// relational path agree with the JSON path instead of diverging from it.
//
// WHY `pieces` IS FOLDED INTO THE INVOICE LINE'S qty AND NEEDS NO MIGRATION
//   rel_invoice_line_items is an ACCOUNTING line, not a production or
//   inventory row. It has no inventory_item_id, no unit, no dimensions — by
//   design (007_relational_core.sql). Nothing derives stock consumption,
//   payments, job data or quote data from it:
//     - inventory is consumed once, at convertQuoteToJob, from
//       rel_job_line_items (which keeps pieces and qty separate, exactly as
//       lineSubtotal's contract requires);
//     - payments are their own rel_payments rows with their own amounts;
//     - the printed/emailed invoice (index.html buildManualInvoiceHtml) and
//       every total in the app read qty x unitAmount and nothing else;
//     - invoice editing (replaceInvoiceLinesTx) round-trips {qty, unitAmount}
//       verbatim, so an edited line stays exactly what it displays.
//   Folding pieces into qty therefore changes no other subsystem, keeps
//   unit_amount the TRUE unit price (so the invoice still reads honestly as
//   "N @ R x"), and makes qty x unit_amount identical to
//   lineSubtotal(pieces, qty, unitPrice) by construction. A NULL or
//   non-positive `pieces` reads as 1 — the same rule lineSubtotal applies —
//   so every historical line prices EXACTLY as it does today.
//   Note this is deliberately the opposite decision to rel_job_line_items /
//   rel_quote_line_items, where pieces and qty MUST stay separate because the
//   spec line and inventory consumption both depend on them individually.

// 2026-08-25 — HISTORICAL PIECES PROTECTION. The billed quantity is no longer
// read from `sl.pieces` alone. A NULL there means one of two completely
// different things: "this line never had a piece count" (1 is correct) or "this
// line's piece count predates migration 013's column" (1 is a factor-of-N
// under-charge, and the real value is still recoverable). Only
// migration013Recovery can tell those apart, so the effective piece count is
// now RESOLVED by that module and passed in per line — see
// resolveDocument013ForInvoicing. The multiplication still happens in SQL, in
// exact NUMERIC, never in JS float: the resolved count arrives as a ::numeric
// parameter and Postgres multiplies it by the source line's own qty.
//
// The confirmed production case this closes is SQ-00150 -> INV-00111: a line of
// 4 pieces x qty 2 x R1,600 stored with pieces NULL, invoiced as 1 x 2 x R1,600.
const EFFECTIVE_QTY_SQL = '($4::numeric * sl.qty)';

/** Money rounded to the 4 decimal places rel_invoice_line_items.unit_amount stores,
 *  so what this function computes and what the database keeps can never disagree. */
function roundMoney4(n: number): number {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

/** "10.000" -> "10", "12.500" -> "12.5" — the discount line reads the way a
 *  person wrote it, matching index.html's `parseFloat(quote.discount)`. */
function formatDiscountPct(pct: number): string {
  return String(Number(pct));
}

/** Below this, an adjustment is not worth a line — the same 0.005 threshold
 *  index.html's createInvoiceFromQuote uses for both adjustments. */
const ADJUSTMENT_LINE_THRESHOLD = 0.005;

/**
 * Copies a document's own line items onto an invoice, folding `pieces` into
 * the billed quantity (see the block comment above), and returns both the next
 * free line_index and the VAT-EXCLUSIVE subtotal those lines came to.
 *
 * `sourceTable` is the table the rows came from — the rows are re-read by id so
 * the arithmetic is done by Postgres in exact NUMERIC rather than by JS on
 * values that have already been through a float.
 *
 * `effectivePieces` maps source line id -> the piece count to bill, as resolved
 * by migration013Recovery (column value, deterministically recovered historical
 * value, or the documented default of 1). A line missing from the map is a
 * programming error, not a data condition, and is refused rather than silently
 * defaulted — silently defaulting is precisely the bug this parameter exists to
 * remove.
 */
async function writeInvoiceLinesFromSourceTx(
  client: PoolClient,
  invoiceId: number,
  sourceTable: 'rel_job_line_items' | 'rel_quote_line_items',
  sourceLines: any[],
  effectivePieces: Map<number, number>
): Promise<{ nextIndex: number; linesSubtotal: number }> {
  let nextIndex = 0;
  for (const l of sourceLines) {
    const pieces = effectivePieces.get(Number(l.id));
    if (pieces === undefined || !Number.isFinite(pieces) || pieces <= 0) {
      throw new BusinessRuleError(
        `internal: no resolved piece count for ${sourceTable} line ${l.id} — refusing to write an invoice line on a guessed quantity`
      );
    }
    await client.query(
      `INSERT INTO rel_invoice_line_items (invoice_id, line_index, description, qty, unit_amount, account_code, tax_type, legacy_data)
       SELECT $1, $2, sl.description, ${EFFECTIVE_QTY_SQL}, sl.unit_price, '4000', '15%', '{}'::jsonb
         FROM ${sourceTable} sl
        WHERE sl.id = $3`,
      [invoiceId, nextIndex, l.id, pieces]
    );
    nextIndex++;
  }
  // The subtotal is read back from what was actually written, so it can never
  // drift from the lines the customer will see on the invoice.
  const sumRes = await client.query(
    `SELECT COALESCE(SUM(qty * unit_amount), 0) AS subtotal
       FROM rel_invoice_line_items WHERE invoice_id = $1`,
    [invoiceId]
  );
  return { nextIndex, linesSubtotal: Number(sumRes.rows[0].subtotal) || 0 };
}

/**
 * Writes the discount and setup-fee adjustment lines for an invoice derived
 * from a quote or a job, in the SAME order and with the SAME descriptions
 * index.html's createInvoiceFromQuote uses (discount first, then setup fee),
 * so a relationally-created invoice is indistinguishable from a JSON-created
 * one. Returns the next free line_index.
 *
 * Discount is a NEGATIVE unit_amount on a qty-1 line rather than a reduction
 * spread across the item lines: that keeps every item line at its true unit
 * price, states the discount explicitly on the customer's document, and is
 * already what buildManualInvoiceHtml renders (it colours negative lines red).
 * Both adjustment lines carry tax_type '15%', so VAT is computed on the
 * discounted, setup-fee-inclusive amount — exactly (subtotal - discount +
 * setupFee) * 0.15, which is the quote's own flat VAT calculation.
 */
async function writeInvoiceAdjustmentLinesTx(
  client: PoolClient,
  invoiceId: number,
  startIndex: number,
  linesSubtotal: number,
  setupFee: unknown,
  discountPct: unknown
): Promise<number> {
  let lineIndex = startIndex;

  const pct = Number(discountPct) || 0;
  const discountAmount = roundMoney4(linesSubtotal * (pct / 100));
  if (discountAmount > ADJUSTMENT_LINE_THRESHOLD) {
    await client.query(
      `INSERT INTO rel_invoice_line_items (invoice_id, line_index, description, qty, unit_amount, account_code, tax_type, legacy_data)
       VALUES ($1, $2, $3, 1, $4, '4000', '15%', '{}'::jsonb)`,
      [invoiceId, lineIndex, `Discount (${formatDiscountPct(pct)}%)`, -discountAmount]
    );
    lineIndex++;
  }

  const fee = roundMoney4(Number(setupFee) || 0);
  if (fee > ADJUSTMENT_LINE_THRESHOLD) {
    await client.query(
      `INSERT INTO rel_invoice_line_items (invoice_id, line_index, description, qty, unit_amount, account_code, tax_type, legacy_data)
       VALUES ($1, $2, 'Design & Setup Fee', 1, $3, '4000', '15%', '{}'::jsonb)`,
      [invoiceId, lineIndex, fee]
    );
    lineIndex++;
  }

  return lineIndex;
}

// ── HISTORICAL-PIECES REFUSAL + FINANCIAL CONSISTENCY GUARD (2026-08-25) ────
// Two protections that every source-derived invoice now passes through, in
// this order:
//
//   1. REFUSE ON UNRESOLVED HISTORY. If a source line has no piece count of its
//      own AND its preserved historical source is MISMATCH or AMBIGUOUS, the
//      line's value cannot be known. Invoicing is refused rather than billed on
//      a guess. Deliberately narrow: a MISMATCH/AMBIGUOUS verdict about a
//      DIMENSION (sqmL/sqmW) or a complete-product link on a line whose pieces
//      are already set changes nothing financial and must not obstruct
//      invoicing — see resolveDocument013ForInvoicing's own note.
//
//   2. REFUSE ON A MATERIAL TOTAL MISMATCH. The invoice this system writes must
//      add up to the document it was raised for. Checked from what was
//      ACTUALLY written to rel_invoice_line_items, after the lines land and
//      before the transaction commits, so any disagreement rolls the whole
//      thing back — including the document number that was reserved inside the
//      same transaction (reserveDocumentNumberWithClient runs on this client,
//      so a ROLLBACK restores the counter and no number is consumed). A quote's
//      PRO-##### reservation is never touched by any of this: it is read, never
//      written, so a rollback leaves it available exactly as it was.
//
// This guard is what would have stopped SQ-00150 (R15,582.50) producing
// INV-00111 (R4,542.50): the invoice was 71% short of its own quote.

/** Rounding headroom for the comparison. Line amounts are stored at 4 dp and a
 *  document's own total at 2 dp, so a few cents of legitimate rounding can
 *  separate them across many lines. 5c is far below anything a person would
 *  call a discrepancy and far above anything rounding can produce. */
const SOURCE_TOTAL_TOLERANCE = 0.05;

/** Refuses invoicing when a line's money depends on an unresolvable historical
 *  piece count. Runs BEFORE any document number is reserved. */
function assertNo013Blockers(res: Document013Resolution): void {
  if (res.blocked.length === 0) return;
  const detail = res.blocked.map((l) => l.blockingReason).join('; ');
  throw new BusinessRuleError(
    `${res.kind === 'quote' ? 'Quote' : 'Job'} ${res.documentNumber} cannot be invoiced yet: ` +
    `${res.blocked.length} line(s) carry no piece count, and their preserved historical records ` +
    `cannot be matched to them with certainty, so the correct amount cannot be determined. ` +
    `Nothing was created. Open ${res.documentNumber}, confirm the piece count on each line and save it — ` +
    `that records the value explicitly and this invoice can then be raised. (${detail})`
  );
}

/** The invoice's own total, derived the one way this system derives it: from
 *  its lines, in exact NUMERIC. */
async function invoiceTotalTx(client: PoolClient, invoiceId: number): Promise<number> {
  const r = await client.query(
    `SELECT COALESCE(SUM(qty * unit_amount), 0)
              + COALESCE(SUM(CASE WHEN tax_type = '15%' THEN qty * unit_amount * 0.15 ELSE 0 END), 0) AS total
       FROM rel_invoice_line_items WHERE invoice_id = $1`,
    [invoiceId]
  );
  return Number(r.rows[0].total) || 0;
}

/** Throws (→ ROLLBACK) when the invoice just written does not add up to the
 *  document it was raised for. */
async function assertInvoiceMatchesSourceTx(
  client: PoolClient, invoiceId: number,
  sourceLabel: string, sourceTotalLabel: string, sourceTotal: number
): Promise<void> {
  const invoiceTotal = await invoiceTotalTx(client, invoiceId);
  if (Math.abs(invoiceTotal - sourceTotal) <= SOURCE_TOTAL_TOLERANCE) return;
  throw new BusinessRuleError(
    `Invoice not created: the invoice this would produce comes to ` +
    `R${invoiceTotal.toFixed(2)}, but ${sourceLabel}'s own ${sourceTotalLabel} is ` +
    `R${sourceTotal.toFixed(2)} — a difference of R${Math.abs(sourceTotal - invoiceTotal).toFixed(2)}. ` +
    `A document that does not add up to its source is never issued, so nothing was created and no ` +
    `invoice number was used. Open ${sourceLabel}, check its line items, piece counts, discount and ` +
    `setup fee, save it, and try again.`
  );
}

// EXPORTED (2026-08-25) so a one-off, narrowly-scoped repair of a single
// historical invoice can rebuild that invoice's lines with THIS function —
// the deployed writer itself — rather than a copy of it. A repair that
// re-implements the financial logic it is repairing towards is a second
// source of truth waiting to drift; see
// src/scripts/repair-audio-access-inv-00103.ts.
//
// 2026-08-25: `effectivePieces` is new and REQUIRED — see the
// HISTORICAL PIECES PROTECTION note on EFFECTIVE_QTY_SQL. Callers obtain it
// from resolveDocument013ForInvoicing; it is never derived here, so this writer
// cannot silently fall back to reading a NULL as 1.
export async function writeInvoiceLinesFromJobTx(
  client: PoolClient,
  invoiceId: number,
  jobLines: any[],
  job: any,
  effectivePieces: Map<number, number>
): Promise<void> {
  if (jobLines.length > 0) {
    const { nextIndex, linesSubtotal } = await writeInvoiceLinesFromSourceTx(
      client, invoiceId, 'rel_job_line_items', jobLines, effectivePieces
    );
    await writeInvoiceAdjustmentLinesTx(
      client, invoiceId, nextIndex, linesSubtotal, job.setup_fee, job.discount_pct
    );
    return;
  }
  // NO-LINES FALLBACK — deliberately unchanged, and deliberately NOT given
  // adjustment lines. rel_jobs.value is the job's FINAL VAT-inclusive figure,
  // which already has the setup fee added and the discount taken off; adding
  // them again here would charge the fee twice and discount an already-
  // discounted amount.
  const vatInclusiveValue = Number(job.value) || 0;
  if (vatInclusiveValue <= 0) return;
  await client.query(
    `INSERT INTO rel_invoice_line_items (invoice_id, line_index, description, qty, unit_amount, account_code, tax_type, legacy_data)
     VALUES ($1, 0, $2, 1, $3, '4000', '15%', '{}'::jsonb)`,
    [invoiceId, job.description || `Job ${job.job_number}`, vatInclusiveValue / 1.15]
  );
}

/**
 * The Job→Invoice half of the financial consistency guard.
 *
 * THE DOCUMENTED EXCEPTION, and why it is the ONLY one. rel_jobs.value is the
 * job's declared VAT-inclusive figure — set from the quote's total at
 * conversion and patchable directly — and it is what the Jobs list, the
 * dashboard revenue tile, the deposit rule and the payment status all read. An
 * invoice derived from the job's LINES must therefore agree with it, and the
 * existing job/quote → invoice consistency suite already asserts exactly that
 * invariant ("invoice total == job value").
 *
 * The exception is the NO-LINES FALLBACK: for a job with no line items,
 * writeInvoiceLinesFromJobTx builds the single invoice line FROM `value`
 * itself, so comparing the result back to `value` is tautological rather than a
 * check — and a job whose value is 0 legitimately produces no line at all
 * (there is nothing to bill). Both are recognised here and skipped, so this
 * guard never refuses a document it did not actually verify.
 */
async function assertJobInvoiceMatchesValueTx(
  client: PoolClient, invoiceId: number, job: any, sourceLineCount: number
): Promise<void> {
  if (sourceLineCount === 0) return;               // no-lines fallback — see above
  const jobValue = Number(job.value) || 0;
  if (jobValue <= 0) return;                       // nothing declared to check against
  await assertInvoiceMatchesSourceTx(
    client, invoiceId, `job ${job.job_number}`, 'value', jobValue
  );
}

const INSTALL_STAGE = 7;
export async function createInvoiceForJob(jobId: number): Promise<{ invoiceId: number; invoiceNumber: string; legacyMapped?: boolean; jobRowVersion: number; jobStage: number; jobStatus: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jobRes = await client.query('SELECT * FROM rel_jobs WHERE id = $1 FOR UPDATE', [jobId]);
    if (jobRes.rowCount === 0) throw new BusinessRuleError(`job ${jobId} not found`);
    const job = jobRes.rows[0];

    // HISTORICAL PIECES PROTECTION (2026-08-25). Resolved ONCE, on this
    // client so it sees the row this transaction has locked, and BEFORE any
    // branch below reserves a document number — a refusal must never consume a
    // number from the atomic pool. Cheap for the common case: a modern job
    // whose lines all carry a piece count resolves straight off the column.
    const jobPieces = await resolveDocument013ForInvoicing(client, 'job', jobId);
    assertNo013Blockers(jobPieces);
    const jobPiecesMap = effectivePiecesByLineId(jobPieces);

    if (job.invoice_num) {
      if (job.invoice_created) {
        throw new BusinessRuleError(`job ${jobId} (${job.job_number}) already has invoice ${job.invoice_num}`);
      }

      const existingInvRes = await client.query(
        `SELECT id, job_id FROM rel_invoices WHERE company_code = $1 AND invoice_number = $2 FOR UPDATE`,
        [job.company_code, job.invoice_num]
      );

      if ((existingInvRes.rowCount ?? 0) > 0) {
        const existingInv = existingInvRes.rows[0];
        if (existingInv.job_id !== null && Number(existingInv.job_id) !== jobId) {
          throw new LegacyInvoiceConflictError(
            `job ${jobId} (${job.job_number}) carries invoice number ${job.invoice_num}, but that number already belongs to a different invoice (rel_invoices id=${existingInv.id}, linked to job_id=${existingInv.job_id}). Refusing to reassign or duplicate — resolve this historical numbering collision manually before invoicing this job.`,
            { jobId, jobNumber: job.job_number, invoiceNumber: job.invoice_num, conflictingInvoiceId: existingInv.id, conflictingJobId: existingInv.job_id }
          );
        }
        if (existingInv.job_id === null) {
          // POST-MIGRATION STABILIZATION (2026-08-24) — BUG 6, see the block
          // above the fresh-invoice INSERT below: `reference` is the ONLY key
          // the frontend's job-invoice de-duplication uses, so it must be set
          // on every branch that links an invoice to a job, not just the fresh
          // one. COALESCE so a manually-entered reference is never overwritten.
          await client.query(
            `UPDATE rel_invoices SET job_id = $1, job_number_raw = $2, reference = COALESCE(NULLIF(reference, ''), $2) WHERE id = $3`,
            [jobId, job.job_number, existingInv.id]
          );
        }
        const jobUpdRes1 = await client.query(
          `UPDATE rel_jobs SET invoice_created = true, invoice_date = COALESCE(invoice_date, CURRENT_DATE), invoice_status = COALESCE(invoice_status, 'pending'),
             status = CASE WHEN stage >= $2 THEN 'invoiced' ELSE status END,
             stage  = CASE WHEN stage >= $2 THEN 9 ELSE stage END,
             row_version = row_version + 1, updated_at = NOW() WHERE id = $1 RETURNING row_version, stage, status`,
          [jobId, INSTALL_STAGE]
        );
        await client.query('COMMIT');
        return { invoiceId: existingInv.id, invoiceNumber: job.invoice_num, legacyMapped: true, jobRowVersion: jobUpdRes1.rows[0].row_version, jobStage: jobUpdRes1.rows[0].stage, jobStatus: jobUpdRes1.rows[0].status };
      }

      // No rel_invoices row exists for this number yet at all — create
      // exactly one, using the job's EXISTING invoice_num verbatim (never
      // reserved from the atomic counter, since a number is already on
      // record for this job).
      const legacyLineItemsRes = await client.query('SELECT * FROM rel_job_line_items WHERE job_id = $1 ORDER BY line_index', [jobId]);
      const legacyInvRes = await client.query(
        `WITH new_id AS (SELECT nextval('rel_invoices_id_seq') AS id)
         INSERT INTO rel_invoices (id, source_id, invoice_number, company_code, customer_id, contact_name, contact_email, contact_address, reference, job_id, job_number_raw, quote_id, quote_number_raw, status, issue_date, legacy_data)
         SELECT new_id.id, new_id.id::text, $1, $2, $3, $4, $10, $11, $6, $5, $6, $7, $8, 'sent', COALESCE($9::date, CURRENT_DATE), '{}'::jsonb FROM new_id
         RETURNING id`,
        [job.invoice_num, job.company_code, job.customer_id, job.customer_name_raw, jobId, job.job_number, job.quote_id, job.quote_number_raw, job.invoice_date,
         job.email, job.address]
      );
      const legacyInvoiceId = legacyInvRes.rows[0].id;
      await writeInvoiceLinesFromJobTx(client, legacyInvoiceId, legacyLineItemsRes.rows, job, jobPiecesMap);
      await assertJobInvoiceMatchesValueTx(client, legacyInvoiceId, job, legacyLineItemsRes.rows.length);
      const jobUpdRes2 = await client.query(
        `UPDATE rel_jobs SET invoice_created = true, invoice_date = COALESCE(invoice_date, CURRENT_DATE), invoice_status = COALESCE(invoice_status, 'pending'),
           status = CASE WHEN stage >= $2 THEN 'invoiced' ELSE status END,
           stage  = CASE WHEN stage >= $2 THEN 9 ELSE stage END,
           row_version = row_version + 1, updated_at = NOW() WHERE id = $1 RETURNING row_version, stage, status`,
        [jobId, INSTALL_STAGE]
      );
      await client.query('COMMIT');
      return { invoiceId: legacyInvoiceId, invoiceNumber: job.invoice_num, legacyMapped: true, jobRowVersion: jobUpdRes2.rows[0].row_version, jobStage: jobUpdRes2.rows[0].stage, jobStatus: jobUpdRes2.rows[0].status };
    }

    // ── POST-MIGRATION STABILIZATION (2026-08-24) — BUG 6, IDEMPOTENCY ───────
    // REQUIRED INVARIANT: "invoice creation is idempotent; repeated clicks/
    // retries do not create duplicates; existing invoice is reused; document
    // number reserved once."
    //
    // Repeated clicks were already safe by accident — the `SELECT ... FOR
    // UPDATE` on the job at the top of this function serialises them, and the
    // second one hits the `already has invoice` refusal. What was NOT safe is
    // the case where an invoice for this job's work already exists but the JOB
    // row doesn't know about it: an invoice created from the quote
    // (finalizeProformaToInvoice) before the job existed, or a manual invoice
    // referencing this job number. In both cases job.invoice_num is NULL, so
    // control reached the reservation below and minted a SECOND number for work
    // already invoiced — a genuinely duplicate document, and one that burns a
    // number from the atomic pool permanently.
    //
    // Checked BEFORE any reservation, so the number pool is never touched on
    // the reuse path. Adoption is deliberately narrow: ONLY an invoice already
    // pointing at this job (job_id), or one linked to this job's source quote
    // (quote_id). Anything else falls through to a fresh reservation.
    //
    // 2026-08-24: this comment previously also claimed an invoice "carrying
    // this job's number as its reference" was adopted. It never was, and it
    // MUST NOT be — `reference` is a free-text field a person types, so
    // adopting on it lets a standalone invoice for a DIFFERENT customer be
    // absorbed into this job (relinking their document and leaving this job's
    // own work uninvoiced while marking it Invoiced). That invariant is
    // asserted by relational.post-migration-stabilization.stress.ts [R2a].
    // The frontend's own createInvoiceNow guard (getJobManualInvoice) is the
    // right place for the softer reference-based match, because it only ever
    // OPENS the existing invoice — it never rewrites ownership.
    const reusableInvRes = await client.query(
      `SELECT id, invoice_number FROM rel_invoices
        WHERE company_code = $1
          AND COALESCE(status, '') <> 'void'
          AND ( job_id = $2
                OR ( job_id IS NULL
                     AND $3::bigint IS NOT NULL
                     AND quote_id = $3::bigint ) )
        ORDER BY (job_id IS NOT DISTINCT FROM $2::bigint) DESC, id ASC
        LIMIT 1
        FOR UPDATE`,
      [job.company_code, jobId, job.quote_id ?? null]
    );
    if ((reusableInvRes.rowCount ?? 0) > 0) {
      const reusable = reusableInvRes.rows[0];
      await client.query(
        `UPDATE rel_invoices SET job_id = $1, job_number_raw = $2, reference = COALESCE(NULLIF(reference, ''), $2) WHERE id = $3`,
        [jobId, job.job_number, reusable.id]
      );
      const jobUpdReuse = await client.query(
        `UPDATE rel_jobs SET invoice_num = $1, invoice_date = COALESCE(invoice_date, CURRENT_DATE), invoice_created = true,
           invoice_status = COALESCE(invoice_status, 'pending'),
           status = CASE WHEN stage >= $3 THEN 'invoiced' ELSE status END,
           stage  = CASE WHEN stage >= $3 THEN 9 ELSE stage END,
           row_version = row_version + 1, updated_at = NOW() WHERE id = $2 RETURNING row_version, stage, status`,
        [reusable.invoice_number, jobId, INSTALL_STAGE]
      );
      await client.query('COMMIT');
      return {
        invoiceId: reusable.id, invoiceNumber: reusable.invoice_number, legacyMapped: true,
        jobRowVersion: jobUpdReuse.rows[0].row_version, jobStage: jobUpdReuse.rows[0].stage, jobStatus: jobUpdReuse.rows[0].status,
      };
    }

    const invoiceNumber = await reserveDocumentNumberWithClient(client, job.company_code, 'invoice');

    const lineItemsRes = await client.query('SELECT * FROM rel_job_line_items WHERE job_id = $1 ORDER BY line_index', [jobId]);

    // ── POST-MIGRATION STABILIZATION (2026-08-24) — BUG 6 ROOT CAUSE ─────────
    // "INV-00099 appeared twice — one with the correct value, one at R0.00."
    //
    // There are NOT two invoice rows: rel_invoices carries
    // UNIQUE (company_code, invoice_number) (007_relational_core.sql), so the
    // database cannot hold a duplicate. The duplicate is produced client-side,
    // by getAllInvoicesUnified()'s merge of (a) invoices derived from
    // jobs[].invoiceNum and (b) the accInvoices array. That merge de-duplicates
    // on exactly ONE key — the invoice's `reference` matching the job's number
    // (getManualInvoiceJobRefs) — and createInvoiceForJob never wrote
    // `reference` at all. With reference NULL the job-derived row and the real
    // relational row both survived the merge: the same INV number twice, the
    // job-derived one showing the job's value and the relational one showing
    // R0.00 (the second half of this bug, fixed in read.ts, which emitted the
    // line array as `items` while every consumer reads `lineItems`).
    //
    // Setting reference = the job number on creation restores the de-dup key
    // for every invoice created from here on. contact_email/contact_address are
    // filled from the job at the same time — they were left NULL before, so a
    // job invoice opened in Accounting showed no contact details.
    const invRes = await client.query(
      `WITH new_id AS (SELECT nextval('rel_invoices_id_seq') AS id)
       INSERT INTO rel_invoices (id, source_id, invoice_number, company_code, customer_id, contact_name, contact_email, contact_address, reference, job_id, job_number_raw, quote_id, quote_number_raw, status, issue_date, legacy_data)
       SELECT new_id.id, new_id.id::text, $1, $2, $3, $4, $9, $10, $6, $5, $6, $7, $8, 'sent', CURRENT_DATE, '{}'::jsonb FROM new_id
       RETURNING id`,
      [invoiceNumber, job.company_code, job.customer_id, job.customer_name_raw, jobId, job.job_number, job.quote_id, job.quote_number_raw,
       job.email, job.address]
    );
    const invoiceId = invRes.rows[0].id;

    await writeInvoiceLinesFromJobTx(client, invoiceId, lineItemsRes.rows, job, jobPiecesMap);
    await assertJobInvoiceMatchesValueTx(client, invoiceId, job, lineItemsRes.rows.length);

    const jobUpdRes3 = await client.query(
      `UPDATE rel_jobs SET invoice_num = $1, invoice_date = CURRENT_DATE, invoice_created = true, invoice_status = 'pending',
         status = CASE WHEN stage >= $3 THEN 'invoiced' ELSE status END,
         stage  = CASE WHEN stage >= $3 THEN 9 ELSE stage END,
         row_version = row_version + 1, updated_at = NOW() WHERE id = $2 RETURNING row_version, stage, status`,
      [invoiceNumber, jobId, INSTALL_STAGE]
    );

    await client.query('COMMIT');
    return { invoiceId, invoiceNumber, jobRowVersion: jobUpdRes3.rows[0].row_version, jobStage: jobUpdRes3.rows[0].stage, jobStatus: jobUpdRes3.rows[0].status };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// FINAL CUTOVER BLOCKER COMPLETION (2026-08-22): until now the ONLY ways an
// invoice could ever be created relationally were createInvoiceForJob and
// finalizeProformaToInvoice below — a standalone "manual invoice" (no job,
// no quote — Sales/Accounting's own New Invoice action) had no relational
// path at all, and there was no PUT/DELETE for an invoice of any kind. That
// meant once "accInvoices" cut over, manual invoicing, invoice editing, and
// invoice deletion would all fail loud with no working replacement. These
// three functions close that gap, reusing the exact same
// reserve/lock/row_version/replace-lines conventions already established by
// createQuote/updateQuote/createInvoiceForJob above — no new architecture.
async function replaceInvoiceLinesTx(client: PoolClient, invoiceId: number, lines: InvoiceLineItemPatch[]): Promise<void> {
  await client.query('DELETE FROM rel_invoice_line_items WHERE invoice_id = $1', [invoiceId]);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const qty = Number(l.qty) || 0;
    const unitAmount = Number(l.unitAmount) || 0;
    await client.query(
      `INSERT INTO rel_invoice_line_items (invoice_id, line_index, description, qty, unit_amount, account_code, tax_type, legacy_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb)`,
      [invoiceId, i, l.description ?? null, qty, unitAmount, l.accountCode ?? '4000', l.taxType ?? '15%']
    );
  }
}

export interface InvoiceLineItemPatch { description?: string | null; qty: number; unitAmount: number; accountCode?: string | null; taxType?: string | null }
export interface CreateManualInvoiceInput {
  companyCode: string; customerId?: number | null; contactName: string; contactEmail?: string | null;
  contactAddress?: string | null; reference?: string | null; status?: string | null;
  issueDate?: string | null; dueDate?: string | null; lines: InvoiceLineItemPatch[];
}
// A standalone invoice not tied to any job/quote — company-scoped
// reservation (matches createInvoiceForJob's own reservation), never the
// global counter used by job/po/creditNote.
export async function createManualInvoice(input: CreateManualInvoiceInput): Promise<{ id: number; invoiceNumber: string; rowVersion: number }> {
  if (!input.contactName || !input.contactName.trim()) throw new BusinessRuleError('"contactName" is required to create an invoice');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const invoiceNumber = await reserveDocumentNumberWithClient(client, input.companyCode, 'invoice');
    const invRes = await client.query(
      `WITH new_id AS (SELECT nextval('rel_invoices_id_seq') AS id)
       INSERT INTO rel_invoices (id, source_id, invoice_number, company_code, customer_id, contact_name, contact_email, contact_address, reference, status, issue_date, due_date, legacy_data)
       SELECT new_id.id, new_id.id::text, $1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::date, CURRENT_DATE), $10::date, '{}'::jsonb FROM new_id
       RETURNING id, row_version`,
      // `|| null` rather than `?? null` on the two DATE params: an empty-string
      // date from the form must become NULL, not '' — see updateInvoice's note.
      [invoiceNumber, input.companyCode, input.customerId ?? null, input.contactName.trim(), input.contactEmail ?? null,
       input.contactAddress ?? null, input.reference ?? null, input.status ?? 'sent', input.issueDate || null, input.dueDate || null]
    );
    const invoiceId = invRes.rows[0].id;
    await replaceInvoiceLinesTx(client, invoiceId, input.lines || []);
    await client.query('COMMIT');
    return { id: invoiceId, invoiceNumber, rowVersion: invRes.rows[0].row_version };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export interface InvoicePatchInput {
  contactName?: string; contactEmail?: string | null; contactAddress?: string | null;
  reference?: string | null; status?: string | null; issueDate?: string | null; dueDate?: string | null;
  lines?: InvoiceLineItemPatch[];
}
export async function updateInvoice(id: number, expectedVersion: number, patch: Partial<InvoicePatchInput>): Promise<{ rowVersion: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const curRes = await client.query('SELECT row_version FROM rel_invoices WHERE id = $1 FOR UPDATE', [id]);
    if (curRes.rowCount === 0) throw new BusinessRuleError(`invoice ${id} not found`);
    if (curRes.rows[0].row_version !== expectedVersion) throw new ConcurrencyConflictError('rel_invoices', id);

    const colMap: Record<string, string> = {
      contactName: 'contact_name', contactEmail: 'contact_email', contactAddress: 'contact_address',
      reference: 'reference', status: 'status', issueDate: 'issue_date', dueDate: 'due_date',
    };
    const sets: string[] = []; const vals: any[] = [];
    for (const [k, col] of Object.entries(colMap)) {
      if ((patch as any)[k] !== undefined) { vals.push(normalizeColumnValue(col, (patch as any)[k])); sets.push(`${col} = $${vals.length}`); }
    }
    const linesChanged = Array.isArray(patch.lines);
    if (linesChanged) {
      await replaceInvoiceLinesTx(client, id, patch.lines!);
    }
    if (sets.length === 0 && !linesChanged) {
      await client.query('COMMIT');
      return { rowVersion: curRes.rows[0].row_version };
    }
    vals.push(id); const idIdx = vals.length;
    const setClause = sets.length ? sets.join(', ') + ', ' : '';
    const res = await client.query(
      `UPDATE rel_invoices SET ${setClause}row_version = row_version + 1, updated_at = NOW() WHERE id = $${idIdx} RETURNING row_version`,
      vals
    );
    await client.query('COMMIT');
    return { rowVersion: res.rows[0].row_version };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ── INVOICE-DELETE / SALES-vs-ACCOUNTING REPAIR (2026-08-24) — ROOT CAUSE ──
// An invoice is represented in this system TWO ways at once, by design (see
// the header comment above CREATE TABLE rel_invoices in
// database/migrations/007_relational_core.sql): as a freestanding
// rel_invoices row, AND — when it belongs to a job — as invoice linkage
// fields stamped onto that job (invoice_num / invoice_date / invoice_due /
// invoice_created / invoice_status). createInvoiceForJob above writes BOTH,
// in one transaction, on every one of its three branches.
//
// This function used to reverse only the first. Every invoice list in the
// frontend — Sales -> Invoices (jobInvItems), Accounting -> Invoices
// (getJobInvoices), getAllInvoicesUnified (dashboard counts + consistency
// audit), the Payments tab, and the dashboard revenue tile — SYNTHESISES a
// job-derived invoice row out of job.invoiceNum, and suppresses it only
// while a live accInvoices record still references that job. So deleting a
// job's invoice removed the very record that was suppressing the job-side
// twin: the invoice did not disappear, it silently changed source from
// 'manual' to 'job' and carried on being listed under the SAME invoice
// number and the same amount. Worse, the job was then permanently stuck —
// createInvoiceForJob refuses a job whose invoice_created is already true,
// and Accounting renders no delete control at all for a source==='job' row,
// so the leftover could neither be re-invoiced nor removed.
//
// The fix is to make the delete reverse the same two-part write the create
// performed, atomically: the invoice row (plus its own payments and, by
// cascade, its line items) AND the job-side linkage that represents it.
//
// SCOPE — this is the part that has to be exactly right, because getting it
// wrong destroys another job's financial data. rel_invoices has UNIQUE
// (company_code, invoice_number); rel_jobs has NO such constraint, so two
// jobs CAN legitimately carry the same invoice_num — that is precisely the
// historical numbering collision LegacyInvoiceConflictError quarantines
// above, and which the codebase says must never be auto-resolved. So the
// reversal is scoped to the job this invoice is actually LINKED to:
//   * rel_invoices.job_id is set on every branch of createInvoiceForJob and
//     by convertQuoteToJob's relink, so when it is present it names the one
//     job, unambiguously, and nothing else is touched.
//   * job_id can be NULL on a BACKFILLED invoice whose JSON record carried
//     no jobId (backfill.ts only sets it from rec.jobId) while the job's own
//     JSON still carried the invoice number. There, and only there, the job
//     is resolved by (company_code, invoice_num) — case- and whitespace-
//     insensitively, because backfill stores both sides verbatim from JSON.
//     If that resolves to MORE THAN ONE job it is the quarantined collision:
//     nothing is cleared, and the candidates are returned as `ambiguousJobs`
//     so a person can decide, exactly as LegacyInvoiceConflictError intends.
// A job is also only cleared if it actually has linkage to clear, and never
// when it carries a DIFFERENT invoice number — so no job's row_version is
// bumped (and no editor is given a spurious 409) for a no-op.
//
// Nothing else about the job is touched: its stage/status stay where the
// business actually is (an invoice being deleted does not un-install a
// sign), and its own job-owned payments (rel_payments owner_type='job') are
// its own, not the invoice's — which is why invoice_status is RECOMPUTED
// from those surviving payments rather than simply nulled: a job that has
// been paid directly must not be reported as unpaid because its invoice
// record was removed. The consumed INV number is deliberately NOT returned
// to the counter — re-invoicing mints the next number, which is the normal
// accounting treatment of a deleted document.
//
// LOCK ORDER: createInvoiceForJob takes rel_jobs FOR UPDATE and then
// rel_invoices. This function must take them in the SAME order or a
// concurrent create/delete pair can deadlock, so it reads the invoice's
// identity unlocked first, locks the job rows, and only then locks and
// version-checks the invoice. company_code/invoice_number are immutable
// (updateInvoice's colMap contains neither), so that unlocked read cannot go
// stale — but job_id is NOT immutable (createInvoiceForJob's adoption branch
// and convertQuoteToJob both assign it, neither bumping row_version), so it
// is re-read under the invoice's own lock and any change aborts the delete
// as a conflict rather than clearing a job that was never locked. For the
// same reason the final UPDATE is restricted to the ids locked earlier
// (`id = ANY($1)`) instead of re-evaluating the predicate against a fresh
// READ COMMITTED snapshot.
export async function deleteInvoice(id: number, expectedVersion: number): Promise<{
  deleted: true;
  clearedJobs: Array<{ id: number; sourceId: string; jobNumber: string; rowVersion: number }>;
  ambiguousJobs: Array<{ id: number; jobNumber: string }>;
  creditReleased: number;
}> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const identRes = await client.query(
      'SELECT company_code, invoice_number, job_id FROM rel_invoices WHERE id = $1', [id]
    );
    if (identRes.rowCount === 0) throw new BusinessRuleError(`invoice ${id} not found`);
    const companyCode: string = identRes.rows[0].company_code;
    const invoiceNumber: string = identRes.rows[0].invoice_number;
    const identJobId: number | null = identRes.rows[0].job_id === null ? null : Number(identRes.rows[0].job_id);

    let targetJobIds: number[] = [];
    let ambiguousJobs: Array<{ id: number; jobNumber: string }> = [];
    if (identJobId !== null) {
      targetJobIds = [identJobId];
    } else {
      const matchRes = await client.query(
        `SELECT id, job_number FROM rel_jobs
          WHERE company_code = $1 AND UPPER(BTRIM(invoice_num)) = UPPER(BTRIM($2)) ORDER BY id`,
        [companyCode, invoiceNumber]
      );
      if (matchRes.rowCount === 1) targetJobIds = [Number(matchRes.rows[0].id)];
      else if ((matchRes.rowCount ?? 0) > 1) {
        ambiguousJobs = matchRes.rows.map((r) => ({ id: Number(r.id), jobNumber: r.job_number }));
      }
    }
    if (targetJobIds.length > 0) {
      await client.query('SELECT id FROM rel_jobs WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE', [targetJobIds]);
    }

    const curRes = await client.query('SELECT row_version, job_id FROM rel_invoices WHERE id = $1 FOR UPDATE', [id]);
    if (curRes.rowCount === 0) throw new BusinessRuleError(`invoice ${id} not found`);
    if (curRes.rows[0].row_version !== expectedVersion) throw new ConcurrencyConflictError('rel_invoices', id);
    const lockedJobId: number | null = curRes.rows[0].job_id === null ? null : Number(curRes.rows[0].job_id);
    if (lockedJobId !== identJobId) throw new ConcurrencyConflictError('rel_invoices', id);

    // FINANCIAL SAFETY (2026-08-24). The invoice's own payment history goes
    // with it — the existing, explicit business rule, which the confirmation
    // dialog states in full before anything is deleted. But a 'Credit'
    // payment is not just history: it CONSUMED a customer credit note, and
    // deleting it without releasing that consumption silently burns the
    // customer's credit. deletePayment has always released it; this path
    // never did, because it deleted the rows with raw SQL. Both now go
    // through the same releaseCreditForPaymentTx, so credit notes stay
    // internally correct whichever way a payment is removed.
    const invPaysRes = await client.query(
      `SELECT id, method, owner_type, owner_id, amount FROM rel_payments
        WHERE owner_type = 'invoice' AND owner_id = $1 ORDER BY id FOR UPDATE`,
      [id]
    );
    let creditReleased = 0;
    for (const p of invPaysRes.rows) creditReleased += await releaseCreditForPaymentTx(client, p);
    await client.query(`DELETE FROM rel_payments WHERE owner_type = 'invoice' AND owner_id = $1`, [id]);
    await client.query('DELETE FROM rel_invoices WHERE id = $1', [id]);
    // The second half of the same reversal. row_version is bumped so any
    // editor holding this job open gets the normal 409 stale_record instead
    // of silently writing the cleared linkage back; the new version is
    // returned so the client that performed the delete stays current.
    const clearedRes = targetJobIds.length > 0
      ? await client.query(
          `UPDATE rel_jobs
              SET invoice_num = NULL, invoice_date = NULL, invoice_due = NULL,
                  invoice_created = false, invoice_status = NULL,
                  row_version = row_version + 1, updated_at = NOW()
            WHERE id = ANY($1::bigint[])
              AND (invoice_num IS NULL OR UPPER(BTRIM(invoice_num)) = UPPER(BTRIM($2)))
              AND (invoice_num IS NOT NULL OR invoice_created OR invoice_status IS NOT NULL
                   OR invoice_date IS NOT NULL OR invoice_due IS NOT NULL)
            RETURNING id, source_id, job_number, row_version`,
          [targetJobIds, invoiceNumber]
        )
      : { rows: [] as any[] };
    // A cleared job may still hold payments of its OWN (owner_type='job'),
    // which this delete does not touch and must not misreport. invoice_status
    // is the column those payments' status lives in, so where any survive it
    // is recomputed from them (recomputeOwnerPaymentStatus does not bump
    // row_version, so the version returned above stays correct); where none
    // do, NULL is the true reversal of createInvoiceForJob's stamp.
    for (const r of clearedRes.rows) {
      const paidRes = await client.query(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM rel_payments WHERE owner_type = 'job' AND owner_id = $1`,
        [Number(r.id)]
      );
      if (Number(paidRes.rows[0].total) > 0) await recomputeOwnerPaymentStatus(client, 'job', Number(r.id));
    }
    await client.query('COMMIT');
    return {
      deleted: true,
      clearedJobs: clearedRes.rows.map((r) => ({
        id: Number(r.id), sourceId: String(r.source_id), jobNumber: r.job_number, rowVersion: r.row_version,
      })),
      ambiguousJobs,
      creditReleased,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ── QUOTE -> INVOICE (shared writer for BOTH quote-invoicing workflows) ────
// 2026-08-25 — DIRECT-INVOICE-FROM-QUOTE REPAIR.
//
// THE DEFECT THIS CLOSES. index.html's "Create Invoice from Quote" button
// (QuotesPage.createInvoiceFromQuote) had exactly ONE relational path:
// relationalApi.finalizeProforma -> finalizeProformaToInvoice. That function
// exists to FINALISE AN EXISTING PRO-##### RESERVATION and therefore refuses
// outright when the quote has none — `quote 371 has no proforma reservation to
// finalise`. But the majority of approved quotes never had a proforma printed
// or emailed, so they carry no reservation, and the button was unusable for
// them. The JSON branch directly below it in index.html has ALWAYS supported
// the no-proforma case (it reserves a fresh INV number from the atomic
// counter), so this was a genuine cutover gap, not a business rule: the
// relational fork simply never grew the direct-invoice half.
//
// TWO WORKFLOWS, ONE WRITER, NO CONFLICT.
//   A. quote HAS a proforma reservation -> the reserved suffix is consumed
//      verbatim (PRO-00123 -> INV-00123); no second number is ever allocated.
//      This is the established behaviour and is byte-for-byte unchanged.
//   B. quote has NO proforma reservation -> a fresh invoice number is reserved
//      from the SAME atomic counter every other invoice uses
//      (reserveDocumentNumberWithClient, docType 'invoice') — exactly what the
//      JSON branch and createInvoiceForJob already do.
// Nothing fabricates a proforma reservation to satisfy the older function, and
// neither workflow can pre-empt the other: which branch runs is decided solely
// by whether rel_quotes.proforma_num is set.
//
// `mode` is what keeps the two entry points honest:
//   'proforma-only' — finalizeProformaToInvoice's contract, preserved exactly:
//                     refuse if there is no reservation, and refuse if the
//                     derived number already exists.
//   'direct'        — the button's contract: reuse this quote's existing
//                     invoice if it already has one (idempotent, per the
//                     established invoice-canonicalisation rules), otherwise
//                     create exactly one.
//
// Financially both paths go through writeInvoiceLinesFromSourceTx +
// writeInvoiceAdjustmentLinesTx — the same shared writers createInvoiceForJob
// uses — so pieces x qty x unit price, the discount line and the setup-fee line
// are all reproduced and the invoice total equals the quote total. There is
// deliberately no second implementation of that arithmetic here.
//
// `reference` is deliberately left NULL, matching both the pre-existing
// relational proforma path and index.html's JSON branch (`reference: ''`, "set
// once this quote converts to a job"): it is the de-dup key job linkage uses
// (createInvoiceForJob's COALESCE(NULLIF(reference,''), job_number)), so
// stamping the quote number here would block that link later.
type QuoteInvoiceMode = 'proforma-only' | 'direct';

async function createInvoiceFromQuoteTx(
  client: PoolClient,
  quoteId: number,
  mode: QuoteInvoiceMode
): Promise<{ invoiceId: number; invoiceNumber: string; reused: boolean }> {
  const quoteRes = await client.query('SELECT * FROM rel_quotes WHERE id = $1 FOR UPDATE', [quoteId]);
  if (quoteRes.rowCount === 0) throw new BusinessRuleError(`quote ${quoteId} not found`);
  const quote = quoteRes.rows[0];
  if (mode === 'proforma-only' && !quote.proforma_num) {
    throw new BusinessRuleError(`quote ${quoteId} has no proforma reservation to finalise`);
  }

  // ── IDEMPOTENCY (direct path only) ──────────────────────────────────────
  // A quote may only ever have ONE invoice — index.html enforces that in the
  // UI (getQuoteInvoice hides the button and offers "View Invoice" instead),
  // but a stale tab, a double-click that outruns the client-side guard, or a
  // second session can all still reach this. Reusing the existing record here
  // means a repeated click can never mint a second document or burn a number
  // from the atomic pool — checked BEFORE any reservation, exactly as
  // createInvoiceForJob's own reuse branch is. Void invoices are ignored so a
  // deliberately voided document does not permanently block re-invoicing.
  // Deliberately NOT applied to 'proforma-only': finalizeProformaToInvoice's
  // established contract is to REFUSE a second finalisation loudly, and that
  // refusal is asserted by the existing suites.
  if (mode === 'direct') {
    const reusable = await client.query(
      `SELECT id, invoice_number FROM rel_invoices
        WHERE quote_id = $1 AND COALESCE(status, '') <> 'void'
        ORDER BY id ASC LIMIT 1
        FOR UPDATE`,
      [quoteId]
    );
    if ((reusable.rowCount ?? 0) > 0) {
      return {
        invoiceId: Number(reusable.rows[0].id),
        invoiceNumber: String(reusable.rows[0].invoice_number),
        reused: true,
      };
    }
  }

  // HISTORICAL PIECES PROTECTION (2026-08-25). Resolved BEFORE a number is
  // reserved or the PRO reservation is consumed, so a refusal never touches
  // either. This is the check that turns SQ-00150 from "invoiced at R4,542.50"
  // into "invoiced at its own R15,582.50" — its line's piece count of 4 is
  // recovered deterministically from the preserved historical record instead of
  // a NULL column being read as 1.
  const quotePieces = await resolveDocument013ForInvoicing(client, 'quote', quoteId);
  assertNo013Blockers(quotePieces);
  const quotePiecesMap = effectivePiecesByLineId(quotePieces);

  let invoiceNumber: string;
  if (quote.proforma_num) {
    // Consume the EXACT reserved suffix (same derivation rule as
    // documentNumbers.ts deriveReservedInvoiceNumber) — never allocate a second.
    const m = /^PRO-(\d+)$/i.exec(String(quote.proforma_num).trim());
    invoiceNumber = m ? `INV-${m[1]}` : String(quote.proforma_num).trim().toUpperCase();
    const existing = await client.query(
      'SELECT id FROM rel_invoices WHERE company_code = $1 AND invoice_number = $2',
      [quote.company_code, invoiceNumber]
    );
    if (existing.rowCount && existing.rowCount > 0) {
      throw new BusinessRuleError(`invoice ${invoiceNumber} already exists for company ${quote.company_code} — this reservation was already finalised, refusing to create a second invoice`);
    }
  } else {
    invoiceNumber = await reserveDocumentNumberWithClient(client, quote.company_code, 'invoice');
  }

  const lineItemsRes = await client.query('SELECT * FROM rel_quote_line_items WHERE quote_id = $1 ORDER BY line_index', [quoteId]);
  // contact_email / contact_address are new here (2026-08-25) and purely
  // additive — they were left NULL before, so a quote invoice opened in
  // Accounting showed no contact details at all, the same defect BUG 6 fixed
  // for job invoices. company_code comes from the quote, so an Original (co=2)
  // quote can never produce a Holdings (co=1) invoice or vice versa.
  const invRes = await client.query(
    `WITH new_id AS (SELECT nextval('rel_invoices_id_seq') AS id)
     INSERT INTO rel_invoices (id, source_id, invoice_number, company_code, customer_id, contact_name, contact_email, contact_address, quote_id, quote_number_raw, status, issue_date, legacy_data)
     SELECT new_id.id, new_id.id::text, $1, $2, $3, $4, $7, $8, $5, $6, 'sent', CURRENT_DATE, '{}'::jsonb FROM new_id
     RETURNING id`,
    [invoiceNumber, quote.company_code, quote.customer_id, quote.customer_name_raw, quoteId, quote.quote_number,
     quote.email, quote.address]
  );
  const invoiceId = Number(invRes.rows[0].id);
  // JOB/QUOTE -> INVOICE FINANCIAL CONSISTENCY REPAIR (2026-08-25): this
  // loop carried the SAME defect as writeInvoiceLinesFromJobTx — a plain
  // qty x unit_price copy that dropped `pieces`, the setup fee and the
  // discount, so a proforma finalised relationally did not add up to its own
  // quote. It now goes through the shared writers, which is also what makes
  // Quote -> Invoice and Job -> Invoice produce the identical document for
  // the identical commercial content.
  await writeQuoteInvoiceLinesTx(client, invoiceId, lineItemsRes.rows, quote, quotePiecesMap);

  // FINANCIAL CONSISTENCY GUARD — the quote's own stored total is the
  // authority, and rel_quotes.subtotal/vat_amount/total are recomputed from its
  // lines by createQuote/updateQuote, so they track it. An invoice that does
  // not add up to it is never issued: this throws, the transaction rolls back,
  // and with it any invoice number reserved above (the reservation ran on this
  // same client) — while a PRO reservation, which is only ever read here, is
  // left untouched and still available.
  await assertInvoiceMatchesSourceTx(
    client, invoiceId, `quote ${quote.quote_number}`, 'total', Number(quote.total) || 0
  );
  return { invoiceId, invoiceNumber, reused: false };
}

// EXPORTED (2026-08-25) for the same reason writeInvoiceLinesFromJobTx is: a
// one-off, narrowly-scoped repair of a single historical invoice must rebuild
// that invoice's lines with THE DEPLOYED WRITER, never a copy of it. See
// src/scripts/repair-sq-00150-inv-00111.ts.
export async function writeQuoteInvoiceLinesTx(
  client: PoolClient,
  invoiceId: number,
  quoteLines: any[],
  quote: any,
  effectivePieces: Map<number, number>
): Promise<void> {
  // JOB/QUOTE -> INVOICE FINANCIAL CONSISTENCY REPAIR (2026-08-25): this
  // loop carried the SAME defect as writeInvoiceLinesFromJobTx — a plain
  // qty x unit_price copy that dropped `pieces`, the setup fee and the
  // discount, so a proforma finalised relationally did not add up to its own
  // quote. It now goes through the shared writers, which is also what makes
  // Quote -> Invoice and Job -> Invoice produce the identical document for
  // the identical commercial content.
  const { nextIndex, linesSubtotal } = await writeInvoiceLinesFromSourceTx(
    client, invoiceId, 'rel_quote_line_items', quoteLines, effectivePieces
  );
  await writeInvoiceAdjustmentLinesTx(
    client, invoiceId, nextIndex, linesSubtotal, quote.setup_fee, quote.discount_pct
  );
}

// ── PRO -> INV finalisation ──────────────────────────────────────────────
// Verifies the PRO reservation belongs to this quote, verifies the matching
// INV reservation (same derivation rule as documentNumbers.ts
// deriveReservedInvoiceNumber), consumes the EXACT reserved suffix — never
// allocates a second number.
//
// 2026-08-25: the body moved into createInvoiceFromQuoteTx above so the direct
// path cannot drift from it. The contract of THIS function is unchanged: it
// still refuses a quote with no proforma reservation, and still refuses a
// second finalisation of the same reservation.
export async function finalizeProformaToInvoice(quoteId: number): Promise<{ invoiceId: number; invoiceNumber: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { invoiceId, invoiceNumber } = await createInvoiceFromQuoteTx(client, quoteId, 'proforma-only');
    await client.query('COMMIT');
    return { invoiceId, invoiceNumber };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ── DIRECT QUOTE -> TAX INVOICE ──────────────────────────────────────────
// The relational counterpart of index.html's "Create Invoice from Quote"
// (QuotesPage.createInvoiceFromQuote) — a standalone tax invoice raised
// against an approved quote BEFORE any job exists, so the client can pay
// immediately. See createInvoiceFromQuoteTx above for the full rationale and
// for how this coexists with finalizeProformaToInvoice without either
// workflow pre-empting the other.
//
// Returns `reused: true` when this quote already had an invoice — the caller
// opens that one instead of creating a duplicate, which is the same rule the
// UI's own getQuoteInvoice guard applies one layer earlier.
export async function createInvoiceFromQuote(quoteId: number): Promise<{ invoiceId: number; invoiceNumber: string; reused: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await createInvoiceFromQuoteTx(client, quoteId, 'direct');
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ── RECORD PAYMENT ──────────────────────────────────────────────────────────
// BEGIN; insert payment; associate with the correct owner; COMMIT.
//
// STAGE 3 (2026-08-20): Credit-method payments — previously excluded from
// the relational fork entirely (index.html's addPayment() gates Credit out
// of relationalApi.recordPayment with `method!=='Credit'`, so it always went
// ── OWNER PAYMENT-STATUS RECOMPUTE — Stage 3 Phase 4 ────────────────────────
// read.ts renders rel_jobs.invoice_status / rel_invoices.status straight
// from their DB columns (no dynamic payment-sum derivation on read) — so
// without this, a job/invoice could reach full payment via
// recordPayment/updatePayment/deletePayment and stay reported as
// "pending"/its prior status forever post-cutover, exactly the kind of
// silent-staleness this migration exists to close. Mirrors the JSON path's
// persist()/addPayment status recompute (paid once total paid >= owner
// total, partial once >0) as closely as the CURRENT schema allows.
//
// KNOWN, DOCUMENTED SIMPLIFICATION: neither rel_jobs nor rel_invoices has a
// paid_at/paid_date column yet (unlike the JSON shape's job.paidAt /
// invoice.paidDate) — only invoice_status/status is recomputed here; adding
// a paid-timestamp column is a future schema migration, out of scope for
// this pass. The JSON path's finer per-operation "not fully/partially paid"
// fallback also differs by call site (jobs always fall back to 'pending';
// invoices fall back to 'sent' specifically on delete but keep their prior
// status verbatim on edit) — this helper collapses that to one rule: an
// invoice's fallback is always its CURRENT status (never force-reset to
// 'sent'), which never regresses a manually-set status, at the cost of not
// reproducing the delete path's historical 'sent'-reset quirk exactly.
// Called for every recordPayment/updatePayment/deletePayment, inside the
// SAME transaction, so the status update can never land without the
// payment change (or vice versa).
// EXPORTED (2026-08-25) so a one-off, narrowly-scoped payment repair can
// derive an owner's status with THIS function — the deployed one — rather than
// re-implementing the paid/partial rule in a script. See
// src/scripts/repair-audio-access-payment-dedup.ts. Behaviour is unchanged:
// the only difference is the `export` keyword.
export async function recomputeOwnerPaymentStatus(client: PoolClient, ownerType: 'job' | 'invoice' | 'quote', ownerId: number): Promise<void> {
  // Quotes' own `status` (draft/converted/...) is a business-workflow field,
  // never payment-derived — matches the JSON path, where quote.payments[]
  // never touches quote.status either.
  if (ownerType === 'quote') return;

  const sumRes = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS total_paid FROM rel_payments WHERE owner_type = $1 AND owner_id = $2`,
    [ownerType, ownerId]
  );
  const totalPaid = Number(sumRes.rows[0].total_paid);

  if (ownerType === 'job') {
    const jobRes = await client.query(`SELECT value FROM rel_jobs WHERE id = $1`, [ownerId]);
    if (jobRes.rowCount === 0) return; // owner row vanished mid-transaction elsewhere — nothing to update
    const jobValue = Number(jobRes.rows[0].value) || 0;
    const newStatus = totalPaid >= jobValue && jobValue > 0 ? 'paid' : totalPaid > 0 ? 'partial' : 'pending';
    await client.query(`UPDATE rel_jobs SET invoice_status = $1 WHERE id = $2`, [newStatus, ownerId]);
  } else {
    const linesRes = await client.query(
      `SELECT qty, unit_amount, tax_type FROM rel_invoice_line_items WHERE invoice_id = $1`,
      [ownerId]
    );
    const invTotal = linesRes.rows.reduce((s, l) => {
      const sub = Number(l.qty) * Number(l.unit_amount);
      return s + sub + (l.tax_type === '15%' ? sub * 0.15 : 0);
    }, 0);
    const curRes = await client.query(`SELECT status FROM rel_invoices WHERE id = $1`, [ownerId]);
    if (curRes.rowCount === 0) return;
    const curStatus = curRes.rows[0].status;
    const newStatus = totalPaid >= invTotal && invTotal > 0 ? 'paid' : totalPaid > 0 ? 'partial' : curStatus;
    await client.query(`UPDATE rel_invoices SET status = $1 WHERE id = $2`, [newStatus, ownerId]);
  }
}

// through JSON) — are now handled here, transactionally, reproducing the
// EXACT existing business effect: `creditNoteAvailable` sums
// max(0, amount-used) across every 'customer' credit note matching the
// owner's contact name (case/whitespace-insensitive), and
// `applyCreditNoteUsage` consumes OLDEST notes first (ascending date) up to
// the payment amount. "Never: apply credit note but fail payment; or record
// payment but fail credit note balance update" — both happen in the SAME
// transaction here, so either both succeed or neither does. If the matching
// notes can't cover the full amount, the whole payment is refused (never a
// partially-funded Credit payment silently recorded).
export async function recordPayment(
  owner: { type: 'job' | 'invoice' | 'quote'; id: number },
  amount: number,
  opts: { date?: string; method?: string; reference?: string; notes?: string } = {}
): Promise<{ paymentId: number; rowVersion: number; creditApplied?: number }> {
  const table = owner.type === 'job' ? 'rel_jobs' : owner.type === 'invoice' ? 'rel_invoices' : 'rel_quotes';
  const nameCol = owner.type === 'invoice' ? 'contact_name' : 'customer_name_raw';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ownerRes = await client.query(`SELECT id, ${nameCol} AS contact_name FROM ${table} WHERE id = $1 FOR UPDATE`, [owner.id]);
    if (ownerRes.rowCount === 0) throw new BusinessRuleError(`${owner.type} ${owner.id} not found`);

    let creditApplied: number | undefined;
    if (opts.method === 'Credit') {
      const contactName = (ownerRes.rows[0].contact_name || '').trim();
      const norm = contactName.toLowerCase();
      if (!norm) {
        throw new BusinessRuleError(`cannot record a Credit payment — ${owner.type} ${owner.id} has no contact/customer name to match against credit notes`);
      }
      // Oldest-first (ascending note_date) consumption — matches applyCreditNoteUsage.
      const notesRes = await client.query(
        `SELECT id, amount, used_amount FROM rel_credit_notes
         WHERE note_type = 'customer' AND LOWER(TRIM(contact_name_raw)) = $1
         ORDER BY note_date ASC NULLS LAST, id ASC
         FOR UPDATE`,
        [norm]
      );
      let remaining = amount;
      let applied = 0;
      for (const note of notesRes.rows) {
        if (remaining <= 0) break;
        const available = Number(note.amount) - Number(note.used_amount);
        if (available <= 0) continue;
        const consume = Math.min(remaining, available);
        await client.query(
          `UPDATE rel_credit_notes SET used_amount = used_amount + $1, row_version = row_version + 1, updated_at = NOW() WHERE id = $2`,
          [consume, note.id]
        );
        remaining -= consume;
        applied += consume;
      }
      if (applied + 1e-9 < amount) {
        throw new BusinessRuleError(
          `insufficient available credit for "${contactName}": requested ${amount.toFixed(2)}, only ${applied.toFixed(2)} available across matching credit notes — refusing to record a partially-funded Credit payment`
        );
      }
      creditApplied = applied;
    }

    const nextIdx = await client.query(
      `SELECT COALESCE(MAX(line_index), -1) + 1 AS idx FROM rel_payments WHERE owner_type = $1 AND owner_id = $2`,
      [owner.type, owner.id]
    );
    const lineIndex = nextIdx.rows[0].idx;

    const res = await client.query(
      `WITH new_id AS (SELECT nextval('rel_payments_id_seq') AS id)
       INSERT INTO rel_payments (id, source_id, owner_type, owner_id, line_index, amount, payment_date, method, reference, notes, legacy_data)
       SELECT new_id.id, new_id.id::text, $1, $2, $3, $4, $5, $6, $7, $8, '{}'::jsonb FROM new_id
       RETURNING id, row_version`,
      [owner.type, owner.id, lineIndex, amount, opts.date || null, opts.method || null, opts.reference || null, opts.notes || null]
    );
    await recomputeOwnerPaymentStatus(client, owner.type, owner.id);
    await client.query('COMMIT');
    return { paymentId: res.rows[0].id, rowVersion: res.rows[0].row_version, creditApplied };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ── UPDATE / DELETE PAYMENT — Stage 3 ───────────────────────────────────────
// updatePayment: refuses to edit (or edit INTO) a Credit-funded payment,
// exactly matching promptEditPayment's block ("Credit-funded payments can't
// be edited — delete and re-record instead").
// deletePayment: TRUE PHYSICAL REMOVAL (matches JSON's
// deletePaymentFromSource filter), never a status/void flag — rel_payments
// has no such column. If the removed payment was Credit-funded, releases
// its usage from matching credit notes NEWEST-first (descending note_date),
// matching releaseCreditNoteUsage's LIFO-release convention — in the SAME
// transaction as the delete, so a release failure rolls back the delete too.
export async function updatePayment(
  id: number,
  expectedVersion: number,
  patch: { amount?: number; date?: string | null; method?: string | null; reference?: string | null; notes?: string | null }
): Promise<{ rowVersion: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const curRes = await client.query('SELECT * FROM rel_payments WHERE id = $1 FOR UPDATE', [id]);
    if (curRes.rowCount === 0) throw new BusinessRuleError(`payment ${id} not found`);
    const cur = curRes.rows[0];
    if (cur.row_version !== expectedVersion) throw new ConcurrencyConflictError('rel_payments', id);
    if (cur.method === 'Credit') {
      throw new BusinessRuleError(`payment ${id} was funded by a credit note and cannot be edited — delete and re-record instead (matches the existing JSON business rule)`);
    }
    if (patch.method === 'Credit') {
      throw new BusinessRuleError(`payment ${id} cannot be changed to method "Credit" via a plain edit — record a new Credit payment through the credit-note application flow instead`);
    }
    const colMap: Record<string, string> = { amount: 'amount', date: 'payment_date', method: 'method', reference: 'reference', notes: 'notes' };
    const sets: string[] = []; const vals: any[] = [];
    for (const [k, col] of Object.entries(colMap)) {
      if ((patch as any)[k] !== undefined) { vals.push(normalizeColumnValue(col, (patch as any)[k])); sets.push(`${col} = $${vals.length}`); }
    }
    if (sets.length === 0) {
      await client.query('COMMIT');
      return { rowVersion: cur.row_version };
    }
    vals.push(id); const idIdx = vals.length;
    const res = await client.query(
      `UPDATE rel_payments SET ${sets.join(', ')}, row_version = row_version + 1, updated_at = NOW() WHERE id = $${idIdx} RETURNING row_version`,
      vals
    );
    // Recompute unconditionally (not just when patch.amount changed) — cheap,
    // and correct even if a future field is added to colMap that affects the
    // owner-total comparison.
    await recomputeOwnerPaymentStatus(client, cur.owner_type, cur.owner_id);
    await client.query('COMMIT');
    return { rowVersion: res.rows[0].row_version };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// STAGE 3 Phase 5 — read-only helper so api.ts's DELETE /payments/:id route
// can check "is this a Credit-funded payment?" BEFORE calling deletePayment
// (which, for a Credit payment, releases usage back onto rel_credit_notes —
// a cross-authority write api.ts must gate on "creditNotes" cutover, same
// as the POST /payments Credit-payment check). Kept in services.ts rather
// than api.ts querying `pool` directly, matching this file's existing
// "api.ts is a thin HTTP adapter" boundary.
export async function getPaymentMethod(id: number): Promise<string | null> {
  const res = await pool.query('SELECT method FROM rel_payments WHERE id = $1', [id]);
  return res.rowCount ? res.rows[0].method : null;
}

// MIGRATION CLOSURE Item 1 (2026-08-21): deletePayment previously took no
// expectedVersion at all — the ONE relational delete route in the codebase
// without row-scoped optimistic concurrency (every sibling — updatePayment,
// updateQuote, updateJob, deleteCreditNote, updatePurchaseOrder — checks
// row_version). That gap meant a stale client (e.g. two staff viewing the
// same job's payment list, one already having edited/re-recorded a payment
// the other still sees the old copy of) could delete a payment that had
// since been changed elsewhere out from under it, with no conflict signal
// at all — silent data loss, not merely a stale read. Fixed the same way as
// every other relational mutation: lock the row FOR UPDATE, compare
// row_version to the caller-supplied expectedVersion BEFORE doing anything
// else (including the credit-release side effect), and throw
// ConcurrencyConflictError (-> HTTP 409 stale_record) on a mismatch,
// touching NOTHING. Only once the version is confirmed current does the
// function proceed to release credit and delete, in the SAME transaction as
// before — so "reject stale delete" and "release credit + delete
// atomically" now both hold together, without duplicating any of the
// existing credit-release/recompute logic.
// ── SHARED CREDIT RELEASE (extracted 2026-08-24, invoice-delete repair) ────
// Removing a payment whose method is 'Credit' must give the consumed amount
// back to the customer's credit note(s) — otherwise the credit is silently
// burnt. This was the body of deletePayment and was reachable ONLY through
// deletePayment, which meant deleteInvoice's own
// `DELETE FROM rel_payments WHERE owner_type='invoice'` destroyed Credit
// payments without ever releasing what they had consumed. Extracted verbatim
// (same oldest-releasable-first selection, same FOR UPDATE, same row_version
// bump) so both callers apply one identical rule and cannot drift.
// EXPORTED (2026-08-25) alongside recomputeOwnerPaymentStatus, for the same
// reason: a repair that deletes a payment must reverse its credit-note effect
// EXACTLY as deletePayment does. Re-implementing LIFO credit release in a
// script would be a second source of truth. A non-Credit payment returns 0 and
// touches nothing. Behaviour is unchanged: only the `export` keyword is new.
export async function releaseCreditForPaymentTx(
  client: PoolClient,
  payment: { method?: string | null; owner_type: 'job' | 'invoice' | 'quote'; owner_id: number; amount: number | string }
): Promise<number> {
  if (payment.method !== 'Credit') return 0;
  let creditReleased = 0;
  const table = payment.owner_type === 'job' ? 'rel_jobs' : payment.owner_type === 'invoice' ? 'rel_invoices' : 'rel_quotes';
  const nameCol = payment.owner_type === 'invoice' ? 'contact_name' : 'customer_name_raw';
  const ownerRes = await client.query(`SELECT ${nameCol} AS contact_name FROM ${table} WHERE id = $1`, [payment.owner_id]);
  const contactName = ownerRes.rowCount ? (ownerRes.rows[0].contact_name || '') : '';
  const norm = contactName.trim().toLowerCase();
  if (!norm) return 0;
  const notesRes = await client.query(
    `SELECT id, used_amount FROM rel_credit_notes
     WHERE note_type = 'customer' AND LOWER(TRIM(contact_name_raw)) = $1 AND used_amount > 0
     ORDER BY note_date DESC NULLS LAST, id DESC
     FOR UPDATE`,
    [norm]
  );
  let remaining = Number(payment.amount);
  for (const note of notesRes.rows) {
    if (remaining <= 0) break;
    const releasable = Math.min(remaining, Number(note.used_amount));
    if (releasable <= 0) continue;
    await client.query(
      `UPDATE rel_credit_notes SET used_amount = used_amount - $1, row_version = row_version + 1, updated_at = NOW() WHERE id = $2`,
      [releasable, note.id]
    );
    remaining -= releasable;
    creditReleased += releasable;
  }
  return creditReleased;
}

export async function deletePayment(id: number, expectedVersion: number): Promise<{ deleted: true; creditReleased: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const curRes = await client.query('SELECT * FROM rel_payments WHERE id = $1 FOR UPDATE', [id]);
    if (curRes.rowCount === 0) throw new BusinessRuleError(`payment ${id} not found`);
    const payment = curRes.rows[0];
    if (payment.row_version !== expectedVersion) throw new ConcurrencyConflictError('rel_payments', id);
    const creditReleased = await releaseCreditForPaymentTx(client, payment);
    await client.query('DELETE FROM rel_payments WHERE id = $1', [id]);
    await recomputeOwnerPaymentStatus(client, payment.owner_type, payment.owner_id);
    await client.query('COMMIT');
    return { deleted: true, creditReleased };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ── LINE ITEM REPLACE HELPERS — Stage 3 ─────────────────────────────────────
// Shared by updateQuote/updateJob/updateQuoteWithJobSync below. Full
// delete+reinsert of a record's line items, transactional with whatever
// caller-supplied `client` is mid-transaction — never a partial update of
// individual lines (matches JobDetail/CreateQuoteModal, which always save
// the WHOLE lines array as one unit, never a single line in isolation).
// Field names here mirror what read.ts now emits/expects (desc/itemId/unit),
// not the DB column names, so callers (services.ts callers and, later, the
// REST layer) can pass through exactly what the frontend already sends.
export interface LineItemPatch {
  desc: string;
  qty: number;
  unitPrice: number;
  unit?: string | null;
  itemId?: number | null;
  // migration 013 — see LINE_EXTRAS below.
  sqmL?: number | string | null;
  sqmW?: number | string | null;
  pieces?: number | string | null;
  cpId?: number | string | null;
  cpLinked?: boolean | null;
}

// ── POST-MIGRATION STABILIZATION (2026-08-24) — BUG 3 ROOT CAUSE #1 ──────────
// "Saving a Quote frequently fails with Internal error."
//
// Every line-item write below used to push the caller's `itemId` STRAIGHT into
// `inventory_item_id`, which is `BIGINT REFERENCES rel_inventory_items(id)`
// (007_relational_core.sql). But `itemId` is NOT that PK — read.ts renders an
// inventory item's frontend-facing id from `restoreId(source_id)` (its ORIGINAL
// historical JSON id) and exposes the real PK separately as `_relId`. For every
// BACKFILLED inventory item those two values differ, so a quote line linked to
// such an item produced:
//   - PostgreSQL 23503 foreign_key_violation  (numeric source_id that is not a PK), or
//   - PostgreSQL 22P02 invalid_text_representation ("abc" into BIGINT)
// neither of which is a ConcurrencyConflictError / BusinessRuleError, so api.ts's
// handleServiceError fell through to `500 {error:'Internal error'}` — the exact
// message users reported, on the exact operation they reported it on (quote
// save / quote edit / the complete-product cascade), and ONLY for quotes whose
// lines were linked to pre-migration inventory items. Fresh post-cutover items
// happened to work because createInventoryItem sets source_id = id::text, making
// the two ids coincidentally identical — which is why this never showed up in
// testing against newly-created data.
//
// SECOND (silent) HALF OF THE SAME DEFECT: these inserts never populated
// `inventory_source_id`, yet read.ts reads a line's `itemId` FROM
// `inventory_source_id` first. So even when the FK happened to be valid, every
// successfully-saved line came back with `itemId: null` — the inventory link was
// dropped on every quote/job edit.
//
// Both halves are fixed at this ONE shared point (rather than at each call site
// or with a frontend workaround) by resolving the caller-supplied id to the real
// row: match on `source_id` first (the id the frontend actually holds, correct
// for backfilled AND fresh rows), fall back to the PK, and store BOTH the FK and
// the source id. An id that matches nothing resolves to NULL — a line whose
// inventory item was deleted still saves, exactly like convertQuoteToJob's own
// forgiving "referenced item no longer exists" skip, instead of 500ing the whole
// quote.
/* ═══════════════════════════════════════════
   QUOTE / JOB LINE EXTRAS + INPUT VALIDATION (2026-08-24, migration 013)

   LINE_EXTRAS — the five per-line fields migration 013 gives real columns.
   `pieces` is the only FINANCIAL one: the Quote form has always priced a line
   as `pQty x qty x unitPrice` (index.html ~6753) while the server recomputed
   `qty x unitPrice`, so every multi-piece quote was persisted under-priced by
   a factor of pQty. lineSubtotal() below is now the ONE formula, used by every
   writer, and it defaults pieces to 1 so historical lines price exactly as
   they always have.

   VALIDATION — the Quote form can hand the server values Postgres cannot
   parse, and until now they reached `$::date` / NUMERIC raw and surfaced to
   the user as a generic "Internal error". The worst case needs no bad typing
   at all: migration 012 never retro-populated quote_date, so a BACKFILLED
   quote hydrates its date from legacy_data as whatever string the old JSON
   held (e.g. "14/03/2025"); <input type="date"> renders blank but keeps that
   string in form state, and the next save posts it verbatim. Everything below
   is checked BEFORE any SQL runs, and fails as a BusinessRuleError the client
   already knows how to display without losing the draft.
═══════════════════════════════════════════ */

/** Number | null, tolerant of the strings the form actually sends. */
function optionalNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
/** Boolean | null — only an explicit boolean-ish value sets it. */
function optionalBoolean(v: unknown): boolean | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v;
  const t = String(v).trim().toLowerCase();
  if (t === 'true' || t === '1') return true;
  if (t === 'false' || t === '0') return false;
  return null;
}
/** The originating Complete Product id, kept verbatim as a breadcrumb. */
function optionalSourceId(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

/**
 * THE line subtotal formula. `pieces` and `qty` are separate commercial
 * concepts and are NEVER folded together — qty stays the per-piece quantity,
 * which is what inventory consumption and the printed "N items x X m² each"
 * spec line both depend on.
 */
export function lineSubtotal(pieces: unknown, qty: unknown, unitPrice: unknown): number {
  const p = optionalNumber(pieces);
  const q = Number(qty) || 0;
  const u = Number(unitPrice) || 0;
  const effectivePieces = p === null || p <= 0 ? 1 : p;
  return effectivePieces * q * u;
}

/** Normalised LINE_EXTRAS for one line, ready to bind. */
function lineExtras(l: { sqmL?: unknown; sqmW?: unknown; pieces?: unknown; cpId?: unknown; cpLinked?: unknown }) {
  return {
    sqmL: optionalNumber(l.sqmL),
    sqmW: optionalNumber(l.sqmW),
    pieces: optionalNumber(l.pieces),
    cpId: optionalSourceId(l.cpId),
    cpLinked: optionalBoolean(l.cpLinked),
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * A date the caller may set. Returns undefined when the caller did not supply
 * the field at all, null for "clear it", and the ISO string otherwise.
 * A non-ISO value is REFUSED — never reinterpreted. "14/03/2025" could equally
 * be 14 March or (in another DateStyle) an invalid month, and silently guessing
 * would put a wrong date on a customer-facing document.
 */
function validateOptionalDate(value: unknown, label: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const t = String(value).trim();
  if (t === '') return null;
  if (!ISO_DATE.test(t)) {
    throw new BusinessRuleError(
      `${label} is not a valid date ("${String(value).slice(0, 40)}"). Please select the date again before saving.`
    );
  }
  const [y, m, d] = t.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw new BusinessRuleError(
      `${label} is not a real calendar date ("${t}"). Please select the date again before saving.`
    );
  }
  return t;
}

/**
 * A number the caller may set, checked against the COLUMN's real range so an
 * out-of-range value is a readable refusal rather than a raw 22003.
 */
function validateOptionalNumber(
  value: unknown, label: string, opts: { min: number; max: number; allowBlank?: boolean }
): number | undefined {
  if (value === undefined) return undefined;
  if (value === null || String(value).trim() === '') {
    if (opts.allowBlank) return 0;
    return undefined;
  }
  const n = Number(String(value).trim());
  if (!Number.isFinite(n)) {
    throw new BusinessRuleError(`${label} must be a number ("${String(value).slice(0, 40)}").`);
  }
  if (n < opts.min || n > opts.max) {
    throw new BusinessRuleError(
      `${label} must be between ${opts.min} and ${opts.max} — got ${n}. Please correct it before saving.`
    );
  }
  return n;
}

// Column ranges, from 007_relational_core.sql / 013_quote_line_dimensions.sql.
const RANGE_MONEY = { min: -99999999.99, max: 99999999.99 };        // NUMERIC(14,2)
const RANGE_RATE = { min: -9999999999.9999, max: 9999999999.9999 }; // NUMERIC(14,4)
const RANGE_DISCOUNT = { min: -999.999, max: 999.999 };             // NUMERIC(6,3)
const RANGE_PIECES = { min: 0, max: 9999999999.9999 };

/** Strips NUL bytes, which Postgres rejects outright (22021) in any text column. */
function sanitizeText(v: unknown): any {
  if (typeof v !== 'string') return v;
  return v.indexOf('\u0000') === -1 ? v : v.replace(/\u0000/g, '');
}

/**
 * Validates every quote line BEFORE any SQL runs, so a bad line can never
 * half-write a quote and can never reach the user as "Internal error".
 */
function validateLines(lines: any[] | undefined, label: string): void {
  if (lines === undefined) return;
  if (!Array.isArray(lines)) throw new BusinessRuleError(`${label} must be a list of lines.`);
  lines.forEach((l, i) => {
    if (!l || typeof l !== 'object') throw new BusinessRuleError(`${label}: line ${i + 1} is empty or malformed.`);
    validateOptionalNumber(l.qty, `${label}: line ${i + 1} quantity`, RANGE_RATE);
    validateOptionalNumber(l.unitPrice, `${label}: line ${i + 1} unit price`, RANGE_RATE);
    validateOptionalNumber(l.sqmL, `${label}: line ${i + 1} length`, RANGE_RATE);
    validateOptionalNumber(l.sqmW, `${label}: line ${i + 1} width`, RANGE_RATE);
    validateOptionalNumber(l.pieces, `${label}: line ${i + 1} pieces`, RANGE_PIECES);
    const sub = lineSubtotal(l.pieces, l.qty, l.unitPrice);
    if (!Number.isFinite(sub) || sub < RANGE_MONEY.min || sub > RANGE_MONEY.max) {
      throw new BusinessRuleError(
        `${label}: line ${i + 1} totals ${sub} — that is outside the range this system can store. Please check the quantity, pieces and unit price.`
      );
    }
  });
}

/**
 * Header-level validation shared by create and both update paths. It also
 * NORMALISES in place — validating without normalising was not enough: a
 * whitespace-only date passes the check (it means "clear it") but the caller
 * would then still bind the original "   " into a DATE column and get a raw
 * 22007. The value that was validated must be the value that gets written.
 */
function validateQuoteHeader(input: any, label = 'Quote'): void {
  if (!input || typeof input !== 'object') return;
  const d = validateOptionalDate(input.quoteDate, 'Quote date');
  if (d !== undefined) input.quoteDate = d;
  const v = validateOptionalDate(input.validUntil, 'Valid until');
  if (v !== undefined) input.validUntil = v;
  validateOptionalNumber(input.discountPct, 'Discount %', RANGE_DISCOUNT);
  validateOptionalNumber(input.setupFee, 'Setup fee', RANGE_MONEY);
  if (typeof input.notes === 'string') input.notes = sanitizeText(input.notes);
  if (typeof input.reference === 'string') input.reference = sanitizeText(input.reference);
  if (typeof input.poRef === 'string') input.poRef = sanitizeText(input.poRef);
  validateLines(input.lines, label);
}

/** Refuses a customerId that does not exist, instead of letting FK 23503 500. */
async function assertCustomerExists(client: PoolClient, customerId: unknown): Promise<void> {
  if (customerId === null || customerId === undefined || customerId === '') return;
  const n = Number(customerId);
  if (!Number.isFinite(n)) throw new BusinessRuleError(`Customer reference "${String(customerId).slice(0, 40)}" is not valid.`);
  const res = await client.query('SELECT 1 FROM rel_customers WHERE id = $1', [n]);
  if (res.rowCount === 0) {
    throw new BusinessRuleError(`The selected customer (id ${n}) no longer exists. Please re-select the customer before saving.`);
  }
}

async function resolveInventoryRef(
  client: PoolClient,
  itemId: unknown
): Promise<{ fk: number | null; sourceId: string | null }> {
  if (itemId === null || itemId === undefined || itemId === '') return { fk: null, sourceId: null };
  const asText = String(itemId).trim();
  if (!asText) return { fk: null, sourceId: null };

  const bySource = await client.query(
    'SELECT id, source_id FROM rel_inventory_items WHERE source_id = $1 LIMIT 1',
    [asText]
  );
  if (bySource.rowCount) return { fk: Number(bySource.rows[0].id), sourceId: bySource.rows[0].source_id };

  // Only worth a PK probe when the value could actually BE a bigint PK. The
  // length bound matters: /^\d+$/ constrains the SHAPE but not the MAGNITUDE, and
  // a 20+ digit id (historical JS ids are timestamp-derived and long) cast to
  // bigint raises 22003 numeric_value_out_of_range — another opaque 500 from the
  // very helper written to stop them. 18 digits is comfortably inside bigint's
  // range and far beyond any real PK this schema will issue.
  if (/^\d{1,18}$/.test(asText)) {
    const byPk = await client.query(
      'SELECT id, source_id FROM rel_inventory_items WHERE id = $1::bigint LIMIT 1',
      [asText]
    );
    if (byPk.rowCount) return { fk: Number(byPk.rows[0].id), sourceId: byPk.rows[0].source_id };
  }

  // Unknown/removed item: keep the caller's id as a breadcrumb in
  // inventory_source_id (so nothing is silently lost and a later re-link is
  // possible) but never risk a FK violation.
  return { fk: null, sourceId: asText };
}

async function replaceQuoteLinesTx(client: PoolClient, quoteId: number, lines: LineItemPatch[]): Promise<number> {
  await client.query('DELETE FROM rel_quote_line_items WHERE quote_id = $1', [quoteId]);
  let subtotal = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const qty = Number(l.qty) || 0;
    const unitPrice = Number(l.unitPrice) || 0;
    const thisLineSubtotal = lineSubtotal(l.pieces, qty, unitPrice);
    subtotal += thisLineSubtotal;
    const inv = await resolveInventoryRef(client, l.itemId);
    const ex = lineExtras(l as any);
    await client.query(
      `INSERT INTO rel_quote_line_items (quote_id, line_index, description, qty, unit_price, unit, subtotal, inventory_item_id, inventory_source_id,
         sqm_l, sqm_w, pieces, complete_product_source_id, complete_product_linked, legacy_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'{}'::jsonb)`,
      [quoteId, i, sanitizeText(l.desc) ?? null, qty, unitPrice, sanitizeText(l.unit) ?? null, thisLineSubtotal, inv.fk, inv.sourceId,
       ex.sqmL, ex.sqmW, ex.pieces, ex.cpId, ex.cpLinked]
    );
  }
  return subtotal;
}

async function replaceJobLinesTx(client: PoolClient, jobId: number, lines: LineItemPatch[]): Promise<void> {
  await client.query('DELETE FROM rel_job_line_items WHERE job_id = $1', [jobId]);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const qty = Number(l.qty) || 0;
    const unitPrice = Number(l.unitPrice) || 0;
    const inv = await resolveInventoryRef(client, l.itemId);
    const ex = lineExtras(l as any);
    await client.query(
      `INSERT INTO rel_job_line_items (job_id, line_index, description, qty, unit_price, unit, subtotal, inventory_item_id, inventory_source_id,
         sqm_l, sqm_w, pieces, complete_product_source_id, complete_product_linked, legacy_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'{}'::jsonb)`,
      [jobId, i, sanitizeText(l.desc) ?? null, qty, unitPrice, sanitizeText(l.unit) ?? null,
       lineSubtotal(l.pieces, qty, unitPrice), inv.fk, inv.sourceId,
       ex.sqmL, ex.sqmW, ex.pieces, ex.cpId, ex.cpLinked]
    );
  }
}

// Exact formula from CreateQuoteModal/QuotesPage — never independently
// stored, always recomputed from subtotal/discount/setupFee.
function computeQuoteTotals(subtotal: number, discountPct: number, setupFee: number): { subtotal: number; vat: number; total: number } {
  const discAmt = subtotal * ((discountPct || 0) / 100);
  const afterDisc = subtotal - discAmt + (setupFee || 0);
  const vat = afterDisc * 0.15;
  const total = afterDisc + vat;
  return { subtotal, vat, total };
}

// ── UPDATE QUOTE / UPDATE JOB — Stage 2 addition, extended in Stage 3 ───────
// Generic, non-cascading field-patch updates, added for Stage 2's frontend
// wiring (Phase 4): "quote creation" and "quote -> job conversion" already
// had dedicated services above (createQuote / convertQuoteToJob), but a
// PLAIN EDIT to an existing quote or job (notes, line items, discount,
// contact details, stage/status) had no relational equivalent yet.
//
// STAGE 3 (2026-08-20): now transactional (was a single atomic UPDATE before)
// so that a `lines` replace (a second table) and the row's own column patch
// commit together — a lines failure never leaves the patch half-applied.
// Also now supports:
//   - quotes: `lines` (replaces rel_quote_line_items, recomputes
//     subtotal/vat/total server-side from the new lines + resulting
//     discount/setupFee — exactly CreateQuoteModal's formula, never trusted
//     from the client).
//   - jobs: `lines` (JobDetail's saveLines(), a completely independent save
//     from cost-breakdown/notes/stage) and `breakdown` (JobDetail's
//     saveCosts(), the fixed 9-key cost object — migration 008 column).
// Still does NOT reproduce the quote<->job CASCADE (editing a quote syncing
// its linked job) — see updateQuoteWithJobSync below for that; this
// function only ever persists the ONE record's own fields/lines.
export interface QuotePatchInput {
  customerNameRaw?: string; contactPerson?: string | null; email?: string | null;
  phone?: string | null; address?: string | null; vatNumber?: string | null;
  status?: string | null; notes?: string | null; terms?: string | null;
  salesperson?: string | null; preparedBy?: string | null; poRef?: string | null;
  reference?: string | null; setupFee?: number; discountPct?: number;
  proformaNum?: string | null;
  // migration 012 (2026-08-24) — "Quote Date" / "Valid Until" are captured by
  // the Quote form but had no relational column, so they were lost on every
  // post-cutover quote. See 012_post_migration_stabilization.sql.
  quoteDate?: string | null; validUntil?: string | null;
  lines?: LineItemPatch[];
}
export async function updateQuote(id: number, expectedVersion: number, patch: Partial<QuotePatchInput>): Promise<{ rowVersion: number }> {
  validateQuoteHeader(patch, 'Quote');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const curRes = await client.query('SELECT * FROM rel_quotes WHERE id = $1 FOR UPDATE', [id]);
    if (curRes.rowCount === 0) throw new BusinessRuleError(`quote ${id} not found`);
    const cur = curRes.rows[0];
    if (cur.row_version !== expectedVersion) throw new ConcurrencyConflictError('rel_quotes', id);

    const colMap: Record<string, string> = {
      customerNameRaw: 'customer_name_raw', contactPerson: 'contact_person', email: 'email',
      phone: 'phone', address: 'address', vatNumber: 'vat_number', status: 'status',
      notes: 'notes', terms: 'terms', salesperson: 'salesperson', preparedBy: 'prepared_by',
      poRef: 'po_ref', reference: 'reference', setupFee: 'setup_fee', discountPct: 'discount_pct',
      // migration 012 (2026-08-24) — see 012_post_migration_stabilization.sql.
      quoteDate: 'quote_date', validUntil: 'valid_until',
      // 2026-08-24: the Print/Email Proforma actions reserve a PRO-##### number
      // and must persist it on the quote. rel_quotes.proforma_num has existed
      // since 007, but no relational write path exposed it — so once "quotes"
      // was cut over, ensureProformaNumber's JSON save was refused by the
      // write-authority guard and BOTH proforma actions became dead, burning a
      // reserved number on every attempt. Only in updateQuote (the plain,
      // non-cascading patch), never in updateQuoteWithJobSync: reserving a
      // proforma number must not cascade anything onto a linked job.
      proformaNum: 'proforma_num',
    };
    const sets: string[] = []; const vals: any[] = [];
    for (const [k, col] of Object.entries(colMap)) {
      if ((patch as any)[k] !== undefined) { vals.push(normalizeColumnValue(col, (patch as any)[k])); sets.push(`${col} = $${vals.length}`); }
    }

    let subtotal = Number(cur.subtotal);
    if (Array.isArray(patch.lines)) {
      subtotal = await replaceQuoteLinesTx(client, id, patch.lines);
    }
    const recomputeNeeded = Array.isArray(patch.lines) || patch.discountPct !== undefined || patch.setupFee !== undefined;
    if (recomputeNeeded) {
      const discountPct = patch.discountPct !== undefined ? Number(patch.discountPct) : Number(cur.discount_pct);
      const setupFee = patch.setupFee !== undefined ? Number(patch.setupFee) : Number(cur.setup_fee);
      const totals = computeQuoteTotals(subtotal, discountPct, setupFee);
      vals.push(totals.subtotal); sets.push(`subtotal = $${vals.length}`);
      vals.push(totals.vat); sets.push(`vat_amount = $${vals.length}`);
      vals.push(totals.total); sets.push(`total = $${vals.length}`);
    }

    if (sets.length === 0) {
      await client.query('COMMIT');
      return { rowVersion: cur.row_version };
    }
    vals.push(id); const idIdx = vals.length;
    const res = await client.query(
      `UPDATE rel_quotes SET ${sets.join(', ')}, row_version = row_version + 1, updated_at = NOW() WHERE id = $${idIdx} RETURNING row_version`,
      vals
    );
    await client.query('COMMIT');
    return { rowVersion: res.rows[0].row_version };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export interface JobPatchInput {
  customerNameRaw?: string; contactPerson?: string | null; email?: string | null;
  phone?: string | null; address?: string | null; vatNumber?: string | null;
  description?: string | null; status?: string | null; stage?: number;
  setupFee?: number; discountPct?: number; salesperson?: string | null;
  preparedBy?: string | null; poRef?: string | null; reference?: string | null;
  notes?: string | null; value?: number;
  // 010_job_writeoff_duedate.sql (2026-08-23 save-authority audit) — two
  // previously JSON-only-and-unwired active Job features, now given a real
  // relational column each. writeOff is 'warranty' | 'maintenance' | null;
  // dueDate is a plain YYYY-MM-DD string (the job's own scheduling due
  // date, distinct from invoiceDate/invoiceDue).
  writeOff?: string | null;
  dueDate?: string | null;
  breakdown?: Record<string, number>;
  lines?: LineItemPatch[];
  // ── migration 012 (2026-08-24) — BUG 5: JOB PROGRESSION WITHOUT PAYMENT ────
  // BUSINESS RULE CORRECTION. A job may progress past "Deposit Received" even
  // when no deposit has been received (clients pay upfront, during production,
  // on completion, or after). Setting this to true records that a user
  // explicitly chose "Continue without payment" for this job. It is a lifecycle
  // decision ONLY: it creates no payment, changes no value/total, never marks
  // an invoice paid, and deliberately does NOT touch invoice_status — which
  // keeps reporting the true payment position ('pending' while nothing has been
  // received). Deposit_waived_at/_by are stamped by the service, not the
  // caller, so the record of WHEN and BY WHOM cannot be back-dated by a client.
  depositWaived?: boolean;
  // Set by api.ts from the AUTHENTICATED session, never from the request body —
  // attribution for a financial-control override must not be client-supplied.
  depositWaivedBy?: string | null;
}
export async function updateJob(id: number, expectedVersion: number, patch: Partial<JobPatchInput>): Promise<{ rowVersion: number }> {
  // 2026-08-24 — job lines carry the same dimensions/pieces columns quote
  // lines do (migration 013), so they need the same before-any-SQL validation:
  // an out-of-range piece count or price must reach the user as a sentence,
  // never as a raw NUMERIC overflow surfacing as "Internal error".
  validateLines(patch.lines as any[] | undefined, 'Job');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const curRes = await client.query('SELECT row_version FROM rel_jobs WHERE id = $1 FOR UPDATE', [id]);
    if (curRes.rowCount === 0) throw new BusinessRuleError(`job ${id} not found`);
    if (curRes.rows[0].row_version !== expectedVersion) throw new ConcurrencyConflictError('rel_jobs', id);

    const colMap: Record<string, string> = {
      customerNameRaw: 'customer_name_raw', contactPerson: 'contact_person', email: 'email',
      phone: 'phone', address: 'address', vatNumber: 'vat_number', description: 'description',
      status: 'status', stage: 'stage', setupFee: 'setup_fee', discountPct: 'discount_pct',
      salesperson: 'salesperson', preparedBy: 'prepared_by', poRef: 'po_ref',
      reference: 'reference', notes: 'notes', value: 'value',
      // 010_job_writeoff_duedate.sql (2026-08-23 save-authority audit)
      writeOff: 'write_off', dueDate: 'due_date',
    };
    const sets: string[] = []; const vals: any[] = [];
    for (const [k, col] of Object.entries(colMap)) {
      if ((patch as any)[k] !== undefined) { vals.push(normalizeColumnValue(col, (patch as any)[k])); sets.push(`${col} = $${vals.length}`); }
    }
    if (patch.breakdown !== undefined) {
      vals.push(JSON.stringify(patch.breakdown)); sets.push(`breakdown = $${vals.length}::jsonb`);
    }
    // migration 012 — BUG 5. Kept out of colMap on purpose: the flag and its
    // audit stamps must move together, and the stamps are server-generated.
    if (patch.depositWaived !== undefined) {
      const waived = patch.depositWaived === true;
      vals.push(waived); sets.push(`deposit_waived = $${vals.length}`);
      if (waived) {
        // COALESCE so re-saving an already-waived job keeps the ORIGINAL
        // decision time rather than sliding it forward on every later edit.
        sets.push(`deposit_waived_at = COALESCE(deposit_waived_at, NOW())`);
        vals.push(patch.depositWaivedBy ?? null);
        sets.push(`deposit_waived_by = COALESCE(deposit_waived_by, $${vals.length})`);
      } else {
        // Clearing the override clears its audit stamps too — leaving a
        // "waived by X at T" on a job that is no longer waived would be a
        // false record.
        sets.push(`deposit_waived_at = NULL`);
        sets.push(`deposit_waived_by = NULL`);
      }
    }
    // A lines-only save (JobDetail's saveLines(), no scalar column touched)
    // must STILL bump row_version — otherwise a caller has no way to detect
    // via optimistic concurrency that the job actually changed. Tracked
    // separately from `sets` because line items live in a different table.
    const linesChanged = Array.isArray(patch.lines);
    if (linesChanged) {
      await replaceJobLinesTx(client, id, patch.lines!);
    }

    if (sets.length === 0 && !linesChanged) {
      await client.query('COMMIT');
      return { rowVersion: curRes.rows[0].row_version };
    }
    vals.push(id); const idIdx = vals.length;
    const setClause = sets.length ? sets.join(', ') + ', ' : '';
    const res = await client.query(
      `UPDATE rel_jobs SET ${setClause}row_version = row_version + 1, updated_at = NOW() WHERE id = $${idIdx} RETURNING row_version`,
      vals
    );
    await client.query('COMMIT');
    return { rowVersion: res.rows[0].row_version };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// FINAL CUTOVER BLOCKER COMPLETION (2026-08-22): jobs had no relational
// delete at all — index.html's deleteJob() was unconditionally JSON-only,
// so once "jobs" cut over the delete button would silently fail to persist
// (the job reappears on reload). Mirrors the JSON path's behavior exactly:
// unlink any quote that was converted into this job (revert 'converted'
// back to 'approved', clear the FK, free the quote_conversions guard row so
// the quote could be converted again) and drop the job's own payment
// history (rel_payments.owner_id is deliberately NOT an FK — polymorphic —
// so it is never touched by ON DELETE CASCADE and must be cleared
// explicitly, matching the JSON path's own warning that deleting a job
// discards its payment history too). A job that already has an invoice or
// purchase order referencing it (rel_invoices.job_id / rel_purchase_orders.job_id,
// both real FKs, no cascade) is refused with a clear business-rule message —
// a deliberate tightening vs. the JSON path (which allowed this silently),
// consistent with how deleteSupplier/deleteInventoryItem already refuse
// deletes that would orphan a real FK elsewhere in this codebase.
export async function deleteJob(
  id: number,
  expectedVersion: number
): Promise<{ deleted: true; unlinkedQuotes: Array<{ id: number; rowVersion: number; status: string }> }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const curRes = await client.query('SELECT row_version FROM rel_jobs WHERE id = $1 FOR UPDATE', [id]);
    if (curRes.rowCount === 0) throw new BusinessRuleError(`job ${id} not found`);
    if (curRes.rows[0].row_version !== expectedVersion) throw new ConcurrencyConflictError('rel_jobs', id);

    // POST-MIGRATION STABILIZATION (2026-08-24) — same stale-version class as
    // convertQuoteToJob above: unlinking bumps the QUOTE's row_version, but the
    // caller was never told, so the reverted quote became unsaveable (409
    // stale_record) until a full page reload. The affected quotes and their new
    // versions/statuses are now reported back so the frontend can keep its
    // `_relRowVersion` in step. Behavior of the unlink itself is unchanged.
    const unlinkedQuotes: Array<{ id: number; rowVersion: number; status: string }> = [];
    const linkedQuoteRes = await client.query(`SELECT id FROM rel_quotes WHERE converted_job_id = $1 FOR UPDATE`, [id]);
    for (const q of linkedQuoteRes.rows) {
      const upd = await client.query(
        `UPDATE rel_quotes SET converted_job_id = NULL, converted_job_source_id = NULL,
           status = CASE WHEN status = 'converted' THEN 'approved' ELSE status END,
           row_version = row_version + 1, updated_at = NOW()
         WHERE id = $1 RETURNING row_version, status`,
        [q.id]
      );
      unlinkedQuotes.push({ id: Number(q.id), rowVersion: upd.rows[0].row_version, status: upd.rows[0].status });
      await client.query(`DELETE FROM quote_conversions WHERE quote_id = $1`, [`rel:${q.id}`]);
    }

    await client.query(`DELETE FROM rel_payments WHERE owner_type = 'job' AND owner_id = $1`, [id]);

    try {
      await client.query('DELETE FROM rel_jobs WHERE id = $1', [id]);
    } catch (err: any) {
      if (err && err.code === '23503') {
        throw new BusinessRuleError('This job cannot be deleted — an invoice or purchase order is still linked to it. Remove those first.');
      }
      throw err;
    }

    await client.query('COMMIT');
    return { deleted: true, unlinkedQuotes };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ── QUOTE EDIT WITH LINKED-JOB SYNC — Stage 3 Phase 3 ───────────────────────
// Reproduces index.html QuotesPage.handleSave's cascade EXACTLY: when a
// quote linked to a job (quote.converted_job_id) is edited, the job's
// display fields are unconditionally overwritten from the QUOTE's resulting
// (post-this-save) values — lines, discount, setupFee, value=(afterDisc*
// 1.15), client/contact/email/tel/address/vatNum, and notes (the ONE field
// with a job-side fallback: `q.notes||j.notes||''`). status/convertedJobId
// are never touched by this function (not in the patchable field list) —
// only convertQuoteToJob/dedicated transitions own those, exactly matching
// the JSON stale-save guard's intent (a plain edit payload can never revert
// a conversion).
//
// ATOMICITY: one transaction — lock quote, lock linked job (optimistic
// version check on BOTH if the caller supplies expectedJobVersion), apply
// quote patch + lines, recompute quote totals, cascade onto the job, commit.
// A failure at any point rolls back both — "quote saved but job sync
// failed" can never happen.
export interface QuoteJobSyncResult {
  quoteRowVersion: number;
  jobId: number | null;
  jobRowVersion: number | null;
}
export async function updateQuoteWithJobSync(
  quoteId: number,
  expectedQuoteVersion: number,
  patch: Partial<QuotePatchInput>,
  opts: { expectedJobVersion?: number; resyncJobLines?: boolean } = {}
): Promise<QuoteJobSyncResult> {
  validateQuoteHeader(patch, 'Quote');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const quoteRes = await client.query('SELECT * FROM rel_quotes WHERE id = $1 FOR UPDATE', [quoteId]);
    if (quoteRes.rowCount === 0) throw new BusinessRuleError(`quote ${quoteId} not found`);
    const quote = quoteRes.rows[0];
    if (quote.row_version !== expectedQuoteVersion) throw new ConcurrencyConflictError('rel_quotes', quoteId);

    // status/convertedJobId deliberately NOT in this colMap — see header.
    const colMap: Record<string, string> = {
      customerNameRaw: 'customer_name_raw', contactPerson: 'contact_person', email: 'email',
      phone: 'phone', address: 'address', vatNumber: 'vat_number',
      notes: 'notes', terms: 'terms', salesperson: 'salesperson', preparedBy: 'prepared_by',
      poRef: 'po_ref', reference: 'reference', setupFee: 'setup_fee', discountPct: 'discount_pct',
      // migration 012 (2026-08-24) — see updateQuote's identical entry.
      quoteDate: 'quote_date', validUntil: 'valid_until',
    };
    const sets: string[] = []; const vals: any[] = [];
    for (const [k, col] of Object.entries(colMap)) {
      if ((patch as any)[k] !== undefined) { vals.push(normalizeColumnValue(col, (patch as any)[k])); sets.push(`${col} = $${vals.length}`); }
    }

    let subtotal = Number(quote.subtotal);
    let finalLines: LineItemPatch[] | null = null;
    if (Array.isArray(patch.lines)) {
      subtotal = await replaceQuoteLinesTx(client, quoteId, patch.lines);
      finalLines = patch.lines;
    }
    const discountPct = patch.discountPct !== undefined ? Number(patch.discountPct) : Number(quote.discount_pct);
    const setupFee = patch.setupFee !== undefined ? Number(patch.setupFee) : Number(quote.setup_fee);
    const totals = computeQuoteTotals(subtotal, discountPct, setupFee);
    vals.push(totals.subtotal); sets.push(`subtotal = $${vals.length}`);
    vals.push(totals.vat); sets.push(`vat_amount = $${vals.length}`);
    vals.push(totals.total); sets.push(`total = $${vals.length}`);

    vals.push(quoteId); const idIdx = vals.length;
    const quoteUpdateRes = await client.query(
      `UPDATE rel_quotes SET ${sets.join(', ')}, row_version = row_version + 1, updated_at = NOW() WHERE id = $${idIdx} RETURNING row_version`,
      vals
    );
    const quoteRowVersion = quoteUpdateRes.rows[0].row_version;

    let jobId: number | null = null;
    let jobRowVersion: number | null = null;
    if (quote.converted_job_id) {
      const linkedJobId: number = Number(quote.converted_job_id);
      jobId = linkedJobId;
      const jobRes = await client.query('SELECT * FROM rel_jobs WHERE id = $1 FOR UPDATE', [linkedJobId]);
      if (jobRes.rowCount === 0) {
        throw new BusinessRuleError(`quote ${quoteId} links to job ${linkedJobId} which no longer exists — refusing to proceed with a half-synced state`);
      }
      const job = jobRes.rows[0];
      if (opts.expectedJobVersion !== undefined && job.row_version !== opts.expectedJobVersion) {
        throw new ConcurrencyConflictError('rel_jobs', linkedJobId);
      }

      // ── BLOCKER 2 (2026-08-24) — a quote edit must NOT rewrite the job's
      // own line items. Quote lines INITIALISE the job at conversion; after
      // that, production owns them: the Job page has its own line editor
      // writing this same table. This cascade used to fire whenever the patch
      // carried `lines` — and the shipped edit patch ALWAYS carries lines
      // (index.html ~8996 is unconditional), so changing a phone number on the
      // quote silently deleted every production line added since conversion.
      // Reproduced before this fix: 3 job lines -> 1.
      //
      // The cascade is now an EXPLICIT action only. Nothing infers a resync
      // from the mere fact that a quote was saved. `opts.resyncJobLines` is the
      // one way to ask for it, and the job's row_version is still asserted
      // exactly as before, so an explicit resync remains concurrency-safe.
      if (finalLines && opts.resyncJobLines === true) {
        await replaceJobLinesTx(client, linkedJobId, finalLines);
      }

      // Resulting (post-this-save) quote field values — whether from THIS
      // patch or preserved unchanged — mirrors `q.contact||''` etc. in the
      // real cascade, where `q` is the full merged quote object, not just
      // the fields touched in this one save.
      const resultClient = patch.customerNameRaw !== undefined ? patch.customerNameRaw : quote.customer_name_raw;
      const resultContact = (patch.contactPerson !== undefined ? patch.contactPerson : quote.contact_person) || '';
      const resultEmail = (patch.email !== undefined ? patch.email : quote.email) || '';
      const resultPhone = (patch.phone !== undefined ? patch.phone : quote.phone) || '';
      const resultAddress = (patch.address !== undefined ? patch.address : quote.address) || '';
      const resultVat = (patch.vatNumber !== undefined ? patch.vatNumber : quote.vat_number) || '';

      // ── POST-MIGRATION STABILIZATION (2026-08-24) — BUG 4 ROOT CAUSE ───────
      // "Notes deleted at the top of the Job page come back after refresh."
      //
      // The old expression was
      //     (patch.notes !== undefined ? patch.notes : quote.notes) || job.notes || ''
      // and it was written UNCONDITIONALLY into rel_jobs.notes on every quote
      // save. Two separate defects lived in that one line:
      //
      //   (a) The `|| job.notes` fallback made notes a one-way ratchet. Once a
      //       job had a note, clearing the QUOTE's note could never clear the
      //       job's — the job's own previous text was substituted straight back
      //       in. Notes could only ever be added, never removed.
      //   (b) Because it ran on EVERY quote save, editing something completely
      //       unrelated (a line item, the discount, the reference) re-pushed the
      //       quote's notes onto the job. That is the actual reported symptom:
      //       the user clears Special Notes on the Job page — which persists
      //       correctly, saveNotes() sends notes:'' and updateJob writes '' —
      //       then anyone touches the source quote for any reason, and the old
      //       text is written back over the cleared field. On the next refresh
      //       the "deleted" note is there again, with no save of its own to
      //       explain it.
      //
      // Corrected rule: the job's notes are part of the cascade ONLY when the
      // quote's notes actually CHANGED in this save. An unchanged quote note
      // never touches the job (so a job-side clear stays cleared), and a quote
      // note cleared to '' now propagates as '' (so a quote-side clear works
      // too). Nothing else about the cascade changes — the display fields below
      // are still overwritten from the quote exactly as before, because those
      // ARE quote-owned; `notes` is the one field the Job legitimately owns its
      // own copy of, which is why it was the only one with a job-side fallback
      // in the first place.
      const quoteNotesBefore = quote.notes == null ? '' : String(quote.notes);
      const quoteNotesAfter = patch.notes !== undefined
        ? (patch.notes == null ? '' : String(patch.notes))
        : quoteNotesBefore;
      const quoteNotesChanged = quoteNotesAfter !== quoteNotesBefore;
      const jobNotesCurrent = job.notes == null ? '' : String(job.notes);
      const resultNotes = quoteNotesChanged ? quoteNotesAfter : jobNotesCurrent;

      const _afterDisc = totals.subtotal - totals.subtotal * ((discountPct || 0) / 100) + (setupFee || 0);
      const jobValue = _afterDisc * 1.15;

      // BUG 2 (same root cause as convertQuoteToJob): the cascade kept the
      // job's client/contact/email/tel/address/VAT in step with the quote but
      // never propagated salesperson / preparedBy / poRef / reference, so a
      // quote edit that changed those left the job showing the old values (or,
      // for a job converted before this pass, no value at all). Added here so
      // the conversion-time copy and the edit-time cascade agree on exactly the
      // same field set — one contract, one place.
      const resultSalesperson = (patch.salesperson !== undefined ? patch.salesperson : quote.salesperson) ?? null;
      const resultPreparedBy = (patch.preparedBy !== undefined ? patch.preparedBy : quote.prepared_by) ?? null;
      const resultPoRef = (patch.poRef !== undefined ? patch.poRef : quote.po_ref) ?? null;
      const resultReference = (patch.reference !== undefined ? patch.reference : quote.reference) ?? null;

      const jobUpdateRes = await client.query(
        `UPDATE rel_jobs SET
           discount_pct = $1, setup_fee = $2, value = $3,
           customer_name_raw = $4, contact_person = $5, email = $6, phone = $7, address = $8, vat_number = $9,
           notes = $10,
           salesperson = $12, prepared_by = $13, po_ref = $14, reference = $15,
           row_version = row_version + 1, updated_at = NOW()
         WHERE id = $11
         RETURNING row_version`,
        [discountPct || 0, setupFee || 0, jobValue, resultClient, resultContact, resultEmail, resultPhone, resultAddress, resultVat, resultNotes, jobId,
         resultSalesperson, resultPreparedBy, resultPoRef, resultReference]
      );
      jobRowVersion = jobUpdateRes.rows[0].row_version;
    }

    await client.query('COMMIT');
    return { quoteRowVersion, jobId, jobRowVersion };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ── CREDIT NOTES — Stage 3 Phase 6 ──────────────────────────────────────────
// Numbering via the atomic 'creditNote' doc type (documentNumbers.ts) —
// never a frontend max()+1 scan. FIFO/LIFO application semantics live in
// recordPayment/deletePayment above (there is no separate "apply" table —
// used_amount on this one row IS the application state, exactly like JSON).
export interface CreditNoteInput {
  // 2026-08-23 (credit note company-isolation repair): companyCode is
  // REQUIRED, matching createManualInvoice's own companyCode requirement
  // — see the API route's validation, which mirrors that same convention
  // rather than inventing a stricter (or looser) rule for this one
  // section. Persisted into rel_credit_notes.company_code (migration 011)
  // and read back as a real number via read.ts's coNum(), exactly like
  // quotes/jobs/accInvoices/purchaseOrders. Never re-derivable from
  // legacy_data on a brand-new note (there is none yet), so it must be
  // supplied here, not defaulted.
  companyCode: string;
  type: 'customer' | 'supplier';
  contactName: string;
  date?: string | null;
  amount: number;
  reason?: string | null;
  appliedTo?: string | null;
  notes?: string | null;
  status?: string | null;
}
export async function createCreditNote(input: CreditNoteInput): Promise<{ id: number; creditNumber: string; rowVersion: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const creditNumber = await reserveDocumentNumberWithClient(client, 'ALL', 'creditNote' as any);
    const res = await client.query(
      `WITH new_id AS (SELECT nextval('rel_credit_notes_id_seq') AS id)
       INSERT INTO rel_credit_notes (id, source_id, credit_number, note_type, contact_name_raw, note_date, amount, used_amount, reason, applied_to, notes, status, company_code, legacy_data)
       SELECT new_id.id, new_id.id::text, $1, $2, $3, $4, $5, 0, $6, $7, $8, $9, $10, '{}'::jsonb FROM new_id
       RETURNING id, row_version`,
      [creditNumber, input.type, input.contactName, input.date || null, input.amount, input.reason ?? null, input.appliedTo ?? null, input.notes ?? null, input.status ?? 'active', input.companyCode]
    );
    await client.query('COMMIT');
    return { id: res.rows[0].id, creditNumber, rowVersion: res.rows[0].row_version };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export interface CreditNotePatchInput {
  contactName?: string; date?: string | null; amount?: number; reason?: string | null;
  appliedTo?: string | null; notes?: string | null; status?: string | null;
}
export async function updateCreditNote(id: number, expectedVersion: number, patch: Partial<CreditNotePatchInput>): Promise<{ rowVersion: number }> {
  // 2026-08-23 (credit note company-isolation repair): companyCode is
  // deliberately NOT in colMap and CreditNotePatchInput has no companyCode
  // field at all — company ownership is set once at creation and is
  // immutable thereafter, matching how no other section's update path
  // (updateQuote/updateJob/updateInvoice/updatePurchaseOrder) ever accepts
  // a companyCode patch either. Even if a caller's req.body included a
  // stray companyCode/company_code key, the colMap-driven SET list below
  // only ever includes keys present in colMap, so it is silently ignored,
  // never applied — a Holdings credit note can never be silently
  // reassigned to Original (or vice versa) through an edit.
  const colMap: Record<string, string> = {
    contactName: 'contact_name_raw', date: 'note_date', amount: 'amount', reason: 'reason',
    appliedTo: 'applied_to', notes: 'notes', status: 'status',
  };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const curRes = await client.query('SELECT row_version FROM rel_credit_notes WHERE id = $1 FOR UPDATE', [id]);
    if (curRes.rowCount === 0) throw new BusinessRuleError(`credit note ${id} not found`);
    if (curRes.rows[0].row_version !== expectedVersion) throw new ConcurrencyConflictError('rel_credit_notes', id);
    const sets: string[] = []; const vals: any[] = [];
    for (const [k, col] of Object.entries(colMap)) {
      if ((patch as any)[k] !== undefined) { vals.push(normalizeColumnValue(col, (patch as any)[k])); sets.push(`${col} = $${vals.length}`); }
    }
    if (sets.length === 0) { await client.query('COMMIT'); return { rowVersion: curRes.rows[0].row_version }; }
    vals.push(id); const idIdx = vals.length;
    const res = await client.query(
      `UPDATE rel_credit_notes SET ${sets.join(', ')}, row_version = row_version + 1, updated_at = NOW() WHERE id = $${idIdx} RETURNING row_version`,
      vals
    );
    await client.query('COMMIT');
    return { rowVersion: res.rows[0].row_version };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// Physical delete, matching JSON's admin-only array-filter removal — with
// ONE deliberate additive safety check beyond JSON parity: refuses to delete
// a note with used_amount > 0. JSON never had a relational credit-note path
// at all (this is new code, not a "fix" to something already shipped), and
// a physical delete of a note still funding a live Credit payment would
// leave that payment's attribution unrecoverable with no relational link to
// reconstruct it from — flagged explicitly in the Stage 3 handoff as a
// deliberate, minimal divergence from bare JSON parity, not an invented
// business rule about HOW credit is applied.
export async function deleteCreditNote(id: number, expectedVersion: number): Promise<{ deleted: true }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const curRes = await client.query('SELECT row_version, used_amount FROM rel_credit_notes WHERE id = $1 FOR UPDATE', [id]);
    if (curRes.rowCount === 0) throw new BusinessRuleError(`credit note ${id} not found`);
    if (curRes.rows[0].row_version !== expectedVersion) throw new ConcurrencyConflictError('rel_credit_notes', id);
    if (Number(curRes.rows[0].used_amount) > 0) {
      throw new BusinessRuleError(`credit note ${id} has ${curRes.rows[0].used_amount} already applied — refusing to delete a partially/fully-used credit note (see Stage 3 handoff)`);
    }
    await client.query('DELETE FROM rel_credit_notes WHERE id = $1', [id]);
    await client.query('COMMIT');
    return { deleted: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ── PURCHASE ORDERS — Stage 3 Phase 7 ───────────────────────────────────────
// PO number reservation reuses the SAME atomic 'po' pool already used by the
// auto-PO path above. Line items are fixed at creation time — real
// PODetailModal never edits po.items[] after creation, only
// supplier/status/notes — so updatePurchaseOrder deliberately has no `items`
// param at all (there is nothing to wire; reproducing "no such feature"
// exactly, not adding one).
export interface POItemInput {
  sku?: string | null; name: string; unit?: string | null;
  qtyNeeded: number; qtyOrdered: number; unitCost?: number; inventoryItemId?: number | null;
}
export interface CreatePOInput {
  companyCode?: string | null; supplierId?: number | null;
  jobId?: number | null; jobNumberRaw?: string | null;
  quoteId?: number | null; quoteNumberRaw?: string | null;
  // 2026-08-21 PURCHASE ORDER MIGRATION POLICY CHANGE: orderDate is an
  // optional caller-supplied date (matches the existing PO UI's date
  // field, previously silently ignored here — always defaulted to
  // CURRENT_DATE regardless of what the modal captured). Falls back to
  // CURRENT_DATE when omitted, unchanged from before.
  orderDate?: string | null;
  notes?: string | null; items: POItemInput[];
}
export async function createPurchaseOrder(input: CreatePOInput): Promise<{ id: number; poNumber: string; rowVersion: number }> {
  // FINAL CUTOVER BLOCKER COMPLETION (2026-08-22): this function only ever
  // runs once purchaseOrders is relational-authoritative (it is reached
  // exclusively via POST /purchase-orders, gated by requireCutOver), so a
  // saved supplier is unconditionally required here — this was previously
  // enforced ONLY in index.html's createPurchaseOrderShared/CreateCustomPOModal,
  // meaning a direct API call could create a supplier-less PO. Enforcing it
  // here closes that gap without weakening the frontend's own check.
  if (input.supplierId == null) {
    throw new BusinessRuleError('A saved supplier is required to create a purchase order — create the supplier first, then create this PO.');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const poNumber = await reserveDocumentNumberWithClient(client, 'ALL', 'po');
    const poRes = await client.query(
      `WITH new_id AS (SELECT nextval('rel_purchase_orders_id_seq') AS id)
       INSERT INTO rel_purchase_orders (id, source_id, po_number, company_code, supplier_id, job_id, job_number_raw, quote_id, quote_number_raw, order_date, status, notes, legacy_data)
       SELECT new_id.id, new_id.id::text, $1, $2, $3, $4, $5, $6, $7, COALESCE($8::date, CURRENT_DATE), 'draft', $9, '{}'::jsonb FROM new_id
       RETURNING id, row_version`,
      [poNumber, input.companyCode ?? null, input.supplierId ?? null, input.jobId ?? null, input.jobNumberRaw ?? null, input.quoteId ?? null, input.quoteNumberRaw ?? null, input.orderDate ?? null, input.notes ?? null]
    );
    const poId = poRes.rows[0].id;
    for (let i = 0; i < input.items.length; i++) {
      const it = input.items[i];
      await client.query(
        `INSERT INTO rel_purchase_order_items (po_id, line_index, inventory_item_id, sku, name, unit, qty_needed, qty_ordered, unit_cost, legacy_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'{}'::jsonb)`,
        [poId, i, it.inventoryItemId ?? null, it.sku ?? null, it.name, it.unit ?? null, it.qtyNeeded, it.qtyOrdered, it.unitCost || 0]
      );
    }
    await client.query('COMMIT');
    return { id: poId, poNumber, rowVersion: poRes.rows[0].row_version };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
export interface POPatchInput { supplierId?: number | null; status?: string | null; notes?: string | null }
export async function updatePurchaseOrder(id: number, expectedVersion: number, patch: Partial<POPatchInput>): Promise<{ rowVersion: number }> {
  const colMap: Record<string, string> = { supplierId: 'supplier_id', status: 'status', notes: 'notes' };
  const sets: string[] = []; const vals: any[] = [];
  for (const [k, col] of Object.entries(colMap)) {
    if ((patch as any)[k] !== undefined) { vals.push((patch as any)[k]); sets.push(`${col} = $${vals.length}`); }
  }
  if (sets.length === 0) {
    const cur = await pool.query('SELECT row_version FROM rel_purchase_orders WHERE id = $1', [id]);
    if (cur.rowCount === 0) throw new BusinessRuleError(`purchase order ${id} not found`);
    return { rowVersion: cur.rows[0].row_version };
  }
  vals.push(id); const idIdx = vals.length;
  vals.push(expectedVersion); const verIdx = vals.length;
  const res = await pool.query(
    `UPDATE rel_purchase_orders SET ${sets.join(', ')}, row_version = row_version + 1, updated_at = NOW()
     WHERE id = $${idIdx} AND row_version = $${verIdx} RETURNING row_version`,
    vals
  );
  if (res.rowCount === 0) {
    const exists = await pool.query('SELECT id FROM rel_purchase_orders WHERE id = $1', [id]);
    if (exists.rowCount === 0) throw new BusinessRuleError(`purchase order ${id} not found`);
    throw new ConcurrencyConflictError('rel_purchase_orders', id);
  }
  return { rowVersion: res.rows[0].row_version };
}

// ── SUPPLIERS — Stage 3 Phase 8 ─────────────────────────────────────────────
// Plain CRUD, matching JSON's saveSup/delSup exactly (no document-number
// scheme — suppliers never had one). deleteSupplier relies on rel_
// inventory_items.supplier_id's FK (no ON DELETE CASCADE/SET NULL in
// migration 007) to refuse deleting a supplier still referenced — a genuine
// DB-level protection, not an invented business rule.
export interface SupplierInput {
  name: string; contactPerson?: string | null; phone?: string | null; email?: string | null;
  address?: string | null; city?: string | null; postalCode?: string | null; vatNumber?: string | null;
  accountNumber?: string | null; notes?: string | null; paymentTerms?: string | null;
}
export async function createSupplier(input: SupplierInput): Promise<{ id: number; rowVersion: number }> {
  const res = await pool.query(
    `WITH new_id AS (SELECT nextval('rel_suppliers_id_seq') AS id)
     INSERT INTO rel_suppliers (id, source_id, name, contact_person, phone, email, address, city, postal_code, vat_number, account_number, notes, payment_terms, legacy_data)
     SELECT new_id.id, new_id.id::text, $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'{}'::jsonb FROM new_id
     RETURNING id, row_version`,
    [input.name, input.contactPerson ?? null, input.phone ?? null, input.email ?? null, input.address ?? null, input.city ?? null, input.postalCode ?? null, input.vatNumber ?? null, input.accountNumber ?? null, input.notes ?? null, input.paymentTerms ?? null]
  );
  return { id: res.rows[0].id, rowVersion: res.rows[0].row_version };
}
export async function updateSupplier(id: number, expectedVersion: number, patch: Partial<SupplierInput>): Promise<{ rowVersion: number }> {
  const colMap: Record<string, string> = {
    name: 'name', contactPerson: 'contact_person', phone: 'phone', email: 'email', address: 'address',
    city: 'city', postalCode: 'postal_code', vatNumber: 'vat_number', accountNumber: 'account_number',
    notes: 'notes', paymentTerms: 'payment_terms',
  };
  const sets: string[] = []; const vals: any[] = [];
  for (const [k, col] of Object.entries(colMap)) {
    if ((patch as any)[k] !== undefined) { vals.push((patch as any)[k]); sets.push(`${col} = $${vals.length}`); }
  }
  if (sets.length === 0) {
    const cur = await pool.query('SELECT row_version FROM rel_suppliers WHERE id = $1', [id]);
    if (cur.rowCount === 0) throw new BusinessRuleError(`supplier ${id} not found`);
    return { rowVersion: cur.rows[0].row_version };
  }
  vals.push(id); const idIdx = vals.length;
  vals.push(expectedVersion); const verIdx = vals.length;
  const res = await pool.query(
    `UPDATE rel_suppliers SET ${sets.join(', ')}, row_version = row_version + 1, updated_at = NOW()
     WHERE id = $${idIdx} AND row_version = $${verIdx} RETURNING row_version`,
    vals
  );
  if (res.rowCount === 0) {
    const exists = await pool.query('SELECT id FROM rel_suppliers WHERE id = $1', [id]);
    if (exists.rowCount === 0) throw new BusinessRuleError(`supplier ${id} not found`);
    throw new ConcurrencyConflictError('rel_suppliers', id);
  }
  return { rowVersion: res.rows[0].row_version };
}
export async function deleteSupplier(id: number, expectedVersion: number): Promise<{ deleted: true }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT row_version FROM rel_suppliers WHERE id = $1 FOR UPDATE', [id]);
    if (cur.rowCount === 0) throw new BusinessRuleError(`supplier ${id} not found`);
    if (cur.rows[0].row_version !== expectedVersion) throw new ConcurrencyConflictError('rel_suppliers', id);
    await client.query('DELETE FROM rel_suppliers WHERE id = $1', [id]);
    await client.query('COMMIT');
    return { deleted: true };
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (err && err.code === '23503') {
      throw new BusinessRuleError(`supplier ${id} is still referenced by inventory items — cannot delete while in use`);
    }
    throw err;
  } finally {
    client.release();
  }
}

// ── INVENTORY — Stage 3 Phase 8 ─────────────────────────────────────────────
// Plain CRUD (saveItem/removeItem) plus ONE additional concurrency-safe
// delta-adjustment op — the ONLY other place stock changes today besides a
// direct field edit is the quote-conversion deduction above (a separate
// code path); this is for a manual stock recount/correction, an atomic
// UPDATE ... SET stock_qty = GREATEST(0, stock_qty + delta) WHERE row_version
// = $expected, never deriving the new value from a stale client-read number.
export interface InventoryItemInput {
  sku?: string | null; name: string; category?: string | null; unit?: string | null;
  cost?: number; sell?: number; stock?: number; reorder?: number; supplierId?: number | null;
  // MIGRATION CLOSURE Item 3's reactivation path — updateInventoryItem can
  // flip an item back to active; the delete path below never uses this
  // (it always sets false), included here only so a future "restore" UI
  // action can reuse the plain update service rather than a bespoke route.
  active?: boolean;
}
export async function createInventoryItem(input: InventoryItemInput): Promise<{ id: number; rowVersion: number }> {
  const res = await pool.query(
    `WITH new_id AS (SELECT nextval('rel_inventory_items_id_seq') AS id)
     INSERT INTO rel_inventory_items (id, source_id, sku, name, category, unit, cost, sell, stock_qty, reorder_level, supplier_id, legacy_data)
     SELECT new_id.id, new_id.id::text, $1,$2,$3,$4,$5,$6,$7,$8,$9,'{}'::jsonb FROM new_id
     RETURNING id, row_version`,
    [input.sku ?? null, input.name, input.category ?? null, input.unit ?? null, input.cost || 0, input.sell || 0, input.stock || 0, input.reorder || 0, input.supplierId ?? null]
  );
  return { id: res.rows[0].id, rowVersion: res.rows[0].row_version };
}
export async function updateInventoryItem(id: number, expectedVersion: number, patch: Partial<InventoryItemInput>): Promise<{ rowVersion: number }> {
  const colMap: Record<string, string> = {
    sku: 'sku', name: 'name', category: 'category', unit: 'unit', cost: 'cost', sell: 'sell',
    stock: 'stock_qty', reorder: 'reorder_level', supplierId: 'supplier_id', active: 'is_active',
  };
  const sets: string[] = []; const vals: any[] = [];
  for (const [k, col] of Object.entries(colMap)) {
    if ((patch as any)[k] !== undefined) { vals.push((patch as any)[k]); sets.push(`${col} = $${vals.length}`); }
  }
  if (sets.length === 0) {
    const cur = await pool.query('SELECT row_version FROM rel_inventory_items WHERE id = $1', [id]);
    if (cur.rowCount === 0) throw new BusinessRuleError(`inventory item ${id} not found`);
    return { rowVersion: cur.rows[0].row_version };
  }
  vals.push(id); const idIdx = vals.length;
  vals.push(expectedVersion); const verIdx = vals.length;
  const res = await pool.query(
    `UPDATE rel_inventory_items SET ${sets.join(', ')}, row_version = row_version + 1, updated_at = NOW()
     WHERE id = $${idIdx} AND row_version = $${verIdx} RETURNING row_version`,
    vals
  );
  if (res.rowCount === 0) {
    const exists = await pool.query('SELECT id FROM rel_inventory_items WHERE id = $1', [id]);
    if (exists.rowCount === 0) throw new BusinessRuleError(`inventory item ${id} not found`);
    throw new ConcurrencyConflictError('rel_inventory_items', id);
  }
  return { rowVersion: res.rows[0].row_version };
}
export async function adjustInventoryStock(id: number, expectedVersion: number, delta: number): Promise<{ rowVersion: number; newStock: number }> {
  const res = await pool.query(
    `UPDATE rel_inventory_items SET stock_qty = GREATEST(0, stock_qty + $1), row_version = row_version + 1, updated_at = NOW()
     WHERE id = $2 AND row_version = $3 RETURNING row_version, stock_qty`,
    [delta, id, expectedVersion]
  );
  if (res.rowCount === 0) {
    const exists = await pool.query('SELECT id FROM rel_inventory_items WHERE id = $1', [id]);
    if (exists.rowCount === 0) throw new BusinessRuleError(`inventory item ${id} not found`);
    throw new ConcurrencyConflictError('rel_inventory_items', id);
  }
  return { rowVersion: res.rows[0].row_version, newStock: Number(res.rows[0].stock_qty) };
}

// MIGRATION CLOSURE Item 3 (2026-08-21): removeItem() was the last core
// financial CRUD action with no relational counterpart at all — before this,
// cutting "inventory" over would make it impossible to delete an item
// through the relational path (assertNoUnwiredRelationalSections refuses
// the save loudly rather than silently losing the deletion — see
// index.html's prior comment on removeItem, now removed).
//
// Deliberately a SOFT delete (is_active = false, migration 009), never a
// physical DELETE FROM rel_inventory_items: rel_quote_line_items/
// rel_job_line_items carry an optional inventory_item_id FK back to this
// table (no ON DELETE CASCADE/SET NULL), so a real delete would either be
// refused forever for any item ever quoted/jobbed (however old and closed —
// unlike rel_suppliers, this is a routine "discontinue this item" action,
// not a rare edge case) or require a CASCADE/SET NULL that could sever
// historical linkage — exactly what the task calls out as unacceptable.
// Row-scoped optimistic concurrency (expectedVersion checked, row_version
// bumped) applies identically to this as to every other relational mutation
// — a stale delete attempt (the item was edited elsewhere since this client
// last read it) is rejected with the same 409 stale_record shape, never
// silently deactivating a newer edit out from under someone.
export async function deleteInventoryItem(id: number, expectedVersion: number): Promise<{ deactivated: true }> {
  const res = await pool.query(
    `UPDATE rel_inventory_items SET is_active = false, row_version = row_version + 1, updated_at = NOW()
     WHERE id = $1 AND row_version = $2 RETURNING row_version`,
    [id, expectedVersion]
  );
  if (res.rowCount === 0) {
    const exists = await pool.query('SELECT id FROM rel_inventory_items WHERE id = $1', [id]);
    if (exists.rowCount === 0) throw new BusinessRuleError(`inventory item ${id} not found`);
    throw new ConcurrencyConflictError('rel_inventory_items', id);
  }
  return { deactivated: true };
}
