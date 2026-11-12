/**
 * /api/v1/integration/read/* — owner read access (CORE-AGENTS). GET only; nothing here writes.
 *
 * Every route: an authenticated integration client (auth.ts), the route's read scope, and company authorisation.
 *  - Lists only ever contain records of companies the client may read (ctx.readCompanies). A `company` filter naming a
 *    company outside that grant is refused with 403 COMPANY_NOT_AUTHORISED — it never widens access.
 *  - A single record outside the grant answers 404, exactly like a record that does not exist.
 *  - Shared master data (customers, suppliers, inventory) has no company in SignaCore and is readable with its scope.
 * Pagination: ?page=1&limit=50 (max 200). Each response says where the data came from (relational | platform_state)
 * and when that section last changed, so a consumer can tell fresh data from stale.
 */
import { query } from '../db/pool';
import { Router, Response, NextFunction } from 'express';
import { requireScope, hasScope, IntegrationRequest } from './auth';
import { IntegrationError, bad } from './errors';
import { Scope } from './scopes';
import * as d from './readData';
import { rands, sgrToCents0 } from './money';

type Handler = (req: IntegrationRequest, res: Response) => Promise<void>;
type Op = (name: string, fn: Handler) => (req: IntegrationRequest, res: Response, next: NextFunction) => Promise<void>;

const READ_SCOPES: Scope[] = ['sales:read', 'jobs:read', 'accounts:read', 'purchasing:read'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function anyReadScope(req: IntegrationRequest, res: Response, next: NextFunction): void {
  const have = req.integration?.scopes || [];
  if (!READ_SCOPES.some((s) => have.includes(s))) {
    res.status(403).json({ error: { code: 'FORBIDDEN_SCOPE', message: 'This integration client is not permitted to do that.', details: { missing: READ_SCOPES } } });
    return;
  }
  next();
}

interface ListOpts { page: number; limit: number; q: string | null; status: string[] | null; from: string | null; to: string | null; updatedSince: string | null }
function listOpts(req: IntegrationRequest): ListOpts {
  const qp = req.query as Record<string, unknown>;
  const page = qp.page === undefined ? 1 : Number(qp.page);
  const limit = qp.limit === undefined ? 50 : Number(qp.limit);
  if (!Number.isInteger(page) || page < 1 || page > 10000) throw bad('"page" must be a whole number from 1.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw bad('"limit" must be a whole number from 1 to 200.');
  const q = qp.q ? String(qp.q).trim().slice(0, 100).toLowerCase() : null;
  const status = qp.status ? String(qp.status).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 10) : null;
  for (const k of ['from', 'to'] as const) if (qp[k] !== undefined && !DATE_RE.test(String(qp[k]))) throw bad(`"${k}" must be a date (YYYY-MM-DD).`);
  const updatedSince = qp.updatedSince ? String(qp.updatedSince) : null;
  if (updatedSince && Number.isNaN(Date.parse(updatedSince))) throw bad('"updatedSince" must be an ISO date/time.');
  return { page, limit, q, status, from: qp.from ? String(qp.from) : null, to: qp.to ? String(qp.to) : null, updatedSince };
}

const matchQ = (q: string | null, ...vals: unknown[]) => !q || vals.some((v) => v !== null && v !== undefined && String(v).toLowerCase().includes(q));
const inRange = (date: string | null, o: ListOpts) => (!o.from || (date !== null && date >= o.from)) && (!o.to || (date !== null && date <= o.to));

/** updatedSince only works where SignaCore stores a timestamp (relational sections); say so instead of guessing. */
function sinceFilter<T extends { updatedAt?: string | null }>(rows: T[], o: ListOpts, notes: string[]): T[] {
  if (!o.updatedSince) return rows;
  const withTs = rows.filter((r) => r.updatedAt);
  if (rows.length && withTs.length === 0) { notes.push('updatedSince was not applied: this section has no per-record timestamps (platform_state).'); return rows; }
  const t = new Date(o.updatedSince).toISOString();
  return rows.filter((r) => !r.updatedAt || r.updatedAt >= t);
}

function page<T>(res: Response, rows: T[], o: ListOpts, meta: Record<string, unknown>, notes: string[] = []) {
  const start = (o.page - 1) * o.limit;
  res.json({
    results: rows.slice(start, start + o.limit), page: o.page, limit: o.limit, total: rows.length, hasMore: start + o.limit < rows.length,
    ...meta, ...(notes.length ? { notes } : {}), asOf: new Date().toISOString(),
  });
}
const meta = (...loaded: Array<[string, d.Loaded]>) => ({
  dataSource: Object.fromEntries(loaded.map(([k, l]) => [k, l.source])),
  sectionUpdatedAt: Object.fromEntries(loaded.map(([k, l]) => [k, l.sectionUpdatedAt])),
});
const byNewest = (dateKey: string, numKey: string) => (a: any, b: any) =>
  String(b[dateKey] || '').localeCompare(String(a[dateKey] || '')) || String(b[numKey] || '').localeCompare(String(a[numKey] || ''));

/** Find one record by SignaCore id or document number among the records this client may see. */
function findOne<T extends { id: string; companyCode?: string }>(rows: T[], ref: string, numKey: keyof T, company: string[] | null): T {
  const want = ref.toUpperCase();
  const hits = rows.filter((r) => (String(r.id) === ref || String(r[numKey] ?? '').toUpperCase() === want) && (!company || !r.companyCode || company.includes(r.companyCode)));
  if (hits.length === 0) throw new IntegrationError(404, 'NOT_FOUND', 'Record not found.');
  if (hits.length > 1) throw new IntegrationError(409, 'AMBIGUOUS_REFERENCE', 'That number exists in more than one company. Add ?company=<code>.', { companies: [...new Set(hits.map((h) => h.companyCode))] });
  return hits[0];
}
const REF_RE = /^[A-Za-z0-9._-]{1,60}$/;

export function readRoutes(op: Op): Router {
  const r = Router();
  r.use((req: IntegrationRequest, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.locals.operation = 'read.write_refused';
      res.status(405).json({ error: { code: 'READ_ONLY_ENDPOINT', message: 'The read API only accepts GET requests.' } });
      return;
    }
    next();
  });

  r.get('/companies', anyReadScope, op('read.companies', async (req, res) => {
    const ctx = req.integration!;
    res.json({ results: ctx.readCompanies.map((code) => ({ code, name: d.COMPANY_NAMES[code] ?? null })), readOnly: ctx.readOnly, asOf: new Date().toISOString() });
  }));

  r.get('/sections', anyReadScope, op('read.sections', async (_req, res) => {
    const snap = new d.Snapshot();
    const out: Record<string, unknown> = {};
    for (const s of ['customers', 'suppliers', 'inventory', 'quotes', 'jobs', 'accInvoices', 'creditNotes', 'purchaseOrders', 'accBills', 'proposedProjects'] as const) {
      try {
        const l = await snap.load(s);
        out[s] = { source: l.source, records: l.items.length, sectionUpdatedAt: l.sectionUpdatedAt };
      } catch (err) {
        out[s] = { source: 'unavailable', error: err instanceof IntegrationError ? err.code : 'ERROR' };
      }
    }
    res.json({ sections: out, asOf: new Date().toISOString() });
  }));

  // ── SALES ────────────────────────────────────────────────────────────────
  r.get('/customers', requireScope('customer:read'), op('read.customers', async (req, res) => {
    const o = listOpts(req);
    const L = await new d.Snapshot().load('customers');
    const rows = L.items.map((c) => ({ ...d.customerSummary(c), ...(L.updatedAt.get(String(c._relId)) || { createdAt: null, updatedAt: null }) }))
      .filter((c: any) => matchQ(o.q, c.companyName, c.contactPerson, c.email, c.phone));
    const notes: string[] = [];
    page(res, sinceFilter(rows, o, notes), o, meta(['customers', L]), notes);
  }));

  async function quoteRows(req: IntegrationRequest, companies: string[]) {
    const snap = new d.Snapshot();
    const [Q, J, I] = await Promise.all([snap.load('quotes'), snap.load('jobs'), snap.load('accInvoices')]);
    const rows = Q.items.filter((q) => companies.includes(d.companyOf(q).code));
    return { Q, J, I, rows, ctx: { jobs: J.items, invoices: I.items } };
  }
  r.get('/quotes', requireScope('sales:read'), op('read.quotes', async (req, res) => {
    const o = listOpts(req);
    const companies = d.authorisedCompanies(req.integration!.readCompanies, req.query.company);
    const { Q, J, I, rows, ctx } = await quoteRows(req, companies);
    const notes: string[] = [];
    const views = rows.map((q) => d.quoteView(q, Q, ctx, false))
      .filter((v) => (!o.status || o.status.includes(v.status)) && inRange(v.quoteDate, o) && matchQ(o.q, v.number, v.customer.name, v.reference, v.poRef))
      .sort(byNewest('quoteDate', 'number'));
    page(res, sinceFilter(views, o, notes), o, meta(['quotes', Q], ['jobs', J], ['accInvoices', I]), notes);
  }));
  r.get('/quotes/:ref', requireScope('sales:read'), op('read.quote', async (req, res) => {
    const ref = String(req.params.ref);
    if (!REF_RE.test(ref)) throw bad('Invalid reference.');
    res.locals.targetType = 'quote'; res.locals.targetId = ref;
    const companies = d.authorisedCompanies(req.integration!.readCompanies, req.query.company);
    const { Q, J, I, rows, ctx } = await quoteRows(req, companies);
    const hit = findOne(rows.map((q) => ({ id: String(q.id), number: q.num, companyCode: d.companyOf(q).code, q })), ref, 'number', companies);
    res.json({ quote: d.quoteView(hit.q, Q, ctx, true), ...meta(['quotes', Q], ['jobs', J], ['accInvoices', I]), asOf: new Date().toISOString() });
  }));
  r.get('/enquiries', requireScope('sales:read'), op('read.enquiries', async (req, res) => {
    const o = listOpts(req);
    const companies = d.authorisedCompanies(req.integration!.readCompanies, req.query.company);
    const snap = new d.Snapshot();
    const [P, J] = await Promise.all([snap.load('proposedProjects'), snap.load('jobs')]);
    const proposals = P.items.filter((p) => companies.includes(d.companyOf(p).code)).map((p) => {
      const c = d.companyOf(p);
      return { kind: 'proposed_project', id: String(p.id), title: d.str(p.name), note: d.str(p.note), companyCode: c.code, companyTagged: c.tagged, stage: null, createdAt: null, updatedAt: null };
    });
    const leads = J.items.filter((j) => companies.includes(d.companyOf(j).code) && [0, 1].includes(Number(j.stage)) && !['completed', 'invoiced'].includes(String(j.status || ''))).map((j) => {
      const c = d.companyOf(j);
      return { kind: 'job_lead', id: String(j.id), title: d.str(j.desc) || d.str(j.client), note: null, jobNumber: j.num, customer: d.str(j.client), companyCode: c.code, companyTagged: c.tagged,
        stage: d.STAGE_NAMES[Number(j.stage)], ...(J.updatedAt.get(String(j._relId)) || { createdAt: null, updatedAt: null }) };
    });
    const rows = [...proposals, ...leads].filter((x: any) => matchQ(o.q, x.title, x.customer, x.jobNumber));
    page(res, rows, o, meta(['proposedProjects', P], ['jobs', J]), ['Enquiries captured in Sally or the mailboxes are not SignaCore records; read them from those systems.']);
  }));

  // ── JOBS ─────────────────────────────────────────────────────────────────
  async function jobContext(companies: string[]) {
    const snap = new d.Snapshot();
    const { links, quotes, jobs, invoices } = await d.buildLinks(snap);
    return { snap, links, Q: quotes, J: jobs, I: invoices, rows: jobs.items.filter((j) => companies.includes(d.companyOf(j).code)) };
  }
  r.get('/jobs', requireScope('jobs:read'), op('read.jobs', async (req, res) => {
    const o = listOpts(req);
    const companies = d.authorisedCompanies(req.integration!.readCompanies, req.query.company);
    const stage = req.query.stage !== undefined ? String(req.query.stage).split(',').map(Number) : null;
    if (stage && stage.some((s) => !Number.isInteger(s) || s < 0 || s > 9)) throw bad('"stage" must be stage numbers 0–9.');
    const { links, Q, J, I, rows } = await jobContext(companies);
    const notes: string[] = [];
    const views = rows.map((j) => d.jobView(j, J, { quotes: Q.items, invoices: I.items, links }, false))
      .filter((v) => (!o.status || o.status.includes(String(v.status || '').toLowerCase())) && (!stage || (v.stage !== null && stage.includes(v.stage)))
        && (req.query.pastDue !== 'true' || v.pastDueDate) && (!o.from || (v.dueDate && v.dueDate >= o.from)) && (!o.to || (v.dueDate && v.dueDate <= o.to))
        && matchQ(o.q, v.number, v.customer.name, v.description, v.poRef, v.links.quoteNumber, v.links.invoiceNumber))
      .sort(byNewest('dueDate', 'number'));
    page(res, sinceFilter(views, o, notes), o, meta(['jobs', J], ['quotes', Q], ['accInvoices', I]), notes);
  }));
  r.get('/jobs/:ref', requireScope('jobs:read'), op('read.job', async (req, res) => {
    const ref = String(req.params.ref);
    if (!REF_RE.test(ref)) throw bad('Invalid reference.');
    res.locals.targetType = 'job'; res.locals.targetId = ref;
    const companies = d.authorisedCompanies(req.integration!.readCompanies, req.query.company);
    const { links, Q, J, I, rows } = await jobContext(companies);
    const hit = findOne(rows.map((j) => ({ id: String(j.id), number: j.num, companyCode: d.companyOf(j).code, j })), ref, 'number', companies);
    res.json({ job: d.jobView(hit.j, J, { quotes: Q.items, invoices: I.items, links }, true), ...meta(['jobs', J], ['quotes', Q], ['accInvoices', I]), asOf: new Date().toISOString() });
  }));

  // ── ACCOUNTS ─────────────────────────────────────────────────────────────
  async function invoiceContext(companies: string[]) {
    const c = await jobContext([]); // links are resolved over every record; only the invoice rows are company-filtered
    const rows = d.invoiceRows(c.I.items, c.J.items, c.Q.items, c.links).filter((x) => companies.includes(d.companyOf(x.rec).code));
    const view = (x: { kind: 'record' | 'job'; rec: any }, detail: boolean) => d.invoiceView(x, { invoices: c.I, jobs: c.J }, { quotes: c.Q.items, links: c.links, jobs: c.J.items }, detail);
    return { ...c, rows, view };
  }
  r.get('/invoices', requireScope('accounts:read'), op('read.invoices', async (req, res) => {
    const o = listOpts(req);
    const companies = d.authorisedCompanies(req.integration!.readCompanies, req.query.company);
    const c = await invoiceContext(companies);
    const notes: string[] = [];
    const views = c.rows.map((x) => c.view(x, false))
      .filter((v) => (!o.status || o.status.includes(String(v.status))) && (req.query.overdue !== 'true' || v.overdue) && (req.query.outstanding !== 'true' || v.outstanding > 0)
        && (req.query.includeVoid === 'true' || !v.isVoid || (o.status || []).includes('void')) && inRange(v.issueDate, o) && matchQ(o.q, v.number, v.contact.name, v.reference, v.links.jobNumber, v.links.quoteNumber))
      .sort(byNewest('issueDate', 'number'));
    page(res, sinceFilter(views, o, notes), o, meta(['accInvoices', c.I], ['jobs', c.J], ['quotes', c.Q]), notes);
  }));
  r.get('/invoices/:ref', requireScope('accounts:read'), op('read.invoice', async (req, res) => {
    const ref = String(req.params.ref);
    if (!REF_RE.test(ref)) throw bad('Invalid reference.');
    res.locals.targetType = 'invoice'; res.locals.targetId = ref;
    const companies = d.authorisedCompanies(req.integration!.readCompanies, req.query.company);
    const c = await invoiceContext(companies);
    const hit = findOne(c.rows.map((x) => ({ id: x.kind === 'job' ? `job-${x.rec.id}` : String(x.rec.id), number: x.kind === 'job' ? x.rec.invoiceNum : x.rec.number, companyCode: d.companyOf(x.rec).code, x })), ref, 'number', companies);
    res.json({ invoice: c.view(hit.x, true), ...meta(['accInvoices', c.I], ['jobs', c.J], ['quotes', c.Q]), asOf: new Date().toISOString() });
  }));
  r.get('/payments', requireScope('accounts:read'), op('read.payments', async (req, res) => {
    const o = listOpts(req);
    const companies = d.authorisedCompanies(req.integration!.readCompanies, req.query.company);
    const c = await invoiceContext(companies);
    const seen = new Set<string>();
    const out: any[] = [];
    for (const x of c.rows) {
      for (const p of (c.view(x, true) as any).payments || []) {
        const k = p.relId != null ? `rel:${p.relId}` : `${p.owner.type}:${p.owner.id}:${p.id}:${p.amount}:${p.date}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ ...p, invoiceNumber: x.kind === 'job' ? x.rec.invoiceNum : x.rec.number });
      }
    }
    // Payments on jobs/quotes that have no invoice yet (deposits).
    for (const j of c.J.items) {
      if (!companies.includes(d.companyOf(j).code)) continue;
      for (const p of (d.jobView(j, c.J, { quotes: c.Q.items, invoices: c.I.items, links: c.links }, true) as any).payments || []) {
        if (p.owner.type === 'invoice') continue; // already listed under its invoice above
        const k = p.relId != null ? `rel:${p.relId}` : `${p.owner.type}:${p.owner.id}:${p.id}:${p.amount}:${p.date}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ ...p, invoiceNumber: null });
      }
    }
    const rows = out.filter((p) => inRange(p.date, o) && matchQ(o.q, p.reference, p.method, p.owner.number, p.invoiceNumber)).sort(byNewest('date', 'id'));
    page(res, rows, o, meta(['accInvoices', c.I], ['jobs', c.J], ['quotes', c.Q]));
  }));
  r.get('/credit-notes', requireScope('accounts:read'), op('read.credit_notes', async (req, res) => {
    const o = listOpts(req);
    const companies = d.authorisedCompanies(req.integration!.readCompanies, req.query.company);
    const L = await new d.Snapshot().load('creditNotes');
    const notes: string[] = [];
    const rows = L.items.filter((cn) => companies.includes(d.companyOf(cn).code)).map((cn) => d.creditNoteView(cn, L))
      .filter((v) => (!req.query.type || v.type === req.query.type) && (req.query.open !== 'true' || v.remaining > 0) && inRange(v.date, o) && matchQ(o.q, v.number, v.contactName, v.reason))
      .sort(byNewest('date', 'number'));
    page(res, sinceFilter(rows, o, notes), o, meta(['creditNotes', L]), notes);
  }));
  r.get('/receivables', requireScope('accounts:read'), op('read.receivables', async (req, res) => {
    const companies = d.authorisedCompanies(req.integration!.readCompanies, req.query.company);
    const c = await invoiceContext(companies);
    const CN = await c.snap.load('creditNotes');
    const today = d.todaySA();
    const byCo: Record<string, any> = {};
    for (const code of companies) byCo[code] = { companyCode: code, companyName: d.COMPANY_NAMES[code] ?? null, invoicesOutstanding: 0, invoiceCount: 0, overdueOutstanding: 0, overdueCount: 0, unusedCustomerCredit: 0, netOwed: 0, aging: { '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 }, topDebtors: [] as any[] };
    const debtors: Record<string, Map<string, number>> = {};
    for (const x of c.rows) {
      const v: any = c.view(x, false);
      if (['paid', 'void'].includes(v.status) || v.outstanding <= 0.005 || v.totals.totalInclVat <= 0.005) continue;
      const g = byCo[v.companyCode];
      if (!g) continue;
      // index.html getAgedDebtors: buckets by days since the invoice was issued.
      const days = v.issueDate ? Math.floor((Date.parse(today) - Date.parse(v.issueDate)) / 86400000) : 0;
      const bucket = days <= 30 ? '1-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+';
      g.aging[bucket] = rands(sgrToCents0(g.aging[bucket]) + sgrToCents0(v.outstanding));
      g.invoicesOutstanding = rands(sgrToCents0(g.invoicesOutstanding) + sgrToCents0(v.outstanding));
      g.invoiceCount += 1;
      if (v.overdue) { g.overdueOutstanding = rands(sgrToCents0(g.overdueOutstanding) + sgrToCents0(v.outstanding)); g.overdueCount += 1; }
      const map = (debtors[v.companyCode] ||= new Map());
      const name = v.contact.name || '(no name)';
      map.set(name, (map.get(name) || 0) + sgrToCents0(v.outstanding));
    }
    for (const cn of CN.items) {
      if (cn.type !== 'customer') continue;
      const v = d.creditNoteView(cn, CN);
      if (byCo[v.companyCode] && v.remaining > 0.005) byCo[v.companyCode].unusedCustomerCredit = rands(sgrToCents0(byCo[v.companyCode].unusedCustomerCredit) + sgrToCents0(v.remaining));
    }
    for (const g of Object.values(byCo)) {
      g.netOwed = rands(sgrToCents0(g.invoicesOutstanding) - sgrToCents0(g.unusedCustomerCredit));
      g.topDebtors = [...(debtors[g.companyCode] || new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, cents]) => ({ name, outstanding: rands(cents) }));
    }
    res.json({ results: Object.values(byCo), method: 'Aged by days since issue date (SignaCore Aged Debtors); overdue = past the invoice due date. Unused customer credit notes reduce the net amount owed.', ...meta(['accInvoices', c.I], ['jobs', c.J], ['creditNotes', CN]), asOf: new Date().toISOString() });
  }));
  r.get('/bills', requireScope('accounts:read'), op('read.bills', async (req, res) => {
    const o = listOpts(req);
    const companies = d.authorisedCompanies(req.integration!.readCompanies, req.query.company);
    const L = await new d.Snapshot().load('accBills');
    const rows = L.items.filter((b) => companies.includes(d.companyOf(b).code)).map(d.billView)
      .filter((v) => (!o.status || o.status.includes(v.status)) && (req.query.outstanding !== 'true' || v.outstanding > 0) && inRange(v.date, o) && matchQ(o.q, v.number, v.supplierName, v.supplierRef, v.poNumber))
      .sort(byNewest('date', 'number'));
    page(res, rows, o, meta(['accBills', L]));
  }));

  // ── PURCHASING ───────────────────────────────────────────────────────────
  r.get('/suppliers', requireScope('purchasing:read'), op('read.suppliers', async (req, res) => {
    const o = listOpts(req);
    const L = await new d.Snapshot().load('suppliers');
    const notes: string[] = [];
    const rows = L.items.map((s) => d.supplierView(s, L)).filter((s) => matchQ(o.q, s.name, s.contactPerson, s.email));
    page(res, sinceFilter(rows, o, notes), o, meta(['suppliers', L]), notes);
  }));
  async function poContext(companies: string[]) {
    const snap = new d.Snapshot();
    const [P, S] = await Promise.all([snap.load('purchaseOrders'), snap.load('suppliers')]);
    return { P, S, rows: P.items.filter((po) => companies.includes(d.companyOf(po).code)) };
  }
  r.get('/purchase-orders', requireScope('purchasing:read'), op('read.purchase_orders', async (req, res) => {
    const o = listOpts(req);
    const companies = d.authorisedCompanies(req.integration!.readCompanies, req.query.company);
    const { P, S, rows } = await poContext(companies);
    const notes: string[] = [];
    const views = rows.map((po) => d.purchaseOrderView(po, P, S.items, req.query.items === 'true'))
      .filter((v) => (!o.status || o.status.includes(v.status)) && (!req.query.supplier || v.supplier.id === String(req.query.supplier)) && inRange(v.orderDate, o) && matchQ(o.q, v.number, v.supplier.name, v.jobNumber, v.quoteNumber))
      .sort(byNewest('orderDate', 'number'));
    page(res, sinceFilter(views, o, notes), o, meta(['purchaseOrders', P], ['suppliers', S]), notes);
  }));
  r.get('/purchase-orders/:ref', requireScope('purchasing:read'), op('read.purchase_order', async (req, res) => {
    const ref = String(req.params.ref);
    if (!REF_RE.test(ref)) throw bad('Invalid reference.');
    res.locals.targetType = 'purchase_order'; res.locals.targetId = ref;
    const companies = d.authorisedCompanies(req.integration!.readCompanies, req.query.company);
    const { P, S, rows } = await poContext(companies);
    const hit = findOne(rows.map((po) => ({ id: String(po.id), number: po.num, companyCode: d.companyOf(po).code, po })), ref, 'number', companies);
    res.json({ purchaseOrder: d.purchaseOrderView(hit.po, P, S.items, true), ...meta(['purchaseOrders', P], ['suppliers', S]), asOf: new Date().toISOString() });
  }));
  r.get('/supplier-prices', requireScope('purchasing:read'), op('read.supplier_prices', async (req, res) => {
    const companies = d.authorisedCompanies(req.integration!.readCompanies, req.query.company);
    const item = req.query.item ? String(req.query.item).trim() : '';
    if (!item || item.length > 60) throw bad('Provide ?item=<inventory id, inv:id ref or SKU>.');
    const snap = new d.Snapshot();
    const [P, S, INV] = await Promise.all([snap.load('purchaseOrders'), snap.load('suppliers'), snap.load('inventory')]);
    const key = item.replace(/^inv:/, '');
    const inv = INV.items.find((it) => String(it.id) === key || String(it.sku || '').toUpperCase() === key.toUpperCase()) || null;
    const supName = (id: unknown) => d.str(S.items.find((s) => String(s.id) === String(id))?.name);
    const history: any[] = [];
    for (const po of P.items) {
      const c = d.companyOf(po);
      if (!companies.includes(c.code)) continue;
      (po.items || []).forEach((l: any) => {
        const match = inv ? (l.inventoryId != null && String(l.inventoryId) === String(inv.id)) || (inv.sku && String(l.sku || '').toUpperCase() === String(inv.sku).toUpperCase())
          : String(l.sku || '').toUpperCase() === key.toUpperCase();
        if (!match) return;
        history.push({ date: po.date || null, poNumber: po.num ?? null, poId: String(po.id), poStatus: po.status || 'draft', companyCode: c.code,
          supplierId: po.supplierId != null ? String(po.supplierId) : null, supplierName: supName(po.supplierId), unitCostExVat: Number(l.unitCost) || 0, qtyOrdered: Number(l.qtyOrdered) || 0, unit: d.str(l.unit) });
      });
    }
    const legacyNotes: string[] = [];
    if (P.source === 'relational') {
      // Historical purchase orders were deliberately not migrated (backfill PASS 6). Their lines are still the only
      // record of what those suppliers charged, so include them — labelled, and never presented as current orders.
      const legacy = await query(`SELECT data -> 'purchaseOrders' AS v FROM platform_state WHERE id = 1`);
      const seenKeys = new Set(history.map((h) => `${h.poNumber}|${h.date}|${h.unitCostExVat}`));
      let added = 0;
      for (const po of Array.isArray(legacy.rows[0]?.v) ? legacy.rows[0].v : []) {
        const c = d.companyOf(po);
        if (!companies.includes(c.code)) continue;
        (po.items || []).forEach((l: any) => {
          const match = inv ? (l.inventoryId != null && String(l.inventoryId) === String(inv.id)) || (inv.sku && String(l.sku || '').toUpperCase() === String(inv.sku).toUpperCase())
            : String(l.sku || '').toUpperCase() === key.toUpperCase();
          if (!match) return;
          const k = `${po.num ?? null}|${po.date || null}|${Number(l.unitCost) || 0}`;
          if (seenKeys.has(k)) return;
          seenKeys.add(k); added++;
          history.push({ date: po.date || null, poNumber: po.num ?? null, poId: String(po.id), poStatus: po.status || 'draft', companyCode: c.code,
            supplierId: po.supplierId != null ? String(po.supplierId) : null, supplierName: supName(po.supplierId), unitCostExVat: Number(l.unitCost) || 0, qtyOrdered: Number(l.qtyOrdered) || 0, unit: d.str(l.unit), source: 'legacy_json' });
        });
      }
      if (added) legacyNotes.push(`${added} price point(s) come from purchase orders made before the relational PO system; they are not shown in the dashboard's current PO list.`);
    }
    for (const h of history) h.source ||= P.source;
    history.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
    res.json({
      item: inv ? { ref: `inv:${inv.id}`, sku: d.str(inv.sku), name: d.str(inv.name), currentCostExVat: Number(inv.cost) || 0, currentSupplierId: inv.supplierId != null ? String(inv.supplierId) : null, currentSupplierName: supName(inv.supplierId) } : null,
      history,
      note: 'Unit prices come from purchase-order lines (draft, approved and declined orders, as recorded). SignaCore keeps no separate supplier price list and does not record received quantities.',
      ...(legacyNotes.length ? { notes: legacyNotes } : {}),
      ...meta(['purchaseOrders', P], ['suppliers', S], ['inventory', INV]), asOf: new Date().toISOString(),
    });
  }));
  r.get('/inventory', requireScope('inventory:read'), op('read.inventory', async (req, res) => {
    const o = listOpts(req);
    const L = await new d.Snapshot().load('inventory');
    const opts = { cost: hasScope(req, 'purchasing:read'), pricing: hasScope(req, 'pricing:read') };
    const notes: string[] = [];
    const rows = L.items.map((it) => d.inventoryView(it, L, opts))
      .filter((v) => (req.query.includeInactive === 'true' || v.active) && (req.query.lowStock !== 'true' || ['low', 'out_of_stock'].includes(v.stockStatus)) && matchQ(o.q, v.sku, v.name, v.category));
    page(res, sinceFilter(rows, o, notes), o, meta(['inventory', L]), notes);
  }));

  // ── SUMMARY (the daily briefing's numbers) ──────────────────────────────
  r.get('/summary', anyReadScope, op('read.summary', async (req, res) => {
    const companies = d.authorisedCompanies(req.integration!.readCompanies, req.query.company);
    const out: Record<string, any> = {};
    const c = await invoiceContext(companies);
    const sections: Array<[string, d.Loaded]> = [['quotes', c.Q], ['jobs', c.J], ['accInvoices', c.I]];
    for (const code of companies) out[code] = { companyCode: code, companyName: d.COMPANY_NAMES[code] ?? null };
    if (hasScope(req, 'sales:read')) {
      for (const q of c.Q.items) {
        const co = d.companyOf(q).code; if (!out[co]) continue;
        const st = q.status || 'draft';
        const s = (out[co].quotes ||= { draft: 0, sent: 0, approved: 0, declined: 0, converted: 0 });
        s[st] = (s[st] || 0) + 1;
      }
    }
    if (hasScope(req, 'jobs:read')) {
      for (const j of c.J.items) {
        const co = d.companyOf(j).code; if (!out[co]) continue;
        const v = d.jobView(j, c.J, { quotes: c.Q.items, invoices: c.I.items, links: c.links }, false);
        const s = (out[co].jobs ||= { open: 0, pastDueDate: 0, byStage: {} as Record<string, number> });
        if (v.stage !== null && v.stage >= 8) continue;
        s.open += 1; if (v.pastDueDate) s.pastDueDate += 1;
        const name = v.stageName || 'Unknown'; s.byStage[name] = (s.byStage[name] || 0) + 1;
      }
    }
    if (hasScope(req, 'accounts:read')) {
      for (const x of c.rows) {
        const v: any = c.view(x, false);
        const s = (out[v.companyCode].invoices ||= { outstandingCount: 0, outstanding: 0, overdueCount: 0, overdue: 0 });
        if (v.isVoid || v.outstanding <= 0 || ['paid', 'draft'].includes(v.status)) continue;
        s.outstandingCount += 1; s.outstanding = rands(sgrToCents0(s.outstanding) + sgrToCents0(v.outstanding));
        if (v.overdue) { s.overdueCount += 1; s.overdue = rands(sgrToCents0(s.overdue) + sgrToCents0(v.outstanding)); }
      }
    }
    if (hasScope(req, 'purchasing:read')) {
      const P = await c.snap.load('purchaseOrders');
      sections.push(['purchaseOrders', P]);
      for (const po of P.items) {
        const co = d.companyOf(po).code; if (!out[co]) continue;
        const s = (out[co].purchaseOrders ||= { draft: 0, approved: 0, declined: 0, other: 0 });
        const st = po.status || 'draft'; if (st in s) s[st] += 1; else s.other += 1;
      }
    }
    if (hasScope(req, 'inventory:read')) {
      const INV = await c.snap.load('inventory');
      sections.push(['inventory', INV]);
      const low = INV.items.filter((it) => it.active !== false && ['low', 'out_of_stock'].includes(d.inventoryView(it, INV, { cost: false, pricing: false }).stockStatus));
      for (const code of companies) out[code].stock = { lowOrOut: low.length, sharedAcrossCompanies: true };
    }
    res.json({ results: Object.values(out), ...meta(...sections), asOf: new Date().toISOString() });
  }));

  return r;
}
