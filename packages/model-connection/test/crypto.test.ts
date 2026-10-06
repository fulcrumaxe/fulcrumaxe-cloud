import { createCipheriv, createHmac, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { open, seal, fingerprintOf, fingerprintKeyFrom, FINGERPRINT_HKDF_INFO } from '../src/crypto.js';
import { buildAad } from '../src/types.js';
import { DecryptionFailedError } from '../src/errors.js';
import { fakeKekSource } from './helpers/fakeKek.js';

function aad(accountId = randomUUID(), rowId = randomUUID()): Buffer {
  return buildAad(accountId, rowId);
}

/**
 * Pure unit tests, no Postgres -- criterion 2's "Decrypt round-trip
 * test" and "A tampered ciphertext fails closed", isolated from the
 * database/RLS layer so a failure here always points at the envelope
 * crypto itself, never at grants or triggers.
 */
describe('seal/open envelope encryption (criterion 2)', () => {
  it('round-trips: open(seal(plaintext)) === plaintext', () => {
    const kek = fakeKekSource().keyFor(1);
    const plaintext = 'sk-test-abcdef1234567890';
    const a = aad();
    const sealed = seal({ kek, aad: a }, plaintext);
    expect(open({ kek, aad: a }, sealed)).toBe(plaintext);
  });

  it('never returns the plaintext key on the sealed envelope itself', () => {
    const kek = fakeKekSource().keyFor(1);
    const plaintext = 'sk-test-super-secret-value';
    const sealed = seal({ kek, aad: aad() }, plaintext);
    const serialized = JSON.stringify({
      ciphertext: sealed.ciphertext.toString('base64'),
      nonce: sealed.nonce.toString('base64'),
      wrappedDek: sealed.wrappedDek.toString('base64'),
    });
    expect(serialized).not.toContain(plaintext);
  });

  it('a tampered ciphertext fails closed (GCM auth tag mismatch)', () => {
    const kek = fakeKekSource().keyFor(1);
    const a = aad();
    const sealed = seal({ kek, aad: a }, 'sk-test-value');
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[0] = tampered[0]! ^ 0xff;
    expect(() => open({ kek, aad: a }, { ...sealed, ciphertext: tampered })).toThrow(DecryptionFailedError);
  });

  it('a tampered wrapped_dek fails closed', () => {
    const kek = fakeKekSource().keyFor(1);
    const a = aad();
    const sealed = seal({ kek, aad: a }, 'sk-test-value');
    const tampered = Buffer.from(sealed.wrappedDek);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    expect(() => open({ kek, aad: a }, { ...sealed, wrappedDek: tampered })).toThrow(DecryptionFailedError);
  });

  it('opening under the wrong KEK fails closed', () => {
    const kek = fakeKekSource().keyFor(1);
    const wrongKek = fakeKekSource().keyFor(1);
    const a = aad();
    const sealed = seal({ kek, aad: a }, 'sk-test-value');
    expect(() => open({ kek: wrongKek, aad: a }, sealed)).toThrow();
  });

  it('nonces are independently random across connections (no reuse)', () => {
    const kek = fakeKekSource().keyFor(1);
    const a = aad();
    const s1 = seal({ kek, aad: a }, 'sk-test-value');
    const s2 = seal({ kek, aad: a }, 'sk-test-value');
    expect(s1.nonce.equals(s2.nonce)).toBe(false);
    expect(s1.wrappedDek.subarray(0, 12).equals(s2.wrappedDek.subarray(0, 12))).toBe(false);
  });

  it('fingerprint is the last 4 hex characters of a keyed HMAC (criterion 4)', () => {
    const kek = fakeKekSource().keyFor(1);
    expect(fingerprintOf('sk-test-value', kek)).toMatch(/^[0-9a-f]{4}$/);
  });

  it('fingerprint is deterministic for the same key+kek', () => {
    const kek = fakeKekSource().keyFor(1);
    expect(fingerprintOf('sk-test-key-a', kek)).toBe(fingerprintOf('sk-test-key-a', kek));
  });

  describe('D#31 (C6-2): AAD binds (accountId, rowId, purpose) -- moved ciphertext fails closed', () => {
    it('opening under a DIFFERENT rowId fails closed', () => {
      const kek = fakeKekSource().keyFor(1);
      const accountId = randomUUID();
      const sealed = seal({ kek, aad: buildAad(accountId, 'row-a') }, 'sk-test-moved');
      // Simulates copying this row's ciphertext + wrapped DEK onto a
      // DIFFERENT model_connections row for the SAME account.
      expect(() => open({ kek, aad: buildAad(accountId, 'row-b') }, sealed)).toThrow(DecryptionFailedError);
    });

    it('opening under a DIFFERENT accountId fails closed', () => {
      const kek = fakeKekSource().keyFor(1);
      const rowId = randomUUID();
      const sealed = seal({ kek, aad: buildAad('account-a', rowId) }, 'sk-test-moved-2');
      // The exact "moved to another row or account" scenario D#31 named.
      expect(() => open({ kek, aad: buildAad('account-b', rowId) }, sealed)).toThrow(DecryptionFailedError);
    });

    it('opening under a different purpose fails closed', () => {
      const kek = fakeKekSource().keyFor(1);
      const accountId = randomUUID();
      const rowId = randomUUID();
      const sealed = seal({ kek, aad: buildAad(accountId, rowId, 'model_key') }, 'sk-test-value');
      expect(() => open({ kek, aad: buildAad(accountId, rowId, 'webhook_secret') }, sealed)).toThrow(
        DecryptionFailedError,
      );
    });
  });

  describe('security review finding 5 (CWE-347): open() refuses a truncated GCM tag', () => {
    it('a genuine 4-byte GCM tag on the data layer is refused, not silently accepted', () => {
      const kek = fakeKekSource().keyFor(1);
      const a = aad();

      // Build the data layer by hand under a real DEK (mirrors seal()'s
      // own construction), then truncate its 16-byte tag to 4 bytes --
      // the exact forged-envelope shape finding 5 describes. Wrap that
      // same DEK normally so wrappedDek/kek_version are valid; only the
      // ciphertext's tag is short.
      const dek = randomBytes(32);
      const dekNonce = randomBytes(12);
      const wrapCipher = createCipheriv('aes-256-gcm', kek, dekNonce);
      wrapCipher.setAAD(a);
      const wrappedDek = Buffer.concat([dekNonce, wrapCipher.update(dek), wrapCipher.final(), wrapCipher.getAuthTag()]);

      const nonce = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', dek, nonce);
      c.setAAD(a);
      c.update(Buffer.alloc(0));
      c.final();
      const shortTag = c.getAuthTag().subarray(0, 4);

      expect(() => open({ kek, aad: a }, { ciphertext: shortTag, nonce, wrappedDek })).toThrow(
        DecryptionFailedError,
      );
    });

    it('a wrappedDek that is not exactly nonce+ciphertext+tag (60 bytes for a 32-byte DEK) is refused up front', () => {
      const kek = fakeKekSource().keyFor(1);
      const a = aad();
      const sealed = seal({ kek, aad: a }, 'sk-test-value');

      expect(() => open({ kek, aad: a }, { ...sealed, wrappedDek: Buffer.alloc(0) })).toThrow(DecryptionFailedError);
      expect(() => open({ kek, aad: a }, { ...sealed, wrappedDek: sealed.wrappedDek.subarray(0, 40) })).toThrow(
        DecryptionFailedError,
      );
    });

    it('a nonce that is not exactly 12 bytes is refused up front', () => {
      const kek = fakeKekSource().keyFor(1);
      const a = aad();
      const sealed = seal({ kek, aad: a }, 'sk-test-value');

      expect(() => open({ kek, aad: a }, { ...sealed, nonce: Buffer.alloc(8) })).toThrow(DecryptionFailedError);
    });

    it('a ciphertext shorter than the 16-byte tag is refused up front', () => {
      const kek = fakeKekSource().keyFor(1);
      const a = aad();
      const sealed = seal({ kek, aad: a }, 'sk-test-value');

      expect(() => open({ kek, aad: a }, { ...sealed, ciphertext: Buffer.alloc(4) })).toThrow(DecryptionFailedError);
    });
  });

  describe('key separation suggestion: fingerprint HMAC key is HKDF-derived, not the raw KEK', () => {
    it('fingerprintOf still round-trips deterministically and matches the display format', () => {
      const kek = fakeKekSource().keyFor(1);
      const fp1 = fingerprintOf('sk-test-key-separation', kek);
      const fp2 = fingerprintOf('sk-test-key-separation', kek);
      expect(fp1).toBe(fp2);
      expect(fp1).toMatch(/^[0-9a-f]{4}$/);
    });

    it('the HMAC key is HKDF(kek, info="model_key_fingerprint"), not the raw KEK', () => {
      const kek = fakeKekSource().keyFor(1);
      const derived = fingerprintKeyFrom(kek);

      expect(derived.equals(kek)).toBe(false);
      const expected = Buffer.from(hkdfSync('sha256', kek, Buffer.alloc(0), Buffer.from(FINGERPRINT_HKDF_INFO, 'utf8'), 32));
      expect(derived.equals(expected)).toBe(true);

      // fingerprintOf uses exactly this derived key, not the raw KEK.
      const plaintextKey = 'sk-test-key-separation-2';
      expect(fingerprintOf(plaintextKey, kek)).toBe(
        createHmac('sha256', derived).update(plaintextKey, 'utf8').digest('hex').slice(-4),
      );
    });
  });
});
