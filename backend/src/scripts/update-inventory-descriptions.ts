/**
 * update-inventory-descriptions.ts — MANUAL, one-off data update (2026-11-22).
 *
 * WHAT IT DOES
 *   Sets the DESCRIPTION (rel_inventory_items.name) of the inventory items
 *   listed in a data file to the wording in that file. Nothing else.
 *
 *   The data file is src/scripts/data/inventory-descriptions-2026-11-22.json:
 *   the 411 items of the live inventory as exported to Excel on 22 Nov 2026
 *   and returned with edited descriptions. It holds sku / active / category /
 *   unit (to FIND each item) and name (the only value written).
 *
 * MATCHING
 *   By SKU (trimmed, exact). Where a SKU is used by more than one item the
 *   match is narrowed by active/inactive, then unit, then category. An item
 *   that still cannot be told apart is AMBIGUOUS: it is reported and --apply
 *   refuses to run at all. A SKU no longer in the database is reported and
 *   skipped. Items in the database that are not in the file are untouched.
 *
 * WHAT IT WRITES (only with --apply and the exact --confirm text; ONE transaction)
 *   1. one platform_state_backups row holding, for every item about to
 *      change: id, source_id, sku, the OLD name, the NEW name, row_version;
 *   2. for each of those items:
 *        UPDATE rel_inventory_items
 *           SET name = <new>, row_version = row_version + 1, updated_at = NOW()
 *         WHERE id = <id> AND row_version = <seen> AND name = <old seen>
 *      — the same shape services.ts's updateInventoryItem uses, so open
 *      browsers pick the change up through the normal freshness check.
 *   If any single update matches no row (someone edited that item meanwhile)
 *   the whole transaction is rolled back and nothing is written.
 *
 *   It NEVER writes sku, category, unit, cost, sell, stock, reorder level,
 *   supplier, is_active or legacy_data. There is no INSERT other than the
 *   backup row, and no DELETE anywhere in this file.
 *
 * SAFETY
 *   * Without --apply everything runs inside BEGIN TRANSACTION READ ONLY.
 *   * Uses DATABASE_URL only; no credentials in this file.
 *   * Not referenced by npm start, npm run migrate or npm run build — Render
 *     never runs it.
 *   * Quotes, jobs and invoices keep their own line descriptions; they are
 *     not rewritten.
 *
 * USAGE (from backend/, DATABASE_URL set)
 *   npm run update:inventory-descriptions                 # dry run
 *   npm run update:inventory-descriptions -- --all        # dry run, list every change in full
 *   npm run update:inventory-descriptions -- --apply --confirm="UPDATE <n> INVENTORY DESCRIPTIONS"
 *   options: --file=PATH   --connect-timeout=SECONDS (5-300, default 30)
 */
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import { resolveSsl, describeConnectionError } from '../db/ssl';

export interface DescItem { sku: string; active: boolean; category: string; unit: string; name: string }
export interface DbItem { id: string | number; source_id: string; sku: string | null; name: string; category: string | null; unit: string | null; is_active: boolean; row_version: number }
export interface Change { id: string | number; source_id: string; sku: string; oldName: string; newName: string; rowVersion: number }
export interface Plan { changes: Change[]; unchanged: number; notFound: DescItem[]; ambiguous: DescItem[]; notInFile: DbItem[]; fileCount: number; dbCount: number }

const DEFAULT_FILE = 'inventory-descriptions-2026-11-22.json';
const norm = (v: unknown): string => String(v == null ? '' : v).trim();
const lower = (v: unknown): string => norm(v).toLowerCase();
/** A description as it is stored: line endings normalised, outer whitespace trimmed. */
export const cleanName = (v: unknown): string => String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim();

export function loadItems(file: string): DescItem[] {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const items: any[] = Array.isArray(doc) ? doc : doc.items;
  if (!Array.isArray(items) || items.length === 0) throw new Error(`no items in ${file}`);
  return items.map((it, i) => {
    const sku = norm(it.sku); const name = cleanName(it.name);
    if (!sku) throw new Error(`item ${i + 1} in ${file} has no SKU`);
    if (!name) throw new Error(`item ${i + 1} (${sku}) in ${file} has an empty description — refusing to blank a name`);
    return { sku, active: it.active !== false, category: norm(it.category), unit: norm(it.unit), name };
  });
}

/** Pure: decide what would change. Never touches the database. */
export function buildPlan(items: DescItem[], db: DbItem[]): Plan {
  const bySku = new Map<string, DbItem[]>();
  for (const r of db) { const k = norm(r.sku); if (!k) continue; (bySku.get(k) || bySku.set(k, []).get(k)!).push(r); }
  const fileSkuCount = new Map<string, number>();
  for (const it of items) fileSkuCount.set(it.sku, (fileSkuCount.get(it.sku) || 0) + 1);

  const claimed = new Set<string>();
  const plan: Plan = { changes: [], unchanged: 0, notFound: [], ambiguous: [], notInFile: [], fileCount: items.length, dbCount: db.length };
  for (const it of items) {
    let cand = (bySku.get(it.sku) || []).filter((r) => !claimed.has(String(r.id)));
    if (cand.length === 0) { plan.notFound.push(it); continue; }
    // One file row for this SKU and one database row: that is the item.
    // Otherwise narrow step by step, never past the point of having none left.
    if (cand.length > 1 || (fileSkuCount.get(it.sku) || 0) > 1) {
      const narrow = (f: (r: DbItem) => boolean) => { const n = cand.filter(f); if (n.length > 0) cand = n; };
      narrow((r) => (r.is_active !== false) === it.active);
      if (cand.length > 1) narrow((r) => lower(r.unit) === lower(it.unit));
      if (cand.length > 1) narrow((r) => lower(r.category) === lower(it.category));
      const activeMatches = cand.filter((r) => (r.is_active !== false) === it.active);
      // A shared SKU must be settled by active/inactive (or better) — never by position.
      if (cand.length !== 1 || ((fileSkuCount.get(it.sku) || 0) > 1 && activeMatches.length !== 1)) { plan.ambiguous.push(it); continue; }
    }
    const row = cand[0];
    claimed.add(String(row.id));
    if (cleanName(row.name) === it.name) { plan.unchanged++; continue; } // whitespace-only differences are not a change
    plan.changes.push({ id: row.id, source_id: row.source_id, sku: it.sku, oldName: row.name, newName: it.name, rowVersion: row.row_version });
  }
  plan.notInFile = db.filter((r) => !claimed.has(String(r.id)) && !plan.ambiguous.some((a) => a.sku === norm(r.sku)));
  return plan;
}

export function confirmText(plan: Plan): string { return `UPDATE ${plan.changes.length} INVENTORY DESCRIPTIONS`; }

type Q = { query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export async function readDb(client: Q): Promise<DbItem[]> {
  const res = await client.query(
    `SELECT id, source_id, COALESCE(sku, legacy_data->>'sku') AS sku, name, category, unit, is_active, row_version
       FROM rel_inventory_items ORDER BY id`
  );
  return res.rows as DbItem[];
}

/** The writes. Caller owns BEGIN / COMMIT / ROLLBACK. Throws if any row moved. */
export async function applyPlan(client: Q, plan: Plan, source: string): Promise<{ backupId: any; updated: number }> {
  const payload = { case: 'inventory descriptions updated from Excel (2026-11-22)', count: plan.changes.length, items: plan.changes };
  const serialized = JSON.stringify(payload);
  const b = (await client.query(
    `INSERT INTO platform_state_backups (data, reason, data_size_bytes, source, record_counts)
     VALUES ($1::jsonb, $2, $3, $4, $5::jsonb) RETURNING id, created_at`,
    [serialized, 'before-update-inventory-descriptions-2026-11-22', Buffer.byteLength(serialized, 'utf8'), source,
     JSON.stringify({ inventory: plan.changes.length })]
  )).rows[0];
  let updated = 0;
  for (const c of plan.changes) {
    const res = await client.query(
      `UPDATE rel_inventory_items SET name = $1, row_version = row_version + 1, updated_at = NOW()
        WHERE id = $2 AND row_version = $3 AND name = $4`,
      [c.newName, c.id, c.rowVersion, c.oldName]
    );
    if ((res.rowCount ?? 0) !== 1) throw new Error(`item ${c.sku} (id ${c.id}) changed while this was running — everything rolled back, nothing written.`);
    updated++;
  }
  return { backupId: b.id, updated };
}

const log = (s = ''): void => console.log(s);
const one = (s: string, n = 90): string => { const t = s.replace(/\s*\n\s*/g, ' ⏎ '); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

function report(plan: Plan, showAll: boolean): void {
  log(`file items ${plan.fileCount}   database items ${plan.dbCount}`);
  log(`   to change        ${plan.changes.length}`);
  log(`   already the same ${plan.unchanged}`);
  log(`   SKU not found    ${plan.notFound.length}`);
  log(`   ambiguous        ${plan.ambiguous.length}`);
  log(`   in database, not in file (untouched)  ${plan.notInFile.length}`);
  if (plan.changes.length) {
    log('');
    log(`CHANGES${showAll ? '' : ' (one line each; --all prints them in full)'}`);
    for (const c of plan.changes) {
      if (showAll) { log(`- ${c.sku}  (id ${c.id})`); log(`    OLD: ${c.oldName}`); log(`    NEW: ${c.newName}`); }
      else log(`- ${c.sku.padEnd(26)} ${one(c.oldName, 60)}  ->  ${one(c.newName, 90)}`);
    }
  }
  if (plan.notFound.length) { log(''); log('SKU NOT FOUND in the database (skipped):'); for (const it of plan.notFound) log(`- ${it.sku}  ${one(it.name, 70)}`); }
  if (plan.ambiguous.length) { log(''); log('AMBIGUOUS — more than one item shares this SKU and they cannot be told apart (--apply refuses):'); for (const it of plan.ambiguous) log(`- ${it.sku}  [${it.active ? 'active' : 'inactive'}, ${it.unit}, ${it.category}]  ${one(it.name, 60)}`); }
  if (plan.notInFile.length) { log(''); log('IN THE DATABASE BUT NOT IN THE FILE (untouched):'); for (const r of plan.notInFile.slice(0, 40)) log(`- ${norm(r.sku) || '(no SKU)'}  ${one(r.name, 70)}`); if (plan.notInFile.length > 40) log(`  … and ${plan.notInFile.length - 40} more`); }
}

function resolveFile(arg: string | undefined): string {
  const cands = arg ? [path.resolve(arg)] : [
    path.join(__dirname, 'data', DEFAULT_FILE),
    path.join(__dirname, '..', '..', 'src', 'scripts', 'data', DEFAULT_FILE),
    path.join(process.cwd(), 'src', 'scripts', 'data', DEFAULT_FILE),
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error(`data file not found. Looked in:\n   ${cands.join('\n   ')}`);
}

async function connect(timeoutMs: number, attempts: number): Promise<Client> {
  const url = process.env.DATABASE_URL as string;
  let last: any = null;
  for (let i = 1; i <= attempts; i++) {
    const client = new Client({ connectionString: url, ssl: resolveSsl(url), connectionTimeoutMillis: timeoutMs, keepAlive: true, keepAliveInitialDelayMillis: 10000 });
    client.on('error', (e) => { console.error('[db] connection error: ' + (e && e.message ? e.message : e)); });
    const t0 = Date.now();
    try { await client.connect(); log(`connected in ${Date.now() - t0} ms (attempt ${i} of ${attempts})`); return client; }
    catch (err: any) {
      last = err;
      log(`connection attempt ${i} of ${attempts} failed after ${Date.now() - t0} ms: ${err && err.message ? err.message : err}`);
      await client.end().catch(() => undefined);
      if (i < attempts) await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  throw new Error(`could not connect to the database after ${attempts} attempts.\n   ${describeConnectionError(last)}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (n: string): string | undefined => { const a = argv.find((x) => x.startsWith(n + '=')); return a ? a.slice(n.length + 1) : undefined; };
  const APPLY = argv.includes('--apply');
  const confirm = arg('--confirm');
  const tSec = Math.min(300, Math.max(5, Number(arg('--connect-timeout')) || 30));

  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exitCode = 1; return; }
  let client: Client | null = null; let inTx = false;
  try {
    const file = resolveFile(arg('--file'));
    const items = loadItems(file);
    log(`update-inventory-descriptions — ${APPLY ? 'APPLY' : 'DRY RUN'}`);
    log(`data file  ${file}  (${items.length} items)`);
    client = await connect(tSec * 1000, 3);
    const who = (await client.query('SELECT current_database() AS db, NOW() AS at')).rows[0];
    await client.query(APPLY ? 'BEGIN' : 'BEGIN TRANSACTION READ ONLY'); inTx = true;
    log(`database ${who.db}   at ${who.at}${APPLY ? '' : '   (transaction is READ ONLY)'}`);
    log('');

    const db = await readDb(client);
    if (db.length === 0) throw new Error('rel_inventory_items is empty — inventory is not stored relationally here. Nothing to do.');
    const plan = buildPlan(items, db);
    report(plan, argv.includes('--all'));
    log('');
    const required = confirmText(plan);

    if (!APPLY) {
      await client.query('ROLLBACK'); inTx = false;
      log('DRY RUN — nothing was written (READ ONLY transaction).');
      if (plan.ambiguous.length) log('Resolve the AMBIGUOUS items before applying.');
      else if (plan.changes.length) { log('To apply:'); log(`   npm run update:inventory-descriptions -- --apply --confirm="${required}"`); }
      else log('Nothing to change.');
      return;
    }
    if (plan.ambiguous.length) throw new Error(`${plan.ambiguous.length} ambiguous item(s) — nothing written.`);
    if (plan.changes.length === 0) { await client.query('ROLLBACK'); inTx = false; log('Nothing to change — nothing written.'); return; }
    if (confirm !== required) throw new Error(`--confirm must be exactly "${required}". Nothing written.`);

    const res = await applyPlan(client, plan, 'src/scripts/update-inventory-descriptions.ts (manual run)');
    await client.query('COMMIT'); inTx = false;
    log(`BACKUP   platform_state_backups id ${res.backupId}`);
    log(`UPDATED  ${res.updated} inventory description(s). Nothing else was changed.`);
  } catch (err: any) {
    if (client && inTx) await client.query('ROLLBACK').catch(() => undefined);
    console.error('STOPPED: ' + (err && err.message ? err.message : err));
    process.exitCode = 1;
  } finally {
    if (client) await client.end().catch(() => undefined);
  }
}

if (require.main === module) { void main(); }
