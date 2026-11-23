/**
 * inventory-import-diagnostic.stress.ts — 2026-11-23
 * Runs the COMPILED read-only diagnostic (dist/scripts/diagnose-inventory-import.js)
 * against a disposable `_test` database seeded with the damage patterns and
 * duplicate ids it must find, and proves it changes nothing and prints no
 * credentials. Run `npm run build` first.
 *
 * SAFETY: writes test rows (SKU prefix INVD-) and temporarily replaces
 * platform_state; both are restored at the end. Refuses unless DATABASE_URL
 * names a database ending in `_test`.
 */
if (!/\/[A-Za-z0-9_-]*_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  console.error('[inventory-import-diagnostic] REFUSING TO RUN — DATABASE_URL must name a database ending in "_test".');
  process.exit(1);
}
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import pool from '../src/db/pool';
import { damageReasons, scrub } from '../src/scripts/diagnose-inventory-import';

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); } else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 800) : ''}`); }
}
const SCRIPT = path.resolve(__dirname, '..', 'dist', 'scripts', 'diagnose-inventory-import.js');
function run(url: string, extra: string[] = []): { out: string; code: number } {
  try { return { out: execFileSync(process.execPath, [SCRIPT, ...extra], { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90000 }), code: 0 }; }
  catch (e: any) { return { out: String(e.stdout || '') + String(e.stderr || ''), code: e.status ?? 1 }; }
}
async function fingerprint(): Promise<string> {
  const a = (await pool.query(`SELECT COUNT(*)::int n, COALESCE(SUM(row_version),0)::bigint v, MAX(updated_at) u FROM rel_inventory_items`)).rows[0];
  const b = (await pool.query(`SELECT md5(data::text) h, updated_at FROM platform_state WHERE id = 1`)).rows[0];
  const c = (await pool.query(`SELECT COUNT(*)::int n FROM platform_state_backups`)).rows[0];
  return JSON.stringify([a, b, c]);
}

async function main() {
  console.log('\n[1] pure checks');
  const base = { id: 1, source_id: '1', sku: 'X', category: 'Vinyl', stock_qty: 1, reorder_level: 1, cost: 1, sell: 1, is_active: true, updated_at: new Date() };
  ok(damageReasons({ ...base, name: 'Vinyl', unit: '8' }).length === 1, 'numeric unit flagged');
  ok(damageReasons({ ...base, name: '"Aluminium return coil', unit: 'm', category: '100mm"' }).length === 2, 'split quoted comma flagged (name + category)');
  ok(damageReasons({ ...base, name: 'Aluminium profile 10"', unit: 'm' }).length === 0 && damageReasons({ ...base, name: '"Quoted" name', unit: 'm' }).length === 0, 'a legitimate inch mark or balanced quotes is NOT flagged');
  ok(!/s3cr3t/.test(scrub('failed for postgresql://u:s3cr3t@h:5432/db and s3cr3t', 'postgresql://u:s3cr3t@h:5432/db')), 'scrub removes the URL and the password');
  const code = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'scripts', 'diagnose-inventory-import.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok(!/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE|DROP\s|ALTER\s|CREATE\s)/i.test(code) && /BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/.test(code), 'the script code has no write/DDL statement and opens a READ ONLY transaction');
  ok(fs.existsSync(SCRIPT), 'compiled script exists (npm run build)');
  if (!fs.existsSync(SCRIPT)) return;

  console.log('\n[2] seeded test database');
  const psBefore = (await pool.query(`SELECT data FROM platform_state WHERE id = 1`)).rows[0];
  await pool.query(`DELETE FROM rel_inventory_items WHERE sku LIKE 'INVD-%'`);
  const ins = async (sku: string, name: string, cat: string, unit: string, stock: number, reorder: number) =>
    pool.query(`WITH n AS (SELECT nextval('rel_inventory_items_id_seq') id) INSERT INTO rel_inventory_items (id, source_id, sku, name, category, unit, stock_qty, reorder_level, cost, sell, legacy_data) SELECT n.id, n.id::text, $1,$2,$3,$4,$5,$6,1,2,'{}'::jsonb FROM n`, [sku, name, cat, unit, stock, reorder]);
  await ins('INVD-UNIT', 'Vinyl roll', 'Vinyl', '8', 0, 40);
  await ins('INVD-QUOTE', '"Aluminium return coil', '100mm"', '12.5', 0, 5);
  await ins('INVD-OK', 'Aluminium profile 10"', 'Profiles', 'm', 3, 1);
  await ins('INVD-DUP', 'Install A', 'Labour', 'hr', 0, 0);
  await ins('INVD-DUP', 'Install B', 'Labour', 'hr', 0, 0);
  await pool.query(`INSERT INTO platform_state (id, data, updated_at) VALUES (1, $1::jsonb, NOW()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`, [JSON.stringify({
    customers: [{ id: 1777789993569.4546, companyName: 'Dup A' }, { id: 1777789993569.4546, companyName: 'Dup B' }, { id: 5, companyName: 'Fine' }, { companyName: 'No id' }],
    quickRates: [{ id: 7, name: 'R1' }, { id: 7, name: 'R2' }, { id: 7, name: 'R3' }],
    userAccounts: [{ id: 'u1', email: 'x@example.test', pw: 'NeverPrintMe-991' }],
  })]);
  const before = await fingerprint();
  const url = process.env.DATABASE_URL as string;
  const r = run(url, ['--limit=20']);
  const after = await fingerprint();
  const out = r.out;
  ok(r.code === 0, 'exit code 0', out.slice(-400));
  ok(/transaction_read_only=on/.test(out), 'reports the transaction as read only', out.slice(0, 400));
  ok(/INVD-UNIT[\s\S]{0,400}unit is a number \("8"\)/.test(out) && /INVD-QUOTE[\s\S]{0,500}unmatched "/.test(out), 'finds the numeric unit and the split quoted comma');
  ok(!/INVD-OK/.test(out.split('B1.')[0]), 'does not flag the legitimate 10" item');
  ok(/B1\.[\s\S]*INVD-DUP × 2/.test(out), 'lists the shared active SKU');
  ok(/customers\s+4 records\s+1 duplicated id\(s\) covering 2 records\s+1 without an id/.test(out) && /id 1777789993569\.4546 × 2: "Dup A", "Dup B"/.test(out), 'customers: the duplicate float id and the record without an id', out.split('B2.')[1]);
  ok(/quickRates\s+3 records\s+1 duplicated id\(s\) covering 3 records/.test(out), 'quickRates: three records sharing one id');
  ok(!out.includes(url) && !out.includes('NeverPrintMe-991') && !/postgres(ql)?:\/\//i.test(out) && !/x@example\.test/.test(out), 'prints no connection string, password, or account field');
  ok(before === after, 'the database is byte-for-byte unchanged (items, platform_state, backups)', { before, after });

  console.log('\n[3] connection failure prints no credentials');
  const bad = url.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:Wr0ngPa55-xyz@');
  const rb = run(bad, ['--connect-timeout=5']);
  ok(rb.code === 1 && /STOPPED|could not connect/.test(rb.out) && !rb.out.includes('Wr0ngPa55-xyz') && !rb.out.includes(bad), 'wrong password: stops with exit 1, password not echoed', rb.out.slice(0, 500));

  await pool.query(`DELETE FROM rel_inventory_items WHERE sku LIKE 'INVD-%'`);
  await pool.query(`UPDATE platform_state SET data = $1::jsonb WHERE id = 1`, [JSON.stringify(psBefore ? psBefore.data : {})]);
}
main().then(async () => { await pool.end(); console.log(`\n${passed} passed, ${failures} failed`); process.exit(failures ? 1 : 0); })
  .catch(async (e) => { console.error('FATAL', e); await pool.end().catch(() => undefined); process.exit(1); });
