import type { InstallationHttp, InstallationHttpKind, InstallationHttpTarget } from "./installationHttp.js";

/**
 * FIXROUND-BASE-SYNC: brings a private pull request's branch up to date with its base branch, with one synchronous GitHub call.
 *
 * The pull request is read for its base branch (`GET /pulls/<n>`), that branch's tip is read (`GET /git/ref/heads/<base>`), and the tip is merged into the pull
 * request's branch (`POST /merges`, `head` = that commit id, so the merge is of exactly the commit read). GitHub answers:
 *   201  a merge commit was made. Its parents are returned as GitHub gave them; the caller checks them against the head it expected.
 *   204  the branch already contains the base: nothing was written.
 *   409  the two conflict: nothing was written.
 * Anything else (a status, a body of the wrong shape, a pull request that is closed or not on this branch, a transport failure) THROWS a fixed-message error: the
 * caller never reads it as "up to date". No text from GitHub reaches the message.
 */
export type BranchSyncOutcome =
  | { kind: "up_to_date"; baseSha: string }
  | { kind: "merged"; sha: string; parents: readonly string[]; baseSha: string; baseRef: string }
  | { kind: "conflict"; baseSha: string; baseRef: string };

export interface BranchSyncPort {
  /** `branch` must be one of the two shapes the platform pushes; the client refuses any other. */
  sync(input: { repo: { id: string; owner: string; name: string }; branch: string; prNumber: number }): Promise<BranchSyncOutcome>;
}

export class BranchSyncError extends Error {
  constructor(readonly reason: string) {
    super(`branchSync: ${reason}`);
    this.name = "BranchSyncError";
  }
}

const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){0,5}$/;
/** Fixed text: no item content in a commit message. */
const message = (branch: string, base: string): string => `Bring ${branch} up to date with ${base}`;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const dig = (v: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((at, k) => (isObj(at) ? at[k] : undefined), v);
const segment = (s: string): string => s.split("/").map(encodeURIComponent).join("/");

export function createBranchSyncPort(open: (kind: InstallationHttpKind, target: InstallationHttpTarget) => Promise<InstallationHttp>): BranchSyncPort {
  return {
    async sync({ repo, branch, prNumber }) {
      const http = await open("branch_sync", { repoId: repo.id, owner: repo.owner, name: repo.name, branch, prNumber });
      try {
        const root = `/repos/${repo.owner}/${repo.name}`;
        const pull = await http.request({ method: "GET", path: `${root}/pulls/${prNumber}` });
        const baseRef = dig(pull.body, "base", "ref");
        if (pull.status !== 200 || dig(pull.body, "state") !== "open" || dig(pull.body, "head", "ref") !== branch || typeof baseRef !== "string" || !BRANCH.test(baseRef) || baseRef === branch) throw new BranchSyncError("pull_request_unreadable");
        // The head must be in this repository: a fork's branch of the same name is not the branch being brought up to date.
        const headRepo = dig(pull.body, "head", "repo", "id");
        if (typeof headRepo !== "number" || headRepo !== dig(pull.body, "base", "repo", "id")) throw new BranchSyncError("pull_request_unreadable");
        const ref = await http.request({ method: "GET", path: `${root}/git/ref/heads/${segment(baseRef)}` });
        const baseSha = dig(ref.body, "object", "sha");
        if (ref.status !== 200 || typeof baseSha !== "string" || !SHA.test(baseSha)) throw new BranchSyncError("base_unreadable");
        const merged = await http.request({ method: "POST", path: `${root}/merges`, body: { base: branch, head: baseSha, commit_message: message(branch, baseRef) } });
        if (merged.status === 204) return { kind: "up_to_date", baseSha };
        if (merged.status === 409) return { kind: "conflict", baseSha, baseRef };
        const sha = dig(merged.body, "sha");
        const parents = dig(merged.body, "parents");
        if (merged.status !== 201 || typeof sha !== "string" || !SHA.test(sha) || !Array.isArray(parents) || parents.length === 0 || parents.length > 2) throw new BranchSyncError("merge_refused");
        const shas = parents.map((p) => dig(p, "sha"));
        if (!shas.every((p): p is string => typeof p === "string" && SHA.test(p))) throw new BranchSyncError("merge_refused");
        return { kind: "merged", sha, parents: shas, baseSha, baseRef };
      } finally {
        await http.close?.();
      }
    },
  };
}
