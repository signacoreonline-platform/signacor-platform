/**
 * relational.invoice-cancel.stress.ts — 2026-11-19
 * ────────────────────────────────────────────────
 * Regression suite for: "INV-00223 was cancelled and replaced by INV-00231,
 * but INV-00223 disappeared."
 *
 * ROOT CAUSE. Cancelling an invoice had one implementation, services.ts
 * deleteInvoice — a hard DELETE. The record only ever stayed visible when a
 * placeholder was inserted by hand afterwards.
 *
 * WHAT THIS PINS (real Postgres, the real services/read layers and the real
 * Express router — nothing is re-implemented):
 *   A  cancel keeps the row, its lines, number, customer and dates; sets void;
 *      records who/when/why; releases the job; survives a fresh read
 *   B  repeating the request changes nothing
 *   C  a replacement is linked in the same transaction; A -> B -> C stays a chain;
 *      job/quote payments are untouched and reach the replacement once
 *   D  money or applied credit recorded ON the invoice refuses the cancellation
 *      and is preserved; a zero-value row does not block and is preserved
 *   E  a void invoice cannot be edited, re-activated or paid, and a payment
 *      status recompute leaves it void
 *   F  a failure part-way through rolls everything back
 *   G  company isolation
 *   H  quote-raised and standalone invoices
 *   I  the HTTP routes: admin only, reason required, DELETE now cancels
 *   J  historical shapes (no job_id on the invoice; a numbering collision)
 *
 * SAFETY: refuses to run unless DATABASE_URL points at localhost/127.0.0.1 or
 * ALLOW_UNSAFE_TEST_DB=1 is set. It TRUNCATEs the rel_* tables it uses.
 * NEVER point it at production.
 *
 * Usage (from backend/, disposable *_test database with migrations applied):
 *   $env:DATABASE_URL = "postgresql://postgres:<pw>@localhost:5432/signacore_test"
 *   npm run test:invoice-cancel
 */
process.env.RELATIONAL_AUTHORITY_ENABLED = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'invoice-cancel-test-secret';

import http from 'http';
import express from 'express';
import jwt from 'jsonwebtoken';
import pool from '../src/db/pool';
import * as services from '../src/relational/services';
import { BusinessRuleError } from '../src/relational/services';
import { buildInvoicesJson, buildJobsJson } from '../src/relational/read';
import relationalRouter from '../src/relational/api';

const DB_URL = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(DB_URL) && process.env.ALLOW_UNSAFE_TEST_DB !== '1') {
  console.error('[invoice-cancel] Refusing to run: DATABASE_URL does not look like a local test database.');
  process.exit(1);
}

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}
async function refuses(fn: () => Promise<unknown>, re: RegExp, label: string) {
  let err: any = null;
  try { await fn(); } catch (e) { err = e; }
  ok(!!err && err instanceof BusinessRuleError && re.test(String(err.message)), label, err ? String(err.message).slice(0, 160) : 'no error thrown');
}

async function reset() {
  await pool.query(`TRUNCATE TABLE rel_payments, rel_invoice_line_items, rel_invoices, rel_job_line_items,
    rel_jobs, rel_quote_line_items, rel_quotes, rel_credit_notes, rel_inventory_items, rel_customers
    RESTART IDENTITY CASCADE`);
  await pool.query(`DELETE FROM document_number_counters`);
  await pool.query(`DELETE FROM quote_conversions`);
}
const ACTOR = { id: 'admin-1', email: 'admin@test.local', role: 'admin' };

async function seedInvoicedJob(companyCode = '2', clientName = 'Cancel Probe Client', value = 11500) {
  const cust = await services.createCustomer({ companyName: clientName } as any);
  const job = await services.createJob({
    companyCode, customerId: cust.id, customerNameRaw: clientName,
    description: 'Invoiced job', value, stage: 7, status: 'in_production',
  } as any);
  const inv = await services.createInvoiceForJob(job.id);
  return { cust, job, inv };
}
async function seedQuoteJobInvoice(companyCode = '2', clientName = 'Chain Client') {
  const cust = await services.createCustomer({ companyName: clientName } as any);
  const quote = await services.createQuote({
    companyCode, customerId: cust.id, customerNameRaw: clientName,
    lines: [{ description: 'Sign panel', qty: 2, unitPrice: 1000 }, { description: 'Install', qty: 1, unitPrice: 500 }],
  } as any);
  const conv = await services.convertQuoteToJob(quote.id);
  const inv = await services.createInvoiceForJob(conv.jobId);
  return { cust, quote, jobId: Number(conv.jobId), jobNumber: conv.jobNumber, inv };
}
const invRow = async (id: number | string) => (await pool.query('SELECT * FROM rel_invoices WHERE id = $1', [id])).rows[0];
const jobRow = async (id: number | string) => (await pool.query('SELECT * FROM rel_jobs WHERE id = $1', [id])).rows[0];
const linesOf = async (id: number | string) => JSON.stringify((await pool.query(
  'SELECT line_index, description, qty::text, unit_amount::text, account_code, tax_type, legacy_data FROM rel_invoice_line_items WHERE invoice_id = $1 ORDER BY line_index', [id])).rows);
const paymentsSnapshot = async () => JSON.stringify((await pool.query(
  'SELECT id, owner_type, owner_id, line_index, amount::text, payment_date, method, reference, notes, row_version FROM rel_payments ORDER BY id')).rows);
const creditSnapshot = async () => JSON.stringify((await pool.query('SELECT id, amount::text, used_amount::text, row_version FROM rel_credit_notes ORDER BY id')).rows);
const hydrated = async (number: string, co?: number) =>
  (await buildInvoicesJson()).find((i: any) => i.number === number && (co === undefined || i.co === co));

async function main() {
  console.log('\n════ INVOICE CANCELLATION — RETAIN, VOID, REPLACE ════');

  // ── A ─────────────────────────────────────────────────────────────────────
  console.log('\n[A] cancelling keeps the invoice, its lines and its number');
  {
    await reset();
    const { quote, jobId, jobNumber, inv } = await seedQuoteJobInvoice();
    const before = await invRow(inv.invoiceId);
    const linesBefore = await linesOf(inv.invoiceId);
    const jobBefore = await jobRow(jobId);
    ok(jobBefore.invoice_num === inv.invoiceNumber && jobBefore.invoice_created === true, 'A0 precondition: the job carries the invoice link');

    const r = await services.cancelInvoice(Number(inv.invoiceId), before.row_version, { reason: 'Client changed the order', actor: ACTOR });
    const after = await invRow(inv.invoiceId);
    ok(!!after, 'A1 the rel_invoices row still exists');
    ok(after.status === 'void', 'A2 status is void', after.status);
    ok(after.invoice_number === before.invoice_number && after.company_code === before.company_code, 'A3 number and company unchanged');
    ok(String(after.customer_id) === String(before.customer_id) && after.contact_name === before.contact_name, 'A4 customer and contact unchanged');
    ok(String(after.issue_date) === String(before.issue_date) && String(after.due_date) === String(before.due_date), 'A5 issue and due dates unchanged');
    ok((await linesOf(inv.invoiceId)) === linesBefore && JSON.parse(linesBefore).length >= 2, 'A6 every original line is byte-identical', JSON.parse(linesBefore).length);
    const m = after.legacy_data;
    ok(m.cancelledByAdmin === true && m.cancelledBy === ACTOR.email && m.cancelledById === ACTOR.id, 'A7 who cancelled it is recorded', m);
    ok(typeof m.cancelledAt === 'string' && !Number.isNaN(Date.parse(m.cancelledAt)), 'A8 when is recorded');
    ok(m.cancelledReason === 'Client changed the order', 'A9 why is recorded');
    ok(m.statusBeforeCancel === before.status && m.originalDetailRetained === true, 'A10 the previous status is recorded and the detail is flagged as retained');
    ok(after.job_id === null && after.quote_id === null, 'A11 the active job/quote link is released');
    ok(m.originalJobId === jobId && m.originalJobNum === jobNumber && Number(m.originalQuoteId) === Number(quote.id) && m.originalQuoteNum === quote.quoteNumber,
      'A12 the original job and quote identity is kept on the record', m);
    ok(after.job_number_raw === jobNumber, 'A13 the job number stays as text for display');
    ok(after.row_version === before.row_version + 1 && r.rowVersion === after.row_version, 'A14 row_version bumped once and returned');
    const jobAfter = await jobRow(jobId);
    ok(jobAfter.invoice_num === null && jobAfter.invoice_created === false && jobAfter.invoice_status === null && jobAfter.invoice_date === null,
      'A15 the job is back to "not yet invoiced"');
    ok(jobAfter.stage === jobBefore.stage && jobAfter.status === jobBefore.status && String(jobAfter.value) === String(jobBefore.value), 'A16 the job\'s stage, status and value are untouched');
    ok(r.clearedJobs.length === 1 && r.clearedJobs[0].jobNumber === jobNumber && r.clearedJobs[0].rowVersion === jobAfter.row_version, 'A17 the released job is reported with its new version');
    // "after refresh and in another session" = a fresh authoritative read.
    const h = await hydrated(inv.invoiceNumber);
    ok(!!h && h.status === 'void' && h.cancelledByAdmin === true && h.cancelledReason === 'Client changed the order',
      'A18 a fresh read still returns it, void, with its cancellation fields');
    ok(!!h && (h.lineItems || []).length === JSON.parse(linesBefore).length, 'A19 and with its original lines');
    const hj = (await buildJobsJson()).find((j: any) => j.num === jobNumber);
    ok(!!hj && !hj.invoiceNum && !hj.invoiceCreated, 'A20 the job reads as not invoiced');
    const counter = (await pool.query(`SELECT last_number FROM document_number_counters WHERE doc_type = 'invoice' AND company = '2'`)).rows[0];
    ok(!!counter && Number(counter.last_number) === 1, 'A21 the document counter did not move');
  }

  // ── B ─────────────────────────────────────────────────────────────────────
  console.log('\n[B] repeating the cancellation is safe');
  {
    await reset();
    const { jobId, inv } = await seedQuoteJobInvoice();
    const v0 = (await invRow(inv.invoiceId)).row_version;
    await services.cancelInvoice(Number(inv.invoiceId), v0, { reason: 'first', actor: ACTOR });
    const snapInv = JSON.stringify(await invRow(inv.invoiceId));
    const snapJob = JSON.stringify(await jobRow(jobId));
    const again = await services.cancelInvoice(Number(inv.invoiceId), v0, { reason: 'second attempt', actor: { id: 'other', email: 'other@test.local', role: 'admin' } });
    ok(again.cancelled === true && again.alreadyCancelled === true, 'B1 a retry with the ORIGINAL (now stale) version reports alreadyCancelled, not a conflict');
    ok(JSON.stringify(await invRow(inv.invoiceId)) === snapInv, 'B2 the invoice row is byte-identical — no second marker, no version bump');
    ok(JSON.stringify(await jobRow(jobId)) === snapJob, 'B3 the job is not touched a second time');
    ok(again.marker.cancelledReason === 'first' && again.marker.cancelledBy === ACTOR.email, 'B4 the original who/why is returned, not the retry\'s');
    ok(again.clearedJobs.length === 0, 'B5 no job is reported as released by the retry');
    const third = await services.cancelInvoice(Number(inv.invoiceId), null, { reason: 'no version', actor: ACTOR });
    ok(third.alreadyCancelled === true && (await pool.query('SELECT count(*)::int n FROM rel_invoices')).rows[0].n === 1, 'B6 a third request creates no duplicate record');
  }

  // ── C ─────────────────────────────────────────────────────────────────────
  console.log('\n[C] replacement chain, and job/quote money counted once');
  {
    await reset();
    const { quote, jobId, inv: invA } = await seedQuoteJobInvoice();
    // A deposit on the QUOTE and a payment on the JOB — neither is the invoice's.
    await services.recordPayment({ type: 'quote', id: Number(quote.id) }, 1000, { date: '2026-11-01', method: 'EFT', notes: 'deposit' });
    await services.recordPayment({ type: 'job', id: jobId }, 500, { date: '2026-11-02', method: 'EFT' });
    const paysBefore = await paymentsSnapshot();

    await services.cancelInvoice(Number(invA.invoiceId), (await invRow(invA.invoiceId)).row_version, { reason: 'order changed', actor: ACTOR });
    ok((await paymentsSnapshot()) === paysBefore, 'C1 cancelling changed no rel_payments row');
    ok((await invRow(invA.invoiceId)).legacy_data.replacedBy === null, 'C2 no replacement is named before one exists');
    const jobMid = await jobRow(jobId);
    ok(jobMid.invoice_status === 'partial', 'C3 the released job still reports the money it holds', jobMid.invoice_status);

    const invB = await services.createInvoiceForJob(jobId);
    ok(invB.invoiceNumber !== invA.invoiceNumber && invB.created === true, 'C4 the job can be invoiced again under a NEW number', invB.invoiceNumber);
    const aAfterB = await invRow(invA.invoiceId);
    ok(aAfterB.legacy_data.replacedBy === invB.invoiceNumber && Number(aAfterB.legacy_data.replacedById) === Number(invB.invoiceId),
      'C5 the cancelled invoice names its replacement (same transaction as the create)', aAfterB.legacy_data);
    ok(aAfterB.status === 'void', 'C6 and is still void');

    const all1 = await buildInvoicesJson();
    const hA = all1.find((i: any) => i.number === invA.invoiceNumber);
    const hB = all1.find((i: any) => i.number === invB.invoiceNumber);
    ok(hA.replacedBy === invB.invoiceNumber, 'C7 a fresh read shows the replacement number on the cancelled invoice');
    ok((hA.payments || []).length === 0, 'C8 the cancelled invoice carries none of the job/quote payments');
    ok((hB.payments || []).length === 2 && hB.payments.reduce((s: number, p: any) => s + Number(p.amount), 0) === 1500,
      'C9 the replacement carries the quote deposit and the job payment exactly once', (hB.payments || []).map((p: any) => p.amount));
    ok(hB.status === 'partial', 'C10 the replacement is Partly Paid from that money', hB.status);
    ok(all1.filter((i: any) => i.status !== 'void').length === 1, 'C11 exactly ONE active invoice exists for the transaction');

    // A -> B -> C
    await services.cancelInvoice(Number(invB.invoiceId), (await invRow(invB.invoiceId)).row_version, { reason: 'changed again', actor: ACTOR });
    const invC = await services.createInvoiceForJob(jobId);
    const fa = await invRow(invA.invoiceId), fb = await invRow(invB.invoiceId), fc = await invRow(invC.invoiceId);
    ok(fa.legacy_data.replacedBy === invB.invoiceNumber, 'C12 chain: A still points to B (an existing link is never rewritten)', fa.legacy_data.replacedBy);
    ok(fb.legacy_data.replacedBy === invC.invoiceNumber, 'C13 chain: B points to C', fb.legacy_data.replacedBy);
    ok(fc.status !== 'void' && Number(fc.job_id) === jobId, 'C14 chain: C is the one active invoice of the job');
    ok((await paymentsSnapshot()) === paysBefore, 'C15 no payment row changed across the whole chain');
    const again = await services.createInvoiceForJob(jobId).catch((e) => e);
    ok(again instanceof BusinessRuleError, 'C16 the job cannot be double-invoiced while C is active');
    ok((await invRow(invB.invoiceId)).legacy_data.replacedBy === invC.invoiceNumber, 'C17 and the recorded links are unchanged by that refused attempt');
  }

  // ── D ─────────────────────────────────────────────────────────────────────
  console.log('\n[D] money or credit recorded ON the invoice');
  {
    await reset();
    const { jobId, inv } = await seedQuoteJobInvoice();
    await services.recordPayment({ type: 'invoice', id: Number(inv.invoiceId) }, 750, { date: '2026-11-03', method: 'EFT' });
    const snapInv = JSON.stringify(await invRow(inv.invoiceId)); const snapJob = JSON.stringify(await jobRow(jobId)); const snapPay = await paymentsSnapshot();
    await refuses(() => services.cancelInvoice(Number(inv.invoiceId), (JSON.parse(snapInv)).row_version, { reason: 'x', actor: ACTOR }),
      /NOT cancelled.*1 payment totalling R750\.00 recorded directly on it/s, 'D1 a payment on the invoice refuses the cancellation, naming the amount');
    ok(JSON.stringify(await invRow(inv.invoiceId)) === snapInv && JSON.stringify(await jobRow(jobId)) === snapJob && (await paymentsSnapshot()) === snapPay,
      'D2 nothing changed: invoice, job and payments identical');
  }
  {
    await reset();
    const { inv } = await seedQuoteJobInvoice('2', 'Credit Client');
    await services.createCreditNote({ companyCode: '2', type: 'customer', contactName: 'Credit Client', date: '2026-10-01', amount: 400 } as any);
    await services.recordPayment({ type: 'invoice', id: Number(inv.invoiceId) }, 400, { date: '2026-11-03', method: 'Credit' });
    const snapCredit = await creditSnapshot(); const snapPay = await paymentsSnapshot();
    await refuses(async () => services.cancelInvoice(Number(inv.invoiceId), (await invRow(inv.invoiceId)).row_version, { reason: 'x', actor: ACTOR }),
      /applied customer credit/, 'D3 applied credit on the invoice refuses the cancellation and says so');
    ok((await creditSnapshot()) === snapCredit && (await paymentsSnapshot()) === snapPay, 'D4 the credit note and the Credit payment are preserved exactly');
    ok((await invRow(inv.invoiceId)).status !== 'void', 'D5 the invoice is still active');
  }
  {
    await reset();
    const { inv } = await seedQuoteJobInvoice();
    await pool.query(`INSERT INTO rel_payments (owner_type, owner_id, line_index, amount, payment_date, method, notes) VALUES ('invoice', $1, 0, 0, '2026-11-01', 'EFT', 'legacy zero row')`, [inv.invoiceId]);
    const snapPay = await paymentsSnapshot();
    const r = await services.cancelInvoice(Number(inv.invoiceId), (await invRow(inv.invoiceId)).row_version, { reason: 'zero row', actor: ACTOR });
    ok(r.cancelled && !r.alreadyCancelled, 'D6 a zero-value payment row carries no money and does not block');
    ok((await paymentsSnapshot()) === snapPay, 'D7 and it is preserved untouched');
  }

  // ── E ─────────────────────────────────────────────────────────────────────
  console.log('\n[E] a cancelled invoice is read-only and stays void');
  {
    await reset();
    const { inv } = await seedInvoicedJob();
    // Guard on an ACTIVE invoice first: no back-door void by editing.
    const v = (await invRow(inv.invoiceId)).row_version;
    await refuses(() => services.updateInvoice(Number(inv.invoiceId), v, { status: 'void' }), /cannot be set to "void" by editing/, 'E1 an active invoice cannot be voided by a plain edit');
    ok((await invRow(inv.invoiceId)).status !== 'void', 'E2 and was not');
    await pool.query(`INSERT INTO rel_payments (owner_type, owner_id, line_index, amount, payment_date, method) VALUES ('invoice', $1, 0, 0, '2026-11-01', 'EFT')`, [inv.invoiceId]);
    const zeroPay = (await pool.query(`SELECT id, row_version FROM rel_payments WHERE owner_type='invoice' AND owner_id=$1`, [inv.invoiceId])).rows[0];
    await services.cancelInvoice(Number(inv.invoiceId), v, { reason: 'guards', actor: ACTOR });
    const vv = (await invRow(inv.invoiceId)).row_version;
    const snap = JSON.stringify(await invRow(inv.invoiceId)); const lines = await linesOf(inv.invoiceId);
    await refuses(() => services.updateInvoice(Number(inv.invoiceId), vv, { reference: 'edited' }), /has been cancelled.*cannot be edited/s, 'E3 editing a cancelled invoice is refused');
    await refuses(() => services.updateInvoice(Number(inv.invoiceId), vv, { status: 'sent' }), /has been cancelled/, 'E4 re-activating it (status sent) is refused');
    await refuses(() => services.updateInvoice(Number(inv.invoiceId), vv, { lines: [{ description: 'x', qty: 1, unitAmount: 1, taxType: '15%' }] } as any), /has been cancelled/, 'E5 replacing its lines is refused');
    await refuses(() => services.updateInvoice(Number(inv.invoiceId), vv - 1, { status: 'paid' }), /has been cancelled/, 'E6 a stale editor is told it is cancelled, not just "stale"');
    await refuses(() => services.recordPayment({ type: 'invoice', id: Number(inv.invoiceId) }, 100, { method: 'EFT' }), /has been cancelled.*cannot be paid/s, 'E7 recording a payment against it is refused');
    await refuses(() => services.updatePayment(Number(zeroPay.id), zeroPay.row_version, { amount: 50 }), /has been cancelled/, 'E8 editing a payment that sits on it is refused');
    await refuses(() => services.deletePayment(Number(zeroPay.id), zeroPay.row_version), /has been cancelled/, 'E9 deleting a payment that sits on it is refused');
    ok(JSON.stringify(await invRow(inv.invoiceId)) === snap && (await linesOf(inv.invoiceId)) === lines, 'E10 none of those attempts changed the record');
    ok((await pool.query(`SELECT count(*)::int n FROM rel_payments WHERE owner_type='invoice' AND owner_id=$1`, [inv.invoiceId])).rows[0].n === 1, 'E11 and no payment was added or removed');

    // Recalculation: money that reaches a void invoice by any other route
    // (historical rows) must never flip it back to partial/paid.
    await pool.query(`INSERT INTO rel_payments (owner_type, owner_id, line_index, amount, payment_date, method) VALUES ('invoice', $1, 1, 99999, '2026-11-01', 'EFT')`, [inv.invoiceId]);
    const c = await pool.connect();
    try { await c.query('BEGIN'); await services.recomputeOwnerPaymentStatus(c, 'invoice', Number(inv.invoiceId)); await c.query('COMMIT'); } finally { c.release(); }
    ok((await invRow(inv.invoiceId)).status === 'void', 'E12 a payment-status recompute anchored on a void invoice leaves it void');
  }

  // ── F ─────────────────────────────────────────────────────────────────────
  console.log('\n[F] failure handling — all or nothing');
  {
    await reset();
    const { jobId, inv } = await seedQuoteJobInvoice();
    const snapInv = JSON.stringify(await invRow(inv.invoiceId)); const snapJob = JSON.stringify(await jobRow(jobId));
    const v = JSON.parse(snapInv).row_version;
    await refuses(() => services.cancelInvoice(Number(inv.invoiceId), v, { reason: 'x', actor: ACTOR, replacedBy: 'INV-99999' }), /Replacement invoice INV-99999 was not found/, 'F1 an unknown replacement is refused');
    await refuses(() => services.cancelInvoice(Number(inv.invoiceId), v, { reason: 'x', actor: ACTOR, replacedBy: inv.invoiceNumber }), /cannot replace itself/, 'F2 an invoice cannot replace itself');
    let conflict: any = null;
    try { await services.cancelInvoice(Number(inv.invoiceId), v + 5, { reason: 'x', actor: ACTOR }); } catch (e) { conflict = e; }
    ok(conflict instanceof services.ConcurrencyConflictError, 'F3 a wrong version on an ACTIVE invoice is a normal stale-record conflict');
    await refuses(() => services.cancelInvoice(987654, 1, { reason: 'x', actor: ACTOR }), /not found/, 'F4 an unknown invoice is refused');
    // Break the SECOND half (the job release) after the invoice UPDATE has run.
    await pool.query(`CREATE OR REPLACE FUNCTION _cancel_test_boom() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'simulated failure releasing the job'; END; $$ LANGUAGE plpgsql`);
    await pool.query(`CREATE TRIGGER _cancel_test_boom BEFORE UPDATE ON rel_jobs FOR EACH ROW EXECUTE FUNCTION _cancel_test_boom()`);
    let boom: any = null;
    try { await services.cancelInvoice(Number(inv.invoiceId), v, { reason: 'will fail', actor: ACTOR }); } catch (e) { boom = e; }
    await pool.query(`DROP TRIGGER _cancel_test_boom ON rel_jobs`); await pool.query(`DROP FUNCTION _cancel_test_boom()`);
    ok(!!boom && /simulated failure/.test(String(boom.message)), 'F5 a failure while releasing the job surfaces as an error');
    ok(JSON.stringify(await invRow(inv.invoiceId)) === snapInv, 'F6 ...and the invoice UPDATE was rolled back: still active, no marker, same version');
    ok(JSON.stringify(await jobRow(jobId)) === snapJob, 'F7 ...and the job is unchanged');
    const r = await services.cancelInvoice(Number(inv.invoiceId), v, { reason: 'retry after failure', actor: ACTOR });
    ok(r.cancelled && !r.alreadyCancelled && (await invRow(inv.invoiceId)).status === 'void', 'F8 the same request then succeeds cleanly');
  }

  // ── G ─────────────────────────────────────────────────────────────────────
  console.log('\n[G] company isolation');
  {
    await reset();
    const sig = await seedQuoteJobInvoice('2', 'Signacore Client');
    const hol = await seedQuoteJobInvoice('1', 'Holdings Client');
    ok(sig.inv.invoiceNumber === hol.inv.invoiceNumber, 'G0 precondition: both companies hold the SAME invoice number', [sig.inv.invoiceNumber, hol.inv.invoiceNumber]);
    const holSnap = JSON.stringify(await invRow(hol.inv.invoiceId)); const holJobSnap = JSON.stringify(await jobRow(hol.jobId));
    await services.cancelInvoice(Number(sig.inv.invoiceId), (await invRow(sig.inv.invoiceId)).row_version, { reason: 'sig only', actor: ACTOR });
    ok(JSON.stringify(await invRow(hol.inv.invoiceId)) === holSnap && JSON.stringify(await jobRow(hol.jobId)) === holJobSnap, 'G1 the other company\'s same-numbered invoice and its job are untouched');
    await refuses(() => services.cancelInvoice(Number(hol.inv.invoiceId), JSON.parse(holSnap).row_version, { reason: 'x', actor: ACTOR, replacedBy: 'INV-00002' }),
      /was not found in this company/, 'G2 a replacement number is only ever resolved inside the invoice\'s own company');
    // A forged marker in the OTHER company naming this job must never be stamped.
    await pool.query(`UPDATE rel_invoices SET status='void', job_id=NULL, quote_id=NULL, legacy_data = legacy_data || $2::jsonb WHERE id=$1`,
      [hol.inv.invoiceId, JSON.stringify({ cancelledByAdmin: true, originalJobId: sig.jobId, originalQuoteId: Number(sig.quote.id), replacedBy: null })]);
    const sigB = await services.createInvoiceForJob(sig.jobId);
    ok((await invRow(sig.inv.invoiceId)).legacy_data.replacedBy === sigB.invoiceNumber, 'G3 the replacement is linked inside its own company');
    ok((await invRow(hol.inv.invoiceId)).legacy_data.replacedBy === null, 'G4 and never onto a cancelled invoice of another company');
    const co1 = await hydrated(hol.inv.invoiceNumber, 1); const co2 = await hydrated(sig.inv.invoiceNumber, 2);
    ok(!!co1 && !!co2 && co1.co === 1 && co2.co === 2, 'G5 each cancelled record reads back under its own company');
  }

  // ── H ─────────────────────────────────────────────────────────────────────
  console.log('\n[H] quote-raised and standalone invoices');
  {
    await reset();
    const cust = await services.createCustomer({ companyName: 'Quote Only' } as any);
    const quote = await services.createQuote({ companyCode: '2', customerId: cust.id, customerNameRaw: 'Quote Only', lines: [{ description: 'Banner', qty: 1, unitPrice: 800 }] } as any);
    await services.recordPayment({ type: 'quote', id: Number(quote.id) }, 300, { date: '2026-11-01', method: 'EFT' });
    const qa = await services.createInvoiceFromQuote(Number(quote.id));
    await services.cancelInvoice(Number(qa.invoiceId), (await invRow(qa.invoiceId)).row_version, { reason: 'quote invoice', actor: ACTOR });
    const a = await invRow(qa.invoiceId);
    ok(a.status === 'void' && a.quote_id === null && Number(a.legacy_data.originalQuoteId) === Number(quote.id) && a.quote_number_raw === quote.quoteNumber, 'H1 a quote-raised invoice is cancelled and keeps its quote identity');
    const qb = await services.createInvoiceFromQuote(Number(quote.id));
    ok(qb.invoiceNumber !== qa.invoiceNumber && qb.reused === false, 'H2 the quote can be invoiced again under a new number', qb);
    ok((await invRow(qa.invoiceId)).legacy_data.replacedBy === qb.invoiceNumber, 'H3 linked as the replacement through the QUOTE identity');
    const hb = await hydrated(qb.invoiceNumber);
    ok((hb.payments || []).length === 1 && Number(hb.payments[0].amount) === 300, 'H4 the quote deposit reaches the replacement once');

    const m = await services.createManualInvoice({ companyCode: '2', contactName: 'Walk-in', lines: [{ description: 'Stickers', qty: 3, unitAmount: 50, taxType: '15%' }] } as any);
    const r = await services.cancelInvoice(Number(m.id), m.rowVersion, { reason: 'raised in error', actor: ACTOR });
    const mr = await invRow(m.id);
    ok(mr.status === 'void' && r.clearedJobs.length === 0 && mr.legacy_data.originalJobId === null, 'H5 a standalone invoice is cancelled with no job to release');
    const m2 = await services.createManualInvoice({ companyCode: '2', contactName: 'Walk-in', lines: [{ description: 'Stickers', qty: 3, unitAmount: 50, taxType: '15%' }] } as any);
    ok((await invRow(m.id)).legacy_data.replacedBy === null && m2.invoiceNumber !== m.invoiceNumber, 'H6 an unrelated new invoice is never guessed to be its replacement');
    const r2 = await services.cancelInvoice(Number(m2.id), m2.rowVersion, { reason: 'x', actor: ACTOR, replacedBy: qb.invoiceNumber });
    ok(r2.marker.replacedBy === qb.invoiceNumber, 'H7 a replacement can be supplied explicitly when it is a real active invoice of the company');
  }

  // ── J ─────────────────────────────────────────────────────────────────────
  console.log('\n[J] historical shapes: no job_id on the invoice');
  {
    await reset();
    // Backfilled shape: the invoice carries NO job_id; the job names it by number.
    const { job, inv } = await seedInvoicedJob();
    await pool.query('UPDATE rel_invoices SET job_id = NULL WHERE id = $1', [inv.invoiceId]);
    const r = await services.cancelInvoice(Number(inv.invoiceId), (await invRow(inv.invoiceId)).row_version, { reason: 'backfilled', actor: ACTOR });
    ok(r.clearedJobs.length === 1 && (await jobRow(job.id)).invoice_num === null, 'J1 exactly one job names the number -> that job is released');
    // Numbering collision: TWO jobs carry the number and the invoice names neither.
    await reset();
    const a = await seedInvoicedJob('2', 'Collision A');
    const b = await services.createJob({ companyCode: '2', customerNameRaw: 'Collision B', description: 'x', value: 100, stage: 7, status: 'in_production' } as any);
    await pool.query('UPDATE rel_invoices SET job_id = NULL WHERE id = $1', [a.inv.invoiceId]);
    await pool.query('UPDATE rel_jobs SET invoice_num = $1, invoice_created = true WHERE id = $2', [a.inv.invoiceNumber, b.id]);
    const snapA = JSON.stringify(await jobRow(a.job.id)); const snapB = JSON.stringify(await jobRow(b.id));
    const r2 = await services.cancelInvoice(Number(a.inv.invoiceId), (await invRow(a.inv.invoiceId)).row_version, { reason: 'collision', actor: ACTOR });
    ok(r2.cancelled && r2.clearedJobs.length === 0 && r2.ambiguousJobs.length === 2, 'J2 a numbering collision is reported, not resolved by guessing', r2.ambiguousJobs);
    ok(JSON.stringify(await jobRow(a.job.id)) === snapA && JSON.stringify(await jobRow(b.id)) === snapB, 'J3 neither colliding job was touched');
    ok((await invRow(a.inv.invoiceId)).status === 'void', 'J4 the invoice itself is still cancelled and retained');
  }

  // ── I ─────────────────────────────────────────────────────────────────────
  console.log('\n[I] HTTP routes');
  {
    await reset();
    await pool.query(`UPDATE relational_cutover SET enabled = true, enabled_at = NOW(), enabled_by = 'invoice-cancel-test' WHERE section IN ('customers','quotes','jobs','accInvoices','creditNotes')`);
    const app = express(); app.use(express.json()); app.use('/api/relational', relationalRouter);
    const server = http.createServer(app); await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
    const base = `http://127.0.0.1:${(server.address() as any).port}/api/relational`;
    const tok = (u: any) => jwt.sign(u, process.env.JWT_SECRET as string);
    const call = async (method: string, path: string, user: any, body?: any) => {
      const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok(user) }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json().catch(() => ({})) as any };
    };
    const ADMIN = { id: 'u1', email: 'admin@signacore.test', role: 'admin', co: null };
    const HOLADMIN = { id: 'u2', email: 'hadmin@holdings.test', role: 'admin', co: 1 };
    const ACCOUNTS = { id: 'u3', email: 'accounts@signacore.test', role: 'accounts', co: null };
    const ASSIST = { id: 'u4', email: 'assistant@signacore.test', role: 'assistant', co: null };
    const FACTORY = { id: 'u5', email: 'factory@signacore.test', role: 'factory', co: null };
    try {
      const a = await seedQuoteJobInvoice('2', 'HTTP Client');
      const v = (await invRow(a.inv.invoiceId)).row_version;
      const p = `/invoices/${a.inv.invoiceId}/cancel`;
      for (const [u, name] of [[ACCOUNTS, 'accounts'], [ASSIST, 'assistant'], [FACTORY, 'factory']] as any[]) {
        const r = await call('POST', p, u, { expectedVersion: v, reason: 'nope' });
        ok(r.status === 403, `I1 role "${name}" cannot cancel (403)`, r);
      }
      const hx = await call('POST', p, HOLADMIN, { expectedVersion: v, reason: 'wrong company' });
      ok(hx.status === 403 && /another company/.test(hx.body.error || ''), 'I2 a Holdings admin cannot cancel a Signacore invoice', hx);
      const nr = await call('POST', p, ADMIN, { expectedVersion: v, reason: '   ' });
      ok(nr.status === 400 && /reason is required/.test(nr.body.error || ''), 'I3 a blank reason is refused (400)', nr);
      ok((await invRow(a.inv.invoiceId)).status !== 'void', 'I4 none of those requests changed the invoice');
      const good = await call('POST', p, ADMIN, { expectedVersion: v, reason: 'Client changed the order' });
      ok(good.status === 200 && good.body.cancelled === true && good.body.deleted === false && good.body.alreadyCancelled === false && good.body.status === 'void', 'I5 an admin with a reason cancels it', good.body);
      ok(good.body.marker && good.body.marker.cancelledBy === ADMIN.email && good.body.marker.cancelledReason === 'Client changed the order', 'I6 who and why come from the session and the request');
      ok(Array.isArray(good.body.clearedJobs) && good.body.clearedJobs.length === 1, 'I7 the released job is reported to the client');
      const rep = await call('POST', p, ADMIN, { expectedVersion: v, reason: 'again' });
      ok(rep.status === 200 && rep.body.alreadyCancelled === true && rep.body.rowVersion === good.body.rowVersion, 'I8 the same request again is a 200 no-op', rep.body);
      ok((await pool.query('SELECT count(*)::int n FROM rel_invoices')).rows[0].n === 1, 'I9 no duplicate record');
      const put = await call('PUT', `/invoices/${a.inv.invoiceId}`, ADMIN, { expectedVersion: good.body.rowVersion, status: 'sent' });
      ok(put.status === 409 && put.body.type === 'business_rule' && /has been cancelled/.test(put.body.error || ''), 'I10 PUT cannot re-activate it', put);
      const pay = await call('POST', '/payments', ADMIN, { ownerType: 'invoice', ownerId: Number(a.inv.invoiceId), amount: 10, ownerSection: 'accInvoices', method: 'EFT' });
      ok(pay.status === 409 && /has been cancelled/.test(pay.body.error || ''), 'I11 POST /payments against it is refused', pay);
      const mk = await call('POST', `/jobs/${a.jobId}/create-invoice`, ADMIN);
      ok(mk.status >= 200 && mk.status < 300 && !!mk.body.invoiceNumber, 'I12 the job is invoiced again through the normal route', mk);
      ok((await invRow(a.inv.invoiceId)).legacy_data.replacedBy === mk.body.invoiceNumber, 'I13 and the cancelled invoice now names that replacement');

      // The legacy DELETE route: an older page in an open tab must not delete.
      const b = await seedQuoteJobInvoice('2', 'Old Tab Client');
      const bv = (await invRow(b.inv.invoiceId)).row_version;
      const nd = await call('DELETE', `/invoices/${b.inv.invoiceId}`, ACCOUNTS, { expectedVersion: bv });
      ok(nd.status === 403 && !!(await invRow(b.inv.invoiceId)), 'I14 DELETE by a non-admin is refused and the row remains');
      const del = await call('DELETE', `/invoices/${b.inv.invoiceId}`, ADMIN, { expectedVersion: bv });
      const brow = await invRow(b.inv.invoiceId);
      ok(del.status === 200 && del.body.deleted === false && del.body.cancelled === true, 'I15 DELETE answers cancelled:true, deleted:false', del.body);
      ok(!!brow && brow.status === 'void' && brow.legacy_data.cancelledByAdmin === true, 'I16 the row is RETAINED and void — nothing was deleted');
      ok((await pool.query('SELECT count(*)::int n FROM rel_invoice_line_items WHERE invoice_id = $1', [b.inv.invoiceId])).rows[0].n >= 2, 'I17 with its lines');
      const hseed = await seedQuoteJobInvoice('1', 'Holdings HTTP');
      const hd = await call('DELETE', `/invoices/${hseed.inv.invoiceId}`, HOLADMIN, {});
      ok(hd.status === 200 && hd.body.cancelled === true, 'I18 a Holdings admin can cancel a Holdings invoice', hd.body);
      const fresh = await buildInvoicesJson();
      ok(fresh.filter((i: any) => i.status === 'void' && i.cancelledByAdmin).length === 3 && fresh.filter((i: any) => i.status !== 'void').length === 1,
        'I19 a fresh read returns all three cancelled invoices and the one active replacement');
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
      await pool.query(`UPDATE relational_cutover SET enabled = false, enabled_at = NULL, enabled_by = NULL WHERE enabled_by = 'invoice-cancel-test'`);
    }
  }

  console.log(`\n════ invoice-cancel: PASSED ${passed}   FAILED ${failures} ════`);
  await pool.end();
  process.exit(failures ? 1 : 0);
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch { /* ignore */ } process.exit(1); });
