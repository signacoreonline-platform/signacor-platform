/**
 * Authority-aware, server-side READ layer.
 *
 * This is what Stage 2 Phase 3 calls the "relational -> JSON-compatibility
 * representation": for any section that IS cut over (see cutover.ts), this
 * module assembles an array of plain objects SHAPED EXACTLY like the
 * section's platform_state.data[<section>] array always looked — same
 * field names, same id semantics — but sourced from the rel_* tables
 * instead of the frozen JSONB blob.
 *
 * Nothing here ever decides authority itself (that's cutover.ts, driven by
 * the double gate). Nothing here is called unless the caller already knows
 * the section is cut over. Nothing here writes anything.
 *
 * ── "relational -> JSON compatibility" vs "JSON -> relational authority" ──
 * This module only ever goes ONE direction: relational rows rendered AS
 * JSON. There is no code path anywhere that takes platform_state.data and
 * uses it to seed/overwrite a rel_* table at read time (that would be
 * "JSON -> relational authority", explicitly forbidden by the migration
 * brief). Writing relational tables happens ONLY through
 * backend/src/relational/services.ts and backend/src/relational/backfill.ts
 * (an explicit, one-time, human-invoked tool) — never implicitly here.
 *
 * ── id semantics ─────────────────────────────────────────────────────────
 * Every rel_* row keeps the record's original JSON id in `source_id` (TEXT).
 * For a row that was BACKFILLED from JSON, source_id is the exact original
 * id, stringified — restoreId() below turns a numeric-looking source_id
 * back into a JS number so every existing frontend comparison
 * (`job.id === someId`, sorts, etc.) keeps working exactly as it did
 * against the JSON blob. For a row that was created FRESH through the
 * relational REST API after cutover (never existed in JSON), source_id
 * looks like `rel-<n>` — a genuine new string id, not a fabricated numeric
 * one. This is a deliberate, visible difference: a caller can tell a
 * post-cutover-created record apart from a backfilled one by checking
 * whether its id is a number or a string, which is useful for the frontend
 * persistence layer (Phase 4) and is documented in the handoff.
 *
 * ── legacy_data as the base ──────────────────────────────────────────────
 * Every builder below starts from `row.legacy_data` (the verbatim original
 * JSON record, or `{}` for a genuinely new record) and overlays ONLY the
 * columns this schema actually models — i.e. the fields that could have
 * changed via a relational write since backfill. Anything the schema
 * doesn't model yet (and any field on a brand-new relational record that
 * has no legacy_data at all) still round-trips correctly: either preserved
 * verbatim from legacy_data, or simply absent for a new record, matching
 * how a freshly-created JSON record would look before every optional field
 * had been filled in.
 */
import pool from '../db/pool';
import { CutoverSection } from './cutover';

export function restoreId(sourceId: string | null | undefined): number | string {
  if (sourceId == null) return '';
  if (/^-?\d+(\.\d+)?$/.test(sourceId)) {
    const n = Number(sourceId);
    if (Number.isFinite(n)) return n;
  }
  return sourceId;
}

function legacyBase(row: any): Record<string, any> {
  const legacy = row.legacy_data;
  return legacy && typeof legacy === 'object' && !Array.isArray(legacy) ? { ...legacy } : {};
}

function dateStr(d: any): string | null {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d);
}

function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ── payments (embedded sub-array on job / quote / accInvoices records) ────
async function paymentsFor(ownerType: 'job' | 'quote' | 'invoice', ownerId: number): Promise<any[]> {
  const res = await pool.query(
    `SELECT * FROM rel_payments WHERE owner_type = $1 AND owner_id = $2 ORDER BY line_index`,
    [ownerType, ownerId]
  );
  return res.rows.map((p) => ({
    ...legacyBase(p),
    id: restoreId(p.source_id) || `relpay-${p.id}`,
    amount: num(p.amount),
    date: dateStr(p.payment_date) ?? legacyBase(p).date ?? null,
    method: p.method ?? legacyBase(p).method ?? null,
    reference: p.reference ?? null,
    notes: p.notes ?? null,
    _relPaymentId: p.id,
    _relRowVersion: p.row_version,
  }));
}

// ── CUSTOMERS ──────────────────────────────────────────────────────────────
export async function buildCustomersJson(): Promise<any[]> {
  const res = await pool.query('SELECT * FROM rel_customers ORDER BY id');
  return res.rows.map((r) => ({
    ...legacyBase(r),
    id: restoreId(r.source_id),
    name: r.company_name,
    contactPerson: r.contact_person ?? legacyBase(r).contactPerson ?? null,
    email: r.email ?? legacyBase(r).email ?? null,
    phone: r.phone ?? legacyBase(r).phone ?? null,
    address: r.address ?? legacyBase(r).address ?? null,
    vatNumber: r.vat_number ?? legacyBase(r).vatNumber ?? null,
    notes: r.notes ?? legacyBase(r).notes ?? null,
    _relId: r.id,
    _relRowVersion: r.row_version,
  }));
}

// ── SUPPLIERS ──────────────────────────────────────────────────────────────
export async function buildSuppliersJson(): Promise<any[]> {
  const res = await pool.query('SELECT * FROM rel_suppliers ORDER BY id');
  return res.rows.map((r) => ({
    ...legacyBase(r),
    id: restoreId(r.source_id),
    name: r.name,
    contactPerson: r.contact_person ?? legacyBase(r).contactPerson ?? null,
    phone: r.phone ?? legacyBase(r).phone ?? null,
    email: r.email ?? legacyBase(r).email ?? null,
    city: r.city ?? legacyBase(r).city ?? null,
    postalCode: r.postal_code ?? legacyBase(r).postalCode ?? null,
    paymentTerms: r.payment_terms ?? legacyBase(r).paymentTerms ?? null,
    accountNumber: r.account_number ?? legacyBase(r).accountNumber ?? null,
    notes: r.notes ?? legacyBase(r).notes ?? null,
    _relId: r.id,
    _relRowVersion: r.row_version,
  }));
}

// ── INVENTORY / QUICK RATES (same shape, two tables) ──────────────────────
function mapItemRow(r: any): any {
  return {
    ...legacyBase(r),
    id: restoreId(r.source_id),
    sku: r.sku ?? legacyBase(r).sku ?? null,
    name: r.name,
    category: r.category ?? legacyBase(r).category ?? null,
    unit: r.unit ?? legacyBase(r).unit ?? null,
    cost: num(r.cost),
    sell: num(r.sell),
    stockQty: num(r.stock_qty),
    reorderLevel: num(r.reorder_level),
    supplierId: r.supplier_source_id != null ? restoreId(r.supplier_source_id) : (legacyBase(r).supplierId ?? null),
    _relId: r.id,
    _relRowVersion: r.row_version,
  };
}
export async function buildInventoryJson(): Promise<any[]> {
  const res = await pool.query('SELECT * FROM rel_inventory_items ORDER BY id');
  return res.rows.map(mapItemRow);
}
export async function buildQuickRatesJson(): Promise<any[]> {
  const res = await pool.query('SELECT * FROM rel_quick_rate_items ORDER BY id');
  return res.rows.map(mapItemRow);
}

// ── QUOTES (+ line items + payments) ───────────────────────────────────────
export async function buildQuotesJson(): Promise<any[]> {
  const quotesRes = await pool.query('SELECT * FROM rel_quotes ORDER BY id');
  const out: any[] = [];
  for (const r of quotesRes.rows) {
    const linesRes = await pool.query(
      'SELECT * FROM rel_quote_line_items WHERE quote_id = $1 ORDER BY line_index', [r.id]
    );
    const items = linesRes.rows.map((l) => ({
      ...legacyBase(l),
      description: l.description,
      qty: num(l.qty),
      unitPrice: num(l.unit_price),
      subtotal: num(l.subtotal),
      inventoryItemId: l.inventory_source_id != null ? restoreId(l.inventory_source_id) : (legacyBase(l).inventoryItemId ?? null),
    }));
    const payments = await paymentsFor('quote', r.id);
    out.push({
      ...legacyBase(r),
      id: restoreId(r.source_id),
      num: r.quote_number,
      co: r.company_code,
      client: r.customer_name_raw ?? legacyBase(r).client ?? null,
      contactPerson: r.contact_person ?? legacyBase(r).contactPerson ?? null,
      email: r.email ?? legacyBase(r).email ?? null,
      phone: r.phone ?? legacyBase(r).phone ?? null,
      address: r.address ?? legacyBase(r).address ?? null,
      vatNumber: r.vat_number ?? legacyBase(r).vatNumber ?? null,
      status: r.status ?? legacyBase(r).status ?? null,
      notes: r.notes ?? legacyBase(r).notes ?? null,
      terms: r.terms ?? legacyBase(r).terms ?? null,
      salesperson: r.salesperson ?? legacyBase(r).salesperson ?? null,
      preparedBy: r.prepared_by ?? legacyBase(r).preparedBy ?? null,
      poRef: r.po_ref ?? legacyBase(r).poRef ?? null,
      reference: r.reference ?? legacyBase(r).reference ?? null,
      setupFee: num(r.setup_fee),
      discountPct: num(r.discount_pct),
      subtotal: num(r.subtotal),
      vat: num(r.vat_amount),
      total: num(r.total),
      proformaNum: r.proforma_num ?? legacyBase(r).proformaNum ?? null,
      convertedJobId: r.converted_job_source_id != null ? restoreId(r.converted_job_source_id) : (legacyBase(r).convertedJobId ?? null),
      items: items.length ? items : (legacyBase(r).items ?? []),
      payments,
      _relId: r.id,
      _relRowVersion: r.row_version,
    });
  }
  return out;
}

// ── JOBS (+ line items + payments) ─────────────────────────────────────────
export async function buildJobsJson(): Promise<any[]> {
  const jobsRes = await pool.query('SELECT * FROM rel_jobs ORDER BY id');
  const out: any[] = [];
  for (const r of jobsRes.rows) {
    const linesRes = await pool.query(
      'SELECT * FROM rel_job_line_items WHERE job_id = $1 ORDER BY line_index', [r.id]
    );
    const items = linesRes.rows.map((l) => ({
      ...legacyBase(l),
      description: l.description,
      qty: num(l.qty),
      unitPrice: num(l.unit_price),
      subtotal: num(l.subtotal),
      inventoryItemId: l.inventory_source_id != null ? restoreId(l.inventory_source_id) : (legacyBase(l).inventoryItemId ?? null),
    }));
    const payments = await paymentsFor('job', r.id);
    out.push({
      ...legacyBase(r),
      id: restoreId(r.source_id),
      num: r.job_number,
      co: r.company_code,
      client: r.customer_name_raw ?? legacyBase(r).client ?? null,
      contactPerson: r.contact_person ?? legacyBase(r).contactPerson ?? null,
      email: r.email ?? legacyBase(r).email ?? null,
      phone: r.phone ?? legacyBase(r).phone ?? null,
      address: r.address ?? legacyBase(r).address ?? null,
      vatNumber: r.vat_number ?? legacyBase(r).vatNumber ?? null,
      description: r.description ?? legacyBase(r).description ?? null,
      status: r.status ?? legacyBase(r).status ?? null,
      stage: r.stage ?? legacyBase(r).stage ?? null,
      value: num(r.value),
      quoteNum: r.quote_number_raw ?? legacyBase(r).quoteNum ?? null,
      invoiceNum: r.invoice_num ?? legacyBase(r).invoiceNum ?? null,
      invoiceDate: dateStr(r.invoice_date) ?? legacyBase(r).invoiceDate ?? null,
      invoiceDue: dateStr(r.invoice_due) ?? legacyBase(r).invoiceDue ?? null,
      invoiceCreated: r.invoice_created ?? legacyBase(r).invoiceCreated ?? false,
      invoiceStatus: r.invoice_status ?? legacyBase(r).invoiceStatus ?? null,
      setupFee: num(r.setup_fee),
      discountPct: num(r.discount_pct),
      salesperson: r.salesperson ?? legacyBase(r).salesperson ?? null,
      preparedBy: r.prepared_by ?? legacyBase(r).preparedBy ?? null,
      poRef: r.po_ref ?? legacyBase(r).poRef ?? null,
      reference: r.reference ?? legacyBase(r).reference ?? null,
      notes: r.notes ?? legacyBase(r).notes ?? null,
      items: items.length ? items : (legacyBase(r).items ?? []),
      payments,
      _relId: r.id,
      _relRowVersion: r.row_version,
    });
  }
  return out;
}

// ── INVOICES (accInvoices) (+ line items + payments) ───────────────────────
export async function buildInvoicesJson(): Promise<any[]> {
  const invRes = await pool.query('SELECT * FROM rel_invoices ORDER BY id');
  const out: any[] = [];
  for (const r of invRes.rows) {
    const linesRes = await pool.query(
      'SELECT * FROM rel_invoice_line_items WHERE invoice_id = $1 ORDER BY line_index', [r.id]
    );
    const items = linesRes.rows.map((l) => ({
      ...legacyBase(l),
      description: l.description,
      qty: num(l.qty),
      unitAmount: num(l.unit_amount),
      accountCode: l.account_code ?? null,
      taxType: l.tax_type ?? null,
    }));
    const payments = await paymentsFor('invoice', r.id);
    out.push({
      ...legacyBase(r),
      id: restoreId(r.source_id),
      number: r.invoice_number,
      co: r.company_code,
      contactName: r.contact_name ?? legacyBase(r).contactName ?? null,
      contactEmail: r.contact_email ?? legacyBase(r).contactEmail ?? null,
      contactAddress: r.contact_address ?? legacyBase(r).contactAddress ?? null,
      jobNum: r.job_number_raw ?? legacyBase(r).jobNum ?? null,
      quoteNum: r.quote_number_raw ?? legacyBase(r).quoteNum ?? null,
      reference: r.reference ?? legacyBase(r).reference ?? null,
      status: r.status ?? legacyBase(r).status ?? null,
      issueDate: dateStr(r.issue_date) ?? legacyBase(r).issueDate ?? null,
      dueDate: dateStr(r.due_date) ?? legacyBase(r).dueDate ?? null,
      items: items.length ? items : (legacyBase(r).items ?? []),
      payments,
      _relId: r.id,
      _relRowVersion: r.row_version,
    });
  }
  return out;
}

// ── CREDIT NOTES ───────────────────────────────────────────────────────────
export async function buildCreditNotesJson(): Promise<any[]> {
  const res = await pool.query('SELECT * FROM rel_credit_notes ORDER BY id');
  return res.rows.map((r) => ({
    ...legacyBase(r),
    id: restoreId(r.source_id),
    number: r.credit_number,
    type: r.note_type,
    client: r.contact_name_raw,
    date: dateStr(r.note_date) ?? legacyBase(r).date ?? null,
    amount: num(r.amount),
    usedAmount: num(r.used_amount),
    reason: r.reason ?? legacyBase(r).reason ?? null,
    appliedTo: r.applied_to ?? legacyBase(r).appliedTo ?? null,
    notes: r.notes ?? legacyBase(r).notes ?? null,
    status: r.status ?? legacyBase(r).status ?? null,
    _relId: r.id,
    _relRowVersion: r.row_version,
  }));
}

// ── PURCHASE ORDERS (+ items) ──────────────────────────────────────────────
export async function buildPurchaseOrdersJson(): Promise<any[]> {
  const poRes = await pool.query('SELECT * FROM rel_purchase_orders ORDER BY id');
  const out: any[] = [];
  for (const r of poRes.rows) {
    const linesRes = await pool.query(
      'SELECT * FROM rel_purchase_order_items WHERE po_id = $1 ORDER BY line_index', [r.id]
    );
    const items = linesRes.rows.map((l) => ({
      ...legacyBase(l),
      sku: l.sku, name: l.name, unit: l.unit,
      qtyNeeded: num(l.qty_needed), qtyOrdered: num(l.qty_ordered), unitCost: num(l.unit_cost),
      inventoryItemId: l.inventory_source_id != null ? restoreId(l.inventory_source_id) : (legacyBase(l).inventoryItemId ?? null),
    }));
    out.push({
      ...legacyBase(r),
      id: restoreId(r.source_id),
      num: r.po_number,
      co: r.company_code,
      supplierId: r.supplier_source_id != null ? restoreId(r.supplier_source_id) : (legacyBase(r).supplierId ?? null),
      jobNum: r.job_number_raw ?? legacyBase(r).jobNum ?? null,
      quoteNum: r.quote_number_raw ?? legacyBase(r).quoteNum ?? null,
      date: dateStr(r.order_date) ?? legacyBase(r).date ?? null,
      status: r.status ?? legacyBase(r).status ?? null,
      notes: r.notes ?? legacyBase(r).notes ?? null,
      items: items.length ? items : (legacyBase(r).items ?? []),
      _relId: r.id,
      _relRowVersion: r.row_version,
    });
  }
  return out;
}

// ── EMPLOYEES / LEAVE / DISCIPLINARY (schema-only tier) ────────────────────
export async function buildEmployeesJson(): Promise<any[]> {
  const res = await pool.query('SELECT * FROM rel_employees ORDER BY id');
  return res.rows.map((r) => ({
    ...legacyBase(r), id: restoreId(r.source_id),
    name: r.full_name ?? legacyBase(r).name ?? null,
    role: r.role ?? legacyBase(r).role ?? null,
    co: r.company_code ?? legacyBase(r).co ?? null,
    _relId: r.id, _relRowVersion: r.row_version,
  }));
}
export async function buildLeaveRequestsJson(): Promise<any[]> {
  const res = await pool.query('SELECT * FROM rel_leave_requests ORDER BY id');
  return res.rows.map((r) => ({
    ...legacyBase(r), id: restoreId(r.source_id),
    employeeId: r.employee_source_id != null ? restoreId(r.employee_source_id) : (legacyBase(r).employeeId ?? null),
    startDate: dateStr(r.start_date) ?? legacyBase(r).startDate ?? null,
    endDate: dateStr(r.end_date) ?? legacyBase(r).endDate ?? null,
    status: r.status ?? legacyBase(r).status ?? null,
    _relId: r.id, _relRowVersion: r.row_version,
  }));
}
export async function buildDisciplinaryJson(): Promise<any[]> {
  const res = await pool.query('SELECT * FROM rel_disciplinary_records ORDER BY id');
  return res.rows.map((r) => ({
    ...legacyBase(r), id: restoreId(r.source_id),
    employeeId: r.employee_source_id != null ? restoreId(r.employee_source_id) : (legacyBase(r).employeeId ?? null),
    date: dateStr(r.record_date) ?? legacyBase(r).date ?? null,
    notes: r.notes ?? legacyBase(r).notes ?? null,
    _relId: r.id, _relRowVersion: r.row_version,
  }));
}

// Maps a CutoverSection to the platform_state.data KEY it is authoritative
// for, and the builder that assembles it. `payments` deliberately has NO
// entry here — see the handoff "known limitations" note: payments are an
// embedded sub-array on job/quote/accInvoices records, not a standalone
// platform_state section, so their authority is carried by whichever of
// those three owns them, not by this flag independently (the flag still
// exists and is exercised by the generic double-gate tests, it just has no
// separate code path here).
export const SECTION_JSON_KEY: Partial<Record<CutoverSection, string>> = {
  customers: 'customers',
  suppliers: 'suppliers',
  inventory: 'inventory',
  quickRates: 'quickRates',
  quotes: 'quotes',
  jobs: 'jobs',
  accInvoices: 'accInvoices',
  creditNotes: 'creditNotes',
  purchaseOrders: 'purchaseOrders',
  employees: 'employees',
  leaveRequests: 'leaveRequests',
  disciplinary: 'disciplinary',
};

const BUILDERS: Partial<Record<CutoverSection, () => Promise<any[]>>> = {
  customers: buildCustomersJson,
  suppliers: buildSuppliersJson,
  inventory: buildInventoryJson,
  quickRates: buildQuickRatesJson,
  quotes: buildQuotesJson,
  jobs: buildJobsJson,
  accInvoices: buildInvoicesJson,
  creditNotes: buildCreditNotesJson,
  purchaseOrders: buildPurchaseOrdersJson,
  employees: buildEmployeesJson,
  leaveRequests: buildLeaveRequestsJson,
  disciplinary: buildDisciplinaryJson,
};

/** Assemble the JSON-compatible array for ONE cut-over section. Caller must
 *  already know the section is cut over — this function does not check. */
export async function getAuthoritativeJson(section: CutoverSection): Promise<any[]> {
  const builder = BUILDERS[section];
  if (!builder) return [];
  return builder();
}
