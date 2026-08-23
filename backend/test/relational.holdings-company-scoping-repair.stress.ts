/**
 * relational.holdings-company-scoping-repair.stress.ts — PRODUCTION CUTOVER
 * REPAIR: "SIGNACORE HOLDINGS SHOWS ZERO DATA".
 *
 * ROOT CAUSE (confirmed by local reproduction before this fix, see the
 * incident report): every rel_* table's `company_code` column is TEXT, and
 * backend/src/relational/read.ts's builders for quotes/jobs/accInvoices/
 * purchaseOrders hydrated it VERBATIM (`co: r.company_code`) — a string.
 * Every pre-cutover legacy-JSON creation path, and every frontend
 * company-scoping predicate (isHoldingsUser/isHoldingsRecord/
 * belongsToUserCompany in index.html), assumes `co` is a genuine JS number
 * and compares it with strict `===` against the numeric HOLDINGS_CO_ID (1).
 * A string can never `===` a number, so:
 *   - Holdings users (belongsToUserCompany = isHoldingsRecord(rec)) saw
 *     ZERO records for every relationally-authoritative, company-specific
 *     section — this is the reported "Holdings shows zero data" symptom.
 *   - Original-company users (belongsToUserCompany = !isHoldingsRecord(rec))
 *     saw EVERY relational record from BOTH companies — an undetected
 *     cross-company data leak in the opposite direction.
 * This was a pure READ/HYDRATION-TIME bug. It did not touch backfill (which
 * copies `co` faithfully as a string, company-agnostic) or the SQL read
 * layer (which has never filtered by company — company scoping has always
 * been a frontend-only concern, both before and after cutover).
 *
 * THE FIX: read.ts's new coNum() helper casts company_code back to a real
 * JS number at the single point relational rows re-enter the JSON shape
 * (see buildQuotesJson/buildJobsJson/buildInvoicesJson/
 * buildPurchaseOrdersJson), restoring the "co is always a number" invariant
 * the rest of the app has always assumed. index.html's Dashboard company
 * breakdown chart (`x.co===active`, `x.co===c.id` — an independently
 * discovered instance of the exact same bug class, unrelated to Holdings
 * specifically) was also hardened with Number(...) normalization.
 *
 * This suite proves, for every relationally-authoritative company-specific
 * section (quotes, jobs, accInvoices, purchaseOrders):
 *   1. A Holdings-tagged record and an Original-tagged record are each
 *      hydrated with `co` as a genuine number (not a string) via read.ts.
 *   2. A faithful re-implementation of index.html's own
 *      isHoldingsRecord/belongsToUserCompany correctly separates them for
 *      BOTH a Holdings user and an Original-company user — no leakage
 *      either direction.
 *   3. Suppliers and inventory (explicitly SHARED sections per the
 *      COMPANY CONTEXT comment block) are visible identically regardless
 *      of company — i.e. they carry no company exclusion at all.
 *   4. A NEW Holdings write (via services.ts, exactly as the frontend's
 *      relationalApi.createX calls do) round-trips through read.ts and is
 *      then correctly scoped to Holdings only — proving the write path
 *      is safe and that a freshly-created Holdings record will not
 *      "disappear" after the next refresh.
 *   5. Source-text checks confirm index.html's own predicates and the
 *      Dashboard chart fix are the exact code actually shipped, so this
 *      suite is proving the REAL fix, not a reimplementation that merely
 *      happens to agree with it.
 *
 * A companion, explicitly-scoped note: rel_credit_notes has NO
 * company_code column at all (confirmed in migration 007), and
 * services.createCreditNote persists legacy_data as '{}' — so a NEW credit
 * note created post-cutover loses its `co` tag entirely (this is a
 * DIFFERENT, structurally distinct bug from the string/number mismatch
 * fixed here: backfilled credit notes are unaffected, since their `co`
 * survives verbatim inside legacy_data). That gap is intentionally NOT
 * fixed in this pass (it needs a schema migration — company_code column +
 * services.ts + frontend companyCode threading — a materially larger
 * change than a read-hydration cast) and is asserted here as a known,
 * documented, currently-still-open gap so it cannot silently regress
 * further or be mistaken for already fixed.
 */
import fs from 'fs';
import path from 'path';
import pool from '../src/db/pool';
import * as services from '../src/relational/services';
import * as read from '../src/relational/read';

const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH || path.resolve(__dirname, '..', '..', 'index.html');

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

// Faithful re-implementation of index.html's own COMPANY CONTEXT block
// (HOLDINGS_CO_ID / isHoldingsUser / isHoldingsRecord / belongsToUserCompany).
// The source-text checks below confirm these lines are what actually ships.
const HOLDINGS_CO_ID = 1;
function isHoldingsUser(user: any) { return !!user && user.co === HOLDINGS_CO_ID; }
function isHoldingsRecord(rec: any) { return !!rec && rec.co === HOLDINGS_CO_ID; }
function belongsToUserCompany(rec: any, user: any) {
  return isHoldingsUser(user) ? isHoldingsRecord(rec) : !isHoldingsRecord(rec);
}
const HOLDINGS_USER = { co: 1 };
const ORIGINAL_USER = { co: 2 };

function checkSourceWiring(src: string) {
  console.log('\n[Holdings scoping repair] source-text checks — the real predicates and chart fix match what this suite exercises');
  ok(src.includes('const HOLDINGS_CO_ID = 1;'), 'HOLDINGS_CO_ID is still 1 in index.html');
  ok(src.includes('function isHoldingsUser(user){ return !!user && user.co === HOLDINGS_CO_ID; }'), 'isHoldingsUser is the exact strict-equality predicate this suite re-implements');
  ok(src.includes('function isHoldingsRecord(rec){ return !!rec && rec.co === HOLDINGS_CO_ID; }'), 'isHoldingsRecord is the exact strict-equality predicate this suite re-implements');
  ok(src.includes('return isHoldingsUser(user) ? isHoldingsRecord(rec) : !isHoldingsRecord(rec);'), 'belongsToUserCompany is the exact predicate this suite re-implements');
  ok(src.includes('const j=active===0?visibleJobs:visibleJobs.filter(x=>Number(x.co)===Number(active));'),
    'Dashboard per-tab job filter now normalizes co/active to numbers before comparing (was the second instance of this bug class)');
  ok(src.includes('const cd=visibleCompanies.map(c=>{const j=visibleJobs.filter(x=>Number(x.co)===Number(c.id));'),
    'Dashboard company-breakdown chart now normalizes co/c.id to numbers before comparing');
}

async function resetRelationalTables() {
  await pool.query(`
    TRUNCATE TABLE rel_payments, rel_invoice_line_items, rel_invoices, rel_job_line_items,
      rel_jobs, rel_quote_line_items, rel_quotes, rel_customers, rel_credit_notes,
      rel_purchase_order_items, rel_purchase_orders, rel_suppliers, rel_inventory_items
    RESTART IDENTITY CASCADE
  `);
  await pool.query(`DELETE FROM document_number_counters`);
  await pool.query(`DELETE FROM quote_conversions`);
}

async function main() {
  await resetRelationalTables();
  const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  checkSourceWiring(src);

  console.log('\n[Holdings scoping repair] QUOTES — Holdings and Original quotes hydrate with numeric co and separate cleanly');
  const cust = await services.createCustomer({ companyName: 'Holdings Scoping Test Customer' });
  const qHoldings = await services.createQuote({ companyCode: '1', customerId: cust.id, customerNameRaw: 'Holdings Test Customer', lines: [{ description: 'Sign A', qty: 1, unitPrice: 1000 }] });
  const qOriginal = await services.createQuote({ companyCode: '2', customerId: cust.id, customerNameRaw: 'Original Test Customer', lines: [{ description: 'Sign B', qty: 1, unitPrice: 500 }] });
  const quotes = await read.buildQuotesJson();
  const qH = quotes.find((q: any) => q._relId === qHoldings.id);
  const qO = quotes.find((q: any) => q._relId === qOriginal.id);
  ok(typeof qH.co === 'number' && qH.co === 1, 'Holdings quote hydrates co as the NUMBER 1, not the string "1"', qH.co);
  ok(typeof qO.co === 'number' && qO.co === 2, 'Original quote hydrates co as the NUMBER 2, not the string "2"', qO.co);
  ok(quotes.filter((q: any) => belongsToUserCompany(q, HOLDINGS_USER)).every((q: any) => q._relId === qHoldings.id) &&
     quotes.some((q: any) => belongsToUserCompany(q, HOLDINGS_USER)),
    'a Holdings user sees the Holdings quote and ONLY the Holdings quote — this is the exact "zero data" symptom, now fixed');
  ok(quotes.filter((q: any) => belongsToUserCompany(q, ORIGINAL_USER)).every((q: any) => q._relId === qOriginal.id) &&
     quotes.some((q: any) => belongsToUserCompany(q, ORIGINAL_USER)),
    'an Original-company user sees the Original quote and ONLY the Original quote — no cross-company leak in the other direction');

  console.log('\n[Holdings scoping repair] JOBS — same proof via quote-to-job conversion (co is inherited from the source quote)');
  const jHoldingsConv = await services.convertQuoteToJob(qHoldings.id);
  const jOriginalConv = await services.convertQuoteToJob(qOriginal.id);
  const jobs = await read.buildJobsJson();
  const jH = jobs.find((j: any) => j._relId === jHoldingsConv.jobId);
  const jO = jobs.find((j: any) => j._relId === jOriginalConv.jobId);
  ok(typeof jH.co === 'number' && jH.co === 1, 'Holdings job hydrates co as the NUMBER 1', jH.co);
  ok(typeof jO.co === 'number' && jO.co === 2, 'Original job hydrates co as the NUMBER 2', jO.co);
  ok(jobs.filter((j: any) => belongsToUserCompany(j, HOLDINGS_USER)).length === 1 && belongsToUserCompany(jH, HOLDINGS_USER),
    'a Holdings user sees exactly the Holdings job (jobs no longer show zero data for Holdings)');
  ok(jobs.filter((j: any) => belongsToUserCompany(j, ORIGINAL_USER)).length === 1 && belongsToUserCompany(jO, ORIGINAL_USER),
    'an Original-company user sees exactly the Original job — no leak');

  console.log('\n[Holdings scoping repair] ACCINVOICES (manual invoice path) — co hydrates as a number and separates correctly');
  const invHoldings = await services.createManualInvoice({ companyCode: '1', contactName: 'Holdings Invoice Contact', lines: [{ description: 'Banner', qty: 1, unitAmount: 800 }] });
  const invOriginal = await services.createManualInvoice({ companyCode: '2', contactName: 'Original Invoice Contact', lines: [{ description: 'Banner', qty: 1, unitAmount: 400 }] });
  const invoices = await read.buildInvoicesJson();
  const iH = invoices.find((i: any) => i._relId === invHoldings.id);
  const iO = invoices.find((i: any) => i._relId === invOriginal.id);
  ok(typeof iH.co === 'number' && iH.co === 1, 'Holdings manual invoice hydrates co as the NUMBER 1', iH.co);
  ok(typeof iO.co === 'number' && iO.co === 2, 'Original manual invoice hydrates co as the NUMBER 2', iO.co);
  ok(invoices.filter((i: any) => belongsToUserCompany(i, HOLDINGS_USER)).every((i: any) => i._relId === invHoldings.id) && iH && belongsToUserCompany(iH, HOLDINGS_USER),
    'a Holdings user sees the Holdings invoice, not the Original one');
  ok(invoices.filter((i: any) => belongsToUserCompany(i, ORIGINAL_USER)).every((i: any) => i._relId === invOriginal.id) && iO && belongsToUserCompany(iO, ORIGINAL_USER),
    'an Original-company user sees the Original invoice, not the Holdings one');

  console.log('\n[Holdings scoping repair] PURCHASE ORDERS — co hydrates as a number and separates correctly');
  const supplier = await services.createSupplier({ name: 'Scoping Test Supplier' });
  const poItems = [{ name: 'Vinyl roll', qtyNeeded: 1, qtyOrdered: 1 }];
  const poHoldings = await services.createPurchaseOrder({ companyCode: '1', supplierId: supplier.id, items: poItems });
  const poOriginal = await services.createPurchaseOrder({ companyCode: '2', supplierId: supplier.id, items: poItems });
  const pos = await read.buildPurchaseOrdersJson();
  const pH = pos.find((p: any) => p._relId === poHoldings.id);
  const pO = pos.find((p: any) => p._relId === poOriginal.id);
  ok(typeof pH.co === 'number' && pH.co === 1, 'Holdings PO hydrates co as the NUMBER 1', pH.co);
  ok(typeof pO.co === 'number' && pO.co === 2, 'Original PO hydrates co as the NUMBER 2', pO.co);
  ok(belongsToUserCompany(pH, HOLDINGS_USER) && !belongsToUserCompany(pO, HOLDINGS_USER), 'a Holdings user sees the Holdings PO and not the Original PO');
  ok(belongsToUserCompany(pO, ORIGINAL_USER) && !belongsToUserCompany(pH, ORIGINAL_USER), 'an Original-company user sees the Original PO and not the Holdings PO');

  console.log('\n[Holdings scoping repair] SHARED sections (suppliers, inventory) remain visible identically to both companies — no exclusion applied');
  const suppliers = await read.buildSuppliersJson();
  const supplierRead = suppliers.find((s: any) => s._relId === supplier.id);
  ok(!!supplierRead, 'the test supplier exists in the shared suppliers list');
  ok(!Object.prototype.hasOwnProperty.call(supplierRead || {}, 'co'),
    'suppliers carry no `co` field at all (buildSuppliersJson never hydrates one) — confirming suppliers.filter(belongsToUserCompany) is structurally impossible, matching the grep-confirmed absence of any such filter in index.html, so both companies see this record identically');
  const item = await services.createInventoryItem({ name: 'Scoping Test Vinyl', stock: 10, reorder: 2, cost: 5, sell: 15 });
  const inventory = await read.buildInventoryJson();
  ok(inventory.some((i: any) => i._relId === item.id), 'the test inventory item exists in the shared inventory list, reachable identically for both companies (no belongsToUserCompany filter is ever applied to inventory)');

  console.log('\n[Holdings scoping repair] WRITE-PATH SAFETY — a freshly-created Holdings quote does not "disappear" after the next read (no stale-stub gap)');
  const freshHoldingsQuote = await services.createQuote({ companyCode: '1', customerId: cust.id, customerNameRaw: 'Fresh Holdings Write Test', lines: [{ description: 'Fresh', qty: 1, unitPrice: 250 }] });
  const quotesAfterFreshWrite = await read.buildQuotesJson();
  const freshRead = quotesAfterFreshWrite.find((q: any) => q._relId === freshHoldingsQuote.id);
  ok(!!freshRead && typeof freshRead.co === 'number' && freshRead.co === 1, 'the freshly-created Holdings quote reads back with a real numeric co=1 immediately (this WAS the exact failure mode reported: correct on optimistic create, hidden on the next GET)', freshRead && freshRead.co);
  ok(belongsToUserCompany(freshRead, HOLDINGS_USER) && !belongsToUserCompany(freshRead, ORIGINAL_USER), 'the fresh Holdings quote is visible to a Holdings user and correctly hidden from an Original-company user on the very next read');

  console.log('\n[Holdings scoping repair] FOLLOW-UP CLOSED (2026-08-23 credit note company-isolation repair) — the credit-notes gap documented here is now fixed; see relational.credit-note-company-isolation-repair.stress.ts for full coverage');
  const cnHoldings = await services.createCreditNote({ companyCode: '1', type: 'customer', contactName: 'Holdings Credit Note Contact', amount: 100 });
  const creditNotesAfter = await read.buildCreditNotesJson();
  const cnRead = creditNotesAfter.find((c: any) => c._relId === cnHoldings.id);
  ok(!!cnRead && typeof cnRead.co === 'number' && cnRead.co === 1, 'a brand-new credit note now hydrates co as a real number (1) after a read-refresh — migration 011 added company_code, services.ts/index.html now thread it through, closing the gap this suite previously only documented', cnRead && cnRead.co);

  await resetRelationalTables();

  console.log('\n' + '='.repeat(60));
  console.log(`${passed} passed, ${failures} failed`);
  console.log('='.repeat(60));
  await pool.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[holdings-company-scoping-repair] Fatal error:', err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
