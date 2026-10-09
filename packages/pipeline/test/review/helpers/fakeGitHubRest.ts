import type { GitHubHttp, GitHubHttpRequest, GitHubHttpResponse } from "../../../src/build/githubMergePort.js";

/**
 * A fake of the part of GitHub's REST API the stage driver touches, written to answer like the real one where our code
 * could be fooled by a lazier fake:
 *
 *  - every list is cut at `per_page` (100 at most) and `total_count` is the whole set's;
 *  - the combined status of a commit holds the LATEST state per context, and a commit with no status at all is
 *    `pending` with `total_count: 0` (which `isCiGreen` must not read as green);
 *  - `POST /statuses/{sha}` needs a full 40-hex sha (else 404 "No commit found for SHA"), a state in the real enum
 *    (else 422), and a description of at most 140 characters (else 422); it answers 201;
 *  - `PUT /pulls/{n}/merge` merges whatever the head is when `sha` is absent, answers 409 when a `sha` is given and the
 *    head has moved, 405 when the pull request is not mergeable, 422 for a `merge_method` outside the real enum;
 *  - branch protection answers 404 "Branch not protected" when none is set;
 *  - a closed or merged pull request still answers its state;
 *  - the files list gives `patch` only for files GitHub shows, and none for a binary file.
 *
 * What it cannot fake faithfully: rate limits, secondary rate limits, eventual consistency between a status post and
 * the next combined-status read, and the exact wording of every message.
 */
export interface FakeFile {
  filename: string;
  patch?: string;
  previous_filename?: string;
  changes?: number;
}

export interface FakeCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  app?: { id: number };
}

export interface FakeRepoState {
  owner: string;
  name: string;
  prNumber: number;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  headSha: string;
  baseRef: string;
  files: FakeFile[];
  /** Check runs by commit sha. */
  checks: Record<string, FakeCheckRun[]>;
  /** Commit statuses by sha: context -> state (latest wins). */
  statuses: Record<string, Record<string, string>>;
  requiredContexts: string[];
  /** The base branch has a classic protection rule that requires no status checks: GitHub answers 404 "Required status checks not enabled" instead of "Branch not protected". */
  protectedWithoutChecks?: boolean;
  /** Ruleset rules GitHub applies to the base branch (a rule of a type other than required_status_checks protects it too). */
  rulesetRules?: Array<{ type: string; enforcement?: string }>;
  /** The branch protection read answers with this status and a "Forbidden"/"Not Found" body (a private repository on a plan without protection, or no permission). */
  protectionStatus?: number;
  /** Branch protection answered as `Branch not protected` unless required contexts are set. */
  mergeStatus: number | null;
  /** Runs when the merge request arrives (a push racing the merge may change `headSha`). */
  onMerge?: (s: FakeRepoState) => void;
  /** Status posts answered with this status instead of 201 (a failure to post). */
  statusPostFails?: number;
  /** Reads of the files list answered with this status. */
  filesFail?: number;
  merges: Array<{ sha: string | undefined; method: unknown }>;
  posts: Array<{ sha: string; body: Record<string, unknown> }>;
  requests: GitHubHttpRequest[];
  /** D#6 R3c: the pull request's head branch as the local-only fake lists it (a runner run's `fx/<run>-g<n>`). */
  runBranch?: string;
}

export function freshRepo(over: Partial<FakeRepoState> = {}): FakeRepoState {
  return {
    owner: "acme",
    name: "widgets",
    prNumber: 41,
    state: "open",
    merged: false,
    draft: false,
    headSha: "a".repeat(40),
    baseRef: "main",
    files: [{ filename: "src/ui/button.tsx", patch: "@@ -1 +1 @@\n+export const x = 1;", changes: 1 }],
    checks: {},
    statuses: {},
    requiredContexts: [],
    mergeStatus: null,
    merges: [],
    posts: [],
    requests: [],
    ...over,
  };
}

const json = (status: number, body: unknown): GitHubHttpResponse => ({ status, body });
const NOT_FOUND = json(404, { message: "Not Found" });
const STATE_ENUM = ["error", "failure", "pending", "success"];
const MERGE_METHODS = ["merge", "squash", "rebase"];

function page<T>(all: T[], q: GitHubHttpRequest["query"]): T[] {
  const per = Math.min(100, Number(q?.per_page ?? 30));
  const p = Number(q?.page ?? 1);
  return all.slice((p - 1) * per, p * per);
}

export function fakeGitHubRest(s: FakeRepoState): GitHubHttp {
  const base = `/repos/${s.owner}/${s.name}`;
  return {
    async request(req) {
      s.requests.push(req);
      const path = req.path;
      if (req.method === "GET" && path === `${base}/pulls/${s.prNumber}`) {
        return json(200, { number: s.prNumber, state: s.state, merged: s.merged, draft: s.draft, head: { sha: s.headSha, ref: `fx/issue-7`, repo: { full_name: `${s.owner}/${s.name}` } }, base: { ref: s.baseRef } });
      }
      if (req.method === "GET" && path === `${base}/pulls/${s.prNumber}/files`) {
        if (s.filesFail) return json(s.filesFail, { message: "Server Error" });
        return json(200, page(s.files, req.query));
      }
      const checks = /^\/repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]{40})\/check-runs$/.exec(path);
      if (req.method === "GET" && checks) {
        const sha = checks[1]!;
        const list = (s.checks[sha] ?? []).map((c, i) => ({ id: i + 1, head_sha: sha, name: c.name, status: c.status, conclusion: c.conclusion, app: c.app ?? { id: 1 } }));
        return json(200, { total_count: list.length, check_runs: page(list, req.query) });
      }
      const status = /^\/repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]{40})\/status$/.exec(path);
      if (req.method === "GET" && status) {
        const sha = status[1]!;
        const latest = Object.entries(s.statuses[sha] ?? {}).map(([context, state]) => ({ context, state }));
        const combined = latest.length === 0 ? "pending" : latest.every((x) => x.state === "success") ? "success" : "failure";
        return json(200, { sha, state: combined, total_count: latest.length, statuses: page(latest, req.query) });
      }
      if (req.method === "GET" && path === `${base}/branches/${s.baseRef}/protection/required_status_checks`) {
        if (s.protectionStatus !== undefined) return json(s.protectionStatus, { message: s.protectionStatus === 403 ? "Upgrade to GitHub Pro or make this repository public to enable this feature." : "Not Found" });
        if (s.requiredContexts.length === 0 && s.protectedWithoutChecks) return json(404, { message: "Required status checks not enabled" });
        return s.requiredContexts.length === 0 ? json(404, { message: "Branch not protected" }) : json(200, { contexts: s.requiredContexts, checks: s.requiredContexts.map((context) => ({ context, app_id: null })) });
      }
      if (req.method === "GET" && path === `${base}/rules/branches/${s.baseRef}`) return json(200, s.rulesetRules ?? []);
      const post = /^\/repos\/[^/]+\/[^/]+\/statuses\/(.+)$/.exec(path);
      if (req.method === "POST" && post) {
        const sha = post[1]!;
        if (!/^[0-9a-f]{40}$/.test(sha)) return json(404, { message: "No commit found for SHA: " + sha });
        const body = (req.body ?? {}) as Record<string, unknown>;
        if (!STATE_ENUM.includes(body.state as string) || typeof body.context !== "string" || (typeof body.description === "string" && body.description.length > 140)) {
          return json(422, { message: "Validation Failed" });
        }
        if (s.statusPostFails) return json(s.statusPostFails, { message: "Server Error" });
        s.posts.push({ sha, body });
        (s.statuses[sha] ??= {})[body.context as string] = body.state as string;
        return json(201, { state: body.state, context: body.context });
      }
      if (req.method === "PUT" && path === `${base}/pulls/${s.prNumber}/merge`) {
        const body = (req.body ?? {}) as { sha?: string; merge_method?: unknown };
        if (body.merge_method !== undefined && !MERGE_METHODS.includes(body.merge_method as string)) return json(422, { message: "Validation Failed" });
        s.onMerge?.(s);
        s.merges.push({ sha: body.sha, method: body.merge_method });
        if (s.mergeStatus) return json(s.mergeStatus, { message: "Pull Request is not mergeable" });
        if (body.sha !== undefined && body.sha !== s.headSha) return json(409, { message: "Head branch was modified. Review and try the merge again." });
        s.merged = true;
        s.state = "closed";
        return json(200, { merged: true, sha: "f".repeat(40) });
      }
      return NOT_FOUND;
    },
  };
}
