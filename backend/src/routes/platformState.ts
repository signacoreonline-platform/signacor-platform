import { Router, Request, Response } from 'express';
import { query } from '../db/pool';
import pool from '../db/pool';
import { authenticate, AuthRequest } from '../middleware/auth';

/**
 * /api/platform-state
 *
 * Stores the entire dashboard JSON state in PostgreSQL.
 * Single-row table (id = 1) holding a JSONB blob — see
 * database/migrations/001_platform_state.sql.
 *
 * The static dashboard (root index.html) calls these endpoints to
 * load and save its full state. The database is the source of truth;
 * localStorage in the browser is only an emergency fallback.
 *
 * ── Authentication (added 2026-08-06, audit finding B1) ──────────────────
 * Both GET and PUT below now require a valid, backend-issued JWT
 * (`Authorization: Bearer <token>`, verified by `authenticate` — see
 * backend/src/middleware/auth.ts).
 *
 * ══════════════════════════════════════════════════════════════════════
 * 2026-08-20 DATA-SAFETY HARDENING — EXPLICIT-DELETE MERGE MODEL
 * ══════════════════════════════════════════════════════════════════════
 *
 * ROOT CAUSE BEING CLOSED: the previous merge design inferred a delete from
 * OMISSION — "this id was in `_knownSectionIds`/`_knownCreditNoteIds` but is
 * absent from the incoming array" was treated as "the client knew about it
 * and chose to delete it." That inference is only trustworthy if the
 * `_knownSectionIds` sent with a given save were captured at EXACTLY the
 * same moment as the array it accompanies. On the partial-save path
 * (savePartialSectionsNow / forceSaveSections), `_knownSectionIds` was
 * historically read from `serverBaselineRef.current` fresh at send time,
 * while the array itself could have been built earlier from stale
 * closure-captured React state (see index.html for the frontend half of
 * this fix). When a poll or another confirmed save advanced the baseline
 * in between, the backend saw "known id, omitted" for a record the payload
 * never actually knew about — and deleted it. Confirmed as the mechanism
 * behind SNS-00120–124 (and others) vanishing after being restored live —
 * reproduced exactly by backend/test/hardening.stress.ts Scenario I against
 * the pre-hardening version of this file (fails there, passes here).
 *
 * NEW RULE — deletion is never inferred from omission. It is enforced ONLY
 * from an explicit, caller-declared list:
 *
 *   data._deletedIds = { jobs: [id, id, ...], quotes: [...], ... }
 *
 * For every PROTECTED_SECTION present in `data`, the merge is:
 *   finalList = incoming records (by id; incoming always wins for a given
 *               id — this is how edits/creates take effect)
 *             + existing records whose id is NOT in incoming
 *               AND NOT in _deletedIds[key]           (preserved)
 *   (existing records whose id IS in _deletedIds[key] are dropped, even if
 *    the incoming payload also happens to include them — an explicit
 *    delete always wins)
 *
 * A section a caller never mentions at all (partial save omits the whole
 * key) is untouched, exactly as before. A section a caller DOES send, but
 * with some ids simply missing and NOT listed in `_deletedIds`, no longer
 * loses those ids — they are preserved. This makes the merge safe
 * regardless of how stale the array a caller sent was: staleness can now
 * only cause a save to "not know about" a record (which is always the safe
 * direction — the record survives), never to delete one it didn't intend to.
 *
 * The OLD `_knownSectionIds`/`_knownCreditNoteIds`-vs-incoming inference is
 * deliberately NOT kept as a "backward-compatible" fallback — that
 * inference IS the vulnerability. Those legacy fields are still accepted
 * and stripped from the payload (so an old cached browser tab never gets a
 * hard error) but never acted on. See resolveDeletedIds() below for the
 * full rationale — in short, this makes the failure mode of a not-yet-
 * updated client fail SAFE (a delete that doesn't take effect until reload)
 * rather than fail dangerously (a delete that removes the wrong thing).
 *
 * SERVER-SIDE BACKSTOP: after computing the merged result for every
 * protected section, `assertNoUnexplainedRemovals()` re-derives which ids
 * vanished and throws (failing the whole save, before any write) if any
 * vanished id is not accounted for by that section's resolved deletedIds.
 * This should be structurally unreachable given the merge formula above —
 * it exists as a mechanical, code-level proof that no save path in this
 * file can silently drop a record, not just a claim.
 *
 * REVISION / OPTIMISTIC CONCURRENCY: a save that carries any explicit
 * deletion (resolvedDeletedIds non-empty for at least one section) may
 * optionally include `data._baseRevision` (the `updated_at` value the
 * caller last fetched). If provided and it no longer matches the CURRENT
 * live `updated_at` (read after the row lock below), the save is rejected
 * with a structured 409 conflict instead of proceeding — a deletion must
 * never be applied against a server state newer than what the caller
 * actually saw. Saves with no explicit deletions are never blocked by this
 * check (they cannot destroy data under the merge formula above, so
 * blocking them would only cost availability for no safety benefit — and
 * risks the "endless retry loop" the hardening brief explicitly warns
 * against).
 */
const router = Router();
router.use(authenticate);

// Every array-type section persisted inside platform_state.data (mirrors
// STATE_SECTIONS in the frontend's index.html). `userAccounts` was missing
// from this list before the 2026-08-20 hardening pass even though the
// frontend has always saved it — it had NO wipe/merge protection at all.
const STATE_ARRAY_KEYS = [
  'jobs', 'inventory', 'quotes', 'customers', 'suppliers', 'assets',
  'employees', 'leaveRequests', 'disciplinary', 'savedCalcs', 'purchaseOrders',
  'savedImports', 'bankTxns', 'chartOfAccounts', 'accInvoices', 'accBills',
  'completeProducts', 'payrollRecords', 'quickRates', 'proposedProjects', 'creditNotes',
  'userAccounts',
];

// Sections whose sudden loss is most consequential for the business — used
// for the "obvious wipe" guard (detectWipe). `userAccounts` added
// 2026-08-20 — losing every login account is exactly the kind of thing this
// guard exists to catch.
const CRITICAL_KEYS = ['jobs', 'customers', 'suppliers', 'inventory', 'quotes', 'accInvoices', 'accBills', 'creditNotes', 'proposedProjects', 'userAccounts'];

// Sections that get id-based merge protection (2026-08-20: generalized to
// EVERY section from Part 3 of the hardening brief — jobs, quotes,
// customers, purchaseOrders, accInvoices, creditNotes, inventory,
// suppliers, proposedProjects, userAccounts — plus the pre-existing extras
// (accBills, quickRates, employees, leaveRequests, disciplinary), which is
// a superset and therefore strictly more protective. `creditNotes` no
// longer needs its own separate code path — see the header comment above,
// this generalized mechanism now handles it identically.
const PROTECTED_SECTIONS = [
  'jobs', 'quotes', 'customers', 'suppliers', 'inventory',
  'accInvoices', 'accBills', 'purchaseOrders', 'quickRates', 'employees',
  'leaveRequests', 'disciplinary', 'creditNotes', 'proposedProjects', 'userAccounts',
];

function arr(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

function idsOf(list: any[]): Set<string> {
  const s = new Set<string>();
  for (const rec of list) {
    if (rec && rec.id !== undefined && rec.id !== null) s.add(String(rec.id));
  }
  return s;
}

// Counts records per `co` (company) tag, for sections that carry one
// (jobs, quotes, purchaseOrders, etc.). Sections with no `co` field on their
// records simply produce an empty count map and are skipped by that check.
function countByCo(list: any[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of list) {
    if (item && item.co !== undefined && item.co !== null) {
      const key = String(item.co);
      out[key] = (out[key] || 0) + 1;
    }
  }
  return out;
}

function buildRecordCounts(data: Record<string, any>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const k of STATE_ARRAY_KEYS) counts[k] = arr(data[k]).length;
  return counts;
}

// Returns null if the incoming payload looks safe, or a short human-readable
// reason if it looks like it would wipe/partially-wipe existing data.
// Deliberately conservative: small/normal edits and deletions must never
// trip this guard — only clearly-accidental full/partial wipes should.
// This is a SEPARATE, coarser-grained guard from the id-level merge below —
// it catches whole-array wipes even in sections/shapes the id-merge can't
// safely reason about (e.g. records with no stable id).
function detectWipe(existingData: Record<string, any> | null, incomingData: any, isPartial: boolean = false): string | null {
  if (!existingData || typeof existingData !== 'object' || Object.keys(existingData).length === 0) {
    return null; // nothing live yet to protect — first-ever save, allow it
  }
  if (!incomingData || typeof incomingData !== 'object' || Array.isArray(incomingData)) {
    return 'incoming payload is not a valid state object';
  }

  if (!isPartial) {
    const existingHasData = STATE_ARRAY_KEYS.some((k) => arr(existingData[k]).length > 0);
    const incomingHasAnySection = STATE_ARRAY_KEYS.some((k) => Array.isArray(incomingData[k]));
    if (existingHasData && !incomingHasAnySection) {
      return 'incoming payload has none of the expected data sections (looks like an empty/default state)';
    }
  }

  for (const k of CRITICAL_KEYS) {
    const existingList = arr(existingData[k]);
    const existingLen = existingList.length;
    const incomingIsArray = Array.isArray(incomingData[k]);
    const incomingLen = incomingIsArray ? incomingData[k].length : 0;

    if (!isPartial && existingLen >= 3 && !incomingIsArray) {
      return `"${k}" is missing from the incoming payload (currently has ${existingLen} record(s))`;
    }
    if (!incomingIsArray && isPartial) continue;
    if (existingLen >= 5 && incomingLen === 0) {
      return `"${k}" would drop from ${existingLen} record(s) to 0`;
    }
    if (existingLen >= 10 && incomingLen <= existingLen * 0.2) {
      return `"${k}" would drop from ${existingLen} record(s) to ${incomingLen} (over 80% loss)`;
    }
    if (incomingIsArray && existingLen > 0) {
      const existingByCo = countByCo(existingList);
      const incomingByCo = countByCo(incomingData[k]);
      for (const co of Object.keys(existingByCo)) {
        if (existingByCo[co] >= 3 && !incomingByCo[co]) {
          return `"${k}" would lose all ${existingByCo[co]} record(s) for company "${co}"`;
        }
      }
    }
  }
  return null;
}

// ── Explicit-delete resolution (2026-08-20 hardening) ─────────────────────
// For a given section, returns the SET of ids this save is explicitly
// deleting. ONLY the new `_deletedIds[key]` field can ever cause a
// deletion — the caller states its intent directly, which is trustworthy
// regardless of any baseline timing, because it does not depend on
// comparing two possibly-mismatched snapshots at all.
//
// Deliberately NOT falling back to the OLD `_knownSectionIds`/
// `_knownCreditNoteIds`-vs-incoming inference: that inference is exactly
// the mechanism this hardening pass closes (see the file header). Keeping
// it as a "backward-compatible" fallback would keep the vulnerability
// alive for any caller — old, new, or future — that ever sends those
// legacy fields with a baseline captured at a different moment than the
// array it accompanies, which is precisely the failure mode already
// confirmed in production. The legacy fields are still accepted and
// stripped from the payload below (so an old cached browser tab does not
// get a hard error), they are just never acted on. The practical effect
// during a rollout is fail-SAFE, not fail-silent-unsafe: an old tab's own
// deletes (e.g. deleteJob) stop taking effect until it reloads and picks
// up the paired frontend change (see index.html), rather than risking
// deleting the wrong thing. A record that fails to delete is always
// recoverable by trying again after a reload; a record wrongly deleted is
// not.
function resolveDeletedIds(
  key: string,
  explicitDeletedIds: Record<string, any[]> | null
): Set<string> {
  if (explicitDeletedIds && Array.isArray(explicitDeletedIds[key])) {
    return new Set(explicitDeletedIds[key].map((x) => String(x)));
  }
  return new Set();
}

// ── New-record validation: co presence + no NEW duplicate numbers ────────
// (2026-08-18, production stabilisation, Section 14 — unchanged by this
// pass except where noted)
const NUMBER_CHECK_SECTIONS: Array<{ key: string; field: string; scopeByCo: boolean }> = [
  { key: 'quotes',         field: 'num',    scopeByCo: true  },
  { key: 'accInvoices',    field: 'number', scopeByCo: true  },
  { key: 'jobs',           field: 'num',    scopeByCo: false },
  { key: 'purchaseOrders', field: 'num',    scopeByCo: false },
];
const CO_REQUIRED_SECTIONS = ['quotes', 'jobs', 'purchaseOrders', 'accInvoices'];

function newRecordValidationError(existingData: Record<string, any> | null, finalData: Record<string, any>): string | null {
  for (const key of CO_REQUIRED_SECTIONS) {
    const finalList = arr(finalData[key]);
    if (finalList.length === 0) continue;
    const existingIds = new Set(arr(existingData && existingData[key]).map((x: any) => x && x.id));
    for (const rec of finalList) {
      if (!rec || rec.id === undefined || rec.id === null) continue;
      if (existingIds.has(rec.id)) continue;
      if (rec.co === undefined || rec.co === null || rec.co === '') {
        return `a new "${key}" record (id ${rec.id}) is missing its company (co) — save blocked to prevent an orphaned/company-1-default record`;
      }
    }
  }

  for (const { key, field, scopeByCo } of NUMBER_CHECK_SECTIONS) {
    const finalList = arr(finalData[key]);
    if (finalList.length === 0) continue;
    const existingList = arr(existingData && existingData[key]);
    const existingIds = new Set(existingList.map((x: any) => x && x.id));

    const groupKeyOf = (rec: any): string | null => {
      const raw = rec && rec[field];
      if (typeof raw !== 'string' || !raw.trim()) return null;
      const norm = raw.trim().toUpperCase();
      return scopeByCo ? `${String(rec.co)}::${norm}` : norm;
    };

    const groups = new Map<string, any[]>();
    for (const rec of finalList) {
      if (!rec) continue;
      const gk = groupKeyOf(rec);
      if (gk === null) continue;
      if (!groups.has(gk)) groups.set(gk, []);
      groups.get(gk)!.push(rec);
    }

    for (const [groupKey, recs] of groups) {
      if (recs.length < 2) continue;
      const anyNew = recs.some((r: any) => r.id !== undefined && r.id !== null && !existingIds.has(r.id));
      if (!anyNew) continue;

      const existingGroupCount = existingList.filter((r: any) => r && groupKeyOf(r) === groupKey).length;
      if (existingGroupCount >= recs.length) continue;

      return `a new "${key}" record would duplicate document number "${recs[0][field]}"${scopeByCo ? ` for company "${recs[0].co}"` : ''} — save blocked to prevent a new duplicate`;
    }
  }

  // ── 2026-08-20 hardening addition: duplicate conversion of one quote ────
  // Blocks a save that would introduce TWO (or more) jobs claiming the SAME
  // quoteNum, when at least one of those jobs is NEW in this save. Relative
  // validation, same pattern as above: a pre-existing duplicate (historical
  // corruption) is never blocked, only a save that WORSENS it.
  {
    const finalJobs = arr(finalData.jobs);
    if (finalJobs.length > 0) {
      const existingJobs = arr(existingData && existingData.jobs);
      const existingJobIds = new Set(existingJobs.map((x: any) => x && x.id));
      const groups = new Map<string, any[]>();
      for (const j of finalJobs) {
        if (!j || typeof j.quoteNum !== 'string' || !j.quoteNum.trim()) continue;
        const gk = j.quoteNum.trim().toUpperCase();
        if (!groups.has(gk)) groups.set(gk, []);
        groups.get(gk)!.push(j);
      }
      for (const [quoteNum, recs] of groups) {
        if (recs.length < 2) continue;
        const anyNew = recs.some((r: any) => r.id !== undefined && r.id !== null && !existingJobIds.has(r.id));
        if (!anyNew) continue;
        const existingGroupCount = existingJobs.filter((r: any) => r && typeof r.quoteNum === 'string' && r.quoteNum.trim().toUpperCase() === quoteNum).length;
        if (existingGroupCount >= recs.length) continue;
        return `a new "jobs" record would duplicate the quote→job conversion for quote "${quoteNum}" (${recs.length} jobs would reference it) — save blocked to prevent a second job for one quote`;
      }
    }
  }

  return null;
}

// ── Server-side backstop (2026-08-20 hardening) ────────────────────────────
// Mechanically proves the merge above never drops a record it didn't mean
// to. For every protected section present in BOTH existingData and
// finalData, any id that existed before and is absent afterward MUST be
// present in that section's resolved deletedIds set — otherwise this
// throws and the whole save is aborted before any write happens. This
// should be unreachable given how finalData is built below; it exists as a
// standing, testable guarantee rather than a claim.
function assertNoUnexplainedRemovals(
  existingData: Record<string, any> | null,
  finalData: Record<string, any>,
  resolvedDeletedIdsBySection: Record<string, Set<string>>
): void {
  if (!existingData) return;
  for (const key of PROTECTED_SECTIONS) {
    const existingList = arr(existingData[key]);
    if (existingList.length === 0) continue;
    const finalIds = idsOf(arr(finalData[key]));
    const deleted = resolvedDeletedIdsBySection[key] || new Set<string>();
    const unexplained: string[] = [];
    for (const rec of existingList) {
      if (!rec || rec.id === undefined || rec.id === null) continue;
      const id = String(rec.id);
      if (!finalIds.has(id) && !deleted.has(id)) unexplained.push(id);
    }
    if (unexplained.length > 0) {
      throw new Error(
        `SAFETY BACKSTOP TRIPPED: "${key}" would lose id(s) [${unexplained.join(', ')}] with no matching explicit delete — save aborted, nothing written. This indicates a bug in the merge logic itself, not a normal rejection.`
      );
    }
  }
}

// ── Server-side backstop 2 (2026-08-20 post-deploy, duplication incident) ─
// Independent of the merge implementation above by design: even if a FUTURE
// bug (in this merge, or any other code path that ever writes to a
// PROTECTED_SECTIONS array) produces a duplicate id, this refuses to
// persist it — a duplicate-id bug fails CLOSED (save blocked, nothing
// written) instead of silently doubling records. This is exactly the class
// of incident being closed here: a Set/string-vs-number id-comparison
// mismatch in the merge filter (see the fix above) caused every existing
// job to be treated as "not already in incoming" and re-appended, taking
// the live jobs collection from 111 records to 222 (111 exact duplicate
// pairs, same id, same job number, every field identical) after one normal
// job save. This check does not know or care why a duplicate might exist —
// it only guarantees one can never be written.
function assertNoDuplicateIds(finalData: Record<string, any>): void {
  for (const key of PROTECTED_SECTIONS) {
    const list = arr(finalData[key]);
    if (list.length === 0) continue;
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const rec of list) {
      if (!rec || rec.id === undefined || rec.id === null) continue;
      const id = String(rec.id);
      if (seen.has(id)) dupes.add(id);
      else seen.add(id);
    }
    if (dupes.size > 0) {
      throw new Error(
        `SAFETY BACKSTOP TRIPPED: "${key}" would persist duplicate id(s) [${[...dupes].join(', ')}] — save aborted, nothing written. This indicates a bug in the merge logic (or another code path) producing more than one record for the same stable id, not a normal rejection.`
      );
    }
  }
}

// GET /api/platform-state — returns { data, updated_at } (updated_at also
// serves as the revision token for optimistic-concurrency checks on PUT).
router.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await query(
      'SELECT data, updated_at FROM platform_state WHERE id = 1'
    );

    if (result.rowCount === 0) {
      await query(
        `INSERT INTO platform_state (id, data)
         VALUES (1, '{}'::jsonb)
         ON CONFLICT (id) DO NOTHING`
      );
      res.json({ data: {}, updated_at: null });
      return;
    }

    const row = result.rows[0];
    res.json({ data: row.data ?? {}, updated_at: row.updated_at });
  } catch (err) {
    console.error('GET /api/platform-state failed:', err);
    res.status(500).json({ error: 'Failed to load platform state' });
  }
});

// PUT /api/platform-state — body: { data: <any-json> }
router.put('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const body = req.body || {};
  if (!('data' in body)) {
    res.status(400).json({ error: 'Request body must include "data"' });
    return;
  }

  const auditMeta = {
    ts: new Date().toISOString(),
    userId: req.user?.id ?? null,
    userRole: req.user?.role ?? null,
  };

  const client = await pool.connect();
  try {
    const data = { ...(body.data || {}) };

    // Legacy fields from pre-2026-08-20 clients — accepted (so an old
    // cached tab never gets a hard error) and stripped, but never acted on.
    // See resolveDeletedIds()'s header comment for why they no longer
    // influence deletion.
    delete data._knownCreditNoteIds;
    delete data._knownSectionIds;

    // New, explicit deletion signal (2026-08-20 hardening).
    const explicitDeletedIds: Record<string, any[]> | null =
      (data._deletedIds && typeof data._deletedIds === 'object' && !Array.isArray(data._deletedIds))
        ? data._deletedIds
        : null;
    delete data._deletedIds;

    const baseRevision: string | null = typeof data._baseRevision === 'string' ? data._baseRevision : null;
    delete data._baseRevision;

    const isPartial = data._partial === true;
    delete data._partial;

    await client.query('BEGIN');

    const existingRes = await client.query(
      'SELECT data, updated_at FROM platform_state WHERE id = 1 FOR UPDATE'
    );
    const existingData: Record<string, any> | null = existingRes.rowCount ? (existingRes.rows[0].data || {}) : null;
    const existingUpdatedAt: string | null = existingRes.rowCount ? existingRes.rows[0].updated_at : null;

    // ── Resolve explicit deletions PER SECTION now (needed for both the
    //    merge below and the revision-conflict decision). ─────────────────
    const resolvedDeletedIdsBySection: Record<string, Set<string>> = {};
    for (const key of PROTECTED_SECTIONS) {
      if (!Array.isArray(data[key])) continue;
      resolvedDeletedIdsBySection[key] = resolveDeletedIds(key, explicitDeletedIds);
    }
    const anyExplicitDeletion = Object.values(resolvedDeletedIdsBySection).some((s) => s.size > 0);
    const totalDeleteCount = Object.values(resolvedDeletedIdsBySection).reduce((n, s) => n + s.size, 0);

    // ── Union-merge every protected section present in this save
    //    (2026-08-20 hardening — replaces the old separate creditNotes
    //    block and MERGE_SECTIONS loop with one explicit-delete-aware
    //    formula; see header comment for the full rationale).
    //
    //    2026-08-20 POST-DEPLOY FIX: this merge now runs BEFORE detectWipe()
    //    (previously it ran after). detectWipe() must judge what will
    //    ACTUALLY be persisted, not the raw pre-merge payload — otherwise a
    //    genuinely safe, purely-additive partial save (e.g. `{jobs:
    //    [oneEditedJob], _partial:true}`, exactly what savePartialSectionsNow
    //    is documented to send) looks like a catastrophic wipe to detectWipe
    //    even though the merge immediately below would have preserved every
    //    untouched record. Confirmed reproducible: a 2-job additive partial
    //    save against a 92-job baseline was rejected with "would drop from
    //    92 record(s) to 2 (over 80% loss)" even though the post-merge
    //    result is a full, correct 92-job set. See
    //    backend/test/hardening.stress.ts Scenarios J–K for the regression
    //    coverage this closes (100+ server jobs / company-filtered view /
    //    status-filtered view all editing safely; explicit deletion and the
    //    wipe guard itself remain fully enforced). ─────────────────────────
    for (const key of PROTECTED_SECTIONS) {
      if (!Array.isArray(data[key])) continue; // section not part of this save — leave untouched
      const incoming = data[key];
      const existingList = arr(existingData && existingData[key]);
      if (existingList.length === 0) continue; // nothing live to protect for this section

      const idsOk = incoming.every((x: any) => x && x.id !== undefined && x.id !== null)
                 && existingList.every((x: any) => x && x.id !== undefined && x.id !== null);
      if (!idsOk) continue; // cannot safely id-merge — saved as sent, no extra protection this time

      const incomingIds = idsOf(incoming);
      const deleted = resolvedDeletedIdsBySection[key] || new Set<string>();
      // 2026-08-20 POST-DEPLOY FIX #2 (duplication incident): `incomingIds`
      // is a Set<string> (idsOf() stringifies every id). This filter used to
      // test `!incomingIds.has(x.id)` — comparing the SET's string keys
      // against `x.id` in its RAW type. When ids are JS numbers (they are —
      // job/quote/etc ids are `Date.now()`-style numeric values), a number
      // never strict-equals its own string form (`1786972817796 !==
      // "1786972817796"`), so `.has(x.id)` was FALSE for every existing
      // record — even ones genuinely present in `incoming` — and the "not
      // already in incoming" filter therefore kept EVERY existing record,
      // every time. A normal full-state save (existing ids === incoming
      // ids) produced `data[key] = [...incoming(111), ...preserved(111)]` =
      // 222 records, each id duplicated exactly once — precisely the
      // production incident (222 jobs / 111 unique ids / 111 exact-duplicate
      // pairs). Fix: stringify `x.id` the same way `incomingIds` was built,
      // so both sides of the comparison use the same type.
      const preserved = existingList.filter((x: any) => x && !incomingIds.has(String(x.id)) && !deleted.has(String(x.id)));
      if (preserved.length) {
        data[key] = [...incoming, ...preserved];
      }
      // else: nothing to add back — incoming already covers everything that survives
    }

    const finalData = isPartial ? { ...(existingData || {}), ...data } : data;

    // ── Save protection: block obvious wipe/partial/empty saves ──────────
    // Evaluates `finalData` (POST-merge) rather than the raw incoming `data`
    // — see the fix note on the merge loop above for why. For a section that
    // could NOT be safely id-merged above (missing ids) or had nothing
    // existing to protect, finalData[key] is identical to the raw incoming
    // array, so this guard's behavior for those cases — the scenarios it was
    // originally written for — is completely unchanged; it only becomes more
    // accurate for the normal, id-mergeable case.
    const wipeReason = detectWipe(existingData, finalData, isPartial);
    if (wipeReason) {
      await client.query('ROLLBACK');
      console.warn(`[platform-state] BLOCKED (wipe guard) ts=${auditMeta.ts} user=${auditMeta.userId ?? '—'} role=${auditMeta.userRole ?? '—'} reason="${wipeReason}"`);
      res.status(409).json({
        error: 'Save blocked to protect existing data',
        reason: wipeReason,
      });
      return;
    }

    // ── Revision / optimistic-concurrency check (2026-08-20 hardening,
    //    Part 4) — scoped ONLY to saves that carry an explicit deletion.
    //    Additive-only saves can never destroy data (see merge above) so
    //    they are never blocked here, regardless of revision drift — this
    //    keeps ordinary concurrent work from ever hitting a conflict loop.
    if (anyExplicitDeletion && baseRevision && existingUpdatedAt) {
      const serverRevision = new Date(existingUpdatedAt).toISOString();
      const clientRevision = new Date(baseRevision).toISOString();
      if (serverRevision !== clientRevision) {
        await client.query('ROLLBACK');
        console.warn(`[platform-state] BLOCKED (stale revision, ${totalDeleteCount} pending delete(s)) ts=${auditMeta.ts} user=${auditMeta.userId ?? '—'} serverRevision=${serverRevision} yourRevision=${clientRevision}`);
        res.status(409).json({
          conflict: true,
          type: 'stale_revision',
          error: 'Server state has changed since your last sync — refresh and retry before deleting records.',
          serverRevision,
          yourRevision: clientRevision,
        });
        return;
      }
    }

    // ── Backup-before-save: snapshot whatever is currently live BEFORE it is
    //    overwritten. If this fails, the whole PUT fails safely.
    if (existingData !== null) {
      try {
        const serialized = JSON.stringify(existingData);
        const recordCounts = JSON.stringify(buildRecordCounts(existingData));
        const source = (req.get('x-signacore-client') || req.get('user-agent') || null);
        await client.query(
          `INSERT INTO platform_state_backups (data, reason, data_size_bytes, record_counts, source)
           VALUES ($1::jsonb, 'before-put', $2, $3::jsonb, $4)`,
          [serialized, Buffer.byteLength(serialized, 'utf8'), recordCounts, source]
        );
      } catch (backupErr) {
        await client.query('ROLLBACK').catch(() => undefined);
        console.error('PUT /api/platform-state: backup-before-save FAILED — aborting save to protect existing data:', backupErr);
        res.status(500).json({ error: 'Backup failed — save aborted to protect existing data' });
        return;
      }

      try {
        await client.query(
          `DELETE FROM platform_state_backups
           WHERE id IN (
             SELECT id FROM platform_state_backups
             ORDER BY created_at DESC
             OFFSET 100
           )`
        );
      } catch (pruneErr) {
        console.warn('platform_state_backups retention prune skipped:', pruneErr);
      }
    }

    // ── Mechanical backstop — proves the merge above did what it claims.
    try {
      assertNoUnexplainedRemovals(existingData, finalData, resolvedDeletedIdsBySection);
      assertNoDuplicateIds(finalData);
    } catch (backstopErr) {
      await client.query('ROLLBACK').catch(() => undefined);
      console.error(`[platform-state] SAFETY BACKSTOP TRIPPED ts=${auditMeta.ts} user=${auditMeta.userId ?? '—'}:`, backstopErr);
      res.status(500).json({ error: 'Save aborted by internal safety check — no data was changed. Please report this.' });
      return;
    }

    // ── Block NEW invariant violations only — never touches or rejects
    //    anything already true before this save.
    const newRecordError = newRecordValidationError(existingData, finalData);
    if (newRecordError) {
      await client.query('ROLLBACK');
      console.warn(`[platform-state] BLOCKED (invariant) ts=${auditMeta.ts} user=${auditMeta.userId ?? '—'} reason="${newRecordError}"`);
      res.status(409).json({
        error: 'Save blocked to prevent a new data-integrity problem',
        reason: newRecordError,
      });
      return;
    }

    const writeRes = await client.query(
      `INSERT INTO platform_state (id, data, updated_at)
       VALUES (1, $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE
         SET data = EXCLUDED.data,
             updated_at = NOW()
       RETURNING updated_at`,
      [JSON.stringify(finalData)]
    );

    await client.query('COMMIT');

    // ── Audit log (Part 17) — structured, no sensitive payload content. ──
    const sectionsSent = STATE_ARRAY_KEYS.filter((k) => Array.isArray(data[k]));
    console.log(
      `[platform-state] SAVED ts=${auditMeta.ts} user=${auditMeta.userId ?? '—'} role=${auditMeta.userRole ?? '—'} ` +
      `revision=${writeRes.rows[0].updated_at} partial=${isPartial} sections=[${sectionsSent.join(',')}] ` +
      `counts=${JSON.stringify(buildRecordCounts(finalData))} deletes=${totalDeleteCount}`
    );

    res.json({ success: true, data: finalData, revision: writeRes.rows[0].updated_at });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('PUT /api/platform-state failed:', err);
    res.status(500).json({ error: 'Failed to save platform state' });
  } finally {
    client.release();
  }
});

export default router;
