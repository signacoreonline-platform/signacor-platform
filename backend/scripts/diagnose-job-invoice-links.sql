-- ============================================================================
-- diagnose-job-invoice-links.sql
-- Signacore — READ-ONLY diagnostic for job-side invoice linkage
-- Created 2026-08-24 (invoice list consistency / View-only investigation)
-- ============================================================================
--
-- WHAT THIS ANSWERS
--   For EVERY job that carries invoice linkage (rel_jobs.invoice_num or
--   invoice_created), does an authoritative rel_invoices row actually exist
--   behind it? Jobs where the answer is "no" are the rows that render as
--   historical job invoices with no accounting record — the "View-only" rows.
--
-- THIS SCRIPT IS STRICTLY READ ONLY.
--   * Every statement is a SELECT. There is no INSERT, UPDATE, DELETE,
--     TRUNCATE, ALTER, CREATE or GRANT anywhere in this file.
--   * It is wrapped in a READ ONLY transaction, so Postgres itself will
--     REFUSE any write even if one were somehow introduced.
--   * It ends with ROLLBACK.
--   Safe to run against production. It changes nothing and locks nothing.
--
-- HOW TO RUN (from a machine that can already reach the production DB):
--   psql "$DATABASE_URL" -f backend/scripts/diagnose-job-invoice-links.sql
--
--   To capture the output for review:
--   psql "$DATABASE_URL" -f backend/scripts/diagnose-job-invoice-links.sql \
--        > job-invoice-link-report.txt 2>&1
--
-- CLASSIFICATION
--   MATCHED    exactly one live rel_invoices row is this job's invoice
--              (linked by job_id, or by same company + same invoice number).
--              Renders as one canonical invoice with the full action set.
--   ORPHANED   the job carries invoice linkage but NO rel_invoices row
--              exists for it. Almost always a genuine historical invoice
--              raised by the pre-cutover "Create Invoice" flow, which only
--              ever wrote the job (see index.html createInvoiceNow's JSON
--              branch: forceSaveSections({ jobs })) — backfill preserves that
--              faithfully and never synthesises an invoice row from job
--              fields. These are REAL invoices; they simply have no
--              accounting record. NOT automatically repairable.
--   AMBIGUOUS  more than one live rel_invoices row matches. Cannot happen
--              under UNIQUE (company_code, invoice_number); if it appears,
--              something has bypassed that constraint. Needs a person.
--   INVALID    the job's invoice number exists in a DIFFERENT company. The
--              job is claiming another company's document number. Needs a
--              person. NEVER merge these.
--   NO_NUMBER  invoice_created is true but there is no invoice number at all.
--
-- WHAT TO DO WITH THE OUTPUT
--   Send sections 1-3 back for review before ANY repair is considered. Do not
--   clear or rewrite historical linkage on the strength of this report alone —
--   an ORPHANED row is a real invoice, not a mistake, and section 3 shows
--   which of them still carry money.
-- ============================================================================

\pset pager off
\pset border 2
\timing off

BEGIN TRANSACTION READ ONLY;

-- Every job carrying invoice linkage, resolved against rel_invoices exactly
-- the way read.ts resolveJobInvoiceLinks() and the UI's
-- resolveJobInvoiceRecord() resolve it: company-scoped, void invoices
-- excluded, invoice numbers compared case- and whitespace-normalised.
-- The report is defined ONCE as a psql variable and inlined into each
-- section below. It is deliberately NOT a TEMP VIEW: creating one is a
-- write, and this script runs inside a READ ONLY transaction that refuses
-- every write — which is exactly the guarantee we want, so the query is
-- reused by substitution instead.
\set report_cte 'WITH linked AS ( SELECT j.id                                   AS job_id, j.company_code, j.job_number, j.customer_name_raw, j.status                               AS job_status, j.stage                                AS job_stage, j.value                                AS job_value, j.invoice_num, j.invoice_date, j.invoice_due, j.invoice_created, j.invoice_status, COUNT(i.id)::int                            AS match_count, (ARRAY_AGG(i.id            ORDER BY i.id))[1] AS matched_invoice_id, (ARRAY_AGG(i.invoice_number ORDER BY i.id))[1] AS matched_invoice_number FROM rel_jobs j LEFT JOIN rel_invoices i ON i.company_code = j.company_code AND COALESCE(i.status, '''') <> ''void'' AND ( i.job_id = j.id OR ( j.invoice_num IS NOT NULL AND UPPER(BTRIM(i.invoice_number)) = UPPER(BTRIM(j.invoice_num)) ) ) WHERE j.invoice_num IS NOT NULL OR j.invoice_created = true GROUP BY j.id ), cross_company AS ( SELECT l.job_id, COUNT(x.id)::int AS other_company_matches, STRING_AGG(DISTINCT x.company_code, '', '') AS other_companies FROM linked l LEFT JOIN rel_invoices x ON x.company_code <> l.company_code AND COALESCE(x.status, '''') <> ''void'' AND l.invoice_num IS NOT NULL AND UPPER(BTRIM(x.invoice_number)) = UPPER(BTRIM(l.invoice_num)) GROUP BY l.job_id ), shared AS ( SELECT matched_invoice_id AS inv_id, COUNT(*)::int AS claiming_jobs FROM linked WHERE match_count = 1 AND matched_invoice_id IS NOT NULL GROUP BY matched_invoice_id ), report AS ( SELECT l.company_code, l.job_id, l.job_number, l.customer_name_raw, l.job_status, l.job_stage, l.job_value, l.invoice_num, l.invoice_date, l.invoice_due, l.invoice_created, l.invoice_status, l.match_count                                    AS matching_rel_invoices, CASE WHEN l.match_count = 1 AND COALESCE(sh.claiming_jobs, 0) <= 1 THEN l.matched_invoice_id END   AS relational_invoice_id, CASE WHEN l.match_count = 1 AND COALESCE(sh.claiming_jobs, 0) <= 1 THEN l.matched_invoice_number END AS relational_invoice_number, COALESCE(c.other_company_matches, 0)             AS same_number_in_other_company, c.other_companies, (SELECT COUNT(*)::int      FROM rel_payments p WHERE p.owner_type = ''job'' AND p.owner_id = l.job_id) AS job_payment_count, (SELECT COALESCE(SUM(p.amount), 0) FROM rel_payments p WHERE p.owner_type = ''job'' AND p.owner_id = l.job_id) AS job_payment_total, (SELECT COUNT(*)::int FROM rel_payments p WHERE p.owner_type = ''job'' AND p.owner_id = l.job_id AND p.method = ''Credit'')                     AS job_credit_payment_count, (SELECT COUNT(*)::int FROM rel_credit_notes cn WHERE cn.company_code = l.company_code AND l.invoice_num IS NOT NULL AND cn.applied_to IS NOT NULL AND UPPER(BTRIM(cn.applied_to)) LIKE ''%'' || UPPER(BTRIM(l.invoice_num)) || ''%'')                 AS credit_notes_naming_invoice, COALESCE(sh.claiming_jobs, 0) AS jobs_claiming_same_invoice, CASE WHEN l.invoice_num IS NULL OR BTRIM(l.invoice_num) = '''' THEN ''NO_NUMBER'' WHEN COALESCE(c.other_company_matches, 0) > 0 AND l.match_count = 0 THEN ''INVALID'' WHEN l.match_count = 1 AND COALESCE(sh.claiming_jobs, 0) > 1 THEN ''AMBIGUOUS'' WHEN l.match_count = 1 THEN ''MATCHED'' WHEN l.match_count = 0 THEN ''ORPHANED'' ELSE ''AMBIGUOUS'' END AS classification FROM linked l LEFT JOIN cross_company c ON c.job_id = l.job_id LEFT JOIN shared sh ON sh.inv_id = l.matched_invoice_id )'


\echo ''
\echo '=============================================================='
\echo ' SECTION 1 — SUMMARY BY COMPANY AND CLASSIFICATION'
\echo '=============================================================='
:report_cte
SELECT company_code,
       classification,
       COUNT(*)::int                                        AS jobs,
       SUM(CASE WHEN job_payment_count > 0 THEN 1 ELSE 0 END)::int AS with_job_payments,
       SUM(job_payment_total)                               AS job_payment_total
  FROM report
 GROUP BY company_code, classification
 ORDER BY company_code, classification;

\echo ''
\echo '=============================================================='
\echo ' SECTION 2 — EVERY JOB NEEDING ATTENTION'
\echo ' (ORPHANED / AMBIGUOUS / INVALID / NO_NUMBER — full detail)'
\echo '=============================================================='
:report_cte
SELECT company_code, job_number, invoice_num, invoice_created, invoice_status,
       invoice_date, invoice_due, job_status, job_stage, job_value,
       customer_name_raw, matching_rel_invoices, same_number_in_other_company,
       other_companies, jobs_claiming_same_invoice, job_payment_count, job_payment_total,
       job_credit_payment_count, credit_notes_naming_invoice, classification
  FROM report
 WHERE classification <> 'MATCHED'
 ORDER BY classification, company_code, invoice_num;

\echo ''
\echo '=============================================================='
\echo ' SECTION 3 — ORPHANED JOBS THAT STILL CARRY MONEY'
\echo ' (review these first: they are real invoices with real payments)'
\echo '=============================================================='
:report_cte
SELECT company_code, job_number, invoice_num, invoice_status,
       job_payment_count, job_payment_total, job_credit_payment_count,
       credit_notes_naming_invoice, customer_name_raw
  FROM report
 WHERE classification = 'ORPHANED'
   AND (job_payment_count > 0 OR credit_notes_naming_invoice > 0)
 ORDER BY job_payment_total DESC, invoice_num;

\echo ''
\echo '=============================================================='
\echo ' SECTION 4 — MATCHED JOBS (confirmation only, first 50)'
\echo ' These now collapse to ONE canonical invoice row in the UI.'
\echo '=============================================================='
:report_cte
SELECT company_code, job_number, invoice_num,
       relational_invoice_id, relational_invoice_number
  FROM report
 WHERE classification = 'MATCHED'
 ORDER BY company_code, invoice_num
 LIMIT 50;

\echo ''
\echo '=============================================================='
\echo ' SECTION 5 — rel_invoices NOT reachable from any job'
\echo ' (standalone/manual invoices — expected, listed for completeness)'
\echo '=============================================================='
:report_cte
SELECT i.company_code, i.invoice_number, i.contact_name, i.status,
       i.job_id, i.job_number_raw, i.reference, i.quote_number_raw
  FROM rel_invoices i
 WHERE COALESCE(i.status, '') <> 'void'
   AND NOT EXISTS (
     SELECT 1 FROM report r
      WHERE r.relational_invoice_id = i.id
   )
 ORDER BY i.company_code, i.invoice_number
 LIMIT 200;

ROLLBACK;

\echo ''
\echo 'Diagnostic complete. Nothing was written — the transaction was READ ONLY'
\echo 'and has been rolled back.'
