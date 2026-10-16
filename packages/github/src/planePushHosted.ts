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
  mintToken(codeRepo: string): Promise<{ token: string; expiresAt: Date }>;
  /** The branch's head sha on the public repo, or null when there is no such branch. */
  branchHead(input: { codeRepo: string; branch: string }): Promise<string | null>;
  /**
   * True only when the branch's head is exactly `headSha`, that commit has exactly one parent, the parent is `tipSha`, and `tipSha` is in
   * public `main`'s history. Anything GitHub cannot answer is a throw (the caller treats it as "unavailable", never as "mismatch").
   */
  verifyPushed(input: { codeRepo: string; branch: string; headSha: string; tipSha: string }): Promise<boolean>;
  /**
   * The pull request's address when pull request `number` is OPEN, has head ref `branch` in the paired repo itself (not a fork) and base `main`, and its
   * address is `https://github.com/<code_repo>/pull/<number>`; null otherwise.
   */
  verifyPullRequest(input: { codeRepo: string; branch: string; number: number }): Promise<{ url: string } | null>;
  /** Revokes a token `mintToken` handed out and the caller could not use. True when it is gone; never throws. */
  revokeToken(token: string): Promise<boolean>;
}

export function createHostedPlanePush(api: PlanePushApi, deps: { now?: () => number } = {}): HostedPlanePush {
  const now = deps.now ?? Date.now;

  async function withFreshToken<T>(codeRepo: string, use: (token: string) => Promise<T>): Promise<T> {
    const token = await api.mintPushToken(codeRepo);
    try {
      return await use(token);
    } finally {
      await api.revokeToken(token);
    }
  }

  return {
    async mintToken(codeRepo) {
      let githubExpiry: number | undefined;
      const token = await api.mintPushToken(codeRepo, { onExpiry: (ms) => (githubExpiry = ms) });
      const cap = now() + PLANE_PUSH_TOKEN_MAX_LIFETIME_MS;
      return { token, expiresAt: new Date(githubExpiry === undefined ? cap : Math.min(githubExpiry - EXPIRY_MARGIN_MS, cap)) };
    },

    revokeToken: (token) => api.revokeToken(token),

    branchHead: ({ codeRepo, branch }) => withFreshToken(codeRepo, (token) => api.branchHead({ codeRepo, branch, token })),

    verifyPushed: ({ codeRepo, branch, headSha, tipSha }) =>
      withFreshToken(codeRepo, async (token) => {
        if ((await api.branchHead({ codeRepo, branch, token })) !== headSha) return false;
        const parents = await api.commitParents({ codeRepo, sha: headSha, token });
        if (!parents || parents.length !== 1 || parents[0] !== tipSha) return false;
        return api.inMainHistory({ codeRepo, sha: tipSha, token });
      }),

    verifyPullRequest: ({ codeRepo, branch, number }) =>
      withFreshToken(codeRepo, async (token) => {
        const pr = await api.pullRequest({ codeRepo, number, token });
        if (!pr || pr.state !== "open" || pr.headRef !== branch || pr.headRepo.toLowerCase() !== codeRepo.toLowerCase() || pr.baseRef !== "main") return null;
        const expected = `https://github.com/${codeRepo}/pull/${number}`;
        return pr.url.toLowerCase() === expected.toLowerCase() ? { url: pr.url } : null;
      }),
  };
}
