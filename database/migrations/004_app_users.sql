-- 004_app_users.sql
-- Backend-authoritative login accounts for the live dashboard.
--
-- Added as part of Audit finding B1 (unauthenticated /api/platform-state and
-- /api/document-numbers/reserve). The live app's actual login accounts have
-- always lived in platform_state.data.userAccounts and were checked entirely
-- client-side. That table cannot be protected by auth (the app needs it to
-- know who's allowed to log in), so a real, backend-only accounts table is
-- needed instead.
--
-- Deliberately a NEW table (`app_users`), NOT the pre-existing `users` table
-- from database/schema.sql. That schema.sql/schema_addons.sql pair defines a
-- completely separate, UUID-keyed data model (companies/clients/jobs/quotes/
-- invoices) that the live dashboard has never used (confirmed: index.html
-- only ever calls /api/platform-state and /api/document-numbers/reserve) and
-- is not applied by this migration runner — reusing that `users` table would
-- tie live login to a schema of unknown/unverified state in production and
-- would require a company_id foreign key the live app's simple co:1/co:2
-- model doesn't have. `app_users` is intentionally minimal and matches the
-- live userAccounts shape (id/email/pw/role/name/co) instead.
--
-- account_id mirrors the frontend's userAccounts[].id (its email today) so
-- existing accounts can be seeded/matched 1:1 by backend/src/db/
-- seedAppUsersFromPlatformState.ts without inventing new identifiers.
--
-- password_hash is nullable and requires_password can be FALSE for the two
-- passwordless "Manufacturing" one-tap accounts that already exist in
-- userAccounts (role:'factory', pw:'') — preserves that behaviour exactly,
-- just moved server-side.
--
-- Idempotent and additive only:
--   - never drops or truncates anything
--   - never touches platform_state or platform_state_backups
--   - safe to re-run

CREATE TABLE IF NOT EXISTS app_users (
  id                BIGSERIAL PRIMARY KEY,
  account_id        TEXT NOT NULL UNIQUE,
  email             TEXT NOT NULL UNIQUE,
  password_hash     TEXT,
  requires_password BOOLEAN NOT NULL DEFAULT TRUE,
  role              TEXT NOT NULL,
  co                INTEGER,
  name              TEXT,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_users_email ON app_users (LOWER(email));
