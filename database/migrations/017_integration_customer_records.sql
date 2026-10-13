-- 017_integration_customer_records.sql
-- Integration API: narrow customer writes (customer:create / customer:update).
--
-- integration_records (016) only accepted record_type 'quote'. A customer
-- created through the integration API is now recorded there too, IN THE SAME
-- TRANSACTION as the customer itself, together with the request's
-- Idempotency-Key. That row is what lets a request whose response was lost be
-- recovered exactly (no second customer), and it attributes the record to the
-- integration client that created it.
--
-- Additive and forward-only: replaces exactly ONE CHECK constraint (the
-- quote-only record_type CHECK that 016 created) with a wider one, and adds
-- one index. Touches no data, no other table and no scope. Customer writes
-- stay impossible until a person explicitly grants customer:create /
-- customer:update to a client with clientCli (see backend/src/integration/README.md).
--
-- FAIL-SAFE. 016 declared the CHECK inline:
--     record_type TEXT NOT NULL CHECK (record_type IN ('quote'))
-- so PostgreSQL generated its name (normally integration_records_record_type_check)
-- and stores it as  CHECK ((record_type = 'quote'::text))  (a one-item IN list
-- is stored as "="; the ANY(ARRAY[...]) spelling is accepted as well). The block
-- below drops ONLY a CHECK on integration_records whose sole column is
-- record_type and whose definition is exactly that quote-only rule. If there is
-- not exactly one such constraint, or any OTHER CHECK on the table refers to
-- record_type, it raises an error: the migration runner then rolls the whole
-- migration back and nothing is dropped. It never guesses.

DO $$
DECLARE
  tbl          REGCLASS := to_regclass('integration_records');
  rt_attnum    SMALLINT;
  old_names    TEXT[];
  other_names  TEXT[];
  has_new      BOOLEAN;
BEGIN
  IF tbl IS NULL THEN
    RAISE EXCEPTION '017: table integration_records not found (migration 016 must be applied first)';
  END IF;

  SELECT attnum INTO rt_attnum
    FROM pg_attribute
   WHERE attrelid = tbl AND attname = 'record_type' AND NOT attisdropped;
  IF rt_attnum IS NULL THEN
    RAISE EXCEPTION '017: integration_records.record_type not found — unexpected schema, nothing changed';
  END IF;

  -- The exact quote-only CHECK from 016: one column (record_type), exact definition.
  SELECT coalesce(array_agg(con.conname ORDER BY con.conname), '{}')
    INTO old_names
    FROM pg_constraint con
   WHERE con.conrelid = tbl
     AND con.contype = 'c'
     AND con.conkey = ARRAY[rt_attnum]
     AND regexp_replace(pg_get_constraintdef(con.oid), '\s+', '', 'g') IN (
           'CHECK((record_type=''quote''::text))',
           'CHECK((record_type=ANY(ARRAY[''quote''::text])))'
         );

  -- Is the replacement already in place (exact name and exact definition)?
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint con
     WHERE con.conrelid = tbl
       AND con.contype = 'c'
       AND con.conname = 'integration_records_record_type_chk'
       AND regexp_replace(pg_get_constraintdef(con.oid), '\s+', '', 'g')
           = 'CHECK((record_type=ANY(ARRAY[''quote''::text,''customer''::text])))'
  ) INTO has_new;

  -- Any OTHER CHECK on the table that involves record_type makes the schema ambiguous.
  SELECT coalesce(array_agg(con.conname ORDER BY con.conname), '{}')
    INTO other_names
    FROM pg_constraint con
   WHERE con.conrelid = tbl
     AND con.contype = 'c'
     AND rt_attnum = ANY (con.conkey)
     AND NOT (con.conname = ANY (old_names))
     AND NOT (has_new AND con.conname = 'integration_records_record_type_chk');

  IF cardinality(other_names) > 0 THEN
    RAISE EXCEPTION '017: unexpected CHECK constraint(s) on integration_records.record_type: % — refusing to change anything', other_names;
  END IF;

  IF cardinality(old_names) > 1 THEN
    RAISE EXCEPTION '017: found % quote-only record_type CHECK constraints (%) where exactly one was expected — refusing to change anything',
      cardinality(old_names), old_names;
  END IF;

  IF cardinality(old_names) = 0 AND NOT has_new THEN
    RAISE EXCEPTION '017: the quote-only record_type CHECK from migration 016 was not found — refusing to change anything';
  END IF;

  IF cardinality(old_names) = 1 THEN
    EXECUTE format('ALTER TABLE integration_records DROP CONSTRAINT %I', old_names[1]);
  END IF;

  IF NOT has_new THEN
    ALTER TABLE integration_records
      ADD CONSTRAINT integration_records_record_type_chk CHECK (record_type IN ('quote', 'customer'));
  END IF;
END $$;

-- Recovery lookup: (client, record type, idempotency key).
CREATE INDEX IF NOT EXISTS idx_integration_records_key
  ON integration_records (client_id, record_type, idempotency_key);
