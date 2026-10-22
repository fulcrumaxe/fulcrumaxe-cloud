import { parseVercelEnvPage, type VercelEnvEntry, type VercelEnvListing, type VercelEnvSource } from './checks.js';
import { markSetupRequestCheckPending } from './store.js';

/**
 * D#598 P8d-1: the HTTP adapter behind the {@link VercelEnvSource} port. It lists a Vercel project's environment-variable NAMES (and the
 * environments each is set for) with the customer's own token, and nothing else.
 *
 *  - The token comes from an injected {@link VercelCredentialResolver}; this file stores none and reads no setting. While the connection kind
 *    is not wired, {@link unavailableVercelCredentials} makes the whole source `available: false`; production injects the sealed store's resolver (P8d-2).
 *  - It never asks for values. The request is built by {@link buildListUrl}, which always sends `decrypt=false` and REFUSES (throws) a
 *    caller-supplied query that carries `decrypt` at all; a second check on the final URL runs right before the call. Only `key` and `target`
 *    are read from an answer (checks.ts `parseVercelEnvPage`).
 *  - Every call has a timeout, the whole listing has a deadline, and the listing is read page by page up to a page cap. A page cap that is hit,
 *    a cursor that does not advance, a non-200 answer, a body that is not the listing, a timeout and a thrown error are all `{ ok: false }`
 *    (check_unavailable), never a partial listing that could read as "missing".
 *  - What is logged is a fixed code and a count, never a body, a URL, a name or the token.
 *  - The transport is injected and required: production passes the net-guarded, address-pinned fetch (apps/web/lib/vercelPinnedFetch.ts).
 *    The body is read as a stream and cut off at a byte cap.
 * Paging contract: Vercel's published reference for this endpoint documents the path, `decrypt`, `teamId` and the environment filters; it does
 * NOT document `limit`, `until` or a `pagination` object. The adapter sends `limit` and `until` and follows `pagination.next` if the answer has
 * one, on the assumption that the live API honours them; if it ignores `until` the cursor does not move (`cursor_stuck`) and the check is
 * unavailable, never wrong. An answer with no `pagination` is read as the last page. The live staging check must confirm this.
 */

/** `ref` is an opaque marker of exactly this stored credential, handed back to {@link VercelCredentialResolver.markRejected}. */
export type VercelCredential = { status: 'ok'; token: string; teamId?: string; ref?: string } | { status: 'unavailable' };

/** Where the adapter gets an account's Vercel token. `configured` is false while no connection can exist for any account. */
export interface VercelCredentialResolver {
  readonly configured: boolean;
  resolve(accountId: string): Promise<VercelCredential>;
  /** Records that Vercel refused (401/403) the credential `ref` named, so the connection can say so. A newer credential is left alone. */
  markRejected?(accountId: string, ref: string | undefined): Promise<void>;
}

/** A resolver for a platform where the connection kind is not wired: no account has a token. Production uses the sealed store (apps/web/lib/setupRequestEnvSource.ts). */
export const unavailableVercelCredentials: VercelCredentialResolver = {
  configured: false,
  async resolve() {
    return { status: 'unavailable' };
  },
};

export const VERCEL_API_BASE = 'https://api.vercel.com';
export const VERCEL_USER_AGENT = 'fulcrumaxe-cloud-setup-check/1';
export const VERCEL_PAGE_SIZE = 100;
/** More pages than this fails closed: a project with 2000 variables is not one we can answer "missing" for. */
export const VERCEL_PAGE_CAP = 20;
export const VERCEL_CALL_TIMEOUT_MS = 8_000;
/** The whole listing, all pages, under the sweep's own pass budget. */
export const VERCEL_LISTING_DEADLINE_MS = 20_000;
const MAX_BODY_BYTES = 2_000_000;

/** The body as text, read as a stream and stopped (the rest cancelled) the moment it passes `max` bytes; null when it does. */
async function readCapped(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel();
    return null;
  }
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
const PROJECT_RE = /^[a-z0-9._-]{1,100}$/;
/** What the adapter will send as a token / team id. The connection kind stores nothing the adapter would refuse. */
export const VERCEL_TOKEN_RE = /^[\x21-\x7E]{1,2000}$/;
export const VERCEL_TEAM_RE = /^team_[A-Za-z0-9]{1,64}$/;
const TOKEN_RE = VERCEL_TOKEN_RE;
const TEAM_RE = VERCEL_TEAM_RE;

/** The listing URL for one page. Throws on a query that asks for `decrypt` in any form: the source never builds a request for values. */
export function buildListUrl(base: string, project: string, opts: { teamId?: string; until?: number; extra?: URLSearchParams }): URL {
  if (opts.extra?.has('decrypt')) throw new Error('vercel_env_source: decrypt is never requested');
  const url = new URL(`/v10/projects/${encodeURIComponent(project)}/env`, base);
  url.searchParams.set('decrypt', 'false');
  url.searchParams.set('limit', String(VERCEL_PAGE_SIZE));
  if (opts.until !== undefined) url.searchParams.set('until', String(opts.until));
  if (opts.teamId !== undefined) url.searchParams.set('teamId', opts.teamId);
  return url;
}

function assertNoDecrypt(url: URL): void {
  if (url.searchParams.getAll('decrypt').some((v) => v !== 'false') || url.searchParams.getAll('decrypt').length > 1) throw new Error('vercel_env_source: decrypt is never requested');
}

export interface VercelEnvSourceOptions {
  credentials: VercelCredentialResolver;
  baseUrl?: string;
  /** Required: the caller supplies the transport (production: the net-guarded, pinned fetch). There is no default to the global fetch. */
  fetch: typeof fetch;
  callTimeoutMs?: number;
  deadlineMs?: number;
  pageCap?: number;
  log?: (line: string) => void;
}

export function createVercelEnvSource(opts: VercelEnvSourceOptions): VercelEnvSource {
  const doFetch = opts.fetch;
  const base = opts.baseUrl ?? VERCEL_API_BASE;
  const callTimeoutMs = opts.callTimeoutMs ?? VERCEL_CALL_TIMEOUT_MS;
  const deadlineMs = opts.deadlineMs ?? VERCEL_LISTING_DEADLINE_MS;
  const pageCap = opts.pageCap ?? VERCEL_PAGE_CAP;
  const log = opts.log ?? ((line: string) => console.info(line));
  const fail = (code: string): VercelEnvListing => {
    log(JSON.stringify({ event: 'vercel_env_source.failed', code }));
    return { ok: false };
  };
  return {
    available: opts.credentials.configured,
    async listEnvNames({ accountId, project }): Promise<VercelEnvListing> {
      if (!PROJECT_RE.test(project) || project.includes('---')) return fail('bad_project');
      let credential: VercelCredential;
      try {
        credential = await opts.credentials.resolve(accountId);
      } catch {
        // fx-swallow-ok: a credential lookup that fails is "cannot ask the provider" (check_unavailable), logged by a fixed code
        return fail('credential_error');
      }
      if (credential.status !== 'ok' || !TOKEN_RE.test(credential.token) || (credential.teamId !== undefined && !TEAM_RE.test(credential.teamId))) return fail('no_credential');
      const startedAt = Date.now();
      const entries: VercelEnvEntry[] = [];
      let skipped = 0;
      let until: number | undefined;
      try {
        for (let page = 0; page < pageCap; page += 1) {
          const remaining = deadlineMs - (Date.now() - startedAt);
          if (remaining <= 0) return fail('deadline');
          const url = buildListUrl(base, project, { ...(credential.teamId !== undefined ? { teamId: credential.teamId } : {}), ...(until !== undefined ? { until } : {}) });
          assertNoDecrypt(url);
          const res = await doFetch(url, {
            method: 'GET',
            headers: { authorization: `Bearer ${credential.token}`, 'user-agent': VERCEL_USER_AGENT, accept: 'application/json' },
            redirect: 'error',
            signal: AbortSignal.timeout(Math.min(callTimeoutMs, remaining)),
          });
          if (res.status !== 200) {
            await res.body?.cancel();
            if (res.status === 401 || res.status === 403) await opts.credentials.markRejected?.(accountId, credential.ref).catch(() => log(JSON.stringify({ event: 'vercel_env_source.failed', code: 'mark_rejected_error' })));
            return fail(`http_${res.status}`);
          }
          const text = await readCapped(res, MAX_BODY_BYTES);
          if (text === null) return fail('body_too_large');
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            // fx-swallow-ok: a body that is not JSON is a failed check (check_unavailable), logged by a fixed code
            return fail('bad_body');
          }
          const parsed = parseVercelEnvPage(body);
          if (parsed === null) return fail('bad_body');
          entries.push(...parsed.entries);
          skipped += parsed.skipped;
          if (parsed.next === null) {
            if (skipped > 0) log(JSON.stringify({ event: 'vercel_env_source.skipped_entries', count: skipped }));
            return { ok: true, entries, ...(skipped > 0 ? { skipped } : {}) };
          }
          if (until !== undefined && parsed.next >= until) return fail('cursor_stuck');
          until = parsed.next;
        }
        return fail('page_cap');
      } catch (error) {
        // fx-swallow-ok: a timeout or a network error is a failed check (check_unavailable); only the error's name is logged, never its message (which can carry a host)
        return fail((error as { name?: string } | null)?.name === 'TimeoutError' ? 'timeout' : 'network');
      }
    },
  };
}

/**
 * Binds a source to the check sweep. The sweep goes idle while no source can answer (checkSweep.ts `nextDueAt` null), so the moment one can,
 * the sweep is marked pending: otherwise a request already waiting would not be looked at until the standard backstop. Returns the source
 * unchanged. A connection made later for one account (P8d-2) calls {@link markSetupRequestCheckPending} the same way.
 */
export function bindVercelEnvSource(source: VercelEnvSource, markPending: () => void = markSetupRequestCheckPending): VercelEnvSource {
  if (source.available) markPending();
  return source;
}
