/**
 * fullbackup-frontend-fix.test.ts — Stage 2 PRODUCTION HOTFIX verification.
 *
 * Root cause of the reported bug: index.html's "Export Full Backup" button
 * (Header's onExportBackup prop) always called exportFullBackup(), a
 * function that built a JSON backup entirely client-side from React's own
 * top-level state and triggered a Blob download — a leftover from BEFORE
 * Full Backup V2 (backend/src/relational/fullBackupV2.ts,
 * GET /api/full-backup) existed. Stage 2 built and tested the new backend
 * endpoint end-to-end (see fullBackupV2.stress.ts) but never actually
 * rewired this frontend function to call it — so the button kept
 * downloading the old JSON no matter what the backend could now produce.
 *
 * There is no browser click-through harness in this environment, so — same
 * technique as proforma-frontend-logic.test.ts and
 * relational-frontend-guard.test.ts — this test extracts the ACTUAL
 * `exportFullBackup` source out of index.html by brace-matching and runs it
 * in a real Node `vm` sandbox with a mocked `fetch`/DOM, so a future edit
 * that reintroduces client-side JSON construction (or silently swallows a
 * server failure) fails this test the same way any other extracted-logic
 * regression would.
 *
 * What this proves:
 *   1. The extracted source no longer contains ANY of the old client-side
 *      JSON-backup construction (the `backupMeta`/`manual-full-platform-export`
 *      signature, or a `.json` Blob/download) — the whole old code path is
 *      gone, not just dead/unreachable.
 *   2. Clicking triggers exactly one fetch to API_FULL_BACKUP_URL, with the
 *      caller's auth header attached.
 *   3. On a successful ZIP response, a real download is triggered, using
 *      the filename from the response's Content-Disposition header.
 *   4. On a failed response (500 with a JSON error body), NO download is
 *      triggered at all — the function surfaces the error and does not
 *      fall back to any local backup.
 *   5. A 401 forces the same session-expiry handling every other API call
 *      in this file already uses (forceLogoutExpiredSession).
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH || path.resolve(__dirname, '..', '..', 'index.html');

let failures = 0;
let passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

function extractFunction(src: string, name: string): string {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) throw new Error(`Could not find function ${name} in index.html — has it been renamed/removed?`);
  const start = m.index;
  const parenStart = src.indexOf('(', m.index);
  if (parenStart === -1) throw new Error(`Could not find parameter list for function ${name}`);
  let pdepth = 0;
  let j = parenStart;
  for (; j < src.length; j++) {
    if (src[j] === '(') pdepth++;
    else if (src[j] === ')') { pdepth--; if (pdepth === 0) { j++; break; } }
  }
  const braceStart = src.indexOf('{', j);
  if (braceStart === -1) throw new Error(`Could not find opening brace for function ${name}`);
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

function extractConst(src: string, name: string): string {
  const re = new RegExp(`const\\s+${name}\\s*=.*?;`, 's');
  const m = re.exec(src);
  if (!m) throw new Error(`Could not find const ${name} in index.html — has it been renamed/removed?`);
  return m[0];
}

async function main() {
  if (!fs.existsSync(INDEX_HTML_PATH)) {
    console.error(`[fullbackup-frontend-fix] index.html not found at ${INDEX_HTML_PATH} — set INDEX_HTML_PATH.`);
    process.exit(1);
  }
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const startMarker = '<script type="text/babel" data-presets="react-classic">';
  const startIdx = html.indexOf(startMarker);
  const endIdx = html.lastIndexOf('</script>');
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    throw new Error('Could not locate the main <script type="text/babel"> block in index.html');
  }
  const appSrc = html.slice(startIdx + startMarker.length, endIdx);

  const exportFullBackupSrc = extractFunction(appSrc, 'exportFullBackup');
  const apiUrlConst = extractConst(appSrc, 'API_FULL_BACKUP_URL');

  console.log('\n[1] Static shape check — the old client-side JSON construction is GONE, not just unreachable');
  ok(!/backupMeta/.test(exportFullBackupSrc), 'no reference to the old backupMeta object anywhere in the function');
  ok(!/manual-full-platform-export/.test(exportFullBackupSrc), 'no reference to the old export-type string');
  ok(!/application\/json;charset=utf-8/.test(exportFullBackupSrc), 'no client-built JSON Blob is constructed');
  ok(/API_FULL_BACKUP_URL/.test(exportFullBackupSrc), 'the function references the real backend endpoint constant');
  ok(/fetch\(/.test(exportFullBackupSrc), 'the function actually calls fetch(...)');
  ok(/\/full-backup/.test(apiUrlConst), 'API_FULL_BACKUP_URL points at /full-backup', apiUrlConst);

  // ── Dynamic behavior — real vm execution with a mocked fetch/DOM ────────
  function freshSandbox(user: any, apiReady: boolean) {
    const created: any[] = [];
    const alerts: string[] = [];
    let forceLogoutCalled = false;
    const sandbox: any = {
      console,
      user,
      apiReadyRef: { current: apiReady },
      fullBackupInFlightRef: { current: false },
      authHeaders: () => ({ Authorization: 'Bearer test-token' }),
      forceLogoutExpiredSession: () => { forceLogoutCalled = true; },
      alert: (msg: string) => { alerts.push(msg); },
      URL: { createObjectURL: () => 'blob:mock-url', revokeObjectURL: () => {} },
      window: { SIGNACORE_API_URL: 'http://localhost:3001/api' },
      document: {
        createElement: () => {
          const el: any = { clicked: false, click() { el.clicked = true; } };
          created.push(el);
          return el;
        },
        body: { appendChild: () => {}, removeChild: () => {} },
      },
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    return { sandbox, created, alerts, wasForceLogoutCalled: () => forceLogoutCalled };
  }

  function run(sandbox: any, fetchImpl: any) {
    sandbox.fetch = fetchImpl;
    const runnable = `${apiUrlConst}\n${exportFullBackupSrc}\nglobalThis.__run = exportFullBackup;`;
    vm.runInContext(runnable, sandbox, { filename: 'index.html-extracted-fullbackup.js' });
    return sandbox.__run();
  }

  console.log('\n[2] Success path — a real ZIP response triggers exactly one download, named from Content-Disposition');
  {
    const { sandbox, created, alerts } = freshSandbox({ role: 'admin' }, true);
    let fetchCallCount = 0;
    let calledUrl = '';
    let calledHeaders: any = null;
    const fakeResponse = {
      status: 200,
      ok: true,
      headers: { get: (h: string) => (h === 'Content-Disposition' ? 'attachment; filename="signacore-full-backup-2026-08-20.zip"' : null) },
      blob: async () => ({ __fakeBlob: true }),
      json: async () => ({}),
    };
    await run(sandbox, async (url: string, opts: any) => {
      fetchCallCount++; calledUrl = url; calledHeaders = opts && opts.headers;
      return fakeResponse;
    });
    ok(fetchCallCount === 1, 'fetch was called exactly once');
    ok(/\/full-backup$/.test(calledUrl), 'fetch was called against the full-backup endpoint', calledUrl);
    ok(!!(calledHeaders && calledHeaders.Authorization), 'the auth header was attached to the request', calledHeaders);
    ok(created.length === 1 && created[0].clicked === true, 'exactly one download element was created and clicked');
    ok(created[0].download === 'signacore-full-backup-2026-08-20.zip', 'the download filename came from Content-Disposition, not a client-generated name', created[0].download);
    ok(alerts.length === 0, 'no error alert was shown on success');
  }

  console.log('\n[3] Failure path — a server error shows a clear alert and downloads NOTHING (no JSON fallback)');
  {
    const { sandbox, created, alerts } = freshSandbox({ role: 'admin' }, true);
    const fakeResponse = {
      status: 500,
      ok: false,
      headers: { get: () => null },
      json: async () => ({ error: 'Full backup export failed', detail: 'simulated relational read failure' }),
    };
    await run(sandbox, async () => fakeResponse);
    ok(created.length === 0, 'NO download element was created on a server failure');
    ok(alerts.length === 1 && /simulated relational read failure/.test(alerts[0]), 'the specific server error detail is shown to the user', alerts);
    ok(!/backupMeta/.test(JSON.stringify(alerts)), 'the failure message never mentions/contains any client-built JSON backup content');
  }

  console.log('\n[4] 401 — session-expiry handling, same convention as every other API call');
  {
    const { sandbox, created, wasForceLogoutCalled } = freshSandbox({ role: 'admin' }, true);
    const fakeResponse = { status: 401, ok: false, headers: { get: () => null }, json: async () => ({}) };
    await run(sandbox, async () => fakeResponse);
    ok(wasForceLogoutCalled(), 'forceLogoutExpiredSession() was called on a 401');
    ok(created.length === 0, 'no download was attempted after a 401');
  }

  console.log('\n[5] Non-admin / not-yet-ready guards are unchanged (still block before any network call)');
  {
    const { sandbox: sbNonAdmin, alerts: alertsNonAdmin } = freshSandbox({ role: 'assistant' }, true);
    let called = false;
    await run(sbNonAdmin, async () => { called = true; return { status: 200, ok: true, headers: { get: () => null }, blob: async () => ({}) }; });
    ok(!called, 'a non-admin user never triggers a network call');
    ok(alertsNonAdmin.length === 1, 'a non-admin user sees a clear block message');

    const { sandbox: sbNotReady, alerts: alertsNotReady } = freshSandbox({ role: 'admin' }, false);
    let called2 = false;
    await run(sbNotReady, async () => { called2 = true; return { status: 200, ok: true, headers: { get: () => null }, blob: async () => ({}) }; });
    ok(!called2, 'apiReadyRef.current=false never triggers a network call');
    ok(alertsNotReady.length === 1, 'the not-yet-loaded guard still shows its own message');
  }

  console.log('\n============================================================');
  console.log(`${passed} passed, ${failures} failed`);
  console.log('============================================================');
  if (failures > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
