/**
 * relational.payment-delete-concurrency.stress.ts — MIGRATION CLOSURE Item 1
 * verification.
 *
 * Before this fix, deletePayment(id) took NO expectedVersion at all — the
 * one relational delete route in the codebase with no row-scoped
 * optimistic concurrency (every sibling — updatePayment, updateQuote,
 * updateJob, deleteCreditNote, updatePurchaseOrder, deleteSupplier — checks
 * row_version). This proves the fix over REAL HTTP, against the real
 * DELETE /payments/:id route and services.ts's deletePayment, covering:
 *
 *   A. a plain (non-Credit) delete with the CORRECT current expectedVersion succeeds
 *   B. a delete with a STALE expectedVersion (the payment was edited by someone
 *      else in between) is rejected 409 stale_record — the payment is NOT deleted
 *   C. deleting a nonexistent payment id is a 409 business_rule "not found",
 *      never a silent no-op success
 *   D. a delete request with expectedVersion missing/non-numeric is refused 400
 *      BEFORE any row is touched (matches PUT's existing validation shape)
 *   E. deleting a Credit-funded payment with the CORRECT version releases its
 *      credit usage atomically in the SAME transaction as the delete
 *   F. deleting a Credit-funded payment with a STALE version is rejected AND
 *      the credit note's used_amount is completely UNCHANGED — never a partial
 *      release on a rejected stale delete
 *   G. a double-delete attempt (same expectedVersion reused after the first
 *      delete already succeeded) is refused "not found", not a silent no-op
 *   H. deleting a payment whose owner section is not cut over is refused
 *      409 not_cut_over BEFORE the version is even checked (double-gate order)
 *   I. a Credit-funded delete blocked by the creditNotes cutover_dependency
 *      gate consumes NEITHER the row_version NOR the credit note — retrying
 *      with the SAME expectedVersion succeeds once creditNotes is cut over
 *   J. the exact "two staff, one stale" production-shaped scenario: payment
 *      is edited (row_version bumps), a second client holding the PRE-edit
 *      version attempts to delete it — rejected; deleting with the version
 *      the edit actually returned succeeds
 *
 * Requires TEST_SERVER_URL_WITH_AUTHORITY — skips with a clear notice if unset,
 * same convention as every other Stage 2/3 REST suite.
 */
import pool from '../src/db/pool';

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

async function login(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.TEST_LOGIN_EMAIL || 'test@signacore.local', password: process.env.TEST_LOGIN_PASSWORD || 'testpass' }),
  });
  if (!res.ok) throw new Error(`login failed against ${baseUrl}: HTTP ${res.status}`);
  return (await res.json()).token;
}

async function resetRelationalTables() {
  await pool.query(`
    TRUNCATE rel_payments, rel_credit_notes, rel_job_line_items, rel_jobs,
      rel_quote_line_items, rel_quotes, rel_customers
    RESTART IDENTITY CASCADE
  `);
  await pool.query(`DELETE FROM quote_conversions`);
  await pool.query(`DELETE FROM document_number_counters`);
  await pool.query(`UPDATE relational_cutover SET enabled = false, enabled_at = NULL, enabled_by = NULL`);
}

async function main() {
  const base = process.env.TEST_SERVER_URL_WITH_AUTHORITY;
  if (!base) {
    console.log('[payment-delete-concurrency] SKIPPED — TEST_SERVER_URL_WITH_AUTHORITY not set. See test runner instructions.');
    await pool.end();
    process.exit(0);
  }

  await resetRelationalTables();
  const token = await login(base);
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section = 'jobs'`);
  const services = await import('../src/relational/services');
  // A dedicated job per Credit-bearing scenario (E/F/I below), each with its
  // OWN unique customer/contact name — recordPayment's Credit consumption
  // matches ALL credit notes sharing a contact name, oldest-first; sharing
  // one contact across scenarios would let a later scenario silently
  // consume an earlier scenario's (already-released) credit note instead of
  // its own, making the "credit note is untouched/exactly-released" checks
  // meaningless. Isolating by job/contact keeps each scenario's credit pool
  // provably its own.
  async function makeJob(companyName: string): Promise<number> {
    const cust = await services.createCustomer({ companyName });
    const quote = await services.createQuote({
      companyCode: '2', customerId: cust.id, customerNameRaw: companyName,
      lines: [{ description: 'Banner', qty: 1, unitPrice: 5000 }],
    });
    const conv = await services.convertQuoteToJob(quote.id);
    return conv.jobId;
  }
  const jobId = await makeJob('Payment Delete Concurrency Co');

  // ── A: plain delete with the correct current expectedVersion succeeds ──
  console.log('\n[Payment delete concurrency] A — a plain EFT delete with the correct expectedVersion succeeds');
  const payA = await (await fetch(`${base}/api/relational/payments`, {
    method: 'POST', headers: H, body: JSON.stringify({ ownerType: 'job', ownerId: jobId, amount: 100, method: 'EFT' }),
  })).json();
  const delA = await fetch(`${base}/api/relational/payments/${payA.paymentId}`, {
    method: 'DELETE', headers: H, body: JSON.stringify({ expectedVersion: payA.rowVersion, ownerSection: 'jobs' }),
  });
  ok(delA.status === 200, 'A: delete with correct expectedVersion returns 200', delA.status);
  const rowAfterA = await pool.query(`SELECT count(*)::int AS n FROM rel_payments WHERE id = $1`, [payA.paymentId]);
  ok(rowAfterA.rows[0].n === 0, 'A: the payment row is actually gone');

  // ── B: stale expectedVersion is rejected, row untouched ──
  console.log('\n[Payment delete concurrency] B — a delete with a STALE expectedVersion (edited elsewhere) is rejected 409 stale_record');
  const payB = await (await fetch(`${base}/api/relational/payments`, {
    method: 'POST', headers: H, body: JSON.stringify({ ownerType: 'job', ownerId: jobId, amount: 150, method: 'EFT', notes: 'v1' }),
  })).json();
  await fetch(`${base}/api/relational/payments/${payB.paymentId}`, {
    method: 'PUT', headers: H, body: JSON.stringify({ expectedVersion: payB.rowVersion, ownerSection: 'jobs', notes: 'v2 — edited by someone else' }),
  });
  const delBStale = await fetch(`${base}/api/relational/payments/${payB.paymentId}`, {
    method: 'DELETE', headers: H, body: JSON.stringify({ expectedVersion: payB.rowVersion, ownerSection: 'jobs' }),
  });
  const delBStaleBody: any = await delBStale.json();
  ok(delBStale.status === 409 && delBStaleBody.type === 'stale_record', 'B: stale-version delete returns 409 stale_record', delBStaleBody);
  // payB.paymentId comes back from JSON as a string (BIGSERIAL over HTTP);
  // the 409 body's `id` is the real JS number services.ts/api.ts worked
  // with — compare numerically, not by strict type-sensitive equality.
  ok(delBStaleBody.table === 'rel_payments' && Number(delBStaleBody.id) === Number(payB.paymentId), 'B: the 409 identifies the exact conflicting table/id', delBStaleBody);
  const rowAfterB = await pool.query(`SELECT notes FROM rel_payments WHERE id = $1`, [payB.paymentId]);
  ok(rowAfterB.rows[0].notes === 'v2 — edited by someone else', 'B: the payment is untouched by the rejected delete attempt (still holds the edited notes)');

  // ── C: deleting a nonexistent payment id ──
  console.log('\n[Payment delete concurrency] C — deleting a nonexistent payment id is 409 business_rule, never a silent success');
  const delC = await fetch(`${base}/api/relational/payments/999999999`, {
    method: 'DELETE', headers: H, body: JSON.stringify({ expectedVersion: 1, ownerSection: 'jobs' }),
  });
  const delCBody: any = await delC.json();
  ok(delC.status === 409 && delCBody.type === 'business_rule', 'C: nonexistent payment id returns 409 business_rule (not a 200 no-op)', delCBody);

  // ── D: missing/non-numeric expectedVersion is refused 400 before any write ──
  console.log('\n[Payment delete concurrency] D — a delete request with no expectedVersion is refused 400 before touching any row');
  const payD = await (await fetch(`${base}/api/relational/payments`, {
    method: 'POST', headers: H, body: JSON.stringify({ ownerType: 'job', ownerId: jobId, amount: 50, method: 'EFT' }),
  })).json();
  const delDMissing = await fetch(`${base}/api/relational/payments/${payD.paymentId}`, {
    method: 'DELETE', headers: H, body: JSON.stringify({ ownerSection: 'jobs' }),
  });
  ok(delDMissing.status === 400, 'D: missing expectedVersion returns 400', delDMissing.status);
  const delDBad = await fetch(`${base}/api/relational/payments/${payD.paymentId}`, {
    method: 'DELETE', headers: H, body: JSON.stringify({ expectedVersion: 'not-a-number', ownerSection: 'jobs' }),
  });
  ok(delDBad.status === 400, 'D: non-numeric expectedVersion also returns 400', delDBad.status);
  const rowAfterD = await pool.query(`SELECT count(*)::int AS n FROM rel_payments WHERE id = $1`, [payD.paymentId]);
  ok(rowAfterD.rows[0].n === 1, 'D: the payment still exists — the malformed requests never reached deletePayment');

  // ── E: Credit-funded delete with correct version releases credit atomically ──
  console.log('\n[Payment delete concurrency] E — deleting a Credit-funded payment (correct version) releases credit in the SAME transaction');
  await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section = 'creditNotes'`);
  const jobE = await makeJob('Payment Delete Concurrency Co E');
  const cnE = await services.createCreditNote({ companyCode: '2', type: 'customer', contactName: 'Payment Delete Concurrency Co E', amount: 500 });
  const payE = await (await fetch(`${base}/api/relational/payments`, {
    method: 'POST', headers: H, body: JSON.stringify({ ownerType: 'job', ownerId: jobE, amount: 300, method: 'Credit' }),
  })).json();
  ok(payE.creditApplied === 300, 'E: the Credit payment applied 300 against the note');
  const delE = await fetch(`${base}/api/relational/payments/${payE.paymentId}`, {
    method: 'DELETE', headers: H, body: JSON.stringify({ expectedVersion: payE.rowVersion, ownerSection: 'jobs' }),
  });
  const delEBody: any = await delE.json();
  ok(delE.status === 200 && delEBody.creditReleased === 300, 'E: delete succeeds and reports the full 300 released', delEBody);
  const cnEAfter = await pool.query(`SELECT used_amount FROM rel_credit_notes WHERE id = $1`, [cnE.id]);
  ok(Number(cnEAfter.rows[0].used_amount) === 0, 'E: the credit note used_amount is correctly released back to 0');

  // ── F: Credit-funded delete with a STALE version — rejected, credit UNCHANGED ──
  console.log('\n[Payment delete concurrency] F — a STALE-version delete of a Credit-funded payment is rejected AND the credit note is completely untouched');
  const jobF = await makeJob('Payment Delete Concurrency Co F');
  const cnF = await services.createCreditNote({ companyCode: '2', type: 'customer', contactName: 'Payment Delete Concurrency Co F', amount: 500 });
  const payF = await (await fetch(`${base}/api/relational/payments`, {
    method: 'POST', headers: H, body: JSON.stringify({ ownerType: 'job', ownerId: jobF, amount: 200, method: 'Credit' }),
  })).json();
  // Bump the payment's row_version via a no-op-shaped edit isn't possible
  // (Credit payments refuse edits) — simulate "elsewhere" concurrency the
  // same way B did: use a deliberately wrong (already-consumed-looking)
  // version instead of the real current one.
  const staleVersion = payF.rowVersion + 7;
  const delFStale = await fetch(`${base}/api/relational/payments/${payF.paymentId}`, {
    method: 'DELETE', headers: H, body: JSON.stringify({ expectedVersion: staleVersion, ownerSection: 'jobs' }),
  });
  const delFBody: any = await delFStale.json();
  ok(delFStale.status === 409 && delFBody.type === 'stale_record', 'F: stale-version delete of a Credit payment returns 409 stale_record', delFBody);
  const cnFAfter = await pool.query(`SELECT used_amount FROM rel_credit_notes WHERE id = $1`, [cnF.id]);
  ok(Number(cnFAfter.rows[0].used_amount) === 200, 'F: the credit note used_amount is COMPLETELY UNCHANGED by the rejected delete (never a partial release)', cnFAfter.rows[0]);
  const payFStillThere = await pool.query(`SELECT count(*)::int AS n FROM rel_payments WHERE id = $1`, [payF.paymentId]);
  ok(payFStillThere.rows[0].n === 1, 'F: the payment itself was not deleted by the rejected attempt');

  // ── G: double-delete — second attempt with the same (now-stale/gone) version fails ──
  console.log('\n[Payment delete concurrency] G — a double-delete attempt (payment already gone) is refused, never a silent second success');
  const delGFirst = await fetch(`${base}/api/relational/payments/${payF.paymentId}`, {
    method: 'DELETE', headers: H, body: JSON.stringify({ expectedVersion: payF.rowVersion, ownerSection: 'jobs' }),
  });
  ok(delGFirst.status === 200, 'G: the first (correctly-versioned) delete succeeds', await delGFirst.text().catch(() => ''));
  const delGSecond = await fetch(`${base}/api/relational/payments/${payF.paymentId}`, {
    method: 'DELETE', headers: H, body: JSON.stringify({ expectedVersion: payF.rowVersion, ownerSection: 'jobs' }),
  });
  const delGSecondBody: any = await delGSecond.json();
  ok(delGSecond.status === 409 && delGSecondBody.type === 'business_rule', 'G: the second delete of an already-deleted payment is 409 business_rule (not found), never a silent 200', delGSecondBody);

  // ── H: owner section not cut over — refused BEFORE the version check ──
  console.log('\n[Payment delete concurrency] H — deleting a payment whose owner section is not cut over is refused before the version is even checked');
  await pool.query(`UPDATE relational_cutover SET enabled = false WHERE section = 'jobs'`);
  const anyPaymentRow = await pool.query(`SELECT id FROM rel_payments LIMIT 1`);
  const delH = await fetch(`${base}/api/relational/payments/${anyPaymentRow.rows[0]?.id || 1}`, {
    method: 'DELETE', headers: H, body: JSON.stringify({ expectedVersion: 999, ownerSection: 'jobs' }),
  });
  const delHBody: any = await delH.json();
  ok(delH.status === 409 && delHBody.type === 'not_cut_over', 'H: not-cut-over owner section is refused 409 not_cut_over even with a nonsense expectedVersion', delHBody);
  await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section = 'jobs'`);

  // ── I: cutover_dependency block never consumes the version or the credit note ──
  console.log('\n[Payment delete concurrency] I — a Credit-delete blocked by cutover_dependency consumes NEITHER the row_version NOR the credit note; retrying the SAME version succeeds once creditNotes is re-enabled');
  const jobI = await makeJob('Payment Delete Concurrency Co I');
  const cnI = await services.createCreditNote({ companyCode: '2', type: 'customer', contactName: 'Payment Delete Concurrency Co I', amount: 500 });
  const payI = await (await fetch(`${base}/api/relational/payments`, {
    method: 'POST', headers: H, body: JSON.stringify({ ownerType: 'job', ownerId: jobI, amount: 250, method: 'Credit' }),
  })).json();
  await pool.query(`UPDATE relational_cutover SET enabled = false WHERE section = 'creditNotes'`);
  const delIBlocked = await fetch(`${base}/api/relational/payments/${payI.paymentId}`, {
    method: 'DELETE', headers: H, body: JSON.stringify({ expectedVersion: payI.rowVersion, ownerSection: 'jobs' }),
  });
  const delIBlockedBody: any = await delIBlocked.json();
  ok(delIBlocked.status === 409 && delIBlockedBody.type === 'cutover_dependency', 'I: blocked with 409 cutover_dependency while creditNotes is not cut over', delIBlockedBody);
  const cnIAfterBlock = await pool.query(`SELECT used_amount FROM rel_credit_notes WHERE id = $1`, [cnI.id]);
  ok(Number(cnIAfterBlock.rows[0].used_amount) === 250, 'I: the credit note is untouched by the blocked attempt');
  await pool.query(`UPDATE relational_cutover SET enabled = true WHERE section = 'creditNotes'`);
  const delIRetry = await fetch(`${base}/api/relational/payments/${payI.paymentId}`, {
    method: 'DELETE', headers: H, body: JSON.stringify({ expectedVersion: payI.rowVersion, ownerSection: 'jobs' }),
  });
  ok(delIRetry.status === 200, 'I: retrying with the SAME (never-consumed) expectedVersion succeeds once creditNotes is re-enabled', await delIRetry.text().catch(() => ''));
  const cnIAfterRelease = await pool.query(`SELECT used_amount FROM rel_credit_notes WHERE id = $1`, [cnI.id]);
  ok(Number(cnIAfterRelease.rows[0].used_amount) === 0, 'I: the credit note is correctly released once the retry succeeds');

  // ── J: the real production-shaped scenario — edit bumps version, a second (stale) client's delete is rejected, the correct version succeeds ──
  console.log('\n[Payment delete concurrency] J — "two staff, one stale" — payment edited elsewhere; a delete holding the PRE-edit version is rejected; the post-edit version succeeds');
  const payJ = await (await fetch(`${base}/api/relational/payments`, {
    method: 'POST', headers: H, body: JSON.stringify({ ownerType: 'job', ownerId: jobId, amount: 400, method: 'EFT', notes: 'staff A opened this' }),
  })).json();
  // Staff B (still holding payJ.rowVersion in their open UI) edits the amount first.
  const editJ = await (await fetch(`${base}/api/relational/payments/${payJ.paymentId}`, {
    method: 'PUT', headers: H, body: JSON.stringify({ expectedVersion: payJ.rowVersion, ownerSection: 'jobs', amount: 425 }),
  })).json();
  ok(editJ.rowVersion === payJ.rowVersion + 1, 'J: the edit bumped row_version by exactly 1', editJ);
  // Staff A, unaware of the edit, now tries to delete using the STALE (pre-edit) version.
  const delJStale = await fetch(`${base}/api/relational/payments/${payJ.paymentId}`, {
    method: 'DELETE', headers: H, body: JSON.stringify({ expectedVersion: payJ.rowVersion, ownerSection: 'jobs' }),
  });
  const delJStaleBody: any = await delJStale.json();
  ok(delJStale.status === 409 && delJStaleBody.type === 'stale_record', 'J: staff A\'s delete with the pre-edit version is correctly rejected', delJStaleBody);
  const rowAfterJStale = await pool.query(`SELECT amount FROM rel_payments WHERE id = $1`, [payJ.paymentId]);
  ok(Number(rowAfterJStale.rows[0].amount) === 425, 'J: the payment still holds staff B\'s edited amount (425), untouched by the rejected delete');
  // Staff A refreshes, sees the real current version, and deletes correctly.
  const delJCorrect = await fetch(`${base}/api/relational/payments/${payJ.paymentId}`, {
    method: 'DELETE', headers: H, body: JSON.stringify({ expectedVersion: editJ.rowVersion, ownerSection: 'jobs' }),
  });
  ok(delJCorrect.status === 200, 'J: deleting with the correct (post-edit) version succeeds', await delJCorrect.text().catch(() => ''));

  await resetRelationalTables();
  await pool.query(`UPDATE platform_state SET data = '{}'::jsonb, updated_at = NOW() WHERE id = 1`);

  console.log('\n' + '='.repeat(60));
  console.log(`${passed} passed, ${failures} failed`);
  console.log('='.repeat(60));
  await pool.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[payment-delete-concurrency] Fatal error:', err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
