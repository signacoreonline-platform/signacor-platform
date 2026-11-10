/**
 * record-cancelled-invoice.ts — PUT A DELETED INVOICE NUMBER BACK ON RECORD
 * AS "CANCELLED BY ADMIN".   Created 2026-11-10.
 * MANUAL ONLY — never run by Render (not referenced by `npm start`,
 * `npm run migrate` or `npm run build`).
 *
 * ── THE CASE ────────────────────────────────────────────────────────────────
 * INV-00219 (Job SNS-00236 / Quote SQ-00304) was deleted. deleteInvoice is a
 * HARD delete, so the number vanished from every list. The quote was then
 * revised by an admin, pulled through to the job, and the job was invoiced
 * again as INV-00223. The business needs INV-00219 to stay visible in the
 * invoice lists, clearly marked "Cancelled by Admin" and pointing to its
 * replacement, so the numbering has no unexplained gap.
 *
 * ── WHAT THIS WRITES — ONE INSERT, NOTHING ELSE ─────────────────────────────
 *   * ONE rel_invoices row: the deleted number, status 'void', the same company
 *     and customer as the replacement, and legacy_data
 *       { cancelledByAdmin: true, replacedBy, cancelledReason, cancelledAt, ... }
 *     (read.ts spreads legacy_data onto the hydrated record, which is how the
 *     dashboard shows "Cancelled by Admin → replaced by INV-00223").
 *   * ONE explanatory line at R0.00. The original line detail was destroyed by
 *     the delete and is NOT reconstructed — no figure is invented.
 *   * job_id and quote_id are left NULL on purpose, so the cancelled record can
 *     never be mistaken for the job's invoice by any linkage lookup (they all
 *     exclude 'void' as well — this is belt and braces). The job and quote
 *     numbers are kept as plain text for display only.
 *
 *   Never touched: rel_jobs, rel_quotes, any line item of any other document,
 *   rel_payments, credit notes, document_number_counters, the replacement
 *   invoice. A void invoice is excluded from every total, balance, statement,
 *   aged-debtor, revenue and settlement calculation in the platform.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────
 *   * DRY RUN BY DEFAULT. Writes only with --apply AND the exact --confirm text.
 *   * ONE transaction: backup row in platform_state_backups → insert → verify.
 *     Any failed check rolls everything back.
 *   * Refuses if the number is held by any row in that company (active OR
 *     void), if the counter has not passed it, or if the replacement invoice
 *     is not an active invoice of the same job.
 *   * Uses DATABASE_URL only. No credentials in code.
 *
 * ── RUN (Windows PowerShell, from backend\) ────────────────────────────────
 *   $env:DATABASE_URL = "<Render Postgres external connection string>"
 *   npm run record:cancelled-invoice -- --invoice=INV-00219 --replaced-by=INV-00223 --job=SNS-00236 --quote=SQ-00304
 *   # read the report, then the same command plus:
 *   #   --apply --confirm="CANCEL INV-00219 REPLACED BY INV-00223"
 *   # optional: --issue-date=YYYY-MM-DD   (original invoice date; default = replacement's date)
 *   #           --reason="Client changed the order"
 *   Remove-Item Env:\DATABASE_URL
 */
import * as fs from 'fs';
import * as path from 'path';
import pool from '../db/pool';

const out: string[] = [];
function log(msg = '') { out.push(msg); console.log(msg); }
function norm(v: unknown): string { return (v === null || v === undefined) ? '' : String(v).trim().toUpperCase(); }
function d10(v: any): string | null { if (!v) return null; return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10); }
class Stop extends Error {}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (flag: string): string => {
    const a = argv.find((x) => x.startsWith(flag + '='));
    return a ? a.slice(flag.length + 1).replace(/^["']|["']$/g, '').trim() : '';
  };
  const APPLY = argv.includes('--apply');
  const invoiceNumber = norm(arg('--invoice'));
  const replacedBy = norm(arg('--replaced-by'));
  const jobNumber = norm(arg('--job'));
  const quoteNumber = norm(arg('--quote'));
  const issueDateArg = arg('--issue-date');
  const reason = arg('--reason') || 'Order changed by the client after invoicing; re-invoiced';
  const confirm = arg('--confirm');
  const requiredConfirm = `CANCEL ${invoiceNumber} REPLACED BY ${replacedBy}`;

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Refusing to run.\n\nPowerShell:\n  $env:DATABASE_URL = "<connection string>"');
    process.exitCode = 1; return;
  }
  if (!/^INV-\d+$/.test(invoiceNumber) || !/^INV-\d+$/.test(replacedBy) || !/^SNS-\d+$/.test(jobNumber)) {
    console.error('Usage: --invoice=INV-00219 --replaced-by=INV-00223 --job=SNS-00236 [--quote=SQ-00304] [--issue-date=YYYY-MM-DD] [--reason="..."] [--apply --confirm="CANCEL INV-00219 REPLACED BY INV-00223"]');
    process.exitCode = 1; return;
  }
  if (issueDateArg && !/^\d{4}-\d{2}-\d{2}$/.test(issueDateArg)) { console.error('--issue-date must be YYYY-MM-DD'); process.exitCode = 1; return; }

  const client = await pool.connect();
  let inTx = false;
  try {
    log('==============================================================');
    log(` SIGNACORE — RECORD CANCELLED INVOICE  ${APPLY ? '(APPLY)' : '(DRY RUN — nothing is written)'}`);
    log(` ${invoiceNumber}  "Cancelled by Admin"  -> replaced by ${replacedBy}   (job ${jobNumber}${quoteNumber ? ', quote ' + quoteNumber : ''})`);
    log('==============================================================');
    const who = (await client.query('SELECT current_database() AS db, now() AS at')).rows[0];
    log(`database ${who.db}   at ${who.at}`);
    log('');

    const jobs = (await client.query('SELECT * FROM rel_jobs WHERE UPPER(BTRIM(job_number)) = $1', [jobNumber])).rows;
    if (jobs.length !== 1) throw new Stop(`expected exactly one job ${jobNumber}, found ${jobs.length}.`);
    const job = jobs[0];
    log(`job          id ${job.id}  ${job.job_number}  company ${job.company_code}  "${job.customer_name_raw ?? ''}"  invoice_num ${job.invoice_num ?? '-'}`);

    let quote: any = null;
    if (job.quote_id) quote = (await client.query('SELECT id, quote_number FROM rel_quotes WHERE id = $1', [job.quote_id])).rows[0] || null;
    if (quoteNumber && (!quote || norm(quote.quote_number) !== quoteNumber)) {
      throw new Stop(`the job's linked quote is ${quote ? quote.quote_number : '(none)'}, not ${quoteNumber}.`);
    }

    const repl = (await client.query(
      `SELECT * FROM rel_invoices WHERE company_code = $1 AND UPPER(BTRIM(invoice_number)) = $2`, [job.company_code, replacedBy]
    )).rows[0];
    if (!repl) throw new Stop(`replacement invoice ${replacedBy} not found in company ${job.company_code}.`);
    log(`replacement  id ${repl.id}  ${repl.invoice_number}  status ${repl.status}  job_id ${repl.job_id ?? '-'}  issued ${d10(repl.issue_date) ?? '-'}`);
    if (String(repl.status ?? '') === 'void') throw new Stop(`${replacedBy} is itself void.`);
    const replIsThisJob = (repl.job_id !== null && Number(repl.job_id) === Number(job.id)) || norm(job.invoice_num) === replacedBy;
    if (!replIsThisJob) throw new Stop(`${replacedBy} does not belong to job ${jobNumber}.`);

    const holders = (await client.query(
      `SELECT id, status FROM rel_invoices WHERE company_code = $1 AND UPPER(BTRIM(invoice_number)) = $2`, [job.company_code, invoiceNumber]
    )).rows;
    log(`${invoiceNumber} held by: ${holders.length ? holders.map((h: any) => `id ${h.id} (${h.status})`).join(', ') : 'nobody — free'}`);
    if (holders.length) throw new Stop(`${invoiceNumber} already exists (id ${holders.map((h: any) => h.id).join(', ')}) — nothing to put back.`);

    const counter = (await client.query(
      `SELECT last_number FROM document_number_counters WHERE company = $1 AND doc_type = 'invoice'`, [String(job.company_code)]
    )).rows[0];
    const invN = parseInt(invoiceNumber.replace(/^INV-/, ''), 10);
    log(`invoice counter (company ${job.company_code}): last_number ${counter ? counter.last_number : '(no row)'}`);
    if (!counter || Number(counter.last_number) < invN) throw new Stop(`the counter has not passed ${invoiceNumber}; recording it now could collide with a future invoice.`);

    const issueDate = issueDateArg || d10(repl.issue_date) || new Date().toISOString().slice(0, 10);
    const marker = {
      cancelledByAdmin: true,
      replacedBy,
      cancelledReason: reason,
      cancelledAt: new Date().toISOString(),
      cancelledVia: 'src/scripts/record-cancelled-invoice.ts',
      originalJobNum: job.job_number,
      originalQuoteNum: quote ? quote.quote_number : null,
      note: `${invoiceNumber} was deleted and re-issued as ${replacedBy}. Recorded as cancelled so the number stays on file. The original line detail was not recoverable and is not reconstructed.`,
    };
    const lineText = `CANCELLED BY ADMIN — superseded by ${replacedBy} (Job ${job.job_number}${quote ? ' / Quote ' + quote.quote_number : ''}). No amount is due on this invoice.`;

    log('');
    log('PRE-CHECKS PASSED. Would insert:');
    log(`   rel_invoices  ${invoiceNumber}  company ${job.company_code}  status 'void'  issue_date ${issueDate}`);
    log(`                 contact "${repl.contact_name ?? job.customer_name_raw ?? ''}"  reference "Cancelled by Admin — replaced by ${replacedBy}"`);
    log(`                 job/quote kept as text only: ${job.job_number}${quote ? ' / ' + quote.quote_number : ''}  (job_id, quote_id = NULL)`);
    log(`   1 line  R0.00  "${lineText}"`);
    log(`   legacy_data ${JSON.stringify(marker)}`);
    if (!APPLY) {
      log('');
      log('DRY RUN — nothing was written. To apply:');
      log(`   npm run record:cancelled-invoice -- --invoice=${invoiceNumber} --replaced-by=${replacedBy} --job=${jobNumber}${quoteNumber ? ' --quote=' + quoteNumber : ''}${issueDateArg ? ' --issue-date=' + issueDateArg : ''} --apply --confirm="${requiredConfirm}"`);
      return;
    }
    if (confirm !== requiredConfirm) throw new Stop(`--confirm must be exactly "${requiredConfirm}".`);

    await client.query('BEGIN'); inTx = true;
    // Re-check under the transaction: the number must still be free.
    const again = await client.query(
      `SELECT 1 FROM rel_invoices WHERE company_code = $1 AND UPPER(BTRIM(invoice_number)) = $2`, [job.company_code, invoiceNumber]
    );
    if ((again.rowCount ?? 0) > 0) throw new Stop(`${invoiceNumber} appeared while running — nothing written.`);

    const backupPayload = { case: `record ${invoiceNumber} as cancelled, replaced by ${replacedBy}`, job, quote, replacementInvoice: repl, marker };
    const serialized = JSON.stringify(backupPayload);
    const b = (await client.query(
      `INSERT INTO platform_state_backups (data, reason, data_size_bytes, source, record_counts)
       VALUES ($1::jsonb, $2, $3, $4, $5::jsonb) RETURNING id, created_at`,
      [serialized, `before-record-cancelled-${invoiceNumber.toLowerCase()}`, Buffer.byteLength(serialized, 'utf8'),
       'src/scripts/record-cancelled-invoice.ts (manual run)', JSON.stringify({ invoices: 1 })]
    )).rows[0];
    log('');
    log(`BACKUP   platform_state_backups id ${b.id}  (${b.created_at})`);

    const ins = (await client.query(
      `WITH new_id AS (SELECT nextval('rel_invoices_id_seq') AS id)
       INSERT INTO rel_invoices (id, source_id, invoice_number, company_code, customer_id, contact_name, contact_email, contact_address,
                                 reference, job_id, job_number_raw, quote_id, quote_number_raw, status, issue_date, legacy_data)
       SELECT new_id.id, new_id.id::text, $1, $2, $3, $4, $5, $6, $7, NULL, $8, NULL, $9, 'void', $10::date, $11::jsonb FROM new_id
       RETURNING id`,
      [invoiceNumber, job.company_code, repl.customer_id ?? job.customer_id ?? null,
       repl.contact_name ?? job.customer_name_raw ?? null, repl.contact_email ?? null, repl.contact_address ?? null,
       `Cancelled by Admin — replaced by ${replacedBy}`, job.job_number, quote ? quote.quote_number : null,
       issueDate, JSON.stringify(marker)]
    )).rows[0];
    await client.query(
      `INSERT INTO rel_invoice_line_items (invoice_id, line_index, description, qty, unit_amount, account_code, tax_type, legacy_data)
       VALUES ($1, 0, $2, 1, 0, '4000', '15%', '{}'::jsonb)`,
      [ins.id, lineText]
    );

    // Verify inside the transaction.
    const v = (await client.query(
      `SELECT i.status, COUNT(l.id)::int AS n, COALESCE(SUM(l.qty*l.unit_amount),0) AS total,
              (SELECT COUNT(*)::int FROM rel_payments p WHERE p.owner_type='invoice' AND p.owner_id=i.id) AS pays
         FROM rel_invoices i LEFT JOIN rel_invoice_line_items l ON l.invoice_id = i.id
        WHERE i.id = $1 GROUP BY i.id, i.status`, [ins.id]
    )).rows[0];
    if (!v || v.status !== 'void' || v.n !== 1 || Number(v.total) !== 0 || v.pays !== 0) {
      throw new Error('post-insert verification failed: ' + JSON.stringify(v));
    }
    await client.query('COMMIT'); inTx = false;
    log(`INSERTED rel_invoices id ${ins.id}  ${invoiceNumber}  status void, 1 line, R0.00, no payments`);
    log('');
    log(`DONE. Refresh the dashboard: ${invoiceNumber} shows in Sales → Invoices and Accounting → Invoices as`);
    log(`"🚫 Cancelled by Admin → ${replacedBy}". It is not counted in any total or balance.`);
  } catch (err: any) {
    if (inTx) { try { await client.query('ROLLBACK'); } catch { /* ignore */ } }
    log('');
    if (err instanceof Stop) { log('STOPPED — nothing was written.'); log('   ' + err.message); }
    else { log('FAILED — rolled back, nothing was written: ' + (err && err.message ? err.message : err)); }
    process.exitCode = 1;
  } finally {
    const outPath = path.resolve(process.cwd(), `record-cancelled-${invoiceNumber.toLowerCase() || 'invoice'}-report.txt`);
    try { fs.writeFileSync(outPath, out.join('\n') + '\n', 'utf8'); console.log('\nReport saved to: ' + outPath); } catch { /* ignore */ }
    client.release();
    await pool.end().catch(() => undefined);
  }
}

main();
