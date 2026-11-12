/**
 * Integration client administration (run on the server / via Render Shell).
 *
 *   node dist/integration/clientCli.js create --client-id sally --name "Sally AI Sales Assistant" --company-code 2
 *   node dist/integration/clientCli.js rotate --client-id sally
 *   node dist/integration/clientCli.js revoke --client-id sally
 *   node dist/integration/clientCli.js set-scopes --client-id sally --scopes customer:read,product:read
 *   node dist/integration/clientCli.js add-scopes --client-id sally --scopes customer:create,customer:update
 *   node dist/integration/clientCli.js list
 *
 * Read-only, multi-company client (CORE-AGENTS owner read access, migration 018):
 *   node dist/integration/clientCli.js create-reader --client-id core-agents --name "CORE-AGENTS (owner read)" --companies 1,2,4
 *   node dist/integration/clientCli.js set-companies --client-id core-agents --companies 1,2
 * A reader gets OWNER_READ_SCOPES unless --scopes names a subset; it can never hold a write scope (CLI, API and DB
 * all refuse) and every non-GET request it makes is refused.
 *
 * `create` and `rotate` print the secret ONCE. Only its SHA-256 hash is
 * stored; if it is lost, rotate. Default scopes (no --scopes) = DEFAULT_SCOPES
 * in scopes.ts: the read + draft-quote set. Customer writes (customer:create,
 * customer:update) are never granted by default — a person must name them.
 *
 * Can also be run from a workstation against Render's EXTERNAL database URL
 * (DATABASE_URL). It uses its own connection (cliDb.ts), not the backend's
 * shared pool: the connect timeout defaults to 15000 ms and can be set with
 * INTEGRATION_CLI_DB_CONNECT_TIMEOUT_MS (1000–120000).
 */
import type { Pool } from 'pg';
import { createCliPool } from './cliDb';
import { KNOWN_SCOPES, DEFAULT_SCOPES, MASTER_DATA_WRITE_SCOPES, OWNER_READ_SCOPES, isKnownScope, isWriteScope } from './scopes';
import { generateSecret, hashSecret } from './keys';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function parseScopes(raw: string | undefined): string[] {
  return (raw || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function reportMasterDataScopes(scopes: string[]): void {
  const writes = scopes.filter((s) => (MASTER_DATA_WRITE_SCOPES as readonly string[]).includes(s));
  if (writes.length) console.log(`  NOTE: this client can now CHANGE Signacore customer master data (${writes.join(', ')}).`);
}

let pool: Pool;

async function main(): Promise<void> {
  pool = createCliPool(); // throws a clear error for a missing DATABASE_URL or an invalid timeout
  const cmd = process.argv[2];
  const clientId = arg('client-id');
  const by = process.env.USER || process.env.USERNAME || 'cli';
  if (cmd === 'list') {
    const r = await pool.query(`SELECT client_id, display_name, company_code, read_only, read_company_codes, scopes, is_active, revoked_at, created_at, rotated_at, last_used_at FROM integration_clients ORDER BY client_id`);
    console.table(r.rows);
    return;
  }
  if (!clientId || !/^[a-z][a-z0-9-]{2,39}$/.test(clientId)) throw new Error('--client-id is required (lowercase letters, digits, hyphens).');

  if (cmd === 'create') {
    const name = arg('name') || clientId;
    const company = arg('company-code');
    if (!company) throw new Error('--company-code is required (the Signacore company whose quotes this client may create/read).');
    const co = await pool.query('SELECT 1 FROM rel_companies WHERE code = $1', [company]);
    if (!co.rowCount) throw new Error(`Company code "${company}" does not exist in rel_companies.`);
    const named = parseScopes(arg('scopes'));
    const scopes = named.length ? named : [...DEFAULT_SCOPES];
    const unknown = scopes.filter((s) => !isKnownScope(s));
    if (unknown.length) throw new Error(`Unknown scopes: ${unknown.join(', ')}. Allowed: ${KNOWN_SCOPES.join(', ')}`);
    const secret = generateSecret();
    await pool.query(
      `INSERT INTO integration_clients (client_id, display_name, secret_hash, scopes, company_code, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [clientId, name, hashSecret(secret), scopes, company, by]
    );
    printSecret(clientId, secret, scopes);
    reportMasterDataScopes(scopes);
    return;
  }
  if (cmd === 'create-reader') {
    const name = arg('name') || clientId;
    const companies = await parseCompanies(arg('companies'));
    const named = parseScopes(arg('scopes'));
    const scopes = named.length ? named : [...OWNER_READ_SCOPES];
    const unknown = scopes.filter((s) => !isKnownScope(s));
    if (unknown.length) throw new Error(`Unknown scopes: ${unknown.join(', ')}. Allowed: ${KNOWN_SCOPES.join(', ')}`);
    const writes = scopes.filter(isWriteScope);
    if (writes.length) throw new Error(`A read-only client cannot hold write scopes (${writes.join(', ')}). Use a separate client for writes.`);
    const secret = generateSecret();
    await pool.query(
      `INSERT INTO integration_clients (client_id, display_name, secret_hash, scopes, company_code, read_only, read_company_codes, created_by)
       VALUES ($1,$2,$3,$4,$5,TRUE,$6,$7)`,
      [clientId, name, hashSecret(secret), scopes, companies[0], companies, by]
    );
    printSecret(clientId, secret, scopes, companies);
    return;
  }
  if (cmd === 'set-companies') {
    const companies = await parseCompanies(arg('companies'));
    const r = await pool.query(`UPDATE integration_clients SET read_company_codes = $2, company_code = $3 WHERE client_id = $1 AND read_only RETURNING client_id`, [clientId, companies, companies[0]]);
    console.log(r.rowCount ? `${clientId} may now read companies: ${companies.join(', ')}` : 'No such read-only client (set-companies only applies to clients made with create-reader).');
    return;
  }
  if (cmd === 'rotate') {
    const secret = generateSecret();
    const r = await pool.query(
      `UPDATE integration_clients SET secret_hash = $2, rotated_at = NOW(), is_active = TRUE, revoked_at = NULL WHERE client_id = $1 RETURNING scopes`,
      [clientId, hashSecret(secret)]
    );
    if (!r.rowCount) throw new Error('No such client.');
    printSecret(clientId, secret, r.rows[0].scopes);
    return;
  }
  if (cmd === 'revoke') {
    const r = await pool.query(`UPDATE integration_clients SET is_active = FALSE, revoked_at = NOW() WHERE client_id = $1`, [clientId]);
    console.log(r.rowCount ? `Revoked ${clientId}. Its secret no longer works.` : 'No such client.');
    return;
  }
  if (cmd === 'set-scopes') {
    const scopes = parseScopes(arg('scopes'));
    const unknown = scopes.filter((s) => !isKnownScope(s));
    if (unknown.length) throw new Error(`Unknown scopes: ${unknown.join(', ')}`);
    await refuseWritesForReader(clientId, scopes);
    const r = await pool.query(`UPDATE integration_clients SET scopes = $2 WHERE client_id = $1`, [clientId, scopes]);
    console.log(r.rowCount ? `Scopes for ${clientId}: ${scopes.join(', ') || '(none)'}` : 'No such client.');
    if (r.rowCount) reportMasterDataScopes(scopes);
    return;
  }
  if (cmd === 'add-scopes') {
    // Adds the named scopes to whatever the client already has (nothing else changes; the secret is untouched).
    const add = parseScopes(arg('scopes'));
    if (!add.length) throw new Error('--scopes is required.');
    const unknown = add.filter((s) => !isKnownScope(s));
    if (unknown.length) throw new Error(`Unknown scopes: ${unknown.join(', ')}. Allowed: ${KNOWN_SCOPES.join(', ')}`);
    const cur = await pool.query(`SELECT scopes FROM integration_clients WHERE client_id = $1`, [clientId]);
    if (!cur.rowCount) throw new Error('No such client.');
    await refuseWritesForReader(clientId, add);
    const scopes = [...new Set([...(cur.rows[0].scopes as string[] || []), ...add])];
    await pool.query(`UPDATE integration_clients SET scopes = $2 WHERE client_id = $1`, [clientId, scopes]);
    console.log(`Scopes for ${clientId}: ${scopes.join(', ')}`);
    reportMasterDataScopes(add);
    return;
  }
  throw new Error('Usage: create | create-reader | set-companies | rotate | revoke | set-scopes | add-scopes | list');
}

/** Company codes the owner authorises, validated against rel_companies. */
async function parseCompanies(raw: string | undefined): Promise<string[]> {
  const list = [...new Set((raw || '').split(',').map((s) => s.trim()).filter(Boolean))];
  if (!list.length) throw new Error('--companies is required, e.g. --companies 1,2,4 (only companies the owner authorises).');
  for (const c of list) {
    const co = await pool.query('SELECT 1 FROM rel_companies WHERE code = $1', [c]);
    if (!co.rowCount) throw new Error(`Company code "${c}" does not exist in rel_companies.`);
  }
  return list;
}

async function refuseWritesForReader(clientId: string, scopes: string[]): Promise<void> {
  const r = await pool.query(`SELECT read_only FROM integration_clients WHERE client_id = $1`, [clientId]);
  const writes = scopes.filter(isWriteScope);
  if (r.rows[0]?.read_only && writes.length) throw new Error(`${clientId} is read-only and cannot be given write scopes (${writes.join(', ')}).`);
}

function printSecret(clientId: string, secret: string, scopes: string[], companies?: string[]): void {
  console.log('');
  console.log(companies
    ? '  Read-only client ready. Store these on the CORE-AGENTS Render services (core-agents, core-agents-scan, core-agents-briefing):'
    : '  Integration client ready. Store these in the CALLING service\'s environment (e.g. Sally on Render):');
  console.log(`    SIGNACORE_CLIENT_ID=${clientId}`);
  console.log(`    SIGNACORE_API_KEY=${secret}`);
  if (companies) console.log(`    SIGNACORE_COMPANY_CODES=${companies.join(',')}`);
  console.log(`  Scopes: ${scopes.join(', ')}${companies ? ' (read-only)' : ''}`);
  console.log('  This secret is shown ONCE and is not stored. If lost, run "rotate".');
  console.log('');
}

main()
  .catch((e) => { console.error(`Error: ${e.message}`); process.exitCode = 1; })
  .finally(() => (pool ? pool.end() : undefined));
