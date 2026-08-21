/**
 * relational.backfill-008-fields.stress.ts — STAGE 3 Phase 12 verification.
 *
 * migration 008 added rel_job_line_items.unit, rel_quote_line_items.unit,
 * rel_jobs.breakdown, rel_suppliers.address, rel_suppliers.vat_number — but
 * an audit of backfill.ts (this suite's whole reason to exist) found none
 * of those five columns were actually being populated from JSON; every one
 * of them was silently falling back to a column default/NULL forever, even
 * though the JSON source field was right there in legacy_data.
 *
 * This suite builds a tiny synthetic source file (the shared fixture at
 * test/fixtures/sample-state.json happens to carry `undefined` for all
 * five fields, which would pass either buggy or fixed code — not a useful
 * regression guard) with every one of those fields populated, runs a real
 * --apply backfill against it, and asserts each column round-trips.
 */
import fs from 'fs';
import path from 'path';
import pool from '../src/db/pool';
import { runBackfill } from '../src/relational/backfill';

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}
// Postgres jsonb does not preserve object key order, so a positional
// JSON.stringify comparison would fail on a byte-identical object with
// re-ordered keys — sort keys first (same technique reconcile.ts/
// backfill.ts's own stableStringify uses for the same reason).
function stableStringify(v: any): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

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
}

const FIXTURE = {
  suppliers: [{
    id: 9001, name: 'Migration 008 Test Supplier', contactPerson: 'A Person', phone: '0210000000',
    email: 'test@example.com', address: '1 Test Street, Testville', city: 'Testville',
    postalCode: '7000', vatNumber: '4999999999', accountNumber: 'ACC-9001', paymentTerms: '30 days', notes: '',
  }],
  quotes: [{
    id: 9101, num: 'SQ-TEST008', co: '2', client: 'Migration 008 Test Co', status: 'draft',
    lines: [{ desc: 'Signage panel', qty: 2, unitPrice: 500, subtotal: 1000, unit: 'm²' }],
    setupFee: '', discount: '',
  }],
  jobs: [{
    id: 9201, num: 'SNS-TEST008', co: '2', client: 'Migration 008 Test Co', desc: 'Test job', status: 'quote_approved',
    stage: 1, value: 1000,
    lines: [{ desc: 'Signage panel', qty: 2, unitPrice: 500, subtotal: 1000, unit: 'm²' }],
    breakdown: { materials: 200, labour: 150, machine_time: 50, design: 0, delivery: 30, franchise_royalty: 60, subcontracting: 0, printing: 400, other: 10 },
  }],
};

async function main() {
  await resetRelationalTables();
  const tmpPath = path.resolve('/tmp/backfill-008-fields-fixture.json');
  fs.writeFileSync(tmpPath, JSON.stringify(FIXTURE));

  console.log('\n[Backfill migration 008 fields] apply against a synthetic fixture with every 008 field populated');
  const result = await runBackfill({ apply: true, sourceFile: tmpPath });
  ok(result.ok, 'backfill --apply completed without error', result);

  console.log('\n[Backfill migration 008 fields] rel_suppliers.address / vat_number');
  const supRow = await pool.query(`SELECT address, vat_number FROM rel_suppliers WHERE source_id = '9001'`);
  ok(supRow.rowCount === 1, 'supplier 9001 was backfilled');
  ok(supRow.rows[0]?.address === '1 Test Street, Testville', 'rel_suppliers.address populated from JSON address field', supRow.rows[0]);
  ok(supRow.rows[0]?.vat_number === '4999999999', 'rel_suppliers.vat_number populated from JSON vatNumber field', supRow.rows[0]);

  console.log('\n[Backfill migration 008 fields] rel_quote_line_items.unit');
  const qRow = await pool.query(`SELECT id FROM rel_quotes WHERE source_id = '9101'`);
  ok(qRow.rowCount === 1, 'quote 9101 was backfilled');
  const qLineRow = await pool.query(`SELECT unit FROM rel_quote_line_items WHERE quote_id = $1 AND line_index = 0`, [qRow.rows[0]?.id]);
  ok(qLineRow.rows[0]?.unit === 'm²', 'rel_quote_line_items.unit populated from JSON line.unit field', qLineRow.rows[0]);

  console.log('\n[Backfill migration 008 fields] rel_job_line_items.unit + rel_jobs.breakdown');
  const jRow = await pool.query(`SELECT id, breakdown FROM rel_jobs WHERE source_id = '9201'`);
  ok(jRow.rowCount === 1, 'job 9201 was backfilled');
  ok(stableStringify(jRow.rows[0]?.breakdown) === stableStringify(FIXTURE.jobs[0].breakdown), 'rel_jobs.breakdown round-trips the full 9-key cost object', jRow.rows[0]?.breakdown);
  const jLineRow = await pool.query(`SELECT unit FROM rel_job_line_items WHERE job_id = $1 AND line_index = 0`, [jRow.rows[0]?.id]);
  ok(jLineRow.rows[0]?.unit === 'm²', 'rel_job_line_items.unit populated from JSON line.unit field', jLineRow.rows[0]);

  console.log('\n[Backfill migration 008 fields] a job with breakdown: null (the real-world shape seen in production data) never stores a bare JSON null');
  await resetRelationalTables();
  const nullBreakdownFixture = { jobs: [{ id: 9301, num: 'SNS-TEST008B', co: '2', client: 'X', desc: 'x', status: 'lead', stage: 0, value: 0, breakdown: null, lines: [] }] };
  fs.writeFileSync(tmpPath, JSON.stringify(nullBreakdownFixture));
  await runBackfill({ apply: true, sourceFile: tmpPath });
  const jRow2 = await pool.query(`SELECT breakdown FROM rel_jobs WHERE source_id = '9301'`);
  ok(jRow2.rowCount === 1, 'job with breakdown:null was backfilled without error');
  ok(stableStringify(jRow2.rows[0]?.breakdown) === '{}', 'breakdown:null normalizes to {} (a real object), never a bare JSON null', jRow2.rows[0]?.breakdown);

  await resetRelationalTables();
  fs.unlinkSync(tmpPath);

  console.log('\n' + '='.repeat(60));
  console.log(`${passed} passed, ${failures} failed`);
  console.log('='.repeat(60));
  await pool.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[backfill-008-fields-stress] Fatal error:', err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
