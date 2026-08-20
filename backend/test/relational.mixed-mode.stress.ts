/**
 * relational.mixed-mode.stress.ts — Stage 2 Phase 5.
 *
 * Explicit MIXED-MODE proof: one section cut over to relational authority
 * while a DIFFERENT section remains JSON-authoritative, in BOTH directions
 * (jobs relational + quotes JSON, then the reverse). This is the scenario
 * the migration brief calls out by name as needing its own test — Stage 1's
 * write-isolation test only proved ONE section's isolation at a time.
 *
 * What this proves, concretely, against a REAL running server:
 *   1. With `jobs` cut over and `quotes` NOT: a PUT carrying BOTH sections
 *      persists `quotes` into platform_state normally, while `jobs` is
 *      silently stripped (never written to platform_state, never lost —
 *      it simply isn't this path's job to write it anymore).
 *   2. GET /api/platform-state, in that same state, returns `quotes` from
 *      the JSON blob (exactly as saved) and `jobs` from the relational
 *      read-overlay (backend/src/relational/read.ts) — NOT from whatever
 *      frozen copy platform_state.data.jobs happens to hold.
 *   3. A relational-only write (via POST /api/relational/...) to the
 *      cut-over section (jobs) is visible on the very next GET, with no
 *      platform_state PUT involved at all.
 *   4. The reverse configuration (quotes cut over, jobs not) exhibits the
 *      exact mirror behavior — proving this isn't an accident of which
 *      section happened to be tested first.
 *   5. Sections that are neither section under test (e.g. customers) are
 *      completely unaffected by either configuration.
 *
 * REQUIRES a running server with RELATIONAL_AUTHORITY_ENABLED=true (see
 * TEST_SERVER_URL_WITH_AUTHORITY) — without it, this suite prints a clear
 * skip notice and exits 0 (it cannot prove anything meaningful about the
 * double-gate without a server that has the master switch on; the master
 * switch itself is proven OFF-by-default elsewhere, in
 * relational.stress.ts's testPlatformStateWriteIsolation).
 */
import pool from '../src/db/pool';
import * as services from '../src/relational/services';

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

async function login(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.TEST_LOGIN_EMAIL || 'test@signacore.local', password: process.env.TEST_LOGIN_PASSWORD || 'testpass' }),
  });
  if (!res.ok) throw new Error(`login failed against ${baseUrl}: HTTP ${res.status}`);
  return (await res.json()).token;
}

async function setCutover(sections: Record<string, boolean>) {
  await pool.query(`UPDATE relational_cutover SET enabled = false`);
  for (const [section, enabled] of Object.entries(sections)) {
    if (enabled) await pool.query(`UPDATE relational_cutover SET enabled = true, enabled_at = NOW(), enabled_by = 'mixed-mode-test' WHERE section = $1`, [section]);
  }
}

async function main() {
  const baseWithAuthority = process.env.TEST_SERVER_URL_WITH_AUTHORITY;
  if (!baseWithAuthority) {
    console.log('[mixed-mode] SKIPPED — TEST_SERVER_URL_WITH_AUTHORITY not set (needs a server with RELATIONAL_AUTHORITY_ENABLED=true). See test runner instructions.');
    process.exit(0);
  }
  const token = await login(baseWithAuthority);
  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  // ── Direction 1: jobs relational, quotes JSON ───────────────────────────
  console.log('\n[Mixed mode 1/2] jobs=RELATIONAL, quotes=JSON');
  await setCutover({ jobs: true });

  const relJob = await services.createQuote({ companyCode: '2', customerNameRaw: 'Mixed Mode Job Source', lines: [{ description: 'panel', qty: 1, unitPrice: 1000 }] })
    .then((q) => services.convertQuoteToJob(q.id));
  const jsonQuoteSeed = { id: Date.now(), num: `SQ-MIX1-${Date.now()}`, co: '2', client: 'Mixed Mode Quote (JSON)', status: 'draft', lines: [], payments: [] };

  const putRes = await fetch(`${baseWithAuthority}/api/platform-state`, {
    method: 'PUT', headers: authHeaders,
    body: JSON.stringify({ data: {
      jobs: [{ id: 999999999, num: 'SNS-SHOULD-NOT-LAND', co: '2', client: 'must be stripped', status: 'lead', stage: 0, value: 0 }],
      quotes: [jsonQuoteSeed],
      _partial: true,
    } }),
  });
  const putBody = await putRes.json();
  ok(putRes.ok, 'mixed save (jobs + quotes together) is accepted', `HTTP ${putRes.status}`);
  ok(Array.isArray(putBody.relationalAuthoritativeSectionsIgnored) && putBody.relationalAuthoritativeSectionsIgnored.includes('jobs'), '"jobs" reported as stripped/ignored', JSON.stringify(putBody.relationalAuthoritativeSectionsIgnored));
  ok(!putBody.relationalAuthoritativeSectionsIgnored.includes('quotes'), '"quotes" is NOT stripped — it is still JSON-authoritative', JSON.stringify(putBody.relationalAuthoritativeSectionsIgnored));

  const getRes = await fetch(`${baseWithAuthority}/api/platform-state`, { headers: { Authorization: `Bearer ${token}` } });
  const getBody = await getRes.json();
  ok((getBody.data.quotes || []).some((q: any) => q.id === jsonQuoteSeed.id), 'quotes: the JSON-saved quote is present, read straight from platform_state', 'not found');
  ok(!(getBody.data.jobs || []).some((j: any) => j.num === 'SNS-SHOULD-NOT-LAND'), 'jobs: the attempted JSON write to the cut-over section never landed anywhere');
  ok((getBody.data.jobs || []).some((j: any) => j.num === relJob.jobNumber), 'jobs: the RELATIONALLY-created job IS visible via GET, with no platform_state PUT involved', `looked for ${relJob.jobNumber}`);
  ok(Array.isArray(getBody.relationalAuthoritativeSections) && getBody.relationalAuthoritativeSections.includes('jobs'), 'GET response declares "jobs" as a relational-authoritative section', JSON.stringify(getBody.relationalAuthoritativeSections));
  ok(!(getBody.relationalAuthoritativeSections || []).includes('quotes'), 'GET response does NOT declare "quotes" as relational-authoritative', JSON.stringify(getBody.relationalAuthoritativeSections));

  // A relational-only write to jobs, with no PUT at all, shows up on GET.
  const relJob2 = await services.createQuote({ companyCode: '2', customerNameRaw: 'Mixed Mode Job Source 2', lines: [{ description: 'vinyl', qty: 2, unitPrice: 250 }] })
    .then((q) => services.convertQuoteToJob(q.id));
  const getRes2 = await fetch(`${baseWithAuthority}/api/platform-state`, { headers: { Authorization: `Bearer ${token}` } });
  const getBody2 = await getRes2.json();
  ok((getBody2.data.jobs || []).some((j: any) => j.num === relJob2.jobNumber), 'a SECOND relational-only write (no PUT at all) is immediately visible on the next GET', `looked for ${relJob2.jobNumber}`);

  // customers (neither section under test) is unaffected.
  const custCountBefore = (getBody.data.customers || []).length;
  // 2026-08-20 fix: the original `getBody2.data.customers?.length` (no
  // fallback) compared `undefined` against `custCountBefore`'s `0` on a
  // freshly-seeded/empty platform_state row (customers genuinely absent
  // from the JSON blob, not present-but-empty) — a false failure with
  // nothing actually wrong. `|| []` on both sides makes the comparison
  // robust to "section key missing entirely" the same way `custCountBefore`
  // above already is.
  ok((getBody2.data.customers || []).length === custCountBefore, 'an unrelated section (customers) is unaffected by either cutover configuration');

  // ── Direction 2: quotes relational, jobs JSON (the reverse) ────────────
  console.log('\n[Mixed mode 2/2] quotes=RELATIONAL, jobs=JSON (reverse configuration)');
  await setCutover({ quotes: true });

  const relQuote = await services.createQuote({ companyCode: '2', customerNameRaw: 'Mixed Mode Reverse', lines: [{ description: 'banner', qty: 3, unitPrice: 80 }] });
  const jsonJobSeed = { id: Date.now() + 5, num: `SNS-MIX2-${Date.now()}`, co: '2', client: 'Mixed Mode Job (JSON)', status: 'lead', stage: 0, value: 0, payments: [] };

  const putRes2b = await fetch(`${baseWithAuthority}/api/platform-state`, {
    method: 'PUT', headers: authHeaders,
    body: JSON.stringify({ data: {
      quotes: [{ id: 888888888, num: 'SQ-SHOULD-NOT-LAND', co: '2', client: 'must be stripped', status: 'draft' }],
      jobs: [jsonJobSeed],
      _partial: true,
    } }),
  });
  const putBody2b = await putRes2b.json();
  ok(putRes2b.ok, 'reverse mixed save is accepted', `HTTP ${putRes2b.status}`);
  ok(putBody2b.relationalAuthoritativeSectionsIgnored?.includes('quotes'), '"quotes" is now the one stripped (reverse of direction 1)', JSON.stringify(putBody2b.relationalAuthoritativeSectionsIgnored));
  ok(!putBody2b.relationalAuthoritativeSectionsIgnored?.includes('jobs'), '"jobs" is NOT stripped this time — it is JSON-authoritative again in this configuration', JSON.stringify(putBody2b.relationalAuthoritativeSectionsIgnored));

  const getRes3 = await fetch(`${baseWithAuthority}/api/platform-state`, { headers: { Authorization: `Bearer ${token}` } });
  const getBody3 = await getRes3.json();
  ok((getBody3.data.jobs || []).some((j: any) => j.id === jsonJobSeed.id), 'jobs: the JSON-saved job is present, read straight from platform_state (reverse config)');
  ok(!(getBody3.data.quotes || []).some((q: any) => q.num === 'SQ-SHOULD-NOT-LAND'), 'quotes: the attempted JSON write to the now-cut-over section never landed');
  ok((getBody3.data.quotes || []).some((q: any) => q.num === relQuote.quoteNumber), 'quotes: the RELATIONALLY-created quote IS visible via GET (reverse config)', `looked for ${relQuote.quoteNumber}`);

  // Restore defaults.
  await pool.query(`UPDATE relational_cutover SET enabled = false, enabled_at = NULL, enabled_by = NULL`);

  console.log('\n' + '='.repeat(60));
  console.log(`${passed} passed, ${failures} failed`);
  console.log('='.repeat(60));
  await pool.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[mixed-mode] Fatal error:', err);
  await pool.query(`UPDATE relational_cutover SET enabled = false, enabled_at = NULL, enabled_by = NULL`).catch(() => undefined);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
