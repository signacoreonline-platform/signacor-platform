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
export interface QuoteLineInput { description: string; qty: number; unitPrice: number; inventoryItemId?: number | null }
export interface CreateQuoteInput {
  companyCode: string;
  customerId?: number | null;
  customerNameRaw: string;
  lines: QuoteLineInput[];
  discountPct?: number;
  setupFee?: number;
  notes?: string | null;
}

export async function createQuote(input: CreateQuoteInput): Promise<{ id: number; quoteNumber: string; rowVersion: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const quoteNumber = await reserveDocumentNumberWithClient(client, input.companyCode, 'quote');

    const subtotal = input.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0);
    const discountPct = input.discountPct || 0;
    const discAmt = subtotal * (discountPct / 100);
    const setupFee = input.setupFee || 0;
    const afterDisc = subtotal - discAmt + setupFee;
    const vatAmount = afterDisc * 0.15;
    const total = afterDisc + vatAmount;

    const insertRes = await client.query(
      `WITH new_id AS (SELECT nextval('rel_quotes_id_seq') AS id)
       INSERT INTO rel_quotes (id, source_id, quote_number, company_code, customer_id, customer_name_raw, notes, setup_fee, discount_pct, subtotal, vat_amount, total, status, legacy_data)
       SELECT new_id.id, new_id.id::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft', '{}'::jsonb FROM new_id
       RETURNING id, row_version`,
      [quoteNumber, input.companyCode, input.customerId ?? null, input.customerNameRaw, input.notes ?? null, setupFee, discountPct, subtotal, vatAmount, total]
    );
    const quoteId = insertRes.rows[0].id;
    const quoteRowVersion = insertRes.rows[0].row_version;

    for (let i = 0; i < input.lines.length; i++) {
      const l = input.lines[i];
      await client.query(
        `INSERT INTO rel_quote_line_items (quote_id, line_index, description, qty, unit_price, subtotal, inventory_item_id, legacy_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb)`,
        [quoteId, i, l.description, l.qty, l.unitPrice, l.qty * l.unitPrice, l.inventoryItemId ?? null]
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

    const jobRes = await client.query(
      `WITH new_id AS (SELECT nextval('rel_jobs_id_seq') AS id)
       INSERT INTO rel_jobs (id, source_id, job_number, company_code, customer_id, customer_name_raw, description, status, stage, value, quote_id, quote_number_raw, setup_fee, discount_pct, notes, legacy_data)
       SELECT new_id.id, new_id.id::text, $1, $2, $3, $4, $5, 'quote_approved', 4, $6, $7, $8, $9, $10, $11, '{}'::jsonb FROM new_id
       RETURNING id, row_version`,
      [jobNumber, quote.company_code, quote.customer_id, quote.customer_name_raw,
       `From Quote ${quote.quote_number}`, quote.total, quoteId, quote.quote_number,
       quote.setup_fee, quote.discount_pct, quote.notes]
    );
    const jobId = jobRes.rows[0].id;
    const jobRowVersion = jobRes.rows[0].row_version;

    for (const l of lineItemsRes.rows) {
      await client.query(
        `INSERT INTO rel_job_line_items (job_id, line_index, description, qty, unit_price, unit, subtotal, inventory_item_id, legacy_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}'::jsonb)`,
        [jobId, l.line_index, l.description, l.qty, l.unit_price, l.unit, l.subtotal, l.inventory_item_id]
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
    await client.query(
      `UPDATE rel_quotes SET status = 'converted', converted_job_id = $1::bigint, converted_job_source_id = $1::text, row_version = row_version + 1, updated_at = NOW() WHERE id = $2`,
      [jobId, quoteId]
    );

    await client.query('COMMIT');
    return { jobId, jobNumber, jobRowVersion, inventoryAdjustments };
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
export async function createInvoiceForJob(jobId: number): Promise<{ invoiceId: number; invoiceNumber: string; legacyMapped?: boolean; jobRowVersion: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jobRes = await client.query('SELECT * FROM rel_jobs WHERE id = $1 FOR UPDATE', [jobId]);
    if (jobRes.rowCount === 0) throw new BusinessRuleError(`job ${jobId} not found`);
    const job = jobRes.rows[0];

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
          await client.query(`UPDATE rel_invoices SET job_id = $1, job_number_raw = $2 WHERE id = $3`, [jobId, job.job_number, existingInv.id]);
        }
        const jobUpdRes1 = await client.query(
          `UPDATE rel_jobs SET invoice_created = true, invoice_date = COALESCE(invoice_date, CURRENT_DATE), invoice_status = COALESCE(invoice_status, 'pending'), status = 'invoiced', stage = 9, row_version = row_version + 1, updated_at = NOW() WHERE id = $1 RETURNING row_version`,
          [jobId]
        );
        await client.query('COMMIT');
        return { invoiceId: existingInv.id, invoiceNumber: job.invoice_num, legacyMapped: true, jobRowVersion: jobUpdRes1.rows[0].row_version };
      }

      // No rel_invoices row exists for this number yet at all — create
      // exactly one, using the job's EXISTING invoice_num verbatim (never
      // reserved from the atomic counter, since a number is already on
      // record for this job).
      const legacyLineItemsRes = await client.query('SELECT * FROM rel_job_line_items WHERE job_id = $1 ORDER BY line_index', [jobId]);
      const legacyInvRes = await client.query(
        `WITH new_id AS (SELECT nextval('rel_invoices_id_seq') AS id)
         INSERT INTO rel_invoices (id, source_id, invoice_number, company_code, customer_id, contact_name, job_id, job_number_raw, quote_id, quote_number_raw, status, issue_date, legacy_data)
         SELECT new_id.id, new_id.id::text, $1, $2, $3, $4, $5, $6, $7, $8, 'sent', COALESCE($9::date, CURRENT_DATE), '{}'::jsonb FROM new_id
         RETURNING id`,
        [job.invoice_num, job.company_code, job.customer_id, job.customer_name_raw, jobId, job.job_number, job.quote_id, job.quote_number_raw, job.invoice_date]
      );
      const legacyInvoiceId = legacyInvRes.rows[0].id;
      for (const l of legacyLineItemsRes.rows) {
        await client.query(
          `INSERT INTO rel_invoice_line_items (invoice_id, line_index, description, qty, unit_amount, account_code, tax_type, legacy_data)
           VALUES ($1, $2, $3, $4, $5, '4000', '15%', '{}'::jsonb)`,
          [legacyInvoiceId, l.line_index, l.description, l.qty, l.unit_price]
        );
      }
      const jobUpdRes2 = await client.query(
        `UPDATE rel_jobs SET invoice_created = true, invoice_date = COALESCE(invoice_date, CURRENT_DATE), invoice_status = COALESCE(invoice_status, 'pending'), status = 'invoiced', stage = 9, row_version = row_version + 1, updated_at = NOW() WHERE id = $1 RETURNING row_version`,
        [jobId]
      );
      await client.query('COMMIT');
      return { invoiceId: legacyInvoiceId, invoiceNumber: job.invoice_num, legacyMapped: true, jobRowVersion: jobUpdRes2.rows[0].row_version };
    }

    const invoiceNumber = await reserveDocumentNumberWithClient(client, job.company_code, 'invoice');

    const lineItemsRes = await client.query('SELECT * FROM rel_job_line_items WHERE job_id = $1 ORDER BY line_index', [jobId]);

    const invRes = await client.query(
      `WITH new_id AS (SELECT nextval('rel_invoices_id_seq') AS id)
       INSERT INTO rel_invoices (id, source_id, invoice_number, company_code, customer_id, contact_name, job_id, job_number_raw, quote_id, quote_number_raw, status, issue_date, legacy_data)
       SELECT new_id.id, new_id.id::text, $1, $2, $3, $4, $5, $6, $7, $8, 'sent', CURRENT_DATE, '{}'::jsonb FROM new_id
       RETURNING id`,
      [invoiceNumber, job.company_code, job.customer_id, job.customer_name_raw, jobId, job.job_number, job.quote_id, job.quote_number_raw]
    );
    const invoiceId = invRes.rows[0].id;

    for (const l of lineItemsRes.rows) {
      await client.query(
        `INSERT INTO rel_invoice_line_items (invoice_id, line_index, description, qty, unit_amount, account_code, tax_type, legacy_data)
         VALUES ($1, $2, $3, $4, $5, '4000', '15%', '{}'::jsonb)`,
        [invoiceId, l.line_index, l.description, l.qty, l.unit_price]
      );
    }

    const jobUpdRes3 = await client.query(
      `UPDATE rel_jobs SET invoice_num = $1, invoice_date = CURRENT_DATE, invoice_created = true, invoice_status = 'pending', status = 'invoiced', stage = 9, row_version = row_version + 1, updated_at = NOW() WHERE id = $2 RETURNING row_version`,
      [invoiceNumber, jobId]
    );

    await client.query('COMMIT');
    return { invoiceId, invoiceNumber, jobRowVersion: jobUpdRes3.rows[0].row_version };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ── PRO -> INV finalisation ──────────────────────────────────────────────
// Verifies the PRO reservation belongs to this quote, verifies the matching
// INV reservation (same derivation rule as documentNumbers.ts
// deriveReservedInvoiceNumber), consumes the EXACT reserved suffix — never
// allocates a second number.
export async function finalizeProformaToInvoice(quoteId: number): Promise<{ invoiceId: number; invoiceNumber: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const quoteRes = await client.query('SELECT * FROM rel_quotes WHERE id = $1 FOR UPDATE', [quoteId]);
    if (quoteRes.rowCount === 0) throw new BusinessRuleError(`quote ${quoteId} not found`);
    const quote = quoteRes.rows[0];
    if (!quote.proforma_num) throw new BusinessRuleError(`quote ${quoteId} has no proforma reservation to finalise`);

    const m = /^PRO-(\d+)$/i.exec(String(quote.proforma_num).trim());
    const invoiceNumber = m ? `INV-${m[1]}` : String(quote.proforma_num).trim().toUpperCase();

    const existing = await client.query('SELECT id FROM rel_invoices WHERE company_code = $1 AND invoice_number = $2', [quote.company_code, invoiceNumber]);
    if (existing.rowCount && existing.rowCount > 0) {
      throw new BusinessRuleError(`invoice ${invoiceNumber} already exists for company ${quote.company_code} — this reservation was already finalised, refusing to create a second invoice`);
    }

    const lineItemsRes = await client.query('SELECT * FROM rel_quote_line_items WHERE quote_id = $1 ORDER BY line_index', [quoteId]);
    const invRes = await client.query(
      `WITH new_id AS (SELECT nextval('rel_invoices_id_seq') AS id)
       INSERT INTO rel_invoices (id, source_id, invoice_number, company_code, customer_id, contact_name, quote_id, quote_number_raw, status, issue_date, legacy_data)
       SELECT new_id.id, new_id.id::text, $1, $2, $3, $4, $5, $6, 'sent', CURRENT_DATE, '{}'::jsonb FROM new_id
       RETURNING id`,
      [invoiceNumber, quote.company_code, quote.customer_id, quote.customer_name_raw, quoteId, quote.quote_number]
    );
    const invoiceId = invRes.rows[0].id;
    for (const l of lineItemsRes.rows) {
      await client.query(
        `INSERT INTO rel_invoice_line_items (invoice_id, line_index, description, qty, unit_amount, account_code, tax_type, legacy_data)
         VALUES ($1, $2, $3, $4, $5, '4000', '15%', '{}'::jsonb)`,
        [invoiceId, l.line_index, l.description, l.qty, l.unit_price]
      );
    }
    await client.query('COMMIT');
    return { invoiceId, invoiceNumber };
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
async function recomputeOwnerPaymentStatus(client: PoolClient, ownerType: 'job' | 'invoice' | 'quote', ownerId: number): Promise<void> {
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
      if ((patch as any)[k] !== undefined) { vals.push((patch as any)[k]); sets.push(`${col} = $${vals.length}`); }
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
export async function deletePayment(id: number, expectedVersion: number): Promise<{ deleted: true; creditReleased: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const curRes = await client.query('SELECT * FROM rel_payments WHERE id = $1 FOR UPDATE', [id]);
    if (curRes.rowCount === 0) throw new BusinessRuleError(`payment ${id} not found`);
    const payment = curRes.rows[0];
    if (payment.row_version !== expectedVersion) throw new ConcurrencyConflictError('rel_payments', id);
    let creditReleased = 0;
    if (payment.method === 'Credit') {
      const table = payment.owner_type === 'job' ? 'rel_jobs' : payment.owner_type === 'invoice' ? 'rel_invoices' : 'rel_quotes';
      const nameCol = payment.owner_type === 'invoice' ? 'contact_name' : 'customer_name_raw';
      const ownerRes = await client.query(`SELECT ${nameCol} AS contact_name FROM ${table} WHERE id = $1`, [payment.owner_id]);
      const contactName = ownerRes.rowCount ? (ownerRes.rows[0].contact_name || '') : '';
      const norm = contactName.trim().toLowerCase();
      if (norm) {
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
      }
    }
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
}

async function replaceQuoteLinesTx(client: PoolClient, quoteId: number, lines: LineItemPatch[]): Promise<number> {
  await client.query('DELETE FROM rel_quote_line_items WHERE quote_id = $1', [quoteId]);
  let subtotal = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const qty = Number(l.qty) || 0;
    const unitPrice = Number(l.unitPrice) || 0;
    const lineSubtotal = qty * unitPrice;
    subtotal += lineSubtotal;
    await client.query(
      `INSERT INTO rel_quote_line_items (quote_id, line_index, description, qty, unit_price, unit, subtotal, inventory_item_id, legacy_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'{}'::jsonb)`,
      [quoteId, i, l.desc, qty, unitPrice, l.unit ?? null, lineSubtotal, l.itemId ?? null]
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
    await client.query(
      `INSERT INTO rel_job_line_items (job_id, line_index, description, qty, unit_price, unit, subtotal, inventory_item_id, legacy_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'{}'::jsonb)`,
      [jobId, i, l.desc, qty, unitPrice, l.unit ?? null, qty * unitPrice, l.itemId ?? null]
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
  lines?: LineItemPatch[];
}
export async function updateQuote(id: number, expectedVersion: number, patch: Partial<QuotePatchInput>): Promise<{ rowVersion: number }> {
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
    };
    const sets: string[] = []; const vals: any[] = [];
    for (const [k, col] of Object.entries(colMap)) {
      if ((patch as any)[k] !== undefined) { vals.push((patch as any)[k]); sets.push(`${col} = $${vals.length}`); }
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
  breakdown?: Record<string, number>;
  lines?: LineItemPatch[];
}
export async function updateJob(id: number, expectedVersion: number, patch: Partial<JobPatchInput>): Promise<{ rowVersion: number }> {
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
    };
    const sets: string[] = []; const vals: any[] = [];
    for (const [k, col] of Object.entries(colMap)) {
      if ((patch as any)[k] !== undefined) { vals.push((patch as any)[k]); sets.push(`${col} = $${vals.length}`); }
    }
    if (patch.breakdown !== undefined) {
      vals.push(JSON.stringify(patch.breakdown)); sets.push(`breakdown = $${vals.length}::jsonb`);
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
  opts: { expectedJobVersion?: number } = {}
): Promise<QuoteJobSyncResult> {
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
    };
    const sets: string[] = []; const vals: any[] = [];
    for (const [k, col] of Object.entries(colMap)) {
      if ((patch as any)[k] !== undefined) { vals.push((patch as any)[k]); sets.push(`${col} = $${vals.length}`); }
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

      if (finalLines) await replaceJobLinesTx(client, linkedJobId, finalLines);

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
      const resultNotes = (patch.notes !== undefined ? patch.notes : quote.notes) || job.notes || '';
      const _afterDisc = totals.subtotal - totals.subtotal * ((discountPct || 0) / 100) + (setupFee || 0);
      const jobValue = _afterDisc * 1.15;

      const jobUpdateRes = await client.query(
        `UPDATE rel_jobs SET
           discount_pct = $1, setup_fee = $2, value = $3,
           customer_name_raw = $4, contact_person = $5, email = $6, phone = $7, address = $8, vat_number = $9,
           notes = $10, row_version = row_version + 1, updated_at = NOW()
         WHERE id = $11
         RETURNING row_version`,
        [discountPct || 0, setupFee || 0, jobValue, resultClient, resultContact, resultEmail, resultPhone, resultAddress, resultVat, resultNotes, jobId]
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
       INSERT INTO rel_credit_notes (id, source_id, credit_number, note_type, contact_name_raw, note_date, amount, used_amount, reason, applied_to, notes, status, legacy_data)
       SELECT new_id.id, new_id.id::text, $1, $2, $3, $4, $5, 0, $6, $7, $8, $9, '{}'::jsonb FROM new_id
       RETURNING id, row_version`,
      [creditNumber, input.type, input.contactName, input.date || null, input.amount, input.reason ?? null, input.appliedTo ?? null, input.notes ?? null, input.status ?? 'active']
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
      if ((patch as any)[k] !== undefined) { vals.push((patch as any)[k]); sets.push(`${col} = $${vals.length}`); }
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
