#!/usr/bin/env node
/* ============================================================================
 * reports-payments-canonical.test.js
 * Signacore — focused regression suite for the 2026-09-22 REPORTS → PAYMENTS
 * canonical-payment repair.
 * ============================================================================
 *
 * THE DEFECT
 *   ReportsPage's Payments tab summed ONLY `job.payments` for jobs carrying an
 *   invoiceNum. After the relational cutover that array holds JOB-OWNED
 *   rel_payments rows only, so quote-owned deposits, invoice-owned payments and
 *   standalone accounting invoices were invisible; Last Paid came from
 *   job.paidAt (a status date) before any payment date, counted R0.00 rows,
 *   and fell back to the invoice date; settlement used job.value.
 *
 * THE FIX
 *   sgrPaymentsReportModel() — every payment in the Quote / Proforma → Job →
 *   Invoice flow, each rel_payment counted once, positive amounts only, on its
 *   own payment date, labelled with its customer-facing document (never a Job).
 *
 *   Every function is LIFTED OUT OF index.html, not re-implemented, so this
 *   suite cannot drift from shipped behaviour.
 *
 * ZERO DEPENDENCIES — plain Node, no database.
 *   node test/reports-payments-canonical.test.js
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

function maskForCounting(src) {
  const out = src.split(''); let i = 0; const n = src.length;
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
if (startIdx < 0) { console.error('Main babel script block not found'); process.exit(1); }
const SRC = html.slice(startIdx + OPEN.length, html.lastIndexOf('</script>'));
const MASKED = maskForCounting(SRC);

const _A = SRC.indexOf('BEGIN SGR-CANONICAL-CENTS');
const _B = SRC.indexOf('/* END SGR-CANONICAL-CENTS */');
if (_A < 0 || _B < 0) { console.error('SGR-CANONICAL-CENTS sentinels not found'); process.exit(1); }
const CENTS_SRC = SRC.slice(SRC.lastIndexOf('/*', _A), _B + '/* END SGR-CANONICAL-CENTS */'.length);

const WANTED = [
  'isGenuineZeroAmount',
  'isHoldingsUser', 'isHoldingsRecord', 'belongsToUserCompany',
  'companyTagOf', 'sameCompany', 'jobHasId', 'resolveJobsForQuote', 'resolveJobForQuote',
  'resolveQuoteForJob', 'resolveQuoteForInvoice',
  'invoiceIdentityKey', 'invoiceBelongsToJob', 'resolveJobInvoiceRecord',
  'sgrReportPaymentKey', 'sgrReportPaymentDate', 'sgrReportChainPayments',
  'sgrReportLastPaid', 'sgrReportPaymentDocument', 'sgrPaymentsReportModel',
];
const pieces = ['"use strict";',
  extractConst(SRC, MASKED, 'UNIONTECH_ID'),
  extractConst(SRC, MASKED, 'HOLDINGS_CO_ID'),
  extractConst(SRC, MASKED, 'HOLDINGS_CO_KEY'),
  CENTS_SRC];
for (const f of WANTED) pieces.push(extractFunction(SRC, f));
pieces.push('return {' + WANTED.join(',') + ', SGR_LEGACY_SETTLEMENT_KEY};');
let A;
try { A = new Function(pieces.join('\n'))(); }
catch (e) { console.error('Could not evaluate lifted functions: ' + e.message); process.exit(1); }

/* ── fixtures ───────────────────────────────────────────────────────────── */
const SIG = { role: 'admin', email: 'a@x', co: 2 };     // original-company user
const HOL = { role: 'admin', email: 'h@x', co: 1 };     // Holdings user
let relSeq = 1000;
const pay = (owner, amount, date) => { relSeq++; return { id: 'p' + relSeq, _relPaymentId: relSeq, _relOwnerType: owner, amount, date }; };
const copy = p => ({ ...p });                            // same rel_payment reached through another stage
function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const run = (jobs, quotes, inv, user) => A.sgrPaymentsReportModel(deepFreeze(jobs), deepFreeze(quotes), deepFreeze(inv), user || SIG);
const day = (m, d) => (m.byDate[d] || []).map(x => x._payCents).sort((a, b) => a - b);
const refs = (m, d) => (m.byDate[d] || []).map(x => x._docKind + ' ' + x._docRef).sort();
const line = amt => ({ description: 'x', qty: 1, unitAmount: amt, taxType: '15%' });
const allRefs = m => m.receipts.map(r => r._docKind + ' ' + r._docRef);

section('1. Quote deposit appears (quote not yet converted or invoiced)');
{
  const q = { id: 'q1', num: 'SQ-00123', co: 2, client: 'Acme', payments: [pay('quote', 500, '2026-09-03')] };
  const m = run([], [q], []);
  ok(JSON.stringify(day(m, '2026-09-03')) === '[50000]', 'R500.00 deposit on 03 Sep');
  ok(refs(m, '2026-09-03')[0] === 'Quote SQ-00123', 'labelled with Quote SQ-00123', refs(m, '2026-09-03'));
  ok(m.totalPaidC === 50000, 'counted in Total Paid');
  ok(m.paidRows.length === 0, 'Paid Invoices table unchanged — a quote is not an invoice row');
}

section('2. Proforma-linked payment appears');
{
  const q = { id: 'q2', num: 'SQ-00124', proformaNum: 'PRO-00045', co: 2, client: 'Beta', payments: [pay('quote', 1200, '2026-09-05')] };
  const m = run([], [q], []);
  ok(JSON.stringify(day(m, '2026-09-05')) === '[120000]', 'R1,200.00 on 05 Sep');
  ok(refs(m, '2026-09-05')[0] === 'Proforma PRO-00045', 'labelled with the Proforma', refs(m, '2026-09-05'));
}

section('3 / 5. Invoice payment appears — invoice-owned payment no longer missed');
{
  const j = { id: 'j3', num: 'SNS-3', co: 2, invoiceNum: 'INV-00146', value: 1150, client: 'Gamma', invoiceDate: '2026-09-01', payments: [] };
  const inv = { id: 'i3', number: 'INV-00146', co: 2, reference: 'SNS-3', date: '2026-09-01', status: 'partial', lineItems: [line(1000)],
                payments: [pay('invoice', 650, '2026-09-11')] };
  const m = run([j], [], [inv]);
  ok(JSON.stringify(day(m, '2026-09-11')) === '[65000]', 'invoice-owned R650.00 on 11 Sep (old report: missing)');
  ok(refs(m, '2026-09-11')[0] === 'Invoice INV-00146', 'labelled with Invoice INV-00146');
  ok(m.paidRows.length === 1 && m.paidRows[0]._paidC === 65000, 'Paid Invoices → Received R650.00');
  const sa = { id: 'i4', number: 'INV-00200', co: 2, date: '2026-09-02', status: 'sent', lineItems: [line(100)], payments: [pay('invoice', 50, '2026-09-12')] };
  const ms = run([], [], [sa]);
  ok(day(ms, '2026-09-12')[0] === 5000 && ms.paidRows.length === 1, 'standalone accounting invoice payment appears');
}

section('4 / 6 / 7 / 12. Deposit survives conversion; every payment appears; each id counted once; Received = full chain');
{
  const qd = pay('quote', 219.08, '2026-09-03');
  const q = { id: 'q5', num: 'SQ-00150', proformaNum: 'PRO-00050', co: 2, client: 'Delta', convertedJobId: 'j5', payments: [qd] };
  const jp = pay('job', 219.07, '2026-09-03');
  const ip1 = pay('invoice', 1654.31, '2026-09-11');
  const ip2 = pay('invoice', 488.36, '2026-09-18');
  const j = { id: 'j5', num: 'SNS-5', co: 2, quoteNum: 'SQ-00150', invoiceNum: 'INV-00111', value: 2580.82, client: 'Delta',
              invoiceDate: '2026-09-10', payments: [jp] };
  // read.ts hydrates the invoice with its whole chain: own + job + quote
  const inv = { id: 'i5', number: 'INV-00111', co: 2, reference: 'SNS-5', date: '2026-09-10', status: 'paid',
                lineItems: [line(2244.19)], payments: [ip1, ip2, copy(jp), copy(qd)] };
  const m = run([j], [q], [inv]);
  ok(JSON.stringify(day(m, '2026-09-03')) === '[21907,21908]', 'deposit R219.08 still shown after conversion + R219.07 on the same day');
  ok(day(m, '2026-09-11')[0] === 165431 && day(m, '2026-09-18')[0] === 48836, 'both invoice payments shown');
  ok(m.receipts.length === 4, 'exactly 4 receipts — no id counted twice', m.receipts.length);
  ok(m.totalPaidC === 21908 + 21907 + 165431 + 48836, 'Total Paid = R2,580.82 including the deposit', m.totalPaidC);
  ok(m.paidRows.length === 1 && m.paidRows[0]._paidC === m.totalPaidC, 'Received includes the complete chain, once');
  ok(refs(m, '2026-09-03').includes('Proforma PRO-00050'), 'deposit keeps its Proforma reference — not relabelled as the invoice');
  // three payments on one day all represented
  const t = [pay('quote', 10, '2026-09-20'), pay('quote', 20, '2026-09-20'), pay('quote', 30, '2026-09-20')];
  const m3 = run([], [{ id: 'q6', num: 'SQ-6', co: 2, payments: t }], []);
  ok(JSON.stringify(day(m3, '2026-09-20')) === '[1000,2000,3000]', 'three payments on one date all present in the calendar data');
}

section('8. Actual payment date only');
{
  const j = { id: 'j8', num: 'SNS-8', co: 2, invoiceNum: 'INV-8', value: 100, client: 'E', invoiceDate: '2026-10-01', paidAt: '2026-10-02',
              date: '2026-07-01', payments: [pay('job', 100, '2026-09-11')] };
  const q = { id: 'q8', num: 'SQ-8', co: 2, date: '2026-06-01', payments: [pay('quote', 5, '2026-08-30')] };
  const m = run([j], [q], []);
  ok(day(m, '2026-09-11')[0] === 10000 && day(m, '2026-08-30')[0] === 500, 'each on its own payment date');
  ok(!m.byDate['2026-10-01'] && !m.byDate['2026-10-02'] && !m.byDate['2026-07-01'] && !m.byDate['2026-06-01'], 'never on invoice / paidAt / job / quote dates');
  const mn = run([], [{ id: 'q9', num: 'SQ-9', co: 2, date: '2026-09-01', payments: [pay('quote', 7, null)] }], []);
  ok(Object.keys(mn.byDate).length === 0 && mn.undatedReceipts === 1 && mn.totalPaidC === 700, 'undated payment is never re-dated, still counted as cash');
}

section('9 / 10 / 13. R0.00 rows excluded; Last Paid = latest positive payment');
{
  const j = { id: 'j10', num: 'SNS-10', co: 2, invoiceNum: 'INV-10', value: 984.51, client: 'F', paidAt: '2026-09-30',
              payments: [pay('job', 400, '2026-07-01'), pay('job', 584.51, '2026-08-05'), pay('job', 0, '2026-09-18')] };
  const q = { id: 'q10', num: 'SQ-10', co: 2, payments: [pay('quote', 0, '2026-09-19')] };
  const m = run([j], [q], []);
  ok(!m.byDate['2026-09-18'] && !m.byDate['2026-09-19'], 'R0.00 rows do not appear on the calendar');
  ok(m.receipts.every(r => r._payCents > 0) && m.totalPaidC === 98451, 'R0.00 not counted as money received');
  ok(m.rows[0]._lastPaid === '2026-08-05', 'Last Paid = 05 Aug, not the R0.00 date nor paidAt', m.rows[0]._lastPaid);
  ok(m.rows[0]._payments.length === 3, 'R0.00 row left untouched in the chain');
}

section('11. Total Paid includes deposits');
{
  const q1 = { id: 'q11', num: 'SQ-11', co: 2, payments: [pay('quote', 300, '2026-09-01')] };             // not converted
  const q2 = { id: 'q12', num: 'SQ-12', co: 2, convertedJobId: 'j12', payments: [pay('quote', 200, '2026-09-02')] };
  const j2 = { id: 'j12', num: 'SNS-12', co: 2, quoteNum: 'SQ-12', value: 1000, client: 'G', payments: [pay('job', 100, '2026-09-04')] }; // no invoice yet
  const m = run([j2], [q1, q2], []);
  ok(m.totalPaidC === 60000, 'Total Paid = R600.00 (both deposits + pre-invoice job receipt)', m.totalPaidC);
}

section('14. A job-owned row is shown with its Quote / Proforma / Invoice, never as a Job');
{
  const q = { id: 'q14', num: 'SQ-00140', co: 2, convertedJobId: 'j14', payments: [] };
  const before = pay('job', 100, '2026-08-01'), after = pay('job', 200, '2026-09-15');
  const j = { id: 'j14', num: 'SNS-00140', co: 2, quoteNum: 'SQ-00140', invoiceNum: 'INV-00140', invoiceDate: '2026-09-01', value: 300, client: 'H',
              payments: [before, after] };
  const m = run([j], [q], []);
  ok(refs(m, '2026-08-01')[0] === 'Quote SQ-00140', 'received before invoicing → its Quote');
  ok(refs(m, '2026-09-15')[0] === 'Invoice INV-00140', 'received on/after the invoice date → the Invoice');
  const jNoQuote = { id: 'j15', num: 'SNS-00150', co: 2, invoiceNum: 'INV-00150', invoiceDate: '2026-09-01', value: 50, client: 'I',
                     payments: [pay('job', 50, '2026-08-01')] };
  ok(refs(run([jNoQuote], [], []), '2026-08-01')[0] === 'Invoice INV-00150', 'no source quote → its Invoice');
  const all = allRefs(m).concat(allRefs(run([jNoQuote], [], [])));
  ok(all.every(r => !/^Job\b/.test(r) && !/SNS-/.test(r)), 'no receipt is labelled with a Job', all);
  ok(A.sgrReportPaymentDocument({ date: '2026-09-01' }, 'job', { quote: null, invoice: null }) === null,
     'an unresolvable job row gets no document label (still counted as cash), never a Job label');
}

section('15. Company isolation unchanged');
{
  const sigQ = { id: 'qs', num: 'SQ-50', co: 2, payments: [pay('quote', 111, '2026-09-03')] };
  const holQ = { id: 'qh', num: 'SQ-50', co: 1, payments: [pay('quote', 999, '2026-09-03')] };
  const sigJ = { id: 'js', num: 'SNS-50', co: 2, quoteNum: 'SQ-50', invoiceNum: 'INV-50', value: 111, client: 'S', payments: [] };
  const holJ = { id: 'jh', num: 'HLD-50', co: 1, quoteNum: 'SQ-50', invoiceNum: 'INV-50', value: 999, client: 'H', payments: [] };
  const holInv = { id: 'ih', number: 'INV-51', co: 1, status: 'sent', lineItems: [line(10)], payments: [pay('invoice', 5, '2026-09-04')] };
  const ms = run([sigJ, holJ], [sigQ, holQ], [holInv], SIG);
  ok(ms.totalPaidC === 11100 && ms.receipts.length === 1, 'Signacore sees only its own R111.00', ms.totalPaidC);
  ok(ms.rows.length === 1 && ms.rows[0]._paidC === 11100, 'Signacore INV-50 never picks up the Holdings SQ-50 deposit');
  const mh = run([sigJ, holJ], [sigQ, holQ], [holInv], HOL);
  ok(mh.totalPaidC === 99900 + 500 && mh.rows.every(r => r.co === 1), 'Holdings sees only Holdings (R999.00 + R5.00)', mh.totalPaidC);
}

section('Settlement / markers untouched — no fake money');
{
  const mk = { settled: true, version: 1, reason: 'system-generated-payment-amount', payableCentsAtVerification: 2496363,
               paidCentsAtVerification: 2496362, residualCents: 1, legacyGeneratedAmountCents: 2496362 };
  const j = { id: 'j20', num: 'SNS-20', co: 2, invoiceNum: 'INV-20', value: 24963.62, client: 'M', payments: [] };
  const inv = { id: 'i20', number: 'INV-20', co: 2, reference: 'SNS-20', status: 'paid',
                lineItems: [{ description: 'x', qty: 1, unitAmount: 21707.50, taxType: '15%' }], payments: [pay('invoice', 24963.62, '2026-09-11')] };
  const m0 = run([j], [], [inv]);
  ok(m0.rows[0]._payableC === 2496363 && m0.rows[0]._status === 'partial' && m0.rows[0]._outstandingC === 1, 'issued invoice stays the payable; no tolerance');
  const withMarker = { ...inv, [A.SGR_LEGACY_SETTLEMENT_KEY]: mk };
  const m = run([{ ...j }], [], [withMarker]);
  ok(m.totalPaidC === 2496362 && m.rows[0]._paidC === 2496362, 'legacyRoundingSettlement adds no money');
  ok(m.rows[0]._status === 'paid' && m.rows[0]._outstandingC === 0, 'verified marker still settles status only');
  const jm = { id: 'j21', num: 'SNS-21', co: 2, invoiceNum: 'INV-21', value: 1000, client: 'N', invoiceStatus: 'paid', paidAt: '2026-09-15',
               manualSettlement: { settled: true, amount: 1000 }, payments: [pay('job', 250, '2026-09-02')] };
  const m2 = run([jm], [], []);
  ok(m2.totalPaidC === 25000 && !m2.byDate['2026-09-15'], 'manual paid flag / override creates no receipt');
}

section('Collection Rate is issued-invoice scoped (Total Paid is not)');
{
  // Collection Rate exactly as ReportsPage computes it
  const rate = m => { const c = m.invoiceCollectedC, o = m.totalPendingC; return c + o > 0 ? Math.round(c / (c + o) * 1000) / 10 : null; };
  const inv1 = { id: 'ic1', number: 'INV-900', co: 2, date: '2026-09-01', status: 'partial', lineItems: [line(1000)],   // R1,150.00
                 payments: [pay('invoice', 575, '2026-09-02')] };
  const base = run([], [], [inv1]);
  ok(base.totalPaidC === 57500 && rate(base) === 50, 'baseline: invoice R575 of R1,150 → 50.0%', rate(base));
  const dep = pay('quote', 400, '2026-09-06');
  const q = { id: 'qc', num: 'SQ-900', co: 2, client: 'Z', convertedJobId: 'jc', payments: [dep] };
  const m = run([], [q], [{ ...inv1, payments: [...inv1.payments.map(copy)] }]);
  ok(m.totalPaidC === 57500 + 40000, '1. uninvoiced quote deposit increases Total Paid', m.totalPaidC);
  ok(JSON.stringify(day(m, '2026-09-06')) === '[40000]', '2. uninvoiced quote deposit appears on the Payment Calendar');
  ok(rate(m) === 50 && m.invoiceCollectedC === 57500, '3. uninvoiced quote deposit does NOT change Collection Rate', rate(m));
  ok(m.totalPendingC === 57500, '   Outstanding unchanged by the deposit (invoice-scoped)', m.totalPendingC);
  // the same transaction now has an issued invoice; read.ts brings the deposit into its chain
  const j = { id: 'jc', num: 'SNS-900', co: 2, quoteNum: 'SQ-900', invoiceNum: 'INV-901', invoiceDate: '2026-09-10', value: 1150, client: 'Z', payments: [] };
  const inv2 = { id: 'ic2', number: 'INV-901', co: 2, reference: 'SNS-900', date: '2026-09-10', status: 'partial', lineItems: [line(1000)],
                 payments: [copy(dep)] };
  const m2 = run([j], [{ ...q, payments: [copy(dep)] }], [{ ...inv1, payments: inv1.payments.map(copy) }, inv2]);
  ok(m2.totalPaidC === 97500, '   Total Paid unchanged — the deposit is still counted once', m2.totalPaidC);
  ok(m2.invoiceCollectedC === 97500, '4. once invoiced, the earlier deposit counts in the invoice collected amount', m2.invoiceCollectedC);
  const r2 = m2.rows.find(r => r.invoiceNum === 'INV-901');
  ok(r2 && r2._paidC === 40000 && r2._outstandingC === 75000, '5. INV-901 outstanding = canonical R1,150.00 − R400.00 = R750.00', r2 && r2._outstandingC);
  ok(m2.totalPendingC === 57500 + 75000 && rate(m2) === Math.round(97500 / (97500 + 132500) * 1000) / 10,
     '   Collection Rate = invoice collected ÷ (collected + issued-invoice outstanding)', rate(m2));
  // marker-settled invoice still reads 100% collected, no cent invented
  const mk = { settled: true, version: 1, reason: 'system-generated-payment-amount', payableCentsAtVerification: 2496363,
               paidCentsAtVerification: 2496362, residualCents: 1, legacyGeneratedAmountCents: 2496362 };
  const iv = { id: 'ic3', number: 'INV-902', co: 2, status: 'paid', lineItems: [{ description: 'x', qty: 1, unitAmount: 21707.50, taxType: '15%' }],
               payments: [pay('invoice', 24963.62, '2026-09-11')], [A.SGR_LEGACY_SETTLEMENT_KEY]: mk };
  const m3 = run([], [], [iv]);
  ok(m3.invoiceCollectedC === 2496362 && m3.totalPendingC === 0 && rate(m3) === 100, '   canonical settlement (legacy marker) respected: 100.0%, R0.00 outstanding');
}

section('7. No tooltip / new visual behaviour on Reports → Payments');
{
  const a = SRC.indexOf('\nfunction ReportsPage(');
  const b = SRC.indexOf('\nfunction ShareGuideModal(');
  const rp = SRC.slice(a, b);
  const titles = rp.match(/title=/g) || [];
  ok(titles.length === 1 && rp.includes('title="Hover to preview · click to open the full invoice"'), 'only the pre-existing invoice-number title remains', titles.length);
  ok(!rp.includes('_docRef') && !rp.includes('_docKind'), 'no document label is rendered anywhere on the page');
  ok(rp.includes('<div key={pi} className="truncate text-emerald-700 font-semibold leading-tight text-xs mt-0.5">{zar(j._payAmt!=null?j._payAmt:(j.value||0))}</div>'),
     'calendar amount markup identical to the original');
  ok(rp.includes('{payments.length>2&&<div className="text-emerald-500 text-xs">+{payments.length-2}</div>}'), '"+N" badge markup identical to the original');
  ok(rp.includes("{invoiceCollected+totalPending>0?((invoiceCollected/(invoiceCollected+totalPending))*100).toFixed(1)+'%':'—'}"),
     'Collection Rate card uses the invoice-scoped collected amount');
  ok(rp.includes('>of all invoices collected<') && rp.includes('cash received incl. deposits'), 'card labels unchanged');
}

section('No writes');
{
  const j = { id: 'j30', num: 'SNS-30', co: 2, invoiceNum: 'INV-30', value: 100, client: 'W', payments: [pay('job', 100, '2026-09-01')] };
  const before = JSON.stringify(j);
  let threw = null;
  try { run([j], [], []); } catch (e) { threw = e.message; }
  ok(threw === null && JSON.stringify(j) === before, 'runs over deep-frozen inputs in strict mode; inputs unchanged', threw);
  const a = SRC.indexOf('\nfunction sgrReportPaymentKey(');
  const b = SRC.indexOf('\nfunction ShareGuideModal(');
  const body = SRC.slice(a, b);
  const banned = ['setJobs', 'setQuotes', 'setAccInvoices', 'persist(', 'forceSaveSections', 'relationalApi', 'fetch(',
                  'recordPayment', 'updatePayment', 'deletePayment', "'/payments", 'platform-state', 'localStorage.setItem'];
  const hits = banned.filter(t => body.includes(t));
  ok(a > 0 && b > a && hits.length === 0, 'model + ReportsPage contain no save / payment-write call', hits);
  ok(!/\(j\.payments\|\|\[\]\)\.reduce/.test(body), 'the old job.payments-only sum is gone');
  ok(/<ReportsPage\s+jobs=\{jobs\} quotes=\{quotes\} accInvoices=\{accInvoices\}/.test(SRC), 'App passes quotes and accInvoices to ReportsPage');
}

console.log('\n' + (failures === 0 ? 'ALL ' + passed + ' CHECKS PASSED' : 'PASSED: ' + passed + '   FAILED: ' + failures));
process.exit(failures === 0 ? 0 : 1);
