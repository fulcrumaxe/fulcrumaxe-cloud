import type { BuildPr, BuildState, BuildStatePort, GitPort, GitResult, LedgerPort, PullRequestRef, RebuildPort, RetractionPort } from "../src/ports.js";

/** Test fakes for the reversal ports (D#7 DP7-2b). Each one rejects a call its real counterpart would reject; the shapes are listed in fakes.test.ts. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40}$/;

function uuid(label: string, value: string): void {
  if (!UUID.test(value)) throw new TypeError(`${label} is not a UUID`);
}
function pullRequest(ref: PullRequestRef): void {
  if (!REPO.test(ref.repo)) throw new TypeError("repo is not owner/name");
  if (!Number.isInteger(ref.number) || ref.number <= 0) throw new TypeError("pull request number is not a positive integer");
}

/** A ledger that holds per-item spend. Rejects a malformed id, an unknown account/item pair, and a stored amount that is negative or not finite. */
export function fakeLedger(spend: Record<string, number> = {}): LedgerPort & { reads: Array<[string, string]> } {
  const reads: Array<[string, string]> = [];
  return {
    reads,
    async workItemBuildSpendUsd(accountId, workItemId) {
      uuid("accountId", accountId);
      uuid("workItemId", workItemId);
      reads.push([accountId, workItemId]);
      const usd = spend[`${accountId}:${workItemId}`];
      if (usd === undefined) return 0;
      if (!Number.isFinite(usd) || usd < 0) throw new RangeError("ledger holds an invalid amount");
      return usd;
    },
  };
}

/** A build-state reader. Rejects a malformed id, an item it does not know, and a state whose pull request does not match its stage. */
export function fakeBuildState(items: Record<string, BuildState>): BuildStatePort {
  return {
    async stateOf(accountId, workItemId) {
      uuid("accountId", accountId);
      uuid("workItemId", workItemId);
      const s = items[`${accountId}:${workItemId}`];
      if (!s) throw new Error("work item not found for this account");
      const hasPr = s.pr !== null;
      if ((s.stage === "built" || s.stage === "merged") && !hasPr) throw new Error("a built item must carry its pull request");
      if (s.stage === "not_started" && hasPr) throw new Error("an item that has not started has no pull request");
      return s;
    },
  };
}

export interface FakeGitState {
  /** Open pull requests by `repo#number`, with the head sha recorded for each. */
  open: Record<string, BuildPr["headSha"]>;
  /** Merged pull requests by `repo#number`. */
  merged: string[];
  /** Pull requests the fake's GitHub would refuse to revert (a conflict). */
  conflicts?: string[];
  /** Pull requests whose public branch a person took over: left whole, never closed. */
  personManaged?: string[];
}

/** A GitPort. Records every write; never deletes a branch (there is no such method); refuses what GitHub would. */
export function fakeGit(state: FakeGitState): GitPort & { writes: string[] } {
  const writes: string[] = [];
  const key = (r: PullRequestRef) => `${r.repo}#${r.number}`;
  return {
    writes,
    async rerunAfterBuild(input): Promise<GitResult<{ closed: true }>> {
      pullRequest(input);
      if (!SHA.test(input.headSha)) throw new TypeError("headSha is not a 40 character sha");
      if (state.personManaged?.includes(key(input))) return { ok: false, code: "person_managed" };
      const head = state.open[key(input)];
      if (head === undefined) return { ok: false, code: "not_open" };
      if (head !== input.headSha) return { ok: false, code: "stale_head" };
      delete state.open[key(input)];
      writes.push(`close ${key(input)}`);
      return { ok: true, closed: true };
    },
    async openRevertPr(input): Promise<GitResult<{ number: number }>> {
      pullRequest(input);
      if (!state.merged.includes(key(input))) return { ok: false, code: "not_merged" };
      if (state.conflicts?.includes(key(input))) return { ok: false, code: "revert_refused" };
      writes.push(`revert ${key(input)}`);
      return { ok: true, number: 9000 + input.number };
    },
  };
}

/**
 * A RebuildPort. Like the real one it files Build again only for an owner or admin of the account, only while nothing of the item is running, and only
 * from a stage the move to Needs a person is legal from (or from Needs a person itself); it rejects a malformed id. Records every filing.
 */
export function fakeRebuild(world: { roles: Record<string, string>; stage: string; live?: boolean }): RebuildPort & { filed: Array<{ workItemId: string; userId: string }> } {
  const filed: Array<{ workItemId: string; userId: string }> = [];
  return {
    filed,
    async buildAgain(input) {
      uuid("accountId", input.accountId);
      uuid("workItemId", input.workItemId);
      uuid("userId", input.userId);
      const role = world.roles[`${input.accountId}:${input.userId}`];
      if (role !== "owner" && role !== "admin") return { ok: false, code: "refused" };
      if (world.live === true) return { ok: false, code: "refused" };
      if (!["pr_opened", "changes_requested", "review_passed", "needs_human"].includes(world.stage)) return { ok: false, code: "state_changed" };
      world.stage = "needs_human";
      filed.push({ workItemId: input.workItemId, userId: input.userId });
      return { ok: true, runActionId: `00000000-0000-4000-8000-${String(filed.length).padStart(12, "0")}` };
    },
  };
}

/** A RetractionPort that works: the stand-in for the DP7b adapter. Rejects an empty ref and a surface that is not one of the two. */
export function fakeRetraction(): RetractionPort & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    async retractDeprecationNotice(input) {
      if (input.surface !== "release" && input.surface !== "discussion") throw new TypeError("unknown surface");
      if (input.ref.length === 0) throw new TypeError("ref is empty");
      writes.push(`${input.surface}:${input.ref}`);
      return { ok: true, retracted: true };
    },
  };
}
