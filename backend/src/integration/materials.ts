/**
 * Job Material Lists and Materials to Order for the owner read API (CORE-AGENTS). Read-only.
 *
 * ONE calculation, shared with the dashboard. The Material List rules (the set rows, sheet sizes, roll width, how a
 * saved list is normalised, and the automatic estimate drawn from job / quote lines) live in index.html. Rather than
 * keep a second copy that could drift, this module loads that exact block from the repository's index.html once
 * (text between `const SGR_MATERIAL_LIST_KEY` and the "EDITABLE DATA" banner) and runs it as a pure function, the
 * same way the test suites already lift the dashboard's money functions. The block only defines constants and pure
 * functions; it reads no browser state. Its SHA-256 is reported as `calculation.version`. If index.html cannot be
 * found or the block does not load, saved lists are still returned (they need no calculation beyond the shape rules,
 * which then fall back to a strict reader below) and the estimate is reported as unavailable — never guessed.
 *
 * States a job's list can be in:
 *   saved        a Material List was saved on the job (job.breakdown.material_list) with at least one line
 *   saved_empty  a Material List was saved and deliberately has no lines
 *   none         nothing saved — the dashboard then shows its automatic ESTIMATE (returned on the job detail)
 *   unreadable   something is stored under the key but not in a shape the dashboard can read
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

interface Calc {
  sgrMaterialList: (breakdown: any) => { v: number; rollW: number; qty: Record<string, number>; other: Array<{ id: string; material: string; size: string; qty: number; amount: string }> };
  sgrAutoMaterialList: (lines: any[], ctx: { inventory?: any[]; completeProducts?: any[]; rollW?: number }) => ReturnType<Calc['sgrMaterialList']>;
  sgrMaterialListCount: (ml: any) => number;
  SGR_MATERIAL_ROWS: Array<{ key: string; material: string; kind: 'sheet' | 'roll' | 'unit'; l?: number; w?: number; lam?: boolean }>;
  SGR_MATERIAL_LIST_KEY: string;
  SGR_MATERIAL_ROLL_W: number;
}

let loaded: { calc: Calc | null; version: string | null; error: string | null; from: string | null } | null = null;

function indexCandidates(): string[] {
  return [
    process.env.SIGNACORE_INDEX_HTML || '',
    path.resolve(__dirname, '..', '..', '..', 'index.html'), // backend/src/integration → repo root, and backend/dist/integration
    path.resolve(process.cwd(), '..', 'index.html'),
    path.resolve(process.cwd(), 'index.html'),
  ].filter(Boolean);
}

/** The dashboard's Material List block, loaded once. */
export function materialCalc(): { calc: Calc | null; version: string | null; error: string | null } {
  if (loaded) return loaded;
  const file = indexCandidates().find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  if (!file) { loaded = { calc: null, version: null, error: 'index.html (the dashboard, which holds the Material List rules) was not found next to the backend', from: null }; return loaded; }
  try {
    const html = fs.readFileSync(file, 'utf8');
    const a = html.indexOf('const SGR_MATERIAL_LIST_KEY');
    const b = html.indexOf('EDITABLE DATA', a);
    if (a < 0 || b < 0) throw new Error('Material List block markers not found in index.html');
    const block = html.slice(html.lastIndexOf('\n', a), html.lastIndexOf('/*', b));
    const names = ['sgrMaterialList', 'sgrAutoMaterialList', 'sgrMaterialListCount', 'SGR_MATERIAL_ROWS', 'SGR_MATERIAL_LIST_KEY', 'SGR_MATERIAL_ROLL_W'];
    // eslint-disable-next-line no-new-func
    const calc = new Function(`${block}\nreturn { ${names.join(', ')} };`)() as Calc;
    if (typeof calc.sgrMaterialList !== 'function' || !Array.isArray(calc.SGR_MATERIAL_ROWS)) throw new Error('Material List functions missing');
    loaded = { calc, version: crypto.createHash('sha256').update(block).digest('hex').slice(0, 12), error: null, from: file };
  } catch (err) {
    loaded = { calc: null, version: null, error: `the Material List rules in index.html could not be loaded (${(err as Error).message})`, from: file };
  }
  return loaded;
}
/** Tests only: reload (e.g. after pointing SIGNACORE_INDEX_HTML elsewhere). */
export function resetMaterialCalcForTests(): void { loaded = null; }

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const UNIT_OF = { sheet: 'sheets', roll: 'm', unit: 'units' } as const;

/** Lines with explicit units and dimensions, from a normalised list (dashboard shape). */
function linesOf(ml: ReturnType<Calc['sgrMaterialList']>, calc: Calc) {
  const out: any[] = [];
  for (const row of calc.SGR_MATERIAL_ROWS) {
    const qty = ml.qty[row.key];
    if (!(qty > 0)) continue;
    out.push({
      key: row.key, material: row.material, kind: row.kind, qty, qtyUnit: UNIT_OF[row.kind],
      sheetLengthM: row.kind === 'sheet' ? row.l ?? null : null, sheetWidthM: row.kind === 'sheet' ? row.w ?? null : null,
      rollWidthM: row.kind === 'roll' ? ml.rollW : null,
      areaM2: row.kind === 'sheet' ? r2(qty * (row.l || 0) * (row.w || 0)) : row.kind === 'roll' ? r2(qty * ml.rollW) : null,
      description: null, size: row.kind === 'sheet' ? `${row.l} m × ${row.w} m` : row.kind === 'roll' ? `Roll · ${ml.rollW} m wide` : 'Each',
      stockItemRef: null, // SignaCore does not link a Material List row to a stock item
    });
  }
  for (const o of ml.other) {
    out.push({ key: null, material: o.material, kind: 'other', qty: o.qty, qtyUnit: null, sheetLengthM: null, sheetWidthM: null, rollWidthM: null, areaM2: null,
      description: o.amount || null, size: o.size || null, stockItemRef: null });
  }
  return out;
}

/** Strict reader used only when the dashboard block could not be loaded: returns the stored values, unnormalised. */
function rawLines(stored: any) {
  const out: any[] = [];
  if (stored?.qty && typeof stored.qty === 'object') for (const [k, v] of Object.entries(stored.qty)) if (Number(v) > 0) out.push({ key: k, material: null, kind: null, qty: Number(v), qtyUnit: null, stockItemRef: null });
  if (Array.isArray(stored?.other)) for (const o of stored.other) if (o && String(o.material || '').trim() && Number(o.qty) > 0) out.push({ key: null, material: String(o.material), kind: 'other', qty: Number(o.qty), description: o.amount || null, size: o.size || null, stockItemRef: null });
  return out;
}

/** Entries the dashboard ignores when it reads a saved list (unknown rows, zero quantities, unnamed "other" lines). */
function ignoredEntries(stored: any, calc: Calc): string[] {
  const out: string[] = [];
  const keys = new Set(calc.SGR_MATERIAL_ROWS.map((r) => r.key));
  if (stored?.qty && typeof stored.qty === 'object') for (const [k, v] of Object.entries(stored.qty)) if (!keys.has(k) || !(parseFloat(String(v)) > 0)) out.push(`qty.${k}`);
  if (Array.isArray(stored?.other)) stored.other.forEach((o: any, i: number) => { if (!o || typeof o !== 'object' || !String(o.material || '').trim()) out.push(`other[${i}]`); });
  return out;
}

/** A plain JSON copy of what is stored (no functions, bounded) so a consumer can see the exact saved structure. */
function storedCopy(v: unknown): unknown {
  try { const s = JSON.stringify(v); return s && s.length <= 20000 ? JSON.parse(s) : { truncated: true, bytes: s ? s.length : 0 }; } catch { return null; }
}

/**
 * The job's Material List as the API reports it.
 * @param estimateCtx  pass on the job DETAIL only: { lines, linesFrom, quoteNumber, inventory, completeProducts } — the
 *                     estimate is worked out only when nothing is saved, exactly as the dashboard shows it.
 */
export function materialListView(job: any, estimateCtx?: { lines: any[]; linesFrom: 'job' | 'quote' | 'none'; quoteNumber: string | null; inventory: any[]; completeProducts: any[] }) {
  const { calc, version, error } = materialCalc();
  const key = calc ? calc.SGR_MATERIAL_LIST_KEY : 'material_list';
  const bd = job?.breakdown && typeof job.breakdown === 'object' ? job.breakdown : null;
  const has = Boolean(bd && Object.prototype.hasOwnProperty.call(bd, key) && bd[key] !== null && bd[key] !== undefined);
  const stored = has ? bd[key] : undefined;
  const calculation = { version, source: 'index.html Material List rules', available: Boolean(calc), ...(error ? { unavailableBecause: error } : {}) };
  const relationships = { stockItems: 'none — SignaCore does not link Material List rows to stock items', quote: job?.quoteNum ?? null };

  if (has && (typeof stored !== 'object' || Array.isArray(stored))) {
    return { state: 'unreadable', effective: 'saved_empty', reason: 'Something is stored as the Material List but it is not the object the dashboard reads.', saved: null, stored: storedCopy(stored), calculation, relationships };
  }
  if (has) {
    const ml = calc ? calc.sgrMaterialList(bd) : null;
    const lines = ml && calc ? linesOf(ml, calc) : rawLines(stored);
    const count = lines.length;
    return {
      state: count ? 'saved' : 'saved_empty', effective: count ? 'saved' : 'saved_empty',
      saved: { rollWidthM: ml ? ml.rollW : (Number(stored.rollW) > 0 ? Number(stored.rollW) : null), lines, ignoredEntries: calc ? ignoredEntries(stored, calc) : [], normalised: Boolean(ml) },
      stored: storedCopy(stored), estimate: null, calculation, relationships,
    };
  }
  const base = { state: 'none', saved: null, stored: null, calculation, relationships };
  if (!estimateCtx) return { ...base, effective: 'estimate_on_detail', estimate: null };
  if (!calc) return { ...base, effective: 'unavailable', estimate: { available: false, reason: `The automatic estimate could not be worked out: ${error}.` } };
  const lines = Array.isArray(estimateCtx.lines) ? estimateCtx.lines : [];
  const ml = calc.sgrAutoMaterialList(lines, { inventory: estimateCtx.inventory, completeProducts: estimateCtx.completeProducts, rollW: calc.SGR_MATERIAL_ROLL_W });
  const out = linesOf(ml, calc);
  return {
    ...base, effective: out.length ? 'estimate' : 'none',
    estimate: {
      available: true, label: 'ESTIMATED — worked out from the wording of the job (or quote) lines by keyword, as the dashboard\'s automatic Material List does. Not a saved requirement.',
      rollWidthM: ml.rollW, lines: out,
      basis: {
        linesFrom: estimateCtx.linesFrom, quoteNumber: estimateCtx.quoteNumber, lineCount: lines.length,
        linesLinkedToStockItems: lines.filter((l) => l && l.itemId != null && l.itemId !== '').length,
        linesLinkedToCompleteProducts: lines.filter((l) => l && l.cpId != null && l.cpId !== '').length,
        serviceLinesLeftOut: 'labour, installation, CNC and similar lines are not materials',
      },
    },
  };
}

/** Cost breakdown categories as numbers (the Material List object itself is left out: it is not a cost). */
export function costBreakdownView(job: any) {
  const bd = job?.breakdown && typeof job.breakdown === 'object' ? job.breakdown : {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(bd)) if (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))) out[k] = Number(v);
  return { categories: out, total: r2(Object.values(out).reduce((s, n) => s + n, 0)), currency: 'ZAR', note: 'As entered on the job in SignaCore (cost estimates, ex VAT).' };
}

/** Job lines as stored on the job (what the estimate reads). */
export function jobLinesView(job: any) {
  return (Array.isArray(job?.lines) ? job.lines : []).map((l: any, i: number) => ({
    index: i, description: l?.desc ?? null, qty: Number(l?.qty) || 0, pieces: l?.pQty ?? null, unit: l?.unit ?? null,
    lengthMm: l?.sqmL ?? null, widthMm: l?.sqmW ?? null, unitPriceExVat: Number(l?.unitPrice) || 0,
    stockItemId: l?.itemId != null ? String(l.itemId) : null, completeProductId: l?.cpId != null ? String(l.cpId) : null,
  }));
}

// ── Materials to Order (platform_state section `materialOrders`) ─────────────────────────────────────────────────────
// One record per material and SCOPE: 's' = every company except Holdings (the original Signacore users see every
// record not tagged co:1), 'h' = Holdings (co:1). `ordered` is kept PER JOB id. Scope-wide values (supplier, adjust,
// manual lines, who/when) belong to every company in the scope, so they are only shown to a client that may read ALL
// of them; per-job quantities are shown only for jobs whose company the client may read. An ordered entry for a job
// that no longer exists has no provable company and is withheld.
export const HOLDINGS_CODE = '1';

export function materialOrderView(rec: any, ctx: { calc: Calc | null; jobsById: Map<string, any>; companyOfJob: (j: any) => string; allowed: string[]; scopeCompanies: { s: string[]; h: string[] } }) {
  const id = String(rec?.id || '');
  const m = id.match(/^([sh]):(.+)$/);
  if (!m) return { ok: false as const, reason: 'no scope in id' };
  const scope = m[1] as 's' | 'h';
  const matId = m[2];
  const row = ctx.calc?.SGR_MATERIAL_ROWS.find((r) => r.key === matId) || null;
  const material = row ? row.material : rec.manual ? String(rec.material || '') : matId.startsWith('o:') ? matId.slice(2) : matId;
  const scopeAll = ctx.scopeCompanies[scope].every((c) => ctx.allowed.includes(c));
  const ordered: any[] = [];
  let withheld = 0;
  for (const [jobId, q] of Object.entries(rec.ordered && typeof rec.ordered === 'object' ? rec.ordered : {})) {
    const j = ctx.jobsById.get(String(jobId));
    const co = j ? ctx.companyOfJob(j) : null;
    if (!j || !co || !ctx.allowed.includes(co)) { withheld++; continue; }
    ordered.push({ jobId: String(jobId), jobNumber: j.num ?? null, companyCode: co, qty: Number(q) || 0 });
  }
  if (!scopeAll && !ordered.length) return { ok: false as const, reason: 'nothing this client may read' };
  return {
    ok: true as const,
    view: {
      id, scope: scope === 'h' ? 'holdings' : 'signacore', scopeCompanies: ctx.scopeCompanies[scope], material, materialKey: row ? row.key : null,
      kind: row ? row.kind : rec.manual ? 'manual' : 'other', unit: row ? UNIT_OF[row.kind] : rec.unit ?? null, size: row ? null : rec.size ?? null,
      orderedByJob: ordered, orderedEntriesWithheld: withheld,
      ...(scopeAll ? {
        supplier: rec.supplier ?? null, adjust: Number(rec.adjust) || 0, adjustOrdered: Number(rec.adjOrdered) || 0,
        orderedAt: rec.orderedAt ?? null, manual: rec.manual === true, removed: rec.removed === true,
      } : { scopeFieldsWithheld: 'Supplier, adjustment and manual-line details are shared by every company in this scope; this client may not read all of them.' }),
      orderedBy: null, // a person's name: not exposed
    },
  };
}
