import type { PoolClient } from "pg";
import { COPY, type SandboxUnavailableReason } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";
import { UNNAMED_MEMBER } from "./memberRole.js";
import { CURRENT_PROTOCOL_VERSION, RunnerHttpError, type RunnerCloudDeps, type RunnerHttpResponse, type SessionPrincipal } from "./http.js";

/**
 * D#6 R2b criterion 13 (the read model) and criterion 16 (`GET /api/runners`, correction C6 section 2).
 *
 * Every state here is derived from rows at read time, never stored, so it cannot go stale and has no stamp to clear:
 *  - a runner is exactly one of `online_idle`, `busy`, `offline`, `outdated` or `revoked`;
 *  - a run waiting on something is exactly one of five reasons, or none.
 * Both read through the caller's tenant context, so another account's runner or run does not exist here.
 */

export const RUNNER_STATES = ["online_idle", "busy", "offline", "outdated", "revoked"] as const;
export type RunnerState = (typeof RUNNER_STATES)[number];

export const RUN_WAIT_REASONS = ["waiting_for_runner", "waiting_for_approval", "runner_lost_retrying", "timed_out_waiting", "paused_usage_limit"] as const;
export type RunWaitReason = (typeof RUN_WAIT_REASONS)[number];

/** A runner that has made no request for this long is `offline` (criterion 13). */
export const RUNNER_OFFLINE_AFTER_SECONDS = 120;

/** What the classifier needs of one runner. `busy` is "holds a running run whose lease has not run out". */
export interface RunnerFacts {
  revokedAt: Date | null;
  protocolVersion: number | null;
  lastSeenAt: Date | null;
  busy: boolean;
}

/**
 * The one state of a runner. Precedence, highest first: `revoked` (nothing else matters once the key is dead),
 * `outdated` (below N-1: it is refused at `hello`, and an upgrade is the only fix, so it says so even while it is quiet),
 * `offline` (no request for 120 seconds), `busy`, `online_idle`. A runner that has never said `hello` has no protocol
 * version and is not outdated: it is offline until it is heard from.
 */
export function classifyRunner(facts: RunnerFacts, now: Date, current: number = CURRENT_PROTOCOL_VERSION): RunnerState {
  if (facts.revokedAt !== null) return "revoked";
  if (facts.protocolVersion !== null && facts.protocolVersion < current - 1) return "outdated";
  if (facts.lastSeenAt === null || now.getTime() - facts.lastSeenAt.getTime() > RUNNER_OFFLINE_AFTER_SECONDS * 1000) return "offline";
  return facts.busy ? "busy" : "online_idle";
}

type ReadDeps = Pick<RunnerCloudDeps, "appUserPool" | "now" | "currentProtocolVersion">;

export interface RunnerRow {
  id: string;
  credential_mode: "subscription" | "api_key";
  registered_by: { id: string; name: string };
  binary_version: string | null;
  last_seen_at: string | null;
  state: RunnerState;
  /** D#6 R4a-6 (C16 section 1.3): why the runner's sandbox does not work, from its last poll; null while it works. A closed code, never text from the machine. */
  sandbox_unavailable: SandboxUnavailableReason | null;
  /**
   * D#6 R2b-4a (C31 section 2.3): whether its registrant lets work run on their Claude plan without asking each time. Derived from the newest
   * consent row: off when none exists, and off for a revoked runner (its consent stops counting). `changed_at` is when that row was written.
   */
  plan_consent: { granted: boolean; changed_at: string | null };
  /** True only on the caller's own live runner: the one person who may turn its consent on or off. Always false in a read with no user. */
  can_change_plan_consent: boolean;
  /**
   * D#6 R2b-4a follow-up: the repos this runner may take work for, as `{ id, name }` ("owner/name"), sorted by name. This is what the consent
   * dialog shows before the plan holder agrees. Only repos the caller can see: each id is looked up in `repos` through the caller's tenant
   * context, so an id that names another account's repo, or one that no longer exists, is dropped and never named. A revoked runner takes no
   * work, so it lists none.
   */
  repos: Array<{ id: string; name: string }>;
}

interface RawRunner {
  id: string;
  credential_mode: "subscription" | "api_key";
  registered_by: string;
  registered_by_name: string;
  binary_version: string | null;
  protocol_version: number | null;
  last_seen_at: Date | null;
  revoked_at: Date | null;
  sandbox_unavailable: SandboxUnavailableReason | null;
  consent_granted: boolean | null;
  consent_changed_at: Date | null;
  allowed_repo_ids: string[];
  busy: boolean;
}

/** A repo's display name, the same text the approvals list uses: "owner/name", else a fixed fallback, never null or an id. */
const REPO_NAME_SQL = "COALESCE(NULLIF(gh_owner || '/' || gh_name, ''), 'a repository')";

async function readRunners(deps: ReadDeps, accountId: string, userId: string | null): Promise<RunnerRow[]> {
  const now = (deps.now ?? (() => new Date()))();
  const current = deps.currentProtocolVersion ?? CURRENT_PROTOCOL_VERSION;
  const read = async (client: PoolClient): Promise<{ runners: RawRunner[]; repos: Map<string, string> }> => {
    const runners = (
      await client.query<RawRunner>(
        `SELECT r.id, r.credential_mode, r.registered_by, COALESCE(NULLIF(u.name, ''), NULLIF(u.github_login, ''), $3) AS registered_by_name,
                r.binary_version, r.protocol_version, r.last_seen_at, r.revoked_at, s.reason AS sandbox_unavailable,
                pc.granted AS consent_granted, pc.created_at AS consent_changed_at, r.allowed_repo_ids,
                EXISTS (SELECT 1 FROM agent_runs a
                         WHERE a.account_id = r.account_id AND a.runner_id = r.id AND a.status = 'running' AND a.lease_expires_at > $2) AS busy
           FROM runners r LEFT JOIN users u ON u.id = r.registered_by
                LEFT JOIN runner_sandbox_status s ON s.runner_id = r.id AND s.account_id = r.account_id
                LEFT JOIN LATERAL (SELECT c.granted, c.created_at FROM runner_plan_consents c
                                    WHERE c.account_id = r.account_id AND c.runner_id = r.id ORDER BY c.version DESC LIMIT 1) pc ON true
          WHERE r.account_id = $1
          ORDER BY r.created_at, r.id`,
        [accountId, now, UNNAMED_MEMBER],
      )
    ).rows;
    // The repo names, looked up under the caller's tenant (row security) and again by account, so a repo of another account is never named.
    const ids = [...new Set(runners.filter((r) => r.revoked_at === null).flatMap((r) => r.allowed_repo_ids))];
    const repos = new Map<string, string>();
    if (ids.length > 0) {
      const found = await client.query<{ id: string; name: string }>(`SELECT id, ${REPO_NAME_SQL} AS name FROM repos WHERE account_id = $1 AND id = ANY($2::uuid[])`, [accountId, ids]);
      for (const f of found.rows) repos.set(f.id, f.name);
    }
    return { runners, repos };
  };
  const { runners: rows, repos } =
    userId === null
      ? await withTenant(deps.appUserPool, accountId, read)
      : await withTenant(deps.appUserPool, accountId, userId, async (client) => {
          // A session route is for a member. The session already names an account the user belongs to; this keeps the read
          // closed even if a caller ever pairs a user with an account they are not in.
          const role = (await client.query<{ role: string | null }>("SELECT current_member_role() AS role")).rows[0]?.role;
          if (role === null || role === undefined) throw new RunnerHttpError(403, "forbidden", "you are not a member of this account");
          return read(client);
        });
  return rows.map((r) => ({
    id: r.id,
    credential_mode: r.credential_mode,
    registered_by: { id: r.registered_by, name: r.registered_by_name },
    binary_version: r.binary_version,
    last_seen_at: r.last_seen_at === null ? null : r.last_seen_at.toISOString(),
    // A revoked runner polls no more, so a stale reason is not shown for it.
    sandbox_unavailable: r.revoked_at === null ? r.sandbox_unavailable : null,
    state: classifyRunner({ revokedAt: r.revoked_at, protocolVersion: r.protocol_version, lastSeenAt: r.last_seen_at, busy: r.busy }, now, current),
    plan_consent: { granted: r.revoked_at === null && r.consent_granted === true, changed_at: r.consent_changed_at === null ? null : r.consent_changed_at.toISOString() },
    can_change_plan_consent: userId !== null && r.revoked_at === null && r.registered_by === userId,
    repos:
      r.revoked_at !== null
        ? []
        : [...new Set(r.allowed_repo_ids)]
            .filter((id) => repos.has(id))
            .map((id) => ({ id, name: repos.get(id)! }))
            .sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id)),
  }));
}

/** Each of the account's runners (revoked ones included, so the list can say so) with its one state. */
export async function getRunnerStates(deps: ReadDeps, accountId: string): Promise<Array<{ id: string; state: RunnerState }>> {
  return (await readRunners(deps, accountId, null)).map(({ id, state }) => ({ id, state }));
}

/** One runner run with the facts its wait reason is derived from. */
export interface RawRun {
  id: string;
  work_item_id: string | null;
  role: string;
  dispatch_repo_id: string | null;
  created_at: Date;
  status: string;
  runtime: string;
  initiated_by: string | null;
  approved_by: string | null;
  own_reason: string | null;
  parent_reason: string | null;
  claimable_after: Date | null;
  runnable_without_approval: boolean;
  needs_approval_possible: boolean;
  runner_online: boolean;
}

/**
 * The facts of the runs a filter selects, in one query. `$1` is the account, `$2` the clock and `$3` the offline window in seconds;
 * the filter's own parameters start at `$4`.
 */
const WAIT_FACTS = (filter: string, tail: string): string => `
  SELECT a.id, a.work_item_id, a.role, a.dispatch_repo_id, a.created_at, a.status, a.runtime, a.initiated_by, a.approved_by, a.claimable_after,
         (SELECT e.payload ->> 'failureReason' FROM run_events e WHERE e.run_id = a.id AND e.kind = 'run.status_changed' AND e.payload ->> 'to' = 'timed_out' ORDER BY e.seq DESC LIMIT 1) AS own_reason,
         -- The follow-up step test (C22 section 5): the parent counts only when it is a failed runner run whose last move to
         -- failed recorded one of the two follow-up reasons. Any other parent says nothing about why this run waits.
         (SELECT x.reason FROM agent_runs pr
            CROSS JOIN LATERAL (SELECT e.payload ->> 'failureReason' AS reason FROM run_events e
                                 WHERE e.run_id = pr.id AND e.kind = 'run.status_changed' AND e.payload ->> 'to' = 'failed'
                                 ORDER BY e.seq DESC LIMIT 1) x
           WHERE pr.account_id = a.account_id AND pr.id = a.parent_run_id AND pr.runtime = 'runner' AND pr.status = 'failed') AS parent_reason,
         -- A runner "covers" the run when it is live (not revoked) and the run's repo is in its own list: the test the claim applies.
         -- It can take the run without a click when it is an api_key runner, when its registrant started or approved the run, or when
         -- the claim would approve the run for it by itself (the dial and its registrant's consent: runner_plan_auto_approvable, which
         -- the claim calls too, so this and the claim cannot disagree).
         EXISTS (SELECT 1 FROM runners r WHERE r.account_id = a.account_id AND r.revoked_at IS NULL AND a.dispatch_repo_id = ANY(r.allowed_repo_ids)
                    AND (r.credential_mode = 'api_key' OR r.registered_by IN (a.initiated_by, a.approved_by)
                         OR (a.approved_by IS NULL AND r.credential_mode = 'subscription' AND runner_plan_auto_approvable(r.id, a.dispatch_repo_id)))) AS runnable_without_approval,
         EXISTS (SELECT 1 FROM runners r WHERE r.account_id = a.account_id AND r.revoked_at IS NULL AND a.dispatch_repo_id = ANY(r.allowed_repo_ids)
                    AND r.credential_mode = 'subscription') AS needs_approval_possible,
         EXISTS (SELECT 1 FROM runners r WHERE r.account_id = a.account_id AND r.revoked_at IS NULL AND r.last_seen_at > $2::timestamptz - make_interval(secs => $3)
                    AND a.dispatch_repo_id = ANY(r.allowed_repo_ids)) AS runner_online
    FROM agent_runs a WHERE a.account_id = $1 AND ${filter} ${tail}`;

/** Pure. The one wait reason of a run's facts, or null. See `getRunWaitReason` for each. */
export function waitReasonOf(row: RawRun, now: Date): RunWaitReason | null {
  if (row.runtime !== "runner") return null;
  if (row.status === "timed_out") return row.own_reason === "queue_ttl" ? "timed_out_waiting" : null;
  if (row.status !== "pending") return null;
  // A usage-limit follow-up waits for its own claimable_after (the reset time); once that has passed it waits like any other run.
  if (row.parent_reason === "usage_limit" && row.claimable_after !== null && row.claimable_after.getTime() > now.getTime()) return "paused_usage_limit";
  if (row.parent_reason === "runner_lost") return "runner_lost_retrying";
  if (row.approved_by === null && !row.runnable_without_approval && row.needs_approval_possible) return "waiting_for_approval";
  if (!row.runner_online) return "waiting_for_runner";
  return null;
}

/**
 * Why a run is waiting, or null when it is not waiting on anything this model names (running, finished, not a runner run,
 * or about to be claimed because a runner that can take it is online). Derived on read from the run, its parent and the
 * account's runners:
 *  - `timed_out_waiting`: the run ended in `timed_out` with reason `queue_ttl`;
 *  - `paused_usage_limit`: a pending follow-up whose parent failed with `usage_limit` and whose own `claimable_after` (the
 *    reset time) is still ahead; `runner_lost_retrying`: a pending follow-up whose parent failed with `runner_lost`. The
 *    parent counts only under the follow-up step test (a failed runner run whose last move to failed recorded one of the two);
 *  - `waiting_for_approval`: pending, nobody has approved it, and no runner that covers its repo can take it as things stand, though
 *    at least one subscription runner covers the repo (so a click, or a dial and a consent, would let it run). A covering runner is
 *    live (not revoked) and lists the run's repo in its `allowed_repo_ids`, the claim's own test. It can take the run when it is an
 *    `api_key` runner, when its registrant started or approved the run, or when the claim would approve the run for it at claim time:
 *    the registrant's consent on that runner is on and the repo's dial for runner runs is not `ask` (C31 section 2.2). A run whose
 *    starter was never recorded (`initiated_by` NULL, which is every pipeline run) reads this way too;
 *  - `waiting_for_runner`: pending and no live runner FOR THE RUN'S REPO: not revoked, heard from within 120 seconds, and with the
 *    run's repo in its `allowed_repo_ids`. A live runner whose list leaves the repo out can never claim the run (the claim returns
 *    idle for it), so it does not count; neither does one with an empty list, because the claim reads an empty repo list as
 *    "no repo" (only `allowed_roles` reads empty as "all"). The waiting notice in the worker uses the same test, so the two agree.
 * The runner's roles are the claim's business and are not second-guessed here.
 */
export async function getRunWaitReason(deps: ReadDeps, accountId: string, runId: string): Promise<RunWaitReason | null> {
  const now = (deps.now ?? (() => new Date()))();
  const row = await withTenant(deps.appUserPool, accountId, async (client) => {
    const { rows } = await client.query<RawRun>(WAIT_FACTS("a.id = $4", ""), [accountId, now, RUNNER_OFFLINE_AFTER_SECONDS, runId]);
    return rows[0];
  });
  return row ? waitReasonOf(row, now) : null;
}

/** The pending, unapproved runner runs of the account, newest first, with their facts. Run on a client already inside the caller's tenant. */
export async function readUnapprovedRunFacts(client: PoolClient, accountId: string, now: Date, limit: number): Promise<RawRun[]> {
  const { rows } = await client.query<RawRun>(WAIT_FACTS("a.status = 'pending' AND a.runtime = 'runner' AND a.approved_by IS NULL", "ORDER BY a.created_at DESC, a.id LIMIT $4"), [accountId, now, RUNNER_OFFLINE_AFTER_SECONDS, limit]);
  return rows;
}

/**
 * GET /api/runners (a session route, any member of the account). The runners with their derived state and consent, and the copy
 * strings the runner screens show, so the UI never retypes them. A runner's key, thumbprint and nonces are not selected, so they
 * cannot be returned. Its repo list is returned as `{ id, name }` pairs, and only for repos the caller's tenant context can read.
 */
export async function listRunners(deps: RunnerCloudDeps, principal: SessionPrincipal): Promise<RunnerHttpResponse> {
  const runners = await readRunners(deps, principal.accountId, principal.userId);
  return {
    status: 200,
    body: {
      runners,
      copy: {
        usageLimits: COPY.usageLimits,
        approval: COPY.approval,
        runner: COPY.runner,
        localOnly: COPY.localOnly,
        sandboxUnavailable: COPY.sandboxUnavailable,
        approvalMine: COPY.approvalMine,
        approvalButton: COPY.approvalButton,
        approvalDone: COPY.approvalDone,
        approvalRefused: COPY.approvalRefused,
        approvalAuto: COPY.approvalAuto,
        planConsentText: COPY.planConsentText,
        dialRunnerRuns: COPY.dialRunnerRuns,
        dialRunnerRunsAsk: COPY.dialRunnerRunsAsk,
        dialRunnerRunsAnnounce: COPY.dialRunnerRunsAnnounce,
        dialRunnerRunsAct: COPY.dialRunnerRunsAct,
      },
    },
    headers: { "cache-control": "no-store" },
  };
}
