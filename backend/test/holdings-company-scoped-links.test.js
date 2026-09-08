#!/usr/bin/env node
/* ============================================================================
 * holdings-company-scoped-links.test.js
 * Signacore — focused regression suite for the 2026-09-08 company-safe
 * transaction-link repair.
 * ============================================================================
 *
 * WHAT THIS PROVES
 *   Quote numbers (SQ-) and invoice numbers (INV-) are minted PER COMPANY by
 *   backend/src/routes/documentNumbers.ts, so the same number legitimately
 *   exists in Holdings (co 1) and in the original company (co 2). Job numbers
 *   (SNS-) are global. The frontend used to resolve a job's source quote with
 *   an unscoped `quotes.find(q => q.num === job.quoteNum)` over the FULL
 *   multi-company array, so a Holdings job routinely resolved another
 *   company's quote — and, through reconcileJobInvoice, absorbed that quote's
 *   payments into its own paid total and invoice status.
 *
 *   Every test below is driven by the REAL functions lifted out of
 *   index.html — not a re-implementation — so it cannot drift from shipped
 *   behaviour. Array order is deliberately reversed in the ordering tests,
 *   because array order is exactly what the old `.find()` depended on.
 *
 * ZERO DEPENDENCIES — plain Node, no ts-node, no babel, no database.
 *   node test/holdings-company-scoped-links.test.js
 *   INDEX_HTML_PATH=/some/other/index.html node test/holdings-company-scoped-links.test.js
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

/* ── lift the real functions out of index.html ───────────────────────────── */

// Mask comments and quoted/template strings with spaces so brace counting is
// exact, while keeping the original offsets so we can slice the real source.
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

// Anchored on a TOP-LEVEL declaration (newline + `function` at column 0), so a
// mention of the name inside a comment can never be mistaken for the definition.
// Masking is applied only to a local window around the declaration, because
// masking the whole 27k-line file would have to model regex literals too.
function extractFunction(src, masked, name) {
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
    else if (wm[i] === '}') {
      depth--;
      if (depth === 0) return win.slice(0, i + 1);
    }
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
  'companyTagOf', 'sameCompany', 'jobHasId',
  'resolveJobsForQuote', 'resolveJobForQuote',
  'resolveQuoteForJob', 'resolveQuoteForInvoice',
  'findSourceQuoteForJob', 'reconcileJobInvoice', 'getQuoteInvoice',
  'isHoldingsRecord',
];
const pieces = [extractConst(SRC, MASKED, 'HOLDINGS_CO_ID'), extractConst(SRC, MASKED, 'HOLDINGS_CO_KEY')];
for (const f of WANTED_FNS) pieces.push(extractFunction(SRC, MASKED, f));
pieces.push('return {' + WANTED_FNS.join(',') + ', HOLDINGS_CO_ID};');

let A;
try { A = new Function(pieces.join('\n'))(); }
catch (e) { console.error('Could not evaluate the lifted functions: ' + e.message); process.exit(1); }

/* ── fixtures: two companies, deliberately duplicated quote numbers ─────── */
const HOLD = 1, OTHER = 2;

function mk() {
  const holdQuote = { id: 101, num: 'SQ-00050', co: HOLD, client: 'Holdings Client', convertedJobId: 201, payments: [], lines: [] };
  const otherQuote = { id: 102, num: 'SQ-00050', co: OTHER, client: 'Other Client', convertedJobId: 202, payments: [{ id: 'pay-other-1', amount: 5000 }], lines: [] };
  const holdJob = { id: 201, num: 'SNS-00901', co: HOLD, quoteNum: 'SQ-00050', client: 'Holdings Client', value: 10000, payments: [], stage: 4 };
  const otherJob = { id: 202, num: 'SNS-00902', co: OTHER, quoteNum: 'SQ-00050', client: 'Other Client', value: 10000, payments: [], stage: 4 };
  return { holdQuote, otherQuote, holdJob, otherJob };
}
// The live-audit shape: a Holdings job whose legacy quote number exists ONLY
// under company 2 (the 17 historical SNS-000xx records).
function mkOrphan() {
  const otherQuote = { id: 302, num: 'SQ-00060', co: OTHER, client: 'Other Client', convertedJobId: null, payments: [{ id: 'pay-other-2', amount: 5000 }], lines: [] };
  const holdJob = { id: 301, num: 'SNS-00040', co: HOLD, quoteNum: 'SQ-00060', client: 'Holdings Client', value: 10000, payments: [], stage: 4 };
  return { otherQuote, holdJob };
}
const clone = (v) => JSON.parse(JSON.stringify(v));

/* ═══════════════════════════════════════════════════════════════════════ */
section('1. COMPANY MATCHING RULE');
{
  ok(A.sameCompany({ co: 1 }, { co: '1' }) === true, 'co 1 and co "1" are the same logical company (numeric/string drift)');
  ok(A.sameCompany({ co: 1 }, { co: 2 }) === false, 'Holdings (1) never matches company 2');
  ok(A.sameCompany({ co: 1 }, {}) === false, 'Holdings never matches an untagged legacy record');
  ok(A.sameCompany({}, { co: 1 }) === false, 'an untagged legacy record never matches Holdings');
  ok(A.sameCompany({ co: 2 }, {}) === true, 'company 2 still matches an untagged pre-Holdings record (legacy links preserved)');
  ok(A.sameCompany({}, {}) === true, 'two untagged legacy records still match each other');
  ok(A.sameCompany({ co: 2 }, { co: 4 }) === false, 'two different tagged companies never match');
  ok(A.sameCompany({ co: 2 }, { co: '2' }) === true, 'company 2 numeric/string drift matches');
  ok(A.sameCompany(null, { co: 1 }) === false, 'a null record never matches anything');
}

section('2. JOB → SOURCE QUOTE — the 17 historical Holdings jobs');
{
  const { otherQuote, holdJob } = mkOrphan();
  const quotes = [otherQuote];
  ok(A.findSourceQuoteForJob(holdJob, quotes) === null,
    'Holdings job SNS-00040 (quoteNum SQ-00060, no Holdings quote with that number) resolves NO source quote');
  ok(A.findSourceQuoteForJob(holdJob, quotes) !== otherQuote,
    'it never resolves the company-2 quote that shares the number');
  ok(A.resolveQuoteForJob(holdJob, [...quotes].reverse()) === null,
    'still NO source quote with the array reversed');
}

section('3. JOB → SOURCE QUOTE — both companies hold the same quote number');
{
  const { holdQuote, otherQuote, holdJob, otherJob } = mk();
  const forward = [otherQuote, holdQuote];   // other company FIRST (the real-world order)
  const reverse = [holdQuote, otherQuote];
  ok(A.findSourceQuoteForJob(holdJob, forward) === holdQuote,
    'Holdings job resolves the HOLDINGS quote even when the company-2 quote comes first');
  ok(A.findSourceQuoteForJob(holdJob, reverse) === holdQuote,
    'same result with the array reversed — order-independent');
  ok(A.findSourceQuoteForJob(otherJob, forward) === otherQuote,
    'company-2 job resolves the company-2 quote (unchanged behaviour)');
  ok(A.findSourceQuoteForJob(otherJob, reverse) === otherQuote,
    'company-2 job is order-independent too');
}

section('4. STABLE-ID-FIRST — quote → job');
{
  const { holdQuote, holdJob, otherJob } = mk();
  const forward = [otherJob, holdJob];
  const reverse = [holdJob, otherJob];
  ok(A.resolveJobForQuote(holdQuote, forward) === holdJob,
    'quote.convertedJobId picks Job A even though company-2 Job B matches by quote number');
  ok(A.resolveJobForQuote(holdQuote, reverse) === holdJob, 'order-independent');
  ok(A.resolveJobsForQuote(holdQuote, forward).length === 1,
    'exactly one job is considered — Job B is never in the candidate set');
  ok(A.resolveJobsForQuote(holdQuote, forward).indexOf(otherJob) === -1,
    'the company-2 job is never returned');

  // stable id present but pointing at another company's job: never fall back
  const crossQuote = { id: 111, num: 'SQ-00050', co: HOLD, convertedJobId: 202 };
  ok(A.resolveJobForQuote(crossQuote, forward) === null,
    'a convertedJobId pointing at another company\'s job resolves to NOTHING (no OR-fallback to the number)');

  // no stable id: same-company number fallback only
  const legacyQuote = { id: 112, num: 'SQ-00050', co: HOLD, convertedJobId: null };
  ok(A.resolveJobForQuote(legacyQuote, forward) === holdJob,
    'with no convertedJobId, the legacy fallback finds the SAME-COMPANY job');
  ok(A.resolveJobForQuote(legacyQuote, reverse) === holdJob, 'legacy fallback is order-independent');
  const legacyNoMatch = { id: 113, num: 'SQ-00099', co: HOLD, convertedJobId: null };
  ok(A.resolveJobForQuote(legacyNoMatch, forward) === null,
    'legacy fallback with no same-company match resolves to NOTHING');
}

section('5. PAYMENT CONTAMINATION');
{
  const { otherQuote, holdJob } = mkOrphan();
  const rec = A.reconcileJobInvoice(holdJob, [otherQuote]);
  ok(rec.totalPaid === 0, 'Holdings job takes R0 from the company-2 quote (was R5,000)', rec.totalPaid);
  ok(rec.payments.length === 0, 'no company-2 payment rows are merged in', rec.payments);
  ok(rec.invoiceStatus === 'pending', 'invoice status is not inflated by the other company\'s payment', rec.invoiceStatus);

  const { holdQuote, otherQuote: oq2, holdJob: hj2 } = mk();
  holdQuote.payments = [{ id: 'pay-hold-1', amount: 2500 }];
  const rec2 = A.reconcileJobInvoice(hj2, [oq2, holdQuote]);
  ok(rec2.totalPaid === 2500, 'the Holdings job DOES still take its own Holdings quote\'s payment', rec2.totalPaid);
  ok(rec2.payments.length === 1 && rec2.payments[0].id === 'pay-hold-1',
    'and only that payment — the company-2 R5,000 is excluded');
  const rec3 = A.reconcileJobInvoice(hj2, [holdQuote, oq2]);
  ok(rec3.totalPaid === 2500, 'same with the quotes array reversed');
}

section('6. QUOTE PAYMENT SAVE CASCADE (write path)');
{
  // Reproduces QuotesPage's persisted cascade: build the target set with the
  // shipped resolver, then map. The company-2 job must come out untouched.
  const { holdQuote, otherQuote, holdJob, otherJob } = mk();
  holdQuote.payments = [{ id: 'p-new', amount: 1000 }];
  const jobs = [otherJob, holdJob];
  const before = clone(otherJob);

  const targets = new Set(A.resolveJobsForQuote(holdQuote, jobs).map((x) => x.id));
  const mapped = jobs.map((j) => {
    if (!targets.has(j.id)) return j;
    const rec = A.reconcileJobInvoice({ ...j, payments: j.payments }, [holdQuote]);
    const bump = rec.totalPaid > 0 && (parseFloat(j.stage) || 0) < 5;
    return { ...j, invoiceStatus: rec.invoiceStatus, ...(bump ? { stage: 5, status: 'deposit_received' } : {}) };
  });

  const outOther = mapped.find((j) => j.id === otherJob.id);
  const outHold = mapped.find((j) => j.id === holdJob.id);
  ok(targets.size === 1 && targets.has(holdJob.id), 'only the Holdings job is targeted by the cascade');
  ok(JSON.stringify(outOther) === JSON.stringify(before),
    'the company-2 job is byte-for-byte unchanged', { before, after: outOther });
  ok(outOther.stage === 4 && outOther.status === undefined, 'company-2 job stage/status untouched');
  ok(outHold.stage === 5 && outHold.status === 'deposit_received',
    'the Holdings job still receives its own legitimate deposit advance');
}

section('7. QUOTE DECLINE (write path)');
{
  const { holdQuote, holdJob, otherJob } = mk();
  const jobs = [otherJob, holdJob];
  const targets = new Set(A.resolveJobsForQuote(holdQuote, jobs).map((x) => x.id));
  const remaining = jobs.filter((j) => !targets.has(j.id));
  ok(remaining.length === 1 && remaining[0].id === otherJob.id,
    'declining the Holdings quote removes only the Holdings job');
  ok(remaining.indexOf(otherJob) !== -1, 'the company-2 job survives untouched');

  // reversed order
  const jobsRev = [holdJob, otherJob];
  const t2 = new Set(A.resolveJobsForQuote(holdQuote, jobsRev).map((x) => x.id));
  ok(jobsRev.filter((j) => !t2.has(j.id)).length === 1, 'same with the jobs array reversed');
}

section('8. INVOICE LOOKUP — per-company invoice numbers');
{
  const holdQuote = { id: 401, num: 'SQ-00070', co: HOLD };
  const invHold = { id: 501, number: 'INV-00088', co: HOLD, quoteId: 401, quoteNum: 'SQ-00070', status: 'draft' };
  const invOther = { id: 502, number: 'INV-00088', co: OTHER, quoteId: 402, quoteNum: 'SQ-00070', status: 'draft' };

  ok(A.getQuoteInvoice(holdQuote, [invOther, invHold]) === invHold,
    'getQuoteInvoice matches the Holdings invoice by stable quoteId, not the company-2 one');
  ok(A.getQuoteInvoice(holdQuote, [invHold, invOther]) === invHold, 'order-independent');

  // number-only fallback must still be company-scoped
  const legacyQuote = { id: null, num: 'SQ-00070', co: HOLD };
  const invNumOnly = { id: 503, number: 'INV-00089', co: OTHER, quoteNum: 'SQ-00070', status: 'draft' };
  ok(A.getQuoteInvoice(legacyQuote, [invNumOnly]) === null,
    'the quoteNum fallback never returns another company\'s invoice');

  // duplicate-number check predicate (saveManualInvoice)
  const working = { id: 601, number: 'INV-00088', co: HOLD };
  const all = [invOther, { id: 602, number: 'INV-00088', co: HOLD }];
  const dupScoped = all.find((i) => i.id !== working.id && i.number && A.sameCompany(i, working) &&
    i.number.trim().toLowerCase() === working.number.trim().toLowerCase());
  ok(dupScoped && dupScoped.id === 602, 'a real same-company duplicate invoice number is still caught');
  const okCase = [invOther].find((i) => i.id !== working.id && i.number && A.sameCompany(i, working) &&
    i.number.trim().toLowerCase() === working.number.trim().toLowerCase());
  ok(okCase === undefined, 'a legitimate cross-company reuse of INV-00088 is NOT flagged as a duplicate');
}

section('9. INVOICE → SOURCE QUOTE');
{
  const holdQuote = { id: 701, num: 'SQ-00080', co: HOLD };
  const otherQuote = { id: 702, num: 'SQ-00080', co: OTHER };
  const invHold = { id: 801, number: 'INV-00090', co: HOLD, quoteId: 701, quoteNum: 'SQ-00080' };
  ok(A.resolveQuoteForInvoice(invHold, [otherQuote, holdQuote]) === holdQuote,
    'invoice resolves its own company\'s quote by stable id');
  const invLegacy = { id: 802, number: 'INV-00091', co: HOLD, quoteNum: 'SQ-00080' };
  ok(A.resolveQuoteForInvoice(invLegacy, [otherQuote]) === null,
    'number-only invoice never resolves another company\'s quote');
  ok(A.resolveQuoteForInvoice(invLegacy, [otherQuote, holdQuote]) === holdQuote,
    'number-only invoice resolves the same-company quote when one exists');
  const invCross = { id: 803, number: 'INV-00092', co: HOLD, quoteId: 702 };
  ok(A.resolveQuoteForInvoice(invCross, [otherQuote, holdQuote]) === null,
    'a quoteId pointing across a company boundary resolves to NOTHING');
}

section('10. PDF / ACCOUNTING SOURCE-QUOTE RESOLUTION');
{
  // Job detail panel, printed/emailed invoice, Sales re-sync and Accounting
  // all derive their figures from findSourceQuoteForJob/resolveQuoteForJob.
  const { otherQuote, holdJob } = mkOrphan();
  otherQuote.client = 'OTHER COMPANY CUSTOMER';
  otherQuote.lines = [{ desc: 'other company work', qty: 1, unitPrice: 99999, subtotal: 99999 }];
  const srcQ = A.resolveQuoteForJob(holdJob, [otherQuote]);
  ok(srcQ === null, 'no source quote is resolved for the PDF/Accounting panel');
  const sub = srcQ ? (srcQ.lines || []).reduce((s, l) => s + (l.subtotal || 0), 0) : 0;
  ok(sub === 0, 'no company-2 line totals leak into the Holdings document', sub);
  const client = srcQ ? srcQ.client : holdJob.client;
  ok(client === 'Holdings Client', 'no company-2 customer identity leaks into the Holdings document', client);
}

section('11. ORIGINAL SIGNACORE — existing correct links must be unaffected');
{
  const legacyQuote = { id: 901, num: 'SQ-00010', client: 'Legacy Client', convertedJobId: 902, payments: [{ id: 'lp1', amount: 750 }], lines: [] };
  const legacyJob = { id: 902, num: 'SNS-00010', quoteNum: 'SQ-00010', client: 'Legacy Client', value: 1000, payments: [] };
  ok(A.findSourceQuoteForJob(legacyJob, [legacyQuote]) === legacyQuote,
    'untagged legacy job still resolves its untagged legacy quote');
  ok(A.resolveJobForQuote(legacyQuote, [legacyJob]) === legacyJob,
    'untagged legacy quote still resolves its job');
  ok(A.reconcileJobInvoice(legacyJob, [legacyQuote]).totalPaid === 750,
    'untagged legacy payments still reconcile');

  const co2Quote = { id: 903, num: 'SQ-00011', co: OTHER, convertedJobId: 904, payments: [{ id: 'lp2', amount: 400 }], lines: [] };
  const untaggedJob = { id: 904, num: 'SNS-00011', quoteNum: 'SQ-00011', value: 1000, payments: [] };
  ok(A.findSourceQuoteForJob(untaggedJob, [co2Quote]) === co2Quote,
    'a co-2 quote still links to its untagged pre-Holdings job (mixed-tag legacy pair)');
  ok(A.reconcileJobInvoice(untaggedJob, [co2Quote]).totalPaid === 400,
    'that legacy pair\'s payments still reconcile');
}

section('12. SOURCE GUARDS — the unsafe patterns must not come back');
{
  // MASKED already has every comment and string blanked out, so these guards
  // cannot be satisfied or defeated by documentation text.
  const noComments = MASKED;
  ok(!/\.find\(\s*q\s*=>\s*q\.num\s*===\s*job\.quoteNum\s*\)/.test(noComments),
    'no bare quotes.find(q => q.num === job.quoteNum) remains outside comments');
  const orPattern = /j\.id\s*===\s*q(uote)?\.convertedJobId\s*\|\|\s*[^\n]*quoteNum/g;
  const orHits = (noComments.match(orPattern) || []);
  ok(orHits.length === 0, 'no "stable id OR quote number" resolution pattern remains', orHits);
  ok(SRC.includes('function sameCompany(a, b){'), 'sameCompany() is present');
  ok(SRC.includes('function resolveJobsForQuote(quote, jobs){'), 'resolveJobsForQuote() is present');
  ok(SRC.includes('function resolveQuoteForJob(job, quotes){'), 'resolveQuoteForJob() is present');
  ok(/const link = resolveQuoteForJob\(job, quotes\);/.test(SRC),
    'reconcileJobInvoice resolves its source quote through the company-safe resolver');
  ok(/const _cascadeTargets = new Set\(resolveJobsForQuote\(updated, jobs\)/.test(SRC),
    'the persisted quote-payment cascade uses a company-safe target set');
  ok(/const _declineTargets = new Set\(resolveJobsForQuote\(updated, jobs\)/.test(SRC),
    'the quote-decline cascade uses a company-safe target set');
  ok(/const _syncTargets = new Set\(resolveJobsForQuote\(updated, jobs\)/.test(SRC),
    'the handleUpdate payment cascade uses a company-safe target set');
  ok(noComments.length > 0, 'index.html main script block was parsed');
}

/* ── result ─────────────────────────────────────────────────────────────── */
console.log('\n' + '='.repeat(60));
console.log('PASSED: ' + passed + '   FAILED: ' + failures);
console.log('='.repeat(60));
process.exit(failures === 0 ? 0 : 1);
