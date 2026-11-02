import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { assembleConflictPrompt, isReservationPause, mergeQueue, promptRuntimeOf, startWaitFor } from "@fx/pipeline";
import { readEntryContext, type DeltaReviewBinding } from "./mergeQueueDeltaReview";

/**
 * D#519 MQ4-b: binds the merge queue's `onConflict` to the real conflict round. Everything about the item (who approved it, its halt epoch, its review
 * context, the pull request) is read from the stored rows and from GitHub by the same lookup the delta review uses; the queue's caller passes none of
 * it. The round is the worker's `conflict` fix round: it resumes the build's session (or queues for the runner), merges nothing itself, and moves no stage.
 */
export interface ConflictBinding extends DeltaReviewBinding {
  github: mergeQueue.ConflictPorts["github"] & DeltaReviewBinding["github"];
  tryMechanicalReplay?: mergeQueue.ConflictPorts["tryMechanicalReplay"];
}

export function conflictPorts(deps: ConflictBinding): mergeQueue.ConflictPorts {
  return {
    github: deps.github,
    inTenant: (accountId, fn) => withTenant(deps.pool, accountId, fn),
    // D#519 C10: the one module-level source of the push-record proof: unread (no round starts) until its production binding is set.
    platformCommits: async (entry, shas) => (await mergeQueue.readPlatformCommitProof()?.(entry, shas)) ?? null,
    ...(deps.tryMechanicalReplay ? { tryMechanicalReplay: deps.tryMechanicalReplay } : {}),
    async startConflictRound({ entry, round }) {
      const l = await readEntryContext(deps, entry);
      if (!("who" in l)) return { ok: false, reason: l.reason };
      const runtime = promptRuntimeOf(l.ctx.executionMode);
      let prompt;
      try {
        prompt = assembleConflictPrompt({
          owner: l.ctx.owner,
          name: l.ctx.name,
          issue: l.ctx.issue,
          pr: l.pr.number,
          headSha: round.fromSha,
          branch: l.pr.branch,
          baseRef: round.baseRef,
          baseSha: round.baseSha,
          files: round.conflictFiles,
          round: round.round,
          of: mergeQueue.MAX_CONFLICT_ROUNDS,
          runtime,
        });
      } catch {
        // fx-swallow-ok: a value the prompt refuses is a closed refusal; the error text can name a path
        return { ok: false, reason: "invalid_input" };
      }
      const started = await deps.worker!.advanceStartFix(l.who, {
        kind: "conflict",
        issue: l.ctx.issue,
        headSha: round.fromSha,
        prompt: prompt.prompt,
        contextSections: prompt.sections,
        round: round.round,
        actionId: l.actionId,
        expectedExecutionMode: l.ctx.executionMode,
        pr: { number: l.pr.number, branch: l.pr.branch },
      });
      if (started.ok) return { ok: true, runId: started.runId };
      // A spending-limit pause is a refused spend (the entry stops, nothing is retried); a wait for capacity keeps its own answer.
      const capacity = started.reason === "waiting_for_capacity";
      const spend = isReservationPause(started.reason) || started.reason === "refused_spend" || (!capacity && startWaitFor(started.reason) !== null);
      return { ok: false, reason: capacity ? "waiting_for_capacity" : spend ? "refused_spend" : (started.reason ?? "invalid_input") };
    },
  };
}

/** The tick's `onConflict`, bound. */
export function bindOnConflict(deps: ConflictBinding): NonNullable<mergeQueue.QueueTickDeps["onConflict"]> {
  return mergeQueue.createOnConflict(conflictPorts(deps));
}
