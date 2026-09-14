#!/usr/bin/env node
/* ============================================================================
 * diagnose-job-invoice-discount.js
 * Signacore — READ-ONLY diagnostic for a single job-derived invoice's
 * discount and total (2026-09-14 · INV-00057 / SNS-00083).
 * ============================================================================
 *
 * WHAT THIS ANSWERS
 *   For ONE job number, it prints the facts the Sales and Accounting invoice
 *   rows are built from, side by side:
 *     JOB      value, discount_pct, setup_fee, invoice fields, line subtotals
 *     QUOTE    the company-safe source quote: discount_pct, setup_fee, lines
 *     INVOICE  whether a rel_invoices record exists for it at all
 *     PAYMENTS the canonical chain total
 *   and then states, from those numbers alone, what each screen derives.
 *
 *   It exists to confirm the diagnosis behind the 2026-09-14 (c) repair: a
 *   historical transaction carries its discount on the JOB while its source
 *   quote still reads 0, because the quote→job→invoice cascade only arrived on
 *   2026-09-07. Sales rebuilt the total from the quote and so showed the
 *   PRE-discount figure.
 *
 * THIS SCRIPT IS STRICTLY READ ONLY
 *   * Every statement is a SELECT. No INSERT, UPDATE, DELETE, TRUNCATE, ALTER,
 *     CREATE, DROP, MERGE or GRANT appears anywhere in this file.
 *   * All work happens inside BEGIN TRANSACTION READ ONLY, so Postgres itself
 *     refuses any write, and it always ends with ROLLBACK.
 *   * No temp tables, no views, no server-side state.
 *   * DATABASE_URL is redacted before it is echoed; no password is ever printed.
 *   Safe to run against production. It changes nothing and locks nothing.
 *
 * HOW TO RUN — ONE COMMAND
 *   PowerShell, from the repo root:
 *     cd backend
 *     $env:DATABASE_URL = "<your production connection string>"
 *     node scripts/diagnose-job-invoice-discount.js --job SNS-00083
 *
 *   Render shell (DATABASE_URL already set):
 *     cd backend && node scripts/diagnose-job-invoice-discount.js --job SNS-00083
 *
 *   Or via the script entry:  npm run diagnose:job-invoice-discount -- --job SNS-00083
 * ==========================================================================*/

'use strict';

const path = require('path');

let Pool;
try {
  ({ Pool } = require('pg'));
} catch (e) {
  console.error('Could not load the "pg" driver.\n' +
    'Run this from the backend folder (where node_modules lives):\n' +
    '  cd backend\n  node scripts/diagnose-job-invoice-discount.js --job SNS-00083');
  process.exit(1);
}
try { require('dotenv').config(); } catch (e) { /* .env is optional */ }

const argv = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}
const JOB_NUMBER = argValue('--job', 'SNS-00083');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set.\n\nPowerShell:\n' +
    '  $env:DATABASE_URL = "<connection string>"\n' +
    '  node scripts/diagnose-job-invoice-discount.js --job ' + JOB_NUMBER);
  process.exit(1);
}
function resolveSsl(url) {
  if (!url) return undefined;
  return /render\.com|\.com\/|sslmode=require/i.test(url) ? { rejectUnauthorized: false } : undefined;
}

function table(rows) {
  if (!rows.length) { console.log('  (no rows)'); return; }
  const cols = Object.keys(rows[0]);
  const show = (v) => {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return String(v);
  };
  const w = cols.map(c => Math.max(c.length, ...rows.map(r => show(r[c]).length)));
  console.log('  ' + cols.map((c, i) => c.padEnd(w[i])).join('  '));
  console.log('  ' + w.map(n => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log('  ' + cols.map((c, i) => show(r[c]).padEnd(w[i])).join('  '));
}
const money = (n) => 'R ' + Number(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: resolveSsl(DATABASE_URL), max: 1, connectionTimeoutMillis: 15000 });
  const redacted = DATABASE_URL.replace(/\/\/([^:]+):[^@]*@/, '//$1:****@');
  let client;
  try { client = await pool.connect(); }
  catch (err) {
    console.error('\nCould not connect to the database.\n  ' + (err && err.message ? err.message : err) +
      '\n\n  Checked DATABASE_URL: ' + redacted);
    await pool.end().catch(() => {});
    process.exit(1);
  }

  try {
    await client.query('BEGIN TRANSACTION READ ONLY');

    const who = await client.query('SELECT current_database() AS db, current_user AS usr, now() AS at');
    console.log('');
    console.log('==============================================================');
    console.log(' SIGNACORE — JOB INVOICE DISCOUNT DIAGNOSTIC (READ ONLY)');
    console.log('==============================================================');
    console.log(' job      : ' + JOB_NUMBER);
    console.log(' database : ' + who.rows[0].db + '   user: ' + who.rows[0].usr);
    console.log(' url      : ' + redacted);
    console.log(' mode     : BEGIN TRANSACTION READ ONLY  (ends in ROLLBACK)');

    const jobRes = await client.query(
      `SELECT id, source_id, job_number, company_code, quote_id, quote_number_raw,
              invoice_num, invoice_created, invoice_status, invoice_date, invoice_due,
              value, discount_pct, setup_fee
         FROM rel_jobs WHERE job_number = $1`, [JOB_NUMBER]);
    console.log('\n-- JOB ------------------------------------------------------');
    table(jobRes.rows);
    if (jobRes.rowCount === 0) {
      console.log('\n  No job with that number. Nothing further to report.');
      return;
    }
    const job = jobRes.rows[0];

    const jobLines = await client.query(
      `SELECT line_index, description, qty, unit_price, subtotal
         FROM rel_job_line_items WHERE job_id = $1 ORDER BY line_index`, [job.id]);
    console.log('\n-- JOB LINE ITEMS -------------------------------------------');
    table(jobLines.rows);
    const jobLinesSub = jobLines.rows.reduce((s, l) => s + Number(l.subtotal || 0), 0);

    // The company-safe source quote: stable FK first, and the company_code must
    // match — never a number-only cross-company lookup.
    const quoteRes = await client.query(
      `SELECT q.id, q.quote_number, q.company_code, q.discount_pct, q.setup_fee,
              q.subtotal, q.vat_amount, q.total, q.converted_job_id
         FROM rel_quotes q
        WHERE q.id = $1 AND q.company_code = $2`, [job.quote_id, job.company_code]);
    console.log('\n-- SOURCE QUOTE (stable FK, same company only) --------------');
    table(quoteRes.rows);
    const quote = quoteRes.rows[0] || null;

    let quoteLinesSub = 0;
    if (quote) {
      const qLines = await client.query(
        `SELECT line_index, description, qty, unit_price, subtotal
           FROM rel_quote_line_items WHERE quote_id = $1 ORDER BY line_index`, [quote.id]);
      console.log('\n-- QUOTE LINE ITEMS -----------------------------------------');
      table(qLines.rows);
      quoteLinesSub = qLines.rows.reduce((s, l) => s + Number(l.subtotal || 0), 0);
    }

    const invRes = await client.query(
      `SELECT id, invoice_number, company_code, status, job_id, quote_id, job_number_raw, reference
         FROM rel_invoices
        WHERE COALESCE(status,'') <> 'void'
          AND company_code = $1
          AND (job_id = $2 OR reference = $3 OR job_number_raw = $3
               OR ($4::text IS NOT NULL AND invoice_number = $4::text))`,
      [job.company_code, job.id, job.job_number, job.invoice_num]);
    console.log('\n-- ACCOUNTING RECORD (rel_invoices) -------------------------');
    if (invRes.rowCount === 0) {
      console.log('  (none — this is a historical "No accounting record" job invoice)');
    } else {
      table(invRes.rows);
      const invLines = await client.query(
        `SELECT invoice_id, line_index, description, qty, unit_amount, tax_type
           FROM rel_invoice_line_items WHERE invoice_id = ANY($1::bigint[]) ORDER BY invoice_id, line_index`,
        [invRes.rows.map(r => r.id)]);
      console.log('\n-- ACCOUNTING RECORD LINE ITEMS -----------------------------');
      table(invLines.rows);
    }

    const payRes = await client.query(
      `SELECT COALESCE(SUM(p.amount),0) AS chain_paid, COUNT(*) AS rows
         FROM rel_payments p
        WHERE (p.owner_type = 'job'   AND p.owner_id = $1)
           OR (p.owner_type = 'quote' AND $2::bigint IS NOT NULL AND p.owner_id = $2::bigint)
           OR (p.owner_type = 'invoice' AND p.owner_id = ANY($3::bigint[]))`,
      [job.id, quote ? quote.id : null, invRes.rows.map(r => r.id)]);
    console.log('\n-- CANONICAL CHAIN PAYMENTS --------------------------------');
    table(payRes.rows);

    /* ── what each screen derives from exactly those numbers ─────────────── */
    const jobValue = Number(job.value || 0);
    const jobPct = Number(job.discount_pct || 0);
    const jobSetup = Number(job.setup_fee || 0);
    const quotePct = quote ? Number(quote.discount_pct || 0) : 0;
    const quoteSetup = quote ? Number(quote.setup_fee || 0) : 0;
    const paid = Number(payRes.rows[0].chain_paid || 0);

    const salesOldTotal = quote
      ? (quoteLinesSub - quoteLinesSub * (quotePct / 100) + quoteSetup) * 1.15
      : jobValue;
    const jobDiscAmt = jobLinesSub * (jobPct / 100);

    console.log('\n-- DERIVATION ----------------------------------------------');
    console.log('  job.value (authoritative total)      : ' + money(jobValue));
    console.log('  job.discount_pct                     : ' + jobPct + '%');
    console.log('  job line subtotal (ex VAT)           : ' + money(jobLinesSub));
    console.log('  discount off the job subtotal        : ' + money(jobDiscAmt));
    console.log('  quote.discount_pct                   : ' + (quote ? quotePct + '%' : '(no same-company quote)'));
    console.log('  quote line subtotal (ex VAT)         : ' + (quote ? money(quoteLinesSub) : '—'));
    console.log('  chain payments                       : ' + money(paid));
    console.log('');
    console.log('  ACCOUNTING / after the repair, SALES : ' + money(jobValue) +
                '   balance ' + money(jobValue - paid));
    console.log('  SALES BEFORE the repair (quote rebuild): ' + money(salesOldTotal) +
                '   balance ' + money(salesOldTotal - paid));
    if (Math.abs(salesOldTotal - jobValue) > 0.01) {
      console.log('');
      console.log('  >> AFFECTED: the quote rebuild differs from the job\'s own value by ' +
                  money(Math.abs(salesOldTotal - jobValue)) + '.');
      if (quote && Math.abs(quotePct - jobPct) > 0.0001) {
        console.log('     Cause: the job carries ' + jobPct + '% while its source quote carries ' +
                    quotePct + '% — the pre-cascade historical shape.');
      }
    } else {
      console.log('\n  >> Not affected: quote rebuild and job value agree.');
    }
  } finally {
    try { await client.query('ROLLBACK'); } catch (e) { /* nothing was written anyway */ }
    client.release();
    await pool.end().catch(() => {});
  }

  console.log('\nNothing was written. The transaction was READ ONLY and was rolled back.\n');
})();
