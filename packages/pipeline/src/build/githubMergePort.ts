import {
  SHA_PATTERN,
  type CheckRunState,
  type CiSnapshot,
  type CommitStatusState,
  type MergeBlockReason,
  type MergeCallOutcome,
  type MergeGateGitHubPort,
  type PullRequestState,
  type RequiredAppCheck,
} from "./mergeGate.js";
import type { PullRequestRef } from "./types.js";

/**
 * D#2 H14c-1: the production `MergeGateGitHubPort` over GitHub's REST API.
 *
 * Transport is injected (`GitHubHttp`): the composition root (H14c-3) owns
 * the App installation token and the actual `fetch`; this file adds no
 * dependency and reads no environment. Every method fails CLOSED:
 *   - an unexpected status or a response of the wrong shape THROWS (the
 *     workflow step retries), it is never read as "green" or "merged";
 *   - the merge call always carries GitHub's `sha` parameter, so a push
 *     after the gate's reads makes GitHub answer 409 instead of merging an
 *     unreviewed head;
 *   - CI is collected across EVERY page and returned with the API's
 *     `total_count`, plus the required contexts of the PR's base branch.
 *
 * Only structured fields are read from any response (never a PR body, title
 * or label), the same rule the gate itself keeps.
 */

export interface GitHubHttpRequest {
  method: "GET" | "POST" | "PUT";
  path: string;
  query?: Readonly<Record<string, string | number>>;
  body?: unknown;
}

export interface GitHubHttpResponse {
  status: number;
  body: unknown;
}

export interface GitHubHttp {
  /** Resolves for ANY HTTP status; rejects only on a transport failure. */
  request(req: GitHubHttpRequest): Promise<GitHubHttpResponse>;
}

/**
 * D#6 R3c: a GitHub client for a `runner_local` repo. It is `localOnlyGithub`'s shape: `request` only ever forwards the allowlist's
 * REST calls (anything else rejects before a request is made), and `graphql` runs one of the fixed documents by name.
 */
export type LocalGraphqlOperation = "PullRequestFiles" | "CommitChecks";
export interface LocalGitHubHttp extends GitHubHttp {
  graphql(op: LocalGraphqlOperation, variables: Readonly<Record<string, unknown>>): Promise<GitHubHttpResponse>;
}
export const isLocalGitHubHttp = (http: GitHubHttp): http is LocalGitHubHttp => typeof (http as Partial<LocalGitHubHttp>).graphql === "function";

export interface GitHubMergePortDeps {
  http: GitHubHttp;
  /** `repos.id` -> the GitHub owner and repository name. */
  resolveRepo(repoId: string): Promise<{ owner: string; name: string }>;
  /** The "ready, human merges" marking is display only (C11); how it is
   * shown (label, check, comment) is the composition root's choice. */
  markReadyForHumanMerge(pr: PullRequestRef, args: { headSha: string; reasons: readonly MergeBlockReason[] }): Promise<void>;
  mergeMethod?: "merge" | "squash" | "rebase";
  /**
   * D#6 R3c: set for a `runner_local` repo. Every read the port makes then stays inside the local-only allowlist: the pull request
   * comes from the list call (A3) filtered by the run's recorded branch, CI from the `CommitChecks` document (A9), protection from
   * the one protection call (A8), and the merge is A10. No check-run, status or rules REST path is called, and no check output is read.
   * `http` is a client that enforces the allowlist; the port also simply makes no other call.
   */
  local?: { http: LocalGitHubHttp; recordedBranch(pr: PullRequestRef): Promise<string> };
}

const PER_PAGE = 100;
/** A hard ceiling on pages per list (10,000 items). Hitting it leaves the
 * collected list shorter than `total_count`, which the gate reads as not green. */
const MAX_PAGES = 100;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
/** Ruleset rule types that make a base branch "protected" for the merge gate: reviewed pull requests, required checks, or no force-push. */
const PROTECTING_RULE_TYPES: ReadonlySet<string> = new Set(["pull_request", "required_status_checks", "non_fast_forward"]);

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

function bad(what: string): never {
  throw new Error(`GitHub response malformed: ${what}`);
}

/** Pages of the rollup read for one commit (100 each). Past that the snapshot says it is incomplete. */
const LOCAL_CHECK_PAGES = 20;

function dig(root: unknown, keys: readonly string[]): unknown {
  let at: unknown = root;
  for (const k of keys) {
    if (!isObj(at)) return undefined;
    at = at[k];
  }
  return at;
}

function segment(s: string): string {
  return s.split("/").map(encodeURIComponent).join("/");
}

export function createGitHubMergeGatePort(deps: GitHubMergePortDeps): MergeGateGitHubPort {
  async function repoPath(pr: PullRequestRef): Promise<string> {
    if (!Number.isSafeInteger(pr.prNumber) || pr.prNumber <= 0) throw new Error("invalid PR number");
    const { owner, name } = await deps.resolveRepo(pr.repoId);
    if (!NAME.test(owner) || !NAME.test(name)) throw new Error("invalid GitHub repository identity");
    return `/repos/${owner}/${name}`;
  }

  async function get(path: string, query?: Record<string, string | number>): Promise<GitHubHttpResponse> {
    return deps.http.request({ method: "GET", path, query });
  }

  async function okBody(res: GitHubHttpResponse, what: string): Promise<Json> {
    if (res.status !== 200 || !isObj(res.body)) throw new Error(`GitHub ${what}: unexpected status ${res.status}`);
    return res.body;
  }

  /** A3: the run's pull request, found by its recorded head branch (any state) and then by number. Nothing is read but the list's own fields. */
  async function readPrLocal(pr: PullRequestRef, branch: string): Promise<Json> {
    const { owner } = await deps.resolveRepo(pr.repoId);
    const res = await get(`${await repoPath(pr)}/pulls`, { head: `${owner}:${branch}`, state: "all", per_page: 100 });
    if (res.status !== 200 || !Array.isArray(res.body)) throw new Error(`GitHub get pull request: unexpected status ${res.status}`);
    const mine = res.body.filter((p): p is Json => isObj(p) && p.number === pr.prNumber);
    if (mine.length !== 1) throw new Error("GitHub get pull request: the recorded pull request was not listed");
    const found = mine[0]!;
    const head = found.head;
    // Only the run's own branch of this repository: the head repository must be the base repository.
    if (!isObj(head) || head.ref !== branch || !isObj(head.repo) || typeof head.repo.full_name !== "string") bad("pull.head");
    const base = isObj(found.base) ? found.base : null;
    if (base === null || !isObj(base.repo) || typeof base.repo.full_name !== "string" || base.repo.full_name.toLowerCase() !== head.repo.full_name.toLowerCase()) bad("pull.base.repo");
    // The list shape has no `merged` flag: a closed pull request is merged exactly when `merged_at` is set.
    if (found.merged_at !== null && found.merged_at !== undefined && typeof found.merged_at !== "string") bad("pull.merged_at");
    return { ...found, merged: typeof found.merged_at === "string" };
  }

  async function readPr(pr: PullRequestRef): Promise<{ state: PullRequestState; baseRef: string }> {
    const body = deps.local ? await readPrLocal(pr, await deps.local.recordedBranch(pr)) : await okBody(await get(`${await repoPath(pr)}/pulls/${pr.prNumber}`), "get pull request");
    const head = body.head;
    const base = body.base;
    if (!isObj(head) || typeof head.sha !== "string") bad("pull.head.sha");
    if (!isObj(base) || typeof base.ref !== "string" || base.ref === "") bad("pull.base.ref");
    if (body.state !== "open" && body.state !== "closed") bad("pull.state");
    if (typeof body.merged !== "boolean" && body.merged !== undefined) bad("pull.merged");
    return {
      state: {
        headSha: head.sha,
        state: body.state,
        merged: body.merged === true,
        // Anything other than an explicit false is treated as a draft.
        draft: body.draft !== false,
      },
      baseRef: base.ref,
    };
  }

  /** Every item of a list the API pages by `page`/`per_page`. */
  async function collect<T>(
    path: string,
    listKey: string,
    query: Record<string, string | number>,
    pick: (item: unknown) => T,
    key: (item: T) => string,
  ): Promise<{ items: T[]; totalCount: number; last: Json }> {
    const items: T[] = [];
    const seen = new Set<string>();
    let totalCount = 0;
    let last: Json = {};
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await get(path, { ...query, per_page: PER_PAGE, page });
      const body = await okBody(res, path);
      const list = body[listKey];
      if (!Array.isArray(list)) bad(`${listKey} is not a list`);
      if (typeof body.total_count !== "number") bad("total_count");
      // A list that changes while it is being paged (a new run listed first
      // pushes an item onto the next page) is not a snapshot: refuse it
      // rather than read a mix of two states as complete (CWE-362).
      if (page > 1 && body.total_count !== totalCount) throw new Error(`GitHub ${path}: total_count changed between pages`);
      totalCount = body.total_count;
      last = body;
      for (const item of list.map(pick)) {
        const k = key(item);
        if (seen.has(k)) throw new Error(`GitHub ${path}: item repeated across pages`);
        seen.add(k);
        items.push(item);
      }
      if (list.length < PER_PAGE || items.length >= totalCount) break;
    }
    return { items, totalCount, last };
  }

  /** An app binding: absent or null means "any source"; anything else must
   * be an integer and is then matched against the check run's app. */
  function appBinding(v: unknown, what: string): number | null {
    if (v === undefined || v === null) return null;
    if (typeof v !== "number" || !Number.isSafeInteger(v)) bad(what);
    return v;
  }

  /**
   * A8, for a `runner_local` repo: the one protection call. The classic rule is all that can be read through the allowlist, so a
   * branch guarded only by a ruleset reads as "not protected" here (the gate then blocks with `no_branch_protection`); that is the
   * fail-closed side. 403 and any other 404 mean the rule is unreadable, and CI never reads green from that.
   */
  async function requiredContextsLocal(pr: PullRequestRef, baseRef: string): Promise<{ contexts: string[]; appBound: RequiredAppCheck[]; protectedBase: boolean; unreadable: boolean }> {
    const prot = await get(`${await repoPath(pr)}/branches/${encodeURIComponent(baseRef)}/protection`);
    if (prot.status === 404 && isObj(prot.body) && prot.body.message === "Branch not protected") return { contexts: [], appBound: [], protectedBase: false, unreadable: false };
    if (prot.status === 403 || prot.status === 404) return { contexts: [], appBound: [], protectedBase: false, unreadable: true };
    if (prot.status !== 200 || !isObj(prot.body)) throw new Error(`GitHub branch protection: unexpected status ${prot.status}`);
    const contexts = new Set<string>();
    const bound = new Map<string, RequiredAppCheck>();
    const need = (context: string, appId: number | null) => {
      contexts.add(context);
      if (appId !== null) bound.set(`${appId}:${context}`, { context, appId });
    };
    const checks = prot.body.required_status_checks;
    if (checks !== undefined && checks !== null) {
      if (!isObj(checks)) bad("protection.required_status_checks");
      for (const c of Array.isArray(checks.contexts) ? checks.contexts : []) {
        if (typeof c !== "string") bad("protection.contexts");
        need(c, null);
      }
      for (const c of Array.isArray(checks.checks) ? checks.checks : []) {
        if (!isObj(c) || typeof c.context !== "string") bad("protection.checks");
        need(c.context, appBinding(c.app_id, "protection.checks.app_id"));
      }
    }
    const appBound = [...bound.values()].sort((a, b) => a.appId - b.appId || a.context.localeCompare(b.context));
    return { contexts: [...contexts].sort(), appBound, protectedBase: true, unreadable: false };
  }

  async function requiredContexts(pr: PullRequestRef, baseRef: string): Promise<{ contexts: string[]; appBound: RequiredAppCheck[]; protectedBase: boolean; unreadable: boolean }> {
    if (deps.local) return requiredContextsLocal(pr, baseRef);
    const repo = await repoPath(pr);
    // D#6 R3b: whether anything protects the base branch (a classic rule, even one with no required checks, or a ruleset).
    let protectedBase = false;
    const contexts = new Set<string>();
    const bound = new Map<string, RequiredAppCheck>();
    const need = (context: string, appId: number | null) => {
      contexts.add(context);
      if (appId !== null) bound.set(`${appId}:${context}`, { context, appId });
    };

    // Classic branch protection. 404 means "no required checks" ONLY with GitHub's own two messages. A 403 (private repository
    // on a plan without protection, or the App cannot read it) or any other 404 means we cannot see protection: that reads
    // as "not protected" (the gate blocks with no_branch_protection) and nothing else is consulted, because required checks
    // we could not read must not be assumed absent. Any other status throws, and the gate fails closed as an error.
    const prot = await get(`${repo}/branches/${segment(baseRef)}/protection/required_status_checks`);
    if (prot.status === 200 && isObj(prot.body)) {
      protectedBase = true;
      for (const c of Array.isArray(prot.body.contexts) ? prot.body.contexts : []) {
        if (typeof c !== "string") bad("protection.contexts");
        need(c, null);
      }
      for (const c of Array.isArray(prot.body.checks) ? prot.body.checks : []) {
        if (!isObj(c) || typeof c.context !== "string") bad("protection.checks");
        need(c.context, appBinding(c.app_id, "protection.checks.app_id"));
      }
    } else if (prot.status === 404 && isObj(prot.body) && prot.body.message === "Branch not protected") {
      // No classic rule: rulesets below may still protect the branch.
    } else if (prot.status === 404 && isObj(prot.body) && prot.body.message === "Required status checks not enabled") {
      // The branch has a classic protection rule; it just requires no checks.
      protectedBase = true;
    } else if (prot.status === 403 || prot.status === 404) {
      // The required checks are unknown, so the snapshot says so and CI never reads green from it (`isCiGreen`).
      return { contexts: [], appBound: [], protectedBase: false, unreadable: true };
    } else {
      throw new Error(`GitHub branch protection: unexpected status ${prot.status}`);
    }

    // Rulesets that apply to the base branch.
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await get(`${repo}/rules/branches/${segment(baseRef)}`, { per_page: PER_PAGE, page });
      if (res.status !== 200 || !Array.isArray(res.body)) throw new Error(`GitHub branch rules: unexpected status ${res.status}`);
      for (const rule of res.body) {
        if (!isObj(rule)) bad("rule");
        // GitHub lists only the active rulesets' rules here; a rule that says otherwise is ignored as well. Only a rule that
        // controls how commits reach the branch counts as protection: a ruleset of `deletion` or `creation` rules alone does not.
        if (typeof rule.enforcement === "string" && rule.enforcement !== "active") continue;
        if (typeof rule.type === "string" && PROTECTING_RULE_TYPES.has(rule.type)) protectedBase = true;
        if (rule.type !== "required_status_checks") continue;
        const params = rule.parameters;
        if (!isObj(params) || !Array.isArray(params.required_status_checks)) bad("rule.parameters");
        for (const c of params.required_status_checks) {
          if (!isObj(c) || typeof c.context !== "string") bad("rule.required_status_checks");
          need(c.context, appBinding(c.integration_id, "rule.required_status_checks.integration_id"));
        }
      }
      if (res.body.length < PER_PAGE) break;
      if (page === MAX_PAGES) throw new Error("GitHub branch rules: too many pages");
    }
    const appBound = [...bound.values()].sort((a, b) => a.appId - b.appId || a.context.localeCompare(b.context));
    return { contexts: [...contexts].sort(), appBound, protectedBase, unreadable: false };
  }

  /** A9: every check run and status context on the pull request's last commit, from the fixed `CommitChecks` document. Names, states and conclusions only. */
  async function localSnapshot(pr: PullRequestRef, baseRef: string): Promise<CiSnapshot> {
    const local = deps.local!;
    const { owner, name } = await deps.resolveRepo(pr.repoId);
    const checkRuns: CheckRunState[] = [];
    const statuses: CommitStatusState[] = [];
    let oid = "";
    let totalCount = 0;
    let complete = false;
    let cursor: string | null = null;
    for (let page = 1; page <= LOCAL_CHECK_PAGES; page++) {
      const res = await local.http.graphql("CommitChecks", { owner, name, number: pr.prNumber, ...(cursor === null ? {} : { cursor }) });
      if (res.status !== 200 || !isObj(res.body)) throw new Error(`GitHub commit checks: unexpected status ${res.status}`);
      // GraphQL answers errors with status 200: an errors array is a failure and never an empty (green-looking) list.
      if (res.body.errors !== undefined) throw new Error("GitHub commit checks: GraphQL error");
      const pull = dig(res.body, ["data", "repository", "pullRequest"]);
      const nodes = isObj(pull) && isObj(pull.commits) && Array.isArray(pull.commits.nodes) ? pull.commits.nodes : bad("commits");
      const first: unknown = nodes[0];
      if (nodes.length !== 1 || !isObj(first) || !isObj(first.commit) || typeof first.commit.oid !== "string") bad("commit");
      const commit = (first as Json).commit as Json;
      oid = commit.oid as string;
      const rollup = commit.statusCheckRollup;
      if (rollup === null) {
        // No check and no status has been posted on the commit.
        totalCount = 0;
        complete = true;
        break;
      }
      const contexts = isObj(rollup) && isObj(rollup.contexts) ? rollup.contexts : bad("statusCheckRollup.contexts");
      if (typeof contexts.totalCount !== "number" || !Array.isArray(contexts.nodes) || !isObj(contexts.pageInfo)) bad("contexts");
      if (page > 1 && contexts.totalCount !== totalCount) throw new Error("GitHub commit checks: totalCount changed between pages");
      totalCount = contexts.totalCount as number;
      for (const node of contexts.nodes as unknown[]) {
        if (!isObj(node)) bad("context");
        if (node.__typename === "CheckRun") {
          if (typeof node.name !== "string" || typeof node.status !== "string") bad("check_run");
          if (node.conclusion !== null && typeof node.conclusion !== "string") bad("check_run.conclusion");
          const app = isObj(node.checkSuite) && isObj(node.checkSuite.app) ? node.checkSuite.app.databaseId : null;
          checkRuns.push({ name: node.name as string, status: (node.status as string).toLowerCase(), conclusion: node.conclusion === null ? null : (node.conclusion as string).toLowerCase(), appId: typeof app === "number" ? app : null });
        } else if (node.__typename === "StatusContext") {
          if (typeof node.context !== "string" || typeof node.state !== "string") bad("status");
          statuses.push({ context: node.context as string, state: (node.state as string).toLowerCase() });
        } else {
          bad("context.__typename");
        }
      }
      const info = contexts.pageInfo as Json;
      if (info.hasNextPage !== true) {
        complete = checkRuns.length + statuses.length === totalCount;
        break;
      }
      cursor = typeof info.endCursor === "string" ? info.endCursor : bad("pageInfo.endCursor");
    }
    const required = await requiredContexts(pr, baseRef);
    // An incomplete read (more pages than the cap, or a count that does not add up) disagrees with its own total, which the gate reads as not green.
    const missing = complete ? 0 : 1;
    return {
      headSha: oid,
      checkRuns,
      checkRunsTotalCount: checkRuns.length + missing,
      statuses,
      statusesTotalCount: statuses.length,
      requiredContexts: required.contexts,
      requiredAppChecks: required.appBound,
      baseBranchProtected: required.protectedBase,
      ...(required.unreadable ? { protectionUnreadable: true } : {}),
    };
  }

  return {
    async getPullRequest(pr) {
      return (await readPr(pr)).state;
    },

    async getCiSnapshot(pr, headSha) {
      if (!SHA_PATTERN.test(headSha)) throw new Error("getCiSnapshot: malformed head SHA");
      const repo = await repoPath(pr);
      const { baseRef } = await readPr(pr);
      if (deps.local) return localSnapshot(pr, baseRef);

      let attributedSha = headSha;
      const checks = await collect<CheckRunState & { id: string }>(`${repo}/commits/${headSha}/check-runs`, "check_runs", { filter: "latest" }, (raw) => {
        if (!isObj(raw) || typeof raw.name !== "string" || typeof raw.status !== "string") bad("check_run");
        if (raw.conclusion !== null && typeof raw.conclusion !== "string") bad("check_run.conclusion");
        // A run GitHub attributes to another commit makes the snapshot
        // answer for that commit, which the gate then rejects.
        if (raw.head_sha !== headSha) attributedSha = typeof raw.head_sha === "string" ? raw.head_sha : "";
        if (typeof raw.id !== "number" && typeof raw.id !== "string") bad("check_run.id");
        const appId = isObj(raw.app) && typeof raw.app.id === "number" ? raw.app.id : null;
        return { id: String(raw.id), name: raw.name, status: raw.status, conclusion: raw.conclusion, appId };
      }, (c) => c.id);
      const statuses = await collect<CommitStatusState>(`${repo}/commits/${headSha}/status`, "statuses", {}, (raw) => {
        if (!isObj(raw) || typeof raw.context !== "string" || typeof raw.state !== "string") bad("status");
        return { context: raw.context, state: raw.state };
      }, (s) => s.context);
      if (statuses.last.sha !== headSha) attributedSha = typeof statuses.last.sha === "string" ? statuses.last.sha : "";

      const required = await requiredContexts(pr, baseRef);
      const snapshot: CiSnapshot = {
        headSha: attributedSha,
        checkRuns: checks.items.map(({ name, status, conclusion, appId }) => ({ name, status, conclusion, appId })),
        checkRunsTotalCount: checks.totalCount,
        statuses: statuses.items,
        statusesTotalCount: statuses.totalCount,
        requiredContexts: required.contexts,
        requiredAppChecks: required.appBound,
        baseBranchProtected: required.protectedBase,
        ...(required.unreadable ? { protectionUnreadable: true } : {}),
      };
      return snapshot;
    },

    async mergePullRequest(pr, args): Promise<MergeCallOutcome> {
      // Never call the merge endpoint without a well-formed `sha`.
      if (!SHA_PATTERN.test(args.sha)) throw new Error("mergePullRequest: malformed sha");
      const res = await deps.http.request({
        method: "PUT",
        path: `${await repoPath(pr)}/pulls/${pr.prNumber}/merge`,
        body: { sha: args.sha, merge_method: deps.mergeMethod ?? "squash" },
      });
      // Merged only on GitHub's explicit 200 + `merged: true`.
      if (res.status === 200 && isObj(res.body) && res.body.merged === true) return { merged: true };
      return { merged: false, httpStatus: res.status };
    },

    markReadyForHumanMerge: (pr, args) => deps.markReadyForHumanMerge(pr, args),
  };
}
