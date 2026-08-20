/**
 * Relational cutover gate.
 *
 * TWO independent switches must BOTH be true for a section to be treated as
 * relational-authoritative anywhere in the backend:
 *
 *   1. process.env.RELATIONAL_AUTHORITY_ENABLED === 'true'   (master switch —
 *      absent/unset/anything else = OFF; must be set explicitly in the
 *      environment, never defaulted on by code)
 *   2. relational_cutover.enabled = true for that specific section, in the
 *      database (see database/migrations/007_relational_core.sql — every
 *      row is seeded FALSE)
 *
 * Requiring BOTH means:
 *   - a bad/forgotten env var in one Render environment can't silently
 *     inherit an "enabled" state some OTHER environment's database rows
 *     might carry (e.g. never accidentally treat a copied/restored database
 *     as live-authoritative just because its rows say so);
 *   - flipping a database row alone (e.g. by a stray manual UPDATE) can never
 *     enable authority in an environment that hasn't also had the env var
 *     set — deployment/config always has to agree with data state.
 *
 * Neither switch is ever flipped by migration, backfill, reconciliation, or
 * deploy code — only a human, explicitly, via the commands in the handoff
 * document (UPDATE relational_cutover SET enabled = true ... AND setting the
 * env var in Render's dashboard, both deliberate actions).
 */
import { query } from '../db/pool';

export const ALL_SECTIONS = [
  'customers', 'suppliers', 'inventory', 'quickRates', 'quotes', 'jobs',
  'accInvoices', 'payments', 'creditNotes', 'purchaseOrders', 'employees',
  'leaveRequests', 'disciplinary',
] as const;
export type CutoverSection = (typeof ALL_SECTIONS)[number];

function masterSwitchEnabled(): boolean {
  return process.env.RELATIONAL_AUTHORITY_ENABLED === 'true';
}

/** True only if BOTH the env master switch AND the DB row for this section say enabled. */
export async function isSectionCutOver(section: CutoverSection): Promise<boolean> {
  if (!masterSwitchEnabled()) return false;
  const res = await query('SELECT enabled FROM relational_cutover WHERE section = $1', [section]);
  return (res.rowCount ?? 0) > 0 && res.rows[0].enabled === true;
}

/** Bulk version — one round trip, used by platformState.ts on every save. */
export async function cutOverSections(): Promise<Set<CutoverSection>> {
  const out = new Set<CutoverSection>();
  if (!masterSwitchEnabled()) return out; // master switch off -> nothing is ever cut over, full stop
  const res = await query('SELECT section, enabled FROM relational_cutover WHERE enabled = true');
  for (const row of res.rows) out.add(row.section as CutoverSection);
  return out;
}
