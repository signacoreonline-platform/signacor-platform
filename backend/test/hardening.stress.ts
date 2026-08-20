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

  console.log(`\n${'='.repeat(60)}\n${passed} passed, ${failures} failed\n${'='.repeat(60)}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[hardening-stress] Fatal error:', err);
  process.exit(1);
});
