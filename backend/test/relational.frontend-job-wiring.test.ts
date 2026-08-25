/**
 * relational.frontend-job-wiring.test.ts — STAGE 3 Phase 1 verification
 * (frontend job editing wiring).
 *
 * Two parts:
 *   1. Source-text checks that JobDetail's saveCosts/saveNotes/saveLines/
 *      advanceStage in index.html now route through relationalApi.
 *      updateJob() when 'jobs' is relational-authoritative, using
 *      job._relId/job._relRowVersion (not job.id — see the sibling
 *      relational.frontend-id-bugfix.test.ts for why that distinction is
 *      safety-critical), and fall through to the original JSON behavior
 *      unchanged otherwise.
 *   2. A REAL end-to-end proof, over real HTTP against a live server, that
 *      exercises the EXACT scenario the id-bugfix targets: a job
 *      BACKFILLED from historical JSON (so job.id, the restored legacy
 *      id, is a completely different number from job._relId, the real
 *      relational PK) can still be edited correctly — proving the wiring
 *      doesn't just look right in the source, it actually works for real
 *      production-shaped (backfilled) data, not only for a job created
 *      fresh after cutover (where legacy id and PK coincide and would
 *      mask this exact bug).
 *
 * Requires TEST_SERVER_URL_WITH_AUTHORITY for part 2 — skips that part
 * with a clear notice if unset, same convention as every other Stage 2/3
 * REST suite.
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

function checkSourceWiring(src: string) {
  console.log('\n[Frontend job wiring] source-text checks — saveCosts/saveNotes/saveLines/advanceStage');
  ok(/async function saveCosts\(\)\{[\s\S]{0,200}isRelationalAuthoritative\('jobs'\)/.test(src),
    'saveCosts checks isRelationalAuthoritative(\'jobs\') before deciding how to persist');
  ok(src.includes(`relationalApi.updateJob(job._relId, job._relRowVersion, { breakdown: bd })`),
    'saveCosts calls relationalApi.updateJob with job._relId/job._relRowVersion and a breakdown patch');

  ok(/async function saveNotes\(\)\{[\s\S]{0,300}isRelationalAuthoritative\('jobs'\)/.test(src),
    'saveNotes checks isRelationalAuthoritative(\'jobs\') before deciding how to persist');
  ok(src.includes(`relationalApi.updateJob(job._relId, job._relRowVersion, { notes: nextNotes })`),
    'saveNotes calls relationalApi.updateJob with job._relId/job._relRowVersion and a notes patch');

  ok(/async function saveLines\(\)\{[\s\S]{0,300}isRelationalAuthoritative\('jobs'\)/.test(src),
    'saveLines checks isRelationalAuthoritative(\'jobs\') before deciding how to persist');
  ok(src.includes(`relationalApi.updateJob(job._relId, job._relRowVersion, { lines: patchLines })`),
    'saveLines calls relationalApi.updateJob with job._relId/job._relRowVersion and a lines patch');
  // 2026-08-25: this assertion pinned the PRE-migration-013 patch shape as one
  // exact string, and went red the moment the Quote Reliability Repair added
  // the five 013 fields to saveLines — which it had to, because
  // replaceJobLinesTx recomputes every subtotal as pieces x qty x unitPrice, so
  // a wholesale line replacement that omitted `pieces` would reprice every
  // multi-piece line to 1/pQty (013's own header says exactly that). It is
  // restored to its real intent — every field services.ts's LineItemPatch
  // expects is present and correctly named — instead of a frozen snapshot of
  // one historical line of source that no longer exists.
  ok(/const patchLines = cleanLines\.map\(l=>\(\{ desc: l\.desc, qty: l\.qty, unitPrice: l\.unitPrice, unit: l\.unit, itemId: l\.itemId,/.test(src),
    'saveLines maps to the EXACT LineItemPatch shape services.ts expects (desc/qty/unitPrice/unit/itemId) — no renamed/missing fields');
  ok(/pieces: l\.pQty===''\|\|l\.pQty===undefined\?null:l\.pQty/.test(src) &&
     /sqmL: l\.sqmL===''\|\|l\.sqmL===undefined\?null:l\.sqmL/.test(src) &&
     /sqmW: l\.sqmW===''\|\|l\.sqmW===undefined\?null:l\.sqmW/.test(src) &&
     /cpId: l\.cpId\?\?null/.test(src) && /cpLinked: l\.cpLinked\?\?null/.test(src),
    'and carries all five migration-013 fields too (pieces from pQty, sqmL/sqmW, cpId/cpLinked) — omitting pieces would silently reprice every multi-piece line');

  ok(/async function advanceStage\(\)\{[\s\S]{0,300}isRelationalAuthoritative\('jobs'\)/.test(src),
    'advanceStage checks isRelationalAuthoritative(\'jobs\') before deciding how to persist');
  ok(src.includes(`relationalApi.updateJob(job._relId, job._relRowVersion, { stage: ns, status: nextStatus })`),
    'advanceStage calls relationalApi.updateJob with job._relId/job._relRowVersion and a stage+status patch');
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
    console.log('\n[Frontend job wiring] end-to-end proof SKIPPED — TEST_SERVER_URL_WITH_AUTHORITY not set. See test runner instructions.');
    return;
  }

  await resetRelationalTables();
  await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section = 'jobs'`);

  // A job BACKFILLED from historical JSON with a legacy id (555001) that is
  // guaranteed NOT to equal whatever relational PK backfill.ts assigns
  // (PKs start at 1 on this freshly-truncated table) — exactly the
  // "job.id !== job._relId" scenario the bugfix targets.
  const tmpPath = path.resolve('/tmp/frontend-job-wiring-fixture.json');
  fs.writeFileSync(tmpPath, JSON.stringify({
    jobs: [{ id: 555001, num: 'SNS-WIRETEST', co: '2', client: 'Frontend Wiring Test Co', desc: 'Original desc', status: 'in_production', stage: 6, value: 1000, notes: 'original note', lines: [{ desc: 'Original line', qty: 1, unitPrice: 1000, subtotal: 1000 }] }],
  }));
  await runBackfill({ apply: true, sourceFile: tmpPath });

  const jobRow = await pool.query(`SELECT id, row_version FROM rel_jobs WHERE source_id = '555001'`);
  const relId = jobRow.rows[0].id;
  const relRowVersion = jobRow.rows[0].row_version;
  console.log(`\n[Frontend job wiring] backfilled job: legacy id=555001, real relational PK=${relId} (deliberately different — this is the scenario that was silently broken before the id bugfix)`);
  ok(String(relId) !== '555001', 'sanity check: the relational PK genuinely differs from the legacy id for this backfilled job', { relId });

  const token = await login(base);
  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  console.log('\n[Frontend job wiring] end-to-end: exactly what saveNotes() now sends — PUT /jobs/:relId with a notes patch');
  const putRes = await fetch(`${base}/api/relational/jobs/${relId}`, {
    method: 'PUT', headers: authHeaders,
    body: JSON.stringify({ expectedVersion: relRowVersion, notes: 'Edited via the wired frontend save path' }),
  });
  const putBody = await putRes.json();
  ok(putRes.status === 200, 'the edit succeeds against the REAL relational PK', JSON.stringify(putBody));
  const afterRow = await pool.query(`SELECT notes, row_version FROM rel_jobs WHERE id = $1`, [relId]);
  ok(afterRow.rows[0].notes === 'Edited via the wired frontend save path', 'the correct job (identified by _relId) was actually updated', afterRow.rows[0]);
  ok(afterRow.rows[0].row_version === relRowVersion + 1, 'row_version bumped by exactly 1');

  console.log('\n[Frontend job wiring] proving the OLD bug would have failed: PUT /jobs/:legacyId (job.id, not job._relId) does NOT hit this job');
  const badRes = await fetch(`${base}/api/relational/jobs/555001`, {
    method: 'PUT', headers: authHeaders,
    body: JSON.stringify({ expectedVersion: relRowVersion + 1, notes: 'This should never land' }),
  });
  ok(badRes.status !== 200, 'a PUT using the legacy id (555001) as if it were the relational PK does NOT succeed — confirms the fix is load-bearing, not cosmetic', String(badRes.status));
  const stillOk = await pool.query(`SELECT notes FROM rel_jobs WHERE id = $1`, [relId]);
  ok(stillOk.rows[0].notes === 'Edited via the wired frontend save path', 'the real job record is untouched by the bad (legacy-id) request');

  await resetRelationalTables();
  await pool.query(`UPDATE platform_state SET data = '{}'::jsonb, updated_at = NOW() WHERE id = 1`);
  fs.unlinkSync(tmpPath);
}

async function main() {
  const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  checkSourceWiring(src);
  await runEndToEndProof();

  console.log('\n' + '='.repeat(60));
  console.log(`${passed} passed, ${failures} failed`);
  console.log('='.repeat(60));
  await pool.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[frontend-job-wiring-test] Fatal error:', err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
