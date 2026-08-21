/**
 * relational.frontend-payment-wiring.test.ts — STAGE 3 Phase 4 verification
 * (frontend payment lifecycle wiring: JobPaymentsModal's addPayment now
 * covers every method including Credit, plus the new editPayment/
 * deletePayment relational wiring), AND the new
 * recomputeOwnerPaymentStatus service-layer fix it depends on.
 *
 * Three parts:
 *   1. Source-text checks that JobPaymentsModal's addPayment/editPayment/
 *      deletePayment all route through relationalApi when the owning
 *      section is cut over and (for edit/delete) the payment is a genuine
 *      relational row (_relPaymentId set), using ._relId/._relPaymentId/
 *      ._relRowVersion — never a bare .id.
 *   2. A REAL end-to-end proof, over real HTTP, of the NEW
 *      recomputeOwnerPaymentStatus fix: before this fix,
 *      recordPayment/updatePayment/deletePayment left rel_jobs.invoice_status
 *      untouched forever — a job could be paid in full and still read as
 *      "pending". This proves invoice_status now correctly reaches 'paid'
 *      on full payment, 'partial' on partial payment, and reverts
 *      correctly on delete/edit.
 *   3. A REAL end-to-end proof that a Credit-method payment (previously
 *      JSON-only from the frontend's point of view) can now be recorded,
 *      edited-refused, and deleted through the relational REST API,
 *      including the credit-note usage side effect and the 409
 *      cutover_dependency block when "creditNotes" is not cut over.
 *
 * Requires TEST_SERVER_URL_WITH_AUTHORITY — skips part 2/3 with a clear
 * notice if unset, same convention as every other Stage 2/3 REST suite.
 */
import fs from 'fs';
import path from 'path';
import pool from '../src/db/pool';
import { runBackfill } from '../src/relational/backfill';

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
  console.log('\n[Frontend payment wiring] source-text checks — JobPaymentsModal addPayment/editPayment/deletePayment');

  ok(src.includes(`if(isRelationalAuthoritative(relSection)){`) && src.includes(`if(method==='Credit' && amt > availableCredit + 0.005){`),
    'addPayment now covers EVERY method (including Credit) in its relational branch, not just non-Credit');
  ok(src.includes(`const result = await relationalApi.recordPayment(ownerType, ownerId, amt, { date, method, notes: notes.trim() });`) &&
     src.includes(`_relPaymentId:result.paymentId, _relRowVersion:result.rowVersion`),
    'addPayment sets _relPaymentId/_relRowVersion on the new payment from the response');

  ok(src.includes(`if(removed && removed._relPaymentId!=null && isRelationalAuthoritative(relSection)){`),
    'deletePayment routes relationally only for a genuine relational payment row (_relPaymentId set)');
  // MIGRATION CLOSURE Item 1 (2026-08-21): deletePayment's relational call
  // now also sends removed._relRowVersion — the server-side row-scoped
  // concurrency fix closing the one relational delete route that
  // previously had none.
  ok(src.includes(`await relationalApi.deletePayment(removed._relPaymentId, removed._relRowVersion, relSection);`),
    'deletePayment calls relationalApi.deletePayment with the payment\'s _relPaymentId, _relRowVersion and the owning section');

  ok(src.includes(`if(p && p._relPaymentId!=null && isRelationalAuthoritative(relSection)){`),
    'editPayment routes relationally only for a genuine relational payment row (_relPaymentId set)');
  ok(src.includes(`const result = await relationalApi.updatePayment(p._relPaymentId, p._relRowVersion, relSection, patch);`),
    'editPayment calls relationalApi.updatePayment with the payment\'s _relPaymentId/_relRowVersion and the owning section');

  ok(src.includes(`updatePayment(id, expectedVersion, ownerSection, patch) { return relationalFetch('/payments/' + id, { method: 'PUT', body: JSON.stringify(Object.assign({ expectedVersion: expectedVersion, ownerSection: ownerSection }, patch)) }); },`),
    'relationalApi.updatePayment client wrapper exists with the correct shape');
  ok(src.includes(`deletePayment(id, expectedVersion, ownerSection) { return relationalFetch('/payments/' + id, { method: 'DELETE', body: JSON.stringify({ expectedVersion: expectedVersion, ownerSection: ownerSection }) }); },`),
    'relationalApi.deletePayment client wrapper now requires expectedVersion (MIGRATION CLOSURE Item 1)');
}

async function resetRelationalTables() {
  await pool.query(`
    TRUNCATE rel_payments, rel_invoice_line_items, rel_invoices, rel_job_line_items, rel_jobs, rel_quote_line_items, rel_quotes, rel_credit_notes, rel_customers
    RESTART IDENTITY CASCADE
  `);
  await pool.query(`DELETE FROM quote_conversions`);
  await pool.query(`UPDATE relational_cutover SET enabled = false, enabled_at = NULL, enabled_by = NULL`);
}

async function runStatusRecomputeProof() {
  const base = process.env.TEST_SERVER_URL_WITH_AUTHORITY;
  if (!base) {
    console.log('\n[Frontend payment wiring] end-to-end proofs SKIPPED — TEST_SERVER_URL_WITH_AUTHORITY not set.');
    return;
  }

  await resetRelationalTables();
  await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section IN ('jobs')`);

  // A job BACKFILLED from historical JSON, value 1000 (VAT-inclusive, as
  // rel_jobs.value always is — see createQuote/convertQuoteToJob), with a
  // legacy id (777001) deliberately different from its relational PK.
  const tmpPath = path.resolve('/tmp/frontend-payment-wiring-fixture.json');
  fs.writeFileSync(tmpPath, JSON.stringify({
    jobs: [{ id: 777001, num: 'SNS-PAYWIRE', co: '2', client: 'Payment Wiring Test Co', desc: 'x', status: 'in_production', stage: 6, value: 1000, lines: [{ desc: 'x', qty: 1, unitPrice: 1000, subtotal: 1000 }] }],
  }));
  await runBackfill({ apply: true, sourceFile: tmpPath });

  const jobRow = await pool.query(`SELECT id FROM rel_jobs WHERE source_id = '777001'`);
  const jobRelId = jobRow.rows[0].id;

  const token = await login(base);
  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  console.log('\n[Frontend payment wiring] recomputeOwnerPaymentStatus — the NEW fix: invoice_status now reaches "paid" on full payment');
  const pay1Res = await fetch(`${base}/api/relational/payments`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ ownerType: 'job', ownerId: jobRelId, amount: 400, date: '2026-08-21', method: 'EFT', notes: 'first partial' }),
  });
  const pay1Body: any = await pay1Res.json();
  ok(pay1Res.status === 201, 'first partial payment recorded', pay1Body);
  let jobAfter = await pool.query(`SELECT invoice_status FROM rel_jobs WHERE id = $1`, [jobRelId]);
  ok(jobAfter.rows[0].invoice_status === 'partial', 'invoice_status correctly reached "partial" after a 400/1000 payment (BEFORE this fix it would have stayed unchanged forever)', jobAfter.rows[0]);

  const pay2Res = await fetch(`${base}/api/relational/payments`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ ownerType: 'job', ownerId: jobRelId, amount: 600, date: '2026-08-21', method: 'EFT', notes: 'final payment' }),
  });
  const pay2Body: any = await pay2Res.json();
  ok(pay2Res.status === 201, 'second (final) payment recorded', pay2Body);
  jobAfter = await pool.query(`SELECT invoice_status FROM rel_jobs WHERE id = $1`, [jobRelId]);
  ok(jobAfter.rows[0].invoice_status === 'paid', 'invoice_status correctly reached "paid" once total paid (1000) >= job value (1000)', jobAfter.rows[0]);

  console.log('\n[Frontend payment wiring] deleting the second payment correctly reverts invoice_status back to "partial"');
  const delRes = await fetch(`${base}/api/relational/payments/${pay2Body.paymentId}`, {
    method: 'DELETE', headers: authHeaders, body: JSON.stringify({ expectedVersion: pay2Body.rowVersion, ownerSection: 'jobs' }),
  });
  ok(delRes.status === 200, 'delete succeeded', await delRes.text().catch(() => ''));
  jobAfter = await pool.query(`SELECT invoice_status FROM rel_jobs WHERE id = $1`, [jobRelId]);
  ok(jobAfter.rows[0].invoice_status === 'partial', 'invoice_status correctly reverted to "partial" after deleting the payment that made it "paid"', jobAfter.rows[0]);

  console.log('\n[Frontend payment wiring] editing the remaining payment\'s amount to a small nonzero value still correctly reads as "partial"');
  const editRes = await fetch(`${base}/api/relational/payments/${pay1Body.paymentId}`, {
    method: 'PUT', headers: authHeaders,
    body: JSON.stringify({ expectedVersion: pay1Body.rowVersion, ownerSection: 'jobs', amount: 5 }),
  });
  const editBody: any = await editRes.json();
  ok(editRes.status === 200, 'edit succeeded', editBody);
  jobAfter = await pool.query(`SELECT invoice_status FROM rel_jobs WHERE id = $1`, [jobRelId]);
  ok(jobAfter.rows[0].invoice_status === 'partial', 'a small nonzero remaining payment (5) still reads as "partial" (>0), not "pending"', jobAfter.rows[0]);

  console.log('\n[Frontend payment wiring] editing the remaining payment\'s amount down to exactly 0 correctly reverts invoice_status to "pending"');
  const editZeroRes = await fetch(`${base}/api/relational/payments/${pay1Body.paymentId}`, {
    method: 'PUT', headers: authHeaders,
    body: JSON.stringify({ expectedVersion: editBody.rowVersion, ownerSection: 'jobs', amount: 0 }),
  });
  const editZeroBody: any = await editZeroRes.json();
  ok(editZeroRes.status === 200, 'edit to 0 succeeded', editZeroBody);
  jobAfter = await pool.query(`SELECT invoice_status FROM rel_jobs WHERE id = $1`, [jobRelId]);
  ok(jobAfter.rows[0].invoice_status === 'pending', 'invoice_status correctly reverted all the way to "pending" once total paid is exactly 0', jobAfter.rows[0]);

  await resetRelationalTables();
  await pool.query(`UPDATE platform_state SET data = '{}'::jsonb, updated_at = NOW() WHERE id = 1`);
  fs.unlinkSync(tmpPath);
}

async function runCreditPaymentProof() {
  const base = process.env.TEST_SERVER_URL_WITH_AUTHORITY;
  if (!base) return;

  await resetRelationalTables();
  await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section IN ('jobs')`); // creditNotes deliberately NOT cut over yet

  const tmpPath = path.resolve('/tmp/frontend-payment-wiring-credit-fixture.json');
  fs.writeFileSync(tmpPath, JSON.stringify({
    jobs: [{ id: 777101, num: 'SNS-CREDITPAY', co: '2', client: 'Credit Payment Test Co', desc: 'x', status: 'in_production', stage: 6, value: 500, lines: [{ desc: 'x', qty: 1, unitPrice: 500, subtotal: 500 }] }],
  }));
  await runBackfill({ apply: true, sourceFile: tmpPath });
  const jobRow = await pool.query(`SELECT id FROM rel_jobs WHERE source_id = '777101'`);
  const jobRelId = jobRow.rows[0].id;

  const token = await login(base);
  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  console.log('\n[Frontend payment wiring] a Credit-method payment is correctly BLOCKED (409 cutover_dependency) while "creditNotes" is not cut over — the frontend now attempts this instead of silently routing to the JSON path');
  const blockedRes = await fetch(`${base}/api/relational/payments`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ ownerType: 'job', ownerId: jobRelId, amount: 100, method: 'Credit' }),
  });
  const blockedBody: any = await blockedRes.json();
  ok(blockedRes.status === 409 && blockedBody.type === 'cutover_dependency', 'Credit payment correctly refused with 409 cutover_dependency', blockedBody);

  console.log('\n[Frontend payment wiring] enabling "creditNotes" lets the SAME Credit payment succeed and correctly apply credit-note usage');
  await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section = 'creditNotes'`);
  await pool.query(
    `WITH new_id AS (SELECT nextval('rel_credit_notes_id_seq') AS id)
     INSERT INTO rel_credit_notes (id, source_id, credit_number, note_type, contact_name_raw, amount, used_amount, note_date, legacy_data)
     SELECT new_id.id, new_id.id::text, 'CN-TESTFIX-1', 'customer', 'Credit Payment Test Co', 200, 0, '2026-08-01', '{}'::jsonb FROM new_id`
  );
  const creditRes = await fetch(`${base}/api/relational/payments`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ ownerType: 'job', ownerId: jobRelId, amount: 100, method: 'Credit' }),
  });
  const creditBody: any = await creditRes.json();
  ok(creditRes.status === 201 && creditBody.creditApplied === 100, 'Credit payment now succeeds and reports creditApplied=100', creditBody);
  const noteAfter = await pool.query(`SELECT used_amount FROM rel_credit_notes WHERE contact_name_raw = 'Credit Payment Test Co'`);
  ok(Number(noteAfter.rows[0].used_amount) === 100, 'the credit note\'s used_amount was correctly incremented by 100');
  const jobAfterCredit = await pool.query(`SELECT invoice_status FROM rel_jobs WHERE id = $1`, [jobRelId]);
  ok(jobAfterCredit.rows[0].invoice_status === 'partial', 'the job\'s invoice_status was also correctly recomputed for the Credit payment (100/500 = partial)', jobAfterCredit.rows[0]);

  console.log('\n[Frontend payment wiring] editPayment correctly REFUSES to edit a Credit-funded payment (matches promptEditPayment\'s existing JSON-side rule)');
  const editCreditRes = await fetch(`${base}/api/relational/payments/${creditBody.paymentId}`, {
    method: 'PUT', headers: authHeaders,
    body: JSON.stringify({ expectedVersion: creditBody.rowVersion, ownerSection: 'jobs', amount: 50 }),
  });
  ok(editCreditRes.status === 409, 'editing a Credit-funded payment is refused', editCreditRes.status);

  console.log('\n[Frontend payment wiring] deletePayment correctly releases credit usage back to the note');
  const delCreditRes = await fetch(`${base}/api/relational/payments/${creditBody.paymentId}`, {
    method: 'DELETE', headers: authHeaders, body: JSON.stringify({ expectedVersion: creditBody.rowVersion, ownerSection: 'jobs' }),
  });
  ok(delCreditRes.status === 200, 'delete of the Credit-funded payment succeeded', await delCreditRes.text().catch(() => ''));
  const noteAfterRelease = await pool.query(`SELECT used_amount FROM rel_credit_notes WHERE contact_name_raw = 'Credit Payment Test Co'`);
  ok(Number(noteAfterRelease.rows[0].used_amount) === 0, 'the credit note\'s used_amount was correctly released back to 0');

  await resetRelationalTables();
  await pool.query(`UPDATE platform_state SET data = '{}'::jsonb, updated_at = NOW() WHERE id = 1`);
  fs.unlinkSync(tmpPath);
}

async function main() {
  const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  checkSourceWiring(src);
  await runStatusRecomputeProof();
  await runCreditPaymentProof();

  console.log('\n' + '='.repeat(60));
  console.log(`${passed} passed, ${failures} failed`);
  console.log('='.repeat(60));
  await pool.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[frontend-payment-wiring-test] Fatal error:', err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
