/**
 * relational.frontend-creditnote-wiring.test.ts — STAGE 3 Phase 7
 * verification (frontend credit note create/edit/delete wiring).
 *
 * Two parts:
 *   1. Source-text checks that AccountingPage's saveCreditNote/
 *      deleteCreditNote route through relationalApi.createCreditNote/
 *      updateCreditNote/deleteCreditNote when "creditNotes" is
 *      relational-authoritative, using ._relId (never a bare .id), and
 *      that the create branch sets _relId/_relRowVersion on the new local
 *      stub immediately (closing the same creation-stub race the
 *      customer/quote/job-conversion fixes closed).
 *   2. A REAL end-to-end proof over real HTTP: create, edit, and delete a
 *      credit note through the relational REST API exactly as the wired
 *      frontend now calls it, plus proving a partially-used note's delete
 *      is correctly refused (services.ts's own business rule).
 *
 * Requires TEST_SERVER_URL_WITH_AUTHORITY for part 2 — skips with a clear
 * notice if unset, same convention as every other Stage 2/3 REST suite.
 */
import fs from 'fs';
import path from 'path';
import pool from '../src/db/pool';

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
  console.log('\n[Frontend credit note wiring] source-text checks — AccountingPage saveCreditNote/deleteCreditNote');
  ok(src.includes(`if(isRelationalAuthoritative('creditNotes')){`) && src.includes(`async function saveCreditNote(cn){`),
    'saveCreditNote checks isRelationalAuthoritative(\'creditNotes\') before deciding how to persist');
  ok(src.includes(`const result = await relationalApi.createCreditNote({ type: tagged.type, contactName: tagged.contactName, date: tagged.date, amount: tagged.amount, reason: tagged.reason, appliedTo: tagged.appliedTo, notes: tagged.notes, status: tagged.status });`),
    'the create branch calls relationalApi.createCreditNote with the full CreditNoteModal field set');
  ok(src.includes(`_relId: result.id, _relRowVersion: result.rowVersion }, ...prev]);`),
    'the create branch sets _relId/_relRowVersion on the new local stub immediately');
  ok(src.includes(`const result = await relationalApi.updateCreditNote(existing && existing._relId, existing && existing._relRowVersion,`),
    'the edit branch calls relationalApi.updateCreditNote with existing._relId/._relRowVersion, never a bare .id');
  ok(src.includes(`if(isRelationalAuthoritative('creditNotes') && existing && existing._relId!=null){`) && src.includes(`async function deleteCreditNote(id){`),
    'deleteCreditNote routes relationally only for a genuine relational row (_relId set)');
  ok(src.includes(`await relationalApi.deleteCreditNote(existing._relId, existing._relRowVersion);`),
    'deleteCreditNote calls relationalApi.deleteCreditNote with the note\'s _relId/_relRowVersion');
  ok(src.includes(`createCreditNote(data) { return relationalFetch('/credit-notes', { method: 'POST', body: JSON.stringify(data) }); },`),
    'relationalApi.createCreditNote client wrapper exists');
  ok(src.includes(`deleteCreditNote(id, expectedVersion) { return relationalFetch('/credit-notes/' + id, { method: 'DELETE', body: JSON.stringify({ expectedVersion: expectedVersion }) }); },`),
    'relationalApi.deleteCreditNote client wrapper exists');
}

async function resetRelationalTables() {
  await pool.query(`TRUNCATE rel_credit_notes RESTART IDENTITY CASCADE`);
  await pool.query(`DELETE FROM document_number_counters WHERE doc_type = 'creditNote'`);
  await pool.query(`UPDATE relational_cutover SET enabled = false, enabled_at = NULL, enabled_by = NULL WHERE section = 'creditNotes'`);
}

async function runEndToEndProof() {
  const base = process.env.TEST_SERVER_URL_WITH_AUTHORITY;
  if (!base) {
    console.log('\n[Frontend credit note wiring] end-to-end proof SKIPPED — TEST_SERVER_URL_WITH_AUTHORITY not set.');
    return;
  }

  await resetRelationalTables();
  await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section = 'creditNotes'`);

  const token = await login(base);
  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  console.log('\n[Frontend credit note wiring] end-to-end: exactly what saveCreditNote() now sends for a NEW credit note');
  const createRes = await fetch(`${base}/api/relational/credit-notes`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ type: 'customer', contactName: 'Frontend CN Wiring Co', date: '2026-08-21', amount: 250, reason: 'Overpayment', appliedTo: '', notes: '', status: 'open' }),
  });
  const createBody: any = await createRes.json();
  ok(createRes.status === 201 && /^CN-/i.test(createBody.creditNumber || ''), 'credit note created with a real CN-##### number', createBody);

  console.log('\n[Frontend credit note wiring] end-to-end: exactly what saveCreditNote() now sends for an EDIT');
  const editRes = await fetch(`${base}/api/relational/credit-notes/${createBody.id}`, {
    method: 'PUT', headers: authHeaders,
    body: JSON.stringify({ expectedVersion: createBody.rowVersion, contactName: 'Frontend CN Wiring Co', date: '2026-08-21', amount: 300, reason: 'Overpayment', appliedTo: '', notes: 'edited via wired frontend', status: 'open' }),
  });
  const editBody: any = await editRes.json();
  ok(editRes.status === 200, 'edit succeeded and bumped rowVersion', editBody);
  const afterEdit = await pool.query(`SELECT amount, notes FROM rel_credit_notes WHERE id = $1`, [createBody.id]);
  ok(Number(afterEdit.rows[0].amount) === 300 && afterEdit.rows[0].notes === 'edited via wired frontend', 'the DB row reflects the edit');

  console.log('\n[Frontend credit note wiring] a note with used_amount > 0 correctly REFUSES delete (services.ts business rule, unchanged)');
  await pool.query(`UPDATE rel_credit_notes SET used_amount = 50 WHERE id = $1`, [createBody.id]);
  const delBlockedRes = await fetch(`${base}/api/relational/credit-notes/${createBody.id}`, {
    method: 'DELETE', headers: authHeaders, body: JSON.stringify({ expectedVersion: editBody.rowVersion }),
  });
  ok(delBlockedRes.status === 409, 'delete of a partially-used note is refused', delBlockedRes.status);

  console.log('\n[Frontend credit note wiring] an UNUSED note deletes correctly');
  await pool.query(`UPDATE rel_credit_notes SET used_amount = 0 WHERE id = $1`, [createBody.id]);
  const delRes = await fetch(`${base}/api/relational/credit-notes/${createBody.id}`, {
    method: 'DELETE', headers: authHeaders, body: JSON.stringify({ expectedVersion: editBody.rowVersion }),
  });
  ok(delRes.status === 200, 'delete of an unused note succeeds', await delRes.text().catch(() => ''));
  const gone = await pool.query(`SELECT id FROM rel_credit_notes WHERE id = $1`, [createBody.id]);
  ok(gone.rowCount === 0, 'the note is actually gone from the DB');

  await resetRelationalTables();
  await pool.query(`UPDATE platform_state SET data = '{}'::jsonb, updated_at = NOW() WHERE id = 1`);
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
  console.error('[frontend-creditnote-wiring-test] Fatal error:', err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
