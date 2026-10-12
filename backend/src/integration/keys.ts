import crypto from 'crypto';

/** 48 random bytes, base64url — ~384 bits; shown once, never stored. */
export function generateSecret(): string {
  return crypto.randomBytes(48).toString('base64url');
}

/** Secrets are high-entropy random values, so a plain SHA-256 is appropriate. */
export function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Constant-time comparison of a presented secret with a stored hash. */
export function secretMatches(presented: string, storedHash: string): boolean {
  const a = Buffer.from(hashSecret(presented), 'hex');
  let b: Buffer;
  try { b = Buffer.from(String(storedHash), 'hex'); } catch { return false; }
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Stable hash of a request body, used to detect idempotency-key reuse. */
export function requestHash(operation: string, target: string, body: unknown): string {
  return crypto.createHash('sha256').update(`${operation}\n${target}\n${stableStringify(body)}`).digest('hex');
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}
