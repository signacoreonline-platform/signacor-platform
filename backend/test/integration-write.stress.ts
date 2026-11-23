/**
 * integration-write.stress.ts — owner WRITE access (/api/v1/integration/write/*, migration 020, writeRoutes.ts).
 *
 * Runs the real integration router against a DISPOSABLE local database (name must end in _test; apply migrations
 * first):
 *
 *   DATABASE_URL=postgres://.../signacore_test npx ts-node --transpile-only test/integration-write.stress.ts
 *
 * Covers: only an owner-writer may write and only there; company boundary; allow-lists; X-Confirmed-By; optimistic
 * concurrency (STALE_VERSION); idempotent replay and key reuse; draft PO creation with names/costs from inventory;
 * PO status only from draft; DB constraints that keep the reader and Sally away from owner write scopes; audit rows.
 * All data and secrets below are invented.
 */
process.env.TZ = 'UTC';
process.env.RELATIONAL_AUTHORITY_ENABLED = 'true';
process.env.INTEGRATION_API_ENABLED = 'true';

import express from 'express';
import type { AddressInfo } from 'net';
import pool from '../src/db/pool';
import router from '../src/integration/router';
import { hashSecret } from '../src/integration/keys';
import { OWNER_WRITE_SCOPES, OWNER_READ_SCOPES } from '../src/integration/scopes';

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 700) : ''}`); }
}

const WRITER = 'test-secret-writer-0123456789abcdefghijklmnopqrstuvwxy';
const READER = 'test-secret-reader-0123456789abcdefghijklmnopqrstuvwxy';
const SALLY = 'test-secret-sally-0123456789abcdefghijklmnopqrstuvwxyz';
let base = '';

async function call(method: string, p: string, o: { client?: string; secret?: string; body?: unknown; key?: string; confirmed?: string | null } = {}) {
  const headers: Record<string, string> = {
    'X-Integration-Client': o.client || 'core-agents-writer-test', Authorization: `Bearer ${o.secret || WRITER}`, 'Content-Type': 'application/json',
  };
  if (o.key) headers['Idempotency-Key'] = o.key;
  if (o.confirmed !== null) headers['X-Confirmed-By'] = o.confirmed || 'Ockert Smit <owner@test.invalid> · approval #1';
  const res = await fetch(`${base}/api/v1/integration${p}`, { method, headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* empty */ }
  return { status: res.status, body: json, headers: res.headers };
}

async function seed() {
  const db = (await pool.query('SELECT current_database() AS d')).rows[0].d as string;
  if (!db.endsWith('_test')) throw new Error(`Refusing to run against "${db}" — use a *_test database.`);
  await pool.query(`TRUNCATE integration_audit, integration_idempotency, integration_records, integration_clients RESTART IDENTITY`);
  const rel = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'rel\\_%' AND tablename NOT IN ('rel_companies')`);
  await pool.query(`TRUNCATE ${rel.rows.map((r) => r.tablename).join(', ')} RESTART IDENTITY CASCADE`);
  await pool.query(`UPDATE relational_cutover SET enabled = (section IN ('jobs','purchaseOrders','accInvoices','inventory','quotes','suppliers'))`);
  await pool.query(`INSERT INTO integration_clients (client_id, display_name, secret_hash, scopes, company_code, owner_writer, write_company_codes) VALUES ($1,$2,$3,$4,'2',TRUE,$5)`,
    ['core-agents-writer-test', 'CORE-AGENTS writer (test)', hashSecret(WRITER), [...OWNER_WRITE_SCOPES], ['2']]);
  await pool.query(`INSERT INTO integration_clients (client_id, display_name, secret_hash, scopes, company_code, read_only, read_company_codes) VALUES ($1,$2,$3,$4,'2',TRUE,$5)`,
    ['core-agents-reader-test', 'CORE-AGENTS reader (test)', hashSecret(READER), [...OWNER_READ_SCOPES], ['1', '2']]);
  await pool.query(`INSERT INTO integration_clients (client_id, display_name, secret_hash, scopes, company_code) VALUES ($1,$2,$3,$4,'2')`,
    ['sally-test', 'Sally (test)', hashSecret(SALLY), ['customer:read', 'quote:read', 'quote:create']]);
  await pool.query(`INSERT INTO rel_suppliers (id, source_id, name) VALUES (701, '701', 'Coil Supplier (test)')`);
  await pool.query(`INSERT INTO rel_inventory_items (id, source_id, sku, name, unit, cost, sell) VALUES (801, '801', 'ACR-3', 'Acrylic 3mm (test)', 'sheet', 412.5, 690)`);
  await pool.query(`INSERT INTO rel_jobs (id, source_id, job_number, company_code, customer_name_raw, status, stage, due_date, notes) VALUES
     (901, '901', 'SNS-09001', '2', 'Write Test Client', 'in_production', 4, '2026-12-01', 'Original note'),
     (902, '902', 'SNS-09002', '1', 'Other Company Client', 'in_production', 4, '2026-12-05', null)`);
  await pool.query(`INSERT INTO rel_purchase_orders (id, source_id, po_number, company_code, supplier_id, status, notes, order_date) VALUES
     (951, '951', 'PO-0951', '2', 701, 'draft', null, '2026-11-01'), (952, '952', 'PO-0952', '2', 701, 'approved', null, '2026-10-01')`);
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/integration', router);
  const server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await seed();

    console.log('— who may write');
    let r = await call('GET', '/status');
    ok(r.status === 200 && r.body.client.ownerWriter === true && JSON.stringify(r.body.client.writeCompanies) === '["2"]', 'writer authenticates; owner-writer for company 2', r.body?.client);
    r = await call('GET', '/read/jobs');
    ok(r.status === 403 && r.body.error.code === 'OWNER_WRITER_ONLY', 'writer cannot use the read API', r.body);
    r = await call('GET', '/write/capabilities', { client: 'core-agents-reader-test', secret: READER });
    ok(r.status === 403 && r.body.error.code === 'NOT_OWNER_WRITER', 'the read-only reader cannot use the write API', r.body);
    r = await call('GET', '/write/jobs/901', { client: 'sally-test', secret: SALLY });
    ok(r.status === 403 && r.body.error.code === 'NOT_OWNER_WRITER', 'Sally cannot use the write API', r.body);
    r = await call('GET', '/write/capabilities');
    ok(r.status === 200 && r.body.actions.jobUpdate && r.body.actions.purchaseOrderCreate && r.body.actions.purchaseOrderUpdate, 'capabilities report the writable actions', r.body);

    console.log('— database constraints');
    let refused = false;
    try { await pool.query(`UPDATE integration_clients SET scopes = scopes || ARRAY['jobs:update'] WHERE client_id = 'sally-test'`); } catch { refused = true; }
    ok(refused, 'DB refuses an owner write scope on a non-writer (Sally)');
    refused = false;
    try { await pool.query(`UPDATE integration_clients SET scopes = scopes || ARRAY['purchasing:update'] WHERE client_id = 'core-agents-reader-test'`); } catch { refused = true; }
    ok(refused, 'DB refuses an owner write scope on the read-only reader');
    refused = false;
    try { await pool.query(`UPDATE integration_clients SET scopes = scopes || ARRAY['quote:create'] WHERE client_id = 'core-agents-writer-test'`); } catch { refused = true; }
    ok(refused, 'DB refuses a non-owner write scope on the owner-writer');

    console.log('— job changes');
    r = await call('GET', '/write/jobs/901');
    ok(r.status === 200 && r.body.job.dueDate === '2026-12-01' && r.body.job.rowVersion === 1, 'job read with its writable fields and rowVersion', r.body);
    r = await call('GET', '/write/jobs/902');
    ok(r.status === 404, 'a job in a company outside the write grant is not found', r.body);
    r = await call('PATCH', '/write/jobs/901', { key: 'job-901-a-0001', body: { expectedVersion: 1, dueDate: '2026-12-10' }, confirmed: null });
    ok(r.status === 428 && r.body.error.code === 'CONFIRMATION_REQUIRED', 'a change without X-Confirmed-By is refused', r.body);
    r = await call('PATCH', '/write/jobs/901', { key: 'job-901-a-0001', body: { expectedVersion: 1, stage: 7 } });
    ok(r.status === 403 && r.body.error.code === 'FIELD_NOT_PERMITTED', 'stage changes are not permitted', r.body);
    r = await call('PATCH', '/write/jobs/901', { body: { expectedVersion: 1, dueDate: '2026-12-10' } });
    ok(r.status === 428 && r.body.error.code === 'IDEMPOTENCY_KEY_REQUIRED', 'a change without Idempotency-Key is refused', r.body);
    r = await call('PATCH', '/write/jobs/901', { key: 'job-901-a-0001', body: { expectedVersion: 1, dueDate: '2026-12-10', notes: 'Agreed with client (test)' } });
    ok(r.status === 200 && r.body.job.dueDate === '2026-12-10' && r.body.job.notes === 'Agreed with client (test)' && r.body.job.rowVersion === 2, 'due date and notes changed through updateJob; rowVersion bumped', r.body);
    const again = await call('PATCH', '/write/jobs/901', { key: 'job-901-a-0001', body: { expectedVersion: 1, dueDate: '2026-12-10', notes: 'Agreed with client (test)' } });
    ok(again.status === 200 && again.headers.get('idempotent-replayed') === 'true' && again.body.job.rowVersion === 2, 'the same request again is replayed, not applied twice', again.body);
    r = await call('PATCH', '/write/jobs/901', { key: 'job-901-a-0001', body: { expectedVersion: 1, dueDate: '2026-12-11' } });
    ok(r.status === 422 && r.body.error.code === 'IDEMPOTENCY_KEY_REUSED', 'the same key with different values is refused', r.body);
    r = await call('PATCH', '/write/jobs/901', { key: 'job-901-b-0001', body: { expectedVersion: 1, dueDate: '2026-12-12' } });
    ok(r.status === 409 && r.body.error.code === 'STALE_VERSION', 'a stale expectedVersion is refused (record changed meanwhile)', r.body);
    const j = (await pool.query(`SELECT due_date::text AS d, row_version FROM rel_jobs WHERE id = 901`)).rows[0];
    ok(j.d === '2026-12-10' && j.row_version === 2, 'the database holds exactly one applied change', j);
    r = await call('PATCH', '/write/jobs/902', { key: 'job-902-a-0001', body: { expectedVersion: 1, notes: 'x' } });
    ok(r.status === 404, 'a job in another company cannot be changed', r.body);

    console.log('— purchase orders');
    r = await call('POST', '/write/purchase-orders', { key: 'po-new-0001', body: { companyCode: '2', supplierId: 701, items: [{ inventoryItemId: 801, qty: 5, unitCost: 1 }] } });
    ok(r.status === 403 && r.body.error.code === 'FIELD_NOT_PERMITTED', 'a caller-supplied cost is refused', r.body);
    r = await call('POST', '/write/purchase-orders', { key: 'po-new-0001', body: { companyCode: '1', supplierId: 701, items: [{ inventoryItemId: 801, qty: 5 }] } });
    ok(r.status === 403 && r.body.error.code === 'COMPANY_NOT_AUTHORISED', 'a PO for a company outside the grant is refused', r.body);
    r = await call('POST', '/write/purchase-orders', { key: 'po-new-0002', body: { companyCode: '2', supplierId: 701, jobId: 901, notes: 'For SNS-09001 (test)', items: [{ inventoryItemId: 801, qty: 5 }] } });
    ok(r.status === 201 && r.body.purchaseOrder.status === 'draft' && r.body.purchaseOrder.lines === 1 && r.body.purchaseOrder.supplier === 'Coil Supplier (test)', 'a DRAFT purchase order is created through createPurchaseOrder', r.body);
    const line = (await pool.query(`SELECT name, unit_cost::float AS c, qty_ordered::float AS q FROM rel_purchase_order_items WHERE po_id = $1`, [r.body?.purchaseOrder?.id])).rows[0];
    ok(line?.name === 'Acrylic 3mm (test)' && line?.c === 412.5 && line?.q === 5, 'line name and cost come from the inventory record', line);
    const poCount = Number((await pool.query(`SELECT count(*) FROM rel_purchase_orders`)).rows[0].count);
    r = await call('POST', '/write/purchase-orders', { key: 'po-new-0002', body: { companyCode: '2', supplierId: 701, jobId: 901, notes: 'For SNS-09001 (test)', items: [{ inventoryItemId: 801, qty: 5 }] } });
    ok(r.status === 201 && r.headers.get('idempotent-replayed') === 'true' && Number((await pool.query(`SELECT count(*) FROM rel_purchase_orders`)).rows[0].count) === poCount, 'a retried create is replayed and creates no second PO', r.body);
    r = await call('PATCH', '/write/purchase-orders/952', { key: 'po-952-a-0001', body: { expectedVersion: 1, status: 'declined' } });
    ok(r.status === 409 && r.body.error.code === 'STATUS_NOT_CHANGEABLE', 'an approved PO cannot be declined through the API', r.body);
    r = await call('PATCH', '/write/purchase-orders/951', { key: 'po-951-a-0001', body: { expectedVersion: 1, status: 'received' } });
    ok(r.status === 400, 'an unknown status is refused', r.body);
    r = await call('PATCH', '/write/purchase-orders/951', { key: 'po-951-a-0002', body: { expectedVersion: 1, status: 'approved', notes: 'Ordered by phone (test)' } });
    ok(r.status === 200 && r.body.purchaseOrder.status === 'approved' && r.body.purchaseOrder.rowVersion === 2, 'a draft PO is approved through updatePurchaseOrder', r.body);

    console.log('— audit');
    const a = (await pool.query(`SELECT operation, outcome, confirmed_by, idempotency_key FROM integration_audit WHERE client_id = 'core-agents-writer-test' AND is_mutation ORDER BY id`)).rows;
    ok(a.some((x) => x.operation === 'write.job.update' && x.outcome === 'success' && /approval #1/.test(x.confirmed_by || '')), 'the applied job change is audited with the owner confirmation', a);
    ok(a.some((x) => x.operation === 'write.job.update' && x.outcome === 'replayed'), 'the replay is audited as replayed');
    ok(a.some((x) => x.outcome === 'denied' || x.outcome === 'rejected'), 'refused writes are audited');
  } finally {
    server.close();
    await pool.end();
  }
  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
