import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt, { SignOptions } from 'jsonwebtoken';
import { query } from '../db/pool';
import { authenticate, requireRole, AuthRequest } from '../middleware/auth';

/**
 * /api/auth
 *
 * Backend-authoritative login for the live dashboard, against `app_users`
 * (database/migrations/004_app_users.sql) — NOT the old `users` table from
 * database/schema.sql, which belongs to a separate, unused data model (see
 * that migration file's header comment for why).
 *
 * Added 2026-08-06 to close audit finding B1: the live app previously
 * authenticated entirely client-side, comparing against
 * platform_state.data.userAccounts (including a plaintext-comparable `pw`
 * field) loaded via the unauthenticated GET /api/platform-state. This route
 * replaces that — index.html's LoginPage now calls POST /login here and
 * gets back a JWT, which it then sends as `Authorization: Bearer <token>` on
 * every call to /api/platform-state and /api/document-numbers/reserve (both
 * now behind `authenticate`, see those route files).
 *
 * app_users is seeded from today's live userAccounts by
 * backend/src/db/seedAppUsersFromPlatformState.ts (run once, manually, after
 * this deploys — see that script's header for instructions). Until that
 * script has been run in a given environment, app_users is empty and no one
 * can log in — this is a deliberate fail-closed choice; deploy order matters
 * here (see project audit report, item B1, "sequencing to prevent lockout").
 */
const router = Router();

const jwtSecret = process.env.JWT_SECRET || 'fallback-secret';
const jwtOptions: SignOptions = {
  expiresIn: (process.env.JWT_EXPIRES_IN || '7d') as SignOptions['expiresIn'],
};

interface AppUserRow {
  id: number;
  account_id: string;
  email: string;
  password_hash: string | null;
  requires_password: boolean;
  role: string;
  co: number | null;
  name: string | null;
  is_active: boolean;
}

// POST /api/auth/login
// body: { email, password }
// `password` may be omitted/blank for accounts seeded with
// requires_password = false (the two passwordless "Manufacturing" one-tap
// logins) — every other account must match its bcrypt hash exactly.
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body || {};
    if (!email) {
      res.status(400).json({ error: 'Email is required' });
      return;
    }
    const result = await query(
      'SELECT * FROM app_users WHERE LOWER(email) = LOWER($1) AND is_active = true',
      [String(email).trim()]
    );
    const user: AppUserRow | undefined = result.rows[0];
    if (!user) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    if (user.requires_password) {
      if (!password || !user.password_hash) {
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }
      const valid = await bcrypt.compare(String(password), user.password_hash);
      if (!valid) {
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }
    }
    // requires_password === false: passwordless account (factory/print room
    // one-tap sign-in) — no password check, matching existing behaviour.

    const token = jwt.sign(
      { id: user.account_id, email: user.email, role: user.role, co: user.co },
      jwtSecret,
      jwtOptions
    );

    res.json({
      token,
      user: {
        id: user.account_id,
        email: user.email,
        name: user.name,
        role: user.role,
        co: user.co,
      },
    });
  } catch (err) {
    console.error('POST /api/auth/login failed:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/auth/sync-user — admin-only.
// Keeps the existing "User Roles" admin page (index.html UserRolesPage)
// working after login moved server-side: that page edits name/email/password
// against platform_state.data.userAccounts as it always has (unchanged —
// still the visible record of who has an account and what their display
// details are), and now ALSO calls this endpoint so the change actually
// takes effect for real login, which now checks app_users, not
// platform_state. Never creates a new role/company — role and co are only
// ever written here from what the caller already has on the account (this
// endpoint cannot promote/demote anyone; UserRolesPage never exposes those
// fields for editing either).
// body: { accountId, email, name, role, co, password? }
router.put('/sync-user', authenticate, requireRole('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { accountId, email, name, role, co, password } = req.body || {};
    if (!accountId || !email || !role) {
      res.status(400).json({ error: 'accountId, email and role are required' });
      return;
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    const passwordHash = password ? await bcrypt.hash(String(password), 12) : null;

    if (passwordHash) {
      await query(
        `INSERT INTO app_users (account_id, email, password_hash, requires_password, role, co, name)
         VALUES ($1, $2, $3, true, $4, $5, $6)
         ON CONFLICT (account_id) DO UPDATE
           SET email = EXCLUDED.email, password_hash = EXCLUDED.password_hash,
               requires_password = true, role = EXCLUDED.role, co = EXCLUDED.co,
               name = EXCLUDED.name, updated_at = NOW()`,
        [accountId, normalizedEmail, passwordHash, role, typeof co === 'number' ? co : null, name || null]
      );
    } else {
      // No new password supplied — update the account's other details only,
      // leaving whatever password/hash (or passwordless flag) it already has
      // untouched. If the account doesn't exist yet in app_users, it's
      // created with no usable password until one is set.
      await query(
        `INSERT INTO app_users (account_id, email, role, co, name)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (account_id) DO UPDATE
           SET email = EXCLUDED.email, role = EXCLUDED.role, co = EXCLUDED.co,
               name = EXCLUDED.name, updated_at = NOW()`,
        [accountId, normalizedEmail, role, typeof co === 'number' ? co : null, name || null]
      );
    }

    res.json({ success: true });
  } catch (err: unknown) {
    if ((err as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'Email already in use by another account' });
      return;
    }
    console.error('PUT /api/auth/sync-user failed:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
