import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTenant } from '@fx/db/src/withTenant.js';
import { getMemberRole, requireOwnerOrAdmin } from '@fx/core/src/tenancy/authorize.js';
import { assertActiveMembership } from '@fx/core/src/tenancy/scopedAccess.js';
import {
  VERCEL_API_BASE,
  VERCEL_TEAM_RE,
  VERCEL_TOKEN_RE,
  VERCEL_USER_AGENT,
  type VercelCredential,
  type VercelCredentialResolver,
} from '@fx/core/src/setup-requests/vercelEnvSource.js';
import { fingerprintOf, open, seal } from './crypto.js';
import { NotFoundError } from './errors.js';
import type { KekSource } from './kek.js';
import { buildAad, type Principal } from './types.js';

/**
 * D#598 P8d-2: the "connect Vercel" connection kind. One sealed Vercel API token per account, stored with the same envelope as a model key
 * (crypto.ts seal/open under the platform FX_KEK_V<n>), bound to (account, row, purpose 'vercel_token') so a ciphertext cannot be moved to
 * another account, row or kind.
 *
 * The token enters this file in `connectVercel` / `rotateVercel` and is handed to the validator and to `seal`. It leaves it ONLY through
 * `createSealedVercelCredentials(...).resolve`, the credential lookup the env-var check uses. No view, error, log line or audit row carries it,
 * and every error is a fixed string plus a code from {@link VercelConnectionErrorCode}.
 */

export const VERCEL_TOKEN_PURPOSE = 'vercel_token';

export type VercelConnectionErrorCode =
  | 'invalid_token_format'
  | 'invalid_team_id'
  | 'token_rejected'
  | 'provider_unreachable'
  | 'already_connected'
  | 'not_connected';

const MESSAGES: Record<VercelConnectionErrorCode, string> = {
  invalid_token_format: 'the Vercel token is not in a form Vercel issues',
  invalid_team_id: 'the Vercel team id is not in a form Vercel issues',
  token_rejected: 'Vercel did not accept the token',
  provider_unreachable: 'Vercel could not be reached to check the token',
  already_connected: 'Vercel is already connected; replace the token instead',
  not_connected: 'Vercel is not connected',
};

export class VercelConnectionError extends Error {
  constructor(public readonly code: VercelConnectionErrorCode) {
    super(MESSAGES[code]);
    this.name = 'VercelConnectionError';
  }
}

export type VercelTokenCheck = 'ok' | 'rejected' | 'unreachable';
/** Asks Vercel whether a token (and optional team) can list projects, the one thing the env-var check needs. */
export interface VercelTokenValidator {
  check(input: { token: string; teamId?: string }): Promise<VercelTokenCheck>;
}

/** The production validator: one GET with the caller-supplied (net-guarded, pinned) fetch. 200 ok, 401/403 rejected, anything else unreachable. */
export function createVercelTokenValidator(opts: { fetch: typeof fetch; baseUrl?: string; timeoutMs?: number }): VercelTokenValidator {
  return {
    async check({ token, teamId }) {
      const url = new URL('/v10/projects', opts.baseUrl ?? VERCEL_API_BASE);
      url.searchParams.set('limit', '1');
      if (teamId !== undefined) url.searchParams.set('teamId', teamId);
      try {
        const res = await opts.fetch(url, {
          method: 'GET',
          headers: { authorization: `Bearer ${token}`, 'user-agent': VERCEL_USER_AGENT, accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000),
        });
        await res.body?.cancel();
        if (res.status === 200) return 'ok';
        return res.status === 401 || res.status === 403 ? 'rejected' : 'unreachable';
      } catch {
        // fx-swallow-ok: a network error or timeout is "could not reach Vercel"; its message can carry a host, so nothing of it is kept
        return 'unreachable';
      }
    },
  };
}

export interface VercelConnectionCtx {
  pool: Pool;
  principal: Principal;
  kek: KekSource;
  validator: VercelTokenValidator;
}

export type VercelConnectionState = 'not_connected' | 'connected' | 'rejected';
/** The only shape a caller ever sees: a display tail, never the token or any sealed column. */
export interface VercelConnectionView {
  state: VercelConnectionState;
  fingerprint: string | null;
  team_id: string | null;
  connected_at: Date | null;
  rotated_at: Date | null;
  rejected_at: Date | null;
}

const NOT_CONNECTED: VercelConnectionView = { state: 'not_connected', fingerprint: null, team_id: null, connected_at: null, rotated_at: null, rejected_at: null };

interface ViewRow {
  token_fingerprint: string;
  team_id: string | null;
  status: 'ok' | 'rejected';
  created_at: Date;
  rotated_at: Date | null;
  rejected_at: Date | null;
}
const VIEW_COLUMNS = 'token_fingerprint, team_id, status, created_at, rotated_at, rejected_at';

function toView(row: ViewRow): VercelConnectionView {
  return {
    state: row.status === 'ok' ? 'connected' : 'rejected',
    fingerprint: row.token_fingerprint,
    team_id: row.team_id,
    connected_at: row.created_at,
    rotated_at: row.rotated_at,
    rejected_at: row.rejected_at,
  };
}

const aadFor = (accountId: string, rowId: string): Buffer => buildAad(accountId, rowId, VERCEL_TOKEN_PURPOSE);

function assertTokenFormat(token: string): void {
  if (!VERCEL_TOKEN_RE.test(token)) throw new VercelConnectionError('invalid_token_format');
}

/** Any member may read the status. */
export async function getVercelConnection(ctx: Pick<VercelConnectionCtx, 'pool' | 'principal'>): Promise<VercelConnectionView> {
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    await assertActiveMembership(client, accountId, userId);
    const { rows } = await client.query<ViewRow>(`SELECT ${VIEW_COLUMNS} FROM vercel_connections WHERE account_id = $1`, [accountId]);
    return rows[0] ? toView(rows[0]) : NOT_CONNECTED;
  });
}

async function authorize(ctx: VercelConnectionCtx): Promise<void> {
  requireOwnerOrAdmin(await getMemberRole(ctx.pool, ctx.principal.accountId, ctx.principal.userId));
}

/**
 * Connects Vercel. Owner/admin only. The token is checked with Vercel BEFORE anything is encrypted or written, so a refused or unproven token
 * leaves no trace. A second connect is refused (`already_connected`): replacing is {@link rotateVercel}.
 */
export async function connectVercel(ctx: VercelConnectionCtx, input: { token: string; teamId?: string | undefined }): Promise<VercelConnectionView> {
  const { accountId, userId } = ctx.principal;
  await authorize(ctx);
  assertTokenFormat(input.token);
  if (input.teamId !== undefined && !VERCEL_TEAM_RE.test(input.teamId)) throw new VercelConnectionError('invalid_team_id');
  const verdict = await ctx.validator.check({ token: input.token, ...(input.teamId !== undefined ? { teamId: input.teamId } : {}) });
  if (verdict === 'rejected') throw new VercelConnectionError('token_rejected');
  if (verdict === 'unreachable') throw new VercelConnectionError('provider_unreachable');

  const id = randomUUID();
  const kekVersion = ctx.kek.currentVersion();
  const kek = ctx.kek.keyFor(kekVersion);
  const sealed = seal({ kek, aad: aadFor(accountId, id) }, input.token);
  const fingerprint = fingerprintOf(input.token, kek);
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    const { rows } = await client.query<ViewRow>(
      `INSERT INTO vercel_connections (id, account_id, token_ciphertext, token_nonce, wrapped_dek, kek_version, token_fingerprint, team_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (account_id) DO NOTHING RETURNING ${VIEW_COLUMNS}`,
      [id, accountId, sealed.ciphertext, sealed.nonce, sealed.wrappedDek, kekVersion, fingerprint, input.teamId ?? null, userId],
    );
    if (!rows[0]) throw new VercelConnectionError('already_connected');
    await client.query(`SELECT audit_write('vercel_connection.connect', $1::jsonb)`, [JSON.stringify({ fingerprint, team_scoped: input.teamId !== undefined })]);
    return toView(rows[0]);
  });
}

/**
 * Replaces the stored token. Owner/admin only. The new token must be accepted by Vercel first (else the old one stays, untouched). The swap is
 * one UPDATE of every sealed column in one transaction, under a row lock: a concurrent reader sees the old token or the new one, never a mix.
 * The row keeps its id, so the AAD is unchanged. A rejected connection becomes connected again.
 */
export async function rotateVercel(ctx: VercelConnectionCtx, input: { token: string }): Promise<VercelConnectionView> {
  const { accountId, userId } = ctx.principal;
  await authorize(ctx);
  assertTokenFormat(input.token);
  const current = await getVercelConnection(ctx);
  if (current.state === 'not_connected') throw new VercelConnectionError('not_connected');
  const verdict = await ctx.validator.check({ token: input.token, ...(current.team_id !== null ? { teamId: current.team_id } : {}) });
  if (verdict === 'rejected') throw new VercelConnectionError('token_rejected');
  if (verdict === 'unreachable') throw new VercelConnectionError('provider_unreachable');

  const kekVersion = ctx.kek.currentVersion();
  const kek = ctx.kek.keyFor(kekVersion);
  const fingerprint = fingerprintOf(input.token, kek);
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    const locked = await client.query<{ id: string; team_id: string | null }>(`SELECT id, team_id FROM vercel_connections WHERE account_id = $1 FOR UPDATE`, [accountId]);
    if (!locked.rows[0]) throw new VercelConnectionError('not_connected');
    // The token was checked against the team read before the lock; if the connection was replaced in between, it was not checked against this one. Ask again.
    if (locked.rows[0].team_id !== current.team_id) throw new VercelConnectionError('provider_unreachable');
    const sealed = seal({ kek, aad: aadFor(accountId, locked.rows[0].id) }, input.token);
    const { rows } = await client.query<ViewRow>(
      `UPDATE vercel_connections
          SET token_ciphertext = $2, token_nonce = $3, wrapped_dek = $4, kek_version = $5, token_fingerprint = $6,
              status = 'ok', rejected_at = NULL, rotated_at = now()
        WHERE id = $1 RETURNING ${VIEW_COLUMNS}`,
      [locked.rows[0].id, sealed.ciphertext, sealed.nonce, sealed.wrappedDek, kekVersion, fingerprint],
    );
    await client.query(`SELECT audit_write('vercel_connection.rotate', $1::jsonb)`, [JSON.stringify({ fingerprint })]);
    return toView(rows[0]!);
  });
}

/** Disconnects Vercel: the row, with its ciphertext and wrapped data key, is deleted. Owner/admin only. */
export async function removeVercel(ctx: Pick<VercelConnectionCtx, 'pool' | 'principal'>): Promise<void> {
  const { accountId, userId } = ctx.principal;
  requireOwnerOrAdmin(await getMemberRole(ctx.pool, accountId, userId));
  await withTenant(ctx.pool, accountId, userId, async (client) => {
    const { rowCount } = await client.query(`DELETE FROM vercel_connections WHERE account_id = $1`, [accountId]);
    if (!rowCount) throw new NotFoundError('vercel_connections: no connection for this account');
    await client.query(`SELECT audit_write('vercel_connection.remove', $1::jsonb)`, [JSON.stringify({})]);
  });
}

interface SealedRow {
  id: string;
  token_ciphertext: Buffer;
  token_nonce: Buffer;
  wrapped_dek: Buffer;
  kek_version: number;
  team_id: string | null;
  status: 'ok' | 'rejected';
}

/**
 * The credential lookup behind the env-var check ({@link VercelCredentialResolver}). This is the only place a stored token is opened.
 * It fails closed: no connection, a rejected one, a KEK version that is not configured, a row whose seal does not open (tampered, moved or
 * wrong version) and any database error all answer `unavailable`, logged by a fixed code. `ref` names the exact stored token (its nonce), so a
 * rejection recorded later never lands on a token that was rotated in meanwhile.
 */
export function createSealedVercelCredentials(opts: { pool: Pool; kek: KekSource; log?: (line: string) => void }): VercelCredentialResolver {
  const log = opts.log ?? ((line: string) => console.info(line));
  const note = (code: string): VercelCredential => {
    log(JSON.stringify({ event: 'vercel_credentials.unavailable', code }));
    return { status: 'unavailable' };
  };
  return {
    get configured(): boolean {
      try {
        opts.kek.keyFor(opts.kek.currentVersion());
        return true;
      } catch {
        // fx-swallow-ok: an unset or malformed platform key means no connection can be sealed or opened; reported as unconfigured, nothing of the error kept
        return false;
      }
    },
    async resolve(accountId): Promise<VercelCredential> {
      let row: SealedRow | undefined;
      try {
        row = await withTenant(opts.pool, accountId, async (client) => {
          const { rows } = await client.query<SealedRow>(
            `SELECT id, token_ciphertext, token_nonce, wrapped_dek, kek_version, team_id, status FROM vercel_connections WHERE account_id = $1`,
            [accountId],
          );
          return rows[0];
        });
      } catch {
        // fx-swallow-ok: a failed read is "cannot get a credential" (check_unavailable); only a fixed code is logged
        return note('read_error');
      }
      if (!row) return { status: 'unavailable' };
      if (row.status !== 'ok') return { status: 'unavailable' };
      try {
        const token = open(
          { kek: opts.kek.keyFor(row.kek_version), aad: aadFor(accountId, row.id) },
          { ciphertext: row.token_ciphertext, nonce: row.token_nonce, wrappedDek: row.wrapped_dek },
        );
        return { status: 'ok', token, ...(row.team_id !== null ? { teamId: row.team_id } : {}), ref: row.token_nonce.toString('hex') };
      } catch {
        // fx-swallow-ok: a missing KEK version or a seal that does not open fails closed; the error text names key material, so only a fixed code is logged
        return note('open_failed');
      }
    },
    async markRejected(accountId, ref): Promise<void> {
      if (ref === undefined || !/^[0-9a-f]{24}$/.test(ref)) return;
      await withTenant(opts.pool, accountId, (client) =>
        client.query(
          `UPDATE vercel_connections SET status = 'rejected', rejected_at = now()
            WHERE account_id = $1 AND token_nonce = decode($2, 'hex') AND status = 'ok'`,
          [accountId, ref],
        ),
      );
    },
  };
}
