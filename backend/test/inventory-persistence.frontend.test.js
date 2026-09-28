#!/usr/bin/env node
/* ============================================================================
 * inventory-persistence.frontend.test.js
 * Signacore — 2026-09-28 INVENTORY PERSISTENCE INVESTIGATION (frontend half).
 * ============================================================================
 *
 * WHAT THIS PROVES
 *   A user created a new Inventory category (via "+ Add new category…" in the
 *   Add Stock Item form — categories are NOT a separate entity, they are the
 *   `cat` value carried by items) plus items in it. They appeared, then
 *   disappeared. Three frontend mechanisms are proven here, each against the
 *   REAL code lifted out of index.html (never a re-implementation):
 *
 *   A. CATEGORY FIELD MAPPING ON RE-READ. The relational read delivers
 *      `category`; the dashboard reads `cat`. The targeted relational refresh
 *      (fetchRelationalSectionsNow — runs right after every inventory
 *      create/edit and whenever another session changes inventory) did not
 *      normalise, so the new category vanished from the chips/filter/dropdown.
 *
 *   B. HYDRATION KEPT THE BROWSER CACHE INSTEAD OF THE SERVER. attemptHydration
 *      compared live state against the raw `_saved` cache. The inventory state
 *      initialiser transforms that cache (withItemCat + INITIAL_INVENTORY seed
 *      injection), so inventory ALWAYS looked "changed during the load window",
 *      the server's inventory was skipped, and the stale cache stayed on
 *      screen: items created since the cache disappeared after reload/login.
 *      In JSON mode the next autosave then declared them DELETED
 *      (_deletedIds); with inventory cut over every autosave was refused.
 *
 *   C. TRANSIENT LOSS OF RELATIONAL AUTHORITY. When the server's relational read
 *      of inventory throws, it serves the frozen pre-cutover JSON copy and
 *      omits inventory from relationalAuthoritativeSections. Adopting that
 *      verbatim showed the frozen copy (new items gone) and flipped routing to
 *      the JSON path, whose writes the server strips while answering 200.
 *
 *   Run against the pre-fix file to see the failures reproduced:
 *     INDEX_HTML_PATH=/path/to/old/index.html node test/inventory-persistence.frontend.test.js
 *
 * ZERO DEPENDENCIES — plain Node, no ts-node, no babel, no database.
 *   node test/inventory-persistence.frontend.test.js
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');

const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH || path.resolve(__dirname, '..', '..', 'index.html');
const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
const MARK = '<script type="text/babel" data-presets="react-classic">';
const SRC = html.slice(html.indexOf(MARK) + MARK.length, html.lastIndexOf('</script>'));

let failures = 0, passed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failures++; console.log('  ✗ ' + label + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}
function section(t) { console.log('\n' + t); }

/* ── source lifting ──────────────────────────────────────────────────────── */
// Mask comments and string/template literals so brace counting is exact.
function mask(src) {
  const out = src.split(''); let i = 0; const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') { out[i] = ' '; i++; } continue; }
    if (c === '/' && d === '*') { out[i] = out[i + 1] = ' '; i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out[i] = ' '; i++; } if (i < n) { out[i] = out[i + 1] = ' '; i += 2; } continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out[i] = ' '; i++;
      while (i < n) { if (src[i] === '\\') { out[i] = out[i + 1] = ' '; i += 2; continue; } if (src[i] === q) { out[i] = ' '; i++; break; } out[i] = ' '; i++; }
      continue;
    }
    i++;
  }
  return out.join('');
}
function braceBlock(src, from, skipParams) {
  const win = src.slice(from, from + 250000); const m = mask(win);
  let start = 0;
  if (skipParams) { // skip the parameter list so a destructured `({ a, b })` is not taken for the body
    let p = m.indexOf('('), pd = 0;
    for (let i = p; i < m.length; i++) { if (m[i] === '(') pd++; else if (m[i] === ')') { pd--; if (pd === 0) { start = i + 1; break; } } }
  }
  const open = m.indexOf('{', start); let depth = 0;
  for (let i = open; i < m.length; i++) {
    if (m[i] === '{') depth++;
    else if (m[i] === '}') { depth--; if (depth === 0) return win.slice(0, i + 1); }
  }
  throw new Error('unbalanced block at ' + from);
}
// `function name(` at ANY indentation (App-nested helpers included), first
// declaration at the start of a line.
function fn(name, opts) {
  const re = new RegExp('\\n[ \\t]*(async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(SRC);
  if (!m) { if (opts && opts.optional) return null; throw new Error('function ' + name + ' not found'); }
  return braceBlock(SRC, m.index + 1, true);
}
function has(name) { return new RegExp('\\n[ \\t]*(async\\s+)?function\\s+' + name + '\\s*\\(').test(SRC); }
// Evaluate a set of declarations with every free identifier resolved from
// `env` (sloppy-mode `with`), returning the named functions.
function lift(decls, names, env) {
  const body = 'with (env) {\n' + decls.join('\n\n') + '\nreturn {' + names.join(',') + '};\n}';
  return new Function('env', body)(env); // eslint-disable-line no-new-func
}
const clone = (v) => JSON.parse(JSON.stringify(v));

/* ── shared real helpers ─────────────────────────────────────────────────── */
const DATA_VERSION = Number((SRC.match(/const DATA_VERSION\s*=\s*(\d+)/) || [])[1]);
const STATE_SECTIONS = eval(SRC.match(/const STATE_SECTIONS = (\[[\s\S]*?\]);/)[1]); // eslint-disable-line no-eval
const INITIAL_INVENTORY = eval(SRC.match(/const INITIAL_INVENTORY = (\[[\s\S]*?\n\]);/)[1]); // eslint-disable-line no-eval

function freshEnv(extra) {
  const env = {
    console: { log() {}, warn() {}, debug() {}, error() {} },
    JSON, Object, Array, Set, Map, String, Number, Date, Math, Error, Promise,
    DATA_VERSION, STATE_SECTIONS, INITIAL_INVENTORY,
    relationalAuthoritativeSectionsRef: { current: [] },
    relationalCutOverSeenRef: { current: [] },
    serverBaselineRef: { current: null },
  };
  return Object.assign(env, extra || {});
}
const helperNames = ['withItemCat'].concat(has('normaliseItemCatSections') ? ['normaliseItemCatSections'] : [])
  .concat(has('adoptRelationalAuthority') ? ['adoptRelationalAuthority'] : []);

/* ── fixtures ────────────────────────────────────────────────────────────── */
// A backfilled item (legacy `cat` present), an item created through the
// relational API after cutover (only `category`, exactly as read.ts served it
// before the backend half of this fix), and supplier-linked data.
const OLD_ITEM = { id: 90001, sku: 'VIN-3M-WG', name: '3M Vinyl White Gloss', cat: 'Vinyl', category: 'Vinyl', stock: 45, reorder: 10, unit: 'm', cost: 285, sell: 450, supplierId: 77, active: true, _relId: '1', _relRowVersion: 3 };
const NEW_ITEM_1 = { id: 501, sku: 'SB-ACM-3', name: 'ACM 3mm White', category: 'Signage Boards', stock: 0, reorder: 2, unit: 'sheet', cost: 400, sell: 650, supplierId: 77, active: true, _relId: '501', _relRowVersion: 1 };
const NEW_ITEM_2 = { id: 502, sku: 'SB-ACM-4', name: 'ACM 4mm White', category: 'Signage Boards', stock: 3, reorder: 2, unit: 'sheet', cost: 480, sell: 760, supplierId: null, active: true, _relId: '502', _relRowVersion: 1 };

(async function main() {
  console.log('index.html: ' + INDEX_HTML_PATH);

  /* ════════════════════════════════════════════════════════════════════
     A. category field mapping on every read path
     ════════════════════════════════════════════════════════════════════ */
  section('[A1] withItemCat maps relational `category` onto the `cat` field the dashboard reads');
  {
    const h = lift([fn('withItemCat')], ['withItemCat'], freshEnv());
    const out = h.withItemCat([clone(OLD_ITEM), clone(NEW_ITEM_1)]);
    ok(out[1].cat === 'Signage Boards', 'a post-cutover item gains cat from category', out[1]);
    ok(out[0] === out[0] && out[0].cat === 'Vinyl', 'an already-consistent item is unchanged');
    const edited = h.withItemCat([{ ...OLD_ITEM, cat: 'Vinyl', category: 'Laminate' }])[0];
    ok(edited.cat === 'Laminate' && edited.category === 'Laminate', 'an EDITED backfilled item shows the new (relational) category, not the stale legacy one', edited);
    const none = { id: 9, name: 'x', category: null };
    ok(h.withItemCat([none])[0] === none, 'an item with no category at all is returned untouched (no phantom diff)');
    const twice = h.withItemCat(h.withItemCat([clone(NEW_ITEM_1)]));
    ok(JSON.stringify(twice) === JSON.stringify(h.withItemCat([clone(NEW_ITEM_1)])), 'normalisation is idempotent');
  }

  section('[A2] the TARGETED relational refresh (fetchRelationalSectionsNow) delivers `cat` — the path that ran seconds after every save');
  {
    const served = { data: { inventory: [clone(OLD_ITEM), clone(NEW_ITEM_1), clone(NEW_ITEM_2)] } };
    const env = freshEnv({
      API_RELATIONAL_SECTIONS_URL: 'http://x/api/relational/sections',
      encodeURIComponent, authHeaders: () => ({}), forceLogoutExpiredSession() {},
      fetch: async () => ({ status: 200, ok: true, json: async () => clone(served) }),
    });
    const decls = [fn('withItemCat')];
    if (has('normaliseItemCatSections')) decls.push(fn('normaliseItemCatSections'));
    decls.push(fn('fetchRelationalSectionsNow'));
    const h = lift(decls, ['fetchRelationalSectionsNow'], env);
    const body = await h.fetchRelationalSectionsNow(['inventory']);
    const inv = body.data.inventory;
    ok(inv.every(i => typeof i.cat === 'string' && i.cat.length > 0), 'every refreshed item carries a category under `cat`', inv.map(i => i.cat));
    // The real InventoryPage derivation of the category chips/filter/dropdown.
    const catsExpr = SRC.match(/const cats\s*=\s*(\[\.\.\.new Set\(activeInventory\.map\(i=>i\.cat\)\)\]\.sort\(\));/);
    ok(!!catsExpr, 'InventoryPage still derives categories from items\' `cat` (the model this fix preserves)');
    const activeInventory = inv.filter(i => i.active !== false);
    const cats = eval(catsExpr[1]); // eslint-disable-line no-eval
    ok(cats.indexOf('Signage Boards') !== -1, 'the NEW category survives the post-save refresh (it used to vanish here)', cats);
    ok(activeInventory.filter(i => i.cat === 'Signage Boards').length === 2, 'filtering by the new category still shows both of its items');
  }

  section('[A3] fetchFromServer + saveToServer normalise through the same single helper');
  {
    const ff = fn('fetchFromServer'), sv = fn('saveToServer');
    ok(/normaliseItemCatSections\(data\)/.test(ff), 'fetchFromServer normalises the full GET');
    ok(/normaliseItemCatSections\(confirmed\.data\)/.test(sv), 'saveToServer normalises the PUT response it folds into the baseline');
  }

  /* ════════════════════════════════════════════════════════════════════
     B. hydration must adopt the SERVER's inventory
     ════════════════════════════════════════════════════════════════════ */
  // The real inventory useState initialiser, lifted verbatim.
  const initAt = SRC.indexOf('const [inventory,    setInventory]    = useState(()=>');
  const initFn = braceBlock(SRC, SRC.indexOf('{', initAt + 'const [inventory,    setInventory]    = useState(()=>'.length - 1));
  function initialInventoryFrom(_saved) {
    const env = freshEnv({ _saved });
    return lift([fn('withItemCat'), 'function __init()' + initFn], ['__init'], env).__init();
  }

  // localStorage cache from the PREVIOUS session in this browser: written after
  // a targeted refresh (so the relational item carries only `category`), and —
  // like any real cache — missing a seed id and missing NEW_ITEM_2, created
  // later in another browser/session.
  const seedIds = new Set(INITIAL_INVENTORY.map(i => i.id));
  const _saved = { v: DATA_VERSION, jobs: [{ id: 11, num: 'SNS-1' }], customers: [], quotes: [], inventory: [clone(OLD_ITEM), clone(NEW_ITEM_1)].concat(INITIAL_INVENTORY.filter(i => i.id !== 1 && i.id !== 2).map(clone)), _autoSavedAt: '2026-09-27T10:00:00.000Z' };
  const serverInventory = [clone(OLD_ITEM), { ...clone(NEW_ITEM_1), cat: 'Signage Boards' }, { ...clone(NEW_ITEM_2), cat: 'Signage Boards' }].concat(INITIAL_INVENTORY.filter(i => i.id !== 1 && i.id !== 2).map(clone));
  const dbData = { v: DATA_VERSION, jobs: [{ id: 11, num: 'SNS-1' }, { id: 12, num: 'SNS-2' }], customers: [], quotes: [], inventory: serverInventory, _serverRevision: 'rev-2', _autoSavedAt: '2026-09-28T09:00:00.000Z', _relationalAuthoritativeSections: [] };

  const initialInventory = initialInventoryFrom(clone(_saved));
  ok(JSON.stringify(initialInventory) !== JSON.stringify(_saved.inventory), '[precondition] the real initialiser DOES transform the cache (seed injection / category mapping) — the trigger for mechanism B');
  ok(initialInventory.some(i => i.id === 1) && seedIds.has(1), '[precondition] a demo seed item (id 1) was injected into pre-hydration state');

  async function runHydration(startRefValue, cutOver) {
    const applied = [];
    const state = { ...clone(_saved), inventory: initialInventory };
    const env = freshEnv({
      _saved: clone(_saved),
      cancelled: false, myAttemptGen: 1, hydrationAttemptRef: { current: 1 },
      currentSnapshotRef: { current: startRefValue === 'state' ? state : null },
      fetchFromServer: async () => {
        // by the time the GET returns, the snapshot effect has populated the ref
        env.currentSnapshotRef.current = state;
        const d = clone(dbData); d._relationalAuthoritativeSections = cutOver ? ['inventory'] : []; return d;
      },
      applyServerData: (d) => { applied.push(d); for (const k of Object.keys(d)) if (k[0] !== '_') state[k] = d[k]; },
      apiReadyRef: { current: false }, apiSaveTimerRef: { current: null }, dbConfirmedEmptyRef: { current: false },
      setApiMsg() {}, setHydrationStatus() {}, setHydrationError() {},
      setTimeout: () => 0, clearTimeout() {}, enqueueMergeAndSave: async () => false,
      MAX_AUTO_HYDRATION_RETRIES: 5, RETRY_BASE_MS: 1, RETRY_MAX_MS: 1,
    });
    const h = lift([fn('locallyChangedSections'), fn('mergeCreditNotes'), fn('attemptHydration')], ['attemptHydration'], env);
    await h.attemptHydration(0);
    return { state, applied, baseline: env.serverBaselineRef.current };
  }

  for (const [label, startRef] of [['first page load (ref not yet populated)', null], ['retry / logout→login in the same tab (ref already populated)', 'state']]) {
    section('[B1] hydration — ' + label);
    const r = await runHydration(startRef, false);
    const ids = new Set(r.state.inventory.map(i => i.id));
    ok(ids.has(502), 'an item created elsewhere after this browser\'s cache (id 502) is present after reload', [...ids].filter(i => i > 400));
    ok(ids.has(501), 'the item created in this browser (id 501) is present after reload');
    ok(!ids.has(1), 'the stale/demo seed item (id 1) that is NOT on the server does not survive hydration');
    ok(JSON.stringify(r.state.inventory) === JSON.stringify(r.baseline.inventory), 'displayed inventory == the server baseline (nothing looks "locally changed")');
    ok(r.state.inventory.filter(i => i.cat === 'Signage Boards').length === 2, 'the new category and both of its items are shown after reload');
  }

  section('[B2] JSON mode (inventory NOT cut over): the first autosave after reload must not delete anything');
  {
    const r = await runHydration('state', false);
    const sent = [];
    const env = freshEnv({
      apiReadyRef: { current: true }, dbConfirmedEmptyRef: { current: false },
      fetchFromServer: async () => clone(r.baseline),
      saveToServer: async (p) => { sent.push(p); return { success: true, data: p, revision: 'rev-3' }; },
      stateStamp: (o) => (o && (o._autoSavedAt || o.savedAt)) || '',
      setInventory() {}, setJobs() {}, setQuotes() {}, setCustomers() {},
    });
    const h = lift([fn('isRelationalAuthoritative'), fn('assertNoUnwiredRelationalSections'), fn('locallyChangedSections'), fn('mergeSectionArray'), fn('mergeCreditNotes'), fn('mergeAndSave')], ['mergeAndSave'], env);
    env.serverBaselineRef.current = r.baseline;
    let threw = null, res;
    try { res = await h.mergeAndSave({ ...r.state, v: DATA_VERSION }, r.baseline); } catch (e) { threw = e.message; }
    const deleted = sent.length && sent[0]._deletedIds ? (sent[0]._deletedIds.inventory || []) : [];
    ok(!threw, 'autosave does not throw', threw);
    ok(deleted.length === 0, 'NO inventory ids are declared deleted (the stale cache used to delete the item created elsewhere)', deleted);
    ok(res === false || sent.length === 0 || !sent[0].inventory || sent[0].inventory.some(i => i.id === 502), 'if anything is sent, item 502 is still in it');
  }

  section('[B3] Inventory cut over: autosave after reload is not blocked by a phantom inventory diff');
  {
    const r = await runHydration('state', true);
    const env = freshEnv({
      apiReadyRef: { current: true }, dbConfirmedEmptyRef: { current: false },
      fetchFromServer: async () => clone(r.baseline),
      saveToServer: async (p) => ({ success: true, data: p }),
      stateStamp: (o) => (o && (o._autoSavedAt || o.savedAt)) || '',
    });
    env.relationalAuthoritativeSectionsRef.current = ['inventory'];
    const h = lift([fn('isRelationalAuthoritative'), fn('assertNoUnwiredRelationalSections'), fn('locallyChangedSections'), fn('mergeSectionArray'), fn('mergeCreditNotes'), fn('mergeAndSave')], ['mergeAndSave'], env);
    let threw = null;
    try { await h.mergeAndSave({ ...r.state, v: DATA_VERSION }, r.baseline); } catch (e) { threw = e.message; }
    ok(!threw, 'no "Cannot save inventory" refusal — every other section\'s autosave keeps working', threw);
  }

  /* ════════════════════════════════════════════════════════════════════
     C. a transient server omission cannot un-cut-over inventory
     ════════════════════════════════════════════════════════════════════ */
  section('[C1] fetchFromServer keeps inventory authoritative and ignores the frozen JSON fallback copy');
  {
    const liveInv = [clone(OLD_ITEM), { ...clone(NEW_ITEM_1), cat: 'Signage Boards' }];
    const frozenInv = [clone(OLD_ITEM)]; // pre-cutover copy: knows nothing created since
    const responses = [
      { data: { v: DATA_VERSION, jobs: [], inventory: liveInv }, updated_at: 'r1', relationalAuthoritativeSections: ['inventory', 'jobs'] },
      { data: { v: DATA_VERSION, jobs: [], inventory: frozenInv }, updated_at: 'r2', relationalAuthoritativeSections: ['jobs'] },
    ];
    let n = 0;
    const env = freshEnv({
      API_STATE_URL: 'http://x/api/platform-state', authHeaders: () => ({}), forceLogoutExpiredSession() {},
      fetch: async () => ({ status: 200, ok: true, json: async () => clone(responses[n++]) }),
    });
    const decls = [fn('withItemCat')];
    for (const x of ['normaliseItemCatSections', 'adoptRelationalAuthority']) if (has(x)) decls.push(fn(x));
    decls.push(fn('isRelationalAuthoritative'), fn('fetchFromServer'));
    const h = lift(decls, ['fetchFromServer', 'isRelationalAuthoritative'], env);
    const first = await h.fetchFromServer();
    env.relationalAuthoritativeSectionsRef.current = first._relationalAuthoritativeSections;
    env.serverBaselineRef.current = first;
    const second = await h.fetchFromServer();
    env.relationalAuthoritativeSectionsRef.current = second._relationalAuthoritativeSections; // what applyServerData does
    ok(second._relationalAuthoritativeSections.indexOf('inventory') !== -1, 'inventory stays relational-authoritative for the session', second._relationalAuthoritativeSections);
    ok(h.isRelationalAuthoritative('inventory') === true, 'so Add/Edit Stock Item keeps using the relational API (never the JSON path the server silently strips)');
    ok((second.inventory || []).some(i => i.id === 501), 'the frozen pre-cutover copy is NOT applied — the new item stays on screen', (second.inventory || []).map(i => i.id));
  }

  section('[C2] a PUT the server answered with relationalAuthoritativeSectionsIgnored teaches the session');
  {
    const env = freshEnv({
      API_STATE_URL: 'http://x', authHeaders: () => ({}), forceLogoutExpiredSession() {},
      fetch: async () => ({ status: 200, ok: true, json: async () => ({ success: true, data: {}, relationalAuthoritativeSectionsIgnored: ['inventory'] }) }),
    });
    const decls = [fn('withItemCat')];
    for (const x of ['normaliseItemCatSections', 'adoptRelationalAuthority']) if (has(x)) decls.push(fn(x));
    decls.push(fn('isRelationalAuthoritative'), fn('saveToServer'));
    const h = lift(decls, ['saveToServer', 'isRelationalAuthoritative'], env);
    await h.saveToServer({ inventory: [] });
    ok(h.isRelationalAuthoritative('inventory') === true, 'after the server reports it stripped inventory, inventory is routed relationally from then on');
  }

  /* ════════════════════════════════════════════════════════════════════
     D. InventoryPage wiring (source contracts on the real component)
     ════════════════════════════════════════════════════════════════════ */
  section('[D] InventoryPage save wiring');
  {
    const page = fn('InventoryPage');
    ok(/async function saveItem__impl\(item\) \{[\s\S]{0,400}?if\(isRelationalAuthoritative\('inventory'\)\)\{[\s\S]{0,400}const result = await relationalApi\.createInventoryItem\(patch\);[\s\S]{0,300}setInventory\(inventoryUpdater\)/.test(page),
      'create waits for the server\'s acknowledgement BEFORE the item is added to the list');
    ok(/catch\(e\)\{\s*\n\s*alert\(describeSaveConflictError\(e, 'inventory item'\)\);\s*\n\s*return;/.test(page), 'a failed create/edit is alerted and the form stays open (never shown as saved)');
    ok(/onSave=\{async it=>\{await saveItem\(it\);/.test(page), 'the modal awaits the save, so its Saving… lock covers the whole request (no double-create)');
    ok(/onImport=\{importInventory\}/.test(page) && /function importInventory\(list\) \{\s*\n\s*if\(isRelationalAuthoritative\('inventory'\)\)\{\s*\n\s*alert\(/.test(page),
      'Bulk Import refuses up front when inventory is relational (it used to show rows that were never persisted)');
    ok(/const _catFiltered = catFilter==='all' \? activeInventory : activeInventory\.filter\(i=>i\.cat===catFilter\);/.test(page), 'category filter keys on `cat` (why the mapping matters)');
    ok(!/localStorage/.test(page), 'InventoryPage does not keep inventory in browser storage (no cache-based "fix")');
  }

  section('[D2] deleting one item cannot remove others (real removeItem updater)');
  {
    const page = fn('InventoryPage');
    ok(/const inventoryUpdater = prev=>prev\.filter\(i=>i\.id!==id\);/.test(page), 'removeItem filters exactly one id');
    const upd = (id) => (prev) => prev.filter(i => i.id !== id);
    const after = upd(501)([clone(OLD_ITEM), clone(NEW_ITEM_1), clone(NEW_ITEM_2)]);
    ok(after.length === 2 && after.some(i => i.id === 502) && after.some(i => i.id === OLD_ITEM.id), 'the sibling item in the same category and the unrelated item survive');
  }


  /* ════════════════════════════════════════════════════════════════════
     FINAL HARDENING — every Inventory write path in relational mode
     ════════════════════════════════════════════════════════════════════ */
  // A lazily-resolving environment: stubs first, then REAL top-level
  // functions lifted from index.html on demand, then JS globals.
  function smartEnv(stubs) {
    const cache = {};
    const missing = new Set();
    const proxy = new Proxy({}, {
      has(_, k) { return typeof k === 'string'; },
      get(_, k) {
        if (k === Symbol.unscopables) return undefined;
        if (Object.prototype.hasOwnProperty.call(stubs, k)) return stubs[k];
        if (Object.prototype.hasOwnProperty.call(cache, k)) return cache[k];
        if (typeof k === 'string' && new RegExp('\\n(async\\s+)?function\\s+' + k + '\\s*\\(').test(SRC)) {
          const m = new RegExp('\\n(async\\s+)?function\\s+' + k + '\\s*\\(').exec(SRC);
          cache[k] = new Function('env', 'with (env) {\n' + braceBlock(SRC, m.index + 1, true) + '\nreturn ' + k + ';\n}')(proxy); // eslint-disable-line no-new-func
          return cache[k];
        }
        if (k in globalThis) return globalThis[k];
        missing.add(k);
        return undefined;
      },
      set(_, k, v) { stubs[k] = v; return true; },
    });
    proxy.__missing = missing;
    return proxy;
  }
  function liftIn(env, name) {
    return new Function('env', 'with (env) {\n' + fn(name) + '\nreturn ' + name + ';\n}')(env); // eslint-disable-line no-new-func
  }
  function applyUpd(cur, upd) { return typeof upd === 'function' ? upd(cur) : upd; }

  section('[E1] computeStockConsumption — per-item totals, string/number ids, unknown and non-positive skipped');
  if (!has('computeStockConsumption')) ok(false, 'computeStockConsumption exists (relational deduction helper)');
  else {
    const env = smartEnv({});
    const f = liftIn(env, 'computeStockConsumption');
    const inv = [{ id: 10, sku: 'A' }, { id: '11', sku: 'B' }, { id: 12, sku: 'C' }];
    const out = f([{ itemId: 10, qty: 2 }, { itemId: '10', qty: '3' }, { itemId: 11, qty: 1 }, { itemId: 999, qty: 5 }, { itemId: 12, qty: 0 }, { desc: 'custom', qty: 4 }], inv);
    const by = Object.fromEntries(out.map(c => [String(c.item.id), c.qty]));
    ok(by['10'] === 5 && by['11'] === 1, 'quantities summed per item across lines, number and string ids unified', by);
    ok(!('12' in by) && out.length === 2, 'unknown items and zero totals produce no deduction');
  }

  // ── Quote → Job (JSON jobs/quotes path) with RELATIONAL Inventory ──
  function convertHarness(opts) {
    const calls = { saves: [], adjusts: [], alerts: [], reserve: 0 };
    const state = {
      jobs: [], quotes: [opts.quote], purchaseOrders: [], accInvoices: [],
      inventory: opts.inventory.map(clone),
    };
    const stubs = {
      jobs: state.jobs, quotes: state.quotes, inventory: state.inventory, purchaseOrders: state.purchaseOrders, accInvoices: state.accInvoices,
      creditNotes: [], customers: [], user: { role: 'admin', co: 2 }, companies: [],
      convertingRef: { current: false },
      isRelationalAuthoritative: (s) => (opts.relational || []).indexOf(s) !== -1,
      relationalCutOverSeenRef: { current: (opts.relational || []).slice() },
      relationalAuthoritativeSectionsRef: { current: (opts.relational || []).slice() },
      fetchFreshnessTokens: async () => ({ cutOver: (opts.serverCutOver || opts.relational || []).slice() }),
      requestRelationalRefresh() {},
      reserveJobForQuote: async () => { calls.reserve++; return { jobNumber: 'SNS-09999' }; },
      reserveJobNumber: async () => { calls.reserve++; return 'SNS-09998'; },
      reservePONumber: async () => 'PO-00999',
      reassignJobForQuote: async () => ({ error: 'n/a' }),
      forceSaveSections: async (o) => { calls.saves.push(o); if (opts.saveFails) throw new Error('save refused'); return true; },
      relationalApi: opts.api || { adjustInventoryStock: async (id, v, d) => { calls.adjusts.push([id, v, d]); if (opts.adjustFails) { const e = new Error('This record was changed elsewhere'); e.status = 409; throw e; } const it = state.inventory.find(i => String(i._relId) === String(id)); return { newStock: Math.max(0, it.stock + d), rowVersion: v + 1 }; } },
      setJobs: (u) => { state.jobs = applyUpd(state.jobs, u); }, setQuotes: (u) => { state.quotes = applyUpd(state.quotes, u); },
      setInventory: (u) => { state.inventory = applyUpd(state.inventory, u); }, setPurchaseOrders: (u) => { state.purchaseOrders = applyUpd(state.purchaseOrders, u); },
      setAccInvoices: (u) => { state.accInvoices = applyUpd(state.accInvoices, u); },
      setViewQuote() {}, setConvertedInfo(v) { state.converted = v; }, onJobCreated() {},
      alert: (m) => calls.alerts.push(String(m)), window: { confirm: () => true },
      setTimeout: (f) => { f(); return 0; },
      serverBaselineRef: { current: { inventory: opts.inventory.map(clone) } },
      STATUS_TO_STAGE: { quote_approved: 4 },
    };
    const env = smartEnv(stubs);
    const handle = liftIn(env, 'handleConvertToJob');
    return { handle, calls, state, env, stubs };
  }
  const INV_A = { id: 10, _relId: '10', _relRowVersion: 3, sku: 'INV-A', name: 'ACM 3mm', cat: 'Signage Boards', category: 'Signage Boards', supplierId: 55, stock: 20, reorder: 2, unit: 'sheet', cost: 400, sell: 650 };
  const INV_B = { id: 11, _relId: '11', _relRowVersion: 7, sku: 'INV-B', name: 'Unrelated', cat: 'Vinyl', category: 'Vinyl', supplierId: null, stock: 9, reorder: 1, unit: 'm', cost: 1, sell: 2 };
  const QUOTE = { id: 700, num: 'SQ-00700', client: 'Client', co: 2, status: 'approved', total: 1000, discount: '', setupFee: '',
    lines: [{ id: 1, itemId: 10, desc: 'ACM', qty: 3, unitPrice: 100, subtotal: 300 }, { id: 2, itemId: '10', desc: 'ACM again', qty: 2, unitPrice: 100, subtotal: 200 }, { id: 3, desc: 'labour', qty: 1, unitPrice: 500, subtotal: 500 }] };

  {
    section('[E2] Quote → Job with relational Inventory (jobs/quotes on the JSON path): deduction goes through the relational API, never platform_state');
    {
      const h = convertHarness({ quote: clone(QUOTE), inventory: [INV_A, INV_B], relational: ['inventory'] });
      await h.handle(clone(QUOTE), false);
      const save = h.calls.saves[0] || {};
      ok(h.calls.saves.length === 1 && Array.isArray(save.jobs) && save.jobs.length === 1, 'the job/quote save happened once', h.stubs.__missing ? [...h.env.__missing] : null);
      ok(!('inventory' in save), 'the platform_state save carries NO inventory section', Object.keys(save));
      ok(h.calls.adjusts.length === 1 && h.calls.adjusts[0][0] === '10' && h.calls.adjusts[0][1] === 3 && h.calls.adjusts[0][2] === -5, 'exactly one version-checked adjust: item 10, expected version 3, delta -5', h.calls.adjusts);
      const a = h.state.inventory.find(i => i.id === 10), b = h.state.inventory.find(i => i.id === 11);
      ok(a.stock === 15 && a._relRowVersion === 4, 'local stock/version are the SERVER-acknowledged values', { stock: a.stock, v: a._relRowVersion });
      ok(a.cat === 'Signage Boards' && a.category === 'Signage Boards' && a.supplierId === 55, 'category and supplier survive the deduction');
      ok(JSON.stringify(b) === JSON.stringify(INV_B), 'the unrelated item is untouched');
      ok(h.calls.alerts.every(m => !/NOT deducted/.test(m)), 'no failure reported');
    }

    section('[E3] a stale/failed deduction is reported by name and never shown as deducted');
    {
      const h = convertHarness({ quote: clone(QUOTE), inventory: [INV_A, INV_B], relational: ['inventory'], adjustFails: true });
      await h.handle(clone(QUOTE), false);
      ok(h.calls.saves.length === 1, 'the job itself was created (its save was confirmed)');
      ok(h.state.inventory.find(i => i.id === 10).stock === 20, 'local stock is NOT changed — nothing pretends the deduction happened');
      ok(h.calls.alerts.some(m => /WAS created, but stock was NOT deducted/.test(m) && /INV-A/.test(m) && /5 not deducted/.test(m)), 'the user is told exactly which item/quantity was not deducted', h.calls.alerts);
    }

    section('[E4] an item with no server record id stops the conversion BEFORE anything is reserved or saved');
    {
      const bad = { ...INV_A, _relId: undefined };
      const h = convertHarness({ quote: clone(QUOTE), inventory: [bad, INV_B], relational: ['inventory'] });
      await h.handle(clone(QUOTE), false);
      ok(h.calls.reserve === 0 && h.calls.saves.length === 0 && h.calls.adjusts.length === 0, 'no job number reserved, nothing saved, nothing adjusted');
      ok(h.calls.alerts.some(m => /Job could NOT be created/.test(m) && /Nothing was changed/.test(m)), 'visible refusal');
    }

    section('[E5] JSON mode (inventory NOT relational) is unchanged; an untouched inventory is no longer sent');
    {
      const h = convertHarness({ quote: clone(QUOTE), inventory: [INV_A, INV_B], relational: [] });
      await h.handle(clone(QUOTE), false);
      const save = h.calls.saves[0] || {};
      ok(Array.isArray(save.inventory) && save.inventory.find(i => i.id === 10).stock === 15, 'JSON mode still deducts through its own (JSON) save, as before');
      ok(h.calls.adjusts.length === 0, 'and never calls the relational API');
      const noStock = { ...clone(QUOTE), lines: [{ id: 3, desc: 'labour', qty: 1, unitPrice: 500, subtotal: 500 }] };
      const h2 = convertHarness({ quote: noStock, inventory: [INV_A, { ...INV_B, stock: 99 }], relational: [] });
      await h2.handle(noStock, false);
      ok(!('inventory' in (h2.calls.saves[0] || {})), 'a quote with no stock lines no longer sends the whole (possibly stale) inventory');
    }

    section('[E6] the fully relational conversion (quotes+jobs cut over) leaves stock to the server transaction');
    {
      const api = { convertQuoteToJob: async () => ({ jobId: 5, jobNumber: 'SNS-00005', jobRowVersion: 1, quoteRowVersion: 2 }), adjustInventoryStock: async () => { throw new Error('must not be called'); } };
      const h = convertHarness({ quote: { ...clone(QUOTE), _relId: '700' }, inventory: [INV_A, INV_B], relational: ['inventory', 'jobs', 'quotes'], api });
      await h.handle({ ...clone(QUOTE), _relId: '700' }, false);
      ok(h.calls.saves.length === 0, 'no platform_state save at all');
      ok(JSON.stringify(h.state.inventory.map(i => i.stock)) === JSON.stringify([20, 9]), 'no client-side stock arithmetic (server deducts inside the conversion transaction; the post-mutation refresh shows it)');
    }
  }

  if (!has('importInventoryRowsRelational')) ok(false, 'importInventoryRowsRelational exists (relational Bulk Import)');
  else {
    section('[F1] Bulk Import (relational): creates, updates, restores — category kept, supplier untouched, nothing via JSON');
    {
      const log = [];
      let nextId = 900;
      const api = {
        createInventoryItem: async (b) => { log.push(['create', b]); nextId++; return { id: String(nextId), rowVersion: 1 }; },
        updateInventoryItem: async (id, v, p) => { log.push(['update', id, v, p]); return { rowVersion: v + 1 }; },
        deleteInventoryItem: async (id, v) => { log.push(['delete', id, v]); return { deactivated: true }; },
      };
      const env = smartEnv({});
      const imp = liftIn(env, 'importInventoryRowsRelational');
      const current = [{ ...INV_A }, { ...INV_B }, { id: 12, _relId: '12', _relRowVersion: 2, sku: 'OLD-1', name: 'Discontinued', cat: 'Old', active: false }];
      const rows = [
        { sku: 'inv-a', name: 'ACM 3mm v2', cat: 'Boards 2', stock: 30, reorder: 3, unit: 'sheet', cost: 410, sell: 660 },
        { sku: 'NEW-1', name: 'New item', cat: 'Brand New Cat', stock: 5, reorder: 1, unit: 'unit', cost: 1, sell: 2 },
        { sku: 'OLD-1', name: 'Back again', cat: 'Old', stock: 1, reorder: 1, unit: 'unit', cost: 1, sell: 2 },
      ];
      const r = await imp(rows, 'add', current, api);
      ok(r.report.created.length === 1 && r.report.updated.length === 1 && r.report.restored.length === 1 && r.report.failed.length === 0, 'report: 1 created, 1 updated, 1 restored, 0 failed', r.report);
      const upd = log.find(x => x[0] === 'update' && x[1] === '10');
      ok(upd && upd[2] === 3 && upd[3].category === 'Boards 2' && !('supplierId' in upd[3]), 'update is version-checked, carries the category, never touches the supplier', upd);
      const cr = log.find(x => x[0] === 'create');
      ok(cr && cr[1].category === 'Brand New Cat', 'new item created with its category');
      const rest = log.find(x => x[0] === 'update' && x[1] === '12');
      ok(rest && rest[3].active === true, 'a SKU matching only a removed item restores it (never saved-but-invisible)');
      const a = r.changed.find(i => String(i.id) === '10');
      ok(a.cat === 'Boards 2' && a.category === 'Boards 2' && a.supplierId === 55 && a._relRowVersion === 4, 'local result: new category, supplier kept, server row version');
      ok(!log.some(x => x[0] === 'delete'), 'add mode removes nothing');
      ok(/✅ Import saved to the server\./.test(r.message) && /3 of 3 rows saved/.test(r.message), 'success message only after every row was acknowledged');
    }

    section('[F2] Bulk Import failures are reported; no false success; replace mode never removes after a failure');
    {
      const log = [];
      const api = {
        createInventoryItem: async (b) => { if (b.sku === 'BAD') { const e = new Error('The supplier reference … does not match'); e.status = 409; throw e; } log.push(['create', b.sku]); return { id: '950', rowVersion: 1 }; },
        updateInventoryItem: async (id, v) => { const e = new Error('This record was changed elsewhere'); e.status = 409; throw e; },
        deleteInventoryItem: async (id) => { log.push(['delete', id]); return { deactivated: true }; },
      };
      const env = smartEnv({});
      const imp = liftIn(env, 'importInventoryRowsRelational');
      const rows = [{ sku: 'GOOD', name: 'g', cat: 'C', stock: 1 }, { sku: 'BAD', name: 'b', cat: 'C', stock: 1 }, { sku: 'INV-A', name: 'stale', cat: 'C', stock: 1 }];
      const r = await imp(rows, 'replace', [{ ...INV_A }, { ...INV_B }], api);
      ok(r.report.failed.length === 2 && r.report.created.length === 1, 'two failures recorded (create + stale update), one success', r.report);
      ok(r.report.removalsSkipped === true && !log.some(x => x[0] === 'delete'), 'replace mode removed NOTHING because not every row saved');
      ok(/WITH ERRORS/.test(r.message) && /2 NOT saved/.test(r.message) && /BAD/.test(r.message) && /INV-A/.test(r.message) && !/✅/.test(r.message), 'the message lists every failure and never says success', r.message);
      ok(!r.changed.some(i => i.sku === 'INV-A'), 'the failed update is not applied locally');

      const r2 = await imp([{ sku: 'GOOD', name: 'g', cat: 'C', stock: 1 }], 'replace', [{ ...INV_A }, { ...INV_B }], { ...api, updateInventoryItem: async (id, v) => ({ rowVersion: v + 1 }) });
      ok(r2.report.removed.length === 2 && log.filter(x => x[0] === 'delete').length === 2, 'a fully successful replace removes (soft-deletes) the other active items', r2.report);
    }

    section('[F3] Bulk Import wiring');
    {
      const page = fn('InventoryPage');
      ok(/onImportRows=\{importInventoryRelational\} resolveImportMode=\{\(\)=>confirmInventoryWriteMode\(\{ existing: true \}\)\}/.test(page), 'the modal gets the relational importer and decides the path at confirm time');
      ok(/const result = await importInventoryRowsRelational\(rows, mode, inventory, relationalApi\);/.test(page) && /syncRelationalBaseline\('inventory', inventoryUpdater\);/.test(page), 'only server-acknowledged records are applied locally');
      const modal = fn('BulkImportModal');
      ok(/if \(importMode === 'relational' && onImportRows\) \{[\s\S]{0,900}message = await onImportRows\(preview, mode\);[\s\S]{0,700}alert\(message\);[\s\S]{0,40}return;/.test(modal), 'the modal shows the server-built report and returns before the JSON branch');
    }

    section('[F4] no JSON fallback: remove / merge refuse when a relational item has no server id');
    {
      const alerts = []; let inv = [{ id: 1, sku: 'X', name: 'no id' }];
      const env = smartEnv({ inventory: inv, isRelationalAuthoritative: (s) => s === 'inventory', relationalCutOverSeenRef: { current: ['inventory'] }, relationalAuthoritativeSectionsRef: { current: ['inventory'] }, requestRelationalRefresh() {}, window: { confirm: () => true }, alert: (m) => alerts.push(m), setInventory: (u) => { inv = applyUpd(inv, u); }, relationalApi: {} });
      const rm = liftIn(env, 'removeItem__impl');
      await rm(1);
      ok(inv.length === 1 && alerts.some(m => /could not be removed/.test(m)), 'removeItem refuses instead of filtering locally');
      const merges = SRC.match(/alert\('The stock could not be merged: the target inventory item has no server record id\./g) || [];
      ok(merges.length === 2, 'both mergeIntoInventory copies refuse instead of a JSON stock change', merges.length);
    }
  }

  section('[G] temporary relational read failure');
  if (has('adoptRelationalAuthority')) {
    const responses = [];
    let n = 0; const msgs = [];
    const env = freshEnv({
      API_STATE_URL: 'http://x', authHeaders: () => ({}), forceLogoutExpiredSession() {}, setApiMsg: (m) => msgs.push(m),
      fetch: async () => ({ status: 200, ok: true, json: async () => clone(responses[n++]) }),
    });
    const h = lift([fn('withItemCat'), fn('normaliseItemCatSections'), fn('adoptRelationalAuthority'), fn('isRelationalAuthoritative'), fn('fetchFromServer')], ['fetchFromServer', 'isRelationalAuthoritative'], env);
    // FIRST load of a session, inventory cut over but its relational read failed → frozen copy served
    responses.push({ data: { v: DATA_VERSION, jobs: [], inventory: [clone(OLD_ITEM)] }, updated_at: 'r1', relationalAuthoritativeSections: ['jobs'], relationalReadFailedSections: ['inventory'] });
    let threw = null; try { await h.fetchFromServer(); } catch (e) { threw = e.message; }
    ok(!!threw && /could not load inventory/.test(threw), 'first load: the frozen copy is refused (hydration retries) instead of shown as live', threw);
    ok(h.isRelationalAuthoritative('inventory') === false && env.relationalCutOverSeenRef.current.indexOf('inventory') !== -1, 'and inventory is already remembered as relational for routing');
    // Healthy read, then a failed one: last good copy kept, message shown
    responses.push({ data: { v: DATA_VERSION, jobs: [], inventory: [clone(OLD_ITEM), { ...clone(NEW_ITEM_1) }] }, updated_at: 'r2', relationalAuthoritativeSections: ['jobs', 'inventory'] });
    const good = await h.fetchFromServer(); env.serverBaselineRef.current = good; env.relationalAuthoritativeSectionsRef.current = good._relationalAuthoritativeSections;
    responses.push({ data: { v: DATA_VERSION, jobs: [], inventory: [clone(OLD_ITEM)] }, updated_at: 'r3', relationalAuthoritativeSections: ['jobs'], relationalReadFailedSections: ['inventory'] });
    const later = await h.fetchFromServer(); env.relationalAuthoritativeSectionsRef.current = later._relationalAuthoritativeSections;
    ok(later.inventory.some(i => i.id === 501), 'later failure: the last good inventory is kept (new item still present)');
    ok(h.isRelationalAuthoritative('inventory') === true, 'write authority unchanged');
    ok(msgs.some(m => /Could not refresh inventory/.test(m)), 'the read failure is surfaced to the user', msgs);
    ok(!('_relationalRetainedSections' in JSON.parse(JSON.stringify(later))), 'read metadata is never serialised into a save payload');
  }


  /* ════════════════════════════════════════════════════════════════════
     MID-SESSION CUTOVER — Inventory switched to relational while this tab
     was open believing it was JSON
     ════════════════════════════════════════════════════════════════════ */
  function cutoverEnv(extra) {
    const st = { alerts: [], refreshes: 0, freshCalls: 0, serverCutOver: [], freshFails: false };
    const stubs = Object.assign({
      relationalAuthoritativeSectionsRef: { current: [] },   // the tab still believes: JSON
      relationalCutOverSeenRef: { current: [] },
      serverBaselineRef: { current: null },
      fetchFreshnessTokens: async () => { st.freshCalls++; if (st.freshFails) throw new Error('offline'); return { cutOver: st.serverCutOver.slice(), sections: {} }; },
      requestRelationalRefresh: () => { st.refreshes++; },
      alert: (m) => st.alerts.push(String(m)),
      console: { log() {}, warn() {}, debug() {}, error() {} },
    }, extra || {});
    return { env: smartEnv(stubs), st, stubs };
  }
  const haveGate = has('confirmInventoryWriteMode');
  if (!haveGate) ok(false, 'confirmInventoryWriteMode exists (mid-session cutover gate)');

  section('[M1] the gate asks the server, adopts relational at once, and never downgrades');
  if (haveGate) {
    const { env, st } = cutoverEnv();
    const gate = liftIn(env, 'confirmInventoryWriteMode');
    const isRel = liftIn(env, 'isRelationalAuthoritative');
    ok(await gate({ existing: false }) === 'json' && st.freshCalls === 1, 'server still JSON → "json" (the JSON path is still correct)');
    st.serverCutOver = ['inventory'];                         // ← the cutover happens now
    ok(await gate({ existing: false }) === 'relational', 'after the cutover a CREATE is routed relationally');
    ok(isRel('inventory') === true && st.refreshes === 1, 'authority adopted immediately and a refresh from the server requested');
    st.serverCutOver = [];                                    // e.g. a later answer that omits it
    const calls = st.freshCalls;
    ok(await gate({ existing: true }) === 'relational' && st.freshCalls === calls, 'sticky: once relational, never asks again and never downgrades');
    const e2 = cutoverEnv(); e2.st.serverCutOver = ['inventory'];
    const gate2 = liftIn(e2.env, 'confirmInventoryWriteMode');
    ok(await gate2({ existing: true }) === null && e2.st.alerts.some(m => /Nothing was changed/.test(m) && /upgraded/.test(m)), 'a change to an EXISTING item after the cutover stops before anything changes, and says why');
    const e3 = cutoverEnv(); e3.st.freshFails = true;
    const gate3 = liftIn(e3.env, 'confirmInventoryWriteMode');
    ok(await gate3({ existing: false }) === null && e3.st.alerts.some(m => /Nothing was changed/.test(m) && /could not confirm/.test(m)), 'no answer from the server → nothing changes, user told to retry');
  }

  // A page-level harness for the real InventoryPage functions.
  function pageEnv(serverCutOver, invList) {
    const c = cutoverEnv();
    c.st.serverCutOver = serverCutOver.slice();
    const pg = { inventory: invList.map(clone), setCalls: 0, created: [], updated: [], deleted: [], closed: false };
    Object.assign(c.stubs, {
      inventory: pg.inventory,
      setInventory: (u) => { pg.setCalls++; pg.inventory = applyUpd(pg.inventory, u); },
      setShowAddItem: () => { pg.closed = true; }, setEditItem: () => {}, setCopyItem: () => {},
      window: { confirm: () => true },
      relationalApi: {
        createInventoryItem: async (b) => { pg.created.push(b); return { id: '777', rowVersion: 1 }; },
        updateInventoryItem: async (id, v, p) => { pg.updated.push([id, v, p]); return { rowVersion: v + 1 }; },
        deleteInventoryItem: async (id, v) => { pg.deleted.push([id, v]); return { deactivated: true }; },
      },
    });
    return Object.assign(c, { pg });
  }
  const JSON_ITEM = { id: 5001, sku: 'J-1', name: 'JSON-era item', cat: 'Vinyl', stock: 3, reorder: 1, unit: 'm', cost: 1, sell: 2, supplierId: null };

  section('[M2] CREATE right after the cutover → saved through the relational API; nothing via JSON');
  {
    const h = pageEnv(['inventory'], [JSON_ITEM]);
    const save = liftIn(h.env, 'saveItem__impl');
    await save({ id: 9999, sku: 'NEW-1', name: 'Brand new', cat: 'New Category', category: 'New Category', stock: 2, reorder: 1, unit: 'u', cost: 1, sell: 2, supplierId: null });
    ok(h.pg.created.length === 1 && h.pg.created[0].category === 'New Category', 'POST /relational/inventory was called with the category', h.pg.created);
    const added = h.pg.inventory.find(i => i.sku === 'NEW-1');
    ok(!!added && added._relId === '777', 'the item appears only as the server-acknowledged record (has its server id)', added);
    ok(h.pg.closed === true, 'the form closes only after the acknowledgement');
  }

  section('[M3] EDIT right after the cutover → stopped before any visible change');
  {
    const h = pageEnv(['inventory'], [JSON_ITEM]);
    const save = liftIn(h.env, 'saveItem__impl');
    await save({ ...JSON_ITEM, name: 'renamed' });
    ok(h.pg.setCalls === 0 && h.pg.inventory[0].name === 'JSON-era item', 'the visible list is untouched');
    ok(h.pg.updated.length === 0 && h.pg.created.length === 0, 'no write of any kind was sent');
    ok(h.st.alerts.some(m => /Nothing was changed/.test(m)) && h.st.refreshes === 1, 'user told to repeat after the refresh; refresh requested');
    ok(h.pg.closed === false, 'the edit form stays open (the draft is not lost)');
  }

  section('[M4] DELETE right after the cutover → stopped before any visible change');
  {
    const h = pageEnv(['inventory'], [JSON_ITEM]);
    const rm = liftIn(h.env, 'removeItem__impl');
    await rm(5001);
    ok(h.pg.setCalls === 0 && h.pg.inventory.length === 1 && h.pg.deleted.length === 0, 'item still listed, nothing sent');
    ok(h.st.alerts.some(m => /Nothing was changed/.test(m)), 'user told');
  }

  section('[M5] BULK IMPORT right after the cutover → no JSON import; relational once authority is known');
  if (!haveGate) ok(false, 'Bulk Import has a confirm-time authority check');
  else {
    const h = pageEnv(['inventory'], [JSON_ITEM]);
    const gate = liftIn(h.env, 'confirmInventoryWriteMode');
    const calls = { json: 0, rel: 0 };
    Object.assign(h.stubs, {
      busy: false, setBusy() {}, preview: [{ sku: 'IMP-1', name: 'Imported', cat: 'X', stock: 1 }], mode: 'add',
      onImport: () => { calls.json++; }, onImportRows: async () => { calls.rel++; return 'report'; },
      resolveImportMode: () => gate({ existing: true }), onClose() {},
    });
    const confirmImport = liftIn(h.env, 'confirmImport');
    await confirmImport();
    ok(calls.json === 0 && calls.rel === 0, 'first attempt after the cutover imports NOTHING (JSON import never runs)', calls);
    ok(h.st.alerts.some(m => /Nothing was changed/.test(m)), 'and the user is told to repeat it');
    await confirmImport();
    ok(calls.json === 0 && calls.rel === 1, 'the repeat goes through the relational importer', calls);
  }

  section('[M6] a stale JSON Inventory write can never end in an Inventory-success state (saveToServer)');
  {
    const mk = (response) => {
      const c = cutoverEnv();
      Object.assign(c.stubs, { API_STATE_URL: 'http://x', authHeaders: () => ({}), forceLogoutExpiredSession() {},
        fetch: async () => response });
      return Object.assign(c, { save: liftIn(c.env, 'saveToServer') });
    };
    const ok200 = (body) => ({ status: 200, ok: true, json: async () => body });
    // a) mixed partial: other section saved, inventory ignored
    let h = mk(ok200({ success: true, data: {}, relationalAuthoritativeSectionsIgnored: ['inventory'] }));
    await h.save({ _partial: true, inventory: [JSON_ITEM], savedCalcs: [] });
    ok(h.st.alerts.some(m => /inventory change was NOT saved/.test(m)), 'ignored changed inventory → explicit "NOT saved" message');
    ok(liftIn(h.env, 'isRelationalAuthoritative')('inventory') === true && h.st.refreshes === 1, 'authority learned; authoritative copy re-read (replaces the unsaved local change)');
    // b) full-state save where inventory was NOT among the changed sections
    h = mk(ok200({ success: true, data: {}, relationalAuthoritativeSectionsIgnored: ['inventory'] }));
    await h.save({ inventory: [JSON_ITEM], customers: [] }, ['customers']);
    ok(h.st.alerts.length === 0, 'an ignored but UNCHANGED inventory array raises no false alarm');
    // c) server refuses an inventory-only stale save
    h = mk({ status: 409, ok: false, json: async () => ({ conflict: true, type: 'relational_authoritative', sections: ['inventory'], error: 'Not saved: inventory is now stored in the relational database' }) });
    let threw = null; try { await h.save({ _partial: true, inventory: [JSON_ITEM] }); } catch (e) { threw = e.message; }
    ok(!!threw && h.st.alerts.some(m => /NOT saved/.test(m)), 'a refused inventory-only save throws AND tells the user', threw);
    // d) ordinary non-inventory save
    h = mk(ok200({ success: true, data: { savedCalcs: [] } }));
    const r = await h.save({ _partial: true, savedCalcs: [] });
    ok(r && r.success === true && h.st.alerts.length === 0, 'unrelated platform_state saves work exactly as before');
  }

  section('[M7] every interactive Inventory mutation passes the gate first');
  {
    const uses = (SRC.match(/await confirmInventoryWriteMode\(/g) || []).length + (SRC.match(/resolveImportMode=\{\(\)=>confirmInventoryWriteMode\(/g) || []).length;
    ok(uses >= 9, 'gate used by: add/edit/duplicate, delete, save-quote-line-as-item, move×2, merge×2, quote→job, bulk import', uses);
    for (const [name, re] of [
      ['saveItem__impl', /async function saveItem__impl\(item\) \{[\s\S]{0,200}confirmInventoryWriteMode/],
      ['removeItem__impl', /async function removeItem__impl\(id\) \{[\s\S]{0,200}confirmInventoryWriteMode/],
      ['moveToInventory ×2', /async function moveToInventory\(item\) \{\s*\n\s*if \(!\(await confirmInventoryWriteMode/g],
      ['mergeIntoInventory ×2', /async function mergeIntoInventory\(qrItem, invTargetId\) \{\s*\n\s*if \(!\(await confirmInventoryWriteMode/g],
    ]) {
      const n = (SRC.match(re.global ? re : new RegExp(re.source, 'g')) || []).length;
      ok(n >= (/×2/.test(name) ? 2 : 1), name + ' checks the gate before touching Inventory', n);
    }
    ok(/Array\.isArray\(fresh\.cutOver\) && fresh\.cutOver\.length\) \{\s*\n\s*adoptRelationalAuthority\(null, fresh\.cutOver, null\);/.test(SRC), 'the routine 25s freshness check also learns a new cutover (sticky)');
  }

  console.log('\n' + passed + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(1); });
