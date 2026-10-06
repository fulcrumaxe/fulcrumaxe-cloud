import { describe, expect, it } from 'vitest';
import { buildValidatedReturnUrl } from '../src/returnUrl.js';

/**
 * Security-review fix round 2 (PR #53, finding #3): open-redirect
 * probes from the review's own secprobe.test.ts (P4), turned into real,
 * pure-function tests -- no Postgres needed.
 */
describe('buildValidatedReturnUrl (finding #3)', () => {
  const APP_ORIGIN = 'https://app.example';

  it('accepts a bare absolute path, resolved against the configured app origin', () => {
    expect(buildValidatedReturnUrl('/billing', APP_ORIGIN)).toBe('https://app.example/billing');
  });

  it('accepts a path with a query string', () => {
    expect(buildValidatedReturnUrl('/billing?tab=invoices', APP_ORIGIN)).toBe(
      'https://app.example/billing?tab=invoices',
    );
  });

  it('rejects a full URL to a different origin (open redirect)', () => {
    expect(buildValidatedReturnUrl('https://evil.example/phish', APP_ORIGIN)).toBeNull();
  });

  it('rejects a javascript: URL', () => {
    expect(buildValidatedReturnUrl('javascript:alert(1)', APP_ORIGIN)).toBeNull();
  });

  it('rejects a protocol-relative //host URL', () => {
    expect(buildValidatedReturnUrl('//evil.example', APP_ORIGIN)).toBeNull();
  });

  it('rejects a full URL that happens to match the app origin (path-only, not "any URL that resolves same-origin")', () => {
    expect(buildValidatedReturnUrl('https://app.example/billing', APP_ORIGIN)).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(buildValidatedReturnUrl('', APP_ORIGIN)).toBeNull();
  });

  it('rejects a relative path with no leading slash', () => {
    expect(buildValidatedReturnUrl('billing', APP_ORIGIN)).toBeNull();
  });

  it('rejects a backslash trick some parsers treat as a host separator', () => {
    expect(buildValidatedReturnUrl('/\\evil.example', APP_ORIGIN)).toBeNull();
  });

  it('rejects when the configured app origin itself is not https', () => {
    expect(buildValidatedReturnUrl('/billing', 'http://app.example')).toBeNull();
  });

  it('rejects when the configured app origin is not a valid URL', () => {
    expect(buildValidatedReturnUrl('/billing', 'not-a-url')).toBeNull();
  });

  it('security-review fix round 3 (PR #53, SUGGESTION): rejects a dot-segment path that resolves to a scheme-relative //-prefixed pathname, even though it stays on-origin', () => {
    // '/..//evil.example' resolves same-origin (the origin check above
    // already refuses any genuine cross-origin redirect), but its
    // RESOLVED pathname starts with '//' -- cheap insurance against a
    // future consumer reusing that pathname as its own relative redirect
    // target, where a leading '//' is scheme-relative again.
    expect(buildValidatedReturnUrl('/..//evil.example', APP_ORIGIN)).toBeNull();
    expect(buildValidatedReturnUrl('/%2e%2e/%2e%2e//evil.example', APP_ORIGIN)).toBeNull();
  });

  it('refuses any dot-segment before URL resolution can normalise it, raw or percent-encoded in any case', () => {
    const refused = [
      '/a/../b',
      '/../b',
      '/..',
      '/.',
      '/a/./b',
      '/a/..',
      '/x/%2e%2e/y',
      '/x/%2E%2E/y',
      '/x/%2e%2E/y',
      '/x/.%2e/y',
      '/x/%2e./y',
      '/x/%2E./y',
      '/%2e%2e',
      '/%2e',
      '/x/%2E/y',
      '/x/../y?next=/ok',
      '/x/%2e%2e#frag',
    ];
    for (const path of refused) {
      expect(buildValidatedReturnUrl(path, APP_ORIGIN), path).toBeNull();
    }
  });

  it('refuses control characters and spaces the URL parser would strip before resolving', () => {
    const refused = [
      '/x/..\t/y',
      '/.\t./x',
      '/x/.\n./y',
      '/x/.\r./y',
      '/x/%2e\t%2e/y',
      '/x/.. ',
      '/x/..\u0000',
      '/x/%2e%2e ',
      '/billing\u007f',
      '/bill ing',
    ];
    for (const path of refused) {
      expect(buildValidatedReturnUrl(path, APP_ORIGIN), JSON.stringify(path)).toBeNull();
    }
  });

  it('refuses an encoded slash or backslash in any case', () => {
    for (const path of ['/a%2fb', '/a%2Fb', '/%2f%2fevil.example', '/a%5cb', '/a%5Cb', '/%5c..%5c']) {
      expect(buildValidatedReturnUrl(path, APP_ORIGIN), path).toBeNull();
    }
  });

  it('refuses a backslash anywhere in the path', () => {
    for (const path of ['/a\\b', '/a/..\\b', '/\\', '/a\\..\\b']) {
      expect(buildValidatedReturnUrl(path, APP_ORIGIN), path).toBeNull();
    }
  });

  it('still accepts paths that only look dotty: dots inside a segment, and dots in the query', () => {
    expect(buildValidatedReturnUrl('/a..b', APP_ORIGIN)).toBe('https://app.example/a..b');
    expect(buildValidatedReturnUrl('/file.tar.gz', APP_ORIGIN)).toBe('https://app.example/file.tar.gz');
    expect(buildValidatedReturnUrl('/billing?back=../x', APP_ORIGIN)).toBe('https://app.example/billing?back=../x');
  });
});
