import { afterEach, describe, expect, it } from "vitest";
import { MERGE_QUEUE_CI_WAIT_MINUTES, runQueueTick } from "../../src/mergeQueue/index.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { T0, shaOf, startQueueRepo, type QueueItem, type QueueRepo } from "./helpers/queueRepo.js";

/**
 * D#519 MQ5-a over real Postgres and the strict GitHub fake served over real TLS: the ordered-resource check in the queue tick. Every GitHub answer is a fake; no model is called.
 * The fake pages a pull request's files by 100 and lists no more than 3,000; its recursive tree can be marked truncated. What it cannot fake: GitHub's rate limits and the exact
 * time a tree is cut (the tests set the flag).
 */
const MIN = 60_000;
const DIR = "packages/db/migrations";
const mig = (...keys: number[]) => keys.map((k) => `${DIR}/${String(k).padStart(4, "0")}_m.sql`);
const NEWTIP = `${"f".repeat(38)}08`;
const added = (...paths: string[]) => paths.map((filename) => ({ filename, status: "added" }));

let repos: QueueRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.map((r) => r.close()));
  repos = [];
});

describe("D#519 MQ5-a ordered resources [pg]", () => {
  const db = pgHarness();
  const start = async () => {
    const r = await startQueueRepo(db);
    repos.push(r);
    return r;
  };
  /** A queued pull request that adds `adds`, on a default branch whose tip holds `tip`. */
  const item = async (r: QueueRepo, pr: number, adds: string[], tip: string[], approvedAt = T0): Promise<QueueItem> => {
    const a = await r.addItem(pr, { approvedAt, world: { pullFiles: added(...adds) } });
    r.setTip(pr, shaOf(pr, "tip"), tip);
    return a;
  };
  const deps = (r: QueueRepo, over: Parameters<QueueRepo["deps"]>[0] = {}) => r.deps({ ordered: true, ...over });
  const settings = (r: QueueRepo, value: unknown) => db.admin.query("UPDATE repos SET settings = $2::jsonb WHERE id = $1", [r.repoId, JSON.stringify(value)]);
  const facts = async (r: QueueRepo, kind: string) => (await db.admin.query(`SELECT code, reasons, pr_number, dedupe_key FROM work_item_driver_events WHERE account_id = $1 AND kind = $2 AND code LIKE 'ordered_%' ORDER BY seq`, [r.accountId, kind])).rows;
  const agentRuns = async (r: QueueRepo) => Number((await db.admin.query(`SELECT count(*) AS n FROM agent_runs WHERE account_id = $1`, [r.accountId])).rows[0].n);
  const treeReads = (r: QueueRepo) => r.calls.filter((c) => c.path.includes("/git/trees/")).length;
  
  describe("the detected default (MQ5-a-1, a-2, a-6)", () => {
    it("a-1: 0710 while main's highest is 0712 stops with the code, releases the slot, starts no agent run and never reaches the merge call", async () => {
      const r = await start();
      const a = await item(r, 7, mig(710), mig(710 - 1, 711, 712));
      const before = await agentRuns(r);
      let delta = 0;
      let conflict = 0;
      const out = await runQueueTick(deps(r, { startDeltaReview: async () => (delta++, { started: false as const, reason: "worker_unavailable" as const }), onConflict: async () => (conflict++, true) }), r);
      expect(out.steps[0]).toEqual({ step: "released", entryId: a.entryId, why: "ordered_resource_out_of_order" });
      expect(r.mergeCalls()).toEqual([]);
      expect(a.g.world.merges).toEqual([]);
      expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: "ordered_resource_out_of_order", slotHolder: null, approvedAt: T0 });
      expect([delta, conflict, await agentRuns(r) - before]).toEqual([0, 0, 0]);
      // Codes only: the resource, the key, main's highest key and the branch.
      expect(await facts(r, "stopped")).toEqual([{ code: "ordered_resource_out_of_order", reasons: ["resource_migrations", "key_0710", "highest_0712", "branch_main"], pr_number: 7, dedupe_key: `${a.head}:ordered_resource_out_of_order` }]);
    });

    it("a key above the highest merges", async () => {
      const r = await start();
      await item(r, 7, mig(713), mig(711, 712));
      expect((await runQueueTick(deps(r), r)).steps.map((s) => s.step)).toEqual(["merged", "idle"]);
      expect(r.mergeCalls()).toEqual([7]);
    });

    it("a-2: two queued pull requests add the next free number; the second, after the first merges, stops and never reaches the merge call", async () => {
      const r = await start();
      await item(r, 7, mig(713), mig(711, 712));
      const b = await item(r, 8, mig(713), mig(711, 712), new Date(T0.getTime() + MIN));
      const base = deps(r);
      // The first merge moves main: the next read of the default branch holds 0713. (The fake router sends a read that names no pull request to the first one, so both worlds learn it.)
      const moving = deps(r, {
        gate: async (args) => {
          const out = await base.gate(args);
          if (out.outcome === "merged") for (const pr of [7, 8]) r.setTip(pr, NEWTIP, mig(711, 712, 713));
          return out;
        },
      });
      const out = await runQueueTick(moving, r);
      expect(out.steps.slice(0, 2)).toEqual([{ step: "merged", entryId: expect.any(String), prNumber: 7 }, { step: "released", entryId: b.entryId, why: "ordered_resource_out_of_order" }]);
      expect(r.mergeCalls()).toEqual([7]);
      expect(b.g.world.merges).toEqual([]);
      expect(await r.entry(8)).toMatchObject({ state: "stopped", reason: "ordered_resource_out_of_order" });
      expect((await facts(r, "stopped"))[0]!.reasons).toEqual(["resource_migrations", "key_0713", "highest_0713", "branch_main"]);
    });

    it("a repeated key inside one pull request stops it, and a key equal to the highest stops it", async () => {
      const r = await start();
      const a = await item(r, 7, [...mig(713), `${DIR}/0713_other.sql`], mig(711, 712));
      await runQueueTick(deps(r), r);
      expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: "ordered_resource_out_of_order" });
      const r2 = await start();
      await item(r2, 7, mig(712), mig(711, 712));
      await runQueueTick(deps(r2), r2);
      expect(await r2.entry(7)).toMatchObject({ state: "stopped" });
      expect(a.g.world.merges).toEqual([]);
    });

    it("a repository with no migrations directory is not checked", async () => {
      const r = await start();
      await item(r, 7, ["src/a.ts"], ["src/b.ts", "README.md"]);
      expect((await runQueueTick(deps(r), r)).steps[0]).toMatchObject({ step: "merged" });
    });

    it("a-6: the check reads the tree at each take: after main moves, a second tick sees the new highest", async () => {
      const r = await start();
      const a = await item(r, 7, mig(713), mig(711, 712));
      a.g.world.treeStatus = 500;
      expect((await runQueueTick(deps(r), r)).steps[0]).toMatchObject({ step: "parked", why: "ordered_resource_unknown" });
      a.g.world.treeStatus = 200;
      const reads = treeReads(r);
      r.setTip(7, NEWTIP, mig(711, 712, 713, 714));
      expect((await runQueueTick(deps(r), r)).steps[0]).toMatchObject({ step: "released", why: "ordered_resource_out_of_order" });
      expect(treeReads(r)).toBeGreaterThan(reads);
      expect((await facts(r, "stopped"))[0]!.reasons).toEqual(["resource_migrations", "key_0713", "highest_0714", "branch_main"]);
    });
  });

  describe("a-3: unknown is neither a stop nor a merge", () => {
    const cases: Array<[string, (a: QueueItem) => void]> = [
      ["a truncated tree listing", (a) => void (a.g.world.truncatedTrees = [a.g.world.baseTipSha])],
      ["a failed tree read", (a) => void (a.g.world.treeStatus = 500)],
      ["a file list at GitHub's ceiling", (a) => void (a.g.world.pullFiles = added(...Array.from({ length: 3000 }, (_, i) => `docs/${i}.md`)))],
    ];
    it.each(cases)("%s: the entry waits with its slot, one fact is recorded for the head, and nothing is merged or stopped", async (_name, break_) => {
      const r = await start();
      const a = await item(r, 7, mig(710), mig(711, 712));
      break_(a);
      const first = await runQueueTick(deps(r), r);
      expect(first.steps).toEqual([{ step: "parked", entryId: a.entryId, why: "ordered_resource_unknown" }]);
      expect(await r.entry(7)).toMatchObject({ state: "in_flight", phase: "parked" });
      expect(r.mergeCalls()).toEqual([]);
      await runQueueTick(deps(r), r);
      expect(await r.entry(7)).toMatchObject({ state: "in_flight" });
      expect(await facts(r, "merge_gate")).toEqual([{ code: "ordered_resource_unknown", reasons: [], pr_number: 7, dedupe_key: `${a.head}:ordered_resource_unknown` }]);
      expect(await facts(r, "stopped")).toEqual([]);
    });

    it("a file list that cannot be read waits the same way", async () => {
      const r = await start();
      const a = await item(r, 7, mig(713), mig(711, 712));
      const github = { ...deps(r).github, listPullRequestAdds: async () => Promise.reject(new Error("socket hang up")) };
      expect((await runQueueTick(deps(r, { github }), r)).steps).toEqual([{ step: "parked", entryId: a.entryId, why: "ordered_resource_unknown" }]);
      expect(r.mergeCalls()).toEqual([]);
    });

    it("the wait is bounded by the CI wait: past it the entry stops with ordered_resource_unreadable and the slot is free", async () => {
      const r = await start();
      const a = await item(r, 7, mig(713), mig(711, 712));
      a.g.world.truncatedTrees = [a.g.world.baseTipSha];
      await runQueueTick(deps(r), r);
      // The wait counts from the take: move the take back, so the clock and the lease stay real.
      const takenAgo = (m: number) => db.admin.query(`UPDATE merge_queue_entries SET slot_taken_at = now() - make_interval(mins => $2) WHERE id = $1`, [a.entryId, m]);
      await takenAgo(MERGE_QUEUE_CI_WAIT_MINUTES - 1);
      expect((await runQueueTick(deps(r), r)).steps[0]).toMatchObject({ step: "parked" });
      await takenAgo(MERGE_QUEUE_CI_WAIT_MINUTES + 1);
      const late = await runQueueTick(deps(r), r);
      expect(late.steps[0]).toEqual({ step: "released", entryId: a.entryId, why: "ordered_resource_unreadable" });
      expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: "ordered_resource_unreadable", slotHolder: null });
      expect(await facts(r, "stopped")).toEqual([{ code: "ordered_resource_unreadable", reasons: [], pr_number: 7, dedupe_key: `${a.head}:ordered_resource_unreadable` }]);
      expect(r.mergeCalls()).toEqual([]);
    });

    it("once the read works the same entry is checked and merges", async () => {
      const r = await start();
      const a = await item(r, 7, mig(713), mig(711, 712));
      a.g.world.treeStatus = 500;
      await runQueueTick(deps(r), r);
      a.g.world.treeStatus = 200;
      expect((await runQueueTick(deps(r), r)).steps[0]).toMatchObject({ step: "merged" });
    });
  });

  describe("configured resources (a-4)", () => {
    const adr = { name: "adr", pathPattern: "docs/adr/*.md", keyPattern: "^(\\d{3})-.+\\.md$", keyKind: "integer" };
    const tip = ["docs/adr/006-a.md", "docs/adr/007-b.md", ...mig(711, 712)];

    it("a configured resource replaces the detected default and stops a pull request that breaks it", async () => {
      const r = await start();
      await settings(r, { orderedResources: [adr] });
      const a = await item(r, 7, ["docs/adr/005-x.md"], tip);
      await runQueueTick(deps(r), r);
      expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: "ordered_resource_out_of_order" });
      expect((await facts(r, "stopped"))[0]!.reasons).toEqual(["resource_adr", "key_005", "highest_007", "branch_main"]);
      expect(a.g.world.merges).toEqual([]);
      // The migrations are not a resource any more: the detected default is only for a repository with no configuration.
      const r2 = await start();
      await settings(r2, { orderedResources: [adr] });
      await item(r2, 7, mig(1), tip);
      expect((await runQueueTick(deps(r2), r2)).steps[0]).toMatchObject({ step: "merged" });
    });

    it("an invalid entry is ignored whole and the rest of the configuration applies; a sixth entry is ignored", async () => {
      const r = await start();
      const extra = (name: string) => ({ ...adr, name, pathPattern: `docs/${name}/*.md` });
      await settings(r, { orderedResources: [{ ...adr, name: "evil", pathPattern: "docs/evil/*.md", keyPattern: "^(a+)+$" }, { ...adr, name: "x".repeat(41), pathPattern: "docs/long/*.md" }, adr, extra("c"), extra("d"), extra("six")] });
      // docs/evil, docs/long and docs/six are not resources; docs/adr is.
      await item(r, 7, ["docs/evil/001-x.md", "docs/long/001-x.md", "docs/six/001-x.md", "docs/adr/008-ok.md"], [...tip, "docs/evil/009-y.md", "docs/long/009-y.md", "docs/six/009-y.md"]);
      expect((await runQueueTick(deps(r), r)).steps[0]).toMatchObject({ step: "merged" });
      const r2 = await start();
      await settings(r2, { orderedResources: [{ ...adr, name: "evil", keyPattern: "^(a+)+$" }, adr] });
      await item(r2, 7, ["docs/adr/005-x.md"], tip);
      await runQueueTick(deps(r2), r2);
      expect(await r2.entry(7)).toMatchObject({ state: "stopped", reason: "ordered_resource_out_of_order" });
    });

    it("an empty list is a configuration with nothing to check: the detected default is not used", async () => {
      const r = await start();
      await settings(r, { orderedResources: [] });
      await item(r, 7, mig(710), mig(711, 712));
      expect((await runQueueTick(deps(r), r)).steps[0]).toMatchObject({ step: "merged" });
    });
  });

  describe("a-5: the configuration removed", () => {
    it("the next tick skips the check and an entry stopped only for ordering is eligible again; a stop for another reason stays", async () => {
      const r = await start();
      const adr = { name: "adr", pathPattern: "docs/adr/*.md", keyPattern: "^(\\d{3})-.+\\.md$", keyKind: "integer" };
      await settings(r, { orderedResources: [adr] });
      const a = await item(r, 7, ["docs/adr/005-x.md"], ["docs/adr/006-a.md", "docs/adr/007-b.md"]);
      const other = await item(r, 8, ["src/a.ts"], ["src/b.ts"], new Date(T0.getTime() + MIN));
      await runQueueTick(deps(r, { maxPasses: 1 }), r);
      expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: "ordered_resource_out_of_order" });
      await db.admin.query(`UPDATE merge_queue_entries SET state = 'stopped', reason = 'ci_not_green' WHERE id = $1`, [other.entryId]);
      await settings(r, {});
      const out = await runQueueTick(deps(r), r);
      expect(out.steps[0]).toMatchObject({ step: "merged", prNumber: 7 });
      expect(await r.entry(7)).toMatchObject({ state: "merged" });
      expect(await r.entry(8)).toMatchObject({ state: "stopped", reason: "ci_not_green" });
      expect(a.g.world.merges).toHaveLength(1);
    });

    it("a failed or truncated tree read does not requeue a stop: only a known 'no resource applies' does", async () => {
      for (const break_ of [(g: QueueItem["g"]) => void (g.world.treeStatus = 500), (g: QueueItem["g"]) => void (g.world.truncatedTrees = [g.world.baseTipSha])]) {
        const r = await start();
        await settings(r, { orderedResources: [{ name: "adr", pathPattern: "docs/adr/*.md", keyPattern: "^(\\d{3})-.+\\.md$", keyKind: "integer" }] });
        const a = await item(r, 7, ["docs/adr/005-x.md"], ["docs/adr/006-a.md", "docs/adr/007-b.md"]);
        await runQueueTick(deps(r, { maxPasses: 1 }), r);
        expect(await r.entry(7)).toMatchObject({ state: "stopped" });
        await settings(r, {});
        break_(a.g);
        await runQueueTick(deps(r, { maxPasses: 1 }), r);
        expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: "ordered_resource_out_of_order" });
        expect(r.mergeCalls()).toEqual([]);
      }
    });

    it("while the configuration stays, the stop stays (no tick requeues it)", async () => {
      const r = await start();
      await settings(r, { orderedResources: [{ name: "adr", pathPattern: "docs/adr/*.md", keyPattern: "^(\\d{3})-.+\\.md$", keyKind: "integer" }] });
      await item(r, 7, ["docs/adr/005-x.md"], ["docs/adr/007-b.md"]);
      await runQueueTick(deps(r), r);
      await runQueueTick(deps(r), r);
      expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: "ordered_resource_out_of_order" });
      expect(r.mergeCalls()).toEqual([]);
    });
  });
});
