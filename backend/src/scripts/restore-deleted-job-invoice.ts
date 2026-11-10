/**
 * restore-deleted-job-invoice.ts — PUT A DELETED JOB INVOICE BACK, SAME NUMBER
 * Created 2026-11-10. MANUAL ONLY — never run by Render (not referenced by
 * `npm start`, `npm run migrate` or `npm run build`).
 *
 * ── THE CASE ────────────────────────────────────────────────────────────────
 * Quote SQ-00304 became Job SNS-00236, which was invoiced as INV-00219. The
 * invoice was then deleted (services.ts deleteInvoice — a HARD delete: the
 * rel_invoices row, its lines and any payment captured directly ON the invoice
 * are removed, and the job's invoice_num / invoice_created are cleared). The
 * number INV-00219 was deliberately not returned to the counter, so it is
 * unused and can be re-issued to the same job.
 *
 * ── HOW, WITH NO NEW ARITHMETIC ─────────────────────────────────────────────
 * services.ts's jobInvoiceTx already has a deployed path for exactly this:
 * "No rel_invoices row exists for this number yet at all — create exactly one,
 * using the job's EXISTING invoice_num verbatim (never reserved from the
 * atomic counter)". So this script:
 *
 *   STEP 1  (one transaction) backs up the affected rows into
 *           platform_state_backups, then stamps rel_jobs.invoice_num (and,
 *           optionally, invoice_date) back onto the job. Nothing else.
 *   STEP 2  calls the DEPLOYED createInvoiceForJob(jobId) — the same function
 *           the "Create Invoice" button calls — which writes the invoice under
 *           that number from the job's own lines, with every existing guard
 *           (assertJobInvoiceMatchesValueTx, historical-pieces protection).
 *           If it refuses, STEP 1 is reversed (version-checked) and nothing
 *           remains changed.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────
 *   * DRY RUN BY DEFAULT. Writes only with --apply AND the exact --confirm text.
 *   * Refuses if: the job is not found exactly once; it already has an invoice
 *     number or an active linked invoice; the invoice number is held by ANY
 *     invoice row in that company (active or void); the counter has not yet
 *     passed that number (so it could later be issued twice); the expected
 *     quote does not link to the job.
 *   * Never creates, edits or deletes a rel_payments row. Never touches a
 *     quote, a quote line or a job line. Never moves a document counter.
 *   * Uses DATABASE_URL only. No credentials in code.
 *
 * ── RUN (Windows PowerShell, from backend\) ────────────────────────────────
 *   $env:DATABASE_URL = "<Render Postgres external connection string>"
 *   npm run restore:deleted-job-invoice -- --job=SNS-00236 --invoice=INV-00219 --quote=SQ-00304
 *   # read the report, then:
 *   npm run restore:deleted-job-invoice -- --job=SNS-00236 --invoice=INV-00219 --quote=SQ-00304 --apply --confirm="RESTORE INV-00219 FOR SNS-00236"
 *   # optional: --issue-date=2026-10-15   (the original invoice date; default today)
 *   Remove-Item Env:\DATABASE_URL
 */
import * as fs from 'fs';
import * as path from 'path';
import pool from '../db/pool';
import { createInvoiceForJob } from '../relational/services';

const out: string[] = [];
function log(msg = '') { out.push(msg); console.log(msg); }
function norm(v: unknown): string { return (v === null || v === undefined) ? '' : String(v).trim().toUpperCase(); }
function money(n: unknown): string { return (Math.round((Number(n) || 0) * 100) / 100).toFixed(2); }
class Stop extends Error {}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (flag: string): string => {
    const a = argv.find((x) => x.startsWith(flag + '='));
    return a ? a.slice(flag.length + 1).replace(/^["']|["']$/g, '').trim() : '';
  };
  const APPLY = argv.includes('--apply');
  const jobNumber = norm(arg('--job'));
  const invoiceNumber = norm(arg('--invoice'));
  const quoteNumber = norm(arg('--quote'));
  const issueDate = arg('--issue-date');
  const confirm = arg('--confirm');
  const requiredConfirm = `RESTORE ${invoiceNumber} FOR ${jobNumber}`;

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Refusing to run.\n\nPowerShell:\n  $env:DATABASE_URL = "<connection string>"');
    process.exitCode = 1; return;
  }
  if (!/^SNS-\d+$/.test(jobNumber) || !/^INV-\d+$/.test(invoiceNumber)) {
    console.error('Usage: --job=SNS-00236 --invoice=INV-00219 [--quote=SQ-00304] [--issue-date=YYYY-MM-DD] [--apply --confirm="RESTORE INV-00219 FOR SNS-00236"]');
    process.exitCode = 1; return;
  }
  if (issueDate && !/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) {
    console.error('--issue-date must be YYYY-MM-DD'); process.exitCode = 1; return;
  }

  const client = await pool.connect();
  let stamped: { jobId: number; rowVersion: number } | null = null;
  try {
    log('==============================================================');
    log(` SIGNACORE — RESTORE DELETED JOB INVOICE  ${APPLY ? '(APPLY)' : '(DRY RUN — nothing is written)'}`);
    log(` ${invoiceNumber} -> ${jobNumber}${quoteNumber ? '  (quote ' + quoteNumber + ')' : ''}`);
    log('==============================================================');
    const who = (await client.query('SELECT current_database() AS db, now() AS at')).rows[0];
    log(`database ${who.db}   at ${who.at}`);
    log('');

    const cut = (await client.query(`SELECT section, enabled FROM relational_cutover WHERE section IN ('quotes','jobs','accInvoices')`)).rows;
    log('cutover: ' + cut.map((r: any) => `${r.section}=${r.enabled}`).join('  '));

    // ── The job ────────────────────────────────────────────────────────────
    const jobs = (await client.query(
      `SELECT * FROM rel_jobs WHERE UPPER(BTRIM(job_number)) = $1 ORDER BY id`, [jobNumber]
    )).rows;
    if (jobs.length !== 1) throw new Stop(`expected exactly one job ${jobNumber}, found ${jobs.length}.`);
    const job = jobs[0];
    const jobId = Number(job.id);
    log(`job      id ${jobId}  ${job.job_number}  company ${job.company_code}  "${job.customer_name_raw ?? ''}"`);
    log(`         value R ${money(job.value)}  stage ${job.stage} / ${job.status}  row_version ${job.row_version}`);
    log(`         invoice_num ${job.invoice_num ?? '(none)'}  invoice_created ${job.invoice_created}  invoice_status ${job.invoice_status ?? '(none)'}`);

    const jobLines = (await client.query(
      `SELECT line_index, description, qty, unit_price, pieces, subtotal FROM rel_job_line_items WHERE job_id = $1 ORDER BY line_index`, [jobId]
    )).rows;
    log(`         ${jobLines.length} job line(s):`);
    for (const l of jobLines) log(`           #${l.line_index}  ${l.pieces ?? '-'} x ${l.qty} x R ${money(l.unit_price)} = R ${money(l.subtotal)}  ${l.description ?? ''}`);

    // ── The quote ──────────────────────────────────────────────────────────
    let quote: any = null;
    if (job.quote_id) quote = (await client.query('SELECT * FROM rel_quotes WHERE id = $1', [job.quote_id])).rows[0] || null;
    if (quote) {
      log(`quote    id ${quote.id}  ${quote.quote_number}  total R ${money(quote.total)}  status ${quote.status}  converted_job_id ${quote.converted_job_id ?? '-'}`);
      log(`         proforma ${quote.proforma_num ?? '(none)'}`);
    } else {
      log('quote    (job has no linked quote)');
    }
    if (quoteNumber) {
      if (!quote || norm(quote.quote_number) !== quoteNumber) {
        throw new Stop(`the job's linked quote is ${quote ? quote.quote_number : '(none)'}, not ${quoteNumber}.`);
      }
    }

    // ── Is the invoice number free, and is the job free of an invoice? ──────
    const holders = (await client.query(
      `SELECT id, invoice_number, status, job_id, quote_id FROM rel_invoices
        WHERE company_code = $1 AND UPPER(BTRIM(invoice_number)) = $2`,
      [job.company_code, invoiceNumber]
    )).rows;
    const linked = (await client.query(
      `SELECT id, invoice_number, status FROM rel_invoices
        WHERE COALESCE(status,'') <> 'void' AND (job_id = $1 OR ($2::bigint IS NOT NULL AND quote_id = $2::bigint))`,
      [jobId, job.quote_id ?? null]
    )).rows;
    const counter = (await client.query(
      `SELECT last_number FROM document_number_counters WHERE company = $1 AND doc_type = 'invoice'`, [String(job.company_code)]
    )).rows[0];
    const invN = parseInt(invoiceNumber.replace(/^INV-/, ''), 10);
    log('');
    log(`${invoiceNumber} held by: ${holders.length ? holders.map((h: any) => `id ${h.id} (${h.status})`).join(', ') : 'nobody — free'}`);
    log(`active invoices linked to this job/quote: ${linked.length ? linked.map((r: any) => r.invoice_number).join(', ') : 'none'}`);
    log(`invoice counter (company ${job.company_code}): last_number ${counter ? counter.last_number : '(no row)'}`);

    const pays = (await client.query(
      `SELECT owner_type, owner_id, amount, payment_date, method, reference FROM rel_payments
        WHERE (owner_type = 'job' AND owner_id = $1) OR ($2::bigint IS NOT NULL AND owner_type = 'quote' AND owner_id = $2::bigint)
        ORDER BY payment_date NULLS FIRST, id`,
      [jobId, job.quote_id ?? null]
    )).rows;
    let paid = 0;
    log(`surviving payments on this chain (quote/job owned): ${pays.length}`);
    for (const p of pays) { paid += Number(p.amount) || 0; log(`   R ${money(p.amount)}  ${p.payment_date ? String(p.payment_date).slice(0, 10) : '-'}  ${p.method ?? ''}  [${p.owner_type}] ${p.reference ?? ''}`); }
    log(`   total R ${money(paid)}   (any payment captured directly ON the deleted invoice was removed with it and must be recaptured)`);

    const problems: string[] = [];
    if (holders.length) problems.push(`${invoiceNumber} is still held by invoice row(s) ${holders.map((h: any) => h.id).join(', ')} — it was not deleted, or was reused. Nothing to restore.`);
    if (linked.length) problems.push(`the job/quote already has active invoice ${linked.map((r: any) => r.invoice_number).join(', ')}.`);
    if (job.invoice_num && norm(job.invoice_num) !== invoiceNumber) problems.push(`the job already carries invoice number ${job.invoice_num}.`);
    if (job.invoice_created) problems.push('the job is still flagged invoice_created = true.');
    if (!counter || !Number.isFinite(invN) || Number(counter.last_number) < invN) problems.push(`the invoice counter has not passed ${invoiceNumber}; re-issuing it here could let the counter issue it a second time later.`);
    if (problems.length) throw new Stop('cannot restore:\n   - ' + problems.join('\n   - '));

    log('');
    log('PRE-CHECKS PASSED. The restore would:');
    log(`   1. back up job ${jobNumber} (+ its lines, its quote and the chain payments) to platform_state_backups`);
    log(`   2. set rel_jobs.invoice_num = '${invoiceNumber}'${issueDate ? `, invoice_date = ${issueDate}` : ''} on job id ${jobId}`);
    log(`   3. call the deployed createInvoiceForJob(${jobId}) — same as the "Create Invoice" button — which issues`);
    log(`      ${invoiceNumber} from the job's own lines without reserving a new number`);
    if (!APPLY) {
      log('');
      log('DRY RUN — nothing was written. To apply:');
      log(`   npm run restore:deleted-job-invoice -- --job=${jobNumber} --invoice=${invoiceNumber}${quoteNumber ? ' --quote=' + quoteNumber : ''}${issueDate ? ' --issue-date=' + issueDate : ''} --apply --confirm="${requiredConfirm}"`);
      return;
    }
    if (confirm !== requiredConfirm) throw new Stop(`--confirm must be exactly "${requiredConfirm}".`);

    // ── STEP 1: backup + stamp the number, one transaction ────────────────
    await client.query('BEGIN');
    const locked = (await client.query('SELECT * FROM rel_jobs WHERE id = $1 FOR UPDATE', [jobId])).rows[0];
    if (!locked || Number(locked.row_version) !== Number(job.row_version)) {
      await client.query('ROLLBACK');
      throw new Stop('the job changed while this script was running — run the dry run again.');
    }
    const backupPayload = { case: `restore ${invoiceNumber} for ${jobNumber}`, job: locked, jobLines, quote, payments: pays };
    const serialized = JSON.stringify(backupPayload);
    const b = (await client.query(
      `INSERT INTO platform_state_backups (data, reason, data_size_bytes, source, record_counts)
       VALUES ($1::jsonb, $2, $3, $4, $5::jsonb) RETURNING id, created_at`,
      [serialized, `before-restore-${invoiceNumber.toLowerCase()}-${jobNumber.toLowerCase()}`, Buffer.byteLength(serialized, 'utf8'),
       'src/scripts/restore-deleted-job-invoice.ts (manual run)', JSON.stringify({ jobLines: jobLines.length, payments: pays.length })]
    )).rows[0];
    log('');
    log(`BACKUP   platform_state_backups id ${b.id}  (${b.created_at})`);
    const st = (await client.query(
      `UPDATE rel_jobs SET invoice_num = $1, invoice_date = COALESCE($2::date, invoice_date),
              row_version = row_version + 1, updated_at = NOW()
        WHERE id = $3 AND invoice_num IS NULL AND invoice_created = false
        RETURNING row_version`,
      [invoiceNumber, issueDate || null, jobId]
    )).rows[0];
    if (!st) { await client.query('ROLLBACK'); throw new Stop('the job no longer matched the expected state — nothing written.'); }
    await client.query('COMMIT');
    const stampNow = { jobId, rowVersion: Number(st.row_version) };
    stamped = stampNow;
    log(`STEP 1   job ${jobNumber} now carries ${invoiceNumber} (row_version ${st.row_version})`);

    // ── STEP 2: the deployed writer ──────────────────────────────────────
    try {
      const r = await createInvoiceForJob(jobId);
      stamped = null;
      log(`STEP 2   createInvoiceForJob -> invoice id ${r.invoiceId}  ${r.invoiceNumber}  created=${r.created}`);
      log(`         job is now stage ${r.jobStage} / ${r.jobStatus}`);
      const t = (await client.query(
        `SELECT COUNT(*)::int AS n, COALESCE(SUM(qty*unit_amount),0) AS sub,
                COALESCE(SUM(CASE WHEN tax_type='15%' THEN qty*unit_amount ELSE 0 END),0) AS taxable
           FROM rel_invoice_line_items WHERE invoice_id = $1`, [r.invoiceId]
      )).rows[0];
      log(`         ${t.n} line(s), excl. VAT R ${money(t.sub)}, VAT R ${money(Number(t.taxable) * 0.15)}`);
      log('');
      log(`DONE. ${invoiceNumber} is back on ${jobNumber}. Payment status was re-derived from the chain's payments.`);
    } catch (e: any) {
      log(`STEP 2   REFUSED by the invoice writer: ${e && e.message ? e.message : e}`);
      const undo = await client.query(
        `UPDATE rel_jobs SET invoice_num = NULL, invoice_date = $1, row_version = row_version + 1, updated_at = NOW()
          WHERE id = $2 AND row_version = $3 AND UPPER(BTRIM(invoice_num)) = $4 AND invoice_created = false`,
        [job.invoice_date ?? null, stampNow.jobId, stampNow.rowVersion, invoiceNumber]
      );
      log(undo.rowCount === 1
        ? '         STEP 1 reversed — the job is exactly as before (only row_version moved). Nothing else changed.'
        : '         WARNING: could not reverse STEP 1 automatically (the job changed). The job still carries the number; restore from the backup above if needed.');
      stamped = null;
      process.exitCode = 1;
    }
  } catch (err: any) {
    if (err instanceof Stop) { log(''); log('STOPPED — nothing was written.'); log('   ' + err.message); }
    else { log(''); log('FAILED: ' + (err && err.message ? err.message : err)); }
    try { await client.query('ROLLBACK'); } catch { /* not in a transaction */ }
    process.exitCode = 1;
  } finally {
    const outPath = path.resolve(process.cwd(), `restore-${invoiceNumber.toLowerCase() || 'invoice'}-report.txt`);
    try { fs.writeFileSync(outPath, out.join('\n') + '\n', 'utf8'); console.log('\nReport saved to: ' + outPath); } catch { /* ignore */ }
    client.release();
    await pool.end().catch(() => undefined);
  }
}

main();
