/**
 * relational.frontend-quote-wiring.test.ts — STAGE 3 Phase 2 verification
 * (frontend quote editing wiring, including the linked-job sync cascade).
 *
 * Two parts, same structure as relational.frontend-job-wiring.test.ts:
 *   1. Source-text checks that QuotesPage.handleSave's isEdit branch now
 *      routes an existing-quote save through relationalApi.updateQuote()
 *      (-> services.ts's updateQuoteWithJobSync, "the ONE endpoint for
 *      edit a quote") when 'quotes' is relational-authoritative, using
 *      q._relId/q._relRowVersion — never q.id, which is only the restored
 *      legacy JSON id — and never re-implementing the job-sync cascade a
 *      second time client-side.
 *   2. A REAL end-to-end proof, over real HTTP against a live server, for
 *      a quote AND its linked job both BACKFILLED from historical JSON
 *      (so both .id fields differ from their real relational PKs) —
 *      confirming a field edit on the quote correctly cascades to the
 *      linked job's synced fields (value/discount/setupFee/lines/contact
 *      details), and that status/convertedJobId are never touched by this
 *      path (that's Mark Sent/Approve/Decline/Convert's job).
 *
 * Requires TEST_SERVER_URL_WITH_AUTHORITY for part 2 — skips that part
 * with a clear notice if unset, same convention as every other Stage 2/3
 * REST suite.
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
  console.log('\n[Frontend quote wiring] source-text checks — QuotesPage.handleSave isEdit branch');
  ok(/if\(isEdit && isRelationalAuthoritative\('quotes'\)\)\{/.test(src),
    'handleSave has a dedicated isEdit && isRelationalAuthoritative(\'quotes\') branch');
  ok(src.includes(`const result = await relationalApi.updateQuote(q._relId, q._relRowVersion, patch);`),
    'the edit branch calls relationalApi.updateQuote with q._relId/q._relRowVersion');
  ok(src.includes(`if(linkedJob && linkedJob._relRowVersion !== undefined) patch.expectedJobVersion = linkedJob._relRowVersion;`),
    'the linked job\'s row version is passed as expectedJobVersion for dual optimistic concurrency');
  ok(!/documented, deliberate gap/.test(src),
    'the stale "documented, deliberate gap" comment about quote-edit job-sync has been removed now that it is wired');
  // Never re-implement the cascade's OWN write client-side via
  // forceSaveSections inside this branch — that would be the exact
  // "duplicate sync logic" the migration brief explicitly forbids.
  const branchStart = src.indexOf(`if(isEdit && isRelationalAuthoritative('quotes')){`);
  const jsonPathMarker = `let nextQuotes;`;
  const jsonPathStart = branchStart === -1 ? -1 : src.indexOf(jsonPathMarker, branchStart);
  const editBranchText = (branchStart !== -1 && jsonPathStart !== -1) ? src.slice(branchStart, jsonPathStart) : '';
  ok(editBranchText.length > 0 && !editBranchText.includes('forceSaveSections'),
    'the relational edit branch never calls forceSaveSections — updateQuoteWithJobSync is the ONLY write, server-side');
}

async function resetRelationalTables() {
  await pool.query(`
    TRUNCATE rel_payments, rel_job_line_items, rel_jobs, rel_quote_line_items, rel_quotes, rel_customers
    RESTART IDENTITY CASCADE
  `);
  await pool.query(`DELETE FROM quote_conversions`);
  await pool.query(`UPDATE relational_cutover SET enabled = false, enabled_at = NULL, enabled_by = NULL`);
}

async function runEndToEndProof() {
  const base = process.env.TEST_SERVER_URL_WITH_AUTHORITY;
  if (!base) {
    console.log('\n[Frontend quote wiring] end-to-end proof SKIPPED — TEST_SERVER_URL_WITH_AUTHORITY not set. See test runner instructions.');
    return;
  }

  await resetRelationalTables();
  await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section IN ('quotes','jobs')`);

  // A quote AND its linked job, both BACKFILLED with legacy ids guaranteed
  // to differ from whatever relational PKs backfill.ts assigns on this
  // freshly-truncated pair of tables (both start their own sequence at 1).
  const tmpPath = path.resolve('/tmp/frontend-quote-wiring-fixture.json');
  fs.writeFileSync(tmpPath, JSON.stringify({
    quotes: [{
      id: 666100, num: 'SQ-WIRETEST', co: '2', client: 'Frontend Quote Wiring Co',
      contact: 'Old Contact', email: 'old@example.com', tel: '0210000000', address: 'Old Address', vatNum: '',
      lines: [{ desc: 'Original line', qty: 1, unitPrice: 1000, subtotal: 1000 }],
      setupFee: '', discount: '', convertedJobId: 666101,
    }],
    jobs: [{
      id: 666101, num: 'SNS-WIRETEST-Q', co: '2', client: 'Frontend Quote Wiring Co',
      desc: 'From quote', status: 'quote_approved', stage: 4, value: 1150,
      quoteNum: 'SQ-WIRETEST', notes: '',
      lines: [{ desc: 'Original line', qty: 1, unitPrice: 1000, subtotal: 1000 }],
    }],
  }));
  await runBackfill({ apply: true, sourceFile: tmpPath });

  const quoteRow = await pool.query(`SELECT id, row_version FROM rel_quotes WHERE source_id = '666100'`);
  const jobRow = await pool.query(`SELECT id, row_version FROM rel_jobs WHERE source_id = '666101'`);
  const quoteRelId = quoteRow.rows[0].id, quoteRowVersion = quoteRow.rows[0].row_version;
  const jobRelId = jobRow.rows[0].id, jobRowVersion = jobRow.rows[0].row_version;
  ok(String(quoteRelId) !== '666100' && String(jobRelId) !== '666101',
    'sanity check: both relational PKs genuinely differ from their legacy ids', { quoteRelId, jobRelId });

  const token = await login(base);
  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  console.log('\n[Frontend quote wiring] end-to-end: exactly what handleSave() now sends for an edited quote with a linked job');
  const patch = {
    expectedVersion: quoteRowVersion,
    customerNameRaw: 'Frontend Quote Wiring Co', contactPerson: 'New Contact', email: 'new@example.com',
    phone: '0219999999', address: 'New Address', vatNumber: '',
    notes: 'Edited via the wired frontend save path', terms: '', salesperson: '', preparedBy: '', poRef: '', reference: '',
    setupFee: 100, discountPct: 10,
    lines: [{ desc: 'Updated line', qty: 2, unitPrice: 600, unit: null, itemId: null }],
    expectedJobVersion: jobRowVersion,
  };
  const putRes = await fetch(`${base}/api/relational/quotes/${quoteRelId}`, { method: 'PUT', headers: authHeaders, body: JSON.stringify(patch) });
  const putBody = await putRes.json();
  ok(putRes.status === 200, 'the quote edit succeeds against the REAL relational PK', JSON.stringify(putBody));
  ok(String(putBody.jobId) === String(jobRelId), 'the response correctly identifies the linked job by its relational PK', { returned: putBody.jobId, expected: jobRelId });

  const quoteAfter = await pool.query(`SELECT contact_person, notes, subtotal, vat_amount, total FROM rel_quotes WHERE id = $1`, [quoteRelId]);
  ok(quoteAfter.rows[0].contact_person === 'New Contact', 'the quote\'s own fields were updated');
  // 2 x 600 = 1200 subtotal, 10% discount = 120, +100 setup fee = 1180 after-disc, *1.15 = 1357
  ok(Math.abs(Number(quoteAfter.rows[0].total) - 1357) < 0.01, 'quote totals were correctly recomputed from the new lines/discount/setup fee', quoteAfter.rows[0]);

  const jobAfter = await pool.query(`SELECT contact_person, value, discount_pct, setup_fee, status FROM rel_jobs WHERE id = $1`, [jobRelId]);
  ok(jobAfter.rows[0].contact_person === 'New Contact', 'the linked job\'s contact details were synced from the quote edit');
  ok(Math.abs(Number(jobAfter.rows[0].value) - 1357) < 0.01, 'the linked job\'s value was recomputed to match the quote\'s new total', jobAfter.rows[0]);
  ok(jobAfter.rows[0].status === 'quote_approved', 'the linked job\'s status was NOT touched by this edit (status is not part of this cascade)');

  const jobLineAfter = await pool.query(`SELECT description, qty, unit_price FROM rel_job_line_items WHERE job_id = $1 ORDER BY line_index`, [jobRelId]);
  ok(jobLineAfter.rows.length === 1 && jobLineAfter.rows[0].description === 'Updated line', 'the linked job\'s line items were replaced to match the quote\'s new lines', jobLineAfter.rows);

  console.log('\n[Frontend quote wiring] proving the OLD bug would have failed: PUT /quotes/:legacyId (q.id, not q._relId) does NOT hit this quote');
  const badRes = await fetch(`${base}/api/relational/quotes/666100`, {
    method: 'PUT', headers: authHeaders,
    body: JSON.stringify({ expectedVersion: quoteRowVersion + 1, notes: 'This should never land' }),
  });
  ok(badRes.status !== 200, 'a PUT using the legacy id (666100) as if it were the relational PK does NOT succeed', String(badRes.status));
  const stillOk = await pool.query(`SELECT notes FROM rel_quotes WHERE id = $1`, [quoteRelId]);
  ok(stillOk.rows[0].notes === 'Edited via the wired frontend save path', 'the real quote record is untouched by the bad (legacy-id) request');

  await resetRelationalTables();
  await pool.query(`UPDATE platform_state SET data = '{}'::jsonb, updated_at = NOW() WHERE id = 1`);
  fs.unlinkSync(tmpPath);
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
  console.error('[frontend-quote-wiring-test] Fatal error:', err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
