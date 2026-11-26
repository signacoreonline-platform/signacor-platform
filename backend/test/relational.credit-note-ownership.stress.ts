/**
 * relational.credit-note-ownership.stress.ts — a customer credit note's owner is
 * its customer LINK, and an unlinked historical note is locked to its customer
 * the first time it provides credit (2026-11-26, customer credit).
 *
 * Disposable *_test database only (TRUNCATEs rel_* credit/document tables and
 * rewrites platform_state.customers). Synthetic data only. Service-level, no
 * HTTP server needed (the routes call exactly these services).
 */
import pool from '../src/db/pool';
import * as S from '../src/relational/services';
import * as C from '../src/relational/customerCredit';

const url = process.env.DATABASE_URL || '';
const dbName = (url.match(/\/([^/?]+)(\?|$)/) || [])[1] || '';
if (!/_test$/.test(dbName) && process.env.ALLOW_UNSAFE_TEST_DB !== '1') {
  console.error(`[credit-note-ownership] refusing to run: database "${dbName}" is not a *_test database.`);
  process.exit(2);
}
let passed = 0, failed = 0;
function ok(cond: unknown, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''}`); }
}
async function refuses(fn: () => Promise<unknown>, re: RegExp, label: string) {
  try { await fn(); ok(false, label, 'was accepted'); }
  catch (e: any) { ok(re.test(String(e?.message || e)), label, String(e?.message || e).slice(0, 240)); }
}
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;
const CO = '2';
const actor = { id: 'u-test', email: 'accounts@test.local', role: 'accounts', co: null };
const L = (amt: number) => [{ description: 'Signage', qty: 1, unitAmount: amt, taxType: 'No VAT' }];
let customers: any[] = [];
async function setCustomers(list: any[]) {
  customers = list;
  await pool.query(`INSERT INTO platform_state (id, data) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET data = jsonb_set(COALESCE(platform_state.data,'{}'::jsonb), '{customers}', $2::jsonb)`,
    [JSON.stringify({ customers: list }), JSON.stringify(list)]);
}
const inv = (name: string, amt: number, ref: string | null) => S.createManualInvoice({ companyCode: CO, contactName: name, customerRef: ref, lines: L(amt) });
const legacyNote = async (num: string, name: string, amount: number, extra: { legacyCustomerId?: string } = {}) => Number((await q(
  `INSERT INTO rel_credit_notes (source_id, credit_number, note_type, contact_name_raw, note_date, amount, used_amount, company_code, legacy_data)
   VALUES ($1, $1, 'customer', $2, '2026-07-01', $3, 0, $4, $5::jsonb) RETURNING id`,
  [num, name, amount, CO, JSON.stringify(extra.legacyCustomerId ? { customerId: extra.legacyCustomerId } : {})]))[0].id);
const note = async (id: number) => (await q('SELECT * FROM rel_credit_notes WHERE id = $1', [id]))[0];
const audits = async (id: number) => q(`SELECT * FROM customer_link_audit WHERE members @> $1::jsonb ORDER BY id`, [JSON.stringify([{ type: 'credit_note', id }])]);
const avail = async (ref: string) => (await C.getCustomerCredit(CO, ref)).totals.creditNotes;

async function main() {
  await pool.query(`TRUNCATE TABLE rel_credit_allocations, rel_credit_refunds, rel_payments, rel_invoice_line_items, rel_invoices,
    rel_job_line_items, rel_jobs, rel_quote_line_items, rel_quotes, rel_credit_notes RESTART IDENTITY CASCADE`);
  await pool.query(`DELETE FROM customer_link_audit`);
  await pool.query(`DELETE FROM document_number_counters`);
  await setCustomers([
    { id: 'C-ACME', companyName: 'Acme Signs' },
    { id: 'C-BETA', companyName: 'Beta Print' },
    { id: 'C-TWIN1', companyName: 'Twin Co' }, { id: 'C-TWIN2', companyName: 'Twin Co' },
    { id: 'C-GAMMA', companyName: 'Gamma Ltd' },
  ]);

  console.log('\n[1] New customer credit notes must be linked to an existing customer (and a company)');
  await refuses(() => S.createCreditNote({ companyCode: CO, type: 'customer', contactName: 'Acme Signs', amount: 100 } as any), /must be linked to a customer record/, 'no customer link → refused');
  await refuses(() => S.createCreditNote({ companyCode: CO, type: 'customer', contactName: 'Acme Signs', customerRef: 'C-NOPE', amount: 100 } as any), /no longer exists|Choose an existing customer/, 'unknown customer link → refused');
  await refuses(() => S.createCreditNote({ companyCode: '', type: 'customer', contactName: 'Acme Signs', customerRef: 'C-ACME', amount: 100 } as any), /company/, 'no company → refused');
  const created = await S.createCreditNote({ companyCode: CO, type: 'customer', contactName: 'Acme Signs', customerRef: 'C-ACME', amount: 100 } as any);
  const cr = await note(created.id);
  ok(cr.customer_ref === 'C-ACME' && cr.company_code === CO, 'linked note persists customer_ref and company_code', { ref: cr.customer_ref, co: cr.company_code });
  const sup = await S.createCreditNote({ companyCode: CO, type: 'supplier', contactName: 'Some Supplier', amount: 50 } as any);
  ok(!!sup.id, 'supplier credit notes are not customer credit and need no customer link');
  await refuses(async () => { const n = await note(created.id); await S.updateCreditNote(created.id, n.row_version, { customerRef: null }); }, /cannot be removed/, 'a linked note cannot be unlinked');

  console.log('\n[2] First use locks an unlinked note to the customer it unambiguously resolves to (manual allocation)');
  const n1 = await legacyNote('CN-L1', 'Acme Signs', 300);
  const i1 = await inv('Acme Signs', 1000, 'C-ACME');
  ok((await note(n1)).customer_ref === null, 'before use: unlinked');
  const a1 = await C.applyCredit({ sourceType: 'credit_note', sourceId: n1, targetType: 'invoice', targetId: Number(i1.id), amount: 100, actor });
  ok((await note(n1)).customer_ref === 'C-ACME', 'after first allocation: customer_ref = C-ACME (same transaction)');
  let au = await audits(n1);
  ok(au.length === 1 && au[0].action === 'credit-note-owner' && au[0].to_ref === 'C-ACME' && au[0].detail.reason === 'allocation' && au[0].detail.via === 'name' && au[0].actor === 'accounts@test.local',
    'ownership assignment recorded once in customer_link_audit (who, how resolved, why)', au);
  await C.applyCredit({ sourceType: 'credit_note', sourceId: n1, targetType: 'invoice', targetId: Number(i1.id), amount: 50, actor });
  ok((await audits(n1)).length === 1, 'a later use does not re-assign or re-audit');

  console.log('\n[3] Renaming customers cannot transfer locked credit');
  // Worst case: Acme renamed away AND Beta renamed to "Acme Signs", with formerNames wiped (e.g. via a JSON save).
  await setCustomers([{ id: 'C-ACME', companyName: 'Acme Renamed' }, { id: 'C-BETA', companyName: 'Acme Signs' }, ...customers.slice(2)]);
  ok(await avail('C-ACME') === 250 && await avail('C-BETA') === 0, 'C-ACME keeps R250 (R150 left on CN-L1 + its linked R100 note); C-BETA (now named "Acme Signs") gets nothing', { acme: await avail('C-ACME'), beta: await avail('C-BETA') });
  const iBeta = await inv('Acme Signs', 500, 'C-BETA');
  await refuses(() => C.applyCredit({ sourceType: 'credit_note', sourceId: n1, targetType: 'invoice', targetId: Number(iBeta.id), amount: 10, actor }), /belongs to/, 'allocating it to the renamed other customer is refused');
  await refuses(() => S.recordPayment({ type: 'invoice', id: Number(iBeta.id) }, 10 as any, { date: '2026-12-01', method: 'Credit', creditNoteId: n1, actor }), /does not belong/, 'a Credit payment from it on the other customer is refused');

  console.log('\n[4] Reversals keep the owner; a used note can never be re-pointed');
  for (const a of await q(`SELECT id FROM rel_credit_allocations WHERE source_credit_note_id = $1 AND status = 'active'`, [n1])) await C.reverseCreditAllocation(Number(a.id), { actor });
  const afterRev = await note(n1);
  ok(afterRev.customer_ref === 'C-ACME' && Number(afterRev.used_amount) === 0, 'all uses reversed: used R0, still linked to C-ACME');
  await refuses(() => S.updateCreditNote(n1, afterRev.row_version, { customerRef: 'C-BETA' }), /cannot be changed/, 're-pointing a note that has provided credit is refused even after reversal');
  await refuses(() => S.updateCreditNote(n1, afterRev.row_version, { customerRef: null }), /cannot be removed/, 'unlinking it is refused');
  const nv = await note(n1); await S.updateCreditNote(n1, nv.row_version, { notes: 'edited', customerRef: 'C-ACME' });
  ok((await note(n1)).customer_ref === 'C-ACME' && (await audits(n1)).length === 1, 'an ordinary edit that re-sends the same link changes nothing about ownership');
  void a1;
  await setCustomers([{ id: 'C-ACME', companyName: 'Acme Signs' }, { id: 'C-BETA', companyName: 'Beta Print' }, ...customers.slice(2)]);

  console.log('\n[5] Ambiguous / unresolved notes need an explicit customer choice first');
  const nTwin = await legacyNote('CN-TWIN', 'Twin Co', 200);
  const iTwin = await inv('Twin Co', 500, 'C-TWIN1');
  await refuses(() => C.applyCredit({ sourceType: 'credit_note', sourceId: nTwin, targetType: 'invoice', targetId: Number(iTwin.id), amount: 50, actor }), /not linked to a customer.*Choose its customer/, 'two customers share the name → manual allocation refused, asks for a choice');
  await refuses(() => S.recordPayment({ type: 'invoice', id: Number(iTwin.id) }, 50 as any, { date: '2026-12-01', method: 'Credit', creditNoteId: nTwin, actor }), /Choose its customer/, 'explicit Credit payment from it refused with the same instruction');
  await refuses(() => S.recordPayment({ type: 'invoice', id: Number(iTwin.id) }, 50 as any, { date: '2026-12-01', method: 'Credit', actor }), /only has R0\.00/, 'automatic credit-note usage skips it (never guesses)');
  ok((await note(nTwin)).customer_ref === null && (await audits(nTwin)).length === 0, 'nothing was linked or audited by the refused attempts');
  // Former-name conflict: current name of one customer, former name of another.
  await setCustomers([...customers.filter((c) => c.id !== 'C-GAMMA'), { id: 'C-GAMMA', companyName: 'Gamma Ltd', formerNames: ['Acme Signs'] }]);
  const nConf = await legacyNote('CN-CONF', 'Acme Signs', 80);
  const iA2 = await inv('Acme Signs', 500, 'C-ACME');
  await refuses(() => C.applyCredit({ sourceType: 'credit_note', sourceId: nConf, targetType: 'invoice', targetId: Number(iA2.id), amount: 10, actor }), /current name of one customer and a former name of another/, 'a name that is another customer\'s former name is not unambiguous evidence');
  // Explicit choice, then use.
  const tv = await note(nTwin);
  await S.updateCreditNote(nTwin, tv.row_version, { customerRef: 'C-TWIN1' }, actor as any);
  const tAud = await audits(nTwin);
  ok((await note(nTwin)).customer_ref === 'C-TWIN1' && tAud.length === 1 && tAud[0].action === 'link' && tAud[0].to_ref === 'C-TWIN1', 'explicit choice links it and is audited ("link")', tAud);
  await C.applyCredit({ sourceType: 'credit_note', sourceId: nTwin, targetType: 'invoice', targetId: Number(iTwin.id), amount: 50, actor });
  ok((await audits(nTwin)).length === 1, 'then usable; no second ownership assignment');

  console.log('\n[6] Automatic / Credit-payment allocation and refunds lock ownership too');
  const nAuto = await legacyNote('CN-AUTO', 'Beta Print', 120);
  const iB = await inv('Beta Print', 400, 'C-BETA');
  await S.recordPayment({ type: 'invoice', id: Number(iB.id) }, 70 as any, { date: '2026-12-01', method: 'Credit', actor });
  let aa = await audits(nAuto);
  ok((await note(nAuto)).customer_ref === 'C-BETA' && aa.length === 1 && aa[0].detail.reason === 'credit-payment', 'a "Credit" payment (dashboard auto-usage path) locks the note to C-BETA', aa);
  const nLegacy = await legacyNote('CN-LEGID', 'Some Old Spelling', 60, { legacyCustomerId: 'C-BETA' });
  await C.recordCreditRefund({ sourceType: 'credit_note', sourceId: nLegacy, amount: 20, date: '2026-12-02', method: 'EFT', reference: 'RF-L', actor } as any);
  aa = await audits(nLegacy);
  ok((await note(nLegacy)).customer_ref === 'C-BETA' && aa.length === 1 && aa[0].detail.reason === 'refund' && aa[0].detail.via === 'link' && aa[0].detail.legacyCustomerId === 'C-BETA',
    'a refund locks a note that carried only its original customerId (persisted as customer_ref)', aa);

  console.log('\n[7] Simultaneous first uses cannot assign conflicting owners');
  const nRace = await legacyNote('CN-RACE', 'Acme Signs', 200);
  // A competing transaction links the note to C-BETA and holds its row lock…
  const other = await pool.connect();
  await other.query('BEGIN');
  const locked = (await other.query('SELECT * FROM rel_credit_notes WHERE id = $1 FOR UPDATE', [nRace])).rows[0];
  await C.pinCreditNoteOwnerTx(other as any, locked, { state: 'matched', ref: 'C-BETA', name: 'Beta Print', via: 'name' }, { reason: 'allocation', actor });
  // …while an allocation to C-ACME (resolved by name) starts and has to wait.
  const iRace = await inv('Acme Signs', 500, 'C-ACME');
  const racing = C.applyCredit({ sourceType: 'credit_note', sourceId: nRace, targetType: 'invoice', targetId: Number(iRace.id), amount: 50, actor }).then(() => 'ok', (e) => String(e.message));
  await new Promise((r) => setTimeout(r, 400));
  await other.query('COMMIT'); other.release();
  const raceRes = await racing;
  ok(raceRes !== 'ok' && /belongs to/.test(raceRes), 'the waiting allocation sees the committed owner and is refused', raceRes);
  ok((await note(nRace)).customer_ref === 'C-BETA' && (await audits(nRace)).length === 1 && Number((await note(nRace)).used_amount) === 0, 'exactly one owner, one audit row, no credit used');
  // Stale view: a transaction holding an outdated (unlinked) copy cannot overwrite the owner.
  const c2 = await pool.connect();
  await c2.query('BEGIN');
  const stale = { ...locked, customer_ref: null };
  let staleErr = '';
  try { await C.pinCreditNoteOwnerTx(c2 as any, stale, { state: 'matched', ref: 'C-ACME', name: 'Acme Signs', via: 'name' }, { reason: 'allocation', actor }); } catch (e: any) { staleErr = e.message; }
  await c2.query('ROLLBACK'); c2.release();
  ok(/just linked to another customer/.test(staleErr) && (await note(nRace)).customer_ref === 'C-BETA', 'the conditional update refuses a second, different owner', staleErr);
  // Two concurrent first uses for the SAME customer: both succeed, one assignment.
  const nSame = await legacyNote('CN-SAME', 'Gamma Ltd', 100);
  const iG1 = await inv('Gamma Ltd', 300, 'C-GAMMA'); const iG2 = await inv('Gamma Ltd', 300, 'C-GAMMA');
  const both = await Promise.allSettled([iG1, iG2].map((i) => C.applyCredit({ sourceType: 'credit_note', sourceId: nSame, targetType: 'invoice', targetId: Number(i.id), amount: 40, actor })));
  ok(both.every((r) => r.status === 'fulfilled') && (await note(nSame)).customer_ref === 'C-GAMMA' && (await audits(nSame)).length === 1 && Number((await note(nSame)).used_amount) === 80,
    'two simultaneous first uses by the same customer: both recorded, one ownership assignment', both.map((r: any) => r.status + (r.reason ? r.reason.message : '')));

  console.log('\n[8] A failed allocation rolls back the ownership assignment');
  const nFail = await legacyNote('CN-FAIL', 'Beta Print', 150);
  const iF = await inv('Beta Print', 500, 'C-BETA');
  await pool.query(`CREATE OR REPLACE FUNCTION own_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'synthetic allocation failure'; END $$ LANGUAGE plpgsql`);
  await pool.query(`CREATE TRIGGER own_fail BEFORE INSERT ON rel_credit_allocations FOR EACH ROW EXECUTE FUNCTION own_fail()`);
  await refuses(() => C.applyCredit({ sourceType: 'credit_note', sourceId: nFail, targetType: 'invoice', targetId: Number(iF.id), amount: 30, actor }), /synthetic allocation failure/, 'manual allocation fails');
  await refuses(() => S.recordPayment({ type: 'invoice', id: Number(iF.id) }, 30 as any, { date: '2026-12-01', method: 'Credit', creditNoteId: nFail, actor }), /synthetic allocation failure/, 'Credit payment fails');
  await pool.query(`DROP TRIGGER own_fail ON rel_credit_allocations`); await pool.query(`DROP FUNCTION own_fail()`);
  const nf = await note(nFail);
  ok(nf.customer_ref === null && Number(nf.used_amount) === 0 && (await audits(nFail)).length === 0, 'note still unlinked, nothing used, no audit row', { ref: nf.customer_ref, used: nf.used_amount });
  ok((await q(`SELECT COUNT(*)::int n FROM rel_payments WHERE owner_type='invoice' AND owner_id=$1`, [iF.id]))[0].n === 0, 'no payment row left on the invoice');

  console.log('\n[9] Historical amounts untouched');
  ok(Number((await note(n1)).amount) === 300 && Number((await note(nTwin)).amount) === 200, 'note amounts unchanged by ownership locking');

  await pool.query('TRUNCATE TABLE rel_credit_allocations, rel_credit_refunds RESTART IDENTITY');
  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}
main().catch(async (e) => { console.error('[credit-note-ownership] Fatal error:', e); await pool.end().catch(() => undefined); process.exit(1); });
