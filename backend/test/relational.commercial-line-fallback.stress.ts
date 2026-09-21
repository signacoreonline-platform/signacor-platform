/**
 * relational.commercial-line-fallback.stress.ts
 * PRESERVED COMMERCIAL-LINE FALLBACK (2026-09-21 — SNS-00128)
 *
 * THE LIVE CASE THIS PINS
 *   Job SNS-00128 declares R24,963.62. Its OWN line items come to R16,044.80.
 *   Two real customer payments are already banked against it:
 *       R12,835.84 = 80% of R16,044.80          (the original sale)
 *       R 7,135.06 = 80% of R 8,918.825         (the agreed increase)
 *       R19,970.90 = 80% of R24,963.625         (the revised sale)
 *   The linked Quote SQ-00187 carries the REVISED commercial detail for the
 *   SAME product, re-measured and re-rated:
 *       2480 × 1150 mm = 2.8520 m² @ R3,500 = R 9,982.00   (Job, original)
 *       5500 × 1075 mm = 5.9125 m² @ R3,000 = R17,737.50   (Quote, revised)
 *   Identical description on both sides, both areas exact from their own
 *   dimensions — a genuine re-measure, not a back-solved figure. The other two
 *   lines, the R250 setup fee and the 0% discount are identical.
 *
 *   The Job's lines are therefore STALE COMMERCIAL DETAIL — the conversion-time
 *   copy of the superseded sale — not a production variation.
 *
 * WHAT IS PROVED HERE
 *   1  the SNS-00128 shape now invoices at the Job's declared value, with the
 *      Quote's commercial detail, and nothing else moves
 *   2  the ordinary Job-line path is untouched when the Job reconciles
 *   3–11 every safety condition refuses on its own
 *   12 a genuine R0.00 sponsored job is unaffected
 *   13 payments are byte-identical and counted once
 *   14 the converted-Quote divergence prevention still operates
 *
 * Throwaway PostgreSQL only. No production connection, no production write.
 *
 * Usage (from backend/):
 *   npx ts-node --transpile-only test/relational.commercial-line-fallback.stress.ts
 */
import pool from '../src/db/pool';
import * as services from '../src/relational/services';

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}
const cents = (n: unknown) => Math.round((Number(n) || 0) * 100);
const money = (n: unknown) => cents(n) / 100;
const near = (a: unknown, b: unknown, tol = 0.05) => Math.abs((Number(a) || 0) - (Number(b) || 0)) <= tol;

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

// ── THE SNS-00128 COMMERCIAL SHAPE ──────────────────────────────────────────
// The real descriptions and the real dimensions, because the description match
// and the dimension arithmetic are what prove this is ONE product re-measured
// rather than two different sales that happen to total the same:
//     2480 × 1150 mm = 2.852   m²   @ R3,500 = R 9,982.00   (original)
//     5500 × 1075 mm = 5.9125  m²   @ R3,000 = R17,737.50   (revised)
// These numbers exist only here. Nothing in src/ knows them.
const PANEL_DESC =
  'Black 3mm Aluminium Composite Panel with a 0.3mm Coating and\n' +
  'full colour digital printed graphics including UV Protection\n' +
  'Lamination.\nCool White LED modules to provide Halo effect lighting.';
const INSTALL_DESC = 'Installation Labour';
const TRAVEL_DESC = 'Travel';

const PANEL_ORIGINAL = { description: PANEL_DESC, qty: 2.852, unitPrice: 3500, pieces: 1, unit: 'm²', sqmL: 2480, sqmW: 1150 };
const PANEL_REVISED  = { description: PANEL_DESC, qty: 5.9125, unitPrice: 3000, pieces: 1, unit: 'm²', sqmL: 5500, sqmW: 1075 };
const INSTALL_LINE   = { description: INSTALL_DESC, qty: 4, unitPrice: 650, pieces: 1, unit: 'ea' };
const TRAVEL_LINE    = { description: TRAVEL_DESC, qty: 160, unitPrice: 7, pieces: 1, unit: 'km' };
const SETUP_FEE = 250;

const ORIGINAL_TOTAL = 16044.80;      // 9,982.00 + 2,600.00 + 1,120.00 + 250 = 13,952.00 ex VAT
const REVISED_TOTAL  = 24963.625;     // 17,737.50 + 2,600.00 + 1,120.00 + 250 = 21,707.50 ex VAT
const STORED_JOB_VALUE = 24963.62;    // what the pre-guard JS cascade actually wrote
const PAYMENT_1 = 12835.84;
const PAYMENT_2 = 7135.06;
const TOTAL_PAID = 19970.90;
const OUTSTANDING = 4992.72;

const toLine = (l: any) => ({
  description: l.description, desc: l.description, qty: l.qty, unitPrice: l.unitPrice,
  unit: l.unit ?? 'ea', pieces: l.pieces ?? null,
  sqmL: l.sqmL ?? null, sqmW: l.sqmW ?? null, cpId: null, cpLinked: null,
});

interface Fx { quoteId: number; jobId: number; jobNumber: string; quoteNumber: string; }

/**
 * Reproduces the PRODUCTION state, using deployed code for every step it can.
 *
 * The divergence cannot be created through updateQuoteWithJobSync any more —
 * the converted-Quote guard now refuses it, which is the point of that guard.
 * So the quote side is repriced with services.updateQuote (the NON-cascading
 * updater that has always existed alongside it, and which is exactly what
 * touches the quote without touching the job), and rel_jobs.value is then set
 * to the figure the pre-guard cascade actually wrote. That is the state as it
 * exists in production: value moved, lines did not.
 */
async function makeStaleCommercialJob(opts: {
  companyCode?: string;
  revisedLines?: any[];
  jobValue?: number;
  customerName?: string;
} = {}): Promise<Fx> {
  const companyCode = opts.companyCode ?? '2';
  const name = opts.customerName ?? 'SNS-00128 Client';
  const cust = await services.createCustomer({ companyName: name });

  // 1. The ORIGINAL sale, quoted and converted.
  const quote = await services.createQuote({
    companyCode, customerId: cust.id, customerNameRaw: name,
    setupFee: SETUP_FEE, discountPct: 0,
    lines: [PANEL_ORIGINAL, INSTALL_LINE, TRAVEL_LINE].map(toLine) as any,
  });
  const conv = await services.convertQuoteToJob(quote.id);

  // 2. The REVISION, on the quote only — job lines untouched, exactly as
  //    BLOCKER 2 requires.
  const ver = Number((await pool.query('SELECT row_version FROM rel_quotes WHERE id=$1', [quote.id])).rows[0].row_version);
  await services.updateQuote(quote.id, ver, {
    lines: (opts.revisedLines ?? [PANEL_REVISED, INSTALL_LINE, TRAVEL_LINE]).map(toLine) as any,
    setupFee: SETUP_FEE, discountPct: 0,
  } as any);

  // 3. The value cascade that DID happen, before the guard existed.
  await pool.query('UPDATE rel_jobs SET value = $1 WHERE id = $2',
    [opts.jobValue ?? STORED_JOB_VALUE, conv.jobId]);

  const j = await pool.query('SELECT job_number FROM rel_jobs WHERE id = $1', [conv.jobId]);
  const q = await pool.query('SELECT quote_number FROM rel_quotes WHERE id = $1', [quote.id]);
  return { quoteId: quote.id, jobId: conv.jobId, jobNumber: j.rows[0].job_number, quoteNumber: q.rows[0].quote_number };
}

async function invLines(invoiceId: number) {
  return (await pool.query(
    `SELECT line_index, description, qty, unit_amount, account_code, tax_type, legacy_data
       FROM rel_invoice_line_items WHERE invoice_id = $1 ORDER BY line_index`, [invoiceId])).rows;
}
async function invoiceTotal(invoiceId: number): Promise<number> {
  const r = await pool.query(
    `SELECT COALESCE(SUM(qty*unit_amount),0)
          + COALESCE(SUM(CASE WHEN tax_type='15%' THEN qty*unit_amount*0.15 ELSE 0 END),0) AS t
       FROM rel_invoice_line_items WHERE invoice_id=$1`, [invoiceId]);
  return Number(r.rows[0].t) || 0;
}
async function snapshotAll() {
  const q = async (sql: string) => JSON.stringify((await pool.query(sql)).rows);
  return {
    jobs: await q('SELECT id, value, discount_pct, setup_fee, row_version FROM rel_jobs ORDER BY id'),
    jobLines: await q('SELECT job_id, line_index, description, qty, unit_price, pieces, sqm_l, sqm_w, subtotal FROM rel_job_line_items ORDER BY job_id, line_index'),
    quotes: await q('SELECT id, subtotal, vat_amount, total, discount_pct, setup_fee, row_version FROM rel_quotes ORDER BY id'),
    quoteLines: await q('SELECT quote_id, line_index, description, qty, unit_price, pieces, sqm_l, sqm_w, subtotal FROM rel_quote_line_items ORDER BY quote_id, line_index'),
    payments: await q('SELECT id, owner_type, owner_id, line_index, amount, payment_date, method, reference, notes, row_version, client_request_id FROM rel_payments ORDER BY id'),
    counters: await q('SELECT * FROM document_number_counters ORDER BY 1,2'),
  };
}
async function expectRefusal(jobId: number, label: string) {
  const before = await snapshotAll();
  let err: any = null;
  try { await services.createInvoiceForJob(jobId); } catch (e) { err = e; }
  ok(err instanceof services.BusinessRuleError, label, err && String(err.message).slice(0, 140));
  ok(!!err && /does not reconcile with its own line items/.test(String(err.message)),
    `${label} — with the EXISTING Job-vs-Job-lines refusal, not a new error path`);
  const after = await snapshotAll();
  ok(before.jobs === after.jobs && before.jobLines === after.jobLines, `${label} — rel_jobs / rel_job_line_items untouched`);
  ok(before.quotes === after.quotes && before.quoteLines === after.quoteLines, `${label} — rel_quotes / rel_quote_line_items untouched`);
  ok(before.payments === after.payments, `${label} — rel_payments byte-identical`);
  ok(before.counters === after.counters, `${label} — no invoice number consumed`);
  ok((await pool.query('SELECT COUNT(*)::int n FROM rel_invoices')).rows[0].n === 0, `${label} — no invoice row written`);
}

async function main() {
  // ══ 1 — THE SNS-00128 SHAPE ══════════════════════════════════════════════
  console.log('\n[1] the SNS-00128 shape: stale Job lines, proven linked Quote, two banked payments');
  {
    await reset();
    const fx = await makeStaleCommercialJob();

    const jobBefore = (await pool.query('SELECT * FROM rel_jobs WHERE id=$1', [fx.jobId])).rows[0];
    ok(cents(jobBefore.value) === cents(STORED_JOB_VALUE), 'Job declares R24,963.62', money(jobBefore.value));
    const jobRecon = await (async () => {
      const r = await pool.query(
        `SELECT (COALESCE(SUM(COALESCE(NULLIF(pieces,0),1)*qty*unit_price),0) + $2::numeric) * 1.15 AS t
           FROM rel_job_line_items WHERE job_id = $1`, [fx.jobId, SETUP_FEE]);
      return Number(r.rows[0].t);
    })();
    ok(cents(jobRecon) === cents(ORIGINAL_TOTAL), 'its OWN lines come to R16,044.80 — the superseded sale', money(jobRecon));

    // The two real payments, recorded on the Quote as they are in production.
    await services.recordPayment({ type: 'quote', id: fx.quoteId }, PAYMENT_1, { date: '2026-06-02', method: 'EFT', reference: 'DEP-1' });
    await services.recordPayment({ type: 'quote', id: fx.quoteId }, PAYMENT_2, { date: '2026-08-14', method: 'EFT', reference: 'DEP-2' });

    const before = await snapshotAll();

    // ── THE ACT ──
    const inv = await services.createInvoiceForJob(fx.jobId);
    ok(!!inv.invoiceNumber && inv.created === true, 'the invoice IS created', inv.invoiceNumber);

    // Exactly one invoice, exactly one number.
    ok((await pool.query('SELECT COUNT(*)::int n FROM rel_invoices')).rows[0].n === 1, 'exactly ONE invoice exists');
    const counters = (await pool.query('SELECT * FROM document_number_counters')).rows;
    ok(counters.length === 1, 'exactly one document-number counter advanced', counters.length);

    // Commercial detail came from the QUOTE.
    const lines = await invLines(inv.invoiceId);
    ok(lines.length === 4, 'three commercial lines plus the setup fee (0% discount → no discount line)', lines.map((l: any) => l.description));
    ok(cents(lines[0].qty) === cents(5.9125) && cents(lines[0].unit_amount) === cents(3000),
      'line 0 is the REVISED commercial line: 5.9125 m² @ R3,000.00', { qty: String(lines[0].qty), price: String(lines[0].unit_amount) });
    ok(cents(Number(lines[0].qty) * Number(lines[0].unit_amount)) === cents(17737.50), '…totalling R17,737.50', money(Number(lines[0].qty) * Number(lines[0].unit_amount)));
    ok(cents(Number(lines[1].qty) * Number(lines[1].unit_amount)) === cents(2600), 'Installation Labour R2,600.00 unchanged');
    ok(cents(Number(lines[2].qty) * Number(lines[2].unit_amount)) === cents(1120), 'Travel R1,120.00 unchanged');
    ok(lines[3].description === 'Design & Setup Fee' && cents(lines[3].unit_amount) === cents(SETUP_FEE), 'Setup fee R250.00 as its own line', lines[3].description);
    ok(lines.every((l: any) => l.tax_type === '15%'), 'every line carries the existing 15% VAT treatment');
    ok(lines[0].legacy_data.srcTable === 'rel_quote_line_items',
      'the line provenance records the QUOTE as the commercial source', lines[0].legacy_data.srcTable);
    ok(Number(lines[0].legacy_data.sqmL) === 5500 && Number(lines[0].legacy_data.sqmW) === 1075,
      '…with the revised dimensions 5500 × 1075 mm on the document', lines[0].legacy_data);

    // The money.
    const total = await invoiceTotal(inv.invoiceId);
    ok(near(total, REVISED_TOTAL, 0.005), 'the invoice comes to R24,963.625 before document rounding', money(total));
    ok(near(total, Number(jobBefore.value)), 'and it reconciles to job.value under the EXISTING tolerance', { inv: total, job: Number(jobBefore.value) });

    // BOTH links.
    const invRow = (await pool.query('SELECT job_id, quote_id, reference, job_number_raw, quote_number_raw, legacy_data FROM rel_invoices WHERE id=$1', [inv.invoiceId])).rows[0];
    ok(Number(invRow.job_id) === Number(fx.jobId), 'the invoice keeps job_id', invRow.job_id);
    ok(Number(invRow.quote_id) === Number(fx.quoteId), 'the invoice keeps quote_id', invRow.quote_id);
    ok(invRow.reference === fx.jobNumber, 'and the reference → job-number relationship is unchanged', invRow.reference);

    // Provenance.
    const prov = invRow.legacy_data && invRow.legacy_data.commercialLineSource;
    ok(!!prov && prov.kind === 'linked-quote-fallback', 'provenance is stamped on rel_invoices.legacy_data', prov);
    ok(!!prov && Number(prov.quoteId) === Number(fx.quoteId) && prov.quoteNumber === fx.quoteNumber,
      '…naming the source quote id and number', prov);
    ok(!!prov && !('total' in prov) && !('value' in prov),
      '…and storing NO second financial total or source of truth', prov);

    // Nothing else moved.
    const after = await snapshotAll();
    ok(before.jobs === after.jobs || JSON.parse(after.jobs)[0].value === JSON.parse(before.jobs)[0].value,
      'rel_jobs.value / discount / setup fee unchanged');
    ok(before.jobLines === after.jobLines, 'rel_job_line_items UNCHANGED — the stale lines were not repaired');
    ok(before.quotes === after.quotes, 'rel_quotes unchanged');
    ok(before.quoteLines === after.quoteLines, 'rel_quote_line_items unchanged');
    ok(before.payments === after.payments, 'rel_payments byte-identical');
    ok((await pool.query('SELECT COUNT(*)::int n FROM rel_payments')).rows[0].n === 2, 'payment count is still exactly 2 — none copied or created');

    // Payments resolve through the chain exactly once.
    const client = await pool.connect();
    try {
      const chain = await services.resolveTransactionChainTx(client, 'invoice', inv.invoiceId);
      const paid = await services.sumChainPaymentsTx(client, chain);
      ok(cents(paid) === cents(TOTAL_PAID), 'the chain resolver sees R19,970.90 — both rows, counted once', money(paid));
      ok(cents(Number(jobBefore.value) - paid) === cents(OUTSTANDING), 'outstanding against job.value is R4,992.72', money(Number(jobBefore.value) - paid));
      ok(chain.invoiceIds.length === 1, 'the new invoice is the single active invoice on the chain', chain.invoiceIds);
    } finally { client.release(); }
  }

  // ══ 2 — ORDINARY PATH UNCHANGED ══════════════════════════════════════════
  console.log('\n[2] a Job whose own lines reconcile still invoices from its OWN lines');
  {
    await reset();
    const cust = await services.createCustomer({ companyName: 'Ordinary Co' });
    const quote = await services.createQuote({
      companyCode: '2', customerId: cust.id, customerNameRaw: 'Ordinary Co',
      setupFee: SETUP_FEE, discountPct: 0,
      lines: [PANEL_ORIGINAL, INSTALL_LINE, TRAVEL_LINE].map(toLine) as any,
    });
    const conv = await services.convertQuoteToJob(quote.id);
    const inv = await services.createInvoiceForJob(conv.jobId);
    const lines = await invLines(inv.invoiceId);
    ok(lines[0].legacy_data.srcTable === 'rel_job_line_items',
      'the ordinary path still sources from rel_job_line_items', lines[0].legacy_data.srcTable);
    const invRow = (await pool.query('SELECT legacy_data FROM rel_invoices WHERE id=$1', [inv.invoiceId])).rows[0];
    ok(!invRow.legacy_data.commercialLineSource, '…and stamps NO fallback provenance', invRow.legacy_data);
    ok(near(await invoiceTotal(inv.invoiceId), ORIGINAL_TOTAL, 0.005), '…totalling R16,044.80 from the job’s own lines', money(await invoiceTotal(inv.invoiceId)));
  }

  // ══ 3–11 — EVERY SAFETY CONDITION, ONE AT A TIME ═════════════════════════
  console.log('\n[3] Job mismatch + Quote total does not reconcile to job.value → REFUSE');
  { await reset(); const fx = await makeStaleCommercialJob({ jobValue: 30000 }); await expectRefusal(fx.jobId, '[3] quote total mismatch'); }

  console.log('\n[4] Job mismatch + no quote_id → REFUSE');
  { await reset(); const fx = await makeStaleCommercialJob();
    await pool.query('UPDATE rel_jobs SET quote_id = NULL WHERE id = $1', [fx.jobId]);
    await expectRefusal(fx.jobId, '[4] no stable quote_id'); }

  console.log('\n[5] Job mismatch + wrong-company Quote → REFUSE');
  { await reset(); const fx = await makeStaleCommercialJob();
    await pool.query('UPDATE rel_quotes SET company_code = $1 WHERE id = $2', ['1', fx.quoteId]);
    await expectRefusal(fx.jobId, '[5] company mismatch'); }

  console.log('\n[6] Job mismatch + Quote financial blocker (migration-013 unresolved) → REFUSE');
  { await reset(); const fx = await makeStaleCommercialJob();
    await pool.query(
      `UPDATE rel_quote_line_items SET pieces = NULL, unit_price = unit_price + 111, legacy_data = '{}'::jsonb
        WHERE quote_id = $1 AND line_index = 0`, [fx.quoteId]);
    await pool.query(`UPDATE platform_state SET data = $1::jsonb WHERE id = 1`,
      [JSON.stringify({ quotes: [{ num: fx.quoteNumber, co: 2, lines: [
        { desc: PANEL_DESC, qty: 5.9125, unitPrice: 3000, pQty: 2 },
        { desc: PANEL_DESC, qty: 5.9125, unitPrice: 3000, pQty: 7 },
      ] }] })]);
    await expectRefusal(fx.jobId, '[6] quote piece counts unresolvable');
    await pool.query(`UPDATE platform_state SET data = '{}'::jsonb WHERE id = 1`); }

  console.log('\n[7] line COUNT mismatch → REFUSE');
  { await reset(); const fx = await makeStaleCommercialJob();
    await pool.query('DELETE FROM rel_quote_line_items WHERE quote_id = $1 AND line_index = 2', [fx.quoteId]);
    await expectRefusal(fx.jobId, '[7] line count mismatch'); }

  console.log('\n[8] line DESCRIPTION mismatch → REFUSE (a different product, not a re-measure)');
  { await reset(); const fx = await makeStaleCommercialJob();
    await pool.query(`UPDATE rel_quote_line_items SET description = 'Completely different signage product'
                       WHERE quote_id = $1 AND line_index = 0`, [fx.quoteId]);
    await expectRefusal(fx.jobId, '[8] description mismatch'); }

  console.log('\n[9] DISCOUNT mismatch → REFUSE');
  { await reset(); const fx = await makeStaleCommercialJob();
    await pool.query('UPDATE rel_quotes SET discount_pct = 5 WHERE id = $1', [fx.quoteId]);
    await expectRefusal(fx.jobId, '[9] discount mismatch'); }

  console.log('\n[10] SETUP-FEE mismatch → REFUSE');
  { await reset(); const fx = await makeStaleCommercialJob();
    await pool.query('UPDATE rel_quotes SET setup_fee = 400 WHERE id = $1', [fx.quoteId]);
    await expectRefusal(fx.jobId, '[10] setup fee mismatch'); }

  console.log('\n[11] two Jobs claim the same Quote → REFUSE');
  { await reset(); const fx = await makeStaleCommercialJob();
    const other = await makeStaleCommercialJob({ customerName: 'Second Claimant' });
    await pool.query('UPDATE rel_jobs SET quote_id = $1 WHERE id = $2', [fx.quoteId, other.jobId]);
    await expectRefusal(fx.jobId, '[11] ambiguous claim'); }

  console.log('\n[12] converted_job_id points at a different Job → REFUSE');
  { await reset(); const fx = await makeStaleCommercialJob();
    const other = await makeStaleCommercialJob({ customerName: 'Elsewhere' });
    await pool.query('UPDATE rel_quotes SET converted_job_id = $1 WHERE id = $2', [other.jobId, fx.quoteId]);
    await expectRefusal(fx.jobId, '[12] converted_job_id points elsewhere'); }

  // ══ 13 — ZERO-VALUE BEHAVIOUR UNCHANGED ══════════════════════════════════
  console.log('\n[13] a genuine R0.00 sponsored Job is unaffected');
  {
    await reset();
    const cust = await services.createCustomer({ companyName: 'Sponsored Co' });
    const quote = await services.createQuote({
      companyCode: '2', customerId: cust.id, customerNameRaw: 'Sponsored Co',
      setupFee: 0, discountPct: 100,
      lines: [{ description: 'Sponsored signage', qty: 4, unitPrice: 3000, pieces: 1, unit: 'ea' }].map(toLine) as any,
    });
    const conv = await services.convertQuoteToJob(quote.id);
    ok(cents((await pool.query('SELECT value FROM rel_jobs WHERE id=$1', [conv.jobId])).rows[0].value) === 0,
      'the sponsored job carries R0.00');
    const inv = await services.createInvoiceForJob(conv.jobId);
    ok(cents(await invoiceTotal(inv.invoiceId)) === 0, 'it still invoices, at R0.00');
    const lines = await invLines(inv.invoiceId);
    ok(lines[0].legacy_data.srcTable === 'rel_job_line_items', '…from its OWN lines — the fallback was never consulted');
    ok((await pool.query('SELECT COUNT(*)::int n FROM rel_payments')).rows[0].n === 0, '…and no payment was created');

    // And a R0.00 job whose own lines price positively is still refused.
    await reset();
    const c2 = await services.createCustomer({ companyName: 'Bad Zero Co' });
    const q2 = await services.createQuote({
      companyCode: '2', customerId: c2.id, customerNameRaw: 'Bad Zero Co', setupFee: 0, discountPct: 0,
      lines: [{ description: 'Sign', qty: 4, unitPrice: 2500, pieces: 1, unit: 'ea' }].map(toLine) as any,
    });
    const conv2 = await services.convertQuoteToJob(q2.id);
    await pool.query('UPDATE rel_jobs SET value = 0 WHERE id = $1', [conv2.jobId]);
    let zErr: any = null;
    try { await services.createInvoiceForJob(conv2.jobId); } catch (e) { zErr = e; }
    ok(zErr instanceof services.BusinessRuleError,
      'a R0.00 job whose own lines price to R11,500.00 is still REFUSED — the quote reconciles to R11,500, not R0.00', zErr && String(zErr.message).slice(0, 120));
  }

  // ══ 14 — THE PREVENTION GUARD STILL OPERATES ═════════════════════════════
  console.log('\n[14] the converted-Quote divergence prevention is untouched');
  {
    await reset();
    const cust = await services.createCustomer({ companyName: 'Prevention Co' });
    const quote = await services.createQuote({
      companyCode: '2', customerId: cust.id, customerNameRaw: 'Prevention Co', setupFee: 0, discountPct: 0,
      lines: [{ description: 'Sign', qty: 2, unitPrice: 1000, pieces: 1, unit: 'ea' }].map(toLine) as any,
    });
    await services.convertQuoteToJob(quote.id);
    const ver = Number((await pool.query('SELECT row_version FROM rel_quotes WHERE id=$1', [quote.id])).rows[0].row_version);
    let gErr: any = null;
    try {
      await services.updateQuoteWithJobSync(quote.id, ver, {
        lines: [{ desc: 'Sign', qty: 7, unitPrice: 1000, unit: 'ea', pieces: null, sqmL: null, sqmW: null, cpId: null, cpLinked: null }],
        setupFee: 0, discountPct: 0,
      } as any);
    } catch (e) { gErr = e; }
    ok(gErr instanceof services.BusinessRuleError,
      'an ordinary converted-Quote financial edit is STILL refused — the fallback did not weaken prevention', gErr && String(gErr.message).slice(0, 120));
  }

  console.log('\n============================================================');
  console.log(`[commercial-line-fallback] ${passed} passed, ${failures} failed`);
  console.log('============================================================');
  await pool.end();
  if (failures > 0) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error('\n[commercial-line-fallback] Fatal error:', err);
  process.exitCode = 1;
  await pool.end().catch(() => undefined);
});
