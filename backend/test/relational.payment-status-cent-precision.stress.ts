/**
 * relational.payment-status-cent-precision.stress.ts
 * SIGNACORE — payment-status cent-precision boundary suite
 * Created 2026-08-27 (INV-00117 sub-cent blocker).
 *
 * ── WHAT THIS PROTECTS ──────────────────────────────────────────────────────
 * recomputeOwnerPaymentStatus decides 'paid' / 'partial' / 'pending' by
 * comparing what has been paid against what is owed. A line total is stored at
 * 4 dp and VAT is a multiplication, so a document's RAW arithmetic can carry a
 * fraction of a cent the customer is never billed. The confirmed production
 * case is INV-00117:
 *
 *     line 0   9.5875 x R550 = 5273.125      VAT 790.96875
 *     line 1   1      x R250 =  250          VAT  37.5
 *     raw total                 6351.59375
 *     invoice issued to the customer          R6,351.59
 *     customer paid                           R6,351.59
 *
 * Comparing the payment against the RAW 6351.59375 marked a fully-settled
 * invoice 'partial' on a shortfall of R0.00375. Both sides are now reduced to
 * cents before the comparison.
 *
 * The other half of this suite matters just as much: a GENUINE one-cent
 * shortfall must still be 'partial'. Rounding must not become a tolerance.
 *
 * Runs against a REAL local PostgreSQL and calls the DEPLOYED
 * recomputeOwnerPaymentStatus — never a copy of its rule.
 *
 * SAFETY: refuses to run unless DATABASE_URL points at localhost/127.0.0.1,
 * or ALLOW_UNSAFE_TEST_DB=1 is explicitly set. Every fixture it creates is
 * created by this suite and removed again at the end; it never touches a row
 * it did not write.
 *
 * Usage (from backend/):
 *   DATABASE_URL=postgresql://.../signacore_test \
 *   npx ts-node --transpile-only test/relational.payment-status-cent-precision.stress.ts
 */
import pool from '../src/db/pool';
import { recomputeOwnerPaymentStatus } from '../src/relational/services';

const DB_URL = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(DB_URL) && process.env.ALLOW_UNSAFE_TEST_DB !== '1') {
  console.error('[cent-precision] Refusing to run: DATABASE_URL does not look like a local test database.');
  process.exit(1);
}

let passed = 0, failures = 0;
function ok(cond: boolean, label: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

const TAG = 'CENTPREC-' + process.pid;

interface LineSpec { qty: number; unit: number; taxed?: boolean }

/** Builds an invoice with the given lines, records the given payments against
 *  it, runs the DEPLOYED recompute, and returns the resulting status. */
async function invoiceCase(lines: LineSpec[], payments: number[], startStatus = 'sent'): Promise<{
  status: string; rawTotal: number; centTotal: number; paid: number;
}> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inv = await client.query(
      `INSERT INTO rel_invoices (source_id, invoice_number, company_code, status, contact_name, legacy_data)
       VALUES ($1, $2, '2', $3, 'Cent Precision Fixture', '{}'::jsonb) RETURNING id`,
      [TAG + '-' + Math.random().toString(36).slice(2), TAG + '-' + Math.random().toString(36).slice(2, 10), startStatus]);
    const invId = Number(inv.rows[0].id);

    let rawTotal = 0;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const taxed = l.taxed === undefined ? true : l.taxed;
      await client.query(
        `INSERT INTO rel_invoice_line_items (invoice_id, line_index, description, qty, unit_amount, account_code, tax_type, legacy_data)
         VALUES ($1, $2, 'fixture line', $3, $4, '4000', $5, '{}'::jsonb)`,
        [invId, i, l.qty, l.unit, taxed ? '15%' : 'None']);
      const sub = l.qty * l.unit;
      rawTotal += sub + (taxed ? sub * 0.15 : 0);
    }
    for (let i = 0; i < payments.length; i++) {
      await client.query(
        `INSERT INTO rel_payments (source_id, owner_type, owner_id, line_index, amount, payment_date, method, legacy_data)
         VALUES ($1, 'invoice', $2, $3, $4, '2026-08-19', 'EFT', '{}'::jsonb)`,
        [TAG + '-p-' + Math.random().toString(36).slice(2), invId, i, payments[i]]);
    }

    // THE DEPLOYED FUNCTION — not a re-implementation of its rule.
    await recomputeOwnerPaymentStatus(client, 'invoice', invId);

    const st = await client.query(`SELECT status FROM rel_invoices WHERE id = $1`, [invId]);
    const status = st.rows[0].status;
    // everything this case created is discarded — the suite owns no rows after it
    await client.query('ROLLBACK');
    return {
      status,
      rawTotal,
      centTotal: Math.round(rawTotal * 100) / 100,
      paid: payments.reduce((s, p) => s + p, 0),
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally { client.release(); }
}

async function jobCase(value: number, payments: number[]): Promise<{ status: string; paid: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const j = await client.query(
      `INSERT INTO rel_jobs (source_id, job_number, company_code, customer_name_raw, description,
         status, stage, value, legacy_data)
       VALUES ($1, $2, '2', 'Cent Precision Fixture', 'fixture', 'in_progress', 5, $3, '{}'::jsonb)
       RETURNING id`,
      [TAG + '-j-' + Math.random().toString(36).slice(2), TAG + '-J-' + Math.random().toString(36).slice(2, 10), value]);
    const jobId = Number(j.rows[0].id);
    for (let i = 0; i < payments.length; i++) {
      await client.query(
        `INSERT INTO rel_payments (source_id, owner_type, owner_id, line_index, amount, payment_date, method, legacy_data)
         VALUES ($1, 'job', $2, $3, $4, '2026-08-19', 'EFT', '{}'::jsonb)`,
        [TAG + '-jp-' + Math.random().toString(36).slice(2), jobId, i, payments[i]]);
    }
    await recomputeOwnerPaymentStatus(client, 'job', jobId);
    const st = await client.query(`SELECT invoice_status FROM rel_jobs WHERE id = $1`, [jobId]);
    const status = st.rows[0].invoice_status;
    await client.query('ROLLBACK');
    return { status, paid: payments.reduce((s, p) => s + p, 0) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally { client.release(); }
}

// The exact INV-00117 shape.
const INV117: LineSpec[] = [{ qty: 9.5875, unit: 550 }, { qty: 1, unit: 250 }];

async function main() {
  console.log('\n============================================');
  console.log(' PAYMENT-STATUS CENT-PRECISION BOUNDARY SUITE');
  console.log('============================================');

  console.log('\n=== THE PRODUCTION CASE — INV-00117 ===');
  {
    const r = await invoiceCase(INV117, [6351.59]);
    console.log(`    raw total ${r.rawTotal}   billed ${r.centTotal.toFixed(2)}   paid ${r.paid.toFixed(2)}`);
    ok(r.status === 'paid',
      '1. raw 6351.59375 / billed 6351.59 / paid 6351.59  -> PAID', 'got ' + r.status);
    ok(Math.abs(r.rawTotal - 6351.59375) < 1e-9,
      '   ...and the fixture really does reproduce the 6351.59375 raw total', String(r.rawTotal));
  }
  {
    const r = await invoiceCase(INV117, [6351.58]);
    ok(r.status === 'partial',
      '2. same invoice / paid 6351.58 (a real cent short) -> PARTIAL', 'got ' + r.status);
  }

  console.log('\n=== WHOLE-CENT TOTALS ===');
  {
    // 10 x R100 = 1000 + VAT 150 = 1150.00 exactly
    const r = await invoiceCase([{ qty: 10, unit: 100 }], [1150.00]);
    ok(r.status === 'paid', '3. exact whole-cent total / exact payment -> PAID', 'got ' + r.status + ' raw ' + r.rawTotal);
  }
  {
    const r = await invoiceCase([{ qty: 10, unit: 100 }], [1149.99]);
    ok(r.status === 'partial', '4. exact whole-cent total / one cent short -> PARTIAL', 'got ' + r.status);
  }
  {
    const r = await invoiceCase([{ qty: 10, unit: 100 }], [1150.01]);
    ok(r.status === 'paid', '5. overpayment by one cent -> PAID', 'got ' + r.status);
  }

  console.log('\n=== ZERO AND PARTIAL ===');
  {
    const r = await invoiceCase([{ qty: 10, unit: 100 }], [], 'sent');
    ok(r.status === 'sent',
      '6. zero payment -> status unchanged (keeps its current value, per the deployed rule)', 'got ' + r.status);
  }
  {
    const r = await invoiceCase([{ qty: 10, unit: 100 }], [500]);
    ok(r.status === 'partial', '7. partial payment -> PARTIAL', 'got ' + r.status);
  }

  console.log('\n=== MULTIPLE PAYMENTS ===');
  {
    const r = await invoiceCase(INV117, [3000.00, 3351.59]);
    ok(r.status === 'paid',
      '8. two payments summing to the canonical cent total -> PAID', 'got ' + r.status + ' paid ' + r.paid.toFixed(2));
  }
  {
    const r = await invoiceCase(INV117, [3000.00, 3351.58]);
    ok(r.status === 'partial',
      '9. two payments summing one cent short -> PARTIAL', 'got ' + r.status + ' paid ' + r.paid.toFixed(2));
  }

  console.log('\n=== THE HALF-CENT BOUNDARY — the case a tolerance would get wrong ===');
  {
    // 1 x 2.87 = 2.87, VAT 0.4305 -> raw 3.3005, which rounds DOWN to 3.30.
    // The half-cent remainder is money the customer is never billed.
    const r = await invoiceCase([{ qty: 1, unit: 2.87 }], [3.30]);
    console.log(`    raw ${r.rawTotal}  billed ${r.centTotal.toFixed(2)}  paid 3.30`);
    ok(r.centTotal === 3.30 && r.rawTotal > 3.30,
      '10a-setup. the fixture really does round DOWN (raw > billed)', 'raw ' + r.rawTotal + ' billed ' + r.centTotal);
    ok(r.status === 'paid',
      '10a. raw just BELOW a half-cent (3.3005 -> billed 3.30) / paid 3.30 -> PAID', 'got ' + r.status);
  }
  {
    const r = await invoiceCase([{ qty: 1, unit: 2.87 }], [3.29]);
    ok(r.status === 'partial',
      '10b. ...and paying a cent less than the billed figure -> PARTIAL', 'got ' + r.status);
  }
  {
    // 3 x 1.5 = 4.5, VAT 0.675 -> raw 5.175, which rounds UP to 5.18.
    // Paying 5.17 is therefore a GENUINE cent short of the billed figure.
    const r = await invoiceCase([{ qty: 3, unit: 1.5 }], [5.17]);
    console.log(`    raw ${r.rawTotal}  billed ${r.centTotal.toFixed(2)}  paid 5.17`);
    ok(r.centTotal === 5.18,
      '10e-setup. this fixture rounds UP, so 5.17 is a real shortfall', 'billed ' + r.centTotal);
    ok(r.status === 'partial',
      '10e. raw on a half-cent rounding UP (5.175 -> billed 5.18) / paid 5.17 -> PARTIAL', 'got ' + r.status);
  }
  {
    const r = await invoiceCase([{ qty: 3, unit: 1.5 }], [5.18]);
    ok(r.status === 'paid',
      '10f. ...paying the billed 5.18 -> PAID', 'got ' + r.status);
  }
  {
    // 7 x 1.30 = 9.1, VAT 1.365 -> raw 10.465 -> billed 10.47 (rounds UP).
    // Paying 10.46 is a GENUINE cent short of what the customer was billed.
    // A half-cent tolerance on the RAW total would wrongly call this paid.
    const r = await invoiceCase([{ qty: 7, unit: 1.30 }], [10.46]);
    console.log(`    raw ${r.rawTotal}  billed ${r.centTotal.toFixed(2)}  paid 10.46`);
    ok(r.status === 'partial',
      '10c. raw ABOVE a half-cent (10.465 -> billed 10.47) / paid 10.46 -> PARTIAL', 'got ' + r.status);
    ok(10.46 >= r.rawTotal - 0.005,
      '     ...and a 0.005 tolerance WOULD have wrongly forgiven it — which is why this is rounding, not tolerance');
  }
  {
    const r = await invoiceCase([{ qty: 7, unit: 1.30 }], [10.47]);
    ok(r.status === 'paid',
      '10d. ...paying the billed 10.47 -> PAID', 'got ' + r.status);
  }

  console.log('\n=== THE JOB BRANCH IS UNAFFECTED ===');
  console.log('    rel_jobs.value is numeric(14,2) and rel_payments.amount is numeric,');
  console.log('    so both operands were already cent-precise; rounding them is a no-op.');
  {
    const r = await jobCase(6351.59, [6351.59]);
    ok(r.status === 'paid', '11. job value 6351.59 / paid 6351.59 -> paid', 'got ' + r.status);
  }
  {
    const r = await jobCase(6351.59, [6351.58]);
    ok(r.status === 'partial', '12. job value 6351.59 / paid 6351.58 -> partial', 'got ' + r.status);
  }
  {
    const r = await jobCase(6351.59, []);
    ok(r.status === 'pending', '13. job with no payments -> pending', 'got ' + r.status);
  }
  {
    const r = await jobCase(0, [100]);
    ok(r.status === 'partial', '14. job value 0 with a payment -> partial (jobValue > 0 guard)', 'got ' + r.status);
  }

  console.log('\n=== NOTHING WAS LEFT BEHIND ===');
  {
    const left = await pool.query(
      `SELECT (SELECT COUNT(*)::int FROM rel_invoices WHERE source_id LIKE $1) AS invoices,
              (SELECT COUNT(*)::int FROM rel_jobs     WHERE source_id LIKE $1) AS jobs,
              (SELECT COUNT(*)::int FROM rel_payments WHERE source_id LIKE $1) AS payments`,
      [TAG + '%']);
    const l = left.rows[0];
    ok(l.invoices === 0 && l.jobs === 0 && l.payments === 0,
      '15. every fixture row this suite created was rolled back',
      JSON.stringify(l));
  }

  console.log('\n============================================');
  console.log(` PASSED: ${passed}   FAILED: ${failures}`);
  console.log('============================================');
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
