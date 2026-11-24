/**
 * backfill-customer-links.ts — link existing quotes, jobs, invoices and credit
 * notes to their customer record (migration 021, 2026-11-24).
 *
 * MANUAL ONLY. Never run by Render. Three modes:
 *   --diagnose   read only: storage authority per section, customer id health,
 *                linked / unlinked / broken-link counts, and the plan summary.
 *   (default)    DRY RUN, read only: the full plan, every unresolved record
 *                with its reason, and a 16-hex plan fingerprint.
 *   --apply --confirm="LINK <n> DOCUMENTS" --expect=<fingerprint>
 *                applies EXACTLY the reviewed dry run, in one transaction.
 *   options: --connect-timeout=SECONDS (5-300, default 30)  --lock-timeout=SECONDS (default 15)
 *
 * WHAT COUNTS AS EVIDENCE (a link is only ever ADDED to a record that has none;
 * an existing link is never changed by this script):
 *   chain-link   another document of the same quote -> job -> invoice chain
 *                (same company) is already linked;
 *   rel-customer the record's backfilled rel_customers reference, whose
 *                source_id is exactly one current customer;
 *   stored-id    a customerId already stored on the record's JSON copy;
 *   name         the record's customer name equals exactly ONE customer's name
 *                (or a former name of exactly one renamed customer), with no
 *                other document in its chain naming a different customer.
 *   A chain whose evidence points at two customers, a name shared by two
 *   customers, a customer id shared by two customer records (run
 *   repair-id-collisions first), or no evidence at all is NOT linked — it is
 *   listed as UNRESOLVED for an explicit choice in Customers -> "not linked".
 *
 * APPLY (one transaction): every target row is locked; the plan is rebuilt and
 * must equal --expect; backups are written FIRST (a platform_state_backups copy
 * of the whole platform_state row when any JSON section changes, a plan row,
 * one customer_link_audit row per record with its previous link, and a local
 * customer-link-backfill-<time>.json); each link is set only while the record
 * is still unlinked; the result is re-read and verified before COMMIT.
 * Nothing else is touched: no name, contact, line, amount, date, number,
 * status or payment changes, and row_version is not bumped (open editors are
 * not invalidated; updated_at moves so other sessions refresh).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Client } from 'pg';
import { resolveSsl, describeConnectionError } from '../db/ssl';

type Section = 'quotes' | 'jobs' | 'accInvoices' | 'creditNotes';
const SECTIONS: Section[] = ['quotes', 'jobs', 'accInvoices', 'creditNotes'];
const REL: Record<Section, { table: string; num: string; name: string }> = {
  quotes: { table: 'rel_quotes', num: 'quote_number', name: 'customer_name_raw' },
  jobs: { table: 'rel_jobs', num: 'job_number', name: 'customer_name_raw' },
  accInvoices: { table: 'rel_invoices', num: 'invoice_number', name: 'contact_name' },
  creditNotes: { table: 'rel_credit_notes', num: 'credit_number', name: 'contact_name_raw' },
};
const LABEL: Record<Section, string> = { quotes: 'Quote', jobs: 'Job', accInvoices: 'Invoice', creditNotes: 'Credit note' };

interface Cust { ref: string; name: string; former: string[] }
interface Doc {
  key: string; section: Section; store: 'rel' | 'json'; relId: number | null; jsonIndex: number | null; jsonId: string | null;
  number: string; co: string; name: string; ref: string | null; status: string; customerType: string;
  relCustomerRef: string | null; storedRef: string | null; peers: string[];
}
interface PlanItem { key: string; section: Section; store: 'rel' | 'json'; relId: number | null; jsonIndex: number | null; jsonId: string | null; number: string; co: string; name: string; toRef: string; toName: string; evidence: string }
interface Unresolved { key: string; section: Section; number: string; co: string; name: string; reason: string }
interface Plan { items: PlanItem[]; unresolved: Unresolved[]; broken: Unresolved[]; fingerprint: string; confirm: string; dupIds: string[] }

const log = (s: string) => console.log(s);
const norm = (s: unknown) => String(s == null ? '' : s).trim().toLowerCase();
const t = (v: unknown): string | null => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());
const coOf = (v: unknown) => { const s = t(v); return s === null ? '2' : String(Number.isFinite(Number(s)) ? Number(s) : s); };

async function authority(client: Client): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  const r = await client.query(`SELECT section, enabled FROM relational_cutover`).catch(() => ({ rows: [] as any[] }));
  for (const row of r.rows) out[row.section] = row.enabled === true;
  return out;
}

async function readAll(client: Client, lock: boolean) {
  const auth = await authority(client);
  const ps = (await client.query(`SELECT data, updated_at FROM platform_state WHERE id = 1${lock ? ' FOR UPDATE' : ''}`)).rows[0];
  const data = ps?.data || {};
  let customers: Cust[];
  if (auth.customers) {
    customers = (await client.query('SELECT source_id, company_name, legacy_data FROM rel_customers')).rows
      .map((r: any) => ({ ref: String(r.source_id), name: String(r.company_name || ''), former: Array.isArray(r.legacy_data?.formerNames) ? r.legacy_data.formerNames : [] }));
  } else {
    customers = (Array.isArray(data.customers) ? data.customers : []).filter((c: any) => c && c.id != null)
      .map((c: any) => ({ ref: String(c.id), name: String(c.companyName || ''), former: Array.isArray(c.formerNames) ? c.formerNames.map(String) : [] }));
  }
  const relCustSource = new Map<string, string>();
  const rc = await client.query('SELECT id, source_id FROM rel_customers').catch(() => ({ rows: [] as any[] }));
  for (const r of rc.rows) relCustSource.set(String(r.id), String(r.source_id));

  const docs: Doc[] = [];
  const peersByKey = new Map<string, Set<string>>();
  const peer = (a: string, b: string) => { if (!peersByKey.has(a)) peersByKey.set(a, new Set()); if (!peersByKey.has(b)) peersByKey.set(b, new Set()); peersByKey.get(a)!.add(b); peersByKey.get(b)!.add(a); };

  for (const s of SECTIONS) {
    if (auth[s]) {
      const R = REL[s];
      const extra = s === 'quotes' ? ', converted_job_id' : s === 'jobs' ? ', quote_id' : s === 'accInvoices' ? ', job_id, quote_id, job_number_raw, quote_number_raw, reference, legacy_data' : ', note_type, legacy_data';
      const rows = (await client.query(`SELECT id, ${R.num} AS num, company_code, ${R.name} AS nm, customer_ref, customer_id, status${extra}${s !== 'accInvoices' && s !== 'creditNotes' ? ', legacy_data' : ''} FROM ${R.table} ORDER BY id${lock ? ' FOR UPDATE' : ''}`)).rows;
      for (const r of rows) {
        docs.push({
          key: `${s}:rel:${r.id}`, section: s, store: 'rel', relId: Number(r.id), jsonIndex: null, jsonId: null,
          number: String(r.num || ''), co: coOf(r.company_code), name: String(r.nm || ''), ref: t(r.customer_ref), status: String(r.status || ''),
          customerType: s === 'creditNotes' ? String(r.note_type || '') : 'customer',
          relCustomerRef: r.customer_id != null ? (relCustSource.get(String(r.customer_id)) || null) : null,
          storedRef: t(r.legacy_data?.customerId), peers: [],
        });
        const me = `${s}:rel:${r.id}`;
        if (s === 'quotes' && r.converted_job_id != null) peer(me, `jobs:rel:${r.converted_job_id}`);
        if (s === 'jobs' && r.quote_id != null) peer(me, `quotes:rel:${r.quote_id}`);
        if (s === 'accInvoices') {
          if (r.job_id != null) peer(me, `jobs:rel:${r.job_id}`);
          if (r.quote_id != null) peer(me, `quotes:rel:${r.quote_id}`);
          const oj = r.legacy_data?.originalJobId, oq = r.legacy_data?.originalQuoteId;
          if (oj != null) peer(me, `jobs:rel:${oj}`);
          if (oq != null) peer(me, `quotes:rel:${oq}`);
          (docs[docs.length - 1] as any)._nums = { job: t(r.job_number_raw) || t(r.reference), quote: t(r.quote_number_raw), hasIds: r.job_id != null || r.quote_id != null };
        }
      }
    } else {
      const arr = Array.isArray(data[s]) ? data[s] : [];
      arr.forEach((r: any, i: number) => {
        if (!r || r.id == null) return;
        const nm = s === 'quotes' || s === 'jobs' ? r.client : r.contactName;
        docs.push({
          key: `${s}:json:${r.id}`, section: s, store: 'json', relId: null, jsonIndex: i, jsonId: String(r.id),
          number: String((s === 'quotes' || s === 'jobs') ? (r.num || '') : (r.number || '')), co: coOf(r.co), name: String(nm || ''),
          ref: t(r.customerId), status: String(r.status || ''), customerType: s === 'creditNotes' ? String(r.type || '') : 'customer',
          relCustomerRef: null, storedRef: null, peers: [],
        });
        (docs[docs.length - 1] as any)._json = r;
      });
    }
  }
  // number-based chain links (JSON records, and older relational invoices without ids)
  const byNum = (sec: Section, num: string | null, co: string) => num ? docs.filter((d) => d.section === sec && d.co === co && norm(d.number) === norm(num)) : [];
  for (const d of docs) {
    const j = (d as any)._json;
    if (j) {
      if (d.section === 'jobs' && j.quoteNum) { const q = byNum('quotes', j.quoteNum, d.co); if (q.length === 1) peer(d.key, q[0].key); }
      if (d.section === 'accInvoices') {
        const jn = t(j.jobNum) || t(j.reference) || t(j.originalJobNum); const jj = byNum('jobs', jn, d.co); if (jj.length === 1) peer(d.key, jj[0].key);
        const qn = t(j.quoteNum) || t(j.originalQuoteNum); const qq = byNum('quotes', qn, d.co); if (qq.length === 1) peer(d.key, qq[0].key);
      }
    }
    const nums = (d as any)._nums;
    if (nums && !nums.hasIds) {
      const jj = byNum('jobs', nums.job, d.co); if (jj.length === 1) peer(d.key, jj[0].key);
      const qq = byNum('quotes', nums.quote, d.co); if (qq.length === 1) peer(d.key, qq[0].key);
    }
  }
  for (const d of docs) d.peers = Array.from(peersByKey.get(d.key) || []);
  return { auth, customers, docs, psUpdatedAt: ps?.updated_at ? new Date(ps.updated_at).toISOString() : null, data };
}

function buildPlan(customers: Cust[], docs: Doc[]): Plan {
  const count = new Map<string, number>();
  for (const c of customers) count.set(c.ref, (count.get(c.ref) || 0) + 1);
  const dupIds = Array.from(count.entries()).filter(([, n]) => n > 1).map(([r]) => r);
  const valid = (ref: string | null) => !!ref && count.get(ref) === 1;
  const nameOf = (ref: string) => customers.find((c) => c.ref === ref)?.name || '';
  const byName = (nm: string): { state: 'one' | 'many' | 'none'; ref?: string; n?: number } => {
    const n = norm(nm); if (!n) return { state: 'none' };
    let hits = customers.filter((c) => norm(c.name) === n);
    if (!hits.length) hits = customers.filter((c) => c.former.some((f) => norm(f) === n));
    if (hits.length === 1) return valid(hits[0].ref) ? { state: 'one', ref: hits[0].ref } : { state: 'many', n: 2 };
    return hits.length ? { state: 'many', n: hits.length } : { state: 'none' };
  };
  const byKey = new Map(docs.map((d) => [d.key, d]));
  const items: PlanItem[] = []; const unresolved: Unresolved[] = []; const broken: Unresolved[] = [];
  const un = (d: Doc, reason: string) => unresolved.push({ key: d.key, section: d.section, number: d.number, co: d.co, name: d.name, reason });
  for (const d of docs) if (d.ref && !valid(d.ref)) broken.push({ key: d.key, section: d.section, number: d.number, co: d.co, name: d.name, reason: count.get(d.ref) ? `linked id ${d.ref} is shared by ${count.get(d.ref)} customers` : `linked customer ${d.ref} no longer exists` });
  // chains (union of peers), company-scoped
  const seen = new Set<string>();
  for (const start of docs) {
    if (seen.has(start.key) || start.section === 'creditNotes') continue;
    const group: Doc[] = []; const stack = [start.key];
    while (stack.length) { const k = stack.pop()!; if (seen.has(k)) continue; const d = byKey.get(k); if (!d || d.co !== start.co || d.section === 'creditNotes') continue; seen.add(k); group.push(d); d.peers.forEach((p) => stack.push(p)); }
    const todo = group.filter((d) => !d.ref);
    if (!todo.length) continue;
    const existing = Array.from(new Set(group.map((d) => d.ref).filter((r): r is string => !!r && valid(r))));
    const strong = new Set<string>(); const strongBad: string[] = [];
    for (const d of group) for (const r of [d.relCustomerRef, d.storedRef]) { if (!r) continue; if (valid(r)) strong.add(r); else strongBad.push(r); }
    const names = group.map((d) => ({ d, m: byName(d.name) }));
    const nameRefs = new Set(names.filter((x) => x.m.state === 'one').map((x) => x.m.ref as string));
    const label = group.map((d) => `${LABEL[d.section]} ${d.number}`).join(' / ');
    let to: string | null = null; let evidence = ''; let reason = '';
    if (existing.length > 1) reason = `the chain (${label}) is already linked to ${existing.length} different customers`;
    else if (existing.length === 1) {
      const conflictStrong = Array.from(strong).filter((r) => r !== existing[0]);
      if (conflictStrong.length) reason = `the chain is linked to ${nameOf(existing[0])} but the stored customer reference points at ${nameOf(conflictStrong[0])}`;
      else { to = existing[0]; evidence = 'chain-link'; }
    } else if (strong.size > 1) reason = `the stored customer references in the chain (${label}) point at ${strong.size} different customers`;
    else if (strong.size === 1) {
      const s = Array.from(strong)[0];
      const otherName = Array.from(nameRefs).find((r) => r !== s);
      if (otherName) reason = `the stored reference says ${nameOf(s)} but a document in the chain is named ${nameOf(otherName)}`;
      else { to = s; evidence = group.some((d) => d.relCustomerRef === s) ? 'rel-customer' : 'stored-id'; }
    } else {
      const many = names.find((x) => x.m.state === 'many');
      if (strongBad.length) reason = `a stored customer reference (${strongBad[0]}) is missing or duplicated`;
      else if (nameRefs.size > 1) reason = `documents in the chain (${label}) name ${nameRefs.size} different customers`;
      else if (many) reason = `${many.m.n} customers are named "${many.d.name}" — choose one`;
      else if (nameRefs.size === 1) { to = Array.from(nameRefs)[0]; evidence = 'name'; }
      else reason = `no customer record matches "${group[0].name || '(no name)'}"`;
    }
    for (const d of todo) {
      if (to) items.push({ key: d.key, section: d.section, store: d.store, relId: d.relId, jsonIndex: d.jsonIndex, jsonId: d.jsonId, number: d.number, co: d.co, name: d.name, toRef: to, toName: nameOf(to), evidence });
      else un(d, reason);
    }
  }
  for (const d of docs.filter((x) => x.section === 'creditNotes' && !x.ref)) {
    if (d.customerType && d.customerType !== 'customer') continue;
    const strong = [d.relCustomerRef, d.storedRef].filter((r): r is string => !!r);
    const okStrong = strong.filter(valid);
    const m = byName(d.name);
    let to: string | null = null; let ev = ''; let reason = '';
    if (new Set(okStrong).size > 1) reason = 'stored customer references disagree';
    else if (okStrong.length) { if (m.state === 'one' && m.ref !== okStrong[0]) reason = `the stored reference says ${nameOf(okStrong[0])} but the note is named ${nameOf(m.ref!)}`; else { to = okStrong[0]; ev = d.relCustomerRef === to ? 'rel-customer' : 'stored-id'; } }
    else if (m.state === 'one') { to = m.ref!; ev = 'name'; }
    else reason = m.state === 'many' ? `${m.n} customers are named "${d.name}" — choose one` : `no customer record matches "${d.name || '(no name)'}"`;
    if (to) items.push({ key: d.key, section: d.section, store: d.store, relId: d.relId, jsonIndex: d.jsonIndex, jsonId: d.jsonId, number: d.number, co: d.co, name: d.name, toRef: to, toName: nameOf(to), evidence: ev });
    else un(d, reason);
  }
  items.sort((a, b) => a.key.localeCompare(b.key));
  const fp = crypto.createHash('sha256').update(JSON.stringify(items.map((i) => [i.key, i.toRef, i.evidence]))).digest('hex').slice(0, 16);
  return { items, unresolved, broken, fingerprint: fp, confirm: `LINK ${items.length} DOCUMENTS`, dupIds };
}

function printReport(auth: Record<string, boolean>, customers: Cust[], docs: Doc[], plan: Plan, mode: string): void {
  log('STORAGE AUTHORITY (relational_cutover flags; Render also needs RELATIONAL_AUTHORITY_ENABLED=true)');
  for (const s of ['customers', ...SECTIONS]) log(`   ${s.padEnd(12)} ${auth[s] ? 'relational' : 'platform_state (JSON)'}`);
  log(`CUSTOMERS  ${customers.length} record(s); duplicated ids: ${plan.dupIds.length ? plan.dupIds.join(', ') + '  -> run repair-id-collisions first; these are never linked to' : 'none'}`);
  log('DOCUMENTS  section       linked  not-linked  broken-link');
  for (const s of SECTIONS) {
    const ds = docs.filter((d) => d.section === s && (s !== 'creditNotes' || d.customerType === 'customer'));
    const br = plan.broken.filter((b) => b.section === s).length;
    log(`           ${s.padEnd(12)} ${String(ds.filter((d) => d.ref).length - br).padStart(6)}  ${String(ds.filter((d) => !d.ref).length).padStart(10)}  ${String(br).padStart(11)}`);
  }
  const ev = new Map<string, number>(); plan.items.forEach((i) => ev.set(i.evidence, (ev.get(i.evidence) || 0) + 1));
  log(`PLAN       ${plan.items.length} record(s) can be linked from reliable evidence (${Array.from(ev.entries()).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'}); ${plan.unresolved.length} unresolved; ${plan.broken.length} broken link(s).`);
  if (mode === 'diagnose') return;
  if (plan.items.length) { log(''); log('TO LINK'); for (const i of plan.items) log(`   co ${i.co}  ${LABEL[i.section]} ${i.number || '(no number)'}  "${i.name}"  ->  ${i.toName} [${i.toRef}]  (${i.evidence})`); }
  if (plan.unresolved.length) { log(''); log('UNRESOLVED — choose explicitly in Customers -> "not linked to a customer record"'); for (const u of plan.unresolved) log(`   co ${u.co}  ${LABEL[u.section]} ${u.number || '(no number)'}  "${u.name}"  — ${u.reason}`); }
  if (plan.broken.length) { log(''); log('BROKEN LINKS — never changed by this script; fix the customer id or choose again in the dashboard'); for (const b of plan.broken) log(`   co ${b.co}  ${LABEL[b.section]} ${b.number}  — ${b.reason}`); }
}

async function applyPlan(client: Client, plan: Plan, anyJson: boolean, localFile: string): Promise<{ changed: number; backupId: string | null; planBackupId: string }> {
  const REASON = 'before-customer-link-backfill';
  const source = 'src/scripts/backfill-customer-links.ts (manual run)';
  let backupId: string | null = null;
  if (anyJson) {
    backupId = (await client.query(
      `INSERT INTO platform_state_backups (data, reason, data_size_bytes, record_counts, source)
       SELECT data, $1, octet_length(data::text), '{}'::jsonb, $2 FROM platform_state WHERE id = 1 RETURNING id::text AS id`, [REASON, source])).rows[0].id;
  }
  const doc = { createdAt: new Date().toISOString(), fingerprint: plan.fingerprint, items: plan.items, unresolved: plan.unresolved, broken: plan.broken, backupId };
  const ser = JSON.stringify(doc);
  const planBackupId = (await client.query(
    `INSERT INTO platform_state_backups (data, reason, data_size_bytes, record_counts, source) VALUES ($1::jsonb, $2, $3, $4::jsonb, $5) RETURNING id::text AS id`,
    [ser, REASON + ' (plan)', Buffer.byteLength(ser, 'utf8'), JSON.stringify({ link: plan.items.length, unresolved: plan.unresolved.length }), source])).rows[0].id;
  fs.writeFileSync(localFile, JSON.stringify({ ...doc, planBackupId, status: 'NOT YET COMMITTED' }, null, 2), 'utf8');
  let changed = 0;
  for (const i of plan.items) {
    if (i.store === 'rel') {
      const r = await client.query(`UPDATE ${REL[i.section].table} SET customer_ref = $1, updated_at = NOW() WHERE id = $2 AND customer_ref IS NULL`, [i.toRef, i.relId]);
      if (r.rowCount !== 1) throw new Error(`${LABEL[i.section]} ${i.number} changed while the repair ran (it is no longer unlinked). Nothing was written.`);
    } else {
      const r = await client.query(
        `UPDATE platform_state SET data = jsonb_set(data, $1::text[], to_jsonb($2::text), true), updated_at = NOW()
          WHERE id = 1 AND data #>> $3::text[] = $4 AND COALESCE(data #>> $1::text[], '') = ''`,
        [[i.section, String(i.jsonIndex), 'customerId'], i.toRef, [i.section, String(i.jsonIndex), 'id'], i.jsonId]);
      if (r.rowCount !== 1) throw new Error(`${LABEL[i.section]} ${i.number} moved or was linked while the repair ran. Nothing was written.`);
    }
    await client.query(
      `INSERT INTO customer_link_audit (actor, action, company_code, from_refs, to_ref, members, detail) VALUES ($1, 'backfill', $2, '[null]'::jsonb, $3, $4::jsonb, $5::jsonb)`,
      [source, i.co, i.toRef, JSON.stringify([{ key: i.key, number: i.number, name: i.name, before: null }]), JSON.stringify({ evidence: i.evidence, fingerprint: plan.fingerprint })]);
    changed++;
  }
  return { changed, backupId, planBackupId };
}

export function scrub(text: string, url: string | undefined): string {
  let s = String(text);
  if (url) { s = s.split(url).join('<DATABASE_URL>'); try { const u = new URL(url); if (u.password) s = s.split(decodeURIComponent(u.password)).join('***').split(u.password).join('***'); } catch { /* not a URL */ } }
  return s.replace(/postgres(ql)?:\/\/[^\s'"]+/gi, '<connection string>');
}
async function connect(timeoutMs: number, attempts: number): Promise<Client> {
  const url = process.env.DATABASE_URL as string; let last: any = null;
  for (let i = 1; i <= attempts; i++) {
    const client = new Client({ connectionString: url, ssl: resolveSsl(url), connectionTimeoutMillis: timeoutMs, keepAlive: true, keepAliveInitialDelayMillis: 10000 });
    client.on('error', (e) => { console.error('[db] connection error: ' + scrub(e && e.message ? e.message : String(e), url)); });
    const t0 = Date.now();
    try { await client.connect(); log(`connected in ${Date.now() - t0} ms (attempt ${i} of ${attempts}; limit ${Math.round(timeoutMs / 1000)}s)`); return client; }
    catch (err: any) {
      last = err; log(`connection attempt ${i} of ${attempts} failed after ${Date.now() - t0} ms: ${scrub(err && err.message ? err.message : String(err), url)}`);
      await client.end().catch(() => undefined);
      if (i < attempts) await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  throw new Error(`could not connect to the database after ${attempts} attempts (limit ${Math.round(timeoutMs / 1000)}s each).\n   ${scrub(describeConnectionError(last), url)}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (n: string): string | undefined => { const a = argv.find((x) => x.startsWith(n + '=')); return a ? a.slice(n.length + 1) : undefined; };
  const APPLY = argv.includes('--apply'); const DIAG = argv.includes('--diagnose');
  const tSec = Math.min(300, Math.max(5, Number(arg('--connect-timeout')) || 30));
  const lockSec = Math.min(120, Math.max(1, Number(arg('--lock-timeout')) || 15));
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set. In PowerShell:  $env:DATABASE_URL = Read-Host "Render External Database URL"'); process.exitCode = 1; return; }
  if (APPLY && DIAG) { console.error('Use --diagnose or --apply, not both.'); process.exitCode = 1; return; }
  let client: Client | null = null; let inTx = false; let localFile = '';
  try {
    log(`backfill-customer-links — ${APPLY ? 'APPLY' : DIAG ? 'DIAGNOSE (read only)' : 'DRY RUN (read only)'}`);
    client = await connect(tSec * 1000, 3);
    await client.query(APPLY ? 'BEGIN' : 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'); inTx = true;
    await client.query(`SET LOCAL lock_timeout = '${lockSec}s'`);
    await client.query(`SET LOCAL statement_timeout = '120s'`);
    const who = (await client.query(`SELECT current_database() AS db, NOW() AS at, current_setting('transaction_read_only') AS ro`)).rows[0];
    log(`database ${who.db}   at ${new Date(who.at).toISOString()}   transaction_read_only=${who.ro}`);
    const hasCol = (await client.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'rel_invoices' AND column_name = 'customer_ref'`)).rowCount;
    if (!hasCol) throw new Error('migration 021_customer_links has not run on this database yet (rel_invoices.customer_ref is missing). Deploy the backend first. Nothing was written.');
    log('');
    const { auth, customers, docs } = await readAll(client, APPLY);
    const plan = buildPlan(customers, docs);
    printReport(auth, customers, docs, plan, DIAG ? 'diagnose' : APPLY ? 'apply' : 'dry-run');
    log('');
    if (!APPLY) {
      await client.query('ROLLBACK'); inTx = false;
      if (DIAG) { log('DIAGNOSE — nothing was written. Run without --diagnose for the full plan and the unresolved list.'); return; }
      const rep = path.resolve(process.cwd(), `customer-link-dry-run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      fs.writeFileSync(rep, JSON.stringify({ fingerprint: plan.fingerprint, items: plan.items, unresolved: plan.unresolved, broken: plan.broken, dupIds: plan.dupIds }, null, 2), 'utf8');
      log(`DRY RUN — ${plan.items.length} record(s) to link, ${plan.unresolved.length} unresolved, ${plan.broken.length} broken. Nothing was written.`);
      log(`report:          ${rep}`);
      log(`plan fingerprint: ${plan.fingerprint}`);
      if (plan.items.length) { log('To apply exactly this plan:'); log(`   npm run backfill:customer-links:compiled -- --apply --confirm="${plan.confirm}" --expect=${plan.fingerprint}`); }
      return;
    }
    if (!plan.items.length) { await client.query('ROLLBACK'); inTx = false; log('Nothing to link — nothing written.'); return; }
    if (arg('--expect') !== plan.fingerprint) throw new Error(`the data no longer matches the reviewed dry run (fingerprint now ${plan.fingerprint}, --expect=${arg('--expect') || '(missing)'}). Run the dry run again and review it. Nothing written.`);
    if (arg('--confirm') !== plan.confirm) throw new Error(`--confirm must be exactly "${plan.confirm}". Nothing written.`);
    localFile = path.resolve(process.cwd(), `customer-link-backfill-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    const res = await applyPlan(client, plan, plan.items.some((i) => i.store === 'json'), localFile);
    // verify before commit
    const again = buildPlan((await readAll(client, false)).customers, (await readAll(client, false)).docs);
    const stillTodo = again.items.filter((i) => plan.items.some((p) => p.key === i.key));
    if (stillTodo.length) throw new Error(`verification failed: ${stillTodo.length} planned record(s) are still unlinked. Rolled back; nothing written.`);
    await client.query('COMMIT'); inTx = false;
    try { const d = JSON.parse(fs.readFileSync(localFile, 'utf8')); d.status = 'APPLIED (committed ' + new Date().toISOString() + ')'; fs.writeFileSync(localFile, JSON.stringify(d, null, 2), 'utf8'); } catch { /* already written */ }
    if (res.backupId) log(`BACKUP   platform_state_backups id ${res.backupId} (whole platform_state row, before)`);
    log(`BACKUP   platform_state_backups id ${res.planBackupId} (plan) and one customer_link_audit row per record`);
    log(`LOCAL    ${localFile}   (keep it: the server keeps only the newest 100 backup rows)`);
    log(`APPLIED  ${res.changed} record(s) linked. ${plan.unresolved.length} unresolved and ${plan.broken.length} broken link(s) were left for an explicit choice. No other field changed.`);
    log('Reload every open dashboard tab.');
  } catch (err: any) {
    if (client && inTx) await client.query('ROLLBACK').catch(() => undefined);
    if (localFile && fs.existsSync(localFile)) { const nf = localFile.replace(/\.json$/, '-NOT-APPLIED.json'); try { fs.renameSync(localFile, nf); log(`(plan file renamed ${path.basename(nf)} — nothing was applied)`); } catch { /* ignore */ } }
    console.error('STOPPED: ' + scrub(err && err.message ? err.message : String(err), url));
    process.exitCode = 1;
  } finally {
    if (client) await client.end().catch(() => undefined);
  }
}

export { buildPlan };
if (require.main === module) { void main(); }
