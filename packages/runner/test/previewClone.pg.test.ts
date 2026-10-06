import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SandboxPort, StartDetachedOptions } from "../src/sandboxPort.js";
import { DispatchFailedError } from "../src/executionTarget.js";
import { CloneError, PREVIEW_WORKDIR } from "../src/repoClone.js";
import { startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedAccount, seedMember, seedRepo, seedWorkItem } from "./helpers/seed.js";

/**
 * D#2 PREVIEW-RUNNER-EVENTS: a preview run is started with a repository to clone and a workdir. The clone itself is the
 * port's (see vercelSandboxPort.test.ts); this is what the target does with the outcome. [pg]
 */
describe("preview clone through the target [pg]", () => {
  const db = pgHarness();

  async function scenario(extra: Partial<StartAgentRunInput> = {}) {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedMember(db.admin, accountId, randomUUID());
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: 5 });
    const input: StartAgentRunInput = {
      accountId,
      repoId,
      workItemId,
      role: "code-reviewer",
      product: "team",
      roleCard: "rc",
      prompt: "p",
      model: "haiku-4.5",
      capUsd: 5,
      workdir: PREVIEW_WORKDIR,
      cloneRepo: { owner: "acme", name: "widgets" },
      spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" },
      ...extra,
    };
    return input;
  }

  function target(wrap: (port: SandboxPort, seen: StartDetachedOptions[]) => SandboxPort) {
    const h = createSandboxTargetHarness(db.runWriterPool);
    const seen: StartDetachedOptions[] = [];
    return { seen, target: new SandboxTarget({ ...h.deps, sandboxPort: wrap(h.deps.sandboxPort, seen) }) };
  }

  const reasonOf = async (runId: string) =>
    (await db.admin.query(`SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' AND payload->>'to' = 'failed'`, [runId])).rows[0]?.payload.failureReason as string | undefined;
  const stagesOf = async (runId: string) =>
    (await db.admin.query(`SELECT payload->>'stage' AS stage FROM run_events WHERE run_id = $1 AND kind = 'run.stage' ORDER BY seq`, [runId])).rows.map((r: { stage: string }) => r.stage);

  it("hands the repository and the workdir to the launch, and records the sandbox_ready and cloned stages the launch reports", async () => {
    const input = await scenario();
    const t = target((port, seen) => ({
      ...port,
      startDetached(handle, opts) {
        seen.push(opts);
        void opts.onStage?.("sandbox_ready");
        void opts.onStage?.("cloned");
        return port.startDetached(handle, opts);
      },
    }));
    const started = await startAgentRun(db.runWriterPool, { sandbox: t.target }, input);
    if (started.status !== "running") throw new Error("run did not start");
    expect(t.seen[0]).toMatchObject({ workdir: PREVIEW_WORKDIR, clone: { owner: "acme", name: "widgets" } });
    // The recorder's writes run behind the call; the run's finalize waits for them.
    await new Promise((r) => setTimeout(r, 300));
    expect(await stagesOf(started.id)).toEqual(["sandbox_ready", "cloned"]);
  });

  it("an ordinary run carries no clone", async () => {
    const input = await scenario({ workdir: undefined, cloneRepo: undefined });
    const t = target((port, seen) => ({ ...port, startDetached: (handle, opts) => (seen.push(opts), port.startDetached(handle, opts)) }));
    await startAgentRun(db.runWriterPool, { sandbox: t.target }, input);
    expect(t.seen[0]).not.toHaveProperty("clone");
  });

  it("a failed clone logs its exit code and redacted output tail (operator log only); the run's failure reason stays the fixed code", async () => {
    const input = await scenario();
    const t = target((port) => ({
      ...port,
      startDetached(handle) {
        const failing = Promise.reject(new CloneError("clone_failed", { exitCode: 128, tail: "fatal: repository not found" }));
        failing.catch(() => undefined);
        return { handle, hookFired: failing, launched: failing };
      },
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const failure = await startAgentRun(db.runWriterPool, { sandbox: t.target }, input).catch((e: unknown) => e);
      const runId = (failure as DispatchFailedError).runId;
      const logged = warn.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>).find((l) => l.event === "run.agent_start_failed");
      expect(logged).toMatchObject({ run_id: runId, reason: "failed", clone_reason: "clone_failed", clone_exit_code: 128, clone_output_tail: "fatal: repository not found" });
      expect(await reasonOf(runId)).toBe("clone_failed");
      expect(JSON.stringify((await db.admin.query(`SELECT payload FROM run_events WHERE run_id = $1`, [runId])).rows)).not.toContain("repository not found");
    } finally {
      warn.mockRestore();
    }
  });

  it.each([["clone_failed"], ["clone_too_large"]] as const)("a launch that fails with %s fails the run with that reason", async (reason) => {
    const input = await scenario();
    const t = target((port) => ({
      ...port,
      startDetached(handle) {
        const failing = Promise.reject(new CloneError(reason));
        failing.catch(() => undefined);
        return { handle, hookFired: failing, launched: failing };
      },
    }));
    const failure = await startAgentRun(db.runWriterPool, { sandbox: t.target }, input).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(DispatchFailedError);
    expect((failure as DispatchFailedError).failureReason).toBe(reason);
    const runId = (failure as DispatchFailedError).runId;
    expect((await db.admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [runId])).rows[0].status).toBe("failed");
    expect(await reasonOf(runId)).toBe(reason);
  });
});
