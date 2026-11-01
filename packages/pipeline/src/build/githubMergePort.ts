import {
  SHA_PATTERN,
  type CheckRunState,
  type CiSnapshot,
  type CommitStatusState,
  type DequeueOutcome,
  type EnqueueOutcome,
  type QueueEntryReading,
  type QueueEntryState,
  type MergeBlockReason,
  type MergeQueueMode,
  type MergeCallOutcome,
  type BranchComparison,
  type CompareStatus,
  type MergeGateGitHubPort,
  type MergeableState,
  type PullRequestMergeability,
  type PullRequestState,
  type UpdateBranchOutcome,
  type RequiredAppCheck,
} from "./mergeGate.js";
import { readCleanMerge, type CleanMergeReading } from "./treeMerge.js";
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

/**
 * D#694 B5 and B6-1: the five GraphQL documents the hosted `merge_gate` client lets through (`@fx/github`'s mergeGateGraphql.ts, pinned there byte for byte).
 * The composition root hands them in, because this package does not depend on @fx/github; the port never writes a document of its own, so a document the
 * client has not pinned cannot be sent from here.
 */
export interface MergeQueueDocuments {
  read: string;
  enqueue: string;
  autoMerge: string;
  /** B6-1: `dequeuePullRequest`. */
  dequeue: string;
  /** B6-1: the pull request and its queue entry, by number. */
  entry: string;
}

export interface GitHubMergePortDeps {
  http: GitHubHttp;
  /** D#694 B5: absent, the port has no queue and every base branch is `direct` (today's behaviour). */
  queueDocuments?: MergeQueueDocuments;
  /** The clock for the queue-mode cache (milliseconds); defaults to `Date.now`. */
  now?: () => number;
  /** `repos.id` -> the GitHub owner and repository name. */
  resolveRepo(repoId: string): Promise<{ owner: string; name: string }>;
  /** The "ready, human merges" marking is display only (C11); how it is
   * shown (label, check, comment) is the composition root's choice. */
  markReadyForHumanMerge(pr: PullRequestRef, args: { headSha: string; reasons: readonly MergeBlockReason[] }): Promise<void>;
  mergeMethod?: "merge" | "squash" | "rebase";
  /**
   * D#519 MQ1: waits between reads while GitHub is still computing `mergeable` (it answers `null`). Defaults to a real timer. The
   * wait is short and bounded by `mergeablePollLimit` reads; a caller that must not wait in a step passes a shorter limit.
   */
  sleep?: (ms: number) => Promise<void>;
  mergeablePollLimit?: number;
  mergeablePollIntervalMs?: number;
  /**
   * D#6 R3c: set for a `runner_local` repo. Every read the port makes then stays inside the local-only allowlist: the pull request
   * comes from the list call (A3) filtered by the run's recorded branch, CI from the `CommitChecks` document (A9), protection from
   * the one protection call (A8), and the merge is A10. No check-run, status or rules REST path is called, and no check output is read.
   * `http` is a client that enforces the allowlist; the port also simply makes no other call.
   */
  local?: { http: LocalGitHubHttp; recordedBranch(pr: PullRequestRef): Promise<string> };
}

/** D#519 policy constants: how many reads (the first included) a `null` `mergeable` gets, and the wait between them. */
export const MERGEABLE_POLL_LIMIT = 6;
export const MERGEABLE_POLL_INTERVAL_MS = 2000;
const MERGEABLE_STATES: ReadonlySet<string> = new Set(["clean", "behind", "dirty", "blocked", "unstable", "has_hooks", "draft", "unknown"]);
const COMPARE_STATUSES: ReadonlySet<string> = new Set(["ahead", "behind", "diverged", "identical"]);
/** GitHub's own 404 messages for "no classic rule" and "a rule that requires no status checks". */
const NO_RULE_MESSAGES: ReadonlySet<string> = new Set(["Branch not protected", "Required status checks not enabled"]);
/** D#694 B5: one queue answer per (repository, base branch), for five minutes, in this process; the oldest goes out past 500. */
export const MERGE_QUEUE_MODE_TTL_MS = 5 * 60_000;
export const MERGE_QUEUE_MODE_CACHE_MAX = 500;
const queueModeCache = new Map<string, { at: number; value: MergeQueueMode }>();
/** Empties the queue-mode cache (a test, or a caller that must read afresh). */
export function clearMergeQueueModeCache(): void {
  queueModeCache.clear();
}
const QUEUE_ENTRY_STATES: ReadonlySet<string> = new Set(["AWAITING_CHECKS", "LOCKED", "MERGEABLE", "QUEUED", "UNMERGEABLE"]);
const NODE_ID = /^[A-Za-z0-9_=-]{1,100}$/;
const LOCAL_REFUSED = "not available on a runner_local repository's allowlist";

/** GitHub returns at most this many files for one comparison, on its first response only. */
export const COMPARE_FILES_CAP = 300;

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

/**
 * D#519 MQ3-a: one commit as GitHub reports it, structured fields only. `authorLogin` is the GitHub account the commit's AUTHOR
 * resolves to (`author.login`; null when it resolves to none), `verified` is GitHub's own signature verdict for the commit
 * (`commit.verification.verified`). `files` are the paths the commit changed against its FIRST parent (a rename lists both names), or
 * `null` when the list is cut at GitHub's cap (`filesTruncated`), in which case the set is unknown.
 */
export interface CommitInfo {
  sha: string;
  parents: readonly string[];
  authorLogin: string | null;
  committerLogin: string | null;
  verified: boolean;
  verificationReason: string | null;
  files: readonly string[] | null;
  filesTruncated: boolean;
}

/** D#519 MQ3-a: the one read the refresh verification adds to the merge port. Kept apart so `MergeGateGitHubPort` is unchanged. */
export interface CommitReaderPort {
  getCommit(pr: PullRequestRef, sha: string): Promise<CommitInfo>;
  /**
   * Whether `head`'s tree is exactly the clean three-way merge of `from` and `other` over their unique merge base (see `treeMerge.ts`).
   * Any read that fails, a truncated tree or a non-unique merge base answers `clean: false`; only a transport failure throws.
   */
  checkCleanMerge(pr: PullRequestRef, args: { from: string; other: string; head: string }): Promise<CleanMergeReading>;
}

/** D#519 MQ-MAIN-RED-GUARD: the repository's default branch and the commit it points at now. */
export interface DefaultBranchReaderPort {
  getDefaultBranchTip(pr: PullRequestRef): Promise<{ branch: string; sha: string }>;
}

export function createGitHubMergeGatePort(deps: GitHubMergePortDeps): MergeGateGitHubPort & CommitReaderPort & DefaultBranchReaderPort {
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

  async function readPrBody(pr: PullRequestRef): Promise<Json> {
    return deps.local ? readPrLocal(pr, await deps.local.recordedBranch(pr)) : okBody(await get(`${await repoPath(pr)}/pulls/${pr.prNumber}`), "get pull request");
  }

  async function readPr(pr: PullRequestRef): Promise<{ state: PullRequestState; baseRef: string }> {
    return parsePr(await readPrBody(pr));
  }

  /**
   * D#519 MQ1: one read of the PR with its mergeability. The single-PR read always carries `mergeable` (boolean, or `null` while
   * GitHub computes it) and `mergeable_state`; a response without them is malformed, not "clean". The list read a `runner_local`
   * repo is limited to carries neither, so there `mergeable` stays `null` and nothing is classified from it.
   */
  async function readMergeabilityOnce(pr: PullRequestRef): Promise<PullRequestMergeability> {
    const body = await readPrBody(pr);
    const { state } = parsePr(body);
    if (deps.local) return { headSha: state.headSha, state: state.state, merged: state.merged, mergeable: null, mergeableState: "unknown" };
    if (body.mergeable !== null && typeof body.mergeable !== "boolean") bad("pull.mergeable");
    if (typeof body.mergeable_state !== "string") bad("pull.mergeable_state");
    const mergeableState: MergeableState = MERGEABLE_STATES.has(body.mergeable_state) ? (body.mergeable_state as MergeableState) : "unknown";
    return { headSha: state.headSha, state: state.state, merged: state.merged, mergeable: body.mergeable, mergeableState };
  }

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  /** Reads until GitHub has computed `mergeable` or the bound is spent; the last read is returned, `null` included. */
  async function readMergeability(pr: PullRequestRef, gatedHeadSha?: string): Promise<PullRequestMergeability> {
    const limit = Math.max(1, deps.mergeablePollLimit ?? MERGEABLE_POLL_LIMIT);
    let m = await readMergeabilityOnce(pr);
    for (let reads = 1; m.mergeable === null && !deps.local && reads < limit && (gatedHeadSha === undefined || m.headSha === gatedHeadSha); reads++) {
      await sleep(deps.mergeablePollIntervalMs ?? MERGEABLE_POLL_INTERVAL_MS);
      m = await readMergeabilityOnce(pr);
    }
    return m;
  }

  function parsePr(body: Json): { state: PullRequestState; baseRef: string } {
    const head = body.head;
    const base = body.base;
    if (!isObj(head) || typeof head.sha !== "string") bad("pull.head.sha");
    if (!isObj(base) || typeof base.ref !== "string" || base.ref === "") bad("pull.base.ref");
    if (!isObj(base.repo) || typeof base.repo.default_branch !== "string" || base.repo.default_branch === "") bad("pull.base.repo.default_branch");
    if (body.state !== "open" && body.state !== "closed") bad("pull.state");
    if (typeof body.merged !== "boolean" && body.merged !== undefined) bad("pull.merged");
    return {
      state: {
        headSha: head.sha,
        state: body.state,
        merged: body.merged === true,
        // Anything other than an explicit false is treated as a draft.
        draft: body.draft !== false,
        baseRef: base.ref,
        defaultBranch: base.repo.default_branch,
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

  /** Every rule the rulesets apply to the base branch, across all pages. */
  async function listRules(repo: string, baseRef: string): Promise<Json[]> {
    const rules: Json[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await get(`${repo}/rules/branches/${segment(baseRef)}`, { per_page: PER_PAGE, page });
      if (res.status !== 200 || !Array.isArray(res.body)) throw new Error(`GitHub branch rules: unexpected status ${res.status}`);
      for (const rule of res.body) {
        if (!isObj(rule)) bad("rule");
        rules.push(rule);
      }
      if (res.body.length < PER_PAGE) break;
      if (page === MAX_PAGES) throw new Error("GitHub branch rules: too many pages");
    }
    return rules;
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
    for (const rule of await listRules(repo, baseRef)) {
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

  const queueKey = async (pr: PullRequestRef, baseRef: string): Promise<string> => {
    const { owner, name } = await deps.resolveRepo(pr.repoId);
    return `${owner.toLowerCase()}/${name.toLowerCase()}#${baseRef}`;
  };

  /** Drops every cached queue answer of the repository (all its base branches): a refusal that names the queue means the `direct` answer is stale. */
  async function evictRepo(pr: PullRequestRef): Promise<void> {
    const { owner, name } = await deps.resolveRepo(pr.repoId);
    const prefix = `${owner.toLowerCase()}/${name.toLowerCase()}#`;
    for (const key of [...queueModeCache.keys()]) if (key.startsWith(prefix)) queueModeCache.delete(key);
  }

  async function graphql(document: string, variables: Record<string, unknown>): Promise<Json> {
    const res = await deps.http.request({ method: "POST", path: "/graphql", body: { query: document, variables } });
    if (res.status !== 200 || !isObj(res.body)) throw new Error(`GitHub graphql: unexpected status ${res.status}`);
    return res.body;
  }

  /** The error kinds of a GraphQL answer, from structured fields first and GitHub's message only to tell two refusals apart. */
  function classifyGraphqlErrors(body: Json): "none" | "permission" | "head_moved" | "other" {
    if (body.errors === undefined) return "none";
    if (!Array.isArray(body.errors) || body.errors.length === 0) return "other";
    let kind: "permission" | "head_moved" | "other" = "other";
    for (const e of body.errors) {
      const message = isObj(e) && typeof e.message === "string" ? e.message : "";
      const type = isObj(e) && typeof e.type === "string" ? e.type : "";
      if (type === "FORBIDDEN" || /resource not accessible by integration/i.test(message)) return "permission";
      if (/head (branch|commit|sha|oid|ref)\b.*(modified|differ|changed|match|moved)|expected.*head|head.*expected/i.test(message)) kind = "head_moved";
    }
    return kind;
  }

  /** The pull request's GraphQL node id, from the same single-PR read the rest of the port uses. */
  async function pullRequestNodeId(pr: PullRequestRef): Promise<string> {
    const body = await readPrBody(pr);
    return typeof body.node_id === "string" && NODE_ID.test(body.node_id) ? body.node_id : bad("pull.node_id");
  }

  return {
    async getPullRequest(pr) {
      return (await readPr(pr)).state;
    },

    async getMergeQueueMode(pr, baseRef): Promise<MergeQueueMode> {
      // A runner_local repo is unchanged by this feature: its merge belongs to the runner (the gate stops before any merge call there).
      if (deps.local) return { mode: "direct", source: "runner_local" };
      const docs = deps.queueDocuments;
      if (docs === undefined) return { mode: "direct", source: "queue_not_configured" };
      try {
        if (typeof baseRef !== "string" || baseRef === "") return { mode: "unknown", source: "base_ref_missing" };
        const key = await queueKey(pr, baseRef);
        const now = (deps.now ?? Date.now)();
        const hit = queueModeCache.get(key);
        if (hit !== undefined && now - hit.at < MERGE_QUEUE_MODE_TTL_MS && now >= hit.at) return hit.value;
        queueModeCache.delete(key);
        const { owner, name } = await deps.resolveRepo(pr.repoId);
        const body = await graphql(docs.read, { owner, name, branch: baseRef });
        if (body.errors !== undefined) return { mode: "unknown", source: "graphql_error" };
        const repository = dig(body, ["data", "repository"]);
        if (!isObj(repository) || !("mergeQueue" in repository)) return { mode: "unknown", source: "graphql_shape" };
        const queue = repository.mergeQueue;
        if (queue !== null && !isObj(queue)) return { mode: "unknown", source: "graphql_shape" };
        const rules = await listRules(await repoPath(pr), baseRef);
        const ruleQueue = rules.some((r) => r.type === "merge_queue" && !(typeof r.enforcement === "string" && r.enforcement !== "active"));
        const built = rules.find((r) => r.type === "merge_queue" && !(typeof r.enforcement === "string" && r.enforcement !== "active"))?.parameters;
        const maxEntries = isObj(built) && Number.isInteger(built.max_entries_to_build) && (built.max_entries_to_build as number) >= 1 && (built.max_entries_to_build as number) <= 100 ? (built.max_entries_to_build as number) : undefined;
        const value: MergeQueueMode = queue !== null && ruleQueue ? { mode: "queue", source: "graphql_and_rules", ...(maxEntries !== undefined ? { maxEntries } : {}) } : queue === null && !ruleQueue ? { mode: "direct", source: "graphql_and_rules" } : { mode: "unknown", source: "graphql_rules_disagree" };
        if (value.mode !== "unknown") {
          if (queueModeCache.size >= MERGE_QUEUE_MODE_CACHE_MAX) queueModeCache.delete(queueModeCache.keys().next().value as string);
          queueModeCache.set(key, { at: now, value });
        }
        return value;
      } catch {
        // fx-swallow-ok: a failed read (the hosted client's refusal included) is `unknown`, which stops the gate; it is never read as `direct`, and nothing is cached
        return { mode: "unknown", source: "read_failed" };
      }
    },

    /**
     * D#694 B6-3: the base branch's merge mode and, in a queue, the batch size the rule builds at once (`max_entries_to_build`), for the product queue's in-flight bound.
     * One read of the pull request for its base branch, then the cached mode answer. A batch size that cannot be read is 1; a failed read is `unknown` with 1.
     */
    async getMergeQueueInfo(pr): Promise<{ mode: MergeQueueMode["mode"]; maxEntries: number }> {
      try {
        const m = await this.getMergeQueueMode!(pr, (await readPr(pr)).baseRef);
        return { mode: m.mode, maxEntries: m.mode === "queue" ? (m.maxEntries ?? 1) : 1 };
      } catch {
        // fx-swallow-ok: an unreadable answer is `unknown` with a bound of 1, which stops nothing from merging by hand and lets no second entry into the queue
        return { mode: "unknown", maxEntries: 1 };
      }
    },

    async enqueuePullRequest(pr, args): Promise<EnqueueOutcome> {
      if (deps.local) throw new Error(`GitHub enqueue: ${LOCAL_REFUSED}`);
      const docs = deps.queueDocuments;
      if (docs === undefined) throw new Error("GitHub enqueue: no queue documents");
      // Never call the mutation without a well-formed head to hold GitHub to.
      if (!SHA_PATTERN.test(args.expectedHeadOid)) throw new Error("enqueuePullRequest: malformed expected head");
      const evict = async () => {
        queueModeCache.delete(await queueKey(pr, (await readPr(pr)).baseRef));
      };
      const pullRequestId = await pullRequestNodeId(pr);
      const queued = await graphql(docs.enqueue, { pullRequestId, expectedHeadOid: args.expectedHeadOid });
      const kind = classifyGraphqlErrors(queued);
      if (kind === "none") {
        const entry = dig(queued, ["data", "enqueuePullRequest", "mergeQueueEntry"]);
        if (!isObj(entry) || typeof entry.id !== "string" || !NODE_ID.test(entry.id)) bad("mergeQueueEntry.id");
        const position = entry.position;
        if (position !== undefined && position !== null && !Number.isSafeInteger(position)) bad("mergeQueueEntry.position");
        return { enqueued: true, via: "queue", entryId: entry.id, position: typeof position === "number" ? position : null };
      }
      if (kind === "head_moved") {
        await evict();
        return { enqueued: false, reason: "head_moved" };
      }
      if (kind === "other") throw new Error("GitHub enqueue: GraphQL error");
      // The app may not use the queue: auto-merge is the only fallback, and only for this refusal.
      await evict();
      const auto = await graphql(docs.autoMerge, { pullRequestId, expectedHeadOid: args.expectedHeadOid, mergeMethod: "SQUASH" });
      const autoKind = classifyGraphqlErrors(auto);
      if (autoKind === "none") {
        const target = dig(auto, ["data", "enablePullRequestAutoMerge", "pullRequest"]);
        if (!isObj(target) || typeof target.id !== "string") bad("enablePullRequestAutoMerge.pullRequest");
        return { enqueued: true, via: "auto_merge", entryId: null, position: null };
      }
      if (autoKind === "head_moved") return { enqueued: false, reason: "head_moved" };
      if (autoKind === "permission") return { enqueued: false, reason: "unavailable" };
      throw new Error("GitHub auto-merge: GraphQL error");
    },

    async dequeuePullRequest(pr): Promise<DequeueOutcome> {
      if (deps.local) throw new Error(`GitHub dequeue: ${LOCAL_REFUSED}`);
      const docs = deps.queueDocuments;
      if (docs === undefined) throw new Error("GitHub dequeue: no queue documents");
      const out = await graphql(docs.dequeue, { pullRequestId: await pullRequestNodeId(pr) });
      const kind = classifyGraphqlErrors(out);
      if (kind === "permission") return { dequeued: false, reason: "unavailable" };
      if (kind === "other") {
        // GitHub names the case in words only; the message tells "not in the queue" apart from a real failure, nothing else is read from it.
        const notQueued = Array.isArray(out.errors) && out.errors.length > 0 && out.errors.every((e) => isObj(e) && typeof e.message === "string" && /not (currently )?(in|part of) the merge queue|not queued/i.test(e.message));
        if (notQueued) return { dequeued: false, reason: "not_queued" };
        throw new Error("GitHub dequeue: GraphQL error");
      }
      if (kind === "head_moved") throw new Error("GitHub dequeue: GraphQL error");
      const entry = dig(out, ["data", "dequeuePullRequest", "mergeQueueEntry"]);
      // A success that names no entry removed nothing.
      if (entry === null) return { dequeued: false, reason: "not_queued" };
      if (!isObj(entry) || typeof entry.id !== "string" || !NODE_ID.test(entry.id)) bad("mergeQueueEntry.id");
      return { dequeued: true, entryId: entry.id };
    },

    async getQueueEntry(pr): Promise<QueueEntryReading> {
      if (deps.local) throw new Error(`GitHub queue entry: ${LOCAL_REFUSED}`);
      const docs = deps.queueDocuments;
      if (docs === undefined) throw new Error("GitHub queue entry: no queue documents");
      await repoPath(pr);
      const { owner, name } = await deps.resolveRepo(pr.repoId);
      const body = await graphql(docs.entry, { owner, name, number: pr.prNumber });
      if (body.errors !== undefined) throw new Error("GitHub queue entry: GraphQL error");
      const found = dig(body, ["data", "repository", "pullRequest"]);
      if (!isObj(found)) bad("pullRequest");
      const state = typeof found.state === "string" ? found.state.toLowerCase() : "";
      if (state !== "open" && state !== "closed" && state !== "merged") bad("pullRequest.state");
      if (typeof found.merged !== "boolean") bad("pullRequest.merged");
      if (typeof found.headRefOid !== "string" || !SHA_PATTERN.test(found.headRefOid)) bad("pullRequest.headRefOid");
      const queued = found.mergeQueueEntry;
      let entry: QueueEntryReading["entry"] = null;
      if (queued !== null && queued !== undefined) {
        if (!isObj(queued) || typeof queued.id !== "string" || !NODE_ID.test(queued.id)) bad("mergeQueueEntry.id");
        if (typeof queued.state !== "string" || !QUEUE_ENTRY_STATES.has(queued.state)) bad("mergeQueueEntry.state");
        if (queued.position !== undefined && queued.position !== null && !Number.isSafeInteger(queued.position)) bad("mergeQueueEntry.position");
        entry = { id: queued.id as string, state: queued.state.toLowerCase() as QueueEntryState, position: typeof queued.position === "number" ? queued.position : null };
      }
      // GitHub's GraphQL state is OPEN, CLOSED or MERGED; a merged one is closed with the flag set.
      return { state: state === "open" ? "open" : "closed", merged: found.merged, headSha: found.headRefOid, entry };
    },

    async getDefaultBranchTip(pr) {
      if (deps.local) throw new Error(`GitHub default branch tip: ${LOCAL_REFUSED}`);
      const repo = await repoPath(pr);
      const branch = (await readPr(pr)).state.defaultBranch;
      const path = `${repo}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`;
      const body = await okBody(await get(path), "get default branch ref");
      const sha = isObj(body.object) ? body.object.sha : undefined;
      if (typeof sha !== "string" || !SHA_PATTERN.test(sha)) bad("ref.object.sha");
      return { branch, sha: sha as string };
    },

    async getCiSnapshot(pr, headSha, opts) {
      if (!SHA_PATTERN.test(headSha)) throw new Error("getCiSnapshot: malformed head SHA");
      const repo = await repoPath(pr);
      const { baseRef } = await readPr(pr);
      if (deps.local) return localSnapshot(pr, baseRef);

      let attributedSha = headSha;
      const checks = await collect<CheckRunState & { id: string }>(`${repo}/commits/${headSha}/check-runs`, "check_runs", { filter: opts?.allRuns ? "all" : "latest" }, (raw) => {
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
        checkRuns: checks.items.map(({ id, name, status, conclusion, appId }) => ({ id, name, status, conclusion, appId })),
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
      // A refusal that names the queue means the base branch is behind one now, so a cached `direct` answer is stale: drop the repository's cached answers.
      // The message only tells this refusal from the others; no decision reads anything else from it.
      if (isObj(res.body) && typeof res.body.message === "string" && /merge queue/i.test(res.body.message)) await evictRepo(pr);
      return { merged: false, httpStatus: res.status };
    },

    async getMergeability(pr, opts) {
      return readMergeability(pr, opts?.gatedHeadSha);
    },

    async updateBranch(pr, args): Promise<UpdateBranchOutcome> {
      if (deps.local) throw new Error(`GitHub update branch: ${LOCAL_REFUSED}`);
      // Never call the endpoint without a well-formed head to hold GitHub to: `expected_head_sha` is what makes a push after our
      // reads a refusal instead of a merge of a head nobody reviewed.
      if (!SHA_PATTERN.test(args.expectedHeadSha)) throw new Error("updateBranch: malformed expected head SHA");
      const res = await deps.http.request({
        method: "PUT",
        path: `${await repoPath(pr)}/pulls/${pr.prNumber}/update-branch`,
        body: { expected_head_sha: args.expectedHeadSha },
      });
      // 202 means GitHub took the request and will merge the base in LATER. It is not a refresh: the head is unchanged until a
      // later read shows otherwise.
      if (res.status === 202) return { outcome: "accepted" };
      // 403 (the App lacks the permission or the branch is not writable) and every other status are errors: the step retries.
      if (res.status !== 422) throw new Error(`GitHub update branch: unexpected status ${res.status}`);
      // A head that is not `expected_head_sha` and a merge conflict both answer 422. Only a re-read tells them apart.
      const after = await readMergeability(pr);
      if (after.headSha !== args.expectedHeadSha) {
        if (!SHA_PATTERN.test(after.headSha)) bad("pull.head.sha");
        return { outcome: "head_moved", newHeadSha: after.headSha };
      }
      if (after.mergeable === false) return { outcome: "conflict" };
      throw new Error("GitHub update branch: refused with an unmoved head and no conflict reported");
    },

    async compareToBase(pr, headSha, opts): Promise<BranchComparison> {
      if (deps.local) throw new Error(`GitHub compare: ${LOCAL_REFUSED}`);
      if (!SHA_PATTERN.test(headSha)) throw new Error("compareToBase: malformed head SHA");
      const repo = await repoPath(pr);
      const { baseRef } = await readPr(pr);
      const path = `${repo}/compare/${segment(baseRef)}...${headSha}`;
      const wantFiles = opts?.files === true;
      // GitHub's compare pages the COMMITS with per_page/page; the files come on the first response only, capped at COMPARE_FILES_CAP
      // for the whole comparison. So one request is made, and a list that reached the cap is reported as truncated.
      const res = await get(path, wantFiles ? {} : { per_page: 1 });
      const body = await okBody(res, "compare");
      if (typeof body.status !== "string" || !COMPARE_STATUSES.has(body.status)) bad("compare.status");
      if (!Number.isSafeInteger(body.ahead_by) || (body.ahead_by as number) < 0) bad("compare.ahead_by");
      if (!Number.isSafeInteger(body.behind_by) || (body.behind_by as number) < 0) bad("compare.behind_by");
      const counts = { status: body.status as CompareStatus, aheadBy: body.ahead_by as number, behindBy: body.behind_by as number };
      if (!wantFiles) return { ...counts, files: null, filesTruncated: false };
      if (!Array.isArray(body.files)) bad("compare.files");
      const files: string[] = [];
      const seen = new Set<string>();
      for (const f of body.files) {
        if (!isObj(f) || typeof f.filename !== "string") bad("compare.files.filename");
        if (f.previous_filename !== undefined && typeof f.previous_filename !== "string") bad("compare.files.previous_filename");
        if (seen.has(f.filename)) throw new Error("GitHub compare: file repeated");
        seen.add(f.filename);
        files.push(f.filename);
        // A renamed file touched both paths.
        if (typeof f.previous_filename === "string" && !seen.has(f.previous_filename)) {
          seen.add(f.previous_filename);
          files.push(f.previous_filename);
        }
      }
      // At the cap the list may be cut short and is NOT a complete set: it is withheld (files: null) so it cannot be mistaken for one.
      if (body.files.length >= COMPARE_FILES_CAP) return { ...counts, files: null, filesTruncated: true };
      return { ...counts, files, filesTruncated: false };
    },

    async requiresUpToDateBranch(pr): Promise<boolean> {
      if (deps.local) throw new Error(`GitHub branch protection strictness: ${LOCAL_REFUSED}`);
      const repo = await repoPath(pr);
      const { baseRef } = await readPr(pr);
      // Classic protection. A 404 means "no rule" ONLY with GitHub's own two messages. Unlike the CI read, a 403 or any other 404
      // is NOT "not required": an unreadable rule may well require it, so it throws and the step retries.
      const prot = await get(`${repo}/branches/${segment(baseRef)}/protection/required_status_checks`);
      if (prot.status === 200 && isObj(prot.body)) {
        if (typeof prot.body.strict !== "boolean") bad("protection.strict");
        if (prot.body.strict) return true;
      } else if (!(prot.status === 404 && isObj(prot.body) && typeof prot.body.message === "string" && NO_RULE_MESSAGES.has(prot.body.message))) {
        throw new Error(`GitHub branch protection: unexpected status ${prot.status}`);
      }
      for (const rule of await listRules(repo, baseRef)) {
        if (typeof rule.enforcement === "string" && rule.enforcement !== "active") continue;
        if (rule.type !== "required_status_checks") continue;
        const params = rule.parameters;
        if (!isObj(params) || typeof params.strict_required_status_checks_policy !== "boolean") bad("rule.parameters.strict_required_status_checks_policy");
        if (params.strict_required_status_checks_policy) return true;
      }
      return false;
    },

    async getCommit(pr, sha): Promise<CommitInfo> {
      if (deps.local) throw new Error(`GitHub get commit: ${LOCAL_REFUSED}`);
      if (!SHA_PATTERN.test(sha)) throw new Error("getCommit: malformed SHA");
      const body = await okBody(await get(`${await repoPath(pr)}/commits/${sha}`), "get commit");
      if (body.sha !== sha) bad("commit.sha");
      if (!Array.isArray(body.parents)) bad("commit.parents");
      const parents = body.parents.map((p) => {
        if (!isObj(p) || typeof p.sha !== "string" || !SHA_PATTERN.test(p.sha)) bad("commit.parents.sha");
        return p.sha;
      });
      if (body.author !== null && !isObj(body.author)) bad("commit.author");
      const authorLogin = body.author === null ? null : typeof body.author.login === "string" ? body.author.login : null;
      if (body.committer !== null && !isObj(body.committer)) bad("commit.committer");
      const committerLogin = body.committer === null ? null : typeof body.committer.login === "string" ? body.committer.login : null;
      const verification = isObj(body.commit) && isObj(body.commit.verification) ? body.commit.verification : null;
      if (verification === null || typeof verification.verified !== "boolean") bad("commit.verification.verified");
      if (!Array.isArray(body.files)) bad("commit.files");
      const files = new Set<string>();
      for (const f of body.files) {
        if (!isObj(f) || typeof f.filename !== "string") bad("commit.files.filename");
        if (f.previous_filename !== undefined && typeof f.previous_filename !== "string") bad("commit.files.previous_filename");
        files.add(f.filename);
        if (typeof f.previous_filename === "string") files.add(f.previous_filename);
      }
      // At the cap the list may be cut short: withheld, so it cannot be mistaken for a complete set.
      const truncated = body.files.length >= COMPARE_FILES_CAP;
      const verificationReason = typeof verification.reason === "string" ? verification.reason : null;
      return { sha, parents, authorLogin, committerLogin, verified: verification.verified, verificationReason, files: truncated ? null : [...files], filesTruncated: truncated };
    },

    async checkCleanMerge(pr, args): Promise<CleanMergeReading> {
      if (deps.local) throw new Error(`GitHub tree check: ${LOCAL_REFUSED}`);
      for (const sha of [args.from, args.other, args.head]) if (!SHA_PATTERN.test(sha)) throw new Error("checkCleanMerge: malformed SHA");
      const { owner, name } = await deps.resolveRepo(pr.repoId);
      return readCleanMerge(deps.http, { owner, name, ...args });
    },

    markReadyForHumanMerge: (pr, args) => deps.markReadyForHumanMerge(pr, args),
  };
}
