/**
 * READ-ONLY reconciliation tool: platform_state JSON vs relational tables.
 *
 * Never writes anything — no INSERT/UPDATE/DELETE anywhere in this file,
 * on any table. Compares, for every migrated collection, the live JSON
 * array against its rel_* table and classifies every source record as:
 *
 *   MATCH               — present in both, content identical
 *   DIFFERENT           — present in both, content differs (relational is
 *                         stale — re-run the backfill)
 *   MISSING_IN_RELATIONAL — present in JSON, not found relationally, and
 *                         NOT part of a currently-quarantined duplicate-id
 *                         group (an unexpected gap — investigate)
 *   EXTRA_IN_RELATIONAL — present relationally, no longer present in the
 *                         live JSON array (the JSON section moved on since
 *                         the relational row was written — investigate
 *                         before treating relational as authoritative)
 *   QUARANTINED         — present in JSON as part of a duplicate-source-id
 *                         group; deliberately never in the relational table
 *                         (see backfill.ts) — EXPECTED, not a bug
 *
 * FINANCIAL RECONCILIATION: for quotes/jobs/invoices, also compares
 * computed subtotal/vat/total figures and payment sums between the JSON
 * source and what's stored relationally — never recomputes and silently
 * overwrites a historical value; only reports where they disagree.
 *
 * SAFE-TO-CUTOVER gate (per section):
 *   safeToCutover = (missing == 0) && (extra == 0) && (different == 0)
 *                   && (quarantined == 0)
 * Quarantined records are the one case that blocks cutover EVEN THOUGH they
 * are "expected" rather than a bug: once a section is cut over, the
 * relational tables become the ONLY place the application reads that
 * section from (see backend/src/relational/cutover.ts + the platformState
 * write-isolation change) — a permanently-quarantined historical duplicate
 * id would silently vanish from the live application the moment cutover
 * happens, unless someone has separately built a "still read these specific
 * legacy ids from JSON forever" carve-out. That carve-out does not exist
 * yet (explicitly out of scope for this migration, like resolving the
 * collisions themselves) — so by design this gate stays closed for any
 * section with outstanding quarantined groups until either (a) the
 * historical collision is manually resolved (a human decision, never
 * automatic) or (b) such a carve-out is deliberately built and reviewed.
 *
 * USAGE (run from backend/):
 *   npx ts-node --transpile-only src/relational/reconcile.ts
 *   npx ts-node --transpile-only src/relational/reconcile.ts --source-file=test/fixtures/sample-state.json
 *   npx ts-node --transpile-only src/relational/reconcile.ts --mode=post-cutover
 *
 * ══════════════════════════════════════════════════════════════════════
 * STAGE 3 (2026-08-20) — WHY THERE ARE NOW TWO MODES
 * ══════════════════════════════════════════════════════════════════════
 * Everything above this note (`runReconciliation`, the MATCH/DIFFERENT/...
 * classification, `safeToCutOver`) is UNCHANGED and remains the PRE-CUTOVER
 * check — it compares each rel_* row's `legacy_data` (the snapshot captured
 * at backfill time) against the CURRENT live JSON. That comparison is
 * exactly right before any relational writes have happened for a section:
 * pre-cutover, the only way a rel_* row's modeled columns/legacy_data can
 * exist at all is via backfill.ts, which is itself driven directly by the
 * live JSON — so "does relational match JSON" and "is the backfill fresh"
 * are the same question, and `runReconciliation` (still the function every
 * existing test and `cutoverCli.ts enable` calls) keeps answering it
 * unchanged, byte-for-byte, exactly as before.
 *
 * That comparison basis STOPS being meaningful the moment a section
 * receives a REAL relational write through services.ts (Stage 3's
 * updateJob/updateQuote/recordPayment/etc.) — those functions intentionally
 * update the normalized rel_* columns but never rewrite `legacy_data` (by
 * design: legacy_data stays as historical backfill provenance, not a
 * running mirror of every edit). So once a section has live relational
 * writes (which today only happens in local testing, or in production
 * after a section is actually cut over), `runReconciliation` would report
 * every edited record as DIFFERENT forever, with the message "relational
 * copy is stale, re-run the backfill" — which is BACKWARDS: the relational
 * copy is the fresher, authoritative one; the JSON is what's stale.
 *
 * `runPostCutoverIntegrityCheck` below is the answer for that situation. It
 * NEVER compares against JSON/legacy_data at all — it verifies the
 * relational data is internally consistent on its own terms: no duplicate
 * document numbers (a belt-and-suspenders check; the DB's own UNIQUE
 * constraints already prevent this), no dangling foreign-key references
 * (a quote's converted_job_id/a job's quote_id/a PO's supplier_id-job_id-
 * quote_id/a payment's owner_id all still point at a row that exists), and
 * a small set of financial self-consistency invariants that must always
 * hold regardless of what JSON says (a quote's stored subtotal/vat/total
 * actually equal what its own current line items compute to; a credit
 * note's used_amount never exceeds its amount). This is what Phase 22's
 * "post-cutover verification... not falsely requiring stale JSON to equal
 * current relational data" asks for.
 *
 * Neither function ever writes anything, on any table, in any mode.
 */
import fs from 'fs';
import path from 'path';
import pool from '../db/pool';
import { describeConnectionError } from '../db/ssl';

function arr(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}
function stableStringify(v: any): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
function num(v: unknown, fallback = 0): number {
  const n = parseFloat(v as any);
  return isNaN(n) ? fallback : n;
}
function approxEqual(a: number, b: number, eps = 0.01): boolean {
  return Math.abs(a - b) <= eps;
}

interface SectionReport {
  collection: string;
  table: string;
  totalSourceRecords: number;
  match: number;
  different: number;
  missingInRelational: number;
  extraInRelational: number;
  quarantined: number;
  financialMismatches: Array<{ sourceId: string; field: string; jsonValue: number; relationalValue: number }>;
  details: {
    different: Array<{ sourceId: string; documentNumber?: string }>;
    missingInRelational: Array<{ sourceId: string; documentNumber?: string }>;
    extraInRelational: Array<{ sourceId: string; documentNumber?: string }>;
    quarantined: Array<{ sourceId: string; documentNumber?: string }>;
  };
  safeToCutOver: boolean;
  reasons: string[];
  // 2026-08-21 PURCHASE ORDER MIGRATION POLICY CHANGE: set only on the
  // purchaseOrders section (see reconcileLegacyPolicySkippedCollection
  // below). Every other section leaves these undefined/falsy and keeps its
  // existing MATCH/DIFFERENT/MISSING/EXTRA/QUARANTINED semantics exactly as
  // before — this is a narrow, additive exception for one explicit,
  // user-approved migration-policy decision, not a general reconciliation
  // weakening.
  legacyPolicyExcluded?: boolean;
  legacySkippedByPolicy?: number;
}

function splitDuplicateIds(list: any[]): { clean: any[]; duplicateIds: Set<string> } {
  const groups = new Map<string, number>();
  for (const rec of list) {
    if (!rec || rec.id === undefined || rec.id === null) continue;
    const id = String(rec.id);
    groups.set(id, (groups.get(id) || 0) + 1);
  }
  const duplicateIds = new Set<string>();
  for (const [id, count] of groups) if (count > 1) duplicateIds.add(id);
  const clean = list.filter((rec) => rec && rec.id !== undefined && rec.id !== null && !duplicateIds.has(String(rec.id)));
  return { clean, duplicateIds };
}

async function reconcileSimpleCollection(
  jsonKey: string,
  table: string,
  list: any[],
  docNumberField?: string
): Promise<SectionReport> {
  const { clean, duplicateIds } = splitDuplicateIds(list);
  const jsonBySourceId = new Map<string, any>();
  for (const rec of clean) jsonBySourceId.set(String(rec.id), rec);

  const relRes = await pool.query(`SELECT source_id, legacy_data FROM ${table}`);
  const relBySourceId = new Map<string, any>();
  for (const row of relRes.rows) relBySourceId.set(String(row.source_id), row.legacy_data);

  const report: SectionReport = {
    collection: jsonKey, table, totalSourceRecords: list.length,
    match: 0, different: 0, missingInRelational: 0, extraInRelational: 0, quarantined: duplicateIds.size,
    financialMismatches: [],
    details: { different: [], missingInRelational: [], extraInRelational: [], quarantined: [] },
    safeToCutOver: false, reasons: [],
  };

  for (const id of duplicateIds) {
    const sample = list.find((r) => r && String(r.id) === id);
    report.details.quarantined.push({ sourceId: id, documentNumber: docNumberField ? sample?.[docNumberField] : undefined });
  }

  for (const [sourceId, jsonRec] of jsonBySourceId) {
    const relLegacy = relBySourceId.get(sourceId);
    if (relLegacy === undefined) {
      report.missingInRelational++;
      report.details.missingInRelational.push({ sourceId, documentNumber: docNumberField ? jsonRec[docNumberField] : undefined });
      continue;
    }
    if (stableStringify(relLegacy) === stableStringify(jsonRec)) {
      report.match++;
    } else {
      report.different++;
      report.details.different.push({ sourceId, documentNumber: docNumberField ? jsonRec[docNumberField] : undefined });
    }
  }

  for (const [sourceId] of relBySourceId) {
    if (!jsonBySourceId.has(sourceId)) {
      report.extraInRelational++;
      report.details.extraInRelational.push({ sourceId });
    }
  }

  report.safeToCutOver = report.missingInRelational === 0 && report.extraInRelational === 0 && report.different === 0 && report.quarantined === 0;
  if (report.missingInRelational > 0) report.reasons.push(`${report.missingInRelational} record(s) exist in JSON but not relationally — run the backfill (apply) again.`);
  if (report.extraInRelational > 0) report.reasons.push(`${report.extraInRelational} relational record(s) no longer exist in the live JSON array — investigate before treating relational as authoritative.`);
  if (report.different > 0) report.reasons.push(`${report.different} record(s) differ between JSON and relational — relational copy is stale, re-run the backfill (apply) again.`);
  if (report.quarantined > 0) report.reasons.push(`${report.quarantined} historical duplicate-id group(s) are quarantined (JSON-only, by design) — cutover stays blocked for this section until each is either manually resolved or an explicit legacy-carve-out is built and reviewed.`);
  if (report.safeToCutOver) report.reasons.push('No discrepancies found — safe to cut over.');

  return report;
}

// 2026-08-21 PURCHASE ORDER MIGRATION POLICY CHANGE.
//
// purchaseOrders is a DELIBERATE migration-policy exception: the 640
// historical JSON purchaseOrders records are intentionally never imported
// into rel_purchase_orders at all (see backfill.ts's PASS 6 —
// LEGACY_PURCHASE_ORDERS_SKIPPED_BY_POLICY). Running the generic
// reconcileSimpleCollection() above against that policy would misreport
// reality in two ways: it would count all 640 historical records as
// "missingInRelational" (implying "run the backfill again", which is
// exactly what must NEVER happen for these records), and it would flag
// every future MANUALLY-created relational PO as "extraInRelational"
// (implying "the JSON section moved on", which is nonsensical — manual POs
// were never expected to exist in JSON in the first place).
//
// This function replaces that comparison for purchaseOrders ONLY with a
// policy-aware check: it reports the 640 historical records as
// intentionally excluded (not missing, not a failure), and the only thing
// it actually verifies is that the policy is being honoured — i.e. that no
// relational rel_purchase_orders row's source_id matches one of the
// historical JSON purchaseOrders ids. That would mean the (removed) legacy
// import path somehow ran again, a genuine bug worth blocking cutover for.
// A brand-new manually-created PO's source_id is always its own fresh
// rel_purchase_orders_id_seq value (see services.ts's createPurchaseOrder),
// never a historical JSON id, so this check does not touch or restrict the
// manual workflow at all.
async function reconcileLegacyPolicySkippedCollection(jsonKey: string, table: string, list: any[]): Promise<SectionReport> {
  const jsonSourceIds = new Set<string>();
  for (const rec of list) {
    if (rec && rec.id !== undefined && rec.id !== null) jsonSourceIds.add(String(rec.id));
  }

  const relRes = await pool.query(`SELECT source_id FROM ${table}`);
  const unexpectedLegacyImports: string[] = [];
  for (const row of relRes.rows) {
    if (jsonSourceIds.has(String(row.source_id))) unexpectedLegacyImports.push(String(row.source_id));
  }

  const report: SectionReport = {
    collection: jsonKey, table, totalSourceRecords: list.length,
    match: 0, different: 0, missingInRelational: 0, extraInRelational: unexpectedLegacyImports.length,
    quarantined: 0,
    financialMismatches: [],
    details: {
      different: [], missingInRelational: [],
      extraInRelational: unexpectedLegacyImports.map((id) => ({ sourceId: id })),
      quarantined: [],
    },
    safeToCutOver: unexpectedLegacyImports.length === 0,
    reasons: [],
    legacyPolicyExcluded: true,
    legacySkippedByPolicy: list.length,
  };

  report.reasons.push(
    `LEGACY SECTION EXCLUDED BY MIGRATION POLICY — ${list.length} historical JSON ${jsonKey} record(s) are intentionally NOT migrated into ${table} (explicit, user-approved migration-policy decision — see backfill.ts's LEGACY_PURCHASE_ORDERS_SKIPPED_BY_POLICY classification). This is not a data-quality failure: the historical records remain fully preserved in platform_state and Full Backup V2 for forensic/recovery reference; they are simply never imported relationally. All future purchase orders are created exclusively through the new manual PO workflow.`
  );
  if (unexpectedLegacyImports.length > 0) {
    report.reasons.push(`UNEXPECTED: ${unexpectedLegacyImports.length} relational ${table} row(s) carry a source_id matching a historical JSON record — this should never happen under the current no-import policy and must be investigated before cutover.`);
  } else {
    report.reasons.push('No unexpected historical purchase-order imports found relationally — safe to cut over under the migration policy above.');
  }

  return report;
}

export async function runReconciliation(opts: { sourceFile?: string }): Promise<{ sections: SectionReport[]; overallSafe: boolean }> {
  let data: Record<string, any>;
  if (opts.sourceFile) {
    data = JSON.parse(fs.readFileSync(path.resolve(opts.sourceFile), 'utf8'));
  } else {
    const res = await pool.query('SELECT data FROM platform_state WHERE id = 1');
    data = res.rowCount ? res.rows[0].data || {} : {};
  }

  const sections: SectionReport[] = [];
  sections.push(await reconcileSimpleCollection('customers', 'rel_customers', arr(data.customers), 'companyName'));
  sections.push(await reconcileSimpleCollection('suppliers', 'rel_suppliers', arr(data.suppliers), 'name'));
  sections.push(await reconcileSimpleCollection('inventory', 'rel_inventory_items', arr(data.inventory), 'sku'));
  sections.push(await reconcileSimpleCollection('quickRates', 'rel_quick_rate_items', arr(data.quickRates), 'sku'));
  sections.push(await reconcileSimpleCollection('quotes', 'rel_quotes', arr(data.quotes), 'num'));
  sections.push(await reconcileSimpleCollection('jobs', 'rel_jobs', arr(data.jobs), 'num'));
  sections.push(await reconcileSimpleCollection('accInvoices', 'rel_invoices', arr(data.accInvoices), 'number'));
  sections.push(await reconcileSimpleCollection('creditNotes', 'rel_credit_notes', arr(data.creditNotes), 'number'));
  sections.push(await reconcileLegacyPolicySkippedCollection('purchaseOrders', 'rel_purchase_orders', arr(data.purchaseOrders)));
  sections.push(await reconcileSimpleCollection('employees', 'rel_employees', arr(data.employees), 'name'));
  sections.push(await reconcileSimpleCollection('leaveRequests', 'rel_leave_requests', arr(data.leaveRequests)));
  sections.push(await reconcileSimpleCollection('disciplinary', 'rel_disciplinary_records', arr(data.disciplinary)));

  // ── Financial reconciliation (quotes/jobs/invoices totals + payment sums) ──
  // Reported as extra detail on top of the structural MATCH/DIFFERENT
  // classification above — never used to recompute or overwrite anything.
  const quoteReport = sections.find((s) => s.collection === 'quotes')!;
  for (const q of arr(data.quotes)) {
    const relRow = await pool.query('SELECT subtotal, vat_amount, total FROM rel_quotes WHERE source_id = $1', [String(q.id)]);
    if (relRow.rowCount === 0) continue;
    const lines = arr(q.lines);
    const subtotal = lines.reduce((s: number, l: any) => s + num(l.subtotal), 0);
    const discAmt = subtotal * (num(q.discount) / 100);
    const setupFee = num(q.setupFee);
    const afterDisc = subtotal - discAmt + setupFee;
    const vat = afterDisc * 0.15;
    const total = afterDisc + vat;
    const rel = relRow.rows[0];
    if (!approxEqual(subtotal, num(rel.subtotal))) quoteReport.financialMismatches.push({ sourceId: String(q.id), field: 'subtotal', jsonValue: subtotal, relationalValue: num(rel.subtotal) });
    if (!approxEqual(vat, num(rel.vat_amount))) quoteReport.financialMismatches.push({ sourceId: String(q.id), field: 'vat_amount', jsonValue: vat, relationalValue: num(rel.vat_amount) });
    if (!approxEqual(total, num(rel.total))) quoteReport.financialMismatches.push({ sourceId: String(q.id), field: 'total', jsonValue: total, relationalValue: num(rel.total) });
  }

  const invoiceReport = sections.find((s) => s.collection === 'accInvoices')!;
  for (const inv of arr(data.accInvoices)) {
    const paidJson = arr(inv.payments).reduce((s: number, p: any) => s + num(p.amount), 0);
    const relPaid = await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS total FROM rel_payments p JOIN rel_invoices i ON i.id = p.owner_id AND p.owner_type='invoice' WHERE i.source_id = $1`,
      [String(inv.id)]
    );
    if (relPaid.rowCount && !approxEqual(paidJson, num(relPaid.rows[0].total))) {
      invoiceReport.financialMismatches.push({ sourceId: String(inv.id), field: 'payments_sum', jsonValue: paidJson, relationalValue: num(relPaid.rows[0].total) });
    }
  }

  const jobReport = sections.find((s) => s.collection === 'jobs')!;
  for (const job of arr(data.jobs)) {
    const paidJson = arr(job.payments).reduce((s: number, p: any) => s + num(p.amount), 0);
    const relPaid = await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS total FROM rel_payments p JOIN rel_jobs j ON j.id = p.owner_id AND p.owner_type='job' WHERE j.source_id = $1`,
      [String(job.id)]
    );
    if (relPaid.rowCount && !approxEqual(paidJson, num(relPaid.rows[0].total))) {
      jobReport.financialMismatches.push({ sourceId: String(job.id), field: 'payments_sum', jsonValue: paidJson, relationalValue: num(relPaid.rows[0].total) });
    }
  }

  // A financial mismatch also closes the safe-to-cutover gate for that
  // section, even if the structural MATCH/DIFFERENT check above didn't
  // catch it (it always should, since financial fields are derived from
  // the same legacy_data — this is a mechanical double-check, not a
  // separate independent source of truth).
  for (const s of sections) {
    if (s.financialMismatches.length > 0) {
      s.safeToCutOver = false;
      s.reasons.push(`${s.financialMismatches.length} financial figure(s) disagree between JSON and relational — see financialMismatches.`);
    }
  }

  const overallSafe = sections.every((s) => s.safeToCutOver);
  return { sections, overallSafe };
}

// ═══════════════════════════════════════════════════════════════════════
// POST-CUTOVER MODE — relational-internal integrity only. NEVER reads
// platform_state or any --source-file, and NEVER compares against
// legacy_data. See the "WHY THERE ARE NOW TWO MODES" note at the top of
// this file for the full rationale. Purely additive: does not change the
// return type, behavior, or byte-for-byte output of `runReconciliation`
// above, which every existing test and cutoverCli.ts's `enable` gate still
// calls unchanged.
// ═══════════════════════════════════════════════════════════════════════

export interface PostCutoverIntegrityReport {
  collection: string;
  table: string;
  cutOver: boolean;
  relationalRowCount: number;
  duplicateDocumentNumbers: Array<{ documentNumber: string; count: number }>;
  orphanedReferences: Array<{ id: string; issue: string }>;
  invariantViolations: Array<{ id: string; issue: string }>;
  integrityOk: boolean;
  reasons: string[];
}

export async function runPostCutoverIntegrityCheck(): Promise<{ sections: PostCutoverIntegrityReport[]; overallOk: boolean }> {
  const cutoverRes = await pool.query('SELECT section, enabled FROM relational_cutover');
  const cutoverBySection = new Map<string, boolean>();
  for (const row of cutoverRes.rows) cutoverBySection.set(row.section, row.enabled);

  // Document-number duplicate checks. Belt-and-suspenders: every table
  // below already carries a DB-level UNIQUE constraint on this exact
  // column (set), so a hit here means the constraint itself was somehow
  // bypassed (e.g. a manual psql UPDATE) — treat any hit as an emergency,
  // not routine drift.
  async function checkDocNumbers(collection: string, table: string, numberCol: string, partitionCols: string[] = []): Promise<PostCutoverIntegrityReport> {
    const countRes = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
    const report: PostCutoverIntegrityReport = {
      collection, table, cutOver: cutoverBySection.get(collection) === true,
      relationalRowCount: countRes.rows[0].n,
      duplicateDocumentNumbers: [], orphanedReferences: [], invariantViolations: [],
      integrityOk: true, reasons: [],
    };
    const groupCols = [numberCol, ...partitionCols].join(', ');
    const dupRes = await pool.query(
      `SELECT ${numberCol} AS doc_number, count(*)::int AS n FROM ${table} GROUP BY ${groupCols} HAVING count(*) > 1`
    );
    for (const row of dupRes.rows) {
      report.duplicateDocumentNumbers.push({ documentNumber: row.doc_number, count: row.n });
    }
    return report;
  }

  const sections: PostCutoverIntegrityReport[] = [];
  sections.push(await checkDocNumbers('quotes', 'rel_quotes', 'quote_number', ['company_code']));
  sections.push(await checkDocNumbers('jobs', 'rel_jobs', 'job_number'));
  sections.push(await checkDocNumbers('accInvoices', 'rel_invoices', 'invoice_number', ['company_code']));
  sections.push(await checkDocNumbers('purchaseOrders', 'rel_purchase_orders', 'po_number'));
  sections.push(await checkDocNumbers('creditNotes', 'rel_credit_notes', 'credit_number'));

  // Payments carry no document number of their own — still reported so the
  // owner-orphan check below (the one reference NOT enforced by a DB FK,
  // since owner_id is polymorphic across job/quote/invoice) has a home.
  const paymentsCountRes = await pool.query('SELECT count(*)::int AS n FROM rel_payments');
  const paymentsReport: PostCutoverIntegrityReport = {
    collection: 'payments', table: 'rel_payments', cutOver: cutoverBySection.get('payments') === true,
    relationalRowCount: paymentsCountRes.rows[0].n,
    duplicateDocumentNumbers: [], orphanedReferences: [], invariantViolations: [], integrityOk: true, reasons: [],
  };
  sections.push(paymentsReport);

  // ── Orphaned reference checks ──
  // Almost every FK in schema 007/008 is a REAL Postgres FOREIGN KEY
  // (rel_jobs.quote_id, rel_invoices.job_id/quote_id, rel_purchase_orders.
  // supplier_id/job_id/quote_id, rel_credit_notes.customer_id/supplier_id,
  // rel_quotes.converted_job_id, ...) — the database itself already makes
  // a dangling reference impossible there, so re-checking them here would
  // be pure theater. The ONE reference that is NOT a DB-level FK is
  // rel_payments.owner_id, which is polymorphic (owner_type decides which
  // table owner_id points into) and so cannot be declared as a real FK —
  // this is the genuine, non-redundant integrity check for this section.
  const orphanJobPayments = await pool.query(
    `SELECT p.id, p.owner_id FROM rel_payments p WHERE p.owner_type = 'job' AND NOT EXISTS (SELECT 1 FROM rel_jobs j WHERE j.id = p.owner_id)`
  );
  const orphanQuotePayments = await pool.query(
    `SELECT p.id, p.owner_id FROM rel_payments p WHERE p.owner_type = 'quote' AND NOT EXISTS (SELECT 1 FROM rel_quotes q WHERE q.id = p.owner_id)`
  );
  const orphanInvoicePayments = await pool.query(
    `SELECT p.id, p.owner_id FROM rel_payments p WHERE p.owner_type = 'invoice' AND NOT EXISTS (SELECT 1 FROM rel_invoices i WHERE i.id = p.owner_id)`
  );
  for (const row of orphanJobPayments.rows) paymentsReport.orphanedReferences.push({ id: String(row.id), issue: `owner_type=job owner_id=${row.owner_id} has no matching rel_jobs row` });
  for (const row of orphanQuotePayments.rows) paymentsReport.orphanedReferences.push({ id: String(row.id), issue: `owner_type=quote owner_id=${row.owner_id} has no matching rel_quotes row` });
  for (const row of orphanInvoicePayments.rows) paymentsReport.orphanedReferences.push({ id: String(row.id), issue: `owner_type=invoice owner_id=${row.owner_id} has no matching rel_invoices row` });

  // ── Financial self-consistency invariants ──
  // Recomputed strictly from THIS row's own current relational data
  // (its own rel_quote_line_items, right now) — never from JSON/legacy_data,
  // and never from a value that could itself be stale. A quote edited
  // relationally (line items changed via updateQuote/updateQuoteWithJobSync)
  // must still have subtotal/vat_amount/total that agree with its OWN
  // current lines — that's the whole point of this being a "post-cutover"
  // check instead of a JSON comparison.
  const quoteReport = sections.find((s) => s.collection === 'quotes')!;
  const quotesRes = await pool.query('SELECT id, source_id, setup_fee, discount_pct, subtotal, vat_amount, total FROM rel_quotes');
  for (const q of quotesRes.rows) {
    const linesRes = await pool.query('SELECT subtotal FROM rel_quote_line_items WHERE quote_id = $1', [q.id]);
    const subtotal = linesRes.rows.reduce((s: number, l: any) => s + num(l.subtotal), 0);
    const discAmt = subtotal * (num(q.discount_pct) / 100);
    const setupFee = num(q.setup_fee);
    const afterDisc = subtotal - discAmt + setupFee;
    const vat = afterDisc * 0.15;
    const total = afterDisc + vat;
    if (!approxEqual(subtotal, num(q.subtotal))) quoteReport.invariantViolations.push({ id: q.source_id, issue: `stored subtotal ${q.subtotal} != this quote's OWN current line items sum ${subtotal.toFixed(2)}` });
    if (!approxEqual(vat, num(q.vat_amount))) quoteReport.invariantViolations.push({ id: q.source_id, issue: `stored vat_amount ${q.vat_amount} != recomputed ${vat.toFixed(2)} from this quote's OWN current line items` });
    if (!approxEqual(total, num(q.total))) quoteReport.invariantViolations.push({ id: q.source_id, issue: `stored total ${q.total} != recomputed ${total.toFixed(2)} from this quote's OWN current line items` });
  }

  // Credit notes: used_amount can never exceed amount, regardless of what
  // JSON ever said.
  const creditReport = sections.find((s) => s.collection === 'creditNotes')!;
  const creditRes = await pool.query('SELECT source_id, amount, used_amount FROM rel_credit_notes');
  for (const cn of creditRes.rows) {
    if (num(cn.used_amount) > num(cn.amount) + 0.01) {
      creditReport.invariantViolations.push({ id: cn.source_id, issue: `used_amount ${cn.used_amount} exceeds amount ${cn.amount}` });
    }
  }

  // 2026-08-21 PURCHASE ORDER MIGRATION POLICY CHANGE — document counter
  // consistency for POs (the one genuinely non-redundant invariant this
  // section needs post-cutover; supplier_id/job_id/quote_id are real FKs
  // already enforced by the database — see the "Orphaned reference checks"
  // comment above). Every new PO number is reserved atomically from
  // document_number_counters (company='ALL', doc_type='po') — this checks
  // that counter never sits BEHIND the highest PO-##### number actually in
  // use relationally, which would mean a future reservation could collide
  // with (or fall behind) an already-issued number. This deliberately never
  // compares against the historical JSON purchaseOrders collection — that
  // dataset is excluded by policy and is not part of this counter's domain
  // once purchaseOrders is cut over (see reconcileLegacyPolicySkippedCollection
  // for the pre-cutover equivalent, which explains why the two datasets are
  // not expected to match at all).
  const poReport = sections.find((s) => s.collection === 'purchaseOrders')!;
  const poNumbersRes = await pool.query(`SELECT po_number FROM rel_purchase_orders`);
  let highestRelationalPoSuffix = 0;
  for (const row of poNumbersRes.rows) {
    const m = /^PO-(\d+)$/i.exec(String(row.po_number || '').trim());
    if (m) {
      const v = parseInt(m[1], 10);
      if (!isNaN(v) && v > highestRelationalPoSuffix) highestRelationalPoSuffix = v;
    }
  }
  const poCounterRes = await pool.query(
    `SELECT last_number FROM document_number_counters WHERE company = 'ALL' AND doc_type = 'po'`
  );
  const poCounterLastNumber = poCounterRes.rowCount ? num(poCounterRes.rows[0].last_number) : 0;
  if (poCounterLastNumber < highestRelationalPoSuffix) {
    poReport.invariantViolations.push({
      id: 'document_number_counters(ALL,po)',
      issue: `counter last_number=${poCounterLastNumber} is BEHIND the highest PO-##### number actually in use relationally (PO-${String(highestRelationalPoSuffix).padStart(5, '0')}) — the next reservation could collide with an already-issued number.`,
    });
  }

  for (const s of sections) {
    s.integrityOk = s.duplicateDocumentNumbers.length === 0 && s.orphanedReferences.length === 0 && s.invariantViolations.length === 0;
    if (s.duplicateDocumentNumbers.length) s.reasons.push(`${s.duplicateDocumentNumbers.length} duplicate document number group(s) found — the DB UNIQUE constraint should already prevent this; treat as an emergency, not routine drift.`);
    if (s.orphanedReferences.length) s.reasons.push(`${s.orphanedReferences.length} orphaned reference(s) found — a row points at an owner/parent that no longer exists.`);
    if (s.invariantViolations.length) s.reasons.push(`${s.invariantViolations.length} financial self-consistency invariant violation(s) found — computed strictly from this row's own current relational data, never compared against JSON.`);
    if (s.integrityOk) s.reasons.push('Relational data is internally consistent on its own terms — JSON/legacy_data was never consulted (see PRE-CUTOVER vs POST-CUTOVER note at top of file).');
  }

  const overallOk = sections.every((s) => s.integrityOk);
  return { sections, overallOk };
}

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const modeArg = args.find((a) => a.startsWith('--mode='));
    const mode = modeArg ? modeArg.slice('--mode='.length) : 'pre-cutover';

    if (mode === 'post-cutover') {
      console.log(`[reconcile] READ ONLY. Mode: post-cutover (relational-internal integrity only — JSON/legacy_data is NOT consulted).\n`);
      const { sections, overallOk } = await runPostCutoverIntegrityCheck();
      for (const s of sections) {
        console.log(`── ${s.collection} (${s.table}) ──────────────────────────`);
        console.log(`  cut over: ${s.cutOver ? 'YES' : 'no'}  relational rows: ${s.relationalRowCount}`);
        if (s.duplicateDocumentNumbers.length) {
          console.log(`  duplicate document numbers: ${s.duplicateDocumentNumbers.length}`);
          for (const d of s.duplicateDocumentNumbers) console.log(`    - ${d.documentNumber} (${d.count}x)`);
        }
        if (s.orphanedReferences.length) {
          console.log(`  orphaned references: ${s.orphanedReferences.length}`);
          for (const o of s.orphanedReferences) console.log(`    - id=${o.id}: ${o.issue}`);
        }
        if (s.invariantViolations.length) {
          console.log(`  invariant violations: ${s.invariantViolations.length}`);
          for (const v of s.invariantViolations) console.log(`    - id=${v.id}: ${v.issue}`);
        }
        console.log(`  INTEGRITY OK: ${s.integrityOk ? 'YES' : 'NO'}`);
        for (const r of s.reasons) console.log(`    - ${r}`);
        console.log('');
      }
      console.log(`════════════════════════════════════════`);
      console.log(`OVERALL: ${overallOk ? 'ALL SECTIONS INTERNALLY CONSISTENT' : 'SOME SECTIONS HAVE INTEGRITY ISSUES'}`);
      await pool.end();
      process.exit(overallOk ? 0 : 0); // read-only report — never a hard CI failure by itself
      return;
    }

    const sourceFileArg = args.find((a) => a.startsWith('--source-file='));
    const sourceFile = sourceFileArg ? sourceFileArg.slice('--source-file='.length) : undefined;

    console.log(`[reconcile] READ ONLY. Mode: pre-cutover. Source: ${sourceFile || 'live platform_state'}\n`);
    const { sections, overallSafe } = await runReconciliation({ sourceFile });
    for (const s of sections) {
      console.log(`── ${s.collection} (${s.table}) ──────────────────────────`);
      console.log(`  source records: ${s.totalSourceRecords}`);
      if (s.legacyPolicyExcluded) {
        console.log(`  LEGACY SECTION EXCLUDED BY MIGRATION POLICY — legacy skipped by policy: ${s.legacySkippedByPolicy}  unexpected conflicts: ${s.extraInRelational}`);
      }
      console.log(`  MATCH: ${s.match}  DIFFERENT: ${s.different}  MISSING_IN_RELATIONAL: ${s.missingInRelational}  EXTRA_IN_RELATIONAL: ${s.extraInRelational}  QUARANTINED: ${s.quarantined}`);
      if (s.financialMismatches.length) {
        console.log(`  financial mismatches: ${s.financialMismatches.length}`);
        for (const m of s.financialMismatches) console.log(`    - id=${m.sourceId} ${m.field}: json=${m.jsonValue} relational=${m.relationalValue}`);
      }
      console.log(`  SAFE TO CUT OVER: ${s.safeToCutOver ? 'YES' : 'NO'}`);
      for (const r of s.reasons) console.log(`    - ${r}`);
      console.log('');
    }
    console.log(`════════════════════════════════════════`);
    console.log(`OVERALL: ${overallSafe ? 'ALL SECTIONS SAFE TO CUT OVER' : 'NOT ALL SECTIONS ARE SAFE TO CUT OVER YET'}`);
    await pool.end();
    process.exit(0);
  })().catch(async (err) => {
    // reconcile.ts never writes anything in any mode — a connection
    // failure here just means the report never ran; nothing to roll back.
    console.error(describeConnectionError(err));
    console.error('[reconcile] Fatal error.', err);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
}
