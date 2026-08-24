/**
 * relational.invoice-delete-representation.stress.ts
 * ──────────────────────────────────────────────────
 * Regression suite for the reported production failure (2026-08-24):
 *
 *   "I attempted to DELETE AN INVOICE. The invoice did NOT disappear
 *    completely. A VERSION / REPRESENTATION OF THE INVOICE REMAINS."
 *
 * ROOT CAUSE (established empirically, not assumed — see TEST A's revert
 * note): an invoice that belongs to a job is represented TWICE by design
 * (see the header above CREATE TABLE rel_invoices in
 * database/migrations/007_relational_core.sql) — once as a rel_invoices row,
 * and once as invoice linkage stamped on the job itself (invoice_num /
 * invoice_date / invoice_due / invoice_created / invoice_status).
 * createInvoiceForJob writes both halves in one transaction; deleteInvoice
 * used to reverse only the first. FIVE independent list builders in
 * index.html synthesise a job-derived invoice row out of job.invoiceNum and
 * suppress it only while a live accInvoices record references that job:
 *
 *   1. getAllInvoicesUnified()            — dashboard counts + consistency audit
 *   2. Sales -> Invoices   jobInvItems     — index.html ~8442
 *   3. Accounting -> Invoices getJobInvoices() + manualRefs — index.html ~21912/21982
 *   4. Payments tab        invoicedJobs    — index.html ~23286
 *   5. Dashboard revenue tile / revenue chart — index.html ~13670/13862
 *
 * So deleting the invoice deleted the only thing SUPPRESSING the job-side
 * twin: the row stayed listed, under the same number and amount, having
 * silently changed source from 'manual' to 'job' — and became unremovable,
 * because Accounting renders no delete control for a source==='job' row and
 * createInvoiceForJob refuses a job whose invoice_created is already true.
 *
 * Every test below runs against a REAL local Postgres through the real
 * services/read layers, and every frontend assertion executes the SHIPPED
 * function extracted from index.html rather than a re-implementation.
 *
 * SAFETY: refuses to run unless DATABASE_URL points at localhost/127.0.0.1 or
 * ALLOW_UNSAFE_TEST_DB=1 is set. TRUNCATEs only the rel_* tables it owns and
 * never touches platform_state or platform_state_backups.
 *
 * Usage (from backend/):
 *   DATABASE_URL=postgresql://user:pass@localhost:5432/signacore_test \
 *   npx ts-node --transpile-only test/relational.invoice-delete-representation.stress.ts
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import pool from '../src/db/pool';
import * as services from '../src/relational/services';
import { ConcurrencyConflictError, BusinessRuleError } from '../src/relational/services';
import { buildJobsJson, buildInvoicesJson, buildQuotesJson } from '../src/relational/read';

const DB_URL = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(DB_URL) && process.env.ALLOW_UNSAFE_TEST_DB !== '1') {
  console.error('[invoice-delete-representation] Refusing to run: DATABASE_URL does not look like a local test database.');
  process.exit(1);
}
const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH || path.resolve(__dirname, '..', '..', 'index.html');

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

// ── shipped-source extraction ───────────────────────────────────────────────
function extractFunction(src: string, name: string): string {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) throw new Error(`Could not find function ${name} in index.html — renamed or removed?`);
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

const HTML = fs.readFileSync(INDEX_HTML_PATH, 'utf8').replace(/\r\n/g, '\n');

/** Sandbox holding the shipped read-only list builders. */
const listBox: any = { console, Math, Date, parseFloat, parseInt, JSON, Set, Array, Object, isNaN, String, Number };
vm.createContext(listBox);
for (const n of ['getManualInvoiceJobRefs', 'invoiceBelongsToJob', 'getJobManualInvoice',
  'getQuoteInvoice', 'reconcileJobInvoice', 'numSort', 'getAllInvoicesUnified',
  'getPendingJobInvoices', 'getJobInvoices']) {
  vm.runInContext(extractFunction(HTML, n), listBox);
}
// belongsToUserCompany is what actually enforces company isolation in this
// app's UI layer, and locallyChangedSections is the autosave's own diff — both
// are shipped functions, extracted here rather than re-implemented.
const STATE_SECTIONS_SRC = /const STATE_SECTIONS\s*=\s*\[[\s\S]*?\];/.exec(HTML);
if (STATE_SECTIONS_SRC) vm.runInContext(STATE_SECTIONS_SRC[0], listBox);
const HOLDINGS_CONST_SRC = /const HOLDINGS_CO_ID\s*=\s*\d+;/.exec(HTML);
if (HOLDINGS_CONST_SRC) vm.runInContext(HOLDINGS_CONST_SRC[0], listBox);
for (const n of ['isHoldingsUser', 'isHoldingsRecord', 'belongsToUserCompany', 'locallyChangedSections']) {
  try { vm.runInContext(extractFunction(HTML, n), listBox); } catch { /* reported by the test that needs it */ }
}

/**
 * The four list builders that are NOT standalone functions live inline inside
 * their components, so they are modelled here — and each model is pinned to
 * the shipped source by an assertion in TEST J, so it can never silently
 * drift away from what actually ships.
 */
const SALES_JOB_INV_RULE = 'myJobs.filter(j=>j.invoiceNum && !_manualJobRefs.has(j.num))';
const ACCT_MERGE_RULE = 'jobInvoices.filter(j=>!manualRefs.has(j.jobNum))';
const PAYMENTS_TAB_RULE = 'const invoicedJobs = visibleJobs.filter(j=>j.invoiceNum);';
const DASHBOARD_REVENUE_RULE = '.filter(j=>([7,8,9].includes(j.stage)||j.invoiceNum) && !manualRefs.has(j.num)';

function salesInvoiceList(jobs: any[], quotes: any[], accInvoices: any[]) {
  const refs = listBox.getManualInvoiceJobRefs(accInvoices);
  const jobInvItems = jobs.filter((j) => j.invoiceNum && !refs.has(j.num))
    .map((j) => ({ invoiceNum: j.invoiceNum, num: j.num, _isManual: false }));
  const manualInvItems = accInvoices.filter((i) => i.status !== 'void')
    .map((i) => ({ invoiceNum: i.number, num: 'manual', _isManual: true }));
  return [...jobInvItems, ...manualInvItems];
}
function accountingInvoiceList(jobs: any[], quotes: any[], accInvoices: any[]) {
  listBox.jobs = jobs; listBox.quotes = quotes;
  const jobInvoices = listBox.getJobInvoices();
  const manualRefs = listBox.getManualInvoiceJobRefs(accInvoices);
  const jobInvsFiltered = jobInvoices.filter((j: any) => !manualRefs.has(j.jobNum));
  return [
    ...accInvoices.filter((i: any) => i && i.status !== 'void').map((i: any) => ({ ...i, source: i.source || 'manual' })),
    ...jobInvsFiltered,
  ];
}
function paymentsTabList(jobs: any[]) { return jobs.filter((j) => j.invoiceNum); }
function dashboardRevenueJobs(jobs: any[], accInvoices: any[]) {
  const refs = listBox.getManualInvoiceJobRefs(accInvoices);
  return jobs.filter((j) => ([7, 8, 9].includes(j.stage) || j.invoiceNum) && !refs.has(j.num));
}

/** All five surfaces at once — "does ANY representation of this number remain?" */
async function everyRepresentationOf(invoiceNumber: string) {
  const jobs = await buildJobsJson();
  const accInvoices = await buildInvoicesJson();
  const quotes = await buildQuotesJson();
  const unified = listBox.getAllInvoicesUnified(jobs, quotes, accInvoices);
  const sales = salesInvoiceList(jobs, quotes, accInvoices);
  const acct = accountingInvoiceList(jobs, quotes, accInvoices);
  const pays = paymentsTabList(jobs);
  const dash = dashboardRevenueJobs(jobs, accInvoices);
  return {
    jobs, accInvoices, quotes, unified, sales, acct, pays, dash,
    relRows: accInvoices.filter((i: any) => i.number === invoiceNumber).length,
    inUnified: unified.filter((i: any) => i.number === invoiceNumber).length,
    inSales: sales.filter((i: any) => i.invoiceNum === invoiceNumber).length,
    inAcct: acct.filter((i: any) => i.number === invoiceNumber).length,
    inPayments: pays.filter((j: any) => j.invoiceNum === invoiceNumber).length,
    inDashboard: dash.filter((j: any) => j.invoiceNum === invoiceNumber).length,
    total() {
      return this.relRows + this.inUnified + this.inSales + this.inAcct + this.inPayments + this.inDashboard;
    },
  };
}

async function reset() {
  await pool.query(`TRUNCATE TABLE rel_payments, rel_invoice_line_items, rel_invoices, rel_job_line_items,
    rel_jobs, rel_quote_line_items, rel_quotes, rel_credit_notes, rel_inventory_items, rel_customers
    RESTART IDENTITY CASCADE`);
  await pool.query(`DELETE FROM document_number_counters`);
  await pool.query(`DELETE FROM quote_conversions`);
}

async function seedInvoicedJob(companyCode = 'SNS', clientName = 'Delete Probe Client', value = 11500) {
  const cust = await services.createCustomer({ companyName: clientName } as any);
  const job = await services.createJob({
    companyCode, customerId: cust.id, customerNameRaw: clientName,
    description: 'Invoiced job', value, stage: 7, status: 'in_production',
  } as any);
  const inv = await services.createInvoiceForJob(job.id);
  return { cust, job, inv };
}

async function main() {
  console.log('\n════ INVOICE DELETE / SALES vs ACCOUNTING — REGRESSION SUITE ════');

  // ── TEST A — the reported failure: nothing survives a delete ──────────────
  // Revert-verification: with the job-side half of services.deleteInvoice
  // removed, this test fails with inSales/inAcct/inUnified/inPayments/
  // inDashboard all = 1 while relRows = 0 — i.e. exactly the reported
  // "the invoice did not disappear, a representation remains".
  console.log('\n[A] deleting a job-created invoice removes EVERY representation');
  {
    await reset();
    const { job, inv } = await seedInvoicedJob();
    const before = await everyRepresentationOf(inv.invoiceNumber);
    ok(before.relRows === 1, 'A1 precondition: one relational invoice row exists');
    ok(before.inSales === 1 && before.inAcct === 1 && before.inUnified === 1,
      'A2 precondition: it is listed exactly once on Sales, Accounting and the unified list',
      { s: before.inSales, a: before.inAcct, u: before.inUnified });

    const relInv = before.accInvoices.find((i: any) => i.number === inv.invoiceNumber)!;
    const result = await services.deleteInvoice(relInv._relId, relInv._relRowVersion);

    const after = await everyRepresentationOf(inv.invoiceNumber);
    ok(after.relRows === 0, 'A3 the rel_invoices row is gone');
    ok(after.inUnified === 0, 'A4 getAllInvoicesUnified no longer lists it', after.unified);
    ok(after.inSales === 0, 'A5 Sales -> Invoices no longer lists it', after.sales);
    ok(after.inAcct === 0, 'A6 Accounting -> Invoices no longer lists it', after.acct);
    ok(after.inPayments === 0, 'A7 the Payments tab no longer counts it');
    ok(after.inDashboard === 0, 'A8 the dashboard revenue tile no longer counts it');
    ok(after.total() === 0, 'A9 NO representation of the invoice remains anywhere', after.total());
    ok(result.deleted === true && Array.isArray(result.clearedJobs) && result.clearedJobs.length === 1,
      'A10 the delete reports exactly the one job whose linkage it reversed', result.clearedJobs);
    ok(!!result.clearedJobs[0] && result.clearedJobs[0].jobNumber === job.jobNumber,
      'A11 and it is the right job', result.clearedJobs[0]);
  }

  // ── TEST B — the job-side half is fully and precisely reversed ────────────
  console.log('\n[B] the linked job\'s own invoice linkage is fully cleared');
  {
    await reset();
    const { job, inv } = await seedInvoicedJob();
    const stampedRes = await pool.query('SELECT * FROM rel_jobs WHERE id = $1', [job.id]);
    const stamped = stampedRes.rows[0];
    ok(stamped.invoice_num === inv.invoiceNumber && stamped.invoice_created === true,
      'B1 precondition: creating the invoice stamped the job (this is the second representation)');
    const stageBefore = stamped.stage, statusBefore = stamped.status, versionBefore = stamped.row_version;

    const relInv = (await buildInvoicesJson())[0];
    const result = await services.deleteInvoice(relInv._relId, relInv._relRowVersion);

    const clearedRes = await pool.query('SELECT * FROM rel_jobs WHERE id = $1', [job.id]);
    const cleared = clearedRes.rows[0];
    ok(cleared.invoice_num === null, 'B2 invoice_num cleared');
    ok(cleared.invoice_created === false, 'B3 invoice_created cleared');
    ok(cleared.invoice_date === null, 'B4 invoice_date cleared');
    ok(cleared.invoice_due === null, 'B5 invoice_due cleared');
    ok(cleared.invoice_status === null, 'B6 invoice_status cleared');
    ok(cleared.row_version === versionBefore + 1, 'B7 the job\'s row_version was bumped exactly once',
      { before: versionBefore, after: cleared.row_version });
    ok(!!result.clearedJobs[0] && result.clearedJobs[0].rowVersion === cleared.row_version,
      'B8 the delete returns the job\'s NEW row_version so the deleting client stays current');
    // Deliberately NOT reverted — deleting an invoice does not un-install a
    // sign. Pinned so a future change has to be a conscious decision.
    ok(cleared.stage === stageBefore && cleared.status === statusBefore,
      'B9 the job\'s stage/status are deliberately left alone (physical progress is not an invoice)');
    const jobJson = (await buildJobsJson())[0];
    ok(!jobJson.invoiceNum && jobJson.invoiceCreated === false,
      'B10 the read layer hydrates the cleared job with no invoice linkage');
    const pending = listBox.getPendingJobInvoices([jobJson], await buildInvoicesJson());
    ok(pending.length === 1,
      'B11 the job correctly reappears as "invoice-ready but not yet invoiced"');
  }

  // ── TEST C — re-invoiceable, and the number is never reused ──────────────
  console.log('\n[C] the job becomes re-invoiceable and never reuses the deleted number');
  {
    await reset();
    const { job, inv } = await seedInvoicedJob();
    const relInv = (await buildInvoicesJson())[0];
    await services.deleteInvoice(relInv._relId, relInv._relRowVersion);
    let second: any = null, refusal: Error | null = null;
    try { second = await services.createInvoiceForJob(job.id); } catch (e) { refusal = e as Error; }
    ok(refusal === null, 'C1 re-invoicing the job is no longer refused', refusal && refusal.message);
    ok(!!second && !!second.invoiceNumber && second.invoiceNumber !== inv.invoiceNumber,
      'C2 the new invoice gets a DIFFERENT number (the deleted number is not recycled)',
      { deleted: inv.invoiceNumber, minted: second && second.invoiceNumber });
    // Guarded so a REVERT-CHECK run (where C1/C2 legitimately fail and no
    // replacement invoice exists) still reports every remaining assertion
    // instead of aborting the suite on a null dereference.
    if (second && second.invoiceNumber) {
      const rep = await everyRepresentationOf(second.invoiceNumber);
      ok(rep.relRows === 1 && rep.inUnified === 1 && rep.inSales === 1 && rep.inAcct === 1,
        'C3 the replacement invoice is listed exactly once on every surface',
        { r: rep.relRows, u: rep.inUnified, s: rep.inSales, a: rep.inAcct });
    } else {
      ok(false, 'C3 the replacement invoice is listed exactly once on every surface', 'no replacement invoice was minted');
    }
    const old = await everyRepresentationOf(inv.invoiceNumber);
    ok(old.total() === 0, 'C4 the deleted number is still gone from every surface');
  }

  // ── TEST D — a standalone manual invoice: unchanged behaviour ────────────
  console.log('\n[D] deleting a standalone manual invoice touches no job');
  {
    await reset();
    const { job } = await seedInvoicedJob('SNS', 'Untouched Client', 5000);
    const keeper = await pool.query('SELECT invoice_num, invoice_created, row_version FROM rel_jobs WHERE id = $1', [job.id]);
    const manual = await services.createManualInvoice({
      companyCode: 'SNS', contactName: 'Walk-in', lines: [{ qty: 1, unitAmount: 500 }],
    } as any);
    const res = await services.deleteInvoice(manual.id, manual.rowVersion);
    ok(res.clearedJobs.length === 0, 'D1 no job linkage was cleared', res.clearedJobs);
    const after = await pool.query('SELECT invoice_num, invoice_created, row_version FROM rel_jobs WHERE id = $1', [job.id]);
    ok(after.rows[0].invoice_num === keeper.rows[0].invoice_num
      && after.rows[0].row_version === keeper.rows[0].row_version,
      'D2 the unrelated invoiced job is untouched, row_version included');
    const rep = await everyRepresentationOf(manual.invoiceNumber);
    ok(rep.total() === 0, 'D3 the manual invoice itself is gone from every surface');
  }

  // ── TEST E — manual invoice referencing an un-invoiced job ───────────────
  console.log('\n[E] deleting a manual invoice raised against an un-invoiced job');
  {
    await reset();
    const cust = await services.createCustomer({ companyName: 'E Client' } as any);
    const job = await services.createJob({
      companyCode: 'SNS', customerId: cust.id, customerNameRaw: 'E Client',
      description: 'E job', value: 2300, stage: 7, status: 'in_production',
    } as any);
    const manual = await services.createManualInvoice({
      companyCode: 'SNS', contactName: 'E Client', reference: job.jobNumber,
      lines: [{ qty: 1, unitAmount: 2000 }],
    } as any);
    const before = await everyRepresentationOf(manual.invoiceNumber);
    ok(before.inSales === 1 && before.inAcct === 1, 'E1 precondition: listed once, not twice',
      { s: before.inSales, a: before.inAcct });
    const res = await services.deleteInvoice(manual.id, manual.rowVersion);
    ok(res.clearedJobs.length === 0, 'E2 the job carried no invoice number, so nothing was cleared');
    const jobRow = await pool.query('SELECT invoice_num, invoice_created FROM rel_jobs WHERE id = $1', [job.id]);
    ok(jobRow.rows[0].invoice_num === null && jobRow.rows[0].invoice_created === false,
      'E3 no invoice linkage was invented on the job');
    const after = await everyRepresentationOf(manual.invoiceNumber);
    ok(after.total() === 0, 'E4 nothing remains of the deleted invoice');
    const jobJson = (await buildJobsJson())[0];
    ok(listBox.getPendingJobInvoices([jobJson], await buildInvoicesJson()).length === 1,
      'E5 the job returns to "ready to invoice but not yet invoiced"');
  }

  // ── TEST F — quote-originated invoice relinked to a job ─────────────────
  console.log('\n[F] deleting a quote-originated invoice relinked on conversion');
  {
    await reset();
    const cust = await services.createCustomer({ companyName: 'F Client' } as any);
    const quote = await services.createQuote({
      companyCode: 'SNS', customerId: cust.id, customerNameRaw: 'F Client',
      description: 'F quote', value: 5750, status: 'accepted',
      lines: [{ desc: 'x', qty: 1, unitPrice: 5000 }],
    } as any);
    const manual = await services.createManualInvoice({
      companyCode: 'SNS', contactName: 'F Client', lines: [{ qty: 1, unitAmount: 5000 }],
    } as any);
    await pool.query('UPDATE rel_invoices SET quote_id = $1, quote_number_raw = $2 WHERE id = $3',
      [quote.id, quote.quoteNumber, manual.id]);
    const conv = await services.convertQuoteToJob(quote.id);
    const linked = await pool.query('SELECT job_id, reference FROM rel_invoices WHERE id = $1', [manual.id]);
    ok(linked.rows[0].job_id !== null && linked.rows[0].reference === conv.jobNumber,
      'F1 precondition: conversion relinked the existing invoice to the job');
    const before = await everyRepresentationOf(manual.invoiceNumber);
    ok(before.inSales === 1 && before.inAcct === 1, 'F2 precondition: still listed exactly once');
    const relInv = (await buildInvoicesJson())[0];
    const res = await services.deleteInvoice(relInv._relId, relInv._relRowVersion);
    ok(res.clearedJobs.length === 0,
      'F3 this job never carried invoice_num, so there is no job-side half to reverse');
    const after = await everyRepresentationOf(manual.invoiceNumber);
    ok(after.total() === 0, 'F4 nothing remains of the deleted invoice');
    const q = await pool.query('SELECT quote_number, converted_job_id, status FROM rel_quotes WHERE id = $1', [quote.id]);
    ok(q.rows[0].converted_job_id !== null,
      'F5 the source quote and its conversion link are untouched by an invoice delete');
  }

  // ── TEST G — payments: the invoice's die with it, the job's survive ──────
  console.log('\n[G] payment history: invoice payments die with the invoice, job payments do not');
  {
    await reset();
    const { job, inv } = await seedInvoicedJob('SNS', 'G Client', 11500);
    const relInvBefore = (await buildInvoicesJson())[0];
    await services.recordPayment({ type: 'invoice', id: relInvBefore._relId }, 1000, { date: '2026-08-01', method: 'EFT' });
    await services.recordPayment({ type: 'job', id: job.id }, 2500, { date: '2026-08-02', method: 'EFT' });
    const invPaysBefore = await pool.query(`SELECT count(*)::int c FROM rel_payments WHERE owner_type='invoice'`);
    const jobPaysBefore = await pool.query(`SELECT count(*)::int c FROM rel_payments WHERE owner_type='job'`);
    ok(invPaysBefore.rows[0].c === 1 && jobPaysBefore.rows[0].c === 1, 'G1 precondition: one payment of each kind');
    const relInv = (await buildInvoicesJson())[0];
    await services.deleteInvoice(relInv._relId, relInv._relRowVersion);
    const invPaysAfter = await pool.query(`SELECT count(*)::int c FROM rel_payments WHERE owner_type='invoice'`);
    const jobPaysAfter = await pool.query(`SELECT count(*)::int c FROM rel_payments WHERE owner_type='job'`);
    ok(invPaysAfter.rows[0].c === 0, 'G2 the invoice\'s own payment history went with it');
    ok(jobPaysAfter.rows[0].c === 1, 'G3 the JOB\'s own payments are NOT collateral damage');
    const lines = await pool.query(`SELECT count(*)::int c FROM rel_invoice_line_items`);
    ok(lines.rows[0].c === 0, 'G4 the invoice\'s line items cascaded away');
    const jobJson = (await buildJobsJson())[0];
    ok((jobJson.payments || []).length === 1,
      'G5 the read layer still hydrates the job\'s surviving payment', jobJson.payments);
    const rep = await everyRepresentationOf(inv.invoiceNumber);
    ok(rep.total() === 0, 'G6 and no representation of the invoice remains');
  }

  // ── TEST H — company isolation ──────────────────────────────────────────
  console.log('\n[H] company isolation: deleting one company\'s invoice never reaches the other');
  {
    await reset();
    const sns = await seedInvoicedJob('SNS', 'SNS Client', 10000);
    const uts = await seedInvoicedJob('UTS', 'UTS Client', 20000);
    ok(sns.inv.invoiceNumber === uts.inv.invoiceNumber,
      'H1 precondition: both companies legitimately hold the SAME invoice number',
      { sns: sns.inv.invoiceNumber, uts: uts.inv.invoiceNumber });
    const snsRow = await pool.query(`SELECT id, row_version FROM rel_invoices WHERE company_code='SNS'`);
    const res = await services.deleteInvoice(Number(snsRow.rows[0].id), snsRow.rows[0].row_version);
    ok(res.clearedJobs.length === 1 && !!res.clearedJobs[0] && res.clearedJobs[0].jobNumber === sns.job.jobNumber,
      'H2 exactly one job — the SNS one — had its linkage reversed', res.clearedJobs);
    const utsJob = await pool.query('SELECT invoice_num, invoice_created FROM rel_jobs WHERE id = $1', [uts.job.id]);
    ok(utsJob.rows[0].invoice_num === uts.inv.invoiceNumber && utsJob.rows[0].invoice_created === true,
      'H3 the UTS job keeps its identically-numbered invoice linkage');
    const remaining = await pool.query('SELECT company_code, invoice_number FROM rel_invoices');
    ok(remaining.rowCount === 1 && remaining.rows[0].company_code === 'UTS',
      'H4 only the UTS invoice row survives', remaining.rows);
    const snsJob = await pool.query('SELECT invoice_num FROM rel_jobs WHERE id = $1', [sns.job.id]);
    ok(snsJob.rows[0].invoice_num === null, 'H5 the SNS job was cleared');
  }

  // ── TEST I — concurrency and idempotency ────────────────────────────────
  console.log('\n[I] concurrency: a stale delete changes NOTHING at all');
  {
    await reset();
    const { job, inv } = await seedInvoicedJob();
    const relInv = (await buildInvoicesJson())[0];
    let conflict: Error | null = null;
    try { await services.deleteInvoice(relInv._relId, relInv._relRowVersion + 5); }
    catch (e) { conflict = e as Error; }
    ok(conflict instanceof ConcurrencyConflictError, 'I1 a stale expectedVersion is rejected as a conflict', conflict && conflict.message);
    const still = await everyRepresentationOf(inv.invoiceNumber);
    ok(still.relRows === 1, 'I2 the invoice row still exists after the rejected delete');
    const jobRow = await pool.query('SELECT invoice_num, invoice_created FROM rel_jobs WHERE id = $1', [job.id]);
    ok(jobRow.rows[0].invoice_num === inv.invoiceNumber && jobRow.rows[0].invoice_created === true,
      'I3 the JOB-SIDE half was NOT cleared by the rejected delete (the whole reversal is atomic)');

    await services.deleteInvoice(relInv._relId, relInv._relRowVersion);
    let second: Error | null = null;
    try { await services.deleteInvoice(relInv._relId, relInv._relRowVersion); } catch (e) { second = e as Error; }
    ok(second instanceof BusinessRuleError && /not found/.test(second.message),
      'I4 deleting the same invoice twice fails cleanly with "not found"', second && second.message);
    const after = await everyRepresentationOf(inv.invoiceNumber);
    ok(after.total() === 0, 'I5 the double-delete left the (already correct) state intact');
  }

  // ── TEST J — no ghosts, no duplicates, and the models are honest ─────────
  console.log('\n[J] ghost/duplicate audit across a mixed portfolio, and model fidelity');
  {
    await reset();
    const a = await seedInvoicedJob('SNS', 'J Client A', 11500);
    const b = await seedInvoicedJob('SNS', 'J Client B', 23000);
    const standalone = await services.createManualInvoice({
      companyCode: 'SNS', contactName: 'J Walk-in', lines: [{ qty: 1, unitAmount: 750 }],
    } as any);

    const beforeJobs = await buildJobsJson();
    const beforeInvs = await buildInvoicesJson();
    const beforeQuotes = await buildQuotesJson();
    const beforeUnified = listBox.getAllInvoicesUnified(beforeJobs, beforeQuotes, beforeInvs);
    ok(beforeUnified.length === 3, 'J1 precondition: three invoices, no duplicates', beforeUnified.map((i: any) => i.number));
    const dupBefore = beforeUnified.map((i: any) => i.number).filter((n: string, i: number, arr: string[]) => arr.indexOf(n) !== i);
    ok(dupBefore.length === 0, 'J2 precondition: no duplicate numbers', dupBefore);

    const aRow = (await buildInvoicesJson()).find((i: any) => i.number === a.inv.invoiceNumber)!;
    await services.deleteInvoice(aRow._relId, aRow._relRowVersion);

    const jobs = await buildJobsJson(); const invs = await buildInvoicesJson(); const quotes = await buildQuotesJson();
    const unified = listBox.getAllInvoicesUnified(jobs, quotes, invs);
    ok(unified.length === 2, 'J3 exactly one invoice disappeared — no ghost, no orphan', unified.map((i: any) => i.number));
    const numbers = unified.map((i: any) => i.number);
    ok(new Set(numbers).size === numbers.length, 'J4 no duplicate invoice numbers survive the delete', numbers);
    ok(numbers.indexOf(b.inv.invoiceNumber) !== -1 && numbers.indexOf(standalone.invoiceNumber) !== -1,
      'J5 the two untouched invoices are both still present', numbers);
    ok(salesInvoiceList(jobs, quotes, invs).length === 2
      && accountingInvoiceList(jobs, quotes, invs).length === 2,
      'J6 Sales and Accounting agree with each other and with the unified list');
    const consistencyDupes = unified.filter((i: any, ix: number, arr: any[]) =>
      arr.findIndex((o: any) => o.number === i.number) !== ix);
    ok(consistencyDupes.length === 0, 'J7 the consistency audit would raise no duplicate_invoice_number issue');

    // Model fidelity — these three list builders are inline in index.html and
    // are modelled above; pin the shipped rules so the models cannot drift.
    ok(HTML.indexOf(SALES_JOB_INV_RULE) !== -1,
      'J8 Sales -> Invoices still derives its job rows by the modelled rule', SALES_JOB_INV_RULE);
    ok(HTML.indexOf(ACCT_MERGE_RULE) !== -1,
      'J9 Accounting -> Invoices still merges by the modelled rule', ACCT_MERGE_RULE);
    ok(HTML.indexOf(PAYMENTS_TAB_RULE) !== -1,
      'J10 the Payments tab still keys off job.invoiceNum as modelled', PAYMENTS_TAB_RULE);
    ok(HTML.indexOf(DASHBOARD_REVENUE_RULE) !== -1,
      'J11 the dashboard revenue tile still keys off job.invoiceNum as modelled', DASHBOARD_REVENUE_RULE);
  }

  // ── TEST K — the shipped frontend delete handler ────────────────────────
  console.log('\n[K] the shipped AccountingPage deleteInvoice applies the reversal locally');
  {
    const box: any = {
      console, JSON, Object, Array, Set, Number, String, parseFloat, Math, Date,
      alert: (_m: string) => { box.alerted = (box.alerted || []).concat([_m]); },
      window: { confirm: () => true },
      isRelationalAuthoritative: (_s: string) => true,
      describeSaveConflictError: (e: any) => (e && e.message) || 'error',
      accInvoices: [{ id: 'inv-1', number: 'INV-00099', _relId: 7, _relRowVersion: 3, payments: [] }],
      relationalApi: {
        deleteInvoice: async (relId: number, ver: number) => {
          box.calls = (box.calls || []).concat([{ relId, ver }]);
          return { success: true, deleted: true, ambiguousJobs: [],
            clearedJobs: [{ id: 42, sourceId: '42', jobNumber: 'SNS-00112', rowVersion: 9 }] };
        },
      },
      setAccInvoices: (u: any) => { box.accState = u(box.accState); },
      setJobs: (u: any) => { box.jobState = u(box.jobState); },
      syncRelationalBaseline: (section: string, u: any) => {
        box.baseline = box.baseline || {};
        box.baseline[section] = u(box.baseline[section]);
      },
      accState: [{ id: 'inv-1', number: 'INV-00099' }],
      // _relId is hydrated from a Postgres BIGINT, which node-pg returns as a
      // STRING — job 42 carries the real production shape, job 44 the numeric
      // one, so the id matching is proven correct for both.
      jobState: [
        { id: 900, _relId: '42', num: 'SNS-00112', invoiceNum: 'INV-00099', invoiceCreated: true, invoiceDate: '2026-08-01', invoiceDue: '2026-08-31', invoiceStatus: 'pending', _relRowVersion: 8 },
        { id: 901, _relId: '43', num: 'SNS-00113', invoiceNum: 'INV-00100', invoiceCreated: true, _relRowVersion: 4 },
        { id: 902, _relId: 44, num: 'SNS-00114', invoiceNum: 'INV-00099', invoiceCreated: true, invoiceStatus: 'pending', _relRowVersion: 5 },
      ],
    };
    box.baseline = { accInvoices: [{ id: 'inv-1', number: 'INV-00099' }], jobs: box.jobState.slice() };
    vm.createContext(box);
    vm.runInContext(extractFunction(HTML, 'deleteInvoice'), box);
    await vm.runInContext('deleteInvoice("inv-1")', box);

    ok((box.calls || []).length === 1 && box.calls[0].relId === 7 && box.calls[0].ver === 3,
      'K1 the relational delete is called with the record\'s _relId and _relRowVersion', box.calls);
    ok(box.accState.length === 0, 'K2 the accInvoices record is removed from local state');
    ok(box.baseline.accInvoices.length === 0, 'K3 …and from the autosave baseline');
    const cleared = box.jobState.find((j: any) => j._relId === '42');
    const untouched = box.jobState.find((j: any) => j._relId === '43');
    const otherSameNumber = box.jobState.find((j: any) => j._relId === 44);
    ok(!cleared.invoiceNum && cleared.invoiceCreated === false && !cleared.invoiceDate
      && !cleared.invoiceDue && !cleared.invoiceStatus,
      'K4 the reported job\'s local invoice linkage is cleared — no job-derived twin can be synthesised', cleared);
    ok(cleared._relRowVersion === 9,
      'K5 the job\'s local row_version is refreshed from the delete response (no false 409 next edit)');
    ok(otherSameNumber.invoiceNum === 'INV-00099' && otherSameNumber._relRowVersion === 5,
      'K5b a DIFFERENT job carrying the same invoice number, which the server did NOT report, is left alone',
      otherSameNumber);
    ok(untouched.invoiceNum === 'INV-00100' && untouched._relRowVersion === 4,
      'K6 a job the server did NOT report is left completely alone', untouched);
    ok(box.baseline.jobs.find((j: any) => j._relId === '42').invoiceCreated === false,
      'K7 the jobs autosave baseline is synced the same way');
    ok(box.jobState.length === 3 && box.baseline.jobs.length === 3,
      'K7b no job was added to or removed from local state or the baseline by a delete');
    // The handler must never invent a local clear the server did not report.
    ok(HTML.indexOf('(delResult && delResult.clearedJobs) || []') !== -1,
      'K8 the handler only ever clears jobs the SERVER reported clearing');
    ok(HTML.indexOf("guardAction('deleteInvoice:'+inv.id") !== -1,
      'K9 the delete button keeps its in-flight duplicate-submission guard');

    // K10/K11 — behavioural versions of K8: a response that reports nothing,
    // and a page with no setJobs at all, must both leave every job untouched
    // rather than the handler inventing a clear of its own.
    const quietBox: any = { ...box };
    quietBox.calls = [];
    quietBox.accState = [{ id: 'inv-1', number: 'INV-00099' }];
    quietBox.jobState = [{ id: 900, _relId: '42', num: 'SNS-00112', invoiceNum: 'INV-00099', invoiceCreated: true, _relRowVersion: 8 }];
    quietBox.baseline = { accInvoices: [{ id: 'inv-1', number: 'INV-00099' }], jobs: quietBox.jobState.slice() };
    quietBox.setAccInvoices = (u: any) => { quietBox.accState = u(quietBox.accState); };
    quietBox.setJobs = (u: any) => { quietBox.jobState = u(quietBox.jobState); };
    quietBox.syncRelationalBaseline = (section: string, u: any) => { quietBox.baseline[section] = u(quietBox.baseline[section]); };
    quietBox.relationalApi = { deleteInvoice: async () => ({ success: true, deleted: true }) };
    vm.createContext(quietBox);
    vm.runInContext(extractFunction(HTML, 'deleteInvoice'), quietBox);
    await vm.runInContext('deleteInvoice("inv-1")', quietBox);
    ok(quietBox.accState.length === 0, 'K10 a response with no clearedJobs still removes the invoice');
    ok(quietBox.jobState[0].invoiceNum === 'INV-00099' && quietBox.jobState[0]._relRowVersion === 8,
      'K10b …and touches no job at all', quietBox.jobState[0]);

    const noSetJobsBox: any = { ...quietBox };
    noSetJobsBox.setJobs = undefined;
    noSetJobsBox.accState = [{ id: 'inv-1', number: 'INV-00099' }];
    noSetJobsBox.jobState = [{ id: 900, _relId: '42', num: 'SNS-00112', invoiceNum: 'INV-00099', invoiceCreated: true, _relRowVersion: 8 }];
    noSetJobsBox.baseline = { accInvoices: [{ id: 'inv-1', number: 'INV-00099' }], jobs: noSetJobsBox.jobState.slice() };
    noSetJobsBox.setAccInvoices = (u: any) => { noSetJobsBox.accState = u(noSetJobsBox.accState); };
    noSetJobsBox.syncRelationalBaseline = (section: string, u: any) => { noSetJobsBox.baseline[section] = u(noSetJobsBox.baseline[section]); };
    noSetJobsBox.relationalApi = { deleteInvoice: async () => ({ success: true, deleted: true, ambiguousJobs: [], clearedJobs: [{ id: 42, sourceId: '42', jobNumber: 'SNS-00112', rowVersion: 9 }] }) };
    let threw: Error | null = null;
    vm.createContext(noSetJobsBox);
    vm.runInContext(extractFunction(HTML, 'deleteInvoice'), noSetJobsBox);
    try { await vm.runInContext('deleteInvoice("inv-1")', noSetJobsBox); } catch (e) { threw = e as Error; }
    ok(threw === null, 'K11 a page without setJobs does not throw', threw && threw.message);
    ok(noSetJobsBox.accState.length === 0, 'K11b …and the invoice is still removed (the re-read heals the rest)');

    // K12 — the collision notice reaches the user rather than looking like a
    // failed delete.
    const ambigBox: any = { ...quietBox };
    ambigBox.alerted = [];
    ambigBox.alert = (m: string) => { ambigBox.alerted.push(m); };
    ambigBox.accState = [{ id: 'inv-1', number: 'INV-00099' }];
    ambigBox.jobState = [];
    ambigBox.baseline = { accInvoices: [{ id: 'inv-1', number: 'INV-00099' }], jobs: [] };
    ambigBox.setAccInvoices = (u: any) => { ambigBox.accState = u(ambigBox.accState); };
    ambigBox.setJobs = (u: any) => { ambigBox.jobState = u(ambigBox.jobState); };
    ambigBox.syncRelationalBaseline = (section: string, u: any) => { ambigBox.baseline[section] = u(ambigBox.baseline[section]); };
    ambigBox.relationalApi = { deleteInvoice: async () => ({ success: true, deleted: true, clearedJobs: [], ambiguousJobs: [{ id: 1, jobNumber: 'SNS-00112' }, { id: 2, jobNumber: 'SNS-00113' }] }) };
    vm.createContext(ambigBox);
    vm.runInContext(extractFunction(HTML, 'deleteInvoice'), ambigBox);
    await vm.runInContext('deleteInvoice("inv-1")', ambigBox);
    ok(ambigBox.alerted.length === 1 && /SNS-00112/.test(ambigBox.alerted[0]) && /SNS-00113/.test(ambigBox.alerted[0])
      && /deleted/i.test(ambigBox.alerted[0]),
      'K12 a quarantined numbering collision is explained to the user, naming both jobs',
      ambigBox.alerted);

    // K13 — the confirmation actually warns that a job loses its invoice.
    ok(HTML.indexOf('This invoice belongs to Job ') !== -1
      && HTML.indexOf('ready to invoice but not yet invoiced') !== -1,
      'K13 the confirm dialog tells the user the linked job will lose its invoice number');
  }

  // ── TEST M — the collision case the first pass got WRONG (adversarial) ───
  // rel_jobs has NO uniqueness on (company_code, invoice_num), so two jobs can
  // legitimately carry the same invoice number — the historical collision
  // LegacyInvoiceConflictError quarantines and which must never be
  // auto-resolved. The first version of this fix cleared BOTH, destroying the
  // second job's invoice number, date, due date and payment status and
  // silently dissolving the quarantine. REVERT-CHECK: widening the reversal
  // back to `WHERE company_code = $1 AND invoice_num = $2` fails M3-M6.
  console.log('\n[M] a second job sharing the invoice number is NEVER collateral damage');
  {
    await reset();
    const a = await seedInvoicedJob('SNS', 'M Client A', 11500);
    const custB = await services.createCustomer({ companyName: 'M Client B' } as any);
    const jobB = await services.createJob({
      companyCode: 'SNS', customerId: custB.id, customerNameRaw: 'M Client B',
      description: 'Historical job', value: 8000, stage: 7, status: 'in_production',
    } as any);
    // Exactly what a backfilled historical collision looks like.
    await pool.query(
      `UPDATE rel_jobs SET invoice_num = $1, invoice_date = '2024-03-01', invoice_due = '2024-03-31',
         invoice_status = 'partial', invoice_created = false WHERE id = $2`,
      [a.inv.invoiceNumber, jobB.id]
    );
    let quarantined: Error | null = null;
    try { await services.createInvoiceForJob(jobB.id); } catch (e) { quarantined = e as Error; }
    ok(quarantined !== null && quarantined.constructor.name === 'LegacyInvoiceConflictError',
      'M1 precondition: the collision is quarantined and needs a human decision',
      quarantined && quarantined.message);
    const bBefore = (await pool.query('SELECT * FROM rel_jobs WHERE id = $1', [jobB.id])).rows[0];

    const relInv = (await buildInvoicesJson()).find((i: any) => i.number === a.inv.invoiceNumber)!;
    const res = await services.deleteInvoice(relInv._relId, relInv._relRowVersion);

    ok(res.clearedJobs.length === 1 && res.clearedJobs[0].jobNumber === a.job.jobNumber,
      'M2 only the job this invoice was actually linked to is reported cleared', res.clearedJobs);
    const bAfter = (await pool.query('SELECT * FROM rel_jobs WHERE id = $1', [jobB.id])).rows[0];
    ok(bAfter.invoice_num === bBefore.invoice_num, 'M3 the other job keeps its invoice number');
    ok(String(bAfter.invoice_date) === String(bBefore.invoice_date)
      && String(bAfter.invoice_due) === String(bBefore.invoice_due),
      'M4 …its invoice and due dates');
    ok(bAfter.invoice_status === 'partial', 'M5 …and its payment status');
    ok(bAfter.row_version === bBefore.row_version,
      'M6 its row_version is NOT bumped — no spurious 409 for whoever has it open',
      { before: bBefore.row_version, after: bAfter.row_version });
    // M7 — what the delete must NOT do is rewrite job B. What legitimately
    // follows is that the collision stops being a collision: the quarantine
    // existed because the number was already taken by ANOTHER job's invoice
    // row, and that row is now gone. Job B's own historical claim on the
    // number is untouched and unrewritten, so createInvoiceForJob's legacy
    // branch can finally materialise B's invoice under the number B always
    // carried — verbatim, never re-minted. This is the human decision being
    // ENABLED, not taken: nothing about B changed until someone chose to
    // press Create Invoice on B.
    let bInvoice: any = null, bErr: Error | null = null;
    try { bInvoice = await services.createInvoiceForJob(jobB.id); } catch (e) { bErr = e as Error; }
    ok(bErr === null && !!bInvoice && bInvoice.invoiceNumber === bBefore.invoice_num,
      'M7 job B can later be invoiced under the number IT always carried, unchanged and un-re-minted',
      { err: bErr && bErr.message, minted: bInvoice && bInvoice.invoiceNumber, carried: bBefore.invoice_num });
    const dupCheck = await pool.query('SELECT count(*)::int c FROM rel_invoices WHERE company_code = $1 AND invoice_number = $2',
      ['SNS', bBefore.invoice_num]);
    ok(dupCheck.rows[0].c === 1, 'M7b …and exactly one invoice row holds that number, never two', dupCheck.rows[0]);

    // …and when the invoice carries no job link at all to disambiguate them,
    // NOTHING is cleared and both candidates are reported for review.
    await reset();
    const custC = await services.createCustomer({ companyName: 'M Client C' } as any);
    const j1 = await services.createJob({ companyCode: 'SNS', customerId: custC.id, customerNameRaw: 'M C1', description: 'c1', value: 100, stage: 7, status: 'in_production' } as any);
    const j2 = await services.createJob({ companyCode: 'SNS', customerId: custC.id, customerNameRaw: 'M C2', description: 'c2', value: 200, stage: 7, status: 'in_production' } as any);
    const orphan = await services.createManualInvoice({ companyCode: 'SNS', contactName: 'M Client C', lines: [{ qty: 1, unitAmount: 100 }] } as any);
    await pool.query('UPDATE rel_jobs SET invoice_num = $1, invoice_created = true WHERE id = ANY($2::bigint[])',
      [orphan.invoiceNumber, [j1.id, j2.id]]);
    const amb = await services.deleteInvoice(orphan.id, orphan.rowVersion);
    ok(amb.clearedJobs.length === 0, 'M8 an ambiguous collision clears NO job', amb.clearedJobs);
    ok(amb.ambiguousJobs.length === 2, 'M9 …and reports both candidates for a human to review', amb.ambiguousJobs);
    const bothStill = await pool.query('SELECT count(*)::int c FROM rel_jobs WHERE invoice_num = $1', [orphan.invoiceNumber]);
    ok(bothStill.rows[0].c === 2, 'M10 both jobs keep their invoice numbers untouched');
  }

  // ── TEST N — a job's OWN payments keep their reported status ─────────────
  // The invoice's payments die with it; the JOB's do not — and rel_jobs
  // .invoice_status is the column those surviving payments' status lives in,
  // so it is recomputed rather than nulled. REVERT-CHECK: dropping the
  // recompute and leaving `invoice_status = NULL` fails N3/N4.
  console.log('\n[N] a job paid directly is not reported unpaid after its invoice is deleted');
  {
    await reset();
    const { job } = await seedInvoicedJob('SNS', 'N Client', 1000);
    await services.recordPayment({ type: 'job', id: job.id }, 1000, { date: '2026-08-01', method: 'EFT' });
    const statusBefore = (await pool.query('SELECT invoice_status FROM rel_jobs WHERE id = $1', [job.id])).rows[0].invoice_status;
    ok(statusBefore === 'paid', 'N1 precondition: the job is fully paid by its own payments', statusBefore);
    const relInv = (await buildInvoicesJson())[0];
    await services.deleteInvoice(relInv._relId, relInv._relRowVersion);
    const after = (await pool.query('SELECT invoice_num, invoice_created, invoice_status FROM rel_jobs WHERE id = $1', [job.id])).rows[0];
    ok(after.invoice_num === null && after.invoice_created === false, 'N2 the invoice linkage is still fully cleared');
    ok(after.invoice_status === 'paid',
      'N3 …but the payment status of the job\'s OWN surviving payments is preserved', after.invoice_status);
    const pays = await pool.query(`SELECT count(*)::int c FROM rel_payments WHERE owner_type='job' AND owner_id=$1`, [job.id]);
    ok(pays.rows[0].c === 1, 'N4 and the payments themselves survive');
    // A job with NO payments of its own goes back to a clean NULL — the true
    // reversal of createInvoiceForJob's stamp, not a fabricated 'pending'.
    await reset();
    const clean = await seedInvoicedJob('SNS', 'N Clean', 1000);
    const cleanInv = (await buildInvoicesJson())[0];
    await services.deleteInvoice(cleanInv._relId, cleanInv._relRowVersion);
    const cleanAfter = (await pool.query('SELECT invoice_status FROM rel_jobs WHERE id = $1', [clean.job.id])).rows[0];
    ok(cleanAfter.invoice_status === null, 'N5 a job with no payments of its own is left with no status at all', cleanAfter);
  }

  // ── TEST O — under-reach and text-shape robustness ──────────────────────
  console.log('\n[O] linkage is reversed even when it is not a clean invoice_num match');
  {
    // O1/O2 — invoice_created stranded true with invoice_num already NULL.
    await reset();
    const { job } = await seedInvoicedJob('SNS', 'O Client', 4000);
    await pool.query('UPDATE rel_jobs SET invoice_num = NULL WHERE id = $1', [job.id]);
    const relInv = (await buildInvoicesJson())[0];
    const res = await services.deleteInvoice(relInv._relId, relInv._relRowVersion);
    ok(res.clearedJobs.length === 1, 'O1 the job_id link is followed even with invoice_num already NULL', res.clearedJobs);
    const after = (await pool.query('SELECT invoice_created, invoice_status FROM rel_jobs WHERE id = $1', [job.id])).rows[0];
    ok(after.invoice_created === false && after.invoice_status === null,
      'O2 …so invoice_created/invoice_status cannot be stranded true forever', after);
    const jobJson = (await buildJobsJson())[0];
    ok(listBox.getPendingJobInvoices([jobJson], await buildInvoicesJson()).length === 1,
      'O3 and the job is visible again as "ready to invoice but not yet invoiced"');

    // O4/O5 — a backfilled pair whose case/whitespace disagree, with no
    // job_id on the invoice to fall back on.
    await reset();
    const custP = await services.createCustomer({ companyName: 'O Backfill' } as any);
    const jobP = await services.createJob({ companyCode: 'SNS', customerId: custP.id, customerNameRaw: 'O Backfill', description: 'p', value: 500, stage: 7, status: 'in_production' } as any);
    const manual = await services.createManualInvoice({ companyCode: 'SNS', contactName: 'O Backfill', lines: [{ qty: 1, unitAmount: 500 }] } as any);
    await pool.query('UPDATE rel_jobs SET invoice_num = $1, invoice_created = true WHERE id = $2',
      [' ' + manual.invoiceNumber.toLowerCase() + ' ', jobP.id]);
    const resP = await services.deleteInvoice(manual.id, manual.rowVersion);
    ok(resP.clearedJobs.length === 1,
      'O4 a case/whitespace-differing backfilled invoice_num is still matched', resP.clearedJobs);
    const afterP = (await pool.query('SELECT invoice_num, invoice_created FROM rel_jobs WHERE id = $1', [jobP.id])).rows[0];
    ok(afterP.invoice_num === null && afterP.invoice_created === false,
      'O5 …so it cannot be left as an unremovable, un-reinvoiceable leftover', afterP);

    // O6 — a job carrying a DIFFERENT invoice number is never touched, even
    // when it is the job this invoice points at.
    await reset();
    const c6 = await services.createCustomer({ companyName: 'O Other' } as any);
    const j6 = await services.createJob({ companyCode: 'SNS', customerId: c6.id, customerNameRaw: 'O Other', description: 'o6', value: 900, stage: 7, status: 'in_production' } as any);
    const inv6 = await services.createManualInvoice({ companyCode: 'SNS', contactName: 'O Other', lines: [{ qty: 1, unitAmount: 900 }] } as any);
    await pool.query('UPDATE rel_invoices SET job_id = $1 WHERE id = $2', [j6.id, inv6.id]);
    await pool.query(`UPDATE rel_jobs SET invoice_num = 'INV-99999', invoice_created = true WHERE id = $1`, [j6.id]);
    const res6 = await services.deleteInvoice(inv6.id, inv6.rowVersion);
    ok(res6.clearedJobs.length === 0, 'O6 a job holding a different invoice number is left alone', res6.clearedJobs);
    const after6 = (await pool.query('SELECT invoice_num, invoice_created FROM rel_jobs WHERE id = $1', [j6.id])).rows[0];
    ok(after6.invoice_num === 'INV-99999' && after6.invoice_created === true,
      'O7 …its own linkage is untouched', after6);
  }

  // ── TEST P — FINANCIAL DEPENDENCY (brief TEST F) ────────────────────────
  // The existing, explicit business rule is that an invoice's payment history
  // is deleted with it — stated in full by the confirmation dialog BEFORE
  // anything happens ("Deleting the invoice will permanently remove that
  // payment history too"). So deletion is allowed rather than blocked. What
  // must NOT happen is a payment being destroyed while the customer credit it
  // consumed stays consumed. REVERT-CHECK: removing the shared
  // releaseCreditForPaymentTx call from deleteInvoice fails P4/P5.
  console.log('\n[P] financial dependency: payments, and the customer credit they consumed');
  {
    await reset();
    const { job, inv } = await seedInvoicedJob('SNS', 'P Client', 11500);
    const relInvBefore = (await buildInvoicesJson())[0];
    const note = await services.createCreditNote({
      companyCode: 'SNS', type: 'customer', contactName: 'P Client',
      date: '2026-07-01', amount: 2000, reason: 'Returned goods',
    } as any);
    await services.recordPayment({ type: 'invoice', id: relInvBefore._relId }, 1500, { date: '2026-08-01', method: 'Credit' });
    await services.recordPayment({ type: 'invoice', id: relInvBefore._relId }, 500, { date: '2026-08-02', method: 'EFT' });
    const usedBefore = Number((await pool.query('SELECT used_amount FROM rel_credit_notes WHERE id = $1', [note.id])).rows[0].used_amount);
    ok(usedBefore === 1500, 'P1 precondition: the Credit payment consumed R1500 of the credit note', usedBefore);

    const relInv = (await buildInvoicesJson())[0];
    const res = await services.deleteInvoice(relInv._relId, relInv._relRowVersion);

    const invPays = await pool.query(`SELECT count(*)::int c FROM rel_payments WHERE owner_type='invoice'`);
    ok(invPays.rows[0].c === 0, 'P2 the invoice\'s payment history is deleted with it, per the stated rule');
    const noteAfter = await pool.query('SELECT amount, used_amount FROM rel_credit_notes WHERE id = $1', [note.id]);
    ok(noteAfter.rowCount === 1, 'P3 the credit NOTE itself is never deleted by an invoice delete');
    ok(Number(noteAfter.rows[0].used_amount) === 0,
      'P4 …and the R1500 it had consumed is RELEASED, not silently burnt', noteAfter.rows[0]);
    ok(res.creditReleased === 1500,
      'P5 the delete reports exactly how much credit it gave back, so the user can be told', res.creditReleased);
    const rep = await everyRepresentationOf(inv.invoiceNumber);
    ok(rep.total() === 0, 'P6 and no representation of the invoice remains');
    ok(HTML.indexOf('will permanently remove that payment history too') !== -1,
      'P7 the confirmation states the payment-history rule BEFORE anything is deleted (no partial surprise)');
    ok(HTML.indexOf('delResult.creditReleased') !== -1,
      'P8 …and the released credit is reported back to the user in the UI');
    // A non-Credit payment must not touch any credit note at all.
    await reset();
    const p2 = await seedInvoicedJob('SNS', 'P2 Client', 5000);
    const note2 = await services.createCreditNote({ companyCode: 'SNS', type: 'customer', contactName: 'P2 Client', date: '2026-07-01', amount: 900, reason: 'x' } as any);
    const relInv2 = (await buildInvoicesJson())[0];
    await services.recordPayment({ type: 'invoice', id: relInv2._relId }, 400, { date: '2026-08-01', method: 'EFT' });
    const res2 = await services.deleteInvoice(relInv2._relId, relInv2._relRowVersion);
    const note2After = await pool.query('SELECT used_amount FROM rel_credit_notes WHERE id = $1', [note2.id]);
    ok(res2.creditReleased === 0 && Number(note2After.rows[0].used_amount) === 0,
      'P9 an EFT payment releases nothing — credit notes are only touched by Credit payments', res2.creditReleased);
    ok(p2.job.jobNumber.length > 0, 'P10 (fixture sanity) the job under test existed');
  }

  // ── TEST Q — DUPLICATE / GHOST REGRESSION (brief TEST G) ────────────────
  // Recreate the exact representation conditions behind the reported
  // duplicate INV-00099 — a job carrying invoiceNum AND an accInvoices record
  // for the same invoice — first in the BROKEN shape (the accInvoices record's
  // `reference` empty, so the de-duplication key that suppresses the job-side
  // twin is missing) and then in the repaired shape, and delete from both.
  console.log('\n[Q] duplicate/ghost regression — the INV-00099 representation conditions');
  {
    await reset();
    const { job, inv } = await seedInvoicedJob('SNS', 'Q Client', 11500);
    // The pre-repair shape: reference NULL. This is what made ONE logical
    // invoice render as TWO rows (the real one, and an R0.00 job-derived twin).
    await pool.query(`UPDATE rel_invoices SET reference = NULL, job_number_raw = NULL WHERE invoice_number = $1`, [inv.invoiceNumber]);
    const broken = await everyRepresentationOf(inv.invoiceNumber);
    ok(broken.inUnified === 2 && broken.inSales === 2 && broken.inAcct === 2,
      'Q1 precondition reproduced: with no dedup key the SAME invoice renders twice on every list',
      { u: broken.inUnified, s: broken.inSales, a: broken.inAcct });
    const relBroken = (await buildInvoicesJson())[0];
    await services.deleteInvoice(relBroken._relId, relBroken._relRowVersion);
    const afterBroken = await everyRepresentationOf(inv.invoiceNumber);
    ok(afterBroken.total() === 0,
      'Q2 deleting it removes BOTH representations — not one, leaving the twin behind', {
        rel: afterBroken.relRows, u: afterBroken.inUnified, s: afterBroken.inSales,
        a: afterBroken.inAcct, p: afterBroken.inPayments, d: afterBroken.inDashboard });

    // And in the repaired shape (reference set, as createInvoiceForJob now
    // always writes it), one row before, none after.
    await reset();
    const b = await seedInvoicedJob('SNS', 'Q Client 2', 8050);
    const refRow = await pool.query('SELECT reference, job_number_raw FROM rel_invoices WHERE invoice_number = $1', [b.inv.invoiceNumber]);
    ok(refRow.rows[0].reference === b.job.jobNumber,
      'Q3 the 2026-08-24 repair still holds: createInvoiceForJob writes `reference` (the dedup key)', refRow.rows[0]);
    const okBefore = await everyRepresentationOf(b.inv.invoiceNumber);
    ok(okBefore.inUnified === 1 && okBefore.inSales === 1 && okBefore.inAcct === 1,
      'Q4 so the same invoice renders exactly once, never duplicated');
    const relOk = (await buildInvoicesJson())[0];
    await services.deleteInvoice(relOk._relId, relOk._relRowVersion);
    const okAfter = await everyRepresentationOf(b.inv.invoiceNumber);
    ok(okAfter.total() === 0, 'Q5 and delete removes it completely');
    // De-duplication keys: the job-derived row and the relational row must be
    // recognisable as ONE logical invoice, not two, however each is identified.
    ok(HTML.indexOf('function invoiceBelongsToJob(inv, jobNum)') !== -1
      && HTML.indexOf('inv.reference === jobNum || inv.jobNum === jobNum') !== -1,
      'Q6 the single shared predicate matching an accInvoices record to a job is intact');
    ok(HTML.indexOf('if (i.reference) refs.add(i.reference);') !== -1
      && HTML.indexOf('if (i.jobNum) refs.add(i.jobNum);') !== -1,
      'Q7 …and the membership index over it stays in step (both keys, never one)');
  }

  // ── TEST R — MANUAL vs AUTOMATIC (brief TESTS D and E) ──────────────────
  // The previously fixed rule: a manually created invoice linked to a Job must
  // NOT advance the Job lifecycle, and when the Job later reaches its
  // invoicing stage the EXISTING invoice is reused rather than a second one
  // created. Deleting must behave consistently for both origins and must not
  // regress either half of that rule.
  console.log('\n[R] manual vs automatic invoices — creation rule preserved, deletion consistent');
  {
    await reset();
    const cust = await services.createCustomer({ companyName: 'R Client' } as any);
    const job = await services.createJob({
      companyCode: 'SNS', customerId: cust.id, customerNameRaw: 'R Client',
      description: 'R job', value: 4600, stage: 4, status: 'in_production',
    } as any);
    const before = (await pool.query('SELECT stage, status, invoice_num, invoice_created FROM rel_jobs WHERE id = $1', [job.id])).rows[0];
    const manual = await services.createManualInvoice({
      companyCode: 'SNS', contactName: 'R Client', reference: job.jobNumber,
      lines: [{ qty: 1, unitAmount: 4000 }],
    } as any);
    const afterManual = (await pool.query('SELECT stage, status, invoice_num, invoice_created FROM rel_jobs WHERE id = $1', [job.id])).rows[0];
    ok(afterManual.stage === before.stage && afterManual.status === before.status,
      'R1 a manual invoice against a job does NOT advance the job lifecycle (rule preserved)', afterManual);
    ok(afterManual.invoice_num === null && afterManual.invoice_created === false,
      'R2 …and does not stamp the job either', afterManual);
    const jobsJson = await buildJobsJson(); const invsJson = await buildInvoicesJson();
    const reused = listBox.getJobManualInvoice(jobsJson[0], invsJson);
    ok(!!reused && reused.number === manual.invoiceNumber,
      'R3 the job resolves to that EXISTING manual invoice, so the later invoicing stage reuses it', reused && reused.number);
    ok(listBox.getAllInvoicesUnified(jobsJson, [], invsJson).length === 1,
      'R4 and it is listed exactly once, never as job-derived + manual');

    const res = await services.deleteInvoice(manual.id, manual.rowVersion);
    ok(res.clearedJobs.length === 0, 'R5 deleting a manual invoice clears no job linkage (there was none to clear)');
    const afterDel = (await pool.query('SELECT stage, status, invoice_num, invoice_created FROM rel_jobs WHERE id = $1', [job.id])).rows[0];
    ok(afterDel.stage === before.stage && afterDel.status === before.status,
      'R6 …and does not move the job lifecycle in either direction', afterDel);
    ok((await everyRepresentationOf(manual.invoiceNumber)).total() === 0, 'R7 no ghost remains');
    const autoInv = await services.createInvoiceForJob(job.id);
    ok(!!autoInv.invoiceNumber && autoInv.invoiceNumber !== manual.invoiceNumber,
      'R8 the job can then be invoiced automatically, with a NEW number', autoInv.invoiceNumber);
    const autoJob = (await pool.query('SELECT stage, status FROM rel_jobs WHERE id = $1', [job.id])).rows[0];
    ok(autoJob.stage === before.stage,
      'R9 …and invoicing below the installation stage still does not jump the job to Invoiced(9)', autoJob);
    const autoRel = (await buildInvoicesJson())[0];
    const autoRes = await services.deleteInvoice(autoRel._relId, autoRel._relRowVersion);
    ok(autoRes.clearedJobs.length === 1,
      'R10 deleting the AUTOMATIC invoice does clear the job linkage it created — the two origins differ only where they genuinely differ',
      autoRes.clearedJobs);
    ok((await everyRepresentationOf(autoInv.invoiceNumber)).total() === 0, 'R11 and it too leaves nothing behind');
  }

  // ── TEST S — SAVE-PATH + COMPANY-ISOLATION (brief TESTS K and I) ────────
  console.log('\n[S] invoice delete never touches the platform_state save path');
  {
    const src = extractFunction(HTML, 'deleteInvoice');
    for (const forbidden of ['forceSaveSections', 'saveToServer', 'mergeAndSave', 'platform-state', '_partial', '_deletedIds']) {
      ok(src.indexOf(forbidden) === -1,
        `S1 the delete handler contains no reference to ${forbidden} — it is a purely relational write`);
    }

    // Behavioural: run the shipped handler with the whole legacy save surface
    // wired as spies, then ask the SHIPPED autosave diff whether it would now
    // emit a save. It must report nothing changed, because syncRelationalBaseline
    // folded both mutations into the baseline.
    const saveBox: any = {
      console, JSON, Object, Array, Set, Number, String, parseFloat, Math, Date,
      alert: () => undefined,
      zar: (n: number) => 'R ' + Number(n).toFixed(2),
      window: { confirm: () => true },
      isRelationalAuthoritative: () => true,
      describeSaveConflictError: (e: any) => (e && e.message) || 'error',
      forceSaveSections: (...a: any[]) => { saveBox.illegal.push(['forceSaveSections', a]); },
      saveToServer: (...a: any[]) => { saveBox.illegal.push(['saveToServer', a]); },
      mergeAndSave: (...a: any[]) => { saveBox.illegal.push(['mergeAndSave', a]); },
      fetch: (...a: any[]) => { saveBox.illegal.push(['fetch', a]); return Promise.resolve({ ok: true, json: async () => ({}) }); },
      illegal: [] as any[],
      accInvoices: [{ id: 'inv-1', number: 'INV-00099', _relId: 7, _relRowVersion: 3, payments: [], reference: 'SNS-00112' }],
      relationalApi: {
        deleteInvoice: async () => ({
          success: true, deleted: true, ambiguousJobs: [], creditReleased: 0,
          clearedJobs: [{ id: 42, sourceId: '42', jobNumber: 'SNS-00112', rowVersion: 9 }],
        }),
      },
    };
    saveBox.localState = {
      accInvoices: [{ id: 'inv-1', number: 'INV-00099' }],
      jobs: [{ id: 900, _relId: '42', num: 'SNS-00112', invoiceNum: 'INV-00099', invoiceCreated: true, _relRowVersion: 8 }],
      customers: [{ id: 1, name: 'Keep me' }],
    };
    saveBox.baselineState = JSON.parse(JSON.stringify(saveBox.localState));
    saveBox.setAccInvoices = (u: any) => { saveBox.localState.accInvoices = u(saveBox.localState.accInvoices); };
    saveBox.setJobs = (u: any) => { saveBox.localState.jobs = u(saveBox.localState.jobs); };
    saveBox.syncRelationalBaseline = (section: string, u: any) => {
      if (Array.isArray(saveBox.baselineState[section])) saveBox.baselineState[section] = u(saveBox.baselineState[section]);
    };
    vm.createContext(saveBox);
    vm.runInContext(extractFunction(HTML, 'deleteInvoice'), saveBox);
    if (STATE_SECTIONS_SRC) vm.runInContext(STATE_SECTIONS_SRC[0], saveBox);
    vm.runInContext(extractFunction(HTML, 'locallyChangedSections'), saveBox);
    await vm.runInContext('deleteInvoice("inv-1")', saveBox);

    ok(saveBox.illegal.length === 0,
      'S2 no legacy save function and no network call of any kind was invoked', saveBox.illegal);
    const changed = vm.runInContext('locallyChangedSections(localState, baselineState)', saveBox);
    ok(changed && Object.keys(changed).length === 0,
      'S3 the SHIPPED autosave diff reports NOTHING changed — so no /api/platform-state save is triggered at all',
      changed);
    ok(saveBox.localState.accInvoices.length === 0 && !saveBox.localState.jobs[0].invoiceNum,
      'S4 …even though both local state and the baseline really did move together', saveBox.localState);
    ok(saveBox.localState.customers.length === 1 && saveBox.baselineState.customers.length === 1,
      'S5 and no other section was touched — the partial-save architecture is untouched');

    // Company isolation at the layer this app actually enforces it: the delete
    // control is rendered from the COMPANY-FILTERED accInvoices list, so a
    // Holdings user can never reach an Original invoice's delete, or vice versa.
    ok(HTML.indexOf('const accInvoices = (accInvoicesAll||[]).filter(i=>belongsToUserCompany(i,user));') !== -1,
      'S6 AccountingPage still renders from the company-filtered invoice list');
    ok(HTML.indexOf('const inv = accInvoices.find(i=>i.id===id);') !== -1,
      'S7 …and the delete handler resolves its record from THAT filtered list, never the unfiltered one');
    if (typeof listBox.belongsToUserCompany === 'function') {
      const holdingsUser = { role: 'admin', co: 1 };   // Holdings (HOLDINGS_CO_ID)
      const originalUser = { role: 'admin', co: 2 };   // Signacore Original
      const holdingsInv = { id: 'h1', number: 'INV-00001', co: 1 };
      const originalInv = { id: 'o1', number: 'INV-00001', co: 2 };
      const untaggedInv = { id: 'u1', number: 'INV-00002' };  // historical, no co
      const all = [holdingsInv, originalInv, untaggedInv];
      const holdingsSees = all.filter((i) => listBox.belongsToUserCompany(i, holdingsUser));
      const originalSees = all.filter((i) => listBox.belongsToUserCompany(i, originalUser));
      ok(holdingsSees.length === 1 && holdingsSees[0].id === 'h1',
        'S8 a Holdings user can only reach the Holdings invoice — never the Original one', holdingsSees.map((i) => i.id));
      ok(originalSees.length === 2 && originalSees.every((i) => i.id !== 'h1'),
        'S9 an Original user reaches the Original and untagged invoices — never the Holdings one', originalSees.map((i) => i.id));
    } else {
      ok(false, 'S8/S9 belongsToUserCompany could not be extracted from index.html');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // [L] LIVE HTTP — the whole delete path over the wire, exactly as the browser
  // walks it: authenticate -> GET /api/platform-state (the read overlay the
  // client actually renders) -> DELETE /api/relational/invoices/:id -> GET
  // /api/platform-state again. Everything above this point exercises the
  // services/read layer directly and so cannot see the route's cutover gate,
  // its response body, or whether the overlay the browser receives really
  // stopped carrying the invoice.
  //
  // Skipped with a clear notice when TEST_SERVER_URL_WITH_AUTHORITY is unset —
  // same convention as every sibling REST suite.
  // ══════════════════════════════════════════════════════════════════════════
  const AUTH_URL = process.env.TEST_SERVER_URL_WITH_AUTHORITY;
  if (!AUTH_URL) {
    console.log('\n[L] live HTTP\n  ! skipped: TEST_SERVER_URL_WITH_AUTHORITY not set');
  } else {
    console.log('\n[L] live HTTP — delete over the wire, seen through /api/platform-state');
    const loginRes = await fetch(`${AUTH_URL}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: process.env.TEST_LOGIN_EMAIL || 'test@signacore.local',
        password: process.env.TEST_LOGIN_PASSWORD || 'testpass',
      }),
    });
    const loginBody: any = await loginRes.json().catch(() => null);
    const token = loginBody && loginBody.token;
    ok(!!token, 'L0 authenticated against the live server');
    const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

    const prevFlags = (await pool.query(`SELECT section, enabled FROM relational_cutover`)).rows;
    for (const sec of ['quotes', 'jobs', 'accInvoices']) {
      await pool.query(
        `INSERT INTO relational_cutover (section, enabled) VALUES ($1, true)
         ON CONFLICT (section) DO UPDATE SET enabled = true`, [sec]);
    }
    try {
      await reset();
      const { job, inv } = await seedInvoicedJob('SNS', 'Live HTTP Client', 11500);

      const readOverlay = async () => {
        const r = await fetch(`${AUTH_URL}/api/platform-state`, { headers: H });
        const b: any = await r.json().catch(() => null);
        const data = (b && (b.data || b)) || {};
        return {
          sections: (b && b.relationalAuthoritativeSections) || [],
          jobs: data.jobs || [], accInvoices: data.accInvoices || [],
        };
      };

      const before = await readOverlay();
      ok(before.sections.indexOf('accInvoices') !== -1 && before.sections.indexOf('jobs') !== -1,
        'L1 the overlay reports jobs AND accInvoices as relational-authoritative (no silent JSON fallback)',
        before.sections);
      const invRow = before.accInvoices.find((i: any) => i.number === inv.invoiceNumber);
      ok(!!invRow, 'L2 the invoice is served to the browser as an accInvoices record');
      const jobRow = before.jobs.find((j: any) => j.num === job.jobNumber);
      ok(!!jobRow && jobRow.invoiceNum === inv.invoiceNumber,
        'L3 …and the SAME invoice is also served stamped on the job (the second representation)',
        jobRow && { invoiceNum: jobRow.invoiceNum, invoiceCreated: jobRow.invoiceCreated });
      const salesBefore = salesInvoiceList(before.jobs, [], before.accInvoices);
      ok(salesBefore.filter((i: any) => i.invoiceNum === inv.invoiceNumber).length === 1,
        'L4 the browser would render it exactly once (the two halves de-duplicate correctly while both exist)');

      const delRes = await fetch(`${AUTH_URL}/api/relational/invoices/${invRow._relId}`, {
        method: 'DELETE', headers: H,
        body: JSON.stringify({ expectedVersion: invRow._relRowVersion }),
      });
      const delBody: any = await delRes.json().catch(() => null);
      ok(delRes.status === 200 && delBody && delBody.success === true,
        'L5 DELETE /api/relational/invoices/:id succeeds', { status: delRes.status, body: delBody });
      ok(Array.isArray(delBody.clearedJobs) && delBody.clearedJobs.length === 1
        && delBody.clearedJobs[0].jobNumber === job.jobNumber
        && typeof delBody.clearedJobs[0].rowVersion === 'number',
        'L6 the response tells the client which job it must clear, and that job\'s new row_version',
        delBody && delBody.clearedJobs);

      const after = await readOverlay();
      ok(!after.accInvoices.find((i: any) => i.number === inv.invoiceNumber),
        'L7 the overlay no longer serves the accInvoices record');
      const jobAfter = after.jobs.find((j: any) => j.num === job.jobNumber);
      ok(!!jobAfter && !jobAfter.invoiceNum && jobAfter.invoiceCreated === false,
        'L8 …and no longer serves the job-side half either', jobAfter && { invoiceNum: jobAfter.invoiceNum, invoiceCreated: jobAfter.invoiceCreated });
      ok(salesInvoiceList(after.jobs, [], after.accInvoices)
        .filter((i: any) => i.invoiceNum === inv.invoiceNumber).length === 0,
        'L9 a browser re-rendering from this overlay shows NO representation of the deleted invoice');
      ok(accountingInvoiceList(after.jobs, [], after.accInvoices)
        .filter((i: any) => i.number === inv.invoiceNumber).length === 0,
        'L10 Accounting agrees — the two pages cannot disagree because neither half survives');
      ok(Number(jobAfter._relRowVersion) === delBody.clearedJobs[0].rowVersion,
        'L11 the row_version the client was handed matches what the overlay now serves — no false 409 on the next job edit',
        { handed: delBody.clearedJobs[0].rowVersion, served: jobAfter && jobAfter._relRowVersion });

      // ── L12-L15 MIXED MODE ─────────────────────────────────────────────
      // With "jobs" back on JSON authority the delete is a cross-authority
      // write it cannot complete correctly: clearing rel_jobs would land in a
      // table nothing reads, leaving the reported leftover in place while
      // silently diverging rel_jobs from the JSON the pre-cutover
      // reconciliation gate compares against. The route refuses instead —
      // the same posture POST /jobs/:id/create-invoice already takes — and
      // NOTHING is deleted.
      await reset();
      const mixed = await seedInvoicedJob('SNS', 'Mixed Mode Client', 6900);
      await pool.query(`UPDATE relational_cutover SET enabled = false WHERE section = 'jobs'`);
      try {
        const mixedInv = (await buildInvoicesJson())[0];
        const refuseRes = await fetch(`${AUTH_URL}/api/relational/invoices/${mixedInv._relId}`, {
          method: 'DELETE', headers: H,
          body: JSON.stringify({ expectedVersion: mixedInv._relRowVersion }),
        });
        const refuseBody: any = await refuseRes.json().catch(() => null);
        ok(refuseRes.status === 409 && refuseBody && refuseBody.type === 'not_cut_over',
          'L12 with "jobs" not cut over the delete is refused with the standard not_cut_over conflict',
          { status: refuseRes.status, body: refuseBody });
        ok(/jobs/.test((refuseBody && refuseBody.error) || ''),
          'L13 …and the message names the section that is not cut over', refuseBody && refuseBody.error);
        const stillThere = await pool.query('SELECT count(*)::int c FROM rel_invoices WHERE id = $1', [mixedInv._relId]);
        ok(stillThere.rows[0].c === 1, 'L14 the invoice was NOT deleted');
        const jobStill = await pool.query('SELECT invoice_num, invoice_created FROM rel_jobs WHERE job_number = $1', [mixed.job.jobNumber]);
        ok(jobStill.rows[0].invoice_num === mixed.inv.invoiceNumber && jobStill.rows[0].invoice_created === true,
          'L15 …and no half-reversal was left behind on the job', jobStill.rows[0]);
      } finally {
        await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section = 'jobs'`);
      }
    } finally {
      // Restore EXACTLY the prior state: rows that existed go back to their
      // previous value; a row this block had to create is removed, so this
      // suite can never leave a section switched on behind it.
      const prior = new Set(prevFlags.map((r: any) => r.section));
      for (const row of prevFlags) {
        await pool.query(`UPDATE relational_cutover SET enabled = $2 WHERE section = $1`, [row.section, row.enabled]);
      }
      for (const sec of ['quotes', 'jobs', 'accInvoices']) {
        if (!prior.has(sec)) await pool.query(`DELETE FROM relational_cutover WHERE section = $1`, [sec]);
      }
    }
  }

  console.log(`\n──────── ${passed} passed, ${failures} failed ────────\n`);
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
