#!/usr/bin/env node
/* customer-credit-frontend.test.js — focused frontend regression checks for
 * customer payment credit (migration 022, 2026-11-26). The shared helpers are
 * LIFTED OUT OF index.html (not re-implemented), so this cannot drift from
 * what ships. Run: node test/customer-credit-frontend.test.js */
const fs = require('fs'), path = require('path'), vm = require('vm');
const html = fs.readFileSync(path.resolve(__dirname, '..', '..', 'index.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (c, l, d) => { if (c) { pass++; console.log('  ✓ ' + l); } else { fail++; console.log('  ✗ ' + l + (d !== undefined ? ' — ' + JSON.stringify(d) : '')); } };
function lift(name) {
  const m = new RegExp('\\nfunction ' + name + '\\s*\\(').exec(html);
  if (!m) throw new Error('not found: ' + name);
  // the body starts after the parameter list (which may itself destructure with braces)
  let i = html.indexOf('{', html.indexOf(')', m.index)), d = 0, j = i, q = null, esc = false;
  for (; j < html.length; j++) { const c = html[j];
    if (q) { if (esc) { esc = false; continue; } if (c === '\\') { esc = true; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '/' && html[j + 1] === '/') { j = html.indexOf('\n', j); continue; }
    if (c === '/' && html[j + 1] === '*') { j = html.indexOf('*/', j) + 1; continue; }
    if (c === '{') d++; else if (c === '}') { d--; if (!d) break; } }
  return html.slice(m.index + 1, j + 1);
}
const confirms = [];
const ctx = { Math, Number, String, Object, Array, JSON, parseFloat, isFinite, INITIAL_COMPANIES: [{ id: 1, name: 'Signacore Holdings' }, { id: 2, name: 'Signacore' }],
  window: { confirm: (m) => { confirms.push(m); return true; } } };
vm.createContext(ctx);
const want = new Set(['sgrToCents0', 'sgrCreditZar', 'sgrPaymentKind', 'sgrIsCreditLedgerRow', 'sgrIsBalanceNeutralCreditRow', 'sgrCompanyName', 'sgrConfirmOverpayment', 'cnNorm', 'creditNoteAvailable']);
for (let grew = true; grew;) { grew = false; for (const n of [...want]) for (const r of (lift(n).match(/\bsgr\w+(?=\s*\()/g) || [])) if (!want.has(r) && new RegExp('\\nfunction ' + r + '\\s*\\(').test(html)) { want.add(r); grew = true; } }
for (const n of want) vm.runInContext(lift(n), ctx);

console.log('\n[1] what a payment row is');
ok(ctx.sgrPaymentKind({ method: 'EFT' }) === 'receipt', 'a historical EFT row is a receipt');
ok(ctx.sgrPaymentKind({ method: 'Credit (R 300,00 available)' }) === 'credit_note', 'the old "Credit (R …)" text is a credit-note payment');
ok(ctx.sgrPaymentKind({ method: 'Payment credit', _entryKind: 'payment_credit_in' }) === 'payment_credit_in', 'the server\'s entry kind wins');
ok(ctx.sgrIsCreditLedgerRow({ _entryKind: 'refund' }) && !ctx.sgrIsCreditLedgerRow({ method: 'Credit' }), 'ledger rows (applied/offset/refund) are told apart from credit-note payments');
ok(ctx.sgrIsBalanceNeutralCreditRow({ _entryKind: 'payment_credit_out' }) && !ctx.sgrIsBalanceNeutralCreditRow({ _entryKind: 'refund' }), 'applied credit is balance-neutral; a refund is not');

console.log('\n[2] overpayment confirmation');
const dc = { data: { identity: { state: 'matched', name: 'Alpha Signs' }, companyCode: '2' } };
ok(ctx.sgrConfirmOverpayment({ amount: 1000, balance: 1000, docLabel: 'INV-1', docCredit: dc }) === true && confirms.length === 0, 'no confirmation when the payment is not more than the balance');
ctx.sgrConfirmOverpayment({ amount: 1200, balance: 1000, docLabel: 'INV-1', docCredit: dc });
const m = (confirms.pop() || '').replace(/ /g, ' ');
ok(/R 1 000,00 will settle INV-1/.test(m) && /R 200,00 will remain as payment credit for Alpha Signs in Signacore/.test(m) && /No credit note is created/.test(m), 'explains what settles and what remains as customer credit', m);
ctx.sgrConfirmOverpayment({ amount: 150, balance: 100, docLabel: 'INV-2', docCredit: { data: { identity: { state: 'unresolved', detail: 'No customer record is named "Cash Sale".' }, companyCode: '2' } } });
ok(/cannot be used as customer credit until it is linked/.test(confirms.pop() || ''), 'an unlinked document says the excess is not usable as credit');

console.log('\n[3] legacy (JSON) credit-note fallback');
ok(ctx.creditNoteAvailable([{ type: 'customer', contactName: 'A', amount: 300, used: 100, refunded: 50 }], 'a') === 150, 'a recorded refund reduces available credit-note credit');

console.log('\n[4] wiring of the shipped screens');
ok((html.match(/useDocumentCredit\('invoice', inv\._relId/g) || []).length === 1 && /useDocumentCredit\(_jobCredOwner\.type/.test(html) && /useDocumentCredit\(_qCredOwner\.type/.test(html), 'all three payment windows read the server\'s customer credit');
ok((html.match(/sgrConfirmOverpayment\(\{ amount:amt/g) || []).length === 3, 'all three payment windows confirm an overpayment');
ok((html.match(/credit is never used to overpay/g) || []).length === 3, 'all three payment windows refuse Credit above the balance');
ok(/kind==='refund'[\s\S]{0,200}debit:Math\.abs\(amt\)/.test(html) && /balanceCredit:neutral\?0:amt/.test(html), 'statement: refunds are debits, applied credit is balance-neutral, receipts count once');
ok(/_k==='payment_credit_in' \|\| _k==='payment_credit_out' \|\| _k==='refund'\) return;/.test(html), 'reports: applied payment credit is never cash received again');
ok(/<CustomerCreditsView user=\{user\} customers=\{customers\}\/>/.test(html) && /\{id:'customercredits',label:'💳 Customer Credits'\}/.test(html), 'Accounting → Customer Credits tab');
ok(/<CustomerCreditModal customer=\{creditFor\}/.test(html), 'customer account → Available Credit');
ok(!/Record credits for overpayments/.test(html), 'Credit Notes no longer suggests a credit note for an overpayment (it would double-count)');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
