import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { GitHubOAuthProvider } from '../../src/auth/provider.js';
// Relative on purpose: the strict GitHub fake is shared test support and lives with the @fx/github tests.
import { strictGithubFetch } from '../../../github/test/helpers/strictGithub.js';
// @ts-expect-error plain JS module, no declarations
import { startFakeGithubAuthorize } from '../../../../apps/workspace/e2e/fake-github-authorize.mjs';

/**
 * The human sign-in flow against fakes that are as strict as GitHub: the token exchange and the user
 * calls go through the shared strict `fetch` fake, and the authorize redirect is answered by the e2e
 * authorize stand-in, which now refuses what github.com refuses.
 */
const config = { clientId: 'Iv1.id', clientSecret: 'secret', callbackUrl: 'https://example.test/callback' };

function github(opts: { publicEmail: boolean }) {
  const seen: string[] = [];
  const fetchImpl = strictGithubFetch((async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    seen.push(u);
    if (u === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'gho_fake' });
    if (u === 'https://api.github.com/user') return Response.json({ id: 42, login: 'octocat', email: opts.publicEmail ? 'octocat@example.test' : null, name: 'Octo' });
    if (u === 'https://api.github.com/user/emails') return Response.json([{ email: 'primary@example.test', primary: true, verified: true }]);
    void init;
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch);
  return { fetchImpl, seen };
}

describe('GitHubOAuthProvider.exchangeCode against the strict GitHub fake', () => {
  it('signs in with a public email: JSON token exchange, then /user with a bearer token', async () => {
    const gh = github({ publicEmail: true });
    const identity = await new GitHubOAuthProvider(config, gh.fetchImpl).exchangeCode('code');
    expect(identity).toEqual({ githubUserId: 42, email: 'octocat@example.test', name: 'Octo', githubLogin: 'octocat' });
    expect(gh.seen).toEqual(['https://github.com/login/oauth/access_token', 'https://api.github.com/user']);
  });

  it('falls back to /user/emails, which GitHub also serves only to an authenticated caller', async () => {
    const gh = github({ publicEmail: false });
    const identity = await new GitHubOAuthProvider(config, gh.fetchImpl).exchangeCode('code');
    expect(identity.email).toBe('primary@example.test');
  });

  it('is refused if the user calls ever lose their bearer token (the lenient mocks never noticed)', async () => {
    const gh = github({ publicEmail: true });
    const stripAuth = ((url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.delete('authorization');
      return gh.fetchImpl(url, { ...init, headers });
    }) as typeof fetch;
    await expect(new GitHubOAuthProvider(config, stripAuth).exchangeCode('code')).rejects.toThrow(/\/user failed: 401/);
  });
});

describe('the e2e authorize stand-in refuses what github.com refuses', () => {
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await stop?.();
    stop = undefined;
  });

  async function start() {
    const fake = await startFakeGithubAuthorize({ port: 0, callbackBase: 'http://127.0.0.1:9' });
    stop = fake.stop;
    return fake as { authorizeUrl: string; server: { address(): AddressInfo } };
  }
  const get = (url: string, init: RequestInit = {}) => fetch(url, { redirect: 'manual', ...init });

  it('redirects the exact URL the app builds', async () => {
    const fake = await start();
    const provider = new GitHubOAuthProvider({ ...config, authorizeUrl: fake.authorizeUrl }, (() => {
      throw new Error('no network');
    }) as unknown as typeof fetch);
    const res = await get(provider.getAuthorizationUrl('csrf-state'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/api/auth/test/callback');
  });

  it('answers 404 without a client_id, 422 for a redirect_uri that is not a URL, 400 without state, 404 for a POST', async () => {
    const fake = await start();
    expect((await get(`${fake.authorizeUrl}?state=s`)).status).toBe(404);
    expect((await get(`${fake.authorizeUrl}?client_id=x&state=s&redirect_uri=not-a-url`)).status).toBe(422);
    expect((await get(`${fake.authorizeUrl}?client_id=x`)).status).toBe(400);
    expect((await get(`${fake.authorizeUrl}?client_id=x&state=s`, { method: 'POST' })).status).toBe(404);
  });
});
