import { RECONCILE_ROUTE, type JobContext, type JobResult, type ReconcileJob, type ReportError } from '../runner.js';
import type { GithubAppApi, GithubAppResponse } from '../githubAppApi.js';

export const GITHUB_INSTALLATIONS_JOB = 'github_installations';
/** Outside calls per run (the spec's GitHub budget, shared with the repo re-sync job's own allowance). */
export const GITHUB_CALLS_PER_RUN = 300;
/** A run that would detach more than this many installations of one kind detaches none. */
export const BREAKER_MAX_DETACHES = 5;
/** ...or more than this share of that kind's live installations. */
export const BREAKER_MAX_SHARE = 0.1;
/** Kinds in the order a run takes them. Each has its own GitHub App, and only that App's JWT can see its installations. */
export const INSTALLATION_KINDS = ['team', 'team_readonly', 'sitekit'] as const;
export type InstallationKind = (typeof INSTALLATION_KINDS)[number];

const PAGE_SIZE = 100;
const MAX_LIST_PAGES = 50;
const CALL_TIMEOUT_MS = 15_000;
const MAX_ORPHAN_REPORTS = 20;
const LIST_PATH = `/app/installations?per_page=${PAGE_SIZE}`;

/** What the job asks of the webhook path's own lifecycle function (ONBOARDING-STATE): the same change a delivery would make. */
export interface InstallationChange {
  kind: InstallationKind;
  ghInstallationId: number;
  /** `deleted` and `suspend` detach the installation's repos (never delete them); `unsuspend` re-syncs them. */
  action: 'deleted' | 'suspend' | 'unsuspend';
}

export interface GithubInstallationsDeps {
  /** The client for one kind's App, or null when that kind is not configured (it is then skipped, never borrowed from another kind). */
  api(kind: InstallationKind): GithubAppApi | null;
  apply(change: InstallationChange): Promise<void>;
  reportError: ReportError;
}

interface OurRow {
  gh: number;
  suspended: boolean;
}

type Seen = { state: 'present'; suspended: boolean } | { state: 'gone' } | { state: 'unknown' } | { state: 'limited' } | { state: 'unauthorized' };

function isRateLimited(res: GithubAppResponse): boolean {
  if (res.status !== 403 && res.status !== 429) return false;
  return res.headers['retry-after'] !== undefined || res.headers['x-ratelimit-remaining'] === '0';
}

/** The `next` page of a GitHub listing, as a path and query on our own two endpoints; null when there is none or it points elsewhere. */
function nextPath(link: string | undefined): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (!m) continue;
    try {
      const u = new URL(m[1]!);
      if (u.hostname !== 'api.github.com' || u.pathname !== '/app/installations') return null;
      return `${u.pathname}${u.search}`;
    } catch {
      // fx-swallow-ok: an unreadable Link header reads as "no next page", which makes the list incomplete
      return null;
    }
  }
  return null;
}

const asId = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null);

/**
 * GitHub installation state for all three App kinds, every 6 hours (D#454 H2b):
 *  - the list (`GET /app/installations`, that kind's App JWT) is used for suspension changes and to spot orphans. It is
 *    NEVER what says an installation is gone;
 *  - an installation of ours that the list does not show, or whose list did not finish, is read one by one
 *    (`GET /app/installations/{id}`, same kind's JWT). Only a 404 there marks it deleted. Any other answer, a network
 *    error or a rate limit changes nothing;
 *  - every change goes through the webhook path's own lifecycle function (`apply`), so detaching repos, the events the
 *    open windows refresh on, and the advisory lock are the same as for a delivery;
 *  - an installation GitHub shows and we do not know is reported as an orphan and never bound;
 *  - the breaker: more than 5 detaching changes (deleted or suspend) for one kind, or more than 10% of that kind's live
 *    installations, and none of them is applied; the run ends `breaker_tripped`. Un-suspending detaches nothing, so
 *    it is not held back.
 */
export function createGithubInstallationsJob(deps: GithubInstallationsDeps): ReconcileJob {
  const stage = `reconcile.${GITHUB_INSTALLATIONS_JOB}`;
  const report = (err: unknown, code?: string): void => deps.reportError(err, { stage, route: RECONCILE_ROUTE, ...(code ? { code } : {}) });

  return {
    name: GITHUB_INSTALLATIONS_JOB,
    maxCalls: GITHUB_CALLS_PER_RUN,
    async run(ctx: JobContext): Promise<JobResult> {
      const apis = INSTALLATION_KINDS.map((k) => deps.api(k));
      if (apis.every((a) => a === null)) return { cursor: null, wrapped: false, code: 'not_configured' };

      // The cursor is "<kind index>:<last installation id finished>"; a bad one starts over.
      const at = /^([0-2]):([0-9]{1,18})$/.exec(ctx.cursor ?? '');
      const startKind = at ? Number(at[1]) : 0;
      const startAfter = at ? Number(at[2]) : null;

      let failed = false;
      let tripped = false;

      for (let ki = startKind; ki < INSTALLATION_KINDS.length; ki++) {
        const api = apis[ki];
        if (!api) continue;
        const kind = INSTALLATION_KINDS[ki]!;
        const done = await processKind(ctx, kind, api, ki === startKind ? startAfter : null);
        if (done.tripped) tripped = true;
        if (done.failed) failed = true;
        if (done.stop) {
          if (done.stop === 'limited') report(new Error('github rate limit: the run stopped and kept its place'), 'rate_limited');
          // A budget, a rate limit or the deadline: keep the place. A tripped breaker restarts the pass instead, so the
          // same rows are looked at again next time.
          if (tripped) return { cursor: null, wrapped: false, code: 'breaker_tripped' };
          const cursor = `${ki}:${done.lastDone ?? startAfterFor(ki, startKind, startAfter) ?? 0}`;
          return { cursor, wrapped: false, ...(done.stop === 'limited' || failed ? { code: 'error' as const } : {}) };
        }
      }
      if (tripped) return { cursor: null, wrapped: false, code: 'breaker_tripped' };
      if (failed) return { cursor: null, wrapped: false, code: 'error' };
      return { cursor: null, wrapped: true };
    },
  };

  function startAfterFor(ki: number, startKind: number, startAfter: number | null): number | null {
    return ki === startKind ? startAfter : null;
  }

  async function processKind(
    ctx: JobContext,
    kind: InstallationKind,
    api: GithubAppApi,
    after: number | null,
  ): Promise<{ stop?: 'budget' | 'limited'; lastDone?: number; tripped?: boolean; failed?: boolean }> {
    const { rows: all } = await ctx.pool.query<{ gh: string; suspended: boolean }>(
      `SELECT i.gh_installation_id::text AS gh, (ii.suspended_at IS NOT NULL) AS suspended
         FROM installations i
         JOIN installation_installers ii ON ii.gh_installation_id = i.gh_installation_id AND ii.app_kind = i.app_kind
        WHERE i.app_kind = $1 AND ii.deleted_at IS NULL
        ORDER BY i.gh_installation_id`,
      [kind],
    );
    const live: OurRow[] = all.map((r) => ({ gh: Number(r.gh), suspended: r.suspended }));
    const slice = live.filter((r) => after === null || r.gh > after);

    const call = async (path: string): Promise<GithubAppResponse | 'budget' | 'failed'> => {
      if (ctx.signal.aborted || ctx.msLeft() <= 0 || !ctx.calls.take(1)) return 'budget';
      try {
        return await api.get(path, { signal: ctx.signal, timeoutMs: Math.min(CALL_TIMEOUT_MS, Math.max(1, ctx.msLeft())) });
      } catch (err) {
        deps.reportError(err, { stage, route: RECONCILE_ROUTE });
        return 'failed';
      }
    };

    // 1. The list: suspension and orphans. An unfinished list is never read as "the rest are gone".
    const listed = new Map<number, boolean>();
    let complete = true;
    let path: string | null = LIST_PATH;
    for (let page = 0; path !== null; page++) {
      if (page >= MAX_LIST_PAGES) {
        complete = false;
        break;
      }
      const res = await call(path);
      if (res === 'budget') return { stop: 'budget' };
      if (res === 'failed') return { failed: true };
      if (isRateLimited(res)) return { stop: 'limited' };
      if (res.status === 401) {
        report(new Error('github rejected the app jwt'), 'invalid_token');
        return { failed: true };
      }
      if (res.status !== 200 || !Array.isArray(res.body)) {
        report(new Error('installation list did not answer 200 with an array'));
        complete = false;
        break;
      }
      for (const item of res.body as unknown[]) {
        const o = item as { id?: unknown; suspended_at?: unknown } | null;
        const id = asId(o?.id);
        if (id !== null) listed.set(id, typeof o?.suspended_at === 'string' && o.suspended_at !== '');
      }
      path = nextPath(res.headers['link']);
      if (path === null && /rel="next"/.test(res.headers['link'] ?? '')) complete = false;
    }

    // 2. Ours, one by one. Positive answers only.
    const changes: InstallationChange[] = [];
    let stop: 'budget' | 'limited' | undefined;
    let lastDone: number | undefined;
    let failed = false;
    for (const row of slice) {
      let seen: Seen;
      const inList = listed.get(row.gh);
      if (inList !== undefined) {
        seen = { state: 'present', suspended: inList };
      } else {
        const res = await call(`/app/installations/${row.gh}`);
        if (res === 'budget') {
          stop = 'budget';
          break;
        }
        if (res === 'failed') seen = { state: 'unknown' };
        else if (isRateLimited(res)) seen = { state: 'limited' };
        else if (res.status === 401) seen = { state: 'unauthorized' };
        else if (res.status === 404) seen = { state: 'gone' };
        else if (res.status === 200 && asId((res.body as { id?: unknown } | null)?.id) === row.gh) {
          const sus = (res.body as { suspended_at?: unknown }).suspended_at;
          seen = { state: 'present', suspended: typeof sus === 'string' && sus !== '' };
        } else {
          report(new Error('installation lookup gave no confirmed answer'));
          seen = { state: 'unknown' };
        }
      }
      if (seen.state === 'limited') {
        stop = 'limited';
        break;
      }
      if (seen.state === 'unauthorized') {
        report(new Error('github rejected the app jwt'), 'invalid_token');
        failed = true;
        break;
      }
      if (seen.state === 'gone') changes.push({ kind, ghInstallationId: row.gh, action: 'deleted' });
      else if (seen.state === 'present' && seen.suspended !== row.suspended) {
        changes.push({ kind, ghInstallationId: row.gh, action: seen.suspended ? 'suspend' : 'unsuspend' });
      }
      lastDone = row.gh;
    }

    // 3. Orphans: on GitHub (the list finished), unknown to us. Reported for the digest, never bound.
    if (complete && after === null) {
      const known = new Set(
        (await ctx.pool.query<{ gh: string }>('SELECT gh_installation_id::text AS gh FROM installations WHERE app_kind = $1', [kind])).rows.map((r) => Number(r.gh)),
      );
      let reported = 0;
      for (const id of listed.keys()) {
        if (known.has(id) || reported >= MAX_ORPHAN_REPORTS) continue;
        reported++;
        report(new Error('an installation on github is unknown to us'), 'orphan_installation');
      }
    }

    // 4. The breaker, then the changes.
    const detaching = changes.filter((c) => c.action !== 'unsuspend');
    const tripped = detaching.length > BREAKER_MAX_DETACHES || detaching.length > BREAKER_MAX_SHARE * live.length;
    if (tripped) report(new Error('detach breaker tripped: no installation was detached'), 'breaker_tripped');
    for (const change of tripped ? changes.filter((c) => c.action === 'unsuspend') : changes) {
      try {
        await deps.apply(change);
      } catch (err) {
        // The change is found again on the next pass; the rest of this one still runs.
        deps.reportError(err, { stage, route: RECONCILE_ROUTE });
        failed = true;
      }
    }
    return { ...(stop ? { stop } : {}), ...(lastDone !== undefined ? { lastDone } : {}), ...(tripped ? { tripped } : {}), ...(failed ? { failed } : {}) };
  }
}
