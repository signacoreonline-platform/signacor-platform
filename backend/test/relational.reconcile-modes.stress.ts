/**
 * relational.reconcile-modes.stress.ts — STAGE 3 Phase 11 verification.
 *
 * Proves the EXACT scenario the migration brief specifies for the
 * reconciliation architecture fix:
 *
 *   1. backfill a job from JSON -> reconciliation reports it clean (no
 *      financial mismatch, present + matching)
 *   2. record a NEW payment on that job THROUGH THE RELATIONAL SERVICE
 *      LAYER (services.recordPayment) — a legitimate Stage 3 write that
 *      never touches platform_state.data or legacy_data, by design
 *   3. the live JSON is now "stale" relative to relational (it does not
 *      know about the new payment) — runReconciliation() (PRE-CUTOVER,
 *      byte-for-byte unchanged) SHOULD now report a financial mismatch
 *      for that job and close its safe-to-cutover gate. This is EXPECTED,
 *      documented behavior, not a bug: pre-cutover, a real relational
 *      write happening at all is itself unusual (normally only backfill
 *      writes relationally pre-cutover) and reconciliation is right to
 *      flag that JSON and relational have diverged.
 *   4. runPostCutoverIntegrityCheck() (the NEW function), which NEVER
 *      compares against JSON/legacy_data, reports that same job/payment
 *      as internally consistent (integrityOk) — proving the two modes
 *      genuinely disagree on the "is this fine?" question, exactly as
 *      the two-mode design intends: post-cutover, a live relational edit
 *      diverging from a now-frozen JSON snapshot is NORMAL, not a defect.
 *
 * Run against a real local Postgres — same convention as every other
 * relational.*.stress.ts suite in this directory.
 */
import pool from '../src/db/pool';
import { runBackfill } from '../src/relational/backfill';
import { runReconciliation, runPostCutoverIntegrityCheck } from '../src/relational/reconcile';
import * as services from '../src/relational/services';

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

const FIXTURE_PATH = require('path').resolve(__dirname, 'fixtures', 'sample-state.json');
const REL_TABLES = [
  'rel_payments', 'rel_invoice_line_items', 'rel_invoices', 'rel_job_line_items',
  'rel_purchase_order_items', 'rel_purchase_orders', 'rel_credit_notes',
  'rel_quote_line_items', 'rel_jobs', 'rel_quotes', 'rel_inventory_items',
  'rel_quick_rate_items', 'rel_suppliers', 'rel_customers', 'rel_employees',
  'rel_leave_requests', 'rel_disciplinary_records',
];
async function resetRelationalTables() {
  await pool.query(`TRUNCATE ${REL_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  await pool.query(`TRUNCATE relational_backfill_runs, relational_legacy_conflicts RESTART IDENTITY CASCADE`);
  await pool.query(`DELETE FROM quote_conversions WHERE quote_id LIKE 'rel:%'`);
  await pool.query(`UPDATE relational_cutover SET enabled = false, enabled_at = NULL, enabled_by = NULL`);
  // reconcile.ts always reads LIVE platform_state, not the fixture file
  // directly, so for this suite's assertions to mean anything, live
  // platform_state.data must actually be the same JSON the backfill below
  // runs against — same convention as relational.cutover-cli.stress.ts.
  const fixture = require('fs').readFileSync(FIXTURE_PATH, 'utf8');
  await pool.query(
    `INSERT INTO platform_state (id, data, updated_at) VALUES (1, $1::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [fixture]
  );
}

async function main() {
  console.log('\n[Reconcile modes] pre-cutover MATCH after a clean backfill');
  await resetRelationalTables();
  await runBackfill({ apply: true, sourceFile: FIXTURE_PATH });

  const before = await runReconciliation({});
  const jobsBefore = before.sections.find((s) => s.collection === 'jobs')!;
  ok(jobsBefore.financialMismatches.length === 0, 'fresh backfill: zero financial mismatches on jobs section', jobsBefore.financialMismatches);
  ok(!jobsBefore.details.different.some((d) => d.sourceId === '6001'), 'fresh backfill: job 6001 is not in the DIFFERENT list');
  ok(!jobsBefore.details.missingInRelational.some((d) => d.sourceId === '6001'), 'fresh backfill: job 6001 is not MISSING_IN_RELATIONAL');

  const postBefore = await runPostCutoverIntegrityCheck();
  const paymentsBefore = postBefore.sections.find((s) => s.collection === 'payments')!;
  ok(paymentsBefore.integrityOk, 'post-cutover integrity check: payments internally consistent right after backfill', paymentsBefore);

  console.log('\n[Reconcile modes] record a NEW payment on job 6001 THROUGH THE RELATIONAL SERVICE LAYER (JSON is untouched)');
  const jobRow = await pool.query(`SELECT id FROM rel_jobs WHERE source_id = '6001'`);
  ok(jobRow.rowCount === 1, 'job 6001 exists relationally after backfill');
  const jobId = jobRow.rows[0].id;

  await services.recordPayment({ type: 'job', id: jobId }, 500, { method: 'EFT', reference: 'PAY-EXTRA-RELATIONAL-ONLY' });

  // Sanity: the live JSON genuinely was never touched by that call — the
  // whole point of the scenario is that JSON is now stale, not deleted or
  // rewritten.
  const psRes = await pool.query(`SELECT data FROM platform_state WHERE id = 1`);
  const jsonJob = (psRes.rows[0].data.jobs || []).find((j: any) => String(j.id) === '6001');
  const jsonPaidSum = (jsonJob.payments || []).reduce((s: number, p: any) => s + Number(p.amount || 0), 0);
  ok(jsonPaidSum === 5750, 'live JSON for job 6001 is unchanged — still shows the original 5750 total (no new payment)', jsonPaidSum);

  console.log('\n[Reconcile modes] PRE-CUTOVER runReconciliation() now correctly reports this as a financial mismatch — EXPECTED, not a bug');
  const after = await runReconciliation({});
  const jobsAfter = after.sections.find((s) => s.collection === 'jobs')!;
  const mismatch6001 = jobsAfter.financialMismatches.find((m) => m.sourceId === '6001' && m.field === 'payments_sum');
  ok(!!mismatch6001, 'runReconciliation flags job 6001 payments_sum as a financial mismatch once a real relational payment has been recorded', jobsAfter.financialMismatches);
  ok(!!mismatch6001 && mismatch6001.jsonValue === 5750 && mismatch6001.relationalValue === 6250, 'the mismatch correctly shows json=5750 (stale) vs relational=6250 (the fresher, real total)', mismatch6001);
  ok(jobsAfter.safeToCutOver === false, 'jobs section safe-to-cutover gate is closed by this financial mismatch');

  console.log('\n[Reconcile modes] POST-CUTOVER runPostCutoverIntegrityCheck() does NOT care that JSON is stale — it never looks at JSON at all');
  const postAfter = await runPostCutoverIntegrityCheck();
  const paymentsAfter = postAfter.sections.find((s) => s.collection === 'payments')!;
  ok(paymentsAfter.relationalRowCount === paymentsBefore.relationalRowCount + 1, 'post-cutover check sees the new payment row exists', { before: paymentsBefore.relationalRowCount, after: paymentsAfter.relationalRowCount });
  ok(paymentsAfter.orphanedReferences.length === 0, 'the new payment is not orphaned — its owner_id still points at a real rel_jobs row');
  ok(paymentsAfter.integrityOk, 'post-cutover integrity check reports payments as internally consistent even though pre-cutover reconciliation now flags a mismatch for the SAME row — proving the two modes genuinely answer different questions', paymentsAfter);

  console.log('\n[Reconcile modes] a genuinely BROKEN invariant IS still caught post-cutover (this is not a check that always passes)');
  const brokenCredit = await pool.query(
    `INSERT INTO rel_credit_notes (source_id, credit_number, note_type, contact_name_raw, amount, used_amount)
     VALUES ('test-broken-credit-note', 'CN-TEST-BROKEN', 'customer', 'Broken Invariant Co', 100, 999)
     RETURNING id`
  );
  ok(brokenCredit.rowCount === 1, 'seeded a credit note with used_amount > amount (an impossible state that must never happen via normal service calls)');
  const postBroken = await runPostCutoverIntegrityCheck();
  const creditAfter = postBroken.sections.find((s) => s.collection === 'creditNotes')!;
  const violation = creditAfter.invariantViolations.find((v) => v.id === 'test-broken-credit-note');
  ok(!!violation, 'post-cutover integrity check DOES catch a genuinely broken used_amount > amount invariant', creditAfter.invariantViolations);
  ok(creditAfter.integrityOk === false, 'creditNotes section integrityOk flips to false once a real invariant violation exists');

  await resetRelationalTables();
  await pool.query(`UPDATE platform_state SET data = '{}'::jsonb, updated_at = NOW() WHERE id = 1`);

  console.log('\n' + '='.repeat(60));
  console.log(`${passed} passed, ${failures} failed`);
  console.log('='.repeat(60));
  await pool.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[reconcile-modes-stress] Fatal error:', err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
