/**
 * relational.po-policy.stress.ts — 2026-08-21 PURCHASE ORDER MIGRATION
 * POLICY CHANGE verification (numbering safety, concurrency, multi-PO,
 * line items, stale-edit).
 *
 * Complements relational.stress.ts (backfill policy-skip + reconciliation
 * exclusion — tests #1-#5), relational.stage3.stress.ts
 * (testConversionInventoryNoAutoPO — tests #6-#9), and fullBackupV2.stress.ts
 * (active-vs-legacy PO archive — tests #17/#18). This file covers, against
 * a REAL local PostgreSQL database:
 *
 *   #10 new PO numbers use the exact PO-##### format (5 digits).
 *   #11 a new PO number never reuses a historical PO suffix — the atomic
 *       counter safely seeds PAST the highest legitimately-used historical
 *       numeric PO suffix found in platform_state (reusing the EXISTING
 *       document_number_counters / reserveDocumentNumberWithClient
 *       architecture — no new migration or numbering logic was written for
 *       this; this test proves the existing mechanism already satisfies
 *       the requirement).
 *   #12 concurrent PO creation always produces unique numbers.
 *   #13 two POs for one job both work.
 *   #14 different suppliers on those POs get separate PO numbers, correctly
 *       linked (never one PO number shared across suppliers, reproducing
 *       the historical repeated-document-number problem).
 *   #15 PO line items persist correctly.
 *   #16 a stale-version PO edit remains blocked (row-level optimistic
 *       concurrency, unchanged from before this policy change).
 *
 * SAFETY: refuses to run unless DATABASE_URL points at localhost/127.0.0.1,
 * or ALLOW_UNSAFE_TEST_DB=1 is explicitly set — same convention as every
 * other suite in this directory.
 *
 * Usage (from backend/):
 *   DATABASE_URL=postgresql://user:pass@localhost:5432/signacore_test \
 *   npx ts-node --transpile-only test/relational.po-policy.stress.ts
 */
import pool from '../src/db/pool';
import * as services from '../src/relational/services';
import { buildPurchaseOrdersJson } from '../src/relational/read';

const DB_URL = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(DB_URL) && process.env.ALLOW_UNSAFE_TEST_DB !== '1') {
  console.error('[relational-po-policy-stress] Refusing to run: DATABASE_URL does not look like a local test database.');
  process.exit(1);
}

let failures = 0;
let passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

async function resetTables() {
  await pool.query(`
    TRUNCATE rel_payments, rel_purchase_order_items, rel_purchase_orders,
      rel_credit_notes, rel_job_line_items, rel_jobs, rel_quote_line_items,
      rel_quotes, rel_inventory_items, rel_suppliers, rel_customers
    RESTART IDENTITY CASCADE
  `);
  await pool.query(`DELETE FROM quote_conversions WHERE quote_id LIKE 'rel:%'`);
  await pool.query(`DELETE FROM document_number_counters WHERE doc_type = 'po'`);
}

async function testNumberFormatAndSafeStart() {
  console.log('\n[PO numbering] PO-##### format + safe starting position past the highest historical PO suffix (tests #10, #11)');
  await resetTables();

  // Seed platform_state with a historical purchaseOrders collection that
  // mirrors the REAL production dry-run scenario: many records, several
  // sharing the SAME number (the actual historical duplicate-number
  // problem), reaching up to PO-00085 as the highest legitimately-visible
  // suffix. None of this is ever imported (see backfill.ts's
  // LEGACY_PURCHASE_ORDERS_SKIPPED_BY_POLICY) — it exists here purely to
  // prove the atomic counter's seeding logic (reserveDocumentNumberWithClient
  // / scanExistingNumbers in documentNumbers.ts) correctly scans it and
  // starts the NEW sequence safely past it.
  const psRes = await pool.query('SELECT data FROM platform_state WHERE id = 1');
  const baseData = psRes.rowCount ? psRes.rows[0].data || {} : {};
  const historicalPOs: any[] = [];
  for (let i = 1; i <= 85; i++) {
    // Reproduce the real duplicate-number pattern for the last few numbers
    // (PO-00083/84/85 each had 7-8 records sharing one number in production).
    const groupSize = i >= 83 ? 3 : 1;
    for (let g = 0; g < groupSize; g++) {
      historicalPOs.push({
        id: 90000 + i * 10 + g, num: `PO-${String(i).padStart(5, '0')}`,
        supplierId: null, jobNum: null, co: '2', date: '2020-01-01', status: 'sent', items: [],
      });
    }
  }
  await pool.query(
    `UPDATE platform_state SET data = $1::jsonb, updated_at = NOW() WHERE id = 1`,
    [JSON.stringify({ ...baseData, purchaseOrders: historicalPOs })]
  );

  const sup = await services.createSupplier({ name: 'Numbering Test Supplier' });
  const po = await services.createPurchaseOrder({
    companyCode: '2', supplierId: sup.id,
    items: [{ name: 'Widget', qtyNeeded: 1, qtyOrdered: 1, unitCost: 1 }],
  });
  ok(/^PO-\d{5}$/.test(po.poNumber), 'new PO uses the exact PO-##### format — 5 digits, no PO-1/PO-001/PO-0001 (test #10)', po.poNumber);
  const suffix = parseInt(po.poNumber.slice(3), 10);
  ok(suffix > 85, 'the new PO number\'s numeric suffix is strictly GREATER than the highest historical PO suffix (85) — never reuses a historical number (test #11)', po.poNumber);

  // Clean up the seeded historical fixture so later tests in this file
  // start from an empty purchaseOrders collection.
  await pool.query(`UPDATE platform_state SET data = $1::jsonb, updated_at = NOW() WHERE id = 1`, [JSON.stringify({ ...baseData, purchaseOrders: [] })]);
}

async function testConcurrentUniqueness() {
  console.log('\n[PO numbering] concurrent creation always produces unique numbers (test #12)');
  await resetTables();
  const sup = await services.createSupplier({ name: 'Concurrency Test Supplier' });
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      services.createPurchaseOrder({
        companyCode: '2', supplierId: sup.id,
        items: [{ name: `Concurrent item ${i}`, qtyNeeded: 1, qtyOrdered: 1, unitCost: 1 }],
      })
    )
  );
  const numbers = results.map((r) => r.poNumber);
  const uniqueNumbers = new Set(numbers);
  ok(uniqueNumbers.size === 10, 'all 10 concurrently-created POs received unique PO-##### numbers — atomic row-level locking, never a collision (test #12)', JSON.stringify(numbers));
  ok(numbers.every((n) => /^PO-\d{5}$/.test(n)), 'every concurrently-issued number still uses the correct PO-##### format');
}

async function testMultiplePOsPerJobAndSuppliers() {
  console.log('\n[PO workflow] multiple POs for one job, different suppliers, unique numbers, line items persist (tests #13, #14, #15)');
  await resetTables();
  const cust = await services.createCustomer({ companyName: 'Multi PO Co' });
  const quote = await services.createQuote({
    companyCode: '2', customerId: cust.id, customerNameRaw: 'Multi PO Co',
    lines: [{ description: 'Signage job', qty: 1, unitPrice: 1000 }],
  });
  const conv = await services.convertQuoteToJob(quote.id);

  const supA = await services.createSupplier({ name: 'Supplier A' });
  const supB = await services.createSupplier({ name: 'Supplier B' });

  const jobRow = await pool.query('SELECT job_number FROM rel_jobs WHERE id = $1', [conv.jobId]);
  const poA = await services.createPurchaseOrder({
    companyCode: '2', supplierId: supA.id, jobId: conv.jobId, jobNumberRaw: jobRow.rows[0].job_number,
    items: [{ name: 'Item from Supplier A', qtyNeeded: 3, qtyOrdered: 3, unitCost: 15.5 }],
  });
  const poB = await services.createPurchaseOrder({
    companyCode: '2', supplierId: supB.id, jobId: conv.jobId, jobNumberRaw: jobRow.rows[0].job_number,
    items: [{ name: 'Item from Supplier B', qtyNeeded: 2, qtyOrdered: 2, unitCost: 42 }],
  });

  ok(poA.poNumber !== poB.poNumber, 'two POs for the SAME job get different, unique PO-##### numbers — never one number shared across suppliers (test #13/#14)', `${poA.poNumber} vs ${poB.poNumber}`);

  const jobPOs = await pool.query('SELECT id, supplier_id, po_number FROM rel_purchase_orders WHERE job_id = $1 ORDER BY id', [conv.jobId]);
  ok(jobPOs.rowCount === 2, 'a job is NOT artificially limited to one PO — both POs are correctly linked via job_id (test #13)', String(jobPOs.rowCount));
  ok(String(jobPOs.rows[0].supplier_id) === String(supA.id) && String(jobPOs.rows[1].supplier_id) === String(supB.id), 'each PO retains its own distinct supplier link, not merged or overwritten (test #14)', JSON.stringify(jobPOs.rows));

  // Line items persist correctly (test #15) — check both the raw table and
  // the read.ts-rendered JSON (proving the supplierId-join fix also works).
  const itemsA = await pool.query('SELECT name, qty_needed, qty_ordered, unit_cost FROM rel_purchase_order_items WHERE po_id = $1', [poA.id]);
  ok(itemsA.rowCount === 1 && itemsA.rows[0].name === 'Item from Supplier A' && Number(itemsA.rows[0].qty_needed) === 3 && Number(itemsA.rows[0].unit_cost) === 15.5, 'PO line items persist correctly with the exact values supplied (test #15)', JSON.stringify(itemsA.rows));

  const rendered = await buildPurchaseOrdersJson();
  const renderedA = rendered.find((p) => p._relId === poA.id);
  const renderedB = rendered.find((p) => p._relId === poB.id);
  ok(!!renderedA && String(renderedA.supplierId) === String(supA.id), 'PO A renders with the correct supplierId via the live rel_suppliers join', renderedA && renderedA.supplierId);
  ok(!!renderedB && String(renderedB.supplierId) === String(supB.id), 'PO B renders with the correct supplierId via the live rel_suppliers join', renderedB && renderedB.supplierId);
  ok(!!renderedA && renderedA.items.length === 1 && renderedA.items[0].name === 'Item from Supplier A', 'PO A\'s rendered line items match what was created', renderedA && renderedA.items);
}

async function testStaleEditBlocked() {
  console.log('\n[PO edit] stale-version edit remains blocked (test #16)');
  await resetTables();
  const sup = await services.createSupplier({ name: 'Stale Edit Test Supplier' });
  const po = await services.createPurchaseOrder({
    companyCode: '2', supplierId: sup.id,
    items: [{ name: 'x', qtyNeeded: 1, qtyOrdered: 1, unitCost: 1 }],
  });
  const patch1 = await services.updatePurchaseOrder(po.id, po.rowVersion, { status: 'sent' });
  ok(patch1.rowVersion === po.rowVersion + 1, 'first PO edit succeeds and bumps row_version by 1');

  let staleBlocked = false;
  try {
    await services.updatePurchaseOrder(po.id, po.rowVersion /* stale — already bumped above */, { status: 'approved' });
  } catch (e) {
    staleBlocked = e instanceof services.ConcurrencyConflictError;
  }
  ok(staleBlocked, 'a stale-version PO edit is rejected via ConcurrencyConflictError, never silently applied on top of a newer value (test #16)');

  const finalRow = await pool.query('SELECT status, row_version FROM rel_purchase_orders WHERE id = $1', [po.id]);
  ok(finalRow.rows[0].status === 'sent' && finalRow.rows[0].row_version === patch1.rowVersion, 'the rejected stale edit left the PO completely unchanged — still "sent", row_version unchanged');
}

async function main() {
  console.log('[relational-po-policy-stress] Starting.');
  await testNumberFormatAndSafeStart();
  await testConcurrentUniqueness();
  await testMultiplePOsPerJobAndSuppliers();
  await testStaleEditBlocked();

  await resetTables();
  await pool.query(`UPDATE platform_state SET data = '{}'::jsonb, updated_at = NOW() WHERE id = 1`);

  console.log('\n============================================================');
  console.log(`${passed} passed, ${failures} failed`);
  console.log('============================================================');
  await pool.end();
  if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error('[relational-po-policy-stress] Fatal error:', err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
