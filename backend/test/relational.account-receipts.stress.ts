/**
 * relational.account-receipts.stress.ts — CUSTOMER PAYMENTS ON ACCOUNT
 * (migration 023, 2026-11-26): money received with no quote, job or invoice,
 * spent as payment credit through the customer-credit workflow (022).
 *
 * Disposable *_test database only (TRUNCATEs rel_* document/credit tables and
 * rewrites platform_state.customers). Synthetic data only. Service level — the
 * HTTP routes call exactly these services; permissions are covered end to end
 * by the browser flow.
 */
import pool from '../src/db/pool';
import * as S from '../src/relational/services';
import * as C from '../src/relational/customerCredit';

const url = process.env.DATABASE_URL || '';
const dbName = (url.match(/\/([^/?]+)(\?|$)/) || [])[1] || '';
if (!/_test$/.test(dbName) && process.env.ALLOW_UNSAFE_TEST_DB !== '1') {
  console.error(`[account-receipts] refusing to run: database "${dbName}" is not a *_test database.`);
  process.exit(2);
}
let passed = 0, failed = 0;
function ok(cond: unknown, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''}`); }
}
async function refuses(fn: () => Promise<unknown>, re: RegExp, label: string) {
  try { await fn(); ok(false, label, 'was accepted'); }
  catch (e: any) { ok(re.test(String(e?.message || e)), label, String(e?.message || e).slice(0, 240)); }
}
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;
const CO = '2', HOL = '1';
const actor = { id: 'u-test', email: 'accounts@test.local', role: 'accounts', co: null };
const L = (amt: number) => [{ description: 'Signage', qty: 1, unitAmount: amt, taxType: 'No VAT' }];
let seq = 0; const key = (p: string) => `${p}-${Date.now()}-${++seq}`;
const inv = (ref: string, name: string, amt: number, co = CO) => S.createManualInvoice({ companyCode: co, contactName: name, customerRef: ref, lines: L(amt) });
const credit = (ref: string, co = CO) => C.getCustomerCredit(co, ref);
const acc = async (ref: string, co = CO) => (await credit(ref, co)).paymentCredits.filter((p: any) => p.sourceType === 'account_receipt');
const due = async (id: number | string) => (await C.chainStateTx(pool, 'invoice', Number(id))).outstandingC;
const status = async (id: number | string) => (await q('SELECT status FROM rel_invoices WHERE id = $1', [id]))[0].status;
const receive = (o: any = {}) => C.recordAccountReceipt({ companyCode: CO, customerRef: 'C-NEW', amount: 2000, date: '2026-11-26', method: 'EFT', reference: 'EFT-NEW-2000', actor, ...o });
const apply = (src: number, t: 'invoice' | 'job' | 'quote', id: number | string, amount: unknown, o: any = {}) =>
  C.applyCredit({ sourceType: 'account_receipt', sourceId: src, targetType: t, targetId: Number(id), amount, actor, ...o });

async function main() {
  await pool.query(`TRUNCATE TABLE rel_account_receipts, rel_credit_allocations, rel_credit_refunds, rel_payments, rel_invoice_line_items, rel_invoices,
    rel_job_line_items, rel_jobs, rel_quote_line_items, rel_quotes, rel_credit_notes RESTART IDENTITY CASCADE`);
  await pool.query(`DELETE FROM quote_conversions`); await pool.query(`DELETE FROM document_number_counters`); await pool.query(`DELETE FROM customer_link_audit`);
  const customers = [{ id: 'C-NEW', companyName: 'Fresh Start Signs' }, { id: 'C-OTHER', companyName: 'Other Customer' }, { id: 'C-TWIN1', companyName: 'Twin' }, { id: 'C-TWIN2', companyName: 'Twin' }];
  await pool.query(`INSERT INTO platform_state (id, data) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET data = jsonb_set(COALESCE(platform_state.data,'{}'::jsonb), '{customers}', $2::jsonb)`,
    [JSON.stringify({ customers }), JSON.stringify(customers)]);

  console.log('\n[1] Record R2,000 for a customer with no documents at all');
  ok((await q(`SELECT COUNT(*)::int n FROM rel_invoices`))[0].n === 0, 'no documents exist');
  const k1 = key('acct');
  const r1 = await receive({ clientRequestId: k1 });
  const row = (await q('SELECT * FROM rel_account_receipts WHERE id = $1', [r1.receiptId]))[0];
  ok(row && Number(row.amount) === 2000 && row.customer_ref === 'C-NEW' && row.company_code === CO && row.reference === 'EFT-NEW-2000' && row.method === 'EFT' && row.created_by === 'accounts@test.local',
    'one receipt row: R2,000, customer link, company, method, reference, who', row);
  ok((await q(`SELECT (SELECT COUNT(*) FROM rel_invoices)+(SELECT COUNT(*) FROM rel_jobs)+(SELECT COUNT(*) FROM rel_quotes)+(SELECT COUNT(*) FROM rel_credit_notes)+(SELECT COUNT(*) FROM rel_payments) AS n`))[0].n === '0',
    'no placeholder quote, job, invoice, credit note or payment row was created');
  let cr = await credit('C-NEW');
  ok(cr.totals.paymentCredit === 2000 && cr.totals.total === 2000, 'Customer Credit: R2,000 available payment credit', cr.totals);
  let a = (await acc('C-NEW'))[0];
  ok(a && a.original === 2000 && a.available === 2000 && a.allocated === 0 && a.document === null && a.reference === 'EFT-NEW-2000' && a.date === '2026-11-26', 'listed as a payment on account with its reference and date', a);
  const sum = await C.getCreditSummary([CO]);
  ok(sum.customers.some((c: any) => c.ref === 'C-NEW' && c.paymentCredit === 2000), 'Customer Credits summary shows R2,000 for the customer', sum.customers);
  ok((await C.getCreditSummary([HOL])).customers.every((c: any) => c.ref !== 'C-NEW'), 'not visible in another company');

  console.log('\n[2] Validation');
  await refuses(() => receive({ amount: 0 }), /greater than R0\.00/, 'zero refused');
  await refuses(() => receive({ amount: -5 }), /greater than R0\.00/, 'negative refused');
  await refuses(() => receive({ amount: '10.005' }), /at most 2 decimal/, 'sub-cent refused');
  await refuses(() => receive({ amount: 'abc' }), /number|amount/i, 'malformed refused');
  await refuses(() => receive({ reference: '  ' }), /reference/, 'missing reference refused');
  await refuses(() => receive({ date: null }), /payment date/i, 'missing date refused');
  await refuses(() => receive({ date: '2026-13-40' }), /date/i, 'invalid date refused');
  await refuses(() => receive({ method: '' }), /payment method/, 'missing method refused');
  await refuses(() => receive({ customerRef: null }), /Choose the customer/, 'missing customer refused');
  await refuses(() => receive({ customerRef: 'C-NOPE' }), /no longer exists|Choose an existing customer/, 'unknown customer refused');
  await refuses(() => receive({ companyCode: '' }), /company/, 'missing company refused');
  ok((await q(`SELECT COUNT(*)::int n FROM rel_account_receipts`))[0].n === 1, 'nothing extra was recorded');

  console.log('\n[3] Duplicate submissions');
  const again = await receive({ clientRequestId: k1 });
  ok(again.deduplicated && again.receiptId === r1.receiptId, 'the same request again returns the same receipt');
  const kp = key('par');
  const par = await Promise.allSettled([1, 2, 3].map(() => receive({ amount: 50, reference: 'PAR', clientRequestId: kp })));
  const ids = par.filter((x) => x.status === 'fulfilled').map((x: any) => x.value.receiptId);
  ok(ids.length === 3 && new Set(ids).size === 1, 'three simultaneous copies = one receipt', par.map((x: any) => x.status));
  await C.voidAccountReceipt(ids[0], { actor, reason: 'test' });

  console.log('\n[4] Later: a R1,500 invoice, paid with R1,500 of the payment on account');
  const i1 = await inv('C-NEW', 'Fresh Start Signs', 1500);
  await refuses(() => apply(r1.receiptId, 'invoice', i1.id, 1600), /more than the R1500\.00 still due/, 'more than the invoice balance refused');
  const al1 = await apply(r1.receiptId, 'invoice', i1.id, 1500, { clientRequestId: key('al1') });
  ok(await status(i1.id) === 'paid' && await due(i1.id) === 0, 'invoice is paid');
  a = (await acc('C-NEW'))[0];
  ok(a.available === 500 && a.allocated === 1500 && a.original === 2000, 'R500 remains; the R2,000 receipt is unchanged and traceable', a);
  const led = (await q('SELECT * FROM rel_payments WHERE id = $1', [al1.targetPaymentId]))[0];
  ok(led.entry_kind === 'payment_credit_in' && Number(led.amount) === 1500 && led.reference === 'EFT-NEW-2000' && /payment on account received 2026-11-26/.test(led.notes),
    'invoice carries one "Payment credit" entry with the receipt reference and date', { kind: led.entry_kind, ref: led.reference, notes: led.notes });
  ok((await q(`SELECT COUNT(*)::int n FROM rel_payments WHERE entry_kind = 'receipt'`))[0].n === 0, 'no second receipt was created on the invoice (money counted once)');
  ok(a.history.length === 1 && a.history[0].targetNumber === i1.invoiceNumber && a.history[0].amount === 1500, 'allocation history links the receipt to the invoice', a.history);

  console.log('\n[5] Reverse the allocation');
  await C.reverseCreditAllocation(al1.allocationId, { actor, reason: 'test' });
  a = (await acc('C-NEW'))[0];
  ok(a.available === 2000 && await due(i1.id) === 150000, 'credit back to R2,000; invoice owes R1,500 again', { avail: a.available, due: await due(i1.id) });
  ok((await q('SELECT status FROM rel_credit_allocations WHERE id = $1', [al1.allocationId]))[0].status === 'reversed', 'allocation kept as reversed (audit)');

  console.log('\n[6] Multiple allocations (invoice, job, quote), caps');
  await apply(r1.receiptId, 'invoice', i1.id, 1000);
  const qt = await S.createQuote({ companyCode: CO, customerNameRaw: 'Fresh Start Signs', customerRef: 'C-NEW', lines: [{ description: 'Sign', qty: 1, unitPrice: 600 }] } as any);
  const alQ = await apply(r1.receiptId, 'quote', qt.id, 300);
  ok(!!alQ.allocationId, 'applied R300 to a quote (deposit)');
  const qt2 = await S.createQuote({ companyCode: CO, customerNameRaw: 'Fresh Start Signs', customerRef: 'C-NEW', lines: [{ description: 'Job sign', qty: 1, unitPrice: 800 }] } as any);
  const conv = await S.convertQuoteToJob(Number(qt2.id));
  await apply(r1.receiptId, 'job', conv.jobId, 200);
  a = (await acc('C-NEW'))[0];
  ok(a.available === 500 && a.allocated === 1500 && a.history.filter((h: any) => h.status === 'active').length === 3, 'R1,000 + R300 + R200 allocated across three documents; R500 left', a);
  const iBig = await inv('C-NEW', 'Fresh Start Signs', 900);
  await refuses(() => apply(r1.receiptId, 'invoice', iBig.id, 501), /R500\.00 available/, 'more than the receipt has left refused (invoice owes R900)');

  console.log('\n[7] Simultaneous allocations cannot double-spend');
  const i2 = await inv('C-NEW', 'Fresh Start Signs', 400); const i3 = await inv('C-NEW', 'Fresh Start Signs', 400);
  const race = await Promise.allSettled([i2, i3].map((x) => apply(r1.receiptId, 'invoice', x.id, 400, { clientRequestId: key('race') })));
  ok(race.filter((x) => x.status === 'fulfilled').length === 1, 'two R400 allocations from R500 at once: exactly one succeeds', race.map((x: any) => x.status + (x.reason ? ':' + x.reason.message : '')));
  ok((await acc('C-NEW'))[0].available === 100, 'R100 left');
  const kr = key('rep');
  const reps = await Promise.allSettled([1, 2, 3].map(() => apply(r1.receiptId, 'invoice', i1.id, 50, { clientRequestId: kr })));
  const repIds = reps.filter((x) => x.status === 'fulfilled').map((x: any) => x.value.allocationId);
  ok(repIds.length === 3 && new Set(repIds).size === 1 && (await acc('C-NEW'))[0].available === 50, 'a retried allocation (same key, 3 copies) is recorded once');

  console.log('\n[8] Company and customer isolation');
  const iHol = await inv('C-NEW', 'Fresh Start Signs', 100, HOL);
  await refuses(() => apply(r1.receiptId, 'invoice', iHol.id, 10), /another company/, 'cannot be used in another company');
  const iOther = await inv('C-OTHER', 'Other Customer', 100);
  await refuses(() => apply(r1.receiptId, 'invoice', iOther.id, 10), /Credit can only be used by the customer who paid it/, 'cannot be used for another customer');

  console.log('\n[9] Refund (recorded only)');
  await refuses(() => C.recordCreditRefund({ sourceType: 'account_receipt', sourceId: r1.receiptId, amount: 20, date: '2026-11-27', method: 'EFT', reference: '', actor } as any), /reference/, 'reference required');
  await refuses(() => C.recordCreditRefund({ sourceType: 'account_receipt', sourceId: r1.receiptId, amount: 60, date: '2026-11-27', method: 'EFT', reference: 'RF-1', actor } as any), /R50\.00 available to refund/, 'cannot refund more than is available');
  const kf = key('rf');
  const rf = await C.recordCreditRefund({ sourceType: 'account_receipt', sourceId: r1.receiptId, amount: 30, date: '2026-11-27', method: 'EFT', reference: 'RF-1', clientRequestId: kf, actor } as any);
  const rf2 = await C.recordCreditRefund({ sourceType: 'account_receipt', sourceId: r1.receiptId, amount: 30, date: '2026-11-27', method: 'EFT', reference: 'RF-1', clientRequestId: kf, actor } as any);
  a = (await acc('C-NEW'))[0];
  ok(rf2.deduplicated && a.available === 20 && a.refunded === 30, 'refund of R30 recorded once; R20 left', a);
  ok((await q(`SELECT COUNT(*)::int n FROM rel_payments WHERE entry_kind = 'refund'`))[0].n === 0, 'a refund of a payment on account adds no document entry (nothing to double count)');
  await C.reverseCreditRefund(rf.refundId, { actor });
  ok((await acc('C-NEW'))[0].available === 50, 'reversing the refund restores R50');

  console.log('\n[10] Rollback: a failure mid-allocation leaves nothing behind');
  const before = (await acc('C-NEW'))[0];
  await pool.query(`CREATE OR REPLACE FUNCTION acct_fail() RETURNS trigger AS $$ BEGIN IF NEW.entry_kind = 'payment_credit_in' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
  await pool.query(`CREATE TRIGGER acct_fail BEFORE INSERT ON rel_payments FOR EACH ROW EXECUTE FUNCTION acct_fail()`);
  await refuses(() => apply(r1.receiptId, 'invoice', i1.id, 10), /synthetic failure/, 'allocation fails');
  await pool.query(`DROP TRIGGER acct_fail ON rel_payments`); await pool.query(`DROP FUNCTION acct_fail()`);
  const after = (await acc('C-NEW'))[0];
  ok(after.available === before.available && after.history.length === before.history.length, 'no allocation record and no credit used', { before: before.available, after: after.available });

  console.log('\n[11] Source edits, customer change and void follow the allocation safeguards');
  let rv = (await q('SELECT row_version FROM rel_account_receipts WHERE id = $1', [r1.receiptId]))[0].row_version;
  await refuses(() => C.updateAccountReceipt(r1.receiptId, rv, { amount: 2500 }, actor), /cannot be changed/, 'amount cannot change while allocated');
  await refuses(() => C.updateAccountReceipt(r1.receiptId, rv, { customerRef: 'C-OTHER' }, actor), /cannot be changed/, 'customer cannot change once it has provided credit');
  await refuses(() => C.updateAccountReceipt(r1.receiptId, rv, { companyCode: HOL }, actor), /company .* cannot be changed/, 'company never changes');
  await refuses(() => C.voidAccountReceipt(r1.receiptId, { actor }), /Reverse those first/, 'cannot void while allocated');
  const ed = await C.updateAccountReceipt(r1.receiptId, rv, { reference: 'EFT-NEW-2000 (corrected)' }, actor);
  ok((await q('SELECT reference FROM rel_account_receipts WHERE id = $1', [r1.receiptId]))[0].reference === 'EFT-NEW-2000 (corrected)', 'reference correction is allowed');
  await refuses(() => C.updateAccountReceipt(r1.receiptId, rv, { notes: 'x' }, actor), /changed by someone else/, 'stale edit refused (row version)');
  void ed;
  const r2 = await receive({ amount: 300, reference: 'WRONG-CUST' });
  rv = (await q('SELECT row_version FROM rel_account_receipts WHERE id = $1', [r2.receiptId]))[0].row_version;
  await C.updateAccountReceipt(r2.receiptId, rv, { customerRef: 'C-OTHER' }, actor);
  const au = await q(`SELECT * FROM customer_link_audit WHERE members @> $1::jsonb`, [JSON.stringify([{ type: 'account_receipt', id: r2.receiptId }])]);
  ok((await acc('C-OTHER'))[0]?.available === 300 && au.length === 1 && au[0].to_ref === 'C-OTHER', 'an unused receipt can be moved to the right customer (audited)', au);
  rv = (await q('SELECT row_version FROM rel_account_receipts WHERE id = $1', [r2.receiptId]))[0].row_version;
  await C.voidAccountReceipt(r2.receiptId, { expectedVersion: rv, actor, reason: 'recorded in error' });
  ok((await acc('C-OTHER')).length === 0 && (await q('SELECT status FROM rel_account_receipts WHERE id = $1', [r2.receiptId]))[0].status === 'voided', 'void: kept as voided, no longer credit');
  await refuses(() => apply(r2.receiptId, 'invoice', iOther.id, 10), /voided/, 'a voided receipt cannot be used');
  ok((await C.listAccountReceipts([CO])).every((x: any) => x.sourceId !== r2.receiptId), 'voided receipt is not listed for statements / cash received');

  console.log('\n[12] Deleting the "Payment credit" entry on the invoice reverses that allocation');
  const pc = (await q(`SELECT * FROM rel_payments WHERE owner_type='invoice' AND owner_id=$1 AND entry_kind='payment_credit_in' ORDER BY id DESC LIMIT 1`, [i1.id]))[0];
  const availBefore = (await acc('C-NEW'))[0].available;
  await S.deletePayment(Number(pc.id), pc.row_version, { actor } as any);
  ok((await acc('C-NEW'))[0].available === availBefore + Number(pc.amount), 'its amount is available again', { before: availBefore, amount: pc.amount });
  await refuses(async () => { const inv0 = (await q('SELECT row_version FROM rel_invoices WHERE id=$1', [i2.id]))[0]; await S.deleteInvoice(Number(i2.id), inv0.row_version); }, /credit|cannot be deleted/i, 'an invoice holding applied credit cannot be deleted');

  console.log('\n[13] Cash received lists the receipt once, including unallocated');
  const listed = await C.listAccountReceipts([CO]);
  ok(listed.filter((x: any) => x.sourceId === r1.receiptId).length === 1 && listed.find((x: any) => x.sourceId === r1.receiptId).original === 2000, 'listed once at its full R2,000');

  await pool.query('TRUNCATE TABLE rel_account_receipts, rel_credit_allocations, rel_credit_refunds RESTART IDENTITY');
  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}
main().catch(async (e) => { console.error('[account-receipts] Fatal error:', e); await pool.end().catch(() => undefined); process.exit(1); });
