import { isLocalGitHubHttp, type GitHubHttp, type LocalGitHubHttp } from "../build/githubMergePort.js";
import { SHA_PATTERN } from "../build/mergeGate.js";
import { listChangedFiles, listChangedFilesLocal, type ListFilesResult } from "./githubReads.js";

/**
 * D#6 CLOUD-POSTS-FX-GATE1: the cloud's own `fx-gate1` on a paired item's public pull request head, from a green full-scope run of the public CI on that
 * exact head. The decision is pure (`decideGate1`); `attestGate1Head` reads the facts through a `Gate1Reads` adapter and acts. On a `runner_local` pair the
 * reads are the fenced code-repository client's: the files (A1 `PullRequestFiles`), the label events (A16), the check runs (A15), who posted `fx-gate1`
 * (A17); on a hosted pair they are REST reads of the `merge_gate` client. Both add `ci:full` (A14) and post `fx-gate1` (A7, fixed descriptions) with the
 * same two calls. No log is read, and no text a pull request controls is read.
 *
 * Proof is GitHub's own records only: the check runs' app id (GitHub Actions) and start times, compared with the time of the last `ci:full` label event.
 * A job that started after the label was added cannot have run at the affected scope (CI reads the label from the API when its scope step runs).
 *
 * Off unless the code repository is listed in `FX_GATE1_ATTEST_REPOS`: an unlisted repository gets no call at all (`off`), whatever its contexts are named.
 */

export const GATE1_CONTEXT = "fx-gate1";
export const FULL_CI_LABEL = "ci:full";
/** GitHub Actions' app id. Only its check runs count. */
export const ACTIONS_APP_ID = 15368;
/** The five workflow contexts of the public CI that must be green after the label. */
export const GATE1_WORKFLOW_CONTEXTS: readonly string[] = Object.freeze(["check", "e2e-runner", "workspace-e2e (desktop)", "workspace-e2e (phone)", "workspace-e2e (tablet)"]);
/** The only descriptions the fence lets through (runner-cloud `FX_GATE1_DESCRIPTIONS`; a test holds the two equal). */
export const GATE1_DESCRIPTIONS = Object.freeze({
  success: "Gate 1: full public CI green (cloud)",
  failure: Object.freeze({
    ci_red: "Gate 1: full public CI failed (cloud)",
    ci_paths: "Gate 1: the change touches CI files (cloud)",
    foreign_app: "Gate 1: a required check was not run by GitHub Actions (cloud)",
  }),
});
export const GATE1_ATTEST_ENV = "FX_GATE1_ATTEST_REPOS";

export interface Gate1LabelEvent {
  event: "labeled" | "unlabeled";
  label: string;
  createdAt: string;
}
export interface Gate1CheckRun {
  name: string;
  appId: number | null;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
}
export interface Gate1Facts {
  /** The pull request's labeled and unlabeled events, oldest first. */
  labelEvents: readonly Gate1LabelEvent[];
  /** The events read reached the newest `ci:full` event, or the start of the timeline. */
  labelEventsComplete: boolean;
  checkRuns: readonly Gate1CheckRun[];
  checkRunsComplete: boolean;
  changedPaths: readonly string[];
  changedPathsComplete: boolean;
  /** A file was renamed and its old path is not known (the fenced files read gives none): it may have been a CI path. */
  renameUnknown: boolean;
  /** `fx-gate1` = success on this sha was posted by our App's bot. */
  oursSucceeded: boolean;
}

export type Gate1WaitReason = "head_moved" | "files_incomplete" | "label_unknown" | "label_removed" | "run_before_label" | "check_running" | "check_missing" | "checks_incomplete";
export type Gate1FailReason = keyof typeof GATE1_DESCRIPTIONS.failure;
export type Gate1Decision = { verdict: "already" } | { verdict: "add_label" } | { verdict: "wait"; reason: Gate1WaitReason } | { verdict: "pass" } | { verdict: "fail"; reason: Gate1FailReason };

const ms = (iso: string | null): number => (iso === null ? Number.NaN : Date.parse(iso));

/**
 * A path a pull request may not touch and still get the cloud's Gate 1: the workflows, the CI scripts, and the Nix inputs the label's re-run workflow runs
 * with `actions: write` (TL ruling 11-07 00:45).
 */
export const isCiPath = (p: string): boolean => p.startsWith(".github/") || p.startsWith("scripts/ci/") || p === "flake.nix" || p === "flake.lock";

/**
 * The decision for one head. Pure. The file rule comes before the label, so a change to CI files never gets `ci:full` added by us; a rename whose old
 * path is unknown counts as one. Only a conclusion of exactly `success` is green: skipped, neutral, cancelled and every other one fail.
 */
export function decideGate1(f: Gate1Facts): Gate1Decision {
  if (f.oursSucceeded) return { verdict: "already" };
  if (f.renameUnknown || f.changedPaths.some(isCiPath)) return { verdict: "fail", reason: "ci_paths" };
  if (!f.changedPathsComplete) return { verdict: "wait", reason: "files_incomplete" };
  const events = f.labelEvents.filter((e) => e.label === FULL_CI_LABEL && !Number.isNaN(ms(e.createdAt)));
  if (events.length === 0) return f.labelEventsComplete ? { verdict: "add_label" } : { verdict: "wait", reason: "label_unknown" };
  const lastLabeled = events.filter((e) => e.event === "labeled").reduce((t, e) => Math.max(t, ms(e.createdAt)), Number.NEGATIVE_INFINITY);
  // A person took the label off (the newest event, or one at the same time): wait; putting it back re-runs CI. We never add it again over them.
  if (lastLabeled === Number.NEGATIVE_INFINITY || events.some((e) => e.event === "unlabeled" && ms(e.createdAt) >= lastLabeled)) return { verdict: "wait", reason: "label_removed" };
  if (!f.checkRunsComplete) return { verdict: "wait", reason: "checks_incomplete" };
  let wait: Gate1WaitReason | null = null;
  for (const name of GATE1_WORKFLOW_CONTEXTS) {
    const runs = f.checkRuns.filter((c) => c.name === name);
    if (runs.length === 0) {
      wait ??= "check_missing";
      continue;
    }
    if (runs.some((c) => c.appId !== ACTIONS_APP_ID)) return { verdict: "fail", reason: "foreign_app" };
    if (runs.some((c) => c.status !== "completed")) {
      wait ??= "check_running";
      continue;
    }
    const run = runs.reduce((a, b) => (ms(b.startedAt) > ms(a.startedAt) ? b : a));
    // A run that started before the label, or in the same second, is not full scope, red or green: the label's own re-run replaces it.
    const started = ms(run.startedAt);
    if (Number.isNaN(started) || !(started > lastLabeled)) {
      wait ??= "run_before_label";
      continue;
    }
    if (run.conclusion !== "success") return { verdict: "fail", reason: "ci_red" };
  }
  return wait !== null ? { verdict: "wait", reason: wait } : { verdict: "pass" };
}

/** `FX_GATE1_ATTEST_REPOS`: a comma list of `owner/name`. Unset or empty is off. Anything malformed throws, so the worker does not start on a typo. */
export class Gate1AttestConfigError extends Error {
  constructor() {
    super(`${GATE1_ATTEST_ENV}: expected a comma-separated list of owner/name repositories`);
    this.name = "Gate1AttestConfigError";
  }
}
const SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
export function parseGate1AttestRepos(raw: string | undefined): ReadonlySet<string> {
  if (raw === undefined || raw.trim() === "") return new Set();
  const repos = new Set<string>();
  for (const part of raw.split(",")) {
    const slug = part.trim();
    if (!SLUG.test(slug) || slug.endsWith("/.") || slug.endsWith("/..")) throw new Gate1AttestConfigError();
    repos.add(slug.toLowerCase());
  }
  return repos;
}
export const gate1AttestEnabled = (repos: ReadonlySet<string>, owner: string, name: string): boolean => repos.has(`${owner}/${name}`.toLowerCase());

export type Gate1AttestOutcome = { kind: "off" } | { kind: "already" } | { kind: "label_added" } | { kind: "wait"; reason: Gate1WaitReason } | { kind: "posted"; state: "success" } | { kind: "posted"; state: "failure"; reason: Gate1FailReason };

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const MAX_PAGES = 5;
const fail = (what: string): never => {
  throw new Error(`gate1 attest: ${what}`);
};

async function query(http: LocalGitHubHttp, op: "Gate1CheckRuns" | "Gate1LabelEvents" | "Gate1Status", variables: Record<string, unknown>): Promise<Json> {
  const res = await http.graphql(op, variables);
  // GraphQL answers errors with status 200: an errors array is a failure, never an empty list.
  if (res.status !== 200 || !isObj(res.body) || res.body.errors !== undefined || !isObj(res.body.data) || !isObj(res.body.data.repository)) return fail(`${op} unreadable`);
  return res.body.data.repository;
}

/**
 * Whether a status creator is our App's bot: typed `Bot`, its login exactly our slug (GraphQL's form) or the slug with `[bot]` (REST's form). Case counts
 * and nothing matches by prefix: another App's bot, a user whose login looks like ours, and a near-miss slug are all someone else.
 */
export function isOurBot(creator: unknown, ourLogin: string): boolean {
  if (!isObj(creator) || creator.__typename !== "Bot" || typeof creator.login !== "string") return false;
  const slug = ourLogin.replace(/\[bot\]$/, "");
  return creator.login === slug || creator.login === `${slug}[bot]`;
}

/** A17: whether our App's bot posted `fx-gate1` = success on the commit. */
async function readOursSucceeded(http: LocalGitHubHttp, repo: { owner: string; name: string; sha: string }, ourLogin: string): Promise<boolean> {
  const r = await query(http, "Gate1Status", { owner: repo.owner, name: repo.name, sha: repo.sha });
  const commit = isObj(r.object) ? r.object : fail("Gate1Status commit");
  if (commit.oid !== repo.sha) fail("Gate1Status oid");
  const ctx = isObj(commit.status) ? commit.status.context : null;
  if (!isObj(ctx)) return false;
  return ctx.state === "SUCCESS" && isOurBot(ctx.creator, ourLogin);
}

/** A16, newest page first, until a `ci:full` event is seen or the timeline starts (at most five pages). */
async function readLabelEvents(http: LocalGitHubHttp, repo: { owner: string; name: string; number: number }): Promise<{ events: Gate1LabelEvent[]; complete: boolean }> {
  const events: Gate1LabelEvent[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await query(http, "Gate1LabelEvents", { owner: repo.owner, name: repo.name, number: repo.number, ...(cursor === null ? {} : { cursor }) });
    const items = isObj(r.pullRequest) && isObj(r.pullRequest.timelineItems) ? r.pullRequest.timelineItems : fail("Gate1LabelEvents timeline");
    if (!Array.isArray(items.nodes) || !isObj(items.pageInfo)) fail("Gate1LabelEvents nodes");
    const pageEvents: Gate1LabelEvent[] = [];
    for (const n of items.nodes as unknown[]) {
      if (!isObj(n) || (n.__typename !== "LabeledEvent" && n.__typename !== "UnlabeledEvent") || typeof n.createdAt !== "string" || !isObj(n.label) || typeof n.label.name !== "string") fail("Gate1LabelEvents node");
      const node = n as Json;
      pageEvents.push({ event: node.__typename === "LabeledEvent" ? "labeled" : "unlabeled", label: (node.label as Json).name as string, createdAt: node.createdAt as string });
    }
    events.unshift(...pageEvents);
    const info = items.pageInfo as Json;
    if (info.hasPreviousPage !== true || pageEvents.some((e) => e.label === FULL_CI_LABEL)) return { events, complete: true };
    cursor = typeof info.startCursor === "string" ? info.startCursor : fail("Gate1LabelEvents startCursor");
  }
  return { events, complete: false };
}

/** A15: the check runs in the commit's rollup (status contexts arrive as a bare `__typename` and are skipped). */
async function readCheckRuns(http: LocalGitHubHttp, repo: { owner: string; name: string; sha: string }): Promise<{ runs: Gate1CheckRun[]; complete: boolean }> {
  const runs: Gate1CheckRun[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await query(http, "Gate1CheckRuns", { owner: repo.owner, name: repo.name, sha: repo.sha, ...(cursor === null ? {} : { cursor }) });
    const commit = isObj(r.object) ? r.object : fail("Gate1CheckRuns commit");
    if (commit.oid !== repo.sha) fail("Gate1CheckRuns oid");
    if (commit.statusCheckRollup === null) return { runs, complete: true };
    const contexts = isObj(commit.statusCheckRollup) && isObj(commit.statusCheckRollup.contexts) ? commit.statusCheckRollup.contexts : fail("Gate1CheckRuns contexts");
    if (!Array.isArray(contexts.nodes) || !isObj(contexts.pageInfo)) fail("Gate1CheckRuns nodes");
    for (const n of contexts.nodes as unknown[]) {
      if (!isObj(n)) fail("Gate1CheckRuns node");
      const node = n as Json;
      if (node.__typename !== "CheckRun") continue;
      if (typeof node.name !== "string" || typeof node.status !== "string" || (node.conclusion !== null && typeof node.conclusion !== "string") || (node.startedAt !== null && typeof node.startedAt !== "string")) fail("Gate1CheckRuns run");
      const app = isObj(node.checkSuite) && isObj(node.checkSuite.app) ? node.checkSuite.app.databaseId : null;
      runs.push({ name: node.name as string, appId: typeof app === "number" ? app : null, status: (node.status as string).toLowerCase(), conclusion: node.conclusion === null ? null : (node.conclusion as string).toLowerCase(), startedAt: node.startedAt as string | null });
    }
    const info = contexts.pageInfo as Json;
    if (info.hasNextPage !== true) return { runs, complete: true };
    cursor = typeof info.endCursor === "string" ? info.endCursor : fail("Gate1CheckRuns endCursor");
  }
  return { runs, complete: false };
}

type Head = { owner: string; name: string; sha: string; number: number };

/**
 * What the attester reads, behind one port with two adapters, so the same `decideGate1` runs on both paths (TL ruling 11-07 01:25):
 *  - `runner_local`: the fenced code-repository client, through its fixed documents (A1, A15, A16, A17) and nothing else;
 *  - hosted: the plain `merge_gate` client, through REST reads it already allows (no GraphQL document is added or opened).
 * The writes (the label, the status) are the same two REST calls on both clients.
 */
export interface Gate1Reads {
  oursSucceeded(ourLogin: string): Promise<boolean>;
  changedFiles(): Promise<ListFilesResult>;
  labelEvents(): Promise<{ events: Gate1LabelEvent[]; complete: boolean }>;
  checkRuns(): Promise<{ runs: Gate1CheckRun[]; complete: boolean }>;
}

export function fencedGate1Reads(http: LocalGitHubHttp, repo: Head): Gate1Reads {
  return {
    oursSucceeded: (login) => readOursSucceeded(http, repo, login),
    changedFiles: () => listChangedFilesLocal(http, { owner: repo.owner, name: repo.name, pr: repo.number }),
    labelEvents: () => readLabelEvents(http, repo),
    checkRuns: () => readCheckRuns(http, repo),
  };
}

const REST_PER_PAGE = 100;
/** The issue events list runs oldest first, so it is read to its end; past this many pages the label's state is unknown (a wait). */
const REST_EVENT_PAGES = 10;
const restBase = (r: Head) => `/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}`;
async function restList(http: GitHubHttp, path: string, page: number, extra: Record<string, string> = {}): Promise<unknown> {
  const res = await http.request({ method: "GET", path, query: { ...extra, per_page: REST_PER_PAGE, page } });
  return res.status === 200 ? res.body : fail(`GET ${path.split("/").slice(-1)[0]} answered ${res.status}`);
}

/**
 * The hosted adapter. Files: `pulls/{n}/files`, which names a rename's previous path, so both paths are checked. Label events: `issues/{n}/events`, every
 * page (a list cut short reads as no event at all, a wait). Check runs: `commits/{sha}/check-runs?filter=latest` (app id, start time). Who posted
 * `fx-gate1`: `commits/{sha}/statuses`, newest first, whose first `fx-gate1` is the context's current state; REST types the creator `Bot`.
 */
export function hostedGate1Reads(http: GitHubHttp, repo: Head): Gate1Reads {
  const base = restBase(repo);
  return {
    async oursSucceeded(login) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const list = await restList(http, `${base}/commits/${repo.sha}/statuses`, page);
        if (!Array.isArray(list)) return fail("statuses list");
        for (const s of list as unknown[]) {
          if (!isObj(s) || typeof s.context !== "string") return fail("statuses entry");
          if (s.context !== GATE1_CONTEXT) continue;
          const c = isObj(s.creator) ? s.creator : null;
          return s.state === "success" && c !== null && isOurBot({ __typename: c.type, login: c.login }, login);
        }
        if (list.length < REST_PER_PAGE) return false;
      }
      return false;
    },
    changedFiles: () => listChangedFiles(http, { owner: repo.owner, name: repo.name, pr: repo.number }),
    async labelEvents() {
      const events: Gate1LabelEvent[] = [];
      for (let page = 1; page <= REST_EVENT_PAGES; page++) {
        const list = await restList(http, `${base}/issues/${repo.number}/events`, page);
        if (!Array.isArray(list)) return fail("events list");
        for (const e of list as unknown[]) {
          if (!isObj(e) || typeof e.event !== "string") return fail("events entry");
          if (e.event !== "labeled" && e.event !== "unlabeled") continue;
          if (!isObj(e.label) || typeof e.label.name !== "string" || typeof e.created_at !== "string") return fail("label event");
          events.push({ event: e.event, label: e.label.name, createdAt: e.created_at });
        }
        if (list.length < REST_PER_PAGE) return { events, complete: true };
      }
      return { events: [], complete: false };
    },
    async checkRuns() {
      const runs: Gate1CheckRun[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const body = await restList(http, `${base}/commits/${repo.sha}/check-runs`, page, { filter: "latest" });
        if (!isObj(body) || typeof body.total_count !== "number" || !Array.isArray(body.check_runs)) return fail("check-runs list");
        for (const c of body.check_runs as unknown[]) {
          if (!isObj(c) || c.head_sha !== repo.sha || typeof c.name !== "string" || typeof c.status !== "string" || (c.conclusion !== null && typeof c.conclusion !== "string") || (c.started_at !== null && typeof c.started_at !== "string")) return fail("check run");
          const app = isObj(c.app) ? c.app.id : null;
          runs.push({ name: c.name, appId: typeof app === "number" ? app : null, status: c.status, conclusion: c.conclusion as string | null, startedAt: c.started_at as string | null });
        }
        if (body.check_runs.length < REST_PER_PAGE || runs.length >= body.total_count) return { runs, complete: true };
      }
      return { runs, complete: false };
    },
  };
}

/** The adapter for a client: the fenced one's documents for a `runner_local` client, REST for the hosted `merge_gate` client. */
export const gate1ReadsFor = (http: GitHubHttp, repo: Head): Gate1Reads => (isLocalGitHubHttp(http) ? fencedGate1Reads(http, repo) : hostedGate1Reads(http, repo));

async function postGate1(http: GitHubHttp, repo: { owner: string; name: string; sha: string }, state: "success" | "failure", description: string): Promise<void> {
  const res = await http.request({ method: "POST", path: `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/statuses/${repo.sha}`, body: { state, context: GATE1_CONTEXT, description } });
  if (res.status !== 201) fail(`status post answered ${res.status}`);
}

/**
 * Reads the head's facts and acts on the decision. Idempotent: our own success already on the sha answers `already` with no post. A throw (a failed
 * or malformed read, a refused post) is not an answer: the caller's step retries. `readHead` is the caller's own read of the pull request's live head:
 * the file list is the head's at the moment it is read, so a head that moved away from `sha` by then answers `wait` before any label or post.
 */
export async function attestGate1Head(http: GitHubHttp, input: { repos: ReadonlySet<string>; owner: string; name: string; number: number; sha: string; ourLogin: () => Promise<string>; readHead: () => Promise<string> }): Promise<Gate1AttestOutcome> {
  // TL ruling 11-07 00:45: the setting is checked before ANY attester call; the fence alone opens A14 to A17 for every paired runner_local code repository.
  if (!gate1AttestEnabled(input.repos, input.owner, input.name)) return { kind: "off" };
  if (!SHA_PATTERN.test(input.sha) || !Number.isSafeInteger(input.number) || input.number < 1) fail("malformed head");
  const repo = { owner: input.owner, name: input.name, sha: input.sha, number: input.number };
  const reads = gate1ReadsFor(http, repo);
  const oursSucceeded = await reads.oursSucceeded(await input.ourLogin());
  if (oursSucceeded) return { kind: "already" };
  // The files come before the label: a change to CI files is refused before `ci:full` could start the label's re-run workflow.
  const files = await reads.changedFiles();
  if (!files.ok) fail(`files ${files.reason}`);
  const paths: string[] = files.ok ? files.files.flatMap((f) => (typeof f.previousPath === "string" ? [f.path, f.previousPath] : [f.path])) : [];
  const renameUnknown = files.ok && files.files.some((f) => f.previousPathUnknown === true);
  if ((await input.readHead()) !== repo.sha) return { kind: "wait", reason: "head_moved" };
  const base: Gate1Facts = { oursSucceeded, changedPaths: paths, changedPathsComplete: files.ok && !files.truncated, renameUnknown, labelEvents: [], labelEventsComplete: false, checkRuns: [], checkRunsComplete: false };
  const early = decideGate1(base);
  if (early.verdict === "fail" || (early.verdict === "wait" && early.reason === "files_incomplete")) return act(http, repo, early);
  const labels = await reads.labelEvents();
  const checks = await reads.checkRuns();
  return act(http, repo, decideGate1({ ...base, labelEvents: labels.events, labelEventsComplete: labels.complete, checkRuns: checks.runs, checkRunsComplete: checks.complete }));
}

async function act(http: GitHubHttp, repo: { owner: string; name: string; sha: string; number: number }, d: Gate1Decision): Promise<Gate1AttestOutcome> {
  switch (d.verdict) {
    case "already":
      return { kind: "already" };
    case "wait":
      return { kind: "wait", reason: d.reason };
    case "add_label": {
      const res = await http.request({ method: "POST", path: `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/issues/${repo.number}/labels`, body: { labels: [FULL_CI_LABEL] } });
      if (res.status !== 200) fail(`label add answered ${res.status}`);
      return { kind: "label_added" };
    }
    case "pass":
      await postGate1(http, repo, "success", GATE1_DESCRIPTIONS.success);
      return { kind: "posted", state: "success" };
    case "fail":
      await postGate1(http, repo, "failure", GATE1_DESCRIPTIONS.failure[d.reason]);
      return { kind: "posted", state: "failure", reason: d.reason };
  }
}
