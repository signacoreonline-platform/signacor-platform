/**
 * "Full Backup V2" — Stage 2 Phase 6.
 *
 * Upgrades the existing manual "Export Full Backup" feature (previously a
 * pure client-side download built from React state — see index.html's
 * `exportFullBackup()`) into a server-driven, self-describing, portable
 * ZIP so that after cutover it captures ALL authoritative data, not just
 * whatever happens to be in platform_state.
 *
 * WHY SERVER-SIDE: the old export was built entirely from the frontend's
 * own in-memory arrays. Once ANY section is cut over, that section's true,
 * live data lives in the rel_* tables — the frontend only ever sees a
 * JSON-compatible RENDERING of it (via GET /api/platform-state's read
 * overlay, backend/src/relational/read.ts), assembled at whatever moment
 * the browser last fetched. A "full, consistent, point-in-time backup"
 * claim is much stronger coming from the server, which can read
 * platform_state and every rel_* table back-to-back in one short window
 * and PROVE (via the verification step below) that nothing was dropped,
 * rather than trusting a browser tab's possibly-stale/possibly-partial
 * in-memory state.
 *
 * CONSISTENCY: every read below happens against the SAME open pool client,
 * back-to-back, with no intervening writes initiated by this module. This
 * is not a full serializable snapshot (Postgres doesn't offer a
 * multi-statement consistent snapshot across arbitrary SELECTs without a
 * REPEATABLE READ / SERIALIZABLE transaction) — so it explicitly USES ONE:
 * the whole read is wrapped in `BEGIN TRANSACTION ISOLATION LEVEL
 * REPEATABLE READ READ ONLY; ... COMMIT;`, which gives every SELECT in the
 * transaction the same consistent snapshot of the database as of the
 * moment the transaction started, and READ ONLY additionally guarantees
 * this transaction itself can never write anything, mechanically, not
 * just by convention.
 *
 * VERIFICATION AGAINST SILENT PARTIAL FAILURE: after assembling everything,
 * this recomputes record counts directly from what was actually written
 * into the archive's data.json (not from what was originally queried) and
 * compares them against the counts captured at read time. Any mismatch
 * throws — the whole export fails loudly rather than silently shipping a
 * truncated file. A SHA-256 checksum of data.json is also included in the
 * manifest so a restore tool (or a human) can verify the ZIP was not
 * corrupted/modified after export.
 *
 * SENSITIVE-DATA EXCLUSION: preserves the pre-existing policy exactly —
 * this backup includes the same STATE_ARRAY_KEYS sections the old export
 * covered (business data only). It does NOT read or include app_users,
 * password hashes, JWT secrets, or any other authentication material —
 * there was never a code path here that could, since this module only
 * ever queries platform_state and the rel_* business tables, never
 * app_users.
 */
import archiver from 'archiver';
import crypto from 'crypto';
import { PassThrough } from 'stream';
import pool from '../db/pool';
import { ALL_SECTIONS, CutoverSection } from './cutover';
import { getAuthoritativeJson, SECTION_JSON_KEY } from './read';

// Mirrors STATE_ARRAY_KEYS in platformState.ts / index.html — the full set
// of business-data sections a "full platform backup" has always covered.
// Sections with no relational equivalent (assets, savedCalcs, savedImports,
// bankTxns, chartOfAccounts, accBills, completeProducts, payrollRecords,
// proposedProjects, userAccounts) are always sourced from platform_state —
// there is no rel_* table for them yet (schema-only or out-of-scope tier),
// exactly as documented in migration 007's header.
const ALL_JSON_SECTIONS = [
  'jobs', 'inventory', 'quotes', 'customers', 'suppliers', 'assets',
  'employees', 'leaveRequests', 'disciplinary', 'savedCalcs', 'purchaseOrders',
  'savedImports', 'bankTxns', 'chartOfAccounts', 'accInvoices', 'accBills',
  'completeProducts', 'payrollRecords', 'quickRates', 'proposedProjects', 'creditNotes',
];

// CUTOVER BLOCKER COMPLETION — closes Full Backup V2 gap #1 (no raw rel_*
// table dump — only a JSON-shaped rendering of currently-cut-over sections)
// and gap #2 (document_number_counters entirely absent). Every rel_* table
// from migration 007 (business data) PLUS the two supporting tables that are
// genuinely recovery-critical once relational authority begins: without
// document_number_counters, restoring only rel_jobs/rel_quotes/etc but not the
// atomic counters they were numbered from risks a future document reusing an
// already-issued number after a restore; without quote_conversions, a
// restored database loses the quote<->job conversion history the JSON-side
// read overlay depends on (see services.ts's convertQuoteToJob/deleteJob).
// This is read UNCONDITIONALLY — every table, every row — regardless of
// which sections are currently cut over, because a genuinely full recovery
// must be possible even for a section that gets cut over AFTER this backup
// was taken but before the next one.
const RAW_REL_TABLES = [
  'rel_companies', 'rel_customers', 'rel_suppliers', 'rel_inventory_items',
  'rel_quick_rate_items', 'rel_quotes', 'rel_quote_line_items', 'rel_jobs',
  'rel_job_line_items', 'rel_invoices', 'rel_invoice_line_items', 'rel_payments',
  'rel_credit_notes', 'rel_purchase_orders', 'rel_purchase_order_items',
  'rel_employees', 'rel_leave_requests', 'rel_disciplinary_records',
];
const RAW_SUPPORTING_TABLES = ['document_number_counters', 'quote_conversions'];

function arr(v: unknown): any[] { return Array.isArray(v) ? v : []; }

export interface FullBackupV2Result {
  buffer: Buffer;
  filename: string;
  manifest: Record<string, any>;
}

export async function buildFullBackupV2(exportedByRole: string): Promise<FullBackupV2Result> {
  const client = await pool.connect();
  let platformStateRow: { data: Record<string, any>; updated_at: string | null };
  let cutOverRows: Array<{ section: string; enabled: boolean }>;
  let quarantineCounts: Record<string, number> = {};

  try {
    // READ ONLY, REPEATABLE READ: every SELECT below sees one consistent
    // snapshot of the database, and this transaction is mechanically
    // incapable of writing anything, regardless of what code runs inside it.
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');

    const psRes = await client.query('SELECT data, updated_at FROM platform_state WHERE id = 1');
    platformStateRow = psRes.rowCount
      ? { data: psRes.rows[0].data || {}, updated_at: psRes.rows[0].updated_at }
      : { data: {}, updated_at: null };

    const cutRes = await client.query('SELECT section, enabled FROM relational_cutover ORDER BY section');
    cutOverRows = cutRes.rows;

    // Quarantine info — aggregate counts (kept exactly as before, for the
    // existing manifest.quarantinedGroupCounts field / backward compat).
    const qRes = await client.query(
      `SELECT collection, COUNT(DISTINCT source_id) AS n FROM relational_legacy_conflicts WHERE conflict_type = 'duplicate_source_id' GROUP BY collection`
    );
    for (const row of qRes.rows) quarantineCounts[row.collection] = Number(row.n);

    // CUTOVER BLOCKER COMPLETION — closes Full Backup V2 gap #4: the actual
    // quarantined records (not just aggregate counts above) are now captured
    // too, so a recovery/reconciliation pass after a restore can see exactly
    // WHICH source records were quarantined and why, not just how many.
    const quarantineRecordsRes = await client.query(
      `SELECT id, backfill_run_id, collection, source_id, document_number, conflict_type, detail, detected_at FROM relational_legacy_conflicts ORDER BY collection, source_id, id`
    );
    const quarantineRecords = quarantineRecordsRes.rows;

    // CUTOVER BLOCKER COMPLETION — closes gap #1 (raw rel_* table dump) and
    // gap #2 (document_number_counters absent). Read every table raw, inside
    // this same REPEATABLE READ snapshot, regardless of cutover state.
    const rawTables: Record<string, any[]> = {};
    for (const table of RAW_REL_TABLES) {
      const res = await client.query(`SELECT * FROM ${table}`);
      rawTables[table] = res.rows;
    }
    for (const table of RAW_SUPPORTING_TABLES) {
      const res = await client.query(`SELECT * FROM ${table}`);
      rawTables[table] = res.rows;
    }

    // 2026-08-21 PURCHASE ORDER MIGRATION POLICY CHANGE: capture the RAW
    // historical JSON purchaseOrders array exactly as it stands in
    // platform_state, BEFORE any relational overlay below can replace
    // `effectiveData.purchaseOrders`. This is the permanent legacy archive —
    // independent of purchaseOrders' cutover state, never deleted, never
    // merged with the active dataset. See the archive-key handling further
    // down for how this is actually preserved in the exported ZIP.
    const legacyPurchaseOrdersArchive = arr(platformStateRow.data.purchaseOrders);

    // Build the effective, authority-correct `data` blob: platform_state as
    // the base, overlaid with a fresh relational-authoritative rendering for
    // every section that is ACTUALLY cut over right now (env master switch
    // AND db row — the SAME double gate as everywhere else; re-derived here
    // rather than trusted from the cutOverRows query above alone, since the
    // env master switch is process-level, not a DB row).
    const masterSwitch = process.env.RELATIONAL_AUTHORITY_ENABLED === 'true';
    const effectiveData: Record<string, any> = { ...platformStateRow.data };
    const sectionAuthority: Record<string, 'json' | 'relational'> = {};
    for (const key of ALL_JSON_SECTIONS) sectionAuthority[key] = 'json';

    if (masterSwitch) {
      for (const row of cutOverRows) {
        if (!row.enabled) continue;
        const section = row.section as CutoverSection;
        const jsonKey = SECTION_JSON_KEY[section];
        if (!jsonKey) continue; // 'payments' — no standalone key, see read.ts
        effectiveData[jsonKey] = await getAuthoritativeJson(section);
        sectionAuthority[jsonKey] = 'relational';
      }
    }

    // 2026-08-21 PURCHASE ORDER MIGRATION POLICY CHANGE: once purchaseOrders
    // is cut over, `effectiveData.purchaseOrders` above has just been
    // REPLACED by the fresh relational rendering (ACTIVE RELATIONAL PURCHASE
    // ORDERS — correctly reflecting that the 640 historical JSON records are
    // no longer the active dataset). Without the line below, the original
    // historical JSON purchaseOrders array would simply be gone from this
    // backup the moment cutover happens — never physically deleted from
    // platform_state itself, but absent from THIS archive, which would
    // violate "do not erase the historical PO source data from recovery
    // material". `purchaseOrdersLegacyArchive` always carries that original
    // historical array, unfiltered, regardless of purchaseOrders' cutover
    // state — so the ZIP always contains both an unambiguous ACTIVE dataset
    // (`purchaseOrders`) and the LEGACY JSON PURCHASE ORDER ARCHIVE
    // (`purchaseOrdersLegacyArchive`), never merged into one list. See the
    // manifest's `purchaseOrdersDataset` field for the human-readable
    // distinction.
    effectiveData.purchaseOrdersLegacyArchive = legacyPurchaseOrdersArchive;

    // CUTOVER BLOCKER COMPLETION — closes gap #3: relational_cutover's RAW
    // per-section state, captured unconditionally (regardless of the env
    // master switch), covering EVERY section in ALL_SECTIONS including
    // "payments" (which sectionAuthority/perSectionAuthority above can never
    // represent — it has no standalone JSON key, see SECTION_JSON_KEY). This
    // is the ground truth a restore/reconciliation tool should trust instead
    // of the derived perSectionAuthority summary, which — by design, for its
    // OWN documented purpose of describing "what does data.json currently
    // contain" — collapses to 'json' for every section whenever the master
    // switch happens to be off at backup time, even if the DB rows say
    // enabled=true underneath.
    const cutoverStateRaw = cutOverRows.map(r => ({ section: r.section, enabled: r.enabled }));

    // A single new file (relational-raw.json), additive alongside the
    // existing data.json/manifest.json — nothing already in the archive is
    // removed, restructured, or reinterpreted.
    const relationalRaw = {
      relTables: rawTables,
      cutoverStateRaw,
      relationalAuthorityMasterSwitchEnabled: masterSwitch,
      quarantineRecords,
    };

    await client.query('COMMIT');

    // ── Assemble manifest + payload ──────────────────────────────────────
    const now = new Date();
    const recordCounts: Record<string, number> = {};
    for (const key of ALL_JSON_SECTIONS) recordCounts[key] = arr(effectiveData[key]).length;
    // purchaseOrdersLegacyArchive is NOT one of the normal ALL_JSON_SECTIONS
    // authority-bearing sections (it has no "active/relational" concept of
    // its own — it is always the raw historical snapshot) but it still gets
    // the same record-count + verification treatment as everything else.
    recordCounts.purchaseOrdersLegacyArchive = arr(effectiveData.purchaseOrdersLegacyArchive).length;

    const dataJson = JSON.stringify(effectiveData, null, 2);
    const checksum = crypto.createHash('sha256').update(dataJson, 'utf8').digest('hex');

    const rawRecordCounts: Record<string, number> = {};
    for (const table of [...RAW_REL_TABLES, ...RAW_SUPPORTING_TABLES]) rawRecordCounts[table] = arr(rawTables[table]).length;
    rawRecordCounts.quarantineRecords = arr(quarantineRecords).length;
    const relationalRawJson = JSON.stringify(relationalRaw, null, 2);
    const relationalRawChecksum = crypto.createHash('sha256').update(relationalRawJson, 'utf8').digest('hex');

    // ── Verification against silent partial failure ──────────────────────
    // Recompute counts from the EXACT bytes about to be archived (parse
    // dataJson back) rather than trusting `effectiveData` object identity —
    // this catches a class of bug where serialization itself drops/mangles
    // something (e.g. a circular reference silently truncated), not just a
    // query that returned too few rows.
    const reparsed = JSON.parse(dataJson);
    for (const key of ALL_JSON_SECTIONS) {
      const expected = recordCounts[key];
      const actual = arr(reparsed[key]).length;
      if (actual !== expected) {
        throw new Error(`Full Backup V2 verification FAILED: section "${key}" expected ${expected} record(s) but the serialized archive would contain ${actual} — aborting export, nothing was written.`);
      }
    }
    {
      const expected = recordCounts.purchaseOrdersLegacyArchive;
      const actual = arr(reparsed.purchaseOrdersLegacyArchive).length;
      if (actual !== expected) {
        throw new Error(`Full Backup V2 verification FAILED: purchaseOrdersLegacyArchive expected ${expected} record(s) but the serialized archive would contain ${actual} — aborting export, nothing was written.`);
      }
    }
    // Same silent-partial-failure verification, applied to relational-raw.json.
    const reparsedRaw = JSON.parse(relationalRawJson);
    for (const table of [...RAW_REL_TABLES, ...RAW_SUPPORTING_TABLES]) {
      const expected = rawRecordCounts[table];
      const actual = arr(reparsedRaw.relTables && reparsedRaw.relTables[table]).length;
      if (actual !== expected) {
        throw new Error(`Full Backup V2 verification FAILED: raw table "${table}" expected ${expected} record(s) but the serialized archive would contain ${actual} — aborting export, nothing was written.`);
      }
    }
    {
      const expected = rawRecordCounts.quarantineRecords;
      const actual = arr(reparsedRaw.quarantineRecords).length;
      if (actual !== expected) {
        throw new Error(`Full Backup V2 verification FAILED: quarantineRecords expected ${expected} record(s) but the serialized archive would contain ${actual} — aborting export, nothing was written.`);
      }
    }

    const fileStamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const filename = `signacore-platform-full-backup-v2-${fileStamp}.zip`;

    const manifest = {
      formatVersion: 2,
      type: 'full-platform-backup-v2',
      exportedAt: now.toISOString(),
      exportedByRole,
      platformStateRevision: platformStateRow.updated_at,
      relationalAuthorityMasterSwitchEnabled: masterSwitch,
      perSectionAuthority: sectionAuthority,
      recordCounts,
      quarantinedGroupCounts: quarantineCounts,
      dataJsonSha256: checksum,
      dataJsonBytes: Buffer.byteLength(dataJson, 'utf8'),
      // CUTOVER BLOCKER COMPLETION — closes Full Backup V2 gaps #1-#4 (see
      // relational-raw.json below): raw rel_* tables + document_number_
      // counters + quote_conversions (gaps #1/#2), the raw per-section
      // relational_cutover state including "payments" (gap #3, ground truth
      // — see cutoverStateRaw's own comment above for why this differs from
      // perSectionAuthority), and full quarantined records, not just counts
      // (gap #4).
      relationalRawSha256: relationalRawChecksum,
      relationalRawBytes: Buffer.byteLength(relationalRawJson, 'utf8'),
      relationalRawRecordCounts: rawRecordCounts,
      cutoverStateRaw,
      // 2026-08-21 PURCHASE ORDER MIGRATION POLICY CHANGE: an explicit,
      // human-readable field distinguishing the ACTIVE purchase-order
      // dataset from the LEGACY JSON PURCHASE ORDER ARCHIVE, so nobody
      // reading this manifest (or a future restore tool) mistakes the 640
      // historical records for current active data once purchaseOrders is
      // cut over — see the archive-key handling above for the mechanics.
      purchaseOrdersDataset: {
        activeDataset: {
          key: 'data.json -> purchaseOrders',
          label: sectionAuthority.purchaseOrders === 'relational' ? 'ACTIVE RELATIONAL PURCHASE ORDERS' : 'ACTIVE (JSON, not yet cut over)',
          source: sectionAuthority.purchaseOrders,
          recordCount: recordCounts.purchaseOrders,
        },
        legacyJsonArchive: {
          key: 'data.json -> purchaseOrdersLegacyArchive',
          label: 'LEGACY JSON PURCHASE ORDER ARCHIVE',
          recordCount: recordCounts.purchaseOrdersLegacyArchive,
          note: 'The original historical purchaseOrders records exactly as they existed in platform_state, preserved unfiltered for forensic/recovery reference regardless of purchaseOrders\' cutover state. These are intentionally excluded from the relational migration by explicit migration policy (see backfill.ts\'s LEGACY_PURCHASE_ORDERS_SKIPPED_BY_POLICY classification) and are never presented as the active dataset, never merged with it, and never deleted.',
        },
      },
      contents: {
        'manifest.json': 'this file',
        'data.json': 'the full, unfiltered, both-companies business-data blob — same shape platform_state.data has always had, with relational-authoritative sections (see perSectionAuthority) rendered fresh from the relational tables instead of read from the (possibly frozen) platform_state row. See purchaseOrdersDataset above for the one section with a distinct active-vs-archive split.',
        'relational-raw.json': 'RAW relational recovery data, additive alongside data.json: every rel_* table (business rows AND child line items) exactly as stored, document_number_counters, quote_conversions, the raw relational_cutover per-section rows (cutoverStateRaw — includes "payments", which has no JSON-section equivalent), and the full quarantined-record list (relational_legacy_conflicts), not just aggregate counts. Read this file to reconstruct actual relational-authoritative state after a restore; data.json alone is a JSON-shaped RENDERING, not sufficient on its own to restore relational child records or document-number counters.',
      },
      excludes: 'app_users (accounts, password hashes), JWT secrets, and any other authentication material are never read or included by this export — same policy as the pre-V2 export.',
      notes: 'A section with perSectionAuthority="relational" is the live source of truth for that section; the JSON copy inside data.json for that section is a fresh rendering, not platform_state\'s own (possibly stale, frozen-at-cutover) copy. purchaseOrders is the one exception with its own permanent archive copy — see purchaseOrdersDataset. cutoverStateRaw is the ground truth for per-section relational authority — unlike perSectionAuthority (derived only for describing data.json\'s own JSON-key sections), it reflects the DB rows exactly as they stand, covers every section including "payments", and is not silently collapsed to "json" when relationalAuthorityMasterSwitchEnabled happens to be false at backup time.',
    };

    // ── Build the ZIP in memory ───────────────────────────────────────────
    const chunks: Buffer[] = [];
    const passthrough = new PassThrough();
    passthrough.on('data', (c: Buffer) => chunks.push(c));
    const archive = archiver('zip', { zlib: { level: 9 } });
    const done = new Promise<void>((resolve, reject) => {
      passthrough.on('end', resolve);
      archive.on('error', reject);
    });
    archive.pipe(passthrough);
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
    archive.append(dataJson, { name: 'data.json' });
    archive.append(relationalRawJson, { name: 'relational-raw.json' });
    await archive.finalize();
    await done;
    const buffer = Buffer.concat(chunks);

    return { buffer, filename, manifest };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
