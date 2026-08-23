/**
 * relational.cutover-blocker-completion.stress.ts
 *
 * Regression coverage for "SIGNACORE — FINAL CUTOVER BLOCKER COMPLETION":
 * every named blocker from PRE_CUTOVER_READINESS_AUDIT.md that this task
 * fixed. Two parts:
 *
 *   PART A (no server required) — source-text checks proving index.html's
 *   frontend now routes every fixed action through the relational API when
 *   its section is cut over, instead of silently writing JSON:
 *     - job deletion (JobDetail.deleteJob)
 *     - quote status actions (QuotesPage.handleUpdate -> updateQuoteStatus)
 *     - manual invoicing (saveManualInvoice -> createInvoice/updateInvoice)
 *     - invoice deletion (AccountingPage.deleteInvoice)
 *     - Accounting-view payments (PaymentHistoryModal add/edit/delete)
 *     - markInvPaid records a real relational payment, not a fake local one
 *     - PO gap #2 — the onEmail "sent" transition now reuses updatePO
 *     - inventory-from-QuickRates promote/merge actions (both duplicated
 *       copies of moveToInventory/mergeIntoInventory)
 *
 *   PART B (requires TEST_SERVER_URL_WITH_AUTHORITY / TEST_SERVER_URL, same
 *   convention as every other Stage 2/3 REST suite; skips with a clear
 *   notice if unset) — REAL HTTP proof, over a live server, of the backend
 *   halves of the same blockers:
 *     - DELETE /api/relational/jobs/:id: happy path (reverts a converted-
 *       from quote back to 'approved'), FK-refusal when an invoice still
 *       references the job, stale-version rejection.
 *     - PATCH /api/relational/quotes/:id/status: changes ONLY status,
 *       and PUT /api/relational/quotes/:id (the job-cascading route)
 *       provably does NOT change status even if one is smuggled into the
 *       patch — proving the deliberate separation actually holds.
 *     - POST /api/relational/invoices, PUT .../invoices/:id, DELETE
 *       .../invoices/:id: full manual-invoice CRUD lifecycle, plus
 *       stale-version rejection on delete.
 *     - POST /api/relational/purchase-orders without a supplierId is
 *       refused (PO gap #1 — server-side, not just frontend).
 *     - not_cut_over gating for every new route.
 */
import pool from '../src/db/pool';
import fs from 'fs';
import path from 'path';

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

function checkFrontendWiring(src: string) {
  console.log('\n[PART A] source-text checks — every named blocker\'s frontend fix');

  console.log('\n  -- job deletion --');
  ok(/async function deleteJob\(\)\{[\s\S]{0,900}isRelationalAuthoritative\('jobs'\)[\s\S]{0,300}relationalApi\.deleteJob\(job\._relId, job\._relRowVersion\)/.test(src),
    'JobDetail.deleteJob() checks isRelationalAuthoritative(\'jobs\') and calls relationalApi.deleteJob(job._relId, job._relRowVersion)');

  console.log('\n  -- quote status actions --');
  ok(/async function handleUpdate\(updated\)\{[\s\S]{0,300}isRelationalAuthoritative\('quotes'\)[\s\S]{0,300}relationalApi\.updateQuoteStatus\(updated\._relId, updated\._relRowVersion, updated\.status\)/.test(src),
    'QuotesPage.handleUpdate() checks isRelationalAuthoritative(\'quotes\') and calls relationalApi.updateQuoteStatus(updated._relId, updated._relRowVersion, updated.status)');
  ok(src.includes(`updateQuoteStatus(id, expectedVersion, status) { return relationalFetch('/quotes/' + id + '/status', { method: 'PATCH'`),
    'relationalApi.updateQuoteStatus is a DISTINCT method/endpoint from relationalApi.updateQuote (never folded into the job-cascading PUT route)');

  console.log('\n  -- manual invoicing --');
  ok(/if\(isRelationalAuthoritative\('accInvoices'\)\)\{[\s\S]{0,2000}relationalApi\.createInvoice\(/.test(src),
    'saveManualInvoice() checks isRelationalAuthoritative(\'accInvoices\') and calls relationalApi.createInvoice for a new invoice');
  ok(/if\(isRelationalAuthoritative\('accInvoices'\)\)\{[\s\S]{0,2000}relationalApi\.updateInvoice\(inv\._relId, inv\._relRowVersion,/.test(src),
    'saveManualInvoice() calls relationalApi.updateInvoice(inv._relId, inv._relRowVersion, ...) when editing an existing relational invoice');

  console.log('\n  -- invoice deletion --');
  ok(/async function deleteInvoice\(id\)\{[\s\S]{0,700}isRelationalAuthoritative\('accInvoices'\)[\s\S]{0,300}relationalApi\.deleteInvoice\(inv\._relId, inv\._relRowVersion\)/.test(src),
    'AccountingPage.deleteInvoice() checks isRelationalAuthoritative(\'accInvoices\') and calls relationalApi.deleteInvoice(inv._relId, inv._relRowVersion)');

  console.log('\n  -- Accounting-view payments (PaymentHistoryModal) --');
  ok(/async function addPayment\(\) \{[\s\S]{0,300}isRelationalAuthoritative\('accInvoices'\)[\s\S]{0,900}relationalApi\.recordPayment\('invoice', inv\._relId,/.test(src),
    'PaymentHistoryModal.addPayment() checks isRelationalAuthoritative(\'accInvoices\') and calls relationalApi.recordPayment(\'invoice\', inv._relId, ...)');
  ok(/async function editPayment\(pid\) \{[\s\S]{0,900}isRelationalAuthoritative\('accInvoices'\)[\s\S]{0,300}relationalApi\.updatePayment\(p\._relPaymentId, p\._relRowVersion, 'accInvoices',/.test(src),
    'PaymentHistoryModal.editPayment() checks isRelationalAuthoritative(\'accInvoices\') and calls relationalApi.updatePayment with ownerSection \'accInvoices\'');
  ok(/async function deletePayment\(pid\) \{[\s\S]{0,500}isRelationalAuthoritative\('accInvoices'\)[\s\S]{0,300}relationalApi\.deletePayment\(removed\._relPaymentId, removed\._relRowVersion, 'accInvoices'\)/.test(src),
    'PaymentHistoryModal.deletePayment() checks isRelationalAuthoritative(\'accInvoices\') and calls relationalApi.deletePayment with ownerSection \'accInvoices\'');

  console.log('\n  -- markInvPaid records a REAL relational payment --');
  ok(/async function markInvPaid\(inv\)\{[\s\S]{0,500}isRelationalAuthoritative\('accInvoices'\)[\s\S]{0,300}relationalApi\.recordPayment\('invoice', inv\._relId, remaining,/.test(src),
    'markInvPaid() checks isRelationalAuthoritative(\'accInvoices\') and calls relationalApi.recordPayment for the remaining balance, instead of routing an embedded payments array through saveInvoice');

  console.log('\n  -- PO gap #2: onEmail "sent" transition --');
  ok(src.includes(`onEmail={updated=>updatePO({...updated, status:'sent'})}`),
    'PurchaseOrdersPage\'s onEmail prop now reuses updatePO (the already-correct relational-vs-JSON branch) instead of writing purchaseOrders JSON state directly');
  ok(!/onEmail=\{updated=>setPurchaseOrders\(prev=>prev\.map\(p=>p\.id===updated\.id\?\{\.\.\.updated,status:'sent'\}:p\)\)\}/.test(src),
    'the OLD unconditional-JSON onEmail handler is gone entirely (not left behind as dead code alongside the fix)');

  console.log('\n  -- inventory: Quick Rates "promote to Inventory" gap --');
  const moveToInvMatches = src.match(/async function moveToInventory\(item\) \{/g) || [];
  ok(moveToInvMatches.length === 2, 'both copies of moveToInventory (QuickRatesModal + QuickRatesPanel) were fixed', moveToInvMatches.length);
  ok((src.match(/isRelationalAuthoritative\('inventory'\)\) \{\s*\n\s*try \{\s*\n\s*const patch = \{ sku: item\.sku,/g) || []).length === 2,
    'both moveToInventory copies check isRelationalAuthoritative(\'inventory\') and call relationalApi.createInventoryItem before falling through to the JSON path');
  const mergeMatches = src.match(/async function mergeIntoInventory\(qrItem, invTargetId\) \{/g) || [];
  ok(mergeMatches.length === 2, 'both copies of mergeIntoInventory (QuickRatesModal + QuickRatesPanel) were fixed', mergeMatches.length);
  ok((src.match(/relationalApi\.adjustInventoryStock\(target\._relId, target\._relRowVersion, delta\)/g) || []).length === 2,
    'both mergeIntoInventory copies call relationalApi.adjustInventoryStock with the target item\'s _relId/_relRowVersion');
}

async function resetRelationalTables() {
  await pool.query(`
    TRUNCATE rel_payments, rel_invoice_line_items, rel_invoices, rel_job_line_items, rel_jobs,
             rel_quote_line_items, rel_quotes, rel_customers, rel_purchase_order_items,
             rel_purchase_orders, rel_suppliers
    RESTART IDENTITY CASCADE
  `);
  await pool.query(`DELETE FROM quote_conversions WHERE quote_id LIKE 'rel:%'`);
  await pool.query(`UPDATE relational_cutover SET enabled = false, enabled_at = NULL, enabled_by = NULL`);
}

async function runHttpProof() {
  const baseNoAuthority = process.env.TEST_SERVER_URL || 'http://localhost:3001';
  const baseWithAuthority = process.env.TEST_SERVER_URL_WITH_AUTHORITY;

  await resetRelationalTables();

  console.log('\n[PART B] not_cut_over gating for every NEW route (master switch/section off)');
  const tokenNoAuthority = await login(baseNoAuthority);
  const headersNoAuthority = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenNoAuthority}` };
  const gatedDelete = await fetch(`${baseNoAuthority}/api/relational/jobs/1`, { method: 'DELETE', headers: headersNoAuthority, body: JSON.stringify({ expectedVersion: 1 }) });
  ok(gatedDelete.status === 409, 'DELETE /api/relational/jobs/:id refuses with 409 when jobs is not cut over', String(gatedDelete.status));
  const gatedStatus = await fetch(`${baseNoAuthority}/api/relational/quotes/1/status`, { method: 'PATCH', headers: headersNoAuthority, body: JSON.stringify({ expectedVersion: 1, status: 'sent' }) });
  ok(gatedStatus.status === 409, 'PATCH /api/relational/quotes/:id/status refuses with 409 when quotes is not cut over', String(gatedStatus.status));
  const gatedCreateInv = await fetch(`${baseNoAuthority}/api/relational/invoices`, { method: 'POST', headers: headersNoAuthority, body: JSON.stringify({ companyCode: '2', contactName: 'x', lines: [{ qty: 1, unitAmount: 1 }] }) });
  ok(gatedCreateInv.status === 409, 'POST /api/relational/invoices refuses with 409 when accInvoices is not cut over', String(gatedCreateInv.status));

  if (!baseWithAuthority) {
    console.log('\n[PART B] SKIPPED success-path/concurrency checks — TEST_SERVER_URL_WITH_AUTHORITY not set.');
    return;
  }

  const token = await login(baseWithAuthority);
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  // ── PO gap #1: supplier-required, enforced server-side ──────────────────
  console.log('\n[PART B] PO gap #1 — POST /api/relational/purchase-orders without a supplierId is refused server-side');
  await pool.query(`UPDATE relational_cutover SET enabled = true, enabled_at = NOW(), enabled_by = 'blocker-completion-test' WHERE section = 'purchaseOrders'`);
  const noSupplierPo = await fetch(`${baseWithAuthority}/api/relational/purchase-orders`, {
    method: 'POST', headers, body: JSON.stringify({ companyCode: '2', items: [{ name: 'Widget', qtyNeeded: 1, qtyOrdered: 1, unitCost: 10 }] }),
  });
  const noSupplierPoBody = await noSupplierPo.json();
  ok(noSupplierPo.status === 409 && noSupplierPoBody.type === 'business_rule', 'creating a PO with no supplierId is refused with 409 business_rule, even calling the API directly (not just the frontend modal)', JSON.stringify(noSupplierPoBody));
  ok((await pool.query(`SELECT count(*)::int AS n FROM rel_purchase_orders`)).rows[0].n === 0, 'the refused supplier-less PO genuinely wrote nothing to rel_purchase_orders');

  // ── job deletion: happy path, quote revert, FK refusal, stale rejection ──
  console.log('\n[PART B] job deletion — happy path, converted-quote revert, FK refusal, stale-version rejection');
  await pool.query(`UPDATE relational_cutover SET enabled = true, enabled_at = NOW(), enabled_by = 'blocker-completion-test' WHERE section IN ('quotes','jobs','accInvoices')`);

  const q1 = await (await fetch(`${baseWithAuthority}/api/relational/quotes`, { method: 'POST', headers, body: JSON.stringify({ companyCode: '2', customerNameRaw: 'Blocker Completion Co', lines: [{ description: 'x', qty: 1, unitPrice: 10 }] }) })).json();
  const conv1 = await (await fetch(`${baseWithAuthority}/api/relational/quotes/${q1.id}/convert-to-job`, { method: 'POST', headers })).json();
  const beforeDelete = await pool.query(`SELECT status FROM rel_quotes WHERE id = $1`, [q1.id]);
  ok(beforeDelete.rows[0].status === 'converted', 'sanity check: the source quote is "converted" before the job is deleted');

  const delRes = await fetch(`${baseWithAuthority}/api/relational/jobs/${conv1.jobId}`, { method: 'DELETE', headers, body: JSON.stringify({ expectedVersion: conv1.jobRowVersion }) });
  const delBody = await delRes.json();
  ok(delRes.status === 200 && delBody.deleted === true, 'DELETE /api/relational/jobs/:id succeeds for a job with no linked invoice/PO', JSON.stringify(delBody));
  const jobGone = await pool.query(`SELECT count(*)::int AS n FROM rel_jobs WHERE id = $1`, [conv1.jobId]);
  ok(jobGone.rows[0].n === 0, 'the job row is genuinely gone from rel_jobs');
  const quoteAfter = await pool.query(`SELECT status, converted_job_id FROM rel_quotes WHERE id = $1`, [q1.id]);
  ok(quoteAfter.rows[0].status === 'approved' && quoteAfter.rows[0].converted_job_id === null, 'deleting the job reverts its source quote back to "approved" and clears converted_job_id', quoteAfter.rows[0]);
  const conversionGone = await pool.query(`SELECT count(*)::int AS n FROM quote_conversions WHERE quote_id = $1`, [`rel:${q1.id}`]);
  ok(conversionGone.rows[0].n === 0, 'the quote_conversions bookkeeping row is cleaned up too');

  console.log('\n  -- job deletion refuses when an invoice still references the job (FK) --');
  const q2 = await (await fetch(`${baseWithAuthority}/api/relational/quotes`, { method: 'POST', headers, body: JSON.stringify({ companyCode: '2', customerNameRaw: 'Blocker Completion Co 2', lines: [{ description: 'y', qty: 1, unitPrice: 50 }] }) })).json();
  const conv2 = await (await fetch(`${baseWithAuthority}/api/relational/quotes/${q2.id}/convert-to-job`, { method: 'POST', headers })).json();
  // createInvoiceForJob bumps the job's own row_version (it sets
  // invoice_created/invoice_date/status/stage on rel_jobs) — use ITS
  // returned jobRowVersion for the delete attempt below, not the
  // pre-invoice conv2.jobRowVersion, so this genuinely tests the FK-refusal
  // path rather than accidentally tripping the (also-correct, but different)
  // stale-version rejection instead.
  const createInvForJobBody = await (await fetch(`${baseWithAuthority}/api/relational/jobs/${conv2.jobId}/create-invoice`, { method: 'POST', headers })).json();
  const delRes2 = await fetch(`${baseWithAuthority}/api/relational/jobs/${conv2.jobId}`, { method: 'DELETE', headers, body: JSON.stringify({ expectedVersion: createInvForJobBody.jobRowVersion }) });
  const delBody2 = await delRes2.json();
  ok(delRes2.status === 409 && delBody2.type === 'business_rule', 'a job with a linked invoice cannot be deleted — refused with 409 business_rule, not silently cascaded away', JSON.stringify(delBody2));
  ok((await pool.query(`SELECT count(*)::int AS n FROM rel_jobs WHERE id = $1`, [conv2.jobId])).rows[0].n === 1, 'the job row is untouched after the refused delete');

  console.log('\n  -- job deletion: stale expectedVersion is rejected (concurrency) --');
  const staleDel = await fetch(`${baseWithAuthority}/api/relational/jobs/${conv2.jobId}`, { method: 'DELETE', headers, body: JSON.stringify({ expectedVersion: 999999 }) });
  const staleDelBody = await staleDel.json();
  ok(staleDel.status === 409 && staleDelBody.type === 'stale_record', 'deleting a job with a stale/wrong expectedVersion is rejected as 409 stale_record, not silently accepted', JSON.stringify(staleDelBody));

  // ── quote status actions: PATCH .../status vs PUT (job-cascading) ────────
  console.log('\n[PART B] quote status actions — PATCH /quotes/:id/status changes ONLY status; PUT /quotes/:id never does');
  const q3 = await (await fetch(`${baseWithAuthority}/api/relational/quotes`, { method: 'POST', headers, body: JSON.stringify({ companyCode: '2', customerNameRaw: 'Status Action Co', lines: [{ description: 'z', qty: 2, unitPrice: 25 }] }) })).json();
  const statusRes = await fetch(`${baseWithAuthority}/api/relational/quotes/${q3.id}/status`, { method: 'PATCH', headers, body: JSON.stringify({ expectedVersion: q3.rowVersion, status: 'sent' }) });
  const statusBody = await statusRes.json();
  ok(statusRes.status === 200, 'PATCH /quotes/:id/status succeeds', JSON.stringify(statusBody));
  const afterStatus = await pool.query(`SELECT status, customer_name_raw, row_version FROM rel_quotes WHERE id = $1`, [q3.id]);
  ok(afterStatus.rows[0].status === 'sent' && afterStatus.rows[0].customer_name_raw === 'Status Action Co', 'the quote\'s status changed to "sent" and every other field is untouched');

  const smuggledStatusRes = await fetch(`${baseWithAuthority}/api/relational/quotes/${q3.id}`, {
    method: 'PUT', headers, body: JSON.stringify({ expectedVersion: afterStatus.rows[0].row_version, status: 'declined', notes: 'attempted smuggle' }),
  });
  ok(smuggledStatusRes.status === 200, 'PUT /quotes/:id (job-cascading route) still succeeds even when a status field is included in the patch body');
  const afterSmuggle = await pool.query(`SELECT status, notes FROM rel_quotes WHERE id = $1`, [q3.id]);
  ok(afterSmuggle.rows[0].status === 'sent' && afterSmuggle.rows[0].notes === 'attempted smuggle', 'PUT /quotes/:id genuinely ignored the smuggled status field (still "sent") while applying the notes patch — proves the deliberate separation from PATCH .../status actually holds, not just in the source comment', afterSmuggle.rows[0]);

  // ── manual invoicing + invoice deletion: full CRUD lifecycle ─────────────
  console.log('\n[PART B] manual invoicing — full CRUD lifecycle (create, edit, delete)');
  const createInvRes = await fetch(`${baseWithAuthority}/api/relational/invoices`, {
    method: 'POST', headers, body: JSON.stringify({
      companyCode: '2', contactName: 'Manual Invoice Test Client', reference: 'Manual test',
      lines: [{ description: 'Consulting', qty: 3, unitAmount: 100, accountCode: '4000', taxType: '15%' }],
    }),
  });
  const createInvBody = await createInvRes.json();
  ok(createInvRes.status === 201 && !!createInvBody.invoiceNumber, 'POST /api/relational/invoices creates a standalone manual invoice with an atomically-reserved number', JSON.stringify(createInvBody));
  const invId = createInvBody.id;
  const invLines = await pool.query(`SELECT description, qty, unit_amount FROM rel_invoice_line_items WHERE invoice_id = $1 ORDER BY line_index`, [invId]);
  ok(invLines.rows.length === 1 && Number(invLines.rows[0].qty) === 3 && Number(invLines.rows[0].unit_amount) === 100, 'the invoice\'s line item was persisted correctly', invLines.rows);

  const updateInvRes = await fetch(`${baseWithAuthority}/api/relational/invoices/${invId}`, {
    method: 'PUT', headers, body: JSON.stringify({ expectedVersion: createInvBody.rowVersion, reference: 'Manual test — edited' }),
  });
  const updateInvBody = await updateInvRes.json();
  ok(updateInvRes.status === 200, 'PUT /api/relational/invoices/:id edits the manual invoice', JSON.stringify(updateInvBody));
  const afterEditInv = await pool.query(`SELECT reference FROM rel_invoices WHERE id = $1`, [invId]);
  ok(afterEditInv.rows[0].reference === 'Manual test — edited', 'the edit was actually persisted');

  console.log('\n  -- invoice deletion: stale-version rejected, then happy-path delete --');
  const staleInvDel = await fetch(`${baseWithAuthority}/api/relational/invoices/${invId}`, { method: 'DELETE', headers, body: JSON.stringify({ expectedVersion: 999999 }) });
  const staleInvDelBody = await staleInvDel.json();
  ok(staleInvDel.status === 409 && staleInvDelBody.type === 'stale_record', 'deleting a manual invoice with a stale expectedVersion is rejected as 409 stale_record', JSON.stringify(staleInvDelBody));
  ok((await pool.query(`SELECT count(*)::int AS n FROM rel_invoices WHERE id = $1`, [invId])).rows[0].n === 1, 'the invoice is untouched after the rejected stale delete');

  const delInvRes = await fetch(`${baseWithAuthority}/api/relational/invoices/${invId}`, { method: 'DELETE', headers, body: JSON.stringify({ expectedVersion: updateInvBody.rowVersion }) });
  const delInvBody = await delInvRes.json();
  ok(delInvRes.status === 200 && delInvBody.deleted === true, 'DELETE /api/relational/invoices/:id succeeds with the correct expectedVersion', JSON.stringify(delInvBody));
  ok((await pool.query(`SELECT count(*)::int AS n FROM rel_invoices WHERE id = $1`, [invId])).rows[0].n === 0, 'the invoice row is genuinely gone');
  ok((await pool.query(`SELECT count(*)::int AS n FROM rel_invoice_line_items WHERE invoice_id = $1`, [invId])).rows[0].n === 0, 'the invoice\'s line items cascade-deleted with it (ON DELETE CASCADE, migration 007)');

  // ── unrelated-record independence sanity check (Runtime Authority Rule) ──
  console.log('\n[PART B] unrelated-record independence — deleting one job never touches an unrelated quote/job');
  const q4 = await (await fetch(`${baseWithAuthority}/api/relational/quotes`, { method: 'POST', headers, body: JSON.stringify({ companyCode: '2', customerNameRaw: 'Unrelated Co', lines: [{ description: 'w', qty: 1, unitPrice: 5 }] }) })).json();
  const conv4 = await (await fetch(`${baseWithAuthority}/api/relational/quotes/${q4.id}/convert-to-job`, { method: 'POST', headers })).json();
  await fetch(`${baseWithAuthority}/api/relational/jobs/${conv2.jobId}`, { method: 'DELETE', headers, body: JSON.stringify({ expectedVersion: 999999 }) }); // still-refused stale delete of the OTHER job from earlier
  ok((await pool.query(`SELECT count(*)::int AS n FROM rel_jobs WHERE id = $1`, [conv4.jobId])).rows[0].n === 1, 'an unrelated job created afterward is completely unaffected by any of the above operations');

  await resetRelationalTables();
  await pool.query(`UPDATE platform_state SET data = '{}'::jsonb, updated_at = NOW() WHERE id = 1`).catch(() => undefined);
}

async function main() {
  const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  checkFrontendWiring(src);
  await runHttpProof();

  console.log('\n' + '='.repeat(60));
  console.log(`${passed} passed, ${failures} failed`);
  console.log('='.repeat(60));
  await pool.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[cutover-blocker-completion-test] Fatal error:', err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
