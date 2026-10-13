/**
 * integration-customers.stress.ts — narrow customer writes through
 * /api/v1/integration (customer:create / customer:update).
 *
 * Runs the real router against a DISPOSABLE local database (DATABASE_URL must
 * name a database ending in _test — refused otherwise). Apply migrations first
 * (including 017_integration_customer_records.sql):
 *
 *   DATABASE_URL=postgres://.../signacore_test npm run test:integration-customers
 *
 * Uses invented test data only. Never point this at production.
 */
process.env.RELATIONAL_AUTHORITY_ENABLED = 'true';
process.env.INTEGRATION_API_ENABLED = 'true';

import express from 'express';
import type { AddressInfo } from 'net';
import pool from '../src/db/pool';
import router from '../src/integration/router';
import { hashSecret } from '../src/integration/keys';
import { customerVersion } from '../src/integration/data';

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : ''}`); }
}

const WRITER_SECRET = 'test-secret-writer-0123456789abcdefghijklmnopqrstuvw';
const READER_SECRET = 'test-secret-reader-0123456789abcdefghijklmnopqrstuvw';
const CREATEONLY_SECRET = 'test-secret-createonly-0123456789abcdefghijklmnopqrs';
const HOLDINGS_SECRET = 'test-secret-holdings-0123456789abcdefghijklmnopqrstu';
let base = '';

async function call(method: string, path: string, opts: { body?: unknown; client?: string; secret?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  headers['X-Integration-Client'] = opts.client || 'sally-writer-test';
  headers.Authorization = `Bearer ${opts.secret || WRITER_SECRET}`;
  const res = await fetch(`${base}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  let json: any = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json, headers: res.headers };
}

async function customers(): Promise<any[]> {
  const r = await pool.query(`SELECT data -> 'customers' AS c FROM platform_state WHERE id = 1`);
  return r.rows[0]?.c || [];
}
async function stateRow() {
  return (await pool.query(`SELECT data, updated_at FROM platform_state WHERE id = 1`)).rows[0];
}
const count = async (sql: string, p: unknown[] = []) => Number((await pool.query(sql, p)).rows[0].n);

async function seed() {
  const db = (await pool.query('SELECT current_database() AS d')).rows[0].d as string;
  if (!db.endsWith('_test')) throw new Error(`Refusing to run against "${db}" — use a *_test database.`);
  await pool.query(`TRUNCATE integration_audit, integration_idempotency, integration_records, integration_clients RESTART IDENTITY`);
  await pool.query(`UPDATE relational_cutover SET enabled = false`);
  const state = {
    customers: [
      { id: 1700000000001, companyName: 'Acme Signs Test (Pty) Ltd', contactPerson: 'Thandi Test', email: 'thandi@acme.test', tel: '044 555 0101', address: '1 Test Street, George', vatNumber: '4000000001', notes: 'INTERNAL-ONLY-NOTE' },
      { id: 1700000000002, companyName: 'Blue Crane Test Cafe', contactPerson: 'Lerato Test', email: 'lerato@bluecrane.test', tel: '082 555 0103', address: '', vatNumber: '', notes: '' },
      // historical id collision (two records, one id) — must never be edited through the API
      { id: 1700000000009, companyName: 'Collision Test A', contactPerson: '', email: '', tel: '', address: '', vatNumber: '', notes: '' },
      { id: 1700000000009, companyName: 'Collision Test B', contactPerson: '', email: '', tel: '', address: '', vatNumber: '', notes: '' },
    ],
    jobs: [{ id: 5001, title: 'UNRELATED JOB MUST SURVIVE' }],
  };
  await pool.query(`INSERT INTO platform_state (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`, [JSON.stringify(state)]);
  const reads = ['customer:read', 'product:read', 'inventory:read', 'pricing:read', 'quote:read'];
  await pool.query(`INSERT INTO integration_clients (client_id, display_name, secret_hash, scopes, company_code) VALUES ('sally-writer-test','Sally writer',$1,$2,'2')`,
    [hashSecret(WRITER_SECRET), [...reads, 'customer:create', 'customer:update', 'customer:delete', 'admin:everything']]);
  await pool.query(`INSERT INTO integration_clients (client_id, display_name, secret_hash, scopes, company_code) VALUES ('sally-reader-test','Sally reader',$1,$2,'2')`,
    [hashSecret(READER_SECRET), [...reads, 'quote:create', 'quote:update']]);
  await pool.query(`INSERT INTO integration_clients (client_id, display_name, secret_hash, scopes, company_code) VALUES ('create-only-test','Create only',$1,$2,'2')`,
    [hashSecret(CREATEONLY_SECRET), ['customer:read', 'customer:create']]);
  await pool.query(`INSERT INTO integration_clients (client_id, display_name, secret_hash, scopes, company_code) VALUES ('holdings-test','Holdings',$1,$2,'1')`,
    [hashSecret(HOLDINGS_SECRET), [...reads, 'customer:create']]);
}

async function main() {
  await seed();
  const app = express();
  app.use(express.json());
  app.use('/api/v1/integration', router);
  const server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/integration`;

  console.log('\n— scopes');
  let r = await call('GET', '/status');
  ok(r.status === 200 && r.body.capabilities.customerCreate === true && r.body.capabilities.customerUpdate === true, 'writer client reports customer create/update capabilities', r.body?.capabilities);
  ok(r.body.capabilities.customerDeletes === false, 'customer deletes are never a capability');
  ok(!r.body.client.scopes.includes('customer:delete') && !r.body.client.scopes.includes('admin:everything'), 'unknown stored scopes (customer:delete, admin:everything) grant nothing', r.body.client.scopes);
  r = await call('GET', '/status', { client: 'sally-reader-test', secret: READER_SECRET });
  ok(r.body.capabilities.customerCreate === false && r.body.capabilities.customerUpdate === false, 'read/quote client has no customer write capability');

  r = await call('POST', '/customers', { client: 'sally-reader-test', secret: READER_SECRET, body: { companyName: 'Reader Should Fail' }, headers: { 'Idempotency-Key': 'reader-create-001' } });
  ok(r.status === 403 && r.body.error.code === 'FORBIDDEN_SCOPE', 'customer:create scope required (read-only client denied)', r.body);
  const acme = (await customers()).find((c) => c.id === 1700000000001);
  r = await call('PATCH', '/customers/1700000000001', { client: 'sally-reader-test', secret: READER_SECRET, body: { expectedVersion: customerVersion(acme), email: 'x@acme.test' }, headers: { 'Idempotency-Key': 'reader-update-001' } });
  ok(r.status === 403 && r.body.error.code === 'FORBIDDEN_SCOPE', 'customer:update scope required (read-only client denied)', r.body);
  r = await call('PATCH', '/customers/1700000000001', { client: 'create-only-test', secret: CREATEONLY_SECRET, body: { expectedVersion: customerVersion(acme), email: 'x@acme.test' }, headers: { 'Idempotency-Key': 'createonly-update-001' } });
  ok(r.status === 403, 'customer:create does not imply customer:update (no escalation)', r.body);
  r = await call('POST', '/quotes', { client: 'create-only-test', secret: CREATEONLY_SECRET, body: {}, headers: { 'Idempotency-Key': 'createonly-quote-001' } });
  ok(r.status === 403, 'customer:create does not imply quote:create (no escalation)', r.body);
  ok((await customers()).find((c) => c.id === 1700000000001)?.email === 'thandi@acme.test', 'denied requests changed nothing');

  console.log('\n— no delete / no forbidden fields');
  for (const [m, p] of [['DELETE', '/customers/1700000000001'], ['POST', '/customers/1700000000001/merge'], ['PUT', '/customers/1700000000001']]) {
    r = await call(m, p, { body: {}, headers: { 'Idempotency-Key': 'delete-key-0001' } });
    ok(r.status === 404, `no route: ${m} ${p}`, r.status);
  }
  ok((await customers()).length === 4, 'no customer was deleted');
  r = await call('POST', '/customers', { body: { companyName: 'Notes Test', notes: 'try to write internal notes' }, headers: { 'Idempotency-Key': 'forbidden-notes-01' } });
  ok(r.status === 403 && r.body.error.code === 'FIELD_NOT_PERMITTED', 'internal notes cannot be written', r.body);
  r = await call('POST', '/customers', { body: { companyName: 'Id Test', id: 42 }, headers: { 'Idempotency-Key': 'forbidden-id-0001' } });
  ok(r.status === 403 && r.body.error.code === 'FIELD_NOT_PERMITTED', 'a customer id cannot be chosen by the client', r.body);
  r = await call('POST', '/customers', { body: { companyName: 'Status Test', status: 'inactive' }, headers: { 'Idempotency-Key': 'forbidden-status-1' } });
  ok(r.status === 403, 'status cannot be set');

  console.log('\n— validation');
  r = await call('POST', '/customers', { body: { contactPerson: 'No Company' }, headers: { 'Idempotency-Key': 'invalid-noname-01' } });
  ok(r.status === 400 && r.body.error.code === 'VALIDATION_ERROR', 'company name is required', r.body);
  r = await call('POST', '/customers', { body: { companyName: '   ' }, headers: { 'Idempotency-Key': 'invalid-blank-001' } });
  ok(r.status === 400, 'blank company name refused');
  r = await call('POST', '/customers', { body: { companyName: 'Bad Email Test', email: 'not-an-email' }, headers: { 'Idempotency-Key': 'invalid-email-001' } });
  ok(r.status === 400, 'invalid email refused');
  r = await call('POST', '/customers', { body: { companyName: 'Bad Phone Test', phone: 'call me <script>' }, headers: { 'Idempotency-Key': 'invalid-phone-001' } });
  ok(r.status === 400, 'invalid phone refused');
  r = await call('POST', '/customers', { body: { companyName: 'Unknown Field Test', tradingName: 'x' }, headers: { 'Idempotency-Key': 'invalid-field-001' } });
  ok(r.status === 400, 'unknown fields refused (strict schema)');
  r = await call('POST', '/customers', { body: { companyName: 'No Key Test' } });
  ok(r.status === 428 && r.body.error.code === 'IDEMPOTENCY_KEY_REQUIRED', 'create needs an Idempotency-Key');
  ok((await customers()).length === 4, 'no invalid request wrote a customer');

  console.log('\n— create');
  const before = await stateRow();
  const backupsBefore = await count('SELECT count(*) AS n FROM platform_state_backups');
  const newCust = { externalRef: 'SAL-C-0001', companyName: 'Protea Test Bakery', contactPerson: 'Anelda Test', email: 'anelda@protea.test', phone: '021 555 0199', address: '9 Test Road, Paarl', vatNumber: '4999999999' };
  r = await call('POST', '/customers', { body: newCust, headers: { 'Idempotency-Key': 'create-protea-001', 'X-Acting-For': 'sally@signacore.co.za' } });
  ok(r.status === 201 && r.body.created === true, 'customer created', r.body);
  const created = r.body.customer;
  ok(created?.companyName === 'Protea Test Bakery' && created?.phone === '021 555 0199' && /^[a-f0-9]{32}$/.test(created?.version || ''), 'response carries the Signacore id, fields and version', created);
  const stored = (await customers()).find((c) => String(c.id) === created.id);
  ok(stored && stored.tel === '021 555 0199' && stored.notes === '' && typeof stored.id === 'number', 'stored in the dashboard record shape (numeric id, tel, empty notes)', stored);
  const after = await stateRow();
  ok(JSON.stringify(after.data.jobs) === JSON.stringify(before.data.jobs), 'other platform_state sections untouched');
  ok(new Date(after.updated_at).getTime() > new Date(before.updated_at).getTime(), 'platform_state revision bumped (stale dashboard tabs get a conflict)');
  ok(await count('SELECT count(*) AS n FROM platform_state_backups') === backupsBefore + 1, 'backup written before the change');
  ok(await count(`SELECT count(*) AS n FROM integration_records WHERE record_type='customer' AND record_id=$1 AND idempotency_key='create-protea-001'`, [created.id]) === 1, 'ownership + idempotency key recorded with the customer');

  console.log('\n— idempotent create');
  r = await call('POST', '/customers', { body: newCust, headers: { 'Idempotency-Key': 'create-protea-001' } });
  ok(r.status === 201 && r.body.customer.id === created.id && r.headers.get('idempotent-replayed') === 'true', 'same key replays the same customer', r.body);
  ok((await customers()).filter((c) => c.companyName === 'Protea Test Bakery').length === 1, 'no second customer');
  r = await call('POST', '/customers', { body: { ...newCust, contactPerson: 'Someone Else' }, headers: { 'Idempotency-Key': 'create-protea-001' } });
  ok(r.status === 422 && r.body.error.code === 'IDEMPOTENCY_KEY_REUSED', 'same key with a different body refused');
  // Lost response: the idempotency row is stuck in progress but the customer + ownership row committed together.
  await pool.query(`UPDATE integration_idempotency SET state='in_progress', response_status=NULL, response_body=NULL, updated_at = NOW() - INTERVAL '5 minutes' WHERE idempotency_key='create-protea-001'`);
  r = await call('POST', '/customers', { body: newCust, headers: { 'Idempotency-Key': 'create-protea-001' } });
  ok(r.status === 201 && r.body.customer.id === created.id, 'stale in-progress create recovered from the ownership record (no duplicate)', r.body);
  ok((await customers()).filter((c) => c.companyName === 'Protea Test Bakery').length === 1, 'still exactly one customer after recovery');

  console.log('\n— duplicate safety (never merged)');
  r = await call('POST', '/customers', { body: { companyName: 'protea test  bakery', email: 'other@protea.test' }, headers: { 'Idempotency-Key': 'dupe-name-00001' } });
  ok(r.status === 409 && r.body.error.code === 'POSSIBLE_DUPLICATE' && r.body.error.details.candidates[0].id === created.id
    && r.body.error.details.candidates[0].matchedOn.includes('company_name'), 'exact normalised company name → possible duplicate with candidate', r.body);
  r = await call('POST', '/customers', { body: { companyName: 'Totally Different Name', email: 'THANDI@acme.test' }, headers: { 'Idempotency-Key': 'dupe-email-0001' } });
  ok(r.status === 409 && r.body.error.details.candidates.some((c: any) => c.id === '1700000000001' && c.matchedOn.includes('email')), 'email match → possible duplicate', r.body);
  r = await call('POST', '/customers', { body: { companyName: 'VAT Match Co', vatNumber: '4000 000 001' }, headers: { 'Idempotency-Key': 'dupe-vat-000001' } });
  ok(r.status === 409 && r.body.error.details.candidates.some((c: any) => c.matchedOn.includes('vat_number')), 'VAT number match → possible duplicate');
  r = await call('POST', '/customers', { body: { companyName: 'Phone Match Co', phone: '+27 82 555 0103' }, headers: { 'Idempotency-Key': 'dupe-phone-0001' } });
  ok(r.status === 409 && r.body.error.details.candidates.some((c: any) => c.id === '1700000000002' && c.matchedOn.includes('phone')), 'phone match (+27 vs 0 prefix) → possible duplicate');
  // Ambiguous: matches TWO existing customers on different signals.
  r = await call('POST', '/customers', { body: { companyName: 'Blue Crane Test Cafe', email: 'thandi@acme.test' }, headers: { 'Idempotency-Key': 'dupe-ambig-0001' } });
  ok(r.status === 409 && r.body.error.details.candidates.length === 2, 'ambiguous match returns every candidate for the user to choose', r.body);
  r = await call('POST', '/customers', { body: { companyName: 'Blue Crane Test Cafe', email: 'thandi@acme.test', allowDuplicateOf: ['1700000000002'] }, headers: { 'Idempotency-Key': 'dupe-ambig-0002', 'X-Confirmed-By': 'sally@signacore.co.za' } });
  ok(r.status === 409 && r.body.error.code === 'POSSIBLE_DUPLICATE', 'acknowledging only ONE of two candidates is not enough', r.body);
  r = await call('POST', '/customers', { body: { companyName: 'Blue Crane Test Cafe', allowDuplicateOf: ['1700000000002'] }, headers: { 'Idempotency-Key': 'dupe-confirm-001' } });
  ok(r.status === 428 && r.body.error.code === 'CONFIRMATION_REQUIRED', 'creating a confirmed duplicate needs X-Confirmed-By', r.body);
  const countBefore = (await customers()).length;
  r = await call('POST', '/customers', { body: { companyName: 'Blue Crane Test Cafe', allowDuplicateOf: ['1700000000002'] }, headers: { 'Idempotency-Key': 'dupe-confirm-002', 'X-Confirmed-By': 'sally@signacore.co.za' } });
  ok(r.status === 201 && r.body.customer.id !== '1700000000002', 'explicitly confirmed separate customer is created (never merged)', r.body);
  ok((await customers()).length === countBefore + 1, 'exactly one record added');
  ok((await customers()).find((c) => c.id === 1700000000002)?.companyName === 'Blue Crane Test Cafe', 'the existing customer was not modified');

  console.log('\n— update');
  let detail = (await call('GET', `/customers/${created.id}`)).body.customer;
  ok(detail.version === created.version, 'GET returns the same version token');
  r = await call('PATCH', `/customers/${created.id}`, { body: { expectedVersion: detail.version, email: 'orders@protea.test', address: '10 Test Road, Paarl' }, headers: { 'Idempotency-Key': 'update-protea-001' } });
  ok(r.status === 200 && r.body.customer.email === 'orders@protea.test' && r.body.customer.version !== detail.version, 'customer updated; new version returned', r.body);
  const updated = (await customers()).find((c) => String(c.id) === created.id);
  ok(updated.notes === '' && updated.companyName === 'Protea Test Bakery' && updated.tel === '021 555 0199', 'unchanged fields (and notes) preserved');
  r = await call('PATCH', `/customers/${created.id}`, { body: { expectedVersion: detail.version, contactPerson: 'Stale Editor' }, headers: { 'Idempotency-Key': 'update-protea-002' } });
  ok(r.status === 409 && r.body.error.code === 'STALE_VERSION', 'stale version refused (no last-write-wins)', r.body);
  // A dashboard edit of internal notes does NOT invalidate the version (notes are not integration data).
  const cur = (await call('GET', '/customers/1700000000001')).body.customer;
  const st = await stateRow();
  st.data.customers = st.data.customers.map((c: any) => (c.id === 1700000000001 ? { ...c, notes: 'changed in dashboard' } : c));
  await pool.query(`UPDATE platform_state SET data = $1 WHERE id = 1`, [JSON.stringify(st.data)]);
  r = await call('PATCH', '/customers/1700000000001', { body: { expectedVersion: cur.version, contactPerson: 'Thandi Updated' }, headers: { 'Idempotency-Key': 'update-acme-0001' } });
  ok(r.status === 200, 'a notes-only dashboard change does not block an integration update', r.body);
  ok((await customers()).find((c) => c.id === 1700000000001)?.notes === 'changed in dashboard', 'internal notes preserved exactly');
  r = await call('PATCH', '/customers/1700000000001', { body: { expectedVersion: r.body.customer.version, notes: 'x' }, headers: { 'Idempotency-Key': 'update-acme-0002' } });
  ok(r.status === 403 && r.body.error.code === 'FIELD_NOT_PERMITTED', 'notes cannot be updated');
  detail = (await call('GET', '/customers/1700000000001')).body.customer;
  r = await call('PATCH', '/customers/1700000000001', { body: { expectedVersion: detail.version, companyName: '' }, headers: { 'Idempotency-Key': 'update-acme-0003' } });
  ok(r.status === 400, 'company name cannot be blanked');
  r = await call('PATCH', '/customers/1700000000001', { body: { expectedVersion: detail.version, companyName: 'Protea Test Bakery' }, headers: { 'Idempotency-Key': 'update-acme-0004' } });
  ok(r.status === 409 && r.body.error.code === 'POSSIBLE_DUPLICATE', 'renaming onto another customer\'s name is a possible duplicate');
  r = await call('PATCH', '/customers/1700000000009', { body: { expectedVersion: '0'.repeat(32), email: 'a@b.test' }, headers: { 'Idempotency-Key': 'update-collision-1' } });
  ok(r.status === 409 && r.body.error.code === 'AMBIGUOUS_CUSTOMER_ID', 'a historically duplicated id is never edited', r.body);
  r = await call('PATCH', '/customers/999999', { body: { expectedVersion: '0'.repeat(32), email: 'a@b.test' }, headers: { 'Idempotency-Key': 'update-missing-01' } });
  ok(r.status === 404, 'unknown customer → 404');
  // Lost update response: recovery returns the record only if it already holds the requested values.
  await pool.query(`UPDATE integration_idempotency SET state='in_progress', response_status=NULL, response_body=NULL, updated_at = NOW() - INTERVAL '5 minutes' WHERE idempotency_key='update-protea-001'`);
  r = await call('PATCH', `/customers/${created.id}`, { body: { expectedVersion: created.version, email: 'orders@protea.test', address: '10 Test Road, Paarl' }, headers: { 'Idempotency-Key': 'update-protea-001' } });
  ok(r.status === 200 && r.body.customer.email === 'orders@protea.test', 'stale in-progress update recovered as applied (not re-run, not refused)', r.body);

  console.log('\n— company boundary');
  // Customers are shared across companies in Signacore (no company field exists on the record); quotes stay company-scoped.
  r = await call('POST', '/customers', { client: 'holdings-test', secret: HOLDINGS_SECRET, body: { companyName: 'Holdings Side Test Co' }, headers: { 'Idempotency-Key': 'holdings-create-1' } });
  ok(r.status === 201, 'a client of another company can create a (shared) customer when granted the scope', r.body);
  const hc = (await customers()).find((c) => c.companyName === 'Holdings Side Test Co');
  ok(hc && !('companyCode' in hc) && !('company_code' in hc), 'no company field is invented on the customer record');
  r = await call('GET', '/quotes?mine=true', { client: 'holdings-test', secret: HOLDINGS_SECRET });
  ok(r.status === 403 || r.status === 409 || (r.status === 200 && r.body.results.every((q: any) => q.companyCode !== '2')), 'customer writes do not widen quote access across companies', r.status);

  console.log('\n— cutover authority');
  await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section = 'customers'`);
  r = await call('POST', '/customers', { body: { companyName: 'Cutover Test Co' }, headers: { 'Idempotency-Key': 'cutover-create-01' } });
  ok(r.status === 409 && r.body.error.code === 'SECTION_NOT_WRITABLE', 'customer writes refused when customers are not platform_state-authoritative', r.body);
  await pool.query(`UPDATE relational_cutover SET enabled = false WHERE section = 'customers'`);

  console.log('\n— audit');
  await new Promise((res) => setTimeout(res, 300)); // audit rows are written when each response finishes
  const audits = (await pool.query(`SELECT client_id, operation, outcome, error_code, target_type, target_id, acting_for, idempotency_key FROM integration_audit ORDER BY id`)).rows;
  ok(audits.some((a) => a.operation === 'customer.create' && a.outcome === 'success' && a.target_type === 'customer' && a.target_id === created.id && a.acting_for === 'sally@signacore.co.za'),
    'successful create audited with target and acting-for', audits.filter((a) => a.operation === 'customer.create').slice(0, 3));
  ok(audits.some((a) => a.operation === 'customer.create' && a.outcome === 'replayed'), 'replay audited');
  ok(audits.some((a) => a.client_id === 'sally-reader-test' && a.outcome === 'denied' && a.error_code === 'FORBIDDEN_SCOPE'), 'scope denial audited');
  ok(audits.some((a) => a.operation === 'customer.create' && a.outcome === 'denied' && a.error_code === 'FIELD_NOT_PERMITTED'), 'forbidden-field attempt audited');
  ok(audits.some((a) => a.operation === 'customer.update' && a.outcome === 'rejected' && a.error_code === 'STALE_VERSION'), 'stale update audited');
  ok(!JSON.stringify(audits).includes('Protea Test Bakery'), 'audit never stores request bodies');

  server.close();
  await pool.end();
  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

main().catch(async (e) => { console.error(e); try { await pool.end(); } catch { /* */ } process.exit(1); });
