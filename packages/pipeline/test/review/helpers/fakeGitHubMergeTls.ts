import https from "node:https";
import type { LookupFunction } from "node:net";
import type { GitHubHttp, GitHubHttpRequest, GitHubHttpResponse } from "../../../src/build/githubMergePort.js";
import { startStrictGithubServer, type LocalTlsServer } from "../../../../github/test/helpers/localTlsServer.js";
import { ghError, type GhReply, type GhRequest } from "../../../../github/test/helpers/strictGithub.js";

/**
 * D#519 MQ1: GitHub's merge-side REST API (get a pull request, merge, update branch, compare, protection and rulesets), served over
 * REAL TLS so the port under test reaches it through Node's real connection path (certificate and hostname checked, `autoSelectFamily`,
 * a custom `lookup` called with `{ all: true }`). On top of the shared strict rules (User-Agent, Accept, API version, bearer
 * credentials, JSON bodies with a JSON content type, JSON error bodies) it enforces what the real endpoints do that our code touches:
 *
 *  - `GET /pulls/{n}`: `mergeable` is boolean, or `null` while GitHub computes it in the background (`computeReads` reads answer
 *    null, with `mergeable_state: "unknown"`; `neverComputes` never stops). `mergeable_state` is one of the documented values, and
 *    `behind` is reported ONLY when the base branch requires up-to-date branches (classic `strict` or a ruleset's
 *    `strict_required_status_checks_policy`); a non-strict repo that is behind still reports `clean`.
 *  - `PUT /pulls/{n}/merge`: 200 `merged: true` only when it can be merged; **405** when it cannot (conflict, out of date when
 *    required, any protection refusal, a closed pull request); **409** when the given `sha` is not the head; 422 for a
 *    `merge_method` outside the enum. A test may force any other answer with `world.mergeAnswer`. The message strings are free text
 *    and `world.messageOverride` changes them, so a test can show the code under test never reads them.
 *  - `PUT /pulls/{n}/update-branch`: **202 Accepted and asynchronous** (the head is unchanged in the response and changes only after
 *    `refreshAfterReads` later reads of the pull request); **422** both for an `expected_head_sha` that is not the head and for a merge
 *    conflict (told apart only by re-reading the pull request), and for a branch with no new base commits; 403 when
 *    `updateForbidden`. A body that is not a JSON object, or an `expected_head_sha` that is not a 40-hex string, is 422 as well.
 *  - `GET /compare/{base}...{head}`: `status` (`ahead` / `behind` / `diverged` / `identical`), `ahead_by`, `behind_by` and `files`,
 *    with `files` on one response only, capped at 300 (`per_page`/`page` page the commits); the head must be a commit that exists (404 otherwise).
 *  - `GET /commits/{sha}/check-runs` and `/status`: one passing check run named by `checkNames` on every commit (or the runs of `checkRuns`,
 *    with GitHub's null `conclusion` until completed) and an empty combined status (or `statuses`), each cut at `per_page` with `total_count`, so a gate over the real port reaches its merge call.
 *  - `GET /branches/{b}/protection/required_status_checks`: 200 with `strict` when set, 404 "Branch not protected" / "Required status
 *    checks not enabled" (GitHub's own messages), 403 on `protectionStatus: 403`.
 *  - `GET /rules/branches/{b}`: a paged array of rules (`required_status_checks` rules carry `parameters` with both
 *    `strict_required_status_checks_policy` and `required_status_checks`).
 *
 * NOT faked faithfully (called out in the PR): GitHub's actual three-way merge. The outcome (clean or conflict) is GIVEN per
 * scenario (`conflict`), as are the changed files. Also not faked: rate limits, abuse detection, how long GitHub really takes to
 * compute `mergeable` or to apply an update-branch request, and the exact wording of every message.
 */
export type MergeableStateValue = "clean" | "behind" | "dirty" | "blocked" | "unstable" | "has_hooks" | "draft" | "unknown";

export interface FakeRule {
  type: string;
  enforcement?: string;
  parameters?: Record<string, unknown>;
}

export interface MergeWorld {
  owner: string;
  name: string;
  prNumber: number;
  baseRef: string;
  headSha: string;
  /** The commit update-branch produces (the head after the refresh). */
  refreshedHeadSha: string;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  /** GIVEN: merging the base into the head conflicts. */
  conflict: boolean;
  /** Commits on the base that the head lacks. */
  behindBy: number;
  /** Commits on the head that the base lacks. */
  aheadBy: number;
  /** Paths the head changed since the merge base. */
  files: Array<{ filename: string; previous_filename?: string }>;
  /** The following GET reads of the pull request answer `mergeable: null` first. */
  computeReads: number;
  neverComputes: boolean;
  /** Overrides the `mergeable_state` the fake would derive (still one of the documented values). */
  forceMergeableState?: MergeableStateValue;
  /** Classic protection `strict`; undefined = no classic rule ("Branch not protected"). */
  classicStrict?: boolean;
  protectionStatus?: number;
  rules: FakeRule[];
  /** Forces the merge call's status (with GitHub's usual message for it). */
  mergeAnswer?: number;
  /** Runs when a merge request arrives, before it is answered (a push racing the merge, or `mergeable` starting to compute). */
  onMerge?: (w: MergeWorld) => void;
  /** Forces the update-branch call's status. */
  updateAnswer?: number;
  /** Classic protection exists but requires no status checks: GitHub answers 404 "Required status checks not enabled". */
  classicNotEnabled?: boolean;
  /** Both protection reads answer 500 once a merge request has been seen (the read that refines a refusal fails). */
  breakProtectionAfterMerge?: boolean;
  /** The check runs present and passing on every commit. */
  checkNames: string[];
  /** D#598 P7b: replaces `checkNames` with runs in any state. GitHub's `conclusion` is null until a run has completed, and `status` is queued | in_progress | completed. */
  checkRuns?: Array<{ name: string; status: "queued" | "in_progress" | "completed"; conclusion: string | null }>;
  /** D#598 P7b: commit statuses on every commit (context -> state); the combined state is derived the way GitHub derives it. */
  statuses?: Record<string, "error" | "failure" | "pending" | "success">;
  /** Replaces the `message` of the merge and update-branch errors, to show no code reads it (protection's documented 404 messages stay exact). */
  messageOverride?: string;
  updateForbidden: boolean;
  /** After update-branch answers 202, the head changes once this many later reads of the pull request have been made. */
  refreshAfterReads: number;
  pendingRefresh: { remaining: number } | null;
  /** Everything the server saw, in order. */
  calls: Array<{ method: string; path: string; query?: string; body: unknown }>;
  merges: Array<{ sha: unknown; method: unknown }>;
  updates: Array<{ expected: unknown }>;
}

export function freshMergeWorld(over: Partial<MergeWorld> = {}): MergeWorld {
  return {
    owner: "acme",
    name: "widgets",
    prNumber: 7,
    baseRef: "main",
    headSha: "a".repeat(40),
    refreshedHeadSha: "b".repeat(40),
    state: "open",
    merged: false,
    draft: false,
    conflict: false,
    behindBy: 0,
    aheadBy: 1,
    files: [{ filename: "src/a.ts" }],
    computeReads: 0,
    neverComputes: false,
    rules: [],
    checkNames: ["build"],
    updateForbidden: false,
    refreshAfterReads: 1,
    pendingRefresh: null,
    calls: [],
    merges: [],
    updates: [],
    ...over,
  };
}

const SHA40 = /^[0-9a-f]{40}$/;
const MERGE_METHODS = ["merge", "squash", "rebase"];

export function requiresUpToDate(w: MergeWorld): boolean {
  return w.classicStrict === true || w.rules.some((r) => r.type === "required_status_checks" && (r.enforcement ?? "active") === "active" && r.parameters?.strict_required_status_checks_policy === true);
}

function compareStatus(w: MergeWorld): "ahead" | "behind" | "diverged" | "identical" {
  if (w.aheadBy > 0 && w.behindBy > 0) return "diverged";
  if (w.behindBy > 0) return "behind";
  if (w.aheadBy > 0) return "ahead";
  return "identical";
}

function mergeableState(w: MergeWorld): MergeableStateValue {
  if (w.forceMergeableState) return w.forceMergeableState;
  if (w.draft) return "draft";
  if (w.conflict) return "dirty";
  // `behind` is reported only when the base branch requires up-to-date branches.
  if (w.behindBy > 0 && requiresUpToDate(w)) return "behind";
  return "clean";
}

function paged<T>(all: T[], query: URLSearchParams): T[] {
  const per = Math.min(100, Math.max(1, Number(query.get("per_page") ?? 30) || 30));
  const page = Math.max(1, Number(query.get("page") ?? 1) || 1);
  return all.slice((page - 1) * per, page * per);
}

/** The rule set above as a `route` for `startStrictGithubServer`. */
export function mergeRoute(w: MergeWorld): (req: GhRequest) => GhReply {
  const base = `/repos/${w.owner}/${w.name}`;
  const json = (status: number, body: unknown): GhReply => ({ status, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
  const err = (status: number, message: string): GhReply => ghError(status, w.messageOverride ?? message);

  return (req) => {
    const query = new URLSearchParams(req.query ?? "");
    let body: unknown;
    if (req.body !== "") body = JSON.parse(req.body) as unknown;
    w.calls.push({ method: req.method, path: req.path, ...(req.query === undefined ? {} : { query: req.query }), body });

    if (req.method === "GET" && req.path === `${base}/pulls/${w.prNumber}`) {
      // An accepted update-branch applies after the configured number of later reads, never in its own response.
      if (w.pendingRefresh) {
        if (w.pendingRefresh.remaining <= 0) {
          w.headSha = w.refreshedHeadSha;
          w.behindBy = 0;
          w.pendingRefresh = null;
        } else {
          w.pendingRefresh.remaining -= 1;
        }
      }
      let mergeable: boolean | null;
      let state: MergeableStateValue;
      if (w.neverComputes || w.computeReads > 0) {
        if (!w.neverComputes) w.computeReads -= 1;
        mergeable = null;
        state = "unknown";
      } else {
        mergeable = !w.conflict;
        state = mergeableState(w);
      }
      return json(200, {
        number: w.prNumber,
        state: w.state,
        merged: w.merged,
        draft: w.draft,
        mergeable,
        mergeable_state: state,
        head: { sha: w.headSha, ref: "fx/item-7", repo: { full_name: `${w.owner}/${w.name}` } },
        base: { ref: w.baseRef, repo: { full_name: `${w.owner}/${w.name}` } },
      });
    }

    if (req.method === "PUT" && req.path === `${base}/pulls/${w.prNumber}/merge`) {
      const b = (body ?? {}) as { sha?: unknown; merge_method?: unknown };
      if (b.merge_method !== undefined && !MERGE_METHODS.includes(b.merge_method as string)) return err(422, "Validation Failed");
      w.onMerge?.(w);
      w.merges.push({ sha: b.sha, method: b.merge_method });
      if (w.mergeAnswer !== undefined) return err(w.mergeAnswer, "Pull Request is not mergeable");
      if (b.sha !== undefined && b.sha !== w.headSha) return err(409, "Head branch was modified. Review and try the merge again.");
      // 405 is every "the merge cannot be performed".
      if (w.state !== "open" || w.merged || w.draft || w.conflict || (w.behindBy > 0 && requiresUpToDate(w))) return err(405, "Pull Request is not mergeable");
      w.merged = true;
      w.state = "closed";
      return json(200, { merged: true, sha: "f".repeat(40), message: "Pull Request successfully merged" });
    }

    if (req.method === "PUT" && req.path === `${base}/pulls/${w.prNumber}/update-branch`) {
      if (w.updateForbidden) return err(403, "Resource not accessible by integration");
      if (w.updateAnswer !== undefined) return err(w.updateAnswer, "Server Error");
      if (body === null || typeof body !== "object" || Array.isArray(body)) return err(422, "Validation Failed");
      const expected = (body as { expected_head_sha?: unknown }).expected_head_sha;
      w.updates.push({ expected });
      if (expected !== undefined && (typeof expected !== "string" || !SHA40.test(expected))) return err(422, "Validation Failed");
      // A head that differs and a conflict are both 422; only a re-read of the pull request tells them apart.
      if (expected !== undefined && expected !== w.headSha) return err(422, "expected head sha didn’t match current head ref.");
      if (w.conflict) return err(422, "merge conflict between base and head");
      if (w.behindBy === 0) return err(422, "There are no new commits on the base branch.");
      w.pendingRefresh = { remaining: w.refreshAfterReads };
      return json(202, { message: "Updating pull request branch.", url: `https://api.github.com${base}/pulls/${w.prNumber}` });
    }

    const cmp = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/compare/(.+)\\.\\.\\.([^.]+)$`).exec(req.path);
    if (req.method === "GET" && cmp) {
      if (decodeURIComponent(cmp[1]!) !== w.baseRef || cmp[2] !== w.headSha) return err(404, "Not Found");
      // per_page/page page the COMMITS; files come on one response, capped at 300 for the whole comparison.
      const page = w.files.slice(0, 300);
      return json(200, { status: compareStatus(w), ahead_by: w.aheadBy, behind_by: w.behindBy, total_commits: w.aheadBy, files: page.map((f) => ({ sha: "c".repeat(40), status: f.previous_filename ? "renamed" : "modified", ...f })) });
    }

    const checks = /^\/repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]{40})\/check-runs$/.exec(req.path);
    if (req.method === "GET" && checks) {
      const runs = w.checkRuns ?? w.checkNames.map((name) => ({ name, status: "completed" as const, conclusion: "success" as string | null }));
      const list = runs.map((r, i) => ({ id: i + 1, head_sha: checks[1], name: r.name, status: r.status, conclusion: r.status === "completed" ? r.conclusion : null, app: { id: 1 } }));
      return json(200, { total_count: list.length, check_runs: paged(list, query) });
    }
    const combined = /^\/repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]{40})\/status$/.exec(req.path);
    if (req.method === "GET" && combined) {
      const latest = Object.entries(w.statuses ?? {}).map(([context, state]) => ({ context, state }));
      const state = latest.length === 0 || latest.some((x) => x.state === "pending") ? "pending" : latest.every((x) => x.state === "success") ? "success" : "failure";
      return json(200, { sha: combined[1], state, total_count: latest.length, statuses: paged(latest, query) });
    }

    const protectionPath = req.path === `${base}/branches/${w.baseRef}/protection/required_status_checks` || req.path === `${base}/rules/branches/${w.baseRef}`;
    if (req.method === "GET" && protectionPath && w.breakProtectionAfterMerge && w.merges.length > 0) return err(500, "Server Error");

    if (req.method === "GET" && req.path === `${base}/branches/${w.baseRef}/protection/required_status_checks`) {
      // GitHub's own 404 messages are part of the contract the port matches exactly, so `messageOverride` leaves them alone.
      if (w.classicNotEnabled) return ghError(404, "Required status checks not enabled");
      if (w.protectionStatus !== undefined) return ghError(w.protectionStatus, w.protectionStatus === 403 ? "Resource not accessible by integration" : "Not Found");
      if (w.classicStrict === undefined) return ghError(404, "Branch not protected");
      return json(200, { strict: w.classicStrict, contexts: [], checks: [] });
    }

    if (req.method === "GET" && req.path === `${base}/rules/branches/${w.baseRef}`) {
      return json(200, paged(w.rules, query));
    }

    return err(404, "Not Found");
  };
}

export interface MergeTlsGitHub {
  world: MergeWorld;
  server: LocalTlsServer;
  http: GitHubHttp;
  close(): Promise<void>;
}

/** A client that speaks to the server above the way the production installation client does (same headers, JSON bodies), over Node's real TLS path. */
export function tlsGitHubHttp(server: LocalTlsServer): GitHubHttp {
  const lookup = ((_host: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => (opts.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4))) as unknown as LookupFunction;
  return {
    request(req: GitHubHttpRequest): Promise<GitHubHttpResponse> {
      const url = new URL(`https://api.github.com${req.path}`);
      for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, String(v));
      const payload = req.body === undefined ? undefined : JSON.stringify(req.body);
      const headers: Record<string, string> = {
        accept: "application/vnd.github+json",
        authorization: "Bearer installation-token-for-test", // gitleaks:allow
        "x-github-api-version": "2022-11-28",
        "user-agent": "fulcrumaxe-cloud",
        ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) }),
      };
      return new Promise((resolve, reject) => {
        const r = https.request({ host: url.hostname, port: server.port, method: req.method, path: `${url.pathname}${url.search}`, headers, ca: server.ca, servername: url.hostname, lookup }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: unknown = null;
            try {
              parsed = text ? JSON.parse(text) : null;
            } catch {
              parsed = null;
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        });
        r.on("error", reject);
        r.end(payload);
      });
    },
  };
}

export async function startMergeTlsGitHub(over: Partial<MergeWorld> = {}): Promise<MergeTlsGitHub> {
  const world = freshMergeWorld(over);
  const server = await startStrictGithubServer(mergeRoute(world));
  return { world, server, http: tlsGitHubHttp(server), close: () => server.close() };
}
