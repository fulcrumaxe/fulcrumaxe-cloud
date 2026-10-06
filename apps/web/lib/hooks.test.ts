import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureReports } from "../test/captureReports";

/**
 * D#2 H14c-3-3a-3 (P2/P3): the production hooks port, the follower starter and the follower workflow's body.
 * `workflow`'s `createHook` and `sleep` only run inside a real workflow execution (and vitest here is 2.x, below
 * `@workflow/vitest`'s 3.1 peer), so they are replaced with controllable fakes; the steps run as plain functions over
 * mocked runner bodies. The first real proof of createHook/resumeHook is the live smoke.
 */
const world = vi.hoisted(() => {
  type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
  const deferred = <T>(): Deferred<T> => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  };
  return {
    order: [] as string[],
    hook: undefined as Deferred<{ runId: string; status: string }> | undefined,
    sleeps: [] as { ms: number; resolve: () => void }[],
    statuses: [] as { status: string; done: boolean }[],
    timeoutStatus: { status: "timed_out", done: true },
    deferred,
  };
});

vi.mock("workflow", () => ({
  createHook: vi.fn(() => {
    world.order.push("createHook");
    world.hook = world.deferred();
    return { then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => world.hook!.promise.then(res, rej) };
  }),
  sleep: vi.fn((ms: number) => {
    world.order.push(`sleep:${ms}`);
    return new Promise<void>((resolve) => world.sleeps.push({ ms, resolve }));
  }),
}));
vi.mock("workflow/api", () => ({ resumeHook: vi.fn(), start: vi.fn() }));
vi.mock("@fx/worker", async (original) => ({
  ...(await original<typeof import("@fx/worker")>()),
  followStatusBody: vi.fn(async () => {
    world.order.push("status");
    return world.statuses.shift() ?? { status: "running", done: false };
  }),
  followTimeoutBody: vi.fn(async () => {
    world.order.push("timeout");
    return world.timeoutStatus;
  }),
}));
vi.mock("./worker", () => ({ getWorker: vi.fn(async () => null) }));

import { agentRunFollowWorkflow } from "../workflows/agentRunFollow";
import { createFollow, createHooksPort } from "./hooks";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const TOKEN = "33333333-3333-4333-8333-333333333333";
const ARGS = { runId: RUN, accountId: ACCOUNT, hookToken: TOKEN, watchdogMs: 150_000 };
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

let logged: string[];
beforeEach(() => {
  world.order.length = 0;
  world.sleeps.length = 0;
  world.statuses.length = 0;
  world.timeoutStatus = { status: "timed_out", done: true };
  logged = [];
  for (const m of ["info", "warn", "error", "log"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
});
afterEach(() => vi.restoreAllMocks());

describe("the follower workflow body", () => {
  it("creates the hook BEFORE it first reads the status, so a run that finished earlier is seen and nothing waits", async () => {
    world.statuses.push({ status: "succeeded", done: true });
    const out = await agentRunFollowWorkflow(ARGS);
    expect(out).toEqual({ runId: RUN, status: "succeeded", timedOut: false });
    expect(world.order).toEqual(["createHook", "status"]); // no sleep: it never waited for the hook or the watchdog
    expect(logged.some((l) => l.includes("run.follower_finalized"))).toBe(true);
  });

  it("a hook for this run wakes it; the status row decides, and the follower finalizes once", async () => {
    world.statuses.push({ status: "running", done: false }, { status: "failed", done: true });
    const done = agentRunFollowWorkflow(ARGS);
    await flush();
    world.hook!.resolve({ runId: RUN, status: "failed" });
    expect(await done).toEqual({ runId: RUN, status: "failed", timedOut: false });
    expect(world.order.filter((o) => o === "timeout")).toEqual([]);
    expect(logged.filter((l) => l.includes("run.follower_finalized"))).toHaveLength(1);
  });

  it("a hook payload for ANOTHER run is ignored: no status read on its say-so, and the run still ends on its own watchdog", async () => {
    const done = agentRunFollowWorkflow({ ...ARGS, watchdogMs: 60_000 });
    await flush();
    const statusReadsBefore = world.order.filter((o) => o === "status").length;
    world.hook!.resolve({ runId: "99999999-9999-4999-8999-999999999999", status: "succeeded" });
    await flush();
    expect(world.order.filter((o) => o === "status").length).toBe(statusReadsBefore);
    world.sleeps.at(-1)!.resolve();
    const out = await done;
    expect(out).toEqual({ runId: RUN, status: "timed_out", timedOut: true });
  });

  it("the watchdog is the run's own: it sleeps in slices that add up to watchdogMs, then times the run out once", async () => {
    const done = agentRunFollowWorkflow(ARGS); // 150 s
    for (let i = 0; i < 3; i++) {
      await flush();
      world.sleeps.at(-1)!.resolve();
    }
    const out = await done;
    const slept = world.order.filter((o) => o.startsWith("sleep:")).map((o) => Number(o.slice(6)));
    expect(slept).toEqual([60_000, 60_000, 30_000]);
    expect(slept.reduce((a, b) => a + b, 0)).toBe(ARGS.watchdogMs);
    expect(out).toEqual({ runId: RUN, status: "timed_out", timedOut: true });
    expect(world.order.filter((o) => o === "timeout")).toHaveLength(1);
    expect(logged.some((l) => l.includes("run.follower_timed_out"))).toBe(true);
  });

  it("a poll tick that finds the run terminal ends it with no hook at all (the resume was lost)", async () => {
    world.statuses.push({ status: "running", done: false }, { status: "succeeded", done: true });
    const done = agentRunFollowWorkflow(ARGS);
    await flush();
    world.sleeps.at(-1)!.resolve();
    expect(await done).toEqual({ runId: RUN, status: "succeeded", timedOut: false });
  });

  it("the arguments and the result are plain data, and no log line or result holds the hook token", async () => {
    expect(structuredClone(ARGS)).toEqual(ARGS);
    world.statuses.push({ status: "succeeded", done: true });
    const out = await agentRunFollowWorkflow(ARGS);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    for (const l of logged) expect(l).not.toContain(TOKEN);
  });
});

describe("the production hooks port", () => {
  it("forwards exactly { runId, status } to resumeHook, whatever it was handed", async () => {
    const resumeHook = vi.fn(async () => undefined);
    const port = createHooksPort({ resumeHook });
    await port.resume(TOKEN, { runId: RUN, status: "succeeded", envelope: { secret: "agent text" }, usd: 3 } as never);
    expect(resumeHook).toHaveBeenCalledWith(TOKEN, { runId: RUN, status: "succeeded" });
    expect(JSON.stringify(resumeHook.mock.calls)).not.toContain("agent text");
  });

  it("a resume that fails (the hook is not registered yet, or the service is down) is not an error, and the token is never logged", async () => {
    const port = createHooksPort({
      resumeHook: async () => {
        throw new Error(`Hook not found for token ${TOKEN}`);
      },
    });
    const reports = captureReports();
    await expect(port.resume(TOKEN, { runId: RUN, status: "failed" })).resolves.toBeUndefined();
    // Counted by stage and code: no hook token and no message reach the reporter.
    expect(reports.classes).toEqual([{ service: "test", route: "/", stage: "hooks.resume", code: "other" }]);
    expect(reports.everything()).not.toContain(TOKEN);
    expect(logged.some((l) => l.includes("hook.resume_failed") && l.includes(RUN))).toBe(true);
    for (const l of logged) expect(l).not.toContain(TOKEN);
  });

  it("logs a success by run id only", async () => {
    await createHooksPort({ resumeHook: async () => undefined }).resume(TOKEN, { runId: RUN, status: "succeeded" });
    expect(logged).toEqual([JSON.stringify({ event: "hook.resumed", run_id: RUN })]);
  });
});

describe("the follower starter", () => {
  it("starts the follower workflow with the run's plain-data arguments", async () => {
    const start = vi.fn(async () => undefined);
    await createFollow({ start })(ARGS);
    expect(start).toHaveBeenCalledWith(agentRunFollowWorkflow, [ARGS]);
  });
});

describe("the request path and the follower reach the runner only through @fx/worker", () => {
  it("no non-test file under apps/web imports a value from @fx/runner", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const path = await import("node:path");
    const root = path.join(__dirname, "..");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (["node_modules", ".next", "test"].includes(name)) continue;
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) files.push(full);
      }
    };
    walk(root);
    // The gh-proxy route's two pure env-to-config helpers are the boundary test's own allowlisted exception.
    const offenders = files.filter((f) => !f.includes(`${path.sep}gh-proxy${path.sep}`) && /^\s*(import|export)\s+(?!type\b)[^;]*from\s+["']@fx\/runner(?![-\w])/m.test(readFileSync(f, "utf8").replace(/import\s+type\s[^;]*;/g, "")));
    expect(files.length).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});
