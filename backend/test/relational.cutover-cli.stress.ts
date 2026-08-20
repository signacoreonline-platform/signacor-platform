/**
 * relational.cutover-cli.stress.ts — Stage 2 Phase 8.
 *
 * Tests backend/src/relational/cutoverCli.ts's actual behavior by
 * importing and calling it in-process (spawning the compiled CLI as a
 * subprocess and parsing stdout would be more "real", but the important
 * guarantees — refusal without --apply/--confirm, hard-block on
 * customers/quickRates, reconciliation gating — all live in plain
 * functions this suite can call directly and assert on the DATABASE
 * effects of, which is a stronger check than scraping console output).
 */
import pool from '../src/db/pool';
import { runBackfill } from '../src/relational/backfill';

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
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
  // reconcile.ts (and therefore cutoverCli's enable gate) always compares
  // against LIVE platform_state, never the fixture file directly — so for
  // this suite's reconciliation-gated assertions to mean anything, live
  // platform_state.data must actually BE the same fixture content the
  // backfill below is run against. Every other Stage 2 suite in this repo
  // leaves platform_state in some other state, so this is set explicitly
  // rather than assumed.
  const fixture = require('fs').readFileSync(FIXTURE_PATH, 'utf8');
  await pool.query(
    `INSERT INTO platform_state (id, data, updated_at) VALUES (1, $1::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [fixture]
  );
}

async function main() {
  // Import AFTER module resolution so process.env manipulation elsewhere in
  // a suite runner doesn't affect module-load-time behavior (this module
  // reads process.env only inside functions, at call time, so plain import
  // is safe here).
  const cli = await import('../src/relational/cutoverCli');

  console.log('\n[Cutover CLI] hard-blocked sections refuse unconditionally, even with correct flags');
  await resetRelationalTables();
  await runBackfill({ apply: true, sourceFile: FIXTURE_PATH });
  // Calls the exact same exported main() the compiled CLI's own
  // `if (require.main === module)` block invokes — the real entrypoint,
  // not a re-derived shortcut.
  const originalArgv = process.argv;
  async function runCli(...args: string[]): Promise<void> {
    process.argv = ['node', 'cutoverCli.js', ...args];
    await cli.main();
  }

  await runCli('enable', 'customers', '--apply', '--confirm=ENABLE_CUSTOMERS');
  const custRow = await pool.query(`SELECT enabled FROM relational_cutover WHERE section = 'customers'`);
  ok(custRow.rows[0].enabled === false, '"customers" remains disabled even after enable --apply --confirm=ENABLE_CUSTOMERS (hard-blocked, no override exists)');

  await runCli('enable', 'quickRates', '--apply', '--confirm=ENABLE_QUICKRATES');
  const qrRow = await pool.query(`SELECT enabled FROM relational_cutover WHERE section = 'quickRates'`);
  ok(qrRow.rows[0].enabled === false, '"quickRates" remains disabled — same hard block');

  console.log('\n[Cutover CLI] enable without BOTH --apply and correct --confirm is always a no-op dry run');
  await runCli('enable', 'quotes'); // no flags at all
  let quotesRow = await pool.query(`SELECT enabled FROM relational_cutover WHERE section = 'quotes'`);
  ok(quotesRow.rows[0].enabled === false, 'enable with no flags at all changes nothing');

  await runCli('enable', 'quotes', '--apply'); // apply but no confirm
  quotesRow = await pool.query(`SELECT enabled FROM relational_cutover WHERE section = 'quotes'`);
  ok(quotesRow.rows[0].enabled === false, 'enable with --apply but no --confirm changes nothing');

  await runCli('enable', 'quotes', '--confirm=ENABLE_QUOTES'); // confirm but no apply
  quotesRow = await pool.query(`SELECT enabled FROM relational_cutover WHERE section = 'quotes'`);
  ok(quotesRow.rows[0].enabled === false, 'enable with --confirm but no --apply changes nothing');

  await runCli('enable', 'quotes', '--apply', '--confirm=WRONG_PHRASE');
  quotesRow = await pool.query(`SELECT enabled FROM relational_cutover WHERE section = 'quotes'`);
  ok(quotesRow.rows[0].enabled === false, 'enable with --apply but a WRONG --confirm phrase changes nothing');

  console.log('\n[Cutover CLI] enable is gated on a FRESH reconciliation showing safe-to-cutover');
  // quotes has 0 discrepancies in the clean fixture — should be enable-able.
  await runCli('enable', 'quotes', '--apply', '--confirm=ENABLE_QUOTES');
  quotesRow = await pool.query(`SELECT enabled FROM relational_cutover WHERE section = 'quotes'`);
  ok(quotesRow.rows[0].enabled === true, 'enable with correct --apply + --confirm on a CLEAN section actually flips the DB row');

  // Dirty a job so jobs is no longer safe to cut over, then try to enable it.
  const fs = require('fs');
  const dirty = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  dirty.jobs[0].value = 12345678; // diverges from what was backfilled
  const dirtyPath = '/tmp/cutover-cli-dirty-fixture.json';
  fs.writeFileSync(dirtyPath, JSON.stringify(dirty));
  // reconcile.ts (and therefore the CLI) always reads live platform_state,
  // not a --source-file — so to make this section genuinely unsafe we edit
  // platform_state.data directly (the CLI must reconcile against the SAME
  // live truth it will cut over against, so this is exactly right).
  const existing = await pool.query(`SELECT data FROM platform_state WHERE id = 1`);
  const psData = existing.rowCount ? existing.rows[0].data || {} : {};
  psData.jobs = dirty.jobs;
  await pool.query(`INSERT INTO platform_state (id, data, updated_at) VALUES (1, $1::jsonb, NOW()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`, [JSON.stringify(psData)]);

  await runCli('enable', 'jobs', '--apply', '--confirm=ENABLE_JOBS');
  const jobsRow = await pool.query(`SELECT enabled FROM relational_cutover WHERE section = 'jobs'`);
  ok(jobsRow.rows[0].enabled === false, 'enable is REFUSED for "jobs" once a fresh reconciliation shows a discrepancy, even with correct flags');

  console.log('\n[Cutover CLI] disable requires --apply + confirm too, and actually flips the row when given');
  await runCli('disable', 'quotes'); // no flags
  quotesRow = await pool.query(`SELECT enabled FROM relational_cutover WHERE section = 'quotes'`);
  ok(quotesRow.rows[0].enabled === true, 'disable with no flags changes nothing — quotes still enabled');

  await runCli('disable', 'quotes', '--apply', '--confirm=DISABLE_QUOTES_ACKNOWLEDGE_JSON_IS_STALE');
  quotesRow = await pool.query(`SELECT enabled FROM relational_cutover WHERE section = 'quotes'`);
  ok(quotesRow.rows[0].enabled === false, 'disable with correct --apply + --confirm flips the row back off');

  console.log('\n[Cutover CLI] no enable-all exists — enable requires an exact, known section name');
  await runCli('enable', 'nonexistent-section', '--apply', '--confirm=ENABLE_NONEXISTENT-SECTION');
  const anyEnabled = await pool.query(`SELECT count(*)::int AS n FROM relational_cutover WHERE enabled = true`);
  ok(anyEnabled.rows[0].n === 0, 'an unknown section name is rejected outright, nothing is ever enabled by accident');

  process.argv = originalArgv;
  await resetRelationalTables();
  await pool.query(`UPDATE platform_state SET data = '{}'::jsonb, updated_at = NOW() WHERE id = 1`);

  console.log('\n' + '='.repeat(60));
  console.log(`${passed} passed, ${failures} failed`);
  console.log('='.repeat(60));
  await pool.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[cutover-cli-stress] Fatal error:', err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
