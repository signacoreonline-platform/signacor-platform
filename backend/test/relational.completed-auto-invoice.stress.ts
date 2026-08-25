/**
 * relational.completed-auto-invoice.stress.ts
 * ───────────────────────────────────────────
 * COMPLETED → AUTO-INVOICE (2026-08-25)
 *
 * THE BUSINESS RULE BEING PROVED
 *   When a Job PROGRESSES INTO Completed, the system must ensure that EXACTLY
 *   ONE valid invoice exists for that Job — reusing one if there already is
 *   one, creating exactly one if there is not — and the Job then progresses to
 *   Invoiced. Nobody has to click "Create Invoice" afterwards.
 *
 * THE TRIGGER IS A TRANSITION, NOT A STATE (2026-08-25 correction)
 *   "Has just reached Completed" and "is sitting at Completed" are different
 *   facts, and only the first is an event. Anything that decided from hydrated
 *   state — a useEffect scanning the jobs array for stage === Completed —
 *   cannot tell them apart, so app startup, a login, a browser refresh, an
 *   authoritative rehydration, a company switch, or simply opening an old job
 *   would all raise invoices for HISTORICAL work nobody asked to invoice.
 *   The trigger is therefore the CONFIRMED stage transition inside
 *   advanceStage() — the one place a job actually crosses into Completed, and
 *   a deliberate click. Jobs already sitting at Completed are untouched and
 *   keep the existing explicit Create Invoice action. Cases 23 and 24 below
 *   prove both halves: the transition does fire it, and nothing else can.
 *
 * WHAT IS NEW, AND WHAT DELIBERATELY IS NOT
 *   New: services.ts's ensureInvoiceForJob() and POST /jobs/:id/ensure-invoice,
 *   plus the frontend lifecycle effect that calls it. All three are thin: the
 *   invoice itself is written by the SAME jobInvoiceTx the explicit "Create
 *   Invoice" action already used, in 'ensure' mode instead of 'create' mode.
 *   There is no second financial writer, no second numbering path, and no
 *   relaxed guard — this suite exists largely to prove that negative.
 *
 *   Not new, and asserted here as still-armed: the migration-013 historical
 *   pieces protection (SAFE_TO_RECOVER resolves, MISMATCH / AMBIGUOUS refuse),
 *   the job-value vs invoice-total consistency guard, the atomic INV-#####
 *   reservation, proforma reservation safety, company isolation, and the
 *   row-lock/row_version concurrency protections.
 *
 * COVERAGE (numbered to match the brief's required tests)
 *    1  Completed job, no invoice          → exactly one created, job Invoiced
 *    2  Completed job, linked manual invoice → reused, zero created
 *    2b reference-only "match"             → NOT adopted (a new invoice is raised)
 *    3  Completed job, existing system invoice → reused
 *    4  ghost invoice fields, no canonical record → controlled refusal
 *    5  ambiguous linkage                  → no guessed invoice
 *    6  no payment                         → works
 *    7  partial payment                    → works
 *    8  full payment                       → works
 *    9  pieces > 1                         → financially correct
 *   10  historical SAFE_TO_RECOVER pieces  → financially correct
 *   11  historical MISMATCH / AMBIGUOUS    → refused safely
 *   12  job total vs invoice total mismatch→ rollback
 *   13  setup fee / discount / VAT         → correct exactly once
 *   14  the job's OWN proforma reservation → preserved
 *   15  an unrelated proforma reservation  → protected
 *   16  retry / double-click               → one invoice
 *   17  concurrent attempts                → one invoice
 *   18  company 2 isolation                → correct
 *   19  company 1 (Holdings) isolation     → correct
 *   20  refresh                            → same canonical job/invoice link
 *   21  explicit Create Invoice            → still works, contract unchanged
 *   22  REST: POST /jobs/:id/ensure-invoice end to end + cutover gating
 *   23  THE TRIGGER — the real advanceStage() executed: only a confirmed
 *       transition INTO Completed invoices; a job already there, a refused
 *       stage write, another stage, JSON authority and a half-open cutover
 *       gate all invoice nothing; a refused invoice leaves the transition
 *       standing; a double-click yields one attempt
 *   24  NOTHING ELSE can start it — one call site, no useEffect, no hydration,
 *       refresh or company-switch path can reach it
 *
 * SAFETY: refuses to run unless DATABASE_URL is local (or ALLOW_UNSAFE_TEST_DB=1).
 * It owns the rel_* tables and platform_state row 1 in the TEST database only.
 *
 * Usage (from backend/):
 *   DATABASE_URL=postgresql://user:pass@localhost:5432/signacore_test \
 *   TEST_SERVER_URL_WITH_AUTHORITY=http://127.0.0.1:5001 \
 *   npx ts-node --transpile-only test/relational.completed-auto-invoice.stress.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import pool from '../src/db/pool';
import * as services from '../src/relational/services';
import { buildJobsJson } from '../src/relational/read';

const DB_URL = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(DB_URL) && process.env.ALLOW_UNSAFE_TEST_DB !== '1') {
  console.error('[completed-auto-invoice] Refusing to run: DATABASE_URL does not look like a local test database.');
  console.error('[completed-auto-invoice] Set ALLOW_UNSAFE_TEST_DB=1 only if you are certain this is a disposable test DB.');
  process.exit(1);
}
const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH || path.resolve(__dirname, '..', '..', 'index.html');
const BASE = process.env.TEST_SERVER_URL_WITH_AUTHORITY || '';

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}
function money(n: unknown): number { return Math.round((Number(n) || 0) * 100) / 100; }
function eqMoney(a: unknown, b: unknown): boolean { return Math.abs(money(a) - money(b)) < 0.005; }

const CO = '2';                 // Signacore (Original)
const CO_HOLDINGS = '1';        // Holdings

/** The stage the app calls "Completed". Read from index.html's own stage table
 *  rather than hardcoded here, so this suite can never drift from the app's
 *  definition of the stage that triggers everything below. */
function completedStageFromSource(src: string): number {
  const m = /const STAGE_STATUSES\s*=\s*\[([^\]]*)\]/.exec(src);
  if (!m) throw new Error('could not find STAGE_STATUSES in index.html');
  const list = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  const idx = list.indexOf('completed');
  if (idx < 0) throw new Error('STAGE_STATUSES has no "completed" entry');
  return idx;
}
function stageIndexFromSource(src: string, status: string): number {
  const m = /const STAGE_STATUSES\s*=\s*\[([^\]]*)\]/.exec(src);
  const list = m![1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  return list.indexOf(status);
}
function invoicedStageFromSource(src: string): number { return stageIndexFromSource(src, 'invoiced'); }

async function reset() {
  await pool.query(`
    TRUNCATE TABLE rel_payments, rel_invoice_line_items, rel_invoices, rel_job_line_items,
      rel_jobs, rel_quote_line_items, rel_quotes, rel_credit_notes, rel_customers
    RESTART IDENTITY CASCADE
  `);
  await pool.query(`DELETE FROM document_number_counters`);
  await pool.query(`DELETE FROM quote_conversions`);
  await pool.query(`UPDATE platform_state SET data = '{}'::jsonb WHERE id = 1`);
}

async function invoiceCount(): Promise<number> {
  return (await pool.query('SELECT COUNT(*)::int AS n FROM rel_invoices')).rows[0].n;
}
async function invoiceTotals(invoiceId: number) {
  const r = (await pool.query(
    `SELECT COALESCE(SUM(qty * unit_amount), 0) AS subtotal,
            COALESCE(SUM(CASE WHEN tax_type = '15%' THEN qty * unit_amount * 0.15 ELSE 0 END), 0) AS vat,
            COUNT(*)::int AS line_count
       FROM rel_invoice_line_items WHERE invoice_id = $1`, [invoiceId])).rows[0];
  return { subtotal: Number(r.subtotal), vat: Number(r.vat), total: Number(r.subtotal) + Number(r.vat), lineCount: r.line_count };
}
async function invoiceLines(invoiceId: number) {
  return (await pool.query(
    `SELECT line_index, description, qty, unit_amount, tax_type
       FROM rel_invoice_line_items WHERE invoice_id = $1 ORDER BY line_index`, [invoiceId])).rows;
}
async function jobRow(jobId: number) {
  return (await pool.query(
    `SELECT job_number, company_code, stage, status, value, invoice_num, invoice_created, invoice_status, row_version
       FROM rel_jobs WHERE id = $1`, [jobId])).rows[0];
}
async function counterFor(company: string): Promise<number> {
  const r = await pool.query(
    `SELECT last_number FROM document_number_counters WHERE company = $1 AND doc_type = 'invoice'`, [company]);
  return r.rowCount ? Number(r.rows[0].last_number) : 0;
}


/* ── FRONTEND EXTRACTION ────────────────────────────────────────────────────
   The trigger correction lives in index.html, in two functions inside the
   JobDetail component. Source-text assertions alone would not prove that the
   guard actually holds, so both are lifted out by brace-matching and RUN in a
   VM context whose collaborators (relationalApi, setJobs, alert, …) record what
   they are asked to do. Same extraction convention proforma-frontend-logic.
   test.ts already uses; it works for nested functions too, which is what lets
   a component-local function be tested without a browser. */
function extractFrontendFunction(src: string, name: string): string {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) throw new Error(`Could not find function ${name} in index.html — has it been renamed/removed?`);
  const parenStart = src.indexOf('(', m.index);
  let pdepth = 0, j = parenStart;
  for (; j < src.length; j++) {
    if (src[j] === '(') pdepth++;
    else if (src[j] === ')') { pdepth--; if (pdepth === 0) { j++; break; } }
  }
  const braceStart = src.indexOf('{', j);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(m.index, i);
}
function extractFrontendConst(src: string, name: string): string {
  const re = new RegExp(`const\\s+${name}\\s*=[\\s\\S]*?;`);
  const m = re.exec(src);
  if (!m) throw new Error(`Could not find const ${name} in index.html — has it been renamed/removed?`);
  return m[0];
}

interface HarnessOpts {
  job: any;
  ensureResult?: any;
  ensureError?: any;
  updateJobError?: any;
  authority?: { jobs: boolean; accInvoices: boolean };
  /** Make the fake API calls take real time, so concurrent clicks genuinely overlap. */
  slow?: boolean;
}

/**
 * Builds a runner for index.html's REAL advanceStage() with its REAL
 * ensureInvoiceOnCompletedTransition(), against recording stand-ins.
 *
 * The JobDetail locals the two functions close over are supplied exactly as the
 * component computes them: `isLast` is stage >= Invoiced, and `LOCKED_STAGES`
 * is the base [Deposit Received, Invoiced] pair for an ordinary (non-zero-value,
 * non-waived) job — the two system-controlled stages an operator can never
 * activate by hand. Nothing about the lifecycle is re-implemented here.
 */
function buildTransitionHarness(src: string) {
  const code = [
    extractFrontendConst(src, 'STAGE_STATUSES'),
    extractFrontendConst(src, 'STATUS_TO_STAGE'),
    extractFrontendConst(src, 'COMPLETED_STAGE'),
    extractFrontendFunction(src, 'classifySaveError'),
    extractFrontendFunction(src, 'describeSaveConflictError'),
    extractFrontendFunction(src, 'ensureInvoiceOnCompletedTransition'),
    extractFrontendFunction(src, 'advanceStage'),
  ].join('\n\n');

  return function harness(opts: HarnessOpts) {
    const calls = {
      updateJob: [] as any[],
      ensureInvoiceForJob: [] as any[],
      syncRelationalBaseline: [] as string[],
      invoiceCreatedInfo: [] as any[],
      alert: [] as string[],
    };
    const authority = opts.authority ?? { jobs: true, accInvoices: true };
    const state: { jobs: any[] } = { jobs: [{ ...opts.job }] };
    const wait = () => (opts.slow ? new Promise((r) => setTimeout(r, 15)) : Promise.resolve());

    const sandbox: any = {
      console, setTimeout, Promise, Date, Object, Array, String, Number, JSON,
      job: { ...opts.job },
      isLast: (opts.job.stage ?? 0) >= 9,
      advancing: false,
      LOCKED_STAGES: [5, 9],
      setAdvancing: (v: boolean) => { sandbox.advancing = v; },
      setJobs: (updater: any) => { state.jobs = typeof updater === 'function' ? updater(state.jobs) : updater; },
      syncRelationalBaseline: (section: string) => { calls.syncRelationalBaseline.push(section); },
      setInvoiceCreatedInfo: (info: any) => { calls.invoiceCreatedInfo.push(info); },
      isRelationalAuthoritative: (s: string) => (authority as any)[s] === true,
      alert: (m: string) => { calls.alert.push(m); },
      relationalApi: {
        async updateJob(id: any, expectedVersion: any, patch: any) {
          await wait();
          calls.updateJob.push({ id, expectedVersion, patch });
          if (opts.updateJobError) throw opts.updateJobError;
          return { rowVersion: (Number(expectedVersion) || 0) + 1 };
        },
        async ensureInvoiceForJob(id: any) {
          await wait();
          calls.ensureInvoiceForJob.push(id);
          if (opts.ensureError) throw opts.ensureError;
          return opts.ensureResult ?? {
            invoiceId: 1, invoiceNumber: 'INV-00001', created: true, reused: false,
            jobRowVersion: 9, jobStage: 9, jobStatus: 'invoiced',
          };
        },
      },
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    try {
      vm.runInContext(`${code}\nglobalThis.__advanceStage = advanceStage;`, sandbox, { filename: 'index.html-jobdetail.js' });
    } catch (e: any) {
      throw new Error(`Extracted JobDetail source failed to evaluate — index.html likely changed shape: ${e.message}`);
    }
    return {
      calls,
      get jobs() { return state.jobs; },
      advanceStage: () => sandbox.__advanceStage(),
    };
  };
}

interface JobFx { quoteId: number; quoteNumber: string; jobId: number; jobNumber: string; jobValue: number; quoteTotal: number }

/** A quote converted to a job and parked at Completed — the exact state the new
 *  rule fires on. Nothing here reaches into invoicing. */
async function makeCompletedJob(opts: {
  companyCode?: string; client?: string; setupFee?: number; discountPct?: number; stage?: number;
  lines: Array<{ description: string; qty: number; unitPrice: number; pieces?: number | null }>;
}): Promise<JobFx> {
  const companyCode = opts.companyCode ?? CO;
  const name = opts.client ?? 'Completed Job Client';
  const cust = await services.createCustomer({ companyName: name });
  const quote = await services.createQuote({
    companyCode, customerId: cust.id, customerNameRaw: name,
    setupFee: opts.setupFee ?? 0, discountPct: opts.discountPct ?? 0,
    lines: opts.lines.map((l) => ({
      description: l.description, qty: l.qty, unitPrice: l.unitPrice, unit: 'ea',
      pieces: l.pieces === undefined ? null : l.pieces,
    })),
  } as any);
  const conv = await services.convertQuoteToJob(quote.id);
  await pool.query('UPDATE rel_jobs SET stage = $1, status = $2 WHERE id = $3',
    [opts.stage ?? COMPLETED_STAGE, 'completed', conv.jobId]);
  const q = (await pool.query('SELECT total FROM rel_quotes WHERE id = $1', [quote.id])).rows[0];
  const j = (await pool.query('SELECT value, job_number FROM rel_jobs WHERE id = $1', [conv.jobId])).rows[0];
  // Number() on both ids deliberately: rel_* PKs are BIGINT, which node-postgres
  // returns as a STRING. services.ts's signatures are typed `id: number` and
  // api.ts coerces with Number() at the route, so a fixture that passed the raw
  // string would be testing a shape the product never sees.
  return {
    quoteId: Number(quote.id), quoteNumber: quote.quoteNumber, jobId: Number(conv.jobId), jobNumber: j.job_number,
    jobValue: Number(j.value), quoteTotal: Number(q.total),
  };
}

/** Turn a job's lines into the shape a pre-migration-013 backfill left behind:
 *  the pieces column NULL, the original line preserved in legacy_data. Same
 *  helper shape as relational.historical-pieces-invoice-protection.stress.ts. */
async function makeHistoricalJobLines(jobId: number) {
  const rows = (await pool.query(
    `SELECT id, description, qty, unit_price, pieces FROM rel_job_line_items WHERE job_id = $1 ORDER BY line_index`, [jobId])).rows;
  for (const r of rows) {
    await pool.query(
      `UPDATE rel_job_line_items SET legacy_data = $2::jsonb, pieces = NULL WHERE id = $1`,
      [r.id, JSON.stringify({
        desc: r.description, qty: Number(r.qty), unitPrice: Number(r.unit_price),
        pQty: r.pieces === null ? undefined : Number(r.pieces),
      })]
    );
  }
}

let COMPLETED_STAGE = 8;
let INVOICED_STAGE = 9;
let INSTALLATION_STAGE = 7;

async function login(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.TEST_LOGIN_EMAIL || 'test@signacore.local', password: process.env.TEST_LOGIN_PASSWORD || 'testpass' }),
  });
  if (!res.ok) throw new Error(`login failed against ${baseUrl}: HTTP ${res.status}`);
  return (await res.json()).token;
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  COMPLETED_STAGE = completedStageFromSource(src);
  INVOICED_STAGE = invoicedStageFromSource(src);
  INSTALLATION_STAGE = stageIndexFromSource(src, 'installation');
  console.log(`\n[lifecycle] index.html defines Completed as stage ${COMPLETED_STAGE} ('completed') and Invoiced as stage ${INVOICED_STAGE} ('invoiced')`);
  ok(COMPLETED_STAGE === 8 && INVOICED_STAGE === 9 && INSTALLATION_STAGE === 7,
    'the stage table still runs Installation → Completed → Invoiced (the assumption the whole rule rests on)',
    { INSTALLATION_STAGE, COMPLETED_STAGE, INVOICED_STAGE });

  // ══ 1 — Completed job with no invoice ════════════════════════════════════
  console.log('\n[1] Completed job with NO invoice → exactly one invoice created, job becomes Invoiced');
  await reset();
  {
    const fx = await makeCompletedJob({ lines: [{ description: 'Pylon sign', qty: 2, unitPrice: 1500, pieces: 1 }] });
    const before = await counterFor(CO);
    const r = await services.ensureInvoiceForJob(fx.jobId);
    ok(r.created === true && r.reused === false, 'the call reports that it CREATED the invoice', { created: r.created, reused: r.reused });
    ok((await invoiceCount()) === 1, 'exactly one invoice exists', await invoiceCount());
    ok(/^INV-\d{5}$/.test(r.invoiceNumber), 'it carries a properly formatted INV number from the atomic pool', r.invoiceNumber);
    ok((await counterFor(CO)) === before + 1, 'exactly one number was consumed', { before, after: await counterFor(CO) });
    const j = await jobRow(fx.jobId);
    ok(Number(j.stage) === INVOICED_STAGE && j.status === 'invoiced', 'the job progressed to Invoiced', { stage: j.stage, status: j.status });
    ok(j.invoice_num === r.invoiceNumber && j.invoice_created === true, 'and is linked to that invoice', j);
    ok(Number(r.jobStage) === INVOICED_STAGE && r.jobStatus === 'invoiced',
      'the response reports the job stage/status the server actually wrote (never assumed client-side)', { jobStage: r.jobStage, jobStatus: r.jobStatus });
    const t = await invoiceTotals(r.invoiceId);
    ok(eqMoney(t.total, fx.jobValue), 'the invoice adds up to the job value exactly', { inv: money(t.total), job: money(fx.jobValue) });
    const inv = (await pool.query('SELECT job_id, job_number_raw, reference, quote_id FROM rel_invoices WHERE id = $1', [r.invoiceId])).rows[0];
    ok(Number(inv.job_id) === fx.jobId && inv.job_number_raw === fx.jobNumber && inv.reference === fx.jobNumber,
      'the invoice is fully linked back to the job (job_id, job_number_raw and the reference de-dup key)', inv);
    ok(Number(inv.quote_id) === fx.quoteId, 'and keeps its quote linkage', inv.quote_id);
  }

  // ══ 2 — a valid, correctly-linked manual invoice is reused ═══════════════
  console.log('\n[2] Completed job with an existing correctly-linked MANUAL invoice → reused, zero new invoices');
  await reset();
  {
    const fx = await makeCompletedJob({ lines: [{ description: 'Lightbox', qty: 1, unitPrice: 4000, pieces: 1 }] });
    // A manual (Accounting) invoice, then linked to the job the way the manual
    // flow links one. Deliberately a DIFFERENT amount from the job: reuse must
    // preserve the existing document exactly, never re-derive it.
    const manual = await services.createManualInvoice({
      companyCode: CO, contactName: 'Completed Job Client', reference: fx.jobNumber,
      lines: [{ description: 'Agreed lump sum', qty: 1, unitAmount: 3500, accountCode: '4000', taxType: '15%' }],
    });
    await pool.query('UPDATE rel_invoices SET job_id = $1, job_number_raw = $2 WHERE id = $3', [fx.jobId, fx.jobNumber, manual.id]);
    await services.recordPayment({ type: 'invoice', id: manual.id }, 1000, { method: 'EFT' });
    const beforeCount = await invoiceCount();
    const beforeCounter = await counterFor(CO);

    const r = await services.ensureInvoiceForJob(fx.jobId);
    ok(r.created === false && r.reused === true, 'the call reports that it REUSED an existing invoice', { created: r.created, reused: r.reused });
    ok(Number(r.invoiceId) === Number(manual.id) && r.invoiceNumber === manual.invoiceNumber, 'the same invoice id and number are returned', { got: r.invoiceNumber, expected: manual.invoiceNumber });
    ok((await invoiceCount()) === beforeCount, 'no second invoice was created', { before: beforeCount, after: await invoiceCount() });
    ok((await counterFor(CO)) === beforeCounter, 'and no invoice number was consumed', { before: beforeCounter, after: await counterFor(CO) });
    const t = await invoiceTotals(manual.id);
    ok(eqMoney(t.total, 3500 * 1.15) && t.lineCount === 1, 'its lines and amount are untouched — nothing was re-derived from the job', t);
    const pays = (await pool.query(`SELECT COALESCE(SUM(amount),0) AS total FROM rel_payments WHERE owner_type='invoice' AND owner_id=$1`, [manual.id])).rows[0];
    ok(eqMoney(pays.total, 1000), 'its payments are preserved', pays.total);
    const j = await jobRow(fx.jobId);
    ok(j.invoice_num === manual.invoiceNumber && j.invoice_created === true, 'the job is linked to that existing invoice', j);
    ok(Number(j.stage) === INVOICED_STAGE && j.status === 'invoiced', 'and still progresses to Invoiced', { stage: j.stage, status: j.status });
  }

  // ══ 2b — a reference-only "match" must NOT be adopted ════════════════════
  console.log('\n[2b] an unlinked invoice that merely mentions the job number in its free-text reference → NOT adopted');
  await reset();
  {
    const fx = await makeCompletedJob({ lines: [{ description: 'Fascia', qty: 1, unitPrice: 2000, pieces: 1 }] });
    // Free text a person typed. It belongs to someone else entirely.
    const stranger = await services.createManualInvoice({
      companyCode: CO, contactName: 'A Completely Different Customer', reference: fx.jobNumber,
      lines: [{ description: 'Their work', qty: 1, unitAmount: 999, accountCode: '4000', taxType: '15%' }],
    });
    const r = await services.ensureInvoiceForJob(fx.jobId);
    ok(r.created === true, 'a NEW invoice is raised for the job', { created: r.created });
    ok(Number(r.invoiceId) !== Number(stranger.id), 'the stranger’s invoice was not absorbed into this job', { got: r.invoiceId, stranger: stranger.id });
    const strangerRow = (await pool.query('SELECT job_id, contact_name FROM rel_invoices WHERE id = $1', [stranger.id])).rows[0];
    ok(strangerRow.job_id === null && strangerRow.contact_name === 'A Completely Different Customer',
      'and it was not relinked or rewritten in any way', strangerRow);
  }

  // ══ 3 — an existing SYSTEM invoice is reused ═════════════════════════════
  console.log('\n[3] Completed job that was already invoiced by the system → reused, zero new invoices');
  await reset();
  {
    const fx = await makeCompletedJob({ lines: [{ description: 'Wall letters', qty: 4, unitPrice: 300, pieces: 1 }] });
    const first = await services.createInvoiceForJob(fx.jobId);   // the explicit action
    const beforeCount = await invoiceCount();
    const beforeCounter = await counterFor(CO);

    const r = await services.ensureInvoiceForJob(fx.jobId);
    ok(r.created === false && r.reused === true && Number(r.invoiceId) === Number(first.invoiceId),
      'the same system invoice is resolved and reused', { got: r.invoiceNumber, expected: first.invoiceNumber });
    ok((await invoiceCount()) === beforeCount && (await counterFor(CO)) === beforeCounter,
      'no invoice and no number were created', { invoices: await invoiceCount(), counter: await counterFor(CO) });
  }

  // ══ 4 — GHOST invoice fields with no canonical record ════════════════════
  console.log('\n[4] ghost linkage (marked invoiced, number recorded, no invoice record) → controlled refusal, nothing guessed');
  await reset();
  {
    const fx = await makeCompletedJob({ lines: [{ description: 'Signboard', qty: 1, unitPrice: 5000, pieces: 1 }] });
    await pool.query(
      `UPDATE rel_jobs SET invoice_num = 'INV-09999', invoice_created = true WHERE id = $1`, [fx.jobId]);
    const beforeCounter = await counterFor(CO);
    let msg = '', name = '';
    try { await services.ensureInvoiceForJob(fx.jobId); } catch (e: any) { msg = String(e && e.message); name = e && e.name; }
    ok(name === 'BusinessRuleError', 'it refuses with a controlled business-rule error, not a crash', { name, msg: msg.slice(0, 120) });
    ok(/already marked as invoiced/.test(msg) && /no invoice record with that number exists/.test(msg),
      'and the message says exactly what is inconsistent', msg.slice(0, 200));
    ok((await invoiceCount()) === 0, 'no invoice was created', await invoiceCount());
    ok((await counterFor(CO)) === beforeCounter, 'no invoice number was consumed', { before: beforeCounter, after: await counterFor(CO) });
    const j = await jobRow(fx.jobId);
    ok(Number(j.stage) === COMPLETED_STAGE, 'and the job stays at Completed rather than being shown as Invoiced', j.stage);

    // The same ghost shape WITHOUT the invoice_created flag is the established
    // pre-cutover "job invoice with no accounting record" case, which the
    // deployed writer reconstructs. That behaviour is unchanged, and available
    // to ensure too — this is what "safely resolvable" means here.
    await pool.query(`UPDATE rel_jobs SET invoice_created = false WHERE id = $1`, [fx.jobId]);
    const r2 = await services.ensureInvoiceForJob(fx.jobId);
    ok(r2.invoiceNumber === 'INV-09999' && r2.created === true,
      'with only a recorded number (no invoiced flag) the record is rebuilt under that SAME number', r2.invoiceNumber);
    ok((await counterFor(CO)) === beforeCounter, 'still without consuming a number from the pool', { before: beforeCounter, after: await counterFor(CO) });
  }

  // ══ 5 — AMBIGUOUS linkage ═══════════════════════════════════════════════
  console.log('\n[5] ambiguous linkage (the job names one invoice, a different invoice is linked to it) → no guessed invoice');
  await reset();
  {
    const fx = await makeCompletedJob({ lines: [{ description: 'Totem', qty: 1, unitPrice: 7000, pieces: 1 }] });
    const real = await services.createManualInvoice({
      companyCode: CO, contactName: 'Completed Job Client',
      lines: [{ description: 'Totem', qty: 1, unitAmount: 7000, accountCode: '4000', taxType: '15%' }],
    });
    await pool.query('UPDATE rel_invoices SET job_id = $1 WHERE id = $2', [fx.jobId, real.id]);
    // ...but the job itself insists on a different number.
    await pool.query(`UPDATE rel_jobs SET invoice_num = 'INV-04242', invoice_created = true WHERE id = $1`, [fx.jobId]);
    const beforeCount = await invoiceCount();
    const beforeCounter = await counterFor(CO);

    let msg = '', name = '';
    try { await services.ensureInvoiceForJob(fx.jobId); } catch (e: any) { msg = String(e && e.message); name = e && e.name; }
    ok(name === 'LegacyInvoiceConflictError', 'it refuses as a legacy/linkage conflict, which the API reports distinctly', { name });
    ok(/INV-04242/.test(msg) && new RegExp(real.invoiceNumber).test(msg),
      'the message names BOTH disagreeing numbers so a person can decide', msg.slice(0, 220));
    ok((await invoiceCount()) === beforeCount, 'no invoice was created', { before: beforeCount, after: await invoiceCount() });
    ok((await counterFor(CO)) === beforeCounter, 'no number was consumed', { before: beforeCounter, after: await counterFor(CO) });
    const untouched = (await pool.query('SELECT job_id, invoice_number FROM rel_invoices WHERE id = $1', [real.id])).rows[0];
    ok(Number(untouched.job_id) === fx.jobId && untouched.invoice_number === real.invoiceNumber,
      'and the invoice that IS linked was neither renumbered nor unlinked', untouched);
  }

  // ══ 6 / 7 / 8 — payment must never gate invoicing ════════════════════════
  console.log('\n[6,7,8] payment position is irrelevant — no payment / partial / full all invoice');
  for (const scenario of [
    { label: 'no payment', pay: 0 },
    { label: 'partial payment (deposit)', pay: 0.4 },
    { label: 'full payment', pay: 1 },
  ]) {
    await reset();
    const fx = await makeCompletedJob({ lines: [{ description: 'Banner', qty: 2, unitPrice: 1250, pieces: 1 }] });
    if (scenario.pay > 0) {
      await services.recordPayment({ type: 'job', id: fx.jobId }, money(fx.jobValue * scenario.pay), { method: 'EFT' });
    }
    const r = await services.ensureInvoiceForJob(fx.jobId);
    ok(r.created === true && (await invoiceCount()) === 1, `${scenario.label}: exactly one invoice is created`, { created: r.created, n: await invoiceCount() });
    const j = await jobRow(fx.jobId);
    ok(Number(j.stage) === INVOICED_STAGE, `${scenario.label}: the job still progresses to Invoiced`, j.stage);
    const t = await invoiceTotals(r.invoiceId);
    ok(eqMoney(t.total, fx.jobValue), `${scenario.label}: for the full job value — a payment never reduces what is invoiced`, { inv: money(t.total), job: money(fx.jobValue) });
    const paid = (await pool.query(`SELECT COALESCE(SUM(amount),0) AS total FROM rel_payments WHERE owner_type='job' AND owner_id=$1`, [fx.jobId])).rows[0];
    ok(eqMoney(paid.total, fx.jobValue * scenario.pay), `${scenario.label}: the recorded payments are preserved exactly`, paid.total);
  }

  // ══ 9 / 13 — pieces > 1, setup fee, discount, VAT ════════════════════════
  console.log('\n[9,13] pieces × qty × unit price, with the setup fee and discount applied exactly once and VAT correct');
  await reset();
  {
    const fx = await makeCompletedJob({
      lines: [
        { description: 'Panel', qty: 2, unitPrice: 250, pieces: 4 },
        { description: 'Bracket', qty: 3, unitPrice: 120, pieces: 2 },
      ],
      setupFee: 350, discountPct: 7.5,
    });
    const r = await services.ensureInvoiceForJob(fx.jobId);
    const lines = await invoiceLines(r.invoiceId);
    ok(eqMoney(lines[0].qty, 8) && eqMoney(lines[0].unit_amount, 250), 'line 1 bills pieces × qty (4 × 2) at the true unit price', { qty: Number(lines[0].qty), unit: Number(lines[0].unit_amount) });
    ok(eqMoney(lines[1].qty, 6) && eqMoney(lines[1].unit_amount, 120), 'line 2 bills 2 × 3 at its own unit price', { qty: Number(lines[1].qty), unit: Number(lines[1].unit_amount) });
    const discountLines = lines.filter((l: any) => /discount/i.test(l.description));
    const setupLines = lines.filter((l: any) => /setup/i.test(l.description));
    ok(discountLines.length === 1, 'the discount appears exactly once, as its own line', discountLines.map((l: any) => l.description));
    ok(Number(discountLines[0].unit_amount) < 0, 'and is negative', Number(discountLines[0].unit_amount));
    ok(setupLines.length === 1 && eqMoney(setupLines[0].unit_amount, 350), 'the setup fee appears exactly once, at its full value', setupLines.map((l: any) => ({ d: l.description, a: Number(l.unit_amount) })));
    const t = await invoiceTotals(r.invoiceId);
    ok(eqMoney(t.vat, t.subtotal * 0.15), 'VAT is 15% of the invoice subtotal', { vat: money(t.vat), sub: money(t.subtotal) });
    ok(eqMoney(t.total, fx.jobValue) && eqMoney(t.total, fx.quoteTotal),
      'and the invoice total equals both the job value and the quote it came from', { inv: money(t.total), job: money(fx.jobValue), quote: money(fx.quoteTotal) });
  }

  // ══ 10 — historical SAFE_TO_RECOVER pieces ══════════════════════════════
  console.log('\n[10] historical job whose piece counts are recoverable → automatic invoice is financially correct');
  await reset();
  {
    const fx = await makeCompletedJob({ lines: [{ description: 'ACP', qty: 2, unitPrice: 1600, pieces: 4 }], setupFee: 250 });
    await makeHistoricalJobLines(fx.jobId);   // pieces column NULLed, source preserved
    const nulls = (await pool.query('SELECT COUNT(*)::int AS n FROM rel_job_line_items WHERE job_id = $1 AND pieces IS NULL', [fx.jobId])).rows[0].n;
    ok(nulls === 1, 'the fixture really is in the pre-013 shape (pieces column NULL)', nulls);
    const r = await services.ensureInvoiceForJob(fx.jobId);
    const t = await invoiceTotals(r.invoiceId);
    ok(eqMoney(t.total, fx.jobValue),
      'the recovered piece count is used, so the invoice matches the job value instead of under-charging', { inv: money(t.total), job: money(fx.jobValue) });
    const lines = await invoiceLines(r.invoiceId);
    ok(eqMoney(lines[0].qty, 8), 'the billed qty is the recovered 4 × 2, not 1 × 2', Number(lines[0].qty));
    const stillNull = (await pool.query('SELECT pieces FROM rel_job_line_items WHERE job_id = $1', [fx.jobId])).rows[0];
    ok(stillNull.pieces === null, 'and the source job line was NOT rewritten — recovery resolves, it does not migrate', stillNull);
  }

  // ══ 11 — historical MISMATCH / AMBIGUOUS ════════════════════════════════
  console.log('\n[11] historical MISMATCH and AMBIGUOUS piece counts → the automatic invoice is refused, never guessed');
  await reset();
  {
    // MISMATCH: the preserved source describes a different line.
    const fx = await makeCompletedJob({ lines: [{ description: 'Edited line', qty: 2, unitPrice: 1600, pieces: 4 }], setupFee: 250 });
    await pool.query(
      `UPDATE rel_job_line_items SET pieces = NULL, legacy_data = $2::jsonb WHERE job_id = $1`,
      [fx.jobId, JSON.stringify({ desc: 'Edited line', qty: 99, unitPrice: 1600, pQty: 4 })]);
    const beforeCounter = await counterFor(CO);
    let msg = '';
    try { await services.ensureInvoiceForJob(fx.jobId); } catch (e: any) { msg = String(e && e.message); }
    ok(/cannot be invoiced yet/.test(msg) && /MISMATCH/.test(msg),
      'MISMATCH refuses automatic invoicing with the same message the explicit path gives', msg.slice(0, 160));
    ok((await invoiceCount()) === 0, 'nothing was created', await invoiceCount());
    ok((await counterFor(CO)) === beforeCounter, 'and no number was consumed', { before: beforeCounter, after: await counterFor(CO) });
    ok(Number((await jobRow(fx.jobId)).stage) === COMPLETED_STAGE, 'the job is not shown as Invoiced', (await jobRow(fx.jobId)).stage);
  }
  await reset();
  {
    // AMBIGUOUS: two preserved sources that disagree, both plausible.
    const fx = await makeCompletedJob({ lines: [{ description: 'Two sources', qty: 2, unitPrice: 1600, pieces: 4 }], setupFee: 250 });
    await pool.query(
      `UPDATE rel_job_line_items SET pieces = NULL, legacy_data = $2::jsonb WHERE job_id = $1`,
      [fx.jobId, JSON.stringify({ desc: 'Two sources', qty: 2, unitPrice: 1600, pQty: 4 })]);
    const srcId = (await pool.query('SELECT source_id FROM rel_jobs WHERE id = $1', [fx.jobId])).rows[0].source_id;
    await pool.query(`UPDATE platform_state SET data = $1::jsonb WHERE id = 1`, [JSON.stringify({
      jobs: [{ id: Number(srcId), num: fx.jobNumber, co: Number(CO), lines: [{ desc: 'Two sources', qty: 2, unitPrice: 1600, pQty: 6 }] }],
    })]);
    let msg = '';
    try { await services.ensureInvoiceForJob(fx.jobId); } catch (e: any) { msg = String(e && e.message); }
    ok(/cannot be invoiced yet/.test(msg) && /AMBIGUOUS/.test(msg),
      'AMBIGUOUS refuses too — two sources that disagree are never averaged or preferred', msg.slice(0, 160));
    ok((await invoiceCount()) === 0, 'nothing was created', await invoiceCount());
    await pool.query(`UPDATE platform_state SET data = '{}'::jsonb WHERE id = 1`);
  }

  // ══ 12 — job value vs invoice total mismatch rolls back ═════════════════
  console.log('\n[12] job value vs the invoice it would produce disagree → ROLLBACK, nothing committed');
  await reset();
  {
    const fx = await makeCompletedJob({ lines: [{ description: 'Fascia', qty: 3, unitPrice: 400, pieces: 2 }] });
    // Nothing preserved anywhere: the piece count is simply gone, so the derived
    // invoice would be half the job's declared value.
    await pool.query(`UPDATE rel_job_line_items SET pieces = NULL, legacy_data = '{}'::jsonb WHERE job_id = $1`, [fx.jobId]);
    const beforeCounter = await counterFor(CO);
    let msg = '';
    try { await services.ensureInvoiceForJob(fx.jobId); } catch (e: any) { msg = String(e && e.message); }
    ok(/does not add up to its source is never issued/.test(msg), 'the financial consistency guard refuses it', msg.slice(0, 140));
    ok((await invoiceCount()) === 0, 'no invoice survives the rollback', await invoiceCount());
    const j = await jobRow(fx.jobId);
    ok(j.invoice_num === null && j.invoice_created === false && Number(j.stage) === COMPLETED_STAGE,
      'and the job is completely untouched — no number stamped, not marked invoiced, stage unchanged', j);
    ok((await counterFor(CO)) === beforeCounter, 'no invoice number was consumed', { before: beforeCounter, after: await counterFor(CO) });
  }

  // ══ 14 — the job's OWN proforma reservation ═════════════════════════════
  console.log('\n[14] the job’s own source-quote proforma reservation is preserved');
  await reset();
  {
    // 14a — the reservation was already finalised into a real invoice before
    // the job existed. That invoice IS the job's invoice: reused verbatim, and
    // the reserved number is what the job ends up carrying.
    const cust = await services.createCustomer({ companyName: 'Proforma Client' });
    const quote = await services.createQuote({
      companyCode: CO, customerId: cust.id, customerNameRaw: 'Proforma Client', status: 'approved',
      lines: [{ description: 'Signage', qty: 1, unitPrice: 8000, unit: 'ea', pieces: 1 }],
    } as any);
    const finalised = await services.createInvoiceFromQuote(Number(quote.id));
    const conv = await services.convertQuoteToJob(Number(quote.id));
    const convJobId = Number(conv.jobId);
    await pool.query('UPDATE rel_jobs SET stage = $1, status = $2 WHERE id = $3', [COMPLETED_STAGE, 'completed', convJobId]);
    const beforeCount = await invoiceCount();
    const beforeCounter = await counterFor(CO);

    const r = await services.ensureInvoiceForJob(convJobId);
    ok(r.created === false && Number(r.invoiceId) === Number(finalised.invoiceId),
      'the quote’s own invoice is reused rather than a second one being raised', { got: r.invoiceNumber, expected: finalised.invoiceNumber });
    ok((await invoiceCount()) === beforeCount, 'no new invoice', { before: beforeCount, after: await invoiceCount() });
    ok((await counterFor(CO)) === beforeCounter, 'and no new number — the reservation is what the job is invoiced under', { before: beforeCounter, after: await counterFor(CO) });
    const j = await jobRow(convJobId);
    ok(j.invoice_num === finalised.invoiceNumber, 'the job carries that exact number', j.invoice_num);
  }
  await reset();
  {
    // 14b — an UNFINALISED reservation on the job's own quote. Established
    // behaviour for the job path is to reserve a fresh number and leave the
    // reservation alone; what must never happen is the reservation being burnt
    // or silently re-issued to someone else.
    const fx = await makeCompletedJob({ client: 'Reserved Client', lines: [{ description: 'Wrap', qty: 1, unitPrice: 3000, pieces: 1 }] });
    await pool.query(`UPDATE rel_quotes SET proforma_num = 'PRO-00007' WHERE id = $1`, [fx.quoteId]);
    await pool.query(
      `INSERT INTO document_number_counters (company, doc_type, last_number) VALUES ($1, 'invoice', 7)
         ON CONFLICT (company, doc_type) DO UPDATE SET last_number = 7`, [CO]);
    await pool.query(`UPDATE platform_state SET data = $1::jsonb WHERE id = 1`, [JSON.stringify({
      quotes: [{ id: 1, num: fx.quoteNumber, co: Number(CO), proformaNum: 'PRO-00007' }],
    })]);

    const r = await services.ensureInvoiceForJob(fx.jobId);
    ok(r.invoiceNumber !== 'INV-00007', 'the job does not consume the number its own proforma reserves', r.invoiceNumber);
    ok(r.invoiceNumber === 'INV-00008', 'it takes the next free number from the same atomic counter', r.invoiceNumber);
    const q = (await pool.query('SELECT proforma_num FROM rel_quotes WHERE id = $1', [fx.quoteId])).rows[0];
    ok(q.proforma_num === 'PRO-00007', 'and the reservation itself is left exactly as it was', q);
    await pool.query(`UPDATE platform_state SET data = '{}'::jsonb WHERE id = 1`);
  }

  // ══ 15 — an UNRELATED proforma reservation is protected ═════════════════
  console.log('\n[15] an unrelated quote’s proforma reservation cannot be consumed by this job’s invoice');
  await reset();
  {
    const fx = await makeCompletedJob({ client: 'Unrelated Job Client', lines: [{ description: 'Board', qty: 1, unitPrice: 1000, pieces: 1 }] });
    // INV-00101 and INV-00102 are used; PRO-00103 reserves 00103 for a
    // completely different quote — exactly the brief's example.
    await pool.query(
      `INSERT INTO document_number_counters (company, doc_type, last_number) VALUES ($1, 'invoice', 102)
         ON CONFLICT (company, doc_type) DO UPDATE SET last_number = 102`, [CO]);
    await pool.query(`UPDATE platform_state SET data = $1::jsonb WHERE id = 1`, [JSON.stringify({
      accInvoices: [{ id: 1, number: 'INV-00101', co: Number(CO) }, { id: 2, number: 'INV-00102', co: Number(CO) }],
      quotes: [{ id: 9, num: 'SQ-09999', co: Number(CO), proformaNum: 'PRO-00103' }],
    })]);

    const r = await services.ensureInvoiceForJob(fx.jobId);
    ok(r.invoiceNumber !== 'INV-00103', 'INV-00103 is NOT issued to this job', r.invoiceNumber);
    ok(r.invoiceNumber === 'INV-00104', 'the reserved number is skipped and the next free one is used', r.invoiceNumber);
    await pool.query(`UPDATE platform_state SET data = '{}'::jsonb WHERE id = 1`);
  }

  // ══ 16 — retry / double-click ═══════════════════════════════════════════
  console.log('\n[16] repeated attempts (retry, double-click, a second browser tab) → still exactly one invoice');
  await reset();
  {
    const fx = await makeCompletedJob({ lines: [{ description: 'Sign', qty: 1, unitPrice: 2500, pieces: 1 }] });
    const beforeCounter = await counterFor(CO);
    const a = await services.ensureInvoiceForJob(fx.jobId);
    const b = await services.ensureInvoiceForJob(fx.jobId);
    const c = await services.ensureInvoiceForJob(fx.jobId);
    ok(a.invoiceId === b.invoiceId && b.invoiceId === c.invoiceId, 'every attempt resolves to the same invoice', { a: a.invoiceId, b: b.invoiceId, c: c.invoiceId });
    ok(a.created === true && b.created === false && c.created === false, 'only the first one created anything', { a: a.created, b: b.created, c: c.created });
    ok((await invoiceCount()) === 1, 'exactly one invoice exists', await invoiceCount());
    ok((await counterFor(CO)) === beforeCounter + 1, 'exactly one document number was consumed in total', { before: beforeCounter, after: await counterFor(CO) });
  }

  // ══ 17 — concurrent attempts ════════════════════════════════════════════
  console.log('\n[17] two concurrent ensure attempts on the same job → one invoice, one number');
  await reset();
  {
    const fx = await makeCompletedJob({ lines: [{ description: 'Sign', qty: 1, unitPrice: 2500, pieces: 1 }] });
    const beforeCounter = await counterFor(CO);
    const results = await Promise.allSettled([
      services.ensureInvoiceForJob(fx.jobId),
      services.ensureInvoiceForJob(fx.jobId),
      services.ensureInvoiceForJob(fx.jobId),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    ok(fulfilled.length === 3, 'all three calls succeed — a concurrent attempt is not an error, it is a no-op', results.map((r) => r.status));
    const ids = new Set(fulfilled.map((r) => Number(r.value.invoiceId)));
    ok(ids.size === 1, 'they all resolve to the SAME invoice', Array.from(ids));
    ok(fulfilled.filter((r) => r.value.created).length === 1, 'exactly one of them created it', fulfilled.map((r) => r.value.created));
    ok((await invoiceCount()) === 1, 'exactly one invoice exists in the database', await invoiceCount());
    ok((await counterFor(CO)) === beforeCounter + 1, 'exactly one number was consumed', { before: beforeCounter, after: await counterFor(CO) });
  }

  // ══ 18 / 19 — company isolation ═════════════════════════════════════════
  console.log('\n[18,19] company 2 and company 1 (Holdings) invoice independently, from their own counters');
  await reset();
  {
    const co2 = await makeCompletedJob({ companyCode: CO, client: 'Original Client', lines: [{ description: 'Job A', qty: 1, unitPrice: 1000, pieces: 1 }] });
    const co1 = await makeCompletedJob({ companyCode: CO_HOLDINGS, client: 'Holdings Client', lines: [{ description: 'Job B', qty: 1, unitPrice: 2000, pieces: 1 }] });
    const r2 = await services.ensureInvoiceForJob(co2.jobId);
    const r1 = await services.ensureInvoiceForJob(co1.jobId);
    ok((await invoiceCount()) === 2, 'one invoice each', await invoiceCount());
    const i2 = (await pool.query('SELECT company_code, job_id FROM rel_invoices WHERE id = $1', [r2.invoiceId])).rows[0];
    const i1 = (await pool.query('SELECT company_code, job_id FROM rel_invoices WHERE id = $1', [r1.invoiceId])).rows[0];
    ok(i2.company_code === CO && Number(i2.job_id) === co2.jobId, 'the company-2 invoice belongs to company 2 and to its own job', i2);
    ok(i1.company_code === CO_HOLDINGS && Number(i1.job_id) === co1.jobId, 'the Holdings invoice belongs to company 1 and to its own job', i1);
    ok((await counterFor(CO)) === 1 && (await counterFor(CO_HOLDINGS)) === 1,
      'each company advanced only its OWN counter — the two numbering series never touch',
      { co2: await counterFor(CO), co1: await counterFor(CO_HOLDINGS) });
    ok(r2.invoiceNumber === r1.invoiceNumber,
      'so both legitimately hold the same number, in different companies (the pre-existing per-company rule)', { co2: r2.invoiceNumber, co1: r1.invoiceNumber });
  }

  // ══ 20 — refresh: the canonical relationship is what a re-read shows ════
  console.log('\n[20] an authoritative re-read shows the same single canonical job/invoice relationship');
  await reset();
  {
    const fx = await makeCompletedJob({ lines: [{ description: 'Sign', qty: 2, unitPrice: 900, pieces: 3 }] });
    const r = await services.ensureInvoiceForJob(fx.jobId);
    const jobs = await buildJobsJson();
    const hydrated = jobs.find((j: any) => Number(j._relId) === fx.jobId);
    ok(!!hydrated, 'the job is present in the authoritative read');
    ok(hydrated.invoiceLinkState === 'matched', 'its invoice link resolves as canonical "matched" — not orphaned, not ambiguous', hydrated.invoiceLinkState);
    ok(Number(hydrated.invoiceRelId) === Number(r.invoiceId), 'pointing at the one invoice that was raised', { got: hydrated.invoiceRelId, expected: r.invoiceId });
    ok(hydrated.invoiceNum === r.invoiceNumber && hydrated.invoiceCreated === true, 'with the number and the created flag agreeing', { num: hydrated.invoiceNum, created: hydrated.invoiceCreated });
    ok(hydrated.stage === INVOICED_STAGE && hydrated.status === 'invoiced', 'and the job reading as Invoiced', { stage: hydrated.stage, status: hydrated.status });
    // ...and running the rule again after that "refresh" changes nothing.
    const again = await services.ensureInvoiceForJob(fx.jobId);
    ok(Number(again.invoiceId) === Number(r.invoiceId) && again.created === false && (await invoiceCount()) === 1,
      'a second pass after the refresh reuses the same invoice', { n: await invoiceCount() });
  }

  // ══ 21 — the explicit action is unchanged ═══════════════════════════════
  console.log('\n[21] the explicit "Create Invoice" action still works, with its contract unchanged');
  await reset();
  {
    const fx = await makeCompletedJob({ lines: [{ description: 'Sign', qty: 1, unitPrice: 4500, pieces: 2 }], setupFee: 100, discountPct: 5 });
    const r = await services.createInvoiceForJob(fx.jobId);
    ok(r.created === true && (await invoiceCount()) === 1, 'it creates exactly one invoice', { created: r.created, n: await invoiceCount() });
    const t = await invoiceTotals(r.invoiceId);
    ok(eqMoney(t.total, fx.jobValue), 'financially identical to what the automatic path produces', { inv: money(t.total), job: money(fx.jobValue) });
    let msg = '';
    try { await services.createInvoiceForJob(fx.jobId); } catch (e: any) { msg = String(e && e.message); }
    ok(/already has invoice/.test(msg),
      'and clicking it again on an already-invoiced job still refuses with the same message it always did — the explicit contract is untouched', msg.slice(0, 120));
    ok((await invoiceCount()) === 1, 'nothing extra was created by that refusal', await invoiceCount());
    // The automatic path, on the very same job, resolves instead of refusing —
    // this is the ONLY behavioural difference between the two modes.
    const e = await services.ensureInvoiceForJob(fx.jobId);
    ok(e.created === false && Number(e.invoiceId) === Number(r.invoiceId),
      'while the automatic path resolves the same invoice instead of refusing — the one intended difference', { got: e.invoiceId, expected: r.invoiceId });
  }

  // ══ 22 — REST ═══════════════════════════════════════════════════════════
  if (!BASE) {
    console.log('\n[22] REST proof SKIPPED — TEST_SERVER_URL_WITH_AUTHORITY not set.');
  } else {
    console.log('\n[22] REST: POST /api/relational/jobs/:id/ensure-invoice');
    await reset();
    await pool.query(`UPDATE relational_cutover SET enabled = false`);
    const token = await login(BASE);
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

    const fx = await makeCompletedJob({ lines: [{ description: 'REST sign', qty: 1, unitPrice: 3000, pieces: 1 }] });

    const gated = await fetch(`${BASE}/api/relational/jobs/${fx.jobId}/ensure-invoice`, { method: 'POST', headers });
    const gatedBody: any = await gated.json();
    ok(gated.status === 409 && gatedBody.type === 'not_cut_over',
      'it refuses with 409 not_cut_over while the sections are not cut over — an automatic step can never write where the explicit one may not',
      { status: gated.status, body: gatedBody });
    ok((await invoiceCount()) === 0, 'and wrote nothing', await invoiceCount());

    await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section IN ('jobs','accInvoices')`);
    const res1 = await fetch(`${BASE}/api/relational/jobs/${fx.jobId}/ensure-invoice`, { method: 'POST', headers });
    const body1: any = await res1.json();
    ok(res1.status === 200 && body1.success === true && body1.created === true,
      'once cut over it succeeds and reports that it created the invoice', { status: res1.status, body: body1 });
    ok(/^INV-\d{5}$/.test(body1.invoiceNumber), 'returning the reserved invoice number', body1.invoiceNumber);
    ok(body1.jobStage === INVOICED_STAGE && body1.jobStatus === 'invoiced',
      'and the job stage/status the server actually wrote', { jobStage: body1.jobStage, jobStatus: body1.jobStatus });

    const res2 = await fetch(`${BASE}/api/relational/jobs/${fx.jobId}/ensure-invoice`, { method: 'POST', headers });
    const body2: any = await res2.json();
    ok(res2.status === 200 && body2.created === false && Number(body2.invoiceId) === Number(body1.invoiceId),
      'a repeated request over HTTP reuses it instead of creating a second', { body: body2 });
    ok((await invoiceCount()) === 1, 'exactly one invoice exists after both requests', await invoiceCount());

    // The explicit endpoint is still there and still refuses this job.
    const explicit = await fetch(`${BASE}/api/relational/jobs/${fx.jobId}/create-invoice`, { method: 'POST', headers });
    const explicitBody: any = await explicit.json();
    ok(explicit.status === 409 && /already has invoice/.test(String(explicitBody.error)),
      'POST /create-invoice still exists and still refuses an already-invoiced job', { status: explicit.status, body: explicitBody });

    await pool.query(`UPDATE relational_cutover SET enabled = false`);
    await reset();
  }

  // ══ 23 — THE TRIGGER: a genuine transition into Completed, and nothing else ═
  //
  // This is the part that matters most. "Has just reached Completed" and "is
  // sitting at Completed" are different facts, and only the first one is an
  // event — so the trigger is the CONFIRMED stage transition inside
  // advanceStage(), never a scan of hydrated state. The real advanceStage() and
  // ensureInvoiceOnCompletedTransition() are lifted out of index.html and RUN
  // here against a recording stand-in for relationalApi, so what follows proves
  // behaviour rather than merely the shape of the source.
  console.log('\n[23] the trigger is the transition INTO Completed — executed, not just inspected');
  {
    const harness = buildTransitionHarness(src);

    // ── T1 — a real transition into Completed, with no existing invoice ────
    {
      const h = harness({
        job: { id: 7, num: 'SNS-00110', stage: INSTALLATION_STAGE, status: 'installation', _relId: 42, _relRowVersion: 3 },
        ensureResult: { invoiceId: 900, invoiceNumber: 'INV-00112', created: true, reused: false, jobRowVersion: 5, jobStage: INVOICED_STAGE, jobStatus: 'invoiced' },
      });
      await h.advanceStage();
      ok(h.calls.updateJob.length === 1 && h.calls.updateJob[0].patch.stage === COMPLETED_STAGE,
        'advancing from Installation writes stage → Completed', h.calls.updateJob);
      ok(h.calls.ensureInvoiceForJob.length === 1 && h.calls.ensureInvoiceForJob[0] === 42,
        'and THAT transition calls ensureInvoiceForJob exactly once, with the real relational PK', h.calls.ensureInvoiceForJob);
      ok(h.jobs[0].stage === INVOICED_STAGE && h.jobs[0].status === 'invoiced',
        'the job ends up Invoiced, using the stage/status the SERVER returned', { stage: h.jobs[0].stage, status: h.jobs[0].status });
      ok(h.jobs[0].invoiceNum === 'INV-00112' && h.jobs[0].invoiceCreated === true && h.jobs[0]._relRowVersion === 5,
        'linked to the returned invoice, carrying the server’s confirmed row_version', h.jobs[0]);
      ok(h.calls.syncRelationalBaseline.length === 2,
        'local state and the relational baseline move together for BOTH writes — so no legacy platform_state save is ever attempted', h.calls.syncRelationalBaseline.length);
      ok(h.calls.invoiceCreatedInfo.length === 1 && h.calls.invoiceCreatedInfo[0].invoiceNum === 'INV-00112',
        'and the "invoice created" confirmation names the new invoice', h.calls.invoiceCreatedInfo);
      ok(h.calls.alert.length === 0, 'nothing is reported as a failure', h.calls.alert);
    }

    // ── T2 — the same transition when a valid invoice already exists ──────
    {
      const h = harness({
        job: { id: 7, num: 'SNS-00110', stage: INSTALLATION_STAGE, status: 'installation', _relId: 42, _relRowVersion: 3 },
        ensureResult: { invoiceId: 55, invoiceNumber: 'INV-00099', created: false, reused: true, jobRowVersion: 5, jobStage: INVOICED_STAGE, jobStatus: 'invoiced' },
      });
      await h.advanceStage();
      ok(h.calls.ensureInvoiceForJob.length === 1, 'the transition still resolves the job’s invoice');
      ok(h.jobs[0].invoiceNum === 'INV-00099' && h.jobs[0].stage === INVOICED_STAGE,
        'the EXISTING invoice is linked and the job still becomes Invoiced', h.jobs[0]);
      ok(h.calls.invoiceCreatedInfo.length === 0,
        'and nothing is announced as newly created, because nothing was — `created:false` is a correct, silent outcome', h.calls.invoiceCreatedInfo);
    }

    // ── T3 — every other advance leaves invoicing alone ───────────────────
    for (const from of [3, 5, 6]) {
      const h = harness({ job: { id: 7, stage: from, status: 'x', _relId: 42, _relRowVersion: 3 } });
      await h.advanceStage();
      ok(h.calls.updateJob.length === 1 && h.calls.updateJob[0].patch.stage === from + 1,
        `advancing ${from} → ${from + 1} writes the stage`, h.calls.updateJob[0].patch);
      ok(h.calls.ensureInvoiceForJob.length === 0,
        `and does NOT touch invoicing — only the step INTO Completed does`, h.calls.ensureInvoiceForJob);
    }

    // ── T4 — a job ALREADY at Completed can never reach the trigger ───────
    {
      const h = harness({ job: { id: 7, num: 'SNS-00001', stage: COMPLETED_STAGE, status: 'completed', _relId: 42, _relRowVersion: 3 } });
      await h.advanceStage();
      ok(h.calls.updateJob.length === 0 && h.calls.ensureInvoiceForJob.length === 0,
        'clicking Advance on a job that is ALREADY Completed does nothing at all — Invoiced is system-controlled and locked',
        { updateJob: h.calls.updateJob.length, ensure: h.calls.ensureInvoiceForJob.length });
    }
    {
      const h = harness({ job: { id: 7, stage: INVOICED_STAGE, status: 'invoiced', _relId: 42, _relRowVersion: 3 } });
      await h.advanceStage();
      ok(h.calls.ensureInvoiceForJob.length === 0, 'and an already-Invoiced job is the end of the lifecycle');
    }

    // ── T5 — a transition the server did not confirm invoices nothing ─────
    {
      const h = harness({
        job: { id: 7, stage: INSTALLATION_STAGE, status: 'installation', _relId: 42, _relRowVersion: 3 },
        updateJobError: Object.assign(new Error('stale'), { status: 409, body: { type: 'stale_record' } }),
      });
      await h.advanceStage();
      ok(h.calls.ensureInvoiceForJob.length === 0,
        'a REFUSED stage write raises no invoice — the transition never happened', h.calls.ensureInvoiceForJob);
      ok(h.calls.alert.length === 1 && /was NOT advanced/.test(h.calls.alert[0]), 'and the user is told the stage did not move', h.calls.alert);
      ok(h.jobs[0].stage === INSTALLATION_STAGE, 'the job is left exactly where it was', h.jobs[0].stage);
    }

    // ── T6 — the cutover double gate ─────────────────────────────────────
    {
      const h = harness({
        job: { id: 7, stage: INSTALLATION_STAGE, status: 'installation', _relId: 42, _relRowVersion: 3 },
        authority: { jobs: true, accInvoices: false },
      });
      await h.advanceStage();
      ok(h.calls.updateJob.length === 1, 'the stage still advances when only "jobs" is cut over');
      ok(h.calls.ensureInvoiceForJob.length === 0,
        'but no invoice is attempted while accInvoices is not — an automatic step never writes where the explicit one may not');
    }
    {
      const h = harness({
        job: { id: 7, stage: INSTALLATION_STAGE, status: 'installation', _relId: 42, _relRowVersion: 3 },
        authority: { jobs: false, accInvoices: false },
      });
      await h.advanceStage();
      ok(h.calls.updateJob.length === 0 && h.calls.ensureInvoiceForJob.length === 0,
        'under JSON authority the whole relational branch is skipped — behaviour is exactly what it always was');
      ok(h.jobs[0].stage === COMPLETED_STAGE, 'the JSON path still advances the job locally, unchanged', h.jobs[0].stage);
    }

    // ── T7 — a refused invoice leaves the confirmed transition standing ───
    {
      const h = harness({
        job: { id: 7, num: 'SNS-00110', stage: INSTALLATION_STAGE, status: 'installation', _relId: 42, _relRowVersion: 3 },
        ensureError: Object.assign(new Error('ambiguous'), { status: 409, body: { type: 'legacy_conflict', error: 'two records disagree about this job’s invoice' } }),
      });
      await h.advanceStage();
      ok(h.jobs[0].stage === COMPLETED_STAGE && h.jobs[0].status === 'completed',
        'the job stays at Completed — the stage write was confirmed and stands', h.jobs[0]);
      ok(!h.jobs[0].invoiceNum && !h.jobs[0].invoiceCreated,
        'and NOTHING is shown as invoiced', h.jobs[0]);
      ok(h.calls.alert.length === 1 && /could NOT be raised automatically/.test(h.calls.alert[0])
         && /two records disagree/.test(h.calls.alert[0]),
        'the person who just clicked is told plainly, in the server’s own words', h.calls.alert[0].slice(0, 200));
      ok(/use Create Invoice once this is resolved/.test(h.calls.alert[0]),
        'and pointed at the explicit action, which still works', h.calls.alert[0].slice(-90));
    }

    // ── T8 — double-click during the transition ──────────────────────────
    {
      const h = harness({
        job: { id: 7, stage: INSTALLATION_STAGE, status: 'installation', _relId: 42, _relRowVersion: 3 },
        ensureResult: { invoiceId: 900, invoiceNumber: 'INV-00112', created: true, reused: false, jobRowVersion: 5, jobStage: INVOICED_STAGE, jobStatus: 'invoiced' },
        slow: true,
      });
      await Promise.all([h.advanceStage(), h.advanceStage(), h.advanceStage()]);
      ok(h.calls.updateJob.length === 1, 'three rapid clicks produce ONE stage write', h.calls.updateJob.length);
      ok(h.calls.ensureInvoiceForJob.length === 1,
        'and ONE invoice attempt — the in-flight guard covers the whole transition, with the backend row lock as the authoritative backstop', h.calls.ensureInvoiceForJob.length);
    }
  }

  // ══ 24 — NOTHING ELSE anywhere can start an automatic invoice ═══════════
  //
  // Startup, login, a browser refresh, relational rehydration, a company
  // switch, and merely viewing or editing an old Completed job all reduce to
  // ONE structural question: is there any caller of the automatic path other
  // than the confirmed transition? These assertions answer it for the whole
  // file at once, which is stronger than simulating each surface individually —
  // a surface that cannot reach the call site cannot trigger it however it is
  // exercised.
  console.log('\n[24] the automatic path has exactly ONE caller, and it is the transition');
  {
    ok(/ensureInvoiceForJob\(jobId\)\s*\{\s*return relationalFetch\('\/jobs\/' \+ jobId \+ '\/ensure-invoice', \{ method: 'POST' \}\);/.test(src),
      'relationalApi exposes ensureInvoiceForJob() as a thin adapter over POST /jobs/:id/ensure-invoice');

    const apiCallSites = src.match(/relationalApi\.ensureInvoiceForJob\s*\(/g) || [];
    ok(apiCallSites.length === 1, 'relationalApi.ensureInvoiceForJob is called from exactly ONE place in the entire file', apiCallSites.length);
    const ensureFn = extractFrontendFunction(src, 'ensureInvoiceOnCompletedTransition');
    ok(/relationalApi\.ensureInvoiceForJob\(job\._relId\)/.test(ensureFn),
      '…and that place is ensureInvoiceOnCompletedTransition, using the real relational PK');

    const helperCallSites = src.match(/(?<!function )ensureInvoiceOnCompletedTransition\s*\(\)/g) || [];
    ok(helperCallSites.length === 1, 'ensureInvoiceOnCompletedTransition is itself invoked from exactly one place', helperCallSites.length);
    const advance = extractFrontendFunction(src, 'advanceStage');
    ok(/if\(advanced && ns === COMPLETED_STAGE\) await ensureInvoiceOnCompletedTransition\(\);/.test(advance),
      '…inside advanceStage, guarded by BOTH a server-confirmed write and the target stage being Completed', advance.slice(-400));
    ok(/const COMPLETED_STAGE = STATUS_TO_STAGE\['completed'\];/.test(src),
      'and Completed is derived from the app’s own stage table, never a hardcoded 8');

    // No effect, poll, hydration or refresh path can reach it.
    const effects = src.match(/useEffect\(\(\)\s*=>\s*\{[\s\S]*?\},\s*\[[^\]]*\]\);/g) || [];
    ok(effects.length > 0, 'the file does contain useEffect hooks to check', effects.length);
    ok(effects.every((e) => !/ensureInvoiceForJob|ensureInvoiceOnCompletedTransition/.test(e)),
      'NOT ONE useEffect references the automatic invoice path — so app startup, login, a browser refresh and rehydration cannot trigger it',
      effects.filter((e) => /ensureInvoice/.test(e)).length);
    for (const fn of ['fetchFromServer', 'applyServerData', 'requestRelationalRefresh', 'relationalFetch']) {
      const body = extractFrontendFunction(src, fn);
      ok(!/ensureInvoiceForJob|ensureInvoiceOnCompletedTransition/.test(body),
        `${fn}() — the authoritative read/refresh path — cannot start an invoice`);
    }
    // Company "switching" is a pure render-time filter over the same array, so
    // it writes nothing at all. Asserted rather than assumed.
    ok(/const visibleJobs\s+= jobs\.filter\(j=>j\.co!==UNIONTECH_ID && belongsToUserCompany\(j,user\)\)/.test(src),
      'company scoping is a read-only filter over the jobs array — switching company writes nothing');

    // The pre-existing stage effect is untouched and still only bumps stages.
    const stageEffect = /const autoStageInFlightRef = useRef\(null\);\s*useEffect\(\(\)=>\{([\s\S]*?)\},\[jobs,quotes\]\);/.exec(src);
    ok(!!stageEffect, 'the pre-existing system-controlled stage effect is still present');
    const stageBody = stageEffect ? stageEffect[1] : '';
    ok(/if\(st===8 && j\.invoiceCreated\) due\.push\(\{job:j, stage:9, status:STAGE_STATUSES\[9\]\}\);/.test(stageBody),
      'it still owns the 8→9 Invoiced bump for a job that ALREADY has an invoice');
    ok(!/ensureInvoice/.test(stageBody) && /relationalApi\.updateJob\(j\._relId/.test(stageBody),
      'and it still only ever writes a stage — it raises no documents');

    // The explicit action is untouched and remains the route for historical jobs.
    ok(/relationalApi\.createInvoiceForJob\(job\._relId\)/.test(src),
      'the explicit "Create Invoice" actions still go through createInvoiceForJob — one backend writer, two entry points');
    ok(!/forceSaveSections|savePartialSectionsNow|mergeAndSave/.test(ensureFn),
      'the automatic path never reaches for a legacy JSON save path');
    ok(/setJobs\(jobsUpdater\);\s*syncRelationalBaseline\('jobs', jobsUpdater\);/.test(ensureFn),
      'it updates local state and the relational baseline with ONE updater, as every other relational job write does');
    ok(/stage:result\.jobStage, status:result\.jobStatus/.test(ensureFn) && /_relRowVersion:result\.jobRowVersion/.test(ensureFn),
      'applying the server’s own stage, status and row_version rather than assuming them');
  }

  console.log('\n' + '='.repeat(60));
  console.log(`[completed-auto-invoice] ${passed} passed, ${failures} failed`);
  console.log('='.repeat(60));
  await pool.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('\n[completed-auto-invoice] Fatal error:', err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
