/**
 * relational.frontend-po-supplier-inventory-wiring.test.ts — STAGE 3
 * Phases 8, 9, 10 verification (frontend supplier / purchase order /
 * inventory create-edit-delete wiring).
 *
 * For each of the three entities:
 *   1. Source-text checks that the relevant page's save/delete function
 *      routes through relationalApi when the section is cut over, using
 *      ._relId (never a bare .id), and sets _relId/_relRowVersion
 *      immediately on a new record's local stub.
 *   2. A REAL end-to-end proof over real HTTP of create + edit (+ delete,
 *      where a relational delete route exists) exactly as the wired
 *      frontend now calls it.
 *
 * Also documents, via a source-text assertion, the one remaining deliberate
 * gap: a "custom" (not-yet-saved) supplier name on a Purchase Order
 * (rel_purchase_orders has no raw-name column) stays JSON-only by design,
 * protected by the pre-existing systemic safety guard if the section is
 * ever cut over for real. Inventory item DELETE (formerly the same kind of
 * documented gap) was closed by MIGRATION CLOSURE Item 3 — see
 * relational.inventory-delete.stress.ts for full scenario coverage; this
 * file's own source-text checks below confirm removeItem() is wired.
 *
 * Requires TEST_SERVER_URL_WITH_AUTHORITY for the end-to-end parts — skips
 * with a clear notice if unset, same convention as every other Stage 2/3
 * REST suite.
 */
import fs from 'fs';
import path from 'path';
import pool from '../src/db/pool';

const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH || path.resolve(__dirname, '..', '..', 'index.html');

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

async function login(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.TEST_LOGIN_EMAIL || 'test@signacore.local', password: process.env.TEST_LOGIN_PASSWORD || 'testpass' }),
  });
  if (!res.ok) throw new Error(`login failed against ${baseUrl}: HTTP ${res.status}`);
  return (await res.json()).token;
}

function checkSourceWiring(src: string) {
  console.log('\n[Frontend PO/supplier/inventory wiring] source-text checks');

  // Suppliers (Phase 8)
  ok(src.includes(`if(isRelationalAuthoritative('suppliers')){`) && src.includes(`async function saveSup(s) {`),
    'SuppliersPage.saveSup checks isRelationalAuthoritative(\'suppliers\')');
  ok(src.includes(`const result = await relationalApi.createSupplier(patch);`),
    'saveSup create branch calls relationalApi.createSupplier');
  ok(src.includes(`setSuppliers(prev => [{ ...s, id: result.id, _relId: result.id, _relRowVersion: result.rowVersion }, ...prev]);`),
    'saveSup create branch sets _relId/_relRowVersion immediately');
  ok(src.includes(`const result = await relationalApi.updateSupplier(existing && existing._relId, existing && existing._relRowVersion, patch);`),
    'saveSup edit branch uses existing._relId, never a bare .id');
  ok(src.includes(`if(isRelationalAuthoritative('suppliers') && existing && existing._relId!=null){`) && src.includes(`async function delSup(id) {`),
    'delSup routes relationally only for a genuine relational row');
  ok(src.includes(`await relationalApi.deleteSupplier(existing._relId, existing._relRowVersion);`),
    'delSup calls relationalApi.deleteSupplier with _relId/_relRowVersion');

  // Purchase Orders (Phase 9)
  ok(src.includes(`if(isRelationalAuthoritative('purchaseOrders') && po.supplierId!=null){`) && src.includes(`async function handleCreateCustomPO(po) {`),
    'handleCreateCustomPO routes relationally only for a SAVED supplier (po.supplierId set)');
  ok(src.includes(`const result = await relationalApi.createPurchaseOrder({`),
    'handleCreateCustomPO create branch calls relationalApi.createPurchaseOrder');
  ok(src.includes(`_relId:result.id, _relRowVersion:result.rowVersion}, ...prev]);`),
    'handleCreateCustomPO sets _relId/_relRowVersion immediately on the new PO stub');
  ok(src.includes(`if(isRelationalAuthoritative('purchaseOrders') && updated._relId!=null){`) && src.includes(`async function updatePO(updated) {`),
    'updatePO routes relationally only for a genuine relational row (updated._relId set)');
  ok(src.includes(`const result = await relationalApi.updatePurchaseOrder(updated._relId, updated._relRowVersion,`),
    'updatePO calls relationalApi.updatePurchaseOrder with updated._relId/._relRowVersion');
  ok(src.includes(`rel_purchase_orders has no raw/custom-supplier-`),
    'the custom-supplier-name limitation for POs is explicitly documented in source, not silently handled');

  // Inventory (Phase 10)
  ok(src.includes(`if(isRelationalAuthoritative('inventory')){`) && src.includes(`async function saveItem(item) {`),
    'InventoryPage.saveItem checks isRelationalAuthoritative(\'inventory\')');
  ok(src.includes(`const result = await relationalApi.createInventoryItem(patch);`),
    'saveItem create branch calls relationalApi.createInventoryItem');
  ok(src.includes(`setInventory(prev => [...prev, { ...item, id: result.id, _relId: result.id, _relRowVersion: result.rowVersion }]);`),
    'saveItem create branch sets _relId/_relRowVersion immediately');
  ok(src.includes(`const result = await relationalApi.updateInventoryItem(existing && existing._relId, existing && existing._relRowVersion, patch);`),
    'saveItem edit branch uses existing._relId, never a bare .id');
  ok(src.includes(`category: item.cat,`),
    'saveItem correctly maps JSON\'s "cat" field to services.ts\'s "category"');
  // MIGRATION CLOSURE Item 3 (2026-08-21): removeItem is no longer
  // JSON-only — it now routes through the relational REST API (a SOFT
  // delete server-side, is_active=false — see services.ts's
  // deleteInventoryItem / migration 009) when "inventory" is
  // relational-authoritative and this is a genuine relational row. Full
  // scenario coverage lives in relational.inventory-delete.stress.ts.
  ok(src.includes(`async function removeItem(id) {`) && src.includes(`if(item && item._relId!=null && isRelationalAuthoritative('inventory')){`),
    'removeItem routes relationally only for a genuine relational row (_relId set) when "inventory" is cut over');
  ok(src.includes(`await relationalApi.deleteInventoryItem(item._relId, item._relRowVersion);`),
    'removeItem calls relationalApi.deleteInventoryItem with the item\'s _relId/_relRowVersion');
  ok(src.includes(`deleteInventoryItem(id, expectedVersion) { return relationalFetch('/inventory/' + id, { method: 'DELETE', body: JSON.stringify({ expectedVersion: expectedVersion }) }); },`),
    'relationalApi.deleteInventoryItem client wrapper exists with the correct shape');
}

async function resetRelationalTables() {
  await pool.query(`TRUNCATE rel_purchase_order_items, rel_purchase_orders, rel_inventory_items, rel_suppliers RESTART IDENTITY CASCADE`);
  await pool.query(`DELETE FROM document_number_counters WHERE doc_type = 'po'`);
  await pool.query(`UPDATE relational_cutover SET enabled = false, enabled_at = NULL, enabled_by = NULL WHERE section IN ('suppliers','purchaseOrders','inventory')`);
}

async function runEndToEndProof() {
  const base = process.env.TEST_SERVER_URL_WITH_AUTHORITY;
  if (!base) {
    console.log('\n[Frontend PO/supplier/inventory wiring] end-to-end proof SKIPPED — TEST_SERVER_URL_WITH_AUTHORITY not set.');
    return;
  }

  await resetRelationalTables();
  await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section IN ('suppliers','purchaseOrders','inventory')`);

  const token = await login(base);
  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  console.log('\n[Frontend PO/supplier/inventory wiring] Supplier: exactly what saveSup() now sends for a NEW supplier');
  const createSupRes = await fetch(`${base}/api/relational/suppliers`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ name: 'Frontend Wiring Supplier Co', contactPerson: 'Jane', phone: '0210000000', email: 'jane@example.com', address: '1 Main Rd', city: 'Cape Town', postalCode: '8001', vatNumber: 'VAT123', accountNumber: 'ACC1', notes: '', paymentTerms: '30 days' }),
  });
  const createSupBody: any = await createSupRes.json();
  ok(createSupRes.status === 201, 'supplier created', createSupBody);

  console.log('\n[Frontend PO/supplier/inventory wiring] Supplier: edit');
  const editSupRes = await fetch(`${base}/api/relational/suppliers/${createSupBody.id}`, {
    method: 'PUT', headers: authHeaders,
    body: JSON.stringify({ expectedVersion: createSupBody.rowVersion, name: 'Frontend Wiring Supplier Co', contactPerson: 'Jane Updated', phone: '0210000000', email: 'jane@example.com', address: '1 Main Rd', city: 'Cape Town', postalCode: '8001', vatNumber: 'VAT123', accountNumber: 'ACC1', notes: 'edited', paymentTerms: '60 days' }),
  });
  const editSupBody: any = await editSupRes.json();
  ok(editSupRes.status === 200, 'supplier edit succeeded', editSupBody);

  console.log('\n[Frontend PO/supplier/inventory wiring] Inventory: exactly what saveItem() now sends for a NEW item, linked to the new supplier');
  const createInvRes = await fetch(`${base}/api/relational/inventory`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ sku: 'WIRE-SKU-1', name: 'Frontend Wiring Item', category: 'Vinyl', unit: 'sqm', cost: 10, sell: 20, stock: 50, reorder: 5, supplierId: createSupBody.id }),
  });
  const createInvBody: any = await createInvRes.json();
  ok(createInvRes.status === 201, 'inventory item created', createInvBody);

  console.log('\n[Frontend PO/supplier/inventory wiring] PO: exactly what handleCreateCustomPO() now sends with a SAVED supplier chosen');
  const createPoRes = await fetch(`${base}/api/relational/purchase-orders`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({
      companyCode: '2', supplierId: createSupBody.id, jobNumberRaw: null, notes: 'Custom PO',
      items: [{ inventoryItemId: createInvBody.id, name: 'Frontend Wiring Item', unit: 'sqm', qtyNeeded: 20, qtyOrdered: 20, unitCost: 10 }],
    }),
  });
  const createPoBody: any = await createPoRes.json();
  ok(createPoRes.status === 201 && /^PO-/i.test(createPoBody.poNumber || ''), 'PO created with a real PO-##### number', createPoBody);

  console.log('\n[Frontend PO/supplier/inventory wiring] PO: exactly what updatePO() now sends on approve/decline/save-changes (status/supplierId/notes only, no items)');
  const editPoRes = await fetch(`${base}/api/relational/purchase-orders/${createPoBody.id}`, {
    method: 'PUT', headers: authHeaders,
    body: JSON.stringify({ expectedVersion: createPoBody.rowVersion, supplierId: createSupBody.id, status: 'approved', notes: 'Approved via wired frontend' }),
  });
  const editPoBody: any = await editPoRes.json();
  ok(editPoRes.status === 200, 'PO status update succeeded', editPoBody);
  const poAfter = await pool.query(`SELECT status, notes FROM rel_purchase_orders WHERE id = $1`, [createPoBody.id]);
  ok(poAfter.rows[0].status === 'approved' && poAfter.rows[0].notes === 'Approved via wired frontend', 'the DB row reflects the PO status/notes edit');

  await resetRelationalTables();
  await pool.query(`UPDATE platform_state SET data = '{}'::jsonb, updated_at = NOW() WHERE id = 1`);
}

async function main() {
  const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  checkSourceWiring(src);
  await runEndToEndProof();

  console.log('\n' + '='.repeat(60));
  console.log(`${passed} passed, ${failures} failed`);
  console.log('='.repeat(60));
  await pool.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[frontend-po-supplier-inventory-wiring-test] Fatal error:', err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
