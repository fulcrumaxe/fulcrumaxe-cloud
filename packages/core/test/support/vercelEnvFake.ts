import { envEntriesFromVercelListing, type VercelEnvListing, type VercelEnvSource } from '../../src/setup-requests/checks.js';

/**
 * A strict stand-in for Vercel's project environment-variable listing (`GET /v10/projects/{idOrName}/env`), behind the {@link VercelEnvSource}
 * port. It enforces what the real API does that our code touches:
 *  - the project name is a real Vercel name (lowercase letters, digits, `.`, `_`, `-`; at most 100 characters; no `---`), otherwise 400;
 *  - an unknown project is 404, and an account with no connection (no token) is 401, never an empty list;
 *  - a listing carries what Vercel's does, including the fields our code must NOT keep: every entry has an id, a type, a `value` (plain
 *    variables return their value; encrypted and sensitive ones return ciphertext or nothing) and a `target` that is an array of
 *    `production`, `preview`, `development` (older projects: a single string);
 *  - only names are asked for: the request never carries `decrypt=true`, and the fake REFUSES one (400), so a change that starts asking
 *    for values fails here;
 *  - a failure is a failure: 500 and a body that is not the listing shape are both answered, and the port must treat them as unavailable.
 * What it cannot fake faithfully: Vercel's TLS, rate limits, team scoping and the User-Agent rule belong to the HTTP adapter that
 * binds the port (D#598 P8d), which does not exist in this change; this fake covers the port contract and the listing's shape.
 */

export interface FakeVercelEnv {
  key: string;
  value: string;
  target: string[] | string;
  type?: 'plain' | 'encrypted' | 'sensitive';
}

export interface FakeVercelCall {
  accountId: string;
  project: string;
  query: string;
}

export class FakeVercel {
  readonly calls: FakeVercelCall[] = [];
  private readonly projects = new Map<string, FakeVercelEnv[]>();
  private readonly connected = new Set<string>();
  /** The next N responses fail with this (500 or a body that is not a listing). */
  private failing: { mode: 'http_500' | 'bad_body' | 'throw'; remaining: number } | null = null;

  connect(accountId: string): this {
    this.connected.add(accountId);
    return this;
  }
  disconnect(accountId: string): this {
    this.connected.delete(accountId);
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
  failNext(mode: 'http_500' | 'bad_body' | 'throw', times = 1): this {
    this.failing = { mode, remaining: times };
    return this;
  }

  /** The raw HTTP-shaped answer for a request, as the real API would send it. */
  private respond(accountId: string, project: string, query: string): { status: number; body: unknown } {
    if (this.failing && this.failing.remaining > 0) {
      this.failing.remaining -= 1;
      if (this.failing.mode === 'throw') throw new Error('socket hang up');
      return this.failing.mode === 'http_500' ? { status: 500, body: { error: { code: 'internal_server_error' } } } : { status: 200, body: { unexpected: true } };
    }
    if (!this.connected.has(accountId)) return { status: 401, body: { error: { code: 'forbidden' } } };
    if (!/^[a-z0-9._-]{1,100}$/.test(project) || project.includes('---')) return { status: 400, body: { error: { code: 'bad_request' } } };
    if (new URLSearchParams(query).get('decrypt') === 'true') return { status: 400, body: { error: { code: 'bad_request', message: 'decrypt is not allowed' } } };
    const envs = this.projects.get(project);
    if (!envs) return { status: 404, body: { error: { code: 'not_found' } } };
    return {
      status: 200,
      body: {
        envs: envs.map((e, i) => ({
          id: `env_${i}`,
          key: e.key,
          value: e.type === 'sensitive' ? undefined : e.type === 'encrypted' ? `enc:${e.value}` : e.value,
          type: e.type ?? 'plain',
          target: e.target,
          createdAt: 1_700_000_000_000,
        })),
      },
    };
  }

  /** The port, as the HTTP adapter will implement it: it asks for names (no decrypt) and keeps only what the listing parser keeps. */
  source(): VercelEnvSource {
    return {
      available: true,
      listEnvNames: async ({ accountId, project }): Promise<VercelEnvListing> => {
        const query = 'target=&gitBranch=&source=';
        this.calls.push({ accountId, project, query });
        const answer = this.respond(accountId, project, query);
        if (answer.status !== 200) return { ok: false };
        const entries = envEntriesFromVercelListing(answer.body);
        return entries === null ? { ok: false } : { ok: true, entries };
      },
    };
  }

  /** Drives the same strict `respond` with a hostile query, to prove the fake would refuse value requests. */
  rawRequest(accountId: string, project: string, query: string): { status: number; body: unknown } {
    return this.respond(accountId, project, query);
  }
}
