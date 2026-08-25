/**
 * migration013Recovery.ts — HISTORICAL MIGRATION-013 FIELD RECOVERY ANALYSIS
 * Created 2026-08-25 (Job → Invoice financial consistency repair, Part 3).
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
 * 013_quote_line_dimensions.sql added five columns to rel_quote_line_items and
 * rel_job_line_items:
 *      sqm_l, sqm_w, pieces, complete_product_source_id, complete_product_linked
 * Every row that was BACKFILLED before 013 ran therefore has all five NULL —
 * not because the values never existed, but because the columns did not.
 *
 * One of them, `pieces`, is FINANCIAL: lineSubtotal() prices a line as
 * pieces x qty x unitPrice, and a NULL reads as 1. A historical job whose lines
 * really carried pieces=2 therefore prices, today, at HALF its true value —
 * which is precisely what the confirmed Audio Access case (SQ-00108 /
 * SNS-00110 / INV-00103) turned out to be.
 *
 * The original values were not destroyed. They survive in two places, and this
 * module's whole job is to decide, per line, whether one of them can be
 * matched back DETERMINISTICALLY — never by guesswork.
 *
 * ── THIS MODULE NEVER WRITES ────────────────────────────────────────────────
 * There is deliberately NO apply path anywhere in this file. It issues SELECTs
 * only and returns a report. A repair, if one is ever approved, is a separate,
 * separately-reviewed piece of work that would consume this report — it cannot
 * be triggered from here by accident or by a stray flag.
 *
 * ── THE TWO SOURCES, IN PRIORITY ORDER ──────────────────────────────────────
 * S1  the row's OWN `legacy_data`.
 *     backfill.ts stores each source JSON line verbatim in the line row's
 *     legacy_data. For a backfilled line that has never been re-saved, that
 *     object still holds sqmL / sqmW / pQty / cpId / cpLinked. This is the
 *     strongest possible source: it needs no cross-document matching at all,
 *     because it is physically attached to the row being recovered.
 *     (013's own header notes the flip side: a relational WRITE sets
 *     legacy_data to '{}', so a line edited since cutover has lost it — which
 *     is exactly when S2 matters.)
 *
 * S2  the preserved platform_state.data JSON.
 *     The pre-cutover snapshot of quotes[] / jobs[], each with its own lines[].
 *     Reaching a line here requires TWO deterministic hops — document, then
 *     line — and either hop can legitimately fail to be deterministic, which
 *     is what AMBIGUOUS exists to report.
 *
 * ── IDENTITY, IN DESCENDING STRENGTH ────────────────────────────────────────
 * Document:  rel_*.source_id  ==  JSON record id      (the identity backfill
 *                                                      itself wrote — exact)
 *            then (document number + company code)     (globally unique per
 *                                                      007's UNIQUE constraints)
 * Line:      line_index       ==  position in lines[]  (backfill writes
 *                                                      line_index = array index,
 *                                                      so this is an identity,
 *                                                      not a heuristic)
 *            then a UNIQUE match on description+qty+unitPrice — used ONLY when
 *            positional identity is unavailable, and ONLY when exactly one
 *            candidate matches. Never "closest match".
 *
 * Description / qty / unit_price are then used as VERIFICATION on whichever
 * candidate identity produced — never as the identity itself unless proven
 * unique. A candidate that disagrees is reported as MISMATCH and recovered
 * from NEVER; that is a line which has been edited since backfill, and its
 * historical dimensions may no longer describe it.
 *
 * ── CLASSIFICATIONS ─────────────────────────────────────────────────────────
 *   SAFE_TO_RECOVER  a single verified source was located and it carries at
 *                    least one value for a field that is currently NULL.
 *   NO_SOURCE_VALUE  no source could be located, or the source was located and
 *                    verified but genuinely records nothing for these fields.
 *   AMBIGUOUS        identity could not be resolved to exactly one candidate,
 *                    or two located sources disagree about a value.
 *   MISMATCH         a source was located but its verification fields disagree
 *                    with the relational row.
 *   ALREADY_SET      every 013 field on this row already has a value. Nothing
 *                    is proposed — a non-NULL value is NEVER overwritten.
 */
import pool from '../db/pool';
import { restoreId } from './read';

// ── the five fields 013 added ───────────────────────────────────────────────
export type Migration013Field = 'pieces' | 'sqmL' | 'sqmW' | 'cpId' | 'cpLinked';
export const MIGRATION_013_FIELDS: Migration013Field[] = ['pieces', 'sqmL', 'sqmW', 'cpId', 'cpLinked'];

/** The relational column each field lives in — used by the report, never to write. */
export const MIGRATION_013_COLUMNS: Record<Migration013Field, string> = {
  pieces: 'pieces',
  sqmL: 'sqm_l',
  sqmW: 'sqm_w',
  cpId: 'complete_product_source_id',
  cpLinked: 'complete_product_linked',
};

/** Only `pieces` moves money. The report separates it so a reviewer can see at
 *  a glance which recoveries would change a document's value. */
export const FINANCIAL_013_FIELDS: Migration013Field[] = ['pieces'];

export type RecoveryClassification =
  | 'SAFE_TO_RECOVER'
  | 'NO_SOURCE_VALUE'
  | 'AMBIGUOUS'
  | 'MISMATCH'
  | 'ALREADY_SET';

export interface RelationalLineSnapshot {
  lineId: number;
  lineIndex: number;
  description: string | null;
  qty: number;
  unitPrice: number;
  inventorySourceId: string | null;
  pieces: number | null;
  sqmL: number | null;
  sqmW: number | null;
  cpId: string | null;
  cpLinked: boolean | null;
}

export type CandidateOrigin = 'legacy_data' | 'platform_state_json';

export interface RecoveryCandidate {
  origin: CandidateOrigin;
  /** How the candidate was identified, for the report's audit trail. */
  identity: string;
  /** The raw source line object (a JSON line as the frontend stored it). */
  line: Record<string, unknown> | null;
  /** Set when identity itself could not be resolved to exactly one thing. */
  ambiguous?: boolean;
  ambiguityReason?: string;
}

export interface LineRecoveryVerdict {
  classification: RecoveryClassification;
  reason: string;
  /** Which source (if any) the proposal came from. */
  sourceOrigin: CandidateOrigin | null;
  sourceIdentity: string | null;
  /** Fields that would be filled, with the exact value that would be written. */
  proposed: Partial<Record<Migration013Field, number | string | boolean>>;
  /** Fields left alone because the row already has a value — never overwritten. */
  preservedFields: Migration013Field[];
  /** Fields still NULL afterwards because no source value exists for them. */
  unresolvedFields: Migration013Field[];
  /** True when `proposed` contains a field that changes the line's value. */
  changesValue: boolean;
}

// ── normalisation / comparison helpers ──────────────────────────────────────

/** A number, or null for anything that is not a usable finite number. Mirrors
 *  services.ts's optionalNumber so a value recovered here would be read back by
 *  the same rules the pricing formula applies. */
export function optionalNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function optionalStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

function optionalBool(v: unknown): boolean | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v;
  const t = String(v).trim().toLowerCase();
  if (t === 'true' || t === '1') return true;
  if (t === 'false' || t === '0') return false;
  return null;
}

/** Case- and whitespace-insensitive text comparison for verification only. */
function sameText(a: unknown, b: unknown): boolean {
  const na = (a === null || a === undefined) ? '' : String(a).trim().replace(/\s+/g, ' ').toLowerCase();
  const nb = (b === null || b === undefined) ? '' : String(b).trim().replace(/\s+/g, ' ').toLowerCase();
  return na === nb;
}

/** Money/quantity comparison at the 4 decimal places the columns actually store. */
function sameNumber(a: unknown, b: unknown): boolean {
  const na = optionalNum(a);
  const nb = optionalNum(b);
  if (na === null && nb === null) return true;
  if (na === null || nb === null) return false;
  return Math.abs(na - nb) < 0.00005;
}

/** Reads the five 013 values off a source JSON line, under the names the
 *  frontend has always used for them (`pQty` is the piece count on the wire). */
export function readSourceFields(
  line: Record<string, unknown> | null | undefined
): Partial<Record<Migration013Field, number | string | boolean>> {
  if (!line || typeof line !== 'object') return {};
  const out: Partial<Record<Migration013Field, number | string | boolean>> = {};
  const pieces = optionalNum((line as any).pQty ?? (line as any).pieces);
  if (pieces !== null) out.pieces = pieces;
  const sqmL = optionalNum((line as any).sqmL);
  if (sqmL !== null) out.sqmL = sqmL;
  const sqmW = optionalNum((line as any).sqmW);
  if (sqmW !== null) out.sqmW = sqmW;
  const cpId = optionalStr((line as any).cpId);
  if (cpId !== null) out.cpId = cpId;
  const cpLinked = optionalBool((line as any).cpLinked);
  if (cpLinked !== null) out.cpLinked = cpLinked;
  return out;
}

/** Whether a source line verifies against the relational row it claims to be. */
export function verifyCandidate(
  rel: RelationalLineSnapshot,
  line: Record<string, unknown> | null | undefined
): { ok: boolean; reason: string } {
  if (!line || typeof line !== 'object') return { ok: false, reason: 'source line is not an object' };
  const srcDesc = (line as any).desc ?? (line as any).description;
  if (!sameText(rel.description, srcDesc)) {
    return { ok: false, reason: `description differs (relational "${rel.description ?? ''}" vs source "${srcDesc ?? ''}")` };
  }
  if (!sameNumber(rel.qty, (line as any).qty)) {
    return { ok: false, reason: `qty differs (relational ${rel.qty} vs source ${(line as any).qty})` };
  }
  if (!sameNumber(rel.unitPrice, (line as any).unitPrice)) {
    return { ok: false, reason: `unit price differs (relational ${rel.unitPrice} vs source ${(line as any).unitPrice})` };
  }
  // Inventory identity is only checked when BOTH sides carry one — a line that
  // never referenced inventory must not be rejected for not having an id.
  const relItem = optionalStr(rel.inventorySourceId);
  const srcItem = optionalStr((line as any).itemId);
  if (relItem !== null && srcItem !== null && relItem !== srcItem) {
    return { ok: false, reason: `inventory identity differs (relational ${relItem} vs source ${srcItem})` };
  }
  return { ok: true, reason: 'description, qty, unit price (and inventory identity where present) all agree' };
}

/**
 * THE classification decision. Pure — no database, no I/O — so every branch is
 * directly testable and the rules can be read in one place.
 */
export function classifyLineRecovery(
  rel: RelationalLineSnapshot,
  candidates: RecoveryCandidate[]
): LineRecoveryVerdict {
  const empty: LineRecoveryVerdict = {
    classification: 'NO_SOURCE_VALUE', reason: '', sourceOrigin: null, sourceIdentity: null,
    proposed: {}, preservedFields: [], unresolvedFields: [], changesValue: false,
  };

  // Which fields are currently NULL? A non-NULL field is NEVER a candidate for
  // recovery — this is the single hard invariant of the whole exercise.
  const currentValues: Record<Migration013Field, unknown> = {
    pieces: rel.pieces, sqmL: rel.sqmL, sqmW: rel.sqmW, cpId: rel.cpId, cpLinked: rel.cpLinked,
  };
  const preservedFields = MIGRATION_013_FIELDS.filter((f) => currentValues[f] !== null && currentValues[f] !== undefined);
  const missingFields = MIGRATION_013_FIELDS.filter((f) => currentValues[f] === null || currentValues[f] === undefined);

  if (missingFields.length === 0) {
    return {
      ...empty,
      classification: 'ALREADY_SET',
      reason: 'every migration-013 field on this line already carries a value — nothing to recover, and an existing value is never overwritten',
      preservedFields,
    };
  }

  // An identity that could not be resolved is ambiguous whatever else is true.
  const ambiguousCandidate = candidates.find((c) => c.ambiguous);
  if (ambiguousCandidate) {
    return {
      ...empty,
      classification: 'AMBIGUOUS',
      reason: ambiguousCandidate.ambiguityReason || 'the source line could not be identified deterministically',
      sourceOrigin: ambiguousCandidate.origin,
      sourceIdentity: ambiguousCandidate.identity,
      preservedFields,
      unresolvedFields: missingFields,
    };
  }

  const present = candidates.filter((c) => c.line && typeof c.line === 'object');
  if (present.length === 0) {
    return {
      ...empty,
      classification: 'NO_SOURCE_VALUE',
      reason: 'no preserved source line exists for this row (legacy_data is empty and the record is not present in platform_state JSON)',
      preservedFields,
      unresolvedFields: missingFields,
    };
  }

  // Verify every located candidate. A single disagreeing candidate is enough to
  // stop: it means at least one of the identities we trusted is wrong, and this
  // is exactly the situation where guessing would corrupt a document.
  for (const c of present) {
    const v = verifyCandidate(rel, c.line);
    if (!v.ok) {
      return {
        ...empty,
        classification: 'MISMATCH',
        reason: `${c.origin} source located via ${c.identity} but it does not verify: ${v.reason}`,
        sourceOrigin: c.origin,
        sourceIdentity: c.identity,
        preservedFields,
        unresolvedFields: missingFields,
      };
    }
  }

  // Two verified sources that DISAGREE about a value is ambiguity, not a
  // mismatch — both look like this line, so there is no basis to prefer one.
  // Agreement between them is not ambiguity; it is corroboration.
  const readings = present.map((c) => ({ c, fields: readSourceFields(c.line) }));
  for (const f of missingFields) {
    const values = readings
      .map((r) => r.fields[f])
      .filter((v) => v !== undefined);
    const distinct = Array.from(new Set(values.map((v) => JSON.stringify(v))));
    if (distinct.length > 1) {
      return {
        ...empty,
        classification: 'AMBIGUOUS',
        reason: `preserved sources disagree about "${f}" (${distinct.join(' vs ')}) — no deterministic value`,
        sourceOrigin: readings[0].c.origin,
        sourceIdentity: readings.map((r) => r.c.identity).join(' / '),
        preservedFields,
        unresolvedFields: missingFields,
      };
    }
  }

  // Prefer the strongest source that actually carries something.
  const ordered = readings.slice().sort((a, b) =>
    (a.c.origin === 'legacy_data' ? 0 : 1) - (b.c.origin === 'legacy_data' ? 0 : 1));

  const proposed: Partial<Record<Migration013Field, number | string | boolean>> = {};
  let chosen: typeof ordered[number] | null = null;
  for (const f of missingFields) {
    for (const r of ordered) {
      const v = r.fields[f];
      if (v !== undefined) {
        proposed[f] = v;
        if (!chosen) chosen = r;
        break;
      }
    }
  }

  const unresolvedFields = missingFields.filter((f) => proposed[f] === undefined);

  if (Object.keys(proposed).length === 0) {
    return {
      ...empty,
      classification: 'NO_SOURCE_VALUE',
      reason: 'the preserved source verifies against this line but records no value for any missing migration-013 field — these were genuinely never captured',
      sourceOrigin: ordered[0].c.origin,
      sourceIdentity: ordered[0].c.identity,
      preservedFields,
      unresolvedFields,
    };
  }

  return {
    classification: 'SAFE_TO_RECOVER',
    reason: `verified preserved source found via ${chosen!.c.identity}; only currently-NULL fields would be filled`,
    sourceOrigin: chosen!.c.origin,
    sourceIdentity: chosen!.c.identity,
    proposed,
    preservedFields,
    unresolvedFields,
    changesValue: FINANCIAL_013_FIELDS.some((f) => proposed[f] !== undefined),
  };
}

// ── DB-reading analysis (SELECT only) ───────────────────────────────────────

export interface AnalyzedLine extends LineRecoveryVerdict {
  collection: 'quote' | 'job';
  documentId: number;
  documentNumber: string;
  companyCode: string;
  lineId: number;
  lineIndex: number;
  description: string | null;
  /** The line's value today, and what it would become if the proposal were applied. */
  currentLineValue: number;
  recoveredLineValue: number;
}

export interface Migration013RecoveryReport {
  generatedFor: { quotes: number; jobs: number };
  summary: Record<RecoveryClassification, number>;
  /** Rows whose recovery would change money, listed separately for review. */
  valueChangingLines: AnalyzedLine[];
  lines: AnalyzedLine[];
  documentAmbiguities: string[];
}

function jsonArray(data: any, key: string): any[] {
  const v = data ? data[key] : undefined;
  return Array.isArray(v) ? v : [];
}

/** Locates the ONE platform_state JSON record for a relational document, or
 *  reports why it could not. source_id is the identity backfill itself wrote,
 *  so it is tried first; (number + company) is the documented fallback. */
export function findJsonDocument(
  records: any[],
  sourceId: string | null,
  documentNumber: string,
  companyCode: string,
  numberKey: string
): { record: any | null; identity: string; ambiguous: boolean; reason: string } {
  const wanted = sourceId === null ? null : String(restoreId(sourceId));
  if (wanted !== null) {
    const byId = records.filter((r) => r && r.id !== undefined && r.id !== null && String(r.id) === wanted);
    if (byId.length === 1) return { record: byId[0], identity: `source_id=${sourceId}`, ambiguous: false, reason: '' };
    if (byId.length > 1) {
      return { record: null, identity: `source_id=${sourceId}`, ambiguous: true, reason: `platform_state JSON holds ${byId.length} records with id ${wanted}` };
    }
  }
  const target = String(documentNumber || '').trim().toUpperCase();
  const byNumber = records.filter((r) => r && String(r[numberKey] || '').trim().toUpperCase() === target);
  if (byNumber.length === 1) {
    const rec = byNumber[0];
    const recCo = rec.co === undefined || rec.co === null ? null : String(rec.co);
    if (recCo !== null && String(companyCode) !== recCo) {
      return { record: null, identity: `${numberKey}=${documentNumber}`, ambiguous: true, reason: `document number matches but company differs (relational ${companyCode} vs JSON ${recCo})` };
    }
    return { record: rec, identity: `${numberKey}=${documentNumber}`, ambiguous: false, reason: '' };
  }
  if (byNumber.length > 1) {
    return { record: null, identity: `${numberKey}=${documentNumber}`, ambiguous: true, reason: `platform_state JSON holds ${byNumber.length} records numbered ${documentNumber}` };
  }
  return { record: null, identity: 'none', ambiguous: false, reason: 'not present in platform_state JSON' };
}

/** Locates the ONE JSON line for a relational line. Positional identity first
 *  (backfill wrote line_index = array index); a UNIQUE description+qty+price
 *  match is the only fallback, and non-uniqueness is AMBIGUOUS, never a guess. */
export function findJsonLine(
  jsonLines: any[],
  rel: RelationalLineSnapshot
): { line: any | null; identity: string; ambiguous: boolean; reason: string } {
  if (rel.lineIndex >= 0 && rel.lineIndex < jsonLines.length) {
    return { line: jsonLines[rel.lineIndex], identity: `line_index=${rel.lineIndex}`, ambiguous: false, reason: '' };
  }
  const matches = jsonLines.filter((l) =>
    l && sameText(rel.description, l.desc ?? l.description) &&
    sameNumber(rel.qty, l.qty) && sameNumber(rel.unitPrice, l.unitPrice));
  if (matches.length === 1) {
    return { line: matches[0], identity: 'unique description+qty+unitPrice', ambiguous: false, reason: '' };
  }
  if (matches.length > 1) {
    return { line: null, identity: 'description+qty+unitPrice', ambiguous: true, reason: `${matches.length} JSON lines match this line's description, qty and unit price — position is out of range, so identity cannot be resolved` };
  }
  return { line: null, identity: 'none', ambiguous: false, reason: 'no JSON line at this position and none matching this line' };
}

/** pieces x qty x unitPrice, with NULL/<=0 pieces read as 1 — the same rule
 *  services.ts's lineSubtotal applies, restated here so this module stays
 *  dependency-light and side-effect-free. */
export function lineValue(pieces: number | null | undefined, qty: number, unitPrice: number): number {
  const p = pieces === null || pieces === undefined || pieces <= 0 ? 1 : pieces;
  return p * (Number(qty) || 0) * (Number(unitPrice) || 0);
}

// ── THE ONE MATCHING ALGORITHM ──────────────────────────────────────────────
// Three things now need to know "what was this line's historical piece count?":
// the whole-database analysis report below, the per-document resolver invoice
// creation consults (resolveDocument013ForInvoicing), and the one-record repair
// script. All three go through the helpers in this block. There is deliberately
// no second implementation anywhere — a repair that matches differently from
// the analysis that authorised it, or an invoice writer that matches
// differently from either, is a second source of truth waiting to drift.

/** The document-level half of the identity: which JSON record (if any) is this
 *  relational document, and was that resolvable deterministically? */
export interface JsonDocumentMatch {
  record: any | null; identity: string; ambiguous: boolean; reason: string; jsonLines: any[];
}
export function matchJsonDocument(
  jsonRecords: any[], sourceId: string | null, documentNumber: string, companyCode: string, jsonNumberKey: string
): JsonDocumentMatch {
  const found = findJsonDocument(jsonRecords, sourceId, documentNumber, companyCode, jsonNumberKey);
  return {
    ...found,
    jsonLines: found.record && Array.isArray(found.record.lines) ? found.record.lines : [],
  };
}

/** The line-level half: assemble S1 (the row's own legacy_data) and S2 (the
 *  located JSON record's line) into the candidate list classifyLineRecovery
 *  consumes. `lineTableLabel` only ever appears in the audit trail. */
export function buildLineCandidates(
  rel: RelationalLineSnapshot, legacyData: unknown, doc: JsonDocumentMatch, lineTableLabel: string
): RecoveryCandidate[] {
  const candidates: RecoveryCandidate[] = [];

  // S1 — the row's own preserved JSON line.
  const legacyUsable = legacyData && typeof legacyData === 'object' && !Array.isArray(legacyData)
    && Object.keys(legacyData as object).length > 0;
  if (legacyUsable) {
    candidates.push({
      origin: 'legacy_data',
      identity: `${lineTableLabel}.legacy_data (line id ${rel.lineId})`,
      line: legacyData as Record<string, unknown>,
    });
  }

  // S2 — platform_state JSON, only when the document itself resolved.
  if (doc.ambiguous) {
    candidates.push({
      origin: 'platform_state_json', identity: doc.identity, line: null,
      ambiguous: true, ambiguityReason: doc.reason,
    });
  } else if (doc.record) {
    const jl = findJsonLine(doc.jsonLines, rel);
    if (jl.ambiguous) {
      candidates.push({
        origin: 'platform_state_json', identity: `${doc.identity} / ${jl.identity}`, line: null,
        ambiguous: true, ambiguityReason: jl.reason,
      });
    } else if (jl.line) {
      candidates.push({ origin: 'platform_state_json', identity: `${doc.identity} / ${jl.identity}`, line: jl.line });
    }
  }
  return candidates;
}

/** Turn a line row (as SELECTed by LINE_SELECT_013) into the snapshot shape
 *  every classification function takes. One place, so column-to-field naming
 *  cannot drift between the analysis, the invoicing resolver and the repair. */
export function toLineSnapshot(row: any): RelationalLineSnapshot {
  return {
    lineId: Number(row.id),
    lineIndex: Number(row.line_index),
    description: row.description,
    qty: Number(row.qty),
    unitPrice: Number(row.unit_price),
    inventorySourceId: row.inventory_source_id ?? null,
    pieces: row.pieces === null || row.pieces === undefined ? null : Number(row.pieces),
    sqmL: row.sqm_l === null || row.sqm_l === undefined ? null : Number(row.sqm_l),
    sqmW: row.sqm_w === null || row.sqm_w === undefined ? null : Number(row.sqm_w),
    cpId: row.complete_product_source_id ?? null,
    cpLinked: row.complete_product_linked ?? null,
  };
}

/** The columns every 013 consumer needs off a line row. */
export const LINE_SELECT_013 =
  `id, line_index, description, qty, unit_price, inventory_source_id,
   pieces, sqm_l, sqm_w, complete_product_source_id, complete_product_linked, legacy_data`;

// ── PER-DOCUMENT RESOLUTION FOR INVOICE CREATION ────────────────────────────
// 2026-08-25 — HISTORICAL PIECES PROTECTION.
//
// THE DEFECT THIS EXISTS TO CLOSE, confirmed in production as SQ-00150 ->
// INV-00111. The invoice writers price a source line as pieces x qty x
// unitPrice and read a NULL `pieces` as 1 — which is correct for a line that
// genuinely never had a piece count, and WRONG for a line that had one before
// 013 added the column. SQ-00150's line really was 4 x 2 x R1,600 = R12,800;
// its relational `pieces` is NULL, so the invoice was written as 1 x 2 x R1,600
// = R3,200, and INV-00111 came out at R4,542.50 against a R15,582.50 quote.
//
// The historical value was not destroyed — it survives in legacy_data and in
// the frozen platform_state JSON, which is exactly what this module already
// knows how to match deterministically. This resolver puts that knowledge in
// front of the invoice writers.
//
// APPROACH B — RESOLVE AT INVOICE TIME, NEVER MUTATE THE SOURCE. The
// alternative (write the recovered value back onto the quote/job line first,
// then invoice normally) was rejected: it turns invoicing into an incremental
// historical backfill, bumps the source document's row_version so every open
// editor 409s, and — where a quote's stored header total was itself computed on
// the old basis — would leave the header and its own lines disagreeing with no
// one having asked for that. Resolving at invoice time changes exactly one
// thing, the document being created, and leaves every historical record byte
// for byte as it was. The separately-approved one-record repair script is the
// only thing that ever writes a recovered value back.
export interface LineResolution013 {
  lineId: number;
  lineIndex: number;
  description: string | null;
  qty: number;
  unitPrice: number;
  /** What the column says today — null means the column is empty. */
  currentPieces: number | null;
  /** The piece count invoicing MUST use for this line. */
  effectivePieces: number;
  /** Where effectivePieces came from. */
  piecesSource: 'column' | 'recovered' | 'default-1';
  verdict: LineRecoveryVerdict;
  /** True when this line's VALUE depends on a historical piece count that could
   *  not be resolved deterministically — the only case that refuses invoicing. */
  blocking: boolean;
  blockingReason: string | null;
}

export interface Document013Resolution {
  kind: 'quote' | 'job';
  documentId: number;
  documentNumber: string;
  companyCode: string;
  lines: LineResolution013[];
  /** Lines that refuse invoicing (MISMATCH / AMBIGUOUS with pieces still NULL). */
  blocked: LineResolution013[];
  /** Lines whose piece count came from a recovered historical value. */
  recovered: LineResolution013[];
}

const COLLECTION_META = {
  quote: { docTable: 'rel_quotes', lineTable: 'rel_quote_line_items', numberCol: 'quote_number', fk: 'quote_id', jsonKey: 'quotes' },
  job: { docTable: 'rel_jobs', lineTable: 'rel_job_line_items', numberCol: 'job_number', fk: 'job_id', jsonKey: 'jobs' },
} as const;

/**
 * Resolve ONE document's lines, on the caller's own client so it participates
 * in the caller's transaction and sees the rows the caller has locked. SELECTs
 * only — this function never writes, in any mode.
 */
export async function resolveDocument013ForInvoicing(
  client: { query: (sql: string, params?: any[]) => Promise<any> },
  kind: 'quote' | 'job',
  documentId: number
): Promise<Document013Resolution> {
  const meta = COLLECTION_META[kind];
  const docRes = await client.query(
    `SELECT id, source_id, ${meta.numberCol} AS document_number, company_code FROM ${meta.docTable} WHERE id = $1`,
    [documentId]
  );
  if (docRes.rowCount === 0) {
    throw new Error(`${kind} ${documentId} not found while resolving migration-013 fields`);
  }
  const doc = docRes.rows[0];

  const linesRes = await client.query(
    `SELECT ${LINE_SELECT_013} FROM ${meta.lineTable} WHERE ${meta.fk} = $1 ORDER BY line_index`,
    [documentId]
  );

  const stateRes = await client.query('SELECT data FROM platform_state WHERE id = 1');
  const data = stateRes.rowCount ? stateRes.rows[0].data : {};
  const jsonMatch = matchJsonDocument(
    jsonArray(data, meta.jsonKey), doc.source_id, doc.document_number, String(doc.company_code), 'num'
  );

  const lines: LineResolution013[] = [];
  for (const row of linesRes.rows) {
    const rel = toLineSnapshot(row);
    const candidates = buildLineCandidates(rel, row.legacy_data, jsonMatch, meta.lineTable);
    const verdict = classifyLineRecovery(rel, candidates);

    let effectivePieces: number;
    let piecesSource: LineResolution013['piecesSource'];
    if (rel.pieces !== null && rel.pieces > 0) {
      // ALREADY_SET for the purposes that matter here: a non-NULL column value
      // is authoritative and is never second-guessed by a historical source.
      effectivePieces = rel.pieces;
      piecesSource = 'column';
    } else {
      const proposed = optionalNum(verdict.proposed.pieces);
      if (verdict.classification === 'SAFE_TO_RECOVER' && proposed !== null && proposed > 0) {
        effectivePieces = proposed;
        piecesSource = 'recovered';
      } else {
        // NO_SOURCE_VALUE, or a source that records no piece count: the
        // documented compatibility default. This is the ONLY case in which
        // NULL still reads as 1, and it is correct — there is no evidence a
        // piece count was ever recorded for this line.
        effectivePieces = 1;
        piecesSource = 'default-1';
      }
    }

    // A MISMATCH or AMBIGUOUS verdict only REFUSES invoicing when the line's
    // money actually depends on the unresolved value — i.e. `pieces` is still
    // NULL. If pieces is already set, the unresolved field is a dimension or a
    // complete-product link, which changes nothing financial, and refusing to
    // invoice over it would be an obstruction rather than a protection.
    const unresolvedFinancial = rel.pieces === null
      && (verdict.classification === 'MISMATCH' || verdict.classification === 'AMBIGUOUS');

    lines.push({
      lineId: rel.lineId, lineIndex: rel.lineIndex, description: rel.description,
      qty: rel.qty, unitPrice: rel.unitPrice,
      currentPieces: rel.pieces, effectivePieces, piecesSource, verdict,
      blocking: unresolvedFinancial,
      blockingReason: unresolvedFinancial
        ? `line ${rel.lineIndex} ("${rel.description ?? ''}") has no piece count of its own and its preserved historical source is ${verdict.classification}: ${verdict.reason}`
        : null,
    });
  }

  return {
    kind, documentId: Number(doc.id), documentNumber: String(doc.document_number),
    companyCode: String(doc.company_code), lines,
    blocked: lines.filter((l) => l.blocking),
    recovered: lines.filter((l) => l.piecesSource === 'recovered'),
  };
}

/** Convenience for the writers: lineId -> effective pieces. */
export function effectivePiecesByLineId(res: Document013Resolution): Map<number, number> {
  const m = new Map<number, number>();
  for (const l of res.lines) m.set(l.lineId, l.effectivePieces);
  return m;
}

export async function analyzeMigration013Recovery(): Promise<Migration013RecoveryReport> {
  const stateRes = await pool.query('SELECT data FROM platform_state WHERE id = 1');
  const data = stateRes.rowCount ? stateRes.rows[0].data : {};
  const jsonQuotes = jsonArray(data, 'quotes');
  const jsonJobs = jsonArray(data, 'jobs');

  const lines: AnalyzedLine[] = [];
  const documentAmbiguities: string[] = [];
  const summary: Record<RecoveryClassification, number> = {
    SAFE_TO_RECOVER: 0, NO_SOURCE_VALUE: 0, AMBIGUOUS: 0, MISMATCH: 0, ALREADY_SET: 0,
  };

  const collections: Array<{
    kind: 'quote' | 'job'; docTable: string; lineTable: string; numberCol: string;
    fk: string; jsonRecords: any[]; jsonNumberKey: string;
  }> = [
    { kind: 'quote', docTable: 'rel_quotes', lineTable: 'rel_quote_line_items', numberCol: 'quote_number', fk: 'quote_id', jsonRecords: jsonQuotes, jsonNumberKey: 'num' },
    { kind: 'job', docTable: 'rel_jobs', lineTable: 'rel_job_line_items', numberCol: 'job_number', fk: 'job_id', jsonRecords: jsonJobs, jsonNumberKey: 'num' },
  ];

  for (const c of collections) {
    const docsRes = await pool.query(
      `SELECT id, source_id, ${c.numberCol} AS document_number, company_code FROM ${c.docTable} ORDER BY id`
    );
    for (const doc of docsRes.rows) {
      const linesRes = await pool.query(
        `SELECT ${LINE_SELECT_013} FROM ${c.lineTable} WHERE ${c.fk} = $1 ORDER BY line_index`,
        [doc.id]
      );
      if (linesRes.rowCount === 0) continue;

      // The SAME document/line matching the invoicing resolver and the repair
      // script use — see "THE ONE MATCHING ALGORITHM" above.
      const found = matchJsonDocument(
        c.jsonRecords, doc.source_id, doc.document_number, String(doc.company_code), c.jsonNumberKey
      );
      if (found.ambiguous) {
        documentAmbiguities.push(`${c.kind} ${doc.document_number} (rel id ${doc.id}): ${found.reason}`);
      }

      for (const row of linesRes.rows) {
        const rel = toLineSnapshot(row);
        const candidates = buildLineCandidates(rel, row.legacy_data, found, c.lineTable);
        const verdict = classifyLineRecovery(rel, candidates);
        summary[verdict.classification]++;

        const proposedPieces = verdict.proposed.pieces === undefined ? rel.pieces : Number(verdict.proposed.pieces);
        lines.push({
          ...verdict,
          collection: c.kind,
          documentId: Number(doc.id),
          documentNumber: doc.document_number,
          companyCode: String(doc.company_code),
          lineId: rel.lineId,
          lineIndex: rel.lineIndex,
          description: rel.description,
          currentLineValue: lineValue(rel.pieces, rel.qty, rel.unitPrice),
          recoveredLineValue: lineValue(proposedPieces, rel.qty, rel.unitPrice),
        });
      }
    }
  }

  return {
    generatedFor: { quotes: jsonQuotes.length, jobs: jsonJobs.length },
    summary,
    valueChangingLines: lines.filter((l) => l.changesValue),
    lines,
    documentAmbiguities,
  };
}

/** Human-readable report. Analysis only — it proposes, it never applies. */
export function formatMigration013RecoveryReport(report: Migration013RecoveryReport): string {
  const out: string[] = [];
  out.push('==============================================================');
  out.push(' SIGNACORE — MIGRATION-013 HISTORICAL FIELD RECOVERY ANALYSIS');
  out.push(' ANALYSIS ONLY — this tool has no apply path and writes nothing');
  out.push('==============================================================');
  out.push(` platform_state JSON records read : ${report.generatedFor.quotes} quotes, ${report.generatedFor.jobs} jobs`);
  out.push('');
  out.push(' Classification summary');
  for (const k of Object.keys(report.summary) as RecoveryClassification[]) {
    out.push(`   ${k.padEnd(16)} ${report.summary[k]}`);
  }
  out.push('');
  out.push(` Lines whose recovery would CHANGE VALUE: ${report.valueChangingLines.length}`);
  for (const l of report.valueChangingLines) {
    out.push(`   ${l.collection} ${l.documentNumber} line ${l.lineIndex} (${l.description ?? ''})`);
    out.push(`     pieces NULL -> ${l.proposed.pieces}   line value ${l.currentLineValue.toFixed(2)} -> ${l.recoveredLineValue.toFixed(2)}`);
    out.push(`     source: ${l.sourceOrigin} via ${l.sourceIdentity}`);
  }
  const needsPerson = report.lines.filter((l) => l.classification === 'AMBIGUOUS' || l.classification === 'MISMATCH');
  out.push('');
  out.push(` Lines needing a person (AMBIGUOUS / MISMATCH): ${needsPerson.length}`);
  for (const l of needsPerson) {
    out.push(`   [${l.classification}] ${l.collection} ${l.documentNumber} line ${l.lineIndex}: ${l.reason}`);
  }
  if (report.documentAmbiguities.length) {
    out.push('');
    out.push(' Document-level ambiguities');
    for (const a of report.documentAmbiguities) out.push(`   ${a}`);
  }
  out.push('');
  out.push(' NOTHING WAS CHANGED. A repair, if approved, is separate work that');
  out.push(' would consume this report — it cannot be run from this tool.');
  return out.join('\n');
}

if (require.main === module) {
  analyzeMigration013Recovery()
    .then((r) => {
      console.log(formatMigration013RecoveryReport(r));
      return pool.end();
    })
    .catch(async (err) => {
      console.error('[migration-013-recovery] analysis failed:', err && err.message ? err.message : err);
      process.exitCode = 1;
      await pool.end().catch(() => undefined);
    });
}
