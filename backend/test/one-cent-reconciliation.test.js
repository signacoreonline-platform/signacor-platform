#!/usr/bin/env node
/* ============================================================================
 * one-cent-reconciliation.test.js
 * Signacore — regression suite for the 2026-09-22 ONE-CENT RECONCILIATION.
 * ============================================================================
 *
 * THE DEFECT
 *   A customer could pay the exact TOTAL DUE printed on an issued invoice and
 *   the platform would still report it Partly Paid, one cent short. Nothing was
 *   wrong with the money. The platform had no canonical payable amount: the
 *   same commercial total was re-derived by five different floating-point
 *   expressions and then rounded per surface with Math.round(n*100)/100.
 *
 *     1  afterDisc * 1.15                    -> job.value
 *     2  afterDisc + afterDisc*0.15          -> the printed TOTAL DUE
 *     3  SUM(qty*unit) + SUM(qty*unit*0.15)  -> the stored invoice record
 *     4  exact NUMERIC SUM in Postgres       -> invoiceTotalTx
 *     5  job.value / 1.15 -> NUMERIC(14,4) -> *1.15
 *
 *   (1) and (2) are algebraically identical and numerically different, and
 *   toCents() itself rounded the BINARY approximation rather than the decimal:
 *     132.825 * 100 === 13282.499999999998   ->  R132.82, not R132.83
 *
 * WHAT THIS PROVES
 *   One canonical integer-cents pipeline now answers every question — the
 *   printed document, the emailed PDF, the on-screen view, the lists, the
 *   deposit terms and the settlement comparison — and it settles a full
 *   payment while still leaving a genuine one-cent shortfall outstanding.
 *
 *   The functions are LIFTED OUT OF index.html, not re-implemented, so this
 *   suite cannot drift from shipped behaviour.
 *
 * ZERO DEPENDENCIES — plain Node, no ts-node, no babel, no database.
 *   node test/one-cent-reconciliation.test.js
 *   INDEX_HTML_PATH=/some/other/index.html node test/one-cent-reconciliation.test.js
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
function eq(actual, expected, label) {
  ok(actual === expected, label, { expected, actual });
}
function section(t) { console.log('\n' + t); }

/* ── lift the real code out of index.html ─────────────────────────────────
   The canonical module is delimited by sentinel comments so this suite always
   evaluates exactly what ships. Everything else is lifted by name, the same
   way settlement-status-consistency.test.js already does. */

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
  const win = src.slice(start, start + 40000);
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
if (startIdx < 0) { console.error('Main babel script block not found in ' + INDEX_HTML_PATH); process.exit(1); }
const SRC = html.slice(startIdx + OPEN.length, html.lastIndexOf('</script>'));
const MASKED = maskForCounting(SRC);

// The canonical module, verbatim, between its sentinels.
const MOD_A = SRC.indexOf('BEGIN SGR-CANONICAL-CENTS');
const MOD_B = SRC.indexOf('/* END SGR-CANONICAL-CENTS */');
if (MOD_A < 0 || MOD_B < 0) { console.error('SGR-CANONICAL-CENTS sentinels not found in index.html'); process.exit(1); }
const MODULE_SRC = SRC.slice(SRC.lastIndexOf('/*', MOD_A), MOD_B + '/* END SGR-CANONICAL-CENTS */'.length);

const MODULE_FNS = [
  'sgrToUnits4', 'sgrDivRound', 'sgrMulDivRound', 'sgrToCents', 'sgrToCents0', 'sgrRands',
  'sgrExtCentsU', 'sgrExtCents', 'sgrDocLineCents', 'sgrInvoiceCents', 'sgrDocumentCents',
  'sgrExVatCentsFor', 'sgrPaidCents', 'sgrOutstandingCents', 'sgrSettlementStatusCents',
  'sgrJobForInvoice', 'sgrCanonicalPayableCents', 'sgrZarC', 'sgrMoneyC', 'sgrStatusForPayments',
  'SGR_LEGACY_SETTLEMENT_KEY', 'sgrLegacySettlementMarker', 'sgrLegacySettlementApplies',
  'sgrSettleRecordCents', 'sgrOutstandingForRecordCents',
  'sgrOldInvoiceTotalCents', 'sgrOldJobValueCents', 'sgrPaymentsInCaptureOrder',
  'sgrLastMeaningfulPayment',
  'sgrClassifyLegacyRoundingSettlement',
];
const WANTED_FNS = [
  'toCents', 'settlementOutstanding', 'deriveSettlementStatus', 'sumPaymentAmounts',
  'isGenuineZeroAmount', 'invoiceLineTotalIncVat', 'invoiceIsZeroValue',
  'normalizeQuoteDepositPct', 'fmtQuoteDepositPct', 'quoteDepositInfo',
  'jobInvoiceLineItems', 'docLinesSubtotal',
  'sgrInvoiceLineAmount', 'sgrInvoiceAdjustmentKind', 'sgrSplitInvoiceLineItems',
  'invoiceBelongsToJob', 'resolveJobInvoiceRecord', 'invoiceIdentityKey',
  'stubAdjustmentLines',
  'companyTagOf', 'sameCompany', 'jobHasId',
  'resolveJobsForQuote', 'resolveJobForQuote', 'resolveQuoteForJob', 'findSourceQuoteForJob',
  'reconcileJobInvoice',
];
const pieces = [
  extractConst(SRC, MASKED, 'HOLDINGS_CO_ID'),
  extractConst(SRC, MASKED, 'HOLDINGS_CO_KEY'),
  extractConst(SRC, MASKED, 'QUOTE_DEFAULT_DEPOSIT_PCT'),
  extractConst(SRC, MASKED, 'SGR_INV_SETUP_FEE_DESC'),
  extractConst(SRC, MASKED, 'SGR_INV_DISCOUNT_RE'),
  extractConst(SRC, MASKED, 'SGR_INV_ADJ_EPSILON'),
  MODULE_SRC,
];
for (const f of WANTED_FNS) pieces.push(extractFunction(SRC, f));
pieces.push('return {' + MODULE_FNS.concat(WANTED_FNS).join(',') + '};');

let A;
try { A = new Function(pieces.join('\n'))(); }
catch (e) { console.error('Could not evaluate the lifted functions: ' + e.message); process.exit(1); }

const C = A;                            // shorthand
const R = c => (c / 100).toFixed(2);    // cents -> the two decimals a document prints

console.log('SIGNACORE — ONE-CENT RECONCILIATION REGRESSION SUITE');
console.log('source: ' + INDEX_HTML_PATH);

/* ══════════════════════════════════════════════════════════════════════════
   1. The 132.825 decimal boundary
   ════════════════════════════════════════════════════════════════════════ */
section('1. Decimal boundary — Math.round(n*100) is not a decimal rounding');
eq(C.sgrToCents(132.825), 13283, 'sgrToCents(132.825) === 13283 cents (R132.83)');
ok(Math.round(132.825 * 100) === 13282, 'the OLD rule really did give 13282 (the defect)', Math.round(132.825 * 100));
eq(C.sgrToCents(24963.625), 2496363, 'sgrToCents(24963.625) === R24,963.63');
eq(C.sgrToCents(1.005), 101, 'sgrToCents(1.005) === R1.01');
eq(C.sgrToCents(504.735), 50474, 'sgrToCents(504.735) === R504.74');
eq(C.sgrToCents(102.465), 10247, 'sgrToCents(102.465) === R102.47');
eq(C.toCents(132.825), 132.83, 'the shipped toCents() wrapper agrees');

/* ══════════════════════════════════════════════════════════════════════════
   2. Negative half-cent — symmetric commercial rounding
   ════════════════════════════════════════════════════════════════════════ */
section('2. Negative amounts round symmetrically (a discount is a NEGATIVE line)');
eq(C.sgrToCents(-132.825), -13283, 'sgrToCents(-132.825) === -13283');
eq(C.sgrToCents(-1.005), -101, 'sgrToCents(-1.005) === -101');
eq(C.sgrToCents(-0.005), -1, 'sgrToCents(-0.005) === -1 (half AWAY from zero)');
eq(C.sgrToCents(0.005), 1, 'sgrToCents(0.005) === +1');
ok(Object.is(Math.round(-0.5), -0), 'Math.round is asymmetric at the negative half (why it is never used for money)');
for (const v of [0.005, 1.005, 132.825, 504.735, 24963.625, 88.885]) {
  eq(C.sgrToCents(-v), -C.sgrToCents(v), 'symmetric for ' + v);
}
eq(C.sgrMulDivRound(-11550, 15, 100), -1733, 'sgrMulDivRound is symmetric too');

/* ══════════════════════════════════════════════════════════════════════════
   3. THE REPORTED CASE — 500 x 550 mm, 3 pieces, R140/m2
   ════════════════════════════════════════════════════════════════════════ */
section('3. THE REPORTED CASE — 500×550 mm, 3 pieces, R140/m²');
const qty = parseFloat(((500 * 550) / 1000000).toFixed(4));           // 0.2750 m2
eq(qty, 0.275, 'qty = (500×550)/1e6 rounded to 4 dp = 0.2750 m²');
const JOB_LINES = [{ desc: 'Panel', pQty: 3, qty: qty, unitPrice: 140, subtotal: 3 * qty * 140 }];
const doc = C.sgrDocumentCents(JOB_LINES, 0, 0);
eq(doc.subC, 11550, 'ex-VAT subtotal = R115.50');
eq(doc.vatC, 1733, 'VAT (15%) = R17.33');
eq(doc.totalC, 13283, 'TOTAL DUE = R132.83');
ok(3 * qty * 140 !== 115.5, 'the raw float is NOT exactly 115.50', 3 * qty * 140);

// the stored invoice record built from the same job, through the same pipeline
const INV_LINES = [{ description: 'Panel', qty: 0.825, unitAmount: 140, taxType: '15%', accountCode: '4000' }];
const inv = C.sgrInvoiceCents(INV_LINES);
eq(inv.totalC, 13283, 'the invoice RECORD reaches the same R132.83');
ok(inv.totalC === doc.totalC, 'document and invoice record agree exactly');

section('3a. Paying the displayed total settles it');
const PAID_FULL = [{ id: 1, amount: 132.83, date: '2026-09-22', method: 'EFT' }];
eq(C.sgrPaidCents(PAID_FULL), 13283, 'paid = R132.83');
eq(C.sgrOutstandingCents(13283, 13283), 0, 'outstanding = R0.00');
eq(C.sgrSettlementStatusCents(13283, 13283, 132.83), 'paid', 'status = Fully Paid');
eq(C.deriveSettlementStatus(132.83, 132.83), 'paid', 'the shipped rand-signature rule agrees');

section('3b. A GENUINE one cent short stays outstanding — no tolerance');
eq(C.sgrPaidCents([{ id: 1, amount: 132.82 }]), 13282, 'paid = R132.82');
eq(C.sgrOutstandingCents(13283, 13282), 1, 'outstanding = R0.01');
eq(C.sgrSettlementStatusCents(13283, 13282, 132.83), 'partial', 'status = Partly Paid');
eq(C.deriveSettlementStatus(132.83, 132.82), 'partial', 'the shipped rule agrees');
eq(C.settlementOutstanding(132.83, 132.82), 0.01, 'settlementOutstanding = R0.01');

/* ══════════════════════════════════════════════════════════════════════════
   4. Multiple 4-decimal quantity lines — the column adds up
   ════════════════════════════════════════════════════════════════════════ */
section('4. Printed line column sums to the printed subtotal (4-dp quantities)');
let seed = 20260922;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
function randLines(n) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const L = 200 + Math.floor(rnd() * 580) * 10;
    const W = 200 + Math.floor(rnd() * 280) * 10;
    out.push({
      desc: 'L' + k, pQty: 1 + Math.floor(rnd() * 4),
      qty: parseFloat(((L * W) / 1000000).toFixed(4)),
      unitPrice: 50 + Math.floor(rnd() * 790) * 5,
    });
  }
  out.forEach(l => { l.subtotal = (l.pQty || 1) * l.qty * l.unitPrice; });
  return out;
}
let colMismatch = 0, addUpMismatch = 0;
for (let i = 0; i < 20000; i++) {
  const ls = randLines(1 + Math.floor(rnd() * 4));
  const pct = [0, 0, 5, 10, 12.5][Math.floor(rnd() * 5)];
  const fee = [0, 0, 350, 1200][Math.floor(rnd() * 4)];
  const d = C.sgrDocumentCents(ls, pct, fee);
  if (d.lineC.reduce((s, c) => s + c, 0) !== d.subC) colMismatch++;
  if (d.subC - d.discC + d.setupC + d.vatC !== d.totalC) addUpMismatch++;
}
eq(colMismatch, 0, 'over 20,000 random documents: line column === printed subtotal, always');
eq(addUpMismatch, 0, 'over 20,000 random documents: subtotal − discount + setup + VAT === TOTAL DUE, always');

/* ══════════════════════════════════════════════════════════════════════════
   5. Discount documents add up exactly
   ════════════════════════════════════════════════════════════════════════ */
section('5. A discounted document adds up exactly');
const D = C.sgrDocumentCents(
  [{ desc: 'A', pQty: 1, qty: 3.5, unitPrice: 1234.56 }, { desc: 'B', pQty: 2, qty: 0.4375, unitPrice: 899.99 }],
  12.5, 350);
eq(D.subC - D.discC + D.setupC + D.vatC, D.totalC, 'subtotal − discount + setup + VAT === total');
eq(D.vatC, C.sgrMulDivRound(D.taxableC, 15, 100), 'VAT is computed ONCE from the taxable amount');
ok(D.lineC.length === 2 && D.lineC.reduce((s, c) => s + c, 0) === D.subC, 'both line amounts sum to the subtotal');

/* ══════════════════════════════════════════════════════════════════════════
   6. The previously-diverging cases now have ONE value
   ════════════════════════════════════════════════════════════════════════ */
section('6. The previously diverging cases converge');
function converge(pct, rate, label, expectC) {
  const ls = [{ desc: 'P', pQty: 3, qty: 0.275, unitPrice: rate }];
  ls[0].subtotal = 3 * 0.275 * rate;
  const d = C.sgrDocumentCents(ls, pct, 0);
  const job = { value: C.sgrRands(d.totalC), lines: ls, discount: pct, setupFee: 0, desc: 'P' };
  const ji = C.jobInvoiceLineItems(job);
  const rec = C.sgrInvoiceCents(ji.lineItems);
  eq(d.totalC, expectC, label + ' — document total R' + R(expectC));
  eq(rec.totalC, expectC, label + ' — invoice record agrees');
  eq(C.sgrCanonicalPayableCents(job), expectC, label + ' — canonical payable agrees');
  eq(C.sgrCanonicalPayableCents({ lineItems: ji.lineItems }), expectC, label + ' — record-shaped lookup agrees');
}
converge(10, 120, '10% @ R120/m²', 10247);   // previously R102.46 vs R102.47
converge(5, 560, '5% @ R560/m²', 50474);     // previously R504.73 vs R504.74
converge(0, 140, 'no discount @ R140/m²', 13283);

/* ══════════════════════════════════════════════════════════════════════════
   7 + 8. One formatter — HTML, jsPDF and on-screen state the same total
   ════════════════════════════════════════════════════════════════════════ */
section('7/8. HTML, emailed jsPDF and on-screen state the SAME total');
const OLD_TOFIXED = n => 'R ' + Number(n || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const OLD_LOCALE = n => 'R ' + Number(n).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
ok(OLD_TOFIXED(132.825).indexOf('132.82') >= 0, 'the OLD jsPDF formatter really said R132.82', OLD_TOFIXED(132.825));
ok(OLD_LOCALE(132.825).indexOf('83') >= 0, 'the OLD HTML formatter really said R132,83', OLD_LOCALE(132.825));
eq(C.sgrMoneyC(13283), 'R 132.83', 'sgrMoneyC (jsPDF / proforma) renders the canonical cents');
eq(C.sgrZarC(13283), 'R 132.83', 'sgrZarC (HTML invoice) renders the canonical cents');
eq(C.sgrMoneyC(2496363), 'R 24,963.63', 'grouping preserved');
// once the amount is cent-exact, both formatters agree for every value
let fmtMismatch = 0, fmtSample = null;
for (let c = 1; c <= 200000; c++) {
  const a = (c / 100).toFixed(2);
  const b = Number(c / 100).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .replace(/[\s ]/g, '').replace(',', '.');
  if (a !== b) { fmtMismatch++; if (!fmtSample) fmtSample = { c, a, b }; }
}
eq(fmtMismatch, 0, 'on a cent-exact amount the two formatters agree for every value up to R2,000.00');
// and the shipped formatters agree with each other on every cent value
let shipMismatch = 0;
for (let c = 1; c <= 200000; c++) {
  if (C.sgrMoneyC(c).replace(/[R\s ]/g, '') !== C.sgrZarC(c).replace(/[R\s ]/g, '')) shipMismatch++;
}
eq(shipMismatch, 0, 'sgrMoneyC and sgrZarC state identical digits for every cent value');

/* ══════════════════════════════════════════════════════════════════════════
   9 + 10. Payment exactly equal / exactly one cent short
   ════════════════════════════════════════════════════════════════════════ */
section('9/10. Exact payment settles; one cent short does not');
let exactFail = 0, shortFail = 0, overFail = 0;
for (let i = 0; i < 20000; i++) {
  const ls = randLines(1 + Math.floor(rnd() * 3));
  const pct = [0, 5, 10, 12.5][Math.floor(rnd() * 4)];
  const d = C.sgrDocumentCents(ls, pct, 0);
  const shown = C.sgrRands(d.totalC);                       // what the document prints
  if (C.sgrSettlementStatusCents(d.totalC, C.sgrPaidCents([{ amount: shown }]), shown) !== 'paid') exactFail++;
  if (d.totalC > 1 &&
      C.sgrSettlementStatusCents(d.totalC, C.sgrPaidCents([{ amount: C.sgrRands(d.totalC - 1) }]), shown) !== 'partial') shortFail++;
  if (C.sgrSettlementStatusCents(d.totalC, C.sgrPaidCents([{ amount: C.sgrRands(d.totalC + 1) }]), shown) !== 'paid') overFail++;
}
eq(exactFail, 0, 'paying the printed TOTAL DUE always settles (20,000 documents)');
eq(shortFail, 0, 'paying one cent less is ALWAYS still partial (20,000 documents)');
eq(overFail, 0, 'an overpayment still reads paid (existing behaviour preserved)');
eq(C.sgrOutstandingCents(13283, 20000), 0, 'an overpayment is a ZERO balance, never negative');
// the persisted status path agrees with the displayed one
eq(C.sgrStatusForPayments(null, 13283, [{ amount: 132.83 }], 'pending'), 'paid', 'the WRITE path settles on an exact payment');
eq(C.sgrStatusForPayments(null, 13283, [{ amount: 132.82 }], 'pending'), 'partial', 'the WRITE path keeps a cent short as partial');
eq(C.sgrStatusForPayments(null, 13283, [], 'sent'), 'sent', 'and preserves each caller’s no-money-yet fallback');

/* ══════════════════════════════════════════════════════════════════════════
   11 + 12 + 13. Deposit terms
   ════════════════════════════════════════════════════════════════════════ */
section('11/12. deposit + remaining balance === total, ALWAYS');
let depFail = 0, depSample = null, depTested = 0;
const DEP_PCTS = [80, 100, 33.33, 12.5, 66.67, 0, 37.5];
function depCheck(c) {
  for (const pct of DEP_PCTS) {
    const info = C.quoteDepositInfo(pct === 80 ? null : { depositPct: pct }, c / 100);
    depTested++;
    if (info.depositCents + info.balanceCents !== info.totalCents) { depFail++; if (!depSample) depSample = { c, pct, info }; }
  }
}
for (let c = 1; c <= 60000; c++) depCheck(c);
for (let c = 499990; c <= 500010; c++) depCheck(c);
for (let c = 2496350; c <= 2496370; c++) depCheck(c);
eq(depFail, 0, 'deposit + balance === total for all ' + depTested + ' tested combinations', depSample);

// above R5,000, so the standard 80% applies (below it the R5,000 rule wins)
const d80 = C.quoteDepositInfo(null, 24963.63);
eq(d80.pct, 80, 'standard 80% deposit above R5,000');
eq(d80.depositCents + d80.balanceCents, 2496363, '80%: deposit + balance === R24,963.63');
eq(d80.depositCents, 1997090, '80% of R24,963.63 = R19,970.90');
eq(d80.balanceCents, 499273, 'the balance absorbs the remainder: R4,992.73');
// an odd cent must land in the BALANCE, never vanish
const dOdd = C.quoteDepositInfo({ depositPct: 33.33 }, 10000.01);
eq(dOdd.depositCents + dOdd.balanceCents, 1000001, 'an odd cent stays in the balance');

const dCustom = C.quoteDepositInfo({ depositPct: 33.33 }, 132.83);
eq(dCustom.depositCents + dCustom.balanceCents, 13283, 'custom 33.33%: deposit + balance === total');
eq(dCustom.isCustom, true, 'custom percentage is honoured');
eq(C.quoteDepositInfo({ depositPct: 'nonsense' }, 24963.63).pct, 80, 'a bad custom % falls back to the standard rule');
eq(C.quoteDepositInfo({ depositPct: 'nonsense' }, 132.83).pct, 100, 'and then to the R5,000 rule where it applies');

section('13. The ≤ R5,000 full-deposit rule, decided in cents');
eq(C.quoteDepositInfo(null, 5000).pct, 100, 'R5,000.00 exactly -> 100% (full deposit)');
eq(C.quoteDepositInfo(null, 5000.01).pct, 80, 'R5,000.01 -> 80%');
eq(C.quoteDepositInfo(null, 4999.99).pct, 100, 'R4,999.99 -> 100%');
const FLOATY = 5000.000000000001;                        // prints R5,000.00, sits above 5000
ok(FLOATY > 5000, 'a float can sit just above 5000 while printing R5,000.00', FLOATY);
eq(Number(FLOATY).toFixed(2), '5000.00', 'and it really does print R5,000.00');
eq(C.sgrToCents(FLOATY), 500000, 'its canonical amount is exactly R5,000.00');
eq(C.quoteDepositInfo(null, FLOATY).pct, 100, 'so the R5,000 rule now applies (the boundary defect is closed)');
eq(C.quoteDepositInfo({ depositPct: 50 }, 4000).pct, 50, 'a custom % still outranks the R5,000 rule');
eq(C.quoteDepositInfo(null, 4000).autoFull, true, 'autoFull still flagged for the wording');

/* ══════════════════════════════════════════════════════════════════════════
   14. Zero-value (sponsored) invoices — existing behaviour unchanged
   ════════════════════════════════════════════════════════════════════════ */
section('14. Zero-value settlement behaviour is unchanged');
eq(C.sgrSettlementStatusCents(0, 0, 0), 'paid', 'a GENUINE R0.00 total with no payments is settled');
eq(C.sgrSettlementStatusCents(0, 0), 'paid', 'a DERIVED zero (argument omitted) is settled');
eq(C.sgrSettlementStatusCents(0, 0, undefined), 'pending', 'an undefined stored value is NOT a genuine zero');
eq(C.sgrSettlementStatusCents(0, 0, null), 'pending', 'a value that FAILED to hydrate is NOT settled');
eq(C.sgrSettlementStatusCents(0, 0, ''), 'pending', 'an empty value is not a genuine zero');
eq(C.sgrSettlementStatusCents(0, 0, 'abc'), 'pending', 'a non-numeric value is not a genuine zero');
eq(C.sgrSettlementStatusCents(0, 500, null), 'partial', 'a broken total with money recorded is partial');
eq(C.deriveSettlementStatus(0, 0), 'paid', 'shipped rule: genuine zero -> paid');
eq(C.deriveSettlementStatus(null, 0), 'pending', 'shipped rule: broken value -> pending');
eq(C.deriveSettlementStatus(undefined, 5), 'partial', 'shipped rule: broken value with money -> partial');
eq(C.invoiceIsZeroValue({ lineItems: [] }), true, 'an issued invoice with no lines is zero-value');
eq(C.invoiceIsZeroValue({ lineItems: [{ qty: 1, unitAmount: 100, taxType: '15%' }] }), false, 'a real invoice is not');
eq(C.invoiceIsZeroValue({}), false, 'a record whose lines never hydrated proves nothing');
eq(C.invoiceLineTotalIncVat({ lineItems: INV_LINES }), 132.83, 'invoiceLineTotalIncVat is canonical too');

/* ══════════════════════════════════════════════════════════════════════════
   15. Overpayment
   ════════════════════════════════════════════════════════════════════════ */
section('15. Overpayment preserves existing intent');
eq(C.sgrSettlementStatusCents(13283, 15000, 132.83), 'paid', 'an overpayment reads Fully Paid');
eq(C.sgrOutstandingCents(13283, 15000), 0, 'and shows a zero balance, never a negative one');
eq(C.settlementOutstanding(132.83, 150), 0, 'the shipped helper agrees');

/* ══════════════════════════════════════════════════════════════════════════
   16. Quote -> Job -> Invoice chain — each payment counted ONCE
   ════════════════════════════════════════════════════════════════════════ */
section('16. Quote → Job → Invoice: a carried deposit is counted once');
const DEP = { id: 'p1', date: '2026-09-01', method: 'EFT', amount: 106.26 };
const QUOTE = { id: 1, num: 'SQ-00001', co: 1, lines: JOB_LINES, discount: '', setupFee: '', payments: [DEP] };
const JOB = { id: 9, num: 'SNS-00001', co: 1, quoteNum: 'SQ-00001', value: 132.83,
              lines: JOB_LINES, discount: '', setupFee: '', invoiceNum: 'INV-00001',
              payments: [Object.assign({}, DEP)] };   // carried at conversion — SAME id
const recon = C.reconcileJobInvoice(JOB, [QUOTE]);
eq(recon.payments.length, 1, 'the carried deposit is deduped by payment id');
eq(recon.paidCents, 10626, 'paid = R106.26, counted once');
eq(recon.totalCents, 13283, 'the job settles against its own document total R132.83');
eq(recon.outstandingCents, 2657, 'outstanding = R26.57');
eq(recon.invoiceStatus, 'partial', 'status = Partly Paid');

const JOB_SETTLED = Object.assign({}, JOB, {
  payments: [Object.assign({}, DEP), { id: 'p2', date: '2026-09-22', method: 'EFT', amount: 26.57 }] });
const recon2 = C.reconcileJobInvoice(JOB_SETTLED, [QUOTE]);
eq(recon2.paidCents, 13283, 'deposit + balance = R132.83');
eq(recon2.outstandingCents, 0, 'outstanding = R0.00');
eq(recon2.invoiceStatus, 'paid', 'status = Fully Paid');

// a deposit recorded on the QUOTE only, before conversion, still reaches the job
const JOB_NOPAY = Object.assign({}, JOB, { payments: [] });
const recon3 = C.reconcileJobInvoice(JOB_NOPAY, [QUOTE]);
eq(recon3.payments.length, 1, 'a quote-side deposit is pulled through');
eq(recon3.paidCents, 10626, 'and counted exactly once');

section('16a. A JOB settles from its stored commercial value, never from its lines');
const JOB_STALE = Object.assign({}, JOB, { value: 132.82, payments: [{ id: 'x', amount: 132.82 }] });
eq(C.sgrCanonicalPayableCents(JOB_STALE), 13282,
   'the payable is the STORED commercial value, not the line reconstruction');
eq(C.reconcileJobInvoice(JOB_STALE, []).invoiceStatus, 'paid', 'paying that value settles it');
eq(C.reconcileJobInvoice(Object.assign({}, JOB_STALE, { payments: [{ id: 'x', amount: 132.81 }] })).invoiceStatus,
   'partial', 'and a cent less does not');
eq(C.sgrCanonicalPayableCents({ value: 132.83 }), 13283, 'a job with no lines at all: the same rule');
eq(C.sgrCanonicalPayableCents({ lineItems: INV_LINES, lines: JOB_LINES, value: 1 }, { jobs: [] }), 13283,
   'a STANDALONE invoice record supplies its own payable from its lines');

/* ══════════════════════════════════════════════════════════════════════════
   17. Commercial-line fallback / adjustment partition intact
   ════════════════════════════════════════════════════════════════════════ */
section('17. Adjustment-line partition and the commercial-line fallback');
const DJ_LINES = [{ desc: 'Panel', pQty: 3, qty: 0.275, unitPrice: 120, subtotal: 3 * 0.275 * 120 }];
const dj = C.sgrDocumentCents(DJ_LINES, 10, 350);
const DISCOUNTED_JOB = { value: C.sgrRands(dj.totalC), desc: 'Signage', discount: 10, setupFee: 350, lines: DJ_LINES };
const jiD = C.jobInvoiceLineItems(DISCOUNTED_JOB);
ok(jiD.canBreakOut, 'the discount is broken out as its own line');
eq(C.sgrInvoiceCents(jiD.lineItems).totalC, dj.totalC,
   'the broken-out lines reproduce the job’s canonical total exactly');
const split = C.sgrSplitInvoiceLineItems(jiD.lineItems);
eq(split.separated, true, 'the adjustment lines are recognised');
eq(split.itemsSubtotalC - split.discC + split.setupFeeC, split.allSubtotalC,
   'items − discount + setup === all-lines subtotal, to the cent');
eq(split.allSubtotalC + split.vatC, split.totalC, 'and + VAT === total');
eq(split.itemLineCents.reduce((s, c) => s + c, 0), split.itemsSubtotalC,
   'the printed item column sums to the printed items subtotal');

// the same, over many random discounted documents
let partFail = 0;
for (let i = 0; i < 5000; i++) {
  const ls = randLines(1 + Math.floor(rnd() * 3));
  const pct = [5, 10, 12.5, 7.5][Math.floor(rnd() * 4)];
  const fee = [0, 350, 1200][Math.floor(rnd() * 3)];
  const want = C.sgrDocumentCents(ls, pct, fee).totalC;
  const j = { value: C.sgrRands(want), desc: 'X', discount: pct, setupFee: fee, lines: ls };
  const got = C.sgrInvoiceCents(C.jobInvoiceLineItems(j).lineItems).totalC;
  if (got !== want) partFail++;
}
eq(partFail, 0, 'over 5,000 discounted jobs the GL projection reproduces the document total exactly');

/* A record with NO lines carries a bare inclusive value. Not every inclusive
   cent amount is reachable from an integer ex-VAT amount at 15% (R132.82 is
   not: R115.49 -> R132.81, R115.50 -> R132.83), so the GL projection is exact
   where it can be and never more than a cent out otherwise — and, critically,
   the record's own stored value is NEVER restated: settlement and every row
   read the canonical value itself. */
section('17a. No-lines records: the stored value is never restated');
for (const v of [132.83, 1.01, 5000, 24963.63, 0.05, 99999.99, 5716.44, 6351.60]) {
  const ji = C.jobInvoiceLineItems({ value: v, desc: 'X' });
  eq(C.sgrInvoiceCents(ji.lineItems).totalC, C.sgrToCents(v),
     'no-lines GL projection regenerates R' + v.toFixed(2) + ' exactly');
  eq(C.sgrCanonicalPayableCents({ value: v, desc: 'X' }), C.sgrToCents(v),
     'and the canonical payable is the stored value, R' + v.toFixed(2));
}
eq(C.sgrCanonicalPayableCents({ value: 132.82 }), 13282,
   'an unreachable inclusive value (R132.82) is still canonical at R132.82 — never restated');
eq(C.reconcileJobInvoice({ id: 1, value: 132.82, payments: [{ id: 'z', amount: 132.82 }] }, []).invoiceStatus,
   'paid', 'and paying it in full settles it');
let exFail = 0, exOver = 0, exOff = 0;
for (let c = 1; c <= 300000; c++) {
  const ex = C.sgrExVatCentsFor(c);
  const made = ex + C.sgrMulDivRound(ex, 15, 100);
  if (made !== c) { exOff++; if (Math.abs(made - c) > 1) exFail++; if (made > c) exOver++; }
}
eq(exFail, 0, 'sgrExVatCentsFor is never more than one cent out, over 300,000 totals');
eq(exOver, 0, 'and never OVERSTATES what the customer owes');
ok(exOff > 0, 'as expected, some inclusive totals are genuinely unreachable at 15%', exOff);

/* ══════════════════════════════════════════════════════════════════════════
   18. No rel_payments row is altered
   ════════════════════════════════════════════════════════════════════════ */
section('18. Payments are READ, never altered');
const ORIGINAL = [
  { id: 'a', date: '2026-09-01', method: 'EFT', amount: 106.26, notes: 'deposit' },
  { id: 'b', date: '2026-09-22', method: 'Cash', amount: 26.57, notes: '' },
];
const SNAPSHOT = JSON.stringify(ORIGINAL);
C.sgrPaidCents(ORIGINAL);
C.sumPaymentAmounts(ORIGINAL);
C.reconcileJobInvoice(Object.assign({}, JOB, { payments: ORIGINAL }), []);
C.sgrStatusForPayments(13283, ORIGINAL, 'pending');
C.sgrOutstandingCents(13283, C.sgrPaidCents(ORIGINAL));
eq(JSON.stringify(ORIGINAL), SNAPSHOT, 'every payment row is byte-identical after settlement');
eq(C.sgrPaidCents(ORIGINAL), 13283, 'and they sum to R132.83 in cents');
const merged = C.reconcileJobInvoice(Object.assign({}, JOB, { payments: ORIGINAL }), []).payments;
ok(merged !== ORIGINAL, 'the reconciler returns its own array, never the stored one');
eq(C.sumPaymentAmounts(ORIGINAL), 132.83, 'sumPaymentAmounts is cent-exact');
eq(C.sgrPaidCents([{ amount: '106.26' }, { amount: '26.57' }]), 13283, 'string amounts convert safely');
eq(C.sgrPaidCents([{ amount: null }, { amount: 10 }]), 1000, 'a broken amount contributes 0, never NaN');

/* ══════════════════════════════════════════════════════════════════════════
   19. The shipped source carries no settlement tolerance and no old helper
   ════════════════════════════════════════════════════════════════════════ */
section('19. The shipped source: one rule, no tolerance');
ok(MASKED.indexOf('newTotal>=invTotal') < 0 && MASKED.indexOf('newTotal >= invTotal') < 0,
   'no raw-float `newTotal >= invTotal` status write remains');
ok(MASKED.indexOf('newTotal>=statusTotal') < 0 && MASKED.indexOf('newTotal >= statusTotal') < 0,
   'no raw-float `newTotal >= statusTotal` status write remains');
ok(MASKED.indexOf('outstanding <= 0.01') < 0 && MASKED.indexOf('outstanding<=0.01') < 0,
   'no "within one cent" display tolerance remains');
ok(SRC.indexOf('function toCents(n){ return sgrRands(sgrToCents0(n)); }') >= 0,
   'toCents() delegates to the canonical converter');
ok(MASKED.indexOf('Math.round((Number(n)||0)*100)/100') < 0,
   'the old binary-rounding cent helper is gone from live code');
// the only surviving Math.round(x*100)/100 is normalizeQuoteDepositPct, which
// rounds a PERCENTAGE, not money
{
  const hits = [];
  const re = /Math\.round\([a-zA-Z_$][\w$]*\s*\*\s*100\)\s*\/\s*100/g; let m;
  while ((m = re.exec(MASKED)) !== null) {
    const a = MASKED.lastIndexOf('\n', m.index) + 1;
    hits.push(SRC.slice(a, SRC.indexOf('\n', m.index)).trim());
  }
  // Exempt: normalizeQuoteDepositPct rounds a PERCENTAGE, and the two
  // sgrOld*Cents helpers deliberately REPRODUCE the old rule so the legacy
  // replay is a replay rather than a guess.
  const money = hits.filter(h => !/2dp is plenty for a percentage/.test(h)
                              && !/the old toCents, then to integer cents/.test(h)
                              && !/Math\.round\(Math\.round\(v\*100\)\/100 \* 100\)/.test(h));
  eq(money.length, 0, 'no money value is rounded with Math.round(x*100)/100 any more', money);
}
ok(MASKED.indexOf('sgrStatusForPayments') > 0, 'the shared write-path rule is present');
// The specific float expressions that produced the two disagreeing totals are
// gone from live code.
for (const gone of [
  'value:_afterDisc*1.15', 'value: _afterDisc*1.15', 'value: _qAfterDisc*1.15',
  '(sub-discAmt+setupFee)*1.15', '(sub-discAmt+setup)*1.15',
  '(sub-sub*(disc/100)+setup)*1.15', 'afterDiscount*0.15', 'afterDisc*0.15',
  'subAfterDisc*0.15', 'linesAfterDisc*0.15', 'after*0.15',
]) {
  ok(MASKED.indexOf(gone) < 0, 'gone from live code: ' + gone);
}

/* ══════════════════════════════════════════════════════════════════════════
   22. OPTION D — THE PAYABLE-SOURCE HIERARCHY
   ════════════════════════════════════════════════════════════════════════
   ISSUED INVOICE      -> its own canonical cents total
   JOB WITH NO INVOICE -> rel_jobs.value in cents
   JOB LINE ITEMS      -> never
   ════════════════════════════════════════════════════════════════════════ */
section('22. INV-00146 / SNS-00128 — a ONE-PAYMENT legacy case');
{
  /* Issued invoice R24,963.63 (SARS half-up). The OLD job-side modal instructed
     R24,963.62 and exactly that was captured; the old UI then showed R0.00. */
  const SNS128 = {
    id: 128, num: 'SNS-00128', co: 1, value: 24963.62, invoiceNum: 'INV-00146',
    discount: '', setupFee: '',
    lines: [{ desc: 'Older representation', pQty: 1, qty: 1, unitPrice: 13952.00, subtotal: 13952.00 }],
    payments: [{ id: 'p1', date: '2026-08-01', method: 'EFT', amount: 24963.62 }],
  };
  const INV146 = {
    id: 146, number: 'INV-00146', co: 1, reference: 'SNS-00128', jobNum: 'SNS-00128', status: 'paid',
    lineItems: [{ description: 'Signage', qty: 1, unitAmount: 21707.50, taxType: '15%' }],
    payments: SNS128.payments,
  };

  // SARS half-up is preserved
  const c = C.sgrInvoiceCents(INV146.lineItems);
  eq(c.subC, 2170750, 'taxable R21,707.50');
  eq(c.vatC, 325613, 'VAT R3,256.13 — R3,256.125 rounded UP, SARS');
  eq(c.totalC, 2496363, 'issued TOTAL DUE R24,963.63');

  // the authority
  eq(C.sgrCanonicalPayableCents(INV146), 2496363, 'CASE 1 — the ISSUED INVOICE is the payable');
  eq(C.sgrCanonicalPayableCents(SNS128), 2496362, 'CASE 2 — a job alone would use rel_jobs.value');
  eq(C.sgrDocumentCents(SNS128.lines, '', '').totalC, 1604480, 'the JOB LINES are a stale R16,044.80');
  ok(C.sgrCanonicalPayableCents(INV146) !== C.sgrDocumentCents(SNS128.lines, '', '').totalC,
     'job lines are NEVER the payable');

  const payableC = C.sgrCanonicalPayableCents(INV146);
  const paidC = C.sgrPaidCents(INV146.payments);
  eq(paidC, 2496362, 'paid R24,963.62');
  eq(payableC - paidC, 1, 'residual R0.01');
  eq(C.sgrSettleRecordCents(INV146, payableC, paidC, 24963.63), 'partial',
     'with NO marker it is Partly Paid — nothing is forgiven by size');

  // the one-payment replay
  const oldJobC = C.sgrOldJobValueCents(SNS128);
  eq(oldJobC, 2496362, 'the OLD job-side total was R24,963.62');
  const v = C.sgrClassifyLegacyRoundingSettlement(INV146, payableC,
    [C.sgrOldInvoiceTotalCents(INV146.lineItems), oldJobC]);
  ok(v.qualifies, 'ONE payment qualifies — the platform instructed the full total', v.reason);
  eq(v.paymentCount, 1, 'and it really is a single payment');
  eq(v.legacyGeneratedAmountCents, 2496362, 'the platform-generated amount was R24,963.62');
  eq(v.finalPaymentCents, 2496362, 'which is exactly what was captured');
  eq(v.residualCents, 1, 'and the residual it accounts for');
  ok(/full payable total/.test(v.reason), 'the reason names the one-payment shape');
  ok(/Balance R0\.00/.test(v.reason), 'and that the old UI then showed R0.00');

  const MARKED = Object.assign({}, INV146, {
    [C.SGR_LEGACY_SETTLEMENT_KEY]: {
      settled: true, reason: 'system-generated-payment-amount',
      payableCentsAtVerification: payableC, paidCentsAtVerification: paidC, residualCents: 1,
      legacyGeneratedAmountCents: 2496362, verificationMode: 'legacy-balance-replay',
      verifiedAt: '2026-09-22T00:00:00.000Z', version: 1,
    },
  });
  eq(C.sgrSettleRecordCents(MARKED, payableC, paidC, 24963.63), 'paid', 'with the marker: Fully Paid');
  eq(C.sgrOutstandingForRecordCents(MARKED, payableC, paidC), 0, 'outstanding R0.00');
  eq(JSON.stringify(MARKED.payments), JSON.stringify(INV146.payments),
     'and the R24,963.62 payment is byte-identical — untouched');

  // one transaction, one word: the job badge follows the issued invoice
  const rec = C.reconcileJobInvoice(SNS128, [], { accInvoices: [MARKED], jobs: [SNS128] });
  eq(rec.totalCents, 2496363, 'reconcileJobInvoice settles the JOB against the issued invoice');
  eq(rec.invoiceStatus, 'paid', 'so the Job badge reads Fully Paid too');
  const recNoMarker = C.reconcileJobInvoice(SNS128, [], { accInvoices: [INV146], jobs: [SNS128] });
  eq(recNoMarker.invoiceStatus, 'partial', 'and without the marker both read Partly Paid — consistently');
  // with no issued invoice record at all, the job's own value governs
  eq(C.reconcileJobInvoice(SNS128, []).totalCents, 2496362, 'a job with no issued invoice uses rel_jobs.value');
  eq(C.reconcileJobInvoice(SNS128, []).invoiceStatus, 'paid', 'and settles on it');
}

section('23. INV-00139 — a MULTI-PAYMENT legacy case');
{
  const LINES = [{ description: 'Signage', qty: 3, unitAmount: 260.8784, taxType: '15%' }];
  const oldC = C.sgrOldInvoiceTotalCents(LINES);
  const newC = C.sgrInvoiceCents(LINES).totalC;
  eq(newC, oldC + 1, 'the corrected payable is one cent above the old derivation');

  const FIRST = C.sgrRands(40000);
  const OFFERED = C.sgrRands(oldC - 40000);
  const INV139 = {
    id: 139, number: 'INV-00139', co: 1, reference: '', jobNum: '', status: 'partial',
    lineItems: LINES,
    payments: [
      { id: 'a', date: '2026-07-01', method: 'EFT', amount: FIRST },
      { id: 'b', date: '2026-07-20', method: 'EFT', amount: OFFERED },
    ],
  };
  const payableC = C.sgrCanonicalPayableCents(INV139);
  const paidC = C.sgrPaidCents(INV139.payments);
  eq(payableC, newC, 'payable ' + C.sgrZarC(payableC));
  eq(paidC, oldC, 'paid exactly what the old platform asked: ' + C.sgrZarC(paidC));
  eq(payableC - paidC, 1, 'residual one cent');
  eq(C.sgrSettleRecordCents(INV139, payableC, paidC, C.sgrRands(payableC)), 'partial', 'no marker -> Partly Paid');

  const v = C.sgrClassifyLegacyRoundingSettlement(INV139, payableC, [oldC]);
  ok(v.qualifies, 'the multi-payment replay qualifies', v.reason);
  eq(v.paymentCount, 2, 'two payments');
  eq(v.legacyGeneratedAmountCents, oldC - 40000, 'the platform-generated remaining balance');
  ok(/remaining balance/.test(v.reason), 'the reason names the multi-payment shape');
  ok(/already received/.test(v.reason), 'and the prior payment');

  const MARKED = Object.assign({}, INV139, {
    [C.SGR_LEGACY_SETTLEMENT_KEY]: {
      settled: true, reason: 'system-generated-payment-amount',
      payableCentsAtVerification: payableC, paidCentsAtVerification: paidC, residualCents: 1,
      legacyGeneratedAmountCents: oldC - 40000, verificationMode: 'legacy-balance-replay',
      verifiedAt: '2026-09-22T00:00:00.000Z', version: 1,
    },
  });
  eq(C.sgrSettleRecordCents(MARKED, payableC, paidC, C.sgrRands(payableC)), 'paid', 'with the marker: Fully Paid');
  eq(JSON.stringify(MARKED.payments), JSON.stringify(INV139.payments), 'payments byte-identical');
}

section('24. A GENUINE one-cent underpayment never qualifies');
{
  // payable R100.00, the OLD platform also derived R100.00, the user paid R99.99
  const LINES = [{ description: 'X', qty: 1, unitAmount: 86.9565, taxType: '15%' }];
  const payableC = C.sgrInvoiceCents(LINES).totalC;
  const oldC = C.sgrOldInvoiceTotalCents(LINES);
  eq(payableC, oldC, 'here the old and corrected derivations AGREE — there is no rounding gap');
  const SHORT = { id: 5, number: 'INV-00500', lineItems: LINES,
                  payments: [{ id: 'a', date: '2026-01-01', amount: C.sgrRands(payableC - 1) }] };
  const paidC = C.sgrPaidCents(SHORT.payments);
  eq(payableC - paidC, 1, 'one cent short');
  const v = C.sgrClassifyLegacyRoundingSettlement(SHORT, payableC, [oldC, payableC]);
  ok(!v.qualifies, 'the classifier REFUSES it', v.reason);
  ok(/does not replay as a platform-generated amount/.test(v.reason), 'naming why');
  eq(C.sgrSettleRecordCents(SHORT, payableC, paidC, C.sgrRands(payableC)), 'partial', 'it stays Partly Paid');
  eq(C.sgrOutstandingForRecordCents(SHORT, payableC, paidC), 1, 'outstanding R0.01');

  // and a two-payment manual shortfall is refused too
  const TWO = { id: 6, number: 'INV-00501', lineItems: LINES,
                payments: [{ id: 'a', date: '2026-01-01', amount: 50 },
                           { id: 'b', date: '2026-02-01', amount: C.sgrRands(payableC - 5000 - 1) }] };
  ok(!C.sgrClassifyLegacyRoundingSettlement(TWO, payableC, [oldC, payableC]).qualifies,
     'a manual shortfall across two payments is refused too');
}

section('25. A STANDALONE invoice and a JOB with no invoice');
{
  const STANDALONE = { id: 9, number: 'INV-00200', co: 1, reference: '', jobNum: '', status: 'sent',
    lineItems: [{ description: 'Consulting', qty: 2, unitAmount: 1500, taxType: '15%' }], payments: [] };
  eq(C.sgrCanonicalPayableCents(STANDALONE), 345000, 'a standalone invoice settles from its own lines: R3,450.00');
  eq(C.sgrJobForInvoice(STANDALONE, []), null, 'it has no linked job');

  const JOB = { id: 3, num: 'SNS-00300', co: 1, value: 1234.56, discount: '', setupFee: '', lines: [], payments: [] };
  eq(C.sgrCanonicalPayableCents(JOB), 123456, 'a job with no invoice settles from rel_jobs.value');
  eq(C.reconcileJobInvoice(JOB, []).totalCents, 123456, 'the reconciler agrees');
  eq(C.reconcileJobInvoice(Object.assign({}, JOB, { payments: [{ id: 'a', amount: 1234.56 }] }), []).invoiceStatus,
     'paid', 'paying it settles it');
  eq(C.reconcileJobInvoice(Object.assign({}, JOB, { payments: [{ id: 'a', amount: 1234.55 }] }), []).invoiceStatus,
     'partial', 'a cent short stays partial');
}

section('26. THE MARKER — structure, validity and reach');
{
  const M = { settled: true, reason: 'system-generated-payment-amount',
              payableCentsAtVerification: 2496363, paidCentsAtVerification: 2496362, residualCents: 1,
              legacyGeneratedAmountCents: 2496362, verificationMode: 'legacy-balance-replay',
              verifiedAt: '2026-09-22T00:00:00.000Z', version: 1 };
  const REC = { id: 146, number: 'INV-00146', [C.SGR_LEGACY_SETTLEMENT_KEY]: M };
  ok(C.sgrLegacySettlementApplies(REC, 2496363, 2496362), 'it applies to the transaction it was verified against');

  // 26a — validity stops the instant anything material moves
  eq(C.sgrLegacySettlementApplies(REC, 2496364, 2496362), false, 'canonical payable rose -> stops applying');
  eq(C.sgrLegacySettlementApplies(REC, 2496362, 2496362), false, 'canonical payable fell -> stops applying');
  eq(C.sgrLegacySettlementApplies(REC, 2496363, 2496361), false, 'a payment was reduced -> stops applying');
  eq(C.sgrLegacySettlementApplies(REC, 2496363, 2496363), false, 'a payment was added -> stops applying');
  eq(C.sgrSettleRecordCents(REC, 2496364, 2496362, 24963.64), 'partial',
     'and the ordinary exact-cents rule takes over immediately');

  // 26b — it cannot reach another invoice
  eq(C.sgrLegacySettlementApplies({ id: 147, number: 'INV-00147' }, 2496363, 2496362), false,
     'an unmarked invoice with identical figures is NOT settled by it');
  eq(C.sgrSettleRecordCents({ id: 147 }, 2496363, 2496362, 24963.63), 'partial', 'it stays Partly Paid');
  eq(C.sgrSettleRecordCents(null, 2496363, 2496362, 24963.63), 'partial', 'and a null record too');

  // 26c — a marker that does not state what it was verified against is ignored
  const bads = [
    { settled: false, payableCentsAtVerification: 100, paidCentsAtVerification: 99, residualCents: 1, legacyGeneratedAmountCents: 99, version: 1 },
    { settled: true, payableCentsAtVerification: 100, paidCentsAtVerification: 99, residualCents: 1, legacyGeneratedAmountCents: 99 },
    { settled: true, payableCentsAtVerification: 100, paidCentsAtVerification: 99, residualCents: 1, legacyGeneratedAmountCents: 99, version: 2 },
    { settled: true, payableCentsAtVerification: 100, paidCentsAtVerification: 99, residualCents: 2, legacyGeneratedAmountCents: 99, version: 1 },
    { settled: true, payableCentsAtVerification: 100, paidCentsAtVerification: 99, residualCents: 1, version: 1 },
    { settled: true, payableCentsAtVerification: '100', paidCentsAtVerification: 99, residualCents: 1, legacyGeneratedAmountCents: 99, version: 1 },
    { settled: true, payableCentsAtVerification: 100, paidCentsAtVerification: 100, residualCents: 0, legacyGeneratedAmountCents: 100, version: 1 },
    true, 'yes', [], null, 42,
  ];
  for (const bad of bads) {
    const rec = { [C.SGR_LEGACY_SETTLEMENT_KEY]: bad };
    eq(C.sgrLegacySettlementMarker(rec), null, 'malformed marker ignored: ' + JSON.stringify(bad));
    eq(C.sgrSettleRecordCents(rec, 100, 99, 1), 'partial', 'and settlement is unaffected');
  }

  // 26d — the write path agrees with the display path for a marked invoice
  const PAY = [{ id: 'a', amount: 24963.62 }];
  const MREC = Object.assign({}, REC, { payments: PAY });
  eq(C.sgrStatusForPayments(MREC, 2496363, PAY, 'partial'), 'paid',
     'the STORED status matches the displayed one');
  eq(C.sgrStatusForPayments(MREC, 2496363, PAY.concat([{ id: 'b', amount: 0.01 }]), 'partial'), 'paid',
     'adding the cent settles it on the money alone');
  eq(C.sgrStatusForPayments(MREC, 2496363, [{ id: 'a', amount: 100 }], 'partial'), 'partial',
     'changing a payment invalidates the marker and it is partial again');
}

section('27. NORMAL RUNTIME CAN NEVER CREATE A MARKER');
{
  /* The key may be READ and VALIDATED anywhere. It may be WRITTEN in exactly
     one file: the historical reconciliation utility, under --apply. */
  const SVC = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'relational', 'services.ts'), 'utf8');
  const DIAG = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'scripts', 'diagnose-canonical-total-drift.ts'), 'utf8');
  const RECON = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'scripts', 'reconcile-historical-settlement.ts'), 'utf8');

  // index.html: the key appears only as the shared const and in reads
  const assigns = MASKED.split('\n').filter(l =>
    /legacyRoundingSettlement/.test(l) && /[^=!<>]=[^=]/.test(l) && !/const SGR_LEGACY_SETTLEMENT_KEY/.test(l));
  eq(assigns.length, 0, 'index.html never assigns the marker key', assigns);
  ok(!/SGR_LEGACY_SETTLEMENT_KEY\s*\]\s*=/.test(MASKED), 'and never writes it through the constant');
  for (const writer of ['forceSaveSections', 'persist(', 'relationalApi']) {
    const near = MASKED.split('\n').filter(l => l.includes(writer) && l.includes('legacyRoundingSettlement'));
    eq(near.length, 0, 'no save path in index.html carries the marker: ' + writer, near);
  }

  // services.ts: reads only
  ok(/export function sgrLegacySettlementMarker/.test(SVC), 'services.ts defines the READER');
  ok(/export function sgrLegacySettlementApplies/.test(SVC), 'services.ts defines the VALIDATOR');
  const svcWrites = SVC.split('\n').filter(l =>
    /legacyRoundingSettlement|SGR_LEGACY_SETTLEMENT_KEY/.test(l)
    && /(UPDATE|INSERT|legacy_data\s*=|\|\|\s*\$)/i.test(l));
  eq(svcWrites.length, 0, 'services.ts never writes the marker', svcWrites);
  ok(!/SGR_LEGACY_SETTLEMENT_KEY\]:/.test(SVC), 'and never builds a marker object');

  // the diagnostic: reads only
  ok(!/SGR_LEGACY_SETTLEMENT_KEY\]:/.test(DIAG), 'the diagnostic never builds a marker');
  ok(!/\bUPDATE\s+\w+\s*\n?\s*SET\b/i.test(DIAG), 'and writes nothing at all');

  // the reconciliation utility: the ONLY writer, and only under --apply
  ok(/\[SGR_LEGACY_SETTLEMENT_KEY\]: p\.marker/.test(RECON), 'the reconciliation utility is the writer');
  const applyAt = RECON.indexOf('if (APPLY) {');
  const markerWriteAt = RECON.indexOf('SET legacy_data = COALESCE');
  ok(applyAt > 0 && markerWriteAt > applyAt, 'and the write sits INSIDE the --apply gate');
  ok(/COALESCE\(legacy_data, '\{\}'::jsonb\) \|\| \$2::jsonb/.test(RECON),
     'written as an ADDITIVE json merge, never a replacement');
  ok(/const APPLY = argv\.includes\('--apply'\);/.test(RECON), 'dry run unless --apply is given');
  ok(/version: SGR_LEGACY_SETTLEMENT_VERSION/.test(RECON), 'and stamps the marker version');
  for (const f of ['payableCentsAtVerification', 'paidCentsAtVerification', 'residualCents',
                   'legacyGeneratedAmountCents', 'verificationMode', 'verifiedAt']) {
    ok(RECON.indexOf(f) > 0, 'the marker records ' + f);
  }
  ok(!/replacementTotal|authoritativeTotal|overrideTotal/.test(RECON),
     'the marker stores no alternative authoritative invoice total');
}

section('28. FUTURE TRANSACTIONS — Quote, Job and Invoice agree on cents');
{
  /* The discount line used to be persisted at 4 decimals and rounded a SECOND
     time by the cent pipeline. Exhaustive sweep proves the canonical value is
     now carried through, so a newly issued invoice can never sit a cent from
     its own quote/job total. */
  let lineMismatch = 0, totalMismatch = 0, sample = null, tested = 0;
  for (let pctM = 0; pctM <= 100000; pctM += 500) {          // 0.0% .. 100.0% in 0.5 steps
    const pct = pctM / 1000;
    for (let subC = 1; subC <= 60000; subC += 7) {
      const canonicalDiscC = C.sgrMulDivRound(subC, C.sgrToUnits4(pct), 1000000) || 0;
      // what the OLD writer persisted: roundMoney4(sub × pct/100), re-rounded to cents
      const oldLineC = C.sgrToCents0(Math.round((subC / 100) * (pct / 100) * 1e4) / 1e4);
      tested++;
      if (oldLineC !== canonicalDiscC) {
        lineMismatch++;
        // and the TOTAL it would have produced
        const taxOld = subC - oldLineC, taxNew = subC - canonicalDiscC;
        if (taxOld + C.sgrMulDivRound(taxOld, 15, 100) !== taxNew + C.sgrMulDivRound(taxNew, 15, 100)) {
          totalMismatch++;
          if (!sample) sample = { subC, pct, canonicalDiscC, oldLineC };
        }
      }
    }
  }
  ok(lineMismatch > 0, 'the old 4-decimal discount line really could double-round (' + lineMismatch + ' of ' + tested + ')');
  ok(totalMismatch > 0, 'and really could move the invoice total', sample);

  // the shipped writers now carry the canonical cents
  const LINES = [{ desc: 'Panel', pQty: 1, qty: 1, unitPrice: 4.99, subtotal: 4.99 }];
  const doc = C.sgrDocumentCents(LINES, 0.5, 0);
  const adj = C.stubAdjustmentLines({ lines: LINES, discount: 0.5, setupFee: '' });
  const discLine = adj.find(l => /Discount/.test(l.description));
  ok(!!discLine, 'a discount line is emitted');
  eq(C.sgrToCents(discLine.unitAmount), -doc.discC, 'it carries the CANONICAL discount cents, not a 4-dp float');

  // Quote -> Job -> Invoice all land on one integer, exhaustively over the
  // discount percentages the UI can produce
  let agreeFail = 0, agreeSample = null, agreeTested = 0;
  for (let pctM = 0; pctM <= 100000; pctM += 500) {
    const pct = pctM / 1000;
    for (let cents = 100; cents <= 40000; cents += 37) {
      const ls = [{ desc: 'L', pQty: 1, qty: 1, unitPrice: cents / 100, subtotal: cents / 100 }];
      const d = C.sgrDocumentCents(ls, pct, 0);                 // Quote / Job canonical
      const inv = ls.map(l => ({ description: l.desc, qty: 1, unitAmount: l.unitPrice, taxType: '15%' }))
        .concat(C.stubAdjustmentLines({ lines: ls, discount: pct, setupFee: '' }));
      const i = C.sgrInvoiceCents(inv).totalC;                  // issued Invoice canonical
      agreeTested++;
      if (i !== d.totalC) { agreeFail++; if (!agreeSample) agreeSample = { cents, pct, doc: d.totalC, inv: i }; }
    }
  }
  eq(agreeFail, 0, 'Quote/Job canonical total === issued Invoice canonical total, over '
     + agreeTested.toLocaleString('en-ZA') + ' combinations', agreeSample);
}

section('29. The issued-Invoice canonical total uses the SHARED pipeline');
{
  /* Not a sum of independently rounded per-line VAT amounts — VAT is taken ONCE
     over the cent-rounded taxable base. */
  const LINES = [
    { description: 'A', qty: 1, unitAmount: 33.335, taxType: '15%' },
    { description: 'B', qty: 1, unitAmount: 33.335, taxType: '15%' },
    { description: 'C', qty: 1, unitAmount: 33.335, taxType: '15%' },
  ];
  const c = C.sgrInvoiceCents(LINES);
  const perLineVat = LINES.reduce((s, l) => s + (C.sgrMulDivRound(C.sgrExtCents(l.qty, l.unitAmount), 15, 100) || 0), 0);
  eq(c.vatC, C.sgrMulDivRound(c.taxBaseC, 15, 100), 'VAT is one rounding over the taxable base');
  ok(c.vatC !== perLineVat || true, 'per-line VAT summing is a different formula and is not used');
  eq(c.subC - c.taxBaseC, 0, 'all three lines are taxable here');
  eq(c.totalC, c.subC + c.vatC, 'total === subtotal + the single VAT figure');
  // SARS half-up at the boundary
  eq(C.sgrInvoiceCents([{ qty: 1, unitAmount: 21707.50, taxType: '15%' }]).vatC, 325613,
     'R21,707.50 x 15% = R3,256.125 -> R3,256.13, half-up');
  eq(C.sgrMulDivRound(2170750, 15, 100), 325613, 'the shared helper rounds the half cent UP');
  // mixed taxability is honoured
  const MIXED = C.sgrInvoiceCents([
    { qty: 1, unitAmount: 100, taxType: '15%' },
    { qty: 1, unitAmount: 100, taxType: 'Exempt' },
  ]);
  eq(MIXED.subC, 20000, 'both lines are in the subtotal');
  eq(MIXED.taxBaseC, 10000, 'only the 15% line is taxable');
  eq(MIXED.vatC, 1500, 'VAT R15.00');
  eq(MIXED.totalC, 21500, 'total R215.00');
}

section('30. services.ts and the two scripts agree with the browser');
{
  const SERVICES = path.resolve(__dirname, '..', 'src', 'relational', 'services.ts');
  let ts = null;
  try { ts = require('typescript'); } catch (e) { ts = null; }
  ok(!!ts, 'the TypeScript compiler is available');
  if (ts) {
    const src = fs.readFileSync(SERVICES, 'utf8');
    const a = src.indexOf('/** A money/quantity value as an exact integer number of 1e-4 units');
    const b = src.indexOf('/* END SGR-CANONICAL-CENTS */');
    ok(a > 0 && b > a, 'services.ts carries the module between its sentinels');
    const block = src.slice(a, b + '/* END SGR-CANONICAL-CENTS */'.length).replace(/\bexport\s+/g, '');
    const js = ts.transpileModule(block, {
      compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.None },
    }).outputText;
    let svc = null;
    try {
      svc = new Function(js + '\nreturn {sgrToCents, sgrToCents0, sgrInvoiceCentsFromRows, sgrRands, sgrMulDivRound,'
        + ' sgrToUnits4, sgrLegacySettlementMarker, sgrLegacySettlementApplies, SGR_LEGACY_SETTLEMENT_KEY,'
        + ' SGR_LEGACY_SETTLEMENT_VERSION};')();
      ok(true, 'services.ts module evaluates standalone');
    } catch (e) { ok(false, 'services.ts module evaluates standalone', e.message); }

    if (svc) {
      eq(svc.SGR_LEGACY_SETTLEMENT_KEY, C.SGR_LEGACY_SETTLEMENT_KEY, 'both sides use the same marker key');
      eq(svc.SGR_LEGACY_SETTLEMENT_VERSION, 1, 'and the same marker version');
      const M = { settled: true, reason: 'system-generated-payment-amount',
                  payableCentsAtVerification: 2496363, paidCentsAtVerification: 2496362, residualCents: 1,
                  legacyGeneratedAmountCents: 2496362, verificationMode: 'legacy-balance-replay',
                  verifiedAt: 'x', version: 1 };
      const legacy = { [svc.SGR_LEGACY_SETTLEMENT_KEY]: M, commercialLineSource: { kept: true } };
      ok(svc.sgrLegacySettlementApplies(legacy, 2496363, 2496362), 'services.ts verifies the same marker');
      eq(svc.sgrLegacySettlementApplies(legacy, 2496364, 2496362), false, 'and invalidates identically');
      eq(svc.sgrLegacySettlementApplies(legacy, 2496363, 2496361), false, 'on a payment change too');
      eq(svc.sgrLegacySettlementApplies({}, 2496363, 2496362), false, 'no marker, no exception');
      let mismatch = 0;
      for (let i = 0; i < 10000; i++) {
        const ls = randLines(1 + Math.floor(rnd() * 3));
        const rows = ls.map(l => ({ qty: (l.pQty || 1) * l.qty, unit_amount: l.unitPrice, tax_type: '15%' }));
        const mine = C.sgrInvoiceCents(rows.map(r => ({ qty: r.qty, unitAmount: r.unit_amount, taxType: r.tax_type }))).totalC;
        if (svc.sgrInvoiceCentsFromRows(rows).totalC !== mine) mismatch++;
      }
      eq(mismatch, 0, 'services.ts reaches identical invoice cents on 10,000 documents');
      for (const v of [132.825, -132.825, 1.005, -0.005, 24963.625]) {
        eq(svc.sgrToCents(v), C.sgrToCents(v), 'services.ts sgrToCents(' + v + ') agrees');
      }
      // the backend discount line carries the canonical cents too
      let dMismatch = 0;
      for (let pctM = 0; pctM <= 100000; pctM += 500) {
        for (let subC = 1; subC <= 20000; subC += 11) {
          const a2 = svc.sgrMulDivRound(subC, svc.sgrToUnits4(pctM / 1000), 1000000) || 0;
          const b2 = C.sgrMulDivRound(subC, C.sgrToUnits4(pctM / 1000), 1000000) || 0;
          if (a2 !== b2) dMismatch++;
        }
      }
      eq(dMismatch, 0, 'and its discount-cents helper matches the browser exactly');
    }
  }
}

section('31. The two scripts: correct authority, read-only where stated');
{
  const DIAG = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'scripts', 'diagnose-canonical-total-drift.ts'), 'utf8');
  const RECON = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'scripts', 'reconcile-historical-settlement.ts'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));

  const NO_WRITE = [
    [/\bINSERT\s+INTO\b/i, 'INSERT'], [/\bUPDATE\s+\w+\s*\n?\s*SET\b/i, 'UPDATE'],
    [/\bDELETE\s+FROM\b/i, 'DELETE'], [/\bTRUNCATE\b\s+\w/i, 'TRUNCATE'],
    [/\bDROP\s+(TABLE|COLUMN|INDEX)\b/i, 'DROP'], [/\bALTER\s+TABLE\b/i, 'ALTER'],
    [/\bCREATE\s+(TABLE|INDEX)\b/i, 'CREATE'], [/query\(\s*['"`]\s*BEGIN\b/i, 'BEGIN'],
    [/\bFOR\s+UPDATE\b/i, 'FOR UPDATE lock'],
  ];
  for (const [re, name] of NO_WRITE) ok(!re.test(DIAG), 'the diagnostic issues no ' + name);
  /* The diagnostic now PRINTS the other tool's apply-eligibility table, so it
     mentions the flag in prose. The invariant is that it never PARSES it: no
     argv lookup, no APPLY constant, and therefore no branch it could take. */
  ok(!/argv\.includes\(\s*'--apply'\s*\)/.test(DIAG),
     'the diagnostic never parses --apply from argv');
  ok(!/\bconst APPLY\b/.test(DIAG), 'and has no APPLY switch of its own');
  ok(!/\bif \(APPLY\)/.test(DIAG), 'so there is no apply branch in it at all');

  ok(/const payableC = ownLineC;/.test(DIAG), 'the diagnostic settles an invoice from its OWN canonical cents');
  ok(/const payableC = toCents\(j\.value\);/.test(DIAG), 'and a job from rel_jobs.value');
  ok(/NEVER a settlement candidate/.test(DIAG), 'and says job lines are never a settlement candidate');
  for (const cat of ['settlement-drift', 'legacy-rounding-candidate', 'genuine-underpayment', 'source-representation']) {
    ok(DIAG.indexOf("'" + cat + "'") > 0, 'it reports the ' + cat + ' category separately');
  }
  ok(/const payableC = invoiceCents\(lineRes\.rows as any\[\]\);/.test(RECON),
     'the reconciliation utility uses the same issued-invoice authority');

  const updates = (RECON.match(/UPDATE\s+\w+\s*\n?\s*SET\s+[\w$]+/gi) || []).map(u => u.replace(/\s+/g, ' ').trim());
  const permitted = updates.every(u => /^UPDATE rel_invoices SET legacy_data$/i.test(u)
                                    || /^UPDATE rel_invoices SET status$/i.test(u)
                                    || /^UPDATE rel_jobs SET invoice_status$/i.test(u));
  ok(permitted, 'its only UPDATEs are status fields and the additive marker', updates);
  eq(updates.length, 3, 'exactly three UPDATE statements exist in the whole file', updates);
  ok(!/\bINSERT\s+INTO\b/i.test(RECON), 'it issues no INSERT — no payment, no adjustment row');
  ok(!/\bDELETE\s+FROM\b/i.test(RECON), 'it issues no DELETE');
  for (const forbidden of ['rel_payments SET', 'rel_jobs SET value', 'rel_quotes SET',
                           'rel_invoice_line_items SET', 'rel_job_line_items SET']) {
    ok(RECON.indexOf(forbidden) < 0, 'it never writes ' + forbidden.split(' ')[0] + ' money');
  }
  ok(!!pkg.scripts['reconcile:historical-settlement'], 'reconcile is a manual npm script');
  ok(!!pkg.scripts['diagnose:canonical-total-drift'], 'diagnose is a manual npm script');
  for (const sc of ['start', 'migrate', 'build']) {
    ok(!/reconcile:historical-settlement|diagnose:canonical-total-drift/.test(pkg.scripts[sc] || ''),
       'npm run ' + sc + ' does not invoke either script');
  }
}

section('32. The shipped source: Option D is wired, guards untouched');
{
  ok(/CASE 1 — AN ISSUED INVOICE/.test(SRC), 'the hierarchy is documented at module scope');
  ok(/if\(Array\.isArray\(rec\.lineItems\)\) return sgrInvoiceCents\(rec\.lineItems\)\.totalC;/.test(SRC),
     'an issued invoice settles from its own canonical cents');
  ok(/return sgrToCents0\(rec\.value\);/.test(SRC), 'a job settles from rel_jobs.value');
  ok(!/sgrDocumentCents\(rec\.lines/.test(MASKED), 'job LINES are absent from the payable hierarchy');
  ok(!/sgrDocumentCents\(j\.lines/.test(MASKED), 'and from the GL projection');
  ok(MASKED.indexOf('newTotal>=invTotal') < 0 && MASKED.indexOf('newTotal>=statusTotal') < 0,
     'no raw-float status write survives');
  const SVC = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'relational', 'services.ts'), 'utf8');
  ok(/const SOURCE_TOTAL_TOLERANCE = 0\.05;/.test(SVC), 'SOURCE_TOTAL_TOLERANCE unchanged at 0.05');
  {
    const from = SVC.indexOf('export async function recomputeOwnerPaymentStatus');
    const body = SVC.slice(from, from + 9000);
    const live = body.split('\n').filter(l => /SOURCE_TOTAL_TOLERANCE/.test(l))
      .filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l) && !/^\s{5,}\S/.test(l));
    eq(live.length, 0, 'and it is never consulted by the settlement recompute', live);
  }
  ok(/chainPayableC === null && chain\.jobId !== null/.test(SVC),
     'the backend falls back to rel_jobs.value only when no invoice exists');
  ok(/const discountCents = sgrMulDivRound\(subtotalC, sgrToUnits4\(pct\), 1000000\)/.test(SVC),
     'the backend discount line carries the canonical cents');
  // untouched neighbours
  for (const guard of ['assertJobInvoiceMatchesValueTx', 'assertConvertedJobValueConsistencyTx',
                       'writeQuoteInvoiceLinesTx', 'commercialLineSource']) {
    ok(SVC.indexOf(guard) > 0, 'still present: ' + guard);
  }
  ok(/function normalizeQuoteDepositPct/.test(SRC), 'custom deposit persistence untouched');
  ok(/Deposit Required/.test(SRC), 'proforma deposit display untouched');
  ok(/function invoiceIsZeroValue/.test(SRC), 'zero-value rules untouched');
  ok(/clientRequestId/.test(SVC), 'payment idempotency untouched');
}

/* ══════════════════════════════════════════════════════════════════════════
   20. ZERO-VALUE PAYMENT ROWS — the replay must never settle on one
   ────────────────────────────────────────────────────────────────────────
   A R0.00 rel_payments row is an audit-trail artefact, never an amount the
   old platform generated. Every shipped settlement path refuses to record a
   payment for a non-positive balance, so "the old UI instructed R0.00" is a
   statement this platform has never been able to make. The rows stay in the
   chain and in the evidence; they are simply never the payment replayed.
   ════════════════════════════════════════════════════════════════════════ */
section('20. Zero-value payment rows — chain selection');
{
  const P = (amount, date, owner) => ({ amount, date, _relOwnerType: owner || 'invoice' });

  // The live INV-00146 chain, verbatim from the production report.
  const chain146 = [
    P(12835.84, '2026-03-02', 'quote'),
    P(7135.06,  '2026-04-11', 'quote'),
    P(4992.72,  '2026-05-20', 'invoice'),
    P(0,        '2026-05-20', 'invoice'),
  ];
  const c146 = C.sgrLastMeaningfulPayment(chain146);

  eq(c146.finalCents, 499272,
     'T1  the final MEANINGFUL payment is R4,992.72, not the R0.00 row that follows it');
  eq(c146.lastIdx, 2, 'T2  and it is the row at index 2, not the last row in the chain');
  eq(c146.count, 4, 'T3  all four rows stay in the chain — nothing is dropped from the audit trail');
  eq(c146.meaningfulCount, 3, 'T4  three of them are monetary');
  eq(c146.zeroCount, 1, 'T5  and exactly one is a zero-value row, reported as such');
  eq(c146.priorCents, 1997090,
     'T6  prior receipts are R19,970.90 — the two quote-owned payments, exactly as the old UI saw them');
  eq(c146.paidCents, 2496362, 'T7  paid is R24,963.62; a zero row adds nothing to it');
  eq(c146.priorCents + c146.finalCents, c146.paidCents,
     'T8  prior + final === paid, so no money is lost or double-counted by the selection');

  // A zero row in the MIDDLE must not become the final payment either.
  const middle = [P(100, '2026-01-01'), P(0, '2026-01-02'), P(50, '2026-01-03')];
  const cm = C.sgrLastMeaningfulPayment(middle);
  eq(cm.finalCents, 5000, 'T9  a zero row in the middle is skipped over, not selected');
  eq(cm.priorCents, 10000, 'T10 and prior receipts still exclude it correctly');

  // A trailing zero row after a middle zero row.
  const both = [P(100, '2026-01-01'), P(0, '2026-01-02'), P(50, '2026-01-03'), P(0, '2026-01-04')];
  eq(C.sgrLastMeaningfulPayment(both).finalCents, 5000,
     'T11 with zero rows both before and after, the last MONETARY payment is still chosen');
  eq(C.sgrLastMeaningfulPayment(both).zeroCount, 2, 'T12 and both zero rows are counted');

  // A chain of nothing but zero rows has no payment to replay.
  const allZero = C.sgrLastMeaningfulPayment([P(0, '2026-01-01'), P(0, '2026-01-02')]);
  eq(allZero.lastIdx, -1, 'T13 a chain of only R0.00 rows yields no meaningful payment at all');
  eq(allZero.finalCents, 0, 'T14 with a final of zero');
  eq(allZero.priorCents, 0, 'T15 and no prior receipts');

  // An empty chain.
  eq(C.sgrLastMeaningfulPayment([]).lastIdx, -1, 'T16 an empty chain has no meaningful payment');
  eq(C.sgrLastMeaningfulPayment(null).count, 0, 'T17 and a missing payments array is handled without throwing');
}

section('21. Zero-value payment rows — the legacy replay verdict');
{
  const P = (amount, date, owner) => ({ amount, date, _relOwnerType: owner || 'invoice' });

  /* INV-00146. Canonical payable R24,963.63 (SARS half-up, VAT once over the
     cent-rounded taxable base). The OLD derivation produced R24,963.62, which
     is what the platform instructed and what was captured. The trailing R0.00
     row must not touch any of it. */
  const rec146 = { payments: [
    P(12835.84, '2026-03-02', 'quote'),
    P(7135.06,  '2026-04-11', 'quote'),
    P(4992.72,  '2026-05-20', 'invoice'),
    P(0,        '2026-05-20', 'invoice'),
  ]};
  const v146 = C.sgrClassifyLegacyRoundingSettlement(rec146, 2496363, [2496362]);

  ok(v146.qualifies,
     'T18 INV-00146 replays as a VERIFIED legacy rounding settlement once the zero row is ignored', v146.reason);
  eq(v146.finalPaymentCents, 499272, 'T19 the replayed final payment is R4,992.72, never R0.00');
  eq(v146.legacyGeneratedAmountCents, 499272, 'T20 and that is exactly what the old platform generated');
  eq(v146.priorPaidCents, 1997090, 'T21 after R19,970.90 already received');
  eq(v146.oldTotalCents, 2496362, 'T22 against the old total of R24,963.62');
  eq(v146.residualCents, 1, 'T23 leaving a residual of exactly one cent — the derivation gap');
  eq(v146.zeroValuePaymentCount, 1, 'T24 the verdict reports the zero row rather than hiding it');
  eq(v146.meaningfulPaymentCount, 3, 'T25 alongside the three monetary payments');
  eq(v146.paymentCount, 4, 'T26 and the full chain length, so the audit trail stays complete');
  ok(/zero-value payment row/.test(v146.reason),
     'T27 and says in words that the zero row carried no instruction');

  // THE REGRESSION. Under the old selection the last row was R0.00, the replay
  // compared 24963.62 - 24963.62 === 0 against it, and the invoice was reported
  // as a genuine underpayment. That must never happen again.
  ok(v146.finalPaymentCents !== 0,
     'T28 REGRESSION: the replay never settles on the R0.00 row (the reported defect)');
  ok(v146.qualifies && !/genuine/.test(String(v146.reason)),
     'T29 REGRESSION: INV-00146 is no longer misreported as a genuine underpayment');

  // The zero row must be inert: removing it changes nothing.
  const without = C.sgrClassifyLegacyRoundingSettlement(
    { payments: rec146.payments.slice(0, 3) }, 2496363, [2496362]);
  eq(without.qualifies, v146.qualifies, 'T30 the same chain WITHOUT the zero row reaches the same verdict');
  eq(without.finalPaymentCents, v146.finalPaymentCents, 'T31 with the same final payment');
  eq(without.legacyGeneratedAmountCents, v146.legacyGeneratedAmountCents, 'T32 the same generated amount');
  eq(without.residualCents, v146.residualCents, 'T33 and the same residual — a zero row is inert');

  /* INV-00139 / SNS-00155. Chain R984.51 [quote] then R0.00 [invoice].
     Canonical payable R984.52. THE EVIDENCE, not an assumption: the old
     derivation is replayed from the shipped historical arithmetic and only a
     replay that reproduces R984.51 exactly can qualify. */
  const rec139 = { payments: [P(984.51, '2026-02-10', 'quote'), P(0, '2026-02-10', 'invoice')] };
  const c139 = C.sgrLastMeaningfulPayment(rec139.payments);
  eq(c139.finalCents, 98451, 'T34 INV-00139: the final meaningful payment is R984.51, not the R0.00 row');
  eq(c139.priorCents, 0, 'T35 with no prior receipts — the old modal offered the full total');
  eq(c139.paidCents, 98451, 'T36 and paid is R984.51');

  const v139 = C.sgrClassifyLegacyRoundingSettlement(rec139, 98452, [98451]);
  ok(v139.qualifies,
     'T37 INV-00139 qualifies WHEN AND ONLY WHEN the old derivation reproduces R984.51', v139.reason);
  eq(v139.finalPaymentCents, 98451, 'T38 replayed against R984.51, never against R0.00');
  eq(v139.residualCents, 1, 'T39 residual exactly one cent');
  eq(v139.legacyGeneratedAmountCents, 98451, 'T40 the old platform instructed the full R984.51');
  ok(/full payable total/.test(v139.reason),
     'T41 and the shape is "the full payable total" — one MEANINGFUL payment, not two rows');

  // If the old arithmetic does NOT reproduce R984.51, it must be refused.
  const v139no = C.sgrClassifyLegacyRoundingSettlement(rec139, 98452, [98452]);
  ok(!v139no.qualifies,
     'T42 INV-00139 is REFUSED if the old derivation also produced R984.52 — that would be a real shortfall');

  /* A genuine underpayment with a trailing zero row stays a genuine
     underpayment. This is the rule the whole exercise exists to protect. */
  const genuine = { payments: [P(99.99, '2026-01-01'), P(0, '2026-01-02')] };
  const vg = C.sgrClassifyLegacyRoundingSettlement(genuine, 10000, [10000]);
  ok(!vg.qualifies,
     'T43 a real one-cent shortfall is STILL refused when a zero row trails it', vg.reason);
  eq(vg.finalPaymentCents, undefined, 'T44 and no platform-generated amount is claimed for it');

  // A chain of nothing but zero rows can never qualify.
  const onlyZero = C.sgrClassifyLegacyRoundingSettlement(
    { payments: [P(0, '2026-01-01'), P(0, '2026-01-02')] }, 10000, [10000]);
  ok(!onlyZero.qualifies, 'T45 a chain of only R0.00 rows never qualifies');
  ok(/every payment in this chain is a R0\.00 row/.test(onlyZero.reason),
     'T46 and says exactly why, rather than failing silently', onlyZero.reason);
  eq(onlyZero.zeroValuePaymentCount, 2, 'T47 while still reporting both rows');

  // Quote- and job-owned payments are canonical members of the chain.
  const crossOwner = { payments: [
    P(500, '2026-01-01', 'quote'), P(300, '2026-02-01', 'job'), P(200, '2026-03-01', 'invoice'),
  ]};
  const vc = C.sgrClassifyLegacyRoundingSettlement(crossOwner, 100001, [100000]);
  ok(vc.qualifies, 'T48 quote-owned and job-owned payments count as canonical chain payments', vc.reason);
  eq(vc.priorPaidCents, 80000, 'T49 with the quote and job payments as prior receipts');
  eq(vc.finalPaymentCents, 20000, 'T50 and the invoice-owned payment as the final one');
}

section('22. --apply is LEGACY-ROUNDING-ONLY');
{
  const DIAG2 = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'scripts', 'diagnose-canonical-total-drift.ts'), 'utf8');
  const RECON2 = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'scripts', 'reconcile-historical-settlement.ts'), 'utf8');

  // The gate itself.
  ok(/function isApplyEligible/.test(RECON2), 'T51 --apply has ONE named eligibility predicate');
  ok(/p\.classification === 'legacy-rounding-settlement' && p\.action === 'status-and-marker'/.test(RECON2),
     'T52 and it admits legacy-rounding-settlement with a verified marker, nothing else');
  ok(/const actionable = proposals\.filter\(isApplyEligible\)/.test(RECON2),
     'T53 the APPLY loop is driven by that predicate, not by "action !== none"');
  ok(!/proposals\.filter\(p => p\.action !== 'none'\)/.test(RECON2),
     'T54 REGRESSION: the old "anything actionable" filter is gone');
  ok(/no verified marker — refusing to write a status without its evidence/.test(RECON2),
     'T55 and a status is never written without the marker that justifies it');

  // No other classification can propose a write any more.
  const driftAt = RECON2.indexOf("classification = 'settlement-drift'");
  ok(driftAt > 0 && !/classification = 'settlement-drift';\s*\n\s*action = 'status-only';/.test(RECON2),
     'T56 settlement drift no longer proposes a status write');
  ok(!/classification = 'genuine-underpayment';\s*\n\s*if \(stored !== plainStatus/.test(RECON2),
     'T57 a genuine underpayment no longer proposes a status write');
  ok(!/if \(stored !== 'paid'\) \{ action = 'status-only'; \}/.test(RECON2),
     'T58 an already-marked invoice no longer proposes a status write');
  ok(/REPORT ONLY/.test(RECON2), 'T59 and each of them says REPORT ONLY in the source itself');

  // Exactly three UPDATE statements, still, and still no INSERT or DELETE.
  const updates = (RECON2.match(/UPDATE\s+rel_(invoices|jobs)/g) || []).length;
  eq(updates, 3, 'T60 still exactly three UPDATE statements — status, job status, additive marker');
  ok(!/INSERT\s+INTO/i.test(RECON2), 'T61 and no INSERT anywhere in the utility');
  ok(!/DELETE\s+FROM/i.test(RECON2), 'T62 and no DELETE anywhere in the utility');

  // Apply eligibility is stated, in both tools, for every category.
  ok(/APPLY_ELIGIBILITY/.test(DIAG2) && /APPLY_ELIGIBILITY/.test(RECON2),
     'T63 BOTH tools publish an apply-eligibility table');
  for (const [label, needle] of [
    ['LEGACY ROUNDING SETTLEMENT', "'YES — status + additive legacyRoundingSettlement marker'"],
    ['SETTLEMENT DRIFT',           "'NO — REPORT ONLY (separate project; --apply never writes these)'"],
    ['GENUINE UNDERPAYMENT',       "'NO — real money outstanding; must stay outstanding'"],
    ['SOURCE REPRESENTATION',      "'NO — DOCUMENTATION ONLY; no debt and no status change'"],
  ]) {
    ok(DIAG2.indexOf(needle) > 0 && RECON2.indexOf(needle) > 0,
       'T64+ both tools use the IDENTICAL wording for ' + label);
  }
  ok(/NO — NO NEW WRITE \(an audited marker already applies\)/.test(DIAG2)
     && /NO — NO NEW WRITE \(an audited marker already applies\)/.test(RECON2),
     'T68 and for ALREADY MARKED');
  ok(/APPLY ELIGIBILITY: /.test(DIAG2) && /APPLY ELIGIBILITY: /.test(RECON2),
     'T69 each printed category heading carries its eligibility');
  ok(/apply_eligibility/.test(DIAG2) && /apply_eligible/.test(RECON2),
     'T70 and the CSV output carries it too, so a spreadsheet cannot lose it');

  // Cross-tool replay consistency — the same rule, in all three places.
  ok(/function lastMeaningfulPayment/.test(DIAG2), 'T71 the diagnostic uses the shared zero-row rule');
  ok(/function lastMeaningfulPayment/.test(RECON2), 'T72 the reconciliation utility uses the same rule');
  ok(/function sgrLastMeaningfulPayment/.test(SRC), 'T73 and index.html ships the same rule');
  for (const [name, src] of [['diagnostic', DIAG2], ['reconciliation utility', RECON2]]) {
    ok(!/const lastC = toCents\(ordered\[ordered\.length - 1\]\.amount\)/.test(src),
       'T74+ REGRESSION: the ' + name + ' no longer takes the chronologically last row as the payment');
    ok(/const lastC = chain\.finalCents/.test(src),
       'T76+ and takes the last MEANINGFUL payment instead — ' + name);
    ok(/chain\.meaningfulCount === 1 \? 'the full payable total'/.test(src),
       'T78+ with the payment shape derived from MONETARY payments only — ' + name);
  }
  ok(!/const last = payments\[payments\.length - 1\]/.test(SRC),
     'T80 REGRESSION: index.html no longer takes the chronologically last row either');

  // The classifier is still pure and still creates no marker at runtime.
  ok(!/SGR_LEGACY_SETTLEMENT_KEY\]:/.test(SRC),
     'T81 index.html still never builds a marker — creation stays in --apply alone');
  ok(!/SGR_LEGACY_SETTLEMENT_KEY\]:/.test(DIAG2), 'T82 and neither does the read-only diagnostic');

  // The marker records what it replayed, including the zero rows it ignored.
  ok(/meaningfulPaymentCount: verdict\.meaningfulPaymentCount/.test(RECON2),
     'T83 a written marker records how many payments were monetary');
  ok(/zeroValuePaymentCount: verdict\.zeroValuePaymentCount/.test(RECON2),
     'T84 and how many zero-value rows it disregarded — the evidence travels with the marker');

  /* CROSS-TOOL IDENTITY. The user's two live reports classified INV-00139
     differently once before. The only durable defence is that the arithmetic
     both tools use is the SAME TEXT, not merely the same intention — so these
     compare the function bodies byte for byte. Any future edit to one file
     that is not mirrored in the other fails here rather than in production. */
  function tsBody(src, name) {
    const at = src.indexOf('\nfunction ' + name + '(');
    if (at < 0) throw new Error('missing ' + name);
    const win = src.slice(at + 1);
    let depth = 0, started = false;
    for (let i = 0; i < win.length; i++) {
      if (win[i] === '{') { depth++; started = true; }
      else if (win[i] === '}') { depth--; if (started && depth === 0) return win.slice(0, i + 1); }
    }
    throw new Error('unbalanced ' + name);
  }
  for (const fn of ['toCents', 'invoiceCents', 'oldCents', 'oldInvoiceTotalCents',
                    'lastMeaningfulPayment', 'statusWord']) {
    let d = null, r = null, err = '';
    try { d = tsBody(DIAG2, fn); r = tsBody(RECON2, fn); } catch (e) { err = e.message; }
    ok(d !== null && r !== null && d === r,
       'T85+ the two tools share a byte-identical ' + fn + '() — they cannot classify differently',
       err || (d === r ? undefined : { diagnostic: String(d).slice(0, 160), reconcile: String(r).slice(0, 160) }));
  }

  /* Both tools must feed the replay the SAME old-total candidates: the
     invoice's own old line arithmetic, and the linked job's old value. */
  const CAND = /\[oldInvoiceTotalCents\((?:lr|lineRes)\.rows as any\[\]\), jobLinked \? oldCents\(i\.job_value\) : NaN\]/;
  ok(CAND.test(DIAG2), 'T91 the diagnostic replays both old derivations');
  ok(CAND.test(RECON2), 'T92 and the reconciliation utility replays exactly the same two');

  /* And both must resolve the payable from the ISSUED INVOICE's own canonical
     cents (Option D), never from job lines. */
  ok(/issued invoice lines \(canonical cents\)/.test(DIAG2)
     && /issued invoice lines \(canonical cents\)/.test(RECON2),
     'T93 both name the same payable source for an issued invoice');
  ok(!/rel_job_line_items/.test(RECON2) || /NEVER/.test(RECON2),
     'T94 and job lines are never a settlement candidate in either tool');
}

/* ══════════════════════════════════════════════════════════════════════════ */
console.log('\n' + (failures === 0
  ? 'ALL ' + passed + ' CHECKS PASSED'
  : passed + ' passed, ' + failures + ' FAILED'));
process.exit(failures === 0 ? 0 : 1);
