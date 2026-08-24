#!/usr/bin/env node
/* ============================================================================
 * diagnose-job-invoice-links.js
 * Signacore — READ-ONLY diagnostic for job-side invoice linkage
 * Created 2026-08-24 (invoice list consistency / View-only investigation)
 * ============================================================================
 *
 * Same report as scripts/diagnose-job-invoice-links.sql, for machines that do
 * not have `psql` installed (a normal Windows dev box does not — psql ships
 * with the Postgres/pgAdmin installer, not with Node). This uses the `pg`
 * driver already in backend/node_modules and the SAME SSL negotiation the app
 * itself uses (src/db/ssl.ts's resolveSsl), so it connects wherever the
 * backend connects — including Render's external endpoint.
 *
 * WHAT THIS ANSWERS
 *   For EVERY job that carries invoice linkage (rel_jobs.invoice_num or
 *   invoice_created), does an authoritative rel_invoices row actually exist
 *   behind it? Jobs where the answer is "no" are the rows that render as
 *   historical job invoices with no accounting record — the "View-only" rows.
 *
 * THIS SCRIPT IS STRICTLY READ ONLY
 *   * Every statement it issues is a SELECT. There is no INSERT, UPDATE,
 *     DELETE, TRUNCATE, ALTER, CREATE or GRANT anywhere in this file.
 *   * All work happens inside BEGIN TRANSACTION READ ONLY, so Postgres itself
 *     REFUSES any write even if one were somehow introduced.
 *   * It always ends with ROLLBACK.
 *   * It creates no temp tables, no views, and no server-side state.
 *   Safe to run against production. It changes nothing and locks nothing.
 *
 * HOW TO RUN (PowerShell, from the repo root)
 *   cd backend
 *   $env:DATABASE_URL = "<your production connection string>"
 *   node scripts/diagnose-job-invoice-links.js
 *
 *   To capture the report for review (it is also written to a file
 *   automatically — the path is printed at the end):
 *   node scripts/diagnose-job-invoice-links.js > job-invoice-link-report.txt 2>&1
 *
 *   Optional flags:
 *     --out <path>     write the report to this file instead of the default
 *     --limit <n>      rows per detail section (default 500)
 *
 * CLASSIFICATION
 *   MATCHED    exactly one live rel_invoices row is this job's invoice
 *              (linked by job_id, or by same company + same invoice number),
 *              AND that invoice is claimed by exactly one job. Renders as one
 *              canonical invoice with the full action set.
 *   ORPHANED   the job carries invoice linkage but NO rel_invoices row exists
 *              for it. Almost always a genuine historical invoice raised by
 *              the pre-cutover "Create Invoice" flow, which only ever wrote
 *              the job (index.html createInvoiceNow's JSON branch:
 *              forceSaveSections({ jobs })) — backfill preserves that
 *              faithfully and never synthesises an invoice row from job
 *              fields. These are REAL invoices; they simply have no
 *              accounting record. NOT automatically repairable.
 *   AMBIGUOUS  the identity cannot be resolved to one job/invoice pair:
 *              more than one invoice matches, OR one invoice is claimed by
 *              two or more jobs. Needs a person; no invoice id is reported.
 *   INVALID    the job's invoice number does not exist in its own company but
 *              DOES exist in another company. The linkage cannot be a valid
 *              identity. Needs a person. NEVER merge these.
 *   NO_NUMBER  invoice_created is true but there is no invoice number at all.
 *
 * WHAT TO DO WITH THE OUTPUT
 *   Send sections 1-3 back for review before ANY repair is considered. Do not
 *   clear or rewrite historical linkage on the strength of this report alone —
 *   an ORPHANED row is a real invoice, not a mistake, and section 3 shows
 *   which of them still carry money.
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
    '  cd backend\n  node scripts/diagnose-job-invoice-links.js');
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
  path.join(process.cwd(), 'job-invoice-link-report.txt')));

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set.\n\nPowerShell:\n' +
    '  $env:DATABASE_URL = "<connection string>"\n' +
    '  node scripts/diagnose-job-invoice-links.js');
  process.exit(1);
}

// Same SSL decision the backend itself makes (src/db/ssl.ts resolveSsl), so
// this reaches Render's external endpoint exactly as the app does.
function resolveSsl(url) {
  if (!url) return undefined;
  return /render\.com|\.com\/|sslmode=require/i.test(url) ? { rejectUnauthorized: false } : undefined;
}

// ── output ──────────────────────────────────────────────────────────────────
const lines = [];
function out(s) { const t = s === undefined ? '' : String(s); lines.push(t); console.log(t); }

/** Fixed-width table, so the file is readable without a spreadsheet. */
function table(rows) {
  if (!rows.length) { out('  (no rows)'); return; }
  const cols = Object.keys(rows[0]);
  // DATE columns come back as JS Date objects; render them as plain YYYY-MM-DD
  // so the table stays narrow enough to read in a text file.
  const show = (v) => {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return String(v);
  };
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => show(r[c]).length)));
  const sep = '+' + w.map((n) => '-'.repeat(n + 2)).join('+') + '+';
  out(sep);
  out('| ' + cols.map((c, i) => c.padEnd(w[i])).join(' | ') + ' |');
  out(sep);
  for (const r of rows) out('| ' + cols.map((c, i) => show(r[c]).padEnd(w[i])).join(' | ') + ' |');
  out(sep);
  out(`(${rows.length} row${rows.length === 1 ? '' : 's'})`);
}

// ── the report query ────────────────────────────────────────────────────────
// Byte-for-byte the same resolution rule as read.ts's resolveJobInvoiceLinks()
// and the UI's resolveJobInvoiceRecord(): company-scoped, void invoices
// excluded, invoice numbers compared case- and whitespace-normalised, and a
// per-invoice claim count so a number claimed by two jobs is AMBIGUOUS rather
// than silently resolved to one of them.
const REPORT_CTE = `
WITH linked AS (
  SELECT j.id AS job_id, j.company_code, j.job_number, j.customer_name_raw,
         j.status AS job_status, j.stage AS job_stage, j.value AS job_value,
         j.invoice_num, j.invoice_date, j.invoice_due, j.invoice_created, j.invoice_status,
         COUNT(i.id)::int                               AS match_count,
         (ARRAY_AGG(i.id             ORDER BY i.id))[1] AS matched_invoice_id,
         (ARRAY_AGG(i.invoice_number ORDER BY i.id))[1] AS matched_invoice_number
    FROM rel_jobs j
    LEFT JOIN rel_invoices i
      ON i.company_code = j.company_code
     AND COALESCE(i.status, '') <> 'void'
     AND ( i.job_id = j.id
           OR ( j.invoice_num IS NOT NULL
                AND UPPER(BTRIM(i.invoice_number)) = UPPER(BTRIM(j.invoice_num)) ) )
   WHERE j.invoice_num IS NOT NULL OR j.invoice_created = true
   GROUP BY j.id
), cross_company AS (
  SELECT l.job_id,
         COUNT(x.id)::int AS other_company_matches,
         STRING_AGG(DISTINCT x.company_code, ', ') AS other_companies
    FROM linked l
    LEFT JOIN rel_invoices x
      ON x.company_code <> l.company_code
     AND COALESCE(x.status, '') <> 'void'
     AND l.invoice_num IS NOT NULL
     AND UPPER(BTRIM(x.invoice_number)) = UPPER(BTRIM(l.invoice_num))
   GROUP BY l.job_id
), shared AS (
  SELECT matched_invoice_id AS inv_id, COUNT(*)::int AS claiming_jobs
    FROM linked WHERE match_count = 1 AND matched_invoice_id IS NOT NULL
   GROUP BY matched_invoice_id
), report AS (
  SELECT l.company_code, l.job_id, l.job_number, l.customer_name_raw,
         l.job_status, l.job_stage, l.job_value,
         l.invoice_num, l.invoice_date, l.invoice_due, l.invoice_created, l.invoice_status,
         l.match_count AS matching_rel_invoices,
         CASE WHEN l.match_count = 1 AND COALESCE(sh.claiming_jobs, 0) <= 1
              THEN l.matched_invoice_id END     AS relational_invoice_id,
         CASE WHEN l.match_count = 1 AND COALESCE(sh.claiming_jobs, 0) <= 1
              THEN l.matched_invoice_number END AS relational_invoice_number,
         COALESCE(c.other_company_matches, 0)   AS same_number_in_other_company,
         c.other_companies,
         COALESCE(sh.claiming_jobs, 0)          AS jobs_claiming_same_invoice,
         (SELECT COUNT(*)::int FROM rel_payments p
           WHERE p.owner_type = 'job' AND p.owner_id = l.job_id)              AS job_payment_count,
         (SELECT COALESCE(SUM(p.amount), 0) FROM rel_payments p
           WHERE p.owner_type = 'job' AND p.owner_id = l.job_id)              AS job_payment_total,
         (SELECT COUNT(*)::int FROM rel_payments p
           WHERE p.owner_type = 'job' AND p.owner_id = l.job_id
             AND p.method = 'Credit')                                         AS job_credit_payment_count,
         (SELECT COUNT(*)::int FROM rel_credit_notes cn
           WHERE cn.company_code = l.company_code
             AND l.invoice_num IS NOT NULL AND cn.applied_to IS NOT NULL
             AND UPPER(BTRIM(cn.applied_to)) LIKE '%' || UPPER(BTRIM(l.invoice_num)) || '%')
                                                                              AS credit_notes_naming_invoice,
         CASE
           WHEN l.invoice_num IS NULL OR BTRIM(l.invoice_num) = ''              THEN 'NO_NUMBER'
           WHEN COALESCE(c.other_company_matches, 0) > 0 AND l.match_count = 0  THEN 'INVALID'
           WHEN l.match_count = 1 AND COALESCE(sh.claiming_jobs, 0) > 1         THEN 'AMBIGUOUS'
           WHEN l.match_count = 1                                              THEN 'MATCHED'
           WHEN l.match_count = 0                                              THEN 'ORPHANED'
           ELSE 'AMBIGUOUS'
         END AS classification
    FROM linked l
    LEFT JOIN cross_company c ON c.job_id = l.job_id
    LEFT JOIN shared sh       ON sh.inv_id = l.matched_invoice_id
)`;

const SECTIONS = [
  {
    title: 'SECTION 1 — SUMMARY BY COMPANY AND CLASSIFICATION',
    sql: `${REPORT_CTE}
      SELECT company_code, classification, COUNT(*)::int AS jobs,
             SUM(CASE WHEN job_payment_count > 0 THEN 1 ELSE 0 END)::int AS with_job_payments,
             SUM(job_payment_total) AS job_payment_total
        FROM report GROUP BY company_code, classification
       ORDER BY company_code, classification`,
  },
  {
    title: 'SECTION 2 — EVERY JOB NEEDING ATTENTION\n (ORPHANED / AMBIGUOUS / INVALID / NO_NUMBER — full detail)',
    sql: `${REPORT_CTE}
      SELECT company_code, job_id, job_number, invoice_num, invoice_created, invoice_status,
             invoice_date, invoice_due, job_status, job_stage, job_value, customer_name_raw,
             matching_rel_invoices, relational_invoice_id, same_number_in_other_company,
             other_companies, jobs_claiming_same_invoice, job_payment_count, job_payment_total,
             job_credit_payment_count, credit_notes_naming_invoice, classification
        FROM report WHERE classification <> 'MATCHED'
       ORDER BY classification, company_code, invoice_num
       LIMIT $1`,
    params: () => [ROW_LIMIT],
  },
  {
    title: 'SECTION 3 — ORPHANED JOBS THAT STILL CARRY MONEY\n (review these first: they are real invoices with real payments)',
    sql: `${REPORT_CTE}
      SELECT company_code, job_id, job_number, invoice_num, invoice_status,
             job_payment_count, job_payment_total, job_credit_payment_count,
             credit_notes_naming_invoice, customer_name_raw
        FROM report
       WHERE classification = 'ORPHANED'
         AND (job_payment_count > 0 OR credit_notes_naming_invoice > 0)
       ORDER BY job_payment_total DESC, invoice_num
       LIMIT $1`,
    params: () => [ROW_LIMIT],
  },
  {
    title: 'SECTION 4 — MATCHED JOBS (confirmation only)\n These now collapse to ONE canonical invoice row in the UI.',
    sql: `${REPORT_CTE}
      SELECT company_code, job_number, invoice_num, relational_invoice_id, relational_invoice_number
        FROM report WHERE classification = 'MATCHED'
       ORDER BY company_code, invoice_num LIMIT $1`,
    params: () => [Math.min(ROW_LIMIT, 100)],
  },
  {
    title: 'SECTION 5 — rel_invoices NOT reachable from any job\n (standalone/manual invoices — expected, listed for completeness)',
    sql: `${REPORT_CTE}
      SELECT i.company_code, i.invoice_number, i.contact_name, i.status,
             i.job_id, i.job_number_raw, i.reference, i.quote_number_raw
        FROM rel_invoices i
       WHERE COALESCE(i.status, '') <> 'void'
         AND NOT EXISTS (SELECT 1 FROM report r WHERE r.relational_invoice_id = i.id)
       ORDER BY i.company_code, i.invoice_number LIMIT $1`,
    params: () => [Math.min(ROW_LIMIT, 200)],
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
    // Postgres itself now refuses every write for the rest of this session.
    await client.query('BEGIN TRANSACTION READ ONLY');

    const who = await client.query('SELECT current_database() AS db, current_user AS usr, now() AS at');
    out('');
    out('==============================================================');
    out(' SIGNACORE — JOB-SIDE INVOICE LINKAGE DIAGNOSTIC (READ ONLY)');
    out('==============================================================');
    out(` database : ${who.rows[0].db}`);
    out(` user     : ${who.rows[0].usr}`);
    out(` run at   : ${new Date(who.rows[0].at).toISOString()}`);
    out(` url      : ${redacted}`);
    out(' mode     : BEGIN TRANSACTION READ ONLY — nothing can be written');
    out('');

    for (const s of SECTIONS) {
      out('');
      out('==============================================================');
      out(' ' + s.title);
      out('==============================================================');
      const res = await client.query(s.sql, s.params ? s.params() : []);
      table(res.rows);
    }

    await client.query('ROLLBACK');
    out('');
    out('Diagnostic complete. Nothing was written — the transaction was READ ONLY');
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
