-- 019_quote_attachments.sql
-- Metadata for files attached to a quotation before it is emailed (2026-11-16).
--
-- WHY A NEW TABLE (and not an existing column)
-- The dashboard already has a "quote attachments" field: whole files held as
-- base64 data URLs inside the quote's JSON. rel_quotes has no column for it and
-- the relational quote services neither accept nor return it, so the dashboard
-- itself has blocked adding or removing those files since 2026-08-24 — a file
-- attached that way is dropped on save, and one removed comes back on the next
-- authoritative read. It cannot preserve attachments across a refresh.
-- rel_quotes.legacy_data was considered and rejected for the same reasons its
-- other users document: every quote save bumps row_version (an attachment
-- change would raise a false "stale revision" conflict for anyone editing that
-- quote), concurrent uploads would be a read-modify-write of one JSON array,
-- and backfill.ts replaces legacy_data wholesale.
--
-- WHAT THIS TABLE HOLDS
-- One row per attached file: who it belongs to and where its bytes are. The
-- bytes themselves are NOT in the database — they live in private file storage
-- (backend/src/storage), under the key recorded here.
--
--   company_code + quote_source_id  the quotation's canonical saved identity.
--     quote_source_id is rel_quotes.source_id — the same id the dashboard
--     carries as quote.id — so it is stable across the string/number forms a
--     freshly created quote's id can take in the browser, and it is valid in
--     both the relational and the legacy JSON mode. It is deliberately NOT a
--     foreign key: attachments are never a reason a quote cannot be saved.
--   storage_provider / storage_key  where the file is, and through which
--     provider it must be read (a file is always read from the provider that
--     stored it, never from whatever the default is today).
--   sha256 / size_bytes             the file's fingerprint; every read is
--     verified against it before a byte is sent.
--   removed_at / removed_by         removal retires the record. The stored
--     object is never deleted (a content-addressed object may back more than
--     one record), and the row stays as an audit trail.
--
-- Idempotent and additive only:
--   - creates one new table and one new index
--   - never alters, drops or truncates anything
--   - never touches platform_state, rel_quotes or any existing row
--   - safe to re-run
-- Render applies it automatically through: npm run migrate && npm start

CREATE TABLE IF NOT EXISTS quote_attachments (
  id                BIGSERIAL PRIMARY KEY,
  company_code      TEXT NOT NULL,
  quote_source_id   TEXT NOT NULL,
  quote_number      TEXT,
  original_filename TEXT NOT NULL,
  extension         TEXT NOT NULL,
  mime_type         TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),
  sha256            TEXT NOT NULL,
  storage_provider  TEXT NOT NULL,
  storage_key       TEXT NOT NULL,
  uploaded_by       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at        TIMESTAMPTZ,
  removed_by        TEXT
);

CREATE INDEX IF NOT EXISTS idx_quote_attachments_quote
  ON quote_attachments (company_code, quote_source_id)
  WHERE removed_at IS NULL;
