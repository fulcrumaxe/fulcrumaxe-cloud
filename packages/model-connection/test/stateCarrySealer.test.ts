import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createStateCarrySealer, machineKekSource, MachineOpsError } from '../src/index.js';
import { open, seal } from '../src/crypto.js';

/** D#845 MC-9b2: a chunk of the state tar is sealed under the machine key with the AAD `account:carry:index`, as bytes. */
const key = (fill: number) => ({ FX_MACHINE_KEK_V1: Buffer.alloc(32, fill).toString('base64') });
const sealer = (fill = 9) => createStateCarrySealer(machineKekSource(key(fill)));
const ids = () => ({ accountId: randomUUID(), carryId: randomUUID(), index: 3 });
const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof MachineOpsError ? error.code : `other:${String(error)}`;
  }
};

describe('createStateCarrySealer', () => {
  it('round-trips arbitrary bytes (every byte value, including ones that are not UTF-8), and the ciphertext holds none of them in the clear', () => {
    const s = sealer();
    const i = ids();
    const chunk = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, n) => n)), randomBytes(4096), Buffer.from('SENTINEL-MEMORY-NOTE')]);
    const sealed = s.seal(i, chunk);
    expect(sealed.kekVersion).toBe(1);
    expect(sealed.ciphertext.includes(Buffer.from('SENTINEL-MEMORY-NOTE'))).toBe(false);
    expect(sealed.nonce).toHaveLength(12);
    expect(sealed.wrappedDek).toHaveLength(60);
    expect(s.open(i, sealed).equals(chunk)).toBe(true);
  });

  it('seals the same bytes twice differently (a fresh key and nonce each time)', () => {
    const s = sealer();
    const i = ids();
    const a = s.seal(i, Buffer.from('same'));
    const b = s.seal(i, Buffer.from('same'));
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.nonce.equals(b.nonce)).toBe(false);
  });

  it('does not open for another account, another carry or another index: the AAD binds all three', () => {
    const s = sealer();
    const i = ids();
    const sealed = s.seal(i, Buffer.from('the team memory'));
    expect(codeOf(() => s.open({ ...i, accountId: randomUUID() }, sealed))).toBe('unseal_failed');
    expect(codeOf(() => s.open({ ...i, carryId: randomUUID() }, sealed))).toBe('unseal_failed');
    expect(codeOf(() => s.open({ ...i, index: i.index + 1 }, sealed))).toBe('unseal_failed');
    expect(codeOf(() => s.open({ ...i, index: 0 }, sealed))).toBe('unseal_failed');
    expect(codeOf(() => s.open(i, sealed))).toBeUndefined();
  });

  it('reads an id in either case as the same id, so a path id and a stored id cannot split a chunk from its seal', () => {
    const s = sealer();
    const i = ids();
    const sealed = s.seal(i, Buffer.from('x'));
    expect(s.open({ ...i, carryId: i.carryId.toUpperCase(), accountId: i.accountId.toUpperCase() }, sealed).toString()).toBe('x');
  });

  it('fails closed on a flipped bit anywhere in the parts, a short part, a wrong key and a KEK version it does not hold', () => {
    const s = sealer();
    const i = ids();
    const sealed = s.seal(i, Buffer.from('payload'));
    for (const part of ['ciphertext', 'wrappedDek', 'nonce'] as const) {
      const bad = Buffer.from(sealed[part]);
      bad[0] = bad[0]! ^ 1;
      expect(codeOf(() => s.open(i, { ...sealed, [part]: bad })), part).toBe('unseal_failed');
    }
    expect(codeOf(() => s.open(i, { ...sealed, wrappedDek: sealed.wrappedDek.subarray(1) }))).toBe('unseal_failed');
    expect(codeOf(() => sealer(7).open(i, sealed))).toBe('unseal_failed');
    expect(codeOf(() => s.open(i, { ...sealed, kekVersion: 2 }))).toBe('machine_kek_unset');
    expect(codeOf(() => s.open(i, { ...sealed, kekVersion: 0 }))).toBe('unseal_failed');
  });

  it('answers an unset or malformed machine key as machine_kek_unset on both sides, and never falls back to the model key', () => {
    const none = createStateCarrySealer(machineKekSource({}));
    const model = createStateCarrySealer(machineKekSource({ FX_KEK_V1: Buffer.alloc(32, 3).toString('base64') }));
    const sealed = sealer().seal(ids(), Buffer.from('x'));
    for (const s of [none, model, createStateCarrySealer(machineKekSource({ FX_MACHINE_KEK_V1: 'short' }))]) {
      expect(codeOf(() => s.seal(ids(), Buffer.from('x')))).toBe('machine_kek_unset');
      expect(codeOf(() => s.open(ids(), sealed))).toBe('machine_kek_unset');
    }
  });

  it('puts no key material or plaintext in an error', () => {
    const s = sealer();
    const i = ids();
    const sealed = s.seal(i, Buffer.from('SENTINEL-MEMORY-NOTE'));
    let message = '';
    try {
      s.open({ ...i, index: 9 }, sealed);
    } catch (error) {
      message = JSON.stringify(error) + String((error as Error).message) + String((error as Error).stack);
    }
    expect(message).not.toMatch(/SENTINEL|cipher|auth|tag/i);
  });
});

describe('the envelope primitive still seals text', () => {
  it('a string and its UTF-8 bytes seal alike and open as text', () => {
    const kek = Buffer.alloc(32, 5);
    const aad = Buffer.from('a:b:c');
    expect(open({ kek, aad }, seal({ kek, aad }, 'héllo'))).toBe('héllo');
    expect(open({ kek, aad }, seal({ kek, aad }, Buffer.from('héllo', 'utf8')))).toBe('héllo');
  });
});
