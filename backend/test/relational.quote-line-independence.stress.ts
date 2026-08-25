/**
 * relational.quote-line-independence.stress.ts
 * QUOTE EDIT LINE-LINKING REGRESSION (2026-08-25)
 *
 * THE LIVE SYMPTOM THIS PINS
 *   Open any relationally-hydrated Quote for editing, change ONE line's
 *   description, and every line's description changes. Same for the selected
 *   item, the qty, the price — every editable line field.
 *
 * WHY IT HAPPENS
 *   Every line control in CreateQuoteModal calls `updateLine(line.id, …)`, and
 *   updateLine targets its row with `if (l.id !== id) return l`. read.ts's
 *   buildQuotesJson / buildJobsJson never emitted an `id` for a line, so on a
 *   quote whose lines carry no legacy_data (i.e. any quote created or saved
 *   since cutover) every hydrated line has `id === undefined`. The guard then
 *   reads `undefined !== undefined` → false for EVERY row, so one keystroke
 *   rewrites all of them. `key={line.id}` collides for the same reason, and
 *   removeLine / moveLine / copyLine / activeLineId are hit identically.
 *
 * These tests run the REAL functions, extracted from index.html by source text
 * and executed — not a re-implementation — so they cannot pass while the
 * shipped code is broken.
 */
import * as path from 'path';
import * as fs from 'fs';
import pool from '../src/db/pool';
import * as services from '../src/relational/services';
import { buildQuotesJson, buildJobsJson } from '../src/relational/read';

const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH || path.resolve(__dirname, '..', '..', 'index.html');

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}
function money(n: unknown): number { return Math.round((Number(n) || 0) * 100) / 100; }
function eqMoney(a: unknown, b: unknown): boolean { return Math.abs(money(a) - money(b)) < 0.005; }

// ── extract the REAL implementation out of index.html ───────────────────────
/** Pulls `function <name>(…){ … }` out verbatim by brace-matching. */
function extractFn(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`could not find function ${name} in index.html`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces while extracting ${name}`);
}

interface LineHarness {
  updateLine(id: unknown, field: string, value: unknown): void;
  removeLine(id: unknown): void;
  moveLine(id: unknown, dir: number): void;
  copyLine(id: unknown): void;
  addLine(): void;
  withLineIdentity?(lines: any[]): any[];
  get(): any[];
}

/**
 * Builds a live harness around CreateQuoteModal's own line functions, with the
 * two closure values they need (`inventory`, `setLines`) supplied by the test.
 * If a function does not exist yet, it is simply absent from the harness — so a
 * test can assert its absence rather than crashing.
 */
function makeHarness(src: string, inventory: any[], initialLines: any[]): LineHarness {
  const names = ['updateLine', 'removeLine', 'moveLine', 'copyLine', 'addLine'];
  const bodies = names.map((n) => extractFn(src, n)).join('\n');
  // Helpers the mutators close over. Absent in the broken implementation, so
  // each is optional — the harness must be able to run BOTH versions.
  const optional = ['hasLineId', 'withLineIdentity'];
  const present: Record<string, boolean> = {};
  const helpers = optional.map((n) => {
    try { const s = extractFn(src, n); present[n] = true; return s; } catch { present[n] = false; return ''; }
  }).join('\n');
  const identityFn = helpers;
  const hasIdentity = present.withLineIdentity;
  // eslint-disable-next-line no-new-func
  const factory = new Function('inventory', 'initialLines', `
    let lines = initialLines;
    function setLines(u){ lines = (typeof u === 'function') ? u(lines) : u; }
    let activeLineId = null;
    function setActiveLineId(v){ activeLineId = v; }
    ${identityFn}
    ${bodies}
    return {
      updateLine, removeLine, moveLine, copyLine, addLine,
      ${hasIdentity ? 'withLineIdentity,' : ''}
      get: () => lines,
    };
  `);
  return factory(inventory, initialLines) as LineHarness;
}

/** Deep structural equality on a line, ignoring key order. */
function sameLine(a: any, b: any): boolean {
  const keys = Array.from(new Set([...Object.keys(a || {}), ...Object.keys(b || {})])).sort();
  return keys.every((k) => JSON.stringify(a?.[k]) === JSON.stringify(b?.[k]));
}
function snapshot(lines: any[]): string { return JSON.stringify(lines); }

/**
 * Runs one section. A BROKEN implementation does not merely return wrong
 * values — removeLine(undefined) empties the whole array, so the next line of
 * the test reads a property of undefined and throws. Without this, the suite
 * would abort mid-run and report far less than it found. A thrown section is
 * one loud failure and the run continues.
 */
async function section(label: string, fn: () => Promise<void> | void) {
  console.log(`\n${label}`);
  try { await fn(); }
  catch (err) { failures++; console.log(`  ✗ section threw: ${err instanceof Error ? err.message : String(err)}`); }
}

async function reset() {
  await pool.query(`
    TRUNCATE TABLE rel_payments, rel_invoice_line_items, rel_invoices, rel_job_line_items,
      rel_jobs, rel_quote_line_items, rel_quotes, rel_inventory_items, rel_customers
    RESTART IDENTITY CASCADE`);
  await pool.query(`DELETE FROM document_number_counters`);
  await pool.query(`DELETE FROM quote_conversions`);
  await pool.query(`UPDATE platform_state SET data = '{}'::jsonb WHERE id = 1`);
}

const THREE_LINES = [
  { description: 'AAA', qty: 1, unitPrice: 100, unit: 'ea', pieces: 1 },
  { description: 'BBB', qty: 2, unitPrice: 200, unit: 'ea', pieces: 1 },
  { description: 'CCC', qty: 3, unitPrice: 300, unit: 'ea', pieces: 1 },
];

async function makeQuote(lines = THREE_LINES, extra: Record<string, unknown> = {}) {
  const cust = await services.createCustomer({ companyName: 'Line Independence Co' });
  return services.createQuote({
    companyCode: '2', customerId: cust.id, customerNameRaw: 'Line Independence Co',
    lines: lines as any, ...extra,
  });
}

async function main() {
  const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  await reset();

  // ══ 1. HYDRATION — every line must arrive with a unique, defined identity ══
  console.log('\n[1] Hydration: authoritative read gives every quote line a distinct identity');
  const q1 = await makeQuote();
  {
    const hydrated = (await buildQuotesJson()).find((x: any) => x.id === q1.id || x.num === q1.quoteNumber)!;
    const L = hydrated.lines;
    ok(L.length === 3, 'the quote hydrates with its three lines', L.length);
    ok(L.every((l: any) => l.id !== undefined && l.id !== null && l.id !== ''),
      'EVERY hydrated line carries a defined id — this is the field whose absence made updateLine match all rows',
      L.map((l: any) => l.id));
    ok(new Set(L.map((l: any) => String(l.id))).size === L.length,
      'and those ids are unique across the quote', L.map((l: any) => l.id));
    // Object identity — no two rows may be the same object, nor share nested state.
    ok(L[0] !== L[1] && L[1] !== L[2] && L[0] !== L[2],
      'line[0] !== line[1] !== line[2] by object identity');
    L[0].desc = '__MUTATED__';
    ok(L[1].desc === 'BBB' && L[2].desc === 'CCC',
      'mutating one hydrated line in place leaves the others untouched — no shared object reference', [L[1].desc, L[2].desc]);
  }

  // Job lines have the identical editors (JobDetail's line editor and the job
  // invoice modal both key and target on l.id), so they need the same guarantee.
  await section('[1b] Hydration: job lines carry the same guarantee', async () => {
    const conv = await services.convertQuoteToJob(q1.id);
    const job = (await buildJobsJson()).find((j: any) => String(j.num) !== '')!;
    ok(job.lines.length === 3, 'the converted job hydrates with three lines', job.lines.length);
    ok(job.lines.every((l: any) => l.id !== undefined && l.id !== null && l.id !== ''),
      'every hydrated JOB line carries a defined id too', job.lines.map((l: any) => l.id));
    ok(new Set(job.lines.map((l: any) => String(l.id))).size === job.lines.length,
      'and they are unique', job.lines.map((l: any) => l.id));
    await pool.query('DELETE FROM rel_job_line_items WHERE job_id = $1', [conv.jobId]);
    await pool.query('DELETE FROM quote_conversions');
    await pool.query('UPDATE rel_quotes SET converted_job_id = NULL WHERE id = $1', [q1.id]);
    await pool.query('DELETE FROM rel_jobs WHERE id = $1', [conv.jobId]);
  });

  // ══ 2. THE EXACT LIVE SYMPTOM ════════════════════════════════════════════
  console.log('\n[2] THE REGRESSION: edit only line 2\'s description');
  {
    const hydrated = (await buildQuotesJson()).find((x: any) => x.num === q1.quoteNumber)!;
    const h = makeHarness(src, [], JSON.parse(JSON.stringify(hydrated.lines)));
    const before = h.get().map((l: any) => ({ ...l }));
    h.updateLine(before[1].id, 'desc', 'BBB EDITED');
    const after = h.get();
    ok(after.map((l: any) => l.desc).join(' / ') === 'AAA / BBB EDITED / CCC',
      'result is AAA / BBB EDITED / CCC — NOT BBB EDITED three times',
      after.map((l: any) => l.desc));
    ok(sameLine(after[0], before[0]), 'line 1 is byte-for-byte unchanged', { before: before[0], after: after[0] });
    ok(sameLine(after[2], before[2]), 'line 3 is byte-for-byte unchanged', { before: before[2], after: after[2] });
    ok(after[0] === before[0] || sameLine(after[0], before[0]), 'untouched rows are returned as-is by the map');
  }

  // ══ 3. EVERY EDITABLE FIELD, INDEPENDENTLY ═══════════════════════════════
  await section('[3] Every editable line field changes exactly one line', async () => {
    await pool.query(
      `INSERT INTO rel_inventory_items (source_id, sku, name, category, unit, cost, sell, stock_qty, reorder_level, legacy_data)
       VALUES ('inv-1','SKU1','Aluminium Composite','Sheet','m²',100,250,10,1,'{}'::jsonb),
              ('inv-2','SKU2','Cast Vinyl','Roll','m²',40,90,10,1,'{}'::jsonb)`);
    const inventory = [
      { id: 'inv-1', name: 'Aluminium Composite', unit: 'm²', sell: 250 },
      { id: 'inv-2', name: 'Cast Vinyl', unit: 'm²', sell: 90 },
    ];
    const hydrated = (await buildQuotesJson()).find((x: any) => x.num === q1.quoteNumber)!;

    const cases: Array<[string, string, unknown, (l: any) => boolean]> = [
      ['description', 'desc', 'CCC EDITED', (l) => l.desc === 'CCC EDITED'],
      ['product / item', 'itemId', 'inv-1', (l) => String(l.itemId) === 'inv-1' && l.desc === 'Aluminium Composite' && Number(l.unitPrice) === 250],
      ['quantity', 'qty', 9, (l) => Number(l.qty) === 9],
      ['pieces', 'pQty', 4, (l) => Number(l.pQty) === 4],
      ['unit price', 'unitPrice', 555, (l) => Number(l.unitPrice) === 555],
      ['unit', 'unit', 'm (linear)', (l) => l.unit === 'm (linear)'],
      ['dimension sqmL', 'sqmL', 2000, (l) => Number(l.sqmL) === 2000],
      ['dimension sqmW', 'sqmW', 1000, (l) => Number(l.sqmW) === 1000],
    ];
    for (const [label, field, value, verify] of cases) {
      const h = makeHarness(src, inventory, JSON.parse(JSON.stringify(hydrated.lines)));
      const before = h.get().map((l: any) => ({ ...l }));
      const targetIdx = 2; // always line 3, the one the brief names
      h.updateLine(before[targetIdx].id, field, value);
      const after = h.get();
      const targetOk = verify(after[targetIdx]);
      const othersOk = sameLine(after[0], before[0]) && sameLine(after[1], before[1]);
      ok(targetOk && othersOk, `${label}: line 3 changes, lines 1 and 2 byte-for-byte unchanged`,
        { target: after[targetIdx], line1Same: sameLine(after[0], before[0]), line2Same: sameLine(after[1], before[1]) });
    }
  });

  // ══ 4. FINANCIALS — pieces x qty x unitPrice, per line only ══════════════
  await section('[4] Financial recalculation stays per-line', async () => {
    const hydrated = (await buildQuotesJson()).find((x: any) => x.num === q1.quoteNumber)!;
    const h = makeHarness(src, [], JSON.parse(JSON.stringify(hydrated.lines)));
    const before = h.get().map((l: any) => ({ ...l }));
    h.updateLine(before[1].id, 'pQty', 3);
    const after = h.get();
    ok(eqMoney(after[1].subtotal, 3 * 2 * 200), 'the edited line recalculates as pieces x qty x unitPrice', after[1].subtotal);
    ok(eqMoney(after[0].subtotal, before[0].subtotal) && eqMoney(after[2].subtotal, before[2].subtotal),
      'the other lines\' subtotals are untouched', [after[0].subtotal, after[2].subtotal]);
    const subtotal = after.reduce((s: number, l: any) => s + (Number(l.subtotal) || 0), 0);
    ok(eqMoney(subtotal, 100 + 1200 + 900), 'the quote subtotal reflects only the one changed line', subtotal);
  });

  // ══ 5. ADVERSARIAL ═══════════════════════════════════════════════════════
  await section('[5] Adversarial: identity survives duplication, deletion, reordering', async () => {
    const inventory = [{ id: 'inv-1', name: 'Aluminium Composite', unit: 'm²', sell: 250 }];
    const hydrated = (await buildQuotesJson()).find((x: any) => x.num === q1.quoteNumber)!;

    // the SAME product on two lines, intentionally
    let h = makeHarness(src, inventory, JSON.parse(JSON.stringify(hydrated.lines)));
    let L = h.get();
    h.updateLine(L[0].id, 'itemId', 'inv-1');
    h.updateLine(L[1].id, 'itemId', 'inv-1');
    L = h.get();
    ok(String(L[0].itemId) === 'inv-1' && String(L[1].itemId) === 'inv-1' && L[2].desc === 'CCC',
      'the same product may appear on two lines while the third is untouched', L.map((l: any) => l.desc));
    h.updateLine(L[1].id, 'unitPrice', 999);
    L = h.get();
    ok(Number(L[0].unitPrice) === 250 && Number(L[1].unitPrice) === 999,
      'and those two same-product lines remain independently editable', [L[0].unitPrice, L[1].unitPrice]);

    // repeated descriptions must not merge identity
    h = makeHarness(src, inventory, JSON.parse(JSON.stringify(hydrated.lines)));
    L = h.get();
    h.updateLine(L[0].id, 'desc', 'SAME');
    h.updateLine(L[1].id, 'desc', 'SAME');
    h.updateLine(L[2].id, 'desc', 'SAME');
    L = h.get();
    h.updateLine(L[1].id, 'qty', 77);
    L = h.get();
    ok(Number(L[0].qty) === 1 && Number(L[1].qty) === 77 && Number(L[2].qty) === 3,
      'three identically-described lines stay independently addressable', L.map((l: any) => l.qty));

    // delete the middle line, then edit what remains
    h = makeHarness(src, inventory, JSON.parse(JSON.stringify(hydrated.lines)));
    L = h.get();
    h.removeLine(L[1].id);
    L = h.get();
    ok(L.length === 2 && L[0].desc === 'AAA' && L[1].desc === 'CCC',
      'removing the middle line removes exactly one line', L.map((l: any) => l.desc));
    h.updateLine(L[1].id, 'desc', 'CCC AFTER DELETE');
    L = h.get();
    ok(L[0].desc === 'AAA' && L[1].desc === 'CCC AFTER DELETE',
      'and the survivors are still independently editable', L.map((l: any) => l.desc));

    // add a new line after a deletion
    h.addLine();
    L = h.get();
    ok(L.length === 3 && new Set(L.map((l: any) => String(l.id))).size === 3,
      'a newly added line gets its own id, distinct from the hydrated ones', L.map((l: any) => l.id));
    h.updateLine(L[2].id, 'desc', 'BRAND NEW');
    L = h.get();
    ok(L[0].desc === 'AAA' && L[1].desc === 'CCC AFTER DELETE' && L[2].desc === 'BRAND NEW',
      'editing the new line leaves the hydrated ones alone', L.map((l: any) => l.desc));

    // copy a line — the copy must be independent of its source
    h = makeHarness(src, inventory, JSON.parse(JSON.stringify(hydrated.lines)));
    L = h.get();
    h.copyLine(L[0].id);
    L = h.get();
    ok(L.length === 4 && String(L[0].id) !== String(L[1].id) && L[1].desc === 'AAA',
      'a copied line is a distinct row with a distinct id', L.map((l: any) => l.id));
    h.updateLine(L[1].id, 'desc', 'COPY EDITED');
    L = h.get();
    ok(L[0].desc === 'AAA' && L[1].desc === 'COPY EDITED',
      'and editing the copy does not touch the original', [L[0].desc, L[1].desc]);

    // reorder
    h = makeHarness(src, inventory, JSON.parse(JSON.stringify(hydrated.lines)));
    L = h.get();
    h.moveLine(L[0].id, 1);
    L = h.get();
    ok(L.map((l: any) => l.desc).join('/') === 'BBB/AAA/CCC', 'moveLine reorders exactly two rows', L.map((l: any) => l.desc));
    h.updateLine(L[0].id, 'qty', 42);
    L = h.get();
    ok(Number(L[0].qty) === 42 && Number(L[1].qty) === 1 && Number(L[2].qty) === 3,
      'and identity still follows the row, not its position', L.map((l: any) => l.qty));

    // rapid sequential edits to two different lines
    h = makeHarness(src, inventory, JSON.parse(JSON.stringify(hydrated.lines)));
    L = h.get();
    for (let i = 0; i < 20; i++) { h.updateLine(L[0].id, 'qty', i); h.updateLine(L[2].id, 'unitPrice', 1000 + i); }
    L = h.get();
    ok(Number(L[0].qty) === 19 && Number(L[1].qty) === 2 && Number(L[2].unitPrice) === 1019,
      'twenty interleaved edits to lines 1 and 3 never touch line 2', L.map((l: any) => [l.qty, l.unitPrice]));
  });

  // ══ 6. HISTORICAL / BACKFILLED LINES ═════════════════════════════════════
  await section('[6] Historical lines: legacy ids honoured, NULL migration-013 fields safe', async () => {
    const qh = await makeQuote([
      { description: 'HIST-1', qty: 1, unitPrice: 10, unit: 'ea', pieces: 1 },
      { description: 'HIST-2', qty: 1, unitPrice: 20, unit: 'ea', pieces: 1 },
    ]);
    // A backfilled line: 013 columns NULL, original JSON line preserved in legacy_data.
    const rows = (await pool.query('SELECT id, line_index FROM rel_quote_line_items WHERE quote_id = $1 ORDER BY line_index', [qh.id])).rows;
    for (const r of rows) {
      await pool.query(
        `UPDATE rel_quote_line_items SET pieces = NULL, sqm_l = NULL, sqm_w = NULL, legacy_data = $2::jsonb WHERE id = $1`,
        [r.id, JSON.stringify({ id: 1755000000000 + Number(r.line_index), desc: `HIST-${Number(r.line_index) + 1}`, qty: 1 })]);
    }
    const hydrated = (await buildQuotesJson()).find((x: any) => x.num === qh.quoteNumber)!;
    ok(hydrated.lines.every((l: any) => l.id !== undefined && l.id !== null),
      'backfilled lines hydrate with an id', hydrated.lines.map((l: any) => l.id));
    ok(new Set(hydrated.lines.map((l: any) => String(l.id))).size === hydrated.lines.length,
      'and it is unique', hydrated.lines.map((l: any) => l.id));
    ok(hydrated.lines.every((l: any) => l.pQty === null || l.pQty === undefined),
      'their NULL migration-013 piece count still hydrates as absent (read as 1 by the pricing formula)',
      hydrated.lines.map((l: any) => l.pQty));
    const h = makeHarness(src, [], JSON.parse(JSON.stringify(hydrated.lines)));
    const before = h.get().map((l: any) => ({ ...l }));
    h.updateLine(before[0].id, 'desc', 'HIST-1 EDITED');
    const after = h.get();
    ok(after[0].desc === 'HIST-1 EDITED' && sameLine(after[1], before[1]),
      'editing a historical line leaves its sibling byte-for-byte unchanged', after.map((l: any) => l.desc));

    // Duplicate legacy ids must NOT be trusted as identity.
    for (const r of rows) {
      await pool.query(`UPDATE rel_quote_line_items SET legacy_data = $2::jsonb WHERE id = $1`,
        [r.id, JSON.stringify({ id: 999, desc: 'dup' })]);
    }
    const dup = (await buildQuotesJson()).find((x: any) => x.num === qh.quoteNumber)!;
    ok(new Set(dup.lines.map((l: any) => String(l.id))).size === dup.lines.length,
      'when two historical lines share an id, hydration falls back to a guaranteed-unique identity instead',
      dup.lines.map((l: any) => l.id));
  });

  // ══ 7. SAVE / FRESH READ ═════════════════════════════════════════════════
  await section('[7] Save the edited quote, read it back authoritatively', async () => {
    const q = await makeQuote();
    const hydrated = (await buildQuotesJson()).find((x: any) => x.num === q.quoteNumber)!;
    const h = makeHarness(src, [], JSON.parse(JSON.stringify(hydrated.lines)));
    let L = h.get();
    h.updateLine(L[1].id, 'desc', 'BBB EDITED');
    L = h.get();
    // Byte-for-byte the mapping index.html's quote EDIT path sends
    // (services.ts LineItemPatch: desc/qty/unitPrice/unit/itemId + the five
    // migration-013 fields) — NOT the create-path shape, which is a different
    // interface (QuoteLineInput: description/inventoryItemId).
    const patchLines = L.map((l: any) => ({
      desc: l.desc || '', qty: l.qty, unitPrice: l.unitPrice, unit: l.unit, itemId: l.itemId,
      sqmL: l.sqmL === '' || l.sqmL === undefined ? null : l.sqmL,
      sqmW: l.sqmW === '' || l.sqmW === undefined ? null : l.sqmW,
      pieces: l.pQty === '' || l.pQty === undefined ? null : l.pQty,
      cpId: l.cpId ?? null, cpLinked: l.cpLinked ?? null,
    }));
    const cur = (await pool.query('SELECT row_version FROM rel_quotes WHERE id = $1', [q.id])).rows[0];
    await services.updateQuote(q.id, cur.row_version, { lines: patchLines as any });
    const fresh = (await buildQuotesJson()).find((x: any) => x.num === q.quoteNumber)!;
    ok(fresh.lines.map((l: any) => l.desc).join(' / ') === 'AAA / BBB EDITED / CCC',
      'after a save and a fresh authoritative read: AAA / BBB EDITED / CCC', fresh.lines.map((l: any) => l.desc));
    ok(eqMoney(fresh.lines[0].subtotal, 100) && eqMoney(fresh.lines[1].subtotal, 400) && eqMoney(fresh.lines[2].subtotal, 900),
      'and every line still carries its own value', fresh.lines.map((l: any) => l.subtotal));
    ok(fresh.lines.every((l: any) => l.id !== undefined && l.id !== null) &&
       new Set(fresh.lines.map((l: any) => String(l.id))).size === 3,
      'the re-read lines are still uniquely identified, so the next edit is safe too', fresh.lines.map((l: any) => l.id));

    // ══ 8. QUOTE -> JOB ════════════════════════════════════════════════════
    console.log('\n[8] Quote -> Job keeps three distinct lines');
    const conv = await services.convertQuoteToJob(q.id);
    const job = (await buildJobsJson()).find((j: any) => String(j.quoteNum) === q.quoteNumber)!;
    ok(job.lines.length === 3, 'the job receives exactly three lines', job.lines.length);
    ok(job.lines.map((l: any) => l.desc).join(' / ') === 'AAA / BBB EDITED / CCC',
      'with the three distinct intended descriptions — no duplication, no all-identical', job.lines.map((l: any) => l.desc));
    ok(new Set(job.lines.map((l: any) => String(l.id))).size === 3, 'and three distinct line identities', job.lines.map((l: any) => l.id));
    const jobRow = (await pool.query('SELECT value FROM rel_jobs WHERE id = $1', [conv.jobId])).rows[0];
    ok(eqMoney(jobRow.value, (100 + 400 + 900) * 1.15), 'the job value is the quote total, unchanged by the repair', money(jobRow.value));
  });

  // ══ 9. CREATE PATH ═══════════════════════════════════════════════════════
  await section('[9] Create path (never hydrated) is unaffected', async () => {
    const fresh = [
      { id: 1, itemId: null, desc: 'AAA', qty: 1, pQty: 1, unit: '', unitPrice: 100, subtotal: 100, sqmL: '', sqmW: '' },
      { id: 2, itemId: null, desc: 'BBB', qty: 2, pQty: 1, unit: '', unitPrice: 200, subtotal: 400, sqmL: '', sqmW: '' },
      { id: 3, itemId: null, desc: 'CCC', qty: 3, pQty: 1, unit: '', unitPrice: 300, subtotal: 900, sqmL: '', sqmW: '' },
    ];
    const h = makeHarness(src, [], JSON.parse(JSON.stringify(fresh)));
    h.updateLine(2, 'desc', 'BBB EDITED');
    const after = h.get();
    ok(after.map((l: any) => l.desc).join(' / ') === 'AAA / BBB EDITED / CCC',
      'a brand-new quote being typed edits one line at a time, exactly as it always did', after.map((l: any) => l.desc));
  });

  // ══ 10. THE MODAL'S OWN NORMALISATION ════════════════════════════════════
  // A localStorage draft saved WHILE the bug was live holds lines with no id at
  // all. read.ts cannot repair those — only the modal can, as it loads them.
  await section('[10] The modal repairs any id-less line source it is handed (e.g. a stale saved draft)', async () => {
    const h = makeHarness(src, [], []);
    ok(typeof h.withLineIdentity === 'function',
      'CreateQuoteModal exposes withLineIdentity(), applied to whichever line source it initialises from');
    if (typeof h.withLineIdentity === 'function') {
      const idless = [{ desc: 'AAA', qty: 1, unitPrice: 100 }, { desc: 'BBB', qty: 2, unitPrice: 200 }, { desc: 'CCC', qty: 3, unitPrice: 300 }];
      const fixed = h.withLineIdentity(idless);
      ok(fixed.every((l: any) => l.id !== undefined && l.id !== null && l.id !== ''), 'every id-less line is given an id', fixed.map((l: any) => l.id));
      ok(new Set(fixed.map((l: any) => String(l.id))).size === 3, 'and the ids are unique', fixed.map((l: any) => l.id));
      const dupIds = [{ id: 7, desc: 'A' }, { id: 7, desc: 'B' }];
      const deduped = h.withLineIdentity(dupIds);
      ok(String(deduped[0].id) !== String(deduped[1].id), 'duplicate ids are separated too', deduped.map((l: any) => l.id));
      const keepers = [{ id: 11, desc: 'A' }, { id: 12, desc: 'B' }];
      const kept = h.withLineIdentity(keepers);
      ok(String(kept[0].id) === '11' && String(kept[1].id) === '12', 'ids that are already unique are left exactly as they are', kept.map((l: any) => l.id));
      const h2 = makeHarness(src, [], h.withLineIdentity(JSON.parse(JSON.stringify(idless))));
      const b = h2.get().map((l: any) => ({ ...l }));
      h2.updateLine(b[1].id, 'desc', 'BBB EDITED');
      const a = h2.get();
      ok(a.map((l: any) => l.desc).join(' / ') === 'AAA / BBB EDITED / CCC',
        'and a normalised id-less source then edits one line at a time', a.map((l: any) => l.desc));
    }
  });

  // ══ 11. REACT KEYS ═══════════════════════════════════════════════════════
  await section('[11] React keys', async () => {
    ok(/\{lines\.map\(\(line,idx\)=>\{[\s\S]{0,400}key=\{line\.id\}/.test(src) || src.includes('key={line.id}'),
      'the quote line list keys on line.id — the stable per-row identity, not the description, product or index');
    ok(!/lines\.map\(\(line,idx\)=>[\s\S]{0,200}key=\{idx\}/.test(src),
      'and never on the array index, which reordering and deletion would make unsafe');
  });

  console.log('\n============================================================');
  console.log(`${passed} passed, ${failures} failed`);
  console.log('============================================================');
  await pool.end();
  if (failures > 0) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error('\n[quote-line-independence] Fatal error:', err);
  process.exitCode = 1;
  await pool.end().catch(() => undefined);
});
