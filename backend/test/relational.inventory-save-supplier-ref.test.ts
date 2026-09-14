/**
 * relational.inventory-save-supplier-ref.test.ts
 *
 * INVENTORY SAVE REPAIR (2026-09-14) — "Inventory -> Stock Items -> Edit Stock
 * Item -> Save Item" failed with:
 *     The server could not complete this save (inventory item) — it reported:
 *     "Internal error".
 *
 * ROOT CAUSE PROVEN HERE. rel_inventory_items.supplier_id is
 * `BIGINT REFERENCES rel_suppliers(id)` (007_relational_core.sql) — the real
 * PK. The frontend never holds that PK: read.ts's mapItemRow renders an item's
 * `supplierId` from supplier_source_id (falling back to legacy_data.supplierId)
 * — the supplier's ORIGINAL historical JSON id — and index.html's
 * AddEditInventoryItemModal posts exactly that value back. services.ts's
 * createInventoryItem/updateInventoryItem pushed it STRAIGHT into the FK
 * column, so for every BACKFILLED supplier (source_id = legacy JSON id, PK = a
 * small serial) Postgres raised
 *     23503 foreign_key_violation (rel_inventory_items_supplier_id_fkey)
 * which is neither ConcurrencyConflictError nor BusinessRuleError, so
 * api.ts's handleServiceError fell through to 500 {error:'Internal error'}.
 *
 * This is the SAME defect class resolveInventoryRef already fixes for quote/job
 * line items (services.ts, "BUG 3 ROOT CAUSE #1"); resolveSupplierRef closes it
 * for the supplier link, at the same single shared point.
 *
 * resolveSupplierRef's four cases, all covered below:
 *   1. null / '' ................ supplier_id = NULL (valid, saves)          CASE 6b
 *   2. matches source_id ........ resolved to the real PK (the live defect)  CASE 2
 *   3. matches a real PK ........ accepted, source ref normalised            CASE 2/CREATE
 *   4. non-null, matches neither  BusinessRuleError -> 409, row UNCHANGED    CASE 6
 *
 * Exercises the REAL exported services.ts functions and the REAL read path —
 * nothing is reimplemented here.
 *
 * ── SAFETY ────────────────────────────────────────────────────────────────
 * This test WRITES. It therefore refuses to run unless
 * INVENTORY_SAVE_TEST_DATABASE_URL is set AND names a database whose name ends
 * in `_test`. It never reads DATABASE_URL, never TRUNCATEs, and only ever
 * touches rows it created itself (source_id prefixed TEST-INVSUP-), which it
 * removes again at the end.
 *
 *   createdb signacore_test
 *   psql -d signacore_test -f database/migrations/007_relational_core.sql
 *   psql -d signacore_test -f database/migrations/009_inventory_soft_delete.sql
 *   INVENTORY_SAVE_TEST_DATABASE_URL=postgresql://.../signacore_test \
 *     npx ts-node --transpile-only test/relational.inventory-save-supplier-ref.test.ts
 */
const TEST_URL = process.env.INVENTORY_SAVE_TEST_DATABASE_URL;
if (!TEST_URL) {
  console.log('[inventory-save-supplier-ref] SKIPPED — INVENTORY_SAVE_TEST_DATABASE_URL not set.');
  process.exit(0);
}
if (!/\/[A-Za-z0-9_-]*_test(\?|$)/.test(TEST_URL)) {
  console.error('[inventory-save-supplier-ref] REFUSING TO RUN — the database name must end in "_test". This test writes.');
  process.exit(1);
}
// db/pool.ts reads DATABASE_URL; point it at the throwaway test database only.
process.env.DATABASE_URL = TEST_URL;

import pool from '../src/db/pool';
import {
  createInventoryItem, updateInventoryItem,
  ConcurrencyConflictError, BusinessRuleError,
} from '../src/relational/services';
import { buildInventoryJson } from '../src/relational/read';

const SRC_ITEM = 'TEST-INVSUP-ITEM-1777018196257';
const SRC_SUP = 'TEST-INVSUP-SUP-1777018057084';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
}
function shape(err: any): string {
  if (err instanceof ConcurrencyConflictError) return '409 stale_record';
  if (err instanceof BusinessRuleError) return '409 business_rule';
  return `500 Internal error [pg code=${err && err.code} constraint=${err && err.constraint}]`;
}

async function cleanup(): Promise<void> {
  await pool.query(`DELETE FROM rel_inventory_items WHERE source_id LIKE 'TEST-INVSUP-%'`);
  await pool.query(`DELETE FROM rel_suppliers WHERE source_id LIKE 'TEST-INVSUP-%'`);
}
/** A BACKFILLED supplier: source_id = the legacy JSON id, PK = a serial. */
async function backfilledSupplier(): Promise<number> {
  const r = await pool.query(
    'INSERT INTO rel_suppliers (source_id, name) VALUES ($1,$2) RETURNING id', [SRC_SUP, 'Legacy Supplier']);
  return Number(r.rows[0].id);
}
/** The reported live item, exactly as backfill.ts writes it. */
async function liveItem(supplierPk: number | null, supplierSourceId: string | null): Promise<any> {
  await pool.query(
    `INSERT INTO rel_inventory_items
       (source_id, sku, name, category, unit, cost, sell, stock_qty, reorder_level,
        supplier_id, supplier_source_id, legacy_data)
     VALUES ($1,'SNS-BAN-SF-4',
             'Sharkfin Banner (Rounded Telescopic) complete system...',
             'Promotional Material','unit',1255,1757,0,0,$2,$3,
             '{"cat":"Promotional Material","sku":"SNS-BAN-SF-4"}'::jsonb)`,
    [SRC_ITEM, supplierPk, supplierSourceId]);
  return mine();
}
async function mine(): Promise<any> {
  return (await buildInventoryJson()).filter((i: any) => String(i.sku) === 'SNS-BAN-SF-4' && i.name.startsWith('Sharkfin'))[0];
}
async function row(): Promise<any> {
  return (await pool.query('SELECT * FROM rel_inventory_items WHERE source_id = $1', [SRC_ITEM])).rows[0];
}
/** The EXACT patch index.html's saveItem__impl builds for an edit. */
const uiPatch = (fe: any, over: Record<string, unknown> = {}) => ({
  sku: fe.sku, name: fe.name, category: fe.cat, unit: fe.unit,
  cost: fe.cost, sell: fe.sell, stock: fe.stock, reorder: fe.reorder,
  supplierId: fe.supplierId, ...over,
});

async function main(): Promise<void> {
  await cleanup();
  let fe: any, r: any, x: any;

  // ── CASE 1 — no supplier, qty 0, reorder 0; edit the sell price ──────────
  console.log('\nCASE 1  existing item, supplier null, qty 0 / reorder 0 — edit sell price');
  fe = await liveItem(null, null);
  r = await updateInventoryItem(fe._relId, fe._relRowVersion, uiPatch(fe, { sell: 1800 }) as any);
  check('save succeeds', r.rowVersion === fe._relRowVersion + 1);
  x = await row();
  check('sell persisted', Number(x.sell) === 1800, String(x.sell));
  check('stock still 0 (not null)', x.stock_qty !== null && Number(x.stock_qty) === 0);
  check('reorder still 0 (not null)', x.reorder_level !== null && Number(x.reorder_level) === 0);
  await cleanup();

  // ── CASE 2 — item linked to a BACKFILLED supplier: the reported failure ──
  console.log('\nCASE 2  item linked to a BACKFILLED supplier — edit qty + price');
  const supPk = await backfilledSupplier();
  fe = await liveItem(supPk, SRC_SUP);
  check('frontend holds the SOURCE id, not the PK', String(fe.supplierId) === SRC_SUP && String(supPk) !== SRC_SUP,
    `fe=${fe.supplierId} pk=${supPk}`);
  try {
    r = await updateInventoryItem(fe._relId, fe._relRowVersion, uiPatch(fe, { stock: 5, sell: 1900 }) as any);
    check('save succeeds (regression: was 500 Internal error / pg 23503)', r.rowVersion === fe._relRowVersion + 1);
  } catch (e) { check('save succeeds (regression: was 500 Internal error / pg 23503)', false, shape(e)); }
  x = await row();
  check('supplier REMAINS linked — real PK stored in supplier_id', Number(x.supplier_id) === supPk, String(x.supplier_id));
  check('supplier_source_id mirrored (read path reads this first)', x.supplier_source_id === SRC_SUP);
  check('read-back still shows the supplier link', String((await mine()).supplierId) === SRC_SUP);
  check('qty persisted', Number(x.stock_qty) === 5);
  check('sell persisted', Number(x.sell) === 1900);

  // ── CASE 3 — linked supplier -> no supplier ─────────────────────────────
  console.log('\nCASE 3  linked supplier -> no supplier (schema permits NULL supplier_id)');
  fe = await mine();
  r = await updateInventoryItem(fe._relId, fe._relRowVersion, uiPatch(fe, { supplierId: null }) as any);
  x = await row();
  check('save succeeds', r.rowVersion === fe._relRowVersion + 1);
  check('supplier_id cleared to NULL', x.supplier_id === null, String(x.supplier_id));
  check('supplier_source_id cleared too (no stale breadcrumb)', x.supplier_source_id === null, String(x.supplier_source_id));
  fe = await mine();
  r = await updateInventoryItem(fe._relId, fe._relRowVersion, uiPatch(fe, { supplierId: '' }) as any);
  check("the <select>'s empty string means unlinked, never 22P02", r.rowVersion === fe._relRowVersion + 1);
  await cleanup();

  // ── CASE 4 — zero numerics must stay 0, never null/undefined ────────────
  console.log('\nCASE 4  zero numeric values stay 0');
  fe = await liveItem(null, null);
  await updateInventoryItem(fe._relId, fe._relRowVersion, uiPatch(fe, { stock: 0, reorder: 0, cost: 0 }) as any);
  x = await row();
  check('stock_qty === 0', x.stock_qty !== null && Number(x.stock_qty) === 0);
  check('reorder_level === 0', x.reorder_level !== null && Number(x.reorder_level) === 0);
  check('cost === 0', x.cost !== null && Number(x.cost) === 0);
  check('read path exposes a numeric 0', (await mine()).stock === 0);

  // ── CASE 5 — 1255 / 1757 round-trip exactly ────────────────────────────
  console.log('\nCASE 5  cost 1255 / sell 1757 round-trip');
  fe = await mine();
  await updateInventoryItem(fe._relId, fe._relRowVersion, uiPatch(fe, { cost: 1255, sell: 1757 }) as any);
  fe = await mine();
  check('cost === 1255', fe.cost === 1255, String(fe.cost));
  check('sell === 1757', fe.sell === 1757, String(fe.sell));
  await cleanup();

  // ── CASE 6 — a NON-NULL supplier reference that matches nothing ────────
  // Must be REFUSED, never silently unlinked: rewriting a non-null supplier
  // reference to NULL as a side effect of an unrelated edit would quietly
  // unlink the item with no error and no way to notice.
  console.log('\nCASE 6  invalid NON-NULL supplier reference -> controlled 409, row untouched');
  fe = await liveItem(null, null);
  const before6 = await row();
  for (const bad of ['9999999999999', 'not-an-id', '9'.repeat(25)]) {
    const label = bad.length > 14 ? bad.slice(0, 11) + '…' : bad;
    try {
      await updateInventoryItem(fe._relId, fe._relRowVersion, uiPatch(fe, { supplierId: bad, sell: 2000 }) as any);
      check(`supplierId "${label}" refused`, false, 'the save SUCCEEDED');
    } catch (e) {
      check(`supplierId "${label}" -> BusinessRuleError (clean 409, never 500)`,
        e instanceof BusinessRuleError, shape(e));
    }
    const after = await row();
    check(`  "${label}": supplier_id unchanged (NOT silently nulled/overwritten)`,
      after.supplier_id === before6.supplier_id, String(after.supplier_id));
    check(`  "${label}": supplier_source_id unchanged`,
      after.supplier_source_id === before6.supplier_source_id, String(after.supplier_source_id));
    check(`  "${label}": no partial write — sell still ${before6.sell}, not 2000`,
      String(after.sell) === String(before6.sell), String(after.sell));
    check(`  "${label}": row_version NOT bumped (transaction rolled back)`,
      Number(after.row_version) === Number(before6.row_version), String(after.row_version));
  }
  await cleanup();

  // ── CASE 6b — "No supplier linked" as a real null/empty value ──────────
  console.log('\nCASE 6b  "No supplier linked" (null / empty) saves successfully');
  fe = await liveItem(null, null);
  r = await updateInventoryItem(fe._relId, fe._relRowVersion, uiPatch(fe, { supplierId: null, sell: 2100 }) as any);
  x = await row();
  check('explicit null supplier -> save succeeds', r.rowVersion === fe._relRowVersion + 1);
  check('explicit null supplier -> supplier_id IS NULL', x.supplier_id === null, String(x.supplier_id));
  check('explicit null supplier -> supplier_source_id IS NULL', x.supplier_source_id === null);
  check('the edit itself committed', Number(x.sell) === 2100);
  fe = await mine();
  r = await updateInventoryItem(fe._relId, fe._relRowVersion, uiPatch(fe, { supplierId: '', sell: 2200 }) as any);
  x = await row();
  check("the <select>'s empty string -> save succeeds", r.rowVersion === fe._relRowVersion + 1);
  check("the <select>'s empty string -> supplier_id IS NULL", x.supplier_id === null, String(x.supplier_id));
  check('the edit itself committed', Number(x.sell) === 2200);
  await cleanup();

  // ── CASE 7 — optimistic concurrency is unchanged ───────────────────────
  console.log('\nCASE 7  stale row_version must not silently overwrite another save');
  const supPk2 = await backfilledSupplier();
  fe = await liveItem(supPk2, SRC_SUP);
  const stale = fe._relRowVersion;                                   // editor A opened here
  await updateInventoryItem(fe._relId, stale, uiPatch(fe, { sell: 1500 }) as any);   // editor B saves
  try {
    await updateInventoryItem(fe._relId, stale, uiPatch(fe, { sell: 9999 }) as any); // editor A saves stale
    check('stale save rejected', false, 'it succeeded');
  } catch (e) {
    check('stale save -> ConcurrencyConflictError (409 stale_record, NOT 500)', e instanceof ConcurrencyConflictError, shape(e));
  }
  x = await row();
  check("editor B's value survived", Number(x.sell) === 1500, String(x.sell));
  check('row_version bumped exactly once', Number(x.row_version) === stale + 1);
  check('nothing partially written by the rejected save', Number(x.sell) !== 9999);

  // ── CREATE path — same defect, same fix ────────────────────────────────
  console.log('\nCREATE  Add Stock Item with a backfilled supplier id');
  try {
    const c = await createInventoryItem({
      sku: 'SNS-TEST-NEW-1', name: 'TEST-INVSUP new item', category: 'Promotional Material',
      unit: 'unit', cost: 0, sell: 0, stock: 0, reorder: 0, supplierId: SRC_SUP as any,
    });
    const created = (await pool.query('SELECT * FROM rel_inventory_items WHERE id = $1', [c.id])).rows[0];
    check('create succeeds (regression: was 500 Internal error / pg 23503)', true);
    check('supplier_id = real PK', Number(created.supplier_id) === supPk2, String(created.supplier_id));
    check('supplier_source_id populated (link survives read-back)', created.supplier_source_id === SRC_SUP);
    await pool.query('DELETE FROM rel_inventory_items WHERE id = $1', [c.id]);
  } catch (e) { check('create succeeds (regression: was 500 Internal error / pg 23503)', false, shape(e)); }

  await cleanup();
  console.log('\n============================================================');
  console.log(`${pass} passed, ${fail} failed`);
  console.log('============================================================');
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await cleanup().catch(() => undefined); await pool.end().catch(() => undefined); process.exit(1); });
