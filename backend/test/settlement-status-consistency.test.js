#!/usr/bin/env node
/* ============================================================================
 * settlement-status-consistency.test.js
 * Signacore — focused regression suite for the 2026-09-14 Accounting ↔ Sales
 * settlement-status repair.
 * ============================================================================
 *
 * THE DEFECT
 *   One transaction reported two settlement states: Accounting → Invoices said
 *   Paid while Sales → Invoices said "⏳ Partly Paid" for the SAME invoice, the
 *   SAME total and the SAME payments. Three different comparison rules were in
 *   play over one set of facts:
 *     backend    toCents(chain paid) >= toCents(invoice total)     ← canonical
 *     Accounting a private display tolerance, "outstanding <= R0.01"
 *     Sales      a RAW float `paid >= total`, or the stored status verbatim
 *   rel_jobs.value and rel_payments.amount are NUMERIC(14,2) — cents — but the
 *   job value is computed as (subtotal − discount + setupFee) * 1.15 and Sales
 *   re-derives that product in the browser without rounding it, so an invoice
 *   issued and paid at R5,716.51 was compared against 5716.512 and read
 *   'partial'.
 *
 * WHAT THIS PROVES
 *   Both surfaces now reach the same word from the same facts, through the one
 *   shared rule, for every case below — including the rounding edge that caused
 *   the report, and including the case that must STAY partial.
 *
 *   The settlement functions are LIFTED OUT OF index.html, not re-implemented,
 *   so this suite cannot drift from shipped behaviour. The two surfaces' own
 *   one-line derivations are additionally asserted against the shipped source.
 *
 * ZERO DEPENDENCIES — plain Node, no ts-node, no babel, no database.
 *   node test/settlement-status-consistency.test.js
 *   INDEX_HTML_PATH=/some/other/index.html node test/settlement-status-consistency.test.js
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
  // the new shared settlement authority
  'toCents', 'settlementOutstanding', 'deriveSettlementStatus', 'sumPaymentAmounts',
  // 2026-09-18 (zero-value settlement): deriveSettlementStatus's zero branch
  // calls this, so it must be lifted alongside it. See
  // zero-value-settlement.test.js for that repair's own suite.
  'isGenuineZeroAmount',
  // company-safe chain resolution reconcileJobInvoice depends on
  'companyTagOf', 'sameCompany', 'jobHasId',
  'resolveJobsForQuote', 'resolveJobForQuote', 'resolveQuoteForJob',
  'findSourceQuoteForJob',
  // the shared job-invoice reconciler used by BOTH Sales and Accounting
  'reconcileJobInvoice',
];
/* 2026-09-22 (ONE-CENT RECONCILIATION): the lifted settlement/document
   functions now delegate to the shared canonical-cents module, so that module
   must be in scope here too. It is lifted verbatim between its sentinels, for
   the same reason everything else in this harness is lifted rather than
   re-implemented: this suite must never drift from shipped behaviour. */
const _SGR_MOD_A = SRC.indexOf('BEGIN SGR-CANONICAL-CENTS');
const _SGR_MOD_B = SRC.indexOf('/* END SGR-CANONICAL-CENTS */');
if (_SGR_MOD_A < 0 || _SGR_MOD_B < 0) {
  console.error('SGR-CANONICAL-CENTS sentinels not found in index.html'); process.exit(1);
}
const SGR_CANONICAL_CENTS_SRC =
  SRC.slice(SRC.lastIndexOf('/*', _SGR_MOD_A), _SGR_MOD_B + '/* END SGR-CANONICAL-CENTS */'.length);
const pieces = [extractConst(SRC, MASKED, 'HOLDINGS_CO_ID'), extractConst(SRC, MASKED, 'HOLDINGS_CO_KEY')];
pieces.push(SGR_CANONICAL_CENTS_SRC);
for (const f of WANTED_FNS) pieces.push(extractFunction(SRC, f));
pieces.push('return {' + WANTED_FNS.join(',') + '};');

let A;
try { A = new Function(pieces.join('\n'))(); }
catch (e) { console.error('Could not evaluate the lifted functions: ' + e.message); process.exit(1); }

/* ── the two surfaces, expressed exactly as index.html expresses them ──────
   Each mirrors one shipped derivation; §8 asserts the shipped source still
   reads that way, so a future edit to either screen breaks this suite. */

// Accounting → Invoices, invoice row (AccountingPage, displayedAccInvoices.map)
function accountingBadge(inv) {
  const sub = (inv.lineItems || []).reduce((s, l) => s + (parseFloat(l.qty || 1) * parseFloat(l.unitAmount || 0)), 0);
  const vat = (inv.lineItems || []).reduce((s, l) => l.taxType === '15%' ? s + (parseFloat(l.qty || 1) * parseFloat(l.unitAmount || 0) * 0.15) : s, 0);
  const paidSoFar = A.sumPaymentAmounts(inv.payments);
  const outstanding = A.settlementOutstanding(sub + vat, paidSoFar);
  const isEffectivelyPaid = inv.status === 'partial' && A.deriveSettlementStatus(sub + vat, paidSoFar) === 'paid';
  return { label: isEffectivelyPaid ? 'paid' : inv.status, outstanding };
}

// Sales → Invoices, manual/canonical invoice row (QuotesPage, manualInvItems)
function salesManualBadge(i) {
  const sub = (i.lineItems || []).reduce((s, l) => s + (parseFloat(l.qty || 1) * parseFloat(l.unitAmount || 0)), 0);
  const vat = (i.lineItems || []).reduce((s, l) => l.taxType === '15%' ? s + (parseFloat(l.qty || 1) * parseFloat(l.unitAmount || 0) * 0.15) : s, 0);
  const _settled = A.deriveSettlementStatus(sub + vat, A.sumPaymentAmounts(i.payments));
  return (i.status === 'paid' || _settled === 'paid') ? 'paid'
    : (_settled === 'partial' || i.status === 'partial') ? 'partial'
      : 'pending';
}

// Accounting → Invoices, job-derived row (AccountingPage, getJobInvoices)
function accountingJobStatus(job, quotes) {
  const rec = A.reconcileJobInvoice(job, quotes);
  return rec.invoiceStatus === 'paid' ? 'paid' : rec.invoiceStatus === 'partial' ? 'partial' : 'pending';
}

// Sales → Invoices, job-derived row (QuotesPage, jobInvItems).
//
// 2026-09-18 — MIRROR CORRECTION. This mirror still rebuilt `value` from the
// source quote as (quote subtotal − quote discount + quote setup fee) × 1.15.
// Shipped Sales stopped doing that in the SAME 2026-09-14 repair this suite
// covers ("THE JOB OWNS ITS OWN MONEY"): the re-sync now carries quote-owned
// CONTACT fields only, and the job's stored value IS the invoice. The stale
// mirror was invisible while a rebuilt total and the job's own total happened
// to reach the same word; it is corrected here so this suite asserts the code
// that actually ships. No shipped behaviour changed with this edit — only the
// test's copy of it.
function salesJobStatus(j, quotes) {
  const link = A.resolveQuoteForJob(j, quotes);
  let job = j;
  if (link) {
    job = {
      ...j,
      client: link.client, contact: link.contact || j.contact || '', email: link.email || j.email || '',
      tel: link.tel || j.tel || '', address: link.address || j.address || '', vatNum: link.vatNum || j.vatNum || '',
    };
  }
  return A.reconcileJobInvoice(job, quotes).invoiceStatus;
}

const HOLD = 1, OTHER = 2;
const inv = (total4dp, payments, status) => ({
  id: 'inv-1', number: 'INV-00500', status: status || 'partial',
  lineItems: [{ description: 'Signage', qty: 1, unitAmount: total4dp / 1.15, accountCode: '4000', taxType: '15%' }],
  payments: payments,
});

/* ═══════════════════════════════════════════════════════════════════════ */
section('CASE 1 — FULLY PAID (R10,000 invoiced, R10,000 received)');
{
  const quote = { id: 1, num: 'SQ-00100', co: OTHER, convertedJobId: 10, payments: [], lines: [{ subtotal: 8695.652173913044 }] };
  const job = { id: 10, num: 'SNS-00100', co: OTHER, quoteNum: 'SQ-00100', invoiceNum: 'INV-00500', value: 10000, payments: [{ id: 'p1', amount: 10000 }] };
  ok(accountingJobStatus(job, [quote]) === 'paid', 'Accounting (job invoice) = Paid');
  ok(salesJobStatus(job, [quote]) === 'paid', 'Sales (job invoice) = Paid');
  ok(accountingJobStatus(job, [quote]) === salesJobStatus(job, [quote]), 'the two agree');

  const record = inv(10000, [{ id: 'p1', amount: 10000 }], 'partial');
  ok(accountingBadge(record).label === 'paid', 'Accounting (canonical invoice) = Paid even though the stored status is stale "partial"');
  ok(salesManualBadge(record) === 'paid', 'Sales (canonical invoice) = Paid — no longer echoes the stale stored status');
  ok(accountingBadge(record).outstanding === 0, 'outstanding is exactly R0.00');
}

section('CASE 2 — PARTIAL (R10,000 invoiced, R4,000 received)');
{
  const quote = { id: 1, num: 'SQ-00100', co: OTHER, convertedJobId: 10, payments: [], lines: [{ subtotal: 8695.652173913044 }] };
  const job = { id: 10, num: 'SNS-00100', co: OTHER, quoteNum: 'SQ-00100', invoiceNum: 'INV-00500', value: 10000, payments: [{ id: 'p1', amount: 4000 }] };
  ok(accountingJobStatus(job, [quote]) === 'partial', 'Accounting = Partial');
  ok(salesJobStatus(job, [quote]) === 'partial', 'Sales = Partial');

  const record = inv(10000, [{ id: 'p1', amount: 4000 }], 'partial');
  ok(accountingBadge(record).label === 'partial', 'Accounting (canonical invoice) = Partial');
  ok(salesManualBadge(record) === 'partial', 'Sales (canonical invoice) = Partial');
  ok(accountingBadge(record).outstanding === 6000, 'outstanding is R6,000.00 on both');
}

section('CASE 3 — QUOTE-OWNED PAYMENT (deposit taken before the invoice existed)');
{
  const quote = { id: 1, num: 'SQ-00100', co: OTHER, convertedJobId: 10, lines: [{ subtotal: 8695.652173913044 }], payments: [{ id: 'q1', amount: 10000 }] };
  const job = { id: 10, num: 'SNS-00100', co: OTHER, quoteNum: 'SQ-00100', invoiceNum: 'INV-00500', value: 10000, payments: [] };
  ok(accountingJobStatus(job, [quote]) === 'paid', 'Accounting = Paid from the quote-owned payment');
  ok(salesJobStatus(job, [quote]) === 'paid', 'Sales = Paid from the same quote-owned payment');
  ok(A.reconcileJobInvoice(job, [quote]).totalPaid === 10000, 'the quote payment is counted exactly once');

  // The canonical-invoice shape: read.ts resolves the chain into inv.payments,
  // each row keeping its own owner. Nothing is copied between arrays here.
  const record = inv(10000, [{ id: 'q1', amount: 10000, _relOwnerType: 'quote' }], 'sent');
  ok(salesManualBadge(record) === 'paid', 'Sales reads the chain-resolved quote payment as settling the invoice');
  ok(A.deriveSettlementStatus(10000, A.sumPaymentAmounts(record.payments)) === 'paid', 'the shared rule agrees');
}

section('CASE 4 — MIXED OWNER PAYMENTS (quote R2,000 + job R3,000 + invoice R5,000)');
{
  const payments = [
    { id: 'i1', amount: 5000, _relOwnerType: 'invoice', _relPaymentId: 501 },
    { id: 'j1', amount: 3000, _relOwnerType: 'job', _relPaymentId: 502 },
    { id: 'q1', amount: 2000, _relOwnerType: 'quote', _relPaymentId: 503 },
  ];
  const record = inv(10000, payments, 'partial');
  ok(A.sumPaymentAmounts(payments) === 10000, 'the chain total is R10,000 — no payment duplicated');
  ok(accountingBadge(record).label === 'paid', 'Accounting = Paid');
  ok(salesManualBadge(record) === 'paid', 'Sales = Paid');
  ok(accountingBadge(record).outstanding === 0, 'nothing outstanding');
  ok(payments.every(p => p._relOwnerType), 'every payment still carries its own true owner — nothing was re-owned');

  // reconcileJobInvoice must not double-count a payment that appears on both
  // the job and its source quote (the carried-deposit shape).
  const quote = { id: 1, num: 'SQ-00100', co: OTHER, convertedJobId: 10, lines: [], payments: [{ id: 'shared', amount: 2000 }] };
  const job = { id: 10, num: 'SNS-00100', co: OTHER, quoteNum: 'SQ-00100', value: 2000, payments: [{ id: 'shared', amount: 2000 }] };
  ok(A.reconcileJobInvoice(job, [quote]).totalPaid === 2000, 'a payment present on both job and quote is counted once, not twice');
}

section('CASE 5 — REFRESH (status is derived, never a stored leftover)');
{
  // Before the payment.
  const before = inv(10000, [], 'sent');
  ok(salesManualBadge(before) === 'pending' && accountingBadge(before).label === 'sent',
    'unpaid invoice: Sales Pending, Accounting shows its own issue status');
  // The authoritative re-read after the payment mutation returns the chain row.
  const after = inv(10000, [{ id: 'p1', amount: 10000, _relOwnerType: 'invoice' }], 'partial');
  ok(salesManualBadge(after) === 'paid', 'immediately after the authoritative refresh Sales = Paid');
  ok(accountingBadge(after).label === 'paid', 'and Accounting = Paid');
  // The same object after a full page reload carries the server-recomputed status.
  const reloaded = inv(10000, [{ id: 'p1', amount: 10000, _relOwnerType: 'invoice' }], 'paid');
  ok(salesManualBadge(reloaded) === 'paid' && accountingBadge(reloaded).label === 'paid',
    'after a page reload both still read Paid');
  // A job whose stored invoiceStatus is stale must not be believed.
  const quote = { id: 1, num: 'SQ-00100', co: OTHER, convertedJobId: 10, lines: [{ subtotal: 8695.652173913044 }], payments: [] };
  const staleJob = { id: 10, num: 'SNS-00100', co: OTHER, quoteNum: 'SQ-00100', value: 10000, invoiceStatus: 'partial', payments: [{ id: 'p1', amount: 10000 }] };
  ok(accountingJobStatus(staleJob, [quote]) === 'paid' && salesJobStatus(staleJob, [quote]) === 'paid',
    'a stale stored job.invoiceStatus is overridden by the recorded payments on both screens');
}

section('CASE 6 — ROUNDING (the platform money convention, both sides in cents)');
{
  // THE REPORTED CASE. Quote subtotal R4,970.88 → (4970.88 * 1.15) = 5716.512.
  // rel_jobs.value is NUMERIC(14,2), so the database — and the invoice issued to
  // the customer — says R5,716.51, and that is what is paid. Sales re-derived
  // 5716.512 in the browser and compared it raw.
  const quote = { id: 1, num: 'SQ-00100', co: OTHER, convertedJobId: 10, discount: '', setupFee: '', lines: [{ subtotal: 4970.88 }], payments: [] };
  const job = { id: 10, num: 'SNS-00100', co: OTHER, quoteNum: 'SQ-00100', invoiceNum: 'INV-00500', value: 5716.51, payments: [{ id: 'p1', amount: 5716.51 }] };
  ok(4970.88 * 1.15 > 5716.51, 'precondition: the re-derived value really is above the stored cent figure');
  ok(accountingJobStatus(job, [quote]) === 'paid', 'Accounting = Paid');
  ok(salesJobStatus(job, [quote]) === 'paid', 'Sales = Paid (was "Partly Paid" — this is the reported defect)');
  ok(accountingJobStatus(job, [quote]) === salesJobStatus(job, [quote]), 'the two agree on the rounding edge');

  // Sub-cent line arithmetic on a canonical invoice (the INV-00117 shape):
  // lines come to 6351.59375, the customer is billed and pays R6,351.59.
  const settled = { id: 'x', number: 'INV-00117', status: 'partial', payments: [{ id: 'p1', amount: 6351.59 }],
    lineItems: [{ description: 'L', qty: 1, unitAmount: 5523.125, taxType: '15%' }] };
  ok(A.toCents(5523.125 * 1.15) === 6351.59, 'precondition: 4-dp lines come to R6,351.59 at cent precision');
  ok(accountingBadge(settled).label === 'paid' && salesManualBadge(settled) === 'paid',
    'a fraction of a cent of line arithmetic never leaves an invoice "partial" on either screen');

  // A GENUINE one-cent shortfall must STAY partial — rounding both sides, not a
  // tolerance. This is the case the old Accounting-only "<= R0.01" forgave.
  const short = { id: 'y', number: 'INV-00118', status: 'partial', payments: [{ id: 'p1', amount: 6351.59 }],
    lineItems: [{ description: 'L', qty: 1, unitAmount: 5523.1261, taxType: '15%' }] };
  ok(A.toCents(5523.1261 * 1.15) === 6351.60, 'precondition: this invoice is issued at R6,351.60');
  ok(accountingBadge(short).label === 'partial', 'Accounting keeps a real one-cent shortfall outstanding (no tolerance)');
  ok(salesManualBadge(short) === 'partial', 'Sales keeps it Partly Paid too');
  ok(accountingBadge(short).outstanding === 0.01, 'and states the balance as exactly R0.01, not a sub-cent ghost');

  // 2026-09-18 (ZERO-VALUE SETTLEMENT) — this assertion used to read
  //   ok(A.deriveSettlementStatus(0, 0) === 'pending', 'a zero-total document is never "paid"');
  // and it was WRONG about the business, not about the code. Signacore sponsors
  // signage, so a transaction's authoritative final amount due is legitimately
  // R0.00 — and R0.00 due against R0.00 received is an outstanding balance of
  // R0.00, i.e. settled. Requiring a positive total was what made a sponsored
  // invoice read Unpaid and then Overdue. The expectation is inverted here and
  // proved in full by zero-value-settlement.test.js; what must NOT change is
  // that a total which merely failed to parse is not a zero, asserted next.
  ok(A.deriveSettlementStatus(0, 0) === 'paid', 'a genuine zero-total document IS settled — nothing is due on it');
  ok(A.deriveSettlementStatus(undefined, 0) === 'pending', 'but a total that failed to hydrate is NOT a settled zero');
  ok(A.deriveSettlementStatus('', 0) === 'pending', 'nor is an empty value');
  ok(A.deriveSettlementStatus(10000, 12000) === 'paid', 'an overpayment is still paid');
  ok(A.settlementOutstanding(10000, 12000) === 0, 'and never reports a negative balance');
}

section('CASE 7 — COMPANY ISOLATION (the 2026-09-08 Holdings repair must not regress)');
{
  // The same quote number legitimately exists in both companies. Only the
  // Holdings quote may ever contribute to the Holdings job.
  const holdQuote = { id: 101, num: 'SQ-00050', co: HOLD, client: 'Holdings Client', convertedJobId: 201, payments: [], lines: [] };
  const otherQuote = { id: 102, num: 'SQ-00050', co: OTHER, client: 'Other Client', convertedJobId: 202, payments: [{ id: 'pay-other-1', amount: 10000 }], lines: [] };
  const holdJob = { id: 201, num: 'SNS-00901', co: HOLD, quoteNum: 'SQ-00050', invoiceNum: 'INV-00900', value: 10000, payments: [] };

  for (const order of [[otherQuote, holdQuote], [holdQuote, otherQuote]]) {
    ok(A.reconcileJobInvoice(holdJob, order).totalPaid === 0,
      'the other company\'s payment never reaches the Holdings job (array order ' + (order[0] === otherQuote ? 'other-first' : 'holdings-first') + ')');
    ok(accountingJobStatus(holdJob, order) === 'pending' && salesJobStatus(holdJob, order) === 'pending',
      'both screens show Pending, neither is contaminated');
  }

  // A Holdings job whose legacy quote number exists only under company 2.
  const orphanQuote = { id: 302, num: 'SQ-00060', co: OTHER, convertedJobId: null, payments: [{ id: 'pay-other-2', amount: 10000 }], lines: [] };
  const orphanJob = { id: 301, num: 'SNS-00040', co: HOLD, quoteNum: 'SQ-00060', invoiceNum: 'INV-00901', value: 10000, payments: [] };
  ok(A.reconcileJobInvoice(orphanJob, [orphanQuote]).totalPaid === 0,
    'a Holdings job with no Holdings quote of that number absorbs nothing');
  ok(accountingJobStatus(orphanJob, [orphanQuote]) === salesJobStatus(orphanJob, [orphanQuote]),
    'and the two screens still agree');
}

section('8. SOURCE — one rule, wired into both surfaces');
{
  ok(/\nfunction deriveSettlementStatus\(invoiceTotal, paidTotal\)\{/.test(SRC), 'deriveSettlementStatus() is defined once, at module scope');
  ok((SRC.match(/\nfunction toCents\(/g) || []).length === 1, 'toCents() is defined exactly once');
  ok((SRC.match(/\nfunction deriveSettlementStatus\(/g) || []).length === 1, 'deriveSettlementStatus() is defined exactly once');
  // 2026-09-22 (ONE-CENT RECONCILIATION): the shared rule is now applied in
  // exact integer cents, against the issued DOCUMENT rather than job.value.
  ok(/const invoiceStatus = sgrSettleRecordCents\(_settleRec, invTotalCents, paidC, invTotal\);/.test(SRC),
    'reconcileJobInvoice() — shared by Sales and Accounting — derives through the shared rule, in cents');
  ok(/const invTotalCents = _issued \? sgrCanonicalPayableCents\(_issued\) : sgrToCents0\(job\.value\);/.test(SRC),
    'against the ISSUED INVOICE where one exists, else rel_jobs.value \u2014 Option D (2026-09-22)');
  ok(!/if\(totalPaid>=invTotal && invTotal>0\) invoiceStatus = 'paid';/.test(MASKED),
    'the old raw-float comparison is gone from reconcileJobInvoice');
  ok(/const _settled = sgrSettleRecordCents\(i, totalC, sgrPaidCents\(i\.payments\), sgrRands\(totalC\)\);/.test(SRC),
    'Sales → Invoices derives a canonical invoice\'s status instead of echoing the stored one');
  ok(!/const normStatus=i\.status==='paid'\?'paid':i\.status==='partial'\?'partial':'pending';/.test(MASKED),
    'the old stored-status-verbatim line is gone from Sales');
  ok(/const isEffectivelyPaid = inv\.status==='partial'\s*\n?\s*&& sgrSettleRecordCents\(inv, _rowTotalC, _rowPaidC, sgrRands\(_rowTotalC\)\)==='paid';/.test(SRC),
    'Accounting\'s badge uses the shared rule');
  ok(!/outstanding<=0\.01/.test(MASKED), 'Accounting\'s private "<= R0.01" tolerance is gone');
  ok(/const outstanding = sgrRands\(sgrOutstandingForRecordCents\(inv, _rowTotalC, _rowPaidC\)\);/.test(SRC),
    'Accounting states the outstanding balance in exact cents');
  // and the 2026-09-22 additions: one canonical pipeline, no raw-float writes
  ok(/function sgrToUnits4\(n\)\{/.test(SRC), 'the canonical cents converter is present');
  ok(!/newTotal>=invTotal/.test(MASKED) && !/newTotal>=statusTotal/.test(MASKED),
    'no raw-float status write survives anywhere');
  ok(/function sgrStatusForPayments\(rec, totalC, payments, pendingFallback, rawTotal\)\{/.test(SRC),
    'every payment write goes through the one shared rule');
}

section('9. SOURCE — rel_payments architecture and company scoping untouched');
{
  ok(/function paymentOwnerSection\(payment, fallbackSection\)/.test(SRC),
    'payments are still routed by their own _relOwnerType, not by the screen showing them');
  ok(/const PAYMENT_OWNER_SECTIONS = \{ job: 'jobs', quote: 'quotes', invoice: 'accInvoices' \};/.test(SRC),
    'the owner→section map is unchanged');
  ok(/const link = resolveQuoteForJob\(job, quotes\);/.test(SRC),
    'reconcileJobInvoice still resolves its source quote through the company-safe resolver');
  ok(!/\.find\(\s*q\s*=>\s*q\.num\s*===\s*job\.quoteNum\s*\)/.test(MASKED),
    'no unscoped quote lookup was reintroduced');
  ok(/function sameCompany\(a, b\)\{/.test(SRC), 'sameCompany() is present');
  ok(/function resolvePaymentSource\(\{ quote, job, accInvoices, quotes \}\)/.test(SRC),
    'the single-source payment resolver is unchanged — no second payment projection');
  ok(MASKED.length > 0, 'index.html main script block was parsed');
}

/* ── result ─────────────────────────────────────────────────────────────── */
console.log('\n' + '='.repeat(60));
console.log('PASSED: ' + passed + '   FAILED: ' + failures);
console.log('='.repeat(60));
process.exit(failures === 0 ? 0 : 1);
