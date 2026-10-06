import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { RUN_STATUS_TRANSITIONS } from "@fx/runner";
import { createWorker, type Worker, RunActionForbiddenError, RunActionInputError, RunActionRefusedError, RunActionUnavailableError } from "../src/index.js";
import { CANCELLABLE_RUN_STATUSES, MAX_OUTCOME_BYTES } from "../src/runActions.js";
import { forgetWorkerForTests } from "../src/compositionRoot.js";

interface Call {
  pool: "runner" | "ops";
  sql: string;
  params: unknown[];
}
const calls: Call[] = [];
let nextRows: Record<string, unknown>[] = [];
let queryError: Error | undefined;

function fakePool(tag: "runner" | "ops"): Pool {
  return {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ pool: tag, sql, params });
      if (queryError) throw queryError;
      return { rows: nextRows };
    },
    connect: async () => {
      calls.push({ pool: tag, sql: "connect", params: [] });
      throw new Error("connect refused (test)");
    },
  } as unknown as Pool;
}

const mocks = vi.hoisted(() => ({ createWorkerPools: vi.fn() }));
vi.mock("../src/pools.js", async (original) => ({
  ...(await original<typeof import("../src/pools.js")>()),
  createWorkerPools: mocks.createWorkerPools,
}));

beforeEach(() => {
  forgetWorkerForTests();
  calls.length = 0;
  nextRows = [];
  queryError = undefined;
  mocks.createWorkerPools.mockReset();
  mocks.createWorkerPools.mockImplementation(async () => ({
    runnerPool: fakePool("runner"),
    platformOpsPool: fakePool("ops"),
    close: async () => {},
  }));
});

const OPTIONS = {
  env: { FX_GH_FORWARD_SUFFIX: "fixture.test", FX_GH_FORWARD_HOST: "gh-proxy.fixture.test" },
  vercel: { teamId: "t", projectId: "p", getToken: async () => "tok" },
  ports: {
    decryptTenantKey: async () => "k",
    modelConnection: { get: async () => { throw new Error("unused"); } },
    connectionStatus: { markBroken: async () => {} },
    hooks: { resume: async () => {} },
  },
};
const ID = "11111111-1111-4111-8111-111111111111";

describe("run-action facade: every method runs on the runner login's pool and nothing else", () => {
  it("claimRunAction maps the claimed row to plain data", async () => {
    nextRows = [
      { id: ID, account_id: "a", kind: "cancel_run", target_id: "t", requested_by: "u", principal_kind: "session", attempts: 1, claimed_until: new Date("2026-01-01T00:00:00Z") },
    ];
    const worker = await createWorker(OPTIONS);
    const claimed = await worker.claimRunAction(ID, 60);
    expect(claimed).toEqual({
      id: ID,
      accountId: "a",
      kind: "cancel_run",
      targetId: "t",
      requestedBy: "u",
      principalKind: "session",
      attempts: 1,
      claimedUntil: "2026-01-01T00:00:00.000Z",
    });
    expect(calls).toEqual([{ pool: "runner", sql: expect.stringContaining("run_action_claim("), params: [ID, 60] }]);
  });

  it("claimRunAction is null when nothing is claimable (the definer's NULL composite, or no row)", async () => {
    const worker = await createWorker(OPTIONS);
    nextRows = [{ id: null, account_id: null }];
    expect(await worker.claimRunAction(ID, 60)).toBeNull();
    nextRows = [];
    expect(await worker.claimRunAction(ID, 60)).toBeNull();
  });

  it("settleRunAction passes the state, outcome as JSON, code and retry delay", async () => {
    const worker = await createWorker(OPTIONS);
    await worker.settleRunAction(ID, { state: "done", outcome: { status: "cancelled" } });
    await worker.settleRunAction(ID, { state: "accepted", retryAfterSeconds: 30, errorCode: "busy" });
    expect(calls.map((c) => [c.pool, c.params])).toEqual([
      ["runner", [ID, "done", '{"status":"cancelled"}', null, null]],
      ["runner", [ID, "accepted", null, "busy", 30]],
    ]);
  });

  it("settleRunAction with progress calls the requeue definer only; at the cap it then settles failed with too_many_runs", async () => {
    const worker = await createWorker(OPTIONS);
    nextRows = [{ r: "requeued" }];
    await worker.settleRunAction(ID, { state: "accepted", progress: true });
    expect(calls.map((c) => [c.pool, c.sql, c.params])).toEqual([["runner", "SELECT run_action_requeue_progress($1::uuid) AS r", [ID]]]);
    calls.length = 0;
    nextRows = [{ r: "cap_reached" }];
    await worker.settleRunAction(ID, { state: "accepted", progress: true });
    expect(calls.map((c) => [c.sql.split("(")[0], c.params])).toEqual([
      ["SELECT run_action_requeue_progress", [ID]],
      ["SELECT run_action_settle", [ID, '{"reason":"too_many_runs"}']],
    ]);
    expect(calls[1]!.sql).toContain("'failed'");
    expect(calls[1]!.sql).toContain("'too_many_runs'");
  });

  it("listDueRunActions returns ids; purgeRunActions returns the count", async () => {
    const worker = await createWorker(OPTIONS);
    nextRows = [{ id: "x" }, { id: "y" }];
    expect(await worker.listDueRunActions(5, 10)).toEqual(["x", "y"]);
    nextRows = [{ n: 3 }];
    expect(await worker.purgeRunActions(86400, 100)).toBe(3);
    nextRows = [];
    expect(await worker.purgeRunActions(86400, 100)).toBe(0);
    expect(calls.map((c) => [c.pool, c.params])).toEqual([
      ["runner", [5, 10]],
      ["runner", [86400, 100]],
      ["runner", [86400, 100]],
    ]);
  });

  it("cancelRun runs on the runner pool, never platform_ops; a malformed id is refused before any connection", async () => {
    const worker = await createWorker(OPTIONS);
    await expect(worker.cancelRun({ accountId: ID, userId: ID }, "not-a-uuid")).rejects.toThrow(/not found/);
    expect(calls).toEqual([]);
    await expect(worker.cancelRun({ accountId: ID, userId: ID }, ID)).rejects.toThrow();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.pool === "runner")).toBe(true);
  });

  it("a definer refusal becomes a fixed error carrying only its code", async () => {
    const worker = await createWorker(OPTIONS);
    queryError = Object.assign(new Error("run_action_settle: no such action"), { code: "P0002" });
    const err = await worker.settleRunAction(ID, { state: "done" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunActionRefusedError);
    expect(err).toMatchObject({ code: "P0002", message: "run action: refused (P0002)" });
    expect(err).not.toBe(queryError);
  });
});

describe("run-action facade: refusals before any SQL", () => {
  it("cancelRun refuses a token principal with a fixed error and touches nothing", async () => {
    const worker = await createWorker(OPTIONS);
    for (const kind of ["token", "system", "service", "TOKEN"]) {
      const err = await worker.cancelRun({ accountId: ID, userId: ID, kind } as never, ID).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RunActionForbiddenError);
      expect((err as Error).message).toBe("run action: principal kind not permitted");
    }
    expect(calls).toEqual([]);
  });

  it("cancelRun refuses a forged system principal before any SQL, and accepts a session principal", async () => {
    const worker = await createWorker(OPTIONS);
    await expect(worker.cancelRun({ accountId: ID, userId: ID, kind: "system" } as never, ID)).rejects.toBeInstanceOf(RunActionForbiddenError);
    expect(calls).toEqual([]);
    await expect(worker.cancelRun({ accountId: ID, userId: ID, kind: "session" }, ID)).rejects.not.toBeInstanceOf(RunActionForbiddenError);
    expect(calls.length).toBeGreaterThan(0);
  });

  it("malformed ids and out-of-range numbers are a fixed input error, never echoed, and run no SQL", async () => {
    const worker = await createWorker(OPTIONS);
    const secret = "x'--secret-input";
    const attempts: Array<() => Promise<unknown>> = [
      () => worker.claimRunAction(secret, 60),
      () => worker.claimRunAction(ID, 0),
      () => worker.claimRunAction(ID, 3601),
      () => worker.claimRunAction(ID, 1.5),
      () => worker.settleRunAction(secret, { state: "done" }),
      () => worker.settleRunAction(ID, { state: "bogus" as never }),
      () => worker.settleRunAction(ID, { state: "accepted", retryAfterSeconds: 86401 }),
      () => worker.settleRunAction(ID, { state: "failed", errorCode: "Bad Code" }),
      // progress is legal only alone with state accepted
      () => worker.settleRunAction(ID, { state: "done", progress: true }),
      () => worker.settleRunAction(ID, { state: "failed", progress: true }),
      () => worker.settleRunAction(ID, { state: "refused", progress: true }),
      () => worker.settleRunAction(ID, { state: "accepted", progress: true, retryAfterSeconds: 0 }),
      () => worker.settleRunAction(ID, { state: "accepted", progress: true, errorCode: "busy" }),
      () => worker.settleRunAction(ID, { state: "accepted", progress: true, outcome: { a: 1 } }),
      () => worker.settleRunAction(ID, { state: "accepted", progress: false as never }),
      () => worker.listDueRunActions(-1, 10),
      () => worker.listDueRunActions(0, 1001),
      () => worker.listDueRunActions(0, 0),
      () => worker.purgeRunActions(59, 10),
      () => worker.purgeRunActions(3600, 1001),
      () => worker.purgeRunActions(Number.NaN, 10),
      () => worker.performCancelRun(secret),
      () => worker.performCancelWorkItem(secret),
    ];
    for (const attempt of attempts) {
      const err = await attempt().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RunActionInputError);
      expect((err as Error).message).toBe("run action: invalid input");
    }
    expect(calls).toEqual([]);
  });

  it("a settle outcome over the size cap is refused; one at the cap is sent", async () => {
    const worker = await createWorker(OPTIONS);
    await expect(worker.settleRunAction(ID, { state: "done", outcome: { blob: "a".repeat(MAX_OUTCOME_BYTES) } })).rejects.toBeInstanceOf(
      RunActionInputError,
    );
    expect(calls).toEqual([]);
    await worker.settleRunAction(ID, { state: "done", outcome: { blob: "a".repeat(MAX_OUTCOME_BYTES - 20) } });
    expect(calls.length).toBe(1);
  });
});

describe("run-action facade: perform methods take the action id and nothing else", () => {
  it("has no principal, user or kind parameter (types), and extra arguments never reach SQL", async () => {
    expectTypeOf<Parameters<Worker["performCancelRun"]>>().toEqualTypeOf<[actionId: string]>();
    expectTypeOf<Parameters<Worker["performCancelWorkItem"]>>().toEqualTypeOf<[actionId: string]>();
    const worker = await createWorker(OPTIONS);
    expect(worker.performCancelRun.length).toBe(1);
    expect(worker.performCancelWorkItem.length).toBe(1);
    nextRows = [{ allowed: false, account_id: ID, kind: "cancel_run", target_id: ID, principal_kind: "token", user_id: null }];
    const forged = { accountId: ID, userId: ID, kind: "session", requestedBy: `session:${ID}` };
    const call = worker.performCancelRun as (...a: unknown[]) => Promise<unknown>;
    expect(await call(ID, forged)).toEqual({ result: "refused", errorCode: "principal_not_authorised" });
    expect(calls).toEqual([{ pool: "runner", sql: expect.stringContaining("run_action_perform_principal("), params: [ID] }]);
  });
});

describe("run-action facade: drift from the routes and the runner", () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
  it("the cancellable statuses are the runner's and the api's", () => {
    const fromRunner = Object.entries(RUN_STATUS_TRANSITIONS)
      .filter(([, to]) => to.includes("cancelled"))
      .map(([from]) => from)
      .sort();
    expect([...CANCELLABLE_RUN_STATUSES].sort()).toEqual(fromRunner);
    const api = /CANCELLABLE_RUN_STATUSES = \[([^\]]*)\]/.exec(read("../../api/src/routes/run-actions.ts"))![1]!;
    expect(api.split(",").map((x) => x.trim().replaceAll('"', "")).sort()).toEqual(fromRunner);
  });

  it("the route still asks for runs:cancel and a member; the perform definer checks the same two things", () => {
    const routes = read("../../api/src/routes/run-actions.ts");
    const common = /const cancelCommon = \{([\s\S]*?)\} as const/.exec(routes)![1]!;
    expect(common).toContain('minRole: "member"');
    expect(common).toContain('scope: "runs:cancel"');
    const sql = read("../../db/migrations/0682_run_action_perform.sql");
    expect(sql).toContain("'runs:cancel' = ANY (t.scopes)");
    expect(sql).toContain("am.user_id = t.created_by");
  });
});

describe("run-action facade: connection failures are scrubbed", () => {
  it("login refused, host unreachable and socket errors become one fixed error with no driver text", async () => {
    const worker = await createWorker(OPTIONS);
    const leaks = [
      Object.assign(new Error('password authentication failed for user "runner_login"'), { code: "28P01" }),
      Object.assign(new Error("connect ECONNREFUSED 10.0.0.9:5432"), { code: "ECONNREFUSED", syscall: "connect" }),
      Object.assign(new Error("getaddrinfo ENOTFOUND db.internal"), { code: "ENOTFOUND", syscall: "getaddrinfo" }),
      Object.assign(new Error('invalid input syntax for type uuid: "secret"'), { code: "22P02" }),
    ];
    for (const leak of leaks) {
      queryError = leak;
      const err = await worker.listDueRunActions(0, 10).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RunActionUnavailableError);
      expect((err as Error).message).toBe("run action: database unavailable");
      expect(JSON.stringify(err)).not.toMatch(/runner_login|10\.0\.0\.9|db\.internal|secret/);
      expect((err as Error).cause).toBeUndefined();
    }
  });
});
