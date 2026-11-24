import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createMachineLoginSealer, machineKekSource, MachineOpsError } from '../src/index.js';

/** D#845 MC-8a: the Claude sign-in link and code are sealed under the machine key, bound to account, request, runner and purpose. */
const key = (fill: number) => ({ FX_MACHINE_KEK_V1: Buffer.alloc(32, fill).toString('base64') });
const sealer = (fill = 9) => createMachineLoginSealer(machineKekSource(key(fill)));
const ids = () => ({ accountId: randomUUID(), requestId: randomUUID(), runnerId: randomUUID() });
const PLAIN = 'https://claude.com/cai/oauth/authorize?scope=a+b&state=SENTINEL';

describe('createMachineLoginSealer', () => {
  it('round-trips a link and a code, and the blob holds neither in the clear', () => {
    const s = sealer();
    const i = ids();
    for (const [purpose, text] of [['auth_url', PLAIN], ['code', 'abc-123_XYZ']] as const) {
      const blob = s.seal(i, purpose, text);
      expect(blob.includes(Buffer.from(text))).toBe(false);
      expect(blob.length).toBeLessThanOrEqual(4096);
      expect(s.open(i, purpose, blob)).toBe(text);
    }
  });

  it('a blob made twice differs (a fresh key and nonce each time)', () => {
    const s = sealer();
    const i = ids();
    expect(s.seal(i, 'code', 'abc').equals(s.seal(i, 'code', 'abc'))).toBe(false);
  });

  it('does not open for another account, request, runner or purpose: the AAD binds all four', () => {
    const s = sealer();
    const i = ids();
    const blob = s.seal(i, 'code', 'abc');
    for (const moved of [{ ...i, accountId: randomUUID() }, { ...i, requestId: randomUUID() }, { ...i, runnerId: randomUUID() }]) {
      expect(() => s.open(moved, 'code', blob)).toThrowError(expect.objectContaining({ code: 'unseal_failed' }));
    }
    expect(() => s.open(i, 'auth_url', blob)).toThrowError(expect.objectContaining({ code: 'unseal_failed' }));
    expect(s.open(i, 'code', blob)).toBe('abc');
  });

  it('does not open under another key, a changed byte, a short blob or another version, and names nothing of the key in the error', () => {
    const i = ids();
    const blob = sealer(9).seal(i, 'code', 'abc');
    expect(() => sealer(8).open(i, 'code', blob)).toThrowError(expect.objectContaining({ code: 'unseal_failed' }));
    for (const at of [0, 1, 20, blob.length - 1]) {
      const bad = Buffer.from(blob);
      bad[at] = bad[at]! ^ 1;
      expect(() => sealer(9).open(i, 'code', bad), `byte ${at}`).toThrow(MachineOpsError);
    }
    expect(() => sealer(9).open(i, 'code', blob.subarray(0, 40))).toThrow(MachineOpsError);
    try {
      sealer(8).open(i, 'code', blob);
    } catch (e) {
      expect(String((e as Error).message)).not.toMatch(/key|aes|gcm|auth/i);
    }
  });

  it('fails closed without the machine key, and never reads the model-connection key', () => {
    const i = ids();
    for (const env of [{}, { FX_KEK_V1: Buffer.alloc(32, 3).toString('base64') }, { FX_MACHINE_KEK_V1: 'short' }]) {
      expect(() => createMachineLoginSealer(machineKekSource(env)).seal(i, 'code', 'abc')).toThrowError(expect.objectContaining({ code: 'machine_kek_unset' }));
    }
    const blob = sealer().seal(i, 'code', 'abc');
    expect(() => createMachineLoginSealer(machineKekSource({})).open(i, 'code', blob)).toThrowError(expect.objectContaining({ code: 'machine_kek_unset' }));
  });

  it('records the KEK version in the blob apart from the format byte, so a rotation still opens old blobs', () => {
    const k1 = Buffer.alloc(32, 1);
    const k2 = Buffer.alloc(32, 2);
    const source = (current: number) => ({ currentVersion: () => current, keyFor: (v: number): Buffer => { const k = ({ 1: k1, 2: k2 } as Record<number, Buffer>)[v]; if (!k) throw new Error('no such version'); return k; } });
    const i = ids();
    const old = createMachineLoginSealer(source(1)).seal(i, 'code', 'abc');
    expect(old[0]).toBe(1);
    expect(old.readUInt32BE(1)).toBe(1);
    const rotated = createMachineLoginSealer(source(2));
    expect(rotated.open(i, 'code', old)).toBe('abc');
    const fresh = rotated.seal(i, 'code', 'def');
    expect(fresh.readUInt32BE(1)).toBe(2);
    expect(rotated.open(i, 'code', fresh)).toBe('def');
    // A tampered version never opens: another held version fails the cipher, an unheld one is a fixed code, and zero is refused.
    const swap = (blob: Buffer, v: number): Buffer => { const b = Buffer.from(blob); b.writeUInt32BE(v, 1); return b; };
    expect(() => rotated.open(i, 'code', swap(old, 2))).toThrowError(expect.objectContaining({ code: 'unseal_failed' }));
    expect(() => rotated.open(i, 'code', swap(old, 7))).toThrow(MachineOpsError);
    expect(() => rotated.open(i, 'code', swap(old, 0))).toThrowError(expect.objectContaining({ code: 'unseal_failed' }));
  });
});
