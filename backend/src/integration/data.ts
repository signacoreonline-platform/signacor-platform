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
 * Writes:
 *  - quotes: only through relational/services.ts (createQuote / updateQuote,
 *    used as-is), and only when 'quotes' is cut over;
 *  - customers: only create + allow-listed field update of platform_state
 *    customers (the customers authority), and only while 'customers' is NOT
 *    cut over — see "Customer writes" below.
 */
import crypto from 'crypto';
import pool, { query } from '../db/pool';
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
  return { ...customerSummary(c), address: str(c.address), version: customerVersion(c) };
}

/**
 * Optimistic-concurrency token for a JSON customer record (platform_state has
 * no row_version). It is the SHA-256 of the record's id and its allow-listed
 * contact/billing fields — exactly the fields an integration client can see
 * and change — so a dashboard edit to any of them makes a stale update fail,
 * while an edit to the internal `notes` field (never visible to, never written
 * by, the integration) does not block Sally.
 */
export function customerVersion(c: any): string {
  const view = {
    id: String(c?.id ?? ''),
    companyName: str(c?.companyName), contactPerson: str(c?.contactPerson), email: str(c?.email),
    tel: str(c?.tel ?? c?.phone), address: str(c?.address), vatNumber: str(c?.vatNumber),
  };
  return crypto.createHash('sha256').update(JSON.stringify(view)).digest('hex').slice(0, 32);
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

// ── Customer writes (customer:create / customer:update) ────────────────────
// Customers are platform_state-authoritative (they are one of the sections
// permanently hard-blocked from relational cutover — see index.html's
// CustomersPage.handleSave and relational/cutoverCli.ts). Integration writes
// therefore go to the SAME storage the dashboard uses: platform_state.data
// .customers, with the same record shape the dashboard's AddEditCustomerModal
// produces ({ id: Date.now(), companyName, contactPerson, vatNumber, address,
// email, tel, notes }) and the same safety rules as PUT /api/platform-state:
//   - the single platform_state row is locked (SELECT … FOR UPDATE);
//   - the full previous state is copied to platform_state_backups FIRST (a
//     failed backup aborts the write);
//   - ONLY the `customers` array is replaced (jsonb_set) — no other section is
//     rewritten, so a concurrent dashboard save of another section is safe;
//   - updated_at is bumped, so a dashboard tab holding a stale copy of the
//     customer gets the dashboard's normal "changed elsewhere" 409;
//   - no new duplicate id can be created, and a customer id that already has
//     duplicate copies (historical collisions) is never edited.
// Nothing here deletes, merges or re-ids a customer, and `notes` (internal) is
// never read back to the client or written.

/** Fields an integration client may set on a customer, in the dashboard's own names. */
export interface CustomerFieldsIn {
  companyName?: string;
  contactPerson?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  vatNumber?: string | null;
}

const normName = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/[\s.,'"()-]+/g, ' ').replace(/\s+/g, ' ').trim();
const normEmail = (s: unknown) => String(s ?? '').trim().toLowerCase();
const normVat = (s: unknown) => String(s ?? '').replace(/[\s./-]+/g, '').toLowerCase();
/** Last 9 digits, so "+27 82 555 0101" and "082 555 0101" compare equal. */
const normPhone = (s: unknown) => { const d = digits(s); return d.length >= 7 ? d.slice(-9) : ''; };

export type DuplicateSignal = 'company_name' | 'email' | 'vat_number' | 'phone';

/**
 * Deterministic duplicate detection on the authoritative customer list. A
 * candidate is any existing customer sharing at least one exact, normalised
 * signal (company name, email, VAT number, phone). Never merges — the caller
 * decides. Mirrors (and tightens) the dashboard's own "matching name / email /
 * VAT / phone" warning in AddEditCustomerModal.
 */
export function duplicateCandidates(items: any[], input: CustomerFieldsIn, excludeId?: string) {
  const name = normName(input.companyName);
  const email = normEmail(input.email);
  const vat = normVat(input.vatNumber);
  const phone = normPhone(input.phone);
  const out: Array<ReturnType<typeof customerSummary> & { matchedOn: DuplicateSignal[] }> = [];
  for (const c of items) {
    if (!c || c.id === undefined || c.id === null) continue;
    if (excludeId !== undefined && String(c.id) === excludeId) continue;
    const matchedOn: DuplicateSignal[] = [];
    if (name && normName(c.companyName) === name) matchedOn.push('company_name');
    if (email && normEmail(c.email) === email) matchedOn.push('email');
    if (vat.length >= 4 && normVat(c.vatNumber) === vat) matchedOn.push('vat_number');
    if (phone && normPhone(c.tel ?? c.phone) === phone) matchedOn.push('phone');
    if (matchedOn.length) out.push({ ...customerSummary(c), matchedOn });
  }
  out.sort((a, b) => b.matchedOn.length - a.matchedOn.length || String(a.companyName || '').localeCompare(String(b.companyName || '')));
  return out.slice(0, 10);
}

function arrayCounts(data: Record<string, any>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(data || {})) if (Array.isArray(v)) counts[k] = v.length;
  return counts;
}

export type CustomerWriteResult = { customer: any } | { duplicates: ReturnType<typeof duplicateCandidates> };

type LockedCustomers = { customers: any[]; client: import('pg').PoolClient };

/**
 * Runs `fn` with the platform_state row locked. If `fn` returns `next`, the
 * previous state is backed up and ONLY data.customers is replaced with `next`,
 * then `afterWrite` runs in the same transaction (e.g. the ownership record).
 * Any throw rolls everything back — nothing is half-written.
 */
async function withCustomersLocked<T>(
  clientId: string, reason: string,
  fn: (ctx: LockedCustomers) => Promise<{ next: any[] | null; result: T; afterWrite?: (c: import('pg').PoolClient) => Promise<void> }>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT data FROM platform_state WHERE id = 1 FOR UPDATE');
    if (!r.rowCount) throw new IntegrationError(503, 'SECTION_UNAVAILABLE', 'Signacore customer data is temporarily unavailable.');
    const data: Record<string, any> = r.rows[0].data || {};
    const customers = Array.isArray(data.customers) ? data.customers : [];
    const out = await fn({ customers, client });
    if (out.next) {
      const serialized = JSON.stringify(data);
      await client.query(
        `INSERT INTO platform_state_backups (data, reason, data_size_bytes, record_counts, source)
         VALUES ($1::jsonb, $2, $3, $4::jsonb, $5)`,
        [serialized, reason, Buffer.byteLength(serialized, 'utf8'), JSON.stringify(arrayCounts(data)), `integration:${clientId}`]
      );
      await client.query(
        `DELETE FROM platform_state_backups WHERE id IN (SELECT id FROM platform_state_backups ORDER BY created_at DESC OFFSET 100)`
      ).catch(() => undefined);
      await client.query(
        `UPDATE platform_state SET data = jsonb_set(data, '{customers}', $1::jsonb, true), updated_at = NOW() WHERE id = 1`,
        [JSON.stringify(out.next)]
      );
      if (out.afterWrite) await out.afterWrite(client);
    }
    await client.query('COMMIT');
    return out.result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Refuses customer writes unless customers are (still) platform_state-authoritative. */
export async function requireCustomersWritable(): Promise<void> {
  const a = await sectionAuthority('customers');
  if (a !== 'platform_state') {
    throw new IntegrationError(409, 'SECTION_NOT_WRITABLE',
      'Customers are not writable through the integration API on this server (customer data is not in its JSON authority state).');
  }
}

function newCustomerId(existing: any[]): number {
  const taken = new Set(existing.map((c) => String(c?.id)));
  let id = Date.now();
  while (taken.has(String(id))) id += 1;
  return id;
}

/** Same blank-as-'' shape the dashboard's AddEditCustomerModal saves. */
function textOrBlank(v: string | null | undefined): string {
  return v === null || v === undefined ? '' : String(v);
}

export async function findCustomerCreatedByKey(clientId: string, key: string): Promise<string | null> {
  const r = await query(
    `SELECT record_id FROM integration_records WHERE client_id = $1 AND record_type = 'customer' AND idempotency_key = $2 LIMIT 1`,
    [clientId, key]
  );
  return r.rows[0] ? String(r.rows[0].record_id) : null;
}

/**
 * Creates one customer. The duplicate check is repeated INSIDE the lock, so two
 * concurrent creates of the same company cannot both pass it. The ownership
 * record (with the idempotency key) is written in the SAME transaction as the
 * customer, so a stale in-progress request can always be recovered exactly.
 */
export async function createCustomerJson(
  clientId: string, key: string, externalRef: string | null, input: CustomerFieldsIn, opts: { allowDuplicateOf: string[] }
): Promise<CustomerWriteResult> {
  return withCustomersLocked<CustomerWriteResult>(clientId, 'before-integration-customer-create', async ({ customers }) => {
    const dupes = duplicateCandidates(customers, input);
    const unacknowledged = dupes.filter((d) => !opts.allowDuplicateOf.includes(d.id));
    if (unacknowledged.length) return { next: null, result: { duplicates: dupes } };
    const record = {
      id: newCustomerId(customers),
      companyName: String(input.companyName || '').trim(),
      contactPerson: textOrBlank(input.contactPerson),
      vatNumber: textOrBlank(input.vatNumber),
      address: textOrBlank(input.address),
      email: textOrBlank(input.email),
      tel: textOrBlank(input.phone),
      notes: '',
    };
    return {
      next: [record, ...customers], // the dashboard also prepends new customers
      result: { customer: record },
      afterWrite: async (c) => {
        await c.query(
          `INSERT INTO integration_records (client_id, record_type, record_id, external_ref, idempotency_key)
           VALUES ($1, 'customer', $2, $3, $4) ON CONFLICT (client_id, record_type, record_id) DO NOTHING`,
          [clientId, record.id, externalRef, key]
        );
      },
    };
  });
}

/**
 * Updates the allow-listed fields of one customer, only if its current version
 * still equals `expectedVersion`. Every other property of the record (notes,
 * id, anything the dashboard added) is preserved exactly.
 */
export async function updateCustomerJson(
  clientId: string, id: string, expectedVersion: string, patch: CustomerFieldsIn, opts: { allowDuplicateOf: string[] }
): Promise<CustomerWriteResult> {
  return withCustomersLocked<CustomerWriteResult>(clientId, 'before-integration-customer-update', async ({ customers }) => {
    const matches = customers.filter((c: any) => c && String(c.id) === id);
    if (!matches.length) throw new IntegrationError(404, 'NOT_FOUND', 'Customer not found in Signacore.');
    if (matches.length > 1) {
      throw new IntegrationError(409, 'AMBIGUOUS_CUSTOMER_ID',
        'This customer id is shared by more than one Signacore record (a historical collision). Edit it in Signacore itself.');
    }
    const current = matches[0];
    if (customerVersion(current) !== expectedVersion) {
      throw new IntegrationError(409, 'STALE_VERSION', 'The customer changed in Signacore since it was last read. Reload it and try again.');
    }
    const merged = {
      companyName: patch.companyName !== undefined ? patch.companyName : current.companyName,
      email: patch.email !== undefined ? patch.email : current.email,
      vatNumber: patch.vatNumber !== undefined ? patch.vatNumber : current.vatNumber,
      phone: patch.phone !== undefined ? patch.phone : (current.tel ?? current.phone),
    };
    const identityChanged = ['companyName', 'email', 'vatNumber', 'phone'].some((k) => (patch as any)[k] !== undefined);
    if (identityChanged) {
      const dupes = duplicateCandidates(customers, merged, id);
      const unacknowledged = dupes.filter((d) => !opts.allowDuplicateOf.includes(d.id));
      if (unacknowledged.length) return { next: null, result: { duplicates: dupes } };
    }
    const updated = { ...current };
    if (patch.companyName !== undefined) updated.companyName = String(patch.companyName || '').trim();
    if (patch.contactPerson !== undefined) updated.contactPerson = textOrBlank(patch.contactPerson);
    if (patch.email !== undefined) updated.email = textOrBlank(patch.email);
    if (patch.phone !== undefined) updated.tel = textOrBlank(patch.phone);
    if (patch.address !== undefined) updated.address = textOrBlank(patch.address);
    if (patch.vatNumber !== undefined) updated.vatNumber = textOrBlank(patch.vatNumber);
    if (customerVersion(updated) === customerVersion(current)) {
      return { next: null, result: { customer: current } }; // nothing actually changes — no write, no backup
    }
    return { next: customers.map((c: any) => (c === current ? updated : c)), result: { customer: updated } };
  });
}

/** True when `c` already carries exactly the values `patch` asks for (used to recover a stuck update). */
export function customerMatchesPatch(c: any, patch: CustomerFieldsIn): boolean {
  const same = (a: unknown, b: unknown) => String(a ?? '').trim() === String(b ?? '').trim();
  if (patch.companyName !== undefined && !same(c.companyName, patch.companyName)) return false;
  if (patch.contactPerson !== undefined && !same(c.contactPerson, patch.contactPerson)) return false;
  if (patch.email !== undefined && !same(c.email, patch.email)) return false;
  if (patch.phone !== undefined && !same(c.tel ?? c.phone, patch.phone)) return false;
  if (patch.address !== undefined && !same(c.address, patch.address)) return false;
  if (patch.vatNumber !== undefined && !same(c.vatNumber, patch.vatNumber)) return false;
  return true;
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
