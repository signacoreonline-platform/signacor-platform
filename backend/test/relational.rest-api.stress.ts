/**
 * relational.rest-api.stress.ts — Stage 2 Phase 2.
 *
 * Exercises the REST endpoints in backend/src/relational/api.ts over HTTP
 * against a REAL running server: cutover gating (a not-cut-over section
 * refuses with 409 not_cut_over, never silently accepts), the full
 * customer -> quote -> job -> invoice -> payment chain succeeding end to
 * end once cut over, row-level optimistic concurrency surfacing as a 409
 * stale_record over HTTP (not just inside services.ts directly), and a
 * business-rule violation (e.g. double-converting a quote) surfacing as a
 * 409 business_rule.
 *
 * Requires TEST_SERVER_URL (no authority — used for the gating-refusal
 * checks) and TEST_SERVER_URL_WITH_AUTHORITY (authority on — used for the
 * success-path checks). Skips the authority-on section with a clear notice
 * if that URL isn't set, same convention as the other Stage 2 suites.
 */
import pool from '../src/db/pool';

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

async function login(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.TEST_LOGIN_EMAIL || 'test@signacore.local', password: process.env.TEST_LOGIN_PASSWORD || 'testpass' }),
  });
  if (!res.ok) throw new Error(`login failed against ${baseUrl}: HTTP ${res.status}`);
  return (await res.json()).token;
}

async function main() {
  const baseNoAuthority = process.env.TEST_SERVER_URL || 'http://localhost:3001';
  const baseWithAuthority = process.env.TEST_SERVER_URL_WITH_AUTHORITY;

  // Clean slate — this suite shares the disposable local test database with
  // every other Stage 1/2 suite; a previous run/suite may have left
  // rel_quotes/rel_jobs rows and quote_conversions bookkeeping behind (e.g.
  // a quote id=1 from an earlier suite's own reset would otherwise collide
  // with quote_conversions' UNIQUE(quote_id) on 'rel:1').
  await pool.query(`TRUNCATE rel_customers, rel_quotes, rel_quote_line_items, rel_jobs, rel_job_line_items, rel_invoices, rel_invoice_line_items, rel_payments RESTART IDENTITY CASCADE`).catch(() => undefined);
  await pool.query(`DELETE FROM quote_conversions WHERE quote_id LIKE 'rel:%'`);

  console.log('\n[REST API] cutover gating — every section OFF (default) refuses with 409 not_cut_over');
  await pool.query(`UPDATE relational_cutover SET enabled = false`);
  const tokenNoAuthority = await login(baseNoAuthority);
  const headersNoAuthority = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenNoAuthority}` };

  const gatedCustomer = await fetch(`${baseNoAuthority}/api/relational/customers`, { method: 'POST', headers: headersNoAuthority, body: JSON.stringify({ companyName: 'Should Be Refused' }) });
  const gatedCustomerBody = await gatedCustomer.json();
  ok(gatedCustomer.status === 409 && gatedCustomerBody.type === 'not_cut_over', 'POST /api/relational/customers refuses with 409 not_cut_over when customers is not cut over', `HTTP ${gatedCustomer.status} ${JSON.stringify(gatedCustomerBody)}`);

  const gatedQuote = await fetch(`${baseNoAuthority}/api/relational/quotes`, { method: 'POST', headers: headersNoAuthority, body: JSON.stringify({ companyCode: '2', customerNameRaw: 'x', lines: [{ description: 'a', qty: 1, unitPrice: 1 }] }) });
  ok(gatedQuote.status === 409, 'POST /api/relational/quotes also refuses with 409 when quotes is not cut over', `HTTP ${gatedQuote.status}`);

  ok((await pool.query(`SELECT count(*)::int AS n FROM rel_customers WHERE company_name = 'Should Be Refused'`)).rows[0].n === 0, 'the refused customer create genuinely wrote nothing to rel_customers');

  const statusRes = await fetch(`${baseNoAuthority}/api/relational/status`, { headers: { Authorization: `Bearer ${tokenNoAuthority}` } });
  const statusBody = await statusRes.json();
  ok(statusRes.ok && Object.values(statusBody.sections).every((v) => v === false), 'GET /api/relational/status reports every section false with master switch off', JSON.stringify(statusBody));

  if (!baseWithAuthority) {
    console.log('\n[REST API] SKIPPED success-path checks — TEST_SERVER_URL_WITH_AUTHORITY not set.');
  } else {
    console.log('\n[REST API] success path — full customer -> quote -> job -> invoice -> payment chain once cut over');
    await pool.query(`UPDATE relational_cutover SET enabled = true, enabled_at = NOW(), enabled_by = 'rest-api-test' WHERE section IN ('customers','quotes','jobs','accInvoices')`);
    const token = await login(baseWithAuthority);
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

    const custRes = await fetch(`${baseWithAuthority}/api/relational/customers`, { method: 'POST', headers, body: JSON.stringify({ companyName: 'REST API Test Customer' }) });
    const cust = await custRes.json();
    // pg returns BIGINT/BIGSERIAL columns as numeric STRINGS (avoids
    // precision loss beyond Number.MAX_SAFE_INTEGER) — this is the same
    // convention services.ts has always returned (jobId/quoteId/invoiceId
    // were always numeric strings in Stage 1 too); id comparisons
    // throughout this codebase are String(id)-based by design (see
    // platformState.ts's own merge logic), so a numeric string is the
    // CORRECT shape here, not a bug.
    ok(custRes.status === 201 && cust.id != null && /^\d+$/.test(String(cust.id)), 'POST /api/relational/customers creates a customer, minimal response (id + rowVersion only)', JSON.stringify(cust));
    ok(cust.legacy_data === undefined && cust.companyName === undefined, 'response body is minimal — no full row/legacy_data echoed back');

    // The id returned by the REST create response must be the SAME id a
    // subsequent GET /api/platform-state renders for this record (Stage 2
    // fix — see services.ts's 2026-08-20 comment on source_id = id::text
    // for fresh records). Without this, a frontend could create a
    // customer, get back one id, then be unable to find "that same
    // customer" in the next GET because it rendered under a different id.
    const getAfterCreate = await fetch(`${baseWithAuthority}/api/platform-state`, { headers: { Authorization: `Bearer ${token}` } });
    const getAfterCreateBody = await getAfterCreate.json();
    const foundViaGet = (getAfterCreateBody.data.customers || []).find((c: any) => String(c.id) === String(cust.id));
    ok(!!foundViaGet && foundViaGet.name === 'REST API Test Customer', 'the id returned by POST /api/relational/customers matches the id the SAME record renders under via GET /api/platform-state', `looked for id ${cust.id} among ${JSON.stringify((getAfterCreateBody.data.customers || []).map((c: any) => c.id))}`);

    const staleUpdateAttempt1 = fetch(`${baseWithAuthority}/api/relational/customers/${cust.id}`, { method: 'PUT', headers, body: JSON.stringify({ expectedVersion: cust.rowVersion, notes: 'first' }) });
    const staleUpdateAttempt2 = fetch(`${baseWithAuthority}/api/relational/customers/${cust.id}`, { method: 'PUT', headers, body: JSON.stringify({ expectedVersion: cust.rowVersion, notes: 'second (stale)' }) });
    const [u1, u2] = await Promise.all([staleUpdateAttempt1, staleUpdateAttempt2]);
    const results = await Promise.all([u1.json(), u2.json()]);
    const statuses = [u1.status, u2.status].sort();
    ok(JSON.stringify(statuses) === JSON.stringify([200, 409]), 'two concurrent updates with the SAME expectedVersion: one wins (200), one gets 409 over HTTP', JSON.stringify(statuses));
    const conflictResult = results[[u1.status, u2.status].indexOf(409)];
    ok(conflictResult.conflict === true && conflictResult.type === 'stale_record', 'the losing request gets { conflict: true, type: "stale_record" } — same shape family as platform_state\'s 409s', JSON.stringify(conflictResult));

    const quoteRes = await fetch(`${baseWithAuthority}/api/relational/quotes`, { method: 'POST', headers, body: JSON.stringify({ companyCode: '2', customerId: cust.id, customerNameRaw: 'REST API Test Customer', lines: [{ description: 'signage panel', qty: 2, unitPrice: 450 }] }) });
    const quote = await quoteRes.json();
    ok(quoteRes.status === 201 && /^SQ-/.test(quote.quoteNumber), 'POST /api/relational/quotes creates a quote with a real SQ-##### number', JSON.stringify(quote));

    const quotePatchRes = await fetch(`${baseWithAuthority}/api/relational/quotes/${quote.id}`, { method: 'PUT', headers, body: JSON.stringify({ expectedVersion: 1, notes: 'edited via REST' }) });
    const quotePatch = await quotePatchRes.json();
    ok(quotePatchRes.status === 200 && quotePatch.rowVersion === 2, 'PUT /api/relational/quotes/:id (plain field edit) succeeds and bumps rowVersion', JSON.stringify(quotePatch));

    const convertRes = await fetch(`${baseWithAuthority}/api/relational/quotes/${quote.id}/convert-to-job`, { method: 'POST', headers });
    const job = await convertRes.json();
    ok(convertRes.status === 201 && /^SNS-/.test(job.jobNumber), 'POST convert-to-job creates a job with a real SNS-##### number', JSON.stringify(job));

    const jobPatchRes = await fetch(`${baseWithAuthority}/api/relational/jobs/${job.jobId}`, { method: 'PUT', headers, body: JSON.stringify({ expectedVersion: 1, notes: 'job note via REST' }) });
    const jobPatch = await jobPatchRes.json();
    ok(jobPatchRes.status === 200 && jobPatch.rowVersion === 2, 'PUT /api/relational/jobs/:id (plain field edit) succeeds and bumps rowVersion', JSON.stringify(jobPatch));

    const doubleConvertRes = await fetch(`${baseWithAuthority}/api/relational/quotes/${quote.id}/convert-to-job`, { method: 'POST', headers });
    const doubleConvertBody = await doubleConvertRes.json();
    ok(doubleConvertRes.status === 409 && doubleConvertBody.type === 'business_rule', 'converting the SAME quote a second time over HTTP correctly surfaces as 409 business_rule (not a 500, not a silent duplicate)', JSON.stringify(doubleConvertBody));

    const invoiceRes = await fetch(`${baseWithAuthority}/api/relational/jobs/${job.jobId}/create-invoice`, { method: 'POST', headers });
    const invoice = await invoiceRes.json();
    ok(invoiceRes.status === 201 && /^INV-/.test(invoice.invoiceNumber), 'POST create-invoice creates an invoice with a real INV-##### number, sharing the quote/job\'s numeric suffix pool', JSON.stringify(invoice));

    const paymentRes = await fetch(`${baseWithAuthority}/api/relational/payments`, { method: 'POST', headers, body: JSON.stringify({ ownerType: 'invoice', ownerId: invoice.invoiceId, amount: 250, method: 'EFT', reference: 'REST-TEST' }) });
    const payment = await paymentRes.json();
    ok(paymentRes.status === 201 && payment.paymentId != null && /^\d+$/.test(String(payment.paymentId)), 'POST /api/relational/payments records a payment against the new invoice', JSON.stringify(payment));

    await pool.query(`UPDATE relational_cutover SET enabled = false, enabled_at = NULL, enabled_by = NULL`);
  }

  console.log('\n' + '='.repeat(60));
  console.log(`${passed} passed, ${failures} failed`);
  console.log('='.repeat(60));
  await pool.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[rest-api-stress] Fatal error:', err);
  await pool.query(`UPDATE relational_cutover SET enabled = false, enabled_at = NULL, enabled_by = NULL`).catch(() => undefined);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
