/**
 * Integration scopes — the COMPLETE list of what any integration client can
 * ever be granted. A scope stored in integration_clients.scopes that is not
 * listed here grants nothing (it is ignored and reported by the CLI).
 *
 * Mapped from the live dashboard's Sales Assistant ("assistant") role, then
 * cut down to what the Sally quotation workflow actually needs:
 *
 *   customer:read    search/read customers (contact + billing fields only)
 *   customer:create  create a NEW customer: allow-listed fields only, with a
 *                    deterministic duplicate check and idempotency (never notes,
 *                    never an id, never a delete or merge)
 *   customer:update  change the allow-listed contact/billing fields of an
 *                    existing customer, with optimistic concurrency (never
 *                    notes, never the id, never a delete)
 *   product:read     search/read inventory items and quick rates
 *   inventory:read   stock on hand / reorder level for inventory items
 *   pricing:read     selling price (ex VAT) — NEVER cost price or margin
 *   quote:read       search/read quotes in the client's own company
 *   quote:create     create DRAFT quotes (status forced to 'draft')
 *   quote:update     edit lines/notes of DRAFT quotes THIS client created
 *
 * Deliberately absent (no code path exists for them in this API): cost
 * prices, margins, discounts, setup fees, price overrides, quote status
 * changes (sent / approved / declined), quote -> job conversion, invoices,
 * payments, credit notes, purchasing, customer deletes or merges, deletes of
 * any kind, users, HR and backups.
 *
 * customer:create / customer:update are NEVER granted implicitly: they are not
 * in DEFAULT_SCOPES (what `clientCli create` grants when --scopes is omitted),
 * and an existing client only gets them when a person runs
 * `clientCli set-scopes` (or `add-scopes`) naming them explicitly.
 */
export const KNOWN_SCOPES = [
  'customer:read',
  'customer:create',
  'customer:update',
  'product:read',
  'inventory:read',
  'pricing:read',
  'quote:read',
  'quote:create',
  'quote:update',
] as const;
export type Scope = (typeof KNOWN_SCOPES)[number];

/** Scopes a new client receives when none are named. Customer writes are opt-in only. */
export const DEFAULT_SCOPES: readonly Scope[] = [
  'customer:read',
  'product:read',
  'inventory:read',
  'pricing:read',
  'quote:read',
  'quote:create',
  'quote:update',
];

/** Scopes that change Signacore master data (listed separately by the CLI). */
export const MASTER_DATA_WRITE_SCOPES: readonly Scope[] = ['customer:create', 'customer:update'];

export function isKnownScope(s: string): s is Scope {
  return (KNOWN_SCOPES as readonly string[]).includes(s);
}

/** Effective scopes: what is stored AND known. Unknown scopes grant nothing. */
export function effectiveScopes(stored: unknown): Scope[] {
  if (!Array.isArray(stored)) return [];
  return [...new Set(stored.map(String).filter(isKnownScope))];
}
