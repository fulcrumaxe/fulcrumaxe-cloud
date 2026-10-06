import { randomUUID } from 'node:crypto';
import { withTenant } from '@fx/db/src/withTenant.js';
import { getMemberRole, requireOwnerOrAdmin } from '@fx/core/src/tenancy/authorize.js';
import { InvalidModelKeyError } from './errors.js';
import { fingerprintOf, seal } from './crypto.js';
import { recordInitialValidation } from './validate.js';
import { getStatus } from './summary.js';
import {
  buildAad,
  isAnthropicProviderEnabled,
  type ConnectionStatusView,
  type ModelConnectionCtx,
  type Provider,
} from './types.js';

export interface ConnectParams {
  provider: Provider;
  key: string;
}

/**
 * Security review finding 7: the exact runtime allowlist, checked BEFORE
 * the anthropic feature flag. `provider`'s static type is `Provider`, but
 * nothing stops a caller (a route handler decoding request JSON, or a
 * caller that bypasses the type with `as`) from passing an arbitrary
 * string through at runtime -- previously only the literal `'anthropic'`
 * was special-cased, so any other value (`'Anthropic'`, `'openai'`, ...)
 * skipped the feature-flag check entirely and reached requestFor(), which
 * sends every non-`ai_gateway` value to api.anthropic.com with the key
 * attached. The DB's own CHECK constraint would eventually reject the
 * row, but only after the key had already gone out over the network.
 */
const ALLOWED_PROVIDERS: readonly Provider[] = ['ai_gateway', 'anthropic'];

/**
 * Security review finding 1: printable-ASCII gate, checked BEFORE any
 * network call. A key containing CR, LF or NUL (e.g. pasted with a line
 * wrap) makes undici's own header validation throw inside `fetch`, with
 * the ENTIRE header value -- including the key -- embedded in the thrown
 * error's message. httpClient.ts now never surfaces that text either, but
 * a key that can never be sent as a header should not be stored at all:
 * refusing it here means it's never encrypted, never written, and never
 * has a chance to reach `test()`'s return value by any path. Printable
 * ASCII is 0x20-0x7e; a reasonable upper bound rules out something
 * clearly not a credential.
 */
const PRINTABLE_ASCII_KEY_RE = /^[\x20-\x7e]+$/;
const MAX_KEY_LENGTH = 4096;

function assertValidKeyFormat(key: string): void {
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
    throw new InvalidModelKeyError(
      `model key: length must be between 1 and ${MAX_KEY_LENGTH} characters`,
      'invalid_key_format',
    );
  }
  if (!PRINTABLE_ASCII_KEY_RE.test(key)) {
    throw new InvalidModelKeyError(
      'model key: must be printable ASCII (no control characters, including CR/LF/NUL)',
      'invalid_key_format',
    );
  }
  // Security review suggestion (fix round 3): a real provider key is
  // never legitimately surrounded by whitespace -- accepting it silently
  // sent the literal spaces in the Authorization header (confirmed by the
  // re-review's probe). Reject rather than trim: trimming would make
  // connect() store a DIFFERENT key than what the caller passed with no
  // way for them to know, which is worse than a clear error.
  if (key !== key.trim()) {
    throw new InvalidModelKeyError(
      'model key: must not have leading or trailing whitespace',
      'invalid_key_format',
    );
  }
}

/**
 * D#31 comment 18494573 (C6-1): the public `connect(ctx, {provider,
 * key})` export -- also used to replace an existing key (rotation).
 * "The account's model connection" is at most one logical row per
 * account_id, upheld here (SELECT existing id, then UPDATE its key
 * material or INSERT a fresh row) rather than by a schema constraint --
 * a UNIQUE(account_id) would break packages/spend/test/security-fixes.test.ts,
 * which intentionally inserts more than one model_connections row
 * against one shared test account_id.
 *
 * Criterion 3's "nothing stored" on rejection: validation runs BEFORE
 * any encryption or write, using the plaintext key directly -- a
 * 401/403 throws InvalidModelKeyError and nothing is ever persisted.
 * Only 'ok'/'network_error' reach the INSERT/UPDATE below.
 *
 * D#31 (AAD, C6-2/C6-3): encryption is bound to `(accountId, rowId,
 * 'model_key')` via seal(), so the row's id must exist BEFORE seal()
 * runs. On a rotation that's the row already found below; on first
 * connect there is no row yet, so this generates the id itself
 * (`randomUUID()`) and INSERTs it explicitly instead of letting
 * Postgres's `DEFAULT gen_random_uuid()` assign one after the
 * ciphertext already exists.
 */
export async function connect(ctx: ModelConnectionCtx, params: ConnectParams): Promise<ConnectionStatusView> {
  const { accountId, userId } = ctx.principal;
  const { provider, key: plaintextKey } = params;

  // Finding 7: the exact allowed set, checked before the anthropic flag
  // (and before anything else) -- a provider that isn't even one of the
  // two this package knows about must never reach requestFor().
  if (!ALLOWED_PROVIDERS.includes(provider)) {
    // Security review suggestion (fix round 3): don't echo the raw
    // provider value into the error -- it's runtime-unvalidated input
    // (see the comment above ALLOWED_PROVIDERS), and an error message is
    // somewhere that value could end up logged or displayed unbounded and
    // unsanitized.
    throw new InvalidModelKeyError('model connection: unsupported provider', 'invalid_provider');
  }

  if (provider === 'anthropic' && !isAnthropicProviderEnabled()) {
    throw new InvalidModelKeyError(
      'anthropic: provider is behind a feature flag pending spike S11, not available yet',
      'provider_disabled',
    );
  }

  // Authorization check first (cheap, no network call) -- criterion 6.
  const role = await getMemberRole(ctx.pool, accountId, userId);
  requireOwnerOrAdmin(role);

  // Finding 1: reject anything that could never be sent as a header
  // value BEFORE the HTTP call -- a key that can't be sent shouldn't be
  // stored, encrypted or not.
  assertValidKeyFormat(plaintextKey);

  // Validate BEFORE any write (criterion 3): a rejected key must leave
  // no trace, encrypted or not.
  const outcome = await ctx.httpClient.validate({ provider, plaintextKey });
  if (outcome.kind === 'rejected') {
    throw new InvalidModelKeyError(outcome.message, outcome.code);
  }

  // Finding 4 (TOCTOU): recordInitialValidation below is pinned to the
  // EXACT id/nonce this call just wrote, so it can refuse to apply its
  // outcome to a row a concurrent rotation has since changed. W1 (fix
  // round 3): pinned to `sealed.nonce`, not `fingerprint` -- see
  // validate.ts's recordInitialValidation doc comment for why the
  // 16-bit display fingerprint is the wrong marker for this check.
  let writtenConnectionId!: string;
  let writtenNonce!: Buffer;

  await withTenant(ctx.pool, accountId, userId, async (client) => {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM model_connections WHERE account_id = $1`,
      [accountId],
    );
    const connectionId = existing.rows[0]?.id ?? randomUUID();

    const kekVersion = ctx.kek.currentVersion();
    const kekBytes = ctx.kek.keyFor(kekVersion);
    const sealed = seal({ kek: kekBytes, aad: buildAad(accountId, connectionId) }, plaintextKey);
    const fingerprint = fingerprintOf(plaintextKey, kekBytes);
    writtenConnectionId = connectionId;
    writtenNonce = sealed.nonce;

    if (existing.rows[0]) {
      // An UPDATE of key material -- the guard trigger (round-5 finding
      // 2) auto-resets status/last_validated_at/last_error_code for this
      // non-platform_ops caller; recordInitialValidation below re-applies
      // the fresh outcome under platform_ops's own lock.
      await client.query(
        `UPDATE model_connections
           SET provider = $2, key_ciphertext = $3, key_nonce = $4, wrapped_dek = $5,
               kek_version = $6, key_fingerprint = $7
         WHERE id = $1`,
        [connectionId, provider, sealed.ciphertext, sealed.nonce, sealed.wrappedDek, kekVersion, fingerprint],
      );
    } else {
      await client.query(
        `INSERT INTO model_connections
           (id, account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [connectionId, accountId, provider, sealed.ciphertext, sealed.nonce, sealed.wrappedDek, kekVersion, fingerprint],
      );
    }

    // audit_log payload is provider + fingerprint only -- never key
    // material (criterion 2 applies to audit rows too).
    //
    // D#76: app_user's INSERT grant on audit_log was revoked -- this goes
    // through audit_write(), the SECURITY DEFINER function that stamps
    // account_id/actor/created_at itself, rather than a raw INSERT. The
    // two action strings below are on audit_write's allowlist
    // (migrations/0008_audit_log_append_only.sql).
    await client.query(
      `SELECT audit_write($1, $2::jsonb)`,
      [
        existing.rows[0] ? 'model_connection.replace' : 'model_connection.connect',
        JSON.stringify({ provider, fingerprint }),
      ],
    );
  });

  if (outcome.kind === 'ok' || outcome.kind === 'network_error') {
    await recordInitialValidation(ctx, writtenConnectionId, writtenNonce, outcome);
  }

  // Re-read rather than hand-assemble the return value -- the row this
  // same call just wrote is the one honest source for status/last_validated_at.
  const status = await getStatus(ctx);
  if (!status) {
    throw new Error('model-connection: connection vanished immediately after being written');
  }
  return status;
}
