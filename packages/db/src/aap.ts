import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

/**
 * D#7 AAP-d1: the TypeScript half of the Agent Approval Protocol storage (migration 0837). Every write goes through a SECURITY DEFINER
 * function; this file only prepares the inputs (credentials, sealing, size checks) and names the errors. A caller passes a client on a login
 * that is a member of app_user and aap_invoker. Instance-credential calls need no tenant (the definer finds the account from the credential);
 * session calls run inside `withTenant`; provisioner-token calls pass the token and need neither.
 */

type Db = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

export const AAP_LIMITS = Object.freeze({ argumentsBytes: 65536, reasoningBytes: 8192, contextBytes: 8192, noteChars: 1000, deadlineDays: 14 });

const CODES = [
  'unauthenticated', 'not_found', 'already_consumed', 'not_approved', 'approval_expired', 'not_consumed', 'outcome_already_recorded',
  'idempotency_conflict', 'already_decided', 'session_required', 'forbidden', 'invalid_request',
] as const;
export type AapErrorCode = (typeof CODES)[number] | 'sealing_unavailable';

/** A named failure. Branch on `code`; the message is a fixed phrase and never carries a credential or an argument. */
export class AapError extends Error {
  constructor(readonly code: AapErrorCode) {
    super(code);
    this.name = 'AapError';
  }
}

/** Maps a database error to an AapError by the definer's leading name, a CHECK failure to invalid_request; anything else is rethrown. */
async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const e = err as { message?: unknown; code?: unknown };
    const lead = typeof e.message === 'string' ? (/^([a-z_]+):/.exec(e.message)?.[1] ?? '') : '';
    if ((CODES as readonly string[]).includes(lead)) throw new AapError(lead as AapErrorCode);
    if (e.code === '23514') throw new AapError('invalid_request');
    throw err;
  }
}

// ---- credentials ---------------------------------------------------------------------------------------------------------------
export type CredentialKind = 'instance' | 'token';
/** `secret` is shown once and never stored. */
export interface IssuedCredential { secret: string; sha256: string; hint: string }
export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** 32 random bytes, prefixed by kind. Only `sha256` and `hint` (its last four characters) are stored. */
export function issueCredential(kind: CredentialKind): IssuedCredential {
  const secret = `${kind === 'instance' ? 'aapi' : 'aapt'}_${randomBytes(32).toString('base64url')}`;
  return { secret, sha256: sha256Hex(secret), hint: secret.slice(-4) };
}

// ---- sealing -------------------------------------------------------------------------------------------------------------------
/** The same shape as the model-key KEK source (FX_KEK_V<n>); @fx/db cannot import that package, so the reader is repeated here. */
export interface ArgumentsKek {
  currentVersion(): number;
  keyFor(version: number): Buffer;
}
export function envArgumentsKek(env: Readonly<Record<string, string | undefined>> = process.env): ArgumentsKek {
  const current = Number.parseInt(env.FX_KEK_CURRENT_VERSION ?? '1', 10);
  if (!Number.isInteger(current) || current < 1) throw new Error('FX_KEK_CURRENT_VERSION must be a positive integer');
  return {
    currentVersion: () => current,
    keyFor: (version) => {
      const raw = env[`FX_KEK_V${version}`];
      const key = raw ? Buffer.from(raw, 'base64') : Buffer.alloc(0);
      if (key.length !== 32) throw new Error(`FX_KEK_V${version} is not set to 32 base64 bytes`);
      return key;
    },
  };
}
const dataKey = (kek: Buffer): Buffer => Buffer.from(hkdfSync('sha256', kek, Buffer.alloc(0), 'aap_arguments', 32));
const aad = (accountId: string, approvalId: string): Buffer => Buffer.from(`${accountId}:${approvalId}:aap_arguments`, 'utf8');

/** AES-256-GCM under a key derived from the KEK; stored as nonce(12) || ciphertext || tag(16). Bound to the account and the approval. */
export function sealArguments(kek: ArgumentsKek, ids: { accountId: string; approvalId: string }, plaintext: string): { sealed: Buffer; kekVersion: number } {
  const kekVersion = kek.currentVersion();
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', dataKey(kek.keyFor(kekVersion)), nonce);
  c.setAAD(aad(ids.accountId, ids.approvalId));
  return { sealed: Buffer.concat([nonce, c.update(plaintext, 'utf8'), c.final(), c.getAuthTag()]), kekVersion };
}
export function openArguments(kek: ArgumentsKek, ids: { accountId: string; approvalId: string }, sealed: Buffer, kekVersion: number): string {
  if (sealed.length < 28) throw new Error('sealed arguments are shorter than a nonce and a tag');
  const d = createDecipheriv('aes-256-gcm', dataKey(kek.keyFor(kekVersion)), sealed.subarray(0, 12), { authTagLength: 16 });
  d.setAAD(aad(ids.accountId, ids.approvalId));
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([d.update(sealed.subarray(12, sealed.length - 16)), d.final()]).toString('utf8');
}

/** JSON with sorted keys: two requests with the same fields in another order produce the same text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// ---- instances and tokens ------------------------------------------------------------------------------------------------------
/** A provisioner token (sha256 of the presented secret) or, when omitted, the signed-in owner/admin session the client runs under. */
export interface Manager {
  tokenSha256?: string;
}
const tokenArg = (m: Manager): string | null => m.tokenSha256 ?? null;

export async function createToken(db: Db, label: string): Promise<IssuedCredential & { id: string }> {
  const cred = issueCredential('token');
  const { rows } = await call(() => db.query<{ id: string }>('SELECT aap_token_create($1, $2, $3) AS id', [label, cred.sha256, cred.hint]));
  return { ...cred, id: rows[0]!.id };
}
export const revokeToken = (db: Db, id: string): Promise<unknown> => call(() => db.query('SELECT aap_token_revoke($1)', [id]));

export async function createInstance(db: Db, m: Manager, name: string): Promise<IssuedCredential & { id: string }> {
  const cred = issueCredential('instance');
  const { rows } = await call(() => db.query<{ id: string }>('SELECT aap_instance_create($1, $2, $3, $4) AS id', [tokenArg(m), name, cred.sha256, cred.hint]));
  return { ...cred, id: rows[0]!.id };
}
export const renameInstance = (db: Db, m: Manager, id: string, name: string): Promise<unknown> =>
  call(() => db.query('SELECT aap_instance_rename($1, $2, $3)', [tokenArg(m), id, name]));
/** Stops the credential now and cancels the instance's pending approvals. `remove` also starts the 7-day deletion record. */
export const closeInstance = (db: Db, m: Manager, id: string, remove: boolean): Promise<unknown> =>
  call(() => db.query('SELECT aap_instance_close($1, $2, $3)', [tokenArg(m), id, remove]));
export interface InstanceView { id: string; name: string; credentialHint: string; revokedAt: Date | null; deletedAt: Date | null; createdAt: Date }
export async function getInstance(db: Db, m: Manager, id: string): Promise<InstanceView> {
  const { rows } = await call(() => db.query('SELECT * FROM aap_instance_get($1, $2)', [tokenArg(m), id]));
  const r = rows[0]!;
  return { id: r.o_id, name: r.o_name, credentialHint: r.o_credential_hint, revokedAt: r.o_revoked_at, deletedAt: r.o_deleted_at, createdAt: r.o_created_at };
}
export async function authenticateInstance(db: Db, credential: string): Promise<{ instanceId: string; accountId: string }> {
  const { rows } = await call(() => db.query('SELECT * FROM aap_instance_authenticate($1)', [sha256Hex(credential)]));
  return { instanceId: rows[0]!.o_instance_id, accountId: rows[0]!.o_account_id };
}

// ---- requests ------------------------------------------------------------------------------------------------------------------
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
export interface ApprovalView {
  id: string; instanceId: string; accountId: string; tool: string; server: string; status: ApprovalStatus; deadlineAt: Date; expiresAt: Date | null;
  consumedAt: Date | null; outcome: 'succeeded' | 'failed' | null; decidedByKind: 'person' | 'policy' | 'provider' | null; decidedAt: Date | null;
  note: string | null; requestedTimeoutS: number | null; createdAt: Date; replayed: boolean;
}
async function view(db: Db, sql: string, params: unknown[]): Promise<ApprovalView> {
  const { rows } = await call(() => db.query<Record<string, unknown>>(`SELECT * FROM ${sql}`, params));
  // snake_case columns -> camelCase fields, one for one
  return Object.fromEntries(Object.entries(rows[0]!).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), v])) as unknown as ApprovalView;
}

export interface CreateRequestInput {
  tool: string;
  server: string;
  arguments: unknown;
  agentReasoning?: string;
  context?: Record<string, unknown>;
  requestedTimeoutS?: number;
  /** The caller's resolved deadline (the smaller of the requested timeout and the customer's window); at most 14 days ahead. */
  deadlineAt: Date;
  idempotencyKey?: string;
}
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/**
 * Creates a request. Sealing happens here, before the database sees anything: with no usable FX_KEK_V<n> the call is refused with
 * `sealing_unavailable` and nothing is stored. Sizes are checked first so an oversized request never reaches the sealer.
 */
export async function createRequest(db: Db, kek: ArgumentsKek, credential: string, input: CreateRequestInput): Promise<ApprovalView> {
  const argsJson = canonicalJson(input.arguments ?? null);
  const contextJson = input.context === undefined ? null : canonicalJson(input.context);
  if (bytes(argsJson) > AAP_LIMITS.argumentsBytes || bytes(input.agentReasoning ?? '') > AAP_LIMITS.reasoningBytes || (contextJson !== null && bytes(contextJson) > AAP_LIMITS.contextBytes)) {
    throw new AapError('invalid_request');
  }
  const { accountId } = await authenticateInstance(db, credential);
  const approvalId = randomUUID();
  let sealed: { sealed: Buffer; kekVersion: number };
  try {
    sealed = sealArguments(kek, { accountId, approvalId }, argsJson);
  } catch {
    // fx-swallow-ok: the key is missing or malformed; the named refusal below carries no key detail
    throw new AapError('sealing_unavailable');
  }
  const args = [
    sha256Hex(credential), approvalId, input.tool, input.server, sealed.sealed, sealed.kekVersion, sha256Hex(argsJson), bytes(argsJson),
    input.agentReasoning ?? null, contextJson, input.requestedTimeoutS ?? null, input.deadlineAt,
  ];
  if (input.idempotencyKey === undefined) return view(db, 'aap_request_create($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)', args);
  // The key's fingerprint is over the parsed fields (sorted keys), not the bytes the caller sent.
  const fields = canonicalJson({ tool: input.tool, server: input.server, arguments: input.arguments ?? null, agent_reasoning: input.agentReasoning ?? null, context: input.context ?? null, timeout: input.requestedTimeoutS ?? null });
  return view(db, 'aap_request_create_idempotent($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14)', [...args, input.idempotencyKey, sha256Hex(fields)]);
}
export const getRequest = (db: Db, credential: string, id: string): Promise<ApprovalView> => view(db, 'aap_request_get($1, $2, false)', [sha256Hex(credential), id]);
export const cancelRequest = (db: Db, credential: string, id: string): Promise<ApprovalView> => view(db, 'aap_request_get($1, $2, true)', [sha256Hex(credential), id]);
/** At most once, and never after `expiresAt`: `already_consumed`, `not_approved` or `approval_expired` otherwise. */
export const consumeRequest = (db: Db, credential: string, id: string): Promise<ApprovalView> => view(db, 'aap_request_consume($1, $2)', [sha256Hex(credential), id]);
export async function reportOutcome(db: Db, credential: string, id: string, outcome: 'succeeded' | 'failed', note?: string): Promise<void> {
  if (note !== undefined && note.length > AAP_LIMITS.noteChars) throw new AapError('invalid_request');
  await call(() => db.query('SELECT aap_request_outcome($1, $2, $3, $4)', [sha256Hex(credential), id, outcome, note ?? null]));
}
/** A signed-in owner or admin answers (run inside `withTenant` with the user). Approvals stay valid for `validForS` seconds (60 to 48 hours). */
export const decideRequest = (db: Db, id: string, approve: boolean, note: string | null, validForS: number | null): Promise<unknown> =>
  call(() => db.query('SELECT aap_approval_decide($1, $2, $3, $4)', [id, approve, note, validForS]));

/**
 * The arguments of a request, for the people who answer: run inside `withTenant` with the user. Only a signed-in owner or admin of the account
 * gets them (`forbidden` for a member, `session_required` for a token principal, `not_found` for another account's id); app_user cannot read the
 * sealed column directly. `purged` once the 30 days are up, with the hash and byte count that stay.
 */
export async function readArguments(db: Db, kek: ArgumentsKek, id: string): Promise<{ arguments: unknown; sha256: string; bytes: number } | { purged: true; sha256: string; bytes: number }> {
  const { rows } = await call(() => db.query('SELECT * FROM aap_arguments_get($1)', [id]));
  const r = rows[0]!;
  if (r.o_sealed === null) return { purged: true, sha256: r.o_sha256, bytes: r.o_bytes };
  return { arguments: JSON.parse(openArguments(kek, { accountId: r.o_account_id, approvalId: id }, r.o_sealed, r.o_kek_version)), sha256: r.o_sha256, bytes: r.o_bytes };
}

export interface AapSweepResult { expired: number; argumentsPurged: number; idempotencyPurged: number; instancesPurged: number }
/** The worker tick's housekeeping (cross-tenant), run by the sweep login. The database's own clock decides what is due; there is no time argument. */
export async function sweepAap(db: Db, limit = 200): Promise<AapSweepResult> {
  const { rows } = await db.query('SELECT * FROM aap_sweep($1)', [limit]);
  const r = rows[0]!;
  return { expired: r.o_expired, argumentsPurged: r.o_arguments_purged, idempotencyPurged: r.o_idempotency_purged, instancesPurged: r.o_instances_purged };
}
