import { retryTransientRead } from "@fx/core/src/github/transientRead.js";
import { createPlanePushApi } from "./planePushApi.js";

/**
 * D#598 P1f-2: the hosted side's GitHub reads about a paired PUBLIC repo, for the runner routes.
 *
 * Every call here mints its own restricted `plane_push` token, uses it for that one operation and revokes it in a `finally` (the token
 * never leaves this module, is never cached and is never stored). The one exception is `mintToken`, whose whole job is to hand a fresh
 * token to a runner; the hosted side cannot revoke that one (it does not keep it), and it lapses at GitHub's own expiry.
 *
 * `branchHead` is the adapter the record module's `BranchHeadPort` asks for: `createPlanePushApi().branchHead` takes a token, this one
 * mints and revokes it around the read.
 */

export type PlanePushApi = ReturnType<typeof createPlanePushApi>;

/** GitHub's installation tokens last an hour; the runner is told 55 minutes at most, so it never plans on the last five. */
export const PLANE_PUSH_TOKEN_MAX_LIFETIME_MS = 55 * 60 * 1000;
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export interface HostedPlanePush {
  /** A fresh token for one repo, and the time the runner may rely on it until: the smaller of GitHub's expiry minus 5 minutes and 55 minutes from now. */
  mintToken(codeRepo: string, accountId: string): Promise<{ token: string; expiresAt: Date }>;
  /**
   * D#6 PUBLIC-MERGE PR2b: a fresh credential for one merge order on the paired public repository, and the time the runner may rely on it until (as `mintToken`).
   * `read` holds `contents: read` only; `write` holds `contents: write` only (the `plane_merge` purpose) and is minted once per order. Neither is cached or stored.
   */
  mintMergeToken(codeRepo: string, accountId: string, kind: "read" | "write"): Promise<{ token: string; expiresAt: Date }>;
  /** The branch's head sha on the public repo, or null when there is no such branch. */
  branchHead(input: { accountId: string; codeRepo: string; branch: string }): Promise<string | null>;
  /**
   * True only when the branch's head is exactly `headSha`, that commit has exactly one parent, the parent is `tipSha`, and `tipSha` is in
   * public `main`'s history. Anything GitHub cannot answer is a throw (the caller treats it as "unavailable", never as "mismatch").
   */
  verifyPushed(input: { accountId: string; codeRepo: string; branch: string; headSha: string; tipSha: string }): Promise<boolean>;
  /**
   * The pull request's address when pull request `number` is OPEN, has head ref `branch` in the paired repo itself (not a fork) and base `main`, and its
   * address is `https://github.com/<code_repo>/pull/<number>`; null otherwise.
   */
  verifyPullRequest(input: { accountId: string; codeRepo: string; branch: string; number: number }): Promise<{ url: string } | null>;
  /**
   * D#6 PLANE-PUSH-REVERIFY-BOUND: the ONE open pull request of `branch`, when it is exactly the push that was recorded: the only open pull request with that head, in the paired repository itself (not a
   * fork), head ref `branch`, head sha `headSha`, base `main`, and an address in the paired repository. Anything else (none, two, a fork, another base or head) is null. One read of the list.
   */
  findOpenPullRequest(input: { accountId: string; codeRepo: string; branch: string; headSha: string }): Promise<{ number: number; url: string } | null>;
  /** D#6 REPUBLISH-CLOSED-PR: the pull request's live state (`unknown` for no such pull request); an unreadable answer throws. Sibling of `verifyPullRequest`, which keeps returning null for everything but an open match. */
  pullRequestState(input: { accountId: string; codeRepo: string; number: number }): Promise<"open" | "closed" | "merged" | "unknown">;
  /** D#6 STACK-THREE-DEEP: a public pull request's state, merge bit, base branch and the repository's default branch; null for no such pull request. An unreadable answer throws. */
  pullRequestBase(input: { accountId: string; codeRepo: string; number: number }): Promise<{ state: "open" | "closed"; merged: boolean; baseRef: string; defaultBranch: string } | null>;
  /**
   * D#598 P1f-5c: opens the pull request on a branch the platform already pushed (base `main`), with a fresh token revoked before this returns. Nothing is pushed. A refusal throws a
   * `PlanePushApiError` (`pr_failed`, or `public_unavailable` when GitHub could not be reached).
   */
  openPullRequest(input: { accountId: string; codeRepo: string; branch: string; title: string; body: string }): Promise<{ number: number; url: string }>;
  /**
   * Closes a public pull request the cloud refused after it was published, and leaves one plain comment (a fresh token revoked before this returns). A pull request that is not open is left as it is
   * (`not_open`), and so is one whose head is not the recorded branch of the paired repository (`not_ours`). The branch is never touched. An unreadable answer throws a `PlanePushApiError`.
   */
  closeRefusedPullRequest(input: { accountId: string; codeRepo: string; number: number; branch: string; comment: string }): Promise<{ result: "closed"; commented: boolean } | { result: "not_open" } | { result: "not_ours" }>;
  /** Revokes a token `mintToken` handed out and the caller could not use. True when it is gone; never throws. */
  revokeToken(token: string): Promise<boolean>;
}

export function createHostedPlanePush(api: PlanePushApi, deps: { now?: () => number; ownsInstallation: (accountId: string, ghInstallationId: number) => Promise<boolean> }): HostedPlanePush {
  const now = deps.now ?? Date.now;
  const ownedBy = (accountId: string) => (ghInstallationId: number) => deps.ownsInstallation(accountId, ghInstallationId);

  async function withFreshToken<T>(accountId: string, codeRepo: string, use: (token: string) => Promise<T>): Promise<T> {
    const token = await api.mintPushToken(codeRepo, { ownsInstallation: ownedBy(accountId) });
    try {
      return await use(token);
    } finally {
      await api.revokeToken(token);
    }
  }

  return {
    async mintToken(codeRepo, accountId) {
      let githubExpiry: number | undefined;
      const token = await api.mintPushToken(codeRepo, { ownsInstallation: ownedBy(accountId), onExpiry: (ms) => (githubExpiry = ms) });
      const cap = now() + PLANE_PUSH_TOKEN_MAX_LIFETIME_MS;
      return { token, expiresAt: new Date(githubExpiry === undefined ? cap : Math.min(githubExpiry - EXPIRY_MARGIN_MS, cap)) };
    },

    async mintMergeToken(codeRepo, accountId, kind) {
      let githubExpiry: number | undefined;
      const token = await api.mintMergeToken(codeRepo, kind, { ownsInstallation: ownedBy(accountId), onExpiry: (ms) => (githubExpiry = ms) });
      const cap = now() + PLANE_PUSH_TOKEN_MAX_LIFETIME_MS;
      return { token, expiresAt: new Date(githubExpiry === undefined ? cap : Math.min(githubExpiry - EXPIRY_MARGIN_MS, cap)) };
    },

    revokeToken: (token) => api.revokeToken(token),

    branchHead: ({ accountId, codeRepo, branch }) => withFreshToken(accountId, codeRepo, (token) => api.branchHead({ codeRepo, branch, token })),

    openPullRequest: ({ accountId, codeRepo, branch, title, body }) => withFreshToken(accountId, codeRepo, (token) => api.openPullRequest({ codeRepo, branch, base: "main", title, body, token })),

    verifyPushed: ({ accountId, codeRepo, branch, headSha, tipSha }) =>
      withFreshToken(accountId, codeRepo, async (token) => {
        if ((await api.branchHead({ codeRepo, branch, token })) !== headSha) return false;
        const parents = await api.commitParents({ codeRepo, sha: headSha, token });
        if (!parents || parents.length !== 1 || parents[0] !== tipSha) return false;
        return api.inMainHistory({ codeRepo, sha: tipSha, token });
      }),

    pullRequestState: ({ accountId, codeRepo, number }) => withFreshToken(accountId, codeRepo, (token) => retryTransientRead(() => api.pullRequestState({ codeRepo, number, token }))),

    pullRequestBase: ({ accountId, codeRepo, number }) => withFreshToken(accountId, codeRepo, (token) => api.pullRequestBase({ codeRepo, number, token })),

    closeRefusedPullRequest: ({ accountId, codeRepo, number, branch, comment }) => withFreshToken(accountId, codeRepo, (token) => api.closeRefusedPullRequest({ codeRepo, number, branch, token, comment })),

    findOpenPullRequest: ({ accountId, codeRepo, branch, headSha }) =>
      withFreshToken(accountId, codeRepo, async (token) => {
        const found = await api.openPullRequestsForBranch({ codeRepo, branch, token });
        if (found.length !== 1) return null;
        const pr = found[0]!;
        if (pr.headRef !== branch || pr.headRepo.toLowerCase() !== codeRepo.toLowerCase() || pr.baseRef !== "main" || pr.headSha !== headSha) return null;
        return pr.url.toLowerCase() === `https://github.com/${codeRepo}/pull/${pr.number}`.toLowerCase() ? { number: pr.number, url: pr.url } : null;
      }),

    verifyPullRequest: ({ accountId, codeRepo, branch, number }) =>
      withFreshToken(accountId, codeRepo, async (token) => {
        const pr = await api.pullRequest({ codeRepo, number, token });
        if (!pr || pr.state !== "open" || pr.headRef !== branch || pr.headRepo.toLowerCase() !== codeRepo.toLowerCase() || pr.baseRef !== "main") return null;
        const expected = `https://github.com/${codeRepo}/pull/${number}`;
        return pr.url.toLowerCase() === expected.toLowerCase() ? { url: pr.url } : null;
      }),
  };
}
