import { isLocalGitHubHttp, type GitHubHttp, type LocalGitHubHttp } from "../build/githubMergePort.js";
import { SHA_PATTERN } from "../build/mergeGate.js";
import { ACTIONS_APP_ID, GATE1_CONTEXT, GATE1_DESCRIPTIONS, GATE1_WORKFLOW_CONTEXTS, gate1AttestEnabled, hostedGate1Reads } from "./gate1Attest.js";
import { readGate1CreatorFor } from "./gate1Creator.js";

/**
 * D#6 CLOUD-POSTS-FX-GATE1 PR 1d: the cloud's `fx-gate1` on a merge-queue entry commit (`gh-readonly-queue/<base>/pr-<n>-<sha>`) of a cloud item.
 *
 * GitHub's branch name carries the entry's BASE commit (the base branch's tip, or the entry ahead of it), not the pull request's head. The entry is matched on
 * its own head commit (the commit the suite ran on), its pull request's number and that base; the pull request's head is taken from the entry itself.
 *
 * GitHub's queue tests the merged result of every pull request from the front of the queue up to this entry, and the ruleset requires `fx-gate1` on that
 * commit. A `merge_group` run is always full scope (the CI scope step only narrows `pull_request` events), so no label rule applies. The entry gets
 * success only when BOTH hold:
 *   - each of the five workflow contexts on the entry commit is a check run of GitHub Actions (app 15368), completed and green;
 *   - every pull request in the group (each entry at or ahead of this one) carries OUR `fx-gate1` = success on its head (A17: our App's bot, not a person's).
 * A finished red or foreign run posts failure. Anything still running, an entry that is not in the queue (any more), or a group head without our success
 * (a team pull request ahead, whose own watcher posts that entry) answers `wait`: nothing is posted.
 *
 * A runner_local pair reads only through the attester's fenced client: A17 (who posted `fx-gate1`), A18 (the queue's entries), A15 (the entry commit's check
 * runs); writes only A7's fixed `fx-gate1` shape. PR 1e: a hosted pair makes the same decision from the plain `merge_gate` client's REST reads and its
 * pinned entry document (`readEntriesHosted`). Off unless the code repository is listed in `FX_GATE1_ATTEST_REPOS`, checked before any call.
 *
 * The group is "at or ahead of this entry" by comparing positions, never by a number GitHub's docs do not give: the schema says only that `position` is "the
 * position of this entry in the queue", not whether the front is 0 or 1. The hosted reader proves the group from commits instead (below).
 */

export interface QueueEntryNode {
  position: number;
  entryOid: string | null;
  /** The entry's base commit (null until GitHub builds the entry). */
  baseOid: string | null;
  prNumber: number;
  prHead: string;
}
export interface QueueEntryRun {
  name: string;
  appId: number | null;
  status: string;
  conclusion: string | null;
}
export interface QueueEntryFacts {
  /** The commit the check suite finished on, and the pull request number and base sha its branch name gives. */
  entrySha: string;
  prNumber: number;
  baseSha: string;
  entries: readonly QueueEntryNode[];
  entriesComplete: boolean;
  checkRuns: readonly QueueEntryRun[];
  checkRunsComplete: boolean;
  /** Pull request head oid -> our App's bot posted `fx-gate1` = success on it. A head missing here is not ours. */
  groupOurs: Readonly<Record<string, boolean>>;
}

export type QueueEntryWaitReason = "entries_incomplete" | "entry_not_queued" | "checks_incomplete" | "check_missing" | "check_running" | "group_head_unattested";
export type QueueEntryDecision = { verdict: "wait"; reason: QueueEntryWaitReason } | { verdict: "pass" } | { verdict: "fail"; reason: "ci_red" | "foreign_app" };

/** The entry for this commit, or null. Its head commit is the commit, and it names the pull request and the base the branch was built for. */
export function findEntry(f: Pick<QueueEntryFacts, "entries" | "entrySha" | "prNumber" | "baseSha">): QueueEntryNode | null {
  return f.entries.find((e) => e.entryOid === f.entrySha && e.prNumber === f.prNumber && e.baseOid === f.baseSha) ?? null;
}

/** The decision for one entry commit. Pure. A red or foreign run is a failure whatever the group; success needs green runs AND every group head ours. */
export function decideQueueEntry(f: QueueEntryFacts): QueueEntryDecision {
  if (!f.entriesComplete) return { verdict: "wait", reason: "entries_incomplete" };
  const entry = findEntry(f);
  if (entry === null) return { verdict: "wait", reason: "entry_not_queued" };
  if (!f.checkRunsComplete) return { verdict: "wait", reason: "checks_incomplete" };
  let wait: QueueEntryWaitReason | null = null;
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
    if (runs.some((c) => c.conclusion !== "success")) return { verdict: "fail", reason: "ci_red" };
  }
  if (wait !== null) return { verdict: "wait", reason: wait };
  const group = f.entries.filter((e) => e.position <= entry.position);
  if (!group.every((e) => f.groupOurs[e.prHead] === true)) return { verdict: "wait", reason: "group_head_unattested" };
  return { verdict: "pass" };
}

export type QueueEntryOutcome = { kind: "off" } | { kind: "already" } | { kind: "wait"; reason: QueueEntryWaitReason } | { kind: "posted"; state: "success" } | { kind: "posted"; state: "failure"; reason: "ci_red" | "foreign_app" };

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const fail = (what: string): never => {
  throw new Error(`gate1 queue entry: ${what}`);
};
const MAX_PAGES = 5;
const MAX_GROUP = 100;

async function repository(http: LocalGitHubHttp, op: "Gate1QueueEntries" | "Gate1CheckRuns", variables: Record<string, unknown>): Promise<Json> {
  const res = await http.graphql(op, variables);
  if (res.status !== 200 || !isObj(res.body) || res.body.errors !== undefined || !isObj(res.body.data) || !isObj(res.body.data.repository)) return fail(`${op} unreadable`);
  return res.body.data.repository;
}

/** A18. No queue on the branch is an empty, complete list; a list shorter than GitHub's total is incomplete. */
async function readEntries(http: LocalGitHubHttp, repo: { owner: string; name: string; base: string }): Promise<{ entries: QueueEntryNode[]; complete: boolean }> {
  const r = await repository(http, "Gate1QueueEntries", { owner: repo.owner, name: repo.name, branch: repo.base });
  if (r.mergeQueue === null) return { entries: [], complete: true };
  const conn = isObj(r.mergeQueue) && isObj(r.mergeQueue.entries) ? r.mergeQueue.entries : fail("entries");
  if (!Array.isArray(conn.nodes) || typeof conn.totalCount !== "number") return fail("entries nodes");
  const entries = (conn.nodes as unknown[]).map((n): QueueEntryNode => {
    if (!isObj(n) || !Number.isSafeInteger(n.position) || !isObj(n.pullRequest) || !Number.isSafeInteger(n.pullRequest.number) || typeof n.pullRequest.headRefOid !== "string") return fail("entry");
    const oid = isObj(n.headCommit) && typeof n.headCommit.oid === "string" ? n.headCommit.oid : null;
    const baseOid = isObj(n.baseCommit) && typeof n.baseCommit.oid === "string" ? n.baseCommit.oid : null;
    return { position: n.position as number, entryOid: oid, baseOid, prNumber: n.pullRequest.number as number, prHead: n.pullRequest.headRefOid };
  });
  return { entries, complete: entries.length === conn.totalCount };
}

/** A15 on the entry commit: its check runs (status contexts in the rollup are skipped). */
async function readRuns(http: LocalGitHubHttp, repo: { owner: string; name: string; sha: string }): Promise<{ runs: QueueEntryRun[]; complete: boolean }> {
  const runs: QueueEntryRun[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await repository(http, "Gate1CheckRuns", { owner: repo.owner, name: repo.name, sha: repo.sha, ...(cursor === null ? {} : { cursor }) });
    const commit = isObj(r.object) ? r.object : fail("commit");
    if (commit.oid !== repo.sha) fail("oid");
    if (commit.statusCheckRollup === null) return { runs, complete: true };
    const ctx = isObj(commit.statusCheckRollup) && isObj(commit.statusCheckRollup.contexts) ? commit.statusCheckRollup.contexts : fail("contexts");
    if (!Array.isArray(ctx.nodes) || !isObj(ctx.pageInfo)) fail("nodes");
    for (const n of ctx.nodes as unknown[]) {
      if (!isObj(n)) fail("node");
      const node = n as Json;
      if (node.__typename !== "CheckRun") continue;
      if (typeof node.name !== "string" || typeof node.status !== "string" || (node.conclusion !== null && typeof node.conclusion !== "string")) fail("run");
      const app = isObj(node.checkSuite) && isObj(node.checkSuite.app) ? node.checkSuite.app.databaseId : null;
      runs.push({ name: node.name as string, appId: typeof app === "number" ? app : null, status: (node.status as string).toLowerCase(), conclusion: node.conclusion === null ? null : (node.conclusion as string).toLowerCase() });
    }
    const info = ctx.pageInfo as Json;
    if (info.hasNextPage !== true) return { runs, complete: true };
    cursor = typeof info.endCursor === "string" ? info.endCursor : fail("endCursor");
  }
  return { runs, complete: false };
}

/**
 * PR 1e: a hosted pair's entries, through REST and the one pinned queue document the hosted `merge_gate` client already holds (`MERGE_QUEUE_ENTRY_DOCUMENT`,
 * injected: this package does not depend on @fx/github). No new document and no `allowGraphql`. That document gives a pull request's `state`, `headRefOid`
 * and `mergeQueueEntry { id state position }`, but no entry commit and no `baseCommit`, so the commits are proven from git instead:
 *  1. `git/matching-refs/heads/gh-readonly-queue/<base>`: the queue's branches. GitHub names each `pr-<n>-<sha>`, where `<sha>` is the commit the entry was
 *     built ON (the base branch's tip, or the entry ahead's commit), and the branch points at the entry commit. A name that is not exactly that shape under
 *     exactly this base (a lookalike base such as `main-x`) is not an entry; two branches on one commit is unreadable (a wait).
 *  2. `git/ref/heads/<base>`: the base branch's tip.
 *  3. The group is the chain of commits this entry was built on. Starting at this entry (the branch of THIS pull request number, pointing at THIS commit, named
 *     with the sha the wake read), each step's commit must have the sha its branch name gives as its first parent (REST `commits/{sha}`); the chain ends at
 *     the base tip. A step built on anything that is neither the tip nor another entry's commit (the base moved, an entry ahead was removed) is incomplete.
 *     This is exactly the set of pull requests the entry commit tests, and it needs no assumption about how GitHub numbers positions.
 *  4. For each pull request in the chain, the entry document: GitHub's own state (OPEN), head (`headRefOid`) and queue position. A pull request in the chain
 *     that is no longer queued is incomplete; ours not queued is not an entry. Positions must fall strictly from this entry to the front, else incomplete.
 * Any `baseOid` here is the first parent that step 3 checked, never the branch name alone.
 */
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const QUEUE_REF_TAIL = /^pr-([1-9][0-9]{0,9})-([0-9a-f]{40})$/;
type EntriesRead = { entries: QueueEntryNode[]; complete: boolean };
const NOT_AN_ENTRY: EntriesRead = { entries: [], complete: true };
const INCOMPLETE: EntriesRead = { entries: [], complete: false };
async function readEntriesHosted(http: GitHubHttp, repo: { owner: string; name: string; base: string }, entryDocument: string, own: { entrySha: string; prNumber: number; baseSha: string }): Promise<EntriesRead> {
  if (!BRANCH.test(repo.base) || repo.base.includes("..")) fail("base");
  const root = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  const res = await http.request({ method: "GET", path: `${root}/git/matching-refs/heads/gh-readonly-queue/${repo.base}` });
  if (res.status !== 200 || !Array.isArray(res.body)) return fail("queue refs unreadable");
  const prefix = `refs/heads/gh-readonly-queue/${repo.base}/`;
  const byCommit = new Map<string, { prNumber: number; builtOn: string }>();
  for (const r of res.body as unknown[]) {
    if (!isObj(r) || typeof r.ref !== "string" || !isObj(r.object) || typeof r.object.sha !== "string") return fail("queue ref");
    if (!r.ref.startsWith(prefix)) continue;
    const m = QUEUE_REF_TAIL.exec(r.ref.slice(prefix.length));
    if (m === null) continue;
    if (!SHA_PATTERN.test(r.object.sha)) return fail("queue ref sha");
    if (byCommit.has(r.object.sha)) return INCOMPLETE;
    byCommit.set(r.object.sha, { prNumber: Number(m[1]), builtOn: m[2]! });
    if (byCommit.size > MAX_GROUP) return INCOMPLETE;
  }
  const mine = byCommit.get(own.entrySha);
  if (mine === undefined || mine.prNumber !== own.prNumber || mine.builtOn !== own.baseSha) return NOT_AN_ENTRY;
  const tipRes = await http.request({ method: "GET", path: `${root}/git/ref/heads/${repo.base}` });
  if (tipRes.status !== 200 || !isObj(tipRes.body) || !isObj(tipRes.body.object) || typeof tipRes.body.object.sha !== "string" || !SHA_PATTERN.test(tipRes.body.object.sha)) return fail("base tip unreadable");
  const tip = tipRes.body.object.sha;
  const chain: Array<{ sha: string; prNumber: number; builtOn: string }> = [];
  for (let cur = own.entrySha, step = mine; ; ) {
    if (chain.length >= MAX_GROUP || chain.some((c) => c.prNumber === step.prNumber || c.sha === cur)) return INCOMPLETE;
    const c = await http.request({ method: "GET", path: `${root}/commits/${cur}` });
    if (c.status !== 200 || !isObj(c.body) || c.body.sha !== cur || !Array.isArray(c.body.parents)) return fail("entry commit unreadable");
    const first = c.body.parents[0] as unknown;
    if (!isObj(first) || first.sha !== step.builtOn) return chain.length === 0 ? NOT_AN_ENTRY : INCOMPLETE;
    chain.push({ sha: cur, prNumber: step.prNumber, builtOn: step.builtOn });
    if (step.builtOn === tip) break;
    const next = byCommit.get(step.builtOn);
    if (next === undefined) return INCOMPLETE;
    cur = step.builtOn;
    step = next;
  }
  const entries: QueueEntryNode[] = [];
  for (const link of chain) {
    const q = await http.request({ method: "POST", path: "/graphql", body: { query: entryDocument, variables: { owner: repo.owner, name: repo.name, number: link.prNumber } } });
    if (q.status !== 200 || !isObj(q.body) || q.body.errors !== undefined || !isObj(q.body.data) || !isObj(q.body.data.repository)) return fail("entry unreadable");
    const pr = isObj(q.body.data.repository.pullRequest) ? q.body.data.repository.pullRequest : fail("entry pull request");
    if (typeof pr.state !== "string" || typeof pr.headRefOid !== "string" || !SHA_PATTERN.test(pr.headRefOid)) return fail("entry fields");
    const queued = pr.mergeQueueEntry;
    if (queued === null || queued === undefined || pr.state !== "OPEN") return link.sha === own.entrySha ? NOT_AN_ENTRY : INCOMPLETE;
    if (!isObj(queued) || !Number.isSafeInteger(queued.position) || (queued.position as number) < 0) return fail("entry position");
    const at = queued.position as number;
    if (entries.length > 0 && !(at < entries[entries.length - 1]!.position)) return INCOMPLETE;
    entries.push({ position: at, entryOid: link.sha, baseOid: link.builtOn, prNumber: link.prNumber, prHead: pr.headRefOid });
  }
  return { entries, complete: true };
}

/** The hosted pair's entry commit check runs: the attester's REST read (`commits/{sha}/check-runs?filter=latest`, app id from GitHub). */
async function readRunsHosted(http: GitHubHttp, repo: { owner: string; name: string; sha: string; number: number }): Promise<{ runs: QueueEntryRun[]; complete: boolean }> {
  const read = await hostedGate1Reads(http, repo).checkRuns();
  return { runs: read.runs.map((r) => ({ name: r.name, appId: r.appId, status: r.status, conclusion: r.conclusion })), complete: read.complete };
}

/**
 * Reads the entry's facts and acts. A throw (a failed read, a refused post) is not an answer: the next check suite's wake asks again. A fenced client
 * (`runner_local`) reads through A17, A18 and A15; any other client is the hosted `merge_gate` one and needs `entryDocument` (PR 1e).
 */
export async function attestQueueEntry(http: GitHubHttp, input: { repos: ReadonlySet<string>; owner: string; name: string; base: string; prNumber: number; baseSha: string; entrySha: string; ourLogin: () => Promise<string>; entryDocument?: string }): Promise<QueueEntryOutcome> {
  if (!gate1AttestEnabled(input.repos, input.owner, input.name)) return { kind: "off" };
  if (!SHA_PATTERN.test(input.entrySha) || !SHA_PATTERN.test(input.baseSha) || !Number.isSafeInteger(input.prNumber) || input.prNumber < 1) fail("malformed entry");
  const local: LocalGitHubHttp | null = isLocalGitHubHttp(http) ? http : null;
  const entryDocument = input.entryDocument;
  if (local === null && (typeof entryDocument !== "string" || entryDocument.length === 0)) fail("hosted client without the entry document");
  const repo = { owner: input.owner, name: input.name };
  const login = await input.ourLogin();
  const own = await readGate1CreatorFor(http, { ...repo, sha: input.entrySha }, login);
  if (own.ours && own.state === "SUCCESS") return { kind: "already" };
  const { entries, complete } = local !== null ? await readEntries(local, { ...repo, base: input.base }) : await readEntriesHosted(http, { ...repo, base: input.base }, entryDocument!, { entrySha: input.entrySha, prNumber: input.prNumber, baseSha: input.baseSha });
  const runs = local !== null ? await readRuns(local, { ...repo, sha: input.entrySha }) : await readRunsHosted(http, { ...repo, sha: input.entrySha, number: input.prNumber });
  const facts: QueueEntryFacts = { entrySha: input.entrySha, prNumber: input.prNumber, baseSha: input.baseSha, entries, entriesComplete: complete, checkRuns: runs.runs, checkRunsComplete: runs.complete, groupOurs: {} };
  // The group's heads are read only when everything else already passes (asked with every head assumed ours): one A17 per pull request at or ahead of
  // this entry. The answer acted on is always the one with the heads as read.
  let d = decideQueueEntry({ ...facts, groupOurs: Object.fromEntries(entries.map((e) => [e.prHead, true])) });
  if (d.verdict === "pass") {
    const entry = findEntry(facts)!;
    const group = entries.filter((e) => e.position <= entry.position);
    if (group.length > MAX_GROUP) fail("group too large");
    const groupOurs: Record<string, boolean> = {};
    for (const e of group) {
      if (!SHA_PATTERN.test(e.prHead)) fail("group head");
      const who = await readGate1CreatorFor(http, { ...repo, sha: e.prHead }, login);
      groupOurs[e.prHead] = who.ours && who.state === "SUCCESS";
    }
    d = decideQueueEntry({ ...facts, groupOurs });
  }
  if (d.verdict === "wait") return { kind: "wait", reason: d.reason };
  const state = d.verdict === "pass" ? "success" : "failure";
  const description = d.verdict === "pass" ? GATE1_DESCRIPTIONS.success : GATE1_DESCRIPTIONS.failure[d.reason];
  const res = await http.request({ method: "POST", path: `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/statuses/${input.entrySha}`, body: { state, context: GATE1_CONTEXT, description } });
  if (res.status !== 201) fail(`status post answered ${res.status}`);
  return d.verdict === "pass" ? { kind: "posted", state: "success" } : { kind: "posted", state: "failure", reason: d.reason };
}
