import { isDetailPath } from "@fulcrumaxe/runner-protocol";
import type { CommitComparison, CommitInfo } from "../build/githubMergePort.js";
import type { PullRequestMergeability } from "../build/mergeGate.js";
import type { PullRequestRef } from "../build/types.js";
import type { PlatformCommitProof } from "./conflict.js";
import type { ConflictCompletionPorts, RunnerFedPort } from "./conflictComplete.js";
import type { ConflictRound } from "./types.js";

/**
 * D#519 MQ4-e2-c2 (C18, C19, C20): the end of a `runner_local` conflict round, read the way a hosted one is, from the fence plus the run's stored attestation.
 *
 * One adapter implements the same `github` port the judge already uses, so `judgeConflictRound` keeps every rule. Where the repository cannot be read (a commit's parents, a history
 * compare, a merge commit's file list, whether it conflicts again) the answer is the runner's attested one; where the fence can answer (the pull request's state and head, the
 * default branch tip, the pull request's own files) the fence does, and the attestation is only ever compared with it. Anything missing, malformed or out of the closed set
 * reads as the hosted rule's closed result for the same fact, never as a pass.
 */
export interface RoundAttestation {
  head: string;
  parents: readonly string[];
  from_sha: string;
  base_sha: string;
  history: "descendant" | "not";
  pushed_by_round: boolean;
  second_parent_on_default: boolean;
  still_conflicting: "yes" | "no" | "unknown";
  touched_paths: readonly string[];
  truncated: boolean;
}

const SHA = /^[0-9a-f]{40}$/;
const KEYS = ["head", "parents", "from_sha", "base_sha", "history", "pushed_by_round", "second_parent_on_default", "still_conflicting", "touched_paths", "truncated"];
export const ATTEST_MAX_PATHS = 100;

/** The stored event's payload as the closed shape, or null for anything else (an extra key, a wrong type, a value outside the closed sets). */
export function parseAttestation(raw: unknown): RoundAttestation | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== KEYS.length || !KEYS.every((k) => keys.includes(k))) return null;
  const sha = (v: unknown): v is string => typeof v === "string" && SHA.test(v);
  if (!sha(o.head) || !sha(o.from_sha) || !sha(o.base_sha)) return null;
  if (!Array.isArray(o.parents) || o.parents.length < 1 || o.parents.length > 2 || !o.parents.every(sha)) return null;
  if (o.history !== "descendant" && o.history !== "not") return null;
  if (typeof o.pushed_by_round !== "boolean" || typeof o.second_parent_on_default !== "boolean" || typeof o.truncated !== "boolean") return null;
  if (o.still_conflicting !== "yes" && o.still_conflicting !== "no" && o.still_conflicting !== "unknown") return null;
  const paths = o.touched_paths;
  if (!Array.isArray(paths) || paths.length > ATTEST_MAX_PATHS || new Set(paths).size !== paths.length || !paths.every((p) => typeof p === "string" && isDetailPath(p))) return null;
  return o as unknown as RoundAttestation;
}

/** The reads the fence answers for a `runner_local` repository (A3, `RunBranchState`, `PullRequestFiles`); the cloud makes no other read of the code repository. */
export interface RoundFence {
  getMergeability(pr: PullRequestRef, opts?: { gatedHeadSha?: string }): Promise<PullRequestMergeability>;
  defaultBranchTip(pr: PullRequestRef): Promise<{ branch: string; sha: string }>;
  /** The pull request's own file paths, or null when the list is cut short. */
  prFiles(pr: PullRequestRef): Promise<readonly string[] | null>;
}

export interface RoundGitHub {
  github: ConflictCompletionPorts["github"];
  runnerFed: RunnerFedPort;
  /** The judge's push proof (C20-1): a push record of the round's own run from the signed anchor to the live head, or an empty proof. */
  platformCommits(entry: unknown, shas: readonly string[]): Promise<PlatformCommitProof | null>;
}

/**
 * `round`: the cloud's own row (its `from_sha`, `base_sha` and run id are the signed anchors, which the `done` route already matched to the attestation). `stored`: the run's first
 * `conflict.attestation` event payload, or null when there is none.
 */
export function createRoundGitHub(fence: RoundFence, round: ConflictRound | undefined, stored: unknown, unreachable?: () => Promise<boolean>): RoundGitHub {
  const a = round === undefined ? null : parseAttestation(stored);
  // The anchors in the attestation are the signed ones echoed back; a row that disagrees makes the whole attestation unreadable.
  const att = a !== null && round !== undefined && a.from_sha === round.fromSha && a.base_sha === round.baseSha ? a : null;
  const none: CommitComparison = { status: "diverged", aheadBy: 0, behindBy: 0, mergeBaseSha: "", files: null, filesTruncated: false };

  return {
    runnerFed: {
      async read(liveHead) {
        if (att === null) return "unreadable";
        return att.head === liveHead ? "ok" : "head_changed";
      },
      // C18-3 (c3): the web wiring's read of whether any runner could ever take the run; absent in a test that does not care.
      ...(unreachable ? { unreachable } : {}),
    },
    github: {
      async getMergeability(pr, opts) {
        const m = await fence.getMergeability(pr, opts);
        // Whether the head conflicts again comes from the attestation, and only for the head it was computed on; otherwise it is the hosted "unknown", which waits.
        if (m.state !== "open" || m.merged || att === null || att.head !== m.headSha || att.still_conflicting === "unknown") return { ...m, mergeable: null, mergeableState: "unknown" };
        return att.still_conflicting === "yes" ? { ...m, mergeable: false, mergeableState: "dirty" } : { ...m, mergeable: true, mergeableState: "clean" };
      },
      async getCommit(_pr, sha): Promise<CommitInfo> {
        const base = { sha, authorLogin: null, committerLogin: null, verified: false, verificationReason: null };
        // A commit other than the attested head has no parents here, so the shape check fails closed.
        if (att === null || att.head !== sha) return { ...base, parents: [], files: null, filesTruncated: true };
        // `truncated` or no path at all is never a pass: the file list is then unknown (the judge reads null as invalid_input).
        const known = !att.truncated && att.touched_paths.length > 0;
        return { ...base, parents: att.parents, files: known ? att.touched_paths : null, filesTruncated: !known };
      },
      async compareCommits(_pr, base, head): Promise<CommitComparison> {
        if (att === null || round === undefined) return none;
        // History: the head descends from the signed start, as the runner computed it against that anchor. The live head must be the attested one. The shape (exactly two parents) is the next check.
        if (base === round.fromSha) return att.head === head && att.history === "descendant" ? { ...none, status: "ahead", aheadBy: 1 } : none;
        // Second parent on the default branch: `head` is the default tip the fence just read. Equality only, with the row's base or that tip (stricter than the hosted ancestry rule).
        const second = att.parents.length === 2 ? att.parents[1] : undefined;
        if (second !== undefined && base === second && att.second_parent_on_default && (second === round.baseSha || second === head)) return { ...none, status: second === head ? "identical" : "ahead", aheadBy: second === head ? 0 : 1, mergeBaseSha: second };
        return none;
      },
      async getDefaultBranchTip(pr) {
        return fence.defaultBranchTip(pr);
      },
      async compareToBase(pr) {
        const files = await fence.prFiles(pr);
        return { status: "ahead", aheadBy: 0, behindBy: 0, files, filesTruncated: files === null };
      },
    } as ConflictCompletionPorts["github"],
    async platformCommits(_entry, shas) {
      const head = shas[0];
      // C20-1: the attested push record, pinned at both ends by cloud-held values. (b) it starts at the signed anchor; (c) it ends at the live head the cloud read itself; (d) that head
      // has exactly the attested two parents, the first the anchor and the second the row's base. Any miss is the empty proof, which the judge reads as "not the round's own commit".
      const ok =
        att !== null &&
        round !== undefined &&
        round.runId !== null &&
        shas.length === 1 &&
        head === att.head &&
        att.pushed_by_round &&
        att.parents.length === 2 &&
        att.parents[0] === round.fromSha &&
        att.from_sha === round.fromSha;
      return { appLogin: null, pushes: ok ? [{ oldSha: round!.fromSha, newSha: att.head, startSha: null, runId: round!.runId! }] : [] };
    },
  };
}
