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

export async function createQuote(input: CreateQuoteInput): Promise<{ id: number; quoteNumber: string }> {
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
       RETURNING id`,
      [quoteNumber, input.companyCode, input.customerId ?? null, input.customerNameRaw, input.notes ?? null, setupFee, discountPct, subtotal, vatAmount, total]
    );
    const quoteId = insertRes.rows[0].id;

    for (let i = 0; i < input.lines.length; i++) {
      const l = input.lines[i];
      await client.query(
        `INSERT INTO rel_quote_line_items (quote_id, line_index, description, qty, unit_price, subtotal, inventory_item_id, legacy_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb)`,
        [quoteId, i, l.description, l.qty, l.unitPrice, l.qty * l.unitPrice, l.inventoryItemId ?? null]
      );
    }

    await client.query('COMMIT');
    return { id: quoteId, quoteNumber };
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
export async function convertQuoteToJob(quoteId: number): Promise<{ jobId: number; jobNumber: string }> {
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
       RETURNING id`,
      [jobNumber, quote.company_code, quote.customer_id, quote.customer_name_raw,
       `From Quote ${quote.quote_number}`, quote.total, quoteId, quote.quote_number,
       quote.setup_fee, quote.discount_pct, quote.notes]
    );
    const jobId = jobRes.rows[0].id;

    for (const l of lineItemsRes.rows) {
      await client.query(
        `INSERT INTO rel_job_line_items (job_id, line_index, description, qty, unit_price, subtotal, inventory_item_id, legacy_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb)`,
        [jobId, l.line_index, l.description, l.qty, l.unit_price, l.subtotal, l.inventory_item_id]
      );
    }

    await client.query(
      `UPDATE rel_quotes SET status = 'converted', converted_job_id = $1, row_version = row_version + 1, updated_at = NOW() WHERE id = $2`,
      [jobId, quoteId]
    );

    await client.query('COMMIT');
    return { jobId, jobNumber };
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
export async function createInvoiceForJob(jobId: number): Promise<{ invoiceId: number; invoiceNumber: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jobRes = await client.query('SELECT * FROM rel_jobs WHERE id = $1 FOR UPDATE', [jobId]);
    if (jobRes.rowCount === 0) throw new BusinessRuleError(`job ${jobId} not found`);
    const job = jobRes.rows[0];
    if (job.invoice_num) throw new BusinessRuleError(`job ${jobId} (${job.job_number}) already has invoice ${job.invoice_num}`);

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

    await client.query(
      `UPDATE rel_jobs SET invoice_num = $1, invoice_date = CURRENT_DATE, invoice_created = true, invoice_status = 'pending', status = 'invoiced', stage = 9, row_version = row_version + 1, updated_at = NOW() WHERE id = $2`,
      [invoiceNumber, jobId]
    );

    await client.query('COMMIT');
    return { invoiceId, invoiceNumber };
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
export async function recordPayment(owner: { type: 'job' | 'invoice' | 'quote'; id: number }, amount: number, opts: { date?: string; method?: string; reference?: string; notes?: string } = {}): Promise<{ paymentId: number }> {
  const table = owner.type === 'job' ? 'rel_jobs' : owner.type === 'invoice' ? 'rel_invoices' : 'rel_quotes';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ownerRes = await client.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [owner.id]);
    if (ownerRes.rowCount === 0) throw new BusinessRuleError(`${owner.type} ${owner.id} not found`);

    const nextIdx = await client.query(
      `SELECT COALESCE(MAX(line_index), -1) + 1 AS idx FROM rel_payments WHERE owner_type = $1 AND owner_id = $2`,
      [owner.type, owner.id]
    );
    const lineIndex = nextIdx.rows[0].idx;

    const res = await client.query(
      `WITH new_id AS (SELECT nextval('rel_payments_id_seq') AS id)
       INSERT INTO rel_payments (id, source_id, owner_type, owner_id, line_index, amount, payment_date, method, reference, notes, legacy_data)
       SELECT new_id.id, new_id.id::text, $1, $2, $3, $4, $5, $6, $7, $8, '{}'::jsonb FROM new_id
       RETURNING id`,
      [owner.type, owner.id, lineIndex, amount, opts.date || null, opts.method || null, opts.reference || null, opts.notes || null]
    );
    await client.query('COMMIT');
    return { paymentId: res.rows[0].id };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ── UPDATE QUOTE / UPDATE JOB — Stage 2 addition ────────────────────────────
// Generic, non-cascading field-patch updates, added for Stage 2's frontend
// wiring (Phase 4): "quote creation" and "quote -> job conversion" already
// had dedicated services above (createQuote / convertQuoteToJob), but a
// PLAIN EDIT to an existing quote or job (notes, line items, discount,
// contact details, stage/status) had no relational equivalent yet — without
// one, once a section is cut over, an ordinary field edit would have nowhere
// to persist (platformState.ts's write-isolation correctly refuses to let
// platform_state.data write it, per Stage 1's design, but nothing was built
// yet to accept it relationally either). Same row-level optimistic
// concurrency pattern as updateCustomer above. Deliberately does NOT
// reproduce index.html's cross-section cascades (e.g. a quote edit syncing
// into its linked job's invoice fields) — that cascade logic stays in the
// frontend exactly as it already works today; this only persists the ONE
// record's own fields. See the migration handoff for what this does and
// does not cover.
export interface QuotePatchInput {
  customerNameRaw?: string; contactPerson?: string | null; email?: string | null;
  phone?: string | null; address?: string | null; vatNumber?: string | null;
  status?: string | null; notes?: string | null; terms?: string | null;
  salesperson?: string | null; preparedBy?: string | null; poRef?: string | null;
  reference?: string | null; setupFee?: number; discountPct?: number;
}
export async function updateQuote(id: number, expectedVersion: number, patch: Partial<QuotePatchInput>): Promise<{ rowVersion: number }> {
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
  if (sets.length === 0) {
    const cur = await pool.query('SELECT row_version FROM rel_quotes WHERE id = $1', [id]);
    if (cur.rowCount === 0) throw new BusinessRuleError(`quote ${id} not found`);
    return { rowVersion: cur.rows[0].row_version };
  }
  vals.push(id); const idIdx = vals.length;
  vals.push(expectedVersion); const verIdx = vals.length;
  const res = await pool.query(
    `UPDATE rel_quotes SET ${sets.join(', ')}, row_version = row_version + 1, updated_at = NOW()
     WHERE id = $${idIdx} AND row_version = $${verIdx} RETURNING row_version`,
    vals
  );
  if (res.rowCount === 0) {
    const exists = await pool.query('SELECT id FROM rel_quotes WHERE id = $1', [id]);
    if (exists.rowCount === 0) throw new BusinessRuleError(`quote ${id} not found`);
    throw new ConcurrencyConflictError('rel_quotes', id);
  }
  return { rowVersion: res.rows[0].row_version };
}

export interface JobPatchInput {
  customerNameRaw?: string; contactPerson?: string | null; email?: string | null;
  phone?: string | null; address?: string | null; vatNumber?: string | null;
  description?: string | null; status?: string | null; stage?: number;
  setupFee?: number; discountPct?: number; salesperson?: string | null;
  preparedBy?: string | null; poRef?: string | null; reference?: string | null;
  notes?: string | null;
}
export async function updateJob(id: number, expectedVersion: number, patch: Partial<JobPatchInput>): Promise<{ rowVersion: number }> {
  const colMap: Record<string, string> = {
    customerNameRaw: 'customer_name_raw', contactPerson: 'contact_person', email: 'email',
    phone: 'phone', address: 'address', vatNumber: 'vat_number', description: 'description',
    status: 'status', stage: 'stage', setupFee: 'setup_fee', discountPct: 'discount_pct',
    salesperson: 'salesperson', preparedBy: 'prepared_by', poRef: 'po_ref',
    reference: 'reference', notes: 'notes',
  };
  const sets: string[] = []; const vals: any[] = [];
  for (const [k, col] of Object.entries(colMap)) {
    if ((patch as any)[k] !== undefined) { vals.push((patch as any)[k]); sets.push(`${col} = $${vals.length}`); }
  }
  if (sets.length === 0) {
    const cur = await pool.query('SELECT row_version FROM rel_jobs WHERE id = $1', [id]);
    if (cur.rowCount === 0) throw new BusinessRuleError(`job ${id} not found`);
    return { rowVersion: cur.rows[0].row_version };
  }
  vals.push(id); const idIdx = vals.length;
  vals.push(expectedVersion); const verIdx = vals.length;
  const res = await pool.query(
    `UPDATE rel_jobs SET ${sets.join(', ')}, row_version = row_version + 1, updated_at = NOW()
     WHERE id = $${idIdx} AND row_version = $${verIdx} RETURNING row_version`,
    vals
  );
  if (res.rowCount === 0) {
    const exists = await pool.query('SELECT id FROM rel_jobs WHERE id = $1', [id]);
    if (exists.rowCount === 0) throw new BusinessRuleError(`job ${id} not found`);
    throw new ConcurrencyConflictError('rel_jobs', id);
  }
  return { rowVersion: res.rows[0].row_version };
}
