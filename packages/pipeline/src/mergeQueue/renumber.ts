import type { PoolClient } from "pg";
import type { PullRequestRef } from "../build/types.js";
import { CAPACITY_WAIT_REASONS, CONFLICT_FILES_MAX, START_IDLE_TIMEOUT_MS, provePlatformAuthored, type ConflictPorts, type RoundStart } from "./conflict.js";
import { isSafeRepoPath } from "../discovery/verifierOutput.js";
import { MAX_CONFLICT_ROUNDS } from "./policy.js";
import { recordRoundRun, releaseToQueue, startConflictWork, stopEntry } from "./store.js";
import { subjectOf, type ConflictRound, type MergeQueueEntry } from "./types.js";

/**
 * D#519 MQ5-b1 (C14-3, C16-1): the START of an ordered-resource renumber round. The check (MQ5-a) found that the pull request's new resource files sort at or below
 * the default branch's latest key. When a round is allowed, the entry gives up its slot and an executor run renames the files and fixes their references; when it
 * is not, the entry stops `ordered_resource_out_of_order` exactly as MQ5-a leaves it. Nothing here judges the end of a round: that is MQ5-b2.
 *
 * The start is ON since MQ5-b2 (the round-end judge `judgeRenumberRound`, the delta review on a plain diff, and the completion dispatch in the wait and the sweep), so every round
 * that starts can finish. It stays refused for an item with an open public copy (the worker refuses `conflict_public_copy`: nothing maps a renumber round's republish), and a
 * `runner_local` repository is never ticked, so its entries cannot reach it. A disabled start (tests pass `false`) reads nothing and answers "not started".
 */
export const RENUMBER_START_ENABLED = true;

/** What the check found, as structured fields: the resource, the added files of it, the default branch's highest key, and the repository's `autoRenumber`. */
export interface RenumberAsk {
  autoRenumber: boolean;
  resource: string;
  /** The resource files the pull request adds. */
  files: readonly string[];
  highest: string;
}

export type RenumberNo = "auto_renumber_off" | "stacked" | "rounds_exhausted" | "no_files" | "foreign_commits" | "unreadable" | "identity_unread";
export type RenumberDecision = { go: true; baseSha: string; baseRef: string } | { go: false; code: RenumberNo };

export interface RenumberPorts<S extends MergeQueueEntry = MergeQueueEntry> {
  github: ConflictPorts<S>["github"];
  inTenant<T>(accountId: string, fn: (client: PoolClient) => Promise<T>): Promise<T>;
  /** The same proof the conflict round reads (C10); null while unread. */
  platformCommits: ConflictPorts<S>["platformCommits"];
  /** Starts the round's agent run inside the start transaction: a refusal leaves no round row. */
  startRenumberRound(args: { entry: S; round: ConflictRound; resource: string; highest: string }): Promise<RoundStart>;
}

/**
 * The decision alone (no write). Allowed only when `autoRenumber` is not off, the entry is not stacked on a parent, the shared bound has a round left, the files are
 * a bounded list of safe paths, and every commit that touches those files is the platform's own (rule (a), the conflict round's proof). Anything unread answers no.
 */
export async function decideRenumber<S extends MergeQueueEntry>(ports: Pick<RenumberPorts<S>, "github" | "platformCommits">, entry: S, ask: RenumberAsk): Promise<RenumberDecision> {
  const subject = subjectOf(entry);
  if (subject === null) return { go: false, code: "unreadable" };
  if (!ask.autoRenumber) return { go: false, code: "auto_renumber_off" };
  if (entry.dependsOnPrNumber !== null) return { go: false, code: "stacked" };
  if (subject.roundsUsed >= MAX_CONFLICT_ROUNDS) return { go: false, code: "rounds_exhausted" };
  if (ask.files.length === 0 || ask.files.length > CONFLICT_FILES_MAX || !ask.files.every(isSafeRepoPath)) return { go: false, code: "no_files" };
  // Asked before any GitHub read: with the proof unread a decision costs no call at all.
  if ((await ports.platformCommits(entry, [])) === null) return { go: false, code: "identity_unread" };
  const pr: PullRequestRef = { repoId: subject.repoId, prNumber: subject.prNumber };
  const authored = await provePlatformAuthored(ports, entry, pr, ask.files);
  if (authored !== "ok") return { go: false, code: authored };
  const tip = await ports.github.getDefaultBranchTip(pr);
  return { go: true, baseSha: tip.sha, baseRef: tip.branch };
}

class Undo extends Error {
  constructor(readonly refusal: string) {
    super("renumber round start undone");
  }
}

/**
 * The tick's `onRenumber`: answers whether the entry is handled (a round started, or it waits for capacity or stopped for a refused spend). False leaves the caller to
 * stop the entry `ordered_resource_out_of_order`. `enabled` is the injected constant (tests pass both states).
 */
export function createOnRenumber(ports: RenumberPorts, enabled: boolean = RENUMBER_START_ENABLED): (entry: MergeQueueEntry, holder: string, ask: RenumberAsk, headSha: string) => Promise<boolean> {
  return async (entry, holder, ask, headSha) => {
    if (!enabled) return false;
    const decision = await decideRenumber(ports, entry, ask);
    if (!decision.go) return false;
    const { accountId } = entry;
    try {
      const started = await ports.inTenant(accountId, async (c) => {
        // Same guard as the conflict round's start: a hung sandbox resume must not hold the entry's row lock for ever.
        await c.query(`SET LOCAL idle_in_transaction_session_timeout = ${START_IDLE_TIMEOUT_MS}`);
        const s = await startConflictWork(c, { accountId, entryId: entry.id, holder, fromSha: headSha, baseSha: decision.baseSha, baseRef: decision.baseRef, conflictFiles: ask.files, kind: "renumber" });
        if (!s.ok) return s.reason === "rounds_exhausted" ? ("rounds_exhausted" as const) : ("moved" as const);
        const run = await ports.startRenumberRound({ entry: s.entry, round: s.round, resource: ask.resource, highest: ask.highest });
        // A refusal rolls the whole start back: no round row, no counted round, the entry as it was.
        if (!run.ok) throw new Undo(run.reason);
        await recordRoundRun(c, { accountId, roundId: s.round.id, runId: run.runId });
        return "started" as const;
      });
      // "moved": another pass already moved the entry; its record is that pass's. Exhausted: the shared bound was spent between the decision and the write.
      return started !== "rounds_exhausted";
    } catch (err) {
      if (!(err instanceof Undo)) throw err;
      if (CAPACITY_WAIT_REASONS.includes(err.refusal)) {
        // Nothing was spent: the slot goes back and the next pass asks again.
        await ports.inTenant(accountId, (c) => releaseToQueue(c, { accountId, entryId: entry.id, holder }));
        return true;
      }
      if (err.refusal === "refused_spend") {
        await ports.inTenant(accountId, (c) => stopEntry(c, { accountId, entryId: entry.id, reason: "refused_spend", holder }));
        return true;
      }
      return false;
    }
  };
}
