#!/usr/bin/env node
/* account-receipt-admin-only.test.js — 2026-11-26. "Receive Payment on Account"
 * is ADMIN only, in the UI and on the server. Every other credit permission is
 * unchanged. Reads the shipped index.html and api.ts. No database needed.
 * Run: node test/account-receipt-admin-only.test.js */
const fs = require('fs'), path = require('path'), vm = require('vm');
const html = fs.readFileSync(path.resolve(__dirname, '..', '..', 'index.html'), 'utf8');
const api = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'relational', 'api.ts'), 'utf8');
let pass = 0, fail = 0;
const ok = (c, l, d) => { if (c) { pass++; console.log('  ✓ ' + l); } else { fail++; console.log('  ✗ ' + l + (d !== undefined ? ' — ' + JSON.stringify(d) : '')); } };
const MSG = 'Admin only — contact an administrator to record a payment on account.';

console.log('\n[1] Frontend rule');
const fn = /\nfunction canRecordAccountReceipt\(user\)\{[^\n]*\}/.exec(html);
ok(!!fn, 'canRecordAccountReceipt is defined in index.html');
const ctx = {}; vm.createContext(ctx); vm.runInContext(fn[0], ctx);
const can = r => ctx.canRecordAccountReceipt(r === undefined ? null : { role: r });
ok(can('admin') && can('Admin') && can(' ADMIN '), 'admin may record (any casing)');
ok(['accounts', 'assistant', 'viewer', 'salesman', '', 'administrator'].every(r => !can(r)) && !can(undefined), 'every other role (or no login) may not');
ok(html.includes("const ACCOUNT_RECEIPT_ADMIN_ONLY = '" + MSG + "'"), 'the locked message is the agreed wording');
const btn = html.slice(html.indexOf('function AccountReceiptOpenButton'), html.indexOf('// Active payments on account visible'));
ok(/disabled aria-disabled="true"/.test(btn) && /🔒 Receive Payment on Account/.test(btn) && /account-receipt-locked-note/.test(btn), 'non-admins get a visible, disabled button with a lock icon and the note');
const uses = html.split('<AccountReceiptOpenButton').length - 1;
const raw = (html.match(/data-testid="account-receipt-open"/g) || []).length;
ok(uses === 2 && raw === 1, 'both places (Customer Credits and the customer Credit view) use the shared button; no other open button exists', { uses, raw });
ok((html.match(/\(receiving && canRecordAccountReceipt\(user\)\)/g) || []).length === 2, 'the form itself only opens for an admin');

console.log('\n[2] Server rule');
const route = api.slice(api.indexOf("router.post('/account-receipts',"), api.indexOf("router.post('/account-receipts',") + 600);
ok(api.includes("export const ACCOUNT_RECEIPT_ADMIN_ONLY = '" + MSG + "'"), 'the server message is the same wording');
const iGate = route.indexOf('creditGate'), iRole = route.indexOf('accountReceiptRecorder(req, res)'), iCo = route.indexOf('companyAllowed(req, companyCode)'), iDb = route.indexOf('recordAccountReceipt(');
ok(iGate > 0 && iRole > iGate && iCo > iRole && (iDb < 0 || iDb > iCo), 'POST /account-receipts: role check before company check, both before any write');
ok(!/creditWriter\(req, res\)/.test(route.slice(0, iCo)), 'recording no longer accepts accounts (creditWriter not used there)');
ok(/String\(req\.user\.role \|\| ''\)\.trim\(\)\.toLowerCase\(\) !== 'admin'/.test(api) && /status\(403\)\.json\(\{ conflict: false, type: 'forbidden', error: ACCOUNT_RECEIPT_ADMIN_ONLY \}\)/.test(api), 'non-admins are refused with 403 and the message');
const others = ["router.put('/account-receipts/:id'", "router.post('/account-receipts/:id/void'", "router.post('/credit-allocations/:id/reverse'", "router.post('/credit-refunds'", "router.post('/credit-refunds/:id/reverse'"];
for (const o of others) { const i = api.indexOf(o); ok(i > 0 && /creditWriter\(req, res\)/.test(api.slice(i, i + 400)), o.replace('router.', '') + ' keeps its existing Admin / Accounts permission'); }


console.log('\n[3] Applying credit (2026-11-26): Assistant may apply payment credit and payments on account');
const ap = api.slice(api.indexOf("router.post('/credit-allocations',"), api.indexOf("router.post('/credit-allocations',") + 400);
ok(/creditApplier\(req, res, req\.body\?\.sourceType\)/.test(ap) && !/creditWriter\(req, res\)/.test(ap), 'POST /credit-allocations uses the apply rule');
const fnA = api.slice(api.indexOf('function creditApplier'), api.indexOf('async function ownerCompany'));
const sctx = { out: null, ASSISTANT_CREDIT_NOTE_APPLY: 'x' }; vm.createContext(sctx);
vm.runInContext(fnA.replace(/: AuthRequest|: Response|: unknown|: boolean/g, ''), sctx);
const srv = (role, t) => { let code = 200; const res = { status(c) { code = c; return { json() {} }; } }; const r = sctx.creditApplier({ user: role == null ? null : { role } }, res, t); return r ? 'ok' : code; };
ok(['admin', 'accounts', 'Admin'].every(r => ['payment', 'account_receipt', 'credit_note'].every(t => srv(r, t) === 'ok')), 'server: Admin / Accounts may apply every source');
ok(srv('assistant', 'payment') === 'ok' && srv('assistant', 'account_receipt') === 'ok' && srv('assistant', 'credit_note') === 403, 'server: Assistant may apply payment credit and payments on account, not credit notes');
ok(['salesman', 'factory', 'viewer', ''].every(r => srv(r, 'payment') === 403) && srv(null, 'payment') === 403, 'server: every other role is refused');
const fnF = /\nfunction creditApplySourceAllowed\(user, type\)\{[\s\S]*?\n\}/.exec(html);
const fctx = {}; vm.createContext(fctx); vm.runInContext(fnF[0], fctx);
const fe = (role, t) => fctx.creditApplySourceAllowed({ role }, t);
ok(fe('assistant', 'payment') && fe('assistant', 'account_receipt') && !fe('assistant', 'credit_note') && fe('accounts', 'credit_note') && fe('admin', 'credit_note') && !fe('salesman', 'payment'), 'frontend panel follows the same rule');
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
