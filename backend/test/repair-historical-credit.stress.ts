/**
 * repair-historical-credit.stress.ts — runs the COMPILED
 * dist/scripts/repair-historical-credit.js against synthetic copies of the two
 * authorised cases (Raider INV-00207 / ATC INV-00239). Disposable *_test
 * database only. Requires `npm run build` first.
 *
 * Two variants: ATC's receipt on the invoice (with a bank reference) and on the
 * job (with a blank reference). Each covers diagnose, dry run, wrong
 * confirmation, stale fingerprint, a mid-repair failure (whole rollback), the
 * real apply, a second run, later use of the credit, and refusal of
 * unexpected data. Other customers / historical overpayments must not change.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import pool from '../src/db/pool';
import * as S from '../src/relational/services';
import * as C from '../src/relational/customerCredit';

const url = process.env.DATABASE_URL || '';
const dbName = (url.match(/\/([^/?]+)(\?|$)/) || [])[1] || '';
if (!/_test$/.test(dbName) && process.env.ALLOW_UNSAFE_TEST_DB !== '1') { console.error(`[repair-historical-credit] refusing: "${dbName}" is not a *_test database.`); process.exit(2); }
const SCRIPT = path.resolve(__dirname, '..', 'dist', 'scripts', 'repair-historical-credit.js');
if (!fs.existsSync(SCRIPT)) { console.error('run `npm run build` first'); process.exit(2); }
let passed = 0, failed = 0;
function ok(c: unknown, l: string, d?: unknown) { if (c) { passed++; console.log('  ✓ ' + l); } else { failed++; console.log('  ✗ ' + l + (d !== undefined ? ' — ' + String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 600) : '')); } }
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;
const CO = '2';
const actor = { id: 'u-test', email: 'accounts@test.local', role: 'accounts', co: null };
const L = (amt: number) => [{ description: 'Work', qty: 1, unitAmount: amt, taxType: 'No VAT' }];
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hcr-'));
function run(...args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: work, env: { ...process.env }, encoding: 'utf8', timeout: 120000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const fpOf = (out: string) => (out.match(/plan fingerprint: ([0-9a-f]{16})/) || [])[1];
const confirmOf = (out: string) => (out.match(/--confirm=([^"]+)"/) || [])[1];
async function dbPrint() {
  return (await q(`SELECT
    (SELECT md5(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY id),'')) FROM rel_payments t) p,
    (SELECT md5(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY id),'')) FROM rel_invoices t) i,
    (SELECT md5(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY id),'')) FROM rel_jobs t) j,
    (SELECT md5(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY id),'')) FROM rel_quotes t) q,
    (SELECT md5(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY id),'')) FROM rel_account_receipts t) a,
    (SELECT md5(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY id),'')) FROM rel_credit_allocations t) al,
    (SELECT md5(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY id),'')) FROM rel_credit_refunds t) rf,
    (SELECT md5(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY id),'')) FROM rel_credit_notes t) cn,
    (SELECT COUNT(*) FROM customer_link_audit WHERE action = 'historical-credit-repair') au`))[0];
}

async function seed(atcOwner: 'invoice' | 'job', atcRef: string) {
  await pool.query(`TRUNCATE TABLE rel_account_receipts, rel_credit_allocations, rel_credit_refunds, rel_payments, rel_invoice_line_items, rel_invoices,
    rel_job_line_items, rel_jobs, rel_quote_line_items, rel_quotes, rel_credit_notes RESTART IDENTITY CASCADE`);
  await pool.query(`DELETE FROM quote_conversions`); await pool.query(`DELETE FROM document_number_counters`); await pool.query(`DELETE FROM customer_link_audit`);
  const customers = [
    { id: 'C-RAIDER', companyName: 'Raider Outboards International' },
    { id: 'C-ATC', companyName: 'Advanced Tactical Craft (PTY) LTD - ATC Marine' },
    { id: 'C-HIST', companyName: 'Historic Overpayer' },
    { id: 'C-LIVE', companyName: 'Live Credit Co' },
  ];
  await pool.query(`INSERT INTO platform_state (id, data) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET data = jsonb_set(COALESCE(platform_state.data,'{}'::jsonb), '{customers}', $2::jsonb)`,
    [JSON.stringify({ customers }), JSON.stringify(customers)]);
  await pool.query(`UPDATE relational_cutover SET enabled = false WHERE section = 'customers'`);
  const chain = async (ref: string, name: string, amount: number, inv: string, job: string) => {
    const qt = await S.createQuote({ companyCode: CO, customerNameRaw: name, customerRef: ref, lines: [{ description: 'Work', qty: 1, unitPrice: amount }] } as any);
    const cv = await S.convertQuoteToJob(Number(qt.id));
    const iv = await S.createInvoiceForJob(Number(cv.jobId));
    await pool.query(`UPDATE rel_invoices SET invoice_number = $2 WHERE id = $1`, [iv.invoiceId ?? (iv as any).id, inv]);
    await pool.query(`UPDATE rel_jobs SET job_number = $2, invoice_num = $3 WHERE id = $1`, [cv.jobId, job, inv]);
    return { quoteId: Number(qt.id), jobId: Number(cv.jobId), invoiceId: Number(iv.invoiceId ?? (iv as any).id) };
  };
  const hist = async (owner: 'invoice' | 'job', id: number, amount: number, date: string, ref: string | null, src: string) => {
    await pool.query(`INSERT INTO rel_payments (source_id, owner_type, owner_id, line_index, amount, payment_date, method, reference) VALUES ($1, $2, $3, 0, $4, $5, 'EFT', $6)`, [src, owner, id, amount, date, ref]);
    const c = await pool.connect(); try { await S.recomputeOwnerPaymentStatus(c, owner, id); } finally { c.release(); }
  };
  const raider = await chain('C-RAIDER', 'Raider Outboards International', 177.60, // + 15% VAT = R204.24
    'INV-00207', 'SNS-00222');
  await hist('job', raider.jobId, 2000, '2026-11-18', 'RAIDER EFT 18 NOV', 'hist-raider');
  const atc = await chain('C-ATC', 'Advanced Tactical Craft (PTY) LTD - ATC Marine', 0, 'INV-00239', 'SNS-00253');
  await hist(atcOwner, atcOwner === 'invoice' ? atc.invoiceId : atc.jobId, 2000, '2026-11-18', atcRef || null, 'hist-atc');
  const other = await chain('C-HIST', 'Historic Overpayer', 100, 'INV-00100', 'SNS-00100');
  await hist('invoice', other.invoiceId, 300, '2026-10-01', 'OLD', 'hist-other');                       // historical overpayment: must stay non-spendable
  await C.recordAccountReceipt({ companyCode: CO, customerRef: 'C-LIVE', amount: 250, date: '2026-11-20', method: 'EFT', reference: 'LIVE-250', actor });
  return { raider, atc, other };
}

async function variant(atcOwner: 'invoice' | 'job', atcRef: string) {
  console.log(`\n════ variant: ATC receipt on the ${atcOwner}, reference ${atcRef ? JSON.stringify(atcRef) : '(blank)'} ════`);
  const ids = await seed(atcOwner, atcRef);
  const st0 = await C.chainStateTx(pool, 'invoice', ids.raider.invoiceId);
  ok(st0.payableC === 20424 && st0.paidC === 200000, 'setup: Raider R204.24 due, R2,000 paid (historical receipt)', { due: st0.payableC, paid: st0.paidC });
  const atcSt = await C.chainStateTx(pool, 'invoice', ids.atc.invoiceId);
  ok(atcSt.paidC === 200000 && (atcSt.payableC === 0 || atcSt.payableC === null), 'setup: ATC R0.00 invoice with R2,000 paid', { due: atcSt.payableC, paid: atcSt.paidC });
  ok((await C.getCustomerCredit(CO, 'C-RAIDER')).totals.total === 0 && (await C.getCustomerCredit(CO, 'C-ATC')).totals.total === 0, 'before repair: neither customer has spendable credit (historical rule)');
  const otherBefore = { hist: (await C.getCustomerCredit(CO, 'C-HIST')).totals, live: (await C.getCustomerCredit(CO, 'C-LIVE')).totals };

  console.log('\n[1] diagnose / dry run are read only');
  const before = await dbPrint();
  const d = run('--diagnose');
  ok(d.code === 0 && /RAIDER.*INV-00207/.test(d.out) && /ATC.*INV-00239/.test(d.out) && /state:\s+PENDING/.test(d.out), 'diagnose lists both cases as PENDING', d.out);
  ok(/customer:\s+Raider Outboards International \[C-RAIDER\] via link/.test(d.out) && /customer:\s+Advanced Tactical Craft \(PTY\) LTD - ATC Marine \[C-ATC\] via link/.test(d.out), 'diagnose shows the canonical customer ids');
  if (!atcRef) ok(/NO bank reference/.test(d.out), 'a blank ATC reference is reported (and not invented)');
  const dr = run();
  const fp = fpOf(dr.out), confirm = confirmOf(dr.out);
  ok(dr.code === 0 && fp && confirm === 'REPAIR INV-00207 AND INV-00239', 'dry run prints a fingerprint and the confirmation phrase', dr.out.slice(-800));
  ok(/payment credit R1795\.76 for C-RAIDER/.test(dr.out) && /NEW payment on account: R2000\.00\s+date 2026-11-18\s+method EFT/.test(dr.out) && /CANCEL INV-00239/.test(dr.out), 'dry run shows the exact changes and after-balances');
  ok(JSON.stringify(await dbPrint()) === JSON.stringify(before), 'diagnose and dry run wrote nothing');

  console.log('\n[2] guarded apply');
  let r = run('--apply', '--confirm=REPAIR EVERYTHING', `--expect=${fp}`);
  ok(r.code === 1 && /--confirm must be exactly "REPAIR INV-00207 AND INV-00239"/.test(r.out), 'wrong confirmation refused', r.out.slice(-300));
  r = run('--apply', `--confirm=${confirm}`, '--expect=0000000000000000');
  ok(r.code === 1 && /no longer matches the reviewed dry run/.test(r.out), 'wrong fingerprint refused');
  ok(JSON.stringify(await dbPrint()) === JSON.stringify(before), 'refused applies wrote nothing');
  // concurrent change after the review: the plan no longer matches
  await pool.query(`UPDATE rel_invoices SET row_version = row_version + 1 WHERE id = $1`, [ids.raider.invoiceId]);
  r = run('--apply', `--confirm=${confirm}`, `--expect=${fp}`);
  ok(r.code === 1 && /no longer matches the reviewed dry run/.test(r.out), 'a change after the dry run makes the reviewed fingerprint stale (refused)');
  const dr2 = run(); const fp2 = fpOf(dr2.out);
  ok(fp2 && fp2 !== fp, 'a new dry run gives a new fingerprint');

  console.log('\n[3] a failure part-way rolls back the WHOLE repair');
  await pool.query(`CREATE OR REPLACE FUNCTION hcr_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'synthetic failure during repair'; END $$ LANGUAGE plpgsql`);
  await pool.query(`CREATE TRIGGER hcr_fail BEFORE INSERT ON rel_account_receipts FOR EACH ROW EXECUTE FUNCTION hcr_fail()`);
  const before3 = await dbPrint();
  r = run('--apply', `--confirm=${confirm}`, `--expect=${fp2}`);
  await pool.query(`DROP TRIGGER hcr_fail ON rel_account_receipts`); await pool.query(`DROP FUNCTION hcr_fail()`);
  ok(r.code === 1 && /synthetic failure during repair/.test(r.out) && /NOT-APPLIED/.test(r.out), 'apply stops on the failure (the Raider step had already run inside the transaction)', r.out.slice(-400));
  ok(JSON.stringify(await dbPrint()) === JSON.stringify(before3), 'everything rolled back: Raider receipt still not eligible, nothing moved, no audit row');
  ok((await q(`SELECT credit_eligible FROM rel_payments WHERE source_id = 'hist-raider'`))[0].credit_eligible === false, 'Raider receipt unchanged after the rollback');

  console.log('\n[4] the real apply');
  r = run('--apply', `--confirm=${confirm}`, `--expect=${fp2}`);
  ok(r.code === 0 && /APPLIED\s+RAIDER: payment #\d+ now provides R1795\.76/.test(r.out) && /APPLIED\s+ATC: payment on account #\d+ R2000\.00 available/.test(r.out), 'apply succeeds for both cases', r.out.slice(-900));
  const files = fs.readdirSync(work).filter((f) => /^historical-credit-repair-.*\.json$/.test(f) && !/NOT-APPLIED/.test(f));
  const bk = files.length ? JSON.parse(fs.readFileSync(path.join(work, files[files.length - 1]), 'utf8')) : null;
  ok(bk && /^APPLIED/.test(bk.status) && bk.before.length === 2 && bk.before.some((b: any) => b.case === 'ATC' && b.payments.some((p: any) => p.source_id === 'hist-atc')), 'local backup holds the before-images (incl. the removed ATC payment)');
  const audit = await q(`SELECT * FROM customer_link_audit WHERE action = 'historical-credit-repair' ORDER BY id`);
  ok(audit.length === 2 && audit[1].detail.before.payments.some((p: any) => p.source_id === 'hist-atc') && audit.every((a: any) => a.detail.fingerprint === fp2), 'two audit rows with before-images and the reviewed fingerprint');

  console.log('\n[5] results — Raider');
  const rpay = (await q(`SELECT *, payment_date::text AS d FROM rel_payments WHERE source_id = 'hist-raider'`))[0];
  ok(rpay && rpay.credit_eligible === true && rpay.entry_kind === 'receipt' && Number(rpay.amount) === 2000 && rpay.d === '2026-11-18' && rpay.method === 'EFT' && rpay.reference === 'RAIDER EFT 18 NOV',
    'the original R2,000 receipt is kept (date, method, reference unchanged), now credit-eligible');
  ok((await q(`SELECT status FROM rel_invoices WHERE id = $1`, [ids.raider.invoiceId]))[0].status === 'paid', 'INV-00207 still paid');
  const rc = await C.getCustomerCredit(CO, 'C-RAIDER');
  ok(rc.totals.paymentCredit === 1795.76 && rc.paymentCredits.length === 1 && rc.paymentCredits[0].original === 2000 && rc.paymentCredits[0].date === '2026-11-18', 'Raider: exactly R1,795.76 payment credit, from the R2,000 receipt of 2026-11-18', rc.paymentCredits);

  console.log('\n[6] results — ATC');
  const a = (await q(`SELECT *, receipt_date::text AS d FROM rel_account_receipts WHERE customer_ref = 'C-ATC'`));
  ok(a.length === 1 && Number(a[0].amount) === 2000 && a[0].d === '2026-11-18' && a[0].method === 'EFT' && a[0].reference === (atcRef || '') && a[0].company_code === CO && /Moved from the payment recorded on INV-00239/.test(a[0].notes),
    'one payment on account: R2,000, 2026-11-18, EFT, original reference, same company, with its history note', a[0]);
  ok((await q(`SELECT COUNT(*)::int n FROM rel_payments WHERE source_id = 'hist-atc'`))[0].n === 0, 'the old payment row is gone (counted once)');
  const iv = (await q(`SELECT * FROM rel_invoices WHERE id = $1`, [ids.atc.invoiceId]))[0];
  ok(iv.status === 'void' && iv.invoice_number === 'INV-00239' && iv.job_id === null && iv.legacy_data.cancelledVia === 'script:repair-historical-credit' && /payment on account/.test(iv.legacy_data.cancelledReason) && iv.legacy_data.originalJobNum === 'SNS-00253',
    'INV-00239 cancelled and retained (number, reason, original job kept)', { status: iv.status, marker: iv.legacy_data });
  const jb = (await q(`SELECT * FROM rel_jobs WHERE id = $1`, [ids.atc.jobId]))[0];
  ok(jb && jb.invoice_num === null && jb.job_number === 'SNS-00253' && (await q(`SELECT COUNT(*)::int n FROM rel_quotes WHERE id = $1`, [ids.atc.quoteId]))[0].n === 1, 'job SNS-00253 and its quote kept; invoice link released');
  const ac = await C.getCustomerCredit(CO, 'C-ATC');
  ok(ac.totals.paymentCredit === 2000 && ac.paymentCredits[0].sourceType === 'account_receipt', 'ATC: R2,000 payment-on-account credit', ac.totals);
  ok((await q(`SELECT COUNT(*)::int n FROM rel_credit_notes`))[0].n === 0 && (await q(`SELECT COUNT(*)::int n FROM rel_credit_refunds`))[0].n === 0, 'no credit note and no refund created');
  const listed = await C.listAccountReceipts([CO]);
  ok(listed.filter((x: any) => x.customerRef === 'C-ATC').length === 1, 'cash-received list: ATC R2,000 once');

  console.log('\n[7] everything else unchanged');
  ok(JSON.stringify((await C.getCustomerCredit(CO, 'C-HIST')).totals) === JSON.stringify(otherBefore.hist) && (await C.getCustomerCredit(CO, 'C-HIST')).totals.total === 0, 'another historical overpayment is still not spendable');
  ok(JSON.stringify((await C.getCustomerCredit(CO, 'C-LIVE')).totals) === JSON.stringify(otherBefore.live), "another customer's credit is unchanged");
  ok((await q(`SELECT credit_eligible FROM rel_payments WHERE source_id = 'hist-other'`))[0].credit_eligible === false, 'the other historical receipt was not touched');

  console.log('\n[8] a second run writes nothing');
  const before8 = await dbPrint();
  const d2 = run();
  ok(d2.code === 0 && /already repaired. Nothing to do/.test(d2.out), 'dry run: both already repaired', d2.out.slice(-300));
  r = run('--apply', `--confirm=${confirm}`, `--expect=${fp2}`);
  ok(r.code === 0 && /already repaired — nothing written/.test(r.out), 'apply again: nothing written');
  ok(JSON.stringify(await dbPrint()) === JSON.stringify(before8), 'no duplicate receipt, credit or audit row');

  console.log('\n[9] the repaired credit is usable — partly, then reversed');
  const nr = await S.createManualInvoice({ companyCode: CO, contactName: 'Raider Outboards International', customerRef: 'C-RAIDER', lines: L(500) });
  const rcp = (await C.getCustomerCredit(CO, 'C-RAIDER')).paymentCredits[0];
  const al = await C.applyCredit({ sourceType: 'payment', sourceId: rcp.sourceId, targetType: 'invoice', targetId: Number(nr.id), amount: 300, actor });
  ok((await C.getCustomerCredit(CO, 'C-RAIDER')).totals.paymentCredit === 1495.76, 'Raider: R300 applied to a new invoice, R1,495.76 left');
  const na = await S.createManualInvoice({ companyCode: CO, contactName: 'Advanced Tactical Craft (PTY) LTD - ATC Marine', customerRef: 'C-ATC', lines: L(800) });
  const al2 = await C.applyCredit({ sourceType: 'account_receipt', sourceId: Number(a[0].id), targetType: 'invoice', targetId: Number(na.id), amount: 800, actor });
  ok((await C.getCustomerCredit(CO, 'C-ATC')).totals.paymentCredit === 1200, 'ATC: R800 applied to a new invoice, R1,200 left');
  const d3 = run();
  ok(d3.code === 0 && /already repaired/.test(d3.out), 'a run after the credit was used still reads both as repaired (writes nothing)', d3.out.slice(-300));
  await C.reverseCreditAllocation(al.allocationId, { actor }); await C.reverseCreditAllocation(al2.allocationId, { actor });
  ok((await C.getCustomerCredit(CO, 'C-RAIDER')).totals.paymentCredit === 1795.76 && (await C.getCustomerCredit(CO, 'C-ATC')).totals.paymentCredit === 2000, 'reversals restore R1,795.76 and R2,000');
}

async function unexpected() {
  console.log('\n════ unexpected data is refused ════');
  const ids = await seed('invoice', 'ATC-EFT');
  await pool.query(`INSERT INTO rel_payments (source_id, owner_type, owner_id, line_index, amount, payment_date, method) VALUES ('extra', 'invoice', $1, 1, 50, '2026-11-19', 'Cash')`, [ids.atc.invoiceId]);
  let r = run();
  ok(r.code === 1 && /REFUSED:\s+expected exactly one payment on the chain, found 2/.test(r.out), 'an extra payment on the ATC chain is refused', r.out.slice(-500));
  await pool.query(`DELETE FROM rel_payments WHERE source_id = 'extra'`);
  await pool.query(`UPDATE rel_payments SET amount = 1999.99 WHERE source_id = 'hist-raider'`);
  r = run();
  ok(r.code === 1 && /REFUSED:\s+the payment is R1999\.99, expected R2000\.00/.test(r.out), 'a different Raider amount is refused');
  await pool.query(`UPDATE rel_payments SET amount = 2000 WHERE source_id = 'hist-raider'`);
  const cs = [{ id: 'C-RAIDER', companyName: 'Raider Outboards International' }, { id: 'C-RAIDER2', companyName: 'Raider Outboards International' },
    { id: 'C-ATC', companyName: 'Advanced Tactical Craft (PTY) LTD - ATC Marine' }];
  await pool.query(`UPDATE platform_state SET data = jsonb_set(data, '{customers}', $1::jsonb) WHERE id = 1`, [JSON.stringify(cs)]);
  r = run();
  ok(r.code === 1 && /2 customer records are named "Raider Outboards International"/.test(r.out), 'a duplicate customer name is refused (no guessing)');
  await pool.query(`UPDATE platform_state SET data = jsonb_set(data, '{customers}', $1::jsonb) WHERE id = 1`, [JSON.stringify([cs[0], cs[2]])]);
  await pool.query(`UPDATE rel_invoices SET company_code = '4' WHERE id = $1`, [ids.atc.invoiceId]);
  r = run();
  ok(r.code === 1 && /job SNS-00253 is in company 2 but invoice INV-00239 is in company 4/.test(r.out), 'a company mismatch is refused');
  ok((await q(`SELECT COUNT(*)::int n FROM customer_link_audit WHERE action = 'historical-credit-repair'`))[0].n === 0, 'nothing was written by any refused run');
}

async function main() {
  await variant('invoice', 'ATC-EFT-18NOV');
  await variant('job', '');
  await unexpected();
  await pool.query('TRUNCATE TABLE rel_account_receipts, rel_credit_allocations, rel_credit_refunds RESTART IDENTITY');
  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
}
main().catch(async (e) => { console.error('[repair-historical-credit] Fatal error:', e); await pool.end().catch(() => undefined); process.exit(1); });
