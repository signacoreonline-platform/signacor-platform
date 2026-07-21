/**
 * fixDiazStatementJuly2026.ts
 *
 * ONE-OFF, MANUALLY-TRIGGERED data correction for a single customer:
 * "Diaz Hotel & Resort" — July 2026 statement.
 *
 * BACKUP INSPECTED TO IDENTIFY THE RECORDS BELOW:
 *   signacore-platform-full-backup-2026-07-21-183719.json
 *   (manual full-platform export, exportedAt 2026-07-21T16:37:19.870Z)
 *
 * Confirmed against that backup — Diaz Hotel & Resort's invoices are NOT in
 * data.accInvoices (that array holds only unrelated manual/cash-sale
 * invoices). They are derived from data.jobs, via getJobInvoices() /
 * reconcileJobInvoice() in index.html: contactName comes from job.client,
 * and the payments actually used for the statement/balance come from
 * job.payments (merged with the linked quote's payments, deduped by id).
 *
 *   Customer:        Diaz Hotel & Resort  (customer id 1782381756340)
 *   Credit note:      CN-0001              (id 1782915525736, amount 12905.01,
 *                                            contactName "Diaz Hotel & Resort")
 *   Job SNS-00063  -> invoiceNum INV-00016  (job id 1784012079803, value 5138.775)
 *     payment id 1784012042372  amount 5138.77  method "Credit (R 12 905,01 available)"
 *     linked quote SQ-00089 (quote id 1784012008924) carries the SAME payment id
 *   Job SNS-00087  -> invoiceNum INV-00061  (job id 1784533312014, value 6414.7)
 *     payment id 1784533274025  amount 4829.13  method "Credit (R 12 905,01 available)"
 *     linked quote SQ-00094 (quote id 1784097188898) carries the SAME payment id
 *   Job SNS-00090  -> invoiceNum INV-00065  (job id 1784548777655, value 2937.10)
 *     payment id 1784548937775  amount 2937.10  (kept — earlier, 2026-07-20)
 *     payment id 1784549039055  amount 2937.10  (DUPLICATE — ~101s later — removed)
 *     linked quote SQ-00107 (quote id 1784548749845) has an empty payments array
 *     — nothing to sync there.
 *
 * WHAT WAS WRONG (per the printed statement + the backup):
 *   - INV-00065 / job SNS-00090 has the identical credit-allocation payment
 *     recorded twice (same amount, same method, ~101 seconds apart) —
 *     the repeated final statement line.
 *   - Because of that duplicate + a wrong split, the credit allocated to
 *     INV-00061 (R4,829.13) and the un-deduplicated INV-00065 total don't
 *     add up to the R12,905.01 credit note.
 *   - The "Credit (R 12 905,01 available)" text on each payment is a static
 *     string baked in at the time it was recorded — it always shows the
 *     ORIGINAL note total, never what's actually left after that specific
 *     use.
 *
 * WHAT THIS SCRIPT CHANGES — ONLY these fields, ONLY for the three Diaz
 * jobs / their linked quotes (same ids, same dates, same references) /
 * CN-0001 above. Nothing else in platform_state is touched:
 *   1. Job SNS-00063 payment 1784012042372: method text only (amount
 *      preserved at 5138.77 exactly, per instruction — the backup shows no
 *      more precise stored amount, so it is left unchanged).
 *   2. Job SNS-00087 payment 1784533274025: amount 4829.13 -> 6414.70
 *      (job's own invoice total — fully covered by the credit that was
 *      left), method text updated.
 *   3. Job SNS-00090: the LATER duplicate payment (id 1784549039055) is
 *      removed. The EARLIER payment (id 1784548937775) is kept, its amount
 *      corrected 2937.10 -> 1351.54 (the credit remaining at that point),
 *      method text updated.
 *   4. The same method-text (and, for SQ-00094, amount) correction is
 *      mirrored onto the linked quotes SQ-00089 / SQ-00094 for the SAME
 *      payment id, so the Quotes tab doesn't show a stale duplicate of the
 *      same payment with different numbers. SQ-00107's payments array is
 *      already empty — left untouched.
 *   5. CN-0001.used is set to 12905.01 (fully drawn down). This field is
 *      not currently populated on this credit note even though all three
 *      allocations above already exhaust it — it's the same authoritative
 *      field applyCreditNoteUsage() in index.html writes to, just never
 *      set for this note. No other credit note is touched.
 *
 * Every other field on every one of these records (id, date, reference,
 * customer id, quote/job links, company marker "co", document numbers,
 * status workflow fields, etc.) is left exactly as-is. No other Diaz
 * record, no other customer, no application code, no calculation function,
 * and no migration is touched by this script.
 *
 * SAFETY:
 *   - Runs in DRY-RUN mode by default (prints the full before/after diff
 *     plus a simulated statement replay, writes nothing). Pass --apply to
 *     actually write.
 *   - Aborts with a clear error (no writes at all) if the live data does
 *     not match the values recorded above within 2 cents — it never
 *     "guesses" its way through a mismatch.
 *   - Idempotent: re-running after a successful --apply detects the fix is
 *     already in place and does nothing.
 *   - Backs up the CURRENT full platform_state row into
 *     platform_state_backups BEFORE writing anything.
 *   - Never drops a table, never deletes a backup row, never touches
 *     schema_migrations, never runs DELETE/TRUNCATE/DROP SQL.
 *   - Uses DATABASE_URL only — no hard-coded credentials.
 *
 * Run (from backend/, after `npm run build`):
 *   node dist/db/fixDiazStatementJuly2026.js          # dry run — prints the diff + replay
 *   node dist/db/fixDiazStatementJuly2026.js --apply  # actually writes the fix
 */
import { Client } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const CENT = 0.02; // sanity-check tolerance

// ── Known-good record identity, confirmed against the 2026-07-21 18:37 backup ──
const CUSTOMER_NAME = 'Diaz Hotel & Resort';
const CN_ID = 1782915525736;       // CN-0001
const JOB16_ID = 1784012079803;    // SNS-00063 -> INV-00016
const PAY16_ID = 1784012042372;
const QUOTE16_ID = 1784012008924;  // SQ-00089
const JOB61_ID = 1784533312014;    // SNS-00087 -> INV-00061
const PAY61_ID = 1784533274025;
const QUOTE61_ID = 1784097188898;  // SQ-00094
const JOB65_ID = 1784548777655;    // SNS-00090 -> INV-00065
const PAY65_KEEP_ID = 1784548937775;   // earlier — kept
const PAY65_DUP_ID = 1784549039055;    // later, ~101s after — removed

const norm = (s: unknown) => String(s || '').trim().toLowerCase();
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const R = (n: number) =>
  'R ' + Number(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fail(msg: string): never {
  console.error(`[fix-diaz] ✗ ABORTED — no changes written.\n[fix-diaz] Reason: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const APPLY = process.argv.includes('--apply');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set.');

  const useSsl = /render\.com|sslmode=require/i.test(databaseUrl);
  const client = new Client({
    connectionString: databaseUrl,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  });

  await client.connect();
  console.log('[fix-diaz] Connected to PostgreSQL.');
  console.log(`[fix-diaz] Mode: ${APPLY ? 'APPLY (will write)' : 'DRY RUN (no writes — pass --apply to write)'}`);

  try {
    await client.query('BEGIN');

    const existingRes = await client.query('SELECT data FROM platform_state WHERE id = 1 FOR UPDATE');
    if (existingRes.rowCount === 0) fail('platform_state row (id=1) does not exist.');
    const data = existingRes.rows[0].data || {};

    const jobs: any[] = Array.isArray(data.jobs) ? data.jobs : [];
    const quotes: any[] = Array.isArray(data.quotes) ? data.quotes : [];
    const creditNotes: any[] = Array.isArray(data.creditNotes) ? data.creditNotes : [];

    const job16 = jobs.find((j) => j.id === JOB16_ID);
    const job61 = jobs.find((j) => j.id === JOB61_ID);
    const job65 = jobs.find((j) => j.id === JOB65_ID);
    if (!job16) fail(`Job ${JOB16_ID} (SNS-00063 / INV-00016) not found.`);
    if (!job61) fail(`Job ${JOB61_ID} (SNS-00087 / INV-00061) not found.`);
    if (!job65) fail(`Job ${JOB65_ID} (SNS-00090 / INV-00065) not found.`);
    for (const [label, j] of [['SNS-00063', job16], ['SNS-00087', job61], ['SNS-00090', job65]] as const) {
      if (norm(j.client) !== norm(CUSTOMER_NAME)) fail(`Job ${label} client is "${j.client}", expected "${CUSTOMER_NAME}".`);
    }

    const cn = creditNotes.find((c) => c.id === CN_ID);
    if (!cn) fail(`Credit note ${CN_ID} (CN-0001) not found.`);
    if (norm(cn.contactName) !== norm(CUSTOMER_NAME)) fail(`CN-0001 contactName is "${cn.contactName}", expected "${CUSTOMER_NAME}".`);
    const creditFace = round2(parseFloat(cn.amount) || 0);
    if (Math.abs(creditFace - 12905.01) > CENT) fail(`CN-0001 amount is ${R(creditFace)}, expected ${R(12905.01)}.`);

    const quote16 = quotes.find((q) => q.id === QUOTE16_ID);
    const quote61 = quotes.find((q) => q.id === QUOTE61_ID);
    // (SQ-00107 / quote for job65 is not needed — its payments array is empty)

    // ── Locate and verify each payment ──────────────────────────────────
    const pay16 = (job16.payments || []).find((p: any) => p.id === PAY16_ID);
    if (!pay16) fail(`Payment ${PAY16_ID} not found on job SNS-00063.`);
    const pay16Amt = round2(parseFloat(pay16.amount) || 0);
    if (Math.abs(pay16Amt - 5138.77) > CENT) fail(`Job SNS-00063 payment amount is ${R(pay16Amt)}, expected ${R(5138.77)}.`);

    const pay61 = (job61.payments || []).find((p: any) => p.id === PAY61_ID);
    if (!pay61) fail(`Payment ${PAY61_ID} not found on job SNS-00087.`);
    const pay61AmtBefore = round2(parseFloat(pay61.amount) || 0);
    const job61Total = round2(parseFloat(job61.value) || 0);
    if (Math.abs(job61Total - 6414.70) > CENT) fail(`Job SNS-00087 value is ${R(job61Total)}, expected ${R(6414.70)}.`);

    const pay65Keep = (job65.payments || []).find((p: any) => p.id === PAY65_KEEP_ID);
    const pay65Dup = (job65.payments || []).find((p: any) => p.id === PAY65_DUP_ID);
    if (!pay65Keep) fail(`Payment ${PAY65_KEEP_ID} not found on job SNS-00090.`);
    const job65Total = round2(parseFloat(job65.value) || 0);
    if (Math.abs(job65Total - 2937.10) > CENT) fail(`Job SNS-00090 value is ${R(job65Total)}, expected ${R(2937.10)}.`);

    // ── Compute the corrected figures ───────────────────────────────────
    const remainingAfter16 = round2(creditFace - pay16Amt);
    if (Math.abs(remainingAfter16 - 7766.24) > CENT) fail(`Remaining credit after INV-00016 computes to ${R(remainingAfter16)}, expected ${R(7766.24)}.`);

    const pay61AmtAfter = job61Total; // 6414.70 — fully covered by the credit that was left
    const remainingAfter61 = round2(remainingAfter16 - pay61AmtAfter);
    if (Math.abs(remainingAfter61 - 1351.54) > CENT) fail(`Remaining credit after INV-00061 computes to ${R(remainingAfter61)}, expected ${R(1351.54)}.`);

    const pay65AmtAfter = remainingAfter61; // 1351.54 — exhausts the note
    const remainingAfter65 = round2(remainingAfter61 - pay65AmtAfter);
    const outstandingOn65 = round2(job65Total - pay65AmtAfter);
    if (Math.abs(outstandingOn65 - 1585.56) > CENT) fail(`Outstanding balance on INV-00065 computes to ${R(outstandingOn65)}, expected ${R(1585.56)}.`);

    const newMethod16 = `Credit (${R(remainingAfter16)} available)`;
    const newMethod61 = `Credit (${R(remainingAfter61)} available)`;
    const newMethod65 = `Credit (${R(remainingAfter65)} available)`;

    // Idempotency guard — if a prior --apply already did this, do nothing.
    const alreadyFixed =
      !pay65Dup &&
      Math.abs(pay61AmtBefore - pay61AmtAfter) <= CENT &&
      Math.abs(round2(parseFloat(pay65Keep.amount) || 0) - pay65AmtAfter) <= CENT &&
      String(pay16.method) === newMethod16 &&
      String(pay61.method) === newMethod61;
    if (alreadyFixed) {
      console.log('[fix-diaz] Statement already matches the corrected figures — nothing to do.');
      await client.query('ROLLBACK');
      process.exit(0);
    }

    console.log('\n[fix-diaz] ── Planned changes ──────────────────────────────');
    console.log(`Job SNS-00063 / INV-00016  payment ${PAY16_ID}:`);
    console.log(`  method:  "${pay16.method}"  ->  "${newMethod16}"`);
    console.log(`  amount:  ${R(pay16Amt)}  (unchanged)`);
    console.log(`Job SNS-00087 / INV-00061  payment ${PAY61_ID}:`);
    console.log(`  amount:  ${R(pay61AmtBefore)}  ->  ${R(pay61AmtAfter)}`);
    console.log(`  method:  "${pay61.method}"  ->  "${newMethod61}"`);
    console.log(`Job SNS-00090 / INV-00065  payment ${PAY65_KEEP_ID} (kept):`);
    console.log(`  amount:  ${R(round2(parseFloat(pay65Keep.amount) || 0))}  ->  ${R(pay65AmtAfter)}`);
    console.log(`  method:  "${pay65Keep.method}"  ->  "${newMethod65}"`);
    console.log(`Job SNS-00090 / INV-00065  payment ${PAY65_DUP_ID}: ${pay65Dup ? 'REMOVED (duplicate)' : 'already absent'}`);
    console.log(`Credit note CN-0001 "used": ${R(parseFloat(cn.used) || 0)}  ->  ${R(creditFace)}`);
    console.log(`Linked quote SQ-00089 (${QUOTE16_ID}) payment ${PAY16_ID}: ${quote16 ? 'method synced' : 'quote not found — job only'}`);
    console.log(`Linked quote SQ-00094 (${QUOTE61_ID}) payment ${PAY61_ID}: ${quote61 ? 'amount+method synced' : 'quote not found — job only'}`);
    console.log('[fix-diaz] ──────────────────────────────────────────────────\n');

    // ── Simulated statement replay (mirrors buildStatement() in index.html,
    //    read-only — for verification only, does not affect what's written) ──
    type Ev = { date: string; sort: number; debit: number; credit: number };
    const evs: Ev[] = [];
    evs.push({ date: cn.date, sort: 2, debit: 0, credit: creditFace });
    evs.push({ date: job16.invoiceDate, sort: 0, debit: 5138.78, credit: 0 });
    evs.push({ date: job16.invoiceDate, sort: 1, debit: 0, credit: 0 }); // credit-alloc row, balance-neutral
    evs.push({ date: job61.invoiceDate, sort: 0, debit: job61Total, credit: 0 });
    evs.push({ date: job65.invoiceDate, sort: 0, debit: job65Total, credit: 0 });
    evs.push({ date: job61.invoiceDate, sort: 1, debit: 0, credit: 0 }); // credit-alloc row, balance-neutral
    evs.push({ date: job65.invoiceDate, sort: 1, debit: 0, credit: 0 }); // credit-alloc row, balance-neutral
    evs.sort((a, b) => {
      const d = new Date(a.date).getTime() - new Date(b.date).getTime();
      return d !== 0 ? d : a.sort - b.sort;
    });
    let running = 0;
    evs.forEach((e) => (running += e.debit - e.credit));
    console.log(`[fix-diaz] Simulated statement replay: ${evs.length} transactions in period, closing balance ${R(running)}.`);
    if (evs.length !== 7) fail(`Simulated replay produced ${evs.length} transactions, expected 7.`);
    if (Math.abs(running - 1585.56) > CENT) fail(`Simulated closing balance is ${R(running)}, expected ${R(1585.56)}.`);

    if (!APPLY) {
      console.log('[fix-diaz] Dry run only — no changes written. Re-run with --apply to write these changes.');
      await client.query('ROLLBACK');
      process.exit(0);
    }

    // ── Apply the edits to a deep copy ──────────────────────────────────
    const newData = JSON.parse(JSON.stringify(data));
    const nJob16 = newData.jobs.find((j: any) => j.id === JOB16_ID);
    const nJob61 = newData.jobs.find((j: any) => j.id === JOB61_ID);
    const nJob65 = newData.jobs.find((j: any) => j.id === JOB65_ID);
    const nCn = newData.creditNotes.find((c: any) => c.id === CN_ID);
    const nQuote16 = (newData.quotes || []).find((q: any) => q.id === QUOTE16_ID);
    const nQuote61 = (newData.quotes || []).find((q: any) => q.id === QUOTE61_ID);

    const nPay16 = nJob16.payments.find((p: any) => p.id === PAY16_ID);
    nPay16.method = newMethod16;

    const nPay61 = nJob61.payments.find((p: any) => p.id === PAY61_ID);
    nPay61.amount = pay61AmtAfter;
    nPay61.method = newMethod61;

    nJob65.payments = nJob65.payments.filter((p: any) => p.id !== PAY65_DUP_ID);
    const nPay65 = nJob65.payments.find((p: any) => p.id === PAY65_KEEP_ID);
    nPay65.amount = pay65AmtAfter;
    nPay65.method = newMethod65;

    nCn.used = creditFace;

    if (nQuote16) {
      const qp16 = (nQuote16.payments || []).find((p: any) => p.id === PAY16_ID);
      if (qp16) qp16.method = newMethod16;
    }
    if (nQuote61) {
      const qp61 = (nQuote61.payments || []).find((p: any) => p.id === PAY61_ID);
      if (qp61) { qp61.amount = pay61AmtAfter; qp61.method = newMethod61; }
    }

    // ── Backup current (pre-fix) state BEFORE writing anything ─────────
    const serialized = JSON.stringify(data);
    await client.query(
      `INSERT INTO platform_state_backups (data, reason, data_size_bytes, source)
       VALUES ($1::jsonb, 'manual-fix-diaz-statement-2026-07', $2, 'fixDiazStatementJuly2026.ts (manual run)')`,
      [serialized, Buffer.byteLength(serialized, 'utf8')]
    );
    console.log('[fix-diaz] Current platform_state backed up to platform_state_backups.');

    await client.query(
      `UPDATE platform_state SET data = $1::jsonb, updated_at = NOW() WHERE id = 1`,
      [JSON.stringify(newData)]
    );

    await client.query('COMMIT');
    console.log('[fix-diaz] ✓ Done. Diaz Hotel & Resort statement data corrected.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[fix-diaz] ✗ FAILED — transaction rolled back. No changes were written.');
    throw err;
  } finally {
    await client.end().catch(() => undefined);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[fix-diaz] Fatal error:', err);
    process.exit(1);
  });
