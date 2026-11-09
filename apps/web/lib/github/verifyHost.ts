import { createPlanReadClient, PlanReadError, type PlanReadDeps } from "@fx/github";
import type { CommitFacts, CommitRelation } from "@fx/core/src/verify/qualify.js";
import type { VerifyHostPort, VerifyTarget } from "@fx/worker";

/**
 * D#749 V3a-2: the production host adapter of the post-merge verify stage: what GitHub says about a merged pull request's commit, a commit's parents and how two
 * commits relate. It rides the existing read-only plan client (packages/github/src/planReadClient.ts: the repository's own installation, a `plan_read` token that is
 * one repository and read only, GET only, no redirect, a timeout per call), so no new token path exists and nothing here can write to GitHub.
 *
 * Bounds. Every port call is ONE request on a fresh client, with a timeout and a body cap (`MAX_BODY_BYTES`). The three reads:
 *  - `mergeCommit`: `GET pulls/<n>`; the answer counts only for a pull request that is `merged` and names a full commit id.
 *  - `commit`: `GET commits?sha=<id>&per_page=1`, the list form, not `commits/<id>`: the single-commit form carries every changed file's patch (megabytes for a large
 *    merge) and the list form carries the parents and message alone. The first entry must be the commit asked for.
 *  - `relation`: `GET compare/<base>...<head>?per_page=1`; GitHub's `status` is `ahead` (head descends from base), `behind`, `identical` or `diverged`.
 * Nothing thrown reaches the tick: a missing commit is `null`, a relation that cannot be read is `unknown`, a merge commit that cannot be read is `null` (the intake
 * tries the merge again next tick). After GitHub's rate limit answers (the primary or the secondary one) the adapter makes no call at all for `RATE_COOLDOWN_MS`.
 */
export const MAX_BODY_BYTES = 1_048_576;
export const CALL_TIMEOUT_MS = 10_000;
/** The whole port call, token mint and installation lookup included (the pass budget is only checked between repositories, so no single call may hang the pass). */
export const DEADLINE_MS = 15_000;
export const RATE_COOLDOWN_MS = 60_000;
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const RELATIONS: ReadonlySet<string> = new Set(["ahead", "behind", "identical", "diverged"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Which repository answers what. A paired repository has two planes: the pull request, its merge commit and the comparison of code-plane commits live in the PUBLIC code
 * repository (`target.codeRepo`, which the stage reads from the repository's pairing); the deployed sync commit lives in the PRIVATE repository (`target` itself). Both
 * are read with the installation that owns the item's repository (`target.repoId`), each scoped to the one repository it reads. With no `codeRepo` the repository is
 * single-plane and every read goes to `target`.
 */
export type PlaneTarget = VerifyTarget;

export function createVerifyHost(deps: PlanReadDeps | (() => PlanReadDeps), opts: { now?: () => number; deadlineMs?: number } = {}): VerifyHostPort {
  const now = opts.now ?? Date.now;
  const deadlineMs = opts.deadlineMs ?? DEADLINE_MS;
  // Built on the first read, inside its try: a deployment whose settings are missing answers "no answer" like any other failure, never an error at load or in the tick.
  let opener: ReturnType<typeof createPlanReadClient> | undefined;
  const open = (target: Parameters<ReturnType<typeof createPlanReadClient>>[0]) => (opener ??= createPlanReadClient({ ...(typeof deps === "function" ? deps() : deps), callTimeoutMs: CALL_TIMEOUT_MS }))(target);
  let coolUntil = 0;

  /** One GET. `null` when the call was not made, failed, or GitHub answered with a status that is not in `accept`; otherwise the parsed JSON body of that status. */
  async function read(target: PlaneTarget, plane: "code" | "private", path: string, query: Record<string, string>, accept: readonly number[]): Promise<{ status: number; body: unknown } | null> {
    if (now() < coolUntil) return null;
    // The token is minted on the installation that owns `target`, so the paired code repository must belong to the same owner: a pairing that names another owner is no answer, before any mint or request.
    if (plane === "code" && target.codeRepo && target.codeRepo.owner.toLowerCase() !== target.owner.toLowerCase()) return null;
    const repo = plane === "code" && target.codeRepo ? target.codeRepo : { owner: target.owner, name: target.name };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), deadlineMs);
    });
    try {
      return await Promise.race([attempt(target.repoId, repo, path, query, accept), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function attempt(repoId: string, repo: { owner: string; name: string }, path: string, query: Record<string, string>, accept: readonly number[]): Promise<{ status: number; body: unknown } | null> {
    try {
      const res = await open({ repoId, owner: repo.owner, name: repo.name }).request({
        method: "GET",
        path: `/repos/${repo.owner}/${repo.name}/${path}`,
        ...(Object.keys(query).length > 0 ? { query } : {}),
        maxBytes: MAX_BODY_BYTES,
      });
      if (!accept.includes(res.status)) return null;
      let body: unknown = null;
      try {
        body = JSON.parse(res.text);
      } catch {
        // fx-swallow-ok: a body that is not JSON reads as null, which every caller treats as "not the shape expected"
        body = null;
      }
      return { status: res.status, body };
    } catch (err) {
      if (err instanceof PlanReadError && err.code === "rate_limited_by_github") coolUntil = now() + RATE_COOLDOWN_MS;
      // fx-swallow-ok: the stage reads a missing answer as "try again next tick" (intake) or "does not qualify yet" (readiness); the error text can carry request details
      return null;
    }
  }

  return {
    async mergeCommit(target, prNumber) {
      if (!Number.isSafeInteger(prNumber) || prNumber < 1) return null;
      const res = await read(target, "code", `pulls/${prNumber}`, {}, [200]);
      if (res === null || !isRecord(res.body) || res.body["merged"] !== true) return null;
      const sha = res.body["merge_commit_sha"];
      return typeof sha === "string" && COMMIT_ID.test(sha) ? sha : null;
    },

    async commit(target, sha): Promise<CommitFacts | null> {
      if (!COMMIT_ID.test(sha)) return null;
      const res = await read(target, "private", "commits", { sha, per_page: "1" }, [200]);
      const first = res !== null && Array.isArray(res.body) ? (res.body[0] as unknown) : undefined;
      if (!isRecord(first) || first["sha"] !== sha || !Array.isArray(first["parents"]) || !isRecord(first["commit"]) || typeof first["commit"]["message"] !== "string") return null;
      const parents: string[] = [];
      for (const p of first["parents"] as unknown[]) {
        if (!isRecord(p) || typeof p["sha"] !== "string" || !COMMIT_ID.test(p["sha"])) return null;
        parents.push(p["sha"]);
      }
      return { parents, message: first["commit"]["message"] };
    },

    async relation(target, base, head): Promise<CommitRelation> {
      if (!COMMIT_ID.test(base) || !COMMIT_ID.test(head)) return "unknown";
      const res = await read(target, "code", `compare/${base}...${head}`, { per_page: "1" }, [200]);
      const status = res !== null && isRecord(res.body) ? res.body["status"] : undefined;
      return typeof status === "string" && RELATIONS.has(status) ? (status as CommitRelation) : "unknown";
    },
  };
}
