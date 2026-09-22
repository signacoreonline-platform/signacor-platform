#!/usr/bin/env node
/* ============================================================================
 * zero-value-settlement.test.js
 * Signacore — focused regression suite for the 2026-09-18 ZERO-VALUE
 * (sponsored) settlement repair.
 * ============================================================================
 *
 * THE BUSINESS FACT
 *   Signacore sometimes SPONSORS signage. The quote / job / invoice is then
 *   legitimately issued with an authoritative final amount due of R0.00. There
 *   is no debt: nothing for the customer to pay, nothing to chase, nothing to
 *   age. The transaction is settled the moment it is issued.
 *
 * THE DEFECT THIS CLOSES
 *   deriveSettlementStatus() — the platform's single settlement rule — required
 *   a POSITIVE total before it would say 'paid':
 *       if(total > 0 && paid >= total) return 'paid';
 *   so a R0.00 transaction with R0.00 received fell through to 'pending'. Every
 *   surface that reads that rule therefore called a sponsored transaction
 *   unpaid, and Accounting's job-invoice projection then escalated it:
 *       if(status!=='paid' && new Date()>new Date(dueDate)) status = 'overdue';
 *   — a due-date test that never asked whether anything was actually owed. A
 *   sponsored invoice 30 days old read OVERDUE on a balance of R0.00.
 *
 * THE RULE NOW
 *   Settlement is derived from the BALANCE and nothing else:
 *       outstandingCents = totalCents - paidCents
 *       outstanding <= 0  ->  paid / fully paid
 *       otherwise         ->  partial / pending, overdue only once past due
 *   R0.00 total + R0.00 payments = R0.00 outstanding = PAID, with NO payment
 *   row invented to say so. rel_payments remains the one canonical ledger.
 *
 *   The one place a zero total does NOT mean "settled" is an un-issued DRAFT
 *   invoice: InvoiceModal's default new invoice is status 'draft' with a single
 *   R0.00 line, so "nothing due" there means "nothing entered yet". Drafts keep
 *   their workflow status, unchanged.
 *
 *   The settlement functions are LIFTED OUT OF index.html, not re-implemented,
 *   so this suite cannot drift from shipped behaviour. Each surface's own
 *   derivation is additionally asserted against the shipped source.
 *
 * ZERO DEPENDENCIES — plain Node, no ts-node, no babel, no database.
 *   node test/zero-value-settlement.test.js
 *   INDEX_HTML_PATH=/some/other/index.html node test/zero-value-settlement.test.js
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

/* -- lift the real functions out of index.html -----------------------------
   Same extraction approach as settlement-status-consistency.test.js. */

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
  // the shared settlement authority
  'toCents', 'settlementOutstanding', 'deriveSettlementStatus', 'sumPaymentAmounts',
  // the 2026-09-18 zero-value additions
  'isGenuineZeroAmount', 'invoiceLineTotalIncVat', 'invoiceIsZeroValue',
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

/* -- the surfaces, expressed exactly as index.html expresses them ----------
   Sections 12-14 assert the shipped source still reads this way, so a future
   edit to any of these screens breaks this suite rather than silently
   diverging from it. */

const NOW      = '2026-09-18';                 // "today" for every case below
const LONG_AGO = '2026-06-01';                 // invoice date well past its due date
const FUTURE   = '2026-12-31';                 // a due date that has not arrived

// The shipped total, lifted — not a re-implementation.
const lineTotalIncVat = inv => A.invoiceLineTotalIncVat(inv);

// Accounting -> Invoices, JOB-DERIVED row (AccountingPage.getJobInvoices) —
// settlement first, then the overdue escalation. This is the projection that
// feeds the status pill, the status filter, the Outstanding counters, the Aged
// Debtors list AND ViewInvoiceModal's STATUS field.
function accountingJobInvoiceStatus(job, quotes, now) {
  const rec = A.reconcileJobInvoice(job, quotes);
  let status = 'sent';
  if (rec.invoiceStatus === 'paid') status = 'paid';
  else if (rec.invoiceStatus === 'partial') status = 'partial';
  else status = 'sent';
  const invDate = job.invoiceDate || job.date || now;
  const dueDate = job.invoiceDue || new Date(new Date(invDate).getTime() + 30 * 864e5).toISOString().slice(0, 10);
  if (status !== 'paid' && new Date(now) > new Date(dueDate)) status = (rec.invoiceStatus === 'partial') ? 'partial' : 'overdue';
  return status;
}

// Accounting -> Invoices, CANONICAL (manual) invoice as it enters `allInvoices`.
function accountingCanonicalStatus(i) {
  const _acc = { ...i, source: i.source || 'manual' };
  if (_acc.status !== 'draft' && A.invoiceIsZeroValue(_acc)
      && A.deriveSettlementStatus(A.invoiceLineTotalIncVat(_acc), A.sumPaymentAmounts(_acc.payments)) === 'paid') {
    return 'paid';
  }
  return _acc.status;
}

// Accounting -> Invoices, the row itself: the overdue flag and the pill label.
function accountingRow(i, now) {
  const inv = { ...i, status: accountingCanonicalStatus(i) };
  const total = lineTotalIncVat(inv);
  const paidSoFar = A.sumPaymentAmounts(inv.payments);
  const outstanding = A.settlementOutstanding(total, paidSoFar);
  const due = new Date(inv.dueDate || inv.date);
  const overdue = inv.status !== 'paid' && inv.status !== 'void' && new Date(now) > due && outstanding > 0;
  const isEffectivelyPaid = inv.status === 'partial' && A.deriveSettlementStatus(total, paidSoFar) === 'paid';
  return {
    label: isEffectivelyPaid ? 'paid' : (inv.status === 'partial' ? 'Outstanding: ' + outstanding : inv.status),
    overdue, outstanding, status: inv.status,
  };
}

// Sales -> Invoices, CANONICAL (manual) invoice row (QuotesPage.manualInvItems).
function salesCanonicalStatus(i) {
  const subvat = lineTotalIncVat(i);
  const _settled = A.deriveSettlementStatus(subvat, A.sumPaymentAmounts(i.payments));
  const _settledForDisplay = (A.toCents(subvat) <= 0 && !(i.status !== 'draft' && A.invoiceIsZeroValue(i)))
    ? 'pending' : _settled;
  return (i.status === 'paid' || _settledForDisplay === 'paid') ? 'paid'
    : (_settledForDisplay === 'partial' || i.status === 'partial') ? 'partial'
      : 'pending';
}

// Sales -> Invoices, JOB-DERIVED row (QuotesPage.jobInvItems). `value` is the
// JOB's — the company-safe quote re-sync carries contact fields only.
function salesJobStatus(j, quotes) {
  return A.reconcileJobInvoice(j, quotes).invoiceStatus;
}

// Jobs -> Job Detail, invoice badge. Derived, never the stored compatibility
// field (services.ts stamps rel_jobs.invoice_status 'pending' at invoice
// creation and never revisits it for a transaction that takes no payment).
function jobDetailBadge(job, quotes) {
  const st = A.reconcileJobInvoice(job, quotes).invoiceStatus;
  return st === 'paid' ? 'Fully Paid' : st === 'partial' ? 'Partly Paid' : 'Pending';
}

// Quote -> Job conversion, the stored invoiceStatus seeded on the new job.
function conversionStoredStatus(qAfterDisc, carriedPayments) {
  const paid = (carriedPayments || []).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  return A.deriveSettlementStatus(qAfterDisc * 1.15, paid);
}

// Accounting -> Aged Debtors (AccountingPage.getAgedDebtors) — membership only.
function agedDebtorsHas(inv) {
  if (['paid', 'void'].includes(accountingCanonicalStatus(inv))) return false;
  const total = lineTotalIncVat(inv);
  const paid = (inv.payments || []).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  return total > 0.005 && (total - paid) > 0.005;
}

const HOLD = 1, OTHER = 2;
const OUTSTANDING_WORDS = ['sent', 'overdue', 'partial', 'pending', 'draft'];

// A canonical invoice whose lines come to `totalIncVat`.
const canonical = (totalIncVat, payments, status, dates) => ({
  id: 'inv-1', number: 'INV-00500', status: status || 'sent',
  date: (dates && dates.date) || LONG_AGO,
  dueDate: (dates && dates.dueDate) || LONG_AGO,
  lineItems: totalIncVat === 0
    ? []   // services.ts: "A zero-value job still produces no line, exactly as before."
    : [{ description: 'Signage', qty: 1, unitAmount: totalIncVat / 1.15, accountCode: '4000', taxType: '15%' }],
  payments: payments,
});

/* ======================================================================== */
section('CASE 1 — SPONSORED ZERO VALUE (total R0.00, no payments at all)');
{
  const quote = { id: 1, num: 'SQ-00700', co: OTHER, convertedJobId: 70, discount: '', setupFee: '', lines: [], payments: Object.freeze([]) };
  const job   = { id: 70, num: 'SNS-00700', co: OTHER, quoteNum: 'SQ-00700', invoiceNum: 'INV-00700',
                  value: 0, invoiceDate: LONG_AGO, invoiceDue: FUTURE, invoiceStatus: 'pending', payments: Object.freeze([]) };

  ok(A.deriveSettlementStatus(0, 0) === 'paid', 'the shared rule: R0.00 due, R0.00 received -> paid');
  ok(A.settlementOutstanding(0, 0) === 0, 'outstanding is exactly R0.00');
  ok(salesJobStatus(job, [quote]) === 'paid', 'Sales -> Invoices = Fully Paid');
  ok(accountingJobInvoiceStatus(job, [quote], NOW) === 'paid', 'Accounting -> Invoices = Paid');
  ok(jobDetailBadge(job, [quote]) === 'Fully Paid', 'Jobs -> Job Detail = Fully Paid');
  ok(!OUTSTANDING_WORDS.includes(salesJobStatus(job, [quote])), 'Sales says none of Unpaid/Partial/Pending/Overdue');
  ok(!OUTSTANDING_WORDS.includes(accountingJobInvoiceStatus(job, [quote], NOW)), 'Accounting says none of Unpaid/Partial/Pending/Overdue');

  // TASK 9 — no payment side effects.
  const rec = A.reconcileJobInvoice(job, [quote]);
  ok(rec.payments.length === 0, 'rel_payments row count for this transaction: 0 before -> 0 after');
  ok(rec.totalPaid === 0, 'the resolved payment total is R0.00 — nothing was manufactured');
  ok(job.payments.length === 0 && quote.payments.length === 0, 'neither the job nor the quote payment array was written to');
  ok(!('_syntheticPayment' in rec) && !('sponsoredPayment' in rec), 'no synthetic / sponsored payment concept was introduced');
}

section('CASE 2 — ZERO VALUE, DUE DATE ALREADY PASSED (the reported defect)');
{
  const quote = { id: 2, num: 'SQ-00701', co: OTHER, convertedJobId: 71, discount: '', setupFee: '', lines: [], payments: [] };
  const job   = { id: 71, num: 'SNS-00701', co: OTHER, quoteNum: 'SQ-00701', invoiceNum: 'INV-00701',
                  value: 0, invoiceDate: LONG_AGO, invoiceDue: LONG_AGO, invoiceStatus: 'pending', payments: [] };

  ok(new Date(NOW) > new Date(LONG_AGO), 'precondition: the due date really has passed');
  ok(accountingJobInvoiceStatus(job, [quote], NOW) === 'paid',
     'Accounting = Paid, NOT Overdue — the due-date escalation can no longer fire on a zero balance');
  ok(accountingJobInvoiceStatus(job, [quote], NOW) !== 'overdue', 'explicitly not Overdue');
  ok(salesJobStatus(job, [quote]) === 'paid', 'Sales = Fully Paid');

  // The canonical (rel_invoice-backed) shape of the same transaction.
  const rec = canonical(0, [], 'sent');
  ok(accountingCanonicalStatus(rec) === 'paid', 'Accounting: an ISSUED R0.00 canonical invoice enters the list as Paid');
  ok(accountingRow(rec, NOW).overdue === false, 'and its due date carries no overdue warning flag');
  ok(accountingRow(rec, NOW).outstanding === 0, 'stated balance R0.00');
  ok(salesCanonicalStatus(rec) === 'paid', 'Sales: the same canonical invoice = Fully Paid');
  ok(agedDebtorsHas(rec) === false, 'it is not aged as a debtor');
}

section('CASE 3 — NORMAL UNPAID (R10,000 invoiced, R0 received, due date in future)');
{
  const quote = { id: 3, num: 'SQ-00710', co: OTHER, convertedJobId: 80, discount: '', setupFee: '', lines: [{ subtotal: 8695.652173913044 }], payments: [] };
  const job   = { id: 80, num: 'SNS-00710', co: OTHER, quoteNum: 'SQ-00710', invoiceNum: 'INV-00710',
                  value: 10000, invoiceDate: NOW, invoiceDue: FUTURE, payments: [] };
  ok(salesJobStatus(job, [quote]) === 'pending', 'Sales = Pending (unpaid)');
  ok(accountingJobInvoiceStatus(job, [quote], NOW) === 'sent', 'Accounting = Sent (unpaid, not yet due)');
  ok(A.settlementOutstanding(10000, 0) === 10000, 'the full R10,000 is outstanding');

  const rec = canonical(10000, [], 'sent', { date: NOW, dueDate: FUTURE });
  ok(accountingCanonicalStatus(rec) === 'sent', 'Accounting canonical = Sent — unchanged');
  ok(accountingRow(rec, NOW).overdue === false, 'not overdue before the due date');
  ok(salesCanonicalStatus(rec) === 'pending', 'Sales canonical = Pending — unchanged');
}

section('CASE 4 — NORMAL OVERDUE (R10,000 invoiced, R0 received, due date passed)');
{
  const quote = { id: 4, num: 'SQ-00711', co: OTHER, convertedJobId: 81, discount: '', setupFee: '', lines: [{ subtotal: 8695.652173913044 }], payments: [] };
  const job   = { id: 81, num: 'SNS-00711', co: OTHER, quoteNum: 'SQ-00711', invoiceNum: 'INV-00711',
                  value: 10000, invoiceDate: LONG_AGO, invoiceDue: LONG_AGO, payments: [] };
  ok(accountingJobInvoiceStatus(job, [quote], NOW) === 'overdue', 'Accounting = Overdue — a real debt past its due date is untouched');
  ok(salesJobStatus(job, [quote]) === 'pending', 'Sales = Pending — unchanged');

  const rec = canonical(10000, [], 'sent');
  ok(accountingCanonicalStatus(rec) === 'sent', 'Accounting canonical keeps its stored issue status');
  ok(accountingRow(rec, NOW).overdue === true, 'and IS flagged overdue — R10,000 is still owed');
  ok(accountingRow(rec, NOW).outstanding === 10000, 'stated balance R10,000.00');
  ok(agedDebtorsHas(rec) === true, 'it is aged as a debtor, exactly as before');
}

section('CASE 5 — NORMAL PARTIAL (R10,000 invoiced, R4,000 received)');
{
  const quote = { id: 5, num: 'SQ-00712', co: OTHER, convertedJobId: 82, discount: '', setupFee: '', lines: [{ subtotal: 8695.652173913044 }], payments: [] };
  const job   = { id: 82, num: 'SNS-00712', co: OTHER, quoteNum: 'SQ-00712', invoiceNum: 'INV-00712',
                  value: 10000, invoiceDate: LONG_AGO, invoiceDue: LONG_AGO, payments: [{ id: 'p1', amount: 4000 }] };
  ok(salesJobStatus(job, [quote]) === 'partial', 'Sales = Partly Paid');
  ok(accountingJobInvoiceStatus(job, [quote], NOW) === 'partial', 'Accounting = Partial (past due, but partial wins — unchanged)');
  ok(A.settlementOutstanding(10000, 4000) === 6000, 'R6,000 outstanding');

  const rec = canonical(10000, [{ id: 'p1', amount: 4000 }], 'partial');
  ok(accountingRow(rec, NOW).label === 'Outstanding: 6000', 'Accounting states the outstanding balance — unchanged');
  ok(accountingRow(rec, NOW).overdue === true, 'a part-paid invoice past due is still flagged');
  ok(salesCanonicalStatus(rec) === 'partial', 'Sales = Partly Paid — unchanged');
}

section('CASE 6 — NORMAL FULLY PAID (R10,000 invoiced, R10,000 received)');
{
  const quote = { id: 6, num: 'SQ-00713', co: OTHER, convertedJobId: 83, discount: '', setupFee: '', lines: [{ subtotal: 8695.652173913044 }], payments: [] };
  const job   = { id: 83, num: 'SNS-00713', co: OTHER, quoteNum: 'SQ-00713', invoiceNum: 'INV-00713',
                  value: 10000, invoiceDate: LONG_AGO, invoiceDue: LONG_AGO, payments: [{ id: 'p1', amount: 10000 }] };
  ok(salesJobStatus(job, [quote]) === 'paid', 'Sales = Fully Paid');
  ok(accountingJobInvoiceStatus(job, [quote], NOW) === 'paid', 'Accounting = Paid');

  const over = { ...job, payments: [{ id: 'p1', amount: 10001 }] };
  ok(salesJobStatus(over, [quote]) === 'paid', 'an overpayment is still Paid — existing behaviour');
  ok(A.settlementOutstanding(10000, 10001) === 0, 'and never reports a negative balance');

  // The rounding edge the 2026-09-14 repair closed must still hold.
  ok(A.deriveSettlementStatus(5716.512, 5716.51) === 'paid', 'the cents convention still settles the 5716.512 / R5,716.51 case');
  ok(A.deriveSettlementStatus(6351.595, 6351.59) === 'partial', 'a GENUINE one-cent shortfall still stays partial — no tolerance was introduced');
  ok(A.settlementOutstanding(6351.595, 6351.59) === 0.01, 'and is stated as exactly R0.01');
}

section('CASE 7 — QUOTE / JOB / INVOICE PAYMENT RESOLUTION IS UNCHANGED');
{
  // A deposit recorded on the quote before the job existed still settles the job.
  const quote = { id: 7, num: 'SQ-00720', co: OTHER, convertedJobId: 90, lines: [{ subtotal: 8695.652173913044 }], payments: [{ id: 'q1', amount: 10000 }] };
  const job   = { id: 90, num: 'SNS-00720', co: OTHER, quoteNum: 'SQ-00720', invoiceNum: 'INV-00720', value: 10000, payments: [] };
  ok(A.reconcileJobInvoice(job, [quote]).totalPaid === 10000, 'a quote-owned payment still resolves onto the job');
  ok(salesJobStatus(job, [quote]) === 'paid', 'and settles it');

  // Deduped by payment id — a carried deposit is never counted twice.
  const dupQ = { id: 8, num: 'SQ-00721', co: OTHER, convertedJobId: 91, lines: [], payments: [{ id: 'shared', amount: 2000 }] };
  const dupJ = { id: 91, num: 'SNS-00721', co: OTHER, quoteNum: 'SQ-00721', value: 2000, payments: [{ id: 'shared', amount: 2000 }] };
  ok(A.reconcileJobInvoice(dupJ, [dupQ]).totalPaid === 2000, 'a payment present on both job and quote is counted once');

  // Mixed owners on a canonical invoice: each row keeps its own true owner.
  const mixed = [
    { id: 'i1', amount: 5000, _relOwnerType: 'invoice' },
    { id: 'j1', amount: 3000, _relOwnerType: 'job' },
    { id: 'q1', amount: 2000, _relOwnerType: 'quote' },
  ];
  ok(A.sumPaymentAmounts(mixed) === 10000, 'the chain total is R10,000 — nothing duplicated');
  ok(mixed.every(p => p._relOwnerType), 'every payment still carries its own owner — nothing was re-owned');

  // A sponsored R0.00 transaction resolves through the SAME path and finds nothing.
  const spQ = { id: 9, num: 'SQ-00722', co: OTHER, convertedJobId: 92, lines: [], payments: [] };
  const spJ = { id: 92, num: 'SNS-00722', co: OTHER, quoteNum: 'SQ-00722', invoiceNum: 'INV-00722', value: 0, payments: [] };
  ok(A.reconcileJobInvoice(spJ, [spQ]).payments.length === 0, 'the sponsored transaction resolves zero payments — settlement came from the balance');
}

section('CASE 8 — COMPANY ISOLATION (the Holdings repair must not regress)');
{
  // The same quote number legitimately exists in both companies. The other
  // company's payment must never reach the Holdings job.
  const holdQuote  = { id: 101, num: 'SQ-00050', co: HOLD,  client: 'Holdings Client', convertedJobId: 201, payments: [], lines: [] };
  const otherQuote = { id: 102, num: 'SQ-00050', co: OTHER, client: 'Other Client',    convertedJobId: 202, payments: [{ id: 'pay-other-1', amount: 10000 }], lines: [] };
  const holdJob    = { id: 201, num: 'SNS-00901', co: HOLD, quoteNum: 'SQ-00050', invoiceNum: 'INV-00900',
                       value: 10000, invoiceDate: LONG_AGO, invoiceDue: LONG_AGO, payments: [] };
  for (const order of [[otherQuote, holdQuote], [holdQuote, otherQuote]]) {
    ok(A.reconcileJobInvoice(holdJob, order).totalPaid === 0,
       'the other company\'s payment never reaches the Holdings job (order ' + (order[0] === otherQuote ? 'other-first' : 'holdings-first') + ')');
    ok(salesJobStatus(holdJob, order) === 'pending', 'the Holdings job stays Pending — uncontaminated');
    ok(accountingJobInvoiceStatus(holdJob, order, NOW) === 'overdue', 'and is correctly Overdue: R10,000 really is owed');
  }

  // A ZERO-VALUE Holdings job must be settled on its OWN balance, and must not
  // absorb or influence another company's job carrying the same number.
  const zHold  = { id: 210, num: 'SNS-00902', co: HOLD,  quoteNum: 'SQ-00051', invoiceNum: 'INV-00902', value: 0, invoiceDue: LONG_AGO, payments: [] };
  const zOther = { id: 211, num: 'SNS-00902', co: OTHER, quoteNum: 'SQ-00051', invoiceNum: 'INV-00903', value: 10000, invoiceDue: LONG_AGO, payments: [] };
  const zQuotes = [{ id: 111, num: 'SQ-00051', co: OTHER, convertedJobId: 211, lines: [], payments: [{ id: 'x', amount: 10000 }] }];
  ok(accountingJobInvoiceStatus(zHold, zQuotes, NOW) === 'paid', 'the Holdings R0.00 job is Paid on its own balance');
  ok(A.reconcileJobInvoice(zHold, zQuotes).totalPaid === 0, 'and absorbed no payment from the other company');
  ok(accountingJobInvoiceStatus(zOther, zQuotes, NOW) === 'paid', 'the other company\'s R10,000 job is settled only by its OWN quote payment');
}

section('CASE 9 — HISTORICAL JOB-DERIVED R0.00 INVOICE ("No accounting record")');
{
  // No rel_invoice behind it: the job IS the invoice. Its authoritative final
  // value is R0.00 and there is no accounting record to consult.
  const job = { id: 300, num: 'SNS-00300', co: OTHER, quoteNum: '', invoiceNum: 'INV-00300',
                value: 0, invoiceDate: '2026-01-15', invoiceDue: '2026-02-14',
                invoiceStatus: 'pending', payments: [] };
  ok(accountingJobInvoiceStatus(job, [], NOW) === 'paid', 'Accounting = Fully Paid, NOT Overdue');
  ok(accountingJobInvoiceStatus(job, [], NOW) !== 'overdue', 'explicitly not Overdue despite a due date 7 months past');
  ok(salesJobStatus(job, []) === 'paid', 'Sales = Fully Paid');
  ok(jobDetailBadge(job, []) === 'Fully Paid', 'Job Detail = Fully Paid');
  ok(A.reconcileJobInvoice(job, []).payments.length === 0, 'and it still has no payment rows');

  // With no due date at all, getJobInvoices synthesises invoiceDate + 30 days.
  const noDue = { ...job, invoiceDue: undefined };
  ok(accountingJobInvoiceStatus(noDue, [], NOW) === 'paid', 'also Paid when the due date is synthesised from the invoice date');
}

section('CASE 10 — STORED / LEGACY STATUS FIELDS MUST NOT WIN');
{
  // rel_jobs.invoice_status is stamped 'pending' at invoice creation
  // (services.ts) and never revisited for a transaction that takes no payment.
  const stale = { id: 400, num: 'SNS-00400', co: OTHER, invoiceNum: 'INV-00400', value: 0,
                  invoiceDate: LONG_AGO, invoiceDue: LONG_AGO, invoiceStatus: 'pending', payments: [] };
  ok(salesJobStatus(stale, []) === 'paid', 'a stale stored invoiceStatus="pending" does not make a R0.00 job unpaid');
  ok(jobDetailBadge(stale, []) === 'Fully Paid', 'Job Detail derives rather than echoing the stored field');
  ok(accountingJobInvoiceStatus(stale, [], NOW) === 'paid', 'Accounting derives too');

  // A canonical invoice a user manually set to 'overdue' before it was sponsored.
  const storedOverdue = canonical(0, [], 'overdue');
  ok(accountingCanonicalStatus(storedOverdue) === 'paid', 'a stored status of "overdue" cannot survive a R0.00 balance');
  ok(accountingRow(storedOverdue, NOW).overdue === false, 'and no overdue warning is drawn');
  ok(salesCanonicalStatus(storedOverdue) === 'paid', 'Sales agrees');

  // ...but a stored 'paid' is still honoured on its own (historical records
  // settled before payments were kept as rows).
  const legacyPaid = canonical(10000, [], 'paid');
  ok(salesCanonicalStatus(legacyPaid) === 'paid', 'a stored "paid" with no payment rows still reads Paid — no regression');
  ok(accountingCanonicalStatus(legacyPaid) === 'paid', 'on both screens');

  // A DRAFT is a workflow state, not a payment state. InvoiceModal's default
  // new invoice is status 'draft' with one R0.00 line — "nothing due" there
  // means "nothing entered yet" and must NOT read as settled.
  const blankDraft = canonical(0, [], 'draft');
  ok(accountingCanonicalStatus(blankDraft) === 'draft', 'a blank new DRAFT invoice stays Draft in Accounting');
  ok(salesCanonicalStatus(blankDraft) === 'pending', 'and Pending in Sales — it is not called Fully Paid');
  ok(accountingRow(blankDraft, NOW).overdue === false, 'a draft with nothing on it is not overdue either');
  const realDraft = canonical(10000, [], 'draft');
  ok(accountingCanonicalStatus(realDraft) === 'draft', 'a draft with real lines is unchanged');
  ok(accountingRow(realDraft, NOW).overdue === true, 'and still flags its passed due date');
}

section('CASE 11 — ZERO THROUGH THE EXISTING ACCOUNTING RULES (100% discount)');
{
  // No "sponsored" flag exists or is introduced. The financial fact — the
  // authoritative final total is R0.00 — is sufficient, however it got there.
  const quote = { id: 500, num: 'SQ-00800', co: OTHER, convertedJobId: 500, discount: '100', setupFee: '',
                  lines: [{ subtotal: 8695.652173913044 }], payments: [] };
  const qAfterDisc = 8695.652173913044 - 8695.652173913044 * (100 / 100) + 0;
  ok(A.toCents(qAfterDisc * 1.15) === 0, 'precondition: a 100% discount really lands the final total on R0.00');
  const job = { id: 500, num: 'SNS-00800', co: OTHER, quoteNum: 'SQ-00800', invoiceNum: 'INV-00800',
                value: 0, invoiceDate: LONG_AGO, invoiceDue: LONG_AGO, payments: [] };
  ok(salesJobStatus(job, [quote]) === 'paid', 'Sales = Fully Paid');
  ok(accountingJobInvoiceStatus(job, [quote], NOW) === 'paid', 'Accounting = Paid, not Overdue');
  ok(conversionStoredStatus(qAfterDisc, []) === 'paid', 'the status seeded at quote->job conversion agrees');
  ok(conversionStoredStatus(8695.652173913044, []) === 'pending', 'and a normal R10,000 conversion is still seeded Pending');
  ok(conversionStoredStatus(8695.652173913044, [{ amount: 10000 }]) === 'paid', 'a conversion carrying a full deposit is still seeded Paid');
  ok(conversionStoredStatus(8695.652173913044, [{ amount: 4000 }]) === 'partial', 'and a part deposit still Partial');
}

section('CASE 12 — A BROKEN VALUE IS NOT A ZERO (2026-08-23 hardening upheld)');
{
  // The hazard a zero-means-settled rule creates: `parseFloat(x)||0` turns a
  // value that FAILED to hydrate into a perfectly convincing R0.00. A job whose
  // value never loaded must NOT be announced as Fully Paid.
  ok(A.isGenuineZeroAmount(0) === true, 'a real 0 is a genuine zero');
  ok(A.isGenuineZeroAmount('0') === true, 'and so is a numeric string "0" (the JSON shape)');
  ok(A.isGenuineZeroAmount(-0.004) === true, 'as is a sub-cent negative');
  ok(A.isGenuineZeroAmount(undefined) === false, 'undefined is NOT a zero');
  ok(A.isGenuineZeroAmount(null) === false, 'null is NOT a zero');
  ok(A.isGenuineZeroAmount('') === false, 'empty string is NOT a zero');
  ok(A.isGenuineZeroAmount('abc') === false, 'a non-numeric value is NOT a zero');
  ok(A.isGenuineZeroAmount(NaN) === false, 'NaN is NOT a zero');
  ok(A.isGenuineZeroAmount(10000) === false, 'and a real total is obviously not a zero');

  for (const broken of [undefined, null, '', 'abc', NaN]) {
    const job = { id: 600, num: 'SNS-00600', co: OTHER, invoiceNum: 'INV-00600', value: broken,
                  invoiceDate: LONG_AGO, invoiceDue: LONG_AGO, payments: [] };
    ok(salesJobStatus(job, []) === 'pending', 'a job whose value is ' + JSON.stringify(broken) + ' stays Pending, never Fully Paid');
    ok(jobDetailBadge(job, []) === 'Pending', '...and Job Detail agrees');
  }

  // A canonical invoice whose lineItems never hydrated is not proof of a zero.
  const noLines = { id: 'inv-9', number: 'INV-00601', status: 'sent', date: LONG_AGO, dueDate: LONG_AGO, payments: [] };
  ok(A.invoiceIsZeroValue(noLines) === false, 'an invoice with NO lineItems array is not a proven zero-value invoice');
  ok(accountingCanonicalStatus(noLines) === 'sent', 'so Accounting leaves its stored status alone');
  ok(salesCanonicalStatus(noLines) === 'pending', 'and Sales still reads it Pending, not Fully Paid');
  ok(A.invoiceIsZeroValue({ lineItems: [] }) === true, 'an EMPTY lines array IS a proven R0.00 invoice — how services.ts writes one');
}

section('12. SOURCE — the one settlement rule is balance-only');
{
  ok((SRC.match(/\nfunction deriveSettlementStatus\(/g) || []).length === 1, 'deriveSettlementStatus() is still defined exactly once');
  ok((SRC.match(/\nfunction toCents\(/g) || []).length === 1, 'toCents() is still defined exactly once');
  ok(!/if\(total > 0 && paid >= total\) return 'paid';/.test(SRC),
     'the "positive total required" guard is gone from deriveSettlementStatus');
  /* 2026-09-22 (ONE-CENT RECONCILIATION): the rule moved into the shared
     canonical-cents module and compares exact INTEGER CENTS. The zero-value
     behaviour this suite guards is unchanged and still expressed here. */
  ok(/if\(p >= t\) return 'paid';/.test(SRC),
     'settlement is still decided by the balance alone: paid >= total -> paid');
  ok(/isGenuineZeroAmount\(arguments\.length < 3 \? t \/ 100 : rawTotal\)/.test(SRC),
     'the zero branch still requires a GENUINE zero, not merely a total that parsed to 0');
  ok((SRC.match(/\nfunction sgrSettlementStatusCents\(/g) || []).length === 1,
     'the cents rule is defined exactly once, at module scope');
  ok((SRC.match(/\nfunction isGenuineZeroAmount\(/g) || []).length === 1, 'isGenuineZeroAmount() is defined exactly once, at module scope');
  ok((SRC.match(/\nfunction invoiceIsZeroValue\(/g) || []).length === 1, 'invoiceIsZeroValue() is defined exactly once, at module scope');
  ok((SRC.match(/\nfunction invoiceLineTotalIncVat\(/g) || []).length === 1, 'invoiceLineTotalIncVat() is defined exactly once, at module scope');
  ok(/const invTotal      = _issued \? sgrRands\(invTotalCents\) : job\.value;/.test(SRC),
     'reconcileJobInvoice still holds the RAW job value where no invoice was issued, so a broken value is not laundered into a zero');
  ok(/const invoiceStatus = sgrSettleRecordCents\(_settleRec, invTotalCents, paidC, invTotal\);/.test(SRC),
     'and hands that raw value straight to the rule, so a broken value is never a genuine zero');
  ok(!/const invTotal  = parseFloat\(job\.value\)\|\|0;/.test(SRC),
     'the laundering parseFloat(job.value)||0 is gone from reconcileJobInvoice');
  ok(/invoiceStatus: sgrSettlementStatusCents\(_qCanonC, sgrPaidCents\(_paymentsForNewJob\), sgrRands\(_qCanonC\)\),/.test(SRC),
     'quote->job conversion seeds the stored status through the SHARED rule, in canonical cents');
  ok(!/return paid>=tot&&tot>0\?'paid':paid>0\?'partial':'pending';/.test(MASKED),
     'the open-coded copy of the rule is gone from the conversion');
  ok(/const _jobSettlement = reconcileJobInvoice\(job, quotes, \{ accInvoices, jobs \}\)\.invoiceStatus;/.test(SRC),
     'Job Detail derives its invoice badge instead of reading the stored compatibility field');
  ok(!/\{job\.invoiceStatus==='paid'\?'✓ Fully Paid'/.test(SRC),
     'Job Detail no longer badges from job.invoiceStatus');
  ok(/if\(_acc\.status!=='draft' && invoiceIsZeroValue\(_acc\)/.test(SRC),
     'Accounting normalises an ISSUED, line-proven R0.00 canonical invoice — and only that');
  ok(/const _settledForDisplay = \(totalC<=0 && !\(i\.status!=='draft' && invoiceIsZeroValue\(i\)\)\)/.test(SRC),
     'Sales applies the same issued-and-proven test before calling a zero total settled');
  ok(/const invoiceStatus = sgrSettleRecordCents\(_settleRec, invTotalCents, paidC, invTotal\);/.test(SRC),
     'reconcileJobInvoice() still derives through the shared rule');
  ok(/const _settled = sgrSettleRecordCents\(i, totalC, sgrPaidCents\(i\.payments\), sgrRands\(totalC\)\);/.test(SRC),
     'Sales -> Invoices still derives a canonical invoice through the shared rule');
  ok(/const isEffectivelyPaid = inv\.status==='partial'\s*\n?\s*&& sgrSettleRecordCents\(inv, _rowTotalC, _rowPaidC, sgrRands\(_rowTotalC\)\)==='paid';/.test(SRC),
     'Accounting\'s existing partial-rescue is untouched');
  ok(/const outstanding = sgrRands\(sgrOutstandingForRecordCents\(inv, _rowTotalC, _rowPaidC\)\);/.test(SRC),
     'Accounting still states the outstanding balance in cents');
  ok(!/outstanding<=0\.01/.test(MASKED), 'no display tolerance was reintroduced');
}

section('13. SOURCE — overdue requires an outstanding balance');
{
  ok(/const overdue=inv\.status!=='paid'&&inv\.status!=='void'&&today>due&&outstanding>0;/.test(SRC),
     'Accounting\'s invoice row: overdue = past due AND outstanding > 0');
  ok(!/const overdue=inv\.status!=='paid'&&inv\.status!=='void'&&today>due;/.test(SRC),
     'the old due-date-only test is gone from the invoice row');
  ok(/const overdue=bill\.status!=='paid'&&bill\.status!=='void'&&today>due;/.test(SRC),
     'supplier BILLS are deliberately untouched — this repair is customer-side only');
  ok(/if\(status!=='paid' && new Date\(\)>new Date\(dueDate\)\)/.test(SRC),
     'getJobInvoices still evaluates settlement BEFORE overdue, so a settled balance can never escalate');
}

section('14. SOURCE — no synthetic payment, one canonical ledger');
{
  // Settlement is derived from the FINANCIAL FACT — the final amount due is
  // R0.00 — and not from any sponsorship flag. No such flag exists, and none
  // was added: the only occurrences of the word are the pre-existing
  // explanatory note on the Job Detail lifecycle banner and this repair's
  // comments, never a field, property or branch condition.
  ok(!/\.sponsored|isSponsored|sponsoredFlag|sponsorship|sponsored:/i.test(MASKED),
     'no sponsorship flag, field or branch condition exists anywhere in the code');
  ok(!/syntheticPayment|zeroPayment|autoPayment|fakePayment|settlementPayment/i.test(MASKED),
     'no synthetic-payment concept exists');
  ok(!/payments:\s*\[\s*\{\s*amount:\s*0/.test(MASKED), 'no R0.00 payment row is ever constructed');
  ok(/const PAYMENT_OWNER_SECTIONS = \{ job: 'jobs', quote: 'quotes', invoice: 'accInvoices' \};/.test(SRC),
     'the payment owner->section map is unchanged');
  ok(/function resolvePaymentSource\(\{ quote, job, accInvoices, quotes \}\)/.test(SRC),
     'the single-source payment resolver is unchanged — no second payment projection');
  ok(/const link = resolveQuoteForJob\(job, quotes\);/.test(SRC),
     'reconcileJobInvoice still resolves its source quote through the company-safe resolver');
  ok(/function sameCompany\(a, b\)\{/.test(SRC), 'sameCompany() is present — company scoping intact');
  ok(MASKED.length > 0, 'index.html main script block was parsed');
}

/* -- result -------------------------------------------------------------- */
console.log('\n' + '='.repeat(60));
console.log('PASSED: ' + passed + '   FAILED: ' + failures);
console.log('='.repeat(60));
process.exit(failures === 0 ? 0 : 1);
