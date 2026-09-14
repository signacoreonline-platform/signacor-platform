#!/usr/bin/env node
/* ============================================================================
 * discount-display-consistency.test.js
 * Signacore — focused regression suite for the 2026-09-14 discount-presentation
 * repair (Sales → Invoices lost the discount).
 * ============================================================================
 *
 * THE DEFECT
 *   A discounted transaction showed its discount on the Invoice view, on the
 *   printed Invoice/PDF, on the Quote, on the Job's Source Quote panel, on Edit
 *   Invoice and on the Accounting invoice row — but NOT in Sales → Invoices.
 *   Two separate omissions, both display-only:
 *     S1  the Sales list row never rendered a discount at all, and its
 *         canonical-invoice projection did not even carry one
 *     S2  the Sales job-row "View" handed the shared View modal a SINGLE lump
 *         line at value/1.15, so invoiceDiscountView() had no Discount (x%)
 *         line to find and the modal's DISCOUNT tile stayed empty
 *   The totals were correct throughout — `value` has always been the DISCOUNTED
 *   total. Only the statement of the discount was missing.
 *
 * WHAT THIS PROVES
 *   Every representation of one transaction exposes the SAME percentage and the
 *   SAME money, and the totals did not move when the job invoice's presentation
 *   was broken out into lines.
 *
 *   The derivations are LIFTED OUT OF index.html, not re-implemented, so this
 *   suite cannot drift from shipped behaviour.
 *
 * ZERO DEPENDENCIES — plain Node, no ts-node, no babel, no database.
 *   node test/discount-display-consistency.test.js
 *   INDEX_HTML_PATH=/some/other/index.html node test/discount-display-consistency.test.js
 * ==========================================================================*/

'use strict';

const fs = require('fs');
const path = require('path');

const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH ||
  path.resolve(__dirname, '..', '..', 'index.html');

let failures = 0, passed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failures++; console.log('  ✗ ' + label + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}
function section(t) { console.log('\n' + t); }
const near = (a, b, eps) => Math.abs(a - b) <= (eps === undefined ? 0.005 : eps);

/* ── lift the real functions out of index.html ─────────────────────────────
   Same extraction approach as holdings-company-scoped-links.test.js. */

function maskForCounting(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') { out[i] = ' '; i++; } continue; }
    if (c === '/' && d === '*') { out[i] = ' '; out[i + 1] = ' '; i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out[i] = ' '; i++; } if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; } continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out[i] = ' '; i++;
      while (i < n) {
        if (src[i] === '\\') { out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
        if (src[i] === q) { out[i] = ' '; i++; break; }
        out[i] = ' '; i++;
      }
      continue;
    }
    i++;
  }
  return out.join('');
}

function extractFunction(src, name) {
  const decl = '\nfunction ' + name + '(';
  const at = src.indexOf(decl);
  if (at < 0) throw new Error('could not locate top-level function ' + name + ' in index.html');
  const start = at + 1;
  const win = src.slice(start, start + 20000);
  const wm = maskForCounting(win);
  const open = wm.indexOf('{');
  if (open < 0) throw new Error('no body found for ' + name);
  let depth = 0;
  for (let i = open; i < wm.length; i++) {
    if (wm[i] === '{') depth++;
    else if (wm[i] === '}') { depth--; if (depth === 0) return win.slice(0, i + 1); }
  }
  throw new Error('unbalanced body for ' + name);
}

function extractConst(src, masked, name) {
  const re = new RegExp('const\\s+' + name + '\\s*=', 'g');
  const m = re.exec(masked);
  if (!m) throw new Error('could not extract const ' + name);
  const end = masked.indexOf(';', m.index);
  return src.slice(m.index, end + 1);
}

const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
const OPEN = '<script type="text/babel" data-presets="react-classic">';
const startIdx = html.indexOf(OPEN);
if (startIdx < 0) { console.error('Main <script type="text/babel" data-presets="react-classic"> block not found in ' + INDEX_HTML_PATH); process.exit(1); }
const SRC = html.slice(startIdx + OPEN.length, html.lastIndexOf('</script>'));
const MASKED = maskForCounting(SRC);

const WANTED_FNS = [
  // the invoice adjustment-line splitter and the display helper built on it
  'sgrInvoiceLineAmount', 'sgrInvoiceAdjustmentKind', 'sgrSplitInvoiceLineItems',
  'invoiceDiscountView',
  // the writers' own adjustment-line construction
  'docLinesSubtotal', 'stubAdjustmentLines',
  // the shared job-invoice construction (extracted from Accounting 2026-09-14)
  'jobInvoiceLineItems',
  // company-safe quote resolution, for CASE 7
  'companyTagOf', 'sameCompany', 'jobHasId',
  'resolveJobsForQuote', 'resolveJobForQuote', 'resolveQuoteForJob',
  'findSourceQuoteForJob',
];
const CONSTS = ['HOLDINGS_CO_ID', 'HOLDINGS_CO_KEY',
  'SGR_INV_SETUP_FEE_DESC', 'SGR_INV_DISCOUNT_RE', 'SGR_INV_ADJ_EPSILON'];
const pieces = CONSTS.map(c => extractConst(SRC, MASKED, c));
for (const f of WANTED_FNS) pieces.push(extractFunction(SRC, f));
pieces.push('return {' + WANTED_FNS.join(',') + '};');

let A;
try { A = new Function(pieces.join('\n')).call(null); }
catch (e) { console.error('Could not evaluate the lifted functions: ' + e.message); process.exit(1); }

/* ── the surfaces, expressed exactly as index.html expresses them ──────────
   §8 asserts the shipped source still reads this way, so a future edit to
   either screen breaks this suite. */

const invTotalOf = (lineItems) => (lineItems || []).reduce((s, l) => {
  const amt = (parseFloat(l.qty == null ? 1 : l.qty) || 0) * (parseFloat(l.unitAmount) || 0);
  return s + amt + (l.taxType === '15%' ? amt * 0.15 : 0);
}, 0);

// Sales → Invoices, canonical/manual row projection (QuotesPage → manualInvItems)
const salesManualRow = (i) => ({ value: invTotalOf(i.lineItems), _discountView: A.invoiceDiscountView(i) });

// Sales → Invoices, job row projection (QuotesPage → jobInvItems), including the
// company-safe quote re-sync that runs before it.
// 2026-09-14 (c): the quote re-sync no longer touches the job's money. It used
// to rebuild `value`/`discount`/`setupFee`/`lines` from the source quote, which
// produced the PRE-discount total for any transaction whose quote and job carry
// different discounts — the historical population, and the INV-00057 defect.
// Only the quote-owned contact fields are re-synced now, so nothing financial
// is taken from the quote at all.
function salesJobRow(j, quotes) {
  const link = A.resolveQuoteForJob(j, quotes);
  let job = j;
  if (link) {
    job = { ...j, client: link.client };
  }
  const _disc = A.jobInvoiceLineItems(job);
  return { ...job, _discountView: { pct: _disc.discPct, amt: _disc.discAmt } };
}

// Sales → Invoices, the object the job row's "View" hands the shared modal.
function salesJobViewObject(j) {
  const _ji = A.jobInvoiceLineItems(j);
  return { source: 'job', discount: _ji.discPct, discountAmount: _ji.discAmt, lineItems: _ji.lineItems };
}

// The OLD Sales "View" construction, kept only to prove the total did not move.
const salesJobViewObjectBefore = (j) => ({
  lineItems: [{ description: 'x', qty: 1, unitAmount: (parseFloat(j.value) || 0) / 1.15, taxType: '15%' }],
});

// Accounting → Invoices, job row (AccountingPage → getJobInvoices)
function accountingJobRow(j) {
  const { lineItems, discPct, discAmt } = A.jobInvoiceLineItems(j);
  return { source: 'job', discount: discPct, discountAmount: discAmt, lineItems };
}

// Accounting → Invoices row badge, and the shared View Invoice modal tile —
// both read invoiceDiscountView of whatever record they were handed.
const badgeView = (inv) => A.invoiceDiscountView(inv);

const HOLD = 1, OTHER = 2;

/* ═══════════════════════════════════════════════════════════════════════ */
section('CASE 1 — 10% DISCOUNT (subtotal R10,000 → R1,000 off, R10,350 incl. VAT)');
{
  // (a) a stored invoice carrying its discount as an adjustment line
  const storedInv = { lineItems: [
    { description: 'Signage', qty: 1, unitAmount: 10000, taxType: '15%' },
    { description: 'Discount (10%)', qty: 1, unitAmount: -1000, taxType: '15%' },
  ] };
  // (b) the same transaction as a job-derived invoice
  const job = { id: 1, num: 'SNS-00001', co: OTHER, desc: 'Signage', value: 10350,
    discount: '10', setupFee: '', lines: [{ subtotal: 10000 }] };
  // (c) the writers' own adjustment lines, from the canonical quote
  const quoteAdj = A.stubAdjustmentLines({ lines: [{ qty: 1, unitPrice: 10000 }], discount: '10' });

  const vStored = badgeView(storedInv);
  const vSalesManual = salesManualRow(storedInv)._discountView;
  const vSalesJob = salesJobRow(job, [])._discountView;
  const vSalesJobView = badgeView(salesJobViewObject(job));
  const vAccounting = badgeView(accountingJobRow(job));

  for (const [name, v] of [['View Invoice modal / stored invoice', vStored],
                           ['Sales list — canonical row', vSalesManual],
                           ['Sales list — job row', vSalesJob],
                           ['Sales job-row View modal', vSalesJobView],
                           ['Accounting invoice row', vAccounting]]) {
    ok(v.pct === 10, name + ' shows 10%', v);
    ok(near(v.amt, 1000), name + ' shows R1,000.00', v);
  }
  const discLine = quoteAdj.find(l => /^Discount /.test(l.description));
  ok(discLine && discLine.description === 'Discount (10%)' && near(discLine.unitAmount, -1000),
    'the writers\' own adjustment line states the same 10% / R1,000.00', quoteAdj);

  ok(near(invTotalOf(storedInv.lineItems), 10350), 'stored invoice totals R10,350.00');
  ok(near(invTotalOf(accountingJobRow(job).lineItems), 10350), 'Accounting job row totals R10,350.00');
  ok(near(invTotalOf(salesJobViewObject(job).lineItems), 10350), 'Sales job View totals R10,350.00');
  ok(near(salesJobRow(job, []).value, 10350), 'Sales job row value is R10,350.00');
}

section('CASE 2 — NO DISCOUNT (discount_pct = 0 — nothing may be invented)');
{
  const storedInv = { lineItems: [{ description: 'Signage', qty: 1, unitAmount: 10000, taxType: '15%' }] };
  const job = { id: 2, num: 'SNS-00002', co: OTHER, desc: 'Signage', value: 11500, discount: '', setupFee: '', lines: [{ subtotal: 10000 }] };

  for (const [name, v] of [['stored invoice', badgeView(storedInv)],
                           ['Sales list — canonical row', salesManualRow(storedInv)._discountView],
                           ['Sales list — job row', salesJobRow(job, [])._discountView],
                           ['Sales job-row View modal', badgeView(salesJobViewObject(job))],
                           ['Accounting invoice row', badgeView(accountingJobRow(job))]]) {
    ok(v.pct === 0 && v.amt === 0, name + ' reports no discount', v);
  }
  ok(!/discount applied/.test(A.jobInvoiceLineItems(job).lineItems[0].description),
    'the job invoice line carries no "(0% discount applied)" text');
  ok(A.jobInvoiceLineItems(job).canBreakOut === false, 'nothing is broken out when there is no discount');
  ok(near(invTotalOf(salesJobViewObject(job).lineItems), 11500), 'total is unaffected: R11,500.00');
  // The badge itself must render nothing at all for a zero discount.
  ok(/if\(!view \|\| !\(view\.pct > 0\)\) return null;/.test(SRC),
    'InvoiceDiscountBadge returns null rather than drawing a 0% pill');
}

section('CASE 3 — RELATIONAL INVOICE (discount carried by its adjustment line)');
{
  // Exactly what services.ts's writeInvoiceAdjustmentLinesTx / stubAdjustmentLines emit.
  const relInv = { number: 'INV-00300', status: 'sent', lineItems: [
    { description: 'Illuminated sign', qty: 1, unitAmount: 24000, accountCode: '4000', taxType: '15%' },
    { description: 'Discount (12.5%)', qty: 1, unitAmount: -3000, accountCode: '4000', taxType: '15%' },
    { description: 'Design & Setup Fee', qty: 1, unitAmount: 1500, accountCode: '4000', taxType: '15%' },
  ] };
  const row = salesManualRow(relInv);
  ok(row._discountView.pct === 12.5, 'Sales list derives 12.5% from the adjustment line', row._discountView);
  ok(near(row._discountView.amt, 3000), 'Sales list derives R3,000.00');
  ok(badgeView(relInv).pct === row._discountView.pct && near(badgeView(relInv).amt, row._discountView.amt),
    'the View Invoice modal and Accounting derive the identical pair');
  const split = A.sgrSplitInvoiceLineItems(relInv.lineItems);
  ok(split.separated === true, 'the splitter recognises the shape');
  ok(near(split.itemsSubtotal, 24000) && near(split.setupFeeAmt, 1500) && near(split.discAmt, 3000),
    'subtotal / discount / setup fee are separated correctly', split);
  ok(near(split.itemsSubtotal - split.discAmt + split.setupFeeAmt, split.allSubtotal),
    'subtotal − discount + setup fee reproduces the invoice subtotal');
  ok(near(row.value, 22500 * 1.15) && near(row.value, split.total),
    'the Sales row total matches the invoice total exactly', { value: row.value, total: split.total });
}

section('CASE 4 — JOB-DERIVED INVOICE, no invoice record (the job holds the billed facts)');
{
  // The quote's percentage is canonical for the CHAIN and is cascaded onto the
  // job as a synchronised projection — so a converted job carries it too. The
  // job is what the invoice was raised at, and it is what every surface reads.
  const quote = { id: 40, num: 'SQ-00040', co: OTHER, convertedJobId: 41, discount: '10', setupFee: '',
    lines: [{ subtotal: 10000 }], payments: [] };
  const job = { id: 41, num: 'SNS-00041', co: OTHER, quoteNum: 'SQ-00040', desc: 'Signage',
    invoiceNum: 'INV-00400', value: 10350, discount: '10', setupFee: '', lines: [{ subtotal: 10000 }] };

  const row = salesJobRow(job, [quote]);
  ok(row._discountView.pct === 10, 'Sales states the 10% the job was invoiced at', row._discountView);
  ok(near(row._discountView.amt, 1000), 'and R1,000.00 off its own subtotal');
  ok(near(row.value, 10350), 'the displayed total is the discounted R10,350.00');

  /* THE HISTORICAL DIVERGENCE — INV-00057's shape. The discount cascade only
     arrived on 2026-09-07, so an older transaction holds its discount on the
     JOB while its source quote still reads 0. Sales must show what was billed,
     which is the job's own value — not a rebuild from the quote, which would
     produce the PRE-discount total and hide the discount entirely. */
  const staleQuote = { id: 43, num: 'SQ-00043', co: OTHER, convertedJobId: 44, discount: '', setupFee: '',
    lines: [{ subtotal: 10000 }], payments: [] };
  const historicalJob = { id: 44, num: 'SNS-00044', co: OTHER, quoteNum: 'SQ-00043', desc: 'Signage',
    invoiceNum: 'INV-00404', value: 10350, discount: '10', setupFee: '', lines: [{ subtotal: 10000 }] };
  const hist = salesJobRow(historicalJob, [staleQuote]);
  ok(near(hist.value, 10350), 'the historical row shows the DISCOUNTED total, not the quote rebuild', hist.value);
  ok(!near(hist.value, 11500), 'never the pre-discount R11,500.00 the old re-sync produced');
  ok(hist._discountView.pct === 10 && near(hist._discountView.amt, 1000),
    'and states 10% / R1,000.00 rather than the quote\'s empty discount', hist._discountView);
  // With no quote at all the job's own percentage is canonical.
  const soloJob = { id: 42, num: 'SNS-00042', co: OTHER, desc: 'Signage', value: 10350, discount: '10', setupFee: '', lines: [{ subtotal: 10000 }] };
  const solo = salesJobRow(soloJob, []);
  ok(solo._discountView.pct === 10 && near(solo._discountView.amt, 1000),
    'a job with no quote falls back to its own canonical percentage', solo._discountView);
}

section('CASE 5 — HISTORICAL INVOICE (a Discount (x%) line, no legacy inv.discount field)');
{
  const historical = { number: 'INV-00099', status: 'paid', lineItems: [
    { description: 'Pylon sign', qty: 1, unitAmount: 50000, accountCode: '4000', taxType: '15%' },
    { description: 'Discount (7%)', qty: 1, unitAmount: -3500, accountCode: '4000', taxType: '15%' },
  ] };
  ok(historical.discount === undefined && historical.discountAmount === undefined,
    'precondition: the record carries NO legacy discount field');
  const row = salesManualRow(historical);
  ok(row._discountView.pct === 7, 'Sales still shows 7%', row._discountView);
  ok(near(row._discountView.amt, 3500), 'Sales still shows R3,500.00');
  ok(badgeView(historical).pct === 7, 'Accounting and the View modal agree');
  ok(near(row.value, 46500 * 1.15), 'and the total is unchanged at R53,475.00', row.value);

  // A legacy record that DOES carry the stored fields keeps using them.
  const legacy = { number: 'INV-00050', discount: 5, discountAmount: 250, lineItems: [
    { description: 'Signage', qty: 1, unitAmount: 4750, taxType: '15%' } ] };
  const lv = salesManualRow(legacy)._discountView;
  ok(lv.pct === 5 && near(lv.amt, 250), 'a legacy stored discount field is still honoured', lv);
}

section('CASE 6 — DISCOUNT CHANGED AFTER THE INVOICE EXISTS');
{
  // The accepted source-of-truth behaviour: the cascade rewrites the invoice's
  // own Discount (x%) line from the canonical percentage. Every surface reads
  // that line, so all three move together. No payment is involved anywhere.
  const before = { lineItems: [
    { description: 'Signage', qty: 1, unitAmount: 10000, taxType: '15%' },
    { description: 'Discount (10%)', qty: 1, unitAmount: -1000, taxType: '15%' } ],
    payments: [{ id: 'p1', amount: 5000 }] };
  const after = { lineItems: [
    { description: 'Signage', qty: 1, unitAmount: 10000, taxType: '15%' },
    { description: 'Discount (15%)', qty: 1, unitAmount: -1500, taxType: '15%' } ],
    payments: before.payments };

  ok(salesManualRow(before)._discountView.pct === 10, 'before: Sales shows 10%');
  const vSales = salesManualRow(after)._discountView;
  const vOther = badgeView(after);
  ok(vSales.pct === 15 && near(vSales.amt, 1500), 'after: Sales shows 15% / R1,500.00', vSales);
  ok(vOther.pct === 15 && near(vOther.amt, 1500), 'after: Accounting and the View modal show 15% / R1,500.00', vOther);
  ok(near(salesManualRow(after).value, 8500 * 1.15), 'the total moves with it, to R9,775.00');
  ok(after.payments === before.payments && after.payments.length === 1 && after.payments[0].amount === 5000,
    'the payment is untouched — same array, same row, same amount');
  // The same change on the job-derived representation.
  const jobBefore = { value: 10350, discount: '10', setupFee: '', lines: [{ subtotal: 10000 }], desc: 'Signage' };
  const jobAfter = { ...jobBefore, discount: '15', value: 8500 * 1.15 };
  ok(salesJobRow(jobAfter, [])._discountView.pct === 15 &&
     badgeView(accountingJobRow(jobAfter)).pct === 15,
    'the job-derived representation moves to 15% on both screens too');
}

section('CASE 7 — COMPANY ISOLATION (same quote number, different discount)');
{
  const holdQuote = { id: 101, num: 'SQ-00050', co: HOLD, convertedJobId: 201, discount: '5', setupFee: '', lines: [{ subtotal: 10000 }], payments: [] };
  const otherQuote = { id: 102, num: 'SQ-00050', co: OTHER, convertedJobId: 202, discount: '40', setupFee: '', lines: [{ subtotal: 10000 }], payments: [] };
  // The Holdings job carries its own synchronised 5% and its own lines, as the
  // platform stores them. The other company's same-numbered quote carries 40%
  // and must never reach this job — and now cannot, because nothing financial
  // is read from a quote at all.
  const holdJob = { id: 201, num: 'SNS-00901', co: HOLD, quoteNum: 'SQ-00050', desc: 'Signage',
    invoiceNum: 'INV-00901', value: 9500 * 1.15, discount: '5', setupFee: '', lines: [{ subtotal: 10000 }] };

  for (const order of [[otherQuote, holdQuote], [holdQuote, otherQuote]]) {
    const row = salesJobRow(holdJob, order);
    const label = order[0] === otherQuote ? 'other-company quote first' : 'Holdings quote first';
    ok(row._discountView.pct === 5, 'Holdings job shows the HOLDINGS 5%, never the other company\'s 40% (' + label + ')', row._discountView);
    ok(near(row._discountView.amt, 500), 'and R500.00, not R4,000.00 (' + label + ')');
  }
  // A Holdings job whose quote number exists ONLY under the other company.
  const orphanJob = { id: 301, num: 'SNS-00040', co: HOLD, quoteNum: 'SQ-00050', desc: 'Signage',
    invoiceNum: 'INV-00902', value: 11500, discount: '', setupFee: '', lines: [] };
  const orphan = salesJobRow(orphanJob, [otherQuote]);
  ok(orphan._discountView.pct === 0 && orphan._discountView.amt === 0,
    'it borrows no discount at all from the other company\'s quote', orphan._discountView);
  ok(near(orphan.value, 11500), 'and its total is left exactly as the job states it');
}

section('8. SOURCE — one derivation, wired into every changed surface');
{
  ok((SRC.match(/\nfunction jobInvoiceLineItems\(/g) || []).length === 1,
    'jobInvoiceLineItems() is defined exactly once, at module scope');
  ok((SRC.match(/\nfunction InvoiceDiscountBadge\(/g) || []).length === 1,
    'InvoiceDiscountBadge is defined exactly once');
  ok(/const \{ lineItems, discPct, discAmt \} = jobInvoiceLineItems\(j\);/.test(SRC),
    'Accounting\'s getJobInvoices() builds its lines through the shared construction');
  ok(/const _ji = jobInvoiceLineItems\(j\); setViewInvoiceRow\(\{/.test(SRC),
    'the Sales job row\'s View builds the SAME lines through the shared construction');
  ok(!/unitAmount:\(parseFloat\(j\.value\)\|\|0\)\/1\.15/.test(MASKED),
    'the old single lump-line construction is gone from Sales');
  ok(/const _discountView = invoiceDiscountView\(i\);/.test(SRC),
    'Sales\' canonical-invoice projection carries a derived discount view');
  ok(/_discountView:\{ pct:_disc\.discPct, amt:_disc\.discAmt \}/.test(SRC),
    'Sales\' job projection carries a derived discount view');
  // 2026-09-14 (b): the Sales row states the discount in its FINANCIAL block,
  // beside the total it explains, rather than as a pill in the header line
  // where it read as just another tag. Accounting's compact table cell keeps
  // the shared badge. Both still derive from the same _discountView.
  ok(/const _rowDiscount = j\._discountView \|\| \{ pct:0, amt:0 \};/.test(SRC),
    'the Sales invoice row reads the derived discount view');
  ok(SRC.includes('{`Discount: ${_rowDiscount.pct}% (${zar(_rowDiscount.amt)})`}'),
    'and states it as "Discount: x% (Rn)" — percentage AND money — in its financial block');
  ok(/<InvoiceDiscountBadge view=\{invoiceDiscountView\(inv\)\} fmt=\{fmtAmt\}\/>/.test(SRC),
    'the Accounting invoice row renders the same shared badge');
  ok(/_invDiscountView\.pct>0&&/.test(SRC),
    'the shared View Invoice modal still shows its DISCOUNT tile from invoiceDiscountView');
}

section('9. SOURCE — discount authority and company scoping unchanged');
{
  ok(/const storedPct = parseFloat\(inv\.discount\);/.test(SRC),
    'invoiceDiscountView still reads a legacy stored field first, then the lines');
  ok(/function sgrSplitInvoiceLineItems\(lineItems\)\{/.test(SRC),
    'the adjustment-line splitter is unchanged and still the only parser');
  ok((SRC.match(/SGR_INV_DISCOUNT_RE\s*=/g) || []).length === 1,
    'there is still exactly ONE Discount (x%) pattern in the codebase');
  ok(/if\(discAmt>0\.005\) out\.push\(\{ description:`Discount \(\$\{discPct\}%\)`/.test(SRC),
    'stubAdjustmentLines is still the writer of the discount line');
  ok(/const link = resolveQuoteForJob\(j, myQuotes\);/.test(SRC),
    'Sales still resolves a job\'s source quote through the company-safe resolver');
  ok(!/\.find\(\s*q\s*=>\s*q\.num\s*===\s*job\.quoteNum\s*\)/.test(MASKED),
    'no unscoped quote lookup was reintroduced');
  ok(/const srcQ=resolveQuoteForJob\(job, quotes\);/.test(SRC),
    'JobDetail\'s Source Quote panel is likewise unchanged and company-safe');
  ok(MASKED.length > 0, 'index.html main script block was parsed');
}

section('10. TOTALS — the presentation was split, the total was not');
{
  const cases = [
    { label: '10% discount', job: { value: 10350, discount: '10', setupFee: '', lines: [{ subtotal: 10000 }], desc: 'S' } },
    { label: '10% + setup fee', job: { value: (10000 - 1000 + 1500) * 1.15, discount: '10', setupFee: '1500', lines: [{ subtotal: 10000 }], desc: 'S' } },
    { label: 'no discount', job: { value: 11500, discount: '', setupFee: '', lines: [{ subtotal: 10000 }], desc: 'S' } },
    { label: 'discount with no proving lines', job: { value: 10350, discount: '10', setupFee: '', lines: [], desc: 'S' } },
  ];
  for (const c of cases) {
    const before = invTotalOf(salesJobViewObjectBefore(c.job).lineItems);
    const after = invTotalOf(salesJobViewObject(c.job).lineItems);
    ok(near(before, after), c.label + ': the Sales View total is unchanged by the new line breakout', { before, after });
    ok(near(after, parseFloat(c.job.value)), c.label + ': and still equals the job\'s own value');
    ok(near(invTotalOf(accountingJobRow(c.job).lineItems), after),
      c.label + ': Accounting builds the identical total');
  }
  // The unproven shape must NOT be broken out — a discount whose lines do not
  // reconstruct the value is stated, never silently re-derived into the total.
  // 2026-09-14 (c): a discount with no line rows left to prove its subtotal is
  // now recovered from the job's OWN value by inverting the same formula, so it
  // is stated as real money instead of a percentage of nothing. The total is
  // unchanged — asserted immediately above for this very case.
  const unproven = A.jobInvoiceLineItems(cases[3].job);
  ok(unproven.canBreakOut === true, 'a discount with no proving lines is recovered from the job value');
  ok(unproven.lineItems.length === 2 && unproven.lineItems[1].description === 'Discount (10%)',
    'and broken out as a real Discount (10%) line', unproven.lineItems.map(l => l.description));
  ok(Math.abs(unproven.discAmt - 1000) < 0.01, 'stating R1,000.00, not R0.00', unproven.discAmt);
}

/* ── result ─────────────────────────────────────────────────────────────── */
console.log('\n' + '='.repeat(60));
console.log('PASSED: ' + passed + '   FAILED: ' + failures);
console.log('='.repeat(60));
process.exit(failures === 0 ? 0 : 1);
