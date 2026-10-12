/**
 * Integration client administration (run on the server / via Render Shell).
 *
 *   node dist/integration/clientCli.js create --client-id sally --name "Sally AI Sales Assistant" --company-code 2
 *   node dist/integration/clientCli.js rotate --client-id sally
 *   node dist/integration/clientCli.js revoke --client-id sally
 *   node dist/integration/clientCli.js set-scopes --client-id sally --scopes customer:read,product:read
 *   node dist/integration/clientCli.js list
 *
 * `create` and `rotate` print the secret ONCE. Only its SHA-256 hash is
 * stored; if it is lost, rotate. Default scopes = the full Sally set in
 * scopes.ts (which is already the Sales-Assistant subset).
 */
import pool from '../db/pool';
import { KNOWN_SCOPES, isKnownScope } from './scopes';
import { generateSecret, hashSecret } from './keys';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const clientId = arg('client-id');
  const by = process.env.USER || process.env.USERNAME || 'cli';
  if (cmd === 'list') {
    const r = await pool.query(`SELECT client_id, display_name, company_code, scopes, is_active, revoked_at, created_at, rotated_at, last_used_at FROM integration_clients ORDER BY client_id`);
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
    const scopes = (arg('scopes') || KNOWN_SCOPES.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = scopes.filter((s) => !isKnownScope(s));
    if (unknown.length) throw new Error(`Unknown scopes: ${unknown.join(', ')}. Allowed: ${KNOWN_SCOPES.join(', ')}`);
    const secret = generateSecret();
    await pool.query(
      `INSERT INTO integration_clients (client_id, display_name, secret_hash, scopes, company_code, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [clientId, name, hashSecret(secret), scopes, company, by]
    );
    printSecret(clientId, secret, scopes);
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
    const scopes = (arg('scopes') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = scopes.filter((s) => !isKnownScope(s));
    if (unknown.length) throw new Error(`Unknown scopes: ${unknown.join(', ')}`);
    const r = await pool.query(`UPDATE integration_clients SET scopes = $2 WHERE client_id = $1`, [clientId, scopes]);
    console.log(r.rowCount ? `Scopes for ${clientId}: ${scopes.join(', ') || '(none)'}` : 'No such client.');
    return;
  }
  throw new Error('Usage: create | rotate | revoke | set-scopes | list');
}

function printSecret(clientId: string, secret: string, scopes: string[]): void {
  console.log('');
  console.log('  Integration client ready. Store these in the CALLING service\'s environment (e.g. Sally on Render):');
  console.log(`    SIGNACORE_CLIENT_ID=${clientId}`);
  console.log(`    SIGNACORE_API_KEY=${secret}`);
  console.log(`  Scopes: ${scopes.join(', ')}`);
  console.log('  This secret is shown ONCE and is not stored. If lost, run "rotate".');
  console.log('');
}

main()
  .catch((e) => { console.error(`Error: ${e.message}`); process.exitCode = 1; })
  .finally(() => pool.end());
