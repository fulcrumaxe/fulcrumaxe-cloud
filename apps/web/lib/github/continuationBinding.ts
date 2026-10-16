import type { Pool } from "pg";
import { platformOpsPool } from "@fx/api/src/sse/pools.js";
import { withPlatformOps } from "@fx/core/src/tenancy/withPlatformOps.js";
import type { BindingRepo, BoundPullRequestView, ContinuationBindingPort } from "@fx/runner";
import type { InstallationHttp, InstallationHttpKind, InstallationHttpTarget } from "@fx/github";
import { fenceInstallationHttp } from "./localOnlyHttp";
import { openInstallationHttp } from "./installationHttp";

/**
 * D#599 PL-2b-2 (TL ruling R-599-PL2b-1-c): the live GitHub side of `ContinuationBindingPort`, the reads that bind a cross-side continuation on the item's
 * own pull request branch (`fx/issue-<n>`). The job issuer decides; this file only asks GitHub three things and reduces the answers to structured values.
 *
 *  - the pull requests of THIS repository whose head is the branch (`GET pulls?head=<owner>:<branch>&state=all`, allowlist A3). The listing is for this
 *    repository only; its pull requests' own `head.repo.id` is compared by the issuer against OUR stored GitHub repository id (`repos.gh_repo_id`), which is
 *    what this file reports as `baseRepoId`. Nothing GitHub says about the base repository is believed: a fork's pull request that names this repository as
 *    its base still has a different head repository id, and a head repository that was deleted reads as null and never matches.
 *  - the repository's `default_branch` (`GET repos/{o}/{r}`, A2);
 *  - the branch's protection (`GET repos/{o}/{r}/branches/{branch}/protection`, A8): 200 protected, 404 not, anything else "cannot tell".
 *
 * A run on a `runner_local` repository is read only through the local-only fence (`fenceInstallationHttp`), exactly as the merge gate is: a call the allowlist
 * does not hold is refused before a request is made, and the issuer reads the refusal as "cannot tell" (retryable, nothing recorded). A cloud-verified run's
 * repository is read through the same installation client without the fence, as the cloud already holds that code.
 *
 * Only structured values leave this file: numbers, states and ref names. A title, body, label or comment of a pull request is never selected.
 */
type Open = (kind: InstallationHttpKind, target: InstallationHttpTarget) => Promise<InstallationHttp>;

const isObj = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** A branch name as the issuer passes it: plain ref characters only (the shared item and run branch patterns), so the encoded path below is exact. */
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export interface ContinuationBindingDeps {
  open?: Open;
  /** Our stored GitHub repository id for `repos.id`, or null when there is none. Tests inject it. */
  storedGhRepoId?: (repoId: string) => Promise<number | null>;
  pool?: () => Pool;
}

export function createAppContinuationBinding(deps: ContinuationBindingDeps = {}): ContinuationBindingPort {
  const open = deps.open ?? openInstallationHttp;
  const pool = deps.pool ?? platformOpsPool;
  const storedGhRepoId =
    deps.storedGhRepoId ??
    (async (repoId: string): Promise<number | null> => {
      const rows = await withPlatformOps(pool(), async (client) => {
        const { rows } = await client.query<{ gh_repo_id: string | number | null }>("SELECT gh_repo_id FROM repos WHERE id = $1", [repoId]);
        return rows;
      });
      const id = Number(rows[0]?.gh_repo_id);
      return Number.isSafeInteger(id) && id > 0 ? id : null;
    });

  const client = async (repo: BindingRepo): Promise<Pick<InstallationHttp, "request">> => {
    const target = { repoId: repo.id, owner: repo.owner, name: repo.name };
    // `merge_gate` is the kind that holds the permissions the protection read needs; every call below is a GET of an allowlisted path.
    // Only an explicit `local: false` (a cloud-verified run) is read unfenced; anything else, an absent flag included, takes the fence.
    return repo.local === false ? open("merge_gate", target) : fenceInstallationHttp(await open("merge_gate", { ...target, allowGraphql: true }));
  };

  return {
    async pullRequestsByHead({ repo, branch }) {
      if (!SAFE_BRANCH.test(branch)) return { status: 400 };
      const base = await storedGhRepoId(repo.id);
      if (base === null) return { status: 404 };
      const http = await client(repo);
      const res = await http.request({ method: "GET", path: `/repos/${repo.owner}/${repo.name}/pulls`, query: { head: `${repo.owner}:${branch}`, state: "all", per_page: 5 } });
      if (res.status !== 200) return { status: res.status };
      if (!Array.isArray(res.body)) return { status: 502 };
      const pulls: BoundPullRequestView[] = [];
      for (const p of res.body) {
        if (!isObj(p) || !isObj(p.head)) return { status: 502 };
        const number = p.number;
        const state = p.state;
        const headRef = p.head.ref;
        const headRepo = p.head.repo;
        if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1 || (state !== "open" && state !== "closed") || typeof headRef !== "string") return { status: 502 };
        // A head repository that is gone (a deleted fork) is null, never this repository.
        const headRepoId = isObj(headRepo) && typeof headRepo.id === "number" && Number.isSafeInteger(headRepo.id) ? headRepo.id : null;
        pulls.push({ number, state, headRepoId, baseRepoId: base, headRef });
      }
      return { status: 200, pulls };
    },

    async defaultBranch({ repo }) {
      const http = await client(repo);
      const res = await http.request({ method: "GET", path: `/repos/${repo.owner}/${repo.name}` });
      if (res.status !== 200 || !isObj(res.body)) return null;
      return typeof res.body.default_branch === "string" && res.body.default_branch !== "" ? res.body.default_branch : null;
    },

    async branchProtection({ repo, branch }) {
      if (!SAFE_BRANCH.test(branch)) return { status: 400 };
      const http = await client(repo);
      // GitHub takes a branch name with a slash only percent-encoded, as one path segment.
      const res = await http.request({ method: "GET", path: `/repos/${repo.owner}/${repo.name}/branches/${encodeURIComponent(branch)}/protection` });
      return { status: res.status };
    },
  };
}
