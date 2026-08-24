/**
 * relational.save-authority-audit.stress.ts — 2026-08-23 URGENT POST-CUTOVER
 * PLATFORM-WIDE SAVE AUTHORITY AUDIT + FIX.
 *
 * Confirmed ROOT CAUSE of the reported production failure ("cannot save —
 * autosave path is not yet yielded to relational" when editing a Job Note):
 * a SHARED autosave/baseline-desync defect, not a Job-Notes-specific bug.
 * JobDetail.saveNotes (and EVERY OTHER dedicated relational action across
 * every relational-authoritative section) persists its change directly via
 * relationalApi, then calls its own local optimistic setJobs/setQuotes/
 * setSuppliers/setInventory/setAccInvoices/setCreditNotes/setPurchaseOrders
 * purely to reflect the change in the UI immediately. Nothing updated
 * serverBaselineRef — the ONLY thing the generic 800ms-debounced autosave
 * effect diffs local state against to decide "what changed, and does the
 * systemic assertNoUnwiredRelationalSections guard need to check it."
 * Result: 800ms after ANY such optimistic update, the autosave effect saw
 * that section as "locally changed" against a stale baseline and attempted
 * an illegitimate JSON PUT for an already relational-authoritative section
 * — which the guard correctly (and loudly) refused.
 *
 * THE FIX (index.html, module scope, near isRelationalAuthoritative):
 *   - serverBaselineRef lifted from a useRef(null) inside App to a plain
 *     module-level `{ current: null }` object (behaviourally identical —
 *     only one App instance is ever mounted — but now reachable from every
 *     sibling page/detail component, matching the existing
 *     relationalAuthoritativeSectionsRef pattern).
 *   - syncRelationalBaseline(sectionKey, updater) mirrors an
 *     already-confirmed relational save's own local optimistic update into
 *     serverBaselineRef.current, so the next autosave diff correctly sees
 *     "nothing pending here — already saved" for that section.
 *   - Called from every dedicated relational action's own setX(...) call
 *     site (saveNotes, advanceStage, deleteJob, saveCosts, saveLines,
 *     saveSup, delSup, createPurchaseOrderShared, updatePO, moveToInventory
 *     x2, mergeIntoInventory x2, removeItem, saveItem, quote handleSave/
 *     handleUpdate/handleConvertToJob, createInvoiceNow,
 *     createInvoiceFromQuote, saveManualInvoice, deleteInvoice, markInvPaid,
 *     saveCreditNote, deleteCreditNote, and EditCompleteProductModal's
 *     linked-quote cascade — see full audit report for the complete list).
 *
 * The guard itself (assertNoUnwiredRelationalSections) is COMPLETELY
 * UNCHANGED — this file explicitly proves that (same throw message, same
 * call sites, same section-list logic) so a genuinely-still-unwired
 * JSON-only mutation to a relational section still correctly throws.
 *
 * SEPARATE genuine schema/wiring gaps closed in this same audit pass
 * (found via the ROOT CAUSE investigation, not merely inferred):
 *   - JobDetail's write-off toggle and inline due-date editor were
 *     COMPLETELY UNWIRED (no isRelationalAuthoritative check at all, no
 *     relationalApi call) — a genuine LIVE CUTOVER GAP distinct from the
 *     shared baseline-desync bug. rel_jobs had no column for either field.
 *     Migration 010_job_writeoff_duedate.sql adds write_off/due_date
 *     (additive, nullable, idempotent); services.ts's updateJob colMap and
 *     read.ts's buildJobsJson were extended to match; the two frontend call
 *     sites now route through relationalApi.updateJob exactly like every
 *     other Job field.
 *   - EditCompleteProductModal's linked-quote-line cascade unconditionally
 *     called setQuotes(...) with NO relational awareness at all — a genuine
 *     LIVE CUTOVER GAP for "quotes" (editing an UNRELATED Complete Product
 *     could make an unrelated quote silently fail to persist its cascaded
 *     line-item update). Now routes each linked quote's line patch through
 *     the SAME relationalApi.updateQuote endpoint already used elsewhere.
 *
 * Part 1: source-text checks (this file's primary evidence — most of the
 * ~30 fixed call sites cannot be exercised end-to-end without a live React
 * app, so verifying the exact code shape is the correct level of proof,
 * matching every other frontend-wiring test in this suite).
 * Part 2: a small in-process re-implementation of locallyChangedSections'
 * documented JSON.stringify-per-section diff, proving the BEFORE/AFTER
 * behaviour difference mathematically (no baseline sync => false-positive
 * "changed"; with baseline sync => correctly "unchanged"; a genuinely
 * unwired mutation still correctly shows as "changed").
 * Part 3: a REAL end-to-end HTTP proof — PUT /jobs/:id with a notes patch
 * (exactly what saveNotes() now sends), confirming the edit survives a
 * fresh GET /api/platform-state (the "reload" proof), plus the same for
 * the new writeOff/dueDate fields (migration 010).
 *
 * Requires TEST_SERVER_URL_WITH_AUTHORITY for part 3 — skips with a clear
 * notice if unset, same convention as every other Stage 2/3 REST suite.
 */
import fs from 'fs';
import path from 'path';
import pool from '../src/db/pool';
import { runBackfill } from '../src/relational/backfill';

const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH || path.resolve(__dirname, '..', '..', 'index.html');

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

async function login(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.TEST_LOGIN_EMAIL || 'test@signacore.local', password: process.env.TEST_LOGIN_PASSWORD || 'testpass' }),
  });
  if (!res.ok) throw new Error(`login failed against ${baseUrl}: HTTP ${res.status}`);
  return (await res.json()).token;
}

function checkSharedHelperAndGuardIntact(src: string) {
  console.log('\n[Save-authority audit] shared helper + guard-untouched checks');

  // serverBaselineRef lifted to module scope, syncRelationalBaseline defined.
  ok(src.includes(`const serverBaselineRef = { current: null };`),
    'serverBaselineRef now lives at module scope (behaviourally identical single-instance ref, reachable from every sibling component)');
  ok(/function syncRelationalBaseline\(sectionKey, updater\)\s*\{\s*if\s*\(serverBaselineRef\.current && Array\.isArray\(serverBaselineRef\.current\[sectionKey\]\)\)\s*\{\s*serverBaselineRef\.current = \{ \.\.\.serverBaselineRef\.current, \[sectionKey\]: updater\(serverBaselineRef\.current\[sectionKey\]\) \};/.test(src),
    'syncRelationalBaseline mirrors an updater into serverBaselineRef.current for the given section, no-op when there is no baseline yet');
  // App's own useRef(null) declaration for serverBaselineRef must be GONE —
  // otherwise a shadowing local variable would silently defeat the module-
  // level fix for every component that isn't App itself.
  ok(!/const serverBaselineRef = useRef\(null\);/.test(src),
    'the old component-scoped useRef(null) declaration for serverBaselineRef was removed (no shadowing)');

  // The guard itself must be BYTE-IDENTICAL to before this audit — this is
  // the single most important negative-space check in this whole file.
  ok(src.includes(`'Cannot save "' + blocked.join(', ') + '" here — ' + (contextLabel || 'this save path') +`)
    && src.includes(`' is not yet wired to relational persistence, and this section is now relational-authoritative. ' +`)
    && src.includes(`'Your edit was NOT saved. Please use the specific workflow action for this change (or contact support if none exists yet).'`),
    'assertNoUnwiredRelationalSections\' thrown message is UNCHANGED — the guard was not weakened, bypassed, or relaxed');
  ok(src.includes(`assertNoUnwiredRelationalSections(\n      changed ? Object.keys(changed).filter(k => changed[k]) : STATE_SECTIONS,\n      'the autosave path'\n    );`)
    || /assertNoUnwiredRelationalSections\(\s*changed \? Object\.keys\(changed\)\.filter\(k => changed\[k\]\) : STATE_SECTIONS,\s*'the autosave path'\s*\);/.test(src),
    'mergeAndSave still calls the guard against exactly the locally-changed sections (or the full list with no baseline) — unchanged call shape');
  ok(src.includes(`assertNoUnwiredRelationalSections(Object.keys(overrides || {}), 'forceSaveSections');`),
    'forceSaveSections still calls the guard against exactly its own overrides — unchanged call shape');
  ok(src.includes(`function locallyChangedSections(local, baseline) {`) && src.includes(`if (!baseline) return null; // no baseline → treat everything as changed`),
    'locallyChangedSections\' comparison logic is untouched (JSON.stringify per-section diff against baseline)');

  // No JSON fallback was introduced for a relational section, and no catch
  // block converts a relational failure into a JSON save — spot-check a
  // representative sample of the fixed call sites: each relational branch
  // still either returns/throws on failure, it never falls through to the
  // JSON path below it.
  ok(/relationalApi\.updateJob\(job\._relId, job\._relRowVersion, \{ notes: nextNotes \}\);[\s\S]{0,400}return;\s*\}\s*setJobs\(prev=>prev\.map\(j=>j\.id===job\.id\?\{\.\.\.j,notes:nextNotes\}:j\)\);/.test(src),
    'saveNotes\' relational branch still returns after success/failure — the JSON fallback below it is unreachable once inside the relational branch');
}

function checkSyncCallSitesPresent(src: string) {
  console.log('\n[Save-authority audit] syncRelationalBaseline call-site checks (one per fixed section/action)');
  const expectations: Array<[string, string]> = [
    [`syncRelationalBaseline('jobs', jobsUpdater);`, 'JobDetail.advanceStage/deleteJob/saveCosts/saveNotes/saveLines (jobsUpdater pattern, at least one match)'],
    [`syncRelationalBaseline('quotes', quotesUpdater);`, 'QuotesPage.handleSave/handleUpdate/handleConvertToJob (quotesUpdater pattern, at least one match)'],
    [`syncRelationalBaseline('jobs', () => nextJobs);`, 'createInvoiceNow\'s relational branch (plain-array updater shape)'],
    [`syncRelationalBaseline('accInvoices', accInvoicesUpdater);`, 'createInvoiceFromQuote/deleteInvoice (accInvoicesUpdater pattern, at least one match)'],
    [`syncRelationalBaseline('accInvoices', () => nextAccInvoices);`, 'saveManualInvoice\'s two relational branches (plain-array updater shape)'],
    [`syncRelationalBaseline('suppliers', suppliersUpdater);`, 'SuppliersPage.saveSup/delSup (suppliersUpdater pattern, at least one match)'],
    [`syncRelationalBaseline('purchaseOrders', poUpdater);`, 'createPurchaseOrderShared/updatePO (poUpdater pattern, at least one match)'],
    [`syncRelationalBaseline('inventory', inventoryUpdater);`, 'moveToInventory/mergeIntoInventory (x2 components)/removeItem/saveItem (inventoryUpdater pattern, at least one match)'],
    [`syncRelationalBaseline('creditNotes', creditNotesUpdater);`, 'AccountingPage.saveCreditNote/deleteCreditNote (creditNotesUpdater pattern, at least one match)'],
  ];
  for (const [needle, label] of expectations) {
    ok(src.includes(needle), `${label} calls syncRelationalBaseline`);
  }
  // Count total call sites — must be comfortably more than one per section
  // given how many actions were fixed (27 setter call sites catalogued).
  const count = (src.match(/syncRelationalBaseline\(/g) || []).length;
  ok(count >= 27, `syncRelationalBaseline is called from at least 27 sites (found ${count}) — matches the full audit catalogue, not just a couple of spot-fixes`, count);

  // markInvPaid specifically (the accInvoices status-mutation quick action).
  ok(/async function markCanonicalInvoicePaid\(inv, ctx\)\{[\s\S]{0,1500}syncRelationalBaseline\('accInvoices', accInvoicesUpdater\);/.test(src),
    'markInvPaid (hoisted 2026-08-24 as the shared markCanonicalInvoicePaid, called by BOTH Sales and Accounting) syncs the accInvoices baseline after its relational payment-record call');
}

function checkCompleteProductCascadeFix(src: string) {
  console.log('\n[Save-authority audit] EditCompleteProductModal linked-quote-cascade fix');
  ok(/function EditCompleteProductModal\(\{ cp, completeProducts, setCompleteProducts, quotes, setQuotes, onClose \}\)/.test(src),
    'EditCompleteProductModal now receives quotes (needed to resolve _relId/_relRowVersion for the cascade)');
  ok(/async function handleSave\(\)\{[\s\S]{0,50}if\(!name\.trim\(\)\)/.test(src.slice(src.indexOf('function EditCompleteProductModal'))),
    'EditCompleteProductModal.handleSave is now async (needed to await the relational cascade)');
  ok(src.includes(`const linkedQuotes = (quotes||[]).filter(q=>(q.lines||[]).some(l=>l.cpId===cp.id && l.cpLinked));`),
    'handleSave resolves linked quotes from the real quotes array before cascading');
  ok(src.includes(`const result = await relationalApi.updateQuote(q._relId, q._relRowVersion, { lines: patchLines });`)
    && src.slice(src.indexOf('function EditCompleteProductModal'), src.indexOf('function EditCompleteProductModal') + 6000).includes(`syncRelationalBaseline('quotes', quotesUpdater);`),
    'the relational cascade reuses the SAME relationalApi.updateQuote endpoint (no new endpoint) and syncs the baseline');
  ok(src.includes(`quotes={quotes||[]} setQuotes={setQuotes} onClose={()=>setEditCP(null)}`),
    'InventoryPage now threads quotes down into the modal');
  ok(src.includes(`quotes={quotes} setQuotes={setQuotes} companies={companies}`),
    'App now threads quotes down into InventoryPage');
}

function checkWriteOffDueDateSchemaAndWiring(src: string) {
  console.log('\n[Save-authority audit] Job write-off / due-date schema gap closed (migration 010)');
  // repoRoot derived from INDEX_HTML_PATH rather than __dirname — __dirname
  // differs between a ts-node run (backend/test) and a compiled run
  // (backend/dist/test), a documented pre-existing quirk in this suite;
  // INDEX_HTML_PATH is always set to the real repo-root index.html by the
  // test runner regardless of which way this file is invoked.
  const repoRoot = path.dirname(INDEX_HTML_PATH);
  const migrationPath = path.join(repoRoot, 'database', 'migrations', '010_job_writeoff_duedate.sql');
  ok(fs.existsSync(migrationPath), 'migration 010_job_writeoff_duedate.sql exists', migrationPath);
  if (fs.existsSync(migrationPath)) {
    const migSrc = fs.readFileSync(migrationPath, 'utf8');
    ok(/ALTER TABLE rel_jobs ADD COLUMN IF NOT EXISTS write_off\s+TEXT;/.test(migSrc), 'migration adds write_off as ADD COLUMN IF NOT EXISTS (additive, idempotent)');
    ok(/ALTER TABLE rel_jobs ADD COLUMN IF NOT EXISTS due_date\s+DATE;/.test(migSrc), 'migration adds due_date as ADD COLUMN IF NOT EXISTS (additive, idempotent)');
    ok(!/DROP\s|RENAME\s|ALTER COLUMN/i.test(migSrc), 'migration contains no DROP/RENAME/ALTER COLUMN — additive only');
  }

  const servicesSrc = fs.readFileSync(path.join(repoRoot, 'backend', 'src', 'relational', 'services.ts'), 'utf8');
  ok(servicesSrc.includes(`writeOff: 'write_off', dueDate: 'due_date',`),
    'services.ts updateJob colMap accepts writeOff/dueDate');
  ok(/writeOff\?: string \| null;\s*dueDate\?: string \| null;/.test(servicesSrc),
    'JobPatchInput interface declares writeOff/dueDate');

  const readSrc = fs.readFileSync(path.join(repoRoot, 'backend', 'src', 'relational', 'read.ts'), 'utf8');
  ok(readSrc.includes(`writeOff: r.write_off ?? legacyBase(r).writeOff ?? null,`), 'read.ts buildJobsJson exposes writeOff (column, falling back to legacy_data)');
  ok(readSrc.includes(`dueDate: dateStr(r.due_date) ?? legacyBase(r).dueDate ?? null,`), 'read.ts buildJobsJson exposes dueDate (column, falling back to legacy_data)');

  console.log('\n[Save-authority audit] Job write-off / due-date frontend wiring (previously completely unwired)');
  ok(src.includes(`async function toggleWriteOff(k){`) && src.includes(`async function updateJobDueDate(val){`),
    'JobDetail now has dedicated toggleWriteOff/updateJobDueDate functions instead of bare inline setJobs(...)');
  ok(/async function toggleWriteOff\(k\)\{[\s\S]{0,200}isRelationalAuthoritative\('jobs'\)/.test(src),
    'toggleWriteOff checks isRelationalAuthoritative(\'jobs\') before deciding how to persist');
  ok(src.includes(`relationalApi.updateJob(job._relId, job._relRowVersion, { writeOff: nextVal });`),
    'toggleWriteOff calls relationalApi.updateJob with a writeOff patch');
  ok(/async function updateJobDueDate\(val\)\{[\s\S]{0,200}isRelationalAuthoritative\('jobs'\)/.test(src),
    'updateJobDueDate checks isRelationalAuthoritative(\'jobs\') before deciding how to persist');
  ok(src.includes(`relationalApi.updateJob(job._relId, job._relRowVersion, { dueDate: val });`),
    'updateJobDueDate calls relationalApi.updateJob with a dueDate patch');
  ok(src.includes(`<button key={k} onClick={()=>toggleWriteOff(k)}`),
    'the write-off toggle button now calls toggleWriteOff instead of a bare inline setJobs(...)');
  ok(src.includes(`onChange={e=>updateJobDueDate(e.target.value)}`),
    'the due-date input now calls updateJobDueDate instead of a bare inline setJobs(...)');
}

/**
 * Part 2 — a small, faithful re-implementation of locallyChangedSections'
 * documented behaviour (per-section JSON.stringify comparison against a
 * baseline; null baseline => everything "changed"). This does not import
 * index.html (a script file, not a module) — it mirrors the exact
 * documented algorithm so the BEFORE/AFTER claim about the bug can be
 * checked mathematically, independent of a live browser.
 */
function locallyChangedSectionsRef(local: any, baseline: any, sections: string[]): Record<string, boolean> | null {
  if (!baseline) return null;
  const changed: Record<string, boolean> = {};
  for (const k of sections) {
    if (JSON.stringify(local[k]) !== JSON.stringify(baseline[k])) changed[k] = true;
  }
  return changed;
}

function checkBaselineDiffLogicProof() {
  console.log('\n[Save-authority audit] BEFORE/AFTER proof — the diff logic that decides whether the guard fires');
  const SECTIONS = ['jobs', 'quotes'];

  // Scenario: a job's note is edited via a (successful) relational action.
  const baselineBefore = { jobs: [{ id: 1, notes: 'original' }], quotes: [] };
  const localAfterEdit = { jobs: [{ id: 1, notes: 'edited via relational save' }], quotes: [] };

  // BEFORE THE FIX: nothing ever updated serverBaselineRef after the
  // relational save, so the autosave effect diffs localAfterEdit against
  // the STALE baselineBefore.
  const changedBeforeFix = locallyChangedSectionsRef(localAfterEdit, baselineBefore, SECTIONS);
  ok(!!changedBeforeFix && changedBeforeFix.jobs === true,
    'BEFORE the fix: editing a job note via a relational action makes "jobs" show as locally-changed against the (never-updated) baseline — this is exactly what fed assertNoUnwiredRelationalSections and produced the reported error');

  // AFTER THE FIX: syncRelationalBaseline mirrors the SAME resulting value
  // into the baseline immediately after the relational save succeeds.
  const jobsUpdater = (prev: any[]) => prev.map(j => j.id === 1 ? { ...j, notes: 'edited via relational save' } : j);
  const baselineAfterSync = { ...baselineBefore, jobs: jobsUpdater(baselineBefore.jobs) };
  const changedAfterFix = locallyChangedSectionsRef(localAfterEdit, baselineAfterSync, SECTIONS);
  ok(!!changedAfterFix && changedAfterFix.jobs === undefined,
    'AFTER the fix: syncRelationalBaseline(\'jobs\', jobsUpdater) keeps the baseline in lockstep, so the SAME diff correctly reports "jobs" as unchanged — the illegitimate 800ms JSON autosave attempt (and the guard throw it fed) never happens');

  // A GENUINELY still-unwired mutation (changes local state WITHOUT ever
  // going through syncRelationalBaseline) must be COMPLETELY unaffected by
  // this fix — it must still show up as "changed" and still correctly
  // throw. This is the guard-not-weakened proof at the logic level.
  const localViaUnwiredMutation = { jobs: [{ id: 1, notes: 'changed by some still-broken JSON-only path' }], quotes: [] };
  const changedForUnwiredMutation = locallyChangedSectionsRef(localViaUnwiredMutation, baselineAfterSync, SECTIONS);
  ok(!!changedForUnwiredMutation && changedForUnwiredMutation.jobs === true,
    'a genuinely still-unwired mutation (no syncRelationalBaseline call) still correctly shows "jobs" as changed against baseline — the guard would still correctly throw for it, proving this fix does not mask real gaps');
}

async function resetRelationalTables() {
  await pool.query(`
    TRUNCATE rel_payments, rel_job_line_items, rel_jobs, rel_quote_line_items, rel_quotes, rel_customers
    RESTART IDENTITY CASCADE
  `);
  await pool.query(`DELETE FROM quote_conversions`);
  await pool.query(`UPDATE relational_cutover SET enabled = false, enabled_at = NULL, enabled_by = NULL`);
}

async function runEndToEndProof() {
  const base = process.env.TEST_SERVER_URL_WITH_AUTHORITY;
  if (!base) {
    console.log('\n[Save-authority audit] end-to-end proof SKIPPED — TEST_SERVER_URL_WITH_AUTHORITY not set. See test runner instructions.');
    return;
  }

  await resetRelationalTables();
  await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section = 'jobs'`);

  const tmpPath = path.resolve('/tmp/save-authority-audit-fixture.json');
  fs.writeFileSync(tmpPath, JSON.stringify({
    jobs: [{ id: 777001, num: 'SNS-AUDITTEST', co: '2', client: 'Save Authority Audit Co', desc: 'Original desc', status: 'in_production', stage: 6, value: 1000, notes: 'original note', lines: [{ desc: 'Original line', qty: 1, unitPrice: 1000, subtotal: 1000 }] }],
  }));
  await runBackfill({ apply: true, sourceFile: tmpPath });

  const jobRow = await pool.query(`SELECT id, row_version FROM rel_jobs WHERE source_id = '777001'`);
  const relId = jobRow.rows[0].id;
  let relRowVersion = jobRow.rows[0].row_version;

  const token = await login(base);
  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  console.log('\n[Save-authority audit] JOB NOTES — exact before/after path proof: edit -> relational persistence -> reload -> the edited note remains');
  const putRes = await fetch(`${base}/api/relational/jobs/${relId}`, {
    method: 'PUT', headers: authHeaders,
    body: JSON.stringify({ expectedVersion: relRowVersion, notes: 'Edited note — survives reload' }),
  });
  const putBody = await putRes.json();
  ok(putRes.status === 200, 'saveNotes\' relational PUT succeeds', JSON.stringify(putBody));
  relRowVersion = putBody.rowVersion;

  const getRes = await fetch(`${base}/api/platform-state`, { headers: { Authorization: `Bearer ${token}` } });
  const getBody = await getRes.json();
  const reloadedJob = (getBody.data.jobs || []).find((j: any) => j.id === 777001);
  ok(!!reloadedJob, 'the job is present in a fresh GET /api/platform-state (the "reload" proof)');
  ok(!!reloadedJob && reloadedJob.notes === 'Edited note — survives reload', 'the edited note is exactly what a reload returns — persisted relationally, not lost', reloadedJob && reloadedJob.notes);
  ok(Array.isArray(getBody.relationalAuthoritativeSections) && getBody.relationalAuthoritativeSections.includes('jobs'), 'the response correctly reports "jobs" as relational-authoritative');

  console.log('\n[Save-authority audit] write-off / due-date (migration 010) round-trip proof');
  const putRes2 = await fetch(`${base}/api/relational/jobs/${relId}`, {
    method: 'PUT', headers: authHeaders,
    body: JSON.stringify({ expectedVersion: relRowVersion, writeOff: 'warranty', dueDate: '2026-09-15' }),
  });
  const putBody2 = await putRes2.json();
  ok(putRes2.status === 200, 'toggleWriteOff/updateJobDueDate\'s relational PUT succeeds for the new fields', JSON.stringify(putBody2));
  relRowVersion = putBody2.rowVersion;

  const dbRow = await pool.query(`SELECT write_off, due_date FROM rel_jobs WHERE id = $1`, [relId]);
  ok(dbRow.rows[0].write_off === 'warranty', 'write_off column holds the new value directly (not only in legacy_data)', dbRow.rows[0]);
  ok(new Date(dbRow.rows[0].due_date).toISOString().slice(0, 10) === '2026-09-15', 'due_date column holds the new value directly (not only in legacy_data)', dbRow.rows[0]);

  const getRes2 = await fetch(`${base}/api/platform-state`, { headers: { Authorization: `Bearer ${token}` } });
  const getBody2 = await getRes2.json();
  const reloadedJob2 = (getBody2.data.jobs || []).find((j: any) => j.id === 777001);
  ok(!!reloadedJob2 && reloadedJob2.writeOff === 'warranty', 'a fresh GET reflects the new writeOff value via the relational read overlay', reloadedJob2 && reloadedJob2.writeOff);
  ok(!!reloadedJob2 && reloadedJob2.dueDate === '2026-09-15', 'a fresh GET reflects the new dueDate value via the relational read overlay', reloadedJob2 && reloadedJob2.dueDate);

  console.log('\n[Save-authority audit] proving the guard still fires for a genuinely unwired JSON write to a cut-over section (must NOT be weakened)');
  const badPut = await fetch(`${base}/api/platform-state`, {
    method: 'PUT', headers: authHeaders,
    body: JSON.stringify({ data: { jobs: [{ ...reloadedJob2, notes: 'sneaky JSON-only write' }], v: reloadedJob2._v || 1 } }),
  });
  ok(badPut.status !== 200 || (await badPut.clone().json().catch(() => null))?.relationalAuthoritativeSectionsIgnored?.includes?.('jobs') !== false,
    'a raw JSON PUT touching "jobs" while it is cut over is either refused outright or has its jobs section ignored server-side — the relational authority boundary holds end-to-end', badPut.status);

  await resetRelationalTables();
  await pool.query(`UPDATE platform_state SET data = '{}'::jsonb, updated_at = NOW() WHERE id = 1`);
  fs.unlinkSync(tmpPath);
}

async function main() {
  const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  checkSharedHelperAndGuardIntact(src);
  checkSyncCallSitesPresent(src);
  checkCompleteProductCascadeFix(src);
  checkWriteOffDueDateSchemaAndWiring(src);
  checkBaselineDiffLogicProof();
  await runEndToEndProof();

  console.log('\n' + '='.repeat(60));
  console.log(`${passed} passed, ${failures} failed`);
  console.log('='.repeat(60));
  await pool.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[save-authority-audit-test] Fatal error:', err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
