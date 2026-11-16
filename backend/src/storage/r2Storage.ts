/**
 * R2StorageProvider — files in a PRIVATE Cloudflare R2 bucket, through R2's
 * authenticated S3 API (Signature V4, no SDK).
 *
 * This is a TypeScript port of the provider Sally already runs in production
 * (signacore-sally: server/src/files/storage/r2Storage.js), keeping the same
 * contract so the two services behave identically against R2:
 *
 *   - Server-to-server only. The credentials live in this server's
 *     environment — never in the browser, a log, a response or a stored row.
 *   - CONTENT-ADDRESSED keys: <prefix>/sha256/<first two hex>/<sha256>. One
 *     set of bytes has exactly one key, so a repeated or concurrent save of
 *     the same file resolves to the same object and a different file can
 *     never overwrite it.
 *   - Every write is CONDITIONAL (If-None-Match: *) and carries the bytes'
 *     SHA-256 (signed, as x-amz-content-sha256) and Content-MD5; R2 refuses a
 *     body that does not match, so what is stored is exactly what was hashed.
 *   - A lost upload answer is RECONCILED, not repeated blindly: HEAD the key —
 *     present means the save succeeded, absent means it provably stored
 *     nothing (safe to retry).
 *   - Every read is integrity-checked against the SHA-256 in its key before a
 *     single byte is handed on. A corrupted read never looks like a good file.
 *   - NOTHING IS DELETED. A content-addressed object may back more than one
 *     record; removing an attachment retires its record, not the object.
 *   - No presigned URL is ever made or stored.
 *
 * The one deliberate difference from Sally is the key PREFIX. Sally's objects
 * live under "sally/v1/…"; this service's live under "signacore/v1/…". The
 * two can share a bucket without either ever reading, counting or colliding
 * with the other's files — and each refuses a key that is not its own.
 */
import https from 'https';
import http from 'http';
import crypto from 'crypto';
import type { IncomingMessage, IncomingHttpHeaders } from 'http';
import { signRequest, EMPTY_SHA256 } from './s3Signer';
import {
  StorageError, storageUnavailable, storageWrongAnswer, storageMissing, storageTooLarge, storageIntegrity,
  storageConfig, storageCredentials, storagePermission, storageKeyMismatch, storageCorruptRead, storageConflict,
} from './errors';
import type { SaveMeta, StorageProvider } from './index';

export const R2_KEY_PREFIX = 'signacore/v1';
export const R2_KEY_RE = /^signacore\/v1\/sha256\/[0-9a-f]{2}\/([0-9a-f]{64})$/;
const SHA_RE = /^[0-9a-f]{64}$/;
/** Never written: a HEAD answering 404 proves the endpoint, bucket and credentials are all fine. */
const HEALTH_KEY = `${R2_KEY_PREFIX}/health-probe`;
const HEALTH_CACHE_MS = 60_000;
const NEVER_CONNECTED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

const sha256Hex = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const shaOfKey = (key: string): string | null => R2_KEY_RE.exec(String(key))?.[1] || null;

/** The object key of a file with this SHA-256. */
export function r2KeyFor(sha256: string): string {
  if (!SHA_RE.test(String(sha256))) throw new Error('r2KeyFor needs a lower-case hex SHA-256');
  return `${R2_KEY_PREFIX}/sha256/${sha256.slice(0, 2)}/${sha256}`;
}

/**
 * The endpoint and bucket from the configured values. The S3 endpoint
 * Cloudflare shows may include the bucket as its path — accepted, and checked
 * against R2_BUCKET when both are given. Throws a plain Error naming the
 * problem (never a value).
 */
export function parseR2Endpoint(endpoint: string, bucket = ''): { origin: string; host: string; bucket: string } {
  let u: URL;
  try { u = new URL(String(endpoint || '').trim()); } catch { throw new Error('R2_ENDPOINT is not a valid URL'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname); // plain http only for a local S3 test server (never R2)
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error('R2_ENDPOINT must use https://');
  if (u.search || u.hash || u.username || u.password) throw new Error('R2_ENDPOINT must not contain a query, fragment or credentials');
  const fromPath = u.pathname.replace(/^\/+|\/+$/g, '');
  if (fromPath.includes('/')) throw new Error('R2_ENDPOINT has an unexpected path (expected none, or only the bucket name)');
  const b = String(bucket || '').trim() || fromPath;
  if (!b) throw new Error('R2_BUCKET is not set');
  if (fromPath && fromPath !== b) throw new Error('R2_ENDPOINT names a different bucket than R2_BUCKET');
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(b)) throw new Error('R2_BUCKET is not a valid bucket name');
  return { origin: `${u.protocol}//${u.host}`, host: u.host, bucket: b };
}

/** The S3 error code in an XML error answer (<Code>…</Code>), or null. */
const s3CodeOf = (text: string): string | null => /<Code>([A-Za-z0-9]{1,64})<\/Code>/.exec(String(text || ''))?.[1] || null;

async function readAll(res: IncomingMessage, limit = Infinity): Promise<Buffer> {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of res) { if (n < limit) { chunks.push(c as Buffer); n += (c as Buffer).length; } }
  return Buffer.concat(chunks);
}
/** A real object answer carries an ETag and is not an HTML page from something in between. */
function genuineObjectAnswer(h: IncomingHttpHeaders = {}): boolean {
  if (!h.etag) return false;
  return !/^text\/html/i.test(String(h['content-type'] || '')) || Boolean(h['x-amz-meta-sha256']);
}

export interface R2Config {
  endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string;
  region?: string; timeoutMs?: number;
}
interface HeadResult { size: number; sha256: string | null }

export class R2StorageProvider implements StorageProvider {
  readonly name = 'r2';
  private origin: string; private host: string; private bucket: string;
  private lib: typeof https | typeof http;
  private agent: https.Agent | http.Agent;
  private region: string; private timeoutMs: number;
  private creds!: { accessKeyId: string; secretAccessKey: string };
  private health: { at: number; err: Error | null } | null = null;

  constructor({ endpoint, bucket, accessKeyId, secretAccessKey, region = 'auto', timeoutMs = 120_000 }: R2Config) {
    const ep = parseR2Endpoint(endpoint, bucket);
    this.origin = ep.origin; this.host = ep.host; this.bucket = ep.bucket;
    this.lib = ep.origin.startsWith('https:') ? https : http;
    this.agent = new this.lib.Agent({ keepAlive: true, maxSockets: 16 });
    // Non-enumerable: the credentials can never be serialised into a log or a response.
    Object.defineProperty(this, 'creds', { value: { accessKeyId, secretAccessKey }, enumerable: false });
    this.region = region; this.timeoutMs = timeoutMs;
  }

  /** One signed request; resolves with the unconsumed response. */
  private request(method: string, key: string, opts: { headers?: Record<string, string>; body?: Buffer | null; payloadHash?: string; timeoutMs?: number } = {}): Promise<IncomingMessage> {
    const { headers = {}, body = null, payloadHash = EMPTY_SHA256, timeoutMs = this.timeoutMs } = opts;
    const path = `/${this.bucket}/${key}`;
    const signed = signRequest({ method, host: this.host, path, headers, payloadHash, region: this.region, ...this.creds });
    const url = `${this.origin}${path.split('/').map((s) => encodeURIComponent(s)).join('/')}`;
    return new Promise((resolve, reject) => {
      const req = this.lib.request(url, { method, agent: this.agent, headers: { ...signed.headers, 'User-Agent': 'signacore-backend/1' } });
      req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('storage timeout'), { code: 'ETIMEDOUT' })));
      req.on('response', resolve);
      req.on('error', reject);
      if (body) req.end(body); else req.end();
    });
  }

  /** A request that could not get an answer: provably not stored only when no connection was ever made. */
  private async call(method: string, key: string, opts?: Parameters<R2StorageProvider['request']>[2]): Promise<IncomingMessage> {
    try { return await this.request(method, key, opts); } catch (err) {
      const code = String((err as NodeJS.ErrnoException).code || 'NETWORK_ERROR');
      console.warn('[storage] r2 request failed', { method, err: /^[A-Z_]{3,40}$/.test(code) ? code : 'NETWORK_ERROR' });
      throw storageUnavailable(NEVER_CONNECTED.has(code));
    }
  }

  /** An S3 error answer -> a classified error (never the text of the answer beyond its S3 code). */
  private classify(status: number, text: string): StorageError {
    const code = s3CodeOf(text);
    console.warn('[storage] r2 answered with an error', { status, code });
    if (['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'InvalidToken', 'ExpiredToken', 'AuthorizationHeaderMalformed'].includes(String(code))) return storageCredentials();
    if (code === 'InvalidArgument' && status === 400) return storageConfig('R2 rejected the request as invalid');
    if (status === 401) return storageCredentials();
    if (status === 403) return storagePermission();
    if (code === 'NoSuchBucket') return storageConfig('the bucket was not found at the configured endpoint — check R2_BUCKET and R2_ENDPOINT');
    if (status === 404) return storageMissing();
    if (['XAmzContentSHA256Mismatch', 'BadDigest', 'IncompleteBody', 'InvalidDigest'].includes(String(code))) return storageIntegrity();
    if (status === 413 || code === 'EntityTooLarge') return storageTooLarge();
    if (!code) return storageWrongAnswer(); // no S3 error body: something else answered at this address
    return storageUnavailable(false); // 429 / 5xx / anything else: ambiguous for a write
  }
  private async fail(res: IncomingMessage): Promise<StorageError> {
    const text = (await readAll(res, 64 * 1024).catch(() => Buffer.alloc(0))).toString('utf8');
    return this.classify(res.statusCode || 0, text);
  }

  private assertKey(key: string): void { if (!R2_KEY_RE.test(String(key))) throw storageKeyMismatch(); }

  /** HEAD: { size, sha256 } or null when the object does not exist. */
  private async head(key: string): Promise<HeadResult | null> {
    const res = await this.call('HEAD', key);
    res.resume();
    if (res.statusCode === 200) {
      if (!genuineObjectAnswer(res.headers)) throw storageWrongAnswer(); // e.g. a browser-verification page answering 200
      const meta = String(res.headers['x-amz-meta-sha256'] || '');
      return { size: Number(res.headers['content-length']), sha256: SHA_RE.test(meta) ? meta : null };
    }
    if (res.statusCode === 404) return null;
    // A HEAD answer has no body, so a 401 / 403 does not say why. Ask once
    // with GET to read R2's error code (authentication vs permission).
    if (res.statusCode === 401 || res.statusCode === 403) {
      try {
        const again = await this.request('GET', key, { timeoutMs: 8000 });
        if (again.statusCode === 401 || again.statusCode === 403) throw await this.fail(again);
        again.resume();
      } catch (err) { if (err instanceof StorageError) throw err; }
      throw res.statusCode === 401 ? storageCredentials() : storagePermission();
    }
    throw this.classify(res.statusCode || 0, '');
  }

  async healthCheck({ force = false }: { force?: boolean } = {}): Promise<{ ok: true; provider: string }> {
    if (!force && this.health && Date.now() - this.health.at < HEALTH_CACHE_MS) {
      if (this.health.err) throw this.health.err;
      return { ok: true, provider: this.name };
    }
    try {
      await this.head(HEALTH_KEY); // 404 on the never-written probe key = reachable, bucket exists, credentials accepted
      this.health = { at: Date.now(), err: null };
      return { ok: true, provider: this.name };
    } catch (err) {
      this.health = { at: Date.now(), err: err as Error };
      throw err;
    }
  }

  /** The object already at a content key IS this file only with the same size and (when recorded) the same SHA-256. */
  private async verifyExisting(key: string, have: HeadResult, sha256: string, length: number): Promise<string> {
    if (Number(have.size) !== Number(length)) throw storageConflict();
    if (have.sha256 && have.sha256 !== sha256) throw storageConflict();
    if (!have.sha256) await this.read(key); // written without metadata: read() hashes it against the key before it is trusted
    return key;
  }

  /** Stores the bytes (or finds them already stored). Returns the object key. */
  async save(source: Buffer, meta: SaveMeta): Promise<string> {
    const length = source.length;
    const sha = meta.sha256 && SHA_RE.test(meta.sha256) ? meta.sha256 : sha256Hex(source);
    if (sha !== sha256Hex(source)) throw storageIntegrity();
    const key = r2KeyFor(sha);
    // 1. Already stored (a repeat, a concurrent save, or an earlier save whose answer was lost)? Then it is the same file: done.
    const have = await this.head(key);
    if (have) return this.verifyExisting(key, have, sha, length);
    // 2. Conditional write, only if absent.
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream', 'Content-Length': String(length),
      'Content-MD5': crypto.createHash('md5').update(source).digest('base64'),
      'If-None-Match': '*', 'x-amz-meta-sha256': sha, 'x-amz-meta-signacore-size': String(length),
    };
    if (meta.extension && /^[a-z0-9]{1,10}$/i.test(meta.extension)) headers['x-amz-meta-signacore-ext'] = meta.extension.toLowerCase();
    let res: IncomingMessage;
    try {
      res = await this.call('PUT', key, { headers, body: source, payloadHash: sha });
    } catch (err) {
      return this.reconcile(key, sha, length, err as StorageError); // no answer: find out whether it arrived
    }
    if (res.statusCode === 200 && res.headers.etag) {
      res.resume();
      this.health = null;
      const now = await this.head(key).catch(() => null); // confirm it is readable with the right size
      if (now && Number(now.size) !== Number(length)) throw storageConflict();
      return key;
    }
    if (res.statusCode === 412) { // a concurrent save of the same bytes wrote it first: verify and use it
      res.resume();
      const now = await this.head(key);
      if (now) return this.verifyExisting(key, now, sha, length);
      throw storageUnavailable(false);
    }
    const err = await this.fail(res);
    if (err.code === 'STORAGE_UNAVAILABLE') return this.reconcile(key, sha, length, err); // 5xx: did it arrive anyway?
    throw err;
  }

  /** After a write with no usable answer: present -> saved; absent -> provably not saved; unknown -> the original error. */
  private async reconcile(key: string, sha: string, length: number, original: StorageError): Promise<string> {
    let have: HeadResult | null;
    try { have = await this.head(key); } catch { throw original; }
    if (have) return this.verifyExisting(key, have, sha, length);
    throw storageUnavailable(true);
  }

  /** The whole object, verified against the SHA-256 in its key before it is returned. */
  async read(key: string, expectedSha256?: string): Promise<Buffer> {
    this.assertKey(key);
    const res = await this.call('GET', key);
    if (res.statusCode !== 200) throw await this.fail(res);
    if (!genuineObjectAnswer(res.headers)) { res.resume(); throw storageWrongAnswer(); }
    const buf = await readAll(res);
    const got = sha256Hex(buf);
    if (got !== shaOfKey(key) || (expectedSha256 && got !== expectedSha256)) {
      console.error('[storage] r2 read failed its integrity check', { bytes: buf.length });
      throw storageCorruptRead();
    }
    return buf;
  }

  async exists(key: string): Promise<boolean> {
    if (!R2_KEY_RE.test(String(key))) return false;
    return Boolean(await this.head(key));
  }
}
