import type { Pool } from 'pg';
import type { KekSource } from './kek.js';
import type { ValidationHttpClient } from './httpClient.js';

/** Criterion 1: `ai_gateway` is required; `anthropic` is the alternative, gated by isAnthropicProviderEnabled() below. */
export type Provider = 'ai_gateway' | 'anthropic';

/** Mirrors migrations/0001_core.sql's model_connections.status CHECK. */
export type ConnectionStatus = 'unvalidated' | 'ok' | 'broken';

/** D#31 comment 18494573 (C6-1): the caller's tenant + identity for every ctx-taking function below. */
export interface Principal {
  accountId: string;
  userId: string;
}

/**
 * D#31 comment 18494573 (C6-1): every one of the four exported functions
 * takes exactly `ctx: {pool, principal}` as its identity/tenancy carrier.
 * `platformOpsPool`/`httpClient`/`kek` ride along on the same object
 * (structurally: still a `ctx`, just the rest of this task's already-
 * required injectable dependencies -- the fake HTTP client and fake KEK
 * criterion 3 and the Spec both call for) rather than becoming separate
 * positional parameters.
 */
export interface ModelConnectionCtx {
  /** app_user pool -- every read/write of key material goes through withTenant on this. */
  pool: Pool;
  principal: Principal;
  /** platform_ops pool -- the only role allowed to write status/last_validated_at/last_error_code. */
  platformOpsPool: Pool;
  httpClient: ValidationHttpClient;
  kek: KekSource;
}

/**
 * D#31 comment 18494573 (C6-1): getStatus()'s return shape, "frozen as
 * the future /api/v1/model-connection response" -- snake_case to match
 * the DB columns and the eventual JSON wire shape directly, and never
 * containing any part of the key (criterion 4).
 */
export interface ConnectionStatusView {
  provider: Provider;
  /**
   * Last 4 hex characters of HMAC-SHA256(fingerprintKeyFrom(kek),
   * plaintextKey) -- an HKDF-derived key separate from the KEK itself
   * (crypto.ts's fingerprintKeyFrom/fingerprintOf), not the KEK directly.
   * Display-only (criterion 4); never the full digest, never the key, and
   * -- fix round 3, W1 -- never used to compare "is this still the same
   * key" anywhere in this package (see validate.ts's recordInitialValidation).
   */
  fingerprint: string;
  status: ConnectionStatus;
  last_validated_at: Date | null;
  last_error_code: string | null;
}

/**
 * D#31 comment 18494573 (C6-2): AAD bound to (account_id, row_id,
 * 'model_key') -- model-connection's own convention for crypto.ts's
 * generic `seal`/`open`. A future domain (webhook secrets) builds its
 * own AAD string; this format is not shared.
 */
export function buildAad(accountId: string, rowId: string, purpose = 'model_key'): Buffer {
  return Buffer.from(`${accountId}:${rowId}:${purpose}`, 'utf8');
}

/**
 * Criterion 1: Anthropic ships enabled only once spike S11 passes (it
 * needs a real Anthropic key brokered through a sandbox -- LIVE-NEEDS),
 * so this stays hardcoded `false` until a future PR flips it. A function,
 * not a bare constant, so a test can point at the check without editing
 * environment state.
 */
export function isAnthropicProviderEnabled(): boolean {
  return false;
}
