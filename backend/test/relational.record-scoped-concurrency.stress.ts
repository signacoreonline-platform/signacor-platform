/**
 * relational.record-scoped-concurrency.stress.ts — STAGE 3 FOLLOW-UP
 * (2026-08-21): "record-scoped concurrency + long-lived editor safety",
 * RELATIONAL side.
 *
 * The relational architecture already used row-level optimistic concurrency
 * (row_version + expectedVersion, dual-gated per section) for every entity
 * since Stage 2/3 — this file's job is to PROVE that record-scoped
 * concurrency, using the quote editor (the real overnight-quote scenario)
 * as the first complete proof, exactly as specified:
 *
 *   UNRELATED RECORD CHANGED -> current editor may still save.
 *   SAME RECORD CHANGED      -> stale/conflict protection applies.
 *
 * Two parts:
 *   1. Source-text checks against the ACTUAL shipped index.html quote save
 *      handler — proving the real frontend code (not an unused helper)
 *      uses q._relId/q._relRowVersion (never a global platform revision),
 *      asserts the linked job's version via expectedJobVersion in the SAME
 *      transactional call, no longer swallows a conflict via alert()-and-
 *      silently-resolve (the real bug this follow-up found and fixed — see
 *      QuotesPage.handleSave's isEdit-relational branch), and never falls
 *      back to an unsafe full-state save after a relational conflict.
 *   2. Real end-to-end HTTP proofs (Q1-Q6 from the brief) against the live
 *      relational REST API.
 *
 * Requires TEST_SERVER_URL_WITH_AUTHORITY for part 2 — part 1 (source
 * checks) always runs.
 */
import fs from 'fs';
import path from 'path';
import pool from '../src/db/pool';

const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH || path.resolve(__dirname, '..', '..', 'index.html');

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

async function login(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.TEST_LOGIN_EMAIL || 'test@signacore.local', password: process.env.TEST_LOGIN_PASSWORD || 'testpass' }),
  });
  if (!res.ok) throw new Error(`login failed against ${baseUrl}: HTTP ${res.status}`);
  return (await res.json()).token;
}

// ── PART 1 — source-text checks against the real shipped frontend ─────────
function checkSourceWiring(src: string) {
  console.log('\n[Record-scoped concurrency] source-text checks — the ACTUAL shipped QuotesPage.handleSave / CreateQuoteModal');

  // The exact pre-fix bug: the relational edit branch caught its own error,
  // alert()-ed it, and did NOT re-throw — so CreateQuoteModal's submit()
  // (which awaits onSave(payload)) never saw a rejection, believed the save
  // had succeeded, and cleared the user's localStorage draft + closed the
  // editor even on a genuine 409 conflict. This string must be GONE.
  ok(!src.includes(`alert('Save failed — '+(saveErr&&saveErr.message?saveErr.message:'unknown error')+'\\n\\nYour quote edit was NOT saved. Please check your connection and try again.');`),
    'the OLD bug — QuotesPage.handleSave swallowing a relational quote-edit conflict via alert() without re-throwing — is GONE');

  // The relational edit branch itself: record-scoped identity only.
  ok(src.includes(`if(isEdit && isRelationalAuthoritative('quotes')){`),
    'QuotesPage.handleSave has a dedicated relational-authoritative edit branch');
  ok(src.includes(`const result = await relationalApi.updateQuote(q._relId, q._relRowVersion, patch);`),
    'the relational edit branch saves using q._relId/q._relRowVersion — the QUOTE\'s own record identity, never a bare .id and never a global platform revision');
  ok(src.includes(`if(linkedJob && linkedJob._relRowVersion !== undefined) patch.expectedJobVersion = linkedJob._relRowVersion;`),
    'when a linked job exists, its OWN row_version is asserted via expectedJobVersion — record-scoped, not derived from any whole-platform revision');

  // Extract exactly the relational-edit branch's source (from its `if` to
  // the following top-level `return;`) so the "no unsafe fallback" and
  // "no swallowed error" checks are scoped to THIS branch specifically, not
  // a coincidental match elsewhere in a 1.7MB file.
  const branchStart = src.indexOf(`if(isEdit && isRelationalAuthoritative('quotes')){`);
  ok(branchStart !== -1, 'located the relational edit branch to scope the following checks to it');
  const branchEnd = src.indexOf(`\n      return;\n    }`, branchStart);
  const branch = branchStart !== -1 && branchEnd !== -1 ? src.slice(branchStart, branchEnd) : '';
  ok(branch.length > 0, 'extracted a non-empty branch body');
  ok(!/catch\s*\(/.test(branch),
    'the relational edit branch has NO try/catch of its own — a rejection propagates naturally up to CreateQuoteModal\'s submit(), which is what actually decides whether to preserve the draft (see Part 8 below)');
  ok(!branch.includes('forceSaveSections') && !branch.includes('saveToServer') && !branch.includes('mergeAndSave'),
    'the relational edit branch never falls back to the legacy JSON full-state save path after/around a relational call — no unsafe fallback');

  // The reusable conflict-message helper: defined, AND actually called from
  // the real modal (not just an unused helper sitting in the file).
  ok(src.includes('function describeSaveConflictError(err, entityLabel)'),
    'the reusable describeSaveConflictError helper is defined');
  ok(src.includes(`setSaveErr(describeSaveConflictError(saveError, 'quote'));`),
    'CreateQuoteModal\'s own submit() catch — the ONE place that decides whether to close/clear the quote editor — actually calls describeSaveConflictError (not an unused helper)');

  // Draft preservation: the modal's catch returns BEFORE any close/clear
  // logic runs (localStorage.removeItem / onClose()), for BOTH the
  // new-quote and the general onSave catch.
  const modalCatchIdx = src.indexOf(`setSaveErr(describeSaveConflictError(saveError, 'quote'));\n      return; // nothing local changed — form stays open, draft preserved`);
  ok(modalCatchIdx !== -1, 'the modal\'s onSave catch returns immediately after setting the error — draft (form fields, localStorage) is never touched on failure');

  // Legacy JSON path: _recordBase actually threaded from a real BASE
  // snapshot captured when editing began (editQuoteBaseRef), not a stray
  // unused field.
  ok(src.includes('const editQuoteBaseRef = useRef(null);'),
    'a BASE snapshot ref exists, captured once per edit session');
  ok(src.includes('editQuoteBaseRef.current = {') && src.includes('quote: JSON.parse(JSON.stringify(q)),'),
    'handleEditQuote captures a deep-cloned BASE snapshot of the quote (and its linked job, if any) at the moment editing begins');
  ok(src.includes('recordBase = { quotes: { [String(q.id)]: editQuoteBaseRef.current.quote } };'),
    'the legacy JSON quote-save branch builds _recordBase from that captured BASE, not from live/mutable state');
  ok(src.includes('await forceSaveSections(overrides, recordBase);'),
    'the legacy JSON quote-save branch actually PASSES recordBase into forceSaveSections — proving this is wired into the real save call, not an unused local variable');
  // 2026-08-24: both signatures gained an optional third parameter
  // (`deletedIds`), so this no longer pins the exact parameter list — it pins
  // what actually matters, and now pins MORE of it: that `recordBase` is
  // declared by both functions, threaded through the queue between them, and
  // attached to the real request body. The added `deletedIds` parameter is
  // asserted alongside it because it is load-bearing for the same path — it is
  // the ONLY thing that can make a partial save delete a record (the backend
  // merge is otherwise additive), and a removal that silently fails to persist
  // is exactly the class of bug this suite exists to catch.
  ok(/function forceSaveSections\(overrides, recordBase(, deletedIds)?\)\{/.test(src)
     && /async function savePartialSectionsNow\(overrides, recordBase(, deletedIds)?\)\{/.test(src)
     && src.includes('if(recordBase) data._recordBase = recordBase;')
     && src.includes('return enqueueSavePartialSections(overrides, recordBase, deletedIds);')
     && /savePartialSectionsNow\(overrides, recordBase, deletedIds\)/.test(src),
    'forceSaveSections/savePartialSectionsNow accept recordBase end-to-end (and now deletedIds too), threading both through the save queue and attaching recordBase to the actual request body as _recordBase');
  ok(/if\(deletedIds && typeof deletedIds === 'object'\)\{[\s\S]{0,400}data\._deletedIds = scopedDeletes;/.test(src),
    'and an explicitly-declared deletion reaches the request body as _deletedIds, scoped to the sections this save actually sends');
}

// ── PART 2 — real end-to-end HTTP proofs (Q1-Q6) ───────────────────────────
async function resetAll() {
  await pool.query(`
    TRUNCATE rel_payments, rel_invoice_line_items, rel_invoices, rel_purchase_order_items, rel_purchase_orders,
             rel_job_line_items, rel_jobs, rel_quote_line_items, rel_quotes, rel_credit_notes,
             rel_inventory_items, rel_suppliers
    RESTART IDENTITY CASCADE
  `);
  await pool.query(`DELETE FROM quote_conversions`);
  await pool.query(`DELETE FROM document_number_counters`);
  await pool.query(`UPDATE relational_cutover SET enabled = false, enabled_at = NULL, enabled_by = NULL`);
  await pool.query(`UPDATE platform_state SET data = '{}'::jsonb, updated_at = NOW() WHERE id = 1`);
}

async function main() {
  // index.html uses CRLF line endings — normalize to LF here so this file's
  // own multiline template-literal searches (branch extraction, the modal
  // catch-block check) match regardless, without needing every needle
  // spelled out as \r\n (the convention established elsewhere in this test
  // suite, e.g. relational.frontend-po-supplier-inventory-wiring.test.ts's
  // CRLF note, is to split into separate single-line .includes() checks —
  // normalizing once here is equivalent and less error-prone for the
  // multiline extraction this file also needs).
  const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8').replace(/\r\n/g, '\n');
  checkSourceWiring(src);

  const base = process.env.TEST_SERVER_URL_WITH_AUTHORITY;
  if (!base) {
    console.log('\n[Record-scoped concurrency] Part 2 (end-to-end Q1-Q6) SKIPPED — TEST_SERVER_URL_WITH_AUTHORITY not set.');
    console.log('\n' + '='.repeat(60));
    console.log(`${passed} passed, ${failures} failed`);
    console.log('='.repeat(60));
    await pool.end();
    process.exit(failures > 0 ? 1 : 0);
  }

  await resetAll();
  await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section = ANY($1)`, [['quotes', 'jobs']]);

  const token = await login(base);
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  async function createQuote(client: string) {
    const res = await fetch(`${base}/api/relational/quotes`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ companyCode: 2, customerNameRaw: client, lines: [{ description: 'Line', qty: 1, unitPrice: 100 }] }),
    });
    const body: any = await res.json();
    if (res.status !== 201) throw new Error(`createQuote failed: ${JSON.stringify(body)}`);
    return body; // { id, quoteNumber, rowVersion }
  }
  async function editQuote(id: number, expectedVersion: number, notes: string, extra: any = {}) {
    const res = await fetch(`${base}/api/relational/quotes/${id}`, {
      method: 'PUT', headers: H,
      body: JSON.stringify({ expectedVersion, notes, ...extra }),
    });
    const body: any = await res.json();
    return { status: res.status, body };
  }
  async function convertToJob(quoteId: number) {
    const res = await fetch(`${base}/api/relational/quotes/${quoteId}/convert-to-job`, { method: 'POST', headers: H });
    const body: any = await res.json();
    if (res.status !== 201) throw new Error(`convertToJob failed: ${JSON.stringify(body)}`);
    return body; // { jobId, jobNumber, jobRowVersion }
  }
  async function editJob(id: number, expectedVersion: number, notes: string) {
    const res = await fetch(`${base}/api/relational/jobs/${id}`, {
      method: 'PUT', headers: H,
      body: JSON.stringify({ expectedVersion, notes }),
    });
    const body: any = await res.json();
    return { status: res.status, body };
  }

  // ── Q1 — UNRELATED JOB: editing Quote A must succeed even though an
  //    unrelated Job B changed in between. ─────────────────────────────────
  console.log('\n[Q1 — unrelated job] Open Quote A, change Job B, save Quote A — must succeed, Job B\'s change must survive');
  const quoteA = await createQuote('Q1 Client A');
  const quoteForJobB = await createQuote('Q1 Client B (becomes Job B)');
  const jobB = await convertToJob(quoteForJobB.id);
  const jobBEdit = await editJob(jobB.jobId, jobB.jobRowVersion, 'Job B — changed independently while Quote A editor was open');
  ok(jobBEdit.status === 200, 'Job B\'s independent edit succeeds', jobBEdit.body);

  const quoteASave = await editQuote(quoteA.id, quoteA.rowVersion, 'Quote A — saved after an unrelated job changed');
  ok(quoteASave.status === 200, 'Quote A save SUCCEEDS despite Job B having changed — record-scoped, not blocked by an unrelated record', quoteASave.body);
  const jobBRow = await pool.query(`SELECT notes FROM rel_jobs WHERE id = $1`, [jobB.jobId]);
  ok(jobBRow.rows[0].notes === 'Job B — changed independently while Quote A editor was open', 'Job B\'s change survived Quote A\'s save — nothing unrelated was touched');

  // ── Q2 — UNRELATED QUOTE: editing Quote A must succeed even though a
  //    different Quote C changed in between. ───────────────────────────────
  console.log('\n[Q2 — unrelated quote] Open Quote A(2), change Quote C, save Quote A(2) — must succeed, Quote C survives');
  const quoteA2 = await createQuote('Q2 Client A');
  const quoteC = await createQuote('Q2 Client C');
  const quoteCEdit = await editQuote(quoteC.id, quoteC.rowVersion, 'Quote C — changed independently');
  ok(quoteCEdit.status === 200, 'Quote C\'s independent edit succeeds', quoteCEdit.body);
  const quoteA2Save = await editQuote(quoteA2.id, quoteA2.rowVersion, 'Quote A(2) — saved after an unrelated quote changed');
  ok(quoteA2Save.status === 200, 'Quote A(2) save SUCCEEDS despite Quote C having changed', quoteA2Save.body);
  const quoteCRow = await pool.query(`SELECT notes FROM rel_quotes WHERE id = $1`, [quoteC.id]);
  ok(quoteCRow.rows[0].notes === 'Quote C — changed independently', 'Quote C\'s change survived Quote A(2)\'s save');

  // ── Q3 — SAME QUOTE: a genuinely stale edit to the SAME quote is blocked. ──
  console.log('\n[Q3 — same quote] Two edits to the SAME Quote A(3) — the stale one is blocked, the fresh one\'s content survives');
  const quoteA3 = await createQuote('Q3 Client');
  const firstEdit = await editQuote(quoteA3.id, quoteA3.rowVersion, 'Quote A(3) — first editor\'s save (accepted)');
  ok(firstEdit.status === 200, 'the first (fresh) edit succeeds', firstEdit.body);
  const staleEdit = await editQuote(quoteA3.id, quoteA3.rowVersion /* the ORIGINAL, now-stale version */, 'Quote A(3) — stale editor\'s save (must be blocked)');
  ok(staleEdit.status === 409 && staleEdit.body?.type === 'stale_record', 'the second, stale-version edit is refused with 409 stale_record', staleEdit.body);
  const quoteA3Row = await pool.query(`SELECT notes FROM rel_quotes WHERE id = $1`, [quoteA3.id]);
  ok(quoteA3Row.rows[0].notes === 'Quote A(3) — first editor\'s save (accepted)', 'the server\'s current content is the FIRST (accepted) edit — the stale save never overwrote it, and the rejected editor\'s local draft is simply never applied server-side');

  // ── Q4 — LONG-LIVED EDITOR: many unrelated changes happen over the
  //    "editor session"; Quote A(4) itself never changes; saving at the end
  //    still succeeds. This is the automated equivalent of the overnight
  //    quote. ──────────────────────────────────────────────────────────────
  console.log('\n[Q4 — long-lived editor] Quote A(4) stays open through several unrelated changes — save at the end still succeeds');
  const quoteA4 = await createQuote('Q4 Client A — long-lived editor');
  const capturedVersion = quoteA4.rowVersion; // what the "editor" remembers for the whole session
  for (let i = 0; i < 3; i++) {
    const unrelatedQuote = await createQuote(`Q4 unrelated churn quote ${i}`);
    const unrelatedEdit = await editQuote(unrelatedQuote.id, unrelatedQuote.rowVersion, `unrelated churn edit ${i}`);
    ok(unrelatedEdit.status === 200, `unrelated background change #${i + 1} (simulating other Signacore activity overnight) succeeds`, unrelatedEdit.body);
  }
  const dummyForJobChurn = await createQuote('Q4 dummy for job churn'); // separate quote, only to churn a job
  const quoteA4Job = await convertToJob(dummyForJobChurn.id);
  const quoteA4JobEdit = await editJob(quoteA4Job.jobId, quoteA4Job.jobRowVersion, 'more unrelated churn — a job edit, while Quote A(4) is still open');
  ok(quoteA4JobEdit.status === 200, 'unrelated job churn also succeeds', quoteA4JobEdit.body);

  const longLivedSave = await editQuote(quoteA4.id, capturedVersion, 'Quote A(4) — saved after being open through several unrelated changes (the overnight-quote proof)');
  ok(longLivedSave.status === 200, 'Quote A(4)\'s save SUCCEEDS after multiple unrelated background changes — this is the automated proof of the overnight-quote fix', longLivedSave.body);

  // ── Q5 — LINKED JOB CONFLICT: the linked job changes independently while
  //    the quote editor (which needs to sync onto that job) is open — the
  //    WHOLE transaction must be refused, quote not partially saved, job
  //    not overwritten, nothing silently applied. ──────────────────────────
  console.log('\n[Q5 — linked job conflict] Quote E\'s linked Job E changes independently — the sync transaction must fully roll back');
  const quoteE = await createQuote('Q5 Client E');
  const jobE = await convertToJob(quoteE.id);
  // Re-fetch quote E's row_version post-conversion (convertQuoteToJob does
  // not change the quote's own row — only jobs.row_version and
  // quote_conversions — but re-fetch explicitly rather than assume, to keep
  // this test honest about what it's asserting).
  const quoteEAfterConvert = await pool.query(`SELECT row_version FROM rel_quotes WHERE id = $1`, [quoteE.id]);
  const quoteEVersion = quoteEAfterConvert.rows[0].row_version;
  const staleJobEVersion = jobE.jobRowVersion; // captured "when the quote editor opened"

  // Job E changes independently (someone edits the job directly).
  const jobEIndependentEdit = await editJob(jobE.jobId, jobE.jobRowVersion, 'Job E — edited independently while Quote E\'s editor was open');
  ok(jobEIndependentEdit.status === 200, 'Job E\'s independent edit succeeds, Job E\'s row_version advances', jobEIndependentEdit.body);

  // The quote editor now tries to save Quote E (itself unchanged — correct,
  // current quote version) but with the STALE expectedJobVersion — exactly
  // what index.html sends (linkedJob._relRowVersion as captured when the
  // editor opened, before Job E's independent edit).
  const syncConflict = await editQuote(quoteE.id, quoteEVersion, 'Quote E — edited, requires job sync', { expectedJobVersion: staleJobEVersion });
  ok(syncConflict.status === 409 && syncConflict.body?.type === 'stale_record', 'the quote save is refused with 409 stale_record because the LINKED JOB (not the quote itself) is stale', syncConflict.body);

  const quoteEFinal = await pool.query(`SELECT row_version, notes FROM rel_quotes WHERE id = $1`, [quoteE.id]);
  ok(quoteEFinal.rows[0].row_version === quoteEVersion, 'Quote E\'s row_version is UNCHANGED — the refused transaction did not partially apply the quote side');
  const jobEFinal = await pool.query(`SELECT notes FROM rel_jobs WHERE id = $1`, [jobE.jobId]);
  ok(jobEFinal.rows[0].notes === 'Job E — edited independently while Quote E\'s editor was open', 'Job E\'s independent (newer) content is INTACT — the refused sync never overwrote it');

  // ── Q6 — LINE ITEMS: no stable per-line identity exists in the schema
  //    (rel_quote_line_items has only line_index, never exposed to the
  //    client) — CreateQuoteModal/JobDetail always save the WHOLE lines
  //    array as one unit (see services.ts's replaceQuoteLinesTx). The
  //    safest deterministic strategy given that is to treat `lines` as part
  //    of the QUOTE's own atomic unit, protected by the quote's row_version
  //    — proven here: a second, stale-version lines save is rejected
  //    wholesale (never partially merged/duplicated/dropped). ─────────────
  console.log('\n[Q6 — line items] No stable per-line identity exists — lines are protected as part of the quote\'s own atomic row_version, proven here');
  const quoteF = await createQuote('Q6 Client F');
  const firstLinesEdit = await editQuote(quoteF.id, quoteF.rowVersion, 'Quote F — first lines edit', {
    lines: [{ desc: 'First edit — line 1', qty: 2, unitPrice: 50 }, { desc: 'First edit — line 2', qty: 1, unitPrice: 75 }],
  });
  ok(firstLinesEdit.status === 200, 'the first lines edit (fresh version) succeeds', firstLinesEdit.body);
  const staleLinesEdit = await editQuote(quoteF.id, quoteF.rowVersion /* stale — predates the first edit */, 'Quote F — stale concurrent lines edit', {
    lines: [{ desc: 'STALE edit — should never appear', qty: 9, unitPrice: 9 }],
  });
  ok(staleLinesEdit.status === 409 && staleLinesEdit.body?.type === 'stale_record', 'the second (stale) concurrent lines edit is rejected wholesale — 409 stale_record', staleLinesEdit.body);
  const finalLines = await pool.query(`SELECT description FROM rel_quote_line_items WHERE quote_id = $1 ORDER BY line_index`, [quoteF.id]);
  ok(finalLines.rows.length === 2 && finalLines.rows[0].description === 'First edit — line 1' && finalLines.rows[1].description === 'First edit — line 2',
    'the DB holds EXACTLY the first edit\'s two lines — nothing dropped, nothing duplicated, and none of the stale edit\'s content silently merged in', finalLines.rows);

  // A DIFFERENT quote's lines are completely independent (same principle as
  // Q2, applied specifically to line-item saves).
  const quoteG = await createQuote('Q6 Client G — independent lines');
  const quoteGLinesEdit = await editQuote(quoteG.id, quoteG.rowVersion, 'Quote G notes', { lines: [{ desc: 'Quote G own line', qty: 1, unitPrice: 10 }] });
  ok(quoteGLinesEdit.status === 200, 'a different quote\'s (Quote G) own lines edit is completely unaffected by Quote F\'s conflict above', quoteGLinesEdit.body);

  await resetAll();

  console.log('\n' + '='.repeat(60));
  console.log(`${passed} passed, ${failures} failed`);
  console.log('='.repeat(60));
  await pool.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[record-scoped-concurrency-test] Fatal error:', err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
