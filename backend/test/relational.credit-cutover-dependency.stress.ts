/**
 * relational.credit-cutover-dependency.stress.ts — STAGE 3 Phase 5
 * verification.
 *
 * Proves the new cross-authority guard in api.ts: a method:'Credit'
 * payment deducts/releases rel_credit_notes rows in the SAME transaction
 * as the payment write, regardless of which sections are cut over. If the
 * payment's owner section (jobs/accInvoices/quotes) is relational-
 * authoritative but "creditNotes" is NOT, that credit-note mutation would
 * happen invisibly to the live JSON-rendered Credit Notes page. POST
 * /payments and DELETE /payments/:id must both BLOCK with a structured
 * 409 `cutover_dependency` conflict in that mixed-mode combination, and
 * must both succeed once creditNotes is also cut over.
 *
 * Requires a REAL running server with RELATIONAL_AUTHORITY_ENABLED=true
 * (TEST_SERVER_URL_WITH_AUTHORITY) — same convention as
 * relational.rest-api.stress.ts. Skips with a clear notice if not set.
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
  const base = process.env.TEST_SERVER_URL_WITH_AUTHORITY;
  if (!base) {
    console.log('[credit-cutover-dependency] SKIPPED — TEST_SERVER_URL_WITH_AUTHORITY not set (needs a server with RELATIONAL_AUTHORITY_ENABLED=true). See test runner instructions.');
    await pool.end();
    process.exit(0);
  }

  await resetRelationalTables();
  const token = await login(base!);
  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  // "jobs" cut over, "creditNotes" deliberately NOT — build a job + a
  // matching customer credit note entirely through the relational service
  // layer (bypassing the HTTP gate, exactly like a backfill/direct-DB
  // scenario would) so the payment attempt below has real credit to try to
  // consume.
  await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section = 'jobs'`);
  const services = await import('../src/relational/services');
  const cust = await services.createCustomer({ companyName: 'Credit Dependency Test Co' });
  const quote = await services.createQuote({
    companyCode: '2', customerId: cust.id, customerNameRaw: 'Credit Dependency Test Co',
    lines: [{ description: 'Banner', qty: 1, unitPrice: 1000 }],
  });
  const conv = await services.convertQuoteToJob(quote.id);
  const jobId = conv.jobId;
  await services.createCreditNote({ type: 'customer', contactName: 'Credit Dependency Test Co', amount: 500 });

  console.log('\n[Credit cutover dependency] "jobs" cut over, "creditNotes" NOT cut over — a Credit payment is BLOCKED');
  const blockedRes = await fetch(`${base}/api/relational/payments`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ ownerType: 'job', ownerId: jobId, amount: 200, method: 'Credit' }),
  });
  const blockedBody = await blockedRes.json();
  ok(blockedRes.status === 409, 'POST /payments with method=Credit returns HTTP 409 when creditNotes is not cut over', JSON.stringify(blockedBody));
  ok(blockedBody.type === 'cutover_dependency', 'the 409 is specifically typed cutover_dependency (not a generic business_rule/not_cut_over)', JSON.stringify(blockedBody));
  const paymentsAfterBlock = await pool.query(`SELECT count(*)::int AS n FROM rel_payments`);
  ok(paymentsAfterBlock.rows[0].n === 0, 'the blocked attempt is a true no-op — no rel_payments row was created');
  const creditAfterBlock = await pool.query(`SELECT used_amount FROM rel_credit_notes WHERE contact_name_raw = 'Credit Dependency Test Co'`);
  ok(Number(creditAfterBlock.rows[0]?.used_amount) === 0, 'the credit note was never touched by the blocked attempt', JSON.stringify(creditAfterBlock.rows[0]));

  console.log('\n[Credit cutover dependency] a non-Credit payment against the SAME job is NOT blocked (the guard is Credit-specific, not a blanket refusal)');
  const eftRes = await fetch(`${base}/api/relational/payments`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ ownerType: 'job', ownerId: jobId, amount: 300, method: 'EFT' }),
  });
  ok(eftRes.status === 201, 'an EFT payment against the same job succeeds even though creditNotes is not cut over', String(eftRes.status));

  console.log('\n[Credit cutover dependency] once "creditNotes" is ALSO cut over, the Credit payment succeeds');
  await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section = 'creditNotes'`);
  const allowedRes = await fetch(`${base}/api/relational/payments`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ ownerType: 'job', ownerId: jobId, amount: 200, method: 'Credit' }),
  });
  const allowedBody = await allowedRes.json();
  ok(allowedRes.status === 201, 'POST /payments with method=Credit now succeeds once creditNotes is also cut over', JSON.stringify(allowedBody));
  ok(allowedBody.creditApplied === 200, 'the full 200 was funded from the credit note', JSON.stringify(allowedBody));
  const creditNoteId = (await pool.query(`SELECT id, used_amount FROM rel_credit_notes WHERE contact_name_raw = 'Credit Dependency Test Co'`)).rows[0];
  ok(Number(creditNoteId.used_amount) === 200, 'rel_credit_notes.used_amount correctly reflects the funded amount', JSON.stringify(creditNoteId));

  console.log('\n[Credit cutover dependency] disabling "creditNotes" again — deleting that SAME Credit payment is now BLOCKED (release would go unseen by JSON)');
  await pool.query(`UPDATE relational_cutover SET enabled = false WHERE section = 'creditNotes'`);
  const creditPaymentRow = await pool.query(`SELECT id FROM rel_payments WHERE method = 'Credit' LIMIT 1`);
  const deleteBlockedRes = await fetch(`${base}/api/relational/payments/${creditPaymentRow.rows[0].id}`, {
    method: 'DELETE', headers: authHeaders,
    body: JSON.stringify({ expectedVersion: allowedBody.rowVersion, ownerSection: 'jobs' }),
  });
  const deleteBlockedBody = await deleteBlockedRes.json();
  ok(deleteBlockedRes.status === 409, 'DELETE of a Credit-funded payment returns HTTP 409 once creditNotes is not cut over', JSON.stringify(deleteBlockedBody));
  ok(deleteBlockedBody.type === 'cutover_dependency', 'the delete-side 409 is also typed cutover_dependency', JSON.stringify(deleteBlockedBody));
  const paymentStillThere = await pool.query(`SELECT count(*)::int AS n FROM rel_payments WHERE id = $1`, [creditPaymentRow.rows[0].id]);
  ok(paymentStillThere.rows[0].n === 1, 'the payment was NOT deleted by the blocked attempt');
  const creditUnchanged = await pool.query(`SELECT used_amount FROM rel_credit_notes WHERE id = $1`, [creditNoteId.id]);
  ok(Number(creditUnchanged.rows[0].used_amount) === 200, 'used_amount is unchanged by the blocked delete attempt', JSON.stringify(creditUnchanged.rows[0]));

  console.log('\n[Credit cutover dependency] re-enabling "creditNotes" lets the delete succeed and release credit correctly');
  await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section = 'creditNotes'`);
  const deleteAllowedRes = await fetch(`${base}/api/relational/payments/${creditPaymentRow.rows[0].id}`, {
    method: 'DELETE', headers: authHeaders,
    body: JSON.stringify({ expectedVersion: allowedBody.rowVersion, ownerSection: 'jobs' }),
  });
  const deleteAllowedBody = await deleteAllowedRes.json();
  ok(deleteAllowedRes.status === 200, 'delete now succeeds once creditNotes is cut over', JSON.stringify(deleteAllowedBody));
  ok(deleteAllowedBody.creditReleased === 200, 'the full 200 credit was released back', JSON.stringify(deleteAllowedBody));

  await resetRelationalTables();

  console.log('\n' + '='.repeat(60));
  console.log(`${passed} passed, ${failures} failed`);
  console.log('='.repeat(60));
  await pool.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[credit-cutover-dependency-stress] Fatal error:', err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
