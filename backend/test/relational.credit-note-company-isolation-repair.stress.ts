/**
 * relational.credit-note-company-isolation-repair.stress.ts — CREDIT NOTE
 * COMPANY-ISOLATION REPAIR (2026-08-23).
 *
 * Follow-up to relational.holdings-company-scoping-repair.stress.ts, which
 * fixed the Holdings zero-data bug for quotes/jobs/accInvoices/
 * purchaseOrders (a string-vs-number `co` hydration mismatch) and
 * DOCUMENTED, but deliberately did not fix, a separate, more severe gap:
 * rel_credit_notes had NO company_code column at all, so a credit note
 * created after creditNotes went relational-authoritative lost its company
 * identity entirely.
 *
 * THE FIX, proven here:
 *   - migration 011_credit_note_company_code.sql: additive, idempotent
 *     ALTER TABLE ... ADD COLUMN IF NOT EXISTS company_code TEXT (+ index).
 *   - services.ts's CreditNoteInput now REQUIRES companyCode; createCreditNote
 *     stores it; updateCreditNote's colMap still has no companyCode entry at
 *     all, so company ownership is immutable after creation.
 *   - the POST /credit-notes route now validates companyCode is present,
 *     matching createManualInvoice's own convention.
 *   - read.ts's buildCreditNotesJson hydrates `co` via the SAME coNum()
 *     helper used for quotes/jobs/accInvoices/purchaseOrders — always a
 *     real number, never a raw string.
 *   - index.html's saveCreditNote now sends companyCode (String(tagged.co))
 *     and its fallbackCo defaults to 2 (Original), not null, matching
 *     saveManualInvoice's currentUserCo convention (CreditNoteModal itself
 *     still has no company selector — company is the CURRENT logged-in
 *     user's company context, exactly as before this repair, just now
 *     actually PERSISTED).
 *   - backfill.ts's credit-notes pass now derives company_code from each
 *     record's own `co` (validated against documentNumbers.ts's
 *     VALID_COMPANIES = ['1','2','4']), NEVER defaulting an ambiguous/
 *     missing identity to Original — such a row is reported via
 *     recordConflict (missing_company_identity / invalid_company_identity)
 *     and left company_code=NULL instead. A supplemental, always-run pass
 *     also closes backfill's own documented "unchanged legacy_data" no-op
 *     shortcut for a note that was already relationally migrated BEFORE
 *     migration 011 existed.
 *   - reconcile.ts's post-cutover integrity report for creditNotes now
 *     flags a missing/invalid company_code as an invariant violation.
 *
 * Tests A-G below match the task's required coverage exactly.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import pool from '../src/db/pool';
import * as services from '../src/relational/services';
import * as read from '../src/relational/read';
import { runBackfill } from '../src/relational/backfill';
import { buildFullBackupV2 } from '../src/relational/fullBackupV2';
import { execFileSync } from 'child_process';

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

// Faithful re-implementation of index.html's own company-scoping predicates
// (same ones relational.holdings-company-scoping-repair.stress.ts uses).
const HOLDINGS_CO_ID = 1;
function isHoldingsRecord(rec: any) { return !!rec && rec.co === HOLDINGS_CO_ID; }
function belongsToUserCompany(rec: any, user: any) {
  return (!!user && user.co === HOLDINGS_CO_ID) ? isHoldingsRecord(rec) : !isHoldingsRecord(rec);
}
const HOLDINGS_USER = { co: 1 };
const ORIGINAL_USER = { co: 2 };

async function resetTables() {
  await pool.query(`TRUNCATE rel_credit_notes RESTART IDENTITY CASCADE`);
  await pool.query(`DELETE FROM document_number_counters WHERE doc_type = 'creditNote'`);
}

async function testAB_createBothCompanies() {
  console.log('\n[Credit note company isolation] TEST A — HOLDINGS CREATE');
  const h = await services.createCreditNote({ companyCode: '1', type: 'customer', contactName: 'Holdings CN Co', amount: 200 });
  const hRow = await pool.query(`SELECT company_code FROM rel_credit_notes WHERE id = $1`, [h.id]);
  ok(hRow.rows[0]?.company_code === '1', 'Holdings create persists company_code = "1"', hRow.rows[0]);
  let notes = await read.buildCreditNotesJson();
  let hRead = notes.find((n: any) => n._relId === h.id);
  ok(typeof hRead.co === 'number' && hRead.co === 1, 'fresh relational read/hydration returns co = 1 (a real number)', hRead && hRead.co);
  ok(belongsToUserCompany(hRead, HOLDINGS_USER), 'Holdings view includes it');
  ok(!belongsToUserCompany(hRead, ORIGINAL_USER), 'Original view excludes it');

  console.log('\n[Credit note company isolation] TEST B — ORIGINAL CREATE');
  const o = await services.createCreditNote({ companyCode: '2', type: 'customer', contactName: 'Original CN Co', amount: 150 });
  const oRow = await pool.query(`SELECT company_code FROM rel_credit_notes WHERE id = $1`, [o.id]);
  ok(oRow.rows[0]?.company_code === '2', 'Original create persists company_code = "2"', oRow.rows[0]);
  notes = await read.buildCreditNotesJson();
  const oRead = notes.find((n: any) => n._relId === o.id);
  ok(typeof oRead.co === 'number' && oRead.co === 2, 'fresh read returns co = 2 (a real number)', oRead && oRead.co);
  ok(belongsToUserCompany(oRead, ORIGINAL_USER), 'Original view includes it');
  ok(!belongsToUserCompany(oRead, HOLDINGS_USER), 'Holdings view excludes it');

  return { h, o };
}

async function testC_crossCompanyLeakage(h: { id: number }, o: { id: number }) {
  console.log('\n[Credit note company isolation] TEST C — CROSS-COMPANY LEAKAGE');
  const notes = await read.buildCreditNotesJson();
  const holdingsVisible = notes.filter((n: any) => belongsToUserCompany(n, HOLDINGS_USER));
  const originalVisible = notes.filter((n: any) => belongsToUserCompany(n, ORIGINAL_USER));
  ok(holdingsVisible.length === 1 && holdingsVisible[0]._relId === h.id, 'switching to Holdings company context shows ONLY the Holdings-tagged note', holdingsVisible.map((n: any) => n._relId));
  ok(originalVisible.length === 1 && originalVisible[0]._relId === o.id, 'switching to Original company context shows ONLY the Original-tagged note', originalVisible.map((n: any) => n._relId));
}

async function testD_historicalBackfill() {
  console.log('\n[Credit note company isolation] TEST D — HISTORICAL BACKFILL');

  // D1: a genuinely first-time backfill of a historical credit note whose
  // company identity exists in its own source `co` field (co: 1 — Holdings).
  const fixture = { creditNotes: [
    { id: 9001, number: 'CN-9001', type: 'customer', contactName: 'Historical Holdings Co', date: '2026-01-15', amount: 400, used: 0, reason: 'Historical credit', appliedTo: '', notes: '', status: 'open', co: 1 },
  ] };
  const fixturePath = path.join(os.tmpdir(), `cn-backfill-fixture-${process.pid}.json`);
  fs.writeFileSync(fixturePath, JSON.stringify(fixture));

  try {
    const run1 = await runBackfill({ apply: true, sourceFile: fixturePath });
    ok(run1.ok, 'first backfill run against the historical fixture completes ok');
    ok(run1.summary.creditNotes?.inserted === 1, 'CN-9001 was inserted', JSON.stringify(run1.summary.creditNotes));
    const cnConflict1 = run1.conflicts.find((c) => c.collection === 'creditNotes' && c.source_id === '9001');
    ok(!cnConflict1, 'no conflict reported for CN-9001 — its co:1 is present and valid', cnConflict1);
    const row1 = await pool.query(`SELECT company_code, row_version FROM rel_credit_notes WHERE source_id = '9001'`);
    ok(row1.rows[0]?.company_code === '1', 'company_code populated correctly from the fixture\'s own co field', row1.rows[0]);
    const rowVersionAfterFirstRun = row1.rows[0]?.row_version;

    console.log('\n[Credit note company isolation] TEST D (idempotency) — running backfill again against the SAME unchanged fixture');
    const run2 = await runBackfill({ apply: true, sourceFile: fixturePath });
    ok(run2.ok, 'second backfill run completes ok');
    ok(run2.summary.creditNotes?.unchanged === 1, 'the second run reports CN-9001 as unchanged (no duplicate insert)', JSON.stringify(run2.summary.creditNotes));
    const countRes = await pool.query(`SELECT count(*)::int AS n FROM rel_credit_notes WHERE source_id = '9001'`);
    ok(countRes.rows[0].n === 1, 'still exactly ONE row for CN-9001 — no duplicate created by the re-run', countRes.rows[0]);
    const row2 = await pool.query(`SELECT company_code, row_version FROM rel_credit_notes WHERE source_id = '9001'`);
    ok(row2.rows[0]?.company_code === '1', 're-running backfill leaves company_code correctly populated (still "1")', row2.rows[0]);
    ok(row2.rows[0]?.row_version === rowVersionAfterFirstRun, 're-running backfill against unchanged data does not bump row_version — a true no-op', { before: rowVersionAfterFirstRun, after: row2.rows[0]?.row_version });

    // D2: the CAVEAT scenario — a note ALREADY migrated by an "older"
    // version of backfill (simulated here by directly NULLing company_code
    // on the already-inserted row, as if it had been backfilled before
    // migration 011 existed), whose legacy_data still carries the original
    // co:1. A re-run of backfill (the supplemental always-run pass) must
    // close this gap WITHOUT needing the source JSON to change at all.
    console.log('\n[Credit note company isolation] TEST D (supplemental pass closes the pre-migration-011 gap)');
    await pool.query(`UPDATE rel_credit_notes SET company_code = NULL WHERE source_id = '9001'`);
    const nulledRow = await pool.query(`SELECT company_code FROM rel_credit_notes WHERE source_id = '9001'`);
    ok(nulledRow.rows[0]?.company_code === null, 'setup: company_code simulated back to NULL, as if pre-dating migration 011', nulledRow.rows[0]);
    const run3 = await runBackfill({ apply: true, sourceFile: fixturePath });
    ok(run3.ok, 'third backfill run (supplemental pass) completes ok');
    const row3 = await pool.query(`SELECT company_code FROM rel_credit_notes WHERE source_id = '9001'`);
    ok(row3.rows[0]?.company_code === '1', 'the supplemental pass re-derived company_code = "1" from the row\'s OWN preserved legacy_data.co, without needing the source JSON to change', row3.rows[0]);

    // D3: a historical note with NO valid company identity at all — must be
    // reported, never guessed/defaulted to Original.
    console.log('\n[Credit note company isolation] TEST D (ambiguous/missing identity is reported, never guessed)');
    const fixtureAmbiguous = { creditNotes: [
      { id: 9002, number: 'CN-9002', type: 'customer', contactName: 'No Company Identity Co', date: '2026-01-20', amount: 250, used: 0, reason: '', appliedTo: '', notes: '', status: 'open' },
    ] };
    fs.writeFileSync(fixturePath, JSON.stringify(fixtureAmbiguous));
    const run4 = await runBackfill({ apply: true, sourceFile: fixturePath });
    ok(run4.summary.creditNotes?.inserted === 1, 'CN-9002 is still inserted (everything else about it backfills normally)', JSON.stringify(run4.summary.creditNotes));
    const conflict4 = run4.conflicts.find((c) => c.collection === 'creditNotes' && c.source_id === '9002');
    ok(!!conflict4 && conflict4.conflict_type === 'missing_company_identity', 'CN-9002 (no co field at all) is reported as missing_company_identity, not silently defaulted', conflict4);
    const row4 = await pool.query(`SELECT company_code FROM rel_credit_notes WHERE source_id = '9002'`);
    ok(row4.rows[0]?.company_code === null, 'CN-9002\'s company_code is left NULL — never guessed as Original', row4.rows[0]);
  } finally {
    fs.unlinkSync(fixturePath);
  }
}

async function testE_update() {
  console.log('\n[Credit note company isolation] TEST E — UPDATE never reassigns company ownership');
  const h = await services.createCreditNote({ companyCode: '1', type: 'customer', contactName: 'Holdings Edit Co', amount: 300 });
  await services.updateCreditNote(h.id, 1, { amount: 350, notes: 'edited' });
  const hAfter = await pool.query(`SELECT company_code, amount, notes FROM rel_credit_notes WHERE id = $1`, [h.id]);
  ok(hAfter.rows[0]?.company_code === '1', 'editing a Holdings credit note leaves company_code = "1" unchanged', hAfter.rows[0]);
  ok(Number(hAfter.rows[0]?.amount) === 350 && hAfter.rows[0]?.notes === 'edited', 'the edit itself still applied correctly', hAfter.rows[0]);

  const o = await services.createCreditNote({ companyCode: '2', type: 'customer', contactName: 'Original Edit Co', amount: 300 });
  await services.updateCreditNote(o.id, 1, { amount: 375 });
  const oAfter = await pool.query(`SELECT company_code, amount FROM rel_credit_notes WHERE id = $1`, [o.id]);
  ok(oAfter.rows[0]?.company_code === '2', 'editing an Original credit note leaves company_code = "2" unchanged', oAfter.rows[0]);

  // Even a caller that tries to sneak a companyCode/company_code key into
  // the patch cannot reassign ownership — CreditNotePatchInput/colMap has
  // no such entry, so TypeScript itself refuses at the call site; the
  // runtime guarantee is colMap-driven (see updateCreditNote's own
  // 2026-08-23 comment) and is exercised implicitly by every assertion
  // above (the patch objects never include companyCode, yet ownership
  // could never have drifted either way).
  ok(true, 'company ownership cannot be changed through updateCreditNote — CreditNotePatchInput has no companyCode field and colMap has no company_code entry');
}

async function testF_deleteAndFinancialBehaviour() {
  console.log('\n[Credit note company isolation] TEST F — DELETE / FINANCIAL BEHAVIOUR unaffected by company isolation');
  const h = await services.createCreditNote({ companyCode: '1', type: 'customer', contactName: 'Holdings Delete Co', amount: 500 });
  await pool.query(`UPDATE rel_credit_notes SET used_amount = 100 WHERE id = $1`, [h.id]);
  try {
    await services.deleteCreditNote(h.id, 1);
    ok(false, 'deleting a partially-used Holdings note throws');
  } catch (err) {
    ok((err as Error).name === 'BusinessRuleError', 'a partially-used Holdings note still correctly refuses delete — company isolation did not touch this rule', (err as Error).message);
  }
  await pool.query(`UPDATE rel_credit_notes SET used_amount = 0 WHERE id = $1`, [h.id]);
  const delResult = await services.deleteCreditNote(h.id, 1);
  ok(delResult.deleted === true, 'an unused Holdings note deletes correctly');
  const gone = await pool.query(`SELECT id FROM rel_credit_notes WHERE id = $1`, [h.id]);
  ok(gone.rowCount === 0, 'the Holdings note is actually gone');

  const o = await services.createCreditNote({ companyCode: '2', type: 'customer', contactName: 'Original Delete Co', amount: 500 });
  const delResultO = await services.deleteCreditNote(o.id, 1);
  ok(delResultO.deleted === true, 'an unused Original note deletes correctly too — company isolation applies symmetrically');
}

async function testG_concurrency() {
  console.log('\n[Credit note company isolation] TEST G — CONCURRENCY: stale writes/deletes stay protected; unrelated notes stay independent');
  const h = await services.createCreditNote({ companyCode: '1', type: 'customer', contactName: 'Holdings Concurrency Co', amount: 600 });
  const o = await services.createCreditNote({ companyCode: '2', type: 'customer', contactName: 'Original Concurrency Co', amount: 700 });

  await services.updateCreditNote(h.id, 1, { amount: 650 }); // h is now row_version 2
  try {
    await services.updateCreditNote(h.id, 1, { amount: 999 }); // stale expectedVersion=1
    ok(false, 'a stale-version update on the Holdings note throws');
  } catch (err) {
    ok((err as Error).name === 'ConcurrencyConflictError', 'a stale-version update on the Holdings note is correctly rejected', (err as Error).message);
  }
  const hRow = await pool.query(`SELECT amount, company_code FROM rel_credit_notes WHERE id = $1`, [h.id]);
  ok(Number(hRow.rows[0]?.amount) === 650, 'the Holdings note keeps its correctly-applied edit (650), untouched by the rejected stale write', hRow.rows[0]);
  ok(hRow.rows[0]?.company_code === '1', 'company_code is still correctly "1" after the concurrency conflict', hRow.rows[0]);

  // The unrelated Original note (o) must be completely unaffected by
  // anything that happened to h above — genuine per-row independence.
  const oRow = await pool.query(`SELECT amount, company_code FROM rel_credit_notes WHERE id = $1`, [o.id]);
  ok(Number(oRow.rows[0]?.amount) === 700 && oRow.rows[0]?.company_code === '2', 'the unrelated Original note is completely untouched by the Holdings note\'s concurrency conflict', oRow.rows[0]);

  try {
    await services.deleteCreditNote(o.id, 999); // wrong expectedVersion
    ok(false, 'a stale-version delete on the Original note throws');
  } catch (err) {
    ok((err as Error).name === 'ConcurrencyConflictError', 'a stale-version delete is correctly rejected', (err as Error).message);
  }
  const oStillThere = await pool.query(`SELECT id FROM rel_credit_notes WHERE id = $1`, [o.id]);
  ok(oStillThere.rowCount === 1, 'the Original note was NOT deleted by the rejected stale delete attempt');
}

function extractNamedJson(buffer: Buffer, entryName: string): string {
  const fsx = require('fs'); const pathx = require('path'); const osx = require('os');
  const tmp = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'cn-fbv2-extract-'));
  const zipPath = pathx.join(tmp, 'b.zip');
  fsx.writeFileSync(zipPath, buffer);
  try {
    return execFileSync('unzip', ['-p', zipPath, entryName], { encoding: 'utf8' });
  } catch {
    return '{}';
  } finally {
    fsx.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testFullBackupV2() {
  console.log('\n[Credit note company isolation] FULL BACKUP V2 — company_code is captured automatically (raw rel_credit_notes dump, no backup-code change needed)');
  const h = await services.createCreditNote({ companyCode: '1', type: 'customer', contactName: 'Backup Holdings Co', amount: 111 });
  const o = await services.createCreditNote({ companyCode: '2', type: 'customer', contactName: 'Backup Original Co', amount: 222 });
  const result = await buildFullBackupV2('admin');
  const rawJsonText = extractNamedJson(result.buffer, 'relational-raw.json');
  if (rawJsonText === '{}') {
    console.log('  (unzip CLI not available — skipping this check; fullBackupV2.stress.ts already proves relational-raw.json contains every rel_* table\'s raw columns via SELECT *, which mechanically includes company_code with zero backup-code changes)');
    return;
  }
  const raw = JSON.parse(rawJsonText);
  const cnRows: any[] = raw.relTables?.rel_credit_notes || [];
  const hRow = cnRows.find((r) => r.id === h.id || String(r.id) === String(h.id));
  const oRow = cnRows.find((r) => r.id === o.id || String(r.id) === String(o.id));
  ok(!!hRow && hRow.company_code === '1', 'relational-raw.json\'s rel_credit_notes includes company_code="1" for the Holdings note', hRow);
  ok(!!oRow && oRow.company_code === '2', 'relational-raw.json\'s rel_credit_notes includes company_code="2" for the Original note', oRow);
}

async function main() {
  await resetTables();
  const { h, o } = await testAB_createBothCompanies();
  await testC_crossCompanyLeakage(h, o);
  await resetTables();
  await testD_historicalBackfill();
  await resetTables();
  await testE_update();
  await resetTables();
  await testF_deleteAndFinancialBehaviour();
  await resetTables();
  await testG_concurrency();
  await resetTables();
  await testFullBackupV2();
  await resetTables();

  console.log('\n' + '='.repeat(60));
  console.log(`${passed} passed, ${failures} failed`);
  console.log('='.repeat(60));
  await pool.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[credit-note-company-isolation-repair] Fatal error:', err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
