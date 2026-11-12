-- 018 — Read-only, multi-company integration clients (CORE-AGENTS owner read access).
--
-- A READ-ONLY client may read several companies that the owner explicitly authorised (read_company_codes) through
-- the GET-only /api/v1/integration/read/* endpoints. It can never hold a write scope and never perform a write:
--   * enforced here (CHECK constraints below), in the CLI (clientCli create-reader / set-scopes) and in the API
--     (integration/auth.ts refuses every non-GET request from a read-only client before any route runs).
-- Existing clients (e.g. Sally) are untouched: read_only = false, read_company_codes = '{}', so they keep reading and
-- writing exactly their own company_code as before.

ALTER TABLE integration_clients ADD COLUMN IF NOT EXISTS read_only BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE integration_clients ADD COLUMN IF NOT EXISTS read_company_codes TEXT[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
  -- A read-only client holds no write scope, ever.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_integration_clients_read_only_no_writes') THEN
    ALTER TABLE integration_clients ADD CONSTRAINT ck_integration_clients_read_only_no_writes
      CHECK (NOT read_only OR NOT (scopes && ARRAY['quote:create','quote:update','customer:create','customer:update']::text[]));
  END IF;
  -- Multi-company access exists only for read-only clients.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_integration_clients_multi_company_read_only') THEN
    ALTER TABLE integration_clients ADD CONSTRAINT ck_integration_clients_multi_company_read_only
      CHECK (read_only OR cardinality(read_company_codes) = 0);
  END IF;
END $$;
