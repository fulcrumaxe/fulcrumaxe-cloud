import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { assembleConflictPrompt, isReservationPause, mergeQueue, promptRuntimeOf, startWaitFor } from "@fx/pipeline";
import { deltaReviewPorts, readEntryContext, readEntryWho, type DeltaReviewBinding } from "./mergeQueueDeltaReview";
import { appUserPool } from "./github/installationReconcile";
import { readRepoAppLogin } from "./github/installationHttp";

// D#519 MQ4-b0: the ONE production binding of the platform commit proof: the push records the gh-proxy writes, read as app_user in the entry's tenant.
// The pool is opened at the first read, not here. Removing this line turns MQ4 off (every conflict then stops `identity_unread`, with no GitHub read).
mergeQueue.bindPlatformCommitProof(mergeQueue.createPlatformPushReader({ inTenant: (accountId, fn) => withTenant(appUserPool(), accountId, fn), appLogin: readRepoAppLogin }));

/**
 * D#519 MQ4-b: binds the merge queue's `onConflict` to the real conflict round. Everything about the item (who approved it, its halt epoch, its review
 * context, the pull request) is read from the stored rows and from GitHub by the same lookup the delta review uses; the queue's caller passes none of
 * it. The round is the worker's `conflict` fix round: it resumes the build's session (or queues for the runner), merges nothing itself, and moves no stage.
 */
export interface ConflictBinding extends DeltaReviewBinding {
  github: mergeQueue.ConflictPorts["github"] & DeltaReviewBinding["github"];
  tryMechanicalReplay?: mergeQueue.ConflictPorts["tryMechanicalReplay"];
}

/** The fixed reason on the stop event when a round's run could not be cancelled (the event's code is the existing `merge_conflict`). */
export const CANCEL_NOT_CONFIRMED = "run_cancel_not_confirmed";

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

/**
 * D#519 MQ4-c: the ports for the end of a round. The delta-review ports (the same stored-fact lookups) plus: whether the round's run ended, a cancel that needs
 * only who acts for the entry (the pull request may already be closed or merged), and the bound `onConflict` for a head that conflicts again.
 */
export function conflictCompletionPorts(deps: ConflictBinding): mergeQueue.ConflictCompletionPorts {
  return {
    ...deltaReviewPorts(deps),
    github: deps.github,
    async cancelRun(entry, runId) {
      const found = await readEntryWho(deps, entry);
      if ("who" in found && deps.worker) {
        await deps.worker.advanceCancel(found.who, runId);
        return;
      }
      // No worker, or nobody on record to act for the item: the run cannot be cancelled from here, yet the round still ends and the entry still stops or
      // returns. Say so where the person looks (the item's driver event: an existing stop code with a fixed reason) and in the log, rather than nothing.
      console.warn(JSON.stringify({ event: "merge_queue.conflict_run_not_cancelled", entry_id: entry.id, run_id: runId, reason: "who" in found ? "worker_unavailable" : found.reason }));
      await mergeQueue.recordStop({ inTenant: (accountId, fn) => withTenant(deps.pool, accountId, fn) }, entry, CANCEL_NOT_CONFIRMED, entry.headSha);
    },
    // A worker that cannot be reached answers "not ended": the entry waits, and the round timeout still bounds it.
    roundRunEnded: async (entry, runId) => (deps.worker ? (await deps.worker.advanceRunOutcome(entry.accountId, runId)).done : false),
    onConflict: (entry) => bindOnConflict(deps)(entry),
  };
}

/** One look at an entry whose conflict round is running (see `completeConflictRound`). */
export function bindCompleteConflictRound(deps: ConflictBinding): (entry: mergeQueue.MergeQueueEntry) => Promise<mergeQueue.ConflictCompletion> {
  const ports = conflictCompletionPorts(deps);
  return (entry) => mergeQueue.completeConflictRound(ports, entry);
}
