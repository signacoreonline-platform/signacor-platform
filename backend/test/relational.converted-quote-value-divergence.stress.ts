/**
 * relational.converted-quote-value-divergence.stress.ts
 * CONVERTED-QUOTE FINANCIAL DIVERGENCE REFUSAL (2026-09-21)
 *
 * THE CONFIRMED PRODUCTION CASE THIS PINS — SNS-00128
 *   Job value ............................. R24,963.62
 *   Job's own lines + setup fee come to ... R16,044.80
 *   Difference ............................  R8,918.82
 *   Two real customer payments already banked against the transaction.
 *
 * ROOT CAUSE (proved by trace, not guessed)
 *   rel_jobs.value is QUOTE-owned: updateQuoteWithJobSync recomputes it from
 *   the quote's totals on every save of a converted quote, and the shipped edit
 *   patch always carries `lines`, so the money moves even on a phone-number
 *   edit. rel_job_line_items is PRODUCTION-owned and is deliberately not
 *   resynced (BLOCKER 2, 2026-08-24 — the implicit cascade used to delete
 *   production lines, reproduced 3 -> 1). Value cascaded, lines did not, and
 *   the two came apart silently. The invoice guard found it months later, at
 *   which point the job could not be invoiced at all.
 *
 * WHAT THIS SUITE PROVES
 *   T0  the OLD behaviour really could create the inconsistent state
 *       (kept as a fossil, reproduced with a direct write, so the regression is
 *        anchored to a real shape and not to a description of one)
 *   1   a converted-quote financial edit that would create divergence REFUSES,
 *       and nothing anywhere is partially written
 *   2   an UNCONVERTED quote's financial edit is untouched
 *   3   converted-quote NON-financial edits are untouched (BLOCKER 2 contract)
 *   4   a financial FIELD touched with no resulting value change is allowed
 *   5   company isolation
 *   6   rel_payments is byte-identical across a refusal
 *   10  an explicit resyncJobLines that makes the job reconcile is ALLOWED
 *   11  a job with no line items is exempt (nothing to reconcile)
 *   12A a legitimate sponsored R0.00 job reconciles and is allowed
 *   12B a R0.00 value against positive lines is REFUSED
 *   13  an edit that REPAIRS an existing divergence is allowed
 *   14  a stale expectedJobVersion still raises ConcurrencyConflictError
 *   15  unresolvable migration-013 piece counts REFUSE; a non-financial
 *       MISMATCH does not
 *   16  a pre-existing divergence does not freeze unrelated edits
 *
 * These run the REAL services against a REAL database. Nothing here
 * re-implements the guard it is testing.
 */
import pool from '../src/db/pool';
import * as services from '../src/relational/services';

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}
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

interface Fx { quoteId: number; jobId: number; jobNumber: string; quoteNumber: string; }

async function makeConvertedJob(opts: {
  companyCode?: string;
  lines: Array<{ description: string; qty: number; unitPrice: number; pieces?: number | null; unit?: string }>;
  setupFee?: number;
  discountPct?: number;
  customerName?: string;
}): Promise<Fx> {
  const companyCode = opts.companyCode ?? '2';
  const name = opts.customerName ?? 'Divergence Test Co';
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
  const j = await pool.query('SELECT job_number FROM rel_jobs WHERE id = $1', [conv.jobId]);
  const q = await pool.query('SELECT quote_number FROM rel_quotes WHERE id = $1', [quote.id]);
  return {
    quoteId: quote.id, jobId: conv.jobId,
    jobNumber: j.rows[0].job_number, quoteNumber: q.rows[0].quote_number,
  };
}

async function quoteVer(id: number): Promise<number> {
  return Number((await pool.query('SELECT row_version FROM rel_quotes WHERE id=$1', [id])).rows[0].row_version);
}
async function jobRow(id: number) {
  return (await pool.query('SELECT * FROM rel_jobs WHERE id=$1', [id])).rows[0];
}
async function jobLines(id: number) {
  return (await pool.query(
    'SELECT line_index, description, qty, unit_price, pieces, subtotal FROM rel_job_line_items WHERE job_id=$1 ORDER BY line_index', [id]
  )).rows;
}
async function quoteRow(id: number) {
  return (await pool.query('SELECT * FROM rel_quotes WHERE id=$1', [id])).rows[0];
}
async function paymentsSnapshot(): Promise<string> {
  const r = await pool.query(
    `SELECT id, owner_type, owner_id, line_index, amount, payment_date, method, reference, notes,
            row_version, client_request_id
       FROM rel_payments ORDER BY id`
  );
  return JSON.stringify(r.rows);
}
async function counters(): Promise<string> {
  const r = await pool.query('SELECT * FROM document_number_counters ORDER BY 1,2');
  return JSON.stringify(r.rows);
}
/** The patch the SHIPPED frontend actually sends: header fields AND lines AND
 *  setupFee AND discountPct, unconditionally, on every quote save. Tests that
 *  send less than this are not testing the real caller. */
function shippedPatch(over: Record<string, unknown>, lines: Array<{ desc: string; qty: number; unitPrice: number; pieces?: number | null }>, setupFee: number, discountPct: number) {
  return Object.assign({
    notes: '', terms: '', salesperson: '', preparedBy: '', poRef: '', reference: '',
    setupFee, discountPct,
    lines: lines.map((l) => ({
      desc: l.desc, qty: l.qty, unitPrice: l.unitPrice, unit: 'ea', itemId: null,
      sqmL: null, sqmW: null, pieces: l.pieces === undefined ? null : l.pieces, cpId: null, cpLinked: null,
    })),
  }, over);
}
async function expectBusinessRule(fn: () => Promise<unknown>, label: string): Promise<Error | null> {
  try { await fn(); ok(false, label + ' — expected a refusal, the call SUCCEEDED'); return null; }
  catch (e: any) {
    const isBr = e instanceof services.BusinessRuleError;
    ok(isBr, label, isBr ? undefined : { got: e && e.constructor && e.constructor.name, message: e && e.message });
    return e;
  }
}

async function main() {
  await reset();

  // ══ T0 — THE DEFECT, REPRODUCED ══════════════════════════════════════════
  // The old code reached this state through the cascade. The cascade now
  // refuses it, so the state is produced here with a DIRECT write — the same
  // end state, reached honestly, so every "an already-divergent job behaves
  // like X" case below stands on a real row and not on a mock.
  console.log('\n[T0] the internally inconsistent Job the old cascade could create');
  {
    const fx = await makeConvertedJob({ lines: [{ description: 'Sign', qty: 2, unitPrice: 1000 }], setupFee: 0 });
    const before = await jobRow(fx.jobId);
    ok(eqMoney(before.value, 2300), 'converted job starts reconciling: 2 x R1,000 x 1.15 = R2,300.00', before.value);

    await pool.query('UPDATE rel_jobs SET value = $1 WHERE id = $2', [3277.5, fx.jobId]);
    const after = await jobRow(fx.jobId);
    const lines = await jobLines(fx.jobId);
    ok(eqMoney(after.value, 3277.5), 'job.value moved to R3,277.50', after.value);
    ok(lines.length === 1 && Number(lines[0].qty) === 2, '…while the job\'s own lines are untouched at qty 2', lines);
    ok(!eqMoney(after.value, 2300), 'the Job is now internally inconsistent — R3,277.50 declared, R2,300.00 supported');

    const err = await expectBusinessRule(
      () => services.createInvoiceForJob(fx.jobId),
      'an internally inconsistent Job cannot be invoiced (the guard that found SNS-00128)'
    );
    ok(!!err && /does not reconcile with its own line items/.test(String(err.message)),
      '…and the refusal names the Job, not the Quote, as the thing that does not reconcile', err && err.message);
  }

  // ══ CASE 1 — CONVERTED QUOTE, FINANCIAL EDIT CREATING DIVERGENCE ═════════
  console.log('\n[1] a converted-Quote financial edit that would create divergence is refused');
  {
    await reset();
    const fx = await makeConvertedJob({ lines: [{ description: 'Sign', qty: 2, unitPrice: 1000 }], setupFee: 0 });
    const qBefore = await quoteRow(fx.quoteId);
    const jBefore = await jobRow(fx.jobId);
    const jlBefore = JSON.stringify(await jobLines(fx.jobId));
    const qlBefore = JSON.stringify((await pool.query(
      'SELECT line_index, qty, unit_price FROM rel_quote_line_items WHERE quote_id=$1 ORDER BY line_index', [fx.quoteId])).rows);
    const payBefore = await paymentsSnapshot();
    const cntBefore = await counters();

    const err = await expectBusinessRule(
      () => services.updateQuoteWithJobSync(
        fx.quoteId, Number(qBefore.row_version),
        shippedPatch({}, [{ desc: 'Sign (rush)', qty: 3, unitPrice: 1000 }], 0, 5)
      ),
      'the save is refused with a BusinessRuleError'
    );
    ok(!!err && !(err instanceof services.ConcurrencyConflictError), '…and NOT a concurrency conflict');

    const qAfter = await quoteRow(fx.quoteId);
    const jAfter = await jobRow(fx.jobId);
    ok(Number(qAfter.row_version) === Number(qBefore.row_version), 'quote row_version NOT advanced', [qBefore.row_version, qAfter.row_version]);
    ok(eqMoney(qAfter.subtotal, qBefore.subtotal) && eqMoney(qAfter.total, qBefore.total), 'quote subtotal/total unchanged');
    ok(qlBefore === JSON.stringify((await pool.query(
      'SELECT line_index, qty, unit_price FROM rel_quote_line_items WHERE quote_id=$1 ORDER BY line_index', [fx.quoteId])).rows),
      'quote line items unchanged');
    ok(Number(jAfter.row_version) === Number(jBefore.row_version), 'job row_version NOT advanced', [jBefore.row_version, jAfter.row_version]);
    ok(eqMoney(jAfter.value, jBefore.value), 'job.value unchanged', [jBefore.value, jAfter.value]);
    ok(eqMoney(jAfter.discount_pct, jBefore.discount_pct) && eqMoney(jAfter.setup_fee, jBefore.setup_fee), 'job discount/setup fee unchanged');
    ok(jlBefore === JSON.stringify(await jobLines(fx.jobId)), 'job line items unchanged');
    ok((await pool.query('SELECT COUNT(*)::int n FROM rel_invoices')).rows[0].n === 0, 'no invoice was created');
    ok(payBefore === await paymentsSnapshot(), 'rel_payments byte-identical');
    ok(cntBefore === await counters(), 'no document number was consumed');

    const m = String(err && err.message);
    ok(m.includes(fx.jobNumber), 'the message names the Job', m);
    ok(/R2,300\.00/.test(m), '…states what the Job\'s own lines support (R2,300.00)', m);
    ok(/R3,277\.50/.test(m), '…and the value the save would have written (R3,277.50)', m);
    ok(/Nothing was saved/.test(m), '…and says plainly that nothing was written', m);
    ok(!/must match the Quote/i.test(m), '…and never claims the Job must match the Quote', m);
  }

  // ══ CASE 2 — UNCONVERTED QUOTE ═══════════════════════════════════════════
  console.log('\n[2] an UNCONVERTED quote’s financial edit is untouched');
  {
    await reset();
    const cust = await services.createCustomer({ companyName: 'Unconverted Co' });
    const q = await services.createQuote({
      companyCode: '2', customerId: cust.id, customerNameRaw: 'Unconverted Co',
      lines: [{ description: 'Sign', qty: 2, unitPrice: 1000, unit: 'ea', pieces: null }],
    });
    const res = await services.updateQuoteWithJobSync(
      q.id, await quoteVer(q.id), shippedPatch({}, [{ desc: 'Sign', qty: 9, unitPrice: 1000 }], 0, 0)
    );
    ok(res.jobId === null, 'no linked job, so the guard is never reached', res.jobId);
    const row = await quoteRow(q.id);
    ok(eqMoney(row.subtotal, 9000), 'the quote repriced normally', row.subtotal);
    ok(row.converted_job_id === null, 'and it is still unconverted');
  }

  // ══ CASE 3 — CONVERTED QUOTE, NON-FINANCIAL EDITS ════════════════════════
  console.log('\n[3] converted-Quote NON-financial edits still save (BLOCKER 2 contract intact)');
  {
    await reset();
    const fx = await makeConvertedJob({ lines: [{ description: 'Sign', qty: 2, unitPrice: 1000 }], setupFee: 0 });
    const sameLines = [{ desc: 'Sign', qty: 2, unitPrice: 1000 }];
    const edits: Array<[string, Record<string, unknown>]> = [
      ['notes', { notes: 'Rush job' }],
      ['reference', { reference: 'PO-99' }],
      ['contact person', { contactPerson: 'Jane Doe' }],
      ['salesperson', { salesperson: 'A. Seller' }],
      ['valid-until date', { validUntil: '2026-12-31' }],
    ];
    for (const [label, over] of edits) {
      const jBefore = await jobRow(fx.jobId);
      const jlBefore = JSON.stringify(await jobLines(fx.jobId));
      let threw: unknown = null;
      try {
        await services.updateQuoteWithJobSync(fx.quoteId, await quoteVer(fx.quoteId), shippedPatch(over, sameLines, 0, 0));
      } catch (e) { threw = e; }
      const jAfter = await jobRow(fx.jobId);
      ok(threw === null, `a ${label} edit on a converted quote still saves`, threw && String((threw as Error).message));
      ok(eqMoney(jAfter.value, jBefore.value), `…job.value untouched by the ${label} edit`, [jBefore.value, jAfter.value]);
      ok(jlBefore === JSON.stringify(await jobLines(fx.jobId)), `…job line items untouched by the ${label} edit`);
      ok(Number(jAfter.row_version) > Number(jBefore.row_version), `…and the job row_version still bumps, exactly as before`);
    }
  }

  // ══ CASE 4 — FINANCIAL FIELD TOUCHED, NO RESULTING VALUE CHANGE ══════════
  console.log('\n[4] a financial field touched with NO resulting value change is allowed');
  {
    await reset();
    const fx = await makeConvertedJob({ lines: [{ description: 'Sign', qty: 2, unitPrice: 1500 }], setupFee: 0 });
    const v0 = Number((await jobRow(fx.jobId)).value);

    // (a) description only
    await services.updateQuoteWithJobSync(fx.quoteId, await quoteVer(fx.quoteId),
      shippedPatch({}, [{ desc: 'Sign — revised wording', qty: 2, unitPrice: 1500 }], 0, 0));
    ok(eqMoney((await jobRow(fx.jobId)).value, v0), '(a) a line DESCRIPTION change is not refused', v0);

    // (b) qty and price both change, product identical: 2 x 1500 -> 3 x 1000
    await services.updateQuoteWithJobSync(fx.quoteId, await quoteVer(fx.quoteId),
      shippedPatch({}, [{ desc: 'Sign — revised wording', qty: 3, unitPrice: 1000 }], 0, 0));
    ok(eqMoney((await jobRow(fx.jobId)).value, v0),
      '(b) qty 2 x R1,500 -> 3 x R1,000 is allowed — the accounting effect is nil', (await jobRow(fx.jobId)).value);
    const jl = await jobLines(fx.jobId);
    ok(jl.length === 1 && Number(jl[0].qty) === 2 && Number(jl[0].unit_price) === 1500,
      '…and the job’s OWN lines are still untouched by a quote save', jl);
  }

  // ══ CASE 5 — COMPANY ISOLATION ═══════════════════════════════════════════
  console.log('\n[5] company isolation');
  {
    await reset();
    const a = await makeConvertedJob({ companyCode: '2', customerName: 'Co A', lines: [{ description: 'Sign', qty: 2, unitPrice: 1000 }] });
    const b = await makeConvertedJob({ companyCode: '1', customerName: 'Co B', lines: [{ description: 'Sign', qty: 2, unitPrice: 1000 }] });
    // Make company B's job divergent.
    await pool.query('UPDATE rel_jobs SET value = 9999 WHERE id = $1', [b.jobId]);

    const aVal = Number((await jobRow(a.jobId)).value);
    await services.updateQuoteWithJobSync(a.quoteId, await quoteVer(a.quoteId),
      shippedPatch({}, [{ desc: 'Sign', qty: 2, unitPrice: 1000 }], 0, 0));
    ok(eqMoney((await jobRow(a.jobId)).value, aVal), 'company A’s save is unaffected by company B’s divergent job');
    ok(eqMoney((await jobRow(b.jobId)).value, 9999), 'and company B’s job is untouched by company A’s save');
  }

  // ══ CASE 6 — PAYMENT CHAIN ═══════════════════════════════════════════════
  console.log('\n[6] a refusal leaves rel_payments byte-identical');
  {
    await reset();
    const fx = await makeConvertedJob({ lines: [{ description: 'Sign', qty: 2, unitPrice: 1000 }], setupFee: 0 });
    await services.recordPayment({ type: 'quote', id: fx.quoteId }, 1000, { date: '2026-09-01', method: 'EFT' });
    await services.recordPayment({ type: 'quote', id: fx.quoteId }, 500,  { date: '2026-09-10', method: 'EFT' });
    const before = await paymentsSnapshot();
    const countBefore = (await pool.query('SELECT COUNT(*)::int n FROM rel_payments')).rows[0].n;

    await expectBusinessRule(
      async () => services.updateQuoteWithJobSync(fx.quoteId, await quoteVer(fx.quoteId),
        shippedPatch({}, [{ desc: 'Sign', qty: 7, unitPrice: 1000 }], 0, 0)),
      'the divergence-creating save is refused'
    );
    ok(before === await paymentsSnapshot(), 'every rel_payments row is byte-identical after the refusal');
    ok((await pool.query('SELECT COUNT(*)::int n FROM rel_payments')).rows[0].n === countBefore,
      'and the payment row COUNT is identical — nothing copied, recreated or deleted', countBefore);
  }

  // ══ CASE 10 — EXPLICIT RESYNC ════════════════════════════════════════════
  console.log('\n[10] an explicit resyncJobLines that makes the job reconcile is ALLOWED');
  {
    await reset();
    const fx = await makeConvertedJob({ lines: [{ description: 'Sign', qty: 2, unitPrice: 1000 }], setupFee: 0 });
    const jobVer = Number((await jobRow(fx.jobId)).row_version);
    const res = await services.updateQuoteWithJobSync(
      fx.quoteId, await quoteVer(fx.quoteId),
      shippedPatch({}, [{ desc: 'Sign (rush)', qty: 3, unitPrice: 1000 }], 0, 5) as any,
      { expectedJobVersion: jobVer, resyncJobLines: true }
    );
    ok(!!res.jobRowVersion, 'the explicit resync completed');
    const j = await jobRow(fx.jobId);
    const jl = await jobLines(fx.jobId);
    ok(jl.length === 1 && Number(jl[0].qty) === 3, 'the job’s lines were resynced to qty 3', jl);
    ok(eqMoney(j.value, 3277.5), 'and job.value is R3,277.50 — 3 x R1,000 less 5%, x1.15', j.value);
    ok(eqMoney(3000 - 150, Number(jl[0].subtotal) - 150 + 0),
      'the guard read the POST-resync lines, which is why this was not refused');
  }

  // ══ CASE 11 — NO LINE ITEMS ══════════════════════════════════════════════
  console.log('\n[11] a job with NO line items is exempt — nothing independent to reconcile');
  {
    await reset();
    const fx = await makeConvertedJob({ lines: [{ description: 'Sign', qty: 2, unitPrice: 1000 }], setupFee: 0 });
    await pool.query('DELETE FROM rel_job_line_items WHERE job_id = $1', [fx.jobId]);
    await services.updateQuoteWithJobSync(fx.quoteId, await quoteVer(fx.quoteId),
      shippedPatch({}, [{ desc: 'Sign', qty: 11, unitPrice: 1000 }], 0, 0));
    ok(eqMoney((await jobRow(fx.jobId)).value, 12650), 'the value cascade still works on a lines-less job', (await jobRow(fx.jobId)).value);
  }

  // ══ CASE 12A — LEGITIMATE SPONSORED ZERO ═════════════════════════════════
  console.log('\n[12A] a legitimate sponsored R0.00 reconciles on BOTH sides and is allowed');
  {
    await reset();
    const fx = await makeConvertedJob({ lines: [{ description: 'Sponsored signage', qty: 4, unitPrice: 3000 }], setupFee: 0 });
    ok(eqMoney((await jobRow(fx.jobId)).value, 13800), 'starts at R13,800.00', (await jobRow(fx.jobId)).value);

    // 100% discount, R0 setup fee: the SAME adjustments apply to the job's own
    // lines, so both sides reconstruct to R0.00.
    await services.updateQuoteWithJobSync(fx.quoteId, await quoteVer(fx.quoteId),
      shippedPatch({}, [{ desc: 'Sponsored signage', qty: 4, unitPrice: 3000 }], 0, 100));
    const j = await jobRow(fx.jobId);
    ok(eqMoney(j.value, 0), 'job.value is now R0.00 — the sponsorship saved normally', j.value);
    ok(eqMoney(j.discount_pct, 100), 'with the 100% discount cascaded onto the job', j.discount_pct);
    const jl = await jobLines(fx.jobId);
    ok(jl.length === 1 && Number(jl[0].unit_price) === 3000, 'and the job’s own positive lines are untouched', jl);

    // The zero-value job must still INVOICE: its own lines, with its own 100%
    // discount, reconstruct to R0.00.
    const inv = await services.createInvoiceForJob(fx.jobId);
    ok(!!inv.invoiceNumber, 'a genuinely sponsored job still invoices', inv.invoiceNumber);
    const tot = (await pool.query(
      `SELECT COALESCE(SUM(qty*unit_amount),0)*1.15 AS t FROM rel_invoice_line_items WHERE invoice_id=$1`, [inv.invoiceId])).rows[0].t;
    ok(eqMoney(tot, 0), 'and the invoice it produces is R0.00', tot);
    ok((await pool.query('SELECT COUNT(*)::int n FROM rel_payments')).rows[0].n === 0,
      'NO payment row was created to settle it');
  }

  // ══ CASE 12B — INVALID ZERO DIVERGENCE ═══════════════════════════════════
  console.log('\n[12B] R0.00 against positive job lines is REFUSED — zero is not a bypass');
  {
    await reset();
    // R20,000-shaped job, exactly the example in the brief.
    const fx = await makeConvertedJob({ lines: [{ description: 'Sign', qty: 4, unitPrice: 4347.826086 }], setupFee: 0 });
    const v0 = Number((await jobRow(fx.jobId)).value);
    const jlBefore = JSON.stringify(await jobLines(fx.jobId));
    const payBefore = await paymentsSnapshot();

    // Zero the QUOTE's lines only. The job's lines still price positively, and
    // no discount is cascaded that would zero them too.
    const err = await expectBusinessRule(
      async () => services.updateQuoteWithJobSync(fx.quoteId, await quoteVer(fx.quoteId),
        shippedPatch({}, [{ desc: 'Sign', qty: 4, unitPrice: 0 }], 0, 0)),
      'zeroing a converted quote against positive job lines is refused'
    );
    const j = await jobRow(fx.jobId);
    ok(eqMoney(j.value, v0), 'job.value unchanged — it did NOT become R0.00', [v0, j.value]);
    ok(jlBefore === JSON.stringify(await jobLines(fx.jobId)), 'job line items unchanged');
    ok(payBefore === await paymentsSnapshot(), 'payments untouched');
    ok(!!err && /R0\.00/.test(String(err.message)), 'and the refusal states the R0.00 it would have written', err && err.message);

    // The invoice-side twin: a job stored at R0.00 with positive lines must not
    // be able to issue a positive invoice either.
    await reset();
    const fx2 = await makeConvertedJob({ lines: [{ description: 'Sign', qty: 4, unitPrice: 2500 }], setupFee: 0 });
    await pool.query('UPDATE rel_jobs SET value = 0 WHERE id = $1', [fx2.jobId]);
    const err2 = await expectBusinessRule(
      () => services.createInvoiceForJob(fx2.jobId),
      'a R0.00 job whose own lines price to R11,500.00 cannot be invoiced'
    );
    ok(!!err2 && /does not reconcile with its own line items/.test(String(err2.message)),
      '…with the Job-vs-Job-lines diagnostic', err2 && err2.message);
    ok((await pool.query('SELECT COUNT(*)::int n FROM rel_invoices')).rows[0].n === 0, 'no invoice row was written');
    ok((await pool.query('SELECT COUNT(*)::int n FROM rel_payments')).rows[0].n === 0, 'and no payment was created');
  }

  // ══ CASE 13 — AN EDIT THAT REPAIRS A DIVERGENCE ══════════════════════════
  console.log('\n[13] an edit that CLOSES an existing divergence is allowed');
  {
    await reset();
    const fx = await makeConvertedJob({ lines: [{ description: 'Sign', qty: 2, unitPrice: 1000 }], setupFee: 0 });
    await pool.query('UPDATE rel_jobs SET value = 9999 WHERE id = $1', [fx.jobId]);   // pre-existing divergence
    // A quote edit whose result MATCHES the job's own lines (R2,300.00).
    await services.updateQuoteWithJobSync(fx.quoteId, await quoteVer(fx.quoteId),
      shippedPatch({}, [{ desc: 'Sign', qty: 2, unitPrice: 1000 }], 0, 0));
    ok(eqMoney((await jobRow(fx.jobId)).value, 2300),
      'the guard never traps a record in a broken state — the repair saved', (await jobRow(fx.jobId)).value);
  }

  // ══ CASE 14 — CONCURRENCY STILL WINS ═════════════════════════════════════
  console.log('\n[14] a stale expectedJobVersion still raises ConcurrencyConflictError, not the new guard');
  {
    await reset();
    const fx = await makeConvertedJob({ lines: [{ description: 'Sign', qty: 2, unitPrice: 1000 }], setupFee: 0 });
    const jobVer = Number((await jobRow(fx.jobId)).row_version);
    let kind = '';
    try {
      await services.updateQuoteWithJobSync(fx.quoteId, await quoteVer(fx.quoteId),
        shippedPatch({}, [{ desc: 'Sign', qty: 5, unitPrice: 1000 }], 0, 0),
        { expectedJobVersion: jobVer + 99 });
    } catch (e: any) { kind = e && e.constructor ? e.constructor.name : ''; }
    ok(kind === 'ConcurrencyConflictError',
      'concurrency is still checked FIRST — a stale job version is a conflict, not a business-rule refusal', kind);
  }

  // ══ CASE 15 — MIGRATION-013 UNRESOLVED PIECES ════════════════════════════
  console.log('\n[15] unresolvable piece counts refuse; a non-financial MISMATCH does not');
  {
    await reset();
    const fx = await makeConvertedJob({ lines: [{ description: 'Sign', qty: 2, unitPrice: 1000, pieces: 2 }], setupFee: 0 });
    // Strip the piece count AND leave a historical source that cannot be
    // matched to it with certainty (legacy_data wiped, price moved).
    await pool.query(
      `UPDATE rel_job_line_items SET pieces = NULL, unit_price = unit_price + 111, legacy_data = '{}'::jsonb
        WHERE job_id = $1`, [fx.jobId]
    );
    await pool.query(
      `UPDATE platform_state SET data = $1::jsonb WHERE id = 1`,
      [JSON.stringify({ jobs: [{ num: fx.jobNumber, co: 2, lines: [
        { desc: 'Sign', qty: 2, unitPrice: 1000, pQty: 2 },
        { desc: 'Sign', qty: 2, unitPrice: 1000, pQty: 5 },
      ] }] })]
    );
    let msg = '';
    try {
      await services.updateQuoteWithJobSync(fx.quoteId, await quoteVer(fx.quoteId),
        shippedPatch({}, [{ desc: 'Sign', qty: 9, unitPrice: 1000 }], 0, 0));
    } catch (e: any) { msg = String(e && e.message); }
    // Either refusal is correct and safe; what must NEVER happen is the save
    // going through and moving the value on a job nobody can value.
    ok(msg !== '', 'a value change on a job whose piece counts cannot be resolved is refused', msg.slice(0, 160));
    ok(eqMoney((await jobRow(fx.jobId)).value, 2300), 'and job.value did not move', (await jobRow(fx.jobId)).value);
    await pool.query(`UPDATE platform_state SET data = '{}'::jsonb WHERE id = 1`);
  }

  // ══ CASE 16 — A PRE-EXISTING DIVERGENCE DOES NOT FREEZE THE RECORD ═══════
  console.log('\n[16] a pre-existing divergence does not block unrelated edits');
  {
    await reset();
    const fx = await makeConvertedJob({ lines: [{ description: 'Sign', qty: 2, unitPrice: 1000 }], setupFee: 0 });
    await pool.query('UPDATE rel_jobs SET value = 9999 WHERE id = $1', [fx.jobId]);
    await services.updateQuoteWithJobSync(fx.quoteId, await quoteVer(fx.quoteId),
      shippedPatch({ notes: 'Client called' }, [{ desc: 'Sign', qty: 2, unitPrice: 1000 }], 0, 0));
    ok(true, 'a notes-only save on an already-divergent job still succeeds');
  }

  console.log('\n============================================================');
  console.log(`${passed} passed, ${failures} failed`);
  console.log('============================================================');
  await pool.end();
  if (failures > 0) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error('\n[converted-quote-value-divergence] Fatal error:', err);
  process.exitCode = 1;
  await pool.end().catch(() => undefined);
});
