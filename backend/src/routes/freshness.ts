/**
 * GET /api/freshness — RELIABILITY PHASE 1 (2026-08-26)
 *
 * A tiny, metadata-only answer to one question: "has anything I care about
 * changed since the token I am holding?"
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ══════════════════════════════════════════════════════════════════════════
 * The frontend's 30-second poll decided whether to reload by comparing
 * `stateStamp()` — `data._autoSavedAt` / `data.savedAt`, both of which live
 * INSIDE the platform_state JSON blob. A relational write (a quote edit, a job
 * stage change, a payment, an invoice) never touches that blob, so the stamp
 * never moved and the poll always short-circuited. One user could commit a
 * change and every other logged-in session would keep showing the old value
 * for the rest of its session — not for 30 seconds, indefinitely. This
 * endpoint replaces that signal for relational sections with one derived from
 * the relational tables themselves.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE TOKEN, AND WHY IT DETECTS ALL THREE MUTATIONS
 * ══════════════════════════════════════════════════════════════════════════
 * Per section:   c=<COUNT(*)>  v=<SUM(row_version)>  m=<MAX(id)>  u=<MAX(updated_at)>
 *
 * Each component is load-bearing, and each covers a mutation the others can
 * miss. All four come from columns that ALREADY exist (007_relational_core.sql
 * gives every one of these tables id BIGSERIAL, row_version INTEGER and
 * updated_at TIMESTAMPTZ, plus the rel_touch_updated_at BEFORE UPDATE trigger).
 * No migration is required, and none is introduced.
 *
 *   CREATE — every INSERT takes its id from that table's BIGSERIAL sequence,
 *     which is strictly monotonic and never reuses a value, so MAX(id) always
 *     increases. COUNT(*) also increases. Detection does not depend on either
 *     alone: even an insert-plus-delete in the same transaction, which leaves
 *     COUNT(*) unchanged, still moves MAX(id).
 *
 *   UPDATE — every relational UPDATE in services.ts bumps row_version, so
 *     SUM(row_version) increases. Three writers deliberately do NOT bump it
 *     (recomputeOwnerPaymentStatus's status write, and the two invoice-relink
 *     UPDATEs in convertQuoteToJob / jobInvoiceTx). Those are covered by
 *     MAX(updated_at): migration 007 installs a BEFORE UPDATE trigger
 *     (rel_touch_updated_at) on every table below, and it fires on EVERY
 *     update regardless of which columns changed or whether the new values
 *     differ from the old ones — so updated_at becomes the committing
 *     transaction's NOW(), which is at or after the previous maximum.
 *
 *   DELETE — COUNT(*) decreases. This is the case MAX(updated_at) alone
 *     genuinely cannot see: deleting any row other than the most recently
 *     touched one leaves the maximum timestamp exactly where it was.
 *     SUM(row_version) also decreases by the deleted row's version, but that
 *     is not relied on — a delete of a row_version=1 row concurrent with one
 *     update would cancel it out, and COUNT(*) still moves.
 *
 *   Combined: the token can only be unchanged when there were zero inserts
 *   (MAX(id) fixed), zero deletes (COUNT(*) fixed) and zero updates
 *   (SUM(row_version) and MAX(updated_at) both fixed). Any committed mutation
 *   moves at least one component.
 *
 *   MULTIPLE MUTATIONS IN ONE TRANSACTION share one NOW(), so MAX(updated_at)
 *   advances once rather than once per row — which is correct and sufficient:
 *   the client only needs to learn THAT the section changed, not how often.
 *
 * ── LINE ITEMS need no token of their own ─────────────────────────────────
 * rel_quote_line_items / rel_job_line_items / rel_invoice_line_items carry no
 * updated_at or row_version, but they never change without their parent
 * changing: replaceQuoteLinesTx always accompanies a rel_quotes UPDATE (a
 * lines patch forces the subtotal/vat/total recompute, so the SET list is
 * never empty), replaceJobLinesTx sets `linesChanged` which forces the
 * rel_jobs UPDATE precisely so a lines-only save still bumps row_version, and
 * replaceInvoiceLinesTx does the same for rel_invoices. The parent's token
 * therefore covers its lines.
 *
 * ── PAYMENTS need a token of their own ────────────────────────────────────
 * `payments` is not a standalone frontend section — read.ts has no
 * SECTION_JSON_KEY entry for it — but rel_payments IS the authority for any
 * cut-over job/quote/invoice, because buildJobsJson/buildQuotesJson/
 * buildInvoicesJson each embed it. A payment against a JOB or an INVOICE also
 * updates its owner (recomputeOwnerPaymentStatus writes invoice_status/status),
 * so the owner's token moves. A payment against a QUOTE does NOT:
 * recomputeOwnerPaymentStatus returns immediately for owner_type 'quote', so
 * rel_quotes is never touched and the quotes token would not move even though
 * the quote's rendered `payments` array did. That is the specific, proven
 * reason this endpoint reports a payments token, and why the client maps a
 * payments change onto its owner sections.
 *
 * ── PURCHASE ORDERS are deliberately absent ───────────────────────────────
 * purchaseOrders is flagged cut over in production, but backfill.ts skips the
 * entire historical collection by policy (LEGACY_PURCHASE_ORDERS_SKIPPED_BY_
 * POLICY), so rel_purchase_orders holds zero rows while platform_state still
 * holds 640 historical PO records. Until that authority state is resolved by a
 * person, this endpoint reports no PO token and the client performs no PO
 * freshness refresh — exactly the behaviour that exists today.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS ENDPOINT IS NOT
 * ══════════════════════════════════════════════════════════════════════════
 * It returns metadata only — counts and opaque strings. No business row, no
 * customer name, no amount, no document number. It writes nothing. It holds no
 * transaction open. Tokens are SERVER AUTHORITY: the client may cache and
 * compare them, and must never construct, increment or predict one.
 */
import { Router, Response } from 'express';
import { query } from '../db/pool';
import { authenticate, AuthRequest } from '../middleware/auth';
import { cutOverSections, CutoverSection } from '../relational/cutover';

const router = Router();
router.use(authenticate);

/** Section -> the table whose contents that section is assembled from.
 *  purchaseOrders is deliberately absent — see the header. */
const SECTION_TABLE: Array<{ section: string; table: string }> = [
  { section: 'suppliers',   table: 'rel_suppliers' },
  { section: 'inventory',   table: 'rel_inventory_items' },
  { section: 'quotes',      table: 'rel_quotes' },
  { section: 'jobs',        table: 'rel_jobs' },
  { section: 'accInvoices', table: 'rel_invoices' },
  { section: 'creditNotes', table: 'rel_credit_notes' },
  { section: 'payments',    table: 'rel_payments' },
];

/** The sections whose authority depends on rel_payments as well as their own
 *  table (see the header's payments note). */
const PAYMENT_OWNER_SECTIONS = ['quotes', 'jobs', 'accInvoices'];

// One statement, aggregates only. Built once at module load from the constant
// table above — never from a request value.
const TOKEN_SQL = SECTION_TABLE.map(({ section, table }) => `
  SELECT '${section}' AS section,
         COUNT(*)::text                                       AS c,
         COALESCE(SUM(row_version), 0)::text                  AS v,
         COALESCE(MAX(id), 0)::text                           AS m,
         COALESCE(MAX(updated_at), 'epoch'::timestamptz)::text AS u
    FROM ${table}`).join(' UNION ALL ');

router.get('/', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    // ONE round trip for the whole cutover set (not one per section).
    const cutOver = await cutOverSections();
    const anyOwnerCutOver = PAYMENT_OWNER_SECTIONS.some((s) => cutOver.has(s as CutoverSection));

    const [tokenRes, stateRes] = await Promise.all([
      query(TOKEN_SQL),
      query('SELECT updated_at FROM platform_state WHERE id = 1'),
    ]);

    const sections: Record<string, string> = {};
    for (const row of tokenRes.rows) {
      const section = String(row.section);
      const include = section === 'payments'
        ? anyOwnerCutOver                       // see the header's payments note
        : cutOver.has(section as CutoverSection);
      if (!include) continue;                   // JSON-authoritative: platformState covers it
      sections[section] = `c:${row.c}|v:${row.v}|m:${row.m}|u:${row.u}`;
    }

    res.json({
      platformState: stateRes.rowCount ? stateRes.rows[0].updated_at : null,
      sections,
      // Echoed so the client never has to guess which sections it may refresh
      // relationally. Same source of truth as GET /api/platform-state's
      // relationalAuthoritativeSections.
      cutOver: Array.from(cutOver),
      serverTime: new Date().toISOString(),
    });
  } catch (err) {
    // A freshness failure must never look like "nothing changed" — that would
    // leave the client silently stale, which is the exact defect this endpoint
    // exists to remove. Fail loudly; the client treats an error as "unknown"
    // and simply checks again on the next tick.
    console.error('GET /api/freshness failed:', err);
    res.status(500).json({ error: 'Freshness check failed' });
  }
});

export default router;
