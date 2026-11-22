/**
 * integration-materials.stress.ts — Job Material Lists, Materials to Order and /read/capabilities (owner read API).
 *
 * Runs the real integration router and the real platform-state save route against a DISPOSABLE local database
 * (name must end in _test; apply migrations first):
 *
 *   DATABASE_URL=postgres://.../signacore_test npx ts-node --transpile-only test/integration-materials.stress.ts
 *
 * The automatic Material List estimate is checked against the dashboard's OWN sgrAutoMaterialList, lifted from
 * index.html at test time. Set MATERIALS_TEST_SERVE_PORT to keep serving the seeded fixture afterwards (for the
 * CORE-AGENTS end-to-end test). All data and secrets below are invented.
 */
process.env.TZ = 'UTC';
process.env.RELATIONAL_AUTHORITY_ENABLED = 'true';
process.env.INTEGRATION_API_ENABLED = 'true';
process.env.JWT_SECRET = 'materials-test-jwt-secret-not-real';

import express from 'express';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'net';
import pool from '../src/db/pool';
import router from '../src/integration/router';
import platformStateRouter from '../src/routes/platformState';
import { hashSecret } from '../src/integration/keys';
import { OWNER_READ_SCOPES } from '../src/integration/scopes';
import { READ_TYPES, SCHEMA_VERSION } from '../src/integration/readCatalog';
import { runBackfill } from '../src/relational/backfill';

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 700) : ''}`); }
}

// ── the dashboard's own Material List functions, lifted from index.html ─────
function frontendMaterials() {
  const html = fs.readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');
  const a = html.indexOf('const SGR_MATERIAL_LIST_KEY');
  const b = html.indexOf('EDITABLE DATA', a);
  // eslint-disable-next-line no-new-func
  return new Function(`${html.slice(html.lastIndexOf('\n', a), html.lastIndexOf('/*', b))}\nreturn { sgrAutoMaterialList, sgrMaterialList, SGR_MATERIAL_ROLL_W };`)() as any;
}

const SECRET = 'test-secret-core-agents-0123456789abcdefghijklmnopqrstu';
const NARROW_SECRET = 'test-secret-narrow-0123456789abcdefghijklmnopqrstuvwxy';
const BUYER_SECRET = 'test-secret-buyer-0123456789abcdefghijklmnopqrstuvwxyz';
const SALLY_SECRET = 'test-secret-sally-0123456789abcdefghijklmnopqrstuvwxyz';

const estimateLines = [
  { desc: '3mm ACP tray sign 1200x600 with full colour print and gloss laminate (test)', qty: 1, unit: 'm²', sqmL: 1200, sqmW: 600, pQty: 2, unitPrice: 900 },
  { desc: 'Outdoor LED modules (test)', qty: 40, unit: 'each', unitPrice: 12 },
  { desc: '12V power supply (test)', qty: 1, unit: 'each', unitPrice: 350 },
  { desc: 'Installation labour (test)', qty: 3, unit: 'hr', unitPrice: 450 },
];
const savedList = { v: 1, rollW: 1.37, qty: { acp: 4, vinyl_white: 12, bogus_row: 3, led_indoor: 0 }, other: [{ id: 'o1', material: 'Wall brackets', size: '50mm', qty: 6, amount: '6 each' }, { id: 'o2', material: '', qty: 1 }] };

const state = {
  customers: [{ id: 1, companyName: 'Material Test Client', contactPerson: 'Ann Test', email: 'ann@material.test', tel: '044 555 0001' }],
  suppliers: [{ id: 601, name: 'Board Test Supplies', email: 'boards@test.test' }],
  inventory: [
    { id: 700001, sku: 'ACM-3-WHITE', name: 'ACM board 3mm white (test)', cat: 'Boards', unit: 'sheet', cost: 300, sell: 520, stock: 3, reorder: 2, supplierId: 601 },
    { id: 700002, sku: 'VINYL-WHITE', name: 'White vinyl 1370mm (test)', cat: 'Vinyl', unit: 'm', cost: 20, sell: 95, stock: 40, reorder: 10 },
  ],
  quickRates: [],
  completeProducts: [],
  quotes: [
    { id: 3201, co: '4', num: 'SQ-0201', status: 'converted', convertedJobId: 5204, client: 'Cover Material Client', date: '2026-11-01', discount: 0, setupFee: 0, lines: estimateLines },
  ],
  jobs: [
    { id: 5201, co: '2', num: 'J-0201', stage: 6, status: 'active', client: 'Material Test Client', desc: 'Saved list (test)', value: 9000, lines: estimateLines, breakdown: { materials: 2400, labour: 1350, material_list: savedList } },
    { id: 5202, co: '2', num: 'J-0202', stage: 5, status: 'active', client: 'Material Test Client', desc: 'Saved EMPTY list (test)', value: 1000, lines: estimateLines, breakdown: { material_list: { v: 1, rollW: 1.37, qty: {}, other: [] } } },
    { id: 5203, co: '2', num: 'J-0203', stage: 4, status: 'active', client: 'Material Test Client', desc: 'No list: estimate from job lines (test)', value: 5000, lines: estimateLines, breakdown: { materials: 900 } },
    { id: 5204, co: '4', num: 'J-0204', stage: 3, status: 'active', client: 'Cover Material Client', desc: 'No lines: estimate from its quote (test)', value: 5000, quoteNum: 'SQ-0201' },
    { id: 5205, co: '1', num: 'H-0205', stage: 6, status: 'active', client: 'Holdings Material Client', desc: 'Holdings saved list (test)', value: 3000, breakdown: { material_list: { rollW: 1.37, qty: { acp: 2 }, other: [] } } },
    { id: 5206, co: '2', num: 'J-0206', stage: 2, status: 'active', client: 'Material Test Client', desc: 'Unreadable list (test)', value: 100, breakdown: { material_list: 'not-a-list' } },
    { id: 5207, num: 'J-0099', stage: 8, status: 'completed', client: 'Older Untagged Client', desc: 'Job saved before Material Lists existed (test)', value: 700 },
  ],
  accInvoices: [], creditNotes: [], accBills: [], proposedProjects: [],
  purchaseOrders: [{ id: 9201, co: '2', num: 'PO-0201', status: 'approved', date: '2026-11-20', supplierId: 601, jobNum: 'J-0201', items: [{ inventoryId: 700001, sku: 'ACM-3-WHITE', name: 'ACM board 3mm white (test)', unit: 'sheet', qtyNeeded: 4, qtyOrdered: 2, unitCost: 300 }] }],
  materialOrders: [
    { id: 's:acp', supplier: 'Board Test Supplies', adjust: 1, ordered: { 5201: 2, 5204: 1, 99999: 5 }, orderedAt: '2026-11-22T10:00:00Z', orderedBy: 'Person Name Must Not Leak' },
    { id: 's:vinyl_white', supplier: 'Vinyl Test Co', ordered: {} },
    { id: 's:o:wall brackets', manual: true, material: 'Wall brackets', size: '50mm', unit: 'each', supplier: 'Hardware Test', ordered: { 5201: 6 } },
    { id: 'h:acp', supplier: 'Holdings Board Co', ordered: { 5205: 2 } },
    { id: 'no-scope-record', supplier: 'x', ordered: { 5201: 1 } },
  ],
  userAccounts: [{ username: 'owner-test', passwordHash: 'PASSWORD-HASH-MUST-NOT-LEAK', role: 'admin' }],
};

let base = '';
let stateBase = '';
async function call(method: string, url: string, headers: Record<string, string>, body?: unknown) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* empty */ }
  return { status: res.status, body: json, text };
}
const get = (p: string, o: { client?: string; secret?: string } = {}) => call('GET', `${base}${p}`, { 'X-Integration-Client': o.client || 'core-agents-test', Authorization: `Bearer ${o.secret || SECRET}` });
const NARROW = { client: 'narrow-test', secret: NARROW_SECRET };
const BUYER = { client: 'buyer-test', secret: BUYER_SECRET };
const SALLY = { client: 'sally-test', secret: SALLY_SECRET };

async function seed() {
  const db = (await pool.query('SELECT current_database() AS d')).rows[0].d as string;
  if (!db.endsWith('_test')) throw new Error(`Refusing to run against "${db}" — use a *_test database.`);
  await pool.query(`TRUNCATE integration_audit, integration_idempotency, integration_records, integration_clients RESTART IDENTITY`);
  const rel = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'rel\\_%' AND tablename NOT IN ('rel_companies')`);
  await pool.query(`TRUNCATE ${rel.rows.map((r) => r.tablename).join(', ')} RESTART IDENTITY CASCADE`);
  await pool.query(`UPDATE relational_cutover SET enabled = false`);
  await pool.query(`INSERT INTO platform_state (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`, [JSON.stringify(state)]);
  const ins = `INSERT INTO integration_clients (client_id, display_name, secret_hash, scopes, company_code, read_only, read_company_codes) VALUES ($1,$2,$3,$4,$5,$6,$7)`;
  await pool.query(ins, ['core-agents-test', 'CORE-AGENTS (test)', hashSecret(SECRET), [...OWNER_READ_SCOPES], '1', true, ['1', '2', '4']]);
  await pool.query(ins, ['narrow-test', 'Narrow reader (test)', hashSecret(NARROW_SECRET), ['sales:read', 'jobs:read'], '2', true, ['2']]);
  await pool.query(ins, ['buyer-test', 'Purchasing reader, Signacore only (test)', hashSecret(BUYER_SECRET), ['jobs:read', 'purchasing:read', 'inventory:read'], '2', true, ['2']]);
  await pool.query(ins, ['sally-test', 'Sally (test)', hashSecret(SALLY_SECRET), ['customer:read', 'product:read', 'inventory:read', 'pricing:read', 'quote:read', 'quote:create', 'quote:update'], '2', false, []]);
}

const fe = frontendMaterials();
const qtyMap = (lines: any[]) => Object.fromEntries(lines.filter((l) => l.key).map((l) => [l.key, l.qty]));
const otherMap = (lines: any[]) => lines.filter((l) => l.kind === 'other').map((l) => `${l.material}:${l.qty}`).sort();

async function jobSuite(mode: 'platform_state' | 'relational') {
  console.log(`\n══ job Material Lists — ${mode} authority ══`);
  const out: Record<string, unknown> = {};
  let r = await get('/read/jobs/J-0201');
  let j = r.body?.job;
  const ml = j?.materialList;
  ok(r.status === 200 && ml.state === 'saved' && ml.effective === 'saved', 'J-0201: saved Material List', ml);
  ok(JSON.stringify(qtyMap(ml.saved.lines)) === JSON.stringify({ acp: 4, vinyl_white: 12 }) && JSON.stringify(otherMap(ml.saved.lines)) === JSON.stringify(['Wall brackets:6']), 'saved lines: set rows and "other" lines, normalised exactly as the dashboard reads them', ml.saved?.lines);
  const acp = ml.saved.lines.find((l: any) => l.key === 'acp');
  ok(acp.qtyUnit === 'sheets' && acp.sheetLengthM === 3 && acp.sheetWidthM === 1.5 && acp.areaM2 === 18, 'units and sheet dimensions kept (4 sheets of 3 m × 1.5 m = 18 m²)', acp);
  const vinyl = ml.saved.lines.find((l: any) => l.key === 'vinyl_white');
  ok(vinyl.qtyUnit === 'm' && vinyl.rollWidthM === 1.37 && vinyl.areaM2 === 16.44, 'roll material in metres with the roll width', vinyl);
  ok(JSON.stringify(ml.saved.ignoredEntries) === JSON.stringify(['qty.bogus_row', 'qty.led_indoor', 'other[1]']), 'entries the dashboard ignores are reported, not silently dropped', ml.saved?.ignoredEntries);
  ok(ml.stored && ml.stored.qty.bogus_row === 3 && ml.estimate === null, 'the stored structure is returned as saved; no estimate when a list is saved', ml.stored);
  ok(ml.saved.lines.every((l: any) => l.stockItemRef === null) && /does not link/.test(ml.relationships.stockItems), 'no stock link invented', ml.relationships);
  ok(j.costBreakdown.categories.materials === 2400 && j.costBreakdown.categories.labour === 1350 && !('material_list' in j.costBreakdown.categories), 'cost breakdown: numbers only, the Material List is not a cost', j.costBreakdown);
  ok(Array.isArray(j.lines) && j.lines.length === 4 && j.lines[0].lengthMm === 1200 && j.lines[3].unit === 'hr', 'job lines on the detail, with dimensions and units', j.lines);
  out.saved = ml.saved;

  r = await get('/read/jobs/J-0202');
  ok(r.body.job.materialList.state === 'saved_empty' && r.body.job.materialList.saved.lines.length === 0 && r.body.job.materialList.estimate === null, 'J-0202: an explicitly saved EMPTY list stays empty (no estimate substituted)', r.body.job.materialList);

  r = await get('/read/jobs/J-0203');
  j = r.body.job;
  const feEst = fe.sgrAutoMaterialList(estimateLines, { inventory: state.inventory, completeProducts: state.completeProducts, rollW: fe.SGR_MATERIAL_ROLL_W });
  const est = j.materialList.estimate;
  ok(j.materialList.state === 'none' && j.materialList.effective === 'estimate' && est.available && /^ESTIMATED/.test(est.label), 'J-0203: nothing saved → labelled ESTIMATE', j.materialList);
  ok(JSON.stringify(qtyMap(est.lines)) === JSON.stringify(Object.fromEntries(Object.entries(feEst.qty))), 'estimate equals the dashboard\'s own sgrAutoMaterialList', { api: qtyMap(est.lines), dashboard: feEst.qty });
  ok(est.basis.linesFrom === 'job' && est.basis.lineCount === 4 && /labour/.test(est.basis.serviceLinesLeftOut), 'estimate basis: the job\'s 4 lines; labour left out', est.basis);
  ok(typeof j.materialList.calculation.version === 'string' && j.materialList.calculation.available === true, 'calculation version reported', j.materialList.calculation);
  out.estimate = est.lines;

  r = await get('/read/jobs/J-0204?company=4');
  ok(r.status === 200 && r.body.job.materialList.estimate.basis.linesFrom === 'quote' && r.body.job.materialList.estimate.basis.quoteNumber === 'SQ-0201', 'J-0204 (Cover X) has no lines: estimate from its quote SQ-0201', r.body.job?.materialList?.estimate?.basis);
  r = await get('/read/jobs/J-0204', NARROW);
  ok(r.status === 404, 'a reader for Signacore only gets 404 for a Cover X job (same as not existing)', r.body);
  r = await get('/read/jobs/J-0204?company=4', NARROW);
  ok(r.status === 403 && r.body.error.code === 'COMPANY_NOT_AUTHORISED', 'asking for another company is refused, never widened', r.body);

  r = await get('/read/jobs/J-0206');
  ok(r.body.job.materialList.state === 'unreadable' && r.body.job.materialList.effective === 'saved_empty' && r.body.job.materialList.stored === 'not-a-list', 'J-0206: unreadable stored value reported as such (the dashboard shows it as empty)', r.body.job.materialList);
  if (mode === 'platform_state') {
    r = await get('/read/jobs/J-0099');
    ok(r.status === 200 && r.body.job.materialList.state === 'none' && r.body.job.materialList.effective === 'none' && r.body.job.companyTagged === false, 'older untagged job from before Material Lists: none, nothing to estimate from', r.body.job?.materialList);
  }

  r = await get('/read/jobs?company=2&limit=50');
  const listed = Object.fromEntries(r.body.results.map((x: any) => [x.number, x.materialList]));
  ok(listed['J-0201'].state === 'saved' && listed['J-0203'].state === 'none' && listed['J-0203'].effective === 'estimate_on_detail' && listed['J-0203'].estimate === null, 'list: saved lists included; the estimate is on the detail only', listed);
  ok(r.body.results.every((x: any) => !('lines' in x) && !('costBreakdown' in x)), 'list carries no lines or cost breakdown');
  return out;
}

async function materialOrderSuite() {
  console.log('\n══ Materials to Order ══');
  let r = await get('/read/material-orders?limit=50');
  const byId = Object.fromEntries((r.body?.results || []).map((x: any) => [x.id, x]));
  ok(r.status === 200 && byId['s:acp'] && byId['h:acp'], 'owner reader (companies 1, 2, 4) sees both scopes', r.body);
  const sacp = byId['s:acp'];
  ok(sacp.supplier === 'Board Test Supplies' && sacp.adjust === 1 && sacp.unit === 'sheets' && sacp.kind === 'sheet' && sacp.material === 'ACP', 'scope-wide fields shown to a client that may read every company in the scope', sacp);
  ok(JSON.stringify(sacp.orderedByJob.map((e: any) => `${e.jobNumber}:${e.qty}:${e.companyCode}`).sort()) === JSON.stringify(['J-0201:2:2', 'J-0204:1:4']) && sacp.orderedEntriesWithheld === 1, 'per-job ordered quantities with job and company; an entry for a job that no longer exists is withheld', sacp);
  ok(sacp.orderedBy === null && !r.text.includes('Person Name Must Not Leak') && !r.text.includes('PASSWORD-HASH'), 'who ticked it is not exposed; no secrets', null);
  ok(!byId['no-scope-record'] && r.body.notes.some((n: string) => /no company scope/.test(n)), 'a record with no scope is not returned and is reported', r.body.notes);
  ok(byId['s:o:wall brackets'].manual === true && byId['s:o:wall brackets'].material === 'Wall brackets', 'manual line kept with its material and size', byId['s:o:wall brackets']);

  r = await get('/read/material-orders?limit=50', BUYER);
  const b = Object.fromEntries((r.body?.results || []).map((x: any) => [x.id, x]));
  ok(r.status === 200 && !b['h:acp'], 'a Signacore-only reader never sees Holdings material orders', Object.keys(b));
  ok(b['s:acp'] && b['s:acp'].supplier === undefined && /shared by every company/.test(b['s:acp'].scopeFieldsWithheld), 'scope-wide supplier/adjustment withheld from a reader who may not read Cover X', b['s:acp']);
  ok(JSON.stringify(b['s:acp'].orderedByJob.map((e: any) => e.jobNumber)) === JSON.stringify(['J-0201']) && b['s:acp'].orderedEntriesWithheld === 2, 'only the Signacore job\'s quantity is shown; Cover X and unknown-job entries withheld', b['s:acp']);
  ok(!b['s:vinyl_white'], 'a scope-wide record with no readable job entry is not returned to that reader', Object.keys(b));
  r = await get('/read/material-orders', NARROW);
  ok(r.status === 403 && r.body.error.code === 'FORBIDDEN_SCOPE', 'purchasing:read is required', r.body);
  r = await get('/read/material-orders?job=J-0201');
  ok(r.body.results.length === 2 && r.body.results.every((x: any) => x.orderedByJob.every((e: any) => e.jobNumber === 'J-0201')), 'filter by job', r.body.results.map((x: any) => x.id));
  r = await get('/read/material-orders?supplier=hardware');
  ok(r.body.results.length === 1 && r.body.results[0].id === 's:o:wall brackets', 'filter by supplier', r.body.results.map((x: any) => x.id));
  r = await get('/read/material-orders?limit=1&page=2');
  ok(r.body.results.length === 1 && r.body.total === 4 && r.body.hasMore === true, 'pagination: page 2 of 4', { total: r.body.total, hasMore: r.body.hasMore });
  r = await get('/read/material-orders?scope=bogus');
  ok(r.status === 400, 'an invalid scope filter is refused', r.body);
}

async function capabilitySuite() {
  console.log('\n══ /read/capabilities against the real routes ══');
  let r = await get('/read/capabilities');
  const caps = r.body;
  ok(r.status === 200 && caps.apiVersion === 'v1' && caps.schemaVersion === SCHEMA_VERSION && caps.types.length === READ_TYPES.length, 'capabilities: API and schema version, every type', { api: caps?.apiVersion, schema: caps?.schemaVersion });
  ok(caps.types.every((t: any) => t.allowed === true) && JSON.stringify(caps.client.readCompanies) === '["1","2","4"]', 'owner reader: every type allowed; company grant stated', caps.client);
  ok(caps.materialCalculation.available === true, 'Material List rules loaded from index.html', caps.materialCalculation);
  const narrow = (await get('/read/capabilities', NARROW)).body;
  const allowed = narrow.types.filter((t: any) => t.allowed).map((t: any) => t.type).sort();
  ok(JSON.stringify(allowed) === JSON.stringify(['enquiries', 'jobs', 'quotes', 'summary']), 'narrow reader: only what its scopes allow', allowed);

  const SAMPLE_REF: Record<string, string> = { quotes: 'SQ-0201?company=4', jobs: 'J-0201', invoices: '', purchaseOrders: 'PO-0201' };
  for (const t of READ_TYPES) {
    const listPath = t.type === 'supplierPrices' ? `${t.list.path}?item=ACM-3-WHITE` : t.type === 'purchaseOrders' ? `${t.list.path}?items=true` : t.list.path;
    r = await get(listPath);
    const rows: any[] = t.type === 'supplierPrices' ? r.body?.history : r.body?.results;
    ok(r.status === 200 && Array.isArray(rows), `${t.type}: ${t.list.path} answers`, r.body);
    const declared = new Set(t.fields.map((x) => x.name));
    const listDeclared = t.fields.filter((x) => !x.detailOnly).map((x) => x.name);
    const extra = [...new Set((rows || []).flatMap((x) => Object.keys(x)))].filter((k) => !declared.has(k));
    ok(extra.length === 0, `${t.type}: every returned field is described`, extra);
    if (rows && rows.length) {
      const missing = listDeclared.filter((k) => !rows.some((x) => k in x) && !(t.type === 'purchaseOrders' && k === 'itemCount') && !(t.type === 'summary' && ['quotes', 'jobs', 'invoices', 'purchaseOrders', 'stock'].includes(k)) && !(t.type === 'enquiries' && ['jobNumber', 'customer'].includes(k)) && !(t.type === 'materialOrders' && ['scopeFieldsWithheld', 'supplier', 'adjust', 'adjustOrdered', 'orderedAt', 'manual', 'removed'].includes(k) && rows.some((x) => 'supplier' in x || 'scopeFieldsWithheld' in x)));
      ok(missing.length === 0, `${t.type}: every described field is returned`, missing);
    }
    if (t.detail && SAMPLE_REF[t.type]) {
      r = await get(t.detail.path.replace('{ref}', SAMPLE_REF[t.type]));
      const rec = r.body && Object.values(r.body).find((v) => v && typeof v === 'object' && !Array.isArray(v) && 'id' in (v as any)) as any;
      const unknown = rec ? Object.keys(rec).filter((k) => !declared.has(k)) : ['(no record)'];
      ok(r.status === 200 && unknown.length === 0 && t.fields.filter((x) => x.detailOnly).every((x) => x.name in rec), `${t.type}: detail ${t.detail.path} matches its description`, { status: r.status, unknown });
    }
    if (t.scope !== 'any-read') {
      // A client that does NOT hold this scope (Sally holds customer:read and inventory:read; the narrow reader holds sales and jobs).
      const HELD: Array<[typeof NARROW, string[]]> = [[NARROW, ['sales:read', 'jobs:read']], [SALLY, ['customer:read', 'product:read', 'inventory:read', 'pricing:read', 'quote:read']], [BUYER, ['jobs:read', 'purchasing:read', 'inventory:read']]];
      const who = HELD.find(([, sc]) => !sc.includes(t.scope as string))![0];
      const lacking = await get(listPath.replace('?items=true', ''), who);
      ok(lacking.status === 403, `${t.type}: refused without ${t.scope} (${who.client})`, lacking.status);
    }
  }
}

async function saveSuite(appBase: string) {
  console.log('\n══ normal dashboard saves keep Materials to Order ══');
  const token = jwt.sign({ id: 'u-test', email: 'owner@test.test', role: 'admin', co: 2 }, process.env.JWT_SECRET!);
  const H = { Authorization: `Bearer ${token}` };
  const read = async () => (await pool.query(`SELECT data, updated_at FROM platform_state WHERE id = 1`)).rows[0];
  let cur = await read();
  const rev = () => new Date(cur.updated_at).toISOString();
  // 1. A partial save of another section (what every normal save is once jobs are cut over) leaves materialOrders alone.
  let r = await call('PUT', `${appBase}/api/platform-state`, H, { data: { _partial: true, _baseRevision: rev(), suppliers: [...state.suppliers, { id: 602, name: 'New Supplier (test)' }] } });
  cur = await read();
  ok(r.status === 200 && cur.data.materialOrders.length === state.materialOrders.length, 'partial save of suppliers: Materials to Order untouched', { status: r.status, body: r.body, n: cur.data.materialOrders?.length });
  // 2. A save carrying ONLY the record this tab changed (an "Ordered" tick) keeps every other record.
  r = await call('PUT', `${appBase}/api/platform-state`, H, { data: { _partial: true, _baseRevision: rev(), materialOrders: [{ ...state.materialOrders[1], ordered: { 5201: 12 }, orderedAt: '2026-11-23T09:00:00Z' }] } });
  cur = await read();
  const vinyl = cur.data.materialOrders.find((x: any) => x.id === 's:vinyl_white');
  ok(r.status === 200 && cur.data.materialOrders.length === state.materialOrders.length && vinyl.ordered['5201'] === 12, 'tick saved; records this tab did not send are preserved (id merge)', { status: r.status, body: r.body, ids: cur.data.materialOrders.map((x: any) => x.id) });
  // 3. Re-sending the whole array unchanged is a no-op.
  r = await call('PUT', `${appBase}/api/platform-state`, H, { data: { _partial: true, _baseRevision: rev(), materialOrders: cur.data.materialOrders } });
  const after = await read();
  ok(r.status === 200 && JSON.stringify(after.data.materialOrders) === JSON.stringify(cur.data.materialOrders), 'unchanged full resend: nothing changes', r.body);
  // 4. A record nobody asked to delete is never lost.
  r = await call('PUT', `${appBase}/api/platform-state`, H, { data: { _partial: true, _baseRevision: new Date((await read()).updated_at).toISOString(), materialOrders: [cur.data.materialOrders[0]] } });
  ok(r.status === 200 && (await read()).data.materialOrders.length === state.materialOrders.length, 'sending one record never removes the others', r.body);
  await pool.query(`UPDATE platform_state SET data = $1 WHERE id = 1`, [JSON.stringify(state)]); // back to the fixture for what follows
}

async function goRelational() {
  const r = await runBackfill({ apply: true, runByNote: 'integration-materials test' });
  ok(r.ok, 'backfill into relational tables succeeded', { summary: r.summary, conflicts: r.conflicts.slice(0, 5) });
  await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section IN ('customers','suppliers','inventory','quickRates','quotes','jobs','accInvoices','payments','creditNotes')`);
}

async function main() {
  await seed();
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/v1/integration', router);
  app.use('/api/platform-state', platformStateRouter);
  const server = app.listen(0);
  const appBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  base = `${appBase}/api/v1/integration`;
  stateBase = `${appBase}/api/platform-state`;
  void stateBase;

  const a = await jobSuite('platform_state');
  await materialOrderSuite();
  await capabilitySuite();
  await saveSuite(appBase);
  console.log('\n— Sally keeps working (no change to its routes)');
  let r = await get('/customers?q=Material', SALLY);
  ok(r.status === 200 && r.body.results.length === 1, 'Sally customer search', r.body);
  r = await get('/read/jobs', SALLY);
  ok(r.status === 403, 'Sally still cannot use the owner read API', r.body);

  console.log('\n— relational authority');
  await goRelational();
  const b = await jobSuite('relational');
  ok(JSON.stringify(a.saved) === JSON.stringify(b.saved) && JSON.stringify(a.estimate) === JSON.stringify(b.estimate), 'saved list and estimate identical under JSON and relational authority', { json: a, relational: b });

  console.log(`\n${passed} passed, ${failures} failed`);
  const servePort = Number(process.env.MATERIALS_TEST_SERVE_PORT || 0);
  if (servePort && !failures) {
    server.close();
    app.get('/health', (_req, res) => { res.json({ status: 'ok', integrationApiEnabled: true }); });
    app.listen(servePort, '127.0.0.1', () => console.log(`Serving the materials fixture on http://127.0.0.1:${servePort} (client core-agents-test). Ctrl+C to stop.`));
    return;
  }
  server.close();
  await pool.end();
  process.exit(failures ? 1 : 0);
}
main().catch(async (err) => { console.error(err); await pool.end().catch(() => undefined); process.exit(1); });
