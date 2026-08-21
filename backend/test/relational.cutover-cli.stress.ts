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
  await runCli('enable', 'suppliers'); // no flags at all
  let suppliersRow = await pool.query(`SELECT enabled FROM relational_cutover WHERE section = 'suppliers'`);
  ok(suppliersRow.rows[0].enabled === false, 'enable with no flags at all changes nothing');

  await runCli('enable', 'suppliers', '--apply'); // apply but no confirm
  suppliersRow = await pool.query(`SELECT enabled FROM relational_cutover WHERE section = 'suppliers'`);
  ok(suppliersRow.rows[0].enabled === false, 'enable with --apply but no --confirm changes nothing');

  await runCli('enable', 'suppliers', '--confirm=ENABLE_SUPPLIERS'); // confirm but no apply
  suppliersRow = await pool.query(`SELECT enabled FROM relational_cutover WHERE section = 'suppliers'`);
  ok(suppliersRow.rows[0].enabled === false, 'enable with --confirm but no --apply changes nothing');

  await runCli('enable', 'suppliers', '--apply', '--confirm=WRONG_PHRASE');
  suppliersRow = await pool.query(`SELECT enabled FROM relational_cutover WHERE section = 'suppliers'`);
  ok(suppliersRow.rows[0].enabled === false, 'enable with --apply but a WRONG --confirm phrase changes nothing');

  console.log('\n[Cutover CLI] enable is gated on a FRESH reconciliation showing safe-to-cutover');
  // suppliers has 0 discrepancies in the clean fixture and no Stage-3 dependency — should be enable-able.
  await runCli('enable', 'suppliers', '--apply', '--confirm=ENABLE_SUPPLIERS');
  suppliersRow = await pool.query(`SELECT enabled FROM relational_cutover WHERE section = 'suppliers'`);
  ok(suppliersRow.rows[0].enabled === true, 'enable with correct --apply + --confirm on a CLEAN section actually flips the DB row');

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
  await runCli('disable', 'suppliers'); // no flags
  suppliersRow = await pool.query(`SELECT enabled FROM relational_cutover WHERE section = 'suppliers'`);
  ok(suppliersRow.rows[0].enabled === true, 'disable with no flags changes nothing — suppliers still enabled');

  await runCli('disable', 'suppliers', '--apply', '--confirm=DISABLE_SUPPLIERS_ACKNOWLEDGE_JSON_IS_STALE');
  suppliersRow = await pool.query(`SELECT enabled FROM relational_cutover WHERE section = 'suppliers'`);
  ok(suppliersRow.rows[0].enabled === false, 'disable with correct --apply + --confirm flips the row back off');

  console.log('\n[Cutover CLI] no enable-all exists — enable requires an exact, known section name');
  await runCli('enable', 'nonexistent-section', '--apply', '--confirm=ENABLE_NONEXISTENT-SECTION');
  const anyEnabled = await pool.query(`SELECT count(*)::int AS n FROM relational_cutover WHERE enabled = true`);
  ok(anyEnabled.rows[0].n === 0, 'an unknown section name is rejected outright, nothing is ever enabled by accident');

  console.log('\n[Cutover CLI] STAGE 3 — dependency-aware cutover: "quotes" refuses until jobs/inventory are enabled');
  // Fix up platform_state so jobs/inventory/purchaseOrders/quotes all
  // reconcile cleanly again (the earlier "dirty job" scenario deliberately
  // broke jobs' reconciliation; undo that here).
  const cleanFixtureData = JSON.parse(require('fs').readFileSync(FIXTURE_PATH, 'utf8'));
  await pool.query(`UPDATE platform_state SET data = $1::jsonb, updated_at = NOW() WHERE id = 1`, [JSON.stringify(cleanFixtureData)]);

  await runCli('enable', 'quotes', '--apply', '--confirm=ENABLE_QUOTES');
  let quotesDepRow = await pool.query(`SELECT enabled FROM relational_cutover WHERE section = 'quotes'`);
  ok(quotesDepRow.rows[0].enabled === false, '"quotes" is refused (even with correct flags + clean reconciliation) while jobs/inventory are not yet enabled');

  // 2026-08-21 PURCHASE ORDER MIGRATION POLICY CHANGE: convertQuoteToJob no
  // longer creates purchase orders at all, so "purchaseOrders" is no longer
  // part of quotes' dependency group — it can be enabled fully
  // independently, before, after, or without ever enabling quotes/jobs. It
  // succeeds here even though the JSON purchaseOrders collection (1 fixture
  // record) has nothing relational to match — the new
  // reconcileLegacyPolicySkippedCollection reports that as an intentional,
  // approved policy exclusion (legacyPolicyExcluded=true), not a
  // discrepancy, so the normal "enable REFUSES unless safeToCutOver" gate
  // does not block it.
  await runCli('enable', 'purchaseOrders', '--apply', '--confirm=ENABLE_PURCHASEORDERS');
  const poRow = await pool.query(`SELECT enabled FROM relational_cutover WHERE section = 'purchaseOrders'`);
  ok(poRow.rows[0].enabled === true, 'purchaseOrders can be enabled on its own — no longer gated behind jobs/inventory/quotes — because historical POs are excluded by an explicit, approved migration policy, not a data problem', JSON.stringify(poRow.rows));

  await runCli('enable', 'jobs', '--apply', '--confirm=ENABLE_JOBS');
  await runCli('enable', 'inventory', '--apply', '--confirm=ENABLE_INVENTORY');
  const depsRow = await pool.query(`SELECT section, enabled FROM relational_cutover WHERE section IN ('jobs','inventory')`);
  ok(depsRow.rows.every((r) => r.enabled === true), 'jobs/inventory can each be enabled individually, one explicit --confirm at a time — no --enable-all exists', JSON.stringify(depsRow.rows));

  await runCli('enable', 'quotes', '--apply', '--confirm=ENABLE_QUOTES');
  quotesDepRow = await pool.query(`SELECT enabled FROM relational_cutover WHERE section = 'quotes'`);
  ok(quotesDepRow.rows[0].enabled === true, 'once jobs+inventory are enabled (purchaseOrders is no longer required), enabling "quotes" itself now succeeds');

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
