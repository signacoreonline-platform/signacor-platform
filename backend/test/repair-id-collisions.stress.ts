/**
 * repair-id-collisions.stress.ts — 2026-11-23
 * Runs the COMPILED repair script (dist/scripts/repair-id-collisions.js) in all
 * three modes against a disposable `_test` database seeded with synthetic
 * collisions: a 3-record group (two identical), linked relational rows,
 * Sally mappings / stored responses / API calls, an ambiguous reference, a
 * platform_state reference that must move with its copy, concurrent change,
 * lock contention and a forced rollback. Run `npm run build` first.
 * With TEST_SERVER_URL_WITH_AUTHORITY set it also proves the live save path
 * accepts the repaired data and still blocks a stale tab.
 *
 * SAFETY: refuses unless DATABASE_URL ends in `_test`. platform_state is put
 * back afterwards; test rows (client "repair-test", source_ids 5001-5005) are
 * removed.
 */
if (!/\/[A-Za-z0-9_-]*_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  console.error('[repair-id-collisions] REFUSING TO RUN — DATABASE_URL must name a database ending in "_test".');
  process.exit(1);
}
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import pool from '../src/db/pool';
import { buildPlan, readSnapshot, scanPlatformState, stable } from '../src/scripts/repair-id-collisions';

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); } else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 900) : ''}`); }
}
const SCRIPT = path.resolve(__dirname, '..', 'dist', 'scripts', 'repair-id-collisions.js');
const URL_ = process.env.DATABASE_URL as string;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-ids-'));
function run(args: string[], url = URL_): { out: string; code: number } {
  try { return { out: execFileSync(process.execPath, [SCRIPT, ...args], { cwd: WORK, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }), code: 0 }; }
  catch (e: any) { return { out: String(e.stdout || '') + String(e.stderr || ''), code: e.status ?? 1 }; }
}
async function state() {
  const d = (await pool.query('SELECT data, updated_at FROM platform_state WHERE id = 1')).rows[0];
  const rel = (await pool.query(`SELECT id, source_id, row_version FROM rel_customers WHERE source_id LIKE '5%' OR company_name IN ('Kappa','Beta Ltd','Epsilon') ORDER BY id`)).rows;
  const ir = (await pool.query(`SELECT record_id::text FROM integration_records WHERE client_id = 'repair-test' ORDER BY id`)).rows;
  const b = (await pool.query('SELECT COUNT(*)::int n FROM platform_state_backups')).rows[0].n;
  return { data: d.data, fp: stable(d.data) + '|' + JSON.stringify(rel) + '|' + JSON.stringify(ir) + '|' + b, backups: b, rel };
}
const cust = (companyName: string, extra: any = {}) => ({ companyName, contactPerson: '', email: '', tel: '', vatNumber: '', address: '', notes: '', ...extra });
const C1 = 1777789993569.4546, Q1 = 1777789871037.1162, Q2 = 1777789871037.6982;
const SEED = {
  customers: [
    { id: 7, ...cust('Fine Co') },
    { id: C1, ...cust('lloyd mcmurdo', { tel: '082 000 0001' }) }, { id: C1, ...cust('Kanya Cingwane', { email: 'k@example.test' }) },
    { id: 5001, ...cust('Alpha Ltd') }, { id: 5001, ...cust('Beta Ltd') },          // rel row + Sally mapping belong to Beta → Beta keeps 5001
    { id: 5002, ...cust('Gamma') }, { id: 5002, ...cust('Delta') },                 // ambiguous reference → left unapplied
    { id: 5003, ...cust('Epsilon') }, { id: 5003, ...cust('Zeta') },                // rel row = Epsilon, a quote names Zeta → quote ref rewritten
    { id: 5004, ...cust('Eta') }, { id: 5004, ...cust('Theta') },                   // API call → Eta, stored response → Theta (not rewritable) → unapplied
    { id: 5005, ...cust('Iota') }, { id: 5005, ...cust('Kappa') },                  // API call → Iota, rel row = Kappa → rel source_id rewritten
  ],
  quickRates: [
    { id: 8, sku: 'QR-8', name: 'Fine rate', cat: 'X', unit: 'm', stock: 0, reorder: 0, cost: 1, sell: 2, supplierId: null },
    { id: Q1, sku: 'QR-A', name: 'Vinyl A', cat: 'Vinyl', unit: 'm', stock: 0, reorder: 0, cost: 10, sell: 20, supplierId: null },
    { id: Q1, sku: 'QR-A', name: 'Vinyl A', cat: 'Vinyl', unit: 'm', stock: 0, reorder: 0, cost: 10, sell: 20, supplierId: null },
    { id: Q1, sku: 'QR-B', name: 'Vinyl B', cat: 'Vinyl', unit: 'm', stock: 0, reorder: 0, cost: 12.5, sell: 25.75, supplierId: null },
    { id: Q2, sku: 'QR-C', name: 'Cut C', cat: 'Labour', unit: 'hr', stock: 0, reorder: 0, cost: 100, sell: 150, supplierId: null },
    { id: Q2, sku: 'QR-D', name: 'Cut D', cat: 'Labour', unit: 'hr', stock: 0, reorder: 0, cost: 100, sell: 160, supplierId: null },
  ],
  quotes: [{ id: 900, num: 'SQ-T1', client: 'Zeta', customerId: 5003, lines: [{ id: 5003, desc: 'line whose own id is 5003 (not a reference)' }] }],
  materialOrders: [{ id: 's:x', customerRef: 5002 }],
  jobs: [{ id: 901, num: 'SNS-T1', value: 1777789993569.46, stock: 5001, price: 1777789993569.4546 }],   // equal numbers under non-link keys
  other: { untouched: [1, 2, 3], price: 0.1 },
};

async function seed() {
  await pool.query(`DELETE FROM integration_records WHERE client_id = 'repair-test'`);
  await pool.query(`DELETE FROM integration_idempotency WHERE client_id = 'repair-test'`);
  await pool.query(`DELETE FROM integration_audit WHERE client_id = 'repair-test'`);
  await pool.query(`DELETE FROM rel_customers WHERE source_id IN ('5001','5003','5005') OR company_name IN ('Kappa','Beta Ltd','Epsilon')`);
  await pool.query(`UPDATE platform_state SET data = $1::jsonb, updated_at = NOW() WHERE id = 1`, [JSON.stringify(SEED)]);
  for (const [sid, name] of [['5001', 'Beta Ltd'], ['5003', 'Epsilon'], ['5005', 'Kappa']]) await pool.query(`INSERT INTO rel_customers (source_id, company_name, contact_person, email, phone, address, vat_number) VALUES ($1,$2,'','','','','')`, [sid, name]);
  await pool.query(`INSERT INTO integration_idempotency (client_id, idempotency_key, operation, request_hash, state, response_status, response_body) VALUES
    ('repair-test','k-beta','customer.create','h','completed',201,$1::jsonb), ('repair-test','k-theta','customer.create','h','completed',201,$2::jsonb)`,
    [JSON.stringify({ customer: { id: '5001', companyName: 'Beta Ltd' } }), JSON.stringify({ customer: { id: '5004', companyName: 'Theta' } })]);
  await pool.query(`INSERT INTO integration_records (client_id, record_type, record_id, idempotency_key) VALUES ('repair-test','customer',5001,'k-beta')`);
  await pool.query(`INSERT INTO integration_audit (client_id, operation, method, target_type, target_id, outcome, http_status) VALUES
    ('repair-test','customer.get','GET','customer','5004','success',200), ('repair-test','customer.get','GET','customer','5005','success',200),
    ('repair-test','product.get','GET','product','qr:${Q2}','success',200), ('repair-test','customer.search','GET',NULL,NULL,'success',200)`);
}
const fpOf = (out: string) => (/plan fingerprint: ([0-9a-f]{16})/.exec(out) || [])[1];
const confirmOf = (out: string) => (/--confirm="([^"]+)"/.exec(out) || [])[1];

async function main() {
  const psBefore = (await pool.query('SELECT data FROM platform_state WHERE id = 1')).rows[0];
  try {
    console.log('\n[1] scan + plan (pure)');
    const hits = scanPlatformState(SEED, new Set(['5003', String(C1)]));
    ok((hits.get('5003') || []).length === 1 && hits.get('5003')![0].path.join('.') === 'quotes.0.customerId', 'platform_state scan: finds quotes.0.customerId, skips record `id` keys (quote line id 5003)', hits.get('5003'));
    ok((hits.get(String(C1)) || []).every((h) => !h.referenceKey) && (hits.get(String(C1)) || []).length === 1, 'an equal number under a non-link key ("price") is a coincidence, not a reference; a different number (….46) is not matched', hits.get(String(C1)));
    await seed();
    const plan = buildPlan(await readSnapshot(pool, false));
    const g = (s: string, id: any) => plan.groups.find((x) => x.section === s && x.id === String(id))!;
    ok(plan.groups.length === 8, '8 collision groups found (6 customers, 2 quick rates)', plan.groups.map((x) => x.id));
    ok(g('customers', C1).status === 'apply' && g('customers', C1).keeper === 0 && g('customers', C1).info.some((i) => i.kind === 'coincidence'), 'lloyd/Kanya: no references (an equal price is reported as a coincidence) → copy 1 keeps the id');
    ok(g('customers', 5001).status === 'apply' && g('customers', 5001).keeper === 1, 'Alpha/Beta: rel row and Sally mapping both belong to Beta → Beta keeps 5001', g('customers', 5001).refs.map((r) => [r.kind, r.owner, r.evidence]));
    ok(g('customers', 5002).status === 'skip' && /cannot be tied/.test(g('customers', 5002).reason), 'Gamma/Delta: unnamed reference → AMBIGUOUS → left unapplied');
    ok(g('customers', 5003).status === 'apply' && g('customers', 5003).keeper === 0 && g('customers', 5003).rewrites.length === 1, 'Epsilon/Zeta: rel row → Epsilon keeps 5003; the quote that names Zeta moves with Zeta');
    ok(g('customers', 5004).status === 'skip' && /cannot be rewritten/.test(g('customers', 5004).reason), 'Eta/Theta: API call → Eta, stored Sally response → Theta → left unapplied');
    ok(g('customers', 5005).status === 'apply' && g('customers', 5005).keeper === 0 && g('customers', 5005).rewrites[0].ref.kind === 'rel_row', 'Iota/Kappa: API call → Iota keeps 5005; Kappa\'s rel row is re-pointed');
    ok(g('quickRates', Q1).copies.length === 3 && g('quickRates', Q1).identicalCopies && Object.keys(g('quickRates', Q1).newIds).length === 2, 'three quick rates on one id (two identical): all kept, two new ids');
    ok(g('quickRates', Q2).keeper === 0 && g('quickRates', Q2).refs[0].kind === 'integration_audit', 'qr:<id> product lookups → copy 1 keeps the id');
    const allNew = plan.groups.flatMap((x) => Object.values(x.newIds));
    const maxOf = (sec: 'customers' | 'quickRates') => Math.max(...(SEED as any)[sec].map((x: any) => Number(x.id)));
    ok(plan.groups.every((x) => Object.values(x.newIds).every((n) => Number.isSafeInteger(n) && n > maxOf(x.section))) && new Set(allNew).size === allNew.length, 'new ids are unique safe integers above every existing id in their section', allNew);
    ok(plan.reIdCount === 7 && plan.confirm === 'REPAIR 7 DUPLICATE IDS', 'plan: 7 records get a new id (6 groups)', plan.confirm);

    console.log('\n[2] --diagnose and the dry run are read only');
    let s0 = await state();
    const d = run(['--diagnose']);
    ok(d.code === 0 && /transaction_read_only=on/.test(d.out) && /AMBIGUOUS/.test(d.out) && /customer\.search: 1 call/.test(d.out), 'diagnose lists groups, references and Sally search exposure', d.out.slice(-600));
    const dr = run([]);
    const fp = fpOf(dr.out), confirm = confirmOf(dr.out);
    ok(dr.code === 0 && fp === plan.fingerprint && confirm === plan.confirm && /LEFT UNAPPLIED/.test(dr.out) && /-> new id/.test(dr.out), 'dry run prints the plan, fingerprint and exact apply command', dr.out.slice(-500));
    ok((await state()).fp === s0.fp, 'database unchanged by --diagnose and the dry run');
    ok(!d.out.includes(URL_) && !dr.out.includes(URL_) && !/postgres(ql)?:\/\//.test(d.out + dr.out), 'no connection string printed');

    console.log('\n[3] apply refuses anything but the reviewed plan');
    let r = run(['--apply', `--confirm=${confirm}`, '--expect=0000000000000000']);
    ok(r.code === 1 && /no longer matches the reviewed dry run/.test(r.out), 'wrong --expect → refused', r.out.slice(-300));
    r = run(['--apply', '--confirm=REPAIR 5 DUPLICATE IDS', `--expect=${fp}`]);
    ok(r.code === 1 && /--confirm must be exactly/.test(r.out), 'wrong --confirm → refused');
    // concurrent change: someone edits Kanya's phone after the review
    await pool.query(`UPDATE platform_state SET data = jsonb_set(data, '{customers,2,tel}', '"083 999"') WHERE id = 1`);
    s0 = await state();
    r = run(['--apply', `--confirm=${confirm}`, `--expect=${fp}`]);
    ok(r.code === 1 && /no longer matches/.test(r.out) && (await state()).fp === s0.fp, 'a record changed after the dry run → apply refused, nothing written');
    await seed();
    // the re-seed created new rel/integration rows, so the plan is reviewed again
    const dr2 = run([]); const fp2 = fpOf(dr2.out);
    ok(!!fp2 && fp2 !== fp && confirmOf(dr2.out) === confirm, 'reference rows changed → a new fingerprint (the old one would be refused)', dr2.out.split('\n').filter((l) => /LEFT UNAPPLIED|DRY RUN/.test(l)));
    s0 = await state();
    // lock contention: a save holds platform_state
    const blocker = await pool.connect();
    await blocker.query('BEGIN'); await blocker.query('SELECT 1 FROM platform_state WHERE id = 1 FOR UPDATE');
    r = run(['--apply', `--confirm=${confirm}`, `--expect=${fp2}`, '--lock-timeout=2']);
    await blocker.query('ROLLBACK'); blocker.release();
    ok(r.code === 1 && /lock timeout/i.test(r.out) && (await state()).fp === s0.fp, 'platform_state locked by a save → stops after --lock-timeout, nothing written', r.out.slice(-300));
    // forced failure after the writes began → full rollback
    await pool.query(`CREATE OR REPLACE FUNCTION repair_test_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'repair-test forced failure'; END $$ LANGUAGE plpgsql`);
    await pool.query(`CREATE TRIGGER repair_test_fail BEFORE UPDATE ON rel_customers FOR EACH ROW EXECUTE FUNCTION repair_test_fail()`);
    r = run(['--apply', `--confirm=${confirm}`, `--expect=${fp2}`]);
    await pool.query(`DROP TRIGGER repair_test_fail ON rel_customers`); await pool.query(`DROP FUNCTION repair_test_fail()`);
    const files = fs.readdirSync(WORK);
    ok(r.code === 1 && /forced failure/.test(r.out) && (await state()).fp === s0.fp, 'a failure after platform_state was written → everything rolled back (data, rel rows, backups)', r.out.slice(-300));
    ok(files.some((f) => /-NOT-APPLIED\.json$/.test(f)), 'the local plan file is marked NOT-APPLIED', files);

    console.log('\n[4] apply');
    r = run(['--apply', `--confirm=${confirm}`, `--expect=${fp2}`]);
    const s1 = await state();
    ok(r.code === 0 && /APPLIED\s+7 record\(s\) got a new id in 6 group\(s\); 2 group\(s\) left unapplied/.test(r.out), 'apply: 7 records in 6 groups, 2 groups left unapplied', r.out.slice(-700));
    ok(s1.backups === s0.backups + 2, 'two backup rows written (whole row + plan)');
    const C = s1.data.customers, Qr = s1.data.quickRates;
    ok(C.length === SEED.customers.length && stable(C.map(({ id, ...x }: any) => x)) === stable(SEED.customers.map(({ id, ...x }: any) => x)), 'every customer kept, in order, with every field unchanged');
    ok(Qr.length === SEED.quickRates.length && stable(Qr.map(({ id, ...x }: any) => x)) === stable(SEED.quickRates.map(({ id, ...x }: any) => x)), 'every quick rate kept (incl. both identical copies), fields unchanged');
    ok(C[1].id === C1 && Number.isInteger(C[2].id) && C[2].companyName === 'Kanya Cingwane', 'lloyd keeps 1777789993569.4546; Kanya has a new integer id', [C[1].id, C[2].id]);
    ok(C[4].id === 5001 && C[3].id !== 5001, 'Beta keeps 5001 (its rel row and Sally mapping stay correct), Alpha re-id\'d');
    ok(C[5].id === 5002 && C[6].id === 5002 && C[9].id === 5004 && C[10].id === 5004, 'ambiguous groups untouched');
    ok(s1.data.quotes[0].customerId === C[8].id && s1.data.quotes[0].lines[0].id === 5003 && C[7].id === 5003, 'the quote naming Zeta now carries Zeta\'s new id; the line id 5003 is untouched');
    const kappa = s1.rel.find((x: any) => x.source_id === String(C[12].id));
    ok(!!kappa && kappa.row_version === 2 && C[11].id === 5005, 'Kappa\'s rel_customers row re-pointed to Kappa\'s new id (row_version bumped); Iota keeps 5005', s1.rel);
    ok(s1.rel.some((x: any) => x.source_id === '5001') && s1.rel.some((x: any) => x.source_id === '5003'), 'the other rel rows keep their source_id');
    ok(Qr[1].id === Q1 && new Set(Qr.map((x: any) => String(x.id))).size === Qr.length, 'quick rates: copy 1 keeps the id; no id shared any more');
    ok(stable({ ...s1.data, customers: 0, quickRates: 0, quotes: 0, _autoSavedAt: 0 }) === stable({ ...SEED, customers: 0, quickRates: 0, quotes: 0, _autoSavedAt: 0 }) && s1.data.jobs[0].value === 1777789993569.46 && s1.data.jobs[0].stock === 5001 && s1.data.other.price === 0.1, 'every other section byte-identical (numbers too)');
    ok(typeof s1.data._autoSavedAt === 'string', '_autoSavedAt stamped so open dashboards pick the change up');
    const applied = fs.readdirSync(WORK).filter((f) => /^id-collision-repair-.*\.json$/.test(f) && !/NOT-APPLIED/.test(f));
    const doc = applied.length ? JSON.parse(fs.readFileSync(path.join(WORK, applied[0]), 'utf8')) : null;
    ok(!!doc && /^APPLIED/.test(doc.status) && doc.groups.length === 6 && doc.leftUnapplied.length === 2, 'local plan file written and marked APPLIED', doc && doc.status);
    ok(!r.out.includes(URL_), 'no connection string printed');

    console.log('\n[5] running again is safe');
    const s2a = await state();
    r = run([]);
    ok(r.code === 0 && /DRY RUN — 0 group\(s\) to repair \(0 record\(s\) get a new id\), 2 left unapplied/.test(r.out), 'dry run now finds only the two unapplied groups', r.out.slice(-300));
    r = run(['--apply', `--confirm=${confirm}`, `--expect=${fp2}`]);
    ok(r.code === 0 && /Nothing to apply/.test(r.out) && (await state()).fp === s2a.fp, 'apply again: nothing to apply, nothing written');

    const BASE = process.env.TEST_SERVER_URL_WITH_AUTHORITY;
    if (BASE) {
      console.log('\n[6] the dashboard save path after the repair');
      const lg = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: process.env.TEST_LOGIN_EMAIL || 'test@signacore.local', password: process.env.TEST_LOGIN_PASSWORD || 'testpass' }) });
      const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ((await lg.json()) as any).token };
      const cur: any = await (await fetch(`${BASE}/api/platform-state`, { headers: H })).json();
      const edited = { ...cur.data, _baseRevision: cur.updated_at, customers: cur.data.customers.map((x: any) => x.companyName === 'Kanya Cingwane' ? { ...x, notes: 'edited after repair' } : x) };
      const put = await fetch(`${BASE}/api/platform-state`, { method: 'PUT', headers: H, body: JSON.stringify({ data: edited }) });
      const s3 = await state();
      ok(put.status === 200 && s3.data.customers.find((x: any) => x.companyName === 'Kanya Cingwane').notes === 'edited after repair', 'Kanya (previously un-editable) can now be edited and saved', put.status);
      const cur2: any = await (await fetch(`${BASE}/api/platform-state`, { headers: H })).json();
      const stale = { ...cur2.data, _baseRevision: cur2.updated_at, customers: SEED.customers };
      const put2 = await fetch(`${BASE}/api/platform-state`, { method: 'PUT', headers: H, body: JSON.stringify({ data: stale }) });
      ok(put2.status >= 400 && (await state()).fp === s3.fp, 'a stale tab still holding the old duplicate ids is refused (nothing lost)', put2.status);
    } else console.log('\n[6] skipped (TEST_SERVER_URL_WITH_AUTHORITY not set)');
  } finally {
    await pool.query(`DELETE FROM integration_records WHERE client_id = 'repair-test'`).catch(() => undefined);
    await pool.query(`DELETE FROM integration_idempotency WHERE client_id = 'repair-test'`).catch(() => undefined);
    await pool.query(`DELETE FROM integration_audit WHERE client_id = 'repair-test'`).catch(() => undefined);
    await pool.query(`DELETE FROM rel_customers WHERE company_name IN ('Kappa','Beta Ltd','Epsilon')`).catch(() => undefined);
    await pool.query(`UPDATE platform_state SET data = $1::jsonb WHERE id = 1`, [JSON.stringify(psBefore ? psBefore.data : {})]);
    fs.rmSync(WORK, { recursive: true, force: true });
  }
}
main().then(async () => { await pool.end(); console.log(`\n${passed} passed, ${failures} failed`); process.exit(failures ? 1 : 0); })
  .catch(async (e) => { console.error('FATAL', e); await pool.end().catch(() => undefined); process.exit(1); });
