/**
 * relational.inventory-persistence.stress.ts
 *
 * 2026-09-28 INVENTORY PERSISTENCE INVESTIGATION (backend / end-to-end half).
 * The frontend half is test/inventory-persistence.frontend.test.js.
 *
 * Drives the REAL running API (create/edit/delete through /api/relational/
 * inventory, reads through BOTH authoritative read paths — the full
 * GET /api/platform-state overlay and the targeted GET /api/relational/sections
 * the dashboard uses after every save) and the REAL platform-state PUT, and
 * proves that Inventory categories/items:
 *   - persist and come back WITH their category under `cat` (the field the
 *     dashboard reads) on every read path — the backend half of the root
 *     cause (read.ts mapItemRow emitted only `category`, so post-cutover items
 *     returned with no `cat` and an edited backfilled item returned its OLD
 *     legacy `cat`);
 *   - cannot be regressed by a stale row version, a racing duplicate update,
 *     or a stale full-state platform_state save (cut over or not);
 *   - are the same for Signacore and Holdings users (inventory is a single
 *     shared list — no company column — and a Holdings save cannot alter it);
 *   - surface failures (4xx) instead of pretending to persist.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────
 * WRITES to the database. Refuses to run unless DATABASE_URL names a database
 * whose name ends in `_test`. Only rows whose sku starts with `INVP-` (and one
 * supplier with source_id `INVP-SUP-LEGACY`) are created, and exactly those
 * rows are removed at the end. platform_state is snapshotted first and put
 * back afterwards. The relational_cutover rows are restored too.
 *
 *   TEST_SERVER_URL_WITH_AUTHORITY=http://localhost:3101 \
 *   DATABASE_URL=postgresql://.../signacore_test \
 *     npx ts-node --transpile-only test/relational.inventory-persistence.stress.ts
 * (the server must run with RELATIONAL_AUTHORITY_ENABLED=true against the same
 * `_test` database, and a login test@signacore.local / testpass must exist)
 */
const BASE = process.env.TEST_SERVER_URL_WITH_AUTHORITY;
if (!BASE) {
  console.log('[inventory-persistence] SKIPPED — TEST_SERVER_URL_WITH_AUTHORITY not set.');
  process.exit(0);
}
if (!/\/[A-Za-z0-9_-]*_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  console.error('[inventory-persistence] REFUSING TO RUN — DATABASE_URL must name a database ending in "_test". This test writes.');
  process.exit(1);
}

import pool from '../src/db/pool';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';

// ── lift REAL frontend helpers out of index.html (same approach as the
// zero-dependency frontend suite) so the shipped client code is exercised
// against this real server ──────────────────────────────────────────────
const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH || path.resolve(__dirname, '..', '..', 'index.html');
const HTML = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
function liftFrontend(name: string, env: Record<string, any>): any {
  const m = new RegExp('\\n[ \\t]*(async\\s+)?function\\s+' + name + '\\s*\\(').exec(HTML);
  if (!m) return null;
  const start = HTML.indexOf('function', m.index) - (/async\s+function/.test(m[0]) ? 6 : 0);
  // skip the parameter list, then brace-match the body (these helpers contain
  // no braces inside string literals that could confuse a plain counter)
  let i = HTML.indexOf('(', start), d = 0;
  for (; i < HTML.length; i++) { if (HTML[i] === '(') d++; else if (HTML[i] === ')') { d--; if (d === 0) break; } }
  let j = HTML.indexOf('{', i), b = 0;
  for (; j < HTML.length; j++) { if (HTML[j] === '{') b++; else if (HTML[j] === '}') { b--; if (b === 0) break; } }
  const src = HTML.slice(start, j + 1);
  return new Function('env', 'with (env) {\n' + src + '\nreturn ' + name + ';\n}')(env); // eslint-disable-line no-new-func
}
function httpApi(H: any) {
  const call = async (method: string, p: string, body?: any) => {
    const res = await fetch(`${BASE}/api/relational${p}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
    const b: any = await j(res);
    if (!res.ok) { const e: any = new Error((b && b.error) || ('HTTP ' + res.status)); e.status = res.status; e.body = b; throw e; }
    return b;
  };
  return {
    createInventoryItem: (d: any) => call('POST', '/inventory', d),
    updateInventoryItem: (id: any, v: number, p: any) => call('PUT', '/inventory/' + id, { expectedVersion: v, ...p }),
    adjustInventoryStock: (id: any, v: number, delta: number) => call('POST', '/inventory/' + id + '/adjust', { expectedVersion: v, delta }),
    deleteInventoryItem: (id: any, v: number) => call('DELETE', '/inventory/' + id, { expectedVersion: v }),
  };
}

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}
function section(t: string) { console.log('\n' + t); }

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed for ${email}: HTTP ${res.status}`);
  return ((await res.json()) as any).token;
}
function hdr(token: string) { return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }; }
async function j(res: Response): Promise<any> { try { return await res.json(); } catch { return null; } }

async function createItem(H: any, body: any) {
  const res = await fetch(`${BASE}/api/relational/inventory`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  return { status: res.status, body: await j(res) };
}
async function updateItem(H: any, id: any, expectedVersion: number, patch: any) {
  const res = await fetch(`${BASE}/api/relational/inventory/${id}`, { method: 'PUT', headers: H, body: JSON.stringify({ expectedVersion, ...patch }) });
  return { status: res.status, body: await j(res) };
}
async function deleteItem(H: any, id: any, expectedVersion: number) {
  const res = await fetch(`${BASE}/api/relational/inventory/${id}`, { method: 'DELETE', headers: H, body: JSON.stringify({ expectedVersion }) });
  return { status: res.status, body: await j(res) };
}
async function readFull(H: any) {
  const body = await j(await fetch(`${BASE}/api/platform-state`, { headers: H }));
  return { inv: ((body && body.data && body.data.inventory) || []) as any[], body };
}
async function readTargeted(H: any) {
  const body = await j(await fetch(`${BASE}/api/relational/sections?names=inventory`, { headers: H }));
  return ((body && body.data && body.data.inventory) || []) as any[];
}
async function tokens(H: any) { return j(await fetch(`${BASE}/api/freshness`, { headers: H })); }
const mine = (list: any[]) => list.filter((i) => typeof i.sku === 'string' && i.sku.toUpperCase().startsWith('INVP-'));
const bySku = (list: any[], sku: string) => list.find((i) => String(i.sku).toUpperCase() === sku.toUpperCase());

async function main() {
  // ── snapshot everything this test may touch, so it can be put back ──
  const psBefore = await pool.query('SELECT data FROM platform_state WHERE id = 1');
  const cutBefore = await pool.query('SELECT section, enabled FROM relational_cutover');

  // A Holdings (co 1) login next to the default Signacore test login.
  const hHash = bcrypt.hashSync('holdpass', 8);
  await pool.query(
    `INSERT INTO app_users (account_id, email, password_hash, role, co, name)
     VALUES ('invp-holdings', 'invp-holdings@signacore.local', $1, 'admin', 1, 'INVP Holdings')
     ON CONFLICT (email) DO NOTHING`, [hHash]);

  const tokenA = await login(process.env.TEST_LOGIN_EMAIL || 'test@signacore.local', process.env.TEST_LOGIN_PASSWORD || 'testpass');
  const H = hdr(tokenA);
  const tokenHoldings = await login('invp-holdings@signacore.local', 'holdpass');
  const HH = hdr(tokenHoldings);

  await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section = 'inventory'`);

  try {
    // A backfilled supplier (source_id = the legacy JSON id the dashboard holds)
    const sup = await pool.query(
      `INSERT INTO rel_suppliers (source_id, name, legacy_data) VALUES ('INVP-SUP-LEGACY', 'INVP Supplier', '{}'::jsonb)
       ON CONFLICT DO NOTHING RETURNING id`);
    const supRow = sup.rowCount ? sup.rows[0] : (await pool.query(`SELECT id FROM rel_suppliers WHERE source_id='INVP-SUP-LEGACY'`)).rows[0];

    // ════════════════════════════════════════════════════════════════
    section('[1] create a NEW category (first item carries it) → full reload AND post-save refresh both show it');
    const tok0 = await tokens(H);
    const c1 = await createItem(H, { sku: 'INVP-SB-1', name: 'INVP ACM 3mm', category: 'INVP Signage Boards', unit: 'sheet', cost: 400, sell: 650, stock: 0, reorder: 2, supplierId: 'INVP-SUP-LEGACY' });
    ok(c1.status === 201 && c1.body && c1.body.id != null, 'create is acknowledged by the server (201 + id + rowVersion)', c1);
    const full1 = await readFull(H);
    const tgt1 = await readTargeted(H);
    const f1 = bySku(full1.inv, 'INVP-SB-1'), t1 = bySku(tgt1, 'INVP-SB-1');
    ok(!!f1 && f1.cat === 'INVP Signage Boards', 'full GET /api/platform-state: item present with cat = the new category', f1 && { cat: f1.cat, category: f1.category });
    ok(!!t1 && t1.cat === 'INVP Signage Boards', 'targeted GET /api/relational/sections: item present with cat = the new category (was missing before the fix)', t1 && { cat: t1.cat, category: t1.category });
    ok(!!f1 && f1.category === f1.cat, 'cat and category always agree');
    ok(JSON.stringify(f1) === JSON.stringify(t1), 'both read paths return the identical record');
    ok(Array.isArray(full1.body.relationalAuthoritativeSections) && full1.body.relationalAuthoritativeSections.includes('inventory'), 'the GET declares inventory relational-authoritative');
    const tok1 = await tokens(H);
    ok(tok0 && tok1 && JSON.stringify(tok0.sections && tok0.sections.inventory) !== JSON.stringify(tok1.sections && tok1.sections.inventory), 'the inventory freshness token moved, so other sessions refetch it');

    // ════════════════════════════════════════════════════════════════
    section('[2] create several items in that category quickly (parallel) → all persist, distinct ids, all linked by category');
    const batch = await Promise.all([2, 3, 4, 5, 6].map((n) => createItem(H, { sku: `INVP-SB-${n}`, name: `INVP board ${n}`, category: 'INVP Signage Boards', unit: 'sheet', cost: n, sell: n * 2, stock: n, reorder: 1 })));
    ok(batch.every((r) => r.status === 201), 'all 5 concurrent creates acknowledged', batch.map((r) => r.status));
    ok(new Set(batch.map((r) => String(r.body.id))).size === 5, 'five distinct ids');
    const after2 = mine(await readTargeted(H));
    const inCat = after2.filter((i) => i.cat === 'INVP Signage Boards' && i.active !== false);
    ok(inCat.length === 6, 'the new category now holds all 6 items after a reload', inCat.map((i) => i.sku));
    const idOnReload = bySku(after2, 'INVP-SB-1');
    ok(idOnReload && String(idOnReload.id) === String(c1.body.id) && String(idOnReload._relId) === String(c1.body.id), 'the id the create returned is the id the item has after reload (no temporary id to re-link)', idOnReload && { id: idOnReload.id, relId: idOnReload._relId, created: c1.body.id });

    // ════════════════════════════════════════════════════════════════
    section('[3] categories are item-derived (there is no standalone category entity)');
    const catsNow = [...new Set(mine(await readTargeted(H)).filter((i) => i.active !== false).map((i) => i.cat))];
    ok(catsNow.includes('INVP Signage Boards'), 'category list rebuilt from items includes the new category', catsNow);

    // ════════════════════════════════════════════════════════════════
    section('[4] supplier reference persists');
    ok(f1 && String(f1.supplierId) === 'INVP-SUP-LEGACY', 'supplierId comes back as the id the dashboard holds', f1 && f1.supplierId);
    const supDb = await pool.query('SELECT supplier_id, supplier_source_id FROM rel_inventory_items WHERE id = $1', [c1.body.id]);
    ok(String(supDb.rows[0].supplier_id) === String(supRow.id) && supDb.rows[0].supplier_source_id === 'INVP-SUP-LEGACY', 'FK and source id both stored', supDb.rows[0]);

    // ════════════════════════════════════════════════════════════════
    section('[5] edit an item (price) and edit a category → both persist across reload');
    const e1 = await updateItem(H, c1.body.id, c1.body.rowVersion, { sell: 700 });
    ok(e1.status === 200, 'price edit acknowledged', e1);
    const it2 = batch[0].body;
    const e2 = await updateItem(H, it2.id, it2.rowVersion, { category: 'INVP Signage Boards XL' });
    ok(e2.status === 200, 'category edit acknowledged', e2);
    const after5 = mine(await readTargeted(H));
    ok(bySku(after5, 'INVP-SB-1').sell === 700 && bySku(after5, 'INVP-SB-1').cat === 'INVP Signage Boards', 'price edit persisted; category untouched');
    ok(bySku(after5, 'INVP-SB-1').supplierId != null && String(bySku(after5, 'INVP-SB-1').supplierId) === 'INVP-SUP-LEGACY', 'unrelated edit did not unlink the supplier');
    ok(bySku(after5, 'INVP-SB-2').cat === 'INVP Signage Boards XL', 'edited category shows on reload', bySku(after5, 'INVP-SB-2').cat);

    // ════════════════════════════════════════════════════════════════
    section('[6] backward compatibility — a BACKFILLED row (legacy_data.cat) keeps its category, and an edit to it wins over the frozen legacy value');
    const legacy = await pool.query(
      `INSERT INTO rel_inventory_items (source_id, sku, name, category, unit, cost, sell, stock_qty, reorder_level, legacy_data)
       VALUES ('9876543210001', 'INVP-LEGACY-1', 'INVP legacy vinyl', 'Vinyl', 'm', 1, 2, 3, 1, $1::jsonb) RETURNING id, row_version`,
      [JSON.stringify({ id: 9876543210001, sku: 'INVP-LEGACY-1', name: 'INVP legacy vinyl', cat: 'Vinyl', stock: 3, reorder: 1, unit: 'm', cost: 1, sell: 2 })]);
    const legNull = await pool.query(
      `INSERT INTO rel_inventory_items (source_id, sku, name, category, legacy_data)
       VALUES ('9876543210002', 'INVP-LEGACY-2', 'INVP legacy no column', NULL, $1::jsonb) RETURNING id`,
      [JSON.stringify({ id: 9876543210002, sku: 'INVP-LEGACY-2', name: 'INVP legacy no column', cat: 'Laminate' })]);
    let l = bySku(await readTargeted(H), 'INVP-LEGACY-1');
    ok(l && l.cat === 'Vinyl' && l.id === 9876543210001, 'backfilled row reads unchanged (legacy id + category)', l && { id: l.id, cat: l.cat });
    ok(bySku(await readTargeted(H), 'INVP-LEGACY-2').cat === 'Laminate', 'a legacy row with no category column still shows its legacy cat');
    const e6 = await updateItem(H, legacy.rows[0].id, legacy.rows[0].row_version, { category: 'INVP Laminate' });
    ok(e6.status === 200, 'category edit on the backfilled row acknowledged');
    l = bySku(await readTargeted(H), 'INVP-LEGACY-1');
    ok(l.cat === 'INVP Laminate' && l.category === 'INVP Laminate', 'reload shows the EDITED category — not the frozen legacy "Vinyl" (which the next edit used to write back)', { cat: l.cat, category: l.category });
    const legacyJson = await pool.query('SELECT legacy_data FROM rel_inventory_items WHERE id = $1', [legacy.rows[0].id]);
    ok(legacyJson.rows[0].legacy_data.cat === 'Vinyl', 'legacy_data itself is never rewritten (history preserved)');

    // ════════════════════════════════════════════════════════════════
    section('[7] stale version cannot overwrite newer data; two racing updates cannot both win');
    const cur = bySku(await readTargeted(H), 'INVP-SB-3');
    const stale = await updateItem(H, cur._relId, cur._relRowVersion - 1 || 0, { name: 'STALE WRITE' });
    ok(stale.status === 409 && stale.body && stale.body.type === 'stale_record', 'stale expectedVersion → 409 stale_record', stale);
    const race = await Promise.all([
      updateItem(H, cur._relId, cur._relRowVersion, { stock: 111 }),
      updateItem(H, cur._relId, cur._relRowVersion, { stock: 222 }),
    ]);
    const wins = race.filter((r) => r.status === 200).length, losses = race.filter((r) => r.status === 409).length;
    ok(wins === 1 && losses === 1, 'exactly one of two same-version updates wins; the other is refused 409', race.map((r) => r.status));
    const afterRace = bySku(await readTargeted(H), 'INVP-SB-3');
    ok(afterRace.name !== 'STALE WRITE' && (afterRace.stock === 111 || afterRace.stock === 222), 'the stored row is the winning write, never the stale one', { name: afterRace.name, stock: afterRace.stock });
    ok(afterRace.cat === 'INVP Signage Boards', 'category unaffected by the race');

    // ════════════════════════════════════════════════════════════════
    section('[8] deleting one item affects only that item; the category and its other items survive');
    const d4 = bySku(await readTargeted(H), 'INVP-SB-4');
    const del = await deleteItem(H, d4._relId, d4._relRowVersion);
    ok(del.status === 200, 'soft delete acknowledged', del);
    const after8 = mine(await readTargeted(H));
    ok(bySku(after8, 'INVP-SB-4').active === false, 'deleted item is inactive (row preserved)');
    ok(after8.filter((i) => i.active !== false && i.cat === 'INVP Signage Boards').length === 4, 'the other items of the category are all still active', after8.filter((i) => i.active !== false).map((i) => i.sku));
    ok(bySku(after8, 'INVP-SB-2').active !== false && bySku(after8, 'INVP-LEGACY-1').active !== false, 'items in other categories untouched');

    // ════════════════════════════════════════════════════════════════
    section('[9] failures are surfaced, never persisted as success');
    const bad1 = await createItem(H, { sku: 'INVP-BAD-1', name: 'INVP bad supplier', category: 'INVP Signage Boards', supplierId: 'NO-SUCH-SUPPLIER' });
    ok(bad1.status === 409 && bad1.body.type === 'business_rule', 'unknown supplier → 409 business_rule (message shown to the user)', bad1);
    const bad2 = await createItem(H, { sku: 'INVP-BAD-2', category: 'INVP Signage Boards' });
    ok(bad2.status === 400, 'missing name → 400', bad2);
    const badRows = await pool.query(`SELECT count(*)::int AS n FROM rel_inventory_items WHERE sku LIKE 'INVP-BAD-%'`);
    ok(badRows.rows[0].n === 0, 'nothing was written for either refused create');

    // ════════════════════════════════════════════════════════════════
    section('[10] a STALE full-state platform_state save (old tab / old snapshot) cannot overwrite or remove relational inventory');
    const before10 = JSON.stringify(mine(await readTargeted(H)));
    const staleSnapshot = { v: 4, inventory: [{ id: 1, sku: 'VIN-3M-WG', name: 'seed demo item', cat: 'Vinyl', stock: 45 }], _deletedIds: { inventory: [String(c1.body.id), c1.body.id] } };
    const put10 = await fetch(`${BASE}/api/platform-state`, { method: 'PUT', headers: H, body: JSON.stringify({ data: { ...staleSnapshot, _partial: true } }) });
    const put10b = await j(put10);
    ok(put10.status === 409 && put10b && put10b.type === 'relational_authoritative' && (put10b.sections || []).includes('inventory'), 'an inventory-only stale save is REFUSED (409 relational_authoritative) — never a 200 for a write that did not happen', put10b);
    const put10m = await fetch(`${BASE}/api/platform-state`, { method: 'PUT', headers: H, body: JSON.stringify({ data: { ...staleSnapshot, savedCalcs: [], _partial: true } }) });
    const put10mb = await j(put10m);
    ok(put10m.status === 200 && Array.isArray(put10mb.relationalAuthoritativeSectionsIgnored) && put10mb.relationalAuthoritativeSectionsIgnored.includes('inventory'), 'a mixed stale save still saves its JSON section and REPORTS the ignored inventory', put10mb && put10mb.relationalAuthoritativeSectionsIgnored);
    ok(JSON.stringify(mine(await readTargeted(H))) === before10, 'relational inventory is byte-for-byte unchanged (no seed/demo overwrite, no deletion)');

    // ════════════════════════════════════════════════════════════════
    section('[11] company scoping — Signacore and Holdings see the same single inventory; a Holdings save cannot alter it');
    const invA = JSON.stringify(mine(await readTargeted(H)));
    const invH = JSON.stringify(mine(await readTargeted(HH)));
    ok(invA === invH, 'identical inventory for a co 2 and a co 1 user (inventory has no company column by design)');
    const putH = await fetch(`${BASE}/api/platform-state`, { method: 'PUT', headers: HH, body: JSON.stringify({ data: { v: 4, _partial: true, inventory: [], savedCalcs: [] } }) });
    ok(putH.status === 200, 'a Holdings partial save is accepted');
    ok(JSON.stringify(mine(await readTargeted(H))) === invA, 'and it did not change inventory for anyone');

    // ════════════════════════════════════════════════════════════════
    section('[12] logout/login: a brand-new session reconstructs the same inventory');
    const tokenA2 = await login(process.env.TEST_LOGIN_EMAIL || 'test@signacore.local', process.env.TEST_LOGIN_PASSWORD || 'testpass');
    const again = mine((await readFull(hdr(tokenA2))).inv);
    ok(JSON.stringify(again) === invA, 'fresh login → identical inventory, new category included', again.map((i) => `${i.sku}:${i.cat}`));

    // ════════════════════════════════════════════════════════════════
    section('[13] JSON mode (inventory NOT cut over): stale saves cannot remove a newer item');
    await pool.query(`UPDATE relational_cutover SET enabled = false WHERE section = 'inventory'`);
    const g0 = await j(await fetch(`${BASE}/api/platform-state`, { headers: H }));
    const baseInv = ((g0.data && g0.data.inventory) || []).filter((i: any) => !(typeof i.sku === 'string' && i.sku.startsWith('INVP-J')));
    const s1 = await fetch(`${BASE}/api/platform-state`, { method: 'PUT', headers: H, body: JSON.stringify({ data: { v: 4, _partial: true, inventory: [...baseInv, { id: 7770001, sku: 'INVP-J-1', name: 'json item 1', cat: 'INVP JSON Cat' }], _baseRevision: g0.updated_at } }) });
    ok(s1.status === 200, 'session A saves a new category+item (JSON mode)');
    const revAfterA = (await j(await fetch(`${BASE}/api/platform-state`, { headers: H }))).updated_at;
    // Session B still holds the OLD snapshot (without INVP-J-1) and autosaves an unrelated edit to it.
    const s2 = await fetch(`${BASE}/api/platform-state`, { method: 'PUT', headers: H, body: JSON.stringify({ data: { v: 4, _partial: true, inventory: [...baseInv, { id: 7770002, sku: 'INVP-J-2', name: 'json item 2', cat: 'INVP JSON Cat' }], _baseRevision: g0.updated_at } }) });
    ok(s2.status === 200, 'session B\'s stale save (no deletion) is accepted');
    const g2 = await j(await fetch(`${BASE}/api/platform-state`, { headers: H }));
    const jsonInv = (g2.data.inventory || []) as any[];
    ok(!!bySku(jsonInv, 'INVP-J-1') && !!bySku(jsonInv, 'INVP-J-2'), 'both items survive — omission from a stale snapshot never deletes', jsonInv.filter((i) => String(i.sku).startsWith('INVP-J')).map((i) => i.sku));
    const s3 = await fetch(`${BASE}/api/platform-state`, { method: 'PUT', headers: H, body: JSON.stringify({ data: { v: 4, _partial: true, inventory: baseInv, _deletedIds: { inventory: [7770001] }, _baseRevision: g0.updated_at } }) });
    const s3b = await j(s3);
    ok(s3.status === 409 && s3b && s3b.conflict, 'a stale save that tries to DELETE the newer item is refused 409 (stale revision)', { status: s3.status, type: s3b && s3b.type });
    const g3 = await j(await fetch(`${BASE}/api/platform-state`, { headers: H }));
    ok(!!bySku(g3.data.inventory, 'INVP-J-1'), 'the newer item is still there');
    ok(revAfterA !== g0.updated_at, '[sanity] session A really did advance the revision');

    // ════════════════════════════════════════════════════════════════
    // FINAL HARDENING — every relational Inventory write path
    // ════════════════════════════════════════════════════════════════
    await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section = 'inventory'`);
    const psSnap = await pool.query(`SELECT data->'inventory' AS inv FROM platform_state WHERE id = 1`);
    const psInvBefore = JSON.stringify(psSnap.rowCount ? psSnap.rows[0].inv : null);
    const api = httpApi(H);

    section('[14] Quote → Job, fully relational: stock is deducted INSIDE the conversion transaction; concurrent conversions cannot regress quantity');
    await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section IN ('quotes','jobs')`);
    const stockItem = (await createItem(H, { sku: 'INVP-DED-1', name: 'INVP deduct me', category: 'INVP Deduct Cat', unit: 'sheet', cost: 5, sell: 9, stock: 50, reorder: 2, supplierId: 'INVP-SUP-LEGACY' })).body;
    const bystander = (await createItem(H, { sku: 'INVP-DED-2', name: 'INVP bystander', category: 'INVP Other', stock: 8, reorder: 1 })).body;
    const bystanderBefore = JSON.stringify(bySku(await readTargeted(H), 'INVP-DED-2'));
    const mkQuote = async (qty: number) => (await j(await fetch(`${BASE}/api/relational/quotes`, { method: 'POST', headers: H, body: JSON.stringify({ companyCode: '2', customerNameRaw: 'INVP Deduction Co', lines: [{ description: 'boards', qty, unitPrice: 10, inventoryItemId: Number(stockItem.id) }, { description: 'labour', qty: 1, unitPrice: 100 }] }) })));
    const qa = await mkQuote(3), qb = await mkQuote(4);
    ok(qa && qa.id && qb && qb.id, 'two relational quotes referencing the same stock item', { qa, qb });
    const convs = await Promise.all([qa, qb].map(async (q: any) => { const r = await fetch(`${BASE}/api/relational/quotes/${q.id}/convert-to-job`, { method: 'POST', headers: H }); return { status: r.status, body: await j(r) }; }));
    ok(convs.every((c) => c.status === 201), 'both conversions succeed (concurrently)', convs.map((c) => c.status));
    let ded = bySku(await readTargeted(H), 'INVP-DED-1');
    ok(ded.stock === 43, 'stock 50 − 3 − 4 = 43: both deductions applied, none lost (row lock inside each conversion transaction)', ded.stock);
    ok(ded.cat === 'INVP Deduct Cat' && String(ded.supplierId) === 'INVP-SUP-LEGACY', 'category and supplier survive the deduction', { cat: ded.cat, sup: ded.supplierId });
    ok(ded._relRowVersion === stockItem.rowVersion + 2, 'row_version advanced once per deduction — an editor holding the old version now gets 409', ded._relRowVersion);
    ok(JSON.stringify(bySku(await readTargeted(H), 'INVP-DED-2')) === bystanderBefore, 'the unrelated item is byte-for-byte unchanged');
    const staleEdit = await updateItem(H, stockItem.id, stockItem.rowVersion, { stock: 50 });
    ok(staleEdit.status === 409, 'an editor still holding the pre-deduction version cannot write the old quantity back (409)', staleEdit.status);
    ok(bySku(await readTargeted(H), 'INVP-DED-1').stock === 43, 'quantity still 43');
    await pool.query(`UPDATE relational_cutover SET enabled = false WHERE section IN ('quotes','jobs')`);

    section('[15] Quote → Job with jobs/quotes still JSON: the REAL frontend deduction helper against this server');
    const compute = liftFrontend('computeStockConsumption', { String, parseInt, parseFloat, Map, Array });
    const deduct = liftFrontend('deductInventoryRelational', {});
    ok(!!compute && !!deduct, 'deduction helpers exist in index.html');
    if (compute && deduct) {
      let cur = bySku(await readTargeted(H), 'INVP-DED-1');
      const res1 = await deduct(compute([{ itemId: cur.id, qty: 2 }, { itemId: String(cur.id), qty: 1 }, { desc: 'labour', qty: 1 }], [cur, bySku(await readTargeted(H), 'INVP-DED-2')]), api);
      ok(res1.applied.length === 1 && res1.failed.length === 0 && res1.applied[0].newStock === 40, 'one version-checked adjust of −3 → 40 (server-acknowledged)', res1);
      const stale = await deduct([{ item: cur, qty: 5 }], api); // `cur` still holds the pre-deduction version
      ok(stale.applied.length === 0 && stale.failed.length === 1 && stale.failed[0].status === 409, 'a stale deduction is refused 409 and reported, not retried', stale.failed);
      ok(bySku(await readTargeted(H), 'INVP-DED-1').stock === 40, 'the refused stale deduction changed nothing');
      cur = bySku(await readTargeted(H), 'INVP-DED-1');
      const race = await Promise.all([deduct([{ item: cur, qty: 1 }], api), deduct([{ item: cur, qty: 6 }], api)]);
      const appliedQty = race.flatMap((r: any) => r.applied.map((a: any) => a.qty));
      const failedN = race.reduce((n: number, r: any) => n + r.failed.length, 0);
      const finalStock = bySku(await readTargeted(H), 'INVP-DED-1').stock;
      ok(appliedQty.length === 1 && failedN === 1, 'two concurrent deductions on the same version: exactly one applies, the other is refused', { appliedQty, failedN });
      ok(finalStock === 40 - appliedQty[0], 'final quantity reflects exactly the applied deduction — never regressed, never double-applied', finalStock);
      ok(JSON.stringify(bySku(await readTargeted(H), 'INVP-DED-2')) === bystanderBefore, 'the unrelated item is still unchanged');
      const noId = await deduct([{ item: { id: 1, sku: 'x' }, qty: 1 }], api);
      ok(noId.failed.length === 1 && noId.applied.length === 0, 'an item with no server id is reported, never written anywhere');
    }

    section('[16] Bulk Import through the relational API (the REAL frontend importer against this server)');
    const importer = liftFrontend('importInventoryRowsRelational', { String, Array, Map, Set });
    ok(!!importer, 'importInventoryRowsRelational exists in index.html');
    if (importer) {
      const deactivated = (await createItem(H, { sku: 'INVP-IMP-OLD', name: 'INVP old', category: 'INVP Old', stock: 1 })).body;
      await deleteItem(H, deactivated.id, deactivated.rowVersion);
      const before16 = mine(await readTargeted(H));
      const rows = [
        { sku: 'INVP-IMP-1', name: 'INVP imported 1', cat: 'INVP Imported Cat', stock: 4, reorder: 1, unit: 'm', cost: 2, sell: 3 },
        { sku: 'INVP-IMP-2', name: 'INVP imported 2', cat: 'INVP Imported Cat', stock: 5, reorder: 1, unit: 'm', cost: 2, sell: 3 },
        { sku: 'invp-ded-1', name: 'INVP deduct me (renamed)', cat: 'INVP Deduct Cat', stock: 77, reorder: 2, unit: 'sheet', cost: 5, sell: 9 },
        { sku: 'INVP-IMP-OLD', name: 'INVP old (back)', cat: 'INVP Old', stock: 2, reorder: 1, unit: 'u', cost: 1, sell: 1 },
      ];
      const r = await importer(rows, 'add', before16, api);
      ok(r.report.failed.length === 0 && r.report.created.length === 2 && r.report.updated.length === 1 && r.report.restored.length === 1, 'report: 2 created, 1 updated, 1 restored, 0 failed', r.report);
      const reread = mine(await readTargeted(H));
      ok(['INVP-IMP-1', 'INVP-IMP-2'].every((sku) => bySku(reread, sku) && bySku(reread, sku).cat === 'INVP Imported Cat'), 'imported items and their NEW category survive a reload');
      const upd = bySku(reread, 'INVP-DED-1');
      ok(upd.stock === 77 && upd.name === 'INVP deduct me (renamed)' && String(upd.supplierId) === 'INVP-SUP-LEGACY', 'the SKU match updated the existing item and kept its supplier link', { stock: upd.stock, sup: upd.supplierId });
      ok(bySku(reread, 'INVP-IMP-OLD').active === true, 'the removed item listed in the file is restored (visible), not saved-but-hidden');
      const fresh = mine((await readFull(hdr(await login(process.env.TEST_LOGIN_EMAIL || 'test@signacore.local', process.env.TEST_LOGIN_PASSWORD || 'testpass')))).inv);
      ok(JSON.stringify(fresh.filter((i) => /INVP-IMP/.test(i.sku)).map((i) => [i.sku, i.cat, i.active])) === JSON.stringify(reread.filter((i) => /INVP-IMP/.test(i.sku)).map((i) => [i.sku, i.cat, i.active])), 'a brand-new login sees the same imported items');

      // failure reporting + replace safety
      const before16b = mine(await readTargeted(H));
      const bad = await importer([{ sku: 'INVP-IMP-3', name: 'INVP imported 3', cat: 'X', stock: 1 }, { sku: 'INVP-IMP-BAD', name: '', cat: 'X', stock: 1 }], 'replace', before16b, api);
      ok(bad.report.failed.length === 1 && bad.report.failed[0].sku === 'INVP-IMP-BAD', 'the failing row is reported by SKU', bad.report.failed);
      ok(bad.report.removalsSkipped === true && bad.report.removed.length === 0, 'replace mode removed NOTHING because a row failed');
      ok(!/✅/.test(bad.message) && /NOT saved/.test(bad.message), 'no success message on a partial failure', bad.message);
      const after16b = mine(await readTargeted(H));
      ok(after16b.filter((i) => i.active !== false).length === before16b.filter((i) => i.active !== false).length + 1, 'only the one good row was added; every existing item is still active');
    }

    section('[17] relational mode performed NO Inventory write through platform_state');
    const psSnap2 = await pool.query(`SELECT data->'inventory' AS inv FROM platform_state WHERE id = 1`);
    ok(JSON.stringify(psSnap2.rowCount ? psSnap2.rows[0].inv : null) === psInvBefore, 'platform_state.data.inventory is byte-for-byte unchanged across create/edit/delete/deduct/import');

    section('[18] served Inventory depends only on persisted server data (restart-independent)');
    const read = await import('../src/relational/read');
    const fromDb = mine(await read.buildInventoryJson());
    ok(JSON.stringify(fromDb) === JSON.stringify(mine(await readTargeted(H))), 'what the API serves is exactly what the database rebuilds — no process/browser state involved');

    section('[19] temporary relational read failure: the server says so explicitly and never serves the frozen copy as authoritative');
    await pool.query(`ALTER TABLE rel_inventory_items RENAME TO rel_inventory_items_invp_tmp`);
    let failBody: any = null, secStatus = 0;
    try {
      failBody = (await readFull(H)).body;
      secStatus = (await fetch(`${BASE}/api/relational/sections?names=inventory`, { headers: H })).status;
    } finally {
      await pool.query(`ALTER TABLE rel_inventory_items_invp_tmp RENAME TO rel_inventory_items`);
    }
    ok(failBody && Array.isArray(failBody.relationalReadFailedSections) && failBody.relationalReadFailedSections.includes('inventory'), 'GET /api/platform-state reports relationalReadFailedSections: ["inventory"]', failBody && failBody.relationalReadFailedSections);
    ok(!(failBody.relationalAuthoritativeSections || []).includes('inventory'), 'and does not label the frozen copy authoritative');
    ok(secStatus === 500, 'the targeted read fails loudly (500), never serving JSON', secStatus);
    ok(JSON.stringify(mine(await readTargeted(H))) === JSON.stringify(fromDb), 'after recovery the full relational inventory is served again, unchanged');

    // ════════════════════════════════════════════════════════════════
    // MID-SESSION CUTOVER — a tab opened while Inventory was JSON
    // ════════════════════════════════════════════════════════════════
    section('[20] Inventory switched to relational while a JSON-era tab is open: the REAL frontend gate + save path against this server');
    await pool.query(`UPDATE relational_cutover SET enabled = false WHERE section = 'inventory'`);
    const tabAlerts: string[] = [];
    let tabRefreshes = 0;
    const realFreshness = async () => { const r = await fetch(`${BASE}/api/freshness`, { headers: H }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
    const tab: Record<string, any> = {
      relationalAuthoritativeSectionsRef: { current: [] },  // the tab believes: JSON
      relationalCutOverSeenRef: { current: [] },
      serverBaselineRef: { current: null },
      fetchFreshnessTokens: realFreshness,
      requestRelationalRefresh: () => { tabRefreshes++; },
      alert: (m: string) => { tabAlerts.push(String(m)); },
      console: { log() {}, warn() {}, debug() {}, error() {} },
      String, Array, Object, Set, Map, Number, JSON, Error, Promise,
    };
    for (const n of ['isRelationalAuthoritative', 'adoptRelationalAuthority', 'reportIgnoredRelationalWrite', 'withItemCat', 'normaliseItemCatSections']) {
      const f = liftFrontend(n, tab); if (f) tab[n] = f;
    }
    const gate = liftFrontend('confirmInventoryWriteMode', tab);
    ok(!!gate, 'confirmInventoryWriteMode exists in index.html');
    if (gate) {
      ok(await gate({ existing: false }) === 'json', 'before the cutover the server confirms JSON');
      await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section = 'inventory'`);   // ← cutover while the tab is open
      const countBefore = (await pool.query(`SELECT count(*)::int n FROM rel_inventory_items`)).rows[0].n;
      ok(await gate({ existing: true }) === null, 'EDIT / DELETE / IMPORT right after the cutover: stopped before anything changes');
      ok((await pool.query(`SELECT count(*)::int n FROM rel_inventory_items`)).rows[0].n === countBefore, 'nothing was written');
      ok(tab.isRelationalAuthoritative('inventory') === true && tabRefreshes >= 1, 'the tab adopted relational authority at once and asked for a refresh');
      // CREATE through the REAL saveItem__impl, now routed relationally
      let tabInventory: any[] = [];
      let closed = false;
      const pageEnv = Object.assign(Object.create(null), tab, {
        inventory: tabInventory,
        setInventory: (u: any) => { tabInventory = typeof u === 'function' ? u(tabInventory) : u; },
        setShowAddItem: () => { closed = true; }, setEditItem: () => {},
        confirmInventoryWriteMode: gate,
        relationalApi: api,
        syncRelationalBaseline: () => {},
        describeSaveConflictError: (e: any) => String(e && e.message),
      });
      const saveItemImpl = liftFrontend('saveItem__impl', pageEnv);
      await saveItemImpl({ id: 123456, sku: 'INVP-MID-1', name: 'INVP created right after cutover', cat: 'INVP Midsession Cat', category: 'INVP Midsession Cat', stock: 3, reorder: 1, unit: 'u', cost: 1, sell: 2, supplierId: null });
      const persisted = bySku(await readTargeted(H), 'INVP-MID-1');
      ok(!!persisted && persisted.cat === 'INVP Midsession Cat', 'the item created right after the cutover PERSISTED relationally, with its category', persisted && { cat: persisted.cat });
      ok(closed && tabInventory.some((i) => String(i._relId) === String(persisted && persisted._relId)), 'the form closed only after the server acknowledged it');
      tab.fetchFreshnessTokens = async () => ({ cutOver: [] });   // a later answer omitting inventory
      ok(await gate({ existing: true }) === 'relational', 'sticky: a later answer can never downgrade the tab to JSON');
    }

    section('[21] a stale JSON Inventory write through the REAL saveToServer never reads as success');
    const psRow = async () => (await pool.query('SELECT updated_at, data FROM platform_state WHERE id = 1')).rows[0];
    const staleTab: Record<string, any> = Object.assign({}, tab, {
      relationalAuthoritativeSectionsRef: { current: [] }, relationalCutOverSeenRef: { current: [] },
      API_STATE_URL: `${BASE}/api/platform-state`, authHeaders: () => ({ Authorization: H.Authorization }),
      forceLogoutExpiredSession: () => { throw new Error('unexpected logout'); }, fetch,
    });
    for (const n of ['isRelationalAuthoritative', 'adoptRelationalAuthority', 'reportIgnoredRelationalWrite']) { const f = liftFrontend(n, staleTab); if (f) staleTab[n] = f; }
    const saveToServer = liftFrontend('saveToServer', staleTab);
    ok(!!saveToServer, 'saveToServer found');
    if (saveToServer) {
      tabAlerts.length = 0;
      const invRel = JSON.stringify(mine(await readTargeted(H)));
      const r0 = await psRow();
      let threw: string | null = null;
      try { await saveToServer({ v: 4, _partial: true, inventory: [{ id: 42, sku: 'INVP-STALE', name: 'stale', cat: 'X' }] }); } catch (e: any) { threw = e.message; }
      ok(!!threw && tabAlerts.some((m) => /NOT saved/.test(m)), 'inventory-only stale save: refused AND the user is told it was NOT saved', threw);
      ok(String((await psRow()).updated_at) === String(r0.updated_at), 'platform_state was not written at all');
      tabAlerts.length = 0;
      const mixed = await saveToServer({ v: 4, _partial: true, inventory: [{ id: 43, sku: 'INVP-STALE-2', name: 'stale', cat: 'X' }], savedCalcs: [{ id: 'invp-calc', name: 'kept' }] });
      ok(mixed && mixed.success !== false && tabAlerts.some((m) => /inventory change was NOT saved/.test(m)), 'mixed stale save: the JSON section saves, the inventory part is reported NOT saved');
      ok(((await psRow()).data.savedCalcs || []).some((c: any) => c.id === 'invp-calc'), 'the legitimate non-inventory section really was saved');
      ok(JSON.stringify(mine(await readTargeted(H))) === invRel, 'relational inventory untouched by either stale save');
      tabAlerts.length = 0;
      const plain = await saveToServer({ v: 4, _partial: true, savedCalcs: [{ id: 'invp-calc-2', name: 'plain' }] });
      ok(plain && tabAlerts.length === 0, 'an ordinary non-inventory save works with no warning');
    }
  } finally {
    // ── put everything back ──
    // the conversion fixtures of [14] (quotes/jobs for 'INVP Deduction Co' only)
    await pool.query(`UPDATE rel_quotes SET converted_job_id = NULL WHERE customer_name_raw = 'INVP Deduction Co'`);
    await pool.query(`DELETE FROM rel_jobs WHERE customer_name_raw = 'INVP Deduction Co'`);
    await pool.query(`DELETE FROM quote_conversions WHERE quote_id IN (SELECT id::text FROM rel_quotes WHERE customer_name_raw = 'INVP Deduction Co')`).catch(() => undefined);
    await pool.query(`DELETE FROM rel_quotes WHERE customer_name_raw = 'INVP Deduction Co'`);
    await pool.query(`DELETE FROM rel_inventory_items WHERE sku ILIKE 'INVP-%'`);
    await pool.query(`DELETE FROM rel_suppliers WHERE source_id = 'INVP-SUP-LEGACY'`);
    await pool.query(`DELETE FROM app_users WHERE email = 'invp-holdings@signacore.local'`);
    if (psBefore.rowCount) await pool.query('UPDATE platform_state SET data = $1 WHERE id = 1', [psBefore.rows[0].data]);
    for (const r of cutBefore.rows) await pool.query('UPDATE relational_cutover SET enabled = $1 WHERE section = $2', [r.enabled, r.section]);
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
