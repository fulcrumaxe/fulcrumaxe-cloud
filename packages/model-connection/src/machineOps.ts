import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTenant } from '@fx/db/src/withTenant.js';
import { getMemberRole, requireOwnerOrAdmin } from '@fx/core/src/tenancy/authorize.js';
import { open, openBytes, seal } from './crypto.js';
import { parseKek32 } from './kekFormat.js';
import type { KekSource } from './kek.js';
import { buildAad, type Principal } from './types.js';

/**
 * D#845 MC-2: the person's Hetzner Cloud token, sealed, and the one reader of it. This file is the `machine_ops` code path: it is the only code that reads
 * `FX_MACHINE_KEK_V1`, the only caller of the database's `machine_credential_use`, and the only writer of `server.unsealed`
 * (test/machineOps.static.test.ts holds all three). The token enters in `connectHetznerCredential`, is checked with Hetzner, and is sealed under the
 * machine KEK with AAD `account:row:hetzner_token`. It leaves only through `withHetznerToken` and `withManagedServer`, inside a callback, for one call.
 * Every error is fixed text and a code from {@link MachineOpsErrorCode}; no response, log line or audit row carries the token.
 */
export const HETZNER_TOKEN_PURPOSE = 'hetzner_token';
const PROVIDER = 'hetzner_cloud';
/** Hetzner issues 64 letters and digits. */
const TOKEN_RE = /^[A-Za-z0-9]{64}$/;

export type MachineOpsErrorCode =
  | 'machine_kek_unset'
  | 'not_configured'
  | 'invalid_token_format'
  | 'token_invalid'
  | 'token_read_only'
  | 'provider_unreachable'
  | 'already_connected'
  | 'not_connected'
  | 'credential_invalid'
  | 'server_not_managed'
  | 'unseal_failed';

const MESSAGES: Record<MachineOpsErrorCode, string> = {
  machine_kek_unset: 'Hetzner Cloud servers are not available right now',
  not_configured: 'Hetzner Cloud servers are not available right now',
  invalid_token_format: 'the token is not in a form Hetzner issues',
  token_invalid: 'Hetzner did not accept the token',
  token_read_only: 'the token is read-only; create a Read & Write token',
  provider_unreachable: 'Hetzner could not be reached to check the token',
  already_connected: 'a Hetzner token is already connected; remove it first',
  not_connected: "can't reach Hetzner: no token",
  credential_invalid: 'Hetzner no longer accepts the stored token; remove it and add a new one',
  server_not_managed: 'that server is not one of this account\'s managed servers',
  unseal_failed: 'the stored token could not be opened',
};

export class MachineOpsError extends Error {
  constructor(public readonly code: MachineOpsErrorCode) {
    super(MESSAGES[code]);
    this.name = 'MachineOpsError';
  }
}

/**
 * The machine KEK: `FX_MACHINE_KEK_V1` alone, never the model-connection KEK, so a missing machine key never falls back to another one. Version 1 is the only
 * version; a row sealed under any other is refused. A missing or malformed key is `machine_kek_unset` (fail closed), with nothing of the value in the error.
 */
export function machineKekSource(env: Readonly<Record<string, string | undefined>> = process.env): KekSource {
  return {
    currentVersion: () => 1,
    keyFor: (version: number): Buffer => {
      const key = parseKek32(env.FX_MACHINE_KEK_V1);
      if (version !== 1 || !key) throw new MachineOpsError('machine_kek_unset');
      return key;
    },
  };
}

/**
 * D#845 MC-8a: the Claude sign-in link and the one-time code, each sealed into one blob (`version || nonce || wrapped key || ciphertext`) under the machine KEK. The AAD binds the account, the
 * request, the runner and the purpose (`account:request:runner:purpose`), so a blob copied to another request, runner or purpose, or another account's, fails to open. The caller holds the
 * returned object and gives plaintext to nothing but its own response to the person (the link) or the runner's one fetch (the code). Errors are fixed codes of {@link MachineOpsError}.
 */
export interface MachineLoginIds {
  accountId: string;
  requestId: string;
  runnerId: string;
}
export type MachineLoginPurpose = 'auth_url' | 'code';
export interface MachineLoginSealer {
  seal(ids: MachineLoginIds, purpose: MachineLoginPurpose, plaintext: string): Buffer;
  open(ids: MachineLoginIds, purpose: MachineLoginPurpose, blob: Buffer): string;
}
/** The blob's layout: one format byte, the four-byte KEK version that wrapped it (so a rotation opens old blobs under the key that sealed them), the nonce, the wrapped key and the ciphertext. */
const LOGIN_BLOB_FORMAT = 1;
const KEK_VERSION_BYTES = 4;
const NONCE_BYTES = 12;
const WRAPPED_DEK_BYTES = 60;
const HEADER_BYTES = 1 + KEK_VERSION_BYTES;
const loginAad = (ids: MachineLoginIds, purpose: MachineLoginPurpose): Buffer => Buffer.from(`${ids.accountId}:${ids.requestId}:${ids.runnerId}:claude_login_${purpose}`, 'utf8');

export function createMachineLoginSealer(kek: KekSource = machineKekSource()): MachineLoginSealer {
  return {
    seal(ids, purpose, plaintext) {
      const version = kek.currentVersion();
      const sealed = seal({ kek: keyOrThrow(kek, version), aad: loginAad(ids, purpose) }, plaintext);
      const header = Buffer.alloc(HEADER_BYTES);
      header[0] = LOGIN_BLOB_FORMAT;
      header.writeUInt32BE(version, 1);
      return Buffer.concat([header, sealed.nonce, sealed.wrappedDek, sealed.ciphertext]);
    },
    open(ids, purpose, blob) {
      if (blob.length < HEADER_BYTES + NONCE_BYTES + WRAPPED_DEK_BYTES + 16 || blob[0] !== LOGIN_BLOB_FORMAT) throw new MachineOpsError('unseal_failed');
      const version = blob.readUInt32BE(1);
      // A version of 0 is never written; any other the source does not hold answers as an unset key, and one it holds under another key fails the cipher below. Both are fixed codes.
      if (version === 0) throw new MachineOpsError('unseal_failed');
      const key = keyOrThrow(kek, version);
      const body = blob.subarray(HEADER_BYTES);
      try {
        return open({ kek: key, aad: loginAad(ids, purpose) }, { nonce: body.subarray(0, NONCE_BYTES), wrappedDek: body.subarray(NONCE_BYTES, NONCE_BYTES + WRAPPED_DEK_BYTES), ciphertext: body.subarray(NONCE_BYTES + WRAPPED_DEK_BYTES) });
      } catch {
        // fx-swallow-ok: a blob that does not open (tampered, moved to another request, runner, purpose or account, wrong key) fails closed; the cipher error names key material, so only a fixed code is kept
        throw new MachineOpsError('unseal_failed');
      }
    },
  };
}

/**
 * D#845 MC-9b2: one chunk of the engine's state tar, sealed under the machine KEK with the AAD `account:carry:index`, so a chunk copied to another account, carry or place fails to open. The parts are the columns the
 * carry table keeps (the KEK version that wrapped the key, the nonce, the wrapped key, the ciphertext). The chunk is bytes, never logged, audited or put in an error: failures are fixed codes of {@link MachineOpsError}.
 */
export interface StateCarryChunkIds {
  accountId: string;
  carryId: string;
  index: number;
}
export interface SealedStateChunk {
  kekVersion: number;
  nonce: Buffer;
  wrappedDek: Buffer;
  ciphertext: Buffer;
}
export interface StateCarrySealer {
  seal(ids: StateCarryChunkIds, plaintext: Uint8Array): SealedStateChunk;
  open(ids: StateCarryChunkIds, sealed: SealedStateChunk): Buffer;
}
const carryAad = (ids: StateCarryChunkIds): Buffer => Buffer.from(`${ids.accountId.toLowerCase()}:${ids.carryId.toLowerCase()}:${ids.index}`, 'utf8');

export function createStateCarrySealer(kek: KekSource = machineKekSource()): StateCarrySealer {
  return {
    seal(ids, plaintext) {
      const kekVersion = kek.currentVersion();
      const sealed = seal({ kek: keyOrThrow(kek, kekVersion), aad: carryAad(ids) }, plaintext);
      return { kekVersion, ...sealed };
    },
    open(ids, sealed) {
      if (!Number.isInteger(sealed.kekVersion) || sealed.kekVersion < 1) throw new MachineOpsError('unseal_failed');
      const key = keyOrThrow(kek, sealed.kekVersion);
      try {
        return openBytes({ kek: key, aad: carryAad(ids) }, sealed);
      } catch {
        // fx-swallow-ok: a chunk that does not open (tampered, moved to another account, carry or place, wrong key) fails closed; the cipher error names key material, so only a fixed code is kept
        throw new MachineOpsError('unseal_failed');
      }
    },
  };
}

export type HetznerProbeResult = { verdict: 'ok'; unlabelledServers: number } | { verdict: 'invalid' | 'read_only' | 'unreachable' };
/** Asks Hetzner what a token can do (read, write, how many servers are not ours). Production: `createHetznerCredentialProbe` from `@fx/hetzner`. */
export interface HetznerTokenProbe {
  check(token: string): Promise<HetznerProbeResult>;
}

export interface MachineOpsCtx {
  pool: Pool;
  principal: Principal;
  kek: KekSource;
}
export interface ConnectCtx extends MachineOpsCtx {
  probe: HetznerTokenProbe;
}

/** The only shape a caller sees: a four-character tail, never the token or a sealed column. */
export interface HetznerCredentialView {
  id: string;
  status: 'ok' | 'invalid';
  token_hint: string;
  /** How many servers in the Hetzner project are not ours: shown as a warning, never acted on. */
  unlabelled_server_count: number;
  created_at: Date;
}

const authorize = async (ctx: MachineOpsCtx): Promise<void> => requireOwnerOrAdmin(await getMemberRole(ctx.pool, ctx.principal.accountId, ctx.principal.userId));
const aadFor = (accountId: string, rowId: string): Buffer => buildAad(accountId, rowId, HETZNER_TOKEN_PURPOSE);
const keyOrThrow = (kek: KekSource, version: number): Buffer => {
  try {
    return kek.keyFor(version);
  } catch {
    // fx-swallow-ok: an unset or malformed machine key means nothing can be sealed or opened; reported by a fixed code, nothing of the error kept
    throw new MachineOpsError('machine_kek_unset');
  }
};

/**
 * Connects the Hetzner token. Owner or admin only. Order: the machine key must be set; the format; the account must not already hold a token; then Hetzner is
 * asked (a read, a write probe, a count of foreign servers) BEFORE anything is sealed or written, so a refused or unproven token leaves no trace. A 401 is
 * `token_invalid`, a 403 on the write probe is `token_read_only`, anything unclear is `provider_unreachable`.
 */
export async function connectHetznerCredential(ctx: ConnectCtx, input: { token: string }): Promise<HetznerCredentialView> {
  const { accountId, userId } = ctx.principal;
  await authorize(ctx);
  const kekVersion = ctx.kek.currentVersion();
  const kek = keyOrThrow(ctx.kek, kekVersion);
  if (!TOKEN_RE.test(input.token)) throw new MachineOpsError('invalid_token_format');
  const active = () => withTenant(ctx.pool, accountId, userId, async (c) => (await c.query(`SELECT 1 FROM machine_provider_credentials WHERE account_id = $1 AND provider = $2 AND removed_at IS NULL`, [accountId, PROVIDER])).rowCount ?? 0);
  if (await active()) throw new MachineOpsError('already_connected');
  const result = await ctx.probe.check(input.token);
  if (result.verdict === 'invalid') throw new MachineOpsError('token_invalid');
  if (result.verdict === 'read_only') throw new MachineOpsError('token_read_only');
  if (result.verdict !== 'ok') throw new MachineOpsError('provider_unreachable');

  const id = randomUUID();
  const sealed = seal({ kek, aad: aadFor(accountId, id) }, input.token);
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    const { rows } = await client.query<{ id: string; status: 'ok' | 'invalid'; token_hint: string; created_at: Date }>(
      `INSERT INTO machine_provider_credentials (id, account_id, provider, ciphertext, nonce, wrapped_dek, kek_version, token_hint, last_checked_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9)
       ON CONFLICT (account_id, provider) WHERE removed_at IS NULL DO NOTHING RETURNING id, status, token_hint, created_at`,
      [id, accountId, PROVIDER, sealed.ciphertext, sealed.nonce, sealed.wrappedDek, kekVersion, input.token.slice(-4), userId],
    );
    if (!rows[0]) throw new MachineOpsError('already_connected');
    await client.query(`SELECT audit_write('machine_credential.added', $1::jsonb)`, [JSON.stringify({ credential_id: id, provider: PROVIDER })]);
    return { ...rows[0], unlabelled_server_count: result.unlabelledServers };
  });
}

/** Removes the stored token: the ciphertext, nonce and wrapped key become NULL. The account's servers stay (their rows are untouched); they read "can't reach Hetzner: no token". */
export async function removeHetznerCredential(ctx: MachineOpsCtx): Promise<void> {
  const { accountId, userId } = ctx.principal;
  await authorize(ctx);
  await withTenant(ctx.pool, accountId, userId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `UPDATE machine_provider_credentials SET ciphertext = NULL, nonce = NULL, wrapped_dek = NULL, removed_at = now(), removed_by = $3
        WHERE account_id = $1 AND provider = $2 AND removed_at IS NULL RETURNING id`,
      [accountId, PROVIDER, userId],
    );
    if (!rows[0]) throw new MachineOpsError('not_connected');
    await client.query(`SELECT audit_write('machine_credential.removed', $1::jsonb)`, [JSON.stringify({ credential_id: rows[0].id, provider: PROVIDER })]);
  });
}

interface Target {
  /** Hetzner's own server id; refused unless it is one of this account's managed servers. */
  providerServerId?: string;
}
export interface ManagedServerRef {
  /** managed_servers.id */
  serverId: string;
  providerServerId: string;
}

/**
 * Reads, opens and audits the token in ONE transaction, then ends it and hands the token to `use` (so no database lock is held over the Hetzner call).
 * `server.unsealed` is written here, before the sealed columns are read, so no caller can skip it and none writes it; a failure to write it, to read the
 * row or to open the seal rolls the whole transaction back and `use` is never called. The row holds ids and enums only.
 */
async function withToken<T>(ctx: MachineOpsCtx, target: Target, use: (token: string, server: ManagedServerRef | null) => Promise<T>): Promise<T> {
  const { accountId, userId } = ctx.principal;
  await authorize(ctx);
  keyOrThrow(ctx.kek, ctx.kek.currentVersion());
  if (target.providerServerId !== undefined && !/^[0-9]{1,20}$/.test(target.providerServerId)) throw new MachineOpsError('server_not_managed');
  const opened = await withTenant(ctx.pool, accountId, userId, async (client: PoolClient) => {
    let server: ManagedServerRef | null = null;
    let credentialId: string;
    if (target.providerServerId !== undefined) {
      // Refused here, before the seal is read and before any Hetzner call, unless this account made the server and has not deleted it.
      const { rows } = await client.query<{ id: string; credential_id: string }>(
        `SELECT id, credential_id FROM managed_servers WHERE account_id = $1 AND provider_server_id = $2 AND status <> 'deleted'`,
        [accountId, target.providerServerId],
      );
      if (!rows[0]) throw new MachineOpsError('server_not_managed');
      server = { serverId: rows[0].id, providerServerId: target.providerServerId };
      credentialId = rows[0].credential_id;
    } else {
      const { rows } = await client.query<{ id: string }>(`SELECT id FROM machine_provider_credentials WHERE account_id = $1 AND provider = $2 AND removed_at IS NULL`, [accountId, PROVIDER]);
      if (!rows[0]) throw new MachineOpsError('not_connected');
      credentialId = rows[0].id;
    }
    const state = await client.query<{ status: string }>(`SELECT status FROM machine_provider_credentials WHERE account_id = $1 AND id = $2 AND removed_at IS NULL`, [accountId, credentialId]);
    if (!state.rows[0]) throw new MachineOpsError('not_connected');
    if (state.rows[0].status !== 'ok') throw new MachineOpsError('credential_invalid');
    await client.query(`SELECT audit_write('server.unsealed', $1::jsonb)`, [JSON.stringify({ credential_id: credentialId, purpose: HETZNER_TOKEN_PURPOSE, ...(server ? { server_id: server.serverId } : {}) })]);
    const sealed = await client.query<{ o_ciphertext: Buffer; o_nonce: Buffer; o_wrapped_dek: Buffer; o_kek_version: number }>(`SELECT o_ciphertext, o_nonce, o_wrapped_dek, o_kek_version FROM machine_credential_use($1)`, [credentialId]);
    if (!sealed.rows[0]) throw new MachineOpsError('not_connected');
    const row = sealed.rows[0];
    try {
      const token = open({ kek: keyOrThrow(ctx.kek, row.o_kek_version), aad: aadFor(accountId, credentialId) }, { ciphertext: row.o_ciphertext, nonce: row.o_nonce, wrappedDek: row.o_wrapped_dek });
      return { token, credentialId, server };
    } catch (err) {
      if (err instanceof MachineOpsError) throw err;
      // fx-swallow-ok: a seal that does not open (tampered, moved to another row or account, wrong key) fails closed; the cipher error names key material, so only a fixed code is kept
      throw new MachineOpsError('unseal_failed');
    }
  });
  try {
    return await use(opened.token, opened.server);
  } catch (err) {
    if (isTokenRefused(err)) await markInvalid(ctx, opened.credentialId);
    throw err;
  }
}

/** Hetzner answered 401 (a `HetznerError` or a `MachineProviderError`; the 403 of a read-only token is a different answer and does not mark it). */
function isTokenRefused(err: unknown): boolean {
  const e = err as { code?: unknown; status?: unknown; extra?: { status?: unknown } } | null;
  return typeof e === 'object' && e !== null && e.code === 'unauthorized' && (e.extra?.status ?? e.status) === 401;
}

async function markInvalid(ctx: MachineOpsCtx, credentialId: string): Promise<void> {
  const { accountId, userId } = ctx.principal;
  await withTenant(ctx.pool, accountId, userId, (client) =>
    client.query(`UPDATE machine_provider_credentials SET status = 'invalid', last_checked_at = now() WHERE account_id = $1 AND id = $2 AND removed_at IS NULL`, [accountId, credentialId]),
  );
}

/** For a call that names no server (a quote, a create, a list): the account's token, for the callback only. */
export function withHetznerToken<T>(ctx: MachineOpsCtx, use: (token: string) => Promise<T>): Promise<T> {
  return withToken(ctx, {}, (token) => use(token));
}

/** For a call on a server id: refused with `server_not_managed`, before the seal is read and before any Hetzner call, unless the id is one of this account's `managed_servers`. */
export function withManagedServer<T>(ctx: MachineOpsCtx, providerServerId: string, use: (token: string, server: ManagedServerRef) => Promise<T>): Promise<T> {
  return withToken(ctx, { providerServerId }, (token, server) => use(token, server!));
}
