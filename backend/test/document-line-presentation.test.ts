/**
 * document-line-presentation.test.ts — STEP A: GLOBAL DOCUMENT LINE
 * PRESENTATION CONSISTENCY (2026-08-27). Display only.
 *
 * THE REGRESSION BEING PROVED FIXED
 *   INV-00117 printed  ITEM QTY: 0.3835  where its Quote correctly printed
 *   25 items. The invoice's stored financial quantity is 9.5875 (25 pieces ×
 *   0.3835 m², folded in by writeInvoiceLinesFromSourceTx's EFFECTIVE_QTY_SQL);
 *   sgrInvoiceRecordToPrintable's presentation enrichment replaced the printed
 *   qty with the linked JOB line's PER-PIECE 0.3835, and lineItemCount() then
 *   discarded the piece count that was sitting right there (pQty = 25) because
 *   it only consulted pQty when DIMENSIONS were present — and Job 335 had lost
 *   sqmL/sqmW/unit. Two independent faults; this suite covers the code one.
 *
 * WHAT IS ASSERTED
 *   The three quantities stay separate and are never substituted for one
 *   another:  PIECES (customer-facing item count) / PER-PIECE QTY (descriptive
 *   measurement) / EFFECTIVE BILLABLE QTY (internal financial quantity).
 *   Every money figure on every document is unchanged.
 *
 * COVERAGE (numbered to match the brief's required tests)
 *    1  pQty 25 + dimensions + m²      -> "25 items" + full specification
 *    2  pQty 25, no dimensions          -> "25 items", NO fabricated specification
 *    3  pQty 1 + dimensions             -> "1 item" (singular)
 *    4  ordinary qty 3, no pQty         -> "3"
 *    5  ordinary qty 1                  -> "1"
 *    6  m² line, per-piece qty, no pQty -> safe fallback preserved
 *    7  linear-metre line
 *    8  malformed / null / zero / negative pQty
 *    9  Quote and Invoice agree on identical presentation data
 *   10  Proforma agrees
 *   11  Job Card agrees
 *   12  the jsPDF document uses the same helpers, with no private formatting
 *   13  invoice money is byte-identical to the pre-Step-A build (when a baseline
 *       is available) and to the canonical arithmetic either way
 *   14  the SQ-00171 / INV-00117 fixture: 5,273.13 / 250.00 / 828.47 / 6,351.59
 *   15  no financial helper's source changed (md5-pinned)
 *   16  INV-00117 itself, end to end
 *
 * Pure source + sandbox evaluation of index.html — no database, no server, no
 * production connection of any kind.
 *
 * Usage (from backend/):
 *   npx ts-node --transpile-only test/document-line-presentation.test.ts
 * Optional:
 *   INDEX_HTML_PATH=...        the index.html under test
 *   INDEX_HTML_BASELINE=...    a pre-Step-A index.html, for the cross-build
 *                              money comparison in [13]
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as crypto from 'crypto';

const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH || path.resolve(__dirname, '..', '..', 'index.html');
const BASELINE_PATH = process.env.INDEX_HTML_BASELINE || (INDEX_HTML_PATH + '.stepA.bak');

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

function extractFunction(src: string, name: string): string {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) throw new Error(`Could not find function ${name} in index.html — has it been renamed/removed?`);
  const parenStart = src.indexOf('(', m.index);
  let pdepth = 0, j = parenStart;
  for (; j < src.length; j++) {
    if (src[j] === '(') pdepth++;
    else if (src[j] === ')') { pdepth--; if (pdepth === 0) { j++; break; } }
  }
  const braceStart = src.indexOf('{', j);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(m.index, i);
}
function extractConst(src: string, name: string): string {
  const re = new RegExp(`^const\\s+${name}\\s*=.*$`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`Could not find const ${name} in index.html`);
  return m[0];
}
function appSourceOf(file: string): string {
  const html = fs.readFileSync(file, 'utf8');
  const startMarker = '<script type="text/babel" data-presets="react-classic">';
  const startIdx = html.indexOf(startMarker);
  const endIdx = html.lastIndexOf('</script>');
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    throw new Error('Could not locate the main <script type="text/babel"> block in ' + file);
  }
  return html.slice(startIdx + startMarker.length, endIdx);
}

function parseMoney(text: string): number | null {
  const cleaned = text.replace(/[^0-9.,\-]/g, '');
  if (!cleaned) return null;
  const dec = /[.,](\d{1,2})$/.exec(cleaned);
  let normalised: string;
  if (dec) {
    const cut = cleaned.length - dec[0].length;
    normalised = cleaned.slice(0, cut).replace(/[.,]/g, '') + '.' + dec[1];
  } else {
    normalised = cleaned.replace(/[.,]/g, '');
  }
  const n = Number(normalised);
  return Number.isFinite(n) ? n : null;
}
function totalsRow(html: string, label: string): number | null {
  // Labels are given as PLAIN text; the document escapes them, so "Design &
  // Setup Fee" is emitted as "Design &amp; Setup Fee". Escape first, then
  // regex-escape, so no call site has to know either.
  const esc = label.replace(/&/g, '&amp;').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<td[^>]*>${esc}[^<]*</td><td[^>]*>([^<]*)</td>`, 'i');
  const m = re.exec(html);
  return m ? parseMoney(m[1]) : null;
}
/** Every money figure on a rendered document, in document order. Used to prove
 *  "not one figure moved" without depending on which labels exist. */
function allMoney(html: string): number[] {
  const out: number[] = [];
  const re = /R(?:&nbsp;| |\s)?-?[\d  .,]*\d/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const v = parseMoney(m[0]);
    if (v !== null) out.push(v);
  }
  return out;
}
/** The customer-facing item table's rows, as [description+spec, itemQty, total]. */
function itemRows(html: string): Array<{ cells: string[]; text: string }> {
  const table = /<table class="ln">([\s\S]*?)<\/table>/.exec(html);
  const scope = table ? table[1] : '';
  const tbody = /<tbody>([\s\S]*?)<\/tbody>/.exec(scope);
  const body = tbody ? tbody[1] : '';
  return (body.match(/<tr[\s\S]*?<\/tr>/g) || []).map(tr => {
    const cells = (tr.match(/<td[^>]*>([\s\S]*?)<\/td>/g) || [])
      .map(td => td.replace(/^<td[^>]*>/, '').replace(/<\/td>$/, ''));
    return { cells, text: tr.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim() };
  });
}
const strip = (s: string) => s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

function buildSandbox(appSrc: string) {
  const extracted = [
    extractConst(appSrc, 'SGR_INV_SETUP_FEE_DESC'),
    extractConst(appSrc, 'SGR_INV_DISCOUNT_RE'),
    extractConst(appSrc, 'SGR_INV_ADJ_EPSILON'),
    extractConst(appSrc, 'SGR_INV_MONEY_TOLERANCE'),
    extractFunction(appSrc, 'sgrCompanyLegal'),
    extractFunction(appSrc, 'sgrCustomerVatLookup'),
    extractFunction(appSrc, 'sgrJobInvoiceNumber'),
    extractFunction(appSrc, 'escapeHtml'),
    extractFunction(appSrc, 'quoteTermsList'),
    extractFunction(appSrc, 'invoiceTermsList'),
    extractFunction(appSrc, 'docLinesSubtotal'),
    extractFunction(appSrc, 'stubAdjustmentLines'),
    extractFunction(appSrc, 'findCustomerByName'),
    extractFunction(appSrc, 'findLinkedRecords'),
    extractFunction(appSrc, 'invoiceBelongsToJob'),
    extractFunction(appSrc, 'sgrInvoiceLineAmount'),
    extractFunction(appSrc, 'sgrInvoiceAdjustmentKind'),
    extractFunction(appSrc, 'sgrSplitInvoiceLineItems'),
    extractFunction(appSrc, 'sgrInvoiceRecordToPrintable'),
    extractFunction(appSrc, 'buildQuoteHtml'),
    extractFunction(appSrc, 'buildInvoiceHtml'),
    extractFunction(appSrc, 'buildProformaHtml'),
    extractFunction(appSrc, 'printJobCard'),
  ];
  // The presentation helpers: named individually so a rename fails loudly here
  // rather than silently testing stale logic. Pre-Step-A builds have only the
  // first two, which is exactly what the baseline comparison in [13] needs.
  for (const n of ['sgrLineHasDimensions', 'sgrLinePieceCount', 'lineSizeText',
                   'lineItemCount', 'lineItemCountText', 'lineItemQtyDetail']) {
    if (new RegExp(`function\\s+${n}\\s*\\(`).test(appSrc)) extracted.push(extractFunction(appSrc, n));
  }
  const sandbox: any = { console };
  sandbox.globalThis = sandbox;
  // printJobCard ends by opening a print window; capture the HTML instead.
  sandbox.__jobCardHtml = '';
  sandbox.window = { open: () => ({}) };
  sandbox.alert = () => {};
  sandbox.sgrDocFileName = () => 'x';
  sandbox.sgrWritePrintWindow = (_w: any, html: string) => { sandbox.__jobCardHtml = html; };
  vm.createContext(sandbox);
  vm.runInContext(
    `${extracted.join('\n\n')}\nglobalThis.__api = { sgrInvoiceRecordToPrintable, buildQuoteHtml,` +
    ` buildInvoiceHtml, buildProformaHtml, printJobCard, lineSizeText, lineItemCount,` +
    ` docLinesSubtotal, sgrInvoiceLineAmount,` +
    ` lineItemCountText: typeof lineItemCountText === 'function' ? lineItemCountText : null,` +
    ` lineItemQtyDetail: typeof lineItemQtyDetail === 'function' ? lineItemQtyDetail : null };`,
    sandbox, { filename: path.basename(INDEX_HTML_PATH) + '-extracted.js' }
  );
  return sandbox;
}

// ── Fixtures ───────────────────────────────────────────────────────────────
const COMPANIES = [{ id: 2, name: 'Signacore', short: 'SGR' }];
const CUSTOMERS = [{ companyName: 'Karoo Signs CC', contactPerson: 'Jan Botha', vatNumber: '4990123456' }];
const DESC = 'Full colour digital print on high quality outdoor vinyl with lamination.';

/** SQ-00171's real line: 1300 × 295 mm, 25 pieces, 0.3835 m² each, R550/m². */
const SQ_LINE = { desc: DESC, unit: 'm²', sqmL: 1300, sqmW: 295, pQty: 25, qty: 0.3835, unitPrice: 550, subtotal: 5273.13 };
const QUOTE_00171 = {
  id: 171, num: 'SQ-00171', co: 2, client: 'Karoo Signs CC', contact: 'Jan Botha',
  email: 'jan@karoo.co.za', tel: '044 000 1111', vatNum: '4990123456',
  reference: 'PO-7781', date: '2026-08-01', validUntil: '2026-08-15',
  discount: 0, setupFee: 250, lines: [SQ_LINE],
};
/** SNS-00121 as production actually holds it: pieces survived the repair, the
 *  dimensions and the unit did not. This is the shape that produced 0.3835. */
const JOB_00121 = {
  id: 121, num: 'SNS-00121', co: 2, quoteNum: 'SQ-00171',
  client: 'Karoo Signs CC', contact: 'Jan Botha', email: 'jan@karoo.co.za',
  tel: '044 000 1111', vatNum: '4990123456', reference: 'PO-7781',
  discount: 0, setupFee: 250,
  lines: [{ desc: DESC, unit: null, sqmL: null, sqmW: null, pQty: 25, qty: 0.3835, unitPrice: 550, subtotal: 5273.13 }],
};
/** INV-00117: the effective billable quantity is what is stored. */
const INV_00117 = {
  id: 117, number: 'INV-00117', co: 2, date: '2026-08-22', dueDate: '2026-09-21',
  contactName: 'Karoo Signs CC', contactEmail: 'jan@karoo.co.za', contactAddress: '1 Main Rd',
  reference: 'SNS-00121', jobNum: 'SNS-00121', quoteNum: 'SQ-00171', status: 'partial',
  lineItems: [
    { description: DESC, qty: 9.5875, unitAmount: 550, accountCode: '4000', taxType: '15%' },
    { description: 'Design & Setup Fee', qty: 1, unitAmount: 250, accountCode: '4000', taxType: '15%' },
  ],
  payments: [{ date: '2026-08-22', method: 'EFT', amount: 6351.59, notes: '' }],
};
const CTX = { quotes: [QUOTE_00171], jobs: [JOB_00121], accInvoices: [INV_00117], customers: CUSTOMERS };

function main() {
  if (!fs.existsSync(INDEX_HTML_PATH)) {
    console.error(`[document-line-presentation] index.html not found at ${INDEX_HTML_PATH}`);
    process.exit(1);
  }
  const appSrc = appSourceOf(INDEX_HTML_PATH);
  const sb = buildSandbox(appSrc);
  const api = sb.__api;

  if (!api.lineItemCountText) {
    console.error('[document-line-presentation] lineItemCountText() is missing — Step A is not applied to this index.html.');
    process.exit(1);
  }
  const qtyText = (l: any) => api.lineItemCountText(l);
  const specOf = (l: any) => api.lineSizeText(l);

  const renderInvoice = (inv: any, ctx: any = CTX) =>
    api.buildInvoiceHtml(api.sgrInvoiceRecordToPrintable(inv, ctx), COMPANIES, null, ctx.customers || []);
  const renderQuote = (q: any) => api.buildQuoteHtml(q, COMPANIES, null);
  const renderProforma = (q: any) => api.buildProformaHtml(q, 'PRO-00117', COMPANIES, null);
  const renderJobCard = (job: any) => { sb.__jobCardHtml = ''; api.printJobCard(job, COMPANIES); return sb.__jobCardHtml; };

  // ══ 1 ════════════════════════════════════════════════════════════════════
  console.log('\n[1] pQty 25 + dimensions + m² — piece count and full specification');
  {
    ok(qtyText(SQ_LINE) === '25 items', 'ITEM QTY is "25 items"', qtyText(SQ_LINE));
    const spec = specOf(SQ_LINE);
    ok(/1300 × 295 mm/.test(spec), 'specification states the dimensions', spec);
    ok(/25 items/.test(spec), 'specification states the piece count', spec);
    ok(/0\.3835 m² each/.test(spec), 'specification states the PER-PIECE area, marked "each"', spec);
    ok(!/9\.5875/.test(spec) && !/9\.5875/.test(qtyText(SQ_LINE)),
      'the EFFECTIVE BILLABLE quantity never appears as a customer-facing quantity');
  }

  // ══ 2 ════════════════════════════════════════════════════════════════════
  console.log('\n[2] pQty 25 with NO dimensions — count kept, nothing invented');
  {
    const l = { desc: DESC, unit: null, sqmL: null, sqmW: null, pQty: 25, qty: 0.3835 };
    ok(qtyText(l) === '25 items', 'ITEM QTY is still "25 items"', qtyText(l));
    ok(specOf(l) === '', 'no specification sub-line is fabricated', specOf(l));
    ok(!/mm/.test(specOf(l)), 'no dimensions are invented');
  }

  // ══ 3 ════════════════════════════════════════════════════════════════════
  console.log('\n[3] pQty 1 + dimensions — singular wording');
  {
    const l = { unit: 'm²', sqmL: 1300, sqmW: 295, pQty: 1, qty: 0.3835 };
    ok(qtyText(l) === '1 item', 'ITEM QTY is "1 item", not "1 items"', qtyText(l));
    const spec = specOf(l);
    ok(/1300 × 295 mm/.test(spec), 'dimensions still stated', spec);
    ok(!/1 items/.test(spec), 'no "1 items" anywhere in the specification', spec);
  }

  // ══ 4,5 ══════════════════════════════════════════════════════════════════
  console.log('\n[4,5] ordinary lines — the line\'s own quantity is the count');
  {
    // Both line editors seed pQty: 1 on EVERY new line, so an ordinary line
    // almost always carries pQty 1. It must not become "1 item".
    ok(qtyText({ unit: 'each', qty: 3 }) === '3', 'qty 3, no pQty -> "3"', qtyText({ unit: 'each', qty: 3 }));
    ok(qtyText({ unit: 'each', qty: 3, pQty: 1 }) === '3',
      'qty 3 with the form\'s default pQty 1 -> "3", NOT "1 item"', qtyText({ unit: 'each', qty: 3, pQty: 1 }));
    ok(qtyText({ unit: 'each', qty: 1 }) === '1', 'qty 1 -> "1"', qtyText({ unit: 'each', qty: 1 }));
    ok(qtyText({ unit: 'each', qty: 1, pQty: 1 }) === '1', 'qty 1 with pQty 1 -> "1"');
    // A genuine multi-piece plain line: docLinesSubtotal prices it pQty × qty ×
    // unitPrice, so the piece count IS the customer-facing count.
    ok(qtyText({ unit: 'each', qty: 2, pQty: 3 }) === '3 items',
      'an explicit piece count above 1 wins on a plain line too', qtyText({ unit: 'each', qty: 2, pQty: 3 }));
  }

  // ══ 6 ════════════════════════════════════════════════════════════════════
  console.log('\n[6] m² line with a per-piece qty but no pQty — safe fallback preserved');
  {
    const l = { unit: 'm²', sqmL: 1300, sqmW: 295, qty: 0.3835 };
    ok(api.lineItemCount(l) === 1, 'the numeric helper still reads an absent piece count as 1', api.lineItemCount(l));
    ok(qtyText(l) === '1 item', 'and the document says "1 item", never the area', qtyText(l));
    ok(!/0\.3835 *$/.test(qtyText(l)), 'the per-piece area is never the item count');
  }

  // ══ 7 ════════════════════════════════════════════════════════════════════
  console.log('\n[7] linear-metre line');
  {
    const l = { unit: 'm (linear)', sqmL: 4000, pQty: 4, qty: 2 };
    ok(qtyText(l) === '4 items', 'ITEM QTY is "4 items"', qtyText(l));
    const spec = specOf(l);
    ok(/^4000 mm/.test(spec), 'length only — no width is invented for a linear line', spec);
    ok(/4 items/.test(spec) && /2\.0000 m \(linear\) each/.test(spec), 'linear specification wording', spec);
    const one = { unit: 'm (linear)', sqmL: 4000, pQty: 1, qty: 2 };
    ok(specOf(one) === '4000 mm  ·  2.0000 m (linear)', 'single-piece linear line omits the count', specOf(one));
  }

  // ══ 8 ════════════════════════════════════════════════════════════════════
  console.log('\n[8] malformed / null / zero / negative piece counts');
  {
    for (const bad of [null, undefined, '', 'abc', NaN, 0, '0', -2, '-2']) {
      const plain = { unit: 'each', qty: 3, pQty: bad as any };
      ok(qtyText(plain) === '3', `plain line with pQty ${JSON.stringify(bad)} falls back to qty`, qtyText(plain));
      const dim = { unit: 'm²', sqmL: 1300, sqmW: 295, qty: 0.3835, pQty: bad as any };
      ok(qtyText(dim) === '1 item', `dimensioned line with pQty ${JSON.stringify(bad)} reads as 1 piece`, qtyText(dim));
    }
    ok(qtyText({ unit: 'each' }) === '', 'a line with no quantity at all prints nothing');
    ok(specOf(null) === '' && qtyText(null) === '', 'a null line is handled');
    ok(qtyText({ unit: 'each', qty: 2, pQty: '25' }) === '25 items', 'a string piece count is honoured');
  }

  // ══ 9,10,11 ══════════════════════════════════════════════════════════════
  console.log('\n[9,10,11] Quote, Invoice, Proforma and Job Card state the same line the same way');
  {
    const q = renderQuote(QUOTE_00171);
    const qRow = itemRows(q)[0];
    ok(/25 items/.test(strip(qRow.cells[2])), 'Quote Item Qty cell says "25 items"', strip(qRow.cells[2]));
    ok(/1300 × 295 mm/.test(strip(qRow.cells[1])) && /25 items/.test(strip(qRow.cells[1]))
       && /0\.3835 m² each/.test(strip(qRow.cells[1])),
      'Quote specification sub-line is the established wording', strip(qRow.cells[1]));

    // Same line, same presentation data, rendered as an INVOICE: an invoice
    // whose linked source still HAS the dimensions must read identically.
    const jobWithDims = { ...JOB_00121, lines: [SQ_LINE] };
    const invRich = renderInvoice(INV_00117, { ...CTX, jobs: [jobWithDims] });
    const iRow = itemRows(invRich)[0];
    ok(strip(iRow.cells[2]) === '25 items', 'Invoice Item Qty cell says "25 items"', strip(iRow.cells[2]));
    ok(strip(iRow.cells[1]) === strip(qRow.cells[1]),
      'Invoice description + specification is character-identical to the Quote\'s',
      { quote: strip(qRow.cells[1]), invoice: strip(iRow.cells[1]) });

    const pro = renderProforma(QUOTE_00171);
    const pRow = itemRows(pro)[0];
    ok(strip(pRow.cells[2]) === '25 items', 'Proforma Item Qty cell says "25 items"', strip(pRow.cells[2]));
    ok(strip(pRow.cells[1]) === strip(qRow.cells[1]), 'Proforma line reads identically to the Quote\'s');

    const card = renderJobCard({ ...JOB_00121, num: 'SNS-00121', stage: 6, lines: [SQ_LINE] });
    ok(card.length > 0, 'Job Card rendered');
    ok(/1300 × 295 mm/.test(card) && /25 items/.test(card) && /0\.3835 m² each/.test(card),
      'Job Card carries the same specification wording');
    ok(!/25 off/.test(card) && !/25 off/.test(q) && !/25 off/.test(invRich),
      'the superseded "N off" wording is gone from every document');
  }

  // ══ 12 ═══════════════════════════════════════════════════════════════════
  console.log('\n[12] the jsPDF document uses the shared helpers and no private formatting');
  {
    const pdfSrc = extractFunction(appSrc, 'generateDocumentPdf');
    ok(/lineItemCountText\(\s*ln\s*,\s*\{\s*decimals:\s*2\s*\}\s*\)/.test(pdfSrc),
      'Qty column comes from lineItemCountText(ln, { decimals: 2 })');
    ok(/lineSizeText\(\s*ln\s*\)/.test(pdfSrc), 'specification comes from lineSizeText(ln)');
    ok(!/Number\.isInteger\(Number\(q\)\)/.test(pdfSrc), 'its private qty formatting is gone');
    // The decimals option must affect ONLY the bare-quantity fallback.
    ok(api.lineItemCountText({ unit: 'each', qty: 0.3835 }, { decimals: 2 }) === '0.38',
      'a fractional bare quantity still renders at 2 dp in the PDF');
    ok(api.lineItemCountText({ unit: 'each', qty: 3 }, { decimals: 2 }) === '3',
      'an integer bare quantity is unpadded, as before');
    ok(api.lineItemCountText(SQ_LINE, { decimals: 2 }) === '25 items',
      'decimals never truncates a piece count');
    // And every builder that prints a document must go through the helpers.
    for (const fn of ['buildInvoiceHtml', 'buildProformaHtml', 'buildQuoteHtml']) {
      const src = extractFunction(appSrc, fn);
      ok(/lineItemCountText\(/.test(src) && /lineSizeText\(/.test(src),
        `${fn} uses the shared presentation helpers`);
      ok(!/const hasDim/.test(src), `${fn} no longer re-states the rule inline`);
    }
    ok(/lineSizeText\(/.test(extractFunction(appSrc, 'printJobCard')), 'printJobCard uses lineSizeText');
    // The dead, unrouted renderer must not have been touched.
    const dead = extractFunction(appSrc, 'buildManualInvoiceHtml');
    ok(!/lineItemCountText\(/.test(dead) && !/lineSizeText\(/.test(dead),
      'buildManualInvoiceHtml (dead/unrouted) was left untouched');
  }

  // ══ 13 ═══════════════════════════════════════════════════════════════════
  console.log('\n[13] invoice money is unchanged');
  {
    const now = renderInvoice(INV_00117);
    const nowMoney = allMoney(now);
    ok(nowMoney.length > 0, 'money figures were found on the rendered invoice', nowMoney.length);

    if (fs.existsSync(BASELINE_PATH)) {
      const baseApi = buildSandbox(appSourceOf(BASELINE_PATH)).__api;
      const before = baseApi.buildInvoiceHtml(
        baseApi.sgrInvoiceRecordToPrintable(INV_00117, CTX), COMPANIES, null, CUSTOMERS);
      const beforeMoney = allMoney(before);
      ok(JSON.stringify(beforeMoney) === JSON.stringify(nowMoney),
        `every money figure is identical to the pre-Step-A build (${path.basename(BASELINE_PATH)})`,
        { before: beforeMoney, after: nowMoney });
      // …and the presentation genuinely DID change, so the comparison above is
      // not vacuously passing on two identical documents.
      ok(/0\.3835<\/td>/.test(before) || /0\.3835/.test(itemRows(before)[0].cells[2]),
        'the pre-Step-A build really did print 0.3835 as the Item Qty',
        strip(itemRows(before)[0].cells[2]));
      ok(strip(itemRows(now)[0].cells[2]) === '25 items', '…and the corrected build prints "25 items"');
    } else {
      console.log(`  · no baseline at ${BASELINE_PATH} — cross-build comparison skipped, canonical checks still run`);
    }

    // Canonical arithmetic, independent of either build.
    const itemsSub = 9.5875 * 550;
    const setup = 250;
    const vat = (itemsSub + setup) * 0.15;
    // Compared in CENTS — the precision the document is actually issued at —
    // so a raw half-cent (5273.125) cannot fail against its printed 5273.13.
    const cents = (n: number) => Math.round(n * 100);
    ok(cents(totalsRow(now, 'Subtotal (excl. VAT)') ?? -1) === cents(itemsSub),
      'Subtotal is the invoice\'s own effective-quantity money', totalsRow(now, 'Subtotal (excl. VAT)'));
    ok(cents(totalsRow(now, 'Design & Setup Fee') ?? -1) === cents(setup), 'Design & Setup Fee unchanged');
    ok(cents(totalsRow(now, 'VAT (15%)') ?? -1) === cents(vat), 'VAT unchanged');
  }

  // ══ 14 ═══════════════════════════════════════════════════════════════════
  console.log('\n[14] SQ-00171 / INV-00117 fixture — 5,273.13 / 250.00 / 828.47 / 6,351.59');
  {
    const now = renderInvoice(INV_00117);
    const row = itemRows(now)[0];
    ok(parseMoney(row.cells[3]) === 5273.13, 'line total prints R5,273.13', strip(row.cells[3]));
    ok(totalsRow(now, 'Subtotal (excl. VAT)') === 5273.13, 'Subtotal prints R5,273.13');
    ok(totalsRow(now, 'Design & Setup Fee') === 250.00, 'Design & Setup Fee prints R250.00');
    ok(totalsRow(now, 'VAT (15%)') === 828.47, 'VAT prints R828.47');
    const total = totalsRow(now, 'INVOICE TOTAL') ?? totalsRow(now, 'TOTAL DUE');
    ok(total === 6351.59, 'TOTAL prints R6,351.59', total);
    // Payment / balance / status pins for the combined release candidate.
    // The row is printed as a deduction ("- R 6 351.59"), so the parsed value is negative.
    ok(Math.abs(totalsRow(now, 'Less: Payments Received') ?? 0) === 6351.59,
      'payment resolves as R6,351.59', totalsRow(now, 'Less: Payments Received'));
    ok(totalsRow(now, 'PAID IN FULL') === 0, 'balance is R0.00', totalsRow(now, 'PAID IN FULL'));
    ok(/PAID IN FULL/.test(now) && !/BALANCE DUE/.test(now),
      'the R6,351.59 payment still settles the document in full — status paid, not balance due');
    // Nothing upstream was mutated by rendering.
    ok(JOB_00121.lines[0].qty === 0.3835 && JOB_00121.lines[0].pQty === 25,
      'the source job line was not mutated');
    ok(INV_00117.lineItems[0].qty === 9.5875 && INV_00117.lineItems[0].unitAmount === 550,
      'the invoice record\'s financial quantity and unit amount were not mutated');
  }

  // ══ 15 ═══════════════════════════════════════════════════════════════════
  console.log('\n[15] no financial calculation helper changed');
  {
    const PINS: Record<string, string> = {
      docLinesSubtotal:         'cc69d24d773980d13fc0ccb38d017466',
      stubAdjustmentLines:      '1b30072dfd7f7ca144e1211afb5bddef',
      sgrInvoiceLineAmount:     '969ee47c88dc310743696e5c9042c83a',
      sgrInvoiceAdjustmentKind: 'fa0da0cae2f24eeb049cee26bad12d04',
      sgrSplitInvoiceLineItems: 'e049783705c45e8a243bcd6fb0d09ced',
    };
    for (const [name, want] of Object.entries(PINS)) {
      const got = crypto.createHash('md5').update(extractFunction(appSrc, name), 'utf8').digest('hex');
      ok(got === want, `${name}() source is byte-identical to its pinned form`, { want, got });
    }
    // The adapter still takes every amount from the invoice itself.
    const adapter = extractFunction(appSrc, 'sgrInvoiceRecordToPrintable');
    ok(/subtotal: sgrInvoiceLineAmount\(l\)/.test(adapter),
      'the printable line\'s money is still sgrInvoiceLineAmount(l) — never a source amount');
    ok(!/subtotal:\s*e\b/.test(adapter) && !/subtotal:.*docLinesSubtotal/.test(adapter),
      'no amount is taken from the linked Quote or Job');
  }

  // ══ 16 ═══════════════════════════════════════════════════════════════════
  console.log('\n[16] INV-00117 end to end — the reported defect');
  {
    const now = renderInvoice(INV_00117);
    const row = itemRows(now)[0];
    ok(strip(row.cells[1]).startsWith(DESC), 'DESCRIPTION is the line description', strip(row.cells[1]).slice(0, 60));
    ok(strip(row.cells[2]) === '25 items', 'ITEM QTY is "25 items" (was 0.3835)', strip(row.cells[2]));
    ok(parseMoney(row.cells[3]) === 5273.13, 'LINE TOTAL is R5,273.13');
    ok(strip(row.cells[1]) === DESC,
      'no specification sub-line — the Job line has no dimensions and none are fabricated',
      strip(row.cells[1]));
    ok(!/1300/.test(now) && !/295 mm/.test(now),
      'the Quote\'s dimensions are NOT reached into for this already-issued invoice');
    ok(!/0\.3835/.test(now), '0.3835 appears nowhere on the document');

    // Snapshot preference: once the invoice line carries its own presentation
    // metadata, that wins and the linked source is not consulted.
    const snapshotted = {
      ...INV_00117,
      lineItems: [
        { ...INV_00117.lineItems[0], pQty: 25, pieceQty: 0.3835, sqmL: 1300, sqmW: 295, unit: 'm²' },
        INV_00117.lineItems[1],
      ],
    };
    const snap = renderInvoice(snapshotted, { ...CTX, jobs: [], quotes: [] });
    const sRow = itemRows(snap)[0];
    ok(strip(sRow.cells[2]) === '25 items', 'a snapshotted line renders its own piece count with NO linkage');
    ok(/1300 × 295 mm/.test(strip(sRow.cells[1])) && /0\.3835 m² each/.test(strip(sRow.cells[1])),
      '…and its own specification', strip(sRow.cells[1]));
    ok(parseMoney(sRow.cells[3]) === 5273.13, '…while the money is still the invoice\'s own R5,273.13');
    // The snapshot must beat a CONFLICTING linked source, or it is not a snapshot.
    const conflicting = { ...JOB_00121, lines: [{ ...SQ_LINE, sqmL: 999, sqmW: 111, pQty: 7 }] };
    const snap2 = renderInvoice(snapshotted, { ...CTX, jobs: [conflicting] });
    const s2 = itemRows(snap2)[0];
    ok(strip(s2.cells[2]) === '25 items' && !/999/.test(strip(s2.cells[1])),
      'a later upstream edit cannot restate an invoice that carries its own snapshot');
  }

  console.log('\n============================================================');
  console.log(`[document-line-presentation] ${passed} passed, ${failures} failed`);
  console.log('============================================================');
  process.exit(failures === 0 ? 0 : 1);
}

main();
