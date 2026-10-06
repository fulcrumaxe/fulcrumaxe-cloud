import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import type { LookupFunction } from 'node:net';
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
 *  - 403 with `retry-after` (the secondary rate limit), 429 and 5xx on demand (`world.failNext`).
 *
 * Not faked faithfully (the PR says so): GitHub's real primary and secondary rate-limit thresholds, the full
 * installation object (only the fields this job reads), and the exact wording of every message.
 */
export type AppKind = 'team' | 'team_readonly' | 'sitekit';
export const APP_KINDS: readonly AppKind[] = ['team', 'team_readonly', 'sitekit'];

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
}

export interface AppWorld {
  installations: FakeInstallation[];
  /** Answer the next matching requests with these, in order, then carry on. */
  failNext: FailRule[];
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
  const world: AppWorld = { installations: [], failNext: [] };
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
    const as = appOf(jwt);
    calls.push({ as, path: req.path, query: req.query ?? '' });

    const rule = world.failNext[0];
    if (rule && (!rule.match || rule.match.test(req.path)) && (!rule.query || rule.query.test(req.query ?? ''))) {
      world.failNext.shift();
      const r = ghError(rule.status, rule.status === 403 ? 'You have exceeded a secondary rate limit.' : 'Server Error');
      return { ...r, headers: { ...r.headers, ...(rule.headers ?? {}) } };
    }
    if (!as) return ghError(401, 'A JSON web token could not be decoded');
    if (req.method !== 'GET') return ghError(404, 'Not Found');

    const mine = world.installations.filter((i) => i.kind === as).sort((a, b) => a.id - b.id);
    const json = (status: number, body: unknown, headers: Record<string, string> = {}): GhReply => ({
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
      body: JSON.stringify(body),
    });
    const shape = (i: FakeInstallation) => ({
      id: i.id,
      app_id: keys[i.kind].appId,
      // Free text GitHub sends that must never reach our logs or error classes.
      account: { login: `octo-org-${i.id}`, type: 'Organization' },
      suspended_at: i.suspended ? '2026-10-01T00:00:00Z' : null,
    });

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
  return { port: server.port, ca: server.ca, keys, world, calls, server, lookup, close: () => server.close() };
}
