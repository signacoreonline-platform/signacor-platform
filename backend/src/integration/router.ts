/**
 * /api/v1/integration — versioned, scoped server-to-server API.
 * First client: Sally (AI Sales Assistant). See docs in
 * backend/src/integration/README.md.
 *
 * Every business rule that matters is enforced HERE, server-side, no matter
 * what the client sends:
 *   - prices come from the authoritative inventory / quick-rate record; a
 *     request carrying any price, total, discount, setup fee or status is
 *     refused (no overrides of any kind);
 *   - quotes are created as 'draft' only, in the client's own company;
 *   - only DRAFT quotes that THIS client created (and that have no proforma
 *     and no job) can be edited; nothing can be deleted, sent, approved,
 *     declined or converted through this API;
 *   - totals and VAT are calculated by relational/services.ts (createQuote /
 *     updateQuoteWithJobSync, used as-is) and read back from the database;
 *   - customers (customer:create / customer:update only): allow-listed contact
 *     and billing fields, a deterministic duplicate check that never merges,
 *     optimistic concurrency on update, written to the customers authority
 *     (platform_state) with a backup first; never notes, ids or deletes;
 *   - every mutation needs an Idempotency-Key, so a retry can never create a
 *     second quote or a second customer.
 */
import { Router, Response, NextFunction } from 'express';
import { query } from '../db/pool';
import {
  createQuote, updateQuoteWithJobSync, BusinessRuleError, ConcurrencyConflictError, LegacyInvoiceConflictError,
} from '../relational/services';
import { integrationAuth, requireScope, hasScope, IntegrationRequest } from './auth';
import { IntegrationError, bad, sendError } from './errors';
import { requestHash } from './keys';
import * as data from './data';

const router = Router();

type Handler = (req: IntegrationRequest, res: Response) => Promise<void>;
const op = (name: string, fn: Handler) => async (req: IntegrationRequest, res: Response, next: NextFunction) => {
  res.locals.operation = name;
  try { await fn(req, res); }
  catch (err) {
    if (err instanceof IntegrationError) return sendError(res, err);
    console.error(`[integration] ${name} failed:`, (err as Error)?.message || err);
    return sendError(res, new IntegrationError(500, 'INTERNAL', 'Signacore could not complete the request.'));
  }
  void next;
};

// Everything below requires a valid integration client.
router.use(integrationAuth);

// ── validation helpers ─────────────────────────────────────────────────────
const PRICE_LIKE = ['unitPrice', 'unit_price', 'price', 'sell', 'cost', 'subtotal', 'total', 'vat', 'vatAmount',
  'discount', 'discountPct', 'setupFee', 'margin', 'status', 'companyCode', 'customerNameRaw', 'depositPct', 'terms'];

function assertOnlyKeys(obj: Record<string, unknown>, allowed: string[], where: string): void {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (!extra.length) return;
  const priceLike = extra.filter((k) => PRICE_LIKE.includes(k));
  if (priceLike.length) {
    throw new IntegrationError(403, 'FIELD_NOT_PERMITTED',
      `${where} may not set ${priceLike.join(', ')} — prices, totals, discounts and status are controlled by Signacore.`, { fields: priceLike });
  }
  throw bad(`${where} contains fields that are not accepted: ${extra.join(', ')}.`, { fields: extra });
}

function optText(v: unknown, field: string, max: number): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') throw bad(`"${field}" must be text.`);
  const t = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  if (t.length > max) throw bad(`"${field}" must be at most ${max} characters.`);
  return t || null;
}

function todayInSA(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function optFutureDate(v: unknown, field: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw bad(`"${field}" must be a date (YYYY-MM-DD).`);
  if (v < todayInSA()) throw bad(`"${field}" cannot be in the past.`);
  return v;
}

const EXTERNAL_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,39}$/;
const IDEM_RE = /^[A-Za-z0-9._:-]{8,100}$/;

interface LineIn { productRef: string; qty: number; pieces: number | null; description: string | null }

function parseLines(raw: unknown): LineIn[] {
  if (!Array.isArray(raw) || raw.length === 0) throw bad('"lines" must be a non-empty list.');
  if (raw.length > 50) throw bad('A quote may have at most 50 lines through this API.');
  return raw.map((l, i) => {
    if (!l || typeof l !== 'object' || Array.isArray(l)) throw bad(`Line ${i + 1} is not valid.`);
    const o = l as Record<string, unknown>;
    assertOnlyKeys(o, ['productRef', 'qty', 'pieces', 'description'], `Line ${i + 1}`);
    if (typeof o.productRef !== 'string' || !data.PRODUCT_REF_RE.test(o.productRef)) throw bad(`Line ${i + 1}: "productRef" must be a Signacore product reference (inv:… or qr:…).`);
    const qty = Number(o.qty);
    if (typeof o.qty !== 'number' || !Number.isFinite(qty) || qty <= 0 || qty > 1_000_000) throw bad(`Line ${i + 1}: "qty" must be a number greater than 0.`);
    let pieces: number | null = null;
    if (o.pieces !== undefined && o.pieces !== null) {
      pieces = Number(o.pieces);
      if (typeof o.pieces !== 'number' || !Number.isInteger(pieces) || pieces < 1 || pieces > 100_000) throw bad(`Line ${i + 1}: "pieces" must be a whole number of at least 1.`);
    }
    const description = optText(o.description, `lines[${i}].description`, 500) ?? null;
    return { productRef: o.productRef, qty, pieces, description };
  });
}

/** Resolves lines against authoritative products. Price ALWAYS comes from the product record. */
async function resolveLines(lines: LineIn[]) {
  const products = await data.loadProducts();
  return lines.map((l, i) => {
    const p = data.findProduct(products, l.productRef);
    if (!p) throw new IntegrationError(422, 'UNKNOWN_PRODUCT', `Line ${i + 1}: product ${l.productRef} does not exist in Signacore.`, { line: i, productRef: l.productRef });
    if (p.source === 'inventory' && p.item.active === false) throw new IntegrationError(422, 'PRODUCT_INACTIVE', `Line ${i + 1}: ${p.item.name} is discontinued in Signacore.`, { line: i });
    const sell = Number(p.item.sell);
    if (!Number.isFinite(sell) || sell <= 0) throw new IntegrationError(422, 'PRICE_NOT_SET', `Line ${i + 1}: ${p.item.name} has no selling price in Signacore. Set the price in Signacore first.`, { line: i, productRef: l.productRef });
    return {
      description: l.description || String(p.item.name || ''),
      qty: l.qty,
      unitPrice: sell,
      unit: p.item.unit ?? null,
      inventoryItemId: p.source === 'inventory' ? p.item.id : null,
      pieces: l.pieces,
    };
  });
}

const MARKER_RE = /\[Sally ref [^\]]{1,80}\]/;
function composeNotes(userNotes: string | null | undefined, marker: string): string {
  return [userNotes || null, marker].filter(Boolean).join('\n\n');
}

function requireIdempotencyKey(req: IntegrationRequest): string {
  const key = req.get('Idempotency-Key') || '';
  if (!IDEM_RE.test(key)) throw new IntegrationError(428, 'IDEMPOTENCY_KEY_REQUIRED', 'An Idempotency-Key header (8–100 characters) is required for this operation.');
  return key;
}

async function requireQuotesWritable(): Promise<void> {
  const a = await data.sectionAuthority('quotes');
  if (a !== 'relational') {
    throw new IntegrationError(409, 'SECTION_NOT_RELATIONAL', 'Quotes are not currently writable through the integration API on this server.');
  }
}

function mapServiceError(err: unknown): IntegrationError | null {
  if (err instanceof ConcurrencyConflictError) return new IntegrationError(409, 'STALE_VERSION', 'The quote changed in Signacore since it was last read. Reload it and try again.');
  if (err instanceof LegacyInvoiceConflictError) return new IntegrationError(409, 'LEGACY_CONFLICT', 'Signacore refused the change because of a linked legacy invoice.');
  if (err instanceof BusinessRuleError) return new IntegrationError(422, 'BUSINESS_RULE', err.message);
  return null;
}

/** Shared idempotency envelope for mutations. */
async function idempotent(
  req: IntegrationRequest, res: Response, operation: string, target: string,
  recover: (() => Promise<{ status: number; body: unknown } | null>) | null,
  run: () => Promise<{ status: number; body: unknown; committed: boolean; deferCompletion?: boolean }>
): Promise<void> {
  const ctx = req.integration!;
  const key = requireIdempotencyKey(req);
  const hash = requestHash(operation, target, req.body);
  const begin = await data.beginIdempotent(ctx.clientId, key, operation, hash);
  if (begin.state === 'mismatch') throw new IntegrationError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request.');
  if (begin.state === 'completed') {
    res.locals.replayed = true;
    res.set('Idempotent-Replayed', 'true');
    res.status(begin.status).json(begin.body);
    return;
  }
  if (begin.state === 'in_progress') {
    if (begin.ageMs < 120_000 || !recover) throw new IntegrationError(409, 'IDEMPOTENCY_IN_PROGRESS', 'The same request is still being processed. Check its result before retrying.');
    const recovered = await recover();
    if (recovered) {
      await data.completeIdempotent(ctx.clientId, key, recovered.status, recovered.body);
      res.locals.replayed = true;
      res.set('Idempotent-Replayed', 'true');
      res.status(recovered.status).json(recovered.body);
      return;
    }
    // Stale and provably without effect: start again under the same key.
    await data.releaseIdempotent(ctx.clientId, key);
    const again = await data.beginIdempotent(ctx.clientId, key, operation, hash);
    if (again.state !== 'new') throw new IntegrationError(409, 'IDEMPOTENCY_IN_PROGRESS', 'The same request is still being processed. Check its result before retrying.');
  }
  let result: { status: number; body: unknown; committed: boolean; deferCompletion?: boolean };
  try {
    result = await run();
  } catch (err) {
    // CONTRACT: run() may only throw BEFORE or DURING the service transaction
    // (which rolls back), so nothing was written: free the key for a corrected
    // retry. Every run() must catch its own failures AFTER the commit (read-
    // back, response building) and return a committed result instead — see
    // the `partial: true` paths in POST and PATCH /quotes — so a committed
    // mutation never reaches this release.
    await data.releaseIdempotent(ctx.clientId, key).catch(() => undefined);
    const mapped = mapServiceError(err);
    if (mapped) throw mapped;
    throw err;
  }
  if (result.deferCompletion) {
    // The write committed but a follow-up step (ownership record) failed.
    // Leave the key in_progress (never release it): a same-key retry gets
    // 409 IDEMPOTENCY_IN_PROGRESS until the row is stale, then `recover`
    // finishes the follow-up step and completes the key. Completing it now
    // would make every retry replay this response and skip recovery forever.
    console.error('[integration] idempotent result left in_progress for recovery (follow-up step failed after commit)');
  } else {
    await data.completeIdempotent(ctx.clientId, key, result.status, result.body).catch((e) =>
      console.error('[integration] could not record idempotent result (recoverable via marker):', e?.message || e));
  }
  res.status(result.status).json(result.body);
}

// ── STATUS ─────────────────────────────────────────────────────────────────
router.get('/status', op('status', async (req, res) => {
  const ctx = req.integration!;
  const sections: Record<string, string> = {};
  for (const s of ['customers', 'inventory', 'quickRates', 'quotes'] as const) sections[s] = await data.sectionAuthority(s);
  res.json({
    apiVersion: 'v1',
    client: { id: ctx.clientId, name: ctx.displayName, companyCode: ctx.companyCode, scopes: ctx.scopes },
    sections,
    capabilities: {
      quoteDrafts: sections.quotes === 'relational' && ctx.scopes.includes('quote:create'),
      customerCreate: sections.customers === 'platform_state' && ctx.scopes.includes('customer:create'),
      customerUpdate: sections.customers === 'platform_state' && ctx.scopes.includes('customer:update'),
      customerWrites: sections.customers === 'platform_state' && (ctx.scopes.includes('customer:create') || ctx.scopes.includes('customer:update')),
      customerDeletes: false,
      priceOverrides: false,
      quoteStatusChanges: false,
      jobConversion: false,
    },
    serverTime: new Date().toISOString(),
  });
}));

// ── CUSTOMERS ──────────────────────────────────────────────────────────────
router.get('/customers', requireScope('customer:read'), op('customer.search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2 || q.length > 100) throw bad('Search text must be 2–100 characters.');
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 25);
  const { items, source } = await data.loadSection('customers');
  const results = data.searchCustomers(items, q, limit);
  res.json({ results, dataSource: source, asOf: new Date().toISOString() });
}));

router.get('/customers/:id', requireScope('customer:read'), op('customer.get', async (req, res) => {
  const id = String(req.params.id);
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(id)) throw bad('Invalid customer id.');
  res.locals.targetType = 'customer'; res.locals.targetId = id;
  const { items, source } = await data.loadSection('customers');
  const c = items.find((x: any) => x && String(x.id) === id);
  if (!c) throw new IntegrationError(404, 'NOT_FOUND', 'Customer not found in Signacore.');
  res.json({ customer: data.customerDetail(c), dataSource: source, asOf: new Date().toISOString() });
}));

// ── CUSTOMER WRITES (narrow: create + allow-listed field update) ───────────
// No delete, merge, re-id, notes or status. Duplicates are never merged: a
// possible duplicate is refused with the candidates, and only an explicit
// acknowledgement of EACH candidate (allowDuplicateOf + X-Confirmed-By) lets a
// separate record be created — exactly the decision the dashboard asks a person
// to make in AddEditCustomerModal.
const CUSTOMER_WRITE_FIELDS = ['companyName', 'contactPerson', 'email', 'phone', 'address', 'vatNumber'];
const CUSTOMER_FORBIDDEN = ['id', 'notes', 'tel', 'customerId', 'companyCode', 'status', 'deleted', 'mergeInto'];
const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]{2,}$/;
const PHONE_RE = /^[0-9+()\-./\s]{3,50}$/;
const VAT_RE = /^[A-Za-z0-9 ./-]{1,30}$/;
const CUSTOMER_ID_RE = /^[A-Za-z0-9._-]{1,40}$/;

function assertCustomerKeys(body: Record<string, unknown>, allowed: string[], where: string): void {
  const forbidden = Object.keys(body).filter((k) => CUSTOMER_FORBIDDEN.includes(k));
  if (forbidden.length) {
    throw new IntegrationError(403, 'FIELD_NOT_PERMITTED',
      `${where} may not set ${forbidden.join(', ')} — customer ids, internal notes and status are controlled by Signacore.`, { fields: forbidden });
  }
  assertOnlyKeys(body, allowed, where);
}

function parseCustomerFields(body: Record<string, unknown>, { requireName }: { requireName: boolean }): data.CustomerFieldsIn {
  const out: data.CustomerFieldsIn = {};
  const companyName = optText(body.companyName, 'companyName', 200);
  if (companyName === null || (requireName && !companyName)) throw bad('"companyName" (the company / trading name) is required and cannot be empty.');
  if (companyName !== undefined) out.companyName = companyName;
  const contactPerson = optText(body.contactPerson, 'contactPerson', 120);
  if (contactPerson !== undefined) out.contactPerson = contactPerson;
  const email = optText(body.email, 'email', 254);
  if (email && !EMAIL_RE.test(email)) throw bad('"email" is not a valid email address.');
  if (email !== undefined) out.email = email;
  const phone = optText(body.phone, 'phone', 50);
  if (phone && !PHONE_RE.test(phone)) throw bad('"phone" may only contain digits, spaces and + ( ) - . /');
  if (phone !== undefined) out.phone = phone;
  const address = optText(body.address, 'address', 1000);
  if (address !== undefined) out.address = address;
  const vatNumber = optText(body.vatNumber, 'vatNumber', 30);
  if (vatNumber && !VAT_RE.test(vatNumber)) throw bad('"vatNumber" may only contain letters, digits, spaces and . / -');
  if (vatNumber !== undefined) out.vatNumber = vatNumber;
  return out;
}

function parseAllowDuplicateOf(req: IntegrationRequest, raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 10 || raw.some((x) => typeof x !== 'string' || !CUSTOMER_ID_RE.test(x))) {
    throw bad('"allowDuplicateOf" must be a list of up to 10 Signacore customer ids.');
  }
  if (raw.length && !req.integration!.confirmedBy) {
    throw new IntegrationError(428, 'CONFIRMATION_REQUIRED', 'Saving a customer that matches an existing one needs an explicit confirmation (X-Confirmed-By).');
  }
  return raw as string[];
}

function possibleDuplicate(candidates: unknown[]): IntegrationError {
  return new IntegrationError(409, 'POSSIBLE_DUPLICATE',
    'This looks like a customer that already exists in Signacore. Choose the existing customer, or confirm that a separate customer is intended.',
    { candidates });
}

router.post('/customers', requireScope('customer:create'), op('customer.create', async (req, res) => {
  const ctx = req.integration!;
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body as Record<string, unknown> : {};
  assertCustomerKeys(body, ['externalRef', ...CUSTOMER_WRITE_FIELDS, 'allowDuplicateOf'], 'A customer');
  if (body.externalRef !== undefined && (typeof body.externalRef !== 'string' || !EXTERNAL_REF_RE.test(body.externalRef))) {
    throw bad('"externalRef" must be a short reference such as a Sally enquiry or customer number.');
  }
  const fields = parseCustomerFields(body, { requireName: true });
  const allowDuplicateOf = parseAllowDuplicateOf(req, body.allowDuplicateOf);
  await data.requireCustomersWritable();
  const key = requireIdempotencyKey(req);
  const externalRef = (body.externalRef as string | undefined) ?? null;

  const recover = async () => {
    // The ownership row is written in the SAME transaction as the customer, so
    // finding it proves this exact request created this exact customer.
    const id = await data.findCustomerCreatedByKey(ctx.clientId, key);
    if (!id) return null;
    const { items, source } = await data.loadSection('customers');
    const c = items.find((x: any) => x && String(x.id) === id);
    if (!c) return null;
    res.locals.targetType = 'customer'; res.locals.targetId = id;
    return { status: 201, body: { customer: data.customerDetail(c), created: true, dataSource: source } };
  };

  await idempotent(req, res, 'customer.create', 'customers', recover, async () => {
    const result = await data.createCustomerJson(ctx.clientId, key, externalRef, fields, { allowDuplicateOf });
    if ('duplicates' in result) throw possibleDuplicate(result.duplicates); // nothing was written
    // ── COMMITTED (customer + ownership record in one transaction). ──
    res.locals.targetType = 'customer'; res.locals.targetId = result.customer.id;
    return { status: 201, body: { customer: data.customerDetail(result.customer), created: true, dataSource: 'platform_state' }, committed: true };
  });
}));

router.patch('/customers/:id', requireScope('customer:update'), op('customer.update', async (req, res) => {
  const ctx = req.integration!;
  const id = String(req.params.id);
  if (!CUSTOMER_ID_RE.test(id)) throw bad('Invalid customer id.');
  res.locals.targetType = 'customer'; res.locals.targetId = id;
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body as Record<string, unknown> : {};
  assertCustomerKeys(body, ['expectedVersion', ...CUSTOMER_WRITE_FIELDS, 'allowDuplicateOf'], 'A customer update');
  if (typeof body.expectedVersion !== 'string' || !/^[a-f0-9]{32}$/.test(body.expectedVersion)) {
    throw bad('"expectedVersion" (the customer "version" from the last read) is required.');
  }
  const expectedVersion = body.expectedVersion;
  const patch = parseCustomerFields(body, { requireName: false });
  if (!Object.keys(patch).length) throw bad('Nothing to update.');
  const allowDuplicateOf = parseAllowDuplicateOf(req, body.allowDuplicateOf);
  await data.requireCustomersWritable();

  const recover = async () => {
    // A stuck update is proven applied only if the record now holds exactly the requested values.
    const { items, source } = await data.loadSection('customers');
    const matches = items.filter((x: any) => x && String(x.id) === id);
    if (matches.length !== 1 || !data.customerMatchesPatch(matches[0], patch)) return null;
    return { status: 200, body: { customer: data.customerDetail(matches[0]), dataSource: source } };
  };

  await idempotent(req, res, 'customer.update', `customers/${id}`, recover, async () => {
    const result = await data.updateCustomerJson(ctx.clientId, id, expectedVersion, patch, { allowDuplicateOf });
    if ('duplicates' in result) throw possibleDuplicate(result.duplicates); // nothing was written
    return { status: 200, body: { customer: data.customerDetail(result.customer), dataSource: 'platform_state' }, committed: true };
  });
}));

// ── PRODUCTS / INVENTORY / PRICING ─────────────────────────────────────────
router.get('/products', requireScope('product:read'), op('product.search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const category = req.query.category ? String(req.query.category).trim().slice(0, 80) : null;
  if (q.length > 100) throw bad('Search text is too long.');
  if (!q && !category) throw bad('Provide search text or a category.');
  const srcRaw = req.query.source ? String(req.query.source) : null;
  if (srcRaw && srcRaw !== 'inventory' && srcRaw !== 'quickRates') throw bad('"source" must be inventory or quickRates.');
  const limit = Math.min(Math.max(Number(req.query.limit) || 15, 1), 25);
  const all = await data.loadProducts();
  const found = data.searchProducts(all, q, category, srcRaw as data.ProductSource | null, limit);
  const opts = { pricing: hasScope(req, 'pricing:read'), inventory: hasScope(req, 'inventory:read') };
  res.json({ results: found.map((f) => data.productView(f.source, f.item, opts, f.sectionSource)), asOf: new Date().toISOString() });
}));

router.get('/products/:ref', requireScope('product:read'), op('product.get', async (req, res) => {
  const ref = String(req.params.ref);
  if (!data.PRODUCT_REF_RE.test(ref)) throw bad('Invalid product reference.');
  res.locals.targetType = 'product'; res.locals.targetId = ref;
  const p = data.findProduct(await data.loadProducts(), ref);
  if (!p) throw new IntegrationError(404, 'NOT_FOUND', 'Product not found in Signacore.');
  const opts = { pricing: hasScope(req, 'pricing:read'), inventory: hasScope(req, 'inventory:read') };
  res.json({ product: data.productView(p.source, p.item, opts, p.sectionSource), asOf: new Date().toISOString() });
}));

router.get('/inventory/:ref', requireScope('inventory:read'), op('inventory.get', async (req, res) => {
  const ref = String(req.params.ref);
  if (!data.PRODUCT_REF_RE.test(ref)) throw bad('Invalid product reference.');
  res.locals.targetType = 'product'; res.locals.targetId = ref;
  const p = data.findProduct(await data.loadProducts(), ref);
  if (!p) throw new IntegrationError(404, 'NOT_FOUND', 'Product not found in Signacore.');
  const view = data.productView(p.source, p.item, { pricing: false, inventory: true }, p.sectionSource);
  res.json({ ref, name: view.name, stock: view.stock, dataSource: p.sectionSource, asOf: new Date().toISOString() });
}));

router.get('/pricing/:ref', requireScope('pricing:read'), op('pricing.get', async (req, res) => {
  const ref = String(req.params.ref);
  if (!data.PRODUCT_REF_RE.test(ref)) throw bad('Invalid product reference.');
  res.locals.targetType = 'product'; res.locals.targetId = ref;
  const p = data.findProduct(await data.loadProducts(), ref);
  if (!p) throw new IntegrationError(404, 'NOT_FOUND', 'Product not found in Signacore.');
  const sell = Number(p.item.sell);
  const priceSet = Number.isFinite(sell) && sell > 0;
  res.json({
    ref, name: p.item.name ?? null, unit: p.item.unit ?? null,
    sellPriceExVat: priceSet ? Math.round(sell * 10000) / 10000 : null,
    priceSet,
    currency: 'ZAR',
    vat: { ratePct: 15, appliedTo: 'quote total after discount and setup fee' },
    customerSpecificPricing: 'not_supported_by_signacore',
    quantityBreaks: 'not_supported_by_signacore',
    permittedDiscountPct: 0,
    rules: [
      'Line subtotal = pieces × quantity × unit price (pieces defaults to 1).',
      'Quote totals and VAT are calculated by Signacore when the quote is saved.',
      'Standard deposit: 100% for totals up to R5,000, otherwise 80%, unless a custom deposit is set by Signacore staff.',
    ],
    dataSource: p.sectionSource,
    asOf: new Date().toISOString(),
  });
}));

// ── QUOTES ─────────────────────────────────────────────────────────────────
router.get('/quotes', requireScope('quote:read'), op('quote.search', async (req, res) => {
  const ctx = req.integration!;
  if ((await data.sectionAuthority('quotes')) !== 'relational') throw new IntegrationError(409, 'SECTION_NOT_RELATIONAL', 'Quotes are not available through the integration API on this server.');
  const q = req.query.q ? String(req.query.q).trim().slice(0, 100) : null;
  const status = req.query.status ? String(req.query.status) : null;
  if (status && !Object.keys(data.QUOTE_STATUS_LABELS).includes(status)) throw bad('Unknown quote status.');
  const externalRef = req.query.externalRef ? String(req.query.externalRef) : null;
  if (externalRef && !EXTERNAL_REF_RE.test(externalRef)) throw bad('Invalid external reference.');
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
  const results = await data.searchQuotes(ctx.companyCode, ctx.clientId, {
    q, status, createdByThisClient: req.query.mine === 'true', externalRef, limit,
  });
  res.json({ results, dataSource: 'relational', asOf: new Date().toISOString() });
}));

router.get('/quotes/:id', requireScope('quote:read'), op('quote.get', async (req, res) => {
  const ctx = req.integration!;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw bad('Invalid quote id.');
  res.locals.targetType = 'quote'; res.locals.targetId = id;
  if ((await data.sectionAuthority('quotes')) !== 'relational') throw new IntegrationError(409, 'SECTION_NOT_RELATIONAL', 'Quotes are not available through the integration API on this server.');
  const row = await data.getQuoteRow(id, ctx.companyCode);
  if (!row) throw new IntegrationError(404, 'NOT_FOUND', 'Quote not found.');
  res.json({ quote: await data.quoteView(row, ctx.clientId), dataSource: 'relational', asOf: new Date().toISOString() });
}));

router.post('/quotes', requireScope('quote:create'), op('quote.create_draft', async (req, res) => {
  const ctx = req.integration!;
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body as Record<string, unknown> : {};
  assertOnlyKeys(body, ['externalRef', 'customerId', 'lines', 'reference', 'poRef', 'notes', 'validUntil', 'allowAdditionalQuote'], 'A quote');
  if (typeof body.externalRef !== 'string' || !EXTERNAL_REF_RE.test(body.externalRef)) throw bad('"externalRef" (e.g. the Sally enquiry number) is required.');
  if (typeof body.customerId !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(body.customerId)) throw bad('"customerId" (a Signacore customer id) is required.');
  const lines = parseLines(body.lines);
  const reference = optText(body.reference, 'reference', 120);
  const poRef = optText(body.poRef, 'poRef', 60);
  const notes = optText(body.notes, 'notes', 2000);
  const validUntil = optFutureDate(body.validUntil, 'validUntil');
  if (body.allowAdditionalQuote !== undefined && typeof body.allowAdditionalQuote !== 'boolean') throw bad('"allowAdditionalQuote" must be true or false.');
  if (body.allowAdditionalQuote && !ctx.confirmedBy) {
    throw new IntegrationError(428, 'CONFIRMATION_REQUIRED', 'Creating an additional quote for the same enquiry needs an explicit confirmation (X-Confirmed-By).');
  }
  await requireQuotesWritable();
  const externalRef = body.externalRef;
  const key = requireIdempotencyKey(req);
  const marker = `[Sally ref ${externalRef} · request ${key}]`;

  const recover = async () => {
    // Full marker (externalRef + key), never just the key: recovery may only
    // claim the exact quote this request wrote.
    const id = await data.findQuoteByRequestMarker(marker, ctx.companyCode);
    if (!id) return null;
    await data.recordOwnership(ctx.clientId, id, externalRef, key);
    const row = await data.getQuoteRow(id, ctx.companyCode);
    return { status: 201, body: { quote: await data.quoteView(row, ctx.clientId), dataSource: 'relational' } };
  };

  await idempotent(req, res, 'quote.create_draft', 'quotes', recover, async () => {
    const existing = await data.openQuotesForRef(ctx.clientId, externalRef, ctx.companyCode);
    if (existing.length && !body.allowAdditionalQuote) {
      throw new IntegrationError(409, 'DUPLICATE_QUOTE', `Sally already created ${existing.map((e) => e.quoteNumber).join(', ')} for ${externalRef}.`, { existing });
    }
    const customers = await data.loadSection('customers');
    const cust = customers.items.find((c: any) => c && String(c.id) === body.customerId);
    if (!cust) throw new IntegrationError(422, 'UNKNOWN_CUSTOMER', 'That customer does not exist in Signacore.');
    if (!cust.companyName || !String(cust.companyName).trim()) throw new IntegrationError(422, 'CUSTOMER_INCOMPLETE', 'The Signacore customer record has no company name.');
    let relCustomerId: number | null = null;
    if (customers.source === 'relational') {
      const r = await query('SELECT id FROM rel_customers WHERE source_id = $1', [String(cust.id)]);
      relCustomerId = r.rows[0] ? Number(r.rows[0].id) : null;
    }
    const resolved = await resolveLines(lines);

    const created = await createQuote({
      companyCode: ctx.companyCode,
      customerId: relCustomerId,
      customerNameRaw: String(cust.companyName).trim(),
      contactPerson: cust.contactPerson || null,
      email: cust.email || null,
      phone: cust.tel || cust.phone || null,
      address: cust.address || null,
      vatNumber: cust.vatNumber || null,
      preparedBy: 'Sally (AI Sales Assistant)',
      salesperson: null,
      reference: reference ?? null,
      poRef: poRef ?? null,
      quoteDate: todayInSA(),
      validUntil: validUntil ?? null,
      status: 'draft',
      notes: composeNotes(notes, marker),
      lines: resolved as any,
    });
    // ── COMMITTED. Nothing below may "release" the key. ──
    res.locals.targetType = 'quote'; res.locals.targetId = created.id;
    let ownershipRecorded = true;
    try { await data.recordOwnership(ctx.clientId, created.id, externalRef, key); }
    catch (e) {
      ownershipRecorded = false;
      console.error('[integration] ownership record failed (will be recovered):', (e as Error)?.message);
    }
    let bodyOut: unknown;
    try {
      const row = await data.getQuoteRow(created.id, ctx.companyCode);
      bodyOut = { quote: await data.quoteView(row, ctx.clientId), dataSource: 'relational' };
    } catch {
      bodyOut = { quote: { id: created.id, quoteNumber: created.quoteNumber, rowVersion: created.rowVersion, status: 'draft' }, partial: true };
    }
    // Without the ownership row the key must stay in_progress so the stale-
    // request recovery above (which re-runs recordOwnership) can still run.
    return { status: 201, body: bodyOut, committed: true, deferCompletion: !ownershipRecorded };
  });
}));

router.patch('/quotes/:id', requireScope('quote:update'), op('quote.update_draft', async (req, res) => {
  const ctx = req.integration!;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw bad('Invalid quote id.');
  res.locals.targetType = 'quote'; res.locals.targetId = id;
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body as Record<string, unknown> : {};
  assertOnlyKeys(body, ['expectedVersion', 'lines', 'reference', 'poRef', 'notes', 'validUntil'], 'A quote update');
  const expectedVersion = Number(body.expectedVersion);
  if (typeof body.expectedVersion !== 'number' || !Number.isInteger(expectedVersion)) throw bad('"expectedVersion" is required.');
  const lines = body.lines !== undefined ? parseLines(body.lines) : undefined;
  const reference = optText(body.reference, 'reference', 120);
  const poRef = optText(body.poRef, 'poRef', 60);
  const notes = optText(body.notes, 'notes', 2000);
  const validUntil = optFutureDate(body.validUntil, 'validUntil');
  if ([lines, reference, poRef, notes, validUntil].every((v) => v === undefined)) throw bad('Nothing to update.');
  await requireQuotesWritable();

  await idempotent(req, res, 'quote.update_draft', `quotes/${id}`, null, async () => {
    const row = await data.getQuoteRow(id, ctx.companyCode);
    if (!row) throw new IntegrationError(404, 'NOT_FOUND', 'Quote not found.');
    if (!(await data.isRecordOwned(ctx.clientId, id))) {
      throw new IntegrationError(403, 'NOT_OWNED', 'This quote was not created by this integration client and cannot be changed through it.');
    }
    if ((row.status || 'draft') !== 'draft' || row.converted_job_id || row.proforma_num) {
      throw new IntegrationError(409, 'QUOTE_NOT_EDITABLE', 'Only draft quotes without a proforma or job can be changed through this API.');
    }
    const patch: Record<string, unknown> = {};
    if (lines) patch.lines = await resolveLines(lines);
    if (reference !== undefined) patch.reference = reference;
    if (poRef !== undefined) patch.poRef = poRef;
    if (validUntil !== undefined) patch.validUntil = validUntil;
    if (notes !== undefined) {
      const marker = MARKER_RE.exec(String(row.notes || ''))?.[0];
      patch.notes = marker ? composeNotes(notes, marker) : notes;
    }
    await updateQuoteWithJobSync(id, expectedVersion, patch as any, {});
    // ── COMMITTED. Nothing below may throw into idempotent() (which would
    // release the key); a read-back failure still completes the key with a
    // partial response, so a same-key retry replays it instead of re-running.
    let bodyOut: unknown;
    try {
      if (data.__testHooks.beforeUpdateReadback) await data.__testHooks.beforeUpdateReadback();
      const fresh = await data.getQuoteRow(id, ctx.companyCode);
      bodyOut = { quote: await data.quoteView(fresh, ctx.clientId), dataSource: 'relational' };
    } catch (e) {
      console.error('[integration] quote update committed but read-back failed (partial response returned):', (e as Error)?.message || e);
      bodyOut = { quote: { id }, partial: true };
    }
    return { status: 200, body: bodyOut, committed: true };
  });
}));

// Anything else under /api/v1/integration: a clear, audited 404.
router.use(op('unknown', async (_req, _res) => {
  throw new IntegrationError(404, 'NOT_FOUND', 'Unknown integration endpoint.');
}));

export default router;
