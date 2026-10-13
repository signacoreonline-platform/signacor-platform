/**
 * integration-api.stress.ts — /api/v1/integration (Sally integration client).
 *
 * Runs the real router + real relational services against a DISPOSABLE local
 * database (DATABASE_URL must name a database ending in _test — refused
 * otherwise). Apply migrations first (npm run migrate / ts-node src/db/migrate.ts):
 *
 *   DATABASE_URL=postgres://.../signacore_test npx ts-node --transpile-only test/integration-api.stress.ts
 *
 * Uses invented test data only.
 */
process.env.RELATIONAL_AUTHORITY_ENABLED = 'true';
process.env.INTEGRATION_API_ENABLED = 'true';

import express from 'express';
import type { AddressInfo } from 'net';
import pool from '../src/db/pool';
import router from '../src/integration/router';
import { hashSecret, requestHash } from '../src/integration/keys';
import { __testHooks } from '../src/integration/data';
import { createQuote } from '../src/relational/services';

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : ''}`); }
}

const SECRET = 'test-secret-sally-0123456789abcdefghijklmnopqrstuvwxyz';
const LIMITED_SECRET = 'test-secret-limited-0123456789abcdefghijklmnopqrstuv';
const REVOKED_SECRET = 'test-secret-revoked-0123456789abcdefghijklmnopqrstuv';
let base = '';
const serverLog: string[] = [];
for (const m of ['error', 'warn'] as const) {
  const orig = console[m].bind(console);
  console[m] = (...args: unknown[]) => { serverLog.push(args.map(String).join(' ')); orig(...args); };
}

async function call(method: string, path: string, opts: { body?: unknown; client?: string; secret?: string | null; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (opts.client !== '') headers['X-Integration-Client'] = opts.client || 'sally-test';
  if (opts.secret !== null) headers.Authorization = `Bearer ${opts.secret || SECRET}`;
  const res = await fetch(`${base}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  let json: any = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json, headers: res.headers };
}

async function setCutover(section: string, enabled: boolean) {
  await pool.query('UPDATE relational_cutover SET enabled = $2 WHERE section = $1', [section, enabled]);
}

async function seed() {
  const db = (await pool.query('SELECT current_database() AS d')).rows[0].d as string;
  if (!db.endsWith('_test')) throw new Error(`Refusing to run against "${db}" — use a *_test database.`);
  await pool.query(`TRUNCATE integration_audit, integration_idempotency, integration_records, integration_clients RESTART IDENTITY`);
  await pool.query(`TRUNCATE rel_quote_line_items, rel_quotes, rel_inventory_items RESTART IDENTITY CASCADE`);
  await pool.query(`UPDATE relational_cutover SET enabled = false`);
  await setCutover('inventory', true);
  await setCutover('quotes', true);
  const state = {
    customers: [
      { id: 1700000000001, companyName: 'Acme Signs Test (Pty) Ltd', contactPerson: 'Thandi Test', email: 'thandi@acme.test', tel: '044 555 0101', address: '1 Test Street, George', vatNumber: '4000000001', notes: 'INTERNAL-ONLY-NOTE' },
      { id: 1700000000002, companyName: 'Acme Signs Test Branch', contactPerson: 'Pieter Test', email: 'pieter@acme.test', tel: '044 555 0102', address: '2 Test Street', vatNumber: '', notes: '' },
      { id: 1700000000003, companyName: 'Blue Crane Test Cafe', contactPerson: 'Lerato Test', email: 'lerato@bluecrane.test', tel: '082 555 0103', address: '', vatNumber: '', notes: '' },
    ],
    quickRates: [
      { id: 900001, sku: 'QR-INSTALL', name: 'Installation labour per hour (test)', cat: 'Labour', unit: 'hr', cost: 200, sell: 450, stock: 0, reorder: 0 },
      { id: 900002, sku: 'QR-NOPRICE', name: 'Unpriced service (test)', cat: 'Labour', unit: 'ea', cost: 0, sell: 0, stock: 0, reorder: 0 },
    ],
    inventory: [{ id: 1, name: 'FROZEN JSON COPY — must never be served', sell: 1 }],
  };
  await pool.query(`INSERT INTO platform_state (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`, [JSON.stringify(state)]);
  const inv = [
    ['800001', 'ACM-3-WHITE', 'ACM board 3mm white 2440x1220 (test)', 'Boards', 'sheet', 300, 520, 12, 5],
    ['800002', 'VINYL-GLOSS', 'Gloss vinyl 1370mm (test)', 'Vinyl', 'm', 20, 95, 2, 5],
    ['800003', 'ACM-3-BLACK', 'ACM board 3mm black 2440x1220 (test)', 'Boards', 'sheet', 310, 540, 0, 2],
  ];
  for (const r of inv) {
    await pool.query(`INSERT INTO rel_inventory_items (source_id, sku, name, category, unit, cost, sell, stock_qty, reorder_level) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, r);
  }
  const allScopes = ['customer:read', 'product:read', 'inventory:read', 'pricing:read', 'quote:read', 'quote:create', 'quote:update', 'admin:everything'];
  await pool.query(`INSERT INTO integration_clients (client_id, display_name, secret_hash, scopes, company_code) VALUES ('sally-test','Sally (test)',$1,$2,'2')`, [hashSecret(SECRET), allScopes]);
  await pool.query(`INSERT INTO integration_clients (client_id, display_name, secret_hash, scopes, company_code) VALUES ('limited-test','Limited',$1,$2,'2')`, [hashSecret(LIMITED_SECRET), ['customer:read']]);
  await pool.query(`INSERT INTO integration_clients (client_id, display_name, secret_hash, scopes, company_code, is_active, revoked_at) VALUES ('revoked-test','Revoked',$1,$2,'2',false,NOW())`, [hashSecret(REVOKED_SECRET), allScopes]);
}

async function main() {
  await seed();
  const app = express();
  app.use(express.json());
  app.use('/api/v1/integration', router);
  const server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/integration`;

  console.log('\n— enablement & authentication');
  process.env.INTEGRATION_API_ENABLED = 'false';
  ok((await call('GET', '/status')).status === 503, 'API is fail-closed until INTEGRATION_API_ENABLED=true');
  process.env.INTEGRATION_API_ENABLED = 'true';
  let r = await call('GET', '/status');
  ok(r.status === 200, 'valid client authenticates', r.body);
  ok(JSON.stringify(r.body.client.scopes) === JSON.stringify(['customer:read', 'product:read', 'inventory:read', 'pricing:read', 'quote:read', 'quote:create', 'quote:update']),
    'unknown stored scope (admin:everything) grants nothing', r.body.client.scopes);
  ok(r.body.sections.customers === 'platform_state' && r.body.sections.quickRates === 'platform_state', 'customers/quickRates reported as platform_state authority');
  ok(r.body.sections.inventory === 'relational' && r.body.sections.quotes === 'relational', 'inventory/quotes reported as relational authority');
  ok(r.body.capabilities.priceOverrides === false && r.body.capabilities.jobConversion === false, 'privileged capabilities reported as unavailable');
  ok((await call('GET', '/status', { secret: null })).status === 401, 'missing secret → 401');
  ok((await call('GET', '/status', { secret: 'wrong-secret-0123456789abcdefghijklmnop' })).status === 401, 'wrong secret → 401');
  ok((await call('GET', '/status', { client: 'revoked-test', secret: REVOKED_SECRET })).status === 401, 'revoked client → 401');
  ok((await call('GET', '/status', { client: 'nobody-test' })).status === 401, 'unknown client → 401');
  ok((await call('GET', '/status', { secret: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYWRtaW4ifQ.sig' })).status === 401, 'a dashboard JWT is not accepted');
  r = await call('GET', `/status?api_key=${SECRET}`);
  ok(r.status === 400 && r.body.error.code === 'CREDENTIALS_IN_URL', 'credentials in the query string are refused', r.body);
  r = await call('GET', `/status?API_KEY=${SECRET}`);
  ok(r.status === 400 && r.body.error.code === 'CREDENTIALS_IN_URL', 'credential query keys are refused in any letter case', r.body);

  console.log('\n— permission enforcement');
  r = await call('GET', '/products?q=acm', { client: 'limited-test', secret: LIMITED_SECRET });
  ok(r.status === 403 && r.body.error.code === 'FORBIDDEN_SCOPE', 'client without product:read gets 403', r.body);
  r = await call('POST', '/quotes', { client: 'limited-test', secret: LIMITED_SECRET, body: {}, headers: { 'Idempotency-Key': 'limited-key-001' } });
  ok(r.status === 403, 'client without quote:create cannot create quotes');
  for (const [m, p] of [['DELETE', '/quotes/1'], ['POST', '/quotes/1/convert-to-job'], ['PATCH', '/quotes/1/status'], ['DELETE', '/customers/1700000000001'], ['POST', '/payments']]) {
    r = await call(m, p, { body: {}, headers: { 'Idempotency-Key': 'escalation-key-1' } });
    ok(r.status === 404, `no privileged route exists: ${m} ${p}`, r.status);
  }
  // Customer writes exist (2026-10) but need their own explicitly granted scopes; this client does not hold them.
  r = await call('POST', '/customers', { body: { companyName: 'Escalation Test' }, headers: { 'Idempotency-Key': 'escalation-key-2' } });
  ok(r.status === 403 && r.body.error.code === 'FORBIDDEN_SCOPE', 'customer create needs customer:create (not granted to this client)', r.body);
  r = await call('PATCH', '/customers/1700000000001', { body: { expectedVersion: '0'.repeat(32), email: 'x@y.test' }, headers: { 'Idempotency-Key': 'escalation-key-3' } });
  ok(r.status === 403 && r.body.error.code === 'FORBIDDEN_SCOPE', 'customer update needs customer:update (not granted to this client)', r.body);

  console.log('\n— customers');
  r = await call('GET', '/customers?q=acme');
  ok(r.status === 200 && r.body.results.length === 2, 'ambiguous search returns every match (2) for the caller to choose', r.body);
  ok(r.body.dataSource === 'platform_state', 'customer data reported as coming from platform_state');
  ok(!JSON.stringify(r.body).includes('INTERNAL-ONLY-NOTE'), 'internal customer notes are never returned');
  r = await call('GET', '/customers?q=thandi@acme.test');
  ok(r.body.results[0]?.id === '1700000000001', 'email search finds the exact customer');
  r = await call('GET', '/customers?q=0445550102');
  ok(r.body.results[0]?.id === '1700000000002', 'phone search matches on digits');
  ok((await call('GET', '/customers?q=a')).status === 400, 'one-character search refused');
  r = await call('GET', '/customers/1700000000001');
  ok(r.status === 200 && r.body.customer.address === '1 Test Street, George', 'customer detail includes billing address');
  ok((await call('GET', '/customers/999')).status === 404, 'unknown customer → 404');

  console.log('\n— products / inventory / pricing');
  r = await call('GET', '/products?q=acm');
  ok(r.status === 200 && r.body.results.length === 2, 'product search finds inventory items', r.body);
  const white = r.body.results.find((p: any) => p.sku === 'ACM-3-WHITE');
  ok(white?.ref === 'inv:800001' && white?.pricing?.sellPriceExVat === 520, 'authoritative ref and selling price returned', white);
  ok(white?.dataSource === 'relational', 'inventory served from relational authority (not the frozen JSON copy)');
  ok(!JSON.stringify(r.body).includes('"cost"') && !JSON.stringify(r.body).includes('300'), 'cost price is never exposed');
  ok(!JSON.stringify(r.body).includes('FROZEN JSON COPY'), 'frozen JSON inventory copy never served');
  r = await call('GET', '/products?q=installation');
  ok(r.body.results[0]?.ref === 'qr:900001' && r.body.results[0]?.stock?.status === 'not_tracked', 'quick rate found; stock not tracked');
  r = await call('GET', '/inventory/inv:800002');
  ok(r.status === 200 && r.body.stock.onHand === 2 && r.body.stock.status === 'low', 'inventory lookup: low stock reported', r.body);
  r = await call('GET', '/inventory/inv:800003');
  ok(r.body.stock.status === 'out_of_stock', 'inventory lookup: out of stock reported');
  r = await call('GET', '/pricing/inv:800001');
  ok(r.status === 200 && r.body.sellPriceExVat === 520 && r.body.permittedDiscountPct === 0, 'pricing lookup returns sell price, no discount permitted', r.body);
  r = await call('GET', '/pricing/qr:900002');
  ok(r.body.priceSet === false && r.body.sellPriceExVat === null, 'unpriced item reported as having no price (never 0)');
  ok((await call('GET', '/products/inv:999999')).status === 404, 'unknown product → 404');

  console.log('\n— quote draft creation');
  const goodQuote = { externalRef: 'ENQ-TEST-001', customerId: '1700000000001', reference: 'Shopfront', notes: 'Customer wants installation in November.',
    lines: [{ productRef: 'inv:800001', qty: 10 }, { productRef: 'qr:900001', qty: 2, description: 'Install on site (test)' }] };
  r = await call('POST', '/quotes', { body: goodQuote });
  ok(r.status === 428 && r.body.error.code === 'IDEMPOTENCY_KEY_REQUIRED', 'mutation without Idempotency-Key refused', r.body);
  r = await call('POST', '/quotes', { body: { ...goodQuote, lines: [{ productRef: 'inv:800001', qty: 10, unitPrice: 1 }] }, headers: { 'Idempotency-Key': 'key-price-override' } });
  ok(r.status === 403 && r.body.error.code === 'FIELD_NOT_PERMITTED', 'line price override refused', r.body);
  r = await call('POST', '/quotes', { body: { ...goodQuote, discountPct: 50 }, headers: { 'Idempotency-Key': 'key-discount' } });
  ok(r.status === 403 && r.body.error.code === 'FIELD_NOT_PERMITTED', 'discount refused');
  r = await call('POST', '/quotes', { body: { ...goodQuote, total: 1, status: 'approved' }, headers: { 'Idempotency-Key': 'key-total' } });
  ok(r.status === 403, 'client-supplied total/status refused');
  r = await call('POST', '/quotes', { body: { ...goodQuote, lines: [{ productRef: 'inv:424242', qty: 1 }] }, headers: { 'Idempotency-Key': 'key-fake-product' } });
  ok(r.status === 422 && r.body.error.code === 'UNKNOWN_PRODUCT', 'fabricated product id refused', r.body);
  r = await call('POST', '/quotes', { body: { ...goodQuote, lines: [{ productRef: 'qr:900002', qty: 1 }] }, headers: { 'Idempotency-Key': 'key-no-price' } });
  ok(r.status === 422 && r.body.error.code === 'PRICE_NOT_SET', 'product without a Signacore price refused (no R0 lines)');
  r = await call('POST', '/quotes', { body: { ...goodQuote, customerId: '555' }, headers: { 'Idempotency-Key': 'key-fake-customer' } });
  ok(r.status === 422 && r.body.error.code === 'UNKNOWN_CUSTOMER', 'fabricated customer id refused');
  ok(Number((await pool.query('SELECT count(*) FROM rel_quotes')).rows[0].count) === 0, 'no quote was written by any refused request');

  r = await call('POST', '/quotes', { body: goodQuote, headers: { 'Idempotency-Key': 'key-create-001', 'X-Acting-For': 'sally@signacore.co.za' } });
  ok(r.status === 201, 'draft quote created', r.body);
  const q1 = r.body.quote;
  ok(q1?.status === 'draft' && /^SQ-/.test(q1?.quoteNumber || ''), 'quote is a draft with a Signacore quote number', q1?.quoteNumber);
  ok(q1?.lines?.[0]?.unitPriceExVat === 520 && q1?.lines?.[1]?.unitPriceExVat === 450, 'unit prices taken from Signacore records');
  ok(q1?.totals?.subtotalExVat === 6100 && q1?.totals?.vatAmount === 915 && q1?.totals?.totalInclVat === 7015, 'totals calculated by Signacore (6100 + 915 VAT = 7015)', q1?.totals);
  ok(q1?.customer?.name === 'Acme Signs Test (Pty) Ltd' && q1?.customer?.email === 'thandi@acme.test', 'customer details copied from the Signacore record');
  ok(q1?.editableByClient === true && q1?.createdByThisClient === true, 'quote marked as created by and editable by this client');
  const dbq = (await pool.query('SELECT prepared_by, company_code, notes FROM rel_quotes WHERE id = $1', [q1.id])).rows[0];
  ok(dbq.prepared_by === 'Sally (AI Sales Assistant)', 'attributed to Sally, not to a person');
  ok(dbq.company_code === '2', 'created in the client\'s company');
  ok(String(dbq.notes).includes('[Sally ref ENQ-TEST-001 · request key-create-001]'), 'request marker stored for crash recovery');

  console.log('\n— idempotency and duplicates');
  r = await call('POST', '/quotes', { body: goodQuote, headers: { 'Idempotency-Key': 'key-create-001' } });
  ok(r.status === 201 && r.body.quote.id === q1.id && r.headers.get('idempotent-replayed') === 'true', 'retry with the same key replays the same quote', r.body);
  ok(Number((await pool.query('SELECT count(*) FROM rel_quotes')).rows[0].count) === 1, 'retry did not create a second quote');
  r = await call('POST', '/quotes', { body: { ...goodQuote, notes: 'different' }, headers: { 'Idempotency-Key': 'key-create-001' } });
  ok(r.status === 422 && r.body.error.code === 'IDEMPOTENCY_KEY_REUSED', 'same key with a different body refused');
  r = await call('POST', '/quotes', { body: goodQuote, headers: { 'Idempotency-Key': 'key-create-002' } });
  ok(r.status === 409 && r.body.error.code === 'DUPLICATE_QUOTE' && r.body.error.details.existing[0].id === q1.id, 'second quote for the same enquiry refused as a duplicate', r.body);
  r = await call('POST', '/quotes', { body: { ...goodQuote, allowAdditionalQuote: true }, headers: { 'Idempotency-Key': 'key-create-003' } });
  ok(r.status === 428 && r.body.error.code === 'CONFIRMATION_REQUIRED', 'an additional quote needs explicit confirmation');
  r = await call('POST', '/quotes', { body: { ...goodQuote, allowAdditionalQuote: true }, headers: { 'Idempotency-Key': 'key-create-004', 'X-Confirmed-By': 'sally@signacore.co.za' } });
  ok(r.status === 201 && r.body.quote.id !== q1.id, 'confirmed additional quote created');
  const q2 = r.body.quote;

  // Crash recovery: idempotency row stuck in_progress, quote exists with marker.
  await pool.query(`UPDATE integration_idempotency SET state='in_progress', response_status=NULL, response_body=NULL, updated_at = NOW() - INTERVAL '5 minutes' WHERE idempotency_key='key-create-001'`);
  r = await call('POST', '/quotes', { body: goodQuote, headers: { 'Idempotency-Key': 'key-create-001' } });
  ok(r.status === 201 && r.body.quote.id === q1.id, 'stale in-progress request recovered from the stored marker (no duplicate)', r.body);
  await pool.query(`UPDATE integration_idempotency SET state='in_progress', updated_at = NOW() WHERE idempotency_key='key-create-001'`);
  r = await call('POST', '/quotes', { body: goodQuote, headers: { 'Idempotency-Key': 'key-create-001' } });
  ok(r.status === 409 && r.body.error.code === 'IDEMPOTENCY_IN_PROGRESS', 'a request still in progress is not repeated');

  console.log('\n— idempotency acquisition race (deterministic, no sleeps)');
  const countQuotes = async () => Number((await pool.query('SELECT count(*) FROM rel_quotes')).rows[0].count);
  const raceQuote = { ...goodQuote, externalRef: 'ENQ-TEST-RACE' };
  const quotesBeforeRace = await countQuotes();
  // Request A holds the key in_progress …
  await pool.query(`INSERT INTO integration_idempotency (client_id, idempotency_key, operation, request_hash, state)
                    VALUES ('sally-test', 'key-race-001', 'quote.create_draft', 'held-by-request-a', 'in_progress')`);
  let raceHookCalls = 0;
  // … and releases it exactly between request B's conflicting INSERT and B's SELECT.
  __testHooks.afterIdempotencyConflict = async (clientId, key) => {
    if (key !== 'key-race-001') return;
    raceHookCalls++;
    await pool.query('DELETE FROM integration_idempotency WHERE client_id = $1 AND idempotency_key = $2', [clientId, key]);
  };
  try {
    r = await call('POST', '/quotes', { body: raceQuote, headers: { 'Idempotency-Key': 'key-race-001' } });
  } finally {
    delete __testHooks.afterIdempotencyConflict;
  }
  ok(raceHookCalls === 1, 'race reproduced: key released between the conflicting INSERT and the SELECT', raceHookCalls);
  ok(r.status === 409 && r.body?.error?.code === 'IDEMPOTENCY_IN_PROGRESS', 'request that lost the race is NOT treated as newly acquired (409 IDEMPOTENCY_IN_PROGRESS)', r.body);
  ok(await countQuotes() === quotesBeforeRace, 'request that lost the race wrote no quote');
  ok((await pool.query(`SELECT 1 FROM integration_idempotency WHERE client_id='sally-test' AND idempotency_key='key-race-001'`)).rowCount === 0,
    'request that lost the race holds no idempotency reservation');
  ok((await pool.query(`SELECT 1 FROM integration_records WHERE external_ref='ENQ-TEST-RACE'`)).rowCount === 0, 'request that lost the race recorded no ownership');
  r = await call('POST', '/quotes', { body: raceQuote, headers: { 'Idempotency-Key': 'key-race-001' } });
  ok(r.status === 201 && r.body.quote?.createdByThisClient === true, 'retry acquires the key itself, then creates the quote', r.body);
  const raceQ = r.body.quote;
  r = await call('POST', '/quotes', { body: raceQuote, headers: { 'Idempotency-Key': 'key-race-001' } });
  ok(r.status === 201 && r.body.quote?.id === raceQ?.id && r.headers.get('idempotent-replayed') === 'true', 'further retry replays the same quote');
  ok(await countQuotes() === quotesBeforeRace + 1, 'exactly one quote exists for the raced key (no duplicate mutation)');

  console.log('\n— proforma: editableByClient agrees with the PATCH rule');
  await pool.query(`UPDATE rel_quotes SET proforma_num = 'PF-TEST-0001' WHERE id = $1`, [raceQ.id]);
  r = await call('GET', `/quotes/${raceQ.id}`);
  ok(r.status === 200 && r.body.quote.status === 'draft' && r.body.quote.createdByThisClient === true && r.body.quote.editableByClient === false,
    'owned draft with a proforma is reported as editableByClient: false', r.body?.quote);
  const pfVersion = r.body.quote?.rowVersion;
  r = await call('PATCH', `/quotes/${raceQ.id}`, { body: { expectedVersion: pfVersion, notes: 'edit after proforma' }, headers: { 'Idempotency-Key': 'key-proforma-001' } });
  ok(r.status === 409 && r.body.error.code === 'QUOTE_NOT_EDITABLE', 'quote with a proforma cannot be edited', r.body);
  const pfAfter = (await call('GET', `/quotes/${raceQ.id}`)).body.quote;
  ok(pfAfter.rowVersion === pfVersion && !String(pfAfter.notes || '').includes('edit after proforma'), 'refused proforma edit changed nothing');

  console.log('\n— ownership recovery after a post-commit ownership-record failure');
  const ownQuote = { ...goodQuote, externalRef: 'ENQ-TEST-OWN' };
  const ownMarker = '[Sally ref ENQ-TEST-OWN · request key-own-001]';
  const countByMarker = async (m: string) => Number((await pool.query(`SELECT count(*) FROM rel_quotes WHERE POSITION($1 IN COALESCE(notes,'')) > 0`, [m])).rows[0].count);
  let ownFailures = 0;
  __testHooks.beforeRecordOwnership = async () => {
    if (ownFailures === 0) { ownFailures++; throw new Error('simulated ownership insert failure (test)'); }
  };
  try {
    r = await call('POST', '/quotes', { body: ownQuote, headers: { 'Idempotency-Key': 'key-own-001' } });
  } finally {
    delete __testHooks.beforeRecordOwnership;
  }
  const ownQ = r.body?.quote;
  ok(ownFailures === 1 && r.status === 201 && Boolean(ownQ?.id), 'quote committed even though the ownership record failed', r.body);
  ok(ownQ?.createdByThisClient === false && ownQ?.editableByClient === false, 'response does not claim ownership that was not recorded');
  ok((await pool.query('SELECT 1 FROM integration_records WHERE record_id = $1', [ownQ.id])).rowCount === 0, 'ownership row really is missing (failure simulated)');
  ok((await pool.query(`SELECT state FROM integration_idempotency WHERE client_id='sally-test' AND idempotency_key='key-own-001'`)).rows[0]?.state === 'in_progress',
    'key left in_progress (neither completed nor released) so recovery can still run');
  r = await call('POST', '/quotes', { body: ownQuote, headers: { 'Idempotency-Key': 'key-own-001' } });
  ok(r.status === 409 && r.body.error.code === 'IDEMPOTENCY_IN_PROGRESS', 'immediate same-key retry waits (409), no second quote');
  ok(await countByMarker(ownMarker) === 1, 'still exactly one quote for the request');
  await pool.query(`UPDATE integration_idempotency SET updated_at = NOW() - INTERVAL '5 minutes' WHERE client_id='sally-test' AND idempotency_key='key-own-001'`);
  r = await call('POST', '/quotes', { body: ownQuote, headers: { 'Idempotency-Key': 'key-own-001' } });
  ok(r.status === 201 && r.body.quote?.id === ownQ.id && r.headers.get('idempotent-replayed') === 'true', 'stale retry recovers the same quote from its marker', r.body);
  ok(r.body.quote?.createdByThisClient === true && r.body.quote?.editableByClient === true, 'recovery restored ownership (quote now editable by this client)');
  ok((await pool.query(`SELECT external_ref FROM integration_records WHERE client_id='sally-test' AND record_id=$1`, [ownQ.id])).rows[0]?.external_ref === 'ENQ-TEST-OWN',
    'ownership row restored with the original external reference');
  ok((await pool.query(`SELECT state FROM integration_idempotency WHERE client_id='sally-test' AND idempotency_key='key-own-001'`)).rows[0]?.state === 'completed', 'key completed after recovery');
  ok(await countByMarker(ownMarker) === 1, 'recovery created no second quote');
  r = await call('POST', '/quotes', { body: ownQuote, headers: { 'Idempotency-Key': 'key-own-002' } });
  ok(r.status === 409 && r.body.error.code === 'DUPLICATE_QUOTE', 'after recovery the duplicate guard sees the quote again', r.body);

  // Recovery only claims the exact quote the request wrote (full marker), never a person's quote.
  const decoyBody = { ...goodQuote, externalRef: 'ENQ-TEST-DECOY' };
  const decoy = await createQuote({ companyCode: '2', customerNameRaw: 'Walk-in decoy (test)', notes: 'pasted text ending in request key-decoy-001]',
    lines: [{ description: 'Manual line', qty: 1, unitPrice: 100 }] });
  await pool.query(`INSERT INTO integration_idempotency (client_id, idempotency_key, operation, request_hash, state, updated_at)
                    VALUES ('sally-test', 'key-decoy-001', 'quote.create_draft', $1, 'in_progress', NOW() - INTERVAL '5 minutes')`,
    [requestHash('quote.create_draft', 'quotes', decoyBody)]);
  r = await call('POST', '/quotes', { body: decoyBody, headers: { 'Idempotency-Key': 'key-decoy-001' } });
  ok(r.status === 201 && r.body.quote?.id !== decoy.id, 'stale recovery never claims a person\'s quote that merely contains the key text', r.body);
  ok((await pool.query('SELECT 1 FROM integration_records WHERE record_id = $1', [decoy.id])).rowCount === 0, 'the person\'s quote is still not owned by the client');

  console.log('\n— PATCH: committed update whose read-back fails keeps its idempotency key');
  const rbBefore = (await call('GET', `/quotes/${ownQ.id}`)).body.quote;
  ok(rbBefore?.editableByClient === true, 'precondition: owned editable draft', rbBefore);
  let readbackFailures = 0;
  __testHooks.beforeUpdateReadback = async () => {
    readbackFailures++;
    throw new Error('simulated post-commit read-back failure (test)');
  };
  try {
    r = await call('PATCH', `/quotes/${ownQ.id}`, { body: { expectedVersion: rbBefore.rowVersion, reference: 'Committed before read-back failure' }, headers: { 'Idempotency-Key': 'key-readback-001' } });
  } finally {
    delete __testHooks.beforeUpdateReadback;
  }
  ok(readbackFailures === 1, 'read-back failure simulated exactly once, after the update', readbackFailures);
  ok(r.status === 200 && r.body?.partial === true && r.body?.quote?.id === ownQ.id, 'committed update is reported (partial response), not as a failure', r.body);
  const rbRow = (await pool.query('SELECT reference, row_version FROM rel_quotes WHERE id = $1', [ownQ.id])).rows[0];
  ok(rbRow.reference === 'Committed before read-back failure' && Number(rbRow.row_version) > Number(rbBefore.rowVersion), 'the quote change really committed', rbRow);
  const rbIdem = (await pool.query(`SELECT state, response_status FROM integration_idempotency WHERE client_id='sally-test' AND idempotency_key='key-readback-001'`)).rows[0];
  ok(Boolean(rbIdem), 'idempotency reservation was NOT released after the commit');
  ok(rbIdem?.state === 'completed' && Number(rbIdem?.response_status) === 200, 'key completed with the committed (partial) result', rbIdem);
  r = await call('PATCH', `/quotes/${ownQ.id}`, { body: { expectedVersion: rbBefore.rowVersion, reference: 'Committed before read-back failure' }, headers: { 'Idempotency-Key': 'key-readback-001' } });
  ok(r.status === 200 && r.headers.get('idempotent-replayed') === 'true' && r.body?.partial === true, 'same-key retry replays the committed result (not treated as a new request)', r.body);
  ok(Number((await pool.query('SELECT row_version FROM rel_quotes WHERE id = $1', [ownQ.id])).rows[0].row_version) === Number(rbRow.row_version),
    'retry did not apply the update a second time');

  console.log('\n— draft updates');
  r = await call('PATCH', `/quotes/${q1.id}`, { body: { expectedVersion: q1.rowVersion, lines: [{ productRef: 'inv:800001', qty: 4, pieces: 2 }] }, headers: { 'Idempotency-Key': 'key-update-001' } });
  ok(r.status === 200 && r.body.quote.totals.subtotalExVat === 4160 && r.body.quote.totals.totalInclVat === 4784, 'line update recalculated by Signacore (2×4×520 = 4160 + VAT)', r.body?.quote?.totals || r.body);
  const v2 = r.body.quote?.rowVersion;
  r = await call('PATCH', `/quotes/${q1.id}`, { body: { expectedVersion: q1.rowVersion, reference: 'stale' }, headers: { 'Idempotency-Key': 'key-update-002' } });
  ok(r.status === 409 && r.body.error.code === 'STALE_VERSION', 'stale expectedVersion refused', r.body);
  r = await call('PATCH', `/quotes/${q1.id}`, { body: { expectedVersion: v2, notes: 'Updated note' }, headers: { 'Idempotency-Key': 'key-update-003' } });
  const notesNow = (await pool.query('SELECT notes FROM rel_quotes WHERE id=$1', [q1.id])).rows[0].notes;
  ok(r.status === 200 && notesNow.startsWith('Updated note') && notesNow.includes('[Sally ref ENQ-TEST-001'), 'notes updated, Sally marker preserved', notesNow);
  r = await call('PATCH', `/quotes/${q1.id}`, { body: { expectedVersion: r.body.quote?.rowVersion, lines: [{ productRef: 'inv:800001', qty: 1, unitPrice: 1 }] }, headers: { 'Idempotency-Key': 'key-update-004' } });
  ok(r.status === 403 && r.body.error.code === 'FIELD_NOT_PERMITTED', 'price override refused on update');

  const human = await createQuote({ companyCode: '2', customerNameRaw: 'Walk-in (test)', lines: [{ description: 'Manual line', qty: 1, unitPrice: 100 }] });
  r = await call('PATCH', `/quotes/${human.id}`, { body: { expectedVersion: human.rowVersion, notes: 'hijack' }, headers: { 'Idempotency-Key': 'key-update-005' } });
  ok(r.status === 403 && r.body.error.code === 'NOT_OWNED', 'cannot edit a quote a person created');
  await pool.query(`UPDATE rel_quotes SET status='sent' WHERE id=$1`, [q2.id]);
  r = await call('PATCH', `/quotes/${q2.id}`, { body: { expectedVersion: q2.rowVersion, notes: 'x' }, headers: { 'Idempotency-Key': 'key-update-006' } });
  ok(r.status === 409 && r.body.error.code === 'QUOTE_NOT_EDITABLE', 'cannot edit a quote that is no longer a draft');
  const other = await createQuote({ companyCode: '1', customerNameRaw: 'Holdings customer (test)', lines: [{ description: 'x', qty: 1, unitPrice: 1 }] });
  ok((await call('GET', `/quotes/${other.id}`)).status === 404, 'quote in another company is invisible (no IDOR)');

  console.log('\n— company isolation & forbidden update fields');
  r = await call('GET', '/quotes?q=Holdings');
  ok(r.status === 200 && r.body.results.length === 0, 'quote search never returns another company\'s quotes', r.body);
  r = await call('GET', `/quotes?q=${encodeURIComponent(other.quoteNumber)}`);
  ok(r.body.results.length === 0, 'searching another company\'s quote number finds nothing');
  r = await call('PATCH', `/quotes/${other.id}`, { body: { expectedVersion: other.rowVersion, notes: 'x' }, headers: { 'Idempotency-Key': 'key-iso-001' } });
  ok(r.status === 404, 'another company\'s quote cannot be updated (404, not even acknowledged)', r.body);
  r = await call('POST', '/quotes', { body: { ...goodQuote, externalRef: 'ENQ-TEST-ISO', companyCode: '1' }, headers: { 'Idempotency-Key': 'key-iso-002' } });
  ok(r.status === 403 && r.body.error.code === 'FIELD_NOT_PERMITTED', 'caller-supplied companyCode refused (company comes from the service client)');
  const freshQ1 = (await call('GET', `/quotes/${q1.id}`)).body.quote;
  for (const [field, value] of [['status', 'sent'], ['discountPct', 10], ['setupFee', 100], ['total', 1], ['companyCode', '1']] as const) {
    r = await call('PATCH', `/quotes/${q1.id}`, { body: { expectedVersion: freshQ1.rowVersion, [field]: value }, headers: { 'Idempotency-Key': `key-forbid-${field}` } });
    ok(r.status === 403 && r.body.error.code === 'FIELD_NOT_PERMITTED', `update refuses "${field}"`, r.body);
  }
  r = await call('PATCH', `/quotes/${q1.id}`, { body: { expectedVersion: freshQ1.rowVersion, colour: 'red' }, headers: { 'Idempotency-Key': 'key-unexpected-1' } });
  ok(r.status === 400 && r.body.error.code === 'VALIDATION_ERROR', 'unexpected (non-price) field refused on update');
  r = await call('POST', '/quotes', { body: { ...goodQuote, externalRef: 'ENQ-TEST-UX', colour: 'red' }, headers: { 'Idempotency-Key': 'key-unexpected-2' } });
  ok(r.status === 400 && r.body.error.code === 'VALIDATION_ERROR', 'unexpected (non-price) field refused on create');
  const afterForbidden = (await call('GET', `/quotes/${q1.id}`)).body.quote;
  ok(afterForbidden.status === 'draft' && afterForbidden.rowVersion === freshQ1.rowVersion, 'refused updates changed nothing (still draft, same version)');
  ok((await pool.query(`SELECT company_code FROM rel_quotes WHERE id IN (SELECT record_id FROM integration_records WHERE client_id='sally-test')`)).rows.every((x: any) => x.company_code === '2'),
    'every quote the client created is in its own company (2)');

  console.log('\n— quote retrieval & search');
  r = await call('GET', `/quotes/${q1.id}`);
  ok(r.status === 200 && r.body.quote.quoteNumber === q1.quoteNumber && r.body.quote.totals.calculatedBy === 'signacore', 'quote retrieved with Signacore totals');
  r = await call('GET', '/quotes?externalRef=ENQ-TEST-001');
  ok(r.status === 200 && r.body.results.length === 2, 'search by external reference finds Sally\'s quotes', r.body);
  r = await call('GET', `/quotes?q=${encodeURIComponent(q1.quoteNumber)}`);
  ok(r.body.results.some((x: any) => x.id === q1.id), 'search by quote number');
  r = await call('GET', '/quotes?status=sent');
  ok(r.body.results.length === 1 && r.body.results[0].id === q2.id, 'search by status');

  console.log('\n— cutover authority');
  await setCutover('quotes', false);
  r = await call('POST', '/quotes', { body: { ...goodQuote, externalRef: 'ENQ-TEST-009' }, headers: { 'Idempotency-Key': 'key-notcut-001' } });
  ok(r.status === 409 && r.body.error.code === 'SECTION_NOT_RELATIONAL', 'no quote writes when quotes are not relational-authoritative');
  await setCutover('quotes', true);
  process.env.RELATIONAL_AUTHORITY_ENABLED = 'false';
  r = await call('GET', '/products?q=acm');
  ok(r.status === 503 && r.body.error.code === 'SECTION_AUTHORITY_MISMATCH', 'master switch off + cutover rows on → refuse instead of serving frozen copy', r.body);
  process.env.RELATIONAL_AUTHORITY_ENABLED = 'true';

  console.log('\n— audit');
  await new Promise((res) => setTimeout(res, 300));
  const audit = await pool.query(`SELECT * FROM integration_audit ORDER BY id`);
  const created = audit.rows.find((a: any) => a.operation === 'quote.create_draft' && a.outcome === 'success');
  ok(Boolean(created) && created.client_id === 'sally-test' && created.target_type === 'quote' && created.acting_for === 'sally@signacore.co.za', 'quote creation audited with client, target and acting-for', created);
  ok(audit.rows.some((a: any) => a.outcome === 'denied' && a.error_code === 'FORBIDDEN_SCOPE'), 'scope denials audited');
  ok(audit.rows.some((a: any) => a.outcome === 'replayed'), 'idempotent replays audited');
  const dump = JSON.stringify(audit.rows) + JSON.stringify((await pool.query('SELECT * FROM integration_idempotency')).rows);
  ok(!dump.includes(SECRET) && !dump.includes(LIMITED_SECRET), 'no secret appears in audit or idempotency tables');
  ok(!serverLog.join('\n').includes(SECRET) && !serverLog.join('\n').includes(LIMITED_SECRET) && !serverLog.join('\n').includes(REVOKED_SECRET), 'no secret appears in server log output');
  const stored = (await pool.query(`SELECT secret_hash FROM integration_clients WHERE client_id='sally-test'`)).rows[0].secret_hash;
  ok(stored !== SECRET && /^[0-9a-f]{64}$/.test(stored), 'only a hash of the secret is stored');

  server.close();
  await pool.end();
  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

main().catch(async (e) => { console.error(e); try { await pool.end(); } catch { /* */ } process.exit(1); });


