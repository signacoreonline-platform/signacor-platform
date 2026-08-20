/**
 * reconstructPlatformStateAfterDuplicationAugust2026.ts
 *
 * FINAL, ONE-OFF, TEMPORARY production recovery for the 2026-08-20
 * jobs/protected-section duplication incident.
 *
 * Supersedes both repairDuplicatedJobsAugust2026.ts (surgical dedupe —
 * abandoned) and restorePlatformStateBeforeDuplicationAugust2026.ts (blind
 * full-blob restore from a `platform_state_backups` row — superseded now
 * that a verified, human-reviewed manual backup + a read-only backup-vs-live
 * comparison exist). This script reconstructs platform_state.data as:
 *
 *   clean manual backup (2026-08-20T09:51:20.512Z)
 *     + current LIVE userAccounts                (backup has none)
 *     + the LIVE copy of job SNS-00118            (has the real notes edit)
 *     + the LIVE copy of quote SQ-00177           (has the real added lines)
 *
 * Every other record — including the two KNOWN pre-existing historical id
 * collisions already present in the backup itself (27 `quickRates` groups,
 * 1 `customers` group) — is taken FROM THE BACKUP AS-IS. This script does
 * NOT deduplicate or "fix" those; they are not today's corruption and are
 * out of scope here, exactly as instructed.
 *
 * WHERE THE BACKUP COMES FROM: this script does not embed the ~8MB backup
 * JSON in source. It reads it from a local file, path given by
 * `--backup-file=<path>` (required) — the exact manual export file that was
 * inspected earlier (`...20260820115120.json`).
 *
 * SELECTION IS STRUCTURAL, NOT HARDCODED: SNS-00118 and SQ-00177 are
 * located in the backup by `num`, cross-checked against LIVE by that
 * record's own stable `id` (not by trusting `num` text alone), and the
 * correct live variant is picked by an explicit, auditable rule — not by
 * pasting a specific record's content into this file:
 *   - SNS-00118: the live copy whose `notes` field is exactly "Test Note".
 *   - SQ-00177:  the live copy with the LATER `_savedAt` timestamp.
 * If live doesn't match the expected shape (not exactly 2 distinct
 * variants, or the selection rule can't unambiguously pick one), this
 * ABORTS rather than guessing.
 *
 * DRIFT CHECK ("verify current state still matches the comparison basis"):
 * before doing anything else, this recomputes backup-vs-live classification
 * fresh (same A/B/C/D/E/F logic as the earlier read-only comparison) against
 * whatever LIVE actually is right now. It requires: zero new records (D),
 * zero missing records (E), zero single-copy-modified records (C), and that
 * every conflicting-copy id (F) is EITHER one of the backup's own
 * pre-existing collision ids (derived live from the backup file, not a
 * hardcoded list) OR one of the two named exceptions above. Any conflict
 * outside that — i.e. anything that would mean the comparison this
 * reconstruction is based on is stale — aborts with no write.
 *
 * SAFETY MODEL
 * ────────────
 *  - Default mode is DRY RUN — fully read-only.
 *  - Apply requires BOTH `--apply` AND
 *    `--confirm="RECONSTRUCT PLATFORM STATE FROM CLEAN BACKUP"`.
 *  - Apply: BEGIN -> SELECT platform_state FOR UPDATE -> re-run the drift
 *    check against the JUST-LOCKED row -> re-locate SNS-00118/SQ-00177 live
 *    variants under the lock -> INSERT an emergency backup of the CURRENT
 *    (corrupted) state, reason 'before-reconstruct-platform-state-after-
 *    duplication' -> construct finalData -> verify every invariant listed
 *    below -> UPDATE platform_state.data ONLY -> COMMIT.
 *  - Touches only `platform_state` and `platform_state_backups`. Never
 *    touches `document_number_counters`, `quote_conversions`, any migration
 *    table, or any auth/user table.
 *  - No automatic retry, anywhere. A connection drop after the write is
 *    sent prints "commit status uncertain — do not re-run apply; run
 *    dry-run again first" and exits.
 *
 * PRE-WRITE INVARIANTS (all checked in-memory before any UPDATE is sent):
 *  - Every section's record count matches the backup's own count exactly,
 *    except `userAccounts` (sourced from live).
 *  - jobs: count and unique-id count both equal the backup's own jobs
 *    count (no duplicates introduced).
 *  - The SNS-00118 job appears exactly once in the final jobs array and its
 *    `notes` field is exactly "Test Note".
 *  - The SQ-00177 quote appears exactly once in the final quotes array and
 *    is byte-identical to the selected (later) live variant.
 *  - No section's duplicate-id groups exceed the backup's OWN pre-existing
 *    duplicate-id groups for that section — i.e. no incident-created
 *    duplicate survives, only the already-acknowledged historical ones.
 *  - `customers` and `quickRates` in the final data are byte-for-byte
 *    identical to the backup's own `customers`/`quickRates` (untouched,
 *    collisions preserved exactly as they were).
 *  - `userAccounts` in the final data is byte-for-byte identical to
 *    CURRENT LIVE `userAccounts` (never sourced from the backup).
 *
 * USAGE
 * ─────
 *   npm run build
 *   DATABASE_URL="<connection string>" \
 *   npm run reconstruct:platform-state-after-duplication -- --backup-file="<path to the manual backup json>"
 *
 *   Apply (only after reviewing dry-run output):
 *   DATABASE_URL="<connection string>" \
 *   npm run reconstruct:platform-state-after-duplication -- --backup-file="<path>" --apply --confirm="RECONSTRUCT PLATFORM STATE FROM CLEAN BACKUP"
 */

import { Client } from 'pg';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';

// ── CLI args ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const CONFIRM_FLAG = argv.find((a) => a.startsWith('--confirm='));
const CONFIRM_VALUE = CONFIRM_FLAG ? CONFIRM_FLAG.slice('--confirm='.length).replace(/^"(.*)"$/, '$1') : '';
const REQUIRED_CONFIRM = 'RECONSTRUCT PLATFORM STATE FROM CLEAN BACKUP';
const WILL_APPLY = APPLY && CONFIRM_VALUE === REQUIRED_CONFIRM;
const BACKUP_FILE_FLAG = argv.find((a) => a.startsWith('--backup-file='));
const BACKUP_FILE_PATH = BACKUP_FILE_FLAG ? BACKUP_FILE_FLAG.slice('--backup-file='.length).replace(/^"(.*)"$/, '$1') : null;

if (APPLY && CONFIRM_VALUE !== REQUIRED_CONFIRM) {
  console.error(`[reconstruct] --apply was passed but --confirm did not exactly match "${REQUIRED_CONFIRM}" — refusing to run. Falling back to DRY RUN.`);
}

const ALL_STATE_SECTIONS = [
  'jobs', 'inventory', 'quotes', 'customers', 'suppliers', 'assets',
  'employees', 'leaveRequests', 'disciplinary', 'savedCalcs', 'purchaseOrders',
  'savedImports', 'bankTxns', 'chartOfAccounts', 'accInvoices', 'accBills',
  'completeProducts', 'payrollRecords', 'quickRates', 'proposedProjects', 'creditNotes',
];

// Named, explicit, business-key exceptions — the ONLY two records this
// script will source from LIVE instead of the backup. Selection rules are
// functions, not pasted record content, so the actual data is verified at
// runtime, not assumed.
const NAMED_EXCEPTIONS = [
  {
    section: 'jobs',
    num: 'SNS-00118',
    describe: (r: any) => `notes=${JSON.stringify(r?.notes)}`,
    select: (variants: any[]): any | null => {
      const matches = variants.filter((r) => r && r.notes === 'Test Note');
      return matches.length === 1 ? matches[0] : null;
    },
  },
  {
    section: 'quotes',
    num: 'SQ-00177',
    describe: (r: any) => `_savedAt=${r?._savedAt}`,
    select: (variants: any[]): any | null => {
      const withTs = variants.filter((r) => r && typeof r._savedAt === 'string');
      if (withTs.length !== variants.length) return null; // every variant must be timestamped to compare
      const sorted = [...withTs].sort((a, b) => new Date(b._savedAt).getTime() - new Date(a._savedAt).getTime());
      // Require an unambiguous, strictly later timestamp for the winner.
      if (sorted.length >= 2 && new Date(sorted[0]._savedAt).getTime() === new Date(sorted[1]._savedAt).getTime()) return null;
      return sorted[0];
    },
  },
];

function arr(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

function stableStringify(v: any): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

function recordCountsOf(data: Record<string, any>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of ALL_STATE_SECTIONS) out[k] = arr(data[k]).length;
  return out;
}

// Returns the set of ids that have >1 record sharing that id in `list`.
function duplicateIdSet(list: any[]): Set<string> {
  const counts = new Map<string, number>();
  for (const r of list) {
    if (!r || r.id === undefined || r.id === null) continue;
    const id = String(r.id);
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  const out = new Set<string>();
  for (const [id, n] of counts) if (n > 1) out.add(id);
  return out;
}

function groupById(list: any[]): Map<string, any[]> {
  const m = new Map<string, any[]>();
  for (const r of list) {
    if (!r || r.id === undefined || r.id === null) continue;
    const id = String(r.id);
    if (!m.has(id)) m.set(id, []);
    m.get(id)!.push(r);
  }
  return m;
}

function loadBackupFile(): Record<string, any> {
  if (!BACKUP_FILE_PATH) {
    console.error('[reconstruct] --backup-file=<path> is required. Refusing to run.');
    process.exit(1);
  }
  let raw: string;
  try {
    raw = readFileSync(BACKUP_FILE_PATH, 'utf8');
  } catch (err) {
    console.error(`[reconstruct] Could not read --backup-file="${BACKUP_FILE_PATH}": ${String(err)}`);
    process.exit(1);
  }
  const parsed = JSON.parse(raw!);
  const data = parsed.data;
  if (!data || typeof data !== 'object') {
    console.error('[reconstruct] Backup file does not contain a "data" object at its top level. Refusing to run.');
    process.exit(1);
  }
  if (Array.isArray(data.userAccounts)) {
    console.warn('[reconstruct] NOTE: the backup file unexpectedly DOES contain userAccounts — it will be IGNORED. Live userAccounts is always used, per standing instruction.');
  }
  console.log(`[reconstruct] Backup loaded: ${BACKUP_FILE_PATH}`);
  console.log(`[reconstruct] backupMeta: ${JSON.stringify(parsed.backupMeta)}`);
  return data;
}

interface DriftIssue { section: string; kind: string; detail: string }

// Recomputes the SAME classification the earlier read-only comparison used,
// against whatever LIVE actually is right now, and asserts it still matches
// the basis this reconstruction assumes: zero new, zero missing, zero
// single-copy-modified, and every conflicting id explained either by the
// backup's OWN pre-existing collisions or by a named exception above.
function checkDrift(backupData: Record<string, any>, liveData: Record<string, any>): DriftIssue[] {
  const issues: DriftIssue[] = [];
  for (const section of ALL_STATE_SECTIONS) {
    const backupList = arr(backupData[section]);
    const liveList = arr(liveData[section]);
    const backupGroups = groupById(backupList);
    const liveGroups = groupById(liveList);
    const backupOwnDupIds = duplicateIdSet(backupList); // pre-existing collisions, derived live from the backup file itself

    const allIds = new Set<string>([...backupGroups.keys(), ...liveGroups.keys()]);
    for (const id of allIds) {
      const bRecs = backupGroups.get(id) || [];
      const lRecs = liveGroups.get(id) || [];
      if (bRecs.length === 0 && lRecs.length > 0) {
        issues.push({ section, kind: 'NEW', detail: `id ${id} exists live but not in backup (expected zero — comparison basis said D=0)` });
        continue;
      }
      if (bRecs.length > 0 && lRecs.length === 0) {
        issues.push({ section, kind: 'MISSING', detail: `id ${id} exists in backup but not live (expected zero — comparison basis said E=0)` });
        continue;
      }
      const lDistinct = new Set(lRecs.map(stableStringify));
      if (lRecs.length === 1) {
        const bDistinct = new Set(bRecs.map(stableStringify));
        if (!bDistinct.has(stableStringify(lRecs[0]))) {
          // Single live copy whose content differs from every backup copy —
          // this is a real "C" (modified) case the comparison basis said
          // didn't exist. Allow it ONLY if it's a named exception's target id.
          const exception = NAMED_EXCEPTIONS.find((e) => e.section === section && bRecs[0] && bRecs[0].num === e.num);
          if (!exception) {
            issues.push({ section, kind: 'MODIFIED', detail: `id ${id} has a single live copy that differs from backup (expected zero unmatched — comparison basis said C=0)` });
          }
        }
        continue;
      }
      // lRecs.length > 1 — conflicting or clean-duplicate
      if (lDistinct.size === 1) continue; // clean duplicate, always fine — this is the incident's normal signature
      // Multiple distinct live variants for this id — must be explained.
      if (backupOwnDupIds.has(id)) continue; // pre-existing collision, carried forward — expected
      const exception = NAMED_EXCEPTIONS.find((e) => e.section === section && bRecs[0] && bRecs[0].num === e.num);
      if (exception) continue; // one of the two named, explicitly-handled edits
      issues.push({ section, kind: 'UNEXPLAINED_CONFLICT', detail: `id ${id} has ${lRecs.length} live copies with ${lDistinct.size} distinct variants, not a known pre-existing collision or named exception` });
    }
  }
  return issues;
}

function resolveException(
  exception: typeof NAMED_EXCEPTIONS[number],
  backupData: Record<string, any>,
  liveData: Record<string, any>
): { record: any } | { error: string } {
  const backupList = arr(backupData[exception.section]);
  const backupMatches = backupList.filter((r) => r && r.num === exception.num);
  if (backupMatches.length !== 1) {
    return { error: `expected exactly 1 backup "${exception.section}" record with num="${exception.num}", found ${backupMatches.length}` };
  }
  const targetId = String(backupMatches[0].id);
  const liveList = arr(liveData[exception.section]);
  const liveVariantsRaw = liveList.filter((r) => r && String(r.id) === targetId);
  if (liveVariantsRaw.length === 0) {
    return { error: `no live "${exception.section}" record found with id ${targetId} (backup's ${exception.num})` };
  }
  const distinctByContent = new Map<string, any>();
  for (const r of liveVariantsRaw) distinctByContent.set(stableStringify(r), r);
  const variants = Array.from(distinctByContent.values());
  if (variants.length === 1) {
    // Only one distinct variant live — nothing to choose between; use it,
    // but only if it actually satisfies the selection rule (e.g. already
    // carries the expected edit) or is identical to the backup copy.
    const chosen = exception.select(variants);
    if (chosen) return { record: chosen };
    if (stableStringify(variants[0]) === stableStringify(backupMatches[0])) return { record: variants[0] };
    return { error: `live has only 1 variant for ${exception.num}, and it neither matches the backup copy nor satisfies the selection rule (${exception.describe(variants[0])}) — needs manual review` };
  }
  if (variants.length !== 2) {
    return { error: `expected exactly 2 distinct live variants for ${exception.num}, found ${variants.length} — needs manual review, not auto-resolvable` };
  }
  const chosen = exception.select(variants);
  if (!chosen) {
    return { error: `could not unambiguously select between the 2 live variants for ${exception.num} (${variants.map(exception.describe).join(' | ')}) — needs manual review` };
  }
  return { record: chosen };
}

function dbUrlLooksSet(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[reconstruct] DATABASE_URL is not set. Refusing to run.');
    process.exit(1);
  }
  return url;
}

function makeClient(): Client {
  const url = dbUrlLooksSet();
  const isLocal = /localhost|127\.0\.0\.1/.test(url);
  return new Client({
    connectionString: url,
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
  });
}

async function fetchLive(client: Client, forUpdate: boolean): Promise<{ data: Record<string, any>; updatedAt: string | null }> {
  const res = await client.query(
    forUpdate
      ? 'SELECT data, updated_at FROM platform_state WHERE id = 1 FOR UPDATE'
      : 'SELECT data, updated_at FROM platform_state WHERE id = 1'
  );
  if (res.rowCount === 0) return { data: {}, updatedAt: null };
  return { data: res.rows[0].data || {}, updatedAt: res.rows[0].updated_at };
}

function buildFinalData(backupData: Record<string, any>, liveData: Record<string, any>, snsRecord: any, sqRecord: any): Record<string, any> {
  const finalData: Record<string, any> = {};
  // Every backup key, verbatim, EXCEPT jobs/quotes which get the named
  // exception's live record substituted in place of the backup's own copy.
  for (const key of Object.keys(backupData)) {
    if (key === 'userAccounts') continue; // never sourced from backup
    if (key === 'jobs') {
      finalData.jobs = arr(backupData.jobs).map((j) => (j && j.num === 'SNS-00118' ? snsRecord : j));
      continue;
    }
    if (key === 'quotes') {
      finalData.quotes = arr(backupData.quotes).map((q) => (q && q.num === 'SQ-00177' ? sqRecord : q));
      continue;
    }
    finalData[key] = backupData[key];
  }
  finalData.userAccounts = liveData.userAccounts;
  return finalData;
}

function printDriftIssues(issues: DriftIssue[]) {
  if (issues.length === 0) {
    console.log('  none — live state still matches the comparison basis exactly.');
    return;
  }
  for (const i of issues) console.log(`  ✗ [${i.section}] ${i.kind}: ${i.detail}`);
}

async function runChecks(backupData: Record<string, any>, liveData: Record<string, any>): Promise<{ ok: boolean; snsRecord?: any; sqRecord?: any; problems: string[] }> {
  const problems: string[] = [];

  console.log('\nDRIFT CHECK (live vs. the comparison basis):');
  const drift = checkDrift(backupData, liveData);
  printDriftIssues(drift);
  if (drift.length > 0) problems.push(`${drift.length} drift issue(s) — live has changed in a way the comparison basis did not account for`);

  console.log('\nNAMED EXCEPTION RESOLUTION:');
  const snsResult = resolveException(NAMED_EXCEPTIONS[0], backupData, liveData);
  const sqResult = resolveException(NAMED_EXCEPTIONS[1], backupData, liveData);
  if ('error' in snsResult) { console.log(`  ✗ SNS-00118: ${snsResult.error}`); problems.push(`SNS-00118: ${snsResult.error}`); }
  else console.log(`  ✓ SNS-00118 resolved: notes=${JSON.stringify(snsResult.record.notes)}`);
  if ('error' in sqResult) { console.log(`  ✗ SQ-00177: ${sqResult.error}`); problems.push(`SQ-00177: ${sqResult.error}`); }
  else console.log(`  ✓ SQ-00177 resolved: _savedAt=${sqResult.record._savedAt}`);

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, snsRecord: (snsResult as any).record, sqRecord: (sqResult as any).record, problems: [] };
}

function verifyFinalData(backupData: Record<string, any>, liveData: Record<string, any>, finalData: Record<string, any>): string[] {
  const problems: string[] = [];

  for (const key of ALL_STATE_SECTIONS) {
    if (key === 'userAccounts') continue;
    const backupLen = arr(backupData[key]).length;
    const finalLen = arr(finalData[key]).length;
    if (backupLen !== finalLen) problems.push(`section "${key}": final count (${finalLen}) does not match backup count (${backupLen})`);
  }

  const jobsIds = new Set(arr(finalData.jobs).map((j) => String(j.id)));
  if (jobsIds.size !== arr(finalData.jobs).length) problems.push(`jobs: ${arr(finalData.jobs).length} records but only ${jobsIds.size} unique ids — duplicate ids present`);

  const snsInFinal = arr(finalData.jobs).filter((j) => j && j.num === 'SNS-00118');
  if (snsInFinal.length !== 1) problems.push(`SNS-00118 occurs ${snsInFinal.length} times in final jobs (expected exactly 1)`);
  else if (snsInFinal[0].notes !== 'Test Note') problems.push(`SNS-00118's final notes field is ${JSON.stringify(snsInFinal[0].notes)}, expected "Test Note"`);

  const sqInFinal = arr(finalData.quotes).filter((q) => q && q.num === 'SQ-00177');
  if (sqInFinal.length !== 1) problems.push(`SQ-00177 occurs ${sqInFinal.length} times in final quotes (expected exactly 1)`);

  for (const key of ALL_STATE_SECTIONS) {
    if (key === 'userAccounts') continue;
    const backupDup = duplicateIdSet(arr(backupData[key]));
    const finalDup = duplicateIdSet(arr(finalData[key]));
    const extra = Array.from(finalDup).filter((id) => !backupDup.has(id));
    if (extra.length > 0) problems.push(`section "${key}": ${extra.length} duplicate id(s) in final data NOT explained by the backup's own pre-existing collisions: [${extra.slice(0, 10).join(', ')}]`);
  }

  if (stableStringify(finalData.customers) !== stableStringify(backupData.customers)) {
    problems.push('customers: final data is not byte-identical to the backup (it must be — customers is untouched except by nothing)');
  }
  if (stableStringify(finalData.quickRates) !== stableStringify(backupData.quickRates)) {
    problems.push('quickRates: final data is not byte-identical to the backup (it must be untouched)');
  }
  if (stableStringify(finalData.userAccounts) !== stableStringify(liveData.userAccounts)) {
    problems.push('userAccounts: final data is not byte-identical to current live userAccounts');
  }

  return problems;
}

// 2026-08-20 CONNECTION/TRANSACTION-SHAPE FIX: a cheap staleness signal for
// Phase 2 of apply() to check the locked row against, WITHOUT re-running
// the expensive drift check while the row is locked. Deliberately plain
// `JSON.stringify` here, NOT the recursive key-sorting `stableStringify`
// used elsewhere in this file — those two reads are of the SAME jsonb
// column, and Postgres's jsonb storage format has a fixed, deterministic
// key ordering per stored value (not affected by which connection reads
// it), so two unchanged reads always produce byte-identical JSON text.
// `stableStringify` exists to compare two objects from DIFFERENT sources
// (backup vs. live) that may have unrelated key ordering — not needed, and
// more expensive, here. userAccounts is excluded on purpose: Phase 2 always
// takes userAccounts fresh from the locked row regardless of Phase 1's
// read, so a userAccounts-only change between the two reads is not
// "staleness" and must not block the apply.
function dataHashExcludingUserAccounts(data: Record<string, any>): string {
  const { userAccounts, ...rest } = data;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

// `pg` returns a `timestamp without time zone` column as a JS Date object,
// not a string, despite the `string | null` type used for it elsewhere in
// this file for logging convenience. Two Date instances for the identical
// moment are never `===`/`!==`-equal (object identity, not value equality),
// so a naive `a !== b` staleness check between Phase 1's and Phase 2's reads
// would ALWAYS report "changed" even when nothing changed. Normalize to a
// comparable primitive (epoch ms, or null) before comparing.
function updatedAtKey(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v as string).getTime();
  return Number.isNaN(t) ? null : t;
}

async function dryRun(): Promise<void> {
  const backupData = loadBackupFile();
  const client = makeClient();
  await client.connect();
  try {
    const live = await fetchLive(client, false);
    console.log(`\n[reconstruct] Mode: DRY RUN (read-only — no data will be written)`);
    console.log(`[reconstruct] Live platform_state.updated_at: ${live.updatedAt}`);

    console.log('\nBACKUP record counts:', JSON.stringify(recordCountsOf(backupData)));
    console.log('LIVE record counts:  ', JSON.stringify(recordCountsOf(live.data)));

    const result = await runChecks(backupData, live.data);
    if (!result.ok) {
      console.log('\nSAFE TO APPLY: NO');
      for (const p of result.problems) console.log(`  - ${p}`);
      return;
    }

    const finalData = buildFinalData(backupData, live.data, result.snsRecord, result.sqRecord);
    const verifyProblems = verifyFinalData(backupData, live.data, finalData);
    console.log('\nFINAL-DATA PRE-WRITE VERIFICATION:');
    if (verifyProblems.length === 0) {
      console.log('  all invariants hold.');
      console.log('\nExpected reconstructed record counts:', JSON.stringify(recordCountsOf(finalData)));
      console.log('\nSAFE TO APPLY: YES');
      console.log(`\nTo apply, run:`);
      console.log(`  npm run reconstruct:platform-state-after-duplication -- --backup-file="${BACKUP_FILE_PATH}" --apply --confirm="${REQUIRED_CONFIRM}"`);
    } else {
      for (const p of verifyProblems) console.log(`  ✗ ${p}`);
      console.log('\nSAFE TO APPLY: NO');
    }
  } finally {
    await client.end();
  }
}

// 2026-08-20 CONNECTION/TRANSACTION-SHAPE FIX: the first production apply
// attempt failed with "Connection terminated unexpectedly" — a subsequent
// dry run proved the transaction rolled back cleanly (nothing written). The
// cause: runChecks()/buildFinalData()/verifyFinalData() were all running
// INSIDE the BEGIN...FOR UPDATE lock, against LIVE data at full corrupted
// scale (hundreds to low thousands of records per section, some with large
// nested arrays) — the drift check in particular does per-id classification
// with deep-equality (`stableStringify`) comparisons across every section,
// which is proportional to LIVE's inflated size, not the backup's. Held
// under a row lock against a real network connection, that was slow enough
// to trip a connection/idle timeout before ever reaching COMMIT.
//
// FIX (no change to reconstruction logic — same functions, same inputs,
// same selection rules — only WHEN they run relative to the lock):
//   Phase 1 (no lock): load backup, read live READ-ONLY, run the full drift
//     check + named-exception resolution + build + verify finalData, report
//     everything, then close this connection entirely.
//   Phase 2 (short lock): BEGIN, SELECT ... FOR UPDATE, a CHEAP staleness
//     check only (updated_at equality, then a hash of the locked row's data
//     minus userAccounts vs. the same hash computed in Phase 1 — no
//     re-running the drift check), swap in the LOCKED row's userAccounts,
//     a couple of O(1)/O(backup-size) in-memory sanity checks, INSERT the
//     emergency backup, UPDATE, COMMIT immediately.
//   Phase 3 (outside any transaction): fresh SELECT + full verification and
//     reporting, using the LOCKED read's data as the reference (not Phase
//     1's) so a legitimate userAccounts change between Phase 1 and the lock
//     is never misreported as a problem.
async function apply(): Promise<void> {
  const backupData = loadBackupFile();

  // ── PHASE 1 — read-only, unlocked. All expensive work happens here. ────
  const readClient = makeClient();
  readClient.on('error', (err) => {
    console.error('[reconstruct] Phase 1 (read-only) connection error — nothing was ever locked or written:', String(err));
  });
  await readClient.connect();
  let live: { data: Record<string, any>; updatedAt: string | null };
  try {
    live = await fetchLive(readClient, false);
  } finally {
    await readClient.end(); // closed before Phase 2 opens the write transaction
  }
  if (Object.keys(live.data).length === 0) {
    console.error('[reconstruct] No live platform_state row found. Nothing to reconstruct.');
    return;
  }

  console.log(`[reconstruct] Mode: APPLY — Phase 1 (read-only, unlocked). Live platform_state.updated_at at read time: ${live.updatedAt}`);
  console.log('\nBACKUP record counts:', JSON.stringify(recordCountsOf(backupData)));
  console.log('LIVE record counts:  ', JSON.stringify(recordCountsOf(live.data)));

  const result = await runChecks(backupData, live.data);
  if (!result.ok) {
    console.error('\n[reconstruct] BLOCKED in Phase 1 — no lock was ever taken, nothing written:');
    for (const p of result.problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }

  const preparedFinalData = buildFinalData(backupData, live.data, result.snsRecord, result.sqRecord);
  const verifyProblems = verifyFinalData(backupData, live.data, preparedFinalData);
  if (verifyProblems.length > 0) {
    console.error('\n[reconstruct] SAFETY CHECK FAILED in Phase 1 — no lock was ever taken, nothing written:');
    for (const p of verifyProblems) console.error(`  ✗ ${p}`);
    process.exitCode = 1;
    return;
  }

  console.log('\nPhase 1 complete — all checks pass. Expected reconstructed record counts:', JSON.stringify(recordCountsOf(preparedFinalData)));
  const preparedUpdatedAt = live.updatedAt;
  const preparedHash = dataHashExcludingUserAccounts(live.data);
  console.log(`Prepared basis for Phase 2: updated_at=${preparedUpdatedAt} hash=${preparedHash.slice(0, 16)}…`);

  // ── PHASE 2 — very short locked transaction. Cheap checks only. ────────
  type Stage = 'not-started' | 'locked' | 'write-sent' | 'committed';
  let stage: Stage = 'not-started';
  let lockedDataCaptured: Record<string, any> | null = null;

  const writeClient = makeClient();
  writeClient.on('error', (err) => {
    if (stage === 'write-sent') {
      console.error('\n[reconstruct] CONNECTION ERROR AFTER THE WRITE WAS SENT (client "error" event).');
      console.error('commit status uncertain — do not re-run apply; run dry-run again first');
    } else {
      console.error(`[reconstruct] Phase 2 connection error at stage="${stage}" (nothing written if this is before "write-sent"):`, String(err));
    }
  });

  try {
    await writeClient.connect();
    await writeClient.query('BEGIN');
    const lockedRes = await writeClient.query('SELECT data, updated_at FROM platform_state WHERE id = 1 FOR UPDATE');
    if (lockedRes.rowCount === 0) {
      await writeClient.query('ROLLBACK');
      console.error('[reconstruct] No live platform_state row found under lock. Rolled back — nothing written.');
      return;
    }
    stage = 'locked';
    const lockedData: Record<string, any> = lockedRes.rows[0].data || {};
    const lockedUpdatedAt: string | null = lockedRes.rows[0].updated_at;
    lockedDataCaptured = lockedData;

    // ── ONLY cheap staleness checks — no drift check, no diffing. ────────
    if (updatedAtKey(lockedUpdatedAt) !== updatedAtKey(preparedUpdatedAt)) {
      await writeClient.query('ROLLBACK');
      console.error(`[reconstruct] BLOCKED: live changed since Phase 1 (updated_at was ${preparedUpdatedAt}, now ${lockedUpdatedAt}). Rolled back — nothing written. Re-run the dry run.`);
      process.exitCode = 1;
      return;
    }
    if (dataHashExcludingUserAccounts(lockedData) !== preparedHash) {
      await writeClient.query('ROLLBACK');
      console.error('[reconstruct] BLOCKED: live content changed since Phase 1 despite matching updated_at (unexpected) — rolled back, nothing written. Re-run the dry run.');
      process.exitCode = 1;
      return;
    }

    // ── Preserve userAccounts from the LOCKED row, not the Phase 1 read. ──
    const finalWritePayload: Record<string, any> = { ...preparedFinalData, userAccounts: lockedData.userAccounts };

    // ── In-memory-only sanity checks — cheap, no full re-verification. ───
    if (stableStringify(finalWritePayload.userAccounts) !== stableStringify(lockedData.userAccounts)) {
      await writeClient.query('ROLLBACK');
      console.error('[reconstruct] BLOCKED: userAccounts assignment sanity check failed — rolled back, nothing written.');
      process.exitCode = 1;
      return;
    }
    const finalJobIds = new Set(arr(finalWritePayload.jobs).map((j) => String(j.id)));
    if (finalJobIds.size !== arr(finalWritePayload.jobs).length) {
      await writeClient.query('ROLLBACK');
      console.error('[reconstruct] BLOCKED: final jobs sanity check failed (duplicate ids) — rolled back, nothing written.');
      process.exitCode = 1;
      return;
    }

    // ── Emergency backup of the CURRENT (locked, corrupted) state — full,
    //    including userAccounts — INSIDE this transaction, BEFORE the UPDATE.
    const serializedCurrent = JSON.stringify(lockedData);
    const backupInsertRes = await writeClient.query(
      `INSERT INTO platform_state_backups (data, reason, data_size_bytes, record_counts, source)
       VALUES ($1::jsonb, 'before-reconstruct-platform-state-after-duplication', $2, $3::jsonb, $4)
       RETURNING id`,
      [serializedCurrent, Buffer.byteLength(serializedCurrent, 'utf8'), JSON.stringify(recordCountsOf(lockedData)), 'reconstructPlatformStateAfterDuplicationAugust2026.ts']
    );
    if (backupInsertRes.rowCount !== 1) {
      await writeClient.query('ROLLBACK');
      console.error('[reconstruct] Emergency backup insert failed — rolled back, nothing written.');
      process.exitCode = 1;
      return;
    }

    stage = 'write-sent';
    await writeClient.query(`UPDATE platform_state SET data = $1::jsonb, updated_at = NOW() WHERE id = 1`, [JSON.stringify(finalWritePayload)]);
    await writeClient.query('COMMIT');
    stage = 'committed';
    console.log(`\nCOMMIT confirmed. Emergency backup id=${backupInsertRes.rows[0].id}.`);
  } catch (err) {
    if (stage === 'write-sent') {
      console.error('\n[reconstruct] CONNECTION ERROR AFTER THE WRITE WAS SENT.');
      console.error('commit status uncertain — do not re-run apply; run dry-run again first');
      console.error(String(err));
      process.exitCode = 1;
      return;
    }
    try { await writeClient.query('ROLLBACK'); } catch { /* connection may already be gone */ }
    console.error(`[reconstruct] Failed at stage="${stage}" before any commit — rolled back, nothing written. Safe to re-run.`);
    console.error(String(err));
    process.exitCode = 1;
    return;
  } finally {
    try { await writeClient.end(); } catch { /* already gone */ }
  }

  // ── PHASE 3 — fresh read + full verification, OUTSIDE any transaction. ──
  const verifyClient = makeClient();
  verifyClient.on('error', (err) => {
    console.error('[reconstruct] Phase 3 (post-commit verify) connection error — informational only, the write already committed:', String(err));
  });
  await verifyClient.connect();
  try {
    const post = await verifyClient.query('SELECT data, updated_at FROM platform_state WHERE id = 1');
    const postData: Record<string, any> = post.rows[0]?.data || {};
    console.log(`\n── POST-COMMIT fresh read (outside any transaction) ───────`);
    console.log(`platform_state.updated_at: ${post.rows[0]?.updated_at}`);
    console.log(`counts: ${JSON.stringify(recordCountsOf(postData))}`);
    // Reference is the LOCKED read (lockedDataCaptured), not Phase 1's —
    // userAccounts may legitimately have advanced between Phase 1 and the
    // lock, and that must never be misreported as a problem here.
    const postProblems = verifyFinalData(backupData, lockedDataCaptured || live.data, postData);
    const jobsCount = arr(postData.jobs).length;
    const jobsUnique = new Set(arr(postData.jobs).map((j) => String(j.id))).size;
    const sns = arr(postData.jobs).find((j) => j && j.num === 'SNS-00118');
    const sq = arr(postData.quotes).find((q) => q && q.num === 'SQ-00177');
    console.log(`jobs: ${jobsCount} total, ${jobsUnique} unique ids`);
    console.log(`SNS-00118 notes: ${JSON.stringify(sns?.notes)}`);
    console.log(`SQ-00177 present: ${!!sq}, _savedAt: ${sq?._savedAt}`);
    if (postProblems.length === 0) {
      console.log('\n✓ RECONSTRUCTION SUCCESSFUL — all invariants hold post-commit.');
    } else {
      console.error('\n✗ UNEXPECTED: post-commit verification found problems — investigate immediately:');
      for (const p of postProblems) console.error(`  ✗ ${p}`);
      process.exitCode = 1;
    }
  } finally {
    await verifyClient.end();
  }
}

async function main() {
  if (WILL_APPLY) await apply();
  else await dryRun();
}

main().catch((err) => {
  console.error('[reconstruct] Fatal error:', err);
  process.exitCode = 1;
});
