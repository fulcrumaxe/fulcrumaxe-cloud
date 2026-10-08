import { RECONCILE_ROUTE, type JobContext, type JobResult, type ReconcileJob, type ReportError } from '../runner.js';

export const GITHUB_REPOS_JOB = 'github_repos';
/** Installations re-synced per run (the spec's budget); the cursor carries the rest to the next run. */
export const GITHUB_REPOS_INSTALLATIONS_PER_RUN = 30;
/** Outside calls per run: the installation job's 300-call GitHub allowance is not shared across jobs, this one has its own. */
export const GITHUB_REPOS_CALLS_PER_RUN = 300;
/** Failures in a row that end a run: GitHub or our network is down, and further calls only spend the budget. */
const MAX_CONSECUTIVE_FAILURES = 3;

export type InstallationKind = 'team' | 'team_readonly' | 'sitekit';

/** What the job needs of one repo sync (`syncInstallationRepos` in production). */
export type RepoSyncOutcome = { status: 'synced'; etags?: readonly string[] } | { status: 'skipped'; reason: string };

export interface GithubReposDeps {
  /**
   * Re-sync one installation exactly as the webhook path does (same function, so its inactive checks, its advisory lock,
   * its detach rule and its events). The App JWT it mints with is the installation's own kind's. `conditional` carries the
   * ETags of the last complete listing and a gate to call before each list request. Never judges that an installation is
   * gone: only the installation job does that, on a per-installation 404.
   */
  sync(
    target: { installationId: string; kind: InstallationKind; ghInstallationId: number },
    conditional: { priorEtags: readonly string[] | null; allowCall: () => boolean },
  ): Promise<RepoSyncOutcome>;
  reportError: ReportError;
  installationsPerRun?: number;
  /** Tests only: a smaller per-run call allowance than GITHUB_REPOS_CALLS_PER_RUN. */
  callsPerRun?: number;
}

interface Row {
  id: string;
  app_kind: InstallationKind;
  gh: string;
  repo_list_etags: string[] | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Stop = 'budget' | 'limited' | 'failing';

/** What a thrown sync error means. Only a rate limit or our own call allowance running out stops the run for a reason that is not a failure. */
function classify(err: unknown): 'budget' | 'limited' | 'failure' {
  const e = (err && typeof err === 'object' ? err : {}) as { name?: unknown; rateLimited?: unknown; status?: unknown };
  if (e.name === 'RepoListBudgetError') return 'budget';
  if (e.rateLimited === true || e.status === 429) return 'limited';
  return 'failure';
}

/**
 * GitHub repo re-sync, every 6 hours (D#454 H2c): for each live installation (not deleted, not suspended), up to 30 a run in
 * installation-id order with a cursor, run the repo sync the webhook path runs. It catches repositories added or removed on
 * "all repositories" installs whose webhook was missed.
 *
 *  - An unchanged list costs nothing: the ETags of the last complete listing are sent as If-None-Match, and a 304 on every
 *    page means no write. They are saved only after a complete listing was written, and cleared by every lifecycle change;
 *  - this job never decides that an installation or a repository is gone from a list or a failure. It repairs toward the
 *    source of truth through the sync (which detaches, never deletes, and only after a complete listing); an installation
 *    that stopped existing is the installation job's call, on a per-installation 404;
 *  - a rate limit saves the cursor and stops; so does the call or time budget. Three failures in a row end the run too.
 */
export function createGithubReposJob(deps: GithubReposDeps): ReconcileJob {
  const stage = `reconcile.${GITHUB_REPOS_JOB}`;
  const perRun = deps.installationsPerRun ?? GITHUB_REPOS_INSTALLATIONS_PER_RUN;
  const report = (err: unknown, code?: string): void => deps.reportError(err, { stage, route: RECONCILE_ROUTE, ...(code ? { code } : {}) });

  return {
    name: GITHUB_REPOS_JOB,
    maxCalls: deps.callsPerRun ?? GITHUB_REPOS_CALLS_PER_RUN,
    async run(ctx: JobContext): Promise<JobResult> {
      const after = ctx.cursor !== null && UUID_RE.test(ctx.cursor) ? ctx.cursor : null; // a bad cursor starts over
      const { rows } = await ctx.pool.query<Row>(
        `SELECT i.id, i.app_kind, i.gh_installation_id::text AS gh, ii.repo_list_etags
           FROM installations i
           JOIN installation_installers ii ON ii.gh_installation_id = i.gh_installation_id AND ii.app_kind = i.app_kind
          WHERE ii.deleted_at IS NULL AND ii.suspended_at IS NULL AND ($1::uuid IS NULL OR i.id > $1::uuid)
          ORDER BY i.id
          LIMIT $2`,
        [after, perRun],
      );

      let lastDone: string | null = null;
      let failed = false;
      let consecutive = 0;
      let stop: Stop | undefined;

      for (const row of rows) {
        // One call for the token and the first list request are asked for here; every further page asks again.
        if (ctx.signal.aborted || ctx.msLeft() <= 0 || !ctx.calls.take(1)) {
          stop = 'budget';
          break;
        }
        const target = { installationId: row.id, kind: row.app_kind, ghInstallationId: Number(row.gh) };
        let outcome: RepoSyncOutcome;
        try {
          outcome = await deps.sync(target, {
            priorEtags: row.repo_list_etags,
            allowCall: () => !ctx.signal.aborted && ctx.msLeft() > 0 && ctx.calls.take(1),
          });
        } catch (err) {
          const kind = classify(err);
          if (kind === 'budget') {
            // fx-swallow-ok: the call allowance ran out before a request; that is a stop with the cursor kept, not a failure
            stop = 'budget';
            break;
          }
          if (kind === 'limited') {
            report(new Error('github rate limit: the run stopped and kept its place'), 'rate_limited');
            stop = 'limited';
            failed = true;
            break;
          }
          report(err);
          failed = true;
          // The place moves on: a poisoned installation must not hold the cursor, and it is looked at again next pass.
          lastDone = row.id;
          if (++consecutive >= MAX_CONSECUTIVE_FAILURES) {
            stop = 'failing';
            break;
          }
          continue;
        }
        consecutive = 0;
        if (outcome.status === 'synced') {
          // Saved only now, after the listing it describes was written, and never onto a lifecycle change that landed since.
          await ctx.pool.query(
            `UPDATE installation_installers SET repo_list_etags = $3
              WHERE gh_installation_id = $1 AND app_kind = $2 AND deleted_at IS NULL AND suspended_at IS NULL`,
            [row.gh, row.app_kind, outcome.etags && outcome.etags.length > 0 ? [...outcome.etags] : null],
          );
        }
        lastDone = row.id;
      }

      if (stop) return { cursor: lastDone ?? after, wrapped: false, ...(failed || stop === 'failing' ? { code: 'error' as const } : {}) };
      if (rows.length >= perRun) return { cursor: lastDone, wrapped: false, ...(failed ? { code: 'error' as const } : {}) };
      // The estate is covered. A pass with a failure restarts (and does not count as a full pass) so it is looked at again.
      return failed ? { cursor: null, wrapped: false, code: 'error' } : { cursor: null, wrapped: true };
    },
  };
}
