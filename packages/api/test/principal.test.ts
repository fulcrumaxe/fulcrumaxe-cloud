import { describe, expect, it } from 'vitest';
import { principalIdOf } from '../src/principal.js';

/**
 * Fix round item 4 (CWE-639, security review of this PR, latent):
 * `principalIdOf` used to return the literal string `token:undefined`
 * for a token principal missing `tokenId`, which would silently
 * collapse every such token's idempotency binding into one shared id.
 * Not reachable before API-3b mints real token principals -- pure unit
 * test, no DB needed.
 */
describe('principalIdOf', () => {
  it('a token principal with no tokenId throws, rather than returning "token:undefined"', () => {
    expect(() =>
      principalIdOf({
        kind: 'token',
        accountId: 'a1111111-1111-4111-8111-111111111111',
        userId: 'u1111111-1111-4111-8111-111111111111',
        role: 'member',
        scopes: [],
      }),
    ).toThrow();
  });

  it('a token principal with a tokenId returns "token:<id>"', () => {
    expect(
      principalIdOf({
        kind: 'token',
        accountId: 'a1111111-1111-4111-8111-111111111111',
        userId: 'u1111111-1111-4111-8111-111111111111',
        role: 'member',
        scopes: ['read'],
        tokenId: 't1111111-1111-4111-8111-111111111111',
      }),
    ).toBe('token:t1111111-1111-4111-8111-111111111111');
  });

  it('a session principal returns "session:<userId>"', () => {
    expect(
      principalIdOf({
        kind: 'session',
        accountId: 'a1111111-1111-4111-8111-111111111111',
        userId: 'u1111111-1111-4111-8111-111111111111',
        role: 'owner',
        scopes: [],
      }),
    ).toBe('session:u1111111-1111-4111-8111-111111111111');
  });
});
