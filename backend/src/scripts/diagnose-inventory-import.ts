/**
 * diagnose-inventory-import.ts — READ-ONLY diagnostic (2026-11-23).
 *
 * WHAT IT CHECKS (nothing else)
 *   A. Inventory damage that the pre-2026-11-23 Bulk Import could leave behind
 *      in rel_inventory_items. That importer read columns by POSITION and
 *      split on every comma, so a file in the 22 Nov export layout
 *      (…, Unit, Stock on hand, Reorder level, …) wrote the stock into the
 *      reorder level, stock 0 and a number into Unit; a quoted comma left a
 *      stray double quote at the start of the name / end of the category.
 *      Reported per item with the reason, plus "bursts" (10+ items updated
 *      in the same minute) that show when a bulk import ran.
 *   B. Things that make the NEW importer reject rows or that block saves:
 *        - active inventory items sharing one SKU (rows without an ID column
 *          are rejected for these);
 *        - duplicate / missing record ids in the platform_state sections the
 *          server id-merges (routes/platformState.ts PROTECTED_SECTIONS). A
 *          record whose id is duplicated cannot be edited or saved until the
 *          collision is resolved; new records are not affected.
 *
 * SAFETY
 *   * Everything runs in ONE `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE
 *     READ READ ONLY` transaction (one consistent snapshot) that is rolled
 *     back. The file contains no INSERT, UPDATE, DELETE or DDL.
 *   * Uses DATABASE_URL only. Never prints it, the host's password, or any
 *     account field; error text is scrubbed of the connection string.
 *   * Its own dedicated connection, as in record-cancelled-invoice.ts: a
 *     30-second connect limit (Render's external endpoint often needs more
 *     than the shared pool's 2 s for TLS + login), TCP keep-alive, up to 3
 *     attempts, SSL from db/ssl.ts resolveSsl.
 *   * Not referenced by npm start / npm run migrate / npm run build.
 *
 * RUN (Windows PowerShell, from backend\, after npm run build)
 *   $env:DATABASE_URL = Read-Host "Render External Database URL"
 *   npm run diagnose:inventory-import:compiled
 *   #   options: -- --limit=200   (rows listed per finding, default 50)
 *   #            -- --connect-timeout=60   (seconds per attempt, default 30)
 *   Remove-Item Env:\DATABASE_URL
 */
import { Client } from 'pg';
import { resolveSsl, describeConnectionError } from '../db/ssl';

/** Mirror of routes/platformState.ts PROTECTED_SECTIONS (the id-merged sections). */
export const ID_MERGED_SECTIONS = [
  'jobs', 'quotes', 'customers', 'suppliers', 'inventory',
  'accInvoices', 'accBills', 'purchaseOrders', 'quickRates', 'employees',
  'leaveRequests', 'disciplinary', 'creditNotes', 'proposedProjects', 'userAccounts',
  'materialOrders',
];

export interface InvRow {
  id: string | number; source_id: string; sku: string | null; name: string | null; category: string | null; unit: string | null;
  stock_qty: any; reorder_level: any; cost: any; sell: any; is_active: boolean; updated_at: any;
}
export interface Suspect { row: InvRow; reasons: string[] }
export interface DupGroup { section: string; id: string; count: number; labels: string[] }
export interface SectionIds { section: string; records: number; duplicateGroups: DupGroup[]; missingId: number }
export interface Report {
  inventoryRelational: boolean | null; items: number; active: number;
  suspects: Suspect[]; bursts: { minute: string; items: number; stockZero: number; numericUnit: number }[];
  sharedSkus: { sku: string; count: number; items: string[] }[];
  sections: SectionIds[];
}

const oddQuotes = (s: string): boolean => ((s.match(/"/g) || []).length % 2) === 1;
const num = (v: any): number => (v === null || v === undefined || v === '' ? 0 : Number(v));
const minuteOf = (v: any): string => { const d = new Date(v); return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; };

/** Pure: why might this item have been damaged by the old positional importer? */
export function damageReasons(r: InvRow): string[] {
  const out: string[] = [];
  const unit = String(r.unit == null ? '' : r.unit).trim();
  const name = String(r.name == null ? '' : r.name).trim();
  const cat = String(r.category == null ? '' : r.category).trim();
  if (/^[-+]?\d+([.,]\d+)?$/.test(unit)) out.push(`unit is a number ("${unit}") — the old importer put the reorder level here`);
  if (name.startsWith('"') && oddQuotes(name)) out.push('name starts with an unmatched " — a quoted comma was split');
  if (cat && oddQuotes(cat)) out.push('category has an unmatched " — a quoted comma was split');
  if (cat && /^[-+]?[\d.,\s]+$/.test(cat)) out.push(`category is a number ("${cat}") — columns were shifted`);
  return out;
}

export function buildReport(inv: InvRow[], data: Record<string, any> | null, cutover: boolean | null): Report {
  const suspects: Suspect[] = [];
  for (const r of inv) { const reasons = damageReasons(r); if (reasons.length) suspects.push({ row: r, reasons }); }
  // Bursts: 10+ items written in the same minute = a bulk import (or script).
  const byMinute = new Map<string, InvRow[]>();
  for (const r of inv) { const m = minuteOf(r.updated_at); const l = byMinute.get(m) || []; l.push(r); byMinute.set(m, l); }
  const bursts = [...byMinute.entries()].filter(([, l]) => l.length >= 10)
    .map(([minute, l]) => ({ minute, items: l.length, stockZero: l.filter((r) => num(r.stock_qty) === 0).length, numericUnit: l.filter((r) => /^[-+]?\d+([.,]\d+)?$/.test(String(r.unit || '').trim())).length }))
    .sort((a, b) => (a.minute < b.minute ? 1 : -1));
  // Active items sharing a SKU (case-insensitive, trimmed).
  const skuMap = new Map<string, InvRow[]>();
  for (const r of inv) { if (r.is_active === false) continue; const k = String(r.sku || '').trim().toLowerCase(); if (!k) continue; const l = skuMap.get(k) || []; l.push(r); skuMap.set(k, l); }
  const sharedSkus = [...skuMap.values()].filter((l) => l.length > 1)
    .map((l) => ({ sku: String(l[0].sku), count: l.length, items: l.map((r) => `id ${r.source_id}: ${String(r.name || '').slice(0, 50)}`) }));
  // Duplicate / missing ids in the id-merged platform_state sections.
  const sections: SectionIds[] = [];
  for (const section of ID_MERGED_SECTIONS) {
    const list = data && Array.isArray(data[section]) ? data[section] : null;
    if (!list) continue;
    const groups = new Map<string, any[]>(); let missingId = 0;
    for (const rec of list) {
      if (!rec || typeof rec !== 'object') continue;
      if (rec.id === undefined || rec.id === null) { missingId++; continue; }
      const k = String(rec.id); const g = groups.get(k) || []; g.push(rec); groups.set(k, g);
    }
    const duplicateGroups: DupGroup[] = [...groups.entries()].filter(([, g]) => g.length > 1).map(([id, g]) => ({
      section, id, count: g.length,
      // A short human label only (name / number / sku) — never any other field.
      labels: g.map((x) => String(x.companyName || x.name || x.num || x.number || x.sku || x.description || '').slice(0, 50)),
    }));
    sections.push({ section, records: list.length, duplicateGroups, missingId });
  }
  return { inventoryRelational: cutover, items: inv.length, active: inv.filter((r) => r.is_active !== false).length, suspects, bursts, sharedSkus, sections };
}

/** Never print the connection string or its password, whatever an error says. */
export function scrub(text: string, url: string | undefined): string {
  let t = String(text);
  if (url) {
    t = t.split(url).join('<DATABASE_URL>');
    try { const u = new URL(url); if (u.password) t = t.split(decodeURIComponent(u.password)).join('***').split(u.password).join('***'); } catch { /* not a URL */ }
  }
  return t.replace(/postgres(ql)?:\/\/[^\s'"]+/gi, '<connection string>');
}

const log = (s = ''): void => console.log(s);

export function printReport(rep: Report, limit: number): void {
  const fmt = (v: any) => (v === null || v === undefined ? '' : String(Number(v)));
  log(`inventory storage: ${rep.inventoryRelational === null ? 'unknown (no relational_cutover row)' : rep.inventoryRelational ? 'relational (rel_inventory_items) — Bulk Import writes here' : 'platform_state JSON (not cut over)'}`);
  log(`rel_inventory_items: ${rep.items} items (${rep.active} active, ${rep.items - rep.active} removed)`);
  log('');
  log(`A. POSSIBLE DAMAGE FROM THE OLD BULK IMPORT — ${rep.suspects.length} item(s)`);
  for (const s of rep.suspects.slice(0, limit)) {
    const r = s.row;
    log(`- ${String(r.sku || '(no SKU)').padEnd(22)} id ${r.source_id}${r.is_active === false ? ' (removed)' : ''}  updated ${minuteOf(r.updated_at)}`);
    log(`    name "${String(r.name || '').slice(0, 70)}"  category "${r.category || ''}"  unit "${r.unit || ''}"  stock ${fmt(r.stock_qty)}  reorder ${fmt(r.reorder_level)}  cost ${fmt(r.cost)}  sell ${fmt(r.sell)}`);
    for (const why of s.reasons) log(`    · ${why}`);
  }
  if (rep.suspects.length > limit) log(`  … and ${rep.suspects.length - limit} more (use --limit=${rep.suspects.length})`);
  log('');
  log(`   bulk-write minutes (10+ items updated in the same minute) — ${rep.bursts.length}`);
  for (const b of rep.bursts.slice(0, limit)) log(`   - ${b.minute}: ${b.items} items, ${b.stockZero} now with stock 0, ${b.numericUnit} with a numeric unit`);
  log('');
  log(`B1. ACTIVE ITEMS SHARING A SKU — ${rep.sharedSkus.length} SKU(s) (rows for these are rejected unless the file has the ID column)`);
  for (const g of rep.sharedSkus.slice(0, limit)) { log(`- ${g.sku} × ${g.count}`); for (const it of g.items) log(`    ${it}`); }
  log('');
  const bad = rep.sections.filter((s) => s.duplicateGroups.length || s.missingId);
  log(`B2. DUPLICATE / MISSING RECORD IDS IN platform_state — ${bad.length} section(s) affected`);
  for (const s of rep.sections) {
    const dupRecs = s.duplicateGroups.reduce((n, g) => n + g.count, 0);
    log(`   ${s.section.padEnd(17)} ${String(s.records).padStart(5)} records   ${s.duplicateGroups.length ? `${s.duplicateGroups.length} duplicated id(s) covering ${dupRecs} records` : 'no duplicate ids'}${s.missingId ? `   ${s.missingId} without an id` : ''}`);
    for (const g of s.duplicateGroups.slice(0, limit)) log(`      id ${g.id} × ${g.count}: ${g.labels.map((x) => `"${x}"`).join(', ')}`);
    if (s.duplicateGroups.length > limit) log(`      … and ${s.duplicateGroups.length - limit} more`);
  }
  log('');
  const findings = rep.suspects.length + rep.sharedSkus.length + bad.length;
  log(findings ? `RESULT: ${findings} finding group(s) above. Nothing was changed.` : 'RESULT: no damage, shared SKUs or duplicate ids found. Nothing was changed.');
  if (bad.length) log('   Records in a duplicated-id group cannot be edited until the collision is resolved; importing NEW records is not affected.');
}

async function connect(timeoutMs: number, attempts: number): Promise<Client> {
  const url = process.env.DATABASE_URL as string;
  let last: any = null;
  for (let i = 1; i <= attempts; i++) {
    const client = new Client({ connectionString: url, ssl: resolveSsl(url), connectionTimeoutMillis: timeoutMs, keepAlive: true, keepAliveInitialDelayMillis: 10000 });
    client.on('error', (e) => { console.error('[db] connection error: ' + scrub(e && e.message ? e.message : String(e), url)); });
    const t0 = Date.now();
    try { await client.connect(); log(`connected in ${Date.now() - t0} ms (attempt ${i} of ${attempts}; limit ${Math.round(timeoutMs / 1000)}s)`); return client; }
    catch (err: any) {
      last = err;
      log(`connection attempt ${i} of ${attempts} failed after ${Date.now() - t0} ms: ${scrub(err && err.message ? err.message : String(err), url)}`);
      await client.end().catch(() => undefined);
      if (i < attempts) await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  throw new Error(`could not connect to the database after ${attempts} attempts (limit ${Math.round(timeoutMs / 1000)}s each).\n   ${scrub(describeConnectionError(last), url)}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (n: string): string | undefined => { const a = argv.find((x) => x.startsWith(n + '=')); return a ? a.slice(n.length + 1) : undefined; };
  const limit = Math.max(1, Math.min(100000, Number(arg('--limit')) || 50));
  const tSec = Math.min(300, Math.max(5, Number(arg('--connect-timeout')) || 30));
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set. In PowerShell:  $env:DATABASE_URL = Read-Host "Render External Database URL"'); process.exitCode = 1; return; }
  let client: Client | null = null; let inTx = false;
  try {
    log('diagnose-inventory-import — READ ONLY');
    client = await connect(tSec * 1000, 3);
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'); inTx = true;
    await client.query(`SET LOCAL statement_timeout = '120s'`);
    const who = (await client.query('SELECT current_database() AS db, NOW() AS at, current_setting(\'transaction_read_only\') AS ro')).rows[0];
    log(`database ${who.db}   snapshot at ${new Date(who.at).toISOString()}   transaction_read_only=${who.ro}`);
    log('');
    const cut = await client.query(`SELECT enabled FROM relational_cutover WHERE section = 'inventory'`);
    const inv = (await client.query(
      `SELECT id, source_id, COALESCE(sku, legacy_data->>'sku') AS sku, name,
              COALESCE(NULLIF(category, ''), NULLIF(legacy_data->>'cat', ''), NULLIF(legacy_data->>'category', '')) AS category,
              unit, stock_qty, reorder_level, cost, sell, is_active, updated_at
         FROM rel_inventory_items ORDER BY updated_at DESC, id`
    )).rows as InvRow[];
    const ps = await client.query('SELECT data FROM platform_state WHERE id = 1');
    await client.query('ROLLBACK'); inTx = false;
    const rep = buildReport(inv, ps.rowCount ? ps.rows[0].data : null, cut.rowCount ? cut.rows[0].enabled === true : null);
    printReport(rep, limit);
  } catch (err: any) {
    if (client && inTx) await client.query('ROLLBACK').catch(() => undefined);
    console.error('STOPPED: ' + scrub(err && err.message ? err.message : String(err), url));
    process.exitCode = 1;
  } finally {
    if (client) await client.end().catch(() => undefined);
  }
}

if (require.main === module) { void main(); }
