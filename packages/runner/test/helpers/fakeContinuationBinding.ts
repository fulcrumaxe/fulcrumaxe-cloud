import type { BoundPullRequestView, ContinuationBindingPort } from "../../src/targets/jobIssuer.js";

/** One pull request as GitHub's pulls list returns it, down to the fields the binding reads. */
export interface FakePull {
  number: number;
  state: "open" | "closed";
  /** `head.repo.id`; null models a deleted fork. */
  headRepoId: number | null;
  baseRepoId: number;
  /** `head.ref`. */
  headRef: string;
  /** The owner of the head repository: GitHub's `head=<owner>:<ref>` filter matches on it, so a fork under the same owner is listed too. */
  headOwner: string;
}

export interface FakeBindingState {
  /** The repository's `default_branch` (A2). */
  defaultBranch: string | null;
  pulls: FakePull[];
  /** The status of the protection read per branch (A8). GitHub answers 404 for a branch with no protection, never 200 with an empty body; unlisted branches are 404. */
  protection: Record<string, number>;
  /** Statuses for the list call, when GitHub cannot answer (anything but 200). */
  listStatus: number;
  /** Throw from the named call, as a dropped connection would. */
  throwOn?: "list" | "default" | "protection";
  /** Return every pull request whatever the head filter says: the issuer must not rely on the filter alone. */
  ignoreHeadFilter?: boolean;
}

/**
 * A fake of the three GitHub reads behind the binding, with the behaviour the issuer depends on and nothing it does not:
 *  - the list applies GitHub's `head=<owner>:<ref>` filter and returns every state it is asked for (`state=all`), so a closed pull request and a
 *    fork's pull request under the same owner come back, as they do on GitHub;
 *  - the protection read is 404 for an unprotected branch and 200 for a protected one, and any other status the test sets;
 *  - every call is recorded, so a test can show which reads happened (a refusal before GitHub is asked makes none).
 * What it cannot model: a branch covered only by a repository ruleset (A8 does not see it; recorded as an accepted gap in the PL-2b Spec), and real TLS
 * (the live port goes through the installation client, which the apps/web tests exercise).
 */
export function createFakeContinuationBinding(initial: Partial<FakeBindingState> = {}): ContinuationBindingPort & { state: FakeBindingState; calls: string[] } {
  const state: FakeBindingState = { defaultBranch: "main", pulls: [], protection: {}, listStatus: 200, ...initial };
  const calls: string[] = [];
  return {
    state,
    calls,
    async pullRequestsByHead({ repo, branch }) {
      calls.push(`list ${repo.owner}:${branch}`);
      if (state.throwOn === "list") throw new Error("socket hang up");
      if (state.listStatus !== 200) return { status: state.listStatus };
      const pulls: BoundPullRequestView[] = state.pulls
        .filter((p) => state.ignoreHeadFilter === true || (p.headOwner === repo.owner && p.headRef === branch))
        .map((p) => ({ number: p.number, state: p.state, headRepoId: p.headRepoId, baseRepoId: p.baseRepoId, headRef: p.headRef }));
      return { status: 200, pulls };
    },
    async defaultBranch() {
      calls.push("default_branch");
      if (state.throwOn === "default") throw new Error("socket hang up");
      return state.defaultBranch;
    },
    async branchProtection({ branch }) {
      calls.push(`protection ${branch}`);
      if (state.throwOn === "protection") throw new Error("socket hang up");
      return { status: state.protection[branch] ?? 404 };
    },
  };
}
