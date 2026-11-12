/**
 * integration-read.stress.ts — /api/v1/integration/read/* (owner read access for CORE-AGENTS).
 *
 * Runs the real integration router against a DISPOSABLE local database (name must end in _test). Apply migrations
 * first. The same invented dataset is served twice: once under platform_state (JSON) authority and once after a real
 * backfill into the relational tables with every section cut over — the answers must match.
 *
 *   DATABASE_URL=postgres://.../signacore_test npx ts-node --transpile-only test/integration-read.stress.ts
 *
 * Money is checked against the dashboard's OWN functions, extracted from index.html at test time.
 */
// Render runs in UTC. SignaCore's relational reader formats DATE columns with toISOString(), which shifts a day in a
// UTC+2 process; pin the zone so this test reproduces production (see the handover note on TZ).
process.env.TZ = 'UTC';
process.env.RELATIONAL_AUTHORITY_ENABLED = 'true';
process.env.INTEGRATION_API_ENABLED = 'true';

import express from 'express';
import fs from 'fs';
import path from 'path';
import type { AddressInfo } from 'net';
import pool from '../src/db/pool';
import router from '../src/integration/router';
import { hashSecret } from '../src/integration/keys';
import { OWNER_READ_SCOPES } from '../src/integration/scopes';
import { runBackfill } from '../src/relational/backfill';

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 500) : ''}`); }
}

// ── the dashboard's own money functions, lifted from index.html ─────────────
function frontendMoney() {
  const html = fs.readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');
  const body = (name: string) => {
    const i = html.indexOf(`function ${name}(`);
    if (i < 0) throw new Error(`index.html has no function ${name}`);
    let depth = 0;
    for (let k = html.indexOf('{', i); k < html.length; k++) {
      if (html[k] === '{') depth++;
      else if (html[k] === '}' && --depth === 0) return html.slice(i, k + 1);
    }
    throw new Error(`unterminated ${name}`);
  };
  const names = ['sgrToUnits4', 'sgrToCents', 'sgrToCents0', 'sgrRands', 'sgrDivRound', 'sgrMulDivRound', 'sgrExtCentsU', 'sgrExtCents',
    'sgrDocLineCents', 'sgrDocumentCents', 'sgrInvoiceCents', 'sgrPaidCents', 'isGenuineZeroAmount', 'sgrSettlementStatusCents',
    'normalizeQuoteDepositPct', 'fmtQuoteDepositPct', 'quoteDepositInfo'];
  const constMatch = html.match(/const QUOTE_DEFAULT_DEPOSIT_PCT\s*=\s*([0-9.]+)/);
  const src = `const QUOTE_DEFAULT_DEPOSIT_PCT = ${constMatch ? constMatch[1] : 80};\n${names.map(body).join('\n')}\nreturn { ${names.join(', ')} };`;
  // eslint-disable-next-line no-new-func
  return new Function(src)() as Record<string, (...a: any[]) => any>;
}

// ── fixtures (invented) ─────────────────────────────────────────────────────
const SECRET = 'test-secret-core-agents-0123456789abcdefghijklmnopqrstu';
const NARROW_SECRET = 'test-secret-narrow-0123456789abcdefghijklmnopqrstuvwxy';
const SALLY_SECRET = 'test-secret-sally-0123456789abcdefghijklmnopqrstuvwxyz';
const quoteLines = [
  { desc: 'Channel letters 600mm (test)', qty: 2, pQty: 1, unitPrice: 4350.5, unit: 'set' },
  { desc: 'Installation labour (test)', qty: 3, unitPrice: 450, unit: 'hr' },
];
const quoteTotalInclVat = 11268.22; // checked against index.html below, not just asserted
const state = {
  customers: [
    { id: 1700000000001, companyName: 'Acme Signs Test (Pty) Ltd', contactPerson: 'Thandi Test', email: 'thandi@acme.test', tel: '044 555 0101', notes: 'INTERNAL-ONLY-NOTE' },
    { id: 1700000000002, companyName: 'Blue Crane Test Cafe', contactPerson: 'Lerato Test', email: 'lerato@bluecrane.test', tel: '082 555 0103' },
  ],
  suppliers: [
    { id: 601, name: 'Aluminium Test Supplies', contactPerson: 'Sipho Test', phone: '021 555 0601', email: 'sales@alu.test', accountNumber: 'SUPPLIER-ACCOUNT-MUST-NOT-LEAK', notes: 'SUPPLIER-INTERNAL-NOTE', paymentTerms: '30 days' },
    { id: 602, name: 'Acrylic Test Co', contactPerson: '', phone: '', email: 'acrylic@test.test' },
  ],
  inventory: [
    { id: 700001, sku: 'ACM-3-WHITE', name: 'ACM board 3mm white (test)', cat: 'Boards', unit: 'sheet', cost: 300, sell: 520, stock: 12, reorder: 5, supplierId: 601 },
    { id: 700002, sku: 'VINYL-GLOSS', name: 'Gloss vinyl 1370mm (test)', cat: 'Vinyl', unit: 'm', cost: 20, sell: 95, stock: 2, reorder: 5, supplierId: 602 },
  ],
  quickRates: [],
  quotes: [
    { id: 3001, co: '2', num: 'SQ-0101', status: 'converted', convertedJobId: 5001, client: 'Acme Signs Test (Pty) Ltd', contact: 'Thandi Test', email: 'thandi@acme.test', date: '2026-09-01', validUntil: '2026-10-01', discount: 5, setupFee: 250, lines: quoteLines },
    { id: 3002, co: '4', num: 'SQ-0101', status: 'sent', client: 'Cover Test Client', date: '2026-10-02', discount: 0, setupFee: 0, lines: [{ desc: 'Vehicle wrap panel (test)', qty: 1, unitPrice: 3000 }] },
    { id: 3003, co: '1', num: 'HQ-0001', status: 'declined', client: 'Holdings Test Client', date: '2026-08-15', discount: 0, setupFee: 0, lines: [{ desc: 'Consulting (test)', qty: 1, unitPrice: 9000 }] },
    { id: 3004, num: 'SQ-0050', status: 'draft', client: 'Older Untagged Client', date: '2025-03-10', discount: 0, setupFee: 0, lines: [{ desc: 'Older quote line (test)', qty: 4, unitPrice: 125.25 }] },
    { id: 3005, co: '2', num: 'SQ-0102', status: 'sent', client: 'Blue Crane Test Cafe', date: '2026-11-01', discount: 0, setupFee: 0, depositPct: 50, lines: [{ desc: 'Lightbox (test)', qty: 1, unitPrice: 8000 }] },
  ],
  jobs: [
    { id: 5001, co: '2', num: 'J-0101', stage: 7, status: 'active', client: 'Acme Signs Test (Pty) Ltd', desc: 'Acme shopfront channel letters (test)', value: quoteTotalInclVat, quoteNum: 'SQ-0101', invoiceNum: 'INV-0101', dueDate: '2026-10-15', lines: quoteLines, discount: 5, setupFee: 250 },
    { id: 5002, co: '4', num: 'J-0102', stage: 9, status: 'invoiced', client: 'Cover Test Client', desc: 'Fleet wrap (test)', value: 11500, invoiceNum: 'CX-INV-0001', invoiceDate: '2026-08-01', invoiceStatus: 'sent', dueDate: '2026-07-20' },
    { id: 5003, co: '1', num: 'J-0103', stage: 1, status: 'active', client: 'Holdings Lead (test)', desc: 'New pylon enquiry (test)', value: 0 },
    { id: 5004, co: '2', num: 'J-0104', stage: 3, status: 'active', client: 'Blue Crane Test Cafe', desc: 'Menu boards (test)', value: 4600, dueDate: '2027-02-01' },
  ],
  accInvoices: [
    { id: 4001, co: '2', number: 'INV-0101', type: 'invoice', status: 'partial', jobId: 5001, quoteId: 3001, contactName: 'Acme Signs Test (Pty) Ltd', contactEmail: 'thandi@acme.test', jobNum: 'J-0101', quoteNum: 'SQ-0101', reference: 'J-0101', date: '2026-10-20', dueDate: '2026-11-01',
      lineItems: [
        { description: 'Channel letters 600mm (test)', qty: 2, unitAmount: 4350.5, taxType: '15%', accountCode: '200' },
        { description: 'Installation labour (test)', qty: 3, unitAmount: 450, taxType: '15%', accountCode: '200' },
        { description: 'Discount 5% (test)', qty: 1, unitAmount: -502.55, taxType: '15%', accountCode: '200' },
        { description: 'Setup fee (test)', qty: 1, unitAmount: 250, taxType: '15%', accountCode: '200' },
      ],
      payments: [{ id: 11, amount: 5000, date: '2026-09-05', method: 'EFT', reference: 'DEP-ACME' }, { id: 12, amount: 2500.5, date: '2026-10-25', method: 'EFT', reference: 'ACME-2' }] },
    { id: 4002, co: '2', number: 'INV-0102', type: 'invoice', status: 'void', contactName: 'Voided Test Client', date: '2026-10-01', dueDate: '2026-10-31', lineItems: [{ description: 'Cancelled work (test)', qty: 1, unitAmount: 1000, taxType: '15%' }], payments: [] },
    { id: 4003, co: '4', number: 'INV-0101', type: 'invoice', status: 'paid', contactName: 'Cover Test Client', date: '2026-09-10', dueDate: '2026-10-10', lineItems: [{ description: 'Panel (test)', qty: 1, unitAmount: 2000, taxType: '15%' }], payments: [{ id: 21, amount: 2300, date: '2026-09-20', method: 'EFT' }] },
    { id: 4004, co: '1', number: 'HINV-0001', type: 'invoice', status: 'sent', contactName: 'Holdings Test Client', date: '2026-11-05', dueDate: '2026-12-05', lineItems: [{ description: 'Management fee (test)', qty: 1, unitAmount: 5000, taxType: '15%' }], payments: [] },
  ],
  creditNotes: [{ id: 8001, co: '2', number: 'CN-0001', type: 'customer', contactName: 'Acme Signs Test (Pty) Ltd', date: '2026-10-30', amount: 500, used: 0, reason: 'Goodwill (test)', status: 'open' }],
  purchaseOrders: [
    { id: 9001, co: '2', num: 'PO-0001', status: 'approved', date: '2026-06-01', supplierId: 601, jobNum: 'J-0101', items: [{ inventoryId: 700001, sku: 'ACM-3-WHITE', name: 'ACM board 3mm white (test)', unit: 'sheet', qtyNeeded: 10, qtyOrdered: 10, unitCost: 280 }] },
    { id: 9002, co: '2', num: 'PO-0002', status: 'approved', date: '2026-09-01', supplierId: 601, items: [{ inventoryId: 700001, sku: 'ACM-3-WHITE', name: 'ACM board 3mm white (test)', unit: 'sheet', qtyNeeded: 5, qtyOrdered: 6, unitCost: 300 }] },
    { id: 9003, co: '4', num: 'PO-0003', status: 'draft', date: '2026-10-10', supplierId: 601, items: [{ inventoryId: 700001, sku: 'ACM-3-WHITE', name: 'ACM board 3mm white (test)', unit: 'sheet', qtyNeeded: 4, qtyOrdered: 4, unitCost: 310 }] },
  ],
  accBills: [{ id: 1, co: '2', number: 'BILL-0001', supplierName: 'Aluminium Test Supplies', status: 'awaiting_payment', date: '2026-10-05', dueDate: '2026-11-04', lineItems: [{ description: 'ACM sheets (test)', qty: 6, unitAmount: 300, taxType: '15%' }], payments: [] }],
  proposedProjects: [{ id: 1, name: 'Mall pylon sign (test)', note: 'Call back in Dec', co: null }, { id: 2, name: 'Holdings HQ signage (test)', note: '', co: '1' }],
  userAccounts: [{ username: 'owner-test', passwordHash: 'PASSWORD-HASH-MUST-NOT-LEAK', role: 'admin' }],
  employees: [{ id: 1, name: 'Employee Test', idNumber: 'EMPLOYEE-ID-MUST-NOT-LEAK', salary: 99999 }],
};
const FORBIDDEN = ['SUPPLIER-ACCOUNT-MUST-NOT-LEAK', 'SUPPLIER-INTERNAL-NOTE', 'PASSWORD-HASH-MUST-NOT-LEAK', 'EMPLOYEE-ID-MUST-NOT-LEAK', 'INTERNAL-ONLY-NOTE', 'secret_hash'];

let base = '';
async function call(method: string, p: string, opts: { client?: string; secret?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Integration-Client': opts.client || 'core-agents-test', Authorization: `Bearer ${opts.secret || SECRET}`, 'Idempotency-Key': 'read-test-key-0001' },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* empty */ }
  return { status: res.status, body: json, text };
}
const get = (p: string, o: { client?: string; secret?: string } = {}) => call('GET', p, o);

async function seed() {
  const db = (await pool.query('SELECT current_database() AS d')).rows[0].d as string;
  if (!db.endsWith('_test')) throw new Error(`Refusing to run against "${db}" — use a *_test database.`);
  await pool.query(`TRUNCATE integration_audit, integration_idempotency, integration_records, integration_clients RESTART IDENTITY`);
  const rel = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'rel\\_%' AND tablename NOT IN ('rel_companies')`);
  await pool.query(`TRUNCATE ${rel.rows.map((r) => r.tablename).join(', ')} RESTART IDENTITY CASCADE`);
  await pool.query(`UPDATE relational_cutover SET enabled = false`);
  await pool.query(`INSERT INTO platform_state (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`, [JSON.stringify(state)]);
  const ins = `INSERT INTO integration_clients (client_id, display_name, secret_hash, scopes, company_code, read_only, read_company_codes) VALUES ($1,$2,$3,$4,$5,$6,$7)`;
  await pool.query(ins, ['core-agents-test', 'CORE-AGENTS (test)', hashSecret(SECRET), [...OWNER_READ_SCOPES], '1', true, ['1', '2', '4']]);
  await pool.query(ins, ['narrow-test', 'Narrow reader (test)', hashSecret(NARROW_SECRET), ['sales:read', 'jobs:read'], '2', true, ['2']]);
  await pool.query(ins, ['sally-test', 'Sally (test)', hashSecret(SALLY_SECRET), ['customer:read', 'product:read', 'inventory:read', 'pricing:read', 'quote:read', 'quote:create', 'quote:update'], '2', false, []]);
}

async function goRelational() {
  const r = await runBackfill({ apply: true, runByNote: 'integration-read test' });
  ok(r.ok, 'backfill into relational tables succeeded', { summary: r.summary, conflicts: r.conflicts.slice(0, 5) });
  await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section IN ('customers','suppliers','inventory','quickRates','quotes','jobs','accInvoices','payments','creditNotes')`);
  // purchaseOrders stays on platform_state: historical POs are never backfilled (backfill PASS 6).
}

const fe = frontendMoney();
const cents = (r: number) => Math.round(r * 100);

async function suite(mode: 'platform_state' | 'relational'): Promise<Record<string, unknown>> {
  console.log(`\n══ ${mode} authority ══`);
  const snapshot: Record<string, unknown> = {};

  console.log('— status, sections, scopes');
  let r = await get('/status');
  ok(r.status === 200 && r.body.client.readOnly === true && JSON.stringify(r.body.client.readCompanies) === '["1","2","4"]', 'reader authenticates; read-only with companies 1,2,4', r.body?.client);
  ok(!r.body.client.scopes.some((s: string) => /create|update/.test(s)), 'reader holds no write scope', r.body.client.scopes);
  r = await get('/read/sections');
  ok(r.status === 200 && r.body.sections.jobs.source === mode && r.body.sections.accBills.source === 'platform_state', `sections report ${mode} authority (bills are JSON-only)`, r.body?.sections);

  console.log('— quote → job → invoice → payment chain');
  r = await get('/read/quotes/SQ-0101?company=2');
  const q = r.body?.quote;
  const feQ = fe.sgrDocumentCents(quoteLines, 5, 250);
  ok(r.status === 200 && q.companyCode === '2' && q.number === 'SQ-0101', 'quote SQ-0101 for Signacore found by number', r.body);
  ok(cents(q.totals.totalInclVat) === feQ.totalC && cents(q.totals.vat) === feQ.vatC && cents(q.totals.discount) === feQ.discC, 'quote totals equal index.html sgrDocumentCents', { api: q?.totals, fe: feQ });
  ok(q.totals.totalInclVat === quoteTotalInclVat, 'quote total is R11,268.22', q?.totals);
  const feDep = fe.quoteDepositInfo({}, q.totals.totalInclVat);
  ok(q.deposit.pct === feDep.pct && cents(q.deposit.amount) === feDep.depositCents, 'deposit equals index.html quoteDepositInfo (80% default)', { api: q.deposit, fe: feDep.depositCents });
  ok(q.links.jobId === '5001' && q.links.jobNumber === 'J-0101' && q.links.invoiceNumbers.includes('INV-0101'), 'quote links to job J-0101 and invoice INV-0101', q.links);
  ok(q.sentAt === null && q.statusLabel === 'Job Created', 'no invented sent date; converted shown as "Job Created"');
  ok(q.lines.length === 2 && q.lines[0].lineTotalExVat === 8701, 'quote lines included on the record view', q.lines);
  r = await get('/read/quotes/SQ-0101');
  ok(r.status === 409 && r.body.error.code === 'AMBIGUOUS_REFERENCE', 'same quote number in two companies without ?company= → 409, never a guess', r.body);

  r = await get('/read/jobs/J-0101');
  const j = r.body?.job;
  ok(r.status === 200 && j.links.quoteId === '3001' && j.links.invoiceId === '4001' && j.links.invoiceLinkState === 'matched', 'job J-0101 links back to quote 3001 and invoice 4001', j?.links);
  ok(j.pastDueDate === true && j.daysPastDue > 0 && j.stageName === 'Installation', 'job past its due date while at Installation is flagged', { pastDue: j?.pastDueDate, days: j?.daysPastDue, stage: j?.stageName });
  ok(j.installationDate === null && j.deliveredAt === null, 'no invented installation or delivery date');
  ok(j.settlement.payableFrom === 'invoice' && j.settlement.paid === 7500.5 && j.settlement.outstanding === 3767.72, 'job settlement uses the invoice: R7,500.50 paid, R3,767.72 outstanding', j?.settlement);

  r = await get('/read/invoices/INV-0101?company=2');
  const inv = r.body?.invoice;
  const feI = fe.sgrInvoiceCents(state.accInvoices[0].lineItems);
  ok(r.status === 200 && cents(inv.totals.totalInclVat) === feI.totalC && cents(inv.totals.vat) === feI.vatC, 'invoice totals equal index.html sgrInvoiceCents', { api: inv?.totals, fe: feI });
  ok(inv.status === 'partial' && inv.paid === 7500.5 && inv.outstanding === 3767.72, 'partially paid invoice: status partial, paid and outstanding exact', { s: inv?.status, p: inv?.paid, o: inv?.outstanding });
  ok(fe.sgrSettlementStatusCents(feI.totalC, fe.sgrPaidCents(inv.payments)) === 'partial', 'index.html settlement status agrees (partial)');
  ok(inv.overdue === true && inv.links.jobId === '5001' && inv.links.quoteId === '3001', 'invoice is overdue and links to job and quote', { overdue: inv?.overdue, links: inv?.links });
  ok(inv.payments.length === 2 && inv.payments.every((p: any) => p.companyCode === '2'), 'invoice lists both payments', inv?.payments);
  snapshot.invoice = { totals: inv.totals, paid: inv.paid, outstanding: inv.outstanding, status: inv.status, links: inv.links };
  snapshot.job = { links: j.links, settlement: j.settlement, pastDue: j.pastDueDate };
  snapshot.quote = { totals: q.totals, deposit: q.deposit, links: q.links };

  console.log('— void, job-derived and cross-company invoices');
  r = await get('/read/invoices?company=2');
  ok(r.status === 200 && !r.body.results.some((x: any) => x.number === 'INV-0102'), 'void invoice hidden from the default list');
  r = await get('/read/invoices?company=2&includeVoid=true');
  const v = r.body.results.find((x: any) => x.number === 'INV-0102');
  ok(v && v.isVoid && v.status === 'void' && v.outstanding === 0, 'void invoice shown with includeVoid, owing nothing', v);
  r = await get('/read/invoices?company=4');
  const jobInv = r.body.results.find((x: any) => x.number === 'CX-INV-0001');
  ok(jobInv && jobInv.source === 'job' && jobInv.status === 'overdue' && jobInv.outstanding === 11500 && jobInv.dueDate === '2026-08-31', 'job invoice with no accounting record listed (due = invoice date + 30 days, overdue)', jobInv);
  const cx = r.body.results.find((x: any) => x.number === 'INV-0101');
  ok(cx && cx.companyCode === '4' && cx.status === 'paid' && cx.outstanding === 0, 'Cover X INV-0101 kept separate from Signacore INV-0101', cx);
  ok(r.body.results.every((x: any) => x.companyCode === '4'), 'company filter returns only that company');

  console.log('— receivables, summary, payments');
  r = await get('/read/receivables?company=2');
  const rc = r.body?.results?.[0];
  ok(r.status === 200 && rc.invoicesOutstanding === 3767.72 && rc.unusedCustomerCredit === 500 && rc.netOwed === 3267.72, 'receivables: outstanding, unused credit and net owed', rc);
  r = await get('/read/summary');
  const s2 = r.body?.results?.find((x: any) => x.companyCode === '2');
  const s4 = r.body?.results?.find((x: any) => x.companyCode === '4');
  // An untagged older quote cannot be backfilled (no company), so under relational authority SignaCore itself no longer shows it.
  const drafts = mode === 'platform_state' ? 1 : 0;
  ok(s2 && s2.jobs.pastDueDate === 1 && s2.invoices.overdueCount === 1 && s2.quotes.sent === 1 && s2.quotes.draft === drafts, `summary for Signacore (untagged older draft quote: ${drafts})`, s2);
  ok(s4 && s4.invoices.overdue === 11500 && s4.purchaseOrders.draft === 1, 'summary for Cover X', s4);
  ok(r.body.results.length === 3 && r.body.dataSource.jobs === mode, 'summary covers the three authorised companies and names its source', r.body?.dataSource);
  snapshot.summaryMoney = r.body.results.map((x: any) => ({ c: x.companyCode, jobs: x.jobs, invoices: x.invoices }));
  r = await get('/read/payments?company=2');
  ok(r.status === 200 && r.body.results.length === 2 && r.body.results.every((p: any) => p.invoiceNumber === 'INV-0101'), 'payments list counts each payment once', r.body?.results);

  console.log('— enquiries, older records, pagination, filters');
  r = await get('/read/enquiries');
  ok(r.status === 200 && r.body.results.some((x: any) => x.kind === 'proposed_project' && x.companyCode === '2' && x.companyTagged === false) && r.body.results.some((x: any) => x.kind === 'job_lead' && x.jobNumber === 'J-0103'), 'enquiries: proposed projects and job leads', r.body?.results);
  r = await get('/read/quotes?company=2&limit=1&page=1');
  const qTotal = mode === 'platform_state' ? 3 : 2;
  ok(r.status === 200 && r.body.results.length === 1 && r.body.total === qTotal && r.body.hasMore === true, `pagination: page 1 of ${qTotal}`, { total: r.body?.total, hasMore: r.body?.hasMore });
  r = await get(`/read/quotes?company=2&limit=1&page=${qTotal}`);
  ok(r.body.results.length === 1 && r.body.hasMore === false, 'pagination: last page');
  if (mode === 'platform_state') ok(r.body.results[0].number === 'SQ-0050' && r.body.results[0].companyTagged === false, 'older untagged quote returned under Signacore (companyTagged:false)', r.body?.results);
  r = await get('/read/quotes?status=sent&from=2026-10-01');
  ok(r.body.results.length === 2 && r.body.results.every((x: any) => x.status === 'sent'), 'status + date filters across companies');
  r = await get('/read/jobs?stage=7&pastDue=true');
  ok(r.body.results.length === 1 && r.body.results[0].number === 'J-0101', 'job stage + pastDue filters');

  console.log('— purchasing and stock');
  r = await get('/read/supplier-prices?item=ACM-3-WHITE');
  ok(r.status === 200 && r.body.history.map((h: any) => h.unitCostExVat).join(',') === '280,300,310' && r.body.item.currentCostExVat === 300, 'supplier price history from PO lines, oldest first, plus current cost', r.body);
  r = await get('/read/supplier-prices?item=ACM-3-WHITE&company=2');
  ok(r.body.history.length === 2, 'price history respects the company filter');
  r = await get('/read/purchase-orders/PO-0002');
  ok(r.status === 200 && r.body.purchaseOrder.totalExVat === 1800 && r.body.purchaseOrder.receivedAt === null && r.body.purchaseOrder.supplier.name === 'Aluminium Test Supplies', 'PO detail: total, supplier, no invented receipt date', r.body?.purchaseOrder);
  r = await get('/read/purchase-orders?status=draft,approved&items=true');
  ok(r.status === 200 && r.body.total === 3 && r.body.results.every((p: any) => Array.isArray(p.items) && p.items[0].sku === 'ACM-3-WHITE'), 'PO list with items=true includes lines', r.body?.results);
  r = await get('/read/payments?company=2');
  ok(r.body.results.find((p: any) => p.reference === 'DEP-ACME')?.owner.number === 'INV-0101', 'payments recorded on the invoice are attributed to the invoice');
  r = await get('/read/inventory?lowStock=true');
  ok(r.status === 200 && r.body.results.length === 1 && r.body.results[0].sku === 'VINYL-GLOSS' && r.body.results[0].costExVat === 20 && r.body.results[0].reservedQty === null, 'low-stock list with cost (purchasing:read); reserved stock not invented', r.body?.results);
  r = await get('/read/suppliers');
  ok(r.status === 200 && r.body.results.length === 2, 'suppliers list');
  r = await get('/read/bills?company=2');
  ok(r.status === 200 && r.body.results[0].outstanding === 2070 && r.body.results[0].overdue === true, 'supplier bill outstanding and overdue', r.body?.results);

  console.log('— company isolation and refusals');
  r = await get('/read/quotes?company=3');
  ok(r.status === 403 && r.body.error.code === 'COMPANY_NOT_AUTHORISED', 'company not in the grant → 403 COMPANY_NOT_AUTHORISED', r.body);
  r = await get('/read/quotes?company=2,3');
  ok(r.status === 403, 'a mixed list containing an unauthorised company is refused, not trimmed');
  r = await get('/read/quotes?company=abc');
  ok(r.status === 400, 'malformed company → 400');
  r = await get('/read/invoices?company=1', { client: 'narrow-test', secret: NARROW_SECRET });
  ok(r.status === 403 && r.body.error.code === 'FORBIDDEN_SCOPE', 'narrow reader without accounts:read cannot read invoices', r.body);
  r = await get('/read/quotes?company=1', { client: 'narrow-test', secret: NARROW_SECRET });
  ok(r.status === 403 && r.body.error.code === 'COMPANY_NOT_AUTHORISED', 'narrow reader (company 2 only) refused company 1', r.body);
  r = await get('/read/quotes/HQ-0001', { client: 'narrow-test', secret: NARROW_SECRET });
  ok(r.status === 404, 'a record id/number from another company is 404, not revealed', r.body);
  r = await get('/read/jobs/5003', { client: 'narrow-test', secret: NARROW_SECRET });
  ok(r.status === 404, 'a job id from another company is 404');
  r = await get('/read/jobs', { client: 'narrow-test', secret: NARROW_SECRET });
  ok(r.status === 200 && r.body.results.every((x: any) => x.companyCode === '2') && r.body.results.length === 2, 'narrow reader lists only company 2 jobs');
  r = await get('/read/quotes', { client: 'sally-test', secret: SALLY_SECRET });
  ok(r.status === 403 && r.body.error.code === 'FORBIDDEN_SCOPE', 'Sally (no sales:read) gains nothing from the new endpoints');

  console.log('— writes refused');
  r = await call('POST', '/quotes', { body: { customer: { id: 1700000000001 }, lines: [] } });
  ok(r.status === 403 && r.body.error.code === 'READ_ONLY_CLIENT', 'reader POST /quotes → 403 READ_ONLY_CLIENT', r.body);
  r = await call('PATCH', '/customers/1700000000001', { body: { phone: '1' } });
  ok(r.status === 403 && r.body.error.code === 'READ_ONLY_CLIENT', 'reader PATCH → 403 READ_ONLY_CLIENT');
  r = await call('POST', '/read/quotes', { client: 'sally-test', secret: SALLY_SECRET, body: {} });
  ok(r.status === 405 && r.body.error.code === 'READ_ONLY_ENDPOINT', 'POST to a read endpoint → 405 even for a write-capable client', r.body);

  console.log('— nothing sensitive leaks');
  const dump = [
    await get('/read/suppliers'), await get('/read/customers'), await get('/read/summary'), await get('/read/purchase-orders/PO-0001'),
    await get('/read/quotes/SQ-0101?company=2'), await get('/read/jobs/J-0101'), await get('/read/invoices/INV-0101?company=2'), await get('/read/sections'),
  ].map((x) => x.text).join('\n');
  const leaked = FORBIDDEN.filter((f) => dump.includes(f));
  ok(leaked.length === 0, 'no account numbers, notes, password hashes, employee data or secrets in responses', leaked);

  console.log('— existing Sally behaviour unchanged');
  r = await get('/products?q=acm', { client: 'sally-test', secret: SALLY_SECRET });
  ok(r.status === 200 && r.body.results.length >= 1, 'Sally product search still works', r.body);
  r = await get('/inventory/inv:700001', { client: 'sally-test', secret: SALLY_SECRET });
  ok(r.status === 200 && r.body.stock.onHand === 12, 'Sally stock check still works', r.body);
  r = await get('/quotes?limit=5', { client: 'sally-test', secret: SALLY_SECRET });
  if (mode === 'relational') ok(r.status === 200 && r.body.results.every((x: any) => String(x.companyCode ?? '2') === '2'), 'Sally quote list still works, own company only', r.body);
  else ok(r.status === 409 && r.body.error.code === 'SECTION_NOT_RELATIONAL', 'Sally quote list refuses under JSON authority, exactly as before', r.body);

  return snapshot;
}

async function main() {
  await seed();
  const app = express();
  app.use(express.json());
  app.use('/api/v1/integration', router);
  const server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/integration`;

  console.log('\n— database guards');
  let threw = false;
  try {
    await pool.query(`INSERT INTO integration_clients (client_id, display_name, secret_hash, scopes, company_code, read_only) VALUES ('bad1','x','x',ARRAY['quote:create'],'2',true)`);
  } catch { threw = true; }
  ok(threw, 'DB refuses a read-only client holding a write scope');
  threw = false;
  try {
    await pool.query(`INSERT INTO integration_clients (client_id, display_name, secret_hash, scopes, company_code, read_only, read_company_codes) VALUES ('bad2','x','x',ARRAY['quote:create'],'2',false,ARRAY['1','2'])`);
  } catch { threw = true; }
  ok(threw, 'DB refuses multi-company access on a write-capable client');

  const a = await suite('platform_state');
  await goRelational();
  const b = await suite('relational');

  console.log('\n— deposits recorded on jobs (relational chain) are attributed to the job, not the invoice');
  const relJob = async (sid: string) => (await pool.query(`SELECT id FROM rel_jobs WHERE source_id = $1`, [sid])).rows[0].id;
  const addPay = async (jobSid: string, amount: number, ref: string) => pool.query(
    `INSERT INTO rel_payments (owner_type, owner_id, line_index, amount, payment_date, method, reference)
     VALUES ('job', $1, COALESCE((SELECT MAX(line_index) + 1 FROM rel_payments WHERE owner_type = 'job' AND owner_id = $1), 0), $2, '2026-11-02', 'EFT', $3)`,
    [await relJob(jobSid), amount, ref]);
  await addPay('5004', 2300, 'DEP-BLUECRANE');
  await addPay('5001', 100, 'TOPUP-ACME');
  let rp = await get('/read/payments?company=2');
  const blue = rp.body?.results?.filter((p: any) => p.reference === 'DEP-BLUECRANE') || [];
  const acme = rp.body?.results?.filter((p: any) => p.reference === 'TOPUP-ACME') || [];
  ok(blue.length === 1 && blue[0].owner.type === 'job' && blue[0].owner.number === 'J-0104' && blue[0].invoiceNumber === null, 'deposit on a job with no invoice: listed once, owner J-0104', blue);
  ok(acme.length === 1 && acme[0].owner.type === 'job' && acme[0].owner.number === 'J-0101' && acme[0].invoiceNumber === 'INV-0101', 'job payment carried by its invoice: listed once, owner J-0101, invoice INV-0101', acme);
  rp = await get('/read/jobs/J-0104');
  ok(rp.body?.job?.deposit.required === 4600 && rp.body.job.deposit.received === 2300 && rp.body.job.deposit.met === false, 'J-0104 deposit: R4,600 required (total ≤ R5,000 → 100%), R2,300 received, not met', rp.body?.job?.deposit);
  rp = await get('/read/invoices/INV-0101?company=2');
  ok(rp.body?.invoice?.paid === 7600.5 && rp.body.invoice.outstanding === 3667.72, 'invoice INV-0101 counts the job payment in its chain', { paid: rp.body?.invoice?.paid, out: rp.body?.invoice?.outstanding });

  console.log('\n— purchase orders cut over to relational (historical POs not migrated)');
  await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section = 'purchaseOrders'`);
  let r = await get('/read/supplier-prices?item=ACM-3-WHITE');
  ok(r.status === 200 && r.body.dataSource.purchaseOrders === 'relational' && r.body.history.length === 3 && r.body.history.every((h: any) => h.source === 'legacy_json') && r.body.notes?.length === 1,
    'price history keeps pre-migration PO lines, each labelled legacy_json', r.body);
  r = await get('/read/purchase-orders');
  ok(r.status === 200 && r.body.total === 0 && r.body.dataSource.purchaseOrders === 'relational', 'PO list matches the dashboard (relational only, no legacy POs mixed in)', r.body);
  await pool.query(`UPDATE relational_cutover SET enabled = false WHERE section = 'purchaseOrders'`);
  console.log('\n— both authorities give the same answers');
  for (const k of Object.keys(a)) ok(JSON.stringify(a[k]) === JSON.stringify(b[k]), `${k} identical under JSON and relational authority`, { json: a[k], relational: b[k] });

  console.log(`\n${passed} passed, ${failures} failed`);
  const servePort = Number(process.env.READ_TEST_SERVE_PORT || 0);
  if (servePort && !failures) {
    // Cross-repo check (CORE-AGENTS connector): keep serving the seeded relational fixture with invented test secrets.
    server.close();
    app.get('/health', (_req, res) => { res.json({ status: 'ok', integrationApiEnabled: true }); });
    app.listen(servePort, '127.0.0.1', () => console.log(`Serving the read-test fixture on http://127.0.0.1:${servePort} (clients core-agents-test, narrow-test, sally-test). Ctrl+C to stop.`));
    return;
  }
  server.close();
  await pool.end();
  process.exit(failures ? 1 : 0);
}
main().catch(async (err) => { console.error(err); await pool.end().catch(() => undefined); process.exit(1); });
