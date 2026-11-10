/**
 * admin-quote-revision.test.js — 2026-11-10
 * Static + pure-function checks for the admin "revise a converted quote"
 * workflow (Quote -> Job -> Invoice pull-through). No database needed.
 *
 *   node test/admin-quote-revision.test.js
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const api = fs.readFileSync(path.join(__dirname, '..', 'src', 'relational', 'api.ts'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '..', 'src', 'scripts', 'restore-deleted-job-invoice.ts'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ ' + label); } }

// ── pull the pure helpers out of index.html and evaluate them ─────────────
function extract(name) {
  const start = html.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('missing ' + name);
  let i = html.indexOf('{', start), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) break; }
  }
  return html.slice(start, i + 1);
}
const src = ['jobHasId', 'sameCompany', 'resolveJobsForQuote', 'resolveJobForQuote', 'quoteIsAdvanced', 'quoteCommercialSignature']
  .map((n) => { try { return extract(n); } catch (e) { return ''; } }).join('\n');
// eslint-disable-next-line no-new-func
const lib = new Function(src + '\nreturn { quoteIsAdvanced, quoteCommercialSignature };')();

console.log('\n1. Which quotes count as advanced (admin-only to edit)');
ok(lib.quoteIsAdvanced({ status: 'converted', num: 'SQ-1' }, []) === true, 'status converted');
ok(lib.quoteIsAdvanced({ status: 'approved', convertedJobId: 5, num: 'SQ-1' }, []) === true, 'convertedJobId set');
ok(lib.quoteIsAdvanced({ status: 'draft', num: 'SQ-1' }, []) === false, 'a draft quote is freely editable');

console.log('\n2. Commercial signature — only items/discount/setup fee matter');
const base = { client: 'A', tel: '1', discount: '5', setupFee: '250', lines: [{ desc: 'Sign', qty: 2, unitPrice: 100, unit: 'unit', pQty: 3 }] };
const sig = lib.quoteCommercialSignature(base);
ok(sig === lib.quoteCommercialSignature({ ...base, tel: '999', client: 'B' }), 'a header-only edit does not change it (job lines are never replaced for this)');
ok(sig !== lib.quoteCommercialSignature({ ...base, lines: [{ ...base.lines[0], unitPrice: 120 }] }), 'a price change changes it');
ok(sig !== lib.quoteCommercialSignature({ ...base, lines: [...base.lines, { desc: 'Install', qty: 1, unitPrice: 500 }] }), 'an added line changes it');
ok(sig !== lib.quoteCommercialSignature({ ...base, discount: '10' }), 'a discount change changes it');
ok(sig !== lib.quoteCommercialSignature({ ...base, setupFee: '0' }), 'a setup-fee change changes it');
ok(sig === lib.quoteCommercialSignature({ ...base, lines: [{ ...base.lines[0], qty: '2', unitPrice: '100.00' }] }), 'numeric strings and numbers compare equal');

console.log('\n3. Backend route');
const route = api.slice(api.indexOf("router.put('/quotes/:id/admin-revise'"), api.indexOf("router.patch('/quotes/:id/status'"));
ok(route.length > 0, 'PUT /quotes/:id/admin-revise exists');
ok(/actor\.role !== 'admin'/.test(route) && /status\(403\)/.test(route), 'admin role is required, from the authenticated session');
ok(/confirmPullThrough !== true/.test(route), 'explicit confirmPullThrough is required');
ok(/resyncJobLines: true/.test(route), 'it asks updateQuoteWithJobSync for the job-line resync');
const plainPut = api.slice(api.indexOf("router.put('/quotes/:id',"), api.indexOf("router.put('/quotes/:id/admin-revise'"));
ok(/resyncJobLines:\s*_rsjl/.test(plainPut) && !/resyncJobLines: true/.test(plainPut), 'the ordinary PUT /quotes/:id still strips resyncJobLines (BLOCKER 2 unchanged)');
ok((api.match(/resyncJobLines: true/g) || []).length === 1, 'exactly one HTTP surface can request a resync');
ok(!/rel_payments/.test(route), 'the route never names rel_payments');

console.log('\n4. Frontend wiring');
ok(/reviseConvertedQuote\(id, expectedVersion, patch\)/.test(html) && /confirmPullThrough: true/.test(html), 'relationalApi.reviseConvertedQuote sends confirmPullThrough');
ok(/const _adminRevise = isAdmin && _wantPull && !!linkedJob && _commercialChanged;/.test(html), 'admin route used only for an admin, ticked, linked job, real commercial change');
ok(/quoteIsAdvanced\(q, jobs\) && !isAdmin/.test(html), 'non-admins cannot open the editor on an advanced quote');
ok(/!quoteIsAdvanced\(quote, jobs\) \|\| isAdmin/.test(html), 'the Edit button is hidden from non-admins on an advanced quote');
ok(/canAdminRevise=\{isAdmin\}/.test(html), 'the editor is told whether the user may revise');

console.log('\n5. Restore script is manual and safe');
const pkg = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8');
ok(/"restore:deleted-job-invoice":/.test(pkg), 'registered as a manual npm script');
ok(!/restore-deleted-job-invoice/.test(JSON.parse(pkg).scripts.start || '') && !/restore-deleted-job-invoice/.test(JSON.parse(pkg).scripts.migrate || ''), 'not run by npm start / npm run migrate');
ok(/const APPLY = argv\.includes\('--apply'\)/.test(script) && /confirm !== requiredConfirm/.test(script), 'dry run by default; --apply needs the exact --confirm');
ok(/INSERT INTO platform_state_backups/.test(script), 'backs up before writing');
ok(!/INSERT INTO rel_payments|UPDATE rel_payments|DELETE FROM/i.test(script), 'never writes payments and never deletes anything');
ok(!/reserveDocumentNumber/.test(script), 'never reserves a new document number');
ok(/createInvoiceForJob\(jobId\)/.test(script), 'issues the invoice through the deployed createInvoiceForJob writer');

console.log('\n6. Cancelled invoices are listed, never counted');
// eslint-disable-next-line no-new-func
const cxl = new Function(extract('invoiceCancelledLabel') + '\nreturn invoiceCancelledLabel;')();
ok(cxl({ status: 'void', cancelledByAdmin: true }) === 'Cancelled by Admin', 'an admin-cancelled record reads "Cancelled by Admin"');
ok(cxl({ status: 'void' }) === 'Cancelled', 'any other void record reads "Cancelled"');
ok(/const allInvoices = \[\.\.\.accInvoices\.filter\(i=>i && i\.status!=='void'\)/.test(html), 'Accounting allInvoices (exports/counts) still excludes void');
ok(/numSort\(\[\.\.\.allInvoices, \.\.\.cancelledAccInvoices\], 'number'\)/.test(html), 'Accounting list displays the cancelled records');
ok((html.match(/displayedAccInvoices\.filter\(i=>!i\._isCancelled\)\.reduce\(/g) || []).length === 3, 'Accounting totals row ignores cancelled records');
ok(/const manualInvItems = myAccInvoices\.filter\(i=>i\.status!=='void'\)/.test(html), 'Sales money projection still excludes void');
ok(/cancelledInvItems = myAccInvoices\.filter\(i=>i && i\.status==='void'\)[\s\S]{0,400}value:0, _totalCents:0/.test(html), 'Sales cancelled rows carry R0.00 and no payments');
ok(/viewInvoiceRow\.status!=='void'/.test(html) && /viewInv\.status!=='void'/.test(html), 'a cancelled invoice cannot be opened for editing');

console.log('\n7. record-cancelled-invoice script');
const rc = fs.readFileSync(path.join(__dirname, '..', 'src', 'scripts', 'record-cancelled-invoice.ts'), 'utf8');
ok(/"record:cancelled-invoice":/.test(pkg), 'registered as a manual npm script');
ok(/const APPLY = argv\.includes\('--apply'\)/.test(rc) && /confirm !== requiredConfirm/.test(rc), 'dry run by default; --apply needs the exact --confirm');
ok(rc.indexOf('INSERT INTO platform_state_backups') > 0 && rc.indexOf('INSERT INTO platform_state_backups') < rc.indexOf('INSERT INTO rel_invoices'), 'backs up before inserting');
ok(!/UPDATE rel_|DELETE FROM|TRUNCATE|DROP /i.test(rc), 'never updates or deletes anything');
ok(!/INSERT INTO rel_payments/.test(rc) && !/reserveDocumentNumber/.test(rc), 'no payment, no new document number');
ok(/'void', \$10::date/.test(rc) && /\$7, NULL, \$8, NULL, \$9/.test(rc), "inserts status 'void' with job_id/quote_id NULL");

console.log('\n============================================================');
console.log(`PASSED: ${pass}   FAILED: ${fail}`);
console.log('============================================================');
if (fail) process.exitCode = 1;
