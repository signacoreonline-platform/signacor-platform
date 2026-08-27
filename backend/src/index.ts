import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';

import authRoutes from './routes/auth';
import companiesRoutes from './routes/companies';
import clientsRoutes from './routes/clients';
import jobsRoutes from './routes/jobs';
import intercompanyRoutes from './routes/intercompany';
import calculatorsRoutes from './routes/calculators';
import dashboardRoutes from './routes/dashboard';
import inventoryRoutes from './routes/inventory';
import importsRoutes from './routes/imports';
import platformStateRoutes from './routes/platformState';
import documentNumbersRoutes from './routes/documentNumbers';
import quoteConversionsRoutes from './routes/quoteConversions';
import relationalApiRoutes from './relational/api';
import fullBackupRoutes from './routes/fullBackup';
// RELIABILITY PHASE 1 (2026-08-26): metadata-only change detection for
// relational sections — see backend/src/routes/freshness.ts.
import freshnessRoutes from './routes/freshness';
import { errorHandler, notFound } from './middleware/errorHandler';
import { ALL_SECTIONS, isSectionCutOver } from './relational/cutover';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true,
}));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
// 2026-08-04: the full platform_state save body (driven mostly by
// purchaseOrders and quotes) has grown to ~5.3MB, already past the previous
// 5mb limit — confirmed live as "request entity too large" on PUT
// /api/platform-state. Most saves now use the new partial-save path (only
// the sections that changed, see platformState.ts), but a full-state save
// is still the default for every other caller and will keep growing with
// normal business use, so the limit is raised with real headroom rather
// than tuned to today's exact size.
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// ── Health check ──────────────────────────────────────────────
// 2026-08-20 STAGE 2 Phase 9: extended with non-sensitive relational-
// cutover status. Deliberately excludes anything sensitive: no DB
// connection strings, no row data, no user/auth info — just booleans and
// the master env-switch state, safe to expose on an unauthenticated
// health endpoint (this route has never required auth, and Stage 2 does
// not change that).
app.get('/health', async (_req: Request, res: Response) => {
  const relationalAuthorityMasterSwitch = process.env.RELATIONAL_AUTHORITY_ENABLED === 'true';
  let relationalSections: Record<string, boolean> = {};
  let relationalStatusError: string | null = null;
  try {
    for (const s of ALL_SECTIONS) relationalSections[s] = await isSectionCutOver(s);
  } catch (err) {
    // A DB hiccup must never take /health down with it — health checks are
    // used to decide whether a deploy is safe to resume traffic on, so this
    // endpoint always responds 200 with what it knows, and reports the
    // relational-status lookup itself as failed rather than 500ing.
    relationalStatusError = 'relational_status_unavailable';
  }
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'Signacore API',
    // 2026-08-20 SECOND HARDENING PASS — bump this string any time
    // platformState.ts's merge/conflict logic changes, so a deploy can be
    // confirmed live (GET /health) before users are told to resume work.
    platformStateSafetyVersion: '2026-08-20-id-map-stale-safe-v1',
    relational: {
      masterSwitchEnabled: relationalAuthorityMasterSwitch,
      cutOverSections: relationalSections,
      ...(relationalStatusError ? { error: relationalStatusError } : {}),
    },
  });
});

// ── API Routes ────────────────────────────────────────────────
app.use('/api/auth',          authRoutes);
app.use('/api/companies',     companiesRoutes);
app.use('/api/clients',       clientsRoutes);
app.use('/api/jobs',          jobsRoutes);
app.use('/api/intercompany',  intercompanyRoutes);
app.use('/api/calculators',   calculatorsRoutes);
app.use('/api/dashboard',     dashboardRoutes);
app.use('/api/inventory',     inventoryRoutes);
app.use('/api/imports',       importsRoutes);
app.use('/api/platform-state', platformStateRoutes);
app.use('/api/document-numbers', documentNumbersRoutes);
app.use('/api/quote-conversions', quoteConversionsRoutes);
app.use('/api/relational', relationalApiRoutes);
app.use('/api/full-backup', fullBackupRoutes);
app.use('/api/freshness', freshnessRoutes);

// ── Error handling ────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║   Signacore Group Platform — API Server  ║
  ║   Port: ${PORT}                              ║
  ║   Env:  ${process.env.NODE_ENV || 'development'}                    ║
  ╚══════════════════════════════════════════╝
  `);
  warnIfCutoverRowsWithoutMasterSwitch();
});

/**
 * RELIABILITY PHASE 1 (2026-08-26) — LOUD, NON-FATAL MISMATCH WARNING.
 *
 * Authority requires BOTH the env master switch AND the per-section DB row
 * (see relational/cutover.ts). If the DB says sections are cut over but
 * RELATIONAL_AUTHORITY_ENABLED is not "true", every one of those sections
 * silently reverts to its FROZEN platform_state copy — users see pre-cutover
 * data and, worse, JSON saves start writing that copy again. Today that
 * situation is completely silent in the logs.
 *
 * This ONLY logs. It does not change authority, does not alter /health, does
 * not retry, and never prevents the server from starting — hard-failing on
 * this is deliberately left to a later phase, as instructed. Any error while
 * checking is swallowed: a startup diagnostic must never be able to take the
 * service down.
 */
async function warnIfCutoverRowsWithoutMasterSwitch(): Promise<void> {
  try {
    if (process.env.RELATIONAL_AUTHORITY_ENABLED === 'true') return;
    const { query } = await import('./db/pool');
    const res = await query('SELECT section FROM relational_cutover WHERE enabled = true ORDER BY section');
    const rows = res.rows.map((r: { section: string }) => r.section);
    if (rows.length === 0) return;
    console.error('');
    console.error('  ####################################################################');
    console.error('  #  WARNING — RELATIONAL AUTHORITY IS OFF BUT CUTOVER ROWS EXIST    #');
    console.error('  ####################################################################');
    console.error(`  #  RELATIONAL_AUTHORITY_ENABLED is "${process.env.RELATIONAL_AUTHORITY_ENABLED ?? '(unset)'}" — not "true".`);
    console.error(`  #  ${rows.length} section(s) are marked cut over in the database:`);
    console.error(`  #    ${rows.join(', ')}`);
    console.error('  #  Those sections are being served from their FROZEN platform_state');
    console.error('  #  JSON copy, which is OLDER than the relational tables, and JSON');
    console.error('  #  saves are no longer being stripped for them. If this environment');
    console.error('  #  is production, set RELATIONAL_AUTHORITY_ENABLED=true before use.');
    console.error('  ####################################################################');
    console.error('');
  } catch {
    /* A startup diagnostic must never affect startup. */
  }
}

export default app;
