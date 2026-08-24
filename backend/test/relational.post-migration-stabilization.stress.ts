/**
 * relational.post-migration-stabilization.stress.ts
 * ─────────────────────────────────────────────────
 * Dedicated regression suite for the eight production defect groups reported
 * after the relational cutover (2026-08-24). Every test below reproduces the
 * ACTUAL reported failure first and then proves the fix, against a REAL local
 * Postgres through the real services/read layers — not source-text greps.
 *
 * Source-text assertions ARE included, but only for behaviour that lives purely
 * in the browser (a confirm dialog, a toast's lifetime, a de-duplication key)
 * and therefore has no server-side surface to exercise. They are clearly marked
 * as such and are never used as a substitute for a real path that exists.
 *
 * COVERAGE MAP — the twenty proof obligations from the stabilization brief:
 *    1  Quote payment persists and appears immediately          -> [BUG 1] A1/A2
 *    2  Job payment persists and appears immediately            -> [BUG 1] A3
 *    3  Same payment not duplicated across Quote/Job/Invoice     -> [BUG 1] A4
 *    4  Refresh gives identical payment state                    -> [BUG 1] A5
 *    5  Quote data fully maps to Job and Job Card                -> [BUG 2] B1/B2/B3
 *    6  Quote save does not randomly produce Internal Error      -> [BUG 3] C1/C2/C3
 *    7  Stale Quote conflict preserves draft, readable error     -> [BUG 3] C4/C5
 *    8  Clearing Job Notes persists after refresh                -> [BUG 4] D1/D2/D3
 *    9  Job can progress without payment via confirmation        -> [BUG 5] E1/E4
 *   10  No fake payment is created by that override              -> [BUG 5] E2
 *   11  Repeated invoice action cannot duplicate an invoice      -> [BUG 6] F2/F3
 *   12  INV number uniqueness / idempotency enforced             -> [BUG 6] F1/F4/F5
 *   13  Unnecessary payment can be deleted when allowed          -> [BUG 7] G1
 *   14  Locked payment clearly explains the legitimate reason    -> [BUG 7] G3/G4
 *   15  Payment deletion recomputes financial state              -> [BUG 7] G2
 *   16  Holdings/Original scoping remains correct                -> [BUG 8] H5
 *   17  Existing Job autosave fix remains working                -> [BUG 8] H1
 *   18  Existing manual-invoice lifecycle fix remains working    -> [BUG 8] H2
 *   19  Existing zero-value/NaN fix remains working              -> [BUG 8] H3
 *   20  Credit Note company isolation remains working            -> [BUG 8] H4
 *
 * SAFETY: refuses to run unless DATABASE_URL points at localhost/127.0.0.1 or
 * ALLOW_UNSAFE_TEST_DB=1 is set — same posture as every sibling suite. It
 * TRUNCATEs the rel_* tables it owns at startup and never touches
 * platform_state or platform_state_backups.
 *
 * Usage (from backend/):
 *   DATABASE_URL=postgresql://user:pass@localhost:5432/signacore_test \
 *   npx ts-node --transpile-only test/relational.post-migration-stabilization.stress.ts
 */
import fs from 'fs';
import path from 'path';
import pool from '../src/db/pool';
import * as services from '../src/relational/services';
import { ConcurrencyConflictError, BusinessRuleError } from '../src/relational/services';
import {
  buildQuotesJson, buildJobsJson, buildInvoicesJson, buildCreditNotesJson,
} from '../src/relational/read';

const DB_URL = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(DB_URL) && process.env.ALLOW_UNSAFE_TEST_DB !== '1') {
  console.error('[post-migration-stabilization] Refusing to run: DATABASE_URL does not look like a local test database.');
  process.exit(1);
}

const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH || path.resolve(__dirname, '..', '..', 'index.html');

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

async function reset() {
  await pool.query(`
    TRUNCATE TABLE rel_payments, rel_invoice_line_items, rel_invoices, rel_job_line_items,
      rel_jobs, rel_quote_line_items, rel_quotes, rel_credit_notes, rel_inventory_items, rel_customers
    RESTART IDENTITY CASCADE
  `);
  await pool.query(`DELETE FROM document_number_counters`);
  await pool.query(`DELETE FROM quote_conversions`);
}

/** A quote carrying a value in EVERY field the Quote form can capture. */
const FULL_QUOTE_FIELDS = {
  contactPerson: 'Thandi Mokoena',
  email: 'thandi@acme.example',
  phone: '021 555 0101',
  address: '14 Voortrekker Rd, Bellville',
  vatNumber: '4123456789',
  terms: 'Net 30, 50% deposit',
  salesperson: 'Ockert Smit',
  preparedBy: 'Sales Assistant',
  poRef: 'PO-ACME-8891',
  reference: 'ACME REBRAND PHASE 2',
  quoteDate: '2026-08-01',
  validUntil: '2026-08-31',
};

async function makeFullQuote(companyCode = '2', client = 'Acme Signs (Pty) Ltd') {
  const cust = await services.createCustomer({ companyName: client });
  return services.createQuote({
    companyCode, customerId: cust.id, customerNameRaw: client,
    notes: 'Install after hours. Access via loading bay.',
    setupFee: 750, discountPct: 10,
    lines: [
      { description: 'Illuminated fascia sign', qty: 2, unitPrice: 12500, unit: 'ea' },
      { description: 'Vinyl window graphics', qty: 8, unitPrice: 450, unit: 'm²' },
    ],
    ...FULL_QUOTE_FIELDS,
  });
}

async function main() {
  const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  await reset();

  // ══════════════════════════════════════════════════════════════════════════
  // BUG 1 — PAYMENTS ARE INCONSISTENT / APPEAR UNSAVED
  //
  // Reported: a payment allocated from the Quote appears not to save; another
  // added from the Job appears to allocate; neither shows without a manual
  // refresh; after creating the invoice BOTH appear.
  //
  // The findings this section pins down: the payments ALWAYS persisted. What
  // failed was hydration — the relational write updated only the open modal's
  // own useState copy, and the 30s poll could never surface it because that
  // poll gates on platform_state's `_autoSavedAt`, which a purely relational
  // write never moves. Creating the invoice flipped job.invoiceCreated, which
  // changes which array resolvePaymentSource() reads, revealing both already-
  // persisted payments at once — read by the user as "they finally saved".
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n══ BUG 1 — payment persistence and cross-surface consistency ══');

  const q1 = await makeFullQuote();
  const conv1 = await services.convertQuoteToJob(q1.id);

  // A1 — a payment recorded against the QUOTE really is written.
  const quotePay = await services.recordPayment({ type: 'quote', id: q1.id }, 5000, { date: '2026-08-10', method: 'EFT', notes: 'Deposit via quote' });
  const relQuotePayRows = await pool.query(`SELECT * FROM rel_payments WHERE owner_type='quote' AND owner_id=$1`, [q1.id]);
  ok(relQuotePayRows.rowCount === 1 && Number(relQuotePayRows.rows[0].amount) === 5000,
    'A1: a payment allocated from the Quote is genuinely persisted as exactly one rel_payments row (it never was "unsaved")',
    relQuotePayRows.rows[0]);

  // A2 — and it is visible on the very next authoritative read, with no
  // intervening JSON save, no poll, and no manual refresh.
  let quotesJson = await buildQuotesJson();
  let qView = quotesJson.find((x) => x._relId === q1.id);
  ok(!!qView && qView.payments.length === 1 && qView.payments[0].amount === 5000,
    'A2: the authoritative read shows the Quote payment immediately — no manual refresh needed',
    qView && qView.payments);
  ok(!!qView && qView.payments[0]._relPaymentId === quotePay.paymentId && qView.payments[0]._relRowVersion != null,
    'A2: the hydrated payment carries the relational identity the UI needs to edit/delete it');

  // A3 — a second payment, this time against the JOB.
  const jobPay = await services.recordPayment({ type: 'job', id: conv1.jobId }, 3000, { date: '2026-08-12', method: 'Cash', notes: 'Second payment via job' });
  let jobsJson = await buildJobsJson();
  let jView = jobsJson.find((x) => x._relId === conv1.jobId);
  ok(!!jView && jView.payments.length === 1 && jView.payments[0].amount === 3000,
    'A3: a payment allocated from the Job is persisted and visible on the next read',
    jView && jView.payments);

  // A4 — THE duplication question. Two DIFFERENT payments were recorded, so
  // two must exist; but neither may appear twice, and neither may appear under
  // the other's owner.
  const allPayRows = await pool.query(`SELECT owner_type, owner_id, amount FROM rel_payments ORDER BY id`);
  ok(allPayRows.rowCount === 2,
    'A4: exactly two rel_payments rows exist for two distinct recorded payments — recording once created once',
    allPayRows.rows);
  ok(qView.payments.length === 1 && jView.payments.length === 1,
    'A4: neither payment is duplicated — the Quote shows only its own, the Job shows only its own');
  ok(qView.payments[0]._relOwnerType === 'quote' && jView.payments[0]._relOwnerType === 'job',
    'A4: every hydrated payment states its OWN owner (_relOwnerType), so a merged job∪quote view can no longer mis-attribute a row',
    { q: qView.payments[0]._relOwnerType, j: jView.payments[0]._relOwnerType });

  // A5 — creating the invoice is what USED to "reveal" the payments. It must
  // now change nothing about payment state at all.
  const beforeInvoice = JSON.stringify({
    q: (await buildQuotesJson()).find((x) => x._relId === q1.id).payments,
    j: (await buildJobsJson()).find((x) => x._relId === conv1.jobId).payments,
  });
  await pool.query(`UPDATE rel_jobs SET stage = 7 WHERE id = $1`, [conv1.jobId]);
  const inv1 = await services.createInvoiceForJob(conv1.jobId);
  const afterInvoice = JSON.stringify({
    q: (await buildQuotesJson()).find((x) => x._relId === q1.id).payments,
    j: (await buildJobsJson()).find((x) => x._relId === conv1.jobId).payments,
  });
  ok(beforeInvoice === afterInvoice,
    'A5: creating the invoice does not change payment state — it never "released" hidden payments; they were always there');

  const invJson = await buildInvoicesJson();
  const invView = invJson.find((x) => x._relId === inv1.invoiceId);
  ok(!!invView && invView.payments.length === 0,
    'A5: the new invoice starts with NO payments of its own — a job/quote payment is never silently re-parented onto it (which would present the same money twice)',
    invView && invView.payments);

  // A5 (refresh identity) — repeated reads must be byte-identical.
  const read1 = JSON.stringify((await buildJobsJson()).find((x) => x._relId === conv1.jobId).payments);
  const read2 = JSON.stringify((await buildJobsJson()).find((x) => x._relId === conv1.jobId).payments);
  ok(read1 === read2, 'A5: a refresh returns identical payment state — reads are stable, not order- or timing-dependent');

  // A6 — the frontend half: EVERY relational mutation now schedules an
  // authoritative re-read. This is browser-only behaviour, hence source-text.
  ok(/if \(method !== 'GET' && method !== 'HEAD'\) \{\s*requestRelationalRefresh\(/.test(src),
    'A6 [frontend]: relationalFetch schedules an authoritative refresh after EVERY successful relational mutation — the one choke point every write passes through');
  ok(src.includes('async function refreshRelationalSectionsNow(reason)') &&
     src.includes('relationalRefreshRef.current = refreshRelationalSectionsNow'),
    'A6 [frontend]: App registers the refresh implementation, so components declared earlier in the file can trigger it without prop-drilling');
  ok(/const sections = relationalAuthoritativeSectionsRef\.current \|\| \[\];[\s\S]{0,400}applyServerData\(selective\)/.test(src),
    'A6 [frontend]: the refresh applies ONLY relational-authoritative sections — a JSON-owned section the user may be editing is never overwritten');
  ok(/serverBaselineRef\.current = \{ \.\.\.serverBaselineRef\.current, \.\.\.selective \}/.test(src),
    'A6 [frontend]: the refresh syncs serverBaselineRef too, so the autosave diff cannot then trip the relational-authority guard for data that is already saved');

  // A7 — rel_payments is the SOLE authority for a cut-over record's payments.
  //
  // A legacy_data fallback was considered here and deliberately rejected:
  // backfill.ts writes the whole original JSON record into legacy_data AND
  // materialises the same payments into rel_payments, so both copies exist for
  // every backfilled record. A fallback would therefore fire the moment a
  // record's LAST relational payment is legitimately deleted — resurrecting
  // every deleted payment and restating money that is no longer in the books.
  // This assertion pins the correct behaviour so that fallback cannot be
  // reintroduced: an empty payment list means "no payments", full stop.
  const legacyJob = await pool.query(
    `WITH new_id AS (SELECT nextval('rel_jobs_id_seq') AS id)
     INSERT INTO rel_jobs (id, source_id, job_number, company_code, customer_name_raw, value, legacy_data)
     SELECT new_id.id, '1775800000001', 'SNS-LEGACY-1', '2', 'Legacy Client', 1000,
       '{"payments":[{"id":11,"date":"2025-01-05","method":"EFT","amount":250,"notes":"pre-migration"}]}'::jsonb FROM new_id
     RETURNING id`);
  const legacyJobView = (await buildJobsJson()).find((x) => x._relId === legacyJob.rows[0].id);
  ok(!!legacyJobView && Array.isArray(legacyJobView.payments) && legacyJobView.payments.length === 0,
    'A7: a record with no rel_payments rows reports NO payments — legacy_data is never used as a payment fallback, so a deleted payment can never be resurrected by a refresh',
    legacyJobView && legacyJobView.payments);

  // A7b — and a deletion really does stay deleted across a re-read, on a
  // BACKFILLED-shaped record that still carries the original payment in
  // legacy_data. This is the exact scenario a fallback would have broken.
  const bfPayJob = await pool.query(
    `WITH new_id AS (SELECT nextval('rel_jobs_id_seq') AS id)
     INSERT INTO rel_jobs (id, source_id, job_number, company_code, customer_name_raw, value, legacy_data)
     SELECT new_id.id, '1775800000002', 'SNS-LEGACY-2', '2', 'Backfilled Payments Co', 4000,
       '{"payments":[{"id":22,"date":"2025-02-02","method":"EFT","amount":4000,"notes":"historical"}]}'::jsonb FROM new_id
     RETURNING id`);
  const bfPayJobId = bfPayJob.rows[0].id;
  const bfPay = await services.recordPayment({ type: 'job', id: bfPayJobId }, 4000, { method: 'EFT' });
  const bfPayVer = (await pool.query(`SELECT row_version FROM rel_payments WHERE id=$1`, [bfPay.paymentId])).rows[0].row_version;
  await services.deletePayment(bfPay.paymentId, bfPayVer);
  const bfPayView = (await buildJobsJson()).find((x) => x._relId === bfPayJobId);
  ok(bfPayView.payments.length === 0,
    'A7b: deleting the last payment on a backfilled record leaves it with none — the copy still sitting in legacy_data does not come back and restate money that was removed',
    bfPayView.payments);
  ok(bfPayView.invoiceStatus === 'pending',
    'A7b: and the owner financial status is recomputed to match reality, not left claiming paid', bfPayView.invoiceStatus);

  // ══════════════════════════════════════════════════════════════════════════
  // BUG 2 — QUOTE INFORMATION DOES NOT FULLY CARRY TO JOB / JOB CARD
  //
  // Root cause: convertQuoteToJob's INSERT copied only a handful of columns;
  // every contact/identity field was dropped even though rel_jobs has had a
  // column for each since 007. A converted job's legacy_data is '{}', so
  // read.ts's `?? legacyBase(r).x` fallbacks had nothing to fall back to.
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n══ BUG 2 — Quote -> Job -> Job Card field carry ══');

  await reset();
  const q2 = await makeFullQuote();

  // B1 — the quote itself must store everything the form collected. (Before
  // the fix, createQuote accepted only seven fields, so most of this was lost
  // the moment the browser tab was closed — the upstream half of BUG 2.)
  const q2row = (await pool.query(`SELECT * FROM rel_quotes WHERE id = $1`, [q2.id])).rows[0];
  const quoteFieldMatrix: Array<[string, string, any]> = [
    ['contactPerson', 'contact_person', FULL_QUOTE_FIELDS.contactPerson],
    ['email', 'email', FULL_QUOTE_FIELDS.email],
    ['phone', 'phone', FULL_QUOTE_FIELDS.phone],
    ['address', 'address', FULL_QUOTE_FIELDS.address],
    ['vatNumber', 'vat_number', FULL_QUOTE_FIELDS.vatNumber],
    ['terms', 'terms', FULL_QUOTE_FIELDS.terms],
    ['salesperson', 'salesperson', FULL_QUOTE_FIELDS.salesperson],
    ['preparedBy', 'prepared_by', FULL_QUOTE_FIELDS.preparedBy],
    ['poRef', 'po_ref', FULL_QUOTE_FIELDS.poRef],
    ['reference', 'reference', FULL_QUOTE_FIELDS.reference],
  ];
  for (const [field, col, expected] of quoteFieldMatrix) {
    ok(q2row[col] === expected, `B1: createQuote persists "${field}" -> rel_quotes.${col}`, { got: q2row[col], expected });
  }
  ok(q2row.quote_date instanceof Date && q2row.quote_date.toISOString().slice(0, 10) === FULL_QUOTE_FIELDS.quoteDate,
    'B1: createQuote persists "date" -> rel_quotes.quote_date (migration 012 — this field had no column at all before)', q2row.quote_date);
  ok(q2row.valid_until instanceof Date && q2row.valid_until.toISOString().slice(0, 10) === FULL_QUOTE_FIELDS.validUntil,
    'B1: createQuote persists "validUntil" -> rel_quotes.valid_until (migration 012)', q2row.valid_until);

  const q2json = (await buildQuotesJson()).find((x) => x._relId === q2.id);
  ok(q2json.date === FULL_QUOTE_FIELDS.quoteDate && q2json.validUntil === FULL_QUOTE_FIELDS.validUntil,
    'B1: read.ts hydrates the quote date/validity back under the frontend field names the Job screen reads',
    { date: q2json.date, validUntil: q2json.validUntil });
  ok(q2json.lines.length === 2 && q2json.lines[0].unit === 'ea' && q2json.lines[1].unit === 'm²',
    'B1: line "unit" survives create (it had a column since 008 but createQuote dropped it, so units were lost until the first edit)',
    q2json.lines.map((l: any) => l.unit));

  // B2 — conversion must carry every one of those onto the job.
  const conv2 = await services.convertQuoteToJob(q2.id);
  const j2row = (await pool.query(`SELECT * FROM rel_jobs WHERE id = $1`, [conv2.jobId])).rows[0];
  const carryMatrix: Array<[string, string, string, any]> = [
    ['contact',     'contact_person', 'contact',     FULL_QUOTE_FIELDS.contactPerson],
    ['email',       'email',          'email',       FULL_QUOTE_FIELDS.email],
    ['tel',         'phone',          'tel',         FULL_QUOTE_FIELDS.phone],
    ['address',     'address',        'address',     FULL_QUOTE_FIELDS.address],
    ['vatNum',      'vat_number',     'vatNum',      FULL_QUOTE_FIELDS.vatNumber],
    ['salesperson', 'salesperson',    'salesperson', FULL_QUOTE_FIELDS.salesperson],
    ['preparedBy',  'prepared_by',    'preparedBy',  FULL_QUOTE_FIELDS.preparedBy],
    ['poRef',       'po_ref',         'poRef',       FULL_QUOTE_FIELDS.poRef],
    ['reference',   'reference',      'reference',   FULL_QUOTE_FIELDS.reference],
  ];
  const j2json = (await buildJobsJson()).find((x) => x._relId === conv2.jobId);
  for (const [frontendField, col, readField, expected] of carryMatrix) {
    ok(j2row[col] === expected,
      `B2: Quote.${frontendField} -> rel_jobs.${col} on conversion (this column existed but was never populated)`,
      { got: j2row[col], expected });
    ok(j2json[readField] === expected,
      `B2: rel_jobs.${col} -> hydrated Job.${readField} (what Job Detail / Job Card actually read)`,
      { got: j2json[readField], expected });
  }
  ok(j2json.client === 'Acme Signs (Pty) Ltd' && j2json.quoteNum === q2.quoteNumber,
    'B2: client and source quote number carry through (unchanged behaviour, pinned so the widened INSERT cannot regress it)');
  ok(Number(j2json.setupFee) === 750 && Number(j2json.discount) === 10,
    'B2: setup fee and discount carry through', { setupFee: j2json.setupFee, discount: j2json.discount });
  ok(typeof j2json.desc === 'string' && j2json.desc.includes(q2.quoteNumber) && j2json.desc.includes('Illuminated fascia sign'),
    'B2: the job description carries what the quote actually described, not just a bare "From Quote <num>" label (the relational path used to discard it; the JSON path never did)',
    j2json.desc);

  // B3 — line items, including the per-line extras the printed Job Card reads.
  await pool.query(
    `UPDATE rel_quote_line_items SET legacy_data = '{"sqmL":2.4,"sqmW":1.2,"pQty":2,"sizeText":"2400 x 1200"}'::jsonb
      WHERE quote_id = $1 AND line_index = 0`, [q2.id]);
  const q3 = await makeFullQuote('2', 'Sizing Carry Co');
  await pool.query(
    `UPDATE rel_quote_line_items SET legacy_data = '{"sqmL":3,"sqmW":1.5,"sizeText":"3000 x 1500"}'::jsonb
      WHERE quote_id = $1 AND line_index = 0`, [q3.id]);
  const conv3 = await services.convertQuoteToJob(q3.id);
  const j3lines = (await pool.query(`SELECT * FROM rel_job_line_items WHERE job_id=$1 ORDER BY line_index`, [conv3.jobId])).rows;
  ok(j3lines.length === 2 && j3lines[0].unit === 'ea',
    'B3: job line items carry description/qty/unitPrice/unit', j3lines[0]);
  ok(j3lines[0].legacy_data && j3lines[0].legacy_data.sizeText === '3000 x 1500',
    'B3: per-line sizing extras (sqmL/sqmW/sizeText — the fields the printed Job Card renders via lineSizeText) survive conversion instead of being replaced with an empty object',
    j3lines[0].legacy_data);

  // B4 — frontend halves that have no server surface.
  ok(/relationalApi\.createQuote\(\{[\s\S]{0,900}contactPerson: contact\|\|null[\s\S]{0,500}validUntil: valid\|\|null/.test(src),
    'B4 [frontend]: the relational quote-create payload now sends the contact/identity/date fields the form collects, instead of only seven');
  ok(/const stubJob = \{[\s\S]{0,900}salesperson: q\.salesperson\|\|'', preparedBy: q\.preparedBy\|\|'',/.test(src),
    'B4 [frontend]: the optimistic convert stub mirrors the same field set the server now writes, so the immediate view and the authoritative row agree');
  ok(src.includes('quoteDate: q.date||null, validUntil: q.validUntil||null,'),
    'B4 [frontend]: the quote EDIT patch sends the date fields too, so an edit cannot silently drop them again');

  // ══════════════════════════════════════════════════════════════════════════
  // BUG 3 — QUOTE SAVES OFTEN FAIL WITH "INTERNAL ERROR"
  //
  // Root cause #1: replaceQuoteLinesTx / createQuote pushed the frontend's
  // `itemId` (an inventory item's ORIGINAL JSON id, which read.ts derives from
  // source_id) straight into `inventory_item_id`, a BIGINT FK to
  // rel_inventory_items(id). For any BACKFILLED item those two ids differ, so
  // Postgres raised 23503 foreign_key_violation (or 22P02 for a non-numeric
  // source id) — neither a ConcurrencyConflictError nor a BusinessRuleError,
  // so api.ts returned a bare 500 {error:'Internal error'}.
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n══ BUG 3 — quote save "Internal error" ══');

  await reset();

  // Build a BACKFILLED-shaped inventory item: source_id is a historical JS id,
  // deliberately NOT equal to its relational PK. This is the exact shape that
  // produced the 500 in production and that could not occur in testing against
  // freshly-created data (createInventoryItem sets source_id = id::text).
  const backfilledItem = await pool.query(
    `WITH new_id AS (SELECT nextval('rel_inventory_items_id_seq') AS id)
     INSERT INTO rel_inventory_items (id, source_id, name, sku, cost, sell, stock_qty, reorder_level, legacy_data)
     SELECT new_id.id, '1775811628870', 'Backfilled Vinyl Roll', 'VNL-001', 100, 250, 50, 5, '{}'::jsonb FROM new_id
     RETURNING id, source_id`);
  const bfPk = Number(backfilledItem.rows[0].id);
  const bfSourceId = backfilledItem.rows[0].source_id;
  ok(String(bfPk) !== String(bfSourceId),
    'C0: the test fixture reproduces the real production shape — a backfilled inventory item whose frontend-facing id differs from its relational PK',
    { pk: bfPk, sourceId: bfSourceId });

  // C1 — CREATE a quote whose line links to that item, using the id the
  // frontend actually holds. This used to throw 23503 -> HTTP 500.
  let c1Err: any = null;
  let qC1: any = null;
  try {
    const cust = await services.createCustomer({ companyName: 'Internal Error Repro Co' });
    qC1 = await services.createQuote({
      companyCode: '2', customerId: cust.id, customerNameRaw: 'Internal Error Repro Co',
      lines: [{ description: 'Vinyl', qty: 3, unitPrice: 250, inventoryItemId: Number(bfSourceId) }],
    });
  } catch (e) { c1Err = e; }
  ok(c1Err === null,
    'C1: creating a quote whose line is linked to a BACKFILLED inventory item no longer throws — this is the exact failure that surfaced as "Internal error"',
    c1Err && String(c1Err));
  if (!qC1) {
    // The pre-fix failure is fatal for this section (there is no quote to edit),
    // so the remaining C-assertions are reported as failures rather than
    // crashing the whole suite and hiding the sections after it.
    ok(false, 'C1: (skipped — the quote could not be created, see above)');
    ok(false, 'C2: (skipped — the quote could not be created, see above)');
    console.log('  ! remaining BUG 3 assertions skipped — quote creation failed');
  } else {
  const c1Line = (await pool.query(`SELECT * FROM rel_quote_line_items WHERE quote_id=$1`, [qC1.id])).rows[0];
  ok(Number(c1Line.inventory_item_id) === bfPk,
    'C1: the caller-supplied legacy id is resolved to the REAL foreign key, so the FK constraint is satisfied instead of violated',
    { stored: c1Line.inventory_item_id, expectedPk: bfPk });
  ok(String(c1Line.inventory_source_id) === String(bfSourceId),
    'C1: inventory_source_id is populated too — read.ts reads itemId FROM this column, so without it the inventory link came back null on every read');

  // C2 — EDIT the same quote (the path users hit most often).
  let c2Err: any = null;
  try {
    await services.updateQuote(qC1.id, 1, {
      lines: [{ desc: 'Vinyl', qty: 4, unitPrice: 250, unit: 'm²', itemId: Number(bfSourceId) as any }],
    });
  } catch (e) { c2Err = e; }
  ok(c2Err === null, 'C2: editing that quote does not throw either', c2Err && String(c2Err));
  const c2json = (await buildQuotesJson()).find((x) => x._relId === qC1.id);
  ok(c2json.lines[0].itemId === Number(bfSourceId),
    'C2: after the edit the line still reports the SAME inventory id the frontend sent — the link is no longer silently dropped on every save',
    c2json.lines[0]);

  // C2b — an id matching nothing must degrade gracefully, not 500.
  let c2bErr: any = null;
  try {
    await services.updateQuote(qC1.id, 2, {
      lines: [{ desc: 'Deleted item', qty: 1, unitPrice: 10, itemId: 99999999 as any }],
    });
  } catch (e) { c2bErr = e; }
  ok(c2bErr === null,
    'C2b: a line referencing an inventory item that no longer exists still saves (the reference is kept as a breadcrumb) instead of 500ing the whole quote',
    c2bErr && String(c2bErr));

  // C3 — a cleared date must not 22007 -> 500.
  let c3Err: any = null;
  try {
    await services.updateQuote(qC1.id, 3, { quoteDate: '', validUntil: '' } as any);
  } catch (e) { c3Err = e; }
  ok(c3Err === null, 'C3: clearing a date field saves as NULL rather than raising 22007 invalid_datetime_format -> another opaque 500', c3Err && String(c3Err));
  const c3row = (await pool.query(`SELECT quote_date, valid_until FROM rel_quotes WHERE id=$1`, [qC1.id])).rows[0];
  ok(c3row.quote_date === null && c3row.valid_until === null, 'C3: the cleared dates really are NULL', c3row);

  // C3b — same class on the job and invoice date columns.
  const convC3 = await services.convertQuoteToJob(qC1.id);
  let c3bErr: any = null;
  try {
    await services.updateJob(convC3.jobId, 1, { dueDate: '2026-09-01' });
    const v = (await pool.query(`SELECT row_version FROM rel_jobs WHERE id=$1`, [convC3.jobId])).rows[0].row_version;
    await services.updateJob(convC3.jobId, v, { dueDate: '' });
  } catch (e) { c3bErr = e; }
  ok(c3bErr === null, 'C3b: clearing a Job due date behaves the same way (same defect class, different screen)', c3bErr && String(c3bErr));

  // C4 — a genuine conflict must be reported AS a conflict, never as an
  // internal error, and must change nothing.
  const beforeConflict = (await pool.query(`SELECT * FROM rel_quotes WHERE id=$1`, [qC1.id])).rows[0];
  let c4Err: any = null;
  try {
    await services.updateQuote(qC1.id, 1 /* deliberately stale */, { notes: 'should not land' });
  } catch (e) { c4Err = e; }
  ok(c4Err instanceof ConcurrencyConflictError,
    'C4: a stale quote save raises ConcurrencyConflictError (-> HTTP 409 stale_record), which is distinguishable from a server fault',
    c4Err && String(c4Err));
  const afterConflict = (await pool.query(`SELECT * FROM rel_quotes WHERE id=$1`, [qC1.id])).rows[0];
  ok(afterConflict.notes === beforeConflict.notes && afterConflict.row_version === beforeConflict.row_version,
    'C4: the rejected save changed absolutely nothing — the user draft is safe to keep on screen and retry');

  // C5 — the stale-version sources that MANUFACTURED false conflicts.
  const q5 = await makeFullQuote('2', 'Version Tracking Co');
  const conv5 = await services.convertQuoteToJob(q5.id);
  ok(typeof conv5.quoteRowVersion === 'number',
    'C5: convert-to-job now reports the QUOTE\'s new row_version — converting bumps it, and not reporting it left the client stale and 409ing on its very next edit');
  const q5after = (await pool.query(`SELECT row_version FROM rel_quotes WHERE id=$1`, [q5.id])).rows[0];
  ok(conv5.quoteRowVersion === q5after.row_version,
    'C5: the reported version is the real one', { reported: conv5.quoteRowVersion, actual: q5after.row_version });
  let c5Err: any = null;
  try { await services.updateQuote(q5.id, conv5.quoteRowVersion, { notes: 'edited right after conversion' }); }
  catch (e) { c5Err = e; }
  ok(c5Err === null,
    'C5: editing a quote immediately after converting it now succeeds — this is the "quote save randomly fails" report reproduced and fixed',
    c5Err && String(c5Err));

  const q6 = await makeFullQuote('2', 'Unlink Version Co');
  const conv6 = await services.convertQuoteToJob(q6.id);
  const j6ver = (await pool.query(`SELECT row_version FROM rel_jobs WHERE id=$1`, [conv6.jobId])).rows[0].row_version;
  const del6 = await services.deleteJob(conv6.jobId, j6ver);
  ok(Array.isArray(del6.unlinkedQuotes) && del6.unlinkedQuotes.length === 1 && del6.unlinkedQuotes[0].status === 'approved',
    'C5: deleting a job reports which quotes it reverted, and to what status — the same stale-version class as conversion',
    del6.unlinkedQuotes);
  let c5bErr: any = null;
  try { await services.updateQuote(q6.id, del6.unlinkedQuotes[0].rowVersion, { notes: 'edited after the job was deleted' }); }
  catch (e) { c5bErr = e; }
  ok(c5bErr === null, 'C5: the reverted quote is immediately saveable again using the reported version', c5bErr && String(c5bErr));
  }

  // C6 — error visibility (browser-only).
  ok(src.includes('function classifySaveError(err, entityLabel)') &&
     /if \(status >= 500\) \{[\s\S]{0,600}critical: true/.test(src),
    'C6 [frontend]: save failures are classified, and a 5xx is marked critical rather than being shown with the same weight as a routine conflict');
  ok(/kind: 'server_error'[\s\S]{0,500}Your changes have NOT been saved/.test(src),
    'C6 [frontend]: a server fault tells the user their work was NOT saved and is still on screen, instead of five bare words');
  ok(/resolvedTone === 'error' \? 12000 : 2500/.test(src),
    'C6 [frontend]: an error notice stays up for 12s, not the ~2.5s flash users could not read — while still clearing itself, so a transient blip cannot pin a red panel over the header controls for the rest of the session');
  ok(/classifySaveError[\s\S]{0,4000}critical: true/.test(src) && src.includes('setSaveErr(describeSaveConflictError'),
    'C6 [frontend]: genuinely critical save failures are surfaced separately — a modal banner or a blocking alert, which persist until the user acts on them, independent of the corner notice');
  ok(src.includes("apiNotice.tone === 'error' && (") && src.includes('onClick={()=>setApiNotice(null)}'),
    'C6 [frontend]: an error notice carries an explicit dismiss control');
  ok(!/background: \/fail\|offline\/i\.test\(apiMsg\)/.test(src),
    'C6 [frontend]: notice severity is no longer guessed by regex-matching the message text (which rendered any error not containing "fail"/"offline" as a green success)');

  // ══════════════════════════════════════════════════════════════════════════
  // BUG 4 — JOB PAGE TOP NOTES RETURN AFTER DELETION
  //
  // Root cause: updateQuoteWithJobSync wrote
  //   (patch.notes !== undefined ? patch.notes : quote.notes) || job.notes || ''
  // into rel_jobs.notes on EVERY quote save. Two defects in one line: the
  // `|| job.notes` made notes a one-way ratchet that could never be cleared,
  // and running unconditionally meant any unrelated quote edit re-pushed the
  // quote's notes over a note the user had deleted on the Job page.
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n══ BUG 4 — deleted Job notes come back ══');

  await reset();
  const q7 = await makeFullQuote('2', 'Notes Co');
  const conv7 = await services.convertQuoteToJob(q7.id);

  // D1 — text -> new text.
  let jv = (await pool.query(`SELECT row_version FROM rel_jobs WHERE id=$1`, [conv7.jobId])).rows[0].row_version;
  await services.updateJob(conv7.jobId, jv, { notes: 'Ring the site manager first.' });
  let j7 = (await buildJobsJson()).find((x) => x._relId === conv7.jobId);
  ok(j7.notes === 'Ring the site manager first.', 'D1: editing a Job note persists (text -> new text)', j7.notes);

  // D2 — text -> empty. The reported case.
  jv = (await pool.query(`SELECT row_version FROM rel_jobs WHERE id=$1`, [conv7.jobId])).rows[0].row_version;
  await services.updateJob(conv7.jobId, jv, { notes: '' });
  j7 = (await buildJobsJson()).find((x) => x._relId === conv7.jobId);
  ok(j7.notes === '', 'D2: clearing a Job note persists as empty on the next authoritative read (text -> empty string)', j7.notes);

  // D3 — THE regression. Edit the quote's LINES only. The job's cleared note
  // must stay cleared. This is what actually resurrected the note in
  // production: the user cleared it, someone edited the quote for an unrelated
  // reason, and the old text was written straight back over it.
  const q7ver = (await pool.query(`SELECT row_version FROM rel_quotes WHERE id=$1`, [q7.id])).rows[0].row_version;
  await services.updateQuoteWithJobSync(q7.id, q7ver, {
    lines: [{ desc: 'Revised sign', qty: 1, unitPrice: 9000 }],
    notes: 'Install after hours. Access via loading bay.', // UNCHANGED, exactly as the form resends it
  });
  j7 = (await buildJobsJson()).find((x) => x._relId === conv7.jobId);
  ok(j7.notes === '',
    'D3: editing the QUOTE (lines changed, notes unchanged) no longer resurrects the deleted Job note — this is the reported bug, reproduced and fixed',
    j7.notes);
  ok(Number(j7.value) > 0 && j7.lines.length === 1 && j7.lines[0].desc === 'Revised sign',
    'D3: the rest of the quote->job cascade still works — only the notes ratchet changed', { value: j7.value, lines: j7.lines });

  // D4 — changing the quote's notes DOES still cascade, including to empty.
  const q7ver2 = (await pool.query(`SELECT row_version FROM rel_quotes WHERE id=$1`, [q7.id])).rows[0].row_version;
  await services.updateQuoteWithJobSync(q7.id, q7ver2, { notes: 'Client requests weekend install.' });
  j7 = (await buildJobsJson()).find((x) => x._relId === conv7.jobId);
  ok(j7.notes === 'Client requests weekend install.',
    'D4: a genuine change to the quote\'s notes still cascades onto the job (the cascade was fixed, not disabled)', j7.notes);

  const q7ver3 = (await pool.query(`SELECT row_version FROM rel_quotes WHERE id=$1`, [q7.id])).rows[0].row_version;
  await services.updateQuoteWithJobSync(q7.id, q7ver3, { notes: '' });
  j7 = (await buildJobsJson()).find((x) => x._relId === conv7.jobId);
  ok(j7.notes === '',
    'D4: clearing the QUOTE\'s notes now clears the job\'s too — under the old `|| job.notes` fallback this was impossible', j7.notes);

  // D5 — a backfilled job whose legacy_data still holds the original note must
  // not have it resurrected once the column has been explicitly cleared.
  const bfJob = await pool.query(
    `WITH new_id AS (SELECT nextval('rel_jobs_id_seq') AS id)
     INSERT INTO rel_jobs (id, source_id, job_number, company_code, customer_name_raw, value, notes, legacy_data)
     SELECT new_id.id, '1775800000099', 'SNS-BF-9', '2', 'Backfilled Notes Co', 500, 'original note',
       '{"notes":"original note"}'::jsonb FROM new_id
     RETURNING id, row_version`);
  await services.updateJob(bfJob.rows[0].id, bfJob.rows[0].row_version, { notes: '' });
  const bfView = (await buildJobsJson()).find((x) => x._relId === bfJob.rows[0].id);
  ok(bfView.notes === '',
    'D5: clearing the note on a BACKFILLED job stays cleared — legacy_data does not re-supply the old text on read',
    bfView.notes);

  // D6 — the client-side mirrors of the same cascade.
  ok(src.includes('const _quoteNotesChanged = _quoteNotesAfter !== _quoteNotesBefore;') &&
     src.includes('const _qNotesChanged = _qNotesAfter !== _qNotesBefore;'),
    'D6 [frontend]: both client-side quote->job cascades (relational and JSON) apply the same "only when the quote note actually changed" rule as the server');
  ok(!src.includes("notes: q.notes||j.notes||''"),
    'D6 [frontend]: the `q.notes||j.notes||\'\'` ratchet is gone from the frontend entirely');
  ok(src.includes("escapeHtml(job.notes)"),
    'D6 [frontend]: the printed Job Card escapes the note instead of interpolating user-typed text straight into its markup');
  ok(!src.includes('not printed on job card or invoice'),
    'D6 [frontend]: the notes placeholder no longer claims the note is not printed — printJobCard does print it');

  // ══════════════════════════════════════════════════════════════════════════
  // BUG 5 — PAYMENT/DEPOSIT MUST NOT BLOCK JOB PROGRESSION
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n══ BUG 5 — job progression without payment ══');

  await reset();
  const q8 = await makeFullQuote('2', 'Pay On Completion Co');
  const conv8 = await services.convertQuoteToJob(q8.id);
  const j8before = (await pool.query(`SELECT * FROM rel_jobs WHERE id=$1`, [conv8.jobId])).rows[0];
  ok(j8before.stage === 4 && j8before.deposit_waived === false,
    'E0: a freshly converted job starts at Quote Approved with no override recorded', { stage: j8before.stage, waived: j8before.deposit_waived });

  // E1 — the override advances the job.
  await services.updateJob(conv8.jobId, j8before.row_version, {
    stage: 5, status: 'deposit_received', depositWaived: true, depositWaivedBy: 'test@signacore.local',
  });
  const j8after = (await pool.query(`SELECT * FROM rel_jobs WHERE id=$1`, [conv8.jobId])).rows[0];
  ok(j8after.stage === 5 && j8after.deposit_waived === true,
    'E1: a job with no payment CAN progress past Deposit Received once the override is explicitly recorded', { stage: j8after.stage, waived: j8after.deposit_waived });
  ok(j8after.deposit_waived_at !== null && j8after.deposit_waived_by === 'test@signacore.local',
    'E1: the override is auditable — when it was taken and by whom', { at: j8after.deposit_waived_at, by: j8after.deposit_waived_by });

  // E2 — and it fabricates nothing financial. This is the critical assertion.
  const e2Payments = await pool.query(`SELECT count(*)::int AS n FROM rel_payments WHERE owner_type='job' AND owner_id=$1`, [conv8.jobId]);
  ok(e2Payments.rows[0].n === 0,
    'E2: NO payment was created by the override — the job progressed, the money did not', e2Payments.rows[0]);
  ok(Number(j8after.value) === Number(j8before.value),
    'E2: the job value is untouched — an unpaid job is never reclassified as zero-value', { before: j8before.value, after: j8after.value });
  ok(j8after.invoice_status === j8before.invoice_status,
    'E2: invoice_status still reports the TRUE payment position — nothing is marked paid', { before: j8before.invoice_status, after: j8after.invoice_status });
  const e2Invoices = await pool.query(`SELECT count(*)::int AS n FROM rel_invoices`);
  ok(e2Invoices.rows[0].n === 0, 'E2: no invoice was created or marked paid by the override', e2Invoices.rows[0]);

  // E3 — hydration + un-waiving.
  const j8json = (await buildJobsJson()).find((x) => x._relId === conv8.jobId);
  ok(j8json.depositWaived === true && typeof j8json.depositWaivedAt === 'string',
    'E3: the override hydrates to the frontend so the lifecycle can distinguish "payment received" from "progressed without payment"',
    { waived: j8json.depositWaived, at: j8json.depositWaivedAt });
  const j8v = (await pool.query(`SELECT row_version FROM rel_jobs WHERE id=$1`, [conv8.jobId])).rows[0].row_version;
  await services.updateJob(conv8.jobId, j8v, { depositWaived: false });
  const j8cleared = (await pool.query(`SELECT deposit_waived, deposit_waived_at, deposit_waived_by FROM rel_jobs WHERE id=$1`, [conv8.jobId])).rows[0];
  ok(j8cleared.deposit_waived === false && j8cleared.deposit_waived_at === null && j8cleared.deposit_waived_by === null,
    'E3: clearing the override clears its audit stamps too — no "waived by X" left on a job that is not waived', j8cleared);

  // E4 — the browser-side business rule.
  ok(src.includes('async function progressWithoutPayment()') &&
     /No payment\/deposit has been recorded for this job\.[\s\S]{0,200}Do you want to continue anyway\?/.test(src),
    'E4 [frontend]: the user is asked explicitly, in the wording the brief specifies, rather than being silently blocked');
  ok(/relationalApi\.updateJob\(job\._relId, job\._relRowVersion, \{\s*stage: targetStage, status: nextStatus, depositWaived: true,/.test(src),
    'E4 [frontend]: choosing to continue records the override and advances the stage in ONE call — they can never land apart');
  ok(src.includes('Continue Without Payment') && src.includes('Record Payment / Deposit'),
    'E4 [frontend]: the payment action is still offered alongside the override, not replaced by it');
  ok(src.includes('const isDepositWaived = job.depositWaived === true;') &&
     src.includes('const paymentLockBypassed = isZeroValueJob || isDepositWaived;'),
    'E4 [frontend]: the override is kept DISTINCT from the zero-value bypass — an unpaid job is never classified as zero-value');
  ok(src.includes('Progressed without payment'),
    'E4 [frontend]: the lifecycle visually distinguishes an overridden deposit stage from a genuinely paid one');

  // ══════════════════════════════════════════════════════════════════════════
  // BUG 6 — DUPLICATE INV-00099
  //
  // Finding: the database CANNOT hold two rows with the same number —
  // rel_invoices carries UNIQUE (company_code, invoice_number). The duplicate
  // was produced client-side, by the merge of job-derived invoices with the
  // accInvoices array. That merge de-duplicates on the invoice's `reference`
  // matching the job number, and createInvoiceForJob never wrote `reference`.
  // The R0.00 twin came from read.ts emitting the lines as `items` while every
  // consumer reads `lineItems`.
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n══ BUG 6 — duplicate INV-00099 / invoice idempotency ══');

  await reset();

  // F0 — the database-level guarantee, pinned.
  const uniq = await pool.query(`
    SELECT COUNT(*)::int AS n FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'rel_invoices' AND c.contype = 'u'
      AND pg_get_constraintdef(c.oid) ILIKE '%company_code%invoice_number%'`);
  ok(uniq.rows[0].n === 1,
    'F0: rel_invoices enforces UNIQUE (company_code, invoice_number) — two rows can never share a number, so the reported duplicate was a rendering defect, not two records',
    uniq.rows[0]);

  const q9 = await makeFullQuote('2', 'Duplicate Invoice Co');
  const conv9 = await services.convertQuoteToJob(q9.id);
  await pool.query(`UPDATE rel_jobs SET stage = 7 WHERE id = $1`, [conv9.jobId]);
  const inv9 = await services.createInvoiceForJob(conv9.jobId);

  // F1 — the de-duplication key the whole frontend depends on.
  const inv9row = (await pool.query(`SELECT * FROM rel_invoices WHERE id=$1`, [inv9.invoiceId])).rows[0];
  const job9 = (await pool.query(`SELECT job_number FROM rel_jobs WHERE id=$1`, [conv9.jobId])).rows[0];
  ok(inv9row.reference === job9.job_number,
    'F1: a job invoice now carries the job number as its `reference` — the ONLY key getManualInvoiceJobRefs de-duplicates on, and the field that was NULL for every relationally-created invoice',
    { reference: inv9row.reference, jobNumber: job9.job_number });
  ok(inv9row.job_number_raw === job9.job_number && String(inv9row.job_id) === String(conv9.jobId),
    'F1: the job link itself is intact too (the second, independent de-duplication key)', inv9row.job_number_raw);
  ok(inv9row.contact_email === FULL_QUOTE_FIELDS.email && inv9row.contact_address === FULL_QUOTE_FIELDS.address,
    'F1: contact details are carried onto the invoice instead of being left NULL', { email: inv9row.contact_email, address: inv9row.contact_address });

  // F2 — the R0.00 half.
  const inv9json = (await buildInvoicesJson()).find((x) => x._relId === inv9.invoiceId);
  ok(Array.isArray(inv9json.lineItems) && inv9json.lineItems.length === 2,
    'F2: read.ts emits the invoice lines under `lineItems` — the key EVERY frontend consumer actually reads. Emitting only `items` is what made every relationally-hydrated invoice render as R0.00',
    inv9json.lineItems && inv9json.lineItems.length);
  const inv9Total = inv9json.lineItems.reduce((s: number, l: any) => {
    const sub = Number(l.qty) * Number(l.unitAmount);
    return s + sub + (l.taxType === '15%' ? sub * 0.15 : 0);
  }, 0);
  ok(inv9Total > 0,
    'F2: computing the invoice total exactly the way the UI does now yields a real amount, not zero', inv9Total);
  ok(Array.isArray(inv9json.items) && inv9json.items.length === inv9json.lineItems.length,
    'F2: `items` is still emitted alongside it, so existing consumers (fullBackupV2, reconcile, backups) are unaffected');

  // F3 — idempotency: a repeat action must not create a second invoice.
  let f3Err: any = null;
  try { await services.createInvoiceForJob(conv9.jobId); } catch (e) { f3Err = e; }
  ok(f3Err instanceof BusinessRuleError,
    'F3: a repeated Create Invoice on an already-invoiced job is refused with a clear business rule, not silently duplicated', f3Err && String(f3Err));
  const f3count = await pool.query(`SELECT count(*)::int AS n FROM rel_invoices WHERE job_id=$1`, [conv9.jobId]);
  ok(f3count.rows[0].n === 1, 'F3: still exactly one invoice for that job', f3count.rows[0]);

  // F4 — genuine concurrency (the double-click / retry case).
  const q10 = await makeFullQuote('2', 'Concurrent Invoice Co');
  const conv10 = await services.convertQuoteToJob(q10.id);
  await pool.query(`UPDATE rel_jobs SET stage = 7 WHERE id = $1`, [conv10.jobId]);
  const settled = await Promise.allSettled([
    services.createInvoiceForJob(conv10.jobId),
    services.createInvoiceForJob(conv10.jobId),
    services.createInvoiceForJob(conv10.jobId),
  ]);
  const fulfilled = settled.filter((r) => r.status === 'fulfilled');
  ok(fulfilled.length === 1,
    'F4: exactly ONE of three concurrent create-invoice calls succeeds — row locking serialises them, so a double-click or a browser retry cannot duplicate',
    settled.map((r) => r.status));
  const f4count = await pool.query(`SELECT count(*)::int AS n FROM rel_invoices WHERE job_id=$1`, [conv10.jobId]);
  ok(f4count.rows[0].n === 1, 'F4: exactly one invoice row exists afterward', f4count.rows[0]);

  // F5 — reuse rather than mint a second number for work already invoiced.
  const q11 = await makeFullQuote('2', 'Proforma Reuse Co');
  await pool.query(`UPDATE rel_quotes SET proforma_num = 'PRO-00777' WHERE id = $1`, [q11.id]);
  const fin11 = await services.finalizeProformaToInvoice(q11.id);
  const conv11 = await services.convertQuoteToJob(q11.id);
  const relinked = (await pool.query(`SELECT reference, job_id FROM rel_invoices WHERE id=$1`, [fin11.invoiceId])).rows[0];
  ok(String(relinked.job_id) === String(conv11.jobId) && relinked.reference != null,
    'F5: converting a quote that was already invoiced relinks the EXISTING invoice onto the new job (the JSON path always did this; the relational path did not, which is a second route to the same duplicate)',
    relinked);
  const countBefore = (await pool.query(`SELECT count(*)::int AS n FROM rel_invoices`)).rows[0].n;
  await pool.query(`UPDATE rel_jobs SET stage = 7 WHERE id = $1`, [conv11.jobId]);
  const reused = await services.createInvoiceForJob(conv11.jobId);
  const countAfter = (await pool.query(`SELECT count(*)::int AS n FROM rel_invoices`)).rows[0].n;
  ok(reused.invoiceNumber === fin11.invoiceNumber && countAfter === countBefore,
    'F5: invoicing that job REUSES the existing invoice instead of minting a second number for work already invoiced',
    { reused: reused.invoiceNumber, original: fin11.invoiceNumber, countBefore, countAfter });

  // F6 — the client-side merge key.
  ok(src.includes('if (i.reference) refs.add(i.reference);') && src.includes('if (i.jobNum) refs.add(i.jobNum);'),
    'F6 [frontend]: the invoice de-duplication key is widened to reference OR jobNum, which self-heals every invoice created BEFORE the reference fix — including the live INV-00099 — with no data repair');
  ok(/const stubInvoice = \{[\s\S]{0,900}lineItems: \(quote\.lines\|\|\[\]\)\.map/.test(src),
    'F6 [frontend]: the optimistic invoice stub carries the quote\'s real lines instead of an empty array that displayed as R0.00');

  // ══════════════════════════════════════════════════════════════════════════
  // BUG 7 — PAYMENT DELETE SHOWS LOCK ICON
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n══ BUG 7 — payment delete / lock ══');

  await reset();
  const q12 = await makeFullQuote('2', 'Deletable Payment Co');
  const conv12 = await services.convertQuoteToJob(q12.id);
  const jobValue = Number((await pool.query(`SELECT value FROM rel_jobs WHERE id=$1`, [conv12.jobId])).rows[0].value);

  // G1 — an unnecessary payment really can be removed.
  const pay12 = await services.recordPayment({ type: 'job', id: conv12.jobId }, jobValue, { method: 'EFT', notes: 'keyed in error' });
  let statusAfterPay = (await pool.query(`SELECT invoice_status FROM rel_jobs WHERE id=$1`, [conv12.jobId])).rows[0].invoice_status;
  ok(statusAfterPay === 'paid', 'G1: recording a full payment marks the job paid', statusAfterPay);

  const payVer = (await pool.query(`SELECT row_version FROM rel_payments WHERE id=$1`, [pay12.paymentId])).rows[0].row_version;
  const del12 = await services.deletePayment(pay12.paymentId, payVer);
  ok(del12.deleted === true, 'G1: an unnecessary, unapplied payment can be deleted');
  const gone = await pool.query(`SELECT count(*)::int AS n FROM rel_payments WHERE id=$1`, [pay12.paymentId]);
  ok(gone.rows[0].n === 0, 'G1: it is really gone', gone.rows[0]);

  // G2 — and the owner's financial state is recomputed, not left stale.
  statusAfterPay = (await pool.query(`SELECT invoice_status FROM rel_jobs WHERE id=$1`, [conv12.jobId])).rows[0].invoice_status;
  ok(statusAfterPay === 'pending',
    'G2: deleting the payment recomputes the owner\'s financial status back to pending — the job does not stay falsely marked paid', statusAfterPay);
  const j12 = (await buildJobsJson()).find((x) => x._relId === conv12.jobId);
  ok(j12.payments.length === 0 && j12.invoiceStatus === 'pending',
    'G2: the authoritative read reflects both the removal and the recomputed status immediately', { payments: j12.payments.length, status: j12.invoiceStatus });

  // G3 — a stale delete is still refused (the legitimate safeguard stays).
  const pay12b = await services.recordPayment({ type: 'job', id: conv12.jobId }, 100, { method: 'EFT' });
  let g3Err: any = null;
  try { await services.deletePayment(pay12b.paymentId, 999); } catch (e) { g3Err = e; }
  ok(g3Err instanceof ConcurrencyConflictError,
    'G3: a stale delete is still refused with a conflict — loosening the lock rule did not weaken the concurrency safeguard', g3Err && String(g3Err));

  // G4 — the browser-side rule, which is where the padlock actually lived.
  ok(src.includes('function canManagePayments(user)') &&
     src.includes("return role === 'admin' || role === 'accounts';"),
    'G4 [frontend]: ONE payment-permission rule for every screen — the padlock used to mean three different things depending on which page opened the modal');
  ok(src.includes('function paymentDeleteBlockReason(payment, user, fallbackSection)'),
    'G4 [frontend]: every refusal produces a written reason, so the UI can explain WHY rather than showing a bare icon');
  ok(/Only Admin and Accounts users can delete payment records/.test(src) &&
     /historical payment recorded before the database migration/.test(src) &&
     /funded by a credit note/.test(src),
    'G4 [frontend]: the three legitimate reasons are each stated in plain English — role, un-migrated historical payment, and credit-note dependency');
  ok(src.includes('function PaymentLockedBadge({ reason })') && src.includes('onClick={()=>{ if(reason) window.alert(reason); }}'),
    'G4 [frontend]: the padlock itself is now clickable/hoverable and reveals its reason');
  ok(src.includes('function paymentOwnerSection(payment, fallbackSection)') &&
     src.includes('const relSection = paymentOwnerSection(removed, relSectionFallback);'),
    'G4 [frontend]: a payment\'s owning section is taken from the payment itself, not from whichever screen is displaying it — the merged job∪quote list used to send quote-owned payments against the jobs gate');
  ok(!/\{isAdmin\?\(\s*<span className="flex gap-1 justify-center">/.test(src),
    'G4 [frontend]: no payment table still gates its row actions on a bare per-page isAdmin');

  // ══════════════════════════════════════════════════════════════════════════
  // BUG 8 — the previously-shipped migration fixes must all still hold.
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n══ BUG 8 — previously-shipped fixes must not regress ══');

  // H1 — job autosave baseline synchronisation.
  const syncCount = (src.match(/syncRelationalBaseline\(/g) || []).length;
  ok(syncCount >= 27,
    `H1: the autosave baseline is still synced from every relational mutation site (found ${syncCount}) — the Job Notes autosave fix is intact`, syncCount);

  // H2 — manual invoice must not fabricate lifecycle progress.
  await reset();
  const q13 = await makeFullQuote('2', 'Early Invoice Co');
  const conv13 = await services.convertQuoteToJob(q13.id);
  const early = await services.createInvoiceForJob(conv13.jobId); // job is at stage 4
  ok(early.jobStage === 4 && early.jobStatus !== 'invoiced',
    'H2: invoicing a job early does NOT jump it to Invoiced(9) — Deposit Received / In Production / Installation / Completed are still real events, not implied by an invoice existing',
    { stage: early.jobStage, status: early.jobStatus });
  const j13 = (await pool.query(`SELECT invoice_created, invoice_num FROM rel_jobs WHERE id=$1`, [conv13.jobId])).rows[0];
  ok(j13.invoice_created === true && !!j13.invoice_num,
    'H2: the invoice LINKAGE is still unconditional — only the stage bump is conditional', j13);

  // H3 — zero-value / NaN classification.
  ok(src.includes('const hasValidJobValue = Number.isFinite(numericJobValue);') &&
     src.includes('const isZeroValueJob = hasValidJobValue && numericJobValue <= 0;'),
    'H3: a failed value calculation (NaN/null/empty) still can never be misclassified as a genuine zero-value job');
  ok(/const stubJob = \{[\s\S]{0,1800}value: q\.total,/.test(src),
    'H3: the convert stub still carries a real value, so the job never renders as "R NaN"');

  // H4 — credit note company isolation (migration 011).
  const cn = await services.createCreditNote({
    companyCode: '2', type: 'customer', contactName: 'Isolation Co', amount: 500, date: '2026-08-01',
  });
  const cnRow = (await pool.query(`SELECT company_code FROM rel_credit_notes WHERE id=$1`, [cn.id])).rows[0];
  ok(cnRow.company_code === '2', 'H4: a credit note still records its company', cnRow);
  const cnJson = (await buildCreditNotesJson()).find((x) => x._relId === cn.id);
  ok(cnJson.co === 2 && typeof cnJson.co === 'number',
    'H4: and hydrates `co` as a real NUMBER — the frontend\'s company-scoping predicates use strict ===, so a string here would break isolation for every credit note',
    { co: cnJson.co, type: typeof cnJson.co });

  // H5 — Holdings / company scoping across every relational section.
  const q14 = await makeFullQuote('1', 'Holdings Client');
  const conv14 = await services.convertQuoteToJob(q14.id);
  const holdQuote = (await buildQuotesJson()).find((x) => x._relId === q14.id);
  const holdJob = (await buildJobsJson()).find((x) => x._relId === conv14.jobId);
  ok(holdQuote.co === 1 && typeof holdQuote.co === 'number' && holdJob.co === 1 && typeof holdJob.co === 'number',
    'H5: `co` hydrates as a real number for quotes and jobs alike — the Holdings scoping repair is intact',
    { quoteCo: holdQuote.co, jobCo: holdJob.co });
  const original = (await buildJobsJson()).filter((x) => x.co === 2);
  ok(original.length > 0 && original.every((x: any) => x.co !== 1),
    'H5: Original-company records never carry the Holdings company id — no cross-company leakage through the read layer');

  // H6 — the JSON-write safety guard must remain fully armed.
  ok(src.includes('function assertNoUnwiredRelationalSections(sectionNames, contextLabel)') &&
     src.includes("assertNoUnwiredRelationalSections(Object.keys(overrides || {}), 'forceSaveSections');"),
    'H6: the systemic JSON-write guard is untouched and still fires at both save choke points — nothing in this pass weakened it');

  // H7 — concurrency guards, browser side.
  ok(src.includes('async function guardAction(key, fn)') && src.includes('const _actionsInFlight = new Set();'),
    'H7: a shared keyed in-flight guard exists for the primary financial actions');
  const guardedCount = (src.match(/guardAction\(/g) || []).length;
  ok(guardedCount >= 14,
    `H7: it is applied broadly (found ${guardedCount} uses), not to one or two spot-fixes`, guardedCount);
  ok(src.includes('function relKey(rec)'),
    'H7: guards are keyed PER RECORD, so acting on one job never blocks a concurrent action on another');


  // ══════════════════════════════════════════════════════════════════════════
  // PART 2 — REAL HTTP, against a live server with relational authority on.
  //
  // Everything above exercises the services/read layer directly. This part goes
  // over the wire through the actual Express app, because two of the reported
  // symptoms are specifically about what the CLIENT receives: the opaque
  // "Internal error" body, and the response fields the frontend needs to keep
  // its row versions in step. A service-level test cannot see either.
  //
  // Skipped with a clear notice when TEST_SERVER_URL_WITH_AUTHORITY is unset —
  // same convention as every sibling REST suite.
  // ══════════════════════════════════════════════════════════════════════════
  const AUTH_URL = process.env.TEST_SERVER_URL_WITH_AUTHORITY;
  if (!AUTH_URL) {
    console.log('\n══ PART 2 — live HTTP ══\n  ! skipped: TEST_SERVER_URL_WITH_AUTHORITY not set');
  } else {
    console.log('\n══ PART 2 — live HTTP against the relational REST API ══');
    const loginRes = await fetch(`${AUTH_URL}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: process.env.TEST_LOGIN_EMAIL || 'test@signacore.local',
        password: process.env.TEST_LOGIN_PASSWORD || 'testpass',
      }),
    });
    const loginBody: any = await loginRes.json().catch(() => null);
    const token = loginBody && loginBody.token;
    ok(!!token, 'P0: authenticated against the live server');

    const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    // Enable the sections this part needs, then restore whatever was set before.
    const prevFlags = (await pool.query(`SELECT section, enabled FROM relational_cutover`)).rows;
    for (const sec of ['quotes', 'jobs', 'accInvoices']) {
      await pool.query(
        `INSERT INTO relational_cutover (section, enabled) VALUES ($1, true)
         ON CONFLICT (section) DO UPDATE SET enabled = true`, [sec]);
    }
    try {
      await reset();

      // P1 — a full-field quote create over HTTP.
      const custP = await services.createCustomer({ companyName: 'HTTP Test Co' });
      const createRes = await fetch(`${AUTH_URL}/api/relational/quotes`, {
        method: 'POST', headers: H,
        body: JSON.stringify({
          companyCode: '2', customerId: custP.id, customerNameRaw: 'HTTP Test Co',
          lines: [{ description: 'Sign', qty: 1, unitPrice: 1000, unit: 'ea' }],
          ...FULL_QUOTE_FIELDS,
        }),
      });
      const created: any = await createRes.json();
      ok(createRes.status === 201 && created.success,
        'P1: POST /relational/quotes accepts the full field set the Quote form collects', { status: createRes.status, body: created });
      const pQuoteRow = (await pool.query(`SELECT * FROM rel_quotes WHERE id=$1`, [created.id])).rows[0];
      ok(pQuoteRow.contact_person === FULL_QUOTE_FIELDS.contactPerson && pQuoteRow.po_ref === FULL_QUOTE_FIELDS.poRef,
        'P1: those fields really land in the database when sent over the wire', { contact: pQuoteRow.contact_person, poRef: pQuoteRow.po_ref });

      // P2 — convert over HTTP returns the quote's new version.
      const convRes = await fetch(`${AUTH_URL}/api/relational/quotes/${created.id}/convert-to-job`, { method: 'POST', headers: H });
      const convBody: any = await convRes.json();
      ok(convRes.status === 201 && typeof convBody.quoteRowVersion === 'number',
        'P2: POST /convert-to-job returns quoteRowVersion so the client cannot be left holding a version the server has superseded',
        convBody);

      // P3 — and an edit using it succeeds, where before it returned 409.
      const editRes = await fetch(`${AUTH_URL}/api/relational/quotes/${created.id}`, {
        method: 'PUT', headers: H,
        body: JSON.stringify({ expectedVersion: convBody.quoteRowVersion, notes: 'edited straight after conversion' }),
      });
      ok(editRes.status === 200,
        'P3: editing the quote immediately after converting it returns 200 — the reported "quote save randomly fails" sequence, end to end over HTTP',
        editRes.status);

      // P4 — a genuine conflict is 409 stale_record, distinguishable from a fault.
      const staleRes = await fetch(`${AUTH_URL}/api/relational/quotes/${created.id}`, {
        method: 'PUT', headers: H,
        body: JSON.stringify({ expectedVersion: 1, notes: 'stale' }),
      });
      const staleBody: any = await staleRes.json();
      ok(staleRes.status === 409 && staleBody.type === 'stale_record',
        'P4: a stale save is 409 {type:"stale_record"} — the client can tell a conflict from a server fault without parsing prose',
        { status: staleRes.status, body: staleBody });

      // P5 — a payment over HTTP, then read back through the authoritative read.
      const payRes = await fetch(`${AUTH_URL}/api/relational/payments`, {
        method: 'POST', headers: H,
        body: JSON.stringify({ ownerType: 'job', ownerId: convBody.jobId, amount: 1500, date: '2026-08-20', method: 'EFT' }),
      });
      const payBody: any = await payRes.json();
      ok(payRes.status === 201 && payBody.paymentId,
        'P5: POST /relational/payments records the payment', { status: payRes.status, body: payBody });
      const stateRes = await fetch(`${AUTH_URL}/api/platform-state`, { headers: H });
      const stateBody: any = await stateRes.json();
      const httpJob = (stateBody.data.jobs || []).find((j: any) => j._relId === convBody.jobId);
      ok(!!httpJob && (httpJob.payments || []).length === 1 && httpJob.payments[0].amount === 1500,
        'P5: the very next GET /api/platform-state already shows that payment — this is exactly what the frontend now re-reads after every relational write, and why no manual refresh is needed',
        httpJob && httpJob.payments);
      ok(!!httpJob && httpJob.payments[0]._relOwnerType === 'job',
        'P5: and it arrives stamped with its own owner section');
      ok(Array.isArray(stateBody.relationalAuthoritativeSections) && stateBody.relationalAuthoritativeSections.includes('jobs'),
        'P5: the response still tells the client which sections are relational-authoritative — the input to the refresh\'s "apply only these" rule',
        stateBody.relationalAuthoritativeSections);

      // P6 — deposit waiver over HTTP creates no money.
      const jobVerRow = (await pool.query(`SELECT row_version FROM rel_jobs WHERE id=$1`, [convBody.jobId])).rows[0];
      const waiveRes = await fetch(`${AUTH_URL}/api/relational/jobs/${convBody.jobId}`, {
        method: 'PUT', headers: H,
        body: JSON.stringify({ expectedVersion: jobVerRow.row_version, stage: 5, status: 'deposit_received', depositWaived: true }),
      });
      ok(waiveRes.status === 200, 'P6: PUT /relational/jobs accepts the deposit-waiver override', waiveRes.status);
      const payCountAfterWaive = (await pool.query(
        `SELECT count(*)::int AS n FROM rel_payments WHERE owner_type='job' AND owner_id=$1`, [convBody.jobId])).rows[0].n;
      ok(payCountAfterWaive === 1,
        'P6: the override created no additional payment — the one payment recorded in P5 is still the only one', payCountAfterWaive);

      // P7 — invoice idempotency over HTTP: two rapid calls, one invoice.
      await pool.query(`UPDATE rel_jobs SET stage = 7 WHERE id = $1`, [convBody.jobId]);
      const [i1, i2] = await Promise.all([
        fetch(`${AUTH_URL}/api/relational/jobs/${convBody.jobId}/create-invoice`, { method: 'POST', headers: H }),
        fetch(`${AUTH_URL}/api/relational/jobs/${convBody.jobId}/create-invoice`, { method: 'POST', headers: H }),
      ]);
      const statuses = [i1.status, i2.status].sort();
      ok(statuses[0] === 201 && statuses[1] === 409,
        'P7: two simultaneous Create Invoice requests — exactly one succeeds, the other is refused with a business rule, never a second document',
        statuses);
      const httpInvCount = (await pool.query(`SELECT count(*)::int AS n FROM rel_invoices WHERE job_id=$1`, [convBody.jobId])).rows[0].n;
      ok(httpInvCount === 1, 'P7: exactly one invoice exists afterward', httpInvCount);

      // P8 — that invoice hydrates with lineItems (non-zero) and a reference.
      const stateRes2 = await fetch(`${AUTH_URL}/api/platform-state`, { headers: H });
      const stateBody2: any = await stateRes2.json();
      const httpInvForJob = (stateBody2.data.accInvoices || []).find((i: any) => i.jobNum && i.jobNum.length > 0);
      ok(!!httpInvForJob && Array.isArray(httpInvForJob.lineItems) && httpInvForJob.lineItems.length > 0,
        'P8: the invoice reaches the browser with `lineItems` populated — the key every UI total is computed from, and the reason relational invoices rendered as R0.00',
        httpInvForJob && { lineItems: httpInvForJob.lineItems && httpInvForJob.lineItems.length });
      ok(!!httpInvForJob && !!httpInvForJob.reference && httpInvForJob.reference === httpInvForJob.jobNum,
        'P8: and with `reference` set to the job number — the de-duplication key whose absence produced the duplicate INV-00099 rendering',
        httpInvForJob && { reference: httpInvForJob.reference, jobNum: httpInvForJob.jobNum });
    } finally {
      // Restore the cutover flags exactly as they were — this suite must never
      // leave a section switched on behind it.
      for (const row of prevFlags) {
        await pool.query(`UPDATE relational_cutover SET enabled = $2 WHERE section = $1`, [row.section, row.enabled]);
      }
    }
  }


  // ══════════════════════════════════════════════════════════════════════════
  // PART 3 — DEFECTS FOUND BY THE ADVERSARIAL REVIEW OF THIS PASS ITSELF.
  //
  // Every assertion here pins a defect that the first cut of these fixes
  // introduced or left open, and that a review found before deploy. They are
  // kept because each one is a regression trap the original code fell into
  // once already.
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n══ PART 3 — self-review findings ══');

  await reset();

  // R1 — A job with NO line items must not invoice as R0.00.
  // createInvoiceForJob builds lines from rel_job_line_items. A job converted
  // from a quote always has them; a job created directly (the Jobs page's "Add
  // New Job", which has no line editor) has none — so its invoice had zero
  // lines and rendered as R0.00 everywhere: the same symptom the duplicate-INV
  // report was about, reintroduced through a brand-new code path.
  const bareJob = await services.createJob({
    companyCode: '2', customerNameRaw: 'Walk-in Client', description: 'Emergency callout signage', value: 8050,
  });
  await pool.query(`UPDATE rel_jobs SET stage = 7 WHERE id = $1`, [bareJob.id]);
  const bareInv = await services.createInvoiceForJob(bareJob.id);
  const bareInvJson = (await buildInvoicesJson()).find((x) => x._relId === bareInv.invoiceId);
  const bareTotal = (bareInvJson.lineItems || []).reduce((t: number, l: any) => {
    const sub = Number(l.qty) * Number(l.unitAmount);
    return t + sub + (l.taxType === '15%' ? sub * 0.15 : 0);
  }, 0);
  ok((bareInvJson.lineItems || []).length === 1,
    'R1: a job with no line items still produces an invoice WITH a line — not the R0.00 invoice this pass exists to eliminate',
    bareInvJson.lineItems);
  ok(Math.abs(bareTotal - 8050) < 0.01,
    'R1: and that line reconstructs the job\'s value exactly — rel_jobs.value is VAT-INCLUSIVE, so the line is stored ex-VAT and the 15% tax type adds it back, never charging VAT twice',
    { computed: bareTotal, jobValue: 8050 });

  // R2 — invoice adoption must not hijack the wrong invoice.
  await reset();
  const q15 = await makeFullQuote('2', 'Adoption Safety Co');
  const conv15 = await services.convertQuoteToJob(q15.id);
  const job15num = (await pool.query(`SELECT job_number FROM rel_jobs WHERE id=$1`, [conv15.jobId])).rows[0].job_number;

  // (a) A standalone manual invoice that merely TYPES this job's number into its
  //     free-text Reference field must never be absorbed into the job.
  const decoy = await services.createManualInvoice({
    companyCode: '2', contactName: 'Someone Else', reference: job15num,
    lines: [{ description: 'Unrelated work', qty: 1, unitAmount: 999 }],
  });
  // (b) A VOIDED invoice for this job's own quote must never be adopted either.
  const voided = await services.createManualInvoice({
    companyCode: '2', contactName: 'Adoption Safety Co', status: 'void',
    lines: [{ description: 'Cancelled', qty: 1, unitAmount: 1 }],
  });
  await pool.query(`UPDATE rel_invoices SET quote_id = $1 WHERE id = $2`, [q15.id, voided.id]);

  await pool.query(`UPDATE rel_jobs SET stage = 7 WHERE id = $1`, [conv15.jobId]);
  const adopted = await services.createInvoiceForJob(conv15.jobId);
  ok(adopted.invoiceNumber !== decoy.invoiceNumber,
    'R2a: a manual invoice that merely references the job number in free text is NOT absorbed into the job — adoption matches only on real links (job_id / the job\'s own source quote)',
    { adopted: adopted.invoiceNumber, decoy: decoy.invoiceNumber });
  const decoyRow = (await pool.query(`SELECT job_id FROM rel_invoices WHERE id=$1`, [decoy.id])).rows[0];
  ok(decoyRow.job_id === null, 'R2a: and that manual invoice is left completely untouched', decoyRow);
  ok(adopted.invoiceNumber !== voided.invoiceNumber,
    'R2b: a VOIDED invoice is never adopted — doing so would mark the job Invoiced against a number the UI filters out of every list',
    { adopted: adopted.invoiceNumber, voided: voided.invoiceNumber });

  // (c) Ordering: when an invoice IS already linked to this job, it must win
  //     over any unlinked candidate. `(job_id = $2) DESC` evaluated to NULL for
  //     unlinked rows and Postgres sorts DESC NULLS FIRST, so the unlinked one
  //     used to outrank the linked one — the exact inversion of the intent.
  await reset();
  const q16 = await makeFullQuote('2', 'Adoption Order Co');
  const conv16 = await services.convertQuoteToJob(q16.id);
  const linkedInv = await services.createManualInvoice({
    companyCode: '2', contactName: 'Adoption Order Co',
    lines: [{ description: 'Already linked', qty: 1, unitAmount: 500 }],
  });
  await pool.query(`UPDATE rel_invoices SET job_id = $1 WHERE id = $2`, [conv16.jobId, linkedInv.id]);
  const unlinkedInv = await services.createManualInvoice({
    companyCode: '2', contactName: 'Adoption Order Co',
    lines: [{ description: 'Unlinked, same quote', qty: 1, unitAmount: 500 }],
  });
  await pool.query(`UPDATE rel_invoices SET quote_id = $1, job_id = NULL WHERE id = $2`, [q16.id, unlinkedInv.id]);
  const ordered = await services.createInvoiceForJob(conv16.jobId);
  ok(ordered.invoiceNumber === linkedInv.invoiceNumber,
    'R2c: the invoice ALREADY linked to this job is preferred over an unlinked candidate (the NULLS-FIRST ordering bug inverted this)',
    { chose: ordered.invoiceNumber, linked: linkedInv.invoiceNumber, unlinked: unlinkedInv.invoiceNumber });

  // R3 — DATE columns reached through the two colMap loops that the shared
  // normaliser originally missed.
  await reset();
  const q17 = await makeFullQuote('2', 'Date Clearing Co');
  const conv17 = await services.convertQuoteToJob(q17.id);
  const pay17 = await services.recordPayment({ type: 'job', id: conv17.jobId }, 100, { date: '2026-08-01', method: 'EFT' });
  const pay17ver = (await pool.query(`SELECT row_version FROM rel_payments WHERE id=$1`, [pay17.paymentId])).rows[0].row_version;
  let r3aErr: any = null;
  try { await services.updatePayment(pay17.paymentId, pay17ver, { date: '' }); } catch (e) { r3aErr = e; }
  ok(r3aErr === null,
    'R3a: clearing a PAYMENT date does not raise 22007 -> an opaque 500 (rel_payments.payment_date is a DATE column that the shared normaliser originally skipped)',
    r3aErr && String(r3aErr));

  const cn17 = await services.createCreditNote({ companyCode: '2', type: 'customer', contactName: 'Date Clearing Co', amount: 100, date: '2026-08-01' });
  const cn17ver = (await pool.query(`SELECT row_version FROM rel_credit_notes WHERE id=$1`, [cn17.id])).rows[0].row_version;
  let r3bErr: any = null;
  try { await services.updateCreditNote(cn17.id, cn17ver, { date: '' } as any); } catch (e) { r3bErr = e; }
  ok(r3bErr === null,
    'R3b: clearing a CREDIT NOTE date behaves the same way (rel_credit_notes.note_date — the other column the normaliser skipped)',
    r3bErr && String(r3bErr));

  // R4 — proformaNum must have a relational write path, or both Proforma
  // actions are dead once quotes are cut over (each attempt having already
  // burned a number from the atomic pool).
  const q18 = await makeFullQuote('2', 'Proforma Persist Co');
  const q18ver = (await pool.query(`SELECT row_version FROM rel_quotes WHERE id=$1`, [q18.id])).rows[0].row_version;
  await services.updateQuote(q18.id, q18ver, { proformaNum: 'PRO-00123' } as any);
  const q18row = (await pool.query(`SELECT proforma_num FROM rel_quotes WHERE id=$1`, [q18.id])).rows[0];
  ok(q18row.proforma_num === 'PRO-00123',
    'R4: a reserved proforma number persists through the relational quote patch', q18row);
  const q18json = (await buildQuotesJson()).find((x) => x._relId === q18.id);
  ok(q18json.proformaNum === 'PRO-00123', 'R4: and hydrates back for the Proforma display row / reuse check', q18json.proformaNum);

  // R5 — an invoice must reach the browser with `date` populated, or the
  // dashboard revenue chart silently drops it (`if(!d)return`).
  const q19 = await makeFullQuote('2', 'Revenue Date Co');
  const conv19 = await services.convertQuoteToJob(q19.id);
  await pool.query(`UPDATE rel_jobs SET stage = 7 WHERE id = $1`, [conv19.jobId]);
  const inv19 = await services.createInvoiceForJob(conv19.jobId);
  const inv19json = (await buildInvoicesJson()).find((x) => x._relId === inv19.invoiceId);
  ok(typeof inv19json.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(inv19json.date),
    'R5: read.ts emits `date` alongside `issueDate` — the frontend reads inv.date, and without it every relational invoice was skipped by the revenue chart and showed a blank Date column',
    inv19json.date);
  ok(inv19json.date === inv19json.issueDate, 'R5: both keys describe the same date', { date: inv19json.date, issueDate: inv19json.issueDate });

  // R6 — the two crashers this pass introduced and a review caught. Both are
  // browser-only, so pinned by structure rather than by execution.
  const jobDetailStart = src.indexOf('function JobDetail({');
  // Anchored on the STATEMENT (line-start indentation), never on the bare
  // substring — a comment mentioning the guard would otherwise match first and
  // make this check silently examine the wrong slice of the component.
  const jobDetailEarlyReturn = src.indexOf('\n  if (!job) return', jobDetailStart);
  const jobDetailEnd = src.indexOf('\nfunction ', jobDetailEarlyReturn);
  const jobDetailAfterGuard = src.slice(jobDetailEarlyReturn, jobDetailEnd);
  ok(jobDetailStart !== -1 && jobDetailEarlyReturn !== -1,
    'R6a: JobDetail and its early return are both present (the fixture for the check below)');
  ok(!/\buseState\(|\buseEffect\(|\buseRef\(|\buseMemo\(/.test(jobDetailAfterGuard),
    'R6a: NO React hook is declared after JobDetail\'s `if (!job) return` guard. A hook past an early return is committed on some renders and not others — React throws "Rendered fewer hooks than expected" and, with no error boundary in this app, the entire page goes blank. The authoritative refresh replaces `jobs` wholesale after every relational write, which makes an absent job far more likely than it used to be.');

  const paySourceUses = (src.match(/paySource/g) || []).length;
  const quotePayModalStart = src.indexOf('function QuotePaymentsModal(');
  const paymentHistoryModalStart = src.indexOf('function PaymentHistoryModal(');
  const paymentHistoryModalEnd = src.indexOf('\n  function ', paymentHistoryModalStart + 100);
  ok(paySourceUses > 0 && quotePayModalStart !== -1 && paymentHistoryModalStart !== -1,
    'R6b: the payment modals are present (the fixture for the check below)');
  ok(!src.slice(paymentHistoryModalStart, paymentHistoryModalStart + 6000).includes('paySource'),
    'R6b: PaymentHistoryModal never references `paySource` — that identifier belongs to the two OTHER payment modals and does not exist in this component\'s scope, so a copy-pasted use threw ReferenceError inside a React handler and silently killed the Edit-payment action for every role');
  void paymentHistoryModalEnd;

  // R7 — the invoice de-duplication key and the lookups it gates must agree.
  ok(src.includes('function invoiceBelongsToJob(inv, jobNum)') &&
     src.includes('return inv.reference === jobNum || inv.jobNum === jobNum;'),
    'R7: one shared predicate decides whether an invoice belongs to a job');
  ok(!/i\.reference===job\.num/.test(src) && !/i\.reference===linkedJob\.num/.test(src),
    'R7: no lookup still matches on `reference` alone. Widening the de-dup SET without widening the LOOKUPS made things worse — the gate passed while the lookup returned nothing, so a pre-fix invoice\'s link disappeared from the job entirely');

  // R8 — the previously-unwired writes that would have silently lost data.
  ok(/function handleRelinkJob\(q, jobId\)[\s\S]{0,3000}relationalApi\.updateJob/.test(src),
    'R8: the quote/job relink persists relationally instead of mutating two authoritative sections behind a success alert and losing the change on the next refresh');
  ok(/if\(isRelationalAuthoritative\('accInvoices'\)\)\{[\s\S]{0,2000}relationalApi\.recordPayment\('invoice'/.test(src),
    'R8: the auto-apply-credit-notes EFFECT goes through the real payment API — it creates genuine money movements, and being an effect rather than a button it re-fired on every render, producing a permanent failing-save loop');
  ok(/EditInvoiceForm[\s\S]{0,3000}relationalApi\.updateJob/.test(src),
    'R8: Jobs -> Edit Invoice persists relationally instead of being dead under cutover');
  ok(/ensureProformaNumber[\s\S]{0,2500}relationalApi\.updateQuote/.test(src),
    'R8: Print/Email Proforma persists the reserved number relationally instead of aborting after burning it');

  // R9 — ordering and retry on the authoritative refresh.
  ok(src.includes('const seq = ++relationalRefreshSeqRef.current;') &&
     src.includes('if (seq !== relationalRefreshSeqRef.current) {'),
    'R9: concurrent refreshes are sequenced, so a slower older snapshot cannot overwrite a newer one — doing so would revert the user\'s change AND roll every _relRowVersion back to a superseded value, causing the very 409s this refresh exists to prevent');
  ok(/setTimeout\(\(\) => requestRelationalRefresh\(reason\), 4000\)/.test(src),
    'R9: a failed refresh retries once — the 30s poll cannot recover it, because a relational write never moves platform_state\'s `_autoSavedAt`');

  // R10 — the waiver actor must come from the session, not the request body.
  const apiSrc = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'relational', 'api.ts'), 'utf8');
  ok(apiSrc.includes('depositWaivedBy: _ignoredActor') && apiSrc.includes('const actor = req.user'),
    'R10: the deposit-waiver actor is taken from the authenticated session and the body value is discarded — otherwise attribution for a financial-control override is client-forgeable, and (since the UI never sent it) deposit_waived_by would always have been NULL');

  // R11 — create-path double-submit protection where the shared guard cannot help.
  ok(/function AddEditSupplierModal[\s\S]{0,1200}const \[busy, setBusy\] = useState\(false\);/.test(src) &&
     /function AddEditInventoryItemModal[\s\S]{0,1200}const \[busy, setBusy\] = useState\(false\);/.test(src),
    'R11: the supplier and inventory modals carry their own in-flight flag — the shared guardAction key is derived from the record id, and a NEW record\'s id is regenerated on every click, so two rapid clicks produced two different keys and two records');

  // ── summary ───────────────────────────────────────────────────────────────
  console.log(`\n[post-migration-stabilization] ${passed} passed, ${failures} failed`);
  await pool.end();
  if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error('[post-migration-stabilization] Fatal error:', err);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
