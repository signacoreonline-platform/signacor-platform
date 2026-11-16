/**
 * LocalStorageProvider — private files on the local filesystem. For local
 * development and tests only (Render's filesystem is ephemeral), exactly as in
 * Sally. Keys are generated (l_<32 hex>); a customer's filename never becomes
 * a path.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { storageMissing, storageCorruptRead } from './errors';
import type { SaveMeta, StorageProvider } from './index';

const KEY_RE = /^l_[a-f0-9]{32}$/;

export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local';
  private filesDir: string;
  constructor({ root }: { root: string }) {
    this.filesDir = path.join(path.resolve(root), 'files');
  }
  private locate(key: string): string {
    if (!KEY_RE.test(String(key))) throw storageMissing();
    const p = path.join(this.filesDir, key.slice(2, 4), key);
    if (!p.startsWith(this.filesDir + path.sep)) throw storageMissing();
    return p;
  }
  async healthCheck(): Promise<{ ok: true; provider: string }> {
    await fs.promises.mkdir(this.filesDir, { recursive: true, mode: 0o700 });
    await fs.promises.access(this.filesDir, fs.constants.W_OK);
    return { ok: true, provider: this.name };
  }
  async save(source: Buffer, meta: SaveMeta): Promise<string> {
    const key = `l_${crypto.randomBytes(16).toString('hex')}`;
    const target = this.locate(key);
    await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(target, source, { mode: 0o600, flag: 'wx' });
    await fs.promises.writeFile(`${target}.json`, JSON.stringify({ key, sha256: meta.sha256, extension: meta.extension || null, created_at: new Date().toISOString() }), { mode: 0o600 });
    return key;
  }
  async read(key: string, expectedSha256?: string): Promise<Buffer> {
    let buf: Buffer;
    try { buf = await fs.promises.readFile(this.locate(key)); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw storageMissing();
      throw err;
    }
    if (expectedSha256 && crypto.createHash('sha256').update(buf).digest('hex') !== expectedSha256) throw storageCorruptRead();
    return buf;
  }
  async exists(key: string): Promise<boolean> {
    try { await fs.promises.access(this.locate(key)); return true; } catch { return false; }
  }
}
