/**
 * JSON -> relational backfill tool.
 *
 * Reads platform_state.data (or, for local testing only, a JSON file passed
 * via --source-file) and derives rows for every rel_* table added in
 * database/migrations/007_relational_core.sql. NEVER writes to
 * platform_state or platform_state_backups — this is one-directional,
 * JSON -> relational, always.
 *
 * USAGE (run from backend/):
 *   npx ts-node --transpile-only src/relational/backfill.ts                 (dry run against live platform_state)
 *   npx ts-node --transpile-only src/relational/backfill.ts --source-file test/fixtures/sample-state.json   (dry run against a file — local testing)
 *   npx ts-node --transpile-only src/relational/backfill.ts --apply --confirm="I UNDERSTAND THIS WRITES TO THE RELATIONAL DATABASE"
 *
 * DRY RUN IS THE DEFAULT. Writing anything requires BOTH --apply AND the
 * exact --confirm phrase above; either alone is refused.
 *
 * SAFETY: refuses to run in apply mode unless DATABASE_URL points at
 * localhost/127.0.0.1, or ALLOW_UNSAFE_RELATIONAL_BACKFILL=1 is explicitly
 * set — mirrors the same guard backend/test/hardening.stress.ts uses, for
 * the same reason (this must never be pointed at a shared/production
 * database from a development machine by accident).
 *
 * DETERMINISM / IDEMPOTENCY / RESTARTABILITY:
 *   - Every row is upserted by its natural key (source_id, or a composite
 *     natural key for line items / payments that don't carry their own id —
 *     see database/migrations/007_relational_core.sql's column comments).
 *   - An upsert that would not actually change legacy_data is a genuine
 *     no-op (row_version/updated_at are only bumped when content actually
 *     differs) — running this twice against unchanged JSON writes zero rows
 *     the second time (proven by test/relational.backfill.test.ts).
 *   - The ENTIRE run (every collection) happens inside ONE database
 *     transaction, which is only ever COMMITted at the very end in --apply
 *     mode (dry run always ROLLBACKs, guaranteeing zero writes). This means
 *     "restart after interruption" is trivial: a transaction that never
 *     committed left nothing behind, so simply running the tool again from
 *     scratch is always safe and always converges to the same end state —
 *     there is no partial-apply state to reconcile.
 *   - Legacy collisions (duplicate source ids the migration brief says must
 *     never be silently resolved — known cases: customers, quickRates) do
 *     NOT abort the run. That specific id group is skipped (quarantined,
 *     logged to relational_legacy_conflicts) and every other, unrelated
 *     record in that same collection is still imported and committed.
 *   - Genuinely unexpected errors (a bug, a constraint this tool didn't
 *     anticipate) DO abort the whole run via ROLLBACK — nothing partial is
 *     ever left committed from an error case, only from the deliberate
 *     quarantine mechanism above.
 */
import fs from 'fs';
import path from 'path';
import pool from '../db/pool';
import { PoolClient } from 'pg';
import { describeConnectionError } from '../db/ssl';

const CONFIRM_PHRASE = 'I UNDERSTAND THIS WRITES TO THE RELATIONAL DATABASE';

function arr(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
function num(v: unknown, fallback = 0): number {
  const n = parseFloat(v as any);
  return isNaN(n) ? fallback : n;
}
function dateOrNull(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// Key-sorted, recursive stringify — PostgreSQL's jsonb type does NOT
// preserve object key order (confirmed empirically: a round-tripped jsonb
// value comes back with keys in a different order than they were inserted
// with), so a plain JSON.stringify(a) === JSON.stringify(b) comparison
// between "what's already stored" and "what we're about to write" would
// treat every single row as changed on every re-run, even when the
// underlying data is byte-for-byte identical. Same technique (and same
// rationale) as backend/src/routes/platformState.ts's own stableStringify.
function stableStringify(v: any): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

interface Summary {
  [collection: string]: {
    seen: number;
    inserted: number;
    updated: number;
    unchanged: number;
    quarantined: number;
    unresolvedCustomer?: number;
    unresolvedSupplier?: number;
    // 2026-08-21 PURCHASE ORDER MIGRATION POLICY CHANGE: purchaseOrders is
    // the one collection that is deliberately NEVER imported at all (see
    // PASS 6 below) — these three fields make that an explicit, reported
    // migration decision rather than a silent zero. `legacySkippedByPolicy`
    // is the count of historical JSON purchaseOrders records intentionally
    // left out of rel_purchase_orders. `unexpectedConflicts` stays 0 under
    // normal operation (nothing is ever attempted against
    // rel_purchase_orders for legacy rows, so there is nothing left to
    // conflict) — it exists so a genuine future bug that DID attempt an
    // import would show up as non-zero instead of being masked by this
    // field's absence. `policy` names the deterministic classification for
    // any tooling/report that reads this summary programmatically.
    legacySkippedByPolicy?: number;
    unexpectedConflicts?: number;
    policy?: string;
  };
}

interface ConflictRow {
  collection: string;
  source_id: string | null;
  document_number: string | null;
  conflict_type: string;
  detail: any;
}

function bump(summary: Summary, key: string) {
  if (!summary[key]) summary[key] = { seen: 0, inserted: 0, updated: 0, unchanged: 0, quarantined: 0 };
  return summary[key];
}

// Groups records by (stringified) id; returns [cleanRecords, duplicateGroups]
function splitDuplicateIds(list: any[]): { clean: any[]; duplicateGroups: Map<string, any[]> } {
  const groups = new Map<string, any[]>();
  for (const rec of list) {
    if (!rec || rec.id === undefined || rec.id === null) continue;
    const id = String(rec.id);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id)!.push(rec);
  }
  const duplicateGroups = new Map<string, any[]>();
  const dupIds = new Set<string>();
  for (const [id, recs] of groups) {
    if (recs.length > 1) { duplicateGroups.set(id, recs); dupIds.add(id); }
  }
  const clean = list.filter((rec) => rec && rec.id !== undefined && rec.id !== null && !dupIds.has(String(rec.id)));
  return { clean, duplicateGroups };
}

// Upsert-by-natural-key helper used by every collection below: checks
// existence + legacy_data equality FIRST (read), then insert / genuine
// update / no-op. row_version and updated_at are ONLY bumped when the
// stored legacy_data actually differs from what's being written — this is
// what makes a second run against unchanged JSON a true no-op (proven by
// test/relational.backfill.test.ts), not just "no error".
async function upsertRow(
  client: PoolClient,
  table: string,
  conflictCols: string[],
  columns: Record<string, any>,
  legacyData: any
): Promise<'inserted' | 'updated' | 'unchanged'> {
  const whereCols = conflictCols.map((c, i) => `${c} = $${i + 1}`).join(' AND ');
  const existing = await client.query(
    `SELECT id, legacy_data FROM ${table} WHERE ${whereCols}`,
    conflictCols.map((c) => columns[c])
  );

  const cols = Object.keys(columns);
  const legacyJson = JSON.stringify(legacyData);

  if (existing.rowCount === 0) {
    const allCols = [...cols, 'legacy_data'];
    const vals = [...cols.map((c) => columns[c]), legacyJson];
    const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
    await client.query(`INSERT INTO ${table} (${allCols.join(', ')}) VALUES (${placeholders})`, vals);
    return 'inserted';
  }

  const existingLegacy = existing.rows[0].legacy_data;
  const changed = stableStringify(existingLegacy) !== stableStringify(legacyData);
  const id = existing.rows[0].id;

  if (!changed) {
    // Derived columns are a pure function of legacyData — identical JSON
    // means identical columns, nothing to write. CAVEAT (Stage 3, migration
    // 008): this assumes the derivation logic itself hasn't changed since a
    // row was last written. A row backfilled by an OLDER version of this
    // file (e.g. before the unit/breakdown/address/vat_number columns
    // existed) will keep this "unchanged" shortcut forever against
    // unmodified JSON, even though re-running the (now newer) derivation
    // would populate those columns for the first time. Never an issue for
    // this repo's own tests (they always TRUNCATE the rel_* tables before
    // backfilling) or for a genuine first-ever production backfill (there
    // is no prior row to compare against, so the INSERT branch above runs
    // instead) — only a local-dev nuance if backfill was run once under
    // old code and once under new code against the same unchanged JSON.
    return 'unchanged';
  }

  const vals = cols.map((c) => columns[c]);
  const setCols = cols.map((c, i) => `${c} = $${i + 1}`);
  vals.push(legacyJson);
  const legacyIdx = vals.length;
  vals.push(id);
  const idIdx = vals.length;
  await client.query(
    `UPDATE ${table} SET ${setCols.join(', ')}, legacy_data = $${legacyIdx}, row_version = row_version + 1, updated_at = NOW() WHERE id = $${idIdx}`,
    vals
  );
  return 'updated';
}

export async function runBackfill(opts: { apply: boolean; sourceFile?: string; runByNote?: string }): Promise<{ ok: boolean; summary: Summary; conflicts: ConflictRow[]; runId: number | null }> {
  const client = await pool.connect();
  const summary: Summary = {};
  const conflicts: ConflictRow[] = [];
  let runId: number | null = null;

  try {
    await client.query('BEGIN');

    // ── Load source data ────────────────────────────────────────────────
    let data: Record<string, any>;
    let sourceLabel: string;
    if (opts.sourceFile) {
      const full = path.resolve(opts.sourceFile);
      data = JSON.parse(fs.readFileSync(full, 'utf8'));
      sourceLabel = full;
    } else {
      const res = await client.query('SELECT data FROM platform_state WHERE id = 1');
      data = res.rowCount ? res.rows[0].data || {} : {};
      sourceLabel = 'platform_state';
    }

    const runRes = await client.query(
      `INSERT INTO relational_backfill_runs (mode, source) VALUES ($1, $2) RETURNING id`,
      [opts.apply ? 'apply' : 'dry_run', sourceLabel]
    );
    runId = runRes.rows[0].id;

    function recordConflict(c: ConflictRow) {
      conflicts.push(c);
    }

    // Lookup maps built as we go, source_id -> relational id, used to
    // resolve cross-references in later passes.
    const customerIdBySourceId = new Map<string, number>();
    const customerIdByName = new Map<string, number>(); // normalized name -> id, only when name is unique
    const supplierIdBySourceId = new Map<string, number>();
    const inventoryIdBySourceId = new Map<string, number>();
    const quoteIdBySourceId = new Map<string, number>();
    const quoteNumberToId = new Map<string, number>(); // `${co}::${num}` -> id
    const jobIdBySourceId = new Map<string, number>();
    const jobNumberToId = new Map<string, number>();
    const invoiceIdBySourceId = new Map<string, number>();

    function normName(s: string | null): string {
      return (s || '').trim().toLowerCase();
    }

    // ══════════════════════════════════════════════════════════════════
    // PASS 1 — independent entities: customers, suppliers, inventory,
    // quickRates. Duplicate source ids are quarantined (whole group
    // skipped), never guessed at.
    // ══════════════════════════════════════════════════════════════════

    // -- customers --
    {
      const s = bump(summary, 'customers');
      const list = arr(data.customers);
      s.seen = list.length;
      const { clean, duplicateGroups } = splitDuplicateIds(list);
      for (const [id, recs] of duplicateGroups) {
        s.quarantined += recs.length;
        recordConflict({
          collection: 'customers', source_id: id, document_number: null,
          conflict_type: 'duplicate_source_id',
          detail: { count: recs.length, companyNames: recs.map((r) => r.companyName) },
        });
      }
      for (const rec of clean) {
        const sourceId = String(rec.id);
        const columns = {
          source_id: sourceId,
          company_name: str(rec.companyName) || '(unnamed)',
          contact_person: str(rec.contactPerson),
          email: str(rec.email),
          phone: str(rec.tel),
          address: str(rec.address),
          vat_number: str(rec.vatNumber),
          notes: str(rec.notes),
        };
        const outcome = await upsertRow(client, 'rel_customers', ['source_id'], columns, rec);
        s[outcome]++;
        const row = await client.query('SELECT id FROM rel_customers WHERE source_id = $1', [sourceId]);
        const relId = row.rows[0].id;
        customerIdBySourceId.set(sourceId, relId);
        const nm = normName(columns.company_name);
        if (nm) {
          if (customerIdByName.has(nm) && customerIdByName.get(nm) !== relId) {
            customerIdByName.set(nm, -1); // ambiguous — more than one customer shares this name; never guess
          } else if (!customerIdByName.has(nm)) {
            customerIdByName.set(nm, relId);
          }
        }
      }
    }

    // -- suppliers --
    {
      const s = bump(summary, 'suppliers');
      const list = arr(data.suppliers);
      s.seen = list.length;
      const { clean, duplicateGroups } = splitDuplicateIds(list);
      for (const [id, recs] of duplicateGroups) {
        s.quarantined += recs.length;
        recordConflict({ collection: 'suppliers', source_id: id, document_number: null, conflict_type: 'duplicate_source_id', detail: { count: recs.length } });
      }
      for (const rec of clean) {
        const sourceId = String(rec.id);
        const columns = {
          source_id: sourceId,
          name: str(rec.name) || '(unnamed)',
          contact_person: str(rec.contactPerson),
          phone: str(rec.phone),
          email: str(rec.email),
          address: str(rec.address), // migration 008 — AddEditSupplierModal's real field
          city: str(rec.city),
          postal_code: str(rec.postalCode),
          vat_number: str(rec.vatNumber), // migration 008 — AddEditSupplierModal's real field
          payment_terms: str(rec.paymentTerms),
          account_number: str(rec.accountNumber),
          notes: str(rec.notes),
        };
        const outcome = await upsertRow(client, 'rel_suppliers', ['source_id'], columns, rec);
        s[outcome]++;
        const row = await client.query('SELECT id FROM rel_suppliers WHERE source_id = $1', [sourceId]);
        supplierIdBySourceId.set(sourceId, row.rows[0].id);
      }
    }

    // -- inventory + quickRates (same shape, two tables) --
    for (const [jsonKey, table, mapRef] of [
      ['inventory', 'rel_inventory_items', inventoryIdBySourceId] as const,
      ['quickRates', 'rel_quick_rate_items', new Map<string, number>()] as const,
    ]) {
      const s = bump(summary, jsonKey);
      const list = arr((data as any)[jsonKey]);
      s.seen = list.length;
      const { clean, duplicateGroups } = splitDuplicateIds(list);
      for (const [id, recs] of duplicateGroups) {
        s.quarantined += recs.length;
        recordConflict({ collection: jsonKey, source_id: id, document_number: null, conflict_type: 'duplicate_source_id', detail: { count: recs.length, names: recs.map((r: any) => r.name) } });
      }
      for (const rec of clean) {
        const sourceId = String(rec.id);
        const supplierSourceId = rec.supplierId !== undefined && rec.supplierId !== null ? String(rec.supplierId) : null;
        const supplierId = supplierSourceId ? supplierIdBySourceId.get(supplierSourceId) || null : null;
        if (supplierSourceId && !supplierId) {
          s.unresolvedSupplier = (s.unresolvedSupplier || 0) + 1;
        }
        const columns = {
          source_id: sourceId,
          sku: str(rec.sku),
          name: str(rec.name) || '(unnamed)',
          category: str(rec.cat),
          unit: str(rec.unit),
          cost: num(rec.cost),
          sell: num(rec.sell),
          stock_qty: num(rec.stock),
          reorder_level: num(rec.reorder),
          supplier_id: supplierId,
          supplier_source_id: supplierSourceId,
        };
        const outcome = await upsertRow(client, table, ['source_id'], columns, rec);
        s[outcome]++;
        const row = await client.query(`SELECT id FROM ${table} WHERE source_id = $1`, [sourceId]);
        mapRef.set(sourceId, row.rows[0].id);
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // PASS 2 — quotes (+ line items). Customer linkage is best-effort by
    // exact-normalized-name match only; never guessed when ambiguous.
    // ══════════════════════════════════════════════════════════════════
    {
      const s = bump(summary, 'quotes');
      const list = arr(data.quotes);
      s.seen = list.length;
      const { clean, duplicateGroups } = splitDuplicateIds(list);
      for (const [id, recs] of duplicateGroups) {
        s.quarantined += recs.length;
        recordConflict({ collection: 'quotes', source_id: id, document_number: null, conflict_type: 'duplicate_source_id', detail: { count: recs.length, nums: recs.map((r: any) => r.num) } });
      }
      // Also quarantine any group sharing the same (co, num) — the JSON's
      // own invariant (see backend/src/routes/platformState.ts
      // NUMBER_CHECK_SECTIONS) says this should never happen for NEW
      // records, but historical data is not re-litigated here; if it does,
      // this table's UNIQUE(company_code, quote_number) would reject the
      // second one anyway, so detect and quarantine proactively instead of
      // letting the INSERT throw.
      const byCoNum = new Map<string, any[]>();
      for (const rec of clean) {
        const co = str(rec.co);
        const num_ = str(rec.num);
        if (!co || !num_) continue;
        const k = `${co}::${num_.toUpperCase()}`;
        if (!byCoNum.has(k)) byCoNum.set(k, []);
        byCoNum.get(k)!.push(rec);
      }
      const skipIds = new Set<string>();
      for (const [k, recs] of byCoNum) {
        if (recs.length > 1) {
          for (const r of recs) skipIds.add(String(r.id));
          s.quarantined += recs.length;
          recordConflict({ collection: 'quotes', source_id: null, document_number: k, conflict_type: 'duplicate_document_number', detail: { count: recs.length, ids: recs.map((r) => r.id) } });
        }
      }

      for (const rec of clean) {
        const sourceId = String(rec.id);
        if (skipIds.has(sourceId)) continue;
        const co = str(rec.co);
        const num_ = str(rec.num);
        if (!co || !num_) {
          s.quarantined++;
          recordConflict({ collection: 'quotes', source_id: sourceId, document_number: num_, conflict_type: 'missing_required_field', detail: { co, num: num_ } });
          continue;
        }
        const clientName = str(rec.client);
        const nm = normName(clientName);
        const custId = nm && customerIdByName.get(nm) && customerIdByName.get(nm)! > 0 ? customerIdByName.get(nm)! : null;

        const lines = arr(rec.lines);
        const subtotal = lines.reduce((sum: number, l: any) => sum + num(l.subtotal), 0);
        const discountPct = num(rec.discount);
        const discAmt = subtotal * (discountPct / 100);
        const setupFee = num(rec.setupFee);
        const afterDisc = subtotal - discAmt + setupFee;
        const vatAmount = afterDisc * 0.15;
        const total = afterDisc + vatAmount;

        const columns = {
          source_id: sourceId,
          quote_number: num_,
          company_code: co,
          customer_id: custId,
          customer_name_raw: clientName,
          contact_person: str(rec.contact),
          email: str(rec.email),
          phone: str(rec.tel),
          address: str(rec.address),
          vat_number: str(rec.vatNum),
          status: str(rec.status),
          notes: str(rec.notes),
          terms: str(rec.terms),
          salesperson: str(rec.salesperson),
          prepared_by: str(rec.preparedBy),
          po_ref: str(rec.poRef),
          reference: str(rec.reference),
          setup_fee: setupFee,
          discount_pct: discountPct,
          subtotal,
          vat_amount: vatAmount,
          total,
          proforma_num: str(rec.proformaNum),
          converted_job_source_id: rec.convertedJobId !== undefined && rec.convertedJobId !== null ? String(rec.convertedJobId) : null,
        };
        const outcome = await upsertRow(client, 'rel_quotes', ['source_id'], columns, rec);
        s[outcome]++;
        const row = await client.query('SELECT id FROM rel_quotes WHERE source_id = $1', [sourceId]);
        const relId = row.rows[0].id;
        quoteIdBySourceId.set(sourceId, relId);
        quoteNumberToId.set(`${co}::${num_.toUpperCase()}`, relId);

        // line items — natural key is (quote_id, line_index); full
        // replace-in-place per quote, per line, upserted the same way.
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i];
          const invSourceId = l.itemId !== undefined && l.itemId !== null ? String(l.itemId) : null;
          const invId = invSourceId ? inventoryIdBySourceId.get(invSourceId) || null : null;
          await upsertRow(
            client, 'rel_quote_line_items', ['quote_id', 'line_index'],
            {
              quote_id: relId, line_index: i, description: str(l.desc),
              qty: num(l.qty, 1), unit_price: num(l.unitPrice), subtotal: num(l.subtotal),
              unit: str(l.unit), // migration 008 — quote line-item editor's real field
              inventory_item_id: invId, inventory_source_id: invSourceId,
            },
            l
          );
        }

        // payments embedded on the quote (deposits recorded pre-invoice)
        const payments = arr(rec.payments);
        for (let i = 0; i < payments.length; i++) {
          const p = payments[i];
          await upsertRow(
            client, 'rel_payments', ['owner_type', 'owner_id', 'line_index'],
            {
              owner_type: 'quote', owner_id: relId, line_index: i,
              amount: num(p.amount), payment_date: dateOrNull(p.date),
              method: str(p.method), reference: str(p.reference), notes: str(p.notes),
            },
            p
          );
        }
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // PASS 3 — jobs (+ line items + embedded payments)
    // ══════════════════════════════════════════════════════════════════
    {
      const s = bump(summary, 'jobs');
      const list = arr(data.jobs);
      s.seen = list.length;
      const { clean, duplicateGroups } = splitDuplicateIds(list);
      for (const [id, recs] of duplicateGroups) {
        s.quarantined += recs.length;
        recordConflict({ collection: 'jobs', source_id: id, document_number: null, conflict_type: 'duplicate_source_id', detail: { count: recs.length, nums: recs.map((r: any) => r.num) } });
      }
      const byNum = new Map<string, any[]>();
      for (const rec of clean) {
        const num_ = str(rec.num);
        if (!num_) continue;
        const k = num_.toUpperCase();
        if (!byNum.has(k)) byNum.set(k, []);
        byNum.get(k)!.push(rec);
      }
      const skipIds = new Set<string>();
      for (const [k, recs] of byNum) {
        if (recs.length > 1) {
          for (const r of recs) skipIds.add(String(r.id));
          s.quarantined += recs.length;
          recordConflict({ collection: 'jobs', source_id: null, document_number: k, conflict_type: 'duplicate_document_number', detail: { count: recs.length, ids: recs.map((r) => r.id) } });
        }
      }

      for (const rec of clean) {
        const sourceId = String(rec.id);
        if (skipIds.has(sourceId)) continue;
        const num_ = str(rec.num);
        const co = str(rec.co);
        if (!num_ || !co) {
          s.quarantined++;
          recordConflict({ collection: 'jobs', source_id: sourceId, document_number: num_, conflict_type: 'missing_required_field', detail: { co, num: num_ } });
          continue;
        }
        const clientName = str(rec.client);
        const nm = normName(clientName);
        const custId = nm && customerIdByName.get(nm) && customerIdByName.get(nm)! > 0 ? customerIdByName.get(nm)! : null;

        const quoteNumRaw = str(rec.quoteNum);
        const quoteRelId = quoteNumRaw ? quoteNumberToId.get(`${co}::${quoteNumRaw.toUpperCase()}`) || null : null;

        // migration 008 — JobDetail's saveCosts() always writes a fixed
        // 9-key object (materials/labour/machine_time/design/delivery/
        // franchise_royalty/subcontracting/printing/other) onto
        // job.breakdown; the live fixture also shows plain `null` for jobs
        // that have never had costs entered — normalize both cases to a
        // real JSON object so rel_jobs.breakdown (NOT NULL DEFAULT '{}')
        // always holds a valid, whole-object value, never a bare JSON null.
        const breakdown = rec.breakdown && typeof rec.breakdown === 'object' ? rec.breakdown : {};

        const columns = {
          source_id: sourceId,
          job_number: num_,
          company_code: co,
          customer_id: custId,
          customer_name_raw: clientName,
          contact_person: str(rec.contact),
          email: str(rec.email),
          phone: str(rec.tel),
          address: str(rec.address),
          vat_number: str(rec.vatNum),
          description: str(rec.desc),
          status: str(rec.status),
          stage: typeof rec.stage === 'number' ? rec.stage : null,
          value: num(rec.value),
          quote_id: quoteRelId,
          quote_number_raw: quoteNumRaw,
          invoice_num: str(rec.invoiceNum),
          invoice_date: dateOrNull(rec.invoiceDate),
          invoice_due: dateOrNull(rec.invoiceDue),
          invoice_created: rec.invoiceCreated === true,
          invoice_status: str(rec.invoiceStatus),
          setup_fee: num(rec.setupFee),
          discount_pct: num(rec.discount),
          salesperson: str(rec.salesperson),
          prepared_by: str(rec.preparedBy),
          po_ref: str(rec.poRef),
          reference: str(rec.reference),
          notes: str(rec.notes),
          breakdown: JSON.stringify(breakdown), // migration 008 — jsonb column, same untyped-parameter convention already used for legacy_data
        };
        const outcome = await upsertRow(client, 'rel_jobs', ['source_id'], columns, rec);
        s[outcome]++;
        const row = await client.query('SELECT id FROM rel_jobs WHERE source_id = $1', [sourceId]);
        const relId = row.rows[0].id;
        jobIdBySourceId.set(sourceId, relId);
        jobNumberToId.set(num_.toUpperCase(), relId);

        const lines = arr(rec.lines);
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i];
          const invSourceId = l.itemId !== undefined && l.itemId !== null ? String(l.itemId) : null;
          const invId = invSourceId ? inventoryIdBySourceId.get(invSourceId) || null : null;
          await upsertRow(
            client, 'rel_job_line_items', ['job_id', 'line_index'],
            {
              job_id: relId, line_index: i, description: str(l.desc),
              qty: num(l.qty, 1), unit_price: num(l.unitPrice), subtotal: num(l.subtotal),
              unit: str(l.unit), // migration 008 — job line-item editor's real field
              inventory_item_id: invId, inventory_source_id: invSourceId,
            },
            l
          );
        }

        const payments = arr(rec.payments);
        for (let i = 0; i < payments.length; i++) {
          const p = payments[i];
          await upsertRow(
            client, 'rel_payments', ['owner_type', 'owner_id', 'line_index'],
            {
              owner_type: 'job', owner_id: relId, line_index: i,
              amount: num(p.amount), payment_date: dateOrNull(p.date),
              method: str(p.method), reference: str(p.reference), notes: str(p.notes),
            },
            p
          );
        }
      }

      // Second pass: now that all jobs exist, backfill quotes.converted_job_id
      // from quotes.converted_job_source_id (deferred — jobs didn't exist yet
      // during PASS 2).
      const quoteRows = await client.query('SELECT id, converted_job_source_id FROM rel_quotes WHERE converted_job_source_id IS NOT NULL');
      for (const qr of quoteRows.rows) {
        const jobRelId = jobIdBySourceId.get(String(qr.converted_job_source_id));
        if (jobRelId) {
          await client.query('UPDATE rel_quotes SET converted_job_id = $1 WHERE id = $2 AND (converted_job_id IS DISTINCT FROM $1)', [jobRelId, qr.id]);
        }
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // PASS 4 — invoices (accInvoices) + line items + embedded payments
    // ══════════════════════════════════════════════════════════════════
    {
      const s = bump(summary, 'accInvoices');
      const list = arr(data.accInvoices);
      s.seen = list.length;
      const { clean, duplicateGroups } = splitDuplicateIds(list);
      for (const [id, recs] of duplicateGroups) {
        s.quarantined += recs.length;
        recordConflict({ collection: 'accInvoices', source_id: id, document_number: null, conflict_type: 'duplicate_source_id', detail: { count: recs.length } });
      }
      const byCoNum = new Map<string, any[]>();
      for (const rec of clean) {
        const co = str(rec.co);
        const number = str(rec.number);
        if (!co || !number) continue;
        const k = `${co}::${number.toUpperCase()}`;
        if (!byCoNum.has(k)) byCoNum.set(k, []);
        byCoNum.get(k)!.push(rec);
      }
      const skipIds = new Set<string>();
      for (const [k, recs] of byCoNum) {
        if (recs.length > 1) {
          for (const r of recs) skipIds.add(String(r.id));
          s.quarantined += recs.length;
          recordConflict({ collection: 'accInvoices', source_id: null, document_number: k, conflict_type: 'duplicate_document_number', detail: { count: recs.length, ids: recs.map((r) => r.id) } });
        }
      }

      for (const rec of clean) {
        const sourceId = String(rec.id);
        if (skipIds.has(sourceId)) continue;
        const co = str(rec.co);
        const number = str(rec.number);
        if (!co || !number) {
          s.quarantined++;
          recordConflict({ collection: 'accInvoices', source_id: sourceId, document_number: number, conflict_type: 'missing_required_field', detail: { co, number } });
          continue;
        }
        const nm = normName(str(rec.contactName));
        const custId = nm && customerIdByName.get(nm) && customerIdByName.get(nm)! > 0 ? customerIdByName.get(nm)! : null;
        const jobSourceId = rec.jobId !== undefined && rec.jobId !== null ? String(rec.jobId) : null;
        const jobRelId = jobSourceId ? jobIdBySourceId.get(jobSourceId) || null : null;
        const quoteSourceId = rec.quoteId !== undefined && rec.quoteId !== null ? String(rec.quoteId) : null;
        const quoteRelId = quoteSourceId ? quoteIdBySourceId.get(quoteSourceId) || null : null;

        const columns = {
          source_id: sourceId,
          invoice_number: number,
          company_code: co,
          customer_id: custId,
          contact_name: str(rec.contactName),
          contact_email: str(rec.contactEmail),
          contact_address: str(rec.contactAddress),
          job_id: jobRelId,
          job_number_raw: str(rec.jobNum),
          quote_id: quoteRelId,
          quote_number_raw: str(rec.quoteNum),
          reference: str(rec.reference),
          status: str(rec.status),
          issue_date: dateOrNull(rec.date),
          due_date: dateOrNull(rec.dueDate),
        };
        const outcome = await upsertRow(client, 'rel_invoices', ['source_id'], columns, rec);
        s[outcome]++;
        const row = await client.query('SELECT id FROM rel_invoices WHERE source_id = $1', [sourceId]);
        const relId = row.rows[0].id;
        invoiceIdBySourceId.set(sourceId, relId);

        const lineItems = arr(rec.lineItems);
        for (let i = 0; i < lineItems.length; i++) {
          const l = lineItems[i];
          await upsertRow(
            client, 'rel_invoice_line_items', ['invoice_id', 'line_index'],
            {
              invoice_id: relId, line_index: i, description: str(l.description),
              qty: num(l.qty, 1), unit_amount: num(l.unitAmount),
              account_code: str(l.accountCode), tax_type: str(l.taxType),
            },
            l
          );
        }

        const payments = arr(rec.payments);
        for (let i = 0; i < payments.length; i++) {
          const p = payments[i];
          await upsertRow(
            client, 'rel_payments', ['owner_type', 'owner_id', 'line_index'],
            {
              owner_type: 'invoice', owner_id: relId, line_index: i,
              amount: num(p.amount), payment_date: dateOrNull(p.date),
              method: str(p.method), reference: str(p.reference), notes: str(p.notes),
            },
            p
          );
        }
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // PASS 5 — credit notes
    // ══════════════════════════════════════════════════════════════════
    {
      const s = bump(summary, 'creditNotes');
      const list = arr(data.creditNotes);
      s.seen = list.length;
      const { clean, duplicateGroups } = splitDuplicateIds(list);
      for (const [id, recs] of duplicateGroups) {
        s.quarantined += recs.length;
        recordConflict({ collection: 'creditNotes', source_id: id, document_number: null, conflict_type: 'duplicate_source_id', detail: { count: recs.length } });
      }
      for (const rec of clean) {
        const sourceId = String(rec.id);
        const type = rec.type === 'supplier' ? 'supplier' : 'customer';
        const nm = normName(str(rec.contactName));
        const custId = type === 'customer' && nm && customerIdByName.get(nm) && customerIdByName.get(nm)! > 0 ? customerIdByName.get(nm)! : null;
        // supplier name matching would need a name->id map; suppliers are
        // keyed by id not name in this app's own contactName datalist, so
        // best-effort supplier match is skipped here rather than guessed —
        // supplier_id stays null, contact_name_raw always preserved.
        const columns = {
          source_id: sourceId,
          credit_number: str(rec.number) || `(no-number-${sourceId})`,
          note_type: type,
          contact_name_raw: str(rec.contactName) || '',
          customer_id: custId,
          supplier_id: null,
          note_date: dateOrNull(rec.date),
          amount: num(rec.amount),
          used_amount: num(rec.used),
          reason: str(rec.reason),
          applied_to: str(rec.appliedTo),
          notes: str(rec.notes),
          status: str(rec.status),
        };
        const outcome = await upsertRow(client, 'rel_credit_notes', ['source_id'], columns, rec);
        s[outcome]++;
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // PASS 6 — purchase orders: LEGACY_PURCHASE_ORDERS_SKIPPED_BY_POLICY
    // ══════════════════════════════════════════════════════════════════
    // 2026-08-21 PURCHASE ORDER MIGRATION POLICY CHANGE: this pass used to
    // attempt a real upsert of every historical JSON purchaseOrders record
    // into rel_purchase_orders/rel_purchase_order_items, quarantining any
    // record sharing a duplicate source id or document number (the old JSON
    // purchaseOrders collection has large groups of 7-8 records sharing the
    // SAME po number — e.g. PO-00085/PO-00084/PO-00083 — a genuine
    // historical data-quality problem, not something this tool invented).
    // That produced hundreds of unexplained-looking "quarantined" entries
    // (637 of 640 on the real production dataset) for data nobody actually
    // needs relationally.
    //
    // A deliberate BUSINESS/MIGRATION POLICY DECISION has been made: the
    // historical purchaseOrders collection is NOT migrated into the
    // relational purchase-order system at all. Purchase orders going
    // forward are created exclusively through the new manual PO workflow
    // (services.ts's createPurchaseOrder, called from the frontend's
    // "Create Purchase Order" action) — never backfilled from JSON. This is
    // NOT a cleanup hack for the duplicate-number problem; even a single
    // clean historical PO record would still be excluded under this policy,
    // because the decision is "start the relational PO system from a clean
    // future-facing baseline", not "repair what backfill can't cleanly
    // import".
    //
    // What this pass does NOT do:
    //   - it never calls upsertRow against rel_purchase_orders or
    //     rel_purchase_order_items for ANY historical record — zero writes,
    //     every single run, deterministically;
    //   - it never reads/modifies platform_state.purchaseOrders (the source
    //     JSON array is left completely untouched — see runBackfill's
    //     header comment: this tool is one-directional JSON -> relational
    //     and NEVER writes back to platform_state regardless);
    //   - it never reports these 640 records as "quarantined" (a
    //     conflict/failure classification) — they are reported as
    //     `legacySkippedByPolicy`, a deliberate, expected, and fully
    //     explained classification, distinct from a genuine data problem.
    //
    // Idempotent by construction: since nothing is ever written, running
    // this twice (or a thousand times) always reports the exact same
    // seen/legacySkippedByPolicy/unexpectedConflicts numbers and creates
    // zero relational rows every time — there is no state to converge.
    {
      const s = bump(summary, 'purchaseOrders');
      const list = arr(data.purchaseOrders);
      s.seen = list.length;
      s.legacySkippedByPolicy = list.length;
      s.unexpectedConflicts = 0;
      s.policy = 'LEGACY_PURCHASE_ORDERS_SKIPPED_BY_POLICY';
      // inserted/updated/unchanged/quarantined intentionally stay at their
      // bump()-initialized 0 — nothing is inserted, updated, left unchanged,
      // or quarantined-as-a-conflict; every historical record is skipped by
      // policy, reported via legacySkippedByPolicy above instead.
    }

    // ══════════════════════════════════════════════════════════════════
    // PASS 7 — employees / leave requests / disciplinary (best-effort;
    // lower priority tier per the migration brief)
    // ══════════════════════════════════════════════════════════════════
    {
      const s = bump(summary, 'employees');
      const list = arr(data.employees);
      s.seen = list.length;
      const { clean, duplicateGroups } = splitDuplicateIds(list);
      for (const [id, recs] of duplicateGroups) {
        s.quarantined += recs.length;
        recordConflict({ collection: 'employees', source_id: id, document_number: null, conflict_type: 'duplicate_source_id', detail: { count: recs.length } });
      }
      const employeeIdBySourceId = new Map<string, number>();
      for (const rec of clean) {
        const sourceId = String(rec.id);
        const columns = {
          source_id: sourceId,
          full_name: str(rec.name) || str(rec.fullName),
          role: str(rec.role) || str(rec.position),
          company_code: str(rec.co),
        };
        const outcome = await upsertRow(client, 'rel_employees', ['source_id'], columns, rec);
        s[outcome]++;
        const row = await client.query('SELECT id FROM rel_employees WHERE source_id = $1', [sourceId]);
        employeeIdBySourceId.set(sourceId, row.rows[0].id);
      }

      const sLeave = bump(summary, 'leaveRequests');
      const leaveList = arr(data.leaveRequests);
      sLeave.seen = leaveList.length;
      const leaveSplit = splitDuplicateIds(leaveList);
      for (const [id, recs] of leaveSplit.duplicateGroups) {
        sLeave.quarantined += recs.length;
        recordConflict({ collection: 'leaveRequests', source_id: id, document_number: null, conflict_type: 'duplicate_source_id', detail: { count: recs.length } });
      }
      for (const rec of leaveSplit.clean) {
        const sourceId = String(rec.id);
        const empSourceId = rec.employeeId !== undefined && rec.employeeId !== null ? String(rec.employeeId) : null;
        const columns = {
          source_id: sourceId,
          employee_id: empSourceId ? employeeIdBySourceId.get(empSourceId) || null : null,
          employee_source_id: empSourceId,
          start_date: dateOrNull(rec.startDate),
          end_date: dateOrNull(rec.endDate),
          status: str(rec.status),
        };
        const outcome = await upsertRow(client, 'rel_leave_requests', ['source_id'], columns, rec);
        sLeave[outcome]++;
      }

      const sDisc = bump(summary, 'disciplinary');
      const discList = arr(data.disciplinary);
      sDisc.seen = discList.length;
      const discSplit = splitDuplicateIds(discList);
      for (const [id, recs] of discSplit.duplicateGroups) {
        sDisc.quarantined += recs.length;
        recordConflict({ collection: 'disciplinary', source_id: id, document_number: null, conflict_type: 'duplicate_source_id', detail: { count: recs.length } });
      }
      for (const rec of discSplit.clean) {
        const sourceId = String(rec.id);
        const empSourceId = rec.employeeId !== undefined && rec.employeeId !== null ? String(rec.employeeId) : null;
        const columns = {
          source_id: sourceId,
          employee_id: empSourceId ? employeeIdBySourceId.get(empSourceId) || null : null,
          employee_source_id: empSourceId,
          record_date: dateOrNull(rec.date),
          notes: str(rec.notes),
        };
        const outcome = await upsertRow(client, 'rel_disciplinary_records', ['source_id'], columns, rec);
        sDisc[outcome]++;
      }
    }

    // ── Persist conflicts + finalize the run row ─────────────────────────
    for (const c of conflicts) {
      await client.query(
        `INSERT INTO relational_legacy_conflicts (backfill_run_id, collection, source_id, document_number, conflict_type, detail)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [runId, c.collection, c.source_id, c.document_number, c.conflict_type, JSON.stringify(c.detail)]
      );
    }
    await client.query(
      `UPDATE relational_backfill_runs SET finished_at = NOW(), summary = $1::jsonb, ok = true WHERE id = $2`,
      [JSON.stringify(summary), runId]
    );

    if (opts.apply) {
      await client.query('COMMIT');
    } else {
      await client.query('ROLLBACK'); // dry run — guarantee zero writes
    }

    return { ok: true, summary, conflicts, runId: opts.apply ? runId : null };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[backfill] FAILED, rolled back everything:', err);
    return { ok: false, summary, conflicts, runId: null };
  } finally {
    client.release();
  }
}

// ── CLI entry point ────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const confirmArg = args.find((a) => a.startsWith('--confirm='));
    const confirm = confirmArg ? confirmArg.slice('--confirm='.length).replace(/^"|"$/g, '') : '';
    const sourceFileArg = args.find((a) => a.startsWith('--source-file='));
    const sourceFile = sourceFileArg ? sourceFileArg.slice('--source-file='.length) : undefined;

    if (apply) {
      if (confirm !== CONFIRM_PHRASE) {
        console.error(`[backfill] --apply requires --confirm="${CONFIRM_PHRASE}" (exact match). Refusing to run.`);
        process.exit(1);
      }
      const dbUrl = process.env.DATABASE_URL || '';
      if (!/localhost|127\.0\.0\.1/.test(dbUrl) && process.env.ALLOW_UNSAFE_RELATIONAL_BACKFILL !== '1') {
        console.error('[backfill] Refusing to --apply: DATABASE_URL does not look like a local database.');
        console.error('[backfill] Set ALLOW_UNSAFE_RELATIONAL_BACKFILL=1 only if you are certain this is intended.');
        process.exit(1);
      }
    }

    console.log(`[backfill] Mode: ${apply ? 'APPLY (writing)' : 'DRY RUN (no writes)'}${sourceFile ? `, source file: ${sourceFile}` : ', source: live platform_state'}`);
    const result = await runBackfill({ apply, sourceFile });
    console.log('\n[backfill] Summary:');
    console.log(JSON.stringify(result.summary, null, 2));
    if (result.conflicts.length > 0) {
      console.log(`\n[backfill] ${result.conflicts.length} legacy conflict(s) reported (quarantined, not written):`);
      for (const c of result.conflicts) {
        console.log(`  - [${c.collection}] ${c.conflict_type} source_id=${c.source_id ?? '—'} doc=${c.document_number ?? '—'} :: ${JSON.stringify(c.detail)}`);
      }
    }
    console.log(`\n[backfill] ${result.ok ? 'OK' : 'FAILED'}${apply ? (result.ok ? ' — committed.' : ' — rolled back, nothing written.') : ' — dry run, nothing written.'}`);
    await pool.end();
    process.exit(result.ok ? 0 : 1);
  })().catch(async (err) => {
    // EXTERNAL RENDER SSL FIX (2026-08-21): a connection failure here means
    // runBackfill() never started (DRY RUN) or its own transaction never
    // committed (APPLY — runBackfill's internal BEGIN/COMMIT/ROLLBACK means
    // a failed connection or a failed query rolls back everything in that
    // one transaction; nothing here retries the connection or the write).
    console.error(describeConnectionError(err));
    console.error('[backfill] Fatal error — nothing was written.', err);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
}
