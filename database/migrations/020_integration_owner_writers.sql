-- 020 — Owner-writer integration clients (CORE-AGENTS confirmed actions).
--
-- An OWNER-WRITER is a separate integration client for changes the owner has confirmed in CORE-AGENTS. It may call only
-- /api/v1/integration/write/* (auth.ts refuses it everywhere else, and refuses every other client there), only for the
-- companies in write_company_codes, and only with the owner write scopes below. Every route goes through
-- relational/services.ts unchanged (writeRoutes.ts). The CORE-AGENTS reader (read_only) and Sally are untouched.
--
-- Additive and idempotent: two new columns with safe defaults and CHECK constraints; nothing existing changes.

ALTER TABLE integration_clients ADD COLUMN IF NOT EXISTS owner_writer BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE integration_clients ADD COLUMN IF NOT EXISTS write_company_codes TEXT[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
  -- A read-only client holds no write scope, ever — now including the owner write scopes.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_integration_clients_read_only_no_writes') THEN
    ALTER TABLE integration_clients DROP CONSTRAINT ck_integration_clients_read_only_no_writes;
  END IF;
  ALTER TABLE integration_clients ADD CONSTRAINT ck_integration_clients_read_only_no_writes
    CHECK (NOT read_only OR NOT (scopes && ARRAY['quote:create','quote:update','customer:create','customer:update',
                                                  'jobs:update','invoices:create','purchasing:create','purchasing:update']::text[]));
  -- An owner-writer is never read-only and holds ONLY owner write scopes.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_integration_clients_owner_writer_scopes') THEN
    ALTER TABLE integration_clients ADD CONSTRAINT ck_integration_clients_owner_writer_scopes
      CHECK (NOT owner_writer OR (NOT read_only AND scopes <@ ARRAY['jobs:update','invoices:create','purchasing:create','purchasing:update']::text[]));
  END IF;
  -- Owner write scopes exist only on owner-writers (Sally can never be given them).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_integration_clients_owner_scopes_need_writer') THEN
    ALTER TABLE integration_clients ADD CONSTRAINT ck_integration_clients_owner_scopes_need_writer
      CHECK (owner_writer OR NOT (scopes && ARRAY['jobs:update','invoices:create','purchasing:create','purchasing:update']::text[]));
  END IF;
  -- Multi-company WRITE access exists only for owner-writers.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_integration_clients_write_companies_writer') THEN
    ALTER TABLE integration_clients ADD CONSTRAINT ck_integration_clients_write_companies_writer
      CHECK (owner_writer OR cardinality(write_company_codes) = 0);
  END IF;
END $$;
