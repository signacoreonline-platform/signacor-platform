import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// `co` mirrors the live app's simple Holdings(1)/Original(other) company
// model (see index.html isHoldingsUser/belongsToUserCompany) — deliberately
// not `company_id` (a UUID FK into the separate, unused schema.sql
// `companies` table). Optional because most accounts (Original company,
// pre-Holdings) carry no `co` at all.
export interface AuthRequest extends Request {
  user?: { id: string; email: string; role: string; co?: number | null };
}

/**
 * VIEW-ONLY ROLES (2026-11-16).
 *
 * Until now no route checked a role before writing: any valid token —
 * including the two passwordless Manufacturing logins (Factory / Print Room,
 * role `factory`) — could save platform state, jobs, invoices and payments.
 *
 * The rule is fail-closed: a role may write only if it is listed in
 * WRITE_ROLES. `factory` is not, so it is view-only, and so is any role this
 * server does not recognise. The role comes from the signed token, so every
 * EXISTING session receives the restriction on its very next request — no
 * re-login, no session table, nothing to migrate.
 *
 * It is enforced inside `authenticate` itself, which every data router
 * already mounts with `router.use(authenticate)`. That makes it impossible to
 * add a write route that forgets the check: platform-state (full and partial
 * saves), the relational API (creates, edits, status changes, deletes,
 * payments), document-number and quote-conversion reservations, uploads, the
 * legacy routers and the admin routes are all covered by this one test.
 */
export const HOLDINGS_CO = 1;
export const WRITE_ROLES: ReadonlySet<string> = new Set(['admin', 'accounts', 'assistant']);
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export function normaliseRole(role: unknown): string {
  return String(role == null ? '' : role).trim().toLowerCase();
}
/** True when this role may only read. */
export function isReadOnlyRole(role: unknown): boolean {
  return !WRITE_ROLES.has(normaliseRole(role));
}
/** The main (original-company) Administrator — the only account that manages users. */
export function isMainAdmin(user: AuthRequest['user'] | undefined | null): boolean {
  return !!user && normaliseRole(user.role) === 'admin' && Number(user.co) !== HOLDINGS_CO;
}
/** True when the session is scoped to Signacore Holdings (co: 1). */
export function isHoldingsSession(user: AuthRequest['user'] | undefined | null): boolean {
  return !!user && Number(user.co) === HOLDINGS_CO;
}
export const READ_ONLY_MESSAGE =
  'This login is view-only. It can open and print records but cannot change, send or upload anything.';

export const authenticate = (req: AuthRequest, res: Response, next: NextFunction): void => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    res.status(401).json({ error: 'No token provided' });
    return;
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret') as AuthRequest['user'];
    req.user = decoded;
    if (!SAFE_METHODS.has(String(req.method || '').toUpperCase()) && isReadOnlyRole(decoded?.role)) {
      res.status(403).json({ error: READ_ONLY_MESSAGE, code: 'READ_ONLY_ROLE' });
      return;
    }
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

export const requireRole = (...roles: string[]) =>
  (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  };
