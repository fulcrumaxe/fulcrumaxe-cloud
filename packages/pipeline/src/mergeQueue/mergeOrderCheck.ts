import type { Pool, PoolClient } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { reportError } from "@fx/telemetry";
import type { ConflictReaderPort, DefaultBranchReaderPort, OrderedResourceReaderPort } from "../build/githubMergePort.js";
import type { MergeBlockReason, MergeGateDeps, MergeGateGitHubPort } from "../build/mergeGate.js";
import type { PullRequestRef } from "../build/types.js";
import type { GoAttestation } from "../review/mergeGateRun.js";
import { ORDERED_FACTS_CAPABILITY } from "@fulcrumaxe/runner-protocol";
import { resolveOrdered } from "./orderedCheck.js";
import { checkOrdering } from "./orderedResources.js";
import { readHostQueued } from "./store.js";

/**
 * D#483 S5-j2a2: the `mergeOrder` port of the merge gate. It answers reasons only and writes nothing; the gate takes the repository's lease first, so every read here is made
 * under it. It reuses `resolveOrdered` and `checkOrdering` (the queue's own functions) and does NOT call `orderedStep`, which stops entries and renews slots a direct item does not have.
 *
 * Hosted-readable item (an unpaired hosted repository, or a paired item whose code repository is hosted: the `github` it is given is the client that reads the repository that merges):
 *  - ordering: the tip's tree, the paths the pull request adds, `checkOrdering` per resource. Out of order: `ordered_resource_out_of_order`. A pull request that adds an ordered file while
 *    another one of the repository waits in GitHub's merge queue waits too (`merge_repo_busy`): that one has not moved the tip yet (R-C35-3).
 *  - overlap: when the head is behind the base, the files the tip gained since the merge base (a compare of the head to the tip) against the files the pull request changed.
 *    A shared path is `overlap_unreviewed`. A head the platform refreshed already holds the commit it merged in, and the merge base moves up to it, so a review of that
 *    merge is not counted again: only what the base gained after it can overlap. A disjoint change is a clean merge and no overlap.
 *  - any failed read, cut-short tree, file list at its ceiling, or compare list at its cap is `ordered_resource_unreadable`. Nothing is read as "in order" on a doubt.
 *
 * `runner_local` item: the cloud never reads the repository (the fence). Until the runner attests migration order (rows c1 to d), an item with another live item on its repository,
 * or one that saw another item of the repository reach `merged` after its own build started (that item's file is on a tip the cloud cannot read), is `runner_ordered_unsupported`.
 * The only item, and items built one after another, are waived. The reads are made under the lease.
 *
 * D#483 S5-j2c1: a runner that kept `ordered_facts_v1` attests the order itself (the go phase's `attestation`), and its word replaces that stop: an out-of-order fact, an overlap and an unknown are the same
 * reasons the cloud's own reads give, and a capable runner with no fact is unknown. It is a hint, never the control: the lease, the gate's other reasons and the runner's own tip re-read after the go
 * stand beside it. The order phase (no attestation yet) lets a PAIRED item through when the repository has a runner that can attest, and the go phase judges it (an unpaired item has no go phase and keeps the check below); a runner without the capability is judged as before.
 */

export type MergeOrderReads = Pick<MergeGateGitHubPort, "compareToBase"> & OrderedResourceReaderPort & DefaultBranchReaderPort & Pick<ConflictReaderPort, "compareCommits">;

/** The stages in which an item holds a build slot or an open pull request that can still reach a merge. `needs_human` holds no slot: the look-back below catches it if it merges. */
const LIVE_STAGES = ["in_progress", "pr_opened", "changes_requested", "review_passed"] as const;

/**
 * D#483 S5-j2c1 (R-C34-F1): whether a live runner of the account that covers the repository has a latest hello listing `ordered_facts_v1`. The capability, not a release, is the signal, so a runner built from
 * source counts. The order phase uses it to let an item through to the go; the repository's build limit follows it.
 */
export async function repoRunnerCanAttestOrder(client: Pick<PoolClient, "query">, accountId: string, repoId: string): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM runners rn JOIN runner_capabilities cap ON cap.account_id = rn.account_id AND cap.runner_id = rn.id
      WHERE rn.account_id = $1 AND rn.revoked_at IS NULL AND $2::uuid = ANY(rn.allowed_repo_ids) AND $3::text = ANY(cap.capabilities) LIMIT 1`,
    [accountId, repoId, ORDERED_FACTS_CAPABILITY],
  );
  return rows.length > 0;
}

/** The reasons a runner's ordering fact gives. A missing fact from a capable runner, and an `unknown` one, are unreadable: nothing is read as in order on a doubt. */
function factReasons(fact: GoAttestation["ordered"]): MergeBlockReason[] {
  if (fact === undefined || fact.verdict === "unknown") return ["ordered_resource_unreadable"];
  const reasons: MergeBlockReason[] = [];
  if (fact.verdict === "out_of_order") reasons.push("ordered_resource_out_of_order");
  if (fact.overlap) reasons.push("overlap_unreviewed");
  return reasons;
}

export function createMergeOrder(deps: { pool: Pool; github: MergeOrderReads; runnerLocal: boolean; paired?: boolean | undefined; attestation?: GoAttestation | undefined }): { mergeOrder: NonNullable<MergeGateDeps["mergeOrder"]>; addsOrderedFile: NonNullable<MergeGateDeps["addsOrderedFile"]> } {
  const { pool, github } = deps;
  const inTenant = <T>(id: string, fn: (c: PoolClient) => Promise<T>): Promise<T> => withTenant(pool, id, fn);
  /** Whether the pull request adds a file of an ordered resource, and the resolved resources. Unknown is its own answer. */
  const orderedAdds = async (accountId: string, pr: PullRequestRef): Promise<{ state: "none" } | { state: "unknown" } | { state: "some"; adds: readonly string[]; addsOrdered: boolean; resources: Extract<Awaited<ReturnType<typeof resolveOrdered>>, { state: "some" }> }> => {
    const resolved = await resolveOrdered({ github, inTenant }, accountId, pr);
    if (resolved.state !== "some") return { state: resolved.state };
    const adds = await github.listPullRequestAdds(pr);
    if (!adds.complete) return { state: "unknown" };
    return { state: "some", adds: adds.paths, addsOrdered: adds.paths.some((p) => resolved.resources.some((r) => r.matches(p))), resources: resolved };
  };
  const mergeOrder: NonNullable<MergeGateDeps["mergeOrder"]> = async ({ accountId, workItemId, pr, headSha }) => {
    if (deps.runnerLocal) {
      const attested = deps.attestation;
      if (attested?.orderedCapable === true) {
        const reasons = factReasons(attested.ordered);
        // A pull request that adds an ordered file while another one of the repository waits in GitHub's queue waits too (R-C35-3): that one has not moved the tip yet.
        if (reasons.length === 0 && attested.ordered?.verdict === "ok" && (await inTenant(accountId, (c) => readHostQueued(c, accountId, pr.repoId))).length > 0) return ["merge_repo_busy"];
        return reasons;
      }
      if (attested === undefined && deps.paired === true) {
        // The order phase of a paired item: nothing is attested yet. A repository with a runner that can attest is judged at the go, which only a paired item has;
        // an unpaired item is merged by this gate with no go phase after it, so it keeps the conservative check below whatever its runner lists.
        if (await inTenant(accountId, (c) => repoRunnerCanAttestOrder(c, accountId, pr.repoId))) return [];
      }
      const { rows } = await inTenant(accountId, (c) =>
        c.query(
          `SELECT EXISTS (SELECT 1 FROM work_items o WHERE o.account_id = $1 AND o.repo_id = $2 AND o.id <> $3 AND o.stage = ANY($4::text[])) AS live,
                  EXISTS (SELECT 1 FROM work_items o JOIN work_item_transitions m ON m.account_id = o.account_id AND m.work_item_id = o.id AND m.to_stage = 'merged'
                           WHERE o.account_id = $1 AND o.repo_id = $2 AND o.id <> $3
                             AND m.at > COALESCE((SELECT min(t.at) FROM work_item_transitions t WHERE t.account_id = $1 AND t.work_item_id = $3 AND t.to_stage = 'in_progress'), '-infinity'::timestamptz)) AS merged_since`,
          [accountId, pr.repoId, workItemId, LIVE_STAGES],
        ),
      );
      return rows[0]?.live === false && rows[0]?.merged_since === false ? [] : ["runner_ordered_unsupported"];
    }
    const ordering = async (): Promise<MergeBlockReason[]> => {
      const found = await orderedAdds(accountId, pr);
      if (found.state === "none") return [];
      if (found.state === "unknown") return ["ordered_resource_unreadable"];
      if (found.resources.resources.some((rule) => !checkOrdering(rule, found.adds, found.resources.tip).ok)) return ["ordered_resource_out_of_order"];
      // A pull request waiting in GitHub's queue has not moved the tip: the same number would pass here too. This one waits until it settles.
      if (found.addsOrdered) {
        const waiting = await inTenant(accountId, (c) => readHostQueued(c, accountId, pr.repoId));
        if (waiting.length > 0) return ["merge_repo_busy"];
      }
      return [];
    };
    const overlap = async (): Promise<MergeBlockReason[]> => {
      const own = await github.compareToBase(pr, headSha, { files: true });
      if (own.behindBy === 0) return [];
      if (own.files === null) return ["ordered_resource_unreadable"];
      const gained = await github.compareCommits(pr, headSha, (await github.getDefaultBranchTip(pr)).sha, { files: true });
      if (gained.files === null) return ["ordered_resource_unreadable"];
      const mine = new Set(own.files);
      return gained.files.some((f) => mine.has(f)) ? ["overlap_unreviewed"] : [];
    };
    const reasons = new Set<MergeBlockReason>();
    for (const part of [ordering, overlap]) {
      try {
        for (const r of await part()) reasons.add(r);
      } catch (err) {
        reportError(err, { stage: "merge_gate.merge_order" });
        reasons.add("ordered_resource_unreadable");
      }
    }
    return [...reasons];
  };
  const addsOrderedFile: NonNullable<MergeGateDeps["addsOrderedFile"]> = async ({ accountId, pr }) => {
    if (deps.runnerLocal) return true;
    const found = await orderedAdds(accountId, pr);
    return found.state === "none" ? false : found.state === "unknown" ? true : found.addsOrdered;
  };
  return { mergeOrder, addsOrderedFile };
}
