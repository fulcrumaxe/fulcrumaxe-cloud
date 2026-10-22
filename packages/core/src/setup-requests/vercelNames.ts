import { readCapped, refusalReason, VERCEL_API_BASE, VERCEL_USER_AGENT, VERCEL_TOKEN_RE, VERCEL_TEAM_RE, type VercelCredentialResolver } from './vercelEnvSource.js';

/**
 * D#598 P8d-3a: the NAMES a stored Vercel token can see, for the connection screen: the team's display name and the names of its projects. The
 * screen shows names and never ids alone, so a read that cannot produce the names is `unavailable` as a whole: no partial answer, no id fallback.
 *
 * Two requests at most, both GET, both through the injected pinned fetch (apps/web/lib/vercelPinnedFetch.ts): `/v2/teams/<team id>` (only for a
 * team-scoped connection) and the first page of `/v10/projects`. Each has a timeout and a body cap. Only `name` is read from either answer: ids,
 * slugs and every other field are dropped here. The token comes from the injected resolver and goes only into those requests' headers; it is in
 * no result, log line or cache key (the key is the account and the credential's opaque `ref`, so a replaced token is a new key).
 *
 * Bounded: answers are cached per account+credential for {@link NAMES_TTL_MS}, a failure for {@link NAMES_FAILURE_TTL_MS} (so a broken or
 * rate-limited Vercel is not hit on every page view), concurrent reads share one call, and the cache holds at most {@link NAMES_CACHE_MAX} entries.
 * A missing or rejected credential is not asked about at all.
 */
export type VercelNames = { status: 'ok'; teamName: string | null; projects: string[]; truncated: boolean } | { status: 'unavailable' };
export interface VercelNamesReader {
  read(accountId: string): Promise<VercelNames>;
}

export const NAMES_TTL_MS = 5 * 60_000;
export const NAMES_FAILURE_TTL_MS = 30_000;
export const NAMES_CACHE_MAX = 500;
export const NAMES_PROJECT_CAP = 100;
const CALL_TIMEOUT_MS = 6_000;
const MAX_BODY_BYTES = 1_000_000;
const PROJECT_NAME_RE = /^[a-z0-9._-]{1,100}$/;

const UNAVAILABLE: VercelNames = { status: 'unavailable' };

/** The team's display name from a `{ name }` answer, or null when it is not a short plain string. */
const teamNameOf = (body: unknown): string | null => {
  const name = (body as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name.trim().length > 0 && name.length <= 100 && !/[\p{Cc}\p{Cf}]/u.test(name) ? name.trim() : null;
};

export function createVercelNamesReader(opts: { credentials: VercelCredentialResolver; fetch: typeof fetch; baseUrl?: string; now?: () => number; callTimeoutMs?: number; log?: (line: string) => void }): VercelNamesReader {
  const base = opts.baseUrl ?? VERCEL_API_BASE;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((line: string) => console.info(line));
  const cache = new Map<string, { until: number; value: Promise<VercelNames> }>();

  async function getJson(url: URL, token: string): Promise<unknown> {
    const res = await opts.fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, 'user-agent': VERCEL_USER_AGENT, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(opts.callTimeoutMs ?? CALL_TIMEOUT_MS),
    });
    if (res.status !== 200) {
      // The same classification as the env-var check: a refused token is marked (below); anything else is just "unavailable".
      throw new Error((await refusalReason(res)) === 'token_rejected' ? 'token_rejected' : 'not_ok');
    }
    const text = await readCapped(res, MAX_BODY_BYTES);
    if (text === null) throw new Error('body_too_large');
    return JSON.parse(text);
  }

  async function fetchNames(token: string, teamId: string | undefined): Promise<VercelNames> {
    const projectsUrl = new URL('/v10/projects', base);
    projectsUrl.searchParams.set('limit', String(NAMES_PROJECT_CAP));
    if (teamId !== undefined) projectsUrl.searchParams.set('teamId', teamId);
    const [team, projects] = await Promise.all([teamId === undefined ? Promise.resolve(null) : getJson(new URL(`/v2/teams/${teamId}`, base), token), getJson(projectsUrl, token)]);
    const teamName = teamId === undefined ? null : teamNameOf(team);
    const body = projects as { projects?: unknown; pagination?: { next?: unknown } | null } | null;
    if ((teamId !== undefined && teamName === null) || !Array.isArray(body?.projects)) return UNAVAILABLE;
    const names = body.projects.map((p) => (p as { name?: unknown } | null)?.name).filter((n): n is string => typeof n === 'string' && PROJECT_NAME_RE.test(n));
    const more = body.pagination?.next;
    return { status: 'ok', teamName, projects: names.slice(0, NAMES_PROJECT_CAP).sort(), truncated: body.projects.length > NAMES_PROJECT_CAP || (more !== null && more !== undefined) };
  }

  return {
    async read(accountId) {
      let credential;
      try {
        credential = await opts.credentials.resolve(accountId);
      } catch {
        // fx-swallow-ok: a credential lookup that fails is "names unavailable"; nothing of the error is kept
        return UNAVAILABLE;
      }
      if (credential.status !== 'ok' || !VERCEL_TOKEN_RE.test(credential.token) || (credential.teamId !== undefined && !VERCEL_TEAM_RE.test(credential.teamId))) return UNAVAILABLE;
      const key = `${accountId}:${credential.ref ?? ''}`;
      const hit = cache.get(key);
      if (hit !== undefined && hit.until > now()) return hit.value;
      const value = fetchNames(credential.token, credential.teamId).catch(async (error: unknown) => {
        // fx-swallow-ok: any failure is "names unavailable"; only a fixed code is logged (a message can carry a host)
        const rejected = (error as { message?: string } | null)?.message === 'token_rejected';
        log(JSON.stringify({ event: 'vercel_names.failed', code: rejected ? 'token_rejected' : (error as { name?: string } | null)?.name === 'TimeoutError' ? 'timeout' : 'error' }));
        if (rejected) await opts.credentials.markRejected?.(accountId, credential.ref).catch(() => undefined);
        return UNAVAILABLE;
      });
      const entry = { until: now() + NAMES_TTL_MS, value };
      cache.delete(key);
      cache.set(key, entry);
      if (cache.size > NAMES_CACHE_MAX) cache.delete(cache.keys().next().value as string);
      void value.then((v) => {
        if (v.status === 'unavailable') entry.until = now() + NAMES_FAILURE_TTL_MS;
      });
      return value;
    },
  };
}
