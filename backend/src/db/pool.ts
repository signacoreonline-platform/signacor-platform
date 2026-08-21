import { Pool } from 'pg';
import dotenv from 'dotenv';
import { resolveSsl } from './ssl';

dotenv.config();

const databaseUrl = process.env.DATABASE_URL;

// EXTERNAL RENDER SSL FIX (2026-08-21): this pool is the ONE shared
// connection every consumer uses — the running server AND every compiled
// relational CLI tool (backfill.ts/reconcile.ts/cutoverCli.ts all
// `import pool from '../db/pool'`). It previously had no `ssl` option at
// all, which was invisible against local Postgres (no SSL needed) and
// against Render's INTERNAL connection string (used by the deployed
// backend, not SSL-enforced on Render's private network) — but broke the
// first time this same pool was pointed at Render's EXTERNAL/public
// endpoint, which enforces SSL server-side. See db/ssl.ts for the full
// explanation and why `rejectUnauthorized: false` is correct here (it is
// Render's own documented guidance, and was already the proven pattern in
// db/migrate.ts — this reuses that exact same shared logic rather than
// inventing a new one).
const pool = new Pool({
  connectionString: databaseUrl,
  ssl: resolveSsl(databaseUrl),
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

export const query = async (text: string, params?: unknown[]) => {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  if (process.env.NODE_ENV === 'development') {
    console.log('query', { text: text.substring(0, 80), duration, rows: res.rowCount });
  }
  return res;
};

export default pool;
