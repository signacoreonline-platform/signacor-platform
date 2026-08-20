/**
 * proforma-frontend-logic.test.ts — 2026-08-20 forward-only PRO-#####
 * proforma numbering: frontend pure-logic regression suite.
 *
 * The PRO<->INV derivation, the "reserve a proforma number" action, and the
 * "consume this reservation at finalisation without minting a second
 * number" decision all live in index.html (a single-file React app, no
 * build step — see project instructions). This test does NOT reimplement
 * that logic to test it; it extracts the ACTUAL function source for:
 *   - invoiceNumberToProformaNumber
 *   - proformaToReservedInvoiceNumber
 *   - reserveProformaNumber
 *   - invoiceNumberExists
 *   - resolveProformaInvoiceNumber
 *   - reserveInvoiceNumber / authHeaders / getAuthToken / setAuthToken
 *     (dependencies of the above)
 * out of the real index.html, transpiles the surrounding JSX with
 * @babel/standalone-equivalent tooling only insofar as needed to get a
 * clean parse (these particular functions contain no JSX themselves), and
 * evaluates them in a Node `vm` sandbox with `fetch` wired to a REAL
 * running instance of this backend (see hardening.stress.ts's login/BASE
 * pattern) — the same combination proved out interactively while building
 * this feature. If a future edit to index.html renames or removes any of
 * these functions, this test fails loudly at extraction time rather than
 * silently testing stale/reimplemented logic.
 *
 * Requires:
 *   - a real running instance of this backend (TEST_SERVER_URL), same as
 *     hardening.stress.ts / proforma-numbering.stress.ts;
 *   - INDEX_HTML_PATH pointing at the repo's index.html (defaults to
 *     ../../index.html, i.e. the repo root from backend/test/).
 *
 * Usage (from backend/):
 *   TEST_SERVER_URL=http://localhost:4001 \
 *   TEST_LOGIN_EMAIL=test@signacore.local TEST_LOGIN_PASSWORD=testpass \
 *   npx ts-node --transpile-only test/proforma-frontend-logic.test.ts
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const BASE = process.env.TEST_SERVER_URL || 'http://localhost:4001';
const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH || path.resolve(__dirname, '..', '..', 'index.html');

let failures = 0;
let passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

// Pulls a named top-level `function NAME(` / `async function NAME(` block
// out of the script by brace-matching from its own source, independent of
// exact line numbers (robust to unrelated edits elsewhere in the file).
function extractFunction(src: string, name: string): string {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) throw new Error(`Could not find function ${name} in index.html — has it been renamed/removed?`);
  const start = m.index;
  // Skip past the parameter list first (which may itself contain
  // destructuring braces, e.g. `function f(quote, { jobs, quotes }) {`) by
  // balancing PARENS from the name's own '(' before looking for the
  // function BODY's opening brace — otherwise a destructured parameter's
  // braces are mistaken for the body and the extraction truncates there.
  const parenStart = src.indexOf('(', m.index);
  if (parenStart === -1) throw new Error(`Could not find parameter list for function ${name}`);
  let pdepth = 0;
  let j = parenStart;
  for (; j < src.length; j++) {
    if (src[j] === '(') pdepth++;
    else if (src[j] === ')') {
      pdepth--;
      if (pdepth === 0) { j++; break; }
    }
  }
  const braceStart = src.indexOf('{', j);
  if (braceStart === -1) throw new Error(`Could not find opening brace for function ${name}`);
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
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
    console.error(`[proforma-frontend-logic] index.html not found at ${INDEX_HTML_PATH} — set INDEX_HTML_PATH.`);
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
    extractConst(appSrc, 'API_DOC_NUMBER_RESERVE_URL'),
    extractFunction(appSrc, 'getAuthToken'),
    extractFunction(appSrc, 'setAuthToken'),
    extractFunction(appSrc, 'authHeaders'),
    extractFunction(appSrc, 'forceLogoutExpiredSession'),
    extractFunction(appSrc, 'reserveInvoiceNumber'),
    extractFunction(appSrc, 'invoiceNumberToProformaNumber'),
    extractFunction(appSrc, 'proformaToReservedInvoiceNumber'),
    extractFunction(appSrc, 'reserveProformaNumber'),
    extractFunction(appSrc, 'invoiceNumberExists'),
    extractFunction(appSrc, 'findSourceQuoteForJob'),
    extractFunction(appSrc, 'resolveProformaInvoiceNumber'),
  ].join('\n\n');

  const store: Record<string, string> = {};
  const sandbox: any = {
    console,
    fetch,
    localStorage: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    },
    window: { SIGNACORE_API_URL: `${BASE}/api` },
    SGR_TOKEN_KEY: 'sgr_token_test',
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const runnable = `${extracted}\nglobalThis.__api = { reserveInvoiceNumber, invoiceNumberToProformaNumber, proformaToReservedInvoiceNumber, reserveProformaNumber, invoiceNumberExists, findSourceQuoteForJob, resolveProformaInvoiceNumber, setAuthToken };`;

  try {
    vm.runInContext(runnable, sandbox, { filename: 'index.html-extracted.js' });
  } catch (e: any) {
    console.error('[proforma-frontend-logic] Extracted source failed to evaluate — index.html likely changed shape:', e.message);
    process.exit(1);
  }
  const api = sandbox.__api;

  // Real login against a real running backend, so reserveProformaNumber
  // below performs a genuine atomic reservation, not a mock.
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.TEST_LOGIN_EMAIL || 'test@signacore.local',
      password: process.env.TEST_LOGIN_PASSWORD || 'testpass',
    }),
  });
  const loginBody = await loginRes.json();
  ok(loginRes.ok && !!loginBody.token, 'live login against the real backend succeeds (needed for reserveProformaNumber below)');
  api.setAuthToken(loginBody.token);

  console.log('\n[1] invoiceNumberToProformaNumber / proformaToReservedInvoiceNumber — pure derivation');
  ok(api.invoiceNumberToProformaNumber('INV-00042') === 'PRO-00042', 'INV-00042 -> PRO-00042');
  ok(api.invoiceNumberToProformaNumber('inv-00042') === 'PRO-00042', 'case-insensitive INV match');
  ok(api.invoiceNumberToProformaNumber('SQ-00042') === null, 'non-INV input -> null');
  ok(api.proformaToReservedInvoiceNumber('PRO-00042') === 'INV-00042', 'PRO-00042 -> INV-00042');
  ok(api.proformaToReservedInvoiceNumber('INV-00033') === 'INV-00033', 'legacy INV-00033 proformaNum passes through unchanged (2026-08-17 rule preserved)');
  ok(api.proformaToReservedInvoiceNumber('') === null, 'empty proformaNum -> null (implies no reservation)');

  console.log('\n[2] reserveProformaNumber() reserves from the REAL atomic invoice pool, then derives PRO-#####');
  const r1 = await api.reserveProformaNumber('1');
  ok(!r1.error && /^PRO-\d{5,}$/.test(r1.number), 'returns a PRO-##### number', r1);
  ok(api.proformaToReservedInvoiceNumber(r1.number) === r1.reservedInvoiceNumber, 'the returned reservedInvoiceNumber is exactly what the PRO suffix derives to', r1);
  const r2 = await api.reserveProformaNumber('1');
  ok(!r2.error && r2.number !== r1.number, 'two calls in a row never return the same PRO number — no frontend max()+1, backend counter genuinely advances', { r1, r2 });

  console.log('\n[3] resolveProformaInvoiceNumber() — finalisation consumes the existing reservation, never mints a second number');
  const quotePro = { id: 'Q-LIVE-1', num: 'SQ-LIVE-1', co: '1', proformaNum: r1.number };
  const decision = api.resolveProformaInvoiceNumber(quotePro, { jobs: [], accInvoices: [], quotes: [quotePro] });
  ok(decision.number === r1.reservedInvoiceNumber, 'PRO-##### finalises to EXACTLY its reserved INV-##### — no second reservation call happens here (this function never calls fetch)', decision);

  console.log('\n[4] resolveProformaInvoiceNumber() blocks unsafe reuse');
  const blockedByRealInvoice = api.resolveProformaInvoiceNumber(quotePro, { jobs: [{ invoiceNum: r1.reservedInvoiceNumber }], accInvoices: [], quotes: [quotePro] });
  ok(blockedByRealInvoice.blocked === true, 'blocked when the derived invoice number is already used by a real job invoice', blockedByRealInvoice);

  const quoteA = { id: 'Q-A', num: 'SQ-A', co: '1', proformaNum: 'PRO-00099' };
  const quoteB = { id: 'Q-B', num: 'SQ-B', co: '1', proformaNum: 'PRO-00099' };
  const dupDecision = api.resolveProformaInvoiceNumber(quoteA, { jobs: [], accInvoices: [], quotes: [quoteA, quoteB] });
  ok(dupDecision.blocked === true, 'blocked when two quotes independently carry PRO reservations that derive the same invoice number', dupDecision);

  console.log('\n[5] resolveProformaInvoiceNumber() non-regression: legacy + no-proforma quotes behave exactly as before');
  const legacyQuote = { id: 'Q-LEGACY', num: 'SQ-LEGACY', co: '1', proformaNum: 'INV-00033' };
  const legacyDecision = api.resolveProformaInvoiceNumber(legacyQuote, { jobs: [], accInvoices: [], quotes: [legacyQuote] });
  ok(legacyDecision.number === 'INV-00033', 'legacy INV-style proformaNum still resolves to itself, unchanged since 2026-08-17', legacyDecision);

  const plainQuote = { id: 'Q-PLAIN', num: 'SQ-PLAIN', co: '1' };
  const plainDecision = api.resolveProformaInvoiceNumber(plainQuote, { jobs: [], accInvoices: [], quotes: [plainQuote] });
  ok(plainDecision.number === null && !plainDecision.blocked, 'a quote with no proformaNum at all (the default/majority case) is a pure no-op, falls back to reserveInvoiceNumber()', plainDecision);

  console.log('\n[6] invoiceNumberExists() frontend safeguard also recognises a PRO reservation');
  const guardQuote = { id: 'Q-GUARD', num: 'SQ-GUARD', co: '1', proformaNum: r2.number };
  ok(api.invoiceNumberExists(r2.reservedInvoiceNumber, '1', [], [], [guardQuote]) === true, 'invoiceNumberExists() true for the INV number implied by a PRO proformaNum');
  ok(api.invoiceNumberExists(r2.reservedInvoiceNumber, '1', [], [], [guardQuote], 'Q-GUARD') === false, 'invoiceNumberExists() excludes the quote\'s own reservation via excludeQuoteId, matching resolveProformaInvoiceNumber\'s own reuse path');

  console.log(`\n${'='.repeat(60)}\n${passed} passed, ${failures} failed\n${'='.repeat(60)}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[proforma-frontend-logic] Fatal error:', err);
  process.exit(1);
});
