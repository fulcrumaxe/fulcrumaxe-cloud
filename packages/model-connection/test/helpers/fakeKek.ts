import { randomBytes } from 'node:crypto';
import type { KekSource } from '../../src/kek.js';

/**
 * "KEK from env FX_KEK_V1; tests inject a fake" -- a deterministic,
 * in-memory KekSource so no test depends on FX_KEK_V1 being set in the
 * process environment. A fresh random 32-byte key per call keeps tests
 * from accidentally sharing key material across independent cases.
 */
export function fakeKekSource(version = 1): KekSource {
  const key = randomBytes(32);
  return {
    currentVersion: () => version,
    keyFor: (v: number): Buffer => {
      if (v !== version) {
        throw new Error(`fakeKekSource: no key for version ${v} (only ${version} is configured)`);
      }
      return key;
    },
  };
}

/** Two key versions held at once; `setCurrent` is the platform rolling its root key forward (new seals use it, old rows still open under theirs). */
export function fakeVersionedKek(): { source: KekSource; setCurrent(version: number): void } {
  const keys = new Map<number, Buffer>([[1, randomBytes(32)], [2, randomBytes(32)]]);
  let current = 1;
  return {
    source: {
      currentVersion: () => current,
      keyFor: (v: number): Buffer => {
        const key = keys.get(v);
        if (!key) throw new Error(`fakeVersionedKek: no key for version ${v}`);
        return key;
      },
    },
    setCurrent: (v) => void (current = v),
  };
}
