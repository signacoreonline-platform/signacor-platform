import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt, { SignOptions } from 'jsonwebtoken';
import { query } from '../db/pool';
import { authenticate, requireRole, AuthRequest, isMainAdmin, HOLDINGS_CO } from '../middleware/auth';

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

/* ═══════════════════════════════════════════════════════════════════════════
   USER ADMINISTRATION (2026-11-16)

   WHO MAY MANAGE USERS. Exactly one kind of account: the MAIN Administrator
   (role `admin`, not scoped to Holdings). That is the existing rule — the
   dashboard has only ever shown "User Roles" to that account — but until now
   it lived in the browser alone: PUT /sync-user accepted any `admin` token,
   so a Holdings Administrator could create or re-role any account by calling
   it directly. Every route below enforces the rule on the server.

   WHAT MAY BE GRANTED. A role is offered for a company only where that
   combination already exists in the platform, so nothing here invents a new
   kind of account:
       Signacore          (co: null)  admin · accounts · assistant · factory
       Signacore Holdings (co: 1)     admin · assistant
   GET /users returns this same table as `grantable`, and the dashboard builds
   its Role and Company lists from it — the form cannot offer what the server
   would refuse, and the server refuses it regardless of what a form sends.

   PASSWORDS. Hashed with bcrypt at cost 12, exactly as seedAppUsersFromPlatformState
   and /sync-user always have. A password is never returned, never logged and
   never written to platform_state.
   ═══════════════════════════════════════════════════════════════════════════ */

type CompanyCo = number | null;
const GRANTABLE: ReadonlyArray<{ co: CompanyCo; label: string; roles: ReadonlyArray<string> }> = [
  { co: null, label: 'Signacore', roles: ['admin', 'accounts', 'assistant', 'factory'] },
  { co: HOLDINGS_CO, label: 'Signacore Holdings', roles: ['admin', 'assistant'] },
];
const ROLE_LABELS: Record<string, string> = {
  admin: 'Admin', accounts: 'Accounts', assistant: 'Assistant', factory: 'Manufacturing (Factory / Print Room) — view only',
};
const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/;
const PASSWORD_MIN = 8;
// bcrypt reads only the first 72 BYTES. Refusing anything longer is the
// honest behaviour: silently truncating would let two different passwords
// open the same account.
const PASSWORD_MAX_BYTES = 72;

class UserInputError extends Error {
  status: number; code: string; field?: string;
  constructor(status: number, code: string, message: string, field?: string) {
    super(message); this.status = status; this.code = code; this.field = field;
  }
}

/** undefined / null / '' -> null (Signacore); 1 / "1" -> Holdings. Anything else is refused. */
function parseCo(raw: unknown): CompanyCo {
  if (raw === undefined || raw === null || raw === '') return null;
  if (raw === HOLDINGS_CO || raw === String(HOLDINGS_CO)) return HOLDINGS_CO;
  throw new UserInputError(400, 'COMPANY_NOT_GRANTABLE', 'Choose one of the listed companies.', 'co');
}
function assertGrantable(role: string, co: CompanyCo): void {
  const company = GRANTABLE.find((g) => g.co === co);
  if (!company) throw new UserInputError(400, 'COMPANY_NOT_GRANTABLE', 'Choose one of the listed companies.', 'co');
  if (!company.roles.includes(role)) {
    throw new UserInputError(400, 'ROLE_NOT_GRANTABLE', `The role "${role || '?'}" cannot be granted for ${company.label}.`, 'role');
  }
}
function validatePassword(password: unknown, email: string): string {
  if (typeof password !== 'string' || password.length === 0) {
    throw new UserInputError(400, 'PASSWORD_REQUIRED', 'An initial password is required.', 'password');
  }
  if (password.length < PASSWORD_MIN) {
    throw new UserInputError(400, 'PASSWORD_TOO_SHORT', `The password must be at least ${PASSWORD_MIN} characters.`, 'password');
  }
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    throw new UserInputError(400, 'PASSWORD_TOO_LONG', `The password must be ${PASSWORD_MAX_BYTES} characters or fewer.`, 'password');
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    throw new UserInputError(400, 'PASSWORD_TOO_WEAK', 'The password must contain at least one letter and one number.', 'password');
  }
  if (password.trim() !== password) {
    throw new UserInputError(400, 'PASSWORD_WHITESPACE', 'The password cannot start or end with a space.', 'password');
  }
  if (password.toLowerCase() === email.toLowerCase()) {
    throw new UserInputError(400, 'PASSWORD_TOO_WEAK', 'The password cannot be the same as the login email.', 'password');
  }
  return password;
}
function validateEmail(raw: unknown): string {
  const email = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!email) throw new UserInputError(400, 'EMAIL_REQUIRED', 'A login email is required.', 'email');
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    throw new UserInputError(400, 'EMAIL_INVALID', 'Enter a valid email address for the login.', 'email');
  }
  return email;
}
function validateName(raw: unknown): string {
  const name = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (!name) throw new UserInputError(400, 'NAME_REQUIRED', 'A display name is required.', 'name');
  if (name.length > 80) throw new UserInputError(400, 'NAME_TOO_LONG', 'The display name must be 80 characters or fewer.', 'name');
  return name;
}
function sendUserError(err: unknown, res: Response, where: string): void {
  if (err instanceof UserInputError) {
    res.status(err.status).json({ error: err.message, code: err.code, ...(err.field ? { field: err.field } : {}) });
    return;
  }
  if ((err as { code?: string }).code === '23505') {
    res.status(409).json({ error: 'That login email is already in use by another account.', code: 'DUPLICATE_LOGIN', field: 'email' });
    return;
  }
  // Only the error itself is logged — never the request body, which may
  // carry a password.
  console.error(`${where} failed:`, err);
  res.status(500).json({ error: 'Server error' });
}
/** Main Administrator only. Sends the 403 itself and returns false otherwise. */
function requireMainAdmin(req: AuthRequest, res: Response): boolean {
  if (isMainAdmin(req.user)) return true;
  res.status(403).json({ error: 'Only the main Administrator can manage user accounts.', code: 'NOT_ALLOWED' });
  return false;
}
/** The public shape of an account. password_hash is never selected into it. */
function publicUser(row: Pick<AppUserRow, 'account_id' | 'email' | 'role' | 'co' | 'name' | 'requires_password' | 'is_active'>) {
  return {
    id: row.account_id, email: row.email, name: row.name, role: row.role, co: row.co,
    requiresPassword: row.requires_password, isActive: row.is_active,
  };
}
const PUBLIC_COLUMNS = 'account_id, email, role, co, name, requires_password, is_active';

// GET /api/auth/users — main Administrator only.
// The accounts that can actually sign in (app_users is what login checks),
// plus the role/company combinations this Administrator may grant.
router.get('/users', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  if (!requireMainAdmin(req, res)) return;
  try {
    const result = await query(`SELECT ${PUBLIC_COLUMNS} FROM app_users ORDER BY id`);
    res.json({
      users: result.rows.map(publicUser),
      grantable: GRANTABLE.map((g) => ({
        co: g.co, label: g.label,
        roles: g.roles.map((r) => ({ role: r, label: ROLE_LABELS[r] || r })),
      })),
      passwordRules: { minLength: PASSWORD_MIN, maxLength: PASSWORD_MAX_BYTES, needsLetterAndNumber: true },
    });
  } catch (err) {
    sendUserError(err, res, 'GET /api/auth/users');
  }
});

// POST /api/auth/users — main Administrator only.
// body: { name, email, role, co, password }
// Creates ONE new login. Never updates an existing account (a duplicate
// login is a 409, not an overwrite), and never creates a passwordless one.
router.post('/users', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  if (!requireMainAdmin(req, res)) return;
  try {
    const body = req.body || {};
    const name = validateName(body.name);
    const email = validateEmail(body.email);
    const role = String(body.role == null ? '' : body.role).trim().toLowerCase();
    if (!role) throw new UserInputError(400, 'ROLE_REQUIRED', 'Choose a role for the new user.', 'role');
    const co = parseCo(body.co);
    assertGrantable(role, co);
    const password = validatePassword(body.password, email);

    // account_id mirrors the dashboard's userAccounts[].id, which is the
    // login email (see migration 004). Both columns are UNIQUE, so the
    // insert below is also the race-proof duplicate check; this lookup just
    // gives a clear answer first, and matches case-insensitively the way
    // login does.
    const existing = await query(
      'SELECT 1 FROM app_users WHERE LOWER(email) = LOWER($1) OR LOWER(account_id) = LOWER($1) LIMIT 1',
      [email]
    );
    if (existing.rowCount) {
      throw new UserInputError(409, 'DUPLICATE_LOGIN', 'That login email is already in use by another account.', 'email');
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const inserted = await query(
      `INSERT INTO app_users (account_id, email, password_hash, requires_password, role, co, name)
       VALUES ($1, $1, $2, true, $3, $4, $5)
       RETURNING ${PUBLIC_COLUMNS}`,
      [email, passwordHash, role, co, name]
    );
    console.log('[auth] user created', { by: req.user?.id ?? null, account: email, role, co });
    res.status(201).json({ user: publicUser(inserted.rows[0]) });
  } catch (err) {
    sendUserError(err, res, 'POST /api/auth/users');
  }
});

// PUT /api/auth/sync-user — main Administrator only.
// Keeps the "User Roles" page working after login moved server-side: that
// page edits name/email/password against platform_state.data.userAccounts
// (still the visible record of an account's display details) and calls this
// so the change takes effect for real login, which checks app_users.
//
// 2026-11-16: this endpoint could previously be called by ANY admin token and
// wrote whatever role and company the body carried, so it could promote,
// demote or move any account — the opposite of what its own comment claimed.
// Now:
//   - main Administrator only (same rule as the page itself);
//   - an EXISTING account keeps the role and company it already has in
//     app_users. Only its email, name and (when supplied) password change;
//   - an account that does not exist yet is created only with a grantable
//     role/company, the same check POST /users applies.
// body: { accountId, email, name, role, co, password? }
router.put('/sync-user', authenticate, requireRole('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  if (!requireMainAdmin(req, res)) return;
  try {
    const { accountId, email, name, role, co, password } = req.body || {};
    if (!accountId || !email || !role) {
      res.status(400).json({ error: 'accountId, email and role are required' });
      return;
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    const passwordHash = password ? await bcrypt.hash(String(password), 12) : null;

    const current = await query('SELECT role, co FROM app_users WHERE account_id = $1', [String(accountId)]);
    if (current.rowCount) {
      if (passwordHash) {
        await query(
          `UPDATE app_users
              SET email = $2, name = $3, password_hash = $4, requires_password = true, updated_at = NOW()
            WHERE account_id = $1`,
          [String(accountId), normalizedEmail, name || null, passwordHash]
        );
      } else {
        // No new password supplied — the account's password/hash (or its
        // passwordless flag) is left exactly as it is.
        await query(
          'UPDATE app_users SET email = $2, name = $3, updated_at = NOW() WHERE account_id = $1',
          [String(accountId), normalizedEmail, name || null]
        );
      }
      res.json({ success: true });
      return;
    }

    // Not in app_users yet (an account that exists only in the dashboard's
    // record). Created with no usable password until one is set, as before.
    const newRole = String(role).trim().toLowerCase();
    const newCo = parseCo(co);
    assertGrantable(newRole, newCo);
    if (passwordHash) {
      await query(
        `INSERT INTO app_users (account_id, email, password_hash, requires_password, role, co, name)
         VALUES ($1, $2, $3, true, $4, $5, $6)`,
        [String(accountId), normalizedEmail, passwordHash, newRole, newCo, name || null]
      );
    } else {
      await query(
        `INSERT INTO app_users (account_id, email, role, co, name)
         VALUES ($1, $2, $3, $4, $5)`,
        [String(accountId), normalizedEmail, newRole, newCo, name || null]
      );
    }
    res.json({ success: true });
  } catch (err: unknown) {
    if ((err as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'Email already in use by another account' });
      return;
    }
    sendUserError(err, res, 'PUT /api/auth/sync-user');
  }
});

export default router;
