/**
 * relational.jobs-autosave-and-quote-invoice-repair.stress.ts
 * ───────────────────────────────────────────────────────────
 * Regression suite for the TWO confirmed live workflow defects reported on
 * 2026-08-25, with RELATIONAL_AUTHORITY_ENABLED=true and quotes/jobs/
 * accInvoices cut over (payments NOT cut over).
 *
 * ── ERROR 1 — "Create Invoice from Quote" on an approved quote ─────────────
 *     Invoice could NOT be created.
 *     quote 371 has no proforma reservation to finalise
 *
 *   ROOT CAUSE. index.html's QuotesPage.createInvoiceFromQuote had exactly ONE
 *   relational path: relationalApi.finalizeProforma -> POST
 *   /quotes/:id/finalize-proforma -> services.ts finalizeProformaToInvoice.
 *   That function exists solely to FINALISE AN EXISTING PRO-##### reservation
 *   and refuses outright when rel_quotes.proforma_num is NULL. Most approved
 *   quotes never have a proforma printed or emailed, so they carry no
 *   reservation and the button could not work for them — even though the JSON
 *   branch immediately below it in the same function has always handled that
 *   case by reserving a fresh invoice number. A cutover gap, not a business
 *   rule: nothing in the workflow requires a proforma first.
 *
 *   THE FIX. services.ts's createInvoiceFromQuoteTx is now the single writer
 *   for BOTH quote-invoicing workflows, reached by two entry points:
 *     - finalizeProformaToInvoice (mode 'proforma-only') — contract UNCHANGED:
 *       refuses a quote with no reservation, refuses a second finalisation;
 *     - createInvoiceFromQuote  (mode 'direct') — consumes the reservation when
 *       there is one, otherwise reserves a fresh number from the same atomic
 *       counter, and reuses this quote's existing invoice if it already has one.
 *   No proforma reservation is ever fabricated to satisfy the older function.
 *
 * ── ERROR 2 — Jobs page legacy autosave ────────────────────────────────────
 *     Save failed — Cannot save "jobs" here — the autosave path is not yet
 *     wired to relational persistence, and this section is now
 *     relational-authoritative. Your edit was NOT saved.
 *
 *   ROOT CAUSE, proven below from the shipped code rather than from the toast.
 *   The message is assertNoUnwiredRelationalSections firing from inside
 *   mergeAndSave (the generic 800ms debounced autosave), because
 *   locallyChangedSections found `jobs` differing from serverBaselineRef. The
 *   caller was App's global auto-lifecycle effect — the one that advances a job
 *   from Deposit Requested (4) to Deposit Received (5) once a payment is
 *   recorded, and from Completed (8) to Invoiced (9) once an invoice exists.
 *   It:
 *     (1) patched local state AND the baseline OPTIMISTICALLY, before the
 *         server confirmed anything (so a failed write left the baseline
 *         asserting a stage the server never accepted); and
 *     (2) on success ran
 *             setJobs(prev=>prev.map(... _relRowVersion: result.rowVersion ...))
 *         with NO matching syncRelationalBaseline. locallyChangedSections
 *         compares with JSON.stringify, so that row_version alone is a diff:
 *         `jobs` read as locally changed against a baseline that never caught
 *         up, the autosave fired, and the guard threw — for a relational write
 *         that had in fact SUCCEEDED.
 *
 *   THE FIX. One authoritative relational write per progression; the returned
 *   row_version applied to local state and to the baseline TOGETHER, by the
 *   same updater, on the confirmed path only — exactly the pattern
 *   advanceStage/saveNotes/saveLines already use. THE GUARD IS NOT TOUCHED,
 *   NOT WEAKENED AND NOT BYPASSED: this suite asserts it still throws for a
 *   genuinely unwired `jobs` write.
 *
 * WHAT THIS SUITE ACTUALLY RUNS. The backend half drives the REAL services and
 * the REAL REST routes against a REAL local Postgres. The frontend half
 * EXTRACTS THE SHIPPED FUNCTIONS (and the shipped auto-lifecycle effect body)
 * out of index.html and runs them in a Node `vm` sandbox whose `fetch` points
 * at that real server, counting every request — which is the only way to prove
 * a negative like "no platform_state jobs write follows". The BEFORE cases are
 * a transcription of the code as it stood, clearly labelled as such, so the
 * failure they reproduce is the real one and the AFTER cases run the real
 * current code.
 *
 * SAFETY: refuses to run unless DATABASE_URL is local (or ALLOW_UNSAFE_TEST_DB=1).
 * It owns the rel_* tables and platform_state row 1 in the TEST database only,
 * and restores the relational_cutover flags it found on the way in.
 *
 * Usage (from backend/):
 *   DATABASE_URL=postgresql://user:pass@localhost:5432/signacore_test \
 *   TEST_SERVER_URL_WITH_AUTHORITY=http://127.0.0.1:3002 \
 *   npx ts-node --transpile-only test/relational.jobs-autosave-and-quote-invoice-repair.stress.ts
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import pool from '../src/db/pool';
import * as services from '../src/relational/services';
import { BusinessRuleError } from '../src/relational/services';
import { buildJobsJson, buildInvoicesJson, buildQuotesJson } from '../src/relational/read';

const DB_URL = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(DB_URL) && process.env.ALLOW_UNSAFE_TEST_DB !== '1') {
  console.error('[jobs-autosave-quote-invoice] Refusing to run: DATABASE_URL does not look like a local test database.');
  process.exit(1);
}

const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH || path.resolve(__dirname, '..', '..', 'index.html');
const BASE = process.env.TEST_SERVER_URL_WITH_AUTHORITY || '';

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

const CUTOVER_SECTIONS = ['customers', 'suppliers', 'inventory', 'quotes', 'jobs', 'accInvoices', 'creditNotes', 'purchaseOrders'];
const STAGE_STATUSES = ['lead', 'quoted', 'design', 'approved', 'deposit_requested', 'deposit_received',
  'in_production', 'installation', 'completed', 'invoiced'];

// ── source extraction (same convention as relational.save-path-jobs-persistence) ──
function extractFunction(src: string, name: string): string {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) throw new Error(`Could not find function ${name} in index.html — renamed or removed?`);
  const parenStart = src.indexOf('(', m.index);
  let pdepth = 0, j = parenStart;
  for (; j < src.length; j++) {
    if (src[j] === '(') pdepth++;
    else if (src[j] === ')') { pdepth--; if (pdepth === 0) { j++; break; } }
  }
  const braceStart = src.indexOf('{', j);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(m.index, i);
}

/**
 * Lift the SHIPPED auto-lifecycle effect out of index.html and return its body
 * as callable source. This is deliberately not a re-implementation: the code
 * this suite exercises for the AFTER cases is byte-for-byte the code that
 * ships. Anchored on the repair's own marker comment so it can never
 * accidentally pick up a different useEffect.
 */
function extractAutoLifecycleEffectBody(src: string): string {
  const anchor = src.indexOf('// ── LEGACY-AUTOSAVE REPAIR (2026-08-25) ─');
  if (anchor === -1) throw new Error('Could not find the LEGACY-AUTOSAVE REPAIR marker in index.html — renamed or removed?');
  const start = src.indexOf('useEffect(()=>{', anchor);
  if (start === -1) throw new Error('Could not find the auto-lifecycle useEffect after the repair marker');
  const bodyStart = src.indexOf('{', src.indexOf('()=>', start));
  let depth = 0, i = bodyStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  const body = src.slice(bodyStart + 1, i);
  const tail = src.slice(i, i + 40);
  if (!/^\}\s*,\s*\[jobs\s*,\s*quotes\]\s*\)/.test(tail)) {
    throw new Error(`Extracted effect does not end with },[jobs,quotes]) — got: ${JSON.stringify(tail)}`);
  }
  return body;
}

// ── fixtures ────────────────────────────────────────────────────────────────
// Original = co 2 (SNS), Holdings = co 1 (SGH). The company code is what keeps
// the two entities' documents and numbering apart, so every case below is run
// with both present.
const CO_ORIGINAL = 'SNS';
const CO_HOLDINGS = 'SGH';

async function resetRelational() {
  await pool.query(`
    TRUNCATE TABLE rel_payments, rel_invoice_line_items, rel_invoices, rel_job_line_items,
      rel_jobs, rel_quote_line_items, rel_quotes, rel_credit_notes, rel_inventory_items, rel_customers
    RESTART IDENTITY CASCADE
  `);
  await pool.query(`DELETE FROM document_number_counters`);
  await pool.query(`DELETE FROM quote_conversions`);
  // 2026-08-25: platform_state must be cleared too. Invoice creation now
  // consults migration013Recovery, which reads the frozen platform_state JSON
  // looking for this document's historical lines — so a quote left behind by
  // ANOTHER suite under the same number is a real (if artificial) identity
  // collision, and the resolver correctly refuses to invoice against a source
  // it cannot match with certainty. Owning this row makes each suite's
  // fixtures answer only to themselves.
  await pool.query(`UPDATE platform_state SET data = '{}'::jsonb WHERE id = 1`);
}

let PRIOR_CUTOVER: Array<{ section: string; enabled: boolean }> = [];
async function captureCutover() {
  PRIOR_CUTOVER = (await pool.query(`SELECT section, enabled FROM relational_cutover`)).rows;
}
async function restoreCutover() {
  for (const row of PRIOR_CUTOVER) {
    await pool.query(`UPDATE relational_cutover SET enabled = $2 WHERE section = $1`, [row.section, row.enabled]);
  }
}
/** The LIVE cutover shape stated in the brief: quotes/jobs/accInvoices true,
 *  payments false. Reproducing it exactly matters — a suite that enables
 *  everything would not be testing production's configuration. */
async function setLiveCutover() {
  for (const s of CUTOVER_SECTIONS) {
    await pool.query(
      `INSERT INTO relational_cutover (section, enabled) VALUES ($1, true)
       ON CONFLICT (section) DO UPDATE SET enabled = true`, [s]);
  }
  await pool.query(`INSERT INTO relational_cutover (section, enabled) VALUES ('payments', false)
                    ON CONFLICT (section) DO UPDATE SET enabled = false`);
}

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.TEST_LOGIN_EMAIL || 'test@signacore.local',
      password: process.env.TEST_LOGIN_PASSWORD || 'testpass',
    }),
  });
  const body: any = await res.json();
  if (!body || !body.token) throw new Error(`could not authenticate against ${BASE}`);
  return body.token;
}

/** A quote with the exact commercial shape the brief calls out: a multi-PIECE
 *  line (pieces x qty x unit price), a SETUP FEE and a DISCOUNT. */
async function makeQuote(opts: {
  companyCode: string; client: string;
  lines: Array<{ desc: string; qty: number; unitPrice: number; pieces?: number | null }>;
  setupFee?: number; discountPct?: number; status?: string;
}): Promise<{ id: number; quoteNumber: string }> {
  const created = await services.createQuote({
    companyCode: opts.companyCode,
    customerNameRaw: opts.client,
    email: `${opts.client.replace(/\W+/g, '.').toLowerCase()}@example.test`,
    address: `1 Test Street, ${opts.client}`,
    status: opts.status || 'approved',
    setupFee: opts.setupFee ?? 0,
    discountPct: opts.discountPct ?? 0,
    lines: opts.lines.map((l) => ({
      desc: l.desc, qty: l.qty, unitPrice: l.unitPrice,
      pieces: l.pieces === undefined ? null : l.pieces,
    })),
  } as any);
  if (opts.status && opts.status !== 'approved') {
    // createQuote may not accept every status directly; make sure the row says
    // what the test intends.
    await pool.query(`UPDATE rel_quotes SET status = $2 WHERE id = $1`, [created.id, opts.status]);
  } else {
    await pool.query(`UPDATE rel_quotes SET status = 'approved' WHERE id = $1`, [created.id]);
  }
  return { id: created.id, quoteNumber: created.quoteNumber };
}

/** The quote's own arithmetic, exactly as index.html computes it for display
 *  (QuoteViewModal): sum(pieces x qty x unitPrice), less discount %, plus setup
 *  fee, then 15% VAT. Deliberately computed HERE from the quote's inputs rather
 *  than read from rel_quotes, so the invoice is compared against the number the
 *  customer was actually quoted. */
function quoteTotals(
  lines: Array<{ qty: number; unitPrice: number; pieces?: number | null }>,
  setupFee: number, discountPct: number
) {
  const sub = lines.reduce((s, l) => s + (((l.pieces ?? 0) > 0 ? (l.pieces as number) : 1) * l.qty * l.unitPrice), 0);
  const discAmt = sub * (discountPct / 100);
  const exVat = sub - discAmt + setupFee;
  const vat = exVat * 0.15;
  return { sub, discAmt, exVat, vat, total: exVat + vat };
}

/** An invoice's totals from its stored lines, the way every frontend surface
 *  computes them (`(inv.lineItems||[]).reduce(...)` — qty x unitAmount, VAT on
 *  the 15% lines). */
function invoiceTotals(inv: any) {
  const items = inv.lineItems || [];
  const exVat = items.reduce((s: number, l: any) => s + (Number(l.qty) * Number(l.unitAmount)), 0);
  const vat = items.reduce((s: number, l: any) => l.taxType === '15%' ? s + (Number(l.qty) * Number(l.unitAmount) * 0.15) : s, 0);
  return { exVat, vat, total: exVat + vat };
}
const near = (a: number, b: number, tol = 0.02) => Math.abs(a - b) <= tol;

// ═══════════════════════════════════════════════════════════════════════════
// ERROR 1 — CREATE INVOICE FROM QUOTE
// ═══════════════════════════════════════════════════════════════════════════
async function testError1Backend(token: string) {
  console.log('\n══ ERROR 1 — Create Invoice from Quote (services + REST) ══');
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  // ── 1. Approved quote, NO proforma → the live failure, then the repair ────
  console.log('\n[1] Approved quote with NO proforma reservation');
  const q1 = await makeQuote({
    companyCode: CO_ORIGINAL, client: 'Direct Invoice Co',
    lines: [{ desc: 'Shopfront signage', qty: 2, unitPrice: 1500, pieces: 3 }],
    setupFee: 750, discountPct: 10,
  });
  const q1row = (await pool.query(`SELECT proforma_num FROM rel_quotes WHERE id=$1`, [q1.id])).rows[0];
  ok(q1row.proforma_num === null,
    '1a: sanity — this approved quote genuinely carries NO proforma reservation (the reported condition)', q1row);

  // THE REPRODUCTION. finalizeProformaToInvoice is what the button used to
  // call, and it still refuses — correctly, that is its contract. This is the
  // exact message the user saw.
  let reproMsg = '';
  try {
    await services.finalizeProformaToInvoice(q1.id);
  } catch (err: any) {
    reproMsg = String(err && err.message);
  }
  ok(reproMsg === `quote ${q1.id} has no proforma reservation to finalise`,
    '1b: BEFORE — the endpoint the button used to call still refuses this quote with the exact reported message (its contract is deliberately preserved, not weakened)', reproMsg);
  ok(reproMsg !== '' && (await pool.query(`SELECT count(*)::int n FROM rel_invoices WHERE quote_id=$1`, [q1.id])).rows[0].n === 0,
    '1c: BEFORE — and nothing was created, exactly as the user was told ("Nothing was changed")');

  // THE REPAIR — the direct path the button now calls.
  const r1 = await services.createInvoiceFromQuote(q1.id);
  ok(r1.reused === false && /^INV-\d+$/.test(r1.invoiceNumber),
    '1d: AFTER — createInvoiceFromQuote creates exactly one invoice with a freshly reserved INV number from the atomic counter', r1);

  const invCount1 = (await pool.query(`SELECT count(*)::int n FROM rel_invoices WHERE quote_id=$1`, [q1.id])).rows[0].n;
  ok(invCount1 === 1, '1e: exactly ONE invoice exists for this quote — no duplicate', invCount1);

  const invRow1 = (await pool.query(`SELECT * FROM rel_invoices WHERE id=$1`, [r1.invoiceId])).rows[0];
  ok(invRow1.company_code === CO_ORIGINAL, '1f: correct company — the invoice carries the quote\'s own company code', invRow1.company_code);
  ok(Number(invRow1.quote_id) === Number(q1.id) && invRow1.quote_number_raw === q1.quoteNumber,
    '1g: correct Quote linkage — quote_id and quote_number_raw both point back at the source quote (quote_number_raw is what index.html\'s getQuoteInvoice matches on)', {
      quote_id: invRow1.quote_id, quote_number_raw: invRow1.quote_number_raw });
  ok(invRow1.job_id === null, '1h: no job linkage — this invoice was raised before any job exists, which is the whole point of the button');
  ok(invRow1.contact_name === 'Direct Invoice Co' && !!invRow1.contact_email && !!invRow1.contact_address,
    '1i: contact details carried across from the quote (previously left NULL, so a quote invoice opened in Accounting showed none)', {
      name: invRow1.contact_name, email: invRow1.contact_email, address: invRow1.contact_address });
  ok(invRow1.reference === null,
    '1j: `reference` deliberately left empty — it is the key job linkage later claims (createInvoiceForJob COALESCEs the job number into it), so stamping the quote number here would block that link');

  // ── 4. Financial equality: pieces x qty x unit price, setup fee, discount, VAT
  console.log('\n[4] The invoice equals the quote — pieces, setup fee, discount, VAT');
  const expect1 = quoteTotals([{ qty: 2, unitPrice: 1500, pieces: 3 }], 750, 10);
  const invoices1 = await buildInvoicesJson();
  const inv1 = invoices1.find((i: any) => Number(i._relId) === Number(r1.invoiceId));
  const got1 = invoiceTotals(inv1);
  ok(near(got1.exVat, expect1.exVat),
    `4a: VAT-exclusive total matches the quote (${got1.exVat.toFixed(2)} vs ${expect1.exVat.toFixed(2)})`, { got: got1.exVat, expect: expect1.exVat });
  ok(near(got1.vat, expect1.vat),
    `4b: VAT matches the quote (${got1.vat.toFixed(2)} vs ${expect1.vat.toFixed(2)})`, { got: got1.vat, expect: expect1.vat });
  ok(near(got1.total, expect1.total),
    `4c: INVOICE TOTAL EQUALS QUOTE TOTAL (${got1.total.toFixed(2)} vs ${expect1.total.toFixed(2)})`, { got: got1.total, expect: expect1.total });

  const itemLine = (inv1.lineItems || [])[0];
  ok(Number(itemLine.qty) === 6 && Number(itemLine.unitAmount) === 1500,
    '4d: pieces x qty is honoured — 3 pieces x qty 2 is billed as qty 6 at the true unit price of 1500, never 2 x 1500 (the 1/pieces understatement)', itemLine);
  const discLine = (inv1.lineItems || []).find((l: any) => /^Discount/.test(l.description || ''));
  ok(!!discLine && near(Number(discLine.unitAmount), -expect1.discAmt),
    '4e: the discount is present as its own negative adjustment line, so the customer document states it explicitly', discLine);
  const feeLine = (inv1.lineItems || []).find((l: any) => l.description === 'Design & Setup Fee');
  ok(!!feeLine && near(Number(feeLine.unitAmount), 750),
    '4f: the setup fee is present as its own line', feeLine);
  ok((inv1.lineItems || []).every((l: any) => l.taxType === '15%'),
    '4g: every line (items and both adjustments) is taxed at 15%, so VAT is computed on the discounted, fee-inclusive amount — the quote\'s own flat calculation');

  // ── 3. Existing invoice → no duplicate ───────────────────────────────────
  console.log('\n[3] A second click on a quote that already has an invoice');
  const r1again = await services.createInvoiceFromQuote(q1.id);
  ok(r1again.reused === true && r1again.invoiceId === r1.invoiceId && r1again.invoiceNumber === r1.invoiceNumber,
    '3a: the SAME invoice comes back with reused:true — the existing record is reused, per the established canonicalisation rules', r1again);
  const invCount1b = (await pool.query(`SELECT count(*)::int n FROM rel_invoices WHERE quote_id=$1`, [q1.id])).rows[0].n;
  ok(invCount1b === 1, '3b: still exactly ONE invoice — no duplicate document was created', invCount1b);
  const counterAfter = (await pool.query(
    `SELECT last_number FROM document_number_counters WHERE company=$1 AND doc_type='invoice'`, [CO_ORIGINAL])).rows[0];
  const rapid = await Promise.all([
    services.createInvoiceFromQuote(q1.id), services.createInvoiceFromQuote(q1.id), services.createInvoiceFromQuote(q1.id),
  ]);
  ok(rapid.every((r) => r.reused === true && r.invoiceId === r1.invoiceId),
    '3c: three CONCURRENT clicks all resolve to the same existing invoice — the row lock serialises them and none creates a second');
  const counterAfter2 = (await pool.query(
    `SELECT last_number FROM document_number_counters WHERE company=$1 AND doc_type='invoice'`, [CO_ORIGINAL])).rows[0];
  ok(counterAfter.last_number === counterAfter2.last_number,
    '3d: and NO invoice number was burned from the atomic pool on the reuse path — the reuse check runs before any reservation', {
      before: counterAfter.last_number, after: counterAfter2.last_number });
  ok((await buildInvoicesJson()).filter((i: any) => Number(i._relId) === Number(r1.invoiceId) && invoiceTotals(i).total === 0).length === 0
     && invoiceTotals(inv1).total > 0,
    '3e: no R0 invoice — the created invoice carries real lines and a real value');

  // ── 2. Approved quote WITH a valid proforma → established behaviour intact ─
  console.log('\n[2] Approved quote WITH a valid proforma reservation');
  const q2 = await makeQuote({
    companyCode: CO_ORIGINAL, client: 'Proforma First Co',
    lines: [{ desc: 'Illuminated sign', qty: 1, unitPrice: 8000, pieces: null }],
    setupFee: 0, discountPct: 0,
  });
  await pool.query(`UPDATE rel_quotes SET proforma_num = 'PRO-09001' WHERE id = $1`, [q2.id]);
  const r2 = await services.finalizeProformaToInvoice(q2.id);
  ok(r2.invoiceNumber === 'INV-09001',
    '2a: the established proforma-finalisation workflow still succeeds and consumes the EXACT reserved suffix (PRO-09001 -> INV-09001), never a second number', r2);
  let secondFinalise = '';
  try { await services.finalizeProformaToInvoice(q2.id); } catch (e: any) { secondFinalise = String(e && e.message); }
  ok(/already exists for company/.test(secondFinalise),
    '2b: a second finalisation of the same reservation is still refused loudly — finalizeProformaToInvoice\'s contract is unchanged', secondFinalise);

  // And the direct path honours a reservation identically rather than
  // competing with it.
  const q3 = await makeQuote({
    companyCode: CO_ORIGINAL, client: 'Proforma Then Direct Co',
    lines: [{ desc: 'Wall graphics', qty: 4, unitPrice: 600, pieces: 2 }],
    setupFee: 250, discountPct: 5,
  });
  await pool.query(`UPDATE rel_quotes SET proforma_num = 'PRO-09002' WHERE id = $1`, [q3.id]);
  const r3 = await services.createInvoiceFromQuote(q3.id);
  ok(r3.invoiceNumber === 'INV-09002' && r3.reused === false,
    '2c: clicking "Create Invoice from Quote" on a quote that DOES have a reservation consumes that exact reservation too — the two workflows agree instead of conflicting', r3);
  const expect3 = quoteTotals([{ qty: 4, unitPrice: 600, pieces: 2 }], 250, 5);
  const inv3 = (await buildInvoicesJson()).find((i: any) => Number(i._relId) === Number(r3.invoiceId));
  ok(near(invoiceTotals(inv3).total, expect3.total),
    '2d: and that invoice adds up to its quote as well (pieces/setup fee/discount/VAT all reproduced)', {
      got: invoiceTotals(inv3).total, expect: expect3.total });
  const q3after = (await pool.query(`SELECT proforma_num FROM rel_quotes WHERE id=$1`, [q3.id])).rows[0];
  ok(q3after.proforma_num === 'PRO-09002',
    '2e: the quote\'s own reservation is left exactly as it was — nothing fabricates, rewrites or clears a proforma number to satisfy either path');

  // ── 5. Company isolation — Original (co 2) vs Holdings (co 1) ─────────────
  console.log('\n[5] Original / Holdings isolation');
  const qH = await makeQuote({
    companyCode: CO_HOLDINGS, client: 'Holdings Client',
    lines: [{ desc: 'Holdings board', qty: 1, unitPrice: 5000, pieces: null }],
    setupFee: 0, discountPct: 0,
  });
  const rH = await services.createInvoiceFromQuote(qH.id);
  const invH = (await pool.query(`SELECT * FROM rel_invoices WHERE id=$1`, [rH.invoiceId])).rows[0];
  ok(invH.company_code === CO_HOLDINGS,
    '5a: a Holdings quote produces a Holdings invoice — the company code comes from the quote, never from a default', invH.company_code);
  const crossCount = (await pool.query(
    `SELECT count(*)::int n FROM rel_invoices i JOIN rel_quotes q ON q.id = i.quote_id WHERE i.company_code <> q.company_code`)).rows[0].n;
  ok(crossCount === 0,
    '5b: NO invoice anywhere is linked to a quote belonging to a different company — isolation preserved across every case in this suite', crossCount);
  const numbersByCo = (await pool.query(
    `SELECT company_code, count(*)::int n, count(DISTINCT invoice_number)::int d FROM rel_invoices GROUP BY company_code`)).rows;
  ok(numbersByCo.every((r: any) => r.n === r.d),
    '5c: invoice numbers are unique within each company — the two entities number independently and cannot collide with each other', numbersByCo);

  // ── REST layer — the route the button actually calls ─────────────────────
  console.log('\n[6] REST route POST /api/relational/quotes/:id/create-invoice');
  const q4 = await makeQuote({
    companyCode: CO_ORIGINAL, client: 'Rest Route Co',
    lines: [{ desc: 'Vehicle branding', qty: 1, unitPrice: 12000, pieces: 2 }],
    setupFee: 1000, discountPct: 12.5,
  });
  const res4 = await fetch(`${BASE}/api/relational/quotes/${q4.id}/create-invoice`, { method: 'POST', headers: H });
  const body4: any = await res4.json();
  ok(res4.status === 201 && body4.success === true && body4.reused === false && /^INV-\d+$/.test(body4.invoiceNumber),
    '6a: the route creates the invoice and reports it (201 + invoiceId/invoiceNumber/reused)', { status: res4.status, body: body4 });
  const res4b = await fetch(`${BASE}/api/relational/quotes/${q4.id}/create-invoice`, { method: 'POST', headers: H });
  const body4b: any = await res4b.json();
  ok(res4b.status === 200 && body4b.reused === true && body4b.invoiceId === body4.invoiceId,
    '6b: calling it again returns 200 + reused:true with the SAME invoice, so the client opens it instead of adding a duplicate row', { status: res4b.status, body: body4b });
  const res4c = await fetch(`${BASE}/api/relational/quotes/999999999/create-invoice`, { method: 'POST', headers: H });
  ok(res4c.status === 400 || res4c.status === 409,
    '6c: an unknown quote is refused by the shared business-rule handler, not 500', res4c.status);
  const res4d = await fetch(`${BASE}/api/relational/quotes/${q4.id}/create-invoice`, { method: 'POST' });
  ok(res4d.status === 401, '6d: the route is authenticated like every other relational route', res4d.status);

  // The old route is still there and still behaves exactly as before.
  const q5 = await makeQuote({
    companyCode: CO_ORIGINAL, client: 'Old Route Co',
    lines: [{ desc: 'Panel', qty: 1, unitPrice: 100, pieces: null }],
  });
  const res5 = await fetch(`${BASE}/api/relational/quotes/${q5.id}/finalize-proforma`, { method: 'POST', headers: H });
  const body5: any = await res5.json();
  ok(res5.status >= 400 && /no proforma reservation to finalise/.test(String(body5 && body5.error)),
    '6e: POST /finalize-proforma is untouched — it still refuses a quote with no reservation, so nothing that depends on that contract changes', { status: res5.status, body: body5 });

  // ── refresh persistence ──────────────────────────────────────────────────
  console.log('\n[7] Refresh persistence — a fresh authoritative read');
  const quotesJson = await buildQuotesJson();
  const invoicesJson = await buildInvoicesJson();
  const q1json = quotesJson.find((q: any) => Number(q._relId) === Number(q1.id));
  const inv1json = invoicesJson.find((i: any) => Number(i._relId) === Number(r1.invoiceId));
  ok(!!inv1json && inv1json.quoteNum === q1json.num,
    '7a: after a fresh read the invoice still resolves to its quote by the SAME rule index.html\'s getQuoteInvoice uses (invoice.quoteNum === quote.num), so the Quote view offers "View Invoice" rather than "Create Invoice from Quote" again', {
      quoteNum: inv1json && inv1json.quoteNum, num: q1json && q1json.num });
  ok(near(invoiceTotals(inv1json).total, expect1.total),
    '7b: and its total is unchanged by the round trip — pieces, discount, setup fee and VAT all survive a refresh', {
      got: invoiceTotals(inv1json).total, expect: expect1.total });
  ok((inv1json.lineItems || []).length === 3 && (inv1json.items || []).length === 3,
    '7c: the lines come back under BOTH `lineItems` (what the app reads) and `items` — no R0.00 twin', {
      lineItems: (inv1json.lineItems || []).length, items: (inv1json.items || []).length });
}

/** Source-text pins for the frontend half of ERROR 1 — the button must call the
 *  new endpoint, must handle `reused`, and the JSON branch must be untouched. */
function testError1Frontend(src: string) {
  console.log('\n══ ERROR 1 — index.html wiring ══');
  ok(src.includes(`createInvoiceFromQuote(quoteId) { return relationalFetch('/quotes/' + quoteId + '/create-invoice', { method: 'POST' }); },`),
    'F1a: relationalApi has a createInvoiceFromQuote adapter pointing at the new route');
  ok(src.includes('const result = await relationalApi.createInvoiceFromQuote(quote._relId);'),
    'F1b: createInvoiceFromQuote__impl\'s relational branch calls it with the real relational PK');
  ok(!/const result = await relationalApi\.finalizeProforma\(quote\._relId\);/.test(src),
    'F1c: the old unconditional finalizeProforma call — the direct cause of "quote 371 has no proforma reservation to finalise" — is gone from that branch');
  ok(/if\(result\.reused\)\{[\s\S]{0,400}?revealJobInvoice\(\{id: result\.invoiceId\}\);/.test(src),
    'F1d: a reused invoice is OPENED, not stubbed into accInvoices — so a repeat click can never render a duplicate row');
  ok(src.includes("finalizeProforma(quoteId) { return relationalFetch('/quotes/' + quoteId + '/finalize-proforma', { method: 'POST' }); },"),
    'F1e: the finalizeProforma adapter itself is retained (the proforma workflow keeps its own endpoint)');
  // The JSON fallback branch — the behaviour when authority is off — must be
  // untouched, including its own no-proforma handling.
  ok(src.includes('const proformaDecisionFromQuote = resolveProformaInvoiceNumber(quote, { jobs, accInvoices, quotes });'),
    'F1f: the JSON branch still resolves a legacy proformaNum first');
  ok(src.includes('if (!reserved) reserved = await reserveInvoiceNumber(quote.co);'),
    'F1g: and still reserves a fresh number when there is no proforma to reuse — the very behaviour the relational branch was missing');
  ok(src.includes("{quote.status==='approved'&&!linkedJob&&!quoteInvoice&&onCreateInvoiceFromQuote&&("),
    'F1h: the button is still offered only for an approved quote with no job and no existing invoice — the UI-side duplicate guard is unchanged');
}

// ═══════════════════════════════════════════════════════════════════════════
// ERROR 2 — JOBS PAGE LEGACY AUTOSAVE
// ═══════════════════════════════════════════════════════════════════════════

interface JobsHarness {
  sandbox: any;
  puts: Array<{ url: string; body: any }>;
  jobUpdates: Array<{ url: string; body: any }>;
}

/**
 * A sandbox holding the REAL shipped guard, the REAL diff function and the REAL
 * baseline helper, plus a `relationalApi.updateJob` that makes REAL authenticated
 * requests to the REAL server. Every request is recorded, so "exactly one
 * relational write, and no platform_state jobs save" is provable rather than
 * asserted by inspection.
 */
function buildJobsHarness(src: string, token: string): JobsHarness {
  const puts: Array<{ url: string; body: any }> = [];
  const jobUpdates: Array<{ url: string; body: any }> = [];

  const extracted = [
    extractFunction(src, 'isRelationalAuthoritative'),
    extractFunction(src, 'syncRelationalBaseline'),
    extractFunction(src, 'assertNoUnwiredRelationalSections'),
    extractFunction(src, 'locallyChangedSections'),
    extractFunction(src, 'reconcileJobInvoice'),
  ].join('\n\n');

  const sandbox: any = {
    console, setTimeout, clearTimeout, JSON, Math, Set, Map, Array, Object, Number, String, Promise, Error,
    STATE_SECTIONS: ['jobs', 'inventory', 'quotes', 'customers', 'suppliers', 'assets',
      'employees', 'leaveRequests', 'disciplinary', 'savedCalcs', 'purchaseOrders', 'savedImports',
      'bankTxns', 'chartOfAccounts', 'accInvoices', 'accBills', 'completeProducts', 'payrollRecords',
      'quickRates', 'proposedProjects', 'creditNotes', 'userAccounts'],
    STAGE_STATUSES,
    serverBaselineRef: { current: null },
    relationalAuthoritativeSectionsRef: { current: [] },
    relationalCutOverSeenRef: { current: [] },
    // React stand-ins. `jobs` is re-pointed by the harness the way React hands a
    // component the value captured at render time.
    jobs: [] as any[],
    quotes: [] as any[],
    setJobs: (next: any) => {
      sandbox.jobs = typeof next === 'function' ? next(sandbox.jobs) : next;
    },
    autoStageInFlightRef: { current: null },
    useRef: (init: any) => ({ current: init }),
    relationalApi: {
      async updateJob(id: number, expectedVersion: number, patch: any) {
        const url = `${BASE}/api/relational/jobs/${id}`;
        const body = Object.assign({ expectedVersion }, patch);
        jobUpdates.push({ url, body });
        const res = await (globalThis as any).fetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
        const parsed: any = await res.json().catch(() => null);
        if (!res.ok) {
          const err: any = new Error((parsed && parsed.error) || `HTTP ${res.status}`);
          err.status = res.status; err.body = parsed;
          throw err;
        }
        return parsed;
      },
    },
    // Records any attempt to write platform_state, so a legacy whole-section
    // save can be caught even if it somehow got past the guard.
    recordPlatformStatePut: (url: string, body: any) => { puts.push({ url, body }); },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    `${extracted}\nglobalThis.__api = { isRelationalAuthoritative, syncRelationalBaseline, assertNoUnwiredRelationalSections, locallyChangedSections, reconcileJobInvoice };`,
    sandbox, { filename: 'index.html-extracted.js' }
  );
  return { sandbox, puts, jobUpdates };
}

/** Build the snapshot the autosave effect would capture from React state. */
function snapshotOf(sandbox: any, base: any) {
  return Object.assign({}, base, { jobs: sandbox.jobs, quotes: sandbox.quotes });
}

/**
 * The auto-lifecycle effect AS IT STOOD before this repair, transcribed
 * verbatim from the shipped source it replaced. This is the BEFORE case: it
 * exists so the failure being fixed is genuinely reproduced rather than merely
 * described. It is deliberately NOT extracted from index.html — that code no
 * longer exists there, which is the point.
 */
function runLegacyAutoLifecycleEffect(sandbox: any) {
  const { reconcileJobInvoice, syncRelationalBaseline, isRelationalAuthoritative } = sandbox.__api;
  const pending: Array<Promise<any>> = [];
  let changed = false;
  const relationalJobs = isRelationalAuthoritative('jobs');
  const toPersist: any[] = [];
  const next = (sandbox.jobs || []).map((j: any) => {
    const st = j.stage || 0;
    if (st === 4) {
      const rec = reconcileJobInvoice(j, sandbox.quotes);
      if (rec.totalPaid > 0) {
        changed = true;
        if (relationalJobs && j._relId != null) toPersist.push({ id: j.id, relId: j._relId, relRowVersion: j._relRowVersion, stage: 5, status: STAGE_STATUSES[5] });
        return { ...j, stage: 5, status: STAGE_STATUSES[5] };
      }
    }
    if (st === 8 && j.invoiceCreated) {
      changed = true;
      if (relationalJobs && j._relId != null) toPersist.push({ id: j.id, relId: j._relId, relRowVersion: j._relRowVersion, stage: 9, status: STAGE_STATUSES[9] });
      return { ...j, stage: 9, status: STAGE_STATUSES[9] };
    }
    return j;
  });
  if (changed) {
    sandbox.setJobs(next);
    syncRelationalBaseline('jobs', () => next);
    toPersist.forEach((p) => {
      pending.push(
        sandbox.relationalApi.updateJob(p.relId, p.relRowVersion, { stage: p.stage, status: p.status })
          .then((result: any) => {
            // THE DEFECT: local state gains the server's row_version, the
            // baseline never does.
            sandbox.setJobs((prev: any[]) => prev.map((j: any) => j.id === p.id ? { ...j, _relRowVersion: result.rowVersion } : j));
          })
          .catch(() => undefined)
      );
    });
  }
  return Promise.all(pending);
}

async function testError2(src: string, token: string) {
  console.log('\n══ ERROR 2 — Jobs page legacy autosave ══');

  // ── Prove the caller from the current code, not from the toast ───────────
  console.log('\n[C] Which Jobs-page call could reach the legacy whole-section save at all');
  // THE SWEEP THAT IDENTIFIED THE CALLER. Anything that changes the `jobs`
  // React array without mirroring the SAME change into serverBaselineRef makes
  // locallyChangedSections report `jobs` as locally changed, which is the only
  // way the 800ms autosave can reach the guard with "jobs" in its set. So:
  // every setJobs() reached from a relationalApi.* response must be
  // IMMEDIATELY followed by syncRelationalBaseline('jobs', ...). "Immediately"
  // (same line, or within 3 lines after) is deliberate and is what makes this
  // sweep able to see the defect at all — the pre-fix code DID call
  // syncRelationalBaseline, but three lines EARLIER and for a different value,
  // so a looser window would have declared it clean. Scanning stops at the
  // relational branch's own `return;` so JSON-fallback code below it — which is
  // reached only when 'jobs' is not relational-authoritative, and is
  // legitimately persisted by the JSON autosave — is not misreported.
  function sweepUnsyncedJobWrites(source: string): Array<{ apiLine: number; setJobsLine: number }> {
    const ls = source.split('\n');
    const out: Array<{ apiLine: number; setJobsLine: number }> = [];
    for (let i = 0; i < ls.length; i++) {
      if (!ls[i].includes('relationalApi.') || /^\s*\/\//.test(ls[i])) continue;
      for (let k = i; k < Math.min(ls.length, i + 26); k++) {
        if (k > i && ls[k].trim() === 'return;') break;   // end of the relational branch
        if (!ls[k].includes('setJobs(') || /^\s*\/\//.test(ls[k])) continue;
        const win = ls.slice(k, k + 4).join('\n');
        if (!win.includes(`syncRelationalBaseline('jobs'`)) out.push({ apiLine: i + 1, setJobsLine: k + 1 });
        break;
      }
    }
    return out;
  }
  // Prove the sweep can actually see the defect, using the code as it stood.
  // A structural audit nobody has shown to fail is not evidence of anything.
  const PRE_FIX_EFFECT = [
    "    if(changed){",
    "      setJobs(next);",
    "      syncRelationalBaseline('jobs', () => next);",
    "      toPersist.forEach(p=>{",
    "        relationalApi.updateJob(p.relId, p.relRowVersion, { stage:p.stage, status:p.status }).then(result=>{",
    "          setJobs(prev=>prev.map(j=>j.id===p.id?{...j,_relRowVersion:result.rowVersion}:j));",
    "        }).catch(()=>{ });",
    "      });",
    "    }",
  ].join('\n');
  const sweepOnOldCode = sweepUnsyncedJobWrites(PRE_FIX_EFFECT);
  ok(sweepOnOldCode.length === 1,
    'C0: the sweep flags the auto-lifecycle effect AS IT STOOD — one relationalApi.updateJob whose success handler calls setJobs with no matching syncRelationalBaseline. THIS is the caller, proven from the code rather than inferred from the toast',
    sweepOnOldCode);

  const unsynced = sweepUnsyncedJobWrites(src);
  ok(unsynced.length === 0,
    'C1: and the same sweep over the SHIPPED index.html now finds none — every setJobs() reached from a relational response is paired with syncRelationalBaseline(\'jobs\', ...), so no call site can desync the baseline and feed the guard',
    unsynced);
  ok(!/setJobs\(prev=>prev\.map\(j=>j\.id===p\.id\?\{\.\.\.j,_relRowVersion:result\.rowVersion\}:j\)\);/.test(src),
    'C2: THE CALLER IS GONE — the auto-lifecycle effect\'s bare row_version write-back is no longer in the file; that single line is what made `jobs` diff against the baseline after a SUCCESSFUL relational write');

  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  // ── Seed two real jobs, one per company, both at the auto-advance edge ────
  const qA = await makeQuote({
    companyCode: CO_ORIGINAL, client: 'Deposit Client', status: 'approved',
    lines: [{ desc: 'Signage set', qty: 1, unitPrice: 10000, pieces: null }],
  });
  const convA = await services.convertQuoteToJob(qA.id);
  await pool.query(`UPDATE rel_jobs SET stage = 4, status = $2, value = 11500 WHERE id = $1`, [convA.jobId, STAGE_STATUSES[4]]);

  const qB = await makeQuote({
    companyCode: CO_HOLDINGS, client: 'Holdings Deposit Client', status: 'approved',
    lines: [{ desc: 'Holdings signage', qty: 1, unitPrice: 4000, pieces: null }],
  });
  const convB = await services.convertQuoteToJob(qB.id);
  await pool.query(`UPDATE rel_jobs SET stage = 4, status = $2, value = 4600 WHERE id = $1`, [convB.jobId, STAGE_STATUSES[4]]);

  // A recorded deposit is what makes the Deposit Received progression due —
  // this is the ordinary Jobs-page action that produced the live error.
  await services.recordPayment({ type: 'job', id: convA.jobId }, 5000, { method: 'EFT', date: '2026-08-25' });
  await services.recordPayment({ type: 'job', id: convB.jobId }, 2000, { method: 'EFT', date: '2026-08-25' });

  async function freshState() {
    const jobs = await buildJobsJson();
    const quotes = await buildQuotesJson();
    return { jobs, quotes };
  }

  // ════════════════════════════════════════════════════════════════════════
  // BEFORE — the code as it stood reproduces the exact reported failure
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[BEFORE] the shipped-then code path → the live "Cannot save jobs here" error');
  {
    const st = await freshState();
    const HB = buildJobsHarness(src, token);
    HB.sandbox.relationalAuthoritativeSectionsRef.current = ['quotes', 'jobs', 'accInvoices'];
    HB.sandbox.jobs = JSON.parse(JSON.stringify(st.jobs));
    HB.sandbox.quotes = JSON.parse(JSON.stringify(st.quotes));
    const baseline = { jobs: JSON.parse(JSON.stringify(st.jobs)), quotes: JSON.parse(JSON.stringify(st.quotes)) };
    HB.sandbox.serverBaselineRef.current = baseline;

    const jobBefore = HB.sandbox.jobs.find((j: any) => Number(j._relId) === Number(convA.jobId));
    ok(jobBefore && jobBefore.stage === 4,
      'B0: sanity — the job is at Deposit Requested (4) with a payment recorded, the exact condition this effect acts on', jobBefore && jobBefore.stage);

    await runLegacyAutoLifecycleEffect(HB.sandbox);

    ok(HB.jobUpdates.length === 2,
      'B1: the relational write DID happen for both jobs — the data was never the problem', HB.jobUpdates.length);

    const snapshot = snapshotOf(HB.sandbox, {});
    const changed = HB.sandbox.__api.locallyChangedSections(snapshot, HB.sandbox.serverBaselineRef.current);
    ok(changed && changed.jobs === true,
      'B2: and yet `jobs` reads as LOCALLY CHANGED against the baseline afterwards — because the row_version write-back never reached serverBaselineRef', changed && changed.jobs);

    let thrown = '';
    try {
      HB.sandbox.__api.assertNoUnwiredRelationalSections(
        Object.keys(changed).filter((k) => (changed as any)[k]), 'the autosave path');
    } catch (e: any) { thrown = String(e && e.message); }
    ok(thrown.startsWith('Cannot save "jobs" here — the autosave path is not yet wired to relational persistence'),
      'B3: which makes the 800ms autosave call the guard with "jobs" in its changed set, and the guard throws THE EXACT REPORTED MESSAGE', thrown.slice(0, 120));
    ok(/Your edit was NOT saved/.test(thrown),
      'B4: including the "Your edit was NOT saved" wording the user reported — reproduced from the shipped guard, not paraphrased');
  }

  // ════════════════════════════════════════════════════════════════════════
  // AFTER — the shipped current effect, run verbatim out of index.html
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[AFTER] the shipped current effect → correct persistence, no legacy save, no error');
  const effectBody = extractAutoLifecycleEffectBody(src);
  let HA: JobsHarness;
  {
    // Reset the two jobs so this half starts from the same condition.
    await pool.query(`UPDATE rel_jobs SET stage = 4, status = $2 WHERE id = ANY($1::bigint[])`,
      [[convA.jobId, convB.jobId], STAGE_STATUSES[4]]);
    const st = await freshState();
    HA = buildJobsHarness(src, token);
    HA.sandbox.relationalAuthoritativeSectionsRef.current = ['quotes', 'jobs', 'accInvoices'];
    HA.sandbox.jobs = JSON.parse(JSON.stringify(st.jobs));
    HA.sandbox.quotes = JSON.parse(JSON.stringify(st.quotes));
    HA.sandbox.serverBaselineRef.current = {
      jobs: JSON.parse(JSON.stringify(st.jobs)), quotes: JSON.parse(JSON.stringify(st.quotes)),
    };
    // The effect is compiled ONCE into the sandbox as a callable, exactly as
    // extracted — the `pendingWrites` collector is the only addition, and it
    // only records the promises relationalApi.updateJob already returns, so it
    // cannot change what the code does.
    vm.runInContext(
      `globalThis.__runEffect = function(){ ${effectBody} };`,
      HA.sandbox, { filename: 'index.html-auto-lifecycle-effect.js' }
    );

    HA.sandbox.__runEffect();
    // Let the confirmed-write .then callbacks land.
    await new Promise((r) => setTimeout(r, 1200));

    ok(HA.jobUpdates.length === 2,
      'A1: exactly TWO relational writes — one per due job. ONE authoritative write per user action, no double save', HA.jobUpdates.length);
    ok(HA.jobUpdates.every((u) => u.body.stage === 5 && u.body.status === STAGE_STATUSES[5]),
      'A2: each write is the stage/status progression itself, through relationalApi.updateJob — never a whole `jobs` array', HA.jobUpdates.map((u) => u.body));
    ok(HA.puts.length === 0,
      'A3: NO platform_state write of any kind was attempted', HA.puts);

    const jobA = HA.sandbox.jobs.find((j: any) => Number(j._relId) === Number(convA.jobId));
    ok(jobA && jobA.stage === 5 && jobA.status === STAGE_STATUSES[5],
      'A4: local state shows the progression', jobA && { stage: jobA.stage, status: jobA.status });
    ok(jobA && typeof jobA._relRowVersion === 'number',
      'A5: carrying the server\'s own returned row_version, so the next edit of this job cannot 409 on a version the user invalidated themselves', jobA && jobA._relRowVersion);

    const baseJobA = HA.sandbox.serverBaselineRef.current.jobs.find((j: any) => Number(j._relId) === Number(convA.jobId));
    ok(baseJobA && baseJobA.stage === 5 && baseJobA._relRowVersion === jobA._relRowVersion,
      'A6: and the BASELINE carries the identical patch — applied by the same updater, so the two cannot drift', baseJobA && { stage: baseJobA.stage, rv: baseJobA._relRowVersion });

    const snapshot = snapshotOf(HA.sandbox, {});
    const changed = HA.sandbox.__api.locallyChangedSections(snapshot, HA.sandbox.serverBaselineRef.current);
    ok(changed && !changed.jobs,
      'A7: locallyChangedSections now reports `jobs` as UNCHANGED — so the 800ms autosave has nothing to push for it and never calls the guard with it', changed);
    let thrown = '';
    try {
      HA.sandbox.__api.assertNoUnwiredRelationalSections(
        Object.keys(changed).filter((k) => (changed as any)[k]), 'the autosave path');
    } catch (e: any) { thrown = String(e && e.message); }
    ok(thrown === '', 'A8: and the guard does not throw — no "Save failed" toast', thrown);
  }

  // ── The guard is still armed for a genuinely unwired write ───────────────
  console.log('\n[GUARD] the safety protection is intact');
  {
    const HG = buildJobsHarness(src, token);
    HG.sandbox.relationalAuthoritativeSectionsRef.current = ['quotes', 'jobs', 'accInvoices'];
    const baseline = { jobs: [{ id: 1, num: 'SNS-00001', stage: 3, notes: '' }] };
    HG.sandbox.serverBaselineRef.current = baseline;
    // A legacy, still-unwired mutation: local state changed, nothing persisted
    // relationally, no baseline sync.
    const snapshot = { jobs: [{ id: 1, num: 'SNS-00001', stage: 3, notes: 'edited by an unwired path' }] };
    const changed = HG.sandbox.__api.locallyChangedSections(snapshot, baseline);
    ok(changed.jobs === true, 'G1: an unwired local `jobs` edit still shows as changed against the baseline');
    let thrown = '';
    try {
      HG.sandbox.__api.assertNoUnwiredRelationalSections(Object.keys(changed).filter((k) => (changed as any)[k]), 'the autosave path');
    } catch (e: any) { thrown = String(e && e.message); }
    ok(/^Cannot save "jobs" here — the autosave path is not yet wired to relational persistence/.test(thrown),
      'G2: and the guard still throws the full protective message for it — this repair kept the guard\'s INPUT honest, it did not weaken the guard', thrown.slice(0, 90));
    const guardSrc = extractFunction(src, 'assertNoUnwiredRelationalSections').replace(/\s+/g, ' ');
    ok(guardSrc === "function assertNoUnwiredRelationalSections(sectionNames, contextLabel) { "
      + "const blocked = (sectionNames || []).filter(isRelationalAuthoritative); "
      + "if (blocked.length > 0) { throw new Error( 'Cannot save \"' + blocked.join(', ') + '\" here — ' + (contextLabel || 'this save path') + "
      + "' is not yet wired to relational persistence, and this section is now relational-authoritative. ' + "
      + "'Your edit was NOT saved. Please use the specific workflow action for this change (or contact support if none exists yet).' ); } }",
      'G3: assertNoUnwiredRelationalSections itself is unchanged in index.html — same condition, same message, nothing added to let anything through', guardSrc);
    const mergeSrc = extractFunction(src, 'mergeAndSave');
    ok(/assertNoUnwiredRelationalSections\(\s*changed \? Object\.keys\(changed\)\.filter\(k => changed\[k\]\) : STATE_SECTIONS,\s*'the autosave path'\s*\);/.test(mergeSrc),
      'G4: mergeAndSave still calls it for the autosave path — with the full changed set, and before any network round-trip');
    ok(mergeSrc.indexOf('assertNoUnwiredRelationalSections') < mergeSrc.indexOf('await fetchFromServer()'),
      'G5: and that call still happens BEFORE the fetch, so a genuinely unwired save never reaches the network at all');
  }

  // ── Rapid / repeated action → no duplicate write ─────────────────────────
  console.log('\n[RAPID] repeated ticks of the same progression');
  {
    await pool.query(`UPDATE rel_jobs SET stage = 4, status = $2 WHERE id = $1`, [convA.jobId, STAGE_STATUSES[4]]);
    const st = await freshState();
    const HR = buildJobsHarness(src, token);
    HR.sandbox.relationalAuthoritativeSectionsRef.current = ['quotes', 'jobs', 'accInvoices'];
    HR.sandbox.jobs = JSON.parse(JSON.stringify(st.jobs.filter((j: any) => Number(j._relId) === Number(convA.jobId))));
    HR.sandbox.quotes = JSON.parse(JSON.stringify(st.quotes));
    HR.sandbox.serverBaselineRef.current = {
      jobs: JSON.parse(JSON.stringify(HR.sandbox.jobs)), quotes: JSON.parse(JSON.stringify(st.quotes)),
    };
    vm.runInContext(`globalThis.__runEffect = function(){ ${effectBody} };`, HR.sandbox, { filename: 'index.html-auto-lifecycle-effect.js' });
    // The effect re-runs on EVERY jobs/quotes change; until the confirmed patch
    // lands the job still reads as stage 4, so without the in-flight guard a
    // burst of ticks would fire several writes, the later ones carrying a stale
    // row_version and coming back 409.
    HR.sandbox.__runEffect();
    HR.sandbox.__runEffect();
    HR.sandbox.__runEffect();
    await new Promise((r) => setTimeout(r, 1200));
    ok(HR.jobUpdates.length === 1,
      'R1: three immediate ticks produce exactly ONE relational write — no second write, no self-inflicted 409', HR.jobUpdates.length);
    const rowVersions = (await pool.query(`SELECT row_version, stage FROM rel_jobs WHERE id=$1`, [convA.jobId])).rows[0];
    ok(rowVersions.stage === 5, 'R2: and the job is at Deposit Received (5) in the database', rowVersions);
    // Once settled, a further tick is a genuine no-op because the job no longer
    // matches the progression condition.
    HR.sandbox.__runEffect();
    await new Promise((r) => setTimeout(r, 300));
    ok(HR.jobUpdates.length === 1,
      'R3: a later tick after the progression has landed writes nothing at all — the effect is idempotent', HR.jobUpdates.length);
  }

  // ── Stale row_version → nothing local claims to be saved ─────────────────
  console.log('\n[STALE] a conflicting row_version');
  {
    await pool.query(`UPDATE rel_jobs SET stage = 4, status = $2 WHERE id = $1`, [convA.jobId, STAGE_STATUSES[4]]);
    const st = await freshState();
    const HS = buildJobsHarness(src, token);
    HS.sandbox.relationalAuthoritativeSectionsRef.current = ['quotes', 'jobs', 'accInvoices'];
    HS.sandbox.jobs = JSON.parse(JSON.stringify(st.jobs.filter((j: any) => Number(j._relId) === Number(convA.jobId))));
    // Deliberately stale — as if another session had edited this job since.
    HS.sandbox.jobs[0]._relRowVersion = 1;
    HS.sandbox.quotes = JSON.parse(JSON.stringify(st.quotes));
    HS.sandbox.serverBaselineRef.current = {
      jobs: JSON.parse(JSON.stringify(HS.sandbox.jobs)), quotes: JSON.parse(JSON.stringify(st.quotes)),
    };
    vm.runInContext(`globalThis.__runEffect = function(){ ${effectBody} };`, HS.sandbox, { filename: 'index.html-auto-lifecycle-effect.js' });
    HS.sandbox.__runEffect();
    await new Promise((r) => setTimeout(r, 1200));

    const jobS = HS.sandbox.jobs[0];
    ok(jobS.stage === 4,
      'S1: the write was refused, so LOCAL STATE still shows stage 4 — nothing displays a progression the server never accepted', jobS.stage);
    const snapshot = snapshotOf(HS.sandbox, {});
    const changed = HS.sandbox.__api.locallyChangedSections(snapshot, HS.sandbox.serverBaselineRef.current);
    ok(!changed.jobs,
      'S2: and local state and the baseline still agree, so a failed write cannot trip the guard either', changed);
    const dbStage = (await pool.query(`SELECT stage FROM rel_jobs WHERE id=$1`, [convA.jobId])).rows[0].stage;
    ok(dbStage === 4, 'S3: the database is untouched — the refusal really did refuse', dbStage);
  }

  // ── The Invoiced (8 → 9) progression, and refresh persistence ────────────
  console.log('\n[INVOICED] Completed (8) with a created invoice → Invoiced (9), and a fresh read');
  {
    await services.updateJob(convA.jobId, (await pool.query(`SELECT row_version FROM rel_jobs WHERE id=$1`, [convA.jobId])).rows[0].row_version,
      { stage: 7, status: STAGE_STATUSES[7] } as any);
    await services.createInvoiceForJob(convA.jobId);
    await pool.query(`UPDATE rel_jobs SET stage = 8, status = $2 WHERE id = $1`, [convA.jobId, STAGE_STATUSES[8]]);

    const st = await freshState();
    const HI = buildJobsHarness(src, token);
    HI.sandbox.relationalAuthoritativeSectionsRef.current = ['quotes', 'jobs', 'accInvoices'];
    HI.sandbox.jobs = JSON.parse(JSON.stringify(st.jobs.filter((j: any) => Number(j._relId) === Number(convA.jobId))));
    HI.sandbox.quotes = JSON.parse(JSON.stringify(st.quotes));
    HI.sandbox.serverBaselineRef.current = {
      jobs: JSON.parse(JSON.stringify(HI.sandbox.jobs)), quotes: JSON.parse(JSON.stringify(st.quotes)),
    };
    ok(HI.sandbox.jobs[0].stage === 8 && HI.sandbox.jobs[0].invoiceCreated === true,
      'I0: sanity — the job is Completed (8) and carries a CREATED invoice (never a bare invoice number)', {
        stage: HI.sandbox.jobs[0].stage, invoiceCreated: HI.sandbox.jobs[0].invoiceCreated });
    vm.runInContext(`globalThis.__runEffect = function(){ ${effectBody} };`, HI.sandbox, { filename: 'index.html-auto-lifecycle-effect.js' });
    HI.sandbox.__runEffect();
    await new Promise((r) => setTimeout(r, 1200));

    ok(HI.jobUpdates.length === 1 && HI.jobUpdates[0].body.stage === 9,
      'I1: exactly one relational write, advancing to Invoiced (9)', HI.jobUpdates.map((u) => u.body));
    ok(HI.puts.length === 0, 'I2: and no platform_state jobs save', HI.puts);
    const changedI = HI.sandbox.__api.locallyChangedSections(snapshotOf(HI.sandbox, {}), HI.sandbox.serverBaselineRef.current);
    ok(!changedI.jobs, 'I3: `jobs` is not reported as locally changed — no guard error for this progression either');

    // REFRESH PERSISTENCE — a completely fresh authoritative read.
    const refreshed = (await buildJobsJson()).find((j: any) => Number(j._relId) === Number(convA.jobId));
    ok(refreshed.stage === 9 && refreshed.status === STAGE_STATUSES[9],
      'I4: a fresh read of the authoritative state shows Invoiced (9) — the change survives a refresh instead of reverting', {
        stage: refreshed.stage, status: refreshed.status });
    const jobBinvoiceless = (await buildJobsJson()).find((j: any) => Number(j._relId) === Number(convB.jobId));
    ok(jobBinvoiceless.stage === 5,
      'I5: Original / Holdings isolation — the Holdings job progressed on its own evidence and was not dragged along by the Original job\'s progression', jobBinvoiceless.stage);
  }

  // ── Scope of Work / notes / lifecycle — the wired paths stay wired ───────
  console.log('\n[WIRED] the other Jobs-page mutations named in the brief');
  {
    const jobRow = (await pool.query(`SELECT row_version FROM rel_jobs WHERE id=$1`, [convB.jobId])).rows[0];
    const rNotes = await services.updateJob(convB.jobId, jobRow.row_version, { notes: 'Site visit booked for Thursday' } as any);
    ok(typeof rNotes.rowVersion === 'number',
      'W1: Job notes persist through relationalApi.updateJob\'s service (the patch shape saveNotes sends)', rNotes);
    const rLines = await services.updateJob(convB.jobId, rNotes.rowVersion, {
      lines: [{ desc: 'Revised scope', qty: 2, unitPrice: 1250, pieces: 3 } as any],
    } as any);
    ok(typeof rLines.rowVersion === 'number',
      'W2: Scope of Work edits persist through the same path (the patch shape saveLines sends, carrying the piece count)', rLines);
    const refreshedB = (await buildJobsJson()).find((j: any) => Number(j._relId) === Number(convB.jobId));
    ok(refreshedB.notes === 'Site visit booked for Thursday'
      && (refreshedB.lines || []).length === 1 && Number((refreshedB.lines || [])[0].pQty) === 3,
      'W3: and both survive a fresh read, piece count included', {
        notes: refreshedB.notes, lines: refreshedB.lines });
    const rStage = await services.updateJob(convB.jobId, rLines.rowVersion, { stage: 6, status: STAGE_STATUSES[6] } as any);
    ok(typeof rStage.rowVersion === 'number' &&
      (await buildJobsJson()).find((j: any) => Number(j._relId) === Number(convB.jobId)).stage === 6,
      'W4: manual lifecycle progression (advanceStage) persists and survives a fresh read', rStage);

    // Source pins for the paths the brief asked to be inspected.
    ok(src.includes(`const result = await relationalApi.updateJob(job._relId, job._relRowVersion, { notes: nextNotes });`),
      'W5: saveNotes is wired to the relational job patch');
    ok(src.includes(`const result = await relationalApi.updateJob(job._relId, job._relRowVersion, { lines: patchLines });`),
      'W6: saveLines is wired to the relational job patch');
    ok(src.includes(`const result = await relationalApi.updateJob(job._relId, job._relRowVersion, { stage: ns, status: nextStatus });`),
      'W7: advanceStage is wired to the relational job patch');
    ok(src.includes(`const result = await relationalApi.updateJob(job._relId, job._relRowVersion, { breakdown: bd });`),
      'W8: saveCosts is wired to the relational job patch');
    ok(src.includes(`const result = await relationalApi.updateJob(job._relId, job._relRowVersion, { writeOff: nextVal });`),
      'W9: the write-off toggle is wired to the relational job patch');
    ok((src.match(/relationalApi\.updateJob\(job\._relId, job\._relRowVersion, \{ dueDate: val \}\)/g) || []).length === 2,
      'W10: both due-date editors (JobDetail and the Jobs list) are wired to the relational job patch');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  if (!BASE) {
    console.error('[jobs-autosave-quote-invoice] TEST_SERVER_URL_WITH_AUTHORITY is not set — the REST and sandbox halves cannot run without a live server.');
    process.exit(1);
  }
  const token = await login();

  await captureCutover();
  await setLiveCutover();
  await resetRelational();

  testError1Frontend(src);
  await testError1Backend(token);
  await testError2(src, token);

  console.log(`\n[jobs-autosave-and-quote-invoice-repair] ${passed} passed, ${failures} failed`);
  await restoreCutover();
  await pool.end();
  if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error('[jobs-autosave-and-quote-invoice-repair] Fatal error:', err);
  try { await restoreCutover(); } catch { /* ignore */ }
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
