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
];
const FNS = [
  // document plumbing
  'escapeHtml', 'sgrCompanyLegal', 'sgrJobInvoiceNumber', 'invoiceTermsList', 'quoteTermsList',
  'sgrLineHasDimensions', 'sgrLinePieceCount', 'lineSizeText', 'lineItemCount', 'lineItemCountText',
  'lineItemQtyDetail', 'docLinesSubtotal',
  'normalizeQuoteDepositPct', 'fmtQuoteDepositPct', 'quoteDepositInfo', 'quoteDepositTermsInfo',
  // customer lookups (old + new)
  'sgrCustomerVatLookup', 'sgrCustomerAddressLookup',
  'sgrResolveInvoiceCustomer', 'sgrInvoiceWithCurrentCustomer',
  // linkage used by the accInvoices printable adapter
  'companyTagOf', 'sameCompany', 'jobHasId', 'findCustomerByName', 'invoiceBelongsToJob',
  'resolveJobsForQuote', 'resolveJobForQuote', 'resolveQuoteForJob', 'resolveQuoteForInvoice',
  'findSourceQuoteForJob', 'findLinkedRecords',
  'sgrInvoiceLineAmount', 'sgrInvoiceAdjustmentKind', 'sgrSplitInvoiceLineItems', 'sgrInvoiceRecordToPrintable',
  // the builders and every entry point that reaches them
  'buildQuoteHtml', 'buildInvoiceHtml', 'printInvoice', 'printManualInvoice', 'printQuoteWindow',
  'generateDocumentPdfFromHtml', 'generateAndEmailDocument',
];
// Browser-only side effects are replaced by recorders. Everything that
// decides WHAT is printed is the shipped code.
const STUBS = `
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
for (const c of CONSTS) pieces.push(extractConst(SRC, MASKED, c));
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
ok(/<div class="nm">Acme Signs CC<\/div>/.test(bt), '[12] Billed To name is the invoice\'s own client name');
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
  ok(/generateAndEmailDocument\(type, data, companies, logoDataUrl, onMarkSent, customers\)/.test(extractFunction(SRC, 'EmailFlowModal')),
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
  ok(changed.every(k => ['contact', 'email', 'tel', 'address', 'vatNum'].includes(k)),
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

  console.log('\n' + (failures ? ('PASSED: ' + passed + '   FAILED: ' + failures) : ('ALL ' + passed + ' CHECKS PASSED')));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('Fatal:', e); process.exit(1); });
