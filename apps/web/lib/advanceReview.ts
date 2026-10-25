import type { AdvanceReviewDeps } from "@fx/worker";
import { createCiGate, readPublicPullRequest, createPgLocalReviewOptIn, debaterEnabledFor, loadReviewContext, recordMergeOnlyRecheck, recordRound, resumeAgentRun, runMergeGateForItem, type GatheredVerdict, type GitHubHttp, type VerdictRole } from "@fx/pipeline";
import { openInstallationHttp } from "./github/installationHttp";
import { openForRepo } from "./github/localOnlyHttp";

/**
 * D#483 P3: the review stage's pipeline pieces, as the plain-data functions the worker's `review` dependency takes
 * (the worker package imports neither @fx/pipeline nor this app). Each wrapper only reshapes: the decisions are the
 * pipeline's.
 *
 *  - load: the review context as plain data, with the repo's debater setting folded into one boolean.
 *  - recordRound: every verdict of a head recorded, passes first (the worker has already checked the roles and verdict words).
 *    D#598 P7b: only once the head's CI and repo-wide guards have finished; until then it answers `ci_pending` and records nothing,
 *    for every repository alike (nothing here looks at whose repository it is).
 *  - resume: the pipeline's `resumeAgentRun` (same sandbox, same session).
 *  - mergeGate: the pipeline's merge gate over the real GitHub port, with a `merge_gate` token. A failure to read GitHub is
 *    an answer (`error`), not a throw, so the driver can record it and stop instead of retrying a step that cannot succeed.
 */
export function createReviewDeps(open: typeof openInstallationHttp = openInstallationHttp): AdvanceReviewDeps {
  // The merge gate's token purpose for one repository (the item's own, or the paired code repository its installation serves), fenced for a runner_local repo.
  const openReviewHttp = (c: { repoId: string; owner: string; name: string; executionMode: string }) => openForRepo(open, c.executionMode, "merge_gate", { repoId: c.repoId, owner: c.owner, name: c.name }) as Promise<GitHubHttp>;
  return {
    async load(pool, accountId, workItemId) {
      const r = await loadReviewContext(pool, accountId, workItemId);
      if (!r.ok) return { ok: false, reason: r.reason };
      const c = r.ctx;
      return { ok: true, ctx: { workItemId: c.workItemId, stage: c.stage, repoId: c.repoId, owner: c.owner, name: c.name, issue: c.issue, tier: c.tier, specVersion: c.specVersion, fixRoundsStarted: c.fixRoundsStarted, debaterEnabled: debaterEnabledFor(c.debaterMode, c.tier), personRequestPending: c.personRequestPending } };
    },
    recordRound: (pool, registry, input) =>
      recordRound(
        pool,
        registry,
        {
          accountId: input.accountId,
          workItemId: input.workItemId,
          headSha: input.headSha,
          prNumber: input.prNumber,
          ...(input.round !== undefined ? { round: input.round } : {}),
          requiredRoles: input.requiredRoles as VerdictRole[],
          verdicts: input.verdicts as GatheredVerdict[],
        },
        // D#598 P7b: the head's CI is read with the merge gate's token purpose (check runs, statuses, branch protection) and, for a runner_local repo, its fence.
        // Two planes: a paired item's CI is read on the public pull request that merges (`openPublicHttp` gets the code repository's coordinates).
        createCiGate({ pool, openHttp: openReviewHttp, openPublicHttp: openReviewHttp, publicPullRequest: readPublicPullRequest(pool) }),
      ),
    // D#598 P7c: a head that is only a merge of the base branch is re-checked from facts (GitHub's commit and compare reads, our own records), with no reviewer run.
    // The reads use the merge gate's token purpose, like the CI wait; the head's CI is waited for before anything is recorded.
    async recordMergeOnly(pool, input) {
      const loaded = await loadReviewContext(pool, input.accountId, input.workItemId);
      if (!loaded.ok) return { decision: "full_review", reason: loaded.reason };
      const c = loaded.ctx;
      const out = await recordMergeOnlyRecheck(
        pool,
        { accountId: input.accountId, workItemId: input.workItemId, headSha: input.headSha, prNumber: input.prNumber, baseRef: input.baseRef, requiredRoles: input.requiredRoles as VerdictRole[] },
        { http: await openReviewHttp({ repoId: c.repoId, owner: c.owner, name: c.name, executionMode: c.executionMode }), ci: createCiGate({ pool, openHttp: openReviewHttp, openPublicHttp: openReviewHttp, publicPullRequest: readPublicPullRequest(pool) }) },
      );
      return out.decision === "full_review" ? { decision: out.decision, reason: out.reason } : { decision: out.decision };
    },
    resume: (pool, registry, input) => resumeAgentRun(pool, registry, input),
    async mergeGate(pool, input) {
      const loaded = await loadReviewContext(pool, input.accountId, input.workItemId);
      if (!loaded.ok) return { outcome: "refused", reason: loaded.reason };
      const c = loaded.ctx;
      try {
        // D#6 R3c: a runner_local repo's gate (find, files, CI, protection, status, merge) goes through the local-only fence.
        const http = await openForRepo(open, c.executionMode, "merge_gate", { repoId: c.repoId, owner: c.owner, name: c.name });
        // D#6 R2b: the stored per-repo opt-in decides whether a runner repo's local reviews count; a repo with none is advisory.
        const out = await runMergeGateForItem({ pool, http, localReviewOptIn: createPgLocalReviewOptIn(pool) }, input);
        return out.outcome === "refused" ? { outcome: "refused", reason: out.reason } : { outcome: out.outcome, headSha: out.headSha, reasons: out.reasons, status: out.status };
      } catch (err) {
        const e = err as { name?: string; reason?: string };
        // fx-swallow-ok: a fixed code is returned and recorded; the error text can name a repository or carry GitHub's wording
        console.warn(JSON.stringify({ event: "advance.merge_gate_failed", work_item_id: input.workItemId, name: typeof e?.name === "string" ? e.name.slice(0, 60) : null, reason: typeof e?.reason === "string" ? e.reason.slice(0, 60) : null }));
        return { outcome: "error", reason: "github_unavailable" };
      }
    },
  };
}
