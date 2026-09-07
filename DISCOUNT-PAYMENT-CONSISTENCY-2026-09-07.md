# Discount & Payment Consistency — implementation report
**2026-09-07 · live Signacore Platform (not V2)**

Goal: **one discount fact per linked transaction, one payment fact per real payment.**

---

## 1. Exact files changed

| File | Change |
|---|---|
| `database/migrations/014_payment_idempotency.sql` | **NEW.** Additive: `rel_payments.client_request_id` + a *partial* unique index. |
| `backend/src/relational/services.ts` | Transaction-chain resolver; chain-aware payment status; payment idempotency; job→quote/invoice discount cascade; lock ordering. |
| `backend/src/relational/read.ts` | An invoice's `payments` now resolves its whole chain. |
| `backend/src/relational/api.ts` | Passes the submission key through; reports the rows the discount cascade bumped. |
| `index.html` | Submission keys + synchronous guards on every payment action; true-owner routing in the Accounting modal; stale-snapshot protection in Edit Invoice; invoice discount derived from its own lines. |
| `backend/src/scripts/diagnose-discount-payment-consistency.ts` | **NEW.** Read-only review script. |
| `backend/test/relational.discount-payment-consistency.stress.ts` | **NEW.** Focused regression suite. |
| `backend/test/relational.{frontend-payment-wiring,quote-payments-modal-wiring,cutover-blocker-completion}.*` | Existing source-wiring assertions updated to the new call shapes. |
| `backend/package.json` | Two script entries. |

Nothing else was touched. `+1018 / −66` across the eight modified files.

---

## 2. Discount authority — before and after

**Before.** Three independent facts. `rel_quotes.discount_pct`, `rel_jobs.discount_pct`, and — on the invoice — a negative `Discount (x%)` line frozen at creation. `updateQuoteWithJobSync` already cascaded quote → job → invoice (2026‑08‑27). `updateJob` cascaded nothing.

**After.** One fact, held at the head of the chain:

- chain with a quote → `rel_quotes.discount_pct` is canonical
- chain with no quote → `rel_jobs.discount_pct` is canonical
- the invoice owns **no** discount field; its line is always regenerated from the canonical holder by the same shared writers that created it

`rel_jobs.discount_pct` remains — every read path, the Job Card and the job's `value` need it — but as a **synchronised projection**, not an independent fact. Percentage is authoritative; the money is always derived (`subtotal × pct/100`), so the two halves cannot contradict each other. Schema unchanged.

**How each document resolves it.** Quote: its own column. Job: its own column, kept equal to the quote's by both cascades. Invoice: its `Discount (x%)` line, rebuilt on every canonical change. Accounting: the same line, read through `sgrSplitInvoiceLineItems`.

**Change after conversion / after invoicing.** Either end now cascades across the whole chain in one transaction. There is **no locked-document rule anywhere in this codebase** — no invoice lock, no post-issue freeze; the Edit Invoice field is itself labelled *"Discount (any stage)"* — so no intentional accounting lock was bypassed.

---

## 3. Payment authority — before and after

**Before and after: `rel_payments` is the single store.** One row, one stable id, `_relOwnerType` on every hydrated row, edits and deletes already routed by real owner. That was never wrong and was not replaced.

What changed is **resolution**. An invoice's `payments` array is now its whole chain's — its own, plus its job's, plus its quote's, deduped by primary key. **Nothing is moved, copied, created or deleted.** Each payment keeps its owner, its id and its row version, so `deleteInvoice` still removes only invoice-owned rows and a job paid directly still owns its own payment.

---

## 4. Exact cause of the discount inconsistency

`services.ts → updateJob()` wrote `discount_pct` to `rel_jobs` and stopped. It touched neither the source quote nor the linked invoice's adjustment lines. A discount changed from Edit Invoice therefore left the quote on the old percentage and the issued invoice on its old `Discount (x%)` line and old total.

Secondary: the View Invoice modal and the Accounting list read `inv.discount` / `inv.discountAmount` — fields written by only one legacy path — so every invoice raised from a quote or job showed **no discount at all** on screen while its own printed PDF showed it correctly.

---

## 5. Exact cause of delayed / non-persistent payments

**No relational path ever carried or re-owned a quote's or job's payments onto a newly created invoice.** `createInvoiceForJob` and `createInvoiceFromQuoteTx` both leave them where they are — unlike the old JSON path, which copied them across as `carriedPayments`. But `resolvePaymentSource` / `resolveQuotePaymentSource` pick exactly **one** payments array, and an invoice, once it exists, wins.

So a deposit taken before invoicing became **unreachable the instant the invoice was raised** — perfectly intact in `rel_payments`, but absent from the payments modal, the invoice balance, the paid/part-paid status and the statement. That is the reported "the payment didn't save", and the reason it was captured again.

Second, smaller cause: `EditInvoiceForm`'s save wrote back `{...job}` — the snapshot captured when the modal *opened* — so a payment recorded while it was open vanished from local state until the next refresh.

Persisted data was never at risk: `updateJob`/`updateQuote` have no payments field, `platformState.ts` refuses to overwrite a cut-over section, and `read.ts` deliberately has no `legacy_data` fallback for payments.

---

## 6. Exact cause of duplicate-payment risk

`POST /api/relational/payments` had **no idempotency of any kind**. A retry after a timeout, a lost response, or a double-click that outran React's `saving` flag inserted a second row. The only guard was `if (saving) return` on React *state*; the repo's own synchronous `guardAction` pattern was never applied to payment buttons. `markCanonicalInvoicePaid` ("Mark Paid") had neither.

---

## 7. Discount propagation fix

`updateJob` now cascades, inside its own transaction:
1. writes the canonical discount (and setup fee) through to the chain's head quote and recomputes that quote's stored totals from **its own** lines — quote line items are never touched;
2. rebuilds every active linked invoice's commercial content from the **post-save job**, through `writeInvoiceLinesFromJobTx` → the deployed writers, so creation and synchronisation cannot compute a discount differently;
3. holds the result to `assertJobInvoiceMatchesValueTx` — an invoice that does not add up to its job is never left in place; the throw rolls the whole chain back.

The invoice is rebuilt from the **job**, not the quote, because job lines are production-owned after conversion (BLOCKER 2) — sourcing from the quote would silently replace what is actually being billed.

**The gate is deliberately narrow: `discountPct` or `setupFee` only.** Widening it to `lines`/`value` would break `JobDetail.saveLines()`, which sends `{lines}` without restating `value`.

Company isolation is checked on both sides before any write. Lock order (quote → job → invoice) matches `updateQuoteWithJobSync`, so a concurrent quote edit and job edit on one transaction cannot deadlock.

---

## 8. Payment persistence fix

`read.ts → buildInvoicesJson` resolves each invoice's payments across its chain, through proven FK columns only (`rel_invoices.job_id/.quote_id`, `rel_jobs.quote_id`), with `company_code` compared on both sides and deduping by `rel_payments.id`. An invoice with no chain extras hydrates byte-identically to before.

No double counting: `getAllInvoicesUnified` already suppresses a job's synthesised invoice row whenever a real record resolves to that job, and quotes are never a statement or ledger source.

`EditInvoiceForm` now keeps the **live** payments array on both its relational and JSON paths.

---

## 9. Immediate-sync fix

`relationalFetch` already schedules a coalesced authoritative re-read after every mutation (2026‑08‑24) — that mechanism was sound and is untouched. What was missing was that the re-read returned an invoice whose payments array excluded the chain; it now doesn't. `EditInvoiceForm` additionally adopts the row versions the cascade bumped, so the next save of that quote or invoice isn't a spurious 409.

Nothing shows as captured before persistence succeeds: every optimistic row is written only after the server responds, and every failure path keeps the existing error handling.

---

## 10. Payment identity & idempotency

Every optimistic payment row now carries the **server's** payment id (`result.paymentId`) rather than a local `Date.now()`, so one payment never appears under two ids.

`client_request_id` identifies one **submission attempt**. The browser mints it on submit, holds it across retries, and discards it the moment the user changes amount/date/method/notes — so a retry is deduped while a second genuine payment is allowed through. Enforcement is a partial unique index at the database write boundary; `recordPayment` pre-checks (before credit-note application, so a replay never re-consumes credit) and catches `23505`, returning the already-persisted payment's own id and row version. The route answers `200 … deduplicated:true` on a replay, `201` on a real create.

**Amount, date and method are never compared.** Two R5,000 payments on the same day by the same method remain two payments.

`guardAction` (a synchronous Set, not React state) now wraps add/edit/delete in all three payment modals and "Mark Paid", keyed per record or per payment.

---

## 11. Discount + payment interaction

Changing a discount after a payment exists leaves the payment **completely untouched** — same id, amount, date, method. Only the outstanding balance moves, because `recomputeOwnerPaymentStatus` re-derives every chain member's status from the same chain total against the new invoice total. No refund or credit note is invented. The existing "does not add up to its source" guard still refuses an inconsistent document.

`recomputeOwnerPaymentStatus` is now chain-aware, so the job and its invoice can no longer disagree about paid/part-paid. It still does **not** bump `row_version` — bumping it would hand every open editor a spurious 409.

---

## 12. Tests run and results

```
relational.discount-payment-consistency.stress   37 passed, 0 failed   (source-level)
relational.frontend-payment-wiring.test           8 passed, 0 failed
relational.quote-payments-modal-wiring.test       9 passed, 0 failed
relational.cutover-blocker-completion.stress      all source checks pass
tsc --noEmit (strict, src/)                       clean
tsc -p tsconfig.test.json                         clean
Babel/JSX parse of index.html                     OK, no syntax errors
```

The end-to-end database half of the new suite (chain visibility, retry dedup, the 3-way concurrent race, two-genuine-same-value-payments, company isolation, and the full discount cascade Quote→Job→Invoice at 10% → 15%) is written and compiles, but **was not executed here** — this session had no reachable Postgres and no network egress. Run it against a staging database:

```
DATABASE_URL=... TEST_SERVER_URL_WITH_AUTHORITY=http://localhost:PORT \
  npm run test:discount-payment-consistency
```

---

## 13. Suspected duplicate payment records

**None identified, and none could be** — this session had no database access. Nothing was deleted, merged or altered. A read-only script is provided:

```
npm run diagnose:discount-payment-consistency
```

It reports, without changing anything: payments that were unreachable (quote/job-owned on an invoiced transaction — the population most likely to have been re-captured), suspected duplicates (same chain, same amount, within 3 days — a **review list**, never a verdict), and discounts that disagree within one chain. **Run this before deploying**, so you have a "before" picture.

## 14. Potentially missing payment records

None identified. No payment was ever lost by this defect — the affected rows were hidden, not deleted, and are visible again. Nothing was reconstructed or invented.

---

## 15. Unrelated issues found and deliberately NOT fixed

1. **`JobDetail.saveLines()` sends `{lines}` without restating `value`.** A job's lines can drift from its already-issued invoice and from its own declared `value`. Real, but outside discounts/payments — and it is precisely why the cascade gate is narrow.
2. **`EditInvoiceForm`'s `invoiceStatus` / `paidAt` controls are not sent to the server** on the relational path. Changing them appears to work and is reverted by the next refresh.
3. **Two shapes of "job invoice" coexist**: the JSON path flips flags on the job (synthesised invoice, no `accInvoices` record) while the relational path creates a real `rel_invoices` row. Handled correctly everywhere, but worth consolidating one day.
4. **No `paid_at` / `paid_date` column** on `rel_jobs` / `rel_invoices` (already documented in the code): only the status is recomputed server-side.

---

## 16–20. Confirmations

- **16 · No unrelated functionality changed.** Only discount authority/propagation/display and payment authority/persistence/sync/identity/idempotency. No refactors, no cleanups, no UI or CSS changes beyond the two discount readouts. Document numbering, credit notes, refunds, statements, credit allocation, roles, reports, customers, suppliers, inventory, products and company switching are untouched.
- **17 · Company isolation unchanged and reinforced.** The chain resolver verifies `company_code` on every member rather than assuming it, dropping and logging any mismatch; the read projection checks it on both sides; the job→invoice sync refuses a cross-company write. No existing filtering was altered.
- **18 · VAT / accounting policy unchanged.** The same flat 15% on `(subtotal − discount + setupFee)`, the same calculation order, the same cent-precision comparison. Revenue recognition and report definitions untouched.
- **19 · No historical payment deleted or rewritten.** No mass migration, no normalisation of historical discounts, no automatic removal of anything. Migration 014 is additive only — no `DROP`, `TRUNCATE`, `DELETE` or `UPDATE` of any existing row.
- **20 · Persistence protections intact.** Save queue, backup-before-save, empty/partial-state overwrite protection, `assertNoUnwiredRelationalSections`, record-scoped optimistic concurrency, the dirty-editor pin registry, `describeSaveConflictError` handling and confirmed-save-before-success all unchanged. No protection was weakened; two were added (database-level payment idempotency, and the synchronous submit guard).

---

## Deployment

Render runs `npm run migrate && npm start`, so **migration 014 applies automatically** on the next backend deploy. It is additive and idempotent, needs no backup step, and is safe to re-run.

Suggested order: deploy → run `npm run diagnose:discount-payment-consistency` → review anything it lists → then work through the manual checks (capture a deposit on a quote, invoice it, confirm the deposit is still there; change a discount after invoicing and confirm all three documents agree).
