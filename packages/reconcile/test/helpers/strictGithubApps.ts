import { createHash, createPublicKey, createVerify, generateKeyPairSync, randomBytes } from 'node:crypto';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import type { AccessTokenRequester } from '@fx/github';
import { ghError, type GhReply, type GhRequest } from '../../../github/test/helpers/strictGithub.js';
import { startStrictGithubServer, type LocalTlsServer } from '../../../github/test/helpers/localTlsServer.js';

/**
 * GitHub's App-level API for three Apps (`team`, `team_readonly`, `sitekit`), served over real TLS so the code under
 * test reaches it through Node's real connection path. On top of the shared strict rules (User-Agent, Accept, API
 * version, a well-formed App JWT, JSON errors) it enforces what only this job touches:
 *  - the JWT must be signed by one of the three Apps' keys and carry that App's id as `iss`; anything else is 401;
 *  - an App sees only ITS installations: `GET /app/installations` lists them, and `GET /app/installations/{id}` for an
 *    installation that belongs to another App answers 404, exactly what the real service does when the JWT is the
 *    wrong kind's;
 *  - the list is cut at 100 per page, with a `Link` header carrying rel="next" while more remain, and `suspended_at` is
 *    null or a timestamp;
 *  - `GET /app` answers the calling App's own id and slug (`appSlugs[kind]`, overridable per test through
 *    `world.slugs`), and a JWT that does not verify answers 401 as for every other path;
 *  - 403 with `retry-after` (the secondary rate limit), 429 and 5xx on demand (`world.failNext`);
 *  - the repo re-sync's two calls (D#454 H2c): `POST /app/installations/{id}/access_tokens` (App JWT; 404 for an installation
 *    of another App's) mints a token that works only for that installation, and `GET /installation/repositories` with it
 *    lists that installation's repositories (`world.repos`), 100 per page with `total_count` and a `Link` header. Every
 *    page carries a weak `ETag` of its body, and `If-None-Match` answers 304 with no body, as GitHub does; a JWT is not
 *    accepted on the listing and an installation token is not accepted on `/app/...`.
 *
 * Not faked faithfully (the PR says so): GitHub's real primary and secondary rate-limit thresholds, the full
 * installation and repository objects (only the fields our code reads), the exact wording of every message, and whether
 * real GitHub's ETags stay valid across two different installation tokens (here they do, as they hash the body only).
 */
export type AppKind = 'team' | 'team_readonly' | 'sitekit';
export const APP_KINDS: readonly AppKind[] = ['team', 'team_readonly', 'sitekit'];
/** The slug each fake App reports on `GET /app` unless a test overrides it in `world.slugs`. */
export const APP_SLUGS: Readonly<Record<AppKind, string>> = { team: 'fx-team', team_readonly: 'fx-team-readonly', sitekit: 'fx-sitekit' };

export interface FakeInstallation {
  id: number;
  kind: AppKind;
  suspended: boolean;
}

export interface FailRule {
  status: number;
  headers?: Record<string, string>;
  /** Only a request whose path matches; default any. */
  match?: RegExp;
  /** Only a request whose query string matches (e.g. page 2 of a listing); default any. */
  query?: RegExp;
  /** Let this many matching requests through first (the rule then fires on the next one); default 0. */
  skip?: number;
}

export interface FakeRepo {
  id: number;
  name: string;
  owner: string;
}

export interface AppWorld {
  installations: FakeInstallation[];
  /** The repositories each installation (by GitHub installation id) can see. */
  repos: Record<number, FakeRepo[]>;
  /** Answer the next matching requests with these, in order, then carry on. */
  failNext: FailRule[];
  /** What `GET /app` reports as `slug` per kind; defaults to APP_SLUGS. A test sets one to model a swapped or wrong key. */
  slugs: Record<AppKind, string>;
}

export interface AppKeys {
  appId: number;
  privateKeyPem: string;
  publicKeyPem: string;
}

export interface SeenCall {
  /** Which App the JWT said it was (null when it did not verify). */
  as: AppKind | null;
  path: string;
  query: string;
  method?: string;
  /** The If-None-Match the request carried. */
  ifNoneMatch?: string;
}

export interface StrictGithubApps {
  port: number;
  ca: string;
  keys: Record<AppKind, AppKeys>;
  world: AppWorld;
  calls: SeenCall[];
  server: LocalTlsServer;
  /** A lookup that maps api.github.com to this server and honours `{ all: true }`, as Node's connect path calls it. */
  lookup: LookupFunction;
  /** `fetch` over the same TLS path (explicit `ca`, the lookup above). A 304 answers with no body, as a real one does. */
  fetch: typeof fetch;
  /** The mint call, with the shape of the production requester. */
  requester: AccessTokenRequester;
  close(): Promise<void>;
}

const b64urlJson = (seg: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
};

export async function startStrictGithubApps(): Promise<StrictGithubApps> {
  const keys = {} as Record<AppKind, AppKeys>;
  APP_KINDS.forEach((kind, i) => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    keys[kind] = { appId: 1_000_001 + i, privateKeyPem: privateKey, publicKeyPem: publicKey };
  });
  const world: AppWorld = { installations: [], repos: {}, failNext: [], slugs: { ...APP_SLUGS } };
  const tokens = new Map<string, { id: number; kind: AppKind }>();
  const calls: SeenCall[] = [];

  function appOf(jwt: string): AppKind | null {
    const [h, p, s] = jwt.split('.');
    if (!h || !p || !s) return null;
    const claims = b64urlJson(p);
    const kind = APP_KINDS.find((k) => String(keys[k].appId) === String(claims?.iss));
    if (!kind) return null;
    const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(createPublicKey(keys[kind].publicKeyPem), Buffer.from(s, 'base64url'));
    return ok ? kind : null;
  }

  const route = (req: GhRequest): GhReply => {
    const jwt = /^bearer (\S+)$/i.exec(req.headers['authorization'] ?? '')?.[1] ?? '';
    const inst = tokens.get(jwt);
    const as = appOf(jwt) ?? inst?.kind ?? null;
    calls.push({
      as,
      path: req.path,
      query: req.query ?? '',
      ...(req.method !== 'GET' ? { method: req.method } : {}),
      ...(req.headers['if-none-match'] ? { ifNoneMatch: req.headers['if-none-match'] } : {}),
    });

    const rule = world.failNext[0];
    if (rule && (!rule.match || rule.match.test(req.path)) && (!rule.query || rule.query.test(req.query ?? '')) && (rule.skip ?? 0) > 0) {
      rule.skip = (rule.skip ?? 0) - 1;
    } else if (rule && (!rule.match || rule.match.test(req.path)) && (!rule.query || rule.query.test(req.query ?? ''))) {
      world.failNext.shift();
      const r = ghError(rule.status, rule.status === 403 ? 'You have exceeded a secondary rate limit.' : 'Server Error');
      return { ...r, headers: { ...r.headers, ...(rule.headers ?? {}) } };
    }
    const json = (status: number, body: unknown, headers: Record<string, string> = {}): GhReply => ({
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
      body: JSON.stringify(body),
    });

    if (req.path === '/installation/repositories') {
      if (!inst) return ghError(401, 'Bad credentials');
      if (req.method !== 'GET') return ghError(404, 'Not Found');
      const all = world.repos[inst.id] ?? [];
      const q = new URLSearchParams(req.query ?? '');
      const perPage = Math.min(100, Math.max(1, Number(q.get('per_page') ?? 30) || 30));
      const page = Math.max(1, Number(q.get('page') ?? 1) || 1);
      const last = Math.max(1, Math.ceil(all.length / perPage));
      const link = (n: number, rel: string) => `<https://api.github.com/installation/repositories?per_page=${perPage}&page=${n}>; rel="${rel}"`;
      const body = JSON.stringify({
        total_count: all.length,
        repositories: all.slice((page - 1) * perPage, page * perPage).map((r) => ({ id: r.id, name: r.name, owner: { login: r.owner } })),
      });
      const etag = `W/"${createHash('sha1').update(body).digest('hex')}"`;
      if (req.headers['if-none-match']?.split(',').some((t) => t.trim() === etag)) return { status: 304, headers: { etag }, body: '' };
      const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', etag };
      if (page < last) headers['link'] = `${link(page + 1, 'next')}, ${link(last, 'last')}`;
      return { status: 200, headers, body };
    }
    if (!as || inst) return ghError(401, 'A JSON web token could not be decoded');

    const mint = /^\/app\/installations\/([0-9]+)\/access_tokens$/.exec(req.path);
    if (mint) {
      if (req.method !== 'POST') return ghError(404, 'Not Found');
      const found = world.installations.find((i) => i.id === Number(mint[1]) && i.kind === as);
      if (!found) return ghError(404, 'Not Found');
      const token = `ghs_${randomBytes(12).toString('hex')}`;
      tokens.set(token, { id: found.id, kind: found.kind });
      return json(201, { token, expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: { metadata: 'read' }, repository_selection: 'all' });
    }
    if (req.method !== 'GET') return ghError(404, 'Not Found');

    const mine = world.installations.filter((i) => i.kind === as).sort((a, b) => a.id - b.id);
    const shape = (i: FakeInstallation) => ({
      id: i.id,
      app_id: keys[i.kind].appId,
      // Free text GitHub sends that must never reach our logs or error classes.
      account: { login: `octo-org-${i.id}`, type: 'Organization' },
      suspended_at: i.suspended ? '2026-10-01T00:00:00Z' : null,
    });

    if (req.path === '/app') return json(200, { id: keys[as].appId, slug: world.slugs[as], name: `Fake ${as}` });

    if (req.path === '/app/installations') {
      const q = new URLSearchParams(req.query ?? '');
      const perPage = Math.min(100, Math.max(1, Number(q.get('per_page') ?? 30) || 30));
      const page = Math.max(1, Number(q.get('page') ?? 1) || 1);
      const last = Math.max(1, Math.ceil(mine.length / perPage));
      const link = (n: number, rel: string) => `<https://api.github.com/app/installations?per_page=${perPage}&page=${n}>; rel="${rel}"`;
      const headers: Record<string, string> = page < last ? { link: `${link(page + 1, 'next')}, ${link(last, 'last')}` } : {};
      return json(200, mine.slice((page - 1) * perPage, page * perPage).map(shape), headers);
    }
    const one = /^\/app\/installations\/([0-9]+)$/.exec(req.path);
    if (one) {
      const found = mine.find((i) => i.id === Number(one[1]));
      return found ? json(200, shape(found)) : ghError(404, 'Not Found');
    }
    return ghError(404, 'Not Found');
  };

  const server = await startStrictGithubServer(route);
  const lookup = ((_host: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) =>
    opts.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)) as unknown as LookupFunction;

  // Keep-alive only saves handshakes in tests that make hundreds of calls; the certificate and hostname are still checked on each connection.
  const agent = new https.Agent({ keepAlive: true });
  const tlsFetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    headers['user-agent'] ??= 'node';
    const body = init?.body === undefined || init.body === null ? undefined : String(init.body);
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
    return new Promise<Response>((resolve, reject) => {
      const req = https.request(
        { host: url.hostname, port: server.port, method: init?.method ?? 'GET', path: `${url.pathname}${url.search}`, headers, agent, ca: server.ca, servername: url.hostname, lookup, ...(init?.signal ? { signal: init.signal } : {}) },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const h = new Headers();
            for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : v);
            const noBody = res.statusCode === 204 || res.statusCode === 304;
            resolve(new Response(noBody ? null : Buffer.concat(chunks), { status: res.statusCode ?? 0, headers: h }));
          });
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }) as typeof fetch;

  const requester: AccessTokenRequester = async ({ installationId, appJwt, repositories, permissions }) => {
    const res = await tlsFetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: { authorization: `Bearer ${appJwt}`, accept: 'application/vnd.github+json', 'user-agent': 'fulcrumaxe-cloud', 'content-type': 'application/json' },
      body: JSON.stringify(repositories === null ? { permissions } : { repositories, permissions }),
    });
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) throw Object.assign(new Error('access_token_mint_failed'), { status: res.status });
    const parsed = JSON.parse(text) as { token?: string; expires_at?: string; permissions?: Record<string, string> };
    if (!parsed.token || !parsed.expires_at) throw new Error('access_token_mint_failed');
    return { token: parsed.token, expiresAt: parsed.expires_at, ...(parsed.permissions ? { permissions: parsed.permissions } : {}) };
  };

  return { port: server.port, ca: server.ca, keys, world, calls, server, lookup, fetch: tlsFetch, requester, close: async () => {
      agent.destroy();
      await server.close();
    } };
}
