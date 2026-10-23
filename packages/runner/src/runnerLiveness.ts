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
export function runnerLiveSql(input: { runner: string; now: string; onlineSeconds?: string; wakeEnabled: boolean }): string {
  if (!ALIAS.test(input.runner)) throw new Error("runnerLiveSql: runner must be a plain alias");
  if (!PARAM.test(input.now)) throw new Error("runnerLiveSql: now must be a placeholder");
  if (input.onlineSeconds !== undefined && !PARAM.test(input.onlineSeconds)) throw new Error("runnerLiveSql: onlineSeconds must be a placeholder");
  const r = input.runner;
  const online = input.onlineSeconds ?? String(RUNNER_ONLINE_SECONDS);
  if (!input.wakeEnabled) return `${r}.last_seen_at >= ${input.now}::timestamptz - make_interval(secs => ${online})`;
  return `(${r}.last_seen_at >= ${input.now}::timestamptz - make_interval(secs => ${online})
           OR (${r}.last_seen_at >= ${input.now}::timestamptz - make_interval(secs => ${RUNNER_WAKE_LIVENESS_SECONDS})
               AND EXISTS (SELECT 1 FROM runner_capabilities wake_cap
                            WHERE wake_cap.runner_id = ${r}.id AND wake_cap.account_id = ${r}.account_id AND '${WAKE_CAPABILITY}' = ANY(wake_cap.capabilities))))`;
}
