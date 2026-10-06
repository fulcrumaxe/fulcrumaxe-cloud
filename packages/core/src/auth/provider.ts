/** What sign-in/sign-up needs from an external identity, regardless of provider. */
export interface ExternalIdentity {
  githubUserId: number;
  email: string;
  name: string | null;
  /** D#37 WS-C1 criterion 3 (correction C8): the GitHub login handle (`octocat`), distinct from `name` (free-text display name). GitHub's own /user response always has this for an authenticated request, so it is never null here -- unlike `name`, which a user can leave blank. */
  githubLogin: string;
}

/**
 * H06 pass/fail item 1: "An AuthProvider interface has a GitHub OAuth
 * implementation (config from env) and a test-only provider that refuses
 * when NODE_ENV=production." Every provider resolves to the same shape
 * (ExternalIdentity) so sign-up/sign-in (identity.ts) never branches on
 * which provider authenticated the request.
 */
export interface AuthProvider {
  readonly name: string;
  /** The URL to redirect the browser to, carrying `state` for CSRF verification on return. */
  getAuthorizationUrl(state: string): string;
  /** Exchanges the provider's callback `code` for a stable external identity. */
  exchangeCode(code: string): Promise<ExternalIdentity>;
}

export interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Must exactly match the "Authorization callback URL" registered on the GitHub App/OAuth App. */
  callbackUrl: string;
  /**
   * D#37 WS-C2 fix round 2 (criterion 15, owner ruling 2026-09-24,
   * C15e): a dev/test-only override for the authorize URL, set ONLY when
   * {@link resolveGithubAuthorizeUrlOverride} decides the env allows it.
   * Undefined means "use the real github.com authorize URL" -- see
   * `getAuthorizationUrl` below. Never set from a real GitHub App/OAuth
   * App config; this exists purely so a local milestone run can point
   * the authorize redirect at a tiny local fake instead of github.com.
   */
  authorizeUrl?: string;
}

/** The real GitHub OAuth authorize endpoint. Always used unless {@link resolveGithubAuthorizeUrlOverride} returns an override. */
export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';

/**
 * D#37 WS-C2 fix round 2 (criterion 15, owner ruling 2026-09-24, C15e):
 * the ONLY stand-in this milestone is allowed to use -- the GitHub
 * OAuth AUTHORIZE host -- and only for a local milestone run, never for
 * a real deployment. Gated with the exact same discipline
 * `TestOnlyProvider` already uses (security fix round item 6), reusing
 * its own opt-in flag rather than inventing a second one: the override
 * is read ONLY when `FX_ENABLE_TEST_AUTH=1`, and even then is refused
 * whenever `NODE_ENV=production` or `VERCEL_ENV` is set. A production
 * build (`next build`/`next start` with no operator override of
 * NODE_ENV) always has `NODE_ENV=production`, so it always falls back
 * to the real github.com URL even if `FX_GITHUB_AUTHORIZE_URL` is left
 * set in its environment by mistake -- there is no path through this
 * function that returns anything but `undefined` once NODE_ENV is
 * 'production' or VERCEL_ENV is set, regardless of the other two vars.
 */
export function resolveGithubAuthorizeUrlOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.FX_GITHUB_AUTHORIZE_URL;
  if (!override) return undefined;
  if (env.NODE_ENV === 'production' || env.VERCEL_ENV || env.FX_ENABLE_TEST_AUTH !== '1') return undefined;
  return override;
}

/**
 * Reads GitHub OAuth config from env. Throws (rather than returning a
 * provider that would fail on first use) when a required var is unset --
 * a live GitHub sign-in is a Wave-2 LIVE-NEEDS item (owner blocker 2:
 * GitHub App registration), so this failing loudly at construction time
 * is deliberate: nothing downstream should discover a missing client
 * secret mid-flow.
 */
export function githubOAuthConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GitHubOAuthConfig {
  const clientId = env.FX_GITHUB_CLIENT_ID;
  const clientSecret = env.FX_GITHUB_CLIENT_SECRET;
  const callbackUrl = env.FX_GITHUB_CALLBACK_URL;
  if (!clientId || !clientSecret || !callbackUrl) {
    throw new Error(
      'FX_GITHUB_CLIENT_ID, FX_GITHUB_CLIENT_SECRET and FX_GITHUB_CALLBACK_URL must all be set',
    );
  }
  return { clientId, clientSecret, callbackUrl, authorizeUrl: resolveGithubAuthorizeUrlOverride(env) };
}

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

/**
 * GitHub OAuth (not the GitHub App installation flow -- that's H13's
 * proxy/installation-token concern; this is the human sign-in redirect).
 * `fetchImpl` is injectable so tests never make a real network call
 * (root `pnpm test` must make zero external calls -- see the
 * FX_FORBID_MODEL_CALLS guard this repo already runs under, which this
 * mirrors in spirit even though GitHub isn't a model endpoint).
 */
/**
 * A sign-in that failed because of what the caller brought (a stale or garbage code, an account with no verified
 * email), not because anything on our side or GitHub's is down. The callback answers it and does not report it.
 */
export class SignInRefusedError extends Error {
  readonly callerCaused = true;
  constructor(message: string) {
    super(message);
    this.name = 'SignInRefusedError';
  }
}

export class GitHubOAuthProvider implements AuthProvider {
  readonly name = 'github';

  constructor(
    private readonly config: GitHubOAuthConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  getAuthorizationUrl(state: string): string {
    const url = new URL(this.config.authorizeUrl ?? GITHUB_AUTHORIZE_URL);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.config.callbackUrl);
    url.searchParams.set('scope', 'read:user user:email');
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeCode(code: string): Promise<ExternalIdentity> {
    const tokenRes = await this.fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: this.config.callbackUrl,
      }),
    });
    if (!tokenRes.ok) {
      throw new Error(`GitHub token exchange failed: ${tokenRes.status}`);
    }
    const tokenBody = (await tokenRes.json()) as { access_token?: string; error?: string };
    if (!tokenBody.access_token) {
      const reason = `GitHub token exchange returned no access_token: ${tokenBody.error ?? 'unknown error'}`;
      // GitHub answers 200 with this error for a code that is stale, reused or made up: the caller's, not an outage.
      throw tokenBody.error === 'bad_verification_code' ? new SignInRefusedError(reason) : new Error(reason);
    }

    const authHeaders = {
      Authorization: `Bearer ${tokenBody.access_token}`,
      Accept: 'application/vnd.github+json',
    };

    const userRes = await this.fetchImpl('https://api.github.com/user', { headers: authHeaders });
    if (!userRes.ok) {
      throw new Error(`GitHub /user failed: ${userRes.status}`);
    }
    const user = (await userRes.json()) as { id: number; login: string; email: string | null; name: string | null };

    let email = user.email;
    if (!email) {
      const emailsRes = await this.fetchImpl('https://api.github.com/user/emails', {
        headers: authHeaders,
      });
      if (emailsRes.ok) {
        const emails = (await emailsRes.json()) as GitHubEmail[];
        email = emails.find((e) => e.primary && e.verified)?.email ?? emails.find((e) => e.verified)?.email ?? null;
      }
    }
    if (!email) {
      throw new SignInRefusedError('GitHub account has no accessible verified email address');
    }

    return { githubUserId: user.id, email, name: user.name, githubLogin: user.login };
  }
}

/**
 * A fixed-identity provider for local dev and tests, never for a real
 * sign-in. Refuses at construction time (H06 pass/fail item 1) --
 * deliberately in the constructor, not in exchangeCode, so a
 * misconfigured deployment fails at startup/wiring time rather than on
 * the first request that reaches it.
 *
 * Security fix round item 6: this used to be a blocklist --
 * `NODE_ENV === 'production'` -- so the route was open whenever NODE_ENV
 * was unset OR 'development', and `next dev` listens on all interfaces
 * by default. Closed by default now: the caller must explicitly opt in
 * with `FX_ENABLE_TEST_AUTH=1`, which by itself is refused wherever
 * `VERCEL_ENV` is set (a real Vercel deployment, preview or production)
 * so a deployed environment can never enable this by accident, and
 * `NODE_ENV=production` is refused unconditionally as a second,
 * independent guard.
 */
export class TestOnlyProvider implements AuthProvider {
  readonly name = 'test-only';

  constructor(
    private readonly fixedIdentity: ExternalIdentity,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    if (env.NODE_ENV === 'production' || env.VERCEL_ENV || env.FX_ENABLE_TEST_AUTH !== '1') {
      throw new Error(
        'TestOnlyProvider requires FX_ENABLE_TEST_AUTH=1, and refuses when NODE_ENV=production or VERCEL_ENV is set',
      );
    }
  }

  getAuthorizationUrl(): string {
    return '/api/auth/test/callback';
  }

  async exchangeCode(): Promise<ExternalIdentity> {
    return this.fixedIdentity;
  }
}
