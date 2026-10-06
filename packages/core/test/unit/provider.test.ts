import { describe, expect, it, vi } from 'vitest';
import {
  GITHUB_AUTHORIZE_URL,
  GitHubOAuthProvider,
  TestOnlyProvider,
  githubOAuthConfigFromEnv,
  resolveGithubAuthorizeUrlOverride,
  type AuthProvider,
} from '../../src/auth/provider.js';

describe('TestOnlyProvider', () => {
  it('refuses to construct when NODE_ENV=production, even with the opt-in flag set', () => {
    expect(
      () =>
        new TestOnlyProvider(
          { githubUserId: 1, email: 'a@example.test', name: 'A', githubLogin: 'a-user' },
          { NODE_ENV: 'production', FX_ENABLE_TEST_AUTH: '1' } as unknown as NodeJS.ProcessEnv,
        ),
    ).toThrow(/NODE_ENV=production/);
  });

  // Security fix round item 6: the old gate was a blocklist
  // (NODE_ENV === 'production'), so the route was open whenever NODE_ENV
  // was unset or 'development'. It must now be closed by default,
  // regardless of NODE_ENV, unless the caller explicitly opts in.
  it('refuses to construct when FX_ENABLE_TEST_AUTH is unset, including under NODE_ENV=development', () => {
    expect(
      () =>
        new TestOnlyProvider(
          { githubUserId: 1, email: 'a@example.test', name: 'A', githubLogin: 'a-user' },
          { NODE_ENV: 'development' } as unknown as NodeJS.ProcessEnv,
        ),
    ).toThrow(/FX_ENABLE_TEST_AUTH/);
  });

  it('refuses to construct when FX_ENABLE_TEST_AUTH is unset and NODE_ENV is unset entirely', () => {
    expect(
      () =>
        new TestOnlyProvider(
          { githubUserId: 1, email: 'a@example.test', name: 'A', githubLogin: 'a-user' },
          {} as unknown as NodeJS.ProcessEnv,
        ),
    ).toThrow(/FX_ENABLE_TEST_AUTH/);
  });

  it('refuses to construct when VERCEL_ENV is set, even with the opt-in flag set', () => {
    expect(
      () =>
        new TestOnlyProvider(
          { githubUserId: 1, email: 'a@example.test', name: 'A', githubLogin: 'a-user' },
          { NODE_ENV: 'development', FX_ENABLE_TEST_AUTH: '1', VERCEL_ENV: 'preview' } as unknown as NodeJS.ProcessEnv,
        ),
    ).toThrow(/VERCEL_ENV/);
  });

  it('constructs fine when FX_ENABLE_TEST_AUTH=1 and neither NODE_ENV=production nor VERCEL_ENV is set, and returns its fixed identity', async () => {
    const identity = { githubUserId: 1, email: 'a@example.test', name: 'A', githubLogin: 'a-user' };
    const provider: AuthProvider = new TestOnlyProvider(identity, {
      NODE_ENV: 'test',
      FX_ENABLE_TEST_AUTH: '1',
    } as unknown as NodeJS.ProcessEnv);
    expect(await provider.exchangeCode('anything')).toEqual(identity);
  });
});

describe('githubOAuthConfigFromEnv', () => {
  it('throws when any required var is missing', () => {
    expect(() => githubOAuthConfigFromEnv({} as NodeJS.ProcessEnv)).toThrow();
  });

  it('reads all three vars when present', () => {
    const config = githubOAuthConfigFromEnv({
      FX_GITHUB_CLIENT_ID: 'id',
      FX_GITHUB_CLIENT_SECRET: 'secret',
      FX_GITHUB_CALLBACK_URL: 'https://example.test/callback',
    } as unknown as NodeJS.ProcessEnv);
    expect(config).toEqual({
      clientId: 'id',
      clientSecret: 'secret',
      callbackUrl: 'https://example.test/callback',
    });
  });
});

describe('GitHubOAuthProvider', () => {
  const config = {
    clientId: 'id',
    clientSecret: 'secret',
    callbackUrl: 'https://example.test/callback',
  };

  it('getAuthorizationUrl embeds client_id, redirect_uri and state', () => {
    const provider = new GitHubOAuthProvider(config, vi.fn());
    const url = new URL(provider.getAuthorizationUrl('csrf-state'));
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('id');
    expect(url.searchParams.get('redirect_uri')).toBe(config.callbackUrl);
    expect(url.searchParams.get('state')).toBe('csrf-state');
  });

  it('exchangeCode resolves an ExternalIdentity using an injected fetch, with zero real network calls', async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'gho_fake' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 42, login: 'octocat', email: 'octocat@example.test', name: 'Octo Cat' }),
      });

    const provider = new GitHubOAuthProvider(config, fakeFetch as unknown as typeof fetch);
    const identity = await provider.exchangeCode('some-code');

    expect(identity).toEqual({
      githubUserId: 42,
      email: 'octocat@example.test',
      name: 'Octo Cat',
      githubLogin: 'octocat',
    });
    expect(fakeFetch).toHaveBeenCalledTimes(2);
    expect(fakeFetch.mock.calls[0]![0]).toBe('https://github.com/login/oauth/access_token');
    expect(fakeFetch.mock.calls[1]![0]).toBe('https://api.github.com/user');
  });

  it('falls back to /user/emails when the primary user record has no public email', async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'gho_fake' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 7, login: 'noemailuser', email: null, name: null }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { email: 'secondary@example.test', primary: false, verified: true },
          { email: 'primary@example.test', primary: true, verified: true },
        ],
      });

    const provider = new GitHubOAuthProvider(config, fakeFetch as unknown as typeof fetch);
    const identity = await provider.exchangeCode('some-code');

    expect(identity.email).toBe('primary@example.test');
    expect(fakeFetch).toHaveBeenCalledTimes(3);
  });

  it('throws when the token exchange fails', async () => {
    const fakeFetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 401 });
    const provider = new GitHubOAuthProvider(config, fakeFetch as unknown as typeof fetch);
    await expect(provider.exchangeCode('bad-code')).rejects.toThrow(/401/);
  });

  it('throws when no verified email is reachable at all', async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'gho_fake' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 7, login: 'noemailuser', email: null, name: null }) })
      .mockResolvedValueOnce({ ok: true, json: async () => [] });
    const provider = new GitHubOAuthProvider(config, fakeFetch as unknown as typeof fetch);
    await expect(provider.exchangeCode('some-code')).rejects.toThrow(/verified email/);
  });
});

// D#37 WS-C2 fix round 2 (criterion 15, owner ruling 2026-09-24, C15e):
// the config seam that lets a local milestone run stand in a tiny local
// fake for the GitHub authorize HOST. Gated exactly like TestOnlyProvider
// (security fix round item 6) -- these tests prove that gate holds even
// when the override var is set, in every combination that must still
// fall back to the real github.com URL.
describe('resolveGithubAuthorizeUrlOverride', () => {
  it('returns undefined when FX_GITHUB_AUTHORIZE_URL is unset', () => {
    expect(
      resolveGithubAuthorizeUrlOverride({
        NODE_ENV: 'test',
        FX_ENABLE_TEST_AUTH: '1',
      } as unknown as NodeJS.ProcessEnv),
    ).toBeUndefined();
  });

  it('returns the override when FX_ENABLE_TEST_AUTH=1 and neither NODE_ENV=production nor VERCEL_ENV is set', () => {
    expect(
      resolveGithubAuthorizeUrlOverride({
        NODE_ENV: 'test',
        FX_ENABLE_TEST_AUTH: '1',
        FX_GITHUB_AUTHORIZE_URL: 'http://127.0.0.1:4610/authorize',
      } as unknown as NodeJS.ProcessEnv),
    ).toBe('http://127.0.0.1:4610/authorize');
  });

  it('ignores the override when NODE_ENV=production, even with the opt-in flag set -- a production build must still use github.com', () => {
    expect(
      resolveGithubAuthorizeUrlOverride({
        NODE_ENV: 'production',
        FX_ENABLE_TEST_AUTH: '1',
        FX_GITHUB_AUTHORIZE_URL: 'http://127.0.0.1:4610/authorize',
      } as unknown as NodeJS.ProcessEnv),
    ).toBeUndefined();
  });

  it('ignores the override when VERCEL_ENV is set, even with the opt-in flag set', () => {
    expect(
      resolveGithubAuthorizeUrlOverride({
        NODE_ENV: 'test',
        VERCEL_ENV: 'preview',
        FX_ENABLE_TEST_AUTH: '1',
        FX_GITHUB_AUTHORIZE_URL: 'http://127.0.0.1:4610/authorize',
      } as unknown as NodeJS.ProcessEnv),
    ).toBeUndefined();
  });

  it('ignores the override when FX_ENABLE_TEST_AUTH is not exactly "1"', () => {
    expect(
      resolveGithubAuthorizeUrlOverride({
        NODE_ENV: 'test',
        FX_GITHUB_AUTHORIZE_URL: 'http://127.0.0.1:4610/authorize',
      } as unknown as NodeJS.ProcessEnv),
    ).toBeUndefined();
  });
});

describe('GitHubOAuthProvider.getAuthorizationUrl authorize-host override', () => {
  const baseConfig = {
    clientId: 'id',
    clientSecret: 'secret',
    callbackUrl: 'https://example.test/callback',
  };

  it('uses the real github.com authorize URL when githubOAuthConfigFromEnv sees no override', () => {
    const config = githubOAuthConfigFromEnv({
      FX_GITHUB_CLIENT_ID: 'id',
      FX_GITHUB_CLIENT_SECRET: 'secret',
      FX_GITHUB_CALLBACK_URL: baseConfig.callbackUrl,
      NODE_ENV: 'test',
    } as unknown as NodeJS.ProcessEnv);
    const provider = new GitHubOAuthProvider(config, vi.fn());
    const url = new URL(provider.getAuthorizationUrl('csrf-state'));
    expect(url.origin + url.pathname).toBe(GITHUB_AUTHORIZE_URL);
  });

  it('redirects to the fake local authorize URL end-to-end when the env allows the override', () => {
    const config = githubOAuthConfigFromEnv({
      FX_GITHUB_CLIENT_ID: 'id',
      FX_GITHUB_CLIENT_SECRET: 'secret',
      FX_GITHUB_CALLBACK_URL: baseConfig.callbackUrl,
      NODE_ENV: 'test',
      FX_ENABLE_TEST_AUTH: '1',
      FX_GITHUB_AUTHORIZE_URL: 'http://127.0.0.1:4610/authorize',
    } as unknown as NodeJS.ProcessEnv);
    const provider = new GitHubOAuthProvider(config, vi.fn());
    const url = new URL(provider.getAuthorizationUrl('csrf-state'));
    expect(url.origin + url.pathname).toBe('http://127.0.0.1:4610/authorize');
    // The override only swaps the host -- the same client_id/redirect_uri/state
    // params still get attached, matching the real-URL assertions above.
    expect(url.searchParams.get('client_id')).toBe('id');
    expect(url.searchParams.get('redirect_uri')).toBe(baseConfig.callbackUrl);
    expect(url.searchParams.get('state')).toBe('csrf-state');
  });

  it('falls back to github.com end-to-end even with the override var set, when NODE_ENV=production', () => {
    const config = githubOAuthConfigFromEnv({
      FX_GITHUB_CLIENT_ID: 'id',
      FX_GITHUB_CLIENT_SECRET: 'secret',
      FX_GITHUB_CALLBACK_URL: baseConfig.callbackUrl,
      NODE_ENV: 'production',
      FX_ENABLE_TEST_AUTH: '1',
      FX_GITHUB_AUTHORIZE_URL: 'http://127.0.0.1:4610/authorize',
    } as unknown as NodeJS.ProcessEnv);
    const provider = new GitHubOAuthProvider(config, vi.fn());
    const url = new URL(provider.getAuthorizationUrl('csrf-state'));
    expect(url.origin + url.pathname).toBe(GITHUB_AUTHORIZE_URL);
  });
});
