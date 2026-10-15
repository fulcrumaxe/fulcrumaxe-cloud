import type { Pool } from 'pg';
import type { KekSource } from './kek.js';
import type { ValidationHttpClient } from './httpClient.js';
import { DecryptionFailedError } from './errors.js';

/**
 * Criterion 1: `ai_gateway` is required; `anthropic` is the alternative, gated by isAnthropicProviderEnabled() below.
 * D#221 MC1: `openai` is the third, with one fixed host (api.openai.com, httpClient.ts) like the other two.
 */
export type Provider = 'ai_gateway' | 'anthropic' | 'openai';

/**
 * D#221 MC1: which credential a connection row holds. The first two are the original kinds (a row's kind equals its
 * provider); the OpenAI kinds follow. `codex_access_token` and `chatgpt_oauth` are the plan-based kinds (planKinds.ts):
 * defined here, connected by later changes, and refused at admit unless the kill switch is on and the notice is
 * acknowledged (credentialPolicy.ts). Mirrors migrations/0800's model_connections_kind_provider_check.
 */
export const CREDENTIAL_KINDS = ['ai_gateway', 'anthropic', 'openai_api_key', 'codex_access_token', 'chatgpt_oauth'] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

export function isCredentialKind(value: unknown): value is CredentialKind {
  return typeof value === 'string' && (CREDENTIAL_KINDS as readonly string[]).includes(value);
}

/** The one provider each kind belongs to. */
export const PROVIDER_OF_KIND: Readonly<Record<CredentialKind, Provider>> = {
  ai_gateway: 'ai_gateway',
  anthropic: 'anthropic',
  openai_api_key: 'openai',
  codex_access_token: 'openai',
  chatgpt_oauth: 'openai',
};

/** The kind a bare `{provider, key}` connect means: the provider's API key. */
export const DEFAULT_KIND_OF_PROVIDER: Readonly<Record<Provider, CredentialKind>> = {
  ai_gateway: 'ai_gateway',
  anthropic: 'anthropic',
  openai: 'openai_api_key',
};

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

/** The AAD generation a key was sealed under (model_connections.aad_version, migration 0800). */
export type AadVersion = 1 | 2;
/** Every new seal uses this one. */
export const CURRENT_AAD_VERSION: AadVersion = 2;

/**
 * D#221 MC1 (S2, CWE-441): the AAD for a model-connection key. Version 2 binds `credential_kind` as well as the account
 * and the connection row, so a sealed row cannot be moved into another kind: opening it under any other kind fails GCM
 * authentication. Version 1 is the original `account:row:model_key`, which binds no kind. Rows sealed before the kind
 * existed keep it until their key is next replaced, and it is accepted only for the two original kinds; anything else
 * (an unknown version, or a version-1 row that claims an OpenAI kind) fails closed.
 */
export function connectionAad(params: {
  accountId: string;
  connectionId: string;
  /** Absent only for a version-1 row read by a caller that does not select the column. */
  credentialKind?: string | undefined;
  aadVersion?: number | undefined;
}): Buffer {
  const { accountId, connectionId, credentialKind } = params;
  const version = params.aadVersion ?? 1;
  if (version === 2 && isCredentialKind(credentialKind)) {
    return buildAad(accountId, connectionId, `model_key:${credentialKind}`);
  }
  if (version === 1 && (credentialKind === undefined || credentialKind === 'ai_gateway' || credentialKind === 'anthropic')) {
    return buildAad(accountId, connectionId);
  }
  throw new DecryptionFailedError('model-connection: the row has no valid sealing context (unknown AAD version or credential kind)');
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
