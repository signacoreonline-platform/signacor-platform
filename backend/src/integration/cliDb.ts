/**
 * Database connection for the integration client CLI (clientCli.ts) ONLY.
 *
 * Why this exists (2026-10-13): clientCli used the shared backend pool
 * (db/pool.ts), whose connectionTimeoutMillis is 2000 ms. That suits the
 * deployed server, which reaches Postgres over Render's private network. It is
 * too short for the CLI run from a workstation against Render's EXTERNAL
 * endpoint (TLS handshake across continents), which fails with
 * "Connection terminated due to connection timeout".
 *
 * So the CLI gets its own small pool with a longer, configurable connect
 * timeout. db/pool.ts — and therefore the running backend — is NOT changed.
 *
 *   INTEGRATION_CLI_DB_CONNECT_TIMEOUT_MS   optional, whole milliseconds,
 *                                           1000–120000, default 15000.
 * An invalid value is REFUSED with a clear error (the CLI does not start)
 * rather than silently replaced, so an operator never runs with a timeout
 * they did not intend. The value of DATABASE_URL is never printed.
 */
import { Pool } from 'pg';
import dotenv from 'dotenv';
import { resolveSsl } from '../db/ssl';

dotenv.config();

export const CLI_CONNECT_TIMEOUT_ENV = 'INTEGRATION_CLI_DB_CONNECT_TIMEOUT_MS';
export const CLI_CONNECT_TIMEOUT_DEFAULT_MS = 15000;
export const CLI_CONNECT_TIMEOUT_MIN_MS = 1000;
export const CLI_CONNECT_TIMEOUT_MAX_MS = 120000;

/** Strict parse: unset/blank → default; otherwise a whole number of ms within bounds, or an error. */
export function cliConnectTimeoutMs(raw: string | undefined = process.env[CLI_CONNECT_TIMEOUT_ENV]): number {
  if (raw === undefined || raw.trim() === '') return CLI_CONNECT_TIMEOUT_DEFAULT_MS;
  const v = raw.trim();
  if (!/^\d+$/.test(v)) {
    throw new Error(`${CLI_CONNECT_TIMEOUT_ENV} must be a whole number of milliseconds (got a non-integer value).`);
  }
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < CLI_CONNECT_TIMEOUT_MIN_MS || n > CLI_CONNECT_TIMEOUT_MAX_MS) {
    throw new Error(`${CLI_CONNECT_TIMEOUT_ENV} must be between ${CLI_CONNECT_TIMEOUT_MIN_MS} and ${CLI_CONNECT_TIMEOUT_MAX_MS} ms.`);
  }
  return n;
}

/** Pool settings for the CLI. Same SSL decision as the backend (db/ssl.ts). */
export function cliPoolConfig(databaseUrl: string | undefined = process.env.DATABASE_URL, rawTimeout?: string) {
  if (!databaseUrl) throw new Error('DATABASE_URL is not set.');
  return {
    connectionString: databaseUrl,
    ssl: resolveSsl(databaseUrl),
    max: 2,                                   // the CLI runs one statement at a time
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: cliConnectTimeoutMs(rawTimeout === undefined ? process.env[CLI_CONNECT_TIMEOUT_ENV] : rawTimeout),
  };
}

export function createCliPool(): Pool {
  const pool = new Pool(cliPoolConfig());
  pool.on('error', (err) => console.error('[integration-cli] idle database client error:', err?.message || err));
  return pool;
}
