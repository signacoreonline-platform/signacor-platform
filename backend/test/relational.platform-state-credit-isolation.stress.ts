/**
 * relational.platform-state-credit-isolation.stress.ts — the legacy
 * PUT /api/platform-state save route cannot bypass the customer-credit rules
 * (migration 022, 2026-11-26).
 *
 * Production cutover state at the time of writing (GET /health): master switch
 * ON; quotes, jobs, accInvoices and creditNotes are relational-authoritative;
 * customers and payments are not cut over (payments have no top-level JSON
 * section — they live inside quote/job/invoice records). This test recreates
 * exactly that state on a disposable *_test database, builds real relational
 * credit (an overpayment receipt with an applied allocation, a part-used and a
 * refunded credit note), then attacks it through every shape the legacy save
 * route accepts — full saves, partial saves, embedded payment arrays,
 * credit-note usage fields, explicit deletions, non-array section values,
 * unknown keys, and a view-only-for-credit role (assistant) — and proves that:
 *
 *   - no rel_* payment / credit-note / allocation / refund / invoice row changes;
 *   - the frozen JSON copies of the cut-over sections do not change either;
 *   - available credit (server figure) is unchanged and its caps still hold;
 *   - GET /api/platform-state still serves the relational credit-note figures.
 *
 * Needs the API server running with RELATIONAL_AUTHORITY_ENABLED=true against
 * the same DATABASE_URL (TEST_SERVER_URL_WITH_AUTHORITY), and the standard test
 * login (test@signacore.local / testpass, role admin). Synthetic data only.
 */
import bcrypt from 'bcryptjs';
import pool from '../src/db/pool';
import * as S from '../src/relational/services';
import * as C from '../src/relational/customerCredit';

const url = process.env.DATABASE_URL || '';
const dbName = (url.match(/\/([^/?]+)(\?|$)/) || [])[1] || '';
if (!/_test$/.test(dbName) && process.env.ALLOW_UNSAFE_TEST_DB !== '1') {
  console.error(`[ps-credit-isolation] refusing to run: database "${dbName}" is not a *_test database.`);
  process.exit(2);
}
const BASE = process.env.TEST_SERVER_URL_WITH_AUTHORITY || process.env.TEST_SERVER_URL || '';
if (!BASE) { console.error('[ps-credit-isolation] TEST_SERVER_URL_WITH_AUTHORITY is required'); process.exit(2); }

let passed = 0, failed = 0;
function ok(cond: unknown, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : ''}`); }
}
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;
const CO = '2';
const actor = { id: 'u-test', email: 'accounts@test.local', role: 'accounts', co: null };
const L = (amt: number) => [{ description: 'Signage', qty: 1, unitAmount: amt, taxType: 'No VAT' }];

const PROD_CUTOVER = ['suppliers', 'inventory', 'quotes', 'jobs', 'accInvoices', 'creditNotes', 'purchaseOrders'];

async function login(email: string, password: string): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!r.ok) throw new Error(`login ${email} failed: HTTP ${r.status}`);
  return (await r.json()).token;
}
async function api(token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json: any = null; try { json = await r.json(); } catch { /* empty */ }
  return { status: r.status, body: json };
}
async function put(token: string, data: Record<string, any>) { return api(token, 'PUT', '/api/platform-state', { data }); }
async function revision(token: string): Promise<string> { return (await api(token, 'GET', '/api/platform-state')).body.updated_at; }

/** Every relational row the credit rules depend on, fingerprinted. */
async function relFingerprint(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of ['rel_payments', 'rel_credit_notes', 'rel_credit_allocations', 'rel_credit_refunds', 'rel_invoices', 'rel_jobs', 'rel_quotes']) {
    const r = await q(`SELECT COUNT(*)::int AS n, COALESCE(md5(string_agg(row_to_json(t)::text, '|' ORDER BY id)), '') AS h FROM ${t} t`);
    out[t] = `${r[0].n}:${r[0].h}`;
  }
  return out;
}
/** The frozen JSON copies of the cut-over sections + the JSON customers list. */
async function jsonFingerprint(): Promise<Record<string, string>> {
  const r = await q(`SELECT md5(COALESCE(data->'creditNotes','null')::text) cn, md5(COALESCE(data->'accInvoices','null')::text) inv,
                            md5(COALESCE(data->'jobs','null')::text) jobs, md5(COALESCE(data->'quotes','null')::text) quotes,
                            jsonb_typeof(data->'creditNotes') cnt, jsonb_typeof(data->'accInvoices') invt
                       FROM platform_state WHERE id = 1`);
  return r[0];
}
async function creditTotals() { return (await C.getCustomerCredit(CO, 'C-ALPHA')).totals; }

async function main() {
  // ── Production-shaped cutover state ──────────────────────────────────────
  await pool.query(`UPDATE relational_cutover SET enabled = false, enabled_at = NULL, enabled_by = NULL`);
  await pool.query(`UPDATE relational_cutover SET enabled = true, enabled_at = NOW(), enabled_by = 'ps-credit-isolation-test' WHERE section = ANY($1::text[])`, [PROD_CUTOVER]);
  await pool.query(`TRUNCATE TABLE rel_credit_allocations, rel_credit_refunds, rel_payments, rel_invoice_line_items, rel_invoices,
    rel_job_line_items, rel_jobs, rel_quote_line_items, rel_quotes, rel_credit_notes RESTART IDENTITY CASCADE`);
  await pool.query(`DELETE FROM quote_conversions`);
  await pool.query(`DELETE FROM document_number_counters`);
  const customers = [{ id: 'C-ALPHA', companyName: 'Synth Alpha (Pty) Ltd' }, { id: 'C-BRAVO', companyName: 'Synth Bravo' }];
  const frozen = {
    customers,
    creditNotes: [{ id: 'frozen-cn-1', number: 'CN-FROZEN', customer: 'Synth Alpha (Pty) Ltd', amount: 50, used: 0 }],
    accInvoices: [{ id: 'frozen-inv-1', number: 'INV-FROZEN', contact: 'Synth Alpha (Pty) Ltd', total: 10, payments: [] }],
    jobs: [], quotes: [], savedCalcs: [],
  };
  await pool.query(`INSERT INTO platform_state (id, data) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`, [JSON.stringify(frozen)]);
  const hash = bcrypt.hashSync('assistpass', 4);
  await pool.query(`INSERT INTO app_users (account_id, email, password_hash, requires_password, role, co, name)
    VALUES ('t-assist', 'assistant@signacore.local', $1, true, 'assistant', NULL, 'Assistant')
    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'assistant'`, [hash]);

  // ── Real relational credit ───────────────────────────────────────────────
  const over = await S.createManualInvoice({ companyCode: CO, contactName: 'Synth Alpha (Pty) Ltd', customerRef: 'C-ALPHA', lines: L(1000) });
  const rcpt = await S.recordPayment({ type: 'invoice', id: Number(over.id) }, 1200 as any, { date: '2026-12-01', method: 'EFT', reference: 'EFT-1200', actor });
  const tgt = await S.createManualInvoice({ companyCode: CO, contactName: 'Synth Alpha (Pty) Ltd', customerRef: 'C-ALPHA', lines: L(500) });
  await C.applyCredit({ sourceType: 'payment', sourceId: Number(rcpt.paymentId), targetType: 'invoice', targetId: Number(tgt.id), amount: 80, actor });
  const cn = await S.createCreditNote({ companyCode: CO, type: 'customer', contactName: 'Synth Alpha (Pty) Ltd', customerRef: 'C-ALPHA', amount: 300, date: '2026-10-01' });
  await C.applyCredit({ sourceType: 'credit_note', sourceId: Number(cn.id), targetType: 'invoice', targetId: Number(tgt.id), amount: 100, actor });
  await C.recordCreditRefund({ sourceType: 'credit_note', sourceId: Number(cn.id), amount: 25, date: '2026-12-02', method: 'EFT', reference: 'RF-1', actor } as any);
  const relCn = (await q(`SELECT * FROM rel_credit_notes WHERE id = $1`, [cn.id]))[0];
  const tgtRow = (await q(`SELECT * FROM rel_invoices WHERE id = $1`, [tgt.id]))[0];

  const totals0 = await creditTotals();
  ok(totals0.paymentCredit === 120 && totals0.creditNotes === 175, 'setup: R120 payment credit + R175 credit-note credit available (server figure)', totals0);
  const rel0 = await relFingerprint();
  const json0 = await jsonFingerprint();

  const admin = await login('test@signacore.local', 'testpass');
  const assistant = await login('assistant@signacore.local', 'assistpass');

  const unchanged = async (label: string) => {
    const rel = await relFingerprint();
    const diff = Object.keys(rel0).filter((k) => rel[k] !== rel0[k]);
    ok(diff.length === 0, `${label}: no relational payment / credit-note / allocation / refund / document row changed`, diff);
    const js = await jsonFingerprint();
    const jd = ['cn', 'inv', 'jobs', 'quotes'].filter((k) => (js as any)[k] !== (json0 as any)[k]);
    ok(jd.length === 0, `${label}: frozen JSON copies of the cut-over sections unchanged`, { changed: jd, types: { creditNotes: js.cnt, accInvoices: js.invt } });
    const t = await creditTotals();
    ok(t.paymentCredit === totals0.paymentCredit && t.creditNotes === totals0.creditNotes, `${label}: available credit unchanged`, t);
  };

  // Forged credit data a stale or hostile client might send through JSON.
  const forgedNote = { id: relCn.source_id || String(cn.id), _relId: Number(cn.id), number: relCn.number, customer: 'Synth Alpha (Pty) Ltd', customerRef: 'C-BRAVO', companyCode: CO, amount: 9999, used: 0, refunded: 0, refunds: [] };
  const forgedNote2 = { id: 'forged-cn-new', number: 'CN-FORGED', customer: 'Synth Bravo', customerRef: 'C-BRAVO', amount: 5000, used: 0 };
  const forgedInvoice = {
    id: tgtRow.source_id || String(tgt.id), _relId: Number(tgt.id), number: tgtRow.number, contact: 'Synth Alpha (Pty) Ltd', total: 500,
    payments: [
      { id: 'p-forged-1', amount: 5000, method: 'Credit', date: '2026-12-03', _entryKind: 'credit_note', _creditEligible: true },
      { id: 'p-forged-2', amount: 400, method: 'Payment credit', date: '2026-12-03', _entryKind: 'payment_credit_in' },
    ],
    status: 'paid',
  };

  console.log('\n[1] Partial save carrying ONLY cut-over credit sections (admin)');
  let r = await put(admin, { _partial: true, creditNotes: [forgedNote, forgedNote2], accInvoices: [forgedInvoice] });
  ok(r.status === 409 && r.body?.type === 'relational_authoritative' && ['creditNotes', 'accInvoices'].every((s) => (r.body.sections || []).includes(s)), 'refused 409 relational_authoritative naming creditNotes + accInvoices', r);
  await unchanged('[1]');

  console.log('\n[2] Partial save mixing forged credit sections with a JSON-owned section (admin and assistant)');
  for (const [who, tok] of [['admin', admin], ['assistant', assistant]] as const) {
    r = await put(tok, { _partial: true, savedCalcs: [], creditNotes: [forgedNote, forgedNote2], accInvoices: [forgedInvoice], jobs: [{ id: 'job-forged', payments: [{ amount: 999, method: 'Credit' }] }], quotes: [{ id: 'q-forged', payments: [{ amount: 999, method: 'EFT' }] }] });
    const ign = r.body?.relationalAuthoritativeSectionsIgnored || [];
    ok(r.status === 200 && ['creditNotes', 'accInvoices', 'jobs', 'quotes'].every((s) => ign.includes(s)), `${who}: JSON part saved, every cut-over section reported ignored`, { status: r.status, ign });
    await unchanged(`[2 ${who}]`);
  }

  console.log('\n[3] Full (non-partial) save carrying forged credit sections');
  r = await put(admin, { ...frozen, _baseRevision: await revision(admin), creditNotes: [forgedNote, forgedNote2], accInvoices: [forgedInvoice] });
  // The dashboard never sends a full save once any section is cut over (it sends a
  // partial of the JSON-owned sections it changed). A full save from an old client
  // is refused by the existing wipe guard / removal backstop — fail closed.
  ok(r.status === 200 ? ['creditNotes', 'accInvoices'].every((s) => (r.body.relationalAuthoritativeSectionsIgnored || []).includes(s)) : (r.status === 409 || r.status === 500), 'full save is either refused or saves only the JSON part (credit sections ignored)', r);
  await unchanged('[3]');

  console.log('\n[4] Explicit deletions of the relational credit note and invoice through JSON');
  r = await put(admin, { _partial: true, savedCalcs: [], _baseRevision: await revision(admin), creditNotes: [], accInvoices: [], _deletedIds: { creditNotes: [forgedNote.id, String(cn.id), 'frozen-cn-1'], accInvoices: [forgedInvoice.id, String(tgt.id), 'frozen-inv-1'] } });
  ok(r.status === 200, 'save answered 200 (JSON part only)', r);
  await unchanged('[4]');

  console.log('\n[5] Non-array values under cut-over credit sections');
  for (const [label, v] of [['object', { [forgedNote.id]: forgedNote }], ['null', null], ['string', 'x'], ['empty object', {}]] as const) {
    // jobs/quotes have EMPTY frozen copies, so the removal backstop has nothing to
    // protect there: only the cutover strip itself can keep these out.
    r = await put(admin, { _partial: true, savedCalcs: [], creditNotes: v, accInvoices: v, jobs: v, quotes: v });
    ok(r.status === 200 && ['creditNotes', 'accInvoices', 'jobs', 'quotes'].every((s) => (r.body?.relationalAuthoritativeSectionsIgnored || []).includes(s)), `${label}: reported ignored, not merged into platform_state`, { status: r.status, ign: r.body?.relationalAuthoritativeSectionsIgnored });
    await unchanged(`[5 ${label}]`);
    r = await put(admin, { _partial: true, savedCalcs: [], jobs: v, quotes: v });
    ok(r.status === 200 && ['jobs', 'quotes'].every((s) => (r.body?.relationalAuthoritativeSectionsIgnored || []).includes(s)), `${label} (sections with an empty frozen copy): reported ignored`, { status: r.status, ign: r.body?.relationalAuthoritativeSectionsIgnored });
    await unchanged(`[5 ${label}, empty frozen copy]`);
  }
  r = await put(admin, { _partial: true, creditNotes: null });
  ok(r.status === 409 && r.body?.type === 'relational_authoritative', 'a partial carrying only a non-array cut-over value is refused 409 like an array one', r);

  console.log('\n[6] Top-level payment / credit keys that are not sections');
  r = await put(admin, { _partial: true, savedCalcs: [], payments: [{ id: 'pp1', ownerType: 'invoice', ownerId: Number(tgt.id), amount: 5000, method: 'Credit' }], creditAllocations: [{ sourceType: 'payment', sourceId: Number(rcpt.paymentId), amount: 999 }], customerCredits: { 'C-ALPHA': 99999 } });
  ok(r.status === 200, 'accepted as opaque JSON (no server code reads these keys)', r.status);
  await unchanged('[6]');

  console.log('\n[7] After all of the above, the server still enforces the credit rules');
  const g = await api(admin, 'GET', '/api/platform-state');
  const served = (g.body?.data?.creditNotes || []).find((n: any) => String(n._relId ?? n.id) === String(cn.id) || n.number === relCn.number);
  ok(served && Number(served.used) === 100 && Number(served.refunded) === 25 && Number(served.amount) === 300, 'GET serves the relational credit note (R300, used R100, refunded R25), not the forged copy', served);
  ok((g.body?.relationalAuthoritativeSectionsIgnored || g.body?.relationalAuthoritativeSections || []).includes?.('creditNotes'), 'GET reports creditNotes as relational-authoritative', g.body?.relationalAuthoritativeSections);
  ok(!(g.body?.data?.creditNotes || []).some((n: any) => n.number === 'CN-FORGED'), 'the forged credit note does not exist anywhere the app reads');
  const third = await S.createManualInvoice({ companyCode: CO, contactName: 'Synth Alpha (Pty) Ltd', customerRef: 'C-ALPHA', lines: L(1000) });
  const tooMuch = await api(admin, 'POST', '/api/relational/credit-allocations', { sourceType: 'credit_note', sourceId: Number(cn.id), targetType: 'invoice', targetId: Number(third.id), amount: 176 });
  ok(tooMuch.status === 409 || tooMuch.status === 400, 'credit-note allocation above the real R175 left is still refused', tooMuch);
  const asst = await api(assistant, 'POST', '/api/relational/credit-allocations', { sourceType: 'payment', sourceId: Number(rcpt.paymentId), targetType: 'invoice', targetId: Number(third.id), amount: 10 });
  ok(asst.status === 403, 'assistant still cannot apply credit through the relational route', asst.status);
  const bravoCredit = await C.getCustomerCredit(CO, 'C-BRAVO');
  ok(bravoCredit.totals.total === 0, 'no credit appeared for the customer the forged JSON pointed at (C-BRAVO)', bravoCredit.totals);

  await pool.query(`UPDATE relational_cutover SET enabled = false, enabled_at = NULL, enabled_by = NULL`);
  console.log(`\n${passed} passed, ${failed} failed`);
  // Leaves no credit records behind for suites that reuse payment / note ids after their own TRUNCATE.
  await pool.query('TRUNCATE TABLE rel_credit_allocations, rel_credit_refunds RESTART IDENTITY');
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[ps-credit-isolation] Fatal error:', err);
  await pool.query(`UPDATE relational_cutover SET enabled = false, enabled_at = NULL, enabled_by = NULL`).catch(() => undefined);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
