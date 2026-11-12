/**
 * Owner read access (/api/v1/integration/read/*) — data loading, company rules and record views.
 *
 * SOURCE OF TRUTH. Every section is read through the platform's existing authority rule (data.loadSection: relational
 * tables when cut over, platform_state JSON otherwise, refusal when inconsistent). Both paths yield the SAME record
 * shape the dashboard renders, including older records (backfilled rows carry their original fields through
 * legacy_data). JSON-only sections (supplier bills, proposed projects) are read from platform_state.
 *
 * COMPANIES. Quotes, jobs, invoices, credit notes, purchase orders, bills and proposed projects belong to a company
 * (`co`). A record with no company tag belongs to the original company context (Signacore, code 2) — the dashboard's
 * own rule (index.html belongsToUserCompany: untagged records are shown to original-company users, never to Holdings
 * users). Such records are returned with companyTagged:false. Customers, suppliers and inventory are shared by all
 * companies in SignaCore and carry no company.
 *
 * Nothing here writes, and nothing infers an event SignaCore has no record of: no "sent at" for quotes, no delivery or
 * installation date, no goods-received date, no "paid" without payments (or SignaCore's own stored status).
 */
import { query } from '../db/pool';
import { CutoverSection } from '../relational/cutover';
import { loadSection, sectionAuthority, SectionSource, customerSummary, productRef, stockStatus } from './data';
import { IntegrationError } from './errors';
import * as m from './money';

export const COMPANY_NAMES: Record<string, string | null> = { '1': 'Signacore Holdings', '2': 'Signacore', '3': null, '4': 'Cover X Transform' };
export const STAGE_NAMES = ['Lead', 'Brief', 'Design', 'Artwork Approval', 'Quote Approved', 'Deposit Received', 'In Production', 'Installation', 'Complete', 'Invoiced'];
export const QUOTE_STATUS_LABELS: Record<string, string> = { draft: 'Draft', sent: 'Sent', approved: 'Approved', declined: 'Declined', converted: 'Job Created' };
const REL_TABLE: Partial<Record<string, string>> = {
  quotes: 'rel_quotes', jobs: 'rel_jobs', accInvoices: 'rel_invoices', creditNotes: 'rel_credit_notes', purchaseOrders: 'rel_purchase_orders',
  suppliers: 'rel_suppliers', inventory: 'rel_inventory_items', customers: 'rel_customers',
};
const JSON_ONLY = ['accBills', 'proposedProjects'] as const;
type JsonOnly = (typeof JSON_ONLY)[number];

export const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const dateOnly = (d: unknown): string | null => (d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null);
export function todaySA(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
const daysBetween = (from: string, to: string) => Math.floor((Date.parse(to) - Date.parse(from)) / 86400000);

/** The record's company: { code, tagged }. See the header for the untagged rule. */
export function companyOf(rec: any): { code: string; tagged: boolean } {
  const c = str(rec?.co);
  if (c && /^[1-9]$/.test(c)) return { code: c, tagged: true };
  return { code: '2', tagged: false };
}

export interface Loaded { items: any[]; source: SectionSource; updatedAt: Map<string, { createdAt: string | null; updatedAt: string | null }>; sectionUpdatedAt: string | null }

/** Request-scoped cache so one request reads each section once. */
export class Snapshot {
  private cache = new Map<string, Promise<Loaded>>();
  load(section: CutoverSection | JsonOnly): Promise<Loaded> {
    if (!this.cache.has(section)) this.cache.set(section, loadWithMeta(section));
    return this.cache.get(section)!;
  }
}

async function loadWithMeta(section: CutoverSection | JsonOnly): Promise<Loaded> {
  if ((JSON_ONLY as readonly string[]).includes(section)) {
    const r = await query('SELECT data -> $1 AS v, updated_at FROM platform_state WHERE id = 1', [section]);
    const v = r.rows[0]?.v;
    return { items: Array.isArray(v) ? v : [], source: 'platform_state', updatedAt: new Map(), sectionUpdatedAt: r.rows[0]?.updated_at ? new Date(r.rows[0].updated_at).toISOString() : null };
  }
  const { items, source } = await loadSection(section as CutoverSection);
  const updatedAt = new Map<string, { createdAt: string | null; updatedAt: string | null }>();
  let sectionUpdatedAt: string | null = null;
  const table = REL_TABLE[section];
  if (source === 'relational' && table) {
    const ts = await query(`SELECT id, created_at, updated_at FROM ${table}`);
    for (const row of ts.rows) {
      const u = row.updated_at ? new Date(row.updated_at).toISOString() : null;
      updatedAt.set(String(row.id), { createdAt: row.created_at ? new Date(row.created_at).toISOString() : null, updatedAt: u });
      if (u && (!sectionUpdatedAt || u > sectionUpdatedAt)) sectionUpdatedAt = u;
    }
  } else {
    const r = await query('SELECT updated_at FROM platform_state WHERE id = 1');
    sectionUpdatedAt = r.rows[0]?.updated_at ? new Date(r.rows[0].updated_at).toISOString() : null;
  }
  return { items: items.filter(Boolean), source, updatedAt, sectionUpdatedAt };
}

const stamps = (L: Loaded, rec: any) => L.updatedAt.get(String(rec?._relId)) || { createdAt: null, updatedAt: null };

/** Resolve the companies a request may see. A requested company outside the client's grant is refused, never widened. */
export function authorisedCompanies(granted: string[], requested: unknown): string[] {
  if (requested === undefined || requested === null || requested === '') return [...granted];
  const want = String(requested).split(',').map((s) => s.trim()).filter(Boolean);
  if (!want.length || want.some((c) => !/^[1-9]$/.test(c))) throw new IntegrationError(400, 'VALIDATION_ERROR', '"company" must be one or more company codes, e.g. 1,2.');
  const denied = want.filter((c) => !granted.includes(c));
  if (denied.length) throw new IntegrationError(403, 'COMPANY_NOT_AUTHORISED', 'This integration client may not read that company.', { companies: denied });
  return [...new Set(want)];
}

// ── payments ───────────────────────────────────────────────────────────────
function paymentView(p: any, ownerType: string, owner: { id: string; number: string | null; company: string }) {
  const method = str(p.method);
  return {
    id: str(p.id), relId: p._relPaymentId != null ? Number(p._relPaymentId) : null,
    amount: m.rands(m.sgrToCents0(p.amount)), date: dateOnly(p.date), method, reference: str(p.reference),
    isCreditAllocation: String(method || '').trim().toLowerCase().startsWith('credit'),
    owner: { type: p._relOwnerType || ownerType, id: owner.id, number: owner.number }, companyCode: owner.company,
  };
}
/** A payment counted once even when it appears on several chain members (rel id, else owner + position). */
function uniquePayments(lists: Array<{ list: any[]; kind: string }>): Array<{ p: any; kind: string }> {
  const seen = new Set<string>();
  const out: Array<{ p: any; kind: string }> = [];
  for (const { list, kind } of lists) {
    (Array.isArray(list) ? list : []).forEach((p, i) => {
      if (!p) return;
      const k = p._relPaymentId != null ? `rel:${p._relPaymentId}` : `${kind}:${p.id ?? i}:${p.amount}:${p.date}`;
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ p, kind: p._relOwnerType || kind });
    });
  }
  return out;
}
const lastPaid = (ps: any[]) => ps.filter((p) => m.sgrToCents0(p.amount) > 0).map((p) => dateOnly(p.date)).filter(Boolean).sort().at(-1) || null;

// ── link resolution (company-safe, exactly like index.html: id first, then a unique same-company number) ──
export interface Links {
  quoteById: Map<string, any>; jobById: Map<string, any>; jobByNum: Map<string, any>;
  invoiceByRelId: Map<string, any>; relInvoiceLinks: Map<string, { jobSourceId: string | null; quoteSourceId: string | null }>;
}
export async function buildLinks(snap: Snapshot): Promise<{ links: Links; quotes: Loaded; jobs: Loaded; invoices: Loaded }> {
  const [quotes, jobs, invoices] = await Promise.all([snap.load('quotes'), snap.load('jobs'), snap.load('accInvoices')]);
  const links: Links = { quoteById: new Map(), jobById: new Map(), jobByNum: new Map(), invoiceByRelId: new Map(), relInvoiceLinks: new Map() };
  for (const q of quotes.items) links.quoteById.set(String(q.id), q);
  for (const j of jobs.items) { links.jobById.set(String(j.id), j); if (j.num) links.jobByNum.set(String(j.num).toUpperCase(), j); }
  for (const i of invoices.items) if (i._relId != null) links.invoiceByRelId.set(String(i._relId), i);
  if (invoices.source === 'relational') {
    const r = await query(`SELECT i.id, j.source_id AS job_sid, q.source_id AS quote_sid
                             FROM rel_invoices i LEFT JOIN rel_jobs j ON j.id = i.job_id AND j.company_code = i.company_code
                             LEFT JOIN rel_quotes q ON q.id = i.quote_id AND q.company_code = i.company_code`);
    for (const row of r.rows) links.relInvoiceLinks.set(String(row.id), { jobSourceId: str(row.job_sid), quoteSourceId: str(row.quote_sid) });
  }
  return { links, quotes, jobs, invoices };
}
function uniqueSameCompany(list: any[], co: string, num: unknown, numField: string): any | null {
  const n = str(num);
  if (!n) return null;
  const hits = list.filter((x) => companyOf(x).code === co && String(x[numField] || '').toUpperCase() === n.toUpperCase());
  return hits.length === 1 ? hits[0] : null;
}
export function quoteForJob(j: any, quotes: any[]): any | null {
  const co = companyOf(j).code;
  const byId = quotes.find((q) => q.convertedJobId != null && String(q.convertedJobId) === String(j.id));
  if (byId) return companyOf(byId).code === co ? byId : null;
  return uniqueSameCompany(quotes, co, j.quoteNum, 'num');
}
export function invoiceForJob(j: any, invoices: any[], links: Links): any | null {
  const live = invoices.filter((i) => i.status !== 'void');
  const co = companyOf(j).code;
  const byJobNum = live.filter((i) => j.num && (String(i.jobNum || '').toUpperCase() === String(j.num).toUpperCase() || String(i.reference || '').toUpperCase() === String(j.num).toUpperCase()));
  if (byJobNum.length === 1 && companyOf(byJobNum[0]).code === co) return byJobNum[0];
  if (!j.invoiceNum || j.invoiceLinkState === 'ambiguous') return null;
  if (j.invoiceRelId != null) {
    const r = links.invoiceByRelId.get(String(j.invoiceRelId));
    if (r && r.status !== 'void' && companyOf(r).code === co) return r;
  }
  return uniqueSameCompany(live, co, j.invoiceNum, 'number');
}

// ── views ──────────────────────────────────────────────────────────────────
export function quoteView(q: any, L: Loaded, ctx: { jobs: any[]; invoices: any[] }, detail: boolean) {
  const c = companyOf(q);
  const t = m.documentCents(q.lines, q.discount, q.setupFee);
  const status = q.status || 'draft';
  const job = q.convertedJobId != null ? ctx.jobs.find((j) => String(j.id) === String(q.convertedJobId) && companyOf(j).code === c.code) : null;
  const invs = ctx.invoices.filter((i) => companyOf(i).code === c.code && i.quoteNum && q.num && String(i.quoteNum).toUpperCase() === String(q.num).toUpperCase());
  const dep = m.depositInfo(q, m.rands(t.totalC));
  const paidC = m.paidCents(q.payments);
  return {
    id: String(q.id), relId: q._relId ?? null, number: q.num ?? null, companyCode: c.code, companyTagged: c.tagged,
    status, statusLabel: QUOTE_STATUS_LABELS[status] || status,
    customer: { name: str(q.client), contactPerson: str(q.contact), email: str(q.email), phone: str(q.tel) },
    reference: str(q.reference), poRef: str(q.poRef), salesperson: str(q.salesperson), preparedBy: str(q.preparedBy),
    quoteDate: dateOnly(q.date), validUntil: dateOnly(q.validUntil),
    sentAt: null, // SignaCore records the status 'sent' but not when it was sent
    totals: { subtotalExVat: m.rands(t.subC), discountPct: Number(q.discount) || 0, discount: m.rands(t.discC), setupFee: m.rands(t.setupC), vat: m.rands(t.vatC), totalInclVat: m.rands(t.totalC), currency: 'ZAR' },
    deposit: { pct: dep.pct, isCustom: dep.isCustom, amount: m.rands(dep.depositCents) },
    paymentsOnQuote: { count: (q.payments || []).length, paid: m.rands(paidC), lastPaymentDate: lastPaid(q.payments || []) },
    proformaNumber: str(q.proformaNum),
    links: { jobId: q.convertedJobId != null ? String(q.convertedJobId) : null, jobNumber: job?.num ?? null, invoiceNumbers: invs.map((i) => i.number) },
    ...stamps(L, q),
    ...(detail ? { lines: (q.lines || []).map((l: any, i: number) => ({ index: i, description: str(l.desc), qty: Number(l.qty) || 0, pieces: l.pQty ?? null, unit: str(l.unit), unitPriceExVat: Number(l.unitPrice) || 0, lineTotalExVat: m.rands(m.docLineCents(l)), productRef: l.itemId != null ? productRef('inventory', l.itemId) : null })), notes: str(q.notes) } : {}),
  };
}

export function jobView(j: any, L: Loaded, ctx: { quotes: any[]; invoices: any[]; links: Links }, detail: boolean) {
  const c = companyOf(j);
  const quote = quoteForJob(j, ctx.quotes);
  const inv = invoiceForJob(j, ctx.invoices, ctx.links);
  const pay = uniquePayments([{ list: j.payments, kind: 'job' }, { list: quote?.payments || [], kind: 'quote' }, { list: inv?.payments || [], kind: 'invoice' }]);
  const payableC = inv ? m.invoiceCents(inv.lineItems).totalC : m.sgrToCents0(j.value);
  const paidC = m.paidCents(pay.map((x) => x.p));
  const stage = Number.isInteger(Number(j.stage)) ? Number(j.stage) : null;
  const today = todaySA();
  const due = dateOnly(j.dueDate);
  const closed = (stage !== null && stage >= 8) || ['completed', 'invoiced'].includes(String(j.status || ''));
  const dep = m.depositInfo(quote || {}, j.value);
  return {
    id: String(j.id), relId: j._relId ?? null, number: j.num ?? null, companyCode: c.code, companyTagged: c.tagged,
    status: str(j.status), stage, stageName: stage !== null ? STAGE_NAMES[stage] || null : null,
    customer: { name: str(j.client), contactPerson: str(j.contact), email: str(j.email), phone: str(j.tel) },
    description: str(j.desc), valueInclVat: m.rands(m.sgrToCents0(j.value)),
    dueDate: due, pastDueDate: Boolean(due && due < today && !closed), daysPastDue: due && due < today && !closed ? daysBetween(due, today) : 0,
    installationDate: null, deliveredAt: null, // not recorded by SignaCore (stages only)
    writeOff: str(j.writeOff), depositWaived: j.depositWaived === true,
    deposit: { pct: dep.pct, required: m.rands(dep.depositCents), received: m.rands(paidC), met: paidC >= dep.depositCents || j.depositWaived === true },
    links: {
      quoteId: quote ? String(quote.id) : null, quoteNumber: str(j.quoteNum), quoteResolved: Boolean(quote),
      invoiceNumber: str(j.invoiceNum), invoiceId: inv ? String(inv.id) : null, invoiceLinkState: str(j.invoiceLinkState) || (j.invoiceNum ? (inv ? 'matched' : 'orphaned') : 'none'),
      invoiceDate: dateOnly(j.invoiceDate), invoiceDue: dateOnly(j.invoiceDue),
    },
    settlement: {
      payableInclVat: m.rands(payableC), payableFrom: inv ? 'invoice' : 'job_value', paid: m.rands(paidC),
      outstanding: m.rands(m.outstandingCents(inv || j, payableC, paidC)), storedStatus: str(j.invoiceStatus),
      lastPaymentDate: lastPaid(pay.map((x) => x.p)),
    },
    poRef: str(j.poRef), reference: str(j.reference), salesperson: str(j.salesperson),
    ...stamps(L, j),
    ...(detail ? { payments: pay.map((x) => paymentView(x.p, x.kind, { id: String(j.id), number: j.num ?? null, company: c.code })), notes: str(j.notes) } : {}),
  };
}

/** Accounting's invoice list = invoice records + job invoices with no accounting record (index.html allInvoices). */
export function invoiceRows(invoices: any[], jobs: any[], quotes: any[], links: Links): Array<{ kind: 'record' | 'job'; rec: any }> {
  const rows: Array<{ kind: 'record' | 'job'; rec: any }> = invoices.map((rec) => ({ kind: 'record' as const, rec }));
  const live = invoices.filter((i) => i.status !== 'void');
  const refs = new Set<string>();
  for (const i of live) { if (i.reference) refs.add(String(i.reference).toUpperCase()); if (i.jobNum) refs.add(String(i.jobNum).toUpperCase()); }
  for (const j of jobs) {
    if (!j.invoiceNum || !j.num) continue;
    if (refs.has(String(j.num).toUpperCase()) || invoiceForJob(j, invoices, links)) continue;
    rows.push({ kind: 'job', rec: j });
  }
  void quotes;
  return rows;
}

export function invoiceView(row: { kind: 'record' | 'job'; rec: any }, L: { invoices: Loaded; jobs: Loaded }, ctx: { quotes: any[]; links: Links; jobs: any[] }, detail: boolean) {
  const today = todaySA();
  if (row.kind === 'job') {
    const j = row.rec;
    const c = companyOf(j);
    const quote = quoteForJob(j, ctx.quotes);
    const pay = uniquePayments([{ list: j.payments, kind: 'job' }, { list: quote?.payments || [], kind: 'quote' }]);
    const totalC = m.sgrToCents0(j.value);
    const paidC = m.paidCents(pay.map((x) => x.p));
    const issue = dateOnly(j.invoiceDate);
    const due = dateOnly(j.invoiceDue) || (issue ? new Date(Date.parse(issue) + 30 * 86400000).toISOString().slice(0, 10) : null);
    const stored = String(j.invoiceStatus || '');
    const status = stored === 'paid' ? 'paid' : stored === 'partial' ? 'partial' : due && due < today ? 'overdue' : 'sent';
    const outstandingC = m.outstandingCents(j, totalC, paidC);
    return {
      id: `job-${j.id}`, relId: null, number: j.invoiceNum, companyCode: c.code, companyTagged: c.tagged, source: 'job',
      sourceNote: 'Job invoice without a separate accounting record (shown in SignaCore Accounting as a job invoice).',
      status, isVoid: false, contact: { name: str(j.client), email: str(j.email) },
      links: { jobId: String(j.id), jobNumber: j.num, quoteId: quote ? String(quote.id) : null, quoteNumber: str(j.quoteNum) },
      reference: str(j.num), issueDate: issue, dueDate: due,
      totals: { totalInclVat: m.rands(totalC), from: 'job_value' }, paid: m.rands(paidC), outstanding: m.rands(outstandingC),
      overdue: status !== 'paid' && outstandingC > 0 && Boolean(due && due < today), daysPastDue: due && due < today && outstandingC > 0 ? daysBetween(due, today) : 0,
      lastPaymentDate: lastPaid(pay.map((x) => x.p)), legacyRoundingSettlement: m.legacySettled(j, totalC, paidC),
      ...stamps(L.jobs, j),
      ...(detail ? { payments: pay.map((x) => paymentView(x.p, x.kind, { id: String(j.id), number: j.num, company: c.code })) } : {}),
    };
  }
  const i = row.rec;
  const c = companyOf(i);
  const t = m.invoiceCents(i.lineItems);
  const paidC = m.paidCents(i.payments);
  const outstandingC = m.outstandingCents(i, t.totalC, paidC);
  let status = str(i.status) || 'draft';
  // index.html allInvoices: an issued invoice with a genuine R0.00 total and nothing due is shown as paid.
  if (status !== 'draft' && status !== 'void' && Array.isArray(i.lineItems) && t.totalC <= 0 && m.settlementStatus(t.totalC, paidC) === 'paid') status = 'paid';
  if (m.legacySettled(i, t.totalC, paidC)) status = 'paid';
  const due = dateOnly(i.dueDate);
  const rl = i._relId != null ? ctx.links.relInvoiceLinks.get(String(i._relId)) : undefined;
  const job = rl?.jobSourceId ? ctx.links.jobById.get(rl.jobSourceId) : (i.jobNum ? ctx.links.jobByNum.get(String(i.jobNum).toUpperCase()) : null);
  const jobOk = job && companyOf(job).code === c.code ? job : null;
  const quote = rl?.quoteSourceId ? ctx.links.quoteById.get(rl.quoteSourceId) : uniqueSameCompany(ctx.quotes, c.code, i.quoteNum, 'num');
  const quoteOk = quote && companyOf(quote).code === c.code ? quote : null;
  const open = !['paid', 'void', 'draft'].includes(status) && outstandingC > 0;
  return {
    id: String(i.id), relId: i._relId ?? null, number: i.number ?? null, companyCode: c.code, companyTagged: c.tagged, source: 'record',
    status, isVoid: status === 'void', contact: { name: str(i.contactName), email: str(i.contactEmail) },
    links: { jobId: jobOk ? String(jobOk.id) : null, jobNumber: str(i.jobNum) || (jobOk?.num ?? null), quoteId: quoteOk ? String(quoteOk.id) : null, quoteNumber: str(i.quoteNum) || (quoteOk?.num ?? null) },
    reference: str(i.reference), issueDate: dateOnly(i.date || i.issueDate), dueDate: due,
    totals: { subtotalExVat: m.rands(t.subC), vat: m.rands(t.vatC), totalInclVat: m.rands(t.totalC), from: 'invoice_lines' },
    paid: m.rands(paidC), outstanding: m.rands(status === 'void' ? 0 : outstandingC),
    overdue: open && Boolean(due && due < today), daysPastDue: open && due && due < today ? daysBetween(due, today) : 0,
    lastPaymentDate: lastPaid(i.payments || []), legacyRoundingSettlement: m.legacySettled(i, t.totalC, paidC),
    ...stamps(L.invoices, i),
    ...(detail ? {
      lines: (i.lineItems || []).map((l: any, k: number) => ({ index: k, description: str(l.description), qty: Number(l.qty ?? 1), unitAmountExVat: Number(l.unitAmount) || 0, taxType: str(l.taxType), accountCode: str(l.accountCode) })),
      // A relational invoice carries its whole chain's payments; attribute each to the record it was actually made on.
      payments: uniquePayments([{ list: i.payments, kind: 'invoice' }]).map((x) => paymentView(x.p, x.kind,
        x.kind === 'job' && jobOk ? { id: String(jobOk.id), number: jobOk.num ?? null, company: c.code }
          : x.kind === 'quote' && quoteOk ? { id: String(quoteOk.id), number: quoteOk.num ?? null, company: c.code }
            : { id: String(i.id), number: i.number ?? null, company: c.code })),
    } : {}),
  };
}

export function creditNoteView(cn: any, L: Loaded) {
  const c = companyOf(cn);
  const amountC = m.sgrToCents0(cn.amount);
  const usedC = m.sgrToCents0(cn.used);
  return {
    id: String(cn.id), relId: cn._relId ?? null, number: str(cn.number), companyCode: c.code, companyTagged: c.tagged, type: str(cn.type),
    contactName: str(cn.contactName), date: dateOnly(cn.date), amount: m.rands(amountC), used: m.rands(usedC), remaining: m.rands(Math.max(0, amountC - usedC)),
    reason: str(cn.reason), appliedTo: str(cn.appliedTo), status: str(cn.status), ...stamps(L, cn),
  };
}

export function billView(b: any) {
  const c = companyOf(b);
  const totalC = m.invoiceCents(b.lineItems).totalC;
  const hasPayments = Array.isArray(b.payments) && b.payments.length > 0;
  // index.html buildStatement: a bill marked paid without payment lines counts as paid in full on its paid date.
  const paidC = hasPayments ? m.paidCents(b.payments) : b.status === 'paid' ? totalC : 0;
  const due = dateOnly(b.dueDate);
  const status = str(b.status) || 'draft';
  const outstandingC = status === 'void' ? 0 : Math.max(0, totalC - paidC);
  return {
    id: String(b.id), number: str(b.number), companyCode: c.code, companyTagged: c.tagged, status,
    supplierName: str(b.supplierName), supplierRef: str(b.supplierRef), poNumber: str(b.poNumber),
    date: dateOnly(b.date), dueDate: due, paidDate: dateOnly(b.paidDate), totalInclVat: m.rands(totalC), paid: m.rands(paidC), outstanding: m.rands(outstandingC),
    paidFrom: hasPayments ? 'payments' : b.status === 'paid' ? 'status_paid' : 'none',
    overdue: outstandingC > 0 && !['draft', 'void'].includes(status) && Boolean(due && due < todaySA()),
    createdAt: null, updatedAt: null,
  };
}

export function supplierView(s: any, L: Loaded) {
  return {
    id: String(s.id), relId: s._relId ?? null, name: str(s.name), contactPerson: str(s.contactPerson), phone: str(s.phone), email: str(s.email),
    city: str(s.city), vatNumber: str(s.vatNumber), paymentTerms: str(s.paymentTerms), ...stamps(L, s),
  };
}

export function purchaseOrderView(po: any, L: Loaded, suppliers: any[], detail: boolean) {
  const c = companyOf(po);
  const sup = suppliers.find((s) => String(s.id) === String(po.supplierId)) || null;
  const items = (po.items || []).map((l: any, i: number) => {
    const qty = Number(l.qtyOrdered ?? l.qty ?? 0) || 0;
    const unitCost = Number(l.unitCost ?? l.cost ?? 0) || 0;
    return { index: i, sku: str(l.sku), name: str(l.name), unit: str(l.unit), qtyNeeded: Number(l.qtyNeeded) || 0, qtyOrdered: qty, unitCostExVat: unitCost,
      lineTotalExVat: m.rands(m.sgrToCents0(qty * unitCost)), inventoryRef: l.inventoryId != null ? productRef('inventory', l.inventoryId) : null };
  });
  return {
    id: String(po.id), relId: po._relId ?? null, number: str(po.num), companyCode: c.code, companyTagged: c.tagged, status: str(po.status) || 'draft',
    supplier: { id: po.supplierId != null ? String(po.supplierId) : null, name: sup ? str(sup.name) : str(po.supplierName) },
    orderDate: dateOnly(po.date), jobNumber: str(po.jobNum), quoteNumber: str(po.quoteNum),
    totalExVat: m.rands(items.reduce((s: number, it: any) => s + m.sgrToCents0(it.lineTotalExVat), 0)),
    receivedAt: null, expectedArrival: null, // SignaCore records neither goods receipt nor an expected arrival date
    ...stamps(L, po), ...(detail ? { items, notes: str(po.notes) } : { itemCount: items.length }),
  };
}

export function inventoryView(it: any, L: Loaded, opts: { cost: boolean; pricing: boolean }) {
  return {
    ref: productRef('inventory', it.id), id: String(it.id), sku: str(it.sku), name: str(it.name), category: str(it.cat ?? it.category), unit: str(it.unit),
    stockOnHand: Number(it.stock) || 0, reorderLevel: Number(it.reorder) || 0, stockStatus: stockStatus('inventory', it), active: it.active !== false,
    reservedQty: null, availableToPromise: null, // not modelled in SignaCore
    supplierId: it.supplierId != null ? String(it.supplierId) : null,
    ...(opts.cost ? { costExVat: Number(it.cost) || 0 } : {}), ...(opts.pricing ? { sellExVat: Number(it.sell) || 0 } : {}),
    ...stamps(L, it),
  };
}

export { customerSummary, sectionAuthority };
