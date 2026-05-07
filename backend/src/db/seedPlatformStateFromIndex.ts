/**
 * seedPlatformStateFromIndex.ts
 *
 * Safely seeds (or refreshes) the platform_state table from the JSON
 * embedded in the root index.html.
 *
 * Workflow:
 *   1. Locate the repo's root index.html.
 *   2. Extract the JSON payload from the
 *        <script id="sgr-data" type="application/json">...</script>
 *      tag.
 *   3. Connect to PostgreSQL using DATABASE_URL.
 *   4. Ensure the platform_state_backups table exists (safe / idempotent).
 *   5. Insert the CURRENT platform_state.data row into platform_state_backups
 *      BEFORE doing anything destructive.
 *   6. UPSERT platform_state id = 1 with the extracted JSON and update
 *      updated_at = NOW().
 *
 * IMPORTANT:
 *   - Never drops a table.
 *   - Never deletes existing rows.
 *   - The CURRENT data is always backed up first.
 *   - The script exits with a non-zero status on error.
 *
 * Run after `npm run build`:
 *
 *   cd backend
 *   npm run seed:platform-state
 */
import { Client } from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

function findIndexHtml(): string {
  const candidates = [
    // Compiled location: backend/dist/db/seedPlatformStateFromIndex.js → ../../../index.html
    path.resolve(__dirname, '..', '..', '..', 'index.html'),
    // Source-run location: backend/src/db/seedPlatformStateFromIndex.ts → ../../../index.html
    path.resolve(__dirname, '..', '..', '..', 'index.html'),
    // Started from backend/ root
    path.resolve(process.cwd(), '..', 'index.html'),
    // Started from repo root
    path.resolve(process.cwd(), 'index.html'),
  ];

  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {
      /* ignore */
    }
  }
  throw new Error(
    `Could not locate root index.html. Tried:\n  ${candidates.join('\n  ')}`
  );
}

function extractEmbeddedJson(html: string): unknown {
  // Match <script id="sgr-data" type="application/json"> ... </script>
  // Attribute order can vary, so handle both common orderings.
  const patterns: RegExp[] = [
    /<script\s+id=["']sgr-data["']\s+type=["']application\/json["']\s*>([\s\S]*?)<\/script>/i,
    /<script\s+type=["']application\/json["']\s+id=["']sgr-data["']\s*>([\s\S]*?)<\/script>/i,
  ];

  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) {
      const raw = m[1].trim();
      try {
        return JSON.parse(raw);
      } catch (err) {
        throw new Error(
          `Found <script id="sgr-data"> tag but JSON.parse failed: ${(err as Error).message}`
        );
      }
    }
  }

  throw new Error(
    'Could not find <script id="sgr-data" type="application/json"> tag in index.html.'
  );
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set. Cannot seed platform_state.');
  }

  const indexPath = findIndexHtml();
  console.log(`[seed] Reading dashboard from: ${indexPath}`);
  const html = fs.readFileSync(indexPath, 'utf8');

  const extracted = extractEmbeddedJson(html);
  const extractedJson = JSON.stringify(extracted);
  console.log(
    `[seed] Extracted embedded sgr-data JSON (${extractedJson.length} chars).`
  );

  // Mirror migrate.ts SSL behaviour for Render-hosted Postgres.
  const useSsl = /render\.com|sslmode=require/i.test(databaseUrl);
  const client = new Client({
    connectionString: databaseUrl,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  });

  await client.connect();
  console.log('[seed] Connected to PostgreSQL.');

  try {
    await client.query('BEGIN');

    // 1. Ensure backup table exists — never drops anything.
    await client.query(`
      CREATE TABLE IF NOT EXISTS platform_state_backups (
        id           SERIAL PRIMARY KEY,
        backed_up_at TIMESTAMP DEFAULT NOW(),
        data         JSONB NOT NULL
      )
    `);
    console.log('[seed] platform_state_backups table is ready.');

    // 2. Read current platform_state.data (may be empty / missing).
    const existing = await client.query<{ data: unknown }>(
      'SELECT data FROM platform_state WHERE id = 1'
    );

    if (existing.rowCount === 1) {
      // 3. Back up the CURRENT row before changing anything.
      await client.query(
        `INSERT INTO platform_state_backups (data) VALUES ($1::jsonb)`,
        [JSON.stringify(existing.rows[0].data ?? {})]
      );
      console.log(
        '[seed] Existing platform_state.data backed up into platform_state_backups.'
      );
    } else {
      console.log(
        '[seed] No existing platform_state row (id=1). Skipping backup; will insert fresh.'
      );
    }

    // 4. UPSERT platform_state id = 1 with the extracted JSON.
    await client.query(
      `INSERT INTO platform_state (id, data, updated_at)
       VALUES (1, $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE
         SET data       = EXCLUDED.data,
             updated_at = NOW()`,
      [extractedJson]
    );
    console.log('[seed] platform_state row id=1 updated successfully.');

    await client.query('COMMIT');
    console.log('[seed] ✓ Done. Platform state seeded from index.html.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[seed] ✗ FAILED — transaction rolled back.');
    throw err;
  } finally {
    await client.end().catch(() => undefined);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seed] Fatal error:', err);
    process.exit(1);
  });
