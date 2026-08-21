/**
 * relational.full-lifecycle.stress.ts — STAGE 3 Phase 15: the complete
 * cutover-ready lifecycle, end to end, over real HTTP, exactly as the
 * WIRED FRONTEND now calls each step (not just the service layer in
 * isolation — every other Stage 2/3 suite already covers that).
 *
 *   SUPPLIER -> INVENTORY -> QUOTE (with an inventory-linked line) ->
 *   CONVERT TO JOB (inventory dedux + auto-PO) -> CREATE INVOICE ->
 *   PARTIAL PAYMENT (EFT) -> CREDIT NOTE -> CREDIT-METHOD PAYMENT (paid in
 *   full) -> EDIT a payment -> DELETE a payment -> APPROVE the auto-PO ->
 *   POST-CUTOVER INTEGRITY CHECK across every section touched.
 *
 * This is the integration proof: every individual step here already has
 * its own dedicated unit-level test elsewhere in this suite (frontend
 * wiring source-checks, isolated service-layer HTTP calls). What this file
 * adds is proof that they compose correctly as ONE continuous flow with
 * no cross-phase surprises — in particular:
 *   - the createQuote line-mapping bugfix (description/inventoryItemId,
 *     not desc/itemId) is what makes inventory dedup on conversion
 *     possible at all — a quote line with no inventory_item_id can never
 *     deduct stock or trigger an auto-PO, so this test would have quietly
 *     "passed" with zero inventory/PO side effects before that fix.
 *   - recomputeOwnerPaymentStatus (Phase 4) keeps the job's invoice_status
 *     correct across a MIX of EFT and Credit payments, plus an edit and a
 *     delete, not just one payment method in isolation.
 *   - runPostCutoverIntegrityCheck (Phase 11) is run at the END against
 *     every section this lifecycle actually touched, proving the whole
 *     chain leaves the database in a self-consistent state.
 *
 * Requires TEST_SERVER_URL_WITH_AUTHORITY — this entire file is one
 * integration proof, so unlike other suites it does not degrade to a
 * source-only check when unset; it simply cannot run without a live server.
 */
import fs from 'fs';
import pool from '../src/db/pool';
import { runPostCutoverIntegrityCheck } from '../src/relational/reconcile';

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

const ALL_SECTIONS = ['suppliers', 'inventory', 'quotes', 'jobs', 'purchaseOrders', 'accInvoices', 'creditNotes'];

async function resetAll() {
  await pool.query(`
    TRUNCATE rel_payments, rel_invoice_line_items, rel_invoices, rel_purchase_order_items, rel_purchase_orders,
             rel_job_line_items, rel_jobs, rel_quote_line_items, rel_quotes, rel_credit_notes,
             rel_inventory_items, rel_suppliers
    RESTART IDENTITY CASCADE
  `);
  await pool.query(`DELETE FROM quote_conversions`);
  await pool.query(`DELETE FROM document_number_counters`);
  await pool.query(`UPDATE relational_cutover SET enabled = false, enabled_at = NULL, enabled_by = NULL`);
  await pool.query(`UPDATE platform_state SET data = '{}'::jsonb, updated_at = NOW() WHERE id = 1`);
}

async function main() {
  const base = process.env.TEST_SERVER_URL_WITH_AUTHORITY;
  if (!base) {
    console.log('[Full lifecycle] SKIPPED — TEST_SERVER_URL_WITH_AUTHORITY not set. This integration test requires a live server; see other suites\' runner instructions for the server-start command.');
    await pool.end();
    process.exit(0);
  }

  await resetAll();
  await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section = ANY($1)`, [ALL_SECTIONS]);

  const token = await login(base);
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  console.log('\n[Full lifecycle] STEP 1 — create a supplier (exactly what SuppliersPage.saveSup sends)');
  const supRes = await fetch(`${base}/api/relational/suppliers`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: 'Lifecycle Test Supplier', contactPerson: 'Sam', phone: '0211111111', email: 'sam@example.com', address: '', city: '', postalCode: '', vatNumber: '', accountNumber: '', notes: '', paymentTerms: '30 days' }),
  });
  const sup: any = await supRes.json();
  ok(supRes.status === 201, 'supplier created', sup);

  console.log('\n[Full lifecycle] STEP 2 — create an inventory item, stock low enough that consuming 15 units triggers a reorder (reorder=10, stock=20)');
  const invRes = await fetch(`${base}/api/relational/inventory`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ sku: 'LC-VINYL-1', name: 'Lifecycle Test Vinyl', category: 'Vinyl', unit: 'sqm', cost: 15, sell: 30, stock: 20, reorder: 10, supplierId: sup.id }),
  });
  const inv: any = await invRes.json();
  ok(invRes.status === 201, 'inventory item created', inv);

  console.log('\n[Full lifecycle] STEP 3 — create a quote with an inventory-linked line (exactly what the FIXED CreateQuoteModal.submit now sends — description/inventoryItemId, not desc/itemId)');
  const quoteRes = await fetch(`${base}/api/relational/quotes`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      companyCode: '2', customerNameRaw: 'Lifecycle Test Customer',
      lines: [{ description: 'Vinyl banner 15sqm', qty: 15, unitPrice: 100, inventoryItemId: inv.id }],
      discountPct: 0, setupFee: 0, notes: '',
    }),
  });
  const quote: any = await quoteRes.json();
  ok(quoteRes.status === 201 && /^SQ-/i.test(quote.quoteNumber || ''), 'quote created with a real SQ-##### number', quote);
  const quoteLine = await pool.query(`SELECT description, inventory_item_id FROM rel_quote_line_items WHERE quote_id = $1`, [quote.id]);
  ok(quoteLine.rows[0].description === 'Vinyl banner 15sqm', 'the BUGFIX: quote line description landed correctly (was silently NULL before the fix)', quoteLine.rows[0]);
  ok(Number(quoteLine.rows[0].inventory_item_id) === Number(inv.id), 'the BUGFIX: the quote line\'s inventory_item_id landed correctly (was silently NULL before the fix, breaking dedup below entirely)', quoteLine.rows[0]);

  console.log('\n[Full lifecycle] STEP 4 — convert the quote to a job (exactly what handleConvertToJob sends) — proves inventory dedup + auto-PO now actually fire, because inventory_item_id is set');
  const convertRes = await fetch(`${base}/api/relational/quotes/${quote.id}/convert-to-job`, { method: 'POST', headers: H });
  const conv: any = await convertRes.json();
  ok(convertRes.status === 201 && /^SNS-/i.test(conv.jobNumber || ''), 'job created with a real SNS-##### number', conv);
  const invAfterConvert = await pool.query(`SELECT stock_qty FROM rel_inventory_items WHERE id = $1`, [inv.id]);
  ok(Number(invAfterConvert.rows[0].stock_qty) === 5, 'inventory was correctly deducted (20 - 15 = 5) — this ONLY works because the quote line carried a real inventory_item_id', invAfterConvert.rows[0]);
  const autoPO = await pool.query(`SELECT id, po_number FROM rel_purchase_orders WHERE supplier_id = $1`, [sup.id]);
  ok(autoPO.rowCount === 1 && /^PO-/i.test(autoPO.rows[0].po_number || ''), 'an auto-PO was correctly generated for the now-low-stock item (5 <= reorder level 10)', autoPO.rows);

  console.log('\n[Full lifecycle] STEP 5 — edit the job (exactly what JobDetail.saveNotes sends)');
  const jobEditRes = await fetch(`${base}/api/relational/jobs/${conv.jobId}`, {
    method: 'PUT', headers: H,
    body: JSON.stringify({ expectedVersion: conv.jobRowVersion, notes: 'Edited via full-lifecycle test' }),
  });
  const jobEdit: any = await jobEditRes.json();
  ok(jobEditRes.status === 200, 'job edit succeeded', jobEdit);

  console.log('\n[Full lifecycle] STEP 6 — create the invoice for the job (exactly what createInvoiceNow sends)');
  const invoiceRes = await fetch(`${base}/api/relational/jobs/${conv.jobId}/create-invoice`, { method: 'POST', headers: H });
  const invoice: any = await invoiceRes.json();
  ok(invoiceRes.status === 201 && /^INV-/i.test(invoice.invoiceNumber || ''), 'invoice created with a real INV-##### number', invoice);

  const jobValueRow = await pool.query(`SELECT value FROM rel_jobs WHERE id = $1`, [conv.jobId]);
  const jobValue = Number(jobValueRow.rows[0].value); // 15 * 100 * 1.15 = 1725

  console.log('\n[Full lifecycle] STEP 7 — record a partial EFT payment (exactly what JobPaymentsModal.addPayment sends)');
  const halfAmount = Math.round((jobValue / 2) * 100) / 100;
  const pay1Res = await fetch(`${base}/api/relational/payments`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ ownerType: 'job', ownerId: conv.jobId, amount: halfAmount, date: '2026-08-21', method: 'EFT', notes: 'deposit' }),
  });
  const pay1: any = await pay1Res.json();
  ok(pay1Res.status === 201, 'partial EFT payment recorded', pay1);
  let jobStatus = await pool.query(`SELECT invoice_status FROM rel_jobs WHERE id = $1`, [conv.jobId]);
  ok(jobStatus.rows[0].invoice_status === 'partial', 'invoice_status correctly reflects "partial" after the EFT deposit (recomputeOwnerPaymentStatus)', jobStatus.rows[0]);

  console.log('\n[Full lifecycle] STEP 8 — create a credit note for the same customer (exactly what saveCreditNote sends)');
  const cnAmount = jobValue - halfAmount + 50; // more than enough to cover the remainder
  const cnRes = await fetch(`${base}/api/relational/credit-notes`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ type: 'customer', contactName: 'Lifecycle Test Customer', date: '2026-08-21', amount: cnAmount, reason: 'Overpayment', appliedTo: '', notes: '', status: 'open' }),
  });
  const cn: any = await cnRes.json();
  ok(cnRes.status === 201 && /^CN-/i.test(cn.creditNumber || ''), 'credit note created with a real CN-##### number', cn);

  console.log('\n[Full lifecycle] STEP 9 — pay the remainder with a Credit-method payment (exactly what addPayment now sends for Credit, per Phase 4) — brings the job to fully paid');
  const remainder = Math.round((jobValue - halfAmount) * 100) / 100;
  const pay2Res = await fetch(`${base}/api/relational/payments`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ ownerType: 'job', ownerId: conv.jobId, amount: remainder, date: '2026-08-21', method: 'Credit' }),
  });
  const pay2: any = await pay2Res.json();
  ok(pay2Res.status === 201 && Math.abs(Number(pay2.creditApplied) - remainder) < 0.01, 'Credit-method payment recorded and correctly applied against the credit note', pay2);
  jobStatus = await pool.query(`SELECT invoice_status FROM rel_jobs WHERE id = $1`, [conv.jobId]);
  ok(jobStatus.rows[0].invoice_status === 'paid', 'invoice_status correctly reached "paid" once EFT + Credit together cover the full job value', jobStatus.rows[0]);

  console.log('\n[Full lifecycle] STEP 10 — edit the EFT payment\'s amount down (exactly what editPayment sends) — invoice_status correctly reverts to "partial"');
  const editPayRes = await fetch(`${base}/api/relational/payments/${pay1.paymentId}`, {
    method: 'PUT', headers: H,
    body: JSON.stringify({ expectedVersion: pay1.rowVersion, ownerSection: 'jobs', amount: halfAmount - 100 }),
  });
  ok(editPayRes.status === 200, 'EFT payment edit succeeded', await editPayRes.json());
  jobStatus = await pool.query(`SELECT invoice_status FROM rel_jobs WHERE id = $1`, [conv.jobId]);
  ok(jobStatus.rows[0].invoice_status === 'partial', 'invoice_status correctly reverted to "partial" after reducing the EFT payment', jobStatus.rows[0]);

  console.log('\n[Full lifecycle] STEP 11 — delete the Credit-funded payment (exactly what deletePayment sends) — releases credit usage and drops status to "partial"/"pending"');
  const delPayRes = await fetch(`${base}/api/relational/payments/${pay2.paymentId}`, {
    method: 'DELETE', headers: H, body: JSON.stringify({ expectedVersion: pay2.rowVersion, ownerSection: 'jobs' }),
  });
  ok(delPayRes.status === 200, 'Credit payment delete succeeded', await delPayRes.text().catch(() => ''));
  const cnAfter = await pool.query(`SELECT used_amount FROM rel_credit_notes WHERE id = $1`, [cn.id]);
  ok(Number(cnAfter.rows[0].used_amount) === 0, 'the credit note\'s used_amount was correctly released back to 0');

  console.log('\n[Full lifecycle] STEP 12 — approve the auto-generated PO (exactly what updatePO/handleApproveEmail sends)');
  const poRow = await pool.query(`SELECT id, row_version FROM rel_purchase_orders WHERE id = $1`, [autoPO.rows[0].id]);
  const poApproveRes = await fetch(`${base}/api/relational/purchase-orders/${poRow.rows[0].id}`, {
    method: 'PUT', headers: H,
    body: JSON.stringify({ expectedVersion: poRow.rows[0].row_version, supplierId: sup.id, status: 'approved', notes: 'Approved via full-lifecycle test' }),
  });
  ok(poApproveRes.status === 200, 'PO approval succeeded', await poApproveRes.json());

  console.log('\n[Full lifecycle] STEP 13 — post-cutover integrity check across every documented section this lifecycle touched');
  const report = await runPostCutoverIntegrityCheck();
  // runPostCutoverIntegrityCheck reports the 5 document-numbered
  // collections (quotes/jobs/accInvoices/purchaseOrders/creditNotes) plus
  // a "payments" orphaned-owner-reference check — suppliers and inventory
  // have no document-number scheme and never appear here; that is correct,
  // not a gap in this test.
  const expectedCollections = ['quotes', 'jobs', 'accInvoices', 'purchaseOrders', 'creditNotes', 'payments'];
  ok(expectedCollections.every(c => report.sections.some(s => s.collection === c)), 'the report covers every expected collection', report.sections.map(s => s.collection));
  for (const s of report.sections) {
    ok(s.integrityOk, `post-cutover integrity OK for "${s.collection}"`, s);
  }
  ok(report.overallOk, 'overall post-cutover integrity check passes after the full 13-step lifecycle', report.sections.filter(s => !s.integrityOk));

  fs.writeFileSync('/tmp/full-lifecycle-report.json', JSON.stringify({ passed, failures, report }, null, 2));

  await resetAll();

  console.log('\n' + '='.repeat(60));
  console.log(`${passed} passed, ${failures} failed`);
  console.log('='.repeat(60));
  await pool.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[full-lifecycle-test] Fatal error:', err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
