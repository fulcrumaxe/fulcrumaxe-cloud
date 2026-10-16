import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import type { PullFacts } from "@fx/core/src/plan/index.js";
import { holdWritebackForPush, releaseForWork, takeSlot, markMerged, readQueue, type PrFacts } from "../../src/mergeQueue/index.js";
import {
  WRITEBACK_COMMIT_MESSAGE,
  buildWritebackText,
  restartPlanWriteback,
  runPlanWriteback,
  writebackNotice,
  type PlanWritebackDeps,
} from "../../src/build/planWriteback.js";
import { PLAN_UPDATE_BRANCH_PREFIX, WritebackGitHubError, createWritebackGitHub } from "../../src/build/planWritebackGitHub.js";
import { seedAccount, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { APP_EMAIL, FakeGitHub, NAME, OWNER, PERSON_EMAIL } from "./helpers/fakeWritebackGitHub.js";
import { PLAN_PATH, planFile, pull } from "./helpers/planFixture.js";
import { pgHarness } from "../helpers/pgHarness.js";

/** D#598 P5b against real Postgres (plain app_user pool: row security and column grants in force) and a contract-enforcing GitHub fake. */
describe("D#598 P5b plan write-back [pg]", () => {
  const db = pgHarness();

  interface World {
    accountId: string;
    repoId: string;
    gh: FakeGitHub;
    pulls: PullFacts[];
    truncated: boolean;
    clock: { t: Date };
    deps: PlanWritebackDeps;
  }

  const count = async (table: string, accountId: string) =>
    Number((await db.admin.query(`SELECT count(*) AS n FROM ${table} WHERE account_id = $1`, [accountId])).rows[0].n);

  async function world(opts: { overlay?: string[]; plan?: string; planLevel?: string | null } = {}): Promise<World> {
    const accountId = randomUUID();
    const repoId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    await db.admin.query(`UPDATE repos SET gh_owner = $2, gh_name = $3 WHERE id = $1`, [repoId, OWNER, NAME]);
    if (opts.planLevel !== null) {
      await db.admin.query(
        `INSERT INTO plan_imports (account_id, repo_id, state, level, source_path, finished_at) VALUES ($1, $2, 'succeeded', $3, $4, now())`,
        [accountId, repoId, opts.planLevel ?? "roadmap_file", PLAN_PATH],
      );
    }
    if (opts.overlay) {
      await db.admin.query(`INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, 'acme/public', $3)`, [repoId, accountId, opts.overlay]);
    }
    const gh = new FakeGitHub({ [PLAN_PATH]: opts.plan ?? planFile() });
    const w = { accountId, repoId, gh, pulls: [] as PullFacts[], truncated: false, clock: { t: new Date("2026-10-15T10:00:00Z") } } as World;
    w.deps = {
      inTenant: (acct, fn) => withTenant(db.pureAppUserPool, acct, fn as (c: PoolClient) => Promise<never>),
      open: () => ({
        github: createWritebackGitHub({ http: gh.http, owner: OWNER, name: NAME }),
        truth: {
          head: async () => ({ defaultBranch: "main", sha: gh.tip() }),
          pulls: async () => ({ pulls: w.pulls, truncated: w.truncated }),
        },
      }),
      identity: { email: APP_EMAIL },
      now: () => w.clock.t,
    };
    return w;
  }

  const run = (w: World) => runPlanWriteback(w.deps, { accountId: w.accountId, repoId: w.repoId });
  const tenant = <T>(w: World, fn: (c: PoolClient) => Promise<T>) => withTenant(db.pureAppUserPool, w.accountId, fn);
  const wbRow = async (w: World) =>
    (await db.admin.query(`SELECT * FROM plan_writebacks WHERE account_id = $1 ORDER BY created_at, id`, [w.accountId])).rows as Array<Record<string, any>>;
  const entries = async (w: World) =>
    (await db.admin.query(`SELECT * FROM merge_queue_entries WHERE account_id = $1 ORDER BY created_at, id`, [w.accountId])).rows as Array<Record<string, any>>;
  const writes = (w: World) => w.gh.calls.filter((c) => !c.startsWith("GET "));

  it("opens one pull request that changes only the plan file, and queues it with no work item", async () => {
    const w = await world();
    w.pulls = [pull(40, "D#9:T1", "merged")];
    const out = await run(w);
    expect(out).toMatchObject({ kind: "opened", attempt: 1 });
    const prNumber = (out as { prNumber: number }).prNumber;
    const [row] = await wbRow(w);
    expect(row).toMatchObject({ state: "open", pr_number: prNumber, plan_path: PLAN_PATH });
    // the branch differs from main in the plan file only
    expect(w.gh.file(PLAN_PATH, row!.branch)).toContain('"status": "done"');
    expect(JSON.parse(w.gh.file(PLAN_PATH, row!.branch)!).task_status["D#9:T1"].prs).toEqual([40]);
    expect(w.gh.tip(row!.branch)).toBe(row!.head_sha);
    const [e] = await entries(w);
    expect(e).toMatchObject({ entry_kind: "plan_writeback", work_item_id: null, plan_writeback_id: row!.id, pr_number: prNumber, head_sha: row!.head_sha, state: "queued" });
    expect(w.gh.denied).toEqual([]);
    expect(w.gh.file(PLAN_PATH)).toBe(planFile()); // main untouched until a person merges
  });

  it("three merges in a row produce one open write-back holding all three updates, on the platform's own branch", async () => {
    const w = await world();
    w.pulls = [pull(40, "D#9:T1", "merged")];
    const first = (await run(w)) as { prNumber: number };
    const [before] = await entries(w);
    w.pulls.push(pull(41, "D#9:T4", "merged"));
    expect(await run(w)).toMatchObject({ kind: "extended", prNumber: first.prNumber });
    w.pulls.push(pull(42, "D#9:T2", "merged"), pull(43, "D#9:T2", "merged"));
    expect(await run(w)).toMatchObject({ kind: "extended", prNumber: first.prNumber });
    expect(await run(w)).toMatchObject({ kind: "unchanged" });
    expect(w.gh.prs).toHaveLength(1);
    const [row] = await wbRow(w);
    const doc = JSON.parse(w.gh.file(PLAN_PATH, row!.branch)!).task_status;
    expect(doc["D#9:T1"].prs).toEqual([40]);
    expect(doc["D#9:T4"].prs).toEqual([41]);
    expect(doc["D#9:T2"]).toMatchObject({ prs: [21, 42, 43], status: "done" });
    const [after] = await entries(w);
    expect(after!.head_sha).toBe(row!.head_sha);
    expect(after!.head_sha).not.toBe(before!.head_sha);
    expect(after!.approved_at).toEqual(before!.approved_at); // the fairness stamp never moves
    expect(after!.state).toBe("queued");
    expect(w.gh.denied).toEqual([]);
  });

  it("ten write-backs create no work item and no agent run", async () => {
    const rows = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`D#9:X${i}`, { milestone: "m1", planned_prs: 1, status: "not_started", prs: [] }]));
    const w = await world({ plan: planFile(rows) });
    for (let i = 0; i < 10; i++) {
      w.pulls.push(pull(300 + i, `D#9:X${i}`, "merged"));
      const out = await run(w);
      expect(out.kind).toBe("opened");
      w.gh.merge((out as { prNumber: number }).prNumber); // a person merges it
    }
    expect(await count("work_items", w.accountId)).toBe(0);
    expect(await count("agent_runs", w.accountId)).toBe(0);
    expect((await wbRow(w)).filter((r) => r.state === "merged")).toHaveLength(9); // the 10th settles on the next run
    expect(await run(w)).toMatchObject({ kind: "up_to_date" });
    expect((await wbRow(w)).filter((r) => r.state === "merged")).toHaveLength(10);
  });

  it("a closed-unmerged write-back is replaced by a fresh one built from current truth", async () => {
    const w = await world();
    w.pulls = [pull(40, "D#9:T1", "merged")];
    const a = (await run(w)) as { prNumber: number };
    w.gh.closeUnmerged(a.prNumber);
    const b = (await run(w)) as { kind: string; prNumber: number };
    expect(b.kind).toBe("opened");
    expect(b.prNumber).not.toBe(a.prNumber);
    expect((await wbRow(w)).map((r) => r.state)).toEqual(["closed", "open"]);
    expect((await entries(w)).map((e) => e.state)).toEqual(["closed", "queued"]);
  });

  describe("the queue (acceptance 1, 2, 7)", () => {
    const T0 = new Date("2026-10-15T10:00:00Z");
    const open: PrFacts = { open: true, draft: false };

    async function withItem(w: World, prNumber: number, approvedAt: Date) {
      const workItemId = randomUUID();
      await seedWorkItem(db.admin, w.accountId, workItemId, w.repoId, { ghNumber: prNumber });
      const { enqueueEntry } = await import("../../src/mergeQueue/index.js");
      return (await tenant(w, (c) => enqueueEntry(c, { accountId: w.accountId, repoId: w.repoId, workItemId, prNumber, headSha: "c".repeat(40), approvedAt }))).entry;
    }
    async function wbEntry(w: World) {
      w.pulls = [pull(40, "D#9:T1", "merged")];
      w.clock.t = T0;
      const out = (await run(w)) as { prNumber: number };
      const [e] = await entries(w);
      return { prNumber: out.prNumber, id: e!.id as string, head: e!.head_sha as string };
    }
    const take = (w: World, facts: Map<string, PrFacts>, now: Date, holder: string) =>
      tenant(w, (c) => takeSlot(c, { accountId: w.accountId, repoId: w.repoId, holder, facts, now }));

    it("never holds the slot together with a work item (the partial unique index), on separate connections", async () => {
      const w = await world();
      const wb = await wbEntry(w);
      const wi = await withItem(w, 9, new Date(T0.getTime() + 1000));
      const facts = new Map<string, PrFacts>([
        [wb.id, { ...open, headSha: wb.head }],
        [wi.id, open],
      ]);
      const now = new Date(T0.getTime() + 121 * 60_000); // past the yield window: both are eligible
      const results = await Promise.all([take(w, facts, now, "t1"), take(w, facts, now, "t2")]);
      expect(results.filter((r) => r.taken)).toHaveLength(1);
      const held = (await entries(w)).filter((e) => e.state === "in_flight");
      expect(held).toHaveLength(1);
      // a second in_flight row is refused by the database itself
      const other = (await entries(w)).find((e) => e.state === "queued")!;
      await expect(db.admin.query(`UPDATE merge_queue_entries SET state='in_flight', slot_holder='x', lease_until=now()+interval '1 min', slot_taken_at=now() WHERE id=$1`, [other.id])).rejects.toMatchObject({ code: "23505" });
    });

    it("yields to an eligible work item, then takes the slot after 120 minutes (time injected)", async () => {
      const w = await world();
      const wb = await wbEntry(w);
      const wi = await withItem(w, 9, new Date(T0.getTime() + 60_000));
      const facts = new Map<string, PrFacts>([
        [wb.id, { ...open, headSha: wb.head }],
        [wi.id, open],
      ]);
      const early = await take(w, facts, new Date(T0.getTime() + 30 * 60_000), "t1");
      expect(early.taken?.id).toBe(wi.id);
      await tenant(w, (c) => markMerged(c, { accountId: w.accountId, entryId: wi.id, mergedBy: "gate", holder: "t1" }));
      const next = await take(w, facts, new Date(T0.getTime() + 31 * 60_000), "t2");
      expect(next.taken?.id).toBe(wb.id); // no work item left to yield to
      // and with the work item still waiting, 120 minutes is when it stops yielding
      const w2 = await world();
      const wb2 = await wbEntry(w2);
      const wi2 = await withItem(w2, 9, new Date(T0.getTime() + 60_000));
      const facts2 = new Map<string, PrFacts>([
        [wb2.id, { ...open, headSha: wb2.head }],
        [wi2.id, open],
      ]);
      expect((await take(w2, facts2, new Date(T0.getTime() + 119 * 60_000), "t")).taken?.id).toBe(wi2.id);
      const w3 = await world();
      const wb3 = await wbEntry(w3);
      const wi3 = await withItem(w3, 9, new Date(T0.getTime() + 60_000));
      const facts3 = new Map<string, PrFacts>([
        [wb3.id, { ...open, headSha: wb3.head }],
        [wi3.id, open],
      ]);
      expect((await take(w3, facts3, new Date(T0.getTime() + 120 * 60_000), "t")).taken?.id).toBe(wb3.id);
    });

    it("the schema refuses an entry with both ids, neither id, or an agent round", async () => {
      const w = await world();
      const wb = await wbEntry(w);
      const [row] = await wbRow(w);
      const workItemId = randomUUID();
      await seedWorkItem(db.admin, w.accountId, workItemId, w.repoId, { ghNumber: 77 });
      const ins = (cols: string, vals: unknown[]) =>
        db.admin.query(`INSERT INTO merge_queue_entries (account_id, repo_id, pr_number, head_sha, approved_at, ${cols}) VALUES ($1,$2,$3,$4,now(), ${vals.map((_, i) => `$${i + 5}`).join(",")})`, [w.accountId, w.repoId, 501, "d".repeat(40), ...vals]);
      await expect(ins("entry_kind, work_item_id, plan_writeback_id", ["plan_writeback", workItemId, row!.id])).rejects.toMatchObject({ code: "23514" });
      await expect(ins("entry_kind", ["plan_writeback"])).rejects.toMatchObject({ code: "23514" });
      await expect(ins("entry_kind", ["work_item"])).rejects.toMatchObject({ code: "23514" });
      await expect(db.admin.query(`UPDATE merge_queue_entries SET state='awaiting_work', work_kind='conflict' WHERE id=$1`, [wb.id])).rejects.toMatchObject({ code: "23514" });
    });

    it("releaseForWork refuses a write-back (no agent run is ever started for it)", async () => {
      const w = await world();
      const wb = await wbEntry(w);
      const facts = new Map<string, PrFacts>([[wb.id, { ...open, headSha: wb.head }]]);
      await take(w, facts, new Date(T0.getTime() + 1000), "t1");
      const r = await tenant(w, (c) => releaseForWork(c, { accountId: w.accountId, entryId: wb.id, holder: "t1", kind: "conflict" }));
      expect(r).toEqual({ ok: false, reason: "not_a_work_item_entry" });
      expect((await tenant(w, (c) => readQueue(c, w.accountId, w.repoId))).map((e) => e.state)).toEqual(["in_flight"]);
    });

    it("records a verified refresh of a write-back head (head_refreshes has no work item)", async () => {
      const w = await world();
      const wb = await wbEntry(w);
      const facts = new Map<string, PrFacts>([[wb.id, { ...open, headSha: wb.head }]]);
      await take(w, facts, new Date(T0.getTime() + 1000), "t1");
      const { recordHeadRefresh } = await import("../../src/mergeQueue/index.js");
      const r = await tenant(w, (c) => recordHeadRefresh(c, { accountId: w.accountId, entryId: wb.id, holder: "t1", fromSha: wb.head, toSha: "e".repeat(40), baseSha: "f".repeat(40) }));
      expect(r).toMatchObject({ recorded: true });
      const rows = (await db.admin.query(`SELECT work_item_id, entry_id FROM head_refreshes WHERE account_id = $1`, [w.accountId])).rows;
      expect(rows).toEqual([{ work_item_id: null, entry_id: wb.id }]);
    });

    it("does not push while the entry holds the slot", async () => {
      const w = await world();
      const wb = await wbEntry(w);
      await take(w, new Map([[wb.id, { ...open, headSha: wb.head }]]), new Date(T0.getTime() + 1000), "t1");
      w.pulls.push(pull(41, "D#9:T4", "merged"));
      const before = writes(w).length;
      expect(await run(w)).toEqual({ kind: "deferred", reason: "slot_held" });
      expect(writes(w)).toHaveLength(before);
    });
  });

  describe("restart after a refused refresh (acceptance 3)", () => {
    it("closes its own PR, deletes its own branch and opens a fresh one; a second failure in a row stops the entry; no agent run", async () => {
      const w = await world();
      w.pulls = [pull(40, "D#9:T1", "merged")];
      const first = (await run(w)) as { prNumber: number; writebackId: string };
      const [r1] = await wbRow(w);
      w.gh.pushDefault("README.md", "other work\n"); // main moved

      const second = await restartPlanWriteback(w.deps, { accountId: w.accountId, repoId: w.repoId, writebackId: first.writebackId, cause: "merge_conflict" });
      expect(second).toMatchObject({ kind: "opened", attempt: 2 });
      expect(w.gh.prs.find((p) => p.number === first.prNumber)?.state).toBe("closed");
      expect(w.gh.branches()).not.toContain(r1!.branch);
      let rows = await wbRow(w);
      expect(rows.map((r) => r.state)).toEqual(["superseded", "open"]);
      expect(rows[0]).toMatchObject({ reason: "merge_conflict" });
      expect((await entries(w)).map((e) => e.state)).toEqual(["cancelled", "queued"]);

      const third = await restartPlanWriteback(w.deps, { accountId: w.accountId, repoId: w.repoId, writebackId: (second as { writebackId: string }).writebackId, cause: "branch_behind" });
      expect(third).toMatchObject({ kind: "stopped", cause: "branch_behind" });
      const last = (await entries(w))[1]!;
      expect(last).toMatchObject({ state: "stopped", reason: "branch_behind" });
      expect(w.gh.prs.filter((p) => p.state === "open")).toHaveLength(1); // left for a person
      expect(await count("agent_runs", w.accountId)).toBe(0);
      expect(await count("work_items", w.accountId)).toBe(0);
      expect(w.gh.denied).toEqual([]);
    });

    it("refuses to restart a row that is not the platform's open one", async () => {
      const w = await world();
      expect(await restartPlanWriteback(w.deps, { accountId: w.accountId, repoId: w.repoId, writebackId: randomUUID(), cause: "merge_conflict" })).toEqual({ kind: "not_restartable" });
    });
  });

  describe("paired repo (acceptance 5)", () => {
    it("opens nothing and records a setup need when the overlay list does not cover the plan file", async () => {
      const w = await world({ overlay: ["docs/ops/"] });
      w.pulls = [pull(40, "D#9:T1", "merged")];
      expect(await run(w)).toEqual({ kind: "needs_setup", reason: "plan_file_not_in_overlay", path: PLAN_PATH });
      expect(await run(w)).toMatchObject({ kind: "needs_setup" });
      expect(w.gh.calls).toEqual([]); // not one request: the public side is never reached either
      expect(w.gh.branches()).toEqual(["main"]);
      const rows = await wbRow(w);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ state: "needs_setup", reason: "plan_file_not_in_overlay", branch: null, pr_number: null });
      expect(await entries(w)).toEqual([]);
    });

    it("goes ahead once the overlay covers the plan file, and retires the setup need", async () => {
      const w = await world({ overlay: ["docs/ops/"] });
      w.pulls = [pull(40, "D#9:T1", "merged")];
      await run(w);
      await db.admin.query(`UPDATE repo_pairing SET overlay_globs = $2 WHERE repo_id = $1`, [w.repoId, [".autonomous-team/"]]);
      expect((await run(w)).kind).toBe("opened");
      expect((await wbRow(w)).map((r) => r.state)).toEqual(["abandoned", "open"]);
    });
  });

  describe("someone else pushes to the branch (acceptance 6)", () => {
    it("stops writing, stops the entry, and keeps the fixed sentence with the PR number", async () => {
      const w = await world();
      w.pulls = [pull(40, "D#9:T1", "merged")];
      const first = (await run(w)) as { prNumber: number };
      const [row] = await wbRow(w);
      w.gh.pushAs(row!.branch, "notes.md", "hello\n");
      w.pulls.push(pull(41, "D#9:T4", "merged"));
      const before = writes(w).length;
      expect(await run(w)).toMatchObject({ kind: "stopped_changed_by_other", prNumber: first.prNumber });
      expect(await run(w)).toMatchObject({ kind: "stopped_changed_by_other" });
      expect(writes(w)).toHaveLength(before);
      expect(w.gh.prs).toHaveLength(1); // no second write-back while that one is open
      expect((await wbRow(w))[0]).toMatchObject({ state: "changed_by_other", reason: "changed_by_someone_else" });
      expect((await entries(w))[0]).toMatchObject({ state: "stopped", reason: "writeback_changed_by_other" });
      expect(writebackNotice({ kind: "changed_by_other", prNumber: first.prNumber })).toBe(`The plan update PR #${first.prNumber} was changed by someone else. Merge or close it to resume plan updates.`);
      // a person merges it: plan updates resume
      w.gh.merge(first.prNumber);
      expect((await run(w)).kind).toBe("opened");
    });
  });

  describe("states without a pull request", () => {
    it("reports up_to_date, no_plan_file, truth_incomplete and an invalid plan file with fixed codes", async () => {
      const a = await world();
      expect(await run(a)).toEqual({ kind: "up_to_date" });
      expect(a.gh.prs).toHaveLength(0);

      const b = await world({ planLevel: "spec_tables" });
      expect(await run(b)).toEqual({ kind: "no_plan_file" });
      const none = await world({ planLevel: null });
      expect(await run(none)).toEqual({ kind: "no_plan_file" });

      const c = await world();
      c.pulls = [pull(40, "D#9:T1", "merged")];
      c.truncated = true;
      expect(await run(c)).toEqual({ kind: "truth_incomplete" });
      expect(writes(c)).toEqual([]);

      const d = await world({ plan: JSON.stringify({ milestones: { m1: { tasks: ["D#9:SECRET-KEY"] } }, task_status: {} }) });
      d.pulls = [pull(40, "D#9:T1", "merged")];
      const out = await run(d);
      expect(out).toEqual({ kind: "plan_file_invalid", code: "plan_file_invalid" });
      expect(JSON.stringify(out)).not.toContain("SECRET");
    });
  });

  describe("crash recovery", () => {
    it("adopts a branch left behind by a run that died before recording its pull request", async () => {
      const w = await world();
      w.pulls = [pull(40, "D#9:T1", "merged")];
      const id = randomUUID();
      const branch = `fulcrumaxe/plan-update-${id.slice(0, 8)}`;
      await db.admin.query(`INSERT INTO plan_writebacks (id, account_id, repo_id, state, plan_path, branch) VALUES ($1,$2,$3,'opening',$4,$5)`, [id, w.accountId, w.repoId, PLAN_PATH, branch]);
      const api = createWritebackGitHub({ http: w.gh.http, owner: OWNER, name: NAME });
      await api.createBranch(branch, w.gh.tip());
      // the dead run got as far as its one commit (truth at the time: pull 40 only); pull 41 merged since
      const first = buildWritebackText(planFile(), w.pulls);
      if (!first.ok) throw new Error("fixture");
      const blob = (await api.readFile(PLAN_PATH, w.gh.tip(), 5_000_000))!.blobSha;
      await api.putFile({ path: PLAN_PATH, branch, text: first.text, blobSha: blob, message: WRITEBACK_COMMIT_MESSAGE });
      w.pulls.push(pull(41, "D#9:T4", "merged"));
      // adopted: the PR is opened on the existing branch, then the branch is brought to current truth
      expect((await run(w)).kind).toBe("extended");
      expect(w.gh.prs).toHaveLength(1);
      expect((await wbRow(w))[0]).toMatchObject({ id, state: "open" });
      expect((await entries(w))).toHaveLength(1);
    });

    it("drops an opening row whose branch was never made", async () => {
      const w = await world();
      const id = randomUUID();
      await db.admin.query(`INSERT INTO plan_writebacks (id, account_id, repo_id, state, plan_path, branch) VALUES ($1,$2,$3,'opening',$4,$5)`, [id, w.accountId, w.repoId, PLAN_PATH, `fulcrumaxe/plan-update-${id.slice(0, 8)}`]);
      expect(await run(w)).toEqual({ kind: "up_to_date" });
      expect((await wbRow(w))[0]).toMatchObject({ state: "abandoned" });
    });
  });

  const api = (w: World) => createWritebackGitHub({ http: w.gh.http, owner: OWNER, name: NAME });
  /** Opens a write-back for pull 40 and answers its row. */
  async function opened(w: World) {
    w.pulls = [pull(40, "D#9:T1", "merged")];
    const out = (await run(w)) as { prNumber: number; writebackId: string };
    const [row] = await wbRow(w);
    return { out, row: row! };
  }

  describe("someone pushes between the platform's check and its push (compare-and-swap on the head)", () => {
    it("extend: the commit's parent is not the recorded head, so the new head is not recorded and the write-back stops", async () => {
      const w = await world();
      const { out, row } = await opened(w);
      w.pulls.push(pull(41, "D#9:T4", "merged"));
      let fired = 0;
      // after the platform has checked the head, and before its PUT lands, another identity pushes a commit that does not touch the plan file
      w.gh.onRequest = (req) => {
        if (req.method === "PUT" && fired === 0) {
          fired += 1;
          w.gh.pushAs(row.branch, "notes.md", "hello\n");
        }
      };
      const res = await run(w);
      expect(fired).toBe(1);
      expect(res).toMatchObject({ kind: "stopped_changed_by_other", prNumber: out.prNumber });
      const [after] = await wbRow(w);
      expect(after).toMatchObject({ state: "changed_by_other", reason: "changed_by_someone_else", head_sha: row.head_sha }); // stored head unchanged
      expect(w.gh.tip(row.branch)).not.toBe(row.head_sha);
      expect((await entries(w))[0]).toMatchObject({ state: "stopped", reason: "writeback_changed_by_other", head_sha: row.head_sha });
      // from here on nothing is written, and no second write-back is opened while this one is open
      w.gh.onRequest = null;
      const n = writes(w).length;
      expect(await run(w)).toMatchObject({ kind: "stopped_changed_by_other" });
      expect(writes(w)).toHaveLength(n);
      expect(w.gh.prs).toHaveLength(1);
      expect(w.gh.denied).toEqual([]);
    });

    it("openFresh: someone pushes to the fresh branch before the platform's commit; the pull request is the notice and the write-back stops", async () => {
      const w = await world();
      w.pulls = [pull(40, "D#9:T1", "merged")];
      let fired = 0;
      w.gh.onRequest = (req) => {
        if (req.method === "PUT" && fired === 0) {
          fired += 1;
          w.gh.pushAs(String((req.body as { branch: string }).branch), "notes.md", "first\n");
        }
      };
      const mainTip = w.gh.tip();
      const res = await run(w);
      expect(fired).toBe(1);
      expect(res).toMatchObject({ kind: "stopped_changed_by_other" });
      const [row] = await wbRow(w);
      expect(row).toMatchObject({ state: "changed_by_other", reason: "changed_by_someone_else", head_sha: mainTip });
      expect(w.gh.branches()).toContain(row!.branch); // someone else's commit is on it: it is left alone
      expect((await entries(w))[0]).toMatchObject({ state: "stopped", reason: "writeback_changed_by_other" });
      w.gh.onRequest = null;
      const n = writes(w).length;
      w.pulls.push(pull(41, "D#9:T4", "merged"));
      expect(await run(w)).toMatchObject({ kind: "stopped_changed_by_other" });
      expect(writes(w)).toHaveLength(n);
    });

    it("a commit that is the platform's own but was never recorded (the run died after the push) is recognised, not read as someone else's", async () => {
      const w = await world();
      const { row } = await opened(w);
      w.pulls.push(pull(41, "D#9:T4", "merged"));
      // the dead run: it held the entry, then pushed the commit it meant to, and never got to record it
      await tenant(w, (c) => holdWritebackForPush(c, { accountId: w.accountId, planWritebackId: row.id }));
      const current = (await api(w).readFile(PLAN_PATH, row.head_sha, 5_000_000))!;
      const built = buildWritebackText(planFile(), w.pulls);
      if (!built.ok) throw new Error("fixture");
      const put = await api(w).putFile({ path: PLAN_PATH, branch: row.branch, text: built.text, blobSha: current.blobSha, message: WRITEBACK_COMMIT_MESSAGE });

      expect(await run(w)).toMatchObject({ kind: "unchanged", prNumber: row.pr_number });
      const [after] = await wbRow(w);
      expect(after).toMatchObject({ state: "open", head_sha: put.commitSha, base_sha: row.base_sha, reason: null });
      expect((await entries(w))[0]).toMatchObject({ state: "queued", head_sha: put.commitSha });
    });

    it("a commit on the recorded head with a different message, or one touching another file, is someone else's", async () => {
      for (const kind of ["message", "file"] as const) {
        const w = await world();
        const { row } = await opened(w);
        w.pulls.push(pull(41, "D#9:T4", "merged"));
        if (kind === "message") {
          const current = (await api(w).readFile(PLAN_PATH, row.head_sha, 5_000_000))!;
          await api(w).putFile({ path: PLAN_PATH, branch: row.branch, text: current.text.replace("First.", "Edited."), blobSha: current.blobSha, message: "tidy up" });
        } else {
          w.gh.pushAs(row.branch, "notes.md", "x\n", WRITEBACK_COMMIT_MESSAGE);
        }
        expect(await run(w)).toMatchObject({ kind: "stopped_changed_by_other" });
        expect((await wbRow(w))[0]).toMatchObject({ state: "changed_by_other", head_sha: row.head_sha });
      }
    });
  });

  describe("branch handling", () => {
    it("openFresh does not delete a branch it did not create (branch_exists)", async () => {
      const w = await world();
      w.pulls = [pull(40, "D#9:T1", "merged")];
      const id = randomUUID();
      const branch = `${PLAN_UPDATE_BRANCH_PREFIX}${id.slice(0, 8)}`;
      await api(w).createBranch(branch, w.gh.tip()); // an orphan from an earlier run
      const before = w.gh.tip(branch);
      w.deps.newId = () => id;
      await expect(run(w)).rejects.toMatchObject({ code: "branch_exists" });
      expect(w.gh.branches()).toContain(branch);
      expect(w.gh.tip(branch)).toBe(before);
      expect(w.gh.calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
      expect((await wbRow(w))[0]).toMatchObject({ state: "abandoned" });
    });

    it("openFresh still removes a branch it did create when a later step fails", async () => {
      const w = await world();
      w.pulls = [pull(40, "D#9:T1", "merged")];
      // the transport fails on the pull request step, after the branch and the commit exist
      w.gh.onRequest = (req) => {
        if (req.method === "POST" && req.path.endsWith("/pulls")) throw new WritebackGitHubError("unavailable");
      };
      await expect(run(w)).rejects.toBeDefined();
      expect(w.gh.branches()).toEqual(["main"]);
      expect((await wbRow(w))[0]).toMatchObject({ state: "abandoned" });
    });

    it("restart re-reads the head right before the delete: a branch pushed to after the check is left for its pusher", async () => {
      const w = await world();
      const { out, row } = await opened(w);
      w.gh.onRequest = (req) => {
        if (req.method === "PATCH" && /\/pulls\/\d+$/.test(req.path)) {
          w.gh.onRequest = null;
          w.gh.pushAs(row.branch, "notes.md", "late\n"); // between the ownership check and the delete
        }
      };
      const res = await restartPlanWriteback(w.deps, { accountId: w.accountId, repoId: w.repoId, writebackId: out.writebackId, cause: "merge_conflict" });
      expect(res).toMatchObject({ kind: "opened", attempt: 2 });
      expect(w.gh.branches()).toContain(row.branch);
      expect(w.gh.calls.some((c) => c === `DELETE /repos/${OWNER}/${NAME}/git/refs/heads/${row.branch}`)).toBe(false);
      expect((await wbRow(w)).map((r) => r.state)).toEqual(["superseded", "open"]);
    });
  });

  describe("a stopped entry stays stopped (acceptance 3)", () => {
    it("holdWritebackForPush takes only a queued entry, and a push after the second failure does not put it back in the queue", async () => {
      const w = await world();
      const { out } = await opened(w);
      const second = (await restartPlanWriteback(w.deps, { accountId: w.accountId, repoId: w.repoId, writebackId: out.writebackId, cause: "merge_conflict" })) as { writebackId: string };
      const third = await restartPlanWriteback(w.deps, { accountId: w.accountId, repoId: w.repoId, writebackId: second.writebackId, cause: "branch_behind" });
      expect(third).toMatchObject({ kind: "stopped" });
      expect(await tenant(w, (c) => holdWritebackForPush(c, { accountId: w.accountId, planWritebackId: second.writebackId }))).toBeNull();

      w.pulls.push(pull(41, "D#9:T4", "merged"));
      const n = writes(w).length;
      expect(await run(w)).toEqual({ kind: "deferred", reason: "entry_stopped" });
      expect(writes(w)).toHaveLength(n);
      expect((await entries(w))[1]).toMatchObject({ state: "stopped", reason: "branch_behind" });
    });
  });

  describe("an open write-back the default branch no longer needs", () => {
    it("is closed with its branch, and its entry ends, when main already says what truth says", async () => {
      const w = await world();
      const { out, row } = await opened(w);
      w.gh.pushDefault(PLAN_PATH, w.gh.file(PLAN_PATH, row.branch)!); // a person lands the same change by hand
      expect(await run(w)).toEqual({ kind: "up_to_date" });
      expect(w.gh.prs.find((p) => p.number === out.prNumber)?.state).toBe("closed");
      expect(w.gh.branches()).toEqual(["main"]);
      expect((await wbRow(w))[0]).toMatchObject({ state: "superseded", reason: "writeback_not_needed" });
      expect((await entries(w))[0]).toMatchObject({ state: "cancelled", reason: "writeback_not_needed" });
      // and nothing is live: a later merge opens a fresh one
      w.pulls.push(pull(41, "D#9:T4", "merged"));
      expect((await run(w)).kind).toBe("opened");
    });

    it("is left alone while its entry holds the slot", async () => {
      const w = await world();
      const { out, row } = await opened(w);
      const [e] = await entries(w);
      await tenant(w, (c) => takeSlot(c, { accountId: w.accountId, repoId: w.repoId, holder: "t1", facts: new Map([[e!.id, { open: true, draft: false, headSha: row.head_sha }]]), now: new Date(w.clock.t.getTime() + 1000) }));
      w.gh.pushDefault(PLAN_PATH, w.gh.file(PLAN_PATH, row.branch)!);
      const n = writes(w).length;
      expect(await run(w)).toEqual({ kind: "up_to_date" });
      expect(writes(w)).toHaveLength(n);
      expect(w.gh.prs.find((p) => p.number === out.prNumber)?.state).toBe("open");
      expect((await entries(w))[0]).toMatchObject({ state: "in_flight" });
    });
  });

  describe("recovering a row left `opening` verifies the branch it adopts", () => {
    const orphan = async (w: World) => {
      const id = randomUUID();
      const branch = `${PLAN_UPDATE_BRANCH_PREFIX}${id.slice(0, 8)}`;
      await db.admin.query(`INSERT INTO plan_writebacks (id, account_id, repo_id, state, plan_path, branch) VALUES ($1,$2,$3,'opening',$4,$5)`, [id, w.accountId, w.repoId, PLAN_PATH, branch]);
      return { id, branch };
    };

    it("records base_sha as the default-branch commit the branch is built on, not the branch head", async () => {
      const w = await world();
      w.pulls = [pull(40, "D#9:T1", "merged")];
      const { id, branch } = await orphan(w);
      const base = w.gh.tip();
      await api(w).createBranch(branch, base);
      const built = buildWritebackText(planFile(), w.pulls);
      if (!built.ok) throw new Error("fixture");
      const blob = (await api(w).readFile(PLAN_PATH, base, 5_000_000))!.blobSha;
      const put = await api(w).putFile({ path: PLAN_PATH, branch, text: built.text, blobSha: blob, message: WRITEBACK_COMMIT_MESSAGE });
      w.gh.pushDefault("README.md", "other\n"); // main moved on; the plan file did not change
      expect(await run(w)).toMatchObject({ kind: "unchanged" });
      expect((await wbRow(w))[0]).toMatchObject({ id, state: "open", head_sha: put.commitSha, base_sha: base });
      expect(base).not.toBe(put.commitSha);
    });

    it("drops a branch that carries another file or another message, opens a fresh write-back, and leaves the branch alone", async () => {
      for (const kind of ["file", "message"] as const) {
        const w = await world();
        w.pulls = [pull(40, "D#9:T1", "merged")];
        const { id, branch } = await orphan(w);
        await api(w).createBranch(branch, w.gh.tip());
        if (kind === "file") {
          w.gh.pushAs(branch, "notes.md", "x\n", WRITEBACK_COMMIT_MESSAGE);
        } else {
          const blob = (await api(w).readFile(PLAN_PATH, w.gh.tip(), 5_000_000))!.blobSha;
          await api(w).putFile({ path: PLAN_PATH, branch, text: "{}\n", blobSha: blob, message: "hand edit" });
        }
        const before = w.gh.tip(branch);
        expect((await run(w)).kind).toBe("opened");
        const rows = await wbRow(w);
        expect(rows.find((r) => r.id === id)).toMatchObject({ state: "abandoned" });
        expect(rows.filter((r) => r.state === "open")).toHaveLength(1);
        expect(w.gh.branches()).toContain(branch);
        expect(w.gh.tip(branch)).toBe(before);
        expect(w.gh.prs).toHaveLength(1);
        expect(w.gh.prs[0]!.head).not.toBe(branch);
      }
    });
  });

  describe("hardening: adoption needs the platform's identity, and deletes re-read the tip", () => {
    const orphanRow = async (w: World) => {
      const id = randomUUID();
      const branch = `${PLAN_UPDATE_BRANCH_PREFIX}${id.slice(0, 8)}`;
      await db.admin.query(`INSERT INTO plan_writebacks (id, account_id, repo_id, state, plan_path, branch) VALUES ($1,$2,$3,'opening',$4,$5)`, [id, w.accountId, w.repoId, PLAN_PATH, branch]);
      return { id, branch };
    };

    it("a zero-commit orphan branch is abandoned with a fixed reason and deleted; a fresh write-back then opens", async () => {
      const w = await world();
      w.pulls = [pull(40, "D#9:T1", "merged")];
      const { id, branch } = await orphanRow(w);
      await api(w).createBranch(branch, w.gh.tip()); // the crash came after createBranch and before putFile
      const out = await run(w);
      expect(out.kind).toBe("opened");
      const rows = await wbRow(w);
      expect(rows.find((r) => r.id === id)).toMatchObject({ state: "abandoned", reason: "writeback_empty_branch" });
      expect(rows.filter((r) => r.state === "open")).toHaveLength(1);
      expect(w.gh.branches()).not.toContain(branch);
      expect(w.gh.prs).toHaveLength(1);
      expect(w.gh.prs[0]!.head).not.toBe(branch);
    });

    it("a zero-commit orphan whose branch moved after the compare is abandoned and the branch is left alone", async () => {
      const w = await world();
      w.pulls = [pull(40, "D#9:T1", "merged")];
      const { id, branch } = await orphanRow(w);
      await api(w).createBranch(branch, w.gh.tip());
      let pushed = "";
      w.gh.onRequest = (req) => {
        // between the compare and the re-read of the tip, a person pushes to the branch
        if (req.method === "GET" && req.path.includes("/compare/")) {
          w.gh.onRequest = (r2) => {
            if (r2.method === "GET" && r2.path.includes("/git/ref/heads/")) {
              w.gh.onRequest = null;
              pushed = w.gh.pushAs(branch, "notes.md", "late\n");
            }
          };
        }
      };
      expect((await run(w)).kind).toBe("opened");
      expect((await wbRow(w)).find((r) => r.id === id)).toMatchObject({ state: "abandoned", reason: "writeback_empty_branch" });
      expect(w.gh.tip(branch)).toBe(pushed);
      expect(w.gh.calls.some((c) => c === `DELETE /repos/${OWNER}/${NAME}/git/refs/heads/${branch}`)).toBe(false);
    });

    it("recoverOpening refuses a person's commit that has the fixed message and changes only the plan file", async () => {
      const w = await world();
      w.pulls = [pull(40, "D#9:T1", "merged")];
      const { id, branch } = await orphanRow(w);
      await api(w).createBranch(branch, w.gh.tip());
      const built = buildWritebackText(planFile(), w.pulls);
      if (!built.ok) throw new Error("fixture");
      w.gh.pushAs(branch, PLAN_PATH, built.text, WRITEBACK_COMMIT_MESSAGE, PERSON_EMAIL);
      const before = w.gh.tip(branch);
      expect((await run(w)).kind).toBe("opened");
      expect((await wbRow(w)).find((r) => r.id === id)).toMatchObject({ state: "abandoned" });
      expect(w.gh.tip(branch)).toBe(before);
      expect(w.gh.prs[0]!.head).not.toBe(branch);
    });

    it("recoverOpening needs the author AND the committer to be the platform (one of them is not enough)", async () => {
      const w = await world();
      w.pulls = [pull(40, "D#9:T1", "merged")];
      const { id, branch } = await orphanRow(w);
      await api(w).createBranch(branch, w.gh.tip());
      const built = buildWritebackText(planFile(), w.pulls);
      if (!built.ok) throw new Error("fixture");
      const blob = (await api(w).readFile(PLAN_PATH, w.gh.tip(), 5_000_000))!.blobSha;
      await api(w).putFile({ path: PLAN_PATH, branch, text: built.text, blobSha: blob, message: WRITEBACK_COMMIT_MESSAGE });
      const original = w.gh.http.request;
      // the compare answers the platform as author but a person as committer
      (w.gh.http as { request: typeof original }).request = async (req) => {
        const res = await original(req);
        if (req.path.includes("/compare/")) {
          const b = res.body as { commits: Array<{ commit: { committer: { email: string } } }> };
          for (const c of b.commits) c.commit.committer.email = PERSON_EMAIL;
        }
        return res;
      };
      expect((await run(w)).kind).toBe("opened");
      expect((await wbRow(w)).find((r) => r.id === id)).toMatchObject({ state: "abandoned" });
    });

    it("adoptOwnPush refuses a person's commit with the fixed message that changes only the plan file", async () => {
      const w = await world();
      const { row } = await opened(w);
      w.pulls.push(pull(41, "D#9:T4", "merged"));
      const current = (await api(w).readFile(PLAN_PATH, row.head_sha, 5_000_000))!;
      const built = buildWritebackText(planFile(), w.pulls);
      if (!built.ok) throw new Error("fixture");
      expect(built.text).not.toBe(current.text);
      w.gh.pushAs(row.branch, PLAN_PATH, built.text, WRITEBACK_COMMIT_MESSAGE, PERSON_EMAIL);
      expect(await run(w)).toMatchObject({ kind: "stopped_changed_by_other" });
      expect((await wbRow(w))[0]).toMatchObject({ state: "changed_by_other", head_sha: row.head_sha });
    });

    it("openFresh's failure path re-reads the tip: a branch someone pushed to after the platform's commit is not deleted", async () => {
      const w = await world();
      w.pulls = [pull(40, "D#9:T1", "merged")];
      let pushed = "";
      w.gh.onRequest = (req) => {
        if (req.method === "POST" && req.path.endsWith("/pulls")) {
          const branch = w.gh.branches().find((b) => b.startsWith(PLAN_UPDATE_BRANCH_PREFIX))!;
          pushed = w.gh.pushAs(branch, "notes.md", "late\n");
          throw new WritebackGitHubError("unavailable");
        }
      };
      await expect(run(w)).rejects.toBeDefined();
      const branch = w.gh.branches().find((b) => b.startsWith(PLAN_UPDATE_BRANCH_PREFIX))!;
      expect(w.gh.tip(branch)).toBe(pushed);
      expect(w.gh.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
      expect((await wbRow(w))[0]).toMatchObject({ state: "abandoned" });
    });
  });

  describe("the schema ties a queue entry to its write-back's own repo and tenant", () => {
    it("refuses an entry whose repo is not the write-back's repo (composite foreign key)", async () => {
      const w = await world();
      const { row } = await opened(w);
      const otherRepo = randomUUID();
      await seedRepo(db.admin, w.accountId, otherRepo);
      await expect(
        db.admin.query(
          `INSERT INTO merge_queue_entries (account_id, repo_id, entry_kind, plan_writeback_id, pr_number, head_sha, approved_at) VALUES ($1,$2,'plan_writeback',$3,$4,$5,now())`,
          [w.accountId, otherRepo, randomUUID(), 900, "a".repeat(40)],
        ),
      ).rejects.toMatchObject({ code: "23503" });
      await db.admin.query(`DELETE FROM merge_queue_entries WHERE plan_writeback_id = $1`, [row.id]);
      await expect(
        db.admin.query(
          `INSERT INTO merge_queue_entries (account_id, repo_id, entry_kind, plan_writeback_id, pr_number, head_sha, approved_at) VALUES ($1,$2,'plan_writeback',$3,$4,$5,now())`,
          [w.accountId, otherRepo, row.id, row.pr_number, row.head_sha],
        ),
      ).rejects.toMatchObject({ code: "23503" });
      // the same insert on the write-back's own repo is accepted
      await db.admin.query(
        `INSERT INTO merge_queue_entries (account_id, repo_id, entry_kind, plan_writeback_id, pr_number, head_sha, approved_at) VALUES ($1,$2,'plan_writeback',$3,$4,$5,now())`,
        [w.accountId, w.repoId, row.id, row.pr_number, row.head_sha],
      );
    });

    it("refuses a branch outside the platform's namespace, the default branch included", async () => {
      const w = await world();
      for (const branch of ["main", "feature/x", "fulcrumaxe/plan-update-", "fulcrumaxe/plan-update-a..b", "fulcrumaxe/plan-update-x.lock"]) {
        await expect(
          db.admin.query(`INSERT INTO plan_writebacks (account_id, repo_id, state, plan_path, branch) VALUES ($1,$2,'opening',$3,$4)`, [w.accountId, w.repoId, PLAN_PATH, branch]),
        ).rejects.toMatchObject({ code: "23514" });
      }
    });

    it("plan_writebacks is invisible and unwritable across tenants", async () => {
      const a = await world();
      const b = await world();
      const { row } = await opened(a);
      expect((await tenant(a, (c) => c.query(`SELECT id FROM plan_writebacks`))).rows.map((r) => r.id)).toEqual([row.id]);
      expect((await tenant(b, (c) => c.query(`SELECT id FROM plan_writebacks`))).rows).toEqual([]);
      expect((await tenant(b, (c) => c.query(`SELECT id FROM plan_writebacks WHERE id = $1`, [row.id]))).rows).toEqual([]);
      expect((await tenant(b, (c) => c.query(`UPDATE plan_writebacks SET reason = 'x' WHERE id = $1`, [row.id]))).rowCount).toBe(0);
      await expect(
        tenant(b, (c) => c.query(`INSERT INTO plan_writebacks (account_id, repo_id, state, plan_path, branch) VALUES ($1,$2,'opening',$3,$4)`, [a.accountId, a.repoId, PLAN_PATH, `${PLAN_UPDATE_BRANCH_PREFIX}xxxx`])),
      ).rejects.toMatchObject({ code: "42501" });
      // tenant B naming A's repo under its own account id fails on the repo's composite key
      await expect(
        tenant(b, (c) => c.query(`INSERT INTO plan_writebacks (account_id, repo_id, state, plan_path, branch) VALUES ($1,$2,'opening',$3,$4)`, [b.accountId, a.repoId, PLAN_PATH, `${PLAN_UPDATE_BRANCH_PREFIX}yyyy`])),
      ).rejects.toMatchObject({ code: "23503" });
      expect((await wbRow(a))[0]).toMatchObject({ state: "open", reason: null });
    });
  });
});
