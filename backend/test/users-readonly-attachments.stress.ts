/**
 * users-readonly-attachments.stress.ts — 2026-11-16.
 *
 * Server-route verification for three changes, over HTTP against a REAL
 * running instance of this backend and a DISPOSABLE database:
 *
 *   A. Admin user creation       POST/GET /api/auth/users, PUT /api/auth/sync-user
 *   B. View-only roles           Factory / Print Room (role `factory`) on EVERY write route
 *   C. Quotation attachments     /api/quote-attachments, against test storage
 *                                (the local provider AND a fake S3 server speaking R2's contract)
 *   D. Quote save regression     one record at the latest revision
 *
 * SAFETY. Everything here is synthetic. The suite REFUSES to start unless the
 * database named in DATABASE_URL ends in "_test", because it truncates tables.
 * It contacts no production system: storage is a temp folder or a fake server
 * on 127.0.0.1, and it sends no email.
 *
 * RUN (Windows PowerShell, from backend\, migrations already applied):
 *   $env:DATABASE_URL = "postgresql://postgres:<pw>@localhost:5432/signacore_test"
 *   npm run test:users-readonly-attachments
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

const dbUrl = process.env.DATABASE_URL || '';
const dbName = (() => { try { return new URL(dbUrl).pathname.replace(/^\//, ''); } catch { return ''; } })();
if (!/_test$/.test(dbName)) {
  console.error(`REFUSING TO RUN: DATABASE_URL must point at a disposable database whose name ends in "_test" (got "${dbName || '(unset)'}").`);
  process.exit(2);
}

const PORT = Number(process.env.TEST_PORT || 3917);
const JWT_SECRET = 'test-only-secret-' + crypto.randomBytes(8).toString('hex');
const STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgr-test-storage-'));
process.env.PORT = String(PORT);
process.env.JWT_SECRET = JWT_SECRET;
process.env.NODE_ENV = 'test';
process.env.RELATIONAL_AUTHORITY_ENABLED = 'true';
process.env.CORS_ORIGIN = 'http://localhost:3000';
delete process.env.FILE_STORAGE_PROVIDER;

/* eslint-disable @typescript-eslint/no-var-requires */
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../src/db/pool').default;
const storage = require('../src/storage');
const { signRequest } = require('../src/storage/s3Signer');
const { R2_KEY_RE } = require('../src/storage/r2Storage');
const app = require('../src/index').default; // listens on PORT as a side effect

const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0, passed = 0;
function ok(cond: unknown, label: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
const section = (t: string) => console.log(`\n[${t}]`);

// Everything the server prints while the suite runs — searched afterwards for secrets.
const captured: string[] = [];
for (const m of ['log', 'warn', 'error', 'info'] as const) {
  const orig = console[m].bind(console);
  (console as any)[m] = (...a: unknown[]) => { captured.push(a.map((x) => (typeof x === 'string' ? x : safeJson(x))).join(' ')); orig(...a); };
}
function safeJson(x: unknown): string { try { return JSON.stringify(x); } catch { return String(x); } }

type Res = { status: number; body: any; headers: Headers; raw: Buffer };
async function call(method: string, url: string, token?: string | null, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Res> {
  const headers: Record<string, string> = { ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: any;
  if (Buffer.isBuffer(body)) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + url, { method, headers, body: payload });
  const raw = Buffer.from(await r.arrayBuffer());
  let parsed: any = null;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch { parsed = null; }
  return { status: r.status, body: parsed, headers: r.headers, raw };
}
async function login(email: string, password = ''): Promise<Res> {
  return call('POST', '/api/auth/login', null, { email, password });
}
const upload = (token: string | null, quoteId: unknown, filename: string, bytes: Buffer, contentType: string) =>
  call('POST', `/api/quote-attachments?quoteId=${encodeURIComponent(String(quoteId))}`, token, bytes,
    { 'Content-Type': contentType, 'X-File-Name': encodeURIComponent(filename) });

// ── Synthetic files ────────────────────────────────────────────────────────
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const JPG_1PX = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const PDF_MIN = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');
/** A file of exactly `size` bytes that still starts with a real signature. */
const padTo = (head: Buffer, size: number) => Buffer.concat([head, crypto.randomBytes(Math.max(0, size - head.length))]).subarray(0, size);
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const MB5 = 5 * 1024 * 1024;

// ── Synthetic accounts (seeded directly; never real people) ────────────────
const PW = { admin: 'Synthetic-Admin-1', holdings: 'Synthetic-Hold-2', accounts: 'Synthetic-Acc-3', assistant: 'Synthetic-Asst-4', holdAsst: 'Synthetic-HAsst-5' };
const SEED: Array<[string, string | null, string, number | null, string]> = [
  ['admin@synthetic.test', PW.admin, 'admin', null, 'Synthetic Admin'],
  ['holdings-admin@synthetic.test', PW.holdings, 'admin', 1, 'Synthetic Holdings Admin'],
  ['accounts@synthetic.test', PW.accounts, 'accounts', null, 'Synthetic Accounts'],
  ['assistant@synthetic.test', PW.assistant, 'assistant', null, 'Synthetic Assistant'],
  ['holdings-assistant@synthetic.test', PW.holdAsst, 'assistant', 1, 'Synthetic Holdings Assistant'],
  ['factory@synthetic.test', null, 'factory', null, 'Factory'],       // passwordless one-tap, as in production
  ['printroom@synthetic.test', null, 'factory', null, 'Print Room'],  // passwordless one-tap, as in production
];

async function resetDatabase() {
  const has = await pool.query(`SELECT to_regclass('public.quote_attachments') AS t, to_regclass('public.app_users') AS u, to_regclass('public.rel_quotes') AS q`);
  if (!has.rows[0].t || !has.rows[0].u || !has.rows[0].q) {
    console.error('Migrations have not been applied to this test database. Run:  npm run build ; npm run migrate');
    process.exit(2);
  }
  await pool.query(`TRUNCATE quote_attachments, app_users RESTART IDENTITY`);
  await pool.query(`TRUNCATE rel_customers, rel_quotes, rel_quote_line_items, rel_jobs, rel_job_line_items, rel_invoices, rel_invoice_line_items, rel_payments RESTART IDENTITY CASCADE`);
  await pool.query(`DELETE FROM quote_conversions`).catch(() => undefined);
  await pool.query(`INSERT INTO platform_state (id, data) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO UPDATE SET data = '{}'::jsonb, updated_at = NOW()`);
  await pool.query(`UPDATE relational_cutover SET enabled = (section IN ('customers','quotes','jobs','accInvoices','payments'))`);
  for (const [email, pw, role, co, name] of SEED) {
    await pool.query(
      `INSERT INTO app_users (account_id, email, password_hash, requires_password, role, co, name) VALUES ($1, $1, $2, $3, $4, $5, $6)`,
      [email, pw ? await bcrypt.hash(pw, 4) : null, !!pw, role, co, name]
    );
  }
}
const count = async (sql: string, params: unknown[] = []) => Number((await pool.query(sql, params)).rows[0].n);

/** Every non-GET route mounted under /api, discovered from the live Express app. */
function discoverWriteRoutes(): Array<{ method: string; path: string }> {
  const mounts = ['/api/auth', '/api/companies', '/api/clients', '/api/jobs', '/api/intercompany', '/api/calculators', '/api/dashboard',
    '/api/inventory', '/api/imports', '/api/platform-state', '/api/document-numbers', '/api/quote-conversions', '/api/relational',
    '/api/full-backup', '/api/freshness', '/api/quote-attachments', '/api/v1/integration'];
  const out: Array<{ method: string; path: string }> = [];
  const walk = (stack: any[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) {
          if (['get', 'head', 'options'].includes(method)) continue;
          const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
          for (const p of paths) out.push({ method: method.toUpperCase(), path: (prefix + (p === '/' ? '' : p)).replace(/:[A-Za-z_]+/g, '1') });
        }
      } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
        const mount = prefix ? null : mounts.find((m) => layer.regexp.test(m));
        walk(layer.handle.stack, prefix || mount || '');
      }
    }
  };
  walk((app as any)._router.stack, '');
  return out;
}

// ── A fake S3 server speaking the part of R2's contract the provider uses ──
const FAKE = { accessKeyId: 'TESTACCESSKEYID0000000000', secretAccessKey: 'test-secret-access-key-0000000000000000000000', bucket: 'signacore-test-bucket' };
function startFakeS3() {
  const objects = new Map<string, { body: Buffer; meta: Record<string, string> }>();
  const log: Array<{ method: string; key: string; signatureOk: boolean; ifNoneMatch?: string; shaHeaderOk?: boolean; md5Ok?: boolean }> = [];
  const mode = { dropNextPutAnswer: false, corruptReads: false };
  const xml = (res: http.ServerResponse, status: number, code: string) => { res.writeHead(status, { 'Content-Type': 'application/xml' }); res.end(`<?xml version="1.0"?><Error><Code>${code}</Code></Error>`); };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url || '/', 'http://x');
      const parts = decodeURIComponent(url.pathname).replace(/^\//, '').split('/');
      const bucket = parts.shift() || '';
      const key = parts.join('/');
      // Recompute the signature exactly as S3 would, from what actually arrived.
      const auth = String(req.headers.authorization || '');
      const signedNames = (/SignedHeaders=([^,]+)/.exec(auth)?.[1] || '').split(';').filter((n) => n !== 'host');
      const hdrs: Record<string, string> = {};
      for (const n of signedNames) if (!n.startsWith('x-amz-date') && n !== 'x-amz-content-sha256') hdrs[n] = String(req.headers[n] || '');
      const amz = String(req.headers['x-amz-date'] || '');
      const date = new Date(amz.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
      const expect = signRequest({ method: req.method || 'GET', host: String(req.headers.host), path: `/${bucket}/${key}`, headers: hdrs,
        payloadHash: String(req.headers['x-amz-content-sha256'] || ''), date, ...FAKE }).headers.Authorization;
      const signatureOk = auth === expect;
      const entry: any = { method: req.method, key, signatureOk };
      log.push(entry);
      if (!auth.includes(`Credential=${FAKE.accessKeyId}/`)) return xml(res, 403, 'InvalidAccessKeyId');
      if (!signatureOk) return xml(res, 403, 'SignatureDoesNotMatch');
      if (bucket !== FAKE.bucket) return xml(res, 404, 'NoSuchBucket');
      const have = objects.get(key);
      if (req.method === 'HEAD') {
        if (!have) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Length': String(have.body.length), ETag: '"e"', 'Content-Type': 'application/octet-stream', ...have.meta });
        return res.end();
      }
      if (req.method === 'GET') {
        if (!have) return xml(res, 404, 'NoSuchKey');
        const out = mode.corruptReads ? Buffer.concat([have.body.subarray(0, have.body.length - 1), Buffer.from([have.body[have.body.length - 1] ^ 0xff])]) : have.body;
        res.writeHead(200, { 'Content-Length': String(out.length), ETag: '"e"', 'Content-Type': 'application/octet-stream', ...have.meta });
        return res.end(out);
      }
      if (req.method === 'PUT') {
        entry.ifNoneMatch = String(req.headers['if-none-match'] || '');
        entry.shaHeaderOk = String(req.headers['x-amz-content-sha256']) === sha(body);
        entry.md5Ok = String(req.headers['content-md5']) === crypto.createHash('md5').update(body).digest('base64');
        if (!entry.shaHeaderOk) return xml(res, 400, 'XAmzContentSHA256Mismatch');
        if (!entry.md5Ok) return xml(res, 400, 'BadDigest');
        if (have && entry.ifNoneMatch === '*') return xml(res, 412, 'PreconditionFailed');
        const meta: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (k.startsWith('x-amz-meta-')) meta[k] = String(v);
        objects.set(key, { body, meta });
        if (mode.dropNextPutAnswer) { mode.dropNextPutAnswer = false; return req.socket.destroy(); } // stored, but the answer is lost
        res.writeHead(200, { ETag: '"e"' });
        return res.end();
      }
      return xml(res, 405, 'MethodNotAllowed');
    });
  });
  return new Promise<{ server: http.Server; port: number; objects: typeof objects; log: typeof log; mode: typeof mode }>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as any).port, objects, log, mode }));
  });
}
function useR2(port: number, secret = FAKE.secretAccessKey) {
  process.env.FILE_STORAGE_PROVIDER = 'r2';
  process.env.R2_ENDPOINT = `http://127.0.0.1:${port}`;
  process.env.R2_BUCKET = FAKE.bucket;
  process.env.R2_ACCESS_KEY_ID = FAKE.accessKeyId;
  process.env.R2_SECRET_ACCESS_KEY = secret;
  storage.resetStorageForTests();
}
function useLocal() {
  process.env.FILE_STORAGE_PROVIDER = 'local';
  process.env.FILE_STORAGE_PATH = STORAGE_DIR;
  storage.resetStorageForTests();
}
function storageOff() { delete process.env.FILE_STORAGE_PROVIDER; storage.resetStorageForTests(); }
const localFiles = () => {
  const out: string[] = [];
  const walk = (d: string) => { if (!fs.existsSync(d)) return; for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (!p.endsWith('.json')) out.push(p); } };
  walk(path.join(STORAGE_DIR, 'files'));
  return out;
};

async function main() {
  await new Promise((r) => setTimeout(r, 400)); // let app.listen bind
  await resetDatabase();

  const T: Record<string, string> = {};
  for (const [k, email, pw] of [['admin', 'admin@synthetic.test', PW.admin], ['holdings', 'holdings-admin@synthetic.test', PW.holdings],
    ['accounts', 'accounts@synthetic.test', PW.accounts], ['assistant', 'assistant@synthetic.test', PW.assistant],
    ['holdAsst', 'holdings-assistant@synthetic.test', PW.holdAsst], ['factory', 'factory@synthetic.test', ''], ['printroom', 'printroom@synthetic.test', '']] as const) {
    const r = await login(email, pw);
    if (r.status !== 200) throw new Error(`seed login failed for ${email}: HTTP ${r.status}`);
    T[k] = r.body.token;
  }

  // ═════════════════════════════════════════════════════════════════════════
  section('A1  an authorised admin can list accounts and see what may be granted');
  {
    const r = await call('GET', '/api/auth/users', T.admin);
    ok(r.status === 200 && Array.isArray(r.body.users) && r.body.users.length === SEED.length, 'GET /api/auth/users lists every account', `HTTP ${r.status}`);
    ok(!/password|hash|\$2[aby]\$/i.test(r.raw.toString('utf8').replace(/"requiresPassword"|"passwordRules"/g, '')), 'the list carries no password or hash of any kind');
    const g = r.body.grantable || [];
    ok(g.length === 2 && g[0].co === null && g[1].co === 1, 'grantable companies are Signacore and Signacore Holdings');
    ok(JSON.stringify(g[0].roles.map((x: any) => x.role)) === '["admin","accounts","assistant","factory"]', 'Signacore roles: admin, accounts, assistant, factory');
    ok(JSON.stringify(g[1].roles.map((x: any) => x.role)) === '["admin","assistant"]', 'Holdings roles: admin, assistant only');
  }

  section('A2  create a user — they can sign in with the chosen role and company');
  const NEW_PW = 'Fresh-Passw0rd-xyz';
  {
    const before = captured.length;
    const r = await call('POST', '/api/auth/users', T.admin, { name: '  New   Assistant ', email: ' New.Assistant@Synthetic.Test ', role: 'assistant', co: null, password: NEW_PW });
    ok(r.status === 201, 'POST /api/auth/users → 201', `HTTP ${r.status} ${safeJson(r.body)}`);
    ok(r.body?.user?.email === 'new.assistant@synthetic.test' && r.body.user.name === 'New Assistant', 'email is lower-cased and trimmed; name is tidied');
    ok(r.body?.user?.role === 'assistant' && r.body.user.co === null && r.body.user.requiresPassword === true, 'role, company and requiresPassword are returned as chosen');
    ok(!r.raw.toString('utf8').includes(NEW_PW) && !/hash/i.test(r.raw.toString('utf8')), 'the response contains neither the password nor a hash');
    const row = (await pool.query(`SELECT * FROM app_users WHERE email = 'new.assistant@synthetic.test'`)).rows[0];
    ok(row && /^\$2[aby]\$12\$/.test(row.password_hash) && row.password_hash !== NEW_PW, 'the password is stored as a bcrypt hash at cost 12, never in plain text');
    ok(row.account_id === row.email && row.requires_password === true && row.is_active === true, 'account_id mirrors the email; the account is active and password-protected');
    ok(!captured.slice(before).some((l) => l.includes(NEW_PW)), 'nothing the server logged during creation contains the password');
    const list = await call('GET', '/api/auth/users', T.admin);
    ok(list.body.users.some((u: any) => u.id === 'new.assistant@synthetic.test'), 'the new account appears in the user list');
    const good = await login('NEW.assistant@synthetic.test', NEW_PW);
    ok(good.status === 200 && good.body.user.role === 'assistant' && good.body.user.co === null, 'the new user signs in and receives role assistant / company Signacore');
    ok((await login('new.assistant@synthetic.test', 'Wrong-Passw0rd')).status === 401, 'a wrong password is refused');
    ok((await login('new.assistant@synthetic.test', '')).status === 401, 'an empty password is refused (the account is not passwordless)');
    const write = await call('POST', '/api/relational/customers', good.body.token, { companyName: 'Created By New Assistant' });
    ok(write.status === 200 || write.status === 201, 'the new assistant can perform an assistant action (create a customer)', `HTTP ${write.status}`);
  }
  {
    const r = await call('POST', '/api/auth/users', T.admin, { name: 'New Holdings Admin', email: 'new.hadmin@synthetic.test', role: 'admin', co: 1, password: NEW_PW });
    const l = await login('new.hadmin@synthetic.test', NEW_PW);
    ok(r.status === 201 && l.status === 200 && l.body.user.role === 'admin' && l.body.user.co === 1, 'a Holdings admin can be created and signs in scoped to Holdings (co 1)');
    ok((await call('GET', '/api/auth/users', l.body.token)).status === 403, '…and that new Holdings admin still cannot manage users');
  }
  {
    const r = await call('POST', '/api/auth/users', T.admin, { name: 'New Print Room', email: 'new.printroom@synthetic.test', role: 'factory', co: null, password: NEW_PW });
    const l = await login('new.printroom@synthetic.test', NEW_PW);
    ok(r.status === 201 && l.status === 200 && l.body.user.role === 'factory', 'a Manufacturing (factory) user can be created with a password and signs in');
    ok((await login('new.printroom@synthetic.test', '')).status === 401, '…a created Manufacturing account is NOT a passwordless one-tap login');
    const w = await call('PUT', '/api/platform-state', l.body.token, { data: { _partial: true, savedCalcs: [] } });
    ok(w.status === 403 && w.body.code === 'READ_ONLY_ROLE', '…and it is view-only from its first request');
  }

  section('A3  server-side validation of required fields, role, company and password');
  {
    const base = { name: 'V User', email: 'v.user@synthetic.test', role: 'assistant', co: null, password: NEW_PW };
    const cases: Array<[string, object, number, string]> = [
      ['missing name', { ...base, name: '   ' }, 400, 'NAME_REQUIRED'],
      ['missing email', { ...base, email: '' }, 400, 'EMAIL_REQUIRED'],
      ['malformed email', { ...base, email: 'not-an-email' }, 400, 'EMAIL_INVALID'],
      ['missing role', { ...base, role: '' }, 400, 'ROLE_REQUIRED'],
      ['unknown role', { ...base, role: 'superuser' }, 400, 'ROLE_NOT_GRANTABLE'],
      ['unknown company', { ...base, co: 7 }, 400, 'COMPANY_NOT_GRANTABLE'],
      ['role not offered for that company (Holdings accounts)', { ...base, role: 'accounts', co: 1 }, 400, 'ROLE_NOT_GRANTABLE'],
      ['role not offered for that company (Holdings factory)', { ...base, role: 'factory', co: 1 }, 400, 'ROLE_NOT_GRANTABLE'],
      ['missing password', { ...base, password: '' }, 400, 'PASSWORD_REQUIRED'],
      ['password too short', { ...base, password: 'Ab1' }, 400, 'PASSWORD_TOO_SHORT'],
      ['password without a number', { ...base, password: 'OnlyLettersHere' }, 400, 'PASSWORD_TOO_WEAK'],
      ['password without a letter', { ...base, password: '1234567890' }, 400, 'PASSWORD_TOO_WEAK'],
      ['password equal to the email', { ...base, email: 'same1@synthetic.test', password: 'same1@synthetic.test' }, 400, 'PASSWORD_TOO_WEAK'],
      ['password longer than bcrypt reads', { ...base, password: 'A1' + 'x'.repeat(80) }, 400, 'PASSWORD_TOO_LONG'],
      ['password with a trailing space', { ...base, password: NEW_PW + ' ' }, 400, 'PASSWORD_WHITESPACE'],
    ];
    const before = await count('SELECT count(*)::int AS n FROM app_users');
    for (const [label, body, status, code] of cases) {
      const r = await call('POST', '/api/auth/users', T.admin, body);
      ok(r.status === status && r.body?.code === code, `${label} → ${status} ${code}`, `HTTP ${r.status} ${safeJson(r.body)}`);
    }
    ok((await count('SELECT count(*)::int AS n FROM app_users')) === before, 'no refused request created an account');
  }

  section('A4  duplicate logins are refused, never overwritten');
  {
    const before = (await pool.query(`SELECT password_hash, role, name FROM app_users WHERE email = 'assistant@synthetic.test'`)).rows[0];
    for (const email of ['assistant@synthetic.test', 'ASSISTANT@Synthetic.Test', ' assistant@synthetic.test ']) {
      const r = await call('POST', '/api/auth/users', T.admin, { name: 'Dup', email, role: 'admin', co: null, password: NEW_PW });
      ok(r.status === 409 && r.body.code === 'DUPLICATE_LOGIN', `duplicate "${email.trim()}" → 409 DUPLICATE_LOGIN`, `HTTP ${r.status}`);
    }
    const after = (await pool.query(`SELECT password_hash, role, name FROM app_users WHERE email = 'assistant@synthetic.test'`)).rows[0];
    ok(safeJson(before) === safeJson(after), 'the existing account is byte-for-byte unchanged (no overwrite, no promotion)');
    ok((await login('assistant@synthetic.test', PW.assistant)).status === 200, '…and still signs in with its own password');
  }

  section('A5  an unauthorised user cannot create accounts or grant access');
  {
    const before = await count('SELECT count(*)::int AS n FROM app_users');
    const body = { name: 'Escalation', email: 'escalation@synthetic.test', role: 'admin', co: null, password: NEW_PW };
    for (const who of ['holdings', 'accounts', 'assistant', 'holdAsst']) {
      const r = await call('POST', '/api/auth/users', T[who], body);
      ok(r.status === 403 && r.body.code === 'NOT_ALLOWED', `${who} cannot create a user → 403 NOT_ALLOWED`, `HTTP ${r.status}`);
      ok((await call('GET', '/api/auth/users', T[who])).status === 403, `${who} cannot list users → 403`);
    }
    for (const who of ['factory', 'printroom']) {
      const r = await call('POST', '/api/auth/users', T[who], body);
      ok(r.status === 403, `${who} cannot create a user → 403`, `HTTP ${r.status}`);
    }
    ok((await call('POST', '/api/auth/users', null, body)).status === 401, 'no token → 401');
    ok((await call('POST', '/api/auth/users', 'not-a-token', body)).status === 401, 'invalid token → 401');
    ok((await count('SELECT count(*)::int AS n FROM app_users')) === before, 'none of those attempts created an account');

    // sync-user used to accept ANY admin token and whatever role/company the body carried.
    const esc = await call('PUT', '/api/auth/sync-user', T.holdings, { accountId: 'holdings-assistant@synthetic.test', email: 'holdings-assistant@synthetic.test', name: 'x', role: 'admin', co: null, password: 'Takeover-Passw0rd' });
    ok(esc.status === 403, 'a Holdings admin can no longer use /sync-user at all → 403', `HTTP ${esc.status}`);
    const made = await call('PUT', '/api/auth/sync-user', T.holdings, { accountId: 'backdoor@synthetic.test', email: 'backdoor@synthetic.test', name: 'x', role: 'admin', co: null, password: 'Takeover-Passw0rd' });
    ok(made.status === 403 && (await count(`SELECT count(*)::int AS n FROM app_users WHERE email = 'backdoor@synthetic.test'`)) === 0, '…nor create an account through it');
    const promote = await call('PUT', '/api/auth/sync-user', T.admin, { accountId: 'assistant@synthetic.test', email: 'assistant@synthetic.test', name: 'Renamed Assistant', role: 'admin', co: 1 });
    const row = (await pool.query(`SELECT role, co, name FROM app_users WHERE account_id = 'assistant@synthetic.test'`)).rows[0];
    ok(promote.status === 200 && row.name === 'Renamed Assistant', 'the main admin can still rename an account through /sync-user');
    ok(row.role === 'assistant' && row.co === null, '…but /sync-user cannot change an existing account\'s role or company');
    ok((await login('assistant@synthetic.test', PW.assistant)).status === 200, '…and a rename leaves the password untouched');
    const bad = await call('PUT', '/api/auth/sync-user', T.admin, { accountId: 'ghost@synthetic.test', email: 'ghost@synthetic.test', name: 'g', role: 'superuser', co: null });
    ok(bad.status === 400 && (await count(`SELECT count(*)::int AS n FROM app_users WHERE email = 'ghost@synthetic.test'`)) === 0, '/sync-user refuses to create an account with an ungrantable role');
  }

  // ═════════════════════════════════════════════════════════════════════════
  section('B1  Factory and Print Room can still VIEW');
  {
    await call('PUT', '/api/platform-state', T.admin, { data: { _partial: true, savedCalcs: [{ id: 'calc-1', name: 'seed' }] } });
    for (const who of ['factory', 'printroom']) {
      const st = await call('GET', '/api/platform-state', T[who]);
      ok(st.status === 200 && st.body && typeof st.body.data === 'object', `${who}: GET /api/platform-state → 200`);
      ok((await call('GET', '/api/relational/sections?names=jobs,quotes', T[who])).status === 200, `${who}: GET /api/relational/sections → 200`);
      ok((await call('GET', '/api/freshness', T[who])).status === 200, `${who}: GET /api/freshness → 200`);
      ok((await call('GET', '/api/relational/status', T[who])).status === 200, `${who}: GET /api/relational/status → 200`);
    }
  }

  section('B2  every write route on the server refuses a view-only login');
  {
    const routes = discoverWriteRoutes().filter((r) => !r.path.startsWith('/api/v1/integration') && !(r.method === 'POST' && r.path === '/api/auth/login'));
    ok(routes.length >= 55, `discovered ${routes.length} write routes from the running app (expected at least 55)`);
    for (const must of ['PUT /api/platform-state', 'POST /api/relational/quotes', 'PUT /api/relational/quotes/1', 'PATCH /api/relational/quotes/1/status',
      'PUT /api/relational/jobs/1', 'DELETE /api/relational/jobs/1', 'POST /api/relational/payments', 'DELETE /api/relational/payments/1',
      'POST /api/relational/invoices', 'POST /api/document-numbers/reserve', 'POST /api/quote-conversions/reserve', 'POST /api/quote-attachments',
      'DELETE /api/quote-attachments/1', 'POST /api/auth/users', 'PUT /api/auth/sync-user', 'POST /api/relational/inventory/1/adjust', 'PATCH /api/jobs/1/status']) {
      ok(routes.some((r) => `${r.method} ${r.path}` === must), `route list includes ${must}`);
    }
    const stateBefore = (await pool.query(`SELECT md5(data::text) AS h, updated_at FROM platform_state WHERE id = 1`)).rows[0];
    const rowsBefore = safeJson((await pool.query(`SELECT (SELECT count(*) FROM rel_customers) c, (SELECT count(*) FROM rel_quotes) q, (SELECT count(*) FROM rel_jobs) j, (SELECT count(*) FROM rel_invoices) i, (SELECT count(*) FROM rel_payments) p, (SELECT count(*) FROM app_users) u, (SELECT count(*) FROM quote_attachments) a`)).rows[0]);
    for (const who of ['factory', 'printroom']) {
      let refused = 0; const leaks: string[] = [];
      for (const r of routes) {
        const res = await call(r.method, r.path, T[who], { data: { _partial: true, jobs: [] }, companyCode: '2', customerNameRaw: 'x', lines: [{ description: 'x', qty: 1, unitPrice: 1 }], status: 'approved', stage: 9, amount: 1 });
        if (res.status === 403 && res.body?.code === 'READ_ONLY_ROLE') refused++; else leaks.push(`${r.method} ${r.path} → ${res.status}`);
      }
      ok(refused === routes.length, `${who}: all ${routes.length} write routes → 403 READ_ONLY_ROLE`, leaks.slice(0, 6).join(' | '));
    }
    const stateAfter = (await pool.query(`SELECT md5(data::text) AS h, updated_at FROM platform_state WHERE id = 1`)).rows[0];
    const rowsAfter = safeJson((await pool.query(`SELECT (SELECT count(*) FROM rel_customers) c, (SELECT count(*) FROM rel_quotes) q, (SELECT count(*) FROM rel_jobs) j, (SELECT count(*) FROM rel_invoices) i, (SELECT count(*) FROM rel_payments) p, (SELECT count(*) FROM app_users) u, (SELECT count(*) FROM quote_attachments) a`)).rows[0]);
    ok(stateBefore.h === stateAfter.h && String(stateBefore.updated_at) === String(stateAfter.updated_at), 'platform_state is byte-identical and its revision did not move');
    ok(rowsBefore === rowsAfter, 'no relational, account or attachment row was created, changed or deleted');
  }

  section('B3  the restriction reaches sessions that already exist, and fails closed');
  {
    const old = jwt.sign({ id: 'factory@synthetic.test', email: 'factory@synthetic.test', role: 'factory', co: null, iat: Math.floor(Date.now() / 1000) - 5 * 86400 }, JWT_SECRET, { expiresIn: '7d' });
    const r = await call('PUT', '/api/platform-state', old, { data: { _partial: true, savedCalcs: [] } });
    ok(r.status === 403 && r.body.code === 'READ_ONLY_ROLE', 'a factory token issued five days ago (before this change) is refused on its next write');
    ok((await call('GET', '/api/platform-state', old)).status === 200, '…and can still read');
    const odd = jwt.sign({ id: 'x', email: 'x@synthetic.test', role: 'Some-Future-Role', co: null }, JWT_SECRET, { expiresIn: '1h' });
    ok((await call('POST', '/api/relational/customers', odd, { companyName: 'x' })).status === 403, 'a role the server does not recognise is view-only (fail-closed)');
    const upper = jwt.sign({ id: 'x', email: 'x@synthetic.test', role: ' FACTORY ', co: null }, JWT_SECRET, { expiresIn: '1h' });
    ok((await call('POST', '/api/relational/customers', upper, { companyName: 'x' })).status === 403, 'role matching ignores case and stray spaces');
  }

  section('B4  authorised users in other roles can still perform their existing actions');
  let custId = 0;
  {
    const a = await call('PUT', '/api/platform-state', T.admin, { data: { _partial: true, savedCalcs: [{ id: 'calc-2', name: 'admin save' }] } });
    ok(a.status === 200, 'admin: partial platform-state save → 200', `HTTP ${a.status} ${safeJson(a.body)}`);
    const c = await call('POST', '/api/relational/customers', T.assistant, { companyName: 'Synthetic Customer (Pty) Ltd' });
    custId = Number(c.body?.id);
    ok((c.status === 200 || c.status === 201) && custId > 0, 'assistant: create a customer', `HTTP ${c.status}`);
    const n = await call('POST', '/api/document-numbers/check', T.accounts, { company: 2, docType: 'invoice', number: 'INV-99999' });
    ok(n.status !== 403 && n.status !== 401, 'accounts: document-number check is not blocked', `HTTP ${n.status}`);
    const h = await call('POST', '/api/relational/customers', T.holdAsst, { companyName: 'Synthetic Holdings Customer' });
    ok(h.status === 200 || h.status === 201, 'Holdings assistant: create a customer', `HTTP ${h.status}`);
    const acc = await call('POST', '/api/relational/customers', T.accounts, { companyName: 'Synthetic Accounts Customer' });
    ok(acc.status === 200 || acc.status === 201, 'accounts: create a customer', `HTTP ${acc.status}`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  const mkQuote = async (token: string, companyCode: string, name: string) => {
    const r = await call('POST', '/api/relational/quotes', token, { companyCode, customerId: custId, customerNameRaw: name, lines: [{ description: 'Synthetic sign panel', qty: 2, unitPrice: 500 }] });
    if (r.status !== 201) throw new Error(`could not create synthetic quote: HTTP ${r.status} ${safeJson(r.body)}`);
    return r.body as { id: any; quoteNumber: string; rowVersion: number };
  };
  const Q1 = await mkQuote(T.assistant, '2', 'Synthetic Customer (Pty) Ltd');   // Signacore
  const Q2 = await mkQuote(T.holdAsst, '1', 'Synthetic Holdings Customer');     // Holdings
  const listFor = (token: string | null, q: any) => call('GET', `/api/quote-attachments?quoteId=${encodeURIComponent(String(q))}`, token);

  section('C1  with no storage configured the feature is off and says so; nothing else is affected');
  {
    storageOff();
    const l = await listFor(T.assistant, Q1.id);
    ok(l.status === 200 && l.body.storage.configured === false && l.body.attachments.length === 0, 'the list reports storage.configured = false');
    const u = await upload(T.assistant, Q1.id, 'logo.png', PNG_1PX, 'image/png');
    ok(u.status === 503 && u.body.code === 'STORAGE_NOT_CONFIGURED', 'an upload answers 503 STORAGE_NOT_CONFIGURED', `HTTP ${u.status}`);
    ok((await count('SELECT count(*)::int AS n FROM quote_attachments')) === 0, 'no attachment row is written without stored bytes');
    ok((await call('GET', '/health')).status === 200, '/health is unaffected');
    process.env.NODE_ENV = 'production'; process.env.FILE_STORAGE_PROVIDER = 'local'; storage.resetStorageForTests();
    const p = await upload(T.assistant, Q1.id, 'logo.png', PNG_1PX, 'image/png');
    ok(p.status === 503 && p.body.code === 'STORAGE_NOT_CONFIGURED', 'the local provider is refused in production (Render disks are ephemeral)');
    process.env.NODE_ENV = 'test';
  }

  section('C2  JPEG, PNG and PDF are accepted, stored and returned intact (test storage: local provider)');
  useLocal();
  const ids: Record<string, number> = {};
  {
    const files: Array<[string, Buffer, string]> = [['site-photo.JPG', JPG_1PX, 'image/jpeg'], ['photo two.jpeg', padTo(JPG_1PX, 40000), 'image/jpeg'], ['logo.png', PNG_1PX, 'image/png'], ['spec sheet (v2).pdf', PDF_MIN, 'application/pdf']];
    for (const [name, bytes, type] of files) {
      const u = await upload(T.assistant, Q1.id, name, bytes, type);
      ok(u.status === 201 && u.body.attachment.filename === name && u.body.attachment.size === bytes.length, `${name} (${type}) → 201 with its name and size`, `HTTP ${u.status} ${safeJson(u.body)}`);
      ids[name] = u.body?.attachment?.id;
      ok(u.body?.attachment && !('storageKey' in u.body.attachment) && !/l_[a-f0-9]{32}|storage_key|storage_provider/.test(u.raw.toString('utf8')), `${name}: the response exposes no storage key or provider`);
      const c = await call('GET', `/api/quote-attachments/${ids[name]}/content`, T.assistant);
      ok(c.status === 200 && sha(c.raw) === sha(bytes), `${name}: content returns the exact bytes`);
      ok(c.headers.get('content-type') === type && c.headers.get('x-content-type-options') === 'nosniff' && /no-store/.test(c.headers.get('cache-control') || ''), `${name}: served with its real type, nosniff and no-store`);
    }
    const d = await call('GET', `/api/quote-attachments/${ids['logo.png']}/content?download=1`, T.assistant);
    ok(/^attachment;/.test(d.headers.get('content-disposition') || ''), '?download=1 is served as a download');
    const exact = await upload(T.assistant, Q1.id, 'exactly-5mb.pdf', padTo(PDF_MIN, MB5), 'application/pdf');
    ok(exact.status === 201 && exact.body.attachment.size === MB5, 'a file of exactly 5 MB is accepted');
    ids['exactly-5mb.pdf'] = exact.body?.attachment?.id;
    const row = (await pool.query('SELECT * FROM quote_attachments WHERE id = $1', [ids['logo.png']])).rows[0];
    ok(row.company_code === '2' && row.quote_source_id === String(Q1.id) && row.quote_number === Q1.quoteNumber, 'metadata is stored against the canonical saved quote: company, source id and number');
    ok(row.sha256 === sha(PNG_1PX) && row.storage_provider === 'local' && row.uploaded_by === 'assistant@synthetic.test', 'the row records the fingerprint, the provider and who uploaded it');
    ok((await upload(T.assistant, String(Q1.id), 'string-id.png', padTo(PNG_1PX, 300), 'image/png')).status === 201, 'the quote id is accepted as a string as well as a number (same quotation)');
    ok((await count('SELECT count(DISTINCT quote_source_id)::int AS n FROM quote_attachments')) === 1, '…both forms resolve to one quotation identity');
  }

  section('C3  oversized and mislabelled files are rejected, and nothing is stored for them');
  {
    const rowsBefore = await count('SELECT count(*)::int AS n FROM quote_attachments');
    const filesBefore = localFiles().length;
    const EXE = Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(400)]);
    const cases: Array<[string, string, Buffer, string, number, string]> = [
      ['one byte over 5 MB', 'big.png', padTo(PNG_1PX, MB5 + 1), 'image/png', 413, 'FILE_TOO_LARGE'],
      ['8 MB', 'huge.pdf', padTo(PDF_MIN, 8 * 1024 * 1024), 'application/pdf', 413, 'FILE_TOO_LARGE'],
      ['a PDF renamed .png', 'fake.png', PDF_MIN, 'image/png', 415, 'CONTENT_MISMATCH'],
      ['a PNG renamed .pdf', 'fake.pdf', PNG_1PX, 'application/pdf', 415, 'CONTENT_MISMATCH'],
      ['a PNG renamed .jpg', 'fake.jpg', PNG_1PX, 'image/jpeg', 415, 'CONTENT_MISMATCH'],
      ['an executable renamed .pdf', 'invoice.pdf', EXE, 'application/pdf', 415, 'CONTENT_MISMATCH'],
      ['a real PNG declared as application/pdf', 'logo.png', PNG_1PX, 'application/pdf', 415, 'TYPE_MISMATCH'],
      ['a .gif', 'anim.gif', Buffer.from('GIF89a' + 'x'.repeat(50)), 'image/gif', 415, 'TYPE_NOT_ALLOWED'],
      ['a .exe', 'setup.exe', EXE, 'application/octet-stream', 415, 'TYPE_NOT_ALLOWED'],
      ['a double extension', 'photo.png.exe', PNG_1PX, 'image/png', 415, 'TYPE_NOT_ALLOWED'],
      ['no extension', 'README', PNG_1PX, 'image/png', 415, 'TYPE_NOT_ALLOWED'],
      ['an empty file', 'empty.pdf', Buffer.alloc(0), 'application/pdf', 400, 'EMPTY_FILE'],
      ['plain text named .pdf', 'notes.pdf', Buffer.from('just some text, not a pdf'), 'application/pdf', 415, 'CONTENT_MISMATCH'],
    ];
    for (const [label, name, bytes, type, status, code] of cases) {
      const u = await upload(T.assistant, Q1.id, name, bytes, type);
      ok(u.status === status && u.body?.code === code, `${label} → ${status} ${code}`, `HTTP ${u.status} ${safeJson(u.body)}`);
    }
    const noName = await call('POST', `/api/quote-attachments?quoteId=${Q1.id}`, T.assistant, PNG_1PX, { 'Content-Type': 'image/png' });
    ok(noName.status === 400 && noName.body.code === 'FILENAME_REQUIRED', 'a missing file name → 400 FILENAME_REQUIRED');
    const asJson = await call('POST', `/api/quote-attachments?quoteId=${Q1.id}`, T.assistant, { data: 'x' }, { 'X-File-Name': 'a.png' });
    ok(asJson.status === 415 || asJson.status === 400, 'a JSON body instead of a file is refused', `HTTP ${asJson.status}`);
    const trav = await upload(T.assistant, Q1.id, '../../etc/passwd.png', padTo(PNG_1PX, 200), 'image/png');
    ok(trav.status === 201 && trav.body.attachment.filename === 'passwd.png', 'a path in the file name is stripped to its base name');
    ok((await count('SELECT count(*)::int AS n FROM quote_attachments')) === rowsBefore + 1, 'no rejected file left a row behind');
    ok(localFiles().length === filesBefore + 1, 'no rejected file reached storage');
  }

  section('C4  attachments are retained after refresh and across quote edits');
  {
    const fresh = await login('assistant@synthetic.test', PW.assistant); // a brand-new session
    const l = await listFor(fresh.body.token, Q1.id);
    const names = (l.body.attachments || []).map((a: any) => a.filename);
    ok(l.status === 200 && ['site-photo.JPG', 'photo two.jpeg', 'logo.png', 'spec sheet (v2).pdf', 'exactly-5mb.pdf'].every((n) => names.includes(n)), 'a new session lists every uploaded file for the quotation');
    ok(names.length === 7, `the list has exactly the 7 accepted files (got ${names.length})`);
    const v0 = (await pool.query('SELECT row_version FROM rel_quotes WHERE id = $1', [Q1.id])).rows[0].row_version;
    ok(Number(v0) === Number(Q1.rowVersion), 'uploading attachments did NOT bump the quote\'s revision (no false stale-revision conflicts for an open editor)');
    const e1 = await call('PUT', `/api/relational/quotes/${Q1.id}`, T.assistant, { expectedVersion: Number(v0), notes: 'edited after attaching' });
    ok(e1.status === 200, 'the quote can still be edited with the revision the editor already holds', `HTTP ${e1.status} ${safeJson(e1.body)}`);
    const l2 = await listFor(T.admin, Q1.id);
    ok(l2.body.attachments.length === 7, 'the attachments survive a quote edit, and the admin sees the same files');
  }

  section('C5  removal, retry of the same file, and the per-quotation limit');
  {
    const del = await call('DELETE', `/api/quote-attachments/${ids['photo two.jpeg']}`, T.assistant);
    ok(del.status === 200 && del.body.removed === true, 'DELETE → 200 removed');
    ok(!(await listFor(T.assistant, Q1.id)).body.attachments.some((a: any) => a.id === ids['photo two.jpeg']), 'the removed file no longer appears in the list');
    ok((await call('GET', `/api/quote-attachments/${ids['photo two.jpeg']}/content`, T.assistant)).status === 404, 'its content is no longer served');
    ok((await call('DELETE', `/api/quote-attachments/${ids['photo two.jpeg']}`, T.assistant)).status === 404, 'removing it twice → 404');
    const row = (await pool.query('SELECT removed_at, removed_by, storage_key FROM quote_attachments WHERE id = $1', [ids['photo two.jpeg']])).rows[0];
    ok(row.removed_at && row.removed_by === 'assistant@synthetic.test', 'the row is retired with who and when (kept as an audit trail)');
    ok(await storage.getStorageFor('local').exists(row.storage_key), 'the stored object itself is kept — nothing is deleted from storage');
    const again = await upload(T.assistant, Q1.id, 'logo.png', PNG_1PX, 'image/png');
    ok(again.status === 200 && again.body.duplicate === true && again.body.attachment.id === ids['logo.png'], 're-uploading the same file is the same attachment, not a second copy');
    const back = await upload(T.assistant, Q1.id, 'photo two.jpeg', padTo(JPG_1PX, 40000), 'image/jpeg');
    ok(back.status === 201, 'a removed file can be attached again');
    // Fill a separate quotation to its limit.
    const QL = await mkQuote(T.assistant, '2', 'Synthetic Customer (Pty) Ltd');
    let made = 0;
    for (let i = 0; i < 20; i++) if ((await upload(T.assistant, QL.id, `f${i}.png`, padTo(PNG_1PX, 100 + i), 'image/png')).status === 201) made++;
    const over = await upload(T.assistant, QL.id, 'f20.png', padTo(PNG_1PX, 999), 'image/png');
    ok(made === 20 && over.status === 409 && over.body.code === 'TOO_MANY_FILES', 'the 21st file on one quotation → 409 TOO_MANY_FILES');
  }

  section('C6  cross-company isolation and role scoping');
  {
    const hUp = await upload(T.holdAsst, Q2.id, 'holdings-plan.pdf', PDF_MIN, 'application/pdf');
    ok(hUp.status === 201, 'a Holdings user attaches a file to a Holdings quotation');
    const hId = hUp.body.attachment.id;
    ok((await pool.query('SELECT company_code FROM quote_attachments WHERE id = $1', [hId])).rows[0].company_code === '1', 'it is stored under company 1');
    const missing = await listFor(T.assistant, 987654321);
    const pairs: Array<[string, string, any, number]> = [['Signacore assistant', T.assistant, Q2.id, hId], ['Signacore admin', T.admin, Q2.id, hId], ['Signacore accounts', T.accounts, Q2.id, hId],
      ['Holdings assistant', T.holdAsst, Q1.id, ids['logo.png']], ['Holdings admin', T.holdings, Q1.id, ids['logo.png']]];
    for (const [who, token, otherQuote, otherFile] of pairs) {
      const l = await listFor(token, otherQuote);
      ok(l.status === 404 && safeJson(l.body) === safeJson(missing.body), `${who}: listing the other company's quotation → 404, identical to a quotation that does not exist`);
      ok((await upload(token, otherQuote, 'x.png', padTo(PNG_1PX, 77), 'image/png')).status === 404, `${who}: cannot upload to it`);
      ok((await call('GET', `/api/quote-attachments/${otherFile}/content`, token)).status === 404, `${who}: cannot open the other company's file`);
      ok((await call('DELETE', `/api/quote-attachments/${otherFile}`, token)).status === 404, `${who}: cannot remove it`);
    }
    ok((await count('SELECT count(*)::int AS n FROM quote_attachments WHERE id IN ($1, $2) AND removed_at IS NULL', [hId, ids['logo.png']])) === 2, 'both files are untouched after every cross-company attempt');
    ok((await listFor(T.holdings, Q2.id)).body.attachments.length === 1 && (await call('GET', `/api/quote-attachments/${hId}/content`, T.holdings)).status === 200, 'the Holdings admin sees and opens the Holdings file');
    for (const who of ['factory', 'printroom']) {
      ok((await listFor(T[who], Q1.id)).status === 403, `${who}: cannot list quotation files`);
      ok((await call('GET', `/api/quote-attachments/${ids['logo.png']}/content`, T[who])).status === 403, `${who}: cannot open a quotation file`);
      ok((await upload(T[who], Q1.id, 'x.png', PNG_1PX, 'image/png')).body?.code === 'READ_ONLY_ROLE', `${who}: cannot upload`);
    }
    ok((await listFor(null, Q1.id)).status === 401 && (await call('GET', `/api/quote-attachments/${ids['logo.png']}/content`, null)).status === 401, 'no token → 401 for the list and the content');
    for (const bad of ['', 'abc', '0', '-1', '1e3', '9'.repeat(30), '1 OR 1=1']) {
      const r = await call('GET', `/api/quote-attachments/${encodeURIComponent(bad) || '%20'}/content`, T.admin);
      if (r.status !== 404) ok(false, `odd attachment id "${bad}" → 404`, `HTTP ${r.status}`);
    }
    ok(true, 'malformed attachment ids answer 404');
    ok((await listFor(T.admin, "1' OR '1'='1")).status === 404, 'a hostile quoteId answers 404 (parameterised lookup)');
  }

  section('C7  failed upload and retry; a stored file that cannot be retrieved');
  {
    const QF = await mkQuote(T.assistant, '2', 'Synthetic Customer (Pty) Ltd');
    const real = storage.getStorageFor('local');
    storage.setStorageInstance('local', { name: 'local', save: async () => { throw new storage.StorageError('STORAGE_UNAVAILABLE', 'File storage could not be reached. Please try again.', 503, true); },
      read: real.read.bind(real), exists: real.exists.bind(real), healthCheck: real.healthCheck.bind(real) });
    const f = await upload(T.assistant, QF.id, 'retry.png', padTo(PNG_1PX, 1234), 'image/png');
    ok(f.status === 503 && f.body.code === 'STORAGE_UNAVAILABLE' && f.body.notSaved === true, 'a storage failure → 503 STORAGE_UNAVAILABLE with a clear message', `HTTP ${f.status}`);
    ok((await listFor(T.assistant, QF.id)).body.attachments.length === 0, 'the failed upload left no attachment behind');
    storage.setStorageInstance('local', real);
    const r = await upload(T.assistant, QF.id, 'retry.png', padTo(PNG_1PX, 1234), 'image/png');
    ok(r.status === 201 && (await listFor(T.assistant, QF.id)).body.attachments.length === 1, 'the retry succeeds and the file is listed once');
    // Unretrievable: the object disappears, then is damaged.
    const gone = await upload(T.assistant, QF.id, 'gone.pdf', padTo(PDF_MIN, 5000), 'application/pdf');
    const goneKey = (await pool.query('SELECT storage_key FROM quote_attachments WHERE id = $1', [gone.body.attachment.id])).rows[0].storage_key;
    const gonePath = localFiles().find((p) => p.endsWith(goneKey))!;
    fs.unlinkSync(gonePath);
    const g = await call('GET', `/api/quote-attachments/${gone.body.attachment.id}/content`, T.assistant);
    ok(g.status === 404 && g.body.code === 'STORAGE_MISSING', 'a file missing from storage → 404 STORAGE_MISSING (clear error, not a blank download)');
    const bad = await upload(T.assistant, QF.id, 'damaged.pdf', padTo(PDF_MIN, 6000), 'application/pdf');
    const badKey = (await pool.query('SELECT storage_key FROM quote_attachments WHERE id = $1', [bad.body.attachment.id])).rows[0].storage_key;
    const badPath = localFiles().find((p) => p.endsWith(badKey))!;
    const bytes = fs.readFileSync(badPath); bytes[bytes.length - 1] ^= 0xff; fs.writeFileSync(badPath, bytes);
    const b = await call('GET', `/api/quote-attachments/${bad.body.attachment.id}/content`, T.assistant);
    ok(b.status === 502 && b.body.code === 'STORAGE_CORRUPT_READ', 'a damaged stored file → 502 STORAGE_CORRUPT_READ; the wrong bytes are never sent');
    ok((await listFor(T.assistant, QF.id)).body.attachments.length === 3, 'the selection (the attachment records) is preserved so the person can retry or remove');
  }

  section('C8  the Sally storage contract against a fake S3 server (R2 provider)');
  {
    const s3 = await startFakeS3();
    useR2(s3.port);
    const QR = await mkQuote(T.assistant, '2', 'Synthetic Customer (Pty) Ltd');
    const bytes = padTo(PDF_MIN, 150000);
    const u = await upload(T.assistant, QR.id, 'r2-file.pdf', bytes, 'application/pdf');
    ok(u.status === 201, 'upload through the R2 provider → 201', `HTTP ${u.status} ${safeJson(u.body)}`);
    const row = (await pool.query('SELECT storage_provider, storage_key FROM quote_attachments WHERE id = $1', [u.body.attachment.id])).rows[0];
    ok(row.storage_provider === 'r2' && R2_KEY_RE.test(row.storage_key), 'the row records provider r2 and a signacore/v1/sha256/… key');
    ok(row.storage_key === `signacore/v1/sha256/${sha(bytes).slice(0, 2)}/${sha(bytes)}`, 'the key is content-addressed: the file\'s own SHA-256');
    ok(!row.storage_key.startsWith('sally/'), 'the key is outside Sally\'s "sally/" namespace');
    const put = s3.log.find((e) => e.method === 'PUT')!;
    ok(s3.log.length > 0 && s3.log.every((e) => e.signatureOk), `every request (${s3.log.length}) carried a valid AWS Signature V4`);
    ok(put && put.ifNoneMatch === '*' && put.shaHeaderOk && put.md5Ok, 'the write was conditional (If-None-Match: *) and carried the correct SHA-256 and Content-MD5');
    ok(s3.objects.get(row.storage_key)?.meta['x-amz-meta-sha256'] === sha(bytes), 'the object carries its fingerprint as metadata');
    const c = await call('GET', `/api/quote-attachments/${u.body.attachment.id}/content`, T.assistant);
    ok(c.status === 200 && sha(c.raw) === sha(bytes), 'the file is read back through the server, intact');
    const putsBefore = s3.log.filter((e) => e.method === 'PUT').length;
    const QR2 = await mkQuote(T.assistant, '2', 'Synthetic Customer (Pty) Ltd');
    const u2 = await upload(T.assistant, QR2.id, 'same-bytes.pdf', bytes, 'application/pdf');
    ok(u2.status === 201 && s3.log.filter((e) => e.method === 'PUT').length === putsBefore, 'the same bytes on another quotation reuse the stored object — no second upload');
    s3.mode.dropNextPutAnswer = true;
    const lost = await upload(T.assistant, QR.id, 'lost-answer.png', padTo(PNG_1PX, 7777), 'image/png');
    ok(lost.status === 201, 'a write whose answer was lost is reconciled (HEAD finds it) instead of failing or duplicating', `HTTP ${lost.status} ${safeJson(lost.body)}`);
    s3.mode.corruptReads = true;
    const cr = await call('GET', `/api/quote-attachments/${u.body.attachment.id}/content`, T.assistant);
    ok(cr.status === 502 && cr.body.code === 'STORAGE_CORRUPT_READ', 'a read corrupted in transit is caught by the integrity check → 502');
    s3.mode.corruptReads = false;
    // A file is read from the provider recorded on its row, not from the default.
    useLocal();
    process.env.R2_ENDPOINT = `http://127.0.0.1:${s3.port}`; process.env.R2_BUCKET = FAKE.bucket; process.env.R2_ACCESS_KEY_ID = FAKE.accessKeyId; process.env.R2_SECRET_ACCESS_KEY = FAKE.secretAccessKey;
    ok((await call('GET', `/api/quote-attachments/${u.body.attachment.id}/content`, T.assistant)).status === 200, 'with the default switched to local, the R2 file is still read from R2 (provider recorded on the row)');
    ok((await call('GET', `/api/quote-attachments/${ids['logo.png']}/content`, T.assistant)).status === 200, '…and local files are still read from local');
    useR2(s3.port, 'a-wrong-secret-key-0000000000000000000000000');
    const denied = await upload(T.assistant, QR.id, 'denied.png', padTo(PNG_1PX, 4321), 'image/png');
    ok(denied.status === 503 && denied.body.code === 'STORAGE_CREDENTIALS', 'wrong storage credentials → 503 STORAGE_CREDENTIALS, and no row', `HTTP ${denied.status} ${safeJson(denied.body)}`);
    ok(!(await listFor(T.assistant, QR.id)).body.attachments.some((a: any) => a.filename === 'denied.png'), '…the refused file is not listed');
    useR2(1); // nothing listens on port 1
    const down = await upload(T.assistant, QR.id, 'down.png', padTo(PNG_1PX, 2222), 'image/png');
    ok(down.status === 503 && down.body.code === 'STORAGE_UNAVAILABLE' && down.body.notSaved === true, 'unreachable storage → 503 STORAGE_UNAVAILABLE, provably not saved (safe to retry)');
    s3.server.close();
    useLocal();
  }

  section('C9  legacy JSON mode (quotes not cut over) resolves the quotation from platform_state');
  {
    await pool.query(`UPDATE relational_cutover SET enabled = false WHERE section = 'quotes'`);
    await pool.query(`UPDATE platform_state SET data = data || $1::jsonb WHERE id = 1`, [JSON.stringify({ quotes: [
      { id: 1731000000001, num: 'SQ-J0001', co: 2, client: 'JSON Synthetic' }, { id: 1731000000002, num: 'SQ-J0002', co: 1, client: 'JSON Holdings' }, { id: 'q-legacy-3', num: 'SQ-J0003', client: 'No company tag' }] })]);
    const a = await upload(T.assistant, 1731000000001, 'json-mode.png', padTo(PNG_1PX, 555), 'image/png');
    ok(a.status === 201 && (await listFor(T.assistant, '1731000000001')).body.attachments.length === 1, 'a JSON-mode quotation accepts and lists an attachment');
    ok((await upload(T.assistant, 'q-legacy-3', 'untagged.png', padTo(PNG_1PX, 556), 'image/png')).status === 201, 'a quotation with no company tag belongs to the original company');
    ok((await upload(T.holdAsst, 'q-legacy-3', 'x.png', padTo(PNG_1PX, 557), 'image/png')).status === 404, '…and is not reachable from Holdings');
    ok((await upload(T.assistant, 1731000000002, 'x.png', padTo(PNG_1PX, 558), 'image/png')).status === 404, 'a JSON-mode Holdings quotation is not reachable from Signacore');
    ok((await upload(T.holdAsst, 1731000000002, 'h.png', padTo(PNG_1PX, 559), 'image/png')).status === 201, '…and is reachable from Holdings');
    ok((await listFor(T.assistant, Q1.id)).status === 404, 'a relational-only id is not found in JSON mode (no cross-mode guessing)');
    await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section = 'quotes'`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  section('D   creating, editing and reopening a quote leaves one saved record at the latest revision');
  {
    const q = await mkQuote(T.assistant, '2', 'Synthetic Customer (Pty) Ltd');
    ok(typeof q.id === 'string' || typeof q.id === 'number', `create returns the new id (as ${typeof q.id} — the browser must treat "412" and 412 as one record)`);
    await upload(T.assistant, q.id, 'with-quote.pdf', PDF_MIN, 'application/pdf');
    const e1 = await call('PUT', `/api/relational/quotes/${q.id}`, T.assistant, { expectedVersion: q.rowVersion, notes: 'first edit' });
    const e2 = await call('PUT', `/api/relational/quotes/${String(q.id)}`, T.assistant, { expectedVersion: e1.body.rowVersion, notes: 'second edit' });
    ok(e1.status === 200 && e2.status === 200 && e2.body.rowVersion === q.rowVersion + 2, 'two edits move the revision from 1 to 3');
    const stale = await call('PUT', `/api/relational/quotes/${q.id}`, T.assistant, { expectedVersion: q.rowVersion, notes: 'stale edit' });
    ok(stale.status === 409 && stale.body.type === 'stale_record', 'an edit made from a stale revision is refused (409 stale_record)');
    const sent = await call('PATCH', `/api/relational/quotes/${q.id}/status`, T.assistant, { expectedVersion: e2.body.rowVersion, status: 'sent' });
    ok(sent.status === 200, 'marking the quote sent succeeds', `HTTP ${sent.status} ${safeJson(sent.body)}`);
    ok((await count('SELECT count(*)::int AS n FROM rel_quotes WHERE company_code = $1 AND quote_number = $2', ['2', q.quoteNumber])) === 1, 'exactly one saved row exists for the quote number');
    const read = await call('GET', '/api/relational/sections?names=quotes', T.assistant);
    const mine = (read.body.data.quotes || []).filter((x: any) => x.num === q.quoteNumber && String(x.co) === '2');
    ok(mine.length === 1 && mine[0].notes === 'second edit' && mine[0].status === 'sent', 'the authoritative read returns ONE record carrying the latest edit and status');
    ok(typeof mine[0].id === 'number' && String(mine[0].id) === String(q.id), 'the read returns the id as a number; String(id) matches the id returned on create');
    ok((await listFor(T.assistant, mine[0].id)).body.attachments.length === 1, 'the attachment is found by the reopened record\'s id');
  }

  section('E   no secret appears in anything the server logged');
  {
    const all = captured.join('\n');
    const secrets = [NEW_PW, ...Object.values(PW), FAKE.secretAccessKey, JWT_SECRET, 'Takeover-Passw0rd'];
    ok(!secrets.some((s) => all.includes(s)), 'no password, storage secret or signing secret was logged');
  }

  console.log(`\n══ users-readonly-attachments: PASSED ${passed}   FAILED ${failures} ══`);
  fs.rmSync(STORAGE_DIR, { recursive: true, force: true });
  await pool.end();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => { console.error('SUITE CRASHED:', err); try { await pool.end(); } catch { /* ignore */ } process.exit(1); });
