/**
 * repair-historical-credit.ts — TARGETED repair of exactly TWO historical
 * receipts so they work with customer credit (022) and payments on account
 * (023). Authorised for these two cases only (2026-11-26):
 *
 *   RAIDER  Raider Outboards International — INV-00207 / SNS-00222.
 *           Invoice R204.24, EFT receipt R2,000.00 of 2026-11-18 (excess R1,795.76).
 *           Repair: the one receipt row is marked as a receipt that can provide
 *           payment credit (credit_eligible). Nothing else changes: the invoice,
 *           the receipt and its amount, date, method and reference stay as they
 *           are, no receipt or credit note is created, and the customer's
 *           available payment credit becomes exactly R1,795.76 (verified).
 *
 *   ATC     Advanced Tactical Craft (PTY) LTD - ATC Marine — INV-00239 / SNS-00253.
 *           Invoice R0.00 (not required), EFT receipt R2,000.00 of 2026-11-18.
 *           Repair: the receipt becomes ONE payment on account (rel_account_receipts)
 *           for the same customer in the same company with the original amount,
 *           date, method and reference; the old payment row is removed (its full
 *           record is backed up and kept in the audit trail) so the money is
 *           counted once; INV-00239 is cancelled through the normal retained-void
 *           workflow (cancelInvoiceTx — number and history kept, job/quote link
 *           released) with a reason saying the money is on account. No credit
 *           note and no other receipt is created.
 *
 * MANUAL ONLY. Never run by Render.
 *   --diagnose   read only: every fact the repair depends on, per case.
 *   (default)    DRY RUN, read only: the exact changes, before/after balances
 *                and a plan fingerprint.
 *   --apply "--confirm=<phrase from the dry run>" --expect=<fingerprint>
 *                applies EXACTLY the reviewed dry run, in ONE transaction.
 *   options: --connect-timeout=SECONDS (5-300, default 30)  --lock-timeout=SECONDS (default 15)
 *
 * SAFETY: every row is locked; the plan is rebuilt under the locks and must equal
 * --expect; anything that does not match the expected facts (customer, company,
 * chain links, amounts, dates, method, existing credit use, a half-done repair)
 * stops the run before anything is written. Before-images go to a local
 * historical-credit-repair-<time>.json AND into customer_link_audit rows written
 * in the same transaction. The result is verified before COMMIT; any failure
 * rolls back everything. A second run finds the cases already repaired and
 * writes nothing.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { Client, types } from 'pg';
// DATE columns as the plain 'YYYY-MM-DD' text stored in the database — never a
// local-midnight Date (on a South African PC that would print and back up
// 2026-11-18 as 2026-11-17). Applies to this script's process only.
types.setTypeParser(1082, (v: string) => v);
import { resolveSsl, describeConnectionError } from '../db/ssl';
import { resolveTransactionChainTx, recomputeOwnerPaymentStatus, cancelInvoiceTx, sgrToCents0, sgrRands } from '../relational/services';
import {
  buildCustomerIndex, chainStateTx, chainIdentityTx, chainPaymentCreditTx, lockCustomerCreditTx, accountReceiptAvailableTx, CustomerIndex,
} from '../relational/customerCredit';

const SCRIPT = 'repair-historical-credit';
const VIA = 'script:repair-historical-credit';
const KEY_PREFIX = 'historical-credit-repair:';

interface CaseDef {
  key: 'RAIDER' | 'ATC'; kind: 'enable-payment-credit' | 'move-to-account';
  invoiceNumber: string; jobNumber: string; expectedName: string;
  invoiceTotalC: number; receiptC: number; receiptDate: string; method: string; creditC: number;
}
export const CASES: CaseDef[] = [
  { key: 'RAIDER', kind: 'enable-payment-credit', invoiceNumber: 'INV-00207', jobNumber: 'SNS-00222', expectedName: 'Raider Outboards International',
    invoiceTotalC: 20424, receiptC: 200000, receiptDate: '2026-11-18', method: 'EFT', creditC: 179576 },
  { key: 'ATC', kind: 'move-to-account', invoiceNumber: 'INV-00239', jobNumber: 'SNS-00253', expectedName: 'Advanced Tactical Craft (PTY) LTD - ATC Marine',
    invoiceTotalC: 0, receiptC: 200000, receiptDate: '2026-11-18', method: 'EFT', creditC: 200000 },
];
const ATC_REASON = 'No invoice was required: the R2,000.00 EFT received on 2026-11-18 is a payment on account. ' +
  'It was moved to Customer Credits as a payment on account by the historical credit repair of 2026-11-26.';

const log = (s: string) => console.log(s);
const norm = (s: unknown) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase();
const R = (c: number | null | undefined) => (c == null ? 'n/a' : 'R' + sgrRands(c).toFixed(2));
const blank = (v: unknown) => v == null || String(v).trim() === '';

interface Inspection {
  def: CaseDef; state: 'pending' | 'done' | 'refused'; problems: string[]; notes: string[];
  facts: Record<string, any>; plan: Record<string, any> | null; before: Record<string, any>;
}

async function customersFromPlatformState(client: Client): Promise<{ list: Array<{ ref: string; name: string; former: string[] }>; raw: any[] }> {
  const r = await client.query(`SELECT data -> 'customers' AS c FROM platform_state WHERE id = 1`);
  const raw = Array.isArray(r.rows[0]?.c) ? r.rows[0].c : [];
  const list = raw.filter((c: any) => c && c.id !== undefined && c.id !== null).map((c: any) => ({
    ref: String(c.id), name: String(c.companyName || ''), former: Array.isArray(c.formerNames) ? c.formerNames.map(String) : [],
  }));
  return { list, raw };
}

async function inspect(client: Client, def: CaseDef, idx: CustomerIndex, rawCustomers: any[], lock: boolean): Promise<Inspection> {
  const c = client as any;
  const problems: string[] = []; const notes: string[] = []; const facts: Record<string, any> = {}; const before: Record<string, any> = {};
  const out = (state: Inspection['state'], plan: Record<string, any> | null = null): Inspection => ({ def, state, problems, notes, facts, plan, before });
  const FU = lock ? ' FOR UPDATE' : '';

  const jobs = (await client.query(`SELECT * FROM rel_jobs WHERE UPPER(BTRIM(job_number)) = $1 ORDER BY id`, [def.jobNumber])).rows;
  const invs = (await client.query(`SELECT * FROM rel_invoices WHERE UPPER(BTRIM(invoice_number)) = $1 ORDER BY id`, [def.invoiceNumber])).rows;
  facts.jobsFound = jobs.map((j: any) => ({ id: Number(j.id), company: j.company_code, number: j.job_number }));
  facts.invoicesFound = invs.map((i: any) => ({ id: Number(i.id), company: i.company_code, number: i.invoice_number, status: i.status }));
  if (jobs.length !== 1) { problems.push(`expected exactly one job ${def.jobNumber}, found ${jobs.length}`); return out('refused'); }
  if (invs.length !== 1) { problems.push(`expected exactly one invoice ${def.invoiceNumber}, found ${invs.length}`); return out('refused'); }
  // lock order (as cancelInvoice): job, then invoice
  const job = lock ? (await client.query(`SELECT * FROM rel_jobs WHERE id = $1${FU}`, [jobs[0].id])).rows[0] : jobs[0];
  const inv = lock ? (await client.query(`SELECT * FROM rel_invoices WHERE id = $1${FU}`, [invs[0].id])).rows[0] : invs[0];
  const co = String(inv.company_code);
  facts.company = co;
  facts.invoice = { id: Number(inv.id), number: inv.invoice_number, status: inv.status, rowVersion: Number(inv.row_version), jobId: inv.job_id == null ? null : Number(inv.job_id),
    quoteId: inv.quote_id == null ? null : Number(inv.quote_id), customerRef: inv.customer_ref, contactName: inv.contact_name, issueDate: inv.issue_date,
    cancelledVia: inv.legacy_data?.cancelledVia ?? null, cancelledReason: inv.legacy_data?.cancelledReason ?? null };
  facts.job = { id: Number(job.id), number: job.job_number, company: job.company_code, invoiceNum: job.invoice_num, quoteId: job.quote_id == null ? null : Number(job.quote_id),
    customerRef: job.customer_ref, customerName: job.customer_name_raw, rowVersion: Number(job.row_version) };
  before.invoice = inv; before.job = job;
  if (String(job.company_code) !== co) problems.push(`job ${def.jobNumber} is in company ${job.company_code} but invoice ${def.invoiceNumber} is in company ${co}`);

  const done = def.kind === 'move-to-account' && String(inv.status) === 'void';
  if (!done) {
    const linked = (inv.job_id != null && Number(inv.job_id) === Number(job.id)) || norm(job.invoice_num) === norm(def.invoiceNumber);
    if (!linked) problems.push(`invoice ${def.invoiceNumber} is not linked to job ${def.jobNumber} (invoice.job_id=${inv.job_id}, job.invoice_num=${job.invoice_num})`);
  }

  // the transaction chain the money sits on
  const anchor: ['invoice' | 'job', number] = done ? ['job', Number(job.id)] : ['invoice', Number(inv.id)];
  const st = await chainStateTx(c, anchor[0], anchor[1]);
  const quote = st.chain.quoteId != null ? (await client.query(`SELECT * FROM rel_quotes WHERE id = $1${FU}`, [st.chain.quoteId])).rows[0] : null;
  if (quote) before.quote = quote;
  facts.quote = quote ? { id: Number(quote.id), number: quote.quote_number, company: quote.company_code, customerRef: quote.customer_ref } : null;
  facts.chain = { owners: st.chain.owners, payable: R(st.payableC), paid: R(st.paidC), outstanding: R(st.outstandingC), excess: R(st.excessC) };
  const types = st.chain.owners.map((o) => o.type); const ids = st.chain.owners.map((o) => o.id);
  const pays = (await client.query(
    `SELECT p.*, p.payment_date::text AS payment_date_text FROM rel_payments p JOIN UNNEST($1::text[], $2::bigint[]) AS c(t, i) ON p.owner_type = c.t AND p.owner_id = c.i ORDER BY p.id${lock ? ' FOR UPDATE OF p' : ''}`,
    [types, ids])).rows;
  before.payments = pays;
  facts.payments = pays.map((p: any) => ({ id: Number(p.id), owner: `${p.owner_type}#${p.owner_id}`, amount: R(sgrToCents0(p.amount)), date: p.payment_date_text, method: p.method,
    reference: p.reference, kind: p.entry_kind, creditEligible: p.credit_eligible, creditLinkId: p.credit_link_id, rowVersion: Number(p.row_version), createdAt: p.created_at,
    repairMarker: p.legacy_data?.historicalCreditRepair ? true : false }));
  const money = pays.filter((p: any) => sgrToCents0(p.amount) !== 0);
  const payIds = pays.map((p: any) => Number(p.id));
  const allocs = (await client.query(
    `SELECT * FROM rel_credit_allocations WHERE (source_type = 'payment' AND source_payment_id = ANY($1::bigint[]))
        OR (target_owner_type, target_owner_id) IN (SELECT * FROM UNNEST($2::text[], $3::bigint[])) ORDER BY id`, [payIds, types, ids])).rows;
  const refunds = (await client.query(`SELECT * FROM rel_credit_refunds WHERE source_type = 'payment' AND source_payment_id = ANY($1::bigint[]) ORDER BY id`, [payIds])).rows;
  facts.allocations = allocs.map((a: any) => ({ id: Number(a.id), source: a.source_type, amount: R(sgrToCents0(a.amount)), status: a.status, target: `${a.target_owner_type}#${a.target_owner_id}` }));
  facts.refunds = refunds.map((f: any) => ({ id: Number(f.id), amount: R(sgrToCents0(f.amount)), status: f.status }));

  // the customer: canonical id, the expected name, and anyone else with that name
  const ident = await chainIdentityTx(c, st.chain, idx);
  facts.identity = ident;
  const sameName = rawCustomers.filter((x) => x && norm(x.companyName) === norm(def.expectedName)).map((x) => String(x.id));
  facts.customersNamedExpected = sameName;
  const docRefs = [inv.customer_ref, job.customer_ref, quote ? quote.customer_ref : null].filter((x) => !blank(x)).map(String);
  facts.documentCustomerRefs = docRefs;
  if (ident.state !== 'matched') problems.push(`the documents' customer is not resolved: ${ident.detail}`);
  else {
    if (norm(ident.name) !== norm(def.expectedName)) problems.push(`the documents belong to "${ident.name}" [${ident.ref}], not "${def.expectedName}"`);
    if (sameName.length !== 1) problems.push(`${sameName.length} customer records are named "${def.expectedName}" (${sameName.join(', ') || 'none'}) — expected exactly one`);
    else if (sameName[0] !== ident.ref) problems.push(`the documents resolve to customer ${ident.ref}, but the customer named "${def.expectedName}" is ${sameName[0]}`);
    if (docRefs.some((r) => r !== ident.ref)) problems.push(`the documents carry different customer links (${docRefs.join(', ')})`);
    if (ident.via !== 'link') notes.push(`customer resolved by ${ident.via} (the documents carry no customer link)`);
  }
  const ref = ident.state === 'matched' ? ident.ref : null;
  facts.customerRef = ref;

  // existing payments on account for this customer + the repair's own key
  const acc = ref ? (await client.query(`SELECT *, receipt_date::text AS receipt_date_text FROM rel_account_receipts WHERE company_code = $1 AND customer_ref = $2 ORDER BY id`, [co, ref])).rows : [];
  const mine = (await client.query(`SELECT *, receipt_date::text AS receipt_date_text FROM rel_account_receipts WHERE client_request_id LIKE $1 ORDER BY id`, [KEY_PREFIX + def.invoiceNumber + ':%'])).rows;
  facts.accountReceipts = acc.map((a: any) => ({ id: Number(a.id), amount: R(sgrToCents0(a.amount)), date: a.receipt_date_text, reference: a.reference, status: a.status, key: a.client_request_id }));
  const pc = await chainPaymentCreditTx(c, st);
  facts.paymentCreditNow = R(pc.poolC);
  if (problems.length) return out('refused');

  // ── RAIDER ─────────────────────────────────────────────────────────────────
  if (def.kind === 'enable-payment-credit') {
    if (String(inv.status) === 'void') { problems.push(`invoice ${def.invoiceNumber} is cancelled`); return out('refused'); }
    const repaired = money.filter((x: any) => x.legacy_data?.historicalCreditRepair);
    if (repaired.length) {
      // Already repaired: later use of the credit (allocations, refunds) is normal and is not re-checked.
      const ok1 = repaired.length === 1 && repaired[0].credit_eligible === true && repaired[0].entry_kind === 'receipt' && sgrToCents0(repaired[0].amount) === def.receiptC;
      if (!ok1) { problems.push('a repair marker is present but the receipt is not in the repaired state — stop for review'); return out('refused'); }
      notes.push(`already repaired (payment #${repaired[0].id}; payment credit available now ${R(pc.poolC)}, ${allocs.length} allocation(s), ${refunds.length} refund(s) since)`);
      return out('done');
    }
    if (st.payableC !== def.invoiceTotalC) problems.push(`amount due on the chain is ${R(st.payableC)}, expected ${R(def.invoiceTotalC)}`);
    if (money.length !== 1) problems.push(`expected exactly one payment on the chain, found ${money.length}`);
    const p = money[0];
    if (p) {
      if (sgrToCents0(p.amount) !== def.receiptC) problems.push(`the payment is ${R(sgrToCents0(p.amount))}, expected ${R(def.receiptC)}`);
      if (p.payment_date_text !== def.receiptDate) problems.push(`the payment is dated ${p.payment_date_text}, expected ${def.receiptDate}`);
      if (norm(p.method) !== norm(def.method)) problems.push(`the payment method is "${p.method}", expected "${def.method}"`);
      if (!(p.entry_kind == null || p.entry_kind === 'receipt')) problems.push(`the payment is a "${p.entry_kind}" entry, not a receipt`);
      if (p.credit_link_id != null) problems.push(`the payment carries a credit link (${p.credit_link_id})`);
      if (blank(p.reference)) notes.push('the original receipt has NO bank reference (it stays blank; none is invented)');
    }
    if (st.paidC !== def.receiptC) problems.push(`paid on the chain is ${R(st.paidC)}, expected ${R(def.receiptC)}`);
    if (allocs.length || refunds.length) problems.push(`credit has already been allocated or refunded on this chain (${allocs.length} allocation(s), ${refunds.length} refund(s)) — stop for review`);
    if (problems.length) return out('refused');
    if (p.credit_eligible === true) {
      if (p.legacy_data?.historicalCreditRepair && p.entry_kind === 'receipt') { notes.push('already repaired'); return out('done'); }
      problems.push('the receipt is already credit-eligible but was not marked by this repair — stop for review'); return out('refused');
    }
    if (pc.poolC !== 0) { problems.push(`the chain already shows ${R(pc.poolC)} of payment credit`); return out('refused'); }
    return out('pending', {
      case: def.key, action: 'mark the receipt as credit-eligible', company: co, customerRef: ref,
      invoice: { id: Number(inv.id), number: inv.invoice_number, rowVersion: Number(inv.row_version) },
      payment: { id: Number(p.id), rowVersion: Number(p.row_version), amountC: sgrToCents0(p.amount), date: p.payment_date_text, method: p.method, reference: p.reference ?? null },
      expectedCreditC: def.creditC,
    });
  }

  // ── ATC ────────────────────────────────────────────────────────────────────
  if (done) {
    if (inv.legacy_data?.cancelledVia !== VIA) { problems.push(`invoice ${def.invoiceNumber} is already cancelled, but not by this repair — stop for review`); return out('refused'); }
    if (mine.length !== 1 || mine[0].status !== 'active') { problems.push(`invoice ${def.invoiceNumber} was cancelled by this repair but its payment on account is ${mine.length ? mine[0].status : 'missing'} — stop for review`); return out('refused'); }
    if (money.length) notes.push(`${money.length} payment(s) recorded on the job/quote since the repair (normal later activity; not touched)`);
    notes.push(`already repaired (payment on account #${mine[0].id})`); return out('done');
  }
  if (mine.length) { problems.push(`a payment on account from this repair already exists (#${mine[0].id}) while ${def.invoiceNumber} is not cancelled — half-done state, stop for review`); return out('refused'); }
  if (st.payableC !== def.invoiceTotalC && !(st.payableC === null && def.invoiceTotalC === 0)) problems.push(`amount due on the chain is ${R(st.payableC)}, expected ${R(def.invoiceTotalC)}`);
  if (money.length !== 1) problems.push(`expected exactly one payment on the chain, found ${money.length}`);
  const p = money[0];
  if (p) {
    if (sgrToCents0(p.amount) !== def.receiptC) problems.push(`the payment is ${R(sgrToCents0(p.amount))}, expected ${R(def.receiptC)}`);
    if (p.payment_date_text !== def.receiptDate) problems.push(`the payment is dated ${p.payment_date_text}, expected ${def.receiptDate}`);
    if (norm(p.method) !== norm(def.method)) problems.push(`the payment method is "${p.method}", expected "${def.method}"`);
    if (!(p.entry_kind == null || p.entry_kind === 'receipt')) problems.push(`the payment is a "${p.entry_kind}" entry, not a receipt`);
    if (p.credit_link_id != null) problems.push(`the payment carries a credit link (${p.credit_link_id})`);
    if (blank(p.reference)) notes.push('the original receipt has NO bank reference (the payment on account keeps it blank; none is invented)');
  }
  if (allocs.length || refunds.length) problems.push(`credit has already been allocated or refunded on this chain (${allocs.length} allocation(s), ${refunds.length} refund(s)) — stop for review`);
  if (problems.length) return out('refused');
  return out('pending', {
    case: def.key, action: 'move the receipt to a payment on account and cancel the invoice', company: co, customerRef: ref, customerName: ident.state === 'matched' ? ident.name : null,
    invoice: { id: Number(inv.id), number: inv.invoice_number, rowVersion: Number(inv.row_version), status: inv.status },
    job: { id: Number(job.id), number: job.job_number, rowVersion: Number(job.row_version) },
    quote: quote ? { id: Number(quote.id), number: quote.quote_number } : null,
    payment: { id: Number(p.id), rowVersion: Number(p.row_version), owner: `${p.owner_type}#${p.owner_id}`, sourceId: p.source_id, amountC: sgrToCents0(p.amount), date: p.payment_date_text,
      method: p.method, reference: p.reference ?? null, notes: p.notes ?? null, createdAt: p.created_at },
    accountReceiptKey: `${KEY_PREFIX}${def.invoiceNumber}:${Number(p.id)}`,
    cancelReason: ATC_REASON,
  });
}

function fingerprintOf(plans: Record<string, any>[]): string {
  const stable = JSON.stringify(plans, (_k, v) => (v instanceof Date ? v.toISOString() : v));
  return crypto.createHash('sha256').update(stable).digest('hex').slice(0, 16);
}
function confirmOf(pending: Inspection[]): string { return 'REPAIR ' + pending.map((i) => i.def.invoiceNumber).join(' AND '); }

function print(ins: Inspection[], mode: string): void {
  for (const i of ins) {
    log(`── ${i.def.key}  ${i.def.invoiceNumber} / ${i.def.jobNumber}  "${i.def.expectedName}" ─────────────`);
    log(`state:     ${i.state.toUpperCase()}`);
    const f = i.facts;
    if (f.company !== undefined) log(`company:   ${f.company}`);
    if (f.identity) log(`customer:  ${f.identity.state === 'matched' ? `${f.identity.name} [${f.identity.ref}] via ${f.identity.via}` : 'UNRESOLVED — ' + f.identity.detail}   (customers named "${i.def.expectedName}": ${(f.customersNamedExpected || []).join(', ') || 'none'}; document links: ${(f.documentCustomerRefs || []).join(', ') || 'none'})`);
    if (f.invoice) log(`invoice:   #${f.invoice.id} ${f.invoice.number} status=${f.invoice.status} v${f.invoice.rowVersion} job_id=${f.invoice.jobId} quote_id=${f.invoice.quoteId} issued=${f.invoice.issueDate || '—'}${f.invoice.cancelledVia ? ` cancelledVia=${f.invoice.cancelledVia}` : ''}`);
    if (f.job) log(`job:       #${f.job.id} ${f.job.number} company=${f.job.company} invoice_num=${f.job.invoiceNum ?? '—'} v${f.job.rowVersion}`);
    if (f.quote !== undefined) log(`quote:     ${f.quote ? `#${f.quote.id} ${f.quote.number}` : 'none'}`);
    if (f.chain) log(`chain:     ${f.chain.owners.map((o: any) => o.type + '#' + o.id).join(' → ')}   due ${f.chain.payable}  paid ${f.chain.paid}  outstanding ${f.chain.outstanding}  excess ${f.chain.excess}`);
    for (const p of f.payments || []) log(`payment:   #${p.id} on ${p.owner}  ${p.amount}  ${p.date}  ${p.method}  ref=${blank(p.reference) ? '(BLANK)' : JSON.stringify(p.reference)}  kind=${p.kind ?? 'historical'}  creditEligible=${p.creditEligible}${p.repairMarker ? '  [repaired]' : ''}  v${p.rowVersion}`);
    if (f.allocations) log(`credit:    payment credit now ${f.paymentCreditNow}; ${f.allocations.length} allocation(s), ${f.refunds.length} refund(s) on this chain`);
    if (f.accountReceipts) log(`on account: ${f.accountReceipts.length ? f.accountReceipts.map((a: any) => `#${a.id} ${a.amount} ${a.date} ${a.status}${a.key ? ' key=' + a.key : ''}`).join('; ') : 'none'}`);
    for (const n of i.notes) log(`NOTE:      ${n}`);
    for (const p of i.problems) log(`REFUSED:   ${p}`);
    if (i.plan && mode !== 'diagnose') {
      const pl = i.plan;
      if (i.def.kind === 'enable-payment-credit') {
        log(`CHANGE:    rel_payments #${pl.payment.id}: entry_kind → 'receipt', credit_eligible false → true, repair marker added (amount, date, method, reference unchanged)`);
        log(`BALANCE:   before — invoice ${i.facts.chain.payable} due, paid ${i.facts.chain.paid}, payment credit R0.00`);
        log(`           after  — invoice unchanged (paid), receipt unchanged, payment credit ${R(pl.expectedCreditC)} for ${pl.customerRef} in company ${pl.company}`);
      } else {
        log(`CHANGE 1:  NEW payment on account: ${R(pl.payment.amountC)}  date ${pl.payment.date}  method ${pl.payment.method}  reference ${blank(pl.payment.reference) ? '(blank, kept blank)' : JSON.stringify(pl.payment.reference)}  customer ${pl.customerRef}  company ${pl.company}  key ${pl.accountReceiptKey}`);
        log(`CHANGE 2:  REMOVE rel_payments #${pl.payment.id} (on ${pl.payment.owner}) — full record backed up locally and in customer_link_audit`);
        log(`CHANGE 3:  CANCEL ${pl.invoice.number} (retained void; number + history kept; job ${pl.job.number}${pl.quote ? ' and quote ' + pl.quote.number : ''} link released)`);
        log(`           reason: ${pl.cancelReason}`);
        log(`BALANCE:   before — ${pl.invoice.number} due ${i.facts.chain.payable}, paid ${i.facts.chain.paid}, payment on account R0.00`);
        log(`           after  — ${pl.invoice.number} cancelled (nothing due), job/quote hold no money, payment on account ${R(pl.payment.amountC)} available`);
      }
    }
    log('');
  }
}

async function counts(client: Client) {
  const r = await client.query(`SELECT (SELECT COUNT(*) FROM rel_payments)::int AS payments, (SELECT COALESCE(SUM(amount),0) FROM rel_payments) AS paid,
    (SELECT COUNT(*) FROM rel_account_receipts)::int AS accounts, (SELECT COUNT(*) FROM rel_credit_notes)::int AS notes,
    (SELECT COUNT(*) FROM rel_credit_allocations)::int AS allocations, (SELECT COUNT(*) FROM rel_credit_refunds)::int AS refunds,
    (SELECT COUNT(*) FROM rel_invoices)::int AS invoices`);
  return r.rows[0];
}

async function applyCase(client: Client, i: Inspection, fp: string, localFile: string, actorLabel: string): Promise<string> {
  const c = client as any; const pl = i.plan!;
  await lockCustomerCreditTx(c, pl.company, pl.customerRef);
  const detail = (extra: Record<string, any>) => JSON.stringify({ case: i.def.key, fingerprint: fp, backupFile: path.basename(localFile), before: i.before, ...extra },
    (_k, v) => (v instanceof Date ? v.toISOString() : v));
  if (i.def.kind === 'enable-payment-credit') {
    const marker = { historicalCreditRepair: { at: new Date().toISOString(), by: actorLabel, fingerprint: fp, invoice: i.def.invoiceNumber,
      reason: 'Authorised 2026-11-26: the excess of this receipt over the invoice is the customer\'s payment credit.', previous: { entry_kind: i.before.payments.find((p: any) => Number(p.id) === pl.payment.id)?.entry_kind ?? null, credit_eligible: false } } };
    const u = await client.query(
      `UPDATE rel_payments SET entry_kind = 'receipt', credit_eligible = true, legacy_data = COALESCE(legacy_data, '{}'::jsonb) || $3::jsonb, row_version = row_version + 1
        WHERE id = $1 AND row_version = $2 AND credit_eligible = false`, [pl.payment.id, pl.payment.rowVersion, JSON.stringify(marker)]);
    if (u.rowCount !== 1) throw new Error(`${i.def.invoiceNumber}: payment #${pl.payment.id} changed while the repair ran. Nothing was written.`);
    await client.query(`INSERT INTO customer_link_audit (actor, action, company_code, from_refs, to_ref, members, detail) VALUES ($1, 'historical-credit-repair', $2, $3::jsonb, $4, $5::jsonb, $6::jsonb)`,
      [actorLabel, pl.company, JSON.stringify([pl.customerRef]), pl.customerRef, JSON.stringify([{ type: 'payment', id: pl.payment.id }, { type: 'invoice', id: pl.invoice.id, number: pl.invoice.number }]),
       detail({ change: 'credit_eligible false -> true', expectedCredit: R(pl.expectedCreditC) })]);
    // verify
    const st = await chainStateTx(c, 'invoice', pl.invoice.id);
    const pc = await chainPaymentCreditTx(c, st);
    const mine = pc.receipts.find((r) => r.paymentId === pl.payment.id);
    if (pc.poolC !== pl.expectedCreditC || !mine || mine.availableC !== pl.expectedCreditC) throw new Error(`${i.def.invoiceNumber}: verification failed — payment credit would be ${R(pc.poolC)}, expected ${R(pl.expectedCreditC)}. Rolled back; nothing written.`);
    return `${i.def.key}: payment #${pl.payment.id} now provides ${R(pc.poolC)} of payment credit (invoice ${pl.invoice.number} unchanged).`;
  }
  // ATC
  const ins = await client.query(
    `INSERT INTO rel_account_receipts (company_code, customer_ref, customer_name, amount, receipt_date, method, reference, notes, client_request_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [pl.company, pl.customerRef, pl.customerName, sgrRands(pl.payment.amountC), pl.payment.date, pl.payment.method, pl.payment.reference ?? '',
     `Moved from the payment recorded on ${pl.invoice.number} (rel_payments #${pl.payment.id}, source ${pl.payment.sourceId}, on ${pl.payment.owner}, recorded ${pl.payment.createdAt instanceof Date ? pl.payment.createdAt.toISOString() : pl.payment.createdAt}) by the historical credit repair of 2026-11-26.`,
     pl.accountReceiptKey, actorLabel]);
  const accId = Number(ins.rows[0].id);
  const del = await client.query(`DELETE FROM rel_payments WHERE id = $1 AND row_version = $2`, [pl.payment.id, pl.payment.rowVersion]);
  if (del.rowCount !== 1) throw new Error(`${i.def.invoiceNumber}: payment #${pl.payment.id} changed while the repair ran. Nothing was written.`);
  const [ownerType, ownerId] = String(pl.payment.owner).split('#');
  if (ownerType !== 'invoice') await recomputeOwnerPaymentStatus(c, ownerType as any, Number(ownerId));
  const cancel = await cancelInvoiceTx(c, pl.invoice.id, null, { reason: pl.cancelReason, actor: { name: actorLabel }, via: VIA });
  if (cancel.alreadyCancelled) throw new Error(`${i.def.invoiceNumber}: was cancelled by someone else while the repair ran. Nothing was written.`);
  await client.query(`INSERT INTO customer_link_audit (actor, action, company_code, from_refs, to_ref, members, detail) VALUES ($1, 'historical-credit-repair', $2, $3::jsonb, $4, $5::jsonb, $6::jsonb)`,
    [actorLabel, pl.company, JSON.stringify([pl.customerRef]), pl.customerRef,
     JSON.stringify([{ type: 'payment', id: pl.payment.id, removed: true }, { type: 'account_receipt', id: accId }, { type: 'invoice', id: pl.invoice.id, number: pl.invoice.number, cancelled: true }]),
     detail({ change: 'payment moved to a payment on account; invoice cancelled', accountReceiptId: accId, clearedJobs: cancel.clearedJobs })]);
  // verify
  const acc = (await client.query('SELECT * FROM rel_account_receipts WHERE id = $1', [accId])).rows[0];
  const avail = await accountReceiptAvailableTx(c, acc);
  const invNow = (await client.query('SELECT status, legacy_data FROM rel_invoices WHERE id = $1', [pl.invoice.id])).rows[0];
  const chain = await resolveTransactionChainTx(c, 'job', pl.job.id);
  const left = await client.query(`SELECT COUNT(*)::int AS n FROM rel_payments p JOIN UNNEST($1::text[], $2::bigint[]) AS c(t, i) ON p.owner_type = c.t AND p.owner_id = c.i WHERE p.amount <> 0`,
    [chain.owners.map((o) => o.type), chain.owners.map((o) => o.id)]);
  if (avail !== pl.payment.amountC || invNow.status !== 'void' || invNow.legacy_data?.cancelledVia !== VIA || Number(left.rows[0].n) !== 0 || chain.invoiceIds.length !== 0) {
    throw new Error(`${i.def.invoiceNumber}: verification failed (available ${R(avail)}, invoice ${invNow.status}, money rows left ${left.rows[0].n}, active invoices ${chain.invoiceIds.length}). Rolled back; nothing written.`);
  }
  return `${i.def.key}: payment on account #${accId} ${R(avail)} available; ${pl.invoice.number} cancelled (kept); old payment #${pl.payment.id} removed (backed up).`;
}

export function scrub(text: string, url: string | undefined): string {
  let s = String(text);
  if (url) { s = s.split(url).join('<DATABASE_URL>'); try { const u = new URL(url); if (u.password) s = s.split(decodeURIComponent(u.password)).join('***').split(u.password).join('***'); } catch { /* not a URL */ } }
  return s.replace(/postgres(ql)?:\/\/[^\s'"]+/gi, '<connection string>');
}
async function connect(timeoutMs: number, attempts: number): Promise<Client> {
  const url = process.env.DATABASE_URL as string; let last: any = null;
  for (let i = 1; i <= attempts; i++) {
    const client = new Client({ connectionString: url, ssl: resolveSsl(url), connectionTimeoutMillis: timeoutMs, keepAlive: true, keepAliveInitialDelayMillis: 10000 });
    client.on('error', (e) => { console.error('[db] connection error: ' + scrub(e && e.message ? e.message : String(e), url)); });
    const t0 = Date.now();
    try { await client.connect(); log(`connected in ${Date.now() - t0} ms (attempt ${i} of ${attempts}; limit ${Math.round(timeoutMs / 1000)}s)`); return client; }
    catch (err: any) {
      last = err; log(`connection attempt ${i} of ${attempts} failed after ${Date.now() - t0} ms: ${scrub(err && err.message ? err.message : String(err), url)}`);
      await client.end().catch(() => undefined);
      if (i < attempts) await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  throw new Error(`could not connect to the database after ${attempts} attempts (limit ${Math.round(timeoutMs / 1000)}s each).\n   ${scrub(describeConnectionError(last), url)}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (n: string): string | undefined => { const a = argv.find((x) => x.startsWith(n + '=')); return a ? a.slice(n.length + 1) : undefined; };
  const APPLY = argv.includes('--apply'); const DIAG = argv.includes('--diagnose');
  const tSec = Math.min(300, Math.max(5, Number(arg('--connect-timeout')) || 30));
  const lockSec = Math.min(120, Math.max(1, Number(arg('--lock-timeout')) || 15));
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set. In PowerShell:  $env:DATABASE_URL = Read-Host "Render External Database URL"'); process.exitCode = 1; return; }
  if (APPLY && DIAG) { console.error('Use --diagnose or --apply, not both.'); process.exitCode = 1; return; }
  const actorLabel = `${VIA} (${os.userInfo().username}@${os.hostname()})`;
  let client: Client | null = null; let inTx = false; let localFile = '';
  try {
    log(`${SCRIPT} — ${APPLY ? 'APPLY' : DIAG ? 'DIAGNOSE (read only)' : 'DRY RUN (read only)'}   cases: ${CASES.map((c) => c.invoiceNumber).join(', ')} only`);
    client = await connect(tSec * 1000, 3);
    await client.query(APPLY ? 'BEGIN' : 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'); inTx = true;
    await client.query(`SET LOCAL lock_timeout = '${lockSec}s'`);
    await client.query(`SET LOCAL statement_timeout = '120s'`);
    const who = (await client.query(`SELECT current_database() AS db, NOW() AS at, current_setting('transaction_read_only') AS ro`)).rows[0];
    log(`database ${who.db}   at ${new Date(who.at).toISOString()}   transaction_read_only=${who.ro}`);
    const has = (await client.query(`SELECT to_regclass('rel_account_receipts') AS a, (SELECT 1 FROM information_schema.columns WHERE table_name = 'rel_payments' AND column_name = 'credit_eligible') AS b`)).rows[0];
    if (!has.a || !has.b) throw new Error('migrations 022_customer_credit and 023_customer_account_receipts must have run on this database first (deploy the backend). Nothing was written.');
    const cust = (await client.query(`SELECT enabled FROM relational_cutover WHERE section = 'customers'`)).rows[0];
    if (cust && cust.enabled === true) throw new Error('customers are relational-authoritative on this database — this repair reads customers from platform_state and was not written for that. Nothing was written.');
    log('');
    const { list, raw } = await customersFromPlatformState(client);
    const idx = buildCustomerIndex(list);
    const before = await counts(client);
    const ins: Inspection[] = [];
    for (const def of CASES) ins.push(await inspect(client, def, idx, raw, APPLY));
    print(ins, DIAG ? 'diagnose' : APPLY ? 'apply' : 'dry-run');
    const refused = ins.filter((i) => i.state === 'refused');
    const pending = ins.filter((i) => i.state === 'pending');
    const plans = pending.map((i) => i.plan!);
    const fp = fingerprintOf(plans);
    if (refused.length) throw new Error(`${refused.map((i) => i.def.invoiceNumber).join(', ')}: the data does not match the expected facts (see REFUSED above). Nothing was written.`);
    if (!APPLY) {
      await client.query('ROLLBACK'); inTx = false;
      if (DIAG) { log('DIAGNOSE — nothing was written. Run without --diagnose for the exact changes and the plan fingerprint.'); return; }
      if (!pending.length) { log('DRY RUN — both cases are already repaired. Nothing to do; nothing was written.'); return; }
      log(`DRY RUN — ${pending.length} case(s) to repair: ${pending.map((i) => i.def.key).join(', ')}. Nothing was written.`);
      log(`plan fingerprint: ${fp}`);
      log('To apply exactly this plan:');
      log(`   node dist/scripts/${SCRIPT}.js --apply "--confirm=${confirmOf(pending)}" --expect=${fp} --connect-timeout=60`);
      return;
    }
    if (!pending.length) { await client.query('ROLLBACK'); inTx = false; log('Both cases are already repaired — nothing written.'); return; }
    if (arg('--expect') !== fp) throw new Error(`the data no longer matches the reviewed dry run (fingerprint now ${fp}, --expect=${arg('--expect') || '(missing)'}). Run the dry run again and review it. Nothing written.`);
    if (arg('--confirm') !== confirmOf(pending)) throw new Error(`--confirm must be exactly "${confirmOf(pending)}". Nothing written.`);
    localFile = path.resolve(process.cwd(), `historical-credit-repair-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(localFile, JSON.stringify({ status: 'WRITTEN BEFORE APPLY (not yet committed)', fingerprint: fp, plans, before: pending.map((i) => ({ case: i.def.key, ...i.before })), countsBefore: before },
      (_k, v) => (v instanceof Date ? v.toISOString() : v), 2), 'utf8');
    log(`BACKUP   ${localFile} (written before any change)`);
    const results: string[] = [];
    for (const i of pending) results.push(await applyCase(client, i, fp, localFile, actorLabel));
    // whole-database invariants: nothing else was created, refunded or removed
    const after = await counts(client);
    const moved = pending.filter((i) => i.def.kind === 'move-to-account').length;
    const expectPaid = (sgrToCents0(before.paid) - pending.filter((i) => i.def.kind === 'move-to-account').reduce((s, i) => s + i.plan!.payment.amountC, 0));
    if (after.payments !== before.payments - moved || sgrToCents0(after.paid) !== expectPaid || after.accounts !== before.accounts + moved
        || after.notes !== before.notes || after.allocations !== before.allocations || after.refunds !== before.refunds || after.invoices !== before.invoices) {
      throw new Error(`verification failed: unexpected record counts after the repair (before ${JSON.stringify(before)}, after ${JSON.stringify(after)}). Rolled back; nothing written.`);
    }
    // the cases now read as repaired
    const again = []; for (const def of CASES) again.push(await inspect(client, def, idx, raw, false));
    if (again.some((i) => i.state !== 'done')) throw new Error(`verification failed: ${again.filter((i) => i.state !== 'done').map((i) => `${i.def.invoiceNumber} is ${i.state}${i.problems.length ? ' (' + i.problems.join('; ') + ')' : ''}`).join(', ')}. Rolled back; nothing written.`);
    await client.query('COMMIT'); inTx = false;
    try { const d = JSON.parse(fs.readFileSync(localFile, 'utf8')); d.status = 'APPLIED (committed ' + new Date().toISOString() + ')'; d.results = results; d.countsAfter = after; fs.writeFileSync(localFile, JSON.stringify(d, null, 2), 'utf8'); } catch { /* already written */ }
    for (const r of results) log(`APPLIED  ${r}`);
    log(`AUDIT    customer_link_audit rows with action 'historical-credit-repair' (before-images included)`);
    log(`LOCAL    ${localFile}   (keep it)`);
    log('Reload every open dashboard tab.');
  } catch (err: any) {
    if (client && inTx) await client.query('ROLLBACK').catch(() => undefined);
    if (localFile && fs.existsSync(localFile)) { const nf = localFile.replace(/\.json$/, '-NOT-APPLIED.json'); try { fs.renameSync(localFile, nf); log(`(backup file renamed ${path.basename(nf)} — nothing was applied)`); } catch { /* ignore */ } }
    console.error('STOPPED: ' + scrub(err && err.message ? err.message : String(err), url));
    process.exitCode = 1;
  } finally {
    if (client) await client.end().catch(() => undefined);
    // services.ts opens a shared pool lazily; this script never uses it, but close it so the process exits.
    try { const p = require('../db/pool').default; if (p && typeof p.end === 'function') await p.end().catch(() => undefined); } catch { /* ignore */ }
  }
}

if (require.main === module) { void main(); }
