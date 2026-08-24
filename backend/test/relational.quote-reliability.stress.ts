/**
 * relational.quote-reliability.stress.ts
 * ──────────────────────────────────────
 * Quote creation / save reliability audit against the CURRENT shipped code,
 * after the relational cutover (quotes = relational-authoritative).
 *
 * Every test drives the REAL services through a REAL local Postgres, and every
 * payload is built by the SAME mapping the shipped UI uses — the create payload
 * is `CreateQuoteModal.submit`'s (index.html ~6892) and the edit patch is
 * `QuotesPage.handleSave`'s (index.html ~8996), both PINNED to the shipped
 * source by TEST P so this suite can never test a payload the app doesn't send.
 *
 * ── KNOWN DEFECT, PINNED (not silently tolerated) ────────────────────────────
 * Quote lines carry three user-entered fields the relational schema has no
 * home for: `sqmL`, `sqmW` (dimensions in mm) and `pQty` (pieces). They drive
 *   - the printed quote's spec line          (index.html ~2125-2141)
 *   - the Job Card's spec line               (index.html ~4109-4111)
 *   - the item COUNT for a dimensioned line  (index.html ~4117-4122)
 *   - the line subtotal: pQty x qty x unitPrice  (index.html ~6753)
 * rel_quote_line_items / rel_job_line_items have no columns for them, the UI
 * never sends them, and createQuote/replaceQuoteLinesTx write legacy_data as
 * '{}' — which ALSO destroys them on any edit of a backfilled quote, where they
 * are the only copy. The server therefore recomputes the line subtotal WITHOUT
 * pQty, understating the stored subtotal/VAT/total by a factor of pQty.
 *
 * The affected tests below report `⚠ KNOWN DEFECT` and assert that the defect
 * STILL EXISTS, so the suite stays green while the defect is unfixed AND tells
 * you the moment it is fixed (flip DIMENSIONS_PERSISTED to true and they become
 * ordinary hard assertions). They are never silently skipped.
 *
 * SAFETY: refuses to run unless DATABASE_URL points at localhost/127.0.0.1 or
 * ALLOW_UNSAFE_TEST_DB=1 is set. TRUNCATEs only the rel_* tables it owns and
 * never touches platform_state or platform_state_backups.
 *
 * Usage (from backend/):
 *   DATABASE_URL=postgresql://user:pass@localhost:5432/signacore_test \
 *   npx ts-node --transpile-only test/relational.quote-reliability.stress.ts
 */
import fs from 'fs';
import path from 'path';
import pool from '../src/db/pool';
import * as services from '../src/relational/services';
import { ConcurrencyConflictError, BusinessRuleError } from '../src/relational/services';
import { buildQuotesJson, buildJobsJson } from '../src/relational/read';

const DB_URL = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(DB_URL) && process.env.ALLOW_UNSAFE_TEST_DB !== '1') {
  console.error('[quote-reliability] Refusing to run: DATABASE_URL does not look like a local test database.');
  process.exit(1);
}
const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH || path.resolve(__dirname, '..', '..', 'index.html');
const HTML = fs.readFileSync(INDEX_HTML_PATH, 'utf8').replace(/\r\n/g, '\n');
function extractFn(src: string, name: string): string {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
  if (!m) return '';
  const bs = src.indexOf('{', src.indexOf(')', m.index));
  let d = 0, i = bs;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (!d) { i++; break; } } }
  return src.slice(m.index, i);
}

/** Flip each to true the moment the matching defect is fixed. */
const DIMENSIONS_PERSISTED = true;       // FIXED — migration 013 + full wiring
const DATE_INPUT_HARDENED = true;        // FIXED — validation before SQL
const JOB_LINES_PROTECTED = true;        // FIXED — the cascade is now explicit-only
const ATTACHMENTS_PERSISTED = false;     // OPTION B — mutation blocked, not persisted (see [Q])

let failures = 0, passed = 0, knownDefects = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}
/**
 * `shouldBe` is what CORRECT behaviour looks like. While DIMENSIONS_PERSISTED
 * is false the test asserts the defect is still present and reports it loudly;
 * once the fix lands it asserts the correct behaviour instead.
 */
function pinnedDefect(actualIsCorrect: boolean, label: string, detail?: unknown) {
  if (DIMENSIONS_PERSISTED) return ok(actualIsCorrect, label, detail);
  if (!actualIsCorrect) {
    knownDefects++;
    console.log(`  ⚠ KNOWN DEFECT — ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`);
  } else {
    failures++;
    console.log(`  ✗ ${label} now PASSES — the defect appears fixed. Set DIMENSIONS_PERSISTED = true so this becomes a hard assertion.`);
  }
}

function makePinned(flagGetter: () => boolean, name: string) {
  return function pinned(actualIsCorrect: boolean, label: string, detail?: unknown) {
    if (flagGetter()) return ok(actualIsCorrect, label, detail);
    if (!actualIsCorrect) {
      knownDefects++;
      console.log(`  ⚠ KNOWN DEFECT — ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`);
    } else {
      failures++;
      console.log(`  ✗ ${label} now PASSES — the defect appears fixed. Set ${name} = true so this becomes a hard assertion.`);
    }
  };
}
const pinnedDateDefect = makePinned(() => DATE_INPUT_HARDENED, 'DATE_INPUT_HARDENED');
const pinnedJobLineDefect = makePinned(() => JOB_LINES_PROTECTED, 'JOB_LINES_PROTECTED');
const pinnedAttachmentDefect = makePinned(() => ATTACHMENTS_PERSISTED, 'ATTACHMENTS_PERSISTED');

async function reset() {
  await pool.query(`TRUNCATE TABLE rel_payments, rel_invoice_line_items, rel_invoices, rel_job_line_items,
    rel_jobs, rel_quote_line_items, rel_quotes, rel_credit_notes, rel_inventory_items, rel_customers
    RESTART IDENTITY CASCADE`);
  await pool.query(`DELETE FROM document_number_counters`);
  await pool.query(`DELETE FROM quote_conversions`);
}

// ── the shipped payload shapes ──────────────────────────────────────────────
/** A quote line exactly as the form holds it (index.html addLine ~6686). */
function formLine(over: any = {}) {
  return { id: 1, itemId: null, desc: '', qty: 1, pQty: 1, unit: '', unitPrice: 0, subtotal: 0, sqmL: '', sqmW: '', ...over };
}
/** The form's own line subtotal rule (index.html ~6753). */
function formLineSubtotal(l: any) {
  return (parseFloat(l.pQty) || 1) * (parseFloat(l.qty) || 0) * (parseFloat(l.unitPrice) || 0);
}
/** EXACTLY what CreateQuoteModal.submit sends. Pinned by TEST P1. */
function createPayloadLines(lines: any[]) {
  return lines.map((l) => ({
    description: l.desc || '', qty: parseFloat(l.qty) || 0,
    unitPrice: parseFloat(l.unitPrice) || 0, unit: l.unit || null, inventoryItemId: l.itemId || null,
    sqmL: l.sqmL === '' || l.sqmL === undefined ? null : l.sqmL,
    sqmW: l.sqmW === '' || l.sqmW === undefined ? null : l.sqmW,
    pieces: l.pQty === '' || l.pQty === undefined ? null : l.pQty,
    cpId: l.cpId ?? null, cpLinked: l.cpLinked ?? null,
  }));
}
/** EXACTLY what QuotesPage.handleSave sends on edit. Pinned by TEST P2. */
function editPatchLines(lines: any[]) {
  return lines.map((l) => ({
    desc: l.desc || '', qty: l.qty, unitPrice: l.unitPrice, unit: l.unit, itemId: l.itemId,
    sqmL: l.sqmL === '' || l.sqmL === undefined ? null : l.sqmL,
    sqmW: l.sqmW === '' || l.sqmW === undefined ? null : l.sqmW,
    pieces: l.pQty === '' || l.pQty === undefined ? null : l.pQty,
    cpId: l.cpId ?? null, cpLinked: l.cpLinked ?? null,
  }));
}

const FULL_QUOTE = {
  companyCode: '2', customerNameRaw: 'Full Field Signage CC',
  contactPerson: 'Thandi Mokoena', email: 'thandi@acme.example', phone: '021 555 0101',
  address: '14 Voortrekker Rd, Bellville', vatNumber: '4123456789', terms: 'Net 30, 50% deposit',
  salesperson: 'Ockert Smit', preparedBy: 'Sales Assistant', poRef: 'PO-ACME-8891',
  reference: 'ACME REBRAND PHASE 2', quoteDate: '2026-08-01', validUntil: '2026-09-01',
  notes: 'Install after hours. Access via loading bay.',
};

async function main() {
  console.log('\n════ QUOTE CREATION / SAVE RELIABILITY — AUDIT SUITE ════');

  // ── TEST A — FULL-FIELD NEW QUOTE ────────────────────────────────────────
  console.log('\n[A] full-field new Quote survives a completely fresh authoritative read');
  {
    await reset();
    const invA = await services.createInventoryItem({ name: 'Alu composite 3mm', unit: 'm²', unitCost: 450, stock: 60 } as any);
    const invB = await services.createInventoryItem({ name: 'Vinyl print', unit: 'm²', unitCost: 180, stock: 200 } as any);
    const l1 = formLine({ itemId: String(invA.id), desc: 'Fascia panel', unit: 'm²', qty: 3, unitPrice: 450 });
    const l2 = formLine({ id: 2, itemId: String(invB.id), desc: 'Printed vinyl overlay', unit: 'm²', qty: 3, unitPrice: 180 });
    const l3 = formLine({ id: 3, itemId: null, desc: 'Site survey and setout (free text)', unit: 'unit', qty: 1, unitPrice: 850 });
    for (const l of [l1, l2, l3]) l.subtotal = formLineSubtotal(l);

    const created = await services.createQuote({
      ...FULL_QUOTE, discountPct: 7.5, setupFee: 1200, lines: createPayloadLines([l1, l2, l3]),
    } as any);
    ok(!!created.id && /^SQ-\d+$/.test(created.quoteNumber) && created.rowVersion === 1,
      'A1 the quote is created with a reserved number and rowVersion 1', created);

    const q = (await buildQuotesJson())[0];
    const expect: Record<string, any> = {
      client: FULL_QUOTE.customerNameRaw, contact: FULL_QUOTE.contactPerson, email: FULL_QUOTE.email,
      tel: FULL_QUOTE.phone, address: FULL_QUOTE.address, vatNum: FULL_QUOTE.vatNumber,
      salesperson: FULL_QUOTE.salesperson, preparedBy: FULL_QUOTE.preparedBy, poRef: FULL_QUOTE.poRef,
      reference: FULL_QUOTE.reference, notes: FULL_QUOTE.notes,
      date: FULL_QUOTE.quoteDate, validUntil: FULL_QUOTE.validUntil, co: 2,
      setupFee: 1200, discount: 7.5,
    };
    const wrong = Object.keys(expect).filter((k) => String(q[k]) !== String(expect[k]));
    ok(wrong.length === 0, 'A2 EVERY header field survives a fresh read',
      wrong.map((k) => `${k}: got ${JSON.stringify(q[k])}, want ${JSON.stringify(expect[k])}`));
    ok(q.lines.length === 3, 'A3 all three lines survive', q.lines.length);
    ok(q.lines[0].desc === 'Fascia panel' && q.lines[2].desc.indexOf('free text') !== -1,
      'A4 descriptions survive, inventory-backed and free-text alike');
    ok(q.lines.every((l: any) => l.unit), 'A5 units survive on every line', q.lines.map((l: any) => l.unit));
    ok(String(q.lines[0].itemId) === String(invA.id) && q.lines[2].itemId == null,
      'A6 inventory identity survives, and a free-text line stays unlinked',
      { a: q.lines[0].itemId, c: q.lines[2].itemId });
    ok(q._relRowVersion === 1 && q._relId === created.id, 'A7 the read carries _relId/_relRowVersion for the next edit');
    ok(q.terms === FULL_QUOTE.terms, 'A8 `terms` round-trips too when supplied', q.terms);
    // Documented, not a defect: the Quote form has no separate Terms input —
    // its "Additional Terms (optional)" textarea writes to `notes`, which IS
    // sent and IS asserted above. The column simply has no UI of its own.
    const createPayload = HTML.slice(HTML.indexOf('const result = await relationalApi.createQuote({'),
      HTML.indexOf('const result = await relationalApi.createQuote({') + 900);
    ok(createPayload.indexOf('terms') === -1,
      'A9 (documented) the shipped create payload sends no `terms` — the form collects it as `notes` instead');
  }

  // ── TEST B — DIMENSIONS AND PIECES ───────────────────────────────────────
  console.log('\n[B] dimensioned / multi-piece lines — the value the customer is quoted');
  {
    await reset();
    const inv = await services.createInventoryItem({ name: 'Perspex 5mm', unit: 'm²', unitCost: 250, stock: 40 } as any);
    // 2000 x 1000 mm = 2 m², THREE pieces, R250/m². On screen: R1 500.
    const dim = formLine({ itemId: String(inv.id), desc: 'Perspex panel', unit: 'm²', sqmL: '2000', sqmW: '1000', pQty: 3, qty: 2, unitPrice: 250 });
    dim.subtotal = formLineSubtotal(dim);
    const plain = formLine({ id: 2, desc: 'Delivery', unit: 'unit', qty: 1, unitPrice: 800 });
    plain.subtotal = formLineSubtotal(plain);
    ok(dim.subtotal === 1500 && plain.subtotal === 800, 'B1 the FORM computes pQty x qty x unitPrice', { dim: dim.subtotal });

    const created = await services.createQuote({
      ...FULL_QUOTE, discountPct: 0, setupFee: 0, lines: createPayloadLines([dim, plain]),
    } as any);
    const q = (await buildQuotesJson())[0];

    pinnedDefect(Number(q.lines[0].sqmL) === 2000, 'B2 line dimensions (sqmL) survive the save', q.lines[0]);
    pinnedDefect(Number(q.lines[0].sqmW) === 1000, 'B3 line dimensions (sqmW) survive the save', q.lines[0]);
    pinnedDefect(Number(q.lines[0].pQty) === 3, 'B4 the piece count (pQty) survives the save', q.lines[0]);
    pinnedDefect(Number(q.lines[0].subtotal) === 1500,
      'B5 the stored line subtotal matches what the customer was quoted',
      { onScreen: 1500, stored: Number(q.lines[0].subtotal) });
    const row = await pool.query('SELECT subtotal, vat_amount, total FROM rel_quotes WHERE id=$1', [created.id]);
    const formSub = dim.subtotal + plain.subtotal;   // 2300
    pinnedDefect(Number(row.rows[0].subtotal) === formSub,
      'B6 the stored quote subtotal matches the form',
      { onScreen: formSub, stored: Number(row.rows[0].subtotal) });
    pinnedDefect(Math.abs(Number(row.rows[0].total) - formSub * 1.15) < 0.01,
      'B7 the stored TOTAL matches the form',
      { onScreen: +(formSub * 1.15).toFixed(2), stored: Number(row.rows[0].total),
        understatedBy: +(formSub * 1.15 - Number(row.rows[0].total)).toFixed(2) });
    // A line with no dimensions and one piece is unaffected — proving the
    // defect is scoped to pQty>1 / dimensioned lines, not to quotes generally.
    ok(Number(q.lines[1].subtotal) === 800, 'B8 a plain single-piece line is stored EXACTLY right', q.lines[1].subtotal);
  }

  // ── TEST C — EDITING DESTROYS HISTORICAL DIMENSIONS ──────────────────────
  console.log('\n[C] editing a BACKFILLED quote whose dimensions live only in legacy_data');
  {
    await reset();
    const inv = await services.createInventoryItem({ name: 'Panel', unit: 'm²', unitCost: 250, stock: 10 } as any);
    const line = formLine({ itemId: String(inv.id), desc: 'Historic panel', unit: 'm²', qty: 2, unitPrice: 250 });
    const created = await services.createQuote({ ...FULL_QUOTE, discountPct: 0, setupFee: 0, lines: createPayloadLines([line]) } as any);
    // Exactly what backfill leaves behind for a historical dimensioned line:
    // the modelled columns are NULL (013 does not retro-populate) and the
    // values exist only inside legacy_data.
    await pool.query(
      `UPDATE rel_quote_line_items SET sqm_l = NULL, sqm_w = NULL, pieces = NULL, legacy_data = $1::jsonb
        WHERE quote_id = $2 AND line_index = 0`,
      [JSON.stringify({ sqmL: '2000', sqmW: '1000', pQty: 3 }), created.id]);
    const before = (await buildQuotesJson())[0];
    ok(Number(before.lines[0].sqmL) === 2000 && Number(before.lines[0].pQty) === 3,
      'C1 a backfilled line DOES hydrate its dimensions today (they are the only copy)', before.lines[0]);

    // The app resends what it HYDRATED (QuotesPage.handleSave maps q.lines),
    // so the legacy values come back down and are written into the real
    // columns — which is what makes the first edit non-destructive.
    await services.updateQuote(before._relId, before._relRowVersion, {
      lines: editPatchLines([{ ...before.lines[0], desc: 'Historic panel (edited)' }]),
    } as any);
    const after = (await buildQuotesJson())[0];
    ok(after.lines[0].desc === 'Historic panel (edited)', 'C2 the edit itself applies');
    pinnedDefect(Number(after.lines[0].sqmL) === 2000 && Number(after.lines[0].pQty) === 3,
      'C3 a plain edit does not destroy the historical dimensions — they are promoted into real columns',
      after.lines[0]);
    const promoted = await pool.query(
      'SELECT sqm_l, sqm_w, pieces FROM rel_quote_line_items WHERE quote_id=$1 AND line_index=0', [before._relId]);
    ok(Number(promoted.rows[0].sqm_l) === 2000 && Number(promoted.rows[0].pieces) === 3,
      'C4 …and they now live in the modelled columns, not only in legacy_data', promoted.rows[0]);
    const subAfter = await pool.query('SELECT subtotal, total FROM rel_quotes WHERE id=$1', [before._relId]);
    ok(Number(subAfter.rows[0].subtotal) === 3 * 2 * 250,
      'C5 …so the edit no longer silently reprices the quote', Number(subAfter.rows[0].subtotal));
  }

  // ── TEST D — INVENTORY FK (the original 23503 / "Internal error") ────────
  console.log('\n[D] inventory FK — the exact failure that produced "Internal error"');
  {
    await reset();
    const backfilled = await services.createInventoryItem({ name: 'Backfilled item', unit: 'unit', unitCost: 10, stock: 5 } as any);
    // A historical JS id: timestamp-derived, far outside any real PK.
    await pool.query(`UPDATE rel_inventory_items SET source_id='1755123456789.123' WHERE id=$1`, [backfilled.id]);
    const fresh = await services.createInventoryItem({ name: 'Fresh item', unit: 'unit', unitCost: 20, stock: 5 } as any);

    // A — the exact old failure: the FRONTEND id (source id) into a BIGINT FK.
    const qa = await services.createQuote({ ...FULL_QUOTE, discountPct: 0, setupFee: 0,
      lines: createPayloadLines([formLine({ itemId: '1755123456789.123', desc: 'Backfilled line', qty: 1, unitPrice: 100 })]) } as any);
    const ra = await pool.query('SELECT inventory_item_id, inventory_source_id FROM rel_quote_line_items WHERE quote_id=$1', [qa.id]);
    ok(Number(ra.rows[0].inventory_item_id) === Number(backfilled.id),
      'D1 a historical/source inventory id resolves to the correct relational PK — no FK 23503', ra.rows[0]);
    ok(ra.rows[0].inventory_source_id === '1755123456789.123',
      'D2 …and the source identity is preserved alongside it', ra.rows[0].inventory_source_id);

    // B — a natively relational item.
    const qb = await services.createQuote({ ...FULL_QUOTE, discountPct: 0, setupFee: 0,
      lines: createPayloadLines([formLine({ itemId: String(fresh.id), desc: 'Relational line', qty: 1, unitPrice: 100 })]) } as any);
    const rb = await pool.query('SELECT inventory_item_id FROM rel_quote_line_items WHERE quote_id=$1', [qb.id]);
    ok(Number(rb.rows[0].inventory_item_id) === Number(fresh.id), 'D3 a relational inventory PK resolves to itself', rb.rows[0]);

    // C — invalid references must NOT 500, and must not lose the breadcrumb.
    for (const [label, bad] of [['oversized 21-digit id', '999999999999999999999'],
      ['nonexistent numeric id', '424242'], ['garbage text id', 'not-an-id']] as [string, string][]) {
      let err: Error | null = null; let qid: any = null;
      try {
        const qc = await services.createQuote({ ...FULL_QUOTE, discountPct: 0, setupFee: 0,
          lines: createPayloadLines([formLine({ itemId: bad, desc: 'Invalid ref', qty: 1, unitPrice: 100 })]) } as any);
        qid = qc.id;
      } catch (e) { err = e as Error; }
      ok(err === null, `D4 an ${label} does not raise a database error`, err && err.message);
      if (qid) {
        const rc = await pool.query('SELECT inventory_item_id, inventory_source_id FROM rel_quote_line_items WHERE quote_id=$1', [qid]);
        ok(rc.rows[0].inventory_item_id === null && rc.rows[0].inventory_source_id === bad,
          `D5 …the FK is left NULL and the ${label} is kept as a breadcrumb`, rc.rows[0]);
      }
    }
    const count = await pool.query('SELECT COUNT(*)::int c FROM rel_quotes');
    ok(count.rows[0].c === 5, 'D6 every one of those saves committed cleanly — no partial/corrupt quote', count.rows[0].c);
  }

  // ── TEST E — DATES (the original 22007) ─────────────────────────────────
  console.log('\n[E] dates — no empty string may reach a DATE column');
  {
    await reset();
    for (const [label, d, v] of [['valid', '2026-08-01', '2026-09-01'],
      ['empty string', '', ''], ['null', null, null], ['undefined', undefined, undefined]] as any[]) {
      let err: Error | null = null; let id: any = null;
      try {
        const qd = await services.createQuote({ ...FULL_QUOTE, quoteDate: d, validUntil: v, discountPct: 0, setupFee: 0,
          lines: createPayloadLines([formLine({ desc: 'x', qty: 1, unitPrice: 1 })]) } as any);
        id = qd.id;
      } catch (e) { err = e as Error; }
      ok(err === null, `E1 create with a ${label} date does not raise 22007`, err && err.message);
      if (id) {
        const r = await pool.query('SELECT quote_date, valid_until FROM rel_quotes WHERE id=$1', [id]);
        const want = label === 'valid';
        ok(want ? r.rows[0].quote_date !== null : r.rows[0].quote_date === null,
          `E2 …and stores ${want ? 'the date' : 'NULL'}`, r.rows[0].quote_date);
      }
    }
    const q = (await buildQuotesJson())[0];
    ok(q.date === '2026-08-01' && q.validUntil === '2026-09-01', 'E3 a valid date round-trips as YYYY-MM-DD', { d: q.date, v: q.validUntil });
    const u = await services.updateQuote(q._relId, q._relRowVersion, { quoteDate: '', validUntil: '' } as any);
    const cleared = (await buildQuotesJson()).find((x: any) => x._relId === q._relId);
    ok(cleared.date === null && cleared.validUntil === null,
      'E4 CLEARING a populated date persists as cleared, not as an error', { d: cleared.date, v: cleared.validUntil });
    ok(u.rowVersion === q._relRowVersion + 1, 'E5 …and the clearing edit bumps row_version normally');
  }

  // ── TEST F — ROW VERSION / CONCURRENCY ──────────────────────────────────
  console.log('\n[F] row_version — consecutive saves, and a genuine stale save');
  {
    await reset();
    const c = await services.createQuote({ ...FULL_QUOTE, discountPct: 0, setupFee: 0,
      lines: createPayloadLines([formLine({ desc: 'a', qty: 1, unitPrice: 100 })]) } as any);
    ok(c.rowVersion === 1, 'F1 a new quote starts at rowVersion 1', c.rowVersion);
    const u1 = await services.updateQuote(c.id, c.rowVersion, { notes: 'first' } as any);
    ok(u1.rowVersion === 2, 'F2 the first edit returns N+1', u1.rowVersion);
    const u2 = await services.updateQuote(c.id, u1.rowVersion, { notes: 'second' } as any);
    ok(u2.rowVersion === 3, 'F3 an IMMEDIATE second edit succeeds — no false stale conflict', u2.rowVersion);

    // Session A holds N while session B saves N+1.
    const sessionA = u1.rowVersion;
    await services.updateQuote(c.id, u2.rowVersion, { notes: 'session B' } as any);
    let conflict: Error | null = null;
    try { await services.updateQuote(c.id, sessionA, { notes: 'session A overwrite' } as any); }
    catch (e) { conflict = e as Error; }
    ok(conflict instanceof ConcurrencyConflictError,
      'F4 a genuinely stale save is rejected as a conflict, not an Internal error', conflict && conflict.constructor.name);
    const after = await pool.query('SELECT notes, row_version FROM rel_quotes WHERE id=$1', [c.id]);
    ok(after.rows[0].notes === 'session B',
      'F5 …and session B\'s save is NOT overwritten — no partial write from the rejected save', after.rows[0]);
    ok(after.rows[0].row_version === 4, 'F6 …and row_version did not move for the rejected save', after.rows[0].row_version);
    // The client must be able to retry from the fresh version.
    const retry = await services.updateQuote(c.id, after.rows[0].row_version, { notes: 'session A retry' } as any);
    ok(retry.rowVersion === 5, 'F7 retrying with the fresh version succeeds — recovery is safe', retry.rowVersion);
  }

  // ── TEST G — LINE ADD / EDIT / DELETE ───────────────────────────────────
  console.log('\n[G] quote lines — add, edit, delete, reorder, mixed');
  {
    await reset();
    const inv = await services.createInventoryItem({ name: 'Item', unit: 'unit', unitCost: 10, stock: 99 } as any);
    const a = formLine({ id: 1, itemId: String(inv.id), desc: 'A', unit: 'unit', qty: 1, unitPrice: 100 });
    const b = formLine({ id: 2, desc: 'B free text', unit: 'unit', qty: 2, unitPrice: 50 });
    const created = await services.createQuote({ ...FULL_QUOTE, discountPct: 0, setupFee: 0, lines: createPayloadLines([a, b]) } as any);
    let q = (await buildQuotesJson())[0];
    ok(q.lines.length === 2 && q.lines[0].desc === 'A' && q.lines[1].desc === 'B free text', 'G1 both lines persist in order');

    // add a third
    const cLine = formLine({ id: 3, desc: 'C added', unit: 'unit', qty: 3, unitPrice: 20 });
    await services.updateQuote(q._relId, q._relRowVersion, { lines: editPatchLines([a, b, cLine]) } as any);
    q = (await buildQuotesJson())[0];
    ok(q.lines.length === 3 && q.lines[2].desc === 'C added', 'G2 adding a line persists', q.lines.map((l: any) => l.desc));

    // edit the middle one's qty/rate
    const bEdited = { ...b, qty: 5, unitPrice: 60 };
    await services.updateQuote(q._relId, q._relRowVersion, { lines: editPatchLines([a, bEdited, cLine]) } as any);
    q = (await buildQuotesJson())[0];
    ok(Number(q.lines[1].qty) === 5 && Number(q.lines[1].unitPrice) === 60 && Number(q.lines[1].subtotal) === 300,
      'G3 editing quantity and rate persists, and the line subtotal follows', q.lines[1]);

    // delete the middle one
    await services.updateQuote(q._relId, q._relRowVersion, { lines: editPatchLines([a, cLine]) } as any);
    q = (await buildQuotesJson())[0];
    ok(q.lines.length === 2, 'G4 deleting a line persists', q.lines.map((l: any) => l.desc));
    ok(q.lines.every((l: any) => l.desc !== 'B free text'), 'G5 the deleted line does not come back');
    ok(q.lines[0].desc === 'A' && q.lines[1].desc === 'C added', 'G6 no unrelated line disappeared and none duplicated');

    // swap the inventory item on a line
    const inv2 = await services.createInventoryItem({ name: 'Item 2', unit: 'unit', unitCost: 30, stock: 9 } as any);
    await services.updateQuote(q._relId, q._relRowVersion, { lines: editPatchLines([{ ...a, itemId: String(inv2.id) }, cLine]) } as any);
    q = (await buildQuotesJson())[0];
    ok(String(q.lines[0].itemId) === String(inv2.id), 'G7 changing the inventory item on a line persists', q.lines[0].itemId);
    const orphan = await pool.query('SELECT COUNT(*)::int c FROM rel_quote_line_items WHERE quote_id <> $1', [q._relId]);
    ok(orphan.rows[0].c === 0, 'G8 no orphaned line rows are left behind by the delete/replace', orphan.rows[0].c);
  }

  // ── TEST H — FINANCIALS ─────────────────────────────────────────────────
  console.log('\n[H] financial consistency for ordinary (non-dimensioned) quotes');
  {
    await reset();
    const l1 = formLine({ desc: 'x', unit: 'unit', qty: 3, unitPrice: 133.33 });
    const l2 = formLine({ id: 2, desc: 'y', unit: 'unit', qty: 1, unitPrice: 0 });      // legitimate zero line
    for (const l of [l1, l2]) l.subtotal = formLineSubtotal(l);
    const created = await services.createQuote({ ...FULL_QUOTE, discountPct: 12.5, setupFee: 250, lines: createPayloadLines([l1, l2]) } as any);
    const r = await pool.query('SELECT subtotal, vat_amount, total, setup_fee, discount_pct FROM rel_quotes WHERE id=$1', [created.id]);
    const sub = 3 * 133.33;
    const afterDisc = sub - sub * 0.125 + 250;
    ok(Math.abs(Number(r.rows[0].subtotal) - sub) < 0.01, 'H1 subtotal = sum(qty x unitPrice)', { got: Number(r.rows[0].subtotal), want: sub });
    ok(Math.abs(Number(r.rows[0].vat_amount) - afterDisc * 0.15) < 0.01,
      'H2 VAT = 15% of (subtotal - discount + setup fee)', { got: Number(r.rows[0].vat_amount), want: +(afterDisc * 0.15).toFixed(2) });
    ok(Math.abs(Number(r.rows[0].total) - afterDisc * 1.15) < 0.01, 'H3 total = that, plus VAT', { got: Number(r.rows[0].total) });
    const q = (await buildQuotesJson())[0];
    ok(Number(q.subtotal) === Number(r.rows[0].subtotal) && Number(q.total) === Number(r.rows[0].total),
      'H4 the read layer reports exactly what the database holds — no second calculation');
    ok(Number(q.lines[1].subtotal) === 0, 'H5 a legitimate zero-value line is stored as zero, not dropped', q.lines[1]);
    ok(q.lines.length === 2, 'H6 …and the zero line still exists');
    // Fractional handling: 3 x 133.33 = 399.99 must not become 400.
    ok(Number(r.rows[0].subtotal) === 399.99, 'H7 fractional line values are not silently rounded', Number(r.rows[0].subtotal));
  }

  // ── TEST I — REFRESH PERSISTENCE / CLEARING OPTIONAL FIELDS ─────────────
  console.log('\n[I] refresh persistence, including clearing an optional field');
  {
    await reset();
    const created = await services.createQuote({ ...FULL_QUOTE, discountPct: 0, setupFee: 0,
      lines: createPayloadLines([formLine({ desc: 'x', qty: 1, unitPrice: 10 })]) } as any);
    const first = (await buildQuotesJson())[0];
    const second = (await buildQuotesJson())[0];
    ok(JSON.stringify(first) === JSON.stringify(second), 'I1 two independent authoritative reads are identical');
    await services.updateQuote(first._relId, first._relRowVersion, { poRef: '', reference: '', notes: '' } as any);
    const cleared = (await buildQuotesJson())[0];
    ok(cleared.poRef === '' && cleared.reference === '' && cleared.notes === '',
      'I2 cleared optional fields stay cleared after a fresh read — no legacy fallback resurrects them',
      { poRef: cleared.poRef, reference: cleared.reference, notes: cleared.notes });
    const legacy = await pool.query('SELECT legacy_data FROM rel_quotes WHERE id=$1', [created.id]);
    ok(JSON.stringify(legacy.rows[0].legacy_data) === '{}',
      'I3 a relationally-created quote carries no legacy_data that could shadow a cleared field', legacy.rows[0].legacy_data);
  }

  // ── TEST J — QUOTE -> JOB -> JOB CARD ───────────────────────────────────
  console.log('\n[J] quote -> job -> job card carryover');
  {
    await reset();
    const inv = await services.createInventoryItem({ name: 'Conv item', unit: 'm²', unitCost: 250, stock: 10 } as any);
    const line = formLine({ itemId: String(inv.id), desc: 'Panel', unit: 'm²', sqmL: '1000', sqmW: '500', pQty: 2, qty: 0.5, unitPrice: 250 });
    line.subtotal = formLineSubtotal(line);
    const cq = await services.createQuote({ ...FULL_QUOTE, status: 'approved', discountPct: 10, setupFee: 500,
      lines: createPayloadLines([line]) } as any);
    const conv = await services.convertQuoteToJob(cq.id);
    const job = (await buildJobsJson())[0];
    const carried: Record<string, any> = {
      client: FULL_QUOTE.customerNameRaw, contact: FULL_QUOTE.contactPerson, email: FULL_QUOTE.email,
      tel: FULL_QUOTE.phone, address: FULL_QUOTE.address, vatNum: FULL_QUOTE.vatNumber,
      salesperson: FULL_QUOTE.salesperson, preparedBy: FULL_QUOTE.preparedBy,
      poRef: FULL_QUOTE.poRef, reference: FULL_QUOTE.reference, notes: FULL_QUOTE.notes, co: 2,
      setupFee: 500, discount: 10,
    };
    const missing = Object.keys(carried).filter((k) => String(job[k]) !== String(carried[k]));
    ok(missing.length === 0, 'J1 every header field carries into the Job',
      missing.map((k) => `${k}: got ${JSON.stringify(job[k])}, want ${JSON.stringify(carried[k])}`));
    ok(!!conv.jobNumber && job.quoteNum === (await buildQuotesJson())[0].num,
      'J2 the job is linked back to its quote number', { quoteNum: job.quoteNum, jobNumber: conv.jobNumber });
    ok(job.lines.length === 1 && job.lines[0].desc === 'Panel' && job.lines[0].unit === 'm²',
      'J3 the line, its description and its unit carry into the Job Card', job.lines[0]);
    ok(String(job.lines[0].itemId) === String(inv.id), 'J4 inventory identity carries into the Job line', job.lines[0].itemId);
    pinnedDefect(Number(job.lines[0].sqmL) === 1000 && Number(job.lines[0].pQty) === 2,
      'J5 dimensions and pieces carry into the Job Card spec line', job.lines[0]);
    const q = (await buildQuotesJson())[0];
    ok(q.convertedJobId != null, 'J6 the quote records which job it became', q.convertedJobId);
    ok(q.status === 'converted', 'J7 …and its status moves to converted', q.status);
  }

  // ── TEST K — COMPANY ISOLATION ──────────────────────────────────────────
  console.log('\n[K] company isolation — Original (co=2) vs Holdings (co=1)');
  {
    await reset();
    const orig = await services.createQuote({ ...FULL_QUOTE, companyCode: '2', customerNameRaw: 'Original Co',
      discountPct: 0, setupFee: 0, lines: createPayloadLines([formLine({ desc: 'o', qty: 1, unitPrice: 10 })]) } as any);
    const hold = await services.createQuote({ ...FULL_QUOTE, companyCode: '1', customerNameRaw: 'Holdings Co',
      discountPct: 0, setupFee: 0, lines: createPayloadLines([formLine({ desc: 'h', qty: 1, unitPrice: 10 })]) } as any);
    const rows = await pool.query('SELECT id, company_code, quote_number FROM rel_quotes ORDER BY id');
    ok(rows.rows[0].company_code === '2' && rows.rows[1].company_code === '1',
      'K1 each quote stores its own company_code', rows.rows);
    ok(rows.rows[0].quote_number !== rows.rows[1].quote_number
      || rows.rows[0].company_code !== rows.rows[1].company_code,
      'K2 numbering is per company and the two never collide into one identity', rows.rows);
    const qs = await buildQuotesJson();
    ok(qs.find((x: any) => x._relId === orig.id).co === 2 && qs.find((x: any) => x._relId === hold.id).co === 1,
      'K3 the read layer reports each quote under its own company');
    // An edit must not be able to move a quote between companies.
    const before = qs.find((x: any) => x._relId === orig.id);
    await services.updateQuote(before._relId, before._relRowVersion, { customerNameRaw: 'Original Co renamed' } as any);
    const afterRow = await pool.query('SELECT company_code FROM rel_quotes WHERE id=$1', [orig.id]);
    ok(afterRow.rows[0].company_code === '2', 'K4 editing a quote cannot change its company ownership', afterRow.rows[0]);
    const svcSrc = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'relational', 'services.ts'), 'utf8');
    const patchIface = svcSrc.slice(svcSrc.indexOf('export interface QuotePatchInput'),
      svcSrc.indexOf('}', svcSrc.indexOf('export interface QuotePatchInput')));
    ok(patchIface.length > 0 && patchIface.indexOf('companyCode') === -1 && patchIface.indexOf('company_code') === -1,
      'K5 QuotePatchInput exposes no company field at all, so no edit can even attempt to move a quote', patchIface.length);
    const updateFn = svcSrc.slice(svcSrc.indexOf('export async function updateQuote('),
      svcSrc.indexOf('export async function updateQuote(') + 2500);
    ok(updateFn.indexOf('company_code') === -1,
      'K5b …and updateQuote never writes company_code');
  }

  // ── TEST L — FAILURE BEHAVIOUR / NO PARTIAL WRITES ──────────────────────
  console.log('\n[L] save failures leave nothing half-written');
  {
    await reset();
    const created = await services.createQuote({ ...FULL_QUOTE, discountPct: 0, setupFee: 0,
      lines: createPayloadLines([formLine({ desc: 'original', qty: 1, unitPrice: 100 })]) } as any);
    const q = (await buildQuotesJson())[0];

    // Stale version, WITH a line replacement in the same patch: the lines must
    // not be deleted by a save the version check is about to reject.
    let err: Error | null = null;
    try {
      await services.updateQuote(q._relId, q._relRowVersion + 9, {
        notes: 'should not land',
        lines: editPatchLines([formLine({ desc: 'replacement', qty: 9, unitPrice: 9 })]),
      } as any);
    } catch (e) { err = e as Error; }
    ok(err instanceof ConcurrencyConflictError, 'L1 a stale save is refused', err && err.constructor.name);
    const after = (await buildQuotesJson())[0];
    ok(after.notes === FULL_QUOTE.notes, 'L2 …the header is untouched', after.notes);
    ok(after.lines.length === 1 && after.lines[0].desc === 'original',
      'L3 …and the ORIGINAL lines are still there — the rejected save deleted nothing', after.lines);
    ok(after._relRowVersion === q._relRowVersion, 'L4 …and row_version did not move');

    // Updating a quote that does not exist.
    let missing: Error | null = null;
    try { await services.updateQuote(999999, 1, { notes: 'x' } as any); } catch (e) { missing = e as Error; }
    ok(missing instanceof BusinessRuleError && /not found/.test(missing.message),
      'L5 editing a nonexistent quote gives a clear business-rule error, not a 500', missing && missing.message);

    // A create that fails mid-way must leave NO quote behind.
    const beforeCount = (await pool.query('SELECT COUNT(*)::int c FROM rel_quotes')).rows[0].c;
    let createErr: Error | null = null;
    try {
      await services.createQuote({ ...FULL_QUOTE, companyCode: null as any, discountPct: 0, setupFee: 0,
        lines: createPayloadLines([formLine({ desc: 'x', qty: 1, unitPrice: 1 })]) } as any);
    } catch (e) { createErr = e as Error; }
    ok(createErr !== null, 'L6 an invalid create is rejected', createErr && createErr.message.slice(0, 80));
    const afterCount = (await pool.query('SELECT COUNT(*)::int c FROM rel_quotes')).rows[0].c;
    ok(afterCount === beforeCount, 'L7 …and rolls back completely — no orphaned quote row', { beforeCount, afterCount });
    const orphanLines = await pool.query(
      'SELECT COUNT(*)::int c FROM rel_quote_line_items l WHERE NOT EXISTS (SELECT 1 FROM rel_quotes q WHERE q.id = l.quote_id)');
    ok(orphanLines.rows[0].c === 0, 'L8 …and no orphaned line rows', orphanLines.rows[0].c);
  }

  // ── TEST M — NO LEGACY platform_state SAVE ON THE QUOTE PATH ────────────
  console.log('\n[M] a relational Quote save never triggers a platform_state save');
  {
    const createBranch = HTML.slice(HTML.indexOf('const result = await relationalApi.createQuote({'),
      HTML.indexOf('const result = await relationalApi.createQuote({') + 2500);
    ok(createBranch.indexOf('forceSaveSections') === -1 && createBranch.indexOf('saveToServer') === -1,
      'M1 the relational CREATE branch contains no legacy save call');
    const editStart = HTML.indexOf('const result = await relationalApi.updateQuote(q._relId, q._relRowVersion, patch);');
    const editBranch = HTML.slice(editStart - 2500, editStart + 4000);
    ok(editBranch.indexOf('forceSaveSections') === -1 && editBranch.indexOf('saveToServer') === -1,
      'M2 the relational EDIT branch contains no legacy save call');
    ok(HTML.indexOf('function assertNoUnwiredRelationalSections(sectionNames, contextLabel)') !== -1
      && HTML.indexOf('is not yet wired to relational persistence, and this section is now relational-authoritative') !== -1,
      'M3 the guard that refuses a JSON save of a cut-over section is intact and unweakened');
    ok(HTML.indexOf("syncRelationalBaseline('quotes', quotesUpdater)") !== -1,
      'M4 the relational edit syncs the autosave baseline, so the diff cannot then emit a quotes save');
  }

  // ── TEST N — THE "INTERNAL ERROR" IS NOT ACTUALLY CLOSED ────────────────
  // Empty-string dates ARE handled (TEST E). But normalizeColumnValue maps only
  // '' and undefined, and createQuote uses `input.quoteDate || null` — anything
  // ELSE goes straight into $::date. That is reachable from the shipped UI with
  // no bad typing by the user at all: migration 012 did not retro-populate
  // quote_date, so read.ts serves a BACKFILLED quote's date from
  // legacyBase(r).date — an arbitrary historical JSON string. index.html:6620
  // loads it verbatim into form state, <input type="date"> renders blank but
  // KEEPS the bad string, and index.html:8994 sends `quoteDate: q.date||null`.
  // Open such a quote, press Save, get "Internal error".
  console.log('\n[N] a non-ISO date from a backfilled quote still produces an opaque database error');
  {
    await reset();
    const seeded = await services.createQuote({ ...FULL_QUOTE, discountPct: 0, setupFee: 0,
      lines: createPayloadLines([formLine({ desc: 'x', qty: 1, unitPrice: 10 })]) } as any);
    // Exactly what backfill leaves: the date lives only in legacy_data.
    await pool.query(`UPDATE rel_quotes SET quote_date = NULL, legacy_data = $1::jsonb WHERE id = $2`,
      [JSON.stringify({ date: '14/03/2025', validUntil: '' }), seeded.id]);
    const hydrated = (await buildQuotesJson())[0];
    ok(hydrated.date === '14/03/2025',
      'N1 a backfilled quote really does hydrate a non-ISO date string into the form', hydrated.date);

    let err: any = null;
    try {
      // The shipped edit patch, verbatim: quoteDate: q.date||null
      await services.updateQuote(hydrated._relId, hydrated._relRowVersion, { quoteDate: hydrated.date } as any);
    } catch (e) { err = e; }
    ok(err instanceof BusinessRuleError,
      'N2 saving that quote is REFUSED as a readable business rule, not a raw database error',
      err && { type: err.constructor.name, code: err.code, message: String(err.message).slice(0, 110) });
    ok(err && /not a valid date/i.test(err.message) && /select the date again/i.test(err.message),
      'N3 …and the message tells the user exactly what to do', err && err.message);
    ok(err && !/22008|22007|syntax|::date/i.test(err.message),
      'N3b …with no raw Postgres detail leaking into it', err && err.message);
    const still = (await buildQuotesJson())[0];
    ok(still._relRowVersion === hydrated._relRowVersion,
      'N4 …the failed save wrote nothing (row_version unmoved), so the draft is recoverable', still._relRowVersion);

    // Other unmapped raw-Postgres inputs reachable from the live form.
    for (const [label, patch] of [
      ['a fat-fingered discount of 1000%', { discountPct: 1000 }],
      ['a whitespace-only date', { quoteDate: '   ' }],
      ['an out-of-range unit price', { lines: [{ desc: 'x', qty: 1, unitPrice: 1e13, unit: null, itemId: null }] }],
    ] as [string, any][]) {
      const q2 = (await buildQuotesJson())[0];
      let e2: any = null;
      try { await services.updateQuote(q2._relId, q2._relRowVersion, patch); } catch (e) { e2 = e; }
      const mapped = e2 instanceof ConcurrencyConflictError || e2 instanceof BusinessRuleError;
      ok(e2 === null || mapped,
        `N5 ${label} gives a meaningful error, not an opaque 500`,
        e2 && { code: e2.code, message: String(e2.message).slice(0, 100) });
    }
    // A missing customer FK — the SAME 23503 class, on a different column.
    let e3: any = null;
    try {
      await services.createQuote({ ...FULL_QUOTE, customerId: 987654321, discountPct: 0, setupFee: 0,
        lines: createPayloadLines([formLine({ desc: 'x', qty: 1, unitPrice: 1 })]) } as any);
    } catch (e) { e3 = e; }
    ok(e3 instanceof BusinessRuleError && /no longer exists/i.test(e3.message),
      'N6 a customerId pointing at a missing customer gives a meaningful error, not FK 23503 as a 500',
      e3 && { type: e3.constructor.name, message: String(e3.message).slice(0, 100) });
  }

  // ── TEST O — A QUOTE EDIT REWRITES THE JOB'S OWN LINE ITEMS ─────────────
  console.log('\n[O] editing a quote overwrites production line items added on the Job');
  {
    await reset();
    const inv = await services.createInventoryItem({ name: 'Item', unit: 'unit', unitCost: 10, stock: 99 } as any);
    const qline = formLine({ itemId: String(inv.id), desc: 'Quoted sign', unit: 'unit', qty: 1, unitPrice: 1000 });
    const cq = await services.createQuote({ ...FULL_QUOTE, status: 'approved', discountPct: 0, setupFee: 0,
      lines: createPayloadLines([qline]) } as any);
    await services.convertQuoteToJob(cq.id);
    let job = (await buildJobsJson())[0];

    // The shop floor adds two production lines on the JOB.
    await services.updateJob(job._relId, job._relRowVersion, {
      lines: [
        { desc: 'Quoted sign', qty: 1, unitPrice: 1000, unit: 'unit', itemId: String(inv.id) },
        { desc: 'PRODUCTION: extra bracket set', qty: 1, unitPrice: 300, unit: 'unit', itemId: null },
        { desc: 'PRODUCTION: site survey', qty: 1, unitPrice: 200, unit: 'unit', itemId: null },
      ],
    } as any);
    job = (await buildJobsJson())[0];
    ok(job.lines.length === 3, 'O1 the job carries its own production lines', job.lines.map((l: any) => l.desc));
    ok(/updateQuoteWithJobSync\(id, expectedVersion, patch/.test(
        fs.readFileSync(path.resolve(__dirname, '..', 'src', 'relational', 'api.ts'), 'utf8')),
      'O1b …and PUT /quotes/:id really does route through updateQuoteWithJobSync');

    // Now someone corrects a PHONE NUMBER on the quote. The shipped edit patch
    // ALWAYS resends `lines` (index.html:8996 is unconditional).
    const q = (await buildQuotesJson())[0];
    // PUT /quotes/:id calls updateQuoteWithJobSync (api.ts:169), NOT updateQuote —
    // the job-line cascade only exists there, so this must take the real route.
    await services.updateQuoteWithJobSync(q._relId, q._relRowVersion, {
      phone: '021 999 8888', lines: editPatchLines([qline]),
    } as any, {} as any);
    job = (await buildJobsJson())[0];
    pinnedJobLineDefect(job.lines.length === 3,
      'O2 a phone-number-only quote edit does NOT delete the job\'s production lines',
      { before: 3, after: job.lines.length, remaining: job.lines.map((l: any) => l.desc) });
    // And with no expectedJobVersion supplied the job's version check is skipped
    // entirely, so this happens with no conflict raised at all.
    ok(HTML.indexOf('if(linkedJob && linkedJob._relRowVersion !== undefined) patch.expectedJobVersion = linkedJob._relRowVersion;') !== -1,
      'O3 the client only asserts the job version when it happens to have the job in local state');

    // O4 — the capability is PRESERVED, just no longer implicit. An explicit
    // caller can still push the quote's lines onto the job, and that path is
    // still concurrency-protected.
    const jq = (await buildQuotesJson())[0];
    let jj = (await buildJobsJson())[0];
    let staleResyncBlocked = false;
    try {
      await services.updateQuoteWithJobSync(jq._relId, jq._relRowVersion,
        { lines: editPatchLines([qline]) } as any,
        { expectedJobVersion: Number(jj._relRowVersion) - 1, resyncJobLines: true } as any);
    } catch (e) { staleResyncBlocked = e instanceof services.ConcurrencyConflictError; }
    ok(staleResyncBlocked, 'O4 an EXPLICIT resync still refuses a stale expectedJobVersion');
    jj = (await buildJobsJson())[0];
    ok(jj.lines.length === 3, 'O4b …and the refused resync rolled back — the production lines are all still there',
      jj.lines.map((l: any) => l.desc));

    await services.updateQuoteWithJobSync(jq._relId, jq._relRowVersion,
      { lines: editPatchLines([qline]) } as any,
      { expectedJobVersion: Number(jj._relRowVersion), resyncJobLines: true } as any);
    jj = (await buildJobsJson())[0];
    ok(jj.lines.length === 1 && jj.lines[0].desc === 'Quoted sign',
      'O5 an explicit resyncJobLines:true DOES replace the job\'s lines — the workflow exists, it is simply never inferred',
      jj.lines.map((l: any) => l.desc));

    // O6 — and no HTTP surface exposes that flag, so a client can never reach
    // it by accident: PUT /quotes/:id strips it before calling the service.
    // Comment lines are stripped first — prose about the flag must not be able
    // to satisfy (or defeat) a check about real code.
    const apiSrc = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'relational', 'api.ts'), 'utf8')
      .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ok(/resyncJobLines:\s*_rsjl/.test(apiSrc) && !/resyncJobLines:(?!\s*_rsjl)/.test(apiSrc),
      'O6 PUT /quotes/:id strips resyncJobLines and never forwards it — the destructive path is unreachable over HTTP');
    const svcSrcO = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'relational', 'services.ts'), 'utf8');
    ok(/if\s*\(finalLines\s*&&\s*opts\.resyncJobLines\s*===\s*true\)/.test(svcSrcO),
      'O7 the service guards the job-line replacement on an explicit strict-true flag, not on the mere presence of lines');
  }

  // ── TEST R — EVERY OTHER WHOLESALE LINE-REPLACEMENT CALLER ──────────────
  // Persisting the five line fields is only half the fix. `lines` is always a
  // WHOLESALE replacement, so ANY caller that omits a field erases it. Found
  // in the adversarial pass: three shipped callers still sent the old
  // five-field shape, and two of them wrote to job lines, which model the same
  // columns since migration 013.
  console.log('\n[R] every shipped caller that replaces lines wholesale carries all of them');
  {
    await reset();

    // R1 — the Complete-Product price cascade. This one is doubly important:
    // the fields it used to drop include cpId/cpLinked, i.e. the cascade
    // silently unlinked the very lines it exists to keep in step.
    const cpFn = extractFn(HTML, 'handleSave');
    const cascade = HTML.slice(HTML.indexOf('const linkedQuotes = (quotes||[]).filter'));
    const cascadePayload = cascade.slice(0, cascade.indexOf('relationalApi.updateQuote'));
    for (const f of ['sqmL:', 'sqmW:', 'pieces:', 'cpId:', 'cpLinked:']) {
      ok(cascadePayload.indexOf(f) !== -1,
        `R1 the Complete-Product price cascade sends ${f.replace(':', '')} — a wholesale replacement that omitted it would erase it`,
        cascadePayload.slice(-260));
    }
    ok(cpFn.length > 0, 'R1b (sanity) the cascade really lives inside a shipped handleSave');

    // R2 — its OPTIMISTIC local subtotal must agree with the server's formula,
    // or the screen shows one number and the database holds another until the
    // next refresh. `(l.qty||1)*price` disagreed twice over: it dropped the
    // piece count and turned a legitimate qty of 0 into 1.
    ok(HTML.indexOf('subtotal:(parseFloat(l.pQty)||1)*(parseFloat(l.qty)||0)*(parseFloat(updated.sellExVat)||0)') !== -1,
      'R2 the cascade\'s local subtotal uses the form/server formula (pieces x qty x price), not qty x price');
    ok(HTML.indexOf('subtotal:(l.qty||1)*updated.sellExVat') === -1,
      'R2b …and the old piece-count-dropping expression is gone from both branches');

    // R3/R4 — the two JOB-line writers. Job lines carry the same columns.
    const saveLinesFn = extractFn(HTML, 'saveLines');
    for (const f of ['sqmL:', 'sqmW:', 'pieces:', 'cpId:', 'cpLinked:']) {
      ok(saveLinesFn.indexOf(f) !== -1,
        `R3 the Job page's Scope of Work editor sends ${f.replace(':', '')}`, saveLinesFn.slice(-300));
    }
    const jobModal = HTML.slice(HTML.indexOf('lines: (updated.lines||[]).map('));
    const jobModalPayload = jobModal.slice(0, jobModal.indexOf('})),') + 4);
    for (const f of ['sqmL:', 'sqmW:', 'pieces:', 'cpId:', 'cpLinked:']) {
      ok(jobModalPayload.indexOf(f) !== -1,
        `R4 the job edit modal sends ${f.replace(':', '')}`, jobModalPayload);
    }

    // R5 — a REAL round trip through the Job path, not just a source pin.
    const rl = formLine({ desc: 'Panel', unit: 'm²', sqmL: 2000, sqmW: 1500, pQty: 3, qty: 3, unitPrice: 850, cpId: 1755000000001, cpLinked: true });
    const rq = await services.createQuote({ ...FULL_QUOTE, discountPct: 0, setupFee: 0,
      lines: createPayloadLines([rl]) } as any);
    await services.convertQuoteToJob(rq.id);
    let rjob = (await buildJobsJson())[0];
    ok(rjob.lines[0].pQty === 3 && rjob.lines[0].sqmL === 2000 && rjob.lines[0].cpLinked === true,
      'R5 conversion carries dimensions, pieces and the complete-product link onto the Job line', rjob.lines[0]);

    // The shop floor now edits that line the way the Job page does — same
    // payload shape the source pins above assert.
    const jobPatchLines = (rjob.lines || []).map((l: any) => ({
      desc: l.desc, qty: l.qty, unitPrice: l.unitPrice, unit: l.unit, itemId: l.itemId,
      sqmL: l.sqmL === '' || l.sqmL === undefined ? null : l.sqmL,
      sqmW: l.sqmW === '' || l.sqmW === undefined ? null : l.sqmW,
      pieces: l.pQty === '' || l.pQty === undefined ? null : l.pQty,
      cpId: l.cpId ?? null, cpLinked: l.cpLinked ?? null,
    }));
    jobPatchLines[0].desc = 'Panel (revised)';
    await services.updateJob(rjob._relId, rjob._relRowVersion, { lines: jobPatchLines } as any);
    rjob = (await buildJobsJson())[0];
    ok(rjob.lines[0].desc === 'Panel (revised)', 'R6 the Job line edit applied');
    ok(rjob.lines[0].pQty === 3 && rjob.lines[0].sqmL === 2000 && rjob.lines[0].sqmW === 1500,
      'R6b …and the dimensions and piece count SURVIVED it — the Job Card spec is intact', rjob.lines[0]);
    ok(rjob.lines[0].cpId === 1755000000001 && rjob.lines[0].cpLinked === true,
      'R6c …and the complete-product link survived, so the price cascade still matches this line', rjob.lines[0]);
    const rjobLineDb = await pool.query(
      'SELECT subtotal FROM rel_job_line_items WHERE job_id = (SELECT id FROM rel_jobs LIMIT 1)');
    ok(Math.abs(Number(rjobLineDb.rows[0].subtotal) - 3 * 3 * 850) < 0.01,
      'R6d …and the stored line subtotal still includes the piece count — the Job was not silently repriced to a third',
      rjobLineDb.rows[0].subtotal);

    // R7 — a job line with an impossible piece count is a sentence, not a 500.
    let rErr: any = null;
    try {
      await services.updateJob(rjob._relId, rjob._relRowVersion,
        { lines: [{ desc: 'x', qty: 1, unitPrice: 1, pieces: 10 ** 12 }] } as any);
    } catch (e) { rErr = e; }
    ok(rErr instanceof BusinessRuleError && /pieces/i.test(String(rErr.message)),
      'R7 an out-of-range piece count on a JOB line is refused as a readable rule, not a raw NUMERIC overflow',
      rErr && String(rErr.message).slice(0, 120));
  }

  // ── TEST Q — ATTACHMENTS AND OTHER LINE FIELDS ARE NEVER PERSISTED ──────
  console.log('\n[Q] quote attachments and complete-product line links');
  {
    await reset();
    const svcSrc = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'relational', 'services.ts'), 'utf8');
    const readSrc = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'relational', 'read.ts'), 'utf8');
    // OPTION B: attachments are whole base64 files. Rather than half-persist
    // them, the UI REFUSES the mutation and says so. Prove the block, not a
    // persistence that does not exist.
    ok(!/attachment/i.test(svcSrc) && !/attachment/i.test(readSrc),
      'Q1 the relational layer deliberately does not pretend to handle attachments');
    ok(HTML.indexOf('const quoteAttachmentsReadOnly = isRelationalAuthoritative(\'quotes\');') !== -1,
      'Q1b attachment mutation is gated on quotes being relational-authoritative');
    ok(HTML.indexOf('QUOTE_ATTACHMENTS_BLOCKED_REASON') !== -1
      && HTML.indexOf('would not actually be saved') !== -1,
      'Q1c …with a persistent, explicit explanation — never a silent no-op');
    const attachFn = extractFn(HTML, 'handleAttach');
    ok(attachFn.indexOf('if(quoteAttachmentsReadOnly){') !== -1 && attachFn.indexOf('return;') !== -1,
      'Q1d adding an attachment is refused before any file is read');
    const removeFn = extractFn(HTML, 'removeAttachment');
    ok(removeFn.indexOf('if(quoteAttachmentsReadOnly){') !== -1,
      'Q1e removing an attachment is refused too');
    ok(HTML.indexOf('📎 <strong>Attachments are read-only for now.</strong>') !== -1,
      'Q1f …and the panel states the limitation persistently, not just on click');
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'rel_quotes'`);
    ok(!cols.rows.some((r: any) => /attach/i.test(r.column_name)),
      'Q2 rel_quotes has no attachment column — which is exactly why mutation is blocked rather than faked',
      cols.rows.map((r: any) => r.column_name).filter((n: string) => /attach|legacy/i.test(n)));
    ok(HTML.indexOf('attachments,') !== -1,
      'Q3 …even though the Quote form collects them (formFields.attachments)');
    // A backfilled quote's attachments live in rel_quotes.legacy_data and DO
    // hydrate — so a removed one returns while a new one is lost.
    const created = await services.createQuote({ ...FULL_QUOTE, discountPct: 0, setupFee: 0,
      lines: createPayloadLines([formLine({ desc: 'x', qty: 1, unitPrice: 10 })]) } as any);
    await pool.query(`UPDATE rel_quotes SET legacy_data = $1::jsonb WHERE id=$2`,
      [JSON.stringify({ attachments: [{ name: 'artwork.pdf' }] }), created.id]);
    const q = (await buildQuotesJson())[0];
    ok(Array.isArray(q.attachments) && q.attachments.length === 1,
      'Q4 a BACKFILLED quote hydrates its attachments from legacy_data', q.attachments);
    await services.updateQuote(q._relId, q._relRowVersion, { notes: 'edited' } as any);
    const after = (await buildQuotesJson())[0];
    ok(Array.isArray(after.attachments) && after.attachments.length === 1,
      'Q5 a historical attachment is still readable after an unrelated edit — nothing was lost, and nothing was faked',
      after.attachments);
    // cpId / cpLinked / sizeText are dropped by the same patch mapping.
    ok(HTML.indexOf('cpLinked') !== -1 && HTML.indexOf("l.cpId===cp.id && l.cpLinked") !== -1,
      'Q6 complete-product line links (cpId/cpLinked) drive a real price cascade in the UI');
    ok(HTML.indexOf('cpId: l.cpId??null, cpLinked: l.cpLinked??null }))') !== -1,
      'Q7 …and the edit patch now sends cpId/cpLinked, so the cascade keeps matching after a save');
  }

  // ── TEST P — THE PAYLOAD SHAPES ARE THE SHIPPED ONES ────────────────────
  console.log('\n[P] the payloads this suite sends are the ones the app actually sends');
  {
    ok(HTML.indexOf("lines: lines.map(l=>({ description: l.desc||'', qty: parseFloat(l.qty)||0, unitPrice: parseFloat(l.unitPrice)||0, unit: l.unit||null, inventoryItemId: l.itemId||null,") !== -1
      && HTML.indexOf("pieces: l.pQty===''||l.pQty===undefined?null:l.pQty, cpId: l.cpId??null, cpLinked: l.cpLinked??null })),") !== -1,
      'P1 the CREATE payload line mapping is pinned to index.html, including the five migration-013 fields');
    // The count is 5 because `lines` is ALWAYS a wholesale replacement, so
    // every shipped caller must send the piece count or it erases it. The five
    // are: quote create, quote edit, the Complete-Product price cascade, the
    // job edit modal, and the Job page's Scope of Work editor (TEST R pins the
    // last three individually). A new caller added without it drops this to a
    // mismatch here rather than silently repricing lines in production.
    ok(HTML.indexOf("lines: (q.lines||[]).map(l=>({ desc: l.desc||'', qty: l.qty, unitPrice: l.unitPrice, unit: l.unit, itemId: l.itemId,") !== -1
      && (HTML.match(/pieces: l\.pQty===''\|\|l\.pQty===undefined\?null:l\.pQty/g) || []).length === 5,
      'P2 the EDIT patch sends the same five fields — and so does every other wholesale line-replacement caller',
      (HTML.match(/pieces: l\.pQty===''\|\|l\.pQty===undefined\?null:l\.pQty/g) || []).length);
    ok(HTML.indexOf("u.subtotal=(parseFloat(u.pQty)||1)*(parseFloat(u.qty)||0)*(parseFloat(u.unitPrice)||0);") !== -1,
      'P3 the FORM\'s own line-subtotal rule (pQty x qty x unitPrice) is pinned — this is what the customer is shown');
    ok(HTML.indexOf("const hasDim = l.sqmL && (l.unit==='m²'||l.unit==='m (linear)');") !== -1,
      'P4 the printed quote\'s spec line still depends on sqmL/unit');
    ok(HTML.indexOf("if(hasDim) return parseFloat(l.pQty)||1;") !== -1,
      'P5 the item COUNT for a dimensioned line still comes from pQty');
    // Scan EVERY migration, not just 007 — a column added by 008/012 would
    // otherwise be missed and this conclusion would be unfounded.
    const migDir = path.resolve(__dirname, '..', '..', 'database', 'migrations');
    const allMigrations = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql'))
      .map((f) => fs.readFileSync(path.join(migDir, f), 'utf8')).join('\n');
    const mig013 = fs.readFileSync(path.join(migDir, '013_quote_line_dimensions.sql'), 'utf8');
    ok(/sqm_l/.test(mig013) && /sqm_w/.test(mig013) && /pieces/.test(mig013)
      && /complete_product_source_id/.test(mig013) && /complete_product_linked/.test(mig013),
      'P6 migration 013 defines all five columns');
    const mig013Sql = mig013.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    ok(/ADD COLUMN IF NOT EXISTS/.test(mig013Sql)
      && !/\bDROP\b|\bDELETE\b|\bTRUNCATE\b|\bUPDATE\b|ALTER COLUMN|\bINSERT\b/i.test(mig013Sql),
      'P6b …and is additive, idempotent and non-destructive — no DROP/DELETE/TRUNCATE/UPDATE/INSERT/retype anywhere in its SQL');
    const statements = mig013Sql.split(';').map((x) => x.trim()).filter(Boolean);
    ok(statements.every((st) => /^ALTER TABLE .* ADD COLUMN IF NOT EXISTS /i.test(st) || /^COMMENT ON COLUMN /i.test(st)),
      'P6d …every statement is an ADD COLUMN IF NOT EXISTS or a COMMENT — nothing else', statements.length);
    ok(!/sqm|pieces|complete_product/i.test(allMigrations.replace(mig013, '')),
      'P6c …and no OTHER migration was touched to achieve it');
    // And confirm it against the LIVE schema, not just the DDL text.
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'rel_quote_line_items' ORDER BY column_name`);
    const names = cols.rows.map((r: any) => r.column_name);
    for (const col of ['sqm_l', 'sqm_w', 'pieces', 'complete_product_source_id', 'complete_product_linked']) {
      ok(names.indexOf(col) !== -1, `P7 rel_quote_line_items.${col} exists in the live schema`, names);
    }
    const jobCols = (await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'rel_job_line_items'`)).rows.map((r: any) => r.column_name);
    for (const col of ['sqm_l', 'sqm_w', 'pieces', 'complete_product_source_id', 'complete_product_linked']) {
      ok(jobCols.indexOf(col) !== -1, `P7b rel_job_line_items.${col} exists too — the Job Card reads the same spec`, jobCols);
    }
    const nullable = await pool.query(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_name IN ('rel_quote_line_items','rel_job_line_items')
          AND column_name IN ('sqm_l','sqm_w','pieces','complete_product_source_id','complete_product_linked')`);
    ok(nullable.rows.every((r: any) => r.is_nullable === 'YES' && r.column_default === null),
      'P7c …every new column is nullable with no default, so every historical row is untouched and still valid');
  }

  console.log(`\n──────── ${passed} passed, ${failures} failed, ${knownDefects} KNOWN DEFECT ────────`);
  if (knownDefects > 0) {
    console.log('\n  ⚠ The KNOWN DEFECT lines above are real, reproduced, unfixed behaviour.');
    console.log('    This suite exists to GATE a production Quote save, so it exits NON-ZERO');
    console.log('    while any of them stand — a gate that reports success with reproduced');
    console.log('    blockers is worse than no gate. Fix them, flip DIMENSIONS_PERSISTED /');
    console.log('    the matching constants, and this suite goes green on its own.\n');
  }
  await pool.end();
  process.exit(failures === 0 && knownDefects === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
