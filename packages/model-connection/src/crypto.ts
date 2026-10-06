import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { DecryptionFailedError } from './errors.js';

const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const DEK_BYTES = 32; // AES-256
const WRAPPED_DEK_BYTES = GCM_NONCE_BYTES + DEK_BYTES + GCM_TAG_BYTES; // nonce || ciphertext || tag

/**
 * D#31 comment 18494573 (C6-3): the envelope primitive, generic and
 * reusable -- `kek`/`aad` are explicit params, not this package's
 * KekSource/EnvelopeContext types, so D#31 API-4 can call this exact
 * function for webhook signing secrets under FX_WEBHOOK_KEK_V1 without
 * any model-connection-specific type in its way. `kek` is the already-
 * resolved raw key for whichever version the caller picked (version
 * selection is the caller's own schema concern -- see kek.ts); `aad` is
 * an already-built buffer (see connect.ts's buildAad for this package's
 * own `accountId:rowId:purpose` convention).
 */
export interface KekAad {
  kek: Buffer;
  aad: Buffer;
}

/**
 * What migrations/0001_core.sql's key-material columns hold. `ciphertext`
 * is `keyCiphertext || authTag` (GCM's tag is a fixed 16 bytes, appended
 * rather than given its own column); `wrappedDek` carries its OWN nonce
 * as its first 12 bytes (reusing `nonce` under the KEK would be safe --
 * GCM nonce-uniqueness is per-key, not global -- but storing it
 * explicitly avoids relying on that).
 */
export interface Sealed {
  ciphertext: Buffer;
  nonce: Buffer;
  wrappedDek: Buffer;
}

/**
 * Envelope-encrypts `plaintext`: a fresh random 32-byte data key (DEK)
 * encrypts it (AES-256-GCM, random nonce), and `kek` wraps the DEK
 * (AES-256-GCM, its own random nonce). Both layers carry `aad` -- opening
 * under any other AAD fails GCM authentication and throws. Criterion 2:
 * nothing returned here is the plaintext or the DEK in the clear.
 */
export function seal({ kek, aad }: KekAad, plaintext: string): Sealed {
  const dek = randomBytes(DEK_BYTES);

  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dek, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);

  const dekNonce = randomBytes(GCM_NONCE_BYTES);
  const dekCipher = createCipheriv('aes-256-gcm', kek, dekNonce);
  dekCipher.setAAD(aad);
  const dekCiphertext = Buffer.concat([dekCipher.update(dek), dekCipher.final(), dekCipher.getAuthTag()]);

  return { ciphertext, nonce, wrappedDek: Buffer.concat([dekNonce, dekCiphertext]) };
}

/**
 * Reverses seal(). Criterion 2's "a tampered ciphertext fails closed",
 * plus D#31's AAD requirement: a bit flip in `wrappedDek`/`ciphertext`,
 * or opening under a DIFFERENT `aad` than it was sealed with (e.g. this
 * row's ciphertext copied onto another row or account), throws inside
 * node:crypto -- caught and re-thrown as DecryptionFailedError rather
 * than leaking raw node:crypto error text.
 *
 * Security review finding 5 (CWE-347): both `createDecipheriv` calls now
 * pin `authTagLength: 16` -- without it, Node accepts a 4/8/12-15-byte
 * GCM tag, and `sealed.ciphertext.subarray(len - 16)` on a buffer
 * shorter than 16 bytes silently yields a short tag instead of erroring.
 * `setAuthTag` then throws for any tag whose length doesn't match the
 * pinned value, closing that off. The explicit length checks below are
 * defense-in-depth ahead of that: they reject a malformed envelope
 * before any decipher is even constructed, with the same
 * DecryptionFailedError every other failure in this function produces.
 */
export function open({ kek, aad }: KekAad, sealed: Sealed): string {
  try {
    if (sealed.wrappedDek.length !== WRAPPED_DEK_BYTES) {
      throw new Error(`wrappedDek must be exactly ${WRAPPED_DEK_BYTES} bytes, got ${sealed.wrappedDek.length}`);
    }
    if (sealed.nonce.length !== GCM_NONCE_BYTES) {
      throw new Error(`nonce must be exactly ${GCM_NONCE_BYTES} bytes, got ${sealed.nonce.length}`);
    }
    if (sealed.ciphertext.length < GCM_TAG_BYTES) {
      throw new Error(`ciphertext must be at least ${GCM_TAG_BYTES} bytes, got ${sealed.ciphertext.length}`);
    }

    const dekNonce = sealed.wrappedDek.subarray(0, GCM_NONCE_BYTES);
    const dekBody = sealed.wrappedDek.subarray(GCM_NONCE_BYTES);
    const dekTag = dekBody.subarray(dekBody.length - GCM_TAG_BYTES);
    const dekCiphertext = dekBody.subarray(0, dekBody.length - GCM_TAG_BYTES);

    const dekDecipher = createDecipheriv('aes-256-gcm', kek, dekNonce, { authTagLength: GCM_TAG_BYTES });
    dekDecipher.setAAD(aad);
    dekDecipher.setAuthTag(dekTag);
    const dek = Buffer.concat([dekDecipher.update(dekCiphertext), dekDecipher.final()]);

    const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - GCM_TAG_BYTES);
    const ciphertextOnly = sealed.ciphertext.subarray(0, sealed.ciphertext.length - GCM_TAG_BYTES);

    const decipher = createDecipheriv('aes-256-gcm', dek, sealed.nonce, { authTagLength: GCM_TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertextOnly), decipher.final()]).toString('utf8');
  } catch (err) {
    throw new DecryptionFailedError(
      `model-connection: decrypt failed (tampered ciphertext, wrong KEK version/AAD, or corrupted row): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Not re-exported from index.ts (C6's frozen surface covers only
 * seal/open/fingerprintOf from this module) -- exported from this module
 * only so test/crypto.test.ts can assert the HKDF derivation directly
 * rather than inferring it indirectly.
 */
export const FINGERPRINT_HKDF_INFO = 'model_key_fingerprint';

/**
 * Security review suggestion (key separation): derives a fingerprint-only
 * HMAC key from the KEK via HKDF rather than using the AES wrapping key
 * itself as the HMAC key. `seal`/`open` never call this -- the wrapping
 * key and the fingerprint key are now cryptographically distinct even
 * though both trace back to the same KEK.
 */
export function fingerprintKeyFrom(kek: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', kek, Buffer.alloc(0), Buffer.from(FINGERPRINT_HKDF_INFO, 'utf8'), 32));
}

/**
 * Criterion 4's "fingerprint (last 4 characters of a keyed HMAC)":
 * HMAC-SHA256 of the plaintext key, keyed by an HKDF-derived key
 * separate from the KEK itself (not computable without the KEK),
 * truncated to its last 4 hex characters -- the exact display value
 * criterion 4 calls for. Not part of seal/open: this is model-
 * connection's own display concern, not a generic envelope property a
 * webhook secret would need.
 */
export function fingerprintOf(plaintextKey: string, kek: Buffer): string {
  return createHmac('sha256', fingerprintKeyFrom(kek)).update(plaintextKey, 'utf8').digest('hex').slice(-4);
}
