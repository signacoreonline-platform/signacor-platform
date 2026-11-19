/**
 * record-cancelled-invoice.ts — PUT A HARD-DELETED INVOICE BACK ON RECORD AS
 * "CANCELLED BY ADMIN".   Created 2026-11-10 (INV-00219). Reworked 2026-11-19.
 * MANUAL ONLY — never run by Render (not referenced by `npm start`,
 * `npm run migrate` or `npm run build`).
 *
 * ── WHEN THIS IS STILL NEEDED ───────────────────────────────────────────────
 * Since 2026-11-19 the platform no longer deletes invoices: "Cancel invoice"
 * (services.ts cancelInvoice) keeps the row and its original lines and marks
 * it void. This script exists ONLY for invoices that were hard-deleted BEFORE
 * that — the row is gone, so there is nothing for cancelInvoice to act on.
 *   INV-00219  deleted, re-invoiced as INV-00223   (recorded 2026-11-10)
 *   INV-00223  deleted, re-invoiced as INV-00231   (this rework)
 * It writes the SAME cancellation record cancelInvoice writes
 * (buildInvoiceCancellationMarker), so a recovered invoice and a normally
 * cancelled one read identically in Sales and Accounting.
 *
 * ── ORIGINAL DETAIL: EVIDENCE FIRST, DISCLOSED FALLBACK OTHERWISE ───────────
 * A hard delete destroyed the invoice row and its lines. This script looks for
 * what survives and says exactly which is which:
 *   HEADER  the 2026-11-10 run of this script backed up the then-active
 *           replacement invoice's full row into platform_state_backups
 *           (reason before-record-cancelled-…, data.replacementInvoice). For
 *           INV-00223 that IS its original header — customer, contact, dates,
 *           reference, status.
 *   LINES   any platform_state_backups row, or a Full Backup V2 file you pass
 *           with --evidence-file (data.json or relational-raw.json from the
 *           ZIP), that still contains the invoice WITH its line items.
 * Anything not found is NOT reconstructed: the header falls back to the
 * replacement invoice's customer/contact, and the lines fall back to ONE
 * explanatory line at R0.00. Every fallback is printed as FALLBACK and the
 * record is flagged originalDetailRetained:false. No figure is ever invented,
 * and the job's CURRENT lines are never used (they belong to the replacement).
 *
 * ── WHAT IT WRITES — INSERTS ONLY ───────────────────────────────────────────
 *   * one platform_state_backups row (the backup, first);
 *   * one rel_invoices row: the deleted number, status 'void', job_id and
 *     quote_id NULL (numbers kept as text; ids kept in the marker);
 *   * its rel_invoice_line_items rows (evidence lines, or the one R0.00 line).
 *   Never touched: rel_jobs, rel_quotes, any other invoice (so the existing
 *   INV-00219 → INV-00223 reference is preserved exactly), rel_payments,
 *   credit notes, document_number_counters. No UPDATE, no DELETE.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────
 *   * Without --apply everything runs inside BEGIN TRANSACTION READ ONLY — the
 *     database itself refuses any write. --diagnose prints every finding and
 *     never stops early; the default dry run also validates and prints the plan.
 *   * --apply needs the exact --confirm text. ONE transaction: backup → insert
 *     → verify. Any failed check rolls everything back.
 *   * Refuses if: the job / quote / replacement do not link to each other in
 *     the SAME company; the replacement is not an active invoice of that job;
 *     the number is already held in that company (active OR void); the counter
 *     has not passed it; a named --predecessor does not point at it; another
 *     cancelled invoice already names the same replacement.
 *   * Uses DATABASE_URL only. No credentials in code.
 *
 * ── CONNECTION (2026-11-19 timeout fix) ─────────────────────────────────────
 * This script used to take its connection from the shared pool (db/pool.ts),
 * whose connectionTimeoutMillis is 2000. That limit is right for the deployed
 * server (Render's private network) but it also covers the TLS handshake and
 * authentication, and from an office PC to Render's EXTERNAL endpoint those
 * regularly take longer than 2 seconds — so the run died at its very first
 * line with "Connection terminated due to connection timeout" (pg-pool's
 * message for a NEW connection that did not finish in time; waiting for a
 * busy pool reads "timeout exceeded when trying to connect" instead). A TCP
 * port test passing does not contradict that: it stops before TLS and login.
 * The script now opens ONE dedicated connection of its own with a 30-second
 * limit (--connect-timeout=SECONDS), TCP keep-alive, and up to three attempts.
 * Everything still runs on that single connection and in the same single
 * transaction; the shared pool and the deployed server are unchanged.
 *
 * ── RUN (Windows PowerShell, from backend\) ────────────────────────────────
 *   $env:DATABASE_URL = "<Render Postgres external connection string>"
 *   npm run record:cancelled-invoice -- --invoice=INV-00223 --replaced-by=INV-00231 --job=SNS-00236 --quote=SQ-00304 --predecessor=INV-00219 --diagnose
 *   npm run record:cancelled-invoice -- --invoice=INV-00223 --replaced-by=INV-00231 --job=SNS-00236 --quote=SQ-00304 --predecessor=INV-00219
 *   # read the report, then the same command plus:
 *   #   --apply --confirm="CANCEL INV-00223 REPLACED BY INV-00231"
 *   # optional: --company=2  --issue-date=YYYY-MM-DD  --due-date=YYYY-MM-DD
 *   #           --reason="..."  --cancelled-by="Name"  --evidence-file="C:\path\relational-raw.json"
 *   #           --skip-backup-scan   (skip the search of platform_state_backups for line evidence)
 *   #           --connect-timeout=60 (seconds allowed for each connection attempt; default 30)
 *   Remove-Item Env:\DATABASE_URL
 */
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import { resolveSsl, describeConnectionError } from '../db/ssl';
import { buildInvoiceCancellationMarker, sgrInvoiceCentsFromRows } from '../relational/services';

const out: string[] = [];
function log(msg = '') { out.push(msg); console.log(msg); }
function norm(v: unknown): string { return (v === null || v === undefined) ? '' : String(v).trim().toUpperCase(); }
// A Postgres DATE reaches Node as a Date at LOCAL midnight, and a backup made on
// this PC stored it as that instant in UTC ("2026-11-08T22:00:00.000Z" for
// 9 November in South Africa). Both are read back in LOCAL time, so the
// calendar date is the one that was stored — never a day early.
function d10(v: any): string | null {
  if (!v) return null;
  const local = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (v instanceof Date) return local(v);
  const t = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? t.slice(0, 10) : local(d);
}
function money(cents: number): string { return 'R' + (cents / 100).toFixed(2); }
class Stop extends Error {}

/** ONE dedicated connection for the whole run (see CONNECTION in the header).
 *  A failed attempt has written nothing and holds nothing: its client is ended
 *  before the next attempt, so attempts can never pile up connections. */
async function connectWithRetry(timeoutMs: number, attempts: number): Promise<Client> {
  const url = process.env.DATABASE_URL as string;
  let lastErr: any = null;
  for (let i = 1; i <= attempts; i++) {
    const client = new Client({
      connectionString: url, ssl: resolveSsl(url),
      connectionTimeoutMillis: timeoutMs, keepAlive: true, keepAliveInitialDelayMillis: 10000,
    });
    // A dropped link must surface as a failed query, never as an unhandled 'error' event.
    client.on('error', (e) => { console.error('[db] connection error: ' + (e && e.message ? e.message : e)); });
    const t0 = Date.now();
    try {
      await client.connect();
      log(`connected in ${Date.now() - t0} ms (attempt ${i} of ${attempts}; limit ${Math.round(timeoutMs / 1000)}s)`);
      return client;
    } catch (err: any) {
      lastErr = err;
      log(`connection attempt ${i} of ${attempts} failed after ${Date.now() - t0} ms: ${err && err.message ? err.message : err}`);
      await client.end().catch(() => undefined);
      if (i < attempts) await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  throw new Stop(
    `could not connect to the database after ${attempts} attempts (limit ${Math.round(timeoutMs / 1000)}s each).\n   ` +
    describeConnectionError(lastErr) +
    `\n   Nothing was read or written. If the database is reachable but slow, add --connect-timeout=60.`
  );
}

interface EvidenceLine { description: string | null; qty: number; unitAmount: number; accountCode: string | null; taxType: string | null }
interface LineEvidence { source: string; at: string | null; lines: EvidenceLine[]; header: any | null }

/** Finds every copy of `invoiceNumber` (same company) inside an arbitrary JSON
 *  document that still carries line items. Two shapes are understood:
 *   - a rendered record  { number|invoice_number, co|company_code, lineItems|items:[...] }
 *   - raw tables         { rel_invoices:[...], rel_invoice_line_items:[...] }  (Full Backup V2) */
function findLineEvidence(doc: any, invoiceNumber: string, companyCode: string, source: string, at: string | null): LineEvidence[] {
  const found: LineEvidence[] = [];
  const toLine = (l: any): EvidenceLine => ({
    description: l.description ?? null,
    qty: Number(l.qty ?? 1), unitAmount: Number(l.unitAmount ?? l.unit_amount ?? 0),
    accountCode: l.accountCode ?? l.account_code ?? null, taxType: l.taxType ?? l.tax_type ?? null,
  });
  const sameCo = (v: any) => v === undefined || v === null || String(v) === String(companyCode);
  const seen = new Set<any>();
  const walk = (node: any, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 12 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { for (const x of node) walk(x, depth + 1); return; }
    if (Array.isArray(node.rel_invoices) && Array.isArray(node.rel_invoice_line_items)) {
      for (const r of node.rel_invoices) {
        if (norm(r && r.invoice_number) !== invoiceNumber || !sameCo(r.company_code)) continue;
        const ls = node.rel_invoice_line_items.filter((l: any) => l && String(l.invoice_id) === String(r.id))
          .sort((a: any, b: any) => Number(a.line_index) - Number(b.line_index)).map(toLine);
        if (ls.length) found.push({ source: source + ' (raw tables)', at, lines: ls, header: r });
      }
    }
    const num = node.number ?? node.invoice_number;
    const ls = Array.isArray(node.lineItems) ? node.lineItems : (Array.isArray(node.items) ? node.items : null);
    if (num !== undefined && norm(num) === invoiceNumber && ls && ls.length && sameCo(node.co ?? node.company_code)) {
      found.push({ source: source + ' (rendered record)', at, lines: ls.map(toLine), header: node });
    }
    for (const k of Object.keys(node)) walk(node[k], depth + 1);
  };
  walk(doc, 0);
  // A placeholder (all-zero lines) is not evidence of the original detail.
  return found.filter((f) => f.lines.some((l) => Number.isFinite(l.qty * l.unitAmount) && l.qty * l.unitAmount !== 0));
}
const linesKey = (ls: EvidenceLine[]) => JSON.stringify(ls.map((l) => [l.description, l.qty, l.unitAmount, l.accountCode, l.taxType]));
const totalCents = (ls: EvidenceLine[]) => sgrInvoiceCentsFromRows(ls.map((l) => ({ qty: l.qty, unit_amount: l.unitAmount, tax_type: l.taxType })) as any[]).totalC;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (flag: string): string => {
    const a = argv.find((x) => x.startsWith(flag + '='));
    return a ? a.slice(flag.length + 1).replace(/^["']|["']$/g, '').trim() : '';
  };
  const APPLY = argv.includes('--apply');
  const DIAGNOSE = argv.includes('--diagnose');
  const SKIP_SCAN = argv.includes('--skip-backup-scan');
  const invoiceNumber = norm(arg('--invoice'));
  const replacedBy = norm(arg('--replaced-by'));
  const jobNumber = norm(arg('--job'));
  const quoteNumber = norm(arg('--quote'));
  const companyArg = arg('--company');
  const predecessor = norm(arg('--predecessor'));
  const issueDateArg = arg('--issue-date');
  const dueDateArg = arg('--due-date');
  const evidenceFile = arg('--evidence-file');
  const cancelledByArg = arg('--cancelled-by');
  const reason = arg('--reason') || 'Order changed by the client after invoicing; re-invoiced';
  const confirm = arg('--confirm');
  const connectTimeoutArg = arg('--connect-timeout');
  const connectTimeoutMs = (/^\d+$/.test(connectTimeoutArg) && Number(connectTimeoutArg) >= 5 && Number(connectTimeoutArg) <= 300 ? Number(connectTimeoutArg) : 30) * 1000;
  const requiredConfirm = `CANCEL ${invoiceNumber} REPLACED BY ${replacedBy}`;

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Refusing to run.\n\nPowerShell:\n  $env:DATABASE_URL = "<connection string>"');
    process.exitCode = 1; return;
  }
  if (!/^INV-\d+$/.test(invoiceNumber) || !/^INV-\d+$/.test(replacedBy) || !/^SNS-\d+$/.test(jobNumber) || (predecessor && !/^INV-\d+$/.test(predecessor))) {
    console.error('Usage: --invoice=INV-00223 --replaced-by=INV-00231 --job=SNS-00236 [--quote=SQ-00304] [--company=2] [--predecessor=INV-00219] [--issue-date=YYYY-MM-DD] [--due-date=YYYY-MM-DD] [--reason="..."] [--cancelled-by="Name"] [--evidence-file=path] [--skip-backup-scan] [--connect-timeout=30] [--diagnose] [--apply --confirm="CANCEL INV-00223 REPLACED BY INV-00231"]');
    process.exitCode = 1; return;
  }
  for (const [flag, v] of [['--issue-date', issueDateArg], ['--due-date', dueDateArg]]) {
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) { console.error(`${flag} must be YYYY-MM-DD`); process.exitCode = 1; return; }
  }
  if (APPLY && DIAGNOSE) { console.error('--diagnose and --apply cannot be combined.'); process.exitCode = 1; return; }

  let client: Client | null = null;
  let inTx = false;
  const problems: string[] = [];
  const problem = (m: string) => { problems.push(m); log('   ✗ ' + m); };
  try {
    client = await connectWithRetry(connectTimeoutMs, 3);
    log('==============================================================');
    log(` SIGNACORE — RECORD CANCELLED INVOICE  ${APPLY ? '(APPLY)' : DIAGNOSE ? '(READ-ONLY DIAGNOSTIC — nothing is written)' : '(DRY RUN — nothing is written)'}`);
    log(` ${invoiceNumber}  "Cancelled by Admin"  -> replaced by ${replacedBy}   (job ${jobNumber}${quoteNumber ? ', quote ' + quoteNumber : ''}${predecessor ? ', predecessor ' + predecessor : ''})`);
    log('==============================================================');
    if (!APPLY) { await client.query('BEGIN TRANSACTION READ ONLY'); inTx = true; }
    const who = (await client.query('SELECT current_database() AS db, now() AS at')).rows[0];
    log(`database ${who.db}   at ${who.at}${APPLY ? '' : '   (transaction is READ ONLY)'}`);
    log('');

    // ── 1. JOB / QUOTE / COMPANY — verified, not assumed ─────────────────────
    log('1. LINKAGE');
    const jobsAll = (await client.query('SELECT * FROM rel_jobs WHERE UPPER(BTRIM(job_number)) = $1 ORDER BY id', [jobNumber])).rows;
    const jobs = companyArg ? jobsAll.filter((j: any) => String(j.company_code) === companyArg) : jobsAll;
    for (const j of jobsAll) log(`   job candidate   id ${j.id}  ${j.job_number}  company ${j.company_code}  "${j.customer_name_raw ?? ''}"  invoice_num ${j.invoice_num ?? '-'}  quote_id ${j.quote_id ?? '-'}`);
    if (jobs.length !== 1) {
      throw new Stop(`expected exactly one job ${jobNumber}${companyArg ? ' in company ' + companyArg : ''}, found ${jobs.length}.${jobsAll.length > 1 ? ' Add --company=<code> to choose.' : ''}`);
    }
    const job = jobs[0];
    const company = String(job.company_code);
    log(`   JOB             id ${job.id}  ${job.job_number}  company ${company}  invoice_created ${job.invoice_created}  value ${job.value}`);

    let quote: any = null;
    if (job.quote_id) quote = (await client.query('SELECT id, quote_number, company_code, converted_job_id FROM rel_quotes WHERE id = $1', [job.quote_id])).rows[0] || null;
    log(`   QUOTE           ${quote ? `id ${quote.id}  ${quote.quote_number}  company ${quote.company_code}  converted_job_id ${quote.converted_job_id ?? '-'}` : '(the job has no linked quote)'}`);
    if (quote && String(quote.company_code) !== company) problem(`the job's quote ${quote.quote_number} is company ${quote.company_code}, the job is company ${company}.`);
    if (quoteNumber && (!quote || norm(quote.quote_number) !== quoteNumber)) problem(`the job's linked quote is ${quote ? quote.quote_number : '(none)'}, not ${quoteNumber}.`);
    if (quote && quote.converted_job_id != null && String(quote.converted_job_id) !== String(job.id)) problem(`quote ${quote.quote_number} says it converted to job id ${quote.converted_job_id}, not ${job.id}.`);

    const repl = (await client.query(
      `SELECT * FROM rel_invoices WHERE company_code = $1 AND UPPER(BTRIM(invoice_number)) = $2`, [company, replacedBy]
    )).rows[0];
    if (!repl) {
      problem(`replacement invoice ${replacedBy} not found in company ${company}.`);
    } else {
      log(`   REPLACEMENT     id ${repl.id}  ${repl.invoice_number}  status ${repl.status}  job_id ${repl.job_id ?? '-'}  quote_id ${repl.quote_id ?? '-'}  issued ${d10(repl.issue_date) ?? '-'}  "${repl.contact_name ?? ''}"`);
      if (String(repl.status ?? '') === 'void') problem(`${replacedBy} is itself cancelled (void).`);
      const byJobId = repl.job_id !== null && Number(repl.job_id) === Number(job.id);
      const byJobNum = norm(job.invoice_num) === replacedBy;
      log(`                   belongs to the job: by job_id ${byJobId ? 'YES' : 'no'}; job.invoice_num = ${job.invoice_num ?? '-'} ${byJobNum ? '(matches)' : '(does NOT match)'}`);
      if (!byJobId && !byJobNum) problem(`${replacedBy} does not belong to job ${jobNumber}.`);
      if (repl.job_id !== null && !byJobId) problem(`${replacedBy} is linked to a different job (job_id ${repl.job_id}).`);
    }

    // ── 2. THE NUMBER ────────────────────────────────────────────────────────
    log('');
    log('2. THE NUMBER');
    const holders = (await client.query(
      `SELECT id, company_code, status FROM rel_invoices WHERE UPPER(BTRIM(invoice_number)) = $1 ORDER BY id`, [invoiceNumber]
    )).rows;
    const mine = holders.filter((h: any) => String(h.company_code) === company);
    log(`   ${invoiceNumber} in company ${company}: ${mine.length ? mine.map((h: any) => `id ${h.id} (${h.status})`).join(', ') : 'not held — free'}`);
    const others = holders.filter((h: any) => String(h.company_code) !== company);
    if (others.length) log(`   (the same number in another company — unrelated, untouched: ${others.map((h: any) => `company ${h.company_code} id ${h.id} ${h.status}`).join(', ')})`);
    if (mine.length) problem(`${invoiceNumber} already exists in company ${company} (id ${mine.map((h: any) => h.id).join(', ')}) — nothing to put back.`);
    const counter = (await client.query(
      `SELECT last_number FROM document_number_counters WHERE company = $1 AND doc_type = 'invoice'`, [company]
    )).rows[0];
    const invN = parseInt(invoiceNumber.replace(/^INV-/, ''), 10);
    log(`   invoice counter (company ${company}): last_number ${counter ? counter.last_number : '(no row)'}`);
    if (!counter || Number(counter.last_number) < invN) problem(`the counter has not passed ${invoiceNumber}; recording it now could collide with a future invoice.`);

    // ── 3. THE CHAIN ─────────────────────────────────────────────────────────
    log('');
    log('3. REPLACEMENT CHAIN');
    const pointing = (await client.query(
      `SELECT id, invoice_number, status, legacy_data->>'replacedBy' AS replaced_by, legacy_data->>'originalJobNum' AS job_num
         FROM rel_invoices WHERE company_code = $1 AND UPPER(BTRIM(COALESCE(legacy_data->>'replacedBy',''))) = ANY($2::text[]) ORDER BY id`,
      [company, [invoiceNumber, replacedBy]]
    )).rows;
    const preds = pointing.filter((p: any) => norm(p.replaced_by) === invoiceNumber);
    const rivals = pointing.filter((p: any) => norm(p.replaced_by) === replacedBy);
    log(`   already recorded as replaced by ${invoiceNumber}: ${preds.length ? preds.map((p: any) => `${p.invoice_number} (id ${p.id}, ${p.status}, job ${p.job_num ?? '-'})`).join(', ') : 'none'}`);
    log(`   already recorded as replaced by ${replacedBy}: ${rivals.length ? rivals.map((p: any) => `${p.invoice_number} (id ${p.id})`).join(', ') : 'none'}`);
    if (predecessor && !preds.some((p: any) => norm(p.invoice_number) === predecessor)) problem(`${predecessor} is not recorded as replaced by ${invoiceNumber} — the chain ${predecessor} → ${invoiceNumber} cannot be confirmed.`);
    for (const p of preds) if (p.job_num && norm(p.job_num) !== jobNumber) problem(`${p.invoice_number} points at ${invoiceNumber} but belongs to job ${p.job_num}, not ${jobNumber}.`);
    if (rivals.length) problem(`${rivals.map((p: any) => p.invoice_number).join(', ')} already name${rivals.length === 1 ? 's' : ''} ${replacedBy} as the replacement — the chain would fork.`);
    log(`   resulting chain: ${preds.length ? preds.map((p: any) => p.invoice_number).join(' / ') + ' → ' : ''}${invoiceNumber} → ${replacedBy}   (existing records are not modified)`);

    // ── 4. EVIDENCE OF THE ORIGINAL DETAIL ───────────────────────────────────
    log('');
    log('4. EVIDENCE OF THE ORIGINAL INVOICE');
    let headerEv: any = null; let headerSrc = '';
    const hb = (await client.query(
      `SELECT id, created_at, reason, data->'replacementInvoice' AS h FROM platform_state_backups
        WHERE reason LIKE 'before-record-cancelled-%'
          AND UPPER(BTRIM(COALESCE(data->'replacementInvoice'->>'invoice_number',''))) = $1
          AND COALESCE(data->'replacementInvoice'->>'company_code','') = $2
        ORDER BY id DESC LIMIT 1`, [invoiceNumber, company]
    )).rows[0];
    if (hb && hb.h) { headerEv = hb.h; headerSrc = `platform_state_backups id ${hb.id} (${hb.reason}, ${d10(hb.created_at)})`; }
    const lineEv: LineEvidence[] = [];
    if (!SKIP_SCAN) {
      const ids = (await client.query(
        `SELECT id, created_at, reason FROM platform_state_backups WHERE data::text LIKE '%' || $1 || '%' ORDER BY id DESC LIMIT 60`, [invoiceNumber]
      )).rows;
      log(`   platform_state_backups rows mentioning ${invoiceNumber}: ${ids.length}${ids.length === 60 ? ' (newest 60 examined)' : ''}`);
      for (const r of ids) {
        const doc = (await client.query('SELECT data FROM platform_state_backups WHERE id = $1', [r.id])).rows[0];
        const f = findLineEvidence(doc && doc.data, invoiceNumber, company, `platform_state_backups id ${r.id} (${r.reason})`, d10(r.created_at));
        log(`     id ${r.id}  ${d10(r.created_at)}  ${r.reason}  ->  ${f.length ? f.length + ' copy/copies WITH line items' : 'no line items for it'}`);
        lineEv.push(...f);
      }
    } else {
      log('   platform_state_backups scan skipped (--skip-backup-scan).');
    }
    if (evidenceFile) {
      const p = path.resolve(evidenceFile);
      const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
      const f = findLineEvidence(doc, invoiceNumber, company, `file ${path.basename(p)}`, null);
      log(`   --evidence-file ${p}  ->  ${f.length ? f.length + ' copy/copies WITH line items' : 'no line items for it'}`);
      lineEv.unshift(...f);
    }
    if (!headerEv) { const withHeader = lineEv.find((e) => e.header); if (withHeader) { headerEv = withHeader.header; headerSrc = withHeader.source; } }
    const distinct = Array.from(new Map(lineEv.map((e) => [linesKey(e.lines), e])).values());
    const chosen = distinct[0] || null;
    if (distinct.length > 1) {
      log(`   NOTE: ${distinct.length} DIFFERENT versions of the lines were found (the invoice was revised in place). The first listed — the file you passed, else the NEWEST backup — is used:`);
      for (const e of distinct) log(`     ${e.source}  ${e.at ?? ''}  ${e.lines.length} line(s)  total ${money(totalCents(e.lines))}`);
    }

    const pick = (...vals: any[]) => { for (const v of vals) if (v !== undefined && v !== null && v !== '') return v; return null; };
    const H = headerEv || {};
    const header = {
      customerId: pick(H.customer_id, repl && repl.customer_id, job.customer_id),
      contactName: pick(H.contact_name, H.contactName, repl && repl.contact_name, job.customer_name_raw),
      contactEmail: pick(H.contact_email, H.contactEmail, repl && repl.contact_email),
      contactAddress: pick(H.contact_address, H.contactAddress, repl && repl.contact_address),
      reference: pick(H.reference, `Cancelled by Admin — replaced by ${replacedBy}`),
      issueDate: pick(issueDateArg, d10(H.issue_date), d10(H.issueDate), d10(H.date), repl && d10(repl.issue_date), new Date().toISOString().slice(0, 10)),
      dueDate: pick(dueDateArg, d10(H.due_date), d10(H.dueDate)),
      statusBefore: pick(H.status),
      originalId: pick(H.id),
    };
    const src = (fromEvidence: boolean, argUsed?: boolean) => argUsed ? 'SUPPLIED BY YOU' : fromEvidence ? 'EVIDENCE' : 'FALLBACK';
    log('');
    log(`   HEADER  ${headerEv ? 'EVIDENCE: ' + headerSrc : 'NO EVIDENCE FOUND — FALLBACK values from the replacement invoice / job are used'}`);
    log(`     customer_id      ${header.customerId ?? '-'}   [${src(H.customer_id != null)}]`);
    log(`     contact          "${header.contactName ?? ''}"   [${src(pick(H.contact_name, H.contactName) != null)}]`);
    log(`     email / address  ${header.contactEmail ?? '-'} / ${header.contactAddress ? String(header.contactAddress).replace(/\s+/g, ' ').slice(0, 60) : '-'}   [${src(pick(H.contact_email, H.contactEmail, H.contact_address, H.contactAddress) != null)}]`);
    log(`     reference        "${header.reference}"   [${src(H.reference != null && H.reference !== '')}]`);
    const rawIssue = pick(H.issue_date, H.issueDate, H.date);
    log(`     issue date       ${header.issueDate}   [${src(rawIssue != null, !!issueDateArg)}]${!issueDateArg && !rawIssue ? "  <- the REPLACEMENT's date, not the original" : ''}${!issueDateArg && rawIssue && String(rawIssue) !== header.issueDate ? `  (stored in the backup as ${rawIssue}, read in this PC's time zone — pass --issue-date=YYYY-MM-DD if it should differ)` : ''}`);
    log(`     due date         ${header.dueDate ?? '(none)'}   [${src(pick(H.due_date, H.dueDate) != null, !!dueDateArg)}]`);
    log(`     status before    ${header.statusBefore ?? '(unknown)'}   [${src(H.status != null)}]`);
    const lines: EvidenceLine[] = chosen ? chosen.lines : [{
      description: `CANCELLED BY ADMIN — superseded by ${replacedBy} (Job ${job.job_number}${quote ? ' / Quote ' + quote.quote_number : ''}). The original line detail was not recoverable. No amount is due on this invoice.`,
      qty: 1, unitAmount: 0, accountCode: '4000', taxType: '15%',
    }];
    log(`   LINES   ${chosen ? `EVIDENCE: ${chosen.source}${chosen.at ? ' ' + chosen.at : ''} — ${lines.length} line(s), total ${money(totalCents(lines))} incl. VAT` : 'NO EVIDENCE FOUND — FALLBACK: one explanatory line at R0.00 (the original lines and amount are NOT reconstructed)'}`);
    for (const l of lines) log(`     ${String(l.qty).padStart(8)} x ${String(l.unitAmount).padStart(12)}  ${l.taxType ?? '-'}  ${String(l.description ?? '').slice(0, 90)}`);

    const marker = Object.assign(buildInvoiceCancellationMarker({
      cancelledBy: cancelledByArg || 'Admin (recorded by recovery script)', cancelledById: null,
      reason, via: 'src/scripts/record-cancelled-invoice.ts',
      statusBeforeCancel: header.statusBefore,
      originalJobId: Number(job.id), originalJobNum: job.job_number,
      originalQuoteId: quote ? Number(quote.id) : null, originalQuoteNum: quote ? quote.quote_number : null,
      originalDetailRetained: !!chosen, replacedBy: repl ? repl.invoice_number : replacedBy, replacedById: repl ? Number(repl.id) : null,
    }), {
      recoveredAfterDelete: true,
      originalInvoiceId: header.originalId != null ? String(header.originalId) : null,
      headerEvidence: headerEv ? headerSrc : null,
      lineEvidence: chosen ? chosen.source : null,
      note: `${invoiceNumber} was deleted before invoices were retained on cancellation, and re-issued as ${replacedBy}. Recorded as cancelled so the number stays on file. `
        + (chosen ? 'Its original lines were recovered from a backup.' : 'The original line detail was not recoverable and is not reconstructed — the R0.00 line is a placeholder.')
        + (headerEv ? '' : ' Customer and date were taken from the replacement invoice.'),
    });

    log('');
    if (DIAGNOSE) {
      log(problems.length ? `DIAGNOSTIC COMPLETE — ${problems.length} problem(s) would stop a recovery:` : 'DIAGNOSTIC COMPLETE — no problems found. The recovery dry run should pass.');
      for (const p of problems) log('   - ' + p);
      log('Nothing was written (READ ONLY transaction).');
      return;
    }
    if (problems.length) throw new Stop('cannot record:\n   - ' + problems.join('\n   - '));

    log('PRE-CHECKS PASSED. Would insert:');
    log(`   rel_invoices  ${invoiceNumber}  company ${company}  status 'void'  issue_date ${header.issueDate}  due_date ${header.dueDate ?? 'NULL'}`);
    log(`                 contact "${header.contactName ?? ''}"  reference "${header.reference}"`);
    log(`                 job/quote kept as text only: ${job.job_number}${quote ? ' / ' + quote.quote_number : ''}  (job_id, quote_id = NULL)`);
    log(`   ${lines.length} line(s), total ${money(totalCents(lines))}  ${chosen ? '(recovered original detail)' : '(FALLBACK placeholder)'}`);
    log(`   legacy_data ${JSON.stringify(marker)}`);
    if (!APPLY) {
      log('');
      log('DRY RUN — nothing was written (READ ONLY transaction). To apply:');
      log(`   npm run record:cancelled-invoice -- ${argv.filter((a) => a !== '--diagnose').join(' ')} --apply --confirm="${requiredConfirm}"`);
      return;
    }
    if (confirm !== requiredConfirm) throw new Stop(`--confirm must be exactly "${requiredConfirm}".`);

    await client.query('BEGIN'); inTx = true;
    // Re-check under the transaction: the number must still be free.
    const again = await client.query(
      `SELECT 1 FROM rel_invoices WHERE company_code = $1 AND UPPER(BTRIM(invoice_number)) = $2`, [company, invoiceNumber]
    );
    if ((again.rowCount ?? 0) > 0) throw new Stop(`${invoiceNumber} appeared while running — nothing written.`);

    const backupPayload = { case: `record ${invoiceNumber} as cancelled, replaced by ${replacedBy}`, job, quote, replacementInvoice: repl, predecessors: preds, header, lines, marker };
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
                                 reference, job_id, job_number_raw, quote_id, quote_number_raw, status, issue_date, due_date, legacy_data)
       SELECT new_id.id, new_id.id::text, $1, $2, $3, $4, $5, $6, $7, NULL, $8, NULL, $9, 'void', $10::date, $11::date, $12::jsonb FROM new_id
       RETURNING id`,
      [invoiceNumber, company, header.customerId, header.contactName, header.contactEmail, header.contactAddress,
       header.reference, job.job_number, quote ? quote.quote_number : null, header.issueDate, header.dueDate, JSON.stringify(marker)]
    )).rows[0];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      await client.query(
        `INSERT INTO rel_invoice_line_items (invoice_id, line_index, description, qty, unit_amount, account_code, tax_type, legacy_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb)`,
        [ins.id, i, l.description, l.qty, l.unitAmount, l.accountCode, l.taxType]
      );
    }

    // Verify inside the transaction.
    const v = (await client.query(
      `SELECT i.status, i.job_id, i.quote_id, COUNT(l.id)::int AS n,
              (SELECT COUNT(*)::int FROM rel_payments p WHERE p.owner_type='invoice' AND p.owner_id=i.id) AS pays
         FROM rel_invoices i LEFT JOIN rel_invoice_line_items l ON l.invoice_id = i.id
        WHERE i.id = $1 GROUP BY i.id, i.status, i.job_id, i.quote_id`, [ins.id]
    )).rows[0];
    if (!v || v.status !== 'void' || v.n !== lines.length || v.pays !== 0 || v.job_id !== null || v.quote_id !== null) {
      throw new Error('post-insert verification failed: ' + JSON.stringify(v));
    }
    await client.query('COMMIT'); inTx = false;
    log(`INSERTED rel_invoices id ${ins.id}  ${invoiceNumber}  status void, ${lines.length} line(s), no payments, no job/quote link`);
    log('');
    log(`DONE. Refresh the dashboard: ${invoiceNumber} shows in Sales → Invoices and Accounting → Invoices as`);
    log(`"🚫 Cancelled by Admin → ${replacedBy}". It is not counted in any total or balance.`);
  } catch (err: any) {
    log('');
    if (err instanceof Stop) { log('STOPPED — nothing was written.'); log('   ' + err.message); }
    else { log('FAILED — rolled back, nothing was written: ' + (err && err.message ? err.message : err)); }
    process.exitCode = 1;
  } finally {
    if (inTx && client) { try { await client.query('ROLLBACK'); } catch { /* ignore */ } }
    const outPath = path.resolve(process.cwd(), `record-cancelled-${invoiceNumber.toLowerCase() || 'invoice'}-report.txt`);
    try { fs.writeFileSync(outPath, out.join('\n') + '\n', 'utf8'); console.log('\nReport saved to: ' + outPath); } catch { /* ignore */ }
    if (client) await client.end().catch(() => undefined);
  }
}

main();
