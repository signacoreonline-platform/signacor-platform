#!/usr/bin/env node
/* ============================================================================
 * invoice-cancel-frontend.test.js — 2026-11-19
 * Signacore — the dashboard half of "cancel, never delete".
 * ============================================================================
 * Every function is LIFTED OUT OF index.html (the shipped
 * cancelCanonicalInvoice, invoiceReplacementNumber, invoiceCancelledLabel, the
 * SGR-CANONICAL-CENTS and SGR-DASHBOARD-METRICS blocks and the named
 * resolvers) and run against synthetic records — nothing is re-implemented.
 *
 *   1  relational mode: one cancel request, the record is KEPT and re-labelled,
 *      the job is released, failures change nothing
 *   2  admin only, reason required, money on the invoice refuses
 *   3  legacy JSON mode: the same retention on the JSON record
 *   4  replacement display: recorded link wins; A -> B -> C stays a chain;
 *      never across a company; never guessed when ambiguous
 *   5  financial calculations: a cancelled invoice (with its original lines)
 *      counts for nothing, and the replacement counts once
 *   6  source shape: no delete path is left in the page
 *
 * ZERO DEPENDENCIES — plain Node, no database.
 *   node test/invoice-cancel-frontend.test.js
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH || path.resolve(__dirname, '..', '..', 'index.html');

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
  let at = src.indexOf('\nfunction ' + name + '(');
  if (at < 0) at = src.indexOf('\nasync function ' + name + '(');
  if (at < 0) throw new Error('could not locate top-level function ' + name + ' in index.html');
  const start = at + 1;
  const win = src.slice(start, start + 60000);
  const wm = maskForCounting(win);
  // skip the parameter list (it may contain destructuring braces)
  let i = wm.indexOf('('), depth = 0;
  for (; i < wm.length; i++) { if (wm[i] === '(') depth++; else if (wm[i] === ')') { depth--; if (depth === 0) { i++; break; } } }
  const open = wm.indexOf('{', i);
  depth = 0;
  for (let k = open; k < wm.length; k++) {
    if (wm[k] === '{') depth++;
    else if (wm[k] === '}') { depth--; if (depth === 0) return win.slice(0, k + 1); }
  }
  throw new Error('unbalanced body for ' + name);
}
function extractConst(src, masked, name) {
  const m = new RegExp('const\\s+' + name + '\\s*=', 'g').exec(masked);
  if (!m) throw new Error('could not extract const ' + name);
  return src.slice(m.index, masked.indexOf(';', m.index) + 1);
}
function sentinelBlock(src, begin, end) {
  const a = src.indexOf(begin), b = src.indexOf(end);
  if (a < 0 || b < 0) { console.error(begin + ' sentinels not found'); process.exit(1); }
  return src.slice(src.lastIndexOf('/*', a), b + end.length);
}

const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
const OPEN = '<script type="text/babel" data-presets="react-classic">';
const startIdx = html.indexOf(OPEN);
if (startIdx < 0) { console.error('Main babel script block not found'); process.exit(1); }
const SRC = html.slice(startIdx + OPEN.length, html.lastIndexOf('</script>'));
const MASKED = maskForCounting(SRC);

const RESOLVERS = [
  'isGenuineZeroAmount',
  'isHoldingsUser', 'isHoldingsRecord', 'belongsToUserCompany',
  'companyTagOf', 'sameCompany', 'jobHasId', 'resolveJobsForQuote', 'resolveJobForQuote',
  'resolveQuoteForJob', 'resolveQuoteForInvoice',
  'invoiceIdentityKey', 'invoiceBelongsToJob', 'resolveJobInvoiceRecord',
  'sgrReportPaymentKey', 'sgrReportPaymentDate', 'sgrReportChainPayments',
  'sgrReportLastPaid', 'sgrReportPaymentDocument', 'sgrPaymentsReportModelScoped', 'sgrPaymentsReportModel',
  'invoiceCancelledLabel', 'invoiceReplacementNumber', 'invoiceOwnMoneyPayments', 'cancelCanonicalInvoice',
];
const EXPORTS = ['belongsToUserCompany', 'sgrDashboardFinancials', 'sgrPaymentsReportModelScoped', 'sgrInvoiceCents',
  'invoiceCancelledLabel', 'invoiceReplacementNumber', 'invoiceOwnMoneyPayments', 'cancelCanonicalInvoice'];
const pieces = ['"use strict";',
  // The page's environment, supplied by each test through `env`.
  'const window = env.window; const alert = (m) => env.alerts.push(String(m));',
  'const isRelationalAuthoritative = (s) => env.relational.indexOf(s) !== -1;',
  'const relationalApi = env.api; const syncRelationalBaseline = (k, u) => env.baselines.push(k);',
  'const describeSaveConflictError = (e) => (e && e.message) || String(e);',
  extractConst(SRC, MASKED, 'UNIONTECH_ID'),
  extractConst(SRC, MASKED, 'HOLDINGS_CO_ID'),
  extractConst(SRC, MASKED, 'HOLDINGS_CO_KEY'),
  sentinelBlock(SRC, 'BEGIN SGR-CANONICAL-CENTS', '/* END SGR-CANONICAL-CENTS */'),
  sentinelBlock(SRC, 'BEGIN SGR-DASHBOARD-METRICS', '/* END SGR-DASHBOARD-METRICS */')];
for (const f of RESOLVERS) pieces.push(extractFunction(SRC, f));
pieces.push('return {' + EXPORTS.join(',') + '};');
function load(env) {
  try { return new Function('env', pieces.join('\n'))(env); }
  catch (e) { console.error('Could not evaluate lifted functions: ' + e.message); process.exit(1); }
}
function makeEnv(over) {
  const env = Object.assign({ relational: ['accInvoices', 'jobs', 'quotes'], alerts: [], baselines: [], calls: [], promptAnswer: 'Client changed the order',
    api: { cancelInvoice: async () => { throw new Error('api.cancelInvoice not stubbed'); } } }, over || {});
  env.window = { prompt: (msg) => { env.promptText = String(msg); env.promptCount = (env.promptCount || 0) + 1; return env.promptAnswer; }, confirm: () => { env.confirmCount = (env.confirmCount || 0) + 1; return true; } };
  return env;
}
// React-style state holder: the action receives setters, exactly as the pages pass them.
function state(initial) { const s = { v: initial, sets: 0 }; s.set = (u) => { s.sets++; s.v = typeof u === 'function' ? u(s.v) : u; }; return s; }

const ADMIN = { role: 'admin', name: 'Ockert', email: 'admin@x', co: null };
const line = (amt, d) => ({ description: d || 'x', qty: 1, unitAmount: amt, taxType: '15%' });
const pay = (id, owner, amount, extra) => Object.assign({ id: 'p' + id, _relPaymentId: id, _relOwnerType: owner, amount, date: '2026-11-03', method: 'EFT' }, extra || {});
const depQ = pay(1, 'quote', 920);
const jobPay = pay(2, 'job', 100);
function world() {
  return {
    jobs: [{ id: 448, _relId: 448, _relRowVersion: 7, num: 'SNS-00236', co: 2, client: "Hennie's", value: 1150, quoteNum: 'SQ-00304',
      invoiceNum: 'INV-00223', invoiceDate: '2026-11-09', invoiceDue: '2026-12-09', invoiceCreated: true, invoiceStatus: 'partial', stage: 8, status: 'installation', createdAt: '2026-11-09T07:00:00.000Z', payments: [jobPay] },
    { id: 449, _relId: 449, _relRowVersion: 3, num: 'SNS-00237', co: 2, client: 'Other', value: 500, invoiceNum: 'INV-00224', invoiceCreated: true, stage: 9, status: 'invoiced', createdAt: '2026-11-10T07:00:00.000Z', payments: [] }],
    quotes: [{ id: 'q304', _relId: 304, num: 'SQ-00304', co: 2, client: "Hennie's", convertedJobId: 448, status: 'converted', payments: [depQ] }],
    inv: [
      { id: 200, _relId: 200, _relRowVersion: 4, number: 'INV-00223', co: 2, contactName: "Hennie's", reference: 'SNS-00236', jobNum: 'SNS-00236', quoteNum: 'SQ-00304',
        date: '2026-11-09', dueDate: '2026-12-09', status: 'partial', lineItems: [line(800, 'Sign'), line(200, 'Install')], payments: [depQ, jobPay] },
      { id: 201, _relId: 201, number: 'INV-00219', co: 2, contactName: "Hennie's", jobNum: 'SNS-00236', reference: 'Cancelled by Admin — replaced by INV-00223', date: '2026-11-09', status: 'void',
        cancelledByAdmin: true, replacedBy: 'INV-00223', originalJobNum: 'SNS-00236', originalQuoteNum: 'SQ-00304', lineItems: [line(0, 'CANCELLED BY ADMIN')], payments: [] },
      { id: 203, _relId: 203, _relRowVersion: 2, number: 'INV-00224', co: 2, contactName: 'Other', reference: 'SNS-00237', jobNum: 'SNS-00237', date: '2026-11-10', status: 'sent', lineItems: [line(500)], payments: [] },
    ],
  };
}

(async () => {
  /* ═══════════════════════════════════════════════════════════════════════ */
  section('1. Relational mode — the record is kept, re-labelled and the job released');
  {
    const w = world(); const acc = state(w.inv); const jobs = state(w.jobs);
    const env = makeEnv({ api: { cancelInvoice: async (id, ver, reason) => { env.calls.push({ id, ver, reason });
      return { success: true, cancelled: true, deleted: false, alreadyCancelled: false, rowVersion: 5, status: 'void',
        marker: { cancelledByAdmin: true, cancelledAt: '2026-11-19T09:00:00.000Z', cancelledBy: 'admin@x', cancelledReason: reason, statusBeforeCancel: 'partial',
          originalJobId: 448, originalJobNum: 'SNS-00236', originalQuoteId: 304, originalQuoteNum: 'SQ-00304', originalDetailRetained: true, replacedBy: null },
        clearedJobs: [{ id: 448, sourceId: '448', jobNumber: 'SNS-00236', rowVersion: 8 }], ambiguousJobs: [], creditReleased: 0 }; } } });
    const A = load(env);
    const linesBefore = JSON.stringify(acc.v[0].lineItems);
    await A.cancelCanonicalInvoice(200, { accInvoices: acc.v, setAccInvoices: acc.set, setJobs: jobs.set, user: ADMIN });
    ok(env.calls.length === 1 && env.calls[0].id === 200 && env.calls[0].ver === 4 && env.calls[0].reason === 'Client changed the order', 'exactly one cancel request: record id, its version, the typed reason', env.calls);
    ok(/NOT deleted/.test(env.promptText) && /Cancelled by Admin/.test(env.promptText) && /SNS-00236/.test(env.promptText) && /required/.test(env.promptText), 'the prompt says the invoice is kept, names the job and asks for a required reason');
    ok(!env.confirmCount, 'no "Delete anyway?" confirmation is shown any more');
    const rec = acc.v.find(i => i.id === 200);
    ok(acc.v.length === 3 && !!rec, 'the record is STILL in accInvoices (never filtered out)');
    ok(rec.status === 'void' && rec.cancelledByAdmin === true && rec.cancelledReason === 'Client changed the order' && rec.cancelledBy === 'admin@x', 'it is void and carries who/why from the server');
    ok(rec.number === 'INV-00223' && rec.date === '2026-11-09' && rec.contactName === "Hennie's" && JSON.stringify(rec.lineItems) === linesBefore, 'number, date, customer and original lines are unchanged');
    ok(rec._relRowVersion === 5, 'the new row version is adopted');
    ok(rec.payments.length === 0, "the job's and quote's payments are no longer shown on the cancelled record");
    ok(A.invoiceCancelledLabel(rec) === 'Cancelled by Admin', 'it reads "Cancelled by Admin"');
    const j = jobs.v.find(x => x.num === 'SNS-00236');
    ok(j.invoiceNum === null && j.invoiceCreated === false && j.invoiceStatus === null && j.invoiceDate === null && j._relRowVersion === 8, 'the job is released locally with the server\'s new version');
    ok(j.payments.length === 1 && j.value === 1150 && j.stage === 8, "the job's payments, value and stage are untouched");
    ok(JSON.stringify(jobs.v.find(x => x.num === 'SNS-00237')) === JSON.stringify(w.jobs[1]), 'an unrelated job is untouched');
    ok(env.baselines.indexOf('accInvoices') !== -1 && env.baselines.indexOf('jobs') !== -1, 'both relational baselines are synced');
    ok(env.alerts.length === 0, 'no error is shown');

    // repeat on the now-cancelled record
    env.calls.length = 0; const snap = JSON.stringify(acc.v);
    await A.cancelCanonicalInvoice(200, { accInvoices: acc.v, setAccInvoices: acc.set, setJobs: jobs.set, user: ADMIN });
    ok(env.calls.length === 0 && JSON.stringify(acc.v) === snap && /already cancelled/.test(env.alerts.join('|')), 'cancelling it again sends nothing and changes nothing');
  }
  {
    const w = world(); const acc = state(w.inv); const jobs = state(w.jobs);
    const env = makeEnv({ api: { cancelInvoice: async () => { const e = new Error('Invoice INV-00223 was NOT cancelled: server refused'); throw e; } } });
    const A = load(env); const s1 = JSON.stringify(acc.v), s2 = JSON.stringify(jobs.v);
    await A.cancelCanonicalInvoice(200, { accInvoices: acc.v, setAccInvoices: acc.set, setJobs: jobs.set, user: ADMIN });
    ok(JSON.stringify(acc.v) === s1 && JSON.stringify(jobs.v) === s2 && acc.sets === 0 && jobs.sets === 0, 'a refused/failed request leaves the invoice and the job exactly as they were');
    ok(/The invoice was NOT cancelled/.test(env.alerts.join('|')), 'and says the invoice was NOT cancelled');
  }
  {
    const w = world(); const acc = state(w.inv); const jobs = state(w.jobs);
    const env = makeEnv({ api: { cancelInvoice: async () => ({ cancelled: true, alreadyCancelled: true, rowVersion: 9, status: 'void',
      marker: { cancelledByAdmin: true, cancelledReason: 'first session', cancelledBy: 'other@x', replacedBy: 'INV-00231' }, clearedJobs: [], ambiguousJobs: [] }) } });
    const A = load(env);
    await A.cancelCanonicalInvoice(200, { accInvoices: acc.v, setAccInvoices: acc.set, setJobs: jobs.set, user: ADMIN });
    const rec = acc.v.find(i => i.id === 200);
    ok(rec.status === 'void' && rec.cancelledReason === 'first session' && rec.replacedBy === 'INV-00231', 'cancelled meanwhile in another session: this tab adopts the EXISTING record (who/why/replacement), no error');
  }

  /* ═══════════════════════════════════════════════════════════════════════ */
  section('2. Admin only, reason required, money on the invoice refuses');
  {
    for (const role of ['accounts', 'assistant', 'factory']) {
      const w = world(); const acc = state(w.inv); const env = makeEnv(); const A = load(env);
      await A.cancelCanonicalInvoice(200, { accInvoices: acc.v, setAccInvoices: acc.set, setJobs: () => {}, user: { role } });
      ok(acc.sets === 0 && !env.promptCount && /Only an admin/.test(env.alerts.join('|')), 'role "' + role + '" is refused before anything is asked or sent');
    }
    for (const [answer, label] of [[null, 'pressing Cancel on the prompt'], ['', 'an empty reason'], ['    ', 'a blank reason']]) {
      const w = world(); const acc = state(w.inv); const env = makeEnv({ promptAnswer: answer }); const A = load(env);
      await A.cancelCanonicalInvoice(200, { accInvoices: acc.v, setAccInvoices: acc.set, setJobs: () => {}, user: ADMIN });
      ok(acc.sets === 0 && env.calls.length === 0, label + ' cancels nothing');
    }
    const w = world(); w.inv[0].payments = [depQ, jobPay, pay(3, 'invoice', 250), pay(4, 'invoice', 0), pay(5, 'invoice', 50, { method: 'Credit' })];
    const acc = state(w.inv); const env = makeEnv(); const A = load(env);
    ok(A.invoiceOwnMoneyPayments(w.inv[0], true).length === 2, "only the invoice's OWN non-zero payments count (not the quote deposit, the job payment or a zero row)");
    await A.cancelCanonicalInvoice(200, { accInvoices: acc.v, setAccInvoices: acc.set, setJobs: () => {}, user: ADMIN });
    const msg = env.alerts.join('|');
    ok(acc.sets === 0 && !env.promptCount && env.calls.length === 0, 'an invoice holding its own money is refused before any request');
    ok(/NOT cancelled/.test(msg) && /2 payments/.test(msg) && /300/.test(msg) && /applied customer credit/.test(msg) && /record the money against the job/.test(msg), 'the message names the count, the amount, the credit and what to do', msg);
    const w2 = world(); const acc2 = state(w2.inv); let sent = 0; const env2 = makeEnv({ api: { cancelInvoice: async () => { sent++; return { cancelled: true, rowVersion: 5, marker: { cancelledByAdmin: true }, clearedJobs: [], ambiguousJobs: [] }; } } });
    await load(env2).cancelCanonicalInvoice(200, { accInvoices: acc2.v, setAccInvoices: acc2.set, setJobs: () => {}, user: ADMIN });
    ok(sent === 1, 'money held only on the quote and the job does NOT block the cancellation');
  }

  /* ═══════════════════════════════════════════════════════════════════════ */
  section('3. Legacy JSON records — the same retention');
  {
    const w = world();
    // JSON-era shape: no _relId, embedded payments ARE the invoice's own.
    w.inv = w.inv.map(i => { const c = Object.assign({}, i); delete c._relId; delete c._relRowVersion; return c; });
    w.inv[0].payments = [];
    w.inv[1] = Object.assign({}, w.inv[1], { replacedBy: null });          // an earlier cancelled invoice with no recorded replacement yet
    w.jobs = w.jobs.map(j => { const c = Object.assign({}, j); delete c._relId; delete c._relRowVersion; return c; });
    w.jobs.push({ id: 900, num: 'HSN-00001', co: 1, client: 'Holdings', value: 10, invoiceNum: 'INV-00223', invoiceCreated: true, stage: 9, status: 'invoiced', payments: [] });
    const acc = state(w.inv); const jobs = state(w.jobs); let apiCalls = 0;
    const env = makeEnv({ relational: [], api: { cancelInvoice: async () => { apiCalls++; } } }); const A = load(env);
    const linesBefore = JSON.stringify(acc.v[0].lineItems);
    await A.cancelCanonicalInvoice(200, { accInvoices: acc.v, setAccInvoices: acc.set, setJobs: jobs.set, user: ADMIN });
    const rec = acc.v.find(i => i.id === 200);
    ok(apiCalls === 0, 'no relational request is made for a JSON record');
    ok(acc.v.length === 3 && rec.status === 'void' && rec.cancelledByAdmin === true, 'the JSON record is kept and marked void / Cancelled by Admin');
    ok(rec.cancelledBy === 'Ockert' && rec.cancelledReason === 'Client changed the order' && !Number.isNaN(Date.parse(rec.cancelledAt)) && rec.statusBeforeCancel === 'partial', 'who, when, why and the previous status are recorded');
    ok(rec.originalJobNum === 'SNS-00236' && rec.originalQuoteNum === 'SQ-00304' && rec.originalDetailRetained === true && JSON.stringify(rec.lineItems) === linesBefore && rec.number === 'INV-00223', 'the original lines, number and job/quote identity are retained');
    ok(acc.v.find(i => i.id === 201).replacedBy === 'INV-00223', 'CHAIN: the earlier cancelled INV-00219 is stamped "replaced by INV-00223" as INV-00223 is cancelled');
    const j = jobs.v.find(x => x.num === 'SNS-00236');
    ok(j.invoiceNum === null && j.invoiceCreated === false && j.invoiceStatus === null, 'the JSON job is released so it can be invoiced again');
    ok(jobs.v.find(x => x.num === 'HSN-00001').invoiceNum === 'INV-00223', "another company's job carrying the same invoice number is NOT touched");
    ok(jobs.v.find(x => x.num === 'SNS-00237').invoiceNum === 'INV-00224', 'another job of the same company is not touched');
    // a later replacement, derived for display
    const next = acc.v.concat([{ id: 300, number: 'INV-00231', co: 2, contactName: "Hennie's", reference: 'SNS-00236', jobNum: 'SNS-00236', date: '2026-11-18', status: 'sent', lineItems: [line(1200)], payments: [] }]);
    ok(A.invoiceReplacementNumber(next.find(i => i.id === 200), next) === 'INV-00231', 'INV-00223 then shows INV-00231 as its replacement');
    ok(A.invoiceReplacementNumber(next.find(i => i.id === 201), next) === 'INV-00223', 'while INV-00219 still shows INV-00223 — the chain 00219 → 00223 → 00231 holds');
    // legacy invoice with its own money
    const w3 = world(); w3.inv = w3.inv.map(i => { const c = Object.assign({}, i); delete c._relId; return c; }); w3.inv[0].payments = [{ id: 'x', amount: 400, method: 'EFT' }];
    const acc3 = state(w3.inv); const env3 = makeEnv({ relational: [] });
    await load(env3).cancelCanonicalInvoice(200, { accInvoices: acc3.v, setAccInvoices: acc3.set, setJobs: () => {}, user: ADMIN });
    ok(acc3.sets === 0 && /NOT cancelled/.test(env3.alerts.join('|')), 'a JSON invoice with payments recorded on it is refused too');
    // mixed mode: invoices JSON, jobs relational -> the relational job is not edited locally
    const w4 = world(); w4.inv = w4.inv.map(i => { const c = Object.assign({}, i); delete c._relId; return c; }); w4.inv[0].payments = [];
    const acc4 = state(w4.inv); const jobs4 = state(w4.jobs); const env4 = makeEnv({ relational: ['jobs'] });
    await load(env4).cancelCanonicalInvoice(200, { accInvoices: acc4.v, setAccInvoices: acc4.set, setJobs: jobs4.set, user: ADMIN });
    ok(acc4.v.find(i => i.id === 200).status === 'void' && jobs4.sets === 0, 'mixed mode: the JSON invoice is retained as void and a server-owned job is never rewritten from the browser');
  }

  /* ═══════════════════════════════════════════════════════════════════════ */
  section('4. Which invoice replaced a cancelled one');
  {
    const A = load(makeEnv());
    const base = (o) => Object.assign({ co: 2, status: 'void', cancelledByAdmin: true, originalJobNum: 'SNS-00236', originalQuoteNum: 'SQ-00304', lineItems: [], payments: [] }, o);
    const a = base({ id: 1, number: 'INV-00219', replacedBy: 'INV-00223' });
    const b = base({ id: 2, number: 'INV-00223', replacedBy: null });
    const c = { id: 3, number: 'INV-00231', co: 2, status: 'sent', reference: 'SNS-00236', jobNum: 'SNS-00236', lineItems: [], payments: [] };
    ok(A.invoiceReplacementNumber(a, [a, b, c]) === 'INV-00223', 'a RECORDED replacement always wins (INV-00219 → INV-00223, not the newest invoice)');
    ok(A.invoiceReplacementNumber(b, [a, b, c]) === 'INV-00231', 'no recorded link yet: the one active invoice of the same job is shown');
    ok(A.invoiceReplacementNumber(b, [a, b]) === '', 'no active invoice for the job → no replacement shown');
    ok(A.invoiceReplacementNumber(b, [a, b, Object.assign({}, c, { co: 1 })]) === '', "another company's invoice for the same job number is never shown");
    ok(A.invoiceReplacementNumber(b, [a, b, c, Object.assign({}, c, { id: 4, number: 'INV-00240' })]) === '', 'two candidates → nothing is guessed');
    ok(A.invoiceReplacementNumber(c, [a, b, c]) === '', 'an active invoice has no replacement');
    ok(A.invoiceReplacementNumber(base({ id: 9, number: 'INV-1', cancelledByAdmin: false, replacedBy: null }), [c]) === '', 'a plain void record with no admin marker is never given a derived replacement');
    const q = base({ id: 5, number: 'INV-00300', originalJobNum: null, originalQuoteNum: 'SQ-00400', replacedBy: null });
    const qRepl = { id: 6, number: 'INV-00301', co: 2, status: 'sent', quoteNum: 'SQ-00400', lineItems: [], payments: [] };
    ok(A.invoiceReplacementNumber(q, [q, qRepl]) === 'INV-00301', 'a quote-raised invoice resolves its replacement through the quote');
    ok(A.invoiceCancelledLabel(b) === 'Cancelled by Admin' && A.invoiceCancelledLabel({ status: 'void' }) === 'Cancelled', 'labels: admin-cancelled vs any other void');
  }

  /* ═══════════════════════════════════════════════════════════════════════ */
  section('5. Financial calculations — cancelled counts for nothing, the replacement counts once');
  {
    const A = load(makeEnv());
    const SIG = { role: 'admin', email: 'a@x', co: 2 };
    const scope = (arr) => arr.filter(r => A.belongsToUserCompany(r, SIG));
    // After the chain: INV-00219 (placeholder, R0), INV-00223 (cancelled WITH its
    // original R1,150 lines), INV-00231 the active replacement for R1,380.
    const job = { id: 448, _relId: 448, num: 'SNS-00236', co: 2, client: "Hennie's", value: 1380, quoteNum: 'SQ-00304', invoiceNum: 'INV-00231', invoiceRelId: 231,
      invoiceDate: '2026-11-18', invoiceCreated: true, stage: 8, status: 'installation', createdAt: '2026-11-09T07:00:00.000Z', payments: [jobPay] };
    const quote = { id: 'q304', _relId: 304, num: 'SQ-00304', co: 2, client: "Hennie's", convertedJobId: 448, status: 'converted', payments: [depQ] };
    const i219 = { id: 201, _relId: 201, number: 'INV-00219', co: 2, contactName: "Hennie's", jobNum: 'SNS-00236', date: '2026-11-09', status: 'void', cancelledByAdmin: true, replacedBy: 'INV-00223', lineItems: [line(0)], payments: [] };
    const i223 = { id: 200, _relId: 200, number: 'INV-00223', co: 2, contactName: "Hennie's", jobNum: 'SNS-00236', quoteNum: 'SQ-00304', reference: 'SNS-00236', date: '2026-11-09', status: 'void',
      cancelledByAdmin: true, replacedBy: 'INV-00231', originalJobNum: 'SNS-00236', originalDetailRetained: true, lineItems: [line(800), line(200)], payments: [] };
    const i231 = { id: 231, _relId: 231, number: 'INV-00231', co: 2, contactName: "Hennie's", jobNum: 'SNS-00236', quoteNum: 'SQ-00304', reference: 'SNS-00236', date: '2026-11-18', status: 'partial',
      lineItems: [line(1000), line(200)], payments: [depQ, jobPay] };
    ok(A.sgrInvoiceCents(i223.lineItems).totalC === 115000, 'precondition: the cancelled INV-00223 really carries R1,150.00 of original lines');
    const withCancelled = A.sgrDashboardFinancials(scope([job]), scope([quote]), scope([i219, i223, i231]), []);
    const withoutCancelled = A.sgrDashboardFinancials(scope([job]), scope([quote]), scope([i231]), []);
    ok(JSON.stringify(withCancelled) === JSON.stringify(withoutCancelled), 'dashboard revenue / outstanding / every figure is IDENTICAL with and without the cancelled invoices');
    const flat = JSON.stringify(withCancelled);
    ok(flat.indexOf('1380') !== -1 && flat.indexOf('2530') === -1, 'revenue is the replacement only (R1,380) — never R1,380 + the cancelled R1,150', flat.slice(0, 300));
    const leak = A.sgrDashboardFinancials(scope([job]), scope([quote]), scope([i219, Object.assign({}, i223, { status: 'sent' }), i231]), []);
    ok(JSON.stringify(leak) !== JSON.stringify(withoutCancelled), 'control: the same record, if it were NOT void, would change the figures (so the test can fail)');
    const rep1 = A.sgrPaymentsReportModelScoped(scope([job]), scope([quote]), scope([i219, i223, i231]));
    const rep2 = A.sgrPaymentsReportModelScoped(scope([job]), scope([quote]), scope([i231]));
    ok(JSON.stringify(rep1) === JSON.stringify(rep2), 'the Reports payments model is identical with and without the cancelled invoices');
    const r = JSON.stringify(rep1);
    ok((r.match(/"INV-00231"/g) || []).length >= 1 && r.indexOf('INV-00223') === -1 && r.indexOf('INV-00219') === -1, 'the replacement is the only invoice of the chain in the report rows');
    const paidTotals = (r.match(/"_paidC":(\d+)/g) || []).map(x => Number(x.split(':')[1]));
    ok(paidTotals.length >= 1 && paidTotals.every(v => v === 102000), 'every paid total in the report is R1,020.00 — the quote deposit (R920) and the job payment (R100) once each, never doubled', paidTotals);
  }

  /* ═══════════════════════════════════════════════════════════════════════ */
  section('6. Source shape — no delete path remains in the page');
  {
    const code = MASKED;   // comments and strings blanked: only real code is searched
    ok(code.indexOf('deleteCanonicalInvoice') === -1, 'deleteCanonicalInvoice no longer exists');
    ok(!/relationalApi\s*\.\s*deleteInvoice/.test(code) && !/\bdeleteInvoice\s*\(/.test(code), 'nothing calls or defines a deleteInvoice action');
    ok(SRC.indexOf("method: 'DELETE', body: JSON.stringify({ expectedVersion: expectedVersion }) }); },\n".replace('\n', '')) === -1 || !/'\/invoices\/' \+ id, \{ method: 'DELETE'/.test(SRC), 'the page has no DELETE /invoices adapter');
    ok(/cancelInvoice\(id, expectedVersion, reason\)\s*\{\s*return relationalFetch\('\/invoices\/' \+ id \+ '\/cancel', \{ method: 'POST'/.test(SRC), 'relationalApi.cancelInvoice POSTs /invoices/:id/cancel');
    const fn = extractFunction(SRC, 'cancelCanonicalInvoice');
    ok(fn.indexOf('.filter(i=>i.id!==id)') === -1, 'the cancel action never filters the record out of accInvoices');
    ok(/user\.role!=='admin'/.test(fn) && /window\.prompt\(/.test(fn), 'it checks the admin role and asks for a reason');
    ok(SRC.indexOf('cancelCanonicalInvoice(manualRec.id, { accInvoices: myAccInvoices, setAccInvoices, setJobs, user })') !== -1, 'Sales → Invoices uses the shared cancel action');
    ok(SRC.indexOf('return cancelCanonicalInvoice(id, { accInvoices, setAccInvoices, setJobs, user });') !== -1, 'Accounting → Invoices uses the same shared cancel action');
    ok((SRC.match(/🚫 Cancel invoice/g) || []).length === 2 && SRC.indexOf('✕ Delete\r\n') === -1 && SRC.indexOf('✕ Delete\n') === -1, 'both buttons read "Cancel invoice"; no "✕ Delete" invoice button remains');
    ok(SRC.indexOf("{['draft','sent','paid','overdue'].map(s=><option") !== -1 && SRC.indexOf("{['draft','sent','paid','overdue','void'].map(s=><option") === -1, 'the invoice editor can no longer set status "void" (cancel is the only way)');
    ok(SRC.indexOf('data-testid="invoice-cancelled-banner"') !== -1, 'the View screen has a cancellation banner');
    ok(SRC.indexOf("const cancelledInvItems = myAccInvoices.filter(i=>i && i.status==='void')") !== -1 && SRC.indexOf("const cancelledAccInvoices = accInvoices.filter(i=>i && i.status==='void')") !== -1, 'both lists still build their greyed cancelled rows from every void record');
  }

  console.log('\n' + (failures ? ('FAILED: ' + failures + '   PASSED: ' + passed) : ('ALL ' + passed + ' CHECKS PASSED')));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
