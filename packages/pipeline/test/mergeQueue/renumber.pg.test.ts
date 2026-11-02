import { afterEach, describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { RENUMBER_START_ENABLED, createOnRenumber, decideRenumber, listConflictRounds, runQueueTick, startConflictWork, type PlatformPush, type RenumberPorts, type RoundStart } from "../../src/mergeQueue/index.js";
import type { MergeWorld } from "../review/helpers/fakeGitHubMergeTls.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { BOT, T0, shaOf, startQueueRepo, type QueueItem, type QueueRepo } from "./helpers/queueRepo.js";

/**
 * D#519 MQ5-b1 over real Postgres and the strict GitHub fake served over real TLS: the START of a renumber round, through the real queue tick and the real ordered-resource check.
 * The model is never called; the run start is a recording stub that answers what the test says. What cannot be faked: which pushes the proxy really records (the proof is an
 * injected log shaped like the reader's answer, as in the conflict suite) and the executor's own renames, which MQ5-b2's end checks judge.
 */
const DIR = "packages/db/migrations";
const mig = (...keys: number[]) => keys.map((k) => `${DIR}/${String(k).padStart(4, "0")}_m.sql`);
const added = (...paths: string[]) => paths.map((filename) => ({ filename, status: "added" }));
const RUN = "22222222-2222-4222-8222-222222222222";
const commitSha = (pr: number, i: number) => `${pr.toString(16).padStart(2, "0")}${i.toString(16).padStart(2, "0")}`.repeat(10).slice(0, 40);

let repos: QueueRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.map((r) => r.close()));
  repos = [];
});

describe("D#519 MQ5-b1 renumber round start [pg]", () => {
  const db = pgHarness();
  const start = async () => {
    const r = await startQueueRepo(db);
    repos.push(r);
    return r;
  };
  /** A queued pull request that adds `adds` (written by `author`) on a default branch whose tip holds `tip`. */
  const item = async (r: QueueRepo, pr: number, adds: string[], tip: string[], author: string | null = BOT, extra: { dependsOnPrNumber?: number } = {}): Promise<QueueItem> => {
    const world: Partial<MergeWorld> = {
      pullFiles: added(...adds),
      commits: { [commitSha(pr, 0)]: { parents: [shaOf(pr, "fresh")], authorLogin: author, committerLogin: "web-flow", verified: false, files: adds.map((filename) => ({ filename })) } },
      pullCommits: [{ sha: commitSha(pr, 0), authorLogin: author, committerLogin: "web-flow" }],
    };
    const a = await r.addItem(pr, { world, ...extra });
    r.setTip(pr, shaOf(pr, "tip"), tip);
    return a;
  };
  const pushes = (pr: number, by: string | null): PlatformPush[] => (by === BOT ? [{ oldSha: null, newSha: commitSha(pr, 0), startSha: null, runId: RUN }] : []);

  /** The real `onRenumber` over the repo's real GitHub port; the run start is a recording stub. */
  function wire(r: QueueRepo, opts: { enabled?: boolean; log?: PlatformPush[]; proof?: "unread"; answer?: RoundStart } = {}) {
    const started: Array<{ pr: number; round: number; kind: string; files: readonly string[]; baseSha: string; resource: string; highest: string }> = [];
    const ports: RenumberPorts = {
      github: r.deps().github as unknown as RenumberPorts["github"],
      inTenant: (accountId, fn) => withTenant(db.pureAppUserPool, accountId, fn),
      platformCommits: async (_entry, shas) => (opts.proof === "unread" ? null : { appLogin: BOT, pushes: (opts.log ?? []).filter((p) => shas.includes(p.newSha)) }),
      async startRenumberRound({ entry, round, resource, highest }) {
        started.push({ pr: entry.prNumber, round: round.round, kind: round.kind, files: round.conflictFiles, baseSha: round.baseSha, resource, highest });
        return opts.answer ?? { ok: true, runId: RUN };
      },
    };
    return { started, onRenumber: createOnRenumber(ports, opts.enabled) };
  }
  const deps = (r: QueueRepo, onRenumber?: ReturnType<typeof wire>["onRenumber"]) => r.deps({ ordered: true, ...(onRenumber ? { onRenumber } : {}) });
  const rounds = (r: QueueRepo, workItemId: string) => withTenant(db.pureAppUserPool, r.accountId, (c) => listConflictRounds(c, r.accountId, workItemId));
  const commitReads = (r: QueueRepo) => r.calls.filter((c) => /\/pulls\/\d+\/commits/.test(c.path)).length;
  const agentRuns = async (r: QueueRepo) => Number((await db.admin.query("SELECT count(*) AS n FROM agent_runs WHERE account_id = $1", [r.accountId])).rows[0].n);

  it("the constant is on since MQ5-b2, and a start passed false reads nothing: the entry stops exactly as MQ5-a leaves it", async () => {
    expect(RENUMBER_START_ENABLED).toBe(true);
    const r = await start();
    const a = await item(r, 7, mig(710), mig(711, 712));
    const { onRenumber, started } = wire(r, { enabled: false, log: pushes(7, BOT) });
    const out = await runQueueTick(deps(r, onRenumber), r);
    expect(out.steps[0]).toEqual({ step: "released", entryId: a.entryId, why: "ordered_resource_out_of_order" });
    expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: "ordered_resource_out_of_order", workKind: null, conflictRounds: 0 });
    expect(started).toEqual([]);
    expect(commitReads(r)).toBe(0);
    expect(await rounds(r, a.workItemId)).toEqual([]);
  });

  it("enabled: a platform-authored add starts one renumber round, in one transaction, and gives the slot back", async () => {
    const r = await start();
    const a = await item(r, 7, mig(710), mig(711, 712));
    const before = await agentRuns(r);
    const { onRenumber, started } = wire(r, { enabled: true, log: pushes(7, BOT) });
    const out = await runQueueTick(deps(r, onRenumber), r);
    expect(out.steps[0]).toEqual({ step: "released", entryId: a.entryId, why: "ordered_resource_renumbering" });
    expect(started).toEqual([{ pr: 7, round: 1, kind: "renumber", files: mig(710), baseSha: shaOf(7, "tip"), resource: "migrations", highest: "0712" }]);
    expect(await r.entry(7)).toMatchObject({ state: "awaiting_work", workKind: "renumber", conflictRounds: 1, slotHolder: null, approvedAt: T0 });
    const rows = await rounds(r, a.workItemId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "renumber", round: 1, fromSha: a.head, baseSha: shaOf(7, "tip"), baseRef: "main", conflictFiles: mig(710), runId: RUN, outcome: null });
    expect(r.mergeCalls()).toEqual([]);
    // The stub starts no real run; the point is that nothing else did.
    expect(await agentRuns(r)).toBe(before);
  });

  it("autoRenumber off stops, and starts nothing", async () => {
    const r = await start();
    const a = await item(r, 7, mig(710), mig(711, 712));
    await db.admin.query("UPDATE repos SET settings = $2::jsonb WHERE id = $1", [r.repoId, JSON.stringify({ autoRenumber: false })]);
    const { onRenumber, started } = wire(r, { enabled: true, log: pushes(7, BOT) });
    await runQueueTick(deps(r, onRenumber), r);
    expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: "ordered_resource_out_of_order", conflictRounds: 0 });
    expect(started).toEqual([]);
    expect(await rounds(r, a.workItemId)).toEqual([]);
  });

  it("a file a person committed stops (rule a)", async () => {
    const r = await start();
    const a = await item(r, 7, mig(710), mig(711, 712), "alice");
    const { onRenumber, started } = wire(r, { enabled: true, log: [] });
    await runQueueTick(deps(r, onRenumber), r);
    expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: "ordered_resource_out_of_order", conflictRounds: 0 });
    expect(started).toEqual([]);
    expect(await rounds(r, a.workItemId)).toEqual([]);
  });

  it("an unread platform proof starts nothing and reads no commit", async () => {
    const r = await start();
    await item(r, 7, mig(710), mig(711, 712));
    const { onRenumber, started } = wire(r, { enabled: true, proof: "unread" });
    await runQueueTick(deps(r, onRenumber), r);
    expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: "ordered_resource_out_of_order" });
    expect([started, commitReads(r)]).toEqual([[], 0]);
  });

  it("an entry stacked on a parent is not renumbered", async () => {
    const r = await start();
    await item(r, 6, mig(701), mig(701));
    await item(r, 7, mig(710), mig(711, 712), BOT, { dependsOnPrNumber: 6 });
    const { onRenumber, started } = wire(r, { enabled: true, log: [...pushes(7, BOT)] });
    // Direct call: the decision is the unit under test (the parent would take the slot first in a tick).
    const entry = await r.entry(7);
    expect(await onRenumber(entry, "holder", { autoRenumber: true, resource: "migrations", files: mig(710), highest: "0712" }, entry.headSha)).toBe(false);
    expect(started).toEqual([]);
  });

  it("the bound is shared with conflict rounds: an entry that used both rounds on conflicts gets no renumber round; one used once gets exactly one more", async () => {
    const r = await start();
    const a = await item(r, 7, mig(710), mig(711, 712));
    await db.admin.query("UPDATE merge_queue_entries SET conflict_rounds = 2 WHERE account_id = $1 AND id = $2", [r.accountId, a.entryId]);
    const first = wire(r, { enabled: true, log: pushes(7, BOT) });
    await runQueueTick(deps(r, first.onRenumber), r);
    expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: "ordered_resource_out_of_order", conflictRounds: 2 });
    expect(first.started).toEqual([]);

    const r2 = await start();
    const b = await item(r2, 7, mig(710), mig(711, 712));
    await db.admin.query("UPDATE merge_queue_entries SET conflict_rounds = 1 WHERE account_id = $1 AND id = $2", [r2.accountId, b.entryId]);
    const second = wire(r2, { enabled: true, log: pushes(7, BOT) });
    await runQueueTick(deps(r2, second.onRenumber), r2);
    expect(await r2.entry(7)).toMatchObject({ state: "awaiting_work", workKind: "renumber", conflictRounds: 2 });
    expect(second.started).toMatchObject([{ round: 2 }]);
  });

  it("decideRenumber answers rounds_exhausted from the entry's own count, before any read", async () => {
    const r = await start();
    await item(r, 7, mig(710), mig(711, 712));
    const entry = { ...(await r.entry(7)), conflictRounds: 2 };
    let reads = 0;
    const ports = { github: new Proxy({}, { get: () => (reads++, async () => ({})) }) as unknown as RenumberPorts["github"], platformCommits: async () => (reads++, null) };
    expect(await decideRenumber(ports, entry, { autoRenumber: true, resource: "migrations", files: mig(710), highest: "0712" })).toEqual({ go: false, code: "rounds_exhausted" });
    expect(reads).toBe(0);
  });

  describe("a refused run start leaves no round", () => {
    it("a wait for capacity gives the slot back untouched and the next pass asks again", async () => {
      const r = await start();
      const a = await item(r, 7, mig(710), mig(711, 712));
      const { onRenumber, started } = wire(r, { enabled: true, log: pushes(7, BOT), answer: { ok: false, reason: "waiting_for_capacity" } });
      await runQueueTick(deps(r, onRenumber), r);
      expect(started.length).toBeGreaterThan(0);
      expect(await r.entry(7)).toMatchObject({ state: "queued", conflictRounds: 0, workKind: null, slotHolder: null });
      expect(await rounds(r, a.workItemId)).toEqual([]);
    });

    it("a refused spend stops the entry with that code and writes no round", async () => {
      const r = await start();
      const a = await item(r, 7, mig(710), mig(711, 712));
      const { onRenumber } = wire(r, { enabled: true, log: pushes(7, BOT), answer: { ok: false, reason: "refused_spend" } });
      await runQueueTick(deps(r, onRenumber), r);
      expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: "refused_spend", conflictRounds: 0 });
      expect(await rounds(r, a.workItemId)).toEqual([]);
    });

    it("any other refusal rolls the start back and the entry stops for ordering", async () => {
      const r = await start();
      const a = await item(r, 7, mig(710), mig(711, 712));
      const { onRenumber } = wire(r, { enabled: true, log: pushes(7, BOT), answer: { ok: false, reason: "invalid_input" } });
      await runQueueTick(deps(r, onRenumber), r);
      expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: "ordered_resource_out_of_order", conflictRounds: 0, workKind: null });
      expect(await rounds(r, a.workItemId)).toEqual([]);
    });
  });

  describe("the round's kind (migration 0969)", () => {
    it("a conflict round started with no kind is stored as `conflict`, and the table refuses any other kind", async () => {
      const r = await start();
      const a = await r.addItem(7, {});
      const out = await withTenant(db.pureAppUserPool, r.accountId, (c) => startConflictWork(c, { accountId: r.accountId, entryId: a.entryId, fromSha: a.head, baseSha: shaOf(7, "tip"), baseRef: "main", conflictFiles: ["src/a.ts"] }));
      expect(out).toMatchObject({ ok: true, entry: { workKind: "conflict" }, round: { kind: "conflict" } });
      // A row written without the column (as every row was before 0969) reads back `conflict`.
      await db.admin.query(
        `INSERT INTO merge_conflict_rounds (account_id, repo_id, work_item_id, entry_id, round, from_sha, base_sha, base_ref, conflict_files)
         SELECT account_id, repo_id, work_item_id, entry_id, 2, $2, $2, 'main', ARRAY['src/b.ts'] FROM merge_conflict_rounds WHERE account_id = $1`,
        [r.accountId, shaOf(7, "fresh")],
      );
      const stored = await db.admin.query("SELECT round, kind FROM merge_conflict_rounds WHERE account_id = $1 ORDER BY round", [r.accountId]);
      expect(stored.rows).toEqual([{ round: 1, kind: "conflict" }, { round: 2, kind: "conflict" }]);
      await expect(db.admin.query("UPDATE merge_conflict_rounds SET kind = 'merge' WHERE account_id = $1", [r.accountId])).rejects.toThrow(/merge_conflict_rounds_kind_check/);
      // The column is the round's identity: the app role cannot change it after the start.
      await expect(withTenant(db.pureAppUserPool, r.accountId, (c) => c.query("UPDATE merge_conflict_rounds SET kind = 'renumber' WHERE account_id = $1", [r.accountId]))).rejects.toThrow(/permission denied/);
    });
  });
});
