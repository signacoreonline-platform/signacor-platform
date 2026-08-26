/**
 * invoice-layout-restore.test.ts — ESTABLISHED QUOTE / INVOICE LAYOUT RESTORE (2026-08-26)
 *
 * THE REGRESSION BEING PROVED FIXED
 *   Until 2026-08-24 there was exactly ONE customer-facing Tax Invoice in
 *   index.html — buildInvoiceHtml() — and every print button reached it through
 *   printInvoice(job,…). buildManualInvoiceHtml() (2026-08-11) was added for
 *   genuinely manual accounting invoices, which had no template at all. The
 *   2026-08-24 invoice-list consistency pass then stamped `_isManual: true` on
 *   EVERY non-void accInvoices record, so job-sourced and quote-sourced
 *   invoices started printing through the manual template — which carries a
 *   Unit Price column the established document never had, and which renders
 *   inv.lineItems verbatim, so the SYNTHETIC adjustment lines the 2026-08-25
 *   writers store ("Design & Setup Fee", "Discount (x%)") reached the customer
 *   as ordinary product/service items.
 *
 * THE FIX BEING PROVED
 *   sgrInvoiceRecordToPrintable() maps an accInvoices record onto the shape the
 *   ESTABLISHED buildInvoiceHtml() already consumes, separating recognised
 *   adjustment lines into the totals block. Storage is untouched; the money is
 *   the record's own canonical money, handed down pre-computed on `_sgrTotals`.
 *
 * WHY THE MONEY PROOF IS TRUSTWORTHY
 *   buildManualInvoiceHtml() is still present in index.html and still computes
 *   the invoice exactly as every other consumer does (Σ qty × unitAmount, VAT
 *   on the 15% lines only). Cases [8]–[12] render the SAME record through BOTH
 *   builders in the SAME runtime and compare the rendered figures, so the
 *   assertion is "the restored document prints the same money the canonical
 *   presentation prints" — not "the test agrees with itself".
 *
 * COVERAGE (numbered to match the brief's required tests)
 *    1  Quote item table is  # / Description & Specifications / Item Qty / Sub Total
 *    2  Invoice item table is  Item No / Description / Item Qty / Total
 *    3  Invoice has NO Unit Price column
 *    4  a genuine invoice line stays visible
 *    5  recognised Design & Setup Fee — stored, out of the item table, once in totals
 *    6  recognised Discount — stored, out of the item table, once in totals
 *    7  genuine lines whose wording contains design/setup/discount language survive
 *    8  display subtotal is the genuine item subtotal, before the adjustments
 *    9  final displayed Invoice total is unchanged from canonical
 *   10  VAT is unchanged from canonical (incl. mixed 15% / 0% / Exempt lines)
 *   11  payments total is unchanged
 *   12  Balance Due / Paid in Full is correct
 *   13  Job-created Invoice uses the established structure
 *   14  direct Quote-created Invoice uses the established structure
 *   15  manual Accounting Invoice uses the same structure, no invented fields
 *   16  Quote still uses the recovered historical structure
 *   17  Quote totals still calculate exactly as before
 *   18  PDF filename behaviour intact
 *   19  no company-isolation behaviour change (ambiguous linkage borrows nothing)
 *
 * Pure source + sandbox evaluation of index.html — no database, no server.
 *
 * Usage (from backend/):
 *   npx ts-node --transpile-only test/invoice-layout-restore.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH || path.resolve(__dirname, '..', '..', 'index.html');

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

/** Brace-matched extraction of a top-level function — the same helper shape
 *  pdf-filename.test.ts / proforma-frontend-logic.test.ts already use. */
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

/** A single-line `const NAME = ...;` declaration, taken verbatim. */
function extractConst(src: string, name: string): string {
  const re = new RegExp(`^const\\s+${name}\\s*=.*$`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`Could not find const ${name} in index.html — has it been renamed/removed?`);
  return m[0];
}

/** Money comparison at the tolerance services.ts already uses
 *  (SOURCE_TOTAL_TOLERANCE = 0.05). */
const TOL = 0.05;
const near = (a: number, b: number) => Math.abs(a - b) <= TOL;

/** Both builders format money with Number#toLocaleString('en-ZA'), whose
 *  grouping and decimal separators differ between ICU builds (a browser may
 *  render "R 1 234.56" where Node renders "R 1 234,56"). Parse whichever
 *  arrives: the LAST separator that is followed by one or two digits at the end
 *  of the string is the decimal point; every other separator is grouping. */
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

/** Pull a labelled totals row's amount out of a rendered document. Both
 *  builders emit `<td…>LABEL</td><td…>R&nbsp;1 234,56</td>`, so one reader
 *  works for both — which is the point: the two are compared like for like.
 *  `label` is PLAIN text; escaping happens here so no call site can
 *  double-escape it. */
function totalsRow(html: string, label: string): number | null {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<td[^>]*>${esc}[^<]*</td><td[^>]*>([^<]*)</td>`, 'i');
  const m = re.exec(html);
  return m ? parseMoney(m[1]) : null;
}

/** The "Billed To" party box only — so an assertion about the customer's
 *  details can never be satisfied (or defeated) by Signacore's own contact
 *  details in the neighbouring "Remit To" box. */
function billedToBox(html: string): string {
  const m = /<div class="box box-to">([\s\S]*?)<\/div>\s*<div class="box box-from">/.exec(html);
  return m ? m[1] : '';
}

/** The customer-facing item table only — `<table class="ln">`. Scoped
 *  deliberately: the document's FIRST <tbody> belongs to the `qi-meta` header
 *  table (Invoice Date / Due Date / Quote Ref / Job No), so a document-wide
 *  <tbody> match would read the wrong table and quietly assert nothing. */
function itemTable(html: string): { headers: string[]; bodyText: string } {
  const table = /<table class="ln">([\s\S]*?)<\/table>/.exec(html);
  const scope = table ? table[1] : '';
  const thead = /<thead><tr>([\s\S]*?)<\/tr><\/thead>/.exec(scope);
  const headers = thead
    ? (thead[1].match(/<th[^>]*>([\s\S]*?)<\/th>/g) || [])
        .map(h => h.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').trim())
    : [];
  const tbody = /<tbody>([\s\S]*?)<\/tbody>/.exec(scope);
  return { headers, bodyText: tbody ? tbody[1] : '' };
}

function main() {
  if (!fs.existsSync(INDEX_HTML_PATH)) {
    console.error(`[invoice-layout-restore] index.html not found at ${INDEX_HTML_PATH} — set INDEX_HTML_PATH.`);
    process.exit(1);
  }
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const startMarker = '<script type="text/babel" data-presets="react-classic">';
  const startIdx = html.indexOf(startMarker);
  const endIdx = html.lastIndexOf('</script>');
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    throw new Error('Could not locate the main <script type="text/babel"> block in index.html');
  }
  const appSrc = html.slice(startIdx + startMarker.length, endIdx);

  const extracted = [
    extractConst(appSrc, 'SGR_INV_SETUP_FEE_DESC'),
    extractConst(appSrc, 'SGR_INV_DISCOUNT_RE'),
    extractConst(appSrc, 'SGR_INV_ADJ_EPSILON'),
    extractConst(appSrc, 'SGR_INV_MONEY_TOLERANCE'),
    extractFunction(appSrc, 'sgrCompanyLegal'),
    extractFunction(appSrc, 'sgrCustomerVatLookup'),
    extractFunction(appSrc, 'sgrJobInvoiceNumber'),
    extractFunction(appSrc, 'lineSizeText'),
    extractFunction(appSrc, 'lineItemCount'),
    extractFunction(appSrc, 'quoteTermsList'),
    extractFunction(appSrc, 'invoiceTermsList'),
    extractFunction(appSrc, 'docLinesSubtotal'),
    extractFunction(appSrc, 'findCustomerByName'),
    extractFunction(appSrc, 'findLinkedRecords'),
    extractFunction(appSrc, 'invoiceBelongsToJob'),
    extractFunction(appSrc, 'sgrInvoiceLineAmount'),
    extractFunction(appSrc, 'sgrInvoiceAdjustmentKind'),
    extractFunction(appSrc, 'sgrSplitInvoiceLineItems'),
    extractFunction(appSrc, 'sgrInvoiceRecordToPrintable'),
    extractFunction(appSrc, 'buildQuoteHtml'),
    extractFunction(appSrc, 'buildInvoiceHtml'),
    extractFunction(appSrc, 'buildManualInvoiceHtml'),
  ].join('\n\n');

  const sandbox: any = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  try {
    vm.runInContext(
      `${extracted}\nglobalThis.__api = { sgrInvoiceAdjustmentKind, sgrSplitInvoiceLineItems,` +
      ` sgrInvoiceRecordToPrintable, buildQuoteHtml, buildInvoiceHtml, buildManualInvoiceHtml,` +
      ` SGR_INV_SETUP_FEE_DESC, SGR_INV_DISCOUNT_RE };`,
      sandbox, { filename: 'index.html-extracted.js' }
    );
  } catch (e: any) {
    console.error('[invoice-layout-restore] Extracted source failed to evaluate — index.html likely changed shape:', e.message);
    process.exit(1);
  }
  const api = sandbox.__api;

  const COMPANIES = [{ id: 2, name: 'Signacore', short: 'SGR' }];
  const CUSTOMERS = [{ companyName: 'Acme Signs CC', contactPerson: 'Jan Botha', vatNumber: '4990123456' }];

  // ── The three invoice origins, as the app actually stores them ────────────

  // A job and its invoice: pieces + dimensions on the job's lines, and the
  // invoice's own stored lines with pieces folded into qty (what
  // writeInvoiceLinesFromSourceTx does) plus the two adjustment lines.
  const JOB = {
    id: 11, num: 'SNS-00110', co: 2, quoteNum: 'SQ-00150',
    client: 'Acme Signs CC', contact: 'Jan Botha', email: 'jan@acme.co.za',
    tel: '044 000 1111', vatNum: '4990123456', reference: 'PO-8842',
    notes: 'Install after hours.',
    discount: 10, setupFee: 750,
    lines: [
      { desc: 'Illuminated fascia sign', unit: 'm²', sqmL: 2000, sqmW: 900, pQty: 3, qty: 1.8, unitPrice: 1500, subtotal: 8100 },
      { desc: 'Vinyl window graphics',   unit: 'each', qty: 4, unitPrice: 250, subtotal: 1000 },
    ],
  };
  const JOB_LINES_SUBTOTAL = 3 * 1.8 * 1500 + 4 * 250;           // 9100
  const JOB_DISC = JOB_LINES_SUBTOTAL * 0.10;                     // 910
  const INV_FROM_JOB = {
    id: 501, number: 'INV-00111', co: 2, date: '2026-08-20', dueDate: '2026-09-19',
    contactName: 'Acme Signs CC', contactEmail: 'jan@acme.co.za', contactAddress: '1 Main Rd',
    reference: 'SNS-00110', jobNum: 'SNS-00110', quoteNum: 'SQ-00150', status: 'partial',
    lineItems: [
      { description: 'Illuminated fascia sign', qty: 5.4, unitAmount: 1500, accountCode: '4000', taxType: '15%' },
      { description: 'Vinyl window graphics',   qty: 4,   unitAmount: 250,  accountCode: '4000', taxType: '15%' },
      { description: `Discount (10%)`,          qty: 1,   unitAmount: -JOB_DISC, accountCode: '4000', taxType: '15%' },
      { description: 'Design & Setup Fee',      qty: 1,   unitAmount: 750,  accountCode: '4000', taxType: '15%' },
    ],
    payments: [{ date: '2026-08-21', method: 'EFT', amount: 5000, notes: 'Deposit' }],
  };

  const QUOTE = {
    id: 77, num: 'SQ-00151', co: 2, client: 'Acme Signs CC', contact: 'Jan Botha',
    email: 'jan@acme.co.za', tel: '044 000 1111', vatNum: '4990123456',
    reference: 'PO-9001', notes: 'Quote notes.', date: '2026-08-01', validUntil: '2026-08-15',
    discount: 0, setupFee: 500,
    lines: [{ desc: 'Pylon sign', unit: 'm (linear)', sqmL: 4000, pQty: 2, qty: 4, unitPrice: 600, subtotal: 4800 }],
  };
  const INV_FROM_QUOTE = {
    id: 502, number: 'INV-00112', co: 2, date: '2026-08-22', dueDate: '2026-09-21',
    contactName: 'Acme Signs CC', contactEmail: 'jan@acme.co.za',
    reference: 'SQ-00151', quoteNum: 'SQ-00151', jobNum: '', status: 'sent',
    lineItems: [
      { description: 'Pylon sign',         qty: 8, unitAmount: 600, accountCode: '4000', taxType: '15%' },
      { description: 'Design & Setup Fee', qty: 1, unitAmount: 500, accountCode: '4000', taxType: '15%' },
    ],
    payments: [],
  };

  // A genuinely manual accounting invoice: no job, no quote, mixed tax types,
  // and deliberately worded lines that a keyword test would wrongly swallow.
  const INV_MANUAL = {
    id: 503, number: 'INV-00113', co: 2, date: '2026-08-23', dueDate: '2026-09-22',
    contactName: 'Karoo Trust', contactEmail: 'accounts@karoo.co.za', contactAddress: 'PO Box 9',
    reference: 'Retainer', jobNum: '', quoteNum: '', status: 'sent',
    lineItems: [
      { description: 'Setup and design of vehicle wrap', qty: 1, unitAmount: 4000, accountCode: '4000', taxType: '15%' },
      { description: 'Discount agreed with client',      qty: 1, unitAmount: 300,  accountCode: '4000', taxType: '15%' },
      { description: 'Design & Setup Fee',               qty: 1, unitAmount: 900,  accountCode: '4000', taxType: '15%' },
      { description: 'Zero-rated export freight',        qty: 1, unitAmount: 1200, accountCode: '4000', taxType: '0%' },
      { description: 'Exempt statutory levy',            qty: 1, unitAmount: 400,  accountCode: '4000', taxType: 'Exempt' },
    ],
    payments: [{ date: '2026-08-24', method: 'EFT', amount: 1000, notes: '' }],
  };

  const CTX = { quotes: [QUOTE], jobs: [JOB], accInvoices: [INV_FROM_JOB, INV_FROM_QUOTE, INV_MANUAL], customers: CUSTOMERS };

  const render = (inv: any, ctx: any = CTX) =>
    api.buildInvoiceHtml(api.sgrInvoiceRecordToPrintable(inv, ctx), COMPANIES, null, ctx.customers || []);
  const canonical = (inv: any) => api.buildManualInvoiceHtml(inv, COMPANIES, null);

  // ══ 1 — Quote item table ═════════════════════════════════════════════════
  console.log('\n[1] Quote customer-facing table is  # / Description & Specifications / Item Qty / Sub Total');
  {
    const q = api.buildQuoteHtml(QUOTE, COMPANIES, null);
    const t = itemTable(q);
    ok(JSON.stringify(t.headers) === JSON.stringify(['#', 'Description & Specifications', 'Item Qty', 'Sub Total']),
      'the four established Quote columns, in order', t.headers);
    ok(!/Unit Price/i.test(q), 'the Quote has no Unit Price column');
  }

  // ══ 2,3 — Invoice item table, for all three origins ══════════════════════
  console.log('\n[2,3] Invoice customer-facing table is  Item No / Description / Item Qty / Total, with NO Unit Price');
  {
    for (const [label, inv] of [['Job-created', INV_FROM_JOB], ['Quote-created', INV_FROM_QUOTE], ['Manual', INV_MANUAL]] as const) {
      const out = render(inv);
      const t = itemTable(out);
      ok(JSON.stringify(t.headers) === JSON.stringify(['Item No', 'Description', 'Item Qty', 'Total']),
        `${label}: the four established Invoice columns, in order`, t.headers);
      ok(!/<th[^>]*>\s*Unit Price\s*<\/th>/i.test(out), `${label}: no Unit Price column header`);
      ok(!/Unit Price/i.test(out), `${label}: the words "Unit Price" appear nowhere in the document`);
    }
    // …and the superseded template is genuinely the one that had it, so this
    // test would have failed before the repair.
    ok(/<th[^>]*>\s*Unit Price\s*<\/th>/i.test(canonical(INV_MANUAL)),
      'control: the superseded manual template really does carry a Unit Price column');
  }

  // ══ 4,5,6,7 — adjustment separation ══════════════════════════════════════
  console.log('\n[4,5,6,7] adjustment lines leave the item table and appear once in totals; genuine lines never do');
  {
    const out = render(INV_FROM_JOB);
    const t = itemTable(out);
    ok(/Illuminated fascia sign/.test(t.bodyText) && /Vinyl window graphics/.test(t.bodyText),
      '[4] both genuine invoice lines are still in the item table');
    ok(!/Design &amp; Setup Fee/.test(t.bodyText) && !/Design & Setup Fee/.test(t.bodyText),
      '[5] "Design & Setup Fee" is NOT an item-table row');
    ok(!/Discount \(10%\)/.test(t.bodyText), '[6] "Discount (10%)" is NOT an item-table row');
    ok((out.match(/Design &amp; Setup Fee/g) || []).length === 1,
      '[5] "Design & Setup Fee" appears exactly once in the whole document (the totals row)',
      (out.match(/Design &amp; Setup Fee/g) || []).length);
    ok(totalsRow(out, 'Design &amp; Setup Fee') === 750, '[5] …and its totals row carries the stored amount', totalsRow(out, 'Design &amp; Setup Fee'));
    ok((out.match(/Discount \(10%\)/g) || []).length === 1,
      '[6] "Discount (10%)" appears exactly once (the totals row)', (out.match(/Discount \(10%\)/g) || []).length);
    ok(near(Math.abs(totalsRow(out, 'Discount (10%)') || 0), JOB_DISC),
      '[6] …and its totals row carries the stored amount (shown as a deduction)', totalsRow(out, 'Discount (10%)'));

    // Storage untouched — the adapter must not mutate the record it reads.
    ok(INV_FROM_JOB.lineItems.length === 4, '[5,6] the stored invoice still has all four line items');
    ok(INV_FROM_JOB.lineItems.some((l: any) => l.description === 'Design & Setup Fee'),
      '[5] the Design & Setup Fee line is still stored on the invoice');
    ok(INV_FROM_JOB.lineItems.some((l: any) => l.description === 'Discount (10%)'),
      '[6] the Discount line is still stored on the invoice');

    // [7] the false-positive guard — the whole reason recognition is a closed
    // whole-string match rather than a keyword test.
    const man = itemTable(render(INV_MANUAL));
    ok(/Setup and design of vehicle wrap/.test(man.bodyText), '[7] a genuine line worded "Setup and design of…" survives');
    ok(/Discount agreed with client/.test(man.bodyText),     '[7] a genuine line worded "Discount agreed with…" survives');
    ok(api.sgrInvoiceAdjustmentKind({ description: 'Setup Fee', qty: 1, unitAmount: 100 }) === null,
      '[7] a bare "Setup Fee" line is NOT recognised (that description is display-only, never stored)');
    ok(api.sgrInvoiceAdjustmentKind({ description: 'Design & Setup Fee', qty: 2, unitAmount: 100 }) === null,
      '[7] recognition requires qty 1 — the only shape the writers ever emit');
    ok(api.sgrInvoiceAdjustmentKind({ description: 'Design & Setup Fee', qty: 1, unitAmount: -100 }) === null,
      '[7] a NEGATIVE "Design & Setup Fee" is not a setup fee, so it stays an item');
    ok(api.sgrInvoiceAdjustmentKind({ description: 'Discount (10%)', qty: 1, unitAmount: 100 }) === null,
      '[7] a POSITIVE "Discount (10%)" is not a discount, so it stays an item');
    ok(api.sgrInvoiceAdjustmentKind({ description: 'Design & Setup Fee', qty: 1, unitAmount: 750 }) === 'setupFee',
      '[5] the writers’ exact setup-fee line IS recognised');
    ok(api.sgrInvoiceAdjustmentKind({ description: 'Discount (12.5%)', qty: 1, unitAmount: -50 }) === 'discount',
      '[6] the writers’ exact discount line, decimal percentage included, IS recognised');
    // Two of a kind is a shape this does not understand → separate nothing.
    const twoFees = api.sgrSplitInvoiceLineItems([
      { description: 'Design & Setup Fee', qty: 1, unitAmount: 100, taxType: '15%' },
      { description: 'Design & Setup Fee', qty: 1, unitAmount: 200, taxType: '15%' },
    ]);
    ok(twoFees.separated === false && twoFees.items.length === 2,
      '[5] two setup-fee lines is an unrecognised shape — nothing is separated, nothing is hidden');
  }

  // ══ 8 — display subtotal ═════════════════════════════════════════════════
  console.log('\n[8] display Subtotal is the genuine item subtotal, before the separated adjustments');
  {
    const out = render(INV_FROM_JOB);
    ok(near(totalsRow(out, 'Subtotal (excl. VAT)') || 0, JOB_LINES_SUBTOTAL),
      'Subtotal (excl. VAT) = the genuine lines only', { shown: totalsRow(out, 'Subtotal (excl. VAT)'), expected: JOB_LINES_SUBTOTAL });
    const split = api.sgrSplitInvoiceLineItems(INV_FROM_JOB.lineItems);
    ok(near(split.itemsSubtotal - split.discAmt + split.setupFeeAmt, split.allSubtotal),
      'and itemsSubtotal − discount + setupFee reconciles exactly to the stored all-lines subtotal',
      { itemsSubtotal: split.itemsSubtotal, discAmt: split.discAmt, setupFeeAmt: split.setupFeeAmt, allSubtotal: split.allSubtotal });
  }

  // ══ 9,10,11,12 — money is unchanged, proved against the canonical builder ═
  console.log('\n[9,10,11,12] Total / VAT / Payments / Balance are identical to the canonical presentation');
  {
    for (const [label, inv] of [['Job-created', INV_FROM_JOB], ['Quote-created', INV_FROM_QUOTE], ['Manual', INV_MANUAL]] as const) {
      const restored = render(inv);
      const before = canonical(inv);

      const rTotal = totalsRow(restored, 'TOTAL DUE') ?? totalsRow(restored, 'INVOICE TOTAL');
      const cTotal = totalsRow(before, 'TOTAL DUE') ?? totalsRow(before, 'INVOICE TOTAL');
      ok(cTotal !== null && rTotal !== null && near(rTotal!, cTotal!),
        `[9] ${label}: final Invoice total unchanged`, { restored: rTotal, canonical: cTotal });

      const rVat = totalsRow(restored, 'VAT (15%)');
      const cVat = totalsRow(before, 'VAT (15%)');
      ok(cVat !== null && rVat !== null && near(rVat!, cVat!),
        `[10] ${label}: VAT unchanged`, { restored: rVat, canonical: cVat });

      const paid = (inv.payments || []).reduce((s: number, p: any) => s + (parseFloat(p.amount) || 0), 0);
      if (paid > 0) {
        const rPaid = totalsRow(restored, 'Less: Payments Received');
        const cPaid = totalsRow(before, 'Less: Payments Received');
        // Shown as a deduction ("- 5 000,00"), hence the magnitude comparison.
        ok(rPaid !== null && cPaid !== null && near(rPaid!, cPaid!) && near(Math.abs(rPaid!), paid),
          `[11] ${label}: payments received unchanged`, { restored: rPaid, canonical: cPaid, expected: paid });
        const label12 = (cTotal! - paid) <= 0.005 ? 'PAID IN FULL' : 'BALANCE DUE';
        const rBal = totalsRow(restored, label12);
        ok(rBal !== null && near(rBal!, Math.max(0, cTotal! - paid)),
          `[12] ${label}: ${label12} is correct`, { restored: rBal, expected: Math.max(0, cTotal! - paid) });
      } else {
        ok(!/Less: Payments Received/.test(restored) && !/BALANCE DUE/.test(restored),
          `[11,12] ${label}: no payments, so no payments/balance rows are invented`);
      }
    }
    // Mixed tax types are exactly where a flat 15% would have gone wrong.
    const mixedVat = 4000 * 0.15 + 300 * 0.15 + 900 * 0.15;   // 0%/Exempt lines excluded
    ok(near(totalsRow(render(INV_MANUAL), 'VAT (15%)') || 0, mixedVat),
      '[10] mixed 15% / 0% / Exempt: VAT is taxType-aware, not a flat 15% of the subtotal',
      { shown: totalsRow(render(INV_MANUAL), 'VAT (15%)'), expected: mixedVat });
    // Paid-in-full path.
    const full = { ...INV_FROM_QUOTE, payments: [{ date: '2026-08-25', method: 'EFT', amount: 6095, notes: '' }] };
    const fullTotal = totalsRow(canonical(full), 'TOTAL DUE') ?? totalsRow(canonical(full), 'INVOICE TOTAL');
    const fullOut = render({ ...full, payments: [{ date: '2026-08-25', method: 'EFT', amount: fullTotal, notes: '' }] });
    ok(/PAID IN FULL/.test(fullOut), '[12] a fully-settled invoice shows PAID IN FULL');
  }

  // ══ 13,14,15 — the three origins, without inventing anything ═════════════
  console.log('\n[13,14,15] every invoice origin uses the established structure; absent facts stay absent');
  {
    const job = render(INV_FROM_JOB);
    ok(/TAX INVOICE/.test(job) && /class="inv-badge"/.test(job), '[13] Job-created: established TAX INVOICE badge');
    ok(/<td>Job No:<\/td><td>SNS-00110<\/td>/.test(job), '[13] Job-created: Job No row present');
    ok(/<td>Quote Ref:<\/td><td>SQ-00150<\/td>/.test(job), '[13] Job-created: Quote Ref row present');
    ok(/<td>Reference:<\/td><td><strong>PO-8842<\/strong><\/td>/.test(job),
      '[13] Job-created: Reference is the customer’s own reference, not the job number repeated');
    ok(/Attn: Jan Botha/.test(job), '[13] Job-created: Attn from the unambiguously linked job');
    ok(/VAT Reg: 4990123456/.test(job), '[13] Job-created: VAT Reg present');
    ok(/Tel: 044 000 1111/.test(job), '[13] Job-created: telephone present');
    ok(/2000 × 900 mm/.test(job) && /3 off/.test(job),
      '[13] Job-created: the established dimension/pieces sub-line is restored from the matching source lines');
    ok(/Install after hours\./.test(job), '[13] Job-created: the Notes block is present');
    ok(/Payments Received To Date/.test(job), '[13] Job-created: payment history block present');

    const fromQuote = render(INV_FROM_QUOTE);
    ok(/TAX INVOICE/.test(fromQuote), '[14] Quote-created: established TAX INVOICE badge');
    ok(!/<td>Job No:<\/td>/.test(fromQuote), '[14] Quote-created: no Job No row — there is no job, and none is invented');
    ok(/<td>Quote Ref:<\/td><td>SQ-00151<\/td>/.test(fromQuote), '[14] Quote-created: Quote Ref row present');
    ok(/4000 mm/.test(fromQuote) && /2 off/.test(fromQuote),
      '[14] Quote-created: dimension/pieces sub-line restored from the matching quote lines');

    const man = render(INV_MANUAL);
    ok(/TAX INVOICE/.test(man) && /class="inv-badge"/.test(man), '[15] Manual: same established visual family');
    ok(!/<td>Job No:<\/td>/.test(man) && !/<td>Quote Ref:<\/td>/.test(man),
      '[15] Manual: Job No and Quote Ref rows are simply absent');
    ok(!/Attn: /.test(billedToBox(man)), '[15] Manual: no Attn line is invented');
    ok(!/Tel: /.test(billedToBox(man)), '[15] Manual: no telephone is invented in the Billed To box');
    ok(!/VAT Reg: /.test(billedToBox(man)), '[15] Manual: no VAT number is invented for an unknown customer');
    ok(/Karoo Trust/.test(man), '[15] Manual: the stored contact name is used');
    ok(/Banking Details/.test(man) && /Terms &amp; Conditions/.test(man),
      '[15] Manual: established Banking Details and Terms sections present');
    // A manual invoice for a customer that IS on file still gets its VAT number
    // from the Customer record — the established fallback, not an invention.
    const known = render({ ...INV_MANUAL, contactName: 'Acme Signs CC' });
    ok(/VAT Reg: 4990123456/.test(known),
      '[15] Manual: a known customer’s VAT number still comes from the Customer record');
  }

  // ══ 16,17 — the Quote is untouched ═══════════════════════════════════════
  console.log('\n[16,17] the Quote document and its arithmetic are unchanged');
  {
    const q = api.buildQuoteHtml(QUOTE, COMPANIES, null);
    for (const marker of ['Quotation', 'Quote No:', 'Valid Until:', 'Quoted To', 'From',
                          'Subtotal (excl. VAT &amp; discounts)', 'Design &amp; Setup Fee', 'VAT (15%)',
                          'TOTAL DUE', 'Deposit Required', 'Terms &amp; Conditions', 'Banking Details',
                          'ACCEPTANCE OF QUOTATION']) {
      ok(q.indexOf(marker) !== -1, `[16] established Quote section present: ${marker}`);
    }
    // Independent recomputation of the established formula.
    const sub = 4800, disc = 0, setup = 500;
    const after = sub - disc + setup, vat = after * 0.15, total = after + vat;
    ok(near(totalsRow(q, 'Subtotal (excl. VAT &amp; discounts)') || 0, sub), '[17] Quote subtotal unchanged', totalsRow(q, 'Subtotal (excl. VAT &amp; discounts)'));
    ok(near(totalsRow(q, 'Design &amp; Setup Fee') || 0, setup), '[17] Quote setup fee shown in totals, unchanged', totalsRow(q, 'Design &amp; Setup Fee'));
    ok(near(totalsRow(q, 'VAT (15%)') || 0, vat), '[17] Quote VAT unchanged', totalsRow(q, 'VAT (15%)'));
    ok(near(totalsRow(q, 'TOTAL DUE') || 0, total), '[17] Quote total unchanged', totalsRow(q, 'TOTAL DUE'));
    ok(near(totalsRow(q, '80% Deposit Required') || 0, total * 0.8), '[17] Quote deposit rule unchanged', totalsRow(q, '80% Deposit Required'));
  }

  // ══ 18 — PDF filenames ═══════════════════════════════════════════════════
  console.log('\n[18] suggested PDF filenames are unchanged');
  {
    const pm = extractFunction(appSrc, 'printManualInvoice');
    ok(/sgrOpenPrintPreview\(html, [^,]+, inv\.number\)/.test(pm),
      'printManualInvoice still passes inv.number as the filename (INV-#####.pdf)', pm.slice(-160));
    ok(/buildInvoiceHtml\(/.test(pm) && !/buildManualInvoiceHtml\(/.test(pm),
      '…and now builds the ESTABLISHED document rather than the manual one');
    const pi = extractFunction(appSrc, 'printInvoice');
    ok(/sgrOpenPrintPreview\(html, [^,]+, sgrJobInvoiceNumber\(job\)\)/.test(pi), 'printInvoice filename argument unchanged');
    const pq = extractFunction(appSrc, 'printQuoteWindow');
    ok(/sgrOpenPrintPreview\(html, 'Quotation '\+\(q\.num\|\|''\), q\.num\)/.test(pq), 'printQuoteWindow filename argument unchanged');
    const pp = extractFunction(appSrc, 'printProformaWindow');
    ok(/sgrOpenPrintPreview\(html, [^,]+, proformaNum\|\|quote\.num\)/.test(pp), 'printProformaWindow filename argument unchanged');
    ok(/<title>Invoice_'\+invNum\+'<\/title>/.test(appSrc), 'the invoice builder still emits its own <title>');
    ok(/<title>Quotation_\$\{q\.num\}<\/title>/.test(appSrc), 'the quote builder still emits its own <title>');
    ok(render(INV_FROM_JOB).indexOf('<title>Invoice_INV-00111</title>') !== -1,
      'a restored accounting invoice titles itself with its own invoice number');
  }

  // ══ 19 — no company-isolation / linkage-guessing change ══════════════════
  console.log('\n[19] ambiguous or absent linkage borrows nothing');
  {
    // Two jobs claiming the same job number → findLinkedRecords warns, and the
    // adapter must then take nothing from either.
    const twin = { ...JOB, id: 12, client: 'Someone Else', contact: 'Nobody', tel: '000', vatNum: '9999999999', notes: 'other' };
    const ambiguous = render(INV_FROM_JOB, { ...CTX, jobs: [JOB, twin] });
    ok(!/Attn: Jan Botha/.test(ambiguous) && !/Attn: Nobody/.test(ambiguous),
      'an ambiguous job link contributes no Attn line at all');
    ok(!/Tel: 044 000 1111/.test(billedToBox(ambiguous)) && !/Tel: 000/.test(billedToBox(ambiguous)),
      'an ambiguous job link contributes no telephone');
    ok(!/Install after hours\./.test(ambiguous) && !/other/.test(ambiguous),
      'an ambiguous job link contributes no Notes');
    const ambTotal = totalsRow(ambiguous, 'TOTAL DUE') ?? totalsRow(ambiguous, 'INVOICE TOTAL');
    const canTotal = totalsRow(canonical(INV_FROM_JOB), 'TOTAL DUE') ?? totalsRow(canonical(INV_FROM_JOB), 'INVOICE TOTAL');
    ok(ambTotal !== null && near(ambTotal!, canTotal!), '…and the money is still the invoice’s own, unchanged', { ambTotal, canTotal });

    // With no context at all — the worst case a caller can produce — the
    // invoice still prints, from what it stores itself.
    const bare = render(INV_MANUAL, { customers: [] });
    ok(/TAX INVOICE/.test(bare) && /INV-00113/.test(bare), 'with no linkage context the invoice still prints the established document');
    const bareTotal = totalsRow(bare, 'TOTAL DUE') ?? totalsRow(bare, 'INVOICE TOTAL');
    const bareCanon = totalsRow(canonical(INV_MANUAL), 'TOTAL DUE') ?? totalsRow(canonical(INV_MANUAL), 'INVOICE TOTAL');
    ok(bareTotal !== null && near(bareTotal!, bareCanon!), '…with identical money', { bareTotal, bareCanon });

    // The adapter is read-only: nothing it touched was mutated.
    ok(JOB.lines.length === 2 && (JOB.lines[0] as any).pQty === 3, 'the source job was not mutated');
    ok(QUOTE.lines.length === 1 && (QUOTE.lines[0] as any).pQty === 2, 'the source quote was not mutated');
    ok(INV_MANUAL.lineItems.length === 5, 'the manual invoice record was not mutated');
  }

  console.log('\n' + '='.repeat(60));
  console.log(`[invoice-layout-restore] ${passed} passed, ${failures} failed`);
  console.log('='.repeat(60));
  process.exit(failures > 0 ? 1 : 0);
}

try {
  main();
} catch (err) {
  console.error('\n[invoice-layout-restore] Fatal error:', err);
  process.exit(1);
}
