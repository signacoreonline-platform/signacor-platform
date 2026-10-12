-- 016_integration_clients.sql
-- Server-to-server integration clients (first client: Sally, the AI Sales
-- Assistant) for the versioned /api/v1/integration API.
--
-- WHY A SEPARATE IDENTITY. Sally must not log in as a human (no shared
-- passwords, no JWT for an app_users row) and must not inherit the
-- unrestricted reach that any JWT has over /api/relational today. An
-- integration client is a machine identity with:
--   - a revocable secret, stored ONLY as a SHA-256 hash (the plaintext is
--     printed once by the provisioning CLI and never stored);
--   - an explicit scope list, additionally capped in code by
--     backend/src/integration/scopes.ts (a scope written here that the code
--     does not recognise grants nothing);
--   - a fixed company code: every quote it creates or reads is scoped to it.
--
-- Additive and idempotent only: creates new tables, touches nothing that
-- exists, safe to re-run. The API itself stays OFF until
-- INTEGRATION_API_ENABLED=true is set in the environment.

CREATE TABLE IF NOT EXISTS integration_clients (
  id            BIGSERIAL PRIMARY KEY,
  client_id     TEXT NOT NULL UNIQUE CHECK (client_id ~ '^[a-z][a-z0-9-]{2,39}$'),
  display_name  TEXT NOT NULL,
  secret_hash   TEXT NOT NULL,                -- hex SHA-256 of the secret
  scopes        TEXT[] NOT NULL DEFAULT '{}',
  company_code  TEXT NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  last_used_at  TIMESTAMPTZ
);

-- One row per request: who (client + the human/process it acted for), what,
-- which record, and the outcome. Never stores request bodies or secrets.
CREATE TABLE IF NOT EXISTS integration_audit (
  id               BIGSERIAL PRIMARY KEY,
  client_id        TEXT NOT NULL,
  request_id       TEXT,
  operation        TEXT NOT NULL,
  method           TEXT NOT NULL,
  is_mutation      BOOLEAN NOT NULL DEFAULT FALSE,
  target_type      TEXT,
  target_id        TEXT,
  outcome          TEXT NOT NULL CHECK (outcome IN ('success','denied','rejected','error','replayed')),
  http_status      INTEGER NOT NULL,
  error_code       TEXT,
  acting_for       TEXT,                      -- e.g. the Sally Administrator who initiated it
  confirmed_by     TEXT,                      -- set when the client reports an explicit confirmation
  idempotency_key  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_integration_audit_client_time ON integration_audit (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_integration_audit_target ON integration_audit (target_type, target_id);

-- Idempotency for every mutating call: the same (client, key) can only ever
-- produce one effect. A retry with the same key and same body replays the
-- stored response; the same key with a different body is refused.
CREATE TABLE IF NOT EXISTS integration_idempotency (
  client_id        TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL,
  operation        TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('in_progress','completed')),
  response_status  INTEGER,
  response_body    JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (client_id, idempotency_key)
);

-- Records an integration client created. Edits are only ever allowed on
-- records listed here (and only while still in an editable state), so a
-- client can never modify a quote a person created in the dashboard.
CREATE TABLE IF NOT EXISTS integration_records (
  id               BIGSERIAL PRIMARY KEY,
  client_id        TEXT NOT NULL,
  record_type      TEXT NOT NULL CHECK (record_type IN ('quote')),
  record_id        BIGINT NOT NULL,
  external_ref     TEXT,                      -- e.g. Sally enquiry number
  idempotency_key  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, record_type, record_id)
);
CREATE INDEX IF NOT EXISTS idx_integration_records_ref ON integration_records (client_id, record_type, external_ref);
