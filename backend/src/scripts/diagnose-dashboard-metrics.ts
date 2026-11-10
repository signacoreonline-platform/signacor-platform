/**
 * diagnose-dashboard-metrics.ts — READ-ONLY.
 *
 * Prints, per company context, the figures the Dashboard SHOULD show after the
 * 2026-11-10 dashboard repair, computed INDEPENDENTLY from the database (SQL +
 * integer cents), so a person can compare them with the live screen:
 *
 *   1. SALESMAN OF THE MONTH — jobs created in the Johannesburg month, ranked by
 *      job count (then value, then name); names grouped trimmed and case-
 *      insensitively; unassigned jobs listed separately, never ranked.
 *      Created = a legacy millisecond-timestamp source_id when there is one,
 *      otherwise rel_jobs.created_at. A plain PK id is never read as a date.
 *   2. THE AUGUST 2026 CONVERSION GAP — server-created jobs from 20–24 Aug 2026
 *      with no salesperson (convertQuoteToJob did not copy it before 23f58fb).
 *      Reported only; nothing is reassigned.
 *   3. REVENUE (incl. VAT) — every ISSUED invoice (not void, not draft) at its
 *      canonical payable, in the Johannesburg month of its issue date, plus
 *      every job invoice with no accounting record (job.value, job.invoice_date).
 *      Undated invoices are listed, never guessed into a month.
 *   4. OUTSTANDING — the remaining balance of those same invoices (payable −
 *      the chain's payments: own + job + quote, same company, each rel_payment
 *      once; an audited legacy rounding settlement owes 0), less open customer
 *      credit-note balances (amount − used_amount).
 *   5. INV-00219 / INV-00223 — the cancelled invoice contributes nothing; the
 *      replacement is represented exactly once.
 *
 * COMPANY CONTEXT matches the dashboard's belongsToUserCompany(): "Holdings" is
 * company_code 1; "Original company" is everything else (codes 2/3/4 and none).
 *
 * WHAT THIS SCRIPT WRITES: nothing. Every query runs inside BEGIN READ ONLY,
 * which Postgres enforces — any write would fail — and the transaction is
 * rolled back. It never prints DATABASE_URL. Not run by Render: neither
 * `npm start` nor `npm run migrate` references it.
 *
 *   # from backend/, with DATABASE_URL set in this shell
 *   npm run build
 *   npm run diagnose:dashboard-metrics:compiled
 *   npm run diagnose:dashboard-metrics:compiled -- --month 2026-11
 */
import pool from '../db/pool';
import { sgrInvoiceCentsFromRows, sgrToCents0, sgrLegacySettlementApplies } from '../relational/services';

const argv = process.argv.slice(2);
const argVal = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};

/* ── Johannesburg dates (UTC+02:00 all year, no daylight saving) ─────────── */
const jhbDateFromMs = (ms: number): string => new Date(ms + 2 * 3600 * 1000).toISOString().slice(0, 10);
const nowMonth = jhbDateFromMs(Date.now()).slice(0, 7);
const MONTH = argVal('--month') || nowMonth;
if (!/^\d{4}-\d{2}$/.test(MONTH)) { console.error('--month must be YYYY-MM'); process.exit(2); }
const shiftMonth = (key: string, delta: number): string => {
  const y = +key.slice(0, 4), m = +key.slice(5, 7) - 1 + delta;
  const yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12;
  return yy + '-' + String(mm + 1).padStart(2, '0');
};
const CHART_FIRST = MONTH <= '2026-10' ? '2026-05' : shiftMonth(MONTH, -5);
const CHART_MONTHS = Array.from({ length: 6 }, (_, i) => shiftMonth(CHART_FIRST, i));

const LEGACY_MIN = 1420070400000, LEGACY_MAX = 4102444800000;   // 2015-01-01 … 2100-01-01
function legacyTimestampMs(sourceId: unknown): number | null {
  if (sourceId === null || sourceId === undefined) return null;
  const s = String(sourceId).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= LEGACY_MIN && n < LEGACY_MAX ? Math.floor(n) : null;
}

const ctxOf = (code: unknown): 'Holdings' | 'Original company' =>
  (code !== null && code !== undefined && String(code).trim() !== '' && Number(code) === 1) ? 'Holdings' : 'Original company';
const CONTEXTS: Array<'Original company' | 'Holdings'> = ['Original company', 'Holdings'];
const R = (c: number): string => (c < 0 ? '-' : '') + 'R ' + (Math.abs(c) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const norm = (s: unknown): string => String(s ?? '').trim().replace(/\s+/g, ' ');
const isTitle = (s: string): boolean => s.split(' ').every((w) => !w || (w[0] === w[0].toUpperCase() && w[0] !== w[0].toLowerCase()));

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const db = await client.query(`SELECT current_database() AS db, current_setting('transaction_read_only') AS ro`);
    const roRow = db.rows[0];

    const jobs = (await client.query(
      `SELECT id, source_id, job_number, company_code, salesperson, value, stage, status, quote_id,
              invoice_num, invoice_date::text AS invoice_date,
              to_char(created_at AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI') AS created_jhb
         FROM rel_jobs ORDER BY id`)).rows;
    const quotes = (await client.query(`SELECT id, quote_number, company_code, salesperson FROM rel_quotes`)).rows;
    const invoices = (await client.query(
      `SELECT id, invoice_number, company_code, status, issue_date::text AS issue_date, job_id, job_number_raw,
              quote_id, reference, legacy_data
         FROM rel_invoices ORDER BY id`)).rows;
    const lines = (await client.query(
      `SELECT invoice_id, qty, unit_amount, tax_type FROM rel_invoice_line_items ORDER BY invoice_id, line_index`)).rows;
    const payments = (await client.query(`SELECT id, owner_type, owner_id, amount FROM rel_payments`)).rows;
    const credits = (await client.query(
      `SELECT id, credit_number, note_type, company_code, amount, used_amount FROM rel_credit_notes`)).rows;

    const quoteById = new Map(quotes.map((q: any) => [String(q.id), q]));
    const jobById = new Map(jobs.map((j: any) => [String(j.id), j]));
    const linesByInv = new Map<string, any[]>();
    for (const l of lines) { const k = String(l.invoice_id); if (!linesByInv.has(k)) linesByInv.set(k, []); linesByInv.get(k)!.push(l); }
    const payByOwner = new Map<string, any[]>();
    for (const p of payments) { const k = p.owner_type + ':' + p.owner_id; if (!payByOwner.has(k)) payByOwner.set(k, []); payByOwner.get(k)!.push(p); }
    const sameCo = (a: unknown, b: unknown): boolean => String(a ?? '') === String(b ?? '');

    console.log('==============================================================');
    console.log(' SIGNACORE — DASHBOARD METRICS (READ-ONLY)   month ' + MONTH + ' (Africa/Johannesburg)');
    console.log('==============================================================');
    console.log('database ' + roRow.db + '   transaction read-only: ' + roRow.ro + '   run at ' + new Date().toISOString());
    console.log('rows read: jobs ' + jobs.length + ', quotes ' + quotes.length + ', invoices ' + invoices.length +
      ', invoice lines ' + lines.length + ', payments ' + payments.length + ', credit notes ' + credits.length);

    /* ── job → issued invoice links (same rules as read.ts + index.html) ──── */
    const live = invoices.filter((i: any) => i.status !== 'void');
    const linkedInvByJob = new Map<string, any>();
    const ambiguousJobs: string[] = [];
    for (const j of jobs) {
      const num = norm(j.invoice_num).toUpperCase();
      const cands = live.filter((i: any) => sameCo(i.company_code, j.company_code) && (
        String(i.job_id) === String(j.id) ||
        norm(i.reference) === norm(j.job_number) || norm(i.job_number_raw) === norm(j.job_number) ||
        (num !== '' && norm(i.invoice_number).toUpperCase() === num)));
      const uniq = Array.from(new Set(cands));
      if (uniq.length === 1) linkedInvByJob.set(String(j.id), uniq[0]);
      else if (uniq.length > 1) ambiguousJobs.push(j.job_number + ' (' + uniq.map((i: any) => i.invoice_number).join(', ') + ')');
    }
    const jobByLinkedInv = new Map<string, any>();
    for (const [jid, inv] of linkedInvByJob) jobByLinkedInv.set(String(inv.id), jobById.get(jid));

    /* ── canonical invoice rows ───────────────────────────────────────────── */
    type Row = { ctx: string; number: string; source: string; draft: boolean; issue: string | null;
                 payableC: number; paidC: number; outC: number; marker: boolean };
    const rows: Row[] = [];
    const chainPaidC = (owners: string[]): number => {
      const seen = new Set<string>(); let c = 0;
      for (const o of owners) for (const p of payByOwner.get(o) || []) {
        if (seen.has(String(p.id))) continue; seen.add(String(p.id)); c += sgrToCents0(p.amount);
      }
      return c;
    };
    for (const i of live) {
      const payableC = sgrInvoiceCentsFromRows(linesByInv.get(String(i.id)) || []).totalC;
      const job = i.job_id != null ? jobById.get(String(i.job_id)) : jobByLinkedInv.get(String(i.id));
      const owners = ['invoice:' + i.id];
      if (job && sameCo(job.company_code, i.company_code)) owners.push('job:' + job.id);
      const qid = i.quote_id != null ? i.quote_id : (job ? job.quote_id : null);
      const q = qid != null ? quoteById.get(String(qid)) : null;
      if (q && sameCo(q.company_code, i.company_code)) owners.push('quote:' + q.id);
      const paidC = chainPaidC(owners);
      const marker = sgrLegacySettlementApplies(i.legacy_data, payableC, paidC);
      rows.push({ ctx: ctxOf(i.company_code), number: i.invoice_number, source: 'invoice', draft: i.status === 'draft',
        issue: i.issue_date || null, payableC, paidC, outC: marker ? 0 : Math.max(0, payableC - paidC), marker });
    }
    for (const j of jobs) {
      if (!norm(j.invoice_num) || linkedInvByJob.has(String(j.id)) || ambiguousJobs.some((a) => a.startsWith(j.job_number + ' '))) continue;
      const payableC = sgrToCents0(j.value);
      const owners = ['job:' + j.id];
      const q = j.quote_id != null ? quoteById.get(String(j.quote_id)) : null;
      if (q && sameCo(q.company_code, j.company_code)) owners.push('quote:' + q.id);
      const paidC = chainPaidC(owners);
      rows.push({ ctx: ctxOf(j.company_code), number: norm(j.invoice_num), source: 'job-only (' + j.job_number + ')', draft: false,
        issue: j.invoice_date || null, payableC, paidC, outC: Math.max(0, payableC - paidC), marker: false });
    }

    for (const ctx of CONTEXTS) {
      console.log('\n##############################################################');
      console.log('#  ' + ctx.toUpperCase());
      console.log('##############################################################');

      /* 1. Salesman */
      const groups = new Map<string, { count: number; valueC: number; variants: Map<string, number> }>();
      let unassigned = 0, unassignedC = 0, undated = 0;
      const unassignedList: string[] = [];
      for (const j of jobs) {
        if (ctxOf(j.company_code) !== ctx) continue;
        const lms = legacyTimestampMs(j.source_id);
        const created = lms !== null ? jhbDateFromMs(lms) : (j.created_jhb ? String(j.created_jhb).slice(0, 10) : null);
        if (!created) { undated++; continue; }
        if (created.slice(0, 7) !== MONTH) continue;
        const display = norm(j.salesperson);
        const vC = sgrToCents0(j.value);
        if (!display) { unassigned++; unassignedC += vC; unassignedList.push(j.job_number); continue; }
        const key = display.toLowerCase();
        if (!groups.has(key)) groups.set(key, { count: 0, valueC: 0, variants: new Map() });
        const g = groups.get(key)!; g.count++; g.valueC += vC; g.variants.set(display, (g.variants.get(display) || 0) + 1);
      }
      const ranked = Array.from(groups.values()).map((g) => ({
        name: Array.from(g.variants.entries()).sort((a, b) =>
          ((isTitle(b[0]) ? 1 : 0) - (isTitle(a[0]) ? 1 : 0)) || (b[1] - a[1]) || a[0].localeCompare(b[0]))[0][0],
        count: g.count, valueC: g.valueC, spellings: Array.from(g.variants.keys()).join(' | '),
      })).sort((a, b) => (b.count - a.count) || (b.valueC - a.valueC) || a.name.localeCompare(b.name));
      console.log('\n1. SALESMAN OF THE MONTH — jobs created in ' + MONTH);
      if (!ranked.length) console.log('   (no assigned jobs)');
      ranked.forEach((r, i) => console.log('   ' + (i + 1) + '. ' + r.name.padEnd(22) + String(r.count).padStart(3) + ' job(s)  ' +
        R(r.valueC).padStart(14) + '   spellings: ' + r.spellings));
      console.log('   unassigned: ' + unassigned + ' job(s), ' + R(unassignedC) + (unassignedList.length ? '  [' + unassignedList.join(', ') + ']' : ''));
      console.log('   jobs with no resolvable creation date (all months): ' + undated);
      const w = ranked[0];
      console.log('   EXPECTED CARD: ' + (w
        ? w.name + ' · ' + w.count + ' job' + (w.count !== 1 ? 's' : '') + ' · ' + R(w.valueC) + (unassigned ? ' · ' + unassigned + ' unassigned' : '')
        : (unassigned ? '— · No assigned jobs this month · ' + unassigned + ' unassigned' : '— · No jobs created this month')));

      /* 2. August gap */
      const gap = jobs.filter((j: any) => ctxOf(j.company_code) === ctx && legacyTimestampMs(j.source_id) === null &&
        j.created_jhb && String(j.created_jhb) >= '2026-08-20' && String(j.created_jhb) < '2026-08-25' &&
        !norm(j.salesperson) && j.quote_id != null);
      console.log('\n2. AUGUST 2026 CONVERSION GAP — server jobs 20–24 Aug with no salesperson (report only, nothing changed)');
      if (!gap.length) console.log('   none');
      gap.forEach((j: any) => {
        const q = quoteById.get(String(j.quote_id));
        console.log('   ' + j.job_number + '  created ' + j.created_jhb + '  quote ' + (q ? q.quote_number : '?') +
          '  quote salesperson: ' + (q && norm(q.salesperson) ? norm(q.salesperson) : '(none)'));
      });

      /* 3. Revenue */
      const mine = rows.filter((r) => r.ctx === ctx);
      const issued = mine.filter((r) => !r.draft);
      const byMonth = new Map<string, number>();
      const undatedRows = issued.filter((r) => !r.issue);
      for (const r of issued) if (r.issue) byMonth.set(r.issue.slice(0, 7), (byMonth.get(r.issue.slice(0, 7)) || 0) + r.payableC);
      console.log('\n3. REVENUE (incl. VAT) — issued invoices by Johannesburg issue month');
      console.log('   EXPECTED Monthly Revenue card (' + MONTH + '): ' + R(byMonth.get(MONTH) || 0));
      console.log('   EXPECTED 6-month chart:');
      CHART_MONTHS.forEach((m) => console.log('     ' + m + '  ' + R(byMonth.get(m) || 0).padStart(16)));
      console.log('   invoices in ' + MONTH + ': ' + issued.filter((r) => r.issue && r.issue.slice(0, 7) === MONTH)
        .map((r) => r.number + ' ' + R(r.payableC)).join(', '));
      console.log('   drafts excluded: ' + mine.filter((r) => r.draft).length + '   undated (not in any month): ' + undatedRows.length +
        (undatedRows.length ? ' — ' + undatedRows.map((r) => r.number + ' ' + R(r.payableC)).join(', ') : ''));

      /* 4. Outstanding */
      const grossC = issued.reduce((s, r) => s + r.outC, 0);
      const openCreditC = credits.filter((c: any) => c.note_type === 'customer' && ctxOf(c.company_code) === ctx)
        .reduce((s: number, c: any) => s + Math.max(0, sgrToCents0(c.amount) - sgrToCents0(c.used_amount)), 0);
      console.log('\n4. OUTSTANDING');
      console.log('   remaining on issued invoices: ' + R(grossC) + '  (' + issued.filter((r) => r.outC > 0).length + ' invoices)');
      console.log('   less open customer credit:    ' + R(openCreditC));
      console.log('   EXPECTED panel "Outstanding": ' + R(grossC - openCreditC));
      const markers = issued.filter((r) => r.marker);
      if (markers.length) console.log('   audited legacy rounding settlements owing 0: ' + markers.map((r) => r.number).join(', '));
    }

    /* 5. INV-00219 / INV-00223 */
    console.log('\n##############################################################');
    console.log('#  5. INV-00219 (void) / INV-00223 (replacement)');
    console.log('##############################################################');
    for (const n of ['INV-00219', 'INV-00223']) {
      const recs = invoices.filter((i: any) => norm(i.invoice_number).toUpperCase() === n);
      recs.forEach((i: any) => {
        const t = sgrInvoiceCentsFromRows(linesByInv.get(String(i.id)) || []).totalC;
        console.log('   ' + n + '  id ' + i.id + '  company ' + i.company_code + '  status ' + i.status + '  issued ' + i.issue_date +
          '  job_id ' + (i.job_id ?? 'NULL') + '  lines total ' + R(t));
      });
      if (!recs.length) console.log('   ' + n + '  (no rel_invoices row)');
      const r = rows.filter((x) => x.number.toUpperCase() === n);
      const holders = jobs.filter((j: any) => norm(j.invoice_num).toUpperCase() === n).map((j: any) => j.job_number);
      console.log('   ' + n + '  canonical rows: ' + r.length + (r.length ? '  (' + r.map((x) => x.source + ', payable ' + R(x.payableC) +
        ', paid ' + R(x.paidC) + ', outstanding ' + R(x.outC) + ', issue ' + (x.issue || '—')).join(' | ') + ')' : '') +
        '   jobs carrying this invoice_num: ' + (holders.length ? holders.join(', ') : 'none'));
    }
    const r219 = rows.filter((x) => x.number.toUpperCase() === 'INV-00219').length;
    const r223 = rows.filter((x) => x.number.toUpperCase() === 'INV-00223').length;
    console.log('   CHECK  INV-00219 contributes nothing: ' + (r219 === 0 ? 'PASS' : 'FAIL (' + r219 + ' row(s))'));
    console.log('   CHECK  INV-00223 counted exactly once: ' + (r223 === 1 ? 'PASS' : 'FAIL (' + r223 + ' row(s))'));
    if (ambiguousJobs.length) console.log('\n   NOTE ambiguous job→invoice links (shown as review items, not counted as job-only): ' + ambiguousJobs.join('; '));

    await client.query('ROLLBACK');
    console.log('\nREAD-ONLY: transaction rolled back. Nothing was written.');
  } catch (e: any) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('ERROR: ' + (e && e.message ? e.message : String(e)));
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
