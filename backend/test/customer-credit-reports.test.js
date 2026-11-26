#!/usr/bin/env node
/* customer-credit-reports.test.js — Reports → Payments with customer credit
 * (migrations 022/023, 2026-11-26). The report model is LIFTED OUT OF
 * index.html (same extraction as reports-payments-canonical.test.js), so this
 * checks exactly what ships. Plain Node, no database.
 *   node test/customer-credit-reports.test.js
 *
 * Rules checked: only a RECEIPT is cash received — an ordinary document receipt
 * and a payment on account once each; applied payment credit (+/-) and
 * credit-note payments (new kind or older "Credit…" text) never; a reversed
 * allocation leaves no row at all; refunds are totalled separately and never
 * counted as cash received. */
'use strict';
const fs = require('fs');
const path = require('path');
const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH || path.resolve(__dirname, '..', '..', 'index.html');
let failures = 0, passed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failures++; console.log('  ✗ ' + label + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}
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
  'sgrReportLastPaid', 'sgrReportPaymentDocument', 'sgrPaymentsReportModelScoped', 'sgrPaymentsReportModel',
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


const SIG = { role: 'admin', email: 'a@x', co: 2 };
const HOL = { role: 'admin', email: 'h@x', co: 1 };
let seq = 5000;
const pay = (owner, amount, date, extra = {}) => { seq++; return { id: 'p' + seq, _relPaymentId: seq, _relOwnerType: owner, amount, date, ...extra }; };
const line = amt => ({ description: 'x', qty: 1, unitAmount: amt, taxType: 'No VAT' });
const run = (inv, acc, cns, user, jobs = [], quotes = []) => A.sgrPaymentsReportModel(jobs, quotes, inv, user || SIG, acc, cns);

console.log('\n[1] Only receipts are cash received');
const receipt = pay('invoice', 1000, '2026-11-20', { method: 'EFT', _entryKind: 'receipt' });
const invA = { id: 'iA', number: 'INV-A', co: 2, date: '2026-11-20', status: 'paid', lineItems: [line(1000)], payments: [receipt] };
const applied = pay('invoice', 1500, '2026-11-27', { method: 'Payment credit', _entryKind: 'payment_credit_in' });
const invB = { id: 'iB', number: 'INV-B', co: 2, date: '2026-11-27', status: 'paid', lineItems: [line(1500)], payments: [applied] };
const over = pay('invoice', 1200, '2026-11-21', { method: 'EFT', _entryKind: 'receipt' });
const offset = pay('invoice', -200, '2026-11-28', { method: 'Payment credit applied', _entryKind: 'payment_credit_out' });
const refundRow = pay('invoice', -50, '2026-11-29', { method: 'Refund', _entryKind: 'refund', reference: 'RF-DOC' });
const invC = { id: 'iC', number: 'INV-C', co: 2, date: '2026-11-21', status: 'paid', lineItems: [line(1000)], payments: [over, offset, refundRow] };
const cnNew = pay('invoice', 300, '2026-11-22', { method: 'Credit', _entryKind: 'credit_note' });
const cnOld = pay('invoice', 100, '2026-11-22', { method: 'Credit' });                       // older row, no kind
const cnOldTxt = pay('invoice', 80, '2026-11-22', { method: 'Credit (R 300,00 available)' }); // oldest text form
const invD = { id: 'iD', number: 'INV-D', co: 2, date: '2026-11-22', status: 'paid', lineItems: [line(480)], payments: [cnNew, cnOld, cnOldTxt] };
const acc = [{ sourceId: 1, sourceType: 'account_receipt', companyCode: '2', status: 'active', date: '2026-11-26', original: 2000, method: 'EFT', reference: 'FNB-ACC', customerName: 'Fresh',
  history: [{ kind: 'allocation', status: 'active', amount: 1500 }, { kind: 'refund', status: 'active', amount: 200, date: '2026-11-30', reference: 'RF-ACC' }, { kind: 'refund', status: 'reversed', amount: 100 }] }];
const cns = [{ id: 'cn1', type: 'customer', co: 2, number: 'CN-1', contactName: 'Old Co', amount: 300, refunds: [{ amount: 25, date: '2026-11-30', reference: 'RF-CN' }] }];
const m = run([invA, invB, invC, invD], acc, cns);
ok(m.totalPaidC === 100000 + 120000 + 200000, 'Total Paid = R1,000 receipt + R1,200 receipt + R2,000 payment on account (R4,200)', m.totalPaidC);
const cents = m.receipts.map(r => r._payCents).sort((a, b) => a - b);
ok(JSON.stringify(cents) === JSON.stringify([100000, 120000, 200000]), 'exactly three cash receipts, each once', cents);
ok(!m.receipts.some(r => r._payment === applied || r._payment === offset), 'applied payment credit (+R1,500 / −R200) is not cash received');
ok(!m.receipts.some(r => [cnNew, cnOld, cnOldTxt].includes(r._payment)), 'credit-note payments (new kind, older "Credit", oldest "Credit (R …)") are not cash received');
ok(!(m.byDate['2026-11-22'] || []).length && !(m.byDate['2026-11-27'] || []).length, 'calendar: no cash on the credit-note or credit-applied dates');
ok((m.byDate['2026-11-26'] || []).length === 1 && m.byDate['2026-11-26'][0]._docKind === 'account' && m.byDate['2026-11-26'][0]._payCents === 200000, 'calendar: the payment on account on its own date, once');

console.log('\n[2] Refunds are shown separately, never as cash received');
ok(m.totalRefundedC === 5000 + 20000 + 2500, 'Refunds recorded = R50 (document) + R200 (payment on account) + R25 (credit note); the reversed R100 is excluded', m.totalRefundedC);
ok(m.refunds.length === 3 && !m.receipts.some(r => r._payment === refundRow), 'three refund entries, none counted in Total Paid');

console.log('\n[3] A reversed allocation leaves no cash');
// Reversal deletes the +/- entries; the model then simply does not have them.
const mRev = run([invA, { ...invB, payments: [] }, { ...invC, payments: [over, refundRow] }, invD], acc, cns);
ok(mRev.totalPaidC === m.totalPaidC, 'Total Paid unchanged by reversing (no receipt is created)', mRev.totalPaidC);
const mUnalloc = run([], [{ ...acc[0], history: [] }], []);
ok(mUnalloc.totalPaidC === 200000, 'an entirely unallocated payment on account is cash received once (R2,000)');

console.log('\n[4] Company scoping');
const mHol = run([invA], acc, cns, HOL);
ok(mHol.totalPaidC === 0 && mHol.totalRefundedC === 0, 'a Holdings login does not see Signacore receipts or refunds');

console.log('\n[5] Callers without customer-credit data are unchanged');
const mDash = A.sgrPaymentsReportModelScoped([], [], [invA, invB]);
ok(mDash.totalPaidC === 100000 && mDash.totalRefundedC === 0, 'the Dashboard path (no account receipts / credit notes) still works');

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
