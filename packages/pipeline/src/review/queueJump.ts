import type { PoolClient } from "pg";

/**
 * TWO-LANE-QUEUE: the rule for asking GitHub's merge queue to put the cloud's own pull request at the front.
 *
 * Why only the cloud's gate: this module is reached only from `runMergeGateForItem`, which merges pull requests the platform built. A team pull request is merged by the
 * team's wrapper (`scripts/lib/merge_queue.py`) and never passes here, so it can never jump through this code. Where it applies: only the repositories listed in
 * `FX_GATE1_ATTEST_REPOS` (the dogfood code repository, where the cloud's App is the ruleset's bypass actor), so a customer's queue is never reordered.
 *
 * The cost, from GitHub's own page on the queue: a jump rebuilds every entry already in progress. So the rule has a throttle: at most one jump per repository per
 * `minMinutes`, and the default is a little over one run of the repository's slowest required check (the `check` job takes 45 to 50 minutes), so that team entries
 * restarted by one jump can finish before the next one. The throttle is DERIVED from the recorded `merge_enqueued` facts that carry `queue_jump`, not from a stamp
 * kept somewhere else: an undone or lost fact can never leave the repository throttled for good.
 */

/** The reasons written on a `merge_enqueued` fact. `queue_jump`: the entry went to the front. `jump_refused`: a jump was asked for, GitHub refused, the retry queued it at the back. `jump_throttled`: allowed by the switch, held back by the throttle. */
export const QUEUE_JUMP_REASON = "queue_jump";
export const JUMP_REFUSED_REASON = "jump_refused";
export const JUMP_THROTTLED_REASON = "jump_throttled";

export const DEFAULT_QUEUE_JUMP_MIN_MINUTES = 50;
export const MAX_QUEUE_JUMP_MIN_MINUTES = 24 * 60;

export interface QueueJumpSettings {
  /** The switch. Default on; `FX_QUEUE_JUMP=off` turns it off. Any other value is read as off (fail closed: a typo never reorders the queue). */
  enabled: boolean;
  /** `owner/name`, lower case: the repositories a jump may be asked for. */
  repos: ReadonlySet<string>;
  /** At most one jump per repository in this many minutes. */
  minMinutes: number;
}

/** `FX_QUEUE_JUMP` (unset or `on`: on; `off`: off; anything else: off) and `FX_QUEUE_JUMP_MIN_MINUTES` (a whole number from 1 to 1440; anything else: the default). */
export function parseQueueJumpSettings(env: Readonly<Record<string, string | undefined>>, repos: ReadonlySet<string>): QueueJumpSettings {
  const raw = env.FX_QUEUE_JUMP?.trim().toLowerCase();
  const enabled = raw === undefined || raw === "" || raw === "on";
  const m = env.FX_QUEUE_JUMP_MIN_MINUTES?.trim();
  const n = m !== undefined && /^[0-9]{1,4}$/.test(m) ? Number(m) : NaN;
  const minMinutes = Number.isSafeInteger(n) && n >= 1 && n <= MAX_QUEUE_JUMP_MIN_MINUTES ? n : DEFAULT_QUEUE_JUMP_MIN_MINUTES;
  return { enabled, repos: new Set([...repos].map((r) => r.toLowerCase())), minMinutes };
}

/** The newest jump fact of the repository inside the window, as minutes ago (null: none). One read, scoped to the account and repository. */
async function minutesSinceLastJump(client: Pick<PoolClient, "query">, accountId: string, repoId: string, windowMinutes: number): Promise<number | null> {
  const { rows } = await client.query<{ minutes: string }>(
    `SELECT extract(epoch FROM (now() - max(e.created_at))) / 60 AS minutes
       FROM work_item_driver_events e
       JOIN work_items w ON w.account_id = e.account_id AND w.id = e.work_item_id
      WHERE e.account_id = $1 AND w.repo_id = $2 AND e.kind = 'merge_enqueued' AND $3 = ANY(e.reasons)
        AND e.created_at > now() - make_interval(mins => $4)`,
    [accountId, repoId, QUEUE_JUMP_REASON, windowMinutes],
  );
  const v = rows[0]?.minutes;
  return v === null || v === undefined ? null : Number(v);
}

/** The answer the gate's `queueJump` dep gives for one pull request of one repository. */
export async function decideQueueJump(
  settings: QueueJumpSettings | undefined,
  client: Pick<PoolClient, "query">,
  input: { accountId: string; repoId: string; owner: string; name: string },
): Promise<"jump" | "throttled" | "none"> {
  if (settings === undefined || !settings.enabled) return "none";
  if (!settings.repos.has(`${input.owner}/${input.name}`.toLowerCase())) return "none";
  const ago = await minutesSinceLastJump(client, input.accountId, input.repoId, settings.minMinutes);
  return ago === null ? "jump" : "throttled";
}
