/**
 * relational.frontend-id-bugfix.test.ts — STAGE 3 verification of a
 * critical correctness bug found while wiring Phase 1 (job editing):
 * EVERY existing relationalApi call site in index.html that identifies a
 * record by id used the record's `.id` field — but `.id` is
 * backend/src/relational/read.ts's restoreId(source_id), the RESTORED
 * LEGACY JSON id. That only equals the record's real relational PK
 * (`._relId`) for a record created AFTER its section was cut over
 * (createQuote/createCustomer/convertQuoteToJob set source_id to the new
 * row's own PK). For any record BACKFILLED from historical JSON — the
 * entire installed base, since Stage 3 has never run in production —
 * `.id` is the ORIGINAL legacy id, a completely different number from the
 * relational PK. Calling e.g. relationalApi.createInvoiceForJob(job.id)
 * for a backfilled job would either 404 ("job not found") or, worse,
 * silently act on a DIFFERENT row that happens to share that PK value.
 *
 * Confirmed empirically (not just by reading code): backfilling two
 * synthetic customers with legacy ids 555555/777777 produces relational
 * PKs 1/2 — see the session's ad hoc verify-id-bug.js reproduction.
 *
 * This is a plain source-text regression guard, not a VM-executed one —
 * unlike assertNoUnwiredRelationalSections (a standalone pure function),
 * every one of these call sites lives inside a component closure (job,
 * quote, paySource, existing, etc. from surrounding React state), so
 * extracting a runnable, self-contained function for each would require
 * reconstructing that whole closure. A precise source-text assertion that
 * the CORRECT identifier (`_relId`) is used at each real call site, and
 * that the buggy bare `.id` pattern is gone, is what actually protects
 * against regressing this exact bug in this exact file.
 */
import fs from 'fs';
import path from 'path';

const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH || path.resolve(__dirname, '..', '..', 'index.html');

let failures = 0;
let passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

function main() {
  const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

  console.log('\n[Frontend id bugfix] every relationalApi call that identifies an existing record now uses the real relational PK (_relId), never the restored legacy id');

  ok(src.includes('relationalApi.updateCustomer(existing && existing._relId, existing && existing._relRowVersion, patch)'),
    'customer save: relationalApi.updateCustomer() is called with existing._relId');
  ok(!/relationalApi\.updateCustomer\(c\.id,/.test(src),
    'the old buggy pattern relationalApi.updateCustomer(c.id, ...) is gone');

  ok(src.includes('relationalApi.convertQuoteToJob(q._relId)'),
    'quote conversion: relationalApi.convertQuoteToJob() is called with q._relId');
  ok(!/relationalApi\.convertQuoteToJob\(q\.id\)/.test(src),
    'the old buggy pattern relationalApi.convertQuoteToJob(q.id) is gone');

  ok(src.includes('relationalApi.createInvoiceForJob(job._relId)'),
    'create-invoice: relationalApi.createInvoiceForJob() is called with job._relId');
  ok(!/relationalApi\.createInvoiceForJob\(job\.id\)/.test(src),
    'the old buggy pattern relationalApi.createInvoiceForJob(job.id) is gone');

  ok(src.includes('relationalApi.finalizeProforma(quote._relId)'),
    'proforma finalize: relationalApi.finalizeProforma() is called with quote._relId');
  ok(!/relationalApi\.finalizeProforma\(quote\.id\)/.test(src),
    'the old buggy pattern relationalApi.finalizeProforma(quote.id) is gone');

  ok(src.includes("const ownerId = paySource.kind==='invoice' ? paySource.record._relId : job._relId;"),
    'payment recording: ownerId is derived from ._relId for both the invoice and job branches');
  ok(!/const ownerId = paySource\.kind==='invoice' \? paySource\.record\.id : job\.id;/.test(src),
    'the old buggy pattern (ownerId from .id) is gone');

  // Structural sweep: no relationalApi.* call anywhere in the file should
  // pass a bare `.id`-only identifier expression (e.g. `foo.id`, not
  // `foo._relId`) as an argument to a method whose backend counterpart
  // expects a relational row id (id path param or first positional arg) —
  // catches a FUTURE regression of this same mistake at a not-yet-existing
  // call site, not just the five fixed above.
  const relationalApiCalls = src.match(/relationalApi\.\w+\([^)]*\)/g) || [];
  const idOwningMethods = ['updateCustomer', 'convertQuoteToJob', 'createInvoiceForJob', 'finalizeProforma'];
  const suspicious = relationalApiCalls.filter((call) => {
    const method = /relationalApi\.(\w+)\(/.exec(call)?.[1];
    if (!method || !idOwningMethods.includes(method)) return false;
    // A bare "<ident>.id" (word boundary before/after, not "._relId") used
    // as the first argument is the exact shape of the bug.
    return /\(\s*\w+\.id\b/.test(call);
  });
  ok(suspicious.length === 0, 'no relationalApi call anywhere in the file passes a bare .id where a relational PK is expected', suspicious);

  console.log('\n' + '='.repeat(60));
  console.log(`${passed} passed, ${failures} failed`);
  console.log('='.repeat(60));
  process.exit(failures > 0 ? 1 : 0);
}

main();
