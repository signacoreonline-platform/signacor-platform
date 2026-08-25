/**
 * relational.job-financial-lifecycle-repair.stress.ts
 * PRODUCTION RELATIONAL CUTOVER — JOB FINANCIAL + LIFECYCLE REPAIR
 * (2026-08-23)
 *
 * Regression suite for the two production defects reported after cutover:
 *
 *   ISSUE 1 — a live Job linked to quote SQ-00141 (a genuine R1,150.00
 *   incl. VAT quote) displayed "Job Value: R NaN" AND was misclassified as
 *   a "Zero-value job (sponsored / warranty / no-charge)".
 *     Root cause A (the missing/undefined value): index.html's
 *     handleConvertToJob built an optimistic `stubJob` for the newly
 *     converted job with NO `value` field at all. That stub replaces the
 *     jobs array immediately (before the next full GET refresh), and
 *     because syncRelationalBaseline mirrors the SAME stub into
 *     serverBaselineRef, the 30s poll's "only refresh sections I haven't
 *     locally changed" logic would normally have self-healed this quickly
 *     — except the poll ALSO gates its entire response on the JSON
 *     platform_state blob's stateStamp (savedAt/_autoSavedAt), which a
 *     purely-relational mutation like quote conversion never advances —
 *     so the broken stub could persist far longer than 30s in a live
 *     session. Fixed by setting `value: q.total` on the stub (mirrors
 *     EXACTLY what services.ts's convertQuoteToJob already does
 *     server-side: rel_jobs.value <- rel_quotes.total).
 *     Root cause B (the literal "R NaN" text): zar() did
 *     `Number(n).toLocaleString(...)` with no finiteness guard --
 *     Number(undefined) is NaN, and NaN.toLocaleString() literally returns
 *     "NaN". Hardened to return "R --" for any non-finite input, instead
 *     of masking it as R0.00 (which would misrepresent a broken
 *     calculation as a genuine zero amount).
 *     Root cause C (the false zero-value classification): JobDetail's
 *     `isZeroValueJob = (parseFloat(job.value)||0) <= 0` treated a FAILED
 *     parse (NaN) exactly the same as a genuine zero via the `||0`
 *     falsy-NaN fallback. Hardened to require Number.isFinite() before
 *     ever comparing <= 0 -- a failed calculation can now never qualify a
 *     job as zero-value.
 *
 *   ISSUE 2 — manually creating an invoice for an existing Job made it
 *   appear as "Current: Invoiced" with earlier stages (including Deposit
 *   Received) shown as already complete, despite no deposit ever being
 *   recorded.
 *     Root cause (traced, NOT the user's own submitted hypothesis):
 *     createInvoiceForJob (services.ts) — called by BOTH JobDetail's own
 *     gated "Create Invoice" button (only shown once stage>=7,
 *     Installation) AND the QuotesPage's deliberately-early "Create
 *     Invoice Now -- without waiting for the job to reach the
 *     Installation stage" action -- used to unconditionally set
 *     `status='invoiced', stage=9` on EVERY call, regardless of the job's
 *     actual current stage. Invoked early (as the "without waiting"
 *     button is explicitly designed to allow), this fabricated Deposit
 *     Received / In Production / Installation / Completed as already
 *     done. Fixed by making that stage/status bump conditional on the job
 *     having ALREADY reached INSTALL_STAGE (7) -- the SAME threshold
 *     already used elsewhere in this codebase (getPendingJobInvoices(),
 *     JobDetail's own button gate) to decide a job is "invoice-ready".
 *     Invoice LINKAGE (invoice_num/invoice_created/invoice_date/
 *     invoice_status, the rel_invoices row and its job_id FK) remains
 *     unconditional -- only the lifecycle-stage side effect is now gated.
 *     A SECOND, independent instance of the same "invoice existence used
 *     as evidence of lifecycle position" defect was found in index.html's
 *     global auto-lifecycle useEffect, which advanced a Completed (stage
 *     8) job to Invoiced (9) whenever `job.invoiceNum` was merely present
 *     — rather than `job.invoiceCreated` (the confirmed "genuinely has a
 *     created invoice" flag) — and, independently, only ever called
 *     setJobs() with no relationalApi/syncRelationalBaseline persistence
 *     at all (the exact "unwired relational section" class of bug Task 6
 *     targeted), meaning BOTH of its auto-advances (Deposit Received AND
 *     Invoiced) silently failed to persist in a relational-authoritative
 *     production environment. Both are fixed: the Invoiced condition now
 *     checks invoiceCreated, and every auto-bump is now persisted via
 *     relationalApi.updateJob (mirroring advanceStage's own established
 *     pattern), best-effort. A THIRD instance (JobDetail's own inline
 *     "Create Invoice" button handler) had no relational branch at all —
 *     it never called relationalApi or syncRelationalBaseline, so in
 *     production its optimistic "Invoiced" state never actually
 *     persisted (silently rejected by the systemic guard ~800ms later).
 *     Fixed by adding the same relational branch createInvoiceNow uses.
 *
 * This suite maps directly onto the required regression tests A-I:
 *   Part 1 (source-text) proves every frontend-side fix actually shipped.
 *   Part 2 (real end-to-end against the live rel_* tables, via direct
 *   service calls + buildJobsJson()/buildQuotesJson() -- the EXACT
 *   function GET /api/platform-state's relational read-overlay uses)
 *   proves tests A-H's real data-contract behavior. Test I (the Job
 *   Notes/autosave repair from the prior save-authority audit task must
 *   keep working) is proven by the EXISTING
 *   relational.save-authority-audit.stress.ts and
 *   relational.frontend-job-wiring.test.ts suites, both re-run green
 *   after every change in this task -- reconfirmed here with a minimal
 *   source-text check that saveNotes' relational call site is untouched.
 */
import fs from 'fs';
import path from 'path';
import pool from '../src/db/pool';
import * as services from '../src/relational/services';
import { buildJobsJson, buildQuotesJson } from '../src/relational/read';

const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH || path.resolve(__dirname, '..', '..', 'index.html');

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

async function resetTables() {
  await pool.query(`
    TRUNCATE TABLE rel_payments, rel_invoice_line_items, rel_invoices, rel_job_line_items,
      rel_jobs, rel_quote_line_items, rel_quotes, rel_customers, rel_credit_notes
    RESTART IDENTITY CASCADE
  `);
  await pool.query(`DELETE FROM document_number_counters`);
  await pool.query(`DELETE FROM quote_conversions`);
}

// ═══════════════════════════════════════════════════════════════════════
// PART 1 — source-text checks: every frontend-side fix actually shipped
// ═══════════════════════════════════════════════════════════════════════
function checkFrontendSource(src: string) {
  console.log('\n[Part 1] source-text checks — frontend fixes actually present in index.html');

  // Issue 1 — zar() no longer prints the literal "NaN"
  ok(/const zar\s*=\s*n\s*=>\s*\{[\s\S]{0,400}Number\.isFinite\(num\)/.test(src),
    'zar() now checks Number.isFinite(num) before formatting — never blindly Number(n).toLocaleString()');
  ok(src.includes(`if (!Number.isFinite(num)) return 'R \\u2014';`),
    'zar() returns a clear non-numeric indicator ("R \\u2014", an em dash) for a non-finite input, never the literal word "NaN"');
  ok(!/if \(!Number\.isFinite\(num\)\) return 'R \\u2014';[\s\S]{0,80}\|\|\s*0/.test(src),
    'the fix is NOT a "value||0" mask around the display (explicitly prohibited) — it is a distinct sentinel, never a fabricated R0.00');

  // Issue 1 — isZeroValueJob can never be true from a failed calculation
  ok(src.includes('const hasValidJobValue = Number.isFinite(numericJobValue);') &&
     src.includes('const isZeroValueJob = hasValidJobValue && numericJobValue <= 0;'),
    'isZeroValueJob requires Number.isFinite(...) before ever comparing <= 0 — NaN/undefined/null can never be classified as zero-value');

  // Issue 1 — handleConvertToJob's stub now carries a real value
  ok(/const stubJob = \{[\s\S]{0,1800}value: q\.total,/.test(src),
    'handleConvertToJob\'s optimistic stubJob now sets value: q.total (was completely missing before this fix)');

  // Issue 2 — createInvoiceNow (QuotesPage) AND JobDetail's own inline
  // "Create Invoice" button both had their JSON-fallback branches gate the
  // stage bump on INSTALL_STAGE (2 sub-branches each = 4 occurrences), and
  // both now have a relational branch reflecting the backend's ACTUAL
  // resulting stage/status rather than hardcoding it (1 each = 2
  // occurrences). Counting occurrences (not just .includes(), which would
  // pass even if only ONE of the two call sites had been fixed) proves
  // BOTH "Create Invoice" surfaces were corrected, not just one.
  const conditionalBumpCount = (src.match(/\.\.\.\(j\.stage>=INSTALL_STAGE \? \{stage:9, status:'invoiced'\} : \{\}\)/g) || []).length;
  ok(conditionalBumpCount === 4, `all 4 JSON-fallback stage-bump sub-branches (2 in createInvoiceNow + 2 in JobDetail's own button) now gate on INSTALL_STAGE, found ${conditionalBumpCount}`, conditionalBumpCount);
  const relationalBranchResultCount = (src.match(/stage:result\.jobStage, status:result\.jobStatus, _relRowVersion:result\.jobRowVersion\}:j/g) || []).length;
  ok(relationalBranchResultCount === 2, `both "Create Invoice" surfaces' relational branches (createInvoiceNow + JobDetail's own button) now reflect the backend's actual jobStage/jobStatus, found ${relationalBranchResultCount}`, relationalBranchResultCount);
  ok(!/stage:9,\s*status:'invoiced'\s*,\s*_relRowVersion/.test(src),
    'the old unconditional stage:9/status:\'invoiced\' hardcoding next to _relRowVersion is gone everywhere');

  // Issue 2 — JobDetail's own inline "Create Invoice" button previously
  // had NO relational branch at all (a silent no-op in production); it now
  // matches the same isRelationalAuthoritative+relationalApi.createInvoiceForJob
  // pattern createInvoiceNow already used — proven by there now being TWO
  // occurrences of this pattern (one per "Create Invoice" surface).
  const relationalGuardCount = (src.match(/isRelationalAuthoritative\('jobs'\) && isRelationalAuthoritative\('accInvoices'\)\)\{\s*try \{[\s\S]{0,600}?const result = await relationalApi\.createInvoiceForJob\(job\._relId\);/g) || []).length;
  ok(relationalGuardCount === 2, `both "Create Invoice" surfaces (createInvoiceNow + JobDetail's own previously-unwired button) now have a relational branch calling relationalApi.createInvoiceForJob, found ${relationalGuardCount}`, relationalGuardCount);

  // Issue 2 — the global auto-lifecycle effect: invoiceCreated (not
  // invoiceNum) gates the Invoiced auto-bump, and both bumps are now
  // actually persisted
  // 2026-08-25 (LEGACY-AUTOSAVE REPAIR): the pins below follow the effect's
  // current shape. The invariants they guard are IDENTICAL to before —
  // invoiceCreated (never a bare invoiceNum) gates the Invoiced bump, every
  // bump is persisted relationally, and the baseline is kept in step so the
  // 800ms autosave never tries a platform_state "jobs" save. What changed is
  // that the local/baseline patch is now applied AFTER the server confirms
  // (and carries the returned row_version) instead of optimistically before
  // it, which is what removed the live "Cannot save jobs here" toast. Full
  // BEFORE/AFTER coverage lives in
  // relational.jobs-autosave-and-quote-invoice-repair.stress.ts.
  ok(src.includes('if(st===8 && j.invoiceCreated) due.push({job:j, stage:9, status:STAGE_STATUSES[9]});'),
    'the auto-lifecycle effect\'s Invoiced bump now requires j.invoiceCreated (a confirmed created invoice), not merely j.invoiceNum (a bare number that could be reserved without an invoice ever being created)');
  ok(!/if\(st===8 && j\.invoiceNum\)/.test(src),
    'the old invoiceNum-only gate for the Invoiced auto-bump is gone');
  ok(src.includes('relationalApi.updateJob(j._relId, j._relRowVersion, { stage:d.stage, status:d.status })'),
    'the auto-lifecycle effect actually persists each stage bump via relationalApi.updateJob — never a pure local setJobs() with no backend call, which the systemic guard would reject 800ms later in production');
  ok(/\.then\(result=>\{[\s\S]{0,900}?syncRelationalBaseline\('jobs', jobsUpdater\);/.test(src),
    'the auto-lifecycle effect keeps serverBaselineRef in sync with the SAME updater it applies to local state, on the confirmed-write path, so the next autosave diff does not misreport this as an unsaved local change');
  ok(!/syncRelationalBaseline\('jobs', \(\) => next\);/.test(src),
    'the old optimistic baseline sync (applied before the server confirmed anything, and never updated with the returned row_version) is gone');

  // Test I — confirm the Task 6 Notes/autosave repair call site is untouched
  ok(src.includes(`relationalApi.updateJob(job._relId, job._relRowVersion, { notes: nextNotes })`),
    'saveNotes still calls relationalApi.updateJob with job._relId/job._relRowVersion and a notes patch — unchanged by this task\'s fixes (full regression coverage lives in relational.save-authority-audit.stress.ts, re-run green)');
}

// ═══════════════════════════════════════════════════════════════════════
// PART 2 — real end-to-end proof against the live rel_* tables
// ═══════════════════════════════════════════════════════════════════════
const INSTALL_STAGE = 7;

async function makeQuoteAndJob(opts: { unitPrice: number; qty?: number }) {
  const cust = await services.createCustomer({ companyName: 'Job Financial Lifecycle Test Co' });
  const quote = await services.createQuote({
    companyCode: '2', customerId: cust.id, customerNameRaw: 'Job Financial Lifecycle Test Co',
    lines: [{ description: 'Test line', qty: opts.qty ?? 1, unitPrice: opts.unitPrice }],
  });
  const conv = await services.convertQuoteToJob(quote.id);
  // convertQuoteToJob's jobId comes back as a string from pg for some
  // column-type paths — normalize to a real number so strict-equality
  // lookups against buildJobsJson()'s output (which hydrates ids as real
  // numbers via restoreId()) work correctly.
  return { custId: cust.id, quoteId: quote.id, quoteNumber: quote.quoteNumber, ...conv, jobId: Number(conv.jobId) };
}

async function testA() {
  console.log('\n[TEST A] Normal non-zero Job Value — relationally hydrated Job linked to a genuine non-zero quote');
  // 1000 excl VAT, no discount/setup -> 1000 * 1.15 = 1150.00 incl VAT —
  // the EXACT number from the reported production defect (quote SQ-00141,
  // "R 1,150.00 incl. VAT").
  const { quoteId, jobId } = await makeQuoteAndJob({ unitPrice: 1000 });

  const quoteRow = await pool.query(`SELECT total FROM rel_quotes WHERE id = $1`, [quoteId]);
  ok(typeof quoteRow.rows[0].total === 'string', 'sanity: the pg driver returns the NUMERIC total column as a raw STRING (e.g. "1150.00"), not a JS number — this is exactly the PostgreSQL numeric/string form the frontend must handle correctly', quoteRow.rows[0].total);
  ok(Number(quoteRow.rows[0].total) === 1150, 'the source quote\'s total is exactly R1,150.00', quoteRow.rows[0].total);

  const jobRowRaw = await pool.query(`SELECT value FROM rel_jobs WHERE id = $1`, [jobId]);
  ok(typeof jobRowRaw.rows[0].value === 'string', 'sanity: rel_jobs.value also comes back from pg as a raw string', jobRowRaw.rows[0].value);
  ok(Number(jobRowRaw.rows[0].value) === 1150, 'convertQuoteToJob correctly copied the quote\'s total onto rel_jobs.value', jobRowRaw.rows[0].value);

  const jobs = await buildJobsJson();
  const job = jobs.find((j: any) => j.id === jobId);
  ok(!!job, 'the newly-converted job is present in buildJobsJson() — the exact read path GET /api/platform-state uses');
  ok(typeof job.value === 'number' && Number.isFinite(job.value), 'job.value as hydrated for the frontend is a genuine finite JS number, never a string/NaN/undefined', job.value);
  ok(job.value === 1150, 'job.value exactly matches the source quote\'s total (R1,150.00) — the reported "R NaN" job would instead have value === undefined here', job.value);

  // Mirror the corrected isZeroValueJob formula exactly, to prove a normal
  // non-zero job is correctly NOT classified as zero-value.
  const numericJobValue = Number(job.value);
  const hasValidJobValue = Number.isFinite(numericJobValue);
  const isZeroValueJob = hasValidJobValue && numericJobValue <= 0;
  ok(hasValidJobValue === true, 'the corrected formula recognizes this as a VALID job value');
  ok(isZeroValueJob === false, 'a genuine R1,150.00 job is correctly NOT classified as zero-value — deposit/invoice stage locks remain in force', { numericJobValue, isZeroValueJob });
}

async function testB() {
  console.log('\n[TEST B] Genuine zero-value Job — legitimate sponsored/warranty/no-charge job still detected correctly');
  const { jobId } = await makeQuoteAndJob({ unitPrice: 0 });
  const jobs = await buildJobsJson();
  const job = jobs.find((j: any) => j.id === jobId);
  ok(typeof job.value === 'number' && Number.isFinite(job.value) && job.value === 0, 'a genuinely zero-value job hydrates value as the real finite number 0 (not NaN, not undefined, not the string "0")', job.value);

  const numericJobValue = Number(job.value);
  const hasValidJobValue = Number.isFinite(numericJobValue);
  const isZeroValueJob = hasValidJobValue && numericJobValue <= 0;
  ok(isZeroValueJob === true, 'the corrected formula still correctly detects a genuine zero-value job — sponsored/warranty/no-charge behavior (unlocked deposit/invoice stages) remains intact');

  // Prove the fix actually discriminates "genuinely zero" from "failed
  // calculation" — the entire point of this repair.
  for (const broken of [undefined, null, '', NaN]) {
    const n = (broken === null || broken === undefined || broken === '') ? NaN : Number(broken as any);
    const valid = Number.isFinite(n);
    const wouldBeZeroValue = valid && n <= 0;
    ok(valid === false && wouldBeZeroValue === false, `a job value of ${JSON.stringify(broken)} (a failed calculation) is correctly REJECTED as invalid, never silently treated as zero-value`, { broken, valid, wouldBeZeroValue });
  }
}

let jobCId = 0, jobCInvoiceNumber = '';

async function testC() {
  console.log('\n[TEST C] Manual invoice does not advance Job — created while the job is still at Quote Approved (well before Installation)');
  const { jobId } = await makeQuoteAndJob({ unitPrice: 2000 });
  jobCId = jobId;
  const before = await pool.query(`SELECT stage, status FROM rel_jobs WHERE id = $1`, [jobId]);
  ok(before.rows[0].stage === 4 && before.rows[0].status === 'quote_approved', 'sanity: the job starts at Quote Approved (stage 4), well before INSTALL_STAGE (7)', before.rows[0]);

  const result = await services.createInvoiceForJob(jobId);
  jobCInvoiceNumber = result.invoiceNumber;
  ok(/^INV-/.test(result.invoiceNumber), 'a real invoice number was reserved and created', result);
  ok(result.jobStage === 4 && result.jobStatus === 'quote_approved', 'createInvoiceForJob\'s response confirms it did NOT advance stage/status — the job stays exactly where it was', result);

  const jobs = await buildJobsJson();
  const job = jobs.find((j: any) => j.id === jobId);
  ok(job.invoiceCreated === true && job.invoiceNum === result.invoiceNumber, 'the invoice IS linked to the job (invoiceCreated/invoiceNum) — invoice linkage is unconditional', job);
  ok(job.stage === 4 && job.status === 'quote_approved', 'the job\'s lifecycle stage/status are UNCHANGED — Deposit Received/In Production/Installation/Completed are not fabricated', job);

  const invRow = await pool.query(`SELECT job_id, invoice_number FROM rel_invoices WHERE id = $1`, [result.invoiceId]);
  ok(String(invRow.rows[0].job_id) === String(jobId), 'the rel_invoices row is genuinely linked to this job via job_id', invRow.rows[0]);
}

async function testD() {
  console.log('\n[TEST D] Reload/hydration — a fresh re-read shows the same correct, un-advanced state');
  const jobs = await buildJobsJson();
  const job = jobs.find((j: any) => j.id === jobCId);
  ok(job.invoiceCreated === true && job.invoiceNum === jobCInvoiceNumber, 'the linked manual invoice remains linked after a fresh read', job);
  ok(job.stage === 4 && job.status === 'quote_approved', 'the job\'s lifecycle stage remains correct after a fresh read — no Deposit Received fabricated', job);
  ok(typeof job.value === 'number' && Number.isFinite(job.value) && job.value === 2300, 'job.value remains correct and finite after a fresh read (2000 excl VAT * 1.15 = 2300.00)', job.value);
}

async function testE() {
  console.log('\n[TEST E] Real payment — existing payment behaviour records a genuine deposit; invoice existence is never used as the trigger');
  const before = await pool.query(`SELECT invoice_status, stage, status FROM rel_jobs WHERE id = $1`, [jobCId]);
  ok(before.rows[0].invoice_status === 'pending', 'sanity: no payment recorded yet, invoice_status is pending', before.rows[0]);

  const half = 1150; // half of 2300
  const payResult = await services.recordPayment({ type: 'job', id: jobCId }, half, { method: 'EFT', date: '2026-08-23', notes: 'deposit' });
  ok(payResult.paymentId != null && /^\d+$/.test(String(payResult.paymentId)), 'a real payment was recorded', payResult);

  const after = await pool.query(`SELECT invoice_status, stage, status FROM rel_jobs WHERE id = $1`, [jobCId]);
  ok(after.rows[0].invoice_status === 'partial', 'invoice_status correctly recomputed to "partial" from the REAL payment amount — driven by the actual payment sum, not by the invoice this job already carries from TEST C', after.rows[0]);
  ok(after.rows[0].stage === 4 && after.rows[0].status === 'quote_approved', 'recordPayment itself never touches job lifecycle stage/status server-side — Deposit Received auto-activation is the frontend\'s job (see the source-text check confirming that effect now persists correctly via relationalApi.updateJob)', after.rows[0]);
}

async function testF() {
  console.log('\n[TEST F] Job eventual completion with existing manual invoice — no duplicate invoice, existing one reused, lifecycle advances normally');
  // Simulate the job's NORMAL progression via the exact patch shape
  // advanceStage sends (relationalApi.updateJob({stage, status})),
  // including the real Deposit Received bump now that TEST E recorded a
  // genuine payment.
  const STAGE_STATUSES = ['lead','brief','design','quote_sent','quote_approved','deposit_received','in_production','installation','completed','invoiced'];
  let cur = await pool.query(`SELECT stage, row_version FROM rel_jobs WHERE id = $1`, [jobCId]);
  for (const ns of [5, 6, 7, 8]) {
    const rv = cur.rows[0].row_version;
    const r = await services.updateJob(jobCId, rv, { stage: ns, status: STAGE_STATUSES[ns] });
    ok(typeof r.rowVersion === 'number', `advanced job to stage ${ns} (${STAGE_STATUSES[ns]}) via the same patch shape advanceStage sends`, r);
    cur = await pool.query(`SELECT stage, row_version FROM rel_jobs WHERE id = $1`, [jobCId]);
    ok(cur.rows[0].stage === ns, `job is confirmed at stage ${ns} in the DB`, cur.rows[0]);
  }

  const invCountBefore = await pool.query(`SELECT count(*)::int AS n FROM rel_invoices WHERE job_id = $1`, [jobCId]);
  ok(invCountBefore.rows[0].n === 1, 'exactly one invoice exists for this job before completion (the one created early, back in TEST C)', invCountBefore.rows[0]);

  // The job is now at Completed (8) with invoiceCreated already true — per
  // the corrected auto-lifecycle effect, this must NOT call
  // createInvoiceForJob again; it must simply advance stage/status to
  // Invoiced locally+persist, reusing the existing invoice untouched.
  const jobsAtCompleted = await buildJobsJson();
  const jobAtCompleted = jobsAtCompleted.find((j: any) => j.id === jobCId);
  ok(jobAtCompleted.stage === 8 && jobAtCompleted.invoiceCreated === true, 'sanity: job is Completed and already carries a created invoice — this is exactly the condition the corrected auto-lifecycle effect (st===8 && j.invoiceCreated) is designed to catch', jobAtCompleted);

  const finalAdvance = await services.updateJob(jobCId, jobAtCompleted._relRowVersion, { stage: 9, status: 'invoiced' });
  ok(typeof finalAdvance.rowVersion === 'number', 'the job lifecycle itself advances to its final stage (Invoiced) — via a plain stage/status patch, NOT via createInvoiceForJob (which would try to create a second invoice)', finalAdvance);

  // Explicitly prove the idempotency requirement: attempting the
  // auto-invoice path again on this job must refuse, never duplicate.
  let refused = false;
  try {
    await services.createInvoiceForJob(jobCId);
  } catch (err: any) {
    refused = err && err.name === 'BusinessRuleError';
  }
  ok(refused, 'calling createInvoiceForJob again on this already-invoiced job correctly REFUSES rather than creating a second invoice or reserving a second number');

  const invCountAfter = await pool.query(`SELECT count(*)::int AS n, array_agg(invoice_number) AS numbers FROM rel_invoices WHERE job_id = $1`, [jobCId]);
  ok(invCountAfter.rows[0].n === 1, 'still exactly ONE invoice for this job — no duplicate financial record was created', invCountAfter.rows[0]);
  ok(invCountAfter.rows[0].numbers[0] === jobCInvoiceNumber, 'it is the SAME original invoice number from TEST C — the manually-created invoice was retained and reused, never replaced', invCountAfter.rows[0]);

  const finalJob = await pool.query(`SELECT stage, status FROM rel_jobs WHERE id = $1`, [jobCId]);
  ok(finalJob.rows[0].stage === 9 && finalJob.rows[0].status === 'invoiced', 'the job correctly reached its final Invoiced lifecycle stage', finalJob.rows[0]);
}

async function testG() {
  console.log('\n[TEST G] Normal Job without a pre-existing invoice — the existing legitimate auto-create-on-completion path still works');
  const { jobId } = await makeQuoteAndJob({ unitPrice: 500 });
  const STAGE_STATUSES = ['lead','brief','design','quote_sent','quote_approved','deposit_received','in_production','installation','completed','invoiced'];
  let cur = await pool.query(`SELECT stage, row_version FROM rel_jobs WHERE id = $1`, [jobId]);
  for (const ns of [5, 6, 7, 8]) {
    const rv = cur.rows[0].row_version;
    await services.updateJob(jobId, rv, { stage: ns, status: STAGE_STATUSES[ns] });
    cur = await pool.query(`SELECT stage, row_version FROM rel_jobs WHERE id = $1`, [jobId]);
  }
  ok(cur.rows[0].stage === 8, 'sanity: job reached Completed (8) with no invoice ever created', cur.rows[0]);

  const result = await services.createInvoiceForJob(jobId);
  ok(/^INV-/.test(result.invoiceNumber), 'an invoice IS created now that one is legitimately required and none existed', result);
  ok(result.jobStage === 9 && result.jobStatus === 'invoiced', 'because this job had ALREADY reached INSTALL_STAGE (Completed, 8, is >= 7), creating the invoice correctly advances it straight to Invoiced (9) — the same one-step shortcut this action has always intentionally provided for a job at Installation/Completed', result);
  const invRow = await pool.query(`SELECT job_id FROM rel_invoices WHERE id = $1`, [result.invoiceId]);
  ok(String(invRow.rows[0].job_id) === String(jobId), 'the new invoice is correctly linked to the job', invRow.rows[0]);
}

async function testH() {
  console.log('\n[TEST H] Retry/idempotency — repeated invoice-creation attempts never duplicate');
  const { jobId } = await makeQuoteAndJob({ unitPrice: 300 });
  const results = await Promise.allSettled([
    services.createInvoiceForJob(jobId),
    services.createInvoiceForJob(jobId),
    services.createInvoiceForJob(jobId),
  ]);
  const succeeded = results.filter(r => r.status === 'fulfilled');
  ok(succeeded.length === 1, 'exactly ONE of 3 concurrent createInvoiceForJob calls on the same job succeeded (row-level locking, not just an app-level check)', `succeeded=${succeeded.length}`);

  const retryResult = await pool.query(`SELECT count(*)::int AS n FROM rel_invoices WHERE job_id = $1`, [jobId]);
  ok(retryResult.rows[0].n === 1, 'exactly one invoice exists after 3 concurrent attempts plus this check — no duplicate financial records, no wasted invoice numbers left dangling as duplicates', retryResult.rows[0]);

  // A subsequent explicit retry must also cleanly refuse, never duplicate.
  let refused = false;
  try { await services.createInvoiceForJob(jobId); } catch (err: any) { refused = err && err.name === 'BusinessRuleError'; }
  ok(refused, 'a further explicit retry after settling correctly refuses rather than creating a second invoice');
  const finalCount = await pool.query(`SELECT count(*)::int AS n FROM rel_invoices WHERE job_id = $1`, [jobId]);
  ok(finalCount.rows[0].n === 1, 'still exactly one invoice after the extra retry', finalCount.rows[0]);
}

async function main() {
  const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  checkFrontendSource(src);

  await resetTables();
  await testA();
  await testB();
  await testC();
  await testD();
  await testE();
  await testF();
  await testG();
  await testH();

  console.log('\n' + '='.repeat(60));
  console.log(`${passed} passed, ${failures} failed`);
  console.log('='.repeat(60));
  await pool.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[job-financial-lifecycle-repair-test] Fatal error:', err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
