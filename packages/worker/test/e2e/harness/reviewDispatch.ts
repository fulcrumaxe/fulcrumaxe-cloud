import type { LocalGitHubHttp } from "../../../../pipeline/src/build/githubMergePort.js";
import { findPullRequestForItem, type OpenPullRequest } from "../../../../pipeline/src/review/githubReads.js";
import { buildReviewPrompt, type ReviewPromptRole } from "../../../../pipeline/src/review/reviewPrompts.js";
import { promptRuntimeOf } from "../../../../pipeline/src/advance/build.js";
import { loadReviewContext } from "../../../../pipeline/src/review/context.js";
import { recordRound } from "../../../../pipeline/src/review/roundDecision.js";
import type { AdvanceFacade, AdvanceReviewContext, AdvanceReviewDeps, AdvanceStepWho } from "../../../src/advance.js";

/**
 * D#6 R4d-6r (C35 section 3.5): the review half of the stage driver, as the end-to-end test drives it. Everything that decides something is the product's own function:
 * `advanceLoadReview` (the worker's), `findPullRequestForItem` (the pipeline's lookup of the run's recorded pull request through the local-only fence),
 * `buildReviewPrompt` with the repository's execution mode, and `advanceStartRun`, which writes the run row (with `head_sha`) and has the job issuer sign the job.
 *
 * What is copied, because apps/web cannot be imported from this package: the few lines of `startReviewerBody` that join those calls (apps/web/lib/advanceReviewSteps.ts),
 * and the `load` and `recordRound` wrappers of `createReviewDeps` (apps/web/lib/advanceReview.ts). The head sha comes from the pull request as GitHub answers for it and
 * from nowhere else; the test never types one.
 */
export function createHarnessReviewDeps(): AdvanceReviewDeps {
  return {
    async load(pool, accountId, workItemId) {
      const r = await loadReviewContext(pool, accountId, workItemId);
      if (!r.ok) return { ok: false, reason: r.reason };
      const c = r.ctx;
      return { ok: true, ctx: { workItemId: c.workItemId, stage: c.stage, repoId: c.repoId, owner: c.owner, name: c.name, issue: c.issue, tier: c.tier, specVersion: c.specVersion, debaterEnabled: false } };
    },
    recordRound: (pool, registry, input) => recordRound(pool, registry, { ...input, requiredRoles: input.requiredRoles as never, verdicts: input.verdicts as never }),
    resume: async () => {
      throw new Error("a fix round is not part of this harness");
    },
    mergeGate: async () => {
      throw new Error("the merge gate's GitHub half is not part of this harness: the test reads the gate's reviewer half directly");
    },
  };
}

export interface FoundPullRequest {
  ctx: AdvanceReviewContext;
  pr: OpenPullRequest;
}

/** The pull request the item's run recorded, found the way the driver finds it (`findPrBody`, minus the changed-files call that only feeds the security check). */
export async function findRecordedPr(module: AdvanceFacade, who: AdvanceStepWho, http: LocalGitHubHttp): Promise<FoundPullRequest> {
  const loaded = await module.advanceLoadReview(who);
  if (!loaded.ok) throw new Error(`review context: ${loaded.reason}`);
  const found = await findPullRequestForItem(http, { owner: loaded.ctx.owner, name: loaded.ctx.name, issue: loaded.ctx.issue, executionMode: loaded.ctx.executionMode, recordedPr: loaded.ctx.recordedPr });
  if (!found.ok) throw new Error(`pull request lookup: ${found.reason}`);
  return { ctx: loaded.ctx, pr: found.pr };
}

/** `startReviewerBody` for one role (apps/web/lib/advanceReviewSteps.ts): the prompt for the repository's mode, and the run started on the pull request's exact head. */
export async function startReviewer(module: AdvanceFacade, who: AdvanceStepWho, found: FoundPullRequest, role: ReviewPromptRole) {
  const spec = await module.advanceLoadSpecText(who, found.ctx.specVersion);
  if (spec === null) throw new Error("the approved Spec is gone");
  const { ctx, pr } = found;
  const prompt = buildReviewPrompt({ role, owner: ctx.owner, name: ctx.name, issue: ctx.issue, pr: pr.number, headSha: pr.headSha, baseRef: pr.baseRef, branch: pr.branch, version: spec.version, spec: spec.body, runtime: promptRuntimeOf(ctx.executionMode) });
  return module.advanceStartRun({ accountId: who.accountId, workItemId: who.workItemId, haltEpoch: who.haltEpoch, step: `review:${pr.headSha}:${role}`, role, prompt, clone: true, headSha: pr.headSha, expectedExecutionMode: ctx.executionMode });
}
