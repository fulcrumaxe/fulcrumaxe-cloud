import type { PoolClient } from "pg";
import { recordDriverEvent } from "@fx/core/src/work-items/driverEvents.js";
import { reportError } from "@fx/telemetry";
import type { OrderedResourceReaderPort } from "../build/githubMergePort.js";
import type { PullRequestRef } from "../build/types.js";
import { checkOrdering, detectResource, orderedCode as part, readOrderedConfig, type ResourceRule } from "./orderedResources.js";
import { MERGE_QUEUE_CI_WAIT_MINUTES } from "./policy.js";
import { MAIN_GUARD_PARK_LEASE_SECONDS } from "./mainGuard.js";
import type { RenumberAsk } from "./renumber.js";
import { PARKED_PHASE, readHostQueued, readOrderedStops, releaseToQueue, renewSlot, requeueOrderedStopped, stopEntry } from "./store.js";
import type { MergeQueueEntry } from "./types.js";

/**
 * D#519 MQ5-a: the ordered-resource check inside the tick. It runs for the entry that holds the slot, after the refresh step has ended on a head and before the CI wait,
 * from reads made now: the repository's `settings`, the default branch's tip (its tree) and the files the pull request adds. Nothing is stored as "ordered".
 *
 *  - no resource applies (the configuration lists none, or the detected default finds none): the check is skipped.
 *  - out of order: the entry stops with `ordered_resource_out_of_order` and gives the slot back. The `stopped` fact carries codes only: `resource_<name>`, `key_<key>`,
 *    `highest_<key>`, `branch_<name>`, which is all the sentence "{resource} {key} must come after {branch}'s latest ({mainKey})." is filled from.
 *  - unknown (a read failed, a tree was truncated, the pull request's file list reached GitHub's ceiling): not a stop and not a merge. The slot is parked for the next tick and a
 *    `merge_gate` fact `ordered_resource_unknown` is written (once per head). Past `MERGE_QUEUE_CI_WAIT_MINUTES` from the take the entry stops with `ordered_resource_unreadable`.
 *
 * A port without the two reads does no check (the older suites' fakes); production always has them.
 */

export interface OrderedDeps {
  github: Partial<OrderedResourceReaderPort>;
  inTenant<T>(accountId: string, fn: (client: PoolClient) => Promise<T>): Promise<T>;
  now?(): Date;
  /** MQ5-b1: starts a renumber round for the failed check; true when it handled the entry (see `createOnRenumber`). Absent or false: the entry stops, as MQ5-a left it. */
  onRenumber?(entry: MergeQueueEntry, holder: string, ask: RenumberAsk, headSha: string): Promise<boolean>;
}

/** `ordered_host_wait` (D#483 S5-j2a2, R-C35-3): the pull request adds an ordered file while another one of the repository waits in GitHub's queue, so the tip has not moved for it yet. */
export type OrderedOutcome = { outcome: "ordered_host_wait" } | { outcome: "ordered_renumbering" } | { outcome: "ordered_stopped" } | { outcome: "ordered_waiting" } | { outcome: "ordered_unreadable" };

export type Resolved = { state: "none" } | { state: "unknown" } | { state: "some"; resources: ResourceRule[]; branch: string; tip: readonly string[]; autoRenumber: boolean };

// `part` is the protocol module's `orderedCode`: the runner writes the same codes (D#483 S5-j2c2).

/** Which resources apply to the repository now, with the tip's paths. Anything unreadable is `unknown`. */
export async function resolveOrdered(deps: OrderedDeps, accountId: string, pr: PullRequestRef): Promise<Resolved> {
  const read = deps.github as OrderedResourceReaderPort;
  try {
    const row = await deps.inTenant(accountId, async (c) => (await c.query<{ settings: unknown }>("SELECT settings FROM repos WHERE id = $1", [pr.repoId])).rows[0]);
    if (!row) return { state: "unknown" };
    const config = readOrderedConfig(row.settings);
    if (config.configured && config.resources.length === 0) return { state: "none" };
    const tree = await read.listDefaultBranchPaths(pr);
    if (!tree.ok) return { state: "unknown" };
    const resources = config.configured ? config.resources : [detectResource(tree.paths)].filter((r): r is ResourceRule => r !== null);
    return resources.length === 0 ? { state: "none" } : { state: "some", resources, branch: tree.branch, tip: tree.paths, autoRenumber: config.autoRenumber };
  } catch (err) {
    reportError(err, { stage: "merge_queue.ordered_resources" });
    return { state: "unknown" };
  }
}

/** Entries stopped for ordering come back once the check no longer applies. Called at the start of a tick; reads GitHub only when there is such an entry. */
export async function clearOrderedStops(deps: OrderedDeps, input: { accountId: string; repoId: string }): Promise<void> {
  if (!deps.github.listDefaultBranchPaths) return;
  const stops = await deps.inTenant(input.accountId, (c) => readOrderedStops(c, input));
  if (stops.length === 0) return;
  if ((await resolveOrdered(deps, input.accountId, { repoId: input.repoId, prNumber: stops[0]!.prNumber })).state === "none") await deps.inTenant(input.accountId, (c) => requeueOrderedStopped(c, input));
}

export async function orderedStep(deps: OrderedDeps, args: { accountId: string; entry: MergeQueueEntry; holder: string; pr: PullRequestRef; headSha: string }): Promise<OrderedOutcome | null> {
  const { accountId, entry, holder, pr, headSha } = args;
  if (!deps.github.listDefaultBranchPaths || !deps.github.listPullRequestAdds) return null;
  const resolved = await resolveOrdered(deps, accountId, pr);
  if (resolved.state === "none") return null;
  let bad: { rule: ResourceRule; key: string; highest: string; files: string[] } | null = null;
  let hostWait = false;
  if (resolved.state === "some") {
    try {
      const adds = await deps.github.listPullRequestAdds(pr);
      if (adds.complete) {
        for (const rule of resolved.resources) {
          const v = checkOrdering(rule, adds.paths, resolved.tip);
          if (!v.ok) {
            bad = { rule, key: v.key, highest: v.highest, files: adds.paths.filter((p) => rule.matches(p)) };
            break;
          }
        }
        if (bad === null) {
          // Batching stays for a pull request that adds no numbered file. One that does waits while another is in GitHub's queue: that one has not moved the tip, and the same number would pass.
          if (resolved.resources.some((rule) => adds.paths.some((p) => rule.matches(p)))) {
            hostWait = (await deps.inTenant(accountId, (c) => readHostQueued(c, accountId, pr.repoId))).some((w) => w.prNumber !== entry.prNumber);
          }
          if (!hostWait) return null;
        }
      }
    } catch (err) {
      reportError(err, { stage: "merge_queue.ordered_files" });
    }
  }
  const event = (c: PoolClient, code: string, reasons: string[]): Promise<unknown> =>
    entry.workItemId === null ? Promise.resolve() : recordDriverEvent(c, accountId, { workItemId: entry.workItemId, kind: code === "ordered_resource_unknown" || code === "ordered_resource_waiting" ? "merge_gate" : "stopped", dedupeKey: `${headSha}:${code}`, code, reasons, headSha, prNumber: entry.prNumber });
  if (hostWait) {
    await deps.inTenant(accountId, async (c) => {
      await event(c, "ordered_resource_waiting", ["ordered_resource_waiting"]);
      await releaseToQueue(c, { accountId, entryId: entry.id, holder });
    });
    return { outcome: "ordered_host_wait" };
  }
  if (bad !== null && resolved.state === "some") {
    // MQ5-b1: a round, when one is allowed and the start is on; otherwise the stop below (MQ5-a's behaviour).
    if (deps.onRenumber && (await deps.onRenumber(entry, holder, { autoRenumber: resolved.autoRenumber, resource: bad.rule.name, files: bad.files, highest: bad.highest }, headSha))) return { outcome: "ordered_renumbering" };
    const reasons = [part("resource", bad.rule.name), part("key", bad.key), part("highest", bad.highest), part("branch", resolved.branch)];
    await deps.inTenant(accountId, async (c) => {
      await stopEntry(c, { accountId, entryId: entry.id, reason: "ordered_resource_out_of_order", holder });
      await event(c, "ordered_resource_out_of_order", reasons);
    });
    return { outcome: "ordered_stopped" };
  }
  const at = deps.now?.();
  const now = (at ?? new Date()).getTime();
  if (now - (entry.slotTakenAt?.getTime() ?? now) < MERGE_QUEUE_CI_WAIT_MINUTES * 60_000) {
    // Measured from the take, so the parked slot keeps its lease for the whole bound (the same unknown meets every entry); a lapse would start the wait again.
    await deps.inTenant(accountId, async (c) => {
      await event(c, "ordered_resource_unknown", []);
      await renewSlot(c, { accountId, entryId: entry.id, holder, phase: PARKED_PHASE, leaseSeconds: MAIN_GUARD_PARK_LEASE_SECONDS });
    });
    return { outcome: "ordered_waiting" };
  }
  await deps.inTenant(accountId, async (c) => {
    await stopEntry(c, { accountId, entryId: entry.id, reason: "ordered_resource_unreadable", holder });
    await event(c, "ordered_resource_unreadable", []);
  });
  return { outcome: "ordered_unreadable" };
}
