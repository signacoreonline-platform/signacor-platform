/**
 * The money rules the dashboard uses, for the read API. Nothing here is new arithmetic: every function is either a
 * re-export of relational/services.ts's canonical cents helpers or a line-for-line port of the index.html function
 * named beside it (the dashboard computes these in the browser). test/integration-read.stress.ts extracts the
 * index.html originals and checks these against them on fixtures, so the two cannot drift silently.
 */
import {
  sgrToUnits4, sgrToCents, sgrToCents0, sgrRands, sgrMulDivRound, sgrDivRound, sgrExtCents, sgrLegacySettlementApplies,
} from '../relational/services';

export { sgrToCents0, sgrRands };

/** index.html sgrExtCentsU */
function extCentsU(q4: number, u4: number): number {
  if (!Number.isFinite(q4) || !Number.isFinite(u4)) return 0;
  const p = q4 * u4;
  if (Number.isSafeInteger(p)) return sgrDivRound(p, 1000000);
  return sgrToCents0((q4 / 10000) * (u4 / 10000));
}

/** index.html sgrDocLineCents — a quote/job line: pieces × qty × unit price; stored subtotal only as a fallback. */
export function docLineCents(l: any): number {
  if (!l) return 0;
  const pq = parseFloat(l.pQty);
  const pieces = Number.isFinite(pq) && pq > 0 ? pq : 1;
  const hasQty = !(l.qty === null || l.qty === undefined || l.qty === '');
  const hasRate = !(l.unitPrice === null || l.unitPrice === undefined || l.unitPrice === '');
  if (hasQty || hasRate) {
    const q = sgrToUnits4(hasQty ? l.qty : 1);
    const u = sgrToUnits4(hasRate ? l.unitPrice : 0);
    if (Number.isFinite(q) && Number.isFinite(u)) return extCentsU(q * pieces, u);
  }
  const stored = sgrToCents(l.subtotal);
  return Number.isFinite(stored) ? stored : 0;
}

/** index.html sgrDocumentCents — quote/job totals: lines − discount % + setup fee, VAT 15% once. */
export function documentCents(lines: any[], discountPct: unknown, setupFee: unknown) {
  const ls = Array.isArray(lines) ? lines.filter(Boolean) : [];
  const subC = ls.map(docLineCents).reduce((s, c) => s + c, 0);
  const pctU = sgrToUnits4(discountPct === null || discountPct === undefined || discountPct === '' ? 0 : discountPct);
  const discC = Number.isFinite(pctU) ? sgrMulDivRound(subC, pctU, 1000000) || 0 : 0;
  const setupC = sgrToCents0(setupFee);
  const taxableC = subC - discC + setupC;
  const vatC = sgrMulDivRound(taxableC, 15, 100) || 0;
  return { subC, discC, setupC, taxableC, vatC, totalC: taxableC + vatC };
}

/** index.html sgrInvoiceCents — invoice/bill lines: each line to cents, VAT once over the 15% lines. */
export function invoiceCents(lineItems: any[]) {
  const ls = Array.isArray(lineItems) ? lineItems.filter(Boolean) : [];
  let subC = 0;
  let taxBaseC = 0;
  for (const l of ls) {
    const c = sgrExtCents(l.qty, l.unitAmount);
    subC += c;
    if (l.taxType === '15%') taxBaseC += c;
  }
  const vatC = sgrMulDivRound(taxBaseC, 15, 100) || 0;
  return { subC, taxBaseC, vatC, totalC: subC + vatC };
}

/** index.html sgrPaidCents */
export function paidCents(payments: any[]): number {
  return (Array.isArray(payments) ? payments : []).reduce((s, p) => s + (p ? sgrToCents0(p.amount) : 0), 0);
}

/** index.html isGenuineZeroAmount */
function isGenuineZero(v: unknown): boolean {
  const n = v === null || v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) && n <= 0;
}

/** index.html sgrSettlementStatusCents — 'paid' | 'partial' | 'pending'. */
export function settlementStatus(totalC: number, paidC: number): 'paid' | 'partial' | 'pending' {
  const t = Number.isFinite(totalC) ? totalC : 0;
  const p = Number.isFinite(paidC) ? paidC : 0;
  if (t <= 0) return isGenuineZero(t / 100) ? 'paid' : p > 0 ? 'partial' : 'pending';
  if (p >= t) return 'paid';
  if (p > 0) return 'partial';
  return 'pending';
}

/** index.html sgrOutstandingForRecordCents — an audited historical rounding settlement owes R0.00; nothing else is forgiven. */
export function outstandingCents(rec: any, payableC: number, paidC: number): number {
  if (sgrLegacySettlementApplies(rec, payableC, paidC)) return 0;
  return Math.max(0, (Number.isFinite(payableC) ? payableC : 0) - (Number.isFinite(paidC) ? paidC : 0));
}

export function legacySettled(rec: any, payableC: number, paidC: number): boolean {
  return sgrLegacySettlementApplies(rec, payableC, paidC);
}

export const QUOTE_DEFAULT_DEPOSIT_PCT = 80;

/** index.html normalizeQuoteDepositPct (custom deposit %, else null). */
function normalizeDepositPct(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  const n = typeof v === 'number' ? v : parseFloat(v.trim());
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 100) / 100;
}

/** index.html quoteDepositInfo — the deposit term: custom %, else 100% up to R5,000 (in cents), else 80%. */
export function depositInfo(doc: any, totalRands: unknown) {
  const totalCents = sgrToCents0(totalRands);
  const custom = normalizeDepositPct(doc && doc.depositPct);
  const autoFull = custom === null && totalCents <= 500000;
  const pct = custom !== null ? custom : autoFull ? 100 : QUOTE_DEFAULT_DEPOSIT_PCT;
  const depositCents = sgrMulDivRound(totalCents, sgrToUnits4(pct), 1000000) || 0;
  return { pct, isCustom: custom !== null, depositCents, balanceCents: totalCents - depositCents };
}

export const rands = (c: number) => Math.round(sgrRands(c) * 100) / 100;
