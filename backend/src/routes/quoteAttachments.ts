import express, { Router, Response, NextFunction, Request } from 'express';
import crypto from 'crypto';
import { query } from '../db/pool';
import { authenticate, AuthRequest, isReadOnlyRole, isHoldingsSession, HOLDINGS_CO } from '../middleware/auth';
import { isSectionCutOver } from '../relational/cutover';
import { getStorage, getStorageFor, storageStatus, StorageError } from '../storage';
import {
  validateAttachment, UploadValidationError, QUOTE_ATTACHMENT_MAX_BYTES, ALLOWED_EXTENSIONS,
} from '../storage/fileValidation';

/**
 * /api/quote-attachments — files attached to a quotation before it is emailed
 * (2026-11-16).
 *
 *   GET    /?quoteId=<id>     the quotation's attachments + storage status + limits
 *   POST   /?quoteId=<id>     upload ONE file (raw body; name in X-File-Name)
 *   GET    /:id/content       the file's bytes (verified before a byte is sent)
 *   DELETE /:id               retire the attachment (the stored object is kept)
 *
 * STORAGE. Bytes go to private file storage through backend/src/storage — the
 * same provider contract Sally runs in production. The browser never sees a
 * storage credential, a bucket address or a signed URL: every file is read
 * back through /:id/content, which checks the session first, exactly as
 * Sally's own /files/:id/download does.
 *
 * WHO. Roles that work with quotations (admin, accounts, assistant). A
 * view-only login cannot upload or remove (refused by `authenticate`) and is
 * not shown quotation files at all.
 *
 * WHICH COMPANY, WHICH QUOTATION. Both are decided HERE, from the session and
 * the stored quotation — never from anything the request claims:
 *   - the quotation is looked up by its canonical saved identity
 *     (rel_quotes.source_id; in legacy JSON mode, the quote's id);
 *   - a Holdings session may reach only Holdings (company 1) quotations, and
 *     every other session may reach only the rest — the same rule the
 *     dashboard's belongsToUserCompany() applies;
 *   - a file is reached through its own row, whose company is checked again.
 * A quotation or file in the other company answers exactly like one that does
 * not exist (404), so nothing can be learned by probing ids.
 */
const router = Router();
router.use(authenticate);

export const MAX_ATTACHMENTS_PER_QUOTE = 20;
const HOLDINGS_CODE = String(HOLDINGS_CO);

class ApiError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
const notFound = () => new ApiError(404, 'NOT_FOUND', 'That quotation or file could not be found.');

function sendError(err: unknown, res: Response, where: string): void {
  if (err instanceof ApiError || err instanceof UploadValidationError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof StorageError) {
    res.status(err.status).json({ error: err.message, code: err.code, notSaved: err.notSaved });
    return;
  }
  console.error(`${where} failed:`, err);
  res.status(500).json({ error: 'The server could not complete that. Please try again.', code: 'SERVER_ERROR' });
}

/** Quotation files are for the roles that work with quotations. */
function requireQuoteRole(req: AuthRequest, res: Response): boolean {
  if (req.user && !isReadOnlyRole(req.user.role)) return true;
  res.status(403).json({ error: 'This login cannot open quotation files.', code: 'NOT_ALLOWED' });
  return false;
}
/** True when this session may reach records of this company. */
function sessionMayReachCompany(req: AuthRequest, companyCode: string): boolean {
  const holdingsRecord = String(companyCode) === HOLDINGS_CODE;
  return isHoldingsSession(req.user) ? holdingsRecord : !holdingsRecord;
}

interface QuoteRef { sourceId: string; companyCode: string; quoteNumber: string | null }

/**
 * The saved quotation with this id, or null. Relational mode reads rel_quotes;
 * legacy JSON mode reads the quote out of platform_state. Read-only.
 */
async function findQuote(rawId: unknown): Promise<QuoteRef | null> {
  const sourceId = String(rawId == null ? '' : rawId).trim();
  if (!sourceId || sourceId.length > 80) return null;
  if (await isSectionCutOver('quotes')) {
    const r = await query('SELECT source_id, company_code, quote_number FROM rel_quotes WHERE source_id = $1', [sourceId]);
    if (!r.rowCount) return null;
    return { sourceId: String(r.rows[0].source_id), companyCode: String(r.rows[0].company_code), quoteNumber: r.rows[0].quote_number ?? null };
  }
  const r = await query(
    `SELECT q->>'co' AS co, q->>'num' AS num
       FROM platform_state ps, jsonb_array_elements(
              CASE WHEN jsonb_typeof(ps.data->'quotes') = 'array' THEN ps.data->'quotes' ELSE '[]'::jsonb END) AS q
      WHERE ps.id = 1 AND q->>'id' = $1
      LIMIT 1`,
    [sourceId]
  );
  if (!r.rowCount) return null;
  const co = r.rows[0].co;
  // A quote with no company tag belongs to the original company (see
  // index.html belongsToUserCompany). '0' records "no tag" — it is never '1'.
  return { sourceId, companyCode: co == null || co === '' ? '0' : String(co), quoteNumber: r.rows[0].num ?? null };
}

async function requireQuote(req: AuthRequest): Promise<QuoteRef> {
  const quote = await findQuote(req.query.quoteId);
  if (!quote || !sessionMayReachCompany(req, quote.companyCode)) throw notFound();
  return quote;
}

interface AttachmentRow {
  id: string; company_code: string; quote_source_id: string; quote_number: string | null;
  original_filename: string; extension: string; mime_type: string; size_bytes: number; sha256: string;
  storage_provider: string; storage_key: string; uploaded_by: string | null; created_at: Date; removed_at: Date | null;
}
/** What the browser is given. Never the storage key or provider. */
function publicAttachment(r: AttachmentRow) {
  return {
    id: Number(r.id), quoteId: r.quote_source_id, filename: r.original_filename, extension: r.extension,
    mimeType: r.mime_type, size: Number(r.size_bytes), sha256: r.sha256,
    uploadedBy: r.uploaded_by, createdAt: r.created_at,
  };
}
const limits = () => ({
  maxFileBytes: QUOTE_ATTACHMENT_MAX_BYTES, allowedExtensions: ALLOWED_EXTENSIONS, maxFilesPerQuote: MAX_ATTACHMENTS_PER_QUOTE,
});

async function requireAttachment(req: AuthRequest): Promise<AttachmentRow> {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw notFound();
  const r = await query('SELECT * FROM quote_attachments WHERE id = $1 AND removed_at IS NULL', [id]);
  const row: AttachmentRow | undefined = r.rows[0];
  if (!row || !sessionMayReachCompany(req, row.company_code)) throw notFound();
  return row;
}

// GET /api/quote-attachments?quoteId=<id>
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!requireQuoteRole(req, res)) return;
  try {
    const quote = await requireQuote(req);
    const r = await query(
      `SELECT * FROM quote_attachments
        WHERE company_code = $1 AND quote_source_id = $2 AND removed_at IS NULL
        ORDER BY id`,
      [quote.companyCode, quote.sourceId]
    );
    const st = storageStatus();
    res.json({
      quoteId: quote.sourceId,
      attachments: r.rows.map(publicAttachment),
      storage: { configured: st.configured },
      limits: limits(),
    });
  } catch (err) {
    sendError(err, res, 'GET /api/quote-attachments');
  }
});

// The raw-body parser for an upload. The limit sits just above 5 MB so a
// slightly-too-large file reaches validateAttachment() and gets its precise
// message; anything far larger is cut off here and reported the same way.
const rawUpload = express.raw({ type: () => true, limit: QUOTE_ATTACHMENT_MAX_BYTES + 64 * 1024 });
function uploadTooLarge(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (err && (err as { type?: string }).type === 'entity.too.large') {
    res.status(413).json({ error: 'That file is larger than the 5 MB limit per file.', code: 'FILE_TOO_LARGE' });
    return;
  }
  next(err);
}

// POST /api/quote-attachments?quoteId=<id>
// body: the file's bytes. Headers: X-File-Name (URI-encoded), Content-Type (declared type).
router.post('/', rawUpload, uploadTooLarge, async (req: AuthRequest, res: Response): Promise<void> => {
  if (!requireQuoteRole(req, res)) return;
  try {
    const quote = await requireQuote(req);
    if (!Buffer.isBuffer(req.body)) {
      throw new ApiError(415, 'TYPE_NOT_ALLOWED', 'Send the file itself as the request body. Attach JPEG (.jpg, .jpeg), PNG or PDF files only.');
    }
    let filename = '';
    try { filename = decodeURIComponent(String(req.headers['x-file-name'] || '')); } catch { filename = ''; }
    if (!filename) throw new ApiError(400, 'FILENAME_REQUIRED', 'The file name is missing.');

    const buffer: Buffer = req.body;
    const valid = validateAttachment({ filename, declaredType: req.headers['content-type'], buffer });
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

    const existing = await query(
      `SELECT * FROM quote_attachments
        WHERE company_code = $1 AND quote_source_id = $2 AND removed_at IS NULL
        ORDER BY id`,
      [quote.companyCode, quote.sourceId]
    );
    // The same file attached twice (a double click, or a retry after an
    // upload whose answer was lost) is the same attachment, not a second one.
    const same = (existing.rows as AttachmentRow[]).find((r) => r.sha256 === sha256 && r.original_filename === valid.originalFilename);
    if (same) { res.status(200).json({ attachment: publicAttachment(same), duplicate: true }); return; }
    if (existing.rows.length >= MAX_ATTACHMENTS_PER_QUOTE) {
      throw new ApiError(409, 'TOO_MANY_FILES', `A quotation can carry at most ${MAX_ATTACHMENTS_PER_QUOTE} attached files. Remove one first.`);
    }

    const storage = getStorage();
    const key = await storage.save(buffer, { sha256, extension: valid.extension });
    // The record is written only once the bytes are safely stored.
    const inserted = await query(
      `INSERT INTO quote_attachments
         (company_code, quote_source_id, quote_number, original_filename, extension, mime_type,
          size_bytes, sha256, storage_provider, storage_key, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [quote.companyCode, quote.sourceId, quote.quoteNumber, valid.originalFilename, valid.extension, valid.mimeType,
        buffer.length, sha256, storage.name, key, req.user?.id ?? null]
    );
    res.status(201).json({ attachment: publicAttachment(inserted.rows[0]) });
  } catch (err) {
    sendError(err, res, 'POST /api/quote-attachments');
  }
});

// GET /api/quote-attachments/:id/content[?download=1]
router.get('/:id/content', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!requireQuoteRole(req, res)) return;
  try {
    const row = await requireAttachment(req);
    // Read from the provider that stored it, and verified against the
    // recorded fingerprint before a single header is sent — a damaged or
    // missing file is a clear error, never a partial or wrong download.
    const bytes = await getStorageFor(row.storage_provider).read(row.storage_key, row.sha256);
    if (bytes.length !== Number(row.size_bytes)) throw new StorageError('STORAGE_CORRUPT_READ', 'The stored file failed its integrity check and was not sent.', 502);
    const inline = req.query.download !== '1';
    res.setHeader('Content-Type', row.mime_type);
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.original_filename)}`);
    res.end(bytes);
  } catch (err) {
    sendError(err, res, 'GET /api/quote-attachments/:id/content');
  }
});

// DELETE /api/quote-attachments/:id
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!requireQuoteRole(req, res)) return;
  try {
    const row = await requireAttachment(req);
    await query(
      'UPDATE quote_attachments SET removed_at = NOW(), removed_by = $2 WHERE id = $1 AND removed_at IS NULL',
      [Number(row.id), req.user?.id ?? null]
    );
    res.json({ removed: true, id: Number(row.id) });
  } catch (err) {
    sendError(err, res, 'DELETE /api/quote-attachments/:id');
  }
});

export default router;
