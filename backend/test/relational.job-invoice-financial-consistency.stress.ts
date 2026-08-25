/**
 * relational.job-invoice-financial-consistency.stress.ts
 * JOB/QUOTE → INVOICE FINANCIAL CONSISTENCY REPAIR (2026-08-25)
 *
 * Proves the repair to services.ts's writeInvoiceLinesFromJobTx /
 * finalizeProformaToInvoice, driven by the confirmed production case
 * SQ-00108 → SNS-00110 → INV-00103 (Audio Access).
 *
 * THE CONFIRMED DEFECT
 *   An invoice derived from a job (or a quote) was written as a plain
 *   qty x unit_price copy of the source lines. That dropped `pieces`
 *   (migration 013), the document's setup fee and its discount — so the
 *   invoice did not add up to the job it was raised for. In production this
 *   turned a R7,300.27 job into a R3,506.39 invoice.
 *
 * COVERAGE (labelled A–Q to match the repair brief)
 *   A  pieces = 1                → correct invoice
 *   B  pieces > 1                → correct invoice (the core defect)
 *   C  pieces = NULL (historical)→ compatibility default of 1
 *   D  setup fee > 0             → included exactly once
 *   E  discount > 0              → represented exactly once, as a negative line
 *   F  VAT correct
 *   G  invoice total == job value
 *   H  full Quote → Job → Invoice financial chain
 *   I  generic standalone manual invoice unaffected
 *   J  Job-specific manual invoice path (current behaviour asserted in source)
 *   K  existing valid manual-invoice reuse still works
 *   L  no duplicate invoice creation
 *   M  invoice canonicalisation / delete cleanup still correct
 *   N  payments still correct against the corrected total
 *   O  co=2 and Holdings co=1 remain isolated
 *   P  migration-013 recovery classification (all four outcomes)
 *   Q  recovery never overwrites a non-NULL current value
 *   +  Audio Access local reproduction: BEFORE vs AFTER
 */
import * as path from 'path';
import * as fs from 'fs';
import pool from '../src/db/pool';
import * as services from '../src/relational/services';
import {
  classifyLineRecovery, analyzeMigration013Recovery, findJsonDocument, findJsonLine,
  RelationalLineSnapshot, RecoveryCandidate,
} from '../src/relational/migration013Recovery';

const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH || path.resolve(__dirname, '..', '..', 'index.html');

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}
/** Money comparison at the cent, which is the precision every document states. */
function money(n: unknown): number { return Math.round((Number(n) || 0) * 100) / 100; }
function eqMoney(a: unknown, b: unknown): boolean { return Math.abs(money(a) - money(b)) < 0.005; }

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

/** Everything an invoice is worth, derived the one way the app derives it:
 *  from its lines. rel_invoices deliberately stores no totals. */
async function invoiceTotals(invoiceId: number) {
  const res = await pool.query(
    `SELECT COALESCE(SUM(qty * unit_amount), 0) AS subtotal,
            COALESCE(SUM(CASE WHEN tax_type = '15%' THEN qty * unit_amount * 0.15 ELSE 0 END), 0) AS vat,
            COUNT(*)::int AS line_count
       FROM rel_invoice_line_items WHERE invoice_id = $1`,
    [invoiceId]
  );
  const r = res.rows[0];
  return {
    subtotal: Number(r.subtotal), vat: Number(r.vat),
    total: Number(r.subtotal) + Number(r.vat), lineCount: r.line_count,
  };
}

async function invoiceLines(invoiceId: number) {
  const res = await pool.query(
    `SELECT line_index, description, qty, unit_amount, tax_type
       FROM rel_invoice_line_items WHERE invoice_id = $1 ORDER BY line_index`,
    [invoiceId]
  );
  return res.rows;
}

/**
 * The PRE-REPAIR writer, reproduced verbatim so "before" can be measured
 * against "after" in the same run. This is a fossil for the test's benefit
 * only — nothing in src/ calls it, and nothing should.
 */
async function writeInvoiceLinesTheOldWay(invoiceId: number, jobId: number) {
  await pool.query('DELETE FROM rel_invoice_line_items WHERE invoice_id = $1', [invoiceId]);
  const jl = await pool.query('SELECT * FROM rel_job_line_items WHERE job_id = $1 ORDER BY line_index', [jobId]);
  for (const l of jl.rows) {
    await pool.query(
      `INSERT INTO rel_invoice_line_items (invoice_id, line_index, description, qty, unit_amount, account_code, tax_type, legacy_data)
       VALUES ($1, $2, $3, $4, $5, '4000', '15%', '{}'::jsonb)`,
      [invoiceId, l.line_index, l.description, l.qty, l.unit_price]
    );
  }
}

interface JobFixture { quoteId: number; jobId: number; quoteTotal: number; jobValue: number; jobNumber: string; }

async function makeJob(opts: {
  companyCode?: string;
  lines: Array<{ description: string; qty: number; unitPrice: number; pieces?: number | null; unit?: string }>;
  setupFee?: number;
  discountPct?: number;
  stage?: number;
  customerName?: string;
}): Promise<JobFixture> {
  const companyCode = opts.companyCode ?? '2';
  const name = opts.customerName ?? 'Audio Access';
  const cust = await services.createCustomer({ companyName: name });
  const quote = await services.createQuote({
    companyCode, customerId: cust.id, customerNameRaw: name,
    setupFee: opts.setupFee ?? 0, discountPct: opts.discountPct ?? 0,
    lines: opts.lines.map((l) => ({
      description: l.description, qty: l.qty, unitPrice: l.unitPrice,
      unit: l.unit ?? 'ea', pieces: l.pieces === undefined ? null : l.pieces,
    })),
  });
  const conv = await services.convertQuoteToJob(quote.id);
  if (opts.stage !== undefined) {
    await pool.query('UPDATE rel_jobs SET stage = $1 WHERE id = $2', [opts.stage, conv.jobId]);
  }
  const qRow = await pool.query('SELECT total FROM rel_quotes WHERE id = $1', [quote.id]);
  const jRow = await pool.query('SELECT value, job_number FROM rel_jobs WHERE id = $1', [conv.jobId]);
  return {
    quoteId: quote.id, jobId: conv.jobId,
    quoteTotal: Number(qRow.rows[0].total),
    jobValue: Number(jRow.rows[0].value),
    jobNumber: jRow.rows[0].job_number,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE AUDIO ACCESS FIXTURE
//
// Reproduces the CONFIRMED production shape, not the production data: 5 lines,
// pieces = 2 on every line, a R250 setup fee, no discount. The line values are
// chosen so the quote total lands on R7,300.27 and the old writer's output
// lands on R3,506.39 — the two figures the production diagnostic reported —
// so "before" and "after" are directly comparable to the real case.
//
// These numbers exist ONLY here. Nothing in src/ knows them.
// ─────────────────────────────────────────────────────────────────────────────
const AUDIO_ACCESS_LINES = [
  { description: 'Illuminated flat-cut letters', qty: 1.2, unitPrice: 450, pieces: 2, unit: 'm²' },
  { description: 'Brushed aluminium tray',       qty: 0.96, unitPrice: 625, pieces: 2, unit: 'm²' },
  { description: 'Vinyl applied graphics',       qty: 2.5, unitPrice: 300, pieces: 2, unit: 'm²' },
  { description: 'Powder-coated bracket set',    qty: 1, unitPrice: 800, pieces: 2, unit: 'ea' },
  { description: 'Installation hardware pack',   qty: 1, unitPrice: 359.032, pieces: 2, unit: 'ea' },
];
const AUDIO_ACCESS_SETUP_FEE = 250;
const AUDIO_ACCESS_EXPECTED_TOTAL = 7300.27;   // quote total / job value, VAT incl
const AUDIO_ACCESS_BROKEN_TOTAL = 3506.39;     // what the pre-repair writer produced

async function main() {
  await reset();

  // ══ AUDIO ACCESS — BEFORE vs AFTER ═══════════════════════════════════════
  console.log('\n[Audio Access] local reproduction of the confirmed production shape');
  {
    const fx = await makeJob({ lines: AUDIO_ACCESS_LINES, setupFee: AUDIO_ACCESS_SETUP_FEE, stage: 8 });
    ok(eqMoney(fx.quoteTotal, AUDIO_ACCESS_EXPECTED_TOTAL),
      `fixture reproduces the production quote total (R${AUDIO_ACCESS_EXPECTED_TOTAL})`, fx.quoteTotal);
    ok(eqMoney(fx.jobValue, AUDIO_ACCESS_EXPECTED_TOTAL),
      'the converted job carries that same value', fx.jobValue);

    // AFTER — exactly what the repaired writer produced, untouched.
    const inv = await services.createInvoiceForJob(fx.jobId);
    const after = await invoiceTotals(inv.invoiceId);

    // BEFORE — an identical second job, whose invoice lines are then rewritten
    // the way the pre-repair writer wrote them. Two separate jobs, so the
    // "after" measurement above is never disturbed to produce the "before" one.
    const fxBefore = await makeJob({ lines: AUDIO_ACCESS_LINES, setupFee: AUDIO_ACCESS_SETUP_FEE, stage: 8 });
    const invBefore = await services.createInvoiceForJob(fxBefore.jobId);
    await writeInvoiceLinesTheOldWay(invBefore.invoiceId, fxBefore.jobId);
    const before = await invoiceTotals(invBefore.invoiceId);

    ok(eqMoney(before.total, AUDIO_ACCESS_BROKEN_TOTAL),
      `BEFORE: the old writer reproduces the wrong R${AUDIO_ACCESS_BROKEN_TOTAL} result`, before);
    ok(!eqMoney(before.total, fxBefore.jobValue),
      'BEFORE: that invoice does NOT agree with the job it was raised for', before.total);
    ok(before.lineCount === 5, 'BEFORE: 5 item lines and no setup-fee line at all', before.lineCount);

    ok(eqMoney(after.total, AUDIO_ACCESS_EXPECTED_TOTAL),
      `AFTER: the repaired writer produces R${AUDIO_ACCESS_EXPECTED_TOTAL}`, after);
    ok(eqMoney(after.total, fx.jobValue), 'AFTER: invoice total equals the job value exactly', { after: after.total, job: fx.jobValue });
    ok(after.lineCount === 6, 'AFTER: 5 item lines + 1 setup-fee line', after.lineCount);
  }

  // ══ A — pieces = 1 ═══════════════════════════════════════════════════════
  console.log('\n[A] job with pieces = 1 → correct invoice');
  await reset();
  {
    const fx = await makeJob({ lines: [{ description: 'Banner', qty: 3, unitPrice: 100, pieces: 1 }], stage: 8 });
    const inv = await services.createInvoiceForJob(fx.jobId);
    const t = await invoiceTotals(inv.invoiceId);
    ok(eqMoney(t.subtotal, 300), 'subtotal is 3 x 100', t.subtotal);
    ok(eqMoney(t.total, fx.jobValue), 'invoice total equals job value', { t: t.total, job: fx.jobValue });
    const lines = await invoiceLines(inv.invoiceId);
    ok(lines.length === 1 && eqMoney(lines[0].qty, 3), 'a single-piece line bills its own qty unchanged', lines);
  }

  // ══ B — pieces > 1 (THE defect) ══════════════════════════════════════════
  console.log('\n[B] job with pieces > 1 → correct invoice');
  await reset();
  {
    const fx = await makeJob({ lines: [{ description: 'Panel', qty: 2, unitPrice: 250, pieces: 4 }], stage: 8 });
    const inv = await services.createInvoiceForJob(fx.jobId);
    const t = await invoiceTotals(inv.invoiceId);
    ok(eqMoney(t.subtotal, 2000), 'subtotal is pieces x qty x price = 4 x 2 x 250', t.subtotal);
    ok(eqMoney(t.total, fx.jobValue), 'invoice total equals job value', { t: t.total, job: fx.jobValue });
    const lines = await invoiceLines(inv.invoiceId);
    ok(eqMoney(lines[0].qty, 8), 'pieces are folded into the billed qty (4 x 2 = 8)', lines[0].qty);
    ok(eqMoney(lines[0].unit_amount, 250), 'unit_amount stays the TRUE unit price', lines[0].unit_amount);
    const jl = await pool.query('SELECT qty, pieces FROM rel_job_line_items WHERE job_id = $1', [fx.jobId]);
    ok(eqMoney(jl.rows[0].qty, 2) && Number(jl.rows[0].pieces) === 4,
      'the JOB line is untouched — pieces and qty stay separate there (inventory/spec depend on it)', jl.rows[0]);
  }

  // ══ C — historical pieces = NULL ═════════════════════════════════════════
  //
  // 2026-08-25 (HISTORICAL PIECES PROTECTION) — deliberately rewritten, because
  // the behaviour this case used to assert is the behaviour that has now been
  // fixed. It previously built a job whose value said R1,035 (pieces = 3),
  // NULLed the piece count to simulate a pre-013 backfill, and asserted the
  // resulting invoice "HONESTLY under-states the job... this is what Part 3
  // recovery is for". Part 3 is now wired into invoicing, so an invoice 3x
  // short of its own job is not issued at all — the financial consistency
  // guard refuses it. That is precisely the SQ-00150 -> INV-00111 failure mode,
  // and this is where it now dies.
  //
  // The compatibility default itself is unchanged and still asserted, below, on
  // a job where a NULL piece count is genuinely all there ever was.
  console.log('\n[C] pieces = NULL: still compatible when genuinely absent, REFUSED when the job says otherwise');
  await reset();
  {
    // C1 — genuinely no piece count, and the job's own value agrees with that.
    // Nothing is recoverable (created relationally: legacy_data '{}',
    // platform_state empty), so the documented NULL -> 1 default applies and
    // the invoice is issued exactly as it always was.
    const fxNone = await makeJob({ lines: [{ description: 'Never had pieces', qty: 5, unitPrice: 60, pieces: null }], stage: 8 });
    const invNone = await services.createInvoiceForJob(fxNone.jobId);
    const tNone = await invoiceTotals(invNone.invoiceId);
    ok(eqMoney(tNone.subtotal, 300), 'a genuinely absent piece count still prices as 1 — exactly as it does today', tNone.subtotal);
    ok(eqMoney(tNone.total, fxNone.jobValue),
      'and the invoice matches the job value, because the job never claimed more', { invoice: tNone.total, job: fxNone.jobValue });

    // C2 — the same NULL, but on a job whose value was set while the piece
    // count still existed, and whose historical record is gone. There is
    // nothing to recover from, so nothing is guessed — and because the document
    // would come out 3x short of the job it is raised for, it is refused.
    const fxLost = await makeJob({ lines: [{ description: 'Legacy line', qty: 5, unitPrice: 60, pieces: 3 }], stage: 8 });
    await pool.query('UPDATE rel_job_line_items SET pieces = NULL WHERE job_id = $1', [fxLost.jobId]);
    let refusal = '';
    try { await services.createInvoiceForJob(fxLost.jobId); } catch (e: any) { refusal = String(e && e.message); }
    ok(/does not add up to its source is never issued/.test(refusal),
      'an invoice that would under-state its own job is REFUSED, not written — the SQ-00150 failure mode', refusal.slice(0, 140));
    ok(/R345\.00/.test(refusal) && /R1035\.00/.test(refusal),
      'and the refusal states both figures, so the person can see exactly what disagrees', refusal.slice(0, 220));
    const noInv = await pool.query('SELECT COUNT(*)::int AS n FROM rel_invoices WHERE job_id = $1', [fxLost.jobId]);
    ok(noInv.rows[0].n === 0, 'nothing was created', noInv.rows[0]);
    const jobAfter = await pool.query('SELECT invoice_num, invoice_created FROM rel_jobs WHERE id = $1', [fxLost.jobId]);
    ok(jobAfter.rows[0].invoice_num === null && jobAfter.rows[0].invoice_created === false,
      'and the job was left untouched — no number stamped on it, not marked invoiced', jobAfter.rows[0]);

    // pieces = 0 must behave the same as NULL (lineSubtotal's own rule).
    const fxZero = await makeJob({ lines: [{ description: 'Zero pieces', qty: 5, unitPrice: 60, pieces: null }], stage: 8 });
    await pool.query('UPDATE rel_job_line_items SET pieces = 0 WHERE job_id = $1', [fxZero.jobId]);
    const invZero = await services.createInvoiceForJob(fxZero.jobId);
    ok(eqMoney((await invoiceTotals(invZero.invoiceId)).subtotal, 300), 'pieces = 0 is read as 1 too', null);
  }

  // ══ D — setup fee ════════════════════════════════════════════════════════
  console.log('\n[D] setup fee > 0 → included exactly once');
  await reset();
  {
    const fx = await makeJob({ lines: [{ description: 'Sign', qty: 1, unitPrice: 1000, pieces: 1 }], setupFee: 250, stage: 8 });
    const inv = await services.createInvoiceForJob(fx.jobId);
    const lines = await invoiceLines(inv.invoiceId);
    const feeLines = lines.filter((l: any) => l.description === 'Design & Setup Fee');
    ok(feeLines.length === 1, 'exactly one setup-fee line', lines.map((l: any) => l.description));
    ok(eqMoney(feeLines[0].unit_amount, 250) && eqMoney(feeLines[0].qty, 1), 'it carries the fee at qty 1', feeLines[0]);
    ok(feeLines[0].tax_type === '15%', 'and is taxed, so VAT lands on the fee too', feeLines[0].tax_type);
    const t = await invoiceTotals(inv.invoiceId);
    ok(eqMoney(t.subtotal, 1250), 'subtotal = lines + fee', t.subtotal);
    ok(eqMoney(t.total, fx.jobValue), 'invoice total equals job value', { t: t.total, job: fx.jobValue });
  }

  // ══ E — discount ═════════════════════════════════════════════════════════
  console.log('\n[E] discount > 0 → represented exactly once, never applied twice');
  await reset();
  {
    const fx = await makeJob({ lines: [{ description: 'Sign', qty: 1, unitPrice: 1000, pieces: 2 }], discountPct: 10, stage: 8 });
    const inv = await services.createInvoiceForJob(fx.jobId);
    const lines = await invoiceLines(inv.invoiceId);
    const discLines = lines.filter((l: any) => /^Discount \(/.test(l.description));
    ok(discLines.length === 1, 'exactly one discount line', lines.map((l: any) => l.description));
    ok(discLines[0].description === 'Discount (10%)', 'described the way a person wrote it — not "10.000%"', discLines[0].description);
    ok(Number(discLines[0].unit_amount) < 0, 'it is a NEGATIVE line, so the item lines keep their true prices', discLines[0].unit_amount);
    ok(eqMoney(discLines[0].unit_amount, -200), '10% of the piece-aware line total (2 x 1 x 1000)', discLines[0].unit_amount);
    const t = await invoiceTotals(inv.invoiceId);
    ok(eqMoney(t.subtotal, 1800), 'subtotal = 2000 − 200, the discount applied once', t.subtotal);
    ok(eqMoney(t.total, fx.jobValue), 'invoice total equals job value', { t: t.total, job: fx.jobValue });
  }

  // ══ F / G — VAT and total ════════════════════════════════════════════════
  console.log('\n[F][G] VAT is correct and the invoice total matches the intended job value');
  await reset();
  {
    const fx = await makeJob({
      lines: [
        { description: 'A', qty: 1.5, unitPrice: 320, pieces: 3 },
        { description: 'B', qty: 2, unitPrice: 175.5, pieces: 1 },
      ],
      setupFee: 400, discountPct: 12.5, stage: 8,
    });
    const inv = await services.createInvoiceForJob(fx.jobId);
    const t = await invoiceTotals(inv.invoiceId);
    const linesSum = 3 * 1.5 * 320 + 1 * 2 * 175.5;         // 1440 + 351 = 1791
    const expectedSub = linesSum - linesSum * 0.125 + 400;   // 1791 − 223.875 + 400
    ok(eqMoney(t.subtotal, expectedSub), 'subtotal = lines − discount + setup fee', { got: t.subtotal, expectedSub });
    ok(eqMoney(t.vat, expectedSub * 0.15), 'VAT is 15% of THAT amount — the quote’s own flat VAT rule', { got: t.vat });
    ok(eqMoney(t.total, expectedSub * 1.15), 'total = subtotal + VAT', t.total);
    ok(eqMoney(t.total, fx.jobValue), 'and equals the job value', { t: t.total, job: fx.jobValue });
  }

  // ══ H — full chain, including Quote → Invoice ════════════════════════════
  console.log('\n[H] full Quote → Job → Invoice financial chain (and the proforma path)');
  await reset();
  {
    const fx = await makeJob({
      lines: [{ description: 'Chain line', qty: 2, unitPrice: 500, pieces: 2 }],
      setupFee: 150, discountPct: 5, stage: 8,
    });
    const q = await pool.query('SELECT total, subtotal, vat_amount FROM rel_quotes WHERE id = $1', [fx.quoteId]);
    const inv = await services.createInvoiceForJob(fx.jobId);
    const t = await invoiceTotals(inv.invoiceId);
    ok(eqMoney(q.rows[0].total, fx.jobValue), 'quote total == job value', { q: q.rows[0].total, job: fx.jobValue });
    ok(eqMoney(t.total, q.rows[0].total), 'invoice total == quote total — the chain agrees end to end', { inv: t.total, q: q.rows[0].total });
    // rel_quotes.subtotal is the RAW line sum, BEFORE discount and setup fee
    // (see createQuote); the invoice's derived subtotal is the post-adjustment
    // figure. The relationship between them is what must hold, not equality.
    const rawLineSum = Number(q.rows[0].subtotal);
    ok(eqMoney(t.subtotal, rawLineSum - rawLineSum * 0.05 + 150),
      'the invoice’s VAT-exclusive subtotal is the quote’s line sum less its discount plus its setup fee',
      { inv: t.subtotal, rawLineSum });
    ok(eqMoney(t.vat, q.rows[0].vat_amount), 'and the VAT amounts agree exactly', { inv: t.vat, q: q.rows[0].vat_amount });
  }
  {
    // finalizeProformaToInvoice carried the identical defect and is fixed with
    // the same shared writers.
    await reset();
    const cust = await services.createCustomer({ companyName: 'Proforma Co' });
    const quote = await services.createQuote({
      companyCode: '2', customerId: cust.id, customerNameRaw: 'Proforma Co',
      setupFee: 300, discountPct: 10,
      lines: [{ description: 'Proforma line', qty: 1.5, unitPrice: 400, pieces: 3 }],
    });
    await pool.query(`UPDATE rel_quotes SET proforma_num = 'PRO-90210' WHERE id = $1`, [quote.id]);
    const fin = await services.finalizeProformaToInvoice(quote.id);
    const t = await invoiceTotals(fin.invoiceId);
    const qRow = await pool.query('SELECT total FROM rel_quotes WHERE id = $1', [quote.id]);
    ok(eqMoney(t.total, qRow.rows[0].total), 'a finalised proforma invoice equals its own quote', { inv: t.total, q: qRow.rows[0].total });
    const descs = (await invoiceLines(fin.invoiceId)).map((l: any) => l.description);
    ok(descs.includes('Discount (10%)') && descs.includes('Design & Setup Fee'),
      'and carries the same adjustment lines a job invoice does', descs);
  }

  // ══ I — standalone manual invoice unaffected ═════════════════════════════
  console.log('\n[I] a generic standalone manual invoice is completely unaffected');
  await reset();
  {
    const created = await services.createManualInvoice({
      companyCode: '2', contactName: 'Walk-in Customer',
      lines: [{ description: 'Ad-hoc work', qty: 2, unitAmount: 125, taxType: '15%' }],
    });
    const lines = await invoiceLines(created.id);
    ok(lines.length === 1, 'exactly the lines the user typed — no adjustment lines invented', lines.map((l: any) => l.description));
    ok(eqMoney(lines[0].qty, 2) && eqMoney(lines[0].unit_amount, 125), 'stored verbatim', lines[0]);
    const t = await invoiceTotals(created.id);
    ok(eqMoney(t.total, 287.5), 'and totals exactly as before the repair', t.total);
  }

  // ══ J — Job-specific manual invoice path (current behaviour) ═════════════
  console.log('\n[J] Job-specific manual invoice path — current behaviour asserted against index.html');
  {
    const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
    // There is exactly ONE creation entry point for a manual invoice, and it is
    // the standalone Accounting action. Sales only ever EDITS an existing one.
    const createOpens = (src.match(/setEditInv\(null\);setShowInvModal\(true\)/g) || []).length;
    ok(createOpens >= 1, 'Accounting’s "+ New Invoice" is the standalone creation action (opens blank, by design)');
    const modalOpens = src.match(/setEditManualInv\(([^)]*)\)\s*;\s*setShowManualInvModal\(true\)/g) || [];
    const modalOpensTotal = (src.match(/setShowManualInvModal\(true\)/g) || []).length;
    ok(modalOpensTotal > 0 && modalOpens.length === modalOpensTotal &&
       modalOpens.every((o) => !/setEditManualInv\(\s*null\s*\)/.test(o)),
      'every Sales manual-invoice modal opening is an EDIT of an existing record — there is no Job-specific manual invoice CREATE action to prefill',
      { modalOpens, modalOpensTotal });
    ok(src.includes('create their invoice from the Jobs section when ready'),
      'the "ready to invoice but not yet invoiced" banner routes the user to the Job’s own Create Invoice action instead');
    // The optimistic Quote → Invoice stub must mirror the backend, or the user
    // sees a different number on screen from the one that was just written.
    ok(src.includes('.concat(stubAdjustmentLines(quote))'),
      'the optimistic proforma stub now carries the same discount/setup adjustment lines the backend writes');
    ok(/function stubAdjustmentLines\(doc\)\{/.test(src) && /function docLinesSubtotal\(lines\)\{/.test(src),
      'and both helpers are shared, so the stub and the JSON branch cannot drift apart');
    ok(/qty: \(\(\(parseFloat\(l\.pQty\)\|\|0\)>0\?parseFloat\(l\.pQty\):1\)\*\(parseFloat\(l\.qty\)\|\|0\)\)/.test(src),
      'the stub folds the piece count into the billed qty, exactly as writeInvoiceLinesFromSourceTx does');
  }

  // ══ K / L — reuse and no duplicates ══════════════════════════════════════
  console.log('\n[K][L] existing invoice reuse still works; no duplicate invoice is ever created');
  await reset();
  {
    const fx = await makeJob({ lines: [{ description: 'Reuse line', qty: 1, unitPrice: 900, pieces: 2 }], setupFee: 100, stage: 8 });
    const first = await services.createInvoiceForJob(fx.jobId);
    const linesBefore = await invoiceLines(first.invoiceId);
    let threw = false;
    try { await services.createInvoiceForJob(fx.jobId); } catch { threw = true; }
    ok(threw, 'a second Create Invoice on an already-invoiced job is refused');
    const count = await pool.query('SELECT COUNT(*)::int AS n FROM rel_invoices');
    ok(count.rows[0].n === 1, 'exactly one invoice exists', count.rows[0].n);
    const linesAfter = await invoiceLines(first.invoiceId);
    ok(JSON.stringify(linesBefore) === JSON.stringify(linesAfter), 'and its lines were not rewritten');
  }
  await reset();
  {
    // An invoice raised from the quote BEFORE the job existed is adopted, not
    // duplicated — and its own lines are left exactly as they were.
    const fx = await makeJob({ lines: [{ description: 'Adopt line', qty: 1, unitPrice: 500, pieces: 2 }], stage: 8 });
    const manual = await services.createManualInvoice({
      companyCode: '2', contactName: 'Audio Access',
      lines: [{ description: 'Agreed fixed price', qty: 1, unitAmount: 1000, taxType: '15%' }],
    });
    await pool.query('UPDATE rel_invoices SET quote_id = $1 WHERE id = $2', [fx.quoteId, manual.id]);
    const adopted = await services.createInvoiceForJob(fx.jobId);
    ok(adopted.invoiceId === manual.id, 'the existing invoice linked to the job’s source quote is adopted', adopted);
    const lines = await invoiceLines(manual.id);
    ok(lines.length === 1 && eqMoney(lines[0].unit_amount, 1000),
      'a valid existing invoice is NEVER re-priced by the repair — its lines are untouched', lines);
    const n = await pool.query('SELECT COUNT(*)::int AS n FROM rel_invoices');
    ok(n.rows[0].n === 1, 'and no second invoice was created', n.rows[0].n);
  }

  // ══ M — canonicalisation / delete cleanup ════════════════════════════════
  console.log('\n[M] invoice delete still reverses the job linkage and takes its lines with it');
  await reset();
  {
    const fx = await makeJob({ lines: [{ description: 'Delete me', qty: 1, unitPrice: 700, pieces: 2 }], setupFee: 50, stage: 8 });
    const inv = await services.createInvoiceForJob(fx.jobId);
    const v = await pool.query('SELECT row_version FROM rel_invoices WHERE id = $1', [inv.invoiceId]);
    const del = await services.deleteInvoice(inv.invoiceId, v.rows[0].row_version);
    ok(del.deleted === true, 'the invoice deletes');
    ok(del.clearedJobs.length === 1 && del.clearedJobs[0].jobNumber === fx.jobNumber, 'the job’s invoice linkage is reversed', del.clearedJobs);
    const left = await pool.query('SELECT COUNT(*)::int AS n FROM rel_invoice_line_items WHERE invoice_id = $1', [inv.invoiceId]);
    ok(left.rows[0].n === 0, 'and every line — item and adjustment alike — cascades with it', left.rows[0].n);
    const j = await pool.query('SELECT invoice_num, invoice_created FROM rel_jobs WHERE id = $1', [fx.jobId]);
    ok(j.rows[0].invoice_num === null && j.rows[0].invoice_created === false, 'the job is invoiceable again', j.rows[0]);
  }

  // ══ N — payments against the corrected total ═════════════════════════════
  console.log('\n[N] payments reconcile against the CORRECTED invoice total');
  await reset();
  {
    const fx = await makeJob({ lines: [{ description: 'Paid line', qty: 1, unitPrice: 1000, pieces: 2 }], stage: 8 });
    const inv = await services.createInvoiceForJob(fx.jobId);
    const t = await invoiceTotals(inv.invoiceId);
    ok(eqMoney(t.total, 2300), 'invoice is worth 2 x 1000 plus VAT', t.total);
    await services.recordPayment({ type: 'invoice', id: inv.invoiceId }, 1000);
    let st = await pool.query('SELECT status FROM rel_invoices WHERE id = $1', [inv.invoiceId]);
    ok(st.rows[0].status === 'partial', 'a part payment reads as partial against the true total — not "paid"', st.rows[0].status);
    await services.recordPayment({ type: 'invoice', id: inv.invoiceId }, 1300);
    st = await pool.query('SELECT status FROM rel_invoices WHERE id = $1', [inv.invoiceId]);
    ok(st.rows[0].status === 'paid', 'and settles only once the full corrected amount is received', st.rows[0].status);
  }

  // ══ O — company isolation ════════════════════════════════════════════════
  console.log('\n[O] co=2 and Holdings co=1 stay isolated');
  await reset();
  {
    const a = await makeJob({ companyCode: '2', customerName: 'Original Co Client', lines: [{ description: 'Co2 line', qty: 1, unitPrice: 100, pieces: 2 }], setupFee: 10, stage: 8 });
    const b = await makeJob({ companyCode: '1', customerName: 'Holdings Client', lines: [{ description: 'Co1 line', qty: 1, unitPrice: 200, pieces: 3 }], setupFee: 20, stage: 8 });
    const ia = await services.createInvoiceForJob(a.jobId);
    const ib = await services.createInvoiceForJob(b.jobId);
    const rows = await pool.query('SELECT id, company_code, invoice_number FROM rel_invoices ORDER BY id');
    ok(rows.rows.length === 2, 'one invoice per company');
    const rowFor = (id: unknown) => rows.rows.find((r: any) => String(r.id) === String(id));
    ok(rowFor(ia.invoiceId)?.company_code === '2', 'the co=2 invoice is tagged co=2', rowFor(ia.invoiceId));
    ok(rowFor(ib.invoiceId)?.company_code === '1', 'the Holdings invoice is tagged co=1', rowFor(ib.invoiceId));
    const ta = await invoiceTotals(ia.invoiceId);
    const tb = await invoiceTotals(ib.invoiceId);
    ok(eqMoney(ta.total, a.jobValue) && eqMoney(tb.total, b.jobValue), 'each is correct against its OWN job', { ta: ta.total, tb: tb.total });
    const crossA = await pool.query('SELECT COUNT(*)::int AS n FROM rel_invoice_line_items WHERE invoice_id = $1 AND description = $2', [ia.invoiceId, 'Co1 line']);
    ok(crossA.rows[0].n === 0, 'and neither borrowed a line from the other', crossA.rows[0].n);
  }

  // ══ P — migration-013 recovery classification ════════════════════════════
  console.log('\n[P] migration-013 recovery classifies every outcome deterministically');
  {
    const base: RelationalLineSnapshot = {
      lineId: 1, lineIndex: 0, description: 'Illuminated sign', qty: 1.2, unitPrice: 450,
      inventorySourceId: null, pieces: null, sqmL: null, sqmW: null, cpId: null, cpLinked: null,
    };
    const goodSource = { desc: 'Illuminated sign', qty: 1.2, unitPrice: 450, pQty: 2, sqmL: 1200, sqmW: 1000, cpLinked: true };

    const safe = classifyLineRecovery(base, [
      { origin: 'legacy_data', identity: 'rel_job_line_items.legacy_data (line id 1)', line: goodSource },
    ]);
    ok(safe.classification === 'SAFE_TO_RECOVER', 'SAFE_TO_RECOVER when a verified source carries the values', safe.classification);
    ok(safe.proposed.pieces === 2 && safe.proposed.sqmL === 1200 && safe.proposed.cpLinked === true, 'the exact values it would fill', safe.proposed);
    ok(safe.changesValue === true, 'and it is flagged as changing money, because `pieces` is financial');

    const noSource = classifyLineRecovery(base, []);
    ok(noSource.classification === 'NO_SOURCE_VALUE', 'NO_SOURCE_VALUE when nothing preserved exists', noSource.classification);

    const emptySource = classifyLineRecovery(base, [
      { origin: 'legacy_data', identity: 'legacy_data', line: { desc: 'Illuminated sign', qty: 1.2, unitPrice: 450 } },
    ]);
    ok(emptySource.classification === 'NO_SOURCE_VALUE',
      'NO_SOURCE_VALUE when the source verifies but genuinely recorded none of these fields', emptySource.classification);

    const mismatch = classifyLineRecovery(base, [
      { origin: 'platform_state_json', identity: 'source_id=99 / line_index=0', line: { desc: 'Illuminated sign', qty: 9.9, unitPrice: 450, pQty: 2 } },
    ]);
    ok(mismatch.classification === 'MISMATCH', 'MISMATCH when the located source does not verify', mismatch.classification);
    ok(Object.keys(mismatch.proposed).length === 0, 'and it proposes nothing at all', mismatch.proposed);

    const ambiguousIdentity = classifyLineRecovery(base, [
      { origin: 'platform_state_json', identity: 'num=SQ-00108', line: null, ambiguous: true, ambiguityReason: 'two JSON quotes numbered SQ-00108' },
    ]);
    ok(ambiguousIdentity.classification === 'AMBIGUOUS', 'AMBIGUOUS when identity cannot be resolved to one record', ambiguousIdentity.classification);

    const disagreeing = classifyLineRecovery(base, [
      { origin: 'legacy_data', identity: 'legacy_data', line: { ...goodSource, pQty: 2 } },
      { origin: 'platform_state_json', identity: 'json', line: { ...goodSource, pQty: 5 } },
    ]);
    ok(disagreeing.classification === 'AMBIGUOUS', 'AMBIGUOUS when two verified sources disagree about a value', disagreeing.reason);

    const corroborating = classifyLineRecovery(base, [
      { origin: 'legacy_data', identity: 'legacy_data', line: { ...goodSource } },
      { origin: 'platform_state_json', identity: 'json', line: { ...goodSource } },
    ]);
    ok(corroborating.classification === 'SAFE_TO_RECOVER', 'but two sources that AGREE are corroboration, not ambiguity', corroborating.classification);

    // Identity helpers refuse to guess.
    const dupDocs = findJsonDocument([{ id: 5, num: 'SQ-1', co: 2 }, { id: 9, num: 'SQ-1', co: 2 }], null, 'SQ-1', '2', 'num');
    ok(dupDocs.ambiguous === true, 'two JSON records with the same number are ambiguous, never "the first one"', dupDocs.reason);
    const wrongCo = findJsonDocument([{ id: 5, num: 'SQ-1', co: 1 }], null, 'SQ-1', '2', 'num');
    ok(wrongCo.ambiguous === true, 'a number match in the WRONG company is ambiguous, never accepted', wrongCo.reason);
    const dupLines = findJsonLine(
      [{ desc: 'X', qty: 1, unitPrice: 10 }, { desc: 'X', qty: 1, unitPrice: 10 }],
      { ...base, lineIndex: 7, description: 'X', qty: 1, unitPrice: 10 }
    );
    ok(dupLines.ambiguous === true, 'two identical JSON lines with no positional identity are ambiguous', dupLines.reason);
    const positional = findJsonLine([{ desc: 'X', qty: 1, unitPrice: 10 }], { ...base, lineIndex: 0 });
    ok(positional.identity === 'line_index=0' && positional.ambiguous === false, 'position is a real identity, because backfill wrote it');
  }

  // ══ Q — recovery never overwrites a non-NULL value ═══════════════════════
  console.log('\n[Q] recovery never overwrites a value that is already there');
  {
    const partlySet: RelationalLineSnapshot = {
      lineId: 2, lineIndex: 0, description: 'Sign', qty: 1, unitPrice: 100,
      inventorySourceId: null, pieces: 4, sqmL: null, sqmW: null, cpId: null, cpLinked: null,
    };
    const v = classifyLineRecovery(partlySet, [
      { origin: 'legacy_data', identity: 'legacy_data', line: { desc: 'Sign', qty: 1, unitPrice: 100, pQty: 2, sqmL: 500 } },
    ]);
    ok(v.proposed.pieces === undefined, 'an existing pieces = 4 is NOT replaced by the source’s 2', v.proposed);
    ok(v.preservedFields.includes('pieces'), 'it is reported as preserved', v.preservedFields);
    ok(v.proposed.sqmL === 500, 'while a genuinely NULL field beside it is still recovered', v.proposed);
    ok(v.changesValue === false, 'and because pieces was untouched, no money changes', v.changesValue);

    const allSet: RelationalLineSnapshot = {
      lineId: 3, lineIndex: 0, description: 'Sign', qty: 1, unitPrice: 100,
      inventorySourceId: null, pieces: 4, sqmL: 1, sqmW: 1, cpId: 'cp1', cpLinked: false,
    };
    const v2 = classifyLineRecovery(allSet, [
      { origin: 'legacy_data', identity: 'legacy_data', line: { desc: 'Sign', qty: 1, unitPrice: 100, pQty: 2 } },
    ]);
    ok(v2.classification === 'ALREADY_SET' && Object.keys(v2.proposed).length === 0,
      'a fully-populated line is ALREADY_SET and proposes nothing', v2.classification);
  }

  // ══ P/Q end-to-end against a real database ═══════════════════════════════
  console.log('\n[P][Q] the analyser, end to end, against a real historical shape');
  await reset();
  {
    const fx = await makeJob({ lines: AUDIO_ACCESS_LINES, setupFee: AUDIO_ACCESS_SETUP_FEE, stage: 8 });
    const jobNumRes = await pool.query('SELECT job_number, source_id FROM rel_jobs WHERE id = $1', [fx.jobId]);
    const quoteNumRes = await pool.query('SELECT quote_number, source_id FROM rel_quotes WHERE id = $1', [fx.quoteId]);

    // Make it look BACKFILLED-BEFORE-013: the columns are NULL, but the
    // original line still sits in legacy_data, and platform_state still holds
    // the pre-cutover JSON document.
    const jl = await pool.query('SELECT id, line_index, description, qty, unit_price FROM rel_job_line_items WHERE job_id = $1 ORDER BY line_index', [fx.jobId]);
    for (const row of jl.rows) {
      await pool.query(
        `UPDATE rel_job_line_items
            SET pieces = NULL, sqm_l = NULL, sqm_w = NULL,
                legacy_data = $2::jsonb
          WHERE id = $1`,
        [row.id, JSON.stringify({ desc: row.description, qty: Number(row.qty), unitPrice: Number(row.unit_price), pQty: 2 })]
      );
    }
    await pool.query('UPDATE rel_quote_line_items SET pieces = NULL WHERE quote_id = $1', [fx.quoteId]);
    await pool.query(
      `UPDATE platform_state SET data = $1::jsonb WHERE id = 1`,
      [JSON.stringify({
        quotes: [{
          id: Number(quoteNumRes.rows[0].source_id), num: quoteNumRes.rows[0].quote_number, co: 2,
          lines: AUDIO_ACCESS_LINES.map((l) => ({ desc: l.description, qty: l.qty, unitPrice: l.unitPrice, pQty: l.pieces })),
        }],
        jobs: [{
          id: Number(jobNumRes.rows[0].source_id), num: jobNumRes.rows[0].job_number, co: 2,
          lines: AUDIO_ACCESS_LINES.map((l) => ({ desc: l.description, qty: l.qty, unitPrice: l.unitPrice, pQty: l.pieces })),
        }],
      })]
    );

    const report = await analyzeMigration013Recovery();
    ok(report.summary.SAFE_TO_RECOVER === 10,
      'all 10 lines (5 quote + 5 job) are SAFE_TO_RECOVER from their preserved sources', report.summary);
    ok(report.summary.MISMATCH === 0 && report.summary.AMBIGUOUS === 0, 'with nothing ambiguous or mismatched', report.summary);
    ok(report.valueChangingLines.length === 10, 'and every one is flagged as changing value, because pieces is financial', report.valueChangingLines.length);
    ok(report.lines.every((l) => l.proposed.pieces === 2), 'each proposes exactly pieces = 2', report.lines.map((l) => l.proposed.pieces));

    // What the recovery would be WORTH — the analyser reports it, it does not apply it.
    const jobLinesRecovered = report.lines.filter((l) => l.collection === 'job')
      .reduce((s, l) => s + l.recoveredLineValue, 0);
    ok(eqMoney((jobLinesRecovered + AUDIO_ACCESS_SETUP_FEE) * 1.15, AUDIO_ACCESS_EXPECTED_TOTAL),
      'recovering pieces restores SNS-00110-shaped lines to the full R7,300.27', money((jobLinesRecovered + AUDIO_ACCESS_SETUP_FEE) * 1.15));

    // …and it really did not apply it.
    const stillNull = await pool.query('SELECT COUNT(*)::int AS n FROM rel_job_line_items WHERE job_id = $1 AND pieces IS NULL', [fx.jobId]);
    ok(stillNull.rows[0].n === 5, 'the analyser wrote NOTHING — every pieces column is still NULL', stillNull.rows[0].n);

    // An EDITED line (its legacy_data wiped, its price changed) must not be recovered.
    await pool.query(
      `UPDATE rel_job_line_items SET unit_price = unit_price + 111, legacy_data = '{}'::jsonb
        WHERE job_id = $1 AND line_index = 0`, [fx.jobId]
    );
    const report2 = await analyzeMigration013Recovery();
    const editedLine = report2.lines.find((l) => l.collection === 'job' && l.lineIndex === 0)!;
    ok(editedLine.classification === 'MISMATCH',
      'a line edited since backfill is MISMATCH — its historical dimensions may no longer describe it', editedLine.reason);
    ok(Object.keys(editedLine.proposed).length === 0, 'and nothing is proposed for it', editedLine.proposed);
  }

  console.log('\n============================================================');
  console.log(`${passed} passed, ${failures} failed`);
  console.log('============================================================');
  await pool.end();
  if (failures > 0) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error('\n[job-invoice-financial-consistency] Fatal error:', err);
  process.exitCode = 1;
  await pool.end().catch(() => undefined);
});
