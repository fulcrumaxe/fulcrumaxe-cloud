import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { VercelEnvSource } from '../../src/setup-requests/checks.js';
import { createVercelEnvSource, VERCEL_USER_AGENT, type VercelCredentialResolver, type VercelEnvSourceOptions } from '../../src/setup-requests/vercelEnvSource.js';

/**
 * A strict stand-in for Vercel's project environment-variable listing (`GET /v10/projects/{idOrName}/env`), spoken over HTTP so the real
 * adapter (src/setup-requests/vercelEnvSource.ts) runs against it, either through an in-process `fetch` ({@link FakeVercel.source}) or over a
 * real socket ({@link FakeVercel.listen}). It enforces what the real API does that our code touches:
 *  - `Authorization: Bearer <token>` with a token that is currently connected, otherwise 401; a token scoped to a team needs that `teamId`
 *    query, otherwise 403; a request with no `User-Agent` header is refused (403);
 *  - the project name is a real Vercel name (lowercase letters, digits, `.`, `_`, `-`; at most 100 characters; no `---`), otherwise 400; an
 *    unknown project is 404, never an empty list;
 *  - a listing carries what Vercel's does, including the fields our code must NOT keep: every entry has an id, a type, a `value` (plain
 *    variables return their value; encrypted ones ciphertext; sensitive ones none) and a `target` that is an array of `production`, `preview`,
 *    `development` (older projects: a single string);
 *  - it pages (ASSUMED: Vercel's published reference for this endpoint does not list `limit`, `until` or `pagination`): newest first, `limit` as a
 *    hint with no invented bounds, an `until` cursor, `pagination: { count, next, prev }` with `next` null on the last page. `ignoresPagingParams`
 *    models an API that ignores `until`;
 *  - names only: `decrypt=true` is REFUSED (400). That is our own guard, not a documented Vercel rule: a change that starts asking for values fails
 *    here. The fake also records every query it was sent;
 *  - failures are failures: 401/403/404/429 (with retry-after)/500, a body that is not JSON, a body that is not the listing, a dropped connection
 *    and a call that never answers are all available through {@link FakeVercel.failNext}.
 * What it cannot fake faithfully: Vercel's TLS (the socket is plain http on loopback), its real rate-limit thresholds and team scoping beyond
 * the `teamId` rule above. The PR says so.
 */

export interface FakeVercelEnv {
  key: string;
  value: string;
  target: string[] | string;
  type?: 'plain' | 'encrypted' | 'sensitive';
}

export interface FakeVercelCall {
  /** The account the request's token belongs to, null for an unknown token. */
  accountId: string | null;
  project: string;
  query: string;
  userAgent: string | null;
}

export type FakeFailure = 'http_401' | 'http_403' | 'http_404' | 'http_429' | 'http_500' | 'bad_json' | 'bad_body' | 'throw' | 'hang';

interface Answer {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  raw?: string;
}

export class FakeVercel {
  readonly calls: FakeVercelCall[] = [];
  /** Page size the fake uses when the request asks for more (a server may cap `limit`); tests lower it to force paging. */
  pageSize = 100;
  /** Models an API that ignores `until`: every call answers the first page, with a `next` cursor while more remain. */
  ignoresPagingParams = false;
  private readonly projects = new Map<string, FakeVercelEnv[]>();
  /** account -> token, for accounts that have a connection. */
  private readonly tokens = new Map<string, { token: string; teamId?: string }>();
  private readonly revoked = new Set<string>();
  private failing: { mode: FakeFailure; remaining: number } | null = null;

  connect(accountId: string, opts: { teamId?: string } = {}): this {
    this.tokens.set(accountId, { token: `vtok_${accountId}`, ...(opts.teamId !== undefined ? { teamId: opts.teamId } : {}) });
    this.revoked.delete(`vtok_${accountId}`);
    return this;
  }
  /** The token stops working at Vercel, but the account's lookup still hands it out (a revoked token the platform has not noticed yet). */
  revoke(accountId: string): this {
    const t = this.tokens.get(accountId);
    if (t) this.revoked.add(t.token);
    return this;
  }
  /** The account loses its connection: the lookup answers unavailable. */
  disconnect(accountId: string): this {
    this.tokens.delete(accountId);
    return this;
  }
  project(name: string, envs: FakeVercelEnv[] = []): this {
    this.projects.set(name, envs);
    return this;
  }
  setVar(project: string, env: FakeVercelEnv): this {
    const list = this.projects.get(project);
    if (!list) throw new Error(`no such fake project ${project}`);
    const at = list.findIndex((e) => e.key === env.key);
    if (at >= 0) list[at] = env;
    else list.push(env);
    return this;
  }
  removeVar(project: string, key: string): this {
    this.projects.set(project, (this.projects.get(project) ?? []).filter((e) => e.key !== key));
    return this;
  }
  failNext(mode: FakeFailure, times = 1): this {
    this.failing = { mode, remaining: times };
    return this;
  }

  /** The credential lookup the adapter is given: an account with a connection gets its token; one without gets `unavailable`. */
  resolver(): VercelCredentialResolver {
    return {
      configured: true,
      resolve: async (accountId) => {
        const t = this.tokens.get(accountId);
        return t === undefined ? { status: 'unavailable' } : { status: 'ok', token: t.token, ...(t.teamId !== undefined ? { teamId: t.teamId } : {}) };
      },
    };
  }

  private accountOf(token: string): string | null {
    for (const [account, t] of this.tokens) if (t.token === token) return account;
    return null;
  }

  /** The HTTP-shaped answer for a request, as the real API would send it. */
  handle(req: { method: string; url: string; headers: Record<string, string | undefined> }): Answer {
    const url = new URL(req.url, 'http://fake.invalid');
    const match = /^\/v10\/projects\/([^/]+)\/env$/.exec(url.pathname);
    const project = match ? decodeURIComponent(match[1]!) : '';
    const bearer = /^Bearer (.+)$/.exec(req.headers['authorization'] ?? '')?.[1] ?? null;
    this.calls.push({ accountId: bearer === null ? null : this.accountOf(bearer), project, query: url.searchParams.toString(), userAgent: req.headers['user-agent'] ?? null });
    if (this.failing && this.failing.remaining > 0) {
      this.failing.remaining -= 1;
      const mode = this.failing.mode;
      if (mode === 'throw' || mode === 'hang') return { status: -1, body: mode };
      if (mode === 'bad_json') return { status: 200, body: null, raw: '{"envs": [' };
      if (mode === 'bad_body') return { status: 200, body: { unexpected: true } };
      const status = Number(mode.slice(5));
      return { status, body: { error: { code: 'failure' } }, ...(status === 429 ? { headers: { 'retry-after': '30' } } : {}) };
    }
    if (req.method !== 'GET' || !match) return { status: 404, body: { error: { code: 'not_found' } } };
    const account = bearer === null ? null : this.accountOf(bearer);
    if (bearer === null || account === null || this.revoked.has(bearer)) return { status: 401, body: { error: { code: 'forbidden' } } };
    if (!req.headers['user-agent']) return { status: 403, body: { error: { code: 'forbidden', message: 'a User-Agent header is required' } } };
    const team = this.tokens.get(account)!.teamId;
    if (team !== undefined && url.searchParams.get('teamId') !== team) return { status: 403, body: { error: { code: 'forbidden' } } };
    if (!/^[a-z0-9._-]{1,100}$/.test(project) || project.includes('---')) return { status: 400, body: { error: { code: 'bad_request' } } };
    if (url.searchParams.getAll('decrypt').includes('true')) return { status: 400, body: { error: { code: 'bad_request', message: 'decrypt is not allowed' } } };
    // `limit` and `until` are not in Vercel's published reference for this endpoint; the fake treats them as hints and invents no bounds.
    const limitNumber = Number(url.searchParams.get('limit'));
    const limit = Number.isInteger(limitNumber) && limitNumber >= 1 ? limitNumber : this.pageSize;
    const rawUntil = url.searchParams.get('until');
    const untilText = this.ignoresPagingParams || rawUntil === null || !/^\d{1,15}$/.test(rawUntil) ? null : rawUntil;
    const envs = this.projects.get(project);
    if (!envs) return { status: 404, body: { error: { code: 'not_found' } } };
    // Newest first; `createdAt` descends with the position, so it is the cursor.
    const all = envs.map((e, i) => ({ e, i, createdAt: 1_700_000_000_000 + (envs.length - i) * 1000 }));
    const rest = untilText === null ? all : all.filter((x) => x.createdAt < Number(untilText));
    const size = Math.min(limit, this.pageSize);
    const page = rest.slice(0, size);
    const more = rest.length > page.length;
    return {
      status: 200,
      body: {
        envs: page.map(({ e, i, createdAt }) => ({
          id: `env_${i}`,
          key: e.key,
          value: e.type === 'sensitive' ? undefined : e.type === 'encrypted' ? `enc:${e.value}` : e.value,
          type: e.type ?? 'plain',
          target: e.target,
          createdAt,
        })),
        pagination: { count: page.length, next: more ? page[page.length - 1]!.createdAt : null, prev: untilText === null ? null : Number(untilText) },
      },
    };
  }

  /** A `fetch` that speaks to {@link handle} in-process. `throw` rejects like a dropped socket; `hang` never answers until the caller's signal aborts. */
  fetchImpl(): typeof fetch {
    return (async (input: unknown, init?: RequestInit) => {
      const url = String(input instanceof URL ? input.href : input);
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
      const answer = this.handle({ method: init?.method ?? 'GET', url, headers });
      if (answer.status === -1) {
        if (answer.body === 'throw') throw new TypeError('fetch failed');
        const signal = init?.signal;
        return new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));
      }
      return new Response(answer.raw ?? JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json', ...answer.headers } });
    }) as typeof fetch;
  }

  /** The real adapter, bound to this fake in-process. */
  source(opts: Partial<VercelEnvSourceOptions> = {}): VercelEnvSource {
    return createVercelEnvSource({ credentials: this.resolver(), fetch: this.fetchImpl(), log: () => undefined, ...opts });
  }

  /** The same fake behind a real local socket, for tests of the adapter's own network behaviour (timeouts, redirects, connection errors). */
  async listen(): Promise<{ baseUrl: string; close(): Promise<void> }> {
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(',') : v;
      const answer = this.handle({ method: req.method ?? 'GET', url: req.url ?? '/', headers });
      if (answer.status === -1) {
        if (answer.body === 'throw') req.socket.destroy();
        return; // hang: never answer
      }
      res.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers });
      res.end(answer.raw ?? JSON.stringify(answer.body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return {
      baseUrl: `http://127.0.0.1:${port}`,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  }

  /** Drives the same strict `handle` with a hostile query, to prove the fake would refuse value requests. */
  rawRequest(accountId: string, project: string, query: string): { status: number; body: unknown } {
    const token = this.tokens.get(accountId)?.token ?? 'unknown';
    const { status, body } = this.handle({ method: 'GET', url: `/v10/projects/${encodeURIComponent(project)}/env?${query}`, headers: { authorization: `Bearer ${token}`, 'user-agent': VERCEL_USER_AGENT } });
    return { status, body };
  }
}
