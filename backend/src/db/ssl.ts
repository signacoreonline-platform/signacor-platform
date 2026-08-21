/**
 * Shared PostgreSQL SSL negotiation — the ONE place this decision is made
 * for every DB connection this backend creates: the running server
 * (db/pool.ts's shared `pool`), the migration runner (db/migrate.ts), and
 * every compiled relational CLI tool that reuses db/pool.ts's shared pool
 * (backfill.ts, reconcile.ts, cutoverCli.ts, and any future one). One
 * definition, reused everywhere — never a one-off SSL hack per script.
 *
 * ── Why the compiled relational CLI couldn't reach Render ──────────────
 * db/pool.ts (the shared pool backfill.ts/reconcile.ts/cutoverCli.ts all
 * import) had NO `ssl` option at all. That was invisible in every context
 * this project had actually exercised so far:
 *   - LOCAL dev: DATABASE_URL is a bare `localhost` Postgres — no SSL
 *     needed, `pg` connects in plaintext by default. Works.
 *   - The DEPLOYED backend on Render: its DATABASE_URL is Render's
 *     INTERNAL connection string, on Render's private network, which does
 *     not enforce SSL the way the public endpoint does. Works.
 * The first time anyone pointed this pool at Render's EXTERNAL/public
 * connection string (e.g. running a relational CLI tool from a developer
 * machine, exactly what this fix is for) is also the first time the gap
 * showed up: Render's public Postgres endpoint REQUIRES SSL server-side.
 * With no `ssl` option, `pg` attempts a plaintext handshake, and Render
 * either resets the connection (ECONNRESET) or replies with its own
 * "SSL/TLS required" error (Postgres code 28000) — exactly the two errors
 * reported. This was never a bug in backfill.ts/reconcile.ts/cutoverCli.ts
 * themselves — they already correctly share db/pool.ts's one pool; the gap
 * was in db/pool.ts itself, so the fix belongs there, once, not repeated
 * per script.
 *
 * db/migrate.ts had ALREADY solved exactly this problem for itself (it
 * needs to run against Render during deploy) with this identical
 * detection + `rejectUnauthorized: false`. That is Render's own documented
 * guidance for connecting a Node/pg client to Render Postgres — Render's
 * certificate chain isn't in Node's default trust store, so a normal
 * (verified) TLS handshake fails outright; `rejectUnauthorized: false`
 * still ENCRYPTS the connection (this is TLS, not plaintext) — it only
 * skips certificate-chain verification, which is what Render itself
 * recommends and is the already-proven, already-shipped choice in this
 * project, not a new blanket "disable all cert validation" decision made
 * here. This module is that same detection, now shared instead of
 * duplicated, so pool.ts and migrate.ts can never drift apart again.
 */
export function resolveSsl(databaseUrl: string | undefined): { rejectUnauthorized: boolean } | undefined {
  if (!databaseUrl) return undefined;
  // Local Postgres never matches this — ssl stays undefined, i.e. pg's
  // normal unencrypted local default. Unchanged from before this fix.
  const looksLikeRender = /render\.com|\.com\/|sslmode=require/i.test(databaseUrl);
  return looksLikeRender ? { rejectUnauthorized: false } : undefined;
}

/**
 * Turns a raw connection failure into a one-line, actionable diagnostic
 * instead of a bare stack trace — shared by every relational CLI
 * entrypoint (backfill.ts/reconcile.ts/cutoverCli.ts) so this logic exists
 * exactly once. Never retries anything — this only describes the error
 * that already happened; nothing here re-attempts the connection or a
 * write, in DRY RUN or APPLY mode.
 */
export function describeConnectionError(err: unknown): string {
  const e = err as { message?: string; code?: string } | undefined;
  const message = e?.message || String(err);
  const code = e?.code;

  if (code === '28000' || /SSL\/TLS required/i.test(message)) {
    return (
      `[db] Connection refused: the Postgres server requires SSL but this client did not negotiate it (code 28000).\n` +
      `  This DATABASE_URL was not recognized as needing SSL (see db/ssl.ts's resolveSsl). If this is a Render ` +
      `connection string that doesn't contain "render.com" or "sslmode=require", either use Render's standard ` +
      `connection string as-is, or append "?sslmode=require" to it.`
    );
  }
  if (message.includes('ECONNRESET')) {
    return (
      `[db] Connection reset (ECONNRESET) while connecting to Postgres.\n` +
      `  This commonly happens when a TLS-only server (e.g. Render's public Postgres endpoint) receives a ` +
      `plaintext connection attempt and drops it. Confirm DATABASE_URL is correct and that this process is on a ` +
      `network path that reaches the host (Render's dashboard shows the exact external connection string).`
    );
  }
  if (code === 'ENOTFOUND' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED') {
    return (
      `[db] Could not reach the Postgres host (${code}): ${message}\n` +
      `  Check DATABASE_URL's host/port and that this network can reach it (a firewall or VPN can cause exactly this).`
    );
  }
  return `[db] Connection/query failed: ${message}`;
}
