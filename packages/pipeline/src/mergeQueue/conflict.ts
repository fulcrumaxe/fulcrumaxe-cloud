import type { PoolClient } from "pg";
import { recordDriverEvent } from "@fx/core/src/work-items/driverEvents.js";
import type { CommitInfo, CommitReaderPort, ConflictReaderPort, DefaultBranchReaderPort } from "../build/githubMergePort.js";
import type { PullRequestRef } from "../build/types.js";
import { isSafeRepoPath } from "../discovery/verifierOutput.js";
import { MAX_CONFLICT_ROUNDS } from "./policy.js";
import { platformRefreshIdentity } from "./refresh.js";
import { recordRoundRun, releaseToQueue, startConflictWork, stopEntry } from "./store.js";
import type { ConflictRound, MergeQueueEntry } from "./types.js";

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
export const CONFLICT_COMMIT_READS_MAX = 100;
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
export type PlatformCommitProofReader = (entry: MergeQueueEntry, shas: readonly string[]) => Promise<PlatformCommitProof | null>;

/**
 * The ONE source of the proof. Every conflict binding (the tick's `onConflict`, the queue wait, the sweep, the round end) reads it here; none passes its own.
 * It answers unread (null) until its production binding is set in one place, and nothing here sets it. Only a test sets it, through
 * `setPlatformCommitProofForTest`, which production code must never call (a test scans for that).
 */
let platformCommitProofSource: PlatformCommitProofReader | null = null;

/** The proof reader, or null while it has not been read. */
export function readPlatformCommitProof(): PlatformCommitProofReader | null {
  return platformCommitProofSource;
}

/** TEST ONLY: overrides the source (null restores "unread"). Production code never calls this. */
export function setPlatformCommitProofForTest(reader: PlatformCommitProofReader | null): void {
  platformCommitProofSource = reader;
}

const ZERO_SHA = /^0{40}$/;

/**
 * Which of the pull request's commits `prShas` the push records cover, walking `parents` (from the commit reads the decision already made) and never leaving
 * the pull request's own set. `reach(x)` is `x` and its ancestors inside the set. A record covers `reach(new)` minus `reach(old)`; one that created the
 * branch covers `reach(new)` minus `reach(start)`. A record whose `new` is outside the set, or whose non-zero `old` is (history was rewritten), covers
 * nothing. More commits than one decision reads is `unreadable`.
 */
export function coveredCommits(prShas: readonly string[], parents: ReadonlyMap<string, readonly string[]>, proof: Pick<PlatformCommitProof, "pushes">): ReadonlySet<string> | "unreadable" {
  if (prShas.length > CONFLICT_COMMIT_READS_MAX) return "unreadable";
  const inPr = new Set(prShas);
  const reach = (x: string | null): Set<string> => {
    const seen = new Set<string>();
    const todo = x !== null && inPr.has(x) ? [x] : [];
    for (let c = todo.pop(); c !== undefined; c = todo.pop()) {
      if (seen.has(c)) continue;
      seen.add(c);
      for (const p of parents.get(c) ?? []) if (inPr.has(p)) todo.push(p);
    }
    return seen;
  };
  const covered = new Set<string>();
  for (const p of proof.pushes) {
    const created = p.oldSha === null || ZERO_SHA.test(p.oldSha);
    if (!inPr.has(p.newSha) || (!created && !inPr.has(p.oldSha!))) continue;
    const below = reach(created ? p.startSha : p.oldSha);
    for (const c of reach(p.newSha)) if (!below.has(c)) covered.add(c);
  }
  return covered;
}

export type RoundStart = { ok: true; runId: string } | { ok: false; reason: string };

export interface ConflictPorts {
  github: CommitReaderPort & ConflictReaderPort & DefaultBranchReaderPort;
  inTenant<T>(accountId: string, fn: (client: PoolClient) => Promise<T>): Promise<T>;
  /** The proof for the entry's commits `shas` (see `PlatformCommitProofReader`). Null while unread: no round starts (the entry stops as it does today). */
  platformCommits(entry: MergeQueueEntry, shas: readonly string[]): Promise<PlatformCommitProof | null>;
  /** MQ8: tries a mechanical replay first. Answers whether it settled the conflict. Absent: skipped. */
  tryMechanicalReplay?(entry: MergeQueueEntry, files: readonly string[]): Promise<boolean>;
  /**
   * Starts the round's agent run, inside the start transaction: a refusal leaves no round row. `capacity_wait` and `refused_spend` have their own handling;
   * any other reason stops the entry as a conflict.
   */
  startConflictRound(args: { entry: MergeQueueEntry; round: ConflictRound }): Promise<RoundStart>;
}

type NoCode = "rounds_exhausted" | "no_conflict_files" | "foreign_commits" | "unreadable" | "identity_unread";
export type ConflictDecision = { go: true; files: readonly string[]; baseSha: string; baseRef: string } | { go: false; code: NoCode; files: readonly string[]; baseRef?: string };

const REFUSED_SPEND = "refused_spend";
export const CAPACITY_WAIT_REASONS: readonly string[] = ["capacity_wait", "waiting_for_capacity"];

/**
 * The detail table's rules (migration 0957 and 0948), in code, so a value the table would refuse is left out and never fails the stop. The same corpus, and
 * every BMP code point, runs through these and through the SQL functions (detailChecks.pg.test.ts). `[[:cntrl:]]` is read as C0, DEL and C1.
 */
const CNTRL = /[\u0000-\u001f\u007f-\u009f]/;
// Wider than the SQL `[[:space:]]` on purpose (no-break spaces too): a ref the table would take may be dropped, one it would refuse never passes.
const SPACE = /[\s\u0085\u180e]/;
const wellFormed = (s: string): boolean => Buffer.from(s, "utf8").toString("utf8") === s;

export function isDetailPath(p: unknown): p is string {
  if (typeof p !== "string" || p === "" || !wellFormed(p) || Array.from(p).length > 512 || Buffer.byteLength(p) > 1024) return false;
  if (CNTRL.test(p) || /[\u0085\u2028\u2029\\]/.test(p)) return false;
  return !/^\//.test(p) && !/^~(\/|$)/.test(p) && !/^[A-Za-z]:\//.test(p) && !/(^|\/)(\.|\.\.)?(\/|$)/.test(p);
}

export function isDetailRef(r: unknown): r is string {
  if (typeof r !== "string" || !wellFormed(r) || Buffer.byteLength(r) < 1 || Buffer.byteLength(r) > 255) return false;
  return !CNTRL.test(r) && !SPACE.test(r) && !r.includes("..") && !r.startsWith("-") && !/[~^:?*[\\]/.test(r);
}

class Undo extends Error {
  constructor(readonly refusal: string) {
    super("conflict round start undone");
  }
}

/**
 * The decision alone (no write): bound, files, authorship. A read that is cut short answers no. D#519 C8: "the PR head" is the live head when the caller read
 * one (after a refresh, the refresh tip), else the stored head, so the files are computed against the commit the executor merges from.
 */
export async function decideConflict(ports: ConflictPorts, entry: MergeQueueEntry, liveHeadSha?: string): Promise<ConflictDecision> {
  // The default branch's name is known once its tip was read; a decision that stops before any read (identity, bound) has none, and adds no read to get one.
  const no = (code: NoCode, files: readonly string[] = [], baseRef?: string): ConflictDecision => ({ go: false, code, files, ...(baseRef === undefined ? {} : { baseRef }) });
  if (entry.entryKind !== "work_item" || entry.workItemId === null) return no("unreadable");
  if (entry.conflictRounds >= MAX_CONFLICT_ROUNDS) return no("rounds_exhausted");
  // Asked before any GitHub read: with the proof unread (today, in production) a decision costs no call at all.
  if ((await ports.platformCommits(entry, [])) === null) return no("identity_unread");
  const pr: PullRequestRef = { repoId: entry.repoId, prNumber: entry.prNumber };
  const headSha = liveHeadSha ?? entry.headSha;
  const tip = await ports.github.getDefaultBranchTip(pr);
  const mine = await ports.github.compareCommits(pr, tip.sha, headSha, { files: true });
  if (mine.files === null || mine.filesTruncated) return no("unreadable", [], tip.branch);
  const theirs = await ports.github.compareCommits(pr, mine.mergeBaseSha, tip.sha, { files: true });
  if (theirs.files === null || theirs.filesTruncated) return no("unreadable", [], tip.branch);
  const main = new Set(theirs.files);
  const files = [...new Set(mine.files.filter((f) => main.has(f)))].sort();
  if (files.length === 0 || files.length > CONFLICT_FILES_MAX || !files.every(isSafeRepoPath)) return no("no_conflict_files", files, tip.branch);

  const list = await ports.github.listPullCommits(pr);
  if (list.truncated || list.commits.length > CONFLICT_COMMIT_READS_MAX) return no("unreadable", files, tip.branch);
  // Every commit is read first (the walk needs every parent); then only the commits that touch a conflict file have to be proved the platform's.
  const infos: CommitInfo[] = [];
  for (const c of list.commits) {
    const info = await ports.github.getCommit(pr, c.sha);
    if (info.files === null || info.filesTruncated) return no("unreadable", files, tip.branch);
    infos.push(info);
  }
  const shas = list.commits.map((c) => c.sha);
  const proof = await ports.platformCommits(entry, shas);
  if (proof === null) return no("identity_unread", files, tip.branch);
  const covered = coveredCommits(shas, new Map(infos.map((i) => [i.sha, i.parents])), proof);
  if (covered === "unreadable") return no("unreadable", files, tip.branch);
  const appLogin = proof.appLogin?.trim() ? proof.appLogin : null;
  const conflicting = new Set(files);
  for (const info of infos) {
    if (!info.files!.some((f) => conflicting.has(f)) || covered.has(info.sha)) continue;
    if (appLogin === null || !platformRefreshIdentity(info, appLogin).ok) return no("foreign_commits", files, tip.branch);
  }
  return { go: true, files, baseSha: tip.sha, baseRef: tip.branch };
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

/**
 * The fixed fact behind a `merge_conflict` stop: why no round ran (or how the last one ended: MQ4-c), and how many already had. Codes and counts only.
 * `eventCode` is the stop's own code (`merge_conflict` unless the end of a round stopped the entry for another fixed reason).
 */
export async function recordStop(ports: Pick<ConflictPorts, "inTenant">, entry: MergeQueueEntry, code: string, headSha: string, eventCode = "merge_conflict", detail?: { baseRef?: string | null; conflictFiles?: readonly string[] }): Promise<void> {
  if (entry.workItemId === null) return;
  // The table checks both and a bad value fails the write, and the event with it; each value is held to the table's rules here, and one that fails is left out.
  const baseRef = isDetailRef(detail?.baseRef) ? detail!.baseRef! : null;
  const conflictFiles = (detail?.conflictFiles ?? []).filter(isDetailPath).slice(0, CONFLICT_FILES_MAX);
  await ports.inTenant(entry.accountId, (c) =>
    recordDriverEvent(c, entry.accountId, {
      workItemId: entry.workItemId!,
      kind: "stopped",
      dedupeKey: `conflict:${headSha}:${entry.conflictRounds}:${code}`,
      code: eventCode,
      reasons: [code],
      headSha,
      prNumber: entry.prNumber,
      round: entry.conflictRounds,
      detail: { conflictFiles, baseRef },
    }),
  );
}
