import { WAKE_CAPABILITY } from "@fulcrumaxe/runner-protocol";
import { RUNNER_ONLINE_SECONDS } from "./runnerOnline.js";

/**
 * D#6 RUNNER-WAKE: the one rule for "is this runner there?". Every consumer (the fleet read, the handoff's covering test, the wait reason, the
 * waiting notice, the claim's routing and its account ceiling) asks it here, in TypeScript or as the SQL predicate below, so no two can disagree.
 *
 * A runner is heard from at the later of its database stamp (`runners.last_seen_at`, moved by hello, claim and heartbeat) and its cached wake check
 * (`seen:<rid>` in Runtime Cache, when the caller has one). It is live when that is within `RUNNER_ONLINE_SECONDS` (120), or, for a runner whose
 * latest hello listed `wake_v1`, within `RUNNER_WAKE_LIVENESS_SECONDS`. A wake runner claims only on work or at its safety slot (the next 30-minute
 * boundary, plus up to 2 minutes' jitter), so between slots its database stamp is up to ~32 minutes old while it is perfectly alive. Non-wake runners are unchanged.
 *
 * Both edges are inclusive, in TypeScript and in SQL.
 */

/**
 * How long a wake-capable runner may go unheard before it reads absent: one 30-minute safety slot plus 5 minutes' grace. The cloud's idle answer
 * alone may reach exactly this (slot + up to 300 s); fx-runner's `safetyClaimAt` clamp (boundary + at most 120 s) is what keeps a live runner
 * about 3 minutes inside it. See `runnerLiveSql` for the full dependency.
 */
export const RUNNER_WAKE_LIVENESS_SECONDS = 35 * 60;

/** What the rule reads about one runner. */
export interface RunnerLivenessFacts {
  /** `runners.last_seen_at`. */
  lastSeenAt: Date | null;
  /** The cached wake check, when the caller read one. Absent or null: only the database stamp counts (a cache miss). */
  seenAt?: Date | null;
  /** Its latest hello listed `wake_v1` AND the deployment's wake gate is open (a wake key is configured, so it holds a grant). Absent reads as false. */
  wakeCapable?: boolean;
}

/** Pure. The window this runner gets, in seconds. */
export function runnerLivenessSeconds(wakeCapable: boolean | undefined): number {
  return wakeCapable === true ? RUNNER_WAKE_LIVENESS_SECONDS : RUNNER_ONLINE_SECONDS;
}

/** Pure. When the runner was last heard from: the later of the database stamp and the cached wake check. */
export function runnerLastHeardAt(facts: Pick<RunnerLivenessFacts, "lastSeenAt" | "seenAt">): Date | null {
  const db = facts.lastSeenAt;
  const cached = facts.seenAt ?? null;
  if (db === null) return cached;
  if (cached === null) return db;
  return cached.getTime() > db.getTime() ? cached : db;
}

/** Pure. Whether the runner counts as present now. */
export function runnerIsLive(facts: RunnerLivenessFacts, now: Date): boolean {
  const heard = runnerLastHeardAt(facts);
  if (heard === null) return false;
  return now.getTime() - heard.getTime() <= runnerLivenessSeconds(facts.wakeCapable) * 1000;
}

const ALIAS = /^[a-z_][a-z0-9_]*$/;
const PARAM = /^\$\d+(::[a-z]+)?$/;

/**
 * The same rule as an SQL predicate over a `runners` row aliased `runner`, for a query that has no cached wake checks (every SQL consumer: none of
 * them may read the cache, see below). `now` is the clock's placeholder (a timestamptz), `onlineSeconds` the placeholder of the ordinary window,
 * or the 120-second constant when omitted. `wakeEnabled` is the deployment's wake gate (no wake key: no runner holds a grant, so none goes quiet, and
 * the predicate is the plain 120-second test). Wake capability is the runner's own `runner_capabilities` row (0893, 0895); no row reads as not wake-capable.
 *
 * Why the database stamp alone is enough here: a live wake runner claims at least every 32 minutes, and at once after three failed wake checks, so
 * its stamp is always inside the 35-minute window. That bound is not enforced here; it rests on two things outside this package:
 *  - the cloud's idle answer to a runner it grants a wake token, with nothing queued (`wakeSafetyRetryAfterSeconds` in runner-cloud's
 *    wakeToken.ts, used by the claim): `retry_after` runs to just after the next 30-minute slot boundary plus a stable per-runner offset of at
 *    most `WAKE_SAFETY_JITTER_SECONDS` (300 s), so at most 1800 + 300 = 2100 s. On its own that equals this window, with no margin;
 *  - fx-runner's `safetyClaimAt` (packages/fx-runner/src/daemon/wake.ts) never waits longer than that answer, and for one over a minute moves the
 *    claim earlier to the last slot boundary before it plus at most `WAKE_SLOT_JITTER_MS` (120 s). For the cloud's answer above that boundary is
 *    the next one, so the gap between claims is at most 1800 + 120 s, about 32 minutes: the 3 minutes of margin come from this clamp.
 * Queued-but-blocked answers stay short, and the longer pause, drain and usage-limit answers (up to an hour) go only to runners those consumers
 * already leave out by their own tests. A longer slot, offset or jitter, or a runner that waits the cloud's answer out unclamped, must widen
 * `RUNNER_WAKE_LIVENESS_SECONDS` with it.
 *
 * The cache only adds a runner that missed its safety claim, which is the one runner whose next claim is in doubt. Reading it would also put a
 * cache round trip, and a first query for the account's runner ids, on paths that run inside a transaction (the claim) or across tenants (the
 * notice cron).
 */
export function runnerLiveSql(input: { runner: string; now: string; onlineSeconds?: string; wakeEnabled: boolean; replyAware?: boolean }): string {
  if (!ALIAS.test(input.runner)) throw new Error("runnerLiveSql: runner must be a plain alias");
  if (!PARAM.test(input.now)) throw new Error("runnerLiveSql: now must be a placeholder");
  if (input.onlineSeconds !== undefined && !PARAM.test(input.onlineSeconds)) throw new Error("runnerLiveSql: onlineSeconds must be a placeholder");
  const r = input.runner;
  const online = input.onlineSeconds ?? String(RUNNER_ONLINE_SECONDS);
  if (!input.wakeEnabled) return `${r}.last_seen_at >= ${input.now}::timestamptz - make_interval(secs => ${online})`;
  const live = `(${r}.last_seen_at >= ${input.now}::timestamptz - make_interval(secs => ${online})
           OR (${r}.last_seen_at >= ${input.now}::timestamptz - make_interval(secs => ${RUNNER_WAKE_LIVENESS_SECONDS})
               AND EXISTS (SELECT 1 FROM runner_capabilities wake_cap
                            WHERE wake_cap.runner_id = ${r}.id AND wake_cap.account_id = ${r}.account_id AND '${WAKE_CAPABILITY}' = ANY(wake_cap.capabilities))))`;
  // Reply-aware (D#6 PING-CONSUMERS): a wake runner that has left claimable work unanswered for 90 s no longer counts as there. Only with the gate open,
  // since without it no runner holds a grant and none goes quiet.
  return input.replyAware === true ? `(${live} AND NOT ${runnerIgnoringWorkSql({ runner: r, now: input.now })})` : live;
}

/** How long a wake runner may leave claimable work unanswered before it reads as not responding (the fleet screen's 90 s, #428). */
export const RUNNER_WORK_REPLY_SECONDS = 90;

/** What `runnerIgnoringWork` reads: the runner's own rows plus the account's pending runner runs. Any missing input reads as "not ignoring". */
export interface RunnerReplyFacts {
  /** `runners.last_seen_at`. Null: never heard, so nothing is flagged (that is the offline test's job). */
  lastSeenAt: Date | null;
  /** The latest `lease_expires_at` over the runner's running runs (each extension is 90 s from its request), or null with none. */
  latestLeaseExpiresAt: Date | null;
  /** Its latest hello listed `wake_v1`. */
  wakeCapable: boolean;
  /** A `runner_sandbox_status` row with a reason exists: the runner told the cloud its sandbox is down, so it is quiet on purpose. */
  sandboxDown: boolean;
  /** `runner_capacity.limited_by` is `usage_limit` or `paused`: the cloud told it to wait. */
  heldBack: boolean;
  /** The account's pending, unassigned runner-runtime runs, each as `claimable_since` and `claimable_after`. */
  pending: ReadonlyArray<{ claimableSince: Date; claimableAfter: Date | null }>;
}

/** Pure twin of `runnerIgnoringWorkSql`. True: a pending run became claimable at least 90 s ago and nothing was heard from the runner since. */
export function runnerIgnoringWork(facts: RunnerReplyFacts, now: Date): boolean {
  if (!facts.wakeCapable || facts.sandboxDown || facts.heldBack) return false;
  const lease = facts.latestLeaseExpiresAt === null ? null : facts.latestLeaseExpiresAt.getTime() - RUNNER_WORK_REPLY_SECONDS * 1000;
  const stamp = facts.lastSeenAt === null ? null : facts.lastSeenAt.getTime();
  // Postgres GREATEST skips NULLs; with both missing the comparison is NULL and nothing is flagged.
  const heard = stamp === null ? lease : lease === null ? stamp : Math.max(stamp, lease);
  if (heard === null) return false;
  return facts.pending.some((run) => {
    const anchor = Math.max(run.claimableSince.getTime(), run.claimableAfter?.getTime() ?? Number.NEGATIVE_INFINITY);
    return anchor <= now.getTime() - RUNNER_WORK_REPLY_SECONDS * 1000 && anchor > heard;
  });
}

/**
 * D#6 PING-CONSUMERS: "this wake runner is not answering", worked out in SQL from rows that already exist, so the claim, the waiting notice and the
 * wait reason can all use it without a cache read (see `runnerLiveSql`). True when the runner holds `wake_v1`, its sandbox is not reported down, the
 * cloud has not told it to wait (usage limit or pause), and a pending runner run of its account became claimable (`claimable_since`, or a later
 * `claimable_after`) at least 90 s ago and later than the last time the database heard from it: its stamp, or a running run's lease extension less 90 s.
 * Every input missing reads as false, so the rule can only narrow who counts as present. `runner` and `now` are an alias and a placeholder, as above.
 * Under RLS the runs are the runner's own account's.
 */
export function runnerIgnoringWorkSql(input: { runner: string; now: string }): string {
  if (!ALIAS.test(input.runner)) throw new Error("runnerIgnoringWorkSql: runner must be a plain alias");
  if (!PARAM.test(input.now)) throw new Error("runnerIgnoringWorkSql: now must be a placeholder");
  const r = input.runner;
  const n = input.now;
  return `(EXISTS (SELECT 1 FROM runner_capabilities ign_cap
                    WHERE ign_cap.runner_id = ${r}.id AND ign_cap.account_id = ${r}.account_id AND '${WAKE_CAPABILITY}' = ANY(ign_cap.capabilities))
           AND NOT EXISTS (SELECT 1 FROM runner_sandbox_status ign_ss
                            WHERE ign_ss.runner_id = ${r}.id AND ign_ss.account_id = ${r}.account_id AND ign_ss.reason IS NOT NULL)
           AND NOT EXISTS (SELECT 1 FROM runner_capacity ign_rc
                            WHERE ign_rc.runner_id = ${r}.id AND ign_rc.account_id = ${r}.account_id AND ign_rc.limited_by IN ('usage_limit', 'paused'))
           AND EXISTS (SELECT 1 FROM agent_runs ign_w
                        WHERE ign_w.account_id = ${r}.account_id AND ign_w.status = 'pending' AND ign_w.runtime = 'runner' AND ign_w.runner_id IS NULL
                          AND GREATEST(ign_w.claimable_since, ign_w.claimable_after) <= ${n}::timestamptz - make_interval(secs => ${RUNNER_WORK_REPLY_SECONDS})
                          AND GREATEST(ign_w.claimable_since, ign_w.claimable_after) > GREATEST(
                                ${r}.last_seen_at,
                                (SELECT max(ign_h.lease_expires_at) - make_interval(secs => ${RUNNER_WORK_REPLY_SECONDS}) FROM agent_runs ign_h
                                  WHERE ign_h.account_id = ${r}.account_id AND ign_h.runner_id = ${r}.id AND ign_h.status = 'running'))))`;
}
