/**
 * relational.stage3.stress.ts — STAGE 3 verification.
 *
 * Exercises every Stage 3 addition to services.ts directly against a real
 * local PostgreSQL database (no mocks), plus verifies read.ts's corrected
 * field names (the audit-confirmed jobs/quotes/inventory/creditNotes/
 * purchaseOrders mismatches) round-trip correctly end to end.
 *
 * Run with a real DATABASE_URL pointed at a local dev database — same
 * convention as relational.stress.ts.
 */
import pool from '../src/db/pool';
import * as services from '../src/relational/services';
import { buildJobsJson, buildQuotesJson, buildInventoryJson, buildCreditNotesJson, buildPurchaseOrdersJson, buildSuppliersJson } from '../src/relational/read';

let failures = 0;
let passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

async function resetStage3Tables() {
  // Clean slate for this suite only — does not touch backfilled data from
  // other suites; every table here is truncated with CASCADE so line items/
  // payments/PO items go with their parents. Never touches platform_state.
  await pool.query(`
    TRUNCATE TABLE rel_payments, rel_purchase_order_items, rel_purchase_orders,
      rel_credit_notes, rel_job_line_items, rel_jobs, rel_quote_line_items,
      rel_quotes, rel_inventory_items, rel_suppliers, rel_customers
    RESTART IDENTITY CASCADE
  `);
  await pool.query(`DELETE FROM quote_conversions`);
  await pool.query(`DELETE FROM document_number_counters`);
}

async function testJobEditing() {
  console.log('\n[Job editing] generic patch: notes/stage, cost breakdown, line items, concurrency');
  const cust = await services.createCustomer({ companyName: 'Stage3 Job Co' });
  const quote = await services.createQuote({
    companyCode: '2', customerId: cust.id, customerNameRaw: 'Stage3 Job Co',
    lines: [{ description: 'Banner', qty: 1, unitPrice: 1000 }],
  });
  const conv = await services.convertQuoteToJob(quote.id);
  const jobId = conv.jobId;

  const jobsBefore = await buildJobsJson();
  const jobBefore = jobsBefore.find((j) => j._relId === jobId);
  ok(!!jobBefore, 'job renders via read.ts right after conversion');
  ok(jobBefore.lines && Array.isArray(jobBefore.lines) && jobBefore.lines.length === 1, 'read.ts renders job line items under "lines" (not "items")', jobBefore.lines);
  ok(jobBefore.lines[0].desc === 'Banner', 'job line item uses "desc" (not "description")', jobBefore.lines[0]);
  // 2026-08-24 POST-MIGRATION STABILIZATION (BUG 2): this used to assert the
  // exact string 'From Quote SQ-00001'. convertQuoteToJob now derives the job's
  // description from the quote's own line items when it has them —
  // 'From Quote <num> - <first two line descriptions>' — which is precisely what
  // the pre-cutover JSON conversion path always produced (index.html's newJob
  // literal). The relational path was the odd one out, discarding what the
  // quote actually described in favour of a bare label. Tightened rather than
  // relaxed: it still pins the KEY (`desc`, never `description`), still pins the
  // quote-number prefix, and now ALSO pins that the line description carried
  // through — which is the field-carry regression this assertion exists to catch.
  ok(
    typeof jobBefore.desc === 'string'
      && (jobBefore as any).description === undefined
      && jobBefore.desc.startsWith('From Quote SQ-00001')
      && jobBefore.desc.includes('Banner'),
    'job top-level description key is "desc" (not "description") and carries the quote line description',
    jobBefore.desc
  );

  const patch1 = await services.updateJob(jobId, jobBefore._relRowVersion, { notes: 'Called client, confirmed spec', stage: 5 });
  ok(patch1.rowVersion === jobBefore._relRowVersion + 1, 'notes+stage edit bumps row_version by 1');

  const breakdown = { materials: 200, labour: 150, machine_time: 50, design: 0, delivery: 30, franchise_royalty: 60, subcontracting: 0, printing: 400, other: 10 };
  const patch2 = await services.updateJob(jobId, patch1.rowVersion, { breakdown });
  ok(patch2.rowVersion === patch1.rowVersion + 1, 'cost-breakdown save bumps row_version');

  const newLines = [
    { desc: 'Banner (2x3m)', qty: 1, unitPrice: 1200, unit: 'ea' },
    { desc: 'Install', qty: 2, unitPrice: 150, unit: 'hr' },
  ];
  const patch3 = await services.updateJob(jobId, patch2.rowVersion, { lines: newLines });
  ok(patch3.rowVersion === patch2.rowVersion + 1, 'line-items save (saveLines) bumps row_version');

  const jobsAfter = await buildJobsJson();
  const jobAfter = jobsAfter.find((j) => j._relId === jobId);
  ok(jobAfter.notes === 'Called client, confirmed spec', 'job notes persisted and round-trip via read.ts');
  ok(jobAfter.stage === 5, 'job stage persisted');
  ok(jobAfter.breakdown && jobAfter.breakdown.franchise_royalty === 60, 'job breakdown persisted as a whole object with the fixed 9-key shape', jobAfter.breakdown);
  ok(jobAfter.lines.length === 2 && jobAfter.lines[1].desc === 'Install' && jobAfter.lines[1].unit === 'hr', 'job lines replaced wholesale, "unit" round-trips', jobAfter.lines);

  // Concurrency: same-job stale edit -> 409; different-job edit unaffected.
  // patch2.rowVersion is now genuinely stale (patch3 bumped past it).
  let staleBlocked = false;
  try { await services.updateJob(jobId, patch2.rowVersion, { notes: 'stale write' }); }
  catch (e) { staleBlocked = e instanceof services.ConcurrencyConflictError; }
  ok(staleBlocked, 'a stale job edit (outdated row_version) is rejected as ConcurrencyConflictError', { patch2: patch2.rowVersion, patch3: patch3.rowVersion, current: jobAfter._relRowVersion });

  const quote2 = await services.createQuote({ companyCode: '2', customerId: cust.id, customerNameRaw: 'Other Co', lines: [{ description: 'x', qty: 1, unitPrice: 10 }] });
  const conv2 = await services.convertQuoteToJob(quote2.id);
  const otherJobPatch = await services.updateJob(conv2.jobId, 1, { notes: 'unrelated edit' });
  ok(!!otherJobPatch.rowVersion, 'editing an UNRELATED job while another job had a stale-conflict is completely unaffected');
}

async function testQuoteEditingAndSync() {
  console.log('\n[Quote editing + linked-job sync] cascade reproduces handleSave exactly, dual concurrency, never reverts a conversion');
  const cust = await services.createCustomer({ companyName: 'Sync Test Co' });
  const quote = await services.createQuote({
    companyCode: '1', customerId: cust.id, customerNameRaw: 'Sync Test Co',
    lines: [{ description: 'Sign', qty: 1, unitPrice: 1000 }], discountPct: 0, setupFee: 0,
  });

  // Plain (unconverted) quote edit with lines — recomputes totals server-side.
  const plainPatch = await services.updateQuote(quote.id, 1, {
    lines: [{ desc: 'Sign', qty: 2, unitPrice: 1000 }], discountPct: 10, setupFee: 50,
  });
  ok(plainPatch.rowVersion === 2, 'plain quote edit (lines+discount+setupFee) bumps row_version');
  const quotesAfterPlain = await buildQuotesJson();
  const qAfterPlain = quotesAfterPlain.find((q) => q._relId === quote.id);
  // subtotal=2000, discAmt=200, afterDisc=2000-200+50=1850, vat=277.5, total=2127.5
  ok(Math.abs(qAfterPlain.subtotal - 2000) < 0.01, 'recomputed subtotal matches CreateQuoteModal formula', qAfterPlain.subtotal);
  ok(Math.abs(qAfterPlain.total - 2127.5) < 0.01, 'recomputed total matches the exact discount/setupFee/vat formula', qAfterPlain.total);
  ok(qAfterPlain.discount === 10, 'quote top-level field is "discount" (not "discountPct")');
  ok(qAfterPlain.lines[0].desc === 'Sign' && qAfterPlain.lines[0].qty === 2, 'quote lines use "desc", replaced wholesale');

  // Now convert, then edit again — this time the cascade must reach the job.
  // NOTE: convertQuoteToJob itself bumps the quote's row_version by 1 (it
  // sets status='converted' + converted_job_id) — so the version right
  // after conversion is plainPatch.rowVersion + 1, not plainPatch.rowVersion.
  const conv = await services.convertQuoteToJob(quote.id);
  const jobId = conv.jobId;
  const quoteVersionAfterConvert = plainPatch.rowVersion + 1;

  const syncPatch = await services.updateQuoteWithJobSync(quote.id, quoteVersionAfterConvert, {
    contactPerson: 'Jane Doe', email: 'jane@test.com', phone: '0821234567',
    address: '1 Main Rd', vatNumber: 'VAT123', notes: 'Rush job',
    lines: [{ desc: 'Sign (rush)', qty: 3, unitPrice: 1000 }], discountPct: 5, setupFee: 0,
  });
  ok(String(syncPatch.jobId) === String(jobId), 'sync result correctly identifies the linked job', { syncPatchJobId: syncPatch.jobId, jobId });
  ok(!!syncPatch.jobRowVersion, 'linked job row_version bumped by the cascade');

  const jobsAfterSync = await buildJobsJson();
  const jobAfterSync = jobsAfterSync.find((j) => j._relId === jobId);
  ok(jobAfterSync.contact === 'Jane Doe', 'cascade copied contact onto the job under the correct key "contact"');
  ok(jobAfterSync.tel === '0821234567', 'cascade copied phone onto the job under the correct key "tel"');
  ok(jobAfterSync.vatNum === 'VAT123', 'cascade copied vat number onto the job under the correct key "vatNum"');
  ok(jobAfterSync.notes === 'Rush job', 'cascade overwrote job notes with the quote\'s (truthy) notes, matching q.notes||j.notes||\'\'');
  ok(jobAfterSync.lines.length === 1 && jobAfterSync.lines[0].qty === 3, 'cascade replaced the job\'s lines with the quote\'s new lines');
  // subtotal=3000, disc 5% = 150, afterDisc=2850, *1.15 = 3277.5
  ok(Math.abs(jobAfterSync.value - 3277.5) < 0.01, 'cascade recomputed job.value = afterDisc*1.15 from the quote\'s NEW totals', jobAfterSync.value);

  // Quote's own status/convertedJobId must never be revertible through this path.
  const quotesAfterSync = await buildQuotesJson();
  const qAfterSync = quotesAfterSync.find((q) => q._relId === quote.id);
  ok(qAfterSync.status === 'converted' && String(qAfterSync.convertedJobId) === String(jobId), 'quote status/convertedJobId untouched by the edit-with-sync path (never revertible via a plain edit)', { convertedJobId: qAfterSync.convertedJobId, jobId });

  // Dual concurrency: stale EXPECTED JOB VERSION on an edit-with-sync call is
  // rejected. The quote's version here (quoteVersionAfterConvert + 1, after
  // syncPatch's own bump) is the CORRECT current one — only the job's
  // asserted version (1) is stale (the cascade already bumped it to 2).
  const quoteVersionAfterSync = quoteVersionAfterConvert + 1;
  let jobStaleBlocked = false;
  try {
    await services.updateQuoteWithJobSync(quote.id, quoteVersionAfterSync, { notes: 'another edit' }, { expectedJobVersion: 1 /* stale — actual is 2 */ });
  } catch (e) { jobStaleBlocked = e instanceof services.ConcurrencyConflictError; }
  ok(jobStaleBlocked, 'a stale expectedJobVersion on the linked job is rejected — never blindly overwrites a newer job');

  // Stale QUOTE version is also rejected (and must not have touched the job).
  let quoteStaleBlocked = false;
  try { await services.updateQuoteWithJobSync(quote.id, 1 /* stale, actual is quoteVersionAfterSync */, { notes: 'stale quote edit' }); }
  catch (e) { quoteStaleBlocked = e instanceof services.ConcurrencyConflictError; }
  ok(quoteStaleBlocked, 'a stale quote row_version on the sync path is rejected before touching the job at all');
}

// 2026-08-21 PURCHASE ORDER MIGRATION POLICY CHANGE: this test used to also
// prove automatic low-stock PO generation during quote->job conversion —
// that business rule has been REMOVED (see services.ts's convertQuoteToJob
// header comment). Rewritten (not deleted) to prove the NEW rule instead:
// inventory deduction still works exactly as before, but conversion NEVER
// creates a PO under any circumstance, including when stock ends up low —
// purchasing is now always a separate, manual, optional decision (tests
// #6/#7/#8 from the migration policy brief).
async function testConversionInventoryNoAutoPO() {
  console.log('\n[Quote->Job conversion] inventory deduction (floor at 0) still works — automatic PO generation has been REMOVED');
  const supplierResult = await services.createSupplier({ name: 'Acme Supplies', email: 'sales@acme.test' });
  const invResult = await pool.query(
    `WITH new_id AS (SELECT nextval('rel_inventory_items_id_seq') AS id)
     INSERT INTO rel_inventory_items (id, source_id, name, unit, cost, sell, stock_qty, reorder_level, supplier_id, legacy_data)
     SELECT new_id.id, new_id.id::text, 'Vinyl Roll', 'm', 20, 40, 12, 10, $1, '{}'::jsonb FROM new_id
     RETURNING id`,
    [supplierResult.id]
  );
  const invItemId = invResult.rows[0].id;

  const cust = await services.createCustomer({ companyName: 'Inventory Test Co' });
  const quote = await services.createQuote({
    companyCode: '2', customerId: cust.id, customerNameRaw: 'Inventory Test Co',
    lines: [{ description: 'Vinyl Roll', qty: 5, unitPrice: 40, inventoryItemId: invItemId }],
  });

  const poCountBefore = (await pool.query('SELECT count(*)::int AS n FROM rel_purchase_orders')).rows[0].n;

  const conv = await services.convertQuoteToJob(quote.id);
  ok(conv.inventoryAdjustments.length === 1, 'exactly one inventory item was adjusted (test #7)');
  ok(conv.inventoryAdjustments[0].consumed === 5, 'consumed quantity matches the quote line qty');
  ok(conv.inventoryAdjustments[0].newStock === 7, 'stock correctly deducted (12 - 5 = 7)');
  ok(!('autoPurchaseOrders' in conv) && !('poReservationFailures' in conv), 'convertQuoteToJob\'s return value no longer carries autoPurchaseOrders/poReservationFailures at all — the feature is fully removed, not just empty', JSON.stringify(conv));

  const invAfter = await buildInventoryJson();
  const itemAfter = invAfter.find((i) => i._relId === invItemId);
  ok(itemAfter.stock === 7, 'read.ts renders inventory stock under the key "stock" (not "stockQty")', itemAfter.stock);
  ok(itemAfter.reorder === 10, 'read.ts renders reorder level under the key "reorder" (not "reorderLevel")', itemAfter.reorder);

  // 7 <= reorder(10) -> stock IS low -> under the OLD rule this would have
  // auto-generated a PO. Under the new rule, it must NOT (tests #6/#8).
  const poCountAfter = (await pool.query('SELECT count(*)::int AS n FROM rel_purchase_orders')).rows[0].n;
  ok(poCountAfter === poCountBefore, 'stock ended up low (7 <= reorder 10) but ZERO purchase orders were created — automatic PO generation is gone (test #6/#8)', `before=${poCountBefore} after=${poCountAfter}`);

  // Floor-at-zero: deduct more than available stock — also still low, also
  // still must not auto-create a PO.
  const invResult2 = await pool.query(
    `WITH new_id AS (SELECT nextval('rel_inventory_items_id_seq') AS id)
     INSERT INTO rel_inventory_items (id, source_id, name, unit, cost, sell, stock_qty, reorder_level, legacy_data)
     SELECT new_id.id, new_id.id::text, 'Scarce Widget', 'ea', 5, 10, 3, 2, '{}'::jsonb FROM new_id
     RETURNING id`
  );
  const scarceId = invResult2.rows[0].id;
  const quote2 = await services.createQuote({
    companyCode: '2', customerId: cust.id, customerNameRaw: 'Inventory Test Co',
    lines: [{ description: 'Scarce Widget', qty: 100, unitPrice: 10, inventoryItemId: scarceId }],
  });
  const conv2 = await services.convertQuoteToJob(quote2.id);
  ok(conv2.inventoryAdjustments[0].newStock === 0, 'stock is floored at 0, never goes negative, when consumption exceeds available stock', conv2.inventoryAdjustments[0]);
  const poCountAfter2 = (await pool.query('SELECT count(*)::int AS n FROM rel_purchase_orders')).rows[0].n;
  ok(poCountAfter2 === poCountBefore, 'even a severely-understocked item (floored at 0) does not auto-create a PO — low stock is informational only now, purchasing is manual', `before=${poCountBefore} after=${poCountAfter2}`);

  // The manual workflow remains fully available: a user CAN create a PO
  // for the resulting job afterward, referencing the exact job that was
  // just converted, with a real atomically-reserved PO-##### number.
  const jobRes = await pool.query('SELECT job_number FROM rel_jobs WHERE id = $1', [conv.jobId]);
  const manualPo = await services.createPurchaseOrder({
    companyCode: '2', supplierId: supplierResult.id, jobId: conv.jobId, jobNumberRaw: jobRes.rows[0].job_number,
    notes: 'user-initiated manual PO after conversion',
    items: [{ inventoryItemId: invItemId, name: 'Vinyl Roll', unit: 'm', qtyNeeded: 20, qtyOrdered: 20, unitCost: 20 }],
  });
  ok(/^PO-\d{5}$/.test(manualPo.poNumber), 'a manual PO can still be created for the job afterward, with a real PO-##### number (test #9)', manualPo.poNumber);
  const posAfter = await buildPurchaseOrdersJson();
  const poAfter = posAfter.find((p) => p._relId === manualPo.id);
  ok(!!poAfter, 'the manually-created PO renders via read.ts');
  ok(String(poAfter.supplierId) === String(supplierResult.id), 'the manual PO\'s supplierId resolves correctly via the live rel_suppliers join (not just backfill-only supplier_source_id)', { got: poAfter.supplierId, expected: supplierResult.id });
  ok(poAfter.items.length === 1 && String(poAfter.items[0].inventoryId) === String(invItemId), 'PO item uses the key "inventoryId" (not "inventoryItemId")', poAfter.items[0]);
}

async function testPaymentLifecycle() {
  console.log('\n[Payment lifecycle] edit, delete/reversal, Credit-method create+release, refuses partial credit funding');
  const cust = await services.createCustomer({ companyName: 'Credit Test Co' });
  const quote = await services.createQuote({ companyCode: '1', customerId: cust.id, customerNameRaw: 'Credit Test Co', lines: [{ description: 'x', qty: 1, unitPrice: 500 }] });
  const conv = await services.convertQuoteToJob(quote.id);
  const jobId = conv.jobId;
  // Force the job's customer_name_raw to a known value for credit-note contact matching.
  await pool.query(`UPDATE rel_jobs SET customer_name_raw = 'Credit Test Co' WHERE id = $1`, [jobId]);

  const eft = await services.recordPayment({ type: 'job', id: jobId }, 100, { method: 'EFT', reference: 'EFT-1' });
  ok(!!eft.paymentId, 'a plain EFT payment is recorded');

  const editRes = await services.updatePayment(eft.paymentId, 1, { amount: 120, notes: 'corrected amount' });
  ok(editRes.rowVersion === 2, 'editing a non-Credit payment succeeds and bumps row_version');

  const cn = await services.createCreditNote({ companyCode: '2', type: 'customer', contactName: 'Credit Test Co', amount: 300, reason: 'Overpayment refund credit' });
  ok(/^CN-\d{4}$/.test(cn.creditNumber), 'credit note gets an atomically-reserved CN-#### number (4 digits, matching nextCnNum\'s real format)', cn.creditNumber);

  const creditPay = await services.recordPayment({ type: 'job', id: jobId }, 200, { method: 'Credit' });
  ok(creditPay.creditApplied === 200, 'Credit payment consumes exactly the requested amount from the matching credit note');

  const cnAfter = (await buildCreditNotesJson()).find((c) => c._relId === cn.id);
  ok(cnAfter.used === 200, 'credit note "used" field (not "usedAmount") reflects the consumption', cnAfter.used);
  ok(cnAfter.contactName === 'Credit Test Co', 'credit note top-level field is "contactName" (not "client")');

  let editCreditBlocked = false;
  try { await services.updatePayment(creditPay.paymentId, 1, { amount: 250 }); }
  catch (e) { editCreditBlocked = e instanceof services.BusinessRuleError; }
  ok(editCreditBlocked, 'a Credit-funded payment cannot be edited (matches "Credit-funded payments can\'t be edited")');

  let overCreditBlocked = false;
  try { await services.recordPayment({ type: 'job', id: jobId }, 1000, { method: 'Credit' }); }
  catch (e) { overCreditBlocked = e instanceof services.BusinessRuleError; }
  ok(overCreditBlocked, 'a Credit payment exceeding available credit is refused outright (never partially funded)');

  // MIGRATION CLOSURE Item 1: deletePayment now requires expectedVersion —
  // creditPay was never edited, so its row_version is still the one
  // recordPayment returned; eft WAS edited above (editRes), so its current
  // row_version is editRes.rowVersion, not the original 1.
  const deleteRes = await services.deletePayment(creditPay.paymentId, creditPay.rowVersion);
  ok(deleteRes.creditReleased === 200, 'deleting a Credit-funded payment releases its full usage back to the credit note');
  const cnAfterDelete = (await buildCreditNotesJson()).find((c) => c._relId === cn.id);
  ok(cnAfterDelete.used === 0, 'credit note usage correctly released back to 0 after the funding payment is deleted');

  const deleteEft = await services.deletePayment(eft.paymentId, editRes.rowVersion);
  ok(deleteEft.deleted === true && deleteEft.creditReleased === 0, 'deleting a non-Credit payment is a true physical removal with no credit-note side effect');
}

async function testCreditNoteAndPOAndSupplierCrud() {
  console.log('\n[Credit notes / purchase orders / suppliers / inventory] CRUD, concurrency, atomic numbering');
  const cn = await services.createCreditNote({ companyCode: '2', type: 'customer', contactName: 'CRUD Test Co', amount: 100, reason: 'test' });
  const cnPatch = await services.updateCreditNote(cn.id, cn.rowVersion, { reason: 'updated reason' });
  ok(cnPatch.rowVersion === cn.rowVersion + 1, 'credit note edit bumps row_version');
  let deleteUsedBlocked = false;
  await pool.query(`UPDATE rel_credit_notes SET used_amount = 50 WHERE id = $1`, [cn.id]);
  try { await services.deleteCreditNote(cn.id, cnPatch.rowVersion); } catch (e) { deleteUsedBlocked = e instanceof services.BusinessRuleError; }
  ok(deleteUsedBlocked, 'deleting a partially-used credit note is refused (deliberate Stage 3 safety addition)');
  await pool.query(`UPDATE rel_credit_notes SET used_amount = 0 WHERE id = $1`, [cn.id]);
  const cnDelete = await services.deleteCreditNote(cn.id, cnPatch.rowVersion);
  ok(cnDelete.deleted === true, 'an unused credit note can be deleted');

  const sup = await services.createSupplier({ name: 'CRUD Supplier', address: '5 Long St', vatNumber: 'VAT999' });
  const supAfter = (await buildSuppliersJson()).find((s) => s._relId === sup.id);
  ok(supAfter.address === '5 Long St' && supAfter.vatNumber === 'VAT999', 'supplier address/vatNumber (migration 008 columns) round-trip via read.ts', supAfter);
  const supPatch = await services.updateSupplier(sup.id, sup.rowVersion, { city: 'Cape Town' });
  ok(supPatch.rowVersion === sup.rowVersion + 1, 'supplier edit bumps row_version');

  const po = await services.createPurchaseOrder({
    companyCode: '2', supplierId: sup.id, notes: 'manual PO',
    items: [{ name: 'Widget', qtyNeeded: 10, qtyOrdered: 10, unitCost: 5 }],
  });
  ok(/^PO-\d{5}$/.test(po.poNumber), 'manually-created PO gets a real atomic PO-##### number (5 digits, standard format)', po.poNumber);
  const poPatch = await services.updatePurchaseOrder(po.id, po.rowVersion, { status: 'sent' });
  ok(poPatch.rowVersion === po.rowVersion + 1, 'PO status update bumps row_version (no items param exists — matches PODetailModal never editing items post-creation)');

  const item = await services.createInventoryItem({ name: 'Adjustable Widget', stock: 50, reorder: 10 });
  const adj = await services.adjustInventoryStock(item.id, item.rowVersion, -20);
  ok(adj.newStock === 30, 'concurrency-safe stock delta adjustment computes server-side, not from a client-supplied absolute value');
  let staleAdjBlocked = false;
  try { await services.adjustInventoryStock(item.id, item.rowVersion /* stale */, -5); }
  catch (e) { staleAdjBlocked = e instanceof services.ConcurrencyConflictError; }
  ok(staleAdjBlocked, 'a stale-version stock adjustment is rejected, never silently applied on top of a newer value');
  const floorAdj = await services.adjustInventoryStock(item.id, adj.rowVersion, -1000);
  ok(floorAdj.newStock === 0, 'stock adjustment is floored at 0 via GREATEST(0, ...), never goes negative');
}

async function main() {
  console.log('[relational-stage3-stress] Starting.');
  await resetStage3Tables();
  await testJobEditing();
  await testQuoteEditingAndSync();
  await testConversionInventoryNoAutoPO();
  await testPaymentLifecycle();
  await testCreditNoteAndPOAndSupplierCrud();

  console.log('\n============================================================');
  console.log(`${passed} passed, ${failures} failed`);
  console.log('============================================================');
  await pool.end();
  if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error('[relational-stage3-stress] Fatal error:', err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
