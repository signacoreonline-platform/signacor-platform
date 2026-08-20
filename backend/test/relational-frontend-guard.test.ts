/**
 * relational-frontend-guard.test.ts — Stage 2 Phase 4.
 *
 * There is no browser click-through harness in this environment, so the
 * systemic safety guard added to index.html (assertNoUnwiredRelationalSections
 * / isRelationalAuthoritative / relationalAuthoritativeSectionsRef — see the
 * "RELATIONAL PERSISTENCE ABSTRACTION" block near the top of index.html,
 * right after forceLogoutExpiredSession) is instead verified the same way
 * proforma-frontend-logic.test.ts already verifies other pure index.html
 * logic: extract the exact function/const source by brace-matching, run it
 * in a real Node vm sandbox, and assert on its behavior directly. This is
 * NOT a mock/reimplementation of the guard — it is the literal code that
 * ships in index.html, so a future edit that breaks the guard's logic (e.g.
 * an accidental early-return, or a condition inverted) will fail this test
 * exactly the same way any other extracted-logic regression would.
 *
 * What this proves:
 *   1. With no section marked relational-authoritative (the default —
 *      nothing cut over, or a page load before the first GET), the guard
 *      never blocks any save.
 *   2. Once a section is marked authoritative, ANY save whose section list
 *      includes it throws — even when other, non-authoritative sections
 *      are also in that same list (mirrors forceSaveSections/mergeAndSave's
 *      real call shape: multiple sections in one overrides/changed object).
 *   3. A save whose section list does NOT include the authoritative
 *      section is completely unaffected.
 *   4. isRelationalAuthoritative() itself reflects
 *      relationalAuthoritativeSectionsRef.current directly and immediately
 *      — no caching, no stale read.
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH || path.resolve(__dirname, '..', '..', 'index.html');

let failures = 0;
let passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

// Same brace-matching extractor as proforma-frontend-logic.test.ts — kept
// deliberately identical rather than imported, since these test files run
// standalone via ts-node/compiled dist with no shared module between them.
function extractFunction(src: string, name: string): string {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) throw new Error(`Could not find function ${name} in index.html — has it been renamed/removed?`);
  const start = m.index;
  const parenStart = src.indexOf('(', m.index);
  if (parenStart === -1) throw new Error(`Could not find parameter list for function ${name}`);
  let pdepth = 0;
  let j = parenStart;
  for (; j < src.length; j++) {
    if (src[j] === '(') pdepth++;
    else if (src[j] === ')') { pdepth--; if (pdepth === 0) { j++; break; } }
  }
  const braceStart = src.indexOf('{', j);
  if (braceStart === -1) throw new Error(`Could not find opening brace for function ${name}`);
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

function extractConst(src: string, name: string): string {
  const re = new RegExp(`const\\s+${name}\\s*=.*?;`, 's');
  const m = re.exec(src);
  if (!m) throw new Error(`Could not find const ${name} in index.html — has it been renamed/removed?`);
  return m[0];
}

async function main() {
  if (!fs.existsSync(INDEX_HTML_PATH)) {
    console.error(`[relational-frontend-guard] index.html not found at ${INDEX_HTML_PATH} — set INDEX_HTML_PATH.`);
    process.exit(1);
  }
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const startMarker = '<script type="text/babel" data-presets="react-classic">';
  const startIdx = html.indexOf(startMarker);
  const endIdx = html.lastIndexOf('</script>');
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    throw new Error('Could not locate the main <script type="text/babel"> block in index.html');
  }
  const appSrc = html.slice(startIdx + startMarker.length, endIdx);

  const extracted = [
    extractConst(appSrc, 'relationalAuthoritativeSectionsRef'),
    extractFunction(appSrc, 'isRelationalAuthoritative'),
    extractFunction(appSrc, 'assertNoUnwiredRelationalSections'),
  ].join('\n\n');

  const sandbox: any = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const runnable = `${extracted}\nglobalThis.__api = { relationalAuthoritativeSectionsRef, isRelationalAuthoritative, assertNoUnwiredRelationalSections };`;
  try {
    vm.runInContext(runnable, sandbox, { filename: 'index.html-extracted-guard.js' });
  } catch (e: any) {
    console.error('[relational-frontend-guard] Extracted source failed to evaluate — index.html likely changed shape:', e.message);
    process.exit(1);
  }
  const api = sandbox.__api;

  console.log('\n[1] Default state — nothing relational-authoritative yet');
  api.relationalAuthoritativeSectionsRef.current = [];
  ok(api.isRelationalAuthoritative('jobs') === false, 'isRelationalAuthoritative("jobs") is false by default');
  let threw = false;
  try { api.assertNoUnwiredRelationalSections(['jobs', 'quotes', 'customers'], 'test'); } catch (e) { threw = true; }
  ok(!threw, 'guard does not throw for any section list when nothing is cut over');

  console.log('\n[2] "jobs" becomes relational-authoritative');
  api.relationalAuthoritativeSectionsRef.current = ['jobs'];
  ok(api.isRelationalAuthoritative('jobs') === true, 'isRelationalAuthoritative("jobs") reflects the ref immediately');
  ok(api.isRelationalAuthoritative('quotes') === false, 'an unrelated section is still reported as not authoritative');

  threw = false; let msg = '';
  try { api.assertNoUnwiredRelationalSections(['jobs'], 'forceSaveSections'); } catch (e: any) { threw = true; msg = e.message; }
  ok(threw && /jobs/.test(msg), 'a save touching ONLY the cut-over section throws, mentioning it by name', msg);

  threw = false;
  try { api.assertNoUnwiredRelationalSections(['quotes', 'jobs', 'customers'], 'mergeAndSave'); } catch (e) { threw = true; }
  ok(threw, 'a save touching the cut-over section ALONGSIDE unrelated sections still throws (mirrors real overrides/changed shape)');

  threw = false;
  try { api.assertNoUnwiredRelationalSections(['quotes', 'customers'], 'forceSaveSections'); } catch (e) { threw = true; }
  ok(!threw, 'a save that never touches the cut-over section is completely unaffected');

  console.log('\n[3] Multiple sections cut over at once');
  api.relationalAuthoritativeSectionsRef.current = ['jobs', 'quickRates'];
  threw = false; msg = '';
  try { api.assertNoUnwiredRelationalSections(['quotes', 'quickRates'], 'forceSaveSections'); } catch (e: any) { threw = true; msg = e.message; }
  ok(threw && /quickRates/.test(msg), 'guard correctly identifies WHICH of several cut-over sections is being touched', msg);

  console.log('\n[4] Empty/undefined section list never throws (defensive)');
  threw = false;
  try { api.assertNoUnwiredRelationalSections([], 'x'); api.assertNoUnwiredRelationalSections(undefined, 'x'); } catch (e) { threw = true; }
  ok(!threw, 'an empty or undefined section list is a no-op, never throws');

  console.log('\n============================================================');
  console.log(`${passed} passed, ${failures} failed`);
  console.log('============================================================');
  if (failures > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
