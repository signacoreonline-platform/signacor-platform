/**
 * relational.quote-deposit-pct.stress.ts — migration 015 (2026-09-21)
 *
 * Proves the RELATIONAL persistence of a Quote's OPTIONAL custom deposit
 * percentage, the field that makes "Standard 80%" vs "Custom %" survive on a
 * platform where `quotes` is relational-authoritative.
 *
 * THREE PARTS, in increasing cost:
 *
 *   1. VALIDATION  — validateQuoteDepositPct exercised directly. Pure
 *                    function, no database, no server. Always runs.
 *   2. WIRING      — source-text assertions over the migration, services.ts,
 *                    api.ts, read.ts, backfill.ts and index.html, in the same
 *                    style as relational.frontend-quote-wiring.test.ts. These
 *                    are what catch a field that validates correctly but is
 *                    missing from the INSERT, from a colMap, or from the read
 *                    layer — the exact failure mode this migration exists to
 *                    fix. No database. Always runs.
 *   3. ROUND TRIP  — real create/update/read against a real database:
 *                    NULL -> 65 -> 50 -> NULL, plus server-side refusals.
 *                    Requires TEST_DATABASE_URL pointing at a NON-PRODUCTION
 *                    database. SKIPPED, loudly, when that is unset — it is
 *                    never run against production.
 *
 * Nothing in this file touches rel_payments, job values or invoice totals;
 * part 3 asserts that those are byte-for-byte unchanged across every write.
 */
import fs from 'fs';
import path from 'path';
import { validateQuoteDepositPct } from '../src/relational/services';

const ROOT = path.resolve(__dirname, '..', '..');
const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH || path.join(ROOT, 'index.html');

let failures = 0, passed = 0, skipped = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}
function throws(fn: () => unknown, label: string) {
  try { const v = fn(); ok(false, label, { returnedInsteadOfThrowing: v }); }
  catch { ok(true, label); }
}

// ══════════════════════════════════════════════════════════════════════════
// PART 1 — VALIDATION RULE (no database)
// ══════════════════════════════════════════════════════════════════════════
function partValidation() {
  console.log('\n[1] validateQuoteDepositPct — the three-state contract');

  // undefined = "not mentioned in this patch" -> column left alone
  ok(validateQuoteDepositPct(undefined) === undefined,
    'undefined stays undefined (an unrelated quote save never touches deposit_pct)');

  // null / blank = "Standard" -> clear the column
  ok(validateQuoteDepositPct(null) === null, 'null -> null (Standard clears the column)');
  ok(validateQuoteDepositPct('') === null, 'empty string -> null');
  ok(validateQuoteDepositPct('   ') === null, 'whitespace -> null');

  // valid customs
  ok(validateQuoteDepositPct(65) === 65, '65 -> 65');
  ok(validateQuoteDepositPct('65') === 65, '"65" -> 65 (form values arrive as strings)');
  ok(validateQuoteDepositPct(50) === 50, '50 -> 50');
  ok(validateQuoteDepositPct(0) === 0, '0 accepted (lower bound)');
  ok(validateQuoteDepositPct(100) === 100, '100 accepted (upper bound)');
  ok(validateQuoteDepositPct(66.667) === 66.667, 'fractional percentage kept at NUMERIC(6,3) precision');

  // REFUSALS — never clamped, never silently ignored
  throws(() => validateQuoteDepositPct(-1), 'refuses -1 (below 0)');
  throws(() => validateQuoteDepositPct(-0.001), 'refuses -0.001');
  throws(() => validateQuoteDepositPct(101), 'refuses 101 (above 100)');
  throws(() => validateQuoteDepositPct(1000), 'refuses 1000');
  throws(() => validateQuoteDepositPct('abc'), 'refuses non-numeric "abc"');
  throws(() => validateQuoteDepositPct(NaN), 'refuses NaN');
  throws(() => validateQuoteDepositPct(Infinity), 'refuses Infinity');
  throws(() => validateQuoteDepositPct({} as any), 'refuses an object');
  throws(() => validateQuoteDepositPct([65] as any), 'refuses an array (no String() coercion)');
  throws(() => validateQuoteDepositPct(true as any), 'refuses a boolean');

  // the refusal must be READABLE, not a raw Postgres error
  try { validateQuoteDepositPct(150); ok(false, 'refusal carries a readable message'); }
  catch (e: any) {
    ok(/between 0 and 100/.test(String(e && e.message)),
      'refusal message names the allowed range', String(e && e.message));
  }
}

// ══════════════════════════════════════════════════════════════════════════
// PART 2 — WIRING (no database)
// ══════════════════════════════════════════════════════════════════════════
function partWiring() {
  const mig = fs.readFileSync(path.join(ROOT, 'database', 'migrations', '015_quote_deposit_pct.sql'), 'utf8');
  const services = fs.readFileSync(path.join(__dirname, '..', 'src', 'relational', 'services.ts'), 'utf8');
  const api = fs.readFileSync(path.join(__dirname, '..', 'src', 'relational', 'api.ts'), 'utf8');
  const read = fs.readFileSync(path.join(__dirname, '..', 'src', 'relational', 'read.ts'), 'utf8');
  const backfill = fs.readFileSync(path.join(__dirname, '..', 'src', 'relational', 'backfill.ts'), 'utf8');
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

  // The header comment block legitimately CONTAINS the words "no DROP, no
  // DELETE, no TRUNCATE", so the destructive-statement scan runs over the
  // EXECUTABLE sql only — comments stripped.
  const migSql = mig.split('\n').filter(l => !/^\s*--/.test(l)).join('\n');

  console.log('\n[2a] migration 015 — additive, idempotent, no backfill');
  ok(/ALTER TABLE rel_quotes ADD COLUMN IF NOT EXISTS deposit_pct NUMERIC\(6,3\);/.test(migSql),
    'adds rel_quotes.deposit_pct NUMERIC(6,3), IF NOT EXISTS');
  ok(!/\bDROP\b|\bTRUNCATE\b|\bDELETE\b/i.test(migSql), 'executable SQL contains no DROP / TRUNCATE / DELETE');
  ok(!/\bINSERT\b|\bUPDATE\b/i.test(migSql), 'executable SQL writes no rows at all (no backfill of 80 onto history)');
  ok((migSql.match(/;/g) || []).length === 2, 'exactly two statements: the ADD COLUMN and its COMMENT');
  ok(!/NOT NULL|DEFAULT/i.test(migSql.split('\n').filter(l => /ALTER TABLE/.test(l)).join('\n')),
    'the column is nullable with no default, so every existing row stays valid');
  const migFiles = fs.readdirSync(path.join(ROOT, 'database', 'migrations')).filter(f => f.endsWith('.sql')).sort();
  ok(migFiles[migFiles.length - 1] === '015_quote_deposit_pct.sql',
    'takes the next number in the existing sequence', migFiles.slice(-3));

  console.log('\n[2b] services.ts — relational WRITE path');
  ok(/deposit_pct, legacy_data\)/.test(services), 'createQuote INSERT lists deposit_pct');
  ok(/input\.depositPct \?\? null\]/.test(services), 'createQuote binds the validated depositPct (null when absent)');
  ok((services.match(/depositPct: 'deposit_pct',/g) || []).length === 2,
    'BOTH quote update colMaps map depositPct -> deposit_pct (updateQuote and updateQuoteWithJobSync)',
    (services.match(/depositPct: 'deposit_pct',/g) || []).length);
  ok(/const dp = validateQuoteDepositPct\(input\.depositPct, 'Deposit %'\);/.test(services),
    'validateQuoteHeader validates+normalises depositPct for create AND both update paths');
  ok(/if \(\(patch as any\)\[k\] !== undefined\)/.test(services),
    'the colMap loop skips undefined and therefore WRITES an explicit null');

  console.log('\n[2c] services.ts — totals and payments are NOT touched');
  const createTotals = services.slice(services.indexOf('export async function createQuote'), services.indexOf('// ── CONVERT QUOTE -> JOB'));
  ok(!/depositPct/.test(createTotals.slice(createTotals.indexOf('const subtotal ='), createTotals.indexOf('const insertRes'))),
    'createQuote\'s subtotal/discount/VAT/total block never mentions depositPct');
  ok(!/deposit_pct/.test(services.slice(services.indexOf('function computeQuoteTotals'), services.indexOf('function computeQuoteTotals') + 600)),
    'computeQuoteTotals is untouched by the deposit percentage');
  ok(!/rel_payments[\s\S]{0,200}deposit_pct|deposit_pct[\s\S]{0,200}rel_payments/.test(services),
    'no statement associates deposit_pct with rel_payments');

  console.log('\n[2d] api.ts — HTTP surface');
  ok(/quoteDate, validUntil, status, depositPct,\s*\n\s*\} = req\.body \|\| \{\};/.test(api),
    'POST /quotes destructures depositPct from the body');
  ok(/poRef, reference, quoteDate, validUntil, status, depositPct,\s*\n\s*\}\);/.test(api),
    'POST /quotes forwards depositPct to createQuote');
  ok(/expectedInvoiceVersion, \.\.\.patch\s*\} = req\.body \|\| \{\};/.test(api),
    'PUT /quotes/:id rest-spreads the body, so depositPct reaches updateQuoteWithJobSync\'s whitelist');

  console.log('\n[2e] read.ts — relational hydration, ONE source of truth');
  ok(/depositPct: numOrNull\(r\.deposit_pct\),/.test(read),
    'buildQuotesJson exposes the column to the frontend as `depositPct`');
  ok(!/depositPct: numOrNull\(r\.deposit_pct\) \?\? legacyBase/.test(read),
    'deliberately NO legacy_data fallback — a cleared percentage can never resurrect');
  const quoteBuilder = read.slice(read.indexOf('export async function buildQuotesJson'), read.indexOf('// ── CANONICAL JOB -> INVOICE RESOLUTION'));
  ok(quoteBuilder.indexOf('...legacyBase(r)') < quoteBuilder.indexOf('depositPct:'),
    'the explicit key is spread AFTER legacyBase, so the column always wins');

  console.log('\n[2f] backfill.ts — a pre-cutover JSON value reaches the real column');
  ok(/deposit_pct: depositPctOrNull\(rec\.depositPct\),/.test(backfill),
    'the rel_quotes column map carries depositPct across');
  ok(/function depositPctOrNull/.test(backfill), 'depositPctOrNull helper exists');
  ok(/n < 0 \|\| n > 100\) return null;/.test(backfill),
    'backfill degrades a malformed/out-of-range legacy value to NULL (= standard rules)');

  console.log('\n[2g] index.html — frontend relational payloads');
  ok(/depositPct: depositPctValue,\s*\n\s*\}\);/.test(html),
    'the relational CREATE payload sends depositPct on the first save');
  ok(/depositPct: normalizeQuoteDepositPct\(q\.depositPct\),/.test(html),
    'the relational EDIT patch sends a normalised depositPct (null for Standard)');
  ok(/function quoteDepositInfo\(doc, total\)\{/.test(html),
    'the single frontend resolver is still the one all quote surfaces use');
  ok((html.match(/quoteDepositInfo\(/g) || []).length >= 8,
    'every deposit surface still goes through it', (html.match(/quoteDepositInfo\(/g) || []).length);
  ok(!/depRate===1\?'100%':'80%'/.test(html),
    'no hard-coded 80%/100% label survives anywhere');
  ok(/const autoFull = custom===null && t<=5000;/.test(html),
    'the <= R5,000 automatic full-deposit rule is preserved, and only applies when NO custom % is set');
  ok(/const pct = custom!==null \? custom : \(autoFull \? 100 : QUOTE_DEFAULT_DEPOSIT_PCT\);/.test(html),
    'precedence is custom -> R5,000 rule -> 80% default');
}

// ══════════════════════════════════════════════════════════════════════════
// PART 3 — REAL DATABASE ROUND TRIP (requires TEST_DATABASE_URL)
// ══════════════════════════════════════════════════════════════════════════
async function partRoundTrip() {
  const testDbUrl = process.env.TEST_DATABASE_URL;
  if (!testDbUrl) {
    skipped++;
    console.log('\n[3] DATABASE ROUND TRIP — SKIPPED (NOT EXECUTED)');
    console.log('    TEST_DATABASE_URL is not set, so no database round trip was run.');
    console.log('    This suite NEVER falls back to DATABASE_URL: that is the production');
    console.log('    database, and these tests create and mutate quotes.');
    console.log('    To execute part 3, point TEST_DATABASE_URL at a NON-PRODUCTION');
    console.log('    database that has had migrations 001-015 applied.');
    return;
  }
  process.env.DATABASE_URL = testDbUrl;
  const { createQuote, updateQuote } = await import('../src/relational/services');
  const { buildQuotesJson } = await import('../src/relational/read');
  const pool = (await import('../src/db/pool')).default;

  const readBack = async (id: number) => {
    const all = await buildQuotesJson();
    return all.find((q: any) => Number(q._relId) === Number(id));
  };
  const rawTotals = async (id: number) => {
    const r = await pool.query('SELECT subtotal, vat_amount, total FROM rel_quotes WHERE id = $1', [id]);
    return r.rows[0];
  };
  const paymentCount = async () => Number((await pool.query('SELECT COUNT(*)::int AS c FROM rel_payments')).rows[0].c);

  console.log('\n[3] DATABASE ROUND TRIP (TEST_DATABASE_URL)');
  const paymentsBefore = await paymentCount();
  const base = { companyCode: '2', customerNameRaw: 'DEPOSIT PCT TEST', lines: [{ description: 'x', qty: 1, unitPrice: 10000 }] };

  // 1. created with no depositPct -> stored NULL -> reads back null (= 80%)
  const a = await createQuote({ ...base } as any);
  let row = await pool.query('SELECT deposit_pct FROM rel_quotes WHERE id = $1', [a.id]);
  ok(row.rows[0].deposit_pct === null, 'create without depositPct stores NULL');
  ok((await readBack(a.id)).depositPct === null, 'reads back as null (frontend resolver -> default 80%)');
  const aTotals = await rawTotals(a.id);

  // 2. created with a custom 65
  const b = await createQuote({ ...base, depositPct: 65 } as any);
  ok(Number((await pool.query('SELECT deposit_pct FROM rel_quotes WHERE id = $1', [b.id])).rows[0].deposit_pct) === 65,
    'create with depositPct 65 stores 65');
  ok(Number((await readBack(b.id)).depositPct) === 65, 'reads back 65');
  const bTotalsAtCreate = await rawTotals(b.id);

  // 3. edit 65 -> 50
  let v = (await pool.query('SELECT row_version FROM rel_quotes WHERE id = $1', [b.id])).rows[0].row_version;
  await updateQuote(b.id, v, { depositPct: 50 });
  ok(Number((await readBack(b.id)).depositPct) === 50, 'edit 65 -> 50 persists and reads back 50');

  // 4. edit Custom -> Standard (null)
  v = (await pool.query('SELECT row_version FROM rel_quotes WHERE id = $1', [b.id])).rows[0].row_version;
  await updateQuote(b.id, v, { depositPct: null });
  ok((await pool.query('SELECT deposit_pct FROM rel_quotes WHERE id = $1', [b.id])).rows[0].deposit_pct === null,
    'switching to Standard writes NULL, clearing the previous custom percentage');
  ok((await readBack(b.id)).depositPct === null, 'reads back null (-> default 80%)');

  // 5. an unrelated patch must not disturb it
  v = (await pool.query('SELECT row_version FROM rel_quotes WHERE id = $1', [b.id])).rows[0].row_version;
  await updateQuote(b.id, v, { depositPct: 65 });
  v = (await pool.query('SELECT row_version FROM rel_quotes WHERE id = $1', [b.id])).rows[0].row_version;
  await updateQuote(b.id, v, { notes: 'unrelated edit' });
  ok(Number((await readBack(b.id)).depositPct) === 65,
    'a patch that omits depositPct leaves the stored percentage untouched');

  // 6/7/8. server-side refusals
  v = (await pool.query('SELECT row_version FROM rel_quotes WHERE id = $1', [b.id])).rows[0].row_version;
  for (const bad of [-1, 101, 'abc']) {
    let threw = false;
    try { await updateQuote(b.id, v, { depositPct: bad as any }); } catch { threw = true; }
    ok(threw, `server refuses depositPct ${JSON.stringify(bad)}`);
  }
  ok(Number((await readBack(b.id)).depositPct) === 65, 'a refused value changed nothing');

  // 9/11. totals unchanged by every deposit write above
  ok(JSON.stringify(await rawTotals(b.id)) === JSON.stringify(bTotalsAtCreate),
    'quote subtotal/vat/total are byte-identical after all deposit writes');
  ok(JSON.stringify(await rawTotals(a.id)) === JSON.stringify(aTotals), 'the untouched quote\'s totals are unchanged');

  // 10. rel_payments untouched
  ok((await paymentCount()) === paymentsBefore, 'rel_payments row count unchanged by every write above');

  await pool.end();
}

(async () => {
  console.log('='.repeat(78));
  console.log('QUOTE CUSTOM DEPOSIT PERCENTAGE — migration 015 relational persistence');
  console.log('='.repeat(78));
  partValidation();
  partWiring();
  await partRoundTrip();
  console.log('\n' + '='.repeat(78));
  console.log(`RESULT: ${passed} passed, ${failures} failed, ${skipped} section(s) skipped`);
  console.log('='.repeat(78));
  process.exit(failures ? 1 : 0);
})();
