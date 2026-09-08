#!/usr/bin/env node
/* ============================================================================
 * audit-holdings-transaction-links.js
 * Signacore — READ-ONLY forensic audit of the SIGNACORE HOLDINGS
 * Quote -> Job -> Invoice transaction chain.
 *
 * Created 2026-09-08 for the "Holdings documents are linked to the wrong
 * Jobs / Quotes / Invoices" investigation.
 * ============================================================================
 *
 * SCOPE
 *   SIGNACORE HOLDINGS ONLY. Every Holdings quote, job and invoice is walked
 *   and its chain reconstructed. Records belonging to another company are
 *   read ONLY when (a) a Holdings record's own link points at them, or
 *   (b) they share a document number with a Holdings record and could
 *   therefore be picked up by one of the frontend's number-based lookups.
 *   Nothing else about the other company is analysed or reported.
 *
 * THIS SCRIPT IS STRICTLY READ ONLY
 *   * Every statement it issues is a SELECT or a catalog/introspection read.
 *     There is no write statement of any kind anywhere in this file.
 *   * All work happens inside BEGIN TRANSACTION READ ONLY, so PostgreSQL
 *     itself refuses any write even if one were somehow introduced.
 *   * It always ends with ROLLBACK.
 *   * It makes no temp tables, no views, no server-side state.
 *   * A static self-guard (selfGuard() below) scans this file's own source
 *     for write SQL before a single query is sent, and aborts if it finds any.
 *   * It never prints DATABASE_URL, a password, or any credential.
 *   Safe to run against production. It changes nothing and locks nothing.
 *
 * HOW TO RUN (PowerShell, from the repo root)
 *   cd backend
 *   $env:DATABASE_URL = "<your production connection string>"
 *   node scripts/audit-holdings-transaction-links.js
 *
 *   Optional flags:
 *     --out <path>    report text file (default holdings-transaction-link-audit.txt)
 *     --limit <n>     max detail rows per section (default 500)
 *
 *   Alongside the text report it writes, next to it:
 *     holdings-transaction-link-audit.json
 *     holdings-transaction-link-audit.csv
 *   Local diagnostic files only. Nothing is ever written back to the database.
 *
 * HOLDINGS IDENTIFICATION — NEVER GUESSED
 *   The Holdings company identifier is parsed at runtime out of the live
 *   application source, from the two places that actually define it:
 *     1. index.html            const HOLDINGS_CO_ID = <n>;
 *     2. backend/src/routes/documentNumbers.ts   VALID_COMPANIES = [...]
 *   If index.html cannot be found or the constant cannot be parsed, this
 *   script REFUSES to run rather than assuming a value. If the parsed id is
 *   not present in VALID_COMPANIES, it refuses as well.
 *
 * WHICH STORE IS AUTHORITATIVE
 *   The platform has two stores for the same records:
 *     - platform_state.data  (the JSON blob; sections quotes / jobs /
 *       accInvoices) — authoritative unless a section has been cut over
 *     - rel_quotes / rel_jobs / rel_invoices — authoritative ONLY when BOTH
 *       relational_cutover.enabled is true for that section AND the backend
 *       env var RELATIONAL_AUTHORITY_ENABLED is 'true'
 *       (see backend/src/relational/cutover.ts).
 *   The env half is not visible from a database connection, so this script
 *   reads and prints the relational_cutover rows and audits BOTH stores,
 *   then cross-compares them. It never assumes which one the app is serving.
 * ==========================================================================*/

'use strict';

const fs = require('fs');
const path = require('path');

/* ────────────────────────────────────────────────────────────────────────
 * STATIC SELF-GUARD — runs before anything else, including before the
 * database driver is loaded. Strips comments and quoted strings from this
 * file's own source, then scans what remains (real code plus the backtick
 * template literals that hold every SQL statement) for write keywords. The
 * keyword table is assembled from fragments at runtime so the guard can
 * never match itself.
 * ──────────────────────────────────────────────────────────────────────── */
function selfGuard() {
  let src;
  try {
    src = fs.readFileSync(__filename, 'utf8');
  } catch (e) {
    console.error('Self-guard could not read this script to verify it. Aborting.');
    process.exit(2);
  }
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')          // block comments
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")       // single-quoted strings
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')       // double-quoted strings
    .replace(/\/\/[^\n]*/g, ' ');                // line comments
  const banned = [
    ['INS', 'ERT'], ['UPD', 'ATE'], ['DEL', 'ETE'], ['MER', 'GE'],
    ['ALT', 'ER'], ['DR', 'OP'], ['TRUNC', 'ATE'], ['GR', 'ANT'],
    ['REV', 'OKE'], ['CRE', 'ATE'], ['COMM', 'IT'], ['VAC', 'UUM'],
    ['REIND', 'EX'], ['REFR', 'ESH'], ['C', 'OPY'], ['CALL'],
  ].map((p) => p.join(''));
  const hits = [];
  for (const kw of banned) {
    const re = new RegExp('\\b' + kw + '\\b', 'ig');
    let m;
    while ((m = re.exec(stripped)) !== null) hits.push(kw + ' @ offset ' + m.index);
  }
  if (hits.length) {
    console.error('SELF-GUARD FAILED — write SQL detected in this audit script:');
    for (const h of hits) console.error('  ' + h);
    console.error('This script refuses to connect. Nothing was executed.');
    process.exit(2);
  }
  return banned.length;
}
const GUARD_KEYWORDS = selfGuard();

let Pool;
try {
  ({ Pool } = require('pg'));
} catch (e) {
  console.error('Could not load the "pg" driver.\n' +
    'Run this from the backend folder (where node_modules lives):\n' +
    '  cd backend\n  node scripts/audit-holdings-transaction-links.js');
  process.exit(1);
}
try { require('dotenv').config(); } catch (e) { /* .env is optional */ }

/* ── args ───────────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}
const ROW_LIMIT = Number(argValue('--limit', '500')) || 500;
const SELF_TEST = argValue('--self-test', null);
const OUT_PATH = path.resolve(argValue('--out',
  path.join(process.cwd(), 'holdings-transaction-link-audit.txt')));
const JSON_PATH = OUT_PATH.replace(/\.txt$/i, '') + '.json';
const CSV_PATH = OUT_PATH.replace(/\.txt$/i, '') + '.csv';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL && !SELF_TEST) {
  console.error('DATABASE_URL is not set.\n\nPowerShell:\n' +
    '  $env:DATABASE_URL = "<connection string>"\n' +
    '  node scripts/audit-holdings-transaction-links.js');
  process.exit(1);
}

// Same SSL decision the backend itself makes (src/db/ssl.ts resolveSsl).
function resolveSsl(url) {
  if (!url) return undefined;
  return /render\.com|\.com\/|sslmode=require/i.test(url) ? { rejectUnauthorized: false } : undefined;
}

// Host / port / database / user only. The password is never read, never
// stored, never printed.
function describeTargetSafely(url) {
  try {
    const u = new URL(url);
    return {
      host: u.hostname || '(unknown)',
      port: u.port || '5432',
      database: (u.pathname || '').replace(/^\//, '') || '(unknown)',
      user: u.username || '(unknown)',
    };
  } catch (e) {
    return { host: '(unparseable)', port: '', database: '(unparseable)', user: '' };
  }
}

/* ── output plumbing ────────────────────────────────────────────────────── */
const lines = [];
function out(s) { const t = s === undefined ? '' : String(s); lines.push(t); console.log(t); }
function hr(ch) { out((ch || '=').repeat(78)); }
function h1(t) { out(''); hr('='); out(t); hr('='); }
function h2(t) { out(''); out(t); hr('-'); }

function show(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
function table(rows, limit) {
  const cap = limit || ROW_LIMIT;
  if (!rows || !rows.length) { out('  (none)'); return; }
  const shown = rows.slice(0, cap);
  const cols = Object.keys(shown[0]);
  const w = cols.map((c) => Math.max(c.length, ...shown.map((r) => show(r[c]).length)));
  const sep = '+' + w.map((n) => '-'.repeat(n + 2)).join('+') + '+';
  out(sep);
  out('| ' + cols.map((c, i) => c.padEnd(w[i])).join(' | ') + ' |');
  out(sep);
  for (const r of shown) out('| ' + cols.map((c, i) => show(r[c]).padEnd(w[i])).join(' | ') + ' |');
  out(sep);
  out('(' + rows.length + ' row' + (rows.length === 1 ? '' : 's') +
    (rows.length > cap ? ('; showing first ' + cap + ' — raise with --limit') : '') + ')');
}

/* ── findings ledger ────────────────────────────────────────────────────── */
const findings = [];
/**
 * cls       error class (see the ERROR CLASSES table in the report)
 * severity  HIGH | MEDIUM | LOW
 * store     JSON | RELATIONAL | CROSS
 * verdict   DATA | DISPLAY | BOTH | UNDETERMINED   (the A/B/C/D question)
 * repair    HIGH_CONFIDENCE | AMBIGUOUS | UNDETERMINED | NONE
 */
function finding(cls, severity, store, entity, ref, detail, verdict, repair) {
  findings.push({
    cls, severity, store, entity,
    id: ref && ref.id !== undefined ? ref.id : null,
    num: ref && ref.num !== undefined ? ref.num : null,
    detail, verdict, repair: repair || 'UNDETERMINED',
  });
}
function countBy(key) {
  const m = new Map();
  for (const f of findings) m.set(f[key], (m.get(f[key]) || 0) + 1);
  return m;
}

/* ────────────────────────────────────────────────────────────────────────
 * HOLDINGS IDENTIFICATION — parsed from the live application source.
 * ──────────────────────────────────────────────────────────────────────── */
function identifyHoldings() {
  const roots = [
    path.resolve(__dirname, '..', '..'),   // backend/scripts -> repo root
    path.resolve(process.cwd(), '..'),     // run from backend/
    path.resolve(process.cwd()),           // run from repo root
  ];
  let indexPath = null;
  for (const r of roots) {
    const p = path.join(r, 'index.html');
    if (fs.existsSync(p)) { indexPath = p; break; }
  }
  if (!indexPath) {
    return { ok: false, reason: 'index.html could not be located from ' + __dirname +
      '. This audit refuses to assume a Holdings company id.' };
  }
  const src = fs.readFileSync(indexPath, 'utf8');
  const m = /const\s+HOLDINGS_CO_ID\s*=\s*([0-9]+)\s*;/.exec(src);
  if (!m) {
    return { ok: false, reason: 'HOLDINGS_CO_ID could not be parsed from ' + indexPath +
      '. This audit refuses to assume a Holdings company id.' };
  }
  const coNum = parseInt(m[1], 10);
  if (!Number.isFinite(coNum)) {
    return { ok: false, reason: 'HOLDINGS_CO_ID in ' + indexPath + ' is not a number.' };
  }

  // Corroborate against the backend's own valid-company list.
  let validCompanies = null;
  const dnPath = path.join(path.dirname(indexPath), 'backend', 'src', 'routes', 'documentNumbers.ts');
  if (fs.existsSync(dnPath)) {
    const dn = fs.readFileSync(dnPath, 'utf8');
    const vm = /VALID_COMPANIES\s*=\s*\[([^\]]*)\]/.exec(dn);
    if (vm) {
      validCompanies = vm[1].split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    }
  }
  if (validCompanies && !validCompanies.includes(String(coNum))) {
    return { ok: false, reason: 'HOLDINGS_CO_ID=' + coNum + ' parsed from index.html is NOT in the ' +
      'backend VALID_COMPANIES list [' + validCompanies.join(', ') + ']. The two sources disagree; ' +
      'this audit refuses to proceed.' };
  }

  // 2026-09-08: lift the SHIPPED company-safe resolvers straight out of
  // index.html and use them as the audit's model of application behaviour, so
  // this report can never drift from what the application actually does.
  const app = liftAppResolvers(src);

  // The frontend predicate, reproduced verbatim, and its loose twin.
  return {
    app,
    ok: true,
    indexPath,
    coNum,
    coStr: String(coNum),
    validCompanies,
    // isHoldingsRecord(rec) in index.html: rec.co === HOLDINGS_CO_ID (strict)
    strict: (rec) => !!rec && rec.co === coNum,
    // what the record actually IS, regardless of the strict predicate's typing
    loose: (rec) => !!rec && rec.co !== null && rec.co !== undefined && rec.co !== '' &&
      String(rec.co).trim() === String(coNum),
  };
}

/* ── lift the shipped resolvers out of index.html ────────────────────────
   Same masking/brace-matching technique as
   backend/test/holdings-company-scoped-links.test.js. Read-only: this parses
   text, evaluates a handful of pure functions, and touches no database. If the
   functions cannot be lifted (e.g. an index.html predating the 2026-09-08
   company-safe repair) this returns null and the audit still runs, reporting
   the application-resolution model as unavailable rather than guessing. */
function maskForCounting(src) {
  const out = src.split(''); let i = 0; const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') { out[i] = ' '; i++; } continue; }
    if (c === '/' && d === '*') { out[i] = ' '; out[i+1] = ' '; i += 2; while (i < n && !(src[i] === '*' && src[i+1] === '/')) { out[i] = ' '; i++; } if (i < n) { out[i] = ' '; out[i+1] = ' '; i += 2; } continue; }
    if (c === '"' || c === "'" || c === '\u0060') {
      const q = c; out[i] = ' '; i++;
      while (i < n) {
        if (src[i] === '\\') { out[i] = ' '; out[i+1] = ' '; i += 2; continue; }
        if (src[i] === q) { out[i] = ' '; i++; break; }
        out[i] = ' '; i++;
      }
      continue;
    }
    i++;
  }
  return out.join('');
}
function liftAppResolvers(html) {
  const OPEN = '<script type="text/babel" data-presets="react-classic">';
  const at = html.indexOf(OPEN);
  if (at < 0) return null;
  const body = html.slice(at + OPEN.length, html.lastIndexOf('</script>'));
  function fn(name) {
    const decl = '\nfunction ' + name + '(';
    const i = body.indexOf(decl);
    if (i < 0) return null;
    const win = body.slice(i + 1, i + 20001);
    const wm = maskForCounting(win);
    const open = wm.indexOf('{');
    if (open < 0) return null;
    let depth = 0;
    for (let k = open; k < wm.length; k++) {
      if (wm[k] === '{') depth++;
      else if (wm[k] === '}') { depth--; if (depth === 0) return win.slice(0, k + 1); }
    }
    return null;
  }
  function cst(name) {
    const wm = maskForCounting(body);
    const m = new RegExp('const\\s+' + name + '\\s*=').exec(wm);
    if (!m) return null;
    return body.slice(m.index, wm.indexOf(';', m.index) + 1);
  }
  const names = ['companyTagOf', 'sameCompany', 'jobHasId', 'resolveJobsForQuote',
    'resolveJobForQuote', 'resolveQuoteForJob', 'resolveQuoteForInvoice'];
  const parts = [cst('HOLDINGS_CO_ID'), cst('HOLDINGS_CO_KEY')];
  for (const nm of names) parts.push(fn(nm));
  if (parts.some((p) => !p)) return null;
  parts.push('return {' + names.join(',') + '};');
  try { return new Function(parts.join('\n'))(); } catch (e) { return null; }
}

/* ── small helpers mirroring the app's own normalisation ─────────────────── */
const norm = (v) => (v === null || v === undefined) ? '' : String(v).trim().toUpperCase();
const sid = (v) => (v === null || v === undefined) ? null : String(v);
const isLive = (i) => !!i && i.status !== 'void';

/* ════════════════════════════════════════════════════════════════════════
 * MAIN
 * ══════════════════════════════════════════════════════════════════════ */
(async function main() {
  const HOLD = identifyHoldings();

  h1('SIGNACORE — HOLDINGS TRANSACTION-LINK AUDIT (READ ONLY)');
  out('Run at             : ' + new Date().toISOString());
  out('Script             : ' + __filename);
  out('Self-guard         : PASSED — ' + GUARD_KEYWORDS +
    ' write-SQL keyword families scanned, zero found in this file.');
  out('Mode               : READ ONLY (BEGIN TRANSACTION READ ONLY ... ROLLBACK)');

  h2('1. HOLDINGS COMPANY IDENTIFICATION');
  if (!HOLD.ok) {
    out('REFUSING TO PROCEED.');
    out('  ' + HOLD.reason);
    out('');
    out('Nothing was queried. No connection was opened.');
    flush();
    process.exit(3);
  }
  out('Source of truth    : ' + HOLD.indexPath);
  out('  const HOLDINGS_CO_ID = ' + HOLD.coNum + ';');
  out('Holdings co / company_code : ' + HOLD.coNum + '  (JSON `co`) / "' + HOLD.coStr +
    '"  (rel_*.company_code TEXT)');
  if (HOLD.validCompanies) {
    out('Corroborated by    : backend VALID_COMPANIES = [' + HOLD.validCompanies.join(', ') + ']  — contains ' + HOLD.coStr + ' OK');
  } else {
    out('Corroborated by    : (documentNumbers.ts not found next to index.html — proceeding on index.html alone)');
  }
  out('Frontend predicate : isHoldingsRecord(rec) => rec.co === ' + HOLD.coNum + '   (STRICT ===, so a');
  out('                     record storing co as the STRING "' + HOLD.coStr + '" fails this test.)');
  out('Resolution model   : ' + (HOLD.app
    ? 'LIVE — company-safe resolvers lifted from index.html (resolveQuoteForJob / resolveJobsForQuote).'
    : 'UNAVAILABLE — the company-safe resolvers could not be lifted from index.html. Link'));
  if (!HOLD.app) out('                     integrity is still audited; application-resolution findings are skipped.');

  if (SELF_TEST) {
    h2("SELF-TEST MODE — no database connection is opened, no query is sent");
    out("Fixture: " + SELF_TEST);
    const fx = JSON.parse(fs.readFileSync(SELF_TEST, "utf8"));
    auditJsonStore({
      updatedAt: null,
      quotes: Array.isArray(fx.quotes) ? fx.quotes : [],
      jobs: Array.isArray(fx.jobs) ? fx.jobs : [],
      accInvoices: Array.isArray(fx.accInvoices) ? fx.accInvoices : [],
    }, HOLD);
    h2("SELF-TEST — findings by error class");
    const m = countBy("cls");
    table([...m.entries()].sort((x,y)=>y[1]-x[1]).map(([cls, n]) => ({ error_class: cls, count: n })), 100);
    flush();
    return;
  }
  const target = describeTargetSafely(DATABASE_URL);
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: resolveSsl(DATABASE_URL), max: 2 });
  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    out('');
    out('Could not connect: ' + ((err && err.message) || String(err)));
    out('(Host ' + target.host + ':' + target.port + ', database ' + target.database + ', user ' + target.user + ')');
    flush();
    await pool.end().catch(() => {});
    process.exit(1);
  }

  try {
    await client.query('BEGIN TRANSACTION READ ONLY');

    /* ── 2. DATABASE IDENTITY ─────────────────────────────────────────── */
    h2('2. DATABASE IDENTIFIED');
    const ident = await client.query(
      'SELECT current_database() AS db, current_user AS usr, version() AS ver, ' +
      'inet_server_addr()::text AS srv, current_setting(\'server_version\') AS sv, ' +
      'pg_postmaster_start_time() AS started, now() AS now_at'
    );
    const idr = ident.rows[0] || {};
    out('Host (from DATABASE_URL) : ' + target.host + ':' + target.port);
    out('Database                 : ' + idr.db);
    out('Connected as             : ' + idr.usr);
    out('Server address           : ' + (idr.srv || '(not exposed)'));
    out('PostgreSQL               : ' + idr.sv);
    out('Server time              : ' + show(idr.now_at));
    out('');
    out('NOTE: the connection string itself, and any password in it, is never read,');
    out('      logged or written to any output file by this script.');

    const txn = await client.query('SELECT current_setting(\'transaction_read_only\') AS ro');
    out('Transaction read_only    : ' + txn.rows[0].ro + '   <- PostgreSQL will reject any write');

    /* ── 3. WHICH STORE IS AUTHORITATIVE ──────────────────────────────── */
    h2('3. STORE AUTHORITY (relational cutover state)');
    const haveTable = async (t) => {
      const r = await client.query('SELECT to_regclass($1) AS reg', ['public.' + t]);
      return !!r.rows[0].reg;
    };
    const hasCutover = await haveTable('relational_cutover');
    const hasRelQuotes = await haveTable('rel_quotes');
    const hasRelJobs = await haveTable('rel_jobs');
    const hasRelInvoices = await haveTable('rel_invoices');
    const hasPlatformState = await haveTable('platform_state');

    let cutoverRows = [];
    if (hasCutover) {
      const c = await client.query(
        'SELECT section, enabled, enabled_at, enabled_by FROM relational_cutover ' +
        'WHERE section IN (\'quotes\',\'jobs\',\'accInvoices\',\'payments\') ORDER BY section'
      );
      cutoverRows = c.rows;
      table(cutoverRows);
    } else {
      out('  relational_cutover table not present.');
    }
    const cutEnabled = new Set(cutoverRows.filter((r) => r.enabled === true).map((r) => r.section));
    out('');
    out('Tables present: platform_state=' + hasPlatformState + '  rel_quotes=' + hasRelQuotes +
      '  rel_jobs=' + hasRelJobs + '  rel_invoices=' + hasRelInvoices);
    out('A section is relational-authoritative ONLY if the row above says enabled AND the');
    out('backend env var RELATIONAL_AUTHORITY_ENABLED is "true". The env half is NOT visible');
    out('from a database connection, so BOTH stores are audited below and cross-compared.');

    /* ── 4. LOAD THE JSON STORE ───────────────────────────────────────── */
    let J = null;
    if (hasPlatformState) {
      const psMeta = await client.query('SELECT id, updated_at FROM platform_state ORDER BY id');
      const psRow = await client.query('SELECT data FROM platform_state WHERE id = 1');
      const data = (psRow.rows[0] && psRow.rows[0].data) || null;
      if (data) {
        J = {
          updatedAt: (psMeta.rows.find((r) => Number(r.id) === 1) || {}).updated_at || null,
          quotes: Array.isArray(data.quotes) ? data.quotes : [],
          jobs: Array.isArray(data.jobs) ? data.jobs : [],
          accInvoices: Array.isArray(data.accInvoices) ? data.accInvoices : [],
        };
      }
    }

    /* ══════════════════════════════════════════════════════════════════
     * PART A — AUDIT OF platform_state.data (the JSON store)
     * ════════════════════════════════════════════════════════════════ */
    let jsonSummary = null;
    if (J) {
      jsonSummary = auditJsonStore(J, HOLD);
    } else {
      h1('PART A — platform_state JSON STORE');
      out('platform_state row id=1 has no readable data. JSON audit skipped.');
    }

    /* ══════════════════════════════════════════════════════════════════
     * PART B — AUDIT OF THE RELATIONAL TABLES
     * ════════════════════════════════════════════════════════════════ */
    let relSummary = null;
    if (hasRelQuotes && hasRelJobs && hasRelInvoices) {
      relSummary = await auditRelationalStore(client, HOLD);
    } else {
      h1('PART B — RELATIONAL STORE (rel_quotes / rel_jobs / rel_invoices)');
      out('Relational tables are not all present. Relational audit skipped.');
    }

    /* ══════════════════════════════════════════════════════════════════
     * PART C — CROSS-STORE COMPARISON
     * ════════════════════════════════════════════════════════════════ */
    if (jsonSummary && relSummary) {
      h1('PART C — JSON vs RELATIONAL CROSS-COMPARISON (Holdings only)');
      const rows = [
        { metric: 'Holdings quotes', json: jsonSummary.counts.quotes, relational: relSummary.counts.quotes },
        { metric: 'Holdings jobs', json: jsonSummary.counts.jobs, relational: relSummary.counts.jobs },
        { metric: 'Holdings invoices', json: jsonSummary.counts.invoices, relational: relSummary.counts.invoices },
      ];
      table(rows);
      for (const r of rows) {
        if (Number(r.json) !== Number(r.relational)) {
          finding('STORE_DIVERGENCE', 'MEDIUM', 'CROSS', 'store', { num: r.metric },
            r.metric + ': JSON has ' + r.json + ', relational has ' + r.relational +
            '. The two stores do not agree on how many Holdings records exist.',
            'UNDETERMINED', 'NONE');
        }
      }
      out('');
      out('If these disagree, one store is stale. That alone does not prove either is wrong —');
      out('it proves the app can show different answers depending on which one it is serving.');
    }

    /* ══════════════════════════════════════════════════════════════════
     * PART D — SUMMARY
     * ════════════════════════════════════════════════════════════════ */
    h1('PART D — SUMMARY');

    if (jsonSummary) {
      h2('Holdings record counts (JSON store — platform_state.data)');
      table([{
        holdings_quotes: jsonSummary.counts.quotes,
        holdings_jobs: jsonSummary.counts.jobs,
        holdings_invoices: jsonSummary.counts.invoices,
        clean_chains: jsonSummary.chains.clean,
        broken_chains: jsonSummary.chains.broken,
      }]);
    }
    if (relSummary) {
      h2('Holdings record counts (relational store)');
      table([{
        holdings_quotes: relSummary.counts.quotes,
        holdings_jobs: relSummary.counts.jobs,
        holdings_invoices: relSummary.counts.invoices,
      }]);
    }

    h2('Findings by error class');
    const byClass = countBy('cls');
    const classRows = [...byClass.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cls, n]) => {
        const sample = findings.find((f) => f.cls === cls);
        return { error_class: cls, count: n, worst_severity: worstSeverity(cls), verdict: sample ? sample.verdict : '' };
      });
    table(classRows, 100);

    h2('Findings by severity');
    const bySev = countBy('severity');
    table(['HIGH', 'MEDIUM', 'LOW'].map((s) => ({ severity: s, count: bySev.get(s) || 0 })), 10);

    h2('Findings by verdict — IS THE DATABASE WRONG, OR THE DISPLAY?');
    const byVerdict = countBy('verdict');
    table([
      { verdict: 'A. DATA — stored relational ids are actually wrong', count: byVerdict.get('DATA') || 0 },
      { verdict: 'B. DISPLAY — stored ids correct, app resolves wrong doc', count: byVerdict.get('DISPLAY') || 0 },
      { verdict: 'C. BOTH', count: byVerdict.get('BOTH') || 0 },
      { verdict: 'D. UNDETERMINED', count: byVerdict.get('UNDETERMINED') || 0 },
    ], 10);

    h2('Repair-candidate confidence (NO repair is performed by this script)');
    const byRepair = countBy('repair');
    table([
      { confidence: 'HIGH_CONFIDENCE', count: byRepair.get('HIGH_CONFIDENCE') || 0 },
      { confidence: 'AMBIGUOUS', count: byRepair.get('AMBIGUOUS') || 0 },
      { confidence: 'UNDETERMINED', count: byRepair.get('UNDETERMINED') || 0 },
      { confidence: 'NONE (informational)', count: byRepair.get('NONE') || 0 },
    ], 10);

    h2('ALL FINDINGS — DETAIL');
    if (!findings.length) {
      out('  No link defects detected in the Holdings scope.');
    } else {
      const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      const sorted = findings.slice().sort((a, b) =>
        (order[a.severity] - order[b.severity]) || a.cls.localeCompare(b.cls));
      table(sorted.map((f) => ({
        sev: f.severity, store: f.store, error_class: f.cls, entity: f.entity,
        id: f.id, num: f.num, verdict: f.verdict, repair: f.repair, detail: f.detail,
      })));
    }

    await client.query('ROLLBACK');
    out('');
    out('Transaction rolled back. Nothing was written.');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* already gone */ }
    out('');
    out('AUDIT FAILED: ' + ((err && err.message) || String(err)));
    if (err && err.stack) out(String(err.stack).split('\n').slice(0, 6).join('\n'));
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }

  flush();
})();

function worstSeverity(cls) {
  const sevs = findings.filter((f) => f.cls === cls).map((f) => f.severity);
  if (sevs.includes('HIGH')) return 'HIGH';
  if (sevs.includes('MEDIUM')) return 'MEDIUM';
  return 'LOW';
}

/* ════════════════════════════════════════════════════════════════════════
 * PART A IMPLEMENTATION — the JSON store
 *
 * This is where the decisive test lives. For every Holdings record we compute
 * TWO answers:
 *   correct  — resolved the company-safe way, relational id first
 *   asShown  — resolved EXACTLY the way index.html resolves it today,
 *              against the full unfiltered array, in stored array order
 * When those two differ, the stored link may be perfectly good and the screen
 * still shows the wrong document. That is verdict B (DISPLAY). When the stored
 * link itself points somewhere impossible, that is verdict A (DATA).
 * ══════════════════════════════════════════════════════════════════════ */
function auditJsonStore(J, HOLD) {
  h1('PART A — platform_state JSON STORE (authoritative unless cut over)');
  out('platform_state.updated_at : ' + show(J.updatedAt));
  out('Array sizes (all companies): quotes=' + J.quotes.length + '  jobs=' + J.jobs.length +
    '  accInvoices=' + J.accInvoices.length);

  const HQ = J.quotes.filter(HOLD.loose);
  const HJ = J.jobs.filter(HOLD.loose);
  const HI = J.accInvoices.filter(HOLD.loose);

  out('Holdings (co=' + HOLD.coNum + ')      : quotes=' + HQ.length + '  jobs=' + HJ.length +
    '  invoices=' + HI.length);

  /* ── A0. `co` TYPE DRIFT ──────────────────────────────────────────────
     isHoldingsRecord uses ===, so a Holdings record whose `co` is the STRING
     "1" is invisible to Holdings users AND visible to everyone else. */
  h2('A0. Holdings `co` value types (strict === vs actual value)');
  const typeRows = [];
  for (const [label, list] of [['quotes', HQ], ['jobs', HJ], ['invoices', HI]]) {
    const strict = list.filter(HOLD.strict).length;
    const drifted = list.length - strict;
    typeRows.push({ section: label, holdings_records: list.length, co_is_number: strict, co_is_not_number: drifted });
    if (drifted > 0) {
      for (const r of list.filter((x) => !HOLD.strict(x))) {
        finding('CO_TYPE_DRIFT', 'HIGH', 'JSON', label,
          { id: r.id, num: r.num || r.number },
          'co is stored as ' + JSON.stringify(r.co) + ' (' + typeof r.co + '), not the number ' +
          HOLD.coNum + '. index.html isHoldingsRecord uses strict === so this record is hidden ' +
          'from Holdings users and exposed to non-Holdings users.',
          'DATA', 'HIGH_CONFIDENCE');
      }
    }
  }
  table(typeRows, 10);

  /* ── indexes ──────────────────────────────────────────────────────── */
  const quoteById = new Map(J.quotes.map((q) => [sid(q && q.id), q]));
  const jobById = new Map(J.jobs.map((j) => [sid(j && j.id), j]));
  const invById = new Map(J.accInvoices.map((i) => [sid(i && i.id), i]));

  const groupBy = (list, keyFn) => {
    const m = new Map();
    for (const r of list) {
      const k = keyFn(r);
      if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };
  const quotesByNum = groupBy(J.quotes, (q) => norm(q && q.num));
  const jobsByNum = groupBy(J.jobs, (j) => norm(j && j.num));
  const jobsByQuoteNum = groupBy(J.jobs, (j) => norm(j && j.quoteNum));
  const invByCoNum = groupBy(J.accInvoices.filter(isLive),
    (i) => (i.co === null || i.co === undefined || i.co === '') ? null : String(i.co).trim() + '|' + norm(i.number));
  const invByNum = groupBy(J.accInvoices.filter(isLive), (i) => norm(i && i.number));

  const idxOfQuote = new Map(J.quotes.map((q, n) => [q, n]));
  const idxOfJob = new Map(J.jobs.map((j, n) => [j, n]));

  /* ── A1. DOCUMENT-NUMBER COLLISION SURFACE ─────────────────────────── */
  h2('A1. DOCUMENT NUMBER COLLISIONS AFFECTING HOLDINGS');
  out('Quote numbers (SQ-) and invoice numbers (INV-) are minted PER COMPANY');
  out('(backend/src/routes/documentNumbers.ts: quote/invoice are per-company,');
  out('job/po/creditNote are GLOBAL). So the same SQ-/INV- number legitimately');
  out('exists in Holdings and in the other company. Job numbers (SNS-) cannot collide.');
  out('');

  // duplicates WITHIN Holdings
  const dupRows = [];
  for (const [label, list, field] of [['quote', HQ, 'num'], ['job', HJ, 'num'], ['invoice', HI, 'number']]) {
    const g = groupBy(list, (r) => norm(r && r[field]));
    for (const [n, recs] of g) {
      if (recs.length > 1) {
        dupRows.push({ doc: label, number: n, holdings_records: recs.length, ids: recs.map((r) => r.id).join(' ') });
        finding('DUPLICATE_NUMBER_WITHIN_HOLDINGS', 'HIGH', 'JSON', label, { num: n },
          n + ' is used by ' + recs.length + ' Holdings ' + label + ' records (ids ' +
          recs.map((r) => r.id).join(', ') + '). Any number-based lookup for this document is ambiguous.',
          'BOTH', 'AMBIGUOUS');
      }
    }
  }
  out('Duplicates WITHIN Holdings:');
  table(dupRows);

  // cross-company collisions that can actually mis-resolve a Holdings lookup
  out('');
  out('Cross-company number collisions that can mis-resolve a HOLDINGS lookup.');
  out('"first_in_array" is the record a bare .find() by number returns TODAY, in');
  out('stored array order — that is what the screen actually shows.');
  const collisionRows = [];
  for (const q of HQ) {
    const n = norm(q.num);
    if (!n) continue;
    const all = quotesByNum.get(n) || [];
    const foreign = all.filter((x) => !HOLD.loose(x));
    if (!foreign.length) continue;
    const first = all.slice().sort((a, b) => idxOfQuote.get(a) - idxOfQuote.get(b))[0];
    const active = !HOLD.loose(first);
    collisionRows.push({
      doc: 'quote', number: n, holdings_id: q.id,
      other_company_ids: foreign.map((f) => f.id + '(co=' + f.co + ')').join(' '),
      first_in_array: first === q ? 'HOLDINGS' : ('OTHER id=' + first.id),
      hazard: active ? 'ACTIVE' : 'latent',
    });
    finding('CROSS_COMPANY_NUMBER_COLLISION', active ? 'HIGH' : 'MEDIUM', 'JSON', 'quote',
      { id: q.id, num: q.num },
      'Quote number ' + n + ' also exists on ' + foreign.length + ' record(s) in another company (' +
      foreign.map((f) => 'id ' + f.id + ' co=' + f.co).join('; ') + '). ' +
      (active
        ? 'The OTHER company\'s quote sorts FIRST in the stored array, so every unscoped ' +
          '.find(q => q.num === ...) in index.html resolves to it instead of this Holdings quote.'
        : 'The Holdings quote currently sorts first, so unscoped lookups happen to land correctly today — ' +
          'but the ordering is incidental and any re-save can flip it.'),
      'DISPLAY', 'NONE');
  }
  for (const inv of HI) {
    const n = norm(inv.number);
    if (!n || !isLive(inv)) continue;
    const all = invByNum.get(n) || [];
    const foreign = all.filter((x) => !HOLD.loose(x));
    if (!foreign.length) continue;
    collisionRows.push({
      doc: 'invoice', number: n, holdings_id: inv.id,
      other_company_ids: foreign.map((f) => f.id + '(co=' + f.co + ')').join(' '),
      first_in_array: '(company-scoped resolver in use)', hazard: 'scoped',
    });
    finding('CROSS_COMPANY_NUMBER_COLLISION', 'MEDIUM', 'JSON', 'invoice',
      { id: inv.id, num: inv.number },
      'Invoice number ' + n + ' also exists in another company (' +
      foreign.map((f) => 'id ' + f.id + ' co=' + f.co).join('; ') + '). The job->invoice resolver ' +
      '(resolveJobInvoiceRecord / invoiceIdentityKey) IS company-scoped, so this is contained there; ' +
      'it is reported because any lookup that forgets the co prefix would mis-resolve it.',
      'UNDETERMINED', 'NONE');
  }
  table(collisionRows);

  /* ── A2. QUOTE -> JOB ─────────────────────────────────────────────── */
  h2('A2. HOLDINGS QUOTE -> JOB');
  out('Stored link : quote.convertedJobId  (a stable record id)');
  out('Reverse link: job.quoteNum          (a DOCUMENT NUMBER, not an id — and quote');
  out('              numbers are per-company, so this reverse link is not unique');
  out('              across companies. There is no job.quoteId in the JSON model.)');
  out('');
  const q2jRows = [];
  for (const q of HQ) {
    const row = { quote_id: q.id, quote_num: q.num, convertedJobId: q.convertedJobId === undefined ? '' : q.convertedJobId };

    // stored-id resolution
    const target = (q.convertedJobId !== null && q.convertedJobId !== undefined)
      ? jobById.get(sid(q.convertedJobId)) : null;

    // reverse claimants by number, across ALL companies
    const claimants = jobsByQuoteNum.get(norm(q.num)) || [];
    const holdClaim = claimants.filter(HOLD.loose);
    const foreignClaim = claimants.filter((x) => !HOLD.loose(x));

    // what index.html actually returns, using its OWN shipped resolver.
    const asShown = HOLD.app ? HOLD.app.resolveJobForQuote(q, J.jobs) : null;

    row.job_by_id = target ? (target.num + ' (id ' + target.id + ', co=' + target.co + ')') : (q.convertedJobId ? 'MISSING' : '');
    row.jobs_claiming_by_num = claimants.length ? claimants.map((j) => j.num + '/co=' + j.co).join(' ') : '';
    row.as_shown_by_app = asShown ? (asShown.num + ' (co=' + asShown.co + ')') : '';

    let status = 'OK';

    if (q.convertedJobId !== null && q.convertedJobId !== undefined) {
      if (!target) {
        status = 'BROKEN — orphan convertedJobId';
        finding('ORPHAN_LINK', 'HIGH', 'JSON', 'quote', { id: q.id, num: q.num },
          'Quote ' + q.num + ' convertedJobId=' + q.convertedJobId + ' points at a job record that does not exist.',
          'DATA', holdClaim.length === 1 ? 'HIGH_CONFIDENCE' : 'AMBIGUOUS');
      } else if (!HOLD.loose(target)) {
        status = 'BROKEN — cross-company';
        finding('CROSS_COMPANY_LINK', 'HIGH', 'JSON', 'quote', { id: q.id, num: q.num },
          'Holdings quote ' + q.num + ' convertedJobId=' + q.convertedJobId + ' points at job ' +
          target.num + ' which belongs to co=' + target.co + ', not Holdings.',
          'DATA', holdClaim.length === 1 ? 'HIGH_CONFIDENCE' : 'AMBIGUOUS');
      } else if (norm(target.quoteNum) !== norm(q.num)) {
        status = 'BROKEN — reciprocal mismatch';
        finding('QUOTE_JOB_ASYMMETRIC', 'HIGH', 'JSON', 'quote', { id: q.id, num: q.num },
          'Quote ' + q.num + ' (id ' + q.id + ') says its job is ' + target.num + ' (id ' + target.id +
          '), but job ' + target.num + ' says quoteNum=' + (target.quoteNum || '(none)') +
          '. The two ends of this link disagree.',
          'DATA', 'AMBIGUOUS');
      }
    }

    if (holdClaim.length > 1) {
      status = status === 'OK' ? 'REVIEW — multiple Holdings jobs' : status;
      finding('MULTIPLE_JOBS_FOR_ONE_QUOTE', 'MEDIUM', 'JSON', 'quote', { id: q.id, num: q.num },
        'Quote ' + q.num + ' is claimed as source by ' + holdClaim.length + ' Holdings jobs (' +
        holdClaim.map((j) => j.num).join(', ') + '). The conversion path is idempotent by design ' +
        '(backend quote_conversions reserves at most one job per quote), so more than one is unexpected.',
        'DATA', 'AMBIGUOUS');
    }
    if (foreignClaim.length) {
      status = status === 'OK' ? 'REVIEW — foreign job claims this number' : status;
      finding('CROSS_COMPANY_LINK', 'HIGH', 'JSON', 'quote', { id: q.id, num: q.num },
        'Quote number ' + q.num + ' is also claimed as a source quote by ' + foreignClaim.length +
        ' NON-Holdings job(s) (' + foreignClaim.map((j) => j.num + ' co=' + j.co).join(', ') +
        '). Every unscoped number lookup in index.html can return the wrong side of this.',
        'DISPLAY', 'NONE');
    }

    // the decisive display test
    const correct = target && HOLD.loose(target) ? target : (holdClaim.length === 1 ? holdClaim[0] : null);
    if (HOLD.app && correct && asShown && asShown !== correct) {
      status = 'BROKEN — app shows a different job';
      finding('ID_VS_NUMBER_DISAGREEMENT', 'HIGH', 'JSON', 'quote', { id: q.id, num: q.num },
        'Quote ' + q.num + ': the stored link resolves to job ' + correct.num + ' (id ' + correct.id +
        ', co=' + correct.co + '), but index.html\'s own lookup ' +
        'jobs.find(j => j.id===quote.convertedJobId || j.quoteNum===quote.num) returns job ' +
        asShown.num + ' (id ' + asShown.id + ', co=' + asShown.co + ') because that record appears ' +
        'earlier in the array and matches on quote NUMBER. The database is right; the screen is wrong.',
        'DISPLAY', 'HIGH_CONFIDENCE');
    }

    row.status = status;
    if (status !== 'OK') q2jRows.push(row);
  }
  out('Holdings quotes with a non-OK quote->job chain:');
  table(q2jRows);

  /* ── A3. JOB -> QUOTE ─────────────────────────────────────────────── */
  h2('A3. HOLDINGS JOB -> SOURCE QUOTE');
  out('index.html findSourceQuoteForJob(job, quotes) is:');
  out('    quotes.find(q => q.num === job.quoteNum)      <- NO company scope');
  out('reconcileJobInvoice(job, quotes) uses the same rule and MERGES the matched');
  out('quote\'s payments into the job, which then drives the invoice status shown.');
  out('');
  const j2qRows = [];
  for (const j of HJ) {
    if (!j.quoteNum) continue;
    const n = norm(j.quoteNum);
    const all = quotesByNum.get(n) || [];
    const hold = all.filter(HOLD.loose);
    const foreign = all.filter((x) => !HOLD.loose(x));
    // exactly what the app does, using its OWN shipped resolver
    const asShown = HOLD.app ? HOLD.app.resolveQuoteForJob(j, J.quotes) : null;
    // the company-correct answer: prefer the quote that names this job by id
    const reciprocal = hold.find((q) => q.convertedJobId !== null && q.convertedJobId !== undefined &&
      sid(q.convertedJobId) === sid(j.id)) || null;
    const correct = reciprocal || (hold.length === 1 ? hold[0] : null);

    const row = {
      job_id: j.id, job_num: j.num, quoteNum: j.quoteNum,
      holdings_matches: hold.length, other_company_matches: foreign.length,
      as_shown_by_app: asShown ? (asShown.num + ' id=' + asShown.id + ' co=' + asShown.co) : 'NONE',
      correct: correct ? (correct.num + ' id=' + correct.id) : 'UNDETERMINED',
      status: 'OK',
    };

    if (all.length === 0) {
      row.status = 'BROKEN — orphan quoteNum';
      finding('ORPHAN_LINK', 'MEDIUM', 'JSON', 'job', { id: j.id, num: j.num },
        'Job ' + j.num + ' references quote ' + j.quoteNum + ', which does not exist in any company.',
        'DATA', 'UNDETERMINED');
    } else if (hold.length === 0) {
      row.status = 'BROKEN — cross-company only';
      finding('CROSS_COMPANY_LINK', 'HIGH', 'JSON', 'job', { id: j.id, num: j.num },
        'Holdings job ' + j.num + ' references quote number ' + j.quoteNum +
        ', which exists ONLY in another company (' + foreign.map((q) => 'id ' + q.id + ' co=' + q.co).join('; ') +
        '). Every screen that resolves this job\'s source quote is showing another company\'s document, ' +
        'and reconcileJobInvoice is merging that quote\'s payments into this job.',
        'BOTH', 'UNDETERMINED');
    } else if (hold.length > 1) {
      row.status = 'REVIEW — ambiguous within Holdings';
      finding('DUPLICATE_NUMBER_WITHIN_HOLDINGS', 'HIGH', 'JSON', 'job', { id: j.id, num: j.num },
        'Job ' + j.num + ' references quote ' + j.quoteNum + ', which matches ' + hold.length +
        ' Holdings quotes. Cannot be resolved without a person.',
        'BOTH', 'AMBIGUOUS');
    }

    if (HOLD.app && correct && asShown && asShown !== correct) {
      row.status = 'BROKEN — app shows a different quote';
      finding('ID_VS_NUMBER_DISAGREEMENT', 'HIGH', 'JSON', 'job', { id: j.id, num: j.num },
        'Job ' + j.num + ': the correct source quote is id ' + correct.id + ' (' + correct.num +
        ', co=' + correct.co + '), but findSourceQuoteForJob returns id ' + asShown.id + ' (' +
        asShown.num + ', co=' + asShown.co + ') — the first record in the array with that number. ' +
        'Job screen, invoice re-sync and reconcileJobInvoice payment merge are all reading the wrong quote.',
        'DISPLAY', 'HIGH_CONFIDENCE');
    }

    // reciprocity in the other direction
    if (reciprocal && norm(reciprocal.num) !== n) {
      row.status = 'BROKEN — reciprocal mismatch';
      finding('QUOTE_JOB_ASYMMETRIC', 'HIGH', 'JSON', 'job', { id: j.id, num: j.num },
        'Job ' + j.num + ' says quoteNum=' + j.quoteNum + ' but the quote that names it via ' +
        'convertedJobId is ' + reciprocal.num + '.', 'DATA', 'AMBIGUOUS');
    }

    // payment contamination — the financial consequence
    if (asShown && !HOLD.loose(asShown) && Array.isArray(asShown.payments) && asShown.payments.length) {
      // Should be UNREACHABLE after the 2026-09-08 repair — the shipped
      // resolver cannot return a non-Holdings quote for a Holdings job.
      finding('PAYMENT_CONTAMINATION', 'HIGH', 'JSON', 'job', { id: j.id, num: j.num },
        'reconcileJobInvoice(job, quotes) still resolves NON-Holdings quote ' + asShown.num +
        ' (id ' + asShown.id + ', co=' + asShown.co + ') for Holdings job ' + j.num +
        ', merging ' + asShown.payments.length + ' of its payment(s). The company-safe repair is NOT in effect.',
        'DISPLAY', 'HIGH_CONFIDENCE');
    } else if (HOLD.app && !asShown && hold.length === 0 && foreign.length) {
      const contained = foreign.reduce((t, q) => t + ((q.payments || []).length), 0);
      finding('CONTAMINATION_PREVENTED', 'LOW', 'JSON', 'job', { id: j.id, num: j.num },
        'Holdings job ' + j.num + ' carries legacy quoteNum ' + j.quoteNum + ' which exists only under ' +
        'another company. The company-safe resolver correctly returns NO source quote, so none of that ' +
        'quote\'s ' + contained + ' payment(s) and none of its values reach this job. Historical record ' +
        'left exactly as it is — this is the intended post-repair state, not a defect.',
        'DISPLAY', 'NONE');
    }

    if (row.status !== 'OK') j2qRows.push(row);
  }
  out('Holdings jobs with a non-OK job->quote chain:');
  table(j2qRows);

  /* ── A4. JOB -> INVOICE ───────────────────────────────────────────── */
  h2('A4. HOLDINGS JOB -> INVOICE');
  out('Two legitimate representations (see 007_relational_core.sql header):');
  out('  (a) an accInvoices record linked by reference/jobNum/jobId, and');
  out('  (b) invoice fields embedded on the job itself (job.invoiceNum) with no');
  out('      accounting record — a real historical invoice, NOT a defect.');
  out('resolveJobInvoiceRecord IS company-scoped via invoiceIdentityKey(co, number).');
  out('');
  const j2iRows = [];
  for (const j of HJ) {
    const live = J.accInvoices.filter(isLive);
    const linked = live.filter((i) => i.reference === j.num || i.jobNum === j.num ||
      (i.jobId !== undefined && i.jobId !== null && sid(i.jobId) === sid(j.id)));
    const row = {
      job_id: j.id, job_num: j.num, invoiceNum: j.invoiceNum || '',
      linked_invoices: linked.map((i) => i.number + '/co=' + i.co).join(' '),
      state: 'none', status: 'OK',
    };

    for (const i of linked) {
      if (!HOLD.loose(i)) {
        row.status = 'BROKEN — cross-company invoice';
        finding('CROSS_COMPANY_LINK', 'HIGH', 'JSON', 'invoice', { id: i.id, num: i.number },
          'Invoice ' + i.number + ' (co=' + i.co + ') is linked to HOLDINGS job ' + j.num +
          ' via ' + (i.reference === j.num ? 'reference' : (i.jobNum === j.num ? 'jobNum' : 'jobId')) +
          '. The two ends of this link are in different companies.',
          'DATA', 'AMBIGUOUS');
      }
      if (i.jobId !== undefined && i.jobId !== null && sid(i.jobId) !== sid(j.id)) {
        finding('INVOICE_WRONG_JOB', 'HIGH', 'JSON', 'invoice', { id: i.id, num: i.number },
          'Invoice ' + i.number + ' carries jobId=' + i.jobId + ' but its reference/jobNum names job ' +
          j.num + ' (id ' + j.id + '). The stable id and the document number point at different jobs.',
          'BOTH', 'AMBIGUOUS');
      }
    }
    if (linked.length > 1) {
      row.status = 'REVIEW — multiple invoices';
      finding('MULTIPLE_INVOICES_FOR_JOB', 'MEDIUM', 'JSON', 'job', { id: j.id, num: j.num },
        'Job ' + j.num + ' has ' + linked.length + ' live linked invoices (' +
        linked.map((i) => i.number).join(', ') + '). The code models exactly one canonical invoice ' +
        'per job (resolveJobInvoiceRecord returns a single record and reports anything else as ' +
        'ambiguous), so this violates the supported model.',
        'DATA', 'AMBIGUOUS');
    }

    if (j.invoiceNum) {
      const key = (j.co === null || j.co === undefined || j.co === '')
        ? null : String(j.co).trim() + '|' + norm(j.invoiceNum);
      const sameCo = key ? (invByCoNum.get(key) || []) : [];
      const sameNumAnyCo = invByNum.get(norm(j.invoiceNum)) || [];
      const otherCoOnly = sameCo.length === 0 && sameNumAnyCo.length > 0;
      const claimants = HJ.filter((o) => o.invoiceNum && norm(o.invoiceNum) === norm(j.invoiceNum));

      if (linked.length === 1) row.state = 'matched';
      else if (otherCoOnly) {
        row.state = 'invalid';
        row.status = 'BROKEN — number belongs to another company';
        finding('INVOICE_NUMBER_WRONG_COMPANY', 'HIGH', 'JSON', 'job', { id: j.id, num: j.num },
          'Job ' + j.num + ' carries invoiceNum ' + j.invoiceNum + ', which does not exist as a ' +
          'Holdings invoice but DOES exist in another company (' +
          sameNumAnyCo.map((i) => 'id ' + i.id + ' co=' + i.co).join('; ') + '). ' +
          'jobInvoiceLinkState reports this as "invalid".',
          'BOTH', 'UNDETERMINED');
      } else if (sameCo.length > 1 || claimants.length > 1) {
        row.state = 'ambiguous';
        row.status = 'REVIEW — ambiguous invoice identity';
        finding('AMBIGUOUS_INVOICE_IDENTITY', 'HIGH', 'JSON', 'job', { id: j.id, num: j.num },
          'Job ' + j.num + ' invoice ' + j.invoiceNum + ': ' + sameCo.length +
          ' Holdings invoice record(s) match and ' + claimants.length +
          ' Holdings job(s) claim that number. resolveJobInvoiceRecord refuses to pick one.',
          'BOTH', 'AMBIGUOUS');
      } else if (sameCo.length === 0) {
        row.state = 'orphaned';
        // NOT a finding: this is the documented legitimate (b) representation.
      } else {
        row.state = 'matched';
      }
    }
    if (row.status !== 'OK') j2iRows.push(row);
  }
  out('Holdings jobs with a non-OK job->invoice chain (orphaned historical invoices are NOT listed — they are legitimate):');
  table(j2iRows);

  /* ── A5. INVOICE -> JOB / QUOTE ───────────────────────────────────── */
  h2('A5. HOLDINGS INVOICE -> JOB and -> QUOTE');
  const i2xRows = [];
  for (const inv of HI) {
    if (!isLive(inv)) continue;
    const row = {
      invoice_id: inv.id, number: inv.number,
      jobId: inv.jobId === undefined ? '' : inv.jobId, jobNum: inv.jobNum || '', reference: inv.reference || '',
      quoteId: inv.quoteId === undefined ? '' : inv.quoteId, quoteNum: inv.quoteNum || '',
      status: 'OK',
    };
    const byJobId = (inv.jobId !== undefined && inv.jobId !== null) ? jobById.get(sid(inv.jobId)) : null;
    const jobNumRef = inv.reference || inv.jobNum;
    const byJobNum = jobNumRef ? (jobsByNum.get(norm(jobNumRef)) || [])[0] : null;
    const byQuoteId = (inv.quoteId !== undefined && inv.quoteId !== null) ? quoteById.get(sid(inv.quoteId)) : null;
    const quoteNumMatches = inv.quoteNum ? (quotesByNum.get(norm(inv.quoteNum)) || []) : [];
    const holdQuoteMatches = quoteNumMatches.filter(HOLD.loose);

    if (inv.jobId !== undefined && inv.jobId !== null && !byJobId) {
      row.status = 'BROKEN — orphan jobId';
      finding('ORPHAN_LINK', 'HIGH', 'JSON', 'invoice', { id: inv.id, num: inv.number },
        'Invoice ' + inv.number + ' jobId=' + inv.jobId + ' points at a job that does not exist.',
        'DATA', byJobNum ? 'HIGH_CONFIDENCE' : 'UNDETERMINED');
    }
    if (byJobId && !HOLD.loose(byJobId)) {
      row.status = 'BROKEN — cross-company job';
      finding('CROSS_COMPANY_LINK', 'HIGH', 'JSON', 'invoice', { id: inv.id, num: inv.number },
        'Holdings invoice ' + inv.number + ' jobId=' + inv.jobId + ' points at job ' + byJobId.num +
        ' which belongs to co=' + byJobId.co + '.', 'DATA', 'AMBIGUOUS');
    }
    if (byJobId && byJobNum && byJobId !== byJobNum) {
      row.status = 'BROKEN — jobId and jobNum disagree';
      finding('ID_VS_NUMBER_DISAGREEMENT', 'HIGH', 'JSON', 'invoice', { id: inv.id, num: inv.number },
        'Invoice ' + inv.number + ': jobId=' + inv.jobId + ' is job ' + byJobId.num +
        ', but reference/jobNum "' + jobNumRef + '" is job ' + byJobNum.num + ' (id ' + byJobNum.id +
        '). invoiceBelongsToJob matches on the NUMBER, so the app follows ' + byJobNum.num +
        ' while the stored id says ' + byJobId.num + '.',
        'BOTH', 'AMBIGUOUS');
    }
    if (inv.quoteId !== undefined && inv.quoteId !== null && !byQuoteId) {
      row.status = 'BROKEN — orphan quoteId';
      finding('ORPHAN_LINK', 'HIGH', 'JSON', 'invoice', { id: inv.id, num: inv.number },
        'Invoice ' + inv.number + ' quoteId=' + inv.quoteId + ' points at a quote that does not exist.',
        'DATA', holdQuoteMatches.length === 1 ? 'HIGH_CONFIDENCE' : 'UNDETERMINED');
    }
    if (byQuoteId && !HOLD.loose(byQuoteId)) {
      row.status = 'BROKEN — cross-company quote';
      finding('CROSS_COMPANY_LINK', 'HIGH', 'JSON', 'invoice', { id: inv.id, num: inv.number },
        'Holdings invoice ' + inv.number + ' quoteId=' + inv.quoteId + ' points at quote ' +
        byQuoteId.num + ' which belongs to co=' + byQuoteId.co + '.', 'DATA', 'AMBIGUOUS');
    }
    if (byQuoteId && inv.quoteNum && norm(byQuoteId.num) !== norm(inv.quoteNum)) {
      row.status = 'BROKEN — quoteId and quoteNum disagree';
      finding('ID_VS_NUMBER_DISAGREEMENT', 'HIGH', 'JSON', 'invoice', { id: inv.id, num: inv.number },
        'Invoice ' + inv.number + ': quoteId=' + inv.quoteId + ' is quote ' + byQuoteId.num +
        ' but stored quoteNum is "' + inv.quoteNum + '". getQuoteInvoice matches on EITHER, so a ' +
        'quote screen can claim this invoice through the number while the id says otherwise.',
        'BOTH', 'AMBIGUOUS');
    }
    // chain coherence: invoice -> job -> quote  vs  invoice -> quote
    const chainJob = byJobId || byJobNum;
    if (chainJob && byQuoteId && chainJob.quoteNum && norm(chainJob.quoteNum) !== norm(byQuoteId.num)) {
      row.status = 'BROKEN — invoice/job/quote chain incoherent';
      finding('INVOICE_CHAIN_INCONSISTENT', 'HIGH', 'JSON', 'invoice', { id: inv.id, num: inv.number },
        'Invoice ' + inv.number + ' says quote ' + byQuoteId.num + ', but its job ' + chainJob.num +
        ' says its source quote is ' + chainJob.quoteNum + '. The chain does not close.',
        'DATA', 'AMBIGUOUS');
    }
    if (row.status !== 'OK') i2xRows.push(row);
  }
  out('Holdings invoices with a non-OK chain:');
  table(i2xRows);

  /* ── A6. FULL CHAIN VIEW ──────────────────────────────────────────── */
  h2('A6. HOLDINGS TRANSACTION CHAINS');
  let clean = 0, broken = 0;
  const brokenChains = [];
  for (const q of HQ) {
    const target = (q.convertedJobId !== null && q.convertedJobId !== undefined)
      ? jobById.get(sid(q.convertedJobId)) : null;
    const claim = (jobsByQuoteNum.get(norm(q.num)) || []).filter(HOLD.loose);
    const job = (target && HOLD.loose(target)) ? target : (claim.length === 1 ? claim[0] : null);
    const asShownJob = HOLD.app ? HOLD.app.resolveJobForQuote(q, J.jobs) : null;

    let inv = null;
    if (job) {
      inv = J.accInvoices.filter(isLive).find((i) => i.reference === job.num || i.jobNum === job.num) || null;
    }
    const problems = [];
    if (q.convertedJobId !== null && q.convertedJobId !== undefined && !target) problems.push('convertedJobId orphan');
    if (target && !HOLD.loose(target)) problems.push('job in co=' + target.co);
    if (job && norm(job.quoteNum) !== norm(q.num)) problems.push('job.quoteNum=' + (job.quoteNum || '(none)') + ' != ' + q.num);
    if (claim.length > 1) problems.push(claim.length + ' Holdings jobs claim this quote');
    if (HOLD.app && asShownJob && job && asShownJob !== job) problems.push('app resolves to job ' + asShownJob.num + ' (co=' + asShownJob.co + ')');
    if (inv && !HOLD.loose(inv)) problems.push('invoice in co=' + inv.co);

    if (problems.length) {
      broken++;
      brokenChains.push({
        quote: 'id ' + q.id + ' ' + (q.num || ''),
        stored_convertedJobId: q.convertedJobId === undefined ? '' : q.convertedJobId,
        job: job ? ('id ' + job.id + ' ' + job.num) : 'UNRESOLVED',
        job_says_quoteNum: job ? (job.quoteNum || '(none)') : '',
        invoice: inv ? ('id ' + inv.id + ' ' + inv.number) : '',
        status: 'BROKEN — ' + problems.join('; '),
      });
    } else {
      clean++;
    }
  }
  out('Clean chains  : ' + clean);
  out('Broken chains : ' + broken);
  out('');
  table(brokenChains);
  out('');
  out('Chain shape (from the real data, no invented prefixes):');
  out('  Quote  SQ-#####   -> Job  SNS-#####   -> Invoice  INV-#####');

  return {
    counts: { quotes: HQ.length, jobs: HJ.length, invoices: HI.length },
    chains: { clean, broken },
  };
}

/* ════════════════════════════════════════════════════════════════════════
 * PART B IMPLEMENTATION — the relational tables. Pure SELECT / CTE.
 * ══════════════════════════════════════════════════════════════════════ */
async function auditRelationalStore(client, HOLD) {
  h1('PART B — RELATIONAL STORE (rel_quotes / rel_jobs / rel_invoices)');
  const CO = HOLD.coStr;

  const counts = await client.query(
    `SELECT
       (SELECT COUNT(*) FROM rel_quotes   WHERE company_code = $1) AS quotes,
       (SELECT COUNT(*) FROM rel_jobs     WHERE company_code = $1) AS jobs,
       (SELECT COUNT(*) FROM rel_invoices WHERE company_code = $1) AS invoices`,
    [CO]
  );
  const c = counts.rows[0];
  out('Holdings company_code = "' + CO + '"');
  table([{ holdings_quotes: c.quotes, holdings_jobs: c.jobs, holdings_invoices: c.invoices }]);

  /* B1 — quote -> job reciprocity and cross-company */
  h2('B1. rel_quotes.converted_job_id integrity');
  const b1 = await client.query(
    `SELECT q.id AS quote_id, q.quote_number, q.converted_job_id,
            j.id AS job_id, j.job_number, j.company_code AS job_company,
            j.quote_id AS job_quote_id,
            CASE
              WHEN q.converted_job_id IS NOT NULL AND j.id IS NULL THEN 'ORPHAN_LINK'
              WHEN j.company_code IS DISTINCT FROM q.company_code   THEN 'CROSS_COMPANY_LINK'
              WHEN j.quote_id IS DISTINCT FROM q.id                 THEN 'QUOTE_JOB_ASYMMETRIC'
              ELSE 'OK'
            END AS verdict
       FROM rel_quotes q
       LEFT JOIN rel_jobs j ON j.id = q.converted_job_id
      WHERE q.company_code = $1
        AND q.converted_job_id IS NOT NULL
      ORDER BY q.id`,
    [CO]
  );
  const b1bad = b1.rows.filter((r) => r.verdict !== 'OK');
  table(b1bad);
  for (const r of b1bad) {
    finding(r.verdict, 'HIGH', 'RELATIONAL', 'quote', { id: r.quote_id, num: r.quote_number },
      'rel_quotes id ' + r.quote_id + ' (' + r.quote_number + ') converted_job_id=' + r.converted_job_id +
      (r.verdict === 'ORPHAN_LINK' ? ' -> no such rel_jobs row.'
        : r.verdict === 'CROSS_COMPANY_LINK' ? (' -> rel_jobs id ' + r.job_id + ' (' + r.job_number +
            ') company_code=' + r.job_company + ', not ' + CO + '.')
        : (' -> rel_jobs id ' + r.job_id + ' whose own quote_id is ' + r.job_quote_id + ', not ' + r.quote_id + '.')),
      'DATA', 'AMBIGUOUS');
  }

  /* B2 — job -> quote */
  h2('B2. rel_jobs.quote_id integrity');
  const b2 = await client.query(
    `SELECT j.id AS job_id, j.job_number, j.quote_id, j.quote_number_raw,
            q.id AS q_id, q.quote_number, q.company_code AS quote_company,
            q.converted_job_id,
            CASE
              WHEN j.quote_id IS NOT NULL AND q.id IS NULL         THEN 'ORPHAN_LINK'
              WHEN q.company_code IS DISTINCT FROM j.company_code  THEN 'CROSS_COMPANY_LINK'
              WHEN q.converted_job_id IS DISTINCT FROM j.id        THEN 'QUOTE_JOB_ASYMMETRIC'
              ELSE 'OK'
            END AS verdict
       FROM rel_jobs j
       LEFT JOIN rel_quotes q ON q.id = j.quote_id
      WHERE j.company_code = $1
        AND j.quote_id IS NOT NULL
      ORDER BY j.id`,
    [CO]
  );
  const b2bad = b2.rows.filter((r) => r.verdict !== 'OK');
  table(b2bad);
  for (const r of b2bad) {
    finding(r.verdict, 'HIGH', 'RELATIONAL', 'job', { id: r.job_id, num: r.job_number },
      'rel_jobs id ' + r.job_id + ' (' + r.job_number + ') quote_id=' + r.quote_id +
      (r.verdict === 'ORPHAN_LINK' ? ' -> no such rel_quotes row.'
        : r.verdict === 'CROSS_COMPANY_LINK' ? (' -> rel_quotes company_code=' + r.quote_company + ', not ' + CO + '.')
        : (' -> that quote\'s converted_job_id is ' + r.converted_job_id + ', not ' + r.job_id + '.')),
      'DATA', 'AMBIGUOUS');
  }

  /* B2b — Holdings jobs whose quote_number_raw resolves elsewhere */
  h2('B2b. rel_jobs.quote_number_raw resolving outside Holdings');
  const b2b = await client.query(
    `SELECT j.id AS job_id, j.job_number, j.quote_number_raw, j.quote_id,
            (SELECT COUNT(*) FROM rel_quotes q2
              WHERE q2.company_code = j.company_code
                AND UPPER(BTRIM(q2.quote_number)) = UPPER(BTRIM(j.quote_number_raw))) AS holdings_matches,
            (SELECT COUNT(*) FROM rel_quotes q3
              WHERE q3.company_code IS DISTINCT FROM j.company_code
                AND UPPER(BTRIM(q3.quote_number)) = UPPER(BTRIM(j.quote_number_raw))) AS other_company_matches
       FROM rel_jobs j
      WHERE j.company_code = $1
        AND j.quote_number_raw IS NOT NULL AND BTRIM(j.quote_number_raw) <> ''
      ORDER BY j.id`,
    [CO]
  );
  const b2bbad = b2b.rows.filter((r) => Number(r.holdings_matches) !== 1 || Number(r.other_company_matches) > 0);
  table(b2bbad);
  for (const r of b2bbad) {
    const hm = Number(r.holdings_matches), om = Number(r.other_company_matches);
    finding(hm === 0 ? (om > 0 ? 'CROSS_COMPANY_LINK' : 'ORPHAN_LINK')
      : hm > 1 ? 'DUPLICATE_NUMBER_WITHIN_HOLDINGS' : 'CROSS_COMPANY_NUMBER_COLLISION',
      hm === 1 && om > 0 ? 'MEDIUM' : 'HIGH',
      'RELATIONAL', 'job', { id: r.job_id, num: r.job_number },
      'rel_jobs ' + r.job_number + ' quote_number_raw="' + r.quote_number_raw + '": ' + hm +
      ' Holdings quote(s) and ' + om + ' other-company quote(s) carry that number. ' +
      'The frontend resolves this link BY NUMBER against the unfiltered array.',
      hm === 1 && om > 0 ? 'DISPLAY' : 'BOTH', 'UNDETERMINED');
  }

  /* B3 — invoice -> job / quote */
  h2('B3. rel_invoices.job_id / quote_id integrity');
  const b3 = await client.query(
    `SELECT i.id AS invoice_id, i.invoice_number, i.job_id, i.job_number_raw,
            i.quote_id, i.quote_number_raw, i.reference,
            j.job_number AS job_actual, j.company_code AS job_company, j.quote_id AS job_quote_id,
            q.quote_number AS quote_actual, q.company_code AS quote_company,
            CASE
              WHEN i.job_id   IS NOT NULL AND j.id IS NULL          THEN 'ORPHAN_LINK_JOB'
              WHEN i.quote_id IS NOT NULL AND q.id IS NULL          THEN 'ORPHAN_LINK_QUOTE'
              WHEN j.company_code IS DISTINCT FROM i.company_code
                   AND j.id IS NOT NULL                             THEN 'CROSS_COMPANY_LINK'
              WHEN q.company_code IS DISTINCT FROM i.company_code
                   AND q.id IS NOT NULL                             THEN 'CROSS_COMPANY_LINK'
              WHEN j.id IS NOT NULL AND i.job_number_raw IS NOT NULL
                   AND UPPER(BTRIM(j.job_number)) <> UPPER(BTRIM(i.job_number_raw))
                                                                    THEN 'ID_VS_NUMBER_DISAGREEMENT'
              WHEN q.id IS NOT NULL AND i.quote_number_raw IS NOT NULL
                   AND UPPER(BTRIM(q.quote_number)) <> UPPER(BTRIM(i.quote_number_raw))
                                                                    THEN 'ID_VS_NUMBER_DISAGREEMENT'
              WHEN j.id IS NOT NULL AND q.id IS NOT NULL
                   AND j.quote_id IS DISTINCT FROM q.id             THEN 'INVOICE_CHAIN_INCONSISTENT'
              ELSE 'OK'
            END AS verdict
       FROM rel_invoices i
       LEFT JOIN rel_jobs   j ON j.id = i.job_id
       LEFT JOIN rel_quotes q ON q.id = i.quote_id
      WHERE i.company_code = $1
        AND COALESCE(i.status, '') <> 'void'
      ORDER BY i.id`,
    [CO]
  );
  const b3bad = b3.rows.filter((r) => r.verdict !== 'OK');
  table(b3bad);
  for (const r of b3bad) {
    finding(r.verdict.replace(/_JOB$|_QUOTE$/, ''), 'HIGH', 'RELATIONAL', 'invoice',
      { id: r.invoice_id, num: r.invoice_number },
      'rel_invoices ' + r.invoice_number + ' (' + r.verdict + '): job_id=' + r.job_id +
      ' (' + (r.job_actual || 'missing') + ', co=' + (r.job_company || '-') + '), job_number_raw="' +
      (r.job_number_raw || '') + '"; quote_id=' + r.quote_id + ' (' + (r.quote_actual || 'missing') +
      ', co=' + (r.quote_company || '-') + '), quote_number_raw="' + (r.quote_number_raw || '') + '".',
      'DATA', 'AMBIGUOUS');
  }

  /* B4 — multiple invoices per job / quote */
  h2('B4. More than one live invoice per Holdings job / quote');
  const b4 = await client.query(
    `SELECT 'job' AS kind, j.job_number AS doc, COUNT(*)::int AS live_invoices,
            STRING_AGG(i.invoice_number, ', ' ORDER BY i.id) AS invoices
       FROM rel_invoices i JOIN rel_jobs j ON j.id = i.job_id
      WHERE i.company_code = $1 AND COALESCE(i.status,'') <> 'void'
      GROUP BY j.job_number HAVING COUNT(*) > 1
      UNION ALL
     SELECT 'quote', q.quote_number, COUNT(*)::int,
            STRING_AGG(i.invoice_number, ', ' ORDER BY i.id)
       FROM rel_invoices i JOIN rel_quotes q ON q.id = i.quote_id
      WHERE i.company_code = $1 AND COALESCE(i.status,'') <> 'void'
      GROUP BY q.quote_number HAVING COUNT(*) > 1
      ORDER BY 1, 2`,
    [CO]
  );
  table(b4.rows);
  for (const r of b4.rows) {
    finding('MULTIPLE_INVOICES_FOR_' + r.kind.toUpperCase(), 'MEDIUM', 'RELATIONAL', r.kind,
      { num: r.doc },
      r.kind + ' ' + r.doc + ' has ' + r.live_invoices + ' live invoices (' + r.invoices +
      '). The application models exactly one canonical invoice per job/quote.',
      'DATA', 'AMBIGUOUS');
  }

  /* B5 — duplicate document numbers */
  h2('B5. Duplicate document numbers relevant to Holdings');
  const b5 = await client.query(
    `SELECT 'job_number_global' AS scope, j.job_number AS number, COUNT(*)::int AS n
       FROM rel_jobs j GROUP BY j.job_number HAVING COUNT(*) > 1
      UNION ALL
     SELECT 'quote_number_shared_with_other_company', q.quote_number, COUNT(*)::int
       FROM rel_quotes q
      WHERE UPPER(BTRIM(q.quote_number)) IN (
              SELECT UPPER(BTRIM(q2.quote_number)) FROM rel_quotes q2 WHERE q2.company_code = $1)
      GROUP BY q.quote_number HAVING COUNT(DISTINCT q.company_code) > 1
      UNION ALL
     SELECT 'invoice_number_shared_with_other_company', i.invoice_number, COUNT(*)::int
       FROM rel_invoices i
      WHERE UPPER(BTRIM(i.invoice_number)) IN (
              SELECT UPPER(BTRIM(i2.invoice_number)) FROM rel_invoices i2 WHERE i2.company_code = $1)
      GROUP BY i.invoice_number HAVING COUNT(DISTINCT i.company_code) > 1
      ORDER BY 1, 2`,
    [CO]
  );
  table(b5.rows);
  out('');
  out('A shared quote/invoice number across companies is NOT itself corruption — the');
  out('numbering scheme mints them per company on purpose. It is listed because it is');
  out('the raw material every unscoped number lookup in index.html can trip over.');

  /* B6 — job -> invoice, using read.ts's own resolution rule verbatim */
  h2('B6. Job -> invoice resolution (same rule as read.ts resolveJobInvoiceLinks)');
  const b6 = await client.query(
    `WITH cand AS (
       SELECT j.id AS job_id, i.id AS inv_id
         FROM rel_jobs j JOIN rel_invoices i ON i.job_id = j.id
        WHERE j.company_code = $1 AND COALESCE(i.status,'') <> 'void'
       UNION
       SELECT j.id, i.id
         FROM rel_jobs j
         JOIN rel_invoices i
           ON i.company_code = j.company_code
          AND UPPER(BTRIM(i.invoice_number)) = UPPER(BTRIM(j.invoice_num))
        WHERE j.company_code = $1
          AND j.invoice_num IS NOT NULL AND BTRIM(j.invoice_num) <> ''
          AND COALESCE(i.status,'') <> 'void'
     ), per_job AS (
       SELECT job_id, COUNT(*)::int AS match_count FROM cand GROUP BY job_id
     ), claims AS (
       SELECT inv_id, COUNT(DISTINCT job_id)::int AS claiming_jobs FROM cand GROUP BY inv_id
     )
     SELECT j.id AS job_id, j.job_number, j.invoice_num,
            COALESCE(p.match_count, 0) AS match_count,
            COALESCE((SELECT MAX(c.claiming_jobs) FROM cand cd
                        JOIN claims c ON c.inv_id = cd.inv_id
                       WHERE cd.job_id = j.id), 0) AS claiming_jobs,
            EXISTS (SELECT 1 FROM rel_invoices x
                     WHERE x.company_code IS DISTINCT FROM j.company_code
                       AND UPPER(BTRIM(x.invoice_number)) = UPPER(BTRIM(j.invoice_num))
                       AND COALESCE(x.status,'') <> 'void') AS number_in_other_company
       FROM rel_jobs j
       LEFT JOIN per_job p ON p.job_id = j.id
      WHERE j.company_code = $1
        AND (j.invoice_num IS NOT NULL AND BTRIM(j.invoice_num) <> '' OR j.invoice_created = TRUE)
      ORDER BY j.id`,
    [CO]
  );
  const classify = (r) => {
    const mc = Number(r.match_count), cj = Number(r.claiming_jobs);
    if (!r.invoice_num || !String(r.invoice_num).trim()) return 'NO_NUMBER';
    if (mc === 1 && cj === 1) return 'MATCHED';
    if (mc === 0) return r.number_in_other_company ? 'INVALID_OTHER_COMPANY' : 'ORPHANED_HISTORICAL';
    return 'AMBIGUOUS';
  };
  const b6rows = b6.rows.map((r) => ({
    job_id: r.job_id, job_number: r.job_number, invoice_num: r.invoice_num,
    match_count: r.match_count, claiming_jobs: r.claiming_jobs, state: classify(r),
  }));
  const b6tally = new Map();
  for (const r of b6rows) b6tally.set(r.state, (b6tally.get(r.state) || 0) + 1);
  table([...b6tally.entries()].map(([state, n]) => ({ state, jobs: n })), 20);
  const b6bad = b6rows.filter((r) => r.state === 'AMBIGUOUS' || r.state === 'INVALID_OTHER_COMPANY' || r.state === 'NO_NUMBER');
  out('');
  out('Non-clean rows:');
  table(b6bad);
  for (const r of b6bad) {
    finding(r.state === 'INVALID_OTHER_COMPANY' ? 'INVOICE_NUMBER_WRONG_COMPANY'
      : r.state === 'AMBIGUOUS' ? 'AMBIGUOUS_INVOICE_IDENTITY' : 'INVOICE_NUMBER_MISSING',
      r.state === 'NO_NUMBER' ? 'MEDIUM' : 'HIGH',
      'RELATIONAL', 'job', { id: r.job_id, num: r.job_number },
      'rel_jobs ' + r.job_number + ' invoice_num="' + (r.invoice_num || '') + '" resolves as ' +
      r.state + ' (matches=' + r.match_count + ', jobs claiming that invoice=' + r.claiming_jobs + ').',
      'BOTH', 'AMBIGUOUS');
  }
  out('');
  out('ORPHANED_HISTORICAL is NOT a defect: it is a real pre-cutover invoice recorded on');
  out('the job itself with no accounting record. It is counted, never flagged.');

  /* B7 — chain view */
  h2('B7. Holdings chains (relational, ids authoritative)');
  const b7 = await client.query(
    `SELECT q.id AS quote_id, q.quote_number, q.converted_job_id,
            j.id AS job_id, j.job_number, j.quote_id AS job_quote_id, j.company_code AS job_co,
            i.id AS invoice_id, i.invoice_number, i.company_code AS inv_co
       FROM rel_quotes q
       LEFT JOIN rel_jobs j ON j.id = q.converted_job_id
       LEFT JOIN rel_invoices i ON i.job_id = j.id AND COALESCE(i.status,'') <> 'void'
      WHERE q.company_code = $1
      ORDER BY q.id`,
    [CO]
  );
  const chainRows = b7.rows.map((r) => {
    const problems = [];
    if (r.converted_job_id !== null && r.job_id === null) problems.push('converted_job_id orphan');
    if (r.job_id !== null && String(r.job_co) !== CO) problems.push('job company_code=' + r.job_co);
    if (r.job_id !== null && String(r.job_quote_id) !== String(r.quote_id)) {
      problems.push('job.quote_id=' + r.job_quote_id + ' != ' + r.quote_id);
    }
    if (r.invoice_id !== null && String(r.inv_co) !== CO) problems.push('invoice company_code=' + r.inv_co);
    return {
      quote: 'ID ' + r.quote_id + ' ' + r.quote_number,
      job: r.job_id ? ('ID ' + r.job_id + ' ' + r.job_number) : '(none)',
      invoice: r.invoice_id ? ('ID ' + r.invoice_id + ' ' + r.invoice_number) : '(none)',
      status: problems.length ? ('BROKEN — ' + problems.join('; ')) : 'OK',
    };
  });
  const relBroken = chainRows.filter((r) => r.status !== 'OK');
  out('Clean chains  : ' + (chainRows.length - relBroken.length));
  out('Broken chains : ' + relBroken.length);
  table(relBroken);

  return { counts: { quotes: Number(c.quotes), jobs: Number(c.jobs), invoices: Number(c.invoices) } };
}

/* ── write the local diagnostic files ───────────────────────────────────── */
function flush() {
  try {
    fs.writeFileSync(OUT_PATH, lines.join('\n') + '\n', 'utf8');
    console.log('\nReport written to : ' + OUT_PATH);
  } catch (e) {
    console.error('Could not write the report file: ' + ((e && e.message) || String(e)));
  }
  try {
    fs.writeFileSync(JSON_PATH, JSON.stringify({
      generatedAt: new Date().toISOString(),
      readOnly: true,
      findings,
    }, null, 2), 'utf8');
    console.log('JSON written to   : ' + JSON_PATH);
  } catch (e) {
    console.error('Could not write the JSON file: ' + ((e && e.message) || String(e)));
  }
  try {
    const cols = ['severity', 'store', 'cls', 'entity', 'id', 'num', 'verdict', 'repair', 'detail'];
    const esc = (v) => {
      const s = (v === null || v === undefined) ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const csv = [cols.join(',')]
      .concat(findings.map((f) => cols.map((k) => esc(f[k])).join(',')))
      .join('\n');
    fs.writeFileSync(CSV_PATH, csv + '\n', 'utf8');
    console.log('CSV written to    : ' + CSV_PATH);
  } catch (e) {
    console.error('Could not write the CSV file: ' + ((e && e.message) || String(e)));
  }
}
