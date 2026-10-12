/**
 * Data access for /api/v1/integration.
 *
 * AUTHORITY RULE (unchanged from the rest of the platform): a section is read
 * from the relational tables only when it is cut over under the existing
 * double gate (RELATIONAL_AUTHORITY_ENABLED=true AND relational_cutover row
 * enabled — relational/cutover.ts). Otherwise platform_state JSON is the
 * authority. One deliberate difference from GET /api/platform-state: if a
 * section's cutover row is enabled but the master switch is off (the frozen-
 * copy situation index.ts warns about at startup), or the relational read
 * fails, this API REFUSES instead of falling back to the frozen JSON copy —
 * an assistant quoting from stale stock or prices is worse than no answer.
 *
 * Writes: only quotes, only through relational/services.ts (createQuote /
 * updateQuote, used as-is), and only when 'quotes' is cut over.
 */
import { query } from '../db/pool';
import { isSectionCutOver, CutoverSection } from '../relational/cutover';
import { getAuthoritativeJson, SECTION_JSON_KEY, restoreId } from '../relational/read';
import { IntegrationError } from './errors';

export type SectionSource = 'relational' | 'platform_state';

async function cutoverRowEnabled(section: CutoverSection): Promise<boolean> {
  const r = await query('SELECT enabled FROM relational_cutover WHERE section = $1', [section]);
  return r.rows[0]?.enabled === true;
}

export async function sectionAuthority(section: CutoverSection): Promise<SectionSource | 'inconsistent'> {
  if (await isSectionCutOver(section)) return 'relational';
  if (await cutoverRowEnabled(section)) return 'inconsistent';
  return 'platform_state';
}

export async function loadSection(section: CutoverSection): Promise<{ items: any[]; source: SectionSource }> {
  const authority = await sectionAuthority(section);
  if (authority === 'inconsistent') {
    throw new IntegrationError(503, 'SECTION_AUTHORITY_MISMATCH',
      `Signacore ${section} data is in an inconsistent cutover state, so it cannot be served reliably right now.`);
  }
  if (authority === 'relational') {
    try {
      return { items: await getAuthoritativeJson(section), source: 'relational' };
    } catch (err) {
      console.error(`[integration] relational read failed for ${section}:`, (err as Error)?.message || err);
      throw new IntegrationError(503, 'SECTION_UNAVAILABLE', `Signacore ${section} data is temporarily unavailable.`);
    }
  }
  const key = SECTION_JSON_KEY[section];
  const r = await query('SELECT data -> $1 AS v FROM platform_state WHERE id = 1', [key]);
  const v = r.rows[0]?.v;
  return { items: Array.isArray(v) ? v : [], source: 'platform_state' };
}

// ── Customers ──────────────────────────────────────────────────────────────
// The live customer record (platform_state.customers) holds:
// id, companyName, contactPerson, email, tel, address, vatNumber, notes.
// `notes` is internal and never returned. There is no account number,
// trading name, payment terms or delivery address in the live model.

const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

export function customerSummary(c: any) {
  return {
    id: String(c.id),
    companyName: str(c.companyName),
    contactPerson: str(c.contactPerson),
    email: str(c.email),
    phone: str(c.tel ?? c.phone),
    vatNumber: str(c.vatNumber),
  };
}
export function customerDetail(c: any) {
  return { ...customerSummary(c), address: str(c.address) };
}

const digits = (s: unknown) => String(s ?? '').replace(/\D+/g, '');

export function searchCustomers(items: any[], q: string, limit: number) {
  const needle = q.toLowerCase();
  const d = digits(q);
  const scored: Array<{ c: any; score: number }> = [];
  for (const c of items) {
    if (!c || c.id === undefined || c.id === null) continue;
    let score = 0;
    if (String(c.id) === q) score = 100;
    const name = String(c.companyName || '').toLowerCase();
    if (name === needle) score = Math.max(score, 90);
    else if (name.startsWith(needle)) score = Math.max(score, 70);
    else if (name.includes(needle)) score = Math.max(score, 50);
    if (String(c.contactPerson || '').toLowerCase().includes(needle)) score = Math.max(score, 40);
    if (String(c.email || '').toLowerCase() === needle) score = Math.max(score, 95);
    else if (needle.length >= 4 && String(c.email || '').toLowerCase().includes(needle)) score = Math.max(score, 45);
    if (d.length >= 6 && digits(c.tel ?? c.phone).includes(d)) score = Math.max(score, 80);
    if (needle.length >= 4 && String(c.vatNumber || '').toLowerCase() === needle) score = Math.max(score, 85);
    if (score > 0) scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score || String(a.c.companyName || '').localeCompare(String(b.c.companyName || '')));
  return scored.slice(0, limit).map((s) => ({ ...customerSummary(s.c), matchScore: s.score }));
}

// ── Products (inventory items + quick rates) ───────────────────────────────
export type ProductSource = 'inventory' | 'quickRates';
export const PRODUCT_REF_RE = /^(inv|qr):([A-Za-z0-9._-]{1,40})$/;

export function productRef(source: ProductSource, id: unknown): string {
  return `${source === 'inventory' ? 'inv' : 'qr'}:${String(id)}`;
}

export function stockStatus(source: ProductSource, item: any): string {
  if (source !== 'inventory') return 'not_tracked';
  const stock = Number(item.stock) || 0;
  const reorder = Number(item.reorder) || 0;
  if (stock <= 0) return 'out_of_stock';
  if (reorder > 0 && stock <= reorder) return 'low';
  return 'in_stock';
}

/** Shapes a product for a client. Cost price is never included — no scope grants it. */
export function productView(source: ProductSource, item: any, opts: { pricing: boolean; inventory: boolean }, sectionSource: SectionSource) {
  const out: Record<string, unknown> = {
    ref: productRef(source, item.id),
    source,
    sku: str(item.sku),
    name: str(item.name),
    category: str(item.cat ?? item.category),
    unit: str(item.unit),
    active: item.active !== false,
    dataSource: sectionSource,
  };
  if (opts.pricing) {
    const sell = Number(item.sell);
    out.pricing = {
      sellPriceExVat: Number.isFinite(sell) && sell > 0 ? Math.round(sell * 10000) / 10000 : null,
      vatRatePct: 15,
      priceSet: Number.isFinite(sell) && sell > 0,
      currency: 'ZAR',
    };
  }
  if (opts.inventory) {
    out.stock = source === 'inventory'
      ? { tracked: true, onHand: Number(item.stock) || 0, reorderLevel: Number(item.reorder) || 0, unit: str(item.unit), status: stockStatus(source, item), reserved: null, availableToPromise: null }
      : { tracked: false, status: 'not_tracked' };
  }
  return out;
}

export async function loadProducts(): Promise<{ inventory: { items: any[]; source: SectionSource }; quickRates: { items: any[]; source: SectionSource } }> {
  const [inventory, quickRates] = await Promise.all([loadSection('inventory'), loadSection('quickRates')]);
  return { inventory, quickRates };
}

export function searchProducts(
  all: Awaited<ReturnType<typeof loadProducts>>,
  q: string, category: string | null, source: ProductSource | null, limit: number
): Array<{ source: ProductSource; item: any; sectionSource: SectionSource }> {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const cat = category ? category.toLowerCase() : null;
  const pool: Array<{ source: ProductSource; item: any; sectionSource: SectionSource }> = [];
  if (!source || source === 'inventory') for (const i of all.inventory.items) if (i && i.active !== false) pool.push({ source: 'inventory', item: i, sectionSource: all.inventory.source });
  if (!source || source === 'quickRates') for (const i of all.quickRates.items) if (i) pool.push({ source: 'quickRates', item: i, sectionSource: all.quickRates.source });
  const hay = (i: any) => [i.name, i.cat ?? i.category, i.sku].map((x) => String(x || '').toLowerCase()).join(' ');
  const res: Array<{ p: (typeof pool)[number]; score: number }> = [];
  for (const p of pool) {
    if (cat && String(p.item.cat ?? p.item.category ?? '').toLowerCase() !== cat) continue;
    if (!words.length) { res.push({ p, score: 1 }); continue; }
    const h = hay(p.item);
    const sku = String(p.item.sku || '').toLowerCase();
    let score = 0;
    if (words.length === 1 && sku && sku === words[0]) score = 100;
    else if (words.every((w) => h.includes(w))) score = 60;
    else if (words.some((w) => h.includes(w))) score = 20;
    if (score) res.push({ p, score });
  }
  res.sort((a, b) => b.score - a.score || String(a.p.item.name || '').localeCompare(String(b.p.item.name || '')));
  return res.slice(0, limit).map((r) => r.p);
}

export function findProduct(all: Awaited<ReturnType<typeof loadProducts>>, ref: string):
  { source: ProductSource; item: any; sectionSource: SectionSource } | null {
  const m = PRODUCT_REF_RE.exec(ref);
  if (!m) return null;
  const source: ProductSource = m[1] === 'inv' ? 'inventory' : 'quickRates';
  const sect = source === 'inventory' ? all.inventory : all.quickRates;
  const item = sect.items.find((i: any) => i && String(i.id) === m[2]);
  return item ? { source, item, sectionSource: sect.source } : null;
}

// ── Quotes (relational only) ───────────────────────────────────────────────
export const QUOTE_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft', sent: 'Sent', approved: 'Approved', declined: 'Declined', converted: 'Job Created',
};

const money = (v: unknown) => Math.round((Number(v) || 0) * 100) / 100;
const dateOnly = (d: unknown): string | null => {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
};

export async function getQuoteRow(id: number, companyCode: string): Promise<any | null> {
  const r = await query('SELECT * FROM rel_quotes WHERE id = $1 AND company_code = $2', [id, companyCode]);
  return r.rows[0] || null;
}

export async function quoteView(q: any, clientId: string) {
  const lines = await query(
    'SELECT * FROM rel_quote_line_items WHERE quote_id = $1 ORDER BY line_index', [q.id]
  );
  const owned = await isRecordOwned(clientId, Number(q.id));
  const status = q.status || 'draft';
  return {
    id: Number(q.id),
    quoteNumber: q.quote_number,
    companyCode: q.company_code,
    status,
    statusLabel: QUOTE_STATUS_LABELS[status] || status,
    // Same rule PATCH /quotes/:id enforces (router.ts): owned, draft, no job, no proforma.
    editableByClient: owned && status === 'draft' && !q.converted_job_id && !q.proforma_num,
    createdByThisClient: owned,
    customer: { name: q.customer_name_raw, contactPerson: q.contact_person, email: q.email, phone: q.phone, vatNumber: q.vat_number },
    reference: q.reference, poRef: q.po_ref, notes: q.notes,
    quoteDate: dateOnly(q.quote_date), validUntil: dateOnly(q.valid_until),
    lines: lines.rows.map((l: any) => ({
      index: l.line_index,
      description: l.description,
      qty: Number(l.qty),
      pieces: l.pieces === null || l.pieces === undefined ? null : Number(l.pieces),
      unit: l.unit ?? null,
      unitPriceExVat: Number(l.unit_price),
      lineSubtotalExVat: money(l.subtotal),
      productRef: l.inventory_source_id ? productRef('inventory', restoreId(l.inventory_source_id)) : null,
    })),
    totals: {
      subtotalExVat: money(q.subtotal),
      discountPct: Number(q.discount_pct) || 0,
      setupFee: money(q.setup_fee),
      vatAmount: money(q.vat_amount),
      totalInclVat: money(q.total),
      depositPct: q.deposit_pct === null || q.deposit_pct === undefined ? null : Number(q.deposit_pct),
      currency: 'ZAR',
      calculatedBy: 'signacore',
    },
    converted: Boolean(q.converted_job_id),
    rowVersion: Number(q.row_version),
    createdAt: q.created_at, updatedAt: q.updated_at,
  };
}

export async function searchQuotes(companyCode: string, clientId: string, f: { q: string | null; status: string | null; createdByThisClient: boolean; externalRef: string | null; limit: number }) {
  const where: string[] = ['q.company_code = $1'];
  const vals: unknown[] = [companyCode];
  if (f.q) {
    vals.push(`%${f.q.toLowerCase()}%`);
    const i = vals.length;
    where.push(`(LOWER(q.quote_number) LIKE $${i} OR LOWER(COALESCE(q.customer_name_raw,'')) LIKE $${i} OR LOWER(COALESCE(q.reference,'')) LIKE $${i} OR LOWER(COALESCE(q.po_ref,'')) LIKE $${i})`);
  }
  if (f.status) { vals.push(f.status); where.push(`COALESCE(q.status,'draft') = $${vals.length}`); }
  if (f.createdByThisClient || f.externalRef) {
    vals.push(clientId);
    const c = vals.length;
    let sub = `SELECT record_id FROM integration_records WHERE client_id = $${c} AND record_type = 'quote'`;
    if (f.externalRef) { vals.push(f.externalRef); sub += ` AND external_ref = $${vals.length}`; }
    where.push(`q.id IN (${sub})`);
  }
  vals.push(f.limit);
  const r = await query(
    `SELECT q.id, q.quote_number, q.status, q.customer_name_raw, q.reference, q.quote_date, q.valid_until, q.total, q.updated_at
       FROM rel_quotes q WHERE ${where.join(' AND ')}
      ORDER BY q.id DESC LIMIT $${vals.length}`, vals
  );
  return r.rows.map((q: any) => ({
    id: Number(q.id), quoteNumber: q.quote_number, status: q.status || 'draft',
    statusLabel: QUOTE_STATUS_LABELS[q.status || 'draft'] || q.status,
    customerName: q.customer_name_raw, reference: q.reference,
    quoteDate: dateOnly(q.quote_date), validUntil: dateOnly(q.valid_until),
    totalInclVat: money(q.total), updatedAt: q.updated_at,
  }));
}

// ── Ownership records ──────────────────────────────────────────────────────
export async function isRecordOwned(clientId: string, quoteId: number): Promise<boolean> {
  const r = await query(
    `SELECT 1 FROM integration_records WHERE client_id = $1 AND record_type = 'quote' AND record_id = $2`, [clientId, quoteId]
  );
  return (r.rowCount ?? 0) > 0;
}

export async function recordOwnership(clientId: string, quoteId: number, externalRef: string, key: string): Promise<void> {
  if (__testHooks.beforeRecordOwnership) await __testHooks.beforeRecordOwnership();
  await query(
    `INSERT INTO integration_records (client_id, record_type, record_id, external_ref, idempotency_key)
     VALUES ($1, 'quote', $2, $3, $4) ON CONFLICT (client_id, record_type, record_id) DO NOTHING`,
    [clientId, quoteId, externalRef, key]
  );
}

/** Open quotes this client already created for the same external reference (duplicate guard). */
export async function openQuotesForRef(clientId: string, externalRef: string, companyCode: string) {
  const r = await query(
    `SELECT q.id, q.quote_number, COALESCE(q.status,'draft') AS status
       FROM integration_records ir JOIN rel_quotes q ON q.id = ir.record_id
      WHERE ir.client_id = $1 AND ir.record_type = 'quote' AND ir.external_ref = $2 AND q.company_code = $3
        AND COALESCE(q.status,'draft') NOT IN ('declined','converted') AND q.converted_job_id IS NULL
      ORDER BY q.id`, [clientId, externalRef, companyCode]
  );
  return r.rows.map((x: any) => ({ id: Number(x.id), quoteNumber: x.quote_number, status: x.status }));
}

/** Recovery for a create whose idempotency row was left in_progress (e.g. a crash after COMMIT). */
export async function findQuoteByRequestMarker(marker: string, companyCode: string): Promise<number | null> {
  const r = await query(
    `SELECT id FROM rel_quotes WHERE company_code = $1 AND POSITION($2 IN COALESCE(notes,'')) > 0 ORDER BY id LIMIT 1`,
    [companyCode, marker]
  );
  return r.rows[0] ? Number(r.rows[0].id) : null;
}

// ── Test seams ─────────────────────────────────────────────────────────────
/**
 * TEST-ONLY hooks used by test/integration-api.stress.ts to reproduce races
 * deterministically (no sleeps). Nothing in src/ ever sets these; when unset
 * (always, in production) they cost one property read and change nothing.
 */
export const __testHooks: {
  /** Runs after the idempotency INSERT conflicted and before the follow-up SELECT. */
  afterIdempotencyConflict?: (clientId: string, key: string) => Promise<void>;
  /** Runs at the start of recordOwnership(); a throw simulates the INSERT failing. */
  beforeRecordOwnership?: () => Promise<void>;
  /** Runs in PATCH /quotes/:id after the update committed, before the read-back; a throw simulates the read-back failing. */
  beforeUpdateReadback?: () => Promise<void>;
} = {};

// ── Idempotency ────────────────────────────────────────────────────────────
export type IdemBegin =
  | { state: 'new' }
  | { state: 'mismatch' }
  | { state: 'completed'; status: number; body: any }
  | { state: 'in_progress'; ageMs: number };

export async function beginIdempotent(clientId: string, key: string, operation: string, hash: string): Promise<IdemBegin> {
  const ins = await query(
    `INSERT INTO integration_idempotency (client_id, idempotency_key, operation, request_hash, state)
     VALUES ($1,$2,$3,$4,'in_progress') ON CONFLICT (client_id, idempotency_key) DO NOTHING RETURNING 1`,
    [clientId, key, operation, hash]
  );
  // 'new' is returned ONLY here: this request's own INSERT created the
  // in_progress row, so it alone owns the reservation.
  if ((ins.rowCount ?? 0) > 0) return { state: 'new' };
  if (__testHooks.afterIdempotencyConflict) await __testHooks.afterIdempotencyConflict(clientId, key);
  const r = await query(
    `SELECT operation, request_hash, state, response_status, response_body, EXTRACT(EPOCH FROM (NOW() - updated_at)) * 1000 AS age_ms
       FROM integration_idempotency WHERE client_id = $1 AND idempotency_key = $2`, [clientId, key]
  );
  const row = r.rows[0];
  // The conflicting row vanished between the INSERT and this SELECT (another
  // request released it). This request did NOT acquire the reservation, so it
  // must not proceed: report it as in progress (ageMs 0 never qualifies for
  // stale recovery) and the router answers 409 IDEMPOTENCY_IN_PROGRESS. The
  // caller's next retry with the same key acquires the key normally.
  if (!row) return { state: 'in_progress', ageMs: 0 };
  if (row.operation !== operation || row.request_hash !== hash) return { state: 'mismatch' };
  if (row.state === 'completed') return { state: 'completed', status: Number(row.response_status), body: row.response_body };
  return { state: 'in_progress', ageMs: Number(row.age_ms) || 0 };
}

export async function completeIdempotent(clientId: string, key: string, status: number, body: unknown): Promise<void> {
  await query(
    `UPDATE integration_idempotency SET state = 'completed', response_status = $3, response_body = $4, updated_at = NOW()
      WHERE client_id = $1 AND idempotency_key = $2`,
    [clientId, key, status, JSON.stringify(body)]
  );
}

/** Only for failures where it is certain nothing was written (the service transaction rolled back). */
export async function releaseIdempotent(clientId: string, key: string): Promise<void> {
  await query(`DELETE FROM integration_idempotency WHERE client_id = $1 AND idempotency_key = $2 AND state = 'in_progress'`, [clientId, key]);
}
