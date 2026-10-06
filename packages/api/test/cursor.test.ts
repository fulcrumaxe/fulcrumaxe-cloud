import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InvalidCursorError } from '../src/errors.js';
import { CURSOR_RETENTION_MS, isCursorStale, openCursor, parseRunCursor, sealCursor } from '../src/sse/cursor.js';

const KEY = randomBytes(32).toString('base64');
const ENV = { FX_CURSOR_KEY_V1: KEY };
const OTHER_KEY_ENV = { FX_CURSOR_KEY_V1: randomBytes(32).toString('base64') };

/** Builds a validly-sealed cursor with arbitrary plaintext fields, using the real key -- the only way to present a "negative" or "huge" serial that passes the GCM tag. */
function forge(opts: { accountId: string; serial: bigint; issuedAt?: bigint; version?: number }): string {
  const plaintext = Buffer.alloc(32);
  Buffer.from(opts.accountId.replace(/-/g, ''), 'hex').copy(plaintext, 0);
  plaintext.writeBigUInt64BE(opts.serial, 16);
  plaintext.writeBigUInt64BE(opts.issuedAt ?? BigInt(Date.now()), 24);
  const version = opts.version ?? 1;
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(KEY, 'base64'), nonce);
  cipher.setAAD(Buffer.from([version]));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([version]), nonce, ct, cipher.getAuthTag()]).toString('base64url');
}

describe('D#31 API-5 criterion 6: the sealed account cursor', () => {
  const account = randomUUID();

  it('round-trips (account, serial, issued_at)', () => {
    const now = Date.now();
    const sealed = sealCursor({ accountId: account, serial: 123456789012n, issuedAtMs: now }, ENV);
    const opened = openCursor(sealed, account, ENV);
    expect(opened).toEqual({ accountId: account, serial: 123456789012n, issuedAtMs: now });
  });

  it('is base64url, never an integer, and two seals of the same position differ (fresh nonce)', () => {
    const a = sealCursor({ accountId: account, serial: 5n, issuedAtMs: 1 }, ENV);
    const b = sealCursor({ accountId: account, serial: 5n, issuedAtMs: 1 }, ENV);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
    expect(Number.isNaN(Number(a))).toBe(true);
    expect(/^\d+$/.test(a)).toBe(false);
  });

  it('does not contain the serial or the account id in the clear', () => {
    const sealed = sealCursor({ accountId: account, serial: 4242424242n, issuedAtMs: Date.now() }, ENV);
    expect(sealed).not.toContain('4242424242');
    expect(sealed).not.toContain(account.replace(/-/g, ''));
    expect(Buffer.from(sealed, 'base64url').toString('latin1')).not.toContain('4242424242');
  });

  it('account B presenting account A\'s cursor -> InvalidCursorError (422 invalid_cursor)', () => {
    const other = randomUUID();
    const sealed = sealCursor({ accountId: account, serial: 9n, issuedAtMs: Date.now() }, ENV);
    expect(() => openCursor(sealed, other, ENV)).toThrow(InvalidCursorError);
    expect(new InvalidCursorError().status).toBe(422);
    expect(new InvalidCursorError().code).toBe('invalid_cursor');
  });

  it('every tampered form fails the same way: flipped byte in each region, truncated, extended, wrong alphabet, empty, huge', () => {
    const sealed = sealCursor({ accountId: account, serial: 9n, issuedAtMs: Date.now() }, ENV);
    const bytes = Buffer.from(sealed, 'base64url');
    const cases: string[] = [];
    for (const index of [0, 1, 12, 13, 30, 45, bytes.length - 1]) {
      const copy = Buffer.from(bytes);
      copy[index] = copy[index]! ^ 0x01;
      cases.push(copy.toString('base64url'));
    }
    cases.push(sealed.slice(0, -1), `${sealed}A`, sealed.toUpperCase(), `${sealed}=`, '', 'A'.repeat(4096), '-1', '99999999999999999999', 'null', '{"serial":1}');
    for (const bad of cases) {
      expect(() => openCursor(bad, account, ENV), bad.slice(0, 40)).toThrow(InvalidCursorError);
    }
  });

  it('a cursor sealed under a different key, or an unknown version, is rejected', () => {
    const sealed = sealCursor({ accountId: account, serial: 9n, issuedAtMs: Date.now() }, OTHER_KEY_ENV);
    expect(() => openCursor(sealed, account, ENV)).toThrow(InvalidCursorError);
    expect(() => openCursor(forge({ accountId: account, serial: 1n, version: 2 }), account, ENV)).toThrow(InvalidCursorError);
  });

  it('a validly-sealed cursor with a serial past 2^63-1 is rejected (a serial no bigint column can hold)', () => {
    expect(() => openCursor(forge({ accountId: account, serial: (1n << 63n) + 5n }), account, ENV)).toThrow(InvalidCursorError);
    expect(() => openCursor(forge({ accountId: account, serial: (1n << 64n) - 1n }), account, ENV)).toThrow(InvalidCursorError);
    // 2^63-1 itself is the largest legal serial.
    expect(openCursor(forge({ accountId: account, serial: (1n << 63n) - 1n }), account, ENV).serial).toBe((1n << 63n) - 1n);
  });

  it('cannot seal a negative or over-range serial', () => {
    expect(() => sealCursor({ accountId: account, serial: -1n, issuedAtMs: 1 }, ENV)).toThrow();
    expect(() => sealCursor({ accountId: account, serial: 1n << 63n, issuedAtMs: 1 }, ENV)).toThrow();
  });

  it('a missing or malformed key is a server error (plain Error), not a 422 -- and mints nothing', () => {
    expect(() => sealCursor({ accountId: account, serial: 1n, issuedAtMs: 1 }, {})).toThrow(/FX_CURSOR_KEY_V1/);
    expect(() => sealCursor({ accountId: account, serial: 1n, issuedAtMs: 1 }, { FX_CURSOR_KEY_V1: 'c2hvcnQ=' })).toThrow(/32 bytes/);
    const sealed = sealCursor({ accountId: account, serial: 1n, issuedAtMs: 1 }, ENV);
    expect(() => openCursor(sealed, account, {})).toThrow(/FX_CURSOR_KEY_V1/);
    expect(() => openCursor(sealed, account, {})).not.toThrow(InvalidCursorError);
  });

  it('retention: older than 7 days is stale, exactly 7 days is not', () => {
    const now = Date.now();
    const claims = (age: number) => ({ accountId: account, serial: 1n, issuedAtMs: now - age });
    expect(isCursorStale(claims(CURSOR_RETENTION_MS + 1), now)).toBe(true);
    expect(isCursorStale(claims(CURSOR_RETENTION_MS), now)).toBe(false);
    expect(isCursorStale(claims(0), now)).toBe(false);
  });

  it('no id sealed across two accounts\' interleaved events parses as an integer', () => {
    const accounts = [randomUUID(), randomUUID()];
    for (let seq = 1n; seq <= 300n; seq++) {
      const sealed = sealCursor({ accountId: accounts[Number(seq % 2n)]!, serial: seq, issuedAtMs: Date.now() }, ENV);
      expect(/^-?\d+$/.test(sealed)).toBe(false);
      expect(Number.isFinite(Number(sealed))).toBe(false);
      expect(Number.isNaN(parseInt(sealed, 10)) || String(parseInt(sealed, 10)) !== sealed).toBe(true);
    }
  });
});

describe('the run stream\'s Last-Event-ID (a run-scoped seq)', () => {
  it('accepts plain non-negative integers', () => {
    expect(parseRunCursor('0')).toBe(0);
    expect(parseRunCursor('17')).toBe(17);
  });

  it('rejects negative, fractional, exponent, hex, padded, empty, huge and non-numeric forms with invalid_cursor', () => {
    for (const bad of ['-1', '1.5', '1e3', '0x10', '007', '', ' 5', '5 ', '99999999999999999999', 'abc', '+3']) {
      expect(() => parseRunCursor(bad), JSON.stringify(bad)).toThrow(InvalidCursorError);
    }
  });
});
