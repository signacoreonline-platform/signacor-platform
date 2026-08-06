/**
 * removePlaintextPasswordsFromPlatformState.ts
 *
 * ONE-TIME, MANUALLY TRIGGERED cleanup. Blanks the plaintext `pw` field on
 * every account in platform_state.data.userAccounts, now that real login
 * checks the backend's own app_users table (bcrypt-hashed — see
 * backend/src/routes/auth.ts and backend/src/db/
 * seedAppUsersFromPlatformState.ts) instead. Until this runs,
 * GET /api/platform-state — even though it now requires a logged-in session
 * — still hands back every user's real password to anyone who IS logged in,
 * which is more exposure than necessary now that nothing needs it there.
 *
 * SAFETY MODEL — read this before running with --apply:
 *
 *   1. DRY-RUN BY DEFAULT. Running this script with no flags only prints
 *      what it WOULD do. Nothing in the database is touched.
 *
 *   2. --apply requires --confirm="REMOVE PLAINTEXT PASSWORDS" as well
 *      (exact string, case-sensitive). Missing or wrong confirm text = the
 *      script refuses to apply anything, even with --apply present.
 *
 *   3. LOCKOUT GUARD: for each account, this script only blanks `pw` if that
 *      SAME account_id already has a working row in app_users. If an
 *      account has a real password in platform_state but is NOT found in
 *      app_users, its password is left completely untouched and the account
 *      is listed clearly as "SKIPPED" — blanking it would risk making that
 *      account impossible to log into anywhere. (Fix: run
 *      `npm run seed:app-users` first, then re-run this script.)
 *
 *   4. Only the `pw` field is ever changed, and only ever set to '' (blank)
 *      — never deleted as a key, matching the shape factory/print-room
 *      accounts already use for "no password". Every other field (id,
 *      email, name, role, co, initials, title, anything else present) is
 *      copied through completely unchanged. The number of accounts in
 *      userAccounts is never changed — nothing is added or removed.
 *
 *   5. A full backup of the CURRENT platform_state.data is written to
 *      platform_state_backups BEFORE any change, inside the same
 *      transaction as the update — if the backup insert fails, the whole
 *      run fails and nothing is changed (same pattern already used by
 *      backend/src/routes/platformState.ts).
 *
 *   6. Never touches app_users. Never touches any other platform_state
 *      section (jobs, quotes, invoices, etc.) — only userAccounts[].pw.
 *
 *   7. Never prints an actual password value, in dry-run or apply mode —
 *      only counts, ids and emails.
 *
 * Usage:
 *
 *   cd backend
 *   npm run build
 *   npm run remove-plaintext-passwords                 # dry run — no changes
 *   npm run remove-plaintext-passwords -- --apply --confirm="REMOVE PLAINTEXT PASSWORDS"
 */
import { Client } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const REQUIRED_CONFIRM = 'REMOVE PLAINTEXT PASSWORDS';

interface LegacyUserAccount {
  id?: string;
  email?: string;
  pw?: string;
  role?: string;
  co?: number;
  name?: string;
  [key: string]: unknown;
}

function parseArgs(argv: string[]) {
  const apply = argv.includes('--apply');
  const confirmArg = argv.find((a) => a.startsWith('--confirm='));
  const confirm = confirmArg ? confirmArg.slice('--confirm='.length).replace(/^["']|["']$/g, '') : '';
  return { apply, confirm };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set. Cannot run.');
  }

  const { apply, confirm } = parseArgs(process.argv.slice(2));
  if (apply && confirm !== REQUIRED_CONFIRM) {
    console.error(`[remove-plaintext-passwords] --apply was given but --confirm did not exactly match "${REQUIRED_CONFIRM}". Refusing to change anything.`);
    process.exit(1);
  }

  const useSsl = /render\.com|sslmode=require/i.test(databaseUrl);
  const client = new Client({
    connectionString: databaseUrl,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  });

  await client.connect();
  console.log(`[remove-plaintext-passwords] Connected to PostgreSQL. Mode: ${apply ? 'APPLY' : 'DRY RUN (no changes will be made)'}`);

  try {
    const stateRes = await client.query<{ data: { userAccounts?: LegacyUserAccount[] } }>(
      'SELECT data FROM platform_state WHERE id = 1'
    );
    const data = stateRes.rowCount ? (stateRes.rows[0].data || {}) : {};
    const accounts: LegacyUserAccount[] = Array.isArray(data.userAccounts) ? data.userAccounts : [];

    if (accounts.length === 0) {
      console.log('[remove-plaintext-passwords] platform_state.data.userAccounts is empty or missing — nothing to do.');
      return;
    }

    const appUsersRes = await client.query<{ account_id: string; email: string }>(
      'SELECT account_id, email FROM app_users'
    );
    const appUserIds = new Set(appUsersRes.rows.map((r) => r.account_id));

    let hasPlaintext = 0;
    let safeToBlank = 0;
    let skippedNoAppUser = 0;
    let alreadyBlank = 0;
    const safeList: string[] = [];
    const skippedList: string[] = [];

    for (const acc of accounts) {
      const id = (acc.id || acc.email || '').trim();
      const hasPw = typeof acc.pw === 'string' && acc.pw.length > 0;
      if (!hasPw) { alreadyBlank++; continue; }
      hasPlaintext++;
      if (id && appUserIds.has(id)) {
        safeToBlank++;
        safeList.push(`${id}`);
      } else {
        skippedNoAppUser++;
        skippedList.push(`${id}`);
      }
    }

    console.log('[remove-plaintext-passwords] ── Summary ──────────────────────────');
    console.log(`  Accounts in platform_state.userAccounts: ${accounts.length}`);
    console.log(`  Accounts in backend app_users:            ${appUserIds.size}`);
    console.log(`  Already has no password (unchanged):      ${alreadyBlank}`);
    console.log(`  Has a plaintext password:                 ${hasPlaintext}`);
    console.log(`    → confirmed in app_users, SAFE to blank: ${safeToBlank}${safeList.length ? ' (' + safeList.join(', ') + ')' : ''}`);
    console.log(`    → NOT found in app_users, will SKIP:     ${skippedNoAppUser}${skippedList.length ? ' (' + skippedList.join(', ') + ')' : ''}`);
    if (skippedNoAppUser > 0) {
      console.log('  ⚠ One or more accounts would be skipped because they have no matching app_users row yet.');
      console.log('    Run `npm run seed:app-users` first, then re-run this script, to cover them too.');
    }

    if (!apply) {
      console.log('[remove-plaintext-passwords] Dry run only — no changes made. Re-run with --apply --confirm="REMOVE PLAINTEXT PASSWORDS" to apply.');
      return;
    }

    if (safeToBlank === 0) {
      console.log('[remove-plaintext-passwords] Nothing safe to change — exiting without touching the database.');
      return;
    }

    await client.query('BEGIN');
    try {
      // Re-read and lock the row inside the transaction so we act on the
      // current live data, not the copy read above.
      const lockedRes = await client.query<{ data: { userAccounts?: LegacyUserAccount[] } }>(
        'SELECT data FROM platform_state WHERE id = 1 FOR UPDATE'
      );
      const liveData = lockedRes.rowCount ? (lockedRes.rows[0].data || {}) : {};
      const liveAccounts: LegacyUserAccount[] = Array.isArray(liveData.userAccounts) ? liveData.userAccounts : [];

      if (liveAccounts.length !== accounts.length) {
        throw new Error(
          `userAccounts count changed since the dry-run summary above (${accounts.length} → ${liveAccounts.length}) — refusing to apply against data that moved under us. Re-run the script to get a fresh summary.`
        );
      }

      // Backup-before-write — same pattern as backend/src/routes/platformState.ts.
      const serialized = JSON.stringify(liveData);
      await client.query(
        `INSERT INTO platform_state_backups (data, reason, data_size_bytes, source)
         VALUES ($1::jsonb, 'before-remove-plaintext-passwords', $2, $3)`,
        [serialized, Buffer.byteLength(serialized, 'utf8'), 'removePlaintextPasswordsFromPlatformState script']
      );

      let blanked = 0;
      const nextAccounts = liveAccounts.map((acc) => {
        const id = (acc.id || acc.email || '').trim();
        const hasPw = typeof acc.pw === 'string' && acc.pw.length > 0;
        if (hasPw && id && appUserIds.has(id)) {
          blanked++;
          return { ...acc, pw: '' };
        }
        return acc; // untouched — including accounts skipped for the lockout guard
      });

      const nextData = { ...liveData, userAccounts: nextAccounts };
      await client.query(
        `UPDATE platform_state SET data = $1::jsonb, updated_at = NOW() WHERE id = 1`,
        [JSON.stringify(nextData)]
      );

      await client.query('COMMIT');
      console.log(`[remove-plaintext-passwords] ✓ Applied. Blanked the password on ${blanked} account(s). A pre-change backup was written to platform_state_backups.`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      console.error('[remove-plaintext-passwords] ✗ FAILED — transaction rolled back. Nothing was changed.');
      throw err;
    }

    // ── Post-apply verification ──────────────────────────────────────────
    const verifyRes = await client.query<{ data: { userAccounts?: LegacyUserAccount[] } }>(
      'SELECT data FROM platform_state WHERE id = 1'
    );
    const verifyAccounts: LegacyUserAccount[] = Array.isArray(verifyRes.rows[0]?.data?.userAccounts)
      ? (verifyRes.rows[0].data.userAccounts as LegacyUserAccount[])
      : [];
    const stillHasPw = verifyAccounts.filter((a) => typeof a.pw === 'string' && a.pw.length > 0);
    const verifyAppUsersRes = await client.query('SELECT COUNT(*)::int AS count FROM app_users');

    console.log('[remove-plaintext-passwords] ── Post-apply verification ──────────');
    console.log(`  userAccounts count: ${verifyAccounts.length} (was ${accounts.length}) — ${verifyAccounts.length === accounts.length ? 'OK, unchanged' : 'MISMATCH — investigate'}`);
    console.log(`  Accounts that still have a password: ${stillHasPw.length}${stillHasPw.length ? ' (' + stillHasPw.map((a) => a.id || a.email).join(', ') + ' — expected: these were skipped, see above)' : ' (none — cleanup fully applied)'}`);
    console.log(`  app_users row count: ${verifyAppUsersRes.rows[0].count} (unchanged by this script)`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[remove-plaintext-passwords] Fatal error:', err);
    process.exit(1);
  });
