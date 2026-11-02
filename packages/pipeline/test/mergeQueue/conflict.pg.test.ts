import type { PoolClient } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { MAX_CONFLICT_ROUNDS, createOnConflict, listConflictRounds, recordStop, runQueueTick, takeSlot, type ConflictPorts, type PlatformPush, type RoundStart } from "../../src/mergeQueue/index.js";
import type { MergeWorld } from "../review/helpers/fakeGitHubMergeTls.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { BOT, T0, shaOf, startQueueRepo, type QueueRepo } from "./helpers/queueRepo.js";

/**
 * D#519 MQ4-b: the conflict decision and the round start, over real Postgres (a plain `app_user` pool) and the strict GitHub fake served over real TLS,
 * through the real queue tick. C10: a commit is the platform's own when a push record covers it (walked over the parents the fake's commit reads answer)
 * or GitHub made it for our app (verified, committer `web-flow`). The records here are an injected log shaped like the reader's answer: which pushes
 * really reach the proxy, and GitHub's own `mergeable` computation, cannot be faked.
 */
const MIN = 60_000;
const RUN = "11111111-1111-4111-8111-111111111111";
/** The pushes the platform made, looked up by new tip as the record reader does. Reset after each test. */
let pushLog: PlatformPush[] = [];
let repos: QueueRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.map((r) => r.close()));
  repos = [];
  pushLog = [];
});

interface Commit {
  /** The login GitHub resolves the author to (never proof by itself), and the files the commit touched. */
  author: string | null;
  files: string[];
  /** Pushed by the platform: a record (previous commit -> this one; a create for the first). Default: the author is BOT. */
  pushed?: boolean;
  committer?: string;
  verified?: boolean;
  /** Parents, when not the previous commit. */
  parents?: string[];
}
interface Spec {
  commits: Commit[];
  prFiles?: string[];
  mainFiles?: string[];
}

const commitShaOf = (pr: number, i: number) => `${pr.toString(16).padStart(2, "0")}${i.toString(16).padStart(2, "0")}`.repeat(10).slice(0, 40);

/** The world overrides for PR `pr`: it conflicts, the default branch changed `mainFiles` since the merge base, and its commits are as given. */
function conflictWorld(pr: number, spec: Spec, defaultTipOf = pr, headSha = shaOf(pr, "head")): Partial<MergeWorld> {
  const head = headSha;
  // The fake sends a request that names no pull request (the default branch ref) to the first item added, so every item sees that item's tip.
  const tip = shaOf(defaultTipOf, "tip");
  const mergeBase = shaOf(pr, "fresh").replace(/b/g, "d");
  const commitSha = (i: number) => commitShaOf(pr, i);
  const commits: MergeWorld["commits"] = {};
  spec.commits.forEach((c, i) => {
    const parents = c.parents ?? [i === 0 ? mergeBase : commitSha(i - 1)];
    commits[commitSha(i)] = { parents, authorLogin: c.author, committerLogin: c.committer ?? "web-flow", verified: c.verified ?? false, files: c.files.map((filename) => ({ filename })) };
    if (c.pushed ?? c.author === BOT) pushLog.push({ oldSha: i === 0 ? null : commitSha(i - 1), newSha: commitSha(i), startSha: null, runId: RUN });
  });
  return {
    conflict: true,
    commits,
    pullCommits: spec.commits.map((c, i) => ({ sha: commitSha(i), authorLogin: c.author, committerLogin: c.committer ?? "web-flow" })),
    compares: {
      [`${tip}...${head}`]: { status: "diverged", aheadBy: spec.commits.length, behindBy: 1, mergeBaseSha: mergeBase, files: (spec.prFiles ?? ["src/a.ts", "src/other.ts"]).map((filename) => ({ filename })) },
      [`${mergeBase}...${tip}`]: { status: "ahead", aheadBy: 1, behindBy: 0, mergeBaseSha: mergeBase, files: (spec.mainFiles ?? ["src/a.ts"]).map((filename) => ({ filename })) },
    },
  };
}

/** The proof the record reader would give: our app's login, and the logged pushes whose new tip is one of `shas`. */
const fromLog =
  (appLogin: string | null = BOT, log: () => readonly PlatformPush[] = () => pushLog): ConflictPorts["platformCommits"] =>
  async (_entry, shas) => ({ appLogin, pushes: log().filter((p) => shas.includes(p.newSha)) });

describe("D#519 MQ4-b conflict decision and round start [pg]", () => {
  const db = pgHarness();
  const start = async () => {
    const r = await startQueueRepo(db);
    repos.push(r);
    return r;
  };
  const tenant = <T>(r: QueueRepo, fn: (client: PoolClient) => Promise<T>) => withTenant(db.pureAppUserPool, r.accountId, fn);

  /** The real onConflict over the repo's real GitHub port; the round start is a recording stub that answers `answer`. */
  function wire(r: QueueRepo, answer: (round: number) => RoundStart = () => ({ ok: true, runId: RUN }), over: Partial<ConflictPorts> = {}) {
    const started: Array<{ pr: number; round: number; files: readonly string[]; baseSha: string }> = [];
    const ports: ConflictPorts = {
      github: r.deps().github as unknown as ConflictPorts["github"],
      inTenant: (accountId, fn) => withTenant(db.pureAppUserPool, accountId, fn),
      platformCommits: fromLog(),
      async startConflictRound({ entry, round }) {
        started.push({ pr: entry.prNumber, round: round.round, files: round.conflictFiles, baseSha: round.baseSha });
        return answer(round.round);
      },
      ...over,
    };
    return { started, onConflict: createOnConflict(ports) };
  }
  const events = async (workItemId: string) => (await db.admin.query(`SELECT kind, code, reasons, round FROM work_item_driver_events WHERE work_item_id = $1 ORDER BY seq`, [workItemId])).rows as Array<{ kind: string; code: string; reasons: string[]; round: number }>;
  /** The detail rows of a work item's driver events (migration 0957), exactly. */
  const details = async (workItemId: string) =>
    (await db.admin.query(`SELECT e.code, e.reasons, d.conflict_files, d.base_ref FROM work_item_driver_event_details d JOIN work_item_driver_events e ON e.id = d.driver_event_id WHERE e.work_item_id = $1 ORDER BY e.seq`, [workItemId])).rows;
  const roundRows = async (r: QueueRepo, workItemId: string) => tenant(r, (c) => listConflictRounds(c, r.accountId, workItemId));

  it("C6-b1: a conflict on files only the platform touched starts one round, with the conflict files and the default branch's tip", async () => {
    const r = await start();
    const a = await r.addItem(7, { world: conflictWorld(7, { commits: [{ author: BOT, files: ["src/a.ts"] }, { author: "alice", files: ["src/other.ts"] }] }) });
    const { onConflict, started } = wire(r);
    const out = await runQueueTick(r.deps({ onConflict }), r);
    expect(out.conflicted).toEqual([a.entryId]);
    expect(started).toEqual([{ pr: 7, round: 1, files: ["src/a.ts"], baseSha: shaOf(7, "tip") }]);
    const e = await r.entry(7);
    expect(e).toMatchObject({ state: "awaiting_work", workKind: "conflict", conflictRounds: 1, slotHolder: null });
    const rows = await roundRows(r, a.workItemId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ round: 1, fromSha: a.head, conflictFiles: ["src/a.ts"], runId: "11111111-1111-4111-8111-111111111111" });
    expect(r.mergeCalls()).toEqual([]);
    expect((await events(a.workItemId)).filter((x) => x.kind === "stopped")).toEqual([]);
  });

  it("C8: after a refresh the round's from_sha is the live head (the refresh tip), not the entry's stored head", async () => {
    const r = await start();
    const refreshTip = shaOf(7, "fresh");
    const a = await r.addItem(7, { world: conflictWorld(7, { commits: [{ author: BOT, files: ["src/a.ts"] }] }, 7, refreshTip) });
    // The platform refreshed the branch earlier: the pull request's head is now the refresh tip, while the entry still stores the head it was enqueued at.
    r.items.get(7)!.g.world.headSha = refreshTip;
    const { onConflict, started } = wire(r);
    await runQueueTick(r.deps({ onConflict }), r);
    expect(started).toHaveLength(1);
    expect((await r.entry(7)).headSha).toBe(a.head);
    const rows = await roundRows(r, a.workItemId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ round: 1, fromSha: refreshTip });
    expect(rows[0]!.fromSha).not.toBe(a.head);
  });

  it("C8: after a refresh the conflict files are computed from the live head, never the stored one", async () => {
    const r = await start();
    const refreshTip = shaOf(7, "fresh");
    // Only the refresh tip's comparison is known to the fake: a read that named the stored head would find no files and could not start a round.
    const a = await r.addItem(7, { world: conflictWorld(7, { commits: [{ author: BOT, files: ["src/a.ts"] }] }, 7, refreshTip) });
    r.items.get(7)!.g.world.headSha = refreshTip;
    const { onConflict, started } = wire(r);
    await runQueueTick(r.deps({ onConflict }), r);
    expect(started).toEqual([{ pr: 7, round: 1, files: ["src/a.ts"], baseSha: shaOf(7, "tip") }]);
    const compares = r.calls.filter((c) => c.method === "GET" && c.path.includes("/compare/")).map((c) => c.path);
    expect(compares.some((p) => p.endsWith(`${shaOf(7, "tip")}...${refreshTip}`))).toBe(true);
    expect(compares.some((p) => p.includes(a.head))).toBe(false);
    expect((await r.entry(7)).headSha).toBe(a.head);
  });

  it("C8: a stop after a refresh records the live head, with its authorship read against the same files", async () => {
    const r = await start();
    const refreshTip = shaOf(7, "fresh");
    const a = await r.addItem(7, { world: conflictWorld(7, { commits: [{ author: BOT, files: ["src/a.ts"] }, { author: "mallory", files: ["src/a.ts"] }] }, 7, refreshTip) });
    r.items.get(7)!.g.world.headSha = refreshTip;
    const { onConflict, started } = wire(r);
    await runQueueTick(r.deps({ onConflict }), r);
    expect(started).toEqual([]);
    expect(await events(a.workItemId)).toEqual([{ kind: "stopped", code: "merge_conflict", reasons: ["foreign_commits"], round: 0 }]);
    expect(await details(a.workItemId)).toEqual([{ code: "merge_conflict", reasons: ["foreign_commits"], conflict_files: ["src/a.ts"], base_ref: "main" }]);
    const { rows } = await db.admin.query(`SELECT head_sha, dedupe_key FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'stopped'`, [a.workItemId]);
    expect(rows).toEqual([{ head_sha: refreshTip, dedupe_key: `conflict:${refreshTip}:0:foreign_commits` }]);
    expect((await r.entry(7)).headSha).toBe(a.head);
  });

  it("C6-b2: one conflict file was changed by a commit no record covers: no round, the entry stops as merge_conflict, and the fact says foreign_commits", async () => {
    const r = await start();
    const a = await r.addItem(7, { world: conflictWorld(7, { commits: [{ author: BOT, files: ["src/a.ts"] }, { author: "mallory", files: ["src/a.ts"] }] }) });
    const { onConflict, started } = wire(r);
    await runQueueTick(r.deps({ onConflict }), r);
    expect(started).toEqual([]);
    expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: "merge_conflict" });
    expect(await roundRows(r, a.workItemId)).toEqual([]);
    expect(await events(a.workItemId)).toEqual([{ kind: "stopped", code: "merge_conflict", reasons: ["foreign_commits"], round: 0 }]);
    expect(await details(a.workItemId)).toEqual([{ code: "merge_conflict", reasons: ["foreign_commits"], conflict_files: ["src/a.ts"], base_ref: "main" }]);
  });

  it("a stop after the default branch was read records its name and no files (only foreign_commits keeps files)", async () => {
    const r = await start();
    const a = await r.addItem(7, { world: conflictWorld(7, { commits: [{ author: BOT, files: ["src/a.ts"] }], mainFiles: ["src/unrelated.ts"] }) });
    const { onConflict } = wire(r);
    await runQueueTick(r.deps({ onConflict }), r);
    expect(await details(a.workItemId)).toEqual([{ code: "merge_conflict", reasons: ["no_conflict_files"], conflict_files: [], base_ref: "main" }]);
  });

  describe("C10: the platform's own commits are proved by push records or a verified app commit, never by author fields", () => {
    const agentRuns = async (r: QueueRepo) => Number((await db.admin.query(`SELECT count(*)::int AS n FROM agent_runs WHERE account_id = $1`, [r.accountId])).rows[0].n);
    /** One conflicted PR 7 with these commits, decided by one tick. */
    const run = async (commits: Commit[], over: Partial<ConflictPorts> = {}, extra: (w: Partial<MergeWorld>) => void = () => {}) => {
      pushLog = [];
      const r = await start();
      const w = conflictWorld(7, { commits });
      extra(w);
      const a = await r.addItem(7, { world: w });
      const runsBefore = await agentRuns(r);
      const { onConflict, started } = wire(r, undefined, over);
      await runQueueTick(r.deps({ onConflict }), r);
      return { r, started, entry: await r.entry(7), rows: await roundRows(r, a.workItemId), events: await events(a.workItemId), runsBefore, runsAfter: await agentRuns(r) };
    };
    const expectForeign = (out: Awaited<ReturnType<typeof run>>) => {
      expect(out.started).toEqual([]);
      expect(out.rows).toEqual([]);
      expect(out.entry).toMatchObject({ state: "stopped", reason: "merge_conflict" });
      expect(out.events).toEqual([{ kind: "stopped", code: "merge_conflict", reasons: ["foreign_commits"], round: 0 }]);
      expect(out.runsAfter).toBe(out.runsBefore);
    };
    const A = ["src/a.ts"];

    it("C10-2.1: a person's commit pushed directly on our tip, then our next push on top of it: only our new commit is covered", async () => {
      expectForeign(await run([{ author: BOT, files: A }, { author: "mallory", files: A }, { author: BOT, files: ["src/other.ts"] }]));
      // The same history with the person's commit off the conflict file: our two pushes cover the rest, so a round starts.
      expect((await run([{ author: BOT, files: A }, { author: "mallory", files: ["docs/x.md"] }, { author: BOT, files: A }])).started).toHaveLength(1);
    });

    it("C10-2.2: a person's force-push that rewrote our commits: our records name tips outside the pull request and cover nothing", async () => {
      const gone = (i: number) => "e".repeat(39) + String(i);
      const log = [{ oldSha: null, newSha: gone(1), startSha: null, runId: RUN }, { oldSha: gone(1), newSha: gone(2), startSha: null, runId: RUN }];
      expectForeign(await run([{ author: "mallory", files: A, pushed: false }], { platformCommits: fromLog(BOT, () => log) }));
      // Our next push on top of the rewritten history has a non-zero `old` outside the pull request: it covers nothing either, not even its own commit.
      const ours = commitShaOf(7, 1);
      const later = [...log, { oldSha: gone(2), newSha: ours, startSha: null, runId: RUN }];
      expectForeign(await run([{ author: "mallory", files: ["docs/x.md"], pushed: false }, { author: BOT, files: A, pushed: false }], { platformCommits: fromLog(BOT, () => later) }));
    });

    it("C10-2.3: a commit carrying the executor's git identity but pushed with no record (GitHub resolves no login) is foreign", async () => {
      expectForeign(await run([{ author: null, committer: undefined, files: A, pushed: false }]));
    });

    it("C10-2.4: an unsigned commit whose email resolves to the app's login is foreign (the spoof)", async () => {
      expectForeign(await run([{ author: BOT, committer: BOT, files: A, pushed: false }]));
      // Committed as web-flow too, and still unsigned.
      expectForeign(await run([{ author: BOT, committer: "web-flow", files: A, pushed: false }]));
    });

    it("C10-2.5: a person's verified web-UI commit (author the person, committer web-flow) is foreign", async () => {
      expectForeign(await run([{ author: "alice", committer: "web-flow", verified: true, files: A, pushed: false }]));
    });

    it("C10-3: a stacked child retargeted after its parent squash-merged: the person's commit on the parent branch stays foreign (the start bound)", async () => {
      // Parent branch: p0 (ours, created it), h (a person's, on the conflict file), t (ours, on top). The child's run started at t and created its branch with k.
      const [p0, h, t, k] = [0, 1, 2, 3].map((i) => commitShaOf(7, i)) as [string, string, string, string];
      const log: PlatformPush[] = [
        { oldSha: null, newSha: p0, startSha: null, runId: RUN },
        { oldSha: h, newSha: t, startSha: null, runId: RUN },
        { oldSha: null, newSha: k, startSha: t, runId: "22222222-2222-4222-8222-222222222222" },
      ];
      const commits: Commit[] = [{ author: BOT, files: ["src/other.ts"] }, { author: "alice", files: A }, { author: BOT, files: ["src/other.ts"] }, { author: BOT, files: A }];
      expectForeign(await run(commits.map((c) => ({ ...c, pushed: false })), { platformCommits: fromLog(BOT, () => log) }));
    });

    it("C10-4: covered cases start a round: our pushes, a commit our app made (verified, web-flow), and a stacked child's parent commits pushed by us", async () => {
      expect((await run([{ author: BOT, files: A }, { author: BOT, files: A }])).started).toHaveLength(1);
      // The author field never decides: a runner's commit carries a person's login, and the record still covers it.
      expect((await run([{ author: "alice", files: A, pushed: true }])).started).toHaveLength(1);
      // MQ3's update-branch merge: two parents, author our app, committer web-flow, verified. No record, and none needed.
      const mainTip = shaOf(7, "tip");
      const merge = { author: BOT, committer: "web-flow", verified: true, files: A, pushed: false, parents: [commitShaOf(7, 0), mainTip] };
      expect((await run([{ author: BOT, files: A }, merge])).started).toHaveLength(1);
      // ...but not when the repository's app login is unknown: only records count then.
      expectForeign(await run([{ author: BOT, files: A }, merge], { platformCommits: fromLog(null) }));
      // ...and not when GitHub's verification reason is anything but `valid`.
      expectForeign(await run([{ author: BOT, files: A }, merge], {}, (w) => (w.commits![commitShaOf(7, 1)]!.verificationReason = "unknown_key")));
      // A stacked child whose parent's commits we pushed: everything is covered.
      const [p0, t, k] = [0, 1, 2].map((i) => commitShaOf(7, i)) as [string, string, string];
      const log: PlatformPush[] = [
        { oldSha: null, newSha: p0, startSha: null, runId: RUN },
        { oldSha: p0, newSha: t, startSha: null, runId: RUN },
        { oldSha: null, newSha: k, startSha: t, runId: "22222222-2222-4222-8222-222222222222" },
      ];
      expect((await run([{ author: BOT, files: A }, { author: BOT, files: A }, { author: BOT, files: A }].map((c) => ({ ...c, pushed: false })), { platformCommits: fromLog(BOT, () => log) })).started).toHaveLength(1);
    });

    it("C10-4: the proof is asked for the pull request's own commits, by sha", async () => {
      const asked: string[][] = [];
      const out = await run([{ author: BOT, files: A }, { author: BOT, files: A }], { platformCommits: async (e, shas) => (asked.push([...shas]), fromLog()(e, shas)) });
      expect(out.started).toHaveLength(1);
      expect(asked).toEqual([[], [commitShaOf(7, 0), commitShaOf(7, 1)]]);
    });

    it("C10-8: the decision makes no new GitHub read: the default tip, two compares, the commit list, and one commit read per commit", async () => {
      const r = await start();
      await r.addItem(7, { world: conflictWorld(7, { commits: [{ author: BOT, files: A }, { author: "mallory", files: A }, { author: BOT, files: ["src/other.ts"] }] }) });
      const { onConflict } = wire(r);
      const before = r.calls.length;
      expect(await onConflict(await r.entry(7))).toBe(false);
      const paths = r.calls.slice(before).map((c) => `${c.method} ${c.path.replace(/^\/repos\/[^/]+\/[^/]+/, "")}`);
      const tip = shaOf(7, "tip");
      const base = shaOf(7, "fresh").replace(/b/g, "d");
      expect(paths).toEqual(["GET /pulls/7", "GET /git/ref/heads/main", `GET /compare/${tip}...${shaOf(7, "head")}`, `GET /compare/${base}...${tip}`, "GET /pulls/7/commits", ...[0, 1, 2].map((i) => `GET /commits/${commitShaOf(7, i)}`)]);
    });

    it("C10-6: the proof is asked for first: unread, the decision makes no GitHub call at all", async () => {
      const r = await start();
      await r.addItem(7, { world: conflictWorld(7, { commits: [{ author: BOT, files: A }] }) });
      const never = new Proxy({}, { get: (_t, name) => { throw new Error(`GitHub was read (${String(name)}) before the proof`); } }) as unknown as ConflictPorts["github"];
      const { onConflict } = wire(r, undefined, { github: never, platformCommits: async () => null });
      const before = r.calls.length;
      expect(await onConflict(await r.entry(7))).toBe(false);
      expect(r.calls.length).toBe(before);
    });

    it("a proof that turns unread between the probe and the commit read stops with identity_unread", async () => {
      let n = 0;
      const out = await run([{ author: BOT, files: A }], { platformCommits: async (e, shas) => (n++ === 0 ? fromLog()(e, shas) : null) });
      expect(out.started).toEqual([]);
      expect(out.events[0]).toMatchObject({ reasons: ["identity_unread"] });
      // Stopped after the default branch was read: its name is stored for the card (no files: only foreign_commits keeps them).
      expect(await details(out.entry.workItemId!)).toEqual([{ code: "merge_conflict", reasons: ["identity_unread"], conflict_files: [], base_ref: "main" }]);
    });
  });

  it("the round start runs under an idle_in_transaction_session_timeout set inside its own transaction", async () => {
    const r = await start();
    await r.addItem(7, { world: conflictWorld(7, { commits: [{ author: BOT, files: ["src/a.ts"] }] }) });
    let client: PoolClient | undefined;
    let seen = "";
    const { onConflict } = wire(r, undefined, {
      inTenant: (accountId, fn) => withTenant(db.pureAppUserPool, accountId, (c) => ((client = c), fn(c))),
      async startConflictRound() {
        seen = (await client!.query<{ idle_in_transaction_session_timeout: string }>("SHOW idle_in_transaction_session_timeout")).rows[0]!.idle_in_transaction_session_timeout;
        return { ok: true, runId: "11111111-1111-4111-8111-111111111111" };
      },
    });
    await runQueueTick(r.deps({ onConflict }), r);
    expect(seen).toBe("5min");
  });

  it("two overlapping ticks on one conflicted entry start ONE round: the second finds the entry moved, and stops nothing", async () => {
    const r = await start();
    const a = await r.addItem(7, { world: conflictWorld(7, { commits: [{ author: BOT, files: ["src/a.ts"] }] }) });
    const slow = { ok: true, runId: "11111111-1111-4111-8111-111111111111" } as const;
    const { onConflict, started } = wire(r, undefined, {
      async startConflictRound({ round }) {
        started2.push(round.round);
        await new Promise((res) => setTimeout(res, 400));
        return slow;
      },
    });
    const started2: number[] = [];
    const first = runQueueTick(r.deps({ onConflict }), r);
    await new Promise((res) => setTimeout(res, 100));
    const second = runQueueTick(r.deps({ onConflict }), r);
    await Promise.all([first, second]);
    expect(started).toEqual([]);
    expect(started2).toEqual([1]);
    const rows = await roundRows(r, a.workItemId);
    expect(rows).toHaveLength(1);
    expect(await r.entry(7)).toMatchObject({ state: "awaiting_work", workKind: "conflict", conflictRounds: 1 });
    expect((await events(a.workItemId)).filter((x) => x.kind === "stopped")).toEqual([]);
  });

  it("a proof that has not been read starts no round (fail closed)", async () => {
    const r = await start();
    const a = await r.addItem(7, { world: conflictWorld(7, { commits: [{ author: BOT, files: ["src/a.ts"] }] }) });
    const { onConflict, started } = wire(r, undefined, { platformCommits: async () => null });
    await runQueueTick(r.deps({ onConflict }), r);
    expect(started).toEqual([]);
    expect((await events(a.workItemId))[0]).toMatchObject({ reasons: ["identity_unread"] });
    // Stopped before any GitHub read: no branch is known, and none is fetched for the card.
    expect(await details(a.workItemId)).toEqual([]);
  });

  it("C6-b3: an entry with the bound's rounds used gets no further round, and the attempt count is on the fact", async () => {
    const r = await start();
    const a = await r.addItem(7, { world: conflictWorld(7, { commits: [{ author: BOT, files: ["src/a.ts"] }] }) });
    await db.admin.query(`UPDATE merge_queue_entries SET conflict_rounds = $2 WHERE id = $1`, [a.entryId, MAX_CONFLICT_ROUNDS]);
    const { onConflict, started } = wire(r);
    await runQueueTick(r.deps({ onConflict }), r);
    expect(started).toEqual([]);
    expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: "merge_conflict", conflictRounds: 2 });
    expect(await roundRows(r, a.workItemId)).toEqual([]);
    expect(await events(a.workItemId)).toEqual([{ kind: "stopped", code: "merge_conflict", reasons: ["rounds_exhausted"], round: 2 }]);
  });

  it("C6-b4: a start refused for spend stops the entry as refused_spend with no round row, and a second tick starts nothing", async () => {
    const r = await start();
    const a = await r.addItem(7, { world: conflictWorld(7, { commits: [{ author: BOT, files: ["src/a.ts"] }] }) });
    const { onConflict, started } = wire(r, () => ({ ok: false, reason: "refused_spend" }));
    await runQueueTick(r.deps({ onConflict }), r);
    expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: "refused_spend", conflictRounds: 0, slotHolder: null });
    expect(await roundRows(r, a.workItemId)).toEqual([]);
    await runQueueTick(r.deps({ onConflict }), r);
    expect(started).toHaveLength(1);
  });

  it("C6-b4: a wait for capacity is not a refusal: the entry stays queued with no round row and is asked again on the next pass", async () => {
    const r = await start();
    const a = await r.addItem(7, { world: conflictWorld(7, { commits: [{ author: BOT, files: ["src/a.ts"] }] }) });
    let busy = true;
    const { onConflict, started } = wire(r, () => (busy ? { ok: false, reason: "waiting_for_capacity" } : { ok: true, runId: "22222222-2222-4222-8222-222222222222" }));
    await runQueueTick(r.deps({ onConflict }), r);
    expect(await r.entry(7)).toMatchObject({ state: "queued", conflictRounds: 0, reason: null });
    expect(await roundRows(r, a.workItemId)).toEqual([]);
    busy = false;
    await runQueueTick(r.deps({ onConflict }), r);
    expect(started.map((s) => s.round)).toEqual([1, 1]);
    expect(await r.entry(7)).toMatchObject({ state: "awaiting_work", conflictRounds: 1 });
  });

  it("any other refusal to start leaves no round and stops the entry as merge_conflict", async () => {
    const r = await start();
    const a = await r.addItem(7, { world: conflictWorld(7, { commits: [{ author: BOT, files: ["src/a.ts"] }] }) });
    const { onConflict } = wire(r, () => ({ ok: false, reason: "no_session" }));
    await runQueueTick(r.deps({ onConflict }), r);
    expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: "merge_conflict", conflictRounds: 0 });
    expect(await roundRows(r, a.workItemId)).toEqual([]);
    // The tip was read, so the branch is known and stored (round_not_started).
    expect(await details(a.workItemId)).toEqual([{ code: "merge_conflict", reasons: ["round_not_started"], conflict_files: [], base_ref: "main" }]);
  });

  it("a round start that finds the bound used meanwhile (a race) stops as rounds_exhausted with the branch it already read", async () => {
    const r = await start();
    const a = await r.addItem(7, { world: conflictWorld(7, { commits: [{ author: BOT, files: ["src/a.ts"] }] }) });
    const stale = await r.entry(7);
    await db.admin.query(`UPDATE merge_queue_entries SET conflict_rounds = $2 WHERE id = $1`, [a.entryId, MAX_CONFLICT_ROUNDS]);
    const { onConflict, started } = wire(r);
    expect(await onConflict(stale)).toBe(false);
    expect(started).toEqual([]);
    expect(await details(a.workItemId)).toEqual([{ code: "merge_conflict", reasons: ["rounds_exhausted"], conflict_files: [], base_ref: "main" }]);
  });

  it("a foreign_commits stop whose paths the table would refuse is still recorded and the entry stops; the bad paths are left out of the detail", async () => {
    const r = await start();
    const bad = ["~/a.ts", "~", "C:/a.ts", "a\u2028b.ts"];
    const files = [...bad, "src/a.ts"];
    const a = await r.addItem(7, { world: conflictWorld(7, { commits: [{ author: BOT, files: ["src/a.ts"] }, { author: "mallory", files }], prFiles: files, mainFiles: files }) });
    const { onConflict, started } = wire(r);
    await runQueueTick(r.deps({ onConflict }), r);
    expect(started).toEqual([]);
    expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: "merge_conflict" });
    expect(await events(a.workItemId)).toEqual([{ kind: "stopped", code: "merge_conflict", reasons: ["foreign_commits"], round: 0 }]);
    expect(await details(a.workItemId)).toEqual([{ code: "merge_conflict", reasons: ["foreign_commits"], conflict_files: ["src/a.ts"], base_ref: "main" }]);
  });

  it("a default branch the table would refuse (a C1 control character, a line separator) leaves the branch out; the stop is still recorded", async () => {
    // The fake cannot serve such a branch name over HTTP, so the stop is recorded through recordStop with the value the decision would have passed it.
    const r = await start();
    const a = await r.addItem(7, { world: conflictWorld(7, { commits: [{ author: BOT, files: ["src/a.ts"] }] }) });
    const entry = await r.entry(7);
    const ports = { inTenant: <T,>(accountId: string, fn: (c: PoolClient) => Promise<T>) => withTenant(db.pureAppUserPool, accountId, fn) };
    for (const [i, bad] of ["ma\u0085in", "ma\u2028in", "ma\u0080in"].entries()) {
      await recordStop(ports, entry, `foreign_commits`, shaOf(7, "head").replace(/.$/, String(i)), "merge_conflict", { baseRef: bad, conflictFiles: ["src/a.ts"] });
    }
    expect((await details(a.workItemId)).map((d) => d.base_ref)).toEqual([null, null, null]);
    expect((await details(a.workItemId)).map((d) => d.conflict_files)).toEqual([["src/a.ts"], ["src/a.ts"], ["src/a.ts"]]);
  });

  it("only foreign_commits keeps files: a stop for another reason with a non-empty file list stores none", async () => {
    const r = await start();
    // 101 common files is over the bound, so the decision stops with no_conflict_files while holding a non-empty list.
    const files = Array.from({ length: 101 }, (_, i) => `src/f${String(i).padStart(3, "0")}.ts`);
    const a = await r.addItem(7, { world: conflictWorld(7, { commits: [{ author: BOT, files }], prFiles: files, mainFiles: files }) });
    const { onConflict } = wire(r);
    await runQueueTick(r.deps({ onConflict }), r);
    expect(await details(a.workItemId)).toEqual([{ code: "merge_conflict", reasons: ["no_conflict_files"], conflict_files: [], base_ref: "main" }]);
  });

  it("C6-b5: two queued entries conflicted after a merge both start their rounds in the same tick, and the clean one is not disturbed", async () => {
    const r = await start();
    // Added in this order because requests that name no pull request go to the first item: 7 and 8 share 7's default-branch tip and commit store.
    const w7 = conflictWorld(7, { commits: [{ author: BOT, files: ["src/a.ts"] }] });
    const w8 = conflictWorld(8, { commits: [{ author: BOT, files: ["src/a.ts"] }] }, 7);
    w7.commits = { ...w7.commits, ...w8.commits };
    w7.compares = { ...w7.compares, ...w8.compares };
    const b = await r.addItem(7, { approvedAt: new Date(T0.getTime() + MIN), world: w7 });
    const c = await r.addItem(8, { approvedAt: new Date(T0.getTime() + 2 * MIN), world: w8 });
    await r.addItem(6, { approvedAt: T0 });
    const { onConflict, started } = wire(r);
    const out = await runQueueTick(r.deps({ onConflict }), r);
    expect(out.conflicted.sort()).toEqual([b.entryId, c.entryId].sort());
    expect(started.map((s) => s.pr).sort()).toEqual([7, 8]);
    expect(r.mergeCalls()).toEqual([6]);
    expect((await r.entry(6)).state).toBe("merged");
    expect(await Promise.all([7, 8].map(async (pr) => (await r.entry(pr)).state))).toEqual(["awaiting_work", "awaiting_work"]);
  });

  it("C6-b6: in queue mode a conflicted entry starts a round and the old head is never sent to the host's queue", async () => {
    const r = await start();
    await r.addItem(7, { world: conflictWorld(7, { commits: [{ author: BOT, files: ["src/a.ts"] }] }) });
    const { onConflict, started } = wire(r);
    await runQueueTick(r.deps({ onConflict, queueInfo: async () => ({ mode: "queue", maxEntries: 1 }) }), r);
    await runQueueTick(r.deps({ onConflict, queueInfo: async () => ({ mode: "queue", maxEntries: 1 }) }), r);
    expect(started).toHaveLength(1);
    expect(r.calls.filter((c) => c.method === "POST" && c.path.endsWith("/graphql"))).toEqual([]);
    expect(r.calls.filter((c) => c.method === "PUT" && c.path.endsWith("/update-branch"))).toEqual([]);
    expect(r.mergeCalls()).toEqual([]);
  });

  describe("C6-b9: fail closed", () => {
    const stops = async (world: Partial<MergeWorld>, over: Partial<ConflictPorts> = {}) => {
      const r = await start();
      const a = await r.addItem(7, { world });
      const { onConflict, started } = wire(r, undefined, over);
      await runQueueTick(r.deps({ onConflict }), r);
      return { started, entry: await r.entry(7), rows: await roundRows(r, a.workItemId), events: await events(a.workItemId) };
    };
    const base = (): Partial<MergeWorld> => conflictWorld(7, { commits: [{ author: BOT, files: ["src/a.ts"] }] });

    it("a truncated commit list", async () => {
      const w = conflictWorld(7, { commits: Array.from({ length: 3 }, () => ({ author: BOT, files: ["src/a.ts"] })) });
      w.pullCommits = Array.from({ length: 300 }, (_, i) => ({ sha: (i + 1).toString(16).padStart(40, "0"), authorLogin: BOT, committerLogin: "web-flow" }));
      const out = await stops(w);
      expect(out.started).toEqual([]);
      expect(out.entry.reason).toBe("merge_conflict");
      expect(out.events[0]).toMatchObject({ reasons: ["unreadable"] });
    });

    it("a truncated file list", async () => {
      const w = base();
      const key = Object.keys(w.compares!)[0]!;
      w.compares![key]!.files = Array.from({ length: 320 }, (_, i) => ({ filename: `f/${i}.ts` }));
      const out = await stops(w);
      expect(out.started).toEqual([]);
      expect(out.events[0]).toMatchObject({ reasons: ["unreadable"] });
    });

    it("no file changed on both sides", async () => {
      const out = await stops(conflictWorld(7, { commits: [{ author: BOT, files: ["src/a.ts"] }], prFiles: ["src/a.ts"], mainFiles: ["docs/x.md"] }));
      expect(out.started).toEqual([]);
      expect(out.events[0]).toMatchObject({ reasons: ["no_conflict_files"] });
    });

    it("more than 100 commits to read", async () => {
      const commits = Array.from({ length: 101 }, () => ({ author: BOT, files: ["src/z.ts"] }));
      const out = await stops(conflictWorld(7, { commits }));
      expect(out.started).toEqual([]);
      expect(out.events[0]).toMatchObject({ reasons: ["unreadable"] });
    });

    it("a commit whose file list is cut at GitHub's cap", async () => {
      const w = base();
      const sha = w.pullCommits![0]!.sha;
      w.commits![sha]!.files = Array.from({ length: 320 }, (_, i) => ({ filename: `big/${i}.ts` }));
      const out = await stops(w);
      expect(out.started).toEqual([]);
      expect(out.events[0]).toMatchObject({ reasons: ["unreadable"] });
    });
  });

  it("a slot holder's conflict starts its round and frees its own slot in the same transaction", async () => {
    const r = await start();
    const a = await r.addItem(7, { world: conflictWorld(7, { commits: [{ author: BOT, files: ["src/a.ts"] }] }) });
    const holder = "tick:test-holder";
    const taken = await tenant(r, (c) => takeSlot(c, { accountId: r.accountId, repoId: r.repoId, holder, facts: new Map([[a.entryId, { open: true, draft: false }]]) }));
    expect(taken.taken?.state).toBe("in_flight");
    const { onConflict, started } = wire(r);
    expect(await onConflict(taken.taken!, holder)).toBe(true);
    expect(started).toHaveLength(1);
    expect(await r.entry(7)).toMatchObject({ state: "awaiting_work", workKind: "conflict", slotHolder: null, leaseUntil: null });
    // The slot is free for the next entry.
    const b = await r.addItem(8);
    const next = await tenant(r, (c) => takeSlot(c, { accountId: r.accountId, repoId: r.repoId, holder: "tick:next", facts: new Map([[b.entryId, { open: true, draft: false }]]) }));
    expect(next.taken?.prNumber).toBe(8);
  });

  it("a holder whose start waits for capacity gives its slot back", async () => {
    const r = await start();
    const a = await r.addItem(7, { world: conflictWorld(7, { commits: [{ author: BOT, files: ["src/a.ts"] }] }) });
    const holder = "tick:test-holder";
    const taken = await tenant(r, (c) => takeSlot(c, { accountId: r.accountId, repoId: r.repoId, holder, facts: new Map([[a.entryId, { open: true, draft: false }]]) }));
    const { onConflict } = wire(r, () => ({ ok: false, reason: "waiting_for_capacity" }));
    expect(await onConflict(taken.taken!, holder)).toBe(true);
    expect(await r.entry(7)).toMatchObject({ state: "queued", slotHolder: null, conflictRounds: 0 });
  });

  describe("C8: the slot holder's conflict is decided on the live head, not the stored one", () => {
    const ok = [{ author: BOT, files: ["src/a.ts"] }];
    const foreign = [{ author: BOT, files: ["src/a.ts"] }, { author: "mallory", files: ["src/a.ts"] }];
    const stoppedRows = async (workItemId: string) => (await db.admin.query(`SELECT head_sha, dedupe_key FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'stopped'`, [workItemId])).rows;
    const compared = (r: QueueRepo) => r.calls.filter((c) => c.method === "GET" && c.path.includes("/compare/")).map((c) => c.path);

    /**
     * The entry stores the head it was enqueued at, but an earlier refresh already moved the pull request to the refresh tip (a recorded
     * head_refreshes row), so the live head differs from the stored one. The recheck sees a clean pull request; the update-branch the
     * holder then asks for reports a conflict, and the holder's conflict decision must run on the refresh tip.
     */
    async function refreshConflict(commits: Spec["commits"]) {
      const r = await start();
      const live = shaOf(7, "fresh");
      const a = await r.addItem(7, { world: { ...conflictWorld(7, { commits }, 7, live), conflict: false, headSha: live, behindBy: 1 } });
      await db.admin.query(`INSERT INTO head_refreshes (account_id, repo_id, work_item_id, entry_id, from_sha, to_sha, base_sha) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [r.accountId, r.repoId, a.workItemId, a.entryId, a.head, live, shaOf(7, "tip")]);
      const w = wire(r);
      const deps = r.deps({ onConflict: w.onConflict });
      const real = deps.github.getMergeability.bind(deps.github);
      let reads = 0;
      // Only the first read (the recheck) sees a clean pull request; the holder's refresh then meets the conflict.
      deps.github = { ...deps.github, getMergeability: async (pr, o) => { const out = await real(pr, o); if (++reads === 1) a.g.world.conflict = true; return out; } };
      const out = await runQueueTick(deps, r);
      expect(out.conflicted).toEqual([]);
      expect(a.g.world.updates).toEqual([{ expected: live }]);
      expect((await r.entry(7)).headSha).toBe(a.head);
      return { r, a, live, started: w.started };
    }

    it("a refresh that reports a conflict: the round's from_sha and conflict files are the refresh tip's, and the stored head is never read", async () => {
      const { r, a, live, started } = await refreshConflict(ok);
      expect(started).toEqual([{ pr: 7, round: 1, files: ["src/a.ts"], baseSha: shaOf(7, "tip") }]);
      const rows = await roundRows(r, a.workItemId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ round: 1, fromSha: live, conflictFiles: ["src/a.ts"] });
      expect(rows[0]!.fromSha).not.toBe(a.head);
      expect(compared(r).some((p) => p.endsWith(`${shaOf(7, "tip")}...${live}`))).toBe(true);
      expect(compared(r).some((p) => p.endsWith(`...${a.head}`))).toBe(false);
      expect(await stoppedRows(a.workItemId)).toEqual([]);
    });

    it("a refresh that reports a conflict, foreign commits on the files: the stop records the refresh tip as its head", async () => {
      const { a, live, started } = await refreshConflict(foreign);
      expect(started).toEqual([]);
      expect(await stoppedRows(a.workItemId)).toEqual([{ head_sha: live, dedupe_key: `conflict:${live}:0:foreign_commits` }]);
    });

    /**
     * A refresh that succeeds moves the pull request to the refresh tip (the entry still stores the old head); the CI wait passes; the
     * gate then reads the pull request as conflicting. The gate's refusal must carry the head it ran on.
     */
    async function gateConflict(commits: Spec["commits"]) {
      const r = await start();
      const live = shaOf(7, "fresh");
      const a = await r.addItem(7, { world: { ...conflictWorld(7, { commits }, 7, live), conflict: false, behindBy: 1 } });
      const w = wire(r);
      const deps = r.deps({ onConflict: w.onConflict });
      const gate = deps.gate;
      // Update-branch is applied cleanly; the pull request turns out to conflict only once the gate reads it.
      deps.gate = async (args) => { a.g.world.conflict = true; return gate(args); };
      const out = await runQueueTick(deps, r);
      expect(out.conflicted).toEqual([]);
      expect(a.g.world.updates).toEqual([{ expected: a.head }]);
      expect(a.g.world.headSha).toBe(live);
      // The gate's merge call is refused (405) and nothing merged.
      expect(a.g.world.merged).toBe(false);
      expect((await r.entry(7)).headSha).toBe(a.head);
      return { r, a, live, started: w.started };
    }

    it("the gate refuses with merge_conflict after a refresh: the round's from_sha and conflict files are the gate's head's, not the stored head's", async () => {
      const { r, a, live, started } = await gateConflict(ok);
      expect(started).toEqual([{ pr: 7, round: 1, files: ["src/a.ts"], baseSha: shaOf(7, "tip") }]);
      const rows = await roundRows(r, a.workItemId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ round: 1, fromSha: live, conflictFiles: ["src/a.ts"] });
      expect(rows[0]!.fromSha).not.toBe(a.head);
      expect(compared(r).some((p) => p.endsWith(`${shaOf(7, "tip")}...${live}`))).toBe(true);
      // (The refresh itself compared the stored head against the base; the conflict decision must not have: no compare of the default tip to it.)
      expect(compared(r).some((p) => p.endsWith(`${shaOf(7, "tip")}...${a.head}`))).toBe(false);
      expect(await stoppedRows(a.workItemId)).toEqual([]);
    });

    it("the gate refuses with merge_conflict after a refresh, foreign commits on the files: the stop records the gate's head", async () => {
      const { a, live, started } = await gateConflict(foreign);
      expect(started).toEqual([]);
      expect(await stoppedRows(a.workItemId)).toEqual([{ head_sha: live, dedupe_key: `conflict:${live}:0:foreign_commits` }]);
    });
  });
});
