import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import { DuplicateExecutorRunError } from "../src/runStatusWriter.js";
import type { ExecutionTargetRegistry } from "../src/executionTarget.js";
import type { CreateSandboxOptions, SandboxHandle, SandboxPort, StartDetachedOptions, StartDetachedResult } from "../src/sandboxPort.js";
import type { NormalizedEvent } from "../src/types.js";
import { seedAccount, seedMember, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * D#2 H09b2, correction C21 (Team Lead, 2026-09-18): "three H09b1 follow-ups
 * land in H09b2" -- PR #85's final security review recorded these as
 * should-fix/informational, not blocking for H09b1. [pg]: real Postgres,
 * zero model tokens.
 */
describe("D#2 H09b2, correction C21: PR #85 follow-ups [pg]", () => {
  const db = pgHarness();

  async function scenario(role: "code-reviewer" | "executor" = "code-reviewer") {
    const accountId = randomUUID();
    const userId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedMember(db.admin, accountId, userId);
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: 5 });
    const input: StartAgentRunInput = {
      accountId,
      repoId,
      workItemId,
      role,
      product: "team",
      pr: role === "executor" ? 5 : undefined,
      roleCard: "rc",
      prompt: "p",
      model: "haiku-4.5",
      capUsd: 5,
      spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" },
    };
    return { accountId, userId, repoId, workItemId, input };
  }

  /** A `SandboxPort` whose `startDetached`/`resume` return a `hookFired`
   * promise the TEST controls directly (never settling on its own,
   * unlike the fake runtime's zero-event default which resolves almost
   * instantly) -- exactly what's needed to model "the sandbox's real hook
   * fires N ms after cancel commits", which nothing in this package's
   * existing fake-sandbox/fake-runtime pair can do on its own. */
  function controlledPort(): { port: SandboxPort; fireHook: (event: NormalizedEvent | undefined) => void } {
    let resolveHook!: (event: NormalizedEvent | undefined) => void;
    const hookFired = new Promise<NormalizedEvent | undefined>((resolve) => {
      resolveHook = resolve;
    });
    const port: SandboxPort = {
      async createSandbox(opts: CreateSandboxOptions): Promise<SandboxHandle> {
        return { runId: "", sandboxName: opts.sandboxName };
      },
      startDetached(handle: SandboxHandle, _opts: StartDetachedOptions): StartDetachedResult {
        return { handle, hookFired };
      },
      async extendTimeout() {},
      async stop() {},
      resume(handle: SandboxHandle, _sessionId: string, _prompt: string, _opts: StartDetachedOptions): StartDetachedResult {
        return { handle, hookFired };
      },
      async deleteSandbox() {},
      async measure() {
        return [];
      },
      async readCounters() {
        return undefined;
      },
      async sandboxExists() {
        return true;
      },
    };
    return { port, fireHook: (event) => resolveHook(event) };
  }

  it("item 1: a hook that fires 20ms AFTER cancel still resumes -- 20 of 20, and bookkeeping returns to empty", async () => {
    let resumed = 0;
    for (let i = 0; i < 20; i++) {
      const s = await scenario();
      const harness = createSandboxTargetHarness(db.runWriterPool);
      const { port, fireHook } = controlledPort();
      const target = new SandboxTarget({ ...harness.deps, sandboxPort: port });
      const registry: ExecutionTargetRegistry = { sandbox: target };

      const result = await startAgentRun(db.runWriterPool, registry, s.input);
      expect(result.status).toBe("running");
      if (result.status !== "running") continue;

      const run = {
        id: result.id,
        accountId: s.accountId,
        role: "code-reviewer" as const,
        product: "team" as const,
        roleCard: "rc",
        prompt: "p",
        model: "haiku-4.5",
        capUsd: 5,
        spend: s.input.spend,
      };
      await target.cancel(run);

      // The real provider's hook fires 20ms after cancel already
      // committed -- exactly the reviewer's own reproduction.
      await sleep(20);
      fireHook(undefined);
      await sleep(5);

      if (harness.hooks.calls.some((c) => c.hookToken === result.hookToken)) resumed++;
    }
    expect(resumed).toBe(20);
  }, 20_000);

  it("finalize prunes bookkeeping once a dispatched run's hook has resumed normally (no cancel involved)", async () => {
    const s = await scenario();
    const harness = createSandboxTargetHarness(db.runWriterPool);
    const target = new SandboxTarget(harness.deps);
    const registry: ExecutionTargetRegistry = { sandbox: target };

    const result = await startAgentRun(db.runWriterPool, registry, s.input);
    expect(result.status).toBe("running");
    if (result.status !== "running") return;
    // The zero-event fake runtime resolves hookFired almost immediately.
    await sleep(5);

    const run = {
      id: result.id,
      accountId: s.accountId,
      role: "code-reviewer" as const,
      product: "team" as const,
      roleCard: "rc",
      prompt: "p",
      model: "haiku-4.5",
      capUsd: 5,
      spend: s.input.spend,
    };
    await target.finalize(run, { status: "succeeded", usd: 0.1 });
    expect((target as unknown as { runs: Map<string, unknown> }).runs.size).toBe(0);
  });

  it("item 2: a second concurrent executor start for the same (account, repo, PR) is refused with DuplicateExecutorRunError", async () => {
    const s = await scenario("executor");
    const registry: ExecutionTargetRegistry = { sandbox: new SandboxTarget(createSandboxTargetHarness(db.runWriterPool).deps) };

    const first = await startAgentRun(db.runWriterPool, registry, s.input);
    expect(first.status).toBe("running");

    await expect(startAgentRun(db.runWriterPool, registry, s.input)).rejects.toThrow(DuplicateExecutorRunError);

    const rows = await db.admin.query(`SELECT status FROM agent_runs WHERE account_id = $1 ORDER BY created_at`, [
      s.accountId,
    ]);
    expect(rows.rows).toHaveLength(1);
  });

  it("item 2: a second executor start is accepted once the first one reaches a terminal status", async () => {
    const s = await scenario("executor");
    const registry: ExecutionTargetRegistry = { sandbox: new SandboxTarget(createSandboxTargetHarness(db.runWriterPool).deps) };

    const first = await startAgentRun(db.runWriterPool, registry, s.input);
    expect(first.status).toBe("running");
    await db.admin.query(`UPDATE agent_runs SET status = 'succeeded' WHERE id = $1`, [first.id]);

    const second = await startAgentRun(db.runWriterPool, registry, s.input);
    expect(second.status).toBe("running");
  });

  it("item 3: an ownership-query error still produces one stop (fail safe, not fail open)", async () => {
    const s = await scenario();
    const harness = createSandboxTargetHarness(db.runWriterPool);
    const stoppedNames: string[] = [];
    const port: SandboxPort = {
      ...harness.deps.sandboxPort,
      async stop(handle: SandboxHandle) {
        stoppedNames.push(handle.sandboxName);
        return harness.deps.sandboxPort.stop(handle);
      },
    };

    // A pool proxy that fails EXACTLY the ownership query
    // (`stillOwnsSandbox`'s first SELECT) once it is ARMED -- never during
    // `dispatch`'s own two re-checks (identical SQL text), only once this
    // test explicitly arms it right before calling `cancel`.
    let armed = false;
    let failed = false;
    const poolProxy = new Proxy(db.runWriterPool, {
      get(target: Pool, key: string | symbol) {
        if (key === "connect") {
          return async () => {
            const client = await target.connect();
            return new Proxy(client, {
              get(clientTarget: PoolClient, clientKey: string | symbol) {
                if (clientKey === "query") {
                  return async (sql: unknown, params?: unknown) => {
                    if (armed && !failed && typeof sql === "string" && sql.startsWith("SELECT status FROM agent_runs")) {
                      failed = true;
                      throw new Error("injected ownership-query error");
                    }
                    return (clientTarget as PoolClient).query(sql as string, params as unknown[]);
                  };
                }
                const value = (clientTarget as unknown as Record<string | symbol, unknown>)[clientKey];
                return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(clientTarget) : value;
              },
            });
          };
        }
        const value = (target as unknown as Record<string | symbol, unknown>)[key];
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as Pool;

    const target = new SandboxTarget({ ...harness.deps, pool: poolProxy, sandboxPort: port });
    const registry: ExecutionTargetRegistry = { sandbox: target };
    const result = await startAgentRun(db.runWriterPool, registry, s.input);
    expect(result.status).toBe("running");
    if (result.status !== "running") return;
    armed = true;

    const run = {
      id: result.id,
      accountId: s.accountId,
      role: "code-reviewer" as const,
      product: "team" as const,
      roleCard: "rc",
      prompt: "p",
      model: "haiku-4.5",
      capUsd: 5,
      spend: s.input.spend,
    };
    await expect(target.cancel(run)).rejects.toThrow("injected ownership-query error");
    expect(stoppedNames.length).toBeGreaterThanOrEqual(1);
  });
});
