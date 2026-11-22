/**
 * The owner read API's own description of itself — served at GET /read/capabilities and used by readRoutes to
 * register list/detail paths and scopes, so the description and the routes come from ONE definition.
 * test/integration-materials.stress.ts checks it against the live routes: every type's list (and detail) path answers,
 * its scope is enforced, every field a record carries is declared here, and every declared field is returned.
 *
 * Bump SCHEMA_VERSION whenever a type, field, filter or relation changes. API_VERSION changes only for a breaking change.
 */
import { Scope } from './scopes';

export const API_VERSION = 'v1';
export const SCHEMA_VERSION = '2026-11-23.1';

export interface FieldDef { name: string; type: string; description: string; detailOnly?: boolean }
export interface ReadType {
  type: string; label: string; scope: Scope | 'any-read';
  list: { path: string; filters: string[]; paginated: boolean };
  detail?: { path: string; ref: string };
  companyScoped: boolean; idField: string; numberField: string | null; updatedAtField: string | null;
  fields: FieldDef[]; relations: Array<{ field: string; to: string; by: string }>;
  notes?: string;
}

const COMMON_LIST = ['page', 'limit', 'q', 'updatedSince'];
const f = (name: string, type: string, description: string, detailOnly = false): FieldDef => ({ name, type, description, ...(detailOnly ? { detailOnly } : {}) });
const company = [f('companyCode', 'string', 'SignaCore company code (1 Holdings, 2 Signacore, 4 Cover X)'), f('companyTagged', 'boolean', 'false = an older record with no company, shown under Signacore')];
const stampsF = [f('createdAt', 'datetime|null', 'Created (relational records only)'), f('updatedAt', 'datetime|null', 'Last changed (relational records only)')];

export const READ_TYPES: ReadType[] = [
  {
    type: 'customers', label: 'Customers and contacts', scope: 'customer:read', companyScoped: false, idField: 'id', numberField: null, updatedAtField: 'updatedAt',
    list: { path: '/read/customers', filters: COMMON_LIST, paginated: true },
    fields: [f('id', 'string', 'Customer id'), f('companyName', 'string|null', 'Customer name'), f('contactPerson', 'string|null', 'The one contact person'), f('email', 'string|null', 'Contact email'), f('phone', 'string|null', 'Contact phone'), f('vatNumber', 'string|null', 'VAT number'), ...stampsF],
    relations: [],
  },
  {
    type: 'quotes', label: 'Quotations', scope: 'sales:read', companyScoped: true, idField: 'id', numberField: 'number', updatedAtField: 'updatedAt',
    list: { path: '/read/quotes', filters: [...COMMON_LIST, 'company', 'status', 'from', 'to'], paginated: true }, detail: { path: '/read/quotes/{ref}', ref: 'number or id' },
    fields: [f('id', 'string', 'Quote id'), f('relId', 'number|null', 'Relational row id'), f('number', 'string', 'Quote number (SQ-…)'), ...company,
      f('status', 'string', 'draft | sent | approved | declined | converted'), f('statusLabel', 'string', 'Label as the dashboard shows it'), f('customer', 'object', 'Contact typed on the quote: name, contactPerson, email, phone'),
      f('reference', 'string|null', 'Reference'), f('poRef', 'string|null', 'Customer PO reference'), f('salesperson', 'string|null', 'Salesperson'), f('preparedBy', 'string|null', 'Prepared by'),
      f('quoteDate', 'date|null', 'Quote date'), f('validUntil', 'date|null', 'Valid until'), f('sentAt', 'null', 'Not recorded by SignaCore'), f('totals', 'object', 'Totals as the dashboard calculates them (ZAR)'),
      f('deposit', 'object', 'Deposit percentage and amount'), f('paymentsOnQuote', 'object', 'Payments recorded on the quote'), f('proformaNumber', 'string|null', 'Pro-forma number'),
      f('links', 'object', 'jobId, jobNumber, invoiceNumbers'), ...stampsF,
      f('lines', 'array', 'Quote lines with quantities, units and ex-VAT prices', true), f('notes', 'string|null', 'Quote notes (business text)', true)],
    relations: [{ field: 'links.jobNumber', to: 'jobs', by: 'number' }, { field: 'links.invoiceNumbers', to: 'invoices', by: 'number' }],
  },
  {
    type: 'enquiries', label: 'Enquiries recorded in SignaCore', scope: 'sales:read', companyScoped: true, idField: 'id', numberField: 'jobNumber', updatedAtField: 'updatedAt',
    list: { path: '/read/enquiries', filters: ['page', 'limit', 'q', 'company'], paginated: true },
    fields: [f('kind', 'string', 'proposed_project | job_lead'), f('id', 'string', 'Id'), f('title', 'string|null', 'Title'), f('note', 'string|null', 'Note'), f('jobNumber', 'string', 'Job number (job leads only)'), f('customer', 'string|null', 'Customer (job leads only)'),
      ...company, f('stage', 'string|null', 'Stage name'), ...stampsF],
    relations: [{ field: 'jobNumber', to: 'jobs', by: 'number' }],
  },
  {
    type: 'jobs', label: 'Jobs / orders', scope: 'jobs:read', companyScoped: true, idField: 'id', numberField: 'number', updatedAtField: 'updatedAt',
    list: { path: '/read/jobs', filters: [...COMMON_LIST, 'company', 'status', 'stage', 'from', 'to', 'pastDue'], paginated: true }, detail: { path: '/read/jobs/{ref}', ref: 'number or id' },
    fields: [f('id', 'string', 'Job id'), f('relId', 'number|null', 'Relational row id'), f('number', 'string', 'Job number (SNS-…)'), ...company, f('status', 'string|null', 'Status'), f('stage', 'number|null', 'Stage 0–9'), f('stageName', 'string|null', 'Stage name'),
      f('customer', 'object', 'Contact typed on the job'), f('description', 'string|null', 'Description'), f('valueInclVat', 'number', 'Job value incl. VAT'), f('dueDate', 'date|null', 'Due date'), f('pastDueDate', 'boolean', 'Past its due date and not complete'),
      f('daysPastDue', 'number', 'Days past due'), f('installationDate', 'null', 'Not recorded by SignaCore'), f('deliveredAt', 'null', 'Not recorded by SignaCore'), f('writeOff', 'string|null', 'Write-off'), f('depositWaived', 'boolean', 'Progressed without payment'),
      f('deposit', 'object', 'Required and received deposit'), f('links', 'object', 'Quote and invoice links (invoiceLinkState)'), f('settlement', 'object', 'Payable, paid, outstanding'), f('poRef', 'string|null', 'Customer PO'), f('reference', 'string|null', 'Reference'), f('salesperson', 'string|null', 'Salesperson'),
      f('materialList', 'object', 'Job Material List: state saved | saved_empty | none | unreadable; saved lines with units and sizes; on the detail, the automatic ESTIMATE (labelled) when nothing is saved'),
      ...stampsF,
      f('payments', 'array', 'Payments on the job, its quote and invoice', true), f('notes', 'string|null', 'Job notes (business text)', true), f('lines', 'array', 'Job lines as stored (what the estimate reads)', true),
      f('linesNote', 'string|null', 'Says when the job has no lines of its own', true), f('costBreakdown', 'object', 'Cost breakdown categories entered on the job (ex VAT)', true)],
    relations: [{ field: 'links.quoteNumber', to: 'quotes', by: 'number' }, { field: 'links.invoiceNumber', to: 'invoices', by: 'number' }, { field: 'materialList.relationships.stockItems', to: 'inventory', by: 'none recorded' }],
  },
  {
    type: 'invoices', label: 'Invoices', scope: 'accounts:read', companyScoped: true, idField: 'id', numberField: 'number', updatedAtField: 'updatedAt',
    list: { path: '/read/invoices', filters: [...COMMON_LIST, 'company', 'status', 'from', 'to', 'overdue', 'outstanding', 'includeVoid'], paginated: true }, detail: { path: '/read/invoices/{ref}', ref: 'number or id' },
    fields: [f('id', 'string', 'Invoice id (job-… for job invoices)'), f('relId', 'number|null', 'Relational row id'), f('number', 'string', 'Invoice number'), ...company, f('source', 'string', 'record | job'), f('sourceNote', 'string', 'Explains a job invoice'),
      f('status', 'string', 'draft | sent | partial | paid | overdue | void'), f('isVoid', 'boolean', 'Void'), f('contact', 'object', 'name, email'), f('links', 'object', 'Job and quote'), f('reference', 'string|null', 'Reference'), f('issueDate', 'date|null', 'Issued'), f('dueDate', 'date|null', 'Due'),
      f('totals', 'object', 'Totals'), f('paid', 'number', 'Paid'), f('outstanding', 'number', 'Outstanding'), f('overdue', 'boolean', 'Overdue'), f('daysPastDue', 'number', 'Days past due'), f('lastPaymentDate', 'date|null', 'Last payment'),
      f('legacyRoundingSettlement', 'boolean', 'Settled by a legacy rounding rule'), ...stampsF,
      f('lines', 'array', 'Invoice lines', true), f('payments', 'array', 'Payments', true)],
    relations: [{ field: 'links.jobNumber', to: 'jobs', by: 'number' }, { field: 'links.quoteNumber', to: 'quotes', by: 'number' }],
  },
  {
    type: 'payments', label: 'Payments and deposits', scope: 'accounts:read', companyScoped: true, idField: 'id', numberField: null, updatedAtField: null,
    list: { path: '/read/payments', filters: ['page', 'limit', 'q', 'company', 'from', 'to'], paginated: true },
    fields: [f('id', 'string|null', 'Payment id'), f('relId', 'number|null', 'Relational id'), f('amount', 'number', 'Amount'), f('date', 'date|null', 'Date'), f('method', 'string|null', 'Method'), f('reference', 'string|null', 'Reference'),
      f('isCreditAllocation', 'boolean', 'A credit note applied, not money received'), f('owner', 'object', 'The job, quote or invoice it was recorded on'), f('companyCode', 'string', 'Company'), f('invoiceNumber', 'string|null', 'Invoice it belongs to')],
    relations: [{ field: 'owner.number', to: 'jobs|quotes|invoices', by: 'number' }],
  },
  {
    type: 'creditNotes', label: 'Credit notes', scope: 'accounts:read', companyScoped: true, idField: 'id', numberField: 'number', updatedAtField: 'updatedAt',
    list: { path: '/read/credit-notes', filters: [...COMMON_LIST, 'company', 'type', 'open', 'from', 'to'], paginated: true },
    fields: [f('id', 'string', 'Id'), f('relId', 'number|null', 'Relational id'), f('number', 'string|null', 'Number'), ...company, f('type', 'string|null', 'customer | supplier'), f('contactName', 'string|null', 'Contact'), f('date', 'date|null', 'Date'),
      f('amount', 'number', 'Amount'), f('used', 'number', 'Used'), f('remaining', 'number', 'Remaining'), f('reason', 'string|null', 'Reason'), f('appliedTo', 'string|null', 'Applied to'), f('status', 'string|null', 'Status'), ...stampsF],
    relations: [],
  },
  {
    type: 'receivables', label: 'Receivables (aging)', scope: 'accounts:read', companyScoped: true, idField: 'companyCode', numberField: null, updatedAtField: null,
    list: { path: '/read/receivables', filters: ['company'], paginated: false },
    fields: [f('companyCode', 'string', 'Company'), f('companyName', 'string|null', 'Company name'), f('invoicesOutstanding', 'number', 'Outstanding'), f('invoiceCount', 'number', 'Invoices'), f('overdueOutstanding', 'number', 'Overdue'), f('overdueCount', 'number', 'Overdue invoices'),
      f('unusedCustomerCredit', 'number', 'Unused credit'), f('netOwed', 'number', 'Net owed'), f('aging', 'object', 'Aging buckets'), f('topDebtors', 'array', 'Top debtors')],
    relations: [],
  },
  {
    type: 'bills', label: 'Supplier bills', scope: 'accounts:read', companyScoped: true, idField: 'id', numberField: 'number', updatedAtField: null,
    list: { path: '/read/bills', filters: ['page', 'limit', 'q', 'company', 'status', 'outstanding', 'from', 'to'], paginated: true },
    fields: [f('id', 'string', 'Id'), f('number', 'string|null', 'Number'), ...company, f('status', 'string', 'Status'), f('supplierName', 'string|null', 'Supplier'), f('supplierRef', 'string|null', 'Supplier reference'), f('poNumber', 'string|null', 'Purchase order'),
      f('date', 'date|null', 'Date'), f('dueDate', 'date|null', 'Due'), f('paidDate', 'date|null', 'Paid date'), f('totalInclVat', 'number', 'Total'), f('paid', 'number', 'Paid'), f('outstanding', 'number', 'Outstanding'), f('paidFrom', 'string', 'payments | status_paid | none'), f('overdue', 'boolean', 'Overdue'), ...stampsF],
    relations: [{ field: 'poNumber', to: 'purchaseOrders', by: 'number' }],
  },
  {
    type: 'suppliers', label: 'Suppliers', scope: 'purchasing:read', companyScoped: false, idField: 'id', numberField: null, updatedAtField: 'updatedAt',
    list: { path: '/read/suppliers', filters: COMMON_LIST, paginated: true },
    fields: [f('id', 'string', 'Id'), f('relId', 'number|null', 'Relational id'), f('name', 'string|null', 'Name'), f('contactPerson', 'string|null', 'Contact'), f('phone', 'string|null', 'Phone'), f('email', 'string|null', 'Email'), f('city', 'string|null', 'City'),
      f('vatNumber', 'string|null', 'VAT number'), f('paymentTerms', 'string|null', 'Payment terms'), ...stampsF],
    relations: [],
  },
  {
    type: 'purchaseOrders', label: 'Purchase orders and lines', scope: 'purchasing:read', companyScoped: true, idField: 'id', numberField: 'number', updatedAtField: 'updatedAt',
    list: { path: '/read/purchase-orders', filters: [...COMMON_LIST, 'company', 'status', 'supplier', 'from', 'to', 'items'], paginated: true }, detail: { path: '/read/purchase-orders/{ref}', ref: 'number or id' },
    fields: [f('id', 'string', 'Id'), f('relId', 'number|null', 'Relational id'), f('number', 'string|null', 'PO number'), ...company, f('status', 'string', 'draft | approved | declined'), f('supplier', 'object', 'id, name'), f('orderDate', 'date|null', 'Ordered'),
      f('jobNumber', 'string|null', 'Job'), f('quoteNumber', 'string|null', 'Quote'), f('totalExVat', 'number', 'Total ex VAT'), f('receivedAt', 'null', 'Not recorded by SignaCore'), f('expectedArrival', 'null', 'Not recorded by SignaCore'), ...stampsF,
      f('itemCount', 'number', 'Lines (list without items=true)'), f('items', 'array', 'Lines (detail, or list with items=true)', true), f('notes', 'string|null', 'Notes', true)],
    relations: [{ field: 'supplier.id', to: 'suppliers', by: 'id' }, { field: 'jobNumber', to: 'jobs', by: 'number' }, { field: 'items.inventoryRef', to: 'inventory', by: 'ref' }],
  },
  {
    type: 'supplierPrices', label: 'Supplier price history (one stock item)', scope: 'purchasing:read', companyScoped: true, idField: 'poId', numberField: 'poNumber', updatedAtField: null,
    list: { path: '/read/supplier-prices', filters: ['item', 'company'], paginated: false },
    fields: [f('date', 'date|null', 'PO date'), f('poNumber', 'string|null', 'PO number'), f('poId', 'string', 'PO id'), f('poStatus', 'string', 'PO status'), f('companyCode', 'string', 'Company'), f('supplierId', 'string|null', 'Supplier id'),
      f('supplierName', 'string|null', 'Supplier'), f('unitCostExVat', 'number', 'Unit cost ex VAT'), f('qtyOrdered', 'number', 'Quantity'), f('unit', 'string|null', 'Unit'), f('source', 'string', 'relational | platform_state | legacy_json (historical PO, not in the current PO list)')],
    relations: [{ field: 'poNumber', to: 'purchaseOrders', by: 'number' }, { field: 'supplierId', to: 'suppliers', by: 'id' }],
    notes: 'Requires ?item=<inventory id, inv:id or SKU>. Prices come from purchase-order lines.',
  },
  {
    type: 'inventory', label: 'Stock', scope: 'inventory:read', companyScoped: false, idField: 'id', numberField: 'sku', updatedAtField: 'updatedAt',
    list: { path: '/read/inventory', filters: [...COMMON_LIST, 'includeInactive', 'lowStock'], paginated: true },
    fields: [f('ref', 'string', 'Stock reference'), f('id', 'string', 'Id'), f('sku', 'string|null', 'SKU'), f('name', 'string|null', 'Name'), f('category', 'string|null', 'Category'), f('unit', 'string|null', 'Unit'), f('stockOnHand', 'number', 'Recorded on hand'),
      f('reorderLevel', 'number', 'Reorder level (0 = not set)'), f('stockStatus', 'string', 'ok | low | out_of_stock | no_threshold'), f('active', 'boolean', 'Active'), f('reservedQty', 'null', 'Not recorded by SignaCore'), f('availableToPromise', 'null', 'Not recorded by SignaCore'),
      f('supplierId', 'string|null', 'Default supplier'), f('costExVat', 'number', 'Cost (needs purchasing:read)'), f('sellExVat', 'number', 'Selling price (needs pricing:read)'), ...stampsF],
    relations: [{ field: 'supplierId', to: 'suppliers', by: 'id' }],
  },
  {
    type: 'materialOrders', label: 'Materials to Order', scope: 'purchasing:read', companyScoped: true, idField: 'id', numberField: null, updatedAtField: null,
    list: { path: '/read/material-orders', filters: ['page', 'limit', 'q', 'company', 'job', 'supplier', 'scope'], paginated: true },
    fields: [f('id', 'string', '<scope>:<material id> as stored'), f('scope', 'string', 'signacore (every company except Holdings) | holdings'), f('scopeCompanies', 'array', 'Companies the scope covers'),
      f('material', 'string', 'Material'), f('materialKey', 'string|null', 'Set Material List row key'), f('kind', 'string', 'sheet | roll | unit | other | manual'), f('unit', 'string|null', 'Unit of the quantities'), f('size', 'string|null', 'Size (other/manual lines)'),
      f('orderedByJob', 'array', 'Quantities ticked as ordered, per job the client may read'), f('orderedEntriesWithheld', 'number', 'Per-job entries not shown (another company, or a job that no longer exists)'),
      f('supplier', 'string|null', 'Supplier (only when the client may read every company in the scope)'), f('adjust', 'number', 'Manual adjustment'), f('adjustOrdered', 'number', 'Adjustment ordered'), f('orderedAt', 'string|null', 'When ticked'),
      f('manual', 'boolean', 'A manually added line'), f('removed', 'boolean', 'A manual line removed from the table'), f('scopeFieldsWithheld', 'string', 'Present instead of the scope-wide fields when they are withheld'), f('orderedBy', 'null', 'Not exposed')],
    relations: [{ field: 'orderedByJob.jobNumber', to: 'jobs', by: 'number' }],
    notes: 'Totals are not stored: the dashboard recomputes them from the jobs\' Material Lists. Per job: required (jobs.materialList) − ordered (here).',
  },
  {
    type: 'summary', label: 'Per-company summary', scope: 'any-read', companyScoped: true, idField: 'companyCode', numberField: null, updatedAtField: null,
    list: { path: '/read/summary', filters: ['company'], paginated: false },
    fields: [f('companyCode', 'string', 'Company'), f('companyName', 'string|null', 'Name'), f('quotes', 'object', 'Quotes by status (sales:read)'), f('jobs', 'object', 'Jobs (jobs:read)'), f('invoices', 'object', 'Invoices (accounts:read; absent when the company has none)'), f('purchaseOrders', 'object', 'Purchase orders (purchasing:read)'), f('stock', 'object', 'Stock (inventory:read)')],
    notes: 'Each group is present only when the credential holds its scope and the company has such records.',
    relations: [],
  },
];

export const READ_TYPE_BY_TYPE = Object.fromEntries(READ_TYPES.map((t) => [t.type, t]));
