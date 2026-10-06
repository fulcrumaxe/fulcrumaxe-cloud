import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { QueuedRunNotSupportedError, RunnerTarget, SandboxTarget, startAgentRun, type ExecutionTargetRegistry, type StartAgentRunInput } from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount } from "@fx/db/test/helpers/seed.js";
import { createSandboxTargetHarness } from "../../runner/test/helpers/sandboxTargetFakes.js";
import { createFakeJobIssuer, createFakeVisibility } from "../../runner/test/helpers/runnerTargetFakes.js";
import { PREVIEW_ROLE } from "../src/preview.js";
import { WATCHDOG_MARGIN_MS, createRunStarter, type FollowArgs } from "../src/starter.js";
import { seedPreviewTarget } from "./support/previewTarget.js";

// The spy passes straight through: it only lets a test see exactly what the starter handed `startAgentRun`.
vi.mock("@fx/runner", async (importOriginal) => {
  const original = await importOriginal<typeof import("@fx/runner")>();
  return { ...original, startAgentRun: vi.fn(original.startAgentRun) };
});

const SMOKE_REPORT_PATH = fileURLToPath(new URL("../../../scripts/ops/run-smoke-report.ts", import.meta.url));

/** D#2 H14c-3-3a [pg]: the production run starter, against the real definers over the SDK fake. */
describe("createRunStarter [pg]", { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });
  afterEach(() => vi.restoreAllMocks());

  function world(follow: (args: FollowArgs) => Promise<void>) {
    const harness = createSandboxTargetHarness(writerPool, []);
    const registry: ExecutionTargetRegistry = { sandbox: new SandboxTarget(harness.deps) };
    return { harness, registry, starter: createRunStarter({ pool: writerPool, registry, follow }) };
  }

  async function newInput(key: string, overCap = false): Promise<StartAgentRunInput> {
    const a = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE model_connections SET status = 'ok' WHERE account_id = $1", [a.accountId]);
    const t = await seedPreviewTarget(admin, a);
    return {
      accountId: a.accountId,
      repoId: t.repoId,
      role: PREVIEW_ROLE,
      product: "team",
      roleCard: "card",
      prompt: "the preview prompt",
      model: "haiku-4.5",
      capUsd: 20,
      timeoutMs: 10 * 60_000,
      spend: { plan: "starter", purpose: "preview", trigger: "foreground", estimateModelUsd: 20, estimateComputeUsd: 0.5, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: overCap ? 1 : 20 },
      idempotency: { key, requestHash: createHash("sha256").update(key).digest("hex") },
    };
  }

  it("2a/12: a second start with the same key returns the same run, starts nothing, and follows once", async () => {
    const follows: FollowArgs[] = [];
    const w = world(async (args) => void follows.push(args));
    const input = await newInput(`run-action:${randomUUID()}`);
    const first = await w.starter.start(input);
    const runsAfterFirst = w.harness.fakeSandbox.state.created.length;
    expect((await w.starter.start(input)).runId).toBe(first.runId);
    expect((await w.starter.start({ ...input })).runId).toBe(first.runId);
    expect(follows).toHaveLength(1);
    expect(w.harness.fakeSandbox.state.created).toHaveLength(runsAfterFirst);
    expect(Number((await admin.query("SELECT count(*) AS n FROM agent_runs WHERE account_id = $1 AND dispatch_repo_id IS NOT NULL", [input.accountId])).rows[0].n)).toBe(1);
  });

  it("2b: startAgentRun gets the registry and the input's own inCreateTransaction (the same function, not a wrapper)", async () => {
    const w = world(async () => undefined);
    const inCreateTransaction = vi.fn(async () => undefined);
    const input = { ...(await newInput(`run-action:${randomUUID()}`)), inCreateTransaction };
    await w.starter.start(input);
    const call = vi.mocked(startAgentRun).mock.calls.at(-1)!;
    expect(call[1]).toBe(w.registry);
    expect((call[2] as StartAgentRunInput).inCreateTransaction).toBe(inCreateTransaction);
    expect(inCreateTransaction).toHaveBeenCalledTimes(1);
  });

  it("2c: the compute reservation is committed and visible to another connection the moment start resolves, before any hook fires", async () => {
    const w = world(async () => undefined);
    const input = await newInput(`run-action:${randomUUID()}`);
    const { runId } = await w.starter.start(input);
    // A pool of its own: a different session from anything the starter used, and nothing of ours is mid-transaction.
    const other = createPool(process.env.WORKER_DATABASE_URL!);
    try {
      const { rows } = await other.query("SELECT budget, state FROM spend_reservations WHERE run_id = $1 ORDER BY budget", [runId]);
      expect(rows).toEqual([
        { budget: "foreground_compute", state: "open" },
        { budget: "model", state: "open" },
      ]);
    } finally {
      await other.end();
    }
  });

  it("2d: on a running run it hands { runId, accountId, hookToken } to follow and awaits only its acceptance; the run is still running", async () => {
    const seen: FollowArgs[] = [];
    const w = world(async (args) => void seen.push(args));
    const input = await newInput(`run-action:${randomUUID()}`);
    const { runId } = await w.starter.start(input);
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]!).sort()).toEqual(["accountId", "hookToken", "runId", "watchdogMs"]);
    expect(seen[0]).toMatchObject({ runId, accountId: input.accountId });
    expect(seen[0]!.hookToken).toMatch(/^[0-9a-f-]{36}$/);
    expect((await admin.query("SELECT status FROM agent_runs WHERE id = $1", [runId])).rows[0].status).toBe("running");
  });

  it("L3: the follower's watchdog is the seat's own timeout plus a few minutes, never a fixed hours-long default; a run with no timeout is refused before anything starts", async () => {
    const seen: FollowArgs[] = [];
    const w = world(async (args) => void seen.push(args));
    const input = await newInput(`run-action:${randomUUID()}`);
    await w.starter.start({ ...input, timeoutMs: 10 * 60_000 });
    expect(seen[0]!.watchdogMs).toBe(10 * 60_000 + WATCHDOG_MARGIN_MS);
    expect(seen[0]!.watchdogMs).toBeLessThan(30 * 60_000);
    const bare = await newInput(`run-action:${randomUUID()}`);
    for (const bad of [undefined, null, Number.NaN, 0, -1, Number.POSITIVE_INFINITY, "600000"]) {
      await expect(w.starter.start({ ...bare, timeoutMs: bad as never }), String(bad)).rejects.toThrow("no positive timeoutMs");
    }
    expect(Number((await admin.query("SELECT count(*) AS n FROM agent_runs WHERE account_id = $1 AND dispatch_repo_id IS NOT NULL", [bare.accountId])).rows[0].n)).toBe(0);
  });

  it("a run refused at admit is returned as refused, with no follower", async () => {
    const follow = vi.fn(async () => undefined);
    const w = world(follow);
    const input = await newInput(`run-action:${randomUUID()}`, true);
    const started = await w.starter.start(input);
    // D#6 C12 A4: the target's own reason comes through unchanged, not a generic "refused_spend".
    expect(started).toMatchObject({ refused: "per_spawn_cap_exceeded" });
    expect(follow).not.toHaveBeenCalled();
  });

  /** A world whose registry has a runner target as well; `input`'s repo is switched to `runner_local`. */
  async function runnerWorld(visibility: "private" | "public" | "unknown", follow = vi.fn(async () => undefined)) {
    const harness = createSandboxTargetHarness(writerPool, []);
    const issuer = createFakeJobIssuer();
    const registry: ExecutionTargetRegistry = {
      sandbox: new SandboxTarget(harness.deps),
      runner_local: new RunnerTarget({ pool: writerPool, issuer, visibility: createFakeVisibility(visibility) }),
    };
    const starter = createRunStarter({ pool: writerPool, registry, follow });
    const input = await newInput(`run-action:${randomUUID()}`);
    await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [input.repoId]);
    return { harness, issuer, starter, input, follow };
  }

  it.each([
    ["public", "public_repo"],
    ["unknown", "repo_visibility_unknown"],
  ] as const)("D#6 C12 A4: a runner run refused because the repo reads %s comes back refused with %s, with no follower", async (visibility, reason) => {
    const w = await runnerWorld(visibility);
    expect(await w.starter.start(w.input)).toMatchObject({ refused: reason });
    expect(w.follow).not.toHaveBeenCalled();
    expect(w.issuer.calls).toHaveLength(0);
  });

  it("D#6 C12 section 2.1: a run queued for a runner is cancelled and the start fails: no follower waits on a hook that will never fire", async () => {
    const w = await runnerWorld("private");
    await expect(w.starter.start(w.input)).rejects.toThrow(QueuedRunNotSupportedError);
    expect(w.follow).not.toHaveBeenCalled();
    expect((await admin.query("SELECT status, runtime FROM agent_runs WHERE account_id = $1 AND dispatch_repo_id IS NOT NULL", [w.input.accountId])).rows).toEqual([{ status: "cancelled", runtime: "runner" }]);
    expect(w.harness.fakeSandbox.state.created).toHaveLength(0);
  });

  it("a follower that cannot be started stops the sandbox, fails the run, and surfaces the error", async () => {
    const boom = new Error("could not start the follower");
    const w = world(async () => {
      throw boom;
    });
    const input = await newInput(`run-action:${randomUUID()}`);
    await expect(w.starter.start(input)).rejects.toBe(boom);
    expect((await admin.query("SELECT status FROM agent_runs WHERE account_id = $1 AND dispatch_repo_id IS NOT NULL", [input.accountId])).rows).toEqual([{ status: "failed" }]);
    expect(w.harness.fakeSandbox.state.stopped.length).toBeGreaterThan(0);
  });

  it("8b/8c: structured lines when a run starts: a fixed event code and ids, never the hook token or the prompt", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "info").mockImplementation((line: unknown) => void lines.push(String(line)));
    let token = "";
    const w = world(async (args) => void (token = args.hookToken));
    const input = await newInput(`run-action:${randomUUID()}`);
    const { runId } = await w.starter.start(input);
    // The target logs `run.agent_started` (run id only) when the agent command exists; the starter's own line follows it.
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { event: "run.agent_started", run_id: runId },
      { event: "run.started", run_id: runId, account_id: input.accountId },
    ]);
    for (const line of lines) {
      expect(line).not.toContain(token);
      expect(line).not.toContain(input.prompt);
    }
  });

  // scripts/ops/ is a private overlay directory, absent from the public tree: the smoke report is loaded at run time.
  it.skipIf(!existsSync(SMOKE_REPORT_PATH))("8a/8c: the smoke report reads one run through the app login and prints only ids, timestamps and fixed codes; a superuser login is refused", async () => {
    const { smokeReport } = (await import(/* @vite-ignore */ SMOKE_REPORT_PATH)) as { smokeReport: (pool: Pool, accountId: string, runId: string) => Promise<string[]> };
    let token = "";
    const w = world(async (args) => void (token = args.hookToken));
    const input = await newInput(`run-action:${randomUUID()}`);
    const { runId } = await w.starter.start(input);
    const appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    try {
      const lines = await smokeReport(appPool, input.accountId, runId);
      const text = lines.join("\n");
      expect(lines[0]).toBe(`run ${runId} account ${input.accountId}`);
      expect(text).toContain("status running");
      expect(text).toMatch(/event \d+ run\.status_changed /);
      expect(text).toContain("reservation foreground_compute purpose preview open");
      expect(text).toContain("reservation model purpose preview open");
      expect(text).not.toContain(token);
      expect(text).not.toContain(input.prompt);
      expect(text).not.toContain(input.roleCard);
      // The report's transaction is read-only before it reads anything.
      const seen: string[] = [];
      const spy = {
        connect: async () => {
          const c = await appPool.connect();
          const q = c.query.bind(c) as (...a: unknown[]) => Promise<unknown>;
          (c as unknown as { query: unknown }).query = (...a: unknown[]) => (seen.push(String((a[0] as { text?: string } | string)?.hasOwnProperty?.("text") ? (a[0] as { text: string }).text : a[0])), q(...a));
          return c;
        },
      } as unknown as typeof appPool;
      await smokeReport(spy, input.accountId, runId);
      const ro = seen.findIndex((q) => /SET TRANSACTION READ ONLY/.test(q));
      expect(ro).toBeGreaterThanOrEqual(0);
      expect(seen.findIndex((q) => /FROM agent_runs/.test(q))).toBeGreaterThan(ro);
      // Another tenant's run is invisible under row-level security.
      const other = await newInput(`run-action:${randomUUID()}`);
      expect((await smokeReport(appPool, other.accountId, runId)).at(-1)).toBe("no such run for this account");
    } finally {
      await appPool.end();
    }
    await expect(smokeReport(adminPool, input.accountId, runId)).rejects.toThrow("refusing to read as a superuser");
  });
});
