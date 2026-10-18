import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { sweepSandboxReap, type SweepSandboxReapInput } from "../src/sandboxReap.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import { seedAccount, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { createSandboxTargetHarness, type SandboxTargetTestHarness } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";

/**
 * D#598 P1f-5r: the 1-day net over real Postgres reaps a publish sandbox ("pp-<attempt id>") whose attempt has ended, and leaves a live one
 * alone. The name cannot be derived from the run row, so the pass checks it against the attempt row (sandbox_reap_publish_status). [pg]
 */
describe("D#598 P1f-5r: publish sandboxes in the safety net [pg]", () => {
  const db = pgHarness();
  let h: SandboxTargetTestHarness;
  let target: SandboxTarget;
  const lines: string[] = [];

  // Every [pg] file shares one database: facts other files left must not reach this file's passes.
  beforeEach(async () => {
    await db.admin.query(`
      INSERT INTO sandbox_reaps (sandbox_name, account_id, run_id, reason, state, claimed_at, done_at)
      SELECT s.sandbox_name, s.account_id, s.run_id, 'ephemeral', 'deleted', now(), now() + interval '1 day'
        FROM sandbox_reap_ephemeral_state(NULL, NULL) s
      ON CONFLICT (sandbox_name) DO UPDATE SET state = 'deleted', done_at = EXCLUDED.done_at`);
    h = createSandboxTargetHarness(db.runWriterPool);
    target = new SandboxTarget(h.deps);
    lines.length = 0;
  });

  const sweep = (over: Partial<SweepSandboxReapInput> = {}) =>
    sweepSandboxReap(
      { pool: db.runWriterPool, port: h.deps.sandboxPort, stopStray: (run) => target.stopStraySandbox(run), log: (l: string) => void lines.push(l) },
      { pass: "ephemeral", mode: "on", now: Date.now(), cursor: null, maxCalls: 60, timeBudgetMs: 600_000, ...over },
    );

  async function publish(o: { runStatus: string; attemptFinished: boolean }): Promise<{ accountId: string; name: string }> {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId);
    const attemptId = randomUUID();
    const runId = randomUUID();
    const name = `pp-${attemptId}`;
    await db.admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, sandbox_name, created_at)
       VALUES ($1, $2, $3, 'plane_publish', 'production', $4, $5, now() - interval '30 hours')`,
      [runId, accountId, workItemId, o.runStatus, name],
    );
    await db.admin.query(`ALTER TABLE agent_runs DISABLE TRIGGER USER`);
    try {
      await db.admin.query(`UPDATE agent_runs SET ended_at = now() - interval '25 hours' WHERE id = $1`, [runId]);
    } finally {
      await db.admin.query(`ALTER TABLE agent_runs ENABLE TRIGGER USER`);
    }
    await db.admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'compute', 'sandbox', 0.1, $2, 'foreground_compute')`, [accountId, runId]);
    const { rows } = await db.admin.query<{ id: string }>(
      `INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [accountId, workItemId, repoId, `acme-${randomUUID().slice(0, 8)}/pub`, "a".repeat(64)],
    );
    await db.admin.query(
      `INSERT INTO plane_push_attempts (id, account_id, plane_push_id, run_id, runtime, kind, attempt_no, finished_at)
       VALUES ($1, $2, $3, $4, 'sandbox', 'push', 1, CASE WHEN $5::boolean THEN now() ELSE NULL END)`,
      [attemptId, accountId, rows[0]!.id, runId, o.attemptFinished],
    );
    h.fakeSandbox.seedProviderSandbox(name, { status: "stopped", persistent: false });
    return { accountId, name };
  }
  const deletedNames = () => h.fakeSandbox.state.deleted.map((d) => d.sandboxName);
  const reapRow = async (name: string) => (await db.admin.query(`SELECT state, reason FROM sandbox_reaps WHERE sandbox_name = $1`, [name])).rows[0] as { state: string; reason: string } | undefined;

  it("the fake provider lists pp- names", async () => {
    const p = await publish({ runStatus: "succeeded", attemptFinished: true });
    const page = await h.deps.sandboxPort.listSandboxes!({ prefix: "pp-" });
    expect(page.sandboxes.map((s) => s.name)).toContain(p.name);
  });

  it("a publish sandbox whose attempt finished is deleted, with its claim and no name-mismatch alert", async () => {
    const p = await publish({ runStatus: "succeeded", attemptFinished: true });
    const result = await sweep();
    expect(result).toMatchObject({ deleted: 1, skipped: 0, alerts: [] });
    expect(deletedNames()).toEqual([p.name]);
    expect(await reapRow(p.name)).toEqual({ state: "deleted", reason: "ephemeral" });
  });

  it("a crashed attempt (never finished, run ended) is deleted too", async () => {
    const p = await publish({ runStatus: "failed", attemptFinished: false });
    expect(await sweep()).toMatchObject({ deleted: 1, alerts: [] });
    expect(deletedNames()).toEqual([p.name]);
  });

  it("a publish sandbox whose attempt is live is not listed, read or deleted", async () => {
    const p = await publish({ runStatus: "running", attemptFinished: false });
    expect(await sweep()).toMatchObject({ deleted: 0, candidates: [], alerts: [] });
    expect(h.fakeSandbox.state.calls.filter((c) => c.includes(p.name) && /^(delete|stop):/.test(c))).toEqual([]);
    expect(await reapRow(p.name)).toBeUndefined();
  });
  it("a name whose run row is in account A and whose attempt row is in account B is listed, answers refused, and is left alone", async () => {
    const a = await publish({ runStatus: "succeeded", attemptFinished: true });
    // Move the attempt to a second account: the run row stays in A, the attempt row (same id) is B's.
    const b = randomUUID();
    const bRepo = randomUUID();
    const bItem = randomUUID();
    await seedAccount(db.admin, b);
    await seedRepo(db.admin, b, bRepo);
    await seedWorkItem(db.admin, b, bItem, bRepo);
    const attemptId = a.name.slice(3);
    await db.admin.query(`DELETE FROM plane_push_attempts WHERE id = $1`, [attemptId]);
    const push = await db.admin.query<{ id: string }>(
      `INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [b, bItem, bRepo, `acme-${randomUUID().slice(0, 8)}/pub`, "a".repeat(64)],
    );
    await db.admin.query(`INSERT INTO plane_push_attempts (id, account_id, plane_push_id, runtime, kind, attempt_no, finished_at) VALUES ($1, $2, $3, 'sandbox', 'push', 1, now())`, [attemptId, b, push.rows[0]!.id]);
    expect((await db.admin.query(`SELECT sandbox_name FROM sandbox_reap_candidates_ephemeral(50, NULL) WHERE sandbox_name = $1`, [a.name])).rows).toHaveLength(1);
    expect((await db.admin.query(`SELECT sandbox_reap_publish_status($1, $2) AS v`, [a.accountId, a.name])).rows[0].v).toBe("refused");
    const result = await sweep();
    expect(result).toMatchObject({ deleted: 0, skipped: 1 });
    expect(h.fakeSandbox.state.calls.filter((c) => c.includes(a.name) && /^(delete|stop):/.test(c))).toEqual([]);
    expect(deletedNames()).toEqual([]);
    expect(await reapRow(a.name)).toBeUndefined();
  });

  it("a publish sandbox the provider still shows running is neither stopped nor deleted, no rn- name is ever used, and no stop is stamped", async () => {
    const p = await publish({ runStatus: "succeeded", attemptFinished: true });
    h.fakeSandbox.seedProviderSandbox(p.name, { status: "running", persistent: false });
    const result = await sweep();
    expect(result).toMatchObject({ deleted: 0, stopped: 0, skipped: 1 });
    expect(h.fakeSandbox.state.calls.filter((c) => /^(delete|stop):/.test(c))).toEqual([]);
    expect(h.fakeSandbox.state.calls.filter((c) => /^(?!list:)[a-z]+:rn-/.test(c))).toEqual([]);
    expect(h.fakeSandbox.state.stopped).toEqual([]);
    const { rows } = await db.admin.query(`SELECT sandbox_stopped_at FROM agent_runs WHERE sandbox_name = $1`, [p.name]);
    expect(rows).toEqual([{ sandbox_stopped_at: null }]);
    expect(await reapRow(p.name)).toBeUndefined();
  });

  describe("pure orphans: no run row, no attempt row", () => {
    const orphan = (ageMs: number): string => {
      const name = `pp-${randomUUID()}`;
      h.fakeSandbox.seedProviderSandbox(name, { status: "stopped", persistent: false, createdAt: Date.now() - ageMs });
      return name;
    };
    const HOUR = 3_600_000;

    it("an orphan older than the grace is deleted, counted, and logged by name only", async () => {
      const name = orphan(2 * HOUR);
      const result = await sweep();
      expect(result).toMatchObject({ deleted: 1, orphans: 1 });
      expect(result.alerts).toContain("sandbox_orphan_found");
      expect(deletedNames()).toEqual([name]);
      expect(lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === "sandbox_reap.publish_orphan_deleted")).toEqual([{ event: "sandbox_reap.publish_orphan_deleted", name }]);
      expect(await reapRow(name)).toBeUndefined();
    });

    it("a young orphan is counted but not deleted", async () => {
      orphan(10 * 60_000);
      expect(await sweep()).toMatchObject({ deleted: 0, orphans: 1 });
      expect(deletedNames()).toEqual([]);
    });

    it("report-only mode deletes nothing but still counts it", async () => {
      orphan(2 * HOUR);
      expect(await sweep({ mode: "dry_run" })).toMatchObject({ deleted: 0, orphans: 1 });
      expect(deletedNames()).toEqual([]);
    });

    it("a name some attempt or run owns answers refused or live and is never deleted as an orphan", async () => {
      const p = await publish({ runStatus: "running", attemptFinished: false });
      const result = await sweep();
      expect(result).toMatchObject({ deleted: 0, orphans: 0 });
      expect(deletedNames()).not.toContain(p.name);
      const { rows } = await db.admin.query(`SELECT sandbox_reap_publish_status($1, $2) AS v`, [randomUUID(), p.name]);
      expect(rows[0].v).toBe("refused");
    });
  });
});
