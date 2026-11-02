import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { assembleConflictPrompt, isReservationPause, mergeQueue, promptRuntimeOf, readItemRecordedPullRequest, readPublicPullRequest, startWaitFor } from "@fx/pipeline";
import { findPrBody, reviewLoadBody } from "./advanceReviewSteps";
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

/**
 * The round's run start: reads the item's own context and starts the `conflict` fix round on the item's own execution target (`advanceStartFix` resolves it from the
 * repository's mode, so a `runner_local` repository's round goes to its runner and never to a hosted sandbox). It reads only stored rows and the item's pull-request lookup.
 */
export function conflictRoundStarter(deps: Omit<ConflictBinding, "github" | "tryMechanicalReplay">, only?: "runner_local"): (args: { entry: mergeQueue.RoundSubject; round: mergeQueue.ConflictRound }) => Promise<mergeQueue.RoundStart> {
  return async function startConflictRound({ entry, round }) {
    const l = await readEntryContext(deps, entry);
    if (!("who" in l)) return { ok: false, reason: l.reason };
    // A round decided from a runner's attested facts runs only on the runner: an item whose mode changed since the order ended is refused here, before any start.
    if (only !== undefined && l.ctx.executionMode !== only) return { ok: false, reason: "execution_mode_changed" };
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
      baseSha: round.baseSha,
      // D#519 MQ4-e2-c1 (C19): the round row's own anchors, carried to the runner job; the one place that sets them.
      conflictRound: { fromSha: round.fromSha, baseSha: round.baseSha, baseRef: round.baseRef },
      issue: l.ctx.issue,
      headSha: round.fromSha,
      prompt: prompt.prompt,
      contextSections: prompt.sections,
      round: round.round,
      actionId: l.actionId,
      // Fixed for the runner path, so the start itself refuses (`execution_mode_changed`) if the mode changes after the check above.
      expectedExecutionMode: only ?? l.ctx.executionMode,
      pr: { number: l.pr.number, branch: l.pr.branch },
    });
    if (started.ok) return { ok: true, runId: started.runId };
    // A spending-limit pause is a refused spend (the entry stops, nothing is retried); a wait for capacity keeps its own answer.
    const capacity = started.reason === "waiting_for_capacity";
    const spend = isReservationPause(started.reason) || started.reason === "refused_spend" || (!capacity && startWaitFor(started.reason) !== null);
    return { ok: false, reason: capacity ? "waiting_for_capacity" : spend ? "refused_spend" : (started.reason ?? "invalid_input") };
  };
}

export function conflictPorts<S extends mergeQueue.RoundSubject = mergeQueue.MergeQueueEntry>(deps: ConflictBinding): mergeQueue.ConflictPorts<S> {
  return {
    github: deps.github,
    inTenant: (accountId, fn) => withTenant(deps.pool, accountId, fn),
    // D#519 C10: the one module-level source of the push-record proof: unread (no round starts) until its production binding is set.
    platformCommits: async (entry, shas) => (await mergeQueue.readPlatformCommitProof()?.(entry, shas)) ?? null,
    ...(deps.tryMechanicalReplay ? { tryMechanicalReplay: deps.tryMechanicalReplay as mergeQueue.ConflictPorts<S>["tryMechanicalReplay"] } : {}),
    startConflictRound: conflictRoundStarter(deps),
  };
}

/** D#519 MQ4-e2-b: the ports of a round started from the runner's facts: the tenant and the run start only. No repository read, so no GitHub client is opened. */
export function runnerStartPorts(deps: Omit<ConflictBinding, "github" | "tryMechanicalReplay">): mergeQueue.RoundStartPorts {
  return { inTenant: (accountId, fn) => withTenant(deps.pool, accountId, fn), startConflictRound: conflictRoundStarter(deps, "runner_local") };
}

/** The tick's `onConflict`, bound. */
export function bindOnConflict(deps: ConflictBinding): NonNullable<mergeQueue.QueueTickDeps["onConflict"]> {
  return mergeQueue.createOnConflict(conflictPorts(deps));
}

/** Cancels a round's run. Only who acts for the item is needed (the pull request may already be closed or merged). */
async function cancelRoundRun(deps: ConflictBinding, entry: mergeQueue.RoundSubject, runId: string): Promise<void> {
  const found = await readEntryWho(deps, entry);
  if ("who" in found && deps.worker) {
    await deps.worker.advanceCancel(found.who, runId);
    return;
  }
  // No worker, or nobody on record to act for the item: the run cannot be cancelled from here, yet the round still ends and the entry still stops or
  // returns. Say so where the person looks (the item's driver event: an existing stop code with a fixed reason) and in the log, rather than nothing.
  console.warn(JSON.stringify({ event: "merge_queue.conflict_run_not_cancelled", entry_id: entry.id, run_id: runId, reason: "who" in found ? "worker_unavailable" : found.reason }));
  await mergeQueue.recordStop({ inTenant: (accountId, fn) => withTenant(deps.pool, accountId, fn) }, entry, CANCEL_NOT_CONFIRMED, entry.headSha);
}

/**
 * D#519 MQ4-c: the ports for the end of a round. The delta-review ports (the same stored-fact lookups) plus: whether the round's run ended, a cancel that needs
 * only who acts for the entry (the pull request may already be closed or merged), and the bound `onConflict` for a head that conflicts again.
 */
export function conflictCompletionPorts(deps: ConflictBinding): mergeQueue.ConflictCompletionPorts {
  return {
    ...deltaReviewPorts(deps),
    github: deps.github,
    cancelRun: (entry, runId) => cancelRoundRun(deps, entry, runId),
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

/** D#519 MQ4-e1-a: the ports for a work item with no queue entry: the same decision, run start and end checks, keyed by the item. No mechanical replay (it belongs to the queue). */
export function entrylessCompletionPorts(deps: ConflictBinding): mergeQueue.ConflictCompletionPorts<mergeQueue.ConflictSubject> {
  const conflict = entrylessStartPorts(deps);
  return {
    ...deltaReviewPorts<mergeQueue.ConflictSubject>(deps),
    github: deps.github,
    cancelRun: (entry, runId) => cancelRoundRun(deps, entry, runId),
    roundRunEnded: async (entry, runId) => (deps.worker ? (await deps.worker.advanceRunOutcome(entry.accountId, runId)).done : false),
    startEntryless: (subject) => mergeQueue.startEntrylessConflict(conflict, subject),
    publicOutcome: (_subject, round) => withTenant(deps.pool, round.accountId, (c) => mergeQueue.readRepublishOutcome(c, round)),
  };
}

export function entrylessStartPorts(deps: ConflictBinding): mergeQueue.ConflictPorts<mergeQueue.ConflictSubject> {
  return conflictPorts<mergeQueue.ConflictSubject>({ ...deps, tryMechanicalReplay: undefined });
}

/**
 * The item's own view for a round with no queue entry, read from stored rows and the live pull request; the caller passes none of it. `reason` when it is not this path's:
 * the item has a public copy a person took over or that is not open, no review context, or no open pull request.
 * `ended`: the caller only follows a round that is open (the wait, the sweep). When the pull request is no longer open (a person merged or closed it) the subject is
 * built from the stored rows instead (the item's recorded pull request and the newest round's head), so the completion can read its state and end the round.
 */
export async function readEntrylessSubject(deps: Omit<DeltaReviewBinding, "github">, accountId: string, workItemId: string, ended = false): Promise<mergeQueue.ConflictSubject | { reason: string }> {
  const found = await readEntryWho(deps, { accountId, workItemId });
  if (!("who" in found)) return found;
  const ctx = await reviewLoadBody(deps.worker, found.who, null);
  if (!ctx.ok) return { reason: ctx.reason };
  // A paired item is this path's only when its public pull request is open and the platform's own (MQ4-e1-b); a stacked one is refused by the round's start.
  const paired = await readPublicPullRequest(deps.pool)(accountId, workItemId);
  // An open round is followed to its end whatever became of the copy meanwhile (its end reads the republish): only a start refuses.
  if (!ended && paired !== null && (paired.pr === null || paired.pr.managedByPerson || paired.pr.pushState !== "pr_opened")) return { reason: "conflict_public_copy" };
  const pr = await findPrBody(deps.open, ctx);
  // Only a confirmed `no_open_pr` falls back to stored rows; a lookup that failed (GitHub unavailable) says "try later", so a stale recorded pull request is never judged.
  if (!pr.ok && ended && pr.reason !== "no_open_pr") return { reason: "try_later" };
  const rounds = await withTenant(deps.pool, accountId, (c) => mergeQueue.listConflictRounds(c, accountId, workItemId));
  if (pr.ok) return { id: workItemId, accountId, repoId: ctx.repoId, workItemId, prNumber: pr.number, headSha: pr.headSha, entryId: null, roundsUsed: rounds.length };
  const newest = rounds[rounds.length - 1];
  const recorded = ended ? await readItemRecordedPullRequest(deps.pool, accountId, workItemId) : null;
  if (newest === undefined || newest.outcome !== null) return { reason: "invalid_input" };
  // An item with no recorded pull request (a sandbox build) has nothing to read: the caller ends the open round (`endRoundWithoutPr`).
  if (recorded === null) return { reason: ended ? "no_open_pr" : "invalid_input" };
  return { id: workItemId, accountId, repoId: ctx.repoId, workItemId, prNumber: recorded.number, headSha: newest.toSha ?? newest.fromSha, entryId: null, roundsUsed: rounds.length };
}

/** One look at a work item's conflict round with no queue entry (see `completeEntrylessRound`). */
export function bindCompleteEntryless(deps: ConflictBinding): (subject: mergeQueue.ConflictSubject) => Promise<mergeQueue.EntrylessCompletion> {
  const ports = entrylessCompletionPorts(deps);
  return (subject) => mergeQueue.completeEntrylessRound(ports, subject);
}

/** A confirmed `no_open_pr` for an item with no recorded pull request: nothing can be read or followed, so its open round ends as a closed pull request's does, with its run cancelled. */
export async function endRoundWithoutPr(deps: Omit<DeltaReviewBinding, "github">, accountId: string, workItemId: string): Promise<boolean> {
  const rounds = await withTenant(deps.pool, accountId, (c) => mergeQueue.listConflictRounds(c, accountId, workItemId));
  const open = rounds[rounds.length - 1];
  if (!open || open.entryId !== null || open.outcome !== null) return false;
  const found = open.runId ? await readEntryWho(deps, { accountId, workItemId }) : null;
  if (open.runId && found && "who" in found) await deps.worker?.advanceCancel(found.who, open.runId);
  await withTenant(deps.pool, accountId, (c) => mergeQueue.endRound(c, { accountId, roundId: open.id, outcome: "pr_closed" }));
  return true;
}
