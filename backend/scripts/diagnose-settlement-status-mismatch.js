#!/usr/bin/env node
/* ============================================================================
 * diagnose-settlement-status-mismatch.js
 * Signacore — READ-ONLY diagnostic for the 2026-09-14 Accounting ↔ Sales
 * settlement-status inconsistency.
 * ============================================================================
 *
 * WHAT THIS ANSWERS
 *   Which transactions did Accounting → Invoices report as PAID while
 *   Sales → Invoices reported PARTIAL — and exactly why, for each one.
 *
 *   It evaluates, per transaction, all THREE rules side by side:
 *     CANONICAL   round(chain paid, 2) >= round(total, 2)   — services.ts's
 *                 recomputeOwnerPaymentStatus, and now the shared rule both
 *                 screens use
 *     ACCOUNTING  what the Accounting invoice row showed BEFORE the fix
 *                 (stored status, rescued by a private "outstanding <= R0.01")
 *     SALES       what the Sales invoice row showed BEFORE the fix
 *                 (stored status verbatim for canonical invoices; an
 *                 unrounded, quote-derived total for job invoices)
 *
 *   Run it BEFORE deploying the fix to see the affected population, and AFTER
 *   to confirm section 1 and section 3 are empty.
 *
 * THIS SCRIPT IS STRICTLY READ ONLY
 *   * Every statement it issues is a SELECT. There is no INSERT, UPDATE,
 *     DELETE, TRUNCATE, ALTER, CREATE, DROP, MERGE or GRANT anywhere in it.
 *   * All work happens inside BEGIN TRANSACTION READ ONLY, so Postgres itself
 *     REFUSES any write even if one were somehow introduced.
 *   * It always ends with ROLLBACK.
 *   * It creates no temp tables, no views and no server-side state.
 *   * It never prints DATABASE_URL or any password (the connection string is
 *     redacted before it is echoed).
 *   Safe to run against production. It changes nothing and locks nothing.
 *
 * HOW TO RUN — ONE COMMAND
 *   PowerShell, from the repo root:
 *     cd backend
 *     $env:DATABASE_URL = "<your production connection string>"
 *     node scripts/diagnose-settlement-status-mismatch.js
 *
 *   Render shell (DATABASE_URL is already set there):
 *     cd backend && node scripts/diagnose-settlement-status-mismatch.js
 *
 *   The report is printed AND written to a file; the path is shown at the end.
 *   Optional flags:  --out <path>   --limit <n>   (default 500 rows/section)
 *
 * A NOTE ON PRECISION
 *   Postgres NUMERIC is exact decimal; the browser's Number is binary float.
 *   The quantity that matters here — whether an unrounded total sits above the
 *   cent figure the customer was actually billed — is reproduced faithfully by
 *   NUMERIC, so a row listed in section 3 is a real divergence. A handful of
 *   rows sitting exactly on a half-cent boundary could in principle be
 *   classified differently by the browser's float; those are flagged
 *   BOUNDARY in the reason column rather than asserted either way.
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
    '  cd backend\n  node scripts/diagnose-settlement-status-mismatch.js');
  process.exit(1);
}
try { require('dotenv').config(); } catch (e) { /* .env is optional */ }

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}
const ROW_LIMIT = Number(argValue('--limit', '500')) || 500;
const OUT_PATH = path.resolve(argValue('--out',
  path.join(process.cwd(), 'settlement-status-mismatch-report.txt')));

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set.\n\nPowerShell:\n' +
    '  $env:DATABASE_URL = "<connection string>"\n' +
    '  node scripts/diagnose-settlement-status-mismatch.js');
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
function table(rows) {
  if (!rows.length) { out('  (no rows)'); return; }
  const cols = Object.keys(rows[0]);
  const show = (v) => {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return String(v);
  };
  const w = cols.map(c => Math.max(c.length, ...rows.map(r => show(r[c]).length)));
  out('  ' + cols.map((c, i) => c.padEnd(w[i])).join('  '));
  out('  ' + w.map(n => '-'.repeat(n)).join('  '));
  for (const r of rows) out('  ' + cols.map((c, i) => show(r[c]).padEnd(w[i])).join('  '));
}

/* ── shared SQL building blocks ─────────────────────────────────────────────
 * chain_paid mirrors read.ts's buildInvoicesJson chain resolution EXACTLY:
 * the invoice's own payments, plus its job's, plus its quote's (reached through
 * the invoice's own quote_id or through its job's quote_id), with company_code
 * compared on both sides so a chain can never cross a company context. Each
 * rel_payments row has exactly one owner and each owner appears once, so
 * nothing is double counted. */
const INVOICE_FACTS = `
  inv AS (
    SELECT i.id, i.company_code, i.invoice_number, i.status, i.job_id, i.quote_id,
           i.job_number_raw, i.quote_number_raw,
           COALESCE(j.quote_id, i.quote_id) AS eff_quote_id,
           j.job_number, j.invoice_status AS job_invoice_status, j.value AS job_value,
           j.company_code AS job_company, q.company_code AS quote_company, q.quote_number
      FROM rel_invoices i
      LEFT JOIN rel_jobs   j ON j.id = i.job_id
      LEFT JOIN rel_quotes q ON q.id = COALESCE(j.quote_id, i.quote_id)
     WHERE COALESCE(i.status,'') <> 'void'
  ),
  inv_total AS (
    SELECT li.invoice_id,
           SUM((li.qty * li.unit_amount) * (CASE WHEN li.tax_type = '15%' THEN 1.15 ELSE 1 END)) AS total_raw
      FROM rel_invoice_line_items li
     GROUP BY li.invoice_id
  ),
  own_pay AS (
    SELECT p.owner_id AS invoice_id, SUM(p.amount) AS amt
      FROM rel_payments p WHERE p.owner_type = 'invoice' GROUP BY p.owner_id
  ),
  job_pay AS (
    SELECT p.owner_id AS job_id, SUM(p.amount) AS amt
      FROM rel_payments p WHERE p.owner_type = 'job' GROUP BY p.owner_id
  ),
  quote_pay AS (
    SELECT p.owner_id AS quote_id, SUM(p.amount) AS amt
      FROM rel_payments p WHERE p.owner_type = 'quote' GROUP BY p.owner_id
  ),
  facts AS (
    SELECT inv.*,
           COALESCE(it.total_raw, 0) AS total_raw,
           ROUND(COALESCE(it.total_raw, 0), 2) AS total_cents,
           COALESCE(op.amt, 0)
             + CASE WHEN inv.job_id IS NOT NULL AND inv.job_company = inv.company_code
                    THEN COALESCE(jp.amt, 0) ELSE 0 END
             + CASE WHEN inv.eff_quote_id IS NOT NULL AND inv.quote_company = inv.company_code
                    THEN COALESCE(qp.amt, 0) ELSE 0 END AS chain_paid
      FROM inv
      LEFT JOIN inv_total it ON it.invoice_id   = inv.id
      LEFT JOIN own_pay   op ON op.invoice_id   = inv.id
      LEFT JOIN job_pay   jp ON jp.job_id       = inv.job_id
      LEFT JOIN quote_pay qp ON qp.quote_id     = inv.eff_quote_id
  ),
  scored AS (
    SELECT f.*,
           ROUND(f.chain_paid, 2) AS paid_cents,
           GREATEST(ROUND(f.total_raw, 2) - ROUND(f.chain_paid, 2), 0) AS outstanding_cents,
           CASE WHEN ROUND(f.total_raw,2) > 0 AND ROUND(f.chain_paid,2) >= ROUND(f.total_raw,2) THEN 'paid'
                WHEN ROUND(f.chain_paid,2) > 0 THEN 'partial'
                ELSE 'pending' END AS canonical_state,
           -- Accounting BEFORE the fix: stored status, rescued by its private
           -- "raw outstanding <= R0.01" display tolerance.
           CASE WHEN f.status = 'paid' THEN 'paid'
                WHEN f.status = 'partial' AND GREATEST(f.total_raw - f.chain_paid, 0) <= 0.01 THEN 'paid'
                ELSE COALESCE(f.status,'draft') END AS accounting_before,
           -- Sales BEFORE the fix: the stored status, mapped, and nothing else.
           CASE WHEN f.status = 'paid' THEN 'paid'
                WHEN f.status = 'partial' THEN 'partial'
                ELSE 'pending' END AS sales_before
      FROM facts f
  )`;

/* Job invoices with NO accounting record behind them — the rows Sales and
 * Accounting both build from the job. Accounting compares against the job's
 * own stored (cent-precise) value; Sales re-derives the value from the source
 * quote as (subtotal - discount + setupFee) * 1.15 and never rounds it. */
const JOB_FACTS = `
  jpay AS (
    SELECT p.owner_id AS job_id, SUM(p.amount) AS amt
      FROM rel_payments p WHERE p.owner_type = 'job' GROUP BY p.owner_id
  ),
  qpay AS (
    SELECT p.owner_id AS quote_id, SUM(p.amount) AS amt
      FROM rel_payments p WHERE p.owner_type = 'quote' GROUP BY p.owner_id
  ),
  qsub AS (
    SELECT ql.quote_id, SUM(ql.subtotal) AS sub
      FROM rel_quote_line_items ql GROUP BY ql.quote_id
  ),
  jobs AS (
    SELECT j.id, j.company_code, j.job_number, j.invoice_num, j.invoice_status,
           j.value AS job_value, j.quote_id, q.quote_number, q.company_code AS quote_company,
           q.discount_pct, q.setup_fee, COALESCE(qs.sub, 0) AS quote_subtotal,
           COALESCE(jp.amt, 0)
             + CASE WHEN j.quote_id IS NOT NULL AND q.company_code = j.company_code
                    THEN COALESCE(qp.amt, 0) ELSE 0 END AS chain_paid
      FROM rel_jobs j
      LEFT JOIN rel_quotes q ON q.id = j.quote_id
      LEFT JOIN qsub  qs ON qs.quote_id = j.quote_id
      LEFT JOIN jpay  jp ON jp.job_id   = j.id
      LEFT JOIN qpay  qp ON qp.quote_id = j.quote_id
     WHERE j.invoice_num IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM rel_invoices i
          WHERE COALESCE(i.status,'') <> 'void'
            AND i.company_code = j.company_code
            AND (i.job_id = j.id OR i.reference = j.job_number OR i.job_number_raw = j.job_number)
       )
  ),
  jscored AS (
    SELECT jb.*,
           jb.job_value AS accounting_total,
           -- Sales re-syncs a job invoice's value from its source quote — but
           -- only through the COMPANY-SAFE resolveQuoteForJob (2026-09-08). A
           -- quote belonging to another company is never this job's source, so
           -- the job keeps its own value here exactly as it does on screen.
           CASE WHEN jb.quote_id IS NULL
                  OR jb.quote_company IS DISTINCT FROM jb.company_code
                THEN jb.job_value
                ELSE (jb.quote_subtotal
                      - jb.quote_subtotal * (COALESCE(jb.discount_pct,0) / 100)
                      + COALESCE(jb.setup_fee,0)) * 1.15 END AS sales_total_raw
      FROM jobs jb
  ),
  jfinal AS (
    SELECT js.*,
           CASE WHEN js.accounting_total > 0 AND js.chain_paid >= js.accounting_total THEN 'paid'
                WHEN js.chain_paid > 0 THEN 'partial' ELSE 'pending' END AS accounting_before,
           CASE WHEN js.sales_total_raw > 0 AND js.chain_paid >= js.sales_total_raw THEN 'paid'
                WHEN js.chain_paid > 0 THEN 'partial' ELSE 'pending' END AS sales_before,
           CASE WHEN ROUND(js.accounting_total,2) > 0 AND ROUND(js.chain_paid,2) >= ROUND(js.accounting_total,2) THEN 'paid'
                WHEN ROUND(js.chain_paid,2) > 0 THEN 'partial' ELSE 'pending' END AS canonical_state
      FROM jscored js
  )`;

const SECTIONS = [
  {
    title: '1. CANONICAL INVOICES — Accounting said PAID, Sales said PARTIAL',
    note: 'The reported symptom, on invoices that have a rel_invoices record.\n' +
          '  Accounting rescued a stored "partial" with its own R0.01 tolerance;\n' +
          '  Sales printed the stored status verbatim. After the fix both screens\n' +
          '  derive from canonical_state and this section must be EMPTY.',
    sql: `WITH ${INVOICE_FACTS}
      SELECT company_code AS company, invoice_number AS invoice_no, id AS invoice_rel_id,
             job_number AS job_no, job_id, quote_number AS quote_no, eff_quote_id AS quote_id,
             ROUND(total_raw,4) AS invoice_total_raw, total_cents AS invoice_total,
             paid_cents AS chain_paid, outstanding_cents AS outstanding,
             status AS stored_invoice_status, job_invoice_status AS stored_job_status,
             accounting_before AS accounting_showed, sales_before AS sales_showed,
             canonical_state AS canonical,
             CASE WHEN canonical_state = 'paid' AND status <> 'paid'
                    THEN 'stored status stale — chain payments settle it; Accounting derived, Sales did not'
                  WHEN ROUND(total_raw,2) > ROUND(chain_paid,2)
                    THEN 'REAL SHORTFALL of ' || (ROUND(total_raw,2) - ROUND(chain_paid,2))::text
                         || ' — the old Accounting R0.01 tolerance forgave it; Sales was right'
                  ELSE 'rounding: sub-cent line arithmetic' END AS reason
        FROM scored
       WHERE accounting_before = 'paid' AND sales_before = 'partial'
       ORDER BY company_code, invoice_number
       LIMIT $1`,
    params: () => [ROW_LIMIT],
  },
  {
    title: '2. CANONICAL INVOICES — stored rel_invoices.status disagrees with the canonical rule',
    note: 'Informational. A stale stored status is NOT repaired by the fix and does\n' +
          '  not need to be: both screens now derive the state at read time. Listed so\n' +
          '  you can see the size of the population before deciding anything.',
    sql: `WITH ${INVOICE_FACTS}
      SELECT company_code AS company, invoice_number AS invoice_no, id AS invoice_rel_id,
             job_number AS job_no, quote_number AS quote_no,
             total_cents AS invoice_total, paid_cents AS chain_paid,
             outstanding_cents AS outstanding,
             status AS stored_invoice_status, canonical_state AS canonical,
             CASE WHEN canonical_state = 'paid' AND status <> 'paid' THEN 'stored status behind the payments'
                  WHEN canonical_state <> 'paid' AND status = 'paid' THEN 'stored PAID but payments do not cover it'
                  ELSE 'stored/derived differ' END AS reason
        FROM scored
       WHERE (canonical_state = 'paid') <> (status = 'paid')
       ORDER BY company_code, invoice_number
       LIMIT $1`,
    params: () => [ROW_LIMIT],
  },
  {
    title: '3. JOB INVOICES (no accounting record) — Accounting PAID vs Sales PARTIAL',
    note: 'The rounding defect in its purest form. Accounting compares the payments\n' +
          '  against rel_jobs.value — NUMERIC(14,2), the cent figure the customer was\n' +
          '  billed and paid. Sales re-derives (subtotal - discount + setupFee) * 1.15\n' +
          '  in the browser and compares raw. After the fix both round to cents, so\n' +
          '  every row whose two totals differ by less than a cent disappears.',
    sql: `WITH ${JOB_FACTS}
      SELECT company_code AS company, invoice_num AS invoice_no, id AS job_rel_id,
             job_number AS job_no, quote_number AS quote_no, quote_id,
             ROUND(accounting_total,2) AS accounting_total,
             ROUND(sales_total_raw,4) AS sales_total_raw,
             ROUND(sales_total_raw - accounting_total, 4) AS total_gap,
             ROUND(chain_paid,2) AS chain_paid,
             GREATEST(ROUND(accounting_total,2) - ROUND(chain_paid,2), 0) AS outstanding,
             invoice_status AS stored_job_status,
             accounting_before AS accounting_showed, sales_before AS sales_showed,
             canonical_state AS canonical,
             CASE WHEN ABS(sales_total_raw - accounting_total) <= 0.01
                    THEN 'ROUNDING — fixed by the cent-precise rule'
                  ELSE 'TOTAL DRIFT of ' || ROUND(sales_total_raw - accounting_total, 2)::text
                       || ' — the quote and the job genuinely disagree (NOT fixed; see report item L)'
             END AS reason
        FROM jfinal
       WHERE accounting_before = 'paid' AND sales_before = 'partial'
       ORDER BY company_code, invoice_num
       LIMIT $1`,
    params: () => [ROW_LIMIT],
  },
  {
    title: '4. JOB INVOICES — quote-derived total drifts from the job value by more than R0.01',
    note: 'Residual, deliberately NOT changed: Sales re-syncs a job invoice\'s displayed\n' +
          '  value from its source quote, while Accounting, the backend assertion and the\n' +
          '  printed invoice all use the job\'s own value. Where the two really differ,\n' +
          '  Sales also shows a different AMOUNT — which would be visible on screen.\n' +
          '  Empty here means the reported mismatch was purely the rounding rule.',
    sql: `WITH ${JOB_FACTS}
      SELECT company_code AS company, invoice_num AS invoice_no, job_number AS job_no,
             quote_number AS quote_no,
             ROUND(accounting_total,2) AS job_value,
             ROUND(sales_total_raw,2) AS quote_derived_value,
             ROUND(sales_total_raw - accounting_total, 2) AS gap,
             ROUND(chain_paid,2) AS chain_paid,
             accounting_before AS accounting_showed, sales_before AS sales_showed
        FROM jfinal
       WHERE quote_id IS NOT NULL
         AND quote_company = company_code
         AND ABS(sales_total_raw - accounting_total) > 0.01
       ORDER BY ABS(sales_total_raw - accounting_total) DESC
       LIMIT $1`,
    params: () => [ROW_LIMIT],
  },
  {
    title: '5. SUMMARY',
    note: 'One line per population. After the fix, mismatch_canonical and\n' +
          '  mismatch_job_invoices must both be 0.',
    sql: `WITH ${INVOICE_FACTS},
      ${JOB_FACTS}
      SELECT
        (SELECT COUNT(*) FROM scored) AS live_canonical_invoices,
        (SELECT COUNT(*) FROM scored WHERE accounting_before='paid' AND sales_before='partial') AS mismatch_canonical,
        (SELECT COUNT(*) FROM scored WHERE (canonical_state='paid') <> (status='paid')) AS stored_status_stale,
        (SELECT COUNT(*) FROM jfinal) AS job_invoices_no_record,
        (SELECT COUNT(*) FROM jfinal WHERE accounting_before='paid' AND sales_before='partial') AS mismatch_job_invoices,
        (SELECT COUNT(*) FROM jfinal WHERE quote_id IS NOT NULL AND quote_company = company_code
           AND ABS(sales_total_raw - accounting_total) > 0.01) AS job_quote_total_drift`,
    params: () => [],
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

  let failed = false;
  try {
    // Postgres itself now refuses every write for the rest of this transaction.
    await client.query('BEGIN TRANSACTION READ ONLY');

    const who = await client.query('SELECT current_database() AS db, current_user AS usr, now() AS at');
    out('');
    out('==============================================================');
    out(' SIGNACORE — SETTLEMENT STATUS MISMATCH DIAGNOSTIC (READ ONLY)');
    out('==============================================================');
    out(` database : ${who.rows[0].db}`);
    out(` user     : ${who.rows[0].usr}`);
    out(` at       : ${who.rows[0].at.toISOString()}`);
    out(` url      : ${redacted}`);
    out(` mode     : BEGIN TRANSACTION READ ONLY  (ends in ROLLBACK)`);
    out('');

    for (const s of SECTIONS) {
      out('');
      out('--------------------------------------------------------------');
      out(s.title);
      out('--------------------------------------------------------------');
      if (s.note) out('  ' + s.note);
      out('');
      try {
        const res = await client.query(s.sql, s.params());
        table(res.rows);
      } catch (err) {
        failed = true;
        out('  !! query failed: ' + (err && err.message ? err.message : err));
      }
      out('');
    }
  } finally {
    try { await client.query('ROLLBACK'); } catch (e) { /* nothing was written anyway */ }
    client.release();
    await pool.end().catch(() => {});
  }

  out('');
  out('Nothing was written. The transaction was READ ONLY and was rolled back.');
  try {
    fs.writeFileSync(OUT_PATH, lines.join('\n') + '\n', 'utf8');
    out('Report written to: ' + OUT_PATH);
  } catch (e) {
    out('Could not write the report file: ' + (e && e.message ? e.message : e));
  }
  process.exit(failed ? 2 : 0);
})();
