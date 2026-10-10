import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { approveRun } from "../src/index.js";
import { harness, respond, type Harness } from "./helpers.js";

describe("approving a run [pg] (criterion 2)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const fresh = (): Promise<F2Fixture> => seedF2(h.admin);
  const approve = (f: F2Fixture, userId: string, runId: string) => respond(() => approveRun(h.deps(), { accountId: f.accountId, userId }, runId));
  const runner = (f: F2Fixture, by: string, mode = "subscription") => insertRunner(h.admin, f.accountId, by, { credentialMode: mode });
  async function run(f: F2Fixture, over: { status?: string; runtime?: string; mode?: string | null; initiatedBy?: string | null; approvedBy?: string | null } = {}): Promise<string> {
    const id = randomUUID();
    await h.admin.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, initiated_by, approved_by) VALUES ($1, $2, 'executor', $3, $4, $5, $6, $7)`,
      [id, f.accountId, over.runtime ?? "runner", over.status ?? "pending", over.mode === undefined ? "runner_local" : over.mode, over.initiatedBy ?? f.m1, over.approvedBy ?? null],
    );
    return id;
  }
  const approvedBy = async (id: string) => (await h.admin.query("SELECT approved_by FROM agent_runs WHERE id = $1", [id])).rows[0].approved_by;
  const audits = async (f: F2Fixture) => (await h.admin.query("SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'runner.run_approved'", [f.accountId])).rows;

  it("lets the registrant of a live subscription runner approve a teammate's pending run, once, with one audit row", async () => {
    const f = await fresh();
    await runner(f, f.a1);
    const id = await run(f);
    const res = await approve(f, f.a1, id);
    expect(res).toMatchObject({ status: 200, body: { approved: true, changed: true } });
    expect(await approvedBy(id)).toBe(f.a1);
    expect(await audits(f)).toEqual([{ actor: f.a1, payload: { run_id: id } }]);
    // the same person again: still 200, nothing changes, no second audit row
    expect(await approve(f, f.a1, id)).toMatchObject({ status: 200, body: { approved: true, changed: false } });
    expect(await audits(f)).toHaveLength(1);
  });

  it("works for a member who registered the runner (role does not matter, the runner does)", async () => {
    const f = await fresh();
    await runner(f, f.m2);
    const id = await run(f);
    expect((await approve(f, f.m2, id)).status).toBe(200);
  });

  it("refuses everyone else with 403 and changes nothing: another member, an owner without a runner, an api_key registrant, a revoked runner's registrant", async () => {
    const f = await fresh();
    await runner(f, f.a1);
    await runner(f, f.a2, "api_key");
    const revoked = await runner(f, f.o2);
    await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [revoked]);
    const id = await run(f);
    for (const user of [f.m1, f.o1, f.a2, f.o2]) {
      expect((await approve(f, user, id)).status, user).toBe(403);
    }
    expect(await approvedBy(id)).toBeNull();
    expect(await audits(f)).toEqual([]);
  });

  // D#6 R5b-2b-ii (migration 0774): a run of a cloud-verified repository is approved by the same people under the same rules.
  describe("a cloud-verified run (execution_mode runner_verified)", () => {
    it("is approved by an eligible approver (the registrant of a live subscription runner), once, with one audit row; the approval lands on the other member's run", async () => {
      const f = await fresh();
      await runner(f, f.a1);
      const id = await run(f, { mode: "runner_verified", initiatedBy: f.m1 });
      expect(await approve(f, f.a1, id)).toMatchObject({ status: 200, body: { approved: true, changed: true } });
      expect(await approvedBy(id)).toBe(f.a1);
      expect(await audits(f)).toEqual([{ actor: f.a1, payload: { run_id: id } }]);
      expect(await approve(f, f.a1, id)).toMatchObject({ status: 200, body: { approved: true, changed: false } });
      expect(await audits(f)).toHaveLength(1);
    });

    it("is still 403 for everyone who is not an eligible approver (a member, an owner without a runner, an api_key registrant, a revoked runner's registrant)", async () => {
      const f = await fresh();
      await runner(f, f.a1);
      await runner(f, f.a2, "api_key");
      const revoked = await runner(f, f.o2);
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [revoked]);
      const id = await run(f, { mode: "runner_verified" });
      for (const user of [f.m1, f.o1, f.a2, f.o2]) expect((await approve(f, user, id)).status, user).toBe(403);
      expect(await approvedBy(id)).toBeNull();
      expect(await audits(f)).toEqual([]);
    });

    it("is still 409 in the wrong state (not pending, a second approver, a production-runtime row), and nothing changes", async () => {
      const f = await fresh();
      await runner(f, f.a1);
      await runner(f, f.a2);
      for (const over of [{ status: "running" }, { status: "succeeded" }, { status: "cancelled" }, { runtime: "production", mode: "sandbox" }]) {
        const id = await run(f, { ...over, ...(over.mode ? {} : { mode: "runner_verified" }) });
        expect((await approve(f, f.a1, id)).status, JSON.stringify(over)).toBe(409);
        expect(await approvedBy(id)).toBeNull();
      }
      const id = await run(f, { mode: "runner_verified" });
      expect((await approve(f, f.a1, id)).status).toBe(200);
      expect((await approve(f, f.a2, id)).status).toBe(409);
      expect(await approvedBy(id)).toBe(f.a1);
    });
  });

  it("refuses a user outside the account, and does not see another account's run", async () => {
    const f = await fresh();
    const g = await fresh();
    await runner(f, f.a1);
    await runner(g, g.a1);
    const theirs = await run(g);
    expect((await approve(f, g.a1, theirs)).status).toBe(403);
    expect((await approve(f, f.a1, theirs)).status).toBe(404);
    expect(await approvedBy(theirs)).toBeNull();
  });

  it("a run that stops being pending while the approval waits for its row lock is refused 409: no approval, no audit row", async () => {
    const f = await fresh();
    await runner(f, f.a1);
    const id = await run(f);
    await h.admin.query("BEGIN");
    try {
      await h.admin.query("SELECT 1 FROM agent_runs WHERE id = $1 FOR UPDATE", [id]);
      const waiting = approve(f, f.a1, id);
      // Bounded poll until the approval is blocked on the lock held above.
      for (let i = 0; i < 400; i++) {
        const blocked = await h.admin.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%agent_run_approve%'");
        if (blocked.rowCount) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await h.admin.query("UPDATE agent_runs SET status = 'running' WHERE id = $1", [id]);
      await h.admin.query("COMMIT");
      expect((await waiting).status).toBe(409);
    } catch (error) {
      await h.admin.query("ROLLBACK");
      throw error;
    }
    expect(await approvedBy(id)).toBeNull();
    expect(await audits(f)).toEqual([]);
  });

  it("is 404 for no such run or a malformed id, and 409 for a run that is not a pending runner run", async () => {
    const f = await fresh();
    await runner(f, f.a1);
    expect((await approve(f, f.a1, randomUUID())).status).toBe(404);
    expect((await approve(f, f.a1, "nope")).status).toBe(404);
    for (const over of [{ status: "running" }, { status: "succeeded" }, { runtime: "production", mode: "sandbox" }, { mode: "sandbox" }, { mode: null }]) {
      const id = await run(f, over);
      expect((await approve(f, f.a1, id)).status, JSON.stringify(over)).toBe(409);
      expect(await approvedBy(id)).toBeNull();
    }
  });

  it("never replaces an earlier approval: a second registrant gets 409 and the first stays", async () => {
    const f = await fresh();
    await runner(f, f.a1);
    await runner(f, f.a2);
    const id = await run(f);
    expect((await approve(f, f.a1, id)).status).toBe(200);
    expect((await approve(f, f.a2, id)).status).toBe(409);
    expect(await approvedBy(id)).toBe(f.a1);
  });

  it("is write-once in the table itself, and a platform_ops login cannot write it", async () => {
    const f = await fresh();
    await runner(f, f.a1);
    const id = await run(f);
    await approve(f, f.a1, id);
    await expect(h.admin.query("UPDATE agent_runs SET approved_by = $2 WHERE id = $1", [id, f.a2])).rejects.toMatchObject({ code: "23514" });
    const open = await run(f);
    const ops = await h.opsPool.connect();
    try {
      await ops.query("BEGIN");
      await ops.query("SELECT set_config('app.account_id', $1, true)", [f.accountId]);
      await expect(ops.query("UPDATE agent_runs SET approved_by = $2 WHERE id = $1", [open, f.a1])).rejects.toMatchObject({ code: "42501" });
      await ops.query("ROLLBACK");
      await ops.query("BEGIN");
      await ops.query("SELECT set_config('app.account_id', $1, true)", [f.accountId]);
      await expect(ops.query("SELECT agent_run_approve($1)", [open])).rejects.toMatchObject({ code: "42501" });
    } finally {
      await ops.query("ROLLBACK");
      ops.release();
    }
    expect(await approvedBy(open)).toBeNull();
  });
});
