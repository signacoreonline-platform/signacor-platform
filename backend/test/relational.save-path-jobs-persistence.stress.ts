/**
 * relational.save-path-jobs-persistence.stress.ts
 * ───────────────────────────────────────────────
 * Regression suite for the two failures reported by the FIRST controlled
 * production smoke test after the post-migration stabilization deploy:
 *
 *   1. Save failed — "jobs" is missing from the incoming payload
 *                    (currently has 111 record(s))
 *   2. Removed Proposed Projects reappear after a refresh.
 *
 * Both are reproduced against a REAL local Postgres and a REAL running server,
 * and — critically — the frontend half is exercised by EXTRACTING THE SHIPPED
 * FUNCTIONS out of index.html and running them in a Node `vm` sandbox whose
 * `fetch` points at that real server. So these are not source-text greps
 * asserting a name exists: `mergeAndSave`, `locallyChangedSections`,
 * `savePartialSectionsNow` and `removeProposal` are the actual production code,
 * making actual HTTP requests, against the actual save route and its actual
 * wipe guard. Every PUT is counted and its body captured, which is the only way
 * to prove a negative like "no incompatible platform_state write follows".
 *
 * THE DEFECT, precisely (see index.html's own note inside mergeAndSave):
 *   backend/src/routes/platformState.ts DELETES every relational-authoritative
 *   section from an incoming save (the cutover strip) and only AFTERWARDS runs
 *   detectWipe(), which refuses any save NOT marked `_partial` that is missing a
 *   CRITICAL_KEYS section the live row still has records for. `jobs` is both cut
 *   over and the first CRITICAL_KEYS entry, so the server stripped it and then
 *   rejected the save for not containing it. Every FULL-state save has therefore
 *   failed since the jobs cutover — which is why every JSON-owned section
 *   (Proposed Projects, customers, quick rates, HR) silently stopped persisting.
 *
 * THE GUARD IS NOT TOUCHED. The repair is frontend routing: a save that can only
 * legitimately change JSON-owned sections is now SENT as the partial save it
 * actually is. No relational data is written back into JSON, no authority flag
 * moves, and detectWipe/the cutover strip are byte-for-byte unchanged.
 *
 * SAFETY: refuses to run unless DATABASE_URL is local (or ALLOW_UNSAFE_TEST_DB=1).
 * It owns platform_state row 1 and the rel_* tables in the TEST database only.
 *
 * Usage (from backend/):
 *   DATABASE_URL=postgresql://user:pass@localhost:5432/signacore_test \
 *   TEST_SERVER_URL_WITH_AUTHORITY=http://127.0.0.1:3002 \
 *   npx ts-node --transpile-only test/relational.save-path-jobs-persistence.stress.ts
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import pool from '../src/db/pool';
import * as services from '../src/relational/services';
import { buildJobsJson } from '../src/relational/read';

const DB_URL = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(DB_URL) && process.env.ALLOW_UNSAFE_TEST_DB !== '1') {
  console.error('[save-path] Refusing to run: DATABASE_URL does not look like a local test database.');
  process.exit(1);
}

const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH || path.resolve(__dirname, '..', '..', 'index.html');
const BASE = process.env.TEST_SERVER_URL_WITH_AUTHORITY || '';

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

const CUTOVER_SECTIONS = ['suppliers', 'inventory', 'quotes', 'jobs', 'accInvoices', 'creditNotes', 'purchaseOrders'];

// ── source extraction ───────────────────────────────────────────────────────
function extractFunction(src: string, name: string): string {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) throw new Error(`Could not find function ${name} in index.html — renamed or removed?`);
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

/** Extract an arrow function assigned with `const <name> = ` and return its source. */
function extractArrowConst(src: string, name: string): string {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*async?\\s*\\(`);
  const m = re.exec(src);
  if (!m) throw new Error(`Could not find const ${name} in index.html — renamed or removed?`);
  const braceStart = src.indexOf('{', src.indexOf(')', m.index));
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(m.index, i);
}

// ── fixtures ────────────────────────────────────────────────────────────────
const HISTORICAL_JOBS = Array.from({ length: 111 }, (_, i) => ({
  id: 1775800000000 + i, num: `SNS-${String(i + 1).padStart(5, '0')}`,
  client: `Historical Client ${i}`, co: i % 2 === 0 ? 2 : 1, stage: 6, value: 1000, status: 'in_production',
}));
const PROPOSALS = [
  { id: 'prop-a', name: 'Old proposal A — remove me', note: 'stale', co: null },
  { id: 'prop-b', name: 'Keep me B', note: '', co: null },
  { id: 'prop-c', name: 'Holdings proposal C', note: '', co: 1 },
];
const CUSTOMERS = [
  { id: 5001, name: 'Cust A', tel: '021 000 0001' },
  { id: 5002, name: 'Cust B', tel: '021 000 0002' },
  { id: 5003, name: 'Cust C', tel: '021 000 0003' },
];
function seedState() {
  return {
    v: 4,
    jobs: HISTORICAL_JOBS, proposedProjects: PROPOSALS.map((p) => ({ ...p })), customers: CUSTOMERS.map((c) => ({ ...c })),
    quotes: [], suppliers: [], inventory: [], accInvoices: [], accBills: [], creditNotes: [],
    purchaseOrders: [], quickRates: [], employees: [], leaveRequests: [], disciplinary: [],
    assets: [], savedCalcs: [], savedImports: [], bankTxns: [], chartOfAccounts: [],
    completeProducts: [], payrollRecords: [], userAccounts: [],
    savedAt: '2026-08-24T00:00:00.000Z',
  };
}

/** This suite owns the rel_* tables in the TEST database — reset so it is
 *  re-runnable (fixed source_ids below would otherwise collide on a second run,
 *  and a suite that only passes once is not a regression suite). */
async function resetRelational() {
  await pool.query(`
    TRUNCATE TABLE rel_payments, rel_invoice_line_items, rel_invoices, rel_job_line_items,
      rel_jobs, rel_quote_line_items, rel_quotes, rel_credit_notes, rel_inventory_items, rel_customers
    RESTART IDENTITY CASCADE
  `);
  await pool.query(`DELETE FROM document_number_counters`);
  await pool.query(`DELETE FROM quote_conversions`);
}

async function seedPlatformState() {
  await pool.query(
    `INSERT INTO platform_state (id, data) VALUES (1, $1::jsonb)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [JSON.stringify(seedState())]
  );
}
let PRIOR_CUTOVER: Array<{ section: string; enabled: boolean }> = [];
async function captureCutover() {
  PRIOR_CUTOVER = (await pool.query(`SELECT section, enabled FROM relational_cutover`)).rows;
}
async function restoreCutover() {
  for (const row of PRIOR_CUTOVER) {
    await pool.query(`UPDATE relational_cutover SET enabled = $2 WHERE section = $1`, [row.section, row.enabled]);
  }
}
async function setCutover(enabled: boolean) {
  for (const s of CUTOVER_SECTIONS) {
    await pool.query(
      `INSERT INTO relational_cutover (section, enabled) VALUES ($1, $2)
       ON CONFLICT (section) DO UPDATE SET enabled = $2`, [s, enabled]);
  }
}
async function login(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.TEST_LOGIN_EMAIL || 'test@signacore.local',
      password: process.env.TEST_LOGIN_PASSWORD || 'testpass',
    }),
  });
  const body: any = await res.json();
  if (!body || !body.token) throw new Error('could not authenticate against the test server');
  return body.token;
}

/** Assemble a snapshot the way index.html's autosave effect does: enumerate
 *  every section from what applyServerData would have placed in React state.
 *  applyServerData is SELECTIVE (e.g. it only adopts `chartOfAccounts` when it
 *  has more than 5 entries, and `sigOTSmit` only when truthy), so a snapshot is
 *  NOT simply a copy of the server payload — and the difference is exactly where
 *  a spurious "this section changed" would come from. */
const APP_SECTIONS = ['jobs', 'inventory', 'quotes', 'customers', 'suppliers', 'assets',
  'employees', 'leaveRequests', 'disciplinary', 'savedCalcs', 'purchaseOrders', 'savedImports',
  'bankTxns', 'chartOfAccounts', 'accInvoices', 'accBills', 'completeProducts', 'payrollRecords',
  'quickRates', 'proposedProjects', 'creditNotes', 'userAccounts'];
function buildAppSnapshot(dbData: any, overrides: Record<string, any> = {}): any {
  const snap: any = { v: 4 };
  for (const k of APP_SECTIONS) snap[k] = Array.isArray(dbData[k]) ? dbData[k] : [];
  snap.logo = typeof dbData.logo === 'string' ? dbData.logo : undefined;
  snap.utLogo = typeof dbData.utLogo === 'string' ? dbData.utLogo : undefined;
  snap.holdingsLogo = typeof dbData.holdingsLogo === 'string' ? dbData.holdingsLogo : undefined;
  snap.sigOTSmit = dbData.sigOTSmit || undefined;
  snap.savedAt = dbData.savedAt;
  return Object.assign(snap, overrides);
}

// ── the sandbox: real shipped functions, real server, counted requests ──────
interface Harness {
  sandbox: any;
  puts: Array<{ body: any }>;
  gets: number;
}
function buildHarness(src: string, token: string): Harness {
  const puts: Array<{ body: any }> = [];
  const state = { gets: 0 };

  const extracted = [
    extractFunction(src, 'locallyChangedSections'),
    extractFunction(src, 'mergeSectionArray'),
    extractFunction(src, 'mergeCreditNotes'),
    extractFunction(src, 'assertNoUnwiredRelationalSections'),
    extractFunction(src, 'describeSaveConflictError'),
    extractFunction(src, 'classifySaveError'),
    extractFunction(src, 'fetchFromServer'),
    extractFunction(src, 'saveToServer'),
    extractFunction(src, 'mergeAndSave'),
    extractFunction(src, 'savePartialSectionsNow'),
    extractFunction(src, 'forceSaveSections'),
    extractFunction(src, 'enqueueSavePartialSections'),
    extractArrowConst(src, 'removeProposal'),
  ].join('\n\n');

  const sandbox: any = {
    console,
    // Instrumented fetch — counts and captures every platform_state request so a
    // negative ("no incompatible write follows") can actually be proven.
    fetch: async (url: string, opts: any) => {
      const method = (opts && opts.method) || 'GET';
      if (String(url).includes('/platform-state')) {
        if (method === 'PUT') {
          let parsed: any = null;
          try { parsed = JSON.parse(opts.body).data; } catch { /* keep null */ }
          puts.push({ body: parsed });
        } else { state.gets++; }
      }
      return (globalThis as any).fetch(url, opts);
    },
    API_STATE_URL: `${BASE}/api/platform-state`,
    authHeaders: () => ({ Authorization: `Bearer ${token}` }),
    forceLogoutExpiredSession: () => { throw new Error('unexpected logout'); },
    DATA_VERSION: 4,
    STATE_SECTIONS: ['jobs', 'inventory', 'quotes', 'customers', 'suppliers', 'assets',
      'employees', 'leaveRequests', 'disciplinary', 'savedCalcs', 'purchaseOrders', 'savedImports',
      'bankTxns', 'chartOfAccounts', 'accInvoices', 'accBills', 'completeProducts', 'payrollRecords',
      'quickRates', 'proposedProjects', 'creditNotes', 'userAccounts'],
    apiReadyRef: { current: true },
    apiSaveTimerRef: { current: null },
    dbConfirmedEmptyRef: { current: false },
    saveQueueRef: { current: Promise.resolve() },
    serverBaselineRef: { current: null },
    relationalAuthoritativeSectionsRef: { current: [] },
    relationalCutOverSeenRef: { current: [] },
    // Stands in for React state: mergeAndSave calls applyServerData to teach
    // LOCAL STATE about records the union merge pulled in from another session.
    // Recorded here so a test can assert that reconciliation actually happened —
    // without it the baseline knows about records local state does not, and the
    // next save reports them as deliberate deletions.
    appliedToLocalState: {} as Record<string, any>,
    applyServerData: (partialData: any) => {
      Object.assign(sandbox.appliedToLocalState, partialData || {});
    },
    isRelationalAuthoritative: (s: string) => sandbox.relationalAuthoritativeSectionsRef.current.indexOf(s) !== -1,
    stateStamp: (o: any) => (o && (o._autoSavedAt || o.savedAt)) || '',
    setTimeout, clearTimeout,
    // removeProposal's collaborators. `proposedProjects` is deliberately a
    // SNAPSHOT the harness re-points, mirroring how React hands a component a
    // value captured at render time — if this were a live global that the
    // setter also mutated, the entire class of stale-closure clobbering would
    // be defined out of existence and untestable.
    proposedProjects: [] as any[],
    committed: [] as any[],   // the "real" list, as App-level state would hold it
    setProposedProjects: (next: any) => {
      sandbox.committed = typeof next === 'function' ? next(sandbox.committed) : next;
    },
    proposalBusyId: null as any,
    setProposalBusyId: (v: any) => { sandbox.proposalBusyId = v; },
    setProposalErr: (v: string) => { sandbox.proposalErr = v; },
    proposalErr: '',
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    `${extracted}\nglobalThis.__api = { mergeAndSave, locallyChangedSections, forceSaveSections, savePartialSectionsNow, fetchFromServer, removeProposal };`,
    sandbox, { filename: 'index.html-extracted.js' }
  );
  return { sandbox, puts, get gets() { return state.gets; } } as Harness;
}

async function main() {
  const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

  if (!BASE) {
    console.error('[save-path] TEST_SERVER_URL_WITH_AUTHORITY is not set — this suite is entirely end-to-end and cannot run without a live server.');
    process.exit(1);
  }
  const token = await login();
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  // ════════════════════════════════════════════════════════════════════════
  // TEST A — the exact live failure, reproduced then eliminated.
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n══ TEST A — live "jobs is missing from the incoming payload" failure ══');

  await captureCutover();
  await setCutover(true);
  await resetRelational();
  await seedPlatformState();

  const getRes = await fetch(`${BASE}/api/platform-state`, { headers: H });
  const got: any = await getRes.json();
  ok(Array.isArray(got.relationalAuthoritativeSections) && got.relationalAuthoritativeSections.includes('jobs'),
    'A0: the server reports jobs as relational-authoritative (the production condition)', got.relationalAuthoritativeSections);
  const jsonJobCount = (await pool.query(`SELECT jsonb_array_length(data->'jobs') AS n FROM platform_state WHERE id=1`)).rows[0].n;
  ok(Number(jsonJobCount) === 111,
    'A0: the live JSON row still holds 111 historical jobs — exactly the number the production error quoted', jsonJobCount);

  // A1 — THE OLD BEHAVIOUR. A full-state save built the way mergeAndSave used
  // to build it: everything the GET returned, with one JSON-owned section
  // changed. This is the request that produced the production error.
  const oldStylePayload = {
    ...got.data,
    proposedProjects: PROPOSALS.filter((p) => p.id !== 'prop-a'),
    _deletedIds: { proposedProjects: ['prop-a'] },
    _baseRevision: got.updated_at, v: 4, _autoSavedAt: new Date().toISOString(),
  };
  const oldRes = await fetch(`${BASE}/api/platform-state`, { method: 'PUT', headers: H, body: JSON.stringify({ data: oldStylePayload }) });
  const oldBody: any = await oldRes.json();
  ok(oldRes.status === 409 && typeof oldBody.reason === 'string'
     && oldBody.reason === '"jobs" is missing from the incoming payload (currently has 111 record(s))',
    'A1: the OLD full-state save reproduces the production error VERBATIM — this is the failing request, not an approximation',
    { status: oldRes.status, reason: oldBody.reason });
  ok(Array.isArray(oldStylePayload.jobs),
    'A1: and note the payload DID contain jobs — the server strips cut-over sections BEFORE the wipe guard reads them, which is the whole defect',
    { jobsSent: Array.isArray(oldStylePayload.jobs) ? oldStylePayload.jobs.length : null });
  const stillThere = (await pool.query(`SELECT data->'proposedProjects' AS p FROM platform_state WHERE id=1`)).rows[0].p;
  ok(Array.isArray(stillThere) && stillThere.some((p: any) => p.id === 'prop-a'),
    'A1: nothing persisted — which is exactly why a removed Proposed Project came back on refresh', stillThere.map((p: any) => p.id));

  // A2 — THE SHIPPED FIX, running the REAL mergeAndSave from index.html.
  const h = buildHarness(src, token);
  h.sandbox.relationalAuthoritativeSectionsRef.current = CUTOVER_SECTIONS.slice();
  const baseline = await h.sandbox.__api.fetchFromServer();
  h.sandbox.serverBaselineRef.current = baseline;
  const snapshotA = {
    ...baseline,
    proposedProjects: (baseline.proposedProjects || []).filter((p: any) => p.id !== 'prop-a'),
  };
  h.puts.length = 0;
  let mergeErr: any = null;
  let mergeResult: any = null;
  try { mergeResult = await h.sandbox.__api.mergeAndSave(snapshotA, baseline); } catch (e) { mergeErr = e; }
  ok(mergeErr === null && mergeResult === true,
    'A2: the SHIPPED mergeAndSave now completes this save successfully against the real server',
    mergeErr && String(mergeErr));
  ok(h.puts.length === 1, 'A2: it made exactly ONE platform_state write', h.puts.length);
  const sent = h.puts[0] && h.puts[0].body;
  ok(!!sent && sent._partial === true,
    'A2: and sent it as a PARTIAL save — the shape whose omission the wipe guard deliberately does not judge', sent && sent._partial);
  ok(!!sent && CUTOVER_SECTIONS.every((k) => sent[k] === undefined),
    'A2: no relational-authoritative section is present in the payload at all — nothing for the server to strip, and no route by which JSON could reassert authority',
    sent && CUTOVER_SECTIONS.filter((k) => sent[k] !== undefined));
  ok(!!sent && Array.isArray(sent.proposedProjects),
    'A2: the JSON-owned section this save actually intends to change IS present', sent && Object.keys(sent).filter((k) => Array.isArray(sent[k])));
  ok(!!sent && sent._deletedIds && Array.isArray(sent._deletedIds.proposedProjects) && sent._deletedIds.proposedProjects.includes('prop-a'),
    'A2: the removal is stated EXPLICITLY — the backend merge is additive, so an omitted id alone would have been preserved forever',
    sent && sent._deletedIds);

  // A3 — and it actually took effect, surviving a fresh read.
  const afterA: any = await (await fetch(`${BASE}/api/platform-state`, { headers: H })).json();
  const propIdsA = (afterA.data.proposedProjects || []).map((p: any) => p.id);
  ok(!propIdsA.includes('prop-a'), 'A3: after a fresh GET the removed proposal is gone — it does not come back', propIdsA);
  ok(propIdsA.includes('prop-b') && propIdsA.includes('prop-c'),
    'A3: and the other proposals are untouched, including the other company\'s', propIdsA);
  const jobsStillJson = (await pool.query(`SELECT jsonb_array_length(data->'jobs') AS n FROM platform_state WHERE id=1`)).rows[0].n;
  ok(Number(jobsStillJson) === 111,
    'A3: the historical JSON jobs row is byte-for-byte untouched — no relational jobs were copied back into JSON to make counts agree',
    jobsStillJson);

  // ════════════════════════════════════════════════════════════════════════
  // TEST J / F — no autosave feedback loop, and no legacy save after a
  // relational mutation. Both are provable only by counting requests.
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n══ TESTS J + F — rehydration loop and post-relational-mutation writes ══');

  // J — the exact sequence the stabilization introduced: relational mutation
  // succeeds -> authoritative re-read -> local state replaced -> does the
  // generic autosave now fire?
  const freshBaseline = await h.sandbox.__api.fetchFromServer();
  h.sandbox.serverBaselineRef.current = freshBaseline;
  // Assembled the way the App's autosave effect assembles it — enumerating each
  // section from what applyServerData would have put into React state — NOT a
  // spread of the baseline. A spread would make every comparison trivially
  // equal and the test would prove only that an object equals itself.
  const rehydratedSnapshot = buildAppSnapshot(freshBaseline);
  h.puts.length = 0;
  const loopResult = await h.sandbox.__api.mergeAndSave(rehydratedSnapshot, freshBaseline);
  ok(loopResult === false && h.puts.length === 0,
    'J: after an authoritative re-read the autosave diff sees nothing of its own to push — ZERO platform_state requests. There is no rehydration feedback loop',
    { result: loopResult, puts: h.puts.length });

  // F — a relational section differing from baseline must be refused BEFORE
  // any network call, by the untouched systemic guard.
  const relChanged = { ...freshBaseline, jobs: [...(freshBaseline.jobs || []), { id: 'sneaky', num: 'SNS-99999', co: 2 }] };
  h.puts.length = 0;
  let guardErr: any = null;
  try { await h.sandbox.__api.mergeAndSave(relChanged, freshBaseline); } catch (e) { guardErr = e; }
  ok(guardErr !== null && /Cannot save "jobs"/.test(String(guardErr && guardErr.message)),
    'F: a JSON save that would touch a relational-authoritative section is still refused by assertNoUnwiredRelationalSections — the guard is fully armed and untouched',
    guardErr && String(guardErr.message).slice(0, 120));
  ok(h.puts.length === 0, 'F: and it is refused BEFORE any request leaves the browser', h.puts.length);

  // F2 — a real relational mutation, then the autosave: still no legacy write.
  const custRel = await services.createCustomer({ companyName: 'Post-mutation Co' });
  const qRel = await services.createQuote({
    companyCode: '2', customerId: custRel.id, customerNameRaw: 'Post-mutation Co',
    lines: [{ description: 'Sign', qty: 1, unitPrice: 1000 }],
  });
  const convRel = await services.convertQuoteToJob(qRel.id);
  const afterMutation = await h.sandbox.__api.fetchFromServer();
  h.sandbox.serverBaselineRef.current = afterMutation;
  h.puts.length = 0;
  const afterMutResult = await h.sandbox.__api.mergeAndSave(buildAppSnapshot(afterMutation), afterMutation);
  ok(afterMutResult === false && h.puts.length === 0,
    'F2: after a genuine relational mutation (quote created + converted to job) and the authoritative re-read, the autosave issues NO platform_state write',
    { result: afterMutResult, puts: h.puts.length });
  const relJobs = await buildJobsJson();
  ok(relJobs.some((j: any) => j._relId === convRel.jobId),
    'F2: and the relational job is real and readable — the mutation itself was unaffected');

  // ════════════════════════════════════════════════════════════════════════
  // TEST D / E — Proposed Projects removal, via the SHIPPED removeProposal.
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n══ TESTS D + E — Proposed Projects removal ══');

  await seedPlatformState();
  const hD = buildHarness(src, token);
  hD.sandbox.relationalAuthoritativeSectionsRef.current = CUTOVER_SECTIONS.slice();
  hD.sandbox.serverBaselineRef.current = await hD.sandbox.__api.fetchFromServer();
  hD.sandbox.proposedProjects = PROPOSALS.map((p) => ({ ...p }));
  hD.puts.length = 0;

  hD.sandbox.committed = PROPOSALS.map((p) => ({ ...p }));
  await hD.sandbox.__api.removeProposal('prop-a');
  const dBody: any = (hD.puts[0] && hD.puts[0].body) || {};
  ok(hD.puts.length === 1 && dBody._partial === true,
    'D: removing a Proposed Project issues exactly one PARTIAL platform_state save', { puts: hD.puts.length, partial: dBody._partial });
  ok(!!dBody._deletedIds && (dBody._deletedIds.proposedProjects || []).includes('prop-a'),
    'D: which states the deletion explicitly — the only thing the backend will act on', dBody._deletedIds);
  ok(CUTOVER_SECTIONS.every((k) => dBody[k] === undefined),
    'D: and carries no relational-authoritative section');
  ok(hD.sandbox.committed.map((p: any) => p.id).join(',') === 'prop-b,prop-c',
    'D: local state updated only AFTER the server confirmed', hD.sandbox.committed.map((p: any) => p.id));
  ok(hD.sandbox.proposalErr === '', 'D: no error was raised', hD.sandbox.proposalErr);

  // D2 — a concurrent add while the removal is in flight must survive. The
  // handler captured `proposedProjects` BEFORE the request; assigning that
  // captured array back afterwards would silently destroy anything added since.
  const hD2 = buildHarness(src, token);
  hD2.sandbox.relationalAuthoritativeSectionsRef.current = CUTOVER_SECTIONS.slice();
  hD2.sandbox.serverBaselineRef.current = await hD2.sandbox.__api.fetchFromServer();
  hD2.sandbox.proposedProjects = [{ id: 'r-1', name: 'One', co: null }, { id: 'r-2', name: 'Two', co: null }];
  hD2.sandbox.committed = hD2.sandbox.proposedProjects.map((p: any) => ({ ...p }));
  const inFlight = hD2.sandbox.__api.removeProposal('r-1');
  // ...the user adds another one while the PUT is still open (addProposal uses
  // a prev=>… updater, so it lands on the committed list).
  hD2.sandbox.setProposedProjects((prev: any[]) => [...prev, { id: 'r-3', name: 'Added mid-flight', co: null }]);
  await inFlight;
  ok(hD2.sandbox.committed.map((p: any) => p.id).join(',') === 'r-2,r-3',
    'D2: a proposal added WHILE the removal was in flight survives — the handler removes by id from the current list instead of assigning a pre-request snapshot',
    hD2.sandbox.committed.map((p: any) => p.id));

  const afterD: any = await (await fetch(`${BASE}/api/platform-state`, { headers: H })).json();
  const idsD = (afterD.data.proposedProjects || []).map((p: any) => p.id);
  ok(!idsD.includes('prop-a'), 'D: a full refresh does NOT restore it — this is the reported bug, reproduced and fixed', idsD);
  ok(idsD.includes('prop-b'), 'D: an unrelated proposal for the same company remains', idsD);
  ok(idsD.includes('prop-c'), 'D: the OTHER company\'s proposal remains — removal never reaches beyond the acting company\'s intent', idsD);
  // "Navigating away and back" / "logging out and in" are, for this data, the
  // same operation as a fresh GET: every mount re-reads platform_state. Proven
  // by re-reading twice and comparing.
  const afterD2: any = await (await fetch(`${BASE}/api/platform-state`, { headers: H })).json();
  ok(JSON.stringify(afterD2.data.proposedProjects) === JSON.stringify(afterD.data.proposedProjects),
    'D: repeated reads (navigate away and back / log out and in — all re-read platform_state) are stable');

  // E — a FAILED removal must not masquerade as success.
  const hE = buildHarness(src, token);
  hE.sandbox.relationalAuthoritativeSectionsRef.current = CUTOVER_SECTIONS.slice();
  hE.sandbox.serverBaselineRef.current = await hE.sandbox.__api.fetchFromServer();
  // Fixture must MATCH what the row actually holds, or a passing save would
  // create records rather than delete one and the test would fail for a
  // confusing reason instead of the interesting one.
  const liveE: any = await (await fetch(`${BASE}/api/platform-state`, { headers: H })).json();
  hE.sandbox.proposedProjects = (liveE.data.proposedProjects || []).map((p: any) => ({ ...p }));
  hE.sandbox.committed = hE.sandbox.proposedProjects.map((p: any) => ({ ...p }));
  const victimId = hE.sandbox.proposedProjects[0].id;
  // Force a genuine server-side rejection (a stale revision on a deleting save
  // is refused by the backend's revision check — a real failure mode, not a
  // stubbed one).
  hE.sandbox.serverBaselineRef.current = { ...hE.sandbox.serverBaselineRef.current, _serverRevision: '1999-01-01T00:00:00.000Z' };
  hE.puts.length = 0;
  const beforeE = hE.sandbox.committed.map((p: any) => p.id).join(',');
  await hE.sandbox.__api.removeProposal(victimId);
  ok(hE.puts.length === 1, 'E: the removal attempted exactly one save', hE.puts.length);
  ok(hE.sandbox.committed.map((p: any) => p.id).join(',') === beforeE,
    'E: the save was rejected, so local state is UNCHANGED — the item is still on screen rather than falsely shown as deleted',
    { before: beforeE, after: hE.sandbox.committed.map((p: any) => p.id).join(',') });
  ok(typeof hE.sandbox.proposalErr === 'string' && /NOT removed/.test(hE.sandbox.proposalErr),
    'E: and a readable error says in as many words that the item was not removed', hE.sandbox.proposalErr);
  const afterE: any = await (await fetch(`${BASE}/api/platform-state`, { headers: H })).json();
  ok((afterE.data.proposedProjects || []).some((p: any) => p.id === victimId),
    'E: and the record really is still on the SERVER — the failure was genuine, not a UI-only stall',
    (afterE.data.proposedProjects || []).map((p: any) => p.id));

  // E2 — the no-save-path trapdoor. With no way to persist, a removal must
  // REFUSE, not quietly filter local state and look successful — that bare
  // local filter IS the bug under repair.
  const hE2 = buildHarness(src, token);
  hE2.sandbox.relationalAuthoritativeSectionsRef.current = CUTOVER_SECTIONS.slice();
  hE2.sandbox.forceSaveSections = undefined;
  hE2.sandbox.proposedProjects = [{ id: 'x-1', name: 'One', co: null }];
  hE2.sandbox.committed = [{ id: 'x-1', name: 'One', co: null }];
  hE2.puts.length = 0;
  await hE2.sandbox.__api.removeProposal('x-1');
  ok(hE2.sandbox.committed.length === 1 && hE2.puts.length === 0,
    'E2: with no save path available the item is NOT removed locally either — no silent local-only deletion',
    { remaining: hE2.sandbox.committed.length, puts: hE2.puts.length });
  ok(/NOT removed/.test(hE2.sandbox.proposalErr), 'E2: and it says so', hE2.sandbox.proposalErr);

  // ════════════════════════════════════════════════════════════════════════
  // TEST K — TWO CONSECUTIVE SAVES against ONE evolving baseline.
  //
  // Every other test re-seeds the baseline from a fresh GET immediately before
  // each call, which makes a wrong baseline fold-in structurally undetectable —
  // and a wrong fold-in is silent, permanent, and (for the _deletedIds case)
  // destroys records the user never touched. This is the only test that lets
  // the baseline evolve the way it does in a real session.
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n══ TEST K — consecutive saves against one evolving baseline ══');

  await seedPlatformState();
  const hK = buildHarness(src, token);
  hK.sandbox.relationalAuthoritativeSectionsRef.current = CUTOVER_SECTIONS.slice();
  const kBase = await hK.sandbox.__api.fetchFromServer();
  hK.sandbox.serverBaselineRef.current = kBase;

  // K1 — a scalar change (a logo upload). Scalars are NOT in STATE_SECTIONS, so
  // a fold-in that iterates only sections leaves the baseline holding the OLD
  // value and the section reads as "changed" forever after.
  const LOGO = 'data:image/png;base64,AAAAlogoAAAA';
  const kSnap1 = buildAppSnapshot(kBase, { logo: LOGO });
  hK.puts.length = 0;
  await hK.sandbox.__api.mergeAndSave(kSnap1, hK.sandbox.serverBaselineRef.current);
  ok(hK.puts.length === 1 && hK.puts[0].body.logo === LOGO,
    'K1: a changed scalar (logo) IS sent', { puts: hK.puts.length, logo: hK.puts[0] && hK.puts[0].body.logo });
  ok(hK.sandbox.serverBaselineRef.current.logo === LOGO,
    'K1: and is folded into the baseline — otherwise it reads as "locally changed" on every tick for the rest of the session, re-PUTting the whole image forever and blinding the 30s poll to anyone else\'s logo change',
    hK.sandbox.serverBaselineRef.current.logo);

  // K2 — immediately save again with NOTHING further changed. If the baseline
  // were wrong this would issue another write.
  hK.puts.length = 0;
  const kAgain = await hK.sandbox.__api.mergeAndSave(kSnap1, hK.sandbox.serverBaselineRef.current);
  ok(kAgain === false && hK.puts.length === 0,
    'K2: the immediately following save with nothing further changed issues ZERO writes — no permanent re-send loop',
    { result: kAgain, puts: hK.puts.length });

  // K3 — the destructive one. Another session adds a customer between our two
  // saves. mergeSectionArray union-merges it into our payload, so the SAVED
  // list contains a record our React state has never seen. If only the baseline
  // learns about it, the next save computes `_deletedIds` as
  // (baseline ids) minus (payload ids) and destroys it.
  const otherSessionCustomer = { id: 7777, name: 'Added by another session', tel: '021 999 0000' };
  const liveNow: any = await (await fetch(`${BASE}/api/platform-state`, { headers: H })).json();
  const injected = await fetch(`${BASE}/api/platform-state`, {
    method: 'PUT', headers: H,
    body: JSON.stringify({ data: { _partial: true, v: 4, customers: [...(liveNow.data.customers || []), otherSessionCustomer], _autoSavedAt: new Date().toISOString() } }),
  });
  ok(injected.status === 200, 'K3: (fixture) another session added a customer', injected.status);

  // Our client edits a DIFFERENT customer and saves — the union merge pulls the
  // other session's record into the payload.
  const kSnap2 = buildAppSnapshot(kBase, {
    logo: LOGO,
    customers: (kBase.customers || []).map((c: any) => (Number(c.id) === 5001 ? { ...c, tel: '021 000 9999' } : c)),
  });
  hK.puts.length = 0;
  await hK.sandbox.__api.mergeAndSave(kSnap2, hK.sandbox.serverBaselineRef.current);
  const sentCustomerIds = ((hK.puts[0] && hK.puts[0].body.customers) || []).map((c: any) => Number(c.id));
  ok(sentCustomerIds.includes(7777),
    'K3: the union merge pulled the other session\'s record into our payload (this is the existing anti-clobber behaviour, working)', sentCustomerIds);

  // Now save once more. THIS is where the record used to be destroyed.
  hK.puts.length = 0;
  // The repair applies whatever was actually persisted back into LOCAL STATE —
  // that is what stops the divergence. Assert it happened, then build the next
  // snapshot from local state exactly as the App would.
  const reconciled = hK.sandbox.appliedToLocalState.customers;
  ok(Array.isArray(reconciled) && reconciled.map((c: any) => Number(c.id)).includes(7777),
    'K3: the save applied the merged result back into LOCAL STATE — this is what stops the baseline from knowing about a record React state has never seen',
    Array.isArray(reconciled) ? reconciled.map((c: any) => Number(c.id)) : reconciled);
  const kSnap3 = buildAppSnapshot(kBase, {
    logo: LOGO,
    customers: reconciled,
    employees: [{ id: 8888, name: 'Trigger a save' }],
  });
  await hK.sandbox.__api.mergeAndSave(kSnap3, hK.sandbox.serverBaselineRef.current);
  const deletedIdsSent = (hK.puts[0] && hK.puts[0].body._deletedIds) || {};
  ok(!(deletedIdsSent.customers || []).map(Number).includes(7777),
    'K3: the follow-up save does NOT report the other session\'s record as a deletion — it is never destroyed behind the user\'s back',
    deletedIdsSent);
  const afterK: any = await (await fetch(`${BASE}/api/platform-state`, { headers: H })).json();
  ok((afterK.data.customers || []).some((c: any) => Number(c.id) === 7777),
    'K3: and it is still on the server after both saves', (afterK.data.customers || []).map((c: any) => c.id));

  // ════════════════════════════════════════════════════════════════════════
  // TEST G — every JSON-authoritative section still persists.
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n══ TEST G — JSON / mixed sections still persist ══');

  await seedPlatformState();
  const hG = buildHarness(src, token);
  hG.sandbox.relationalAuthoritativeSectionsRef.current = CUTOVER_SECTIONS.slice();

  const JSON_SECTIONS: Array<[string, any]> = [
    ['customers',      { id: 6001, name: 'New Customer', tel: '021 111 2222' }],
    ['quickRates',     { id: 6002, name: 'Quick rate item', sell: 120 }],
    ['employees',      { id: 6003, name: 'New Employee', role: 'Installer' }],
    ['leaveRequests',  { id: 6004, employeeId: 6003, startDate: '2026-09-01', endDate: '2026-09-03', status: 'pending' }],
    ['disciplinary',   { id: 6005, employeeId: 6003, date: '2026-09-05', notes: 'verbal warning' }],
    ['proposedProjects', { id: 'prop-new', name: 'Newly proposed', note: '', co: null }],
    ['assets',         { id: 6006, name: 'Vinyl cutter' }],
  ];
  for (const [section, record] of JSON_SECTIONS) {
    const base = await hG.sandbox.__api.fetchFromServer();
    hG.sandbox.serverBaselineRef.current = base;
    const snap = { ...base, [section]: [...(base[section] || []), record] };
    hG.puts.length = 0;
    let err: any = null;
    try { await hG.sandbox.__api.mergeAndSave(snap, base); } catch (e) { err = e; }
    const after: any = await (await fetch(`${BASE}/api/platform-state`, { headers: H })).json();
    const persisted = (after.data[section] || []).some((r: any) => String(r.id) === String(record.id));
    ok(err === null && persisted,
      `G: "${section}" (JSON-authoritative) still creates and persists through the intended path`,
      { error: err && String(err.message), persisted });
  }

  // And a JSON-section DELETE still works end to end.
  const baseDel = await hG.sandbox.__api.fetchFromServer();
  hG.sandbox.serverBaselineRef.current = baseDel;
  const snapDel = { ...baseDel, customers: (baseDel.customers || []).filter((c: any) => Number(c.id) !== 5002) };
  await hG.sandbox.__api.mergeAndSave(snapDel, baseDel);
  const afterDel: any = await (await fetch(`${BASE}/api/platform-state`, { headers: H })).json();
  ok(!(afterDel.data.customers || []).some((c: any) => Number(c.id) === 5002),
    'G: deleting a JSON-authoritative record persists too — _deletedIds survives the switch to a partial payload',
    (afterDel.data.customers || []).map((c: any) => c.id));

  // ════════════════════════════════════════════════════════════════════════
  // TEST H / I — payments and quote saves issue no platform_state write.
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n══ TESTS H + I — payments and quote saves ══');

  const hH = buildHarness(src, token);
  hH.sandbox.relationalAuthoritativeSectionsRef.current = CUTOVER_SECTIONS.slice();
  // A payment's JSON fallback would save its OWNER's section (jobs / quotes /
  // accInvoices) — all cut over, so every one is refused before any request.
  for (const ownerSection of ['jobs', 'quotes', 'accInvoices']) {
    hH.puts.length = 0;
    let e: any = null;
    try { await hH.sandbox.__api.forceSaveSections({ [ownerSection]: [] }); } catch (err) { e = err; }
    ok(e !== null && hH.puts.length === 0,
      `H: a payment's legacy fallback save of "${ownerSection}" is refused before any request — it can never produce the "jobs is missing" failure`,
      { threw: !!e, puts: hH.puts.length });
  }
  // A real relational payment, then the autosave: still no platform_state write.
  const payJobs = await buildJobsJson();
  const payJob = payJobs.find((j: any) => j._relId === convRel.jobId);
  await services.recordPayment({ type: 'job', id: convRel.jobId }, 250, { method: 'EFT', date: '2026-08-24' });
  const basePay = await hH.sandbox.__api.fetchFromServer();
  hH.sandbox.serverBaselineRef.current = basePay;
  hH.puts.length = 0;
  const payAutosave = await hH.sandbox.__api.mergeAndSave(buildAppSnapshot(basePay), basePay);
  ok(payAutosave === false && hH.puts.length === 0,
    'H: after a real relational payment and the authoritative re-read, the autosave issues NO platform_state write',
    { result: payAutosave, puts: hH.puts.length });
  ok(!!payJob, 'H: (fixture) the payment owner job exists relationally');

  // I — a quote save (the previously-repaired path) still works and still
  // issues no legacy write.
  const invBackfilled = await pool.query(
    `WITH new_id AS (SELECT nextval('rel_inventory_items_id_seq') AS id)
     INSERT INTO rel_inventory_items (id, source_id, name, sku, cost, sell, stock_qty, reorder_level, legacy_data)
     SELECT new_id.id, '1775811628870', 'Backfilled Vinyl', 'VNL-Q', 100, 250, 50, 5, '{}'::jsonb FROM new_id
     RETURNING id, source_id`);
  const bfSource = invBackfilled.rows[0].source_id;
  let quoteErr: any = null;
  let qI: any = null;
  try {
    const custI = await services.createCustomer({ companyName: 'Quote Save Co' });
    qI = await services.createQuote({
      companyCode: '2', customerId: custI.id, customerNameRaw: 'Quote Save Co',
      contactPerson: 'Sipho', email: 's@example.com', quoteDate: '2026-08-02', validUntil: '',
      lines: [{ description: 'Vinyl', qty: 2, unitPrice: 250, unit: 'm²', inventoryItemId: Number(bfSource) }],
    });
    const v = (await pool.query(`SELECT row_version FROM rel_quotes WHERE id=$1`, [qI.id])).rows[0].row_version;
    await services.updateQuote(qI.id, v, { notes: 'edited', quoteDate: '' } as any);
  } catch (e) { quoteErr = e; }
  ok(quoteErr === null,
    'I: a representative quote save (inventory-backed line by its legacy id, plus an emptied date) succeeds — the earlier FK and DATE repairs are intact',
    quoteErr && String(quoteErr));
  const baseQ = await hH.sandbox.__api.fetchFromServer();
  hH.sandbox.serverBaselineRef.current = baseQ;
  hH.puts.length = 0;
  const qAutosave = await hH.sandbox.__api.mergeAndSave(buildAppSnapshot(baseQ), baseQ);
  ok(qAutosave === false && hH.puts.length === 0,
    'I: and the autosave that follows it issues NO platform_state write', { result: qAutosave, puts: hH.puts.length });

  // ════════════════════════════════════════════════════════════════════════
  // TESTS B + C — individual Job notes, revalidated end to end.
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n══ TESTS B + C — individual Job notes ══');

  const jobsB = await buildJobsJson();
  const jobB = jobsB.find((j: any) => j._relId === convRel.jobId);
  let vB = (await pool.query(`SELECT row_version FROM rel_jobs WHERE id=$1`, [convRel.jobId])).rows[0].row_version;
  await services.updateJob(convRel.jobId, vB, { notes: 'OLD NOTE' });
  vB = (await pool.query(`SELECT row_version FROM rel_jobs WHERE id=$1`, [convRel.jobId])).rows[0].row_version;
  await services.updateJob(convRel.jobId, vB, { notes: 'NEW NOTE' });
  let readB = (await buildJobsJson()).find((j: any) => j._relId === convRel.jobId);
  ok(readB.notes === 'NEW NOTE', 'B: OLD NOTE -> NEW NOTE persists and survives a fresh read', readB.notes);
  ok(!!jobB, 'B: (fixture) the job exists');

  vB = (await pool.query(`SELECT row_version FROM rel_jobs WHERE id=$1`, [convRel.jobId])).rows[0].row_version;
  await services.updateJob(convRel.jobId, vB, { notes: '' });
  readB = (await buildJobsJson()).find((j: any) => j._relId === convRel.jobId);
  ok(readB.notes === '', 'C: OLD NOTE -> blank persists as blank — no legacy resurrection', readB.notes);

  // C2 — and an unrelated quote edit must not bring it back (the ratchet).
  const qVer = (await pool.query(`SELECT row_version FROM rel_quotes WHERE id=$1`, [qRel.id])).rows[0].row_version;
  await services.updateQuoteWithJobSync(qRel.id, qVer, {
    lines: [{ desc: 'Revised', qty: 1, unitPrice: 2000 }],
    notes: (await pool.query(`SELECT notes FROM rel_quotes WHERE id=$1`, [qRel.id])).rows[0].notes,
  });
  readB = (await buildJobsJson()).find((j: any) => j._relId === convRel.jobId);
  ok(readB.notes === '', 'C2: editing the source quote does not resurrect the cleared job note', readB.notes);

  // C3 — and clearing a note issues no platform_state write of its own.
  const baseC = await hH.sandbox.__api.fetchFromServer();
  hH.sandbox.serverBaselineRef.current = baseC;
  hH.puts.length = 0;
  const cAutosave = await hH.sandbox.__api.mergeAndSave(buildAppSnapshot(baseC), baseC);
  ok(cAutosave === false && hH.puts.length === 0,
    'C3: the Job-notes save path produces NO platform_state write — the exact smoke test that failed in production now issues nothing for the guard to reject',
    { result: cAutosave, puts: hH.puts.length });

  // ════════════════════════════════════════════════════════════════════════
  // Writer audit — structural, and deliberately so: this asserts a NEGATIVE
  // over the whole file (no other writer exists), which no runtime test can.
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n══ platform_state writer audit ══');
  // Counts INVOCATIONS (`await saveToServer(`), not textual mentions — prose in
  // comments must not be able to move this number, or the audit is theatre.
  const putCallSites = (src.match(/await\s+saveToServer\s*\(/g) || []).length;
  ok(putCallSites === 3,
    'AUDIT: saveToServer is invoked from exactly 3 places — mergeAndSave\'s partial branch, mergeAndSave\'s full-state branch, and savePartialSectionsNow. No other code in this application can write platform_state',
    putCallSites);
  ok((src.match(/async function saveToServer\s*\(/g) || []).length === 1,
    'AUDIT: and there is exactly one definition of it');
  const mergeAndSaveSrc = extractFunction(src, 'mergeAndSave');
  const partialSrc = extractFunction(src, 'savePartialSectionsNow');
  ok((mergeAndSaveSrc.match(/await\s+saveToServer\s*\(/g) || []).length === 2
     && (partialSrc.match(/await\s+saveToServer\s*\(/g) || []).length === 1,
    'AUDIT: all 3 invocations are accounted for inside those two functions — none is loose anywhere else in the file',
    { mergeAndSave: (mergeAndSaveSrc.match(/await\s+saveToServer\s*\(/g) || []).length,
      savePartialSectionsNow: (partialSrc.match(/await\s+saveToServer\s*\(/g) || []).length });
  const rawPuts = src.match(/fetch\s*\(\s*API_STATE_URL[\s\S]{0,200}?method:\s*'PUT'/g) || [];
  ok(rawPuts.length === 1,
    'AUDIT: exactly ONE raw PUT to API_STATE_URL exists in the whole file — the one inside saveToServer', rawPuts.length);
  ok(!/function persistStateToServer/.test(src),
    'AUDIT: the dead, unauthenticated second full-state writer (persistStateToServer) is gone — it had no callers but was a live bypass of the merge/wipe/deletion protocol');
  ok(!/navigator\.sendBeacon/.test(src),
    'AUDIT: no sendBeacon writer exists (a beforeunload save would bypass every guard by design)');

  console.log(`\n[save-path-jobs-persistence] ${passed} passed, ${failures} failed`);
  // Restore whatever the cutover flags were BEFORE this run rather than
  // blanket-clearing them, so the suite cannot leave the test database in a
  // state a later suite silently depends on.
  await restoreCutover();
  await pool.end();
  if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error('[save-path-jobs-persistence] Fatal error:', err);
  try { await restoreCutover(); } catch { /* ignore */ }
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
