/**
 * reconcile-historical-settlement.ts — DRY RUN BY DEFAULT.
 *
 * Finds historical records whose STORED status disagrees with the corrected
 * settlement classification, explains why each one qualifies, and — only when
 * run explicitly with --apply — corrects the status and, where the evidence
 * supports it, writes a NON-MONETARY audit marker.
 *
 * ── WHAT IT MAY CHANGE, WITH --apply ──────────────────────────────────────
 *
 *   1. rel_invoices.status and rel_jobs.invoice_status — status fields only.
 *   2. rel_invoices.legacy_data — ADDITIVELY, one key, via
 *        legacy_data = COALESCE(legacy_data,'{}'::jsonb) || $marker::jsonb
 *      the SAME pattern writeQuoteInvoiceLinesTx already uses for
 *      commercialLineSource provenance. Every existing key is preserved; the
 *      whole object is never replaced.
 *
 * ── WHAT IT MUST NEVER CHANGE, WITH OR WITHOUT --apply ────────────────────
 *
 *   rel_payments (amounts, ownership, count) · rel_jobs.value · rel_quotes
 *   totals · rel_invoice_line_items · rel_job_line_items · VAT · discount ·
 *   setup fee · document numbers. There is no INSERT and no DELETE anywhere in
 *   this file, and the only UPDATEs are the two listed above.
 *
 * ── THE MARKER ────────────────────────────────────────────────────────────
 *
 *   legacy_data.legacyRoundingSettlement = {
 *     settled: true,
 *     reason: "system-generated-payment-amount",
 *     payableCentsAtVerification,                   <- what it was verified
 *     paidCentsAtVerification,                         against; all three must
 *     residualCents,                                   still hold to apply
 *     legacyGeneratedAmountCents,                   <- the amount the OLD
 *     oldTotalCents, priorPaidCents, paymentCount,     platform instructed
 *     verificationMode: "legacy-balance-replay",
 *     verifiedAt, version: 1,
 *     note: <the human explanation>
 *   }
 *
 *   It carries NO replacement invoice total, NO payment and NO adjustment. It
 *   records one fact: this historical invoice was settled with the final amount
 *   the OLD platform itself instructed the user to pay.
 *
 * ── HOW FUTURE RECOMPUTES DECIDE WHETHER IT STILL APPLIES ─────────────────
 *
 *   sgrLegacySettlementApplies(legacy_data, payableCents, paidCents) — in both
 *   services.ts and index.html — requires ALL of:
 *     * marker.settled === true and marker.version === 1
 *     * payableCentsAtVerification, paidCentsAtVerification, residualCents and
 *       legacyGeneratedAmountCents are safe integers
 *     * residualCents > 0 and payable - paid === residualCents
 *     * the CURRENT payable equals payableCentsAtVerification
 *     * the CURRENT chain paid total equals paidCentsAtVerification
 *
 *   The marker is never automatically rewritten or refreshed when the facts
 *   change — it simply stops applying, and the ordinary exact-cents rule takes
 *   over.
 *
 *   MARKER CREATION IS THIS SCRIPT ONLY. Nothing in index.html or services.ts
 *   writes this key: not a payment save, invoice save, job save, quote save,
 *   settlement recompute, status recompute or invoice synchronisation. They
 *   read and validate an existing marker; they never create one. So a future
 *   genuine R0.01 short payment can never be auto-classified as legacy.
 *
 *   So the moment a payment is added, edited or removed, or the job's
 *   commercial value changes by a single cent, the marker stops applying — on
 *   the very next recomputation, with no cleanup step and no human action. It
 *   cannot hide a later material change, and it cannot reach any other
 *   transaction: it lives on one invoice row and names that row's own figures.
 *
 *   It is removable: deleting the key, or setting settled:false, restores the
 *   ordinary rule immediately. It is recomputable: this script's dry run
 *   re-derives the same verdict from the payment data at any time.
 *
 *   ONE KNOWN INVALIDATOR TO BE AWARE OF: relational/backfill.ts REPLACES
 *   legacy_data wholesale when it re-imports a record from JSON. That is
 *   pre-existing behaviour (it would equally drop commercialLineSource) and it
 *   is a manually-triggered migration tool, not a runtime path — but a backfill
 *   re-run would clear these markers, and this script would need re-running.
 *
 * ── RUNNING IT ────────────────────────────────────────────────────────────
 *
 *   # from backend/, with DATABASE_URL set. DRY RUN — writes nothing:
 *   npm run reconcile:historical-settlement
 *   npm run reconcile:historical-settlement -- --csv
 *
 *   # only this explicitly applies the two permitted changes:
 *   npm run reconcile:historical-settlement -- --apply
 *
 *   Not run by Render: neither `npm start` nor `npm run migrate` references it.
 */
import pool from '../db/pool';
import { sgrLegacySettlementApplies, SGR_LEGACY_SETTLEMENT_KEY, SGR_LEGACY_SETTLEMENT_VERSION } from '../relational/services';

/* ── BEGIN SGR-CANONICAL-CENTS ─────────────────────────────────────────── */
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
function invoiceCents(rows: Array<{ qty: unknown; unit_amount: unknown; tax_type?: unknown }>): number {
  let subC = 0, taxC = 0;
  for (const l of rows) {
    const c = extCents(l.qty, l.unit_amount);
    subC += c;
    if (l.tax_type === '15%') taxC += c;
  }
  return subC + (mulDivRound(taxC, 15, 100) || 0);
}
/* END SGR-CANONICAL-CENTS */

function oldCents(n: unknown): number { return Math.round(Math.round((Number(n) || 0) * 100) / 100 * 100); }
function oldInvoiceTotalCents(rows: Array<{ qty: unknown; unit_amount: unknown; tax_type?: unknown }>): number {
  const raw = rows.reduce((s, l) => {
    const sub = Number(l.qty) * Number(l.unit_amount);
    if (!Number.isFinite(sub)) return s;
    return s + sub + (l.tax_type === '15%' ? sub * 0.15 : 0);
  }, 0);
  return oldCents(raw);
}
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

interface Pay { amount: unknown; payment_date: unknown; line_index: unknown; owner_type: string }
interface Verdict {
  qualifies: boolean; reason: string;
  oldTotalCents?: number; offeredCents?: number; priorPaidCents?: number; finalPaymentCents?: number;
  paymentCount?: number; meaningfulPaymentCount?: number; zeroValuePaymentCount?: number;
}

/* THE FINAL MONETARY PAYMENT OF A CHAIN — 2026-09-22 (ZERO-ROW REPLAY FIX).
   Identical rule to index.html's sgrLastMeaningfulPayment and the diagnostic's
   lastMeaningfulPayment: a R0.00 rel_payments row is never the payment a replay
   tests. No shipped settlement path records a payment BECAUSE a balance reached
   zero — markInvPaid guards `remaining>0`, markCanonicalInvoicePaid returns
   early on `remaining<=0`, every payment modal rejects `<=0`, the auto-credit
   effect requires `>0.005`. A settled balance produced NO row at all, only
   status 'paid'. A zero row is an audit-trail artefact (most often a legacy
   JSON entry with a missing/blank/non-numeric amount, which backfill's
   `num(p.amount)` fallback stored as 0.00) and says nothing about the balance.
   It remains in the chain and in the printed evidence; it is simply never the
   amount the old platform is claimed to have generated. */
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
/** The four conditions. See index.html's sgrClassifyLegacyRoundingSettlement. */
function classifyLegacyRounding(ordered: Pay[], payableC: number, paidC: number, candidates: number[]): Verdict {
  const residualC = payableC - paidC;
  if (residualC <= 0) return { qualifies: false, reason: 'no residual — already settled or overpaid' };
  // 2026-09-22 (OPTION D): payment COUNT is not the evidence. On a one-payment
  // transaction the old modal offered the FULL total, which is just as much a
  // platform-generated figure as a remaining balance after earlier payments.
  if (!ordered.length) return { qualifies: false, reason: 'no payments recorded' };
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
  for (const oldTotalC of candidates) {
    if (!Number.isSafeInteger(oldTotalC)) continue;
    tried.push(oldTotalC);
    if (oldTotalC - priorC !== lastC) continue;          // 2 instructed === captured
    if (paidC !== oldTotalC) continue;                   // 3 old UI reached R0.00
    if (payableC - oldTotalC !== residualC) continue;    // 4 residual IS the derivation gap
    const shape = chain.meaningfulCount === 1 ? 'the full payable total' : 'the remaining balance';
    return {
      qualifies: true, ...counts, oldTotalCents: oldTotalC, offeredCents: oldTotalC - priorC,
      priorPaidCents: priorC, finalPaymentCents: lastC,
      reason: `${chain.count} payment${chain.count === 1 ? '' : 's'}`
            + `${chain.zeroCount ? ` (${chain.meaningfulCount} monetary, ${chain.zeroCount} zero-value)` : ''}`
            + `; the old platform's own total was `
            + `${zar(oldTotalC)} and it instructed ${zar(oldTotalC - priorC)} as ${shape}`
            + `${priorC > 0 ? ` after ${zar(priorC)} already received` : ''}. Exactly ${zar(lastC)} was captured `
            + `and the old interface then showed Balance R0.00. The corrected canonical payable is `
            + `${zar(payableC)}, so the entire residual of ${zar(residualC)} is the difference between the two `
            + `derivations — no part of it is money the customer was asked for and did not pay.${zeroNote}`,
    };
  }
  return {
    qualifies: false, ...counts,
    reason: `the captured final MEANINGFUL payment of ${zar(lastC)} does not replay as a platform-generated `
          + `amount (old totals tried: ${tried.map(zar).join(', ') || 'none'}; prior payments ${zar(priorC)})`
          + zeroNote,
  };
}

/* ── the run ──────────────────────────────────────────────────────────────── */

/* APPLY ELIGIBILITY — --apply IS LEGACY-ROUNDING-ONLY.
   It writes exactly one kind of change: the audited, evidence-replayed
   historical rounding settlement (status + additive marker). Every other
   classification is REPORT ONLY and is never written by this utility —
   settlement drift in particular is a separate project, so no sent->pending,
   pending->paid or partial->paid repair happens here. The wording is identical
   to diagnose-canonical-total-drift.ts's APPLY_ELIGIBILITY so a category can
   never be labelled differently by the two tools, and the APPLY loop below
   enforces it structurally rather than by convention. */
const APPLY_ELIGIBILITY: Record<string, string> = {
  'legacy-rounding-settlement': 'YES — status + additive legacyRoundingSettlement marker',
  'settlement-drift':          'NO — REPORT ONLY (separate project; --apply never writes these)',
  'genuine-underpayment':      'NO — real money outstanding; must stay outstanding',
  'source-representation':     'NO — DOCUMENTATION ONLY; no debt and no status change',
  'already-marked':            'NO — NO NEW WRITE (an audited marker already applies)',
  'clean':                     'NO — nothing to do',
};
/** THE one predicate --apply obeys. Nothing else is writable, ever. */
function isApplyEligible(p: { classification: string; action: string }): boolean {
  return p.classification === 'legacy-rounding-settlement' && p.action === 'status-and-marker';
}

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const AS_CSV = argv.includes('--csv');

interface Proposal {
  invoiceId: number;
  invoiceNumber: string;
  jobId: number | null;
  jobNumber: string;
  payableSource: string;
  payableCents: number;
  paidCents: number;
  residualCents: number;
  storedInvoiceStatus: string;
  storedJobStatus: string | null;
  proposedStatus: string;
  action: 'status-only' | 'status-and-marker' | 'none';
  classification: string;
  reason: string;
  paymentSequence: string;
  marker: Record<string, unknown> | null;
}

async function main() {
  const client = await pool.connect();
  const proposals: Proposal[] = [];
  let scanned = 0;

  try {
    const invRes = await client.query(
      `SELECT i.id, i.invoice_number, i.company_code, i.status, i.issue_date,
              i.job_id, i.quote_id, i.legacy_data,
              j.value AS job_value, j.job_number, j.invoice_status AS job_status
         FROM rel_invoices i
         LEFT JOIN rel_jobs j ON j.id = i.job_id
        WHERE i.status IS DISTINCT FROM 'void'
        ORDER BY i.id`
    );

    for (const i of invRes.rows) {
      scanned++;
      const lineRes = await client.query(
        `SELECT qty, unit_amount, tax_type FROM rel_invoice_line_items
          WHERE invoice_id = $1 ORDER BY line_index`, [i.id]
      );
      const jobLinked = i.job_id !== null && i.job_id !== undefined;
      // THE AUTHORITY (Option D): the ISSUED INVOICE's own canonical cents,
      // through the shared document pipeline. SARS half-up VAT preserved.
      const payableC = invoiceCents(lineRes.rows as any[]);
      const payableSource = 'issued invoice lines (canonical cents)';

      const payRes = await client.query(
        `SELECT owner_type, amount, payment_date, line_index FROM rel_payments
          WHERE (owner_type = 'invoice' AND owner_id = $1)
             OR ($2::bigint IS NOT NULL AND owner_type = 'job'   AND owner_id = $2)
             OR ($3::bigint IS NOT NULL AND owner_type = 'quote' AND owner_id = $3)
          ORDER BY payment_date NULLS FIRST, line_index`,
        [i.id, i.job_id, i.quote_id]
      );
      const ordered = payRes.rows as Pay[];
      const paidC = ordered.reduce((s, p) => s + toCents(p.amount), 0);
      const residualC = payableC - paidC;

      const alreadyMarked = sgrLegacySettlementApplies(i.legacy_data, payableC, paidC);
      const plainStatus = statusWord(payableC, paidC);
      const correctStatus = alreadyMarked ? 'paid' : plainStatus;
      const stored = i.status || '(none)';

      let action: Proposal['action'] = 'none';
      let classification = 'clean';
      let reason = '';
      let marker: Record<string, unknown> | null = null;

      if (alreadyMarked) {
        classification = 'already-marked';
        reason = 'an audited legacy rounding settlement marker is present and still verifies'
               + (stored !== 'paid' ? `; stored status ${stored} disagrees — REPORTED ONLY, --apply writes nothing here` : '');
      } else if (residualC > 0 && paidC > 0) {
        const verdict = classifyLegacyRounding(ordered, payableC, paidC,
          [oldInvoiceTotalCents(lineRes.rows as any[]), jobLinked ? oldCents(i.job_value) : NaN]);
        reason = verdict.reason;
        if (verdict.qualifies) {
          classification = 'legacy-rounding-settlement';
          action = 'status-and-marker';
          marker = {
            settled: true,
            reason: 'system-generated-payment-amount',
            payableCentsAtVerification: payableC,
            paidCentsAtVerification: paidC,
            residualCents: residualC,
            legacyGeneratedAmountCents: verdict.offeredCents,
            oldTotalCents: verdict.oldTotalCents,
            priorPaidCents: verdict.priorPaidCents,
            finalPaymentCents: verdict.finalPaymentCents,
            paymentCount: ordered.length,
            meaningfulPaymentCount: verdict.meaningfulPaymentCount,
            zeroValuePaymentCount: verdict.zeroValuePaymentCount,
            verificationMode: 'legacy-balance-replay',
            verifiedAt: new Date().toISOString(),
            version: SGR_LEGACY_SETTLEMENT_VERSION,
            note: verdict.reason,
          };
        } else {
          classification = 'genuine-underpayment';
          // REPORT ONLY. Real money is short; --apply must never touch it.
        }
      } else if (stored !== correctStatus && stored !== '(none)') {
        classification = 'settlement-drift';
        // REPORT ONLY (separate project). Deliberately NOT 'status-only':
        // --apply is legacy-rounding-only and writes nothing for this category.
        reason = `stored status ${stored} disagrees with the corrected rule (${zar(payableC)} payable, ${zar(paidC)} paid)`;
      }

      if (classification === 'clean') continue;

      proposals.push({
        invoiceId: i.id, invoiceNumber: i.invoice_number || ('inv#' + i.id),
        jobId: i.job_id ?? null, jobNumber: i.job_number || '',
        payableSource, payableCents: payableC, paidCents: paidC, residualCents: residualC,
        storedInvoiceStatus: stored, storedJobStatus: i.job_status ?? null,
        proposedStatus: marker ? 'paid' : correctStatus,
        action, classification, reason,
        paymentSequence: ordered.map(p => `${String(p.payment_date ?? '').slice(0, 10)} ${zar(toCents(p.amount))} [${p.owner_type}]`).join('  ->  '),
        marker,
      });
    }

    /* ── APPLY ────────────────────────────────────────────────────────────
       Only reached with --apply. Two statements, both listed at the top of
       this file. No INSERT, no DELETE, no money column, no line item. */
    if (APPLY) {
      // LEGACY-ROUNDING-ONLY. isApplyEligible is the ONE gate, and it admits
      // exactly one classification. A settlement drift, a genuine underpayment,
      // a source-representation difference and an already-marked invoice all
      // fail it, so none of them can reach an UPDATE no matter what `action`
      // any future edit sets. Every one of them is reported and skipped aloud.
      const actionable = proposals.filter(isApplyEligible);
      const skipped = proposals.filter(p => !isApplyEligible(p));
      console.log(`\nAPPLYING ${actionable.length} legacy rounding settlement(s) — status fields and the additive audit marker only.`);
      console.log(`SKIPPING ${skipped.length} record(s) — --apply is legacy-rounding-only.\n`);
      for (const p of skipped) {
        console.log(`  skipped  ${p.invoiceNumber}  [${p.classification}]  ${APPLY_ELIGIBILITY[p.classification] || 'NO'}`);
      }
      if (skipped.length) console.log('');
      for (const p of actionable) {
        if (!p.marker) { console.log(`  skipped  ${p.invoiceNumber}  no verified marker — refusing to write a status without its evidence`); continue; }
        await client.query('BEGIN');
        try {
          if (p.marker) {
            // ADDITIVE merge — every existing legacy_data key is preserved.
            await client.query(
              `UPDATE rel_invoices
                  SET legacy_data = COALESCE(legacy_data, '{}'::jsonb) || $2::jsonb
                WHERE id = $1`,
              [p.invoiceId, JSON.stringify({ [SGR_LEGACY_SETTLEMENT_KEY]: p.marker })]
            );
          }
          await client.query(`UPDATE rel_invoices SET status = $1 WHERE id = $2`, [p.proposedStatus, p.invoiceId]);
          if (p.jobId !== null) {
            await client.query(`UPDATE rel_jobs SET invoice_status = $1 WHERE id = $2`, [p.proposedStatus, p.jobId]);
          }
          await client.query('COMMIT');
          console.log(`  applied  ${p.invoiceNumber}  ${p.storedInvoiceStatus} -> ${p.proposedStatus}` + (p.marker ? '  + marker' : ''));
        } catch (e) {
          await client.query('ROLLBACK').catch(() => undefined);
          console.error(`  FAILED   ${p.invoiceNumber}:`, e);
        }
      }
    }
  } finally {
    client.release();
  }

  /* ── report ───────────────────────────────────────────────────────────── */
  if (AS_CSV) {
    console.log('classification,action,apply_eligible,apply_eligibility,invoice,job,payable_source,payable,paid,residual,stored,proposed,payment_sequence,reason');
    for (const p of proposals) {
      console.log([p.classification, p.action, isApplyEligible(p) ? 'yes' : 'no',
        JSON.stringify(APPLY_ELIGIBILITY[p.classification] || 'NO'),
        p.invoiceNumber, p.jobNumber, JSON.stringify(p.payableSource),
        (p.payableCents / 100).toFixed(2), (p.paidCents / 100).toFixed(2), (p.residualCents / 100).toFixed(2),
        p.storedInvoiceStatus, p.proposedStatus, JSON.stringify(p.paymentSequence), JSON.stringify(p.reason)].join(','));
    }
    await pool.end();
    return;
  }

  console.log('');
  console.log(APPLY ? 'HISTORICAL SETTLEMENT RECONCILIATION — APPLIED' : 'HISTORICAL SETTLEMENT RECONCILIATION — DRY RUN (nothing was written)');
  console.log('='.repeat(112));
  console.log(`scanned ${scanned} invoices; ${proposals.length} need attention`);
  for (const group of ['legacy-rounding-settlement', 'settlement-drift', 'genuine-underpayment', 'already-marked']) {
    const list = proposals.filter(p => p.classification === group);
    console.log('');
    console.log(group.toUpperCase().replace(/-/g, ' ') + `   (${list.length})`);
    console.log('  APPLY ELIGIBILITY: ' + (APPLY_ELIGIBILITY[group] || 'NO'));
    console.log('-'.repeat(112));
    if (!list.length) { console.log('  none'); continue; }
    for (const p of list) {
      console.log(`  ${p.invoiceNumber}${p.jobNumber ? ' / ' + p.jobNumber : ''}`);
      console.log(`      payable  ${zar(p.payableCents)}   from ${p.payableSource}`);
      if (p.marker) console.log(`      legacy platform-generated amount  ${zar(Number(p.marker.legacyGeneratedAmountCents))}`);
      console.log(`      paid     ${zar(p.paidCents)}   residual ${zar(p.residualCents)}`);
      console.log(`      status   ${p.storedInvoiceStatus} -> ${p.proposedStatus}   (${p.action})`);
      console.log(`      apply    ${isApplyEligible(p) ? 'ELIGIBLE — --apply will write this' : 'NOT ELIGIBLE — ' + (APPLY_ELIGIBILITY[p.classification] || 'NO')}`);
      if (p.paymentSequence) console.log(`      payments ${p.paymentSequence}`);
      if (p.reason) console.log(`      why      ${p.reason}`);
      console.log('');
    }
  }
  console.log('-'.repeat(112));
  console.log('  APPLY ELIGIBILITY — --apply IS LEGACY-ROUNDING-ONLY');
  console.log('  ' + '-'.repeat(108));
  console.log('    LEGACY ROUNDING SETTLEMENT      : ' + APPLY_ELIGIBILITY['legacy-rounding-settlement']);
  console.log('    SETTLEMENT DRIFT                : ' + APPLY_ELIGIBILITY['settlement-drift']);
  console.log('    GENUINE UNDERPAYMENT            : ' + APPLY_ELIGIBILITY['genuine-underpayment']);
  console.log('    SOURCE REPRESENTATION DIFFERENCE: ' + APPLY_ELIGIBILITY['source-representation']);
  console.log('    ALREADY MARKED                  : ' + APPLY_ELIGIBILITY['already-marked']);
  console.log(`    eligible now                    : ${proposals.filter(isApplyEligible).length} of ${proposals.length} reported`);
  console.log('');
  if (!APPLY) {
    console.log('  DRY RUN. Nothing was written. Re-run with --apply to write the status fields and');
    console.log('  the additive audit marker FOR LEGACY ROUNDING SETTLEMENTS ONLY. No payment, no job');
    console.log('  value, no line item, no VAT, no discount, no setup fee and no document number is');
    console.log('  touched by --apply either, and no settlement drift is repaired by it.');
  } else {
    console.log('  Applied to LEGACY ROUNDING SETTLEMENTS ONLY. Only rel_invoices.status,');
    console.log('  rel_jobs.invoice_status and an ADDITIVE legacy_data key were written. No monetary');
    console.log('  record was changed, and no settlement drift was repaired.');
  }
  console.log('');
  await pool.end();
}

main().catch(err => { console.error('reconcile-historical-settlement failed:', err); pool.end(); process.exit(1); });
