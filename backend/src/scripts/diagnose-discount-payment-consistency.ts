/**
 * diagnose-discount-payment-consistency.ts — READ-ONLY.
 *
 * Reports, for review by a person, the three conditions the 2026-09-07
 * discount/payment consistency pass can identify but must NEVER act on by
 * itself:
 *
 *   1. PAYMENTS THAT WERE INVISIBLE. Payments owned by a quote or a job whose
 *      transaction has since been invoiced. Before this pass, index.html's
 *      resolvePaymentSource()/resolveQuotePaymentSource() showed ONLY the
 *      invoice's own payments once an invoice existed, so these rows were
 *      unreachable from every screen — perfectly intact, but absent from the
 *      payments modal, the invoice balance and the statement. They are visible
 *      again now (read.ts resolves an invoice's payments across its whole
 *      chain). This list exists because a user who could not see one of these
 *      may well have CAPTURED IT AGAIN, which is condition 2.
 *
 *   2. SUSPECTED DUPLICATE PAYMENTS. Two or more payments within ONE
 *      transaction chain of the same amount, close together in time. This is a
 *      REVIEW LIST, never a verdict: a customer may legitimately pay R5,000 and
 *      another R5,000 on the same day, and those are two real payments. Only a
 *      person with the bank statement can tell the difference, so nothing here
 *      is deleted, merged, flagged in the database, or altered in any way.
 *
 *   3. DISCOUNTS THAT DISAGREE. Quote/job/invoice members of one chain holding
 *      different discount percentages. Going forward this cannot arise: a
 *      discount change from either end cascades across the chain in one
 *      transaction. Historical records are NOT normalised automatically —
 *      rewriting an issued invoice's money without a person deciding to would
 *      be exactly the kind of silent change this codebase forbids.
 *
 * WHAT THIS SCRIPT WRITES: nothing. It opens no transaction, issues no INSERT,
 * UPDATE or DELETE, and holds no locks. It is safe to run against live at any
 * time, including while people are working.
 *
 *   npm run diagnose:discount-payment-consistency
 */
import pool from '../db/pool';

/** How close in time two same-amount payments must be to be worth a look.
 *  Deliberately generous: this is a list for a human to read, and a false
 *  positive costs a glance while a false negative hides a real duplicate. */
const DUPLICATE_WINDOW_DAYS = 3;

interface ChainRow {
  chain_key: string;
  company_code: string;
  quote_id: string | null;
  quote_number: string | null;
  quote_discount: string | null;
  job_id: string | null;
  job_number: string | null;
  job_discount: string | null;
  invoice_id: string | null;
  invoice_number: string | null;
}

function money(n: unknown): string {
  return 'R ' + (Number(n) || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** payment_date is a DATE column, which node-postgres hands back as a JS Date —
 *  and a Date dropped into a template literal renders as
 *  "Sat Aug 01 2026 00:00:00 GMT+0000 (Coordinated Universal Time)". This is a
 *  list a person reads line by line against a bank statement, so the date is
 *  printed the way every other date in this platform is: YYYY-MM-DD. */
function dateStr(d: unknown): string {
  if (!d) return 'no date';
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

async function main(): Promise<void> {
  console.log('Signacore — discount / payment consistency diagnostic (READ-ONLY)');
  console.log('='.repeat(78));
  console.log('Nothing below is changed, deleted or repaired. This is a review list.\n');

  // ── 1) PAYMENTS THAT WERE INVISIBLE ───────────────────────────────────────
  // A quote- or job-owned payment whose chain has an active invoice. Linkage is
  // proven FK columns only, and company_code is compared on both sides so a
  // mislinked historical row can never be reported across companies.
  const invisible = await pool.query(`
    SELECT p.id            AS payment_id,
           p.owner_type,
           p.owner_id,
           p.amount,
           p.payment_date,
           p.method,
           p.notes,
           i.invoice_number,
           i.company_code
      FROM rel_payments p
      JOIN rel_invoices i
        ON COALESCE(i.status, '') <> 'void'
       AND (
             (p.owner_type = 'quote' AND (i.quote_id = p.owner_id
                OR i.job_id IN (SELECT j.id FROM rel_jobs j WHERE j.quote_id = p.owner_id)))
          OR (p.owner_type = 'job'   AND i.job_id = p.owner_id)
           )
     WHERE p.owner_type IN ('quote', 'job')
       AND i.company_code = COALESCE(
             (SELECT q.company_code FROM rel_quotes q WHERE p.owner_type = 'quote' AND q.id = p.owner_id),
             (SELECT j.company_code FROM rel_jobs   j WHERE p.owner_type = 'job'   AND j.id = p.owner_id)
           )
     ORDER BY p.payment_date NULLS LAST, p.id
  `);

  console.log(`1. PAYMENTS THAT WERE UNREACHABLE FROM EVERY SCREEN — ${invisible.rowCount} found`);
  console.log('   (owned by a quote/job whose transaction has an invoice; visible again now)');
  if (invisible.rowCount === 0) {
    console.log('   None. No payment was hidden by this defect.\n');
  } else {
    for (const r of invisible.rows) {
      console.log(`   payment #${r.payment_id}  ${money(r.amount)}  ${dateStr(r.payment_date)}  ${r.method || 'no method'}`
        + `  owner=${r.owner_type} ${r.owner_id}  now shown on invoice ${r.invoice_number} (company ${r.company_code})`
        + (r.notes ? `  notes="${String(r.notes).slice(0, 60)}"` : ''));
    }
    console.log('   → Check each against the bank statement. If one was re-captured while it was');
    console.log('     invisible, its twin will appear in section 2 below.\n');
  }

  // ── 2) SUSPECTED DUPLICATE PAYMENTS ───────────────────────────────────────
  // Same chain, same amount, within the window. NEVER a verdict — see the header.
  const chains = await pool.query<ChainRow>(`
    SELECT DISTINCT
           COALESCE('q' || q.id, 'j' || j.id, 'i' || i.id) AS chain_key,
           COALESCE(q.company_code, j.company_code, i.company_code) AS company_code,
           q.id::text AS quote_id, q.quote_number, q.discount_pct::text AS quote_discount,
           j.id::text AS job_id,   j.job_number,   j.discount_pct::text AS job_discount,
           i.id::text AS invoice_id, i.invoice_number
      FROM rel_jobs j
      FULL OUTER JOIN rel_quotes   q ON q.id = j.quote_id
      LEFT JOIN      rel_invoices  i ON COALESCE(i.status,'') <> 'void'
                                    AND (i.job_id = j.id OR i.quote_id = q.id)
  `);

  let duplicateGroups = 0;
  console.log(`2. SUSPECTED DUPLICATE PAYMENTS (same transaction, same amount, within ${DUPLICATE_WINDOW_DAYS} days)`);
  for (const c of chains.rows) {
    const owners: Array<[string, string]> = [];
    if (c.quote_id) owners.push(['quote', c.quote_id]);
    if (c.job_id) owners.push(['job', c.job_id]);
    if (c.invoice_id) owners.push(['invoice', c.invoice_id]);
    if (owners.length === 0) continue;

    const pays = await pool.query(
      `SELECT p.id, p.owner_type, p.owner_id, p.amount, p.payment_date, p.method, p.notes, p.client_request_id
         FROM rel_payments p
         JOIN UNNEST($1::text[], $2::bigint[]) AS c(owner_type, owner_id)
           ON p.owner_type = c.owner_type AND p.owner_id = c.owner_id
        ORDER BY p.payment_date NULLS LAST, p.id`,
      [owners.map((o) => o[0]), owners.map((o) => o[1])]
    );
    if ((pays.rowCount || 0) < 2) continue;

    const byAmount = new Map<string, any[]>();
    for (const p of pays.rows) {
      const key = (Number(p.amount) || 0).toFixed(2);
      const bucket = byAmount.get(key);
      if (bucket) bucket.push(p); else byAmount.set(key, [p]);
    }
    for (const [amt, group] of byAmount) {
      if (group.length < 2) continue;
      // Only report pairs that are also CLOSE IN TIME. Two identical amounts
      // months apart are almost certainly a recurring arrangement, not a
      // mis-capture.
      const close = group.filter((p, idx) => group.some((o, oIdx) => {
        if (idx === oIdx) return false;
        if (!p.payment_date || !o.payment_date) return true; // undated — worth a look
        const days = Math.abs(new Date(p.payment_date).getTime() - new Date(o.payment_date).getTime()) / 86400000;
        return days <= DUPLICATE_WINDOW_DAYS;
      }));
      if (close.length < 2) continue;
      duplicateGroups++;
      const label = [c.quote_number && `quote ${c.quote_number}`, c.job_number && `job ${c.job_number}`, c.invoice_number && `invoice ${c.invoice_number}`]
        .filter(Boolean).join(' → ');
      console.log(`   ${money(amt)} x${close.length}  on ${label}  (company ${c.company_code})`);
      for (const p of close) {
        console.log(`      payment #${p.id}  ${dateStr(p.payment_date)}  ${p.method || 'no method'}  owner=${p.owner_type} ${p.owner_id}`
          + (p.client_request_id ? '  [has a submission key]' : '')
          + (p.notes ? `  notes="${String(p.notes).slice(0, 50)}"` : ''));
      }
    }
  }
  if (duplicateGroups === 0) console.log('   None found.');
  console.log('   → REVIEW ONLY. Two payments of the same amount on the same day can be entirely');
  console.log('     legitimate. Confirm against the bank statement before removing anything, and');
  console.log('     remove it through the app so credit notes and statuses stay correct.\n');

  // ── 3) DISCOUNTS THAT DISAGREE ────────────────────────────────────────────
  let divergent = 0;
  console.log('3. DISCOUNTS THAT DISAGREE WITHIN ONE TRANSACTION');
  for (const c of chains.rows) {
    if (!c.quote_id || !c.job_id) continue;
    const qd = Number(c.quote_discount) || 0;
    const jd = Number(c.job_discount) || 0;
    if (Math.abs(qd - jd) < 0.0005) continue;
    divergent++;
    console.log(`   quote ${c.quote_number} = ${qd}%   but   job ${c.job_number} = ${jd}%`
      + (c.invoice_number ? `   (invoice ${c.invoice_number})` : '') + `   [company ${c.company_code}]`);
  }
  if (divergent === 0) console.log('   None found.');
  console.log('   → NOT normalised automatically. Open the transaction and save the correct');
  console.log('     discount once from the Quote or the Edit Invoice screen; that now cascades');
  console.log('     across the quote, the job and the invoice in one transaction.\n');

  console.log('='.repeat(78));
  console.log('Diagnostic complete. Nothing was changed.');
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('Diagnostic failed:', err && err.message ? err.message : err);
    await pool.end().catch(() => undefined);
    process.exitCode = 1;
  });
