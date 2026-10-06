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
