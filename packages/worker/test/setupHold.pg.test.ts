import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExecutionTargetRegistry } from "@fx/runner";
import { startBuildForItem } from "@fx/pipeline";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { markSetupRequestDone } from "@fx/core/src/setup-requests/markDone.js";
import type { VercelEnvSource } from "@fx/core/src/setup-requests/checks.js";
import { createAdvanceModule, type AdvanceModuleDeps, type AdvanceStartArgs } from "../src/advance.js";
import type { RunStarter } from "../src/preview.js";
import type { SeatResult } from "../src/seat.js";

/**
 * [pg] D#598 P8a: an item with an open setup request does not advance, and neither does an in-flight workflow step for it; a done request
 * lets it go on at once; a withdrawn one keeps it held until a person advances it again. Real Postgres, real run-action definer.
 */
const SEAT: SeatResult = {
  ok: true,
  seat: { repoId: "unused", product: "team", roleCard: "card", model: "haiku-4.5", capUsd: 5, spend: {}, limits: {}, timeoutMs: 1, maxExtensions: 3 } as never,
};

describe("setup request hold [pg]", { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, appPool]) await p.end();
  });

  let nextNumber = 7000;
  let nextDiscussion = 700;
  async function item(a: SeedRefs): Promise<string> {
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [a.repoId]);
    const id = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'issue', 'internal', 'in_progress', $4)", [id, a.accountId, a.repoId, nextNumber++]);
    const d = randomUUID();
    await admin.query("INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, $2, $3, 'feature', 't', $4, 'internal', 'user')", [d, a.accountId, nextDiscussion++, id]);
    await admin.query("UPDATE work_items SET discussion_id = $1 WHERE id = $2", [d, id]);
    await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, 'spec', encode(sha256(convert_to('spec', 'UTF8')), 'hex'), 'system')", [a.accountId, id]);
    return id;
  }
  async function setupRequest(a: SeedRefs, workItemId: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO setup_requests (account_id, repo_id, work_item_id, origin, kind, target, env_name, reason, created_by)
       VALUES ($1, $2, $3, 'agent', 'env_var', 'cloud-staging', 'SOME_NAME', 'needed', $4) RETURNING id`,
      [a.accountId, a.repoId, workItemId, a.userId],
    );
    return rows[0]!.id;
  }
  const close = (id: string, to: "done" | "withdrawn") =>
    admin.query("UPDATE setup_requests SET state = $2, resolution = $3, resolved_by = (SELECT created_by FROM setup_requests WHERE id = $1) WHERE id = $1", [id, to, to === "done" ? "marked_done" : "withdrawn"]);
  async function request(a: SeedRefs, workItemId: string): Promise<string> {
    const row = await withTenant(appPool, a.accountId, a.userId, undefined, async (c) => (await c.query("SELECT * FROM run_action_request('advance_work_item', $1, NULL, $2)", [workItemId, randomUUID().replace(/-/g, "").repeat(2)])).rows[0]);
    return row.action_id as string;
  }
  const claim = async (id: string) => {
    const { createRunActionFacade } = await import("../src/runActions.js");
    expect(await createRunActionFacade(writerPool, {} as never).claimRunAction(id, 600)).not.toBeNull();
  };

  const reg = { sandbox: { runtime: "production" } } as unknown as ExecutionTargetRegistry;
  const starter: RunStarter = { start: async () => ({ runId: randomUUID() }) } as never;
  const reached: string[] = [];
  function advance() {
    const args: AdvanceStartArgs[] = [];
    const deps: AdvanceModuleDeps = {
      starter,
      resolveRunSeat: async () => SEAT,
      startAdvance: async (x) => void args.push(x),
      triage: null,
      registry: reg,
      panel: (async () => (reached.push("panel"), { status: "ok" })) as never,
      spec: (async () => (reached.push("spec"), { status: "ok" })) as never,
      build: startBuildForItem as never,
      review: {} as never,
    };
    return { module: createAdvanceModule(writerPool, deps), args };
  }
  const whoOf = (a: SeedRefs, workItemId: string) => ({ accountId: a.accountId, userId: a.userId, workItemId, haltEpoch: 0 });

  it("an open request refuses the perform and the workflow step; nothing starts", async () => {
    const a = await seedAccount(admin, randomUUID());
    const wi = await item(a);
    await setupRequest(a, wi);
    const approval = await request(a, wi);
    await claim(approval);
    const t = advance();
    expect(await t.module.performAdvanceWorkItem(approval)).toEqual({ result: "refused", errorCode: "setup_request_open" });
    expect(t.args).toEqual([]);
    expect(await t.module.advanceBuild(whoOf(a, wi), approval, 1)).toEqual({ status: "refused", reason: "setup_request_open" });
    expect((await admin.query("SELECT count(*)::int AS n FROM agent_runs WHERE work_item_id = $1", [wi])).rows[0].n).toBe(0);
  });

  it("a request on another item, or in another account, holds nothing", async () => {
    const a = await seedAccount(admin, randomUUID());
    const b = await seedAccount(admin, randomUUID());
    const held = await item(a);
    const free = await item(a);
    const foreign = await item(b);
    await setupRequest(a, held);
    await setupRequest(b, foreign);
    const t = advance();
    const approval = await request(a, free);
    await claim(approval);
    expect(await t.module.performAdvanceWorkItem(approval)).toEqual({ result: "done", outcome: { work_item_id: free, advance: "started" } });
  });

  it("marked done: the item goes on at once", async () => {
    const a = await seedAccount(admin, randomUUID());
    const wi = await item(a);
    const id = await setupRequest(a, wi);
    await close(id, "done");
    const approval = await request(a, wi);
    await claim(approval);
    const t = advance();
    expect(await t.module.performAdvanceWorkItem(approval)).toEqual({ result: "done", outcome: { work_item_id: wi, advance: "started" } });
    expect(t.args).toHaveLength(1);
  });

  it("withdrawn: an advance requested before the withdrawal stays refused; one requested after it goes on", async () => {
    const a = await seedAccount(admin, randomUUID());
    const wi = await item(a);
    const before = await request(a, wi);
    await claim(before);
    const id = await setupRequest(a, wi);
    await close(id, "withdrawn");
    const t = advance();
    expect(await t.module.performAdvanceWorkItem(before)).toEqual({ result: "refused", errorCode: "setup_request_withdrawn" });
    // The performer settles the refused request; the person then presses the button again.
    await admin.query("UPDATE run_action_requests SET state = 'refused', claimed_until = NULL, error_code = 'setup_request_withdrawn', finished_at = now() WHERE id = $1", [before]);
    const after = await request(a, wi);
    expect(after).not.toBe(before);
    await claim(after);
    expect(await t.module.performAdvanceWorkItem(after)).toEqual({ result: "done", outcome: { work_item_id: wi, advance: "started" } });
  });

  describe("D#598 P8b-2: Mark done files the restart, and the check after it decides whether the item runs", () => {
    const withCheck = async (a: SeedRefs, workItemId: string): Promise<string> =>
      (
        await admin.query<{ id: string }>(
          `INSERT INTO setup_requests (account_id, repo_id, work_item_id, origin, kind, target, env_name, reason, check_kind, created_by)
           VALUES ($1, $2, $3, 'agent', 'env_var', 'cloud-staging', 'SOME_NAME', 'needed', 'env_var_present', $4) RETURNING id`,
          [a.accountId, a.repoId, workItemId, a.userId],
        )
      ).rows[0]!.id;
    const source = (set: boolean): VercelEnvSource => ({
      available: true,
      listEnvNames: async () => ({ ok: true, entries: set ? [{ name: "SOME_NAME", targets: ["production"] }] : [] }),
    });
    const filed = async (a: SeedRefs, wi: string) =>
      (await admin.query<{ id: string }>("SELECT id FROM run_action_requests WHERE account_id = $1 AND kind = 'advance_work_item' AND target_id = $2 AND state = 'accepted'", [a.accountId, wi])).rows.map((r) => r.id);

    it("the variable is there: the one restart Mark done filed starts the item, and nothing else does", async () => {
      const a = await seedAccount(admin, randomUUID());
      const wi = await item(a);
      const id = await withCheck(a, wi);
      const out = await markSetupRequestDone({ pool: appPool, envSource: source(true), signal: null, log: () => undefined }, { accountId: a.accountId, userId: a.userId, id });
      expect(out).toMatchObject({ changed: true, check: "passed" });
      const [restart, ...rest] = await filed(a, wi);
      expect(rest).toEqual([]);
      await claim(restart!);
      const t = advance();
      expect(await t.module.performAdvanceWorkItem(restart!)).toEqual({ result: "done", outcome: { work_item_id: wi, advance: "started" } });
      expect(t.args).toHaveLength(1);
    });

    it("the variable is missing: the restart that was filed is refused by the hold (sentence 4's pause is real), and no workflow step runs", async () => {
      const a = await seedAccount(admin, randomUUID());
      const wi = await item(a);
      const id = await withCheck(a, wi);
      const out = await markSetupRequestDone({ pool: appPool, envSource: source(false), signal: null, log: () => undefined }, { accountId: a.accountId, userId: a.userId, id });
      expect(out).toMatchObject({ changed: true, check: "not_yet", request: { state: "open", checkReason: "env_var_missing" } });
      const [restart] = await filed(a, wi);
      await claim(restart!);
      const t = advance();
      expect(await t.module.performAdvanceWorkItem(restart!)).toEqual({ result: "refused", errorCode: "setup_request_open" });
      expect(await t.module.advanceBuild(whoOf(a, wi), restart!, 1)).toEqual({ status: "refused", reason: "setup_request_open" });
      expect(t.args).toEqual([]);
      // The performer settles it; the variable is set; the person presses again: a new generation, a new restart, and it starts.
      await admin.query("UPDATE run_action_requests SET state = 'refused', claimed_until = NULL, error_code = 'setup_request_open', finished_at = now() WHERE id = $1", [restart]);
      const again = await markSetupRequestDone({ pool: appPool, envSource: source(true), signal: null, log: () => undefined }, { accountId: a.accountId, userId: a.userId, id });
      expect(again).toMatchObject({ changed: true, check: "passed", request: { state: "done" } });
      const [second, ...others] = await filed(a, wi);
      expect(others).toEqual([]);
      expect(second).not.toBe(restart);
      await claim(second!);
      expect(await t.module.performAdvanceWorkItem(second!)).toEqual({ result: "done", outcome: { work_item_id: wi, advance: "started" } });
    });
  });
});
