#!/usr/bin/env node
/* ============================================================================
 * diagnose-audio-access-SNS-00110.js
 * Signacore — READ-ONLY diagnostic for ONE production case
 * Created 2026-08-25 (Audio Access / SQ-00108 / SNS-00110 / INV-00103)
 * ============================================================================
 *
 * WHAT THIS ANSWERS
 *   One real case, three documents:
 *     Quote   SQ-00108   (Audio Access)
 *     Job     SNS-00110  (progressed to Completed; no invoice appeared)
 *     Invoice INV-00103  (created manually; WRONG amount)
 *
 *   It reports, without interpretation:
 *     - each record's relational id / source id / company
 *     - the quote's stored totals vs its totals RECOMPUTED from its own lines
 *       using the live formula (pieces x qty x unit_price, then discount,
 *       then setup fee, then 15% VAT — services.ts createQuote)
 *     - the job's stored `value` vs the value recomputed from its own lines
 *     - the invoice's total computed from its lines (rel_invoices stores no
 *       totals column — the value is ALWAYS derived from rel_invoice_line_items)
 *     - whether INV-00103 actually belongs to SNS-00110
 *     - whether ANY other relational invoice references SNS-00110
 *     - whether SNS-00110 claims an invoice number, and whether it exists
 *     - duplicate invoice numbers inside the same company
 *     - whether the Job lines themselves explain INV-00103's value
 *     - the same three records AS THEY STILL EXIST IN platform_state JSON
 *       (stale/ghost historical linkage check — `payments` is NOT cut over,
 *       so JSON is still live for that section)
 *
 * THIS SCRIPT IS STRICTLY READ ONLY
 *   * Every statement it issues is a SELECT. There is no INSERT, UPDATE,
 *     DELETE, TRUNCATE, ALTER, CREATE, DROP or GRANT anywhere in this file.
 *   * All work happens inside BEGIN TRANSACTION READ ONLY, so Postgres itself
 *     REFUSES any write even if one were somehow introduced.
 *   * It always ends with ROLLBACK.
 *   * It creates no temp tables, no views, and no server-side state.
 *   * It repairs nothing, backfills nothing and migrates nothing.
 *   Safe to run against production. It changes nothing and locks nothing.
 *
 * HOW TO RUN (PowerShell, from the repo root) — see the block at the end of
 * this header for the exact copy/paste command. Uses the `pg` driver already
 * in backend/node_modules and the SAME SSL negotiation the backend itself
 * uses (src/db/ssl.ts's resolveSsl), so no psql install is needed.
 *
 *   cd backend
 *   $env:DATABASE_URL = "<Render EXTERNAL connection string>"
 *   node scripts/diagnose-audio-access-SNS-00110.js
 *
 *   Optional flags:
 *     --quote   <num>   default SQ-00108
 *     --job     <num>   default SNS-00110
 *     --invoice <num>   default INV-00103
 *     --out     <path>  report file (default ./audio-access-SNS-00110-report.txt)
 *     --limit   <n>     rows per detail section (default 200)
 * ==========================================================================*/

'use strict';

const fs = require('fs');
const path = require('path');

let Pool;
try {
  ({ Pool } = require('pg'));
} catch (e) {
  console.error('Could not load the "pg" driver.\n' +
    'Run this from the backend folder (where node_modules lives):\n' +
    '  cd backend\n  node scripts/diagnose-audio-access-SNS-00110.js');
  process.exit(1);
}
try { require('dotenv').config(); } catch (e) { /* .env is optional */ }

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}
const QUOTE_NUM = argValue('--quote', 'SQ-00108');
const JOB_NUM = argValue('--job', 'SNS-00110');
const INV_NUM = argValue('--invoice', 'INV-00103');
const ROW_LIMIT = Number(argValue('--limit', '200')) || 200;
const OUT_PATH = path.resolve(argValue('--out',
  path.join(process.cwd(), 'audio-access-SNS-00110-report.txt')));

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set.\n\nPowerShell:\n' +
    '  $env:DATABASE_URL = "<connection string>"\n' +
    '  node scripts/diagnose-audio-access-SNS-00110.js');
  process.exit(1);
}

// Same SSL decision the backend itself makes (src/db/ssl.ts resolveSsl).
function resolveSsl(url) {
  if (!url) return undefined;
  return /render\.com|\.com\/|sslmode=require/i.test(url) ? { rejectUnauthorized: false } : undefined;
}

// ── output ──────────────────────────────────────────────────────────────────
const lines = [];
function out(s) { const t = s === undefined ? '' : String(s); lines.push(t); console.log(t); }

/** Fixed-width table, so the file is readable without a spreadsheet. */
function table(rows) {
  if (!rows || !rows.length) { out('  (no rows)'); return; }
  const cols = Object.keys(rows[0]);
  const show = (v) => {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  };
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => show(r[c]).length)));
  const sep = '+' + w.map((n) => '-'.repeat(n + 2)).join('+') + '+';
  out(sep);
  out('| ' + cols.map((c, i) => c.padEnd(w[i])).join(' | ') + ' |');
  out(sep);
  for (const r of rows) out('| ' + cols.map((c, i) => show(r[c]).padEnd(w[i])).join(' | ') + ' |');
  out(sep);
  out('(' + rows.length + ' row' + (rows.length === 1 ? '' : 's') + ')');
}

/** Key/value block — easier to read than a 30-column table for single rows. */
function record(rows) {
  if (!rows || !rows.length) { out('  (no rows)'); return; }
  rows.forEach((r, idx) => {
    if (rows.length > 1) out('  --- row ' + (idx + 1) + ' of ' + rows.length + ' ---');
    const cols = Object.keys(r);
    const w = Math.max(...cols.map((c) => c.length));
    for (const c of cols) {
      let v = r[c];
      if (v === null || v === undefined) v = '(null)';
      else if (v instanceof Date) v = v.toISOString().slice(0, 10);
      else if (typeof v === 'object') v = JSON.stringify(v);
      out('  ' + c.padEnd(w) + ' : ' + v);
    }
    out('');
  });
}

// ── shared SQL fragments ────────────────────────────────────────────────────
//
// The live line formula (migration 013 / services.ts lineSubtotal):
//     line subtotal = COALESCE(pieces, 1) * qty * unit_price
// The live document formula (services.ts createQuote / updateQuoteWithJobSync):
//     afterDisc = SUM(line subtotals) - SUM * discount_pct/100 + setup_fee
//     total     = afterDisc * 1.15
// rel_jobs.value is the quote's VAT-INCLUSIVE total (convertQuoteToJob).
//
// rel_invoices has NO totals columns at all — an invoice's value is ALWAYS
// derived from rel_invoice_line_items: qty * unit_amount, + 15% where
// tax_type = '15%'. Setup fee / discount can only appear as extra LINES
// (index.html createInvoiceFromQuote writes 'Design & Setup Fee' and
// 'Discount (n%)' lines); createInvoiceForJob writes neither.

const JSON_ARR = (key) =>
  "CASE WHEN jsonb_typeof(ps.data->'" + key + "') = 'array' THEN ps.data->'" + key + "' ELSE '[]'::jsonb END";

// ── sections ────────────────────────────────────────────────────────────────
const SECTIONS = [
  // ═══ QUOTE ════════════════════════════════════════════════════════════════
  {
    title: 'SECTION 1 — QUOTE ' + QUOTE_NUM + ' : relational header\n (every company, so a cross-company duplicate cannot hide)',
    style: 'record',
    sql: `
      SELECT q.id AS rel_id, q.source_id, q.quote_number, q.company_code,
             q.customer_id, q.customer_name_raw, q.contact_person, q.email,
             q.status, q.quote_date, q.valid_until, q.proforma_num,
             q.setup_fee, q.discount_pct, q.subtotal AS stored_subtotal,
             q.vat_amount AS stored_vat, q.total AS stored_total,
             q.converted_job_id, q.converted_job_source_id,
             (SELECT j2.job_number FROM rel_jobs j2 WHERE j2.id = q.converted_job_id) AS converted_job_number,
             (SELECT COUNT(*)::int FROM rel_quote_line_items l WHERE l.quote_id = q.id) AS line_count,
             q.row_version, q.created_at, q.updated_at,
             (q.legacy_data IS NOT NULL AND q.legacy_data <> '{}'::jsonb) AS has_legacy_data
        FROM rel_quotes q
       WHERE UPPER(BTRIM(q.quote_number)) = UPPER(BTRIM($1))
       ORDER BY q.company_code, q.id`,
    params: () => [QUOTE_NUM],
  },
  {
    title: 'SECTION 2 — QUOTE ' + QUOTE_NUM + ' : line items\n (recomputed = COALESCE(pieces,1) * qty * unit_price)',
    sql: `
      SELECT q.company_code, l.line_index, l.description, l.unit,
             l.qty, l.pieces, l.unit_price,
             l.subtotal AS stored_line_subtotal,
             ROUND(COALESCE(l.pieces, 1) * l.qty * l.unit_price, 2) AS recomputed_line_subtotal,
             ROUND(l.subtotal - (COALESCE(l.pieces, 1) * l.qty * l.unit_price), 2) AS line_delta,
             l.sqm_l, l.sqm_w, l.inventory_source_id,
             l.complete_product_source_id, l.complete_product_linked
        FROM rel_quotes q
        JOIN rel_quote_line_items l ON l.quote_id = q.id
       WHERE UPPER(BTRIM(q.quote_number)) = UPPER(BTRIM($1))
       ORDER BY q.company_code, l.line_index
       LIMIT $2`,
    params: () => [QUOTE_NUM, ROW_LIMIT],
  },
  {
    title: 'SECTION 3 — QUOTE ' + QUOTE_NUM + ' : stored totals vs totals recomputed from its own lines',
    style: 'record',
    sql: `
      WITH q AS (
        SELECT * FROM rel_quotes WHERE UPPER(BTRIM(quote_number)) = UPPER(BTRIM($1))
      ), agg AS (
        SELECT q.id,
               COALESCE(SUM(COALESCE(l.pieces, 1) * l.qty * l.unit_price), 0) AS lines_sum,
               COALESCE(SUM(l.subtotal), 0)                                   AS stored_lines_sum
          FROM q LEFT JOIN rel_quote_line_items l ON l.quote_id = q.id
         GROUP BY q.id
      )
      SELECT q.company_code, q.quote_number, q.id AS rel_id,
             ROUND(a.lines_sum, 2)        AS recomputed_lines_sum,
             ROUND(a.stored_lines_sum, 2) AS stored_lines_sum,
             q.discount_pct, q.setup_fee,
             ROUND(a.lines_sum - a.lines_sum * (COALESCE(q.discount_pct,0)/100) + COALESCE(q.setup_fee,0), 2) AS recomputed_after_discount_excl_vat,
             q.subtotal AS stored_subtotal,
             ROUND((a.lines_sum - a.lines_sum * (COALESCE(q.discount_pct,0)/100) + COALESCE(q.setup_fee,0)) * 0.15, 2) AS recomputed_vat,
             q.vat_amount AS stored_vat,
             ROUND((a.lines_sum - a.lines_sum * (COALESCE(q.discount_pct,0)/100) + COALESCE(q.setup_fee,0)) * 1.15, 2) AS recomputed_total_incl_vat,
             q.total AS stored_total,
             ROUND(q.total - ((a.lines_sum - a.lines_sum * (COALESCE(q.discount_pct,0)/100) + COALESCE(q.setup_fee,0)) * 1.15), 2) AS stored_minus_recomputed
        FROM q JOIN agg a ON a.id = q.id
       ORDER BY q.company_code, q.id`,
    params: () => [QUOTE_NUM],
  },

  // ═══ JOB ══════════════════════════════════════════════════════════════════
  {
    title: 'SECTION 4 — JOB ' + JOB_NUM + ' : relational header',
    style: 'record',
    sql: `
      SELECT j.id AS rel_id, j.source_id, j.job_number, j.company_code,
             j.customer_id, j.customer_name_raw, j.description,
             j.status, j.stage, j.value AS stored_job_value,
             j.setup_fee, j.discount_pct,
             j.quote_id, j.quote_number_raw,
             (SELECT q2.quote_number FROM rel_quotes q2 WHERE q2.id = j.quote_id) AS linked_quote_number,
             (SELECT q2.total        FROM rel_quotes q2 WHERE q2.id = j.quote_id) AS linked_quote_total,
             j.invoice_num, j.invoice_created, j.invoice_status,
             j.invoice_date, j.invoice_due, j.due_date, j.write_off,
             j.deposit_waived, j.deposit_waived_at, j.deposit_waived_by,
             (SELECT COUNT(*)::int FROM rel_job_line_items l WHERE l.job_id = j.id) AS line_count,
             j.row_version, j.created_at, j.updated_at,
             (j.legacy_data IS NOT NULL AND j.legacy_data <> '{}'::jsonb) AS has_legacy_data,
             (j.breakdown  IS NOT NULL AND j.breakdown  <> '{}'::jsonb) AS has_cost_breakdown
        FROM rel_jobs j
       WHERE UPPER(BTRIM(j.job_number)) = UPPER(BTRIM($1))
       ORDER BY j.id`,
    params: () => [JOB_NUM],
  },
  {
    title: 'SECTION 5 — JOB ' + JOB_NUM + ' : line items',
    sql: `
      SELECT l.line_index, l.description, l.unit,
             l.qty, l.pieces, l.unit_price,
             l.subtotal AS stored_line_subtotal,
             ROUND(COALESCE(l.pieces, 1) * l.qty * l.unit_price, 2) AS recomputed_line_subtotal,
             ROUND(l.qty * l.unit_price, 2)                          AS qty_x_price_only,
             l.sqm_l, l.sqm_w, l.inventory_source_id
        FROM rel_jobs j
        JOIN rel_job_line_items l ON l.job_id = j.id
       WHERE UPPER(BTRIM(j.job_number)) = UPPER(BTRIM($1))
       ORDER BY l.line_index
       LIMIT $2`,
    params: () => [JOB_NUM, ROW_LIMIT],
  },
  {
    title: 'SECTION 6 — JOB ' + JOB_NUM + ' : stored value vs value recomputed from its own lines\n'
      + ' qty_x_price_only_incl_vat is what an invoice built by createInvoiceForJob\n'
      + ' would come to, because that writer copies qty and unit_price ONLY —\n'
      + ' it does not carry `pieces`, the setup fee, or the discount.',
    style: 'record',
    sql: `
      WITH j AS (
        SELECT * FROM rel_jobs WHERE UPPER(BTRIM(job_number)) = UPPER(BTRIM($1))
      ), agg AS (
        SELECT j.id,
               COALESCE(SUM(COALESCE(l.pieces, 1) * l.qty * l.unit_price), 0) AS lines_sum,
               COALESCE(SUM(l.qty * l.unit_price), 0)                         AS lines_sum_no_pieces,
               COALESCE(SUM(l.subtotal), 0)                                   AS stored_lines_sum
          FROM j LEFT JOIN rel_job_line_items l ON l.job_id = j.id
         GROUP BY j.id
      )
      SELECT j.job_number, j.id AS rel_id, j.company_code,
             j.value AS stored_job_value,
             ROUND(a.lines_sum, 2)            AS lines_sum_with_pieces_excl_vat,
             ROUND(a.lines_sum_no_pieces, 2)  AS lines_sum_without_pieces_excl_vat,
             ROUND(a.stored_lines_sum, 2)     AS stored_line_subtotal_sum,
             j.discount_pct, j.setup_fee,
             ROUND((a.lines_sum - a.lines_sum * (COALESCE(j.discount_pct,0)/100) + COALESCE(j.setup_fee,0)) * 1.15, 2) AS recomputed_job_value_incl_vat,
             ROUND(j.value - ((a.lines_sum - a.lines_sum * (COALESCE(j.discount_pct,0)/100) + COALESCE(j.setup_fee,0)) * 1.15), 2) AS stored_minus_recomputed,
             ROUND(a.lines_sum_no_pieces * 1.15, 2) AS qty_x_price_only_incl_vat
        FROM j JOIN agg a ON a.id = j.id
       ORDER BY j.id`,
    params: () => [JOB_NUM],
  },

  // ═══ INVOICE ══════════════════════════════════════════════════════════════
  {
    title: 'SECTION 7 — INVOICE ' + INV_NUM + ' : relational header\n (every company, so a cross-company duplicate cannot hide)',
    style: 'record',
    sql: `
      SELECT i.id AS rel_id, i.source_id, i.invoice_number, i.company_code,
             i.customer_id, i.contact_name, i.contact_email, i.contact_address,
             i.status, i.issue_date, i.due_date, i.reference,
             i.job_id, i.job_number_raw,
             (SELECT j2.job_number FROM rel_jobs j2 WHERE j2.id = i.job_id) AS linked_job_number,
             i.quote_id, i.quote_number_raw,
             (SELECT q2.quote_number FROM rel_quotes q2 WHERE q2.id = i.quote_id) AS linked_quote_number,
             (SELECT COUNT(*)::int FROM rel_invoice_line_items l WHERE l.invoice_id = i.id) AS line_count,
             i.row_version, i.created_at, i.updated_at,
             (i.legacy_data IS NOT NULL AND i.legacy_data <> '{}'::jsonb) AS has_legacy_data
        FROM rel_invoices i
       WHERE UPPER(BTRIM(i.invoice_number)) = UPPER(BTRIM($1))
       ORDER BY i.company_code, i.id`,
    params: () => [INV_NUM],
  },
  {
    title: 'SECTION 8 — INVOICE ' + INV_NUM + ' : line items\n (rel_invoice_line_items has NO pieces column — qty * unit_amount is the whole line)',
    sql: `
      SELECT i.company_code, l.line_index, l.description,
             l.qty, l.unit_amount, l.account_code, l.tax_type,
             ROUND(l.qty * l.unit_amount, 2) AS line_excl_vat,
             ROUND(CASE WHEN l.tax_type = '15%' THEN l.qty * l.unit_amount * 0.15 ELSE 0 END, 2) AS line_vat,
             ROUND(l.qty * l.unit_amount + CASE WHEN l.tax_type = '15%' THEN l.qty * l.unit_amount * 0.15 ELSE 0 END, 2) AS line_incl_vat
        FROM rel_invoices i
        JOIN rel_invoice_line_items l ON l.invoice_id = i.id
       WHERE UPPER(BTRIM(i.invoice_number)) = UPPER(BTRIM($1))
       ORDER BY i.company_code, l.line_index
       LIMIT $2`,
    params: () => [INV_NUM, ROW_LIMIT],
  },
  {
    title: 'SECTION 9 — INVOICE ' + INV_NUM + ' : derived totals\n (setup fee / discount only ever exist as separate LINES on an invoice)',
    style: 'record',
    sql: `
      WITH i AS (
        SELECT * FROM rel_invoices WHERE UPPER(BTRIM(invoice_number)) = UPPER(BTRIM($1))
      )
      SELECT i.company_code, i.invoice_number, i.id AS rel_id, i.status,
             (SELECT COUNT(*)::int FROM rel_invoice_line_items l WHERE l.invoice_id = i.id) AS line_count,
             ROUND(COALESCE((SELECT SUM(l.qty * l.unit_amount) FROM rel_invoice_line_items l WHERE l.invoice_id = i.id), 0), 2) AS subtotal_excl_vat,
             ROUND(COALESCE((SELECT SUM(CASE WHEN l.tax_type = '15%' THEN l.qty * l.unit_amount * 0.15 ELSE 0 END) FROM rel_invoice_line_items l WHERE l.invoice_id = i.id), 0), 2) AS vat,
             ROUND(COALESCE((SELECT SUM(l.qty * l.unit_amount + CASE WHEN l.tax_type = '15%' THEN l.qty * l.unit_amount * 0.15 ELSE 0 END) FROM rel_invoice_line_items l WHERE l.invoice_id = i.id), 0), 2) AS total_incl_vat,
             ROUND(COALESCE((SELECT SUM(l.qty * l.unit_amount) FROM rel_invoice_line_items l WHERE l.invoice_id = i.id AND l.description ILIKE '%setup%'), 0), 2) AS setup_fee_lines_total,
             ROUND(COALESCE((SELECT SUM(l.qty * l.unit_amount) FROM rel_invoice_line_items l WHERE l.invoice_id = i.id AND l.description ILIKE '%discount%'), 0), 2) AS discount_lines_total,
             (SELECT COUNT(*)::int FROM rel_invoice_line_items l WHERE l.invoice_id = i.id AND l.tax_type IS DISTINCT FROM '15%') AS non_15pct_lines
        FROM i
       ORDER BY i.company_code, i.id`,
    params: () => [INV_NUM],
  },

  // ═══ OWNERSHIP / LINKAGE ══════════════════════════════════════════════════
  {
    title: 'SECTION 10 — DOES ' + INV_NUM + ' ACTUALLY BELONG TO ' + JOB_NUM + '?\n'
      + ' job_id is the only hard link. job_number_raw / reference are the soft\n'
      + ' keys the frontend de-duplicates on (getManualInvoiceJobRefs).',
    style: 'record',
    sql: `
      SELECT i.invoice_number, i.company_code AS invoice_company,
             j.job_number, j.company_code AS job_company,
             i.job_id, j.id AS job_rel_id,
             (i.job_id IS NOT NULL AND i.job_id = j.id)                                   AS hard_linked_by_job_id,
             i.job_number_raw,
             (UPPER(BTRIM(COALESCE(i.job_number_raw,''))) = UPPER(BTRIM(j.job_number)))    AS job_number_raw_matches,
             i.reference,
             (UPPER(BTRIM(COALESCE(i.reference,'')))      = UPPER(BTRIM(j.job_number)))    AS reference_matches,
             i.quote_id, j.quote_id AS job_quote_id,
             (i.quote_id IS NOT NULL AND i.quote_id = j.quote_id)                          AS same_source_quote,
             (i.company_code = j.company_code)                                             AS same_company,
             i.contact_name, j.customer_name_raw
        FROM rel_invoices i
        CROSS JOIN rel_jobs j
       WHERE UPPER(BTRIM(i.invoice_number)) = UPPER(BTRIM($1))
         AND UPPER(BTRIM(j.job_number))     = UPPER(BTRIM($2))`,
    params: () => [INV_NUM, JOB_NUM],
  },
  {
    title: 'SECTION 11 — EVERY relational invoice that references ' + JOB_NUM + ' in ANY way\n (hard job_id link, job_number_raw, reference, or the job\'s source quote)',
    sql: `
      WITH j AS (
        SELECT id, job_number, company_code, quote_id
          FROM rel_jobs WHERE UPPER(BTRIM(job_number)) = UPPER(BTRIM($1))
      )
      SELECT i.id AS invoice_rel_id, i.invoice_number, i.company_code, i.status,
             i.job_id, i.job_number_raw, i.reference, i.quote_id, i.quote_number_raw,
             i.issue_date, i.contact_name,
             CASE
               WHEN i.job_id = j.id                                                     THEN 'job_id'
               WHEN UPPER(BTRIM(COALESCE(i.job_number_raw,''))) = UPPER(BTRIM(j.job_number)) THEN 'job_number_raw'
               WHEN UPPER(BTRIM(COALESCE(i.reference,'')))      = UPPER(BTRIM(j.job_number)) THEN 'reference'
               WHEN j.quote_id IS NOT NULL AND i.quote_id = j.quote_id                  THEN 'source_quote'
               ELSE 'unknown'
             END AS matched_via,
             ROUND(COALESCE((SELECT SUM(l.qty * l.unit_amount * CASE WHEN l.tax_type = '15%' THEN 1.15 ELSE 1 END)
                               FROM rel_invoice_line_items l WHERE l.invoice_id = i.id), 0), 2) AS invoice_total_incl_vat,
             (SELECT COUNT(*)::int FROM rel_invoice_line_items l WHERE l.invoice_id = i.id) AS line_count
        FROM rel_invoices i CROSS JOIN j
       WHERE i.job_id = j.id
          OR UPPER(BTRIM(COALESCE(i.job_number_raw,''))) = UPPER(BTRIM(j.job_number))
          OR UPPER(BTRIM(COALESCE(i.reference,'')))      = UPPER(BTRIM(j.job_number))
          OR (j.quote_id IS NOT NULL AND i.quote_id = j.quote_id)
       ORDER BY i.id
       LIMIT $2`,
    params: () => [JOB_NUM, ROW_LIMIT],
  },
  {
    title: 'SECTION 12 — DOES THE INVOICE NUMBER ' + JOB_NUM + ' CLAIMS ACTUALLY EXIST?\n (rel_jobs.invoice_num resolved against rel_invoices, in-company and cross-company)',
    style: 'record',
    sql: `
      WITH j AS (
        SELECT id, job_number, company_code, invoice_num, invoice_created, invoice_status
          FROM rel_jobs WHERE UPPER(BTRIM(job_number)) = UPPER(BTRIM($1))
      )
      SELECT j.job_number, j.company_code, j.invoice_num AS claimed_invoice_number,
             j.invoice_created, j.invoice_status,
             (j.invoice_num IS NULL OR BTRIM(j.invoice_num) = '') AS claims_no_number,
             (SELECT COUNT(*)::int FROM rel_invoices i
               WHERE i.company_code = j.company_code
                 AND COALESCE(i.status,'') <> 'void'
                 AND j.invoice_num IS NOT NULL
                 AND UPPER(BTRIM(i.invoice_number)) = UPPER(BTRIM(j.invoice_num))) AS matches_in_own_company,
             (SELECT COUNT(*)::int FROM rel_invoices i
               WHERE i.company_code <> j.company_code
                 AND COALESCE(i.status,'') <> 'void'
                 AND j.invoice_num IS NOT NULL
                 AND UPPER(BTRIM(i.invoice_number)) = UPPER(BTRIM(j.invoice_num))) AS matches_in_other_company,
             (SELECT COUNT(*)::int FROM rel_jobs o
               WHERE o.id <> j.id AND o.company_code = j.company_code
                 AND j.invoice_num IS NOT NULL
                 AND UPPER(BTRIM(COALESCE(o.invoice_num,''))) = UPPER(BTRIM(j.invoice_num))) AS other_jobs_claiming_same_number
        FROM j`,
    params: () => [JOB_NUM],
  },
  {
    title: 'SECTION 13 — OTHER JOBS CLAIMING ' + INV_NUM + '\n (duplicate identity check from the job side)',
    sql: `
      SELECT j.id AS job_rel_id, j.job_number, j.company_code, j.status, j.stage,
             j.value, j.invoice_num, j.invoice_created, j.invoice_status, j.customer_name_raw
        FROM rel_jobs j
       WHERE UPPER(BTRIM(COALESCE(j.invoice_num,''))) = UPPER(BTRIM($1))
       ORDER BY j.company_code, j.id
       LIMIT $2`,
    params: () => [INV_NUM, ROW_LIMIT],
  },
  {
    title: 'SECTION 14 — DUPLICATE INVOICE NUMBERS WITHIN THE SAME COMPANY\n'
      + ' rel_invoices carries UNIQUE (company_code, invoice_number), so a true\n'
      + ' duplicate ROW is impossible; this reports (a) any case-insensitive /\n'
      + ' whitespace duplicate that slips past that constraint, and (b) numbers\n'
      + ' claimed by more than one JOB in the same company.',
    sql: `
      SELECT 'invoice_table' AS source, i.company_code, UPPER(BTRIM(i.invoice_number)) AS number,
             COUNT(*)::int AS occurrences, STRING_AGG(i.id::text, ', ' ORDER BY i.id) AS ids
        FROM rel_invoices i
       GROUP BY i.company_code, UPPER(BTRIM(i.invoice_number))
      HAVING COUNT(*) > 1
      UNION ALL
      SELECT 'jobs_claiming' AS source, j.company_code, UPPER(BTRIM(j.invoice_num)) AS number,
             COUNT(*)::int AS occurrences, STRING_AGG(j.job_number, ', ' ORDER BY j.job_number) AS ids
        FROM rel_jobs j
       WHERE j.invoice_num IS NOT NULL AND BTRIM(j.invoice_num) <> ''
       GROUP BY j.company_code, UPPER(BTRIM(j.invoice_num))
      HAVING COUNT(*) > 1
       ORDER BY 1, 2, 3
       LIMIT $1`,
    params: () => [ROW_LIMIT],
  },

  // ═══ THREE-WAY MONEY COMPARISON ═══════════════════════════════════════════
  {
    title: 'SECTION 15 — THREE-WAY TOTAL COMPARISON\n Quote total vs Job value vs Invoice total (all VAT-inclusive)',
    style: 'record',
    sql: `
      WITH q AS (SELECT * FROM rel_quotes   WHERE UPPER(BTRIM(quote_number))   = UPPER(BTRIM($1))),
           j AS (SELECT * FROM rel_jobs     WHERE UPPER(BTRIM(job_number))     = UPPER(BTRIM($2))),
           i AS (SELECT * FROM rel_invoices WHERE UPPER(BTRIM(invoice_number)) = UPPER(BTRIM($3))),
           it AS (SELECT i.id,
                    COALESCE(SUM(l.qty * l.unit_amount * CASE WHEN l.tax_type = '15%' THEN 1.15 ELSE 1 END), 0) AS total_incl
                    FROM i LEFT JOIN rel_invoice_line_items l ON l.invoice_id = i.id GROUP BY i.id),
           jl AS (SELECT j.id,
                    COALESCE(SUM(COALESCE(l.pieces,1) * l.qty * l.unit_price), 0) AS lines_pieces,
                    COALESCE(SUM(l.qty * l.unit_price), 0)                        AS lines_no_pieces
                    FROM j LEFT JOIN rel_job_line_items l ON l.job_id = j.id GROUP BY j.id)
      SELECT q.quote_number, q.total  AS quote_total_incl_vat,
             j.job_number,   j.value  AS job_value_incl_vat,
             i.invoice_number, ROUND(it.total_incl, 2) AS invoice_total_incl_vat,
             ROUND(j.value - q.total, 2)            AS job_minus_quote,
             ROUND(it.total_incl - j.value, 2)      AS invoice_minus_job,
             ROUND(it.total_incl - q.total, 2)      AS invoice_minus_quote,
             ROUND((jl.lines_pieces - jl.lines_pieces * (COALESCE(j.discount_pct,0)/100) + COALESCE(j.setup_fee,0)) * 1.15, 2) AS job_lines_recomputed_incl_vat,
             ROUND(jl.lines_no_pieces * 1.15, 2)    AS job_lines_without_pieces_incl_vat,
             ROUND(it.total_incl - (jl.lines_no_pieces * 1.15), 2) AS invoice_minus_job_lines_without_pieces,
             CASE WHEN ABS(it.total_incl - (jl.lines_no_pieces * 1.15)) < 0.05
                  THEN 'invoice EQUALS job lines priced WITHOUT pieces'
                  WHEN ABS(it.total_incl - ((jl.lines_pieces - jl.lines_pieces * (COALESCE(j.discount_pct,0)/100) + COALESCE(j.setup_fee,0)) * 1.15)) < 0.05
                  THEN 'invoice EQUALS full recomputed job value'
                  WHEN ABS(it.total_incl - j.value) < 0.05
                  THEN 'invoice EQUALS stored job value'
                  WHEN ABS(it.total_incl - j.value * 1.15) < 0.05
                  THEN 'invoice = job value with VAT applied TWICE'
                  WHEN ABS(it.total_incl - j.value / 1.15) < 0.05
                  THEN 'invoice = job value with VAT stripped'
                  ELSE 'no simple relationship — see the line detail above'
             END AS shape_of_the_difference
        FROM q CROSS JOIN j CROSS JOIN i JOIN it ON it.id = i.id JOIN jl ON jl.id = j.id`,
    params: () => [QUOTE_NUM, JOB_NUM, INV_NUM],
  },
  {
    title: 'SECTION 16 — DO THE JOB LINES EXPLAIN THE INVOICE LINES?\n Job line n vs invoice line n, side by side.',
    sql: `
      WITH j AS (SELECT id FROM rel_jobs     WHERE UPPER(BTRIM(job_number))     = UPPER(BTRIM($1))),
           i AS (SELECT id FROM rel_invoices WHERE UPPER(BTRIM(invoice_number)) = UPPER(BTRIM($2)))
      SELECT COALESCE(jl.line_index, il.line_index) AS line_index,
             jl.description AS job_description,
             jl.pieces AS job_pieces, jl.qty AS job_qty, jl.unit_price AS job_unit_price,
             ROUND(COALESCE(jl.pieces,1) * jl.qty * jl.unit_price, 2) AS job_line_total,
             il.description AS invoice_description,
             il.qty AS inv_qty, il.unit_amount AS inv_unit_amount, il.tax_type,
             ROUND(il.qty * il.unit_amount, 2) AS inv_line_excl_vat,
             CASE WHEN jl.line_index IS NULL THEN 'invoice-only line'
                  WHEN il.line_index IS NULL THEN 'job line MISSING from invoice'
                  WHEN ABS(COALESCE(jl.pieces,1) * jl.qty * jl.unit_price - il.qty * il.unit_amount) < 0.05 THEN 'match'
                  WHEN ABS(jl.qty * jl.unit_price - il.qty * il.unit_amount) < 0.05 THEN 'matches qty*price ONLY (pieces dropped)'
                  ELSE 'differs'
             END AS verdict
        FROM (SELECT l.* FROM rel_job_line_items l JOIN j ON l.job_id = j.id) jl
        FULL OUTER JOIN (SELECT l.* FROM rel_invoice_line_items l JOIN i ON l.invoice_id = i.id) il
          ON il.line_index = jl.line_index
       ORDER BY 1
       LIMIT $3`,
    params: () => [JOB_NUM, INV_NUM, ROW_LIMIT],
  },

  // ═══ PAYMENTS (note: `payments` is NOT relational-authoritative) ══════════
  {
    title: 'SECTION 17 — rel_payments attached to this quote / job / invoice\n'
      + ' NOTE: the `payments` section is NOT cut over (relational_cutover.payments = false),\n'
      + ' so platform_state JSON is still the live source for payments. These rows are\n'
      + ' backfill/observational only and may be incomplete. See Section 21.',
    sql: `
      WITH q AS (SELECT id FROM rel_quotes   WHERE UPPER(BTRIM(quote_number))   = UPPER(BTRIM($1))),
           j AS (SELECT id FROM rel_jobs     WHERE UPPER(BTRIM(job_number))     = UPPER(BTRIM($2))),
           i AS (SELECT id FROM rel_invoices WHERE UPPER(BTRIM(invoice_number)) = UPPER(BTRIM($3)))
      SELECT p.owner_type, p.owner_id, p.line_index, p.amount, p.payment_date,
             p.method, p.reference, p.notes
        FROM rel_payments p
       WHERE (p.owner_type = 'quote'   AND p.owner_id IN (SELECT id FROM q))
          OR (p.owner_type = 'job'     AND p.owner_id IN (SELECT id FROM j))
          OR (p.owner_type = 'invoice' AND p.owner_id IN (SELECT id FROM i))
       ORDER BY p.owner_type, p.owner_id, p.line_index
       LIMIT $4`,
    params: () => [QUOTE_NUM, JOB_NUM, INV_NUM, ROW_LIMIT],
  },

  // ═══ CUTOVER / CONVERSION BOOKKEEPING ════════════════════════════════════
  {
    title: 'SECTION 18 — relational_cutover flags (context for reading everything above)',
    sql: `SELECT section, enabled, enabled_at, enabled_by FROM relational_cutover ORDER BY section`,
  },
  {
    title: 'SECTION 19 — quote_conversions rows for this quote / job number',
    sql: `
      SELECT id, quote_id, job_number, created_at
        FROM quote_conversions
       WHERE UPPER(BTRIM(job_number)) = UPPER(BTRIM($1))
          OR quote_id = 'rel:' || COALESCE((SELECT id::text FROM rel_quotes WHERE UPPER(BTRIM(quote_number)) = UPPER(BTRIM($2)) LIMIT 1), '-')
          OR quote_id = COALESCE((SELECT source_id FROM rel_quotes WHERE UPPER(BTRIM(quote_number)) = UPPER(BTRIM($2)) LIMIT 1), '-')
       ORDER BY id`,
    params: () => [JOB_NUM, QUOTE_NUM],
  },

  // ═══ platform_state JSON — stale / ghost historical linkage ══════════════
  {
    title: 'SECTION 20 — platform_state JSON: the QUOTE as it still exists in JSON',
    style: 'record',
    sql: `
      SELECT x->>'id' AS json_id, x->>'num' AS num, x->>'co' AS co, x->>'client' AS client,
             x->>'status' AS status, x->>'setupFee' AS setup_fee, x->>'discount' AS discount,
             x->>'proformaNum' AS proforma_num, x->>'jobNum' AS job_num, x->>'invoiceNum' AS invoice_num,
             jsonb_array_length(CASE WHEN jsonb_typeof(x->'lines') = 'array' THEN x->'lines' ELSE '[]'::jsonb END) AS line_count,
             jsonb_array_length(CASE WHEN jsonb_typeof(x->'payments') = 'array' THEN x->'payments' ELSE '[]'::jsonb END) AS payment_count,
             ps.updated_at AS platform_state_updated_at
        FROM platform_state ps, jsonb_array_elements(${JSON_ARR('quotes')}) x
       WHERE ps.id = 1 AND UPPER(BTRIM(COALESCE(x->>'num',''))) = UPPER(BTRIM($1))`,
    params: () => [QUOTE_NUM],
  },
  {
    title: 'SECTION 21 — platform_state JSON: the JOB as it still exists in JSON\n (stale/ghost invoice linkage lives here if anywhere)',
    style: 'record',
    sql: `
      SELECT x->>'id' AS json_id, x->>'num' AS num, x->>'co' AS co, x->>'client' AS client,
             x->>'quoteNum' AS quote_num, x->>'status' AS status, x->>'stage' AS stage,
             x->>'value' AS value, x->>'setupFee' AS setup_fee, x->>'discount' AS discount,
             x->>'invoiceNum' AS invoice_num, x->>'invoiceCreated' AS invoice_created,
             x->>'invoiceStatus' AS invoice_status, x->>'invoiceDate' AS invoice_date,
             x->>'invoiceDue' AS invoice_due, x->>'depositWaived' AS deposit_waived,
             jsonb_array_length(CASE WHEN jsonb_typeof(x->'lines') = 'array' THEN x->'lines' ELSE '[]'::jsonb END) AS line_count,
             jsonb_array_length(CASE WHEN jsonb_typeof(x->'payments') = 'array' THEN x->'payments' ELSE '[]'::jsonb END) AS payment_count,
             ps.updated_at AS platform_state_updated_at
        FROM platform_state ps, jsonb_array_elements(${JSON_ARR('jobs')}) x
       WHERE ps.id = 1 AND UPPER(BTRIM(COALESCE(x->>'num',''))) = UPPER(BTRIM($1))`,
    params: () => [JOB_NUM],
  },
  {
    title: 'SECTION 22 — platform_state JSON: the JOB\'s line items',
    sql: `
      SELECT l.ord AS line_index, l.v->>'desc' AS description, l.v->>'qty' AS qty,
             l.v->>'pQty' AS pieces, l.v->>'unitPrice' AS unit_price,
             l.v->>'subtotal' AS stored_subtotal, l.v->>'unit' AS unit,
             l.v->>'sqmL' AS sqm_l, l.v->>'sqmW' AS sqm_w
        FROM platform_state ps,
             jsonb_array_elements(${JSON_ARR('jobs')}) x,
             LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(x->'lines') = 'array' THEN x->'lines' ELSE '[]'::jsonb END)
                     WITH ORDINALITY AS l(v, ord)
       WHERE ps.id = 1 AND UPPER(BTRIM(COALESCE(x->>'num',''))) = UPPER(BTRIM($1))
       ORDER BY l.ord
       LIMIT $2`,
    params: () => [JOB_NUM, ROW_LIMIT],
  },
  {
    title: 'SECTION 23 — platform_state JSON: the INVOICE as it still exists in JSON (accInvoices)',
    style: 'record',
    sql: `
      SELECT x->>'id' AS json_id, x->>'number' AS number, x->>'co' AS co,
             x->>'contactName' AS contact_name, x->>'status' AS status,
             x->>'reference' AS reference, x->>'jobNum' AS job_num, x->>'jobId' AS job_id,
             x->>'quoteNum' AS quote_num, x->>'quoteId' AS quote_id,
             x->>'date' AS date, x->>'dueDate' AS due_date,
             jsonb_array_length(CASE WHEN jsonb_typeof(x->'lineItems') = 'array' THEN x->'lineItems' ELSE '[]'::jsonb END) AS line_count,
             jsonb_array_length(CASE WHEN jsonb_typeof(x->'payments') = 'array' THEN x->'payments' ELSE '[]'::jsonb END) AS payment_count,
             ps.updated_at AS platform_state_updated_at
        FROM platform_state ps, jsonb_array_elements(${JSON_ARR('accInvoices')}) x
       WHERE ps.id = 1 AND UPPER(BTRIM(COALESCE(x->>'number',''))) = UPPER(BTRIM($1))`,
    params: () => [INV_NUM],
  },
  {
    title: 'SECTION 24 — platform_state JSON: the INVOICE\'s line items',
    sql: `
      SELECT l.ord AS line_index, l.v->>'description' AS description,
             l.v->>'qty' AS qty, l.v->>'unitAmount' AS unit_amount,
             l.v->>'taxType' AS tax_type, l.v->>'accountCode' AS account_code
        FROM platform_state ps,
             jsonb_array_elements(${JSON_ARR('accInvoices')}) x,
             LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(x->'lineItems') = 'array' THEN x->'lineItems' ELSE '[]'::jsonb END)
                     WITH ORDINALITY AS l(v, ord)
       WHERE ps.id = 1 AND UPPER(BTRIM(COALESCE(x->>'number',''))) = UPPER(BTRIM($1))
       ORDER BY l.ord
       LIMIT $2`,
    params: () => [INV_NUM, ROW_LIMIT],
  },
  {
    title: 'SECTION 25 — platform_state JSON: any OTHER JSON record naming ' + JOB_NUM + ' or ' + INV_NUM + '\n (ghost/duplicate identity check on the JSON side)',
    sql: `
      SELECT 'accInvoices' AS collection, x->>'number' AS number, x->>'co' AS co,
             x->>'reference' AS reference, x->>'jobNum' AS job_num, x->>'contactName' AS who
        FROM platform_state ps, jsonb_array_elements(${JSON_ARR('accInvoices')}) x
       WHERE ps.id = 1
         AND ( UPPER(BTRIM(COALESCE(x->>'reference',''))) = UPPER(BTRIM($1))
            OR UPPER(BTRIM(COALESCE(x->>'jobNum','')))    = UPPER(BTRIM($1))
            OR UPPER(BTRIM(COALESCE(x->>'number','')))    = UPPER(BTRIM($2)) )
      UNION ALL
      SELECT 'jobs' AS collection, x->>'num' AS number, x->>'co' AS co,
             x->>'invoiceNum' AS reference, x->>'quoteNum' AS job_num, x->>'client' AS who
        FROM platform_state ps, jsonb_array_elements(${JSON_ARR('jobs')}) x
       WHERE ps.id = 1
         AND ( UPPER(BTRIM(COALESCE(x->>'num','')))        = UPPER(BTRIM($1))
            OR UPPER(BTRIM(COALESCE(x->>'invoiceNum',''))) = UPPER(BTRIM($2)) )
       ORDER BY 1, 2
       LIMIT $3`,
    params: () => [JOB_NUM, INV_NUM, ROW_LIMIT],
  },
  {
    title: 'SECTION 26 — CONTEXT: every relational quote / job / invoice for this customer\n (customer matched by name on the quote — Audio Access)',
    sql: `
      WITH cust AS (
        SELECT DISTINCT q.customer_id, q.customer_name_raw
          FROM rel_quotes q WHERE UPPER(BTRIM(q.quote_number)) = UPPER(BTRIM($1))
      )
      SELECT 'quote' AS kind, q.quote_number AS number, q.company_code, q.status,
             q.total AS amount_incl_vat, q.customer_name_raw AS who, q.created_at
        FROM rel_quotes q, cust
       WHERE (cust.customer_id IS NOT NULL AND q.customer_id = cust.customer_id)
          OR UPPER(BTRIM(COALESCE(q.customer_name_raw,''))) = UPPER(BTRIM(COALESCE(cust.customer_name_raw,'~')))
      UNION ALL
      SELECT 'job', j.job_number, j.company_code, j.status, j.value, j.customer_name_raw, j.created_at
        FROM rel_jobs j, cust
       WHERE (cust.customer_id IS NOT NULL AND j.customer_id = cust.customer_id)
          OR UPPER(BTRIM(COALESCE(j.customer_name_raw,''))) = UPPER(BTRIM(COALESCE(cust.customer_name_raw,'~')))
      UNION ALL
      SELECT 'invoice', i.invoice_number, i.company_code, i.status,
             ROUND(COALESCE((SELECT SUM(l.qty * l.unit_amount * CASE WHEN l.tax_type = '15%' THEN 1.15 ELSE 1 END)
                               FROM rel_invoice_line_items l WHERE l.invoice_id = i.id), 0), 2),
             i.contact_name, i.created_at
        FROM rel_invoices i, cust
       WHERE (cust.customer_id IS NOT NULL AND i.customer_id = cust.customer_id)
          OR UPPER(BTRIM(COALESCE(i.contact_name,''))) = UPPER(BTRIM(COALESCE(cust.customer_name_raw,'~')))
       ORDER BY 1, 2
       LIMIT $2`,
    params: () => [QUOTE_NUM, ROW_LIMIT],
  },
];

// ── run ─────────────────────────────────────────────────────────────────────
(async () => {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: resolveSsl(DATABASE_URL),
    max: 1,
    connectionTimeoutMillis: 15000,
  });

  const redacted = DATABASE_URL.replace(/\/\/([^:]+):[^@]*@/, '//$1:****@');
  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    console.error('\nCould not connect to the database.\n  ' + (err && err.message ? err.message : err) +
      '\n\n  Checked DATABASE_URL: ' + redacted +
      '\n  If this is Render\'s external connection string and it does not contain "render.com",' +
      '\n  append "?sslmode=require" to it.');
    await pool.end().catch(() => {});
    process.exit(1);
  }

  try {
    // Postgres itself now refuses every write for the rest of this transaction.
    await client.query('BEGIN TRANSACTION READ ONLY');

    const who = await client.query('SELECT current_database() AS db, current_user AS usr, now() AS at');
    out('');
    out('==============================================================');
    out(' SIGNACORE — SINGLE-CASE INVOICE DIAGNOSTIC (READ ONLY)');
    out('==============================================================');
    out(' quote    : ' + QUOTE_NUM);
    out(' job      : ' + JOB_NUM);
    out(' invoice  : ' + INV_NUM);
    out(' database : ' + who.rows[0].db);
    out(' user     : ' + who.rows[0].usr);
    out(' run at   : ' + new Date(who.rows[0].at).toISOString());
    out(' url      : ' + redacted);
    out(' mode     : BEGIN TRANSACTION READ ONLY — nothing can be written');
    out('');

    for (const s of SECTIONS) {
      out('');
      out('==============================================================');
      out(' ' + s.title);
      out('==============================================================');
      try {
        const res = await client.query(s.sql, s.params ? s.params() : []);
        if (s.style === 'record') record(res.rows); else table(res.rows);
      } catch (sectionErr) {
        // One failing section must never cost us the other 25.
        out('  !! this section failed: ' + (sectionErr && sectionErr.message ? sectionErr.message : sectionErr));
        // A failed statement aborts the transaction; restart it READ ONLY.
        try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
        await client.query('BEGIN TRANSACTION READ ONLY');
      }
    }

    await client.query('ROLLBACK');
    out('');
    out('Diagnostic complete. Nothing was written — every transaction was READ ONLY');
    out('and has been rolled back.');

    try {
      fs.writeFileSync(OUT_PATH, lines.join('\n') + '\n', 'utf8');
      out('');
      out('Report also saved to: ' + OUT_PATH);
    } catch (e) {
      console.error('(Could not write the report file: ' + e.message + ' — the output above is complete.)');
    }
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* already rolled back */ }
    console.error('\nThe diagnostic failed:\n  ' + (err && err.message ? err.message : err));
    if (err && /relation "rel_/.test(String(err.message))) {
      console.error('  The rel_* tables were not found — is DATABASE_URL pointing at the right database?');
    }
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
})();
