import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  actionIdFromBody,
  claimBody,
  handleKick,
  performBody,
  performerFor,
  runActionSteps,
  settleBody,
  settleInputFor,
  signKick,
  sweepRunActions,
  verifyKick,
  NOT_CONFIGURED_LOG,
  type ClaimedAction,
  type PerformResult,
  type RunActionsWorker,
  type SettleInput,
} from "../src/runActions/index.js";

/** D#2 H14c-3b over a fake worker: no database, no SDK. The real-facade cases are runActions.pg.test.ts and runActionCancelRace.test.ts. */
const ID = "11111111-1111-4111-8111-111111111111";
const SECRET = "kick-test-secret";
/** The same vector packages/api's sender test pins: the two sides must agree on it. */
const VECTOR = { timestamp: 1_700_000_000, body: `{"actionId":"${ID}"}`, sig: "d663602c8dffed01a571b48d351906f96ae59b9ae0d6cd2fbb360de89c8b52a3" };
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function fakeWorker(over: Partial<RunActionsWorker> & { claimed?: ClaimedAction | null } = {}) {
  const settles: Array<[string, SettleInput]> = [];
  const performs: Array<[string, string]> = [];
  const worker: RunActionsWorker = {
    claimRunAction: vi.fn(async () => (over.claimed === undefined ? { id: ID, kind: "cancel_run", attempts: 1 } : over.claimed)),
    settleRunAction: vi.fn(async (id: string, input: SettleInput) => void settles.push([id, input])),
    listDueRunActions: vi.fn(async () => []),
    purgeRunActions: vi.fn(async () => 0),
    performCancelRun: vi.fn(async (id: string): Promise<PerformResult> => (performs.push(["cancel_run", id]), { result: "done", outcome: { status: "cancelled", settled_usd: 0, released_usd: 1 } })),
    performCancelWorkItem: vi.fn(async (id: string): Promise<PerformResult> => (performs.push(["cancel_work_item", id]), { result: "done", outcome: { runs_cancelled: 2, settled_usd: 0, released_usd: 2, stage: "needs_human" } })),
    ...over,
  };
  return { worker, settles, performs };
}

describe("C2: the kick signature", () => {
  it("the vector verifies, and signKick reproduces it", () => {
    expect(signKick(SECRET, VECTOR.timestamp, VECTOR.body)).toBe(VECTOR.sig);
    expect(verifyKick(`t=${VECTOR.timestamp},sig=${VECTOR.sig}`, VECTOR.body, SECRET, VECTOR.timestamp)).toBe(true);
  });

  it("only a valid signature within 60 s either way passes", () => {
    const header = `t=${VECTOR.timestamp},sig=${VECTOR.sig}`;
    expect(verifyKick(header, VECTOR.body, SECRET, VECTOR.timestamp + 60)).toBe(true);
    expect(verifyKick(header, VECTOR.body, SECRET, VECTOR.timestamp - 60)).toBe(true);
    expect(verifyKick(header, VECTOR.body, SECRET, VECTOR.timestamp + 61)).toBe(false); // an old timestamp
    expect(verifyKick(header, VECTOR.body, SECRET, VECTOR.timestamp - 61)).toBe(false);
  });

  it("a replayed body with a fresh timestamp but the old signature fails", () => {
    const fresh = VECTOR.timestamp + 500;
    expect(verifyKick(`t=${fresh},sig=${VECTOR.sig}`, VECTOR.body, SECRET, fresh)).toBe(false);
  });

  it("a wrong secret, a changed body, a missing or malformed header and an empty secret all fail", () => {
    const now = VECTOR.timestamp;
    const header = `t=${VECTOR.timestamp},sig=${VECTOR.sig}`;
    expect(verifyKick(header, VECTOR.body, "other-secret", now)).toBe(false);
    expect(verifyKick(header, VECTOR.body.replace("1111", "2222"), SECRET, now)).toBe(false);
    expect(verifyKick(null, VECTOR.body, SECRET, now)).toBe(false);
    expect(verifyKick("", VECTOR.body, SECRET, now)).toBe(false);
    expect(verifyKick(`t=${VECTOR.timestamp},sig=abc`, VECTOR.body, SECRET, now)).toBe(false);
    expect(verifyKick(`t=x,sig=${VECTOR.sig}`, VECTOR.body, SECRET, now)).toBe(false);
    expect(verifyKick(`${header},extra=1`, VECTOR.body, SECRET, now)).toBe(false);
    // An unset secret fails closed even for a signature computed under the empty secret.
    expect(verifyKick(`t=${now},sig=${signKick("", now, VECTOR.body)}`, VECTOR.body, "", now)).toBe(false);
  });

  it("an oversized body is refused before it is hashed", () => {
    const body = JSON.stringify({ actionId: ID, pad: "x".repeat(2000) });
    expect(verifyKick(`t=1,sig=${signKick(SECRET, 1, body)}`, body, SECRET, 1)).toBe(false);
  });
});

describe("C2: the kick handler", () => {
  const run = (header: string | null, body: string, over: Partial<Parameters<typeof handleKick>[2]> = {}) => {
    const started: string[] = [];
    const deps = {
      secret: SECRET,
      nowSeconds: () => VECTOR.timestamp,
      configured: () => true,
      startWorkflow: async (id: string) => void started.push(id),
      ...over,
    };
    return handleKick(header, body, deps).then((status) => ({ status, started }));
  };
  const good = `t=${VECTOR.timestamp},sig=${VECTOR.sig}`;

  it("a valid kick is 202 and starts the workflow for the id it carries", async () => {
    expect(await run(good, VECTOR.body)).toEqual({ status: 202, started: [ID] });
  });

  it.each([
    ["a bad signature", `t=${VECTOR.timestamp},sig=${"0".repeat(64)}`],
    ["no header", null],
    ["an old timestamp", good],
  ])("%s is 401 and starts nothing", async (name, header) => {
    const out = await run(header, VECTOR.body, name === "an old timestamp" ? { nowSeconds: () => VECTOR.timestamp + 600 } : {});
    expect(out).toEqual({ status: 401, started: [] });
  });

  it("a replayed body with a fresh timestamp and the old signature is 401", async () => {
    const out = await run(`t=${VECTOR.timestamp + 10},sig=${VECTOR.sig}`, VECTOR.body, { nowSeconds: () => VECTOR.timestamp + 10 });
    expect(out).toEqual({ status: 401, started: [] });
  });

  it("an unset secret is 401 even for a signature made with no secret", async () => {
    const header = `t=${VECTOR.timestamp},sig=${signKick("", VECTOR.timestamp, VECTOR.body)}`;
    expect(await run(header, VECTOR.body, { secret: "" })).toEqual({ status: 401, started: [] });
  });

  it("an id that does not exist is still 202 (no oracle); the workflow's claim finds nothing and performs nothing", async () => {
    const { worker, performs, settles } = fakeWorker({ claimed: null });
    const unknown = "99999999-9999-4999-8999-999999999999";
    const body = JSON.stringify({ actionId: unknown });
    const out = await run(`t=${VECTOR.timestamp},sig=${signKick(SECRET, VECTOR.timestamp, body)}`, body, {
      startWorkflow: async (id) => void (await runActionSteps(worker, id)),
    });
    expect(out.status).toBe(202);
    expect(worker.claimRunAction).toHaveBeenCalledWith(unknown, 300);
    expect(performs).toEqual([]);
    expect(settles).toEqual([]);
  });

  it("a signed body without a server-generated uuid is acknowledged and nothing starts", async () => {
    for (const body of ["{}", "not json", '{"actionId":5}', '{"actionId":"x; DROP"}', '{"actionId":["' + ID + '"]}']) {
      const out = await run(`t=${VECTOR.timestamp},sig=${signKick(SECRET, VECTOR.timestamp, body)}`, body);
      expect(out, body).toEqual({ status: 202, started: [] });
    }
    expect(actionIdFromBody(VECTOR.body)).toBe(ID);
  });

  it("while no worker is configured a valid kick is 202 and performs nothing", async () => {
    expect(await run(good, VECTOR.body, { configured: () => false })).toEqual({ status: 202, started: [] });
  });

  it("a workflow start that throws does not change the 202 (the sweep covers it)", async () => {
    const out = await run(good, VECTOR.body, {
      startWorkflow: async () => {
        throw new Error("boom");
      },
    });
    expect(out.status).toBe(202);
  });
});

describe("C3: the dispatcher", () => {
  it("cancel_run, cancel_work_item, start_preview, retry_run and advance_work_item are registered; nothing else is, prototype keys included", () => {
    expect(performerFor("cancel_run")).toBeTypeOf("function");
    expect(performerFor("cancel_work_item")).toBeTypeOf("function");
    expect(performerFor("start_preview")).toBeTypeOf("function");
    expect(performerFor("retry_run")).toBeTypeOf("function");
    expect(performerFor("advance_work_item")).toBeTypeOf("function");
    for (const kind of ["continue_work_item", "constructor", "__proto__", "toString", ""]) expect(performerFor(kind)).toBeUndefined();
  });
});

describe("C3/C4: the workflow's steps over a fake facade", () => {
  it("claim takes a 60 s lease; a NULL claim ends the workflow with no perform and no settle", async () => {
    const { worker, performs, settles } = fakeWorker({ claimed: null });
    expect(await claimBody(worker, ID)).toBeNull();
    expect(worker.claimRunAction).toHaveBeenCalledWith(ID, 300);
    expect(await runActionSteps(worker, ID)).toBeNull();
    expect(performs).toEqual([]);
    expect(settles).toEqual([]);
  });

  it("no worker configured: claim is null", async () => {
    expect(await claimBody(null, ID)).toBeNull();
  });

  it("cancel_run: performCancelRun gets the action id and nothing else; done settles with the facade's outcome", async () => {
    const { worker, settles, performs } = fakeWorker();
    expect(await runActionSteps(worker, ID)).toEqual({ id: ID, state: "done" });
    expect(worker.performCancelRun).toHaveBeenCalledWith(ID); // exactly one argument
    expect(performs).toEqual([["cancel_run", ID]]);
    expect(settles).toEqual([[ID, { state: "done", outcome: { status: "cancelled", settled_usd: 0, released_usd: 1 } }]]);
  });

  it("cancel_work_item: performCancelWorkItem gets the id; done settles with runs_cancelled, amounts and stage", async () => {
    const { worker, settles } = fakeWorker({ claimed: { id: ID, kind: "cancel_work_item", attempts: 1 } });
    await runActionSteps(worker, ID);
    expect(worker.performCancelWorkItem).toHaveBeenCalledWith(ID);
    expect(worker.performCancelRun).not.toHaveBeenCalled();
    expect(settles).toEqual([[ID, { state: "done", outcome: { runs_cancelled: 2, settled_usd: 0, released_usd: 2, stage: "needs_human" } }]]);
  });

  it.each(["principal_not_authorised", "target_not_found", "kind_mismatch"])("a policy refusal (%s) settles refused with that code and outcome.reason, and never retries", async (errorCode) => {
    const { worker, settles } = fakeWorker({ performCancelRun: vi.fn(async (): Promise<PerformResult> => ({ result: "refused", errorCode })) });
    expect(await runActionSteps(worker, ID)).toEqual({ id: ID, state: "refused" });
    expect(settles).toEqual([[ID, { state: "refused", errorCode, outcome: { reason: errorCode } }]]);
    expect(settles.some(([, s]) => s.state === "accepted")).toBe(false);
    expect(worker.claimRunAction).toHaveBeenCalledTimes(1);
  });

  it("a kind with no performer settles refused kind_not_supported, without a retry and without any perform call", async () => {
    const { worker, settles } = fakeWorker({ claimed: { id: ID, kind: "continue_work_item", attempts: 1 } });
    await runActionSteps(worker, ID);
    expect(settles).toEqual([[ID, { state: "refused", errorCode: "kind_not_supported", outcome: { reason: "kind_not_supported" } }]]);
    expect(worker.performCancelRun).not.toHaveBeenCalled();
    expect(worker.performCancelWorkItem).not.toHaveBeenCalled();
  });

  it("retry_run: performRetryRun gets the id and its outcome settles done; a refusal settles refused; a worker without the method refuses retry_unavailable", async () => {
    const out = { run_id: "r2", model: "sonnet-5", escalated_from_model: "haiku-4.5" };
    const done = fakeWorker({ claimed: { id: ID, kind: "retry_run", attempts: 1 }, performRetryRun: vi.fn(async (): Promise<PerformResult> => ({ result: "done", outcome: out })) });
    await runActionSteps(done.worker, ID);
    expect(done.worker.performRetryRun).toHaveBeenCalledWith(ID);
    expect(done.settles).toEqual([[ID, { state: "done", outcome: out }]]);
    const denied = fakeWorker({ claimed: { id: ID, kind: "retry_run", attempts: 1 }, performRetryRun: vi.fn(async (): Promise<PerformResult> => ({ result: "refused", errorCode: "model_budget_exceeded" })) });
    await runActionSteps(denied.worker, ID);
    expect(denied.settles).toEqual([[ID, { state: "refused", errorCode: "model_budget_exceeded", outcome: { reason: "model_budget_exceeded" } }]]);
    const bare = fakeWorker({ claimed: { id: ID, kind: "retry_run", attempts: 1 } });
    await runActionSteps(bare.worker, ID);
    expect(bare.settles).toEqual([[ID, { state: "refused", errorCode: "retry_unavailable", outcome: { reason: "retry_unavailable" } }]]);
  });

  it("advance_work_item: performAdvanceWorkItem gets the id and its outcome settles done; a refusal settles refused; a worker without the method refuses advance_unavailable", async () => {
    const out = { work_item_id: "w1", advance: "started" };
    const done = fakeWorker({ claimed: { id: ID, kind: "advance_work_item", attempts: 1 }, performAdvanceWorkItem: vi.fn(async (): Promise<PerformResult> => ({ result: "done", outcome: out })) });
    await runActionSteps(done.worker, ID);
    expect(done.worker.performAdvanceWorkItem).toHaveBeenCalledWith(ID);
    expect(done.settles).toEqual([[ID, { state: "done", outcome: out }]]);
    const denied = fakeWorker({ claimed: { id: ID, kind: "advance_work_item", attempts: 1 }, performAdvanceWorkItem: vi.fn(async (): Promise<PerformResult> => ({ result: "refused", errorCode: "already_running" })) });
    await runActionSteps(denied.worker, ID);
    expect(denied.settles).toEqual([[ID, { state: "refused", errorCode: "already_running", outcome: { reason: "already_running" } }]]);
    const bare = fakeWorker({ claimed: { id: ID, kind: "advance_work_item", attempts: 1 } });
    await runActionSteps(bare.worker, ID);
    expect(bare.settles).toEqual([[ID, { state: "refused", errorCode: "advance_unavailable", outcome: { reason: "advance_unavailable" } }]]);
  });

  it("an AuthorCheckUnavailableError is a counted retry with the real reason, author_check_unavailable, not perform_failed", async () => {
    const err = Object.assign(new Error("x"), { name: "AuthorCheckUnavailableError" });
    const { worker, settles } = fakeWorker({ claimed: { id: ID, kind: "retry_run", attempts: 2 }, performRetryRun: vi.fn(async () => Promise.reject(err)) });
    await runActionSteps(worker, ID);
    expect(settles).toEqual([[ID, { state: "accepted", errorCode: "author_check_unavailable", retryAfterSeconds: 20 }]]);
  });

  it.each([
    [1, 10],
    [2, 20],
    [3, 40],
    [4, 80],
    [5, 160],
  ])("a thrown error on attempt %i settles accepted with retryAfterSeconds %i (2^attempts x 5); the definer writes failed after the 5th", async (attempts, delay) => {
    const { worker, settles } = fakeWorker({
      claimed: { id: ID, kind: "cancel_run", attempts },
      performCancelRun: vi.fn(async () => {
        throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432 user=runner"), { name: "RunActionUnavailableError" });
      }),
    });
    expect(await runActionSteps(worker, ID)).toEqual({ id: ID, state: "accepted" });
    expect(settles).toEqual([[ID, { state: "accepted", errorCode: "worker_unavailable", retryAfterSeconds: delay }]]);
    expect(JSON.stringify(settles)).not.toContain("ECONNREFUSED"); // the code is fixed; the message never travels
  });

  it("cancel_work_item done with remaining: true settles accepted as a page of progress (no delay, no outcome, no error code)", async () => {
    const { worker, settles } = fakeWorker({
      claimed: { id: ID, kind: "cancel_work_item", attempts: 1 },
      performCancelWorkItem: vi.fn(async (): Promise<PerformResult> => ({ result: "done", outcome: { runs_cancelled: 100, remaining: true } })),
    });
    expect(await runActionSteps(worker, ID)).toEqual({ id: ID, state: "accepted", progress: true });
    expect(settles).toEqual([[ID, { state: "accepted", progress: true }]]);
    expect(settleInputFor({ id: ID, kind: "cancel_work_item", attempts: 1 }, { result: "done", outcome: { remaining: true } })).toStrictEqual({ state: "accepted", progress: true });
  });

  it("a thrown error is still a counted retry with backoff, never progress", () => {
    expect(settleInputFor({ id: ID, kind: "cancel_work_item", attempts: 2 }, { result: "error", errorCode: "worker_unavailable" })).toStrictEqual({
      state: "accepted",
      errorCode: "worker_unavailable",
      retryAfterSeconds: 20,
    });
  });

  it("remaining: true on a cancel_run outcome is not special (only the work-item performer pages)", () => {
    expect(settleInputFor({ id: ID, kind: "cancel_run", attempts: 1 }, { result: "done", outcome: { remaining: true } })).toEqual({ state: "done", outcome: { remaining: true } });
  });

  it("a worker that vanishes after the claim fails the step instead of settling (the lease runs out, the sweep retries)", async () => {
    await expect(performBody(null, { id: ID, kind: "cancel_run", attempts: 1 })).rejects.toThrow("worker not configured");
    await expect(settleBody(null, { id: ID, kind: "cancel_run", attempts: 1 }, { result: "done", outcome: {} })).rejects.toThrow("worker not configured");
  });
});

describe("A3: every step's arguments and results are plain JSON", () => {
  const roundTrips = (v: unknown) => {
    expect(JSON.parse(JSON.stringify(v))).toEqual(v);
    expect(structuredClone(v)).toEqual(v);
  };

  it.each([
    ["done", {}],
    ["refused", { performCancelRun: vi.fn(async (): Promise<PerformResult> => ({ result: "refused", errorCode: "target_not_found" })) }],
    [
      "thrown",
      {
        performCancelRun: vi.fn(async () => {
          throw new Error("x");
        }),
      },
    ],
  ])("claim, perform and settle I/O round-trips (%s)", async (_name, over) => {
    const { worker } = fakeWorker(over);
    roundTrips([ID]);
    const claimed = await claimBody(worker, ID);
    roundTrips(claimed);
    const outcome = await performBody(worker, claimed!);
    roundTrips([claimed]);
    roundTrips(outcome);
    roundTrips([claimed, outcome]);
    roundTrips(await settleBody(worker, claimed!, outcome));
  });

  it("the claim step result does not carry the worker's other fields (account, principal, requester)", async () => {
    const full = { id: ID, kind: "cancel_run", attempts: 1, accountId: "a", requestedBy: "session:u", principalKind: "session", targetId: "t", claimedUntil: "x" };
    const { worker } = fakeWorker({ claimed: full as never });
    expect(Object.keys((await claimBody(worker, ID))!).sort()).toEqual(["attempts", "id", "kind"]);
  });
});

describe("C6: the sweep over a fake worker", () => {
  it("lists (30 s, 100), starts a workflow per id, then purges 90 days (7,776,000 s, 1000)", async () => {
    const ids = ["a", "b", "c"];
    const { worker } = fakeWorker({ listDueRunActions: vi.fn(async () => ids), purgeRunActions: vi.fn(async () => 4) });
    const started: string[] = [];
    const result = await sweepRunActions({ worker, startWorkflow: async (id) => void started.push(id), log: () => {} });
    expect(worker.listDueRunActions).toHaveBeenCalledWith(30, 100);
    expect(worker.purgeRunActions).toHaveBeenCalledWith(7_776_000, 1000);
    expect(started).toEqual(ids);
    expect(result).toEqual({ configured: true, listed: 3, started: 3, purged: 4 });
    expect(worker.claimRunAction).not.toHaveBeenCalled(); // the sweep leases nothing
  });

  it("one id that will not start does not hold back the rest", async () => {
    const { worker } = fakeWorker({ listDueRunActions: vi.fn(async () => ["a", "b", "c"]) });
    const started: string[] = [];
    const result = await sweepRunActions({
      worker,
      startWorkflow: async (id) => {
        if (id === "b") throw new Error("no");
        started.push(id);
      },
      log: () => {},
    });
    expect(started).toEqual(["a", "c"]);
    expect(result.started).toBe(2);
  });

  it("no worker: logs exactly the one line and does nothing else", async () => {
    const log = vi.fn();
    const startWorkflow = vi.fn();
    const result = await sweepRunActions({ worker: null, startWorkflow, log });
    expect(log.mock.calls).toEqual([["run actions: worker not configured"]]);
    expect(NOT_CONFIGURED_LOG).toBe("run actions: worker not configured");
    expect(startWorkflow).not.toHaveBeenCalled();
    expect(result.configured).toBe(false);
  });
});

/** Source text of the files this PR adds, comments removed. */
function codeOf(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}
const PIPELINE_FILES = ["dispatcher", "cancelPerformers", "workflow", "sweep", "kick", "index"].map((f) => `packages/pipeline/src/runActions/${f}.ts`);
const WEB_FILES = [
  "apps/web/lib/worker.ts",
  "apps/web/workflows/runAction.ts",
  "apps/web/app/api/internal/run-actions/kick/route.ts",
  "apps/web/app/api/cron/run-action-sweep/route.ts",
  "apps/web/app/api/cron/run-action-sweep/handler.ts",
];

describe("A1/C3/C7: what these files may not contain", () => {
  it("no run_action_* SQL, no pool, no runner import, no query call (facade only)", () => {
    for (const file of [...PIPELINE_FILES, ...WEB_FILES]) {
      const code = codeOf(file);
      expect(code, file).not.toMatch(/run_action_/);
      expect(code, file).not.toMatch(/\bPool\b|createPool|from ["']pg["']|\.query\(|\bSELECT\b|\bINSERT\b|\bUPDATE\b/);
      expect(code, file).not.toMatch(/from ["']@fx\/runner|from ["']@fx\/db|@fx\/worker\/src|worker\/src\//);
    }
  });

  it("the session-only facade.cancelRun is never called, and no spend, ledger or reservation function is", () => {
    for (const file of [...PIPELINE_FILES, ...WEB_FILES]) {
      const code = codeOf(file);
      expect(code, file).not.toMatch(/\.cancelRun\(|\bcancelRun\b/);
      expect(code, file).not.toMatch(/spend|ledger|reservation|charge|refund|@fx\/spend|@fx\/billing/i);
    }
  });

  it("the performers pass the action id only (no principal, user, token, requested_by or kind)", () => {
    const code = codeOf("packages/pipeline/src/runActions/cancelPerformers.ts");
    expect(code).toMatch(/worker\.performCancelRun\(actionId\)/);
    expect(code).toMatch(/worker\.performCancelWorkItem\(actionId\)/);
    expect(code).not.toMatch(/principal|userId|token|requested_by|requestedBy/i);
  });

  it("RUN_ACTION_KICK_SECRET is read in exactly two source files: the HTTP signal and the kick handler", () => {
    const tracked = execFileSync("git", ["-C", REPO_ROOT, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "apps", "packages", "sites"], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    })
      .split("\0")
      .filter((f) => /\.(ts|tsx|mts|mjs|js|json)$/.test(f) && !/(^|\/)(test|tests)\//.test(f) && !/\.test\.tsx?$/.test(f));
    const holders = tracked.filter((f) => readFileSync(path.join(REPO_ROOT, f), "utf8").includes("RUN_ACTION_KICK_SECRET"));
    // apps/web/env-manifest.ts is listed because it names the variable, never reads it; apps/web/test/env-manifest.test.ts
    // fails if that file gains an env access or a runtime import.
    expect(holders.sort()).toEqual(["apps/web/env-manifest.ts", "packages/api/src/runActions/httpSignal.ts", "packages/pipeline/src/runActions/kick.ts"]);
  });

  it("no log call in these files can carry a body, signature, header or secret", () => {
    for (const file of [...PIPELINE_FILES, ...WEB_FILES]) {
      for (const m of codeOf(file).matchAll(/(?:console\.\w+|\blog)\(([^)]*)\)/g)) {
        expect(m[1], `${file}: ${m[0]}`).not.toMatch(/body|sig|secret|header|req\b|request/i);
      }
    }
  });
});

describe("C7: nothing is logged while handling a kick or a sweep", () => {
  it("a kick (valid, forged, stale) and a sweep write nothing to the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    try {
      const deps = { secret: SECRET, nowSeconds: () => VECTOR.timestamp, configured: () => true, startWorkflow: async () => {} };
      await handleKick(`t=${VECTOR.timestamp},sig=${VECTOR.sig}`, VECTOR.body, deps);
      await handleKick(`t=${VECTOR.timestamp},sig=${"0".repeat(64)}`, VECTOR.body, deps);
      await handleKick(`t=1,sig=${VECTOR.sig}`, VECTOR.body, deps);
      await sweepRunActions({ worker: fakeWorker().worker, startWorkflow: async () => {}, log: () => {} });
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});
