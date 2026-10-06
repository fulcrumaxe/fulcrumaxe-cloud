import type { AdvanceReviewDeps } from "@fx/worker";
import { createPgLocalReviewOptIn, debaterEnabledFor, loadReviewContext, recordRound, resumeAgentRun, runMergeGateForItem, type GatheredVerdict, type VerdictRole } from "@fx/pipeline";
import { openInstallationHttp } from "./github/installationHttp";

/**
 * D#483 P3: the review stage's pipeline pieces, as the plain-data functions the worker's `review` dependency takes
 * (the worker package imports neither @fx/pipeline nor this app). Each wrapper only reshapes: the decisions are the
 * pipeline's.
 *
 *  - load: the review context as plain data, with the repo's debater setting folded into one boolean.
 *  - recordRound: every verdict of a head recorded, passes first (the worker has already checked the roles and verdict words).
 *  - resume: the pipeline's `resumeAgentRun` (same sandbox, same session).
 *  - mergeGate: the pipeline's merge gate over the real GitHub port, with a `merge_gate` token. A failure to read GitHub is
 *    an answer (`error`), not a throw, so the driver can record it and stop instead of retrying a step that cannot succeed.
 */
export function createReviewDeps(open: typeof openInstallationHttp = openInstallationHttp): AdvanceReviewDeps {
  return {
    async load(pool, accountId, workItemId) {
      const r = await loadReviewContext(pool, accountId, workItemId);
      if (!r.ok) return { ok: false, reason: r.reason };
      const c = r.ctx;
      return { ok: true, ctx: { workItemId: c.workItemId, stage: c.stage, repoId: c.repoId, owner: c.owner, name: c.name, issue: c.issue, tier: c.tier, specVersion: c.specVersion, debaterEnabled: debaterEnabledFor(c.debaterMode, c.tier) } };
    },
    recordRound: (pool, registry, input) =>
      recordRound(pool, registry, {
        accountId: input.accountId,
        workItemId: input.workItemId,
        headSha: input.headSha,
        prNumber: input.prNumber,
        ...(input.round !== undefined ? { round: input.round } : {}),
        requiredRoles: input.requiredRoles as VerdictRole[],
        verdicts: input.verdicts as GatheredVerdict[],
      }),
    resume: (pool, registry, input) => resumeAgentRun(pool, registry, input),
    async mergeGate(pool, input) {
      const loaded = await loadReviewContext(pool, input.accountId, input.workItemId);
      if (!loaded.ok) return { outcome: "refused", reason: loaded.reason };
      const c = loaded.ctx;
      try {
        const http = await open("merge_gate", { repoId: c.repoId, owner: c.owner, name: c.name });
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
