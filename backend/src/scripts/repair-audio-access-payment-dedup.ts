/**
 * repair-audio-access-payment-dedup.ts
 * SIGNACORE — ONE-CASE PAYMENT DEDUPLICATION + REALLOCATION
 * Audio Access:  SQ-00108  ->  SNS-00110  ->  INV-00103
 * Created 2026-08-25.
 *
 * ── WHAT THIS DOES, AND WHY ─────────────────────────────────────────────────
 * The read-only diagnostic returned AMBIGUOUS: TWO authoritative rel_payments
 * rows carry R5,840.22 EFT — one owned by the quote, one by the job. A script
 * cannot resolve that; only a person who knows the bank can. The owner has,
 * and the business fact is:
 *
 *     the two rows are the SAME real payment, captured twice by the payment
 *     workflow that has since been repaired.
 *
 * So this does two things to two specific rows, in one transaction:
 *
 *   1. DELETE the duplicate captured on the JOB   (rel_payments id 440).
 *   2. MOVE the survivor captured on the QUOTE    (rel_payments id 368)
 *      to owner_type='invoice', owner_id=47 (INV-00103).
 *
 * Allocation IS ownership in this schema — rel_payments has one owner per row
 * and no separate allocation table — so step 2 is the entire reallocation.
 *
 * ── WHAT IT REFUSES TO DO ───────────────────────────────────────────────────
 * There is NO `INSERT INTO rel_payments` anywhere in this file. It cannot
 * create a payment. The surviving row keeps its id, source_id, amount, date,
 * method, reference and notes — only owner_type, owner_id, line_index and
 * row_version move. Nothing else in the database is written except the two
 * owners' derived payment status, and the backup row.
 *
 * ── THE STATUS IS DERIVED, NOT TYPED ────────────────────────────────────────
 * Both owners' status is recomputed by services.ts's own
 * recomputeOwnerPaymentStatus — the deployed function, imported, not a copy.
 * R7,300.27 / R5,840.22 / R1,460.05 / 'partial' appear here ONLY as pre-check
 * expectations and post-check assertions; every value written is derived.
 *
 * The job also gets recomputed, not just the invoice: removing a payment from
 * SNS-00110 leaves its invoice_status describing money it no longer holds, and
 * a repair that fixes one end while leaving the other lying is not a repair.
 *
 * ── SAFETY MODEL ────────────────────────────────────────────────────────────
 *   * DRY RUN BY DEFAULT. Writes need BOTH --apply AND the exact --confirm.
 *   * Every pre-check is re-verified INSIDE the write transaction, after the
 *     rows are locked FOR UPDATE.
 *   * The dry run prints an --apply command with all four row_versions pinned.
 *   * A scoped, recoverable backup goes to platform_state_backups — the
 *     mechanism this codebase already uses — inside the same transaction,
 *     BEFORE any change.
 *   * Post-checks run inside the transaction and throw (-> ROLLBACK) on any
 *     discrepancy, including any evidence an unrelated row moved.
 *   * Re-running after success is safely idempotent: it recognises the
 *     finished state and exits having written nothing.
 *
 * ── USAGE (PowerShell, from the repo root) ──────────────────────────────────
 *   cd backend
 *   $env:DATABASE_URL = "<connection string>"
 *   npx ts-node --transpile-only src/scripts/repair-audio-access-payment-dedup.ts
 *   # then the --apply command the dry run prints
 */
import type { PoolClient } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import pool from '../db/pool';
import { recomputeOwnerPaymentStatus, releaseCreditForPaymentTx } from '../relational/services';

// ── IDENTITY OF THE ONE CASE ────────────────────────────────────────────────
const QUOTE_NUMBER = 'SQ-00108';
const JOB_NUMBER = 'SNS-00110';
const INVOICE_NUMBER = 'INV-00103';
const COMPANY_CODE = '2';
const REQUIRED_CONFIRM = 'DEDUPLICATE AUDIO ACCESS PAYMENT';

// The exact rows the owner identified. Overridable so the same script can be
// driven against the local fixture, whose serial ids differ from production.
const DEFAULT_KEEP_PAYMENT_ID = 368;   // owned by the QUOTE — the survivor
const DEFAULT_DROP_PAYMENT_ID = 440;   // owned by the JOB   — the duplicate
const DEFAULT_INVOICE_ID = 47;         // INV-00103

// ── WHAT THE DIAGNOSTIC OBSERVED (pre-check expectations only) ──────────────
const OBSERVED_AMOUNT = 5840.22;
const OBSERVED_METHOD = 'EFT';
const OBSERVED_INVOICE_TOTAL = 7300.27;
const EXPECTED_PAID_AFTER = 5840.22;
const EXPECTED_BALANCE_AFTER = 1460.05;
const EXPECTED_STATUS_AFTER = 'partial';

const MONEY_TOLERANCE = 0.005;

const lines: string[] = [];
function log(msg = '') { lines.push(msg); console.log(msg); }
function money(n: unknown): number { return Math.round((Number(n) || 0) * 100) / 100; }
function eqMoney(a: unknown, b: unknown): boolean { return Math.abs(money(a) - money(b)) < MONEY_TOLERANCE; }
function norm(v: unknown): string { return (v === null || v === undefined) ? '' : String(v).trim().toUpperCase(); }
function dateStr(v: unknown): string {
  if (v === null || v === undefined) return '(none)';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

class PreCheckFailure extends Error {}
class AlreadyRepaired extends Error {}

interface CheckResult { n: string; label: string; ok: boolean; detail: string }
const checks: CheckResult[] = [];
function check(n: string, ok: boolean, label: string, detail: unknown = '') {
  checks.push({ n, label, ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
}

/** An invoice's total, derived the one way this system derives it: its lines. */
async function invoiceTotal(client: PoolClient, invoiceId: number): Promise<number> {
  const r = (await client.query(
    `SELECT COALESCE(SUM(qty * unit_amount * CASE WHEN tax_type = '15%' THEN 1.15 ELSE 1 END), 0) AS total
       FROM rel_invoice_line_items WHERE invoice_id = $1`, [invoiceId])).rows[0];
  return Number(r.total);
}

async function paidAgainst(client: PoolClient, ownerType: string, ownerId: number): Promise<number> {
  const r = (await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS t FROM rel_payments WHERE owner_type = $1 AND owner_id = $2`,
    [ownerType, ownerId])).rows[0];
  return Number(r.t);
}

/** Fingerprint of everything this repair must NOT touch. */
async function untouchedFingerprint(client: PoolClient, keepId: number, dropId: number, invoiceId: number, jobId: number, quoteId: number) {
  const q = async (sql: string, params: any[] = []) => (await client.query(sql, params)).rows;
  return {
    otherPayments: await q(
      `SELECT id, owner_type, owner_id, line_index, amount, payment_date, method, reference, notes, row_version
         FROM rel_payments WHERE id <> $1 AND id <> $2 ORDER BY id`, [keepId, dropId]),
    allCreditNotes: await q(
      `SELECT id, credit_number, amount, used_amount, applied_to, status, row_version FROM rel_credit_notes ORDER BY id`),
    otherInvoices: await q(
      `SELECT id, row_version, invoice_number, status, job_id, quote_id FROM rel_invoices WHERE id <> $1 ORDER BY id`, [invoiceId]),
    otherJobs: await q(
      `SELECT id, row_version, job_number, value, status, stage, invoice_num, invoice_created, invoice_status
         FROM rel_jobs WHERE id <> $1 ORDER BY id`, [jobId]),
    allQuotes: await q(
      `SELECT id, row_version, quote_number, total, status FROM rel_quotes ORDER BY id`),
    invoiceLines: await q(
      `SELECT id, invoice_id, line_index, description, qty, unit_amount, tax_type FROM rel_invoice_line_items ORDER BY id`),
    jobLines: await q(
      `SELECT id, job_id, line_index, description, qty, unit_price, pieces FROM rel_job_line_items ORDER BY id`),
    quoteLines: await q(
      `SELECT id, quote_id, line_index, description, qty, unit_price, pieces FROM rel_quote_line_items ORDER BY id`),
    // The target quote is fingerprinted too: it loses a payment but must not
    // itself be written to (quotes have no payment-derived status — see
    // recomputeOwnerPaymentStatus's early return for ownerType 'quote').
    targetQuote: await q(
      `SELECT id, row_version, quote_number, total, subtotal, vat_amount, setup_fee, discount_pct, status
         FROM rel_quotes WHERE id = $1`, [quoteId]),
    paymentCount: await q(`SELECT COUNT(*)::int AS n FROM rel_payments`),
  };
}

/** Prints the checks gathered so far, then stops. Used by the two EARLY exits
 *  below: without this, a run that cannot proceed past record resolution
 *  reported "STOPPED" with no indication of WHICH check failed. */
function reportAndStop(message: string): never {
  log('── PRE-CHECKS (stopped early) ────────────────────────────────');
  for (const c of checks) log(`  ${c.ok ? 'PASS' : 'FAIL'}  [${c.n}] ${c.label}${c.ok ? '' : '  →  ' + c.detail}`);
  log('');
  throw new PreCheckFailure(message);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const APPLY = argv.includes('--apply');
  const arg = (flag: string): string => {
    const a = argv.find((x) => x.startsWith(flag + '='));
    return a ? a.slice(flag.length + 1).replace(/^["']|["']$/g, '').trim() : '';
  };
  const confirm = arg('--confirm');
  const KEEP_ID = Number(arg('--keep-payment-id') || DEFAULT_KEEP_PAYMENT_ID);
  const DROP_ID = Number(arg('--drop-payment-id') || DEFAULT_DROP_PAYMENT_ID);
  const INVOICE_ID = Number(arg('--invoice-id') || DEFAULT_INVOICE_ID);
  const expectKeepV = arg('--expect-keep-version');
  const expectDropV = arg('--expect-drop-version');
  const expectInvV = arg('--expect-invoice-version');
  const expectJobV = arg('--expect-job-version');
  const outPathArg = arg('--out');

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Refusing to run.\n\nPowerShell:\n  $env:DATABASE_URL = "<connection string>"');
    process.exitCode = 1;
    return;
  }

  const client = await pool.connect();
  let committed = false;
  try {
    log('==============================================================');
    log(' SIGNACORE — AUDIO ACCESS PAYMENT DEDUPLICATION + REALLOCATION');
    log(` ${QUOTE_NUMBER} -> ${JOB_NUMBER} -> ${INVOICE_NUMBER}  (company ${COMPANY_CODE})`);
    log('==============================================================');
    const who = (await client.query('SELECT current_database() AS db, current_user AS usr, now() AS at')).rows[0];
    log(` database : ${who.db}`);
    log(` user     : ${who.usr}`);
    log(` run at   : ${new Date(who.at).toISOString()}`);
    log(` mode     : ${APPLY ? 'APPLY (writes, but only if EVERY check passes)' : 'DRY RUN (writes nothing)'}`);
    log(` keep     : rel_payments id ${KEEP_ID}  (the QUOTE's capture — the survivor)`);
    log(` drop     : rel_payments id ${DROP_ID}  (the JOB's capture — the duplicate)`);
    log(` allocate : to rel_invoices id ${INVOICE_ID} (${INVOICE_NUMBER})`);
    log('');

    // ONE transaction for the reads AND the writes, so the state that is
    // checked is provably the state that is written. Rolled back in dry run.
    await client.query('BEGIN');

    // ── locate and lock ─────────────────────────────────────────────────────
    const quoteRes = await client.query(
      `SELECT * FROM rel_quotes WHERE UPPER(BTRIM(quote_number)) = $1 ORDER BY id FOR UPDATE`, [QUOTE_NUMBER]);
    const jobRes = await client.query(
      `SELECT * FROM rel_jobs WHERE UPPER(BTRIM(job_number)) = $1 ORDER BY id FOR UPDATE`, [JOB_NUMBER]);
    const invRes = await client.query(
      `SELECT * FROM rel_invoices WHERE UPPER(BTRIM(invoice_number)) = $1 ORDER BY id FOR UPDATE`, [INVOICE_NUMBER]);

    check('1', quoteRes.rowCount === 1 && String(quoteRes.rows[0].company_code) === COMPANY_CODE,
      `${QUOTE_NUMBER} exists exactly once, in company ${COMPANY_CODE}`,
      { rows: quoteRes.rowCount, company: quoteRes.rows[0]?.company_code });
    check('2', jobRes.rowCount === 1 && String(jobRes.rows[0].company_code) === COMPANY_CODE,
      `${JOB_NUMBER} exists exactly once, in company ${COMPANY_CODE}`,
      { rows: jobRes.rowCount, company: jobRes.rows[0]?.company_code });
    check('3', invRes.rowCount === 1 && String(invRes.rows[0].company_code) === COMPANY_CODE,
      `${INVOICE_NUMBER} exists exactly once, in company ${COMPANY_CODE}`,
      { rows: invRes.rowCount, company: invRes.rows[0]?.company_code });
    if (quoteRes.rowCount !== 1 || jobRes.rowCount !== 1 || invRes.rowCount !== 1) {
      reportAndStop('the three records could not be resolved to exactly one row each — nothing further can be verified safely');
    }
    const quote = quoteRes.rows[0];
    const job = jobRes.rows[0];
    const inv = invRes.rows[0];

    check('4', String(inv.id) === String(INVOICE_ID),
      `${INVOICE_NUMBER} really is rel_invoices id ${INVOICE_ID}`, { actual: inv.id, expected: INVOICE_ID });

    const payRes = await client.query(
      `SELECT * FROM rel_payments WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE`, [[KEEP_ID, DROP_ID]]);
    const keep = payRes.rows.find((p: any) => String(p.id) === String(KEEP_ID));
    const drop = payRes.rows.find((p: any) => String(p.id) === String(DROP_ID));

    // ── idempotency: recognise the finished state before judging it broken ──
    if (!drop && keep && keep.owner_type === 'invoice' && String(keep.owner_id) === String(inv.id)) {
      throw new AlreadyRepaired(
        `payment ${DROP_ID} no longer exists and payment ${KEEP_ID} is already owned by ${INVOICE_NUMBER}. ` +
        `This case has already been repaired.`);
    }

    const invTotalNow = await invoiceTotal(client, inv.id);
    const paidOnInvoiceNow = await paidAgainst(client, 'invoice', inv.id);

    check('5', !!keep, `payment ${KEEP_ID} still exists`, { found: !!keep });
    check('6', !!drop, `payment ${DROP_ID} still exists`, { found: !!drop });
    if (!keep || !drop) {
      reportAndStop('one of the two payment rows is gone — the data has moved since the diagnostic. Re-run the diagnostic for a fresh plan.');
    }

    check('7', keep.owner_type === 'quote' && String(keep.owner_id) === String(quote.id),
      `payment ${KEEP_ID} still belongs to ${QUOTE_NUMBER} (rel id ${quote.id})`,
      { owner_type: keep.owner_type, owner_id: keep.owner_id });
    check('8', drop.owner_type === 'job' && String(drop.owner_id) === String(job.id),
      `payment ${DROP_ID} still belongs to ${JOB_NUMBER} (rel id ${job.id})`,
      { owner_type: drop.owner_type, owner_id: drop.owner_id });
    check('9', eqMoney(keep.amount, OBSERVED_AMOUNT) && norm(keep.method) === norm(OBSERVED_METHOD),
      `payment ${KEEP_ID} is still R${OBSERVED_AMOUNT.toFixed(2)} ${OBSERVED_METHOD}`,
      { amount: money(keep.amount), method: keep.method });
    check('10', eqMoney(drop.amount, OBSERVED_AMOUNT) && norm(drop.method) === norm(OBSERVED_METHOD),
      `payment ${DROP_ID} is still R${OBSERVED_AMOUNT.toFixed(2)} ${OBSERVED_METHOD}`,
      { amount: money(drop.amount), method: drop.method });
    check('11', eqMoney(invTotalNow, OBSERVED_INVOICE_TOTAL),
      `${INVOICE_NUMBER} still totals ${OBSERVED_INVOICE_TOTAL.toFixed(2)}`, { total: money(invTotalNow) });
    check('12', eqMoney(paidOnInvoiceNow, 0),
      `${INVOICE_NUMBER} still has ZERO invoice-owned payments — nothing can be double-counted`,
      { paid: money(paidOnInvoiceNow) });

    // No THIRD matching payment anywhere on this chain.
    const thirdRes = await client.query(
      `SELECT id, owner_type, owner_id, amount, payment_date, method FROM rel_payments
        WHERE id <> $1 AND id <> $2 AND ABS(amount - $3::numeric) < 0.005
          AND ( (owner_type='quote' AND owner_id=$4) OR (owner_type='job' AND owner_id=$5) OR (owner_type='invoice' AND owner_id=$6) )
        ORDER BY id`,
      [KEEP_ID, DROP_ID, OBSERVED_AMOUNT, quote.id, job.id, inv.id]);
    check('13', thirdRes.rowCount === 0,
      `no THIRD R${OBSERVED_AMOUNT.toFixed(2)} payment exists on this chain`, thirdRes.rows);

    // Credit coupling. Deleting a Credit payment releases credit-note balance;
    // MOVING one would change which contact the release matches against. Both
    // are out of scope for a deduplication, so either one stops the repair.
    check('14', norm(keep.method) !== 'CREDIT' && norm(drop.method) !== 'CREDIT',
      'neither payment is Credit-method — no credit-note coupling to unwind',
      { keep: keep.method, drop: drop.method });
    const cnRes = await client.query(
      `SELECT id, credit_number, applied_to, used_amount FROM rel_credit_notes
        WHERE applied_to IS NOT NULL
          AND ( UPPER(BTRIM(applied_to)) LIKE '%' || $1 || '%'
             OR UPPER(BTRIM(applied_to)) LIKE '%' || $2 || '%'
             OR UPPER(BTRIM(applied_to)) LIKE '%' || $3 || '%' )`,
      [INVOICE_NUMBER, JOB_NUMBER, QUOTE_NUMBER]);
    check('15', cnRes.rowCount === 0,
      'no credit note references any document in this chain', cnRes.rows);

    // ── operator-supplied row_version pins ─────────────────────────────────
    if (expectKeepV !== '') check('V1', Number(expectKeepV) === Number(keep.row_version),
      `payment ${KEEP_ID} row_version still ${expectKeepV}`, { actual: keep.row_version });
    if (expectDropV !== '') check('V2', Number(expectDropV) === Number(drop.row_version),
      `payment ${DROP_ID} row_version still ${expectDropV}`, { actual: drop.row_version });
    if (expectInvV !== '') check('V3', Number(expectInvV) === Number(inv.row_version),
      `${INVOICE_NUMBER} row_version still ${expectInvV}`, { actual: inv.row_version });
    if (expectJobV !== '') check('V4', Number(expectJobV) === Number(job.row_version),
      `${JOB_NUMBER} row_version still ${expectJobV}`, { actual: job.row_version });

    // ── report ─────────────────────────────────────────────────────────────
    log('── PRE-CHECKS ────────────────────────────────────────────────');
    for (const c of checks) log(`  ${c.ok ? 'PASS' : 'FAIL'}  [${c.n}] ${c.label}${c.ok ? '' : '  →  ' + c.detail}`);
    const failed = checks.filter((c) => !c.ok);
    log('');
    log(`  ${checks.length - failed.length} passed, ${failed.length} failed`);
    log('');
    if (failed.length > 0) throw new PreCheckFailure(`${failed.length} pre-check(s) failed — see above. Nothing was written.`);

    const nextIndexRes = await client.query(
      `SELECT COALESCE(MAX(line_index) + 1, 0) AS next FROM rel_payments WHERE owner_type = 'invoice' AND owner_id = $1`,
      [inv.id]);
    const nextLineIndex = Number(nextIndexRes.rows[0].next);

    log('── CURRENT STATE ─────────────────────────────────────────────');
    log(`  ${QUOTE_NUMBER}   rel id ${quote.id}  row_version ${quote.row_version}  total ${money(quote.total).toFixed(2)}`);
    log(`  ${JOB_NUMBER}  rel id ${job.id}  row_version ${job.row_version}  value ${money(job.value).toFixed(2)}  invoice_status ${job.invoice_status}`);
    log(`  ${INVOICE_NUMBER}  rel id ${inv.id}  row_version ${inv.row_version}  total ${money(invTotalNow).toFixed(2)}  status ${inv.status}  paid ${money(paidOnInvoiceNow).toFixed(2)}`);
    log('');
    log('  The two payment rows:');
    for (const p of [keep, drop]) {
      log(`    id ${p.id}  ${p.owner_type} ${p.owner_id}  line_index ${p.line_index}  ${money(p.amount).toFixed(2)}  ${dateStr(p.payment_date)}  ${p.method}  ref ${p.reference ?? '(none)'}  notes ${p.notes ?? '(none)'}  row_version ${p.row_version}`);
    }
    log('');
    log('── PLANNED CHANGES ───────────────────────────────────────────');
    log(`  STEP 1 — DELETE rel_payments id ${DROP_ID} (the JOB's duplicate capture).`);
    log(`  STEP 2 — UPDATE rel_payments id ${KEEP_ID}:`);
    log(`             owner_type  '${keep.owner_type}' -> 'invoice'`);
    log(`             owner_id    ${keep.owner_id} -> ${inv.id}`);
    log(`             line_index  ${keep.line_index} -> ${nextLineIndex}   (UNIQUE (owner_type, owner_id, line_index))`);
    log(`             row_version ${keep.row_version} -> ${Number(keep.row_version) + 1}`);
    log(`             amount / date / method / reference / notes / source_id: UNCHANGED`);
    log(`  STEP 3 — recompute ${JOB_NUMBER}'s and ${INVOICE_NUMBER}'s derived payment status`);
    log('             with services.ts recomputeOwnerPaymentStatus (the deployed function).');
    log('  There is no INSERT INTO rel_payments in this script. Two rows become one.');
    log('');

    if (!APPLY) {
      log('── DRY RUN COMPLETE — NOTHING WAS WRITTEN ────────────────────');
      log('');
      log('  To apply this exact plan, against these exact rows:');
      log('');
      log('    npx ts-node --transpile-only src/scripts/repair-audio-access-payment-dedup.ts `');
      log(`      --apply --confirm="${REQUIRED_CONFIRM}" \``);
      log(`      --expect-keep-version=${keep.row_version} --expect-drop-version=${drop.row_version} \``);
      log(`      --expect-invoice-version=${inv.row_version} --expect-job-version=${job.row_version}`);
      log('');
      log('  Those four pins are what make this a plan for THESE rows: if any of');
      log('  them changes before you run it, the repair stops rather than writing');
      log('  against a state nobody reviewed.');
      await client.query('ROLLBACK');
      return;
    }

    if (confirm !== REQUIRED_CONFIRM) {
      throw new PreCheckFailure(`--apply was given but --confirm did not exactly match "${REQUIRED_CONFIRM}". Refusing to change anything.`);
    }

    // ══ WRITE ══════════════════════════════════════════════════════════════
    log('── APPLYING ──────────────────────────────────────────────────');
    const fingerprintBefore = await untouchedFingerprint(client, KEEP_ID, DROP_ID, inv.id, job.id, quote.id);

    // ── BACKUP, before any change, in the same transaction ─────────────────
    const backupPayload = {
      repair: 'repair-audio-access-payment-dedup',
      capturedAt: new Date(who.at).toISOString(),
      businessDecision: 'Owner confirmed the two R5,840.22 EFT rows are the SAME real payment, captured twice by the pre-repair payment workflow. Keep the quote capture, delete the job duplicate, reallocate the survivor to the invoice.',
      quote: { header: quote },
      job: { header: job },
      invoice: { header: inv, derivedTotal: invTotalNow, paidBefore: paidOnInvoiceNow },
      paymentKept: keep,
      paymentDeleted: drop,
      allChainPayments: (await client.query(
        `SELECT * FROM rel_payments
          WHERE (owner_type='quote' AND owner_id=$1) OR (owner_type='job' AND owner_id=$2) OR (owner_type='invoice' AND owner_id=$3)
          ORDER BY owner_type, line_index`, [quote.id, job.id, inv.id])).rows,
      creditNotes: (await client.query(
        `SELECT * FROM rel_credit_notes WHERE applied_to IS NOT NULL
           AND ( UPPER(BTRIM(applied_to)) LIKE '%' || $1 || '%' OR UPPER(BTRIM(applied_to)) LIKE '%' || $2 || '%'
              OR UPPER(BTRIM(applied_to)) LIKE '%' || $3 || '%' )`,
        [INVOICE_NUMBER, JOB_NUMBER, QUOTE_NUMBER])).rows,
    };
    const serialized = JSON.stringify(backupPayload);
    const backupRes = await client.query(
      `INSERT INTO platform_state_backups (data, reason, data_size_bytes, source, record_counts)
       VALUES ($1::jsonb, 'before-repair-audio-access-payment-dedup', $2, $3, $4::jsonb)
       RETURNING id, created_at`,
      [serialized, Buffer.byteLength(serialized, 'utf8'),
       'src/scripts/repair-audio-access-payment-dedup.ts (manual run)',
       JSON.stringify({
         chainPayments: backupPayload.allChainPayments.length,
         creditNotes: backupPayload.creditNotes.length,
         paymentKeptId: KEEP_ID, paymentDeletedId: DROP_ID,
       })]);
    const backupId = backupRes.rows[0].id;
    log(`  BACKUP  platform_state_backups id = ${backupId}  (${backupRes.rows[0].created_at})`);
    log(`          holds BOTH payment rows verbatim, so the deleted one is fully recoverable.`);

    // ── STEP 1 — delete the duplicate ──────────────────────────────────────
    // Mirrors services.ts deletePayment's own in-transaction sequence: release
    // any credit effect first (a no-op for EFT, but it is the deployed
    // function, not an assumption), then delete.
    const creditReleased = await releaseCreditForPaymentTx(client, drop as any);
    const delRes = await client.query(
      `DELETE FROM rel_payments WHERE id = $1 AND owner_type = $2 AND owner_id = $3 AND row_version = $4`,
      [DROP_ID, drop.owner_type, drop.owner_id, drop.row_version]);
    if (delRes.rowCount !== 1) throw new Error(`payment ${DROP_ID} changed under us — rolling back`);
    log(`  STEP 1  deleted duplicate payment ${DROP_ID} (credit released: ${creditReleased}).`);

    // ── STEP 2 — move the survivor to the invoice ──────────────────────────
    const updRes = await client.query(
      `UPDATE rel_payments
          SET owner_type = 'invoice', owner_id = $2, line_index = $3,
              row_version = row_version + 1, updated_at = NOW()
        WHERE id = $1 AND owner_type = $4 AND owner_id = $5 AND row_version = $6
        RETURNING id, owner_type, owner_id, line_index, amount, payment_date, method, reference, notes, source_id, row_version`,
      [KEEP_ID, inv.id, nextLineIndex, keep.owner_type, keep.owner_id, keep.row_version]);
    if (updRes.rowCount !== 1) throw new Error(`payment ${KEEP_ID} changed under us — rolling back`);
    log(`  STEP 2  payment ${KEEP_ID} reallocated to ${INVOICE_NUMBER} (line_index ${nextLineIndex}).`);

    // ── STEP 3 — derived status, both ends ─────────────────────────────────
    await recomputeOwnerPaymentStatus(client, 'job', Number(job.id));
    await recomputeOwnerPaymentStatus(client, 'invoice', Number(inv.id));
    log(`  STEP 3  ${JOB_NUMBER} and ${INVOICE_NUMBER} payment status recomputed by services.ts.`);

    // ══ POST-CHECK, INSIDE THE TRANSACTION ═════════════════════════════════
    const keepAfter = (await client.query('SELECT * FROM rel_payments WHERE id = $1', [KEEP_ID])).rows[0];
    const dropAfter = (await client.query('SELECT * FROM rel_payments WHERE id = $1', [DROP_ID])).rows;
    const invAfter = (await client.query('SELECT * FROM rel_invoices WHERE id = $1', [inv.id])).rows[0];
    const jobAfter = (await client.query('SELECT * FROM rel_jobs WHERE id = $1', [job.id])).rows[0];
    const quoteAfter = (await client.query('SELECT * FROM rel_quotes WHERE id = $1', [quote.id])).rows[0];
    const invTotalAfter = await invoiceTotal(client, inv.id);
    const paidAfter = await paidAgainst(client, 'invoice', inv.id);
    const balanceAfter = invTotalAfter - paidAfter;

    const post: Array<[string, boolean, unknown]> = [];
    const p = (label: string, ok: boolean, detail: unknown = '') => post.push([label, ok, detail]);

    p(`duplicate payment ${DROP_ID} is gone`, dropAfter.length === 0, dropAfter.length);
    p(`surviving payment is still id ${KEEP_ID} — the QUOTE's original capture, not a new row`,
      !!keepAfter && String(keepAfter.id) === String(KEEP_ID), keepAfter?.id);
    p(`it is now owned by ${INVOICE_NUMBER} (invoice ${inv.id})`,
      keepAfter.owner_type === 'invoice' && String(keepAfter.owner_id) === String(inv.id),
      { owner_type: keepAfter.owner_type, owner_id: keepAfter.owner_id });
    p('its amount, date, method, reference, notes and source_id are unchanged',
      eqMoney(keepAfter.amount, keep.amount) && dateStr(keepAfter.payment_date) === dateStr(keep.payment_date) &&
      keepAfter.method === keep.method && keepAfter.reference === keep.reference &&
      keepAfter.notes === keep.notes && String(keepAfter.source_id) === String(keep.source_id),
      { amount: money(keepAfter.amount), date: dateStr(keepAfter.payment_date), method: keepAfter.method });
    p(`exactly ONE R${OBSERVED_AMOUNT.toFixed(2)} payment now exists on this chain`,
      (await client.query(
        `SELECT COUNT(*)::int AS n FROM rel_payments WHERE ABS(amount - $1::numeric) < 0.005
          AND ((owner_type='quote' AND owner_id=$2) OR (owner_type='job' AND owner_id=$3) OR (owner_type='invoice' AND owner_id=$4))`,
        [OBSERVED_AMOUNT, quote.id, job.id, inv.id])).rows[0].n === 1);
    p(`${INVOICE_NUMBER} total unchanged at ${OBSERVED_INVOICE_TOTAL.toFixed(2)}`,
      eqMoney(invTotalAfter, invTotalNow) && eqMoney(invTotalAfter, OBSERVED_INVOICE_TOTAL), money(invTotalAfter));
    p(`${INVOICE_NUMBER} paid = ${EXPECTED_PAID_AFTER.toFixed(2)} (derived)`, eqMoney(paidAfter, EXPECTED_PAID_AFTER), money(paidAfter));
    p(`${INVOICE_NUMBER} balance = ${EXPECTED_BALANCE_AFTER.toFixed(2)} (derived)`, eqMoney(balanceAfter, EXPECTED_BALANCE_AFTER), money(balanceAfter));
    p(`${INVOICE_NUMBER} status = '${EXPECTED_STATUS_AFTER}' (derived by recomputeOwnerPaymentStatus)`,
      invAfter.status === EXPECTED_STATUS_AFTER, invAfter.status);
    p(`${INVOICE_NUMBER} identity unchanged (number, issue date, job_id, quote_id, reference, company)`,
      invAfter.invoice_number === inv.invoice_number && String(invAfter.issue_date) === String(inv.issue_date) &&
      String(invAfter.job_id) === String(inv.job_id) && String(invAfter.quote_id) === String(inv.quote_id) &&
      invAfter.reference === inv.reference && invAfter.company_code === inv.company_code, invAfter.invoice_number);
    p(`${JOB_NUMBER} value unchanged`, eqMoney(jobAfter.value, job.value), money(jobAfter.value));
    p(`${JOB_NUMBER} now holds no payments, and its invoice_status reflects that`,
      (await paidAgainst(client, 'job', Number(job.id))) === 0, jobAfter.invoice_status);
    p(`${QUOTE_NUMBER} total unchanged and the quote row itself was not written`,
      eqMoney(quoteAfter.total, quote.total) && Number(quoteAfter.row_version) === Number(quote.row_version),
      { total: money(quoteAfter.total), row_version: quoteAfter.row_version });

    const fingerprintAfter = await untouchedFingerprint(client, KEEP_ID, DROP_ID, inv.id, job.id, quote.id);
    for (const key of Object.keys(fingerprintBefore) as Array<keyof typeof fingerprintBefore>) {
      const before = JSON.stringify(fingerprintBefore[key]);
      const after = JSON.stringify(fingerprintAfter[key]);
      // paymentCount legitimately drops by exactly one — the duplicate.
      if (key === 'paymentCount') {
        p('nothing unrelated changed: total payment count fell by exactly 1',
          Number(fingerprintAfter[key][0].n) === Number(fingerprintBefore[key][0].n) - 1,
          { before: fingerprintBefore[key][0].n, after: fingerprintAfter[key][0].n });
        continue;
      }
      p(`nothing unrelated changed: ${key}`, before === after, '');
    }

    log('');
    log('── POST-CHECKS (inside the transaction) ──────────────────────');
    for (const [label, okFlag, detail] of post) {
      log(`  ${okFlag ? 'PASS' : 'FAIL'}  ${label}${okFlag ? '' : '  →  ' + JSON.stringify(detail)}`);
    }
    const postFailed = post.filter(([, okFlag]) => !okFlag);
    if (postFailed.length > 0) throw new Error(`${postFailed.length} post-check(s) failed — rolling back, nothing is written.`);

    await client.query('COMMIT');
    committed = true;
    log('');
    log(`  COMMITTED. Backup id ${backupId}.`);

    // ── EXACT BEFORE/AFTER DIFF, re-read fresh after the commit ────────────
    const freshKeep = (await client.query('SELECT * FROM rel_payments WHERE id = $1', [KEEP_ID])).rows[0];
    const freshInv = (await client.query('SELECT * FROM rel_invoices WHERE id = $1', [inv.id])).rows[0];
    const freshJob = (await client.query('SELECT * FROM rel_jobs WHERE id = $1', [job.id])).rows[0];
    const freshPaid = await paidAgainst(client, 'invoice', inv.id);
    const freshTotal = await invoiceTotal(client, inv.id);

    log('');
    log('── EXACT BEFORE / AFTER ──────────────────────────────────────');
    log('');
    log(`  payment ${DROP_ID}   ${drop.owner_type} ${drop.owner_id}, ${money(drop.amount).toFixed(2)}, ${dateStr(drop.payment_date)}, ${drop.method}`);
    log(`                 ->  DELETED (duplicate capture of the same real payment)`);
    log('');
    log(`  payment ${KEEP_ID}   owner   ${keep.owner_type} ${keep.owner_id} (${QUOTE_NUMBER})  ->  ${freshKeep.owner_type} ${freshKeep.owner_id} (${INVOICE_NUMBER})`);
    log(`                 line_index  ${keep.line_index} -> ${freshKeep.line_index}`);
    log(`                 row_version ${keep.row_version} -> ${freshKeep.row_version}`);
    log(`                 amount      ${money(keep.amount).toFixed(2)} -> ${money(freshKeep.amount).toFixed(2)}   (unchanged)`);
    log(`                 date        ${dateStr(keep.payment_date)} -> ${dateStr(freshKeep.payment_date)}   (unchanged)`);
    log(`                 method      ${keep.method} -> ${freshKeep.method}   (unchanged)`);
    log(`                 reference   ${keep.reference ?? '(none)'} -> ${freshKeep.reference ?? '(none)'}   (unchanged)`);
    log(`                 notes       ${keep.notes ?? '(none)'} -> ${freshKeep.notes ?? '(none)'}   (unchanged)`);
    log('');
    log(`  ${INVOICE_NUMBER}      total   ${money(invTotalNow).toFixed(2)} -> ${money(freshTotal).toFixed(2)}   (unchanged)`);
    log(`  ${INVOICE_NUMBER}      paid    ${money(paidOnInvoiceNow).toFixed(2)} -> ${money(freshPaid).toFixed(2)}`);
    log(`  ${INVOICE_NUMBER}      balance ${money(invTotalNow - paidOnInvoiceNow).toFixed(2)} -> ${money(freshTotal - freshPaid).toFixed(2)}`);
    log(`  ${INVOICE_NUMBER}      status  ${inv.status} -> ${freshInv.status}`);
    log(`  ${JOB_NUMBER}     invoice_status ${job.invoice_status} -> ${freshJob.invoice_status}   (it no longer holds this payment)`);
    log(`  ${QUOTE_NUMBER}      total   ${money(quote.total).toFixed(2)} -> ${money(quoteAfter.total).toFixed(2)}   (unchanged, row not written)`);
    log('');
    log('  REPAIR COMPLETE. One real payment, recorded once, against the invoice.');
  } catch (err) {
    if (!committed) await client.query('ROLLBACK').catch(() => undefined);
    if (err instanceof AlreadyRepaired) {
      log('');
      log('── ALREADY REPAIRED ──────────────────────────────────────────');
      log(`  ${err.message}`);
      log('  Nothing was written. This is the safe, expected outcome of running');
      log('  the repair a second time.');
    } else if (err instanceof PreCheckFailure) {
      log('');
      log('── STOPPED ───────────────────────────────────────────────────');
      log(`  ${err.message}`);
      log('  NOTHING WAS WRITTEN. The transaction was rolled back.');
      process.exitCode = 1;
    } else {
      log('');
      log('── FAILED — ROLLED BACK ──────────────────────────────────────');
      log(`  ${err instanceof Error ? err.message : String(err)}`);
      log('  NOTHING WAS WRITTEN.');
      process.exitCode = 1;
    }
  } finally {
    client.release();
    await pool.end().catch(() => undefined);
    if (outPathArg) {
      const outPath = path.resolve(outPathArg);
      try {
        fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
        console.log('\nReport saved to: ' + outPath);
      } catch (e) {
        console.error('(Could not write the report file: ' + (e as Error).message + ' — the output above is complete.)');
      }
    }
  }
}

main().catch((err) => {
  console.error('\n[repair-audio-access-payment-dedup] Fatal error:', err);
  process.exitCode = 1;
});
