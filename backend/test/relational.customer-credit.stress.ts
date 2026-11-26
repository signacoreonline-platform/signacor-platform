/**
 * relational.customer-credit.stress.ts — CUSTOMER PAYMENT CREDIT, CREDIT-NOTE
 * ALLOCATIONS AND RECORDED REFUNDS (migration 022, 2026-11-26).
 *
 * Runs against a DISPOSABLE database only: DATABASE_URL must name a database
 * whose name ends in _test (or ALLOW_UNSAFE_TEST_DB=1). It TRUNCATEs the rel_*
 * credit/payment tables and rewrites platform_state.customers with synthetic
 * customers. Synthetic data only.
 *
 *   npx ts-node --transpile-only test/relational.customer-credit.stress.ts
 *
 * Every confirmed defect from claude/overpayment-credit-audit-2026-11-26.md has
 * a regression check here (D1–D5, D7), plus the new workflow end to end.
 */
import pool from '../src/db/pool';
import * as S from '../src/relational/services';
import * as C from '../src/relational/customerCredit';
import { previewCustomerReassignment } from '../src/relational/customerLinks';

const url = process.env.DATABASE_URL || '';
const dbName = (url.match(/\/([^/?]+)(\?|$)/) || [])[1] || '';
if (!/_test$/.test(dbName) && process.env.ALLOW_UNSAFE_TEST_DB !== '1') {
  console.error(`[customer-credit] refusing to run: database "${dbName}" is not a *_test database.`);
  process.exit(2);
}

let passed = 0, failed = 0;
function ok(cond: unknown, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}
async function refuses(fn: () => Promise<unknown>, re: RegExp, label: string) {
  try { await fn(); ok(false, label, 'was accepted'); }
  catch (e: any) { ok(re.test(String(e?.message || e)), label, String(e?.message || e).slice(0, 200)); }
}
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;
const L = (d: string, amt: number) => [{ description: d, qty: 1, unitAmount: amt, taxType: 'No VAT' }];
const CO = '2', HOL = '1';
const actor = { id: 'u-test', email: 'accounts@test.local', role: 'accounts', co: null };
let seq = 0;
const key = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function pay(t: 'invoice' | 'job' | 'quote', id: number, amount: unknown, o: any = {}) {
  return S.recordPayment({ type: t, id: Number(id) }, amount as any, { date: o.date || '2026-12-01', method: o.method || 'EFT', reference: o.reference || null, clientRequestId: o.key || null, creditNoteId: o.creditNoteId ?? null, actor });
}
async function inv(name: string, amt: number, ref: string | null, co = CO) {
  return S.createManualInvoice({ companyCode: co, contactName: name, customerRef: ref, lines: L('Signage', amt) });
}
async function invState(id: number | string) { return C.chainStateTx(pool, 'invoice', Number(id)); }
async function status(id: number | string) { return (await q('SELECT status FROM rel_invoices WHERE id = $1', [id]))[0].status; }
async function credit(ref: string, co = CO) { return C.getCustomerCredit(co, ref); }

async function reset() {
  await pool.query(`TRUNCATE TABLE rel_credit_allocations, rel_credit_refunds, rel_payments, rel_invoice_line_items, rel_invoices,
    rel_job_line_items, rel_jobs, rel_quote_line_items, rel_quotes, rel_credit_notes RESTART IDENTITY CASCADE`);
  await pool.query(`DELETE FROM quote_conversions`);
  await pool.query(`DELETE FROM document_number_counters`);
  const customers = [
    { id: 'C-ALPHA', companyName: 'Synth Alpha (Pty) Ltd' },
    { id: 'C-BRAVO', companyName: 'Synth Bravo' },
    { id: 'C-DUP1', companyName: 'Synth Twin' },
    { id: 'C-DUP2', companyName: 'Synth Twin' },
    { id: 'C-LEGACY', companyName: 'Synth Legacy Ltd' },
    { id: 'C-RENAMED', companyName: 'Synth New Name', formerNames: ['Synth Old Name'] },
  ];
  await pool.query(`INSERT INTO platform_state (id, data) VALUES (1, $1::jsonb)
    ON CONFLICT (id) DO UPDATE SET data = jsonb_set(platform_state.data, '{customers}', $2::jsonb)`, [JSON.stringify({ customers }), JSON.stringify(customers)]);
}

async function main() {
  await reset();

  console.log('\n[1] Exact, partial and over-payment of new receipts');
  const exact = await inv('Synth Alpha (Pty) Ltd', 1000, 'C-ALPHA');
  await pay('invoice', exact.id, 1000);
  ok(await status(exact.id) === 'paid', 'exact payment: invoice paid');
  const part = await inv('Synth Alpha (Pty) Ltd', 1000, 'C-ALPHA');
  await pay('invoice', part.id, 400);
  ok(await status(part.id) === 'partial' && (await invState(part.id)).outstandingC === 60000, 'partial payment: R600 still due');
  let cr = await credit('C-ALPHA');
  ok(cr.totals.paymentCredit === 0, 'no payment credit from exact/partial payments', cr.totals);
  const over = await inv('Synth Alpha (Pty) Ltd', 1000, 'C-ALPHA');
  const rcpt = await pay('invoice', over.id, 1200, { reference: 'EFT-ALPHA-1200' });
  ok(await status(over.id) === 'paid', 'overpayment: invoice settled');
  const rcptRow = (await q('SELECT * FROM rel_payments WHERE id = $1', [rcpt.paymentId]))[0];
  ok(rcptRow.entry_kind === 'receipt' && rcptRow.credit_eligible === true && Number(rcptRow.amount) === 1200 && rcptRow.reference === 'EFT-ALPHA-1200', 'receipt stored once, original amount/reference kept, marked eligible');
  ok((await q(`SELECT COUNT(*)::int n FROM rel_credit_notes`))[0].n === 0, 'no credit note is created automatically');
  cr = await credit('C-ALPHA');
  ok(cr.totals.paymentCredit === 200 && cr.paymentCredits.length === 1 && cr.paymentCredits[0].original === 1200 && cr.paymentCredits[0].available === 200, 'R200 shows as available payment credit (receipt R1,200)', cr.paymentCredits);

  console.log('\n[2] Applying, partial allocation, several targets, reversal');
  const b = await inv('Synth Alpha (Pty) Ltd', 150, 'C-ALPHA');
  const c2 = await inv('Synth Alpha (Pty) Ltd', 500, 'C-ALPHA');
  await refuses(() => C.applyCredit({ sourceType: 'payment', sourceId: Number(rcpt.paymentId), targetType: 'invoice', targetId: Number(b.id), amount: 160, actor }), /more than the R150\.00 still due/, 'allocation above the invoice balance refused (D3)');
  await refuses(() => C.applyCredit({ sourceType: 'payment', sourceId: Number(rcpt.paymentId), targetType: 'invoice', targetId: Number(c2.id), amount: 250, actor }), /R200\.00 of payment credit available/, 'allocation above available credit refused');
  const a1 = await C.applyCredit({ sourceType: 'payment', sourceId: Number(rcpt.paymentId), targetType: 'invoice', targetId: Number(b.id), amount: 150, actor, clientRequestId: key('a1') });
  const a2 = await C.applyCredit({ sourceType: 'payment', sourceId: Number(rcpt.paymentId), targetType: 'invoice', targetId: Number(c2.id), amount: 50, actor });
  ok(await status(b.id) === 'paid' && await status(c2.id) === 'partial', 'R150 settles B; R50 part-pays C');
  ok(await status(over.id) === 'paid' && (await invState(over.id)).paidC === 100000, 'source invoice still paid at exactly R1,000');
  cr = await credit('C-ALPHA');
  ok(cr.totals.paymentCredit === 0 && cr.paymentCredits[0].allocated === 200, 'credit fully allocated (R200 allocated, R0 left)', cr.paymentCredits[0]);
  ok(cr.paymentCredits[0].history.filter((h: any) => h.kind === 'allocation').length === 2, 'allocation history lists both uses');
  const totalReceived = (await q(`SELECT COALESCE(SUM(amount),0) s FROM rel_payments WHERE entry_kind = 'receipt'`))[0].s;
  const net = (await q(`SELECT COALESCE(SUM(amount),0) s FROM rel_payments`))[0].s;
  ok(Number(totalReceived) === Number(net), 'money counted once: ledger pairs net to zero, total = receipts only', { totalReceived, net });
  await refuses(async () => { const p = (await q('SELECT row_version FROM rel_payments WHERE id=$1', [rcpt.paymentId]))[0]; await S.deletePayment(Number(rcpt.paymentId), p.row_version); }, /cannot be deleted/, 'receipt with allocations cannot be deleted');
  await refuses(async () => { const p = (await q('SELECT row_version FROM rel_payments WHERE id=$1', [rcpt.paymentId]))[0]; await S.updatePayment(Number(rcpt.paymentId), p.row_version, { amount: 1100 }); }, /cannot be changed/, 'receipt with allocations cannot change amount');
  const inRow = (await q(`SELECT * FROM rel_payments WHERE id = $1`, [a1.targetPaymentId]))[0];
  await refuses(() => S.updatePayment(Number(inRow.id), inRow.row_version, { amount: 10 }), /cannot be edited/, 'payment-credit entry cannot be edited');
  await C.reverseCreditAllocation(a2.allocationId, { reason: 'test', actor });
  ok((await invState(c2.id)).outstandingC === 50000 && (await credit('C-ALPHA')).totals.paymentCredit === 50, 'reversal restores R50 credit and C balance (R500 due again)');
  // deleting the + entry from a payment window reverses the whole allocation
  await S.deletePayment(Number(inRow.id), inRow.row_version, { actor });
  ok((await q(`SELECT COUNT(*)::int n FROM rel_payments WHERE credit_link_id = $1`, [a1.allocationId]))[0].n === 0, 'deleting the applied-credit entry removes both sides');
  ok((await q(`SELECT status FROM rel_credit_allocations WHERE id = $1`, [a1.allocationId]))[0].status === 'reversed', 'allocation record kept as reversed (audit)');
  ok((await credit('C-ALPHA')).totals.paymentCredit === 200, 'all R200 available again');

  console.log('\n[3] Retries and concurrency');
  const k = key('replay');
  const reps = await Promise.allSettled([1, 2, 3].map(() => C.applyCredit({ sourceType: 'payment', sourceId: Number(rcpt.paymentId), targetType: 'invoice', targetId: Number(b.id), amount: 100, clientRequestId: k, actor })));
  const okReps = reps.filter((r) => r.status === 'fulfilled').map((r: any) => r.value.allocationId);
  ok(okReps.length === 3 && new Set(okReps).size === 1, 'same request sent 3 times = one allocation', reps.map((r) => r.status));
  ok((await credit('C-ALPHA')).totals.paymentCredit === 100, 'credit spent once (R100 left)');
  await C.reverseCreditAllocation(okReps[0], { actor });
  const d1 = await inv('Synth Alpha (Pty) Ltd', 150, 'C-ALPHA');
  const d2 = await inv('Synth Alpha (Pty) Ltd', 150, 'C-ALPHA');
  const race = await Promise.allSettled([
    C.applyCredit({ sourceType: 'payment', sourceId: Number(rcpt.paymentId), targetType: 'invoice', targetId: Number(d1.id), amount: 150, clientRequestId: key('r1'), actor }),
    C.applyCredit({ sourceType: 'payment', sourceId: Number(rcpt.paymentId), targetType: 'invoice', targetId: Number(d2.id), amount: 150, clientRequestId: key('r2'), actor }),
  ]);
  ok(race.filter((r) => r.status === 'fulfilled').length === 1 && race.filter((r) => r.status === 'rejected').length === 1, 'two concurrent R150 allocations from R200: exactly one succeeds', race.map((r: any) => r.status + (r.reason ? ':' + r.reason.message : '')));
  ok((await credit('C-ALPHA')).totals.paymentCredit === 50, 'R50 left after the race');
  for (const a of await q(`SELECT id FROM rel_credit_allocations WHERE status='active'`)) await C.reverseCreditAllocation(Number(a.id), { actor });

  console.log('\n[4] Transaction rollback');
  await pool.query(`CREATE OR REPLACE FUNCTION audit_fail_in() RETURNS trigger AS $$ BEGIN IF NEW.entry_kind = 'payment_credit_in' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
  await pool.query(`CREATE TRIGGER audit_fail_in BEFORE INSERT ON rel_payments FOR EACH ROW EXECUTE FUNCTION audit_fail_in()`);
  const before = (await q(`SELECT COUNT(*)::int n FROM rel_payments`))[0].n;
  await refuses(() => C.applyCredit({ sourceType: 'payment', sourceId: Number(rcpt.paymentId), targetType: 'invoice', targetId: Number(d1.id), amount: 50, actor }), /synthetic failure/, 'a failure mid-allocation is reported');
  await pool.query(`DROP TRIGGER audit_fail_in ON rel_payments`); await pool.query(`DROP FUNCTION audit_fail_in()`);
  ok((await q(`SELECT COUNT(*)::int n FROM rel_payments`))[0].n === before && (await q(`SELECT COUNT(*)::int n FROM rel_credit_allocations WHERE status='active'`))[0].n === 0, 'nothing half-written: no offset row, no allocation');

  console.log('\n[5] Recorded refunds');
  await refuses(() => C.recordCreditRefund({ sourceType: 'payment', sourceId: Number(rcpt.paymentId), amount: 80, reference: '', actor }), /reference/, 'refund needs a reference');
  await refuses(() => C.recordCreditRefund({ sourceType: 'payment', sourceId: Number(rcpt.paymentId), amount: 250, reference: 'EFT-OUT-1', actor }), /R200\.00 of payment credit available to refund/, 'refund above available refused');
  const rf = await C.recordCreditRefund({ sourceType: 'payment', sourceId: Number(rcpt.paymentId), amount: 80, date: '2026-12-03', method: 'EFT', reference: 'EFT-OUT-1', actor, clientRequestId: key('rf') });
  cr = await credit('C-ALPHA');
  ok(cr.totals.paymentCredit === 120 && cr.paymentCredits[0].refunded === 80, 'refund reduces available credit to R120', cr.paymentCredits[0]);
  ok(await status(over.id) === 'paid', 'source invoice remains paid after the refund');
  const refundRow = (await q(`SELECT * FROM rel_payments WHERE entry_kind = 'refund'`))[0];
  ok(refundRow && Number(refundRow.amount) === -80 && refundRow.reference === 'EFT-OUT-1', 'refund ledger row keeps its reference');
  await C.reverseCreditRefund(rf.refundId, { actor, reason: 'recorded in error' });
  ok((await credit('C-ALPHA')).totals.paymentCredit === 200, 'reversing the refund restores R200');

  console.log('\n[6] Quote deposit carried into job and invoice; payment on job after invoicing');
  const qt = await S.createQuote({ companyCode: CO, customerNameRaw: 'Synth Bravo', customerRef: 'C-BRAVO', lines: [{ description: 'Sign', qty: 1, unitPrice: 1000 }] });
  await pay('quote', qt.id, 800, { reference: 'DEP-1' });
  const conv = await S.convertQuoteToJob(Number(qt.id));
  const ji = await S.createInvoiceForJob(Number(conv.jobId));
  let st = await C.chainStateTx(pool, 'invoice', Number(ji.invoiceId));
  ok(st.paidC === 80000 && st.outstandingC === 35000, 'deposit counted once on the invoice (R1,150 − R800 = R350)', { paid: st.paidC, out: st.outstandingC });
  await pay('job', Number(conv.jobId), 500, { reference: 'JOB-EFT' });
  st = await C.chainStateTx(pool, 'invoice', Number(ji.invoiceId));
  ok(st.paidC === 130000 && st.excessC === 15000, 'payment on the job after invoicing: R150 over', st);
  ok((await credit('C-BRAVO')).totals.paymentCredit === 150, 'R150 payment credit, attributed to the latest receipt');

  console.log('\n[7] Transition: historical apparent excess stays out of the pool');
  const old = await inv('Synth Legacy Ltd', 1000, 'C-LEGACY');
  // two historical rows (as migrated/re-captured before 022): entry_kind NULL, not eligible
  await pool.query(`INSERT INTO rel_payments (source_id, owner_type, owner_id, line_index, amount, payment_date, method) VALUES ('h1','invoice',$1,0,1000,'2026-08-20','EFT'),('h2','invoice',$1,1,1000,'2026-08-20','EFT')`, [old.id]);
  ok((await credit('C-LEGACY')).totals.paymentCredit === 0, 'R1,000 of apparent historical excess is NOT spendable');
  const old2 = await inv('Synth Legacy Ltd', 1000, 'C-LEGACY');
  await pool.query(`INSERT INTO rel_payments (source_id, owner_type, owner_id, line_index, amount, payment_date, method) VALUES ('h3','invoice',$1,0,700,'2026-09-01','EFT')`, [old2.id]);
  await pay('invoice', old2.id, 500, { reference: 'NEW-ON-OLD' });
  ok((await credit('C-LEGACY')).totals.paymentCredit === 200, 'older invoice + new R500 payment: only the R200 above the R300 due becomes credit');
  await pay('invoice', old.id, 60, { reference: 'NEW-ON-OVERPAID' });
  ok((await credit('C-LEGACY')).totals.paymentCredit === 260, 'new money on an already over-recorded invoice: only that new R60 is credit');

  console.log('\n[8] Credit notes: existing ones stay usable, under company + customer rules');
  // a historical unlinked note (exact unique name) and a linked one
  await pool.query(`INSERT INTO rel_credit_notes (source_id, credit_number, note_type, contact_name_raw, note_date, amount, used_amount, company_code) VALUES ('cn-h','CN-H01','customer','Synth Legacy Ltd','2026-07-01',300,0,'2')`);
  const cnL = await S.createCreditNote({ companyCode: CO, type: 'customer', contactName: 'Synth Legacy Ltd', customerRef: 'C-LEGACY', amount: 200, date: '2026-10-01' });
  cr = await credit('C-LEGACY');
  ok(cr.totals.creditNotes === 500 && cr.totals.total === 760, 'payment credit (R260) and credit notes (R500) shown together = R760', cr.totals);
  const t1 = await inv('Synth Legacy Ltd', 400, 'C-LEGACY');
  const cp = await pay('invoice', t1.id, 350, { method: 'Credit' });
  const cpAllocs = await q(`SELECT * FROM rel_credit_allocations WHERE target_payment_id = $1 ORDER BY id`, [cp.paymentId]);
  ok(cpAllocs.length === 2 && Number(cpAllocs[0].amount) === 300 && Number(cpAllocs[1].amount) === 50, 'Credit payment funded oldest-first, each note recorded (R300 CN-H01 + R50)', cpAllocs.map((a) => a.amount));
  await refuses(() => pay('invoice', t1.id, 60, { method: 'Credit' }), /more than the R50\.00 still due/, 'Credit above the balance refused (D3)');
  const cpRow = (await q('SELECT row_version FROM rel_payments WHERE id = $1', [cp.paymentId]))[0];
  const del = await S.deletePayment(Number(cp.paymentId), cpRow.row_version, { actor });
  const notesAfter = await q(`SELECT credit_number, used_amount FROM rel_credit_notes ORDER BY id`);
  ok(del.creditReleased === 350 && notesAfter.every((n) => Number(n.used_amount) === 0), 'deleting it returns R300 + R50 to exactly those notes (D2)', notesAfter);
  const ca = await C.applyCredit({ sourceType: 'credit_note', sourceId: Number(cnL.id), targetType: 'invoice', targetId: Number(t1.id), amount: 120, actor });
  ok((await q('SELECT used_amount FROM rel_credit_notes WHERE id=$1', [cnL.id]))[0].used_amount == 120, 'a chosen credit note funds an allocation');
  await refuses(async () => S.updateCreditNote(Number(cnL.id), Number((await q('SELECT row_version FROM rel_credit_notes WHERE id=$1', [cnL.id]))[0].row_version), { amount: 100 }), /cannot be reduced below/, 'credit note amount cannot drop below what it provided');
  await refuses(async () => S.updateCreditNote(Number(cnL.id), Number((await q('SELECT row_version FROM rel_credit_notes WHERE id=$1', [cnL.id]))[0].row_version), { customerRef: 'C-BRAVO' }), /customer cannot be changed/, 'used credit note cannot move to another customer');
  await refuses(async () => S.deleteCreditNote(Number(cnL.id), Number((await q('SELECT row_version FROM rel_credit_notes WHERE id=$1', [cnL.id]))[0].row_version)), /active allocation|already applied/, 'credit note funding an active allocation cannot be deleted');
  await C.reverseCreditAllocation(ca.allocationId, { actor });
  const cnRef = await C.recordCreditRefund({ sourceType: 'credit_note', sourceId: Number(cnL.id), amount: 50, reference: 'EFT-CN-REFUND', actor });
  ok((await credit('C-LEGACY')).creditNotes.find((n: any) => n.number === (cnL as any).creditNumber)?.available === 150, 'credit-note refund reduces that note to R150');
  await C.reverseCreditRefund(cnRef.refundId, { actor });

  console.log('\n[9] Company and customer isolation (D1)');
  await S.createCreditNote({ companyCode: HOL, type: 'customer', contactName: 'Synth Bravo', customerRef: 'C-BRAVO', amount: 700, date: '2026-10-01' });
  const bInv = await inv('Synth Bravo', 700, 'C-BRAVO');
  await refuses(() => pay('invoice', bInv.id, 700, { method: 'Credit' }), /only has R0\.00 of unused credit-note credit in this company/, 'Holdings credit note cannot pay a Signacore invoice');
  const holInv = await inv('Synth Bravo', 100, 'C-BRAVO', HOL);
  const bravoRcpt = (await q(`SELECT id FROM rel_payments WHERE reference = 'JOB-EFT'`))[0].id;
  await refuses(() => C.applyCredit({ sourceType: 'payment', sourceId: Number(bravoRcpt), targetType: 'invoice', targetId: Number(holInv.id), amount: 50, actor }), /another company/, 'Signacore payment credit cannot go to a Holdings invoice');
  await refuses(() => C.applyCredit({ sourceType: 'payment', sourceId: Number(rcpt.paymentId), targetType: 'invoice', targetId: Number(bInv.id), amount: 50, actor }), /Credit can only be used by the customer who paid it/, 'Alpha payment credit cannot pay Bravo');
  await refuses(() => C.applyCredit({ sourceType: 'credit_note', sourceId: Number(cnL.id), targetType: 'invoice', targetId: Number(bInv.id), amount: 50, actor }), /belongs to Synth Legacy Ltd, not Synth Bravo/, 'Legacy credit note cannot pay Bravo');

  console.log('\n[10] Identity: duplicate names, unresolved links, spelling (D1)');
  await pool.query(`INSERT INTO rel_credit_notes (source_id, credit_number, note_type, contact_name_raw, note_date, amount, used_amount, company_code) VALUES ('cn-twin','CN-TWIN','customer','Synth Twin','2026-07-01',100,0,'2')`);
  const twinInv = await inv('Synth Twin', 100, 'C-DUP1');
  await refuses(() => pay('invoice', twinInv.id, 100, { method: 'Credit' }), /only has R0\.00/, 'unlinked note named like two customers is not usable');
  const sum = await C.getCreditSummary([CO]);
  ok(sum.unresolved.some((u: any) => u.number === 'CN-TWIN' && /2 customer records/.test(u.reason)), 'it is listed as unresolved for an explicit choice', sum.unresolved);
  const twinNote = (await q(`SELECT id, row_version FROM rel_credit_notes WHERE credit_number='CN-TWIN'`))[0];
  await S.updateCreditNote(Number(twinNote.id), twinNote.row_version, { customerRef: 'C-DUP1' });
  ok((await credit('C-DUP1')).totals.creditNotes === 100 && (await credit('C-DUP2')).totals.creditNotes === 0, 'after choosing the customer it belongs to C-DUP1 only');
  const ghost = await inv('Synth Ghost', 100, 'C-DOES-NOT-EXIST');
  await refuses(() => C.applyCredit({ sourceType: 'payment', sourceId: Number(rcpt.paymentId), targetType: 'invoice', targetId: Number(ghost.id), amount: 10, actor }), /not resolved/, 'document with an unknown customer link cannot receive credit');
  await pool.query(`INSERT INTO rel_credit_notes (source_id, credit_number, note_type, contact_name_raw, note_date, amount, used_amount, company_code) VALUES ('cn-old','CN-OLDNAME','customer','Synth Old Name','2026-07-01',90,0,'2')`);
  ok((await credit('C-RENAMED')).totals.creditNotes === 90, 'a note under a recorded former name resolves to the renamed customer');
  const cash = await inv('Cash Sale', 100, null);
  await pay('invoice', cash.id, 150);
  const sum2 = await C.getCreditSummary([CO]);
  ok(sum2.unresolved.some((u: any) => u.sourceType === 'payment' && u.name === 'Cash Sale'), 'a Cash Sale overpayment is surfaced as unresolved, never pooled');

  console.log('\n[11] Invalid amounts (D4)');
  for (const bad of [0, -5, 'abc', 1.005, NaN, '', null]) {
    await refuses(() => pay('invoice', part.id, bad), /Payment amount/, `payment amount ${JSON.stringify(bad)} refused`);
  }
  await refuses(() => C.applyCredit({ sourceType: 'payment', sourceId: Number(rcpt.paymentId), targetType: 'invoice', targetId: Number(part.id), amount: -1, actor }), /greater than R0\.00/, 'negative allocation refused');
  await refuses(() => C.recordCreditRefund({ sourceType: 'payment', sourceId: Number(rcpt.paymentId), amount: 0.001, reference: 'x', actor }), /2 decimal/, 'sub-cent refund refused');
  await refuses(() => S.createCreditNote({ companyCode: CO, type: 'customer', contactName: 'Synth Bravo', amount: 0 }), /greater than R0\.00/, 'zero credit note refused');

  console.log('\n[12] Older text-format and ambiguous credit payments (D7)');
  const legInv = await inv('Synth Bravo', 300, 'C-BRAVO');
  await pool.query(`INSERT INTO rel_credit_notes (source_id, credit_number, note_type, contact_name_raw, customer_ref, note_date, amount, used_amount, company_code) VALUES ('cn-b1','CN-B1','customer','Synth Bravo','C-BRAVO','2026-06-01',300,300,'2')`);
  const legPay = (await q(`INSERT INTO rel_payments (source_id, owner_type, owner_id, line_index, amount, payment_date, method) VALUES ('lp1','invoice',$1,0,300,'2026-06-02','Credit (R 300,00 available)') RETURNING id, row_version`, [legInv.id]))[0];
  const rel1 = await S.deletePayment(Number(legPay.id), legPay.row_version, { actor });
  ok(rel1.creditReleased === 300 && Number((await q(`SELECT used_amount FROM rel_credit_notes WHERE credit_number='CN-B1'`))[0].used_amount) === 0, 'old "Credit (R …)" payment returns to its only possible note');
  await pool.query(`UPDATE rel_credit_notes SET used_amount = 300 WHERE credit_number = 'CN-B1'`);
  await pool.query(`INSERT INTO rel_credit_notes (source_id, credit_number, note_type, contact_name_raw, customer_ref, note_date, amount, used_amount, company_code) VALUES ('cn-b2','CN-B2','customer','Synth Bravo','C-BRAVO','2026-06-05',300,300,'2')`);
  const legPay2 = (await q(`INSERT INTO rel_payments (source_id, owner_type, owner_id, line_index, amount, payment_date, method) VALUES ('lp2','invoice',$1,1,300,'2026-06-06','Credit') RETURNING id, row_version`, [legInv.id]))[0];
  await refuses(() => S.deletePayment(Number(legPay2.id), legPay2.row_version, { actor }), /more than one could have: CN-B1.*CN-B2/, 'ambiguous historical credit payment: actionable error naming the candidates');
  const b2 = (await q(`SELECT id FROM rel_credit_notes WHERE credit_number='CN-B2'`))[0].id;
  const rel2 = await S.deletePayment(Number(legPay2.id), legPay2.row_version, { actor, releaseToCreditNoteId: Number(b2) });
  ok(rel2.creditReleased === 300 && Number((await q(`SELECT used_amount FROM rel_credit_notes WHERE credit_number='CN-B2'`))[0].used_amount) === 0, 'with the note chosen, the credit returns to CN-B2');
  ok((await q(`SELECT COUNT(*)::int n FROM rel_credit_allocations WHERE legacy AND source_credit_note_id = $1`, [b2]))[0].n === 1, 'the historical release is recorded in the allocation audit');

  console.log('\n[13] Cancellation, deletion and customer reassignment with allocated credit');
  const tgt = await inv('Synth Alpha (Pty) Ltd', 100, 'C-ALPHA');
  const al = await C.applyCredit({ sourceType: 'payment', sourceId: Number(rcpt.paymentId), targetType: 'invoice', targetId: Number(tgt.id), amount: 100, actor });
  const tv = (await q('SELECT row_version FROM rel_invoices WHERE id = $1', [tgt.id]))[0].row_version;
  await refuses(() => S.cancelInvoice(Number(tgt.id), tv, { reason: 'test' }), /NOT cancelled/, 'invoice holding applied credit cannot be cancelled until reversed');
  const prev = await previewCustomerReassignment('invoice', Number(tgt.id), 'C-BRAVO');
  ok(prev.conflicts.some((c) => c.code === 'CREDIT_ALLOCATION'), 'changing the customer of a transaction with credit activity is refused');
  const srcPrev = await previewCustomerReassignment('invoice', Number(over.id), 'C-BRAVO');
  ok(srcPrev.conflicts.some((c) => c.code === 'CREDIT_ALLOCATION'), '…including the transaction whose receipt funded the credit');
  await C.reverseCreditAllocation(al.allocationId, { actor });
  await S.cancelInvoice(Number(tgt.id), Number((await q('SELECT row_version FROM rel_invoices WHERE id = $1', [tgt.id]))[0].row_version), { reason: 'test' });
  await refuses(() => C.applyCredit({ sourceType: 'payment', sourceId: Number(rcpt.paymentId), targetType: 'invoice', targetId: Number(tgt.id), amount: 10, actor }), /cancelled/, 'credit cannot be applied to a cancelled invoice');
  ok(await status(tgt.id) === 'void', 'cancelled invoice stays void');
  const jq = await S.createQuote({ companyCode: CO, customerNameRaw: 'Synth Bravo', customerRef: 'C-BRAVO', lines: [{ description: 'X', qty: 1, unitPrice: 100 }] });
  const jc = await S.convertQuoteToJob(Number(jq.id));
  const jcred = await C.applyCredit({ sourceType: 'payment', sourceId: Number(bravoRcpt), targetType: 'job', targetId: Number(jc.jobId), amount: 50, actor });
  const jv = (await q('SELECT row_version FROM rel_jobs WHERE id = $1', [jc.jobId]))[0].row_version;
  await refuses(() => S.deleteJob(Number(jc.jobId), jv), /cannot be deleted/, 'job holding applied credit cannot be deleted');
  await C.reverseCreditAllocation(jcred.allocationId, { actor });

  console.log('\n[14] Document credit for the payment window');
  const doc = await C.getDocumentCredit('invoice', Number(part.id));
  ok(doc.identity.state === 'matched' && doc.outstanding === 600 && doc.credit!.totals.paymentCredit === 200, 'payment window sees R600 due and R200 payment credit', { out: doc.outstanding, t: doc.credit?.totals });
  const ownDoc = await C.getDocumentCredit('invoice', Number(over.id));
  ok(ownDoc.credit!.paymentCredits.length === 0, 'a receipt is never offered as credit to its own transaction');

  console.log(`\n${passed} passed, ${failed} failed`);
  // Leaves no credit records behind for suites that reuse payment / note ids after their own TRUNCATE.
  await pool.query('TRUNCATE TABLE rel_credit_allocations, rel_credit_refunds RESTART IDENTITY');
  await pool.end();
  process.exit(failed ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
