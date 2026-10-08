import type { Pool } from "pg";
import type { ReportContext } from "@fx/telemetry";
import { withTenant } from "@fx/db/src/withTenant.js";
import { RUNNER_TTL_REMINDER_MS, RUNNER_WAITING_NOTICE_MS, RUN_EVENTS_SEQ_LOCK_SQL, recordRunnerNotice, runEventsSeqLockKey } from "@fx/runner";

/**
 * D#6 R2b (correction C14 section 4): the two notices a run waiting for a runner can raise.
 *
 *  - `runner.waiting`, once, at the first tick at or after 15 minutes from dispatch when no runner is online;
 *  - `runner.ttl_reminder`, once, at the first tick at or after 48 hours from dispatch while the run is still waiting
 *    (the queue time ends at 72 hours, so this is the reminder 24 hours before it).
 *
 * Both are "not before" rules: nothing is emitted early, and the cadence only adds the sweep's delay. Each notice is a
 * `run_events` row of that kind on the run, written under the run's own tenant and holding ids and times only. The row is
 * also the marker that it was sent: a notice is written only while no row of its kind exists, under the same per-run lock
 * every `run_events` writer takes, so overlapping ticks cannot send it twice and there is no second place to keep in step.
 * A notice for a run that is no longer waiting is never written. "No runner online" is FOR THE RUN'S REPO, the reading the wait
 * reason in `@fx/runner-cloud` uses too: a runner counts only if it is not revoked, was heard from within `onlineWithinMs` (the 120
 * seconds the runner list uses), and has the run's repo in its own `allowed_repo_ids`. A live runner whose list leaves the repo out
 * can never claim the run, so it must not hold the notice back; and an empty list takes no repo (the claim reads it that way;
 * only `allowed_roles` reads empty as "all").
 *
 * Second check (correction C24 section 2): a run whose repo is no longer `runner_local` owes no notice and gets none, even if it is
 * still `pending` (the switch cancels such runs, and the queue sweep cancels one inserted just after it; this closes the gap
 * between). The run's own `execution_mode` says what it was dispatched as; the repo's says where work for it goes now, and only
 * the second decides whether anyone is going to claim it.
 *
 * Cross-tenant, for the cron only. It lists the runs that still owe a notice through `agent_run_list_runner_runs_owing_notice`
 * (0757), ordered by when their next notice falls due: a run whose two notices are both written is not listed, and one that has
 * only its 15 minute notice sorts by the 48 hour reminder still to come, so neither can hide a newer run that is owed something
 * sooner. The first run listed therefore carries the earliest due time of all, and the tick returns it so the cron can store it.
 * A run held back only because a runner is online for its repo stays due and is looked at again each tick; enough of those at
 * once (50) can still crowd out later ones, which is a limit of the list size and not of what is owed.
 */

/** The most runs one tick looks at (the lister allows 50). */
export const RUNNER_NOTICE_BATCH = 50;

export interface RunnerNoticeResult {
  listed: number;
  waitingEmitted: number;
  reminderEmitted: number;
  /** Runs still pending whose repo is no longer `runner_local`: they owe no notice (the second check above). */
  skippedMode: number;
  failed: number;
  /** Epoch ms of the next notice still to come (or soon, after a failure or a full batch); null when none is pending. */
  nextDueAt: number | null;
}

export interface RunnerNoticeSweeper {
  /** One tick. For the cron only: it works across tenants. */
  sweepRunnerNotices(): Promise<RunnerNoticeResult>;
}

export interface RunnerNoticeDeps {
  now?: () => number;
  /** A runner heard from within this long counts as online. */
  onlineWithinMs?: number;
  retryDelayMs?: number;
  onError?: (runId: string, error: unknown) => void;
  /** Called once in a tick whose list came back full (50): more runs may be waiting behind it. */
  onBacklog?: () => void;
}

interface Waiting {
  account_id: string;
  run_id: string;
  created_at: Date;
}

interface Facts {
  status: string;
  repo_id: string | null;
  repo_mode: string | null;
  has_waiting: boolean;
  has_reminder: boolean;
  runner_online: boolean;
}

/**
 * What the sweep reports (D#6 R2b-3h): a fixed code per case and nothing a failure could carry. A run whose notice failed is one
 * `reportError` with the code `runner_notice_failed` on a fresh error (never the caught one, whose text could hold anything), and a
 * log line with the run id. A full page from the lister is `runner_notice_backlog`, once per tick. The reporter and the log are
 * handed in, so the composition root passes the real ones and a test passes recorders.
 */
export function runnerNoticeReports(io: { report: (err: unknown, ctx: ReportContext) => void; warn: (line: string) => void }): Required<Pick<RunnerNoticeDeps, "onError" | "onBacklog">> {
  const stage = "runner.notice";
  return {
    onError: (runId) => {
      io.warn(JSON.stringify({ event: "runner.notice_sweep_failed", run_id: runId }));
      io.report(new Error("runner notice failed"), { stage, code: "runner_notice_failed" });
    },
    onBacklog: () => io.report(new Error("runner notice backlog"), { stage, code: "runner_notice_backlog" }),
  };
}

/** Package-internal: `pool` is the runner login's pool and is captured here, never exposed. */
export function createRunnerNoticeSweeper(pool: Pool, deps: RunnerNoticeDeps = {}): RunnerNoticeSweeper {
  const now = deps.now ?? Date.now;
  const onlineWithinMs = deps.onlineWithinMs ?? 120_000;
  return {
    async sweepRunnerNotices() {
      const result: RunnerNoticeResult = { listed: 0, waitingEmitted: 0, reminderEmitted: 0, skippedMode: 0, failed: 0, nextDueAt: null };
      const { rows } = await pool.query<Waiting>("SELECT account_id, run_id, created_at FROM agent_run_list_runner_runs_owing_notice($1, $2, $3)", [RUNNER_NOTICE_BATCH, RUNNER_WAITING_NOTICE_MS, RUNNER_TTL_REMINDER_MS]);
      result.listed = rows.length;
      if (rows.length >= RUNNER_NOTICE_BATCH) deps.onBacklog?.();
      const consider = (at: number): void => {
        result.nextDueAt = result.nextDueAt === null ? at : Math.min(result.nextDueAt, at);
      };
      for (const row of rows) {
        const dispatched = row.created_at.getTime();
        try {
          const sent = await withTenant(pool, row.account_id, async (client) => {
            await client.query(RUN_EVENTS_SEQ_LOCK_SQL, [runEventsSeqLockKey(row.run_id)]);
            const { rows: found } = await client.query<Facts>(
              `SELECT a.status, a.dispatch_repo_id AS repo_id,
                      (SELECT g.execution_mode FROM repos g WHERE g.id = a.dispatch_repo_id AND g.account_id = a.account_id) AS repo_mode,
                      EXISTS (SELECT 1 FROM run_events e WHERE e.run_id = a.id AND e.kind = 'runner.waiting') AS has_waiting,
                      EXISTS (SELECT 1 FROM run_events e WHERE e.run_id = a.id AND e.kind = 'runner.ttl_reminder') AS has_reminder,
                      EXISTS (SELECT 1 FROM runners r WHERE r.account_id = a.account_id AND r.revoked_at IS NULL
                                 AND r.last_seen_at > $3::timestamptz - make_interval(secs => $4)
                                 AND a.dispatch_repo_id = ANY(r.allowed_repo_ids)) AS runner_online
                 FROM agent_runs a WHERE a.id = $1 AND a.account_id = $2`,
              [row.run_id, row.account_id, new Date(now()), onlineWithinMs / 1000],
            );
            const facts = found[0];
            if (!facts || facts.status !== "pending" || facts.repo_mode !== "runner_local") return { waiting: false, reminder: false, due: null as number | null, skipped: facts?.status === "pending" };
            let waiting = false;
            let reminder = false;
            let due: number | null = null;
            const write = (kind: "runner.waiting" | "runner.ttl_reminder", payload: Record<string, unknown>): Promise<void> =>
              recordRunnerNotice(client, { accountId: row.account_id, runId: row.run_id, kind, payload });
            if (!facts.has_waiting) {
              if (now() >= dispatched + RUNNER_WAITING_NOTICE_MS) {
                // Past 15 minutes: send it only if there is still no runner. If one is online, look again next tick.
                if (!facts.runner_online) {
                  await write("runner.waiting", { repo_id: facts.repo_id, waited_since: row.created_at.toISOString() });
                  waiting = true;
                } else due = now() + (deps.retryDelayMs ?? 5 * 60_000);
              } else due = dispatched + RUNNER_WAITING_NOTICE_MS;
            }
            if (!facts.has_reminder) {
              if (now() >= dispatched + RUNNER_TTL_REMINDER_MS) {
                await write("runner.ttl_reminder", { repo_id: facts.repo_id, waited_since: row.created_at.toISOString() });
                reminder = true;
              } else {
                const at = dispatched + RUNNER_TTL_REMINDER_MS;
                due = due === null ? at : Math.min(due, at);
              }
            }
            return { waiting, reminder, due, skipped: false };
          });
          if (sent.skipped) result.skippedMode++;
          if (sent.waiting) result.waitingEmitted++;
          if (sent.reminder) result.reminderEmitted++;
          if (sent.due !== null) consider(sent.due);
        } catch (error) {
          // fx-swallow-ok: counted as failed and handed to onError (the worker logs a fixed code and the run id); the next tick looks again
          result.failed++;
          deps.onError?.(row.run_id, error);
        }
      }
      if (result.failed > 0) consider(now() + (deps.retryDelayMs ?? 5 * 60_000));
      // A full list means more runs may be waiting behind it. Notices written this tick took runs off the list, so look again at once.
      if (rows.length >= RUNNER_NOTICE_BATCH && result.waitingEmitted + result.reminderEmitted > 0) consider(now());
      return result;
    },
  };
}
