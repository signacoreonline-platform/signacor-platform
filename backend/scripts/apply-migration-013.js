#!/usr/bin/env node
/**
 * apply-migration-013.js — PREPARE ONLY. Nothing here runs unless YOU run it.
 *
 * WHY THIS EXISTS
 *   `psql` is not installed on the Windows machine that administers this
 *   platform, so there is no command-line way to apply a migration. This script
 *   applies exactly ONE file — database/migrations/013_quote_line_dimensions.sql
 *   — using the same `pg` driver the backend already depends on.
 *
 * WHAT IT DOES
 *   1. Reads 013_quote_line_dimensions.sql off disk. It does not contain SQL of
 *      its own; the migration file is the single source of truth.
 *   2. REFUSES to run if that file contains any destructive statement
 *      (DROP / DELETE / TRUNCATE / UPDATE / ALTER ... TYPE). Migration 013 is
 *      additive by design; if that ever stops being true, this script stops.
 *   3. Runs it inside ONE transaction. Postgres does transactional DDL, so
 *      either every column is added or none is.
 *   4. Prints the resulting columns from information_schema so you can see the
 *      outcome rather than trust a "done".
 *
 * WHAT IT DOES NOT DO
 *   No backfill. No reconciliation. No data movement. No flag changes. It adds
 *   nullable columns and nothing else. It is safe to run more than once — every
 *   statement in 013 is ADD COLUMN IF NOT EXISTS.
 *
 * USAGE (from the backend folder, with the target database in DATABASE_URL):
 *     node scripts/apply-migration-013.js            # apply
 *     node scripts/apply-migration-013.js --dry-run  # print the SQL, touch nothing
 *
 * Take a backup first, as with any schema change.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const SQL_PATH = path.resolve(__dirname, '..', '..', 'database', 'migrations', '013_quote_line_dimensions.sql');
const DRY_RUN = process.argv.includes('--dry-run');

function stripComments(sql) {
  return sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
}

async function main() {
  if (!fs.existsSync(SQL_PATH)) {
    console.error(`[apply-013] migration file not found: ${SQL_PATH}`);
    process.exit(1);
  }
  const sql = fs.readFileSync(SQL_PATH, 'utf8');
  const body = stripComments(sql);

  const forbidden = [/\bDROP\b/i, /\bDELETE\b/i, /\bTRUNCATE\b/i, /\bUPDATE\b/i, /ALTER\s+TABLE[\s\S]*?\bTYPE\b/i];
  for (const re of forbidden) {
    if (re.test(body)) {
      console.error(`[apply-013] REFUSING: the migration contains a destructive statement matching ${re}.`);
      console.error('[apply-013] Migration 013 is meant to be purely additive. Nothing was run.');
      process.exit(2);
    }
  }
  const statements = body.split(';').map((s) => s.trim()).filter(Boolean);
  if (!statements.every((s) => /^ALTER\s+TABLE/i.test(s) || /^COMMENT\s+ON/i.test(s))) {
    console.error('[apply-013] REFUSING: the migration contains a statement that is neither ALTER TABLE nor COMMENT ON.');
    process.exit(2);
  }
  console.log(`[apply-013] ${statements.length} statements, all additive (ALTER TABLE ... ADD COLUMN IF NOT EXISTS / COMMENT ON).`);

  if (DRY_RUN) {
    console.log('[apply-013] --dry-run: nothing was executed. The SQL that WOULD run:\n');
    statements.forEach((s, i) => console.log(`  ${i + 1}. ${s.replace(/\s+/g, ' ').slice(0, 160)}`));
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error('[apply-013] DATABASE_URL is not set. Refusing to guess a target database.');
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'disable' ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    for (const s of statements) await client.query(s);
    await client.query('COMMIT');
    console.log('[apply-013] applied and committed.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[apply-013] FAILED — rolled back, nothing changed:', err.message);
    process.exitCode = 3;
    await client.end();
    return;
  }

  const check = await client.query(
    `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_name IN ('rel_quote_line_items', 'rel_job_line_items')
        AND column_name IN ('sqm_l','sqm_w','pieces','complete_product_source_id','complete_product_linked')
      ORDER BY table_name, column_name`);
  console.log('\n[apply-013] columns now present:');
  for (const r of check.rows) {
    console.log(`  ${r.table_name}.${r.column_name}  ${r.data_type}  nullable=${r.is_nullable}`);
  }
  if (check.rows.length !== 10) {
    console.error(`\n[apply-013] EXPECTED 10 columns, found ${check.rows.length}. Investigate before deploying the new backend.`);
    process.exitCode = 4;
  }
  await client.end();
}

main().catch((err) => { console.error('[apply-013] fatal:', err); process.exit(1); });
