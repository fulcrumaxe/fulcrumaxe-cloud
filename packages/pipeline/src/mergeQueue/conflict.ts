import type { PoolClient } from "pg";
import { isDetailPath, isDetailRef } from "@fulcrumaxe/runner-protocol";
import { COVERED_COMMITS_MAX, coveredCommits } from "@fulcrumaxe/runner-protocol/planePush";
import { PUBLIC_BRANCH_MOVED } from "@fx/core/src/repos/planePushRecord.js";
import { recordDriverEvent } from "@fx/core/src/work-items/driverEvents.js";
import type { CommitInfo, CommitReaderPort, ConflictReaderPort, DefaultBranchReaderPort } from "../build/githubMergePort.js";
import type { PullRequestRef } from "../build/types.js";
import { isSafeRepoPath } from "../discovery/verifierOutput.js";
import { MAX_CONFLICT_ROUNDS } from "./policy.js";
import { platformRefreshIdentity } from "./refresh.js";
import { recordRoundRun, releaseToQueue, startConflictWork, startEntrylessConflictRound, stopEntry } from "./store.js";
import { subjectOf, type ConflictRound, type ConflictSubject, type MergeQueueEntry, type RoundKind, type RoundSubject } from "./types.js";

/**
 * D#519 MQ4-b: the real `onConflict`. A queued entry (or the slot holder) whose pull request no longer merges cleanly is given a fix round, but
 * only when the cloud can show that the round is the platform's own to settle:
 *
 *  1. the entry has a round left (`MAX_CONFLICT_ROUNDS`);
 *  2. the conflict files are known: the files the pull request changed since its merge base that the default branch also changed since then
 *     (an empty, unknown or cut list answers no: fail closed);
 *  3. every commit of the pull request that touches a conflict file is proved the platform's own (C10; a foreign commit means a person has to look);
 *  4. MQ8's mechanical replay, when the caller has one, gets the first try;
 *  5. otherwise one transaction starts the round and the agent run: either both happen or neither does.
 *
 * Nothing here reads text a person wrote: logins, shas and paths only.
 */

/** The commits of a pull request one decision reads. A longer pull request fails closed. */
export const CONFLICT_COMMIT_READS_MAX = COVERED_COMMITS_MAX;
/** `merge_conflict_rounds.conflict_files` holds at most this many paths. */
export const CONFLICT_FILES_MAX = 100;
/**
 * `idle_in_transaction_session_timeout` for the round-start transaction (compare `LOCK_IDLE_TIMEOUT_MS` in build/continuation.ts). Postgres counts only
 * the time the session sits idle between statements, which is exactly the sandbox resume awaited in the middle of it: 5 minutes is several times a
 * healthy resume and well short of the point where the held entry lock would stall the queue.
 */
export const START_IDLE_TIMEOUT_MS = 5 * 60_000;

/**
 * D#519 C10: how a pull request's commit is proved the platform's own. Never by a git name or email, and never by a login GitHub has not signed for: anyone
 * with push access can set either. A commit is ours when (a) a record of a push the platform made covers it (`coveredCommits`), or (b) GitHub made it for
 * our app (`platformRefreshIdentity`: author our app's login, committer `web-flow`, verified with reason `valid`).
 */
export interface PlatformPush {
  /** The ref's value before the push; null when the push created the branch. */
  oldSha: string | null;
  newSha: string;
  /** The pushing run's recorded start commit; null when it started from the default branch. */
  startSha: string | null;
  runId: string;
}
export interface PlatformCommitProof {
  /** The repository's app login (rule b), or null when it is not known: then only push records count. */
  appLogin: string | null;
  pushes: readonly PlatformPush[];
}
/** The proof for an entry's commits `shas` (records whose new tip is one of them). Null while unread. An empty list asks only whether it can be read. */
export type PlatformCommitProofReader = { bivariant(entry: RoundSubject, shas: readonly string[]): Promise<PlatformCommitProof | null> }["bivariant"];

/**
 * The ONE source of the proof. Every conflict binding (the tick's `onConflict`, the queue wait, the sweep, the round end) reads it here; none passes its own.
 * It answers unread (null) until `bindPlatformCommitProof` is called, and the web wiring calls it in exactly one place (a test scans for that). A test
 * may override it through `setPlatformCommitProofForTest`, which production code must never call (a test scans for that too).
 */
let platformCommitProofSource: PlatformCommitProofReader | null = null;
let platformCommitProofOverride: PlatformCommitProofReader | null = null;

/** The proof reader, or null while it has not been read. */
export function readPlatformCommitProof(): PlatformCommitProofReader | null {
  return platformCommitProofOverride ?? platformCommitProofSource;
}

/** The production binding (D#519 MQ4-b0: the push-record reader). Called once, by the web wiring; undo is not calling it. */
export function bindPlatformCommitProof(reader: PlatformCommitProofReader): void {
  platformCommitProofSource = reader;
}

/** TEST ONLY: overrides the source; null drops the override (back to the production binding, or "unread" where there is none). Production code never calls this. */
export function setPlatformCommitProofForTest(reader: PlatformCommitProofReader | null): void {
  platformCommitProofOverride = reader;
}

/** Moved to the runner protocol (`planePush/coveredCommits.ts`) so the local runner walks the same rule; re-exported here for the callers and tests that name it. */
export { coveredCommits };

export type RoundStart = { ok: true; runId: string } | { ok: false; reason: string };

export interface ConflictPorts<S extends RoundSubject = MergeQueueEntry> {
  github: CommitReaderPort & ConflictReaderPort & DefaultBranchReaderPort;
  inTenant<T>(accountId: string, fn: (client: PoolClient) => Promise<T>): Promise<T>;
  /** The proof for the entry's commits `shas` (see `PlatformCommitProofReader`). Null while unread: no round starts (the entry stops as it does today). */
  platformCommits(entry: S, shas: readonly string[]): Promise<PlatformCommitProof | null>;
  /** MQ8: tries a mechanical replay first. Answers whether it settled the conflict. Absent: skipped. */
  tryMechanicalReplay?(entry: S, files: readonly string[]): Promise<boolean>;
  /**
   * Starts the round's agent run, inside the start transaction: a refusal leaves no round row. `capacity_wait` and `refused_spend` have their own handling;
   * any other reason stops the entry as a conflict.
   */
  startConflictRound(args: { entry: S; round: ConflictRound }): Promise<RoundStart>;
}

type NoCode = "rounds_exhausted" | "no_conflict_files" | "foreign_commits" | "unreadable" | "identity_unread";
export type ConflictDecision = { go: true; files: readonly string[]; baseSha: string; baseRef: string } | { go: false; code: NoCode; files: readonly string[]; baseRef?: string };

const REFUSED_SPEND = "refused_spend";
export const CAPACITY_WAIT_REASONS: readonly string[] = ["capacity_wait", "waiting_for_capacity"];

// The detail table's path and ref rules live in the runner protocol (`detailRules.ts`), shared with the merge report's conflict facts; re-exported for the callers and tests that name them.
export { isDetailPath, isDetailRef };

class Undo extends Error {
  constructor(readonly refusal: string) {
    super("conflict round start undone");
  }
}

/**
 * The decision alone (no write): bound, files, authorship. A read that is cut short answers no. D#519 C8: "the PR head" is the live head when the caller read
 * one (after a refresh, the refresh tip), else the stored head, so the files are computed against the commit the executor merges from.
 */
export async function decideConflict<S extends RoundSubject>(ports: ConflictPorts<S>, entry: S, liveHeadSha?: string): Promise<ConflictDecision> {
  // The default branch's name is known once its tip was read; a decision that stops before any read (identity, bound) has none, and adds no read to get one.
  const no = (code: NoCode, files: readonly string[] = [], baseRef?: string): ConflictDecision => ({ go: false, code, files, ...(baseRef === undefined ? {} : { baseRef }) });
  const subject = subjectOf(entry);
  if (subject === null) return no("unreadable");
  if (subject.roundsUsed >= MAX_CONFLICT_ROUNDS) return no("rounds_exhausted");
  // Asked before any GitHub read: with the proof unread (today, in production) a decision costs no call at all.
  if ((await ports.platformCommits(entry, [])) === null) return no("identity_unread");
  const pr: PullRequestRef = { repoId: subject.repoId, prNumber: subject.prNumber };
  const headSha = liveHeadSha ?? subject.headSha;
  const tip = await ports.github.getDefaultBranchTip(pr);
  const mine = await ports.github.compareCommits(pr, tip.sha, headSha, { files: true });
  if (mine.files === null || mine.filesTruncated) return no("unreadable", [], tip.branch);
  const theirs = await ports.github.compareCommits(pr, mine.mergeBaseSha, tip.sha, { files: true });
  if (theirs.files === null || theirs.filesTruncated) return no("unreadable", [], tip.branch);
  const main = new Set(theirs.files);
  const files = [...new Set(mine.files.filter((f) => main.has(f)))].sort();
  if (files.length === 0 || files.length > CONFLICT_FILES_MAX || !files.every(isSafeRepoPath)) return no("no_conflict_files", files, tip.branch);

  const authored = await provePlatformAuthored(ports, entry, pr, files);
  if (authored !== "ok") return no(authored, files, tip.branch);
  return { go: true, files, baseSha: tip.sha, baseRef: tip.branch };
}

/**
 * Rule (a) of D#519 C10, shared by the conflict round and the renumber round (MQ5-b1): every commit of the pull request that touches one of `files` is proved the
 * platform's own. Anything that cannot be read answers `unreadable` / `identity_unread`; a commit a person made answers `foreign_commits`.
 */
export async function provePlatformAuthored<S extends RoundSubject>(
  ports: Pick<ConflictPorts<S>, "github" | "platformCommits">,
  entry: S,
  pr: PullRequestRef,
  files: readonly string[],
): Promise<"ok" | "unreadable" | "identity_unread" | "foreign_commits"> {
  const list = await ports.github.listPullCommits(pr);
  if (list.truncated || list.commits.length > CONFLICT_COMMIT_READS_MAX) return "unreadable";
  // Every commit is read first (the walk needs every parent); then only the commits that touch a conflict file have to be proved the platform's.
  const infos: CommitInfo[] = [];
  for (const c of list.commits) {
    const info = await ports.github.getCommit(pr, c.sha);
    if (info.files === null || info.filesTruncated) return "unreadable";
    infos.push(info);
  }
  const shas = list.commits.map((c) => c.sha);
  const proof = await ports.platformCommits(entry, shas);
  if (proof === null) return "identity_unread";
  const covered = coveredCommits(shas, new Map(infos.map((i) => [i.sha, i.parents])), proof);
  if (covered === "unreadable") return "unreadable";
  const appLogin = proof.appLogin?.trim() ? proof.appLogin : null;
  const conflicting = new Set(files);
  for (const info of infos) {
    if (!info.files!.some((f) => conflicting.has(f)) || covered.has(info.sha)) continue;
    if (appLogin === null || !platformRefreshIdentity(info, appLogin).ok) return "foreign_commits";
  }
  return "ok";
}

/** The tick's `onConflict`. Answers whether the conflict is being handled (a round started, or the entry waits); false stops the entry with `merge_conflict`. */
export function createOnConflict(ports: ConflictPorts): (entry: MergeQueueEntry, holder?: string, liveHeadSha?: string) => Promise<boolean> {
  return async (entry, holder, liveHeadSha) => {
    const decision = await decideConflict(ports, entry, liveHeadSha);
    if (!decision.go) {
      await recordStop(ports, entry, decision.code, liveHeadSha ?? entry.headSha, "merge_conflict", { baseRef: decision.baseRef ?? null, ...(decision.code === "foreign_commits" ? { conflictFiles: decision.files } : {}) });
      return false;
    }
    if (ports.tryMechanicalReplay && (await ports.tryMechanicalReplay(entry, decision.files))) return true;
    const { accountId } = entry;
    try {
      const started = await ports.inTenant(accountId, async (c) => {
        // This transaction holds the entry's row lock and a pool connection across the worker's resume of the sandbox. A start that hangs must not hold them
        // for ever. A healthy start (a few DB writes plus one sandbox resume: seconds to a minute) is far inside this; the value only has to exceed the
        // slowest healthy start, so a stuck start frees the lock and the next pass can decide again.
        await c.query(`SET LOCAL idle_in_transaction_session_timeout = ${START_IDLE_TIMEOUT_MS}`);
        // D#519 C8: the round starts from the pull request's live head (after a refresh, the refresh tip), so the executor's merge has it as its first parent.
        // A caller that read none falls back to the stored head.
        const s = await startConflictWork(c, { accountId, entryId: entry.id, ...(holder !== undefined ? { holder } : {}), fromSha: liveHeadSha ?? entry.headSha, baseSha: decision.baseSha, baseRef: decision.baseRef, conflictFiles: decision.files });
        if (!s.ok) return s.reason === "rounds_exhausted" ? ("rounds_exhausted" as const) : ("moved" as const);
        const run = await ports.startConflictRound({ entry: s.entry, round: s.round });
        // A refusal rolls the whole start back: no round row, no counted round, the entry as it was.
        if (!run.ok) throw new Undo(run.reason);
        await recordRoundRun(c, { accountId, roundId: s.round.id, runId: run.runId });
        return "started" as const;
      });
      if (started === "rounds_exhausted") {
        await recordStop(ports, entry, "rounds_exhausted", liveHeadSha ?? entry.headSha, "merge_conflict", { baseRef: decision.baseRef });
        return false;
      }
      // "moved": another pass already moved the entry (a round is running, or it was stopped or merged). Its record is that pass's; this one writes nothing.
      return true;
    } catch (err) {
      if (!(err instanceof Undo)) throw err;
      if (CAPACITY_WAIT_REASONS.includes(err.refusal)) {
        // Not a refusal: nothing was spent. The entry waits where it was and is asked again on the next pass (a holder gives its slot back first).
        if (holder !== undefined) await ports.inTenant(accountId, (c) => releaseToQueue(c, { accountId, entryId: entry.id, holder }));
        return true;
      }
      if (err.refusal === REFUSED_SPEND) {
        await ports.inTenant(accountId, (c) => stopEntry(c, { accountId, entryId: entry.id, reason: REFUSED_SPEND, ...(holder !== undefined ? { holder } : {}) }));
        return true;
      }
      await recordStop(ports, entry, "round_not_started", liveHeadSha ?? entry.headSha, "merge_conflict", { baseRef: decision.baseRef });
      return false;
    }
  };
}

/** `running`: a round of this item is already open (or a queue entry is live): nothing was started or changed. `waiting`: no capacity yet; the caller asks again. */
export type EntrylessStart = { outcome: "started" | "running" | "waiting" } | { outcome: "stopped"; reason: string };

/**
 * D#519 MQ4-e1-a: the same decision and bound as the queue's `onConflict`, for a work item with no queue entry. One transaction inserts the round row (entry_id NULL) and
 * starts the agent run: an `Undo` refusal rolls the round back. There is no slot to give back. The round starts from the live head `subject.headSha`.
 * D#483 S5-j2e: `eventCode` is the code a stop is recorded under; the direct gate's `overlap_unreviewed` re-route passes its own, so a clean overlap is never worded as a conflict.
 */
export async function startEntrylessConflict(ports: ConflictPorts<ConflictSubject>, subject: ConflictSubject, eventCode?: string): Promise<EntrylessStart> {
  return startEntrylessFromDecision(ports, subject, await decideConflict(ports, subject), eventCode === undefined ? {} : { eventCode });
}

/**
 * D#519 MQ4-e2-b: what the runner attests about a `runner_local` item's refused merge call, as the merge order stored it. The paths are the runner's TRUE content conflicts
 * (merge-tree's conflicted files), narrower than the hosted decision's "changed on both sides"; they are taken as given, held to the detail table's rules.
 */
export interface RunnerConflictFacts {
  verdict: "conflict_platform" | "conflict_foreign";
  baseSha: string;
  baseRef: string;
  files: readonly string[];
}

/**
 * The decision from the runner's facts alone: pure, no read. The same bound as `decideConflict` and the same closed result. Only a platform verdict goes; a foreign one is the
 * item-22 stop (`foreign_commits`, with the stored paths); a value outside the table's rules fails closed as `unreadable`.
 */
export function decideFromRunnerFacts(facts: RunnerConflictFacts, roundsUsed: number): ConflictDecision {
  const files = [...facts.files];
  const baseRef = isDetailRef(facts.baseRef) ? facts.baseRef : undefined;
  if (roundsUsed >= MAX_CONFLICT_ROUNDS) return { go: false, code: "rounds_exhausted", files, ...(baseRef === undefined ? {} : { baseRef }) };
  const shaOk = /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(facts.baseSha);
  if (baseRef === undefined || !shaOk || files.length === 0 || files.length > CONFLICT_FILES_MAX || !files.every(isDetailPath)) return { go: false, code: "unreadable", files: [] };
  if (facts.verdict === "conflict_foreign") return { go: false, code: "foreign_commits", files, baseRef };
  return { go: true, files, baseSha: facts.baseSha, baseRef };
}

/** What a start needs: the tenant and the round's own start. No repository read: a `runner_local` item's decision comes from the runner's facts. */
export type RoundStartPorts = Pick<ConflictPorts<ConflictSubject>, "inTenant" | "startConflictRound">;

/** The item's round from the runner's stored facts: the same start and stops as `startEntrylessConflict`, with `decideFromRunnerFacts` as the decision. */
export async function startEntrylessFromRunnerFacts(ports: RoundStartPorts, subject: ConflictSubject, facts: RunnerConflictFacts): Promise<EntrylessStart> {
  return startEntrylessFromDecision(ports, subject, decideFromRunnerFacts(facts, subject.roundsUsed));
}

/** What a start decided, in the one shape both kinds of round use: the files to hand the agent, or a fixed code for why no round starts. */
export type StartDecision = { go: true; files: readonly string[]; baseSha: string; baseRef: string } | { go: false; code: string; files: readonly string[]; baseRef?: string };

/** D#483 S5-j2e: how a start differs from the conflict round: the code its stops are recorded under, the round's kind, and the run it starts (default: the conflict round's). */
export interface EntrylessShape {
  eventCode?: string;
  kind?: RoundKind;
  startRun?(args: { entry: ConflictSubject; round: ConflictRound }): Promise<RoundStart>;
}

export async function startEntrylessFromDecision(ports: Pick<RoundStartPorts, "inTenant"> & Partial<Pick<RoundStartPorts, "startConflictRound">>, subject: ConflictSubject, decision: StartDecision, shape: EntrylessShape = {}): Promise<EntrylessStart> {
  const { accountId } = subject;
  const startRun = shape.startRun ?? ports.startConflictRound;
  const ev = shape.eventCode ?? "merge_conflict";
  const stop = async (code: string, eventCode = ev, detail?: { baseRef?: string | null; conflictFiles?: readonly string[] }): Promise<EntrylessStart> => {
    await recordStop(ports, subject, code, subject.headSha, eventCode, detail);
    return { outcome: "stopped", reason: eventCode };
  };
  if (!decision.go) return stop(decision.code, ev, { baseRef: decision.baseRef ?? null, ...(decision.code === "foreign_commits" ? { conflictFiles: decision.files } : {}) });
  try {
    const started = await ports.inTenant(accountId, async (c) => {
      await c.query(`SET LOCAL idle_in_transaction_session_timeout = ${START_IDLE_TIMEOUT_MS}`);
      const s = await startEntrylessConflictRound(c, { accountId, workItemId: subject.workItemId, fromSha: subject.headSha, baseSha: decision.baseSha, baseRef: decision.baseRef, conflictFiles: decision.files, ...(shape.kind === undefined ? {} : { kind: shape.kind }) });
      if (!s.ok) return s.reason;
      if (startRun === undefined) throw new Error("no round start bound");
      const run = await startRun({ entry: { ...subject, roundsUsed: s.round.round }, round: s.round });
      if (!run.ok) throw new Undo(run.reason);
      await recordRoundRun(c, { accountId, roundId: s.round.id, runId: run.runId });
      return "started" as const;
    });
    if (started === "rounds_exhausted") return stop("rounds_exhausted", ev, { baseRef: decision.baseRef });
    return { outcome: started === "started" ? "started" : "running" };
  } catch (err) {
    if (!(err instanceof Undo)) throw err;
    if (CAPACITY_WAIT_REASONS.includes(err.refusal)) return { outcome: "waiting" };
    if (err.refusal === REFUSED_SPEND) return stop(REFUSED_SPEND, REFUSED_SPEND);
    // MQ4-e1-b (C11-e1-4b): a public branch that is no longer where the platform left it holds a person's commit: the foreign-commits stop, with the files, in this path only
    // (a review round keeps `public_branch_moved`). Nothing was published and no public ref moved.
    if (err.refusal === PUBLIC_BRANCH_MOVED) return stop("foreign_commits", ev, { baseRef: decision.baseRef, conflictFiles: decision.files });
    return stop("round_not_started", ev, { baseRef: decision.baseRef });
  }
}

/**
 * The fixed fact behind a `merge_conflict` stop: why no round ran (or how the last one ended: MQ4-c), and how many already had. Codes and counts only.
 * `eventCode` is the stop's own code (`merge_conflict` unless the end of a round stopped the entry for another fixed reason).
 */
export async function recordStop(ports: Pick<ConflictPorts, "inTenant">, who: RoundSubject, code: string, headSha: string, eventCode = "merge_conflict", detail?: { baseRef?: string | null; conflictFiles?: readonly string[] }): Promise<void> {
  const entry = subjectOf(who);
  if (entry === null) return;
  // The table checks both and a bad value fails the write, and the event with it; each value is held to the table's rules here, and one that fails is left out.
  const baseRef = isDetailRef(detail?.baseRef) ? detail!.baseRef! : null;
  const conflictFiles = (detail?.conflictFiles ?? []).filter(isDetailPath).slice(0, CONFLICT_FILES_MAX);
  await ports.inTenant(entry.accountId, (c) =>
    recordDriverEvent(c, entry.accountId, {
      workItemId: entry.workItemId,
      kind: "stopped",
      dedupeKey: `conflict:${headSha}:${entry.roundsUsed}:${code}`,
      code: eventCode,
      reasons: [code],
      headSha,
      prNumber: entry.prNumber,
      round: entry.roundsUsed,
      detail: { conflictFiles, baseRef },
    }),
  );
}
