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
 */
import fs from 'fs';
import path from 'path';
import pool from '../db/pool';

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
  sections.push(await reconcileSimpleCollection('purchaseOrders', 'rel_purchase_orders', arr(data.purchaseOrders), 'num'));
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

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const sourceFileArg = args.find((a) => a.startsWith('--source-file='));
    const sourceFile = sourceFileArg ? sourceFileArg.slice('--source-file='.length) : undefined;

    console.log(`[reconcile] READ ONLY. Source: ${sourceFile || 'live platform_state'}\n`);
    const { sections, overallSafe } = await runReconciliation({ sourceFile });
    for (const s of sections) {
      console.log(`── ${s.collection} (${s.table}) ──────────────────────────`);
      console.log(`  source records: ${s.totalSourceRecords}`);
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
  })();
}
