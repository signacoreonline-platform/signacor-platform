/**
 * relational.invoice-canonicalization.stress.ts
 * ─────────────────────────────────────────────
 * Regression suite for the reported production failure (2026-08-24):
 *
 *   "In the invoice lists, SOME invoices display the full normal set of
 *    invoice actions. Other invoices display ONLY: View."
 *
 * ROOT CAUSE (established empirically — see TEST E's revert note): an invoice
 * belonging to a job exists in TWO representations at once, and every list
 * renders one row per logical invoice by suppressing the job-derived twin
 * whenever the record-side representation is found. That suppression used to
 * depend ENTIRELY on the accInvoices record carrying `reference` or `jobNum`.
 * A record with neither — any invoice backfilled from a legacy JSON
 * accInvoices entry that never had those keys — went unmatched, so ONE
 * logical invoice rendered as TWO rows: the record (full action set) and the
 * job-derived twin (View-only in Accounting, because Edit/Status/Delete all
 * act on an accInvoices record and the twin has none).
 *
 * Separately, a genuinely UNBACKED job invoice exists in quantity: the
 * pre-cutover "Create Invoice" flow wrote ONLY the job
 * (index.html createInvoiceNow's JSON branch: forceSaveSections({ jobs })),
 * and backfill.ts creates rel_invoices rows ONLY from data.accInvoices
 * (PASS 4) — it never synthesises one from job fields. Those are real
 * historical invoices with no accounting record. They must not be given fake
 * actions, and must not masquerade as normal active invoices.
 *
 * Every test runs against a REAL local Postgres through the real
 * services/read layers, and every frontend assertion executes the SHIPPED
 * function extracted from index.html rather than a re-implementation.
 *
 * SAFETY: refuses to run unless DATABASE_URL points at localhost/127.0.0.1 or
 * ALLOW_UNSAFE_TEST_DB=1 is set. TRUNCATEs only the rel_* tables it owns and
 * never touches platform_state or platform_state_backups.
 *
 * Usage (from backend/):
 *   DATABASE_URL=postgresql://user:pass@localhost:5432/signacore_test \
 *   npx ts-node --transpile-only test/relational.invoice-canonicalization.stress.ts
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import pool from '../src/db/pool';
import * as services from '../src/relational/services';
import { buildJobsJson, buildInvoicesJson, buildQuotesJson } from '../src/relational/read';

const DB_URL = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(DB_URL) && process.env.ALLOW_UNSAFE_TEST_DB !== '1') {
  console.error('[invoice-canonicalization] Refusing to run: DATABASE_URL does not look like a local test database.');
  process.exit(1);
}
const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH || path.resolve(__dirname, '..', '..', 'index.html');

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

function extractFunction(src: string, name: string): string {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) throw new Error(`Could not find function ${name} in index.html — renamed or removed?`);
  const parenStart = src.indexOf('(', m.index);
  let pd = 0, j = parenStart;
  for (; j < src.length; j++) { if (src[j] === '(') pd++; else if (src[j] === ')') { pd--; if (!pd) { j++; break; } } }
  const bs = src.indexOf('{', j);
  let d = 0, i = bs;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (!d) { i++; break; } } }
  return src.slice(m.index, i);
}

const HTML = fs.readFileSync(INDEX_HTML_PATH, 'utf8').replace(/\r\n/g, '\n');
function sliceBetween(hay: string, from: string, to: string): string {
  const a = hay.indexOf(from);
  if (a === -1) return '';
  const b = hay.indexOf(to, a + from.length);
  return b === -1 ? hay.slice(a) : hay.slice(a, b);
}
const box: any = { console, Math, Date, parseFloat, parseInt, JSON, Set, Array, Object, isNaN, String, Number };
vm.createContext(box);
const HOLD = /const HOLDINGS_CO_ID\s*=\s*\d+;/.exec(HTML);
if (HOLD) vm.runInContext(HOLD[0], box);
const STATE_SECTIONS_SRC = /const STATE_SECTIONS\s*=\s*\[[\s\S]*?\];/.exec(HTML);
if (STATE_SECTIONS_SRC) vm.runInContext(STATE_SECTIONS_SRC[0], box);
for (const n of ['invoiceBelongsToJob', 'invoiceIdentityKey', 'resolveJobInvoiceRecord', 'jobInvoiceLinkState',
  'getManualInvoiceJobRefs', 'getJobManualInvoice', 'getQuoteInvoice', 'reconcileJobInvoice', 'numSort',
  'getAllInvoicesUnified', 'getPendingJobInvoices', 'getJobInvoices',
  'isHoldingsUser', 'isHoldingsRecord', 'belongsToUserCompany', 'locallyChangedSections']) {
  try { vm.runInContext(extractFunction(HTML, n), box); }
  catch (e) { console.log(`  !! could not load ${n}: ${(e as Error).message}`); }
}

/* ── THE ACTION CONTRACT ───────────────────────────────────────────────────
 * Modelled from the SHIPPED JSX, and pinned to it by TEST R's source
 * assertions so the model can never drift from what actually renders.
 * A row backed by a canonical accInvoices record gets the established full
 * control set; a job row (which, after canonical resolution, necessarily has
 * NO accounting record) gets only what has a real backend target, with the
 * rest LOCKED and explained — never fabricated. */
const FULL_CONTRACT = ['View', 'Payments', 'Edit', 'Print', 'Email', 'Status', 'Delete'];
function accountingActions(row: any, isAdmin = true) {
  if (row.source === 'job') {
    return { enabled: ['View', 'Payments', 'Print'], locked: ['Edit', 'Email', 'Status', 'Delete'] };
  }
  return { enabled: isAdmin ? FULL_CONTRACT.slice() : FULL_CONTRACT.filter((a) => a !== 'Delete'), locked: [] };
}
function salesActions(row: any, isAdmin = true) {
  if (row._isManual) {
    return { enabled: isAdmin ? FULL_CONTRACT.slice() : FULL_CONTRACT.filter((a) => a !== 'Delete'), locked: [] };
  }
  return { enabled: ['View', 'Payments', 'Edit', 'Print', 'Email'], locked: isAdmin ? ['Status', 'Delete'] : ['Status'] };
}

/** Accounting -> Invoices, exactly as index.html builds it. */
function accountingList(jobs: any[], quotes: any[], accInvoices: any[]) {
  box.jobs = jobs; box.quotes = quotes;
  const jobInvoices = box.getJobInvoices();
  const manualRefs = box.getManualInvoiceJobRefs(accInvoices, jobs);
  const jobInvsFiltered = jobInvoices.filter((j: any) => !manualRefs.has(j.jobNum));
  return [
    ...accInvoices.filter((i: any) => i && i.status !== 'void').map((i: any) => ({ ...i, source: i.source || 'manual' })),
    ...jobInvsFiltered,
  ];
}
/** Sales -> Invoices, exactly as index.html builds it. */
function salesList(jobs: any[], quotes: any[], accInvoices: any[]) {
  const refs = box.getManualInvoiceJobRefs(accInvoices, jobs);
  const jobInvItems = jobs.filter((j) => j.invoiceNum && !refs.has(j.num)).map((j) => ({
    invoiceNum: j.invoiceNum, num: j.num, client: j.client, co: j.co ?? null,
    value: parseFloat(j.value) || 0, invoiceStatus: box.reconcileJobInvoice(j, quotes).invoiceStatus,
    _isManual: false,
  }));
  const manualInvItems = accInvoices.filter((i) => i.status !== 'void').map((i) => {
    const sub = (i.lineItems || []).reduce((s: number, l: any) => s + (parseFloat(l.qty || 1) * parseFloat(l.unitAmount || 0)), 0);
    const vat = (i.lineItems || []).reduce((s: number, l: any) => l.taxType === '15%' ? s + (parseFloat(l.qty || 1) * parseFloat(l.unitAmount || 0) * 0.15) : s, 0);
    return {
      id: i.id, invoiceNum: i.number, client: i.contactName || '', co: i.co ?? null, value: sub + vat,
      invoiceStatus: i.status === 'paid' ? 'paid' : i.status === 'partial' ? 'partial' : 'pending',
      reference: i.reference, num: 'manual', _isManual: true,
    };
  });
  return box.numSort([...jobInvItems, ...manualInvItems], 'invoiceNum');
}

async function snapshot() {
  const jobs = await buildJobsJson();
  const accInvoices = await buildInvoicesJson();
  const quotes = await buildQuotesJson();
  return { jobs, accInvoices, quotes, sales: salesList(jobs, quotes, accInvoices), acct: accountingList(jobs, quotes, accInvoices) };
}

async function reset() {
  await pool.query(`TRUNCATE TABLE rel_payments, rel_invoice_line_items, rel_invoices, rel_job_line_items,
    rel_jobs, rel_quote_line_items, rel_quotes, rel_credit_notes, rel_inventory_items, rel_customers
    RESTART IDENTITY CASCADE`);
  await pool.query(`DELETE FROM document_number_counters`);
  await pool.query(`DELETE FROM quote_conversions`);
}

async function seedInvoicedJob(companyCode = 'SNS', clientName = 'Canon Client', value = 11500, stage = 7) {
  const cust = await services.createCustomer({ companyName: clientName } as any);
  const job = await services.createJob({
    companyCode, customerId: cust.id, customerNameRaw: clientName,
    description: 'Canonicalization job', value, stage, status: 'in_production',
  } as any);
  const inv = await services.createInvoiceForJob(job.id);
  return { cust, job, inv };
}

/** The four diagnostic classifications, computed by the SAME SQL the
 *  read-only production diagnostic uses (scripts/diagnose-job-invoice-links.sql). */
async function classify() {
  const res = await pool.query(`
    WITH linked AS (
      SELECT j.id AS job_id, j.company_code, j.job_number, j.invoice_num, j.invoice_created,
             COUNT(i.id)::int AS match_count,
             (ARRAY_AGG(i.id ORDER BY i.id))[1] AS matched_invoice_id
        FROM rel_jobs j
        LEFT JOIN rel_invoices i
          ON i.company_code = j.company_code
         AND COALESCE(i.status,'') <> 'void'
         AND ( i.job_id = j.id
               OR ( j.invoice_num IS NOT NULL
                    AND UPPER(BTRIM(i.invoice_number)) = UPPER(BTRIM(j.invoice_num)) ) )
       WHERE j.invoice_num IS NOT NULL OR j.invoice_created = true
       GROUP BY j.id
    ), cross_company AS (
      SELECT l.job_id, COUNT(x.id)::int AS other_company_matches
        FROM linked l
        LEFT JOIN rel_invoices x
          ON x.company_code <> l.company_code AND COALESCE(x.status,'') <> 'void'
         AND l.invoice_num IS NOT NULL
         AND UPPER(BTRIM(x.invoice_number)) = UPPER(BTRIM(l.invoice_num))
       GROUP BY l.job_id
    ), shared AS (
      SELECT matched_invoice_id AS inv_id, COUNT(*)::int AS claiming_jobs
        FROM linked WHERE match_count = 1 AND matched_invoice_id IS NOT NULL
       GROUP BY matched_invoice_id
    )
    SELECT l.company_code, l.job_number, l.invoice_num, l.match_count,
           CASE WHEN l.match_count = 1 AND COALESCE(sh.claiming_jobs,0) <= 1 THEN l.matched_invoice_id END AS relational_invoice_id,
           COALESCE(c.other_company_matches,0) AS same_number_other_company,
           COALESCE(sh.claiming_jobs,0)        AS jobs_claiming_same_invoice,
           (SELECT COUNT(*)::int FROM rel_payments p WHERE p.owner_type='job' AND p.owner_id=l.job_id) AS job_payment_count,
           (SELECT COUNT(*)::int FROM rel_credit_notes cn
              WHERE cn.company_code = l.company_code AND l.invoice_num IS NOT NULL
                AND cn.applied_to IS NOT NULL
                AND UPPER(BTRIM(cn.applied_to)) LIKE '%'||UPPER(BTRIM(l.invoice_num))||'%') AS credit_notes_naming_invoice,
           CASE
             WHEN l.invoice_num IS NULL OR BTRIM(l.invoice_num) = ''            THEN 'NO_NUMBER'
             WHEN COALESCE(c.other_company_matches,0) > 0 AND l.match_count = 0 THEN 'INVALID'
             WHEN l.match_count = 1 AND COALESCE(sh.claiming_jobs,0) > 1        THEN 'AMBIGUOUS'
             WHEN l.match_count = 1                                            THEN 'MATCHED'
             WHEN l.match_count = 0                                            THEN 'ORPHANED'
             ELSE 'AMBIGUOUS'
           END AS classification
      FROM linked l
      LEFT JOIN cross_company c ON c.job_id = l.job_id
      LEFT JOIN shared sh ON sh.inv_id = l.matched_invoice_id
     ORDER BY l.company_code, l.job_number`);
  return res.rows;
}

async function main() {
  console.log('\n════ INVOICE CANONICALIZATION / VIEW-ONLY — REGRESSION SUITE ════');

  // ── TEST A — STANDARD RELATIONAL INVOICE ────────────────────────────────
  console.log('\n[A] a standard relational invoice is ONE canonical row with the full contract');
  {
    await reset();
    const { job, inv } = await seedInvoicedJob();
    const s = await snapshot();
    const salesRows = s.sales.filter((r: any) => r.invoiceNum === inv.invoiceNumber);
    const acctRows = s.acct.filter((r: any) => r.number === inv.invoiceNumber);
    ok(salesRows.length === 1, 'A1 Sales renders exactly one row for it', salesRows.length);
    ok(acctRows.length === 1, 'A2 Accounting renders exactly one row for it', acctRows.length);
    ok(salesRows[0]._isManual === true && acctRows[0].source === 'manual',
      'A3 both resolve to the RECORD, not a job-derived twin',
      { sales: salesRows[0]._isManual, acct: acctRows[0].source });
    const sa = salesActions(salesRows[0]); const aa = accountingActions(acctRows[0]);
    ok(FULL_CONTRACT.every((a) => sa.enabled.indexOf(a) !== -1) && sa.locked.length === 0,
      'A4 Sales exposes View/Payments/Edit/Print/Email/Status/Delete — nothing locked', sa);
    ok(FULL_CONTRACT.every((a) => aa.enabled.indexOf(a) !== -1) && aa.locked.length === 0,
      'A5 Accounting exposes the same full contract', aa);
    ok(acctRows[0]._relId != null, 'A6 …and the row carries a real backend target (_relId)', acctRows[0]._relId);
    const cls = await classify();
    ok(cls.length === 1 && cls[0].classification === 'MATCHED', 'A7 the diagnostic classifies it MATCHED', cls);
    // Refresh: a completely fresh authoritative read gives the identical answer.
    const s2 = await snapshot();
    ok(s2.sales.length === s.sales.length && s2.acct.length === s.acct.length,
      'A8 a fresh authoritative rehydration is identical', { before: s.acct.length, after: s2.acct.length });
    ok(!!job.jobNumber, 'A9 (fixture sanity) the job exists');
  }

  // ── TEST B — MANUAL JOB INVOICE ─────────────────────────────────────────
  console.log('\n[B] a manual job invoice is canonical, and does not advance the job');
  {
    await reset();
    const cust = await services.createCustomer({ companyName: 'B Client' } as any);
    const job = await services.createJob({
      companyCode: 'SNS', customerId: cust.id, customerNameRaw: 'B Client',
      description: 'B job', value: 4600, stage: 4, status: 'in_production',
    } as any);
    const before = (await pool.query('SELECT stage, status FROM rel_jobs WHERE id=$1', [job.id])).rows[0];
    const manual = await services.createManualInvoice({
      companyCode: 'SNS', contactName: 'B Client', reference: job.jobNumber,
      lines: [{ qty: 1, unitAmount: 4000 }],
    } as any);
    const after = (await pool.query('SELECT stage, status FROM rel_jobs WHERE id=$1', [job.id])).rows[0];
    ok(after.stage === before.stage && after.status === before.status,
      'B1 creating it does NOT advance the job lifecycle (rule preserved)', after);
    const s = await snapshot();
    ok(s.sales.filter((r: any) => r.invoiceNum === manual.invoiceNumber).length === 1
      && s.acct.filter((r: any) => r.number === manual.invoiceNumber).length === 1,
      'B2 it appears exactly once in Sales and once in Accounting');
    const salesRow = s.sales.find((r: any) => r.invoiceNum === manual.invoiceNumber);
    const acctRow = s.acct.find((r: any) => r.number === manual.invoiceNumber);
    ok(salesRow._isManual === true && acctRow.source === 'manual' && acctRow._relId != null,
      'B3 both screens resolve the SAME authoritative record');
    ok(salesActions(salesRow).locked.length === 0 && accountingActions(acctRow).locked.length === 0,
      'B4 the normal actions are available on both — a manual invoice is not second class');
    const resolved = box.getJobManualInvoice(s.jobs[0], s.accInvoices);
    ok(!!resolved && resolved.number === manual.invoiceNumber,
      'B5 the job resolves to that existing invoice, so later invoicing REUSES it', resolved && resolved.number);
    // Reuse is enforced by the FRONTEND guard, deliberately — and that is the
    // correct division. createInvoiceNow refuses when getJobManualInvoice finds
    // an existing invoice and opens it instead. The BACKEND must NOT adopt on
    // `reference`, because `reference` is free text a person types: adopting on
    // it would relink a DIFFERENT customer's standalone invoice into this job
    // and leave this job's own work uninvoiced. That invariant is asserted by
    // relational.post-migration-stabilization.stress.ts [R2a]; both halves are
    // pinned here so neither can be "fixed" into the other's job.
    const guardSrc = extractFunction(HTML, 'createInvoiceNow__impl').length
      ? extractFunction(HTML, 'createInvoiceNow__impl') : '';
    ok(guardSrc.indexOf('getJobManualInvoice(job, accInvoices)') !== -1
      && guardSrc.indexOf('already has an invoice') !== -1,
      'B6 the invoicing workflow REUSES the existing manual invoice (frontend guard), never minting a second');
    const adoptSrc = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'relational', 'services.ts'), 'utf8');
    const adoptSql = sliceBetween(adoptSrc, 'const reusableInvRes', 'FOR UPDATE`');
    ok(adoptSql.indexOf('reference') === -1 && adoptSql.indexOf('job_number_raw') === -1,
      'B6b …and the backend adoption predicate never keys off the free-text `reference`/`job_number_raw` (that would hijack another customer\'s invoice)',
      adoptSql.length);
    ok(adoptSql.indexOf('job_id = $2') !== -1 && adoptSql.indexOf('quote_id = $3::bigint') !== -1,
      'B6b2 …it adopts ONLY on a real structural link (job_id / quote_id)');
    ok((await pool.query('SELECT COUNT(*)::int c FROM rel_invoices')).rows[0].c === 1,
      'B6c only the one manual invoice exists at this point');
  }

  // ── TEST C — AUTOMATIC / WORKFLOW INVOICE ───────────────────────────────
  console.log('\n[C] an automatic workflow invoice is canonical with the same contract');
  {
    await reset();
    const { job, inv } = await seedInvoicedJob('SNS', 'C Client', 23000, 7);
    const s = await snapshot();
    const salesRow = s.sales.find((r: any) => r.invoiceNum === inv.invoiceNumber);
    const acctRow = s.acct.find((r: any) => r.number === inv.invoiceNumber);
    ok(s.sales.length === 1 && s.acct.length === 1, 'C1 exactly one row on each screen',
      { sales: s.sales.length, acct: s.acct.length });
    ok(salesRow._isManual === true && acctRow.source === 'manual', 'C2 both resolve to the record');
    ok(salesActions(salesRow).locked.length === 0 && accountingActions(acctRow).locked.length === 0,
      'C3 the full contract is available on both — identical to the manual case');
    const link = (await pool.query('SELECT job_id, reference, job_number_raw FROM rel_invoices WHERE invoice_number=$1', [inv.invoiceNumber])).rows[0];
    ok(link.job_id !== null && link.reference === job.jobNumber,
      'C4 job linkage is correct on the record itself', link);
    ok((await classify())[0].classification === 'MATCHED', 'C5 diagnostic: MATCHED');
  }

  // ── TEST D — VALID HISTORICAL RELATIONAL INVOICE ────────────────────────
  console.log('\n[D] a historical BACKFILLED invoice with no dedup keys still resolves');
  {
    await reset();
    const cust = await services.createCustomer({ companyName: 'D Client' } as any);
    const job = await services.createJob({
      companyCode: 'SNS', customerId: cust.id, customerNameRaw: 'D Client',
      description: 'historical', value: 11500, stage: 9, status: 'invoiced',
    } as any);
    const manual = await services.createManualInvoice({
      companyCode: 'SNS', contactName: 'D Client', lines: [{ qty: 1, unitAmount: 10000 }],
    } as any);
    // Exactly what backfill produces from a legacy JSON accInvoices record
    // that carried neither `reference` nor `jobNum`, while the JOB carried the
    // invoice number. THIS is the population that rendered twice.
    await pool.query('UPDATE rel_jobs SET invoice_num=$1, invoice_created=true WHERE id=$2', [manual.invoiceNumber, job.id]);
    await pool.query('UPDATE rel_invoices SET reference=NULL, job_number_raw=NULL, job_id=NULL WHERE id=$1', [manual.id]);
    const s = await snapshot();
    ok(s.acct.length === 1, 'D1 Accounting renders ONE row, not a record + a View-only twin',
      s.acct.map((r: any) => `${r.number}:${r.source}`));
    ok(s.sales.length === 1, 'D2 Sales renders ONE row', s.sales.map((r: any) => `${r.invoiceNum}:${r._isManual}`));
    ok(s.acct[0].source === 'manual' && s.acct[0]._relId != null,
      'D3 …and it is the authoritative record, so it is NOT View-only', s.acct[0].source);
    ok(accountingActions(s.acct[0]).locked.length === 0 && salesActions(s.sales[0]).locked.length === 0,
      'D4 a historical invoice gets the full contract — being historical is not a reason to degrade it');
    ok(box.jobInvoiceLinkState(s.jobs[0], s.accInvoices) === 'matched',
      'D5 the job reports its invoice as matched', box.jobInvoiceLinkState(s.jobs[0], s.accInvoices));
    ok(s.jobs[0].invoiceRelId != null && String(s.jobs[0].invoiceRelId) === String(manual.id),
      'D6 the server itself resolved the link (read.ts resolveJobInvoiceLinks)', s.jobs[0].invoiceRelId);
    ok((await classify())[0].classification === 'MATCHED', 'D7 diagnostic: MATCHED');
  }

  // ── TEST E — RELATIONAL + JOB REPRESENTATION -> ONE CANONICAL ROW ───────
  // REVERT-CHECK: dropping the `jobs` argument at the list-builder call sites
  // (so getManualInvoiceJobRefs falls back to reference/jobNum only) fails
  // E1-E4 with the record and its job-derived twin BOTH rendered — which is
  // the reported "one shows all the buttons, the other shows only View".
  console.log('\n[E] record + job linkage for the SAME logical invoice = one canonical row');
  {
    await reset();
    const cust = await services.createCustomer({ companyName: 'E Client' } as any);
    const job = await services.createJob({
      companyCode: 'SNS', customerId: cust.id, customerNameRaw: 'E Client',
      description: 'E job', value: 11500, stage: 9, status: 'invoiced',
    } as any);
    const manual = await services.createManualInvoice({
      companyCode: 'SNS', contactName: 'E Client', lines: [{ qty: 1, unitAmount: 10000 }],
    } as any);
    await pool.query('UPDATE rel_jobs SET invoice_num=$1, invoice_created=true WHERE id=$2', [manual.invoiceNumber, job.id]);
    await pool.query('UPDATE rel_invoices SET reference=NULL, job_number_raw=NULL, job_id=NULL WHERE id=$1', [manual.id]);
    const s = await snapshot();
    ok(s.acct.length === 1 && s.sales.length === 1, 'E1 exactly ONE row on each screen, never two',
      { acct: s.acct.map((r: any) => r.source), sales: s.sales.map((r: any) => r._isManual) });
    ok(s.acct.filter((r: any) => r.source === 'job').length === 0,
      'E2 no job-derived duplicate survives anywhere in Accounting');
    ok(s.sales.filter((r: any) => r._isManual === false).length === 0,
      'E3 …nor in Sales');
    ok(accountingActions(s.acct[0]).locked.length === 0,
      'E4 the surviving row resolves the FULL action model from the authoritative invoice');
    const unified = box.getAllInvoicesUnified(s.jobs, s.quotes, s.accInvoices);
    ok(unified.length === 1, 'E5 the unified list (dashboard counts + consistency audit) agrees', unified.length);
    ok(box.getPendingJobInvoices(s.jobs, s.accInvoices).length === 0,
      'E6 …and the job is not ALSO reported as "not yet invoiced"');
  }

  // ── TEST F — ORPHAN JOB LINKAGE ────────────────────────────────────────
  console.log('\n[F] an orphan job invoice is detected, labelled, and given NO fake actions');
  {
    await reset();
    const cust = await services.createCustomer({ companyName: 'F Client' } as any);
    const job = await services.createJob({
      companyCode: 'SNS', customerId: cust.id, customerNameRaw: 'F Client',
      description: 'pre-cutover job invoice', value: 5750, stage: 9, status: 'invoiced',
    } as any);
    // Exactly what the pre-cutover createInvoiceNow JSON branch produced: the
    // job carries the invoice, and no accInvoices record was ever created.
    await pool.query(`UPDATE rel_jobs SET invoice_num='INV-04242', invoice_created=true,
      invoice_date='2025-06-01', invoice_status='partial' WHERE id=$1`, [job.id]);
    const s = await snapshot();
    ok(s.accInvoices.length === 0, 'F1 precondition: no rel_invoices row exists at all');
    ok(s.acct.length === 1 && s.acct[0].source === 'job',
      'F2 it still appears — it is a REAL invoice, not hidden', s.acct.map((r: any) => r.source));
    ok(box.jobInvoiceLinkState(s.jobs[0], s.accInvoices) === 'orphaned',
      'F3 it is explicitly classified ORPHANED, not silently treated as normal',
      box.jobInvoiceLinkState(s.jobs[0], s.accInvoices));
    ok(s.jobs[0].invoiceLinkState === 'orphaned' && s.jobs[0].invoiceRelId === null,
      'F4 the SERVER says so too (read.ts), not just the browser', {
        state: s.jobs[0].invoiceLinkState, relId: s.jobs[0].invoiceRelId });
    const aa = accountingActions(s.acct[0]);
    ok(aa.enabled.indexOf('Edit') === -1 && aa.enabled.indexOf('Delete') === -1
      && aa.enabled.indexOf('Status') === -1 && aa.enabled.indexOf('Email') === -1,
      'F5 NO fake Edit / Status / Email / Delete is attached — there is no backend target', aa.enabled);
    ok(aa.locked.length === 4, 'F6 …those four are shown LOCKED with a reason, not silently dropped', aa.locked);
    ok(aa.enabled.indexOf('View') !== -1 && aa.enabled.indexOf('Payments') !== -1 && aa.enabled.indexOf('Print') !== -1,
      'F7 everything that DOES have a real target (the job) is still offered', aa.enabled);
    const sa = salesActions(s.sales[0]);
    ok(sa.enabled.indexOf('Delete') === -1 && sa.locked.indexOf('Delete') !== -1,
      'F8 Sales likewise refuses to offer Delete for it', sa);
    ok(sa.enabled.indexOf('Edit') !== -1,
      'F9 …but Sales keeps Edit, which acts on the JOB — a real target, unchanged behaviour');
    const cls = await classify();
    ok(cls.length === 1 && cls[0].classification === 'ORPHANED' && cls[0].match_count === 0,
      'F10 the diagnostic classifies it ORPHANED with 0 matches', cls);
  }

  // ── TEST G — DELETE REGRESSION (the repair deployed immediately before) ─
  console.log('\n[G] the deployed invoice-delete repair still behaves exactly as deployed');
  {
    await reset();
    const { job, inv } = await seedInvoicedJob('SNS', 'G Client', 11500, 7);
    const stageBefore = (await pool.query('SELECT stage, status FROM rel_jobs WHERE id=$1', [job.id])).rows[0];
    const before = await snapshot();
    ok(before.acct.length === 1 && before.sales.length === 1, 'G1 precondition: one canonical row on each screen');
    const rel = before.accInvoices[0];
    const res = await services.deleteInvoice(rel._relId, rel._relRowVersion);
    ok(res.deleted === true && res.clearedJobs.length === 1 && res.clearedJobs[0].jobNumber === job.jobNumber,
      'G2 the delete still reverses the job-side linkage and reports it', res.clearedJobs);
    const after = await snapshot();
    ok(after.accInvoices.length === 0, 'G3 the authoritative invoice is gone');
    ok(after.acct.length === 0, 'G4 Accounting no longer shows it', after.acct);
    ok(after.sales.length === 0, 'G5 Sales no longer shows it', after.sales);
    const jobRow = (await pool.query('SELECT * FROM rel_jobs WHERE id=$1', [job.id])).rows[0];
    ok(!!jobRow, 'G6 the JOB itself still exists');
    ok(jobRow.invoice_num === null && jobRow.invoice_created === false,
      'G7 its invoice linkage is cleared', { n: jobRow.invoice_num, c: jobRow.invoice_created });
    ok(jobRow.stage === stageBefore.stage && jobRow.status === stageBefore.status,
      'G8 the job lifecycle is NOT falsely rolled backwards', { before: stageBefore, after: { stage: jobRow.stage, status: jobRow.status } });
    // Hard refresh — a completely fresh authoritative read.
    const refreshed = await snapshot();
    ok(refreshed.acct.length === 0 && refreshed.sales.length === 0 && refreshed.accInvoices.length === 0,
      'G9 a hard refresh does not resurrect it anywhere', { a: refreshed.acct.length, s: refreshed.sales.length });
    ok(box.getPendingJobInvoices(refreshed.jobs, refreshed.accInvoices).length === 1,
      'G10 the job correctly reappears as "ready to invoice but not yet invoiced"');
    ok((await classify()).length === 0, 'G11 the diagnostic reports no lingering job-side linkage');
  }

  // ── TEST H — PAYMENT DEPENDENCY ────────────────────────────────────────
  console.log('\n[H] payments: visibility, allocation, deletion, and the canonical owner');
  {
    await reset();
    const { job, inv } = await seedInvoicedJob('SNS', 'H Client', 11500, 7);
    const rel = (await buildInvoicesJson())[0];
    const pay = await services.recordPayment({ type: 'invoice', id: rel._relId }, 2000, { date: '2026-08-01', method: 'EFT' });
    let s = await snapshot();
    const acctRow = s.acct.find((r: any) => r.number === inv.invoiceNumber);
    ok((acctRow.payments || []).length === 1, 'H1 the payment is visible on the canonical invoice', acctRow.payments);
    const source = box.getJobManualInvoice(s.jobs[0], s.accInvoices);
    ok(!!source && String(source._relId) === String(rel._relId),
      'H2 the job resolves its payments to that SAME record — one owner, never two', source && source._relId);
    ok((s.jobs[0].payments || []).length === 0,
      'H3 the payment is not ALSO duplicated onto the job', s.jobs[0].payments);
    const invRow = (await pool.query('SELECT status FROM rel_invoices WHERE id=$1', [rel._relId])).rows[0];
    ok(invRow.status === 'partial', 'H4 invoice payment state recomputed correctly', invRow.status);
    // Refresh persistence.
    s = await snapshot();
    ok((s.acct.find((r: any) => r.number === inv.invoiceNumber).payments || []).length === 1,
      'H5 it survives a full authoritative rehydration');
    // Deletion.
    const pRow = (await pool.query('SELECT id, row_version FROM rel_payments WHERE id=$1', [pay.paymentId])).rows[0];
    await services.deletePayment(pRow.id, pRow.row_version);
    s = await snapshot();
    ok((s.acct.find((r: any) => r.number === inv.invoiceNumber).payments || []).length === 0,
      'H6 deleting it removes it, and it stays removed after rehydration');
    ok(s.acct.length === 1 && s.sales.length === 1,
      'H7 …and none of this disturbed canonicalization', { a: s.acct.length, s: s.sales.length });
    // Quote -> Job payment consistency (the recently repaired path).
    await reset();
    const cq = await services.createCustomer({ companyName: 'H Quote Client' } as any);
    const q = await services.createQuote({
      companyCode: 'SNS', customerId: cq.id, customerNameRaw: 'H Quote Client',
      description: 'q', value: 5750, status: 'accepted', lines: [{ desc: 'x', qty: 1, unitPrice: 5000 }],
    } as any);
    await services.recordPayment({ type: 'quote', id: q.id }, 1000, { date: '2026-08-01', method: 'EFT' });
    const conv = await services.convertQuoteToJob(q.id);
    const s2 = await snapshot();
    const jobJson = s2.jobs.find((j: any) => j.num === conv.jobNumber);
    const rec = box.reconcileJobInvoice(jobJson, s2.quotes);
    ok((rec.payments || []).length === 1,
      'H8 a deposit taken on the quote is still visible on the converted job', rec.payments);
  }

  // ── TEST I — CREDIT NOTE DEPENDENCY ────────────────────────────────────
  console.log('\n[I] credit notes: consumption and release survive canonicalization');
  {
    await reset();
    const { inv } = await seedInvoicedJob('SNS', 'I Client', 11500, 7);
    const rel = (await buildInvoicesJson())[0];
    const note = await services.createCreditNote({
      companyCode: 'SNS', type: 'customer', contactName: 'I Client',
      date: '2026-07-01', amount: 2000, reason: 'Return',
    } as any);
    await services.recordPayment({ type: 'invoice', id: rel._relId }, 1500, { date: '2026-08-01', method: 'Credit' });
    const used = Number((await pool.query('SELECT used_amount FROM rel_credit_notes WHERE id=$1', [note.id])).rows[0].used_amount);
    ok(used === 1500, 'I1 the Credit payment consumed R1500 of the note', used);
    const s = await snapshot();
    ok(s.acct.length === 1 && s.sales.length === 1, 'I2 the invoice is still one canonical row');
    const rel2 = (await buildInvoicesJson())[0];
    const res = await services.deleteInvoice(rel2._relId, rel2._relRowVersion);
    ok(res.creditReleased === 1500, 'I3 deleting it releases the credit (deployed repair intact)', res.creditReleased);
    const after = Number((await pool.query('SELECT used_amount FROM rel_credit_notes WHERE id=$1', [note.id])).rows[0].used_amount);
    ok(after === 0, 'I4 …and the note is restored, never silently burnt', after);
    ok((await pool.query('SELECT COUNT(*)::int c FROM rel_credit_notes')).rows[0].c === 1,
      'I5 the credit note itself is never deleted by an invoice delete');
    ok(!!inv.invoiceNumber, 'I6 (fixture sanity)');
  }

  // ── TEST J — COMPANY ISOLATION ─────────────────────────────────────────
  console.log('\n[J] company isolation: canonical matching NEVER crosses a company');
  {
    await reset();
    const custS = await services.createCustomer({ companyName: 'J SNS Client' } as any);
    const jobS = await services.createJob({
      companyCode: 'SNS', customerId: custS.id, customerNameRaw: 'J SNS Client',
      description: 'sns job', value: 1150, stage: 9, status: 'invoiced',
    } as any);
    const invU = await services.createManualInvoice({
      companyCode: 'UTS', contactName: 'J UTS Client', lines: [{ qty: 1, unitAmount: 900 }],
    } as any);
    // The SNS job carries a number that belongs to a UTS invoice. Same number,
    // different company: this must NEVER resolve to one row.
    await pool.query('UPDATE rel_jobs SET invoice_num=$1, invoice_created=true WHERE id=$2', [invU.invoiceNumber, jobS.id]);
    const s = await snapshot();
    ok(s.jobs[0].invoiceRelId === null,
      'J1 the server refuses to link the SNS job to the UTS invoice', s.jobs[0].invoiceRelId);
    const state = box.jobInvoiceLinkState(s.jobs[0], s.accInvoices);
    ok(state === 'invalid', 'J2 the browser classifies it INVALID, not matched', state);
    ok(box.resolveJobInvoiceRecord(s.jobs[0], s.accInvoices) === null,
      'J3 canonical resolution returns nothing — no cross-company merge');
    ok(s.acct.length === 2, 'J4 the two remain two separate rows', s.acct.map((r: any) => `${r.number}:${r.source}`));
    const orphanRow = s.acct.find((r: any) => r.source === 'job');
    ok(accountingActions(orphanRow).enabled.indexOf('Delete') === -1,
      'J5 …and the invalid job row gets no destructive action');
    const cls = await classify();
    const snsRow = cls.find((r: any) => r.company_code === 'SNS');
    ok(snsRow && snsRow.classification === 'INVALID' && snsRow.same_number_other_company > 0,
      'J6 the diagnostic classifies it INVALID', snsRow);
    // And the UI filter each page applies keeps them apart in the first place.
    if (typeof box.belongsToUserCompany === 'function') {
      const holdingsUser = { role: 'admin', co: 1 };
      const originalUser = { role: 'admin', co: 2 };
      const recs = [{ id: 'h', co: 1 }, { id: 'o', co: 2 }, { id: 'u' }];
      ok(recs.filter((r) => box.belongsToUserCompany(r, holdingsUser)).map((r) => r.id).join() === 'h',
        'J7 a Holdings user sees only Holdings records');
      ok(recs.filter((r) => box.belongsToUserCompany(r, originalUser)).map((r) => r.id).join() === 'o,u',
        'J8 an Original user never sees Holdings records');
    } else { ok(false, 'J7/J8 belongsToUserCompany could not be extracted'); }
  }

  // ── TEST K — INV-00099 DUPLICATE-DISPLAY REGRESSION ────────────────────
  console.log('\n[K] the INV-00099 duplicate-display conditions produce ONE canonical row');
  {
    await reset();
    const { job, inv } = await seedInvoicedJob('SNS', 'K Client', 11500, 7);
    // Strip every dedup key the 2026-08-24 stabilization added, reproducing
    // the exact pre-repair shape that rendered INV-00099 twice.
    await pool.query('UPDATE rel_invoices SET reference=NULL, job_number_raw=NULL WHERE invoice_number=$1', [inv.invoiceNumber]);
    const s = await snapshot();
    ok(s.acct.length === 1, 'K1 Accounting shows ONE row, not the real one plus an R0.00 twin',
      s.acct.map((r: any) => `${r.number}:${r.source}`));
    ok(s.sales.length === 1, 'K2 Sales shows ONE row', s.sales.map((r: any) => `${r.invoiceNum}:${r._isManual}`));
    ok(s.acct[0].source === 'manual', 'K3 the surviving row is the authoritative record');
    const amounts = s.acct.map((r: any) => (r.lineItems || []).reduce((t: number, l: any) => t + parseFloat(l.qty || 1) * parseFloat(l.unitAmount || 0), 0));
    ok(amounts[0] > 0, 'K4 …and it renders a real amount, never R0.00', amounts);
    const unified = box.getAllInvoicesUnified(s.jobs, s.quotes, s.accInvoices);
    const nums = unified.map((i: any) => i.number);
    ok(new Set(nums).size === nums.length, 'K5 the consistency audit sees no duplicate invoice number', nums);
    ok(String(s.jobs[0].invoiceRelId) === String(s.accInvoices[0]._relId),
      'K6 the server resolved job -> invoice even with every key stripped', s.jobs[0].invoiceRelId);
    ok(!!job.jobNumber, 'K7 (fixture sanity)');
  }

  // ── TEST L — SAVE-PATH REGRESSION ──────────────────────────────────────
  console.log('\n[L] rendering and acting on invoices never touches the platform_state save path');
  {
    for (const fnName of ['resolveJobInvoiceRecord', 'jobInvoiceLinkState', 'getManualInvoiceJobRefs',
      'getJobManualInvoice', 'getAllInvoicesUnified', 'getJobInvoices', 'getPendingJobInvoices']) {
      const src = extractFunction(HTML, fnName);
      const dirty = ['forceSaveSections', 'saveToServer', 'mergeAndSave', 'platform-state', 'setJobs(', 'setAccInvoices(']
        .filter((t) => src.indexOf(t) !== -1);
      ok(dirty.length === 0, `L1 ${fnName} is pure/read-only — no save path, no state mutation`, dirty);
    }
    const delSrc = extractFunction(HTML, 'deleteCanonicalInvoice');
    ok(['forceSaveSections', 'saveToServer', 'mergeAndSave', 'platform-state', '_partial', '_deletedIds']
      .every((t) => delSrc.indexOf(t) === -1),
      'L2 the shared delete is a purely relational write — the partial-save architecture is untouched');
    // Behavioural: run the shipped shared delete with the whole legacy save
    // surface wired as spies, then ask the SHIPPED autosave diff whether it
    // would now emit a save.
    const saveBox: any = {
      console, JSON, Object, Array, Set, Number, String, parseFloat, Math, Date,
      alert: () => undefined, zar: (n: number) => 'R' + n,
      window: { confirm: () => true },
      isRelationalAuthoritative: () => true,
      describeSaveConflictError: (e: any) => (e && e.message) || 'e',
      forceSaveSections: (...a: any[]) => saveBox.illegal.push(['forceSaveSections', a]),
      saveToServer: (...a: any[]) => saveBox.illegal.push(['saveToServer', a]),
      mergeAndSave: (...a: any[]) => saveBox.illegal.push(['mergeAndSave', a]),
      fetch: (...a: any[]) => { saveBox.illegal.push(['fetch', a]); return Promise.resolve({ ok: true, json: async () => ({}) }); },
      illegal: [] as any[],
      relationalApi: {
        deleteInvoice: async () => ({
          success: true, deleted: true, ambiguousJobs: [], creditReleased: 0,
          clearedJobs: [{ id: 42, sourceId: '42', jobNumber: 'SNS-00112', rowVersion: 9 }],
        }),
      },
    };
    saveBox.localState = {
      accInvoices: [{ id: 'inv-1', number: 'INV-00099', _relId: 7, _relRowVersion: 3, payments: [], reference: 'SNS-00112' }],
      jobs: [{ id: 900, _relId: '42', num: 'SNS-00112', invoiceNum: 'INV-00099', invoiceCreated: true, _relRowVersion: 8 }],
      customers: [{ id: 1, name: 'Keep me' }],
    };
    saveBox.baselineState = JSON.parse(JSON.stringify(saveBox.localState));
    saveBox.setAccInvoices = (u: any) => { saveBox.localState.accInvoices = u(saveBox.localState.accInvoices); };
    saveBox.setJobs = (u: any) => { saveBox.localState.jobs = u(saveBox.localState.jobs); };
    saveBox.syncRelationalBaseline = (sec: string, u: any) => {
      if (Array.isArray(saveBox.baselineState[sec])) saveBox.baselineState[sec] = u(saveBox.baselineState[sec]);
    };
    vm.createContext(saveBox);
    vm.runInContext(extractFunction(HTML, 'deleteCanonicalInvoice'), saveBox);
    if (STATE_SECTIONS_SRC) vm.runInContext(STATE_SECTIONS_SRC[0], saveBox);
    vm.runInContext(extractFunction(HTML, 'locallyChangedSections'), saveBox);
    await vm.runInContext(`deleteCanonicalInvoice('inv-1', { accInvoices: localState.accInvoices.slice(), setAccInvoices, setJobs })`, saveBox);
    ok(saveBox.illegal.length === 0, 'L3 no legacy save function and no network call was invoked', saveBox.illegal);
    const changed = vm.runInContext('locallyChangedSections(localState, baselineState)', saveBox);
    ok(changed && Object.keys(changed).length === 0,
      'L4 the SHIPPED autosave diff reports NOTHING changed — no platform_state save is triggered', changed);
    ok(saveBox.localState.customers.length === 1 && saveBox.baselineState.customers.length === 1,
      'L5 no other section was touched');
    ok(saveBox.localState.accInvoices.length === 0 && !saveBox.localState.jobs[0].invoiceNum,
      'L6 …while both halves really did move together', saveBox.localState);
  }

  // ── TEST M — FULL REFRESH / AUTHORITATIVE REHYDRATION ──────────────────
  console.log('\n[M] every canonical result survives a full authoritative rehydration');
  {
    await reset();
    const a = await seedInvoicedJob('SNS', 'M A', 11500, 7);
    const b = await seedInvoicedJob('SNS', 'M B', 23000, 7);
    // one historical unbacked, one backfill-shaped matched
    const custC = await services.createCustomer({ companyName: 'M C' } as any);
    const jobC = await services.createJob({ companyCode: 'SNS', customerId: custC.id, customerNameRaw: 'M C', description: 'c', value: 900, stage: 9, status: 'invoiced' } as any);
    await pool.query(`UPDATE rel_jobs SET invoice_num='INV-09999', invoice_created=true WHERE id=$1`, [jobC.id]);
    const standalone = await services.createManualInvoice({ companyCode: 'SNS', contactName: 'M Walk-in', lines: [{ qty: 1, unitAmount: 500 }] } as any);
    const first = await snapshot();
    const second = await snapshot();
    ok(JSON.stringify(first.acct.map((r: any) => [r.number, r.source])) === JSON.stringify(second.acct.map((r: any) => [r.number, r.source])),
      'M1 two independent authoritative reads produce identical Accounting rows');
    ok(JSON.stringify(first.sales.map((r: any) => [r.invoiceNum, r._isManual])) === JSON.stringify(second.sales.map((r: any) => [r.invoiceNum, r._isManual])),
      'M2 …and identical Sales rows');
    ok(first.acct.length === 4, 'M3 four logical invoices, four rows — no duplicates, no ghosts',
      first.acct.map((r: any) => `${r.number}:${r.source}`));
    ok(first.acct.filter((r: any) => r.source === 'job').length === 1,
      'M4 exactly one of them is the unbacked historical invoice', first.acct.filter((r: any) => r.source === 'job').map((r: any) => r.number));
    const salesNums = first.sales.map((r: any) => r.invoiceNum).sort();
    const acctNums = first.acct.map((r: any) => r.number).sort();
    ok(JSON.stringify(salesNums) === JSON.stringify(acctNums),
      'M5 Sales and Accounting agree on exactly which invoices exist', { salesNums, acctNums });
    ok(!!a.inv && !!b.inv && !!standalone.invoiceNumber, 'M6 (fixture sanity)');
  }

  // ── TESTS N/O/P/Q — THE FOUR DIAGNOSTIC CLASSIFICATIONS ────────────────
  console.log('\n[N/O/P/Q] the four diagnostic classifications, on deterministic fixtures');
  {
    await reset();
    // N — MATCHED
    const m = await seedInvoicedJob('SNS', 'N Client', 1150, 7);
    // O — ORPHANED
    const co = await services.createCustomer({ companyName: 'O Client' } as any);
    const jo = await services.createJob({ companyCode: 'SNS', customerId: co.id, customerNameRaw: 'O Client', description: 'o', value: 500, stage: 9, status: 'invoiced' } as any);
    await pool.query(`UPDATE rel_jobs SET invoice_num='INV-08001', invoice_created=true WHERE id=$1`, [jo.id]);
    await services.recordPayment({ type: 'job', id: jo.id }, 250, { date: '2026-02-01', method: 'EFT' });
    // P — AMBIGUOUS (two jobs claiming the same single invoice)
    const cp = await services.createCustomer({ companyName: 'P Client' } as any);
    const jp = await services.createJob({ companyCode: 'SNS', customerId: cp.id, customerNameRaw: 'P Client', description: 'p', value: 700, stage: 9, status: 'invoiced' } as any);
    await pool.query('UPDATE rel_jobs SET invoice_num=$1, invoice_created=true WHERE id=$2', [m.inv.invoiceNumber, jp.id]);
    // Q — INVALID (number belongs to another company)
    const cq2 = await services.createCustomer({ companyName: 'Q Client' } as any);
    const jq = await services.createJob({ companyCode: 'SNS', customerId: cq2.id, customerNameRaw: 'Q Client', description: 'q', value: 300, stage: 9, status: 'invoiced' } as any);
    const utsInv = await services.createManualInvoice({ companyCode: 'UTS', contactName: 'UTS Client', lines: [{ qty: 1, unitAmount: 250 }] } as any);
    await pool.query(`UPDATE rel_invoices SET invoice_number='INV-77777' WHERE id=$1`, [utsInv.id]);
    await pool.query(`UPDATE rel_jobs SET invoice_num='INV-77777', invoice_created=true WHERE id=$1`, [jq.id]);

    const cls = await classify();
    const by = (jobNum: string) => cls.find((r: any) => r.job_number === jobNum);
    // In THIS fixture two jobs deliberately claim m's invoice, so m is
    // AMBIGUOUS — asserted exactly, never as "either answer will do".
    ok(by(m.job.jobNumber)?.classification === 'AMBIGUOUS',
      'N1 a job whose invoice is also claimed by another job is AMBIGUOUS, not MATCHED', by(m.job.jobNumber));
    ok(by(m.job.jobNumber)?.relational_invoice_id == null,
      'N2 …and AMBIGUOUS therefore reports NO resolved invoice id — the collision needs a person', by(m.job.jobNumber)?.relational_invoice_id);
    ok(by(jo.jobNumber)?.classification === 'ORPHANED' && by(jo.jobNumber)?.match_count === 0,
      'O1 ORPHANED = job claims an invoice, zero authoritative matches', by(jo.jobNumber));
    ok(by(jo.jobNumber)?.job_payment_count === 1,
      'O2 …and its payment dependency is reported so it is never cleared blindly', by(jo.jobNumber)?.job_payment_count);
    ok(by(jp.jobNumber)?.classification === 'AMBIGUOUS',
      'P1 AMBIGUOUS = the identity cannot be resolved to one job/invoice pair safely', by(jp.jobNumber));
    ok(by(jp.jobNumber)?.jobs_claiming_same_invoice === 2,
      'P2 …reported with how many jobs claim the same invoice', by(jp.jobNumber)?.jobs_claiming_same_invoice);
    ok(by(jq.jobNumber)?.classification === 'INVALID' && by(jq.jobNumber)?.same_number_other_company === 1,
      'Q1 INVALID = the linkage cannot be a valid identity (number belongs to another company)', by(jq.jobNumber));
    const kinds = new Set(cls.map((r: any) => r.classification));
    ok(kinds.has('ORPHANED') && kinds.has('AMBIGUOUS') && kinds.has('INVALID'),
      'Q2 this fixture exercises ORPHANED, AMBIGUOUS and INVALID together', Array.from(kinds));
    ok(Array.from(kinds).every((k) => ['MATCHED', 'ORPHANED', 'AMBIGUOUS', 'INVALID', 'NO_NUMBER'].indexOf(k as string) !== -1),
      'Q3 no classification outside the agreed set is ever produced', Array.from(kinds));
  }

  // ── TEST R — THE MODELS ARE PINNED TO THE SHIPPED JSX ──────────────────
  console.log('\n[R] the action-contract models are pinned to what actually ships');
  {
    ok(HTML.indexOf("const isJob = inv.source==='job';") !== -1,
      'R1 Accounting still splits its action cell on inv.source===\'job\'');

    // ── MODEL FIDELITY ──────────────────────────────────────────────────
    // accountingActions()/salesActions() above are hand-written models. Read
    // the ACTUAL JSX branches out of index.html and assert each branch really
    // does enable exactly what the model claims and lock exactly what it
    // claims — otherwise every action assertion in this suite is vacuous.
    const acctJobBranch = sliceBetween(HTML, '{isJob?(\n                            /* ── INVOICE LIST CONSISTENCY', '):(');
    ok(acctJobBranch.length > 0, 'R2a the Accounting job branch was located in the shipped JSX');
    ok(acctJobBranch.indexOf('👁 View') !== -1 && acctJobBranch.indexOf('💳 Payments') !== -1
      && acctJobBranch.indexOf('🧾 Print') !== -1,
      'R2b …it ENABLES exactly View, Payments and Print (the model\'s enabled set)');
    ok((acctJobBranch.match(/PaymentLockedBadge/g) || []).length === 4
      && acctJobBranch.indexOf('>Edit ') !== -1 && acctJobBranch.indexOf('>Email ') !== -1
      && acctJobBranch.indexOf('✓ Paid ') !== -1 && acctJobBranch.indexOf('✕ Delete ') !== -1,
      'R2c …and LOCKS exactly Edit, Email, Status and Delete (the model\'s locked set)',
      (acctJobBranch.match(/PaymentLockedBadge/g) || []).length);
    ok(acctJobBranch.indexOf('setEditInv(') === -1 && acctJobBranch.indexOf('deleteInvoice(') === -1
      && acctJobBranch.indexOf('markInvPaid(') === -1,
      'R2d …and wires NO destructive/record-editing handler at all for an unbacked row');

    const acctRecordBranch = sliceBetween(HTML, "<button onClick={()=>setViewInv(inv)} className=\"text-xs font-bold px-2 py-1 rounded-lg\" style={{background:'#f0f4ff',color:'#4338ca'}}>👁 View</button>\n                              <button onClick={()=>{setPayModalInv(inv);setShowPayModal(true);}}", '</td>');
    ok(acctRecordBranch.indexOf('💳 Payments') !== -1 && acctRecordBranch.indexOf('Edit</button>') !== -1
      && acctRecordBranch.indexOf('🧾 Print') !== -1 && acctRecordBranch.indexOf('📧 Email') !== -1
      && acctRecordBranch.indexOf('✓ Paid') !== -1 && acctRecordBranch.indexOf('deleteInvoice(inv.id)') !== -1,
      'R2e the Accounting RECORD branch enables the full contract, Delete included', acctRecordBranch.length);

    const salesManualBranch = sliceBetween(HTML, '{j._isManual?(', '):(\n                        <>');
    for (const [ctl, marker] of [['View', '👁 View'], ['Payments', '💳 Payments'], ['Edit', '✏️ Edit'],
      ['Print', '🧾 Print'], ['Email', '📧 Email'], ['Status', '✓ Paid'], ['Delete', '✕ Delete']]) {
      ok(salesManualBranch.indexOf(marker) !== -1,
        `R2f Sales' record branch exposes ${ctl} — the full contract, same as Accounting`);
    }
    const salesJobBranch = sliceBetween(HTML, 'reference:j.num, contactName:j.client', '\n                    )}\n                  </div>');
    ok(salesJobBranch.indexOf('✓ Paid <PaymentLockedBadge') !== -1
      && salesJobBranch.indexOf('✕ Delete <PaymentLockedBadge') !== -1,
      'R2g Sales\' job branch LOCKS Status and Delete with the shared explanation');

    // The regression that broke the shared modal: identifiers left behind by
    // the hoist. Pin every one that is not module-level as an explicit prop.
    const modalSig = /function ViewInvoiceModal\(\{[\s\S]*?\}\) \{/.exec(HTML);
    ok(!!modalSig && modalSig[0].indexOf('fmtDate') !== -1 && modalSig[0].indexOf('fmtAmt') !== -1,
      'R2h the shared modal takes fmtDate/fmtAmt as PROPS — they are page-local, so a hoist that dropped them crashed the app on open');
    ok(/\nconst STATUS_COLORS = \{/.test(HTML),
      'R2i …and STATUS_COLORS is module-level (single definition) rather than left behind in AccountingPage');
    ok(HTML.indexOf('deleteCanonicalInvoice(manualRec.id, { accInvoices: myAccInvoices, setAccInvoices, setJobs })') !== -1,
      'R3 Sales deletes through the SHARED implementation, against the company-filtered list');
    ok(HTML.indexOf('markCanonicalInvoicePaid(manualRec, { setAccInvoices, onJsonFallback: saveManualInvoiceFromSales })') !== -1,
      'R4 Sales marks paid through the SHARED implementation, WITH a real persistence fallback (never a silent no-op)');
    ok(HTML.indexOf('return deleteCanonicalInvoice(id, { accInvoices, setAccInvoices, setJobs });') !== -1
      && HTML.indexOf('return markCanonicalInvoicePaid(inv, { setAccInvoices, onJsonFallback: saveInvoice });') !== -1,
      'R5 Accounting calls the same two shared implementations — one copy of each action exists');
    ok(HTML.indexOf('function ViewInvoiceModal({ inv, onClose, onEdit, quotes, jobs, accInvoices, customers,') !== -1,
      'R6 the read-only invoice view is hoisted and shared, not duplicated per page');
    ok((HTML.match(/<ViewInvoiceModal/g) || []).length === 2,
      'R7 …and rendered by BOTH Sales and Accounting', (HTML.match(/<ViewInvoiceModal/g) || []).length);
    ok(HTML.indexOf('INVOICE_NO_ACCOUNTING_RECORD_REASON') !== -1
      && (HTML.match(/PaymentLockedBadge reason=\{INVOICE_NO_ACCOUNTING_RECORD_REASON\}/g) || []).length >= 6,
      'R8 every unavailable action carries the same persistent explanation',
      (HTML.match(/PaymentLockedBadge reason=\{INVOICE_NO_ACCOUNTING_RECORD_REASON\}/g) || []).length);
    ok(HTML.indexOf('guardAction(\'deleteInvoice:\'+inv.id') !== -1
      && HTML.indexOf('guardAction(\'deleteInvoice:\'+manualRec.id') !== -1,
      'R9 both delete buttons keep the in-flight duplicate-submission guard');
    for (const call of ['getManualInvoiceJobRefs(accInvoices, jobs)', 'getManualInvoiceJobRefs(myAccInvoices, myJobs)',
      'getManualInvoiceJobRefs(visibleAccInvoices, visibleJobs)']) {
      ok(HTML.indexOf(call) !== -1, `R10 canonical resolution is wired at "${call}"`);
    }
    ok(HTML.indexOf('function getJobManualInvoice(job, accInvoices, jobs) {\n  return resolveJobInvoiceRecord(job, accInvoices, jobs);\n}') !== -1,
      'R11 the lookup and the membership index share ONE implementation and cannot drift');
  }

  console.log(`\n──────── ${passed} passed, ${failures} failed ────────\n`);
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
