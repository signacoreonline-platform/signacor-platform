/**
 * Upload validation for quotation attachments. Uploaded files are untrusted:
 * the extension is checked against an allow-list AND the file's real content
 * signature is verified — the browser-supplied MIME type is never trusted.
 *
 * Ported from Sally's validator (signacore-sally:
 * server/src/files/fileValidation.js), narrowed to the three families a
 * quotation may carry: JPEG (.jpg / .jpeg), PNG and PDF.
 */
import path from 'path';

export const QUOTE_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB per file
export type Family = 'jpeg' | 'png' | 'pdf';
export const ATTACHMENT_TYPES: Record<string, { family: Family; mime: string }> = {
  jpg: { family: 'jpeg', mime: 'image/jpeg' },
  jpeg: { family: 'jpeg', mime: 'image/jpeg' },
  png: { family: 'png', mime: 'image/png' },
  pdf: { family: 'pdf', mime: 'application/pdf' },
};
export const ALLOWED_EXTENSIONS = Object.keys(ATTACHMENT_TYPES);
/** What a browser may claim for each family. Anything else is a declared-type mismatch. */
const DECLARED_OK: Record<Family, string[]> = {
  jpeg: ['image/jpeg', 'image/jpg', 'image/pjpeg'],
  png: ['image/png'],
  pdf: ['application/pdf'],
};

export class UploadValidationError extends Error {
  code: string; status: number;
  constructor(code: string, message: string, status = 400) { super(message); this.code = code; this.status = status; }
}

const startsWith = (buf: Buffer, bytes: number[], offset = 0) => bytes.every((b, i) => buf[offset + i] === b);

/** Detects the real content family from magic bytes. */
export function sniff(buf: Buffer): string {
  if (!buf || buf.length < 4) return 'empty';
  if (startsWith(buf, [0x4d, 0x5a])) return 'executable'; // MZ (Windows PE)
  if (startsWith(buf, [0x7f, 0x45, 0x4c, 0x46])) return 'executable'; // ELF
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) return 'zip';
  return 'other';
}

/** Strips paths and control characters from a user-supplied filename. */
export function sanitiseFilename(name: unknown): string {
  const base = path.posix.basename(String(name == null ? '' : name).replace(/\\/g, '/'));
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^\.+/, '').trim();
  return (cleaned || 'upload').slice(0, 200);
}

export interface ValidatedUpload { originalFilename: string; extension: string; mimeType: string; family: Family }

/**
 * Validates one uploaded file and returns safe metadata, or throws an
 * UploadValidationError whose message can be shown to the person as-is.
 */
export function validateAttachment(input: { filename: unknown; declaredType?: unknown; buffer: Buffer }): ValidatedUpload {
  const safeName = sanitiseFilename(input.filename);
  const ext = path.extname(safeName).slice(1).toLowerCase();
  const type = ATTACHMENT_TYPES[ext];
  if (!ext || !type) {
    throw new UploadValidationError('TYPE_NOT_ALLOWED', `"${safeName}" is not an allowed file type. Attach JPEG (.jpg, .jpeg), PNG or PDF files only.`, 415);
  }
  const size = input.buffer ? input.buffer.length : 0;
  if (!size) throw new UploadValidationError('EMPTY_FILE', `"${safeName}" is empty.`);
  if (size > QUOTE_ATTACHMENT_MAX_BYTES) {
    throw new UploadValidationError('FILE_TOO_LARGE', `"${safeName}" is larger than the 5 MB limit per file.`, 413);
  }
  const declared = String(input.declaredType == null ? '' : input.declaredType).split(';')[0].trim().toLowerCase();
  if (declared && declared !== 'application/octet-stream' && !DECLARED_OK[type.family].includes(declared)) {
    throw new UploadValidationError('TYPE_MISMATCH', `"${safeName}" was sent as ${declared}, which does not match its .${ext} extension.`, 415);
  }
  const detected = sniff(input.buffer);
  if (detected !== type.family) {
    throw new UploadValidationError('CONTENT_MISMATCH', `"${safeName}" is not a real ${ext.toUpperCase()} file — its content does not match its .${ext} extension.`, 415);
  }
  return { originalFilename: safeName, extension: ext, mimeType: type.mime, family: type.family };
}
