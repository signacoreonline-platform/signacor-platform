/**
 * Safe, idempotent migration runner for the Signacore backend.
 *
 *   - Uses process.env.DATABASE_URL.
 *   - Creates a `schema_migrations` table on first run.
 *   - Applies every *.sql file in <repo>/database/migrations in sorted order
 *     that has not already been recorded.
 *   - Records each successful migration's filename.
 *   - Never re-runs an already-applied migration.
 *   - Never drops tables. Never destroys data.
 *   - Stops with a clear error if any migration fails.
 *
 * Path note: on Render the backend is the service root and this file is
 * compiled to `backend/dist/db/migrate.js`. The migrations folder lives
 * OUTSIDE backend at `<repo>/database/migrations`. We try several
 * candidate locations so it works whether the start command is run from
 * the backend root, from the repo root, or via `node dist/db/migrate.js`.
 */
import { Client } from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

function findMigrationsDir(): string {
  const candidates = [
    // Compiled location: backend/dist/db/migrate.js → ../../database/migrations
    path.resolve(__dirname, '..', '..', '..', 'database', 'migrations'),
    // Source-run location: backend/src/db/migrate.ts → ../../database/migrations
    path.resolve(__dirname, '..', '..', 'database', 'migrations'),
    // Started from backend/ root
    path.resolve(process.cwd(), '..', 'database', 'migrations'),
    // Started from repo root
    path.resolve(process.cwd(), 'database', 'migrations'),
  ];

  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
    } catch {
      /* ignore */
    }
  }
  throw new Error(
    `Could not locate database/migrations directory. Tried:\n  ${candidates.join('\n  ')}`
  );
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set. Cannot run migrations.');
  }

  const migrationsDir = findMigrationsDir();
  console.log(`[migrate] Using migrations folder: ${migrationsDir}`);

  const allFiles = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.toLowerCase().endsWith('.sql'))
    .sort(); // alphabetical = the convention 001_, 002_, ... handles itself

  if (allFiles.length === 0) {
    console.log('[migrate] No .sql migration files found. Nothing to do.');
    return;
  }

  // pg's SSL requirements differ between local Postgres and Render Postgres.
  // Render's external connection strings work with rejectUnauthorized:false.
  const useSsl = /render\.com|\.com\/|sslmode=require/i.test(databaseUrl);
  const client = new Client({
    connectionString: databaseUrl,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  });

  await client.connect();
  try {
    // Tracking table — never dropped.
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    const appliedRes = await client.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations'
    );
    const applied = new Set(appliedRes.rows.map((r) => r.filename));

    const pending = allFiles.filter((f) => !applied.has(f));
    if (pending.length === 0) {
      console.log('[migrate] All migrations already applied. Nothing to do.');
      return;
    }

    console.log(`[migrate] ${pending.length} migration(s) pending: ${pending.join(', ')}`);

    for (const filename of pending) {
      const fullPath = path.join(migrationsDir, filename);
      const sql = fs.readFileSync(fullPath, 'utf8');
      console.log(`[migrate] Applying ${filename}...`);

      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1)',
          [filename]
        );
        await client.query('COMMIT');
        console.log(`[migrate] ✓ ${filename}`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        console.error(`[migrate] ✗ FAILED on ${filename}`);
        throw err;
      }
    }

    console.log('[migrate] All pending migrations applied successfully.');
  } finally {
    await client.end().catch(() => undefined);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[migrate] Fatal error:', err);
    process.exit(1);
  });
