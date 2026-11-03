import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { assembleRenumberPrompt, isReservationPause, mergeQueue, promptRuntimeOf, startWaitFor } from "@fx/pipeline";
import { readEntryContext } from "./mergeQueueDeltaReview";
import type { ConflictBinding } from "./mergeQueueConflict";

/**
 * D#519 MQ5-b1: the renumber round's start ports. The same context lookup, proof and run start as the conflict round; the prompt is the renumber one and the worker
 * round is `renumber` (no base sync, no merge). The start is on (`mergeQueue.RENUMBER_START_ENABLED`, turned on by MQ5-b2).
 */
export function renumberPorts<S extends mergeQueue.RoundSubject = mergeQueue.MergeQueueEntry>(deps: ConflictBinding): mergeQueue.RenumberPorts<S> {
  return {
    github: deps.github,
    inTenant: (accountId, fn) => withTenant(deps.pool, accountId, fn),
    platformCommits: async (entry, shas) => (await mergeQueue.readPlatformCommitProof()?.(entry, shas)) ?? null,
    async startRenumberRound({ entry, round, resource, highest }) {
      const l = await readEntryContext(deps, entry);
      if (!("who" in l)) return { ok: false, reason: l.reason };
      let prompt;
      try {
        prompt = assembleRenumberPrompt({
          owner: l.ctx.owner,
          name: l.ctx.name,
          issue: l.ctx.issue,
          pr: l.pr.number,
          headSha: round.fromSha,
          branch: l.pr.branch,
          baseRef: round.baseRef,
          baseSha: round.baseSha,
          resource,
          highest,
          files: round.conflictFiles,
          round: round.round,
          of: mergeQueue.MAX_CONFLICT_ROUNDS,
          runtime: promptRuntimeOf(l.ctx.executionMode),
        });
      } catch {
        // fx-swallow-ok: a value the prompt refuses is a closed refusal; the error text can name a path
        return { ok: false, reason: "invalid_input" };
      }
      const started = await deps.worker!.advanceStartFix(l.who, {
        kind: "renumber",
        baseSha: round.baseSha,
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
      const capacity = started.reason === "waiting_for_capacity";
      const spend = isReservationPause(started.reason) || started.reason === "refused_spend" || (!capacity && startWaitFor(started.reason) !== null);
      return { ok: false, reason: capacity ? "waiting_for_capacity" : spend ? "refused_spend" : (started.reason ?? "invalid_input") };
    },
  };
}

/** The tick's `onRenumber`, bound. `enabled` is the injected constant; production passes none. */
export function bindOnRenumber(deps: ConflictBinding, enabled?: boolean): NonNullable<mergeQueue.QueueTickDeps["onRenumber"]> {
  // Built at the call, not at the bind: the tick binds it for every repository, and a start that is off should cost nothing.
  return (entry, holder, ask, headSha) => mergeQueue.createOnRenumber(renumberPorts(deps), enabled)(entry, holder, ask, headSha);
}

/** D#483 S5-j2e: the same ports for a work item with no queue entry; the ordered-resource reads come from the same merge-gate client the gate itself used. */
export function entrylessRenumberPorts(deps: ConflictBinding): mergeQueue.EntrylessRenumberPorts {
  return { ...renumberPorts<mergeQueue.ConflictSubject>(deps), github: deps.github };
}
