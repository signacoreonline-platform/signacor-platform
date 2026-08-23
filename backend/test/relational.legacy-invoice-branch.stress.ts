/**
 * relational.legacy-invoice-branch.stress.ts — STAGE 3 Phase 6 verification.
 *
 * createInvoiceForJob (services.ts) used to unconditionally refuse via
 * BusinessRuleError the moment a job's invoice_num was already set — even
 * for the entirely legitimate case of a job backfilled from historical
 * JSON with invoiceNum populated but invoiceCreated still false (the
 * "flip-flags-only" legacy path index.html's createInvoiceNow already
 * handles on the JSON side, at the `if(job.invoiceNum){...}` branch, but
 * which had NO relational-safe equivalent at all before this fix).
 *
 * This suite proves the three real outcomes the fixed function must
 * produce:
 *   1. job already fully invoiced (invoice_created=true)            -> the
 *      OLD refusal still applies, unchanged (BusinessRuleError, 409
 *      business_rule)
 *   2. job carries an invoice_num but invoice_created=false, and NO
 *      rel_invoices row exists yet for that number                  -> the
 *      EXACT existing number is adopted (never a fresh reservation), a
 *      single new rel_invoices row is created with it, job flags flip
 *   3. job carries an invoice_num but invoice_created=false, and that
 *      EXACT number already belongs to a DIFFERENT job's invoice       ->
 *      refused with the new LegacyInvoiceConflictError (409
 *      legacy_conflict), never silently reassigned or duplicated
 */
import pool from '../src/db/pool';
import * as services from '../src/relational/services';
import { LegacyInvoiceConflictError, BusinessRuleError } from '../src/relational/services';

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

async function resetStage3Tables() {
  await pool.query(`
    TRUNCATE TABLE rel_payments, rel_invoice_line_items, rel_invoices, rel_job_line_items,
      rel_jobs, rel_quote_line_items, rel_quotes, rel_customers
    RESTART IDENTITY CASCADE
  `);
  await pool.query(`DELETE FROM document_number_counters`);
  await pool.query(`DELETE FROM quote_conversions`);
}

async function makeJob(overrides: Partial<{ invoiceNum: string | null; invoiceCreated: boolean }> = {}) {
  const cust = await services.createCustomer({ companyName: 'Legacy Invoice Test Co' });
  const quote = await services.createQuote({
    companyCode: '2', customerId: cust.id, customerNameRaw: 'Legacy Invoice Test Co',
    lines: [{ description: 'Banner', qty: 1, unitPrice: 1000 }],
  });
  const conv = await services.convertQuoteToJob(quote.id);
  const jobId = conv.jobId;
  if (overrides.invoiceNum !== undefined || overrides.invoiceCreated !== undefined) {
    await pool.query(
      `UPDATE rel_jobs SET invoice_num = $1, invoice_created = $2 WHERE id = $3`,
      [overrides.invoiceNum ?? null, overrides.invoiceCreated ?? false, jobId]
    );
  }
  return jobId;
}

async function main() {
  await resetStage3Tables();

  console.log('\n[Legacy invoice branch] Scenario 1: job genuinely already invoiced (invoice_created=true) — old refusal unchanged');
  const job1 = await makeJob({ invoiceNum: 'INV-90001', invoiceCreated: true });
  try {
    await services.createInvoiceForJob(job1);
    ok(false, 'createInvoiceForJob threw for an already-invoiced job');
  } catch (err) {
    ok(err instanceof BusinessRuleError, 'already-invoiced job refuses with BusinessRuleError (unchanged behavior)', err);
    ok(!(err instanceof LegacyInvoiceConflictError), 'this is NOT classified as a legacy_conflict — it is an ordinary business rule refusal');
  }

  console.log('\n[Legacy invoice branch] Scenario 2: job carries invoiceNum but invoice_created=false, no rel_invoices row exists yet — adopt the EXACT existing number');
  const job2 = await makeJob({ invoiceNum: 'INV-LEGACY-777', invoiceCreated: false });
  const beforeCounters = await pool.query(`SELECT count(*)::int AS n FROM document_number_counters`);
  const result2 = await services.createInvoiceForJob(job2);
  ok(result2.invoiceNumber === 'INV-LEGACY-777', 'the EXACT pre-existing invoice number is adopted verbatim, never a freshly reserved one', result2);
  ok(result2.legacyMapped === true, 'result is flagged legacyMapped=true so callers can tell this apart from a normal fresh invoice');
  const afterCounters = await pool.query(`SELECT count(*)::int AS n FROM document_number_counters`);
  ok(beforeCounters.rows[0].n === afterCounters.rows[0].n, 'no atomic document-number counter row was consumed for this legacy adoption', { before: beforeCounters.rows[0].n, after: afterCounters.rows[0].n });
  const invRow2 = await pool.query(`SELECT invoice_number, job_id FROM rel_invoices WHERE id = $1`, [result2.invoiceId]);
  ok(invRow2.rows[0]?.invoice_number === 'INV-LEGACY-777' && String(invRow2.rows[0]?.job_id) === String(job2), 'exactly one rel_invoices row was created, linked to this job, using the legacy number', invRow2.rows[0]);
  // 2026-08-23 (production cutover repair — JOB FINANCIAL + LIFECYCLE
  // REPAIR): createInvoiceForJob no longer bumps stage/status to
  // Invoiced(9) unconditionally — only once the job has already reached
  // INSTALL_STAGE (7) organically. makeJob() creates job2 via
  // convertQuoteToJob, which always leaves a fresh job at stage 4
  // (quote_approved) — well before Installation — so adopting this job's
  // legacy invoice number here must link the invoice (invoice_created
  // flips true) WITHOUT fabricating Deposit Received/In Production/
  // Installation/Completed by jumping stage straight to 9. This assertion
  // previously expected stage:9/status:'invoiced' unconditionally — that
  // was the exact bug (invoice existence used as proof of lifecycle
  // position) this repair fixes; see services.ts's createInvoiceForJob.
  const jobRow2 = await pool.query(`SELECT invoice_created, status, stage FROM rel_jobs WHERE id = $1`, [job2]);
  ok(jobRow2.rows[0]?.invoice_created === true && jobRow2.rows[0]?.status === 'quote_approved' && jobRow2.rows[0]?.stage === 4, 'job invoice flag flips true, but stage/status are NOT fabricated forward since this job has not reached INSTALL_STAGE', jobRow2.rows[0]);

  console.log('\n[Legacy invoice branch] calling it again on the SAME job now correctly refuses as already-invoiced (not re-triggering legacy adoption)');
  try {
    await services.createInvoiceForJob(job2);
    ok(false, 'a second call on the now-invoiced job throws');
  } catch (err) {
    ok(err instanceof BusinessRuleError && !(err instanceof LegacyInvoiceConflictError), 'second call is an ordinary "already invoiced" refusal, not a legacy conflict', err);
  }

  console.log('\n[Legacy invoice branch] Scenario 3: invoiceNum collides with a DIFFERENT job\'s existing invoice — refused as a structured legacy_conflict, nothing overwritten');
  const jobA = await makeJob({ invoiceNum: 'INV-COLLIDE-999', invoiceCreated: false });
  const resultA = await services.createInvoiceForJob(jobA); // adopts INV-COLLIDE-999 for jobA legitimately
  ok(resultA.invoiceNumber === 'INV-COLLIDE-999', 'jobA legitimately adopts INV-COLLIDE-999 first');

  const jobB = await makeJob({ invoiceNum: 'INV-COLLIDE-999', invoiceCreated: false }); // a DIFFERENT job claiming the SAME historical number
  const invoicesBefore = await pool.query(`SELECT count(*)::int AS n FROM rel_invoices`);
  try {
    await services.createInvoiceForJob(jobB);
    ok(false, 'jobB claiming the same historical number as jobA throws');
  } catch (err) {
    ok(err instanceof LegacyInvoiceConflictError, 'jobB is refused with LegacyInvoiceConflictError, not silently reassigned or duplicated', err);
    const detail = (err as InstanceType<typeof LegacyInvoiceConflictError>).detail;
    ok(!!detail && detail.conflictingJobId === jobA && detail.invoiceNumber === 'INV-COLLIDE-999', 'the structured error detail correctly identifies the conflicting job and number', detail);
  }
  const invoicesAfter = await pool.query(`SELECT count(*)::int AS n FROM rel_invoices`);
  ok(invoicesBefore.rows[0].n === invoicesAfter.rows[0].n, 'no new/second rel_invoices row was created for jobB — the refusal is a true no-op', { before: invoicesBefore.rows[0].n, after: invoicesAfter.rows[0].n });
  const jobBRow = await pool.query(`SELECT invoice_created FROM rel_jobs WHERE id = $1`, [jobB]);
  ok(jobBRow.rows[0]?.invoice_created === false, 'jobB itself was never flipped to invoiced by the refused attempt', jobBRow.rows[0]);

  await resetStage3Tables();

  console.log('\n' + '='.repeat(60));
  console.log(`${passed} passed, ${failures} failed`);
  console.log('='.repeat(60));
  await pool.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[legacy-invoice-branch-stress] Fatal error:', err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
