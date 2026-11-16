/**
 * File-storage abstraction for the Signacore backend (2026-11-16).
 *
 * Modelled on — and deliberately compatible with — Sally's storage layer
 * (signacore-sally: server/src/files/storage/index.js). All file I/O goes
 * through a provider with one interface, so no route ever talks to a
 * filesystem or an HTTP API directly:
 *
 *   save(buffer, { sha256, extension }) -> key      read(key, sha256) -> Buffer
 *   exists(key)                                     healthCheck()
 *
 * Providers (the same names and the same environment variables Sally uses):
 *   local   LocalStorageProvider   development / tests only
 *   r2      R2StorageProvider      Cloudflare R2, private bucket, S3 API
 *
 * WHERE A FILE IS READ: always from the provider recorded on its own row,
 * never from the default. FILE_STORAGE_PROVIDER only decides where NEW files
 * go, so changing it later can never strand a file that is already stored.
 *
 * FAIL-CLOSED: with nothing configured, storage is OFF. Nothing else in the
 * platform depends on it — only the attachment routes answer "not configured".
 * Configuration (read from the environment; secrets are never logged or returned):
 *   FILE_STORAGE_PROVIDER   r2 | local            (unset = storage off)
 *   R2_ENDPOINT             https://<account id>.r2.cloudflarestorage.com
 *   R2_BUCKET               the private bucket's name
 *   R2_ACCESS_KEY_ID        R2 API token id      (Object Read & Write on that bucket only)
 *   R2_SECRET_ACCESS_KEY    R2 API token secret
 *   R2_TIMEOUT_MS           optional, default 120000
 *   FILE_STORAGE_PATH       local provider only, default ./storage
 *   ALLOW_LOCAL_STORAGE_IN_PRODUCTION=true   required to use `local` when NODE_ENV=production
 */
import path from 'path';
import { LocalStorageProvider } from './localStorage';
import { R2StorageProvider } from './r2Storage';
import { storageNotConfigured, storageConfig } from './errors';

export interface SaveMeta { sha256: string; extension?: string }
export interface StorageProvider {
  readonly name: string;
  save(source: Buffer, meta: SaveMeta): Promise<string>;
  read(key: string, expectedSha256?: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  healthCheck(opts?: { force?: boolean }): Promise<{ ok: true; provider: string }>;
}

export const PROVIDERS = ['local', 'r2'] as const;
const instances = new Map<string, StorageProvider>();

const env = () => process.env;
/** The provider NEW files go to, or '' when storage is off. */
export function activeProviderName(): string {
  return String(env().FILE_STORAGE_PROVIDER || '').trim().toLowerCase();
}

/** Problems with the configuration for `name` — NAMES ONLY, never a value. Empty when it is usable. */
export function configProblems(name: string = activeProviderName()): string[] {
  const e = env();
  const out: string[] = [];
  if (!name) return ['FILE_STORAGE_PROVIDER is not set'];
  if (name === 'local') {
    if (e.NODE_ENV === 'production' && String(e.ALLOW_LOCAL_STORAGE_IN_PRODUCTION || '').toLowerCase() !== 'true') {
      out.push('FILE_STORAGE_PROVIDER=local is not allowed in production (Render disks are ephemeral) — use r2');
    }
    return out;
  }
  if (name === 'r2') {
    const endpoint = String(e.R2_ENDPOINT || '').trim();
    if (!endpoint) out.push('R2_ENDPOINT is not set');
    else {
      try {
        const u = new URL(endpoint);
        const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
        if (e.NODE_ENV === 'production' && (u.protocol !== 'https:' || !/\.r2\.cloudflarestorage\.com$/.test(u.hostname))) {
          out.push('R2_ENDPOINT must be an https R2 S3 endpoint (…r2.cloudflarestorage.com)');
        } else if (u.protocol !== 'https:' && !loopback) out.push('R2_ENDPOINT must use https://');
        const fromPath = u.pathname.replace(/^\/+|\/+$/g, '');
        if (!fromPath && !String(e.R2_BUCKET || '').trim()) out.push('R2_BUCKET is not set');
      } catch { out.push('R2_ENDPOINT is not a valid URL'); }
    }
    if (String(e.R2_ACCESS_KEY_ID || '').trim().length < 16) out.push('R2_ACCESS_KEY_ID is not set');
    if (String(e.R2_SECRET_ACCESS_KEY || '').trim().length < 32) out.push('R2_SECRET_ACCESS_KEY is not set');
    return out;
  }
  return [`FILE_STORAGE_PROVIDER "${name}" is not supported (use ${PROVIDERS.join(' or ')})`];
}

function createProvider(name: string): StorageProvider {
  const problems = configProblems(name);
  if (problems.length) {
    console.warn('[storage] not usable:', problems.join('; '));
    throw name && (PROVIDERS as readonly string[]).includes(name) ? storageNotConfigured(name) : storageNotConfigured(name || 'none');
  }
  const e = env();
  if (name === 'local') return new LocalStorageProvider({ root: path.resolve(e.FILE_STORAGE_PATH || './storage') });
  try {
    return new R2StorageProvider({
      endpoint: String(e.R2_ENDPOINT || '').trim(), bucket: String(e.R2_BUCKET || '').trim(),
      accessKeyId: String(e.R2_ACCESS_KEY_ID || '').trim(), secretAccessKey: String(e.R2_SECRET_ACCESS_KEY || '').trim(),
      timeoutMs: Number(e.R2_TIMEOUT_MS) > 0 ? Number(e.R2_TIMEOUT_MS) : 120_000,
    });
  } catch (err) {
    throw storageConfig((err as Error).message);
  }
}

/** The provider for a stored file — the one recorded on its row. */
export function getStorageFor(name: string): StorageProvider {
  const key = String(name || '').trim().toLowerCase();
  const cached = instances.get(key);
  if (cached) return cached;
  const created = createProvider(key);
  instances.set(key, created);
  return created;
}
/** The provider NEW files go to. Throws STORAGE_NOT_CONFIGURED when storage is off. */
export function getStorage(): StorageProvider {
  return getStorageFor(activeProviderName());
}
/** Non-sensitive status for the UI: is storage usable, and if not, why (names of settings only). */
export function storageStatus(): { configured: boolean; provider: string | null; problems: string[] } {
  const name = activeProviderName();
  const problems = configProblems(name);
  return { configured: problems.length === 0, provider: name || null, problems };
}
/** Test hook: replace (or clear) a provider instance. */
export function setStorageInstance(name: string, provider: StorageProvider | null): void {
  if (provider) instances.set(name, provider); else instances.delete(name);
}
/** Test hook: forget every cached provider so the environment is re-read. */
export function resetStorageForTests(): void { instances.clear(); }

export { StorageError } from './errors';
