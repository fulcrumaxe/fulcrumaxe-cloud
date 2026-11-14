import { describe, expect, it } from "vitest";
import { ACTIONS_APP_ID, GATE1_DESCRIPTIONS, GATE1_WORKFLOW_CONTEXTS } from "../../src/review/gate1Attest.js";
import { attestQueueEntry, decideQueueEntry, listQueueEntryCandidates } from "../../src/review/gate1QueueEntry.js";
import { freshRepo, type FakeCheckRun } from "./helpers/fakeGitHubRest.js";
import { fakeGitHubLocal, gate1World, queueBranch, type Gate1World } from "./helpers/fakeGitHubLocal.js";

/**
 * D#6 CLOUD-POSTS-FX-GATE1 PR 1d: the queue entry commit's fx-gate1, through the real fence (attester client) around the strict fake: A17, A18, A15 and A7 only.
 * The group is every entry at or ahead of this one; PR 11 is ahead of PR 12, PR 13 behind it.
 */
const H11 = "1".repeat(40);
const H12 = "2".repeat(40);
const H13 = "3".repeat(40);
const E11 = "a1".repeat(20);
const E12 = "a2".repeat(20);
const E13 = "a3".repeat(20);
/** The base branch's tip. GitHub chains the group: entry 11 is built on main's tip, entry 12 on entry 11's commit, entry 13 on entry 12's. */
const MAIN = "0f".repeat(20);
const OURS = { __typename: "Bot", login: "fx-cloud-app" };
const green = (over: Partial<FakeCheckRun> = {}): FakeCheckRun[] => GATE1_WORKFLOW_CONTEXTS.map((name) => ({ name, status: "completed", conclusion: "success", app: { id: ACTIONS_APP_ID }, ...over }));
const QUEUE = [
  { position: 1, entryOid: E11, baseOid: MAIN, prNumber: 11, prHead: H11 },
  { position: 2, entryOid: E12, baseOid: E11, prNumber: 12, prHead: H12 },
  { position: 3, entryOid: E13, baseOid: E12, prNumber: 13, prHead: H13 },
];
/** What the wake reads from GitHub's branch for PR 12's entry: `gh-readonly-queue/main/pr-12-<E11>`, so the branch sha is entry 12's BASE (E11), not H12. */
const BRANCH12 = queueBranch("main", 12, E11);
const BASE12 = /-([0-9a-f]{40})$/.exec(BRANCH12)![1]!;

function world(o: { runs?: FakeCheckRun[]; heads?: Record<string, { state?: string; creator?: { __typename: string; login: string } } | null>; queue?: Gate1World["queues"]; entryStatus?: { state: string; creator: { __typename: string; login: string } } } = {}) {
  const heads = o.heads ?? { [H11]: {}, [H12]: {}, [H13]: null };
  const statuses: Record<string, Record<string, string>> = {};
  const creators: Gate1World["creators"] = {};
  for (const [sha, h] of Object.entries(heads)) {
    statuses[sha] = h === null ? {} : { "fx-gate1": h.state ?? "success" };
    if (h !== null) creators[sha] = h.creator ?? OURS;
  }
  if (o.entryStatus) {
    statuses[E12] = { "fx-gate1": o.entryStatus.state };
    creators[E12] = o.entryStatus.creator;
  }
  const s = freshRepo({ owner: "acme", name: "widgets-public", prNumber: 12, headSha: H12, checks: { [E12]: o.runs ?? green() }, statuses });
  const g1 = gate1World({ creators, queues: o.queue ?? { main: QUEUE } });
  const fake = fakeGitHubLocal(s, { exclude: ["A10"], gate1: g1 });
  const run = (over: Partial<Parameters<typeof attestQueueEntry>[1]> = {}) =>
    attestQueueEntry(fake.http, { repos: new Set(["acme/widgets-public"]), owner: "acme", name: "widgets-public", base: "main", prNumber: 12, baseSha: BASE12, entrySha: E12, ourLogin: async () => "fx-cloud-app[bot]", ...over });
  const posts = () => s.posts.filter((p) => p.sha === E12);
  return { s, g1, fake, run, posts };
}

describe("decideQueueEntry (pure)", () => {
  const runs = (conclusion = "success") => GATE1_WORKFLOW_CONTEXTS.map((name) => ({ name, appId: ACTIONS_APP_ID, status: "completed", conclusion }));
  const facts = (over: Partial<Parameters<typeof decideQueueEntry>[0]> = {}) => ({ entrySha: E12, prNumber: 12, baseSha: E11, entries: QUEUE, entriesComplete: true, checkRuns: runs(), checkRunsComplete: true, groupOurs: { [H11]: true, [H12]: true }, ...over });
  it("red is a failure whatever the group; green needs the whole group ours", () => {
    expect(decideQueueEntry(facts({ checkRuns: runs("failure"), groupOurs: {} }))).toEqual({ verdict: "fail", reason: "ci_red" });
    expect(decideQueueEntry(facts({ groupOurs: { [H12]: true } }))).toEqual({ verdict: "wait", reason: "group_head_unattested" });
    expect(decideQueueEntry(facts())).toEqual({ verdict: "pass" });
    expect(decideQueueEntry(facts({ checkRunsComplete: false }))).toEqual({ verdict: "wait", reason: "checks_incomplete" });
  });
  it("the entry is matched on its head commit, its pull request and its BASE; the branch sha is never read as the pull request's head", () => {
    expect(BASE12).toBe(E11);
    expect(decideQueueEntry(facts({ baseSha: H12 }))).toEqual({ verdict: "wait", reason: "entry_not_queued" });
    expect(decideQueueEntry(facts({ baseSha: MAIN }))).toEqual({ verdict: "wait", reason: "entry_not_queued" });
    expect(decideQueueEntry(facts({ entrySha: E11 }))).toEqual({ verdict: "wait", reason: "entry_not_queued" });
    expect(decideQueueEntry(facts({ prNumber: 11 }))).toEqual({ verdict: "wait", reason: "entry_not_queued" });
  });
});

describe("attestQueueEntry", () => {
  it("green runs from GitHub Actions and our fx-gate1 on every group head: success on the entry commit, exactly the fixed body, then idempotent", async () => {
    const t = world();
    expect(await t.run()).toEqual({ kind: "posted", state: "success" });
    expect(t.s.posts).toEqual([{ sha: E12, body: { state: "success", context: "fx-gate1", description: GATE1_DESCRIPTIONS.success } }]);
    expect(t.fake.calls.find((c) => c.label === "A7")?.path).toBe(`/repos/acme/widgets-public/statuses/${E12}`);
    expect(new Set(t.fake.calls.map((c) => c.label))).toEqual(new Set(["A17", "A18", "A15", "A7"]));
    // One A17 for the entry commit, one per group head (11 and 12), none for the entry behind (13).
    expect(t.fake.calls.filter((c) => c.label === "A17")).toHaveLength(3);
    expect(t.fake.denied).toEqual([]);
    expect(t.fake.refused).toEqual([]);
    expect(await t.run()).toEqual({ kind: "already" });
    expect(t.s.posts).toHaveLength(1);
  });

  it("a group head without OUR success waits and posts nothing: none at all, a person's or a token's, another app's, a lookalike bot, ours not success", async () => {
    const bad = [null, { creator: { __typename: "User", login: "autonomous-agent-7" } }, { creator: { __typename: "Bot", login: "other-app" } }, { creator: { __typename: "Bot", login: "fx-cloud-app-x" } }, { creator: { __typename: "User", login: "fx-cloud-app" } }, { state: "failure" }, { state: "pending" }, { state: "error" }];
    for (const h of bad) {
      for (const head of [H11, H12]) {
        const t = world({ heads: { [H11]: {}, [H12]: {}, [H13]: null, [head]: h } });
        expect(await t.run(), `${head.slice(0, 2)} ${JSON.stringify(h)}`).toEqual({ kind: "wait", reason: "group_head_unattested" });
        expect(t.s.posts).toEqual([]);
      }
    }
  });

  it("the entry behind this one does not count, and the queue order is by position", async () => {
    expect(await world({ heads: { [H11]: {}, [H12]: {}, [H13]: { creator: { __typename: "User", login: "someone" } } } }).run()).toEqual({ kind: "posted", state: "success" });
    const reordered = { main: [QUEUE[1]!, { ...QUEUE[0]!, position: 3 }, { ...QUEUE[2]!, position: 1 }] };
    expect(await world({ queue: reordered, heads: { [H11]: null, [H12]: {}, [H13]: {} } }).run()).toEqual({ kind: "posted", state: "success" });
    expect(await world({ queue: reordered, heads: { [H11]: {}, [H12]: {}, [H13]: null } }).run()).toEqual({ kind: "wait", reason: "group_head_unattested" });
  });

  it("every non-success conclusion is red and posts failure, even while a group head is unattested", async () => {
    for (const conclusion of ["failure", "cancelled", "timed_out", "action_required", "neutral", "skipped", "stale", "startup_failure"]) {
      const runs = green();
      runs[3] = { ...runs[3]!, conclusion };
      for (const heads of [undefined, { [H11]: null, [H12]: {} }]) {
        const t = world({ runs, ...(heads ? { heads } : {}) });
        expect(await t.run(), conclusion).toEqual({ kind: "posted", state: "failure", reason: "ci_red" });
        expect(t.posts()).toEqual([{ sha: E12, body: { state: "failure", context: "fx-gate1", description: GATE1_DESCRIPTIONS.failure.ci_red } }]);
      }
    }
  });

  it("a required run from another app, or a same-named second run from another app, posts failure foreign_app", async () => {
    const runs = green();
    runs[0] = { ...runs[0]!, app: { id: 1 } };
    expect(await world({ runs }).run()).toEqual({ kind: "posted", state: "failure", reason: "foreign_app" });
    expect(await world({ runs: [...green(), { name: GATE1_WORKFLOW_CONTEXTS[2]!, status: "completed", conclusion: "success", app: { id: 15369 } }] }).run()).toEqual({ kind: "posted", state: "failure", reason: "foreign_app" });
  });

  it("a run still going, or a context not there yet, waits and posts nothing; a red one beats a running one", async () => {
    for (const status of ["in_progress", "queued", "waiting", "pending", "requested"]) {
      const runs = green();
      runs[1] = { ...runs[1]!, status, conclusion: null };
      const t = world({ runs });
      expect(await t.run(), status).toEqual({ kind: "wait", reason: "check_running" });
      expect(t.s.posts).toEqual([]);
    }
    const t = world({ runs: green().slice(1) });
    expect(await t.run()).toEqual({ kind: "wait", reason: "check_missing" });
    expect(t.s.posts).toEqual([]);
    const mixed = green();
    mixed[0] = { ...mixed[0]!, status: "in_progress", conclusion: null };
    mixed[4] = { ...mixed[4]!, conclusion: "failure" };
    expect(await world({ runs: mixed }).run()).toEqual({ kind: "posted", state: "failure", reason: "ci_red" });
  });

  it("an entry that is not this commit's (gone, another commit, another pull request or base, not built yet, no queue) waits and posts nothing", async () => {
    const cases: Array<Gate1World["queues"]> = [
      { main: [QUEUE[0]!] },
      { main: [{ ...QUEUE[1]!, entryOid: "b".repeat(40) }] },
      { main: [{ ...QUEUE[1]!, prNumber: 14 }] },
      { main: [{ ...QUEUE[1]!, baseOid: MAIN }] },
      { main: [{ ...QUEUE[1]!, baseOid: H12 }] },
      { main: [{ ...QUEUE[1]!, baseOid: null }] },
      { main: [{ ...QUEUE[1]!, entryOid: null }] },
      { other: QUEUE },
    ];
    for (const queue of cases) {
      const t = world({ queue });
      expect(await t.run(), JSON.stringify(queue)).toEqual({ kind: "wait", reason: "entry_not_queued" });
      expect(t.s.posts).toEqual([]);
    }
  });

  it("the pull request's head is the entry's own headRefOid: the group read checks that head, whatever the branch name says", async () => {
    // PR 12's entry names H13 as its head (the pull request moved, say): H13 has no fx-gate1, so the group is not ours, though H12 is.
    const moved = { main: [QUEUE[0]!, { ...QUEUE[1]!, prHead: H13 }] };
    const t = world({ queue: moved });
    expect(await t.run()).toEqual({ kind: "wait", reason: "group_head_unattested" });
    expect(t.s.posts).toEqual([]);
    // ... and once H13 carries our success, the entry is attested (H12 is never asked about).
    expect(await world({ queue: moved, heads: { [H11]: {}, [H12]: null, [H13]: {} } }).run()).toEqual({ kind: "posted", state: "success" });
  });

  it("a queue longer than one page is not read as complete", async () => {
    const long = Array.from({ length: 101 }, (_, i) => ({ position: i + 1, entryOid: i === 1 ? E12 : `${(i + 10).toString(16).padStart(2, "0")}`.repeat(20), baseOid: i === 1 ? E11 : MAIN, prNumber: i === 1 ? 12 : 100 + i, prHead: i === 1 ? H12 : H11 }));
    const t = world({ queue: { main: long } });
    expect(await t.run()).toEqual({ kind: "wait", reason: "entries_incomplete" });
    expect(t.s.posts).toEqual([]);
  });

  it("the entry already has someone else's success: not 'already', it is attested on its own facts", async () => {
    expect(await world({ entryStatus: { state: "success", creator: { __typename: "User", login: "autonomous-agent-7" } } }).run()).toEqual({ kind: "posted", state: "success" });
    expect(await world({ entryStatus: { state: "failure", creator: OURS } }).run()).toEqual({ kind: "posted", state: "success" });
  });

  it("an unlisted repository is off before any call; a malformed input throws before any call", async () => {
    const t = world();
    expect(await t.run({ repos: new Set(["acme/other"]) })).toEqual({ kind: "off" });
    expect(await t.run({ repos: new Set() })).toEqual({ kind: "off" });
    await expect(t.run({ entrySha: "main" })).rejects.toThrow(/malformed/);
    await expect(t.run({ baseSha: E11.toUpperCase() })).rejects.toThrow(/malformed/);
    await expect(t.run({ baseSha: E11.slice(1) })).rejects.toThrow(/malformed/);
    await expect(t.run({ prNumber: 0 })).rejects.toThrow(/malformed/);
    expect(t.fake.calls).toEqual([]);
  });

  it("an unreadable read is a throw and posts nothing", async () => {
    const t = world();
    delete t.s.statuses[H11];
    // A group head GitHub does not know answers object: null.
    await expect(t.run()).rejects.toThrow();
    expect(t.s.posts).toEqual([]);
  });
});

describe("attestQueueEntry: a cloud item's group head that never met the head attester (its review round ended before the setting went on)", () => {
  const FOREIGN = { creator: { __typename: "User", login: "autonomous-agent-7" } };
  /** The stub stands for the web wake's head attester: it posts OURS on the head the way the real one does, and answers whether it posted (or found ours). */
  function attesting(t: ReturnType<typeof world>, answers: Record<number, boolean>) {
    const asked: Array<{ prNumber: number; head: string }> = [];
    const attestHead = async (e: { prNumber: number; head: string }) => {
      asked.push(e);
      if (answers[e.prNumber] === true) {
        t.s.statuses[e.head] = { "fx-gate1": "success" };
        t.g1.creators[e.head] = OURS;
      }
      return answers[e.prNumber] === true;
    };
    return { asked, attestHead };
  }

  it("a head with only a foreign fx-gate1 is attested first, then the entry is posted; a head that is already ours is never asked about", async () => {
    const t = world({ heads: { [H11]: FOREIGN, [H12]: {}, [H13]: null } });
    const a = attesting(t, { 11: true });
    expect(await t.run({ attestHead: a.attestHead })).toEqual({ kind: "posted", state: "success" });
    expect(a.asked).toEqual([{ prNumber: 11, head: H11 }]);
    expect(t.posts()).toEqual([{ sha: E12, body: { state: "success", context: "fx-gate1", description: GATE1_DESCRIPTIONS.success } }]);
    expect(t.fake.denied).toEqual([]);
    expect(t.fake.refused).toEqual([]);
  });

  it("a head with no fx-gate1 at all (the entry's own, say) is attested the same way", async () => {
    const t = world({ heads: { [H11]: {}, [H12]: null, [H13]: null } });
    const a = attesting(t, { 12: true });
    expect(await t.run({ attestHead: a.attestHead })).toEqual({ kind: "posted", state: "success" });
    expect(a.asked).toEqual([{ prNumber: 12, head: H12 }]);
  });

  it("a team pull request ahead (not a cloud item: the attester answers false) still waits and nothing is posted; the entry behind is never asked", async () => {
    const t = world({ heads: { [H11]: FOREIGN, [H12]: {}, [H13]: null } });
    const a = attesting(t, {});
    expect(await t.run({ attestHead: a.attestHead })).toEqual({ kind: "wait", reason: "group_head_unattested" });
    expect(a.asked).toEqual([{ prNumber: 11, head: H11 }]);
    expect(t.s.posts).toEqual([]);
  });

  it("an attester that claims success but left the head not ours is not believed: the head is read again, the entry waits", async () => {
    const t = world({ heads: { [H11]: FOREIGN, [H12]: {}, [H13]: null } });
    expect(await t.run({ attestHead: async () => true })).toEqual({ kind: "wait", reason: "group_head_unattested" });
    expect(t.s.posts).toEqual([]);
  });

  it("no attester given: as before (wait); red or still-running entry runs never ask the attester; an attester that throws posts nothing", async () => {
    const heads = { [H11]: FOREIGN, [H12]: {}, [H13]: null };
    expect(await world({ heads }).run()).toEqual({ kind: "wait", reason: "group_head_unattested" });
    const red = green();
    red[2] = { ...red[2]!, conclusion: "failure" };
    const t = world({ heads, runs: red });
    const a = attesting(t, { 11: true });
    expect(await t.run({ attestHead: a.attestHead })).toEqual({ kind: "posted", state: "failure", reason: "ci_red" });
    expect(a.asked).toEqual([]);
    const running = green();
    running[0] = { ...running[0]!, status: "in_progress", conclusion: null };
    const r = world({ heads, runs: running });
    const b = attesting(r, { 11: true });
    expect(await r.run({ attestHead: b.attestHead })).toEqual({ kind: "wait", reason: "check_running" });
    expect(b.asked).toEqual([]);
    const boom = world({ heads });
    await expect(boom.run({ attestHead: async () => Promise.reject(new Error("no installation")) })).rejects.toThrow(/no installation/);
    expect(boom.s.posts).toEqual([]);
  });
});

describe("listQueueEntryCandidates: the re-check after a pull request leaves the queue", () => {
  const REPOS = new Set(["acme/widgets-public"]);
  const list = (t: ReturnType<typeof world>) => listQueueEntryCandidates(t.fake.http, { repos: REPOS, owner: "acme", name: "widgets-public", base: "main" });
  /** Asks the attester about the candidate behind the exited pull request, as the webhook does (the world holds the checks of entry 12 only). */
  const recheck = async (t: ReturnType<typeof world>, exited: number) => {
    const out: unknown[] = [];
    for (const c of (await list(t)).filter((x) => x.prNumber !== exited && x.prNumber === 12)) out.push(await t.run({ prNumber: c.prNumber, baseSha: c.baseSha, entrySha: c.entrySha }));
    return out;
  };

  it("front of the queue first, with each entry's commit and base; only the attester's read (A18) is used", async () => {
    const t = world();
    expect(await list(t)).toEqual([
      { prNumber: 11, baseSha: MAIN, entrySha: E11 },
      { prNumber: 12, baseSha: E11, entrySha: E12 },
      { prNumber: 13, baseSha: E12, entrySha: E13 },
    ]);
    expect(new Set(t.fake.calls.map((c) => c.label))).toEqual(new Set(["A18"]));
    expect(await listQueueEntryCandidates(t.fake.http, { repos: new Set(), owner: "acme", name: "widgets-public", base: "main" })).toEqual([]);
    expect(await listQueueEntryCandidates(t.fake.http, { repos: REPOS, owner: "acme", name: "widgets-public", base: "a..b" })).toEqual([]);
  });

  it("an entry behind a team pull request waits; once that pull request is gone the re-check posts fx-gate1 once, and a replay posts nothing more", async () => {
    // PR 11 (a team pull request) carries no fx-gate1 of ours.
    const t = world({ heads: { [H11]: null, [H12]: {}, [H13]: null } });
    expect(await t.run()).toEqual({ kind: "wait", reason: "group_head_unattested" });
    expect(t.posts()).toEqual([]);
    // PR 11 merged: PR 12 is at the front now (its entry commit and base are unchanged).
    t.g1.queues!.main = [{ position: 1, entryOid: E12, baseOid: E11, prNumber: 12, prHead: H12 }, { position: 2, entryOid: E13, baseOid: E12, prNumber: 13, prHead: H13 }];
    expect(await recheck(t, 11)).toEqual([{ kind: "posted", state: "success" }]);
    expect(t.posts()).toHaveLength(1);
    // The same exit delivered again, or two at once after the first: the attester's own already-posted check answers.
    expect(await recheck(t, 11)).toEqual([{ kind: "already" }]);
    expect(await Promise.all([recheck(t, 11), recheck(t, 11)])).toEqual([[{ kind: "already" }], [{ kind: "already" }]]);
    expect(t.posts()).toHaveLength(1);
  });

  it("a dequeue of the pull request ahead re-checks the same way (the entry rebuilt on main's tip)", async () => {
    const t = world({ heads: { [H11]: null, [H12]: {}, [H13]: null } });
    t.g1.queues!.main = [{ position: 1, entryOid: E12, baseOid: MAIN, prNumber: 12, prHead: H12 }];
    const c = (await list(t)).find((x) => x.prNumber === 12)!;
    expect(await t.run({ baseSha: c.baseSha })).toEqual({ kind: "posted", state: "success" });
  });

  it("a group that still holds a head that is not ours keeps waiting after another pull request left", async () => {
    // PR 11 (team) is still queued ahead of PR 12; the one that left was behind both.
    const t = world({ heads: { [H11]: null, [H12]: {}, [H13]: {} } });
    expect(await recheck(t, 13)).toEqual([{ kind: "wait", reason: "group_head_unattested" }]);
    expect(t.posts()).toEqual([]);
  });
});
