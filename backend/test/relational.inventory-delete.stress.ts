/**
 * relational.inventory-delete.stress.ts — MIGRATION CLOSURE Item 3
 * verification.
 *
 * Before this fix, relational inventory had create/update/adjust but NO
 * delete at all (see services.ts's prior Stage 3 Phase 8 note) — removeItem
 * stayed JSON-only, and cutting "inventory" over for real would make it
 * impossible to delete an item through the relational path at all
 * (assertNoUnwiredRelationalSections would refuse the save loudly).
 *
 * Design proven here: migration 009 adds rel_inventory_items.is_active
 * (default TRUE). deleteInventoryItem() is a SOFT delete — is_active set
 * to false under the same row-scoped expectedVersion discipline as every
 * other relational mutation — NEVER a physical DELETE. This is deliberate:
 * rel_quote_line_items/rel_job_line_items carry an optional
 * inventory_item_id FK back to this table with no ON DELETE CASCADE/SET
 * NULL, so a physical delete would either be refused forever for any item
 * ever quoted (unlike rel_suppliers, discontinuing a catalog item is a
 * ROUTINE action, not a rare edge case) or require a CASCADE/SET NULL that
 * could sever historical linkage — exactly what the task calls out as
 * unacceptable ("never ON DELETE CASCADE destroying business history").
 *
 * Covers:
 *   - a soft delete with the correct expectedVersion succeeds and the row
 *     is NEVER physically removed
 *   - the deactivated item still appears through the full read path
 *     (GET-equivalent buildInventoryJson) with active:false — never hidden
 *     entirely, so full backups/history stay complete
 *   - a stale-version delete is rejected 409 stale_record, is_active
 *     unchanged
 *   - deleting a nonexistent item is 409 business_rule
 *   - a delete request with no expectedVersion is refused 400
 *   - deleting while "inventory" is not cut over is refused 409 not_cut_over
 *   - a double-delete (same now-stale expectedVersion reused) is rejected
 *     409 stale_record, never a silent second success
 *   - reactivation (updateInventoryItem's new `active` patch field) flips
 *     is_active back to true
 *   - THE CORE HISTORY-PRESERVATION PROOF: an inventory item referenced by
 *     a quote's line item can be soft-deleted with ZERO impact on that
 *     quote — the line's own stored desc/qty/unit_price render exactly as
 *     before, and the inventory_item_id FK link is never broken (no FK
 *     violation, no orphaned/cascaded row)
 *
 * Requires TEST_SERVER_URL_WITH_AUTHORITY — skips with a clear notice if
 * unset, same convention as every other Stage 2/3 REST suite.
 */
import pool from '../src/db/pool';

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

async function resetRelationalTables() {
  await pool.query(`
    TRUNCATE rel_payments, rel_quote_line_items, rel_quotes, rel_inventory_items, rel_customers
    RESTART IDENTITY CASCADE
  `);
  await pool.query(`DELETE FROM document_number_counters`);
  await pool.query(`UPDATE relational_cutover SET enabled = false, enabled_at = NULL, enabled_by = NULL`);
}

async function main() {
  const base = process.env.TEST_SERVER_URL_WITH_AUTHORITY;
  if (!base) {
    console.log('[inventory-delete] SKIPPED — TEST_SERVER_URL_WITH_AUTHORITY not set.');
    await pool.end();
    process.exit(0);
  }

  await resetRelationalTables();
  const token = await login(base);
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section = 'inventory'`);

  // ── migration landed ──
  console.log('\n[Inventory delete] migration 009 — is_active column exists, defaults true');
  const colRes = await pool.query(`SELECT column_name, column_default, is_nullable FROM information_schema.columns WHERE table_name='rel_inventory_items' AND column_name='is_active'`);
  ok(colRes.rowCount === 1 && colRes.rows[0].column_default === 'true' && colRes.rows[0].is_nullable === 'NO', 'is_active exists, NOT NULL, defaults true', colRes.rows[0]);

  // ── a soft delete with the correct version succeeds, row never physically removed ──
  console.log('\n[Inventory delete] a soft delete with the correct expectedVersion succeeds and the row is NEVER physically removed');
  const itemA = await (await fetch(`${base}/api/relational/inventory`, {
    method: 'POST', headers: H, body: JSON.stringify({ sku: 'DEL-A', name: 'Item A', category: 'Vinyl', unit: 'm2', cost: 10, sell: 20, stock: 5, reorder: 1 }),
  })).json();
  const delA = await fetch(`${base}/api/relational/inventory/${itemA.id}`, {
    method: 'DELETE', headers: H, body: JSON.stringify({ expectedVersion: itemA.rowVersion }),
  });
  const delABody: any = await delA.json();
  ok(delA.status === 200 && delABody.deactivated === true, 'delete returns 200 { deactivated: true }', delABody);
  const rowA = await pool.query(`SELECT is_active, row_version FROM rel_inventory_items WHERE id = $1`, [itemA.id]);
  ok(rowA.rowCount === 1, 'the row still physically exists after delete');
  ok(rowA.rows[0].is_active === false, 'is_active is correctly flipped to false');
  ok(rowA.rows[0].row_version === itemA.rowVersion + 1, 'row_version was bumped by exactly 1, same discipline as every other mutation');

  // ── deactivated item still appears through the full read path, with active:false ──
  console.log('\n[Inventory delete] the deactivated item still appears through buildInventoryJson (full backup / GET path) with active:false — never hidden from history');
  const read = await import('../src/relational/read');
  const inventoryJson = await read.buildInventoryJson();
  const itemAInJson = inventoryJson.find((i: any) => i._relId === itemA.id);
  ok(!!itemAInJson, 'the deactivated item is STILL present in buildInventoryJson\'s output (not filtered out server-side)');
  ok(itemAInJson && itemAInJson.active === false, 'it correctly reports active:false', itemAInJson);

  // ── stale-version delete is rejected, is_active unchanged ──
  console.log('\n[Inventory delete] a STALE-version delete is rejected 409 stale_record, is_active unchanged');
  const itemB = await (await fetch(`${base}/api/relational/inventory`, {
    method: 'POST', headers: H, body: JSON.stringify({ sku: 'DEL-B', name: 'Item B', category: 'Vinyl', cost: 5, sell: 10, stock: 2 }),
  })).json();
  await fetch(`${base}/api/relational/inventory/${itemB.id}`, {
    method: 'PUT', headers: H, body: JSON.stringify({ expectedVersion: itemB.rowVersion, name: 'Item B (edited)' }),
  });
  const delBStale = await fetch(`${base}/api/relational/inventory/${itemB.id}`, {
    method: 'DELETE', headers: H, body: JSON.stringify({ expectedVersion: itemB.rowVersion }),
  });
  const delBStaleBody: any = await delBStale.json();
  ok(delBStale.status === 409 && delBStaleBody.type === 'stale_record', 'stale-version delete returns 409 stale_record', delBStaleBody);
  const rowB = await pool.query(`SELECT is_active, name FROM rel_inventory_items WHERE id = $1`, [itemB.id]);
  ok(rowB.rows[0].is_active === true, 'is_active is still true — the rejected delete never touched the row');
  ok(rowB.rows[0].name === 'Item B (edited)', 'the row still holds the edit that made the delete\'s version stale');

  // ── nonexistent item ──
  console.log('\n[Inventory delete] deleting a nonexistent item is 409 business_rule');
  const delC = await fetch(`${base}/api/relational/inventory/999999999`, {
    method: 'DELETE', headers: H, body: JSON.stringify({ expectedVersion: 1 }),
  });
  const delCBody: any = await delC.json();
  ok(delC.status === 409 && delCBody.type === 'business_rule', 'nonexistent item id returns 409 business_rule', delCBody);

  // ── missing expectedVersion ──
  console.log('\n[Inventory delete] a delete request with no expectedVersion is refused 400');
  const itemD = await (await fetch(`${base}/api/relational/inventory`, {
    method: 'POST', headers: H, body: JSON.stringify({ sku: 'DEL-D', name: 'Item D', cost: 1, sell: 2, stock: 1 }),
  })).json();
  const delDMissing = await fetch(`${base}/api/relational/inventory/${itemD.id}`, { method: 'DELETE', headers: H, body: JSON.stringify({}) });
  ok(delDMissing.status === 400, 'missing expectedVersion returns 400', delDMissing.status);
  const rowD = await pool.query(`SELECT is_active FROM rel_inventory_items WHERE id = $1`, [itemD.id]);
  ok(rowD.rows[0].is_active === true, 'the item is untouched by the malformed request');

  // ── not cut over ──
  console.log('\n[Inventory delete] deleting while "inventory" is not cut over is refused 409 not_cut_over');
  await pool.query(`UPDATE relational_cutover SET enabled = false WHERE section = 'inventory'`);
  const delE = await fetch(`${base}/api/relational/inventory/${itemD.id}`, {
    method: 'DELETE', headers: H, body: JSON.stringify({ expectedVersion: itemD.rowVersion }),
  });
  const delEBody: any = await delE.json();
  ok(delE.status === 409 && delEBody.type === 'not_cut_over', 'refused 409 not_cut_over while "inventory" is not cut over', delEBody);
  await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section = 'inventory'`);

  // ── double-delete ──
  console.log('\n[Inventory delete] a double-delete (same now-stale expectedVersion reused) is rejected, never a silent second success');
  const delDFirst = await fetch(`${base}/api/relational/inventory/${itemD.id}`, {
    method: 'DELETE', headers: H, body: JSON.stringify({ expectedVersion: itemD.rowVersion }),
  });
  ok(delDFirst.status === 200, 'the first delete succeeds', await delDFirst.text().catch(() => ''));
  const delDSecond = await fetch(`${base}/api/relational/inventory/${itemD.id}`, {
    method: 'DELETE', headers: H, body: JSON.stringify({ expectedVersion: itemD.rowVersion }),
  });
  const delDSecondBody: any = await delDSecond.json();
  ok(delDSecond.status === 409 && delDSecondBody.type === 'stale_record', 'the second delete (stale, already-consumed version) is rejected 409 stale_record', delDSecondBody);

  // ── reactivation ──
  console.log('\n[Inventory delete] reactivation — updateInventoryItem\'s new `active` patch field flips is_active back to true');
  const rowDNow = await pool.query(`SELECT row_version FROM rel_inventory_items WHERE id = $1`, [itemD.id]);
  const reactivateRes = await fetch(`${base}/api/relational/inventory/${itemD.id}`, {
    method: 'PUT', headers: H, body: JSON.stringify({ expectedVersion: rowDNow.rows[0].row_version, active: true }),
  });
  ok(reactivateRes.status === 200, 'reactivation via PUT succeeds', await reactivateRes.text().catch(() => ''));
  const rowDReactivated = await pool.query(`SELECT is_active FROM rel_inventory_items WHERE id = $1`, [itemD.id]);
  ok(rowDReactivated.rows[0].is_active === true, 'is_active is correctly flipped back to true');

  // ── THE CORE HISTORY-PRESERVATION PROOF ──
  console.log('\n[Inventory delete] CORE PROOF — soft-deleting an item referenced by a quote line item has ZERO impact on that quote; the FK link is never broken');
  await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section = 'quotes'`);
  const services = await import('../src/relational/services');
  const itemF = await (await fetch(`${base}/api/relational/inventory`, {
    method: 'POST', headers: H, body: JSON.stringify({ sku: 'DEL-F', name: 'Referenced Item', category: 'Vinyl', unit: 'm2', cost: 50, sell: 100, stock: 20 }),
  })).json();
  const cust = await services.createCustomer({ companyName: 'Inventory Delete History Co' });
  const quote = await services.createQuote({
    companyCode: '2', customerId: cust.id, customerNameRaw: 'Inventory Delete History Co',
    lines: [{ description: 'Referenced Item — 2m2 banner', qty: 2, unitPrice: 100, inventoryItemId: itemF.id }],
  });
  const delF = await fetch(`${base}/api/relational/inventory/${itemF.id}`, {
    method: 'DELETE', headers: H, body: JSON.stringify({ expectedVersion: itemF.rowVersion }),
  });
  ok(delF.status === 200, 'the referenced item is soft-deleted successfully — no FK violation, no refusal', await delF.text().catch(() => ''));
  const lineAfter = await pool.query(`SELECT description, qty, unit_price, subtotal, inventory_item_id FROM rel_quote_line_items WHERE quote_id = $1`, [quote.id]);
  ok(lineAfter.rowCount === 1, 'the quote still has exactly its one line item — nothing cascaded or vanished');
  ok(lineAfter.rows[0].description === 'Referenced Item — 2m2 banner' && Number(lineAfter.rows[0].qty) === 2 && Number(lineAfter.rows[0].unit_price) === 100,
    'the line\'s OWN stored desc/qty/unit_price are completely unaffected — it never re-reads the parent inventory row to render', lineAfter.rows[0]);
  ok(Number(lineAfter.rows[0].inventory_item_id) === Number(itemF.id), 'the inventory_item_id FK link is still intact, pointing at the now-inactive (not deleted) row');
  const itemFStillThere = await pool.query(`SELECT is_active FROM rel_inventory_items WHERE id = $1`, [itemF.id]);
  ok(itemFStillThere.rowCount === 1 && itemFStillThere.rows[0].is_active === false, 'the inventory row itself is still there (inactive, not gone) — the FK could never have been left dangling');
  const quotesJson = (await import('../src/relational/read')).buildQuotesJson;
  const quotesAfter = await quotesJson();
  const quoteAfter = quotesAfter.find((q: any) => q._relId === quote.id);
  ok(!!quoteAfter && quoteAfter.lines.length === 1 && quoteAfter.lines[0].desc === 'Referenced Item — 2m2 banner', 'the full read path (buildQuotesJson, what the frontend actually renders) still shows the quote\'s line exactly as before', quoteAfter && quoteAfter.lines);

  await resetRelationalTables();
  await pool.query(`UPDATE platform_state SET data = '{}'::jsonb, updated_at = NOW() WHERE id = 1`);

  console.log('\n' + '='.repeat(60));
  console.log(`${passed} passed, ${failures} failed`);
  console.log('='.repeat(60));
  await pool.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[inventory-delete] Fatal error:', err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
