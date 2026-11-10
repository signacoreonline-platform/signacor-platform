#!/usr/bin/env node
/* ============================================================================
 * dashboard-metrics.test.js
 * Signacore — regression suite for the 2026-11-10 DASHBOARD repair.
 * ============================================================================
 *
 * THE DEFECTS
 *   1. Salesman of the Month dated jobs with inCurrentMonth(j.id). A job made
 *      on the server has an ordinary PK id (SNS-00236 is 448 → 1 Jan 1970), so
 *      every post-cutover job was silently dropped.
 *   2. "Outstanding" added the FULL amount of every invoice not marked paid,
 *      including drafts, ignoring part payments and open credit.
 *   3. Monthly Revenue / the 6-month chart counted stage-7+ jobs with no
 *      invoice, and fell back to j.id as an invoice date.
 *   4. "Recent Jobs" listed every quote.
 *
 * Every function is LIFTED OUT OF index.html (SGR-CANONICAL-CENTS and
 * SGR-DASHBOARD-METRICS sentinels plus the named resolvers), not
 * re-implemented, so this suite cannot drift from shipped behaviour.
 *
 * ZERO DEPENDENCIES — plain Node, no database.
 *   node test/dashboard-metrics.test.js
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');

const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH ||
  path.resolve(__dirname, '..', '..', 'index.html');
const READ_TS_PATH = path.resolve(__dirname, '..', 'src', 'relational', 'read.ts');

let failures = 0, passed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failures++; console.log('  ✗ ' + label + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}
function eq(actual, expected, label) { ok(actual === expected, label + ' (= ' + JSON.stringify(expected) + ')', { actual }); }
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
  const win = src.slice(start, start + 60000);
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

const CENTS_SRC = sentinelBlock(SRC, 'BEGIN SGR-CANONICAL-CENTS', '/* END SGR-CANONICAL-CENTS */');
const DASH_SRC  = sentinelBlock(SRC, 'BEGIN SGR-DASHBOARD-METRICS', '/* END SGR-DASHBOARD-METRICS */');

const RESOLVERS = [
  'isGenuineZeroAmount',
  'isHoldingsUser', 'isHoldingsRecord', 'belongsToUserCompany',
  'companyTagOf', 'sameCompany', 'jobHasId', 'resolveJobsForQuote', 'resolveJobForQuote',
  'resolveQuoteForJob', 'resolveQuoteForInvoice',
  'invoiceIdentityKey', 'invoiceBelongsToJob', 'resolveJobInvoiceRecord',
  'sgrReportPaymentKey', 'sgrReportPaymentDate', 'sgrReportChainPayments',
  'sgrReportLastPaid', 'sgrReportPaymentDocument', 'sgrPaymentsReportModelScoped', 'sgrPaymentsReportModel',
];
const EXPORTS = RESOLVERS.concat([
  'sgrJhbDateKey', 'sgrJhbMonthKey', 'sgrJhbNowMonthKey', 'sgrMonthKeyShift',
  'sgrLegacyIdTimestampMs', 'sgrJobCreatedMs', 'sgrSalespersonKey', 'sgrSalesmanOfMonth',
  'sgrDashboardInvoiceRows', 'sgrDashboardRevenue', 'sgrDashboardOutstanding', 'sgrDashboardFinancials',
  'sgrRecentJobs', 'sgrToCents0', 'sgrRands',
]);
const pieces = ['"use strict";',
  extractConst(SRC, MASKED, 'UNIONTECH_ID'),
  extractConst(SRC, MASKED, 'HOLDINGS_CO_ID'),
  extractConst(SRC, MASKED, 'HOLDINGS_CO_KEY'),
  CENTS_SRC, DASH_SRC];
for (const f of RESOLVERS) pieces.push(extractFunction(SRC, f));
pieces.push('return {' + EXPORTS.join(',') + '};');
let A;
try { A = new Function(pieces.join('\n'))(); }
catch (e) { console.error('Could not evaluate lifted functions: ' + e.message); process.exit(1); }

/* ── fixtures ───────────────────────────────────────────────────────────── */
const SIG = { role: 'admin', email: 'a@x', co: 2 };     // original-company user
const HOL = { role: 'admin', email: 'h@x', co: 1 };     // Holdings user
const NOV = '2026-11';
function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const ms = s => Date.parse(s);
const line = amt => ({ description: 'x', qty: 1, unitAmount: amt, taxType: '15%' });
let seq = 5000;
const pay = (owner, amount, date, extra) => { seq++; return Object.assign({ id: 'p' + seq, _relPaymentId: seq, _relOwnerType: owner, amount, date }, extra || {}); };
const scope = (arr, user) => arr.filter(r => A.belongsToUserCompany(r, user));

/* ═════════════════════════════════════════════════════════════════════════ */
section('1. Africa/Johannesburg dates — calendar dates as written, instants shifted +02:00');
{
  eq(A.sgrJhbDateKey('2026-11-01'), '2026-11-01', 'a calendar date is never shifted');
  eq(A.sgrJhbDateKey('2026-10-31T22:30:00.000Z'), '2026-11-01', '22:30 UTC on 31 Oct is 00:30 on 1 Nov in Johannesburg');
  eq(A.sgrJhbDateKey('2026-10-31T21:59:59.000Z'), '2026-10-31', '21:59:59 UTC on 31 Oct is still 31 Oct');
  eq(A.sgrJhbDateKey('2026-11-30T22:00:00.000Z'), '2026-12-01', '22:00 UTC on 30 Nov is already December');
  eq(A.sgrJhbMonthKey(ms('2026-11-30T21:59:59.999Z')), '2026-11', 'last Johannesburg millisecond of November');
  eq(A.sgrJhbDateKey('2026-02-30'), null, 'an impossible calendar date is rejected');
  eq(A.sgrJhbDateKey(null), null, 'null → null');
  eq(A.sgrJhbDateKey(''), null, 'empty → null');
  eq(A.sgrJhbDateKey('not a date'), null, 'garbage → null');
  eq(A.sgrJhbNowMonthKey(ms('2026-11-10T10:00:00Z')), NOV, 'now → 2026-11');
  eq(A.sgrMonthKeyShift('2026-11', -5), '2026-06', 'six-month window start');
  eq(A.sgrMonthKeyShift('2026-11', 2), '2027-01', 'year rollover');
}

section('2. A relational row id is never a date — legacy timestamp ids are');
{
  eq(A.sgrLegacyIdTimestampMs(448), null, 'PK 448 (SNS-00236) is not a timestamp');
  eq(A.sgrLegacyIdTimestampMs('448'), null, 'string PK "448" is not a timestamp');
  eq(A.sgrLegacyIdTimestampMs(1775811628870), 1775811628870, 'JSON-era numeric id is a timestamp');
  eq(A.sgrLegacyIdTimestampMs('1775811628870'), 1775811628870, 'JSON-era id restored as a string is a timestamp');
  eq(A.sgrLegacyIdTimestampMs(1775811628870.42), 1775811628870, 'Date.now()+Math.random() id floors');
  eq(A.sgrLegacyIdTimestampMs('job-1'), null, 'non-numeric id → null');
  eq(A.sgrLegacyIdTimestampMs(0), null, '0 → null');
  const backfilled = { id: ms('2026-07-14T09:00:00Z'), createdAt: '2026-08-20T16:00:00.000Z' };
  eq(A.sgrJobCreatedMs(backfilled), ms('2026-07-14T09:00:00Z'), 'backfilled job: legacy timestamp id beats created_at (import date)');
  eq(A.sgrJobCreatedMs({ id: 448, createdAt: '2026-11-09T07:00:00.000Z' }), ms('2026-11-09T07:00:00Z'), 'server job: created_at is used');
  eq(A.sgrJobCreatedMs({ id: '448', createdAt: '2026-11-09T07:00:00.000Z' }), ms('2026-11-09T07:00:00Z'), 'server job with a string id: created_at is used');
  eq(A.sgrJobCreatedMs({ id: 448 }), null, 'server job without createdAt → null, never 1970');
  eq(A.sgrJobCreatedMs({ id: 448, createdAt: 'garbage' }), null, 'unparseable createdAt → null');
}

/* ── one shared synthetic world, both companies ─────────────────────────── */
const dep304 = pay('quote', 920, '2026-11-03');                       // 80% deposit on SQ-00304
const Q304 = { id: 'q304', _relId: 304, num: 'SQ-00304', co: 2, client: "Hennie's Moreleta", convertedJobId: 448, status: 'converted', payments: [dep304] };
const JOBS = [
  // SNS-00236: created on the server (PK id), the INV-00223 replacement chain
  { id: 448, _relId: 448, num: 'SNS-00236', co: 2, client: "Hennie's Moreleta", salesperson: 'Ockert Smit', value: 1150,
    quoteNum: 'SQ-00304', invoiceNum: 'INV-00223', invoiceRelId: 200, invoiceDate: '2026-11-09', stage: 8, status: 'installation',
    createdAt: '2026-11-09T07:00:00.000Z', payments: [] },
  // JSON-era job-only invoice (no accounting record) — legacy timestamp id
  { id: ms('2026-11-03T08:00:00Z'), num: 'SNS-00100', co: 2, client: 'Legacy Co', salesperson: 'Reinhart Smit', value: 575,
    invoiceNum: 'INV-00150', invoiceDate: '2026-11-02', stage: 9, status: 'invoiced', payments: [] },
  // invoice represented BOTH as a job invoice and as an accounting record
  { id: ms('2026-11-04T08:00:00Z'), num: 'SNS-00101', co: 2, client: 'Twin Co', salesperson: ' ockert  smit ', value: 1150,
    invoiceNum: 'INV-00151', invoiceDate: '2026-11-04', stage: 9, status: 'invoiced', payments: [] },
  // stage-only: installed, NO invoice number — must contribute nothing
  { id: 450, _relId: 450, num: 'SNS-00238', co: 2, client: 'Stage Only', salesperson: null, value: 999, stage: 8, status: 'installation',
    createdAt: '2026-11-08T10:00:00.000Z', payments: [] },
  // backfilled (legacy id in August), imported "in November" — must be August
  { id: ms('2026-08-10T08:00:00Z'), num: 'SNS-00050', co: 2, client: 'Backfill', salesperson: 'Janique Bettini', value: 100,
    createdAt: '2026-11-01T06:00:00.000Z', stage: 4, status: 'quote_approved', payments: [] },
  // Johannesburg boundaries
  { id: 452, num: 'SNS-00242', co: 2, client: 'Edge In', salesperson: 'janique bettini', value: 200,
    createdAt: '2026-10-31T22:30:00.000Z', stage: 4, status: 'quote_approved', payments: [] },
  { id: 453, num: 'SNS-00243', co: 2, client: 'Edge Out', salesperson: 'Janique Bettini', value: 200,
    createdAt: '2026-11-30T22:30:00.000Z', stage: 4, status: 'quote_approved', payments: [] },
  // the known August 20–24 conversion gap: server job, salesperson lost
  { id: 300, num: 'SNS-00180', co: 2, client: 'Aug Gap', salesperson: null, value: 300,
    createdAt: '2026-08-22T10:00:00.000Z', quoteNum: 'SQ-00200', stage: 5, status: 'deposit_received', payments: [] },
  // undated jobs (no legacy id, no createdAt) and one beyond the top-10
  { id: 454, num: 'SNS-00240', co: 2, client: 'Undated A', salesperson: 'Ockert Smit', value: 10, stage: 1, status: 'lead', payments: [] },
  { id: 455, num: 'SNS-00241', co: 2, client: 'Undated B', salesperson: 'Ockert Smit', value: 10, stage: 1, status: 'lead', payments: [] },
  { id: 456, num: 'SNS-00199', co: 2, client: 'Undated C', salesperson: 'Ockert Smit', value: 10, stage: 1, status: 'lead', payments: [] },
  // Holdings
  { id: 451, num: 'SNS-00239', co: 1, client: 'Holdings Client', salesperson: 'Janique Bettini', value: 2300,
    createdAt: '2026-11-07T09:00:00.000Z', stage: 4, status: 'quote_approved', payments: [] },
];
const INVS = [
  // INV-00223 — the active replacement, 80% deposit received through the quote
  { id: 200, _relId: 200, number: 'INV-00223', co: 2, contactName: "Hennie's Moreleta", reference: 'SNS-00236', jobNum: 'SNS-00236',
    date: '2026-11-09', status: 'partial', lineItems: [line(1000)], payments: [{ ...dep304 }] },
  // INV-00219 — cancelled by admin (void, R0.00, no job link)
  { id: 201, _relId: 201, number: 'INV-00219', co: 2, contactName: "Hennie's Moreleta",
    reference: 'Cancelled by Admin — replaced by INV-00223', date: '2026-11-09', status: 'void',
    lineItems: [{ description: 'CANCELLED BY ADMIN', qty: 1, unitAmount: 0, taxType: '15%' }], payments: [] },
  // a void with real money on it — proves void is excluded, not merely R0.00
  { id: 202, number: 'INV-09999', co: 2, contactName: 'Void Co', date: '2026-11-05', status: 'void', lineItems: [line(5000)], payments: [] },
  // twin of SNS-00101 — paid in full
  { id: 151, number: 'INV-00151', co: 2, contactName: 'Twin Co', reference: 'SNS-00101', jobNum: 'SNS-00101',
    date: '2026-11-04', status: 'paid', lineItems: [line(1000)], payments: [pay('invoice', 1150, '2026-11-06')] },
  // draft — not issued
  { id: 160, number: 'INV-00160', co: 2, contactName: 'Draft Co', date: '2026-11-06', status: 'draft', lineItems: [line(500)], payments: [] },
  // credit applied as a 'Credit' payment (and recorded as used on the note)
  { id: 170, number: 'INV-00170', co: 2, contactName: 'Acme', date: '2026-11-05', status: 'partial', lineItems: [line(200)],
    payments: [pay('invoice', 100, '2026-11-06', { method: 'Credit', notes: 'Auto-applied from CN-0001' })] },
  // issued but undated — its id looks like a timestamp and must NOT be used
  { id: ms('2026-11-03T00:00:00Z'), number: 'INV-00180', co: 2, contactName: 'No Date', date: null, status: 'sent', lineItems: [line(100)], payments: [] },
  // October, paid in full
  { id: 140, number: 'INV-00140', co: 2, contactName: 'Oct Co', date: '2026-10-15', status: 'paid', lineItems: [line(2000)],
    payments: [pay('invoice', 2300, '2026-10-20')] },
  // dated on the first of the month
  { id: 190, number: 'INV-00190', co: 2, contactName: 'First Co', date: '2026-11-01', status: 'sent', lineItems: [line(10)], payments: [] },
  // Holdings: same per-company number space, part-paid
  { id: 10, number: 'INV-00010', co: 1, contactName: 'Holdings Client', date: '2026-11-07', status: 'partial', lineItems: [line(2000)],
    payments: [pay('invoice', 1000, '2026-11-08')] },
];
const CNS = [
  { id: 'cn1', number: 'CN-0001', type: 'customer', co: 2, contactName: 'Acme', amount: 300, used: 100 },
  { id: 'cn2', number: 'CN-0002', type: 'supplier', co: 2, contactName: 'Supplier', amount: 999, used: 0 },
  { id: 'cn3', number: 'CN-0003', type: 'customer', co: 2, contactName: 'Spent', amount: 50, used: 50 },
  { id: 'cn4', number: 'CN-0004', type: 'customer', co: 1, contactName: 'Holdings Client', amount: 50, used: 0 },
];
const QUOTES = [Q304];
deepFreeze(JOBS); deepFreeze(INVS); deepFreeze(CNS); deepFreeze(QUOTES);
const snapshot = JSON.stringify([JOBS, INVS, CNS, QUOTES]);
const finFor = user => A.sgrDashboardFinancials(scope(JOBS, user), scope(QUOTES, user), scope(INVS, user), scope(CNS, user));

section('3. Salesman of the Month — server jobs counted, names grouped, unassigned separate');
{
  const sp = A.sgrSalesmanOfMonth(scope(JOBS, SIG), NOV);
  const winner = sp.winner || {};
  eq(winner.name, 'Ockert Smit', 'winner (Title Cased display name kept)');
  eq(winner.count, 2, 'Ockert: SNS-00236 (PK 448) + SNS-00101 (" ockert  smit ")');
  eq(winner.valueC, 230000, 'Ockert value R2,300.00');
  const byName = Object.fromEntries(sp.ranked.map(r => [r.name, r.count]));
  eq(byName['Reinhart Smit'], 1, 'Reinhart: legacy timestamp-id job');
  eq(byName['janique bettini'], 1, 'Janique: only the 00:30 1-Nov boundary job (lower-case is the only spelling used)');
  eq(sp.ranked.length, 3, 'three ranked people');
  eq(sp.unassigned.count, 1, 'one unassigned job (SNS-00238) shown separately');
  ok(!sp.ranked.some(r => r.key === ''), 'unassigned never enters the ranking');
  eq(sp.undated, 3, 'three undated jobs reported, not guessed');
  ok(!sp.ranked.some(r => r.name === 'Janique Bettini'), 'backfilled August job and the 30-Nov 22:30 UTC (December) job excluded');
  const hol = A.sgrSalesmanOfMonth(scope(JOBS, HOL), NOV);
  eq(hol.winner && hol.winner.name, 'Janique Bettini', 'Holdings winner');
  eq(hol.winner && hol.winner.count, 1, 'Holdings count');
  ok(!hol.ranked.some(r => r.key === 'ockert smit'), 'Holdings never sees original-company jobs');
  const tie = A.sgrSalesmanOfMonth([
    { id: 1, createdAt: '2026-11-02T08:00:00Z', salesperson: 'B Person', value: 100 },
    { id: 2, createdAt: '2026-11-02T08:00:00Z', salesperson: 'A Person', value: 100 },
  ], NOV);
  eq(tie.winner.name, 'A Person', 'equal count and value → name order, stable');
  const byCount = A.sgrSalesmanOfMonth([
    { id: 1, createdAt: '2026-11-02T08:00:00Z', salesperson: 'Big Deal', value: 100000 },
    { id: 2, createdAt: '2026-11-02T08:00:00Z', salesperson: 'Busy', value: 10 },
    { id: 3, createdAt: '2026-11-03T08:00:00Z', salesperson: 'busy', value: 10 },
  ], NOV);
  eq(byCount.winner.name, 'Busy', 'ranked by job COUNT, not value');
  eq(byCount.winner.count, 2, '"Busy" and "busy" grouped');
  const variants = A.sgrSalesmanOfMonth([
    { id: 1, createdAt: '2026-11-02T08:00:00Z', salesperson: 'ockert smit', value: 1 },
    { id: 2, createdAt: '2026-11-02T08:00:00Z', salesperson: 'ockert smit', value: 1 },
    { id: 3, createdAt: '2026-11-03T08:00:00Z', salesperson: 'Ockert Smit', value: 1 },
  ], NOV);
  eq(variants.winner.name, 'Ockert Smit', 'readable Title Cased spelling shown even when outnumbered');
  const none = A.sgrSalesmanOfMonth([{ id: 9, createdAt: '2026-11-02T08:00:00Z', salesperson: '  ', value: 5 }], NOV);
  ok(none.winner === null && none.unassigned.count === 1, 'only unassigned jobs → no winner, unassigned reported');
  const gap = scope(JOBS, SIG).filter(j => !A.sgrSalespersonKey(j.salesperson) && j.id === 300);
  eq(A.sgrJhbMonthKey(A.sgrJobCreatedMs(gap[0])), '2026-08', 'August-gap job dates to August — never moved into another month');
  eq(gap[0].salesperson, null, 'August-gap assignment left untouched (not back-filled from the quote)');
}

section('4. Revenue — issued invoices once, by Johannesburg issue month');
{
  const sig = finFor(SIG), hol = finFor(HOL);
  // 223: 1150.00 · 150 (job-only): 575.00 · 151 (twin): 1150.00 · 170: 230.00 · 190: 11.50
  eq(sig.revenue.byMonthC[NOV], 311650, 'original company November R3,116.50');
  eq(sig.revenue.byMonthC['2026-10'], 230000, 'original company October R2,300.00');
  eq(sig.revenue.undated.count, 1, 'INV-00180 undated, not placed in any month');
  eq(sig.revenue.undated.cents, 11500, 'undated amount R115.00 reported separately');
  ok(!Object.keys(sig.revenue.byMonthC).some(k => k < '2000'), 'no 1970 bucket — no row id read as a date');
  eq(hol.revenue.byMonthC[NOV], 230000, 'Holdings November R2,300.00');
  const nums = sig.rows.map(r => r.number).sort();
  eq(nums.filter(n => n === 'INV-00223').length, 1, 'INV-00223 has exactly one canonical row');
  eq(nums.filter(n => n === 'INV-00151').length, 1, 'INV-00151 (job + accounting record) has exactly one row');
  ok(!nums.includes('INV-00219') && !nums.includes('INV-09999'), 'void invoices have no row');
  ok(!sig.rows.some(r => r.number === undefined || r.number === null), 'stage-only job SNS-00238 has no row');
  const r223 = sig.rows.find(r => r.number === 'INV-00223');
  eq(r223.payableC, 115000, 'INV-00223 payable from its own issued lines');
  const draft = sig.rows.find(r => r.number === 'INV-00160');
  ok(!draft || draft.isDraft, 'draft is flagged (or absent) and never counted');
}

section('5. Outstanding — remaining balance, payments/credits once, drafts/voids out');
{
  const sig = finFor(SIG), hol = finFor(HOL);
  const o = sig.outstanding;
  // 223: 230.00 · 150: 575.00 · 170: 130.00 · 180: 115.00 · 190: 11.50 · 151/140: 0
  eq(o.grossC, 106150, 'gross remaining R1,061.50');
  eq(o.openCreditC, 20000, 'open customer credit R200.00 (300 − 100 used; supplier and spent notes ignored)');
  eq(o.netC, 86150, 'net outstanding R861.50');
  eq(o.openInvoices, 5, 'five invoices with a balance');
  const r223 = sig.rows.find(r => r.number === 'INV-00223');
  eq(r223.paidC, 92000, 'INV-00223 deposit counted ONCE although it sits on the quote and on the invoice');
  eq(r223.outstandingC, 23000, 'part-paid INV-00223 contributes only its R230.00 balance');
  eq(sig.rows.find(r => r.number === 'INV-00170').outstandingC, 13000, 'applied credit reduces the invoice once (R230.00 − R100.00)');
  eq(hol.outstanding.netC, 125000, 'Holdings: R1,300.00 remaining − R50.00 credit');
  const oldWay = scope(INVS, SIG).filter(i => i.status !== 'paid' && i.status !== 'void')
    .reduce((s, i) => s + i.lineItems.reduce((t, l) => t + l.unitAmount * 1.15, 0), 0);
  ok(Math.round(oldWay * 100) > o.netC, 'the old full-amount rule overstated it (' + oldWay.toFixed(2) + ' > ' + (o.netC / 100).toFixed(2) + ')');
}

section('6. INV-00219 contributes nothing; INV-00223 counts once');
{
  const sig = finFor(SIG);
  const without219 = A.sgrDashboardFinancials(scope(JOBS, SIG), scope(QUOTES, SIG), scope(INVS, SIG).filter(i => i.number !== 'INV-00219'), scope(CNS, SIG));
  eq(sig.revenue.byMonthC[NOV], without219.revenue.byMonthC[NOV], 'revenue identical with or without INV-00219');
  eq(sig.outstanding.netC, without219.outstanding.netC, 'outstanding identical with or without INV-00219');
  const nonVoid219 = scope(INVS, SIG).map(i => i.number === 'INV-00219' ? { ...i, status: 'sent', lineItems: [line(1000)] } : i);
  const leak = A.sgrDashboardFinancials(scope(JOBS, SIG), scope(QUOTES, SIG), nonVoid219, scope(CNS, SIG));
  ok(leak.revenue.byMonthC[NOV] !== sig.revenue.byMonthC[NOV], 'control: the same row NOT void would change the figures');
  const withoutJob = A.sgrDashboardFinancials(scope(JOBS, SIG).filter(j => j.num !== 'SNS-00236'), scope(QUOTES, SIG), scope(INVS, SIG), scope(CNS, SIG));
  eq(withoutJob.revenue.byMonthC[NOV], sig.revenue.byMonthC[NOV], 'INV-00223 counted once whether or not its job is loaded');
}

section('7. Recent Jobs — 10 newest by resolved creation date, deterministic');
{
  const list = A.sgrRecentJobs(scope(JOBS, SIG), 10).map(x => x.job.num);
  const expected = ['SNS-00243', 'SNS-00236', 'SNS-00238', 'SNS-00101', 'SNS-00100', 'SNS-00242', 'SNS-00180', 'SNS-00050', 'SNS-00241', 'SNS-00240'];
  eq(JSON.stringify(list), JSON.stringify(expected), 'order');
  ok(!list.includes('SNS-00199'), 'eleventh job cut by the limit');
  ok(!list.includes('SNS-00239'), 'Holdings job not in the original-company list');
  const shuffled = scope(JOBS, SIG).slice().reverse();
  eq(JSON.stringify(A.sgrRecentJobs(shuffled, 10).map(x => x.job.num)), JSON.stringify(expected), 'same order whatever the input order');
  eq(JSON.stringify(A.sgrRecentJobs(scope(JOBS, HOL), 10).map(x => x.job.num)), JSON.stringify(['SNS-00239']), 'Holdings list');
}

section('8. Purity — nothing is mutated');
{
  eq(JSON.stringify([JOBS, INVS, CNS, QUOTES]), snapshot, 'inputs byte-identical after every call');
}

section('9. Source shape — the shipped Dashboard reads only the shared models');
{
  const dashStart = SRC.indexOf('\nfunction DashboardPage(');
  const dashEnd = SRC.indexOf('\nfunction JobDetail(', dashStart);
  const DASH = SRC.slice(dashStart, dashEnd);
  const DASH_CODE = MASKED.slice(dashStart, dashEnd);           // comments/strings blanked
  const chart = extractFunction(SRC, 'RevenueChart');
  ok(!/inCurrentMonth\(\s*j\.id\s*\)/.test(DASH_CODE), 'no inCurrentMonth(j.id) in code');
  ok(!/\|\|\s*j\.id\s*\)/.test(DASH_CODE) && !/new Date\(\s*j\.id\s*\)/.test(DASH_CODE + chart), 'no row id used as a date fallback');
  ok(/sgrSalesmanOfMonth\(visibleJobs/.test(DASH), 'Salesman card uses sgrSalesmanOfMonth');
  ok(/sgrDashboardFinancials\(visibleJobs, visibleQuotes, visibleAccInvoices, visibleCreditNotes\)/.test(DASH), 'one financial model, company-scoped inputs');
  ok(/_revByMonthC\[_curMonthKey\]/.test(DASH) && /<RevenueChart revenueByMonthC=\{_revByMonthC\}/.test(DASH), 'card and chart read the same revenue result');
  ok(!/j\.stage\)\s*\|\|\s*j\.invoiceNum/.test(DASH + chart), 'no stage-only revenue rule left');
  ok(/sgrRecentJobs\(visibleJobs, 10\)/.test(DASH) && !/numSort\(visibleQuotes/.test(DASH), 'Recent Jobs lists jobs, not quotes');
  ok(/visibleCreditNotes = \(creditNotes\|\|\[\]\)\.filter\(c=>belongsToUserCompany\(c,user\)\)/.test(DASH), 'credit notes company-scoped');
  ok(/<DashboardPage[^\n]*creditNotes=\{creditNotes\}/.test(SRC), 'App passes creditNotes to the Dashboard');
  const summary = extractFunction(SRC, 'getBusinessSummary');
  ok(/sgrDashboardOutstanding\(sgrDashboardInvoiceRows\(jobs, quotes, accInvoices\), creditNotes\)/.test(summary), 'shared panel Outstanding uses the same model');
  ok(!/i\.status!=='paid'\)\.reduce\(\(s,i\)=>s\+\(i\.amount/.test(summary), 'old full-amount Outstanding rule removed');
  const panels = SRC.match(/<ConsistencyPanel [^\n]*\/>/g) || [];
  eq(panels.length, 3, 'three ConsistencyPanel call sites');
  ok(panels.every(p => /creditNotes=\{/.test(p)), 'every panel call site passes credit notes');
  ok(/quotes=\{\(quotes\|\|\[\]\)\.filter\(q=>belongsToUserCompany\(q,user\)\)\}/.test(panels.join('\n')), 'Accounting panel quotes are company-scoped');
  const model = extractFunction(SRC, 'sgrPaymentsReportModel');
  ok(/return sgrPaymentsReportModelScoped\(/.test(model), 'Reports model is the scoped core behind the same filters');
}

section('10. read.ts — jobs carry createdAt from rel_jobs.created_at');
{
  const readTs = fs.readFileSync(READ_TS_PATH, 'utf8');
  const jobsFn = readTs.slice(readTs.indexOf('export async function buildJobsJson'), readTs.indexOf('export async function buildInvoicesJson'));
  ok(/createdAt: r\.created_at \? new Date\(r\.created_at\)\.toISOString\(\) : null,/.test(jobsFn), 'buildJobsJson emits createdAt');
  ok((readTs.match(/createdAt: r\.created_at/g) || []).length === 1, 'added to the jobs read only');
}

console.log('\n' + (failures === 0 ? 'ALL ' + passed + ' CHECKS PASSED' : 'PASSED: ' + passed + '   FAILED: ' + failures));
process.exit(failures === 0 ? 0 : 1);
