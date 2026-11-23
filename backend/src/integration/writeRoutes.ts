/**
 * Owner WRITE access — /api/v1/integration/write/* (CORE-AGENTS confirmed actions). Added with migration
 * 020_integration_owner_writers.sql.
 *
 * WHO. Only an *owner-writer* client (`clientCli create-writer`) may call these routes; every other client — Sally and
 * the read-only CORE-AGENTS reader included — gets 403 NOT_OWNER_WRITER. An owner-writer may write only the companies
 * in its write_company_codes, only with the scopes it holds, and only here (auth.ts refuses it everywhere else).
 *
 * WHAT. Every route calls relational/services.ts — the SAME business services the dashboard's /api/relational routes
 * use, unchanged: their validation, numbering, transactions, cascades and optimistic concurrency (row_version) apply.
 * Allow-lists keep each route narrow:
 *   GET   /write/capabilities                       what this client may change, per company, and section authority
 *   GET   /write/jobs/:id                           the job's writable fields + rowVersion (for the proposal and read-back)
 *   PATCH /write/jobs/:id                           jobs:update        dueDate, notes, reference, poRef
 *   POST  /write/jobs/:id/invoice                   invoices:create    ensureInvoiceForJob (completed jobs; idempotent)
 *   GET   /write/purchase-orders/:id                the PO's writable fields + rowVersion
 *   POST  /write/purchase-orders                    purchasing:create  a DRAFT purchase order from inventory items
 *   PATCH /write/purchase-orders/:id                purchasing:update  notes; status draft → approved | declined
 *
 * HOW. Every mutation needs Idempotency-Key, X-Confirmed-By (the owner approval it carries out, recorded in
 * integration_audit) and expectedVersion where a record is changed (409 STALE_VERSION when it moved). No route deletes,
 * sends, records payments, changes prices, discounts, setup fees, customers or users, or runs SQL from the caller.
 */
import { Router, Response, NextFunction } from 'express';
import { query } from '../db/pool';
import {
  updateJob, ensureInvoiceForJob, createPurchaseOrder, updatePurchaseOrder,
  BusinessRuleError, ConcurrencyConflictError, LegacyInvoiceConflictError,
} from '../relational/services';
import { IntegrationRequest, requireScope } from './auth';
import { IntegrationError, bad, sendError } from './errors';
import * as data from './data';
import { OWNER_WRITE_SCOPES } from './scopes';

type Handler = (req: IntegrationRequest, res: Response) => Promise<void>;
type Op = (name: string, fn: Handler) => (req: IntegrationRequest, res: Response, next: NextFunction) => Promise<void>;
type Idempotent = (
  req: IntegrationRequest, res: Response, operation: string, target: string,
  recover: (() => Promise<{ status: number; body: unknown } | null>) | null,
  run: () => Promise<{ status: number; body: unknown; committed: boolean; deferCompletion?: boolean }>
) => Promise<void>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PO_STATUS_FROM_DRAFT = ['approved', 'declined'];

function onlyKeys(body: Record<string, unknown>, allowed: string[], where: string): void {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length) throw new IntegrationError(403, 'FIELD_NOT_PERMITTED', `${where} cannot set: ${extra.join(', ')}.`, { fields: extra });
}
function text(v: unknown, field: string, max: number): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > max) throw bad(`"${field}" must be text of at most ${max} characters.`);
  return v.trim();
}
function dateOrNull(v: unknown, field: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw bad(`"${field}" must be a date (YYYY-MM-DD).`);
  return v;
}
function id(v: unknown, what: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw bad(`Invalid ${what} id.`);
  return n;
}
function version(body: Record<string, unknown>): number {
  const v = body.expectedVersion;
  if (typeof v !== 'number' || !Number.isInteger(v)) throw bad('"expectedVersion" (the rowVersion you last read) is required.');
  return v;
}
function mapError(err: unknown): IntegrationError | null {
  if (err instanceof ConcurrencyConflictError) return new IntegrationError(409, 'STALE_VERSION', 'The record changed in Signacore since it was last read. Read it again and confirm the change again.');
  if (err instanceof LegacyInvoiceConflictError) return new IntegrationError(409, 'LEGACY_CONFLICT', 'Signacore refused the change because of a linked legacy invoice.');
  if (err instanceof BusinessRuleError) return new IntegrationError(422, 'BUSINESS_RULE', err.message);
  return null;
}

/** Records with no company tag belong to Signacore (code 2), exactly as the dashboard and the read API treat them. */
const companyOfRow = (code: unknown): string => (code == null || String(code).trim() === '' ? '2' : String(code));

function requireOwnerWriter(req: IntegrationRequest): string[] {
  const ctx = req.integration!;
  if (!ctx.ownerWriter) throw new IntegrationError(403, 'NOT_OWNER_WRITER', 'This integration client may not use the owner write API.');
  if (!ctx.confirmedBy && req.method !== 'GET') throw new IntegrationError(428, 'CONFIRMATION_REQUIRED', 'X-Confirmed-By (the owner confirmation this change carries out) is required.');
  return ctx.writeCompanies;
}
function assertCompany(req: IntegrationRequest, code: string): void {
  if (!req.integration!.writeCompanies.includes(code)) throw new IntegrationError(404, 'NOT_FOUND', 'Record not found.'); // never reveal other companies' records
}
async function requireRelational(section: 'jobs' | 'purchaseOrders' | 'accInvoices'): Promise<void> {
  const a = await data.sectionAuthority(section);
  if (a !== 'relational') throw new IntegrationError(409, 'SECTION_NOT_RELATIONAL', `Signacore ${section} are not writable through the integration API on this server (not cut over).`);
}

async function jobRow(jobId: number) {
  const r = await query(`SELECT id, job_number, company_code, customer_name_raw, status, stage, due_date, notes, reference, po_ref, row_version, updated_at FROM rel_jobs WHERE id = $1`, [jobId]);
  return r.rows[0] || null;
}
const jobOut = (j: any) => ({
  id: Number(j.id), jobNumber: j.job_number, companyCode: companyOfRow(j.company_code), customer: j.customer_name_raw || null, status: j.status || null, stage: j.stage ?? null,
  dueDate: j.due_date ? String(j.due_date instanceof Date ? j.due_date.toISOString().slice(0, 10) : j.due_date).slice(0, 10) : null,
  notes: j.notes ?? null, reference: j.reference ?? null, poRef: j.po_ref ?? null, rowVersion: Number(j.row_version), updatedAt: j.updated_at,
});
async function poRow(poId: number) {
  const r = await query(
    `SELECT po.id, po.po_number, po.company_code, po.status, po.notes, po.order_date, po.row_version, po.updated_at, po.supplier_id, s.name AS supplier_name,
            (SELECT count(*) FROM rel_purchase_order_items i WHERE i.po_id = po.id) AS line_count
       FROM rel_purchase_orders po LEFT JOIN rel_suppliers s ON s.id = po.supplier_id WHERE po.id = $1`, [poId]);
  return r.rows[0] || null;
}
const poOut = (p: any) => ({
  id: Number(p.id), poNumber: p.po_number, companyCode: companyOfRow(p.company_code), status: p.status || 'draft', notes: p.notes ?? null,
  supplierId: p.supplier_id != null ? Number(p.supplier_id) : null, supplier: p.supplier_name || null, lines: Number(p.line_count || 0), rowVersion: Number(p.row_version), updatedAt: p.updated_at,
});

export function writeRoutes(op: Op, idempotent: Idempotent): Router {
  const r = Router();

  r.get('/capabilities', op('write.capabilities', async (req, res) => {
    const companies = requireOwnerWriter(req);
    const sections: Record<string, string> = {};
    for (const s of ['jobs', 'purchaseOrders', 'accInvoices'] as const) sections[s] = await data.sectionAuthority(s);
    const scopes = req.integration!.scopes;
    res.json({
      client: req.integration!.clientId, companies, scopes, sections,
      actions: {
        jobUpdate: scopes.includes('jobs:update') && sections.jobs === 'relational',
        jobInvoice: scopes.includes('invoices:create') && sections.jobs === 'relational' && sections.accInvoices === 'relational',
        purchaseOrderCreate: scopes.includes('purchasing:create') && sections.purchaseOrders === 'relational',
        purchaseOrderUpdate: scopes.includes('purchasing:update') && sections.purchaseOrders === 'relational',
      },
      fields: { job: ['dueDate', 'notes', 'reference', 'poRef'], purchaseOrder: ['notes', 'status (draft → approved | declined)'] },
      never: ['deletes', 'sending documents', 'payments', 'prices, discounts or setup fees', 'customers', 'users', 'job stage changes (the dashboard runs invoice automation on stage changes)'],
      knownWriteScopes: OWNER_WRITE_SCOPES,
    });
  }));

  // ── JOBS ────────────────────────────────────────────────────────────────
  r.get('/jobs/:id', op('write.job.get', async (req, res) => {
    requireOwnerWriter(req);
    const jid = id(req.params.id, 'job');
    res.locals.targetType = 'job'; res.locals.targetId = jid;
    const j = await jobRow(jid);
    if (!j) throw new IntegrationError(404, 'NOT_FOUND', 'Record not found.');
    assertCompany(req, companyOfRow(j.company_code));
    res.json({ job: jobOut(j) });
  }));

  r.patch('/jobs/:id', requireScope('jobs:update'), op('write.job.update', async (req, res) => {
    requireOwnerWriter(req);
    const jid = id(req.params.id, 'job');
    res.locals.targetType = 'job'; res.locals.targetId = jid;
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body as Record<string, unknown> : {};
    onlyKeys(body, ['expectedVersion', 'dueDate', 'notes', 'reference', 'poRef'], 'A job change');
    const expected = version(body);
    const patch: Record<string, unknown> = {};
    const dueDate = dateOrNull(body.dueDate, 'dueDate'); if (dueDate !== undefined) patch.dueDate = dueDate;
    const notes = text(body.notes, 'notes', 4000); if (notes !== undefined) patch.notes = notes;
    const reference = text(body.reference, 'reference', 120); if (reference !== undefined) patch.reference = reference;
    const poRef = text(body.poRef, 'poRef', 60); if (poRef !== undefined) patch.poRef = poRef;
    if (!Object.keys(patch).length) throw bad('Nothing to change.');
    await requireRelational('jobs');
    const before = await jobRow(jid);
    if (!before) throw new IntegrationError(404, 'NOT_FOUND', 'Record not found.');
    assertCompany(req, companyOfRow(before.company_code));
    await idempotent(req, res, 'write.job.update', `jobs/${jid}`, null, async () => {
      try {
        await updateJob(jid, expected, patch as any);
      } catch (err) { throw mapError(err) || err; }
      let out: unknown;
      try { out = { job: jobOut(await jobRow(jid)), changed: Object.keys(patch) }; }
      catch { out = { job: { id: jid }, partial: true }; }
      return { status: 200, body: out, committed: true };
    });
  }));

  r.post('/jobs/:id/invoice', requireScope('invoices:create'), op('write.job.invoice', async (req, res) => {
    requireOwnerWriter(req);
    const jid = id(req.params.id, 'job');
    res.locals.targetType = 'job'; res.locals.targetId = jid;
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body as Record<string, unknown> : {};
    onlyKeys(body, ['expectedVersion'], 'Creating an invoice');
    const expected = version(body);
    await requireRelational('jobs'); await requireRelational('accInvoices');
    const j = await jobRow(jid);
    if (!j) throw new IntegrationError(404, 'NOT_FOUND', 'Record not found.');
    assertCompany(req, companyOfRow(j.company_code));
    if (Number(j.row_version) !== expected) throw new IntegrationError(409, 'STALE_VERSION', 'The job changed in Signacore since it was last read. Read it again and confirm again.');
    await idempotent(req, res, 'write.job.invoice', `jobs/${jid}/invoice`, null, async () => {
      let result: Awaited<ReturnType<typeof ensureInvoiceForJob>>;
      try { result = await ensureInvoiceForJob(jid); } catch (err) { throw mapError(err) || err; }
      let jobNow: unknown = { id: jid };
      try { jobNow = jobOut(await jobRow(jid)); } catch { /* read-back is best effort after the commit */ }
      return { status: 200, body: { invoice: { id: result.invoiceId, invoiceNumber: result.invoiceNumber, created: result.created }, job: jobNow }, committed: true };
    });
  }));

  // ── PURCHASE ORDERS ─────────────────────────────────────────────────────
  r.get('/purchase-orders/:id', op('write.po.get', async (req, res) => {
    requireOwnerWriter(req);
    const pid = id(req.params.id, 'purchase order');
    res.locals.targetType = 'purchase_order'; res.locals.targetId = pid;
    const p = await poRow(pid);
    if (!p) throw new IntegrationError(404, 'NOT_FOUND', 'Record not found.');
    assertCompany(req, companyOfRow(p.company_code));
    res.json({ purchaseOrder: poOut(p) });
  }));

  r.post('/purchase-orders', requireScope('purchasing:create'), op('write.po.create', async (req, res) => {
    requireOwnerWriter(req);
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body as Record<string, unknown> : {};
    onlyKeys(body, ['companyCode', 'supplierId', 'jobId', 'orderDate', 'notes', 'items'], 'A purchase order');
    const companyCode = String(body.companyCode ?? '');
    if (!req.integration!.writeCompanies.includes(companyCode)) throw new IntegrationError(403, 'COMPANY_NOT_AUTHORISED', 'This client may not create records for that company.');
    const supplierId = id(body.supplierId, 'supplier');
    const jobId = body.jobId != null ? id(body.jobId, 'job') : null;
    const orderDate = dateOrNull(body.orderDate, 'orderDate') ?? null;
    const notes = text(body.notes, 'notes', 2000) ?? null;
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 100) throw bad('"items" must list 1–100 inventory items.');
    const items: Array<{ inventoryItemId: number; qty: number }> = body.items.map((it: any, i: number) => {
      if (!it || typeof it !== 'object') throw bad(`Item ${i + 1} is invalid.`);
      onlyKeys(it, ['inventoryItemId', 'qty'], `Item ${i + 1}`); // name, unit and cost come from the inventory record, never the caller
      const q = Number(it.qty);
      if (!Number.isFinite(q) || q <= 0 || q > 1_000_000) throw bad(`Item ${i + 1}: "qty" must be a positive number.`);
      return { inventoryItemId: id(it.inventoryItemId, `item ${i + 1} inventory`), qty: q };
    });
    await requireRelational('purchaseOrders');
    const sup = await query('SELECT id FROM rel_suppliers WHERE id = $1', [supplierId]);
    if (!sup.rowCount) throw new IntegrationError(422, 'BUSINESS_RULE', 'A saved supplier is required to create a purchase order.');
    let jobNumberRaw: string | null = null;
    if (jobId) {
      const j = await jobRow(jobId);
      if (!j || companyOfRow(j.company_code) !== companyCode) throw new IntegrationError(404, 'NOT_FOUND', 'Job not found in that company.');
      jobNumberRaw = j.job_number;
    }
    const inv = await query(`SELECT id, sku, name, unit, cost FROM rel_inventory_items WHERE id = ANY($1::bigint[])`, [items.map((i) => i.inventoryItemId)]);
    const byId = new Map(inv.rows.map((x: any) => [Number(x.id), x]));
    const lines = items.map((it, i) => {
      const x: any = byId.get(it.inventoryItemId);
      if (!x) throw new IntegrationError(404, 'NOT_FOUND', `Item ${i + 1}: inventory item not found.`);
      return { inventoryItemId: it.inventoryItemId, sku: x.sku ?? null, name: x.name, unit: x.unit ?? null, qtyNeeded: it.qty, qtyOrdered: it.qty, unitCost: Number(x.cost) || 0 };
    });
    await idempotent(req, res, 'write.po.create', 'purchase-orders', null, async () => {
      let created: { id: number; poNumber: string; rowVersion: number };
      try {
        created = await createPurchaseOrder({ companyCode, supplierId, jobId, jobNumberRaw, orderDate, notes, items: lines } as any);
      } catch (err) { throw mapError(err) || err; }
      res.locals.targetType = 'purchase_order'; res.locals.targetId = created.id;
      let out: unknown;
      try { out = { purchaseOrder: poOut(await poRow(created.id)) }; } catch { out = { purchaseOrder: { id: created.id, poNumber: created.poNumber }, partial: true }; }
      return { status: 201, body: out, committed: true };
    });
  }));

  r.patch('/purchase-orders/:id', requireScope('purchasing:update'), op('write.po.update', async (req, res) => {
    requireOwnerWriter(req);
    const pid = id(req.params.id, 'purchase order');
    res.locals.targetType = 'purchase_order'; res.locals.targetId = pid;
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body as Record<string, unknown> : {};
    onlyKeys(body, ['expectedVersion', 'status', 'notes'], 'A purchase-order change');
    const expected = version(body);
    const patch: Record<string, unknown> = {};
    const notes = text(body.notes, 'notes', 2000); if (notes !== undefined) patch.notes = notes;
    if (body.status !== undefined) {
      if (typeof body.status !== 'string' || !PO_STATUS_FROM_DRAFT.includes(body.status)) throw bad('"status" can only be "approved" or "declined".');
      patch.status = body.status;
    }
    if (!Object.keys(patch).length) throw bad('Nothing to change.');
    await requireRelational('purchaseOrders');
    const p = await poRow(pid);
    if (!p) throw new IntegrationError(404, 'NOT_FOUND', 'Record not found.');
    assertCompany(req, companyOfRow(p.company_code));
    if (patch.status && (p.status || 'draft') !== 'draft') throw new IntegrationError(409, 'STATUS_NOT_CHANGEABLE', 'Only a draft purchase order can be approved or declined through this API.');
    await idempotent(req, res, 'write.po.update', `purchase-orders/${pid}`, null, async () => {
      try { await updatePurchaseOrder(pid, expected, patch as any); } catch (err) { throw mapError(err) || err; }
      let out: unknown;
      try { out = { purchaseOrder: poOut(await poRow(pid)), changed: Object.keys(patch) }; } catch { out = { purchaseOrder: { id: pid }, partial: true }; }
      return { status: 200, body: out, committed: true };
    });
  }));

  r.use(op('write.unknown', async (_req, _res) => { throw new IntegrationError(404, 'NOT_FOUND', 'Unknown write endpoint.'); }));
  return r;
}

export { sendError };
