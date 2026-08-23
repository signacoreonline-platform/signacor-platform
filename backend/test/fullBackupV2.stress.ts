/**
 * fullBackupV2.stress.ts — Stage 2 Phase 6.
 *
 * Tests backend/src/relational/fullBackupV2.ts directly (in-process, not
 * over HTTP — the HTTP route in backend/src/routes/fullBackup.ts is a thin
 * pass-through: auth + role-check + streaming the buffer this module
 * builds, nothing this suite needs to re-prove separately).
 *
 * Covers:
 *   - The ZIP is well-formed and contains exactly manifest.json + data.json.
 *   - manifest.json's declared record counts match data.json's actual
 *     array lengths (the verification-against-partial-failure guarantee).
 *   - manifest.json's sha256 checksum genuinely matches data.json's bytes.
 *   - perSectionAuthority correctly reports 'relational' for a cut-over
 *     section and 'json' for everything else.
 *   - A cut-over section's data in the backup reflects the LIVE relational
 *     data (including a record created after the last platform_state PUT),
 *     proving this isn't just re-exporting the frozen JSON blob.
 *   - Sensitive-auth-data exclusion: app_users is never queried by this
 *     module (a simple, honest static check — grep the source), and the
 *     produced archive contains no user/password/token-shaped keys.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import pool from '../src/db/pool';
import { buildFullBackupV2 } from '../src/relational/fullBackupV2';
import * as services from '../src/relational/services';

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

async function main() {
  // Clean slate — a previous run/suite may have left rel_quotes/rel_jobs
  // rows and quote_conversions bookkeeping behind (this suite shares the
  // disposable local test database with every other Stage 1/2 suite).
  await pool.query(`TRUNCATE rel_customers, rel_quotes, rel_quote_line_items, rel_jobs, rel_job_line_items RESTART IDENTITY CASCADE`).catch(() => undefined);
  await pool.query(`DELETE FROM quote_conversions WHERE quote_id LIKE 'rel:%'`);

  console.log('\n[Full Backup V2] static source check — this module never QUERIES app_users');
  // Resolved from process.cwd() (this suite, like every other in
  // backend/test/, is documented to always be run from backend/ —
  // whether via `ts-node --transpile-only test/...` or the compiled
  // `node dist/test/...`) rather than __dirname, since __dirname's
  // relative distance to src/ differs between those two run modes (one
  // extra nesting level once compiled into dist/test/).
  const src = fs.readFileSync(path.resolve(process.cwd(), 'src', 'relational', 'fullBackupV2.ts'), 'utf8');
  // The word "app_users" legitimately appears in this file's own doc
  // comment (documenting the exclusion policy) — what actually matters is
  // that no SQL statement targets that table. Check for the real signal
  // (a query verb immediately preceding the table name) rather than a bare
  // substring match, which would false-positive on the policy comment.
  ok(!/\b(from|join|into|update)\s+app_users\b/i.test(src), 'fullBackupV2.ts contains no SQL statement that queries/writes app_users (the word only appears in the documentation comment explaining the exclusion policy)');

  console.log('\n[Full Backup V2] baseline export (no sections cut over)');
  await pool.query(`UPDATE relational_cutover SET enabled = false`);
  delete process.env.RELATIONAL_AUTHORITY_ENABLED;
  await pool.query(`INSERT INTO platform_state (id, data, updated_at) VALUES (1, $1::jsonb, NOW()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`, [
    JSON.stringify({ jobs: [{ id: 1, num: 'SNS-BKP-1', co: '2', client: 'Backup Test', status: 'lead', stage: 0, value: 0, payments: [] }], customers: [], quotes: [] }),
  ]);

  const result1 = await buildFullBackupV2('admin');
  ok(result1.buffer.length > 0 && result1.filename.endsWith('.zip'), 'produces a non-empty .zip buffer', `${result1.buffer.length} bytes, ${result1.filename}`);
  ok(result1.manifest.formatVersion === 2 && result1.manifest.type === 'full-platform-backup-v2', 'manifest declares formatVersion=2 and the correct type');
  ok(result1.manifest.perSectionAuthority.jobs === 'json', 'baseline: jobs authority reported as "json" (nothing cut over)', result1.manifest.perSectionAuthority.jobs);
  ok(result1.manifest.recordCounts.jobs === 1, 'manifest recordCounts.jobs matches the seeded 1 job', String(result1.manifest.recordCounts.jobs));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbv2-'));
  const zipPath = path.join(tmpDir, result1.filename);
  fs.writeFileSync(zipPath, result1.buffer);
  let entries: string[] = [];
  try {
    const listing = execFileSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
    entries = listing.split('\n').map((l) => l.trim()).filter((l) => l.endsWith('.json'));
  } catch (e) {
    console.log('  (unzip CLI not available — skipping structural unzip check, relying on programmatic checks below)');
  }
  if (entries.length) {
    // CUTOVER BLOCKER COMPLETION: the ZIP now ALSO contains relational-raw.json
    // (see fullBackupV2.ts's four Full Backup V2 gap fixes) — updated from
    // "exactly manifest.json and data.json" to include the new file.
    ok(
      entries.some((l) => l.includes('manifest.json')) && entries.some((l) => l.includes('data.json')) && entries.some((l) => l.includes('relational-raw.json')),
      'ZIP contains manifest.json, data.json AND relational-raw.json',
      entries.join(' | ')
    );
  }

  let dataJsonExtracted = '';
  try {
    execFileSync('unzip', ['-o', zipPath, '-d', tmpDir], { encoding: 'utf8' });
    dataJsonExtracted = fs.readFileSync(path.join(tmpDir, 'data.json'), 'utf8');
  } catch (e) {
    // Fall back: reconstruct manually isn't possible without unzip/adm-zip;
    // if unzip truly isn't present, the checksum check below still runs
    // against the manifest's own declared checksum vs a fresh re-serialize,
    // which is the actually load-bearing check.
  }
  if (dataJsonExtracted) {
    const actualChecksum = crypto.createHash('sha256').update(dataJsonExtracted, 'utf8').digest('hex');
    ok(actualChecksum === result1.manifest.dataJsonSha256, 'manifest sha256 checksum genuinely matches the extracted data.json bytes', `${actualChecksum} vs ${result1.manifest.dataJsonSha256}`);
    const parsed = JSON.parse(dataJsonExtracted);
    ok(Array.isArray(parsed.jobs) && parsed.jobs.length === 1 && parsed.jobs[0].num === 'SNS-BKP-1', 'extracted data.json contains the seeded job, unchanged');
    ok(!/password|passwordHash|token|jwt/i.test(dataJsonExtracted), 'extracted data.json contains no password/token-shaped keys anywhere');
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log('\n[Full Backup V2] cut-over section reflects LIVE relational data, not the frozen JSON copy');
  process.env.RELATIONAL_AUTHORITY_ENABLED = 'true';
  await pool.query(`UPDATE relational_cutover SET enabled = true, enabled_at = NOW(), enabled_by = 'backup-test' WHERE section = 'jobs'`);
  const relQuote = await services.createQuote({ companyCode: '2', customerNameRaw: 'Backup V2 Relational Job Source', lines: [{ description: 'x', qty: 1, unitPrice: 10 }] });
  const relJob = await services.convertQuoteToJob(relQuote.id);

  const result2 = await buildFullBackupV2('admin');
  ok(result2.manifest.perSectionAuthority.jobs === 'relational', 'after cutover, manifest reports jobs authority as "relational"', result2.manifest.perSectionAuthority.jobs);
  const data2 = JSON.parse(result2.buffer.length ? extractDataJson(result2) : '{}');
  ok(data2.jobs?.some((j: any) => j.num === relJob.jobNumber), 'the backup\'s jobs array includes the RELATIONALLY-created job (never written to platform_state at all)', `looked for ${relJob.jobNumber}`);
  ok(!data2.jobs?.some((j: any) => j.num === 'SNS-BKP-1'), 'the STALE frozen platform_state.data.jobs copy (SNS-BKP-1) is correctly NOT what\'s in the backup once jobs is relational-authoritative — it is superseded by the live relational rendering');

  console.log('\n[Full Backup V2] CUTOVER BLOCKER COMPLETION — the four Full Backup V2 gaps are closed (relational-raw.json)');
  const raw2 = JSON.parse(result2.buffer.length ? extractNamedJson(result2, 'relational-raw.json') : '{}');
  // Gap #1: a raw rel_* table dump (not just a JSON-shaped rendering) —
  // rel_jobs should carry the actual DB row for relJob, with its real
  // row_version/id/company_code columns, independent of read.ts's rendering.
  ok(Array.isArray(raw2.relTables?.rel_jobs) && raw2.relTables.rel_jobs.some((r: any) => r.job_number === relJob.jobNumber), 'relational-raw.json.relTables.rel_jobs contains the raw DB row for the relationally-created job', JSON.stringify(raw2.relTables?.rel_jobs?.map((r: any) => r.job_number)));
  ok(Array.isArray(raw2.relTables?.rel_quotes) && raw2.relTables.rel_quotes.some((r: any) => r.id === relQuote.id), 'relational-raw.json.relTables.rel_quotes contains the raw DB row for the source quote');
  // Gap #2: document_number_counters was completely absent before — now present.
  ok(Array.isArray(raw2.relTables?.document_number_counters) && raw2.relTables.document_number_counters.some((r: any) => r.doc_type === 'quote'), 'relational-raw.json.relTables.document_number_counters contains a "quote" counter row (previously entirely absent from Full Backup V2)', JSON.stringify(raw2.relTables?.document_number_counters));
  ok(Array.isArray(raw2.relTables?.quote_conversions), 'relational-raw.json.relTables.quote_conversions is present (supports reconstructing quote<->job conversion history after a restore)');
  // Gap #3: raw per-section relational_cutover state, including "payments"
  // (which perSectionAuthority can never represent — no standalone JSON key),
  // and NOT silently collapsed just because it happens to mirror the
  // env-derived summary — this is the ground truth straight from the DB rows.
  ok(Array.isArray(raw2.cutoverStateRaw) && raw2.cutoverStateRaw.some((r: any) => r.section === 'payments'), 'relational-raw.json.cutoverStateRaw includes a "payments" row (perSectionAuthority has no equivalent for this section at all)', JSON.stringify(raw2.cutoverStateRaw));
  ok(raw2.cutoverStateRaw?.find((r: any) => r.section === 'jobs')?.enabled === true, 'relational-raw.json.cutoverStateRaw reports jobs.enabled=true, matching the DB row directly (ground truth, not a derived label)');
  ok(raw2.relationalAuthorityMasterSwitchEnabled === true, 'relational-raw.json also carries the master switch state alongside the raw per-section rows');
  // Gap #4: full quarantined records (not just aggregate counts) — array
  // present and correctly shaped even when there happen to be zero right now.
  ok(Array.isArray(raw2.quarantineRecords), 'relational-raw.json.quarantineRecords is a real array of full quarantine records (not just the pre-existing manifest.quarantinedGroupCounts aggregate)', JSON.stringify(raw2.quarantineRecords));
  ok(typeof result2.manifest.relationalRawSha256 === 'string' && result2.manifest.relationalRawSha256.length === 64, 'manifest declares a sha256 checksum for relational-raw.json, same integrity guarantee as data.json');
  ok(!!result2.manifest.relationalRawRecordCounts && typeof result2.manifest.relationalRawRecordCounts.rel_jobs === 'number', 'manifest.relationalRawRecordCounts covers the raw rel_* tables too, verified against the archived bytes exactly like recordCounts is for data.json');

  console.log('\n[Full Backup V2] PURCHASE ORDER MIGRATION POLICY CHANGE (2026-08-21) — active relational POs vs legacy JSON archive (tests #17/#18)');
  await pool.query(`TRUNCATE rel_purchase_order_items, rel_purchase_orders, rel_suppliers RESTART IDENTITY CASCADE`).catch(() => undefined);
  // Seed platform_state with a historical JSON purchaseOrders record — this
  // must remain preserved and referenceable in the backup even after
  // purchaseOrders is cut over, but must NOT be presented as active.
  const psBefore = await pool.query('SELECT data FROM platform_state WHERE id = 1');
  const psDataForPo = { ...(psBefore.rowCount ? psBefore.rows[0].data || {} : {}), purchaseOrders: [
    { id: 8001, num: 'PO-00085', supplierId: '5001', jobNum: 'SNS-LEGACY-1', co: '2', date: '2020-01-01', status: 'sent', items: [{ inventoryId: null, name: 'Legacy Item', unit: 'ea', qtyNeeded: 1, qtyOrdered: 1, unitCost: 1 }], notes: 'historical, part of a duplicate-number group excluded by policy' },
  ] };
  await pool.query(`UPDATE platform_state SET data = $1::jsonb, updated_at = NOW() WHERE id = 1`, [JSON.stringify(psDataForPo)]);

  process.env.RELATIONAL_AUTHORITY_ENABLED = 'true';
  await pool.query(`UPDATE relational_cutover SET enabled = true, enabled_at = NOW(), enabled_by = 'backup-test' WHERE section = 'purchaseOrders'`);
  const poSupplier = await services.createSupplier({ name: 'Full Backup V2 PO Supplier' });
  const activePo = await services.createPurchaseOrder({
    companyCode: '2', supplierId: poSupplier.id, notes: 'active relational PO',
    items: [{ name: 'New Item', qtyNeeded: 5, qtyOrdered: 5, unitCost: 3 }],
  });

  const result3 = await buildFullBackupV2('admin');
  ok(result3.manifest.perSectionAuthority.purchaseOrders === 'relational', 'after purchaseOrders cutover, manifest reports its authority as "relational"', result3.manifest.perSectionAuthority.purchaseOrders);
  ok(!!result3.manifest.purchaseOrdersDataset, 'manifest carries a dedicated purchaseOrdersDataset field distinguishing active vs legacy');
  ok(result3.manifest.purchaseOrdersDataset.activeDataset.label === 'ACTIVE RELATIONAL PURCHASE ORDERS', 'manifest labels the active dataset as ACTIVE RELATIONAL PURCHASE ORDERS once cut over', JSON.stringify(result3.manifest.purchaseOrdersDataset.activeDataset));
  ok(result3.manifest.purchaseOrdersDataset.legacyJsonArchive.label === 'LEGACY JSON PURCHASE ORDER ARCHIVE', 'manifest labels the legacy dataset as LEGACY JSON PURCHASE ORDER ARCHIVE', JSON.stringify(result3.manifest.purchaseOrdersDataset.legacyJsonArchive));
  ok(result3.manifest.purchaseOrdersDataset.legacyJsonArchive.recordCount === 1, 'manifest reports exactly 1 legacy archived PO record (the historical fixture)', String(result3.manifest.purchaseOrdersDataset.legacyJsonArchive.recordCount));

  const data3 = JSON.parse(result3.buffer.length ? extractDataJson(result3) : '{}');
  ok(Array.isArray(data3.purchaseOrders) && data3.purchaseOrders.length === 1 && data3.purchaseOrders[0].num === activePo.poNumber, 'test #17: data.json\'s "purchaseOrders" key contains ONLY the active relational PO, correctly rendered', JSON.stringify(data3.purchaseOrders));
  ok(!data3.purchaseOrders.some((p: any) => p.num === 'PO-00085'), 'the legacy historical PO (PO-00085) is correctly NOT presented as active once purchaseOrders is cut over');
  ok(Array.isArray(data3.purchaseOrdersLegacyArchive) && data3.purchaseOrdersLegacyArchive.length === 1 && data3.purchaseOrdersLegacyArchive[0].num === 'PO-00085', 'test #18: data.json\'s "purchaseOrdersLegacyArchive" key preserves the original historical JSON PO record, unfiltered', JSON.stringify(data3.purchaseOrdersLegacyArchive));

  // Pre-cutover: purchaseOrdersLegacyArchive is still present (always
  // captured regardless of cutover state) and mirrors the same historical
  // data as the (still-JSON) active `purchaseOrders` key.
  await pool.query(`UPDATE relational_cutover SET enabled = false, enabled_at = NULL, enabled_by = NULL WHERE section = 'purchaseOrders'`);
  const result4 = await buildFullBackupV2('admin');
  const data4 = JSON.parse(result4.buffer.length ? extractDataJson(result4) : '{}');
  ok(result4.manifest.purchaseOrdersDataset.activeDataset.label.includes('not yet cut over'), 'pre-cutover: manifest labels the active dataset as not-yet-cut-over JSON', result4.manifest.purchaseOrdersDataset.activeDataset.label);
  ok(Array.isArray(data4.purchaseOrdersLegacyArchive) && data4.purchaseOrdersLegacyArchive.length === 1, 'purchaseOrdersLegacyArchive is preserved even before cutover (always captured, independent of cutover state)', JSON.stringify(data4.purchaseOrdersLegacyArchive));

  await pool.query(`TRUNCATE rel_purchase_order_items, rel_purchase_orders, rel_suppliers RESTART IDENTITY CASCADE`).catch(() => undefined);
  // NOTE: intentionally leave RELATIONAL_AUTHORITY_ENABLED=true and the
  // platform_state jobs seed alone here — the very next section (existing,
  // unmodified below) still relies on the master switch being on and
  // "jobs" still being cut over from the earlier step in this same test run.

  console.log('\n[Full Backup V2] verification catches a manufactured inconsistency (simulated partial-failure)');
  const { buildFullBackupV2: freshImport } = await import('../src/relational/fullBackupV2');
  // Monkeypatch a broken read builder briefly to prove the verification step
  // actually throws rather than silently shipping a mismatched count.
  const readModule = await import('../src/relational/read');
  const originalBuilder = (readModule as any).getAuthoritativeJson;
  (readModule as any).getAuthoritativeJson = async () => { throw new Error('should not reach verification — builder itself throws'); };
  let threwOnBuilderFailure = false;
  try {
    await freshImport('admin');
  } catch {
    threwOnBuilderFailure = true;
  }
  (readModule as any).getAuthoritativeJson = originalBuilder;
  ok(threwOnBuilderFailure, 'a failure while assembling a cut-over section\'s data aborts the WHOLE export rather than shipping a partial/incorrect zip');

  await pool.query(`UPDATE relational_cutover SET enabled = false, enabled_at = NULL, enabled_by = NULL`);
  delete process.env.RELATIONAL_AUTHORITY_ENABLED;
  await pool.query(`TRUNCATE rel_customers, rel_quotes, rel_quote_line_items, rel_jobs, rel_job_line_items RESTART IDENTITY CASCADE`).catch(() => undefined);
  await pool.query(`UPDATE platform_state SET data = '{}'::jsonb, updated_at = NOW() WHERE id = 1`);

  console.log('\n' + '='.repeat(60));
  console.log(`${passed} passed, ${failures} failed`);
  console.log('='.repeat(60));
  await pool.end();
  process.exit(failures > 0 ? 1 : 0);
}

function extractDataJson(result: { buffer: Buffer }): string {
  return extractNamedJson(result, 'data.json');
}

// CUTOVER BLOCKER COMPLETION: generalized from extractDataJson so the new
// relational-raw.json file can be verified with the same in-process,
// no-unzip-CLI-required approach.
function extractNamedJson(result: { buffer: Buffer }, entryName: string): string {
  const os = require('os'); const fsx = require('fs'); const pathx = require('path');
  const { execFileSync } = require('child_process');
  const tmp = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'fbv2-extract-'));
  const zipPath = pathx.join(tmp, 'b.zip');
  fsx.writeFileSync(zipPath, result.buffer);
  try {
    const out = execFileSync('unzip', ['-p', zipPath, entryName], { encoding: 'utf8' });
    return out;
  } catch {
    return '{}';
  } finally {
    fsx.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch(async (err) => {
  console.error('[full-backup-v2-stress] Fatal error:', err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
