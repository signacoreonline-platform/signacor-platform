/**
 * Authentication, scope checks, rate limiting and audit for /api/v1/integration.
 *
 * Completely separate from the dashboard's JWT login: an integration secret
 * is never accepted by any other route, and a dashboard JWT is never
 * accepted here.
 *
 * Credentials travel ONLY in headers:
 *   X-Integration-Client: <client_id>
 *   Authorization: Bearer <secret>
 * Query-string values are never read as credentials. In addition, a request
 * carrying a query parameter named key, apikey, api_key, token, secret or
 * access_token (in any letter case) is refused outright, so a secret pasted
 * into a URL is rejected rather than silently ignored.
 */
import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { query } from '../db/pool';
import { effectiveScopes, Scope } from './scopes';
import { secretMatches } from './keys';
import { IntegrationError, sendError } from './errors';

export interface IntegrationContext {
  clientId: string;
  displayName: string;
  scopes: Scope[];
  companyCode: string;
  actingFor: string | null;
  confirmedBy: string | null;
  requestId: string;
}

export interface IntegrationRequest extends Request {
  integration?: IntegrationContext;
}

const CLIENT_ID_RE = /^[a-z][a-z0-9-]{2,39}$/;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = Number(process.env.INTEGRATION_RATE_LIMIT_PER_MIN) > 0 ? Number(process.env.INTEGRATION_RATE_LIMIT_PER_MIN) : 120;
const hits = new Map<string, { windowStart: number; count: number }>();

/** Printable, bounded header value (used for attribution only — never trusted for authorisation). */
function headerText(req: Request, name: string, max = 120): string | null {
  const v = req.get(name);
  if (!v) return null;
  const clean = v.replace(/[^\x20-\x7E]/g, '').trim().slice(0, max);
  return clean || null;
}

function rateLimited(clientId: string): boolean {
  const now = Date.now();
  const h = hits.get(clientId);
  if (!h || now - h.windowStart > RATE_WINDOW_MS) { hits.set(clientId, { windowStart: now, count: 1 }); return false; }
  h.count += 1;
  return h.count > RATE_MAX;
}

/** For tests only. */
export function resetRateLimits(): void { hits.clear(); }

/** Writes one audit row when the response finishes. Never throws. */
function attachAudit(req: IntegrationRequest, res: Response, presentedClientId: string): void {
  res.on('finish', () => {
    const status = res.statusCode;
    const outcome = res.locals.replayed ? 'replayed'
      : status < 400 ? 'success'
      : status === 401 || status === 403 ? 'denied'
      : status >= 500 ? 'error' : 'rejected';
    const ctx = req.integration;
    query(
      `INSERT INTO integration_audit (client_id, request_id, operation, method, is_mutation, target_type, target_id,
         outcome, http_status, error_code, acting_for, confirmed_by, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [ctx?.clientId || presentedClientId, ctx?.requestId || null, res.locals.operation || 'unknown', req.method,
       req.method !== 'GET', res.locals.targetType || null, res.locals.targetId != null ? String(res.locals.targetId) : null,
       outcome, status, res.locals.integrationErrorCode || null, ctx?.actingFor || null, ctx?.confirmedBy || null,
       headerText(req, 'Idempotency-Key', 100)]
    ).catch((err) => console.error('[integration] audit write failed:', err?.message || err));
  });
}

export async function integrationAuth(req: IntegrationRequest, res: Response, next: NextFunction): Promise<void> {
  if (process.env.INTEGRATION_API_ENABLED !== 'true') {
    // Fail closed: the router exists in code but does nothing until a person
    // deliberately enables it in the environment.
    res.status(503).json({ error: { code: 'INTEGRATION_DISABLED', message: 'The integration API is not enabled on this server.' } });
    return;
  }
  const presentedRaw = headerText(req, 'X-Integration-Client', 40) || '';
  const presented = CLIENT_ID_RE.test(presentedRaw) ? presentedRaw : 'unknown';
  attachAudit(req, res, presented);

  if (process.env.NODE_ENV === 'production' && req.get('x-forwarded-proto') !== 'https' && !req.secure) {
    return sendError(res, new IntegrationError(400, 'HTTPS_REQUIRED', 'HTTPS is required.'));
  }
  const q = req.query as Record<string, unknown>;
  const CREDENTIAL_QUERY_KEYS = ['key', 'apikey', 'api_key', 'token', 'secret', 'access_token'];
  if (Object.keys(q).some((k) => CREDENTIAL_QUERY_KEYS.includes(k.toLowerCase()))) {
    return sendError(res, new IntegrationError(400, 'CREDENTIALS_IN_URL', 'Credentials must never be sent in the URL.'));
  }

  const auth = req.get('authorization') || '';
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(auth);
  if (presented === 'unknown' || !m) {
    return sendError(res, new IntegrationError(401, 'UNAUTHENTICATED', 'Integration credentials are missing or invalid.'));
  }
  try {
    const r = await query(
      `SELECT client_id, display_name, secret_hash, scopes, company_code, is_active, revoked_at
         FROM integration_clients WHERE client_id = $1`,
      [presented]
    );
    const row = r.rows[0];
    // One generic answer for unknown client, wrong secret, inactive or revoked —
    // a caller learns nothing about which part was wrong.
    if (!row || !row.is_active || row.revoked_at || !secretMatches(m[1], row.secret_hash)) {
      return sendError(res, new IntegrationError(401, 'UNAUTHENTICATED', 'Integration credentials are missing or invalid.'));
    }
    if (rateLimited(row.client_id)) {
      res.set('Retry-After', '60');
      return sendError(res, new IntegrationError(429, 'RATE_LIMITED', 'Too many requests. Please retry shortly.'));
    }
    req.integration = {
      clientId: row.client_id,
      displayName: row.display_name,
      scopes: effectiveScopes(row.scopes),
      companyCode: String(row.company_code),
      actingFor: headerText(req, 'X-Acting-For'),
      confirmedBy: headerText(req, 'X-Confirmed-By'),
      requestId: headerText(req, 'X-Request-Id', 64) || crypto.randomUUID(),
    };
    res.set('X-Request-Id', req.integration.requestId);
    query(
      `UPDATE integration_clients SET last_used_at = NOW()
        WHERE client_id = $1 AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '1 minute')`,
      [row.client_id]
    ).catch(() => undefined);
    next();
  } catch (err) {
    console.error('[integration] auth lookup failed:', (err as Error)?.message || err);
    sendError(res, new IntegrationError(503, 'UNAVAILABLE', 'Signacore is temporarily unavailable.'));
  }
}

/** Route guard: the client must hold ALL listed scopes. */
export function requireScope(...needed: Scope[]) {
  return (req: IntegrationRequest, res: Response, next: NextFunction): void => {
    const have = req.integration?.scopes || [];
    const missing = needed.filter((s) => !have.includes(s));
    if (missing.length) {
      return sendError(res, new IntegrationError(403, 'FORBIDDEN_SCOPE', 'This integration client is not permitted to do that.', { missing }));
    }
    next();
  };
}

export function hasScope(req: IntegrationRequest, s: Scope): boolean {
  return Boolean(req.integration?.scopes.includes(s));
}
