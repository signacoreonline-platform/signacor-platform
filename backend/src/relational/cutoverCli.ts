/**
 * Cutover-control CLI. Stage 2 Phase 8.
 *
 * SAFE BY CONSTRUCTION:
 *   - Default action (no args, or `status`) is READ-ONLY: prints the
 *     current per-section cutover state and a fresh reconciliation
 *     summary. Never writes anything.
 *   - `enable <section>` / `disable <section>` are the ONLY mutating
 *     commands, and BOTH require --apply plus an exact, section-specific
 *     confirmation phrase (--confirm=...). Without both, the command
 *     prints exactly what it WOULD do and exits without changing anything
 *     (a safe dry-run preview, not silently accepted).
 *   - `enable` additionally REFUSES unless a fresh reconciliation run
 *     reports safeToCutOver=true for that exact section right now (never
 *     a cached/stale reconciliation result — this CLI always re-runs it).
 *   - `customers` and `quickRates` are HARD-BLOCKED from `enable` in this
 *     CLI, unconditionally, with no override flag of any kind — per the
 *     migration brief, these two sections carry historical duplicate-id
 *     collisions that must never be "fixed" or cut over, regardless of
 *     what any future reconciliation run might report.
 *   - There is deliberately NO `--enable-all`, `enable-all`, or wildcard
 *     section argument anywhere in this file. Every enable/disable
 *     targets exactly one named section.
 *   - This CLI only ever flips the per-section DATABASE half of the
 *     double gate (see cutover.ts). It NEVER touches, sets, or reports
 *     needing to touch RELATIONAL_AUTHORITY_ENABLED for you — that is a
 *     separate, deliberate human action in the deploy environment (e.g.
 *     Render's dashboard), by design, so this tool alone can never fully
 *     enable anything.
 *
 * USAGE (compiled — run from backend/, after `npm run build`):
 *   node dist/relational/cutoverCli.js status
 *   node dist/relational/cutoverCli.js enable jobs --apply --confirm=ENABLE_JOBS
 *   node dist/relational/cutoverCli.js disable jobs --apply --confirm=DISABLE_JOBS_ACKNOWLEDGE_JSON_IS_STALE
 *
 * or via the npm script wrappers in package.json:
 *   npm run relational:cutover -- status
 *   npm run relational:cutover -- enable jobs --apply --confirm=ENABLE_JOBS
 */
import pool from '../db/pool';
import { ALL_SECTIONS, CutoverSection } from './cutover';
import { runReconciliation } from './reconcile';
import { describeConnectionError } from '../db/ssl';

const HARD_BLOCKED_SECTIONS = new Set<string>(['customers', 'quickRates']);

// ══════════════════════════════════════════════════════════════════════
// STAGE 3 — DEPENDENCY-AWARE CUTOVER (2026-08-20)
// ══════════════════════════════════════════════════════════════════════
// Some sections cannot be safely enabled in isolation because a REAL
// operation on them writes into OTHER sections' relational tables too.
// The clearest example: services.ts's convertQuoteToJob (quote -> job)
// creates a job and deducts inventory, in ONE transaction, whenever a quote
// is converted — regardless of which sections are cut over. If "quotes" is
// enabled but "jobs" is not, that job still gets created in rel_jobs, but
// the live JSON-rendered app (which reads jobs from platform_state, since
// "jobs" isn't cut over) would never show it — a real record silently
// invisible to every normal user, not corrupted, just unreachable. Same
// story for inventory (stock deducted, but the JSON inventory view stays
// stale/wrong).
//
// 2026-08-21 PURCHASE ORDER MIGRATION POLICY CHANGE: convertQuoteToJob no
// longer auto-generates purchase orders at all (see services.ts) — the
// invisible-auto-PO risk this dependency group used to guard against for
// "purchaseOrders" no longer exists, so "purchaseOrders" has been removed
// from quotes' `requires` below. purchaseOrders can now be enabled fully
// independently of quotes/jobs — it is an explicit, user-approved
// migration-policy section (historical POs intentionally excluded, see
// backfill.ts) whose own readiness is judged purely on its own manual-
// workflow correctness, not on quote-conversion side effects.
//
// Rather than have the operator remember this, `enable <section>` REFUSES
// if any of that section's required dependencies are not ALREADY enabled.
// This is deliberately NOT an --enable-all: it forces the operator to run
// enable for jobs and inventory individually (each with its own explicit
// --confirm=ENABLE_<SECTION> phrase and its own fresh reconciliation check)
// BEFORE quotes can be enabled — one named, explicit, auditable step per
// section, never a bundled/blanket action.
const DEPENDENCY_GROUPS: Record<string, { requires: string[]; reason: string }> = {
  quotes: {
    requires: ['jobs', 'inventory'],
    reason:
      'Quote -> Job conversion (services.ts convertQuoteToJob) creates a job and deducts inventory in the SAME transaction as the conversion itself — regardless of which sections are cut over. If jobs/inventory are not ALSO relational-authoritative, those writes still happen but become invisible to the live JSON-rendered app (a real job/stock-adjustment existing in the database with no code path that ever surfaces it to a user). Enable jobs and inventory individually FIRST (each with its own --confirm phrase), then enable quotes. (purchaseOrders is no longer part of this dependency group — convertQuoteToJob no longer creates purchase orders at all.)',
  },
};

function missingDependencies(section: string, enabledSections: Set<string>): string[] {
  const group = DEPENDENCY_GROUPS[section];
  if (!group) return [];
  return group.requires.filter((dep) => !enabledSections.has(dep));
}

function confirmPhraseFor(action: 'enable' | 'disable', section: string): string {
  return action === 'enable'
    ? `ENABLE_${section.toUpperCase()}`
    : `DISABLE_${section.toUpperCase()}_ACKNOWLEDGE_JSON_IS_STALE`;
}

async function printStatus(): Promise<void> {
  const masterSwitch = process.env.RELATIONAL_AUTHORITY_ENABLED === 'true';
  console.log(`RELATIONAL_AUTHORITY_ENABLED (env, this process) = ${masterSwitch ? 'true' : 'false / unset'}`);
  console.log(masterSwitch
    ? '  -> master switch is ON in this process — a section is authoritative here iff its DB row below is also enabled.'
    : '  -> master switch is OFF in this process — NOTHING is relational-authoritative here regardless of the DB rows below.');
  console.log('');
  const res = await pool.query('SELECT section, enabled, enabled_at, enabled_by, notes FROM relational_cutover ORDER BY section');
  console.log('Per-section DB flag (relational_cutover table):');
  for (const row of res.rows) {
    const blocked = HARD_BLOCKED_SECTIONS.has(row.section) ? '  [HARD-BLOCKED from enable by this CLI]' : '';
    console.log(`  ${row.section.padEnd(16)} enabled=${String(row.enabled).padEnd(5)} enabled_at=${row.enabled_at || '—'} enabled_by=${row.enabled_by || '—'}${blocked}`);
  }
  console.log('');
  console.log('Fresh reconciliation summary (read-only, always re-run — never cached):');
  const { sections } = await runReconciliation({});
  for (const s of sections) {
    console.log(`  ${s.collection.padEnd(16)} safeToCutOver=${s.safeToCutOver ? 'YES' : 'NO '}  match=${s.match} different=${s.different} missing=${s.missingInRelational} extra=${s.extraInRelational} quarantined=${s.quarantined} financialMismatches=${s.financialMismatches.length}`);
  }
}

async function enableSection(section: string, apply: boolean, confirm: string | undefined): Promise<void> {
  if (!(ALL_SECTIONS as readonly string[]).includes(section)) {
    console.error(`Unknown section "${section}". Valid sections: ${ALL_SECTIONS.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  if (HARD_BLOCKED_SECTIONS.has(section)) {
    console.error(`REFUSED: "${section}" is permanently blocked from cutover by this tool (known historical duplicate-source-id collisions — see migration handoff). This is not a flag to override; resolving those collisions is a separate, deliberate, out-of-scope task.`);
    process.exitCode = 1;
    return;
  }

  const enabledRes = await pool.query('SELECT section FROM relational_cutover WHERE enabled = true');
  const enabledSections = new Set<string>(enabledRes.rows.map((r) => r.section));
  const missing = missingDependencies(section, enabledSections);
  if (missing.length > 0) {
    const group = DEPENDENCY_GROUPS[section];
    console.error(`REFUSED: "${section}" cannot be safely enabled yet — it depends on: ${missing.join(', ')} (not yet enabled).`);
    console.error(`  Reason: ${group.reason}`);
    console.error(`  Enable each dependency individually first, e.g.: relational:cutover -- enable ${missing[0]} --apply --confirm=ENABLE_${missing[0].toUpperCase()}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Re-running reconciliation for "${section}" (always fresh, never cached)...`);
  const { sections } = await runReconciliation({});
  const report = sections.find((s) => s.collection === section);
  if (!report) {
    console.error(`REFUSED: no reconciliation report was produced for "${section}" — refusing to enable without a verified-safe report.`);
    process.exitCode = 1;
    return;
  }
  if (!report.safeToCutOver) {
    console.error(`REFUSED: reconciliation reports "${section}" is NOT safe to cut over right now:`);
    for (const r of report.reasons) console.error(`  - ${r}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Reconciliation OK for "${section}" (${report.match} matched, 0 discrepancies).`);

  const expectedConfirm = confirmPhraseFor('enable', section);
  if (!apply || confirm !== expectedConfirm) {
    console.log('');
    console.log(`DRY RUN (nothing changed). To actually enable "${section}", re-run with BOTH:`);
    console.log(`  --apply --confirm=${expectedConfirm}`);
    console.log('');
    console.log(`REMINDER: flipping this DB row alone does NOT make "${section}" relational-authoritative anywhere.`);
    console.log(`RELATIONAL_AUTHORITY_ENABLED=true must ALSO be set in that deploy environment (e.g. Render dashboard) — a separate, deliberate step this CLI never performs for you.`);
    return;
  }

  await pool.query(
    `UPDATE relational_cutover SET enabled = true, enabled_at = NOW(), enabled_by = $2, notes = $3 WHERE section = $1`,
    [section, process.env.USER || process.env.USERNAME || 'cutoverCli', `Enabled via cutoverCli after reconciliation showed 0 discrepancies (match=${report.match}).`]
  );
  console.log(`DONE: relational_cutover.${section}.enabled = true.`);
  console.log(`REMINDER: this alone does nothing in an environment where RELATIONAL_AUTHORITY_ENABLED is not also "true". Set that separately, deliberately, when actually ready to cut over.`);
}

async function disableSection(section: string, apply: boolean, confirm: string | undefined): Promise<void> {
  if (!(ALL_SECTIONS as readonly string[]).includes(section)) {
    console.error(`Unknown section "${section}". Valid sections: ${ALL_SECTIONS.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  const expectedConfirm = confirmPhraseFor('disable', section);
  if (!apply || confirm !== expectedConfirm) {
    console.log(`DRY RUN (nothing changed).`);
    console.log(`WARNING: disabling "${section}" makes platform_state.data's FROZEN copy of that section authoritative again. Any relational-only writes made while "${section}" was cut over are NOT reflected in that frozen copy and will appear to vanish from the live app the moment you disable.`);
    console.log(`To actually disable "${section}", re-run with BOTH:`);
    console.log(`  --apply --confirm=${expectedConfirm}`);
    return;
  }
  await pool.query(
    `UPDATE relational_cutover SET enabled = false, notes = $2 WHERE section = $1`,
    [section, `Disabled via cutoverCli by ${process.env.USER || process.env.USERNAME || 'unknown'} — operator acknowledged JSON copy may be stale.`]
  );
  console.log(`DONE: relational_cutover.${section}.enabled = false. JSON (platform_state.data.${section}) is authoritative again — it may be stale relative to relational writes made during cutover.`);
}

// Exported (not just run as a CLI) so the Stage 2 test suite can call the
// exact same entrypoint in-process and assert on the resulting DATABASE
// state, rather than only scraping console output. Deliberately does NOT
// close the shared pool itself (see the require.main block below) — a
// caller that imports this module and invokes main() repeatedly (as the
// test suite does) must not have the shared pool torn down after the
// first call.
export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || 'status';
  const apply = args.includes('--apply');
  const confirmArg = args.find((a) => a.startsWith('--confirm='));
  const confirm = confirmArg ? confirmArg.slice('--confirm='.length) : undefined;

  if (command === 'status') {
    await printStatus();
  } else if (command === 'enable') {
    const section = args[1];
    if (!section || section.startsWith('--')) {
      console.error('Usage: cutoverCli enable <section> --apply --confirm=ENABLE_<SECTION>');
      process.exitCode = 1;
    } else {
      await enableSection(section, apply, confirm);
    }
  } else if (command === 'disable') {
    const section = args[1];
    if (!section || section.startsWith('--')) {
      console.error('Usage: cutoverCli disable <section> --apply --confirm=DISABLE_<SECTION>_ACKNOWLEDGE_JSON_IS_STALE');
      process.exitCode = 1;
    } else {
      await disableSection(section, apply, confirm);
    }
  } else {
    console.error(`Unknown command "${command}". Valid commands: status, enable <section>, disable <section>.`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main()
    .catch((err) => {
      // enable/disable already require --apply + an exact --confirm phrase
      // and only ever flip one boolean row per section (no multi-step
      // write to roll back) — a connection failure here means that flip
      // never happened; nothing here retries it.
      console.error(describeConnectionError(err));
      console.error('[cutoverCli] Fatal error.', err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
