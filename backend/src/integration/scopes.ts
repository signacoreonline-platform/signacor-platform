/**
 * Integration scopes — the COMPLETE list of what any integration client can
 * ever be granted. A scope stored in integration_clients.scopes that is not
 * listed here grants nothing (it is ignored and reported by the CLI).
 *
 * Mapped from the live dashboard's Sales Assistant ("assistant") role, then
 * cut down to what the Sally quotation workflow actually needs:
 *
 *   customer:read   search/read customers (contact + billing fields only)
 *   product:read    search/read inventory items and quick rates
 *   inventory:read  stock on hand / reorder level for inventory items
 *   pricing:read    selling price (ex VAT) — NEVER cost price or margin
 *   quote:read      search/read quotes in the client's own company
 *   quote:create    create DRAFT quotes (status forced to 'draft')
 *   quote:update    edit lines/notes of DRAFT quotes THIS client created
 *
 * Deliberately absent (no code path exists for them in this API): cost
 * prices, margins, discounts, setup fees, price overrides, quote status
 * changes (sent / approved / declined), quote -> job conversion, invoices,
 * payments, credit notes, purchasing, customer creation/updates, deletes of
 * any kind, users, HR and backups.
 */
export const KNOWN_SCOPES = [
  'customer:read',
  'product:read',
  'inventory:read',
  'pricing:read',
  'quote:read',
  'quote:create',
  'quote:update',
] as const;
export type Scope = (typeof KNOWN_SCOPES)[number];

export function isKnownScope(s: string): s is Scope {
  return (KNOWN_SCOPES as readonly string[]).includes(s);
}

/** Effective scopes: what is stored AND known. Unknown scopes grant nothing. */
export function effectiveScopes(stored: unknown): Scope[] {
  if (!Array.isArray(stored)) return [];
  return [...new Set(stored.map(String).filter(isKnownScope))];
}
