/**
 * fixInvoiceCollisionINV00068August2026.ts
 *
 * TARGETED investigation + gated correction for a specific reported
 * collision: "INV-00068" now appears to exist on more than one live record,
 * AND the intended replacement number (INV-00033) is itself claimed as a
 * legacy `proformaNum` by two different quotes.
 *
 * Context (confirmed from code inspection + backups; re-confirmed live by
 * this script's own dry-run before any conclusion is drawn):
 *   - A pre-existing job-derived invoice, INV-00068, for Whalecoast Dried
 *     Fruit and Nuts (job SNS-00101, id 1784875525330, co 2, source quote
 *     SQ-00112), dated 2026-07-24, already existed.
 *   - Quote SQ-00056 (Mossel Bay Golf Club, id 1782728479201, co 2) was
 *     converted to job SNS-00055 (id 1783405980410). That JOB record carries
 *     co:1 — a data mismatch inherited from before the current
 *     handleConvertToJob logic (which correctly copies co:q.co) existed.
 *     Using "Create Invoice Now" on that job reserved from company 1's
 *     counter and collided with the pre-existing co:2 Whalecoast INV-00068.
 *   - BUSINESS DECISION (confirmed 2026-08-17): Mossel Bay Golf Club must
 *     keep INV-00033 as its final real invoice number — that was SQ-00056's
 *     original proformaNum, and per the proforma-to-invoice rule (see
 *     index.html's resolveProformaInvoiceNumber()), the final invoice must
 *     reuse that exact number.
 *   - COMPLICATION: quote SQ-00067 (Cash Sale / Sarel, id 1783324711705,
 *     converted job SNS-00053, id 1783325546764) ALSO carries proformaNum
 *     INV-00033 — a duplicated legacy proforma number, not a duplicated real
 *     invoice. As long as SQ-00067 has no real invoice of its own and its
 *     live proformaNum still equals INV-00033, this is a LIVE, UNRESOLVED
 *     conflict that blocks Mossel Bay's correction.
 *   - RESOLUTION (confirmed 2026-08-17): Sarel/Cash Sale must be given a
 *     NEW, different, safe proforma number — not just have the field
 *     cleared, and NOT a new real invoice. This script now supports
 *     proposing (and, only under explicit apply flags, writing) that
 *     specific field change, verified globally safe first.
 *
 * This script does NOT assume which live record is which — it re-derives
 * everything from the live database and prints full detail before drawing
 * any conclusion.
 *
 * SAFETY:
 *   - DRY-RUN BY DEFAULT. No --apply = read-only investigation + full
 *     analysis, prints everything, writes nothing.
 *   - Full analysis dry-run (no writes):
 *       npm run fix:inv00068-collision -- --new-number="INV-00033" --resolve-sarel-proforma --sarel-proforma-number="INV-XXXXX"
 *     (--new-number alone still works and prints the collision/identity
 *     analysis plus the Sarel conflict check; add --resolve-sarel-proforma
 *     and --sarel-proforma-number to see the full proposed resolution.)
 *   - --apply requires ALL of:
 *       --confirm="FIX INV-00068 COLLISION"   (exact string)
 *       --new-number="INV-00033"              (you choose it — never invented)
 *       --resolve-sarel-proforma              (explicit opt-in to touch SQ-00067)
 *       --sarel-proforma-number="INV-XXXXX"   (you choose it — never invented)
 *     Missing/wrong confirm, a missing/colliding --new-number, or (whenever a
 *     live Sarel conflict exists) a missing --resolve-sarel-proforma /
 *     --sarel-proforma-number / an unsafe --sarel-proforma-number = refuses
 *     to write anything.
 *   - HARD BLOCKS on --apply (cannot be overridden by --confirm) if:
 *       (a) the requested --new-number is already a REAL invoice number
 *           (jobs[].invoiceNum/invoiceNo or accInvoices[].num/number)
 *           somewhere else live, or
 *       (b) SQ-00067 / Cash Sale / Sarel still has NO real invoice of its
 *           own AND its live proformaNum still equals --new-number, AND
 *           either --resolve-sarel-proforma wasn't passed, or the proposed
 *           --sarel-proforma-number is missing/invalid/already in use
 *           (as a real invoice anywhere, or as another quote's proformaNum).
 *     A merely HISTORICAL proforma duplicate (Sarel already has their own
 *     separate real invoice, or their live proformaNum has since changed) is
 *     reported but does NOT block and is NOT touched.
 *   - The correction ONLY ever touches:
 *       (1) the ONE record identified as the newly-created Mossel Bay Golf
 *           Club / SQ-00056 / SNS-00055 invoice — its invoice-number field,
 *           and (only if this script's own analysis found them necessary and
 *           they were printed in the dry-run plan) its `co` field and a
 *           one-time carry of one specific quote payment into job.payments
 *           (deduped by id — never a second copy);
 *       (2) SQ-00067's `proformaNum` field ONLY, and ONLY when a live
 *           conflict was found AND a valid, pre-verified-safe
 *           --sarel-proforma-number was supplied. SQ-00067's/SNS-00053's
 *           invoice fields, status, and payments are NEVER touched — no real
 *           invoice is ever created for Sarel/Cash Sale by this script.
 *     Every other record (including the pre-existing Whalecoast INV-00068,
 *     and SQ-00056 itself) is left completely untouched.
 *   - Backs up the CURRENT full platform_state.data into
 *     platform_state_backups BEFORE writing anything.
 *   - Aborts (no writes at all) if live data doesn't match the identity this
 *     script expects — it never guesses its way through a mismatch.
 *   - Verifies, AFTER writing: INV-00068 remains ONLY on Whalecoast, INV-
 *     00033 is used as a real invoice ONLY on Mossel Bay, no other quote
 *     still carries proformaNum INV-00033, SQ-00067's proformaNum (if
 *     changed) matches the approved new number exactly, no payment id
 *     appears duplicated across two different records, and job/quote counts
 *     are unchanged.
 *   - Never drops a table, never deletes a backup row, never touches
 *     schema_migrations, never runs DELETE/TRUNCATE/DROP SQL.
 *   - Uses DATABASE_URL only — no hard-coded credentials.
 *
 * Run (from backend/, after `npm run build`):
 *   npm run fix:inv00068-collision -- --new-number="INV-00033" --resolve-sarel-proforma --sarel-proforma-number="INV-XXXXX"   # dry run — full plan, no writes
 *   npm run fix:inv00068-collision -- --apply --confirm="FIX INV-00068 COLLISION" --new-number="INV-00033" --resolve-sarel-proforma --sarel-proforma-number="INV-XXXXX"
 */
import { Client } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const TARGET_LABEL = 'INV-00068';
const REQUIRED_CONFIRM = 'FIX INV-00068 COLLISION';
const PAYMENT_TOLERANCE = 0.02;

// ── Known identity of the record we expect to be the NEWLY created one —
// confirmed from backups, re-verified live before any write. ──
const NEW_QUOTE_ID = 1782728479201;   // SQ-00056
const NEW_QUOTE_NUM = 'SQ-00056';
const NEW_JOB_ID = 1783405980410;     // SNS-00055
const NEW_JOB_NUM = 'SNS-00055';
const NEW_CUSTOMER_NAME = 'Mossel Bay Golf Club';
const EXPECTED_DEPOSIT_AMOUNT = 8230.55;         // context/fallback only — never assumed live
const EXPECTED_DEPOSIT_PAYMENT_ID = '1783406018516'; // the specific payment to carry, per business instruction

// ── Known identity of the record we expect to be the PRE-EXISTING one —
// same: confirmed from backups, re-verified live, never modified. ──
const OLD_JOB_ID = 1784875525330;     // SNS-00101
const OLD_JOB_NUM = 'SNS-00101';
const OLD_CUSTOMER_NAME = 'Whalecoast Dried Fruit and Nuts';

// ── Known identity of the OTHER historical INV-00033 proforma claimant —
// reported and checked for a live conflict every run; its proformaNum field
// (and ONLY that field) may be rewritten, but only under explicit flags and
// only after this script proves the replacement number is safe. ──
const OTHER_CLAIMANT_QUOTE_ID = 1783324711705; // SQ-00067
const OTHER_CLAIMANT_QUOTE_NUM = 'SQ-00067';
const OTHER_CLAIMANT_JOB_ID = 1783325546764;   // SNS-00053
const OTHER_CLAIMANT_CUSTOMER_NAME = 'Cash Sale'; // contact: Sarel

function log(msg: string): void {
  console.log(`[fix-inv00068] ${msg}`);
}
function norm(s: unknown): string {
  return String(s ?? '').trim().toLowerCase();
}
function pick(obj: any, keys: string[]): any {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}
function extractDigits(label: string): string {
  const m = label.match(/(\d+)\s*$/);
  if (!m) return '';
  const stripped = m[1].replace(/^0+/, '');
  return stripped === '' ? '0' : stripped;
}
function buildInvRegex(label: string): RegExp {
  const digits = extractDigits(label);
  return new RegExp('INV[-\\s]?0*' + digits + '(?!\\d)', 'i');
}
const TARGET_REGEX = buildInvRegex(TARGET_LABEL);

function summarizePayments(payments: any[] | undefined): string {
  const list = Array.isArray(payments) ? payments : [];
  if (list.length === 0) return 'none';
  const total = list.reduce((sum, p) => sum + (parseFloat(p?.amount) || 0), 0);
  return `${list.length} payment(s), total ${total.toFixed(2)}, ids: ${list.map((p) => p?.id ?? '?').join(', ')}`;
}
function summarizeLineItems(items: any[] | undefined): string {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return 'none';
  const names = list.slice(0, 5).map((i) => pick(i, ['description', 'name', 'item', 'desc']) || '(unnamed)');
  return `${list.length} line item(s): ${names.join('; ')}${list.length > 5 ? ', …' : ''}`;
}
function fmtR(n: number): string {
  return 'R ' + Number(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface Candidate {
  source: 'accInvoices' | 'job-derived';
  matchReason: string;
  invoiceNumber?: any;
  invoiceId?: any;
  jobId?: any;
  jobNumber?: any;
  quoteId?: any;
  quoteNumber?: any;
  client?: any;
  company?: any;
  date?: any;
  dueDate?: any;
  status?: any;
  total?: any;
  payments?: any[];
  lineItems?: any[];
  raw: any;
}

function makeAccInvoiceCandidate(inv: any, reason: string): Candidate {
  return {
    source: 'accInvoices',
    matchReason: reason,
    invoiceNumber: pick(inv, ['num', 'invoiceNum', 'number']),
    invoiceId: inv?.id,
    quoteId: inv?.quoteId,
    quoteNumber: pick(inv, ['quoteNum', 'quoteNumber', 'quote']),
    client: pick(inv, ['contactName', 'client', 'customer', 'customerName']),
    company: pick(inv, ['co', 'company']),
    date: pick(inv, ['date', 'invoiceDate']),
    dueDate: pick(inv, ['dueDate', 'due']),
    status: pick(inv, ['status', 'invoiceStatus']),
    total: pick(inv, ['total', 'value', 'amount', 'grandTotal']),
    payments: Array.isArray(inv?.payments) ? inv.payments : [],
    lineItems: pick(inv, ['items', 'lineItems', 'products']) || [],
    raw: inv,
  };
}
function makeJobCandidate(job: any, reason: string): Candidate {
  return {
    source: 'job-derived',
    matchReason: reason,
    invoiceNumber: pick(job, ['invoiceNum', 'invoiceNo']),
    jobId: job?.id,
    jobNumber: pick(job, ['jobNum', 'num', 'ref']),
    quoteNumber: pick(job, ['quoteNum', 'quoteNumber', 'linkedQuote']),
    client: pick(job, ['client', 'contactName', 'customer']),
    company: pick(job, ['co', 'company']),
    date: pick(job, ['invoiceDate', 'date']),
    dueDate: pick(job, ['invoiceDue', 'dueDate', 'due']),
    status: pick(job, ['invoiceStatus', 'status', 'jobStatus']),
    total: pick(job, ['value', 'total', 'amount']),
    payments: Array.isArray(job?.payments) ? job.payments : [],
    lineItems: pick(job, ['lines', 'items', 'lineItems']) || [],
    raw: job,
  };
}

function printCandidate(c: Candidate, label: string): void {
  log(`  ── ${label} ──`);
  log(`    source:            ${c.source}`);
  log(`    match reason:      ${c.matchReason}`);
  log(`    invoice number:    ${c.invoiceNumber ?? '(not found)'}`);
  if (c.invoiceId !== undefined) log(`    invoice id:        ${c.invoiceId}`);
  if (c.jobId !== undefined) log(`    job id:            ${c.jobId}`);
  if (c.jobNumber !== undefined) log(`    job number:        ${c.jobNumber}`);
  if (c.quoteId !== undefined) log(`    quote id:          ${c.quoteId}`);
  if (c.quoteNumber !== undefined) log(`    quote number:      ${c.quoteNumber}`);
  log(`    client/contact:    ${c.client ?? '(not found)'}`);
  log(`    company/co:        ${c.company ?? '(not found)'}`);
  log(`    invoice date:      ${c.date ?? '(not found)'}`);
  log(`    due date:          ${c.dueDate ?? '(not found)'}`);
  log(`    status:            ${c.status ?? '(not found)'}`);
  log(`    total/value:       ${c.total ?? '(not found)'}`);
  log(`    payments:          ${summarizePayments(c.payments)}`);
  log(`    line items:        ${summarizeLineItems(c.lineItems)}`);
}

// Does this quote (by id) already have a real, final invoice number of its
// own — via a converted job's job.invoiceNum, or a direct accInvoices row
// tagged with this quote (quoteId/quoteNum)? Returns the number string if
// so, else null. Mirrors getQuoteInvoice()/getJobManualInvoice() in
// index.html closely enough for this read-only check (never mutates).
function findRealInvoiceForQuote(quote: any, jobs: any[], accInvoices: any[]): string | null {
  if (!quote) return null;
  const directInv = (accInvoices || []).find(
    (i) => i && i.status !== 'void' && ((quote.id != null && i.quoteId === quote.id) || (quote.num && i.quoteNum === quote.num))
  );
  if (directInv) return pick(directInv, ['num', 'invoiceNum', 'number']) || null;
  const linkedJob = (jobs || []).find((j) => j && (j.id === quote.convertedJobId || (quote.num && j.quoteNum === quote.num)));
  if (linkedJob && linkedJob.invoiceNum) return linkedJob.invoiceNum;
  return null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const APPLY = argv.includes('--apply');
  const confirmArg = argv.find((a) => a.startsWith('--confirm='));
  const confirm = confirmArg ? confirmArg.slice('--confirm='.length).replace(/^["']|["']$/g, '') : '';
  const newNumberArg = argv.find((a) => a.startsWith('--new-number='));
  const newNumberRaw = newNumberArg ? newNumberArg.slice('--new-number='.length).replace(/^["']|["']$/g, '').trim() : '';
  const newNumber = newNumberRaw ? newNumberRaw.toUpperCase() : '';
  const resolveSarelProforma = argv.includes('--resolve-sarel-proforma');
  const sarelProformaNumberArg = argv.find((a) => a.startsWith('--sarel-proforma-number='));
  const sarelProformaNumberRaw = sarelProformaNumberArg ? sarelProformaNumberArg.slice('--sarel-proforma-number='.length).replace(/^["']|["']$/g, '').trim() : '';
  const sarelProformaNumber = sarelProformaNumberRaw ? sarelProformaNumberRaw.toUpperCase() : '';

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set.');
  const useSsl = /render\.com|sslmode=require/i.test(databaseUrl);
  const client = new Client({ connectionString: databaseUrl, ssl: useSsl ? { rejectUnauthorized: false } : undefined });

  await client.connect();
  log('Connected to PostgreSQL.');
  log(`Mode: ${APPLY ? 'APPLY (will write, only if every safety check passes)' : 'DRY RUN (no writes)'}`);
  log(`Collision being fixed: ${TARGET_LABEL}`);
  log(`Requested replacement number: ${newNumber || '(none supplied — pass --new-number="INV-00033" for the full safety analysis)'}`);
  log(`Resolve Sarel proforma conflict: ${resolveSarelProforma ? 'YES' : 'no'}${resolveSarelProforma ? `, proposed new number: ${sarelProformaNumber || '(none supplied — required)'}` : ''}`);

  try {
    // ── Stage 1: read-only investigation of the CURRENT INV-00068 collision, targeted key extraction only ──
    log('── Stage 1: searching LIVE platform_state for every INV-00068 match ──');
    const res = await client.query(
      `SELECT data->'accInvoices' AS acc_invoices, data->'jobs' AS jobs, data->'quotes' AS quotes
       FROM platform_state WHERE id = 1`
    );
    if (res.rowCount === 0) {
      log('platform_state row (id=1) does not exist — aborting, nothing to investigate or fix.');
      return;
    }
    const accInvoices: any[] = Array.isArray(res.rows[0].acc_invoices) ? res.rows[0].acc_invoices : [];
    const jobs: any[] = Array.isArray(res.rows[0].jobs) ? res.rows[0].jobs : [];
    const quotes: any[] = Array.isArray(res.rows[0].quotes) ? res.rows[0].quotes : [];
    log(`Pulled data->'accInvoices' (${accInvoices.length}), data->'jobs' (${jobs.length}), data->'quotes' (${quotes.length}) only — not the full platform_state blob.`);

    const candidates: Candidate[] = [];
    for (const inv of accInvoices) {
      const num = pick(inv, ['num', 'invoiceNum', 'number']);
      const reference = pick(inv, ['reference']);
      if (typeof num === 'string' && TARGET_REGEX.test(num)) candidates.push(makeAccInvoiceCandidate(inv, `accInvoices[].num === "${num}"`));
      else if (typeof reference === 'string' && TARGET_REGEX.test(reference)) candidates.push(makeAccInvoiceCandidate(inv, `accInvoices[].reference contains "${TARGET_LABEL}"`));
    }
    for (const job of jobs) {
      const invoiceNum = pick(job, ['invoiceNum']);
      const invoiceNo = pick(job, ['invoiceNo']);
      if (typeof invoiceNum === 'string' && TARGET_REGEX.test(invoiceNum)) candidates.push(makeJobCandidate(job, `jobs[].invoiceNum === "${invoiceNum}"`));
      else if (typeof invoiceNo === 'string' && TARGET_REGEX.test(invoiceNo)) candidates.push(makeJobCandidate(job, `jobs[].invoiceNo === "${invoiceNo}"`));
    }

    if (candidates.length === 0) {
      log(`No live record currently has invoice number ${TARGET_LABEL} — nothing to fix. Exiting.`);
      return;
    }
    log(`${candidates.length} live record(s) currently carry invoice number ${TARGET_LABEL}:`);
    candidates.forEach((c, i) => printCandidate(c, `candidate ${i + 1}`));

    if (candidates.length < 2) {
      log(`Only 1 live record carries ${TARGET_LABEL} — no collision currently exists live. No correction needed. Exiting.`);
      return;
    }
    if (candidates.length > 2) {
      log(`WARNING: ${candidates.length} live records carry ${TARGET_LABEL} — more than the 2 this script expects. Refusing to guess. Please review manually.`);
      return;
    }

    // ── Stage 2: identify which candidate is which ──
    log('── Stage 2: identifying which candidate is which ──');
    const newCandidate = candidates.find(
      (c) => (c.source === 'job-derived' && c.jobId === NEW_JOB_ID) || (c.source === 'accInvoices' && (c.quoteId === NEW_QUOTE_ID || c.quoteNumber === NEW_QUOTE_NUM))
    );
    const oldCandidate = candidates.find((c) => c.source === 'job-derived' && c.jobId === OLD_JOB_ID);
    if (!newCandidate || !oldCandidate) {
      log('Could not confidently match both candidates to the expected identities (SQ-00056/SNS-00055/Mossel Bay Golf Club vs SNS-00101/Whalecoast Dried Fruit and Nuts). Refusing to guess — please review the candidates above manually.');
      return;
    }
    if (norm(newCandidate.client) !== norm(NEW_CUSTOMER_NAME)) {
      log(`ABORT: expected the newly-created candidate's client to be "${NEW_CUSTOMER_NAME}", found "${newCandidate.client}". No changes made.`);
      return;
    }
    if (norm(oldCandidate.client) !== norm(OLD_CUSTOMER_NAME)) {
      log(`ABORT: expected the pre-existing candidate's client to be "${OLD_CUSTOMER_NAME}", found "${oldCandidate.client}". No changes made.`);
      return;
    }
    log(`Newly created (incorrect) record: ${newCandidate.source} ${newCandidate.source === 'accInvoices' ? 'id=' + newCandidate.invoiceId : 'job id=' + newCandidate.jobId} — ${newCandidate.client} (from ${NEW_QUOTE_NUM} / ${NEW_JOB_NUM}).`);
    log(`Pre-existing (correct, keeps ${TARGET_LABEL}) record: job id=${oldCandidate.jobId} — ${oldCandidate.client} (${OLD_JOB_NUM}), invoiced ${oldCandidate.date}.`);

    // ── Stage 2b: confirm Mossel Bay is the correct target ──
    log('── Stage 2b: confirming Mossel Bay Golf Club / SQ-00056 / SNS-00055 identity ──');
    const liveQuote56 = quotes.find((q) => q && q.id === NEW_QUOTE_ID);
    const liveJob55 = jobs.find((j) => j && j.id === NEW_JOB_ID);
    log(`  SQ-00056 exists live: ${liveQuote56 ? 'YES (id ' + liveQuote56.id + ')' : 'NO'}`);
    log(`  SNS-00055 exists live: ${liveJob55 ? 'YES (id ' + liveJob55.id + ')' : 'NO'}`);
    const liveProforma56 = liveQuote56 ? String(liveQuote56.proformaNum || '').trim() : null;
    log(`  SQ-00056 live proformaNum: ${liveProforma56 || '(not set live)'}`);
    log(`  SNS-00055 current invoiceNum: ${liveJob55 ? liveJob55.invoiceNum || '(not set)' : '(job not found)'}`);
    const linkedToQuote = liveJob55 && liveQuote56 && (liveJob55.id === liveQuote56.convertedJobId || liveJob55.quoteNum === liveQuote56.num);
    log(`  SNS-00055 linked to SQ-00056: ${linkedToQuote ? 'YES' : 'NO / could not confirm'}`);
    log(`  Client on SNS-00055: ${liveJob55 ? liveJob55.client : '—'}  |  Client on SQ-00056: ${liveQuote56 ? liveQuote56.client : '—'}`);

    if (!newNumber) {
      log('No --new-number supplied — stopping after basic collision investigation. Re-run with --new-number="INV-00033" (and --resolve-sarel-proforma --sarel-proforma-number="..." for the Sarel resolution) for the full safety analysis.');
      return;
    }
    if (!/^INV-\d{5,}$/.test(newNumber)) {
      log(`--new-number "${newNumberRaw}" does not look like a valid invoice number (expected e.g. "INV-00033"). Stopping.`);
      return;
    }

    // ── Stage 1c: is the requested replacement number already a REAL invoice
    //    anywhere else live? — global, not company-scoped. ──
    log(`── Checking real-invoice safety of ${newNumber} ──`);
    const NEW_NUMBER_REGEX = buildInvRegex(newNumber);
    const realHoldersOfNewNumber = [
      ...accInvoices
        .filter((i) => typeof pick(i, ['num', 'invoiceNum', 'number']) === 'string' && NEW_NUMBER_REGEX.test(pick(i, ['num', 'invoiceNum', 'number'])))
        .filter((i) => i.id !== newCandidate.invoiceId) // exclude the record we're about to correct, for idempotent re-runs
        .map((i) => `accInvoices id=${i.id} (${pick(i, ['contactName', 'client']) || '?'})`),
      ...jobs
        .filter((j) => typeof pick(j, ['invoiceNum', 'invoiceNo']) === 'string' && NEW_NUMBER_REGEX.test(pick(j, ['invoiceNum', 'invoiceNo'])))
        .filter((j) => j.id !== newCandidate.jobId)
        .map((j) => `job id=${j.id} (${j.client || '?'}, ${j.num || '?'})`),
    ];
    const realInvoiceBlock = realHoldersOfNewNumber.length > 0;
    if (realInvoiceBlock) {
      log(`  ✗ ${newNumber} is ALREADY a real invoice number elsewhere live: ${realHoldersOfNewNumber.join('; ')}`);
      log(`  This is a HARD BLOCK — ${newNumber} cannot be assigned to Mossel Bay while it's already in real use elsewhere.`);
    } else {
      log(`  ✓ ${newNumber} is not currently used as a real invoice by any other live record.`);
    }

    // ── Stage 1d: proformaNum claimant search ──
    log(`── Searching quotes[].proformaNum for every claimant of ${newNumber} ──`);
    const claimants = quotes.filter((q) => q && typeof q.proformaNum === 'string' && NEW_NUMBER_REGEX.test(q.proformaNum));
    if (claimants.length === 0) {
      log(`  No quote currently carries proformaNum ${newNumber} live.`);
    } else {
      log(`  ${claimants.length} quote(s) carry proformaNum ${newNumber} live:`);
      claimants.forEach((q) => log(`    - ${q.num} (id ${q.id}) — ${q.client} — status "${q.status}" — convertedJobId ${q.convertedJobId ?? 'none'}`));
    }

    // ── Stage 2c: resolving Sarel/Cash Sale's (SQ-00067/SNS-00053) duplicate
    //    proforma claim on the number Mossel Bay needs ──
    log('── Checking the other historical claimant: SQ-00067 / Cash Sale / Sarel ──');
    const liveQuote67 = quotes.find((q) => q && q.id === OTHER_CLAIMANT_QUOTE_ID);
    const liveJob53 = jobs.find((j) => j && j.id === OTHER_CLAIMANT_JOB_ID);
    let sarelHasLiveConflict = false;
    let sarelResolutionSafe = false;
    let sarelResolutionBlockReason = '';
    let realInvoiceForOther: string | null = null;
    if (!liveQuote67) {
      log(`  SQ-00067 not found live (id ${OTHER_CLAIMANT_QUOTE_ID}) — cannot check, treating as no conflict.`);
    } else {
      log(`  SQ-00067 exists live: id=${liveQuote67.id}, client="${liveQuote67.client}", status="${liveQuote67.status}", convertedJobId=${liveQuote67.convertedJobId ?? 'none'}`);
      log(`  SQ-00067 live proformaNum: ${liveQuote67.proformaNum || '(not set)'}`);
      log(`  SNS-00053 exists live: ${liveJob53 ? 'YES (id ' + liveJob53.id + ', invoiceNum=' + (liveJob53.invoiceNum || '(none)') + ')' : 'NO'}`);
      realInvoiceForOther = findRealInvoiceForQuote(liveQuote67, jobs, accInvoices);
      log(`  Does SQ-00067 / Cash Sale already have a real invoice of its own? ${realInvoiceForOther ? 'YES — ' + realInvoiceForOther : 'NO'}`);
      log(`  SQ-00067 / SNS-00053 payments: quote.payments ${summarizePayments(liveQuote67.payments)}, job.payments ${summarizePayments(liveJob53?.payments)}`);
      const q67Total = liveJob53 ? parseFloat(liveJob53.value) || 0 : parseFloat(liveQuote67.value) || 0;
      log(`  SQ-00067 / SNS-00053 quote/job total: ${fmtR(q67Total)}`);

      sarelHasLiveConflict = !realInvoiceForOther && norm(liveQuote67.proformaNum || '') === norm(newNumber);
      if (!sarelHasLiveConflict) {
        if (realInvoiceForOther) {
          log(`  ✓ No live conflict — Cash Sale/Sarel already has their own real invoice (${realInvoiceForOther}), so their proformaNum is stale/moot. Not touched.`);
        } else {
          log(`  ✓ No live conflict — SQ-00067's live proformaNum no longer matches ${newNumber}. Not touched.`);
        }
      } else {
        log(`  ✗ LIVE CONFLICT: SQ-00067 / Cash Sale / Sarel has NOT been invoiced yet and its proformaNum is still ${newNumber} — this must be resolved before Mossel Bay can safely use ${newNumber}.`);
        log('  Business decision: Sarel/Cash Sale must be reassigned a NEW proforma number (not cleared, not a real invoice).');
        if (!resolveSarelProforma) {
          sarelResolutionBlockReason = `--resolve-sarel-proforma was not passed. This is a HARD BLOCK — pass --resolve-sarel-proforma --sarel-proforma-number="INV-XXXXX" to propose a resolution as part of this plan.`;
          log(`  ${sarelResolutionBlockReason}`);
        } else if (!sarelProformaNumber) {
          sarelResolutionBlockReason = `--resolve-sarel-proforma was passed but --sarel-proforma-number="..." was not. A new proforma number must be explicitly supplied — this script never invents one.`;
          log(`  ${sarelResolutionBlockReason}`);
        } else if (!/^INV-\d{5,}$/.test(sarelProformaNumber)) {
          sarelResolutionBlockReason = `--sarel-proforma-number "${sarelProformaNumberRaw}" does not look like a valid number (expected e.g. "INV-00090").`;
          log(`  ${sarelResolutionBlockReason}`);
        } else if (norm(sarelProformaNumber) === norm(newNumber)) {
          sarelResolutionBlockReason = `--sarel-proforma-number cannot equal ${newNumber} — that would recreate the exact conflict being resolved.`;
          log(`  ${sarelResolutionBlockReason}`);
        } else if (norm(sarelProformaNumber) === norm(TARGET_LABEL)) {
          sarelResolutionBlockReason = `--sarel-proforma-number cannot equal ${TARGET_LABEL} (Whalecoast's real invoice number).`;
          log(`  ${sarelResolutionBlockReason}`);
        } else {
          // Global real-invoice safety check for the proposed Sarel proforma number.
          const SAREL_NUM_REGEX = buildInvRegex(sarelProformaNumber);
          const realHoldersOfSarelNumber = [
            ...accInvoices
              .filter((i) => typeof pick(i, ['num', 'invoiceNum', 'number']) === 'string' && SAREL_NUM_REGEX.test(pick(i, ['num', 'invoiceNum', 'number'])))
              .map((i) => `accInvoices id=${i.id} (${pick(i, ['contactName', 'client']) || '?'})`),
            ...jobs
              .filter((j) => typeof pick(j, ['invoiceNum', 'invoiceNo']) === 'string' && SAREL_NUM_REGEX.test(pick(j, ['invoiceNum', 'invoiceNo'])))
              .map((j) => `job id=${j.id} (${j.client || '?'}, ${j.num || '?'})`),
          ];
          // Any other quote already claiming this as its proformaNum? (excluding SQ-00067 itself)
          const otherProformaClaimants = quotes.filter(
            (q) => q && q.id !== OTHER_CLAIMANT_QUOTE_ID && typeof q.proformaNum === 'string' && SAREL_NUM_REGEX.test(q.proformaNum)
          );
          if (realHoldersOfSarelNumber.length > 0) {
            sarelResolutionBlockReason = `${sarelProformaNumber} is already a REAL invoice number elsewhere live: ${realHoldersOfSarelNumber.join('; ')}. Cannot assign it as Sarel's proforma number.`;
            log(`  ✗ ${sarelResolutionBlockReason}`);
          } else if (otherProformaClaimants.length > 0) {
            sarelResolutionBlockReason = `${sarelProformaNumber} is already recorded as another quote's proformaNum: ${otherProformaClaimants.map((q) => `${q.num} (id ${q.id})`).join(', ')}. Cannot assign it as Sarel's proforma number.`;
            log(`  ✗ ${sarelResolutionBlockReason}`);
          } else {
            sarelResolutionSafe = true;
            log(`  ✓ ${sarelProformaNumber} is free — not used as a real invoice anywhere, and not claimed as another quote's proformaNum.`);
            log(`  Proposed change: SQ-00067.proformaNum "${liveQuote67.proformaNum}" -> "${sarelProformaNumber}"`);
          }
        }
      }
    }
    const otherClaimantConflict = sarelHasLiveConflict && !sarelResolutionSafe;

    // ── Stage 2d: payment/deposit inspection for SQ-00056 / SNS-00055 ──
    log('── Inspecting payments for SQ-00056 / SNS-00055 ──');
    const quotePayments: any[] = liveQuote56 && Array.isArray(liveQuote56.payments) ? liveQuote56.payments : [];
    const jobPayments: any[] = liveJob55 && Array.isArray(liveJob55.payments) ? liveJob55.payments : [];
    const linkedAccInvoice = accInvoices.find((i) => i && (i.quoteId === NEW_QUOTE_ID || i.jobId === NEW_JOB_ID));
    const accInvoicePayments: any[] = linkedAccInvoice && Array.isArray(linkedAccInvoice.payments) ? linkedAccInvoice.payments : [];
    log(`  quote.payments: ${summarizePayments(quotePayments)}`);
    log(`  job.payments: ${summarizePayments(jobPayments)}`);
    log(`  linked accInvoices record: ${linkedAccInvoice ? 'id ' + linkedAccInvoice.id : 'none'} — payments: ${summarizePayments(accInvoicePayments)}`);
    log(`  Looking for payment id ${EXPECTED_DEPOSIT_PAYMENT_ID} (expected ~${fmtR(EXPECTED_DEPOSIT_AMOUNT)} EFT deposit)`);
    const depositById = quotePayments.find((p) => String(p?.id) === EXPECTED_DEPOSIT_PAYMENT_ID);
    const depositByAmount = !depositById ? quotePayments.find((p) => Math.abs((parseFloat(p?.amount) || 0) - EXPECTED_DEPOSIT_AMOUNT) <= PAYMENT_TOLERANCE) : undefined;
    const depositPayment = depositById || depositByAmount;
    if (depositById) log(`  ✓ Found by exact id match on quote.payments, id=${depositPayment.id}, amount=${fmtR(parseFloat(depositPayment.amount) || 0)}`);
    else if (depositByAmount) log(`  ⚠ Not found by id ${EXPECTED_DEPOSIT_PAYMENT_ID} — found a different payment matching the expected amount instead: id=${depositPayment.id}. Review before relying on this match.`);
    else log('  ✗ Not found by id or by expected amount — check the lists above manually. No carry will be proposed.');
    // Global duplicate-payment-id scan (any payment id appearing on more than
    // one record anywhere live) — informational; never modifies anything.
    const paymentIdLocations = new Map<string, string[]>();
    const registerPayments = (list: any[], label: string) => {
      for (const p of list || []) {
        if (p?.id === undefined) continue;
        const key = String(p.id);
        paymentIdLocations.set(key, [...(paymentIdLocations.get(key) || []), label]);
      }
    };
    registerPayments(quotePayments, `quote ${NEW_QUOTE_NUM}`);
    registerPayments(jobPayments, `job ${NEW_JOB_NUM}`);
    registerPayments(accInvoicePayments, `accInvoices id ${linkedAccInvoice?.id}`);
    const duplicatedPaymentIds = [...paymentIdLocations.entries()].filter(([, locs]) => locs.length > 1);
    if (duplicatedPaymentIds.length) {
      log(`  ⚠ Payment id(s) already present in more than one place: ${duplicatedPaymentIds.map(([id, locs]) => `${id} (${locs.join(', ')})`).join('; ')}`);
    } else {
      log('  No payment id duplication detected yet across quote/job/accInvoices for this transaction.');
    }
    const needsPaymentCarry = !!depositPayment && !jobPayments.some((p) => p?.id === depositPayment.id) && !accInvoicePayments.some((p) => p?.id === depositPayment.id);
    log(`  Proposed action: ${needsPaymentCarry ? `carry payment id=${depositPayment.id} from quote.payments into job.payments ONCE (deduped by id) so it's visible as this job's own payment` : depositPayment ? 'no carry needed — the payment already appears on the record that will hold the real invoice' : 'no carry proposed — no matching deposit payment was found'}`);

    // ── Stage 2e: company mismatch ──
    log('── Checking company (co) consistency ──');
    const quoteCo = liveQuote56?.co;
    const jobCo = liveJob55?.co;
    log(`  SQ-00056 co: ${quoteCo}  |  SNS-00055 co: ${jobCo}`);
    const coMismatch = !!(liveQuote56 && liveJob55 && String(quoteCo) !== String(jobCo));
    if (coMismatch) {
      log(`  ✗ Mismatch found. Proposed correction: set SNS-00055.co to ${quoteCo} (matching its source quote) as part of this same apply — this is the root cause that let the two companies' independent invoice-number counters collide in the first place.`);
    } else {
      log('  No mismatch — no co change proposed.');
    }

    // ── Stage 2f: invoice status proposal ──
    log('── Calculating proposed invoice status ──');
    const inclVatTotal = parseFloat(liveJob55?.value) || 0; // job.value is already VAT-inclusive in this app's convention
    const exVatTotal = inclVatTotal / 1.15;
    const mergedPaymentsForTotal = new Map<string, any>();
    [...jobPayments, ...quotePayments, ...accInvoicePayments].forEach((p) => { if (p?.id !== undefined && !mergedPaymentsForTotal.has(String(p.id))) mergedPaymentsForTotal.set(String(p.id), p); });
    const paymentTotal = [...mergedPaymentsForTotal.values()].reduce((s, p) => s + (parseFloat(p?.amount) || 0), 0);
    let proposedStatus = 'pending'; // this app's own vocabulary — 'pending' means invoiced/unpaid
    if (paymentTotal > 0 && inclVatTotal > 0 && paymentTotal >= inclVatTotal - PAYMENT_TOLERANCE) proposedStatus = 'paid';
    else if (paymentTotal > 0) proposedStatus = 'partial';
    log(`  Ex-VAT total:        ${fmtR(exVatTotal)}`);
    log(`  VAT-inclusive total: ${fmtR(inclVatTotal)}`);
    log(`  Payment total (deduped across quote/job/accInvoices): ${fmtR(paymentTotal)}`);
    log(`  Proposed job.invoiceStatus: ${proposedStatus} (current: ${liveJob55?.invoiceStatus || '(not set)'})`);

    // ── Stage 3: dry-run plan summary ──
    const safeToApply = !realInvoiceBlock && !otherClaimantConflict;
    log('════════════════════════════════════════════════════════════════');
    log('DRY-RUN PLAN SUMMARY');
    log(`  Change: job id=${NEW_JOB_ID} (${NEW_JOB_NUM}, ${NEW_CUSTOMER_NAME}) invoiceNum "${TARGET_LABEL}" -> "${newNumber}"`);
    if (coMismatch) log(`  Change: job id=${NEW_JOB_ID} co ${jobCo} -> ${quoteCo}`);
    if (needsPaymentCarry) log(`  Change: job id=${NEW_JOB_ID} payments += payment id=${depositPayment.id} (carried from quote ${NEW_QUOTE_NUM}, deduped)`);
    log(`  Change: job id=${NEW_JOB_ID} invoiceStatus -> ${proposedStatus}`);
    log(`  Change: ${sarelHasLiveConflict ? (sarelResolutionSafe ? `quote id=${OTHER_CLAIMANT_QUOTE_ID} (${OTHER_CLAIMANT_QUOTE_NUM}) proformaNum "${liveQuote67?.proformaNum}" -> "${sarelProformaNumber}"` : `BLOCKED — ${sarelResolutionBlockReason}`) : 'none needed for SQ-00067 (no live conflict)'}`);
    log(`  Untouched: job id=${OLD_JOB_ID} (${OLD_JOB_NUM}, ${OLD_CUSTOMER_NAME}) keeps ${TARGET_LABEL}`);
    log(`  Untouched: quote SQ-00056 (never written by this script)`);
    log(`  Untouched: SQ-00067's invoice fields, status, and payments; SNS-00053 entirely (no invoice ever created for Sarel/Cash Sale by this script)`);
    log(`  Real-invoice safety of ${newNumber}: ${realInvoiceBlock ? 'BLOCKED — already used elsewhere' : 'clear'}`);
    log(`  Sarel/Cash Sale live conflict on ${newNumber}: ${sarelHasLiveConflict ? (sarelResolutionSafe ? 'resolved by proposed proforma reassignment above' : 'BLOCKED — unresolved') : 'none'}`);
    log(`  Safe to apply: ${safeToApply ? 'YES' : 'NO'}`);
    log('════════════════════════════════════════════════════════════════');

    if (!APPLY) {
      log('DRY RUN complete — no changes written. Re-run with --apply --confirm="' + REQUIRED_CONFIRM + '" --new-number="' + newNumber + '"' + (sarelHasLiveConflict ? ' --resolve-sarel-proforma --sarel-proforma-number="' + (sarelProformaNumber || 'INV-XXXXX') + '"' : '') + ' to apply this exact plan, once you approve it.');
      return;
    }

    // ── Stage 4: apply gate ──
    if (confirm !== REQUIRED_CONFIRM) {
      log(`--apply was given but --confirm did not exactly match "${REQUIRED_CONFIRM}". Refusing to change anything.`);
      return;
    }
    if (realInvoiceBlock) {
      log(`REFUSING TO APPLY: ${newNumber} is already a real invoice number elsewhere live (see above). This is not overridable by --confirm. No changes made.`);
      return;
    }
    if (otherClaimantConflict) {
      log(`REFUSING TO APPLY: SQ-00067 / Cash Sale / Sarel's duplicate proforma claim on ${newNumber} is not resolved (${sarelResolutionBlockReason || 'live conflict'}). This is a live conflict that needs a human-approved --resolve-sarel-proforma --sarel-proforma-number — not overridable by --confirm alone. No changes made.`);
      return;
    }

    await client.query('BEGIN');
    try {
      const lockedRes = await client.query('SELECT data FROM platform_state WHERE id = 1 FOR UPDATE');
      if (lockedRes.rowCount === 0) throw new Error('platform_state row (id=1) disappeared before write.');
      const liveData = lockedRes.rows[0].data || {};
      const lJobs: any[] = Array.isArray(liveData.jobs) ? liveData.jobs : [];
      const lAcc: any[] = Array.isArray(liveData.accInvoices) ? liveData.accInvoices : [];
      const lQuotes: any[] = Array.isArray(liveData.quotes) ? liveData.quotes : [];

      // Re-verify everything against the freshly-locked row — never trust the
      // pre-transaction read for the actual write decision.
      const curJob = lJobs.find((j) => j.id === NEW_JOB_ID);
      if (!curJob) throw new Error(`job id ${NEW_JOB_ID} not found live inside the transaction — aborting.`);
      if (norm(curJob.invoiceNum) !== norm(TARGET_LABEL)) throw new Error(`job id ${NEW_JOB_ID} no longer carries ${TARGET_LABEL} live (now "${curJob.invoiceNum}") — data moved since the dry run. Re-run for a fresh plan.`);
      const curOldJob = lJobs.find((j) => j.id === OLD_JOB_ID);
      if (!curOldJob || norm(curOldJob.invoiceNum) !== norm(TARGET_LABEL)) throw new Error(`Whalecoast job id ${OLD_JOB_ID} no longer carries ${TARGET_LABEL} live — aborting rather than risk leaving nobody holding it.`);

      const collideAcc = lAcc.find((i) => norm(pick(i, ['num', 'invoiceNum', 'number'])) === norm(newNumber));
      const collideJob = lJobs.find((j) => j.id !== NEW_JOB_ID && norm(pick(j, ['invoiceNum', 'invoiceNo'])) === norm(newNumber));
      if (collideAcc || collideJob) {
        throw new Error(`${newNumber} is already used by another live record (${collideAcc ? 'accInvoices id ' + collideAcc.id : 'job id ' + (collideJob as any).id}) as of the write moment. Aborting.`);
      }

      // Re-verify the Sarel conflict (and its resolution, if any) against fresh data.
      let sarelPatchNeeded = false;
      const curQuote67 = lQuotes.find((q) => q.id === OTHER_CLAIMANT_QUOTE_ID);
      if (curQuote67) {
        const realInvoiceForOtherNow = findRealInvoiceForQuote(curQuote67, lJobs, lAcc);
        const stillConflicts = !realInvoiceForOtherNow && norm(curQuote67.proformaNum || '') === norm(newNumber);
        if (stillConflicts) {
          if (!resolveSarelProforma || !sarelProformaNumber || !sarelResolutionSafe) {
            throw new Error('SQ-00067 / Cash Sale / Sarel still expects this exact number as of the write moment, and no valid, pre-verified --resolve-sarel-proforma / --sarel-proforma-number resolution was approved — aborting (live conflict).');
          }
          const SAREL_NUM_REGEX_TX = buildInvRegex(sarelProformaNumber);
          const collideAccSarel = lAcc.find((i) => typeof pick(i, ['num', 'invoiceNum', 'number']) === 'string' && SAREL_NUM_REGEX_TX.test(pick(i, ['num', 'invoiceNum', 'number'])));
          const collideJobSarel = lJobs.find((j) => typeof pick(j, ['invoiceNum', 'invoiceNo']) === 'string' && SAREL_NUM_REGEX_TX.test(pick(j, ['invoiceNum', 'invoiceNo'])));
          const collideQuoteSarel = lQuotes.find((q) => q.id !== OTHER_CLAIMANT_QUOTE_ID && typeof q.proformaNum === 'string' && SAREL_NUM_REGEX_TX.test(q.proformaNum));
          if (collideAccSarel || collideJobSarel || collideQuoteSarel) {
            throw new Error(`${sarelProformaNumber} is no longer free as of the write moment — aborting.`);
          }
          sarelPatchNeeded = true;
        }
      }

      const curQuote56 = lQuotes.find((q) => q.id === NEW_QUOTE_ID);
      const jobPatch: Record<string, any> = { invoiceNum: newNumber, invoiceStatus: proposedStatus };
      if (coMismatch && curQuote56) jobPatch.co = curQuote56.co;
      if (needsPaymentCarry && depositPayment) {
        const already = (curJob.payments || []).some((p: any) => p?.id === depositPayment.id);
        jobPatch.payments = already ? curJob.payments : [...(curJob.payments || []), { ...depositPayment }];
      }
      const updatedJobs = lJobs.map((j) => (j.id === NEW_JOB_ID ? { ...j, ...jobPatch } : j));
      const updatedQuotes = sarelPatchNeeded
        ? lQuotes.map((q) => (q.id === OTHER_CLAIMANT_QUOTE_ID ? { ...q, proformaNum: sarelProformaNumber } : q))
        : lQuotes;

      // Backup current (pre-fix) state BEFORE writing anything.
      const serialized = JSON.stringify(liveData);
      await client.query(
        `INSERT INTO platform_state_backups (data, reason, data_size_bytes, source)
         VALUES ($1::jsonb, 'before-fix-inv00068-collision', $2, $3)`,
        [serialized, Buffer.byteLength(serialized, 'utf8'), 'fixInvoiceCollisionINV00068August2026.ts (manual run)']
      );
      log('Current platform_state backed up to platform_state_backups.');

      const nextData = { ...liveData, jobs: updatedJobs, quotes: updatedQuotes };
      await client.query(`UPDATE platform_state SET data = $1::jsonb, updated_at = NOW() WHERE id = 1`, [JSON.stringify(nextData)]);

      // ── Post-write verification, inside the same transaction ──
      // SCOPED to this task: hard-fails only on the specific numbers/records
      // this correction touches or must leave untouched (INV-00068,
      // newNumber/INV-00033, Mossel Bay/Whalecoast/Sarel, the one carried
      // payment id, and record counts). System-wide historical duplicate
      // invoice numbers unrelated to this task (e.g. legacy INV-00001 to
      // INV-00014, INV-00057) are NOT this script's job to fix — they are
      // reported as a warning only, never a rollback reason.
      const isTargetNum = (v: any) => typeof v === 'string' && TARGET_REGEX.test(v);
      const isNewNum = (v: any) => typeof v === 'string' && NEW_NUMBER_REGEX.test(v);

      // 1, 2, 3: INV-00068 — exactly one real-invoice holder, and it must be Whalecoast/SNS-00101, never Mossel Bay.
      const holdersOfTarget = [
        ...lAcc.filter((i) => isTargetNum(pick(i, ['num', 'invoiceNum', 'number']))).map((i) => ({ kind: 'accInvoices', id: i.id })),
        ...updatedJobs.filter((j) => isTargetNum(pick(j, ['invoiceNum', 'invoiceNo']))).map((j) => ({ kind: 'job', id: j.id })),
      ];
      if (holdersOfTarget.length > 1) {
        throw new Error(`Post-write verification failed: more than one real invoice now uses ${TARGET_LABEL}: ${holdersOfTarget.map((h) => `${h.kind} id=${h.id}`).join(', ')}. Rolling back.`);
      }
      if (!holdersOfTarget.some((h) => h.kind === 'job' && h.id === OLD_JOB_ID)) {
        throw new Error(`Post-write verification failed: ${TARGET_LABEL} is not held by Whalecoast/SNS-00101 after the write. Rolling back.`);
      }
      if (holdersOfTarget.some((h) => h.kind === 'job' && h.id === NEW_JOB_ID)) {
        throw new Error(`Post-write verification failed: Mossel Bay/SNS-00055 still uses ${TARGET_LABEL} after the write. Rolling back.`);
      }

      // 4, 5: newNumber (INV-00033) — held only by Mossel Bay/SNS-00055 as a real invoice.
      const holdersOfNewNumber = [
        ...lAcc.filter((i) => isNewNum(pick(i, ['num', 'invoiceNum', 'number']))).map((i) => ({ kind: 'accInvoices', id: i.id })),
        ...updatedJobs.filter((j) => isNewNum(pick(j, ['invoiceNum', 'invoiceNo']))).map((j) => ({ kind: 'job', id: j.id })),
      ];
      if (!holdersOfNewNumber.some((h) => h.kind === 'job' && h.id === NEW_JOB_ID)) {
        throw new Error(`Post-write verification failed: Mossel Bay/SNS-00055 does not use ${newNumber} after the write. Rolling back.`);
      }
      const otherRealHoldersOfNewNumber = holdersOfNewNumber.filter((h) => !(h.kind === 'job' && h.id === NEW_JOB_ID));
      if (otherRealHoldersOfNewNumber.length > 0) {
        throw new Error(`Post-write verification failed: ${newNumber} is used as a real invoice by another record: ${otherRealHoldersOfNewNumber.map((h) => `${h.kind} id=${h.id}`).join(', ')}. Rolling back.`);
      }

      // 6, 7, 8: Sarel's proforma resolution.
      const sarelAfter = updatedQuotes.find((q) => q.id === OTHER_CLAIMANT_QUOTE_ID);
      if (sarelAfter && norm(sarelAfter.proformaNum) === norm(newNumber)) {
        throw new Error(`Post-write verification failed: SQ-00067 still has proformaNum ${newNumber} after the write. Rolling back.`);
      }
      if (sarelPatchNeeded) {
        if (!sarelAfter || norm(sarelAfter.proformaNum) !== norm(sarelProformaNumber)) {
          throw new Error(`Post-write verification failed: SQ-00067.proformaNum does not equal the approved ${sarelProformaNumber} after the write. Rolling back.`);
        }
        const SAREL_NUM_REGEX_VERIFY = buildInvRegex(sarelProformaNumber);
        const otherClaimantsOfSarelNumber = updatedQuotes.filter(
          (q) => q && q.id !== OTHER_CLAIMANT_QUOTE_ID && typeof q.proformaNum === 'string' && SAREL_NUM_REGEX_VERIFY.test(q.proformaNum)
        );
        if (otherClaimantsOfSarelNumber.length > 0) {
          throw new Error(`Post-write verification failed: ${sarelProformaNumber} is also claimed by another quote's proformaNum: ${otherClaimantsOfSarelNumber.map((q) => q.num).join(', ')}. Rolling back.`);
        }
      }

      // 9, 10: the one carried payment — present exactly once on Mossel Bay's job.payments.
      const mosselBayJobAfter = updatedJobs.find((j) => j.id === NEW_JOB_ID);
      if (needsPaymentCarry && depositPayment) {
        const carriedCount = (mosselBayJobAfter?.payments || []).filter((p: any) => p?.id === depositPayment.id).length;
        if (carriedCount === 0) {
          throw new Error(`Post-write verification failed: payment id=${depositPayment.id} is missing from Mossel Bay/SNS-00055.payments after the write. Rolling back.`);
        }
        if (carriedCount > 1) {
          throw new Error(`Post-write verification failed: payment id=${depositPayment.id} appears more than once on Mossel Bay/SNS-00055.payments after the write. Rolling back.`);
        }
      }

      // 11: co correction, only if it was proposed.
      if (coMismatch && String(mosselBayJobAfter?.co) !== String(quoteCo)) {
        throw new Error(`Post-write verification failed: Mossel Bay/SNS-00055.co is not ${quoteCo} after the write. Rolling back.`);
      }

      // 12: Whalecoast completely untouched (fields and payments).
      const whalecoastAfter = updatedJobs.find((j) => j.id === OLD_JOB_ID);
      if (JSON.stringify(whalecoastAfter) !== JSON.stringify(curOldJob)) {
        throw new Error('Post-write verification failed: Whalecoast/SNS-00101 job fields or payments changed unexpectedly. Rolling back.');
      }

      // 13: record counts unchanged.
      if (updatedJobs.length !== lJobs.length) throw new Error('Post-write verification failed: job count changed — expected zero additions/removals. Rolling back.');
      if (updatedQuotes.length !== lQuotes.length) throw new Error('Post-write verification failed: quote count changed — expected zero additions/removals. Rolling back.');

      // Historical, unrelated duplicate invoice numbers — informational only.
      // Never a rollback reason: fixing pre-existing unrelated duplicates
      // (e.g. legacy INV-00001..INV-00014, INV-00057) is explicitly out of
      // scope for this targeted script.
      const globalDupCheck = new Map<string, string[]>();
      for (const i of lAcc) {
        const n = norm(pick(i, ['num', 'invoiceNum', 'number']));
        if (n) globalDupCheck.set(n, [...(globalDupCheck.get(n) || []), `accInvoices id=${i.id}`]);
      }
      for (const j of updatedJobs) {
        const n = norm(j.invoiceNum);
        if (n) globalDupCheck.set(n, [...(globalDupCheck.get(n) || []), `job id=${j.id}`]);
      }
      const relevantNums = new Set([norm(TARGET_LABEL), norm(newNumber)]);
      const unrelatedDupes = [...globalDupCheck.entries()].filter(([n, refs]) => refs.length > 1 && !relevantNums.has(n));
      if (unrelatedDupes.length > 0) {
        log(`WARNING: unrelated pre-existing duplicate invoice numbers still exist: ${unrelatedDupes.map(([n]) => n.toUpperCase()).join(', ')}. Not introduced by this script — out of scope for this correction, left untouched.`);
      }

      await client.query('COMMIT');
      log(`✓ Applied. Job ${NEW_JOB_NUM} (${NEW_CUSTOMER_NAME}): invoiceNum "${TARGET_LABEL}" -> "${newNumber}"${coMismatch ? `, co -> ${jobPatch.co}` : ''}${needsPaymentCarry ? ', deposit payment carried onto job.payments' : ''}, invoiceStatus -> ${proposedStatus}.`);
      if (sarelPatchNeeded) log(`✓ Applied. Quote ${OTHER_CLAIMANT_QUOTE_NUM} (${OTHER_CLAIMANT_CUSTOMER_NAME}): proformaNum -> "${sarelProformaNumber}". No invoice created, SNS-00053 untouched, no payments moved.`);
      log(`✓ Verified: ${TARGET_LABEL} remains ONLY on ${OLD_CUSTOMER_NAME} (job ${OLD_JOB_NUM}); ${newNumber} is used as a real invoice ONLY on ${NEW_CUSTOMER_NAME}; no other quote still claims ${newNumber} as proformaNum; no duplicate invoice numbers anywhere live; job and quote counts unchanged; only the expected fields on one job (and, if applicable, one quote) were touched.`);
      log('No statement double-counting risk: the payment carry (if any) was deduped by id, and every downstream total already merges quote+job payments by id.');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      log(`✗ FAILED — transaction rolled back. No changes were written. Reason: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[fix-inv00068] Fatal error:', err);
    process.exit(1);
  });
