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

return { buildSalesInvoiceList, renderSalesInvoiceRows };
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
  const quote = { id: 40, num: 'SQ-00040', co: OTHER, convertedJobId: 41, discount: '10', setupFee: '',
    lines: [{ subtotal: 10000 }], payments: [], client: 'Acme Signs' };
  const job = { id: 41, num: 'SNS-00041', co: OTHER, quoteNum: 'SQ-00040', desc: 'Signage',
    invoiceNum: 'INV-00400', invoiceDate: '2026-09-01', invoiceDue: '2026-10-01',
    value: 10350, discount: '', setupFee: '', lines: [], payments: [{ id: 'p1', amount: 4000 }],
    client: 'Acme Signs' };
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
  const holdJob = { id: 201, num: 'SNS-00901', co: HOLD, quoteNum: 'SQ-00050', desc: 'Signage',
    invoiceNum: 'INV-00901', invoiceDate: '2026-09-01', invoiceDue: '2026-10-01',
    value: 9500 * 1.15, discount: '', setupFee: '', lines: [], payments: [], client: 'Holdings Client' };

  for (const order of [[otherQuote, holdQuote], [holdQuote, otherQuote]]) {
    const label = order[0] === otherQuote ? 'other-company quote first' : 'Holdings quote first';
    const r = renderSalesInvoiceList({ myJobs: [holdJob], myQuotes: order });
    const text = r.text.replace(new RegExp(NB, 'g'), ' ');
    ok(/Discount: 5% \(R\s*500,00\)/.test(text), 'the Holdings row shows 5% / R500.00 (' + label + ')', text);
    ok(text.indexOf('40%') === -1 && text.indexOf('4 000,00') === -1,
      'and never the other company\'s 40% / R4,000.00 (' + label + ')', text);
  }
  // A Holdings job whose quote number exists ONLY under the other company.
  const orphanJob = Object.assign({}, holdJob, { id: 301, num: 'SNS-00040', invoiceNum: 'INV-00902', value: 11500 });
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
