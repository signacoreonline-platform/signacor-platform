#!/usr/bin/env node
/* ============================================================================
 * diagnose-audio-access-payment.js
 * SIGNACORE — READ-ONLY payment diagnostic for ONE production case
 * Audio Access:  SQ-00108  ->  SNS-00110  ->  INV-00103
 * Target payment: R5,840.22, 2026-08-02, EFT
 * Created 2026-08-25.
 * ============================================================================
 *
 * WHY THIS EXISTS
 *   The invoice repair is done — INV-00103 now totals R7,300.27 and is hard-
 *   linked to SNS-00110 and SQ-00108. A payment of R5,840.22 was observed
 *   against the Quote and the Job, but not against the invoice. Before ANY
 *   reallocation, we need to know, from production and not from assumption:
 *   which single row is that payment, who owns it right now, and is there
 *   exactly one of it.
 *
 * WHAT "AUTHORITATIVE" MEANS HERE — READ THIS BEFORE READING THE OUTPUT
 *   relational_cutover.payments is FALSE, and that is a red herring. There is
 *   no top-level `payments` array in platform_state: a payment always lives
 *   INSIDE a quote, a job or an invoice. Accordingly:
 *     * read.ts has no builder and no SECTION_JSON_KEY entry for 'payments';
 *     * api.ts never calls requireCutOver('payments') — POST/PUT/DELETE
 *       /payments gate on the OWNER's section (jobs / accInvoices / quotes);
 *     * index.html's addPayment gates on `addOwner.relSection`, the owner's
 *       section, for the same reason;
 *     * buildQuotesJson / buildJobsJson / buildInvoicesJson each call
 *       paymentsFor(...) -> rel_payments, unconditionally.
 *   Quotes, jobs and accInvoices are all cut over. Therefore, for THIS chain,
 *   rel_payments IS the authoritative store, and the platform_state copy is a
 *   frozen pre-cutover snapshot. Section 7 reports that snapshot anyway, for
 *   comparison only — it is explicitly labelled OBSERVATIONAL.
 *
 * THIS SCRIPT IS STRICTLY READ ONLY
 *   * Every statement is a SELECT. No INSERT, UPDATE, DELETE, TRUNCATE,
 *     ALTER, CREATE, DROP or GRANT anywhere in this file.
 *   * All work happens inside BEGIN TRANSACTION READ ONLY, so Postgres itself
 *     refuses any write even if one were somehow introduced.
 *   * It always ends with ROLLBACK. No temp tables, no server-side state.
 *   * It allocates nothing, moves nothing and creates no payment.
 *
 * HOW TO RUN (PowerShell, from the repo root)
 *   cd backend
 *   $env:DATABASE_URL = "<Render EXTERNAL connection string>"
 *   node scripts/diagnose-audio-access-payment.js
 *
 *   Optional flags:
 *     --amount <n>     default 5840.22
 *     --date <iso>     default 2026-08-02
 *     --quote/--job/--invoice <num>
 *     --out <path>     report file (default ./audio-access-payment-report.txt)
 *     --limit <n>      rows per detail section (default 200)
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
    '  cd backend\n  node scripts/diagnose-audio-access-payment.js');
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
const TARGET_AMOUNT = Number(argValue('--amount', '5840.22'));
const TARGET_DATE = argValue('--date', '2026-08-02');
const ROW_LIMIT = Number(argValue('--limit', '200')) || 200;
const OUT_PATH = path.resolve(argValue('--out',
  path.join(process.cwd(), 'audio-access-payment-report.txt')));

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set.\n\nPowerShell:\n' +
    '  $env:DATABASE_URL = "<connection string>"\n' +
    '  node scripts/diagnose-audio-access-payment.js');
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

const JSON_ARR = (key) =>
  "CASE WHEN jsonb_typeof(ps.data->'" + key + "') = 'array' THEN ps.data->'" + key + "' ELSE '[]'::jsonb END";

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

  const q = async (sql, params = []) => (await client.query(sql, params)).rows;

  try {
    await client.query('BEGIN TRANSACTION READ ONLY');

    const who = (await client.query('SELECT current_database() AS db, current_user AS usr, now() AS at')).rows[0];
    out('');
    out('==============================================================');
    out(' SIGNACORE — AUDIO ACCESS PAYMENT DIAGNOSTIC (READ ONLY)');
    out('==============================================================');
    out(` chain    : ${QUOTE_NUM} -> ${JOB_NUM} -> ${INV_NUM}`);
    out(` looking  : R${TARGET_AMOUNT.toFixed(2)} dated ${TARGET_DATE}`);
    out(` database : ${who.db}`);
    out(` user     : ${who.usr}`);
    out(` run at   : ${new Date(who.at).toISOString()}`);
    out(` url      : ${redacted}`);
    out(' mode     : BEGIN TRANSACTION READ ONLY — nothing can be written');
    out('');

    // ══ 0. AUTHORITY ═══════════════════════════════════════════════════════
    out('==============================================================');
    out(' SECTION 0 — CUTOVER FLAGS, AND WHAT THEY ACTUALLY GOVERN');
    out('==============================================================');
    table(await q(`SELECT section, enabled, enabled_at FROM relational_cutover ORDER BY section`));
    out('');
    out('  READ THIS BEFORE THE REST. `payments = false` does NOT make');
    out('  platform_state authoritative for a payment on a cut-over record:');
    out('    * there is no top-level `payments` array in platform_state — a');
    out('      payment always lives inside a quote, job or invoice;');
    out('    * read.ts has no builder / SECTION_JSON_KEY entry for it;');
    out('    * api.ts gates POST/PUT/DELETE /payments on the OWNER section');
    out('      (jobs / accInvoices / quotes) — requireCutOver(\'payments\')');
    out('      is never called anywhere in the codebase;');
    out('    * buildQuotesJson/buildJobsJson/buildInvoicesJson each read their');
    out('      payments from rel_payments unconditionally.');
    out('  Quotes, jobs and accInvoices are cut over, so for THIS chain');
    out('  rel_payments is AUTHORITATIVE and the JSON copy is a frozen');
    out('  pre-cutover snapshot (Section 7, observational only).');

    // ══ 1. THE THREE RECORDS ═══════════════════════════════════════════════
    out('');
    out('==============================================================');
    out(' SECTION 1 — THE THREE RECORDS (identity + current money)');
    out('==============================================================');
    const quotes = await q(
      `SELECT id, source_id, quote_number, company_code, customer_id, customer_name_raw, status, total, row_version
         FROM rel_quotes WHERE UPPER(BTRIM(quote_number)) = UPPER(BTRIM($1)) ORDER BY id`, [QUOTE_NUM]);
    const jobs = await q(
      `SELECT id, source_id, job_number, company_code, customer_id, customer_name_raw, status, stage,
              value, invoice_num, invoice_created, invoice_status, quote_id, row_version
         FROM rel_jobs WHERE UPPER(BTRIM(job_number)) = UPPER(BTRIM($1)) ORDER BY id`, [JOB_NUM]);
    const invs = await q(
      `SELECT i.id, i.source_id, i.invoice_number, i.company_code, i.customer_id, i.contact_name,
              i.status, i.issue_date, i.due_date, i.job_id, i.quote_id, i.reference, i.row_version,
              ROUND(COALESCE((SELECT SUM(l.qty * l.unit_amount) FROM rel_invoice_line_items l WHERE l.invoice_id = i.id),0),2) AS subtotal_excl_vat,
              ROUND(COALESCE((SELECT SUM(l.qty * l.unit_amount * CASE WHEN l.tax_type='15%' THEN 1.15 ELSE 1 END) FROM rel_invoice_line_items l WHERE l.invoice_id = i.id),0),2) AS total_incl_vat
         FROM rel_invoices i WHERE UPPER(BTRIM(i.invoice_number)) = UPPER(BTRIM($1)) ORDER BY i.id`, [INV_NUM]);
    out(' QUOTE');
    record(quotes);
    out(' JOB');
    record(jobs);
    out(' INVOICE');
    record(invs);

    const quoteId = quotes.length === 1 ? quotes[0].id : null;
    const jobId = jobs.length === 1 ? jobs[0].id : null;
    const invId = invs.length === 1 ? invs[0].id : null;
    const invTotal = invs.length === 1 ? Number(invs[0].total_incl_vat) : null;

    // ══ 2. AUTHORITATIVE PAYMENTS ON EACH OF THE THREE ═════════════════════
    out('');
    out('==============================================================');
    out(' SECTION 2 — AUTHORITATIVE (rel_payments) ON THIS CHAIN');
    out(' Every payment owned by this quote, this job or this invoice.');
    out('==============================================================');
    const chainPayments = await q(
      `SELECT p.id AS rel_payment_id, p.source_id, p.owner_type, p.owner_id,
              CASE p.owner_type
                WHEN 'quote'   THEN (SELECT quote_number   FROM rel_quotes   WHERE id = p.owner_id)
                WHEN 'job'     THEN (SELECT job_number     FROM rel_jobs     WHERE id = p.owner_id)
                WHEN 'invoice' THEN (SELECT invoice_number FROM rel_invoices WHERE id = p.owner_id)
              END AS owner_number,
              p.line_index, p.amount, p.payment_date, p.method, p.reference, p.notes,
              p.row_version, p.created_at, p.updated_at,
              (p.legacy_data IS NOT NULL AND p.legacy_data <> '{}'::jsonb) AS has_legacy_data,
              'AUTHORITATIVE' AS source_authority
         FROM rel_payments p
        WHERE (p.owner_type = 'quote'   AND p.owner_id = $1)
           OR (p.owner_type = 'job'     AND p.owner_id = $2)
           OR (p.owner_type = 'invoice' AND p.owner_id = $3)
        ORDER BY p.owner_type, p.line_index, p.id`,
      [quoteId, jobId, invId]);
    table(chainPayments);
    out('');
    out('  NOTE ON "IT APPEARED AGAINST BOTH THE QUOTE AND THE JOB":');
    out('  rel_payments carries UNIQUE (owner_type, owner_id, line_index) and');
    out('  each row has exactly ONE owner. index.html\'s reconcileJobInvoice()');
    out('  MERGES a linked quote\'s payments into the job\'s displayed list,');
    out('  de-duplicating by payment id — so one payment showing on both');
    out('  screens is ONE row displayed twice, never two payments. If two rows');
    out('  really exist, they appear as two rows in the table above.');

    // ══ 3. EVERY CANDIDATE BY AMOUNT ═══════════════════════════════════════
    out('');
    out('==============================================================');
    out(` SECTION 3 — EVERY rel_payments ROW MATCHING R${TARGET_AMOUNT.toFixed(2)}`);
    out(' (any owner, any company — this is the duplicate-identity check)');
    out('==============================================================');
    table(await q(
      `SELECT p.id AS rel_payment_id, p.source_id, p.owner_type, p.owner_id,
              CASE p.owner_type
                WHEN 'quote'   THEN (SELECT quote_number   FROM rel_quotes   WHERE id = p.owner_id)
                WHEN 'job'     THEN (SELECT job_number     FROM rel_jobs     WHERE id = p.owner_id)
                WHEN 'invoice' THEN (SELECT invoice_number FROM rel_invoices WHERE id = p.owner_id)
              END AS owner_number,
              CASE p.owner_type
                WHEN 'quote'   THEN (SELECT company_code FROM rel_quotes   WHERE id = p.owner_id)
                WHEN 'job'     THEN (SELECT company_code FROM rel_jobs     WHERE id = p.owner_id)
                WHEN 'invoice' THEN (SELECT company_code FROM rel_invoices WHERE id = p.owner_id)
              END AS owner_company,
              CASE p.owner_type
                WHEN 'quote'   THEN (SELECT customer_name_raw FROM rel_quotes WHERE id = p.owner_id)
                WHEN 'job'     THEN (SELECT customer_name_raw FROM rel_jobs   WHERE id = p.owner_id)
                WHEN 'invoice' THEN (SELECT contact_name      FROM rel_invoices WHERE id = p.owner_id)
              END AS owner_customer,
              p.amount, p.payment_date, p.method, p.reference, p.notes,
              (p.payment_date = $2::date) AS date_matches
         FROM rel_payments p
        WHERE ABS(p.amount - $1::numeric) < 0.005
        ORDER BY p.id LIMIT $3`,
      [TARGET_AMOUNT, TARGET_DATE, ROW_LIMIT]));

    out('');
    out('==============================================================');
    out(` SECTION 4 — EVERY rel_payments ROW DATED ${TARGET_DATE}`);
    out(' (regardless of amount — catches a mistyped or part-captured amount)');
    out('==============================================================');
    table(await q(
      `SELECT p.id AS rel_payment_id, p.owner_type, p.owner_id,
              CASE p.owner_type
                WHEN 'quote'   THEN (SELECT quote_number   FROM rel_quotes   WHERE id = p.owner_id)
                WHEN 'job'     THEN (SELECT job_number     FROM rel_jobs     WHERE id = p.owner_id)
                WHEN 'invoice' THEN (SELECT invoice_number FROM rel_invoices WHERE id = p.owner_id)
              END AS owner_number,
              p.amount, p.payment_date, p.method, p.reference, p.notes
         FROM rel_payments p WHERE p.payment_date = $1::date ORDER BY p.id LIMIT $2`,
      [TARGET_DATE, ROW_LIMIT]));

    out('');
    out('==============================================================');
    out(' SECTION 5 — DUPLICATE PAYMENT IDENTITY ACROSS THE WHOLE TABLE');
    out(' Same amount AND same date on more than one row.');
    out('==============================================================');
    table(await q(
      `SELECT amount, payment_date, COUNT(*)::int AS occurrences,
              STRING_AGG(id::text, ', ' ORDER BY id) AS rel_payment_ids,
              STRING_AGG(owner_type || ':' || owner_id, ', ' ORDER BY id) AS owners
         FROM rel_payments GROUP BY amount, payment_date
        HAVING COUNT(*) > 1 ORDER BY amount DESC LIMIT $1`, [ROW_LIMIT]));

    // ══ 6. WHO ELSE COULD BE CLAIMING IT ═══════════════════════════════════
    out('');
    out('==============================================================');
    out(' SECTION 6 — ANY OTHER INVOICE FOR THIS CUSTOMER, AND WHAT IT HOLDS');
    out(' (an invoice already claiming this payment would make reallocation');
    out('  a MISALLOCATED case, not an UNALLOCATED one)');
    out('==============================================================');
    table(await q(
      `WITH cust AS (
         SELECT customer_id, customer_name_raw FROM rel_quotes WHERE id = $1
       )
       SELECT i.id AS invoice_rel_id, i.invoice_number, i.company_code, i.status,
              i.job_id, i.quote_id, i.reference,
              ROUND(COALESCE((SELECT SUM(l.qty*l.unit_amount*CASE WHEN l.tax_type='15%' THEN 1.15 ELSE 1 END)
                                FROM rel_invoice_line_items l WHERE l.invoice_id=i.id),0),2) AS total_incl_vat,
              (SELECT COUNT(*)::int FROM rel_payments p WHERE p.owner_type='invoice' AND p.owner_id=i.id) AS payment_count,
              ROUND(COALESCE((SELECT SUM(p.amount) FROM rel_payments p WHERE p.owner_type='invoice' AND p.owner_id=i.id),0),2) AS paid_total
         FROM rel_invoices i, cust
        WHERE (cust.customer_id IS NOT NULL AND i.customer_id = cust.customer_id)
           OR UPPER(BTRIM(COALESCE(i.contact_name,''))) = UPPER(BTRIM(COALESCE(cust.customer_name_raw,'~')))
        ORDER BY i.id LIMIT $2`, [quoteId, ROW_LIMIT]));

    // ══ 7. OBSERVATIONAL: platform_state JSON ══════════════════════════════
    out('');
    out('==============================================================');
    out(' SECTION 7 — OBSERVATIONAL ONLY: platform_state JSON payments');
    out(' A frozen PRE-CUTOVER snapshot. NOT authoritative for this chain.');
    out(' Shown so an authoritative row can be compared against what the');
    out(' JSON remembers — a difference is history, not a discrepancy.');
    out('==============================================================');
    out(' quote payments in JSON:');
    table(await q(
      `SELECT x->>'num' AS quote_num, p.ord AS line_index, p->>'id' AS json_payment_id,
              p->>'amount' AS amount, p->>'date' AS date, p->>'method' AS method,
              p->>'reference' AS reference, p->>'notes' AS notes, 'OBSERVATIONAL' AS source_authority
         FROM platform_state ps, jsonb_array_elements(${JSON_ARR('quotes')}) x,
              LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(x->'payments')='array' THEN x->'payments' ELSE '[]'::jsonb END)
                      WITH ORDINALITY AS p(p, ord)
        WHERE ps.id = 1 AND UPPER(BTRIM(COALESCE(x->>'num',''))) = UPPER(BTRIM($1)) ORDER BY p.ord LIMIT $2`,
      [QUOTE_NUM, ROW_LIMIT]));
    out(' job payments in JSON:');
    table(await q(
      `SELECT x->>'num' AS job_num, p.ord AS line_index, p->>'id' AS json_payment_id,
              p->>'amount' AS amount, p->>'date' AS date, p->>'method' AS method,
              p->>'reference' AS reference, p->>'notes' AS notes, 'OBSERVATIONAL' AS source_authority
         FROM platform_state ps, jsonb_array_elements(${JSON_ARR('jobs')}) x,
              LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(x->'payments')='array' THEN x->'payments' ELSE '[]'::jsonb END)
                      WITH ORDINALITY AS p(p, ord)
        WHERE ps.id = 1 AND UPPER(BTRIM(COALESCE(x->>'num',''))) = UPPER(BTRIM($1)) ORDER BY p.ord LIMIT $2`,
      [JOB_NUM, ROW_LIMIT]));
    out(' accInvoices payments in JSON:');
    table(await q(
      `SELECT x->>'number' AS invoice_num, p.ord AS line_index, p->>'id' AS json_payment_id,
              p->>'amount' AS amount, p->>'date' AS date, p->>'method' AS method,
              p->>'reference' AS reference, p->>'notes' AS notes, 'OBSERVATIONAL' AS source_authority
         FROM platform_state ps, jsonb_array_elements(${JSON_ARR('accInvoices')}) x,
              LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(x->'payments')='array' THEN x->'payments' ELSE '[]'::jsonb END)
                      WITH ORDINALITY AS p(p, ord)
        WHERE ps.id = 1 AND UPPER(BTRIM(COALESCE(x->>'number',''))) = UPPER(BTRIM($1)) ORDER BY p.ord LIMIT $2`,
      [INV_NUM, ROW_LIMIT]));
    out(' ANY JSON payment anywhere matching the target amount:');
    table(await q(
      `SELECT 'quotes' AS collection, x->>'num' AS doc, p->>'amount' AS amount, p->>'date' AS date, p->>'method' AS method, p->>'id' AS json_payment_id
         FROM platform_state ps, jsonb_array_elements(${JSON_ARR('quotes')}) x,
              LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(x->'payments')='array' THEN x->'payments' ELSE '[]'::jsonb END) p
        WHERE ps.id = 1 AND ABS(COALESCE((p->>'amount')::numeric,0) - $1::numeric) < 0.005
       UNION ALL
       SELECT 'jobs', x->>'num', p->>'amount', p->>'date', p->>'method', p->>'id'
         FROM platform_state ps, jsonb_array_elements(${JSON_ARR('jobs')}) x,
              LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(x->'payments')='array' THEN x->'payments' ELSE '[]'::jsonb END) p
        WHERE ps.id = 1 AND ABS(COALESCE((p->>'amount')::numeric,0) - $1::numeric) < 0.005
       UNION ALL
       SELECT 'accInvoices', x->>'number', p->>'amount', p->>'date', p->>'method', p->>'id'
         FROM platform_state ps, jsonb_array_elements(${JSON_ARR('accInvoices')}) x,
              LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(x->'payments')='array' THEN x->'payments' ELSE '[]'::jsonb END) p
        WHERE ps.id = 1 AND ABS(COALESCE((p->>'amount')::numeric,0) - $1::numeric) < 0.005
        ORDER BY 1, 2 LIMIT $2`, [TARGET_AMOUNT, ROW_LIMIT]));

    // ══ 8. CREDIT NOTES ════════════════════════════════════════════════════
    out('');
    out('==============================================================');
    out(' SECTION 8 — CREDIT-NOTE INTERACTION');
    out(' A Credit-method payment consumes credit-note balance, so moving one');
    out(' is NOT a simple reallocation. An EFT payment has no such coupling.');
    out('==============================================================');
    table(await q(
      `SELECT id, credit_number, note_type, contact_name_raw, company_code, note_date,
              amount, used_amount, applied_to, status
         FROM rel_credit_notes
        WHERE UPPER(BTRIM(COALESCE(applied_to,''))) LIKE '%' || UPPER(BTRIM($1)) || '%'
           OR UPPER(BTRIM(COALESCE(applied_to,''))) LIKE '%' || UPPER(BTRIM($2)) || '%'
           OR UPPER(BTRIM(COALESCE(applied_to,''))) LIKE '%' || UPPER(BTRIM($3)) || '%'
           OR UPPER(BTRIM(COALESCE(contact_name_raw,''))) =
              UPPER(BTRIM(COALESCE((SELECT customer_name_raw FROM rel_quotes WHERE id = $4),'~')))
        ORDER BY id LIMIT $5`,
      [INV_NUM, JOB_NUM, QUOTE_NUM, quoteId, ROW_LIMIT]));
    out(' Credit-method payments anywhere on this chain:');
    table(await q(
      `SELECT id, owner_type, owner_id, amount, payment_date, method, reference
         FROM rel_payments
        WHERE method = 'Credit'
          AND ((owner_type='quote' AND owner_id=$1) OR (owner_type='job' AND owner_id=$2) OR (owner_type='invoice' AND owner_id=$3))
        ORDER BY id`, [quoteId, jobId, invId]));

    // ══ 9. STATUS NOW, AND WHAT IT WOULD BECOME ════════════════════════════
    out('');
    out('==============================================================');
    out(' SECTION 9 — INVOICE STATUS NOW, AND AFTER A HYPOTHETICAL MOVE');
    out(' Derived with services.ts recomputeOwnerPaymentStatus\'s own rule:');
    out('   totalPaid >= invTotal && invTotal > 0 -> paid');
    out('   totalPaid > 0                          -> partial');
    out('   otherwise                              -> unchanged');
    out(' This is a CALCULATION ONLY. Nothing is written.');
    out('==============================================================');
    if (invId === null) {
      out('  (invoice not uniquely resolved — skipping)');
    } else {
      const paidNow = Number((await q(
        `SELECT COALESCE(SUM(amount),0) AS t FROM rel_payments WHERE owner_type='invoice' AND owner_id=$1`, [invId]))[0].t);
      const chainCandidates = chainPayments.filter(
        (p) => Math.abs(Number(p.amount) - TARGET_AMOUNT) < 0.005 && p.owner_type !== 'invoice');
      const hypothetical = paidNow + chainCandidates.reduce((s, p) => s + Number(p.amount), 0);
      const statusFor = (paid) => (paid >= invTotal && invTotal > 0) ? 'paid' : paid > 0 ? 'partial' : `${invs[0].status} (unchanged)`;
      record([{
        invoice: INV_NUM,
        invoice_total_incl_vat: invTotal === null ? '(unknown)' : invTotal.toFixed(2),
        stored_status: invs[0].status,
        paid_against_invoice_now: paidNow.toFixed(2),
        derived_status_now: statusFor(paidNow),
        candidate_rows_on_quote_or_job: chainCandidates.length,
        candidate_total: chainCandidates.reduce((s, p) => s + Number(p.amount), 0).toFixed(2),
        hypothetical_paid_after_move: hypothetical.toFixed(2),
        hypothetical_status_after_move: statusFor(hypothetical),
        hypothetical_balance_after_move: invTotal === null ? '(unknown)' : (invTotal - hypothetical).toFixed(2),
      }]);
    }

    // ══ 10. CLASSIFICATION ═════════════════════════════════════════════════
    out('');
    out('==============================================================');
    out(' SECTION 10 — CLASSIFICATION');
    out('==============================================================');
    const authoritative = await q(
      `SELECT p.id, p.owner_type, p.owner_id, p.amount, p.payment_date, p.method,
              CASE p.owner_type
                WHEN 'quote'   THEN (SELECT quote_number   FROM rel_quotes   WHERE id = p.owner_id)
                WHEN 'job'     THEN (SELECT job_number     FROM rel_jobs     WHERE id = p.owner_id)
                WHEN 'invoice' THEN (SELECT invoice_number FROM rel_invoices WHERE id = p.owner_id)
              END AS owner_number
         FROM rel_payments p WHERE ABS(p.amount - $1::numeric) < 0.005 ORDER BY p.id`, [TARGET_AMOUNT]);

    let classification, why;
    if (authoritative.length === 0) {
      classification = 'MISSING';
      why = `no authoritative rel_payments row anywhere carries R${TARGET_AMOUNT.toFixed(2)}`;
    } else if (authoritative.length > 1) {
      classification = 'AMBIGUOUS';
      why = `${authoritative.length} authoritative rows carry R${TARGET_AMOUNT.toFixed(2)} — identity cannot be resolved without a person choosing`;
    } else {
      const p = authoritative[0];
      const onThisQuote = p.owner_type === 'quote' && String(p.owner_id) === String(quoteId);
      const onThisJob = p.owner_type === 'job' && String(p.owner_id) === String(jobId);
      const onThisInvoice = p.owner_type === 'invoice' && String(p.owner_id) === String(invId);
      if (onThisInvoice) {
        classification = 'ALREADY_ALLOCATED';
        why = `the single payment is already owned by ${INV_NUM} — nothing to reallocate`;
      } else if (onThisQuote || onThisJob) {
        classification = 'UNALLOCATED';
        why = `exactly one authoritative payment exists, it belongs to ${p.owner_number} (${p.owner_type}) in this chain, and it has no invoice allocation` +
              ` — this is also MATCHED_EXISTING_PAYMENT: one payment, correct customer chain, no duplicate`;
      } else {
        classification = 'MISALLOCATED';
        why = `the single payment is owned by ${p.owner_type} ${p.owner_number}, which is NOT part of this Quote/Job/Invoice chain`;
      }
      out('  The one authoritative candidate:');
      record([p]);
    }
    out(`  CLASSIFICATION : ${classification}`);
    out(`  BASIS          : ${why}`);
    out('');
    out('  Reallocation is safe to prepare ONLY for UNALLOCATED, and only if');
    out('  Section 5 shows no duplicate and Section 8 shows no Credit coupling.');

    await client.query('ROLLBACK');
    out('');
    out('Diagnostic complete. Nothing was written — the transaction was READ ONLY');
    out('and has been rolled back. No payment was created, moved or deleted.');

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
