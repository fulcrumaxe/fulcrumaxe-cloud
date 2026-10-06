import { randomBytes } from 'node:crypto';
import { seal, open, buildAad, type Sealed } from '@fx/model-connection';

/**
 * D#31 API-4b, criterion 4: webhook signing secrets, envelope-encrypted
 * through H21's generic `seal`/`open` (correction C6) under this
 * package's OWN key, `FX_WEBHOOK_KEK_V*` -- never `FX_KEK_V1`
 * (model-connection's own root key). "With FX_KEK_V1 unset, the
 * dispatcher still works. With FX_WEBHOOK_KEK_V1 unset, it fails closed"
 * holds by construction: this module never reads `FX_KEK_V1` at all, so
 * the two are independent, not merely untested together.
 */

/** Mirrors `@fx/model-connection`'s own `KekSource` shape (kek.ts) --
 * not imported from there: that interface isn't part of C6's frozen
 * exported surface (`seal`/`open`/`fingerprintOf` only), and this
 * package's key material is versioned under a completely different env
 * var family regardless. */
export interface KekSource {
  /** The version new/rotated secrets should be wrapped under. */
  currentVersion(): number;
  /** The raw 32-byte AES-256 key for `version`. Throws if unavailable. */
  keyFor(version: number): Buffer;
}

/**
 * Reads `FX_WEBHOOK_KEK_V{version}` from the environment (base64, exactly
 * 32 bytes decoded), current version from `FX_WEBHOOK_KEK_CURRENT_VERSION`
 * (default 1) -- the exact shape of model-connection's own `envKekSource`
 * (kek.ts), duplicated rather than shared: the two key families must stay
 * independently rotatable, and sharing the reader would tempt a future
 * change to also share the env var names.
 */
export function envWebhookKekSource(env: NodeJS.ProcessEnv = process.env): KekSource {
  const currentVersion = Number.parseInt(env.FX_WEBHOOK_KEK_CURRENT_VERSION ?? '1', 10);
  if (!Number.isInteger(currentVersion) || currentVersion < 1) {
    throw new Error(
      `envWebhookKekSource: FX_WEBHOOK_KEK_CURRENT_VERSION must be a positive integer, got: ${env.FX_WEBHOOK_KEK_CURRENT_VERSION}`,
    );
  }
  return {
    currentVersion: () => currentVersion,
    keyFor: (version: number): Buffer => {
      const varName = `FX_WEBHOOK_KEK_V${version}`;
      const raw = env[varName];
      if (!raw) {
        throw new Error(`envWebhookKekSource: ${varName} is not set`);
      }
      const key = Buffer.from(raw, 'base64');
      if (key.length !== 32) {
        throw new Error(`envWebhookKekSource: ${varName} must decode (base64) to exactly 32 bytes, got ${key.length}`);
      }
      return key;
    },
  };
}

export interface SealedWebhookSecret {
  ciphertext: Buffer;
  nonce: Buffer;
  wrappedDek: Buffer;
  kekVersion: number;
}

/**
 * A fresh `whsec_` secret: the Standard Webhooks convention is that the
 * text after the prefix IS the base64-encoded HMAC key, not a further
 * encoded token -- `sign.ts` decodes it that way.
 */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64')}`;
}

/**
 * Criterion 4's AAD requirement (C6): binds every ciphertext to
 * `(account_id, row_id, 'webhook_secret')`, the exact tuple form C6 froze
 * for model keys, with this resource's own purpose string. `endpointId`
 * is the row's own id -- stable for that row's whole life, so a ciphertext
 * copied onto another row (a different id) or another account fails to
 * decrypt under this AAD (fails closed, via `DecryptionFailedError`).
 */
function aadFor(accountId: string, endpointId: string): Buffer {
  return buildAad(accountId, endpointId, 'webhook_secret');
}

export function sealWebhookSecret(
  kekSource: KekSource,
  accountId: string,
  endpointId: string,
  plaintext: string,
): SealedWebhookSecret {
  const kekVersion = kekSource.currentVersion();
  const sealed: Sealed = seal({ kek: kekSource.keyFor(kekVersion), aad: aadFor(accountId, endpointId) }, plaintext);
  return { ciphertext: sealed.ciphertext, nonce: sealed.nonce, wrappedDek: sealed.wrappedDek, kekVersion };
}

export function openWebhookSecret(
  kekSource: KekSource,
  accountId: string,
  endpointId: string,
  sealed: SealedWebhookSecret,
): string {
  return open(
    { kek: kekSource.keyFor(sealed.kekVersion), aad: aadFor(accountId, endpointId) },
    { ciphertext: sealed.ciphertext, nonce: sealed.nonce, wrappedDek: sealed.wrappedDek },
  );
}
