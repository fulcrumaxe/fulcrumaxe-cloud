import { RECONCILE_ROUTE, type CallBudget, type JobContext, type JobResult, type ReconcileJob, type ReportError } from '../runner.js';
import type { GithubAppApi, GithubAppResponse } from '../githubAppApi.js';
import { breakerAllowance, consumeHold, readOpenHold, recordTrip } from '../breakerHolds.js';

export const GITHUB_INSTALLATIONS_JOB = 'github_installations';
/** Outside calls per run (the spec's GitHub budget, shared with the repo re-sync job's own allowance). */
export const GITHUB_CALLS_PER_RUN = 300;
/** A kind's run detaches nothing when its detaching changes exceed min(5, max(2, floor(0.1 x live))); see breakerAllowance. */
export const BREAKER_MAX_DETACHES = 5;
export const BREAKER_MAX_SHARE = 0.1;
export const BREAKER_MIN_ALLOWANCE = 2;
/** A finished list that shares no id with at least this many live installations is read as the wrong App, not as mass deletion. */
export const IDENTITY_MIN_LIVE = 3;
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
  /** The slug this kind's App must report on `GET /app` (GITHUB_APP_*_SLUG), or null when the setting is unset. */
  slug(kind: InstallationKind): string | null;
  /**
   * `meter` is this run's call allowance: an un-suspend re-syncs the installation's repos, and those GitHub calls take from it.
   * Throw an error named `RepoListBudgetError` when it ran out: the change itself was applied, the repo rows were left as they
   * were, and the run ends `budget` and keeps its place.
   */
  apply(change: InstallationChange, meter: CallBudget): Promise<void>;
  reportError: ReportError;
  /** Tests only: a smaller per-run call allowance than GITHUB_CALLS_PER_RUN. */
  callsPerRun?: number;
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
 *  - the breaker: more than min(5, max(2, floor(0.1 x live))) detaching changes (deleted or suspend) for one kind, and
 *    none of them is applied. The trip is recorded as a hold (migration 0748) that only the owner releases; the alert goes
 *    out on the first trip of an id set. A release covers a later run whose detaching set is a subset of the released
 *    ids. A tripped kind does not end the run or reset the cursor, so the other kinds are still read. Un-suspending
 *    detaches nothing, so it is not held back;
 *  - identity: before any lookup a kind's `GET /app` must report the configured slug, and a finished list must share an
 *    id with the kind's live installations; otherwise that kind changes nothing and says so (`app_identity_mismatch`);
 *  - an installation the list shows that we hold as deleted is reported (`deleted_but_listed`), never changed.
 */
export function createGithubInstallationsJob(deps: GithubInstallationsDeps): ReconcileJob {
  const stage = `reconcile.${GITHUB_INSTALLATIONS_JOB}`;
  const report = (err: unknown, code?: string): void => deps.reportError(err, { stage, route: RECONCILE_ROUTE, ...(code ? { code } : {}) });

  return {
    name: GITHUB_INSTALLATIONS_JOB,
    maxCalls: deps.callsPerRun ?? GITHUB_CALLS_PER_RUN,
    async run(ctx: JobContext): Promise<JobResult> {
      const apis = INSTALLATION_KINDS.map((k) => deps.api(k));
      if (apis.every((a) => a === null)) return { cursor: null, wrapped: false, code: 'not_configured' };

      // The cursor is "<kind index>:<last installation id finished>[:flags]"; a bad one starts over. The flags carry what
      // earlier runs of this pass found: t = a kind tripped its breaker, f = a kind failed or could not prove which App it is.
      // A pass that ends carrying either one is never a full pass.
      const at = /^([0-2]):([0-9]{1,18})(?::([tf]{1,2}))?$/.exec(ctx.cursor ?? '');
      const startKind = at ? Number(at[1]) : 0;
      const startAfter = at ? Number(at[2]) : null;
      let failed = at?.[3]?.includes('f') ?? false;
      let tripped = at?.[3]?.includes('t') ?? false;
      const flags = (): string => `${tripped ? 't' : ''}${failed ? 'f' : ''}`;

      for (let ki = startKind; ki < INSTALLATION_KINDS.length; ki++) {
        const api = apis[ki];
        if (!api) continue;
        const kind = INSTALLATION_KINDS[ki]!;
        const done = await processKind(ctx, kind, api, ki === startKind ? startAfter : null);
        if (done.tripped) tripped = true;
        if (done.failed) failed = true;
        if (done.stop) {
          if (done.stop === 'limited') report(new Error('github rate limit: the run stopped and kept its place'), 'rate_limited');
          // A budget, a rate limit or the deadline: keep the place, and what this pass has found so far. A kind that
          // tripped does not end the run or reset the cursor: the later kinds are still looked at, so a kind that
          // trips every run cannot starve them.
          const cursor = `${ki}:${done.lastDone ?? startAfterFor(ki, startKind, startAfter) ?? 0}${flags() ? `:${flags()}` : ''}`;
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

    // 0. Which App is this? Before any lookup, `GET /app` with this kind's JWT must name the slug configured for the kind.
    // A different slug, an unset setting or any answer but 200 means a wrong or swapped key: that kind changes nothing
    // (no detach, no suspension mirror, no hold) and says so once. The other kinds still run.
    const expected = deps.slug(kind)?.trim().toLowerCase() || null;
    const mismatch = (): { failed: true } => {
      report(new Error('the app identity did not match the configured slug: this kind changed nothing'), 'app_identity_mismatch');
      return { failed: true };
    };
    if (expected === null) return mismatch();
    const who = await call('/app');
    if (who === 'budget') return { stop: 'budget' };
    if (who === 'failed') return { failed: true };
    if (isRateLimited(who)) return { stop: 'limited' };
    const slug = who.status === 200 ? (who.body as { slug?: unknown } | null)?.slug : undefined;
    if (typeof slug !== 'string' || slug.toLowerCase() !== expected) return mismatch();

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

    // A finished list that shows none of our live installations (three or more) is the wrong App's list, not a mass
    // deletion: the same "no change" as an identity mismatch.
    if (complete && live.length >= IDENTITY_MIN_LIVE && !live.some((r) => listed.has(r.gh))) return mismatch();

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

    // 3b. Self-repair, detect only: the list shows an installation whose record we hold as deleted. Reported, never
    // re-bound; the owner restores it through the release script after a fresh confirming lookup.
    if (complete && after === null && listed.size > 0) {
      const { rows } = await ctx.pool.query<{ gh: string }>(
        `SELECT i.gh_installation_id::text AS gh
           FROM installations i
           JOIN installation_installers ii ON ii.gh_installation_id = i.gh_installation_id AND ii.app_kind = i.app_kind
          WHERE i.app_kind = $1 AND ii.deleted_at IS NOT NULL AND i.gh_installation_id = ANY($2::bigint[])
          ORDER BY i.gh_installation_id LIMIT $3`,
        [kind, [...listed.keys()], MAX_ORPHAN_REPORTS],
      );
      for (let n = 0; n < rows.length; n++) report(new Error('an installation we hold as deleted is listed by the provider'), 'deleted_but_listed');
    }

    // 4. The breaker, then the changes.
    const detaching = changes.filter((c) => c.action !== 'unsuspend');
    const detachingIds = detaching.map((c) => c.ghInstallationId);
    let tripped = detaching.length > breakerAllowance(live.length);
    let toApply = changes;
    let consume: number | null = null;
    try {
      const hold = await readOpenHold(ctx.pool, GITHUB_INSTALLATIONS_JOB, kind);
      // A release (made within 48 hours) covers the changes only when they are a subset of the ids the owner saw. A
      // superset trips again, as a new hold.
      // An empty set is a subset too, but it uses the release up only once this kind has been read to its end.
      if (hold?.released && detachingIds.every((id) => hold.ids.includes(id)) && (detachingIds.length > 0 || !stop)) {
        tripped = false;
        consume = hold.id;
        report(new Error('a released breaker hold was used: its changes were applied'), 'breaker_released');
      } else if (tripped) {
        const { alert } = await recordTrip(ctx.pool, GITHUB_INSTALLATIONS_JOB, kind, detachingIds);
        if (alert) report(new Error('detach breaker tripped: no installation was detached'), 'breaker_tripped');
      }
    } catch (err) {
      // Fail closed: if the hold cannot be read or written, nothing detaching is applied this run.
      deps.reportError(err, { stage, route: RECONCILE_ROUTE });
      tripped = true;
      failed = true;
    }
    if (tripped) toApply = changes.filter((c) => c.action === 'unsuspend');
    for (const change of toApply) {
      try {
        await deps.apply(change, ctx.calls);
      } catch (err) {
        if ((err as { name?: unknown } | null)?.name === 'RepoListBudgetError') {
          // The change is in; only its repo re-sync ran out of calls. Stop here and let the repo job pick the repos up.
          stop ??= 'budget';
          consume = null; // later changes were not applied, so the release stays unused
          break;
        }
        // The change is found again on the next pass; the rest of this one still runs.
        deps.reportError(err, { stage, route: RECONCILE_ROUTE });
        failed = true;
        consume = null; // a change that did not apply leaves the release unused, so the next pass is still covered
      }
    }
    if (consume !== null) {
      try {
        await consumeHold(ctx.pool, consume);
      } catch (err) {
        deps.reportError(err, { stage, route: RECONCILE_ROUTE });
        failed = true;
      }
    }
    return { ...(stop ? { stop } : {}), ...(lastDone !== undefined ? { lastDone } : {}), ...(tripped ? { tripped } : {}), ...(failed ? { failed } : {}) };
  }
}
