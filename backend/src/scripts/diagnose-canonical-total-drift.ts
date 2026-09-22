/**
 * diagnose-canonical-total-drift.ts — READ-ONLY.
 *
 * Reports, in SEPARATE categories, every difference the 2026-09-22 one-cent
 * reconciliation exposes — so a person can see the exact impact, and so three
 * quite different things stop being reported as one.
 *
 * ── THE FOUR CATEGORIES ───────────────────────────────────────────────────
 *
 *   1. SETTLEMENT DRIFT
 *      The stored status disagrees with what the corrected settlement rule
 *      says, comparing the CORRECT payable against the chain's payments.
 *      This is the only category that is about what the customer owes.
 *
 *   2. SOURCE REPRESENTATION DIFFERENCE
 *      The invoice's or the job's LINE arithmetic differs from the commercial
 *      payable. This is a documentation/reconciliation observation, NOT a
 *      settlement drift, and it is reported separately for exactly that
 *      reason. SNS-00128 is the reference case: job lines reconstruct to
 *      R16,044.80 against an agreed value of R24,963.62 — an older commercial
 *      representation that was never re-saved, not a rounding discrepancy.
 *
 *   3. LEGACY ROUNDING SETTLEMENT CANDIDATE
 *      The payment sequence proves the OLD platform itself generated the final
 *      payment amount: it offered a remaining balance, exactly that was
 *      captured, the old interface then displayed R0.00, and the whole residual
 *      under the corrected payable is the difference between the two
 *      derivations. Evidence-based — never "the difference is one cent".
 *
 *   4. GENUINE UNDERPAYMENT
 *      Money is genuinely short and no replay explains it. No tolerance, ever.
 *
 * ── THE PAYABLE-SOURCE HIERARCHY THIS REPORT USES (OPTION D) ──────────────
 *
 *   ISSUED INVOICE       -> that invoice's own canonical cents total, through
 *                           the SHARED document pipeline (each line rounded to
 *                           cents, VAT ONCE over the taxable base — never a sum
 *                           of independently rounded per-line VAT amounts)
 *   JOB WITH NO INVOICE  -> that job's rel_jobs.value, in cents
 *
 *   rel_job_line_items is NEVER a settlement candidate. A stale job-line
 *   reconstruction (SNS-00128: R16,044.80 against an agreed R24,963.62) is a
 *   SOURCE REPRESENTATION DIFFERENCE and is reported as such.
 *
 *   SARS half-up VAT is preserved throughout: R21,707.50 x 15% = R3,256.125 ->
 *   R3,256.13. No VAT figure is ever reduced to make an older stored value fit.
 *
 * WHAT THIS SCRIPT WRITES: nothing. It opens no transaction, issues no INSERT,
 * UPDATE or DELETE, takes no locks, and is not run by Render — neither
 * `npm start` nor `npm run migrate` references it. Trigger it by hand:
 *
 *   # from backend/, with DATABASE_URL set in the environment
 *   npm run diagnose:canonical-total-drift
 *   npm run diagnose:canonical-total-drift:compiled     # against a built dist/
 *
 *   npm run diagnose:canonical-total-drift -- --all     # include clean records
 *   npm run diagnose:canonical-total-drift -- --limit 50
 *   npm run diagnose:canonical-total-drift -- --csv
 *
 * Historical repair is a SEPARATE utility (reconcile-historical-settlement.ts)
 * and is dry-run by default. Nothing here rewrites an issued document's money.
 */
import pool from '../db/pool';
import { sgrLegacySettlementApplies } from '../relational/services';

/* ── BEGIN SGR-CANONICAL-CENTS ─────────────────────────────────────────────
   The same pipeline index.html and services.ts run, kept tiny and standalone
   so a diagnostic can run against a build of the app it is diagnosing. The
   regression suite proves all three produce identical integers. */
function toUnits4(n: unknown): number {
  if (n === null || n === undefined || n === '') return NaN;
  const x = Number(n);
  if (!Number.isFinite(x)) return NaN;
  const s = x.toFixed(4);
  const neg = s.charCodeAt(0) === 45;
  const b = neg ? s.slice(1) : s;
  const dot = b.indexOf('.');
  const u = Number(b.slice(0, dot)) * 10000 + Number(b.slice(dot + 1));
  if (!Number.isSafeInteger(u)) return NaN;
  return neg ? -u : u;
}
function divRound(a: number, den: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(den) || den <= 0) return NaN;
  const neg = a < 0, m = neg ? -a : a;
  const q = (m - (m % den)) / den;
  const out = q + ((m % den) * 2 >= den ? 1 : 0);
  return neg ? -out : out;
}
function mulDivRound(base: number, num: number, den: number): number {
  const neg = (base < 0) !== (num < 0);
  const p = Math.abs(base) * Math.abs(num);
  if (!Number.isSafeInteger(p)) return NaN;
  const out = divRound(p, den);
  return neg ? -out : out;
}
function toCents(n: unknown): number {
  const u = toUnits4(n);
  return Number.isFinite(u) ? divRound(u, 100) : 0;
}
function extCents(qty: unknown, unitAmount: unknown): number {
  const q = toUnits4(qty === null || qty === undefined || qty === '' ? 1 : qty);
  const u = toUnits4(unitAmount === null || unitAmount === undefined || unitAmount === '' ? 0 : unitAmount);
  if (!Number.isFinite(q) || !Number.isFinite(u)) return 0;
  const p = q * u;
  if (Number.isSafeInteger(p)) return divRound(p, 1000000);
  return toCents((q / 10000) * (u / 10000));
}
/** Canonical cents of an invoice, from its own line rows. */
function invoiceCents(rows: Array<{ qty: unknown; unit_amount: unknown; tax_type?: unknown }>): number {
  let subC = 0, taxC = 0;
  for (const l of rows) {
    const c = extCents(l.qty, l.unit_amount);
    subC += c;
    if (l.tax_type === '15%') taxC += c;
  }
  return subC + (mulDivRound(taxC, 15, 100) || 0);
}
/** Canonical cents of a DOCUMENT held as lines + discount% + setup fee.
 *  REPORTED ONLY — never a settlement candidate. */
function documentCents(
  lines: Array<{ pieces?: unknown; qty: unknown; unit_price: unknown; subtotal?: unknown }>,
  discountPct: unknown, setupFee: unknown
): number {
  let subC = 0;
  for (const l of lines) {
    const rawP = Number(l.pieces);
    const pieces = Number.isFinite(rawP) && rawP > 0 ? rawP : 1;
    const hasQty = !(l.qty === null || l.qty === undefined || l.qty === '');
    const hasRate = !(l.unit_price === null || l.unit_price === undefined || l.unit_price === '');
    let done = false;
    if (hasQty || hasRate) {
      const q = toUnits4(hasQty ? l.qty : 1);
      const u = toUnits4(hasRate ? l.unit_price : 0);
      if (Number.isFinite(q) && Number.isFinite(u)) {
        const p = q * pieces * u;
        subC += Number.isSafeInteger(p) ? divRound(p, 1000000) : toCents((q * pieces / 10000) * (u / 10000));
        done = true;
      }
    }
    if (!done) subC += toCents(l.subtotal);   // the commercial-line fallback
  }
  const pctU = toUnits4(discountPct || 0);
  const discC = Number.isFinite(pctU) ? (mulDivRound(subC, pctU, 1000000) || 0) : 0;
  const setupC = toCents(setupFee);
  const taxableC = subC - discC + setupC;
  return taxableC + (mulDivRound(taxableC, 15, 100) || 0);
}
/* END SGR-CANONICAL-CENTS */

/* ── THE OLD ARITHMETIC, reproduced exactly ───────────────────────────────
   So the report can state what the platform used to say, and so the legacy
   replay below is a replay rather than a guess. */
function oldCents(n: unknown): number { return Math.round(Math.round((Number(n) || 0) * 100) / 100 * 100); }
/** The old invoice total: raw float products, VAT summed PER LINE. */
function oldInvoiceTotalCents(rows: Array<{ qty: unknown; unit_amount: unknown; tax_type?: unknown }>): number {
  const raw = rows.reduce((s, l) => {
    const sub = Number(l.qty) * Number(l.unit_amount);
    if (!Number.isFinite(sub)) return s;
    return s + sub + (l.tax_type === '15%' ? sub * 0.15 : 0);
  }, 0);
  return oldCents(raw);
}

/* ── APPLY ELIGIBILITY ─────────────────────────────────────────────────────
   THE single statement of what `reconcile-historical-settlement.ts --apply` is
   permitted to write, printed by BOTH tools so a category can never be labelled
   one way here and another way there. `--apply` is LEGACY-ROUNDING-ONLY: it is
   the audited, evidence-replayed historical settlement and nothing else.
   Settlement drift is REPORT ONLY — a stored status disagreeing with the
   corrected rule is a separate project and is never repaired by this utility. */
export const APPLY_ELIGIBILITY: Record<Category, string> = {
  'legacy-rounding-candidate': 'YES — status + additive legacyRoundingSettlement marker',
  'settlement-drift':          'NO — REPORT ONLY (separate project; --apply never writes these)',
  'genuine-underpayment':      'NO — real money outstanding; must stay outstanding',
  'source-representation':     'NO — DOCUMENTATION ONLY; no debt and no status change',
  'clean':                     'NO — nothing to do',
};
export const APPLY_ELIGIBILITY_ALREADY_MARKED =
  'NO — NO NEW WRITE (an audited marker already applies)';

function zar(cents: number): string {
  const neg = cents < 0, a = Math.abs(cents);
  return (neg ? '-R' : 'R') + (a / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function statusWord(totalC: number, paidC: number): string {
  if (totalC <= 0) return paidC > 0 ? 'partial' : 'pending';
  if (paidC >= totalC) return 'paid';
  if (paidC > 0) return 'partial';
  return 'pending';
}

/* ── THE LEGACY REPLAY ─────────────────────────────────────────────────────
   Four conditions, all required. See index.html's
   sgrClassifyLegacyRoundingSettlement for the full reasoning. */
export interface LegacyVerdict {
  qualifies: boolean;
  reason: string;
  oldTotalCents?: number;
  offeredCents?: number;
  priorPaidCents?: number;
  finalPaymentCents?: number;
  paymentCount?: number;
  meaningfulPaymentCount?: number;
  zeroValuePaymentCount?: number;
}

/* THE FINAL MONETARY PAYMENT OF A CHAIN — 2026-09-22 (ZERO-ROW REPLAY FIX).
   A R0.00 rel_payments row is never the payment a replay tests. No shipped
   settlement path has ever recorded a payment BECAUSE a balance reached zero:
   markInvPaid guards `remaining>0`, markCanonicalInvoicePaid returns early on
   `remaining<=0`, every payment modal rejects `<=0`, and the auto-credit effect
   requires `>0.005`. When the old platform considered a balance settled it
   recorded NOTHING and wrote only status 'paid'. A zero row is therefore an
   audit-trail artefact — typically a legacy JSON entry whose amount was
   missing, blank or non-numeric, which backfill's `num(p.amount)` fallback
   turned into 0.00 — and carries no statement about the balance at all.
   It stays in the chain, stays counted and stays printed; it simply cannot be
   the amount the old platform is claimed to have generated.
   Mirrors index.html's sgrLastMeaningfulPayment exactly. */
function lastMeaningfulPayment(ordered: Array<{ amount: unknown }>) {
  let lastIdx = -1, meaningfulCount = 0, zeroCount = 0, paidC = 0;
  for (let i = 0; i < ordered.length; i++) {
    const c = toCents(ordered[i].amount);
    paidC += c;
    if (c === 0) { zeroCount++; continue; }
    meaningfulCount++; lastIdx = i;
  }
  const finalC = lastIdx < 0 ? 0 : toCents(ordered[lastIdx].amount);
  return { lastIdx, finalCents: finalC, priorCents: paidC - finalC, paidCents: paidC,
           meaningfulCount, zeroCount, count: ordered.length };
}
function classifyLegacyRounding(
  payments: Array<{ amount: unknown; payment_date: unknown; line_index: unknown }>,
  payableC: number, paidC: number, oldTotalCandidatesC: number[]
): LegacyVerdict {
  const residualC = payableC - paidC;
  if (residualC <= 0) return { qualifies: false, reason: 'no residual — already settled or overpaid' };
  // 2026-09-22 (OPTION D): payment COUNT is not the evidence. A one-payment
  // transaction was offered the FULL total by the old modal, which is just as
  // much a platform-generated figure as a remaining balance.
  if (!payments.length) return { qualifies: false, reason: 'no payments recorded' };
  const ordered = payments.slice().sort((a, b) => {
    const da = String(a.payment_date ?? ''), db = String(b.payment_date ?? '');
    if (da !== db) return da < db ? -1 : 1;
    return (Number(a.line_index) || 0) - (Number(b.line_index) || 0);
  });
  // The last MEANINGFUL payment — never a R0.00 row (see lastMeaningfulPayment).
  const chain = lastMeaningfulPayment(ordered);
  const counts = { paymentCount: chain.count, meaningfulPaymentCount: chain.meaningfulCount,
                   zeroValuePaymentCount: chain.zeroCount };
  if (chain.lastIdx < 0) return { qualifies: false, ...counts,
    reason: 'every payment in this chain is a R0.00 row — there is no monetary payment to replay, '
          + 'and a zero row is never evidence that the old platform generated an amount' };
  const lastC = chain.finalCents;
  const priorC = chain.priorCents;
  const zeroNote = chain.zeroCount
    ? ` (${chain.zeroCount} zero-value payment row${chain.zeroCount === 1 ? '' : 's'} in the chain `
      + 'carried no instruction and were not replayed)' : '';
  const tried: number[] = [];
  for (const oldTotalC of oldTotalCandidatesC) {
    if (!Number.isSafeInteger(oldTotalC)) continue;
    tried.push(oldTotalC);
    if (oldTotalC - priorC !== lastC) continue;            // 2. instructed === captured
    if (paidC !== oldTotalC) continue;                     // 3. old UI reached R0.00
    if (payableC - oldTotalC !== residualC) continue;      // 4. residual IS the derivation gap
    const shape = chain.meaningfulCount === 1 ? 'the full payable total' : 'the remaining balance';
    return {
      qualifies: true, ...counts, oldTotalCents: oldTotalC, offeredCents: oldTotalC - priorC,
      priorPaidCents: priorC, finalPaymentCents: lastC,
      reason: `the old platform's own total was ${zar(oldTotalC)}; it instructed ${zar(oldTotalC - priorC)} as `
            + `${shape}${priorC > 0 ? ` after ${zar(priorC)} already received` : ''}, exactly that was captured, `
            + `and the old interface then showed Balance R0.00. The corrected canonical payable is `
            + `${zar(payableC)}, so the entire residual of ${zar(residualC)} is the difference between the two `
            + `derivations — no part of it is the customer paying less than the platform requested${zeroNote}`,
    };
  }
  return {
    qualifies: false, ...counts,
    reason: `the captured final MEANINGFUL payment of ${zar(lastC)} does not replay as a platform-generated `
          + `amount (old totals tried: ${tried.map(zar).join(', ') || 'none'}; prior payments ${zar(priorC)})`
          + zeroNote,
  };
}

/* ── the scan ─────────────────────────────────────────────────────────────── */

type Category = 'settlement-drift' | 'legacy-rounding-candidate' | 'genuine-underpayment'
              | 'source-representation' | 'clean';

interface Row {
  kind: 'job' | 'invoice';
  ref: string;
  company: string;
  date: string;
  category: Category;
  payableSource: string;
  payableCents: number;
  paidCents: number;
  residualCents: number;
  storedStatus: string;
  correctedStatus: string;
  lineTotalCents: number | null;     // the record's own line arithmetic, for context
  jobLineTotalCents: number | null;  // reported, NEVER a settlement candidate
  note: string;
}

const argv = process.argv.slice(2);
const SHOW_ALL = argv.includes('--all');
const AS_CSV = argv.includes('--csv');
const LIMIT = (() => {
  const i = argv.indexOf('--limit');
  const n = i >= 0 ? Number(argv[i + 1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : Infinity;
})();

async function main() {
  const client = await pool.connect();
  const rows: Row[] = [];
  let jobsScanned = 0, invoicesScanned = 0;

  try {
    /* Payments, per owner. Summed into a chain total below exactly as
       resolveTransactionChainTx resolves it: quote + job + invoice of one
       transaction, each payment counted once. Read only. */
    const payRes = await client.query(
      `SELECT owner_type, owner_id, amount, payment_date, line_index FROM rel_payments
        ORDER BY owner_type, owner_id, payment_date NULLS FIRST, line_index`
    );
    const payByOwner = new Map<string, Array<{ amount: unknown; payment_date: unknown; line_index: unknown }>>();
    for (const p of payRes.rows) {
      const k = p.owner_type + ':' + p.owner_id;
      if (!payByOwner.has(k)) payByOwner.set(k, []);
      payByOwner.get(k)!.push({ amount: p.amount, payment_date: p.payment_date, line_index: p.line_index });
    }
    const chainPayments = (parts: Array<[string, number | null]>) => {
      const out: Array<{ amount: unknown; payment_date: unknown; line_index: unknown }> = [];
      for (const [t, id] of parts) {
        if (id === null || id === undefined) continue;
        for (const p of (payByOwner.get(t + ':' + id) || [])) out.push(p);
      }
      return out.sort((a, b) => {
        const da = String(a.payment_date ?? ''), db = String(b.payment_date ?? '');
        if (da !== db) return da < db ? -1 : 1;
        return (Number(a.line_index) || 0) - (Number(b.line_index) || 0);
      });
    };
    const sumC = (ps: Array<{ amount: unknown }>) => ps.reduce((s, p) => s + toCents(p.amount), 0);

    /* ── JOBS ──────────────────────────────────────────────────────────── */
    const jobsRes = await client.query(
      `SELECT j.id, j.job_number, j.company_code, j.value, j.discount_pct, j.setup_fee,
              j.invoice_status, j.quote_id, j.created_at,
              (SELECT i.id FROM rel_invoices i WHERE i.job_id = j.id
                 AND i.status IS DISTINCT FROM 'void' ORDER BY i.id LIMIT 1) AS invoice_id
         FROM rel_jobs j ORDER BY j.id`
    );
    for (const j of jobsRes.rows) {
      jobsScanned++;
      // THE AUTHORITY for a job with no issued invoice: its stored commercial
      // value. (A job WITH an invoice is reported through that invoice below.)
      const payableC = toCents(j.value);
      const ps = chainPayments([['job', j.id], ['quote', j.quote_id], ['invoice', j.invoice_id]]);
      const paidC = sumC(ps);
      const residualC = payableC - paidC;
      const corrected = statusWord(payableC, paidC);
      const stored = j.invoice_status || '(none)';

      // Reported for context only — NEVER a settlement candidate.
      const lr = await client.query(
        `SELECT qty, unit_price, pieces, subtotal FROM rel_job_line_items
          WHERE job_id = $1 ORDER BY line_index`, [j.id]
      );
      const jobLineC = lr.rowCount ? documentCents(lr.rows as any[], j.discount_pct, j.setup_fee) : null;
      const repDiff = jobLineC !== null && jobLineC !== payableC;

      let category: Category = 'clean';
      let note = '';
      if (stored !== '(none)' && stored !== corrected) category = 'settlement-drift';
      else if (repDiff) { category = 'source-representation'; note = 'job line reconstruction differs from the agreed commercial value'; }
      if (category === 'clean' && !SHOW_ALL) continue;
      rows.push({
        kind: 'job', ref: j.job_number || ('job#' + j.id), company: j.company_code || '',
        date: j.created_at ? String(j.created_at).slice(0, 10) : '',
        category, payableSource: 'rel_jobs.value',
        payableCents: payableC, paidCents: paidC, residualCents: residualC,
        storedStatus: stored, correctedStatus: corrected,
        lineTotalCents: null, jobLineTotalCents: jobLineC, note,
      });
    }

    /* ── INVOICES ──────────────────────────────────────────────────────── */
    const invRes = await client.query(
      `SELECT i.id, i.invoice_number, i.company_code, i.status, i.issue_date,
              i.job_id, i.quote_id, i.legacy_data,
              j.value AS job_value, j.job_number
         FROM rel_invoices i
         LEFT JOIN rel_jobs j ON j.id = i.job_id
        WHERE i.status IS DISTINCT FROM 'void'
        ORDER BY i.id`
    );
    for (const i of invRes.rows) {
      invoicesScanned++;
      const lr = await client.query(
        `SELECT qty, unit_amount, tax_type FROM rel_invoice_line_items
          WHERE invoice_id = $1 ORDER BY line_index`, [i.id]
      );
      const ownLineC = invoiceCents(lr.rows as any[]);
      const jobLinked = i.job_id !== null && i.job_id !== undefined;
      // THE AUTHORITY (Option D): the ISSUED INVOICE's own canonical cents.
      const payableC = ownLineC;
      const payableSource = 'issued invoice lines (canonical cents)';

      const ps = chainPayments([['invoice', i.id], ['job', i.job_id], ['quote', i.quote_id]]);
      const paidC = sumC(ps);
      const residualC = payableC - paidC;
      const marked = sgrLegacySettlementApplies(i.legacy_data, payableC, paidC);
      const corrected = marked ? 'paid' : statusWord(payableC, paidC);
      const stored = i.status || '(none)';

      let category: Category = 'clean';
      let note = marked
        ? 'an audited legacy rounding settlement marker applies — APPLY ELIGIBILITY: '
          + APPLY_ELIGIBILITY_ALREADY_MARKED
        : '';
      if (residualC > 0 && paidC > 0 && !marked) {
        // Both derivations the old code could have offered are replayed: the
        // invoice's own lines, and the linked job's value.
        const verdict = classifyLegacyRounding(ps, payableC, paidC,
          [oldInvoiceTotalCents(lr.rows as any[]), jobLinked ? oldCents(i.job_value) : NaN]);
        category = verdict.qualifies ? 'legacy-rounding-candidate' : 'genuine-underpayment';
        note = verdict.reason;
      } else if (stored !== '(none)' && stored !== corrected) {
        category = 'settlement-drift';
      } else if (jobLinked && toCents(i.job_value) !== payableC) {
        category = 'source-representation';
        note = note || `rel_jobs.value ${zar(toCents(i.job_value))} differs from the issued invoice total — `
             + 'a representation difference, not a debt';
      }
      if (category === 'clean' && !SHOW_ALL) continue;
      rows.push({
        kind: 'invoice', ref: i.invoice_number || ('inv#' + i.id), company: i.company_code || '',
        date: i.issue_date ? String(i.issue_date).slice(0, 10) : '',
        category, payableSource,
        payableCents: payableC, paidCents: paidC, residualCents: residualC,
        storedStatus: stored, correctedStatus: corrected,
        lineTotalCents: ownLineC, jobLineTotalCents: null, note,
      });
    }
  } finally {
    client.release();
  }

  /* ── output ───────────────────────────────────────────────────────────── */
  const ORDER: Category[] = ['settlement-drift', 'legacy-rounding-candidate', 'genuine-underpayment', 'source-representation', 'clean'];
  const byCat = (c: Category) => rows.filter(r => r.category === c);

  if (AS_CSV) {
    console.log('category,kind,ref,company,date,payable_source,payable,paid,residual,stored_status,corrected_status,own_line_total,job_line_total,apply_eligibility,note');
    for (const c of ORDER) for (const r of byCat(c).slice(0, LIMIT === Infinity ? undefined : LIMIT)) {
      console.log([r.category, r.kind, r.ref, r.company, r.date, JSON.stringify(r.payableSource),
        (r.payableCents / 100).toFixed(2), (r.paidCents / 100).toFixed(2), (r.residualCents / 100).toFixed(2),
        r.storedStatus, r.correctedStatus,
        r.lineTotalCents === null ? '' : (r.lineTotalCents / 100).toFixed(2),
        r.jobLineTotalCents === null ? '' : (r.jobLineTotalCents / 100).toFixed(2),
        JSON.stringify(APPLY_ELIGIBILITY[r.category]),
        JSON.stringify(r.note)].join(','));
    }
    await pool.end();
    return;
  }

  const pad = (s: string, n: number) => (s + ' '.repeat(n)).slice(0, n);
  const rpad = (s: string, n: number) => (' '.repeat(n) + s).slice(-n);
  console.log('');
  console.log('CANONICAL SETTLEMENT IMPACT — READ-ONLY REPORT');
  console.log('='.repeat(118));
  console.log(`scanned: ${jobsScanned} jobs, ${invoicesScanned} invoices`);
  console.log('payable source (Option D): ISSUED INVOICE -> its own canonical cents | JOB with no invoice -> rel_jobs.value');
  console.log('rel_job_line_items is reported for context and is NEVER a settlement candidate. SARS half-up VAT preserved.');

  const TITLES: Record<Category, string> = {
    'settlement-drift': '1. SETTLEMENT DRIFT — the stored status disagrees with the corrected rule',
    'legacy-rounding-candidate': '2. LEGACY ROUNDING SETTLEMENT CANDIDATES — the old platform generated the final amount',
    'genuine-underpayment': '3. GENUINE UNDERPAYMENTS — real money short, no tolerance applied',
    'source-representation': '4. SOURCE REPRESENTATION DIFFERENCES — documentation only, NOT a settlement drift',
    'clean': '5. CLEAN',
  };
  for (const c of ORDER) {
    const list = byCat(c);
    if (c === 'clean' && !SHOW_ALL) continue;
    console.log('');
    console.log(TITLES[c] + `   (${list.length})`);
    console.log('  APPLY ELIGIBILITY: ' + APPLY_ELIGIBILITY[c]);
    console.log('-'.repeat(118));
    if (!list.length) { console.log('  none'); continue; }
    const shown = LIMIT === Infinity ? list : list.slice(0, LIMIT);
    for (const r of shown) {
      console.log('  ' + pad(r.kind, 8) + pad(r.ref, 13) + pad(r.date, 12)
        + rpad(zar(r.payableCents), 14) + rpad(zar(r.paidCents), 14) + rpad(zar(r.residualCents), 10)
        + '  ' + pad(r.storedStatus + ' -> ' + r.correctedStatus, 22) + r.payableSource);
      if (r.lineTotalCents !== null && r.lineTotalCents !== r.payableCents) {
        console.log('        invoice lines: ' + zar(r.lineTotalCents) + '  (representation, not the payable)');
      }
      if (r.jobLineTotalCents !== null && r.jobLineTotalCents !== r.payableCents) {
        console.log('        job lines:     ' + zar(r.jobLineTotalCents) + '  (representation, not the payable)');
      }
      if (r.note) console.log('        ' + r.note);
    }
    if (shown.length < list.length) console.log(`  … ${list.length - shown.length} more`);
  }

  console.log('');
  console.log('-'.repeat(118));
  const paidToPartial = rows.filter(r => r.storedStatus === 'paid' && r.correctedStatus !== 'paid').length;
  const partialToPaid = rows.filter(r => r.storedStatus !== 'paid' && r.correctedStatus === 'paid').length;
  console.log(`  paid -> partial : ${paidToPartial}`);
  console.log(`  partial -> paid : ${partialToPaid}`);
  console.log(`  legacy rounding candidates : ${byCat('legacy-rounding-candidate').length}`);
  console.log(`  genuine underpayments      : ${byCat('genuine-underpayment').length}`);
  console.log(`  source-representation only : ${byCat('source-representation').length}`);
  console.log('');
  console.log('  APPLY ELIGIBILITY (reconcile-historical-settlement.ts --apply)');
  console.log('  ' + '-'.repeat(114));
  console.log('    LEGACY ROUNDING SETTLEMENT     : ' + APPLY_ELIGIBILITY['legacy-rounding-candidate']);
  console.log('    SETTLEMENT DRIFT               : ' + APPLY_ELIGIBILITY['settlement-drift']);
  console.log('    GENUINE UNDERPAYMENT           : ' + APPLY_ELIGIBILITY['genuine-underpayment']);
  console.log('    SOURCE REPRESENTATION DIFFERENCE: ' + APPLY_ELIGIBILITY['source-representation']);
  console.log('    ALREADY MARKED                 : ' + APPLY_ELIGIBILITY_ALREADY_MARKED);
  console.log('');
  console.log('  NOTHING WAS WRITTEN. No INSERT, UPDATE or DELETE was issued, no transaction was');
  console.log('  opened, no payment or adjustment row was created, and no record was repaired.');
  console.log('  Historical repair lives in reconcile-historical-settlement.ts and is dry-run by default.');
  console.log('');
  await pool.end();
}

main().catch(err => { console.error('diagnose-canonical-total-drift failed:', err); pool.end(); process.exit(1); });
