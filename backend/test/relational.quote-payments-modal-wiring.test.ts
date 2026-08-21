/**
 * relational.quote-payments-modal-wiring.test.ts — MIGRATION CLOSURE Item 2
 * verification.
 *
 * QuotePaymentsModal was the last core financial screen still fully
 * JSON-only for its payment CRUD (addPayment/editPayment/deletePayment).
 * This proves it now reuses the SAME relational payment services/REST
 * endpoints JobPaymentsModal already used (no duplicated business logic),
 * across all three `resolveQuotePaymentSource` kinds — 'quote' (a plain
 * quote deposit, never converted), 'job' (converted, no separate invoice
 * yet — the MERGED display view), and the true-owner-resolution wrinkle
 * unique to the merged 'job' view: a payment recorded on the quote BEFORE
 * conversion must still be treated (and gated) as quote-owned even when
 * viewed from the post-conversion Job Payments angle, never blindly as
 * job-owned just because that's which view currently shows it.
 *
 * Two parts:
 *   1. Source-text checks against the REAL index.html QuotePaymentsModal
 *      handler (not an isolated/unused helper) — resolvePaymentOwner's
 *      true-owner resolution, and addPayment/editPayment/deletePayment's
 *      relational branches.
 *   2. Real end-to-end HTTP proofs:
 *      - kind 'quote': record/edit/delete a payment directly against the
 *        quote (ownerType 'quote', ownerSection 'quotes') — full CRUD.
 *      - kind 'job' post-conversion: a NEW payment recorded after
 *        conversion is truly job-owned (ownerType 'job').
 *      - the mixed-authority wrinkle: with "quotes" cut over but "jobs"
 *        NOT, a payment recorded directly against the quote succeeds
 *        (gated correctly on its real owner section), while one attempted
 *        against the job is refused 409 not_cut_over — proving the
 *        double-gate is enforced per the payment's REAL owner, never
 *        assumed from which page happens to be looking at it.
 *      - Credit-method payment recorded directly against a quote (not yet
 *        possible before this fix — QuotePaymentsModal had no relational
 *        Credit path at all) applies/releases credit correctly.
 *      - recomputeOwnerPaymentStatus's documented no-op for owner_type
 *        'quote' (quote.status is never payment-derived, matching the
 *        pre-existing JSON behavior) still holds.
 *
 * Requires TEST_SERVER_URL_WITH_AUTHORITY — skips part 2 with a clear
 * notice if unset, same convention as every other Stage 2/3 REST suite.
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
  console.log('\n[QuotePaymentsModal wiring] source-text checks against the REAL QuotePaymentsModal handler');
  const norm = src.replace(/\r\n/g, '\n');
  const startMarker = 'function QuotePaymentsModal({';
  const start = norm.indexOf(startMarker);
  ok(start !== -1, 'QuotePaymentsModal is found in index.html');
  const nextFnMarker = '\nfunction QuoteViewModal(';
  const end = norm.indexOf(nextFnMarker, start);
  ok(end !== -1 && end > start, 'the end of QuotePaymentsModal (start of the next top-level function) is found');
  const body = norm.slice(start, end === -1 ? undefined : end);

  ok(body.includes('function resolvePaymentOwner(pid){'),
    'QuotePaymentsModal defines resolvePaymentOwner — the true-owner resolver for the merged job/quote view');
  ok(body.includes(`if(paySource.kind==='job'){`) && body.includes('const ownJobPayments = Array.isArray(paySource.record.payments) ? paySource.record.payments : [];'),
    'resolvePaymentOwner checks the JOB\'S OWN payments array (not the merged display array) to decide true ownership for the job kind');
  ok(body.includes(`if((quote.payments||[]).some(p=>p&&p.id===pid)){\n        return { ownerType:'quote', relSection:'quotes', ownerId: quote._relId };`),
    'resolvePaymentOwner falls back to quote-ownership when a merged-view id is not in the job\'s own array — never assumed job-owned just because the modal is showing the job view');

  ok(body.includes(`const addOwner = paySource.kind==='invoice' ? { ownerType:'invoice', relSection:'accInvoices', ownerId: paySource.record._relId }`) &&
     body.includes(`: paySource.kind==='quote' ? { ownerType:'quote', relSection:'quotes', ownerId: quote._relId }`),
    'addPayment resolves a brand-new payment\'s owner deterministically by paySource.kind (never ambiguous, unlike edit/delete)');
  ok(body.includes('const result = await relationalApi.recordPayment(addOwner.ownerType, addOwner.ownerId, amt, { date, method, notes: notes.trim() });'),
    'addPayment calls relationalApi.recordPayment for every method including Credit when the resolved owner section is cut over');

  ok(body.includes('const owner = p && p._relPaymentId!=null ? resolvePaymentOwner(pid) : null;') &&
     body.includes('const result = await relationalApi.updatePayment(p._relPaymentId, p._relRowVersion, owner.relSection, patch0);'),
    'editPayment routes through resolvePaymentOwner + relationalApi.updatePayment for a genuine relational payment row');

  ok(body.includes('const owner = removed && removed._relPaymentId!=null ? resolvePaymentOwner(pid) : null;') &&
     body.includes('await relationalApi.deletePayment(removed._relPaymentId, removed._relRowVersion, owner.relSection);'),
    'deletePayment routes through resolvePaymentOwner + relationalApi.deletePayment (with expectedVersion — MIGRATION CLOSURE Item 1) for a genuine relational payment row');
}

async function resetRelationalTables() {
  await pool.query(`
    TRUNCATE rel_payments, rel_credit_notes, rel_job_line_items, rel_jobs,
      rel_quote_line_items, rel_quotes, rel_customers
    RESTART IDENTITY CASCADE
  `);
  await pool.query(`DELETE FROM quote_conversions`);
  await pool.query(`DELETE FROM document_number_counters`);
  await pool.query(`UPDATE relational_cutover SET enabled = false, enabled_at = NULL, enabled_by = NULL`);
}

async function main() {
  const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  checkSourceWiring(src);

  const base = process.env.TEST_SERVER_URL_WITH_AUTHORITY;
  if (!base) {
    console.log('\n[QuotePaymentsModal wiring] end-to-end proofs SKIPPED — TEST_SERVER_URL_WITH_AUTHORITY not set.');
  } else {
    await resetRelationalTables();
    const token = await login(base);
    const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const services = await import('../src/relational/services');

    // ── kind 'quote' — full CRUD directly against an unconverted quote ──
    console.log('\n[QuotePaymentsModal wiring] kind=\'quote\' — record/edit/delete a payment directly against the quote (ownerType/ownerSection \'quotes\')');
    await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section = 'quotes'`);
    const custQ = await services.createCustomer({ companyName: 'Quote Payments Wiring Co' });
    const quoteQ = await services.createQuote({
      companyCode: '2', customerId: custQ.id, customerNameRaw: 'Quote Payments Wiring Co',
      lines: [{ description: 'Deposit test', qty: 1, unitPrice: 2000 }],
    });
    const depositRes = await fetch(`${base}/api/relational/payments`, {
      method: 'POST', headers: H, body: JSON.stringify({ ownerType: 'quote', ownerId: quoteQ.id, amount: 800, date: '2026-08-21', method: 'EFT', notes: 'deposit' }),
    });
    const deposit: any = await depositRes.json();
    ok(depositRes.status === 201, 'a deposit payment recorded directly against the quote succeeds', deposit);
    const quoteOwnerRow = await pool.query(`SELECT owner_type, owner_id FROM rel_payments WHERE id = $1`, [deposit.paymentId]);
    ok(quoteOwnerRow.rows[0].owner_type === 'quote' && Number(quoteOwnerRow.rows[0].owner_id) === Number(quoteQ.id), 'the payment row is truly owner_type=quote', quoteOwnerRow.rows[0]);

    const editDepositRes = await fetch(`${base}/api/relational/payments/${deposit.paymentId}`, {
      method: 'PUT', headers: H, body: JSON.stringify({ expectedVersion: deposit.rowVersion, ownerSection: 'quotes', amount: 850 }),
    });
    const editDeposit: any = await editDepositRes.json();
    ok(editDepositRes.status === 200, 'editing the quote-owned deposit succeeds via ownerSection=quotes', editDeposit);

    console.log('\n[QuotePaymentsModal wiring] recomputeOwnerPaymentStatus no-ops for owner_type=quote (quote.status is never payment-derived)');
    const quoteStatusBefore = await pool.query(`SELECT status FROM rel_quotes WHERE id = $1`, [quoteQ.id]);
    ok(quoteStatusBefore.rows[0].status !== 'paid' && quoteStatusBefore.rows[0].status !== 'partial', 'quote.status was never flipped to a payment-derived value by recording/editing its own deposit', quoteStatusBefore.rows[0]);

    const deleteDepositRes = await fetch(`${base}/api/relational/payments/${deposit.paymentId}`, {
      method: 'DELETE', headers: H, body: JSON.stringify({ expectedVersion: editDeposit.rowVersion, ownerSection: 'quotes' }),
    });
    ok(deleteDepositRes.status === 200, 'deleting the quote-owned deposit succeeds via ownerSection=quotes', await deleteDepositRes.text().catch(() => ''));

    // ── kind 'job' post-conversion — a brand-new payment is truly job-owned ──
    console.log('\n[QuotePaymentsModal wiring] kind=\'job\' post-conversion — a NEW payment recorded after conversion is truly job-owned');
    const quoteJ = await services.createQuote({
      companyCode: '2', customerId: custQ.id, customerNameRaw: 'Quote Payments Wiring Co',
      lines: [{ description: 'Job payment test', qty: 1, unitPrice: 3000 }],
    });
    // Record a deposit BEFORE conversion (quote-owned) — the exact "a
    // deposit recorded before conversion legitimately still lives on
    // quote.payments after the quote becomes a job" scenario
    // resolveQuotePaymentSource's kind='job' merge exists for.
    const preConvDeposit: any = await (await fetch(`${base}/api/relational/payments`, {
      method: 'POST', headers: H, body: JSON.stringify({ ownerType: 'quote', ownerId: quoteJ.id, amount: 500, method: 'EFT', notes: 'pre-conversion deposit' }),
    })).json();
    await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section = 'jobs'`);
    const conv = await services.convertQuoteToJob(quoteJ.id);
    const postConvPayment: any = await (await fetch(`${base}/api/relational/payments`, {
      method: 'POST', headers: H, body: JSON.stringify({ ownerType: 'job', ownerId: conv.jobId, amount: 700, method: 'EFT', notes: 'post-conversion payment' }),
    })).json();
    ok(postConvPayment.paymentId, 'a payment recorded against the job after conversion succeeds', postConvPayment);
    const postConvOwnerRow = await pool.query(`SELECT owner_type, owner_id FROM rel_payments WHERE id = $1`, [postConvPayment.paymentId]);
    ok(postConvOwnerRow.rows[0].owner_type === 'job' && Number(postConvOwnerRow.rows[0].owner_id) === Number(conv.jobId), 'the new payment is truly owner_type=job', postConvOwnerRow.rows[0]);
    const preConvOwnerRow = await pool.query(`SELECT owner_type FROM rel_payments WHERE id = $1`, [preConvDeposit.paymentId]);
    ok(preConvOwnerRow.rows[0].owner_type === 'quote', 'the PRE-conversion deposit is STILL owner_type=quote after conversion — convertQuoteToJob never migrates payment ownership, exactly why resolvePaymentOwner cannot assume kind=\'job\' means job-owned', preConvOwnerRow.rows[0]);

    // ── mixed-authority wrinkle: "quotes" cut over, "jobs" NOT ──
    console.log('\n[QuotePaymentsModal wiring] mixed authority — with only "quotes" cut over, a quote-owned payment action is allowed while a job-owned one is refused 409 not_cut_over');
    await pool.query(`UPDATE relational_cutover SET enabled = false WHERE section = 'jobs'`);
    const quoteM = await services.createQuote({
      companyCode: '2', customerId: custQ.id, customerNameRaw: 'Quote Payments Wiring Co',
      lines: [{ description: 'Mixed authority test', qty: 1, unitPrice: 1000 }],
    });
    const mixedQuotePay = await fetch(`${base}/api/relational/payments`, {
      method: 'POST', headers: H, body: JSON.stringify({ ownerType: 'quote', ownerId: quoteM.id, amount: 400, method: 'EFT' }),
    });
    ok(mixedQuotePay.status === 201, 'a payment against the quote succeeds while "quotes" alone is cut over', mixedQuotePay.status);
    const mixedJobPay = await fetch(`${base}/api/relational/payments`, {
      method: 'POST', headers: H, body: JSON.stringify({ ownerType: 'job', ownerId: conv.jobId, amount: 100, method: 'EFT' }),
    });
    const mixedJobPayBody: any = await mixedJobPay.json();
    ok(mixedJobPay.status === 409 && mixedJobPayBody.type === 'not_cut_over', 'a payment against the job is correctly refused 409 not_cut_over while "jobs" is not cut over, even though "quotes" (a related section) is', mixedJobPayBody);
    await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section = 'jobs'`);

    // ── Credit-method payment recorded directly against a quote ──
    console.log('\n[QuotePaymentsModal wiring] a Credit-method payment recorded directly against a quote (previously impossible from this modal) applies and releases credit correctly');
    await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section = 'creditNotes'`);
    const custC = await services.createCustomer({ companyName: 'Quote Credit Payment Co' });
    const quoteC = await services.createQuote({
      companyCode: '2', customerId: custC.id, customerNameRaw: 'Quote Credit Payment Co',
      lines: [{ description: 'Credit test', qty: 1, unitPrice: 1000 }],
    });
    const cn = await services.createCreditNote({ type: 'customer', contactName: 'Quote Credit Payment Co', amount: 600 });
    const creditPayRes = await fetch(`${base}/api/relational/payments`, {
      method: 'POST', headers: H, body: JSON.stringify({ ownerType: 'quote', ownerId: quoteC.id, amount: 400, method: 'Credit' }),
    });
    const creditPay: any = await creditPayRes.json();
    ok(creditPayRes.status === 201 && creditPay.creditApplied === 400, 'a Credit payment against a quote applies the correct amount', creditPay);
    const cnAfterApply = await pool.query(`SELECT used_amount FROM rel_credit_notes WHERE id = $1`, [cn.id]);
    ok(Number(cnAfterApply.rows[0].used_amount) === 400, 'the credit note used_amount reflects the quote-owned Credit payment');
    const creditDelRes = await fetch(`${base}/api/relational/payments/${creditPay.paymentId}`, {
      method: 'DELETE', headers: H, body: JSON.stringify({ expectedVersion: creditPay.rowVersion, ownerSection: 'quotes' }),
    });
    ok(creditDelRes.status === 200, 'deleting the quote-owned Credit payment succeeds', await creditDelRes.text().catch(() => ''));
    const cnAfterRelease = await pool.query(`SELECT used_amount FROM rel_credit_notes WHERE id = $1`, [cn.id]);
    ok(Number(cnAfterRelease.rows[0].used_amount) === 0, 'the credit note is correctly released back to 0');

    await resetRelationalTables();
    await pool.query(`UPDATE platform_state SET data = '{}'::jsonb, updated_at = NOW() WHERE id = 1`);
  }

  console.log('\n' + '='.repeat(60));
  console.log(`${passed} passed, ${failures} failed`);
  console.log('='.repeat(60));
  await pool.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[quote-payments-modal-wiring] Fatal error:', err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
