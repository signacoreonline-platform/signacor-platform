/**
 * recategorise-hennies-inventory.ts — MANUAL, one-off data update (2026-11-23).
 *
 * WHAT IT DOES
 *   Moves every inventory item that is in the category "General" AND whose
 *   description (rel_inventory_items.name) contains "hennie" (any case — so
 *   Hennie, Hennie's, Hennies) into the category "Hennies". Nothing else.
 *
 * WHICH CATEGORY AN ITEM IS "IN"
 *   The same rule the dashboard reads (read.ts resolveItemCategory): the
 *   category column, else legacy_data.cat, else legacy_data.category. Only an
 *   item whose category is "General" (trimmed, any case) is moved. A matching
 *   item in any other category (including the existing "Hennies" items and
 *   items with no category) is reported and left alone. Active and inactive
 *   (soft-deleted) items are both moved, so a reactivated item lands under
 *   Hennies too; the report lists them separately.
 *
 * WHAT IT WRITES (only with --apply and the exact --confirm text; ONE transaction)
 *   1. one platform_state_backups row holding, for every item about to move:
 *      id, source_id, sku, name, is_active, the OLD category column value, the
 *      effective old category, row_version;
 *   2. for each of those items:
 *        UPDATE rel_inventory_items
 *           SET category = 'Hennies', row_version = row_version + 1, updated_at = NOW()
 *         WHERE id = <id> AND row_version = <seen> AND category = <old seen> (or both NULL)
 *      — the same shape services.ts's updateInventoryItem uses, so open
 *      browsers pick the change up through the normal freshness check.
 *   If any single update matches no row (someone edited that item meanwhile)
 *   the whole transaction is rolled back and nothing is written.
 *
 *   It NEVER writes sku, name, unit, cost, sell, stock, reorder level,
 *   supplier, is_active or legacy_data. There is no INSERT other than the
 *   backup row, and no DELETE anywhere in this file.
 *
 * SAFETY
 *   * Without --apply everything runs inside BEGIN TRANSACTION READ ONLY.
 *   * Uses DATABASE_URL only; no credentials in this file.
 *   * Not referenced by npm start, npm run migrate or npm run build — Render
 *     never runs it.
 *   * Quotes, jobs and invoices are not touched.
 *   * Running it again after a successful apply finds nothing to move.
 *
 * USAGE (from backend/, DATABASE_URL set)
 *   npm run recategorise:hennies                      # dry run, lists every item
 *   npm run recategorise:hennies -- --apply --confirm="MOVE <n> ITEMS TO HENNIES"
 *   options: --connect-timeout=SECONDS (5-300, default 30)
 */
import { Client } from 'pg';
import { resolveSsl, describeConnectionError } from '../db/ssl';

export const FROM_CATEGORY = 'General';
export const TO_CATEGORY = 'Hennies';
export const NAME_PATTERN = /hennie/i;

export interface DbItem { id: string | number; source_id: string; sku: string | null; name: string; category: string | null; effective_category: string | null; is_active: boolean; row_version: number }
export interface Move { id: string | number; source_id: string; sku: string | null; name: string; isActive: boolean; oldCategory: string | null; effectiveCategory: string | null; rowVersion: number }
export interface Plan { moves: Move[]; otherCategory: DbItem[]; dbCount: number; matchCount: number }

const norm = (v: unknown): string => String(v == null ? '' : v).trim();

/** Pure: decide what would move. Never touches the database. */
export function buildPlan(db: DbItem[]): Plan {
  const plan: Plan = { moves: [], otherCategory: [], dbCount: db.length, matchCount: 0 };
  for (const r of db) {
    if (!NAME_PATTERN.test(String(r.name || ''))) continue;
    plan.matchCount++;
    if (norm(r.effective_category).toLowerCase() !== FROM_CATEGORY.toLowerCase()) { plan.otherCategory.push(r); continue; }
    plan.moves.push({ id: r.id, source_id: r.source_id, sku: r.sku, name: r.name, isActive: r.is_active !== false,
      oldCategory: r.category, effectiveCategory: r.effective_category, rowVersion: r.row_version });
  }
  return plan;
}

export function confirmText(plan: Plan): string { return `MOVE ${plan.moves.length} ITEMS TO HENNIES`; }

type Q = { query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export async function readDb(client: Q): Promise<DbItem[]> {
  const res = await client.query(
    `SELECT id, source_id, COALESCE(sku, legacy_data->>'sku') AS sku, name, category,
            COALESCE(NULLIF(category, ''), NULLIF(legacy_data->>'cat', ''), NULLIF(legacy_data->>'category', '')) AS effective_category,
            is_active, row_version
       FROM rel_inventory_items ORDER BY id`
  );
  return res.rows as DbItem[];
}

/** The writes. Caller owns BEGIN / COMMIT / ROLLBACK. Throws if any row moved. */
export async function applyPlan(client: Q, plan: Plan, source: string): Promise<{ backupId: any; updated: number }> {
  const payload = { case: `inventory items containing "hennie" moved from "${FROM_CATEGORY}" to "${TO_CATEGORY}" (2026-11-23)`, count: plan.moves.length, items: plan.moves };
  const serialized = JSON.stringify(payload);
  const b = (await client.query(
    `INSERT INTO platform_state_backups (data, reason, data_size_bytes, source, record_counts)
     VALUES ($1::jsonb, $2, $3, $4, $5::jsonb) RETURNING id, created_at`,
    [serialized, 'before-recategorise-hennies-inventory-2026-11-23', Buffer.byteLength(serialized, 'utf8'), source,
     JSON.stringify({ inventory: plan.moves.length })]
  )).rows[0];
  let updated = 0;
  for (const m of plan.moves) {
    const res = await client.query(
      `UPDATE rel_inventory_items SET category = $1, row_version = row_version + 1, updated_at = NOW()
        WHERE id = $2 AND row_version = $3 AND (category = $4 OR (category IS NULL AND $4::text IS NULL))`,
      [TO_CATEGORY, m.id, m.rowVersion, m.oldCategory]
    );
    if ((res.rowCount ?? 0) !== 1) throw new Error(`item ${m.sku || '(no SKU)'} (id ${m.id}) changed while this was running — everything rolled back, nothing written.`);
    updated++;
  }
  return { backupId: b.id, updated };
}

const log = (s = ''): void => console.log(s);
const one = (s: string, n = 90): string => { const t = String(s || '').replace(/\s*\n\s*/g, ' ⏎ '); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

function report(plan: Plan): void {
  const act = plan.moves.filter((m) => m.isActive), inact = plan.moves.filter((m) => !m.isActive);
  log(`database items ${plan.dbCount}   descriptions containing "hennie" ${plan.matchCount}`);
  log(`   to move ${FROM_CATEGORY} -> ${TO_CATEGORY}   ${plan.moves.length}  (${act.length} active, ${inact.length} inactive)`);
  log(`   in another category (untouched)        ${plan.otherCategory.length}`);
  const list = (title: string, ms: Move[]) => {
    if (!ms.length) return;
    log(''); log(title);
    for (const m of ms) log(`- ${norm(m.sku || '(no SKU)').padEnd(22)} ${one(m.name, 95)}`);
  };
  list('TO MOVE — ACTIVE (shown in Inventory):', act);
  list('TO MOVE — INACTIVE (removed items, hidden in Inventory):', inact);
  if (plan.otherCategory.length) {
    log(''); log('CONTAIN "hennie" BUT NOT IN "General" (untouched):');
    for (const r of plan.otherCategory) log(`- ${norm(r.sku || '(no SKU)').padEnd(22)} [${norm(r.effective_category) || 'no category'}${r.is_active === false ? ', inactive' : ''}]  ${one(r.name, 80)}`);
  }
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
    log(`recategorise-hennies-inventory — ${APPLY ? 'APPLY' : 'DRY RUN'}`);
    client = await connect(tSec * 1000, 3);
    const who = (await client.query('SELECT current_database() AS db, NOW() AS at')).rows[0];
    await client.query(APPLY ? 'BEGIN' : 'BEGIN TRANSACTION READ ONLY'); inTx = true;
    log(`database ${who.db}   at ${who.at}${APPLY ? '' : '   (transaction is READ ONLY)'}`);
    log('');

    const db = await readDb(client);
    if (db.length === 0) throw new Error('rel_inventory_items is empty — inventory is not stored relationally here. Nothing to do.');
    const plan = buildPlan(db);
    report(plan);
    log('');
    const required = confirmText(plan);

    if (!APPLY) {
      await client.query('ROLLBACK'); inTx = false;
      log('DRY RUN — nothing was written (READ ONLY transaction).');
      if (plan.moves.length) { log('To apply:'); log(`   npm run recategorise:hennies -- --apply --confirm="${required}"`); }
      else log('Nothing to move.');
      return;
    }
    if (plan.moves.length === 0) { await client.query('ROLLBACK'); inTx = false; log('Nothing to move — nothing written.'); return; }
    if (confirm !== required) throw new Error(`--confirm must be exactly "${required}". Nothing written.`);

    const res = await applyPlan(client, plan, 'src/scripts/recategorise-hennies-inventory.ts (manual run)');
    await client.query('COMMIT'); inTx = false;
    log(`BACKUP   platform_state_backups id ${res.backupId}`);
    log(`UPDATED  ${res.updated} item(s): category "${FROM_CATEGORY}" -> "${TO_CATEGORY}". Nothing else was changed.`);
  } catch (err: any) {
    if (client && inTx) await client.query('ROLLBACK').catch(() => undefined);
    console.error('STOPPED: ' + (err && err.message ? err.message : err));
    process.exitCode = 1;
  } finally {
    if (client) await client.end().catch(() => undefined);
  }
}

if (require.main === module) { void main(); }
