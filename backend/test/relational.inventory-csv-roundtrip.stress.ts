/**
 * relational.inventory-csv-roundtrip.stress.ts — 2026-11-23
 *
 * End-to-end: Inventory → Export CSV → edit → Bulk Import → reload, through
 * the REAL running API and the REAL frontend helpers lifted from index.html
 * (sgrInventoryCsvExport, sgrParseInventoryCsv, importInventoryRowsRelational).
 * Proves: edited fields persist and are what both read paths (targeted
 * /api/relational/sections and a fresh login's GET /api/platform-state)
 * return; untouched fields and supplier links survive; zeros, decimals,
 * quoted commas and Unicode survive; re-importing the same file writes
 * nothing and creates no duplicates; ambiguous rows are rejected; a stale
 * row is reported, not hidden.
 *
 * SAFETY: writes. Refuses unless DATABASE_URL names a database ending in
 * `_test`. Only rows whose SKU starts with `INVC-` are created, and they are
 * deleted at the end.
 *   TEST_SERVER_URL_WITH_AUTHORITY=http://localhost:3999 DATABASE_URL=…/x_test \
 *   npx ts-node --transpile-only test/relational.inventory-csv-roundtrip.stress.ts
 */
const BASE = process.env.TEST_SERVER_URL_WITH_AUTHORITY;
if (!BASE) { console.log('[inventory-csv-roundtrip] SKIPPED — TEST_SERVER_URL_WITH_AUTHORITY not set.'); process.exit(0); }
if (!/\/[A-Za-z0-9_-]*_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  console.error('[inventory-csv-roundtrip] REFUSING TO RUN — DATABASE_URL must name a database ending in "_test". This test writes.');
  process.exit(1);
}
import pool from '../src/db/pool';
import fs from 'fs';
import path from 'path';

const HTML = fs.readFileSync(process.env.INDEX_HTML_PATH || path.resolve(__dirname, '..', '..', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
function liftBlock(): any {
  const a = HTML.indexOf('2026-11-23 INVENTORY CSV EXPORT / IMPORT (shared');
  const b = HTML.indexOf('// ── END 2026-11-23 INVENTORY CSV EXPORT / IMPORT block');
  if (a < 0 || b < 0) return null;
  return new Function(HTML.slice(HTML.lastIndexOf('/*', a), b) + '\nreturn { sgrInventoryCsvExport, sgrParseInventoryCsv, importInventoryRowsRelational };')(); // eslint-disable-line no-new-func
}
let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); } else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}
function section(t: string) { console.log('\n' + t); }
async function j(res: Response): Promise<any> { try { return await res.json(); } catch { return null; } }
async function login(): Promise<any> {
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: process.env.TEST_LOGIN_EMAIL || 'test@signacore.local', password: process.env.TEST_LOGIN_PASSWORD || 'testpass' }) });
  if (!res.ok) throw new Error('login failed: HTTP ' + res.status);
  return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ((await res.json()) as any).token };
}
function httpApi(H: any) {
  const call = async (method: string, p: string, body?: any) => {
    const res = await fetch(`${BASE}/api/relational${p}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
    const b: any = await j(res);
    if (!res.ok) { const e: any = new Error((b && b.error) || ('HTTP ' + res.status)); e.status = res.status; throw e; }
    return b;
  };
  const log: string[] = [];
  return {
    log,
    createInventoryItem: (d: any) => { log.push('create'); return call('POST', '/inventory', d); },
    updateInventoryItem: (id: any, v: number, p: any) => { log.push('update'); return call('PUT', '/inventory/' + id, { expectedVersion: v, ...p }); },
    deleteInventoryItem: (id: any, v: number) => { log.push('delete'); return call('DELETE', '/inventory/' + id, { expectedVersion: v }); },
  };
}
const mine = (inv: any[]) => inv.filter((i) => /^INVC-/i.test(String(i.sku || '')));
async function readTargeted(H: any): Promise<any[]> { const b = await j(await fetch(`${BASE}/api/relational/sections?names=inventory`, { headers: H })); return mine((b && b.data && b.data.inventory) || []); }
async function readFull(H: any): Promise<any[]> { const b = await j(await fetch(`${BASE}/api/platform-state`, { headers: H })); return mine((b && b.data && b.data.inventory) || []); }
const bySku = (l: any[], s: string) => l.filter((i) => i.sku === s && i.active !== false);

async function main() {
  const L = liftBlock();
  ok(!!L, 'the inventory CSV block exists in index.html');
  if (!L) return;
  const cut = await pool.query(`SELECT enabled FROM relational_cutover WHERE section = 'inventory'`).catch(() => ({ rows: [] as any[] }));
  const cutBefore = cut.rows.length ? cut.rows[0].enabled : null;
  await pool.query(`INSERT INTO relational_cutover (section, enabled) VALUES ('inventory', true) ON CONFLICT (section) DO UPDATE SET enabled = true`);
  await pool.query(`DELETE FROM rel_inventory_items WHERE sku ILIKE 'INVC-%'`);
  await pool.query(`INSERT INTO rel_suppliers (source_id, name) VALUES ('INVC-SUP', 'INVC Supplier'), ('INVC-SUP2', 'INVC Other') ON CONFLICT (source_id) DO NOTHING`);
  // The dashboard's supplier list (ids are the restored source_ids).
  const SUPS = [{ id: 'INVC-SUP', name: 'INVC Supplier' }, { id: 'INVC-SUP2', name: 'INVC Other' }];
  const H = await login();
  const api = httpApi(H);
  try {
    section('[1] seed through the API');
    const seed = [
      { sku: 'INVC-VIN', name: '3M Vinyl Red Gloss 1.37m', category: 'Vinyl', unit: 'm', stock: 25, reorder: 8, cost: 310, sell: 490, supplierId: 'INVC-SUP' },
      { sku: 'INVC-ALU', name: 'Aluminium return coil, 100mm "silver"', category: 'Aluminium Profiles', unit: 'm', stock: 12.5, reorder: 0, cost: 1250.75, sell: 1800, supplierId: null },
      { sku: 'INVC-ZERO', name: 'Café sign ² — zero', category: 'Café', unit: 'unit', stock: 0, reorder: 0, cost: 0, sell: 0, supplierId: null },
      { sku: 'INVC-DUP', name: 'Install A', category: 'Labour', unit: 'hr', stock: 1, reorder: 0, cost: 1, sell: 2, supplierId: null },
      { sku: 'INVC-DUP', name: 'Install B', category: 'Labour', unit: 'hr', stock: 1, reorder: 0, cost: 1, sell: 2, supplierId: null },
    ];
    for (const s of seed) await api.createInventoryItem(s);
    let cur = await readTargeted(H);
    ok(cur.length === 5, '5 INVC items exist', cur.length);

    section('[2] export → edit → import');
    const csv0 = L.sgrInventoryCsvExport(cur, SUPS);
    ok(/INVC-VIN,3M Vinyl Red Gloss 1\.37m,Vinyl,m,25,8,310,490,INVC Supplier,#\d+\r\n/.test(csv0), 'export carries the supplier NAME and a text "#id"', csv0.split('\r\n').find((l: string) => l.startsWith('INVC-VIN')));
    ok(csv0.split('\r\n').length === 7, 'header + 5 rows (+ trailing CRLF)');
    // Simulate an Excel round trip: BOM + edits, one blank cell, one zero, quoted comma kept.
    const lines = ('﻿' + csv0).split('\r\n');
    const edit = (sku: string, fn: (cells: string[]) => void) => {
      const i = lines.findIndex((l) => l.startsWith(sku + ','));
      const parts = lines[i].split(','); fn(parts); lines[i] = parts.join(',');
    };
    edit('INVC-VIN', (c) => { c[4] = '40'; c[7] = '520'; c[5] = ''; });   // stock 25→40, sell 490→520, reorder blank → keep 8
    edit('INVC-ZERO', (c) => { c[4] = '3.5'; });                          // decimal stock
    const csv1 = lines.join('\r\n').replace('Aluminium Profiles,m,12.5,0,', 'Aluminium Profiles,m,0,0,'); // ALU stock 12.5 → 0
    const r1 = await L.importInventoryRowsRelational(L.sgrParseInventoryCsv(csv1).records, 'add', cur, api, SUPS);
    ok(r1.report.updated.length === 3 && r1.report.unchanged.length === 2 && r1.report.created.length === 0 && r1.report.failed.length === 0 && r1.report.rejected.length === 0, 'report: 3 updated, 2 unchanged, 0 created/rejected/failed', r1.report);
    ok(api.log.filter((x) => x === 'update').length === 3 && !api.log.includes('delete'), 'exactly 3 writes; unchanged rows not written');

    section('[3] reload: targeted read and a FRESH login both show the saved values');
    const t = await readTargeted(H);
    const f = await readFull(await login());
    for (const [label, list] of [['targeted', t], ['fresh session', f]] as [string, any[]][]) {
      const v = bySku(list, 'INVC-VIN')[0]; const a = bySku(list, 'INVC-ALU')[0]; const z = bySku(list, 'INVC-ZERO')[0];
      ok(v && v.stock === 40 && v.sell === 520 && v.reorder === 8 && v.cost === 310 && v.unit === 'm' && v.cat === 'Vinyl' && String(v.supplierId) === 'INVC-SUP', label + ': VIN stock 40, sell 520, reorder kept 8, supplier kept', v);
      ok(a && a.stock === 0 && a.cost === 1250.75 && a.name === 'Aluminium return coil, 100mm "silver"', label + ': ALU stock 0 saved; decimal cost, comma + quotes in name intact', a);
      ok(z && z.stock === 3.5 && z.name === 'Café sign ² — zero' && z.cat === 'Café' && z.sell === 0, label + ': decimal stock 3.5, Unicode intact, zero sell kept', z);
    }

    section('[4] re-import the same file: nothing written, no duplicates');
    const api2 = httpApi(H);
    const r2 = await L.importInventoryRowsRelational(L.sgrParseInventoryCsv(csv1).records, 'add', t, api2, SUPS);
    ok(api2.log.length === 0 && r2.report.unchanged.length === 5, 'all 5 unchanged, zero API writes', r2.report);
    ok((await readTargeted(H)).length === 5, 'still exactly 5 INVC items');

    section('[5] the 22 Nov layout (no ID column), shared SKU, new item, stale version');
    const t2 = await readTargeted(H);
    const nov = 'SKU,Item name,Category,Unit,Stock on hand,Reorder level,Cost price (R),Sell price (R),Supplier,Notes\r\n' +
      'INVC-VIN,3M Vinyl Red Gloss 1.37m,Vinyl,m,41,8,310.00,520.00,INVC Supplier,\r\n' +
      'INVC-DUP,Install A,Labour,hr,9,0,1.00,2.00,,\r\n' +
      'INVC-NEW,"Brand new, item",New Cat,sheet,2,1,"1,000.50",1500,,\r\n';
    const r3 = await L.importInventoryRowsRelational(L.sgrParseInventoryCsv(nov).records, 'add', t2, httpApi(H), SUPS);
    ok(r3.report.updated.length === 1 && r3.report.created.length === 1 && r3.report.rejected.length === 1 && /share SKU/.test(r3.report.rejected[0].error), 'VIN updated, NEW created, shared SKU rejected', r3.report);
    const t3 = await readTargeted(H);
    ok(bySku(t3, 'INVC-VIN')[0].stock === 41 && bySku(t3, 'INVC-VIN')[0].reorder === 8 && bySku(t3, 'INVC-VIN')[0].unit === 'm', 'stock read from "Stock on hand" (41) — unit and reorder untouched');
    const nw = bySku(t3, 'INVC-NEW')[0];
    ok(nw && nw.name === 'Brand new, item' && nw.cost === 1000.5 && nw.cat === 'New Cat' && nw.unit === 'sheet', 'new item created with all its fields', nw);
    ok(bySku(t3, 'INVC-DUP').every((i: any) => i.stock === 1), 'neither shared-SKU item was touched');
    const r4 = await L.importInventoryRowsRelational(L.sgrParseInventoryCsv(nov).records, 'add', t3, httpApi(H), SUPS);
    ok(r4.report.created.length === 0 && r4.report.unchanged.length === 2 && (await readTargeted(H)).length === 6, 're-import of that file: no duplicate of INVC-NEW', r4.report);
    // Supplier by name: relink VIN to "INVC Other"; an unknown supplier is rejected.
    const t4 = await readTargeted(H);
    const rs = await L.importInventoryRowsRelational(L.sgrParseInventoryCsv('SKU,Supplier\r\nINVC-VIN,invc other\r\nINVC-ALU,Nobody Ltd\r\n').records, 'add', t4, httpApi(H), SUPS);
    ok(rs.report.updated.length === 1 && rs.report.rejected.length === 1 && rs.report.rejected[0].field === 'Supplier', 'supplier relinked by name; unknown supplier rejected', rs.report);
    const t5 = await readTargeted(H);
    ok(String(bySku(t5, 'INVC-VIN')[0].supplierId) === 'INVC-SUP2' && bySku(t5, 'INVC-VIN')[0].stock === 41 && bySku(t5, 'INVC-ALU')[0].supplierId == null, 'server stored the new supplier link only; stock and the rejected row untouched', [bySku(t5, 'INVC-VIN')[0].supplierId, bySku(t5, 'INVC-ALU')[0].supplierId]);
    // stale: someone edits VIN after this tab read it
    const vin = bySku(t5, 'INVC-VIN')[0];
    await api.updateInventoryItem(vin._relId, vin._relRowVersion, { name: 'edited elsewhere' });
    const r5 = await L.importInventoryRowsRelational(L.sgrParseInventoryCsv('SKU,Stock\r\nINVC-VIN,99').records, 'add', t5, httpApi(H), SUPS);
    ok(r5.report.failed.length === 1 && /changed|stale|modified/i.test(r5.report.failed[0].error) && !/✅/.test(r5.message), 'stale row: reported as NOT saved with the server message', r5.report.failed);
    ok(bySku(await readTargeted(H), 'INVC-VIN')[0].stock === 41, 'the stale import changed nothing');
  } finally {
    await pool.query(`DELETE FROM rel_inventory_items WHERE sku ILIKE 'INVC-%'`);
    await pool.query(`DELETE FROM rel_suppliers WHERE source_id IN ('INVC-SUP', 'INVC-SUP2')`).catch(() => undefined);
    if (cutBefore === null) await pool.query(`DELETE FROM relational_cutover WHERE section = 'inventory'`).catch(() => undefined);
    else await pool.query(`UPDATE relational_cutover SET enabled = $1 WHERE section = 'inventory'`, [cutBefore]);
  }
}
main().then(async () => { await pool.end(); console.log(`\n${passed} passed, ${failures} failed`); process.exit(failures ? 1 : 0); })
  .catch(async (e) => { console.error('FATAL', e); await pool.end().catch(() => undefined); process.exit(1); });
