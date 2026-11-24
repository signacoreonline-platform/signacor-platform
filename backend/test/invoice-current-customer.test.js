#!/usr/bin/env node
/* ============================================================================
 * invoice-current-customer.test.js
 * Signacore — PRINTED INVOICE MUST SHOW THE CURRENT CUSTOMER DETAILS (2026-10-15)
 * ============================================================================
 *
 * THE BUG
 *   A newly generated Tax Invoice printed the customer details SNAPSHOT stored
 *   on the job (copied from the quote on conversion) or on the accInvoices
 *   record. The Customer record was consulted only when a snapshot field was
 *   EMPTY, and only for address + VAT; the emailed .eml PDF never consulted
 *   Customers at all. Correcting a customer's address after the invoice was
 *   issued therefore never reached the regenerated invoice.
 *
 * THE FIX BEING PROVED
 *   buildInvoiceHtml() — the ONE builder behind Print, the Print Preview /
 *   Download PDF window, the Customers-page invoice link, the accInvoices
 *   printable adapter and the emailed PDF — now resolves the current linked
 *   Customer (exact, UNIQUE companyName match) for the customer block only.
 *   generateAndEmailDocument() applies the same rule for an invoice so the
 *   cover letter, PDF and To: address agree. Money is never touched.
 *
 * COVERAGE (numbered to match the brief)
 *    1-4   blank address at creation -> customer edited -> regenerate -> shows
 *    5-11  invoice number, date, lines, subtotal, VAT, total, discount and
 *          setup fee are unchanged
 *   12     contact / email / tel / VAT refresh too (existing document fields)
 *   13     the invoice stays with the SAME customer (similar names ignored)
 *   14     no loose / substring / contact-person matching; duplicates -> snapshot
 *   15     Quote document behaviour unchanged
 *   16     standalone linked Accounting invoice gets current details
 *   17     unlinked / historical invoice keeps its stored snapshot
 *   18     Print, Preview/Download (manual adapter) and Email all agree
 *   19     no input record is mutated; money identical with/without customers
 *   20     settlement/rounding code paths are not referenced by the change
 *
 *
 * LEGAL-SUFFIX FOLLOW-UP (L1–L10)
 *   L1   "Hennies Witbank" resolves uniquely to "Hennies Witbank (Pty) Ltd"
 *   L2   (Pty) Ltd / Pty Ltd / (Pty) Limited / Pty Limited variants resolve
 *   L3   the CURRENT customer company name prints in Billed To
 *   L4   address / contact / email / tel / VAT still refresh
 *   L5   "Hennies Witbank" does NOT match "Hennies Witbank Signs"
 *   L6   partial / fuzzy matches remain prohibited
 *   L7   two customers with the same suffix-normalised base -> no match
 *   L8   exact matching still has priority
 *   L9   unmatched historical invoice still uses its stored details
 *   L10  invoice number / date / lines / money unchanged; stored record untouched
 *
 * APOSTROPHE FOLLOW-UP (P1–P10) — actual case: invoice "Hennie's Witbank",
 * customer "Hennies Witbank (PTY) Ltd"
 *   P1   "Hennie's Witbank" resolves to "Hennies Witbank (PTY) Ltd"
 *   P2   straight ' and curly ’ apostrophes both work
 *   P3   current company name prints        P4  current address prints
 *   P5   current contact / email / tel / VAT print
 *   P6   Hennies Witbank Signs (Pty) Ltd does not match
 *   P7   partial / fuzzy names do not match
 *   P8   duplicate normalised matches -> no match (stored details used)
 *   P9   exact matching still has priority
 *   P10  invoice financial / reference fields unchanged; record untouched
 *
 * Pure source + sandbox evaluation of index.html — no database, no server,
 * no network.
 *
 *   node test/invoice-current-customer.test.js            (from backend/)
 *   INDEX_HTML_PATH=/some/other/index.html node test/invoice-current-customer.test.js
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
function eq(actual, expected, label) { ok(actual === expected, label, { expected, actual }); }
function section(t) { console.log('\n' + t); }

/* ── lift the real code out of index.html (same loader shape as
      one-cent-reconciliation.test.js) ─────────────────────────────────── */
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
  let at = src.indexOf('\nfunction ' + name + '(');
  if (at < 0) at = src.indexOf('\nasync function ' + name + '(');
  if (at < 0) throw new Error('could not locate top-level function ' + name + ' in index.html');
  const start = at + 1;
  // Top-level functions in index.html close with a "}" in column 0. Prefer
  // that boundary (robust against regex literals such as /'/g that confuse
  // the masking counter); fall back to brace counting if it does not parse.
  const col0 = src.indexOf('\n}', start);
  if (col0 > 0) {
    const cand = src.slice(start, col0 + 2);
    try { new Function(cand); return cand; } catch (e) { /* fall through */ }
  }
  const win = src.slice(start, start + 60000);
  const wm = maskForCounting(win);
  // skip the parameter list first — destructured params contain braces
  let p = wm.indexOf('('), pd = 0;
  for (; p < wm.length; p++) {
    if (wm[p] === '(') pd++;
    else if (wm[p] === ')') { pd--; if (pd === 0) break; }
  }
  const open = wm.indexOf('{', p);
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
if (startIdx < 0) { console.error('Main babel script block not found in ' + INDEX_HTML_PATH); process.exit(1); }
const SRC = html.slice(startIdx + OPEN.length, html.lastIndexOf('</script>'));
const MASKED = maskForCounting(SRC);

const MOD_A = SRC.indexOf('BEGIN SGR-CANONICAL-CENTS');
const MOD_B = SRC.indexOf('/* END SGR-CANONICAL-CENTS */');
if (MOD_A < 0 || MOD_B < 0) { console.error('SGR-CANONICAL-CENTS sentinels not found in index.html'); process.exit(1); }
const MODULE_SRC = SRC.slice(SRC.lastIndexOf('/*', MOD_A), MOD_B + '/* END SGR-CANONICAL-CENTS */'.length);

const CONSTS = [
  'HOLDINGS_CO_ID', 'HOLDINGS_CO_KEY', 'QUOTE_DEFAULT_DEPOSIT_PCT',
  'SGR_INV_SETUP_FEE_DESC', 'SGR_INV_DISCOUNT_RE', 'SGR_INV_ADJ_EPSILON', 'SGR_INV_MONEY_TOLERANCE',
  'SGR_LEGAL_SUFFIX_RE',
  // 2026-11-16: generateAndEmailDocument checks the finished message against the mailbox limit
  'SGR_EMAIL_MAX_MESSAGE_BYTES',
];
const FNS = [
  // document plumbing
  'escapeHtml', 'sgrCompanyLegal', 'sgrJobInvoiceNumber', 'invoiceTermsList', 'quoteTermsList',
  'sgrLineHasDimensions', 'sgrLinePieceCount', 'lineSizeText', 'lineItemCount', 'lineItemCountText',
  'lineItemQtyDetail', 'docLinesSubtotal',
  'normalizeQuoteDepositPct', 'fmtQuoteDepositPct', 'quoteDepositInfo', 'quoteDepositTermsInfo',
  // customer lookups (old + new)
  'sgrCustomerVatLookup', 'sgrCustomerAddressLookup',
  'sgrLegalNameBase', 'sgrMatchInvoiceCustomer', 'sgrResolveInvoiceCustomer', 'sgrInvoiceWithCurrentCustomer',
  // 2026-11-24: invoice RECORD -> current customer (View / PDF / Email button)
  'sgrInvoiceRecordCustomer', 'sgrInvoiceRecordContactView',
  // 2026-11-24 (021): stable customer links
  'sgrCustRefOf', 'sgrCustNorm', 'sgrResolveCustomerRef', 'sgrDocCustomerLink', 'sgrCustomerFieldsFor', 'sgrApplyCustomerOverlay',
  // linkage used by the accInvoices printable adapter
  'companyTagOf', 'sameCompany', 'jobHasId', 'findCustomerByName', 'invoiceBelongsToJob',
  'resolveJobsForQuote', 'resolveJobForQuote', 'resolveQuoteForJob', 'resolveQuoteForInvoice',
  'findSourceQuoteForJob', 'findLinkedRecords',
  'sgrInvoiceLineAmount', 'sgrInvoiceAdjustmentKind', 'sgrSplitInvoiceLineItems', 'sgrInvoiceRecordToPrintable',
  // the builders and every entry point that reaches them
  'buildQuoteHtml', 'buildInvoiceHtml', 'printInvoice', 'printManualInvoice', 'printQuoteWindow',
  'generateDocumentPdfFromHtml', 'generateAndEmailDocument',
  'sgrFmtBytes',
];
// Browser-only side effects are replaced by recorders. Everything that
// decides WHAT is printed is the shipped code.
const STUBS = `
  const sgrOverlayCache = { key:null, value:null };
  const __rec = { previews: [], pdfHtml: [], cover: [], eml: [], downloads: [] };
  function sgrOpenPrintPreview(rawHtml, docLabel, docFileName){ __rec.previews.push({ html: rawHtml, docLabel, docFileName }); }
  function sgrLoadPrintMargins(){ return null; }
  function sgrApplyPrintMargins(h){ return h; }
  async function htmlToPdfBase64(h){ __rec.pdfHtml.push(h); return 'PDF'; }
  async function generateCoverLetterPdf(data){ __rec.cover.push(data); return 'COVER'; }
  function buildEmlFile(to, subject, body, attachments){ __rec.eml.push({ to, subject, body }); return 'EML'; }
  function downloadFile(c, f){ __rec.downloads.push(f); }
`;
const pieces = [STUBS];
for (const c of CONSTS) {
  // single-line regex constants are taken verbatim from their own line
  const line = new RegExp('^const\\s+' + c + '\\s*=\\s*/.*;\\s*$', 'm').exec(SRC);
  pieces.push(line ? line[0] : extractConst(SRC, MASKED, c));
}
pieces.push(MODULE_SRC);
for (const f of FNS) pieces.push(extractFunction(SRC, f));
pieces.push('return { __rec, sgrDocumentCents, sgrInvoiceCents, ' + FNS.join(',') + ' };');

let A;
try { A = new Function(pieces.join('\n'))(); }
catch (e) { console.error('Could not evaluate the lifted functions: ' + e.message); process.exit(1); }

console.log('SIGNACORE — INVOICE CURRENT-CUSTOMER REGRESSION SUITE');
console.log('source: ' + INDEX_HTML_PATH);

/* ── helpers over rendered documents ─────────────────────────────────── */
function billedTo(h) {
  const m = /<div class="box box-to">([\s\S]*?)<\/div>\s*<div class="box box-from">/.exec(h);
  return m ? m[1] : '';
}
function invTitle(h) {   // the invoice number printed in the document header
  const m = /<div class="inv-title">([^<]*)<\/div>/.exec(h);
  return m ? m[1] : '';
}
function itemTable(h) {
  const m = /<table class="ln">([\s\S]*?)<\/table>/.exec(h);
  return m ? m[1] : '';
}
function moneyOnly(h) {
  // The financial part of the page, with the customer block removed, so two
  // renders can be compared byte-for-byte for everything except the customer.
  return h.replace(/<div class="box box-to">[\s\S]*?<\/div>\s*(?=<div class="box box-from">)/, '')
          .replace(/<tr><td>Reference:<\/td><td>[^<]*<\/td><\/tr>/, '');
}
const deep = o => JSON.parse(JSON.stringify(o));
const COMPANIES = [{ id: 2, name: 'Signacore', short: 'SGR' }];

/* ── fixtures: the customer as it was when the invoice was issued, and after
      the user corrected it under Customers ───────────────────────────── */
const CUST_BEFORE = { id: 1700000000001.25, companyName: 'Acme Signs CC', contactPerson: 'Jan Botha',
  email: 'jan@acme.co.za', tel: '044 000 1111', address: '', vatNumber: '' };
const CUST_AFTER  = { ...CUST_BEFORE, address: '12 Voortrekker Rd\nGeorge 6529',
  contactPerson: 'Thandi Mokoena', email: 'accounts@acme.co.za', tel: '044 999 2222', vatNumber: '4990123456' };
// A DIFFERENT customer whose name is similar — must never be borrowed from.
const CUST_SIMILAR = { id: 1700000000002.5, companyName: 'Acme Signs', contactPerson: 'Other Person',
  email: 'other@acmesigns.co.za', tel: '021 111 1111', address: '99 Wrong Street, Cape Town', vatNumber: '4111111111' };

// A job converted from a quote while the customer's address was blank —
// exactly how the quote fields are snapshotted onto the job on conversion.
const JOB = {
  id: 11, num: 'SNS-00110', co: 2, quoteNum: 'SQ-00150',
  client: 'Acme Signs CC', contact: 'Jan Botha', email: 'jan@acme.co.za', tel: '044 000 1111',
  address: '', vatNum: '',
  invoiceNum: 'INV-00111', invoiceDate: '2026-09-01', invoiceDue: '2026-10-01', invoiceStatus: 'partial',
  discount: 10, setupFee: 750,
  lines: [
    { desc: 'Illuminated fascia sign', unit: 'm²', sqmL: 2000, sqmW: 900, pQty: 3, qty: 1.8, unitPrice: 1500, subtotal: 8100 },
    { desc: 'Vinyl window graphics',   unit: 'each', qty: 4, unitPrice: 250, subtotal: 1000 },
  ],
  payments: [{ date: '2026-09-02', method: 'EFT', amount: 5000, notes: 'Deposit' }],
};

/* ════════════════════════════════════════════════════════════════════════
   1–4  blank address -> edit customer -> regenerate -> new address shows
   ════════════════════════════════════════════════════════════════════ */
section('1–4. Job invoice issued with a blank address, customer then corrected');
const JOB_SNAPSHOT = deep(JOB);
const hBefore = A.buildInvoiceHtml(JOB, COMPANIES, null, [CUST_BEFORE]);
ok(!/Voortrekker/.test(billedTo(hBefore)), '[1] invoice created while the customer address is blank — no address printed');
const hAfter = A.buildInvoiceHtml(JOB, COMPANIES, null, [CUST_AFTER]);
ok(/12 Voortrekker Rd\nGeorge 6529/.test(billedTo(hAfter)), '[2–4] after editing the customer, the regenerated invoice prints the NEW address',
   billedTo(hAfter));

// The reported case proper: the job carries an OLD (wrong) non-blank address.
const JOB_OLD_ADDR = { ...JOB, address: 'Old Address 1, Mossel Bay' };
const hOld = A.buildInvoiceHtml(JOB_OLD_ADDR, COMPANIES, null, [CUST_AFTER]);
ok(/12 Voortrekker Rd/.test(billedTo(hOld)) && !/Old Address 1/.test(billedTo(hOld)),
   '[2–4] a stale NON-blank snapshot address is replaced by the corrected customer address (this was the bug)');

/* ════════════════════════════════════════════════════════════════════════
   5–11  the financial snapshot is untouched
   ════════════════════════════════════════════════════════════════════ */
section('5–11. Invoice number, date, lines and money are unchanged');
ok(invTitle(hAfter) === 'INV-00111' && invTitle(hBefore) === 'INV-00111', '[5] invoice number unchanged (INV-00111)', invTitle(hAfter));
ok(/2026-09-01/.test(hAfter) && /2026-10-01/.test(hAfter), '[6] invoice date and due date unchanged');
eq(itemTable(hAfter), itemTable(hBefore), '[7] invoice line-item table is byte-identical');
eq(moneyOnly(hAfter), moneyOnly(hBefore), '[8–11] subtotal, discount, setup fee, VAT, total, payments, balance — every non-customer byte identical');
const cents = A.sgrDocumentCents(JOB.lines, JOB.discount, JOB.setupFee);
const fmt = c => (c / 100).toFixed(2);
// sgrZarC formats with locale separators; compare on digits only.
const digits = s => s.replace(/[^0-9]/g, '');
ok(digits(hAfter).includes(digits(fmt(cents.totalC))), '[10] TOTAL DUE is still the canonical ' + fmt(cents.totalC));
ok(digits(hAfter).includes(digits(fmt(cents.vatC))), '[9] VAT is still the canonical ' + fmt(cents.vatC));
ok(digits(hAfter).includes(digits(fmt(cents.subC))), '[8] subtotal is still the canonical ' + fmt(cents.subC));
ok(digits(hAfter).includes(digits(fmt(cents.discC))) && digits(hAfter).includes(digits(fmt(cents.setupC))),
   '[11] discount ' + fmt(cents.discC) + ' and setup fee ' + fmt(cents.setupC) + ' unchanged');

/* ════════════════════════════════════════════════════════════════════════
   12  other existing customer-block fields refresh
   ════════════════════════════════════════════════════════════════════ */
section('12. Contact, email, telephone and VAT number refresh too');
const bt = billedTo(hAfter);
ok(/Attn: Thandi Mokoena/.test(bt) && !/Jan Botha/.test(bt), '[12] contact person refreshed');
ok(/accounts@acme\.co\.za/.test(bt) && !/jan@acme/.test(bt), '[12] email refreshed');
ok(/Tel: 044 999 2222/.test(bt), '[12] telephone refreshed');
ok(/VAT Reg: 4990123456/.test(bt), '[12] VAT number refreshed');
ok(/<div class="nm">Acme Signs CC<\/div>/.test(bt), '[12] Billed To name is the resolved customer\'s company name');
// relational-shaped customer rows carry `phone` rather than `tel`
const relShaped = { companyName: 'Acme Signs CC', phone: '044 777 0000' };
ok(/Tel: 044 777 0000/.test(billedTo(A.buildInvoiceHtml(JOB, COMPANIES, null, [relShaped]))),
   '[12] a customer row that stores phone (relational shape) is read too');
// a blank customer field never blanks a detail the invoice already showed
const sparse = { companyName: 'Acme Signs CC', address: 'New Addr' };
const bSparse = billedTo(A.buildInvoiceHtml(JOB, COMPANIES, null, [sparse]));
ok(/New Addr/.test(bSparse) && /jan@acme\.co\.za/.test(bSparse) && /Jan Botha/.test(bSparse),
   '[12] customer fields that are blank keep the invoice\'s stored values');

/* ════════════════════════════════════════════════════════════════════════
   13–14  link strength: same customer, never a look-alike
   ════════════════════════════════════════════════════════════════════ */
section('13–14. The invoice stays with the SAME customer; no loose matching');
const hSim = billedTo(A.buildInvoiceHtml(JOB, COMPANIES, null, [CUST_SIMILAR, CUST_AFTER]));
ok(/Voortrekker/.test(hSim) && !/Wrong Street/.test(hSim) && !/Other Person/.test(hSim),
   '[13] "Acme Signs CC" resolves to Acme Signs CC, never to the similar "Acme Signs"');
eq(A.sgrResolveInvoiceCustomer('  acme signs cc ', [CUST_SIMILAR, CUST_AFTER]), CUST_AFTER,
   '[13] resolver returns the exact customer record (trim + case-insensitive, whole name)');
eq(A.sgrResolveInvoiceCustomer('Acme', [CUST_AFTER]), null, '[14] substring of a customer name does NOT link');
eq(A.sgrResolveInvoiceCustomer('Acme Signs CC Holdings', [CUST_AFTER]), null, '[14] superstring of a customer name does NOT link');
eq(A.sgrResolveInvoiceCustomer('Thandi Mokoena', [CUST_AFTER]), null, '[14] a contact-person name does NOT link');
const DUP = [CUST_AFTER, { ...CUST_SIMILAR, companyName: 'ACME SIGNS CC ' }];
eq(A.sgrResolveInvoiceCustomer('Acme Signs CC', DUP), null, '[14] two customers sharing the name -> ambiguous -> no link');
const hDup = billedTo(A.buildInvoiceHtml(JOB_OLD_ADDR, COMPANIES, null, DUP));
ok(/Old Address 1/.test(hDup) && /jan@acme\.co\.za/.test(hDup), '[14] ambiguous name keeps the invoice\'s stored snapshot');

/* ════════════════════════════════════════════════════════════════════════
   15  Quote behaviour unchanged
   ════════════════════════════════════════════════════════════════════ */
section('15. Quote document unchanged');
const QUOTE = { id: 77, num: 'SQ-00150', co: 2, client: 'Acme Signs CC', contact: 'Jan Botha',
  email: 'jan@acme.co.za', tel: '044 000 1111', address: 'Quote Stored Address', vatNum: '',
  date: '2026-08-01', validUntil: '2026-08-15', discount: 10, setupFee: 750, lines: deep(JOB.lines) };
const QUOTE_SNAP = deep(QUOTE);
const qh = A.buildQuoteHtml(QUOTE, COMPANIES, null);
ok(/Quote Stored Address/.test(qh) && /Jan Botha/.test(qh), '[15] quote prints its own stored client fields, as before');
eq(A.buildQuoteHtml.length, 3, '[15] buildQuoteHtml signature unchanged (q, companies, logo) — no customer lookup added');
ok(!/sgrInvoiceWithCurrentCustomer|sgrResolveInvoiceCustomer/.test(extractFunction(SRC, 'buildQuoteHtml')),
   '[15] buildQuoteHtml does not use the invoice customer resolver');
ok(JSON.stringify(QUOTE) === JSON.stringify(QUOTE_SNAP), '[15] quote object not mutated');

/* ════════════════════════════════════════════════════════════════════════
   16–17  accInvoices records (standalone / linked / unlinked)
   ════════════════════════════════════════════════════════════════════ */
section('16–17. Accounting invoices');
const INV_MANUAL = {
  id: 503, number: 'INV-00113', co: 2, date: '2026-09-05', dueDate: '2026-10-05',
  contactName: 'Acme Signs CC', contactEmail: 'jan@acme.co.za', contactAddress: '',
  reference: 'Retainer', jobNum: '', quoteNum: '', status: 'sent',
  lineItems: [
    { description: 'Monthly maintenance', qty: 1, unitAmount: 4000, accountCode: '4000', taxType: '15%' },
    { description: 'Exempt pass-through', qty: 1, unitAmount: 300,  accountCode: '4000', taxType: 'Exempt' },
  ],
  payments: [],
};
const INV_SNAP = deep(INV_MANUAL);
A.__rec.previews.length = 0;
A.printManualInvoice(INV_MANUAL, COMPANIES, null, { quotes: [], jobs: [], accInvoices: [INV_MANUAL], customers: [CUST_AFTER] });
const mh = A.__rec.previews[0].html;
const mbt = billedTo(mh);
ok(/12 Voortrekker Rd/.test(mbt) && /accounts@acme\.co\.za/.test(mbt) && /Thandi Mokoena/.test(mbt) && /4990123456/.test(mbt),
   '[16] standalone Accounting invoice linked to a customer prints the current customer details');
const mic = A.sgrInvoiceCents(INV_MANUAL.lineItems);
ok(digits(mh).includes(digits(fmt(mic.totalC))) && digits(mh).includes(digits(fmt(mic.vatC))),
   '[16] its canonical total ' + fmt(mic.totalC) + ' and per-line-taxType VAT ' + fmt(mic.vatC) + ' are unchanged');
eq(A.__rec.previews[0].docFileName, 'INV-00113', '[16] PDF file name still the invoice number');

const INV_UNLINKED = { ...deep(INV_MANUAL), id: 504, number: 'INV-00114', contactName: 'Walk-in Customer',
  contactEmail: 'walkin@example.co.za' };
A.__rec.previews.length = 0;
A.printManualInvoice(INV_UNLINKED, COMPANIES, null, { quotes: [], jobs: [], accInvoices: [], customers: [CUST_AFTER, CUST_SIMILAR] });
const ubt = billedTo(A.__rec.previews[0].html);
ok(/Walk-in Customer/.test(ubt) && /walkin@example\.co\.za/.test(ubt) && !/Voortrekker|Wrong Street/.test(ubt),
   '[17] invoice with no matching customer prints its stored snapshot, nothing borrowed');
const hHist = billedTo(A.buildInvoiceHtml({ ...JOB_OLD_ADDR, client: 'Closed Account (Pty) Ltd' }, COMPANIES, null, [CUST_AFTER]));
ok(/Old Address 1/.test(hHist) && /Closed Account/.test(hHist), '[17] historical job invoice whose customer no longer exists keeps its stored values');
const hNoCust = billedTo(A.buildInvoiceHtml(JOB_OLD_ADDR, COMPANIES, null, undefined));
ok(/Old Address 1/.test(hNoCust), '[17] caller that passes no customers list still prints the stored snapshot');

/* ════════════════════════════════════════════════════════════════════════
   18  every invoice output path uses the same rule
   ════════════════════════════════════════════════════════════════════ */
section('18. Print / Preview / Download / Email resolve the customer identically');
A.__rec.previews.length = 0;
A.printInvoice(JOB_OLD_ADDR, COMPANIES, null, [CUST_AFTER]);
const printBt = billedTo(A.__rec.previews[0].html);
ok(/Voortrekker/.test(printBt), '[18] printInvoice (Print + Preview window + Download PDF from it)');

(async () => {
  Object.keys(A.__rec).forEach(k => { A.__rec[k].length = 0; });
  await A.generateAndEmailDocument('invoice', JOB_OLD_ADDR, COMPANIES, null, null, [CUST_AFTER]);
  const emailBt = billedTo(A.__rec.pdfHtml[0] || '');
  eq(emailBt, printBt, '[18] emailed PDF customer block === printed customer block');
  eq(A.__rec.eml[0] && A.__rec.eml[0].to, 'accounts@acme.co.za', '[18] email is addressed to the current customer email');
  ok(A.__rec.cover[0] && /Voortrekker/.test(A.__rec.cover[0].address) && A.__rec.cover[0].contact === 'Thandi Mokoena',
     '[18] cover letter receives the same current customer details');
  eq(A.__rec.downloads[0], 'Invoice_INV-00111.eml', '[18] .eml file name unchanged');
  eq(moneyOnly(A.__rec.pdfHtml[0]), moneyOnly(A.__rec.previews.length ? A.__rec.previews[0].html : A.buildInvoiceHtml(JOB_OLD_ADDR, COMPANIES, null, [CUST_AFTER])),
     '[18] emailed PDF money === printed money');

  // Quote / Proforma email flows are untouched by the invoice rule.
  Object.keys(A.__rec).forEach(k => { A.__rec[k].length = 0; });
  await A.generateAndEmailDocument('quote', QUOTE, COMPANIES, null, null, [CUST_AFTER]);
  ok(/Quote Stored Address/.test(A.__rec.pdfHtml[0]) && A.__rec.eml[0].to === 'jan@acme.co.za',
     '[15/18] emailed QUOTE still uses the quote\'s own fields');

  // Source wiring: every invoice entry point hands the customers list down.
  // (comment mentions such as "printInvoice(job,…)" are not call sites)
  const isCall = s => !/\.\.\.|…|\(\)$/.test(s);
  const printCalls = (SRC.match(/printInvoice\([^)]*\)/g) || []).filter(isCall).filter(s => s !== 'printInvoice(job, companies, logoDataUrl, customers)');
  ok(printCalls.length > 0 && printCalls.every(s => /customers\)$/.test(s)),
     '[18] every printInvoice(…) call site passes customers (' + printCalls.length + ' sites)', printCalls.filter(s => !/customers\)$/.test(s)));
  const manualCalls = (SRC.match(/printManualInvoice\([^)]*\)/g) || []).filter(isCall).filter(s => !/^printManualInvoice\(inv, companies, logoDataUrl, ctx\)$/.test(s));
  ok(manualCalls.length > 0 && manualCalls.every(s => /customers\}\)$/.test(s)),
     '[18] every printManualInvoice(…) call site passes customers in ctx (' + manualCalls.length + ' sites)', manualCalls.filter(s => !/customers\}\)$/.test(s)));
  const emailInv = SRC.match(/<EmailFlowModal\s+type="invoice"[^>]*>/g) || [];
  ok(emailInv.length > 0 && emailInv.every(s => /customers=\{customers\}/.test(s)),
     '[18] every invoice EmailFlowModal passes customers (' + emailInv.length + ' sites)');
  // 2026-11-16: the call gained a trailing argument (the quotation's extra
  // attachments). `customers` is still forwarded in the same position.
  ok(/generateAndEmailDocument\(type, data, companies, logoDataUrl, onMarkSent, customers(?:, extras)?\)/.test(extractFunction(SRC, 'EmailFlowModal')),
     '[18] EmailFlowModal forwards customers to generateAndEmailDocument');

  /* ══════════════════════════════════════════════════════════════════════
     19–20  nothing financial is written or re-derived
     ══════════════════════════════════════════════════════════════════ */
  section('19–20. No mutation, no money change, settlement untouched');
  ok(JSON.stringify(JOB) === JSON.stringify(JOB_SNAPSHOT), '[19] the job/invoice object passed in is not mutated');
  ok(JSON.stringify(INV_MANUAL) === JSON.stringify(INV_SNAP), '[19] the accInvoices record passed in is not mutated');
  const out = A.sgrInvoiceWithCurrentCustomer(JOB_OLD_ADDR, [CUST_AFTER]);
  ok(out !== JOB_OLD_ADDR, '[19] resolver returns a copy, never the stored record');
  const changed = Object.keys(out).filter(k => JSON.stringify(out[k]) !== JSON.stringify(JOB_OLD_ADDR[k]));
  ok(changed.every(k => ['contact', 'email', 'tel', 'address', 'vatNum', '_billToName'].includes(k)),
     '[19] only customer-block keys differ on the copy', changed);
  ['num', 'invoiceNum', 'invoiceDate', 'invoiceDue', 'invoiceStatus', 'lines', 'discount', 'setupFee', 'payments', 'co', 'quoteNum', 'client']
    .forEach(k => ok(JSON.stringify(out[k]) === JSON.stringify(JOB_OLD_ADDR[k]), '[19] ' + k + ' carried through unchanged'));
  const pr = A.sgrInvoiceRecordToPrintable(INV_MANUAL, { customers: [CUST_AFTER] });
  const pr2 = A.sgrInvoiceWithCurrentCustomer(pr, [CUST_AFTER]);
  ok(pr2._sgrTotals === pr._sgrTotals, '[19] accInvoices pre-computed canonical totals (_sgrTotals) passed through by reference');
  eq(moneyOnly(A.buildInvoiceHtml(JOB, COMPANIES, null, [])), moneyOnly(A.buildInvoiceHtml(JOB, COMPANIES, null, [CUST_AFTER])),
     '[19] with or without a customer list, the financial part of the page is identical');
  const resolverSrc = extractFunction(SRC, 'sgrResolveInvoiceCustomer') + extractFunction(SRC, 'sgrInvoiceWithCurrentCustomer');
  ok(!/sgrSettle|sgrLegacy|legacyRoundingSettlement|rel_payments|sgrDocumentCents|sgrInvoiceCents|setCustomers|setJobs|setAccInvoices|relationalApi|fetch\(/.test(resolverSrc),
     '[20] resolver touches no settlement, rounding, persistence or API code');

  /* ══════════════════════════════════════════════════════════════════════
     L1–L10  legal-suffix equivalence (Hennies Witbank -> (Pty) Ltd)
     ══════════════════════════════════════════════════════════════════ */
  section('L1–L10. Renamed customer: trailing legal-suffix equivalence only');
  const R = A.sgrResolveInvoiceCustomer;
  const HEN = { id: 900.5, companyName: 'Hennies Witbank (Pty) Ltd', contactPerson: 'Pieter Hennie',
    email: 'accounts@hennies.co.za', tel: '013 656 0000', address: '5 Mandela St\nWitbank 1035', vatNumber: '4220111222' };
  const HEN_SIGNS = { id: 901.5, companyName: 'Hennies Witbank Signs', contactPerson: 'X', email: 'x@signs.co.za',
    tel: '013 000 0000', address: 'Signs Rd', vatNumber: '4000000000' };
  const HEN_JOB = { ...deep(JOB), client: 'Hennies Witbank', contact: 'Old Contact', email: 'old@hennies.co.za',
    tel: '013 111 1111', address: 'Old Witbank Address', vatNum: '', invoiceNum: 'INV-00200' };
  const HEN_JOB_SNAP = deep(HEN_JOB);

  eq(R('Hennies Witbank', [HEN, HEN_SIGNS, CUST_AFTER]), HEN, '[L1] "Hennies Witbank" resolves uniquely to "Hennies Witbank (Pty) Ltd"');
  ['Hennies Witbank (Pty) Ltd', 'Hennies Witbank Pty Ltd', 'Hennies Witbank (Pty) Limited', 'Hennies Witbank Pty Limited',
   'Hennies Witbank (PTY) LTD', 'Hennies Witbank (Pty) Ltd.', 'Hennies Witbank, (Pty) Ltd', 'Hennies Witbank (Pty.) Ltd',
   'Hennies Witbank(Pty) Ltd', '  hennies witbank  (pty)  ltd  ']
    .forEach(v => eq(R(v, [{ ...HEN, companyName: 'Hennies Witbank' }]) !== null, true, '[L2] "' + v + '" -> customer "Hennies Witbank"'));
  eq(R('Hennies Witbank Pty Ltd', [HEN]), HEN, '[L2] "Pty Ltd" invoice name -> "(Pty) Ltd" customer');

  const henHtml = A.buildInvoiceHtml(HEN_JOB, COMPANIES, null, [HEN, HEN_SIGNS]);
  const hbt = billedTo(henHtml);
  ok(/<div class="nm">Hennies Witbank \(Pty\) Ltd<\/div>/.test(hbt), '[L3] Billed To prints the CURRENT company name "Hennies Witbank (Pty) Ltd"', hbt);
  ok(/5 Mandela St\nWitbank 1035/.test(hbt) && /Attn: Pieter Hennie/.test(hbt) && /accounts@hennies\.co\.za/.test(hbt)
     && /Tel: 013 656 0000/.test(hbt) && /VAT Reg: 4220111222/.test(hbt) && !/Old /.test(hbt),
     '[L4] current address / contact / email / tel / VAT all print');
  ok(!/Signs Rd|x@signs/.test(hbt), '[L4] nothing borrowed from "Hennies Witbank Signs"');

  eq(R('Hennies Witbank', [HEN_SIGNS]), null, '[L5] "Hennies Witbank" does NOT match "Hennies Witbank Signs"');
  eq(R('Hennies Witbank Signs', [HEN]), null, '[L5] "Hennies Witbank Signs" does NOT match "Hennies Witbank (Pty) Ltd"');
  eq(R('Hennies', [HEN]), null, '[L6] "Hennies" does NOT match "Hennies Witbank (Pty) Ltd"');
  eq(R('Witbank', [HEN]), null, '[L6] "Witbank" does NOT match "Hennies Witbank (Pty) Ltd"');
  eq(R('Hennies', [{ ...HEN, companyName: 'Hennies Witbank' }]), null, '[L6] "Hennies" does NOT match "Hennies Witbank"');
  eq(R('Hennies (Pty) Ltd', [{ ...HEN, companyName: 'Hennies Witbank' }]), null, '[L6] suffix on a shorter name does not match a longer name');
  eq(R('Hennies Witbank CC', [HEN]), null, '[L6] other suffixes (CC) are not treated as equivalent');
  eq(R('Hennies Witbank Holdings (Pty) Ltd', [HEN]), null, '[L6] extra words before the suffix do not match');
  eq(R('(Pty) Ltd', [{ ...HEN, companyName: 'Pty Ltd' }]), null, '[L6] a name that is only a suffix never matches');
  eq(R('Pieter Hennie', [HEN]), null, '[L6] contact-person name still does not link');
  eq(R('Hennies Witbank', [{ ...HEN, companyName: 'Hennies Witbank.' }]), null, '[L6] punctuation alone (no legal suffix) is not a second-choice match');

  const HEN_DUP = { ...HEN, id: 902.5, companyName: 'Hennies Witbank Pty Limited', address: 'Second Record Address' };
  eq(R('Hennies Witbank', [HEN, HEN_DUP]), null, '[L7] two customers with the same base name -> no match');
  const dupBt = billedTo(A.buildInvoiceHtml(HEN_JOB, COMPANIES, null, [HEN, HEN_DUP]));
  ok(/<div class="nm">Hennies Witbank<\/div>/.test(dupBt) && /Old Witbank Address/.test(dupBt) && !/Mandela|Second Record/.test(dupBt),
     '[L7] ambiguous base name -> invoice prints its stored details');

  const HEN_EXACT = { ...HEN, id: 903.5, companyName: 'Hennies Witbank', address: 'Exact Record Address' };
  eq(R('Hennies Witbank', [HEN, HEN_EXACT]), HEN_EXACT, '[L8] exact name wins over a suffix-equivalent customer');
  eq(R('Hennies Witbank (Pty) Ltd', [HEN_EXACT, HEN]), HEN, '[L8] exact name wins in the other direction too');
  eq(R('Hennies Witbank', [HEN_EXACT, { ...HEN_EXACT, id: 904.5 }, HEN]), null,
     '[L8] an AMBIGUOUS exact name never falls through to the suffix rule');

  const unBt = billedTo(A.buildInvoiceHtml({ ...HEN_JOB, client: 'Hennies Middelburg' }, COMPANIES, null, [HEN]));
  ok(/<div class="nm">Hennies Middelburg<\/div>/.test(unBt) && /Old Witbank Address/.test(unBt) && /old@hennies/.test(unBt),
     '[L9] unmatched historical invoice prints its stored name and details');

  const henNoCust = A.buildInvoiceHtml(HEN_JOB, COMPANIES, null, []);
  eq(invTitle(henHtml), 'INV-00200', '[L10] invoice number unchanged');
  ok(/2026-09-01/.test(henHtml) && /2026-10-01/.test(henHtml), '[L10] invoice / due dates unchanged');
  eq(itemTable(henHtml), itemTable(henNoCust), '[L10] line items identical');
  eq(moneyOnly(henHtml), moneyOnly(henNoCust), '[L10] every money / document byte outside the customer block identical');
  ok(/<tr><td>Reference:<\/td><td>INV-00200 \/ Hennies Witbank<\/td><\/tr>/.test(henHtml),
     '[L10] payment Reference row keeps the stored invoice name');
  ok(JSON.stringify(HEN_JOB) === JSON.stringify(HEN_JOB_SNAP), '[L10] stored invoice/job object not modified');
  const henCopy = A.sgrInvoiceWithCurrentCustomer(HEN_JOB, [HEN]);
  eq(henCopy.client, 'Hennies Witbank', '[L10] the copy\'s client (stored name) is not rewritten');
  const henInv = { ...deep(INV_MANUAL), id: 600, number: 'INV-00201', contactName: 'Hennies Witbank', contactEmail: 'old@hennies.co.za' };
  const henInvSnap = deep(henInv);
  A.__rec.previews.length = 0;
  A.printManualInvoice(henInv, COMPANIES, null, { quotes: [], jobs: [], accInvoices: [henInv], customers: [HEN] });
  const mhb = billedTo(A.__rec.previews[0].html);
  ok(/Hennies Witbank \(Pty\) Ltd/.test(mhb) && /Mandela/.test(mhb), '[L3/L4] Accounting invoice under the old name prints the current customer');
  ok(JSON.stringify(henInv) === JSON.stringify(henInvSnap), '[L10] stored accInvoices record not modified');

  /* ══════════════════════════════════════════════════════════════════════
     P1–P10  apostrophe-insensitive SECOND-choice comparison (actual case)
     ══════════════════════════════════════════════════════════════════ */
  section("P1–P10. Actual case: \"Hennie's Witbank\" -> \"Hennies Witbank (PTY) Ltd\"");
  // Fixture values are test data only — nothing is hard-coded in index.html.
  const HW = { id: 1750000000123.4, companyName: 'Hennies Witbank (PTY) Ltd', contactPerson: 'Current Contact',
    email: 'current@hennieswitbank.co.za', tel: '013 690 1234',
    address: 'Stand 12, Corridor Hill, Langa Cres. Witbank, Mpumalanga, 1035', vatNumber: '4730000001' };
  const HW_INV_JOB = { ...deep(JOB), client: "Hennie's Witbank", contact: 'Stored Contact', email: 'stored@old.co.za',
    tel: '013 000 0001', address: 'Stored Old Address', vatNum: '', invoiceNum: 'INV-00300', quoteNum: 'SQ-00300',
    reference: 'PO-300' };
  const HW_SNAP = deep(HW_INV_JOB);

  eq(R("Hennie's Witbank", [HW, CUST_AFTER, HEN_SIGNS]), HW, "[P1] \"Hennie's Witbank\" resolves to \"Hennies Witbank (PTY) Ltd\"");
  eq(R('Hennie’s Witbank', [HW]), HW, '[P2] curly apostrophe (’) works');
  eq(R("Hennie's Witbank", [HW]), HW, "[P2] straight apostrophe (') works");
  eq(R('Hennies Witbank', [{ ...HW, companyName: "Hennie's Witbank (Pty) Ltd" }]) !== null, true, '[P2] apostrophe on the CUSTOMER side works too');

  const hwHtml = A.buildInvoiceHtml(HW_INV_JOB, COMPANIES, null, [HW, HEN_SIGNS]);
  const hwBt = billedTo(hwHtml);
  ok(/<div class="nm">Hennies Witbank \(PTY\) Ltd<\/div>/.test(hwBt), '[P3] Billed To prints "Hennies Witbank (PTY) Ltd"', hwBt);
  ok(/Stand 12, Corridor Hill, Langa Cres\. Witbank, Mpumalanga, 1035/.test(hwBt) && !/Stored Old Address/.test(hwBt),
     '[P4] current customer address prints');
  ok(/Attn: Current Contact/.test(hwBt) && /current@hennieswitbank\.co\.za/.test(hwBt) && /Tel: 013 690 1234/.test(hwBt)
     && /VAT Reg: 4730000001/.test(hwBt) && !/Stored /.test(hwBt), '[P5] current contact / email / tel / VAT print');

  const HW_SIGNS = { ...HEN_SIGNS, companyName: 'Hennies Witbank Signs (Pty) Ltd' };
  eq(R("Hennie's Witbank", [HW_SIGNS]), null, "[P6] \"Hennie's Witbank\" does NOT match \"Hennies Witbank Signs (Pty) Ltd\"");
  eq(R("Hennie's", [HW]), null, "[P7] \"Hennie's\" does NOT match \"Hennies Witbank (PTY) Ltd\"");
  eq(R('Witbank', [HW]), null, '[P7] "Witbank" does NOT match');
  eq(R('Hennies Witbank Holdings', [HW]), null, '[P7] "Hennies Witbank Holdings" does NOT match');
  eq(R("Hennie's Witbanks", [HW]), null, '[P7] a one-letter difference other than the apostrophe does NOT match');
  eq(R("Hennie s Witbank", [HW]), null, '[P7] apostrophe replaced by a space does NOT match');
  eq(R('Hennie`s Witbank', [HW]), null, '[P7] other characters (backtick) are not treated as apostrophes');
  eq(R("Hennie's Witbank", [{ ...HW, companyName: 'Hennies Witbank' }]), null,
     '[P7] apostrophe-only difference with NO legal suffix stays unmatched (second choice still requires the suffix)');

  const HW_DUP = { ...HW, id: 1750000000999.1, companyName: 'Hennies Witbank Pty Ltd', address: 'Duplicate Record Address' };
  eq(R("Hennie's Witbank", [HW, HW_DUP]), null, '[P8] two customers normalising to the same base -> no match');
  const dupHw = billedTo(A.buildInvoiceHtml(HW_INV_JOB, COMPANIES, null, [HW, HW_DUP]));
  ok(/<div class="nm">Hennie's Witbank<\/div>/.test(dupHw) && /Stored Old Address/.test(dupHw) && !/Stand 12|Duplicate Record/.test(dupHw),
     '[P8] ambiguous -> invoice prints its stored details');

  const HW_EXACT = { ...HW, id: 1750000000555.5, companyName: "Hennie's Witbank", address: 'Exact Apostrophe Record' };
  eq(R("Hennie's Witbank", [HW, HW_EXACT]), HW_EXACT, '[P9] exact "Hennie\'s Witbank" customer wins over the normalised match');
  eq(R("Hennie's Witbank", [HW_EXACT, { ...HW_EXACT, id: 1 }, HW]), null, '[P9] ambiguous exact name never falls through');

  const hwNone = A.buildInvoiceHtml(HW_INV_JOB, COMPANIES, null, []);
  eq(invTitle(hwHtml), 'INV-00300', '[P10] invoice number unchanged');
  ok(/2026-09-01/.test(hwHtml) && /2026-10-01/.test(hwHtml), '[P10] invoice date and due date unchanged');
  eq(itemTable(hwHtml), itemTable(hwNone), '[P10] line items, quantities and prices identical');
  eq(moneyOnly(hwHtml), moneyOnly(hwNone), '[P10] subtotal / discount / setup fee / VAT / total / payments / quote ref identical');
  ok(/<tr><td>Reference:<\/td><td>INV-00300 \/ Hennie's Witbank<\/td><\/tr>/.test(hwHtml), '[P10] Reference row keeps the stored client name');
  ok(JSON.stringify(HW_INV_JOB) === JSON.stringify(HW_SNAP), '[P10] stored invoice/job object (client, numbers, lines, payments) not modified');
  const hwAcc = { ...deep(INV_MANUAL), id: 700, number: 'INV-00301', contactName: 'Hennie’s Witbank', contactEmail: 'stored@old.co.za' };
  const hwAccSnap = deep(hwAcc);
  A.__rec.previews.length = 0;
  A.printManualInvoice(hwAcc, COMPANIES, null, { quotes: [], jobs: [], accInvoices: [hwAcc], customers: [HW] });
  const hwAccBt = billedTo(A.__rec.previews[0].html);
  ok(/Hennies Witbank \(PTY\) Ltd/.test(hwAccBt) && /Stand 12, Corridor Hill/.test(hwAccBt), '[P3/P4] Accounting invoice (curly apostrophe) prints current name + address');
  ok(JSON.stringify(hwAcc) === JSON.stringify(hwAccSnap), '[P10] stored accInvoices record not modified');


  /* ══════════════════════════════════════════════════════════════════════
     R1–R14 (2026-11-24): an invoice RECORD (accInvoices / rel_invoices) shows
     the current customer on its View screen, PDF and Email button — the same
     rule a job's documents already followed.
     ══════════════════════════════════════════════════════════════════ */
  section('R1–R14. Invoice records follow customer edits (View / PDF / Email)');
  const EMAIL_FN = extractFunction(SRC, 'emailManualInvoiceViaOutlook');
  const mailtoFor = (inv, ctx) => {
    const win = { location: { href: '' } };
    new Function('window', 'sgrInvoiceRecordContactView', EMAIL_FN + '\nreturn emailManualInvoiceViaOutlook;')(win, A.sgrInvoiceRecordContactView)(inv, COMPANIES, ctx);
    const u = win.location.href; const q = u.indexOf('?');
    const params = new URLSearchParams(u.slice(q + 1));
    return { to: decodeURIComponent(u.slice('mailto:'.length, q)), subject: params.get('subject'), body: params.get('body') };
  };
  const printOf = (inv, ctx) => { A.__rec.previews.length = 0; A.printManualInvoice(inv, COMPANIES, null, ctx); return A.__rec.previews[0].html; };
  // A job-derived invoice record as the read layer serves it: the customer
  // snapshot taken when it was raised (old contact, old email, old address).
  const RJOB = { ...deep(JOB), id: 41, num: 'SNS-00410', invoiceNum: 'INV-00410' };
  const RINV = { id: 410, number: 'INV-00410', co: 2, date: '2026-09-01', dueDate: '2026-10-01',
    contactName: 'Acme Signs CC', contactEmail: 'jan@acme.co.za', contactAddress: 'Old Street 1, Mossel Bay',
    reference: 'SNS-00410', jobNum: 'SNS-00410', quoteNum: 'SQ-00150', status: 'partial',
    lineItems: [ { description: 'Illuminated fascia sign', qty: 1, unitAmount: 8100, accountCode: '4000', taxType: '15%' } ],
    payments: [ { date: '2026-09-02', method: 'EFT', amount: 5000 } ] };
  const RSNAP = deep(RINV);
  const ctxAfter = { quotes: [], jobs: [RJOB], accInvoices: [RINV], customers: [CUST_AFTER, CUST_SIMILAR] };
  const v1 = A.sgrInvoiceRecordContactView(RINV, ctxAfter);
  eq(v1.state, 'matched', '[R1] job-derived invoice record resolves to its customer');
  ok(v1.email === 'accounts@acme.co.za' && v1.address === CUST_AFTER.address && v1.person === 'Thandi Mokoena' && v1.tel === '044 999 2222',
     '[R1] View data = current email / address / contact / tel', v1);
  const p1 = printOf(RINV, ctxAfter), bt1 = billedTo(p1);
  ok(/12 Voortrekker Rd/.test(bt1) && /Thandi Mokoena/.test(bt1) && /accounts@acme\.co\.za/.test(bt1) && !/Old Street|jan@acme/.test(bt1),
     '[R2] PDF Billed To = current customer', bt1);
  const p1none = printOf(RINV, { ...ctxAfter, customers: [] });
  ok(/Old Street 1, Mossel Bay/.test(billedTo(p1none)), '[R11] no customer on file -> the invoice\'s own stored address prints (was dropped before)');
  eq(itemTable(p1), itemTable(p1none), '[R2] lines identical with and without the customer');
  eq(moneyOnly(p1), moneyOnly(p1none), '[R2] totals / VAT / payments / numbers identical');
  eq(invTitle(p1), 'INV-00410', '[R2] invoice number unchanged');
  const m1 = mailtoFor(RINV, ctxAfter);
  ok(m1.to === 'accounts@acme.co.za' && /Tax Invoice INV-00410 - Acme Signs CC/.test(m1.subject) && /^Dear Acme Signs CC,/.test(m1.body),
     '[R3] Email button: To = current email, subject/greeting = current name', m1);
  const m1old = mailtoFor(RINV, undefined);
  eq(m1old.to, 'jan@acme.co.za', '[R3] called without context (old callers) -> stored email, no crash');
  ok(JSON.stringify(RINV) === JSON.stringify(RSNAP), '[R10] invoice record not modified by View / PDF / Email');

  // Older linkage: the stored invoice name never matched a customer, but its
  // linked job (same company) names one exactly.
  const OLD = { ...deep(RINV), id: 411, number: 'INV-00031', contactName: 'Acme (old name)', contactEmail: 'old@acme.co.za', contactAddress: '' };
  const vOld = A.sgrInvoiceRecordContactView(OLD, ctxAfter);
  ok(vOld.state === 'matched' && vOld.via === 'job' && vOld.email === 'accounts@acme.co.za', '[R4] older invoice resolves through its linked job', vOld);
  ok(/12 Voortrekker Rd/.test(billedTo(printOf(OLD, ctxAfter))), '[R4] older invoice PDF prints current address');
  ok(/<div class="nm">Acme Signs CC<\/div>/.test(billedTo(printOf(OLD, ctxAfter))), '[R4] older invoice prints the current customer name');
  const OTHER_CO_JOB = { ...deep(RJOB), co: 1 };
  eq(A.sgrInvoiceRecordContactView(OLD, { ...ctxAfter, jobs: [OTHER_CO_JOB] }).state, 'none', '[R5] a same-numbered job in the OTHER company is never used');
  const quoteOnly = { id: 9, num: 'SQ-00150', co: 2, client: 'Acme Signs CC', lines: [] };
  const vQ = A.sgrInvoiceRecordContactView({ ...OLD, jobNum: '', reference: '' }, { ...ctxAfter, jobs: [], quotes: [quoteOnly] });
  ok(vQ.state === 'matched' && vQ.via === 'quote', '[R4] quote-sourced older invoice resolves through its linked quote', vQ);

  // Ambiguity is explicit and never guessed.
  const DUP = { ...CUST_AFTER, id: 1700000000009.5, email: 'dup@acme.co.za', address: 'Duplicate Address' };
  const vAmb = A.sgrInvoiceRecordContactView(RINV, { ...ctxAfter, customers: [CUST_AFTER, DUP] });
  ok(vAmb.state === 'ambiguous' && vAmb.count === 2 && vAmb.email === 'jan@acme.co.za' && vAmb.address === 'Old Street 1, Mossel Bay',
     '[R6] two customers named alike -> ambiguous, stored details shown', vAmb);
  ok(/Old Street 1/.test(billedTo(printOf(RINV, { ...ctxAfter, customers: [CUST_AFTER, DUP] }))), '[R6] ambiguous -> PDF prints stored details');
  eq(mailtoFor(RINV, { ...ctxAfter, customers: [CUST_AFTER, DUP] }).to, 'jan@acme.co.za', '[R6] ambiguous -> Email uses stored address');
  const OLD_AMB = { ...OLD, contactName: 'Acme Signs CC' };
  eq(A.sgrInvoiceRecordCustomer(OLD_AMB, { ...ctxAfter, customers: [CUST_AFTER, DUP] }).state, 'ambiguous', '[R12] an ambiguous invoice name does not fall through to the job link');
  const OTHER = { ...CUST_SIMILAR, id: 77, companyName: 'Other Client' };
  const vDis = A.sgrInvoiceRecordCustomer({ ...OLD }, { ...ctxAfter, quotes: [{ ...quoteOnly, client: 'Other Client' }], customers: [CUST_AFTER, OTHER] });
  eq(vDis.state, 'ambiguous', '[R7] linked job and linked quote name different customers -> ambiguous');
  eq(A.sgrInvoiceRecordCustomer({ ...OLD, contactName: 'Acme Signs' }, ctxAfter).customer, CUST_SIMILAR,
     '[R13] the invoice\'s own exact name outranks its links (similar names stay separate)');

  // Cancelled invoices keep the details they were issued with.
  const VOID = { ...deep(RINV), id: 412, status: 'void', originalDetailRetained: true };
  const vVoid = A.sgrInvoiceRecordContactView(VOID, ctxAfter);
  ok(vVoid.state === 'retained' && vVoid.email === 'jan@acme.co.za' && vVoid.address === 'Old Street 1, Mossel Bay', '[R8] void invoice -> details as issued', vVoid);
  ok(/Old Street 1/.test(billedTo(printOf(VOID, ctxAfter))) && !/Voortrekker/.test(billedTo(printOf(VOID, ctxAfter))), '[R8] void invoice document is not refreshed');

  // Both companies: customers are shared, so the same edit reaches either company's invoice.
  const CO1 = { ...deep(RINV), id: 413, co: 1, number: 'INV-00005', jobNum: '', reference: '', quoteNum: '' };
  const vCo1 = A.sgrInvoiceRecordContactView(CO1, { quotes: [], jobs: [], accInvoices: [CO1], customers: [CUST_AFTER] });
  ok(vCo1.state === 'matched' && vCo1.email === 'accounts@acme.co.za', '[R9] Holdings (co 1) invoice gets the same current details', vCo1);

  // The old single-answer function is unchanged.
  eq(A.sgrResolveInvoiceCustomer('Acme Signs CC', [CUST_AFTER, DUP]), null, '[R14] sgrResolveInvoiceCustomer still returns null on duplicates');
  eq(A.sgrResolveInvoiceCustomer('Acme Signs CC', [CUST_AFTER]), CUST_AFTER, '[R14] sgrResolveInvoiceCustomer still returns the unique match');

  /* ══════════════════════════════════════════════════════════════════════
     K1–K12 (2026-11-24, 021): the STABLE CUSTOMER LINK decides — not the name.
     ══════════════════════════════════════════════════════════════════ */
  section('K1–K12. Linked documents follow the customer record, by id');
  const KA = { id: 1800000000001, companyName: 'Alpha Signs', contactPerson: 'Ann Alpha', email: 'ann@alpha.test', tel: '011 111 1111', address: '1 Alpha Rd', vatNumber: '4111111111' };
  const KB = { id: 1800000000002, companyName: 'Beta Boards', contactPerson: 'Ben Beta', email: 'ben@beta.test', tel: '022 222 2222', address: '2 Beta Rd', vatNumber: '' };
  const KQ = { id: 91, num: 'SQ-00991', co: 2, client: 'Alpha Signs', customerId: String(KB.id), lines: [] };
  const KJ = { id: 92, num: 'SNS-00992', co: 2, quoteNum: 'SQ-00991', client: 'Alpha Signs', customerId: null, lines: [] };
  const KI = { id: 93, number: 'INV-00993', co: 2, contactName: 'Alpha Signs', contactEmail: 'ann@alpha.test', contactAddress: '1 Alpha Rd', jobNum: 'SNS-00992', reference: 'SNS-00992', status: 'sent',
    lineItems: [{ description: 'Sign', qty: 1, unitAmount: 1000, accountCode: '4000', taxType: '15%' }], payments: [] };
  const kctx = { quotes: [KQ], jobs: [KJ], accInvoices: [KI], customers: [KA, KB] };
  // The reported bug: the chain moved to Beta, the invoice still NAMES Alpha.
  const kr1 = A.sgrInvoiceRecordCustomer(KI, kctx);
  ok(kr1.state === 'matched' && kr1.customer === KB && kr1.linked, '[K1] invoice named "Alpha Signs" but chained to a quote linked to Beta resolves to BETA (link beats name)', kr1);
  const kv1 = A.sgrInvoiceRecordContactView(KI, kctx);
  ok(kv1.name === "Beta Boards" && kv1.email === "ben@beta.test" && kv1.address === "2 Beta Rd", "[K2] View shows Beta details", kv1);
  ok(/Beta Boards/.test(billedTo(printOf(KI, kctx))) && !/Alpha/.test(billedTo(printOf(KI, kctx))), '[K3] PDF Billed To is Beta, nothing of Alpha');
  ok(mailtoFor(KI, kctx).to === 'ben@beta.test', '[K4] Email goes to Beta\'s address');
  const KI2 = { ...KI, id: 94, number: 'INV-00994', customerId: String(KA.id), jobNum: '', reference: 'x' };
  eq(A.sgrInvoiceRecordCustomer(KI2, kctx).customer, KA, '[K5] the invoice\'s OWN link wins');
  const KAren = { ...KA, companyName: 'Alpha Signage (Pty) Ltd', email: '' };
  const r6 = A.sgrInvoiceRecordContactView(KI2, { ...kctx, customers: [KAren, KB] });
  ok(r6.name === 'Alpha Signage (Pty) Ltd' && r6.email === '', '[K6] renamed linked customer: new name; a field cleared on the record shows blank (record is the source of truth)', r6);
  const KAdup = { ...KB, id: KA.id, companyName: 'Imposter' };
  const r7 = A.sgrInvoiceRecordCustomer(KI2, { ...kctx, customers: [KA, KAdup, KB] });
  ok(r7.state === 'unresolved-link' && r7.linkState === 'duplicate-id' && !r7.customer, '[K7] a link id shared by two customers is reported, never guessed', r7);
  const r8 = A.sgrInvoiceRecordCustomer({ ...KI2, customerId: '999' }, kctx);
  ok(r8.state === 'unresolved-link' && r8.linkState === 'missing', '[K8] a link to a deleted customer is reported, NOT replaced by the "Alpha Signs" name match', r8);
  const ren = { ...KA, companyName: 'Alpha Renamed', formerNames: ['Alpha Signs'] };
  const r9 = A.sgrMatchInvoiceCustomer('Alpha Signs', [ren, KB]);
  ok(r9.state === 'matched' && r9.customer === ren, '[K9] unlinked legacy name resolves through formerNames after a rename', r9);
  ok(A.sgrMatchInvoiceCustomer('Alpha Signs', [ren, { ...KB, formerNames: ['Alpha Signs'] }]).state === 'ambiguous', '[K10] a former name shared by two customers stays ambiguous');
  const ov = A.sgrApplyCustomerOverlay({ quotes: [KQ], jobs: [KJ], accInvoices: [KI, { ...KI, id: 95, number: 'INV-00995', status: 'void' }], customers: [KA, KB] });
  ok(ov.quotes[0].client === 'Beta Boards' && ov.jobs[0].client === 'Beta Boards' && ov.accInvoices[0].contactName === 'Beta Boards', '[K11] overlay: quote, job (inherited) and invoice (inherited) all show Beta');
  ok(ov.accInvoices[1].contactName === 'Alpha Signs', '[K12] overlay: a cancelled invoice keeps the name it was issued with');
  ok(KI.contactName === 'Alpha Signs' && KQ.client === 'Alpha Signs', '[K12] raw records are not mutated by the overlay');

  console.log('\n' + (failures ? ('PASSED: ' + passed + '   FAILED: ' + failures) : ('ALL ' + passed + ' CHECKS PASSED')));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('Fatal:', e); process.exit(1); });
