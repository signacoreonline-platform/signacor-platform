/**
 * seedAppUsersFromPlatformState.ts
 *
 * ONE-TIME (safe to re-run), MANUALLY TRIGGERED migration of today's live
 * login accounts — platform_state.data.userAccounts — into the new
 * backend-only app_users table (see database/migrations/004_app_users.sql).
 *
 * This is part of closing audit finding B1 (unauthenticated
 * /api/platform-state and /api/document-numbers/reserve). Those endpoints
 * can only be protected once real backend accounts exist to authenticate
 * against — this script creates them from what's already live, without
 * changing anything about how those accounts currently work.
 *
 * What it does:
 *   1. Connects with DATABASE_URL.
 *   2. Reads platform_state.data.userAccounts (READ-ONLY — this script never
 *      writes to platform_state or platform_state_backups).
 *   3. For each account, bcrypt-hashes its plaintext `pw` (bcryptjs, cost 12
 *      — same library/cost already used by backend/src/routes/auth.ts).
 *      Accounts with no password (role:'factory' one-tap logins) are seeded
 *      with password_hash = NULL and requires_password = FALSE, preserving
 *      today's passwordless sign-in exactly.
 *   4. Upserts into app_users, matched by account_id (mirrors userAccounts[].id).
 *
 * Safe to re-run:
 *   - INSERT for a new account_id: full row inserted, including the hashed password.
 *   - Existing account_id: email/name/role/co/requires_password are refreshed
 *     (so a rename or role change made in the old "User Roles" page before
 *     the cutover is picked up), but password_hash is LEFT ALONE unless
 *     --force-passwords is passed — this prevents accidentally reverting a
 *     password already changed through the new backend-authenticated path
 *     (see PUT /api/auth/sync-user) back to an older plaintext copy.
 *
 * Never drops or deletes anything. Never touches platform_state.
 *
 * Run after `npm run build`, with production DATABASE_URL set:
 *
 *   cd backend
 *   npm run seed:app-users
 *
 * Pass --force-passwords to also overwrite existing password hashes from the
 * current platform_state copy (only use this if you're intentionally
 * resetting everyone back to their platform_state password):
 *
 *   npm run seed:app-users -- --force-passwords
 */
import { Client } from 'pg';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

interface LegacyUserAccount {
  id?: string;
  email?: string;
  pw?: string;
  role?: string;
  co?: number;
  name?: string;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set. Cannot seed app_users.');
  }

  const forcePasswords = process.argv.includes('--force-passwords');

  const useSsl = /render\.com|sslmode=require/i.test(databaseUrl);
  const client = new Client({
    connectionString: databaseUrl,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  });

  await client.connect();
  console.log('[seed-app-users] Connected to PostgreSQL.');

  try {
    // Make sure the target table exists even if the migration runner hasn't
    // been run yet in this environment — matches the same defensive pattern
    // used by seedPlatformStateFromIndex.ts. Idempotent; never drops.
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_users (
        id                BIGSERIAL PRIMARY KEY,
        account_id        TEXT NOT NULL UNIQUE,
        email             TEXT NOT NULL UNIQUE,
        password_hash     TEXT,
        requires_password BOOLEAN NOT NULL DEFAULT TRUE,
        role              TEXT NOT NULL,
        co                INTEGER,
        name              TEXT,
        is_active         BOOLEAN NOT NULL DEFAULT TRUE,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const stateRes = await client.query<{ data: { userAccounts?: LegacyUserAccount[] } }>(
      'SELECT data FROM platform_state WHERE id = 1'
    );
    const data = stateRes.rowCount ? (stateRes.rows[0].data || {}) : {};
    const accounts = Array.isArray(data.userAccounts) ? data.userAccounts : [];

    if (accounts.length === 0) {
      console.log('[seed-app-users] platform_state.data.userAccounts is empty or missing — nothing to seed.');
      console.log('[seed-app-users] Nothing was changed.');
      return;
    }

    console.log(`[seed-app-users] Found ${accounts.length} account(s) in live platform_state.`);
    if (forcePasswords) {
      console.log('[seed-app-users] --force-passwords set: existing password hashes WILL be overwritten.');
    }

    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    for (const acc of accounts) {
      const email = (acc.email || '').trim().toLowerCase();
      const accountId = (acc.id || email).trim();
      if (!email || !accountId) {
        console.warn('[seed-app-users] Skipping an account with no email/id:', JSON.stringify(acc));
        skipped++;
        continue;
      }

      const hasPassword = typeof acc.pw === 'string' && acc.pw.length > 0;
      const passwordHash = hasPassword ? await bcrypt.hash(acc.pw as string, 12) : null;
      const requiresPassword = hasPassword;
      const role = acc.role || 'assistant';
      const co = typeof acc.co === 'number' ? acc.co : null;
      const name = acc.name || null;

      const existingRes = await client.query('SELECT id FROM app_users WHERE account_id = $1', [accountId]);

      if (existingRes.rowCount === 0) {
        await client.query(
          `INSERT INTO app_users (account_id, email, password_hash, requires_password, role, co, name)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [accountId, email, passwordHash, requiresPassword, role, co, name]
        );
        inserted++;
      } else if (forcePasswords) {
        await client.query(
          `UPDATE app_users
             SET email = $2, password_hash = $3, requires_password = $4, role = $5, co = $6, name = $7, updated_at = NOW()
           WHERE account_id = $1`,
          [accountId, email, passwordHash, requiresPassword, role, co, name]
        );
        updated++;
      } else {
        await client.query(
          `UPDATE app_users
             SET email = $2, role = $3, co = $4, name = $5, updated_at = NOW()
           WHERE account_id = $1`,
          [accountId, email, role, co, name]
        );
        updated++;
      }
    }

    console.log(`[seed-app-users] ✓ Done. Inserted ${inserted}, updated ${updated}, skipped ${skipped}.`);
    console.log('[seed-app-users] platform_state.data.userAccounts was NOT modified — this script only read it.');
  } catch (err) {
    console.error('[seed-app-users] ✗ FAILED:', err);
    throw err;
  } finally {
    await client.end().catch(() => undefined);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seed-app-users] Fatal error:', err);
    process.exit(1);
  });
