/**
 * AWS Signature Version 4 for the S3 API (Cloudflare R2 speaks it). Pure; no
 * I/O; no dependency.
 *
 * A TypeScript port of Sally's signer (signacore-sally:
 * server/src/files/storage/s3Signer.js) so the two services sign requests
 * identically. Header-based signing of a single request (PUT / GET / HEAD)
 * with the payload's SHA-256 signed as x-amz-content-sha256. No presigned
 * URLs are ever made: every file is streamed through this server's own
 * permission-checked routes.
 */
import crypto from 'crypto';

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();
const sha256Hex = (data: string) => crypto.createHash('sha256').update(data, 'utf8').digest('hex');

/** RFC 3986 encoding as S3 expects it (unreserved characters kept; '/' kept in paths when asked). */
export function uriEncode(s: string, { keepSlash = false }: { keepSlash?: boolean } = {}): string {
  return Array.from(Buffer.from(String(s), 'utf8')).map((b) => {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === '/')) return c;
    return `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
}

/** "20261029T183842Z" / "20261029" */
export function amzDates(date: Date = new Date()): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

export interface SignInput {
  method: string; host: string; path: string;
  query?: Record<string, string>; headers?: Record<string, string | number>;
  payloadHash?: string; accessKeyId: string; secretAccessKey: string;
  region?: string; service?: string; date?: Date;
}

/** Signs a request. Returns the headers to send (the given ones + x-amz-date, x-amz-content-sha256, Authorization). */
export function signRequest({
  method, host, path, query = {}, headers = {}, payloadHash = EMPTY_SHA256,
  accessKeyId, secretAccessKey, region = 'auto', service = 's3', date = new Date(),
}: SignInput): { headers: Record<string, string>; signature: string } {
  const { amzDate, dateStamp } = amzDates(date);
  const all: Record<string, string> = {
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')])),
    host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash,
  };
  // Signed: host, every x-amz-* header, and the content / condition headers set by the caller.
  const signedNames = Object.keys(all)
    .filter((k) => k === 'host' || k.startsWith('x-amz-') || ['content-type', 'if-none-match', 'if-match', 'range', 'date', 'content-md5'].includes(k))
    .sort();
  const canonicalHeaders = signedNames.map((k) => `${k}:${all[k]}\n`).join('');
  const signedHeaders = signedNames.join(';');
  const canonicalQuery = Object.keys(query).sort().map((k) => `${uriEncode(k)}=${uriEncode(query[k] ?? '')}`).join('&');
  const canonicalUri = uriEncode(path.startsWith('/') ? path : `/${path}`, { keepSlash: true });
  const canonicalRequest = [method.toUpperCase(), canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  const out: Record<string, string> = {
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)])),
    'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash,
  };
  out.Authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers: out, signature };
}
