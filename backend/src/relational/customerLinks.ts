/**
 * CUSTOMER LINKS — preview and transactional reassignment of a transaction
 * chain to a customer (2026-11-24, migration 021).
 *
 * THE MODEL
 *   - The customer record is the source of truth. Customers are platform_state
 *     authoritative (permanently blocked from relational cutover), so the
 *     stable identity is the platform_state customer `id`, as text.
 *   - Quotes, jobs, invoices and credit notes carry that id in customer_ref.
 *     The customer's details are always READ from the customer record; the
 *     documents' own name/contact columns are historical snapshots only.
 *   - "Change which customer owns a transaction" moves the WHOLE chain:
 *     quote -> job -> every invoice of that job/quote, including cancelled
 *     invoices that still point back to it through their cancellation marker
 *     (originalJobId / originalQuoteId) and their replacements.
 *
 * WHAT A REASSIGNMENT WRITES (one transaction, every row locked first)
 *   - quotes / jobs / active invoices: customer_ref + their snapshot columns
 *     (name, contact, email, phone, address, VAT on quotes/jobs; name, email,
 *     address on invoices) from the target customer record;
 *   - cancelled invoices: customer_ref ONLY. Their issued snapshot and their
 *     cancellation marker are audit evidence and are never rewritten;
 *   - one customer_link_audit row with every member, the previous links and
 *     names, the actor and the time.
 *   Lines, prices, totals, numbers, dates, payments and payment allocations are
 *   never touched. Payments belong to the chain, so they move with it.
 *
 * WHAT IS REFUSED, with the exact reason
 *   - a target that is not exactly ONE existing customer (missing, or an id
 *     shared by two customer records — run the id-collision repair first);
 *   - any non-zero "Credit" payment on the chain when the chain would change
 *     customer: credit release finds the credit notes by the owner document's
 *     customer name, so moving it would later return the credit to the WRONG
 *     customer's credit note. The user reverses that allocation first;
 *   - a quote claimed by more than one job (the quarantined historical
 *     collision) — which job belongs to the chain is a human decision;
 *   - stale versions: the preview's row versions are re-checked under lock and
 *     any change (or any new member) is a 409, so the user re-previews.
 */
import { PoolClient } from 'pg';
import pool from '../db/pool';
import { isSectionCutOver } from './cutover';
import { resolveTransactionChainTx, BusinessRuleError, ConcurrencyConflictError, normalizeCustomerRef } from './services';

export interface CanonicalCustomer {
  ref: string; companyName: string; contactPerson: string | null; email: string | null;
  phone: string | null; address: string | null; vatNumber: string | null;
}
export type MemberType = 'quote' | 'job' | 'invoice';
export interface ChainMember {
  type: MemberType; id: number; number: string | null; companyCode: string | null;
  status: string | null; rowVersion: number; customerRef: string | null; customerName: string | null;
  cancelled: boolean;
}
export interface ChainConflict { type: MemberType; id: number; number: string | null; code: string; message: string }
export interface ChainPreview {
  anchor: { type: MemberType; id: number };
  companyCode: string | null;
  target: CanonicalCustomer;
  members: ChainMember[];
  currentRefs: string[];
  currentNames: string[];
  conflicts: ChainConflict[];
  changes: number;
}

const t = (v: unknown): string | null => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());
const norm = (v: unknown): string => String(v == null ? '' : v).trim().toLowerCase();

/** Every customer from the AUTHORITATIVE store. */
export async function loadCanonicalCustomers(client: PoolClient | typeof pool): Promise<CanonicalCustomer[]> {
  if (await isSectionCutOver('customers')) {
    const r = await client.query('SELECT source_id, company_name, contact_person, email, phone, address, vat_number FROM rel_customers');
    return r.rows.map((c: any) => ({ ref: String(c.source_id), companyName: String(c.company_name || ''), contactPerson: t(c.contact_person),
      email: t(c.email), phone: t(c.phone), address: t(c.address), vatNumber: t(c.vat_number) }));
  }
  const r = await client.query(`SELECT data -> 'customers' AS c FROM platform_state WHERE id = 1`);
  const arr = Array.isArray(r.rows[0]?.c) ? r.rows[0].c : [];
  return arr.filter((c: any) => c && c.id !== undefined && c.id !== null).map((c: any) => ({
    ref: String(c.id), companyName: String(c.companyName || ''), contactPerson: t(c.contactPerson), email: t(c.email),
    phone: t(c.tel ?? c.phone), address: t(c.address), vatNumber: t(c.vatNumber),
  }));
}

/** Exactly one customer for a ref, or the precise reason there is not. */
export async function resolveCanonicalCustomer(client: PoolClient | typeof pool, rawRef: unknown):
  Promise<{ state: 'matched'; customer: CanonicalCustomer } | { state: 'missing' | 'duplicate'; count: number }> {
  const ref = normalizeCustomerRef(rawRef);
  if (ref === null) return { state: 'missing', count: 0 };
  const hits = (await loadCanonicalCustomers(client)).filter((c) => c.ref === ref);
  if (hits.length === 1) return { state: 'matched', customer: hits[0] };
  return { state: hits.length ? 'duplicate' : 'missing', count: hits.length };
}

async function collectChainTx(client: PoolClient, anchorType: MemberType, anchorId: number, lock: boolean): Promise<{ companyCode: string | null; members: ChainMember[]; ambiguity: ChainConflict[] }> {
  const table = anchorType === 'quote' ? 'rel_quotes' : anchorType === 'job' ? 'rel_jobs' : 'rel_invoices';
  const exists = await client.query(`SELECT id FROM ${table} WHERE id = $1`, [anchorId]);
  if (!exists.rowCount) throw new BusinessRuleError(`That ${anchorType} no longer exists.`);
  const chain = await resolveTransactionChainTx(client, anchorType, anchorId);
  const co = chain.companyCode;
  const ambiguity: ChainConflict[] = [];
  const quoteIds = new Set<number>(); const jobIds = new Set<number>(); const invIds = new Set<number>();
  if (chain.quoteId !== null) quoteIds.add(chain.quoteId);
  if (chain.jobId !== null) jobIds.add(chain.jobId);
  for (const id of chain.invoiceIds) invIds.add(id);
  if (anchorType === 'quote') quoteIds.add(anchorId);
  if (anchorType === 'job') jobIds.add(anchorId);
  if (anchorType === 'invoice') invIds.add(anchorId);

  // A quote claimed by more than one job: which job is this transaction's is a
  // human decision (the quarantined historical collision), never guessed.
  for (const qid of quoteIds) {
    const j = await client.query('SELECT id, job_number FROM rel_jobs WHERE quote_id = $1 AND company_code IS NOT DISTINCT FROM $2', [qid, co]);
    if ((j.rowCount || 0) > 1) {
      ambiguity.push({ type: 'quote', id: qid, number: null, code: 'AMBIGUOUS_CHAIN',
        message: `This quote is linked to ${j.rowCount} jobs (${j.rows.map((r: any) => r.job_number).join(', ')}). Decide which job belongs to it before changing the customer.` });
    }
  }
  // Cancelled invoices of this chain (their job_id/quote_id were released on
  // cancellation; the marker still names the original job/quote) and any other
  // invoice row still pointing at a chain job/quote.
  const jArr = Array.from(jobIds).map(String); const qArr = Array.from(quoteIds).map(String);
  if (jArr.length || qArr.length) {
    const jn = jArr.length ? (await client.query('SELECT job_number FROM rel_jobs WHERE id = ANY($1::bigint[])', [jArr])).rows.map((r: any) => String(r.job_number || '')).filter(Boolean) : [];
    const qn = qArr.length ? (await client.query('SELECT quote_number FROM rel_quotes WHERE id = ANY($1::bigint[])', [qArr])).rows.map((r: any) => String(r.quote_number || '')).filter(Boolean) : [];
    const r = await client.query(
      `SELECT id FROM rel_invoices
        WHERE company_code IS NOT DISTINCT FROM $3
          AND (job_id::text = ANY($1::text[]) OR quote_id::text = ANY($2::text[])
               OR (legacy_data->>'originalJobId') = ANY($1::text[])
               OR (legacy_data->>'originalQuoteId') = ANY($2::text[])
               -- older links: an invoice tied to the job/quote only by its number
               -- (or the job number in its reference, the dashboard's own rule),
               -- including cancelled invoices recorded before markers carried ids
               OR (job_id IS NULL AND quote_id IS NULL
                   AND (UPPER(COALESCE(job_number_raw, '')) = ANY($4::text[])
                        OR UPPER(COALESCE(reference, '')) = ANY($4::text[])
                        OR UPPER(COALESCE(quote_number_raw, '')) = ANY($5::text[]))))`,
      [jArr, qArr, co, jn.map((x) => x.toUpperCase()), qn.map((x) => x.toUpperCase())]);
    for (const row of r.rows) invIds.add(Number(row.id));
  }
  const lockSql = lock ? ' FOR UPDATE' : '';
  const members: ChainMember[] = [];
  const q = await client.query(`SELECT id, quote_number, company_code, status, row_version, customer_ref, customer_name_raw FROM rel_quotes WHERE id = ANY($1::bigint[]) ORDER BY id${lockSql}`, [Array.from(quoteIds)]);
  for (const r of q.rows) members.push({ type: 'quote', id: Number(r.id), number: r.quote_number, companyCode: t(r.company_code), status: t(r.status), rowVersion: Number(r.row_version), customerRef: t(r.customer_ref), customerName: t(r.customer_name_raw), cancelled: false });
  const j = await client.query(`SELECT id, job_number, company_code, status, row_version, customer_ref, customer_name_raw FROM rel_jobs WHERE id = ANY($1::bigint[]) ORDER BY id${lockSql}`, [Array.from(jobIds)]);
  for (const r of j.rows) members.push({ type: 'job', id: Number(r.id), number: r.job_number, companyCode: t(r.company_code), status: t(r.status), rowVersion: Number(r.row_version), customerRef: t(r.customer_ref), customerName: t(r.customer_name_raw), cancelled: false });
  const i = await client.query(`SELECT id, invoice_number, company_code, status, row_version, customer_ref, contact_name FROM rel_invoices WHERE id = ANY($1::bigint[]) ORDER BY id${lockSql}`, [Array.from(invIds)]);
  for (const r of i.rows) members.push({ type: 'invoice', id: Number(r.id), number: r.invoice_number, companyCode: t(r.company_code), status: t(r.status), rowVersion: Number(r.row_version), customerRef: t(r.customer_ref), customerName: t(r.contact_name), cancelled: String(r.status || '') === 'void' });
  // Company isolation, verified rather than assumed.
  for (const m of members) {
    if (String(m.companyCode ?? '') !== String(co ?? '')) throw new BusinessRuleError(`${m.type} ${m.number || m.id} belongs to another company; the chain was not changed.`);
  }
  return { companyCode: co, members, ambiguity };
}

async function creditConflictsTx(client: PoolClient, members: ChainMember[], target: CanonicalCustomer): Promise<ChainConflict[]> {
  const out: ChainConflict[] = [];
  for (const m of members) {
    const moves = m.customerRef !== target.ref || norm(m.customerName) !== norm(target.companyName);
    if (!moves) continue;
    // 2026-11-26 (customer credit): also any payment-credit allocation, recorded
    // refund, or receipt whose credit was used — credit belongs to one customer.
    const p = await client.query(
      `SELECT amount, payment_date FROM rel_payments
        WHERE owner_type = $1 AND owner_id = $2 AND amount <> 0
          AND (LOWER(TRIM(COALESCE(method, ''))) LIKE 'credit%'
               OR entry_kind IN ('credit_note','payment_credit_in','payment_credit_out','refund')
               OR EXISTS (SELECT 1 FROM rel_credit_allocations a WHERE a.source_type = 'payment' AND a.source_payment_id = rel_payments.id AND a.status = 'active')
               OR EXISTS (SELECT 1 FROM rel_credit_refunds f WHERE f.source_type = 'payment' AND f.source_payment_id = rel_payments.id AND f.status = 'active'))`,
      [m.type, m.id]);
    if (p.rowCount) {
      const total = p.rows.reduce((s: number, r: any) => s + Number(r.amount), 0);
      out.push({ type: m.type, id: m.id, number: m.number, code: 'CREDIT_ALLOCATION',
        message: `${m.type === 'invoice' ? 'Invoice' : m.type === 'job' ? 'Job' : 'Quote'} ${m.number || m.id} has R${Math.abs(total).toFixed(2)} of customer-credit activity (${p.rowCount} credit entr${p.rowCount === 1 ? 'y' : 'ies'}: credit applied, credit used elsewhere, or a recorded refund). Customer credit belongs to one customer, so moving this transaction would move that credit to the wrong customer. Reverse those credit entries first (Customer Credits), change the customer, then apply the new customer's credit if needed.` });
    }
  }
  return out;
}

function summarise(anchorType: MemberType, anchorId: number, companyCode: string | null, target: CanonicalCustomer, members: ChainMember[], conflicts: ChainConflict[]): ChainPreview {
  const currentRefs = Array.from(new Set(members.map((m) => m.customerRef).filter((x): x is string => !!x)));
  const currentNames = Array.from(new Set(members.map((m) => m.customerName).filter((x): x is string => !!x)));
  const changes = members.filter((m) => m.customerRef !== target.ref || (!m.cancelled && m.customerName !== target.companyName)).length;
  return { anchor: { type: anchorType, id: anchorId }, companyCode, target, members, currentRefs, currentNames, conflicts, changes };
}

async function targetOrThrow(client: PoolClient, customerRef: unknown): Promise<CanonicalCustomer> {
  const r = await resolveCanonicalCustomer(client, customerRef);
  if (r.state === 'matched') return r.customer;
  if (r.state === 'duplicate') throw new BusinessRuleError(`${r.count} customer records share the id "${String(customerRef)}". Repair the duplicate customer id before assigning documents to it.`);
  throw new BusinessRuleError('That customer does not exist (it may have been deleted). Choose or create the customer first.');
}

export async function previewCustomerReassignment(anchorType: MemberType, anchorId: number, customerRef: unknown): Promise<ChainPreview> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const target = await targetOrThrow(client, customerRef);
    const { companyCode, members, ambiguity } = await collectChainTx(client, anchorType, anchorId, false);
    const conflicts = [...ambiguity, ...(await creditConflictsTx(client, members, target))];
    await client.query('COMMIT');
    return summarise(anchorType, anchorId, companyCode, target, members, conflicts);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally { client.release(); }
}

/** `expected` = { "quote:12": rowVersion, ... } exactly as the preview returned. */
export async function reassignCustomerChain(
  anchorType: MemberType, anchorId: number, customerRef: unknown,
  expected: Record<string, number> | null, actor: { id?: unknown; email?: string | null } | null,
): Promise<ChainPreview & { applied: true }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const target = await targetOrThrow(client, customerRef);
    const { companyCode, members, ambiguity } = await collectChainTx(client, anchorType, anchorId, true);
    // Stale preview: any member whose version moved, or that the preview never showed.
    if (expected) {
      for (const m of members) {
        const k = `${m.type}:${m.id}`;
        if (!(k in expected) || Number(expected[k]) !== m.rowVersion) {
          throw new ConcurrencyConflictError(m.type === 'quote' ? 'rel_quotes' : m.type === 'job' ? 'rel_jobs' : 'rel_invoices', m.id);
        }
      }
    }
    const conflicts = [...ambiguity, ...(await creditConflictsTx(client, members, target))];
    if (conflicts.length) throw new BusinessRuleError('The customer was not changed. ' + conflicts.map((c) => c.message).join(' '));
    const before = members.map((m) => ({ ...m }));
    for (const m of members) {
      let r;
      if (m.type === 'quote' || m.type === 'job') {
        const table = m.type === 'quote' ? 'rel_quotes' : 'rel_jobs';
        r = await client.query(
          `UPDATE ${table} SET customer_ref = $1, customer_name_raw = $2, contact_person = $3, email = $4, phone = $5, address = $6, vat_number = $7,
             row_version = row_version + 1, updated_at = NOW() WHERE id = $8 RETURNING row_version`,
          [target.ref, target.companyName, target.contactPerson, target.email, target.phone, target.address, target.vatNumber, m.id]);
      } else if (m.cancelled) {
        // Audit evidence stays as issued: only the reliable link moves.
        r = await client.query(`UPDATE rel_invoices SET customer_ref = $1, row_version = row_version + 1, updated_at = NOW() WHERE id = $2 RETURNING row_version`, [target.ref, m.id]);
      } else {
        r = await client.query(
          `UPDATE rel_invoices SET customer_ref = $1, contact_name = $2, contact_email = $3, contact_address = $4,
             row_version = row_version + 1, updated_at = NOW() WHERE id = $5 RETURNING row_version`,
          [target.ref, target.companyName, target.email, target.address, m.id]);
      }
      m.rowVersion = Number(r.rows[0].row_version);
      m.customerRef = target.ref;
      if (!m.cancelled) m.customerName = target.companyName;
    }
    const fromRefs = Array.from(new Set(before.map((m) => m.customerRef)));
    await client.query(
      `INSERT INTO customer_link_audit (actor, action, company_code, from_refs, to_ref, members, detail) VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7::jsonb)`,
      [actor ? String(actor.email || actor.id || '') : null, fromRefs.every((x) => x === null) ? 'link' : 'reassign', companyCode,
       JSON.stringify(fromRefs), target.ref, JSON.stringify(before),
       JSON.stringify({ anchor: { type: anchorType, id: anchorId }, targetName: target.companyName })]);
    await client.query('COMMIT');
    return { ...summarise(anchorType, anchorId, companyCode, target, members, []), applied: true };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally { client.release(); }
}
