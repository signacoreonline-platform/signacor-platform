-- ============================================================================
-- 013_quote_line_dimensions.sql
-- Signacore — quote/job line dimensions, piece count and complete-product link
-- Created 2026-08-24 (complete Quote reliability repair)
-- ============================================================================
--
-- WHY THIS EXISTS
--   A quote line carries five user-entered fields the relational schema has
--   never modelled:
--     sqmL, sqmW   the physical dimensions in mm. The form derives `qty` from
--                  them (qty = sqmL*sqmW/1e6 for m², sqmL/1000 for linear), so
--                  they are PRESENTATIONAL — they drive the spec line on the
--                  printed quote (index.html lineSizeText / the m² hint) and on
--                  the Job Card. Losing them does not move money; it blanks the
--                  specification the customer and the workshop read.
--     pQty         the PIECE COUNT. This one is FINANCIAL: the form computes
--                  every line as `pQty * qty * unitPrice` (index.html ~6753),
--                  and it also drives the Qty column on printed quotes,
--                  proformas and invoices (lineItemCount). Because it was never
--                  stored, the server recomputed `qty * unitPrice` and every
--                  multi-piece quote was persisted UNDER-PRICED by a factor of
--                  pQty — a reproduced R2645 quote stored as R1495.
--     cpId,        the Complete-Product this line was built from, and whether it
--     cpLinked     is still linked to it. The Complete-Product price cascade
--                  matches on `l.cpId===cp.id && l.cpLinked`; once dropped, that
--                  cascade silently stopped matching the quote forever.
--
--   They were previously surviving only inside `legacy_data`, and only for
--   BACKFILLED rows — every relational write set legacy_data to '{}', so the
--   first edit of a historical quote destroyed them and simultaneously repriced
--   the quote. legacy_data is documented as historical backfill provenance
--   (see reconcile.ts), not a store for live business fields, so these get real
--   columns here.
--
-- SAFETY
--   * Purely ADDITIVE — only ADD COLUMN IF NOT EXISTS, nothing else.
--   * IDEMPOTENT — safe to run any number of times.
--   * NON-DESTRUCTIVE — no DROP, no DELETE, no TRUNCATE, no UPDATE, no column
--     retyping, no constraint changes, no data movement of any kind.
--   * Every column is NULLABLE with no default, so every existing row is
--     untouched and stays valid. A NULL `pieces` means "not applicable / never
--     recorded" and is read as 1 by the pricing formula, so historical lines
--     price EXACTLY as they do today.
--   * Migrations 011 and 012 are not modified.
--
-- WHY `pieces` IS NUMERIC AND NOT INTEGER
--   The form's input is `type="number" step="1"`, but the value reaching the
--   server is whatever the browser holds. An INTEGER column would turn a stray
--   "2.5" into a raw 22P02 — precisely the opaque-500 class this repair exists
--   to remove. NUMERIC accepts it, and the service layer validates the range.
--
-- WHY `complete_product_source_id` IS TEXT AND NOT A FOREIGN KEY
--   Complete Products are NOT a relational section — they still live in
--   platform_state JSON, and their ids are timestamp-derived JS numbers. A FK
--   would reference a table that does not exist. This follows the established
--   `inventory_source_id` precedent: keep the originating id as a breadcrumb,
--   never risk a constraint violation on data the relational side cannot vouch
--   for.
-- ============================================================================

-- ── QUOTE LINES ─────────────────────────────────────────────────────────────
ALTER TABLE rel_quote_line_items ADD COLUMN IF NOT EXISTS sqm_l  NUMERIC(14,4);
ALTER TABLE rel_quote_line_items ADD COLUMN IF NOT EXISTS sqm_w  NUMERIC(14,4);
ALTER TABLE rel_quote_line_items ADD COLUMN IF NOT EXISTS pieces NUMERIC(14,4);
ALTER TABLE rel_quote_line_items ADD COLUMN IF NOT EXISTS complete_product_source_id TEXT;
ALTER TABLE rel_quote_line_items ADD COLUMN IF NOT EXISTS complete_product_linked    BOOLEAN;

-- ── JOB LINES (a converted quote's lines land here, and the Job Card reads
--    the very same specification off them) ──────────────────────────────────
ALTER TABLE rel_job_line_items   ADD COLUMN IF NOT EXISTS sqm_l  NUMERIC(14,4);
ALTER TABLE rel_job_line_items   ADD COLUMN IF NOT EXISTS sqm_w  NUMERIC(14,4);
ALTER TABLE rel_job_line_items   ADD COLUMN IF NOT EXISTS pieces NUMERIC(14,4);
ALTER TABLE rel_job_line_items   ADD COLUMN IF NOT EXISTS complete_product_source_id TEXT;
ALTER TABLE rel_job_line_items   ADD COLUMN IF NOT EXISTS complete_product_linked    BOOLEAN;

COMMENT ON COLUMN rel_quote_line_items.sqm_l  IS 'Physical length in mm. Presentational: qty is derived from it. NULL = not a dimensioned line.';
COMMENT ON COLUMN rel_quote_line_items.sqm_w  IS 'Physical width in mm (m² lines only). NULL = not applicable.';
COMMENT ON COLUMN rel_quote_line_items.pieces IS 'Piece count. FINANCIAL: line subtotal = pieces * qty * unit_price. NULL is read as 1.';
COMMENT ON COLUMN rel_quote_line_items.complete_product_source_id IS 'Originating Complete Product id (JSON section, not relational) — a breadcrumb, deliberately not a FK.';
COMMENT ON COLUMN rel_quote_line_items.complete_product_linked    IS 'Whether this line still tracks its Complete Product''s price.';
COMMENT ON COLUMN rel_job_line_items.pieces IS 'Piece count carried from the quote line. NULL is read as 1.';
