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
 *  - `GET /commits/{sha}` (D#519 MQ3-a): a commit GitHub knows (`commits`), with `parents`, `author` (the account the commit's author resolves
 *    to, or null), `committer` (likewise), `commit.verification.verified` / `.reason` and `files` (against the FIRST parent, capped at 300);
 *    an unknown sha is **422** "No commit found for SHA", as the live API answers (read against the live API, not assumed). The
 *    commit an accepted update-branch produces is registered when it is applied: two parents (the old head, then `baseTipSha`), authored
 *    by `refreshAuthorLogin`, committed by `refreshCommitterLogin` (GitHub's `web-flow`), signed unless `refreshVerified` is false.
 *    Which fields a real update-branch commit carries is still to be confirmed from one real commit on staging; the fake pins the shape.
 *  - `GET /git/commits/{sha}` and `GET /git/trees/{id}?recursive=1`: the tree of a commit (`trees`: path -> `mode type sha`; a commit with
 *    no entry has the empty tree), `truncated: true` for a commit in `truncatedTrees`; an unknown tree id is 404. `GET /compare/{sha}...{sha}`
 *    answers the merge base (`mergeBaseSha`) with `ahead_by` (`aheadFromReviewed`; `aheadFromBase` when the first sha is the merge base), so
 *    a criss-cross history is modelled by making those two differ. `compare` also answers for a commit on the default branch
 *    (`baseShas`: `identical` at the tip, `behind` below it) and for a registered commit that is not on it (`ahead`).
 *  - D#519 MQ4-a: `GET /pulls/{n}/commits` is a BARE ARRAY (no `total_count`), paged by `per_page` (100 at most) and `page`, and GitHub lists at most 250 commits
 *    however many the pull request has (`pullCommits`); each item carries `sha`, `author` and `committer` (an account object or null). `GET /compare/{sha}...{sha}`
 *    answers a pair registered in `compares` with its own `status`, counts, `merge_base_commit` and files (capped at 300, on one response); an unregistered pair keeps the merge-base answer above.
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

/** A commit the fake knows about (`GET /commits/{sha}`). */
export interface FakeCommit {
  parents: string[];
  /** The login the commit's author resolves to, or null (no GitHub account). The author is whatever email the pusher typed. */
  authorLogin: string | null;
  /** The login the commit's committer resolves to (default `web-flow`, GitHub's own). The signature is checked against the committer. */
  committerLogin?: string | null;
  verified: boolean;
  /** `commit.verification.reason`; default `valid` when verified, `unsigned` otherwise. */
  verificationReason?: string;
  files: Array<{ filename: string; previous_filename?: string }>;
}

export interface MergeWorld {
  owner: string;
  name: string;
  prNumber: number;
  baseRef: string;
  /** The repository default branch GitHub reports on the PR (`base.repo.default_branch`); "main" when a fixture says nothing. */
  defaultBranch?: string;
  /** D#598 P1d-1: the pull request's author (`user.login`) and whether the repository is public (`base.repo.private` is the opposite). Unset: a private repository. */
  prAuthorLogin?: string | null;
  isPublic?: boolean;
  headSha: string;
  /** The commit update-branch produces (the head after the refresh). */
  refreshedHeadSha: string;
  /** The default branch's tip, and the commits on it (the second parent of a refresh must be one of these). */
  baseTipSha: string;
  baseShas: string[];
  /** Commits `GET /commits/{sha}` answers for. */
  commits: Record<string, FakeCommit>;
  /** The login the update-branch commit is authored by, whether GitHub signed it, and the files it brings in from the default branch. */
  refreshAuthorLogin: string | null;
  refreshCommitterLogin: string | null;
  refreshVerified: boolean;
  /** Each commit's tree: path -> `mode type sha`. A commit with no entry has the empty tree. */
  trees: Record<string, Record<string, string>>;
  /** Commits whose recursive tree comes back `truncated: true`. */
  truncatedTrees: string[];
  /** The status every tree read answers (200 normally; a test sets 500 to show a failed read is "not verified"). */
  treeStatus: number;
  /** The merge base of any two commits, and the `ahead_by` counts the unique-base test compares. */
  mergeBaseSha: string;
  aheadFromReviewed: number;
  aheadFromBase: number;
  mainFiles: Array<{ filename: string; previous_filename?: string }>;
  /** D#519 MQ4-a: the commits `GET /pulls/{n}/commits` lists, oldest first. `rawAuthor`, when present, replaces the `author` member as sent (a malformed shape). */
  pullCommits: Array<{ sha: string; authorLogin: string | null; committerLogin: string | null; rawAuthor?: unknown }>;
  /** D#519 MQ4-a: comparisons of two explicit commits, keyed `base...head`. */
  compares: Record<string, { status: "ahead" | "behind" | "diverged" | "identical"; aheadBy: number; behindBy: number; mergeBaseSha: string; files: Array<{ filename: string; previous_filename?: string }> }>;
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
  /**
   * D#519 MQ3-b: the merge reply is held open this many ms after the request arrives (real I/O, not a microtask), and `mergeGauge` counts the
   * merge requests that are open at once, shared across worlds by passing the same object. With no delay a handler answers in the same tick it
   * was called, so no two requests can ever overlap in the gauge and "never two in flight" could not fail.
   */
  mergeDelayMs?: number;
  mergeGauge?: { now: number; max: number };
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
  /** D#519 MQ3-b: the runs of ONE commit, replacing `checkRuns` / `checkNames` for that sha (a refreshed head whose CI has not all posted yet). */
  checkRunsBySha?: Record<string, Array<{ name: string; status: "queued" | "in_progress" | "completed"; conclusion: string | null }>>;
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
    baseTipSha: "9".repeat(40),
    baseShas: ["9".repeat(40), "8".repeat(40)],
    commits: {},
    refreshAuthorLogin: "fulcrumaxe-app[bot]",
    refreshCommitterLogin: "web-flow",
    refreshVerified: true,
    trees: {},
    truncatedTrees: [],
    treeStatus: 200,
    mergeBaseSha: "7".repeat(40),
    aheadFromReviewed: 1,
    aheadFromBase: 1,
    mainFiles: [{ filename: "docs/main-only.md" }],
    pullCommits: [],
    compares: {},
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
export function mergeRoute(w: MergeWorld): (req: GhRequest) => GhReply | Promise<GhReply> {
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
          // GitHub's merge of the base into the branch: two parents, the old head first.
          w.commits[w.refreshedHeadSha] = { parents: [w.headSha, w.baseTipSha], authorLogin: w.refreshAuthorLogin, committerLogin: w.refreshCommitterLogin, verified: w.refreshVerified, files: w.mainFiles };
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
        base: { ref: w.baseRef, repo: { full_name: `${w.owner}/${w.name}`, default_branch: w.defaultBranch ?? "main", private: w.isPublic !== true } },
        user: w.prAuthorLogin === null ? null : { login: w.prAuthorLogin ?? "fixture-author" },
      });
    }

    if (req.method === "PUT" && req.path === `${base}/pulls/${w.prNumber}/merge`) {
      const b = (body ?? {}) as { sha?: unknown; merge_method?: unknown };
      if (b.merge_method !== undefined && !MERGE_METHODS.includes(b.merge_method as string)) return err(422, "Validation Failed");
      if (w.mergeGauge) w.mergeGauge.max = Math.max(w.mergeGauge.max, ++w.mergeGauge.now);
      w.onMerge?.(w);
      w.merges.push({ sha: b.sha, method: b.merge_method });
      const answer = (): GhReply => {
        if (w.mergeAnswer !== undefined) return err(w.mergeAnswer, "Pull Request is not mergeable");
        if (b.sha !== undefined && b.sha !== w.headSha) return err(409, "Head branch was modified. Review and try the merge again.");
        // 405 is every "the merge cannot be performed".
        if (w.state !== "open" || w.merged || w.draft || w.conflict || (w.behindBy > 0 && requiresUpToDate(w))) return err(405, "Pull Request is not mergeable");
        w.merged = true;
        w.state = "closed";
        return json(200, { merged: true, sha: "f".repeat(40), message: "Pull Request successfully merged" });
      };
      const done = (): GhReply => {
        const reply = answer();
        if (w.mergeGauge) w.mergeGauge.now -= 1;
        return reply;
      };
      return w.mergeDelayMs ? new Promise<GhReply>((resolve) => setTimeout(() => resolve(done()), w.mergeDelayMs)) : done();
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
      const left = decodeURIComponent(cmp[1]!);
      // Two commits (the merge-base read of the tree check): the merge base, with `ahead_by` of the head side over it.
      if (/^[0-9a-f]{40}$/.test(left)) {
        if (!/^[0-9a-f]{40}$/.test(cmp[2]!)) return err(404, "Not Found");
        const pair = w.compares[`${left}...${cmp[2]}`];
        if (pair) {
          // The files come on this one response, capped at 300 for the whole comparison.
          const files = pair.files.slice(0, 300).map((f) => ({ sha: "c".repeat(40), status: f.previous_filename ? "renamed" : "modified", ...f }));
          return json(200, { status: pair.status, ahead_by: pair.aheadBy, behind_by: pair.behindBy, total_commits: pair.aheadBy, merge_base_commit: { sha: pair.mergeBaseSha }, files });
        }
        const ahead = left === w.mergeBaseSha ? w.aheadFromBase : w.aheadFromReviewed;
        return json(200, { status: "ahead", ahead_by: ahead, behind_by: 0, total_commits: ahead, merge_base_commit: { sha: w.mergeBaseSha }, files: [] });
      }
      if (left !== w.baseRef) return err(404, "Not Found");
      const target = cmp[2]!;
      // A commit on the default branch is not ahead of it; a commit GitHub knows that is not on it is.
      if (target !== w.headSha && w.baseShas.includes(target)) {
        return json(200, { status: target === w.baseTipSha ? "identical" : "behind", ahead_by: 0, behind_by: target === w.baseTipSha ? 0 : 1, total_commits: 0, files: [] });
      }
      if (target !== w.headSha && w.commits[target]) return json(200, { status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1, files: [] });
      if (target !== w.headSha) return err(404, "Not Found");
      // per_page/page page the COMMITS; files come on one response, capped at 300 for the whole comparison.
      const page = w.files.slice(0, 300);
      return json(200, { status: compareStatus(w), ahead_by: w.aheadBy, behind_by: w.behindBy, total_commits: w.aheadBy, files: page.map((f) => ({ sha: "c".repeat(40), status: f.previous_filename ? "renamed" : "modified", ...f })) });
    }

    if (req.method === "GET" && req.path === `${base}/pulls/${w.prNumber}/commits`) {
      // A bare array, cut at GitHub's 250 however long the pull request's history is, then paged.
      const listed = w.pullCommits.slice(0, 250).map((c) => ({
        sha: c.sha,
        author: "rawAuthor" in c ? c.rawAuthor : c.authorLogin === null ? null : { login: c.authorLogin, id: 4242, type: "User" },
        committer: c.committerLogin === null ? null : { login: c.committerLogin, id: 19864447, type: "User" },
        commit: { message: "a commit" },
      }));
      return json(200, paged(listed, query));
    }

    const commit = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/commits/([0-9a-f]{40})$`).exec(req.path);
    if (req.method === "GET" && commit) {
      const c = w.commits[commit[1]!];
      // The live API answers 422 (not 404) for a sha it has no commit for.
      if (!c) return err(422, "No commit found for SHA");
      const page = c.files.slice(0, 300);
      return json(200, {
        sha: commit[1],
        parents: c.parents.map((sha) => ({ sha })),
        author: c.authorLogin === null ? null : { login: c.authorLogin, id: 4242, type: c.authorLogin.endsWith("[bot]") ? "Bot" : "User" },
        committer: c.committerLogin === null ? null : { login: c.committerLogin ?? "web-flow", id: 19864447, type: "User" },
        commit: { message: "Merge branch 'main' into feature", verification: { verified: c.verified, reason: c.verificationReason ?? (c.verified ? "valid" : "unsigned") } },
        files: page.map((f) => ({ sha: "d".repeat(40), status: f.previous_filename ? "renamed" : "modified", ...f })),
      });
    }

    // D#519 MQ-MAIN-RED-GUARD: one ref, exactly as GitHub's `GET /git/ref/{ref}` answers it (the singular route is an exact match; a ref that does not exist is a 404).
    const ref = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/git/ref/(.+)$`).exec(req.path);
    if (req.method === "GET" && ref) {
      if (decodeURIComponent(ref[1]!) !== `heads/${w.baseRef}`) return err(404, "Not Found");
      return json(200, { ref: `refs/heads/${w.baseRef}`, node_id: "REF_x", url: `https://api.github.com${base}/git/refs/heads/${w.baseRef}`, object: { sha: w.baseTipSha, type: "commit", url: `https://api.github.com${base}/git/commits/${w.baseTipSha}` } });
    }

    // The data API for a commit's tree id, and the tree behind it. The tree id is the commit sha reversed: stable, unique and invertible, so
    // the fake needs no registry of commits (any well-formed sha has a tree; a commit with no `trees` entry has the empty one).
    const treeId = (commitSha: string): string => [...commitSha].reverse().join("");
    const escBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const dataCommit = new RegExp(`^${escBase}/git/commits/([0-9a-f]{40})$`).exec(req.path);
    if (req.method === "GET" && dataCommit) {
      const sha = dataCommit[1]!;
      return json(200, { sha, tree: { sha: treeId(sha) }, parents: (w.commits[sha]?.parents ?? []).map((p) => ({ sha: p })) });
    }
    const dataTree = new RegExp(`^${escBase}/git/trees/([0-9a-f]{40})$`).exec(req.path);
    if (req.method === "GET" && dataTree) {
      const commitSha = treeId(dataTree[1]!);
      if (w.treeStatus !== 200) return err(w.treeStatus, "Server Error");
      if (query.get("recursive") !== "1") return err(422, "this fake serves recursive trees only");
      const entries = Object.entries(w.trees[commitSha] ?? {}).map(([path, v]) => {
        const [mode, type, sha] = v.split(" ");
        return { path, mode, type, sha, ...(type === "blob" ? { size: 1 } : {}) };
      });
      return json(200, { sha: dataTree[1], tree: entries, truncated: w.truncatedTrees.includes(commitSha) });
    }

    const checks = /^\/repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]{40})\/check-runs$/.exec(req.path);
    if (req.method === "GET" && checks) {
      const runs = w.checkRunsBySha?.[checks[1]!] ?? w.checkRuns ?? w.checkNames.map((name) => ({ name, status: "completed" as const, conclusion: "success" as string | null }));
      // The default `filter` is `latest`: of the runs that share a name only the newest is listed (`all` lists every one). The list is oldest first.
      const wanted = query.get("filter") === "all" ? runs : runs.filter((r, i) => runs.map((o) => o.name).lastIndexOf(r.name) === i);
      const list = wanted.map((r, i) => ({ id: i + 1, head_sha: checks[1], name: r.name, status: r.status, conclusion: r.status === "completed" ? r.conclusion : null, app: { id: 1 } }));
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
