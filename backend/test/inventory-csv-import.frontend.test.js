#!/usr/bin/env node
/* ============================================================================
 * inventory-csv-import.frontend.test.js
 * Signacore — 2026-11-23 INVENTORY CSV EXPORT / IMPORT.
 *
 * Reported: "exported the inventory CSV, edited it, imported it — the changes
 * do not appear". Root cause (proven in section [R] against the pre-fix
 * file): Bulk Import ignored the header row and read columns BY POSITION with
 * a plain split(','), so a file in the export's column order (…Unit, Stock on
 * hand, Reorder level…) wrote the edited stock into the reorder level and set
 * stock to 0; quoted commas shifted columns; blanks overwrote real values.
 *
 * Exercises the REAL code lifted out of index.html (the block between the
 * "2026-11-23 INVENTORY CSV EXPORT / IMPORT" banner and its END marker).
 * ZERO DEPENDENCIES:  node test/inventory-csv-import.frontend.test.js
 * Pre-fix reproduction: OLD_INDEX_HTML_PATH=/path/to/old/index.html node …
 * ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');

const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH || path.resolve(__dirname, '..', '..', 'index.html');
const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8').replace(/\r\n/g, '\n'); // the repo copy is CRLF on Windows
let failures = 0, passed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failures++; console.log('  ✗ ' + label + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}
function section(t) { console.log('\n' + t); }

function liftBlock(src) {
  const a = src.indexOf('2026-11-23 INVENTORY CSV EXPORT / IMPORT (shared');
  const b = src.indexOf('// ── END 2026-11-23 INVENTORY CSV EXPORT / IMPORT block');
  if (a < 0 || b < 0) return null;
  const start = src.lastIndexOf('/*', a);
  const names = ['sgrInventoryWorkbook', 'sgrWorkbookFirstSheetCsv', 'sgrNewRecordIds', 'sgrParseBankStatementCsv', 'sgrSplitBankDuplicates', 'sgrCsvParse', 'sgrCsvStringify', 'sgrParseImportNumber', 'sgrInventoryCsvExport', 'sgrParseInventoryCsv', 'sgrPlanInventoryImport', 'importInventoryRowsRelational', 'sgrApplyInventoryImportJson', 'sgrInventoryCsvHeader'];
  return new Function(src.slice(start, b) + '\nreturn {' + names.join(',') + '};')(); // eslint-disable-line no-new-func
}
const L = liftBlock(html);
if (!L) { console.log('✗ the 2026-11-23 inventory CSV block is missing from index.html'); process.exit(1); }

// ── [R] pre-fix reproduction (only when the old file is supplied) ─────────
// Headers exactly as in "Signacore Inventory 2026-11-22.xlsx".
const HEAD_22NOV = ['SKU', 'Item name', 'Category', 'Unit', 'Stock on hand', 'Reorder level', 'Cost price (R)', 'Sell price (R)', 'Supplier', 'Notes'];
const SUPS = [{ id: 55, name: '3M SA' }, { id: 56, name: 'Vinyl Co' }, { id: 57, name: 'Twin' }, { id: 58, name: 'twin' }];
const EXPORT_22NOV = '\ufeff' + HEAD_22NOV.join(',') + '\r\n' +
  'VIN-3M-RD,3M Vinyl Red Gloss 1.37m,Vinyl,m,40,8,310.00,520.00,3M SA,\r\n' +
  'ALU-COIL,"Aluminium return coil, 100mm",Aluminium Profiles,m,12.5,0,"1,250.00","1,800.00",,\r\n';
const INV = () => [
  { id: 101, _relId: 101, _relRowVersion: 3, sku: 'VIN-3M-RD', name: '3M Vinyl Red Gloss 1.37m', cat: 'Vinyl', category: 'Vinyl', unit: 'm', stock: 25, reorder: 8, cost: 310, sell: 490, supplierId: 55 },
  { id: 102, _relId: 102, _relRowVersion: 1, sku: 'ALU-COIL', name: 'Aluminium return coil, 100mm', cat: 'Aluminium Profiles', category: 'Aluminium Profiles', unit: 'm', stock: 12.5, reorder: 0, cost: 1250, sell: 1800 },
];
if (process.env.OLD_INDEX_HTML_PATH) {
  section('[R] PRE-FIX reproduction (old index.html)');
  const old = fs.readFileSync(process.env.OLD_INDEX_HTML_PATH, 'utf8').replace(/\r\n/g, '\n');
  const s = old.indexOf('function BulkImportModal('); const p = old.indexOf('function parse() {', s); const e = old.indexOf('  async function confirmImport()', p);
  let preview = null;
  new Function('csv', 'inventory', 'setError', 'setPreview', old.slice(p, e) + '; parse();')(EXPORT_22NOV, INV(), () => {}, (x) => { preview = x; }); // eslint-disable-line no-new-func
  const r1 = preview && preview.find(r => r.sku === 'VIN-3M-RD');
  ok(r1 && r1.stock === 40, 'old importer keeps the edited stock (40)', r1);
  ok(r1 && r1.unit === 'm' && r1.reorder === 8, 'old importer keeps unit/reorder', r1);
  const r2 = preview && preview.find(r => r.sku === 'ALU-COIL');
  ok(r2 && r2.name === 'Aluminium return coil, 100mm' && r2.cost === 1250, 'old importer reads a quoted comma / Excel number', r2);
}

section('[A] CSV parsing: BOM, CRLF, quotes, escaped quotes, new lines, separators, Unicode');
{
  const p = L.sgrCsvParse('\ufeffa,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n\r\n,,\r\nñ²€,😀,\r\n');
  ok(p.rows.length === 3, 'blank rows dropped, 3 rows', p.rows);
  ok(p.rows[0][0] === 'a', 'BOM stripped from the first header');
  ok(p.rows[1][0] === 'x, y' && p.rows[1][1] === 'say "hi"' && p.rows[1][2] === 'line1\nline2', 'quoted comma, "" escape and embedded new line', p.rows[1]);
  ok(p.rows[2][0] === 'ñ²€' && p.rows[2][1] === '😀', 'Unicode kept');
  ok(L.sgrCsvParse('a;b\n1,5;2').delimiter === ';' && L.sgrCsvParse('a;b\n1,5;2').rows[1][0] === '1,5', 'semicolon file detected');
  ok(L.sgrCsvParse('a\tb\r1\t2').rows[1][1] === '2', 'TAB file + bare CR line ending');
  const back = L.sgrCsvParse(L.sgrCsvStringify([['a,b', 'q"q', ' lead', '0', '']]));
  ok(JSON.stringify(back.rows[0]) === JSON.stringify(['a,b', 'q"q', ' lead', '0', '']), 'stringify → parse round trip', back.rows[0]);
}

section('[B] numbers');
{
  const n = (s, d) => L.sgrParseImportNumber(s, d || ',');
  const cases = [['0', 0], ['12.5', 12.5], ['1250', 1250], ['1,250.00', 1250], ['R 1,250.50', 1250.5], ['1 250,50', 1250.5], ['1.250,50', 1250.5], ['1,5', 1.5], ['1,250.', 1250], ['12.', 12], ['1,234,567', 1234567], ['0.00004', 0], ['310.00', 310]];
  for (const [s, v] of cases) ok(n(s).value === v, JSON.stringify(s) + ' → ' + v, n(s));
  ok(n('1,250', ';').value === 1.25, 'in a ";" file a lone comma is the decimal mark');
  ok(!!n('1,250').error && /ambiguous/.test(n('1,250').error), '"1,250" in a "," file is refused as ambiguous, never guessed', n('1,250'));
  ok(!!n('abc').error && !!n('1.2.3,4').error && !!n('12x').error, 'garbage is an error');
  ok(n('').blank === true, 'blank is blank, not 0');
  ok(n('-3').value === -3, 'sign parsed (rejected later as negative)');
}

section('[C] header mapping');
{
  const p = L.sgrParseInventoryCsv(EXPORT_22NOV);
  ok(p.fileErrors.length === 0, 'the 22 Nov export layout is accepted', p.fileErrors);
  ok(p.ignoredColumns.length === 1 && p.ignoredColumns[0].column === 'Notes' && /no Notes field/.test(p.ignoredColumns[0].reason), 'Notes is listed as ignored with the reason (inventory has no Notes field); Supplier is read', p.ignoredColumns);
  const r = p.records[0];
  ok(r.stock === 40 && r.reorder === 8 && r.unit === 'm' && r.sell === 520 && r.cost === 310 && r.supplier === '3M SA', 'columns read by NAME incl. "Cost price (R)" / "Sell price (R)" / Supplier', r);
  const unk = L.sgrParseInventoryCsv('SKU,Stock value,Active\nA,1,Yes');
  ok(unk.ignoredColumns.length === 2 && /not an inventory field/.test(unk.ignoredColumns[0].reason) && /restored automatically/.test(unk.ignoredColumns[1].reason), 'every other unknown column is listed with a reason', unk.ignoredColumns);
  ok(p.records[1].name === 'Aluminium return coil, 100mm' && p.records[1].cost === 1250 && p.records[1].sell === 1800 && p.records[1].reorder === 0, 'quoted comma + "1,250.00" + reorder 0', p.records[1]);
  ok(L.sgrParseInventoryCsv('VIN,Name\nX,Y').fileErrors.length === 1, 'no SKU header → file error (positional guessing is gone)');
  ok(/Two columns/.test(L.sgrParseInventoryCsv('SKU,Stock,Qty\nA,1,2').fileErrors[0] || ''), 'two columns for one field → file error');
  ok(L.sgrParseInventoryCsv('SKU,Name\n').fileErrors.length === 1, 'header with no data rows → file error');
  const bad = L.sgrParseInventoryCsv('SKU,Stock,Cost\nA,-1,abc');
  ok(bad.records[0].errors.length === 2 && bad.records[0].errors.every(e => e.field), 'bad numbers recorded per field', bad.records[0].errors);
}

const plan = (csv, inv) => L.sgrPlanInventoryImport(L.sgrParseInventoryCsv(csv).records, inv || INV(), SUPS);
const by = (pl, sku) => pl.find(e => e.sku === sku);

section('[D] export → import round trip with no edits is a no-op');
{
  const inv = INV().concat([
    { id: 1745923456789, _relId: 7, _relRowVersion: 1, sku: 'ZERO', name: 'Zero "stock" ñ', cat: 'Café', unit: 'unit', stock: 0, reorder: 0, cost: 0, sell: 0 },
    { id: 104, _relId: 104, _relRowVersion: 1, sku: 'GONE', name: 'Removed', cat: 'X', unit: 'u', stock: 1, reorder: 1, cost: 1, sell: 1, active: false },
  ]);
  const csv = L.sgrInventoryCsvExport(inv, SUPS);
  ok(csv.split('\r\n')[0] === L.sgrInventoryCsvHeader().join(','), 'export header', csv.split('\r\n')[0]);
  ok(!/GONE/.test(csv), 'removed items are not exported');
  ok(!/_rel|row_?version|supplierId/i.test(csv) && /,3M SA,#101\r\n/.test(csv), 'no internal fields; Supplier written by NAME', csv.split('\r\n')[1]);
  ok(/"Zero ""stock"" ñ"/.test(csv) && /,0,0,0,0,,#1745923456789\r\n/.test(csv), 'quotes escaped, zeros written as 0, ID written as "#<id>" text', csv);
  const pl = plan(csv, inv);
  ok(pl.length === 3 && pl.every(e => e.action === 'unchanged'), 'every exported row plans as unchanged', pl.map(e => [e.sku, e.action, e.changes]));
}

section('[D2] export → import of the real 5 May snapshot embedded in index.html is a no-op');
{
  const m = html.match(/<script id="sgr-data"[^>]*>([\s\S]*?)<\/script>/);
  const snap = m ? JSON.parse(m[1]).inventory : null;
  ok(Array.isArray(snap) && snap.length > 100, 'snapshot found', snap && snap.length);
  if (Array.isArray(snap)) {
    const pl = L.sgrPlanInventoryImport(L.sgrParseInventoryCsv(L.sgrInventoryCsvExport(snap)).records, snap);
    const notSame = pl.filter(e => e.action !== 'unchanged');
    ok(notSame.length === 0, 'every one of ' + pl.length + ' rows is unchanged (trailing spaces in names are not a change)', notSame.slice(0, 5).map(e => [e.sku, e.action, e.changes, e.errors]));
  }
}

section('[E] edits update only the edited fields');
{
  const csv = L.sgrInventoryCsvExport(INV(), SUPS).replace('m,25,8,310,490,3M SA,#101', 'm,40,8,310,520,3M SA,#101').replace('Aluminium return coil, 100mm', 'Aluminium return coil, 100mm — silver');
  const pl = plan(csv);
  const a = by(pl, 'VIN-3M-RD');
  ok(a.action === 'update' && JSON.stringify(a.patch) === JSON.stringify({ stock: 40, sell: 520 }), 'VIN: patch is exactly { stock: 40, sell: 520 }', a.patch);
  const b = by(pl, 'ALU-COIL');
  ok(b.action === 'update' && JSON.stringify(b.patch) === JSON.stringify({ name: 'Aluminium return coil, 100mm — silver' }), 'ALU: only the name, Unicode dash kept', b.patch);
  const pl2 = plan(EXPORT_22NOV);
  ok(JSON.stringify(by(pl2, 'VIN-3M-RD').patch) === JSON.stringify({ stock: 40, sell: 520 }), 'the user\'s 22 Nov layout with an edited stock now writes stock 40 (was: stock 0, reorder 40, unit "8")', by(pl2, 'VIN-3M-RD').patch);
  ok(by(pl2, 'ALU-COIL').action === 'unchanged', 'the quoted-comma row is recognised as unchanged');
  const pl3 = plan('SKU,Category\nvin-3m-rd,Vinyl Gloss');
  const pl4 = plan('SKU,ID\nVIN-3M-RED,101');
  ok(JSON.stringify(by(pl4, 'VIN-3M-RED').patch) === JSON.stringify({ sku: 'VIN-3M-RED' }), 'with the ID column a SKU can be renamed deliberately', by(pl4, 'VIN-3M-RED').patch);
  ok(by(pl3, 'vin-3m-rd').target.id === 101 && JSON.stringify(by(pl3, 'vin-3m-rd').local) === JSON.stringify({ cat: 'Vinyl Gloss', category: 'Vinyl Gloss' }), 'SKU match is case-insensitive; category sent as category and kept as cat locally');
}

section('[F] blanks and omitted columns keep values; 0 is a real value');
{
  const pl = plan('SKU,Name,Category,Unit,Stock,Reorder,Cost,Sell\nVIN-3M-RD,,,,0,,,\nALU-COIL,Aluminium return coil, 100mm,,,,,,');
  const a = by(pl, 'VIN-3M-RD');
  ok(a.action === 'update' && JSON.stringify(a.patch) === JSON.stringify({ stock: 0 }), 'stock 25 → 0 is saved; blank name/category/unit/reorder/cost/sell are NOT cleared', a.patch);
  const pl2 = plan('SKU,Stock\nVIN-3M-RD,25');
  ok(by(pl2, 'VIN-3M-RD').action === 'unchanged', 'a file with only SKU,Stock touches nothing else');
  const created = by(plan('SKU,Name\nNEW-1,Brand new'), 'NEW-1');
  ok(created.action === 'create' && JSON.stringify(created.patch) === JSON.stringify({ sku: 'NEW-1', name: 'Brand new', category: 'General', unit: 'unit', cost: 0, sell: 0, stock: 0, reorder: 5, supplierId: null }), 'a new item takes the Add Item defaults for missing values', created.patch);
}

section('[F2] Supplier column (by name) and IDs');
{
  const pl = plan('SKU,Supplier\nVIN-3M-RD,Vinyl Co\nALU-COIL,3m sa\nX-NEW,Twin');
  ok(JSON.stringify(by(pl, 'VIN-3M-RD').patch) === JSON.stringify({ supplierId: 56 }) && by(pl, 'VIN-3M-RD').changes[0].from === '3M SA', 'VIN: supplier changed 3M SA → Vinyl Co (sent as supplierId 56)', by(pl, 'VIN-3M-RD'));
  ok(JSON.stringify(by(pl, 'ALU-COIL').patch) === JSON.stringify({ supplierId: 55 }), 'ALU (no supplier) gets linked by a case-insensitive name match');
  const pl2 = plan('SKU,Supplier\nVIN-3M-RD,3m sa\nALU-COIL,');
  ok(by(pl2, 'VIN-3M-RD').action === 'unchanged' && by(pl2, 'ALU-COIL').action === 'unchanged', 'same supplier (any case) and a blank Supplier cell change nothing');
  const pl3 = plan('SKU,Supplier\nVIN-3M-RD,Nobody Ltd\nALU-COIL,Twin');
  ok(by(pl3, 'VIN-3M-RD').action === 'rejected' && by(pl3, 'VIN-3M-RD').errors[0].field === 'Supplier' && /not in Suppliers/.test(by(pl3, 'VIN-3M-RD').errors[0].message), 'unknown supplier → rejected (Supplier), never silently unlinked');
  ok(by(pl3, 'ALU-COIL').action === 'rejected' && /2 suppliers are called/.test(by(pl3, 'ALU-COIL').errors[0].message), 'two suppliers with the same name → rejected, never guessed');
  const twinLinked = INV().map(i => i.id === 102 ? { ...i, supplierId: 57 } : i);
  ok(by(plan('SKU,Supplier\nALU-COIL,Twin', twinLinked), 'ALU-COIL').action === 'unchanged', 'an item already linked to one of two same-named suppliers is "unchanged", so an export round trip never trips on it');
  const nw = by(plan('SKU,Name,Supplier\nNEW-S,New with supplier,Vinyl Co'), 'NEW-S');
  ok(nw.action === 'create' && nw.patch.supplierId === 56, 'a new item can be created with its supplier');
  ok(by(plan('SKU,Stock,ID\nVIN-3M-RD,30,#101'), 'VIN-3M-RD').target.id === 101 && by(plan('SKU,Stock,ID\nVIN-3M-RD,30,101'), 'VIN-3M-RD').target.id === 101, 'ID accepted as "#101" (CSV export) and "101" (Excel export)');
}

section('[G] ambiguous / invalid rows are rejected with row and field');
{
  const inv = INV().concat([
    { id: 201, _relId: 201, _relRowVersion: 1, sku: 'SNS-INST-001', name: 'Install A', cat: 'Labour', unit: 'hr', stock: 0, reorder: 0, cost: 1, sell: 2 },
    { id: 202, _relId: 202, _relRowVersion: 1, sku: 'sns-inst-001', name: 'Install B', cat: 'Labour', unit: 'hr', stock: 0, reorder: 0, cost: 1, sell: 2 },
  ]);
  const pl = plan('SKU,Name,Stock,ID\nSNS-INST-001,Install A,3,\nSNS-INST-001,Install B,4,202\nX-1,No such,1,999\nVIN-3M-RD,,1,\nvin-3m-rd,,2,\nNEWX,,1,\nALU-COIL,,-2,\nALU-COIL,,5,1.74592E+12\nVIN-3M-RD,,,102', inv);
  const r = pl.map(e => [e.rowNum, e.action, e.errors.map(x => x.field).join('|')]);
  ok(pl[0].action === 'rejected' && /2 active items share SKU/.test(pl[0].errors[0].message), 'shared SKU without an ID → rejected (never "first match")', r[0]);
  ok(pl[1].action === 'update' && pl[1].target.id === 202 && pl[1].patch.stock === 4, 'the same SKU WITH its ID → that exact item', r[1]);
  ok(pl[2].action === 'rejected' && pl[2].errors[0].field === 'ID', 'unknown ID → rejected, never created', r[2]);
  ok(pl[3].action === 'update' && pl[4].action === 'rejected' && /also on row 5/.test(pl[4].errors[0].message), 'a second row for the same item → rejected, names the first row', r[4]);
  ok(pl[5].action === 'rejected' && pl[5].errors[0].field === 'Name', 'new SKU without a name → rejected (Name)', r[5]);
  ok(pl[6].action === 'rejected' && pl[6].errors[0].field === 'Stock', 'negative stock → rejected (Stock)', r[6]);
  ok(pl[7].action === 'update' && pl[7].target.id === 102 && pl[7].patch.stock === 5 && /shortened by Excel/.test(pl[7].warnings[0]), 'an ID mangled by Excel (1.7E+12) is ignored with a warning and the row falls back to SKU', [r[7], pl[7].warnings]);
  ok(pl[8].action === 'rejected' && pl[8].errors[0].field === 'SKU' && /already used/.test(pl[8].errors[0].message), 'ID of one item with the SKU of another → rejected', r[8]);
  ok(pl.every(e => e.rowNum >= 2), 'row numbers are spreadsheet rows (header = row 1)');
}

function fakeApi(opts) {
  const log = []; let next = 900; const o = opts || {};
  return {
    log,
    createInventoryItem: async (b) => { log.push(['create', b]); if (o.failCreate && o.failCreate(b)) { const e = new Error('server said no'); e.status = 400; throw e; } next++; return { id: String(next), rowVersion: 1 }; },
    updateInventoryItem: async (id, v, p) => { log.push(['update', id, v, p]); if (o.failUpdate && o.failUpdate(id)) { const e = new Error('This record was changed elsewhere'); e.status = 409; throw e; } return { rowVersion: v + 1 }; },
    deleteInventoryItem: async (id, v) => { log.push(['delete', id, v]); return { deactivated: true }; },
  };
}
(async () => {
  section('[H] relational importer: accurate report, no writes for unchanged rows, safe re-import');
  {
    const csv = 'SKU,Name,Category,Unit,Stock,Reorder,Cost,Sell,ID (do not edit)\r\nVIN-3M-RD,3M Vinyl Red Gloss 1.37m,Vinyl,m,40,8,310,520,101\r\nALU-COIL,"Aluminium return coil, 100mm",Aluminium Profiles,m,12.5,0,1250,1800,102\r\nNEW-9,New thing,New Cat,m,3,1,1,2,\r\nBAD,,,,1,,,,\r\n';
    const recs = L.sgrParseInventoryCsv(csv).records;
    const api = fakeApi();
    const r = await L.importInventoryRowsRelational(recs, 'add', INV(), api);
    ok(r.report.created.length === 1 && r.report.updated.length === 1 && r.report.unchanged.length === 1 && r.report.rejected.length === 1 && r.report.failed.length === 0, 'report: 1 created, 1 updated, 1 unchanged, 1 rejected, 0 failed', r.report);
    ok(api.log.filter(x => x[0] === 'update').length === 1 && !api.log.some(x => x[0] === 'update' && x[1] === 102), 'the unchanged row was not written at all');
    const up = api.log.find(x => x[0] === 'update');
    ok(up[1] === 101 && up[2] === 3 && JSON.stringify(up[3]) === JSON.stringify({ stock: 40, sell: 520 }) && !('supplierId' in up[3]), 'update is version-checked and sends only the changed fields (supplier untouched)', up);
    ok(/1 unchanged \(nothing to save\), 1 rejected, 0 failed/.test(r.message) && /Row 5 \(BAD\) — Name/.test(r.message) && !/✅/.test(r.message), 'message reports unchanged/rejected and names the rejected row and field', r.message);
    const after = INV().map(i => { const c = r.changed.find(x => String(x.id) === String(i.id)); return c || i; }).concat(r.changed.filter(c => !INV().some(i => String(i.id) === String(c.id))));
    ok(after.find(i => i.id === 101).stock === 40 && after.find(i => i.id === 101).supplierId === 55 && after.find(i => i.id === 101)._relRowVersion === 4, 'local copy: new stock, supplier kept, server row version');
    const api2 = fakeApi();
    const r2 = await L.importInventoryRowsRelational(L.sgrParseInventoryCsv(csv.replace(/,\r\nBAD.*\r\n$/, ',\r\n').replace('NEW-9,New thing,New Cat,m,3,1,1,2,', 'NEW-9,New thing,New Cat,m,3,1,1,2,' + r.changed.find(c => c.sku === 'NEW-9').id)).records, 'add', after, api2);
    ok(api2.log.length === 0 && r2.report.unchanged.length === 3 && r2.report.created.length === 0, 'importing the same file again writes nothing and creates no duplicates', r2.report);
    const r3 = await L.importInventoryRowsRelational(L.sgrParseInventoryCsv('SKU,Name,Stock\nNEW-9,New thing,3').records, 'add', after, fakeApi());
    ok(r3.report.created.length === 0 && r3.report.unchanged.length === 1, 're-import without the ID column still matches by SKU — no duplicate');
  }
  {
    const api = fakeApi({ failUpdate: (id) => id === 102 });
    const r = await L.importInventoryRowsRelational(L.sgrParseInventoryCsv('SKU,Stock\nVIN-3M-RD,1\nALU-COIL,2').records, 'replace', INV().concat([{ id: 5, _relId: 5, _relRowVersion: 1, sku: 'OTHER', name: 'o' }]), api);
    ok(r.report.failed.length === 1 && r.report.failed[0].row === 3 && r.report.removalsSkipped && !api.log.some(x => x[0] === 'delete'), 'server failure: reported with its row; replace removes nothing', r.report);
    ok(/WITH ERRORS/.test(r.message) && /Row 3 ALU-COIL \(update\): This record was changed elsewhere/.test(r.message), 'server error text reaches the user', r.message);
    const api2 = fakeApi();
    const r2 = await L.importInventoryRowsRelational(L.sgrParseInventoryCsv('SKU,Stock\nVIN-3M-RD,1\nX,').records, 'replace', INV(), api2);
    ok(r2.report.rejected.length === 1 && r2.report.removalsSkipped && !api2.log.some(x => x[0] === 'delete'), 'a rejected row also blocks replace-mode removals');
    const api3 = fakeApi();
    const r3 = await L.importInventoryRowsRelational(L.sgrParseInventoryCsv('SKU,Stock\nVIN-3M-RD,25').records, 'replace', INV(), api3);
    ok(r3.report.removed.length === 1 && r3.report.removed[0] === 'ALU-COIL' && r3.report.unchanged.length === 1, 'replace keeps an unchanged listed item and removes the unlisted one', r3.report);
  }

  section('[W] Excel workbooks: the 22 Nov file layout and the new Excel export');
  {
    let XLSX = null;
    try { XLSX = require('xlsx'); } catch (e) { XLSX = null; }
    if (!XLSX) console.log('  (SKIPPED — the "xlsx" package is not installed here; the browser test covers this path)');
    else {
      const inv = INV().concat([{ id: 1745923456789, _relId: 7, _relRowVersion: 1, sku: 'ZERO', name: 'Zero stock ñ', cat: 'Café', unit: 'unit', stock: 0, reorder: 0, cost: 0, sell: 0 }]);
      // Built the way the 22 Nov file was built: formatted numbers, two sheets.
      const nov = (rows) => {
        const ws = XLSX.utils.aoa_to_sheet([HEAD_22NOV, ...rows]);
        for (let r = 1; r <= rows.length; r++) { for (const c of [6, 7]) { const x = ws[XLSX.utils.encode_cell({ r, c })]; if (x && x.t === 'n') x.z = '#,##0.00'; } for (const c of [4, 5]) { const x = ws[XLSX.utils.encode_cell({ r, c })]; if (x && x.t === 'n') x.z = '#,##0.##'; } }
        const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Inventory');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEAD_22NOV, ['OLD-1', 'Old', 'X', 'u', 1, 0, 1, 1, '', '']]), 'Inactive items');
        return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
      };
      const buf = nov([
        ['VIN-3M-RD', '3M Vinyl Red Gloss 1.37m', 'Vinyl', 'm', 40.5, 8, 310, 520.25, '3M SA', 'keep dry'],   // edited: stock 25 → 40.5, sell 490 → 520.25
        ['ALU-COIL', 'Aluminium return coil, 100mm', 'Aluminium Profiles', 'm', 12.5, 0, 1250, 1800, '', ''],  // unchanged
      ]);
      const x = L.sgrWorkbookFirstSheetCsv(XLSX, new Uint8Array(buf));
      ok(x.sheet === 'Inventory' && JSON.stringify(x.otherSheets) === JSON.stringify(['Inactive items']), 'first sheet read; "Inactive items" reported as not imported', x.otherSheets);
      const p = L.sgrParseInventoryCsv(x.csv);
      ok(p.ignoredColumns.map(c => c.column).join() === 'Notes', 'only Notes is ignored (with its reason)', p.ignoredColumns);
      const pl = L.sgrPlanInventoryImport(p.records, inv, SUPS);
      ok(JSON.stringify(by(pl, 'VIN-3M-RD').patch) === JSON.stringify({ stock: 40.5, sell: 520.25 }), 'decimal stock 40.5 and price 520.25 read exactly; nothing else sent', by(pl, 'VIN-3M-RD').patch);
      ok(by(pl, 'ALU-COIL').action === 'unchanged', 'formatted "1,250.00" cells are read as their raw value 1250 → unchanged');
      const api = fakeApi();
      const r = await L.importInventoryRowsRelational(p.records, 'add', inv, api, SUPS);
      ok(r.report.updated.length === 1 && r.report.unchanged.length === 1 && api.log.length === 1 && !api.log.some(l => l[0] === 'delete'), 'default Add / Update: 1 write; the item NOT in the file (ZERO) is untouched', api.log.map(l => l[0]));
      const p2 = L.sgrParseInventoryCsv(L.sgrWorkbookFirstSheetCsv(XLSX, new Uint8Array((() => { const ws = XLSX.utils.aoa_to_sheet([['SKU', 'Stock on hand'], ['VIN-3M-RD', 3.25]]); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'S'); return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }); })())).csv);
      ok(JSON.stringify(L.sgrPlanInventoryImport(p2.records, inv, SUPS)[0].patch) === JSON.stringify({ stock: 3.25 }), 'a sheet with only SKU + Stock changes only the stock (every omitted field is kept)');
      // New Excel export → re-import: ids (13-digit) are text cells and match exactly.
      const wb = L.sgrInventoryWorkbook(XLSX, inv, SUPS);
      const idCell = wb.Sheets.Inventory[XLSX.utils.encode_cell({ r: 3, c: 9 })];
      ok(idCell && idCell.t === 's', 'Excel export stores the ID as a text cell', idCell);
      const back = L.sgrWorkbookFirstSheetCsv(XLSX, new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })));
      const pb = L.sgrPlanInventoryImport(L.sgrParseInventoryCsv(back.csv).records, inv, SUPS);
      ok(pb.length === 3 && pb.every(e => e.action === 'unchanged') && by(pb, 'ZERO').target.id === 1745923456789 && by(pb, 'VIN-3M-RD').target.id === 101, 'Excel export → import: every row unchanged, matched by its exact ID (incl. 13-digit)', pb.map(e => [e.sku, e.action, e.target && e.target.id]));
    }
  }

  section('[I] JSON (pre-cutover) importer: ids kept, same plan');
  {
    const inv = INV().map(({ _relId, _relRowVersion, ...i }) => i);
    const r = L.sgrApplyInventoryImportJson(L.sgrParseInventoryCsv('SKU,Name,Stock\nvin-3m-rd,,40\nNEW-1,New,2').records, 'add', inv);
    ok(r.list.find(i => i.sku === 'VIN-3M-RD').id === 101 && r.list.find(i => i.sku === 'VIN-3M-RD').stock === 40 && r.list.find(i => i.sku === 'VIN-3M-RD').reorder === 8, 'existing item keeps its id and untouched fields (old code replaced the id)');
    ok(r.list.length === 3 && r.list.find(i => i.sku === 'NEW-1').id === 103, 'new item gets a fresh id');
    ok(!/saved to the server\./.test(r.message), 'JSON message does not claim a server save it has not seen (the modal adds the real autosave result)');
    const rr = L.sgrApplyInventoryImportJson(L.sgrParseInventoryCsv('SKU,Stock\nVIN-3M-RD,1\nZZ,1').records, 'replace', inv);
    ok(rr.list === null && /Nothing was imported/.test(rr.message), 'JSON replace with a rejected row changes nothing');
  }

  section('[K] bank statement CSV (Accounting → Bank import)');
  {
    const b = L.sgrParseBankStatementCsv('Date,Description,Debit,Credit,Balance\r\n2026-11-01,"PAYMENT, REF 123",1250.50,,9000\r\n2026-11-02,DEPOSIT ACME,,"2,000.00",11000\r\n2026-11-03,BAD ROW,12x,,0\r\n2026-11-03,OPENING BALANCE,,,11000\r\n');
    ok(b.txns.length === 2 && b.txns[0].description === 'PAYMENT, REF 123' && b.txns[0].debit === 1250.5 && b.txns[1].credit === 2000, 'quoted comma in the description no longer shifts the amounts', b.txns);
    ok(b.rejected.length === 1 && b.rejected[0].row === 4 && /Debit/.test(b.rejected[0].error), 'an unreadable amount is reported with its row, not imported as 0 or garbage', b.rejected);
    const z = L.sgrParseBankStatementCsv('Datum;Description;Amount\n2026-11-01;Card purchase;-1250,50\n2026-11-02;Refund;(30,00)\n2026-11-02;Salary;15000,00');
    ok(z.txns.length === 3 && z.txns[0].debit === 1250.5 && z.txns[1].debit === 30 && z.txns[2].credit === 15000, '";" file with decimal commas and (bracket) negatives', z.txns);
    const existing = [{ date: '2026-11-01', description: 'PAYMENT,  REF 123', debit: 1250.5, credit: 0 }];
    const twice = b.txns.concat([{ ...b.txns[1] }]);
    const sp = L.sgrSplitBankDuplicates(twice, existing);
    ok(sp.duplicates.length === 1 && sp.fresh.length === 2, 'already-imported row skipped; two identical rows in a new file are both kept', sp);
    const again = L.sgrSplitBankDuplicates(twice, existing.concat(sp.fresh));
    ok(again.fresh.length === 0 && again.duplicates.length === 3, 're-importing the same statement adds nothing');
  }

  section('[K2] ids for imported platform_state records');
  {
    const existing = [{ id: 1777789993569.4546 }, { id: 9e15 }, { id: 'abc' }];
    const ids = L.sgrNewRecordIds(500, existing.slice(0, 1).concat(existing.slice(2)));
    ok(new Set(ids).size === 500 && ids.every(n => Number.isInteger(n) && n > 1777789993569.4546), '500 unique INTEGER ids, all above the existing ids', ids.slice(0, 3));
    const x = 1777789993569; const seen = new Set(); let dup = 0; for (let i = 0; i < 100000; i++) { const v = x + Math.random(); if (seen.has(v)) dup++; seen.add(v); }
    ok(dup > 90000, 'why: Date.now()+Math.random() has only ~4,096 distinct values per millisecond (' + (100000 - dup) + ' seen)');
    ok(!/Date\.now\(\)\+Math\.random\(\)/.test(html.slice(html.indexOf('function BulkImportCustomersModal('), html.indexOf('function AddEditCustomerModal(') > html.indexOf('function BulkImportCustomersModal(') ? html.indexOf('function AddEditCustomerModal(') : html.indexOf('function BulkImportCustomersModal(') + 14000)) && /id: _ids\[k\]/.test(html) && /id:_ids\[k\], sku:/.test(html) && /id: _ids\[i\],/.test(html), 'customer, quick-rate and bank imports use sgrNewRecordIds');
  }

  section('[L] save confirmation for platform_state imports (sgrAwaitAutosave)');
  {
    const a = html.indexOf('const sgrAutosaveSeqRef'); const e = html.indexOf('function sgrAutosaveResultText', a);
    const W = new Function(html.slice(a, html.indexOf('\n}\n', e) + 3) + '\nreturn { sgrAutosaveSeqRef, sgrAwaitAutosave, sgrSettleAutosave, sgrAutosaveResultText };')(); // eslint-disable-line no-new-func
    const inflight = ++W.sgrAutosaveSeqRef.current;          // a save already running with an OLD snapshot
    const p = W.sgrAwaitAutosave(1000);
    W.sgrSettleAutosave(inflight, { ok: true });              // must NOT count for the import
    const mine = ++W.sgrAutosaveSeqRef.current;               // the snapshot that contains the import
    let got = null; p.then(r => { got = r; });
    await new Promise(r => setTimeout(r, 5));
    ok(got === null, 'an autosave of an older snapshot does not confirm the import');
    W.sgrSettleAutosave(mine, { ok: false, error: 'HTTP 409' });
    await new Promise(r => setTimeout(r, 5));
    ok(got && got.ok === false && got.error === 'HTTP 409', 'the import gets the real result of the save that carried it', got);
    const t = await W.sgrAwaitAutosave(20);
    ok(t.timeout === true && /not been confirmed/.test(W.sgrAutosaveResultText(t)), 'no save within the time limit → "not confirmed", never "saved"');
    ok(/Saved to the server/.test(W.sgrAutosaveResultText({ ok: true })) && /did NOT accept/.test(W.sgrAutosaveResultText({ ok: false, error: 'x' })), 'result wording');
    ok((html.match(/sgrSettleAutosave\(_sgrSnapSeq, \{ ok: (true|false)/g) || []).length === 2 && /const _sgrSnapSeq = \+\+sgrAutosaveSeqRef\.current;/.test(html), 'the App autosave settles waiters on success AND on failure');
  }

  section('[J] wiring');
  {
    const MARK = '<script type="text/babel" data-presets="react-classic">';
    const SRC = html.slice(html.indexOf(MARK) + MARK.length, html.lastIndexOf('</script>'));
    const modal = SRC.slice(SRC.indexOf('function BulkImportModal('), SRC.indexOf('function AddEditCustomerModal('));
    ok(/sgrParseInventoryCsv\(csv\)/.test(modal) && /sgrPlanInventoryImport\(p\.records, inventory, suppliers\)/.test(modal), 'the modal parses by header and previews the plan');
    ok(!/split\('\\n'\)|split\(','\)/.test(modal), 'no positional split(",") parsing left in the modal');
    ok(/type="file"/.test(modal) && /sgrWorkbookFirstSheetCsv\(window\.XLSX/.test(modal) && /rawNumbers: true/.test(html), 'file upload (CSV or Excel, raw numbers)');
    ok(/sgrApplyInventoryImportJson\(preview, mode, inventory, suppliers\)/.test(modal), 'the JSON path uses the same plan');
    const page = SRC.slice(SRC.indexOf('function InventoryPage('), SRC.indexOf('function InventoryPage(') + 60000);
    ok(/onClick=\{exportInventoryCSV\}/.test(page) && /sgrInventoryCsvExport\(active, suppliers\|\|\[\]\)/.test(page) && /onClick=\{exportInventoryExcel\}/.test(page) && /sgrInventoryWorkbook\(window\.XLSX, active, suppliers\|\|\[\]\)/.test(page) && /BulkImportModal inventory=\{inventory\} suppliers=\{suppliers\|\|\[\]\}/.test(page), 'Inventory has an Export CSV button using the shared exporter');
    ok(/requestRelationalRefresh\('inventory bulk import'\)/.test(page), 'after an import the page re-reads Inventory from the server');
    ok(/const inStock = activeInventory\.filter/.test(page), 'Wholesale List leaves out removed (inactive) items');
    const qr = SRC.slice(SRC.indexOf('function BulkImportQuickRatesModal('), SRC.indexOf('function BulkImportQuickRatesModal(') + 20000);
    ok(/sgrParseImportNumber\(v, ','\)/.test(qr) && !/replace\(\/\[\^0-9\.\]\/g,''\)/.test(qr) && /seenInFile/.test(qr) && /await onImport\(toAdd\)/.test(qr), 'Quick Rates import: shared number reader, in-file duplicates skipped, waits for the save');
    const cu = SRC.slice(SRC.indexOf('function BulkImportCustomersModal('), SRC.indexOf('function BulkImportCustomersModal(') + 14000);
    ok(/seenInFile/.test(cu) && /await onImport\(toAdd\)/.test(cu) && /Adds new customers only/.test(cu), 'Customer import: in-file duplicates skipped, waits for the save, behaviour stated');
    ok((SRC.match(/const saved=sgrAwaitAutosave\(\); setQuickRates/g) || []).length === 2 && /const saved = sgrAwaitAutosave\(\);\n    setCustomers/.test(SRC), 'both Quick Rates pages and Customers return the save result');
    const acc = SRC.slice(SRC.indexOf('function AccountingPage('), SRC.indexOf('function AccountingPage(') + 90000);
    ok(/sgrParseBankStatementCsv\(/.test(acc) && /sgrSplitBankDuplicates\(all, bankTxns\)/.test(acc) && !/function parseCSV\(/.test(acc), 'bank import uses the shared reader and the duplicate check');
    ok(/allInvoices\.forEach\(inv=>\{/.test(acc) && !/accInvoices\.filter\(i=>i\.status!=='void'\)\.forEach\(inv=>/.test(acc), 'Xero invoice export includes job invoices (allInvoices)');
  }

  console.log('\n' + passed + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})();
