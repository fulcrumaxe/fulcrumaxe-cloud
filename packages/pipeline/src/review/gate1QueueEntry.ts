import type { LocalGitHubHttp } from "../build/githubMergePort.js";
import { SHA_PATTERN } from "../build/mergeGate.js";
import { ACTIONS_APP_ID, GATE1_CONTEXT, GATE1_DESCRIPTIONS, GATE1_WORKFLOW_CONTEXTS, gate1AttestEnabled } from "./gate1Attest.js";
import { readGate1Creator } from "./gate1Creator.js";

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
 * Reads only through the attester's fenced client: A17 (who posted `fx-gate1`), A18 (the queue's entries), A15 (the entry commit's check runs); writes only
 * A7's fixed `fx-gate1` shape. Off unless the code repository is listed in `FX_GATE1_ATTEST_REPOS`, checked before any call.
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

/** Reads the entry's facts and acts. A throw (a failed read, a refused post) is not an answer: the next check suite's wake asks again. */
export async function attestQueueEntry(http: LocalGitHubHttp, input: { repos: ReadonlySet<string>; owner: string; name: string; base: string; prNumber: number; baseSha: string; entrySha: string; ourLogin: () => Promise<string> }): Promise<QueueEntryOutcome> {
  if (!gate1AttestEnabled(input.repos, input.owner, input.name)) return { kind: "off" };
  if (!SHA_PATTERN.test(input.entrySha) || !SHA_PATTERN.test(input.baseSha) || !Number.isSafeInteger(input.prNumber) || input.prNumber < 1) fail("malformed entry");
  const repo = { owner: input.owner, name: input.name };
  const login = await input.ourLogin();
  const own = await readGate1Creator(http, { ...repo, sha: input.entrySha }, login);
  if (own.ours && own.state === "SUCCESS") return { kind: "already" };
  const { entries, complete } = await readEntries(http, { ...repo, base: input.base });
  const runs = await readRuns(http, { ...repo, sha: input.entrySha });
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
      const who = await readGate1Creator(http, { ...repo, sha: e.prHead }, login);
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
