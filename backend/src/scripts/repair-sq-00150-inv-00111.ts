/**
 * repair-sq-00150-inv-00111.ts — ONE-RECORD REPAIR, SQ-00150 -> INV-00111
 * Created 2026-08-25.
 *
 * ── THE CASE ────────────────────────────────────────────────────────────────
 * A READ-ONLY production diagnostic established that INV-00111 (rel id 81) was
 * created through the relational direct "Create Invoice from Quote" path from
 * SQ-00150 (rel id 371, company 2) and came out at R4,542.50 against a quote of
 * R15,582.50.
 *
 * The cause is not the writer's arithmetic. It is that the quote's R1,600 line
 * is a pre-migration-013 row: its `pieces` column is NULL, not because the line
 * never had a piece count but because the column did not exist when the row was
 * backfilled. The writer read that NULL as 1 and billed 1 x 2 x R1,600 = R3,200
 * where the line is really 4 x 2 x R1,600 = R12,800.
 *
 * The historical value was never destroyed — it survives in the preserved
 * records migration013Recovery already knows how to match deterministically
 * (pieces = 4, sqm_l = 2000, sqm_w = 1000).
 *
 * ── WHAT THIS SCRIPT DOES, AND ONLY THIS ────────────────────────────────────
 *   STEP 1  Fills ONLY the currently-NULL migration-013 columns on SQ-00150's
 *           own lines, and only where migration013Recovery classifies the line
 *           SAFE_TO_RECOVER. A non-NULL value is never overwritten. qty,
 *           unit_price, description, unit, subtotal, inventory ids and line
 *           order are not touched. The quote's own header — total, subtotal,
 *           VAT, setup fee, discount, customer, company, status — is not
 *           touched either; only row_version/updated_at move, so any editor
 *           holding SQ-00150 open gets a clean 409 instead of silently writing
 *           its stale lines back over the recovery.
 *   STEP 2  Rebuilds ONLY INV-00111's line items, with the DEPLOYED
 *           Quote -> Invoice writer (services.ts's writeQuoteInvoiceLinesTx —
 *           the same function createInvoiceFromQuote calls), from the repaired
 *           quote. Invoice id 81 and the number INV-00111 are preserved
 *           exactly; no replacement invoice is created, and none is deleted.
 *
 * ── THE FINANCIAL TARGET IS DERIVED, NEVER TYPED ────────────────────────────
 * R15,582.50 appears here ONLY as a pre-check expectation (it is what the
 * diagnostic observed, so a different value means the data has moved and this
 * repair must stop) and as a final cross-check. Every amount actually written
 * is computed by the deployed writer from the repaired source data. Nothing
 * sets a total.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────
 *   * DRY RUN BY DEFAULT. No write happens without BOTH --apply AND an exact
 *     --confirm string.
 *   * ONE transaction. Every read the plan is based on happens inside it, with
 *     the target rows locked FOR UPDATE, so "the state I checked" and "the
 *     state I wrote" are the same state.
 *   * The dry run prints the --apply command with the observed row_versions
 *     already filled in. Passing them pins the exact rows the plan was made
 *     against: if anything moved in between, the repair STOPS.
 *   * A full, scoped, recoverable backup of every affected row is written to
 *     platform_state_backups — the mechanism this codebase already uses before
 *     any destructive write — inside the same transaction, BEFORE any change.
 *   * Post-write verification runs inside the transaction too, and throws
 *     (-> ROLLBACK) on any discrepancy, including evidence that an unrelated
 *     row changed.
 *   * Re-running after a successful repair is safely idempotent: the
 *     pre-checks recognise the repaired state and it exits having written
 *     nothing.
 *
 * ── ONE MATCHING ALGORITHM ──────────────────────────────────────────────────
 * The historical values are proved by migration013Recovery's own
 * resolveDocument013ForInvoicing — the same function invoice creation itself
 * now consults — not by a copy of its rules living here. This repair therefore
 * cannot be more permissive than the protection that supersedes it.
 *
 * ── HOW TO RUN ──────────────────────────────────────────────────────────────
 *   # DRY RUN (default — reads and plans, writes nothing):
 *   cd backend
 *   $env:DATABASE_URL = "<connection string>"
 *   npx ts-node --transpile-only src/scripts/repair-sq-00150-inv-00111.ts
 *
 *   # APPLY (only after reviewing the dry run; use the command it prints):
 *   npx ts-node --transpile-only src/scripts/repair-sq-00150-inv-00111.ts `
 *     --apply --confirm="REPAIR INV-00111 SQ-00150" `
 *     --expect-quote-version=<n> --expect-invoice-version=<n>
 */
import * as fs from 'fs';
import * as path from 'path';
import { PoolClient } from 'pg';
import pool from '../db/pool';
import { writeQuoteInvoiceLinesTx } from '../relational/services';
import {
  MIGRATION_013_FIELDS, MIGRATION_013_COLUMNS, Migration013Field,
  resolveDocument013ForInvoicing, effectivePiecesByLineId, LineResolution013,
} from '../relational/migration013Recovery';

// ── IDENTITY OF THE ONE CASE ────────────────────────────────────────────────
const QUOTE_NUMBER = 'SQ-00150';
const INVOICE_NUMBER = 'INV-00111';
const COMPANY_CODE = '2';
const EXPECTED_QUOTE_ID = 371;
const EXPECTED_INVOICE_ID = 81;
const REQUIRED_CONFIRM = 'REPAIR INV-00111 SQ-00150';

// ── WHAT THE READ-ONLY DIAGNOSTIC OBSERVED ──────────────────────────────────
// Used ONLY to prove nothing has moved since. Never written anywhere.
const OBSERVED_QUOTE_TOTAL = 15582.50;
const OBSERVED_INVOICE_TOTAL = 4542.50;
const OBSERVED_SETUP_FEE = 250.0;
const OBSERVED_DISCOUNT_PCT = 0;
const AFFECTED_LINE_QTY = 2;
const AFFECTED_LINE_UNIT_PRICE = 1600.0;
const EXPECTED_RECOVERED_PIECES = 4;
const EXPECTED_RECOVERED_SQM_L = 2000;
const EXPECTED_RECOVERED_SQM_W = 1000;

/** The cent is the precision every document in this system states. */
const MONEY_TOLERANCE = 0.005;
const SETUP_FEE_DESCRIPTION = 'Design & Setup Fee';
const DISCOUNT_LINE_RE = /^Discount \(/;

const lines: string[] = [];
function log(msg = '') { lines.push(msg); console.log(msg); }
function money(n: unknown): number { return Math.round((Number(n) || 0) * 100) / 100; }
function eqMoney(a: unknown, b: unknown): boolean { return Math.abs(money(a) - money(b)) < MONEY_TOLERANCE; }
function norm(v: unknown): string { return (v === null || v === undefined) ? '' : String(v).trim().toUpperCase(); }
function numOrNull(v: unknown): number | null { return v === null || v === undefined ? null : Number(v); }

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

async function quoteLineRows(client: PoolClient, quoteId: number) {
  return (await client.query(
    `SELECT id, line_index, description, qty, unit_price, unit, subtotal,
            inventory_item_id, inventory_source_id,
            pieces, sqm_l, sqm_w, complete_product_source_id, complete_product_linked, legacy_data
       FROM rel_quote_line_items WHERE quote_id = $1 ORDER BY line_index`,
    [quoteId]
  )).rows;
}

/**
 * A fingerprint of every row this repair must NOT touch. Compared before and
 * after the write, inside the transaction: any difference is proof the repair
 * reached further than it was allowed to, and rolls the whole thing back.
 */
async function untouchedFingerprint(client: PoolClient, quoteId: number, invoiceId: number) {
  const q = async (sql: string, params: any[] = []) => (await client.query(sql, params)).rows;
  return {
    allJobs: await q(
      `SELECT id, row_version, value, status, stage, invoice_num, invoice_created, quote_id
         FROM rel_jobs ORDER BY id`),
    allJobLines: await q(
      `SELECT id, job_id, line_index, description, qty, unit_price, pieces
         FROM rel_job_line_items ORDER BY id`),
    otherQuotes: await q(
      `SELECT id, row_version, quote_number, total, subtotal, vat_amount, status
         FROM rel_quotes WHERE id <> $1 ORDER BY id`, [quoteId]),
    otherQuoteLines: await q(
      `SELECT id, quote_id, line_index, description, qty, unit_price, pieces
         FROM rel_quote_line_items WHERE quote_id <> $1 ORDER BY id`, [quoteId]),
    otherInvoices: await q(
      `SELECT id, row_version, invoice_number, company_code, status, job_id, quote_id, reference
         FROM rel_invoices WHERE id <> $1 ORDER BY id`, [invoiceId]),
    otherInvoiceLines: await q(
      `SELECT id, invoice_id, line_index, description, qty, unit_amount
         FROM rel_invoice_line_items WHERE invoice_id <> $1 ORDER BY id`, [invoiceId]),
    allPayments: await q(
      `SELECT id, owner_type, owner_id, line_index, amount, payment_date, method, reference
         FROM rel_payments ORDER BY id`),
    allCreditNotes: await q(
      `SELECT id, credit_number, amount, used_amount, applied_to, status, company_code
         FROM rel_credit_notes ORDER BY id`),
    // The document-number counters must not move: this repair reserves no
    // number and must consume none.
    counters: await q(`SELECT company, doc_type, last_number FROM document_number_counters ORDER BY company, doc_type`),
    invoiceCount: await q(`SELECT COUNT(*)::int AS n FROM rel_invoices`),
    // The frozen historical record itself is read-only to this repair.
    platformState: await q(`SELECT md5(data::text) AS fingerprint FROM platform_state WHERE id = 1`),
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
  const expectQuoteVersionRaw = arg('--expect-quote-version');
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
    log(' SIGNACORE — ONE-RECORD REPAIR');
    log(` ${QUOTE_NUMBER} -> ${INVOICE_NUMBER}  (company ${COMPANY_CODE})`);
    log('==============================================================');
    const who = (await client.query('SELECT current_database() AS db, current_user AS usr, now() AS at')).rows[0];
    log(` database : ${who.db}`);
    log(` user     : ${who.usr}`);
    log(` run at   : ${new Date(who.at).toISOString()}`);
    log(` mode     : ${APPLY ? 'APPLY (writes, but only if EVERY check passes)' : 'DRY RUN (writes nothing)'}`);
    log('');

    await client.query('BEGIN');

    // ── locate and lock ─────────────────────────────────────────────────────
    const quoteRes = await client.query(
      `SELECT * FROM rel_quotes WHERE UPPER(BTRIM(quote_number)) = $1 ORDER BY id FOR UPDATE`, [QUOTE_NUMBER]);
    const invRes = await client.query(
      `SELECT * FROM rel_invoices WHERE UPPER(BTRIM(invoice_number)) = $1 ORDER BY id FOR UPDATE`, [INVOICE_NUMBER]);

    // ── PRE-CHECKS 1-2: each record exists exactly once, in company 2 ──────
    check('1', quoteRes.rowCount === 1 && String(quoteRes.rows[0].company_code) === COMPANY_CODE,
      `${QUOTE_NUMBER} exists exactly once, in company ${COMPANY_CODE}`,
      { rows: quoteRes.rowCount, company: quoteRes.rows[0]?.company_code });
    check('2', invRes.rowCount === 1 && String(invRes.rows[0].company_code) === COMPANY_CODE,
      `${INVOICE_NUMBER} exists exactly once, in company ${COMPANY_CODE}`,
      { rows: invRes.rowCount, company: invRes.rows[0]?.company_code });
    if (quoteRes.rowCount !== 1 || invRes.rowCount !== 1) {
      throw new PreCheckFailure('the two records could not be resolved to exactly one row each — nothing further can be verified safely');
    }
    const quote = quoteRes.rows[0];
    const inv = invRes.rows[0];

    const quoteLinesBefore = await client.query(
      `SELECT * FROM rel_quote_line_items WHERE quote_id = $1 ORDER BY line_index FOR UPDATE`, [quote.id]);
    await client.query(
      `SELECT id FROM rel_invoice_line_items WHERE invoice_id = $1 ORDER BY line_index FOR UPDATE`, [inv.id]);

    // ── PRE-CHECKS 3-4: the ids the diagnostic reported ────────────────────
    check('3', Number(quote.id) === EXPECTED_QUOTE_ID,
      `${QUOTE_NUMBER} is still relational id ${EXPECTED_QUOTE_ID}`, { id: quote.id });
    check('4', Number(inv.id) === EXPECTED_INVOICE_ID,
      `${INVOICE_NUMBER} is still relational id ${EXPECTED_INVOICE_ID}`, { id: inv.id });

    // ── PRE-CHECKS 5-8: linkage ────────────────────────────────────────────
    check('5', inv.quote_id !== null && Number(inv.quote_id) === Number(quote.id),
      `${INVOICE_NUMBER}.quote_id points to ${QUOTE_NUMBER}`, { quote_id: inv.quote_id, quote: quote.id });
    check('6', inv.job_id === null,
      `${INVOICE_NUMBER} has NO job link (this is a direct quote invoice)`, { job_id: inv.job_id });

    const linkedJobs = await client.query(
      `SELECT id, job_number, quote_id, quote_number_raw, invoice_num FROM rel_jobs
        WHERE quote_id = $1 OR UPPER(BTRIM(COALESCE(quote_number_raw,''))) = $2
           OR UPPER(BTRIM(COALESCE(invoice_num,''))) = $3`,
      [quote.id, QUOTE_NUMBER, INVOICE_NUMBER]);
    check('7', linkedJobs.rowCount === 0 && quote.converted_job_id === null,
      `no Job is linked to ${QUOTE_NUMBER} or claims ${INVOICE_NUMBER}`,
      { jobs: linkedJobs.rows, converted_job_id: quote.converted_job_id });

    const otherInvoices = await client.query(
      `SELECT id, invoice_number, status, quote_id, quote_number_raw, reference FROM rel_invoices
        WHERE id <> $1 AND COALESCE(status,'') <> 'void'
          AND ( quote_id = $2
             OR UPPER(BTRIM(COALESCE(quote_number_raw,''))) = $3
             OR UPPER(BTRIM(COALESCE(reference,'')))        = $3 )`,
      [inv.id, quote.id, QUOTE_NUMBER]);
    check('8', otherInvoices.rowCount === 0,
      `no second invoice references ${QUOTE_NUMBER}`, otherInvoices.rows);

    // ── PRE-CHECKS 9-12: the money, and the shape of the invoice ───────────
    check('9', eqMoney(quote.total, OBSERVED_QUOTE_TOTAL),
      `${QUOTE_NUMBER} total is still ${OBSERVED_QUOTE_TOTAL.toFixed(2)}`, { total: money(quote.total) });
    check('10', eqMoney(quote.setup_fee, OBSERVED_SETUP_FEE) && eqMoney(quote.discount_pct, OBSERVED_DISCOUNT_PCT),
      `${QUOTE_NUMBER} still carries setup fee ${OBSERVED_SETUP_FEE.toFixed(2)} and discount ${OBSERVED_DISCOUNT_PCT}%`,
      { setup_fee: money(quote.setup_fee), discount_pct: Number(quote.discount_pct) });

    const totalsBefore = await invoiceTotals(client, inv.id);
    const invLinesBefore = await invoiceLineRows(client, inv.id);
    const hasSetupFeeLine = invLinesBefore.some((l: any) => norm(l.description) === norm(SETUP_FEE_DESCRIPTION));
    const hasDiscountLine = invLinesBefore.some((l: any) => DISCOUNT_LINE_RE.test(String(l.description ?? '')));

    // The plan. Delegated in full to migration013Recovery — the same resolver
    // invoice creation itself now consults — so this repair cannot be more
    // permissive than the protection that supersedes it. Computed here, before
    // the idempotency check, because "is there anything left to recover?" is
    // part of deciding whether this case is already done.
    const resolution = await resolveDocument013ForInvoicing(client, 'quote', Number(quote.id));
    const planned: LineResolution013[] = resolution.lines;
    const stillRecoverable = planned.filter((p) =>
      MIGRATION_013_FIELDS.some((f) => p.verdict.proposed[f] !== undefined));

    // Idempotency: recognise an ALREADY-REPAIRED record and stop cleanly rather
    // than reporting the repair's own success as a failure. Note the test is
    // NOT "every line has a piece count" — a line that genuinely never had one
    // (SQ-00150's Delivery line) is correctly left NULL for ever, so requiring
    // otherwise would make this repair look permanently unfinished.
    if (eqMoney(totalsBefore.total, quote.total) && stillRecoverable.length === 0) {
      throw new AlreadyRepaired(
        `${INVOICE_NUMBER} already totals ${money(totalsBefore.total).toFixed(2)} — the same as ${QUOTE_NUMBER} — and no ` +
        `${QUOTE_NUMBER} line has any recoverable migration-013 value left outstanding. This case has already been repaired.`
      );
    }

    check('11', eqMoney(totalsBefore.total, OBSERVED_INVOICE_TOTAL),
      `${INVOICE_NUMBER} total is still ${OBSERVED_INVOICE_TOTAL.toFixed(2)}`, { total: money(totalsBefore.total) });
    check('12', norm(inv.status) !== 'VOID', `${INVOICE_NUMBER} is not void`, { status: inv.status });

    // ── PRE-CHECKS 13-14: nothing financial has attached ───────────────────
    const invPayments = await client.query(
      `SELECT id, amount, payment_date, method, reference FROM rel_payments
        WHERE (owner_type = 'invoice' AND owner_id = $1) OR (owner_type = 'quote' AND owner_id = $2) ORDER BY id`,
      [inv.id, quote.id]);
    check('13', invPayments.rowCount === 0,
      `no payment has been recorded against ${INVOICE_NUMBER} or ${QUOTE_NUMBER}`, invPayments.rows);

    const creditNotes = await client.query(
      `SELECT id, credit_number, amount, used_amount, applied_to FROM rel_credit_notes
        WHERE applied_to IS NOT NULL
          AND ( UPPER(BTRIM(applied_to)) LIKE '%' || $1 || '%' OR UPPER(BTRIM(applied_to)) LIKE '%' || $2 || '%' )`,
      [INVOICE_NUMBER, QUOTE_NUMBER]);
    check('14', creditNotes.rowCount === 0,
      `no credit note has been applied against ${INVOICE_NUMBER} or ${QUOTE_NUMBER}`, creditNotes.rows);

    // ── PRE-CHECK 15: the affected line is still exactly what was reported ──
    const affected = quoteLinesBefore.rows.filter(
      (l: any) => eqMoney(l.unit_price, AFFECTED_LINE_UNIT_PRICE) && eqMoney(l.qty, AFFECTED_LINE_QTY));
    check('15', affected.length === 1 && affected[0].pieces === null,
      `exactly one ${QUOTE_NUMBER} line has qty ${AFFECTED_LINE_QTY} at ${AFFECTED_LINE_UNIT_PRICE.toFixed(2)} and its pieces column is still NULL`,
      affected.map((l: any) => ({ line: l.line_index, qty: Number(l.qty), unit_price: money(l.unit_price), pieces: l.pieces })));

    // ── PRE-CHECK 16: the historical values are proved by the SHIPPED rules ─
    const affectedPlan = affected.length === 1
      ? planned.find((p) => p.lineId === Number(affected[0].id)) : undefined;

    check('16', !!affectedPlan
      && affectedPlan.verdict.classification === 'SAFE_TO_RECOVER'
      && Number(affectedPlan.verdict.proposed.pieces) === EXPECTED_RECOVERED_PIECES
      && Number(affectedPlan.verdict.proposed.sqmL) === EXPECTED_RECOVERED_SQM_L
      && Number(affectedPlan.verdict.proposed.sqmW) === EXPECTED_RECOVERED_SQM_W,
      `that line still resolves deterministically to pieces = ${EXPECTED_RECOVERED_PIECES}, sqm_l = ${EXPECTED_RECOVERED_SQM_L}, sqm_w = ${EXPECTED_RECOVERED_SQM_W}`,
      affectedPlan ? { classification: affectedPlan.verdict.classification, proposed: affectedPlan.verdict.proposed, source: affectedPlan.verdict.sourceIdentity } : 'affected line not found in the plan');

    check('17', resolution.blocked.length === 0,
      `no ${QUOTE_NUMBER} line is MISMATCH or AMBIGUOUS — every line's value is knowable`,
      resolution.blocked.map((b) => b.blockingReason));

    // ── PRE-CHECK 18: nothing existing will be overwritten ─────────────────
    const wouldOverwrite: any[] = [];
    for (const p of planned) {
      const row = quoteLinesBefore.rows.find((l: any) => Number(l.id) === p.lineId);
      for (const f of MIGRATION_013_FIELDS) {
        if (p.verdict.proposed[f] === undefined) continue;
        const col = MIGRATION_013_COLUMNS[f];
        if (row && row[col] !== null && row[col] !== undefined) wouldOverwrite.push({ line: p.lineIndex, col, current: row[col] });
      }
    }
    check('18', wouldOverwrite.length === 0,
      'every column this repair would fill is currently NULL — nothing existing is overwritten', wouldOverwrite);

    // ── PRE-CHECK 19: the DERIVED result equals the quote, before writing ──
    // Computed from the plan, with the same formula the writer uses, so a plan
    // that would not produce a consistent document is rejected before the
    // transaction ever writes anything.
    const derivedSubtotal = planned.reduce((s, p) => s + p.effectivePieces * p.qty * p.unitPrice, 0);
    const derivedExVat = derivedSubtotal - derivedSubtotal * (Number(quote.discount_pct) / 100) + Number(quote.setup_fee);
    const derivedTotal = derivedExVat * 1.15;
    check('19', eqMoney(derivedTotal, quote.total),
      `the repaired lines derive a total of ${money(derivedTotal).toFixed(2)}, which equals ${QUOTE_NUMBER}'s own stored total`,
      { derived: money(derivedTotal), quote: money(quote.total) });

    // ── operator-supplied row_version pins ─────────────────────────────────
    if (expectQuoteVersionRaw !== '') {
      check('V1', Number(expectQuoteVersionRaw) === Number(quote.row_version),
        `${QUOTE_NUMBER} row_version still ${expectQuoteVersionRaw} (as seen by the dry run)`,
        { expected: expectQuoteVersionRaw, actual: quote.row_version });
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
    log(`  ${QUOTE_NUMBER}  rel id ${quote.id}  row_version ${quote.row_version}  total ${money(quote.total).toFixed(2)}  setup_fee ${money(quote.setup_fee).toFixed(2)}  discount ${Number(quote.discount_pct)}%`);
    log(`  ${INVOICE_NUMBER}  rel id ${inv.id}  row_version ${inv.row_version}  subtotal ${money(totalsBefore.subtotal).toFixed(2)}  VAT ${money(totalsBefore.vat).toFixed(2)}  total ${money(totalsBefore.total).toFixed(2)}`);
    log('');
    log(`  ${QUOTE_NUMBER} lines (before):`);
    for (const l of quoteLinesBefore.rows) {
      log(`    [${l.line_index}] ${l.description}  qty ${Number(l.qty)}  pieces ${l.pieces === null ? 'NULL' : Number(l.pieces)}  unit ${money(l.unit_price).toFixed(2)}`);
    }
    log('');
    log(`  ${INVOICE_NUMBER} lines (before):`);
    for (const l of invLinesBefore) {
      log(`    [${l.line_index}] ${l.description}  qty ${Number(l.qty)}  unit_amount ${money(l.unit_amount).toFixed(2)}  ${l.tax_type}  = ${money(Number(l.qty) * Number(l.unit_amount)).toFixed(2)}`);
    }
    log('');
    log('── PLANNED CHANGES ───────────────────────────────────────────');
    log(`  STEP 1 — fill ONLY the NULL migration-013 columns on ${QUOTE_NUMBER}'s lines:`);
    let anythingToFill = false;
    for (const p of planned) {
      const fields = MIGRATION_013_FIELDS.filter((f) => p.verdict.proposed[f] !== undefined)
        .map((f) => `${MIGRATION_013_COLUMNS[f]} = ${JSON.stringify(p.verdict.proposed[f])}`);
      if (fields.length) anythingToFill = true;
      log(`    [${p.lineIndex}] ${p.description}`);
      log(`         ${fields.length ? fields.join(', ') : '(nothing to fill — already set, or nothing preserved)'}`);
      log(`         verdict: ${p.verdict.classification}${p.verdict.sourceIdentity ? `  source: ${p.verdict.sourceIdentity}` : ''}`);
    }
    log('  Nothing else on those rows is written: qty, unit_price, description, unit,');
    log('  subtotal, inventory ids and line order are all untouched, and so is every');
    log(`  header field on ${QUOTE_NUMBER} — total, subtotal, VAT, setup fee, discount,`);
    log('  customer, company and status. Only row_version/updated_at move.');
    log('');
    log(`  STEP 2 — rebuild ONLY ${INVOICE_NUMBER}'s line items with services.ts's`);
    log('           writeQuoteInvoiceLinesTx (the DEPLOYED Quote -> Invoice writer,');
    log('           the same one createInvoiceFromQuote calls), from the repaired quote.');
    log(`           Invoice id ${inv.id} and the number ${INVOICE_NUMBER} are preserved exactly.`);
    log('           No replacement invoice is created and none is deleted.');
    log('');
    log(`  DERIVED RESULT (computed from the repaired source, not typed):`);
    log(`    subtotal excl VAT  ${money(derivedExVat).toFixed(2)}`);
    log(`    VAT                ${money(derivedExVat * 0.15).toFixed(2)}`);
    log(`    total incl VAT     ${money(derivedTotal).toFixed(2)}   (${QUOTE_NUMBER} total: ${money(quote.total).toFixed(2)})`);
    log('');

    if (!anythingToFill) {
      throw new PreCheckFailure('the plan would fill nothing — there is no recovery to apply, so this repair has nothing to do');
    }

    if (!APPLY) {
      log('── DRY RUN COMPLETE — NOTHING WAS WRITTEN ────────────────────');
      log('');
      log('  Review the plan above. To apply it, run EXACTLY:');
      log('');
      log('    npx ts-node --transpile-only src/scripts/repair-sq-00150-inv-00111.ts `');
      log(`      --apply --confirm="${REQUIRED_CONFIRM}" \``);
      log(`      --expect-quote-version=${quote.row_version} --expect-invoice-version=${inv.row_version}`);
      log('');
      log('  The two --expect-* values pin the exact rows this plan was made against.');
      log('  If either has moved by then, the repair stops and writes nothing.');
      await client.query('ROLLBACK');
      return;
    }

    if (confirm !== REQUIRED_CONFIRM) {
      throw new PreCheckFailure(
        `--apply was given but --confirm did not exactly match "${REQUIRED_CONFIRM}". Refusing to change anything.`);
    }

    // ══ APPLY ══════════════════════════════════════════════════════════════
    log('── APPLYING ──────────────────────────────────────────────────');
    const fingerprintBefore = await untouchedFingerprint(client, Number(quote.id), Number(inv.id));

    // ── BACKUP, inside the transaction, BEFORE any change ──────────────────
    const backupPayload = {
      case: `${QUOTE_NUMBER} -> ${INVOICE_NUMBER}`,
      quote, quoteLines: quoteLinesBefore.rows,
      invoice: inv, invoiceLines: invLinesBefore,
      payments: invPayments.rows, creditNotes: creditNotes.rows,
      observed: { quoteTotal: money(quote.total), invoiceTotal: money(totalsBefore.total) },
    };
    const serialized = JSON.stringify(backupPayload);
    const backupRes = await client.query(
      `INSERT INTO platform_state_backups (data, reason, data_size_bytes, source, record_counts)
       VALUES ($1::jsonb, 'before-repair-sq-00150-inv-00111', $2, $3, $4::jsonb)
       RETURNING id, created_at`,
      [serialized, Buffer.byteLength(serialized, 'utf8'),
       'src/scripts/repair-sq-00150-inv-00111.ts (manual run)',
       JSON.stringify({
         quoteLines: quoteLinesBefore.rowCount, invoiceLines: invLinesBefore.length,
         payments: invPayments.rowCount, creditNotes: creditNotes.rowCount,
       })]
    );
    log(`  BACKUP  platform_state_backups id = ${backupRes.rows[0].id}  (${backupRes.rows[0].created_at})`);
    log(`          reason 'before-repair-sq-00150-inv-00111' — holds ${QUOTE_NUMBER} and`);
    log(`          ${INVOICE_NUMBER} headers + lines, plus every related payment and credit note.`);

    // ── STEP 1: recover the migration-013 fields, NULL columns only ────────
    let filledCount = 0;
    for (const p of planned) {
      for (const f of MIGRATION_013_FIELDS) {
        const v = p.verdict.proposed[f];
        if (v === undefined) continue;
        const col = MIGRATION_013_COLUMNS[f];
        // `AND <col> IS NULL` is the invariant, restated at the moment of the
        // write: an existing value can never be overwritten, even if something
        // changed between the plan and here.
        const r = await client.query(
          `UPDATE rel_quote_line_items SET ${col} = $1 WHERE id = $2 AND ${col} IS NULL`, [v, p.lineId]);
        filledCount += r.rowCount ?? 0;
      }
    }
    log(`  STEP 1  filled ${filledCount} previously-NULL migration-013 column value(s) across ${planned.length} quote lines.`);

    // The quote row itself: only row_version/updated_at, so any editor holding
    // this quote open gets a clean 409 rather than silently writing stale lines
    // back over the recovery. total/subtotal/vat/setup_fee/discount/status are
    // untouched — and they are already correct, which is precisely why the
    // recovered lines now agree with them.
    const quoteBump = await client.query(
      `UPDATE rel_quotes SET row_version = row_version + 1, updated_at = NOW()
        WHERE id = $1 AND row_version = $2 RETURNING row_version`,
      [quote.id, quote.row_version]);
    if (quoteBump.rowCount !== 1) throw new Error(`${QUOTE_NUMBER} changed under us (row_version moved from ${quote.row_version}) — rolling back`);

    // ── STEP 2: rebuild the invoice's lines with the DEPLOYED writer ───────
    const quoteLinesAfterRecovery = await quoteLineRows(client, Number(quote.id));
    const quoteRowAfterRecovery = (await client.query('SELECT * FROM rel_quotes WHERE id = $1', [quote.id])).rows[0];
    await client.query('DELETE FROM rel_invoice_line_items WHERE invoice_id = $1', [inv.id]);
    // Resolved AFTER step 1, so every line now reports its piece count straight
    // off the column this repair just filled — the rebuild uses the values
    // recovered here, not a second reading of the historical sources.
    const piecesAfterRecovery = effectivePiecesByLineId(
      await resolveDocument013ForInvoicing(client, 'quote', Number(quote.id))
    );
    await writeQuoteInvoiceLinesTx(
      client, Number(inv.id), quoteLinesAfterRecovery, quoteRowAfterRecovery, piecesAfterRecovery);
    log(`  STEP 2  ${INVOICE_NUMBER}'s line items rebuilt by services.ts writeQuoteInvoiceLinesTx.`);

    const invBump = await client.query(
      `UPDATE rel_invoices SET row_version = row_version + 1, updated_at = NOW()
        WHERE id = $1 AND row_version = $2 RETURNING row_version`,
      [inv.id, inv.row_version]);
    if (invBump.rowCount !== 1) throw new Error(`${INVOICE_NUMBER} changed under us (row_version moved from ${inv.row_version}) — rolling back`);

    // ══ POST-CHECK, INSIDE THE TRANSACTION ═════════════════════════════════
    const totalsAfter = await invoiceTotals(client, Number(inv.id));
    const invLinesAfter = await invoiceLineRows(client, Number(inv.id));
    const quoteLinesAfter = await quoteLineRows(client, Number(quote.id));
    const quoteAfter = (await client.query('SELECT * FROM rel_quotes WHERE id = $1', [quote.id])).rows[0];
    const invAfter = (await client.query('SELECT * FROM rel_invoices WHERE id = $1', [inv.id])).rows[0];

    const post: Array<[string, boolean, unknown]> = [];
    const p2 = (label: string, ok: boolean, detail: unknown = '') => post.push([label, ok, detail]);

    p2(`${QUOTE_NUMBER} total unchanged at ${OBSERVED_QUOTE_TOTAL.toFixed(2)}`,
      eqMoney(quoteAfter.total, quote.total) && eqMoney(quoteAfter.total, OBSERVED_QUOTE_TOTAL), money(quoteAfter.total));
    p2(`${QUOTE_NUMBER} subtotal / VAT / setup fee / discount / status / customer / company unchanged`,
      eqMoney(quoteAfter.subtotal, quote.subtotal) && eqMoney(quoteAfter.vat_amount, quote.vat_amount) &&
      eqMoney(quoteAfter.setup_fee, quote.setup_fee) && eqMoney(quoteAfter.discount_pct, quote.discount_pct) &&
      quoteAfter.status === quote.status && quoteAfter.customer_name_raw === quote.customer_name_raw &&
      String(quoteAfter.company_code) === String(quote.company_code) &&
      String(quoteAfter.customer_id) === String(quote.customer_id),
      { total: money(quoteAfter.total), status: quoteAfter.status, company: quoteAfter.company_code });
    p2(`${QUOTE_NUMBER} line descriptions, qty, unit_price, inventory ids and order untouched`,
      quoteLinesAfter.length === quoteLinesBefore.rows.length &&
      quoteLinesAfter.every((a: any, i: number) => {
        const b = quoteLinesBefore.rows[i];
        return Number(a.line_index) === Number(b.line_index) && a.description === b.description &&
          eqMoney(a.qty, b.qty) && eqMoney(a.unit_price, b.unit_price) &&
          String(a.inventory_item_id) === String(b.inventory_item_id) &&
          String(a.inventory_source_id) === String(b.inventory_source_id);
      }), '');
    p2(`the affected ${QUOTE_NUMBER} line now carries pieces = ${EXPECTED_RECOVERED_PIECES}, sqm_l = ${EXPECTED_RECOVERED_SQM_L}, sqm_w = ${EXPECTED_RECOVERED_SQM_W}`,
      quoteLinesAfter.some((l: any) => eqMoney(l.unit_price, AFFECTED_LINE_UNIT_PRICE) && eqMoney(l.qty, AFFECTED_LINE_QTY)
        && Number(l.pieces) === EXPECTED_RECOVERED_PIECES
        && numOrNull(l.sqm_l) === EXPECTED_RECOVERED_SQM_L && numOrNull(l.sqm_w) === EXPECTED_RECOVERED_SQM_W),
      quoteLinesAfter.map((l: any) => ({ i: l.line_index, pieces: l.pieces, sqm_l: l.sqm_l, sqm_w: l.sqm_w })));
    p2(`${INVOICE_NUMBER} carries exactly one "${SETUP_FEE_DESCRIPTION}" line`,
      invLinesAfter.filter((l: any) => norm(l.description) === norm(SETUP_FEE_DESCRIPTION)).length === 1,
      invLinesAfter.map((l: any) => l.description));
    p2(`${INVOICE_NUMBER} has no discount line (quote discount is ${OBSERVED_DISCOUNT_PCT}%)`,
      invLinesAfter.every((l: any) => !DISCOUNT_LINE_RE.test(String(l.description ?? ''))), '');
    p2(`${INVOICE_NUMBER} bills the affected line at ${EXPECTED_RECOVERED_PIECES} x ${AFFECTED_LINE_QTY} = ${EXPECTED_RECOVERED_PIECES * AFFECTED_LINE_QTY} at ${AFFECTED_LINE_UNIT_PRICE.toFixed(2)}`,
      invLinesAfter.some((l: any) => eqMoney(l.unit_amount, AFFECTED_LINE_UNIT_PRICE)
        && eqMoney(l.qty, EXPECTED_RECOVERED_PIECES * AFFECTED_LINE_QTY)),
      invLinesAfter.map((l: any) => ({ qty: Number(l.qty), unit: money(l.unit_amount) })));
    // THE financial assertion. The target is the QUOTE's own total — derived —
    // and only then cross-checked against what the diagnostic observed.
    p2(`${INVOICE_NUMBER} total now equals ${QUOTE_NUMBER}'s total (derived, not typed)`,
      eqMoney(totalsAfter.total, quoteAfter.total), { invoice: money(totalsAfter.total), quote: money(quoteAfter.total) });
    p2(`and that derived total agrees with the diagnostic's ${OBSERVED_QUOTE_TOTAL.toFixed(2)}`,
      eqMoney(totalsAfter.total, OBSERVED_QUOTE_TOTAL), money(totalsAfter.total));
    p2(`${INVOICE_NUMBER} identity unchanged (id, number, issue date, status, job_id, quote_id, reference, company)`,
      String(invAfter.id) === String(inv.id) && invAfter.invoice_number === inv.invoice_number &&
      String(invAfter.issue_date) === String(inv.issue_date) && invAfter.status === inv.status &&
      String(invAfter.job_id) === String(inv.job_id) && String(invAfter.quote_id) === String(inv.quote_id) &&
      invAfter.reference === inv.reference && invAfter.company_code === inv.company_code,
      { id: invAfter.id, number: invAfter.invoice_number, status: invAfter.status });
    p2('exactly one invoice still exists for this quote — no replacement was created',
      (await client.query(
        `SELECT COUNT(*)::int AS n FROM rel_invoices WHERE quote_id = $1 AND COALESCE(status,'') <> 'void'`,
        [quote.id])).rows[0].n === 1, '');

    const fingerprintAfter = await untouchedFingerprint(client, Number(quote.id), Number(inv.id));
    for (const key of Object.keys(fingerprintBefore) as Array<keyof typeof fingerprintBefore>) {
      p2(`nothing unrelated changed: ${key}`,
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
    log('── COMMITTED ─────────────────────────────────────────────────');
    log(`  ${QUOTE_NUMBER}   lines recovered; header untouched; total still ${money(quoteAfter.total).toFixed(2)}`);
    log(`  ${INVOICE_NUMBER}  id ${invAfter.id}, number unchanged, now ${money(totalsAfter.subtotal).toFixed(2)} excl VAT`);
    log(`             + ${money(totalsAfter.vat).toFixed(2)} VAT = ${money(totalsAfter.total).toFixed(2)}`);
    log(`  backup     platform_state_backups id ${backupRes.rows[0].id}`);
  } catch (err: any) {
    if (!committed) { try { await client.query('ROLLBACK'); } catch { /* already rolled back */ } }
    if (err instanceof AlreadyRepaired) {
      log('');
      log('── ALREADY REPAIRED — NOTHING TO DO ──────────────────────────');
      log(`  ${err.message}`);
    } else if (err instanceof PreCheckFailure) {
      log('');
      log('── STOPPED — NOTHING WAS WRITTEN ─────────────────────────────');
      log(`  ${err.message}`);
      process.exitCode = 1;
    } else {
      log('');
      log('── FAILED — ROLLED BACK, NOTHING WAS WRITTEN ─────────────────');
      log(`  ${err && err.message ? err.message : err}`);
      process.exitCode = 1;
    }
  } finally {
    const outPath = path.resolve(outPathArg || path.join(process.cwd(), 'repair-sq-00150-inv-00111-report.txt'));
    try {
      fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
      console.log('');
      console.log('Report saved to: ' + outPath);
    } catch (e: any) {
      console.error('(Could not write the report file: ' + e.message + ')');
    }
    client.release();
    await pool.end().catch(() => undefined);
  }
}

main();
