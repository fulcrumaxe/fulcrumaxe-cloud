import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertAgentRun, writeRunStatus, type ExecutionTargetRegistry } from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { createRunActionFacade, MAX_PROGRESS_PAGES, RunActionForbiddenError, RunActionInputError, RunActionRefusedError, RunActionUnavailableError, type RunActionFacade } from "../src/runActions.js";

/** [pg] The facade against the real 0658 definers, on a real run-writer login and on platform_ops. */
const HASH = "h".repeat(64);
const NO_REGISTRY = {} as ExecutionTargetRegistry;

describe("run-action facade [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let opsPool: Pool;
  let facade: RunActionFacade;
  let acct: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    opsPool = createPool(process.env.WORKER_DATABASE_URL_PLATFORM_OPS!);
    facade = createRunActionFacade(writerPool, NO_REGISTRY);
    acct = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, opsPool]) await p.end();
  });

  /** A committed accepted request, written through the superuser (exempt from the write guard). */
  async function seedRow(over: Record<string, unknown> = {}): Promise<string> {
    const row = {
      kind: "cancel_run",
      target_id: randomUUID(),
      requested_by: `session:${acct.userId}`,
      principal_kind: "session",
      request_hash: HASH,
      ...over,
    };
    const cols = Object.keys(row);
    const { rows } = await admin.query(
      `INSERT INTO run_action_requests (account_id, ${cols.join(", ")}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")}) RETURNING id`,
      [acct.accountId, ...Object.values(row)],
    );
    return rows[0].id;
  }
  const rowOf = async (id: string) => (await admin.query("SELECT * FROM run_action_requests WHERE id = $1", [id])).rows[0];

  it("claim: nothing claimable is null; a claimable row comes back as plain data and is then leased", async () => {
    expect(await facade.claimRunAction(randomUUID(), 60)).toBeNull();
    const id = await seedRow();
    const claimed = await facade.claimRunAction(id, 60);
    expect(claimed).toMatchObject({ id, accountId: acct.accountId, kind: "cancel_run", principalKind: "session", attempts: 1 });
    expect(typeof claimed!.claimedUntil).toBe("string");
    expect((await rowOf(id)).state).toBe("claimed");
    expect(await facade.claimRunAction(id, 60)).toBeNull();
  });

  it("settle: the JSON outcome is stored as JSON; a retry goes back to accepted with a delay", async () => {
    const id = await seedRow();
    await facade.claimRunAction(id, 60);
    await facade.settleRunAction(id, { state: "done", outcome: { status: "cancelled", settled_usd: 1.5 } });
    const done = await rowOf(id);
    expect(done.state).toBe("done");
    expect(done.outcome).toEqual({ status: "cancelled", settled_usd: 1.5 });
    expect(done.finished_at).not.toBeNull();

    const retry = await seedRow();
    await facade.claimRunAction(retry, 60);
    await facade.settleRunAction(retry, { state: "accepted", retryAfterSeconds: 600 });
    const row = await rowOf(retry);
    expect(row.state).toBe("accepted");
    expect(row.not_before.getTime()).toBeGreaterThan(Date.now());
    await facade.settleRunAction(id, { state: "done", outcome: { status: "cancelled", settled_usd: 1.5 } }); // settling again is a no-op
  });

  it("settle: a definer refusal reaches the caller with its code (no such action: P0002)", async () => {
    await expect(facade.settleRunAction(randomUUID(), { state: "done" })).rejects.toMatchObject({ code: "P0002" });
  });

  it("list-due: lists the due ids, writes nothing, and the workflow's claim then takes the lease", async () => {
    const id = await seedRow();
    const before = await rowOf(id);
    const ids = await facade.listDueRunActions(0, 1000);
    expect(ids).toContain(id);
    expect(await rowOf(id)).toEqual(before); // state, attempts and lease untouched
    expect(await facade.listDueRunActions(0, 1000)).toContain(id); // listing twice still lists it
    // The probe that failed when the sweep leased: the workflow's claim on a listed id succeeds.
    expect(await facade.claimRunAction(id, 60)).toMatchObject({ id, attempts: 1 });
    expect(await facade.listDueRunActions(0, 1000)).not.toContain(id); // now it holds a live lease
  });

  it("list-due: an expired lease is listed and then claimable; fresh, leased and finished rows are not listed", async () => {
    const expired = await seedRow({ state: "claimed", claimed_until: new Date(Date.now() - 1000), attempts: 1 });
    const leased = await seedRow({ state: "claimed", claimed_until: new Date(Date.now() + 60_000) });
    const done = await seedRow({ state: "done", finished_at: new Date() });
    const refused = await seedRow({ state: "refused", finished_at: new Date() });
    const failed = await seedRow({ state: "failed", finished_at: new Date() });
    const old = await seedRow();
    await admin.query("UPDATE run_action_requests SET created_at = now() - interval '5 minutes' WHERE id = $1", [old]);
    const fresh = await seedRow();
    const ids = await facade.listDueRunActions(60, 1000);
    expect(ids).toEqual(expect.arrayContaining([expired, old]));
    for (const not of [leased, done, refused, failed, fresh]) expect(ids).not.toContain(not);
    expect(await facade.claimRunAction(expired, 60)).toMatchObject({ id: expired, attempts: 2 });
  });

  it("list-due: two claims on one listed id give exactly one winner", async () => {
    const id = await seedRow();
    expect(await facade.listDueRunActions(0, 1000)).toContain(id);
    const won = await Promise.all([facade.claimRunAction(id, 60), facade.claimRunAction(id, 60)]);
    expect(won.filter((r) => r !== null)).toHaveLength(1);
    expect((await rowOf(id)).attempts).toBe(1);
  });

  it("purge: deletes only finished requests older than the age (interval argument), and returns the count", async () => {
    const old = await seedRow();
    const fresh = await seedRow();
    for (const id of [old, fresh]) {
      await facade.claimRunAction(id, 60);
      await facade.settleRunAction(id, { state: "done" });
    }
    await admin.query("UPDATE run_action_requests SET finished_at = now() - interval '3 days' WHERE id = $1", [old]);
    const purged = await facade.purgeRunActions(24 * 3600, 1000);
    expect(purged).toBeGreaterThanOrEqual(1);
    expect(await rowOf(old)).toBeUndefined();
    expect(await rowOf(fresh)).toBeDefined();
  });

  it("a malformed id is a fixed error before any SQL, not Postgres's text with the input", async () => {
    const err = await facade.claimRunAction("x'; DROP TABLE t;--", 60).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunActionInputError);
    expect((err as Error).message).not.toContain("DROP");
  });

  describe("built on the platform_ops pool, every writer definer refuses (42501)", () => {
    it("claim, settle, list-due and purge", async () => {
      const ops = createRunActionFacade(opsPool, NO_REGISTRY);
      const id = await seedRow();
      await expect(ops.claimRunAction(id, 60)).rejects.toMatchObject({ code: "42501" });
      await expect(ops.settleRunAction(id, { state: "done" })).rejects.toMatchObject({ code: "42501" });
      await expect(ops.listDueRunActions(0, 10)).rejects.toMatchObject({ code: "42501" });
      await expect(ops.purgeRunActions(3600, 10)).rejects.toMatchObject({ code: "42501" });
      expect((await rowOf(id)).state).toBe("accepted");
    });

    it("cancelRun", async () => {
      const ops = createRunActionFacade(opsPool, NO_REGISTRY);
      await expect(ops.cancelRun({ accountId: acct.accountId, userId: acct.userId }, randomUUID())).rejects.toMatchObject({
        code: "42501",
      });
    });
  });

  describe("cancelRun on the run-writer pool: authority is a session member of the run's account", () => {
    const statusOf = async (id: string) => (await admin.query("SELECT status FROM agent_runs WHERE id = $1", [id])).rows[0]?.status;

    async function runningRun(a: SeedRefs): Promise<string> {
      const { id } = await insertAgentRun(writerPool, {
        id: randomUUID(),
        accountId: a.accountId,
        workItemId: a.workItemId,
        role: "code-reviewer",
        runtime: "production",
      });
      await writeRunStatus(writerPool, { accountId: a.accountId, runId: id, from: "pending", to: "running" });
      return id;
    }
    const NOT_FOUND = { name: "NotFoundError", message: expect.stringMatching(/^agent_runs .+ not found$/) };

    it("a member cancels a run in their own account", async () => {
      const runId = await runningRun(acct);
      const result = await facade.cancelRun({ accountId: acct.accountId, userId: acct.userId }, runId);
      expect(result.status).toBe("cancelled");
      expect(await statusOf(runId)).toBe("cancelled");
    });

    it("a non-member, or a removed member, gets NotFoundError and the run is unchanged", async () => {
      const runId = await runningRun(acct);
      const stranger = randomUUID();
      await admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [stranger, `${stranger}@fixture.test`]);
      await expect(facade.cancelRun({ accountId: acct.accountId, userId: stranger }, runId)).rejects.toMatchObject(NOT_FOUND);

      await admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')", [acct.accountId, stranger]);
      await admin.query("DELETE FROM account_members WHERE account_id = $1 AND user_id = $2", [acct.accountId, stranger]);
      await expect(facade.cancelRun({ accountId: acct.accountId, userId: stranger }, runId)).rejects.toMatchObject(NOT_FOUND);
      expect(await statusOf(runId)).toBe("running");
    });

    it("a member of account A using account B's run id gets NotFoundError and B's run is unchanged", async () => {
      const other = await seedAccount(admin, randomUUID());
      const runId = await runningRun(other);
      await expect(facade.cancelRun({ accountId: acct.accountId, userId: acct.userId }, runId)).rejects.toMatchObject(NOT_FOUND);
      expect(await statusOf(runId)).toBe("running");
    });

    it("a forged system (or any non-session) principal is refused with a fixed error before any SQL, and the run is unchanged", async () => {
      const runId = await runningRun(acct);
      for (const kind of ["system", "token", "admin"]) {
        const err = await facade.cancelRun({ accountId: acct.accountId, userId: randomUUID(), kind } as never, runId).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(RunActionForbiddenError);
        expect((err as Error).message).toBe("run action: principal kind not permitted");
      }
      expect(await statusOf(runId)).toBe("running");
    });

    it("a principal id that is not a uuid string (function, null, array, junk) is a fixed input error and the run is unchanged", async () => {
      const runId = await runningRun(acct);
      const bad: unknown[] = [() => undefined, null, undefined, ["x"], { a: 1 }, 5, "not-a-uuid"];
      for (const value of bad) {
        for (const principal of [
          { accountId: acct.accountId, userId: value },
          { accountId: value, userId: acct.userId },
        ]) {
          const err = await facade.cancelRun(principal as never, runId).catch((e: unknown) => e);
          expect(err).toBeInstanceOf(RunActionInputError);
          expect((err as Error).message).toBe("run action: invalid input");
        }
      }
      const other = await seedAccount(admin, randomUUID());
      const otherRun = await runningRun(other);
      await expect(facade.cancelRun({ accountId: other.accountId, userId: (() => undefined) as never }, otherRun)).rejects.toBeInstanceOf(
        RunActionInputError,
      );
      await expect(facade.cancelRun(null as never, runId)).rejects.toBeInstanceOf(RunActionInputError);
      expect(await statusOf(runId)).toBe("running");
      expect(await statusOf(otherRun)).toBe("running");
    });
  });

  describe("perform: the principal is decided by the database when the action runs", () => {
    let appPool: Pool;
    beforeAll(() => {
      appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    });
    afterAll(() => appPool.end());

    const REFUSED = { result: "refused", errorCode: "principal_not_authorised" };
    const statusOf = async (id: string) => (await admin.query("SELECT status FROM agent_runs WHERE id = $1", [id])).rows[0]?.status;
    const fresh = () => seedAccount(admin, randomUUID());

    function fakeRegistry() {
      const cancels: string[] = [];
      const unused = async () => {
        throw new Error("unused");
      };
      const target = {
        admit: unused,
        dispatch: unused,
        resume: unused,
        finalize: unused,
        cancel: async (run: { id: string }) => (cancels.push(run.id), { settled_usd: 0.25, released_usd: 0.75 }),
      };
      return { registry: { sandbox: target } as unknown as ExecutionTargetRegistry, cancels };
    }
    async function run(a: SeedRefs, status: "pending" | "running" | "succeeded" = "running", workItemId: string = a.workItemId): Promise<string> {
      const { id } = await insertAgentRun(writerPool, { id: randomUUID(), accountId: a.accountId, workItemId, role: "code-reviewer", runtime: "production", executionMode: "sandbox" });
      if (status !== "pending") await writeRunStatus(writerPool, { accountId: a.accountId, runId: id, from: "pending", to: "running" });
      if (status === "succeeded") await writeRunStatus(writerPool, { accountId: a.accountId, runId: id, from: "running", to: "succeeded" });
      return id;
    }
    async function item(a: SeedRefs, stage = "in_progress"): Promise<string> {
      const id = randomUUID();
      await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage) VALUES ($1, $2, $3, 'feature', 'internal', $4)", [id, a.accountId, a.repoId, stage]);
      return id;
    }
    async function token(a: SeedRefs, scopes = ["runs:cancel"]): Promise<string> {
      const sql = "INSERT INTO api_tokens (account_id, created_by, token_hash, display_hint, scopes, expires_at) VALUES ($1, $2, $3, 'fxat_x', $4, now() + interval '1 day') RETURNING id";
      return (await admin.query(sql, [a.accountId, a.userId, randomUUID(), scopes])).rows[0].id;
    }
    /** The real request definer, as the token's creator (or as the session member when no token is given). */
    async function request(a: SeedRefs, kind: string, target: string, tokenId?: string): Promise<string> {
      const row = await withTenant(appPool, a.accountId, a.userId, tokenId, async (c) => (await c.query("SELECT * FROM run_action_request($1, $2, NULL, $3)", [kind, target, HASH])).rows[0]);
      return row.action_id;
    }
    async function claimed(a: SeedRefs, kind: string, target: string, tokenId?: string): Promise<string> {
      const id = await request(a, kind, target, tokenId);
      expect(await facade.claimRunAction(id, 60)).not.toBeNull();
      return id;
    }
    /** A committed claimed row written directly (the superuser is exempt from the write guard). */
    async function forgedRow(a: SeedRefs, target: string, requestedBy: string, principalKind: string): Promise<string> {
      const { rows } = await admin.query(
        `INSERT INTO run_action_requests (account_id, kind, target_id, requested_by, principal_kind, request_hash, state, attempts, claimed_until)
         VALUES ($1, 'cancel_run', $2, $3, $4, $5, 'claimed', 1, now() + interval '1 minute') RETURNING id`,
        [a.accountId, target, requestedBy, principalKind, HASH],
      );
      return rows[0].id;
    }
    /** 0.10 settled and 1.00 released on a run. */
    async function spend(a: SeedRefs, runId: string): Promise<void> {
      await admin.query("INSERT INTO ledger (account_id, kind, source, usd, run_id) VALUES ($1, 'compute', 'sandbox', 0.10, $2)", [a.accountId, runId]);
      await admin.query("INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state) VALUES ($1, $2, 1.00, 'released')", [a.accountId, runId]);
    }
    const transitions = async (itemId: string) =>
      (await admin.query("SELECT to_stage, source, source_ref FROM work_item_transitions WHERE work_item_id = $1", [itemId])).rows;

    it("P1: a token-requested cancel is performed; the run is cancelled and the target stopped once", async () => {
      const a = await fresh();
      const runId = await run(a);
      const { registry, cancels } = fakeRegistry();
      const id = await claimed(a, "cancel_run", runId, await token(a));
      expect(await createRunActionFacade(writerPool, registry).performCancelRun(id)).toEqual({
        result: "done",
        outcome: { status: "cancelled", settled_usd: 0.25, released_usd: 0.75 },
      });
      expect(await statusOf(runId)).toBe("cancelled");
      expect(cancels).toEqual([runId]);
    });

    describe("P2: a change after the request and before the run refuses it, and nothing happens", () => {
      const setups: Array<[string, (a: SeedRefs, tokenId: string) => Promise<unknown>]> = [
        ["(a) the token is revoked", (_a, t) => admin.query("UPDATE api_tokens SET revoked_at = now() WHERE id = $1", [t])],
        ["(b) the token has expired", (_a, t) => admin.query("UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE id = $1", [t])],
        ["(c) runs:cancel is removed from its scopes", (_a, t) => admin.query("UPDATE api_tokens SET scopes = ARRAY['read'] WHERE id = $1", [t])],
        ["(d) its creator is removed from the account", (a) => admin.query("DELETE FROM account_members WHERE account_id = $1 AND user_id = $2", [a.accountId, a.userId])],
        ["(e) the account is paused", (a) => admin.query("UPDATE accounts SET owner_paused_at = now() WHERE id = $1", [a.accountId])],
        ["(e) the account is closed", (a) => admin.query("UPDATE accounts SET deleted_at = now() WHERE id = $1", [a.accountId])],
      ];
      it.each(setups)("%s", async (_name, change) => {
        const a = await fresh();
        const runId = await run(a);
        const { registry, cancels } = fakeRegistry();
        const tokenId = await token(a);
        const id = await claimed(a, "cancel_run", runId, tokenId);
        await change(a, tokenId);
        expect(await createRunActionFacade(writerPool, registry).performCancelRun(id)).toEqual(REFUSED);
        expect(await statusOf(runId)).toBe("running");
        expect(cancels).toEqual([]);
      });

      it("(f) the row names a live token of ANOTHER account", async () => {
        const a = await fresh();
        const b = await fresh();
        const runId = await run(a);
        const { registry, cancels } = fakeRegistry();
        const id = await forgedRow(a, runId, `token:${await token(b)}`, "token");
        expect(await createRunActionFacade(writerPool, registry).performCancelRun(id)).toEqual(REFUSED);
        expect(await statusOf(runId)).toBe("running");
        expect(cancels).toEqual([]);
      });

      it("(h) the token's creator is a member of ANOTHER account only", async () => {
        const a = await fresh();
        const b = await fresh();
        const runId = await run(a);
        const { registry, cancels } = fakeRegistry();
        const creator = randomUUID();
        await admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [creator, `${creator}@fixture.test`]);
        await admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')", [b.accountId, creator]);
        const sql = "INSERT INTO api_tokens (account_id, created_by, token_hash, display_hint, scopes, expires_at) VALUES ($1, $2, $3, 'fxat_x', ARRAY['runs:cancel'], now() + interval '1 day') RETURNING id";
        const tokenId = (await admin.query(sql, [a.accountId, creator, randomUUID()])).rows[0].id;
        const id = await forgedRow(a, runId, `token:${tokenId}`, "token");
        expect(await createRunActionFacade(writerPool, registry).performCancelRun(id)).toEqual(REFUSED);
        expect(await statusOf(runId)).toBe("running");
        expect(cancels).toEqual([]);
      });

      it.each([
        ["requested_by is malformed", () => "token:not-a-uuid", "token"],
        ["the prefix disagrees with principal_kind", (a: SeedRefs) => `session:${a.userId}`, "token"],
        ["the kind is session but the prefix says token", (a: SeedRefs) => `token:${a.userId}`, "session"],
      ])("(g) %s", async (_name, requestedBy, principalKind) => {
        const a = await fresh();
        const runId = await run(a);
        const { registry, cancels } = fakeRegistry();
        const id = await forgedRow(a, runId, requestedBy(a), principalKind);
        expect(await createRunActionFacade(writerPool, registry).performCancelRun(id)).toEqual(REFUSED);
        expect(await statusOf(runId)).toBe("running");
        expect(cancels).toEqual([]);
      });

      it("a session requester who has since been removed is refused; a member is performed", async () => {
        const a = await fresh();
        const { registry, cancels } = fakeRegistry();
        const perform = createRunActionFacade(writerPool, registry);
        const kept = await claimed(a, "cancel_run", await run(a));
        expect(await perform.performCancelRun(kept)).toMatchObject({ result: "done" });
        const runId = await run(a);
        const id = await claimed(a, "cancel_run", runId);
        await admin.query("DELETE FROM account_members WHERE account_id = $1 AND user_id = $2", [a.accountId, a.userId]);
        expect(await perform.performCancelRun(id)).toEqual(REFUSED);
        expect(await statusOf(runId)).toBe("running");
        expect(cancels).toHaveLength(1);
      });
    });

    describe("P3: only a live lease can be performed", () => {
      it.each([
        ["not claimed", { state: "accepted" }],
        ["lease expired", { state: "claimed", claimed_until: new Date(Date.now() - 1000) }],
        ["already done", { state: "done", finished_at: new Date() }],
        ["already refused", { state: "refused", finished_at: new Date() }],
        ["already failed", { state: "failed", finished_at: new Date() }],
      ])("%s: 55000 and no runner call", async (_name, over) => {
        const runId = await run(acct);
        const { registry, cancels } = fakeRegistry();
        const id = await seedRow({ target_id: runId, ...over });
        const err = await createRunActionFacade(writerPool, registry).performCancelRun(id).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(RunActionRefusedError);
        expect(err).toMatchObject({ code: "55000" });
        expect(await statusOf(runId)).toBe("running");
        expect(cancels).toEqual([]);
      });

      it("performing twice inside the lease cancels once, writes one status event, and the second answer is the terminal status", async () => {
        const a = await fresh();
        const runId = await run(a);
        const { registry, cancels } = fakeRegistry();
        const perform = createRunActionFacade(writerPool, registry);
        const id = await claimed(a, "cancel_run", runId);
        expect(await perform.performCancelRun(id)).toMatchObject({ result: "done", outcome: { status: "cancelled" } });
        expect(await perform.performCancelRun(id)).toMatchObject({ result: "done", outcome: { status: "cancelled" } });
        expect(cancels).toEqual([runId]);
        const events = await admin.query("SELECT 1 FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' AND payload->>'to' = 'cancelled'", [runId]);
        expect(events.rowCount).toBe(1);
      });

      it("a malformed id is a fixed input error, and an unknown one is P0002", async () => {
        await expect(facade.performCancelRun("nope")).rejects.toBeInstanceOf(RunActionInputError);
        await expect(facade.performCancelWorkItem("nope")).rejects.toBeInstanceOf(RunActionInputError);
        await expect(facade.performCancelRun(randomUUID())).rejects.toMatchObject({ code: "P0002" });
      });
    });

    it("P5: a finished run is answered with its sums and no runner or target call", async () => {
      const a = await fresh();
      const { registry, cancels } = fakeRegistry();
      const runId = await run(a, "succeeded"); // dispatched through the sandbox target, so a stray cancel would reach the fake
      await spend(a, runId);
      const id = await claimed(a, "cancel_run", runId);
      expect(await createRunActionFacade(writerPool, registry).performCancelRun(id)).toEqual({
        result: "done",
        outcome: { status: "succeeded", settled_usd: 0.1, released_usd: 1 },
      });
      expect(cancels).toEqual([]);
    });

    it("a kind other than the method's, or a target in no account of the requester, is a fixed refusal", async () => {
      const a = await fresh();
      const b = await fresh();
      const { registry } = fakeRegistry();
      const perform = createRunActionFacade(writerPool, registry);
      expect(await perform.performCancelWorkItem(await claimed(a, "cancel_run", await run(a)))).toEqual({ result: "refused", errorCode: "kind_mismatch" });
      const foreign = await forgedRow(a, b.runId, `session:${a.userId}`, "session");
      expect(await perform.performCancelRun(foreign)).toEqual({ result: "refused", errorCode: "target_not_found" });
      expect(await statusOf(b.runId)).toBe("running");
    });

    describe("cancel_work_item", () => {
      it("P6: live runs are cancelled, a finished one is untouched, and the item moves to needs_human once", async () => {
        const a = await fresh();
        const wi = await item(a);
        const [pending, running, done] = [await run(a, "pending", wi), await run(a, "running", wi), await run(a, "succeeded", wi)];
        await spend(a, done); // a finished run's spend is not part of this call's totals
        const { registry, cancels } = fakeRegistry();
        const id = await claimed(a, "cancel_work_item", wi, await token(a));
        const out = await createRunActionFacade(writerPool, registry).performCancelWorkItem(id);
        expect(out).toEqual({ result: "done", outcome: { runs_cancelled: 2, settled_usd: 0.5, released_usd: 1.5, stage: "needs_human", halted: true } });
        expect(cancels.sort()).toEqual([pending, running].sort());
        expect(await statusOf(done)).toBe("succeeded");
        expect(await transitions(wi)).toEqual([{ to_stage: "needs_human", source: "control_plane", source_ref: `run-action:${id}` }]);
      });

      it("P7: a failure part-way is retried without repeating work, and the stage is written exactly once", async () => {
        const a = await fresh();
        const wi = await item(a);
        const [first, second] = [await run(a, "running", wi), await run(a, "running", wi)];
        const { registry, cancels } = fakeRegistry();
        const id = await claimed(a, "cancel_work_item", wi);
        // A fixture trigger makes the second run's status write fail once; a fixed error reaches the caller.
        await admin.query("CREATE FUNCTION fx_perform_inject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$");
        await admin.query(`CREATE TRIGGER fx_perform_inject BEFORE UPDATE ON agent_runs FOR EACH ROW WHEN (OLD.id = '${second}') EXECUTE FUNCTION fx_perform_inject()`);
        try {
          await expect(createRunActionFacade(writerPool, registry).performCancelWorkItem(id)).rejects.toBeInstanceOf(RunActionUnavailableError);
        } finally {
          await admin.query("DROP TRIGGER fx_perform_inject ON agent_runs");
          await admin.query("DROP FUNCTION fx_perform_inject()");
        }
        expect(cancels).toEqual([first]);
        const perform = createRunActionFacade(writerPool, registry);
        expect(await perform.performCancelWorkItem(id)).toMatchObject({ outcome: { runs_cancelled: 1, stage: "needs_human" } });
        expect(cancels).toEqual([first, second]);
        expect(await transitions(wi)).toHaveLength(1);
        expect(await perform.performCancelWorkItem(id)).toMatchObject({ outcome: { runs_cancelled: 0, stage: "needs_human" } });
        expect(await transitions(wi)).toHaveLength(1);
      });

      it("P7: an item already closed is 'unchanged' (no error); a cross-tenant item is not found", async () => {
        const a = await fresh();
        const b = await fresh();
        const { registry } = fakeRegistry();
        const perform = createRunActionFacade(writerPool, registry);
        const closed = await item(a, "closed");
        expect(await perform.performCancelWorkItem(await claimed(a, "cancel_work_item", closed))).toMatchObject({ outcome: { runs_cancelled: 0, stage: "unchanged" } });
        expect(await transitions(closed)).toEqual([]);
        const other = await claimed(a, "cancel_work_item", await item(a));
        await admin.query("UPDATE run_action_requests SET target_id = $2 WHERE id = $1", [other, b.workItemId]);
        expect(await perform.performCancelWorkItem(other)).toEqual({ result: "refused", errorCode: "target_not_found" });
        expect(await statusOf(b.runId)).toBe("running");
      });

      it("P7: 101 live runs give 100 cancelled and remaining, the item is parked and marked on the first page, once; the next call finishes", async () => {
        const a = await fresh();
        const wi = await item(a);
        await admin.query(
          `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode)
           SELECT gen_random_uuid(), $1, $2, 'code-reviewer', 'production', 'running', 'sandbox' FROM generate_series(1, 101)`,
          [a.accountId, wi],
        );
        const { registry, cancels } = fakeRegistry();
        const perform = createRunActionFacade(writerPool, registry);
        const id = await claimed(a, "cancel_work_item", wi);
        expect(await perform.performCancelWorkItem(id)).toMatchObject({ outcome: { runs_cancelled: 100, remaining: true } });
        expect(cancels).toHaveLength(100);
        expect(await transitions(wi)).toHaveLength(1); // marked and parked on the first page, so nothing new starts while the rest are cancelled
        expect(await perform.performCancelWorkItem(id)).toMatchObject({ outcome: { runs_cancelled: 1, stage: "needs_human" } });
        expect(await transitions(wi)).toHaveLength(1);
      }, 120_000);

      describe("paging does not spend the retry budget", () => {
        async function manyRuns(a: SeedRefs, wi: string, n: number): Promise<void> {
          await admin.query(
            `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode)
             SELECT gen_random_uuid(), $1, $2, 'code-reviewer', 'production', 'running', 'sandbox' FROM generate_series(1, $3::int)`,
            [a.accountId, wi, n],
          );
        }
        const liveRuns = async (wi: string) =>
          (await admin.query("SELECT count(*)::int n FROM agent_runs WHERE work_item_id = $1 AND status IN ('pending', 'running', 'paused')", [wi])).rows[0].n;
        const events = async (a: SeedRefs, id: string) =>
          (await admin.query("SELECT type FROM domain_events WHERE account_id = $1 AND subject_id = $2 ORDER BY seq", [a.accountId, id])).rows.map((r: { type: string }) => r.type);
        const settledAudits = async (a: SeedRefs, id: string) =>
          (await admin.query("SELECT 1 FROM audit_log WHERE account_id = $1 AND action = 'run_action.settled' AND payload->>'action_id' = $2", [a.accountId, id])).rowCount;
        /**
         * The workflow's loop over the facade, as the pipeline's settle mapping does it: a page with
         * `remaining` settles as progress, a finished cancel as done, a thrown perform as a counted retry
         * (delay 0 here). Returns the `attempts` seen at each claim. Stops when a claim finds nothing.
         */
        async function drive(id: string, perform: { performCancelWorkItem(id: string): Promise<{ result: string; outcome?: Record<string, unknown> }> }, maxClaims = 40): Promise<number[]> {
          const seen: number[] = [];
          for (let i = 0; i < maxClaims; i += 1) {
            const c = await facade.claimRunAction(id, 60);
            if (!c) break;
            seen.push(c.attempts);
            try {
              const out = await perform.performCancelWorkItem(id);
              if (out.result === "done" && out.outcome?.remaining === true) await facade.settleRunAction(id, { state: "accepted", progress: true });
              else await facade.settleRunAction(id, { state: "done", outcome: out.outcome ?? {} });
            } catch {
              await facade.settleRunAction(id, { state: "accepted", errorCode: "perform_failed", retryAfterSeconds: 0 });
            }
          }
          return seen;
        }

        it("P1: 750 live runs end done in one action: every run cancelled, attempts never above 1, progress_pages 7, one stage row, one settled event and audit row", async () => {
          const a = await fresh();
          const wi = await item(a);
          await manyRuns(a, wi, 750);
          const { registry, cancels } = fakeRegistry();
          const id = await request(a, "cancel_work_item", wi);
          const seen = await drive(id, createRunActionFacade(writerPool, registry));
          expect(seen).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
          expect(cancels).toHaveLength(750);
          expect(await liveRuns(wi)).toBe(0);
          expect(await rowOf(id)).toMatchObject({ state: "done", attempts: 1, progress_pages: 7, error_code: null });
          expect((await rowOf(id)).outcome).toMatchObject({ runs_cancelled: 50, stage: "needs_human" });
          expect(await transitions(wi)).toHaveLength(1);
          expect(await events(a, id)).toEqual(["run_action.settled"]);
          expect(await settledAudits(a, id)).toBe(1);
        }, 300_000);

        it("P2: 3 pages of progress, then 5 thrown performs: failed with the thrower's code at the 5th throw, not earlier; the progress pages' runs stay cancelled", async () => {
          const a = await fresh();
          const wi = await item(a);
          await manyRuns(a, wi, 350);
          const { registry } = fakeRegistry();
          const id = await request(a, "cancel_work_item", wi);
          const perform = createRunActionFacade(writerPool, registry);
          for (let page = 1; page <= 3; page += 1) {
            expect(await facade.claimRunAction(id, 60)).toMatchObject({ attempts: 1 });
            expect(await perform.performCancelWorkItem(id)).toMatchObject({ outcome: { remaining: true } });
            await facade.settleRunAction(id, { state: "accepted", progress: true });
            expect(await rowOf(id)).toMatchObject({ state: "accepted", attempts: 0, progress_pages: page });
          }
          expect(await liveRuns(wi)).toBe(50);
          for (let throwNo = 1; throwNo <= 5; throwNo += 1) {
            expect(await facade.claimRunAction(id, 60)).toMatchObject({ attempts: throwNo });
            await facade.settleRunAction(id, { state: "accepted", errorCode: "perform_failed", retryAfterSeconds: 0 });
            expect(await rowOf(id)).toMatchObject({ state: throwNo < 5 ? "accepted" : "failed", attempts: throwNo });
          }
          expect(await rowOf(id)).toMatchObject({ state: "failed", error_code: "perform_failed", progress_pages: 3 });
          expect(await liveRuns(wi)).toBe(50);
        }, 120_000);

        it("the page cap is the SQL constant: MAX_PROGRESS_PAGES is 100 and is what run_action_requeue_progress compares against", async () => {
          const { rows } = await admin.query("SELECT pg_get_functiondef('run_action_requeue_progress(uuid)'::regprocedure) AS def");
          expect(rows[0].def).toMatch(new RegExp(`max_pages\\s+constant\\s+(?:int|integer)\\s*:=\\s*${MAX_PROGRESS_PAGES};`, "i"));
          expect(MAX_PROGRESS_PAGES).toBe(100);
        });

        it("P3: the page after the cap settles failed (too_many_runs, one failed event, the marker and the one stage row stay); 101 runs at 100 pages is the boundary", async () => {
          const a = await fresh();
          const wi = await item(a);
          await manyRuns(a, wi, 101);
          const { registry } = fakeRegistry();
          const id = await claimed(a, "cancel_work_item", wi);
          await admin.query("UPDATE run_action_requests SET progress_pages = $2 WHERE id = $1", [id, MAX_PROGRESS_PAGES]);
          const perform = createRunActionFacade(writerPool, registry);
          expect(await perform.performCancelWorkItem(id)).toMatchObject({ outcome: { remaining: true } });
          await facade.settleRunAction(id, { state: "accepted", progress: true });
          expect(await rowOf(id)).toMatchObject({ state: "failed", error_code: "too_many_runs", outcome: { reason: "too_many_runs" }, progress_pages: MAX_PROGRESS_PAGES });
          expect(await events(a, id)).toEqual(["run_action.settled", "run_action.failed"]);
          expect(await settledAudits(a, id)).toBe(1);
          expect(await transitions(wi)).toHaveLength(1);
        }, 120_000);

        it("the 100th progress page still re-queues (99 -> 100)", async () => {
          const a = await fresh();
          const wi = await item(a);
          const id = await claimed(a, "cancel_work_item", wi);
          await admin.query("UPDATE run_action_requests SET progress_pages = $2 WHERE id = $1", [id, MAX_PROGRESS_PAGES - 1]);
          await facade.settleRunAction(id, { state: "accepted", progress: true });
          expect(await rowOf(id)).toMatchObject({ state: "accepted", progress_pages: MAX_PROGRESS_PAGES, attempts: 0 });
          expect(await events(a, id)).toEqual([]);
        });

        it("a progress settle on a request with no live lease is refused (55000) and changes nothing", async () => {
          const a = await fresh();
          const id = await request(a, "cancel_work_item", await item(a));
          const before = await rowOf(id);
          await expect(facade.settleRunAction(id, { state: "accepted", progress: true })).rejects.toMatchObject({ code: "55000" });
          expect(await rowOf(id)).toEqual(before);
        });
      });
    });
  });
});
