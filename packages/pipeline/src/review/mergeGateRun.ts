import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { enqueueDedupeKey, listHeadRemovals, recordDriverEvent, toCode } from "@fx/core/src/work-items/driverEvents.js";
import { PERSON_REQUEUE_REASON, queueAgainPending } from "@fx/core/src/work-items/queueIntent.js";
import { readStackParentPull } from "@fx/core/src/work-items/stackParentPull.js";
import { humanMergeOnly } from "@fx/db/src/humanMergeOnly.js";
import { autoMergeAllowed } from "@fx/trust";
import { readRecordedRunnerPullRequest } from "@fx/runner";
import { createGitHubMergeGatePort, isLocalGitHubHttp, type GitHubHttp, type LocalGitHubHttp, type MergeQueueDocuments } from "../build/githubMergePort.js";
import { carriedRunsHead, gateReviewerReasons, loadRunsOnSha, runMergeGate, RUNNER_ADMIN_OK_SQL, SHA_PATTERN, type MergeBlockReason, type ReviewMode } from "../build/mergeGate.js";
import { listChangedFiles, listChangedFilesLocal, postReviewStatus, type ListFilesResult } from "./githubReads.js";
import type { ChangedFile } from "./securityTrigger.js";
import { checkPublicContent, type ContentCheck } from "./publicContentMatch.js";
import { loadReviewContext, type ReviewContext } from "./context.js";
import type { PublicPullRequest, PublicPullRequestLookup } from "./publicPullRequest.js";
import { reviewPlanFor } from "./reviewPlan.js";
import { securityTriggers } from "./securityTrigger.js";

/**
 * D#483 P3: the merge gate for one work item whose reviewers have passed, with the real GitHub port.
 *
 * In order:
 *  1. Read the pull request's head (the gate's own port does, and it is the head every later step binds to).
 *  2. Work out who is required on THAT head: the same `reviewPlanFor` the driver used, with the diff check re-run on the
 *     head's files and the code reviewer's security flag read from its recorded run on that head.
 *  3. Owner ruling B: when every required reviewer passed on that head BY OUR RECORDS (the same `reviewerReasons` the gate
 *     applies, vetoes included), post the commit status `fulcrumaxe/review` = success on it. That is the CI signal for a
 *     repository without CI; a repository with CI must pass its own checks too, because the gate still requires every
 *     check and status on the commit to be green.
 *  4. `runMergeGate`, with `autoMergeAllowed` from `@fx/trust` over the repository's guard settings as written. Nothing
 *     here decides to merge: the gate merges (with GitHub's `sha` parameter) or marks the PR for a person.
 *  5. Record the outcome as driver events (the gate's outcome code and its block reasons; whether the status was
 *     posted; that the gate itself merged).
 *
 * D#6 R3b (C12 section 1): for a `runner_local` repo the reviewers ran on the customer's machine. When the repo's admin has turned
 * on auto-merge for runner reviews (`LocalReviewOptInPort`, stored in repo_local_review_optins by migration 0733 and read by `createPgLocalReviewOptIn`; off with no stored opt-in, and off on any failure to read it),
 * a trusted runner's verdict counts, the repo's own CI and branch protection are required (see build/mergeGate.ts), and the
 * status description says "Local review". With it off, the gate never merges such a repo.
 *
 * Failure: a GitHub read that fails throws (the step's own retry), never "merge anyway". The status post is best
 * effort: if it fails the gate still runs and, for a repository with no other CI, says `ci_not_green`; the failure is
 * recorded.
 */

/**
 * D#6 R3b, safeguard (a): whether an owner or admin of the repo's account turned on auto-merge for runner reviews on this one
 * repo. R2b adds the stored setting (0733) and the real port (`createPgLocalReviewOptIn`); a caller that passes none gets off.
 * A throw is off too.
 */
export interface LocalReviewOptInPort {
  enabled(input: { accountId: string; repoId: string }): Promise<boolean>;
}
export const localReviewOptInOff: LocalReviewOptInPort = { enabled: async () => false };

export interface MergeGateRunInput {
  accountId: string;
  workItemId: string;
  prNumber: number;
  /**
   * The GO phase of a paired `runner_local` item's merge order: the whole gate again from fresh reads, with the content attested by the runner for the fixed
   * shas. The security trigger and the tier come from `attestation.paths`; `same: false` adds `public_head_not_reviewed`; the live public head must be the
   * attested one and the live private head the attested reviewed head (else `head_moved`). No `fulcrumaxe/review` status is posted and none is read as authority.
   */
  goPhase?: { attestation: GoAttestation };
  /** D#519 MQ3-b: the signals that were green on the reviewed head, for a head the queue refreshed (see `missingExpectedSignals`). */
  expectedSignals?: readonly string[];
  /**
   * D#519 MQ3-b: the head the caller checked CI on. The gate stops with `head_moved` if the pull request's head is any other commit when
   * it reads it, so a push (or a force-push back to an older head) after the caller's check can never be merged on that check. A paired
   * item's own binding (below) takes precedence.
   */
  expectedHeadSha?: string;
}

export type StatusOutcome = "posted" | "skipped" | "failed";

type MergeGateRunOutcome = "merged" | "merge_delegated" | "merge_enqueued" | "ready_human_merges" | "pr_not_open" | "head_moved";
export type MergeGateRunResult = { outcome: "refused"; reason: string } | { outcome: MergeGateRunOutcome; headSha: string; reasons: MergeBlockReason[]; status: StatusOutcome };
/** The go phase's answer: a `runner_local` repository is never put in GitHub's merge queue (D#694 B5 is the hosted path only), so `merge_enqueued` cannot come back. */
export type MergeGateGoResult = { outcome: "refused"; reason: string } | { outcome: Exclude<MergeGateRunOutcome, "merge_enqueued">; headSha: string; reasons: MergeBlockReason[]; status: StatusOutcome };

/**
 * Two planes, `runner_local`: what the customer's runner attests about the CONTENT of the two commits (fixed shas; the runner has the git objects, the cloud
 * must not). `paths` is the public change set, `incomplete` means the runner could not know (it implies `same` false). The go phase uses nothing else about
 * content: its security trigger and tier rest on these paths, never on a live file list.
 */
export interface GoAttestation {
  reviewedHead: string;
  publicHead: string;
  same: boolean;
  incomplete: boolean;
  paths: readonly string[];
}

/**
 * The hand-over of a paired `runner_local` item's merge, called by the gate's single merge call site once every condition is met. The ORDER phase places a
 * merge order; the GO phase authorizes the single write credential. Either answers `delegated: true`, or `delegated: false` with the reason a person sees.
 * Nothing here merges, and the gate never learns what the credential is.
 */
export type MergeDelegate = (args: { accountId: string; workItemId: string; sha: string; reviewedHead: string }) => Promise<{ delegated: true } | { delegated: false; reason: MergeBlockReason }>;

/** The pull request the item's runner run recorded with its `done` (its number and run branch), or null: the item's OWN pull request, which the reviewers judged. */
export async function readItemRecordedPullRequest(pool: Pool, accountId: string, workItemId: string): Promise<{ number: number; branch: string } | null> {
  const recorded = await withTenant(pool, accountId, (client) => readRecordedRunnerPullRequest(client, { accountId, workItemId }));
  return recorded === null ? null : { number: recorded.number, branch: recorded.branch };
}

/** Whether this head's code-reviewer run set the security flag: a succeeded production run whose envelope says `security_review_needed` is exactly true. */
export async function reviewerFlaggedSecurity(pool: Pool, accountId: string, workItemId: string, headSha: string, localOn: boolean): Promise<boolean> {
  return withTenant(pool, accountId, async (client) => {
    // D#598 P7c: a head carried forward by a merge-only re-check keeps the flag its reviewed head's code reviewer set.
    const carried = await carriedRunsHead(client, accountId, workItemId, headSha);
    // Amended for runner_local repos with local review on (D#6 C12): a trusted runner's run counts here exactly as it does in the gate.
    const { rows } = await client.query<{ flagged: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM agent_runs ar
          WHERE ar.account_id = $1 AND ar.work_item_id = $2 AND ar.head_sha = ANY($3::text[]) AND ar.role = 'code-reviewer'
            AND ar.status = 'succeeded' AND (ar.runtime = 'production' OR ($4::boolean AND ${RUNNER_ADMIN_OK_SQL}))
            AND (ar.envelope -> 'security_review_needed') = 'true'::jsonb
       ) AS flagged`,
      [accountId, workItemId, carried === null ? [headSha] : [headSha, carried], localOn],
    );
    return rows[0]?.flagged === true;
  });
}

/**
 * The GitHub port the review stage reads through, for one item's pull request: the merge gate's port, over the injected transport. For a
 * `runner_local` repo it is built on the local-only client and the run's recorded branch (D#6 R3c), and a transport that is not the local-only
 * one is refused before a call. The merge gate and the CI wait (ciWait.ts) both use it, so they read the same way.
 */
export function createReviewGitHubPort(deps: { pool: Pool; http: GitHubHttp; queueDocuments?: MergeQueueDocuments }, ctx: ReviewContext, ids: MergeGateRunInput & { recordedBranch?: string }) {
  const { pool, http } = deps;
  const { accountId, workItemId, prNumber } = ids;
  const localHttp = ctx.executionMode === "runner_local" ? http : null;
  if (localHttp !== null && !isLocalGitHubHttp(localHttp)) throw new Error("merge gate: a runner_local repo needs the local-only GitHub client");
  return createGitHubMergeGatePort({
    http,
    ...(deps.queueDocuments !== undefined ? { queueDocuments: deps.queueDocuments } : {}),
    ...(localHttp !== null && isLocalGitHubHttp(localHttp)
      ? {
          local: {
            http: localHttp,
            // The branch the run recorded with its `done`. The pull request the workflow found must be that one.
            recordedBranch: async () => {
              // A paired item's PUBLIC pull request: its branch is the one our own push record names (`plane_pushes.branch`), not a run's.
              if (ids.recordedBranch !== undefined) return ids.recordedBranch;
              const recorded = await withTenant(pool, accountId, (client) => readRecordedRunnerPullRequest(client, { accountId, workItemId }));
              if (recorded === null || recorded.number !== prNumber) throw new Error("merge gate: the pull request is not the run's recorded one");
              return recorded.branch;
            },
          },
        }
      : {}),
    resolveRepo: async () => ({ owner: ctx.owner, name: ctx.name }),
    // The block reasons are recorded as a driver event below, right after the gate answers: that is the marking.
    markReadyForHumanMerge: async () => undefined,
    mergeMethod: "squash",
  });
}

/**
 * Two planes. A paired item has a private pull request (the run branch's copy, which the reviewers judged) and a public one on the code repository (the
 * one that can merge: private main only moves by sync commits). When `publicPlane` is given and the item has an open public pull request (its `read`), the gate reads and merges THAT pull request at its live head: its CI and required contexts, its changed files (for the
 * security and tier decisions), the review status and the merge. Reviewer records stay bound to the private head the reviewers judged, because that
 * is the commit they saw; the two heads are different commits by construction. What binds the public head to the platform's own push is its stamp
 * (`plane_pushes.head_sha`): a live head that is not the stamped one (and no person took the branch over) adds `public_head_unrecorded`, so nothing
 * merges. The auto-merge opt-in, the operator's human-merge lock and every ruleset refusal apply unchanged, and a refused merge stays a human merge.
 * The private copy is not merged here. A paired item whose public pull request is not open (not opened yet, closed, merged) stops with `public_pr_not_open`:
 * the private copy never merges in its place, in either runtime.
 *
 * A `runner_local` repo is judged the same way, on the public pull request, but through the local-only fence (paths and states, never contents), and the
 * cloud never merges it: the fence for the code repository leaves out the merge call, and the gate stops with `runner_merge_unavailable` when every other
 * condition is met. What the fence cannot read (the trees that prove the public head holds what was reviewed) is not checked here; the changed paths of both
 * pull requests stand in for the security trigger and the tier, and a person merges.
 */
export type OpenPublicHttp = (ctx: { repoId: string; owner: string; name: string; executionMode: string }) => Promise<GitHubHttp>;

export interface PublicPlanePort {
  open: OpenPublicHttp;
  /** Finds the item's public pull request (`readPublicPullRequest(pool)`); injected so this file names no repository or plane. */
  read: PublicPullRequestLookup;
}

export type MergeGateRunDeps = { pool: Pool; http: GitHubHttp; localReviewOptIn?: LocalReviewOptInPort; publicPlane?: PublicPlanePort; mergeDelegate?: MergeDelegate; queueDocuments?: MergeQueueDocuments };

export function runMergeGateForItem(deps: MergeGateRunDeps, input: MergeGateRunInput & { goPhase: { attestation: GoAttestation } }): Promise<MergeGateGoResult>;
export function runMergeGateForItem(deps: MergeGateRunDeps, input: MergeGateRunInput): Promise<MergeGateRunResult>;
export async function runMergeGateForItem(deps: MergeGateRunDeps, input: MergeGateRunInput): Promise<MergeGateRunResult> {
  const { pool, http } = deps;
  const { accountId, workItemId, prNumber } = input;
  const loaded = await loadReviewContext(pool, accountId, workItemId);
  if (!loaded.ok) return { outcome: "refused", reason: loaded.reason };
  const ctx = loaded.ctx;
  // D#6 R3b: how this repo's reviews are judged. Only a runner_local repo with the admin's opt-in on is "on"; a failed read is off.
  let reviewMode: ReviewMode = "cloud";
  if (ctx.executionMode === "runner_local") {
    const optedIn = await (deps.localReviewOptIn ?? localReviewOptInOff).enabled({ accountId, repoId: ctx.repoId }).then((v) => v === true, () => false);
    reviewMode = optedIn ? "runner_local_on" : "runner_local_off";
  }
  const debaterEnabled = ctx.debaterMode === "always" || ctx.debaterMode === "feature_critical";

  const pr = { repoId: ctx.repoId, prNumber };
  // D#6 R3c: a runner_local repo's whole review and merge path goes through the local-only client. Anything else refuses before a call.
  const runnerLocal = ctx.executionMode === "runner_local";
  const localHttp = runnerLocal ? http : null;
  const port = createReviewGitHubPort({ pool, http, ...(deps.queueDocuments !== undefined ? { queueDocuments: deps.queueDocuments } : {}) }, ctx, { accountId, workItemId, prNumber });

  // 1. The head the reviewers judged (the item's own pull request), and, for a paired item, the public pull request that merges.
  const head = await port.getPullRequest(pr);
  const headSha = head.headSha;
  const go = input.goPhase;
  if (go !== undefined) {
    // The go phase only exists for a paired runner_local item, and only for the private head the order was placed for.
    if (!runnerLocal || deps.publicPlane === undefined || deps.mergeDelegate === undefined) return { outcome: "refused", reason: "go_not_applicable" };
    if (headSha !== go.attestation.reviewedHead) return { outcome: "head_moved", headSha, reasons: [], status: "skipped" };
  }
  const lookup = deps.publicPlane !== undefined ? await deps.publicPlane.read(accountId, workItemId) : null;
  const publicPr: PublicPullRequest | null = lookup?.pr ?? null;
  // Paired: the repository has a pairing, whether or not its public pull request is open.
  const paired = lookup !== null;
  let mergeHttp = http;
  let mergeTarget = { owner: ctx.owner, name: ctx.name, prNumber };
  let mergePort = port;
  let mergeRef = pr;
  let mergeHead = headSha;
  let mergeOpen = head.state === "open" && !head.merged;
  let mergeBaseRef = head.baseRef;
  const extraBlockReasons: MergeBlockReason[] = [];
  let humanLocked = humanMergeOnly(ctx.ghRepoId);
  // A paired item merges its public pull request or nothing: the private copy is never the fallback.
  if (paired && publicPr === null) extraBlockReasons.push("public_pr_not_open");
  if (publicPr !== null && deps.publicPlane !== undefined) {
    mergeHttp = await deps.publicPlane.open({ repoId: ctx.repoId, owner: publicPr.owner, name: publicPr.name, executionMode: ctx.executionMode });
    mergeTarget = { owner: publicPr.owner, name: publicPr.name, prNumber: publicPr.number };
    mergePort = createReviewGitHubPort({ pool, http: mergeHttp, ...(deps.queueDocuments !== undefined ? { queueDocuments: deps.queueDocuments } : {}) }, { ...ctx, owner: publicPr.owner, name: publicPr.name }, { accountId, workItemId, prNumber: publicPr.number, recordedBranch: publicPr.branch });
    // The operator's lock names a repository by its GitHub id: either half of the pairing listed means a person merges.
    if (!humanLocked) humanLocked = humanMergeOnly(await readRepoGhId(mergeHttp, publicPr.owner, publicPr.name));
    // Defence in depth for `runner_local`: the cloud never calls merge on this pull request, whatever client it was given. The gate's merge call site is the
    // delegate (an order, or the single write credential) when one is wired, and a refusal to merge otherwise.
    if (runnerLocal) {
      const delegate = deps.mergeDelegate;
      mergePort = {
        ...mergePort,
        mergePullRequest: async (_ref, { sha }) => {
          if (delegate === undefined) throw new Error("merge gate: the cloud does not merge a runner_local repository's pull request");
          const out = await delegate({ accountId, workItemId, sha, reviewedHead: headSha });
          return out.delegated ? { merged: false, delegated: true } : { merged: false, delegated: false, reason: out.reason };
        },
      };
    }
    mergeRef = { repoId: ctx.repoId, prNumber: publicPr.number };
    const live = await mergePort.getPullRequest(mergeRef);
    mergeHead = live.headSha;
    mergeOpen = live.state === "open" && !live.merged;
    mergeBaseRef = live.baseRef;
    // Every one of these is a stop: a person's branch is theirs to merge, and a head the platform did not push from the head the reviewers cleared is unproven.
    if (publicPr.managedByPerson) extraBlockReasons.push("public_branch_person_managed");
    else if (!SHA_PATTERN.test(mergeHead) || publicPr.stampedHead === null || publicPr.stampedHead !== mergeHead || publicPr.sourceHead === null) extraBlockReasons.push("public_head_unrecorded");
    else if (publicPr.sourceHead !== headSha) extraBlockReasons.push("public_head_not_reviewed");
  }
  let status: StatusOutcome = "skipped";
  let gateSecurityTrigger = false;

  // A paired item is judged on its public pull request: the private copy being closed or merged does not skip the file read below.
  const readable = publicPr !== null ? mergeOpen && SHA_PATTERN.test(mergeHead) && SHA_PATTERN.test(headSha) : head.state === "open" && !head.merged && SHA_PATTERN.test(headSha);
  // The changed files (security trigger, tier) are read for the public head checked here; the gate re-reads the pull request and stops if it moved.
  if (publicPr !== null && mergeOpen && !readable) extraBlockReasons.push("head_sha_malformed");
  if (readable) {
    // 2. Who is required on that head.
    // A paired item reads NO live file list: its changed files (for the security trigger and the tier) are the public change set at the bound commits, which the
    // content check below computes. When it could not (or a stop is already known), the list is incomplete, which fires the security trigger.
    let content: ContentCheck | null = null;
    // A runner_local repo is read through the paths-only fence: the trees and patches the content check needs are not reachable, and the cloud must not receive them.
    if (go !== undefined && !go.attestation.same && !extraBlockReasons.includes("public_head_not_reviewed")) extraBlockReasons.push("public_head_not_reviewed");
    if (publicPr !== null && !runnerLocal) {
      content = extraBlockReasons.length > 0
        ? { same: false, files: [], incomplete: false }
        : await checkPublicContent({
            privateHttp: http,
            privateRepo: { owner: ctx.owner, name: ctx.name },
            privateBaseRef: head.baseRef,
            reviewedHead: headSha,
            publicHttp: mergeHttp,
            publicRepo: { owner: mergeTarget.owner, name: mergeTarget.name },
            publicBaseRef: mergeBaseRef,
            publicHead: mergeHead,
            overlayGlobs: publicPr.overlayGlobs,
          });
      if (extraBlockReasons.length === 0 && !content.same) extraBlockReasons.push("public_head_not_reviewed");
    }
    // The go phase reads NO live list: the attested paths of the fixed shas stand (a file with no diff shown, as in every runner_local list, so the security
    // trigger fires exactly as it did when the order was placed).
    const files = go !== undefined
      ? ({ ok: true, files: go.attestation.paths.map((path): ChangedFile => ({ path, previousPath: null, patch: null, changes: 1 })), truncated: go.attestation.incomplete } as const)
      : content !== null
      ? ({ ok: true, files: content.files, truncated: content.incomplete } as const)
      : publicPr !== null && localHttp !== null && isLocalGitHubHttp(localHttp) && isLocalGitHubHttp(mergeHttp)
        ? extraBlockReasons.length > 0
          ? ({ ok: true, files: [], truncated: false } as const)
          : await provisionalLocalFiles(localHttp, mergeHttp, { owner: ctx.owner, name: ctx.name, pr: prNumber }, { owner: publicPr.owner, name: publicPr.name, pr: publicPr.number })
        : localHttp !== null && isLocalGitHubHttp(localHttp)
        ? await listChangedFilesLocal(localHttp, { owner: ctx.owner, name: ctx.name, pr: prNumber })
        : await listChangedFiles(http, { owner: ctx.owner, name: ctx.name, pr: prNumber });
    if (!files.ok) throw new Error(`merge gate: files ${files.reason}`);
    const plan = reviewPlanFor({
      tier: ctx.tier,
      securityDiffTriggerFired: securityTriggers({ files: files.files, truncated: files.truncated }).length > 0,
      reviewerFlaggedSecurity: await reviewerFlaggedSecurity(pool, accountId, workItemId, headSha, reviewMode === "runner_local_on"),
      debaterEnabled,
    });
    gateSecurityTrigger = plan.gateSecurityTrigger;
    // 3. Owner ruling B: only when the reviewers clear this head by our records.
    const rows = await loadRunsOnSha(pool, accountId, workItemId, headSha);
    // Never in `runner_local_off`: the opt-in is off, so the gate cannot merge on these reviews and our status must not say it can.
    // The status goes on the commit that merges (the public head for a paired item), and only on a head the platform pushed.
    // A paired item's public head is read once more right before the post: a status never goes on a head that moved after the checks above.
    const stillThere = publicPr === null || (await mergePort.getPullRequest(mergeRef)).headSha === mergeHead;
    // The go phase posts nothing: the status is the order phase's signal for a repository without CI, and never merge authority (the rows above decide).
    if (go === undefined && reviewMode !== "runner_local_off" && extraBlockReasons.length === 0 && stillThere && gateReviewerReasons(plan.roles, rows, reviewMode).length === 0) {
      const posted = await postReviewStatus(mergeHttp, { owner: mergeTarget.owner, name: mergeTarget.name, sha: mergeHead, local: reviewMode === "runner_local_on" });
      status = posted.ok ? "posted" : "failed";
    }
    if (go === undefined) {
      await withTenant(pool, accountId, (client) =>
        recordDriverEvent(client, accountId, { workItemId, kind: "review_status", dedupeKey: publicPr === null ? `status:${headSha}` : `status:${headSha}:${mergeHead}`, code: status, headSha, prNumber }),
      );
    }
  }

  // 4. The gate. It merges (bound to the head's sha) or marks the PR for a person.
  const out = await runMergeGate(
    {
      pool,
      github: mergePort,
      // @fx/trust's autoMergeAllowed over the repository's guard settings, exactly. Never wrapped in a try that could read as true.
      isAutoMergeAllowed: async () => autoMergeAllowed({ provenance: ctx.provenance }, { autoMerge: ctx.autoMerge, blockExternalAutoMerge: ctx.blockExternalAutoMerge }),
      // The driver reviews the head itself; nothing is dispatched from inside the gate.
      requestReviews: async () => undefined,
      // D#598 P3b: the parent's pull request number, for the sentence on a stacked stop. Our rows only; no GitHub call.
      stackParentPullNumber: async () => (await withTenant(pool, accountId, (client) => readStackParentPull(client, workItemId)))?.prNumber ?? null,
    },
    // D#6 M1G-a: read from the environment now, on this request. A malformed setting locks every repo; an unknown repo id
    // counts as locked while any id is listed.
    {
      accountId,
      workItemId,
      pr: mergeRef,
      // The go phase binds to the head the runner attested (the order's); the order phase to the head just read.
      ...(publicPr !== null ? { reviewedHeadSha: headSha, expectedHeadSha: go?.attestation.publicHead ?? mergeHead } : input.expectedHeadSha !== undefined ? { expectedHeadSha: input.expectedHeadSha } : {}),
      extraBlockReasons,
      ...(input.expectedSignals !== undefined ? { expectedSignals: input.expectedSignals } : {}),
      // A paired runner_local item is merged by its runner or a person, never by the cloud (the runner side is not built yet: a person).
      ...(paired && runnerLocal && deps.mergeDelegate === undefined ? { mergeUnavailableReason: "runner_merge_unavailable" as const } : {}),
      tier: ctx.tier,
      securityDiffTriggerFired: gateSecurityTrigger,
      debaterEnabled,
      reviewMode,
      humanMergeOnly: humanLocked,
    },
  );

  // 5. The outcome, as facts.
  const reasons = out.outcome === "ready_human_merges" ? out.reasons : [];
  const outHead = out.outcome === "head_moved" ? out.staleHeadSha : out.headSha;
  // The card's rows speak of the head the reviewers judged and the item's own pull request; a paired item's public head rides in the dedupe key.
  const headForRow = publicPr !== null ? (SHA_PATTERN.test(headSha) ? headSha : null) : SHA_PATTERN.test(outHead) ? outHead : null;
  const keyHead = publicPr !== null ? `${headForRow ?? "nohead"}:${SHA_PATTERN.test(outHead) ? outHead : "nopublic"}` : (headForRow ?? "nohead");
  await withTenant(pool, accountId, async (client) => {
    await recordDriverEvent(client, accountId, {
      workItemId,
      kind: "merge_gate",
      dedupeKey: `${keyHead}:${go !== undefined ? "go:" : ""}${out.outcome}`,
      code: toCode(out.outcome),
      reasons: reasons.map((r) => toCode(r)),
      headSha: headForRow,
      prNumber,
    });
    if (out.outcome === "merged") {
      await recordDriverEvent(client, accountId, { workItemId, kind: "merged_by_gate", dedupeKey: `merged:${out.headSha}`, headSha: headForRow, prNumber });
    }
    // D#694 B5: a pull request put in GitHub's queue is a one-time stamp of what was sent. `merged_by_gate` stays for the direct path only; the merge itself is the webhook's to record.
    if (out.outcome === "merge_enqueued") {
      await recordDriverEvent(client, accountId, {
        workItemId,
        kind: "merge_enqueued",
        // A head the queue took out and the gate put back is a new fact (the retry's), not the first one again.
        dedupeKey: enqueueDedupeKey(out.headSha, (await listHeadRemovals(client, accountId, workItemId, out.headSha, prNumber, { all: true })).length),
        code: out.via,
        // D#694 B6-5: an enqueue that answers a person's Queue again says so; the retry rule then counts only the removals after it.
        ...(headForRow !== null && (await queueAgainPending(client, accountId, workItemId, prNumber, headForRow)) ? { reasons: [PERSON_REQUEUE_REASON] } : {}),
        headSha: headForRow,
        prNumber,
        ...(out.entryId !== null ? { queueEntryId: out.entryId } : {}),
      });
    }
  });
  return { outcome: out.outcome, headSha: outHead, reasons, status };
}

/** The GitHub id of a repository (`GET /repos/{owner}/{repo}`, allowlisted as A2 for a runner_local repo). Null when the answer carries no usable id: the lock then counts it as listed. */
async function readRepoGhId(http: GitHubHttp, owner: string, name: string): Promise<number | null> {
  const res = await http.request({ method: "GET", path: `/repos/${owner}/${name}` });
  if (res.status !== 200) throw new Error(`merge gate: repository read answered ${res.status}`);
  const id = typeof res.body === "object" && res.body !== null ? (res.body as { id?: unknown }).id : undefined;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * The changed paths of a paired runner_local item's two pull requests (paths only, through the fence): the private one the reviewers judged and the public
 * one. They decide the security trigger and the tier, never a merge (the cloud does not merge this item). Either list cut short makes the whole list so.
 */
async function provisionalLocalFiles(priv: LocalGitHubHttp, pub: LocalGitHubHttp, a: { owner: string; name: string; pr: number }, b: { owner: string; name: string; pr: number }): Promise<ListFilesResult> {
  const first = await listChangedFilesLocal(priv, a);
  if (!first.ok) return first;
  const second = await listChangedFilesLocal(pub, b);
  if (!second.ok) return second;
  const seen = new Set(first.files.map((f) => f.path));
  return { ok: true, files: [...first.files, ...second.files.filter((f) => !seen.has(f.path))], truncated: first.truncated || second.truncated };
}
