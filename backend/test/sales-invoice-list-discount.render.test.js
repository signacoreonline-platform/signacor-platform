#!/usr/bin/env node
/* ============================================================================
 * sales-invoice-list-discount.render.test.js
 * Signacore — RENDER-LEVEL regression suite for the Sales → Invoices list
 * discount display (2026-09-14, follow-up).
 * ============================================================================
 *
 * WHY THIS EXISTS
 *   The previous pass proved the derivation and asserted the source wiring, but
 *   never rendered the list. This suite compiles the SHIPPED JSX out of
 *   index.html — the real `displayedInvoices.map(j=>{…})` block from QuotesPage,
 *   and the real projection that feeds it — and renders it to HTML, so a claim
 *   that "the Sales row shows the discount" is settled by the row's own output
 *   and not by a regex over the file.
 *
 *   The mandatory check is §MANDATORY below: the exact element that renders
 *   `Balance:` must also render `Discount:`. It is asserted on the rendered
 *   markup, inside one element, not on the source text.
 *
 * DEPENDENCIES — none beyond what the repo already has.
 *   @babel/core + @babel/preset-react are already installed at the repo ROOT
 *   (that is what _checkbabel.js uses). React is NOT required: a ~30-line
 *   createElement/renderToString shim is included below, which is enough for
 *   this row's markup and keeps the backend's dependency set untouched.
 *
 *   node test/sales-invoice-list-discount.render.test.js
 *   INDEX_HTML_PATH=/some/other/index.html node test/…
 * ==========================================================================*/

'use strict';

const fs = require('fs');
const path = require('path');

const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH ||
  path.resolve(__dirname, '..', '..', 'index.html');

let babel, presetReact;
try {
  babel = require('@babel/core');
  presetReact = require('@babel/preset-react');
} catch (e) {
  console.error('Could not load @babel/core / @babel/preset-react.\n' +
    'They live in the REPO ROOT node_modules (the same ones _checkbabel.js uses).\n' +
    'Run this from inside the repo:  cd backend && npm run test:sales-invoice-list-discount');
  process.exit(1);
}

let failures = 0, passed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failures++; console.log('  ✗ ' + label + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}
function section(t) { console.log('\n' + t); }

/* ── a minimal React-compatible renderer ─────────────────────────────────── */
const Fragment = Symbol('Fragment');
function createElement(type, props, ...children) {
  return { $$el: true, type, props: props || {}, children: children.flat(Infinity) };
}
const React = { createElement, Fragment };
const VOID_TAGS = { br: 1, img: 1, input: 1, hr: 1, meta: 1, link: 1 };
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function renderToString(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (Array.isArray(node)) return node.map(renderToString).join('');
  if (typeof node === 'string' || typeof node === 'number') return esc(node);
  if (!node.$$el) return '';
  const { type, props } = node;
  const kids = node.children.length ? node.children
    : (props.children !== undefined ? [].concat(props.children) : []);
  if (type === Fragment) return kids.map(renderToString).join('');
  if (typeof type === 'function') return renderToString(type(Object.assign({}, props, { children: kids })));
  const attrs = [];
  for (const k of Object.keys(props)) {
    const v = props[k];
    if (k === 'children' || k === 'key' || k.startsWith('on')) continue;
    if (v === null || v === undefined || v === false) continue;
    if (k === 'className') attrs.push('class="' + esc(v) + '"');
    else if (k === 'style' && v && typeof v === 'object') {
      attrs.push('style="' + Object.keys(v).map(a => a + ':' + v[a]).join(';') + '"');
    } else attrs.push(k + '="' + esc(v) + '"');
  }
  const open = '<' + type + (attrs.length ? ' ' + attrs.join(' ') : '') + '>';
  if (VOID_TAGS[type]) return open;
  return open + kids.map(renderToString).join('') + '</' + type + '>';
}

/* ── extraction ───────────────────────────────────────────────────────────
   Whole-file masking is NOT safe this deep into index.html: the masker does
   not model regex literals, so one quote inside a regex swallows every
   declaration after it. Everything below masks only a LOCAL window around a
   declaration anchored in the raw source. */
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
  if (at < 0) throw new Error('could not locate top-level function ' + name);
  const win = src.slice(at + 1, at + 1 + 40000);
  const wm = maskForCounting(win);
  // Step over the parameter list: a destructured parameter such as
  // `function InvoiceDiscountBadge({ view, fmt })` opens a brace that is not
  // the body, and matching from it truncates the function to its signature.
  const paren = wm.indexOf('(');
  let pd = 0, afterParams = -1;
  for (let i = paren; i < wm.length; i++) {
    if (wm[i] === '(') pd++;
    else if (wm[i] === ')') { pd--; if (pd === 0) { afterParams = i + 1; break; } }
  }
  const open = wm.indexOf('{', afterParams);
  let depth = 0;
  for (let i = open; i < wm.length; i++) {
    if (wm[i] === '{') depth++;
    else if (wm[i] === '}') { depth--; if (depth === 0) return win.slice(0, i + 1); }
  }
  throw new Error('unbalanced body for ' + name);
}

function extractConst(src, name) {
  const decl = '\nconst ' + name;
  let at = src.indexOf(decl);
  while (at >= 0 && !/^\s*=/.test(src.slice(at + decl.length, at + decl.length + 40))) {
    at = src.indexOf(decl, at + 1);
  }
  if (at < 0) throw new Error('could not extract const ' + name);
  const win = src.slice(at + 1, at + 1 + 40000);
  const wm = maskForCounting(win);
  let depth = 0;
  for (let i = 0; i < wm.length; i++) {
    const c = wm[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (c === ';' && depth === 0) return win.slice(0, i + 1);
  }
  throw new Error('unterminated const ' + name);
}

function extractBalanced(src, from, openCh, closeCh) {
  const at = src.indexOf(from);
  if (at < 0) throw new Error('could not locate ' + from);
  const win = src.slice(at);
  const wm = maskForCounting(win);
  const open = wm.indexOf(openCh);
  let depth = 0;
  for (let i = open; i < wm.length; i++) {
    if (wm[i] === openCh) depth++;
    else if (wm[i] === closeCh) { depth--; if (depth === 0) return win.slice(0, i + 1); }
  }
  throw new Error('unbalanced ' + from);
}

const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
const OPEN = '<script type="text/babel" data-presets="react-classic">';
const startIdx = html.indexOf(OPEN);
if (startIdx < 0) { console.error('main babel script block not found in ' + INDEX_HTML_PATH); process.exit(1); }
const SRC = html.slice(startIdx + OPEN.length, html.lastIndexOf('</script>'));

/* THE SHIPPED PROJECTION — QuotesPage's own invoice-list build. Anchored on
   `jobInvItems`, the one identifier unique to this list (CustomersPage has a
   similarly-shaped `_manualJobRefs` line of its own). */
const projAnchor = SRC.indexOf('const jobInvItems = myJobs.filter(');
if (projAnchor < 0) { console.error('QuotesPage jobInvItems not found'); process.exit(1); }
const projStart = SRC.lastIndexOf('const _manualJobRefs = getManualInvoiceJobRefs(myAccInvoices, myJobs);', projAnchor);
const projEnd = SRC.indexOf('  // Jobs that are invoice-ready but don', projAnchor);
const PROJECTION_SRC = SRC.slice(projStart, projEnd);

/* THE SHIPPED ROW — the exact JSX the Sales invoice list draws. */
const ROW_MAP_SRC = extractBalanced(SRC, 'displayedInvoices.map(j=>{', '(', ')');

const HELPER_FNS = [
  'companyTagOf', 'sameCompany', 'jobHasId', 'isHoldingsRecord', 'isHoldingsUser', 'belongsToUserCompany',
  'resolveJobsForQuote', 'resolveJobForQuote', 'resolveQuoteForJob', 'findSourceQuoteForJob',
  'numSort', 'invoiceBelongsToJob', 'invoiceIdentityKey', 'resolveJobInvoiceRecord',
  'jobInvoiceLinkState', 'getManualInvoiceJobRefs', 'getJobManualInvoice', 'getQuoteInvoice',
  'sgrInvoiceLineAmount', 'sgrInvoiceAdjustmentKind', 'sgrSplitInvoiceLineItems', 'invoiceDiscountView',
  'docLinesSubtotal', 'stubAdjustmentLines', 'jobInvoiceLineItems',
  'toCents', 'settlementOutstanding', 'deriveSettlementStatus', 'sumPaymentAmounts',
  'reconcileJobInvoice', 'InvoiceDiscountBadge', 'PaymentLockedBadge',
];
const HELPER_CONSTS = ['HOLDINGS_CO_ID', 'HOLDINGS_CO_KEY', 'UNIONTECH_ID',
  'SGR_INV_SETUP_FEE_DESC', 'SGR_INV_DISCOUNT_RE', 'SGR_INV_ADJ_EPSILON',
  'INVOICE_NO_ACCOUNTING_RECORD_REASON', 'zar', 'PAYMENT_OWNER_SECTIONS'];

const BUNDLE = `
${HELPER_CONSTS.map(c => extractConst(SRC, c)).join('\n')}
${HELPER_FNS.map(f => extractFunction(SRC, f)).join('\n\n')}

/* Handlers the row wires into onClick — never invoked by a static render. */
const setViewInvoiceRow=()=>{}, setManualInvPayModal=()=>{}, setEditManualInv=()=>{},
      setShowManualInvModal=()=>{}, printManualInvoice=()=>{}, emailManualInvoiceViaOutlook=()=>{},
      guardAction=()=>{}, relKey=()=>'k', markCanonicalInvoicePaid=()=>{}, setAccInvoices=()=>{},
      saveManualInvoiceFromSales=()=>{}, deleteCanonicalInvoice=()=>{}, setJobs=()=>{},
      setJobPayModal=()=>{}, setJobPayModalExternal=()=>{}, setEditInvoice=()=>{},
      printInvoice=()=>{}, setEmailInvoiceJob=()=>{}, logoDataUrl=null, customers=[];

function buildSalesInvoiceList(ctx){
  const { myJobs, myQuotes, myAccInvoices, invFilter, searchInv } = ctx;
${PROJECTION_SRC}
  return { invoicedJobs, displayedInvoices };
}

function renderSalesInvoiceRows(ctx, displayedInvoices){
  const { companies, invHighlight, myAccInvoices, isAdmin } = ctx;
  return <div className="space-y-2">{${ROW_MAP_SRC}}</div>;
}

return { buildSalesInvoiceList, renderSalesInvoiceRows, jobInvoiceLineItems, invoiceDiscountView };
`;

let API;
try {
  const compiled = babel.transform(BUNDLE, {
    presets: [[presetReact, { runtime: 'classic' }]],
    configFile: false, babelrc: false,
    parserOpts: { allowReturnOutsideFunction: true },
  }).code;
  API = new Function('React', compiled)(React);
} catch (e) {
  console.error('Could not compile/evaluate the shipped Sales invoice list: ' + e.message);
  process.exit(1);
}

/** fixtures → the SHIPPED projection → the SHIPPED row JSX → HTML */
function renderSalesInvoiceList(ctx) {
  const full = Object.assign({ invFilter: 'all', searchInv: '', companies: [{ id: 1, short: 'HOLD' }, { id: 2, short: 'SNS' }],
    invHighlight: null, isAdmin: true, myJobs: [], myQuotes: [], myAccInvoices: [] }, ctx);
  const { displayedInvoices } = API.buildSalesInvoiceList(full);
  const markup = renderToString(API.renderSalesInvoiceRows(full, displayedInvoices));
  return { displayedInvoices, markup, text: markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() };
}

/** The row's financial block — the element that renders the amount and Balance. */
function financialBlock(markup) {
  const marker = '<div class="text-right flex-shrink-0">';
  const a = markup.indexOf(marker);
  if (a < 0) return '';
  let depth = 0, i = a;
  const re = /<\/?div\b[^>]*>/g;
  re.lastIndex = a;
  let m;
  while ((m = re.exec(markup))) {
    if (m[0][1] === '/') { depth--; if (depth === 0) return markup.slice(a, m.index + m[0].length); }
    else depth++;
  }
  return markup.slice(a);
}
/** The shared financial derivation, lifted from the same bundle — so the
 *  Accounting-parity checks below compare against the SHIPPED helper, not a
 *  re-implementation of it. */
const API_HELPERS = API;
const stripTags = (s) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const NB = ' '; // zar() uses a non-breaking space after R

const HOLD = 1, OTHER = 2;
const canonicalInvoice = (over) => Object.assign({
  id: 'i1', number: 'INV-00300', status: 'sent', co: OTHER, contactName: 'Acme Signs',
  date: '2026-09-01', dueDate: '2026-10-01', reference: '', payments: [],
  lineItems: [
    { description: 'Illuminated sign', qty: 1, unitAmount: 10000, accountCode: '4000', taxType: '15%' },
    { description: 'Discount (10%)', qty: 1, unitAmount: -1000, accountCode: '4000', taxType: '15%' },
  ],
}, over);

/* ═══════════════════════════════════════════════════════════════════════
   THE LIVE DEFECT — INV-00057 / SNS-00083 · Signarama Port Elizabeth

   A historical job-derived invoice with NO accounting record. The discount
   cascade only arrived on 2026-09-07, so this transaction carries its 10% on
   the JOB (rel_jobs.discount_pct) while its source quote still reads 0.

   Sales rebuilt the total from the QUOTE — (quote subtotal − QUOTE discount
   + quote setup fee) × 1.15 — which for this shape is the PRE-discount total.
   Every figure below is the live one reported from the running site.
   ═══════════════════════════════════════════════════════════════════════ */
const LIVE = {
  linesSub: 3853.49,       // quote AND job line subtotal, ex VAT, pre-discount
  discPct: 10,
  discAmt: 385.35,         // 3853.49 × 10%
  exVat: 3468.14,          // 3853.49 − 385.35
  vat: 520.22,
  total: 3988.36,          // rel_jobs.value — NUMERIC(14,2)
  paid: 3500.00,
  balance: 488.36,
  wrongTotal: 4431.51,     // 3853.49 × 1.15 — what Sales showed
  wrongBalance: 931.51,
};
function liveFixture() {
  const quote = { id: 83, num: 'SQ-00083', co: OTHER, convertedJobId: 183,
    discount: '', setupFee: '', lines: [{ subtotal: LIVE.linesSub }], payments: [],
    client: 'Signarama Port Elizabeth' };
  const job = { id: 183, num: 'SNS-00083', co: OTHER, quoteNum: 'SQ-00083',
    invoiceNum: 'INV-00057', desc: 'Signage', invoiceDate: '2026-07-01', invoiceDue: '2026-07-31',
    value: LIVE.total, discount: String(LIVE.discPct), setupFee: '',
    lines: [{ subtotal: LIVE.linesSub }], payments: [{ id: 'p1', amount: LIVE.paid }],
    client: 'Signarama Port Elizabeth' };
  return { quote, job };
}
/* The removed formula, kept verbatim so this suite proves the fixture really
   does reproduce the defect — and so the defect can never be reintroduced
   silently. This is the code that used to run in QuotesPage's jobInvItems. */
function theRemovedQuoteResync(j, link) {
  const _sub = (link.lines || []).reduce((s, l) => s + (l.subtotal || 0), 0);
  const _discPct = parseFloat(link.discount) || 0;
  const _setupFee = parseFloat(link.setupFee) || 0;
  const _afterDisc = _sub - _sub * (_discPct / 100) + _setupFee;
  return Object.assign({}, j, { lines: link.lines, discount: link.discount || '',
    setupFee: link.setupFee || '', value: _afterDisc * 1.15 });
}

section('LIVE BEFORE — the fixture reproduces the reported defect exactly');
{
  const { quote, job } = liveFixture();
  const broken = theRemovedQuoteResync(job, quote);
  ok(Math.abs(broken.value - LIVE.wrongTotal) < 0.005,
    'the old quote re-sync produces the reported wrong total R4,431.51', broken.value.toFixed(4));
  ok(Math.abs((broken.value - LIVE.paid) - LIVE.wrongBalance) < 0.005,
    'and the reported wrong balance R931.51', (broken.value - LIVE.paid).toFixed(4));
  ok((parseFloat(broken.discount) || 0) === 0,
    'and it overwrote the job\'s 10% with the quote\'s empty discount — so Sales showed none', broken.discount);
  ok(String(job.discount) === '10' && Math.abs(job.value - LIVE.total) < 0.005,
    'while the JOB itself held the correct 10% and R3,988.36 all along');
}

section('LIVE AFTER — the shipped Sales list now shows the correct figures');
{
  const { quote, job } = liveFixture();
  const r = renderSalesInvoiceList({ myJobs: [job], myQuotes: [quote] });
  const row = r.displayedInvoices[0];
  const text = r.text.replace(new RegExp(NB, 'g'), ' ');
  ok(Math.abs(row.value - LIVE.total) < 0.005, 'Total is R3,988.36', row.value);
  ok(row._discountView.pct === LIVE.discPct, 'Discount percentage is 10%', row._discountView);
  ok(Math.abs(row._discountView.amt - LIVE.discAmt) < 0.01, 'Discount amount is R385.35', row._discountView);
  ok(Math.abs((row.value - LIVE.paid) - LIVE.balance) < 0.005, 'Balance is R488.36', row.value - LIVE.paid);
  ok(/R\s*3\s*988,36/.test(text), 'the row renders R 3 988,36');
  ok(/Discount: 10% \(R\s*385,35\)/.test(text), 'the row renders "Discount: 10% (R 385,35)"', text);
  ok(/Paid: R\s*3\s*500,00/.test(text), 'the row renders Paid R 3 500,00');
  ok(/Balance: R\s*488,36/.test(text), 'the row renders Balance R 488,36');
  ok(text.indexOf('4 431,51') === -1 && text.indexOf('931,51') === -1,
    'and the wrong figures appear nowhere on the row', text);
  ok(text.indexOf('📜 No accounting record') !== -1,
    'this is still the historical "No accounting record" representation');
  ok(row.payments.length === 1 && row.payments[0].amount === LIVE.paid,
    'the payment is untouched — one row, R3,500.00', row.payments);
  /* The projected row is also what the row's Print / Edit / Payments buttons
     receive. buildInvoiceHtml derives its document from job.lines +
     job.discount + job.setupFee, so those must now be the JOB's own — the same
     object Jobs, Job Detail and Accounting already hand their own Print. With
     the quote's fields substituted, this invoice printed at R4,431.51 too. */
  ok(row.discount === '10', 'the row carries the JOB\'s discount, not the quote\'s', row.discount);
  ok(JSON.stringify(row.lines) === JSON.stringify(job.lines),
    'and the JOB\'s own lines — so Print and Edit state the same document', row.lines);
  const printSub = (row.lines || []).reduce((s, l) => s + (l.subtotal || 0), 0);
  const printDisc = printSub * ((parseFloat(row.discount) || 0) / 100);
  const printTotal = (printSub - printDisc + (parseFloat(row.setupFee) || 0)) * 1.15;
  ok(Math.abs(printTotal - LIVE.total) < 0.01,
    'the printed invoice therefore totals R3,988.36 as well', printTotal.toFixed(2));
}

section('LIVE PARITY — Accounting derives the same figures from the same job');
{
  const { job } = liveFixture();
  const ji = API_HELPERS.jobInvoiceLineItems(job);
  const sub = ji.lineItems.reduce((s, l) => s + l.qty * l.unitAmount, 0);
  const vat = ji.lineItems.reduce((s, l) => l.taxType === '15%' ? s + l.qty * l.unitAmount * 0.15 : s, 0);
  ok(ji.canBreakOut === true, 'the reconstruction guard passes — the job\'s lines prove the shape');
  ok(ji.discPct === LIVE.discPct && Math.abs(ji.discAmt - LIVE.discAmt) < 0.01,
    'Accounting: 10% / R385.35', { pct: ji.discPct, amt: ji.discAmt });
  ok(Math.abs(sub - LIVE.exVat) < 0.01, 'Accounting: ex VAT R3,468.14', sub);
  ok(Math.abs(vat - LIVE.vat) < 0.01, 'Accounting: VAT R520.22', vat);
  ok(Math.abs(sub + vat - LIVE.total) < 0.01, 'Accounting: total R3,988.36', sub + vat);
  ok(Math.abs(sub + vat - LIVE.paid - LIVE.balance) < 0.01, 'Accounting: outstanding R488.36');
  const { quote } = liveFixture();
  const r = renderSalesInvoiceList({ myJobs: [job], myQuotes: [quote] });
  ok(Math.abs(r.displayedInvoices[0].value - (sub + vat)) < 0.005,
    'Sales and Accounting now agree on the total to the cent');
}

section('HISTORICAL — a discounted job with no line rows left to prove the subtotal');
{
  // Same money, but the job's line rows are gone (a genuinely old record).
  // The pre-discount subtotal is recovered from the job's own value.
  const job = { id: 184, num: 'SNS-00084', co: OTHER, desc: 'Signage', invoiceNum: 'INV-00058',
    invoiceDate: '2026-07-01', invoiceDue: '2026-07-31', value: LIVE.total,
    discount: '10', setupFee: '', lines: [], payments: [{ id: 'p1', amount: LIVE.paid }],
    client: 'Signarama Port Elizabeth' };
  const r = renderSalesInvoiceList({ myJobs: [job] });
  const row = r.displayedInvoices[0];
  ok(Math.abs(row.value - LIVE.total) < 0.005, 'the total is still the job\'s own R3,988.36', row.value);
  ok(row._discountView.pct === 10 && Math.abs(row._discountView.amt - LIVE.discAmt) < 0.01,
    'and the discount is stated as 10% / R385.35 rather than 10% of nothing', row._discountView);
  const ji = API_HELPERS.jobInvoiceLineItems(job);
  const tot = ji.lineItems.reduce((s, l) => s + l.qty * l.unitAmount * (l.taxType === '15%' ? 1.15 : 1), 0);
  ok(Math.abs(tot - LIVE.total) < 0.01, 'and the reconstructed lines still total exactly the job value', tot);
}

section('SETUP FEE + DISCOUNT — the existing accounting order is preserved');
{
  // subtotal 10 000 − 10% + 1 500 setup = 10 500 ex VAT → 12 075 incl.
  const job = { id: 185, num: 'SNS-00085', co: OTHER, desc: 'Signage', invoiceNum: 'INV-00059',
    invoiceDate: '2026-09-01', invoiceDue: '2026-10-01', value: 12075,
    discount: '10', setupFee: '1500', lines: [{ subtotal: 10000 }], payments: [], client: 'Acme' };
  const ji = API_HELPERS.jobInvoiceLineItems(job);
  ok(ji.lineItems.length === 3, 'three lines: item, discount, setup fee', ji.lineItems.length);
  ok(/^Signage/.test(ji.lineItems[0].description) && ji.lineItems[0].unitAmount === 10000,
    'item line is the PRE-discount subtotal');
  ok(ji.lineItems[1].description === 'Discount (10%)' && Math.abs(ji.lineItems[1].unitAmount + 1000) < 0.005,
    'discount is next, negative, off the subtotal only');
  ok(ji.lineItems[2].description === 'Setup Fee' && ji.lineItems[2].unitAmount === 1500,
    'setup fee is added after the discount');
  const r = renderSalesInvoiceList({ myJobs: [job] });
  const text = r.text.replace(new RegExp(NB, 'g'), ' ');
  ok(/R\s*12\s*075,00/.test(text), 'and Sales shows R12,075.00 incl. VAT', text);
  ok(/Discount: 10% \(R\s*1\s*000,00\)/.test(text), 'with the discount stated off the subtotal');
}

section('ROUNDING — the row shows the stored cent value, not a re-multiplication');
{
  // 4970.88 × 1.15 = 5716.512 unrounded; rel_jobs.value NUMERIC(14,2) = 5716.51.
  const quote = { id: 90, num: 'SQ-00090', co: OTHER, convertedJobId: 91, discount: '', setupFee: '',
    lines: [{ subtotal: 4970.88 }], payments: [], client: 'Acme' };
  const job = { id: 91, num: 'SNS-00091', co: OTHER, quoteNum: 'SQ-00090', desc: 'Signage',
    invoiceNum: 'INV-00060', invoiceDate: '2026-09-01', invoiceDue: '2026-10-01',
    value: 5716.51, discount: '', setupFee: '', lines: [{ subtotal: 4970.88 }],
    payments: [{ id: 'p1', amount: 5716.51 }], client: 'Acme' };
  const r = renderSalesInvoiceList({ myJobs: [job], myQuotes: [quote] });
  const row = r.displayedInvoices[0];
  ok(row.value === 5716.51, 'the row value is exactly the stored 5716.51', row.value);
  ok(Math.abs(4970.88 * 1.15 - 5716.512) < 1e-9 && row.value !== 4970.88 * 1.15,
    'not the 5716.512 the old re-multiplication produced');
  ok(row.invoiceStatus === 'paid', 'and a payment of the billed cent figure settles it in full');
}

/* ═══════════════════════════════════════════════════════════════════════ */
section('MANDATORY — the element that renders "Balance:" also renders "Discount:"');
{
  const inv = canonicalInvoice({ payments: [{ id: 'p1', amount: 4000 }] });
  const r = renderSalesInvoiceList({ myAccInvoices: [inv] });
  const block = financialBlock(r.markup);
  ok(block.length > 0, 'the row\'s financial block was located in the rendered markup');
  const blockText = stripTags(block);
  ok(blockText.indexOf('Balance:') !== -1, 'that block renders "Balance:"', blockText);
  ok(blockText.indexOf('Discount:') !== -1, 'THE SAME block renders "Discount:"', blockText);
  ok(/R\s*10\s*350,00/.test(blockText.replace(new RegExp(NB, 'g'), ' ')), 'and the invoice total', blockText);
  console.log('\n      rendered financial block:');
  for (const line of blockText.split(/(?=incl\. VAT|Discount:|Balance:)/)) console.log('        ' + line.trim());
}

section('CASE A — 10% on R10,000: the row shows 10% AND R1,000.00, totals unchanged');
{
  const inv = canonicalInvoice({ payments: [{ id: 'p1', amount: 4000 }] });
  const r = renderSalesInvoiceList({ myAccInvoices: [inv] });
  const text = r.text.replace(new RegExp(NB, 'g'), ' ');
  ok(r.displayedInvoices.length === 1, 'one row is produced');
  ok(text.indexOf('Discount: 10%') !== -1, 'the row visibly states 10%', text);
  ok(/Discount: 10% \(R\s*1\s*000,00\)/.test(text), 'and R1,000.00 alongside it', text);
  // TASK 9 — Total / Paid / Balance must be numerically identical.
  ok(/R\s*10\s*350,00/.test(text), 'Total is R10,350.00 (10,000 − 1,000 = 9,000 × 1.15)');
  ok(/Paid: R\s*4\s*000,00/.test(text), 'Paid is R4,000.00');
  ok(/Balance: R\s*6\s*350,00/.test(text), 'Balance is R6,350.00');
  ok(text.indexOf('⏳ Partly Paid') !== -1, 'and the status is unchanged');
  // TASK 3 — the object the row actually receives.
  const row = r.displayedInvoices[0];
  for (const f of ['invoiceNum', 'value', 'payments', '_discountView']) {
    ok(row[f] !== undefined, 'the row object carries `' + f + '`');
  }
  ok(row._discountView.pct === 10 && Math.abs(row._discountView.amt - 1000) < 0.005,
    'and `_discountView` is {pct:10, amt:1000}', row._discountView);
}

section('CASE B — historical canonical invoice: Discount (10%) line only, no legacy field');
{
  const inv = canonicalInvoice({ id: 'i2', number: 'INV-00099', status: 'paid' });
  ok(inv.discount === undefined && inv.discountAmount === undefined,
    'precondition: the record has NO inv.discount / inv.discountAmount');
  const r = renderSalesInvoiceList({ myAccInvoices: [inv] });
  const text = r.text.replace(new RegExp(NB, 'g'), ' ');
  ok(/Discount: 10% \(R\s*1\s*000,00\)/.test(text), 'the Sales list still shows 10% and R1,000.00', text);
  ok(/R\s*10\s*350,00/.test(text), 'with the same total');
}

section('CASE C — job-derived row, discount from the canonical quote');
{
  // 2026-09-14 (c): the job carries `discount` and its own `lines` too. That is
  // how the platform actually stores a converted job — convertQuoteToJob and
  // the 2026-09-07 cascade both write discount_pct to rel_jobs as a
  // synchronised projection. The original fixture left the job's discount empty
  // and put it only on the quote, which no live record looks like, and that is
  // why this suite passed while INV-00057 was wrong on screen.
  const quote = { id: 40, num: 'SQ-00040', co: OTHER, convertedJobId: 41, discount: '10', setupFee: '',
    lines: [{ subtotal: 10000 }], payments: [], client: 'Acme Signs' };
  const job = { id: 41, num: 'SNS-00041', co: OTHER, quoteNum: 'SQ-00040', desc: 'Signage',
    invoiceNum: 'INV-00400', invoiceDate: '2026-09-01', invoiceDue: '2026-10-01',
    value: 10350, discount: '10', setupFee: '', lines: [{ subtotal: 10000 }],
    payments: [{ id: 'p1', amount: 4000 }], client: 'Acme Signs' };
  const r = renderSalesInvoiceList({ myJobs: [job], myQuotes: [quote] });
  const text = r.text.replace(new RegExp(NB, 'g'), ' ');
  ok(r.displayedInvoices.length === 1, 'one job-derived row is produced');
  ok(/Discount: 10% \(R\s*1\s*000,00\)/.test(text), 'it visibly states 10% and R1,000.00', text);
  ok(/R\s*10\s*350,00/.test(text), 'Total is R10,350.00');
  ok(/Balance: R\s*6\s*350,00/.test(text), 'Balance is R6,350.00');
  const block = stripTags(financialBlock(r.markup));
  ok(block.indexOf('Discount:') !== -1 && block.indexOf('Balance:') !== -1,
    'and both sit in the same financial block', block);
}

section('CASE D — no discount: nothing is displayed, nothing is invented');
{
  const plain = canonicalInvoice({ id: 'i3', number: 'INV-00301',
    lineItems: [{ description: 'Signage', qty: 1, unitAmount: 10000, accountCode: '4000', taxType: '15%' }] });
  const r = renderSalesInvoiceList({ myAccInvoices: [plain] });
  const text = r.text.replace(new RegExp(NB, 'g'), ' ');
  ok(text.indexOf('Discount') === -1, 'the row contains no discount text at all', text);
  ok(text.indexOf('0%') === -1, 'and no "0%"', text);
  ok(/R\s*11\s*500,00/.test(text), 'the total is the undiscounted R11,500.00');

  const job = { id: 50, num: 'SNS-00050', co: OTHER, desc: 'Signage', invoiceNum: 'INV-00500',
    value: 11500, discount: '', setupFee: '', lines: [{ subtotal: 10000 }], payments: [], client: 'Acme' };
  const rj = renderSalesInvoiceList({ myJobs: [job] });
  ok(rj.text.indexOf('Discount') === -1, 'a job-derived row with no discount likewise shows none');
}

section('CASE E — company isolation: the row shows its OWN company\'s discount');
{
  const holdQuote = { id: 101, num: 'SQ-00050', co: HOLD, convertedJobId: 201, discount: '5', setupFee: '',
    lines: [{ subtotal: 10000 }], payments: [], client: 'Holdings Client' };
  const otherQuote = { id: 102, num: 'SQ-00050', co: OTHER, convertedJobId: 202, discount: '40', setupFee: '',
    lines: [{ subtotal: 10000 }], payments: [], client: 'Other Client' };
  // The Holdings job carries its OWN 5% (as the platform stores it); the
  // other company's same-numbered quote carries 40% and must never reach it.
  const holdJob = { id: 201, num: 'SNS-00901', co: HOLD, quoteNum: 'SQ-00050', desc: 'Signage',
    invoiceNum: 'INV-00901', invoiceDate: '2026-09-01', invoiceDue: '2026-10-01',
    value: 9500 * 1.15, discount: '5', setupFee: '', lines: [{ subtotal: 10000 }],
    payments: [], client: 'Holdings Client' };

  for (const order of [[otherQuote, holdQuote], [holdQuote, otherQuote]]) {
    const label = order[0] === otherQuote ? 'other-company quote first' : 'Holdings quote first';
    const r = renderSalesInvoiceList({ myJobs: [holdJob], myQuotes: order });
    const text = r.text.replace(new RegExp(NB, 'g'), ' ');
    ok(/Discount: 5% \(R\s*500,00\)/.test(text), 'the Holdings row shows 5% / R500.00 (' + label + ')', text);
    ok(text.indexOf('40%') === -1 && text.indexOf('4 000,00') === -1,
      'and never the other company\'s 40% / R4,000.00 (' + label + ')', text);
  }
  // A Holdings job with NO discount of its own, whose quote number exists only
  // under the other company — the 40% must not leak in from anywhere.
  const orphanJob = Object.assign({}, holdJob, { id: 301, num: 'SNS-00040', invoiceNum: 'INV-00902',
    value: 11500, discount: '', lines: [{ subtotal: 10000 }] });
  const ro = renderSalesInvoiceList({ myJobs: [orphanJob], myQuotes: [otherQuote] });
  ok(ro.text.indexOf('Discount') === -1, 'it borrows no discount from the other company\'s quote');
  ok(/R\s*11\s*500,00/.test(ro.text.replace(new RegExp(NB, 'g'), ' ')), 'and its total is untouched');
}

section('TOTALS — adding the discount line perturbs nothing else');
{
  // The same money, expressed with and without a discount, must render the same
  // Total / Paid / Balance figures.
  const withDisc = canonicalInvoice({ payments: [{ id: 'p1', amount: 4000 }] });
  const noDisc = canonicalInvoice({ id: 'i9', number: 'INV-00302', payments: [{ id: 'p1', amount: 4000 }],
    lineItems: [{ description: 'Illuminated sign', qty: 1, unitAmount: 9000, accountCode: '4000', taxType: '15%' }] });
  const a = renderSalesInvoiceList({ myAccInvoices: [withDisc] });
  const b = renderSalesInvoiceList({ myAccInvoices: [noDisc] });
  const money = (t) => (t.replace(new RegExp(NB, 'g'), ' ').match(/R\s*[\d\s]+,\d\d/g) || []);
  const aMoney = money(a.text).filter(m => !/1\s*000,00/.test(m));
  ok(JSON.stringify(aMoney) === JSON.stringify(money(b.text)),
    'every other money figure on the row is identical with and without the discount line',
    { withDiscount: aMoney, withoutDiscount: money(b.text) });
  ok(Math.abs(a.displayedInvoices[0].value - b.displayedInvoices[0].value) < 0.005,
    'and the projected `value` is the same number', [a.displayedInvoices[0].value, b.displayedInvoices[0].value]);
}

section('SOURCE — the derivation is the shared one, not a new calculation');
{
  ok(/const _rowDiscount = j\._discountView \|\| \{ pct:0, amt:0 \};/.test(SRC),
    'the row reads the discount the projection derived, and derives nothing itself');
  ok(/const _discountView = invoiceDiscountView\(i\);/.test(SRC),
    'canonical rows derive through invoiceDiscountView');
  ok(/_discountView:\{ pct:_disc\.discPct, amt:_disc\.discAmt \}/.test(SRC),
    'job-derived rows derive through jobInvoiceLineItems');
  ok(ROW_MAP_SRC.indexOf('_rowDiscount.pct>0') !== -1,
    'the Sales row renders the discount only when there is one');
  ok(ROW_MAP_SRC.indexOf('Balance: ') !== -1,
    'and the SAME row source renders Balance — one row, both facts');
  ok(/const link = resolveQuoteForJob\(j, myQuotes\);/.test(SRC),
    'the projection still resolves a job\'s quote through the company-safe resolver');
}

/* ── result ─────────────────────────────────────────────────────────────── */
console.log('\n' + '='.repeat(60));
console.log('PASSED: ' + passed + '   FAILED: ' + failures);
console.log('='.repeat(60));
process.exit(failures === 0 ? 0 : 1);
