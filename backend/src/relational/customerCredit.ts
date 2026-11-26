/**
 * CUSTOMER CREDIT — payment credit, credit-note allocations and recorded refunds
 * (2026-11-26, migration 022).
 *
 * WHAT THIS MODULE OWNS
 *   Every rule that decides whether money a customer already gave us (an
 *   overpaid receipt, or a credit note) may be used again, and every write that
 *   uses, reverses or refunds it. services.ts's payment paths call in here; the
 *   REST routes in api.ts are thin adapters over the exported functions.
 *
 * ONE RECEIPT, COUNTED ONCE
 *   A receipt is one rel_payments row and is never copied or edited. Applying
 *   its excess to another document writes a balancing PAIR of ledger rows:
 *     +x  'Payment credit'          (entry_kind payment_credit_in)  on the target
 *     -x  'Payment credit applied'  (entry_kind payment_credit_out) on the receipt's document
 *   so every existing chain total (rel_payments summed per Quote -> Job ->
 *   Invoice chain) moves exactly as the money did, and the customer's total
 *   received is unchanged. A recorded refund is one -x 'Refund' row on the
 *   receipt's document. The allocation / refund itself is a separate record
 *   (rel_credit_allocations / rel_credit_refunds) with its own audit fields.
 *
 * THE TRANSITION RULE (no historical excess becomes spendable)
 *   Spendable payment credit on a transaction chain =
 *     min( chain excess = max(0, chain paid - chain payable),
 *          what remains of the chain's ELIGIBLE receipts )
 *   A receipt is eligible only when rel_payments.credit_eligible is true, which
 *   only receipts recorded after migration 022 are. Historical rows default to
 *   false, so apparent historical excess (including suspected duplicates) stays
 *   outside the pool. An older invoice that receives a NEW payment contributes
 *   only the part of that new money above what is still owed. The pool is
 *   attributed to the chain's eligible receipts newest-first.
 *
 * IDENTITY AND COMPANY
 *   Credit belongs to one company (company_code) and one customer (the
 *   platform_state customer id, customer_ref). A document chain's customer is
 *   its customer_ref; an unlinked chain or credit note resolves only by an
 *   exact, unique customer name (or a recorded former name). Anything else is
 *   UNRESOLVED and can never fund or receive credit until a customer is chosen.
 *
 * CONCURRENCY
 *   Every operation that spends or returns credit takes a transaction-scoped
 *   advisory lock on (company, customer) FIRST, then row locks — so two
 *   allocations can never both see the same available balance. Each spend also
 *   carries an optional idempotency key (unique index), so a retried request
 *   resolves to the allocation the first attempt made.
 */
import { PoolClient } from 'pg';
import pool from '../db/pool';
import { isSectionCutOver } from './cutover';
import {
  BusinessRuleError, ConcurrencyConflictError, TransactionChain,
  resolveTransactionChainTx, sumChainPaymentsTx, chainPayableCentsTx, recomputeOwnerPaymentStatus,
  sgrToCents0, sgrRands, sgrLegacySettlementApplies, normalizeCustomerRef, normalizeClientRequestId,
} from './services';

export type OwnerType = 'quote' | 'job' | 'invoice';
export type EntryKind = 'receipt' | 'credit_note' | 'payment_credit_in' | 'payment_credit_out' | 'refund';
export interface Actor { id?: string | number | null; email?: string | null; role?: string | null; co?: number | null }

const norm = (v: unknown): string => String(v == null ? '' : v).trim().toLowerCase();
const actorLabel = (a?: Actor | null): string | null => (a ? String(a.email || a.id || '') || null : null);
const fmt = (c: number): string => 'R' + sgrRands(c).toFixed(2);

// ── MONEY ────────────────────────────────────────────────────────────────────
/** Integer cents for a money amount the caller typed, or a precise refusal.
 *  Zero, negative, non-numeric, more than 2 decimals or absurdly large: refused. */
export function parseMoneyCents(raw: unknown, label = 'Amount'): number {
  let v: unknown = raw;
  if (typeof v === 'string') v = v.trim();
  if (v === null || v === undefined || v === '' || typeof v === 'boolean' || (typeof v !== 'number' && typeof v !== 'string')) {
    throw new BusinessRuleError(`${label} is required and must be a number.`);
  }
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new BusinessRuleError(`${label} must be a number.`);
  if (n <= 0) throw new BusinessRuleError(`${label} must be greater than R0.00.`);
  const cents = Math.round(n * 100);
  if (Math.abs(n * 100 - cents) > 1e-6) throw new BusinessRuleError(`${label} can have at most 2 decimal places (whole cents).`);
  if (cents > 10_000_000_000) throw new BusinessRuleError(`${label} is too large.`);
  return cents;
}

/** What a rel_payments row is. Historical rows (entry_kind NULL) keep today's
 *  rule: a method starting "credit" is a credit-note payment, anything else a receipt. */
export function entryKindOf(row: { entry_kind?: string | null; method?: string | null }): EntryKind {
  const k = row.entry_kind;
  if (k === 'receipt' || k === 'credit_note' || k === 'payment_credit_in' || k === 'payment_credit_out' || k === 'refund') return k;
  return norm(row.method).startsWith('credit') ? 'credit_note' : 'receipt';
}

// ── IDENTITY ─────────────────────────────────────────────────────────────────
export interface CustomerIndex {
  byRef: Map<string, Array<{ ref: string; name: string }>>;
  byName: Map<string, string[]>;
  byFormer: Map<string, string[]>;
  nameOf: (ref: string) => string | null;
}
export async function loadCustomerIndex(client: PoolClient | typeof pool): Promise<CustomerIndex> {
  let list: Array<{ ref: string; name: string; former: string[] }> = [];
  if (await isSectionCutOver('customers')) {
    const r = await client.query('SELECT source_id, company_name FROM rel_customers');
    list = r.rows.map((c: any) => ({ ref: String(c.source_id), name: String(c.company_name || ''), former: [] }));
  } else {
    const r = await client.query(`SELECT data -> 'customers' AS c FROM platform_state WHERE id = 1`);
    const arr = Array.isArray(r.rows[0]?.c) ? r.rows[0].c : [];
    list = arr.filter((c: any) => c && c.id !== undefined && c.id !== null).map((c: any) => ({
      ref: String(c.id), name: String(c.companyName || ''), former: Array.isArray(c.formerNames) ? c.formerNames.map(String) : [],
    }));
  }
  const byRef = new Map<string, Array<{ ref: string; name: string }>>();
  const byName = new Map<string, string[]>();
  const byFormer = new Map<string, string[]>();
  for (const c of list) {
    (byRef.get(c.ref) || byRef.set(c.ref, []).get(c.ref)!).push({ ref: c.ref, name: c.name });
    const n = norm(c.name);
    if (n) (byName.get(n) || byName.set(n, []).get(n)!).push(c.ref);
    for (const f of c.former) { const fn = norm(f); if (fn) (byFormer.get(fn) || byFormer.set(fn, []).get(fn)!).push(c.ref); }
  }
  return { byRef, byName, byFormer, nameOf: (ref) => { const h = byRef.get(ref); return h && h.length === 1 ? h[0].name : null; } };
}

export type Identity =
  | { state: 'matched'; ref: string; name: string; via: 'link' | 'name' | 'former-name' }
  | { state: 'unresolved'; reason: 'no-customer' | 'ambiguous-name' | 'unknown-link' | 'duplicate-link' | 'conflicting-links'; detail: string; name: string | null };

export function resolveIdentity(idx: CustomerIndex, rawRef: unknown, name: unknown, opts: { strict?: boolean } = {}): Identity {
  const ref = normalizeCustomerRef(rawRef);
  const nm = name == null ? null : String(name).trim() || null;
  if (ref !== null) {
    const hits = idx.byRef.get(ref) || [];
    if (hits.length === 1) return { state: 'matched', ref, name: hits[0].name, via: 'link' };
    if (hits.length > 1) return { state: 'unresolved', reason: 'duplicate-link', detail: `Customer id ${ref} is shared by ${hits.length} customer records.`, name: nm };
    return { state: 'unresolved', reason: 'unknown-link', detail: `Linked customer id ${ref} no longer exists.`, name: nm };
  }
  const n = norm(nm);
  if (!n) return { state: 'unresolved', reason: 'no-customer', detail: 'No customer name.', name: nm };
  const exact = Array.from(new Set(idx.byName.get(n) || []));
  if (exact.length === 1) {
    // Strict (credit notes): a name that is one customer's current name but
    // ANOTHER customer's former name is not unambiguous evidence — the note may
    // pre-date that rename. Unresolved; a person chooses.
    if (opts.strict) {
      const others = Array.from(new Set(idx.byFormer.get(n) || [])).filter((r) => r !== exact[0]);
      if (others.length) return { state: 'unresolved', reason: 'ambiguous-name', detail: `"${nm}" is the current name of one customer and a former name of another.`, name: nm };
    }
    return { state: 'matched', ref: exact[0], name: idx.nameOf(exact[0]) || nm || '', via: 'name' };
  }
  if (exact.length > 1) return { state: 'unresolved', reason: 'ambiguous-name', detail: `${exact.length} customer records are named "${nm}".`, name: nm };
  const former = Array.from(new Set(idx.byFormer.get(n) || []));
  if (former.length === 1) return { state: 'matched', ref: former[0], name: idx.nameOf(former[0]) || nm || '', via: 'former-name' };
  if (former.length > 1) return { state: 'unresolved', reason: 'ambiguous-name', detail: `${former.length} customer records were previously named "${nm}".`, name: nm };
  return { state: 'unresolved', reason: 'no-customer', detail: `No customer record is named "${nm}".`, name: nm };
}

/** The customer a transaction chain belongs to: its members' links (which must
 *  agree), else the exact unique name of its documents. */
export async function chainIdentityTx(client: PoolClient | typeof pool, chain: TransactionChain, idx: CustomerIndex): Promise<Identity> {
  const refs: string[] = []; const names: string[] = [];
  if (chain.quoteId !== null) {
    const r = await client.query(`SELECT COALESCE(customer_ref, legacy_data->>'customerId') AS customer_ref, customer_name_raw FROM rel_quotes WHERE id = $1`, [chain.quoteId]);
    if (r.rowCount) { if (r.rows[0].customer_ref) refs.push(String(r.rows[0].customer_ref)); if (r.rows[0].customer_name_raw) names.push(String(r.rows[0].customer_name_raw)); }
  }
  if (chain.jobId !== null) {
    const r = await client.query(`SELECT COALESCE(customer_ref, legacy_data->>'customerId') AS customer_ref, customer_name_raw FROM rel_jobs WHERE id = $1`, [chain.jobId]);
    if (r.rowCount) { if (r.rows[0].customer_ref) refs.push(String(r.rows[0].customer_ref)); if (r.rows[0].customer_name_raw) names.unshift(String(r.rows[0].customer_name_raw)); }
  }
  if (chain.invoiceIds.length) {
    const r = await client.query(`SELECT COALESCE(customer_ref, legacy_data->>'customerId') AS customer_ref, contact_name FROM rel_invoices WHERE id = ANY($1::bigint[]) ORDER BY id`, [chain.invoiceIds]);
    for (const row of r.rows) { if (row.customer_ref) refs.push(String(row.customer_ref)); if (row.contact_name) names.unshift(String(row.contact_name)); }
  }
  const distinct = Array.from(new Set(refs.map((x) => x.trim()).filter(Boolean)));
  if (distinct.length > 1) return { state: 'unresolved', reason: 'conflicting-links', detail: `The documents of this transaction are linked to different customers (${distinct.join(', ')}).`, name: names[0] || null };
  if (distinct.length === 1) return resolveIdentity(idx, distinct[0], names[0] || null);
  const nameKeys = Array.from(new Set(names.map(norm).filter(Boolean)));
  if (nameKeys.length > 1) {
    const resolved = Array.from(new Set(names.map((n) => resolveIdentity(idx, null, n)).map((i) => (i.state === 'matched' ? i.ref : '?'))));
    if (resolved.length !== 1 || resolved[0] === '?') return { state: 'unresolved', reason: 'ambiguous-name', detail: 'The documents of this transaction carry different customer names and no customer link.', name: names[0] || null };
  }
  return resolveIdentity(idx, null, names[0] || null);
}

/** A credit note's own link (customer_ref; for a row backfilled before 021 the
 *  customerId its original record carried — the same fallback read.ts serves),
 *  else its exact unique name. A credit note is never inherited from a chain. */
export function creditNoteRef(note: any): string | null {
  return normalizeCustomerRef(note?.customer_ref) ?? normalizeCustomerRef(note?.legacy_data?.customerId);
}
export async function creditNoteIdentity(note: any, idx: CustomerIndex): Promise<Identity> {
  return resolveIdentity(idx, creditNoteRef(note), note.contact_name_raw, { strict: true });
}

// ── CREDIT-NOTE OWNERSHIP (locked on first use) ──────────────────────────────
// A credit note created before customer links existed may carry only a name
// (or only the customerId its original JSON record had). The first time such a
// note provides credit — a manual allocation, a "Credit" payment (manual or the
// dashboard's automatic credit-note usage) or a recorded refund — the customer
// it resolved to is written to customer_ref IN THE SAME TRANSACTION, with a
// customer_link_audit row. From then on the link, not the name, decides who
// owns the note: renaming customers cannot move it, reversing its uses does not
// unlink it, and updateCreditNote refuses to re-point it.
//
// The UPDATE is conditional (customer_ref IS NULL) and the caller holds the
// note row FOR UPDATE, so two simultaneous first uses can never assign two
// different owners: the second sees the first's link and is refused unless it
// is the same customer. If the allocation fails, the transaction rolls back and
// the note stays exactly as it was (unlinked, no audit row).
export async function pinCreditNoteOwnerTx(
  client: PoolClient, note: any, ident: Identity,
  ctx: { reason: 'allocation' | 'credit-payment' | 'refund'; actor: Actor | null; target?: string | null }
): Promise<boolean> {
  if (ident.state !== 'matched') throw new BusinessRuleError(`Credit note ${note.credit_number} is not linked to a customer (${ident.detail}) Choose its customer under Accounting → Customer Credits first.`);
  const linked = normalizeCustomerRef(note.customer_ref);
  if (linked === ident.ref) return false;
  if (linked !== null) throw new BusinessRuleError(`Credit note ${note.credit_number} belongs to another customer, so it cannot provide credit here.`);
  const u = await client.query(
    `UPDATE rel_credit_notes SET customer_ref = $1, row_version = row_version + 1, updated_at = NOW() WHERE id = $2 AND customer_ref IS NULL RETURNING id`,
    [ident.ref, note.id]);
  if (!u.rowCount) {
    const now = (await client.query('SELECT customer_ref FROM rel_credit_notes WHERE id = $1', [note.id])).rows[0];
    if (normalizeCustomerRef(now?.customer_ref) === ident.ref) return false;
    throw new BusinessRuleError(`Credit note ${note.credit_number} was just linked to another customer, so it cannot provide credit here. Nothing was recorded.`);
  }
  note.customer_ref = ident.ref;
  await client.query(
    `INSERT INTO customer_link_audit (actor, action, company_code, from_refs, to_ref, members, detail) VALUES ($1, 'credit-note-owner', $2, $3::jsonb, $4, $5::jsonb, $6::jsonb)`,
    [actorLabel(ctx.actor), note.company_code ?? null, JSON.stringify([null]), ident.ref,
     JSON.stringify([{ type: 'credit_note', id: Number(note.id), number: note.credit_number }]),
     JSON.stringify({ reason: ctx.reason, via: ident.via, contactName: note.contact_name_raw ?? null,
       legacyCustomerId: normalizeCustomerRef(note.legacy_data?.customerId), target: ctx.target ?? null })]);
  return true;
}

// ── CHAIN STATE ──────────────────────────────────────────────────────────────
export interface ChainState {
  chain: TransactionChain;
  companyCode: string | null;
  paidC: number;
  payableC: number | null;
  payableSource: 'invoice' | 'job' | 'quote' | null;
  outstandingC: number | null;
  excessC: number;
}
export async function chainStateTx(client: PoolClient | typeof pool, ownerType: OwnerType, ownerId: number): Promise<ChainState> {
  const c = client as PoolClient;
  const chain = await resolveTransactionChainTx(c, ownerType, ownerId);
  const paidC = sgrToCents0(await sumChainPaymentsTx(c, chain));
  const p = await chainPayableCentsTx(c, chain);
  let payableC: number | null = p.chainPayableC;
  let payableSource: ChainState['payableSource'] = p.source;
  if (payableC === null && chain.quoteId !== null) {
    const q = await client.query('SELECT total FROM rel_quotes WHERE id = $1', [chain.quoteId]);
    if (q.rowCount) { payableC = sgrToCents0(q.rows[0].total); payableSource = 'quote'; }
  }
  let outstandingC: number | null = payableC === null ? null : Math.max(0, payableC - paidC);
  if (outstandingC !== null && p.markerInvoiceId !== null && payableC !== null) {
    const m = await client.query('SELECT legacy_data FROM rel_invoices WHERE id = $1', [p.markerInvoiceId]);
    if (m.rowCount && sgrLegacySettlementApplies(m.rows[0].legacy_data, payableC, paidC)) outstandingC = 0;
  }
  const excessC = payableC === null ? 0 : Math.max(0, paidC - payableC);
  return { chain, companyCode: chain.companyCode, paidC, payableC, payableSource, outstandingC, excessC };
}

export interface ReceiptCredit {
  paymentId: number; ownerType: OwnerType; ownerId: number; ownerNumber: string | null;
  date: string | null; method: string | null; reference: string | null;
  amountC: number; allocatedC: number; refundedC: number; remainingC: number; availableC: number;
}
async function ownerNumberTx(client: PoolClient | typeof pool, t: OwnerType, id: number): Promise<string | null> {
  const sql = t === 'invoice' ? 'SELECT invoice_number AS n FROM rel_invoices WHERE id = $1' : t === 'job' ? 'SELECT job_number AS n FROM rel_jobs WHERE id = $1' : 'SELECT quote_number AS n FROM rel_quotes WHERE id = $1';
  const r = await client.query(sql, [id]);
  return r.rowCount ? r.rows[0].n : null;
}

/** The spendable payment credit of one chain, attributed to its eligible receipts newest-first. */
export async function chainPaymentCreditTx(client: PoolClient | typeof pool, state: ChainState): Promise<{ poolC: number; receipts: ReceiptCredit[] }> {
  const types = state.chain.owners.map((o) => o.type);
  const ids = state.chain.owners.map((o) => o.id);
  if (!types.length) return { poolC: 0, receipts: [] };
  const r = await client.query(
    `SELECT p.id, p.owner_type, p.owner_id, p.amount, p.payment_date::text AS payment_date, p.method, p.reference,
            COALESCE((SELECT SUM(a.amount) FROM rel_credit_allocations a WHERE a.source_type = 'payment' AND a.source_payment_id = p.id AND a.status = 'active'), 0) AS allocated,
            COALESCE((SELECT SUM(f.amount) FROM rel_credit_refunds f WHERE f.source_type = 'payment' AND f.source_payment_id = p.id AND f.status = 'active'), 0) AS refunded
       FROM rel_payments p
       JOIN UNNEST($1::text[], $2::bigint[]) AS c(owner_type, owner_id) ON p.owner_type = c.owner_type AND p.owner_id = c.owner_id
      WHERE p.credit_eligible AND p.entry_kind = 'receipt'
      ORDER BY p.payment_date NULLS FIRST, p.id`,
    [types, ids]
  );
  const receipts: ReceiptCredit[] = [];
  for (const row of r.rows) {
    const amountC = sgrToCents0(row.amount);
    const allocatedC = sgrToCents0(row.allocated);
    const refundedC = sgrToCents0(row.refunded);
    receipts.push({
      paymentId: Number(row.id), ownerType: row.owner_type, ownerId: Number(row.owner_id), ownerNumber: await ownerNumberTx(client, row.owner_type, Number(row.owner_id)),
      date: row.payment_date, method: row.method, reference: row.reference,
      amountC, allocatedC, refundedC, remainingC: Math.max(0, amountC - allocatedC - refundedC), availableC: 0,
    });
  }
  const eligibleC = receipts.reduce((s, x) => s + x.remainingC, 0);
  const poolC = state.payableC === null ? 0 : Math.max(0, Math.min(state.excessC, eligibleC));
  let left = poolC;
  for (let i = receipts.length - 1; i >= 0 && left > 0; i--) {
    const take = Math.min(left, receipts[i].remainingC);
    receipts[i].availableC = take;
    left -= take;
  }
  return { poolC, receipts };
}

export function creditNoteAvailableC(n: { amount: any; used_amount: any; refunded_amount?: any }): number {
  return Math.max(0, sgrToCents0(n.amount) - sgrToCents0(n.used_amount) - sgrToCents0(n.refunded_amount || 0));
}

// ── LOCKING ──────────────────────────────────────────────────────────────────
export async function lockCustomerCreditTx(client: PoolClient, companyCode: string | null, customerRef: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`customer-credit:${companyCode ?? ''}:${customerRef}`]);
}
async function lockOwnerRowTx(client: PoolClient, t: OwnerType, id: number): Promise<any> {
  const table = t === 'invoice' ? 'rel_invoices' : t === 'job' ? 'rel_jobs' : 'rel_quotes';
  const r = await client.query(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
  if (!r.rowCount) throw new BusinessRuleError(`That ${t} no longer exists.`);
  return r.rows[0];
}
async function nextLineIndexTx(client: PoolClient, t: OwnerType, id: number): Promise<number> {
  const r = await client.query(`SELECT COALESCE(MAX(line_index), -1) + 1 AS idx FROM rel_payments WHERE owner_type = $1 AND owner_id = $2`, [t, id]);
  return Number(r.rows[0].idx);
}
async function insertLedgerRowTx(client: PoolClient, o: { ownerType: OwnerType; ownerId: number; amountC: number; date: string | null; method: string; reference?: string | null; notes?: string | null; kind: EntryKind; linkId?: number | null }): Promise<{ id: string; rowVersion: number }> {
  const idx = await nextLineIndexTx(client, o.ownerType, o.ownerId);
  const r = await client.query(
    `WITH new_id AS (SELECT nextval('rel_payments_id_seq') AS id)
     INSERT INTO rel_payments (id, source_id, owner_type, owner_id, line_index, amount, payment_date, method, reference, notes, entry_kind, credit_eligible, credit_link_id, legacy_data)
     SELECT new_id.id, new_id.id::text, $1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE), $6, $7, $8, $9, false, $10, '{}'::jsonb FROM new_id
     RETURNING id, row_version`,
    [o.ownerType, o.ownerId, idx, sgrRands(o.amountC), o.date, o.method, o.reference ?? null, o.notes ?? null, o.kind, o.linkId ?? null]
  );
  return { id: r.rows[0].id, rowVersion: Number(r.rows[0].row_version) };
}
const today = (): string => new Date().toISOString().slice(0, 10);
function isoDateOrNull(v: unknown, label: string): string | null {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(new Date(s + 'T00:00:00Z').getTime())) throw new BusinessRuleError(`${label} must be a date (YYYY-MM-DD).`);
  return s;
}

// ── TARGET (a document that receives credit) ─────────────────────────────────
async function targetContextTx(client: PoolClient, idx: CustomerIndex, t: OwnerType, id: number) {
  const row = await lockOwnerRowTx(client, t, id);
  if (t === 'invoice' && String(row.status ?? '') === 'void') throw new BusinessRuleError(`Invoice ${row.invoice_number} is cancelled — credit cannot be applied to a cancelled invoice.`);
  const state = await chainStateTx(client, t, id);
  if (state.payableC === null || state.outstandingC === null) throw new BusinessRuleError('This document has no amount due yet, so credit cannot be applied to it.');
  const ident = await chainIdentityTx(client, state.chain, idx);
  const number = t === 'invoice' ? row.invoice_number : t === 'job' ? row.job_number : row.quote_number;
  return { row, state, ident, number: number as string | null };
}

// ── CREDIT NOTES: candidates, consumption (used by "Credit" payments) ─────────
export async function eligibleCreditNotesTx(client: PoolClient | typeof pool, idx: CustomerIndex, companyCode: string | null, customerRef: string, lock: boolean, onlyId?: number | null): Promise<any[]> {
  const r = await client.query(
    `SELECT *, note_date::text AS note_date_text FROM rel_credit_notes
      WHERE note_type = 'customer' AND company_code IS NOT DISTINCT FROM $1
        AND (COALESCE(customer_ref, legacy_data->>'customerId') = $2 OR COALESCE(customer_ref, legacy_data->>'customerId') IS NULL)
        AND ($3::bigint IS NULL OR id = $3::bigint)
      ORDER BY note_date ASC NULLS LAST, id ASC${lock ? ' FOR UPDATE' : ''}`,
    [companyCode, customerRef, onlyId ?? null]
  );
  const out: any[] = [];
  for (const n of r.rows) {
    const id = await creditNoteIdentity(n, idx);
    if (id.state === 'matched' && id.ref === customerRef) { n._ident = id; out.push(n); }
  }
  return out;
}

/**
 * Funds a "Credit" payment of `amountC` on (ownerType, ownerId) from the owner
 * customer's credit notes in the owner's company, oldest first (or one chosen
 * note). Called by recordPayment INSIDE its transaction, BEFORE it inserts the
 * payment row; returns what to record once the row exists.
 */
export async function planCreditNoteFundingTx(
  client: PoolClient, ownerType: OwnerType, ownerId: number, amountC: number, creditNoteId?: number | null
): Promise<{ companyCode: string | null; customerRef: string; parts: Array<{ noteId: number; number: string; amountC: number; note?: any }> }> {
  const idx = await loadCustomerIndex(client);
  const pre = await chainStateTx(client, ownerType, ownerId);
  const ident = await chainIdentityTx(client, pre.chain, idx);
  if (ident.state !== 'matched') throw new BusinessRuleError(`Customer credit cannot be applied: this document's customer is not resolved (${ident.detail}) Link the document to its customer first.`);
  await lockCustomerCreditTx(client, pre.companyCode, ident.ref);
  if (ownerType === 'invoice') {
    const inv = await client.query('SELECT status, invoice_number FROM rel_invoices WHERE id = $1', [ownerId]);
    if (inv.rowCount && String(inv.rows[0].status ?? '') === 'void') throw new BusinessRuleError(`Invoice ${inv.rows[0].invoice_number} is cancelled — credit cannot be applied to it.`);
  }
  const state = await chainStateTx(client, ownerType, ownerId);
  if (state.outstandingC === null) throw new BusinessRuleError('This document has no amount due yet, so credit cannot be applied to it.');
  if (amountC > state.outstandingC) throw new BusinessRuleError(`Credit of ${fmt(amountC)} is more than the ${fmt(state.outstandingC)} still due. Apply at most ${fmt(state.outstandingC)}.`);
  const notes = await eligibleCreditNotesTx(client, idx, state.companyCode, ident.ref, true, creditNoteId ?? null);
  if (creditNoteId && !notes.length) {
    const chosen = (await client.query('SELECT * FROM rel_credit_notes WHERE id = $1', [creditNoteId])).rows[0];
    if (chosen && chosen.note_type === 'customer' && String(chosen.company_code ?? '') === String(state.companyCode ?? '') && creditNoteRef(chosen) === null) {
      const ci = await creditNoteIdentity(chosen, idx);
      if (ci.state !== 'matched') throw new BusinessRuleError(`Credit note ${chosen.credit_number} is not linked to a customer (${ci.detail}) Choose its customer under Accounting → Customer Credits first.`);
    }
    throw new BusinessRuleError('That credit note does not belong to this customer in this company, so it cannot fund this payment.');
  }
  let left = amountC; const parts: Array<{ noteId: number; number: string; amountC: number; note?: any }> = [];
  for (const n of notes) {
    if (left <= 0) break;
    const avail = creditNoteAvailableC(n);
    if (avail <= 0) continue;
    const take = Math.min(avail, left);
    parts.push({ noteId: Number(n.id), number: n.credit_number, amountC: take, note: n });
    left -= take;
  }
  if (left > 0) {
    const have = amountC - left;
    throw new BusinessRuleError(`${ident.name} only has ${fmt(have)} of unused credit-note credit in this company — ${fmt(amountC)} was requested. Nothing was recorded.`);
  }
  return { companyCode: state.companyCode, customerRef: ident.ref, parts };
}

export async function recordCreditNoteFundingTx(
  client: PoolClient, plan: { companyCode: string | null; customerRef: string; parts: Array<{ noteId: number; number: string; amountC: number; note?: any }> },
  target: { ownerType: OwnerType; ownerId: number; paymentId: string | number; number: string | null }, actor: Actor | null, requestKey: string | null
): Promise<void> {
  let i = 0;
  for (const part of plan.parts) {
    // First use of a note that carried only a name / legacy customerId: lock
    // its owner now, in this same transaction (row already held FOR UPDATE).
    if (part.note && part.note._ident) await pinCreditNoteOwnerTx(client, part.note, part.note._ident, { reason: 'credit-payment', actor, target: target.number });
    await client.query(`UPDATE rel_credit_notes SET used_amount = used_amount + $1, row_version = row_version + 1, updated_at = NOW() WHERE id = $2`, [sgrRands(part.amountC), part.noteId]);
    await client.query(
      `INSERT INTO rel_credit_allocations (company_code, customer_ref, source_type, source_credit_note_id, target_owner_type, target_owner_id, target_number, amount, target_payment_id, client_request_id, created_by)
       VALUES ($1, $2, 'credit_note', $3, $4, $5, $6, $7, $8, $9, $10)`,
      [plan.companyCode ?? '', plan.customerRef, part.noteId, target.ownerType, target.ownerId, target.number, sgrRands(part.amountC), target.paymentId,
       requestKey ? (i === 0 ? requestKey : `${requestKey}#${i}`) : null, actorLabel(actor)]
    );
    i++;
  }
}

// ── REVERSING A CREDIT-FUNDED PAYMENT ROW (delete path) ──────────────────────
/**
 * Gives back what a credit-note payment row consumed, to EXACTLY the note(s)
 * that funded it. New rows carry allocation records. A historical row (no
 * allocation record, including the old "Credit (R … available)" method text)
 * is returned only when its funding note can be established reliably: the
 * caller named one (releaseToCreditNoteId), or exactly one credit note of the
 * same customer in the same company has at least that much recorded as used.
 * Otherwise an actionable error lists the candidates.
 */
export async function releaseCreditNotePaymentTx(
  client: PoolClient, payment: any, opts: { releaseToCreditNoteId?: number | null; actor?: Actor | null; reason?: string | null } = {}
): Promise<number> {
  const allocs = await client.query(
    `SELECT * FROM rel_credit_allocations WHERE target_payment_id = $1 AND source_type = 'credit_note' AND status = 'active' ORDER BY id FOR UPDATE`, [payment.id]);
  const amountC = sgrToCents0(payment.amount);
  if (allocs.rowCount) {
    let released = 0;
    for (const a of allocs.rows) {
      await client.query(`UPDATE rel_credit_notes SET used_amount = GREATEST(0, used_amount - $1), row_version = row_version + 1, updated_at = NOW() WHERE id = $2`, [a.amount, a.source_credit_note_id]);
      await client.query(`UPDATE rel_credit_allocations SET status = 'reversed', reversed_at = NOW(), reversed_by = $2, reversal_reason = $3, row_version = row_version + 1 WHERE id = $1`,
        [a.id, actorLabel(opts.actor), opts.reason || 'payment deleted']);
      released += sgrToCents0(a.amount);
    }
    return sgrRands(released);
  }
  if (amountC <= 0) return 0;
  // Historical credit payment — find its source reliably or refuse.
  const idx = await loadCustomerIndex(client);
  const state = await chainStateTx(client, payment.owner_type, Number(payment.owner_id));
  const ident = await chainIdentityTx(client, state.chain, idx);
  if (ident.state !== 'matched') {
    throw new BusinessRuleError(`This older credit payment (${fmt(amountC)}) does not record which credit note funded it, and its customer is not resolved (${ident.detail}). Link the document to its customer, then delete the payment again.`);
  }
  await lockCustomerCreditTx(client, state.companyCode, ident.ref);
  const notes = await eligibleCreditNotesTx(client, idx, state.companyCode, ident.ref, true, opts.releaseToCreditNoteId ?? null);
  const candidates = notes.filter((n) => sgrToCents0(n.used_amount) >= amountC);
  let chosen: any = null;
  if (opts.releaseToCreditNoteId) {
    chosen = candidates[0] || null;
    if (!chosen) throw new BusinessRuleError(`The chosen credit note is not one of ${ident.name}'s credit notes in this company with at least ${fmt(amountC)} recorded as used, so the credit cannot be returned to it.`);
  } else if (candidates.length === 1) {
    chosen = candidates[0];
  } else if (candidates.length === 0) {
    throw new BusinessRuleError(`This older credit payment (${fmt(amountC)}) does not record which credit note funded it, and none of ${ident.name}'s credit notes in this company has that much recorded as used. Nothing was deleted. Ask an admin to review the credit note history before removing this payment.`);
  } else {
    const e: any = new BusinessRuleError(`This older credit payment (${fmt(amountC)}) does not record which credit note funded it, and more than one could have: ${candidates.map((n) => `${n.credit_number} (used ${fmt(sgrToCents0(n.used_amount))})`).join(', ')}. Nothing was deleted. Choose the credit note to return the credit to and delete again.`);
    e.candidates = candidates.map((n) => ({ id: Number(n.id), number: n.credit_number, used: Number(n.used_amount) }));
    throw e;
  }
  await client.query(`UPDATE rel_credit_notes SET used_amount = used_amount - $1, row_version = row_version + 1, updated_at = NOW() WHERE id = $2`, [sgrRands(amountC), chosen.id]);
  await client.query(
    `INSERT INTO rel_credit_allocations (company_code, customer_ref, source_type, source_credit_note_id, target_owner_type, target_owner_id, amount, target_payment_id, status, legacy, created_by, reversed_at, reversed_by, reversal_reason)
     VALUES ($1, $2, 'credit_note', $3, $4, $5, $6, $7, 'reversed', true, $8, NOW(), $8, $9)`,
    [state.companyCode ?? '', ident.ref, chosen.id, payment.owner_type, payment.owner_id, sgrRands(amountC), payment.id, actorLabel(opts.actor),
     `historical credit payment deleted; returned to ${chosen.credit_number}${opts.releaseToCreditNoteId ? ' (chosen by user)' : ' (only possible source)'}`]
  );
  return sgrRands(amountC);
}

// ── GUARDS used by update/delete paths ───────────────────────────────────────
/** Refuses a change to a receipt that would invalidate credit already used or refunded from it. */
export async function assertReceiptHasNoCreditUseTx(client: PoolClient, paymentId: number | string, verb: string): Promise<void> {
  const r = await client.query(
    `SELECT (SELECT COUNT(*)::int FROM rel_credit_allocations WHERE source_type = 'payment' AND source_payment_id = $1 AND status = 'active') AS a,
            (SELECT COUNT(*)::int FROM rel_credit_refunds WHERE source_type = 'payment' AND source_payment_id = $1 AND status = 'active') AS f`, [paymentId]);
  const a = Number(r.rows[0].a), f = Number(r.rows[0].f);
  if (a || f) {
    throw new BusinessRuleError(`This receipt cannot be ${verb}: ${a ? `${a} credit allocation${a === 1 ? '' : 's'}` : ''}${a && f ? ' and ' : ''}${f ? `${f} recorded refund${f === 1 ? '' : 's'}` : ''} were made from it. Reverse ${a + f === 1 ? 'it' : 'them'} first (Customer Credits), then try again.`);
  }
}
/** Rows on an owner that must not disappear with a bulk owner delete. */
export async function assertOwnerDeletableTx(client: PoolClient, ownerType: OwnerType, ownerId: number, label: string): Promise<void> {
  const r = await client.query(`SELECT id, entry_kind, method, amount FROM rel_payments WHERE owner_type = $1 AND owner_id = $2`, [ownerType, ownerId]);
  for (const p of r.rows) {
    const k = entryKindOf(p);
    if (k !== 'receipt' && sgrToCents0(p.amount) !== 0) {
      throw new BusinessRuleError(`${label} cannot be deleted: it holds a ${k === 'credit_note' ? 'credit-note payment' : k === 'refund' ? 'recorded refund' : 'payment-credit allocation'} of ${fmt(Math.abs(sgrToCents0(p.amount)))}. Reverse or delete that entry first so the credit returns to its source.`);
    }
    if (k === 'receipt') await assertReceiptHasNoCreditUseTx(client, p.id, 'deleted with this document');
  }
}

// ── APPLY CREDIT ─────────────────────────────────────────────────────────────
export interface ApplyCreditInput {
  sourceType: 'payment' | 'credit_note'; sourceId: number;
  targetType: OwnerType; targetId: number; amount: unknown;
  clientRequestId?: unknown; notes?: string | null; actor?: Actor | null;
}
export async function applyCredit(input: ApplyCreditInput): Promise<{ allocationId: number; targetPaymentId: string; deduplicated?: boolean }> {
  const amountC = parseMoneyCents(input.amount, 'Credit amount');
  if (!['payment', 'credit_note'].includes(input.sourceType)) throw new BusinessRuleError('Choose a credit source (a receipt or a credit note).');
  if (!['invoice', 'job'].includes(input.targetType)) throw new BusinessRuleError('Credit can be applied to an invoice or a job.');
  const key = normalizeClientRequestId(input.clientRequestId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (key) {
      const prior = await client.query('SELECT id, target_payment_id FROM rel_credit_allocations WHERE client_request_id = $1', [key]);
      if (prior.rowCount) { await client.query('COMMIT'); return { allocationId: Number(prior.rows[0].id), targetPaymentId: String(prior.rows[0].target_payment_id), deduplicated: true }; }
    }
    const idx = await loadCustomerIndex(client);
    // Identity + company of the target first (unlocked read), then the customer lock, then row locks.
    const pre = await chainStateTx(client, input.targetType, input.targetId);
    const preIdent = await chainIdentityTx(client, pre.chain, idx);
    if (preIdent.state !== 'matched') throw new BusinessRuleError(`Credit cannot be applied: this document's customer is not resolved (${preIdent.detail}) Link it to its customer first.`);
    await lockCustomerCreditTx(client, pre.companyCode, preIdent.ref);
    if (key) {
      // Re-checked under the customer lock: a concurrent copy of this same
      // request that committed while we waited is the answer, not a second spend.
      const prior = await client.query('SELECT id, target_payment_id FROM rel_credit_allocations WHERE client_request_id = $1', [key]);
      if (prior.rowCount) { await client.query('COMMIT'); return { allocationId: Number(prior.rows[0].id), targetPaymentId: String(prior.rows[0].target_payment_id), deduplicated: true }; }
    }
    const tgt = await targetContextTx(client, idx, input.targetType, input.targetId);
    if (tgt.ident.state !== 'matched' || tgt.ident.ref !== preIdent.ref) throw new ConcurrencyConflictError(input.targetType === 'invoice' ? 'rel_invoices' : 'rel_jobs', input.targetId);
    const co = tgt.state.companyCode;
    if (amountC > (tgt.state.outstandingC || 0)) throw new BusinessRuleError(`Credit of ${fmt(amountC)} is more than the ${fmt(tgt.state.outstandingC || 0)} still due on ${tgt.number}. Apply at most ${fmt(tgt.state.outstandingC || 0)}.`);

    let allocationId: number; let targetPaymentId: string;
    if (input.sourceType === 'payment') {
      const rec = await client.query('SELECT *, payment_date::text AS payment_date_text FROM rel_payments WHERE id = $1 FOR UPDATE', [input.sourceId]);
      if (!rec.rowCount) throw new BusinessRuleError('That receipt no longer exists.');
      const receipt = rec.rows[0];
      if (entryKindOf(receipt) !== 'receipt' || !receipt.credit_eligible) throw new BusinessRuleError('That payment is not a receipt that can provide payment credit (only receipts recorded since customer credit was introduced can).');
      await lockOwnerRowTx(client, receipt.owner_type, Number(receipt.owner_id));
      const src = await chainStateTx(client, receipt.owner_type, Number(receipt.owner_id));
      if (String(src.companyCode ?? '') !== String(co ?? '')) throw new BusinessRuleError('That receipt belongs to another company. Credit stays within its own company.');
      const srcIdent = await chainIdentityTx(client, src.chain, idx);
      if (srcIdent.state !== 'matched' || srcIdent.ref !== tgt.ident.ref) throw new BusinessRuleError(`That receipt belongs to ${srcIdent.state === 'matched' ? srcIdent.name : 'an unresolved customer'}, not ${tgt.ident.name}. Credit can only be used by the customer who paid it.`);
      const sameChain = src.chain.owners.some((o) => tgt.state.chain.owners.some((t) => t.type === o.type && t.id === o.id));
      if (sameChain) throw new BusinessRuleError('That receipt is already part of this transaction — its money already counts here.');
      const pc = await chainPaymentCreditTx(client, src);
      const mine = pc.receipts.find((x) => x.paymentId === Number(receipt.id));
      const availC = mine ? mine.availableC : 0;
      if (amountC > availC) throw new BusinessRuleError(`That receipt has ${fmt(availC)} of payment credit available — ${fmt(amountC)} was requested.`);
      const srcNumber = await ownerNumberTx(client, receipt.owner_type, Number(receipt.owner_id));
      const alloc = await client.query(
        `INSERT INTO rel_credit_allocations (company_code, customer_ref, source_type, source_payment_id, target_owner_type, target_owner_id, target_number, amount, client_request_id, notes, created_by)
         VALUES ($1, $2, 'payment', $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [co ?? '', tgt.ident.ref, receipt.id, input.targetType, input.targetId, tgt.number, sgrRands(amountC), key, input.notes ?? null, actorLabel(input.actor)]);
      allocationId = Number(alloc.rows[0].id);
      const recDate = receipt.payment_date_text || null;
      const out = await insertLedgerRowTx(client, { ownerType: receipt.owner_type, ownerId: Number(receipt.owner_id), amountC: -amountC, date: today(), method: 'Payment credit applied',
        reference: receipt.reference, notes: `Applied to ${tgt.number || input.targetType} (credit allocation #${allocationId})`, kind: 'payment_credit_out', linkId: allocationId });
      const inn = await insertLedgerRowTx(client, { ownerType: input.targetType, ownerId: input.targetId, amountC, date: today(), method: 'Payment credit',
        reference: receipt.reference, notes: `From receipt on ${srcNumber || receipt.owner_type}${recDate ? ` of ${recDate}` : ''} (credit allocation #${allocationId})`, kind: 'payment_credit_in', linkId: allocationId });
      await client.query('UPDATE rel_credit_allocations SET target_payment_id = $2, source_offset_payment_id = $3 WHERE id = $1', [allocationId, inn.id, out.id]);
      targetPaymentId = inn.id;
      await recomputeOwnerPaymentStatus(client, receipt.owner_type, Number(receipt.owner_id));
    } else {
      const nr = await client.query('SELECT * FROM rel_credit_notes WHERE id = $1 FOR UPDATE', [input.sourceId]);
      if (!nr.rowCount) throw new BusinessRuleError('That credit note no longer exists.');
      const note = nr.rows[0];
      if (note.note_type !== 'customer') throw new BusinessRuleError('Only a customer credit note can be applied to a customer document.');
      if (String(note.company_code ?? '') !== String(co ?? '')) throw new BusinessRuleError(`Credit note ${note.credit_number} belongs to another company. Credit stays within its own company.`);
      const nIdent = await creditNoteIdentity(note, idx);
      if (nIdent.state !== 'matched') throw new BusinessRuleError(`Credit note ${note.credit_number} is not linked to a customer (${nIdent.detail}) Choose its customer under Accounting → Customer Credits first.`);
      if (nIdent.ref !== tgt.ident.ref) throw new BusinessRuleError(`Credit note ${note.credit_number} belongs to ${nIdent.name}, not ${tgt.ident.name}.`);
      await pinCreditNoteOwnerTx(client, note, nIdent, { reason: 'allocation', actor: input.actor ?? null, target: tgt.number });
      const availC = creditNoteAvailableC(note);
      if (amountC > availC) throw new BusinessRuleError(`Credit note ${note.credit_number} has ${fmt(availC)} available — ${fmt(amountC)} was requested.`);
      const row = await insertLedgerRowTx(client, { ownerType: input.targetType, ownerId: input.targetId, amountC, date: today(), method: 'Credit',
        notes: `Credit note ${note.credit_number}`, kind: 'credit_note' });
      await client.query(`UPDATE rel_credit_notes SET used_amount = used_amount + $1, row_version = row_version + 1, updated_at = NOW() WHERE id = $2`, [sgrRands(amountC), note.id]);
      const alloc = await client.query(
        `INSERT INTO rel_credit_allocations (company_code, customer_ref, source_type, source_credit_note_id, target_owner_type, target_owner_id, target_number, amount, target_payment_id, client_request_id, notes, created_by)
         VALUES ($1, $2, 'credit_note', $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [co ?? '', tgt.ident.ref, note.id, input.targetType, input.targetId, tgt.number, sgrRands(amountC), row.id, key, input.notes ?? null, actorLabel(input.actor)]);
      allocationId = Number(alloc.rows[0].id);
      await client.query('UPDATE rel_payments SET credit_link_id = $2 WHERE id = $1', [row.id, allocationId]);
      targetPaymentId = row.id;
    }
    await recomputeOwnerPaymentStatus(client, input.targetType, input.targetId);
    await client.query('COMMIT');
    return { allocationId, targetPaymentId };
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (err && err.code === '23505' && key) {
      const w = await pool.query('SELECT id, target_payment_id FROM rel_credit_allocations WHERE client_request_id = $1', [key]);
      if (w.rowCount) return { allocationId: Number(w.rows[0].id), targetPaymentId: String(w.rows[0].target_payment_id), deduplicated: true };
    }
    throw err;
  } finally {
    client.release();
  }
}

// ── REVERSE AN ALLOCATION ────────────────────────────────────────────────────
async function reverseAllocationTx(client: PoolClient, alloc: any, actor: Actor | null, reason: string | null): Promise<void> {
  if (alloc.status !== 'active') return;
  await lockCustomerCreditTx(client, alloc.company_code, alloc.customer_ref);
  const owners: Array<{ t: OwnerType; id: number }> = [];
  for (const pid of [alloc.target_payment_id, alloc.source_offset_payment_id]) {
    if (pid == null) continue;
    const r = await client.query('SELECT id, owner_type, owner_id FROM rel_payments WHERE id = $1 FOR UPDATE', [pid]);
    if (r.rowCount) {
      if (r.rows[0].owner_type === 'invoice') {
        const inv = await client.query('SELECT status, invoice_number FROM rel_invoices WHERE id = $1', [r.rows[0].owner_id]);
        if (inv.rowCount && String(inv.rows[0].status ?? '') === 'void') throw new BusinessRuleError(`Invoice ${inv.rows[0].invoice_number} is cancelled; its entries are kept as issued. Nothing was reversed.`);
      }
      owners.push({ t: r.rows[0].owner_type, id: Number(r.rows[0].owner_id) });
      await client.query('DELETE FROM rel_payments WHERE id = $1', [pid]);
    }
  }
  if (alloc.source_type === 'credit_note') {
    // A credit-note row may be shared by several allocations (one Credit payment
    // funded by two notes); give back THIS allocation's share to ITS note.
    await client.query(`UPDATE rel_credit_notes SET used_amount = GREATEST(0, used_amount - $1), row_version = row_version + 1, updated_at = NOW() WHERE id = $2`, [alloc.amount, alloc.source_credit_note_id]);
    const siblings = await client.query(`SELECT * FROM rel_credit_allocations WHERE target_payment_id = $1 AND id <> $2 AND status = 'active' FOR UPDATE`, [alloc.target_payment_id, alloc.id]);
    for (const s of siblings.rows) {
      await client.query(`UPDATE rel_credit_notes SET used_amount = GREATEST(0, used_amount - $1), row_version = row_version + 1, updated_at = NOW() WHERE id = $2`, [s.amount, s.source_credit_note_id]);
      await client.query(`UPDATE rel_credit_allocations SET status = 'reversed', reversed_at = NOW(), reversed_by = $2, reversal_reason = $3, row_version = row_version + 1 WHERE id = $1`, [s.id, actorLabel(actor), reason || 'reversed with its payment']);
    }
  }
  await client.query(`UPDATE rel_credit_allocations SET status = 'reversed', reversed_at = NOW(), reversed_by = $2, reversal_reason = $3, row_version = row_version + 1 WHERE id = $1`, [alloc.id, actorLabel(actor), reason || null]);
  for (const o of owners) await recomputeOwnerPaymentStatus(client, o.t, o.id);
}
export async function reverseCreditAllocation(id: number, opts: { expectedVersion?: number | null; reason?: string | null; actor?: Actor | null } = {}): Promise<{ reversed: true; alreadyReversed?: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pre = await client.query('SELECT company_code, customer_ref FROM rel_credit_allocations WHERE id = $1', [id]);
    if (!pre.rowCount) throw new BusinessRuleError('That credit allocation no longer exists.');
    await lockCustomerCreditTx(client, pre.rows[0].company_code, pre.rows[0].customer_ref);
    const r = await client.query('SELECT * FROM rel_credit_allocations WHERE id = $1 FOR UPDATE', [id]);
    const alloc = r.rows[0];
    if (alloc.status !== 'active') { await client.query('COMMIT'); return { reversed: true, alreadyReversed: true }; }
    if (opts.expectedVersion != null && Number(alloc.row_version) !== Number(opts.expectedVersion)) throw new ConcurrencyConflictError('rel_credit_allocations', id);
    await reverseAllocationTx(client, alloc, opts.actor || null, opts.reason || null);
    await client.query('COMMIT');
    return { reversed: true };
  } catch (err) { await client.query('ROLLBACK').catch(() => undefined); throw err; } finally { client.release(); }
}

/** Delete path for a ledger row (payment_credit_in/out, refund, or a new-model
 *  credit-note row): reverses the record it belongs to instead of leaving half of it. */
export async function reverseLedgerRowTx(client: PoolClient, payment: any, actor: Actor | null): Promise<number> {
  const k = entryKindOf(payment);
  if (k === 'refund') {
    const f = await client.query(`SELECT * FROM rel_credit_refunds WHERE ledger_payment_id = $1 AND status = 'active' FOR UPDATE`, [payment.id]);
    if (!f.rowCount) throw new BusinessRuleError('This refund entry has no refund record. Nothing was deleted.');
    await reverseRefundTx(client, f.rows[0], actor, 'refund entry deleted');
    return 0;
  }
  const a = await client.query(
    `SELECT * FROM rel_credit_allocations WHERE (target_payment_id = $1 OR source_offset_payment_id = $1) AND status = 'active' ORDER BY id FOR UPDATE`, [payment.id]);
  if (!a.rowCount) throw new BusinessRuleError('This credit entry has no active allocation record. Nothing was deleted.');
  const released = a.rows.filter((x: any) => x.source_type === 'credit_note').reduce((s: number, x: any) => s + sgrToCents0(x.amount), 0);
  for (const alloc of a.rows) {
    const again = await client.query('SELECT status FROM rel_credit_allocations WHERE id = $1', [alloc.id]);
    if (again.rows[0].status !== 'active') continue; // reversed with a sibling (one payment, several notes)
    await reverseAllocationTx(client, alloc, actor, 'payment entry deleted');
  }
  return sgrRands(released);
}

// ── REFUNDS (recorded only — no money is sent) ──────────────────────────────
export interface RefundInput {
  sourceType: 'payment' | 'credit_note'; sourceId: number; amount: unknown;
  date?: unknown; method?: string | null; reference?: string | null; notes?: string | null;
  clientRequestId?: unknown; actor?: Actor | null;
}
export async function recordCreditRefund(input: RefundInput): Promise<{ refundId: number; deduplicated?: boolean }> {
  const amountC = parseMoneyCents(input.amount, 'Refund amount');
  const date = isoDateOrNull(input.date, 'Refund date') || today();
  const key = normalizeClientRequestId(input.clientRequestId);
  if (!input.reference || !String(input.reference).trim()) throw new BusinessRuleError('Enter the refund reference (for example the bank transfer reference) so the refund can be traced.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (key) {
      const prior = await client.query('SELECT id FROM rel_credit_refunds WHERE client_request_id = $1', [key]);
      if (prior.rowCount) { await client.query('COMMIT'); return { refundId: Number(prior.rows[0].id), deduplicated: true }; }
    }
    const idx = await loadCustomerIndex(client);
    let refundId: number;
    if (input.sourceType === 'payment') {
      const pre = await client.query('SELECT * FROM rel_payments WHERE id = $1', [input.sourceId]);
      if (!pre.rowCount) throw new BusinessRuleError('That receipt no longer exists.');
      const st0 = await chainStateTx(client, pre.rows[0].owner_type, Number(pre.rows[0].owner_id));
      const id0 = await chainIdentityTx(client, st0.chain, idx);
      if (id0.state !== 'matched') throw new BusinessRuleError(`This receipt's customer is not resolved (${id0.detail}) Link it to its customer first.`);
      await lockCustomerCreditTx(client, st0.companyCode, id0.ref);
      if (key) {
        const prior = await client.query('SELECT id FROM rel_credit_refunds WHERE client_request_id = $1', [key]);
        if (prior.rowCount) { await client.query('COMMIT'); return { refundId: Number(prior.rows[0].id), deduplicated: true }; }
      }
      const rec = (await client.query('SELECT * FROM rel_payments WHERE id = $1 FOR UPDATE', [input.sourceId])).rows[0];
      if (!rec || entryKindOf(rec) !== 'receipt' || !rec.credit_eligible) throw new BusinessRuleError('Only a receipt recorded since customer credit was introduced can provide a refund of payment credit.');
      await lockOwnerRowTx(client, rec.owner_type, Number(rec.owner_id));
      const st = await chainStateTx(client, rec.owner_type, Number(rec.owner_id));
      const pc = await chainPaymentCreditTx(client, st);
      const mine = pc.receipts.find((x) => x.paymentId === Number(rec.id));
      const availC = mine ? mine.availableC : 0;
      if (amountC > availC) throw new BusinessRuleError(`That receipt has ${fmt(availC)} of payment credit available to refund — ${fmt(amountC)} was requested.`);
      const f = await client.query(
        `INSERT INTO rel_credit_refunds (company_code, customer_ref, source_type, source_payment_id, amount, refund_date, method, reference, notes, client_request_id, created_by)
         VALUES ($1, $2, 'payment', $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [st.companyCode ?? '', id0.ref, rec.id, sgrRands(amountC), date, input.method || null, String(input.reference).trim(), input.notes || null, key, actorLabel(input.actor)]);
      refundId = Number(f.rows[0].id);
      const led = await insertLedgerRowTx(client, { ownerType: rec.owner_type, ownerId: Number(rec.owner_id), amountC: -amountC, date, method: 'Refund',
        reference: String(input.reference).trim(), notes: `Recorded refund of payment credit (refund #${refundId})`, kind: 'refund', linkId: refundId });
      await client.query('UPDATE rel_credit_refunds SET ledger_payment_id = $2 WHERE id = $1', [refundId, led.id]);
      await recomputeOwnerPaymentStatus(client, rec.owner_type, Number(rec.owner_id));
    } else {
      const pre = await client.query('SELECT * FROM rel_credit_notes WHERE id = $1', [input.sourceId]);
      if (!pre.rowCount) throw new BusinessRuleError('That credit note no longer exists.');
      const nId = await creditNoteIdentity(pre.rows[0], idx);
      if (nId.state !== 'matched') throw new BusinessRuleError(`Credit note ${pre.rows[0].credit_number} is not linked to a customer (${nId.detail}) Choose its customer first.`);
      if (pre.rows[0].note_type !== 'customer') throw new BusinessRuleError('Only customer credit notes can be refunded here.');
      await lockCustomerCreditTx(client, pre.rows[0].company_code, nId.ref);
      if (key) {
        const prior = await client.query('SELECT id FROM rel_credit_refunds WHERE client_request_id = $1', [key]);
        if (prior.rowCount) { await client.query('COMMIT'); return { refundId: Number(prior.rows[0].id), deduplicated: true }; }
      }
      const note = (await client.query('SELECT * FROM rel_credit_notes WHERE id = $1 FOR UPDATE', [input.sourceId])).rows[0];
      // Re-resolved on the LOCKED row: a concurrent first use may have linked it.
      const lockedId = await creditNoteIdentity(note, idx);
      if (lockedId.state !== 'matched' || lockedId.ref !== nId.ref) throw new BusinessRuleError(`Credit note ${note.credit_number} was just linked to another customer, so it cannot be refunded to ${nId.name}. Nothing was recorded.`);
      await pinCreditNoteOwnerTx(client, note, lockedId, { reason: 'refund', actor: input.actor ?? null, target: null });
      const availC = creditNoteAvailableC(note);
      if (amountC > availC) throw new BusinessRuleError(`Credit note ${note.credit_number} has ${fmt(availC)} available to refund — ${fmt(amountC)} was requested.`);
      const f = await client.query(
        `INSERT INTO rel_credit_refunds (company_code, customer_ref, source_type, source_credit_note_id, amount, refund_date, method, reference, notes, client_request_id, created_by)
         VALUES ($1, $2, 'credit_note', $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [note.company_code ?? '', nId.ref, note.id, sgrRands(amountC), date, input.method || null, String(input.reference).trim(), input.notes || null, key, actorLabel(input.actor)]);
      refundId = Number(f.rows[0].id);
      await client.query(`UPDATE rel_credit_notes SET refunded_amount = refunded_amount + $1, row_version = row_version + 1, updated_at = NOW() WHERE id = $2`, [sgrRands(amountC), note.id]);
    }
    await client.query('COMMIT');
    return { refundId };
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (err && err.code === '23505' && key) {
      const w = await pool.query('SELECT id FROM rel_credit_refunds WHERE client_request_id = $1', [key]);
      if (w.rowCount) return { refundId: Number(w.rows[0].id), deduplicated: true };
    }
    throw err;
  } finally { client.release(); }
}
async function reverseRefundTx(client: PoolClient, f: any, actor: Actor | null, reason: string | null): Promise<void> {
  if (f.status !== 'active') return;
  await lockCustomerCreditTx(client, f.company_code, f.customer_ref);
  if (f.source_type === 'payment') {
    const r = await client.query('SELECT id, owner_type, owner_id FROM rel_payments WHERE id = $1 FOR UPDATE', [f.ledger_payment_id]);
    if (r.rowCount) {
      await client.query('DELETE FROM rel_payments WHERE id = $1', [f.ledger_payment_id]);
      await recomputeOwnerPaymentStatus(client, r.rows[0].owner_type, Number(r.rows[0].owner_id));
    }
  } else {
    await client.query(`UPDATE rel_credit_notes SET refunded_amount = GREATEST(0, refunded_amount - $1), row_version = row_version + 1, updated_at = NOW() WHERE id = $2`, [f.amount, f.source_credit_note_id]);
  }
  await client.query(`UPDATE rel_credit_refunds SET status = 'reversed', reversed_at = NOW(), reversed_by = $2, reversal_reason = $3, row_version = row_version + 1 WHERE id = $1`, [f.id, actorLabel(actor), reason || null]);
}
export async function reverseCreditRefund(id: number, opts: { reason?: string | null; actor?: Actor | null } = {}): Promise<{ reversed: true; alreadyReversed?: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pre = await client.query('SELECT company_code, customer_ref FROM rel_credit_refunds WHERE id = $1', [id]);
    if (!pre.rowCount) throw new BusinessRuleError('That refund record no longer exists.');
    await lockCustomerCreditTx(client, pre.rows[0].company_code, pre.rows[0].customer_ref);
    const f = (await client.query('SELECT * FROM rel_credit_refunds WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (f.status !== 'active') { await client.query('COMMIT'); return { reversed: true, alreadyReversed: true }; }
    await reverseRefundTx(client, f, opts.actor || null, opts.reason || null);
    await client.query('COMMIT');
    return { reversed: true };
  } catch (err) { await client.query('ROLLBACK').catch(() => undefined); throw err; } finally { client.release(); }
}

// ── READ: one customer's credit, and the per-company summary ─────────────────
async function allocationHistory(client: PoolClient | typeof pool, where: string, params: any[]) {
  const r = await client.query(
    `SELECT id, source_type, source_payment_id, source_credit_note_id, target_owner_type, target_owner_id, target_number, amount, status, legacy,
            created_at, created_by, reversed_at, reversed_by, reversal_reason, notes, row_version
       FROM rel_credit_allocations WHERE ${where} ORDER BY created_at, id`, params);
  return r.rows.map((a: any) => ({
    id: Number(a.id), kind: 'allocation', sourceType: a.source_type, targetType: a.target_owner_type, targetId: Number(a.target_owner_id), targetNumber: a.target_number,
    amount: Number(a.amount), status: a.status, legacy: !!a.legacy, createdAt: a.created_at, createdBy: a.created_by,
    reversedAt: a.reversed_at, reversedBy: a.reversed_by, reversalReason: a.reversal_reason, notes: a.notes, rowVersion: Number(a.row_version),
  }));
}
async function refundHistory(client: PoolClient | typeof pool, where: string, params: any[]) {
  const r = await client.query(
    `SELECT id, amount, refund_date::text AS refund_date, method, reference, notes, status, created_at, created_by, reversed_at, reversed_by, reversal_reason
       FROM rel_credit_refunds WHERE ${where} ORDER BY created_at, id`, params);
  return r.rows.map((f: any) => ({
    id: Number(f.id), kind: 'refund', amount: Number(f.amount), date: f.refund_date, method: f.method, reference: f.reference, notes: f.notes, status: f.status,
    createdAt: f.created_at, createdBy: f.created_by, reversedAt: f.reversed_at, reversedBy: f.reversed_by, reversalReason: f.reversal_reason,
  }));
}

export interface CustomerCreditView {
  companyCode: string; customer: { ref: string; name: string | null };
  paymentCredits: any[]; creditNotes: any[];
  totals: { paymentCredit: number; creditNotes: number; total: number };
}
export async function customerCreditTx(client: PoolClient | typeof pool, companyCode: string, customerRef: string, idx?: CustomerIndex, withHistory = true): Promise<CustomerCreditView> {
  const ix = idx || await loadCustomerIndex(client);
  const name = ix.nameOf(customerRef);
  const nameKeys = new Set<string>();
  if (name) nameKeys.add(norm(name));
  // Pre-filter: eligible receipts whose own document is linked to this customer
  // or unlinked under one of its names; the chain identity then decides.
  const formerFor: string[] = [];
  ix.byFormer.forEach((refs, n) => { if (refs.includes(customerRef)) formerFor.push(n); });
  formerFor.forEach((n) => nameKeys.add(n));
  const cand = await client.query(
    `SELECT p.id, p.owner_type, p.owner_id
       FROM rel_payments p
       LEFT JOIN rel_invoices i ON p.owner_type = 'invoice' AND i.id = p.owner_id
       LEFT JOIN rel_jobs j ON p.owner_type = 'job' AND j.id = p.owner_id
       LEFT JOIN rel_quotes q ON p.owner_type = 'quote' AND q.id = p.owner_id
      WHERE p.credit_eligible AND p.entry_kind = 'receipt'
        AND COALESCE(i.company_code, j.company_code, q.company_code) IS NOT DISTINCT FROM $1
        AND (COALESCE(i.customer_ref, i.legacy_data->>'customerId', j.customer_ref, j.legacy_data->>'customerId', q.customer_ref, q.legacy_data->>'customerId') = $2
             OR (COALESCE(i.customer_ref, i.legacy_data->>'customerId', j.customer_ref, j.legacy_data->>'customerId', q.customer_ref, q.legacy_data->>'customerId') IS NULL
                 AND LOWER(TRIM(COALESCE(i.contact_name, j.customer_name_raw, q.customer_name_raw, ''))) = ANY($3::text[])))
      ORDER BY p.id`, [companyCode, customerRef, Array.from(nameKeys)]);
  const seenChains = new Set<string>();
  const paymentCredits: any[] = [];
  for (const row of cand.rows) {
    const st = await chainStateTx(client, row.owner_type, Number(row.owner_id));
    const chainKey = st.chain.owners.map((o) => `${o.type}:${o.id}`).sort().join('|');
    if (seenChains.has(chainKey)) continue;
    seenChains.add(chainKey);
    const ident = await chainIdentityTx(client, st.chain, ix);
    if (ident.state !== 'matched' || ident.ref !== customerRef) continue;
    const pc = await chainPaymentCreditTx(client, st);
    for (const r of pc.receipts) {
      const hasActivity = r.allocatedC > 0 || r.refundedC > 0;
      if (r.availableC <= 0 && !hasActivity) continue;
      paymentCredits.push({
        sourceType: 'payment', sourceId: r.paymentId, date: r.date, method: r.method, reference: r.reference,
        document: { type: r.ownerType, id: r.ownerId, number: r.ownerNumber },
        original: sgrRands(r.amountC), allocated: sgrRands(r.allocatedC), refunded: sgrRands(r.refundedC),
        settledOnOwnDocument: sgrRands(Math.max(0, r.amountC - r.allocatedC - r.refundedC - r.availableC)),
        available: sgrRands(r.availableC),
        history: withHistory ? [
          ...(await allocationHistory(client, `source_type = 'payment' AND source_payment_id = $1`, [r.paymentId])),
          ...(await refundHistory(client, `source_type = 'payment' AND source_payment_id = $1`, [r.paymentId])),
        ] : [],
      });
    }
  }
  const notes = await eligibleCreditNotesTx(client, ix, companyCode, customerRef, false);
  const creditNotes: any[] = [];
  for (const n of notes) {
    creditNotes.push({
      sourceType: 'credit_note', sourceId: Number(n.id), number: n.credit_number, date: n.note_date_text || null,
      reason: n.reason, original: Number(n.amount), used: Number(n.used_amount), refunded: Number(n.refunded_amount || 0),
      available: sgrRands(creditNoteAvailableC(n)), linked: !!creditNoteRef(n), rowVersion: Number(n.row_version),
      history: withHistory ? [
        ...(await allocationHistory(client, `source_type = 'credit_note' AND source_credit_note_id = $1`, [n.id])),
        ...(await refundHistory(client, `source_type = 'credit_note' AND source_credit_note_id = $1`, [n.id])),
      ] : [],
    });
  }
  const pcT = paymentCredits.reduce((s, x) => s + sgrToCents0(x.available), 0);
  const cnT = creditNotes.reduce((s, x) => s + sgrToCents0(x.available), 0);
  return { companyCode, customer: { ref: customerRef, name }, paymentCredits, creditNotes,
    totals: { paymentCredit: sgrRands(pcT), creditNotes: sgrRands(cnT), total: sgrRands(pcT + cnT) } };
}
export async function getCustomerCredit(companyCode: string, customerRef: string): Promise<CustomerCreditView> {
  return customerCreditTx(pool, companyCode, customerRef);
}

/** Every customer with credit in the given companies, plus anything that cannot
 *  be attributed to a customer (surfaced for an explicit choice). */
export async function getCreditSummary(companyCodes: string[]): Promise<{ customers: any[]; unresolved: any[] }> {
  const idx = await loadCustomerIndex(pool);
  const agg = new Map<string, { companyCode: string; ref: string; name: string | null; paymentCredit: number; creditNotes: number }>();
  const add = (co: string, ref: string, field: 'paymentCredit' | 'creditNotes', c: number) => {
    const k = `${co}|${ref}`;
    const cur = agg.get(k) || { companyCode: co, ref, name: idx.nameOf(ref), paymentCredit: 0, creditNotes: 0 };
    cur[field] += c; agg.set(k, cur);
  };
  const unresolved: any[] = [];
  const rec = await pool.query(
    `SELECT p.id, p.owner_type, p.owner_id FROM rel_payments p
       LEFT JOIN rel_invoices i ON p.owner_type = 'invoice' AND i.id = p.owner_id
       LEFT JOIN rel_jobs j ON p.owner_type = 'job' AND j.id = p.owner_id
       LEFT JOIN rel_quotes q ON p.owner_type = 'quote' AND q.id = p.owner_id
      WHERE p.credit_eligible AND p.entry_kind = 'receipt' AND COALESCE(i.company_code, j.company_code, q.company_code) = ANY($1::text[])
      ORDER BY p.id`, [companyCodes]);
  const seen = new Set<string>();
  for (const row of rec.rows) {
    const st = await chainStateTx(pool, row.owner_type, Number(row.owner_id));
    const k = st.chain.owners.map((o) => `${o.type}:${o.id}`).sort().join('|');
    if (seen.has(k)) continue; seen.add(k);
    if (st.excessC <= 0) continue;
    const pc = await chainPaymentCreditTx(pool, st);
    if (pc.poolC <= 0) continue;
    const ident = await chainIdentityTx(pool, st.chain, idx);
    if (ident.state === 'matched') add(String(st.companyCode ?? ''), ident.ref, 'paymentCredit', pc.poolC);
    else for (const r of pc.receipts.filter((x) => x.availableC > 0)) unresolved.push({ sourceType: 'payment', sourceId: r.paymentId, companyCode: st.companyCode, document: { type: r.ownerType, id: r.ownerId, number: r.ownerNumber }, date: r.date, available: sgrRands(r.availableC), name: ident.name, reason: ident.detail });
  }
  const notes = await pool.query(`SELECT *, note_date::text AS note_date_text FROM rel_credit_notes WHERE note_type = 'customer' AND company_code = ANY($1::text[]) ORDER BY id`, [companyCodes]);
  for (const n of notes.rows) {
    const availC = creditNoteAvailableC(n);
    if (availC <= 0) continue;
    const ident = await creditNoteIdentity(n, idx);
    if (ident.state === 'matched') add(String(n.company_code ?? ''), ident.ref, 'creditNotes', availC);
    else unresolved.push({ sourceType: 'credit_note', sourceId: Number(n.id), number: n.credit_number, companyCode: n.company_code, date: n.note_date_text || null, available: sgrRands(availC), name: n.contact_name_raw, reason: ident.detail, rowVersion: Number(n.row_version) });
  }
  const customers = Array.from(agg.values()).map((c) => ({ ...c, paymentCredit: sgrRands(c.paymentCredit), creditNotes: sgrRands(c.creditNotes), total: sgrRands(c.paymentCredit + c.creditNotes) }))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  return { customers, unresolved };
}

/** Available credit for the customer of one document (the payment window). */
export async function getDocumentCredit(ownerType: OwnerType, ownerId: number): Promise<{ identity: Identity; companyCode: string | null; outstanding: number | null; ownCredit: number; credit: CustomerCreditView | null }> {
  const idx = await loadCustomerIndex(pool);
  const st = await chainStateTx(pool, ownerType, ownerId);
  const identity = await chainIdentityTx(pool, st.chain, idx);
  const outstanding = st.outstandingC === null ? null : sgrRands(st.outstandingC);
  if (identity.state !== 'matched' || st.companyCode === null) return { identity, companyCode: st.companyCode, outstanding, ownCredit: 0, credit: null };
  const credit = await customerCreditTx(pool, st.companyCode, identity.ref, idx, false);
  const ownPool = await chainPaymentCreditTx(pool, st);
  // Never offer a receipt of this same transaction as credit for it.
  const own = new Set(st.chain.owners.map((o) => `${o.type}:${o.id}`));
  credit.paymentCredits = credit.paymentCredits.filter((p) => !own.has(`${p.document.type}:${p.document.id}`));
  const pcT = credit.paymentCredits.reduce((s, x) => s + sgrToCents0(x.available), 0);
  const cnT = sgrToCents0(credit.totals.creditNotes);
  credit.totals = { paymentCredit: sgrRands(pcT), creditNotes: sgrRands(cnT), total: sgrRands(pcT + cnT) };
  // ownCredit: what THIS transaction's own eligible receipts left as payment credit.
  return { identity, companyCode: st.companyCode, outstanding, ownCredit: sgrRands(ownPool.poolC), credit };
}
