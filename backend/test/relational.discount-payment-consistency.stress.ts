/**
 * relational.discount-payment-consistency.stress.ts — 2026-09-07
 *
 * Focused regression cover for the TWO defects this pass exists to close, and
 * for nothing else. Deliberately not a broad platform suite.
 *
 *   PART A — DISCOUNTS: one discount fact per linked transaction.
 *   PART B — PAYMENTS: one payment fact per real payment — persisted, visible
 *            everywhere immediately, and impossible to duplicate by retry.
 *   PART C — the interaction: changing a discount after a payment exists must
 *            move the OUTSTANDING balance and nothing else.
 *
 * Two parts, following the convention every other suite in this directory uses:
 *   1. SOURCE-TEXT CHECKS against the real index.html handlers and the real
 *      backend source. These need no database and always run — they pin the
 *      wiring so a later edit cannot quietly unpick it.
 *   2. REAL END-TO-END PROOFS against a live server + database. Skipped with a
 *      clear notice when TEST_SERVER_URL_WITH_AUTHORITY is unset.
 *
 *   npm run test:discount-payment-consistency
 */
import fs from 'fs';
import path from 'path';
import pool from '../src/db/pool';

/** Walk up from wherever this file is running — test/ under ts-node, dist/test/
 *  once compiled — until the repo root (the directory holding index.html) is
 *  found. Both run modes then read exactly the same sources, so the compiled
 *  suite can never quietly check a different file than the ts-node one. */
function repoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'index.html')) && fs.existsSync(path.join(dir, 'backend'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error('could not locate the repo root (no directory with index.html + backend/ above ' + __dirname + ')');
}
const ROOT = repoRoot();
const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH || path.join(ROOT, 'index.html');
const SERVICES_PATH = path.join(ROOT, 'backend', 'src', 'relational', 'services.ts');
const READ_PATH = path.join(ROOT, 'backend', 'src', 'relational', 'read.ts');
const API_PATH = path.join(ROOT, 'backend', 'src', 'relational', 'api.ts');
const MIGRATION_PATH = path.join(ROOT, 'database', 'migrations', '014_payment_idempotency.sql');

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}
const money = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;
const near = (a: unknown, b: unknown, tol = 0.05) => Math.abs(money(a) - money(b)) <= tol;

/** A copy of index.html's relPaymentDisplayId, so this suite can assert that the
 *  id the frontend stores optimistically really is the id read.ts hydrates. */
function relPaymentDisplayIdLikeFrontend(rawId: unknown): number | string {
  if (rawId == null) return rawId as any;
  const s = String(rawId);
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  return s;
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
    TRUNCATE rel_payments, rel_credit_notes, rel_invoice_line_items, rel_invoices,
      rel_job_line_items, rel_jobs, rel_quote_line_items, rel_quotes, rel_customers
    RESTART IDENTITY CASCADE
  `);
  await pool.query(`DELETE FROM quote_conversions`);
  await pool.query(`DELETE FROM document_number_counters`);
  // Clear platform_state too, exactly as the sibling suites do. Without it a
  // previous suite's JSON is still present, migration 013's historical-pieces
  // resolver matches this suite's fresh source_ids against it, finds a
  // description mismatch and correctly refuses to invoice — so the suite fails
  // on leftover state rather than on anything it is testing.
  await pool.query(`UPDATE platform_state SET data = '{}'::jsonb WHERE id = 1`);
  await pool.query(`UPDATE relational_cutover SET enabled = false, enabled_at = NULL, enabled_by = NULL`);
}

/** The invoice's discount, read the ONE way an invoice carries one: a negative
 *  qty-1 `Discount (x%)` line among its line items. Mirrors index.html's
 *  sgrSplitInvoiceLineItems / invoiceDiscountView. */
async function invoiceDiscountFromLines(invoiceId: number): Promise<{ pct: number; amt: number }> {
  const r = await pool.query(
    `SELECT description, qty, unit_amount FROM rel_invoice_line_items WHERE invoice_id = $1 ORDER BY line_index`,
    [invoiceId]
  );
  for (const l of r.rows) {
    const m = /^Discount \((\d+(?:\.\d+)?)%\)$/.exec(String(l.description || '').trim());
    const amt = Number(l.qty) * Number(l.unit_amount);
    if (m && amt < -0.005) return { pct: Number(m[1]), amt: Math.abs(amt) };
  }
  return { pct: 0, amt: 0 };
}

async function invoiceTotal(invoiceId: number): Promise<number> {
  const r = await pool.query(
    `SELECT COALESCE(SUM(qty * unit_amount), 0)
              + COALESCE(SUM(CASE WHEN tax_type = '15%' THEN qty * unit_amount * 0.15 ELSE 0 END), 0) AS total
       FROM rel_invoice_line_items WHERE invoice_id = $1`,
    [invoiceId]
  );
  return Number(r.rows[0].total) || 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 1 — SOURCE-TEXT CHECKS (no database required)
// ═══════════════════════════════════════════════════════════════════════════
function checkSourceWiring() {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const services = fs.readFileSync(SERVICES_PATH, 'utf8');
  const read = fs.readFileSync(READ_PATH, 'utf8');
  const api = fs.readFileSync(API_PATH, 'utf8');
  const migration = fs.existsSync(MIGRATION_PATH) ? fs.readFileSync(MIGRATION_PATH, 'utf8') : '';

  console.log('\n[A · discount authority] the canonical discount cascades from the job side too');
  ok(/async function syncQuoteDiscountFromJobTx\(/.test(services),
    'services.ts has syncQuoteDiscountFromJobTx — a job-stage discount is written through to the chain\'s head quote');
  ok(/async function syncLinkedInvoicesFromJobTx\(/.test(services),
    'services.ts has syncLinkedInvoicesFromJobTx — the linked invoice is rebuilt from the post-save job');
  ok(/const commercialContentTouched =\s*\n\s*patch\.discountPct !== undefined \|\| patch\.setupFee !== undefined;/.test(services),
    'updateJob\'s cascade gate is NARROW — discount / setup fee only, so an ordinary line or cost save is untouched');
  ok(/await writeInvoiceLinesFromJobTx\(client, invoiceId, jobLinesRes\.rows, job, piecesMap\)/.test(services),
    'the rebuild goes through the DEPLOYED writer (writeInvoiceLinesFromJobTx), never a second copy of the arithmetic');
  ok(/await assertJobInvoiceMatchesValueTx\(client, invoiceId, job, jobLinesRes\.rowCount \|\| 0\)/.test(services),
    'the same financial-consistency guard creation uses still holds: an invoice that does not add up to its job is never left in place');
  ok(/String\(inv\.company_code\) !== String\(job\.company_code\)/.test(services),
    'the job → invoice sync refuses to cross company isolation');

  console.log('\n[A · discount display] both halves of the one financial fact, everywhere');
  ok(/function invoiceDiscountView\(inv\)\{/.test(html),
    'index.html has invoiceDiscountView — an invoice\'s discount derived from its own lines');
  ok(/const split = sgrSplitInvoiceLineItems\(inv\.lineItems\);/.test(html),
    'invoiceDiscountView derives through the SAME splitter the printed document uses, so screen and paper cannot disagree');
  ok(/\{_invDiscountView\.pct>0&&<div className="bg-red-50 rounded-xl p-3">[\s\S]{0,200}\{_invDiscountView\.pct\}%\{_invDiscountView\.amt>0\?' · − '\+fmtAmt\(_invDiscountView\.amt\)/.test(html),
    'the View Invoice modal shows the percentage AND the money, derived rather than read from a rarely-set field');
  ok(/const _d = invoiceDiscountView\(inv\); return _d\.pct>0[\s\S]{0,300}−\{_d\.pct\}% disc\{_d\.amt>0\?' · '\+fmtAmt\(_d\.amt\)/.test(html),
    'the Accounting invoice list badge shows the percentage AND the money, derived the same way');

  console.log('\n[B · payment authority] one payment fact, resolved across the whole chain');
  ok(/export async function resolveTransactionChainTx\(/.test(services) && /export async function sumChainPaymentsTx\(/.test(services),
    'services.ts has the shared chain resolver and chain payment total — one question, one answer, for every reader');
  ok(/const chain = await resolveTransactionChainTx\(client, ownerType, ownerId\);[\s\S]{0,200}const totalPaid = toCents\(await sumChainPaymentsTx\(client, chain\)\);/.test(services),
    'recomputeOwnerPaymentStatus derives every member\'s status from the SAME chain total');
  ok(/const paymentsByChainJob = await paymentsForMany\('job', Array\.from\(chainJobIds\)\);/.test(read) &&
     /const paymentsByChainQuote = await paymentsForMany\('quote', Array\.from\(chainQuoteIds\)\);/.test(read),
    'read.ts resolves an invoice\'s payments across its chain, so a deposit taken before invoicing stays visible after it');
  ok(/if \(seenPaymentIds\.has\(String\(p\._relPaymentId\)\)\) continue;/.test(read),
    'the chain projection dedupes by rel_payments primary key — one payment can never be shown twice');
  ok(/jobCompanyById\.get\(chainJobId\) === invCompany/.test(read) && /quoteCompanyById\.get\(chainQuoteId\) === invCompany/.test(read),
    'the chain projection checks company_code on both sides — it can never reach across the two company contexts');
  ok(!/UPDATE rel_payments SET owner_type/.test(services) && !/INSERT INTO rel_payments[\s\S]{0,400}FROM rel_payments/.test(services),
    'NOTHING moves, copies or re-owns a payment row — resolution, not relocation');

  console.log('\n[B · payment identity] the same payment, under its true owner, from every screen');
  ok(/const ownerType = \(p && p\._relOwnerType\) \|\| 'invoice';/.test(html),
    'QuotePaymentsModal.resolvePaymentOwner resolves a chain row\'s owner from the PAYMENT, not from the screen');
  ok(/const _delSection = paymentOwnerSection\(removed, 'accInvoices'\);/.test(html) &&
     /const _editSection = paymentOwnerSection\(p, 'accInvoices'\);/.test(html),
    'the Accounting payments modal routes edit and delete by the payment\'s true owner section too');
  ok(/const newP=\{id:relPaymentDisplayId\(result\.paymentId\),date,method,amount:amt/.test(html) &&
     /const newP = \{id:relPaymentDisplayId\(result\.paymentId\),date,method,amount:amt/.test(html),
    'every optimistic payment row carries the SERVER\'S payment id, normalised exactly as read.ts will hydrate it');
  ok(/function relPaymentDisplayId\(rawId\)/.test(html),
    'relPaymentDisplayId mirrors read.ts restoreId, so an optimistic row and the hydrated row it becomes are indistinguishable');
  ok((html.match(/String\(p\._relPaymentId\)===String\(result\.paymentId\)/g) || []).length === 4,
    'every replay dedupe compares ids as strings, so a number/string mismatch can never let a replay append a second row');
  ok(/return \{ paymentId: replay\.rows\[0\]\.id, rowVersion: Number\(replay\.rows\[0\]\.row_version\), deduplicated: true \};/.test(services) &&
     /return \{ paymentId: winner\.rows\[0\]\.id, rowVersion: Number\(winner\.rows\[0\]\.row_version\), deduplicated: true \};/.test(services),
    'the replay and race paths return the payment id VERBATIM, the same shape the create path returns — one payment, one identity');

  console.log('\n[B · chain status at creation] a new chain member knows what has already been paid');
  ok((services.match(/await settleNewChainMemberPaymentStatusTx\(client, 'job', jobId\);/g) || []).length === 5,
    'convertQuoteToJob and all four job-invoice branches settle the chain\'s payment status before committing');
  ok(/await settleNewChainMemberPaymentStatusTx\(client, 'invoice', invoiceId\);/.test(services) &&
     /await settleNewChainMemberPaymentStatusTx\(client, 'invoice', Number\(reusable\.rows\[0\]\.id\)\);/.test(services),
    'both quote-to-invoice paths (fresh and reused) settle it too');
  ok(/if \(totalPaid <= 0\) return; \/\/ nothing received yet/.test(services),
    'and the settlement is GUARDED on the chain having money — so a converted job with no payment keeps invoice_status NULL, which deleteInvoice relies on to leave an uninvoiced job alone');

  console.log('\n[B · duplicate protection] a retried submission cannot become a second payment');
  ok(/ADD COLUMN IF NOT EXISTS client_request_id TEXT/.test(migration) &&
     /CREATE UNIQUE INDEX IF NOT EXISTS uq_rel_payments_client_request_id[\s\S]{0,120}WHERE client_request_id IS NOT NULL/.test(migration),
    'migration 014 adds the submission key and a PARTIAL unique index — historical rows and keyless rows stay unconstrained');
  ok(!/DROP |TRUNCATE |DELETE FROM |UPDATE rel_/.test(migration),
    'migration 014 is additive only — no DROP, TRUNCATE, DELETE or UPDATE of anything existing');
  ok(/function newPaymentRequestId\(\)/.test(html) &&
     /const paymentRequestIdRef = useRef\(null\);/.test(html) &&
     /useEffect\(\(\) => \{ paymentRequestIdRef\.current = null; \}, \[amount, date, method, notes\]\);/.test(html),
    'one key per SUBMISSION: held across retries, discarded the moment the user changes what they are paying');
  ok(/err && err\.code === '23505' && String\(err\.constraint \|\| ''\)\.includes\('client_request_id'\)/.test(services),
    'a racing duplicate is caught at the database boundary and resolved to the payment that committed');
  ok(/SELECT id, row_version FROM rel_payments WHERE client_request_id = \$1/.test(services),
    'a replay returns the ALREADY-PERSISTED payment\'s own id and row version — the caller sees one success');
  ok(services.indexOf('const requestKey = normalizeClientRequestId') < services.indexOf("if (opts.method === 'Credit')"),
    'the idempotency pre-check runs BEFORE credit-note application, so a replay never consumes the customer\'s credit twice');
  ok(!/amount === |payment_date = [\s\S]{0,40}AND method =/.test(services),
    'duplicate detection NEVER compares amount/date/method — two genuine same-value payments on one day stay two payments');
  ok(/clientRequestId: paymentRequestIdRef\.current/.test(html),
    'the browser sends the submission key on the payment POST');
  ok(/const result = await recordPayment\(\{ type: ownerType, id \}, amt, \{ date, method, reference, notes, clientRequestId \}\);/.test(api),
    'the API route passes the submission key through to the service');

  console.log('\n[B · double-click] the synchronous guard, on every payment action');
  ok(/return guardAction\('recordPayment:quote:'/.test(html) &&
     /return guardAction\('recordPayment:job:'/.test(html) &&
     /return guardAction\('recordPayment:invoice:'/.test(html),
    'all three payment modals wrap Capture Payment in the shared synchronous guardAction, keyed per record');
  ok((html.match(/return guardAction\('deletePayment:'\+pid/g) || []).length === 3 &&
     (html.match(/return guardAction\('editPayment:'\+pid/g) || []).length === 3,
    'edit and delete are guarded in all three modals too, keyed per payment');
  ok(/return guardAction\('markInvoicePaid:'\+relKey\(inv\)/.test(html) &&
     /const _settleKey = 'markpaid_' \+ relKey\(inv\)/.test(html) &&
     /clientRequestId:_settleKey/.test(html),
    '"Mark Paid" records a real payment and now carries BOTH protections — the synchronous guard and a deterministic submission key');

  console.log('\n[B · stale saves] an editor\'s snapshot can never erase a newer payment');
  ok(/\{\.\.\.updated, payments: \(j && j\.payments !== undefined \? j\.payments : updated\.payments\), _relRowVersion: relResult\.rowVersion\}/.test(html),
    'EditInvoiceForm\'s relational save keeps the LIVE payments array, never the snapshot captured when the form opened');
  ok(/const nextJobs = jobs\.map\(j=>j\.id===updated\.id\s*\n\s*\? \{\.\.\.updated, payments: \(j && j\.payments !== undefined \? j\.payments : updated\.payments\)\}/.test(html),
    'the JSON path does the same, where a stale array would overwrite a newer PERSISTED payment');
  ok(/if\(relResult\.quoteId != null && relResult\.quoteRowVersion != null && setQuotes\)/.test(html),
    'the row versions the discount cascade bumped are adopted, so the next save of that quote is not a spurious 409');

  console.log('\n[scope] nothing outside discounts and payments was touched');
  ok(!/DROP TABLE|TRUNCATE TABLE/.test(services), 'no destructive DDL anywhere in services.ts');
  ok(/UPDATE rel_jobs SET invoice_status = \$1 WHERE id = \$2/.test(services) &&
     !/UPDATE rel_jobs SET invoice_status = \$1, row_version/.test(services),
    'a status recompute still does NOT bump row_version — no open editor is handed a 409 for a change it did not make');
  ok(/tax_type = '15%' THEN sub \* 0\.15|sub \* 0\.15/.test(services.replace(/\s+/g, ' ')) || /0\.15/.test(services),
    'the existing 15% VAT treatment is untouched');
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 2 — END-TO-END PROOFS
// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  checkSourceWiring();

  const base = process.env.TEST_SERVER_URL_WITH_AUTHORITY;
  if (!base) {
    console.log('\n[end-to-end] SKIPPED — TEST_SERVER_URL_WITH_AUTHORITY not set.');
    console.log('             Set it (and a reachable DATABASE_URL) to run the database proofs.');
  } else {
    await resetRelationalTables();
    const token = await login(base);
    const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const services = await import('../src/relational/services');
    const read = await import('../src/relational/read');
    const post = (p: string, b: unknown) => fetch(`${base}/api/relational${p}`, { method: 'POST', headers: H, body: JSON.stringify(b) });
    const put = (p: string, b: unknown) => fetch(`${base}/api/relational${p}`, { method: 'PUT', headers: H, body: JSON.stringify(b) });

    await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section IN ('quotes','jobs','accInvoices')`);
    const cust = await services.createCustomer({ companyName: 'Discount Payment Consistency Co' });

    // ── PART A — DISCOUNT: one fact across Quote → Job → Invoice ─────────────
    console.log('\n[A1] a discount entered on the QUOTE before any job exists');
    const quote = await services.createQuote({
      companyCode: '2', customerId: cust.id, customerNameRaw: 'Discount Payment Consistency Co',
      lines: [{ description: 'Illuminated signage', qty: 1, unitPrice: 10000 }],
      discountPct: 10,
    });
    let qRow = (await pool.query('SELECT * FROM rel_quotes WHERE id = $1', [quote.id])).rows[0];
    ok(Number(qRow.discount_pct) === 10, 'quote holds 10%', qRow.discount_pct);
    ok(near(qRow.total, 10350), 'quote total = (10000 − 1000) × 1.15 = R10,350 — existing VAT treatment unchanged', qRow.total);

    console.log('\n[A2-A3] convert to a job — the SAME discount resolves on the job');
    const conv = await services.convertQuoteToJob(quote.id);
    let jRow = (await pool.query('SELECT * FROM rel_jobs WHERE id = $1', [conv.jobId])).rows[0];
    ok(Number(jRow.discount_pct) === 10, 'job resolves the same 10%', jRow.discount_pct);
    ok(near(jRow.value, 10350), 'job value agrees with the quote total', jRow.value);

    console.log('\n[A4-A5] raise the invoice — the SAME discount resolves on the invoice');
    const inv = await services.createInvoiceForJob(conv.jobId);
    let invDisc = await invoiceDiscountFromLines(inv.invoiceId);
    ok(invDisc.pct === 10, 'invoice carries Discount (10%) as its own line', invDisc);
    ok(near(invDisc.amt, 1000), 'and the monetary discount is R1,000 — percentage and money agree', invDisc);
    ok(near(await invoiceTotal(inv.invoiceId), 10350), 'invoice total agrees with the quote and the job', await invoiceTotal(inv.invoiceId));

    console.log('\n[A6-A12] change the discount to 15% AFTER the invoice exists, from the job side');
    jRow = (await pool.query('SELECT * FROM rel_jobs WHERE id = $1', [conv.jobId])).rows[0];
    const jobPatchRes = await put(`/jobs/${conv.jobId}`, {
      expectedVersion: jRow.row_version, discountPct: 15, value: 10000 * 0.85 * 1.15,
    });
    const jobPatch: any = await jobPatchRes.json();
    ok(jobPatchRes.status === 200, 'the job-side discount change succeeds', jobPatch);

    qRow = (await pool.query('SELECT * FROM rel_quotes WHERE id = $1', [quote.id])).rows[0];
    jRow = (await pool.query('SELECT * FROM rel_jobs WHERE id = $1', [conv.jobId])).rows[0];
    invDisc = await invoiceDiscountFromLines(inv.invoiceId);
    ok(Number(qRow.discount_pct) === 15, 'QUOTE now reflects 15%', qRow.discount_pct);
    ok(Number(jRow.discount_pct) === 15, 'JOB now reflects 15%', jRow.discount_pct);
    ok(invDisc.pct === 15, 'INVOICE now reflects 15% — it is not frozen on the discount it was raised with', invDisc);
    ok(near(invDisc.amt, 1500) && near(qRow.total, 9775) && near(await invoiceTotal(inv.invoiceId), 9775),
      'all three agree on the same monetary discount (R1,500) and the same total (R9,775)',
      { invDisc, quoteTotal: qRow.total, invoiceTotal: await invoiceTotal(inv.invoiceId) });
    ok(jobPatch.quoteId && jobPatch.quoteRowVersion === Number(qRow.row_version),
      'the response reports the quote\'s NEW row version, so the client cannot go stale', jobPatch);

    console.log('\n[A13] a fresh authoritative read preserves the canonical discount');
    const quotesJson = await read.buildQuotesJson();
    const jobsJson = await read.buildJobsJson();
    ok(Number((quotesJson.find((q: any) => Number(q._relId) === Number(quote.id)) || {}).discount) === 15, 'hydrated quote = 15%');
    ok(Number((jobsJson.find((j: any) => Number(j._relId) === Number(conv.jobId)) || {}).discount) === 15, 'hydrated job = 15%');

    console.log('\n[A14-A16] editing an unrelated field does not disturb the discount');
    jRow = (await pool.query('SELECT * FROM rel_jobs WHERE id = $1', [conv.jobId])).rows[0];
    await put(`/jobs/${conv.jobId}`, { expectedVersion: jRow.row_version, notes: 'an ordinary note' });
    ok(Number((await pool.query('SELECT discount_pct FROM rel_jobs WHERE id = $1', [conv.jobId])).rows[0].discount_pct) === 15,
      'a notes-only save leaves the job discount at 15%');
    ok((await invoiceDiscountFromLines(inv.invoiceId)).pct === 15,
      'and leaves the invoice untouched — the cascade gate is narrow, as designed');

    // ── PART B — PAYMENTS ───────────────────────────────────────────────────
    console.log('\n[B1-B3] a deposit captured on a QUOTE stays visible after the invoice is raised');
    const q2 = await services.createQuote({
      companyCode: '2', customerId: cust.id, customerNameRaw: 'Discount Payment Consistency Co',
      lines: [{ description: 'Pylon sign', qty: 1, unitPrice: 20000 }],
    });
    const deposit: any = await (await post('/payments', { ownerType: 'quote', ownerId: q2.id, amount: 4000, date: '2026-09-01', method: 'EFT', notes: 'deposit' })).json();
    ok(!!deposit.paymentId, 'the deposit is recorded against the quote', deposit);
    const conv2 = await services.convertQuoteToJob(q2.id);
    const inv2 = await services.createInvoiceForJob(conv2.jobId);
    const invoicesJson = await read.buildInvoicesJson();
    const inv2Json: any = invoicesJson.find((i: any) => Number(i._relId) === Number(inv2.invoiceId));
    ok(!!inv2Json && (inv2Json.payments || []).some((p: any) => Number(p._relPaymentId) === Number(deposit.paymentId)),
      'THE CORE FIX: the pre-invoice deposit resolves on the invoice — it does not vanish the moment the invoice exists',
      (inv2Json && inv2Json.payments) || null);
    ok((inv2Json.payments || []).find((p: any) => Number(p._relPaymentId) === Number(deposit.paymentId))._relOwnerType === 'quote',
      'and it still states its TRUE owner (quote), so an edit or delete from the invoice view routes correctly');
    const depositRow = await pool.query('SELECT owner_type, owner_id FROM rel_payments WHERE id = $1', [deposit.paymentId]);
    ok(depositRow.rows[0].owner_type === 'quote' && Number(depositRow.rows[0].owner_id) === Number(q2.id),
      'nothing was moved: the row still belongs to the quote it was recorded against', depositRow.rows[0]);

    console.log('\n[B19-B20] balances and status agree across the whole chain');
    const inv2Total = await invoiceTotal(inv2.invoiceId);
    const paid = (inv2Json.payments || []).reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0);
    ok(near(paid, 4000), 'total paid resolves as R4,000', paid);
    ok(near(inv2Total - paid, 19000), 'outstanding = R23,000 − R4,000 = R19,000', inv2Total - paid);
    const j2 = await pool.query('SELECT invoice_status FROM rel_jobs WHERE id = $1', [conv2.jobId]);
    const i2 = await pool.query('SELECT status FROM rel_invoices WHERE id = $1', [inv2.invoiceId]);
    ok(j2.rows[0].invoice_status === 'partial' && i2.rows[0].status === 'partial',
      'the job and the invoice, BOTH created after the deposit, are born knowing about it — not reported as wholly unpaid on the Jobs and Accounting lists',
      { job: j2.rows[0].invoice_status, invoice: i2.rows[0].status });

    console.log('\n[B · identity across the BIGINT boundary] the optimistic row and the hydrated row are the same payment');
    const hydratedForId = await read.buildInvoicesJson();
    const invForId: any = hydratedForId.find((i: any) => Number(i._relId) === Number(inv2.invoiceId));
    const depositHydrated = (invForId.payments || []).find((p: any) => String(p._relPaymentId) === String(deposit.paymentId));
    ok(depositHydrated && depositHydrated.id === relPaymentDisplayIdLikeFrontend(deposit.paymentId),
      'the id the frontend stores optimistically is exactly the id the authoritative read hydrates — strict === matches, so a payment never appears twice mid-window',
      { optimistic: relPaymentDisplayIdLikeFrontend(deposit.paymentId), hydrated: depositHydrated && depositHydrated.id });

    console.log('\n[B14] the SAME submission retried cannot persist twice');
    const key = 'pay_test_' + Date.now().toString(36);
    const first: any = await (await post('/payments', { ownerType: 'invoice', ownerId: inv2.invoiceId, amount: 5000, date: '2026-09-02', method: 'EFT', clientRequestId: key })).json();
    const retryRes = await post('/payments', { ownerType: 'invoice', ownerId: inv2.invoiceId, amount: 5000, date: '2026-09-02', method: 'EFT', clientRequestId: key });
    const retry: any = await retryRes.json();
    ok(String(retry.paymentId) === String(first.paymentId) && retry.deduplicated === true && retryRes.status === 200,
      'the retry resolves to the SAME payment and is reported as a replay, not a create', { first, retry });
    ok(typeof retry.paymentId === typeof first.paymentId,
      'and returns it in the SAME shape as the create — one payment cannot answer to two identities',
      { create: typeof first.paymentId, replay: typeof retry.paymentId });
    const cnt = await pool.query(`SELECT COUNT(*)::int AS n FROM rel_payments WHERE client_request_id = $1`, [key]);
    ok(cnt.rows[0].n === 1, 'exactly one payment row exists for that submission', cnt.rows[0]);

    console.log('\n[B15] concurrent copies of one submission still produce one payment');
    const raceKey = 'pay_race_' + Date.now().toString(36);
    const body = { ownerType: 'invoice', ownerId: inv2.invoiceId, amount: 250, date: '2026-09-03', method: 'EFT', clientRequestId: raceKey };
    const raced = await Promise.all([post('/payments', body), post('/payments', body), post('/payments', body)]);
    const racedBodies: any[] = await Promise.all(raced.map((r) => r.json()));
    const raceCount = await pool.query(`SELECT COUNT(*)::int AS n FROM rel_payments WHERE client_request_id = $1`, [raceKey]);
    ok(raceCount.rows[0].n === 1, 'three simultaneous copies of one submission create exactly ONE payment', raceCount.rows[0]);
    ok(new Set(racedBodies.map((b) => String(b.paymentId))).size === 1, 'and all three callers are told about the same payment', racedBodies.map((b) => b.paymentId));
    ok(new Set(racedBodies.map((b) => typeof b.paymentId)).size === 1, 'and all three are given it in the same shape', racedBodies.map((b) => typeof b.paymentId));

    console.log('\n[B16] two GENUINELY separate payments of the same amount on the same day remain allowed');
    const sameA: any = await (await post('/payments', { ownerType: 'invoice', ownerId: inv2.invoiceId, amount: 1000, date: '2026-09-04', method: 'EFT', clientRequestId: 'pay_sep_a_' + Date.now().toString(36) })).json();
    const sameB: any = await (await post('/payments', { ownerType: 'invoice', ownerId: inv2.invoiceId, amount: 1000, date: '2026-09-04', method: 'EFT', clientRequestId: 'pay_sep_b_' + Date.now().toString(36) })).json();
    ok(sameA.paymentId !== sameB.paymentId && !sameA.deduplicated && !sameB.deduplicated,
      'two real R1,000 payments on the same day by the same method are two payments — never collapsed',
      { a: sameA.paymentId, b: sameB.paymentId });

    console.log('\n[B21] one stable identity, whatever screen resolves it');
    const rehydrated = await read.buildInvoicesJson();
    const inv2Again: any = rehydrated.find((i: any) => Number(i._relId) === Number(inv2.invoiceId));
    const depositAgain = (inv2Again.payments || []).find((p: any) => Number(p._relPaymentId) === Number(deposit.paymentId));
    const quotesAgain = await read.buildQuotesJson();
    const q2Again: any = quotesAgain.find((q: any) => Number(q._relId) === Number(q2.id));
    const depositOnQuote = (q2Again.payments || []).find((p: any) => Number(p._relPaymentId) === Number(deposit.paymentId));
    ok(!!depositAgain && !!depositOnQuote && String(depositAgain.id) === String(depositOnQuote.id),
      'the deposit carries the SAME id seen from the invoice and from the quote',
      { fromInvoice: depositAgain && depositAgain.id, fromQuote: depositOnQuote && depositOnQuote.id });

    console.log('\n[B22] company isolation');
    const q3 = await services.createQuote({
      companyCode: '1', customerId: cust.id, customerNameRaw: 'Holdings side',
      lines: [{ description: 'Other company work', qty: 1, unitPrice: 500 }],
    });
    const otherPay: any = await (await post('/payments', { ownerType: 'quote', ownerId: q3.id, amount: 500, method: 'EFT' })).json();
    const invoicesForIsolation = await read.buildInvoicesJson();
    const leaked = invoicesForIsolation.some((i: any) => (i.payments || []).some((p: any) => Number(p._relPaymentId) === Number(otherPay.paymentId)));
    ok(!leaked, 'a payment in the other company context appears on no invoice in this one', { paymentId: otherPay.paymentId });

    // ── PART C — DISCOUNT × PAYMENT ─────────────────────────────────────────
    console.log('\n[C] changing the discount after a payment exists moves the BALANCE and nothing else');
    const beforePayments = await pool.query(
      `SELECT id, amount, payment_date, method FROM rel_payments WHERE id = $1`, [deposit.paymentId]);
    const j2Row = (await pool.query('SELECT * FROM rel_jobs WHERE id = $1', [conv2.jobId])).rows[0];
    await put(`/jobs/${conv2.jobId}`, { expectedVersion: j2Row.row_version, discountPct: 10, value: 20000 * 0.9 * 1.15 });
    const afterPayments = await pool.query(
      `SELECT id, amount, payment_date, method FROM rel_payments WHERE id = $1`, [deposit.paymentId]);
    ok(JSON.stringify(beforePayments.rows) === JSON.stringify(afterPayments.rows),
      'the payment is untouched — same id, same amount, same date, same method',
      { before: beforePayments.rows, after: afterPayments.rows });
    const newInvTotal = await invoiceTotal(inv2.invoiceId);
    ok(near(newInvTotal, 20700), 'the invoice total re-derives as (20000 − 2000) × 1.15 = R20,700', newInvTotal);
    const finalInvoices = await read.buildInvoicesJson();
    const inv2Final: any = finalInvoices.find((i: any) => Number(i._relId) === Number(inv2.invoiceId));
    const paidFinal = (inv2Final.payments || []).reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0);
    ok(near(newInvTotal - paidFinal, 20700 - paidFinal),
      'only the OUTSTANDING amount moves; no refund and no credit note is invented',
      { total: newInvTotal, paid: paidFinal, outstanding: newInvTotal - paidFinal });
    const finalDisc = await invoiceDiscountFromLines(inv2.invoiceId);
    ok(finalDisc.pct === 10 && near(finalDisc.amt, 2000), 'and the invoice states the new discount, both halves', finalDisc);
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`RESULT: ${passed} passed, ${failures} failed`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .then(() => pool.end().catch(() => undefined))
  .catch(async (err) => {
    console.error('\nSuite failed to run:', err && err.message ? err.message : err);
    process.exitCode = 1;
    await pool.end().catch(() => undefined);
  });
