# Pre-deploy verification — discount & payment consistency fix
**2026-09-07 · verified against PostgreSQL 16.13 + the real backend server, in an isolated sandbox**

Live production was **never** connected to, read from, or written to during this verification.

---

## Environment

| | |
|---|---|
| Database | PostgreSQL **16.13**, local to the verification sandbox (Render runs 16.x) |
| Backend | the real `src/index.ts`, started twice — port 3999 with `RELATIONAL_AUTHORITY_ENABLED=true`, port 3001 without |
| Schema | built by the real runner, `npm run migrate`, migrations 001→014 |
| Sources | byte-identical to the repo (md5-verified both directions before the final run) |
| Live production | **not touched** — no network route to it exists from this session |

---

## A. Diagnostic findings

`npm run diagnose:discount-payment-consistency` was run twice.

**1 · Against a database deliberately seeded with the pre-fix anomaly shapes** — to prove the diagnostic actually detects them rather than merely running:

```
1. PAYMENTS THAT WERE UNREACHABLE FROM EVERY SCREEN — 2 found
   payment #1  R 4 000,00  2026-08-01  EFT   owner=quote 1  now shown on invoice INV-00001 (company 2)
   payment #2  R 1 500,00  2026-08-05  Cash  owner=job 1    now shown on invoice INV-00001 (company 2)

2. SUSPECTED DUPLICATE PAYMENTS (same transaction, same amount, within 3 days)
   R 5 000,00 x2  on quote SQ-00001 → job SNS-00001 → invoice INV-00001  (company 2)
   R 250,00   x2  …
   R 10,00    x3  …

3. DISCOUNTS THAT DISAGREE WITHIN ONE TRANSACTION
   quote SQ-00001 = 10%   but   job SNS-00001 = 15%   (invoice INV-00001)  [company 2]
```

All three detectors fire correctly, and the chain label (`quote → job → invoice`) and company tag are right.

**2 · Against the post-fix verification database** — 0 hidden, 0 duplicate groups, 0 discount divergences.

**Read-only, proven two ways.** A full checksum of `rel_payments`, `rel_quotes`, `rel_jobs`, `rel_invoices` and `rel_invoice_line_items` was identical before and after the run (`396c9e6663baf6cb60e51b6cd8a6c429`), and a static scan found no `INSERT`/`UPDATE`/`DELETE`/`DROP`/`TRUNCATE`/`BEGIN`/`COMMIT` anywhere in the script — the single textual match is the comment that says so.

**Cross-company problems:** none. The chain resolver drops and logs any member whose `company_code` differs from the anchor's, and an end-to-end check confirmed a payment in company 1 appears on no invoice in company 2.

---

## B & C. Findings against LIVE data

**Not obtainable from this session.** This environment has no network route to the production database or API, so the diagnostic could not be pointed at live data. The numbers in section A come from seeded fixtures, not from your books.

**Run this against live before deploying**, so you have a "before" picture:

```
npm run diagnose:discount-payment-consistency
```

It is strictly read-only and safe to run while people are working.

---

## D. Database-backed test results

Final run: **two fresh databases, two freshly started servers, final sources only, zero port conflicts.**

| Suite | Result |
|---|---|
| `relational.discount-payment-consistency.stress` (new) | **81 passed, 0 failed** |
| `relational.payment-status-cent-precision.stress` | **24 passed, 0 failed** |
| `relational.payment-delete-concurrency.stress` | **26 passed, 0 failed** |
| `relational.quote-invoice-sync.stress` | **111 passed, 0 failed** |
| `relational.job-invoice-financial-consistency.stress` | **98 passed, 0 failed** |
| `relational.frontend-payment-wiring.test` | **25 passed, 0 failed** |
| `relational.quote-payments-modal-wiring.test` | **23 passed, 0 failed** |
| `relational.cutover-blocker-completion.stress` | **51 passed, 0 failed** |
| `relational.invoice-delete-representation.stress` | **167 passed, 0 failed** |
| **Total** | **606 passed, 0 failed** |

Every item on the verification list is covered:

**Discounts** — quote discount canonical when a quote exists ✓ · job-only chain uses the job's ✓ · Edit-Invoice change propagates Quote→Job→Invoice (10% → 15%, verified on all three) ✓ · invoice discount line regenerated ✓ · both % and amount derived for the View Invoice modal and the Accounting list ✓ · totals agree (R9,775 across all three) ✓ · VAT unchanged (`(10000−1000)×1.15 = 10,350`) ✓

**Payments** — deposit on a Quote still visible after Job and Invoice exist ✓ · payment on a Job visible after invoicing ✓ · payment on an Invoice resolves across the chain ✓ · dedupe by primary key ✓ · `owner_type`/`owner_id` unchanged ✓ · stable id from every view ✓ · **`deleteInvoice` removes only the invoice-owned payment; quote- and job-owned payments survive** ✓ · `company_code` blocks cross-company leakage ✓ · persists across a fresh authoritative read ✓ · EditInvoiceForm keeps the live payments array ✓ · same idempotency key inserts one row ✓ (and three concurrent copies still produce one) · two genuinely separate equal-value payments both recorded ✓

**Combined** — discount changed after a payment exists leaves the payment byte-identical and moves only the outstanding balance ✓

---

## E. Migration 014 safety

Proven on a database built to the **pre-014** state (migrations 001–013) and seeded with the historical payment shapes most likely to break a naive constraint: a backfilled `source_id`, a **NULL** `source_id`, two payments sharing one `source_id`, and two genuinely separate R5,000 payments on the same day by the same method.

| Check | Result |
|---|---|
| Applies through the real runner | ✓ `[migrate] ✓ 014_payment_idempotency.sql` |
| Additive only | ✓ one `ADD COLUMN IF NOT EXISTS`, one `CREATE UNIQUE INDEX IF NOT EXISTS`, one `COMMENT` |
| No destructive statement | ✓ the only textual match is the comment saying there are none |
| Existing rows untouched | ✓ 6 rows before, 6 after; checksum **identical** (`c417f3399c91373af4eaf2fda86b6a14`), unchanged after **three** applications |
| Column backward-compatible | ✓ `text`, `is_nullable = YES`, no default; all pre-existing rows NULL |
| Index is partial | ✓ `… (client_request_id) WHERE (client_request_id IS NOT NULL)` |
| No existing payment can violate it | ✓ `ADD COLUMN` leaves every existing row NULL and the index excludes NULLs, so the build cannot fail — confirmed on data containing duplicate `source_id`s and identical same-day amounts |
| Safe to re-run | ✓ framework: "All migrations already applied. Nothing to do." Raw SQL re-applied twice more: skip notices only, data unchanged |
| Actually enforces | ✓ two NULL-key rows coexist; a second row with the same key is refused with `duplicate key value violates unique constraint "uq_rel_payments_client_request_id"` |

**No compatibility defect found. Migration 014 is unchanged.**

---

## F. Build / regression

| | |
|---|---|
| `tsc --noEmit -p tsconfig.json` (strict, src) | **clean** |
| `tsc --noEmit -p tsconfig.test.json` | **clean** |
| Babel/JSX parse of `index.html` (1,788,009 chars) | **OK, no syntax errors** |
| Database-backed suites | **606 passed, 0 failed** |

---

## Defects the verification exposed, and fixed

Four, all payment-related. Each was found by running the tests, not by reading the code.

**1 · One payment could answer to two identities.** `POST /payments` returned `paymentId` as a **string** on the create path (pg renders BIGINT as a string) but a **number** on the new replay/race paths. Every identity comparison in `index.html` is a strict `===`, so a replay would not have matched the row it was meant to deduplicate. *Fixed:* all three paths now return the id verbatim.

**2 · The optimistic row's id did not match the hydrated one.** `read.ts` maps a payment's `id` through `restoreId()` (numeric string → number) while keeping `_relPaymentId` raw. Storing the server's id verbatim would have made the same payment carry `id: "2"` optimistically and `id: 2` after the next refresh — briefly two payments in a merged view. *Fixed:* a `relPaymentDisplayId()` helper mirroring `restoreId` exactly, plus string-safe replay dedupe.

**3 · A new chain member was born not knowing what had been paid.** A deposit taken on the quote before conversion left the new job at `invoice_status = 'pending'` and the new invoice at `'sent'` — reported as wholly unpaid on the Jobs and Accounting lists, while the invoice's own detail correctly showed the deposit. *Fixed:* the six creation paths settle the chain's payment status before committing.

**4 · (regression, caught by the existing suite)** Fix 3's first form stamped `invoice_status = 'pending'` on *every* converted job. `rel_jobs.invoice_status` being NULL is load-bearing — `deleteInvoice` uses it to decide whether a job has invoice-side linkage to reverse — so deleting an unrelated quote-originated invoice began bumping the row_version of jobs that had never been invoiced. Caught by `invoice-delete-representation` F3. *Fixed:* the settlement is now guarded on the chain actually having received money, matching `deleteInvoice`'s own established rule.

Also fixed: the diagnostic printed raw JS `Date` objects (`Sat Aug 01 2026 00:00:00 GMT+0000 …`) in a list meant to be read against a bank statement — now `YYYY-MM-DD`. Output formatting only; no query changed.

Three existing source-wiring assertions were updated to follow the renamed guarded implementations, and the new suite now clears `platform_state` in its reset exactly as its sibling suites do.

---

## G. Files that will deploy

```
M  index.html
M  backend/src/relational/services.ts
M  backend/src/relational/read.ts
M  backend/src/relational/api.ts
M  backend/package.json                                  (two script entries)
A  database/migrations/014_payment_idempotency.sql
A  backend/src/scripts/diagnose-discount-payment-consistency.ts
A  backend/test/relational.discount-payment-consistency.stress.ts
M  backend/test/relational.cutover-blocker-completion.stress.ts
M  backend/test/relational.frontend-payment-wiring.test.ts
M  backend/test/relational.quote-payments-modal-wiring.test.ts
A  DISCOUNT-PAYMENT-CONSISTENCY-2026-09-07.md            (docs)
A  PRE-DEPLOY-VERIFICATION-2026-09-07.md                 (this file)
```

`+1167 / −70` across the eight modified files. Only `index.html` and the three `backend/src/relational/*.ts` files change runtime behaviour.

---

## H–J. Confirmations

**H · No unrelated files changed.** The repo carries ~50 other modified files (`frontend/`, `backend/src/routes/*`, `pool.ts`, `schema.sql`, …) that were **already dirty before this work began** — line-ending churn and the unused legacy `frontend/` folder. A grep of every one of them for this fix's markers returns **0 hits**.

**I · No historical live data modified.** Live production was never connected to. In the sandbox, the diagnostic left a byte-identical checksum, and migration 014 left its 6 seeded historical payments byte-identical across three applications. No payment was deleted, merged, re-owned or rewritten anywhere: the payment fix is **resolution, not relocation** — every row keeps its own owner, id and row_version.

**J · READY TO DEPLOY.**

---

## Deploy sequence

1. **Before deploying** — run `npm run diagnose:discount-payment-consistency` against live for a "before" picture. Read-only.
2. Deploy. Render's `npm run migrate && npm start` applies migration 014 automatically.
3. **After deploying** — run the diagnostic again and review sections 1 and 2 against the bank statement. Nothing is auto-corrected; any real duplicate should be removed through the app so credit notes and statuses stay correct.

## Known, documented, deliberately NOT fixed

`JobDetail.saveLines()` sends `{lines}` without restating `value`, so a job's lines can drift from an already-issued invoice — which is exactly why the discount cascade gate is narrow. Plus the three other items in the implementation report. None are discount or payment defects.
