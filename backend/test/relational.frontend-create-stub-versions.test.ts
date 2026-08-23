/**
 * relational.frontend-create-stub-versions.test.ts — STAGE 3 follow-on fix
 * verification.
 *
 * Phase 1 (job editing) and Phase 2 (quote editing) wired JobDetail/
 * QuotesPage's save handlers to require job._relId/job._relRowVersion and
 * q._relId/q._relRowVersion. That made a pre-existing, previously-harmless
 * gap into a real risk: several creation-time code paths built a local
 * "stub" object to reflect a relational create/mutate immediately, without
 * setting _relId/_relRowVersion on it. Editing that record before the next
 * GET refreshed it from the relational read-overlay would then call
 * relationalApi.updateJob/updateQuote/updateCustomer with an undefined id
 * or a stale row_version — either a hard failure or a false 409
 * stale_record conflict.
 *
 * This file proves each of the four fixed call sites:
 *   1. CustomerModal.handleSave's isNew branch — sets _relId (equal to the
 *      new PK) alongside the pre-existing _relRowVersion.
 *   2. CreateQuoteModal.submit's new-quote branch — sets _relId/
 *      _relRowVersion from createQuote()'s response (which now also
 *      returns rowVersion — see services.ts's createQuote).
 *   3. handleConvertToJob's stubJob — sets _relId/_relRowVersion from
 *      convertQuoteToJob()'s response (which now also returns
 *      jobRowVersion — see services.ts's convertQuoteToJob).
 *   4. createInvoiceNow's relational branch — refreshes the job's
 *      _relRowVersion from createInvoiceForJob()'s response (which now
 *      also returns jobRowVersion — see services.ts's createInvoiceForJob).
 *
 * Part 2 is a REAL end-to-end HTTP proof that the three backend response
 * shapes (POST /quotes, POST /quotes/:id/convert-to-job, POST
 * /jobs/:id/create-invoice) all now include a row-version field that
 * matches the actual row_version in the database at that moment — i.e.
 * the frontend fix has real, correct data available to consume, not just
 * a source-level wiring change with nothing behind it.
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
  console.log('\n[Create-stub versions] source-text checks — four creation-time stubs now set _relId/_relRowVersion');

  ok(src.includes(`setCustomers(prev => [{ ...c, id: result.id, _relId: result.id, _relRowVersion: result.rowVersion }, ...prev]);`),
    'customer create sets _relId (equal to the new PK) alongside _relRowVersion');

  ok(src.includes(`_relId: result.id, _relRowVersion: result.rowVersion,`) && src.includes(`const result = await relationalApi.createQuote({`),
    'new-quote payload sets _relId/_relRowVersion from createQuote()\'s response');

  ok(src.includes(`_relId: result.jobId, _relRowVersion: result.jobRowVersion,`) && src.includes(`const result = await relationalApi.convertQuoteToJob(q._relId);`),
    'handleConvertToJob\'s stubJob sets _relId/_relRowVersion from convertQuoteToJob()\'s response');

  // 2026-08-23 (production cutover repair — JOB FINANCIAL + LIFECYCLE
  // REPAIR): stage/status are no longer hardcoded to 9/'invoiced' here —
  // createInvoiceForJob only bumps them server-side once the job has
  // already reached INSTALL_STAGE, and the frontend must reflect whatever
  // the backend actually did (result.jobStage/result.jobStatus) rather
  // than assuming the terminal values unconditionally. _relRowVersion is
  // still refreshed from the response exactly as before.
  ok(src.includes(`stage:result.jobStage, status:result.jobStatus, _relRowVersion:result.jobRowVersion}:j`),
    'createInvoiceNow refreshes the job\'s stage/status/_relRowVersion from createInvoiceForJob()\'s response (not hardcoded)');
}

async function resetRelationalTables() {
  await pool.query(`
    TRUNCATE rel_payments, rel_invoice_line_items, rel_invoices, rel_job_line_items, rel_jobs, rel_quote_line_items, rel_quotes, rel_customers
    RESTART IDENTITY CASCADE
  `);
  await pool.query(`DELETE FROM quote_conversions`);
  await pool.query(`DELETE FROM document_number_counters`);
  await pool.query(`UPDATE relational_cutover SET enabled = false, enabled_at = NULL, enabled_by = NULL`);
}

async function runEndToEndProof() {
  const base = process.env.TEST_SERVER_URL_WITH_AUTHORITY;
  if (!base) {
    console.log('\n[Create-stub versions] end-to-end proof SKIPPED — TEST_SERVER_URL_WITH_AUTHORITY not set.');
    return;
  }

  await resetRelationalTables();
  await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section IN ('quotes','jobs','accInvoices')`);

  const token = await login(base);
  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  console.log('\n[Create-stub versions] POST /quotes response.rowVersion matches the real DB row_version');
  const createQuoteRes = await fetch(`${base}/api/relational/quotes`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ companyCode: '2', customerNameRaw: 'Stub Version Test Co', lines: [{ description: 'x', qty: 1, unitPrice: 100 }] }),
  });
  const quoteBody: any = await createQuoteRes.json();
  ok(createQuoteRes.status === 201 && typeof quoteBody.rowVersion === 'number', 'POST /quotes response includes a numeric rowVersion', quoteBody);
  const quoteDbRow = await pool.query(`SELECT row_version FROM rel_quotes WHERE id = $1`, [quoteBody.id]);
  ok(quoteDbRow.rows[0].row_version === quoteBody.rowVersion, 'the returned rowVersion matches the actual DB row_version for the new quote');

  console.log('\n[Create-stub versions] POST /quotes/:id/convert-to-job response.jobRowVersion matches the real DB row_version');
  const convertRes = await fetch(`${base}/api/relational/quotes/${quoteBody.id}/convert-to-job`, { method: 'POST', headers: authHeaders });
  const convertBody: any = await convertRes.json();
  ok(convertRes.status === 201 && typeof convertBody.jobRowVersion === 'number', 'POST convert-to-job response includes a numeric jobRowVersion', convertBody);
  const jobDbRow = await pool.query(`SELECT row_version FROM rel_jobs WHERE id = $1`, [convertBody.jobId]);
  ok(jobDbRow.rows[0].row_version === convertBody.jobRowVersion, 'the returned jobRowVersion matches the actual DB row_version for the new job');

  console.log('\n[Create-stub versions] POST /jobs/:id/create-invoice response.jobRowVersion matches the real DB row_version AFTER the invoice-creation update');
  const invoiceRes = await fetch(`${base}/api/relational/jobs/${convertBody.jobId}/create-invoice`, { method: 'POST', headers: authHeaders });
  const invoiceBody: any = await invoiceRes.json();
  ok(invoiceRes.status === 201 && typeof invoiceBody.jobRowVersion === 'number', 'POST create-invoice response includes a numeric jobRowVersion', invoiceBody);
  const jobDbRowAfter = await pool.query(`SELECT row_version FROM rel_jobs WHERE id = $1`, [convertBody.jobId]);
  ok(jobDbRowAfter.rows[0].row_version === invoiceBody.jobRowVersion, 'the returned jobRowVersion matches the actual DB row_version after create-invoice bumped it');
  ok(jobDbRowAfter.rows[0].row_version === jobDbRow.rows[0].row_version + 1, 'sanity: create-invoice bumped the job row_version by exactly 1 from its post-conversion value');

  console.log('\n[Create-stub versions] the fresh jobRowVersion (not the stale post-conversion one) is what a following edit must use');
  const editWithStaleVersion = await fetch(`${base}/api/relational/jobs/${convertBody.jobId}`, {
    method: 'PUT', headers: authHeaders,
    body: JSON.stringify({ expectedVersion: convertBody.jobRowVersion, notes: 'This would be a false stale_record conflict if sent' }),
  });
  ok(editWithStaleVersion.status !== 200, 'confirms the version DID change from convert-to-job\'s value — using it (as the pre-fix stub would have) would 409', String(editWithStaleVersion.status));
  const editWithFreshVersion = await fetch(`${base}/api/relational/jobs/${convertBody.jobId}`, {
    method: 'PUT', headers: authHeaders,
    body: JSON.stringify({ expectedVersion: invoiceBody.jobRowVersion, notes: 'Edited using the freshly-returned jobRowVersion' }),
  });
  const editBody: any = await editWithFreshVersion.json();
  ok(editWithFreshVersion.status === 200, 'using the freshly-returned jobRowVersion (the fix) succeeds with no conflict', editBody);

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
  console.error('[frontend-create-stub-versions-test] Fatal error:', err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
