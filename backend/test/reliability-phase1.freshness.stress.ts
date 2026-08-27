/**
 * reliability-phase1.freshness.stress.ts
 * ──────────────────────────────────────
 * RELIABILITY PHASE 1 (2026-08-26) — proves the freshness signal and the
 * targeted authoritative read against a REAL local PostgreSQL, driving the
 * REAL Express app over HTTP. Every mutation goes through the canonical
 * endpoint; nothing is written with raw SQL, so what is proved here is what
 * the application actually does.
 *
 * It proves, specifically:
 *   - the token detects CREATE, UPDATE and DELETE;
 *   - an UPDATE that does NOT bump row_version is still detected (and that it
 *     is MAX(updated_at), not SUM(row_version), that catches it);
 *   - a DELETE is detected by COUNT(*) — and that MAX(updated_at) alone would
 *     NOT have caught it;
 *   - a quote-owned payment moves the payments token but NOT the quotes token,
 *     which is the whole reason a payments token exists;
 *   - repeated polls with no mutation return byte-identical tokens;
 *   - a second user sees a committed change, and a stale save is still refused;
 *   - purchaseOrders is excluded from freshness, and PO read behaviour is
 *     unchanged.
 *
 * SAFETY: refuses to run unless DATABASE_URL points at localhost/127.0.0.1 or
 * ALLOW_UNSAFE_TEST_DB=1 is set. It writes only through the application's own
 * endpoints and never touches production.
 *
 * Usage (from backend/):
 *   DATABASE_URL=postgresql://.../signacore_test RELATIONAL_AUTHORITY_ENABLED=true \
 *   npx ts-node --transpile-only test/reliability-phase1.freshness.stress.ts
 *
 * It expects the database to contain the two login accounts and the seeded
 * quotes/jobs/invoices the harness creates — see the README note in the Phase 1
 * report for the seeding helper.
 */
import { Client } from 'pg';
const PORT = process.env.TEST_PORT || 4201;
if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '') && process.env.ALLOW_UNSAFE_TEST_DB !== '1') {
  console.error('[reliability-phase1] Refusing to run: DATABASE_URL does not look like a local test database.');
  process.exit(1);
}
process.env.PORT = String(PORT);
require('../src/index');

const BASE = 'http://127.0.0.1:' + PORT;
let pass = 0, fail = 0;
const failures = [];

function check(name: string, cond: any, detail?: string) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (detail ? ' -- ' + detail : '')); console.log('  FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
}

async function api(token: string | null, path: string, opts?: any) {
  opts = opts || {};
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method: opts.method || 'GET', headers, body: opts.body });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch (e) { /* non-JSON */ }
  return { status: res.status, json, text };
}
async function login(email: string) {
  const r = await api(null, '/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password: 'pw' }) });
  if (!r.json || !r.json.token) throw new Error('login failed for ' + email + ': ' + r.text.slice(0, 200));
  return r.json.token;
}
async function tokens(t: string): Promise<any> { const r = await api(t, '/api/freshness'); return r.json; }

async function sql(q: string, p?: any[]): Promise<any> {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try { return await c.query(q, p); } finally { await c.end(); }
}

async function main() {
  await new Promise((r) => setTimeout(r, 800));
  const A = await login('tester@example.com');
  const B = await login('tester2@example.com');

  console.log('\n=== STEP 4 — TOKEN PROOFS (via the canonical endpoints) ===');

  // ── CREATE ────────────────────────────────────────────────────────────────
  let t0 = await tokens(A);
  const created = await api(A, '/api/relational/quotes', {
    method: 'POST',
    body: JSON.stringify({
      companyCode: '2', customerNameRaw: 'Token Proof Co',
      lines: [{ description: 'Proof line', qty: 1, unitPrice: 100, pieces: 1 }],
    }),
  });
  check('CREATE quote returns 201', created.status === 201, 'status ' + created.status + ' ' + created.text.slice(0, 160));
  let t1 = await tokens(A);
  check('9. token DETECTS CREATE (quotes token changed)', t0.sections.quotes !== t1.sections.quotes,
    t0.sections.quotes + ' -> ' + t1.sections.quotes);
  const newQuoteId = created.json && created.json.id;
  let newQuoteVersion = created.json && created.json.rowVersion;

  // ── UPDATE (bumps row_version) ────────────────────────────────────────────
  t0 = t1;
  const upd = await api(A, '/api/relational/quotes/' + newQuoteId, {
    method: 'PUT', body: JSON.stringify({ expectedVersion: newQuoteVersion, notes: 'edited once' }),
  });
  check('UPDATE quote returns 200', upd.status === 200, upd.text.slice(0, 160));
  newQuoteVersion = upd.json && upd.json.rowVersion;
  t1 = await tokens(A);
  check('10. token DETECTS UPDATE (quotes token changed)', t0.sections.quotes !== t1.sections.quotes,
    t0.sections.quotes + ' -> ' + t1.sections.quotes);

  // ── UPDATE that does NOT bump row_version ────────────────────────────────
  // recomputeOwnerPaymentStatus writes rel_jobs.invoice_status with no
  // row_version bump. If the token relied on SUM(row_version) alone it would
  // miss this entirely; MAX(updated_at) is what catches it.
  const jobRow = await sql("SELECT id, row_version FROM rel_jobs ORDER BY id LIMIT 1");
  const jobId = jobRow.rows[0].id;
  const beforeJobRv = await sql('SELECT SUM(row_version) s, MAX(updated_at) u FROM rel_jobs');
  t0 = await tokens(A);
  const payJob = await api(A, '/api/relational/payments', {
    method: 'POST', body: JSON.stringify({ ownerType: 'job', ownerId: Number(jobId), amount: 1, method: 'EFT' }),
  });
  check('payment against a JOB returns 201', payJob.status === 201, payJob.text.slice(0, 160));
  t1 = await tokens(A);
  const afterJobRv = await sql('SELECT SUM(row_version) s, MAX(updated_at) u FROM rel_jobs');
  check('10b. an UPDATE that does NOT bump row_version is still detected',
    t0.sections.jobs !== t1.sections.jobs,
    'sum ' + beforeJobRv.rows[0].s + '->' + afterJobRv.rows[0].s + ' ; token ' + t0.sections.jobs + ' -> ' + t1.sections.jobs);
  check('10c. ...and it was MAX(updated_at), not SUM(row_version), that moved',
    String(beforeJobRv.rows[0].s) === String(afterJobRv.rows[0].s)
      && String(beforeJobRv.rows[0].u) !== String(afterJobRv.rows[0].u),
    'sum unchanged=' + (String(beforeJobRv.rows[0].s) === String(afterJobRv.rows[0].s))
      + ' updated_at moved=' + (String(beforeJobRv.rows[0].u) !== String(afterJobRv.rows[0].u)));

  // ── QUOTE-OWNED PAYMENT: the specific case only a payments token catches ──
  t0 = await tokens(A);
  const quoteForPay = await sql('SELECT id FROM rel_quotes ORDER BY id LIMIT 1');
  const payQuote = await api(A, '/api/relational/payments', {
    method: 'POST', body: JSON.stringify({ ownerType: 'quote', ownerId: Number(quoteForPay.rows[0].id), amount: 5, method: 'EFT' }),
  });
  check('payment against a QUOTE returns 201', payQuote.status === 201, payQuote.text.slice(0, 160));
  t1 = await tokens(A);
  check('payments token changed for a quote-owned payment', t0.sections.payments !== t1.sections.payments);
  check('...and the quotes token did NOT — which is exactly why a payments token is required',
    t0.sections.quotes === t1.sections.quotes,
    'quotes ' + t0.sections.quotes + ' -> ' + t1.sections.quotes);

  // ── DELETE ────────────────────────────────────────────────────────────────
  // Deleted through the canonical delete endpoint, and deliberately NOT the
  // most recently touched row, so this also proves MAX(updated_at) alone is
  // insufficient.
  const delTarget = await sql("SELECT id, row_version FROM rel_jobs WHERE invoice_num IS NULL ORDER BY id DESC LIMIT 1");
  const delId = delTarget.rows[0].id, delVer = delTarget.rows[0].row_version;
  const beforeDel = await sql('SELECT COUNT(*) c, MAX(updated_at) u FROM rel_jobs');
  t0 = await tokens(A);
  const del = await api(A, '/api/relational/jobs/' + delId, {
    method: 'DELETE', body: JSON.stringify({ expectedVersion: delVer }),
  });
  check('I. DELETE job through the canonical path returns 200', del.status === 200, del.text.slice(0, 200));
  t1 = await tokens(A);
  const afterDel = await sql('SELECT COUNT(*) c, MAX(updated_at) u FROM rel_jobs');
  check('11. token DETECTS DELETE (jobs token changed)', t0.sections.jobs !== t1.sections.jobs,
    t0.sections.jobs + ' -> ' + t1.sections.jobs);
  check('11b. ...and MAX(updated_at) alone would NOT have detected it — COUNT(*) is what moved',
    String(beforeDel.rows[0].u) === String(afterDel.rows[0].u)
      && String(beforeDel.rows[0].c) !== String(afterDel.rows[0].c),
    'max(updated_at) unchanged=' + (String(beforeDel.rows[0].u) === String(afterDel.rows[0].u))
      + ' count ' + beforeDel.rows[0].c + '->' + afterDel.rows[0].c);

  // ── J. MULTIPLE MUTATIONS IN ONE TRANSACTION / SAME TIMESTAMP ────────────
  t0 = await tokens(A);
  const convSrc = await sql("SELECT id FROM rel_quotes WHERE converted_job_id IS NULL AND status <> 'converted' ORDER BY id DESC LIMIT 1");
  const conv = await api(A, '/api/relational/quotes/' + convSrc.rows[0].id + '/convert-to-job', { method: 'POST' });
  check('J. quote->job conversion returns 201', conv.status === 201, conv.text.slice(0, 200));
  t1 = await tokens(A);
  check('J. one transaction touching quotes AND jobs moves BOTH tokens',
    t0.sections.quotes !== t1.sections.quotes && t0.sections.jobs !== t1.sections.jobs);

  // two rapid updates that may share a transaction timestamp
  const rq = await sql('SELECT id, row_version FROM rel_quotes ORDER BY id LIMIT 1');
  let v = rq.rows[0].row_version;
  t0 = await tokens(A);
  const u1 = await api(A, '/api/relational/quotes/' + rq.rows[0].id, { method: 'PUT', body: JSON.stringify({ expectedVersion: v, notes: 'rapid 1' }) });
  const u2 = await api(A, '/api/relational/quotes/' + rq.rows[0].id, { method: 'PUT', body: JSON.stringify({ expectedVersion: u1.json.rowVersion, notes: 'rapid 2' }) });
  t1 = await tokens(A);
  check('J. two rapid successive updates still move the token', u2.status === 200 && t0.sections.quotes !== t1.sections.quotes);

  // ── H. NO CHANGE ─────────────────────────────────────────────────────────
  const h1 = await tokens(A);
  const h2 = await tokens(A);
  const h3 = await tokens(A);
  check('H. repeated polls with no mutation return IDENTICAL tokens',
    JSON.stringify(h1.sections) === JSON.stringify(h2.sections) && JSON.stringify(h2.sections) === JSON.stringify(h3.sections));
  check('H. platform_state revision also unchanged across those polls', h1.platformState === h3.platformState);

  console.log('\n=== STEP 15 — MULTI-USER SCENARIOS ===');

  // ── A. SAME USER SAVE ────────────────────────────────────────────────────
  const qA = await sql('SELECT id, row_version FROM rel_quotes ORDER BY id LIMIT 1 OFFSET 3');
  const saveA = await api(A, '/api/relational/quotes/' + qA.rows[0].id, {
    method: 'PUT', body: JSON.stringify({ expectedVersion: qA.rows[0].row_version, notes: 'A saved this' }),
  });
  check('A. saver gets 200 and a NEW rowVersion back',
    saveA.status === 200 && saveA.json.rowVersion === qA.rows[0].row_version + 1,
    'v ' + qA.rows[0].row_version + ' -> ' + (saveA.json && saveA.json.rowVersion));
  const readBack = await api(A, '/api/relational/sections?names=quotes');
  const qaRow = readBack.json.data.quotes.find((x: any) => Number(x._relId) === Number(qA.rows[0].id));
  check('A. the authoritative read immediately shows the saved value and version',
    qaRow && qaRow.notes === 'A saved this' && qaRow._relRowVersion === saveA.json.rowVersion);

  // ── B. SECOND USER SEES IT WITHIN THE BOUNDED INTERVAL ───────────────────
  const bBefore = await tokens(B);
  const qB = await sql('SELECT id, row_version FROM rel_quotes ORDER BY id LIMIT 1 OFFSET 4');
  const saveA2 = await api(A, '/api/relational/quotes/' + qB.rows[0].id, {
    method: 'PUT', body: JSON.stringify({ expectedVersion: qB.rows[0].row_version, notes: 'visible to B' }),
  });
  check('B. A saves successfully', saveA2.status === 200);
  const bAfter = await tokens(B);
  check('B. B\'s next freshness check sees the quotes token change',
    bBefore.sections.quotes !== bAfter.sections.quotes);
  const bRead = await api(B, '/api/relational/sections?names=quotes');
  const bRow = bRead.json.data.quotes.find((x: any) => Number(x._relId) === Number(qB.rows[0].id));
  check('B. B\'s targeted refetch returns A\'s committed value', bRow && bRow.notes === 'visible to B');

  // ── D. STALE SAVE IS REFUSED ─────────────────────────────────────────────
  const staleSave = await api(B, '/api/relational/quotes/' + qB.rows[0].id, {
    method: 'PUT', body: JSON.stringify({ expectedVersion: qB.rows[0].row_version, notes: 'B overwrites A' }),
  });
  check('D. B saving the ORIGINAL expectedVersion is refused with 409 stale_record',
    staleSave.status === 409 && staleSave.json && staleSave.json.type === 'stale_record',
    'status ' + staleSave.status + ' ' + staleSave.text.slice(0, 140));
  const afterStale = await api(A, '/api/relational/sections?names=quotes');
  const stillA = afterStale.json.data.quotes.find((x: any) => Number(x._relId) === Number(qB.rows[0].id));
  check('D. A\'s committed value survives the refused save', stillA && stillA.notes === 'visible to B');

  // ── targeted read is gated and never leaks a JSON section ────────────────
  const notCut = await api(A, '/api/relational/sections?names=customers,quickRates,payments');
  check('targeted read refuses sections that are not cut over',
    notCut.status === 200 && Object.keys(notCut.json.data).length === 0
      && Array.isArray(notCut.json.notCutOver) && notCut.json.notCutOver.length === 3,
    notCut.text.slice(0, 200));
  const unknownSec = await api(A, '/api/relational/sections?names=notARealSection');
  check('targeted read reports an unknown section instead of guessing',
    unknownSec.status === 200 && unknownSec.json.unknown && unknownSec.json.unknown[0] === 'notARealSection');
  const noNames = await api(A, '/api/relational/sections');
  check('targeted read requires names', noNames.status === 400);

  // ── freshness is authenticated ───────────────────────────────────────────
  const unauth = await api(null, '/api/freshness');
  check('freshness endpoint requires authentication', unauth.status === 401);
  const unauthSec = await api(null, '/api/relational/sections?names=quotes');
  check('targeted read requires authentication', unauthSec.status === 401);

  // ── PO EXCLUSION EVIDENCE ────────────────────────────────────────────────
  const fresh = await tokens(A);
  check('6. purchaseOrders is NOT reported as a freshness section',
    !Object.prototype.hasOwnProperty.call(fresh.sections, 'purchaseOrders'),
    Object.keys(fresh.sections).join(','));
  const poRel = await sql('SELECT COUNT(*) c FROM rel_purchase_orders');
  const ps = await api(A, '/api/platform-state');
  check('6. PO read behaviour is unchanged: the overlay still serves the relational (empty) set',
    Array.isArray(ps.json.data.purchaseOrders) && ps.json.data.purchaseOrders.length === Number(poRel.rows[0].c),
    'relational POs=' + poRel.rows[0].c + ' rendered=' + (ps.json.data.purchaseOrders || []).length);

  console.log('\n=== STEP 17 — REGRESSION ===');
  const regressionQuote = await api(A, '/api/relational/quotes', {
    method: 'POST',
    body: JSON.stringify({
      companyCode: '2', customerNameRaw: 'Regression Co', setupFee: 100, discountPct: 10,
      lines: [{ description: 'multi piece', qty: 2, unitPrice: 500, pieces: 3 }],
    }),
  });
  check('Quote create (pieces x qty x price + setup fee + discount)', regressionQuote.status === 201, regressionQuote.text.slice(0, 200));
  const rqTotals = await sql('SELECT subtotal, vat_amount, total FROM rel_quotes WHERE id=$1', [regressionQuote.json.id]);
  // 3 * 2 * 500 = 3000 ; -10% = 2700 ; +100 = 2800 ; VAT 420 ; total 3220
  check('Quote financial calculation is unchanged (3000 / -10% / +100 / VAT15 => 3220.00)',
    Number(rqTotals.rows[0].subtotal) === 3000 && Number(rqTotals.rows[0].total).toFixed(2) === '3220.00',
    JSON.stringify(rqTotals.rows[0]));

  const convert2 = await api(A, '/api/relational/quotes/' + regressionQuote.json.id + '/convert-to-job', { method: 'POST' });
  check('Quote -> Job conversion', convert2.status === 201, convert2.text.slice(0, 200));
  const newJobId = convert2.json.jobId;
  const jobRead = await sql('SELECT stage, status, value FROM rel_jobs WHERE id=$1', [newJobId]);
  check('Converted job keeps its lifecycle semantics (stage 4 / quote_approved)',
    jobRead.rows[0].stage === 4 && jobRead.rows[0].status === 'quote_approved', JSON.stringify(jobRead.rows[0]));

  const jv = await sql('SELECT row_version FROM rel_jobs WHERE id=$1', [newJobId]);
  const stageUp = await api(A, '/api/relational/jobs/' + newJobId, {
    method: 'PUT', body: JSON.stringify({ expectedVersion: jv.rows[0].row_version, stage: 8, status: 'completed' }),
  });
  check('Job stage transition', stageUp.status === 200, stageUp.text.slice(0, 200));
  const ensure1 = await api(A, '/api/relational/jobs/' + newJobId + '/ensure-invoice', { method: 'POST' });
  check('Completed -> ensureInvoiceForJob raises exactly one invoice', ensure1.status === 200 && ensure1.json.created === true,
    ensure1.text.slice(0, 200));
  const ensure2 = await api(A, '/api/relational/jobs/' + newJobId + '/ensure-invoice', { method: 'POST' });
  check('ensureInvoiceForJob is idempotent (second call creates nothing, reuses the same invoice)',
    ensure2.status === 200 && ensure2.json.created === false && ensure2.json.invoiceNumber === ensure1.json.invoiceNumber,
    ensure2.text.slice(0, 200));
  const invCount = await sql('SELECT COUNT(*) c FROM rel_invoices WHERE job_id=$1', [newJobId]);
  check('...and only ONE invoice row exists for that job', Number(invCount.rows[0].c) === 1);

  const secAll = await api(A, '/api/relational/sections?names=quotes,jobs,accInvoices,creditNotes,suppliers,inventory');
  check('Targeted read serves every cut-over section it is asked for',
    secAll.status === 200 && ['quotes', 'jobs', 'accInvoices', 'creditNotes', 'suppliers', 'inventory']
      .every((k: string) => Array.isArray(secAll.json.data[k])),
    Object.keys(secAll.json.data).join(','));
  const psFinal = await api(A, '/api/platform-state');
  check('Initial hydration still returns every JSON-owned section too',
    Array.isArray(psFinal.json.data.customers) && psFinal.json.data.customers.length === 1
      && Array.isArray(psFinal.json.data.quickRates),
    'customers=' + JSON.stringify(psFinal.json.data.customers));
  check('Hydration and the targeted read agree, record for record, on quotes',
    JSON.stringify(psFinal.json.data.quotes) === JSON.stringify(secAll.json.data.quotes));
  check('Hydration and the targeted read agree, record for record, on jobs',
    JSON.stringify(psFinal.json.data.jobs) === JSON.stringify(secAll.json.data.jobs));

  console.log('\n============================================');
  console.log(' PASSED: ' + pass + '   FAILED: ' + fail);
  if (failures.length) { console.log(' failures:'); for (const f of failures) console.log('   - ' + f); }
  console.log('============================================');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
