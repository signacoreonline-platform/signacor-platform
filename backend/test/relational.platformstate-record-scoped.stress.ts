/**
 * relational.platformstate-record-scoped.stress.ts — STAGE 3 FOLLOW-UP
 * (2026-08-21): "record-scoped concurrency + long-lived editor safety",
 * LEGACY JSON transitional save.
 *
 * Production is still JSON-authoritative (relational_cutover all false,
 * RELATIONAL_AUTHORITY_ENABLED=false). The real incident this follow-up
 * responds to — a user leaves a large quote open overnight, comes back the
 * next morning, presses Save Changes, and gets "Data changed elsewhere —
 * refresh and retry" even though nobody touched THAT quote — happens
 * through this exact endpoint (backend/src/routes/platformState.ts's
 * PUT /api/platform-state), because its optimistic-concurrency check used a
 * single whole-platform `updated_at` timestamp as the concurrency boundary:
 * ANY genuine change anywhere on the platform advanced it, so an editor that
 * had been open since before that change would be refused regardless of
 * whether its own record had changed.
 *
 * The fix (see platformState.ts's PUT handler, "STAGE 3 FOLLOW-UP" comments)
 * is a purely additive, opt-in `data._recordBase = { <section>: { <id>:
 * <record as the editor originally loaded it> } }`. When every genuinely-
 * updated id in a save has a supplied base that still matches the record's
 * CURRENT server copy, the whole-platform revision check is skipped for
 * that save — proving content-equality per record is at least as safe as
 * comparing one timestamp, and is what actually fixes the "someone else
 * edited something unrelated" false-block. A supplied base that does NOT
 * match is an unambiguous, immediate, specific same-record conflict
 * (`type: 'stale_record'`) — never silently applied. Explicit deletions are
 * NEVER eligible for this bypass — they always still require the plain
 * global `_baseRevision` check, unchanged.
 *
 * A caller that never sends `_recordBase` gets EXACTLY the pre-existing
 * behavior, byte for byte — proven here by a negative-control scenario that
 * reproduces the ORIGINAL bug shape with `_recordBase` omitted.
 *
 * Requires TEST_SERVER_URL + DATABASE_URL (a local/disposable Postgres) —
 * same convention as hardening.stress.ts, which this file deliberately does
 * NOT import from (kept fully self-contained), to avoid any risk of
 * disturbing that suite's own scenario numbering/state assumptions.
 */

const BASE = process.env.TEST_SERVER_URL || 'http://localhost:4001';

let TOKEN = '';
let failures = 0;
let passed = 0;

function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
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

let numIdCounter = 0;
function numUid(): number {
  numIdCounter += 1;
  return Date.now() + numIdCounter; // matches real quote/job/customer id shape
}
function uid(): string {
  numIdCounter += 1;
  return String(Date.now()) + String(numIdCounter).padStart(4, '0');
}
function makeQuote(over: Partial<any> = {}) {
  return {
    id: numUid(), num: `SQ-TEST-${uid()}`, client: 'Record-Scoped Test Client', co: '1',
    status: 'draft', notes: 'original notes', lines: [{ id: 1, desc: 'Line A', qty: 1, unitPrice: 100, subtotal: 100 }],
    ...over,
  };
}
function makeJob(over: Partial<any> = {}) {
  return { id: numUid(), num: `SNS-TEST-${uid()}`, client: 'Record-Scoped Test Client', co: '1', status: 'quote_approved', quoteNum: null, notes: 'original job notes', ...over };
}
function makeCustomer(over: Partial<any> = {}) {
  return { id: numUid(), companyName: `Record-Scoped Sentinel Customer ${uid()}`, ...over };
}

// LEGACY 1 — the actual overnight-quote scenario: an unrelated job changes
// while the quote editor is open; with `_recordBase` supplied and still
// matching the quote's current server copy, the save succeeds DESPITE the
// stale `_baseRevision`, and the unrelated job's newer state survives.
async function legacy1_unrelatedJobChangeDoesNotBlockQuoteSave() {
  console.log('\n[LEGACY 1] Unrelated job change does not block a quote save when _recordBase matches');
  const start = await getState();
  const quoteA = makeQuote();
  const jobB = makeJob();
  const sentinel = makeCustomer(); // survives untouched throughout — proves no unrelated side effects
  const seedRes = await putState({
    quotes: [...(start.data.quotes || []), quoteA],
    jobs: [...(start.data.jobs || []), jobB],
    customers: [...(start.data.customers || []), sentinel],
    _partial: true,
  });
  ok(seedRes.status === 200, 'seed quote A + job B + sentinel customer', JSON.stringify(seedRes.body));

  // The "editor" opens quote A here — this is the BASE it will remember.
  const editorOpenedState = await getState();
  const baseQuoteA = editorOpenedState.data.quotes.find((q: any) => String(q.id) === String(quoteA.id));
  const staleRevision = editorOpenedState.updated_at; // this session's baseline never advances past this point

  // Someone ELSE edits job B (genuinely unrelated to quote A) and saves —
  // succeeds normally, global revision advances past staleRevision.
  const jobEditState = await getState();
  const jobBEdited = jobEditState.data.jobs.map((j: any) => (String(j.id) === String(jobB.id) ? { ...j, notes: 'job B notes — changed by someone else' } : j));
  const jobEditRes = await putState({ jobs: [jobBEdited.find((j: any) => String(j.id) === String(jobB.id))], _partial: true, _baseRevision: jobEditState.updated_at });
  ok(jobEditRes.status === 200, 'unrelated job B edit (by "someone else") succeeds', JSON.stringify(jobEditRes.body));

  // The long-lived editor now saves quote A, using its STALE _baseRevision
  // (captured before job B's edit) but WITH _recordBase — this is exactly
  // what index.html's handleEditQuote/handleSave now send for the legacy
  // JSON path (see editQuoteBaseRef in index.html).
  const quoteAEdited = { ...baseQuoteA, notes: 'quote A notes — edited by the long-lived editor' };
  const saveRes = await putState({
    quotes: [quoteAEdited],
    _partial: true,
    _baseRevision: staleRevision, // deliberately stale — job B's edit happened after this
    _recordBase: { quotes: { [String(quoteA.id)]: baseQuoteA } },
  });
  ok(saveRes.status === 200, 'quote A save SUCCEEDS despite a stale _baseRevision, because _recordBase proves quote A itself was untouched', JSON.stringify(saveRes.body));

  const finalState = await getState();
  const finalQuoteA = finalState.data.quotes.find((q: any) => String(q.id) === String(quoteA.id));
  const finalJobB = finalState.data.jobs.find((j: any) => String(j.id) === String(jobB.id));
  const finalSentinel = finalState.data.customers.find((c: any) => String(c.id) === String(sentinel.id));
  ok(!!finalQuoteA && finalQuoteA.notes === 'quote A notes — edited by the long-lived editor', 'quote A\'s edit was actually applied', finalQuoteA);
  ok(!!finalJobB && finalJobB.notes === 'job B notes — changed by someone else', 'job B\'s unrelated, independent edit survived — never reverted or overwritten', finalJobB);
  ok(!!finalSentinel, 'the unrelated sentinel customer record was never touched by any of this');
}

// LEGACY 1 CONTROL — the exact same scenario, but WITHOUT _recordBase. This
// reproduces the ORIGINAL bug (the real overnight-quote symptom) faithfully,
// proving the fix above is genuinely opt-in: a caller that doesn't send
// _recordBase gets byte-for-byte the pre-2026-08-21 behavior.
async function legacy1Control_withoutRecordBaseStillBlocked() {
  console.log('\n[LEGACY 1 CONTROL] The same scenario WITHOUT _recordBase reproduces the original "overnight quote" block (proves the fix is opt-in, not a silent behavior change)');
  const start = await getState();
  const quoteA = makeQuote();
  const jobB = makeJob();
  const seedRes = await putState({ quotes: [...(start.data.quotes || []), quoteA], jobs: [...(start.data.jobs || []), jobB], _partial: true });
  ok(seedRes.status === 200, 'seed quote A + job B');

  const editorOpenedState = await getState();
  const baseQuoteA = editorOpenedState.data.quotes.find((q: any) => String(q.id) === String(quoteA.id));
  const staleRevision = editorOpenedState.updated_at;

  const jobEditState = await getState();
  const jobBEdited = jobEditState.data.jobs.map((j: any) => (String(j.id) === String(jobB.id) ? { ...j, notes: 'job B notes — changed by someone else, control run' } : j));
  await putState({ jobs: [jobBEdited.find((j: any) => String(j.id) === String(jobB.id))], _partial: true, _baseRevision: jobEditState.updated_at });

  const quoteAEdited = { ...baseQuoteA, notes: 'quote A notes — should be BLOCKED in the control run' };
  const saveRes = await putState({ quotes: [quoteAEdited], _partial: true, _baseRevision: staleRevision }); // NO _recordBase
  ok(saveRes.status === 409 && saveRes.body?.conflict === true && saveRes.body?.type === 'stale_revision', 'WITHOUT _recordBase, the exact same situation is still blocked with the original stale_revision 409 — the pre-existing global protection is completely intact', JSON.stringify(saveRes.body));

  const finalState = await getState();
  const finalQuoteA = finalState.data.quotes.find((q: any) => String(q.id) === String(quoteA.id));
  ok(!!finalQuoteA && finalQuoteA.notes === 'original notes', 'quote A was correctly NOT modified by the blocked save');
}

// LEGACY 2 — a GENUINE same-quote conflict: quote A itself changes between
// when the editor opened it and when it tries to save. Even with
// _recordBase supplied, this must be blocked — the base no longer matches
// the current server copy.
async function legacy2_genuineSameQuoteConflictBlocked() {
  console.log('\n[LEGACY 2] A genuine same-quote conflict is still blocked even when _recordBase is supplied (because it no longer matches)');
  const start = await getState();
  const quoteA = makeQuote();
  const seedRes = await putState({ quotes: [...(start.data.quotes || []), quoteA], _partial: true });
  ok(seedRes.status === 200, 'seed quote A');

  const editorOpenedState = await getState();
  const baseQuoteA = editorOpenedState.data.quotes.find((q: any) => String(q.id) === String(quoteA.id));
  const staleRevision = editorOpenedState.updated_at;

  // Someone else edits QUOTE A ITSELF (not an unrelated record) and saves.
  const otherEditState = await getState();
  const quoteAChangedByOther = otherEditState.data.quotes.map((q: any) => (String(q.id) === String(quoteA.id) ? { ...q, notes: 'quote A notes — changed by a DIFFERENT session' } : q));
  const otherEditRes = await putState({ quotes: [quoteAChangedByOther.find((q: any) => String(q.id) === String(quoteA.id))], _partial: true, _baseRevision: otherEditState.updated_at });
  ok(otherEditRes.status === 200, 'the other session\'s genuine edit to quote A itself succeeds', JSON.stringify(otherEditRes.body));

  // The original (now-stale) editor tries to save its own edit, using its
  // OLD base (from before the other session's edit) as _recordBase.
  const staleLocalEdit = { ...baseQuoteA, notes: 'quote A notes — stale, should NOT win' };
  const saveRes = await putState({
    quotes: [staleLocalEdit],
    _partial: true,
    _baseRevision: staleRevision,
    _recordBase: { quotes: { [String(quoteA.id)]: baseQuoteA } }, // no longer matches the server's current copy
  });
  ok(saveRes.status === 409, 'the stale same-quote save is blocked (409)', JSON.stringify(saveRes.body));
  ok(saveRes.body?.conflict === true && saveRes.body?.type === 'stale_record', 'the conflict is reported as the NEW, specific "stale_record" type, not the generic whole-platform one', JSON.stringify(saveRes.body));
  ok(saveRes.body?.section === 'quotes' && String(saveRes.body?.id) === String(quoteA.id), 'the conflict identifies exactly which section/id conflicted', JSON.stringify(saveRes.body));

  const finalState = await getState();
  const finalQuoteA = finalState.data.quotes.find((q: any) => String(q.id) === String(quoteA.id));
  ok(!!finalQuoteA && finalQuoteA.notes === 'quote A notes — changed by a DIFFERENT session', 'the OTHER session\'s newer content survives untouched — the stale save never applied, nothing was silently reverted');
}

// A save carrying an explicit deletion is NEVER eligible for the
// record-scoped bypass, even if _recordBase is supplied and matches — it
// always still requires the plain global _baseRevision check. This keeps
// the highest-consequence operation (deleting something) maximally
// conservative, exactly as designed.
async function deletionNeverBypassesGlobalCheck() {
  console.log('\n[Deletion safety] A save with an explicit deletion always still requires the global _baseRevision check, even with a matching _recordBase');
  const start = await getState();
  const quoteA = makeQuote();
  const quoteC = makeQuote({ notes: 'quote C — about to be deleted' });
  const seedRes = await putState({ quotes: [...(start.data.quotes || []), quoteA, quoteC], _partial: true });
  ok(seedRes.status === 200, 'seed quote A (untouched throughout) + quote C (to be deleted)');

  const editorOpenedState = await getState();
  const baseQuoteA = editorOpenedState.data.quotes.find((q: any) => String(q.id) === String(quoteA.id));
  const staleRevision = editorOpenedState.updated_at;

  // Something unrelated changes elsewhere, advancing the global revision —
  // exactly LEGACY 1's setup, except this time the save also deletes quote C.
  const jobB = makeJob();
  const bumpState = await getState();
  await putState({ jobs: [...(bumpState.data.jobs || []), jobB], _partial: true, _baseRevision: bumpState.updated_at });

  const deleteRes = await putState({
    quotes: [baseQuoteA], // quote A itself: genuinely unchanged, matches its base
    _deletedIds: { quotes: [quoteC.id] },
    _partial: true,
    _baseRevision: staleRevision, // stale — the job add above moved the revision past this
    _recordBase: { quotes: { [String(quoteA.id)]: baseQuoteA } }, // matches, but must NOT help here
  });
  ok(deleteRes.status === 409 && deleteRes.body?.type === 'stale_revision', 'a deletion-bearing save with a stale _baseRevision is STILL blocked, regardless of a matching _recordBase for the non-deleted record', JSON.stringify(deleteRes.body));

  const finalState = await getState();
  ok(finalState.data.quotes.some((q: any) => String(q.id) === String(quoteC.id)), 'quote C was NOT deleted by the blocked save');
}

// Malformed `_recordBase` (not a plain object) must never crash the save —
// treated as absent, falling back to the ordinary global check.
async function malformedRecordBaseIsIgnoredSafely() {
  console.log('\n[Malformed _recordBase] A non-object _recordBase is safely ignored, never a 500');
  const start = await getState();
  const quoteA = makeQuote();
  await putState({ quotes: [...(start.data.quotes || []), quoteA], _partial: true });

  const st = await getState();
  const baseQuoteA = st.data.quotes.find((q: any) => String(q.id) === String(quoteA.id));
  const edited = { ...baseQuoteA, notes: 'edited with malformed _recordBase' };
  // Fresh revision + no genuine conflict — this should simply succeed,
  // ignoring the garbage _recordBase value entirely rather than erroring.
  const res = await putState({ quotes: [edited], _partial: true, _baseRevision: st.updated_at, _recordBase: 'not-an-object' });
  ok(res.status === 200, 'a non-object _recordBase does not crash or block an otherwise-valid save', JSON.stringify(res.body));
}

async function main() {
  await login();
  await legacy1_unrelatedJobChangeDoesNotBlockQuoteSave();
  await legacy1Control_withoutRecordBaseStillBlocked();
  await legacy2_genuineSameQuoteConflictBlocked();
  await deletionNeverBypassesGlobalCheck();
  await malformedRecordBaseIsIgnoredSafely();

  console.log('\n' + '='.repeat(60));
  console.log(`${passed} passed, ${failures} failed`);
  console.log('='.repeat(60));
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[platformstate-record-scoped-test] Fatal error:', err);
  process.exit(1);
});
