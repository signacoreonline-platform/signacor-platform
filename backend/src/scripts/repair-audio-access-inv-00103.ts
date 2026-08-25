/**
 * repair-audio-access-inv-00103.ts
 * SIGNACORE — ONE-RECORD PRODUCTION REPAIR
 * Audio Access:  SQ-00108  →  SNS-00110  →  INV-00103
 * Created 2026-08-25.
 *
 * ── WHAT THIS REPAIRS, AND ONLY THIS ────────────────────────────────────────
 * One confirmed historical case, established by a read-only diagnostic:
 *
 *   SQ-00108   total  R7,300.27
 *   SNS-00110  value  R7,300.27
 *   INV-00103  total  R3,506.39   ← wrong
 *
 * INV-00103 is definitively this job's invoice (job_id, job_number_raw,
 * reference and quote_id all agree, same company, no second invoice references
 * the job). Its total is exactly the job's lines priced WITHOUT their piece
 * count, and it carries no setup-fee line.
 *
 * TWO faults produced that number, and both are repaired here, in this order:
 *
 *   1. SNS-00110's five rel_job_line_items have `pieces = NULL`, because they
 *      were backfilled before migration 013 added the column. The original
 *      value (2) survives in preserved historical source. Until that is
 *      restored, even the corrected writer prices those lines at 1 piece —
 *      correctly, because a NULL genuinely means "not recorded".
 *   2. The invoice was written by the pre-repair writer, which dropped the
 *      piece count and the setup fee entirely.
 *
 * So: recover the piece count first, THEN rebuild the invoice's lines with the
 * currently deployed writer. Doing it the other way round would rebuild the
 * invoice from data that is still wrong.
 *
 * ── WHAT IT MUST NOT DO ─────────────────────────────────────────────────────
 * INV-00103 keeps its id, number, issue date, status, job_id, quote_id,
 * job_number_raw, reference and company. It is NEVER deleted and NEVER
 * replaced. SQ-00108 is not written to at all. SNS-00110's value, and every
 * line's description / qty / unit_price / inventory id / order, are not
 * written to. Payments and credit notes are not touched. No other job, quote
 * or invoice is read for repair or written to.
 *
 * ── SAFETY MODEL ────────────────────────────────────────────────────────────
 *   * DRY RUN BY DEFAULT. No writes happen without BOTH --apply AND an exact
 *     --confirm string.
 *   * Every pre-check is re-verified INSIDE the write transaction, after the
 *     rows are locked FOR UPDATE — so the state that was checked is provably
 *     the state that is written. A single failing check aborts the whole
 *     transaction; there is no partial repair.
 *   * The dry run prints an --apply command with the observed row_versions
 *     already filled in. Passing them pins the exact rows the plan was made
 *     against: if anything moved in between, the repair STOPS.
 *   * A full, scoped, recoverable backup of every affected row is written to
 *     platform_state_backups — the mechanism this codebase already uses before
 *     any destructive write — inside the same transaction, BEFORE any change.
 *   * Post-write verification runs inside the transaction too, and throws
 *     (→ ROLLBACK) on any discrepancy, including any evidence that an
 *     unrelated row changed.
 *   * Re-running after a successful repair is safely idempotent: the
 *     pre-checks recognise the repaired state and the script exits having
 *     written nothing.
 *
 * ── THE FINANCIAL TARGET IS DERIVED, NEVER TYPED ────────────────────────────
 * R7,300.27 appears in this file ONLY as a pre-check expectation (it is what
 * the diagnostic observed, so a different value means the data has moved and
 * the repair must stop) and as a final consistency assertion. Every amount
 * WRITTEN is computed by services.ts's writeInvoiceLinesFromJobTx from the
 * repaired job lines and the job's own setup fee. This script contains no
 * pricing logic of its own — deliberately, because a repair that
 * re-implements the logic it repairs towards is a second source of truth
 * waiting to drift.
 *
 * ── USAGE (PowerShell, from the repo root) ──────────────────────────────────
 *   cd backend
 *   $env:DATABASE_URL = "<connection string>"
 *
 *   # DRY RUN (default — reads and plans, writes nothing):
 *   npx ts-node --transpile-only src/scripts/repair-audio-access-inv-00103.ts
 *
 *   # APPLY (requires both flags; use the command the dry run prints):
 *   npx ts-node --transpile-only src/scripts/repair-audio-access-inv-00103.ts `
 *     --apply --confirm="REPAIR INV-00103 AUDIO ACCESS" `
 *     --expect-job-version=<n> --expect-invoice-version=<n>
 *
 *   Optional: --out <path>   also write the full report to a file
 */
import type { PoolClient } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import pool from '../db/pool';
import { writeInvoiceLinesFromJobTx } from '../relational/services';
import {
  classifyLineRecovery, findJsonDocument, findJsonLine,
  MIGRATION_013_FIELDS, MIGRATION_013_COLUMNS,
  RelationalLineSnapshot, RecoveryCandidate, Migration013Field,
  resolveDocument013ForInvoicing, effectivePiecesByLineId,
} from '../relational/migration013Recovery';

// ── IDENTITY OF THE ONE CASE ────────────────────────────────────────────────
const QUOTE_NUMBER = 'SQ-00108';
const JOB_NUMBER = 'SNS-00110';
const INVOICE_NUMBER = 'INV-00103';
const COMPANY_CODE = '2';
const REQUIRED_CONFIRM = 'REPAIR INV-00103 AUDIO ACCESS';

// ── WHAT THE READ-ONLY DIAGNOSTIC OBSERVED ──────────────────────────────────
// Used ONLY to prove nothing has moved since. Never written anywhere.
const OBSERVED_QUOTE_TOTAL = 7300.27;
const OBSERVED_JOB_VALUE = 7300.27;
const OBSERVED_INVOICE_TOTAL = 3506.39;
const OBSERVED_ITEM_LINE_COUNT = 5;
const OBSERVED_SETUP_FEE = 250.0;
const OBSERVED_DISCOUNT_PCT = 0;
const EXPECTED_RECOVERED_PIECES = 2;

/** The cent is the precision every document in this system states. */
const MONEY_TOLERANCE = 0.005;
const SETUP_FEE_DESCRIPTION = 'Design & Setup Fee';
const DISCOUNT_LINE_RE = /^Discount \(/;

const lines: string[] = [];
function log(msg = '') { lines.push(msg); console.log(msg); }
function money(n: unknown): number { return Math.round((Number(n) || 0) * 100) / 100; }
function eqMoney(a: unknown, b: unknown): boolean { return Math.abs(money(a) - money(b)) < MONEY_TOLERANCE; }
function norm(v: unknown): string { return (v === null || v === undefined) ? '' : String(v).trim().toUpperCase(); }
/** DATE columns arrive as JS Date objects; render them as plain YYYY-MM-DD so
 *  the operator-facing diff shows a date, not "Thu Aug 20". */
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

/** Every amount an invoice is worth, derived the one way this system derives
 *  it: from its own lines. rel_invoices deliberately stores no totals. */
async function invoiceTotals(client: PoolClient, invoiceId: number) {
  const r = (await client.query(
    `SELECT COALESCE(SUM(qty * unit_amount), 0) AS subtotal,
            COALESCE(SUM(CASE WHEN tax_type = '15%' THEN qty * unit_amount * 0.15 ELSE 0 END), 0) AS vat,
            COUNT(*)::int AS line_count
       FROM rel_invoice_line_items WHERE invoice_id = $1`,
    [invoiceId]
  )).rows[0];
  const subtotal = Number(r.subtotal);
  const vat = Number(r.vat);
  return { subtotal, vat, total: subtotal + vat, lineCount: r.line_count as number };
}

async function invoiceLineRows(client: PoolClient, invoiceId: number) {
  return (await client.query(
    `SELECT line_index, description, qty, unit_amount, account_code, tax_type
       FROM rel_invoice_line_items WHERE invoice_id = $1 ORDER BY line_index`,
    [invoiceId]
  )).rows;
}

async function jobLineRows(client: PoolClient, jobId: number) {
  return (await client.query(
    `SELECT id, line_index, description, qty, unit_price, unit, subtotal,
            inventory_item_id, inventory_source_id,
            pieces, sqm_l, sqm_w, complete_product_source_id, complete_product_linked, legacy_data
       FROM rel_job_line_items WHERE job_id = $1 ORDER BY line_index`,
    [jobId]
  )).rows;
}

/**
 * A fingerprint of every row this repair must NOT touch. Compared before and
 * after the write, inside the transaction: any difference is proof the repair
 * reached further than it was allowed to, and rolls the whole thing back.
 */
async function untouchedFingerprint(client: PoolClient, jobId: number, invoiceId: number, quoteId: number) {
  const q = async (sql: string, params: any[] = []) => (await client.query(sql, params)).rows;
  return {
    otherJobs: await q(
      `SELECT id, row_version, value, status, stage, invoice_num, invoice_created
         FROM rel_jobs WHERE id <> $1 ORDER BY id`, [jobId]),
    otherQuotes: await q(
      `SELECT id, row_version, total, subtotal, vat_amount, status FROM rel_quotes ORDER BY id`),
    otherInvoices: await q(
      `SELECT id, row_version, invoice_number, company_code, status, job_id, quote_id, reference
         FROM rel_invoices WHERE id <> $1 ORDER BY id`, [invoiceId]),
    otherJobLines: await q(
      `SELECT id, job_id, line_index, description, qty, unit_price, pieces
         FROM rel_job_line_items WHERE job_id <> $1 ORDER BY id`, [jobId]),
    otherQuoteLines: await q(
      `SELECT id, quote_id, line_index, description, qty, unit_price, pieces
         FROM rel_quote_line_items ORDER BY id`),
    otherInvoiceLines: await q(
      `SELECT id, invoice_id, line_index, description, qty, unit_amount
         FROM rel_invoice_line_items WHERE invoice_id <> $1 ORDER BY id`, [invoiceId]),
    allPayments: await q(
      `SELECT id, owner_type, owner_id, line_index, amount, payment_date, method, reference
         FROM rel_payments ORDER BY id`),
    allCreditNotes: await q(
      `SELECT id, credit_number, amount, used_amount, applied_to, status, company_code
         FROM rel_credit_notes ORDER BY id`),
    // The target quote is verified separately AND fingerprinted here, because
    // "SQ-00108 is not written to at all" is one of this repair's promises.
    targetQuote: await q(
      `SELECT id, row_version, quote_number, total, subtotal, vat_amount, setup_fee, discount_pct, status
         FROM rel_quotes WHERE id = $1`, [quoteId]),
    invoiceCount: await q(`SELECT COUNT(*)::int AS n FROM rel_invoices`),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const APPLY = argv.includes('--apply');
  const arg = (flag: string): string => {
    const a = argv.find((x) => x.startsWith(flag + '='));
    return a ? a.slice(flag.length + 1).replace(/^["']|["']$/g, '').trim() : '';
  };
  const confirm = arg('--confirm');
  const expectJobVersionRaw = arg('--expect-job-version');
  const expectInvoiceVersionRaw = arg('--expect-invoice-version');
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
    log(' SIGNACORE — ONE-RECORD REPAIR: AUDIO ACCESS');
    log(` ${QUOTE_NUMBER} -> ${JOB_NUMBER} -> ${INVOICE_NUMBER}  (company ${COMPANY_CODE})`);
    log('==============================================================');
    const who = (await client.query('SELECT current_database() AS db, current_user AS usr, now() AS at')).rows[0];
    log(` database : ${who.db}`);
    log(` user     : ${who.usr}`);
    log(` run at   : ${new Date(who.at).toISOString()}`);
    log(` mode     : ${APPLY ? 'APPLY (writes, but only if EVERY check passes)' : 'DRY RUN (writes nothing)'}`);
    log('');

    // Everything — including every read the plan is based on — happens inside
    // ONE transaction, with the target rows locked. In DRY RUN it is rolled
    // back at the end; in APPLY it is the same transaction that commits. That
    // is what makes "the state I checked" and "the state I wrote" the same
    // state, rather than two reads with a gap in between.
    await client.query('BEGIN');

    // ── locate and lock ─────────────────────────────────────────────────────
    const quoteRes = await client.query(
      `SELECT * FROM rel_quotes WHERE UPPER(BTRIM(quote_number)) = $1 ORDER BY id FOR UPDATE`, [QUOTE_NUMBER]);
    const jobRes = await client.query(
      `SELECT * FROM rel_jobs WHERE UPPER(BTRIM(job_number)) = $1 ORDER BY id FOR UPDATE`, [JOB_NUMBER]);
    const invRes = await client.query(
      `SELECT * FROM rel_invoices WHERE UPPER(BTRIM(invoice_number)) = $1 ORDER BY id FOR UPDATE`, [INVOICE_NUMBER]);

    // ── PRE-CHECKS 1-3: each record exists exactly once, in company 2 ───────
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
      throw new PreCheckFailure('the three records could not be resolved to exactly one row each — nothing further can be verified safely');
    }
    const quote = quoteRes.rows[0];
    const job = jobRes.rows[0];
    const inv = invRes.rows[0];

    const jobLinesBefore = await client.query(
      `SELECT * FROM rel_job_line_items WHERE job_id = $1 ORDER BY line_index FOR UPDATE`, [job.id]);
    await client.query(
      `SELECT id FROM rel_invoice_line_items WHERE invoice_id = $1 ORDER BY line_index FOR UPDATE`, [inv.id]);

    // ── PRE-CHECKS 4-8: linkage ────────────────────────────────────────────
    check('4', inv.job_id !== null && String(inv.job_id) === String(job.id),
      `${INVOICE_NUMBER}.job_id points to ${JOB_NUMBER}`, { job_id: inv.job_id, job: job.id });
    check('5', inv.quote_id !== null && String(inv.quote_id) === String(quote.id),
      `${INVOICE_NUMBER}.quote_id points to ${QUOTE_NUMBER}`, { quote_id: inv.quote_id, quote: quote.id });

    const otherRefs = await client.query(
      `SELECT id, invoice_number, status, job_id, job_number_raw, reference FROM rel_invoices
        WHERE id <> $1 AND COALESCE(status,'') <> 'void'
          AND ( job_id = $2
             OR UPPER(BTRIM(COALESCE(job_number_raw,''))) = $3
             OR UPPER(BTRIM(COALESCE(reference,'')))      = $3 )`,
      [inv.id, job.id, JOB_NUMBER]);
    check('6', otherRefs.rowCount === 0,
      `no second relational invoice references ${JOB_NUMBER}`, otherRefs.rows);

    check('7', norm(job.invoice_num) === INVOICE_NUMBER,
      `${JOB_NUMBER}.invoice_num is ${INVOICE_NUMBER}`, { invoice_num: job.invoice_num });
    check('8', job.invoice_created === true,
      `${JOB_NUMBER}.invoice_created is true`, { invoice_created: job.invoice_created });

    // ── PRE-CHECKS 9-12: the money, and the shape of the invoice ───────────
    check('9', eqMoney(quote.total, OBSERVED_QUOTE_TOTAL),
      `${QUOTE_NUMBER} total is still ${OBSERVED_QUOTE_TOTAL.toFixed(2)}`, { total: money(quote.total) });
    check('10', eqMoney(job.value, OBSERVED_JOB_VALUE),
      `${JOB_NUMBER} value is still ${OBSERVED_JOB_VALUE.toFixed(2)}`, { value: money(job.value) });

    const totalsBefore = await invoiceTotals(client, inv.id);
    const invLinesBefore = await invoiceLineRows(client, inv.id);
    const hasSetupFeeLine = invLinesBefore.some((l: any) => norm(l.description) === norm(SETUP_FEE_DESCRIPTION));
    const hasDiscountLine = invLinesBefore.some((l: any) => DISCOUNT_LINE_RE.test(String(l.description ?? '')));

    // Idempotency: recognise an ALREADY-REPAIRED record and stop cleanly,
    // rather than reporting the repair's own success as a scary failure.
    const alreadyRepaired =
      eqMoney(totalsBefore.total, job.value) && hasSetupFeeLine &&
      jobLinesBefore.rows.every((l: any) => l.pieces !== null);
    if (alreadyRepaired) {
      throw new AlreadyRepaired(
        `${INVOICE_NUMBER} already totals ${money(totalsBefore.total).toFixed(2)}, already carries its "${SETUP_FEE_DESCRIPTION}" line, ` +
        `and all ${jobLinesBefore.rowCount} ${JOB_NUMBER} lines already carry a piece count. This case has already been repaired.`
      );
    }

    check('11', eqMoney(totalsBefore.total, OBSERVED_INVOICE_TOTAL),
      `${INVOICE_NUMBER} total is still ${OBSERVED_INVOICE_TOTAL.toFixed(2)}`, { total: money(totalsBefore.total) });
    check('12', totalsBefore.lineCount === OBSERVED_ITEM_LINE_COUNT && !hasSetupFeeLine && !hasDiscountLine,
      `${INVOICE_NUMBER} still has exactly ${OBSERVED_ITEM_LINE_COUNT} item lines, no setup-fee line and no discount line`,
      { lineCount: totalsBefore.lineCount, hasSetupFeeLine, hasDiscountLine });

    // ── PRE-CHECKS 13-14: nothing financial has attached to this invoice ────
    const invPayments = await client.query(
      `SELECT id, amount, payment_date, method, reference FROM rel_payments
        WHERE owner_type = 'invoice' AND owner_id = $1 ORDER BY id`, [inv.id]);
    check('13', invPayments.rowCount === 0,
      `no payment has been recorded directly against ${INVOICE_NUMBER}`, invPayments.rows);

    const creditNotes = await client.query(
      `SELECT id, credit_number, amount, used_amount, applied_to FROM rel_credit_notes
        WHERE applied_to IS NOT NULL AND UPPER(BTRIM(applied_to)) LIKE '%' || $1 || '%'`, [INVOICE_NUMBER]);
    check('14', creditNotes.rowCount === 0,
      `no credit note has been applied against ${INVOICE_NUMBER}`, creditNotes.rows);

    // ── PRE-CHECK 15: the historical piece count is deterministically 2 ─────
    // Delegated in full to migration013Recovery's classifier — the same
    // deterministic identity-then-verify rules, unchanged, so this repair
    // cannot be more permissive than the analysis that justified it.
    const stateRes = await client.query('SELECT data FROM platform_state WHERE id = 1');
    const stateData = stateRes.rowCount ? stateRes.rows[0].data : {};
    const jsonJobs = Array.isArray(stateData?.jobs) ? stateData.jobs : [];
    const foundDoc = findJsonDocument(jsonJobs, job.source_id, job.job_number, String(job.company_code), 'num');
    const jsonLines = foundDoc.record && Array.isArray(foundDoc.record.lines) ? foundDoc.record.lines : [];

    interface PlannedLine {
      lineId: number; lineIndex: number; description: string | null;
      proposed: Partial<Record<Migration013Field, number | string | boolean>>;
      classification: string; reason: string; sourceIdentity: string | null;
    }
    const planned: PlannedLine[] = [];
    let allSafeWithPieces2 = jobLinesBefore.rowCount === OBSERVED_ITEM_LINE_COUNT;

    for (const row of jobLinesBefore.rows) {
      const rel: RelationalLineSnapshot = {
        lineId: Number(row.id), lineIndex: Number(row.line_index), description: row.description,
        qty: Number(row.qty), unitPrice: Number(row.unit_price), inventorySourceId: row.inventory_source_id,
        pieces: row.pieces === null ? null : Number(row.pieces),
        sqmL: row.sqm_l === null ? null : Number(row.sqm_l),
        sqmW: row.sqm_w === null ? null : Number(row.sqm_w),
        cpId: row.complete_product_source_id, cpLinked: row.complete_product_linked,
      };
      const candidates: RecoveryCandidate[] = [];
      const legacy = row.legacy_data;
      if (legacy && typeof legacy === 'object' && !Array.isArray(legacy) && Object.keys(legacy).length > 0) {
        candidates.push({ origin: 'legacy_data', identity: `rel_job_line_items.legacy_data (line id ${rel.lineId})`, line: legacy });
      }
      if (foundDoc.ambiguous) {
        candidates.push({ origin: 'platform_state_json', identity: foundDoc.identity, line: null, ambiguous: true, ambiguityReason: foundDoc.reason });
      } else if (foundDoc.record) {
        const jl = findJsonLine(jsonLines, rel);
        if (jl.ambiguous) {
          candidates.push({ origin: 'platform_state_json', identity: `${foundDoc.identity} / ${jl.identity}`, line: null, ambiguous: true, ambiguityReason: jl.reason });
        } else if (jl.line) {
          candidates.push({ origin: 'platform_state_json', identity: `${foundDoc.identity} / ${jl.identity}`, line: jl.line });
        }
      }
      const verdict = classifyLineRecovery(rel, candidates);
      planned.push({
        lineId: rel.lineId, lineIndex: rel.lineIndex, description: rel.description,
        proposed: verdict.proposed, classification: verdict.classification,
        reason: verdict.reason, sourceIdentity: verdict.sourceIdentity,
      });
      if (verdict.classification !== 'SAFE_TO_RECOVER' || Number(verdict.proposed.pieces) !== EXPECTED_RECOVERED_PIECES) {
        allSafeWithPieces2 = false;
      }
    }
    check('15', allSafeWithPieces2,
      `all ${OBSERVED_ITEM_LINE_COUNT} ${JOB_NUMBER} lines resolve deterministically to pieces = ${EXPECTED_RECOVERED_PIECES}`,
      planned.map((p) => ({ line: p.lineIndex, classification: p.classification, pieces: p.proposed.pieces })));

    // ── ADDITIONAL GUARDS 16-19 ────────────────────────────────────────────
    // Not in the brief's list of 15, but each one is a way the write could be
    // wrong even when all 15 pass, so each is enforced the same way.
    check('16', eqMoney(job.setup_fee, OBSERVED_SETUP_FEE) && eqMoney(quote.setup_fee, OBSERVED_SETUP_FEE),
      `job and quote both still carry a setup fee of ${OBSERVED_SETUP_FEE.toFixed(2)}`,
      { job: money(job.setup_fee), quote: money(quote.setup_fee) });
    check('17', eqMoney(job.discount_pct, OBSERVED_DISCOUNT_PCT),
      `${JOB_NUMBER} still carries no discount (so no discount line is expected)`, { discount_pct: job.discount_pct });
    check('18', norm(inv.status) !== 'VOID',
      `${INVOICE_NUMBER} is not void`, { status: inv.status });
    check('19', jobLinesBefore.rows.every((l: any) => l.pieces === null),
      `every ${JOB_NUMBER} line still has pieces = NULL — nothing existing will be overwritten`,
      jobLinesBefore.rows.map((l: any) => l.pieces));

    // ── operator-supplied row_version pins ─────────────────────────────────
    if (expectJobVersionRaw !== '') {
      check('V1', Number(expectJobVersionRaw) === Number(job.row_version),
        `${JOB_NUMBER} row_version still ${expectJobVersionRaw} (as seen by the dry run)`,
        { expected: expectJobVersionRaw, actual: job.row_version });
    }
    if (expectInvoiceVersionRaw !== '') {
      check('V2', Number(expectInvoiceVersionRaw) === Number(inv.row_version),
        `${INVOICE_NUMBER} row_version still ${expectInvoiceVersionRaw} (as seen by the dry run)`,
        { expected: expectInvoiceVersionRaw, actual: inv.row_version });
    }

    // ── report the pre-checks ──────────────────────────────────────────────
    log('── PRE-CHECKS ────────────────────────────────────────────────');
    for (const c of checks) {
      log(`  ${c.ok ? 'PASS' : 'FAIL'}  [${c.n}] ${c.label}${c.ok ? '' : '  →  ' + c.detail}`);
    }
    const failed = checks.filter((c) => !c.ok);
    log('');
    log(`  ${checks.length - failed.length} passed, ${failed.length} failed`);
    log('');
    if (failed.length > 0) {
      throw new PreCheckFailure(`${failed.length} pre-check(s) failed — see above. Nothing was written.`);
    }

    // ── THE PLAN ───────────────────────────────────────────────────────────
    log('── CURRENT STATE ─────────────────────────────────────────────');
    log(`  ${QUOTE_NUMBER}  rel id ${quote.id}  row_version ${quote.row_version}  total ${money(quote.total).toFixed(2)}`);
    log(`  ${JOB_NUMBER}  rel id ${job.id}  row_version ${job.row_version}  value ${money(job.value).toFixed(2)}  setup_fee ${money(job.setup_fee).toFixed(2)}  discount ${Number(job.discount_pct)}%`);
    log(`  ${INVOICE_NUMBER}  rel id ${inv.id}  row_version ${inv.row_version}  subtotal ${money(totalsBefore.subtotal).toFixed(2)}  VAT ${money(totalsBefore.vat).toFixed(2)}  total ${money(totalsBefore.total).toFixed(2)}`);
    log('');
    log(`  ${JOB_NUMBER} lines (before):`);
    for (const l of jobLinesBefore.rows) {
      log(`    [${l.line_index}] ${l.description}  qty ${Number(l.qty)}  pieces ${l.pieces === null ? 'NULL' : Number(l.pieces)}  unit ${money(l.unit_price).toFixed(2)}`);
    }
    log('');
    log(`  ${INVOICE_NUMBER} lines (before):`);
    for (const l of invLinesBefore) {
      log(`    [${l.line_index}] ${l.description}  qty ${Number(l.qty)}  unit_amount ${money(l.unit_amount).toFixed(2)}  ${l.tax_type}  = ${money(Number(l.qty) * Number(l.unit_amount)).toFixed(2)}`);
    }
    log('');
    log('── PLANNED CHANGES ───────────────────────────────────────────');
    log(`  STEP 1 — fill ONLY the NULL migration-013 columns on ${JOB_NUMBER}'s ${planned.length} lines:`);
    for (const p of planned) {
      const fields = MIGRATION_013_FIELDS.filter((f) => p.proposed[f] !== undefined)
        .map((f) => `${MIGRATION_013_COLUMNS[f]} = ${JSON.stringify(p.proposed[f])}`);
      log(`    [${p.lineIndex}] ${p.description}`);
      log(`         ${fields.length ? fields.join(', ') : '(nothing to fill)'}`);
      log(`         source: ${p.sourceIdentity}`);
    }
    log('  Nothing else on those rows is written: qty, unit_price, description, unit,');
    log('  subtotal, inventory ids and line order are all untouched.');
    log('');
    log(`  STEP 2 — rebuild ONLY ${INVOICE_NUMBER}'s line items with services.ts's`);
    log('           writeInvoiceLinesFromJobTx (the deployed writer itself, not a copy),');
    log('           from the repaired job lines and the job\'s own setup fee.');
    log(`           Expected: ${OBSERVED_ITEM_LINE_COUNT} item lines + 1 "${SETUP_FEE_DESCRIPTION}" line, no discount line.`);
    log('           The invoice header keeps its id, number, issue date, status, job_id,');
    log('           quote_id, job_number_raw, reference and company; only row_version moves.');
    log('');

    if (!APPLY) {
      log('── DRY RUN COMPLETE — NOTHING WAS WRITTEN ────────────────────');
      log('');
      log('  To apply this exact plan, against these exact rows:');
      log('');
      log('    npx ts-node --transpile-only src/scripts/repair-audio-access-inv-00103.ts `');
      log(`      --apply --confirm="${REQUIRED_CONFIRM}" \``);
      log(`      --expect-job-version=${job.row_version} --expect-invoice-version=${inv.row_version}`);
      log('');
      log('  The two --expect-*-version pins are what make this a plan for THESE rows:');
      log('  if either record changes before you run it, the repair stops instead of');
      log('  writing against a state nobody reviewed.');
      await client.query('ROLLBACK');
      return;
    }

    if (confirm !== REQUIRED_CONFIRM) {
      throw new PreCheckFailure(
        `--apply was given but --confirm did not exactly match "${REQUIRED_CONFIRM}". Refusing to change anything.`);
    }

    // ══ WRITE ══════════════════════════════════════════════════════════════
    log('── APPLYING ──────────────────────────────────────────────────');

    const fingerprintBefore = await untouchedFingerprint(client, job.id, inv.id, quote.id);

    // ── BACKUP, before any change, in the same transaction ─────────────────
    const backupPayload = {
      repair: 'repair-audio-access-inv-00103',
      capturedAt: new Date(who.at).toISOString(),
      quote: { header: quote, lines: (await client.query(`SELECT * FROM rel_quote_line_items WHERE quote_id = $1 ORDER BY line_index`, [quote.id])).rows },
      job: { header: job, lines: jobLinesBefore.rows },
      invoice: { header: inv, lines: invLinesBefore, derivedTotals: totalsBefore },
      payments: (await client.query(
        `SELECT * FROM rel_payments
          WHERE (owner_type = 'invoice' AND owner_id = $1)
             OR (owner_type = 'job'     AND owner_id = $2)
             OR (owner_type = 'quote'   AND owner_id = $3)
          ORDER BY owner_type, line_index`, [inv.id, job.id, quote.id])).rows,
      creditNotes: (await client.query(
        `SELECT * FROM rel_credit_notes
          WHERE applied_to IS NOT NULL
            AND ( UPPER(BTRIM(applied_to)) LIKE '%' || $1 || '%'
               OR UPPER(BTRIM(applied_to)) LIKE '%' || $2 || '%' )`, [INVOICE_NUMBER, JOB_NUMBER])).rows,
    };
    const serialized = JSON.stringify(backupPayload);
    const backupRes = await client.query(
      `INSERT INTO platform_state_backups (data, reason, data_size_bytes, source, record_counts)
       VALUES ($1::jsonb, 'before-repair-audio-access-inv-00103', $2, $3, $4::jsonb)
       RETURNING id, created_at`,
      [serialized, Buffer.byteLength(serialized, 'utf8'),
       'src/scripts/repair-audio-access-inv-00103.ts (manual run)',
       JSON.stringify({
         quoteLines: backupPayload.quote.lines.length, jobLines: backupPayload.job.lines.length,
         invoiceLines: backupPayload.invoice.lines.length, payments: backupPayload.payments.length,
         creditNotes: backupPayload.creditNotes.length,
       })]
    );
    const backupId = backupRes.rows[0].id;
    log(`  BACKUP  platform_state_backups id = ${backupId}  (${backupRes.rows[0].created_at})`);
    log(`          reason 'before-repair-audio-access-inv-00103' — holds ${QUOTE_NUMBER}, ${JOB_NUMBER} and`);
    log(`          ${INVOICE_NUMBER} headers + lines, plus every related payment and credit note.`);

    // ── STEP 1: recover the migration-013 fields, NULL columns only ────────
    let filledCount = 0;
    for (const p of planned) {
      for (const f of MIGRATION_013_FIELDS) {
        const v = p.proposed[f];
        if (v === undefined) continue;
        const col = MIGRATION_013_COLUMNS[f];
        // `AND <col> IS NULL` is the invariant, restated at the moment of the
        // write: an existing value can never be overwritten, even if something
        // changed between the check and here.
        const upd = await client.query(
          `UPDATE rel_job_line_items SET ${col} = $2 WHERE id = $1 AND ${col} IS NULL`, [p.lineId, v]);
        filledCount += upd.rowCount ?? 0;
      }
    }
    log(`  STEP 1  filled ${filledCount} previously-NULL migration-013 column value(s) across ${planned.length} job lines.`);

    // The job row itself: only row_version/updated_at, so any editor holding
    // this job open gets a clean 409 rather than silently writing stale lines
    // back over the recovery. value/status/stage/invoice_* are untouched.
    const jobBump = await client.query(
      `UPDATE rel_jobs SET row_version = row_version + 1, updated_at = NOW()
        WHERE id = $1 AND row_version = $2 RETURNING row_version`,
      [job.id, job.row_version]);
    if (jobBump.rowCount !== 1) throw new Error(`${JOB_NUMBER} changed under us (row_version moved from ${job.row_version}) — rolling back`);

    // ── STEP 2: rebuild the invoice's lines with the DEPLOYED writer ───────
    const jobLinesAfterRecovery = await jobLineRows(client, job.id);
    const jobRowAfterRecovery = (await client.query('SELECT * FROM rel_jobs WHERE id = $1', [job.id])).rows[0];
    await client.query('DELETE FROM rel_invoice_line_items WHERE invoice_id = $1', [inv.id]);
    // 2026-08-25 (HISTORICAL PIECES PROTECTION): the writer no longer reads
    // `pieces` off the source line — the effective count is resolved by
    // migration013Recovery and passed in. Resolved HERE, after STEP 1 has
    // filled the columns, so every line reports piecesSource 'column' and this
    // rebuild uses the values this repair just recovered, not a second reading
    // of the historical sources.
    const piecesAfterRecovery = effectivePiecesByLineId(
      await resolveDocument013ForInvoicing(client, 'job', Number(job.id))
    );
    await writeInvoiceLinesFromJobTx(client, Number(inv.id), jobLinesAfterRecovery, jobRowAfterRecovery, piecesAfterRecovery);
    log(`  STEP 2  ${INVOICE_NUMBER}'s line items rebuilt by services.ts writeInvoiceLinesFromJobTx.`);

    const invBump = await client.query(
      `UPDATE rel_invoices SET row_version = row_version + 1, updated_at = NOW()
        WHERE id = $1 AND row_version = $2 RETURNING row_version`,
      [inv.id, inv.row_version]);
    if (invBump.rowCount !== 1) throw new Error(`${INVOICE_NUMBER} changed under us (row_version moved from ${inv.row_version}) — rolling back`);

    // ══ POST-CHECK, INSIDE THE TRANSACTION ═════════════════════════════════
    const totalsAfter = await invoiceTotals(client, inv.id);
    const invLinesAfter = await invoiceLineRows(client, inv.id);
    const jobLinesAfter = await jobLineRows(client, job.id);
    const jobAfter = (await client.query('SELECT * FROM rel_jobs WHERE id = $1', [job.id])).rows[0];
    const quoteAfter = (await client.query('SELECT * FROM rel_quotes WHERE id = $1', [quote.id])).rows[0];
    const invAfter = (await client.query('SELECT * FROM rel_invoices WHERE id = $1', [inv.id])).rows[0];

    const post: Array<[string, boolean, unknown]> = [];
    const p = (label: string, ok: boolean, detail: unknown = '') => post.push([label, ok, detail]);

    p(`${QUOTE_NUMBER} total unchanged at ${OBSERVED_QUOTE_TOTAL.toFixed(2)}`,
      eqMoney(quoteAfter.total, quote.total) && eqMoney(quoteAfter.total, OBSERVED_QUOTE_TOTAL), money(quoteAfter.total));
    p(`${QUOTE_NUMBER} not written to at all (row_version unchanged)`,
      Number(quoteAfter.row_version) === Number(quote.row_version), { before: quote.row_version, after: quoteAfter.row_version });
    p(`${JOB_NUMBER} value unchanged at ${OBSERVED_JOB_VALUE.toFixed(2)}`,
      eqMoney(jobAfter.value, job.value) && eqMoney(jobAfter.value, OBSERVED_JOB_VALUE), money(jobAfter.value));
    p(`${JOB_NUMBER} status/stage/invoice linkage unchanged`,
      jobAfter.status === job.status && Number(jobAfter.stage) === Number(job.stage) &&
      norm(jobAfter.invoice_num) === norm(job.invoice_num) && jobAfter.invoice_created === job.invoice_created &&
      norm(jobAfter.invoice_status) === norm(job.invoice_status),
      { status: jobAfter.status, stage: jobAfter.stage, invoice_num: jobAfter.invoice_num });
    p(`all ${OBSERVED_ITEM_LINE_COUNT} ${JOB_NUMBER} lines now carry pieces = ${EXPECTED_RECOVERED_PIECES}`,
      jobLinesAfter.length === OBSERVED_ITEM_LINE_COUNT &&
      jobLinesAfter.every((l: any) => Number(l.pieces) === EXPECTED_RECOVERED_PIECES),
      jobLinesAfter.map((l: any) => l.pieces));
    p(`${JOB_NUMBER} line descriptions, qty, unit_price, inventory ids and order untouched`,
      jobLinesAfter.length === jobLinesBefore.rows.length &&
      jobLinesAfter.every((a: any, i: number) => {
        const b = jobLinesBefore.rows[i];
        return Number(a.line_index) === Number(b.line_index) && a.description === b.description &&
          eqMoney(a.qty, b.qty) && eqMoney(a.unit_price, b.unit_price) &&
          String(a.inventory_item_id) === String(b.inventory_item_id) &&
          String(a.inventory_source_id) === String(b.inventory_source_id);
      }), '');
    p(`${INVOICE_NUMBER} has exactly ${OBSERVED_ITEM_LINE_COUNT + 1} lines (${OBSERVED_ITEM_LINE_COUNT} item + 1 "${SETUP_FEE_DESCRIPTION}")`,
      totalsAfter.lineCount === OBSERVED_ITEM_LINE_COUNT + 1 &&
      invLinesAfter.filter((l: any) => norm(l.description) === norm(SETUP_FEE_DESCRIPTION)).length === 1,
      invLinesAfter.map((l: any) => l.description));
    p(`${INVOICE_NUMBER} has no discount line (job discount is ${OBSERVED_DISCOUNT_PCT}%)`,
      invLinesAfter.every((l: any) => !DISCOUNT_LINE_RE.test(String(l.description ?? ''))), '');
    // THE financial assertion. The target is the JOB's own value — derived —
    // and only then cross-checked against what the diagnostic observed.
    p(`${INVOICE_NUMBER} total now equals the job value (derived, not typed)`,
      eqMoney(totalsAfter.total, jobAfter.value), { invoice: money(totalsAfter.total), job: money(jobAfter.value) });
    p(`and that derived total agrees with the diagnostic's ${OBSERVED_QUOTE_TOTAL.toFixed(2)}`,
      eqMoney(totalsAfter.total, OBSERVED_QUOTE_TOTAL), money(totalsAfter.total));
    p(`${INVOICE_NUMBER} identity unchanged (id, number, issue date, status, job_id, quote_id, job_number_raw, reference, company)`,
      String(invAfter.id) === String(inv.id) && invAfter.invoice_number === inv.invoice_number &&
      String(invAfter.issue_date) === String(inv.issue_date) && invAfter.status === inv.status &&
      String(invAfter.job_id) === String(inv.job_id) && String(invAfter.quote_id) === String(inv.quote_id) &&
      invAfter.job_number_raw === inv.job_number_raw && invAfter.reference === inv.reference &&
      invAfter.company_code === inv.company_code,
      { number: invAfter.invoice_number, status: invAfter.status, reference: invAfter.reference });

    const fingerprintAfter = await untouchedFingerprint(client, job.id, inv.id, quote.id);
    for (const key of Object.keys(fingerprintBefore) as Array<keyof typeof fingerprintBefore>) {
      p(`nothing unrelated changed: ${key}`,
        JSON.stringify(fingerprintBefore[key]) === JSON.stringify(fingerprintAfter[key]), '');
    }

    log('');
    log('── POST-CHECKS (inside the transaction) ──────────────────────');
    for (const [label, okFlag, detail] of post) {
      log(`  ${okFlag ? 'PASS' : 'FAIL'}  ${label}${okFlag ? '' : '  →  ' + JSON.stringify(detail)}`);
    }
    const postFailed = post.filter(([, okFlag]) => !okFlag);
    if (postFailed.length > 0) {
      throw new Error(`${postFailed.length} post-check(s) failed — rolling back, nothing is written.`);
    }

    await client.query('COMMIT');
    committed = true;
    log('');
    log(`  COMMITTED. Backup id ${backupId}.`);

    // ── EXACT BEFORE/AFTER DIFF, re-read fresh after the commit ────────────
    const freshInv = (await client.query('SELECT * FROM rel_invoices WHERE id = $1', [inv.id])).rows[0];
    const freshTotals = await invoiceTotals(client, inv.id);
    const freshInvLines = await invoiceLineRows(client, inv.id);
    const freshJobLines = await jobLineRows(client, job.id);
    const freshJob = (await client.query('SELECT * FROM rel_jobs WHERE id = $1', [job.id])).rows[0];
    const freshQuote = (await client.query('SELECT * FROM rel_quotes WHERE id = $1', [quote.id])).rows[0];

    log('');
    log('── EXACT BEFORE / AFTER ──────────────────────────────────────');
    log('');
    log(`  ${QUOTE_NUMBER}      total   ${money(quote.total).toFixed(2)}  ->  ${money(freshQuote.total).toFixed(2)}   (unchanged)`);
    log(`  ${JOB_NUMBER}     value   ${money(job.value).toFixed(2)}  ->  ${money(freshJob.value).toFixed(2)}   (unchanged)`);
    log(`  ${INVOICE_NUMBER}     subtotal ${money(totalsBefore.subtotal).toFixed(2)}  ->  ${money(freshTotals.subtotal).toFixed(2)}`);
    log(`  ${INVOICE_NUMBER}     VAT      ${money(totalsBefore.vat).toFixed(2)}  ->  ${money(freshTotals.vat).toFixed(2)}`);
    log(`  ${INVOICE_NUMBER}     TOTAL    ${money(totalsBefore.total).toFixed(2)}  ->  ${money(freshTotals.total).toFixed(2)}`);
    log('');
    log(`  ${JOB_NUMBER} lines — pieces only:`);
    for (let i = 0; i < freshJobLines.length; i++) {
      const b = jobLinesBefore.rows[i];
      const a = freshJobLines[i];
      log(`    [${a.line_index}] ${a.description}`);
      log(`         pieces ${b.pieces === null ? 'NULL' : Number(b.pieces)} -> ${Number(a.pieces)}   qty ${Number(a.qty)} (unchanged)   unit ${money(a.unit_price).toFixed(2)} (unchanged)`);
    }
    log('');
    log(`  ${INVOICE_NUMBER} lines — before:`);
    for (const l of invLinesBefore) {
      log(`    [${l.line_index}] ${l.description}  qty ${Number(l.qty)} @ ${money(l.unit_amount).toFixed(2)} = ${money(Number(l.qty) * Number(l.unit_amount)).toFixed(2)}`);
    }
    log(`  ${INVOICE_NUMBER} lines — after:`);
    for (const l of freshInvLines) {
      log(`    [${l.line_index}] ${l.description}  qty ${Number(l.qty)} @ ${money(l.unit_amount).toFixed(2)} = ${money(Number(l.qty) * Number(l.unit_amount)).toFixed(2)}`);
    }
    log('');
    log(`  ${INVOICE_NUMBER} header — id ${freshInv.id}, number ${freshInv.invoice_number}, issue ${dateStr(freshInv.issue_date)}, due ${dateStr(freshInv.due_date)},`);
    log(`         status ${freshInv.status}, job_id ${freshInv.job_id}, quote_id ${freshInv.quote_id},`);
    log(`         job_number_raw ${freshInv.job_number_raw}, reference ${freshInv.reference}, company ${freshInv.company_code}`);
    log(`         row_version ${inv.row_version} -> ${freshInv.row_version}   (the only header field written)`);
    log('');
    log('  REPAIR COMPLETE.');
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
  console.error('\n[repair-audio-access-inv-00103] Fatal error:', err);
  process.exitCode = 1;
});
