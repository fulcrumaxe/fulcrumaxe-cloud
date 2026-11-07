import { describe, expect, it } from "vitest";
import { MERGE_QUEUE_ENTRY_DOCUMENT } from "../../../github/src/mergeGateGraphql.js";
import { ACTIONS_APP_ID, GATE1_DESCRIPTIONS, GATE1_WORKFLOW_CONTEXTS } from "../../src/review/gate1Attest.js";
import { attestQueueEntry } from "../../src/review/gate1QueueEntry.js";
import { freshRepo, type FakeCheckRun } from "./helpers/fakeGitHubRest.js";
import { gate1World } from "./helpers/fakeGitHubLocal.js";
import { fakeGitHubQueueRest, type HostedQueueWorld } from "./helpers/fakeGitHubQueueRest.js";

/**
 * D#6 CLOUD-POSTS-FX-GATE1 PR 1e: the queue entry commit's fx-gate1 for a HOSTED pair, through the plain merge_gate client's REST reads and the one pinned entry
 * document (no fence, no new document). PR 11 is ahead of PR 12, PR 13 behind it. The decision is the runner_local one (decideQueueEntry).
 * Branches use GitHub's real format (TL ruling 11-07 02:00): `pr-<n>-<sha>` names the commit the entry was built ON, never the pull request's head.
 * The group is the chain of first parents from the entry to the base tip; positions only have to fall along it, from any starting number.
 */
const H11 = "1b".repeat(20);
const H12 = "2c".repeat(20);
const H13 = "3d".repeat(20);
const E11 = "a1".repeat(20);
const E12 = "a2".repeat(20);
const E13 = "a3".repeat(20);
const MAIN = "e0".repeat(20);
const OURS = { __typename: "Bot", login: "fx-cloud-app[bot]" };
const ref = (pr: number, builtOn: string, base = "main") => `refs/heads/gh-readonly-queue/${base}/pr-${pr}-${builtOn}`;
const green = (over: Partial<FakeCheckRun> = {}): FakeCheckRun[] => GATE1_WORKFLOW_CONTEXTS.map((name) => ({ name, status: "completed", conclusion: "success", app: { id: ACTIONS_APP_ID }, ...over }));
/** Entry 11 is built on main's tip, 12 on 11's commit, 13 on 12's: each branch names its base and points at its own entry commit. */
const REFS = () => [
  { ref: ref(11, MAIN), sha: E11 },
  { ref: ref(12, E11), sha: E12 },
  { ref: ref(13, E12), sha: E13 },
];
const PARENTS = (): Record<string, string[]> => ({ [E11]: [MAIN], [E12]: [E11], [E13]: [E12] });
const PRS = (start = 1): HostedQueueWorld["prs"] => ({
  11: { state: "OPEN", headRefOid: H11, entry: { id: "MQE_11", state: "AWAITING_CHECKS", position: start } },
  12: { state: "OPEN", headRefOid: H12, entry: { id: "MQE_12", state: "AWAITING_CHECKS", position: start + 1 } },
  13: { state: "OPEN", headRefOid: H13, entry: { id: "MQE_13", state: "QUEUED", position: start + 2 } },
});

type Head = { state?: string; creator?: { __typename: string; login: string } } | null;
type WorldOpts = { runs?: FakeCheckRun[]; heads?: Record<string, Head>; refs?: HostedQueueWorld["refs"]; prs?: HostedQueueWorld["prs"]; refsStatus?: number; parents?: Record<string, string[]>; baseTip?: string | null; entryStatus?: { state: string; creator: { __typename: string; login: string } } };
function world(o: WorldOpts = {}) {
  const heads = o.heads ?? { [H11]: {}, [H12]: {}, [H13]: null };
  const statuses: Record<string, Record<string, string>> = {};
  const creators: Record<string, { __typename: string; login: string }> = {};
  for (const [sha, h] of Object.entries(heads)) {
    statuses[sha] = h === null ? {} : { "fx-gate1": h.state ?? "success" };
    if (h !== null) creators[sha] = h.creator ?? OURS;
  }
  if (o.entryStatus) {
    statuses[E12] = { "fx-gate1": o.entryStatus.state };
    creators[E12] = o.entryStatus.creator;
  }
  const s = freshRepo({ owner: "acme", name: "widgets-public", prNumber: 12, headSha: H12, checks: { [E12]: (o.runs ?? green()).map((r) => ({ ...r, startedAt: "2026-11-07T09:00:00Z" })) }, statuses, commitParents: o.parents ?? PARENTS() });
  const q: HostedQueueWorld = { refs: o.refs ?? REFS(), prs: o.prs ?? PRS(), entryReads: [], baseTip: o.baseTip === undefined ? MAIN : o.baseTip, ...(o.refsStatus !== undefined ? { refsStatus: o.refsStatus } : {}) };
  const http = fakeGitHubQueueRest(s, gate1World({ creators }), q);
  // The wake gives the sha in the branch's name (E11 for PR 12's branch): the entry's base.
  const run = (over: Partial<Parameters<typeof attestQueueEntry>[1]> = {}) =>
    attestQueueEntry(http, { repos: new Set(["acme/widgets-public"]), owner: "acme", name: "widgets-public", base: "main", prNumber: 12, baseSha: E11, entrySha: E12, ourLogin: async () => "fx-cloud-app[bot]", entryDocument: MERGE_QUEUE_ENTRY_DOCUMENT, ...over });
  const posts = () => s.posts.filter((p) => p.sha === E12);
  const paths = () => s.requests.map((r) => `${r.method} ${r.path}`);
  return { s, q, http, run, posts, paths };
}

describe("attestQueueEntry, hosted pair", () => {
  it("green Actions runs and our fx-gate1 on every group head: success with the fixed body, every call REST or the pinned entry document, then idempotent", async () => {
    const t = world();
    expect(await t.run()).toEqual({ kind: "posted", state: "success" });
    expect(t.s.posts).toEqual([{ sha: E12, body: { state: "success", context: "fx-gate1", description: GATE1_DESCRIPTIONS.success } }]);
    expect(new Set(t.paths())).toEqual(
      new Set([
        `GET /repos/acme/widgets-public/commits/${E12}/statuses`,
        "GET /repos/acme/widgets-public/git/matching-refs/heads/gh-readonly-queue/main",
        "GET /repos/acme/widgets-public/git/ref/heads/main",
        `GET /repos/acme/widgets-public/commits/${E12}`,
        `GET /repos/acme/widgets-public/commits/${E11}`,
        "POST /graphql",
        `GET /repos/acme/widgets-public/commits/${E12}/check-runs`,
        `GET /repos/acme/widgets-public/commits/${H11}/statuses`,
        `GET /repos/acme/widgets-public/commits/${H12}/statuses`,
        `POST /repos/acme/widgets-public/statuses/${E12}`,
      ]),
    );
    // The group heads are the pull requests' heads as GitHub's entry read gives them (11 and 12), never a branch-name sha, never 13 behind.
    expect(t.paths()).not.toContain(`GET /repos/acme/widgets-public/commits/${H13}/statuses`);
    expect(t.paths()).not.toContain(`GET /repos/acme/widgets-public/commits/${E11}/statuses`);
    expect(t.paths()).not.toContain(`GET /repos/acme/widgets-public/commits/${MAIN}/statuses`);
    // Only the pull requests the entry commit tests are read; the one behind is not.
    expect(t.q.entryReads.sort()).toEqual([11, 12]);
    expect(t.s.requests.find((r) => r.path.endsWith("/check-runs"))?.query).toMatchObject({ filter: "latest" });
    expect(await t.run()).toEqual({ kind: "already" });
    expect(t.s.posts).toHaveLength(1);
  });

  it("no assumption about how GitHub numbers positions: a front at 0, at 1, at 7, or with a gap gives the same answer", async () => {
    for (const start of [0, 1, 7]) {
      expect(await world({ prs: PRS(start) }).run(), `start ${start}`).toEqual({ kind: "posted", state: "success" });
      expect(await world({ prs: PRS(start), heads: { [H11]: null, [H12]: {} } }).run(), `start ${start}, 11 unattested`).toEqual({ kind: "wait", reason: "group_head_unattested" });
    }
    const gap = PRS();
    gap[12]!.entry!.position = 3;
    gap[13]!.entry!.position = 4;
    expect(await world({ prs: gap }).run()).toEqual({ kind: "posted", state: "success" });
  });

  it("a group head is read where GitHub's entry says it is: a head ahead that moved to an unattested commit waits", async () => {
    const prs = PRS();
    prs[11]!.headRefOid = "4e".repeat(20);
    expect(await world({ prs }).run()).toEqual({ kind: "wait", reason: "group_head_unattested" });
    const ours = PRS();
    ours[12]!.headRefOid = "5f".repeat(20);
    expect(await world({ prs: ours }).run()).toEqual({ kind: "wait", reason: "group_head_unattested" });
  });

  it("a group head without OUR success waits and posts nothing: none, a person's or a token's, another app's, a lookalike, a case change, our User twin, ours not success", async () => {
    const bad: Head[] = [
      null,
      { creator: { __typename: "User", login: "autonomous-agent-7" } },
      { creator: { __typename: "Bot", login: "other-app[bot]" } },
      { creator: { __typename: "Bot", login: "fx-cloud-app-x[bot]" } },
      { creator: { __typename: "Bot", login: "FX-cloud-app[bot]" } },
      { creator: { __typename: "User", login: "fx-cloud-app[bot]" } },
      { creator: { __typename: "Organization", login: "fx-cloud-app" } },
      { state: "failure" },
      { state: "pending" },
      { state: "error" },
    ];
    for (const h of bad) {
      for (const head of [H11, H12]) {
        const t = world({ heads: { [H11]: {}, [H12]: {}, [H13]: null, [head]: h } });
        expect(await t.run(), `${head.slice(0, 2)} ${JSON.stringify(h)}`).toEqual({ kind: "wait", reason: "group_head_unattested" });
        expect(t.s.posts).toEqual([]);
      }
    }
  });

  it("the entry behind does not count; the entry ahead that already merged (the base tip is its commit) leaves the group too", async () => {
    expect(await world({ heads: { [H11]: {}, [H12]: {}, [H13]: { creator: { __typename: "User", login: "someone" } } } }).run()).toEqual({ kind: "posted", state: "success" });
    const merged = world({ refs: [REFS()[1]!, REFS()[2]!], baseTip: E11, heads: { [H11]: null, [H12]: {} } });
    expect(await merged.run()).toEqual({ kind: "posted", state: "success" });
    expect(merged.q.entryReads).toEqual([12]);
  });

  it("every non-success conclusion posts failure ci_red, even with a group head unattested; a run from another app id posts foreign_app", async () => {
    for (const conclusion of ["failure", "cancelled", "timed_out", "action_required", "neutral", "skipped", "stale", "startup_failure"]) {
      const runs = green();
      runs[2] = { ...runs[2]!, conclusion };
      for (const heads of [undefined, { [H11]: null, [H12]: {} }]) {
        const t = world({ runs, ...(heads ? { heads } : {}) });
        expect(await t.run(), conclusion).toEqual({ kind: "posted", state: "failure", reason: "ci_red" });
        expect(t.posts()).toEqual([{ sha: E12, body: { state: "failure", context: "fx-gate1", description: GATE1_DESCRIPTIONS.failure.ci_red } }]);
      }
    }
    for (const app of [{ id: 1 }, { id: ACTIONS_APP_ID + 1 }]) {
      const runs = green();
      runs[0] = { ...runs[0]!, app };
      expect(await world({ runs }).run(), JSON.stringify(app)).toEqual({ kind: "posted", state: "failure", reason: "foreign_app" });
    }
  });

  it("a run still going, or a context missing, waits and posts nothing", async () => {
    for (const status of ["in_progress", "queued", "waiting", "pending", "requested"]) {
      const runs = green();
      runs[1] = { ...runs[1]!, status, conclusion: null };
      const t = world({ runs });
      expect(await t.run(), status).toEqual({ kind: "wait", reason: "check_running" });
      expect(t.s.posts).toEqual([]);
    }
    expect(await world({ runs: green().slice(1) }).run()).toEqual({ kind: "wait", reason: "check_missing" });
  });

  it("entry identity: wrong commit, a name or parent that disagrees, not queued, closed or merged, a lookalike branch, another pull request's branch, no branch: not this entry", async () => {
    const withPr = (n: number, over: Partial<HostedQueueWorld["prs"][number]>) => ({ ...PRS(), [n]: { ...PRS()[n]!, ...over } });
    type Case = { label: string; refs?: HostedQueueWorld["refs"]; prs?: HostedQueueWorld["prs"]; parents?: Record<string, string[]>; wake?: string };
    const cases: Case[] = [
      { label: "our branch points at another commit", refs: [REFS()[0]!, { ref: ref(12, E11), sha: "b".repeat(40) }] },
      { label: "the wake read another sha from the name", wake: MAIN },
      { label: "the commit's first parent is not the name's sha", parents: { ...PARENTS(), [E12]: [MAIN] } },
      { label: "the name's sha is only the second parent", parents: { ...PARENTS(), [E12]: [MAIN, E11] } },
      { label: "a root commit", parents: { ...PARENTS(), [E12]: [] } },
      { label: "not queued", prs: withPr(12, { entry: null }) },
      { label: "closed", prs: withPr(12, { state: "CLOSED" }) },
      { label: "merged", prs: withPr(12, { state: "MERGED" }) },
      { label: "lookalike base", refs: [REFS()[0]!, { ref: ref(12, E11, "main-x"), sha: E12 }] },
      { label: "base as a path prefix", refs: [REFS()[0]!, { ref: `refs/heads/gh-readonly-queue/main/x/pr-12-${E11}`, sha: E12 }] },
      { label: "zero-padded number", refs: [REFS()[0]!, { ref: `refs/heads/gh-readonly-queue/main/pr-012-${E11}`, sha: E12 }] },
      { label: "upper-case sha in the name", refs: [REFS()[0]!, { ref: `refs/heads/gh-readonly-queue/main/pr-12-${E11.toUpperCase()}`, sha: E12 }] },
      { label: "another pull request's branch with our commit", refs: [REFS()[0]!, { ref: ref(14, E11), sha: E12 }], prs: { ...PRS(), 14: { state: "OPEN", headRefOid: H12, entry: { id: "MQE_14", state: "QUEUED", position: 2 } } } },
      { label: "no branch for ours", refs: [REFS()[0]!] },
      { label: "no queue at all", refs: [] },
    ];
    for (const c of cases) {
      const t = world({ ...(c.refs ? { refs: c.refs } : {}), ...(c.prs ? { prs: c.prs } : {}), ...(c.parents ? { parents: c.parents } : {}) });
      expect(await t.run(c.wake ? { baseSha: c.wake } : {}), c.label).toEqual({ kind: "wait", reason: "entry_not_queued" });
      expect(t.s.posts, c.label).toEqual([]);
      // A branch that is not ours (by number, commit or the name the wake read) stops before the base tip or any commit is read.
      if (c.refs !== undefined || c.wake !== undefined) expect(t.paths().filter((p) => p.includes("/git/ref/heads/") || /\/commits\/[0-9a-f]{40}$/.test(p)), c.label).toEqual([]);
    }
  });

  it("an incomplete group is a wait: an entry ahead with no branch, the base moved, a parent ahead that disagrees, positions that do not fall, an entry ahead not queued, two branches on one commit, more branches than a group holds", async () => {
    const waits: Array<[string, WorldOpts]> = [
      ["entry ahead has no branch", { refs: [REFS()[1]!, REFS()[2]!] }],
      ["the base tip moved past the chain", { baseTip: "f0".repeat(20) }],
      ["the entry ahead's first parent disagrees with its name", { parents: { ...PARENTS(), [E11]: ["f1".repeat(20)] } }],
      ["a duplicate position", { prs: (() => { const p = PRS(); p[11]!.entry!.position = 2; return p; })() }],
      ["positions against the chain", { prs: (() => { const p = PRS(); p[11]!.entry!.position = 3; p[13]!.entry!.position = 1; return p; })() }],
      ["the entry ahead is no longer queued", { prs: (() => { const p = PRS(); p[11]!.entry = null; return p; })() }],
      ["the entry ahead was closed", { prs: (() => { const p = PRS(); p[11]!.state = "CLOSED"; return p; })() }],
      ["two branches on our commit", { refs: [...REFS(), { ref: ref(14, E11), sha: E12 }] }],
      ["a chain that loops", { refs: [{ ref: ref(11, E12), sha: E11 }, REFS()[1]!], parents: { ...PARENTS(), [E11]: [E12] } }],
      ["more branches than a group holds", { refs: [...REFS(), ...Array.from({ length: 101 }, (_, i) => ({ ref: ref(100 + i, E13), sha: (1000 + i).toString(16).padStart(40, "c") }))] }],
    ];
    for (const [label, o] of waits) {
      const t = world(o);
      expect(await t.run(), label).toEqual({ kind: "wait", reason: "entries_incomplete" });
      expect(t.s.posts, label).toEqual([]);
    }
    const many = world(waits[waits.length - 1]![1]);
    await many.run();
    expect(many.q.entryReads).toEqual([]);
    // A loop stops at the first repeat, not at the group's size bound.
    const loop = world(waits.find(([l]) => l === "a chain that loops")![1]);
    await loop.run();
    expect(loop.paths().filter((p) => /\/commits\/[0-9a-f]{40}$/.test(p))).toHaveLength(2);
  });

  it("the entry already carries someone else's success: attested on its own facts; our own success is 'already' with no queue read", async () => {
    expect(await world({ entryStatus: { state: "success", creator: { __typename: "User", login: "autonomous-agent-7" } } }).run()).toEqual({ kind: "posted", state: "success" });
    const mine = world({ entryStatus: { state: "success", creator: OURS } });
    expect(await mine.run()).toEqual({ kind: "already" });
    expect(mine.q.entryReads).toEqual([]);
    expect(mine.paths()).toEqual([`GET /repos/acme/widgets-public/commits/${E12}/statuses`]);
  });

  it("off before any call; no entry document on a hosted client, or a malformed input, throws before any call", async () => {
    const t = world();
    expect(await t.run({ repos: new Set(["acme/other"]) })).toEqual({ kind: "off" });
    expect(await t.run({ repos: new Set() })).toEqual({ kind: "off" });
    await expect(t.run({ entryDocument: undefined })).rejects.toThrow(/entry document/);
    await expect(t.run({ entryDocument: "" })).rejects.toThrow(/entry document/);
    await expect(t.run({ entrySha: "main" })).rejects.toThrow(/malformed/);
    await expect(t.run({ baseSha: "main" })).rejects.toThrow(/malformed/);
    expect(t.s.requests).toEqual([]);
  });

  it("a failed refs or base-tip read, a document that is not the pinned one, or an unknown pull request in the group is a throw and posts nothing", async () => {
    const t = world({ refsStatus: 502 });
    await expect(t.run()).rejects.toThrow(/queue refs/);
    const tip = world({ baseTip: null });
    await expect(tip.run()).rejects.toThrow(/base tip/);
    const other = world();
    await expect(other.run({ entryDocument: "query { viewer { login } }" })).rejects.toThrow(/pinned/);
    const prs = PRS();
    delete prs[11];
    const unknown = world({ prs });
    await expect(unknown.run()).rejects.toThrow(/entry pull request/);
    for (const w of [t, tip, other, unknown]) expect(w.s.posts).toEqual([]);
  });
});
