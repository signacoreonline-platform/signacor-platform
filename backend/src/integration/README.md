# Signacore Integration API — `/api/v1/integration`

Versioned server-to-server API for **integration clients**: machine identities that are
separate from dashboard users. The first client is **Sally**, Signacore's AI Sales Assistant.

* Off by default. Every route answers `503 INTEGRATION_DISABLED` until `INTEGRATION_API_ENABLED=true`.
* Separate from the dashboard's JWT login. An integration secret is accepted only here, and a JWT is never accepted here.
* No route deletes, sends, approves, declines or converts anything. None changes prices, discounts or setup fees, and none touches invoices, payments, purchasing, customers (writes), HR or users.

## Authentication

```
X-Integration-Client: sally
Authorization: Bearer <secret>
Idempotency-Key: <8–100 chars>       (required on POST/PATCH)
X-Acting-For: <person in Sally>      (attribution only)
X-Confirmed-By: <person>             (only where a confirmation is required)
X-Request-Id: <id>                   (optional, echoed back)
```

Secrets are 384-bit random values. The database stores only their SHA-256 hash. Credentials are
read only from the headers above, never from the query string. A request with a query parameter
named `key`, `apikey`, `api_key`, `token`, `secret` or `access_token` (any letter case) is refused
with `400 CREDENTIALS_IN_URL`. In production, a request that did not arrive over HTTPS is refused
(`400 HTTPS_REQUIRED`, based on `X-Forwarded-Proto`, which Render's proxy sets). The rate limit is
120 requests per minute per client by default (`INTEGRATION_RATE_LIMIT_PER_MIN`).

Provision, rotate and revoke clients from the server shell. Sally belongs to Signacore
company code `2`. The CLI itself takes any company code, for future clients.

```
node dist/integration/clientCli.js create --client-id sally --name "Sally AI Sales Assistant" --company-code 2
node dist/integration/clientCli.js rotate --client-id sally
node dist/integration/clientCli.js revoke --client-id sally
node dist/integration/clientCli.js list
```

## Scopes

The full list is in `scopes.ts`. A stored scope that the code doesn't know grants nothing.

| Scope | Allows |
|---|---|
| `customer:read` | Customer search and detail (no internal notes) |
| `product:read` | Inventory item and quick-rate search and detail |
| `inventory:read` | Stock on hand, reorder level, stock status |
| `pricing:read` | Selling price ex VAT (**never cost or margin**) |
| `quote:read` | Quotes in the client's own company |
| `quote:create` | **Draft** quotes only |
| `quote:update` | Lines, reference, PO ref, notes and valid-until on **draft quotes this client created** (no proforma, no job) |

## Data authority

The API uses the platform's existing double gate (`RELATIONAL_AUTHORITY_ENABLED=true` **and** the
`relational_cutover` row enabled):

* A section that is cut over is read from the `rel_*` tables.
* A section that isn't cut over is read from `platform_state` JSON.
* If a cutover row is enabled but the master switch is off, or a relational read fails, the API
  **refuses** (`503 SECTION_AUTHORITY_MISMATCH` / `SECTION_UNAVAILABLE`) rather than serve the frozen
  JSON copy.

Quote writes require `quotes` to be relational. They go through `relational/services.ts`
(`createQuote`, `updateQuoteWithJobSync`), used unchanged.

## Endpoints

| Method | Path | Scope | Notes |
|---|---|---|---|
| GET | `/status` | any | Client, scopes, per-section authority, capabilities |
| GET | `/customers?q=` | customer:read | 2–100 chars. Matches name, contact, email, phone digits, VAT no. and id; ranked; max 25 |
| GET | `/customers/:id` | customer:read | Adds billing address |
| GET | `/products?q=&category=&source=` | product:read | `ref` is `inv:<id>` or `qr:<id>`. Adds `pricing` with pricing:read and `stock` with inventory:read |
| GET | `/products/:ref` | product:read | |
| GET | `/inventory/:ref` | inventory:read | `in_stock` / `low` / `out_of_stock` / `not_tracked`. Reserved and available-to-promise are `null` (not modelled) |
| GET | `/pricing/:ref` | pricing:read | Sell price ex VAT, VAT 15%, `permittedDiscountPct: 0`, rules |
| GET | `/quotes?q=&status=&mine=true&externalRef=` | quote:read | Own company only |
| GET | `/quotes/:id` | quote:read | Lines, totals (`calculatedBy: "signacore"`), status, `rowVersion`, `editableByClient` |
| POST | `/quotes` | quote:create | See below |
| PATCH | `/quotes/:id` | quote:update | `{expectedVersion, lines?, reference?, poRef?, notes?, validUntil?}` |

### `POST /quotes`

```json
{
  "externalRef": "ENQ-00012",
  "customerId": "1712345678901",
  "lines": [{ "productRef": "inv:800001", "qty": 10, "pieces": 1, "description": "optional" }],
  "reference": "optional", "poRef": "optional", "notes": "optional", "validUntil": "YYYY-MM-DD",
  "allowAdditionalQuote": false
}
```

The server fills in everything else:

* **Customer and contact details** are copied from the Signacore customer record.
* **Unit prices** come from the product's `sell`. A product with no price is refused (`PRICE_NOT_SET`).
* **Status** is always `draft`. **Company** is the client's company.
* **Prepared by** is "Sally (AI Sales Assistant)".
* **Quote date** is today in South Africa.
* **Notes** end with `[Sally ref <externalRef> · request <Idempotency-Key>]`. This marker is used for crash recovery.

Any `unitPrice`, `price`, `total`, `vat`, `discountPct`, `setupFee`, `status`, `companyCode` and similar
field is refused (`403 FIELD_NOT_PERMITTED`).

**Duplicate guard.** If this client already has an open quote for the same `externalRef`, the request is refused with `409 DUPLICATE_QUOTE`. `allowAdditionalQuote: true` overrides this, but also needs `X-Confirmed-By`.

**Idempotency**
* Same key and same body: the stored response is replayed (`Idempotent-Replayed: true`).
* Same key with a different body: `422 IDEMPOTENCY_KEY_REUSED`.
* Still processing: `409 IDEMPOTENCY_IN_PROGRESS`. This is also the answer when another request
  released the key at the same moment. A request only goes ahead when its own insert reserved the
  key. Retry with the same key.
* Stuck for more than 2 minutes: the quote is found by its full notes marker
  (`[Sally ref <externalRef> · request <key>]`). It is then returned, and the ownership record is
  restored if it was missing. If no quote with that marker can be found, recovery cannot show that
  the original request created a quote. The stuck key is then released and the request is
  attempted again. Absence of the marker is evidence, not proof (see the warning below).
* An update (`PATCH`) that committed but whose response could not be read back still completes
  the key, with `{"quote": {"id": …}, "partial": true}`. The key is never released after a
  committed write, so a same-key retry replays that response instead of updating again. Fetch the
  quote with `GET /quotes/:id` to see its current state.
* If the quote was created but recording Sally's ownership failed, the key stays in progress
  (it is never released). A same-key retry gets `409` at first, and recovery restores ownership
  after 2 minutes.

A retry with the **same** `Idempotency-Key` does not create a second quote, as long as the
notes marker is still in the quote. If someone removes the marker in Signacore before a stuck
request is recovered, a retry can create the quote again. A request with a **different** key
for the same `externalRef` is stopped by the duplicate guard above. That guard only sees quotes
whose ownership was recorded.

## Errors

`{ "error": { "code": "…", "message": "…", "details": { … } } }`

| Code | Status |
|---|---|
| `UNAUTHENTICATED` | 401 |
| `FORBIDDEN_SCOPE`, `FIELD_NOT_PERMITTED`, `NOT_OWNED` | 403 |
| `NOT_FOUND` | 404 |
| `VALIDATION_ERROR` | 400 |
| `UNKNOWN_PRODUCT`, `UNKNOWN_CUSTOMER`, `PRICE_NOT_SET`, `PRODUCT_INACTIVE`, `BUSINESS_RULE`, `IDEMPOTENCY_KEY_REUSED` | 422 |
| `DUPLICATE_QUOTE`, `STALE_VERSION`, `QUOTE_NOT_EDITABLE`, `SECTION_NOT_RELATIONAL`, `IDEMPOTENCY_IN_PROGRESS` | 409 |
| `IDEMPOTENCY_KEY_REQUIRED`, `CONFIRMATION_REQUIRED` | 428 |
| `RATE_LIMITED` | 429 |
| `INTEGRATION_DISABLED`, `SECTION_UNAVAILABLE`, `SECTION_AUTHORITY_MISMATCH`, `UNAVAILABLE` | 503 |

## Audit

While the API is enabled, every request that reaches the integration router writes one row to
`integration_audit`, whether it is authenticated or not. A body that fails JSON parsing is
rejected by the app's global body parser before it reaches the router, so it is not audited. That includes rejected, denied and
unknown-endpoint requests. The row is written when the response finishes. Audit writes are
best effort: a failure is logged, not returned to the caller. Requests answered
`503 INTEGRATION_DISABLED` while the API is switched off are **not** audited. Each row records the client, request id, operation, target, outcome
(`success` / `denied` / `rejected` / `error` / `replayed`), HTTP status, error code, acting-for, confirmed-by and
idempotency key. It never records bodies or secrets. The quotes themselves show
"Prepared by: Sally (AI Sales Assistant)".

## Tests

`npm run test:integration-api` needs `DATABASE_URL` set to a migrated `*_test` database. It refuses
any other database. The suite has the original 95 checks, plus regression checks for the
idempotency acquisition race, `editableByClient` on quotes with a proforma, ownership recovery
after a failed ownership record, and mixed-case credential query keys.
