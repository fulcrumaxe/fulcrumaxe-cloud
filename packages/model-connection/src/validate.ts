import type { Pool, PoolClient } from 'pg';
import { withTenant } from '@fx/db/src/withTenant.js';
import { withPlatformOps } from '@fx/core/src/tenancy/withPlatformOps.js';
import { getMemberRole } from '@fx/core/src/tenancy/authorize.js';
import { emitDomainEvent } from '@fx/core/src/domain-events/emit.js';
import { NotFoundError } from './errors.js';
import { markBrokenWithClient, type BrokenConnectionCode } from './markBroken.js';
import type { KekSource } from './kek.js';
import { open, type Sealed } from './crypto.js';
import type { ValidationHttpClient, ValidationOutcome } from './httpClient.js';
import { buildAad, type ModelConnectionCtx, type Provider } from './types.js';

interface LockedRow {
  id: string;
  provider: Provider;
  key_nonce: Buffer;
}

/**
 * D#2 fix round 3, R1: how long a platform_ops transaction in this file
 * may wait to acquire the row's `FOR UPDATE` lock, and how long it may
 * then sit idle inside that open transaction, before Postgres kills it
 * itself. Defense-in-depth, not the actual fix -- the actual fix is that
 * neither function below ever borrows a SECOND pool connection while
 * holding this lock anymore (see lockConnectionRow's and test()'s own
 * comments). These two timeouts exist for whatever this file's own review
 * missed: with them, a stuck holder fails loudly and releases the row
 * within seconds instead of wedging it (and a limited-size pool behind
 * it) indefinitely. Session-scoped GUCs, applied via `SET LOCAL` so they
 * revert automatically at COMMIT/ROLLBACK -- same mechanism
 * @fx/db's withTenant.ts uses for app.account_id/app.user_id.
 */
const LOCK_TIMEOUT_MS = 5_000;
const IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS = 10_000;

async function applyStuckHolderTimeouts(client: PoolClient): Promise<void> {
  await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
  await client.query(`SET LOCAL idle_in_transaction_session_timeout = '${IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS}ms'`);
}

/**
 * TOCTOU fix: locks the model_connections row `FOR UPDATE` as
 * platform_ops, reading `key_nonce` in the same statement. Works even
 * though platform_ops's column-level SELECT grant otherwise excludes key
 * material (0003_spend_security_fixes.sql, round-5 finding 1): a Postgres
 * row lock applies to the ROW, not the columns named in the SELECT list,
 * and 0006_model_connections_key_nonce_grant.sql (D#2 fix round 3, R1)
 * adds exactly one more column-scoped grant -- key_nonce, a 12-byte GCM
 * nonce that carries no information about the key it encrypts, unlike
 * key_ciphertext/wrapped_dek which stay off limits.
 *
 * `key_nonce` is what callers now re-check to detect a rotation that
 * landed after they read/validated a key (see recordInitialValidation and
 * test() below) -- W1 (fix round 3): the 4-hex-character key_fingerprint
 * this used to compare is a 16-bit truncated HMAC meant for DISPLAY only
 * (D#31 criterion 4), far too collision-prone to gate a security check on.
 * key_nonce is fresh random bytes on every seal() and never repeats
 * across a rotation, so comparing it end-to-end is the correct check.
 */
async function lockConnectionRow(client: PoolClient, accountId: string): Promise<LockedRow> {
  const { rows } = await client.query<LockedRow>(
    `SELECT id, provider, key_nonce FROM model_connections WHERE account_id = $1 FOR UPDATE`,
    [accountId],
  );
  const row = rows[0];
  if (!row) {
    throw new NotFoundError(`model_connections: no connection for account ${accountId}`);
  }
  return row;
}

/**
 * The only place this package writes status/last_validated_at/
 * last_error_code. Requires an already-open platform_ops client whose
 * transaction already holds this row's lock (lockConnectionRow) -- does
 * not lock anything itself. On 'ok', also clears `accounts.key_broken_at`
 * (criterion 5).
 *
 * D#69 (migration 0606): writes `key_broken_at` instead of `accounts.status`
 * directly, same reasoning as markBroken.ts's own comment -- the
 * unconditional clear/set here never lifts or masks a platform hold, a
 * partner suspension, or an owner pause, since key_broken_at ranks below
 * every one of those pause markers in the derivation priority (it ranks
 * ABOVE past_due_since, fix round 2 MUST-fix 1, so clearing it on 'ok'
 * can surface a `past_due` account if one is genuinely still within its
 * grace window underneath -- that's correct, not a mask).
 */
async function writeOutcome(
  client: PoolClient,
  accountId: string,
  connectionId: string,
  outcome: ValidationOutcome,
): Promise<void> {
  await writeOutcomeRows(client, accountId, connectionId, outcome);
  // Onboarding step 1 follows whether a working key exists, so an open window must re-read after every
  // outcome. Same transaction as the status write; the payload is a fixed word.
  await emitDomainEvent(client, {
    type: 'model_connection.changed',
    accountId,
    subjectId: connectionId,
    payload: { state: outcome.kind === 'ok' ? 'ok' : outcome.kind === 'rejected' ? 'broken' : 'unvalidated' },
  });
}

async function writeOutcomeRows(
  client: PoolClient,
  accountId: string,
  connectionId: string,
  outcome: ValidationOutcome,
): Promise<void> {
  if (outcome.kind === 'ok') {
    await client.query(
      `UPDATE model_connections
         SET status = 'ok', last_validated_at = now(), last_error_code = NULL, health_strikes = 0
       WHERE id = $1`,
      [connectionId],
    );
    await client.query(`UPDATE accounts SET key_broken_at = NULL WHERE id = $1`, [accountId]);
    return;
  }

  if (outcome.kind === 'rejected') {
    await client.query(
      `UPDATE model_connections
         SET status = 'broken', last_error_code = $2
       WHERE id = $1`,
      [connectionId, outcome.code],
    );
    await client.query(
      `UPDATE accounts SET key_broken_at = COALESCE(key_broken_at, now()) WHERE id = $1`,
      [accountId],
    );
    return;
  }

  // network_error: "unvalidated and not usable" -- record the error code
  // but leave status alone (never forced to 'ok' or demoted to 'broken'
  // for one unreachable attempt).
  await client.query(
    `UPDATE model_connections SET last_error_code = $2 WHERE id = $1`,
    [connectionId, outcome.code],
  );
}

interface SealedRow extends Sealed {
  id: string;
  provider: Provider;
  key_nonce: Buffer;
  kek_version: number;
}

/**
 * Reads the account's sealed key as app_user (tenant-scoped) and opens it. The plaintext lives only in the returned
 * local, for one validation call. Throws NotFoundError when the account has no connection.
 */
async function readAndOpenKey(
  pool: Pool,
  kek: KekSource,
  accountId: string,
): Promise<{ encrypted: SealedRow; plaintextKey: string }> {
  const encrypted = await withTenant(pool, accountId, async (client) => {
    const { rows } = await client.query<SealedRow>(
      `SELECT id, provider, key_ciphertext AS ciphertext, key_nonce, wrapped_dek AS "wrappedDek", kek_version
         FROM model_connections WHERE account_id = $1`,
      [accountId],
    );
    return rows[0] ?? null;
  });
  if (!encrypted) {
    throw new NotFoundError(`model_connections: no connection for account ${accountId}`);
  }
  const kekBytes = kek.keyFor(encrypted.kek_version);
  const aad = buildAad(accountId, encrypted.id);
  const plaintextKey = open(
    { kek: kekBytes, aad },
    { ciphertext: encrypted.ciphertext, nonce: encrypted.key_nonce, wrappedDek: encrypted.wrappedDek },
  );
  return { encrypted, plaintextKey };
}

/**
 * D#31 comment 18494573 (C6-1): the public `test(ctx)` export.
 * Re-validates the account's stored key: decrypts it (tenant-scoped,
 * criterion 7) and runs it through `ctx.httpClient` (criterion 3) -- the
 * plaintext key exists only in local variables, for one HTTP call, never
 * logged, returned, or written anywhere. Any active member (not just
 * owner|admin -- criterion 6 doesn't gate this one) may trigger a
 * revalidation; a non-member gets NotFoundError, the same "wrong tenant"
 * shape as getStatus().
 *
 * D#2 fix round 3, R1: this used to take the platform_ops row lock FIRST
 * and read/decrypt the key material through a SEPARATELY BORROWED
 * app_user connection while still holding that lock -- exactly the
 * lock-then-borrow shape that can deadlock the shared pool under
 * concurrency (enough callers each holding their own row lock while
 * waiting on an app_user connection, and every app_user connection
 * blocked on one of those same row locks). Restructured to
 * read-then-validate-then-lock, the same order connect()/
 * recordInitialValidation already used: the app_user read below happens
 * BEFORE any platform_ops transaction opens, so nothing here ever holds
 * one pool's connection while waiting on the other's.
 *
 * The tradeoff: a rotation landing between the read below and the final
 * lock is no longer BLOCKED until this call finishes (the old row lock
 * doesn't exist yet to block it on). Instead, the row lock at the end
 * re-checks the row's live `id` AND `key_nonce` against what was just
 * read/validated (same pin recordInitialValidation uses) and skips the
 * write if either changed -- the safety invariant that actually matters
 * (never leave `status = 'ok'` attached to a key this call didn't
 * validate) is unaffected; only the concurrency shape around it changed.
 */
export async function test(ctx: ModelConnectionCtx): Promise<ValidationOutcome> {
  const { accountId, userId } = ctx.principal;
  const role = await getMemberRole(ctx.pool, accountId, userId);
  if (role === null) {
    throw new NotFoundError(`model_connections: no connection for account ${accountId}`);
  }

  const { encrypted, plaintextKey } = await readAndOpenKey(ctx.pool, ctx.kek, accountId);
  const outcome = await ctx.httpClient.validate({ provider: encrypted.provider, plaintextKey });

  await withPlatformOps(ctx.platformOpsPool, async (opsClient) => {
    await applyStuckHolderTimeouts(opsClient);
    const locked = await lockConnectionRow(opsClient, accountId);
    if (locked.id !== encrypted.id || !locked.key_nonce.equals(encrypted.key_nonce)) {
      // The row was replaced (a fresh first-connect race) or rotated to a
      // different key since we read/validated it above -- this outcome
      // belongs to a key nobody can reach anymore. Skip rather than write,
      // same as recordInitialValidation.
      return;
    }
    await writeOutcome(opsClient, accountId, locked.id, outcome);
  });

  return outcome;
}

/**
 * Records the outcome of the validation connect() already ran (only
 * ever called for 'ok'/'network_error', never 'rejected' -- criterion
 * 3's "nothing stored").
 *
 * Security review finding 4 (TOCTOU, CWE-367): connect() commits its
 * tenant write and THEN calls this -- in the gap between those two
 * steps a concurrent rotation (a second admin's connect()) can change
 * which key is stored under this account's row. Without a check, this
 * function would take the row lock, find whatever key is there NOW, and
 * attach connect()'s outcome to it -- an "ok" that key was never
 * actually validated for. `connectionId`/`nonce` pin this call to
 * the EXACT row/key connect() wrote:
 *   - if the row this account now points at isn't `connectionId`
 *     anymore (e.g. an unlocked first-connect race left more than one
 *     row and lockConnectionRow's own SELECT picked a different one),
 *     there is nothing safe to write to -- skip.
 *   - re-read `key_nonce` under the SAME platform_ops connection this
 *     function already holds the row lock on (lockConnectionRow's own
 *     SELECT ... FOR UPDATE now includes it --
 *     0006_model_connections_key_nonce_grant.sql, D#2 fix round 3 R1). If
 *     it no longer matches the nonce `seal()` generated when connect()
 *     wrote this row, the key was rotated after connect() validated it,
 *     and this outcome belongs to a key nobody can reach anymore -- skip
 *     rather than write.
 *
 * D#2 fix round 3, R1: this used to re-read `key_fingerprint` through a
 * SEPARATELY BORROWED app_user connection (withTenant) while still
 * holding the platform_ops row lock -- exactly the lock-then-borrow
 * shape that can deadlock the shared pool under concurrency. Re-reading
 * `key_nonce` through the SAME connection the lock is already on removes
 * the second pool entirely from this function: nothing here ever borrows
 * one pool's connection while holding the other's. W1 (same fix round):
 * `key_fingerprint` is also the wrong marker on its own terms -- a
 * 4-hex-character (16-bit) truncated HMAC meant for DISPLAY only (D#31
 * criterion 4), far too collision-prone to gate a security check on.
 * `key_nonce` (fresh random bytes on every seal(), never repeated across
 * a rotation) is what this now compares.
 */
export async function recordInitialValidation(
  ctx: ModelConnectionCtx,
  connectionId: string,
  nonce: Buffer,
  outcome: Exclude<ValidationOutcome, { kind: 'rejected' }>,
): Promise<void> {
  await withPlatformOps(ctx.platformOpsPool, async (opsClient) => {
    await applyStuckHolderTimeouts(opsClient);
    const locked = await lockConnectionRow(opsClient, ctx.principal.accountId);
    if (locked.id !== connectionId || !locked.key_nonce.equals(nonce)) {
      return;
    }

    await writeOutcome(opsClient, ctx.principal.accountId, locked.id, outcome);
  });
}

/**
 * What the health job needs: the same four dependencies as a ModelConnectionCtx, with no principal. The job is the
 * platform acting on every account, not a member acting on their own.
 */
export interface HealthCheckCtx {
  /** app_user pool: the sealed key is read through withTenant. */
  pool: Pool;
  /** platform_ops pool: the only role that writes status or strikes. */
  platformOpsPool: Pool;
  httpClient: ValidationHttpClient;
  kek: KekSource;
}

/** What one health check did to the row, for the job's own accounting. Never carries the key or a provider message. */
export type HealthCheckResult =
  | { action: 'cleared' }
  | { action: 'strike' }
  | { action: 'broken' }
  | { action: 'unchanged' }
  | { action: 'skipped' };

/**
 * H2e's entry point (D#454 C1): checks one account's stored key once. Same shape as test() -- read the sealed key
 * through withTenant, open it, make ONE validation call, then take the row lock and re-check `id` and `key_nonce` so a
 * key rotated or replaced meanwhile gets no write at all (strikes included) -- without the member-role check.
 *
 *  - ok: the existing writeOutcome ok path (clears key_broken_at, health_strikes, emits `changed`).
 *  - rejected: first one is a strike and nothing else changes; a second marks the key broken (status, last_error_code,
 *    key_broken_at, and `model_connection.changed` with state broken, all in this transaction). A connection that is
 *    already broken is left alone, so a daily check does not re-announce it.
 *  - network_error (5xx, 429, timeout, a gateway 403): nothing is written. Strikes are neither added nor reset.
 *
 * Returns null when the account has no connection, or when `connectionId` is given and is not the row found.
 */
export async function healthCheck(
  ctx: HealthCheckCtx,
  accountId: string,
  connectionId?: string,
): Promise<HealthCheckResult | null> {
  let read: Awaited<ReturnType<typeof readAndOpenKey>>;
  try {
    read = await readAndOpenKey(ctx.pool, ctx.kek, accountId);
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
  const { encrypted, plaintextKey } = read;
  if (connectionId !== undefined && encrypted.id !== connectionId) return null;

  const outcome = await ctx.httpClient.validate({ provider: encrypted.provider, plaintextKey });

  return withPlatformOps(ctx.platformOpsPool, async (opsClient): Promise<HealthCheckResult> => {
    await applyStuckHolderTimeouts(opsClient);
    const locked = await lockConnectionRow(opsClient, accountId);
    if (locked.id !== encrypted.id || !locked.key_nonce.equals(encrypted.key_nonce)) {
      // Rotated or replaced since the read: this outcome belongs to a key nobody can reach anymore.
      return { action: 'skipped' };
    }
    if (outcome.kind === 'network_error') {
      return { action: 'unchanged' };
    }
    if (outcome.kind === 'ok') {
      await writeOutcome(opsClient, accountId, locked.id, outcome);
      return { action: 'cleared' };
    }

    const { rows } = await opsClient.query<{ health_strikes: number; status: string }>(
      `SELECT health_strikes, status FROM model_connections WHERE id = $1`,
      [locked.id],
    );
    const row = rows[0];
    if (!row) return { action: 'skipped' };
    if (row.health_strikes < 1) {
      await opsClient.query(`UPDATE model_connections SET health_strikes = 1 WHERE id = $1`, [locked.id]);
      return { action: 'strike' };
    }
    if (row.status === 'broken') return { action: 'unchanged' };
    await markBrokenWithClient(opsClient, accountId, Number(outcome.code) as BrokenConnectionCode);
    await emitDomainEvent(opsClient, {
      type: 'model_connection.changed',
      accountId,
      subjectId: locked.id,
      payload: { state: 'broken' },
    });
    return { action: 'broken' };
  });
}
