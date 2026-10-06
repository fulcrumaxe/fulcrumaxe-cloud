import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertLocalDevTarget } from '../scripts/seed-dev.js';

/** D#31 API-3a, seed-dev.ts's guard against seeding a non-local database (CWE-489 / OWASP A05). */
describe('assertLocalDevTarget', () => {
  const originalFlag = process.env.FX_SEED_DEV;

  beforeEach(() => {
    process.env.FX_SEED_DEV = '1';
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.FX_SEED_DEV;
    else process.env.FX_SEED_DEV = originalFlag;
  });

  it('refuses when FX_SEED_DEV is not set to "1"', () => {
    delete process.env.FX_SEED_DEV;
    expect(() => assertLocalDevTarget('postgres://u@localhost/db')).toThrow(/FX_SEED_DEV/);
  });

  it('accepts plain local hosts', () => {
    expect(() => assertLocalDevTarget('postgres://u@localhost/db')).not.toThrow();
    expect(() => assertLocalDevTarget('postgres://u@127.0.0.1/db')).not.toThrow();
    expect(() => assertLocalDevTarget('postgres://u@[::1]/db')).not.toThrow();
  });

  it('rejects a non-local host', () => {
    expect(() => assertLocalDevTarget('postgres://u@db.example.com/db')).toThrow(/non-local host/);
  });

  /**
   * Delta recheck of PR #138 (fix round 2): fix round 1's guard checked
   * only `new URL(url).hostname`, but the driver (`pg` -> its internal
   * `pg-connection-string`) resolves `host` from a `?host=` query param
   * FIRST and only falls back to the URL's own hostname if that param is
   * absent -- so a URL whose hostname looks local can still connect
   * somewhere else entirely. Fails on f7beb7a:
   * assertLocalDevTarget('postgres://u@localhost/db?host=evil.example.com')
   * returned normally instead of throwing.
   */
  it('rejects a ?host= override even when the URL hostname looks local', () => {
    expect(() => assertLocalDevTarget('postgres://u@localhost/db?host=evil.example.com')).toThrow(/host/);
  });

  it('rejects a ?hostaddr= override the same way', () => {
    expect(() => assertLocalDevTarget('postgres://u@localhost/db?hostaddr=10.0.0.1')).toThrow(/host/);
  });

  /**
   * D#31 C12 (API-3c), closing the #145 recheck's should-fix (a): the round-2
   * guard's `searchParams.has("host")` check was case-sensitive, so a
   * mixed-case param name was not rejected. Fails on main:
   * assertLocalDevTarget('postgres://u@localhost/db?HOST=evil.example.com')
   * returns normally instead of throwing.
   */
  it('rejects a ?HOST= override with different case', () => {
    expect(() => assertLocalDevTarget('postgres://u@localhost/db?HOST=evil.example.com')).toThrow(/host/);
  });

  it('rejects a ?Host= override with mixed case', () => {
    expect(() => assertLocalDevTarget('postgres://u@localhost/db?Host=evil.example.com')).toThrow(/host/);
  });

  it('rejects a ?HostAddr= override with mixed case', () => {
    expect(() => assertLocalDevTarget('postgres://u@localhost/db?HostAddr=10.0.0.1')).toThrow(/host/);
  });

  it('still accepts a legitimate local URL with unrelated query params', () => {
    expect(() => assertLocalDevTarget('postgres://u@localhost/db?sslmode=disable')).not.toThrow();
  });

  it('still accepts a legitimate local URL with a mixed-case unrelated query param', () => {
    expect(() => assertLocalDevTarget('postgres://u@localhost/db?SSLMode=disable')).not.toThrow();
  });
});
