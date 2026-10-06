import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMIT, MAX_LIMIT, decodeCursor, encodeCursor, parseLimit } from '../src/pagination.js';
import { ApiError, InvalidCursorError } from '../src/errors.js';

const A_UUID = '11111111-1111-4111-8111-111111111111';

describe('parseLimit', () => {
  it('defaults to 50 when no limit is given', () => {
    expect(parseLimit(null)).toBe(DEFAULT_LIMIT);
    expect(parseLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(parseLimit('')).toBe(DEFAULT_LIMIT);
  });

  it('accepts any integer from 1 through 200', () => {
    expect(parseLimit('1')).toBe(1);
    expect(parseLimit('200')).toBe(MAX_LIMIT);
    expect(parseLimit('50')).toBe(50);
  });

  /**
   * Security fix round item 3 (CWE-755, security review of this PR):
   * `parseLimit('201')` used to throw a bare `RangeError`, which
   * `mapError` has no case for, so any direct caller (not routed
   * through a zod query schema) turned it into 500 `internal_error`
   * instead of criterion 4 of API-3a's "limit=201 -> 422". Fails on
   * 002a5b6 with: expected 422, received 500 (via mapError's fallback).
   */
  it('rejects 201 and above -- "limit=201 -> 422", mapping to an ApiError mapError already knows', () => {
    expect(() => parseLimit('201')).toThrow(ApiError);
    try {
      parseLimit('201');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(422);
      expect((err as ApiError).code).toBe('validation_failed');
    }
  });

  it('rejects 0, negative, non-integer and non-numeric values as ApiError, not RangeError', () => {
    expect(() => parseLimit('0')).toThrow(ApiError);
    expect(() => parseLimit('-1')).toThrow(ApiError);
    expect(() => parseLimit('1.5')).toThrow(ApiError);
    expect(() => parseLimit('abc')).toThrow(ApiError);
  });

  /**
   * Security fix round item 3: `Number()`'s permissive coercion used to
   * let scientific notation, hex, and padded whitespace all parse as a
   * valid in-range limit. None of these should be accepted as "the
   * decimal integer the client wrote".
   */
  it('rejects non-decimal forms that Number() would otherwise coerce: "1e2", "0x10", " 5 "', () => {
    expect(() => parseLimit('1e2')).toThrow(ApiError);
    expect(() => parseLimit('0x10')).toThrow(ApiError);
    expect(() => parseLimit(' 5 ')).toThrow(ApiError);
  });
});

describe('encodeCursor / decodeCursor', () => {
  it('round-trips created_at and id (fix round 1: text, microsecond-bearing, not a Date)', () => {
    const createdAt = '2026-01-01T00:00:00.123456Z';
    const cursor = encodeCursor(createdAt, A_UUID);
    const decoded = decodeCursor(cursor);
    expect(decoded).toEqual({ created_at: createdAt, id: A_UUID });
  });

  it('is opaque: two different rows encode to different strings', () => {
    const a = encodeCursor('2026-01-01T00:00:00.123456Z', 'a');
    const b = encodeCursor('2026-01-01T00:00:00.123456Z', 'b');
    expect(a).not.toBe(b);
  });

  it('a tampered cursor -> InvalidCursorError (422 invalid_cursor)', () => {
    expect(() => decodeCursor('not-valid-base64url!!!')).toThrow(InvalidCursorError);
  });

  it('a well-formed-base64 but wrong-shape cursor -> InvalidCursorError', () => {
    const bogus = Buffer.from(JSON.stringify({ nope: true }), 'utf8').toString('base64url');
    expect(() => decodeCursor(bogus)).toThrow(InvalidCursorError);
  });

  it('a cursor whose created_at does not parse as a date -> InvalidCursorError', () => {
    const bogus = Buffer.from(JSON.stringify({ created_at: 'not-a-date', id: 'x' }), 'utf8').toString(
      'base64url',
    );
    expect(() => decodeCursor(bogus)).toThrow(InvalidCursorError);
  });

  /**
   * Security fix round item 4 (CWE-20, security review of this PR): a
   * well-formed cursor whose `id` is not a UUID used to decode
   * successfully here and only fail once it reached a `uuid` column as
   * a query parameter, where Postgres error 22P02 became 500 (mapError
   * has no case for a raw pg error either). Fails on 002a5b6 with:
   * expected [Function InvalidCursorError] to be thrown -- decodeCursor
   * returned normally instead.
   */
  it('a cursor whose id is not a UUID -> InvalidCursorError, before it ever reaches Postgres', () => {
    const bogus = Buffer.from(
      JSON.stringify({ created_at: new Date('2026-01-01T00:00:00.000Z').toISOString(), id: "1' OR '1'='1" }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeCursor(bogus)).toThrow(InvalidCursorError);
  });

  it("InvalidCursorError's default message no longer claims an account binding decodeCursor doesn't check", () => {
    try {
      decodeCursor('not-valid-base64url!!!');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidCursorError);
      expect((err as InvalidCursorError).message).not.toMatch(/account/i);
    }
  });

  /**
   * Fix round 2 (CWE-1284): `Date.parse` silently normalizes an
   * out-of-range calendar date instead of rejecting it, so the old
   * `Number.isNaN(Date.parse(...))` check let a forged cursor through to
   * `$3::timestamptz`, where Postgres error 22008 became a 500. Fails on
   * f7beb7a: decodeCursor(forged) returns normally instead of throwing.
   */
  it('a cursor whose created_at is not a real calendar date -> InvalidCursorError, not a silently-normalized Date', () => {
    const forged = Buffer.from(
      JSON.stringify({ created_at: '2026-02-30T00:00:00.000000Z', id: A_UUID }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeCursor(forged)).toThrow(InvalidCursorError);
  });

  it('a cursor whose created_at year is outside the 1-9999 timestamptz range -> InvalidCursorError', () => {
    const yearZero = Buffer.from(
      JSON.stringify({ created_at: '0000-01-01T00:00:00.000000Z', id: A_UUID }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeCursor(yearZero)).toThrow(InvalidCursorError);
  });

  it('a cursor whose created_at is not the exact fixed-width shape encodeCursor produces -> InvalidCursorError', () => {
    // No microseconds -- a form Date.parse happily accepts, but not what
    // this service's own to_char(...) cursor column ever emits.
    const shortForm = Buffer.from(
      JSON.stringify({ created_at: '2026-01-01T00:00:00Z', id: A_UUID }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeCursor(shortForm)).toThrow(InvalidCursorError);
  });

  it('a leap day and the 1/9999 year boundaries still round-trip (the fix does not over-reject real cursors)', () => {
    for (const createdAt of [
      '2024-02-29T00:00:00.000000Z',
      '0001-01-01T00:00:00.000000Z',
      '9999-12-31T23:59:59.999999Z',
    ]) {
      const cursor = encodeCursor(createdAt, A_UUID);
      expect(decodeCursor(cursor)).toEqual({ created_at: createdAt, id: A_UUID });
    }
  });
});
