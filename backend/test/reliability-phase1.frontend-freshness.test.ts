/**
 * reliability-phase1.frontend-freshness.test.ts
 * ─────────────────────────────────────────────
 * RELIABILITY PHASE 1 (2026-08-26) — frontend logic, pinned to the SHIPPED
 * source. These tests do not re-implement anything: they EXTRACT the real
 * functions out of index.html by name (brace-matched) and evaluate them, so
 * what is tested is the code that ships.
 *
 * They cover the release-blocking requirement — an automatic refresh must
 * never overwrite unsaved input or move an open editor's expected row_version
 * — plus the payments->owner mapping, the purchaseOrders exclusion, and the
 * focus/visibility/online coalescing.
 *
 * No database, no network. Usage (from backend/):
 *   npx ts-node --transpile-only test/reliability-phase1.frontend-freshness.test.ts
 */
import fs from 'fs';
import vm from 'vm';
import path from 'path';

const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH || path.resolve(__dirname, '..', '..', 'index.html');
const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

/** Extract a top-level declaration by its exact opening text, brace-matched. */
function extract(startText: string): string {
  const i = html.indexOf(startText);
  if (i === -1) throw new Error('could not find: ' + startText);
  let depth = 0, started = false;
  for (let j = i; j < html.length; j++) {
    const ch = html[j];
    if (ch === '{') { depth++; started = true; }
    else if (ch === '}') { depth--; if (started && depth === 0) return html.slice(i, j + 1); }
  }
  throw new Error('unbalanced braces after: ' + startText);
}
function extractLine(startText: string): string {
  const i = html.indexOf(startText);
  if (i === -1) throw new Error('could not find: ' + startText);
  const end = html.indexOf('\n', i);
  return html.slice(i, end);
}

const src = [
  extractLine("const pinnedRecordsRef = { current: new Map() };"),
  extractLine("const pinnedStaleRef = { current: new Set() };"),
  extract('function _pinKey('),
  extract('function pinRecord('),
  extract('function unpinRecord('),
  extract('function isRecordPinned('),
  extract('function pinnedRecordIsStale('),
  extract('function _notePinnedStale('),
  extract('function _pinnedIdsForSection('),
  extractLine("const FRESHNESS_REFRESHABLE_SECTIONS = "),
  extract('function expandFreshnessSections('),
  extract('function mergeRefreshedSection('),
  extract('function scheduleFreshnessCheck('),
].join('\n\n');

const sandbox: any = {
  console,
  setTimeout, clearTimeout,
  // App-scope dependencies of the extracted functions, stubbed with the same
  // shapes the real component provides.
  currentSnapshotRef: { current: null },
  freshnessTimerRef: { current: null },
  freshnessBusyRef: { current: false },
  freshnessAgainRef: { current: false },
  freshnessCheckNow: null, // set per test
  JSON,
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

let pass = 0, fail = 0; const failures: string[] = [];
function check(name: string, cond: any, detail?: string) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name); console.log('  FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('=== PIN REGISTRY ===');
  sandbox.pinRecord('jobs', 7);
  check('a pinned record reports as pinned', sandbox.isRecordPinned('jobs', 7));
  check('an unrelated record is not pinned', !sandbox.isRecordPinned('jobs', 8));
  check('the same id in another section is not pinned', !sandbox.isRecordPinned('quotes', 7));
  sandbox.pinRecord('jobs', 7); // two editors on the same record
  sandbox.unpinRecord('jobs', 7);
  check('refcounted: one editor closing does not release a pin another still holds', sandbox.isRecordPinned('jobs', 7));
  sandbox.unpinRecord('jobs', 7);
  check('the pin is released when the last holder closes', !sandbox.isRecordPinned('jobs', 7));
  check('numeric and string ids are the same pin', (() => {
    sandbox.pinRecord('jobs', 9); const r = sandbox.isRecordPinned('jobs', '9'); sandbox.unpinRecord('jobs', 9); return r;
  })());

  console.log('\n=== C / K — DIRTY EDITOR IS NOT OVERWRITTEN, AND ITS OBJECT IS NOT REPLACED ===');
  const localDirty = { id: 5, num: 'SNS-00005', notes: 'B is typing this', _relId: 55, _relRowVersion: 3 };
  const localOther = { id: 6, num: 'SNS-00006', notes: 'untouched', _relId: 66, _relRowVersion: 1 };
  sandbox.currentSnapshotRef.current = { jobs: [localDirty, localOther] };

  // The server has moved on: record 5 was edited by user A (v4), and record 6 too.
  const serverJobs = [
    { id: 5, num: 'SNS-00005', notes: 'A committed this', _relId: 55, _relRowVersion: 4 },
    { id: 6, num: 'SNS-00006', notes: 'refreshed by A', _relId: 66, _relRowVersion: 2 },
  ];

  // (1) with NO pin, the refresh replaces everything — today's behaviour
  let merged = sandbox.mergeRefreshedSection('jobs', serverJobs);
  check('with no pin held, a refresh applies the server copy as-is',
    merged[0].notes === 'A committed this' && merged[0]._relRowVersion === 4);

  // (2) with a pin held, the dirty record is preserved EXACTLY
  sandbox.pinRecord('jobs', 5);
  merged = sandbox.mergeRefreshedSection('jobs', serverJobs);
  check('C. the pinned record keeps its local content', merged[0].notes === 'B is typing this');
  check('C. the pinned record keeps the row_version editing STARTED from',
    merged[0]._relRowVersion === 3, 'got ' + merged[0]._relRowVersion);
  check('K. the pinned record is the SAME OBJECT, not a copy — nothing can mutate it through the list',
    merged[0] === localDirty);
  check('the UNPINNED record still refreshes normally',
    merged[1].notes === 'refreshed by A' && merged[1]._relRowVersion === 2);
  check('the user is told a newer server copy exists', sandbox.pinnedRecordIsStale('jobs', 5));
  check('...but only for the record that actually differs', !sandbox.pinnedRecordIsStale('jobs', 6));

  // (3) a pinned record deleted server-side is retained rather than yanked away
  merged = sandbox.mergeRefreshedSection('jobs', [serverJobs[1]]);
  check('a pinned record deleted elsewhere is kept on screen instead of vanishing mid-edit',
    merged.some((r: any) => r.id === 5) && merged.find((r: any) => r.id === 5) === localDirty);

  // (4) an identical server copy must NOT raise the "changed elsewhere" flag
  sandbox.unpinRecord('jobs', 5);
  sandbox.pinRecord('jobs', 6);
  sandbox.mergeRefreshedSection('jobs', [serverJobs[0], localOther]);
  check('an identical server copy does not falsely report "changed elsewhere"',
    !sandbox.pinnedRecordIsStale('jobs', 6));
  sandbox.unpinRecord('jobs', 6);

  check('with no pins at all the merge returns the server array untouched (zero cost)',
    sandbox.mergeRefreshedSection('jobs', serverJobs) === serverJobs);

  console.log('\n=== PAYMENTS -> OWNER MAPPING, AND PO EXCLUSION ===');
  check('a payments change refreshes its three owner sections',
    JSON.stringify(sandbox.expandFreshnessSections(['payments']).sort()) === JSON.stringify(['accInvoices', 'jobs', 'quotes']));
  check('purchaseOrders is never refreshed by freshness in Phase 1',
    sandbox.expandFreshnessSections(['purchaseOrders']).length === 0);
  check('a normal section maps to itself',
    JSON.stringify(sandbox.expandFreshnessSections(['quotes'])) === JSON.stringify(['quotes']));
  check('payments + quotes does not refresh quotes twice',
    sandbox.expandFreshnessSections(['payments', 'quotes']).filter((s: string) => s === 'quotes').length === 1);
  check('an unknown section is ignored rather than requested',
    sandbox.expandFreshnessSections(['somethingElse']).length === 0);

  console.log('\n=== E / F / G — FOCUS, VISIBILITY AND RECONNECT ARE COALESCED ===');
  let calls: string[] = [];
  sandbox.freshnessCheckNow = async (reason: string) => { calls.push(reason); await sleep(30); };

  // A burst: focus, then visibilitychange, then online — as a real tab produces.
  sandbox.scheduleFreshnessCheck('focus', false);
  sandbox.scheduleFreshnessCheck('visible', false);
  sandbox.scheduleFreshnessCheck('online', false);
  await sleep(400);
  check('E/F/G. focus + visibilitychange + online in one burst produce exactly ONE check',
    calls.length === 1, 'calls: ' + JSON.stringify(calls));

  // A trigger arriving WHILE a check is running is not dropped.
  calls = [];
  sandbox.freshnessCheckNow = async (reason: string) => { calls.push(reason); await sleep(150); };
  sandbox.scheduleFreshnessCheck('poll', false);
  await sleep(250);                       // now in flight
  sandbox.scheduleFreshnessCheck('focus', false);
  await sleep(600);
  check('a trigger arriving during an in-flight check is followed up, not lost',
    calls.length === 2, 'calls: ' + JSON.stringify(calls));

  // A post-mutation check is not delayed by the debounce. The elapsed time is
  // captured INSIDE the callback — measuring after a sleep would only prove how
  // long the test slept.
  calls = [];
  let mutationDelay: number | null = null;
  const t0 = Date.now();
  sandbox.freshnessCheckNow = async (reason: string) => { mutationDelay = Date.now() - t0; calls.push(reason); };
  sandbox.scheduleFreshnessCheck('mutation', true);
  await sleep(80);
  check('a post-save check runs immediately (no 200ms debounce delay)',
    calls.length === 1 && mutationDelay !== null && mutationDelay < 50, 'ran after ' + mutationDelay + 'ms');

  // ...whereas a background trigger IS debounced, so a burst can coalesce.
  calls = [];
  let pollDelay: number | null = null;
  const t1 = Date.now();
  sandbox.freshnessCheckNow = async (reason: string) => { pollDelay = Date.now() - t1; calls.push(reason); };
  sandbox.scheduleFreshnessCheck('poll', false);
  await sleep(400);
  check('a background check IS debounced (so a focus/visibility burst can coalesce)',
    calls.length === 1 && pollDelay >= 150, 'ran after ' + pollDelay + 'ms');

  console.log('\n============================================');
  console.log(' PASSED: ' + pass + '   FAILED: ' + fail);
  if (failures.length) for (const f of failures) console.log('   - ' + f);
  console.log('============================================');
  process.exit(fail === 0 ? 0 : 1);
}
main();
