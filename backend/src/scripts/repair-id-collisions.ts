/**
 * repair-id-collisions.ts — MANUAL repair of duplicate record ids in
 * platform_state `customers` and `quickRates` (2026-11-23).
 *
 * THE PROBLEM
 *   Older bulk imports gave records `Date.now()+Math.random()` ids, a float
 *   with only ~4,096 distinct values per millisecond, so several DIFFERENT
 *   records ended up sharing one id (live, 23 Nov: customers 1 id × 2 records,
 *   quickRates 27 ids × 55 records). The server's stable-id merge cannot tell
 *   such records apart, so none of them can be edited and saved, the
 *   relational backfill quarantines them, and the integration API's
 *   get-by-id returns only the first of them.
 *
 * WHAT IT DOES
 *   For every collision group (one id, 2+ records in the same section) it
 *   KEEPS every record and all of its data exactly as it is and gives a new,
 *   unique integer id to every copy except one ("keeper"), which keeps the
 *   current id. Nothing is merged, deleted or reordered.
 *
 * REFERENCES — who points at a colliding id, and to which copy
 *   Scanned in one consistent snapshot:
 *     platform_state  every value equal to the id anywhere in the data blob
 *                     (any section, any depth; record `id` keys excluded)
 *     rel_customers / rel_quick_rate_items rows with that source_id
 *     integration_records (Sally ownership mappings, record_type customer)
 *     integration_idempotency stored responses that contain the id
 *     integration_audit get/update/product calls that targeted the id
 *     informational only: relational_legacy_conflicts quarantine rows,
 *       rel_* legacy_data snapshots that mention the id, rel_* rows linked
 *       by primary key, and Sally list/search calls.
 *   A reference is tied to a copy only on reliable evidence: a relational or
 *   stored record whose fields (or, failing that, whose name) match exactly
 *   ONE copy; a platform_state reference whose own record names exactly ONE
 *   copy; an API call by id, which always resolves to the FIRST copy
 *   (customer.get, product.get, quote drafts). Anything else is AMBIGUOUS:
 *   the group is reported and left UNAPPLIED.
 *   Keeper = the copy the references belong to (the first copy when there
 *   are none). If references belong to more than one copy, the other copies'
 *   references are rewritten to their new id, but only for kinds that can be
 *   rewritten (a platform_state value, a rel_* source_id); a Sally mapping,
 *   stored response or API call tied to another copy leaves the group
 *   unapplied (the external system would keep the old id).
 *
 * MODES (from backend\, DATABASE_URL set)
 *   --diagnose                                       groups and references only
 *   (no flag)                                        DRY RUN: the full plan + its fingerprint
 *   --apply --confirm="REPAIR <n> DUPLICATE IDS" --expect=<fingerprint>
 *   options: --connect-timeout=SECONDS (5-300, default 30)  --lock-timeout=SECONDS (default 15)
 *
 * APPLY (one transaction; any failure rolls back everything)
 *   1. locks platform_state (FOR UPDATE) and every referenced row;
 *   2. rebuilds the plan from the locked data and refuses unless its
 *      fingerprint equals --expect (the dry run you reviewed): if any record
 *      in a group or any reference changed, nothing is written;
 *   3. backs up the whole platform_state row (server-side copy, exact) and the
 *      plan into platform_state_backups, and writes the plan to a local file
 *      id-collision-repair-<time>.json (the server keeps only the newest 100
 *      backup rows, so keep that file);
 *   4. sets each new id with jsonb_set at its exact path, checking the old id
 *      is still there (no other byte of platform_state changes), plus
 *      _autoSavedAt and updated_at so every open dashboard sees the change;
 *   5. re-reads and verifies: platform_state equals the plan exactly, every
 *      repaired record is identical apart from its id, no repaired id
 *      collides; then commits.
 *   Running it again finds nothing left to repair (or only the groups that
 *   were left unapplied).
 *
 * SAFETY: DATABASE_URL only, never printed (errors are scrubbed); dedicated
 *   connection (30 s connect limit, keep-alive, 3 attempts, SSL as
 *   db/ssl.ts), as in record-cancelled-invoice.ts; not run by npm start /
 *   migrate / build.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Client } from 'pg';
import { resolveSsl, describeConnectionError } from '../db/ssl';

export type Section = 'customers' | 'quickRates';
export const SECTIONS: Section[] = ['customers', 'quickRates'];
const REL_TABLE: Record<Section, string> = { customers: 'rel_customers', quickRates: 'rel_quick_rate_items' };
const REASON = 'before-repair-id-collisions-2026-11-23';

export type RefKind = 'platform_state' | 'rel_row' | 'integration_record' | 'integration_idempotency' | 'integration_audit';
export interface Ref {
  kind: RefKind; where: string; detail: string;
  owner: number | null;        // position in group.copies; null = ambiguous
  evidence: string;
  rewritable: boolean;
  locator: any;                // what to change if it must be rewritten
}
export interface Info { kind: string; where: string; detail: string }
export interface Copy { index: number; record: any; hash: string; label: string }
export interface Group {
  section: Section; id: string; copies: Copy[]; refs: Ref[]; info: Info[];
  identicalCopies: boolean;
  status: 'apply' | 'skip'; reason: string; keeper: number;
  newIds: Record<number, number>;            // copy position -> new id
  rewrites: { ref: Ref; newId: number }[];   // references moved with their copy
}
export interface Snapshot {
  data: Record<string, any>;
  relRows: Record<Section, any[]>;
  relSourceIds: Record<Section, string[]>;
  conflicts: { collection: string; source_id: string; detected_at?: any }[];
  intRecords: { id: string; client_id: string; record_id: string; idempotency_key: string | null; external_ref: string | null }[];
  intIdem: { client_id: string; idempotency_key: string; operation: string; response_body: any }[];
  intAudit: { client_id: string; operation: string; target_type: string; target_id: string; n: number; last: any }[];
  intExposure: { client_id: string; operation: string; n: number; last: any }[];
  legacyMentions: { table: string; id: string; n: number }[];
  relFk: { table: string; rel_id: string; n: number }[];
}
export interface Plan { groups: Group[]; fingerprint: string; reIdCount: number; confirm: string }

export function stable(v: any): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}
const sha = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const norm = (v: unknown): string => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase();
const withoutId = (r: any): any => { const { id: _drop, ...rest } = r || {}; return rest; };
export function contentHash(r: any): string { return sha(stable(withoutId(r))).slice(0, 16); }
const idRe = (id: string): RegExp => new RegExp('(^|[^0-9.])' + id.replace(/\./g, '\\.') + '([^0-9]|$)');
function names(section: Section, r: any): string[] {
  const out = section === 'customers' ? [r && r.companyName, r && r.contactPerson] : [r && r.name];
  return out.map(norm).filter(Boolean);
}
function label(section: Section, r: any): string {
  const t = section === 'customers' ? [r.companyName, r.contactPerson].filter(Boolean).join(' · ') : [r.name, r.sku ? '[' + r.sku + ']' : ''].filter(Boolean).join(' ');
  return String(t || '(no name)').slice(0, 70);
}
function copiesNamed(section: Section, copies: Copy[], candidates: unknown[]): number[] {
  const want = new Set(candidates.map(norm).filter(Boolean));
  const hit: number[] = [];
  copies.forEach((c, pos) => { if (names(section, c.record).some((n) => want.has(n))) hit.push(pos); });
  return hit;
}
const NAME_KEYS = ['client', 'customer', 'customerName', 'companyName', 'company', 'contactName', 'contact', 'contactPerson', 'name', 'desc', 'description'];

/** Collision groups in one section, in array order. */
export function collisionGroups(section: Section, list: any[]): Map<string, Copy[]> {
  const by = new Map<string, Copy[]>();
  (list || []).forEach((r, index) => {
    if (!r || typeof r !== 'object' || r.id === undefined || r.id === null) return;
    const k = String(r.id); const g = by.get(k) || []; g.push({ index, record: r, hash: contentHash(r), label: label(section, r) }); by.set(k, g);
  });
  for (const [k, g] of [...by.entries()]) if (g.length < 2) by.delete(k);
  return by;
}

interface PsHit { path: (string | number)[]; type: 'number' | 'string'; container: any; key: string; referenceKey: boolean }
// A value is a REFERENCE when its key names a link (customerId, itemId,
// qrRef, client, source, …). An equal value under any other key (a price,
// a stock count, a job value) is reported as a coincidence, never as a link.
export const REFERENCE_KEY_RE = /id|ref|key|customer|client|rate|item|source|link|parent|target|owner/i;
/** Every value in platform_state equal to one of `ids` (record `id` keys excluded). */
export function scanPlatformState(data: any, ids: Set<string>): Map<string, PsHit[]> {
  const out = new Map<string, PsHit[]>();
  const walk = (v: any, p: (string | number)[], container: any, key: string): void => {
    if (v === null || v === undefined) return;
    if (typeof v === 'object') {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...p, i], v, key));
      else for (const k of Object.keys(v)) { if (k === 'id') continue; walk(v[k], [...p, k], v, k); }
      return;
    }
    if (!p.length) return;
    let s: string | null = null; let type: 'number' | 'string' = 'string';
    if (typeof v === 'number') { s = String(v); type = 'number'; } else if (typeof v === 'string') s = v.trim();
    if (s !== null && ids.has(s)) { const l = out.get(s) || []; l.push({ path: p, type, container, key, referenceKey: REFERENCE_KEY_RE.test(key) }); out.set(s, l); }
  };
  walk(data, [], null, '');
  return out;
}

/** The plan. Pure: decides everything from one snapshot; writes nothing. */
export function buildPlan(snap: Snapshot): Plan {
  const groups: Group[] = [];
  const allIds = new Set<string>();
  const bySection: Record<Section, Map<string, Copy[]>> = { customers: new Map(), quickRates: new Map() };
  for (const s of SECTIONS) { bySection[s] = collisionGroups(s, Array.isArray(snap.data[s]) ? snap.data[s] : []); for (const id of bySection[s].keys()) allIds.add(id); }
  const psHits = scanPlatformState(snap.data, allIds);

  for (const section of SECTIONS) {
    for (const [id, copies] of bySection[section]) {
      const refs: Ref[] = []; const info: Info[] = [];
      for (const h of psHits.get(id) || []) {
        if (!h.referenceKey) { info.push({ kind: 'coincidence', where: 'platform_state.' + h.path.join('.'), detail: `equal value under "${h.key}", which is not a link field — treated as a coincidence, left unchanged` }); continue; }
        const cand: unknown[] = [];
        if (h.container && typeof h.container === 'object' && !Array.isArray(h.container)) for (const k of NAME_KEYS) if (typeof h.container[k] === 'string') cand.push(h.container[k]);
        const hit = copiesNamed(section, copies, cand);
        refs.push({ kind: 'platform_state', where: 'platform_state.' + h.path.join('.'), detail: `${h.type} value`, owner: hit.length === 1 ? hit[0] : null,
          evidence: hit.length === 1 ? `its record names "${copies[hit[0]].label}"` : hit.length ? 'its record names more than one copy' : 'its record names none of the copies',
          rewritable: true, locator: { path: h.path, type: h.type } });
      }
      for (const row of snap.relRows[section].filter((r) => String(r.source_id) === id)) {
        const full = copies.map((c, pos) => ({ pos, eq: section === 'customers'
          ? norm(row.company_name) === norm(c.record.companyName) && norm(row.contact_person) === norm(c.record.contactPerson) && norm(row.email) === norm(c.record.email)
            && norm(row.phone) === norm(c.record.tel ?? c.record.phone) && norm(row.address) === norm(c.record.address) && norm(row.vat_number) === norm(c.record.vatNumber)
          : norm(row.name) === norm(c.record.name) && norm(row.sku) === norm(c.record.sku) && norm(row.unit) === norm(c.record.unit)
            && Number(row.sell) === Number(c.record.sell || 0) && Number(row.cost) === Number(c.record.cost || 0) })).filter((x) => x.eq).map((x) => x.pos);
        const byName = copiesNamed(section, copies, [section === 'customers' ? row.company_name : row.name]);
        const owner = full.length === 1 ? full[0] : (full.length === 0 && byName.length === 1 ? byName[0] : null);
        refs.push({ kind: 'rel_row', where: `${REL_TABLE[section]} id ${row.id}`, detail: `source_id ${row.source_id}, "${String(section === 'customers' ? row.company_name : row.name).slice(0, 50)}"`, owner,
          evidence: owner === null ? (full.length > 1 ? 'its fields match more than one copy' : 'its fields and name match no single copy') : (full.length === 1 ? 'all its fields match' : 'its name matches'),
          rewritable: true, locator: { table: REL_TABLE[section], relId: String(row.id), rowVersion: row.row_version } });
        for (const fk of snap.relFk.filter((f) => f.rel_id === String(row.id))) info.push({ kind: 'rel_fk', where: fk.table, detail: `${fk.n} row(s) link to ${REL_TABLE[section]} id ${row.id} by primary key — they follow that row, not the JSON id` });
      }
      if (section === 'customers') {
        for (const ir of snap.intRecords.filter((r) => String(r.record_id) === id)) {
          const idem = snap.intIdem.find((x) => x.client_id === ir.client_id && x.idempotency_key === ir.idempotency_key);
          const body = idem && idem.response_body ? (idem.response_body.customer || idem.response_body) : null;
          const hit = body ? copiesNamed(section, copies, [body.companyName, body.contactPerson]) : [];
          refs.push({ kind: 'integration_record', where: `integration_records id ${ir.id}`, detail: `client ${ir.client_id}${ir.external_ref ? ', ref ' + ir.external_ref : ''}`, owner: hit.length === 1 ? hit[0] : null,
            evidence: hit.length === 1 ? 'the stored create response names this copy' : 'no stored response names exactly one copy', rewritable: false, locator: null });
        }
      }
      for (const idem of snap.intIdem) {
        if (!idRe(id).test(JSON.stringify(idem.response_body || null))) continue;
        const body = idem.response_body || {}; const rec = body.customer || body.product || body;
        const hit = copiesNamed(section, copies, [rec.companyName, rec.contactPerson, rec.name]);
        refs.push({ kind: 'integration_idempotency', where: `integration_idempotency ${idem.client_id}/${idem.idempotency_key}`, detail: `stored ${idem.operation} response`, owner: hit.length === 1 ? hit[0] : null,
          evidence: hit.length === 1 ? 'the stored response names this copy' : 'the stored response names no single copy', rewritable: false, locator: null });
      }
      const target = section === 'customers' ? { t: 'customer', v: id } : { t: 'product', v: 'qr:' + id };
      for (const a of snap.intAudit.filter((x) => x.target_type === target.t && x.target_id === target.v)) {
        refs.push({ kind: 'integration_audit', where: `integration_audit ${a.client_id} ${a.operation}`, detail: `${a.n} call(s), last ${a.last ? new Date(a.last).toISOString().slice(0, 10) : '?'}`, owner: 0,
          evidence: 'an id lookup returns the FIRST record with that id', rewritable: false, locator: null });
      }
      if (snap.conflicts.some((x) => x.collection === section && String(x.source_id) === id)) info.push({ kind: 'quarantine', where: 'relational_legacy_conflicts', detail: 'the backfill quarantined this id (history only; a later backfill imports the repaired records)' });
      for (const m of snap.legacyMentions.filter((x) => x.id === id)) info.push({ kind: 'legacy_snapshot', where: m.table + '.legacy_data', detail: `${m.n} frozen backfill snapshot(s) mention the id; not used for linking, left unchanged` });

      const g: Group = { section, id, copies, refs, info, identicalCopies: new Set(copies.map((c) => c.hash)).size < copies.length,
        status: 'apply', reason: '', keeper: 0, newIds: {}, rewrites: [] };
      const ambiguous = refs.filter((r) => r.owner === null);
      const owners = [...new Set(refs.filter((r) => r.owner !== null).map((r) => r.owner as number))].sort((a, b) => a - b);
      if (ambiguous.length) { g.status = 'skip'; g.reason = `${ambiguous.length} reference(s) cannot be tied to one copy`; }
      else {
        g.keeper = owners.length ? owners[0] : 0;
        const fixed = refs.filter((r) => r.owner !== null && r.owner !== g.keeper && !r.rewritable);
        if (fixed.length) { g.status = 'skip'; g.reason = `references belong to more than one copy and ${fixed.length} of them cannot be rewritten (${[...new Set(fixed.map((r) => r.kind))].join(', ')})`; }
        else g.reason = owners.length ? `keeper = copy ${g.keeper + 1} (the copy the references belong to)` : 'no references — keeper = copy 1 (what every id lookup returns today)';
      }
      groups.push(g);
    }
  }
  // New ids: above every id this section, its relational table, the quarantine
  // log and (customers) the integration mappings/audit have ever used.
  for (const section of SECTIONS) {
    const nums: number[] = [];
    const add = (v: any) => { const n = Number(String(v).replace(/^qr:/, '')); if (Number.isFinite(n)) nums.push(n); };
    for (const r of (Array.isArray(snap.data[section]) ? snap.data[section] : [])) if (r && r.id != null) add(r.id);
    snap.relSourceIds[section].forEach(add);
    snap.conflicts.filter((c) => c.collection === section).forEach((c) => add(c.source_id));
    if (section === 'customers') { snap.intRecords.forEach((r) => add(r.record_id)); snap.intAudit.filter((a) => a.target_type === 'customer').forEach((a) => add(a.target_id)); }
    else snap.intAudit.filter((a) => a.target_type === 'product' && /^qr:/.test(a.target_id)).forEach((a) => add(a.target_id));
    let next = Math.floor(Math.max(0, ...nums)) + 1;
    for (const g of groups.filter((x) => x.section === section && x.status === 'apply').sort((a, b) => a.copies[0].index - b.copies[0].index)) {
      g.copies.forEach((_c, pos) => { if (pos !== g.keeper) g.newIds[pos] = next++; });
      for (const r of g.refs) if (r.owner !== null && r.owner !== g.keeper) g.rewrites.push({ ref: r, newId: g.newIds[r.owner] });
    }
    if (!Number.isSafeInteger(next)) throw new Error(`${section}: a new id would exceed the safe integer range — nothing allocated.`);
  }
  const basis = groups.map((g) => ({ s: g.section, id: g.id, st: g.status, k: g.keeper,
    c: g.copies.map((c) => [c.index, c.hash]), r: g.refs.map((r) => [r.kind, r.where, r.kind === 'integration_audit' ? '' : r.detail, r.owner, r.rewritable]) })); // call counts may grow; ownership does not
  const reIdCount = groups.filter((g) => g.status === 'apply').reduce((n, g) => n + g.copies.length - 1, 0);
  return { groups, fingerprint: sha(stable(basis)).slice(0, 16), reIdCount, confirm: `REPAIR ${reIdCount} DUPLICATE IDS` };
}

// ── database reads ─────────────────────────────────────────────────────────
type Q = { query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
async function exists(q: Q, table: string): Promise<boolean> { return !!(await q.query('SELECT to_regclass($1) AS t', [table])).rows[0].t; }

/** One consistent read of everything the plan needs (rows locked when `lock`). */
export async function readSnapshot(q: Q, lock: boolean): Promise<Snapshot> {
  const upd = lock ? ' FOR UPDATE' : '';
  const ps = await q.query(`SELECT data FROM platform_state WHERE id = 1${upd}`);
  if (!ps.rowCount) throw new Error('platform_state row 1 not found — nothing to do.');
  const data = ps.rows[0].data || {};
  const ids: Record<Section, string[]> = { customers: [], quickRates: [] };
  for (const s of SECTIONS) ids[s] = [...collisionGroups(s, Array.isArray(data[s]) ? data[s] : []).keys()];
  const all = [...ids.customers, ...ids.quickRates];
  const snap: Snapshot = { data, relRows: { customers: [], quickRates: [] }, relSourceIds: { customers: [], quickRates: [] }, conflicts: [], intRecords: [], intIdem: [], intAudit: [], intExposure: [], legacyMentions: [], relFk: [] };
  if (await exists(q, 'rel_customers')) {
    snap.relRows.customers = (await q.query(`SELECT id::text AS id, source_id, row_version, company_name, contact_person, email, phone, address, vat_number FROM rel_customers WHERE source_id = ANY($1)${upd}`, [ids.customers])).rows;
    snap.relSourceIds.customers = (await q.query('SELECT source_id FROM rel_customers')).rows.map((r) => r.source_id);
  }
  if (await exists(q, 'rel_quick_rate_items')) {
    snap.relRows.quickRates = (await q.query(`SELECT id::text AS id, source_id, row_version, sku, name, category, unit, cost, sell FROM rel_quick_rate_items WHERE source_id = ANY($1)${upd}`, [ids.quickRates])).rows;
    snap.relSourceIds.quickRates = (await q.query('SELECT source_id FROM rel_quick_rate_items')).rows.map((r) => r.source_id);
  }
  const relIds = snap.relRows.customers.map((r) => r.id);
  if (relIds.length) for (const t of ['rel_quotes', 'rel_jobs', 'rel_invoices', 'rel_credit_notes']) {
    if (!(await exists(q, t))) continue;
    for (const r of (await q.query(`SELECT customer_id::text AS rel_id, COUNT(*)::int AS n FROM ${t} WHERE customer_id = ANY($1::bigint[]) GROUP BY customer_id`, [relIds])).rows) snap.relFk.push({ table: t, rel_id: r.rel_id, n: r.n });
  }
  if (await exists(q, 'relational_legacy_conflicts')) snap.conflicts = (await q.query(`SELECT collection, source_id, detected_at FROM relational_legacy_conflicts WHERE collection IN ('customers','quickRates')`)).rows;
  if (await exists(q, 'integration_records')) snap.intRecords = (await q.query(`SELECT id::text AS id, client_id, record_id::text AS record_id, idempotency_key, external_ref FROM integration_records WHERE record_type = 'customer'${upd}`)).rows;
  if (all.length && await exists(q, 'integration_idempotency')) {
    const keys = snap.intRecords.filter((r) => ids.customers.includes(String(r.record_id))).map((r) => r.client_id + '\u0001' + r.idempotency_key);
    snap.intIdem = (await q.query(
      `SELECT client_id, idempotency_key, operation, response_body FROM integration_idempotency
        WHERE state = 'completed' AND response_body IS NOT NULL AND (response_body::text LIKE ANY($1) OR (client_id || chr(1) || idempotency_key) = ANY($2))`,
      [all.map((i) => '%' + i + '%'), keys])).rows;
  }
  if (await exists(q, 'integration_audit')) {
    snap.intAudit = (await q.query(
      `SELECT client_id, operation, target_type, target_id, COUNT(*)::int AS n, MAX(created_at) AS last FROM integration_audit
        WHERE (target_type = 'customer' AND (target_id = ANY($1) OR target_id ~ '^[0-9]+$')) OR (target_type = 'product' AND target_id LIKE 'qr:%')
        GROUP BY 1,2,3,4`, [ids.customers])).rows;
    snap.intExposure = (await q.query(`SELECT client_id, operation, COUNT(*)::int AS n, MAX(created_at) AS last FROM integration_audit WHERE operation IN ('customer.search','read.customers','product.search') GROUP BY 1,2 ORDER BY 1,2`)).rows;
  }
  if (all.length) {
    const re = '(^|[^0-9.])(' + all.map((i) => i.replace(/\./g, '\\.')).join('|') + ')([^0-9]|$)';
    for (const t of ['rel_quotes', 'rel_quote_line_items', 'rel_jobs', 'rel_job_line_items', 'rel_invoices', 'rel_invoice_line_items', 'rel_credit_notes', 'rel_purchase_orders', 'rel_purchase_order_items', 'rel_customers', 'rel_quick_rate_items', 'rel_inventory_items']) {
      if (!(await exists(q, t))) continue;
      const rows = (await q.query(`SELECT legacy_data::text AS t FROM ${t} WHERE legacy_data::text ~ $1`, [re])).rows;
      for (const id of all) { const n = rows.filter((r) => idRe(id).test(r.t)).length; if (n) snap.legacyMentions.push({ table: t, id, n }); }
    }
  }
  return snap;
}

// ── output ─────────────────────────────────────────────────────────────────
const log = (s = ''): void => console.log(s);
export function printPlan(plan: Plan, snap: Snapshot, mode: 'diagnose' | 'dry-run' | 'apply'): void {
  for (const s of SECTIONS) {
    const gs = plan.groups.filter((g) => g.section === s);
    log(`${s}: ${Array.isArray(snap.data[s]) ? snap.data[s].length : 0} records, ${gs.length} duplicated id(s) covering ${gs.reduce((n, g) => n + g.copies.length, 0)} records`);
  }
  for (const g of plan.groups) {
    log('');
    log(`[${g.section}] id ${g.id} × ${g.copies.length}${g.identicalCopies ? '   (some copies are IDENTICAL — all are kept; delete extras in the dashboard if wanted)' : ''}`);
    g.copies.forEach((c, pos) => {
      const act = mode === 'diagnose' ? '' : g.status !== 'apply' ? '  (unchanged)' : pos === g.keeper ? '  KEEPS id ' + g.id : `  -> new id ${g.newIds[pos]}`;
      log(`   copy ${pos + 1}  [position ${c.index}]  "${c.label}"  content ${c.hash}${act}`);
    });
    if (!g.refs.length) log('   references: none');
    for (const r of g.refs) log(`   reference: ${r.where} (${r.detail}) -> ${r.owner === null ? 'AMBIGUOUS' : 'copy ' + (r.owner + 1)} — ${r.evidence}`);
    for (const i of g.info) log(`   note: ${i.where} — ${i.detail}`);
    if (mode !== 'diagnose') for (const w of g.rewrites) log(`   rewrite: ${w.ref.where} -> ${w.newId}`);
    if (mode !== 'diagnose') log(`   ${g.status === 'apply' ? 'APPLY' : 'LEFT UNAPPLIED'}: ${g.reason}`);
  }
  if (snap.intExposure.length) {
    log('');
    log('Integration list/search calls (they can show every copy of a duplicated id; nothing records which one a client kept):');
    for (const e of snap.intExposure) log(`   ${e.client_id} ${e.operation}: ${e.n} call(s), last ${e.last ? new Date(e.last).toISOString().slice(0, 10) : '?'}`);
    log('   Every id lookup already returns copy 1, which keeps the id whenever it has no other references.');
  }
}

// ── apply (caller owns BEGIN / COMMIT / ROLLBACK) ──────────────────────────
export async function applyPlan(c: Q, plan: Plan, source: string, localFile: string): Promise<{ backupId: string; planBackupId: string; changed: number }> {
  const apply = plan.groups.filter((g) => g.status === 'apply');
  const before = (await c.query('SELECT data FROM platform_state WHERE id = 1')).rows[0].data;
  // 1. backups: the whole row copied server-side (exact bytes), then the plan.
  const b1 = (await c.query(
    `INSERT INTO platform_state_backups (data, reason, data_size_bytes, record_counts, source)
     SELECT data, $1, octet_length(data::text),
            jsonb_build_object('customers', jsonb_array_length(COALESCE(data->'customers','[]'::jsonb)), 'quickRates', jsonb_array_length(COALESCE(data->'quickRates','[]'::jsonb))), $2
       FROM platform_state WHERE id = 1 RETURNING id::text AS id`, [REASON, source])).rows[0].id;
  const planDoc = {
    case: 'repair duplicate customer / quick-rate ids (2026-11-23)', fingerprint: plan.fingerprint, platformStateBackupId: b1,
    groups: apply.map((g) => ({ section: g.section, id: g.id, keeperPosition: g.copies[g.keeper].index,
      copies: g.copies.map((cp, pos) => ({ position: cp.index, contentHash: cp.hash, record: cp.record, newId: pos === g.keeper ? null : g.newIds[pos] })),
      rewrites: g.rewrites.map((w) => ({ where: w.ref.where, kind: w.ref.kind, oldId: g.id, newId: w.newId, locator: w.ref.locator })) })),
    leftUnapplied: plan.groups.filter((g) => g.status !== 'apply').map((g) => ({ section: g.section, id: g.id, reason: g.reason, references: g.refs.map((r) => ({ where: r.where, owner: r.owner, evidence: r.evidence })) })),
  };
  const ser = JSON.stringify(planDoc);
  const b2 = (await c.query(
    `INSERT INTO platform_state_backups (data, reason, data_size_bytes, record_counts, source) VALUES ($1::jsonb, $2, $3, $4::jsonb, $5) RETURNING id::text AS id`,
    [ser, REASON + ' (plan)', Buffer.byteLength(ser, 'utf8'), JSON.stringify({ groups: apply.length, reIds: plan.reIdCount }), source])).rows[0].id;
  fs.writeFileSync(localFile, JSON.stringify({ ...planDoc, planBackupId: b2, status: 'NOT YET COMMITTED' }, null, 2), 'utf8');

  // 2. each new id at its exact path, only while the old id is still there.
  let changed = 0;
  for (const g of apply) for (const [posStr, newId] of Object.entries(g.newIds)) {
    const cp = g.copies[Number(posStr)];
    const asText = typeof cp.record.id === 'string'; // keep the id's JSON type (number stays number)
    const r = await c.query(`UPDATE platform_state SET data = jsonb_set(data, $1::text[], ${asText ? 'to_jsonb($2::text)' : 'to_jsonb($2::bigint)'}, false) WHERE id = 1 AND data #>> $1::text[] = $3`,
      [[g.section, String(cp.index), 'id'], asText ? String(newId) : newId, g.id]);
    if (r.rowCount !== 1) throw new Error(`${g.section} position ${cp.index} no longer has id ${g.id} — rolled back, nothing written.`);
    changed++;
  }
  // 3. references owned by a copy that got a new id.
  for (const g of apply) for (const w of g.rewrites) {
    const L = w.ref.locator;
    let r: { rowCount?: number | null };
    if (w.ref.kind === 'platform_state') {
      r = await c.query(`UPDATE platform_state SET data = jsonb_set(data, $1::text[], ${L.type === 'number' ? 'to_jsonb($2::bigint)' : 'to_jsonb($2::text)'}, false) WHERE id = 1 AND btrim(data #>> $1::text[]) = $3`,
        [L.path.map(String), L.type === 'number' ? w.newId : String(w.newId), g.id]);
    } else if (w.ref.kind === 'rel_row') {
      r = await c.query(`UPDATE ${L.table === 'rel_customers' ? 'rel_customers' : 'rel_quick_rate_items'} SET source_id = $1, row_version = row_version + 1, updated_at = NOW() WHERE id = $2 AND source_id = $3 AND row_version = $4`,
        [String(w.newId), L.relId, g.id, L.rowVersion]);
    } else throw new Error(`${w.ref.where} cannot be rewritten — rolled back.`);
    if (r.rowCount !== 1) throw new Error(`${w.ref.where} changed since it was read — rolled back, nothing written.`);
  }
  await c.query(`UPDATE platform_state SET data = jsonb_set(data, '{_autoSavedAt}', to_jsonb($1::text), true), updated_at = NOW() WHERE id = 1`, [new Date().toISOString()]);

  // 4. verify, still inside the transaction.
  const after = (await c.query('SELECT data FROM platform_state WHERE id = 1')).rows[0].data;
  const expected = JSON.parse(JSON.stringify(before));
  for (const g of apply) {
    for (const [posStr, newId] of Object.entries(g.newIds)) { const cp = g.copies[Number(posStr)]; expected[g.section][cp.index].id = typeof cp.record.id === 'string' ? String(newId) : newId; }
    for (const w of g.rewrites) if (w.ref.kind === 'platform_state') {
      let o = expected; const p = w.ref.locator.path; for (let i = 0; i < p.length - 1; i++) o = o[p[i]];
      o[p[p.length - 1]] = w.ref.locator.type === 'number' ? w.newId : String(w.newId);
    }
  }
  expected._autoSavedAt = after._autoSavedAt;
  if (stable(expected) !== stable(after)) throw new Error('verification failed: platform_state differs from the plan beyond the repaired ids — rolled back, nothing written.');
  for (const s of SECTIONS) {
    const left = collisionGroups(s, Array.isArray(after[s]) ? after[s] : []);
    for (const g of apply.filter((x) => x.section === s)) for (const cp of g.copies) {
      const now = after[s][cp.index];
      if (contentHash(now) !== cp.hash) throw new Error(`verification failed: ${s} position ${cp.index} changed — rolled back.`);
      if (left.has(String(now.id))) throw new Error(`verification failed: ${s} id ${now.id} still shared — rolled back.`);
    }
  }
  return { backupId: b1, planBackupId: b2, changed };
}

// ── connection (same pattern as record-cancelled-invoice.ts) ───────────────
export function scrub(text: string, url: string | undefined): string {
  let t = String(text);
  if (url) { t = t.split(url).join('<DATABASE_URL>'); try { const u = new URL(url); if (u.password) t = t.split(decodeURIComponent(u.password)).join('***').split(u.password).join('***'); } catch { /* not a URL */ } }
  return t.replace(/postgres(ql)?:\/\/[^\s'"]+/gi, '<connection string>');
}
async function connect(timeoutMs: number, attempts: number): Promise<Client> {
  const url = process.env.DATABASE_URL as string; let last: any = null;
  for (let i = 1; i <= attempts; i++) {
    const client = new Client({ connectionString: url, ssl: resolveSsl(url), connectionTimeoutMillis: timeoutMs, keepAlive: true, keepAliveInitialDelayMillis: 10000 });
    client.on('error', (e) => { console.error('[db] connection error: ' + scrub(e && e.message ? e.message : String(e), url)); });
    const t0 = Date.now();
    try { await client.connect(); log(`connected in ${Date.now() - t0} ms (attempt ${i} of ${attempts}; limit ${Math.round(timeoutMs / 1000)}s)`); return client; }
    catch (err: any) {
      last = err; log(`connection attempt ${i} of ${attempts} failed after ${Date.now() - t0} ms: ${scrub(err && err.message ? err.message : String(err), url)}`);
      await client.end().catch(() => undefined);
      if (i < attempts) await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  throw new Error(`could not connect to the database after ${attempts} attempts (limit ${Math.round(timeoutMs / 1000)}s each).\n   ${scrub(describeConnectionError(last), url)}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (n: string): string | undefined => { const a = argv.find((x) => x.startsWith(n + '=')); return a ? a.slice(n.length + 1) : undefined; };
  const APPLY = argv.includes('--apply'); const DIAG = argv.includes('--diagnose');
  const tSec = Math.min(300, Math.max(5, Number(arg('--connect-timeout')) || 30));
  const lockSec = Math.min(120, Math.max(1, Number(arg('--lock-timeout')) || 15));
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set. In PowerShell:  $env:DATABASE_URL = Read-Host "Render External Database URL"'); process.exitCode = 1; return; }
  if (APPLY && DIAG) { console.error('Use --diagnose or --apply, not both.'); process.exitCode = 1; return; }
  let client: Client | null = null; let inTx = false; let localFile = '';
  try {
    log(`repair-id-collisions — ${APPLY ? 'APPLY' : DIAG ? 'DIAGNOSE (read only)' : 'DRY RUN (read only)'}`);
    client = await connect(tSec * 1000, 3);
    await client.query(APPLY ? 'BEGIN' : 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'); inTx = true;
    await client.query(`SET LOCAL lock_timeout = '${lockSec}s'`);
    await client.query(`SET LOCAL statement_timeout = '120s'`);
    const who = (await client.query(`SELECT current_database() AS db, NOW() AS at, current_setting('transaction_read_only') AS ro`)).rows[0];
    log(`database ${who.db}   at ${new Date(who.at).toISOString()}   transaction_read_only=${who.ro}`);
    log('');
    const snap = await readSnapshot(client, APPLY);
    const plan = buildPlan(snap);
    printPlan(plan, snap, DIAG ? 'diagnose' : APPLY ? 'apply' : 'dry-run');
    log('');
    const nApply = plan.groups.filter((g) => g.status === 'apply').length, nSkip = plan.groups.length - nApply;
    if (!APPLY) {
      await client.query('ROLLBACK'); inTx = false;
      if (!plan.groups.length) { log('Nothing to repair: no duplicated ids in customers or quickRates. Nothing was written.'); return; }
      if (DIAG) { log(`DIAGNOSE — ${plan.groups.length} duplicated id(s). Nothing was written. Run without --diagnose for the repair plan.`); return; }
      log(`DRY RUN — ${nApply} group(s) to repair (${plan.reIdCount} record(s) get a new id), ${nSkip} left unapplied. Nothing was written.`);
      log(`plan fingerprint: ${plan.fingerprint}`);
      if (plan.reIdCount) { log('To apply exactly this plan:'); log(`   npm run repair:id-collisions:compiled -- --apply --confirm="${plan.confirm}" --expect=${plan.fingerprint}`); }
      return;
    }
    if (plan.reIdCount === 0) { await client.query('ROLLBACK'); inTx = false; log(nSkip ? `Nothing to apply — ${nSkip} group(s) are left unapplied (see above). Nothing was written.` : 'Nothing to repair — nothing written.'); return; }
    if (arg('--expect') !== plan.fingerprint) throw new Error(`the data no longer matches the reviewed dry run (fingerprint now ${plan.fingerprint}, --expect=${arg('--expect') || '(missing)'}). Run the dry run again and review it. Nothing written.`);
    if (arg('--confirm') !== plan.confirm) throw new Error(`--confirm must be exactly "${plan.confirm}". Nothing written.`);
    localFile = path.resolve(process.cwd(), `id-collision-repair-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    const res = await applyPlan(client, plan, 'src/scripts/repair-id-collisions.ts (manual run)', localFile);
    await client.query('COMMIT'); inTx = false;
    try { const doc = JSON.parse(fs.readFileSync(localFile, 'utf8')); doc.status = 'APPLIED (committed ' + new Date().toISOString() + ')'; fs.writeFileSync(localFile, JSON.stringify(doc, null, 2), 'utf8'); } catch { /* the plan is already in the file */ }
    log(`BACKUP   platform_state_backups id ${res.backupId} (whole row) and id ${res.planBackupId} (plan)`);
    log(`LOCAL    ${localFile}`);
    log('         keep this file: the server keeps only the newest 100 backup rows.');
    log(`APPLIED  ${res.changed} record(s) got a new id in ${nApply} group(s); ${nSkip} group(s) left unapplied. No name, price or other field changed.`);
    log('Reload every open dashboard tab before editing customers or quick rates.');
  } catch (err: any) {
    if (client && inTx) await client.query('ROLLBACK').catch(() => undefined);
    if (localFile && fs.existsSync(localFile)) { const nf = localFile.replace(/\.json$/, '-NOT-APPLIED.json'); try { fs.renameSync(localFile, nf); log(`(plan file renamed ${path.basename(nf)} — nothing was applied)`); } catch { /* ignore */ } }
    console.error('STOPPED: ' + scrub(err && err.message ? err.message : String(err), url));
    process.exitCode = 1;
  } finally {
    if (client) await client.end().catch(() => undefined);
  }
}

if (require.main === module) { void main(); }
