/**
 * proforma-numbering.stress.ts — 2026-08-20 forward-only PRO-##### proforma
 * numbering regression suite.
 *
 * Companion to hardening.stress.ts (same harness shape, run the same way,
 * against the SAME disposable local test database — see that file's header
 * for the full usage/safety rationale, not repeated here). This file
 * exercises specifically the backend contract the new PRO numbering rule
 * depends on:
 *
 *   - a new proforma reserves its invoice number from the SAME atomic
 *     'invoice' pool every other invoice creation path uses (no separate
 *     PRO counter);
 *   - once reserved, the reserved INV-##### number is genuinely unavailable
 *     to any other invoice/proforma creation path (job, manual, quote,
 *     another proforma) until the reservation is finalised or explicitly
 *     reassigned;
 *   - legacy INV-style proformaNum values keep working completely
 *     unchanged;
 *   - collisions are always a recoverable, structured conflict with a
 *     suggested next-safe number — never a silent substitution, never a
 *     deleted/overwritten record;
 *   - concurrent reservations (proforma + manual + job, all at once) never
 *     converge on the same invoice number;
 *   - historical records are never mass-renumbered — nothing in
 *     documentNumbers.ts ever writes to platform_state.quotes.
 *
 * The PRO<->INV derivation itself, and the finalisation
 * (resolveProformaInvoiceNumber) / reservation (reserveProformaNumber)
 * logic, live in index.html on the frontend — see
 * test/proforma-frontend-logic.test.ts, which extracts and exercises that
 * ACTUAL shipped code (not a reimplementation) in a Node vm sandbox against
 * this same backend.
 *
 * Usage (from backend/):
 *   DATABASE_URL=postgresql://user:pass@localhost:5432/signacore_test \
 *   TEST_SERVER_URL=http://localhost:4001 \
 *   TEST_LOGIN_EMAIL=test@signacore.local TEST_LOGIN_PASSWORD=testpass \
 *   npx ts-node --transpile-only test/proforma-numbering.stress.ts
 */

const BASE = process.env.TEST_SERVER_URL || 'http://localhost:4001';
const DB_URL = process.env.DATABASE_URL || '';

if (!/localhost|127\.0\.0\.1/.test(DB_URL) && process.env.ALLOW_UNSAFE_TEST_DB !== '1') {
  console.error('[proforma-numbering] Refusing to run: DATABASE_URL does not look like a local test database.');
  console.error('[proforma-numbering] Set ALLOW_UNSAFE_TEST_DB=1 only if you are certain this is a disposable test DB.');
  process.exit(1);
}

let TOKEN = '';
let failures = 0;
let passed = 0;

function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

async function login(): Promise<void> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.TEST_LOGIN_EMAIL || 'test@signacore.local',
      password: process.env.TEST_LOGIN_PASSWORD || 'testpass',
    }),
  });
  if (!res.ok) throw new Error(`login failed: HTTP ${res.status}`);
  const body = await res.json();
  TOKEN = body.token;
}

function authHeaders() {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };
}

async function getState(): Promise<{ data: any; updated_at: string | null }> {
  const res = await fetch(`${BASE}/api/platform-state`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`GET platform-state failed: HTTP ${res.status}`);
  return res.json();
}

async function putPartial(payload: Record<string, any>): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}/api/platform-state`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify({ data: { ...payload, _partial: true } }),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

let counter = 0;
function uid(): string {
  counter += 1;
  return String(Date.now()) + String(counter).padStart(4, '0');
}

async function reserve(company: string, docType: string, requestedNumber?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}/api/document-numbers/reserve`, {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ company, docType, ...(requestedNumber ? { requestedNumber } : {}) }),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function check(company: string, docType: string, requestedNumber: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}/api/document-numbers/check`, {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ company, docType, requestedNumber }),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// Mirrors index.html's invoiceNumberToProformaNumber()/
// proformaToReservedInvoiceNumber() — used here purely to construct test
// fixtures, NOT as the thing under test (that's exercised for real, from
// the actual shipped source, in proforma-frontend-logic.test.ts).
function toPro(inv: string): string {
  return 'PRO-' + inv.replace(/^INV-/i, '');
}

// 1 — New quote still receives SQ number normally (unaffected regression).
async function scenario1_quoteNumberingUnaffected() {
  console.log('\n[Scenario 1] New quote still receives SQ-##### normally — PRO numbering never touches the quote pool');
  const r = await reserve('1', 'quote');
  ok(r.status === 200 && /^SQ-\d{5,}$/.test(r.body.number), 'quote reservation returns SQ-#####', r.body);
}

// 2/3 — A PRO reservation comes from the SAME atomic invoice pool, and its
// suffix genuinely equals a real invoice-pool reservation.
async function scenario2_proReservationFromInvoicePool() {
  console.log('\n[Scenario 2] A new proforma reservation comes from the SAME atomic \'invoice\' pool (no separate PRO counter)');
  const r1 = await reserve('1', 'invoice');
  ok(r1.status === 200 && /^INV-\d{5,}$/.test(r1.body.number), 'reserving docType:invoice (what a PRO reservation uses under the hood) returns INV-#####', r1.body);
  const proNumber = toPro(r1.body.number);

  const r2 = await reserve('1', 'invoice');
  ok(r2.status === 200 && r2.body.number !== r1.body.number, 'a second reservation is a genuinely different number — same pool, never reused', { r1: r1.body, r2: r2.body });

  return { reservedInvoice: r1.body.number, proNumber };
}

// 4/9/10 — Persisting a PRO-carrying quote blocks its matching INV slot
// from every other invoice creation path (manual, job-derived, another
// proforma), and the owner is correctly identified.
async function scenario4_proReservationBlocksMatchingInvoiceSlot() {
  console.log('\n[Scenario 4] PRO-carrying quote blocks its exact matching INV-##### slot from every other invoice path');
  const r1 = await reserve('1', 'invoice');
  const reservedInvoice = r1.body.number as string;
  const proNumber = toPro(reservedInvoice);

  const start = await getState();
  const proQuote = { id: uid(), num: `SQ-PRO-TEST-${uid()}`, client: 'PRO Test Client', co: '1', status: 'approved', proformaNum: proNumber };
  const save = await putPartial({ quotes: [...(start.data.quotes || []), proQuote] });
  ok(save.status === 200, 'PRO-carrying quote persists successfully', save.body);

  // /check must now report the matching INV number as occupied, owned by
  // this quote's proforma reservation.
  const c = await check('1', 'invoice', reservedInvoice);
  ok(c.status === 200 && c.body.available === false && c.body.conflict === true, `/check reports ${reservedInvoice} as occupied by the PRO reservation`, c.body);
  ok(c.body.owner && c.body.owner.id === proQuote.id && c.body.owner.documentType === 'quote proforma reservation', '/check identifies the PRO-carrying quote as owner', c.body.owner);

  // A manual/unrelated invoice reservation requesting that EXACT number is
  // refused with a structured conflict, never silently granted (this is
  // the precise regression the 2026-08-20 fix closes — before it, a
  // PRO-##### proformaNum was invisible to this check because it was
  // compared literally against "INV-#####" and never matched).
  const manualAttempt = await reserve('1', 'invoice', reservedInvoice);
  ok(manualAttempt.status === 409 && manualAttempt.body.conflict === true, `manual invoice reservation of ${reservedInvoice} is refused with 409, not silently granted`, manualAttempt.body);
  ok(!!manualAttempt.body.suggestedNumber, 'conflict response includes a suggested safe alternative', manualAttempt.body);

  // An AUTO (no requestedNumber) reservation must also skip the occupied
  // slot even when the counter has fallen behind it (a realistic gap —
  // e.g. the counter row was seeded before this PRO reservation existed).
  const { Client } = await import('pg');
  const pgClient = new Client({ connectionString: DB_URL });
  await pgClient.connect();
  try {
    const invNumericValue = parseInt(reservedInvoice.replace(/^INV-/, ''), 10);
    await pgClient.query(
      `UPDATE document_number_counters SET last_number = $1 WHERE company = '1' AND doc_type = 'invoice'`,
      [invNumericValue - 1]
    );
    const autoAttempt = await reserve('1', 'invoice');
    ok(autoAttempt.status === 200 && autoAttempt.body.number !== reservedInvoice, `auto (non-manual) reservation with the counter rewound to just before ${reservedInvoice} SKIPS the PRO-occupied slot`, autoAttempt.body);
  } finally {
    await pgClient.end();
  }

  // The existing quote record itself was never touched/renumbered by any
  // of the above collision attempts.
  const after = await getState();
  const stillThere = (after.data.quotes || []).find((q: any) => q.id === proQuote.id);
  ok(!!stillThere && stillThere.proformaNum === proNumber, 'the PRO-carrying quote record itself is untouched by every collision attempt above', stillThere);

  return { reservedInvoice, proNumber, proQuote };
}

// 12/13/15/17/19 — collision never deletes/overwrites, decline changes
// nothing, and historical records are never mass-renumbered by this
// endpoint (documentNumbers.ts never writes platform_state.quotes at all).
async function scenario5_collisionNeverMutatesExistingRecords() {
  console.log('\n[Scenario 5] Collision/decline never deletes, overwrites, or renumbers any existing record');
  const r1 = await reserve('1', 'invoice');
  const reservedInvoice = r1.body.number as string;
  const proNumber = toPro(reservedInvoice);
  const start = await getState();
  const proQuote = { id: uid(), num: `SQ-PRO-TEST-${uid()}`, client: 'Collision Test', co: '1', status: 'approved', proformaNum: proNumber };
  await putPartial({ quotes: [...(start.data.quotes || []), proQuote] });

  const before = await getState();
  const beforeQuoteJson = JSON.stringify((before.data.quotes || []).find((q: any) => q.id === proQuote.id));

  // Repeated collision attempts + a repeated /check (simulating the user
  // declining the suggested reassignment) — nothing about the reservation
  // or the quote record changes.
  await reserve('1', 'invoice', reservedInvoice);
  await reserve('1', 'invoice', reservedInvoice);
  const secondCheck = await check('1', 'invoice', reservedInvoice);
  ok(secondCheck.body.conflict === true && secondCheck.body.owner.id === proQuote.id, 're-checking after a decline reports the exact same unresolved conflict, nothing silently changed', secondCheck.body);

  const after = await getState();
  const afterQuoteJson = JSON.stringify((after.data.quotes || []).find((q: any) => q.id === proQuote.id));
  ok(beforeQuoteJson === afterQuoteJson, 'the PRO-carrying quote record is byte-identical before/after every collision + decline — documentNumbers.ts never writes platform_state.quotes', { before: beforeQuoteJson, after: afterQuoteJson });
}

// 12 (legacy) — a pre-existing legacy INV-style proformaNum keeps blocking
// exactly as it always did (non-regression of the 2026-08-17 behaviour).
async function scenario6_legacyInvStyleProformaUnaffected() {
  console.log('\n[Scenario 6] Legacy INV-style proformaNum keeps blocking its own number exactly as before (non-regression)');
  const legacyNumber = `INV-${(600000000 + (Date.now() % 90000000)).toString()}`;
  const start = await getState();
  const legacyQuote = { id: uid(), num: `SQ-LEGACY-TEST-${uid()}`, client: 'Legacy Test', co: '1', status: 'approved', proformaNum: legacyNumber };
  await putPartial({ quotes: [...(start.data.quotes || []), legacyQuote] });

  const c = await check('1', 'invoice', legacyNumber);
  ok(c.body.available === false && c.body.owner && c.body.owner.id === legacyQuote.id, 'legacy INV-style proformaNum still occupies its own number, owner correctly identified', c.body);

  const manualAttempt = await reserve('1', 'invoice', legacyNumber);
  ok(manualAttempt.status === 409, 'legacy proforma number still refuses a colliding manual reservation', manualAttempt.body);
}

// 16/18 — atomicity: many concurrent invoice-pool reservations (mixing
// auto and PRO-shaped usage) never converge on the same number.
async function scenario7_concurrentReservationsNeverDuplicate() {
  console.log('\n[Scenario 7] Concurrent proforma + manual + job invoice reservations never collide (atomicity under load)');
  const N = 15;
  const results = await Promise.all(
    Array.from({ length: N }, () => reserve('2', 'invoice'))
  );
  const numbers = results.map((r) => r.body && r.body.number).filter(Boolean);
  ok(numbers.length === N, `all ${N} concurrent reservations (simulating a mix of proforma + manual + job invoice creation, all drawing from the SAME pool) returned a number`, results.map(r => r.status));
  ok(new Set(numbers).size === N, `all ${N} concurrent reservations are UNIQUE — no duplicate invoice/proforma numbers under concurrent load`, numbers);
}

async function main() {
  await login();
  console.log(`[proforma-numbering] Logged in. Target: ${BASE}. DB: ${DB_URL.replace(/:[^:@]*@/, ':***@')}`);

  await scenario1_quoteNumberingUnaffected();
  await scenario2_proReservationFromInvoicePool();
  await scenario4_proReservationBlocksMatchingInvoiceSlot();
  await scenario5_collisionNeverMutatesExistingRecords();
  await scenario6_legacyInvStyleProformaUnaffected();
  await scenario7_concurrentReservationsNeverDuplicate();

  console.log(`\n${'='.repeat(60)}\n${passed} passed, ${failures} failed\n${'='.repeat(60)}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[proforma-numbering] Fatal error:', err);
  process.exit(1);
});

// 2026-08-20 STAGE 2: see the identical note at the end of
// test/hardening.stress.ts — same fix, same reason (module-scoping only).
export {};
