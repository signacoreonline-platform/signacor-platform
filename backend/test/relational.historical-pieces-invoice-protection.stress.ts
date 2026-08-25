/**
 * relational.historical-pieces-invoice-protection.stress.ts
 * ─────────────────────────────────────────────────────────
 * HISTORICAL PIECES PROTECTION + FINANCIAL CONSISTENCY GUARD (2026-08-25)
 *
 * Driven by the confirmed production case SQ-00150 -> INV-00111.
 *
 * THE DEFECT
 *   The invoice writers priced a source line as pieces x qty x unitPrice and
 *   read a NULL `pieces` as 1. That is correct for a line that never had a
 *   piece count, and a factor-of-N under-charge for a line whose piece count
 *   predates migration 013's column. SQ-00150's R1,600 line is really
 *   4 x 2 x R1,600 = R12,800; its `pieces` column is NULL; the invoice was
 *   written as 1 x 2 x R1,600 = R3,200, and INV-00111 came out at R4,542.50
 *   against a R15,582.50 quote.
 *
 * THE TWO PROTECTIONS THIS SUITE PROVES
 *   1. RESOLVED PIECES. Invoice creation now asks migration013Recovery what a
 *      NULL piece count really means for each line — the SAME deterministic
 *      matcher the analysis report and the repair scripts use. ALREADY_SET uses
 *      the column; SAFE_TO_RECOVER uses the recovered historical value;
 *      NO_SOURCE_VALUE keeps the documented NULL -> 1 default; MISMATCH and
 *      AMBIGUOUS refuse rather than guess. The source document is never
 *      modified (approach B) — see resolveDocument013ForInvoicing's own note.
 *   2. FINANCIAL CONSISTENCY GUARD. A source-derived invoice that does not add
 *      up to its own quote total / job value is rolled back and refused, so a
 *      document that disagrees with the record it was raised for cannot be
 *      issued at all. A refusal consumes no invoice number and leaves any PRO
 *      reservation untouched.
 *
 * COVERAGE
 *   A  modern quote, pieces populated                  -> invoices correctly
 *   B  historical quote, pieces recoverable            -> invoices correctly
 *   C  historical job, pieces recoverable              -> invoices correctly
 *   D  genuine NO_SOURCE_VALUE NULL                    -> stays compatible
 *   E  MISMATCH                                        -> refuses
 *   F  AMBIGUOUS                                       -> refuses
 *   G  quote total vs invoice total mismatch           -> rolls back
 *   H  job value vs invoice total mismatch             -> rolls back
 *   I  numbering: a refusal burns no number, and a PRO reservation survives
 *   J  pieces > 1, setup fee once, discount once, VAT correct
 *   K  retry after a refusal / after success creates no duplicate
 *   L  proforma finalisation still works
 *   M  Original (2) / Holdings (1) isolation
 *   N  ONE matching algorithm — the analysis, the resolver and the repair agree
 *   O  the SQ-00150 fixture produces exactly R15,582.50
 *   P  manual-invoice companyCode type fix (frontend + endpoint)
 *
 * SAFETY: refuses to run unless DATABASE_URL is local (or ALLOW_UNSAFE_TEST_DB=1).
 * It owns the rel_* tables and platform_state row 1 in the TEST database only.
 *
 * Usage (from backend/):
 *   DATABASE_URL=postgresql://user:pass@localhost:5432/signacore_test \
 *   TEST_SERVER_URL_WITH_AUTHORITY=http://127.0.0.1:3002 \
 *   npx ts-node --transpile-only test/relational.historical-pieces-invoice-protection.stress.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import pool from '../src/db/pool';
import * as services from '../src/relational/services';
import {
  analyzeMigration013Recovery, resolveDocument013ForInvoicing,
} from '../src/relational/migration013Recovery';

const DB_URL = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(DB_URL) && process.env.ALLOW_UNSAFE_TEST_DB !== '1') {
  console.error('[historical-pieces] Refusing to run: DATABASE_URL does not look like a local test database.');
  process.exit(1);
}
const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH || path.resolve(__dirname, '..', '..', 'index.html');
const BASE = process.env.TEST_SERVER_URL_WITH_AUTHORITY || '';

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}
function money(n: unknown): number { return Math.round((Number(n) || 0) * 100) / 100; }
function eqMoney(a: unknown, b: unknown): boolean { return Math.abs(money(a) - money(b)) < 0.005; }

const CO = '2';
const CO_HOLDINGS = '1';

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
  const r = (await pool.query(
    `SELECT COALESCE(SUM(qty * unit_amount), 0) AS subtotal,
            COALESCE(SUM(CASE WHEN tax_type = '15%' THEN qty * unit_amount * 0.15 ELSE 0 END), 0) AS vat,
            COUNT(*)::int AS line_count
       FROM rel_invoice_line_items WHERE invoice_id = $1`, [invoiceId])).rows[0];
  return { subtotal: Number(r.subtotal), vat: Number(r.vat), total: Number(r.subtotal) + Number(r.vat), lineCount: r.line_count };
}
async function invoiceLines(invoiceId: number) {
  return (await pool.query(
    `SELECT line_index, description, qty, unit_amount, tax_type
       FROM rel_invoice_line_items WHERE invoice_id = $1 ORDER BY line_index`, [invoiceId])).rows;
}
async function counterFor(company: string): Promise<number> {
  const r = await pool.query(
    `SELECT last_number FROM document_number_counters WHERE company = $1 AND doc_type = 'invoice'`, [company]);
  return r.rowCount ? Number(r.rows[0].last_number) : 0;
}

interface QuoteFx { quoteId: number; quoteNumber: string; quoteTotal: number; lineIds: number[] }
async function makeQuote(opts: {
  companyCode?: string; client?: string; setupFee?: number; discountPct?: number;
  lines: Array<{ description: string; qty: number; unitPrice: number; pieces?: number | null; sqmL?: number | null; sqmW?: number | null }>;
}): Promise<QuoteFx> {
  const companyCode = opts.companyCode ?? CO;
  const name = opts.client ?? 'Historical Client';
  const q = await services.createQuote({
    companyCode, customerNameRaw: name, status: 'approved',
    setupFee: opts.setupFee ?? 0, discountPct: opts.discountPct ?? 0,
    lines: opts.lines.map((l) => ({
      description: l.description, qty: l.qty, unitPrice: l.unitPrice, unit: 'ea',
      pieces: l.pieces === undefined ? null : l.pieces,
      sqmL: l.sqmL ?? null, sqmW: l.sqmW ?? null,
    })),
  } as any);
  await pool.query(`UPDATE rel_quotes SET status = 'approved' WHERE id = $1`, [q.id]);
  const row = (await pool.query('SELECT total FROM rel_quotes WHERE id = $1', [q.id])).rows[0];
  const ids = (await pool.query('SELECT id FROM rel_quote_line_items WHERE quote_id = $1 ORDER BY line_index', [q.id])).rows.map((r: any) => Number(r.id));
  return { quoteId: q.id, quoteNumber: q.quoteNumber, quoteTotal: Number(row.total), lineIds: ids };
}

/**
 * Turn a quote (or job) that was created WITH piece counts into the shape a
 * pre-migration-013 backfilled record has: the columns are NULL, but the
 * original line still sits in legacy_data — exactly SQ-00150's condition. The
 * document's own stored total is deliberately left alone, because that is what
 * makes the under-charge detectable.
 */
async function makeHistorical(table: 'rel_quote_line_items' | 'rel_job_line_items', fk: string, docId: number) {
  const rows = (await pool.query(
    `SELECT id, description, qty, unit_price, pieces, sqm_l, sqm_w FROM ${table} WHERE ${fk} = $1 ORDER BY line_index`, [docId])).rows;
  for (const r of rows) {
    await pool.query(
      `UPDATE ${table}
          SET legacy_data = $2::jsonb, pieces = NULL, sqm_l = NULL, sqm_w = NULL
        WHERE id = $1`,
      [r.id, JSON.stringify({
        desc: r.description, qty: Number(r.qty), unitPrice: Number(r.unit_price),
        pQty: r.pieces === null ? undefined : Number(r.pieces),
        sqmL: r.sqm_l === null ? undefined : Number(r.sqm_l),
        sqmW: r.sqm_w === null ? undefined : Number(r.sqm_w),
      })]
    );
  }
}

async function main() {
  const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

  // ══ A — modern quote, pieces populated ═══════════════════════════════════
  console.log('\n[A] modern quote with populated pieces → still invoices correctly');
  await reset();
  {
    const fx = await makeQuote({ lines: [{ description: 'Panel', qty: 2, unitPrice: 250, pieces: 4 }], setupFee: 100, discountPct: 5 });
    const inv = await services.createInvoiceFromQuote(fx.quoteId);
    const t = await invoiceTotals(inv.invoiceId);
    ok(eqMoney(t.total, fx.quoteTotal), 'invoice total equals the quote total', { inv: money(t.total), quote: money(fx.quoteTotal) });
    const l = await invoiceLines(inv.invoiceId);
    ok(eqMoney(l[0].qty, 8) && eqMoney(l[0].unit_amount, 250),
      'pieces are folded into the billed qty (4 x 2 = 8) at the true unit price', { qty: Number(l[0].qty), unit: Number(l[0].unit_amount) });
    const res = await resolveDocument013ForInvoicing(pool as any, 'quote', fx.quoteId);
    ok(res.lines.every((x) => x.piecesSource === 'column'),
      'and the piece count came straight off the column — no historical lookup was needed', res.lines.map((x) => x.piecesSource));
  }

  // ══ B — historical quote, pieces recoverable ═════════════════════════════
  console.log('\n[B] historical quote with deterministic legacy pieces → invoices correctly');
  await reset();
  {
    const fx = await makeQuote({ lines: [{ description: 'ACP', qty: 2, unitPrice: 1600, pieces: 4, sqmL: 2000, sqmW: 1000 }], setupFee: 250 });
    const quoteTotalBefore = fx.quoteTotal;
    await makeHistorical('rel_quote_line_items', 'quote_id', fx.quoteId);

    const res = await resolveDocument013ForInvoicing(pool as any, 'quote', fx.quoteId);
    ok(res.lines[0].verdict.classification === 'SAFE_TO_RECOVER' && res.lines[0].effectivePieces === 4
       && res.lines[0].piecesSource === 'recovered',
      'the NULL piece count resolves deterministically to the preserved value of 4',
      { classification: res.lines[0].verdict.classification, pieces: res.lines[0].effectivePieces });

    const inv = await services.createInvoiceFromQuote(fx.quoteId);
    const t = await invoiceTotals(inv.invoiceId);
    ok(eqMoney(t.total, quoteTotalBefore),
      'and the invoice is written at the quote\'s real total, not 1/4 of it', { inv: money(t.total), quote: money(quoteTotalBefore) });

    const qLine = (await pool.query('SELECT pieces, sqm_l, sqm_w, legacy_data FROM rel_quote_line_items WHERE quote_id = $1', [fx.quoteId])).rows[0];
    ok(qLine.pieces === null && qLine.sqm_l === null,
      'APPROACH B: the SOURCE quote line is left exactly as it was — invoicing never backfills historical data', qLine.pieces);
    const qHead = (await pool.query('SELECT total, row_version FROM rel_quotes WHERE id = $1', [fx.quoteId])).rows[0];
    ok(eqMoney(qHead.total, quoteTotalBefore) && Number(qHead.row_version) === 1,
      'and the quote header is untouched — no row_version bump, so no open editor is disturbed', qHead);
  }

  // ══ C — historical job, pieces recoverable ═══════════════════════════════
  console.log('\n[C] historical job with deterministic pieces → invoices correctly');
  await reset();
  {
    const fx = await makeQuote({ lines: [{ description: 'Fascia', qty: 3, unitPrice: 400, pieces: 2 }], setupFee: 150 });
    const conv = await services.convertQuoteToJob(fx.quoteId);
    await pool.query('UPDATE rel_jobs SET stage = 8 WHERE id = $1', [conv.jobId]);
    const jobValue = Number((await pool.query('SELECT value FROM rel_jobs WHERE id = $1', [conv.jobId])).rows[0].value);
    await makeHistorical('rel_job_line_items', 'job_id', conv.jobId);

    const res = await resolveDocument013ForInvoicing(pool as any, 'job', conv.jobId);
    ok(res.lines[0].effectivePieces === 2 && res.lines[0].piecesSource === 'recovered',
      'the job line\'s NULL piece count resolves to the preserved value of 2', res.lines[0].effectivePieces);

    const inv = await services.createInvoiceForJob(conv.jobId);
    const t = await invoiceTotals(inv.invoiceId);
    ok(eqMoney(t.total, jobValue), 'and the invoice equals the job value', { inv: money(t.total), job: money(jobValue) });
    const jLine = (await pool.query('SELECT pieces FROM rel_job_line_items WHERE job_id = $1', [conv.jobId])).rows[0];
    ok(jLine.pieces === null, 'the SOURCE job line is left exactly as it was', jLine.pieces);
  }

  // ══ D — genuine NO_SOURCE_VALUE ══════════════════════════════════════════
  console.log('\n[D] genuinely absent pieces (no source at all) → NULL still reads as 1');
  await reset();
  {
    const fx = await makeQuote({ lines: [{ description: 'Plain line', qty: 5, unitPrice: 60, pieces: null }] });
    const res = await resolveDocument013ForInvoicing(pool as any, 'quote', fx.quoteId);
    ok(res.lines[0].verdict.classification === 'NO_SOURCE_VALUE' && res.lines[0].effectivePieces === 1
       && res.lines[0].piecesSource === 'default-1',
      'classified NO_SOURCE_VALUE and priced with the documented default of 1',
      { classification: res.lines[0].verdict.classification, pieces: res.lines[0].effectivePieces });
    const inv = await services.createInvoiceFromQuote(fx.quoteId);
    const t = await invoiceTotals(inv.invoiceId);
    ok(eqMoney(t.total, fx.quoteTotal), 'and the invoice is issued normally, matching the quote', { inv: money(t.total), quote: money(fx.quoteTotal) });
    ok(res.blocked.length === 0, 'nothing is blocked — an absent piece count is not an unresolved one');
  }

  // ══ E — MISMATCH refuses ═════════════════════════════════════════════════
  console.log('\n[E] MISMATCH → invoice creation refused, never guessed');
  await reset();
  {
    const fx = await makeQuote({ lines: [{ description: 'Edited line', qty: 2, unitPrice: 1600, pieces: 4 }], setupFee: 250 });
    // A preserved source that claims a DIFFERENT qty: the line has been edited
    // since backfill, so its historical dimensions may no longer describe it.
    await pool.query(
      `UPDATE rel_quote_line_items SET pieces = NULL, legacy_data = $2::jsonb WHERE quote_id = $1`,
      [fx.quoteId, JSON.stringify({ desc: 'Edited line', qty: 99, unitPrice: 1600, pQty: 4 })]);

    const res = await resolveDocument013ForInvoicing(pool as any, 'quote', fx.quoteId);
    ok(res.lines[0].verdict.classification === 'MISMATCH', 'classified MISMATCH', res.lines[0].verdict.classification);
    ok(res.blocked.length === 1, 'and flagged as blocking, because the line has no piece count of its own', res.blocked.length);

    const counterBefore = await counterFor(CO);
    let msg = '';
    try { await services.createInvoiceFromQuote(fx.quoteId); } catch (e: any) { msg = String(e && e.message); }
    ok(/cannot be invoiced yet/.test(msg) && /MISMATCH/.test(msg),
      'invoice creation is REFUSED with an actionable message naming the verdict', msg.slice(0, 160));
    ok((await pool.query('SELECT COUNT(*)::int AS n FROM rel_invoices')).rows[0].n === 0, 'nothing was created');
    ok((await counterFor(CO)) === counterBefore, 'and no invoice number was consumed', { before: counterBefore, after: await counterFor(CO) });
  }

  // ══ F — AMBIGUOUS refuses ════════════════════════════════════════════════
  console.log('\n[F] AMBIGUOUS → invoice creation refused, never guessed');
  await reset();
  {
    const fx = await makeQuote({ lines: [{ description: 'Two sources', qty: 2, unitPrice: 1600, pieces: 4 }], setupFee: 250 });
    // legacy_data says 4 pieces; the platform_state JSON for the same document
    // says 6. Both verify against the line, so neither can be preferred.
    await pool.query(
      `UPDATE rel_quote_line_items SET pieces = NULL, legacy_data = $2::jsonb WHERE quote_id = $1`,
      [fx.quoteId, JSON.stringify({ desc: 'Two sources', qty: 2, unitPrice: 1600, pQty: 4 })]);
    const srcId = (await pool.query('SELECT source_id FROM rel_quotes WHERE id = $1', [fx.quoteId])).rows[0].source_id;
    await pool.query(`UPDATE platform_state SET data = $1::jsonb WHERE id = 1`, [JSON.stringify({
      quotes: [{ id: Number(srcId), num: fx.quoteNumber, co: Number(CO), lines: [{ desc: 'Two sources', qty: 2, unitPrice: 1600, pQty: 6 }] }],
    })]);

    const res = await resolveDocument013ForInvoicing(pool as any, 'quote', fx.quoteId);
    ok(res.lines[0].verdict.classification === 'AMBIGUOUS', 'classified AMBIGUOUS', res.lines[0].verdict.classification);
    let msg = '';
    try { await services.createInvoiceFromQuote(fx.quoteId); } catch (e: any) { msg = String(e && e.message); }
    ok(/cannot be invoiced yet/.test(msg) && /AMBIGUOUS/.test(msg),
      'invoice creation is REFUSED — two sources that disagree are never averaged or preferred', msg.slice(0, 160));
    ok((await pool.query('SELECT COUNT(*)::int AS n FROM rel_invoices')).rows[0].n === 0, 'nothing was created');
    ok(/confirm the piece count on each line and save it/.test(msg),
      'and the message tells the person exactly how to unblock it', msg.slice(-120));
  }

  // ══ G — quote total vs invoice total mismatch rolls back ═════════════════
  console.log('\n[G] quote total vs derived invoice total mismatch → ROLLBACK');
  await reset();
  {
    // The SQ-00150 shape with NOTHING preserved: pieces NULL, legacy_data empty,
    // platform_state empty. The quote's own total still says 4 pieces' worth, so
    // the derived invoice would be a quarter of it.
    const fx = await makeQuote({
      lines: [
        { description: 'ACP', qty: 2, unitPrice: 1600, pieces: 4 },
        { description: 'Delivery', qty: 1, unitPrice: 500, pieces: null },
      ],
      setupFee: 250,
    });
    ok(eqMoney(fx.quoteTotal, 15582.50), 'the fixture is the SQ-00150 shape, totalling R15,582.50', money(fx.quoteTotal));
    await pool.query(`UPDATE rel_quote_line_items SET pieces = NULL WHERE quote_id = $1`, [fx.quoteId]);
    const counterBefore = await counterFor(CO);
    let msg = '';
    try { await services.createInvoiceFromQuote(fx.quoteId); } catch (e: any) { msg = String(e && e.message); }
    ok(/does not add up to its source is never issued/.test(msg),
      'the guard refuses an invoice that does not add up to its quote', msg.slice(0, 140));
    ok(/R4542\.50/.test(msg.replace(/,/g, '')) && /R15582\.50/.test(msg.replace(/,/g, '')),
      'and states BOTH figures — the exact SQ-00150 / INV-00111 pair', msg.slice(0, 200));
    ok((await pool.query('SELECT COUNT(*)::int AS n FROM rel_invoices')).rows[0].n === 0,
      'the whole transaction rolled back — no invoice row survives');
    ok((await pool.query('SELECT COUNT(*)::int AS n FROM rel_invoice_line_items')).rows[0].n === 0,
      'and no orphan invoice lines survive either');
    ok((await counterFor(CO)) === counterBefore,
      'and the reserved invoice number was released by the rollback — none was consumed',
      { before: counterBefore, after: await counterFor(CO) });
  }

  // ══ H — job value vs invoice total mismatch rolls back ═══════════════════
  console.log('\n[H] job value vs derived invoice total mismatch → ROLLBACK');
  await reset();
  {
    const fx = await makeQuote({ lines: [{ description: 'Fascia', qty: 3, unitPrice: 400, pieces: 2 }] });
    const conv = await services.convertQuoteToJob(fx.quoteId);
    await pool.query('UPDATE rel_jobs SET stage = 8 WHERE id = $1', [conv.jobId]);
    await pool.query(`UPDATE rel_job_line_items SET pieces = NULL WHERE job_id = $1`, [conv.jobId]);
    const counterBefore = await counterFor(CO);
    let msg = '';
    try { await services.createInvoiceForJob(conv.jobId); } catch (e: any) { msg = String(e && e.message); }
    ok(/does not add up to its source is never issued/.test(msg), 'the guard refuses it', msg.slice(0, 120));
    ok((await pool.query('SELECT COUNT(*)::int AS n FROM rel_invoices')).rows[0].n === 0, 'no invoice survives');
    const job = (await pool.query('SELECT invoice_num, invoice_created, stage, status FROM rel_jobs WHERE id = $1', [conv.jobId])).rows[0];
    ok(job.invoice_num === null && job.invoice_created === false && Number(job.stage) === 8,
      'and the job is untouched — no number stamped, not marked invoiced, stage unchanged', job);
    ok((await counterFor(CO)) === counterBefore, 'no invoice number consumed', { before: counterBefore, after: await counterFor(CO) });

    // THE DOCUMENTED EXCEPTION: a job with no lines builds its single invoice
    // line FROM `value`, so the comparison is inapplicable and is skipped.
    const fx2 = await makeQuote({ lines: [{ description: 'Whatever', qty: 1, unitPrice: 1000, pieces: 1 }] });
    const conv2 = await services.convertQuoteToJob(fx2.quoteId);
    await pool.query('UPDATE rel_jobs SET stage = 8 WHERE id = $1', [conv2.jobId]);
    await pool.query('DELETE FROM rel_job_line_items WHERE job_id = $1', [conv2.jobId]);
    const inv2 = await services.createInvoiceForJob(conv2.jobId);
    const t2 = await invoiceTotals(inv2.invoiceId);
    const v2 = Number((await pool.query('SELECT value FROM rel_jobs WHERE id = $1', [conv2.jobId])).rows[0].value);
    ok(eqMoney(t2.total, v2),
      'the no-lines fallback still works — its one line is built from value, so it matches by construction', { inv: money(t2.total), job: money(v2) });
  }

  // ══ I — numbering safety and proforma reservations ═══════════════════════
  console.log('\n[I] a refusal consumes no number and leaves a PRO reservation intact');
  await reset();
  {
    const fx = await makeQuote({ lines: [{ description: 'ACP', qty: 2, unitPrice: 1600, pieces: 4 }], setupFee: 250 });
    await pool.query(`UPDATE rel_quotes SET proforma_num = 'PRO-07777' WHERE id = $1`, [fx.quoteId]);
    await pool.query(`UPDATE rel_quote_line_items SET pieces = NULL WHERE quote_id = $1`, [fx.quoteId]);
    const counterBefore = await counterFor(CO);
    let msg = '';
    try { await services.createInvoiceFromQuote(fx.quoteId); } catch (e: any) { msg = String(e && e.message); }
    ok(msg !== '', 'the guard refused it', msg.slice(0, 80));
    const q = (await pool.query('SELECT proforma_num, row_version FROM rel_quotes WHERE id = $1', [fx.quoteId])).rows[0];
    ok(q.proforma_num === 'PRO-07777',
      'the PRO reservation is still on the quote — it is only ever read, never consumed by a failed attempt', q.proforma_num);
    ok((await counterFor(CO)) === counterBefore, 'and the invoice counter did not move', { before: counterBefore, after: await counterFor(CO) });
    ok((await pool.query(`SELECT COUNT(*)::int AS n FROM rel_invoices WHERE invoice_number = 'INV-07777'`)).rows[0].n === 0,
      'and the number the reservation implies is still free');

    // Restore the piece count and the same reservation now finalises normally.
    await pool.query(`UPDATE rel_quote_line_items SET pieces = 4 WHERE quote_id = $1`, [fx.quoteId]);
    const fin = await services.finalizeProformaToInvoice(fx.quoteId);
    ok(fin.invoiceNumber === 'INV-07777',
      'and once the data is knowable, that same reservation finalises to its exact number', fin.invoiceNumber);
    ok(eqMoney((await invoiceTotals(fin.invoiceId)).total, fx.quoteTotal),
      'at the quote\'s full total', { inv: money((await invoiceTotals(fin.invoiceId)).total), quote: money(fx.quoteTotal) });
  }

  // ══ J — pieces / fee / discount / VAT on one document ════════════════════
  console.log('\n[J] pieces > 1, setup fee once, discount once, VAT correct');
  await reset();
  {
    const fx = await makeQuote({
      lines: [{ description: 'ACP', qty: 2, unitPrice: 1600, pieces: 4 }, { description: 'Delivery', qty: 1, unitPrice: 500, pieces: null }],
      setupFee: 250, discountPct: 10,
    });
    await makeHistorical('rel_quote_line_items', 'quote_id', fx.quoteId);
    const inv = await services.createInvoiceFromQuote(fx.quoteId);
    const l = await invoiceLines(inv.invoiceId);
    const t = await invoiceTotals(inv.invoiceId);
    ok(l.filter((x: any) => x.description === 'Design & Setup Fee').length === 1, 'exactly one setup-fee line', l.map((x: any) => x.description));
    ok(l.filter((x: any) => /^Discount \(/.test(String(x.description))).length === 1, 'exactly one discount line', l.map((x: any) => x.description));
    ok(l.every((x: any) => x.tax_type === '15%'), 'every line taxed at 15%');
    ok(eqMoney(t.vat, t.subtotal * 0.15), 'VAT is 15% of the (discounted, fee-inclusive) subtotal', { vat: money(t.vat), sub: money(t.subtotal) });
    ok(eqMoney(t.total, fx.quoteTotal), 'and the total equals the quote', { inv: money(t.total), quote: money(fx.quoteTotal) });
    const acp = l.find((x: any) => x.description === 'ACP');
    ok(eqMoney(acp.qty, 8), 'the multi-piece line bills 4 x 2 = 8', Number(acp.qty));
    const del = l.find((x: any) => x.description === 'Delivery');
    ok(eqMoney(del.qty, 1), 'and the line that genuinely had no piece count still bills qty 1', Number(del.qty));
  }

  // ══ K — retry creates no duplicate ═══════════════════════════════════════
  console.log('\n[K] retry after a refusal, and after a success, creates no duplicate');
  await reset();
  {
    const fx = await makeQuote({ lines: [{ description: 'ACP', qty: 2, unitPrice: 1600, pieces: 4 }], setupFee: 250 });
    await pool.query(`UPDATE rel_quote_line_items SET pieces = NULL WHERE quote_id = $1`, [fx.quoteId]);
    for (let i = 0; i < 3; i++) {
      try { await services.createInvoiceFromQuote(fx.quoteId); } catch { /* expected */ }
    }
    ok((await pool.query('SELECT COUNT(*)::int AS n FROM rel_invoices')).rows[0].n === 0,
      'three refused attempts leave zero invoices');

    await pool.query(`UPDATE rel_quote_line_items SET pieces = 4 WHERE quote_id = $1`, [fx.quoteId]);
    const first = await services.createInvoiceFromQuote(fx.quoteId);
    const again = await services.createInvoiceFromQuote(fx.quoteId);
    ok(again.reused === true && again.invoiceId === first.invoiceId,
      'and once it succeeds, a repeat click reuses the same invoice', again);
    ok((await pool.query('SELECT COUNT(*)::int AS n FROM rel_invoices')).rows[0].n === 1, 'exactly one invoice exists');
  }

  // ══ M — company isolation ════════════════════════════════════════════════
  console.log('\n[M] Original (2) / Holdings (1) isolation');
  await reset();
  {
    const a = await makeQuote({ companyCode: CO, client: 'Original Client', lines: [{ description: 'A', qty: 2, unitPrice: 1600, pieces: 4 }], setupFee: 250 });
    const h = await makeQuote({ companyCode: CO_HOLDINGS, client: 'Holdings Client', lines: [{ description: 'H', qty: 1, unitPrice: 900, pieces: 2 }] });
    await makeHistorical('rel_quote_line_items', 'quote_id', a.quoteId);
    await makeHistorical('rel_quote_line_items', 'quote_id', h.quoteId);
    const ia = await services.createInvoiceFromQuote(a.quoteId);
    const ih = await services.createInvoiceFromQuote(h.quoteId);
    ok(eqMoney((await invoiceTotals(ia.invoiceId)).total, a.quoteTotal), 'the Original quote invoices at its own total');
    ok(eqMoney((await invoiceTotals(ih.invoiceId)).total, h.quoteTotal), 'the Holdings quote invoices at its own total');
    const rows = (await pool.query('SELECT company_code, quote_id FROM rel_invoices ORDER BY id')).rows;
    ok(rows.length === 2 && rows[0].company_code === CO && rows[1].company_code === CO_HOLDINGS,
      'each invoice carries its own quote\'s company code', rows);
    const cross = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM rel_invoices i JOIN rel_quotes q ON q.id = i.quote_id WHERE i.company_code <> q.company_code`)).rows[0].n;
    ok(cross === 0, 'and no invoice is linked across companies', cross);
  }

  // ══ N — ONE matching algorithm ═══════════════════════════════════════════
  console.log('\n[N] the analysis report and the invoicing resolver agree, line for line');
  await reset();
  {
    const fx = await makeQuote({ lines: [
      { description: 'Recoverable', qty: 2, unitPrice: 1600, pieces: 4 },
      { description: 'Plain', qty: 1, unitPrice: 500, pieces: null },
    ], setupFee: 250 });
    await makeHistorical('rel_quote_line_items', 'quote_id', fx.quoteId);

    const report = await analyzeMigration013Recovery();
    const resolver = await resolveDocument013ForInvoicing(pool as any, 'quote', fx.quoteId);
    const reportForQuote = report.lines.filter((l) => l.collection === 'quote' && Number(l.documentId) === Number(fx.quoteId));
    ok(reportForQuote.length === resolver.lines.length, 'both see the same number of lines', {
      report: reportForQuote.length, resolver: resolver.lines.length });
    ok(reportForQuote.every((r) => {
      const m = resolver.lines.find((x) => x.lineId === r.lineId);
      return !!m && m.verdict.classification === r.classification;
    }), 'and classify every line identically — there is one matcher, not two',
      reportForQuote.map((r) => ({ line: r.lineIndex, report: r.classification,
        resolver: resolver.lines.find((x) => x.lineId === r.lineId)?.verdict.classification })));

    const srcText = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'relational', 'services.ts'), 'utf8');
    ok(srcText.includes("const EFFECTIVE_QTY_SQL = '($4::numeric * sl.qty)';"),
      'the billed quantity is a resolved ::numeric parameter times the source qty — the SQL no longer reads sl.pieces at all');
    ok(!/CASE WHEN sl\.pieces IS NULL/.test(srcText),
      'and the old "NULL pieces reads as 1" SQL is gone from the writer');
    ok(srcText.includes('resolveDocument013ForInvoicing(client, \'quote\', quoteId)')
       && srcText.includes('resolveDocument013ForInvoicing(client, \'job\', jobId)'),
      'and BOTH invoice paths consult it');
    const repairText = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'scripts', 'repair-sq-00150-inv-00111.ts'), 'utf8');
    ok(repairText.includes('resolveDocument013ForInvoicing(client, \'quote\', Number(quote.id))'),
      'and so does the one-record repair, so it cannot be more permissive than the protection that supersedes it');
  }

  // ══ O — the SQ-00150 fixture ═════════════════════════════════════════════
  console.log('\n[O] the SQ-00150 fixture produces exactly R15,582.50 after deterministic recovery');
  await reset();
  {
    // The confirmed production shape (not the production data): an ACP line of
    // 4 pieces x qty 2 x R1,600, a R500 delivery line, a R250 setup fee, no
    // discount — and the ACP line stripped to a pre-013 backfilled row.
    const fx = await makeQuote({
      client: 'SQ-00150 fixture',
      lines: [
        { description: 'ACP', qty: 2, unitPrice: 1600, pieces: 4, sqmL: 2000, sqmW: 1000 },
        { description: 'Delivery', qty: 1, unitPrice: 500, pieces: null },
      ],
      setupFee: 250, discountPct: 0,
    });
    ok(eqMoney(fx.quoteTotal, 15582.50), 'the fixture quote totals R15,582.50, as the diagnostic reported', money(fx.quoteTotal));

    // BEFORE — what the old writer produced: pieces dropped, 1 x 2 x 1600.
    const brokenSubtotal = 1 * 2 * 1600 + 1 * 1 * 500 + 250;
    ok(eqMoney(brokenSubtotal * 1.15, 4542.50),
      'and reading its NULL piece count as 1 gives exactly the R4,542.50 that was issued', money(brokenSubtotal * 1.15));

    await pool.query(
      `UPDATE rel_quote_line_items SET pieces = NULL, sqm_l = NULL, sqm_w = NULL,
              legacy_data = '{"desc":"ACP","qty":2,"unitPrice":1600,"pQty":4,"sqmL":2000,"sqmW":1000}'::jsonb
        WHERE quote_id = $1 AND description = 'ACP'`, [fx.quoteId]);

    const res = await resolveDocument013ForInvoicing(pool as any, 'quote', fx.quoteId);
    const acp = res.lines.find((l) => l.description === 'ACP')!;
    ok(acp.verdict.classification === 'SAFE_TO_RECOVER'
       && acp.effectivePieces === 4
       && Number(acp.verdict.proposed.sqmL) === 2000 && Number(acp.verdict.proposed.sqmW) === 1000,
      'the historical record deterministically proves pieces = 4, sqm_l = 2000, sqm_w = 1000',
      { classification: acp.verdict.classification, proposed: acp.verdict.proposed });

    const inv = await services.createInvoiceFromQuote(fx.quoteId);
    const t = await invoiceTotals(inv.invoiceId);
    const l = await invoiceLines(inv.invoiceId);
    const acpLine = l.find((x: any) => x.description === 'ACP');
    ok(eqMoney(acpLine.qty, 8) && eqMoney(acpLine.unit_amount, 1600),
      'AFTER: the ACP line bills effective qty 8 @ R1,600 = R12,800', { qty: Number(acpLine.qty), unit: Number(acpLine.unit_amount) });
    ok(eqMoney(l.find((x: any) => x.description === 'Delivery').unit_amount, 500), 'Delivery R500');
    ok(eqMoney(l.find((x: any) => x.description === 'Design & Setup Fee').unit_amount, 250), 'Design & Setup Fee R250');
    ok(eqMoney(t.subtotal, 13550.00), 'Subtotal excl VAT R13,550.00', money(t.subtotal));
    ok(eqMoney(t.vat, 2032.50), 'VAT R2,032.50', money(t.vat));
    ok(eqMoney(t.total, 15582.50), 'TOTAL R15,582.50 — derived from the repaired source, not typed', money(t.total));
    ok(eqMoney(t.total, fx.quoteTotal), 'and it equals the quote\'s own stored total', { inv: money(t.total), quote: money(fx.quoteTotal) });
  }

  // ══ P — manual invoice companyCode type fix ══════════════════════════════
  console.log('\n[P] manual-invoice companyCode type fix');
  {
    ok(src.includes('const relCoCode = String(relCo);'),
      'P1: saveManualInvoice stringifies the company id before sending it');
    ok(src.includes('companyCode: relCoCode, contactName: inv.contactName'),
      'P2: and createInvoice is called with that string, not the raw number');
    ok(!/companyCode: relCo,/.test(src),
      'P3: the old numeric payload is gone');
    ok(/const tagged = \{ \.\.\.inv, id: result\.id, number: result\.invoiceNumber, co: relCo,/.test(src),
      'P4: the LOCAL record still carries the numeric `co` every other frontend comparison uses — only the wire value changed');

    if (BASE) {
      // The REST half needs accInvoices actually cut over — otherwise the
      // route's own not_cut_over refusal fires first and the companyCode
      // validation is never reached. Captured and restored so this suite
      // cannot leave the flags in a state a later suite silently depends on.
      const priorCutover = (await pool.query(`SELECT section, enabled FROM relational_cutover`)).rows;
      await pool.query(`INSERT INTO relational_cutover (section, enabled) VALUES ('accInvoices', true)
                        ON CONFLICT (section) DO UPDATE SET enabled = true`);
      const login = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: process.env.TEST_LOGIN_EMAIL || 'test@signacore.local', password: process.env.TEST_LOGIN_PASSWORD || 'testpass' }),
      });
      const token = (await login.json() as any).token;
      const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
      const body = (companyCode: any) => JSON.stringify({
        companyCode, contactName: 'Manual Test', reference: 'SQ-00150', status: 'sent',
        lines: [{ description: 'Signage', qty: 1, unitAmount: 1500, accountCode: '4000', taxType: '15%' }],
      });
      const numRes = await fetch(`${BASE}/api/relational/invoices`, { method: 'POST', headers: H, body: body(2) });
      ok(numRes.status === 400,
        'P5: the endpoint still rejects a NUMBER companyCode — the route contract is unchanged, the caller was fixed', numRes.status);
      const strRes = await fetch(`${BASE}/api/relational/invoices`, { method: 'POST', headers: H, body: body(String(CO)) });
      const strBody: any = await strRes.json();
      ok(strRes.status === 201 && strBody.success === true,
        'P6: and accepts the STRING the frontend now sends — the manual invoice saves', { status: strRes.status, body: strBody });
      const created = (await pool.query('SELECT company_code, reference FROM rel_invoices WHERE id = $1', [strBody.id])).rows[0];
      ok(!!created && created.company_code === CO,
        'P7: stored against the right company', created);
      for (const row of priorCutover) {
        await pool.query(`UPDATE relational_cutover SET enabled = $2 WHERE section = $1`, [row.section, row.enabled]);
      }
    } else {
      console.log('  (TEST_SERVER_URL_WITH_AUTHORITY not set — the end-to-end half of [P] is skipped)');
    }
  }

  console.log(`\n[historical-pieces-invoice-protection] ${passed} passed, ${failures} failed`);
  await pool.end();
  if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error('[historical-pieces-invoice-protection] Fatal error:', err);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
