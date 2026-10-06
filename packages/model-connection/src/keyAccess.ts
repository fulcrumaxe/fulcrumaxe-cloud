// PI-2a (D#291): the one restricted subpath (`@fx/model-connection/keyAccess`) through which an opened
// key leaves this package -- only inside a callback, only to @fx/model-call (test/boundary.test.ts in
// that package enforces it). Deliberately NOT re-exported from index.ts (the frozen C6 surface).
import type { Pool } from 'pg';
import { withTenant } from '@fx/db/src/withTenant.js';
import { getMemberRole } from '@fx/core/src/tenancy/authorize.js';
import { NotFoundError } from './errors.js';
import { open, type Sealed } from './crypto.js';
import type { KekSource } from './kek.js';
import { buildAad, type Principal, type Provider } from './types.js';

export interface KeyAccessCtx {
  pool: Pool;
  principal: Principal;
  kek: KekSource;
}

interface KeyRow extends Sealed {
  id: string;
  provider: Provider;
  kek_version: number;
}

/**
 * Reads the account's sealed key inside withTenant (that transaction ends before `use` runs, so no DB
 * lock is held during the caller's network call), opens it, and hands it to `use`. Nothing is cached;
 * the plaintext is a local for the callback's duration. Same membership rule as test(): a non-member
 * gets NotFoundError.
 */
export async function withOpenedKey<T>(
  ctx: KeyAccessCtx,
  use: (opened: { provider: Provider; key: string }) => Promise<T>,
): Promise<T> {
  const { accountId, userId } = ctx.principal;
  const missing = () => new NotFoundError(`model_connections: no connection for account ${accountId}`);
  if ((await getMemberRole(ctx.pool, accountId, userId)) === null) throw missing();
  const row = await withTenant(ctx.pool, accountId, async (client) => {
    const { rows } = await client.query<KeyRow>(
      `SELECT id, provider, key_ciphertext AS ciphertext, key_nonce AS nonce, wrapped_dek AS "wrappedDek", kek_version
         FROM model_connections WHERE account_id = $1`,
      [accountId],
    );
    return rows[0] ?? null;
  });
  if (!row) throw missing();
  const key = open({ kek: ctx.kek.keyFor(row.kek_version), aad: buildAad(accountId, row.id) }, row);
  return use({ provider: row.provider, key });
}
