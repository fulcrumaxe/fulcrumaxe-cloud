import { createHash, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import type { GithubAppApi } from './githubAppApi.js';
import { listOpenHolds, releaseHold } from './breakerHolds.js';
import { INSTALLATION_KINDS, type InstallationKind } from './jobs/githubInstallations.js';

/**
 * The owner's side of the reconcilers' breaker (D#454 H2b2), as plain Request/Response logic so it is tested against a real
 * database without a web framework. `apps/web/app/api/internal/reconcile/release/route.ts` only wires it.
 *
 * Auth: a bearer secret of its own (FX_RECONCILE_RELEASE_TOKEN), never the cron secret: a cron caller must not be able to release
 * a breaker. Unset (or shorter than 32 characters) secret: 503 and nothing happens. Missing or wrong header: 401 and nothing is read or written. The database is
 * reached only after the header has matched.
 *
 *   GET  -> the open holds (ids and counts only)
 *   POST {action:"release", hold_id, gh_installation_ids, note?} -> releases exactly that hold, and only if it still covers exactly
 *           those ids; releasing a released hold changes nothing
 *   POST {action:"restore", kind, gh_installation_id} -> clears a `deleted_but_listed` installation after a fresh lookup with
 *           that kind's own App JWT answers 200 for the same id; any other answer changes nothing
 */
export interface ReleaseApiDeps {
  /** FX_RECONCILE_RELEASE_TOKEN. */
  token: string | undefined;
  /** The platform_ops pool; built lazily, after the caller is authenticated. */
  pool: () => Pool;
  /** The client for one kind's App (its own JWT), or null when that kind is not configured. */
  api: (kind: InstallationKind) => GithubAppApi | null;
  /** The webhook path's own lifecycle function for a restore; false when there was nothing to restore. */
  restore: (kind: InstallationKind, ghInstallationId: number, meter: { take(n?: number): boolean }) => Promise<boolean>;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

function authorized(header: string | null, token: string): boolean {
  if (!header) return false;
  // Hash both sides so the comparison is constant-length whatever the header holds.
  const expected = createHash('sha256').update(`Bearer ${token}`).digest();
  const actual = createHash('sha256').update(header).digest();
  return timingSafeEqual(expected, actual);
}

const posInt = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null);
const MAX_BODY_BYTES = 64 * 1024;
/** A secret shorter than this is treated as unset: a guessable owner token is worse than none. */
export const MIN_TOKEN_LENGTH = 32;

/** Reads the body but stops at the cap while reading, so an oversized body is never held whole. Null when it is over the cap. */
async function readCapped(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** One restore request may make this many GitHub calls in all: the confirming lookup, then the repo re-sync's token mint and list pages. */
export const RESTORE_CALL_ALLOWANCE = 20;

export type RestoreOutcome = 'restored' | 'nothing_to_restore' | 'not_confirmed' | 'budget';

/**
 * Restore one installation, only after a fresh `GET /app/installations/{id}` as that kind's App answers 200 with the same id.
 * A 404, another id, a non-200, an unconfigured kind or a transport failure changes nothing.
 */
export async function restoreIfConfirmed(deps: Pick<ReleaseApiDeps, 'api' | 'restore'>, kind: InstallationKind, ghInstallationId: number): Promise<RestoreOutcome> {
  const api = deps.api(kind);
  if (!api) return 'not_confirmed';
  let used = 0;
  const meter = {
    take(n = 1): boolean {
      if (used + n > RESTORE_CALL_ALLOWANCE) return false;
      used += n;
      return true;
    },
  };
  meter.take(1); // the confirming lookup
  let res;
  try {
    res = await api.get(`/app/installations/${ghInstallationId}`, { timeoutMs: 15_000 });
  } catch {
    // fx-swallow-ok: a failed confirmation is the same answer as no confirmation; nothing changes and the owner can run it again
    return 'not_confirmed';
  }
  if (res.status !== 200 || posInt((res.body as { id?: unknown } | null)?.id) !== ghInstallationId) return 'not_confirmed';
  try {
    return (await deps.restore(kind, ghInstallationId, meter)) ? 'restored' : 'nothing_to_restore';
  } catch (err) {
    // The restore itself committed; only its repo re-sync ran out of this request's calls, and the repo job picks the repos up.
    if ((err as { name?: unknown } | null)?.name === 'RepoListBudgetError') return 'budget';
    throw err;
  }
}

export async function handleReleaseRequest(req: Request, deps: ReleaseApiDeps): Promise<Response> {
  if (!deps.token || deps.token.length < MIN_TOKEN_LENGTH) return json(503, { error: 'not_configured' });
  if (!authorized(req.headers.get('authorization'), deps.token)) return json(401, { error: 'unauthenticated' });

  if (req.method === 'GET') {
    const holds = await listOpenHolds(deps.pool());
    return json(200, {
      holds: holds.map((h) => ({
        id: h.id,
        job: h.job,
        kind: h.kind,
        gh_installation_ids: h.ids,
        trip_count: h.tripCount,
        first_tripped_at: h.firstTrippedAt,
        last_tripped_at: h.lastTrippedAt,
        released: h.released,
      })),
    });
  }
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const text = await readCapped(req);
  if (text === null) return json(400, { error: 'bad_request' });
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return json(400, { error: 'bad_request' });
    body = parsed as Record<string, unknown>;
  } catch {
    // fx-swallow-ok: an unparseable body is a 400 for the caller, which is the report
    return json(400, { error: 'bad_request' });
  }

  if (body.action === 'release') {
    const holdId = posInt(body.hold_id);
    const ids = Array.isArray(body.gh_installation_ids) ? body.gh_installation_ids.map(posInt) : null;
    const note = body.note === undefined ? '' : body.note;
    if (holdId === null || !ids || ids.length === 0 || ids.some((i) => i === null) || typeof note !== 'string') return json(400, { error: 'bad_request' });
    const out = await releaseHold(deps.pool(), { holdId, ids: ids as number[], note });
    if (out.status === 'released') return json(200, { status: 'released', gh_installation_ids: out.hold.ids });
    if (out.status === 'already_released') return json(200, { status: 'already_released' });
    if (out.status === 'ids_changed') return json(409, { error: 'ids_changed', gh_installation_ids: out.hold.ids });
    return json(404, { error: 'no_such_hold' });
  }

  if (body.action === 'restore') {
    const kind = (INSTALLATION_KINDS as readonly unknown[]).includes(body.kind) ? (body.kind as InstallationKind) : null;
    const id = posInt(body.gh_installation_id);
    if (kind === null || id === null) return json(400, { error: 'bad_request' });
    const outcome = await restoreIfConfirmed(deps, kind, id);
    return json(outcome === 'not_confirmed' ? 409 : 200, outcome === 'not_confirmed' ? { error: 'not_confirmed' } : { status: outcome });
  }
  return json(400, { error: 'bad_request' });
}
