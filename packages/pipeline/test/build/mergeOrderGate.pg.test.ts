import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { GitHubHttp } from "../../src/build/githubMergePort.js";
import { runMergeGate } from "../../src/build/mergeGate.js";
import { createMergeOrder } from "../../src/mergeQueue/mergeOrderCheck.js";
import { runMergeGateForItem, type GoAttestation } from "../../src/review/mergeGateRun.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { discussingItem } from "../plan/helpers/panelFixtures.js";
import { startMergeTlsGitHub, type MergeTlsGitHub, type MergeWorld } from "../review/helpers/fakeGitHubMergeTls.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { seedAccount, seedRepo } from "./helpers/seed.js";

/**
 * D#483 S5-j2a2 [pg]: the order check of the direct merge gate (`mergeOrder`), driven through `runMergeGateForItem` over real Postgres and the strict GitHub fake served over real TLS
 * (`fakeGitHubMergeTls`: tree, pull files, compare and merge answers as GitHub gives them; it refuses what the real API refuses). One repository holds several pull requests, each served by
 * its own fake behind a router, and the default branch's tip is the repository's, so a merge that lands moves it for the others (`advanceTip`).
 *
 * Not faked faithfully (said in the PR): GitHub's three-way merge itself; whether a compare between two commits lists exactly the files `git diff` would (the files are given per scenario).
 */
const h = pgHarness();
const MIG = "sql";
const reverse = (s: string): string => [...s].reverse().join("");
const headOf = (pr: number): string => `${pr.toString(16).padStart(2, "0")}a1b2c3`.repeat(8).slice(0, 40);
const tipOf = (n: number): string => `${n.toString(16).padStart(2, "0")}c0ffee`.repeat(8).slice(0, 40);
const blob = `100644 blob ${"d".repeat(40)}`;
const treeOf = (paths: readonly string[]): Record<string, string> => Object.fromEntries(paths.map((p) => [p, blob]));

interface Item {
  pr: number;
  workItemId: string;
  head: string;
  g: MergeTlsGitHub;
  adds: string[];
}
interface Repo {
  accountId: string;
  repoId: string;
  items: Map<number, Item>;
  http: GitHubHttp;
  /** Requests the router saw, in order. */
  calls: string[];
  tipN: number;
  tipPaths: string[];
}

const servers: MergeTlsGitHub[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function newRepo(opts: { settings?: Record<string, unknown>; tipPaths?: string[]; executionMode?: string } = {}): Promise<Repo> {
  const accountId = randomUUID();
  const repoId = randomUUID();
  await seedAccount(h.admin, accountId);
  await seedRepo(h.admin, accountId, repoId);
  await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets', settings = $2::jsonb, execution_mode = $3 WHERE id = $1", [repoId, JSON.stringify(opts.settings ?? { autoMerge: true }), opts.executionMode ?? "sandbox"]);
  const items = new Map<number, Item>();
  const calls: string[] = [];
  const repo: Repo = { accountId, repoId, items, calls, tipN: 1, tipPaths: opts.tipPaths ?? [`${MIG}/0009_x.sql`, `${MIG}/0010_a.sql`], http: undefined as unknown as GitHubHttp };
  repo.http = {
    async request(req) {
      const pull = /\/pulls\/(\d+)/.exec(req.path);
      let item = pull ? items.get(Number(pull[1])) : undefined;
      if (!item) for (const sha of req.path.match(/[0-9a-f]{40}/g) ?? []) if ((item = [...items.values()].find((i) => i.head === sha || reverse(i.head) === sha))) break;
      item ??= items.values().next().value as Item | undefined;
      if (!item) throw new Error("mergeOrderGate: no pull request registered");
      calls.push(`${req.method} ${req.path}`);
      return item.g.http.request(req);
    },
  };
  return repo;
}

const tipWorld = (r: Repo): Partial<MergeWorld> => ({ baseTipSha: tipOf(r.tipN), baseShas: [tipOf(r.tipN)], trees: { [tipOf(r.tipN)]: treeOf(r.tipPaths) } });

/** A work item with its pull request on the repository: reviewers passed on its head, CI green, auto-merge on. `adds` are the files the pull request adds; `changed` the files it changes. */
async function addItem(r: Repo, pr: number, adds: string[], over: { changed?: string[]; world?: Partial<MergeWorld>; stage?: string } = {}): Promise<Item> {
  const { workItemId } = await discussingItem(h.runWriterPool, r.accountId, { title: `Item ${pr}`, body: "Add the files.", category: "feature", repoId: r.repoId });
  await h.admin.query("UPDATE work_items SET gh_number = $3, repo_id = $2, stage = $4, provenance = 'internal' WHERE id = $1", [workItemId, r.repoId, pr, over.stage ?? "pr_opened"]);
  const body = "1. The files are added.";
  await h.admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, $3, $4, 'system')", [r.accountId, workItemId, body, createHash("sha256").update(body).digest("hex")]);
  const head = headOf(pr);
  for (const role of ["code-reviewer", "acceptance-tester", "security-reviewer"]) {
    await h.admin.query("INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha) VALUES ($1, $2, $3, 'production', 'succeeded', $4::jsonb, $5)", [r.accountId, workItemId, role, JSON.stringify({ verdict: "pass" }), head]);
  }
  const g = await startMergeTlsGitHub({
    prNumber: pr,
    headSha: head,
    ...tipWorld(r),
    pullFiles: adds.map((filename) => ({ filename, status: "added" })),
    files: (over.changed ?? adds).map((filename) => ({ filename })),
    ...over.world,
  });
  servers.push(g);
  const item = { pr, workItemId, head, g, adds };
  r.items.set(pr, item);
  return item;
}

/** A merge landed on the default branch: the tip moves (it holds `adds` besides what it held), and every open pull request is one commit further behind, with the tip's gain on its compare. */
function advanceTip(r: Repo, gained: string[], except?: number): void {
  const before = tipOf(r.tipN);
  r.tipN += 1;
  r.tipPaths = [...r.tipPaths, ...gained.filter((p) => !r.tipPaths.includes(p))];
  for (const [n, it] of r.items) {
    Object.assign(it.g.world, tipWorld(r));
    if (n === except || it.g.world.merged) continue;
    it.g.world.behindBy += 1;
    it.g.world.compares[`${it.head}...${tipOf(r.tipN)}`] = { status: "ahead", aheadBy: it.g.world.behindBy, behindBy: 0, mergeBaseSha: before, files: gained.map((filename) => ({ filename })) };
  }
}

const gate = (r: Repo, it: Item, http: GitHubHttp = r.http) => runMergeGateForItem({ pool: h.runWriterPool, http }, { accountId: r.accountId, workItemId: it.workItemId, prNumber: it.pr });
const reasonsOf = (out: Awaited<ReturnType<typeof gate>>): string[] => (out.outcome === "ready_human_merges" ? [...out.reasons] : []);
const merged = (it: Item): boolean => it.g.world.merges.length > 0;

describe("ordering (test 1): the tip's highest key decides, from reads made at the merge", () => {
  it("an item that adds 0010_b next to the tip's 0010_a is stopped and nothing is merged; one that adds 0011_b merges", async () => {
    const r = await newRepo();
    const late = await addItem(r, 41, [`${MIG}/0010_b.sql`]);
    const fine = await addItem(r, 42, [`${MIG}/0011_b.sql`]);
    const out = await gate(r, late);
    expect(out).toMatchObject({ outcome: "ready_human_merges", reasons: ["ordered_resource_out_of_order"] });
    expect(merged(late)).toBe(false);
    expect(await gate(r, fine)).toMatchObject({ outcome: "merged", reasons: [] });
    expect(fine.g.world.merges).toEqual([{ sha: fine.head, method: "squash" }]);
  });

  it("the stop is a recorded fact with the fixed code only", async () => {
    const r = await newRepo();
    const late = await addItem(r, 41, [`${MIG}/0010_b.sql`]);
    await gate(r, late);
    const { rows } = await h.admin.query<{ code: string; reasons: string[] }>("SELECT code, reasons FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'merge_gate'", [late.workItemId]);
    expect(rows).toEqual([{ code: "ready_human_merges", reasons: ["ordered_resource_out_of_order"] }]);
  });

  it("two keys added together that repeat one another are out of order as well", async () => {
    const r = await newRepo();
    const twice = await addItem(r, 41, [`${MIG}/0011_a.sql`, `${MIG}/0011_b.sql`]);
    expect(reasonsOf(await gate(r, twice))).toEqual(["ordered_resource_out_of_order"]);
  });
});

describe("the mixed pair and the second item (tests 2 and 3)", () => {
  it("a hosted item that went through the queue's slot merged 0011_a: the direct item that adds 0011_b is stopped, and no merge call is made for it", async () => {
    const r = await newRepo();
    const queued = await addItem(r, 41, [`${MIG}/0011_a.sql`]);
    const direct = await addItem(r, 42, [`${MIG}/0011_b.sql`]);
    // The queue tick's call to the gate (it holds the slot, not the lease).
    const viaTick = await runMergeGateForItem({ pool: h.runWriterPool, http: r.http }, { accountId: r.accountId, workItemId: queued.workItemId, prNumber: 41, underQueueSlot: true });
    expect(viaTick.outcome).toBe("merged");
    advanceTip(r, [`${MIG}/0011_a.sql`], 41);
    expect(reasonsOf(await gate(r, direct))).toEqual(["ordered_resource_out_of_order"]);
    expect(merged(direct)).toBe(false);
  });

  it("two direct items for 0011: while the first merges the second waits on the lease; once the first landed, the second is stopped. Exactly one merges", async () => {
    const r = await newRepo();
    const a = await addItem(r, 41, [`${MIG}/0011_a.sql`], { world: { mergeDelayMs: 400 } });
    const b = await addItem(r, 42, [`${MIG}/0011_b.sql`]);
    const first = gate(r, a);
    for (let i = 0; i < 200 && !a.g.world.calls.some((c) => c.method === "PUT" && c.path.endsWith("/merge")); i++) await new Promise((res) => setTimeout(res, 10));
    expect(await gate(r, b)).toMatchObject({ outcome: "ready_human_merges", reasons: ["merge_repo_busy"] });
    expect((await first).outcome).toBe("merged");
    advanceTip(r, [`${MIG}/0011_a.sql`], 41);
    expect(reasonsOf(await gate(r, b))).toEqual(["ordered_resource_out_of_order"]);
    expect([merged(a), merged(b)]).toEqual([true, false]);
  });

  it("a repository switched to a configuration that lists the resource after the claims is judged by it at the merge", async () => {
    const r = await newRepo({ settings: { autoMerge: true } });
    const a = await addItem(r, 41, ["db/0003_a.sql"]);
    // No migrations directory (one file) and nothing configured: not checked.
    r.tipPaths = ["db/0002_x.sql"];
    Object.assign(a.g.world, tipWorld(r));
    expect(await gate(r, a)).toMatchObject({ outcome: "merged" });
    const b = await addItem(r, 42, ["db/0002_b.sql"]);
    await h.admin.query("UPDATE repos SET settings = $2::jsonb WHERE id = $1", [r.repoId, JSON.stringify({ autoMerge: true, orderedResources: [{ name: "db", pathPattern: "db/*.sql", keyPattern: "^(\\d{4})_", keyKind: "integer" }] })]);
    expect(reasonsOf(await gate(r, b))).toEqual(["ordered_resource_out_of_order"]);
  });
});

describe("overlap (test 5)", () => {
  it("the tip gained a change to a.ts, the pull request changes a.ts, the merge is textually clean: stopped overlap_unreviewed, nothing merged", async () => {
    const r = await newRepo();
    const it = await addItem(r, 41, [], { changed: ["src/a.ts"] });
    advanceTip(r, ["src/a.ts"]);
    expect(await gate(r, it)).toMatchObject({ outcome: "ready_human_merges", reasons: ["overlap_unreviewed"] });
    expect(merged(it)).toBe(false);
  });

  it("the same with disjoint files merges", async () => {
    const r = await newRepo();
    const it = await addItem(r, 41, [], { changed: ["src/a.ts"] });
    advanceTip(r, ["src/b.ts"]);
    expect(await gate(r, it)).toMatchObject({ outcome: "merged" });
  });

  it("a rename counts under both names", async () => {
    const r = await newRepo();
    const it = await addItem(r, 41, [], { changed: ["src/old.ts", "src/new.ts"] });
    advanceTip(r, ["src/old.ts"]);
    expect(reasonsOf(await gate(r, it))).toEqual(["overlap_unreviewed"]);
  });

  it("the same overlap after a refresh that reviewed the tip merges; a later tip that overlaps again stops it again", async () => {
    const r = await newRepo();
    const it = await addItem(r, 41, [], { changed: ["src/a.ts"] });
    advanceTip(r, ["src/a.ts"]);
    expect(reasonsOf(await gate(r, it))).toEqual(["overlap_unreviewed"]);
    // The platform refreshed the head (the merge of the tip into it, reviewed as a delta): the head holds the tip, so it is not behind and the merge base is the tip.
    it.g.world.behindBy = 0;
    it.g.world.aheadBy = 2;
    expect(await gate(r, it)).toMatchObject({ outcome: "merged" });
    const next = await addItem(r, 42, [], { changed: ["src/a.ts"] });
    advanceTip(r, ["src/a.ts"]);
    expect(reasonsOf(await gate(r, next))).toEqual(["overlap_unreviewed"]);
  });

  it("ordering and overlap both count: the card gets both reasons", async () => {
    const r = await newRepo();
    const it = await addItem(r, 41, [`${MIG}/0010_b.sql`], { changed: ["src/a.ts", `${MIG}/0010_b.sql`] });
    advanceTip(r, ["src/a.ts"]);
    expect(reasonsOf(await gate(r, it))).toEqual(["ordered_resource_out_of_order", "overlap_unreviewed"]);
  });
});

describe("a check that cannot answer is a stop, never a merge (test 7)", () => {
  const unreadable = ["ordered_resource_unreadable"];

  it("a tree read that fails", async () => {
    const r = await newRepo();
    const it = await addItem(r, 41, [`${MIG}/0011_a.sql`], { world: { treeStatus: 500 } });
    expect(reasonsOf(await gate(r, it))).toEqual(unreadable);
    expect(merged(it)).toBe(false);
  });

  it("a tree GitHub cut short", async () => {
    const r = await newRepo();
    const it = await addItem(r, 41, [`${MIG}/0011_a.sql`], { world: { truncatedTrees: [tipOf(1)] } });
    expect(reasonsOf(await gate(r, it))).toEqual(unreadable);
    expect(merged(it)).toBe(false);
  });

  it("a pull request file list at GitHub's ceiling of 3000", async () => {
    const r = await newRepo();
    const many = Array.from({ length: 3000 }, (_, i) => `docs/f${i}.md`);
    const it = await addItem(r, 41, many);
    expect(reasonsOf(await gate(r, it))).toEqual(unreadable);
    expect(merged(it)).toBe(false);
  });

  it("a compare that fails", async () => {
    const r = await newRepo();
    const it = await addItem(r, 41, [`${MIG}/0011_a.sql`]);
    const failing: GitHubHttp = { request: async (req) => (req.path.includes("/compare/") ? { status: 500, body: { message: "Server Error" } } : r.http.request(req)) };
    expect(reasonsOf(await gate(r, it, failing))).toEqual(unreadable);
    expect(merged(it)).toBe(false);
  });

  it("a behind head whose compare lists 300 files (GitHub's cap) is unknown, not clean", async () => {
    const r = await newRepo();
    const changed = Array.from({ length: 300 }, (_, i) => `src/f${i}.ts`);
    const it = await addItem(r, 41, [], { changed });
    advanceTip(r, ["src/other.ts"]);
    expect(reasonsOf(await gate(r, it))).toEqual(unreadable);
    expect(merged(it)).toBe(false);
  });

  it("the tip's compare capped at 300 files is unknown as well", async () => {
    const r = await newRepo();
    const it = await addItem(r, 41, [], { changed: ["src/a.ts"] });
    advanceTip(r, Array.from({ length: 300 }, (_, i) => `src/g${i}.ts`));
    expect(reasonsOf(await gate(r, it))).toEqual(unreadable);
  });

  it("a check that throws is the same stop, and a port that answers outside its list is too", async () => {
    const deps = (mergeOrder: NonNullable<Parameters<typeof runMergeGate>[0]["mergeOrder"]>) => ({
      pool: h.runWriterPool,
      isAutoMergeAllowed: async () => true,
      requestReviews: async () => undefined,
      mergeOrder,
    });
    const r = await newRepo();
    const it = await addItem(r, 41, [`${MIG}/0011_a.sql`]);
    const { createGitHubMergeGatePort } = await import("../../src/build/githubMergePort.js");
    const github = createGitHubMergeGatePort({ http: r.http, resolveRepo: async () => ({ owner: "acme", name: "widgets" }), markReadyForHumanMerge: async () => undefined });
    const input = { accountId: r.accountId, workItemId: it.workItemId, pr: { repoId: r.repoId, prNumber: 41 }, tier: "small" as const, securityDiffTriggerFired: false, debaterEnabled: false };
    expect(await runMergeGate({ ...deps(async () => { throw new Error("boom"); }), github }, input)).toMatchObject({ outcome: "ready_human_merges", reasons: expect.arrayContaining(["ordered_resource_unreadable"]) });
    expect(await runMergeGate({ ...deps(async () => ["ci_not_green" as never]), github }, input)).toMatchObject({ outcome: "ready_human_merges", reasons: expect.arrayContaining(["ordered_resource_unreadable"]) });
    expect(merged(it)).toBe(false);
  });

  it("orderedResources: [] is not checked, and merges without reading the tree; a tree with no migrations directory is not checked either", async () => {
    const none = await newRepo({ settings: { autoMerge: true, orderedResources: [] } });
    const a = await addItem(none, 41, [`${MIG}/0010_b.sql`]);
    expect(await gate(none, a)).toMatchObject({ outcome: "merged" });
    expect(none.calls.some((c) => c.includes("/git/trees/"))).toBe(false);
    const bare = await newRepo({ tipPaths: ["README.md", "src/a.ts"] });
    const b = await addItem(bare, 41, [`${MIG}/0001_a.sql`]);
    expect(await gate(bare, b)).toMatchObject({ outcome: "merged" });
  });
});

describe("a runner_local item (fork F2, R-C35-1): the cloud reads nothing; an item alone, or built after the others merged, is waived; a live sibling or one that merged since its build began stops it", () => {
  const stuck: GitHubHttp = { request: async () => { throw new Error("a runner_local repository is never read by the cloud"); } };
  /** Minutes before now: a transition may not be dated after the row's creation. */
  const T = (minutes: number): number => minutes - 60;
  let n = 0;
  /** A recorded move of the item into a stage at a time (the facts `work_item_transitions` keeps). */
  const moved = (r: Repo, it: Item, from: string, to: string, minutes: number) =>
    h.admin.query("INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref) VALUES ($1, $2, $3, $4, now() + ($5::int * interval '1 minute'), 'control_plane', $6)", [r.accountId, it.workItemId, from, to, minutes, `test-${++n}`]);
  const asker = (r: Repo, it: Item) => {
    const order = createMergeOrder({ pool: h.runWriterPool, github: stuck as never, runnerLocal: true }).mergeOrder;
    return () => order({ accountId: r.accountId, workItemId: it.workItemId, pr: { repoId: r.repoId, prNumber: it.pr }, headSha: it.head });
  };

  it("with another live item on the repository: runner_ordered_unsupported, with no GitHub read at all", async () => {
    const r = await newRepo({ executionMode: "runner_local" });
    const a = await addItem(r, 41, [`${MIG}/0011_a.sql`]);
    await addItem(r, 42, [`${MIG}/0011_b.sql`], { stage: "in_progress" });
    expect(await asker(r, a)()).toEqual(["runner_ordered_unsupported"]);
  });

  it("a sibling that is closed, not yet building or parked for a person (needs_human holds no slot) does not count; the item alone is waived", async () => {
    const r = await newRepo({ executionMode: "runner_local" });
    const a = await addItem(r, 41, [`${MIG}/0011_a.sql`]);
    const ask = asker(r, a);
    expect(await ask()).toEqual([]);
    for (const stage of ["closed", "closed_unmerged", "spec_ready", "triaged", "needs_human"]) {
      await addItem(r, 50 + r.items.size, [], { stage });
      expect(await ask(), stage).toEqual([]);
    }
    // Another account's item on a repository of its own is not a sibling.
    const other = await newRepo();
    await addItem(other, 41, [], { stage: "in_progress" });
    expect(await ask()).toEqual([]);
  });

  it("items built one after another stay waived: the sibling merged before this item's build began", async () => {
    const r = await newRepo({ executionMode: "runner_local" });
    const first = await addItem(r, 41, [`${MIG}/0011_a.sql`], { stage: "merged" });
    const second = await addItem(r, 42, [`${MIG}/0012_b.sql`]);
    await moved(r, first, "review_passed", "merged", T(5));
    await moved(r, second, "spec_ready", "in_progress", T(10));
    expect(await asker(r, second)()).toEqual([]);
  });

  it("the mixed pair: the runner item stops while its hosted sibling is live; the sibling merges; asked again, the runner item still stops, and 0011_b never lands", async () => {
    const r = await newRepo({ executionMode: "runner_local" });
    const runner = await addItem(r, 41, [`${MIG}/0011_b.sql`]);
    const hosted = await addItem(r, 42, [`${MIG}/0011_a.sql`]);
    await moved(r, runner, "spec_ready", "in_progress", T(0));
    await moved(r, hosted, "spec_ready", "in_progress", T(1));
    const ask = asker(r, runner);
    expect(await ask()).toEqual(["runner_ordered_unsupported"]);
    // The sibling merges: it leaves the live stages, and the facts record when.
    await h.admin.query("UPDATE work_items SET stage = 'merged' WHERE id = $1", [hosted.workItemId]);
    await moved(r, hosted, "review_passed", "merged", T(20));
    expect(await ask()).toEqual(["runner_ordered_unsupported"]);
    expect(merged(runner)).toBe(false);
  });

  it("a sibling parked for a person that then merges is caught by the look-back", async () => {
    const r = await newRepo({ executionMode: "runner_local" });
    const runner = await addItem(r, 41, [`${MIG}/0011_b.sql`]);
    const parked = await addItem(r, 42, [`${MIG}/0011_a.sql`], { stage: "needs_human" });
    await moved(r, runner, "spec_ready", "in_progress", T(0));
    expect(await asker(r, runner)()).toEqual([]);
    await h.admin.query("UPDATE work_items SET stage = 'merged' WHERE id = $1", [parked.workItemId]);
    await moved(r, parked, "needs_human", "merged", T(30));
    expect(await asker(r, runner)()).toEqual(["runner_ordered_unsupported"]);
  });

  it("a hosted sibling counts too (the mixed pair), whatever its kind", async () => {
    const r = await newRepo({ executionMode: "sandbox" });
    const a = await addItem(r, 41, [`${MIG}/0011_a.sql`]);
    await addItem(r, 42, [`${MIG}/0011_b.sql`], { stage: "review_passed" });
    await h.admin.query("UPDATE work_items SET placement = 'runner' WHERE id = $1", [a.workItemId]);
    expect(await asker(r, a)()).toEqual(["runner_ordered_unsupported"]);
  });
});

describe("a tick entry waiting in GitHub's queue (R-C35-3): a direct pull request that adds a numbered file waits; one that adds none does not", () => {
  it("waits with merge_repo_busy for an ordered file, and goes for a file that is not numbered", async () => {
    const r = await newRepo();
    const queued = await addItem(r, 41, [`${MIG}/0011_a.sql`]);
    const ordered = await addItem(r, 42, [`${MIG}/0012_b.sql`]);
    const plain = await addItem(r, 43, ["docs/readme.md"]);
    // Pull request 41 is an entry the tick put in GitHub's queue: a queue entry, and the enqueue fact that keeps the item out of every take.
    await h.admin.query("INSERT INTO merge_queue_entries (account_id, repo_id, work_item_id, pr_number, head_sha, state, approved_at) VALUES ($1, $2, $3, 41, $4, 'queued', now())", [r.accountId, r.repoId, queued.workItemId, queued.head]);
    await h.admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, dedupe_key, code, head_sha, pr_number) VALUES ($1, $2, 'merge_enqueued', $3, 'queue', $4, 41)", [r.accountId, queued.workItemId, `enqueued:${queued.head}`, queued.head]);
    expect(reasonsOf(await gate(r, ordered))).toEqual(["merge_repo_busy"]);
    expect(merged(ordered)).toBe(false);
    expect(await gate(r, plain)).toMatchObject({ outcome: "merged" });
  });
});

describe("a runner that attests the order (S5-j2c1, C34 D9 cloud part and D10): its fact is a hint the cloud combines with its own lease and gate", () => {
  const stuck: GitHubHttp = { request: async () => { throw new Error("a runner_local repository is never read by the cloud"); } };
  const TIP = "c".repeat(40);
  type Fact = NonNullable<GoAttestation["ordered"]>;
  const fact = (over: Partial<Fact> = {}): Fact => ({ verdict: "ok", tip_sha: TIP, behind: false, overlap: false, ...over });
  const att = (over: Partial<GoAttestation> = {}): GoAttestation => ({ reviewedHead: "a".repeat(40), publicHead: "b".repeat(40), same: true, incomplete: false, paths: ["src/a.ts"], ...over });
  const ask = (r: Repo, it: Item, attestation?: GoAttestation) =>
    createMergeOrder({ pool: h.runWriterPool, github: stuck as never, runnerLocal: true, attestation }).mergeOrder({ accountId: r.accountId, workItemId: it.workItemId, pr: { repoId: r.repoId, prNumber: it.pr }, headSha: it.head });
  /** A repository with a live sibling, so that a runner without the capability is stopped. */
  async function crowded() {
    const r = await newRepo({ executionMode: "runner_local" });
    const mine = await addItem(r, 41, [`${MIG}/0011_a.sql`]);
    await addItem(r, 42, [`${MIG}/0011_b.sql`], { stage: "in_progress" });
    return { r, mine };
  }
  async function runnerFor(r: Repo, o: { caps?: string[]; scope?: string[]; revoked?: boolean } = {}): Promise<string> {
    const user = randomUUID();
    await h.admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [user, `${user}@example.test`]);
    const id = await insertRunner(h.admin, r.accountId, user);
    await h.admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], revoked_at = $3 WHERE id = $1", [id, o.scope ?? [r.repoId], o.revoked ? new Date() : null]);
    await h.admin.query("INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, $3::text[])", [id, r.accountId, o.caps ?? ["plane_merge_v1", "ordered_facts_v1"]]);
    return id;
  }

  it("a capable runner's ok or none fact stands in for the stop: no reason, with a live sibling, and the cloud reads nothing", async () => {
    const { r, mine } = await crowded();
    for (const verdict of ["ok", "none"] as const) expect(await ask(r, mine, att({ orderedCapable: true, ordered: fact({ verdict }) })), verdict).toEqual([]);
  });

  it("an out-of-order fact, an overlap and an unknown give the reasons the cloud's own reads give; a capable runner with no fact is unknown", async () => {
    const { r, mine } = await crowded();
    expect(await ask(r, mine, att({ orderedCapable: true, ordered: fact({ verdict: "out_of_order", resource: "migrations", key: "key_0011", highest: "highest_0011" }) }))).toEqual(["ordered_resource_out_of_order"]);
    expect(await ask(r, mine, att({ orderedCapable: true, ordered: fact({ behind: true, overlap: true }) }))).toEqual(["overlap_unreviewed"]);
    expect(await ask(r, mine, att({ orderedCapable: true, ordered: fact({ verdict: "out_of_order", behind: true, overlap: true }) }))).toEqual(["ordered_resource_out_of_order", "overlap_unreviewed"]);
    expect(await ask(r, mine, att({ orderedCapable: true, ordered: fact({ verdict: "unknown" }) }))).toEqual(["ordered_resource_unreadable"]);
    expect(await ask(r, mine, att({ orderedCapable: true }))).toEqual(["ordered_resource_unreadable"]);
  });

  it("a runner without the capability is judged as before whatever it sent: a live sibling is runner_ordered_unsupported, and a lone item is waived", async () => {
    const { r, mine } = await crowded();
    expect(await ask(r, mine, att({ ordered: fact() }))).toEqual(["runner_ordered_unsupported"]);
    expect(await ask(r, mine, att({ orderedCapable: false, ordered: fact() }))).toEqual(["runner_ordered_unsupported"]);
    const alone = await newRepo({ executionMode: "runner_local" });
    const only = await addItem(alone, 41, [`${MIG}/0011_a.sql`]);
    expect(await ask(alone, only, att())).toEqual([]);
  });

  it("a runner that says ok when it cannot be trusted stays a hint: a repository with another pull request waiting in GitHub's queue still waits for an ordered file", async () => {
    const { r, mine } = await crowded();
    const queued = [...r.items.values()].find((i) => i.pr === 42)!;
    await h.admin.query("INSERT INTO merge_queue_entries (account_id, repo_id, work_item_id, pr_number, head_sha, state, approved_at) VALUES ($1, $2, $3, 42, $4, 'queued', now())", [r.accountId, r.repoId, queued.workItemId, queued.head]);
    await h.admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, dedupe_key, code, head_sha, pr_number) VALUES ($1, $2, 'merge_enqueued', $3, 'queue', $4, 42)", [r.accountId, queued.workItemId, `enqueued:${queued.head}`, queued.head]);
    expect(await ask(r, mine, att({ orderedCapable: true, ordered: fact({ verdict: "ok" }) }))).toEqual(["merge_repo_busy"]);
    expect(await ask(r, mine, att({ orderedCapable: true, ordered: fact({ verdict: "none" }) }))).toEqual([]);
  });

  it("a runner that loses the capability between the order and the go is stopped at the go: the order phase let the item through, the go reads the recorded hello again", async () => {
    const { r, mine } = await crowded();
    const runner = await runnerFor(r);
    expect(await askPaired(r, mine, true)).toEqual([]);
    // The runner's next hello no longer lists it (a downgrade); the go carries what the route read now: no capability.
    await h.admin.query("UPDATE runner_capabilities SET capabilities = '{plane_merge_v1}' WHERE runner_id = $1", [runner]);
    expect(await askPaired(r, mine, true)).toEqual(["runner_ordered_unsupported"]);
    expect(await ask(r, mine, att({ ordered: fact() }))).toEqual(["runner_ordered_unsupported"]);
  });

  it("the order phase of a PAIRED item (no attestation yet) lets it through when a runner of the repository can attest, and only then; the go phase judges it", async () => {
    const { r, mine } = await crowded();
    expect(await askPaired(r, mine, true)).toEqual(["runner_ordered_unsupported"]);
    await runnerFor(r, { caps: ["plane_merge_v1"] });
    expect(await askPaired(r, mine, true)).toEqual(["runner_ordered_unsupported"]);
    await runnerFor(r, { scope: [randomUUID()] });
    expect(await askPaired(r, mine, true)).toEqual(["runner_ordered_unsupported"]);
    await runnerFor(r, { revoked: true });
    expect(await askPaired(r, mine, true)).toEqual(["runner_ordered_unsupported"]);
    await runnerFor(r);
    expect(await askPaired(r, mine, true)).toEqual([]);
    // Another account's capable runner is no help to this repository.
    const other = await newRepo({ executionMode: "runner_local" });
    const otherMine = await addItem(other, 41, [`${MIG}/0011_a.sql`]);
    await addItem(other, 42, [`${MIG}/0011_b.sql`], { stage: "in_progress" });
    expect(await askPaired(other, otherMine, true)).toEqual(["runner_ordered_unsupported"]);
  });

  /** The order phase for an item with the given pairing. */
  const askPaired = (r: Repo, it: Item, paired: boolean) =>
    createMergeOrder({ pool: h.runWriterPool, github: stuck as never, runnerLocal: true, paired }).mergeOrder({ accountId: r.accountId, workItemId: it.workItemId, pr: { repoId: r.repoId, prNumber: it.pr }, headSha: it.head });

  it("an UNPAIRED item is never passed on to a go phase it does not have: with a capable runner and a live sibling it is runner_ordered_unsupported (order check)", async () => {
    const { r, mine } = await crowded();
    await runnerFor(r);
    expect(await askPaired(r, mine, false)).toEqual(["runner_ordered_unsupported"]);
    expect(await askPaired(r, mine, true)).toEqual([]);
  });

  it("an unpaired item with a capable runner, no sibling and no merge since its start still passes the order check (the gate-level cases are in mergeGatePairedLocal.pg.test.ts, which has the local-only client)", async () => {
    const r = await newRepo({ executionMode: "runner_local" });
    const only = await addItem(r, 41, [`${MIG}/0011_a.sql`]);
    await runnerFor(r);
    expect(await askPaired(r, only, false)).toEqual([]);
  });
});
