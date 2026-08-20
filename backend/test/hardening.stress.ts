/**
 * hardening.stress.ts — 2026-08-20 data-safety hardening regression suite.
 *
 * Runs against a REAL Postgres + a REAL instance of the hardened Express
 * routes (platformState / documentNumbers / quoteConversions), over HTTP,
 * simulating multiple independent "browser sessions" as separate in-memory
 * clients that each track their own local state/baseline — the same shape
 * the actual frontend save envelope uses. This proves the SERVER-SIDE
 * guarantees (Part 3/4/5 of the hardening brief) hold regardless of what a
 * client sends, which is the part that can be proven mechanically without a
 * real browser.
 *
 * SAFETY: refuses to run unless DATABASE_URL points at localhost/127.0.0.1,
 * or ALLOW_UNSAFE_TEST_DB=1 is explicitly set — this must never be pointed
 * at a shared/production database, since it creates and deletes test rows.
 *
 * Usage (from backend/):
 *   DATABASE_URL=postgresql://user:pass@localhost:5432/signacore_test \
 *   TEST_SERVER_URL=http://localhost:4001 \
 *   TEST_LOGIN_EMAIL=test@signacore.local TEST_LOGIN_PASSWORD=testpass \
 *   npx ts-node --transpile-only test/hardening.stress.ts
 *
 * Exits 0 if every assertion passes, 1 otherwise (prints a summary either
 * way). Intended to be run against a disposable local/test database — it
 * does not clean up after itself beyond what's noted per-scenario, and
 * re-running is safe (each scenario uses freshly-generated ids/numbers).
 */

const BASE = process.env.TEST_SERVER_URL || 'http://localhost:4001';
const DB_URL = process.env.DATABASE_URL || '';

if (!/localhost|127\.0\.0\.1/.test(DB_URL) && process.env.ALLOW_UNSAFE_TEST_DB !== '1') {
  console.error('[hardening-stress] Refusing to run: DATABASE_URL does not look like a local test database.');
  console.error('[hardening-stress] Set ALLOW_UNSAFE_TEST_DB=1 only if you are certain this is a disposable test DB.');
  process.exit(1);
}

let TOKEN = '';
let failures = 0;
let passed = 0;

function ok(cond: boolean, label: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

async function login(): Promise<void> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.TEST_LOGIN_EMAIL || 'test@signacore.local',
      password: process.env.TEST_LOGIN_PASSWORD || 'testpass',
    }),
  });
  if (!res.ok) throw new Error(`login failed: HTTP ${res.status}`);
  const body = await res.json();
  TOKEN = body.token;
}

function authHeaders() {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };
}

async function getState(): Promise<{ data: any; updated_at: string | null }> {
  const res = await fetch(`${BASE}/api/platform-state`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`GET platform-state failed: HTTP ${res.status}`);
  return res.json();
}

async function putState(payload: any): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}/api/platform-state`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify({ data: payload }),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

function idsOf(list: any[]): Set<string> {
  return new Set((list || []).filter((x) => x && x.id != null).map((x) => String(x.id)));
}

// Part 16's reusable safety assertion: capture ids before, assert after
// mutation that only the EXPECTED additions/removals/modifications
// happened and NOTHING else. Returns the set of unexpected removals (empty
// = pass).
function assertOnlyExpectedChanges(before: any[], after: any[], expectedAdded: string[], expectedRemoved: string[]): { unexpectedRemoved: string[]; unexpectedAdded: string[] } {
  const beforeIds = idsOf(before);
  const afterIds = idsOf(after);
  const expectedAddedSet = new Set(expectedAdded);
  const expectedRemovedSet = new Set(expectedRemoved);
  const unexpectedRemoved = Array.from(beforeIds).filter((id) => !afterIds.has(id) && !expectedRemovedSet.has(id));
  const unexpectedAdded = Array.from(afterIds).filter((id) => !beforeIds.has(id) && !expectedAddedSet.has(id));
  return { unexpectedRemoved, unexpectedAdded };
}

function uid(): string {
  // Unique per PROCESS RUN (Date.now() base) + an incrementing counter so
  // ids never collide within a single run either. Using wall-clock time is
  // deliberate here (unlike in Workflow orchestration scripts, which ban
  // it for replay-determinism reasons) — this is a plain, directly-executed
  // Node script re-run against a persistent test database, and needs fresh
  // ids/numbers on every invocation so repeated runs don't collide with
  // leftover rows from a previous run.
  uid.counter = ((uid as any).counter || 0) + 1;
  return String(Date.now()) + String((uid as any).counter).padStart(4, '0');
}
(uid as any).counter = 0;

function makeJob(over: Partial<any> = {}) {
  return { id: uid(), num: `SNS-TEST-${uid()}`, client: 'Test Client', co: '1', status: 'quote_approved', quoteNum: null, ...over };
}

async function scenarioA_additivePartialSaveNeverDeletes() {
  console.log('\n[Scenario A] Stale-closure partial save (forceSaveSections shape) never deletes records added elsewhere');
  const start = await getState();
  const existingJobs = Array.isArray(start.data.jobs) ? start.data.jobs : [];

  // "Session B" adds 5 jobs via a full-state-shaped save (simulating either
  // a normal debounced autosave or, as in the real incident, a direct
  // administrative write) — these represent SNS-00120..124 in the real
  // incident.
  const bJobs = Array.from({ length: 5 }, () => makeJob({ client: 'Session B Client' }));
  const afterB = await putState({ jobs: [...existingJobs, ...bJobs], _partial: true });
  ok(afterB.status === 200, 'Session B add-5-jobs partial save succeeds', JSON.stringify(afterB.body));

  const stateAfterB = await getState();
  ok(idsOf(stateAfterB.data.jobs).size === existingJobs.length + 5, 'live jobs count reflects B\'s 5 additions');

  // "Session A" builds its overrides from a STALE snapshot captured BEFORE
  // B's write (the exact race: overrides.jobs does not include B's jobs,
  // and — per the hardened frontend contract — an additive/partial save
  // sends NO _deletedIds/_knownSectionIds at all, so nothing can be
  // inferred as deleted).
  const aNewJob = makeJob({ client: 'Session A new job' });
  const staleOverridesJobs = [...existingJobs, aNewJob]; // deliberately excludes bJobs
  const afterA = await putState({ jobs: staleOverridesJobs, _partial: true });
  ok(afterA.status === 200, 'Session A stale partial save succeeds (not blocked)', JSON.stringify(afterA.body));

  const finalState = await getState();
  const finalIds = idsOf(finalState.data.jobs);
  const diff = assertOnlyExpectedChanges(stateAfterB.data.jobs, finalState.data.jobs, [aNewJob.id], []);
  ok(diff.unexpectedRemoved.length === 0, 'NO job unexpectedly removed after stale partial save', JSON.stringify(diff.unexpectedRemoved));
  ok(bJobs.every((j) => finalIds.has(String(j.id))), 'all 5 of Session B\'s jobs still present', JSON.stringify(bJobs.map(j=>j.id).filter(id=>!finalIds.has(String(id)))));
  ok(finalIds.has(String(aNewJob.id)), 'Session A\'s own new job was still added');
}

async function scenarioB_explicitDeleteWorks() {
  console.log('\n[Scenario B] Explicit _deletedIds still allows legitimate deletion (full-state save)');
  const start = await getState();
  const target = makeJob({ client: 'To Be Deleted' });
  const afterAdd = await putState({ jobs: [...(start.data.jobs || []), target], _partial: true });
  ok(afterAdd.status === 200, 'setup: add job to delete later');

  const afterAddState = await getState();
  const jobsWithoutTarget = (afterAddState.data.jobs || []).filter((j: any) => String(j.id) !== String(target.id));
  const del = await putState({
    ...afterAddState.data,
    jobs: jobsWithoutTarget,
    _deletedIds: { jobs: [target.id] },
    _baseRevision: afterAddState.updated_at,
  });
  ok(del.status === 200, 'explicit-delete full-state save succeeds', JSON.stringify(del.body));
  const finalState = await getState();
  ok(!idsOf(finalState.data.jobs).has(String(target.id)), 'explicitly-deleted job is actually gone');
}

async function scenarioC_staleRevisionBlocksDeletion() {
  console.log('\n[Scenario C] Stale _baseRevision blocks a deletion-bearing full-state save (409 conflict, nothing removed)');
  const start = await getState();
  const target = makeJob({ client: 'Protected By Revision Check' });
  const afterAdd = await putState({ jobs: [...(start.data.jobs || []), target], _partial: true });
  ok(afterAdd.status === 200, 'setup: add job');
  const staleRevision = start.updated_at; // deliberately OLD — predates the add above

  const afterAddState = await getState();
  const jobsWithoutTarget = (afterAddState.data.jobs || []).filter((j: any) => String(j.id) !== String(target.id));
  const del = await putState({
    ...afterAddState.data,
    jobs: jobsWithoutTarget,
    _deletedIds: { jobs: [target.id] },
    _baseRevision: staleRevision,
  });
  ok(del.status === 409 && del.body?.conflict === true && del.body?.type === 'stale_revision', 'stale-revision deletion is rejected with structured 409', JSON.stringify(del));
  const finalState = await getState();
  ok(idsOf(finalState.data.jobs).has(String(target.id)), 'the record survives — deletion was NOT applied');
}

async function scenarioD_duplicateConversionBlocked() {
  console.log('\n[Scenario D] Duplicate quote->job conversion (2 NEW jobs, same quoteNum) is blocked');
  const start = await getState();
  const quoteNum = `SQ-TEST-${uid()}`;
  const j1 = makeJob({ quoteNum });
  const j2 = makeJob({ quoteNum });
  const res = await putState({ jobs: [...(start.data.jobs || []), j1, j2], _partial: true });
  ok(res.status === 409, 'save introducing 2 new jobs for the same quoteNum is blocked', JSON.stringify(res.body));
}

async function scenarioE_numberCollisionRecoverable() {
  console.log('\n[Scenario E] Manual invoice-number collision returns a recoverable structured conflict, never deletes/steals');
  // 2026-08-20: was `INV-${77000 + (counter % 900)}` — a small bounded range
  // that repeats deterministically every process run, so re-running this
  // suite against a persistent (non-wiped) test DB collided with a NUMBER
  // this exact scenario itself reserved on a PRIOR run, producing a false
  // failure indistinguishable from a real bug.
  //
  // Using the full uid() (Date.now()+counter, ~17 digits) here instead does
  // NOT work either: document_number_counters.last_number is a Postgres
  // INTEGER column (max 2,147,483,647), and reserving a specific
  // requestedNumber advances the counter to match it (see
  // reserveDocumentNumberWithClient) — a 17-digit requested value overflows
  // that column and the reservation genuinely fails server-side. That is a
  // real, correct constraint of the schema (real invoice numbers are always
  // small, zero-padded), not something this test should route around by
  // sending a value production could never send.
  //
  // So: stay comfortably under the INTEGER limit (2,147,483,647) but still
  // vary per run — this cycles every ~10.4 days (900,000,000 ms), which is
  // far more spacing than the previous bounded-900 range gave, so repeated
  // manual test runs within the same session don't collide with a number
  // this exact scenario itself claimed moments earlier.
  const targetNumber = `INV-${(700000000 + (Date.now() % 900000000)).toString()}`;
  const first = await fetch(`${BASE}/api/document-numbers/reserve`, {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ company: '1', docType: 'invoice', requestedNumber: targetNumber }),
  });
  const firstBody = await first.json();
  ok(first.status === 200 && firstBody.number === targetNumber, `first manual claim of ${targetNumber} succeeds`, JSON.stringify(firstBody));

  // Put a live accInvoice record under that number so /check and a second
  // /reserve attempt see it as occupied.
  const beforeState = await getState();
  const invRec = { id: uid(), number: targetNumber, co: '1', client: `Owner Of ${targetNumber}` };
  await putState({ accInvoices: [...(beforeState.data.accInvoices || []), invRec], _partial: true });

  const check = await fetch(`${BASE}/api/document-numbers/check`, {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ company: '1', docType: 'invoice', requestedNumber: targetNumber }),
  });
  const checkBody = await check.json();
  ok(check.status === 200 && checkBody.available === false && checkBody.conflict === true && !!checkBody.suggestedNumber, '/check reports collision with a suggested alternative', JSON.stringify(checkBody));
  ok(checkBody.owner && checkBody.owner.id === invRec.id, '/check identifies the correct owner record');

  const second = await fetch(`${BASE}/api/document-numbers/reserve`, {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ company: '1', docType: 'invoice', requestedNumber: targetNumber }),
  });
  const secondBody = await second.json();
  ok(second.status === 409 && secondBody.conflict === true && !!secondBody.suggestedNumber, '/reserve of an occupied manual number returns 409 conflict, not a generic failure', JSON.stringify(secondBody));

  const afterState = await getState();
  ok((afterState.data.accInvoices || []).some((i: any) => i.id === invRec.id && i.number === targetNumber), 'the EXISTING invoice record was never touched/renumbered/deleted by the collision');

  const useSuggested = await fetch(`${BASE}/api/document-numbers/reserve`, {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ company: '1', docType: 'invoice', requestedNumber: secondBody.suggestedNumber }),
  });
  const useSuggestedBody = await useSuggested.json();
  ok(useSuggested.status === 200 && useSuggestedBody.number === secondBody.suggestedNumber, 'user can proceed by explicitly accepting the suggested number');
}

async function scenarioF_missingDocumentReservationRecovery() {
  console.log('\n[Scenario F] Reservation exists, job missing (SQ-00168 shape) -> recoverable conflict -> explicit reassign');
  const quoteId = uid();
  const first = await fetch(`${BASE}/api/quote-conversions/reserve`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ quoteId }),
  });
  const firstBody = await first.json();
  ok(first.status === 200 && !!firstBody.jobNumber, 'initial reservation succeeds', JSON.stringify(firstBody));
  const originalJobNumber = firstBody.jobNumber;

  // Simulate the job never actually being saved (or being lost) — live
  // platform_state has no job under that number. Retry the reservation.
  const retry = await fetch(`${BASE}/api/quote-conversions/reserve`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ quoteId }),
  });
  const retryBody = await retry.json();
  ok(retry.status === 409 && retryBody.conflict === true && retryBody.type === 'reservation_missing_document' && retryBody.previousJobNumber === originalJobNumber,
    'retry with missing job returns a recoverable conflict, NOT a silent reused:true', JSON.stringify(retryBody));

  const badReassign = await fetch(`${BASE}/api/quote-conversions/reassign`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ quoteId }), // no confirm
  });
  ok(badReassign.status === 400, 'reassign without confirm:true is rejected');

  const reassign = await fetch(`${BASE}/api/quote-conversions/reassign`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ quoteId, confirm: true, reason: 'test-confirmed' }),
  });
  const reassignBody = await reassign.json();
  ok(reassign.status === 200 && !!reassignBody.jobNumber && reassignBody.jobNumber !== originalJobNumber, 'confirmed reassign issues a genuinely NEW number', JSON.stringify(reassignBody));

  // Verify audit trail columns were populated.
  const { Client } = await import('pg');
  const pgClient = new Client({ connectionString: DB_URL });
  await pgClient.connect();
  const auditRes = await pgClient.query('SELECT job_number, superseded_job_number, superseded_at, reassigned_reason FROM quote_conversions WHERE quote_id = $1', [quoteId]);
  await pgClient.end();
  const row = auditRes.rows[0];
  ok(!!row && row.job_number === reassignBody.jobNumber, 'quote_conversions row now shows the NEW job_number');
  ok(!!row && row.superseded_job_number === originalJobNumber, 'quote_conversions row preserves the OLD (superseded) job_number for audit');
  ok(!!row && !!row.superseded_at && row.reassigned_reason === 'test-confirmed', 'quote_conversions row records when/why the reassignment happened');
}

async function scenarioG_concurrentReservationsUnique() {
  console.log('\n[Scenario G] Concurrent job-number reservations never collide (atomicity under load)');
  const N = 12;
  const results = await Promise.all(
    Array.from({ length: N }, () =>
      fetch(`${BASE}/api/document-numbers/reserve`, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ company: '1', docType: 'job' }),
      }).then((r) => r.json())
    )
  );
  const numbers = results.map((r) => r.number).filter(Boolean);
  const uniqueNumbers = new Set(numbers);
  ok(numbers.length === N, `all ${N} concurrent reservations returned a number`, JSON.stringify(results));
  ok(uniqueNumbers.size === N, `all ${N} concurrent reservations are UNIQUE (no duplicate job numbers under load)`, JSON.stringify(numbers));
}

async function scenarioH_oldTabCannotDestroyNewerRecords() {
  console.log('\n[Scenario H] Old/stale tab performing several actions cannot destroy a newer session\'s records (Part 14 shape)');
  const start = await getState();
  // "Session B" (newer tab) creates 3 quotes + 2 jobs.
  const bQuotes = Array.from({ length: 3 }, () => ({ id: uid(), num: `SQ-TEST-${uid()}`, client: 'B Client', co: '1', status: 'draft' }));
  const bJobs = Array.from({ length: 2 }, () => makeJob({ client: 'B Client' }));
  await putState({ quotes: [...(start.data.quotes || []), ...bQuotes], jobs: [...(start.data.jobs || []), ...bJobs], _partial: true });
  const afterB = await getState();

  // "Session A" (STALE tab) captured its snapshot BEFORE B's writes and now
  // performs several unrelated partial saves in a row (payment record,
  // invoice edit, PO create) — none of which mention B's new records at all.
  const staleBaseline = start; // A's own baseline never advanced past the original fetch
  const aInvoice = { id: uid(), number: `INV-TEST-${uid()}`, co: '1', client: 'A Client' };
  await putState({ accInvoices: [...(staleBaseline.data.accInvoices || []), aInvoice], _partial: true });
  const aPO = { id: uid(), num: `PO-TEST-${uid()}`, co: '1' };
  await putState({ purchaseOrders: [...(staleBaseline.data.purchaseOrders || []), aPO], _partial: true });
  const aJob2 = makeJob({ client: 'A second unrelated job' });
  await putState({ jobs: [...(staleBaseline.data.jobs || []), aJob2], _partial: true }); // still built from STALE baseline — excludes bJobs

  const finalState = await getState();
  const jobIds = idsOf(finalState.data.jobs);
  const quoteIds = idsOf(finalState.data.quotes);
  ok(bJobs.every((j) => jobIds.has(String(j.id))), 'Session B\'s jobs survive every one of Session A\'s stale partial saves');
  ok(bQuotes.every((q) => quoteIds.has(String(q.id))), 'Session B\'s quotes survive (never touched by A\'s partial saves, never inferred deleted)');
  ok(jobIds.has(String(aJob2.id)), 'Session A\'s own new job was still added');
}

// Reproduces the ACTUAL historical bug shape: a stale payload (built from a
// closure that predates another session's write) sent together with a
// `_knownSectionIds` claim that WAS refreshed after that write (the exact
// "OLD jobs payload + NEW knownSectionIds" combination described in the
// hardening brief as the confirmed mechanism behind SNS-00120..124
// vanishing). This is the negative control: run against the PRE-hardening
// code, this must FAIL (proving the bug is real and this test reproduces
// it); run against the POST-hardening code, this must PASS (proving
// `_knownSectionIds` can no longer cause a deletion at all, even sent in
// exactly this shape).
async function scenarioI_reproduceHistoricalBugShape() {
  console.log('\n[Scenario I] Reproduce the EXACT historical bug shape (stale payload + fresh _knownSectionIds claim)');
  const start = await getState();
  const existingJobs = Array.isArray(start.data.jobs) ? start.data.jobs : [];

  const bJobs = Array.from({ length: 5 }, () => makeJob({ client: 'Historical-Bug Session B' }));
  await putState({ jobs: [...existingJobs, ...bJobs], _partial: true });
  const stateAfterB = await getState();

  // Session A's overrides.jobs predates B's write (stale closure) — but its
  // _knownSectionIds.jobs is read from a baseline that WAS refreshed to
  // include B's jobs (the poll-vs-closure race). This is the literal old
  // savePartialSectionsNow bug, reproduced as a raw HTTP payload.
  const aNewJob = makeJob({ client: 'Historical-Bug Session A' });
  const staleOverridesJobs = [...existingJobs, aNewJob]; // excludes bJobs — stale
  const freshKnownIds = idsOf(stateAfterB.data.jobs); // includes bJobs — NOT stale
  const res = await putState({
    jobs: staleOverridesJobs,
    _partial: true,
    _knownSectionIds: { jobs: Array.from(freshKnownIds) },
  });
  ok(res.status === 200, 'the (buggy-shaped) save itself is accepted (not rejected outright)', JSON.stringify(res.body));

  const finalState = await getState();
  const finalIds = idsOf(finalState.data.jobs);
  const survived = bJobs.every((j) => finalIds.has(String(j.id)));
  ok(survived, 'Session B\'s jobs SURVIVE even the exact historical bug-shaped request (this is the core proof)', `missing: ${JSON.stringify(bJobs.map(j=>j.id).filter(id=>!finalIds.has(String(id))))}`);
}

// ══════════════════════════════════════════════════════════════════════
// 2026-08-20 POST-DEPLOY FIX — Scenarios J–O
// ══════════════════════════════════════════════════════════════════════
// Added after a live production report: an ordinary single-job text edit
// was rejected by detectWipe() with "would drop ... (over 80% loss)". Root
// cause (proven, see platformState.ts's "POST-DEPLOY FIX" comment on the
// merge loop): detectWipe() was evaluating the RAW pre-merge payload rather
// than the post-merge result, so ANY save that legitimately sends fewer
// records than currently exist for a protected section — which the
// "purely additive" partial-save design explicitly allows — looked like a
// catastrophic wipe even though the merge would have safely preserved
// every untouched record. None of Scenarios A–I above ever had >=10
// existing records in a CRITICAL_KEYS section, so this exact interaction
// was structurally invisible to the suite until now — these scenarios
// close that coverage gap at production-realistic scale (100+ jobs).
function seedJobs(n: number, over: (i: number) => Partial<any> = () => ({})): any[] {
  return Array.from({ length: n }, (_, i) => makeJob({ client: `Seed ${i}`, ...over(i) }));
}

// J — Server has 100+ jobs, current user's view only shows/sends a handful.
// Editing ONE of those visible jobs via a small additive partial save must
// only change that job — all 100+ server jobs must remain.
async function scenarioJ_partialSaveOfFewJobsAgainstLargeServerSet() {
  console.log('\n[Scenario J] Server has 100+ jobs, partial save sends only a handful (e.g. a filtered UI view) — all others must survive');
  const start = await getState();
  const existingJobs = Array.isArray(start.data.jobs) ? start.data.jobs : [];
  const bulk = seedJobs(100);
  await putState({ jobs: [...existingJobs, ...bulk], _partial: true });
  const seeded = await getState();
  const totalBefore = idsOf(seeded.data.jobs).size;
  ok(totalBefore >= existingJobs.length + 100, 'setup: 100+ jobs now live', String(totalBefore));

  // Simulate a UI that only knows about / sends 5 of those jobs (e.g. one
  // page of a filtered list), editing exactly one of them.
  const visibleFive = bulk.slice(0, 5).map((j: any, i: number) => (i === 0 ? { ...j, notes: 'edited via small partial save' } : j));
  const res = await putState({ jobs: visibleFive, _partial: true, _baseRevision: seeded.updated_at });
  ok(res.status === 200, 'small partial save (5 of 100+ jobs) is NOT blocked as a wipe', JSON.stringify(res.body));

  const finalState = await getState();
  const diff = assertOnlyExpectedChanges(seeded.data.jobs, finalState.data.jobs, [], []);
  ok(diff.unexpectedRemoved.length === 0, 'no job was unexpectedly removed', JSON.stringify(diff.unexpectedRemoved));
  ok(idsOf(finalState.data.jobs).size === totalBefore, 'total job count is unchanged', `${idsOf(finalState.data.jobs).size} vs ${totalBefore}`);
  const edited = finalState.data.jobs.find((j: any) => String(j.id) === String(bulk[0].id));
  ok(!!edited && edited.notes === 'edited via small partial save', 'the one edited job actually carries the edit');
}

// K — Company-filtered job view: editing one job belonging to company '1'
// via a save that only mentions company '1' jobs must never touch company
// '2' jobs.
async function scenarioK_companyFilteredViewNeverTouchesOtherCompany() {
  console.log('\n[Scenario K] Company-filtered job view — editing one job must never touch another company\'s jobs');
  const start = await getState();
  const existingJobs = Array.isArray(start.data.jobs) ? start.data.jobs : [];
  const co1Jobs = seedJobs(60, () => ({ co: '1' }));
  const co2Jobs = seedJobs(15, () => ({ co: '2' }));
  await putState({ jobs: [...existingJobs, ...co1Jobs, ...co2Jobs], _partial: true });
  const seeded = await getState();

  // "Company 1 view" save: sends ONLY company 1's jobs (a realistic shape
  // for a company-scoped save), with one edited.
  const co1View = co1Jobs.map((j: any, i: number) => (i === 0 ? { ...j, notes: 'co1 edit' } : j));
  const res = await putState({ jobs: co1View, _partial: true, _baseRevision: seeded.updated_at });
  ok(res.status === 200, 'company-scoped partial save is not blocked', JSON.stringify(res.body));

  const finalState = await getState();
  const finalIds = idsOf(finalState.data.jobs);
  ok(co2Jobs.every((j: any) => finalIds.has(String(j.id))), 'every company-2 job survives a company-1-only save', JSON.stringify(co2Jobs.map((j: any) => j.id).filter((id: any) => !finalIds.has(String(id)))));
  ok(co1Jobs.every((j: any) => finalIds.has(String(j.id))), 'every company-1 job survives too (none dropped)');
}

// L — Status-filtered view: editing one WIP job via a save that only
// mentions WIP-status jobs must never touch Completed jobs outside that
// filter.
async function scenarioL_statusFilteredViewNeverTouchesOtherStatus() {
  console.log('\n[Scenario L] Status-filtered view — editing one WIP job must never touch Completed jobs');
  const start = await getState();
  const existingJobs = Array.isArray(start.data.jobs) ? start.data.jobs : [];
  const wipJobs = seedJobs(11, () => ({ status: 'in_production' }));
  const completedJobs = seedJobs(81, () => ({ status: 'complete' }));
  await putState({ jobs: [...existingJobs, ...wipJobs, ...completedJobs], _partial: true });
  const seeded = await getState();

  // "Work In Progress" tab save: sends only the WIP-status jobs, one edited.
  const wipView = wipJobs.map((j: any, i: number) => (i === 0 ? { ...j, notes: 'wip edit' } : j));
  const res = await putState({ jobs: wipView, _partial: true, _baseRevision: seeded.updated_at });
  ok(res.status === 200, 'status-scoped partial save (11 of 92) is not blocked', JSON.stringify(res.body));

  const finalState = await getState();
  const finalIds = idsOf(finalState.data.jobs);
  ok(completedJobs.every((j: any) => finalIds.has(String(j.id))), 'every Completed job survives a WIP-only save', JSON.stringify(completedJobs.map((j: any) => j.id).filter((id: any) => !finalIds.has(String(id)))));
}

// M — Stale tab + filtered view combined: an old/stale session that only
// ever knew about a small filtered slice of jobs performs a partial save;
// a DIFFERENT, newer session's brand-new jobs (created in between) must
// still survive.
async function scenarioM_staleFilteredTabCannotDestroyNewerRecords() {
  console.log('\n[Scenario M] Stale tab + filtered view — newer session\'s jobs survive a stale filtered-view save');
  const start = await getState();
  const existingJobs = Array.isArray(start.data.jobs) ? start.data.jobs : [];
  const staleFilteredView = seedJobs(5, () => ({ co: '4' })); // "Session A" only ever knew these 5
  await putState({ jobs: [...existingJobs, ...staleFilteredView], _partial: true });

  // "Session B" (newer) creates fresh jobs Session A's filtered view never knew about.
  const afterSeed = await getState();
  const bJobs = seedJobs(3, () => ({ co: '2', client: 'Session B (newer)' }));
  await putState({ jobs: [...(afterSeed.data.jobs || []), ...bJobs], _partial: true });

  // Session A, still only aware of its original 5-job filtered view (no
  // `_baseRevision` matching current — its baseline predates Session B's
  // addition), edits one and saves.
  //
  // 2026-08-20 SECOND HARDENING PASS: this now carries a genuine update
  // with no proof of freshness, so it fails closed (409) rather than being
  // silently accepted — the explicitly-authorized fallback for this shape
  // ("otherwise stale one gets 409, but no data loss"). What must still
  // hold: Session B's jobs are completely unaffected either way, since a
  // blocked save writes nothing at all.
  const staleEdit = staleFilteredView.map((j: any, i: number) => (i === 0 ? { ...j, notes: 'stale session edit' } : j));
  const res = await putState({ jobs: staleEdit, _partial: true });
  ok(res.status === 409 && !!res.body?.conflict, 'stale filtered-view save with no baseRevision is blocked (409)', JSON.stringify(res.body));

  const finalState = await getState();
  const finalIds = idsOf(finalState.data.jobs);
  ok(bJobs.every((j: any) => finalIds.has(String(j.id))), 'Session B\'s newer jobs are unaffected by the blocked save', JSON.stringify(bJobs.map((j: any) => j.id).filter((id: any) => !finalIds.has(String(id)))));
}

// N — Explicit real deletion at production scale still works, and ONLY via
// the explicit _deletedIds mechanism — the fix to detectWipe's evaluation
// order must not accidentally block (or accidentally allow via omission) a
// normal, small, legitimate deletion.
async function scenarioN_explicitDeletionAtScaleStillWorks() {
  console.log('\n[Scenario N] Explicit real job deletion at scale — still works ONLY via the explicit mechanism');
  const start = await getState();
  const existingJobs = Array.isArray(start.data.jobs) ? start.data.jobs : [];
  const bulk = seedJobs(50);
  await putState({ jobs: [...existingJobs, ...bulk], _partial: true });
  const seeded = await getState();

  const target = bulk[0];
  const jobsWithoutTarget = seeded.data.jobs.filter((j: any) => String(j.id) !== String(target.id));
  const del = await putState({
    ...seeded.data,
    jobs: jobsWithoutTarget,
    _deletedIds: { jobs: [target.id] },
    _baseRevision: seeded.updated_at,
  });
  ok(del.status === 200, 'explicit single-job deletion at scale succeeds', JSON.stringify(del.body));
  const finalState = await getState();
  const finalIds = idsOf(finalState.data.jobs);
  ok(!finalIds.has(String(target.id)), 'the explicitly-deleted job is actually gone');
  ok(bulk.slice(1).every((j: any) => finalIds.has(String(j.id))), 'every OTHER seeded job survives — deletion touched only the named id');
}

// O — The wipe guard remains fully active: a deliberately destructive
// request (an EXPLICIT bulk deletion removing the vast majority of a
// section) must still be blocked. This is the direct check that the
// detectWipe fix did not weaken the guard — it only corrected what the
// guard measures.
async function scenarioO_wipeGuardStillBlocksDeliberateDestruction() {
  console.log('\n[Scenario O] Wipe guard remains active — blocks a deliberately destructive explicit bulk-delete request');
  const seeded = await getState();
  const currentJobs = Array.isArray(seeded.data.jobs) ? seeded.data.jobs : [];
  // By this point in the suite, `jobs` has accumulated a large amount from
  // every prior scenario — delete a fraction of the CURRENT total (not a
  // fixed count) so this reliably exceeds the 80%-loss threshold regardless
  // of exactly how much has accumulated before this scenario runs.
  const deleteCount = Math.ceil(currentJobs.length * 0.85);
  const toDelete = currentJobs.slice(0, deleteCount).map((j: any) => j.id);
  const survivors = currentJobs.filter((j: any) => !toDelete.map(String).includes(String(j.id)));
  ok(survivors.length <= currentJobs.length * 0.2, 'setup: this deletion is genuinely a >80% loss', `${survivors.length}/${currentJobs.length}`);

  // A legitimate-shaped request (real _deletedIds, real _baseRevision) but
  // one whose scale should still trip the coarse wipe guard as a
  // belt-and-suspenders check on top of the id-level mechanisms.
  const res = await putState({
    ...seeded.data,
    jobs: survivors,
    _deletedIds: { jobs: toDelete },
    _baseRevision: seeded.updated_at,
  });
  ok(res.status === 409, 'a deliberately destructive explicit bulk-delete is still blocked by the wipe guard', JSON.stringify(res.body));

  const finalState = await getState();
  const finalIds = idsOf(finalState.data.jobs);
  ok(toDelete.every((id: any) => finalIds.has(String(id))), 'none of the targeted jobs were actually removed — the blocked save wrote nothing');
}

// ══════════════════════════════════════════════════════════════════════
// 2026-08-20 POST-DEPLOY FIX #2 — Scenarios P–W (jobs-duplication incident)
// ══════════════════════════════════════════════════════════════════════
// A live "edit one job, save" action doubled the ENTIRE jobs collection:
// 222 total jobs / 111 unique ids / every id present exactly twice, every
// field identical. Root cause (proven, see platformState.ts's "POST-DEPLOY
// FIX #2" comment on the merge loop): `incomingIds` is a Set<string>
// (idsOf() stringifies), but the preserved-existing filter compared it
// against the RAW, non-stringified `x.id`. Real job/quote/etc ids are JS
// NUMBERS (Date.now()-style), so `Set<string>.has(number)` was ALWAYS
// false — every existing record looked "not already in incoming", even
// when it genuinely was, and got re-appended. None of Scenarios A-O above
// ever exercised this: `makeJob()`'s ids are STRINGS (`uid()` returns a
// string), which never triggers the type mismatch. These scenarios use
// NUMERIC ids (`makeNumericJob()`) specifically to match production data
// and actually exercise the bug that shipped. Mapped 1:1 to the incident
// report's required regression scenarios A-H (lettered P-W here since A-O
// are already in use).
let numIdCounter = 0;
function numUid(): number {
  numIdCounter += 1;
  return Date.now() + numIdCounter; // JS number — matches real job/quote ids
}
function makeNumericJob(over: Partial<any> = {}) {
  return { id: numUid(), num: `SNS-TEST-${uid()}`, client: 'Test Client', co: '1', status: 'quote_approved', quoteNum: null, ...over };
}
// A real `mergeAndSave`-shaped full-state save: spreads the CURRENT live
// state and overrides only the given sections — this is the exact shape
// that shipped the duplication bug (mergeAndSave never sets `_partial`).
async function fullSave(overrides: Record<string, any>): Promise<{ status: number; body: any }> {
  const current = await getState();
  // 2026-08-20 SECOND HARDENING PASS: a real client (mergeAndSave) always
  // carries `_baseRevision` — the backend now requires it whenever a save
  // contains a genuine update to an already-existing record (not just
  // deletions), to close the stale-same-record-overwrite hole. `current` was
  // just fetched fresh above, so its revision is the correct basis here.
  return putState({ ...current.data, ...overrides, _baseRevision: current.updated_at });
}

// P (req. A) — Full save: server has 111 numeric-id jobs, a full-state save
// sends the SAME ids back (one edited) — final must be 111, NOT 222.
async function scenarioP_fullSaveSameIdsNeverDuplicates() {
  console.log('\n[Scenario P] (req. A) Full save of unchanged ids (one edited) — 111 jobs stay 111, never become 222');
  const start = await getState();
  const beforeJobs = Array.isArray(start.data.jobs) ? start.data.jobs : [];
  const batch = Array.from({ length: 111 }, () => makeNumericJob({ client: 'Batch P' }));
  await putState({ jobs: [...beforeJobs, ...batch], _partial: true });
  const seeded = await getState();
  const totalBefore = seeded.data.jobs.length;
  ok(idsOf(seeded.data.jobs).size === totalBefore, 'setup: no duplicate ids before the test save', String(totalBefore));

  const edited = seeded.data.jobs.map((j: any) => (String(j.id) === String(batch[0].id) ? { ...j, notes: 'edited via full save' } : j));
  const res = await fullSave({ jobs: edited });
  ok(res.status === 200, 'full save of unchanged ids is accepted', JSON.stringify(res.body));

  const finalState = await getState();
  ok(finalState.data.jobs.length === totalBefore, `job count is UNCHANGED (${totalBefore}), not doubled`, String(finalState.data.jobs.length));
  ok(idsOf(finalState.data.jobs).size === totalBefore, 'no id occurs more than once after the save');
  const editedJob = finalState.data.jobs.find((j: any) => String(j.id) === String(batch[0].id));
  ok(!!editedJob && editedJob.notes === 'edited via full save', 'the one edited job carries the edit exactly once');
}

// Q (req. B) — Partial save of 5 EXISTING numeric-id jobs (edits only) —
// final count unchanged, none duplicated.
async function scenarioQ_partialSaveFiveExistingEditsNeverDuplicates() {
  console.log('\n[Scenario Q] (req. B) Partial save of 5 EXISTING numeric-id jobs (edits only) — none duplicated');
  const start = await getState();
  const beforeJobs = Array.isArray(start.data.jobs) ? start.data.jobs : [];
  const batch = Array.from({ length: 20 }, () => makeNumericJob({ client: 'Batch Q' }));
  await putState({ jobs: [...beforeJobs, ...batch], _partial: true });
  const seeded = await getState();
  const totalBefore = seeded.data.jobs.length;

  const fiveEdited = batch.slice(0, 5).map((j: any, i: number) => ({ ...j, notes: `edit ${i}` }));
  const res = await putState({ jobs: fiveEdited, _partial: true, _baseRevision: seeded.updated_at });
  ok(res.status === 200, 'partial save of 5 existing numeric-id jobs is accepted', JSON.stringify(res.body));

  const finalState = await getState();
  ok(finalState.data.jobs.length === totalBefore, `job count unchanged (${totalBefore})`, String(finalState.data.jobs.length));
  ok(idsOf(finalState.data.jobs).size === totalBefore, 'no id duplicated');
  const stillFive = batch.slice(0, 5).every((j: any, i: number) => {
    const rec = finalState.data.jobs.find((x: any) => String(x.id) === String(j.id));
    return rec && rec.notes === `edit ${i}`;
  });
  ok(stillFive, 'all 5 edits landed, each id appears exactly once');
}

// R (req. C) — One brand-new numeric-id job + one edit — count grows by
// exactly 1, no duplication.
async function scenarioR_newNumericJobAddsExactlyOne() {
  console.log('\n[Scenario R] (req. C) One brand-new numeric-id job + one edit — count grows by exactly 1, no duplication');
  const start = await getState();
  const beforeJobs = Array.isArray(start.data.jobs) ? start.data.jobs : [];
  const batch = Array.from({ length: 10 }, () => makeNumericJob({ client: 'Batch R' }));
  await putState({ jobs: [...beforeJobs, ...batch], _partial: true });
  const seeded = await getState();
  const totalBefore = seeded.data.jobs.length;

  const newJob = makeNumericJob({ client: 'Brand New R' });
  const changedId = batch[0].id;
  const payload = seeded.data.jobs
    .map((j: any) => (String(j.id) === String(changedId) ? { ...j, notes: 'changed' } : j))
    .concat([newJob]);
  const res = await fullSave({ jobs: payload });
  ok(res.status === 200, 'full save with one new + one changed job is accepted', JSON.stringify(res.body));

  const finalState = await getState();
  ok(finalState.data.jobs.length === totalBefore + 1, `job count grew by exactly 1 (${totalBefore} -> ${totalBefore + 1})`, String(finalState.data.jobs.length));
  ok(idsOf(finalState.data.jobs).has(String(newJob.id)), 'the new job is present');
  ok(idsOf(finalState.data.jobs).size === finalState.data.jobs.length, 'no id duplicated');
}

// S (req. D) — Duplicate ids ACCIDENTALLY present in the incoming payload
// itself (a client-side bug) — hard blocked by the independent backstop,
// nothing written.
async function scenarioS_duplicateIdsInIncomingHardBlocked() {
  console.log('\n[Scenario S] (req. D) Duplicate ids accidentally present in the incoming payload — hard blocked, nothing written');
  const start = await getState();
  const before = start.data.jobs || [];
  const beforeCount = before.length;
  const job = makeNumericJob({ client: 'Dup Incoming' });
  const res = await putState({ jobs: [...before, job, { ...job, notes: 'accidental client-side dup' }], _partial: true });
  ok(res.status !== 200, 'save with a duplicate id inside the incoming array is rejected', JSON.stringify(res.body));

  const finalState = await getState();
  ok(finalState.data.jobs.length === beforeCount, 'nothing was written — job count unchanged', String(finalState.data.jobs.length));
  ok(!idsOf(finalState.data.jobs).has(String(job.id)), 'the duplicated job was not partially written either');
}

// T (req. E) — Duplicate ids already sitting in EXISTING data (simulated
// legacy corruption predating this fix), carried forward by an UNRELATED,
// correctly-shaped additive save that never mentions those ids at all. This
// proves the backstop is independent of the merge implementation: the merge
// here is doing exactly what it's supposed to (preserving untouched
// existing records) — the corruption is pre-existing, not caused by this
// save — and the backstop must still refuse to persist it.
async function scenarioT_duplicateIdsFromPreexistingCorruptionHardBlocked() {
  console.log('\n[Scenario T] (req. E) Duplicate ids already present in EXISTING data, preserved by an unrelated additive save — hard blocked');
  const { Client } = await import('pg');
  const pgClient = new Client({ connectionString: DB_URL });
  await pgClient.connect();
  let cur: { data: any; updated_at: string | null } | null = null;
  try {
    cur = await getState();
    const corruptJob = makeNumericJob({ client: 'Legacy Corrupt' });
    const corruptedJobs = [...(cur.data.jobs || []), corruptJob, { ...corruptJob }];
    await pgClient.query(
      `UPDATE platform_state SET data = jsonb_set(data, '{jobs}', $1::jsonb) WHERE id = 1`,
      [JSON.stringify(corruptedJobs)]
    );

    const beforeUnrelated = await getState();
    ok(idsOf(beforeUnrelated.data.jobs).size < beforeUnrelated.data.jobs.length, 'setup: DB now genuinely contains a duplicate id (simulated legacy corruption)', String(beforeUnrelated.data.jobs.length));

    const unrelated = makeNumericJob({ client: 'Unrelated T' });
    const res = await putState({ jobs: [unrelated], _partial: true });
    ok(res.status !== 200, 'unrelated additive save that would carry forward a pre-existing duplicate id is blocked', JSON.stringify(res.body));

    const afterState = await getState();
    ok(!idsOf(afterState.data.jobs).has(String(unrelated.id)), 'the unrelated new job was NOT written either — the whole save aborted');
    ok(afterState.data.jobs.length === corruptedJobs.length, 'the corrupted state itself is unchanged (save aborted before any write)', String(afterState.data.jobs.length));
  } finally {
    // This scenario deliberately injects a duplicate-id corruption directly
    // via SQL (bypassing the API entirely) to prove the backstop is
    // independent of the merge. That corruption must NOT leak into every
    // scenario that runs after this one against the same persistent test
    // DB — restore the pre-corruption jobs array here, regardless of
    // whether the assertions above passed or failed.
    if (cur) {
      await pgClient.query(
        `UPDATE platform_state SET data = jsonb_set(data, '{jobs}', $1::jsonb) WHERE id = 1`,
        [JSON.stringify(cur.data.jobs || [])]
      );
    }
    await pgClient.end();
  }
}

// U (req. F) — Explicit delete of one numeric-id job — final = existing - 1,
// no duplication side-effect.
async function scenarioU_explicitDeleteOfOneNumericJob() {
  console.log('\n[Scenario U] (req. F) Explicit delete of one numeric-id job — final = existing - 1, no duplication side-effect');
  const start = await getState();
  const beforeJobs = start.data.jobs || [];
  const batch = Array.from({ length: 6 }, () => makeNumericJob({ client: 'Batch U' }));
  await putState({ jobs: [...beforeJobs, ...batch], _partial: true });
  const seeded = await getState();
  const totalBefore = seeded.data.jobs.length;

  const target = batch[0];
  const jobsWithoutTarget = seeded.data.jobs.filter((j: any) => String(j.id) !== String(target.id));
  const del = await putState({
    ...seeded.data,
    jobs: jobsWithoutTarget,
    _deletedIds: { jobs: [target.id] },
    _baseRevision: seeded.updated_at,
  });
  ok(del.status === 200, 'explicit delete of one numeric-id job succeeds', JSON.stringify(del.body));

  const finalState = await getState();
  ok(finalState.data.jobs.length === totalBefore - 1, `job count is exactly one less (${totalBefore - 1})`, String(finalState.data.jobs.length));
  ok(!idsOf(finalState.data.jobs).has(String(target.id)), 'the deleted job is actually gone');
  ok(idsOf(finalState.data.jobs).size === finalState.data.jobs.length, 'no id duplicated by the delete save');
}

// V (req. G) — Stale full-save payload (mergeAndSave shape), sent with NO
// `_baseRevision` (or a stale one) after an unrelated concurrent addition.
// 2026-08-20 SECOND HARDENING PASS: this save now carries a GENUINE update
// (Session A edits its own job's notes) with no proof of freshness, so the
// backend fails closed with a structured 409 rather than guessing whether
// it's safe — exactly the explicitly-authorized fallback for this case
// ("otherwise stale one gets 409, but no data loss"). The important
// guarantee is unchanged: nothing is duplicated, nothing is lost, and
// Session B's concurrent addition is completely unaffected either way,
// because a blocked save writes nothing at all.
async function scenarioV_staleFullSavePayloadBlockedNoDataLoss() {
  console.log('\n[Scenario V] (req. G) Stale full-save payload with no baseRevision — blocked (409), zero data loss');
  const start = await getState();
  const beforeJobs = start.data.jobs || [];
  const aBatch = Array.from({ length: 8 }, () => makeNumericJob({ client: 'Session A (stale)' }));
  await putState({ jobs: [...beforeJobs, ...aBatch], _partial: true });
  const aBaseline = await getState(); // "Session A" captures its full snapshot here

  const bBatch = Array.from({ length: 4 }, () => makeNumericJob({ client: 'Session B (newer)' }));
  await putState({ jobs: [...aBaseline.data.jobs, ...bBatch], _partial: true });
  const afterB = await getState();

  // Session A performs a FULL save (mergeAndSave shape) built from its
  // STALE snapshot — one of its OWN jobs edited — excluding B's jobs
  // entirely, with no _deletedIds and no _baseRevision at all (simulating an
  // old/cached client, or one whose baseline predates B's save).
  const staleEdited = aBaseline.data.jobs.map((j: any) => (String(j.id) === String(aBatch[0].id) ? { ...j, notes: 'stale session edit' } : j));
  const res = await putState({ ...aBaseline.data, jobs: staleEdited });
  ok(res.status === 409 && !!res.body?.conflict, 'stale full-state save with no baseRevision is blocked with a structured 409', JSON.stringify(res.body));

  const finalState = await getState();
  const finalIds = idsOf(finalState.data.jobs);
  ok(bBatch.every((j: any) => finalIds.has(String(j.id))), 'Session B\'s newer jobs all survive the blocked save', JSON.stringify(bBatch.map((j: any) => j.id).filter((id: any) => !finalIds.has(String(id)))));
  ok(idsOf(finalState.data.jobs).size === finalState.data.jobs.length, 'no id was duplicated');
  ok(finalState.data.jobs.length === afterB.data.jobs.length, `job count unchanged — the blocked save wrote nothing (${afterB.data.jobs.length})`, String(finalState.data.jobs.length));
}

// W (req. H) — Wipe guard remains fully active after BOTH post-deploy
// fixes: a deliberately destructive explicit bulk-delete is still blocked.
async function scenarioW_wipeGuardStillBlocksRealDestructiveLossAfterBothFixes() {
  console.log('\n[Scenario W] (req. H) Wipe guard still blocks a genuinely destructive explicit bulk-delete, after both post-deploy fixes');
  const seeded = await getState();
  const currentJobs = Array.isArray(seeded.data.jobs) ? seeded.data.jobs : [];
  const deleteCount = Math.ceil(currentJobs.length * 0.85);
  const toDelete = currentJobs.slice(0, deleteCount).map((j: any) => j.id);
  const survivors = currentJobs.filter((j: any) => !toDelete.map(String).includes(String(j.id)));
  ok(survivors.length <= currentJobs.length * 0.2, 'setup: this deletion is genuinely a >80% loss', `${survivors.length}/${currentJobs.length}`);

  const res = await putState({
    ...seeded.data,
    jobs: survivors,
    _deletedIds: { jobs: toDelete },
    _baseRevision: seeded.updated_at,
  });
  ok(res.status === 409, 'deliberately destructive bulk-delete is still blocked', JSON.stringify(res.body));

  const finalState = await getState();
  const finalIds = idsOf(finalState.data.jobs);
  ok(toDelete.every((id: any) => finalIds.has(String(id))), 'none of the targeted jobs were removed — blocked save wrote nothing');
  ok(idsOf(finalState.data.jobs).size === finalState.data.jobs.length, 'no duplication side effect either');
}

// X (req. F, 2026-08-20 SECOND HARDENING PASS) — SAME-RECORD CONFLICT.
// Session A and B both load job X. B changes its notes and saves (succeeds,
// revision advances). A later saves an OLDER copy of the SAME job X, built
// from its now-stale baseline (predates B's save), carrying no
// `_baseRevision` that matches the current server revision. B's newer notes
// must never be silently reverted — the save is either detected as a
// conflict (409, this implementation's chosen behavior) or, if somehow
// accepted, must still show B's content, never A's.
async function scenarioX_sameRecordConflictNeverSilentlyReverted() {
  console.log('\n[Scenario X] (req. F, 2nd pass) Same-record conflict — B\'s newer edit must never be silently reverted by A\'s stale save');
  const start = await getState();
  const job = makeNumericJob({ client: 'Shared Job X', notes: 'original' });
  await putState({ jobs: [...(start.data.jobs || []), job], _partial: true, _baseRevision: start.updated_at });

  // Both A and B "load" job X at this point.
  const aView = await getState();
  const bView = await getState();

  // B edits and saves first — succeeds, revision advances.
  const bEdited = bView.data.jobs.map((j: any) => (String(j.id) === String(job.id) ? { ...j, notes: 'B notes — newer' } : j));
  const bRes = await putState({ jobs: [bEdited.find((j: any) => String(j.id) === String(job.id))], _partial: true, _baseRevision: bView.updated_at });
  ok(bRes.status === 200, 'B\'s edit (based on a current baseline) is accepted', JSON.stringify(bRes.body));

  // A now saves its OWN (older, pre-B) copy of the SAME job, via a
  // mergeAndSave-shaped full save — no _baseRevision matching the CURRENT
  // (post-B) server revision, because A's snapshot predates B's save.
  const aStaleEdited = aView.data.jobs.map((j: any) => (String(j.id) === String(job.id) ? { ...j, notes: 'A notes — stale, should not win' } : j));
  const aRes = await putState({ ...aView.data, jobs: aStaleEdited, _baseRevision: aView.updated_at });

  const finalState = await getState();
  const finalJob = finalState.data.jobs.find((j: any) => String(j.id) === String(job.id));
  if (aRes.status === 200) {
    // Accepted only if the architecture judged it provably safe — even then,
    // B's content must never have been silently reverted.
    ok(finalJob && finalJob.notes === 'B notes — newer', 'if A\'s save was accepted anyway, B\'s newer notes still won (never silently reverted)', JSON.stringify(finalJob));
  } else {
    ok(aRes.status === 409 && !!aRes.body?.conflict, 'A\'s stale same-record save is blocked with a structured 409', JSON.stringify(aRes.body));
    ok(finalJob && finalJob.notes === 'B notes — newer', 'B\'s newer notes are intact — nothing was reverted', JSON.stringify(finalJob));
  }
}

// Y (req. M, 2026-08-20 SECOND HARDENING PASS) — NEGATIVE CONTROL. Runs the
// OLD "incoming array + filtered-existing array" concatenation formula
// (exact shape of the confirmed production bug — a Set<string> compared
// against a raw, un-stringified numeric id) against the SAME 111 server +
// 111 incoming input the new mergeSectionById() implementation is proven
// safe against elsewhere in this suite. Proves the old shape really did
// double records (111 -> 222) and the new implementation, run on identical
// input, does not (111 -> 111) — a pure, isolated, in-process comparison
// requiring no HTTP call.
function scenarioY_negativeControlOldAlgorithmDoubles() {
  console.log('\n[Scenario Y] (req. M) Negative control — old concatenation algorithm doubles, new Map merge does not');
  const existingList = Array.from({ length: 111 }, () => makeNumericJob({ client: 'NegControl' }));
  const incoming = existingList; // "same 111 ids", exactly the production shape

  // ── OLD (buggy) implementation, reproduced verbatim from the pre-fix
  //    source: incomingIds is Set<string>, but existing x.id is compared in
  //    its RAW (numeric) form — always false, so nothing is ever filtered
  //    out, and incoming + existing concatenates to double every record. ──
  const incomingIdsOld = new Set(incoming.map((x: any) => String(x.id)));
  const preservedOld = existingList.filter((x: any) => x && !incomingIdsOld.has(x.id as any)); // BUG: no String(x.id)
  const oldResult = [...incoming, ...preservedOld];
  ok(oldResult.length === 222, 'OLD algorithm: 111 existing + 111 incoming (same ids) doubles to 222 (reproduces the production bug)', String(oldResult.length));

  // ── NEW implementation (mirrors mergeSectionById's Map formula exactly) ──
  const resultById = new Map(existingList.map((r: any) => [String(r.id), r]));
  for (const rec of incoming) resultById.set(String(rec.id), rec);
  const newResult = Array.from(resultById.values());
  ok(newResult.length === 111, 'NEW Map-merge algorithm: 111 existing + 111 incoming (same ids) stays 111', String(newResult.length));
}

async function main() {
  await login();
  console.log(`[hardening-stress] Logged in. Target: ${BASE}. DB: ${DB_URL.replace(/:[^:@]*@/, ':***@')}`);

  await scenarioA_additivePartialSaveNeverDeletes();
  await scenarioB_explicitDeleteWorks();
  await scenarioC_staleRevisionBlocksDeletion();
  await scenarioD_duplicateConversionBlocked();
  await scenarioE_numberCollisionRecoverable();
  await scenarioF_missingDocumentReservationRecovery();
  await scenarioG_concurrentReservationsUnique();
  await scenarioH_oldTabCannotDestroyNewerRecords();
  await scenarioI_reproduceHistoricalBugShape();
  await scenarioJ_partialSaveOfFewJobsAgainstLargeServerSet();
  await scenarioK_companyFilteredViewNeverTouchesOtherCompany();
  await scenarioL_statusFilteredViewNeverTouchesOtherStatus();
  await scenarioM_staleFilteredTabCannotDestroyNewerRecords();
  await scenarioN_explicitDeletionAtScaleStillWorks();
  await scenarioO_wipeGuardStillBlocksDeliberateDestruction();
  await scenarioP_fullSaveSameIdsNeverDuplicates();
  await scenarioQ_partialSaveFiveExistingEditsNeverDuplicates();
  await scenarioR_newNumericJobAddsExactlyOne();
  await scenarioS_duplicateIdsInIncomingHardBlocked();
  await scenarioT_duplicateIdsFromPreexistingCorruptionHardBlocked();
  await scenarioU_explicitDeleteOfOneNumericJob();
  await scenarioV_staleFullSavePayloadBlockedNoDataLoss();
  await scenarioW_wipeGuardStillBlocksRealDestructiveLossAfterBothFixes();
  await scenarioX_sameRecordConflictNeverSilentlyReverted();
  scenarioY_negativeControlOldAlgorithmDoubles();

  // req. B repeated 10x: full save of the SAME ids back (one re-edited each
  // time) must stay at the same count every single time — never creep up.
  console.log('\n[Scenario Z] (req. B x10) Repeat full-save-of-same-ids 10 times — count never changes');
  {
    const seeded = await getState();
    const before = seeded.data.jobs.length;
    let ok10 = true;
    for (let i = 0; i < 10; i++) {
      const cur = await getState();
      const edited = cur.data.jobs.map((j: any, idx: number) => (idx === 0 ? { ...j, notes: `repeat-${i}` } : j));
      const res = await putState({ ...cur.data, jobs: edited, _baseRevision: cur.updated_at });
      if (res.status !== 200) { ok10 = false; console.log(`  ✗ iteration ${i} rejected:`, JSON.stringify(res.body)); break; }
      const after = await getState();
      if (after.data.jobs.length !== before) { ok10 = false; console.log(`  ✗ iteration ${i}: count changed ${before} -> ${after.data.jobs.length}`); break; }
    }
    ok(ok10, `job count stayed at ${before} across all 10 repeated full saves`, String(before));
  }

  console.log(`\n${'='.repeat(60)}\n${passed} passed, ${failures} failed\n${'='.repeat(60)}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[hardening-stress] Fatal error:', err);
  process.exit(1);
});
