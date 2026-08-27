/**
 * relational.quote-invoice-sync.stress.ts
 * LINKED QUOTE → JOB → INVOICE SYNCHRONISATION (2026-08-27)
 *
 * THE DEFECT
 *   A Quote, its Job and its Invoice are three representations of ONE
 *   commercial transaction. Saving the quote cascaded onto the linked job's
 *   header fields and its `value` (updateQuoteWithJobSync) but reached the
 *   linked INVOICE nowhere at all — services.ts looked no invoice up on a quote
 *   save. An invoice raised before a quote edit therefore kept describing the
 *   pre-edit sale for ever: wrong description, wrong piece count, and a total
 *   that no longer agreed with the job value the same save had just rewritten.
 *
 * THE FIX BEING PROVED
 *   updateQuoteWithJobSync now rebuilds the ONE active linked invoice's
 *   commercial content, inside its own transaction, through THE SAME writers
 *   that created it (writeQuoteInvoiceLinesTx → writeInvoiceLinesFromSourceTx +
 *   writeInvoiceAdjustmentLinesTx). Presentation metadata (piece count,
 *   per-piece quantity, dimensions, unit) is snapshotted onto each invoice
 *   line's own legacy_data, so a rendered invoice never has to reach back into
 *   a Quote that may since have changed.
 *
 * COVERAGE (numbered to match the brief's required tests 1–30)
 *    1 description edit          11 ordinary qty             21 void invoice safety
 *    2 pieces edit               12 complete product         22 ambiguous linkage
 *    3 dimensions edit           13 m² line                  23 stale row_version
 *    4 per-piece qty edit        14 linear metre             24 quote with job, no invoice
 *    5 price edit                15 invoice, no payment      25 direct Quote → Invoice
 *    6 setup fee edit            16 invoice, full payment    26 automatic Job → Invoice
 *    7 discount edit             17 invoice, partial payment 27 presentation Quote == Invoice
 *    8 add line                  18 total increase, paid     28 financials unchanged unless intended
 *    9 delete line               19 total decrease, paid     29 Phase 1 freshness untouched
 *   10 reorder lines             20 cent-precision status    30 Step A presentation untouched
 *
 *   Plus: atomicity on a mid-chain failure, company isolation, invoice
 *   identity/payment-row immutability, and the INV-00117 control fixture.
 *
 * Throwaway PostgreSQL 16 only. No production connection, no production write.
 *
 * Usage (from backend/):
 *   npx ts-node --transpile-only test/relational.quote-invoice-sync.stress.ts
 */
import * as path from 'path';
import * as fs from 'fs';
import pool from '../src/db/pool';
import * as services from '../src/relational/services';

const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH || path.resolve(__dirname, '..', '..', 'index.html');
const SERVICES_TS_PATH = path.resolve(__dirname, '..', 'src', 'relational', 'services.ts');
const API_TS_PATH = path.resolve(__dirname, '..', 'src', 'relational', 'api.ts');

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}
const cents = (n: unknown) => Math.round((Number(n) || 0) * 100);
const money = (n: unknown) => cents(n) / 100;

async function reset() {
  await pool.query(`
    TRUNCATE TABLE rel_payments, rel_invoice_line_items, rel_invoices, rel_job_line_items,
      rel_jobs, rel_quote_line_items, rel_quotes, rel_credit_notes, rel_customers
    RESTART IDENTITY CASCADE
  `);
  await pool.query(`DELETE FROM document_number_counters`);
  await pool.query(`DELETE FROM quote_conversions`);
  await pool.query(`UPDATE platform_state SET data = '{}'::jsonb WHERE id = 1`);
}

async function invoiceTotals(invoiceId: number) {
  const res = await pool.query(
    `SELECT COALESCE(SUM(qty * unit_amount), 0) AS subtotal,
            COALESCE(SUM(CASE WHEN tax_type = '15%' THEN qty * unit_amount * 0.15 ELSE 0 END), 0) AS vat,
            COUNT(*)::int AS line_count
       FROM rel_invoice_line_items WHERE invoice_id = $1`,
    [invoiceId]
  );
  const r = res.rows[0];
  return { subtotal: Number(r.subtotal), vat: Number(r.vat), total: Number(r.subtotal) + Number(r.vat), lineCount: r.line_count };
}
async function invLines(invoiceId: number) {
  const res = await pool.query(
    `SELECT line_index, description, qty, unit_amount, account_code, tax_type, legacy_data
       FROM rel_invoice_line_items WHERE invoice_id = $1 ORDER BY line_index`, [invoiceId]);
  return res.rows;
}
async function invRow(invoiceId: number) {
  const r = await pool.query(
    `SELECT id, invoice_number, status, row_version, issue_date, due_date, created_at, quote_id, job_id, company_code
       FROM rel_invoices WHERE id = $1`, [invoiceId]);
  return r.rows[0];
}
async function payRows(invoiceId: number) {
  const r = await pool.query(
    `SELECT id, amount, payment_date, method, reference FROM rel_payments
      WHERE owner_type = 'invoice' AND owner_id = $1 ORDER BY id`, [invoiceId]);
  return r.rows;
}
const qv = async (id: number) => Number((await pool.query('SELECT row_version FROM rel_quotes WHERE id=$1', [id])).rows[0].row_version);
const jv = async (id: number) => Number((await pool.query('SELECT row_version FROM rel_jobs WHERE id=$1', [id])).rows[0].row_version);
const jobValue = async (id: number) => Number((await pool.query('SELECT value FROM rel_jobs WHERE id=$1', [id])).rows[0].value);

interface LineSpec { description: string; qty: number; unitPrice: number; pieces?: number | null; unit?: string | null; sqmL?: number | null; sqmW?: number | null; cpId?: string | null; cpLinked?: boolean | null }
const toPatchLine = (l: LineSpec) => ({
  description: l.description, desc: l.description, qty: l.qty, unitPrice: l.unitPrice,
  unit: l.unit === undefined ? 'ea' : l.unit,
  pieces: l.pieces === undefined ? null : l.pieces,
  sqmL: l.sqmL === undefined ? null : l.sqmL,
  sqmW: l.sqmW === undefined ? null : l.sqmW,
  cpId: l.cpId ?? null, cpLinked: l.cpLinked ?? null,
});

/** A quote → job → invoice chain, built with the deployed services only. */
async function makeChain(opts: {
  lines: LineSpec[]; setupFee?: number; discountPct?: number;
  invoiceFrom?: 'job' | 'quote'; companyCode?: string; customerName?: string; convert?: boolean;
}) {
  const companyCode = opts.companyCode ?? '2';
  const name = opts.customerName ?? 'Karoo Signs CC';
  const cust = await services.createCustomer({ companyName: name });
  const quote = await services.createQuote({
    companyCode, customerId: cust.id, customerNameRaw: name,
    setupFee: opts.setupFee ?? 0, discountPct: opts.discountPct ?? 0,
    lines: opts.lines.map(toPatchLine) as any,
  });
  let jobId: number | null = null;
  if (opts.convert !== false) {
    const conv = await services.convertQuoteToJob(quote.id);
    jobId = conv.jobId;
  }
  let invoiceId: number | null = null;
  let invoiceNumber: string | null = null;
  if (opts.invoiceFrom === 'job' && jobId !== null) {
    const r = await services.createInvoiceForJob(jobId);
    invoiceId = r.invoiceId; invoiceNumber = r.invoiceNumber;
  } else if (opts.invoiceFrom === 'quote') {
    const r = await services.createInvoiceFromQuote(quote.id);
    invoiceId = r.invoiceId; invoiceNumber = r.invoiceNumber;
  }
  return { quoteId: quote.id, jobId, invoiceId, invoiceNumber, companyCode };
}

/** Saves the quote exactly as PUT /api/relational/quotes/:id does. */
async function saveQuote(quoteId: number, patch: any, opts: any = {}) {
  return services.updateQuoteWithJobSync(quoteId, await qv(quoteId), patch, opts);
}

// ── THE INV-00117 CONTROL FIXTURE ───────────────────────────────────────────
// The real commercial shape: 1300 × 295 mm, 25 pieces, 0.3835 m² each, R550/m²,
// R250 setup fee, no discount. Effective billable 9.5875 m²; line R5,273.13;
// VAT R828.47; total R6,351.59. These numbers exist only here.
const CTRL_DESC = 'Full colour digital print on high quality outdoor vinyl with lamination.';
const CTRL_LINE: LineSpec = { description: CTRL_DESC, qty: 0.3835, unitPrice: 550, pieces: 25, unit: 'm²', sqmL: 1300, sqmW: 295 };
const CTRL_SETUP = 250;

async function main() {
  console.log('\n════════ LINKED QUOTE → JOB → INVOICE SYNCHRONISATION ════════');

  // ══ 0 — the defect itself, and the guarantee that it is fixed ═════════════
  console.log('\n[0] the reported defect: a quote edit used to leave the linked invoice stale');
  {
    await reset();
    const c = await makeChain({ lines: [CTRL_LINE], setupFee: CTRL_SETUP, invoiceFrom: 'job' });
    const before = await invLines(c.invoiceId!);
    ok(before[0].description === CTRL_DESC, 'invoice starts with the quote description');

    // ── BEFORE / AFTER, in one run ────────────────────────────────────────
    // updateQuote() is the NON-cascading updater that has always existed
    // alongside updateQuoteWithJobSync — it persists the one record and
    // nothing else. It is exactly what the whole quote-save path did with
    // respect to the invoice before this change (updateQuoteWithJobSync
    // referenced rel_invoices nowhere at all), so calling it here reproduces
    // the reported BEFORE state using deployed code rather than a fossil.
    await services.updateQuote(c.quoteId, await qv(c.quoteId), {
      lines: [toPatchLine({ ...CTRL_LINE, description: 'STALE-CHECK — edited on the quote only' })] as any,
    });
    const qOnly = (await pool.query('SELECT description FROM rel_quote_line_items WHERE quote_id=$1', [c.quoteId])).rows[0];
    ok(qOnly.description === 'STALE-CHECK — edited on the quote only', 'BEFORE: the quote changed');
    ok((await invLines(c.invoiceId!))[0].description === CTRL_DESC,
      'BEFORE: …and the linked invoice did NOT — this is the reported defect, reproduced');
    // Put the quote back so the AFTER case below starts from the same place.
    await services.updateQuote(c.quoteId, await qv(c.quoteId), { lines: [toPatchLine(CTRL_LINE)] as any });
    const r = await saveQuote(c.quoteId, { lines: [toPatchLine({ ...CTRL_LINE, description: 'EDITED — matte laminate' })] });
    const after = await invLines(c.invoiceId!);
    ok(r.invoice.reason === 'synced' && r.invoice.synced === true, 'the save reports the linked invoice was synchronised', r.invoice);
    ok(after[0].description === 'EDITED — matte laminate', '[1] description edit reaches the invoice', after[0].description);
    ok(r.invoice.invoiceNumber === c.invoiceNumber, '…and it is the SAME invoice, not a new one', r.invoice.invoiceNumber);
    const count = await pool.query('SELECT COUNT(*)::int c FROM rel_invoices');
    ok(count.rows[0].c === 1, 'no second invoice was created');
  }

  // ══ 1–5 — the commercial line edits ═══════════════════════════════════════
  console.log('\n[2,3,4,5] piece count, dimensions, per-piece qty and price edits');
  {
    await reset();
    const c = await makeChain({ lines: [CTRL_LINE], setupFee: CTRL_SETUP, invoiceFrom: 'job' });
    // [2] pieces 25 → 30
    await saveQuote(c.quoteId, { lines: [toPatchLine({ ...CTRL_LINE, pieces: 30 })] });
    let l = (await invLines(c.invoiceId!))[0];
    ok(cents(l.qty) === cents(30 * 0.3835), '[2] pieces 25→30: effective billable qty is 30 × 0.3835 = 11.5050', String(l.qty));
    ok(Number(l.legacy_data.pQty) === 30, '[2] …and the customer-facing PIECE COUNT is 30', l.legacy_data);
    ok(Number(l.legacy_data.pieceQty) === 0.3835, '[2] …while the PER-PIECE quantity is still 0.3835');
    // [3] dimensions 1300×295 → 1500×400
    await saveQuote(c.quoteId, { lines: [toPatchLine({ ...CTRL_LINE, pieces: 30, sqmL: 1500, sqmW: 400 })] });
    l = (await invLines(c.invoiceId!))[0];
    ok(Number(l.legacy_data.sqmL) === 1500 && Number(l.legacy_data.sqmW) === 400,
      '[3] dimension edit reaches the invoice', l.legacy_data);
    ok(Number(l.legacy_data.sqmL) === 1500 && String(l.legacy_data.sqmL) === '1500',
      '[3] …as a plain number, so a document never prints "1500.0000"', String(l.legacy_data.sqmL));
    // [4] per-piece qty 0.3835 → 0.6
    await saveQuote(c.quoteId, { lines: [toPatchLine({ ...CTRL_LINE, pieces: 30, sqmL: 1500, sqmW: 400, qty: 0.6 })] });
    l = (await invLines(c.invoiceId!))[0];
    ok(cents(l.qty) === cents(18), '[4] per-piece qty edit: 30 × 0.6 = 18.0000 effective', String(l.qty));
    ok(Number(l.legacy_data.pieceQty) === 0.6, '[4] …and the per-piece figure follows it');
    // [5] price 550 → 600
    await saveQuote(c.quoteId, { lines: [toPatchLine({ ...CTRL_LINE, pieces: 30, sqmL: 1500, sqmW: 400, qty: 0.6, unitPrice: 600 })] });
    l = (await invLines(c.invoiceId!))[0];
    ok(cents(l.unit_amount) === cents(600), '[5] unit price edit reaches the invoice', String(l.unit_amount));
    const t = await invoiceTotals(c.invoiceId!);
    ok(cents(t.subtotal) === cents(18 * 600 + CTRL_SETUP), '[5] …and the invoice re-totals canonically', t);
    ok(cents(t.total) === cents(await jobValue(c.jobId!)),
      'the invoice total still equals the job value the same save wrote', { inv: t.total, job: await jobValue(c.jobId!) });
  }

  // ══ 6,7 — setup fee and discount ══════════════════════════════════════════
  console.log('\n[6,7] setup fee and discount changes');
  {
    await reset();
    const c = await makeChain({ lines: [CTRL_LINE], setupFee: CTRL_SETUP, invoiceFrom: 'job' });
    let lines = await invLines(c.invoiceId!);
    ok(lines.length === 2 && lines[1].description === 'Design & Setup Fee', 'starts with one item + the setup fee line');
    await saveQuote(c.quoteId, { lines: [toPatchLine(CTRL_LINE)], setupFee: 400 });
    lines = await invLines(c.invoiceId!);
    ok(lines.length === 2 && cents(lines[1].unit_amount) === cents(400), '[6] setup fee 250→400 reaches the invoice', lines[1]);
    await saveQuote(c.quoteId, { lines: [toPatchLine(CTRL_LINE)], setupFee: 0 });
    lines = await invLines(c.invoiceId!);
    ok(lines.length === 1, '[6] setup fee → 0 REMOVES its adjustment line, leaving no orphan', lines.map((r: any) => r.description));
    await saveQuote(c.quoteId, { lines: [toPatchLine(CTRL_LINE)], setupFee: 0, discountPct: 10 });
    lines = await invLines(c.invoiceId!);
    ok(lines.length === 2 && /^Discount \(10%\)$/.test(lines[1].description) && Number(lines[1].unit_amount) < 0,
      '[7] a discount arrives as its own NEGATIVE adjustment line', lines[1]);
    await saveQuote(c.quoteId, { lines: [toPatchLine(CTRL_LINE)], setupFee: 300, discountPct: 10 });
    lines = await invLines(c.invoiceId!);
    ok(lines.length === 3 && /Discount/.test(lines[1].description) && lines[2].description === 'Design & Setup Fee',
      '[7] discount then setup fee, in the creation order', lines.map((r: any) => r.description));
    const t = await invoiceTotals(c.invoiceId!);
    ok(cents(t.total) === cents(await jobValue(c.jobId!)), '[7] …and the document still adds up to the job value');
  }

  // ══ 8,9,10 — add / delete / reorder ═══════════════════════════════════════
  console.log('\n[8,9,10] line addition, deletion and reordering');
  {
    await reset();
    const A: LineSpec = { description: 'Line A', qty: 2, unitPrice: 100, pieces: 1, unit: 'ea' };
    const B: LineSpec = { description: 'Line B', qty: 3, unitPrice: 50, pieces: 2, unit: 'ea' };
    const C: LineSpec = { description: 'Line C', qty: 1, unitPrice: 900, pieces: 1, unit: 'ea' };
    const c = await makeChain({ lines: [A, B], invoiceFrom: 'job' });
    ok((await invLines(c.invoiceId!)).length === 2, 'starts with two lines');
    await saveQuote(c.quoteId, { lines: [A, B, C].map(toPatchLine) });
    let lines = await invLines(c.invoiceId!);
    ok(lines.length === 3 && lines[2].description === 'Line C', '[8] an added quote line appears on the invoice', lines.map((r: any) => r.description));
    await saveQuote(c.quoteId, { lines: [A, C].map(toPatchLine) });
    lines = await invLines(c.invoiceId!);
    ok(lines.length === 2 && !lines.some((r: any) => r.description === 'Line B'),
      '[9] a deleted quote line is REMOVED from the invoice, not left behind', lines.map((r: any) => r.description));
    await saveQuote(c.quoteId, { lines: [C, A].map(toPatchLine) });
    lines = await invLines(c.invoiceId!);
    ok(lines[0].description === 'Line C' && lines[1].description === 'Line A',
      '[10] a reorder is reflected, with contiguous line_index', lines.map((r: any) => [r.line_index, r.description]));
    ok(lines.map((r: any) => Number(r.line_index)).join(',') === '0,1', '[10] …and no index gaps or duplicates');
    ok(cents((await invoiceTotals(c.invoiceId!)).total) === cents(await jobValue(c.jobId!)), '[10] totals still agree with the job value');
  }

  // ══ 11,12,13,14 — every line shape, not just dimensioned signage ══════════
  console.log('\n[11,12,13,14] ordinary, complete-product, m² and linear-metre lines');
  {
    await reset();
    const ord1: LineSpec = { description: 'Callout fee', qty: 1, unitPrice: 750, pieces: null, unit: 'ea' };
    const ord3: LineSpec = { description: 'Banner', qty: 3, unitPrice: 220, pieces: 1, unit: 'ea' };
    const cp: LineSpec = { description: 'Complete product', qty: 1, unitPrice: 1250, pieces: 2, unit: 'ea', cpId: 'inv-7', cpLinked: true };
    const sqm: LineSpec = { description: 'Panel', qty: 0.5, unitPrice: 400, pieces: 4, unit: 'm²', sqmL: 1000, sqmW: 500 };
    const lin: LineSpec = { description: 'Trim', qty: 2.4, unitPrice: 90, pieces: 3, unit: 'm (linear)', sqmL: 2400, sqmW: null };
    const nodim: LineSpec = { description: 'Hours', qty: 5, unitPrice: 60, pieces: 1, unit: 'hr' };
    const nounit: LineSpec = { description: 'Misc', qty: 1, unitPrice: 10, pieces: 1, unit: null };
    const c = await makeChain({ lines: [ord1, ord3, cp, sqm, lin, nodim, nounit], setupFee: 100, discountPct: 5, invoiceFrom: 'job' });
    await saveQuote(c.quoteId, { lines: [ord1, ord3, cp, sqm, lin, nodim, nounit].map(toPatchLine), setupFee: 100, discountPct: 5 });
    const lines = await invLines(c.invoiceId!);
    ok(lines.length === 9, '[11-14] seven item lines plus discount and setup fee', lines.length);
    ok(cents(lines[0].qty) === cents(1) && Number(lines[0].legacy_data.pQty) === 1,
      '[11] pieces NULL bills as 1 and states a piece count of 1', lines[0].legacy_data);
    ok(cents(lines[1].qty) === cents(3) && Number(lines[1].legacy_data.pieceQty) === 3,
      '[11] an ordinary qty-3 line bills 3 and keeps 3 as its per-piece quantity', lines[1].legacy_data);
    ok(cents(lines[2].qty) === cents(2), '[12] complete product with 2 pieces bills 2 × 1');
    ok(lines[2].legacy_data.unit === 'ea' && lines[2].legacy_data.sqmL === undefined,
      '[12] …with no dimensions invented for it', lines[2].legacy_data);
    ok(cents(lines[3].qty) === cents(2) && Number(lines[3].legacy_data.sqmL) === 1000 && Number(lines[3].legacy_data.sqmW) === 500,
      '[13] m² line: 4 × 0.5 = 2.0000 billed, 1000 × 500 mm stated', lines[3].legacy_data);
    ok(cents(lines[4].qty) === cents(7.2) && Number(lines[4].legacy_data.sqmL) === 2400 && lines[4].legacy_data.sqmW === undefined,
      '[14] linear metre: 3 × 2.4 = 7.2000 billed, length only — no width invented', lines[4].legacy_data);
    ok(lines[5].legacy_data.unit === 'hr' && lines[5].legacy_data.sqmL === undefined,
      'a unit-bearing line with no dimensions keeps its unit and invents nothing', lines[5].legacy_data);
    ok(lines[6].legacy_data.unit === undefined, 'a line with no unit stores no unit key at all', lines[6].legacy_data);
    ok(lines[7].description === 'Discount (5%)' && lines[8].description === 'Design & Setup Fee', 'adjustment lines in order');
    ok(Object.keys(lines[7].legacy_data).length === 0 && Object.keys(lines[8].legacy_data).length === 0,
      'adjustment lines carry NO presentation metadata — they are not commercial goods', [lines[7].legacy_data, lines[8].legacy_data]);
    ok(cents((await invoiceTotals(c.invoiceId!)).total) === cents(await jobValue(c.jobId!)), 'mixed document still adds up to the job value');
  }

  // ══ 15,16,17,18,19,20 — payments ══════════════════════════════════════════
  console.log('\n[15-20] payments are never altered; only the derived status moves');
  {
    await reset();
    // [15] no payment
    const c0 = await makeChain({ lines: [{ description: 'X', qty: 1, unitPrice: 1000, pieces: 1, unit: 'ea' }], invoiceFrom: 'job' });
    await saveQuote(c0.quoteId, { lines: [toPatchLine({ description: 'X', qty: 1, unitPrice: 1100, pieces: 1, unit: 'ea' })] });
    ok((await payRows(c0.invoiceId!)).length === 0, '[15] an invoice with no payment stays payment-free');

    // [16,18] full payment, then the invoice grows
    await reset();
    const c1 = await makeChain({ lines: [{ description: 'X', qty: 1, unitPrice: 1000, pieces: 1, unit: 'ea' }], invoiceFrom: 'job' });
    const total1 = (await invoiceTotals(c1.invoiceId!)).total;              // 1000 + VAT = 1150
    await services.recordPayment({ type: 'invoice', id: c1.invoiceId! }, money(total1), { method: 'EFT' });
    let inv = await invRow(c1.invoiceId!);
    ok(inv.status === 'paid', '[16] a fully-paid invoice is paid', inv.status);
    const payBefore = await payRows(c1.invoiceId!);
    await saveQuote(c1.quoteId, { lines: [toPatchLine({ description: 'X', qty: 1, unitPrice: 1200, pieces: 1, unit: 'ea' })] });
    const payAfter = await payRows(c1.invoiceId!);
    ok(JSON.stringify(payBefore) === JSON.stringify(payAfter),
      '[18] the payment row is byte-identical after the invoice grows — id, amount, date, method, reference');
    inv = await invRow(c1.invoiceId!);
    ok(inv.status === 'partial', '[18] …and the invoice becomes partial', inv.status);
    const t1 = await invoiceTotals(c1.invoiceId!);
    ok(cents(t1.total - money(total1)) === cents(200 * 1.15), '[18] …with a real balance of the difference', money(t1.total - money(total1)));

    // [19] the invoice shrinks back to at or below the payment
    await saveQuote(c1.quoteId, { lines: [toPatchLine({ description: 'X', qty: 1, unitPrice: 900, pieces: 1, unit: 'ea' })] });
    inv = await invRow(c1.invoiceId!);
    ok(inv.status === 'paid', '[19] shrinking below the payment returns it to paid', inv.status);
    ok(JSON.stringify(await payRows(c1.invoiceId!)) === JSON.stringify(payBefore), '[19] …still without touching the payment row');

    // [17] partial payment survives a sync as partial
    await reset();
    const c2 = await makeChain({ lines: [{ description: 'Y', qty: 1, unitPrice: 2000, pieces: 1, unit: 'ea' }], invoiceFrom: 'job' });
    await services.recordPayment({ type: 'invoice', id: c2.invoiceId! }, 500, { method: 'EFT' });
    await saveQuote(c2.quoteId, { lines: [toPatchLine({ description: 'Y', qty: 1, unitPrice: 2100, pieces: 1, unit: 'ea' })] });
    ok((await invRow(c2.invoiceId!)).status === 'partial', '[17] a partly-paid invoice stays partial');

    // [20] cent precision — the deployed rule, not a tolerance
    await reset();
    const c3 = await makeChain({ lines: [CTRL_LINE], setupFee: CTRL_SETUP, invoiceFrom: 'job' });
    const t3 = await invoiceTotals(c3.invoiceId!);
    ok(cents(t3.total) === cents(6351.59), 'control invoice totals R6,351.59', money(t3.total));
    await services.recordPayment({ type: 'invoice', id: c3.invoiceId! }, 6351.59, { method: 'EFT' });
    ok((await invRow(c3.invoiceId!)).status === 'paid',
      '[20] R6,351.59 settles a raw 6351.59375 invoice — the cent-precision fix still holds');
    await saveQuote(c3.quoteId, { lines: [toPatchLine(CTRL_LINE)], setupFee: CTRL_SETUP });
    ok((await invRow(c3.invoiceId!)).status === 'paid', '[20] …and a no-op resync does not disturb it');
  }

  // ══ 21,22 — void and ambiguous linkage ════════════════════════════════════
  console.log('\n[21,22] void invoices and ambiguous linkage are never rewritten');
  {
    await reset();
    const c = await makeChain({ lines: [CTRL_LINE], setupFee: CTRL_SETUP, invoiceFrom: 'job' });
    await pool.query(`UPDATE rel_invoices SET status = 'void' WHERE id = $1`, [c.invoiceId]);
    const beforeLines = JSON.stringify(await invLines(c.invoiceId!));
    const beforeVer = (await invRow(c.invoiceId!)).row_version;
    const r = await saveQuote(c.quoteId, { lines: [toPatchLine({ ...CTRL_LINE, description: 'CHANGED' })] });
    ok(r.invoice.reason === 'no-linked-invoice', '[21] a void invoice is not a sync target', r.invoice);
    ok(JSON.stringify(await invLines(c.invoiceId!)) === beforeLines, '[21] …and its lines are untouched');
    ok((await invRow(c.invoiceId!)).row_version === beforeVer, '[21] …and its row_version did not move');

    // Two active linked invoices — never guess which one.
    await reset();
    const c2 = await makeChain({ lines: [CTRL_LINE], setupFee: CTRL_SETUP, invoiceFrom: 'job' });
    await pool.query(
      `INSERT INTO rel_invoices (source_id, invoice_number, company_code, contact_name, job_id, status, issue_date, legacy_data)
       VALUES ('x', 'INV-SECOND', '2', 'Karoo Signs CC', $1, 'sent', CURRENT_DATE, '{}'::jsonb)`, [c2.jobId]);
    const before2 = JSON.stringify(await invLines(c2.invoiceId!));
    const r2 = await saveQuote(c2.quoteId, { lines: [toPatchLine({ ...CTRL_LINE, description: 'CHANGED TOO' })] });
    ok(r2.invoice.reason === 'ambiguous', '[22] two active linked invoices abort synchronisation', r2.invoice);
    ok(JSON.stringify(await invLines(c2.invoiceId!)) === before2, '[22] …and neither invoice is modified');
    const q = await pool.query('SELECT * FROM rel_quote_line_items WHERE quote_id = $1', [c2.quoteId]);
    ok(q.rows[0].description === 'CHANGED TOO', '[22] …while the quote save itself still succeeds');
    ok((await pool.query('SELECT COUNT(*)::int c FROM rel_invoices')).rows[0].c === 2, '[22] …and no third invoice appears');
  }

  // ══ 23 — concurrency ══════════════════════════════════════════════════════
  console.log('\n[23] optimistic concurrency on all three records');
  {
    await reset();
    const c = await makeChain({ lines: [CTRL_LINE], setupFee: CTRL_SETUP, invoiceFrom: 'job' });
    const good = { lines: [toPatchLine({ ...CTRL_LINE, description: 'V2' })] };
    let threw = '';
    try { await services.updateQuoteWithJobSync(c.quoteId, (await qv(c.quoteId)) + 5, good); } catch (e: any) { threw = e.constructor.name; }
    ok(threw === 'ConcurrencyConflictError', '[23] a stale QUOTE version is refused', threw);
    threw = '';
    try { await saveQuote(c.quoteId, good, { expectedJobVersion: (await jv(c.jobId!)) + 5 }); } catch (e: any) { threw = e.constructor.name; }
    ok(threw === 'ConcurrencyConflictError', '[23] a stale JOB version is refused', threw);
    threw = '';
    const invVer = Number((await invRow(c.invoiceId!)).row_version);
    try { await saveQuote(c.quoteId, good, { expectedInvoiceVersion: invVer + 5 }); } catch (e: any) { threw = e.constructor.name; }
    ok(threw === 'ConcurrencyConflictError', '[23] a stale INVOICE version is refused', threw);
    const lines = await invLines(c.invoiceId!);
    ok(lines[0].description === CTRL_DESC, '[23] …and after all three refusals nothing was applied anywhere', lines[0].description);
    const qrow = await pool.query('SELECT description FROM rel_quote_line_items WHERE quote_id=$1', [c.quoteId]);
    ok(qrow.rows[0].description === CTRL_DESC, '[23] …including the quote itself — NO PARTIAL CHAIN SAVE');
    // …and the correct version succeeds.
    const okRes = await saveQuote(c.quoteId, good, { expectedInvoiceVersion: invVer });
    ok(okRes.invoice.reason === 'synced', '[23] the same save with the CURRENT invoice version succeeds');
  }

  // ══ 16b — atomicity on a mid-chain failure ════════════════════════════════
  console.log('\n[atomicity] a failure during invoice sync rolls the whole chain back');
  {
    await reset();
    const c = await makeChain({ lines: [CTRL_LINE], setupFee: CTRL_SETUP, invoiceFrom: 'job' });
    const beforeQuote = JSON.stringify((await pool.query('SELECT description, qty, unit_price FROM rel_quote_line_items WHERE quote_id=$1 ORDER BY line_index', [c.quoteId])).rows);
    const beforeJobValue = await jobValue(c.jobId!);
    const beforeInv = JSON.stringify(await invLines(c.invoiceId!));
    // Force the invoice-side guard to fire by making the invoice unwritable
    // mid-transaction: a CHECK that rejects the rebuilt rows.
    await pool.query(`ALTER TABLE rel_invoice_line_items ADD CONSTRAINT _sync_test_block CHECK (description <> 'BOOM')`);
    let failed = false;
    try { await saveQuote(c.quoteId, { lines: [toPatchLine({ ...CTRL_LINE, description: 'BOOM' })] }); }
    catch (e) { failed = true; }
    await pool.query(`ALTER TABLE rel_invoice_line_items DROP CONSTRAINT _sync_test_block`);
    ok(failed, 'the save failed rather than half-applying');
    ok(JSON.stringify((await pool.query('SELECT description, qty, unit_price FROM rel_quote_line_items WHERE quote_id=$1 ORDER BY line_index', [c.quoteId])).rows) === beforeQuote,
      '…the QUOTE rolled back');
    ok(cents(await jobValue(c.jobId!)) === cents(beforeJobValue), '…the JOB rolled back');
    ok(JSON.stringify(await invLines(c.invoiceId!)) === beforeInv, '…the INVOICE rolled back');
  }

  // ══ 24,25,26 — the three chain shapes ═════════════════════════════════════
  console.log('\n[24,25,26] quote with no invoice, direct Quote→Invoice, automatic Job→Invoice');
  {
    await reset();
    const c1 = await makeChain({ lines: [CTRL_LINE], setupFee: CTRL_SETUP });   // job, no invoice
    const r1 = await saveQuote(c1.quoteId, { lines: [toPatchLine({ ...CTRL_LINE, description: 'no invoice here' })] });
    ok(r1.invoice.reason === 'no-linked-invoice' && Number(r1.jobId) === Number(c1.jobId),
      '[24] a quote with a job but no invoice syncs the job and reports nothing to do', { invoice: r1.invoice, jobId: r1.jobId, expected: c1.jobId });

    await reset();
    const c2 = await makeChain({ lines: [CTRL_LINE], setupFee: CTRL_SETUP, invoiceFrom: 'quote', convert: false });
    const r2 = await saveQuote(c2.quoteId, { lines: [toPatchLine({ ...CTRL_LINE, description: 'direct path' })] });
    ok(r2.jobId === null && r2.invoice.reason === 'synced', '[25] a direct Quote→Invoice with no job at all still synchronises', r2.invoice);
    ok((await invLines(c2.invoiceId!))[0].description === 'direct path', '[25] …by quote_id linkage alone');

    await reset();
    const c3 = await makeChain({ lines: [CTRL_LINE], setupFee: CTRL_SETUP });
    await services.ensureInvoiceForJob(c3.jobId!);
    const r3 = await saveQuote(c3.quoteId, { lines: [toPatchLine({ ...CTRL_LINE, description: 'auto job invoice' })] });
    ok(r3.invoice.reason === 'synced', '[26] an automatically-created job invoice is found by job_id linkage', r3.invoice);
  }

  // ══ company isolation ═════════════════════════════════════════════════════
  console.log('\n[isolation] company isolation is preserved');
  {
    await reset();
    const c = await makeChain({ lines: [CTRL_LINE], setupFee: CTRL_SETUP, invoiceFrom: 'job', companyCode: '2' });
    await pool.query(`UPDATE rel_invoices SET company_code = '1' WHERE id = $1`, [c.invoiceId]);
    const before = JSON.stringify(await invLines(c.invoiceId!));
    const r = await saveQuote(c.quoteId, { lines: [toPatchLine({ ...CTRL_LINE, description: 'cross company' })] });
    ok(r.invoice.reason === 'company-mismatch', 'a company-2 quote never rewrites a company-1 invoice', r.invoice);
    ok(JSON.stringify(await invLines(c.invoiceId!)) === before, '…and that invoice is untouched');
  }

  // ══ invoice identity is never rewritten ═══════════════════════════════════
  console.log('\n[identity] invoice-only accounting fields are never overwritten');
  {
    await reset();
    const c = await makeChain({ lines: [CTRL_LINE], setupFee: CTRL_SETUP, invoiceFrom: 'job' });
    await pool.query(`UPDATE rel_invoices SET due_date = DATE '2026-12-31', issue_date = DATE '2026-01-02' WHERE id = $1`, [c.invoiceId]);
    const before = await invRow(c.invoiceId!);
    await saveQuote(c.quoteId, { lines: [toPatchLine({ ...CTRL_LINE, description: 'identity check' })] });
    const after = await invRow(c.invoiceId!);
    for (const k of ['id', 'invoice_number', 'issue_date', 'due_date', 'created_at', 'quote_id', 'job_id', 'company_code']) {
      ok(String(before[k]) === String(after[k]), `${k} is unchanged by synchronisation`, { before: before[k], after: after[k] });
    }
    ok(Number(after.row_version) === Number(before.row_version) + 1, 'only row_version moved, by exactly one');
  }

  // ══ no-op saves cause no churn ════════════════════════════════════════════
  console.log('\n[no-op] a header-only or identical save does not touch the invoice');
  {
    await reset();
    const c = await makeChain({ lines: [CTRL_LINE], setupFee: CTRL_SETUP, invoiceFrom: 'job' });
    // The FIRST commercial save after a JOB-sourced invoice legitimately differs:
    // creation wrote the lines from rel_job_line_items, synchronisation writes
    // them from rel_quote_line_items, so the provenance recorded on each line
    // changes even when every figure is identical. That is a real change and is
    // reported as one. It is the SECOND identical save that must be free.
    const rFirst = await saveQuote(c.quoteId, { lines: [toPatchLine(CTRL_LINE)], setupFee: CTRL_SETUP });
    ok(rFirst.invoice.reason === 'synced', 'the first sync of a job-sourced invoice re-sources it from the quote', rFirst.invoice);
    const v0 = Number((await invRow(c.invoiceId!)).row_version);
    const rA = await saveQuote(c.quoteId, { phone: '044 000 1111' });
    ok(rA.invoice.reason === 'not-requested', 'a header-only edit never looks an invoice up at all', rA.invoice);
    ok(Number((await invRow(c.invoiceId!)).row_version) === v0, '…so the invoice row_version does not move');
    const rB = await saveQuote(c.quoteId, { lines: [toPatchLine(CTRL_LINE)], setupFee: CTRL_SETUP });
    ok(rB.invoice.reason === 'unchanged', 'an identical rebuild reports "unchanged"', rB.invoice);
    ok(Number((await invRow(c.invoiceId!)).row_version) === v0,
      '…and still does not bump row_version, so Phase 1 freshness sees no false change');
  }

  // ══ 27, and the INV-00117 control ═════════════════════════════════════════
  console.log('\n[27, INV-00117] the control fixture: presentation and money');
  {
    await reset();
    const c = await makeChain({ lines: [CTRL_LINE], setupFee: CTRL_SETUP, invoiceFrom: 'job' });
    // Reproduce the production condition: the JOB line lost its dimensions and
    // unit (migration-013 era). The invoice must still end up complete, because
    // it is synchronised from the QUOTE, which still has them.
    await pool.query(`UPDATE rel_job_line_items SET sqm_l = NULL, sqm_w = NULL, unit = NULL, legacy_data = '{}'::jsonb WHERE job_id = $1`, [c.jobId]);
    const r = await saveQuote(c.quoteId, { lines: [toPatchLine(CTRL_LINE)], setupFee: CTRL_SETUP });
    ok(r.invoice.reason === 'synced', 'the control chain synchronises');
    const l = (await invLines(c.invoiceId!))[0];
    ok(l.description === CTRL_DESC, 'DESCRIPTION matches the quote');
    ok(Number(l.legacy_data.pQty) === 25, 'ITEM QTY: the invoice now carries the piece count 25', l.legacy_data);
    ok(Number(l.legacy_data.pieceQty) === 0.3835, 'and the per-piece area 0.3835');
    ok(Number(l.legacy_data.sqmL) === 1300 && Number(l.legacy_data.sqmW) === 295 && l.legacy_data.unit === 'm²',
      'SPECIFICATION: 1300 × 295 mm, m² — recovered from the QUOTE, not from the degraded job line', l.legacy_data);
    ok(cents(l.qty) === cents(9.5875), 'the internal EFFECTIVE quantity is still 9.5875', String(l.qty));
    ok(cents(l.unit_amount) === cents(550), 'unit amount R550.00');
    const t = await invoiceTotals(c.invoiceId!);
    ok(cents(t.subtotal) === cents(5273.13 + 250), 'LINE R5,273.13 + Setup R250.00', money(t.subtotal));
    ok(cents(t.vat) === cents(828.47), 'VAT R828.47', money(t.vat));
    ok(cents(t.total) === cents(6351.59), 'TOTAL R6,351.59', money(t.total));
    // [27] Quote and Invoice describe the SAME commercial line.
    const ql = (await pool.query('SELECT description, qty, unit, sqm_l, sqm_w, pieces FROM rel_quote_line_items WHERE quote_id=$1 ORDER BY line_index', [c.quoteId])).rows[0];
    ok(ql.description === l.description
      && Number(ql.pieces) === Number(l.legacy_data.pQty)
      && Number(ql.qty) === Number(l.legacy_data.pieceQty)
      && Number(ql.sqm_l) === Number(l.legacy_data.sqmL)
      && Number(ql.sqm_w) === Number(l.legacy_data.sqmW)
      && ql.unit === l.legacy_data.unit,
      '[27] every customer-facing field on the invoice equals the quote\'s',
      { quote: ql, invoice: l.legacy_data });
    // The three quantities remain three separate things.
    ok(Number(l.legacy_data.pQty) !== Number(l.qty) && Number(l.legacy_data.pieceQty) !== Number(l.qty),
      '[27] piece count, per-piece area and effective billable quantity are still three distinct values',
      { pQty: l.legacy_data.pQty, pieceQty: l.legacy_data.pieceQty, qty: String(l.qty) });
  }

  // ══ 28,29,30 — nothing deployed regressed ═════════════════════════════════
  console.log('\n[28,29,30] the deployed work is intact');
  {
    const src = fs.readFileSync(SERVICES_TS_PATH, 'utf8');
    ok(/const EFFECTIVE_QTY_SQL = '\(\$4::numeric \* sl\.qty\)';/.test(src),
      '[28] EFFECTIVE_QTY_SQL is byte-identical — the financial mapping did not change');
    ok(/function toCents\(n: number\): number \{\s*return Math\.round\(\(Number\(n\) \|\| 0\) \* 100\) \/ 100;/.test(src),
      '[20,28] the cent-precision helper is unchanged');
    ok(src.indexOf('await writeQuoteInvoiceLinesTx(client, invoiceId, quoteLinesRes.rows, quoteAfterSave, piecesMap)') !== -1,
      '[28] synchronisation reuses the CREATION writer rather than a second mapping');
    ok(src.indexOf('if (finalLines && opts.resyncJobLines === true)') !== -1,
      'BLOCKER 2 is intact — a quote save still cannot rewrite production job lines');
    const api = fs.readFileSync(API_TS_PATH, 'utf8');
    ok(/resyncJobLines: _rsjl/.test(api), 'resyncJobLines is still stripped at the HTTP boundary');
    ok(/expectedInvoiceVersion/.test(api), 'expectedInvoiceVersion is forwarded so a stale invoice is detectable');

    const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
    ok(html.indexOf('selective._relationalAuthoritativeSections = dbData._relationalAuthoritativeSections;') !== -1,
      '[29] the Phase 1 hydration correction is still present');
    ok(html.indexOf('const POLL_MS = 25000;') !== -1 && html.indexOf("FRESHNESS_REFRESHABLE_SECTIONS = ['suppliers', 'inventory', 'quotes', 'jobs', 'accInvoices', 'creditNotes']") !== -1,
      '[29] Phase 1 freshness polling and its section list are unchanged');
    ok(html.indexOf('function sgrLinePieceCount(l){') !== -1 && html.indexOf('function lineItemCountText(l, opts){') !== -1,
      '[30] the Step A presentation helpers are unchanged');
    ok(html.indexOf("qty:  has(own.pieceQty) ? own.pieceQty : (e ? e.qty : (l && l.qty==null ? '' : l.qty)),") !== -1,
      '[30] …and the renderer already prefers the invoice line\'s OWN snapshot, which is what this task now writes');
  }

  console.log('\n============================================================');
  console.log(`[quote-invoice-sync] ${passed} passed, ${failures} failed`);
  console.log('============================================================');
  await pool.end();
  if (failures > 0) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error('\n[quote-invoice-sync] Fatal error:', err);
  process.exitCode = 1;
  await pool.end().catch(() => undefined);
});
