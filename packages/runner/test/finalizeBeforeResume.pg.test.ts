import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { SandboxTarget, type HookResumePort } from "../src/targets/sandboxTarget.js";
import { startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import type { HookResult } from "../src/executionTarget.js";
import type { NormalizedEvent } from "../src/types.js";
import { cancelRun } from "../src/cancelRun.js";
import { seedAccount, seedMember, seedRepo } from "./helpers/seed.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";

/**
 * D#2 H14c-3-3a-3 (P2) [pg]: the target finalizes a finished run itself, then wakes the hook with { runId, status } only.
 * The agent's envelope reaches `agent_runs` and nowhere else.
 */
describe("the target finalizes before it resumes the hook [pg]", () => {
  const db = pgHarness();
  const SECRET = `envelope-marker-${randomUUID()}`;
  const result: NormalizedEvent = { runId: "r", role: "code-reviewer", seq: 2, type: "result", ts: new Date().toISOString(), costUsd: 0.4, agentOutput: { note: SECRET } };

  async function input(): Promise<StartAgentRunInput> {
    const accountId = randomUUID();
    const repoId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    return { accountId, repoId, role: "code-reviewer", product: "team", roleCard: "c", prompt: "p", model: "haiku-4.5", capUsd: 5, spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" } };
  }
  const statusOf = async (runId: string) => (await db.admin.query("SELECT status FROM agent_runs WHERE id = $1", [runId])).rows[0].status as string;

  function build(hooks: HookResumePort) {
    const harness = createSandboxTargetHarness(db.runWriterPool, [result]);
    const target = new SandboxTarget({ ...harness.deps, finalizeBeforeResume: true, hooks });
    return { harness, target };
  }
  const settle = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 25));
  };

  it("the run is terminal when the hook wakes, the payload is exactly { runId, status }, and the envelope is in agent_runs only", async () => {
    const seen: { token: string; result: HookResult; statusThen: string }[] = [];
    const { target } = build({
      resume: async (token, r) => void seen.push({ token, result: r, statusThen: await statusOf(r.runId) }),
    });
    const i = await input();
    const started = await startAgentRun(db.runWriterPool, { sandbox: target }, i);
    if (started.status !== "running") throw new Error("setup");
    await settle(() => seen.length > 0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.token).toBe(started.hookToken);
    expect(seen[0]!.statusThen).toBe("succeeded"); // finalized BEFORE the wake-up
    expect(Object.keys(seen[0]!.result).sort()).toEqual(["runId", "status"]);
    expect(seen[0]!.result).toEqual({ runId: started.id, status: "succeeded" });
    expect(JSON.stringify(seen)).not.toContain(SECRET);
    // The envelope is in the run row...
    const row = await db.admin.query("SELECT envelope FROM agent_runs WHERE id = $1", [started.id]);
    expect(JSON.stringify(row.rows[0].envelope)).toContain(SECRET);
    // ... and in no event the customer can read.
    const events = await db.admin.query("SELECT kind, payload FROM run_events WHERE run_id = $1", [started.id]);
    expect(events.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(events.rows)).not.toContain(SECRET);
    const finals = await db.admin.query("SELECT count(*)::int AS n FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' AND payload->>'to' = 'succeeded'", [started.id]);
    expect(finals.rows[0].n).toBe(1);
  });

  it("if finalize fails the hook is NOT resumed (the run is still running; the watchdog ends it) and nothing escapes", async () => {
    const resumed: HookResult[] = [];
    const harness = createSandboxTargetHarness(db.runWriterPool, [result]);
    class FailingFinalize extends SandboxTarget {
      override async finalize(): Promise<never> {
        throw new Error("finalize failed with a secret in its text");
      }
    }
    const target = new FailingFinalize({ ...harness.deps, finalizeBeforeResume: true, hooks: { resume: async (_t, r) => void resumed.push(r) } });
    const i = await input();
    const started = await startAgentRun(db.runWriterPool, { sandbox: target }, i);
    if (started.status !== "running") throw new Error("setup");
    await new Promise((r) => setTimeout(r, 400));
    expect(await statusOf(started.id)).toBe("running");
    expect(resumed).toEqual([]);
  });

  it("a run cancelled before its stream ends is not finalized again; the hook still wakes", async () => {
    const resumed: HookResult[] = [];
    const gate = { open: () => {} };
    const harness = createSandboxTargetHarness(db.runWriterPool, [result]);
    const real = harness.deps.sandboxPort;
    const held = new Promise<void>((resolve) => (gate.open = resolve));
    let finalizeCalls = 0;
    class Counting extends SandboxTarget {
      override async finalize(...a: Parameters<SandboxTarget["finalize"]>): ReturnType<SandboxTarget["finalize"]> {
        finalizeCalls++;
        return super.finalize(...a);
      }
    }
    const target = new Counting({
      ...harness.deps,
      finalizeBeforeResume: true,
      hooks: { resume: async (_t, r) => void resumed.push(r) },
      sandboxPort: { ...real, startDetached: (h, o) => ({ ...real.startDetached(h, o), hookFired: held.then(() => real.startDetached(h, o).hookFired) }) },
    });
    const i = await input();
    const started = await startAgentRun(db.runWriterPool, { sandbox: target }, i);
    if (started.status !== "running") throw new Error("setup");
    const userId = randomUUID();
    await seedMember(db.admin, i.accountId, userId);
    await cancelRun({ pool: db.runWriterPool, principal: { accountId: i.accountId, userId } }, started.id, { sandbox: target });
    gate.open();
    await settle(() => resumed.length > 0);
    expect(await statusOf(started.id)).toBe("cancelled");
    expect(resumed).toHaveLength(1);
    expect(finalizeCalls).toBe(0); // finalize was not even called, not just harmless
    const finals = await db.admin.query("SELECT count(*)::int AS n FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' AND payload->>'to' IN ('succeeded','failed')", [started.id]);
    expect(finals.rows[0].n).toBe(0);
  });

  it("the abort branch: a finalize that throws is contained (no unhandled rejection), the run is left running, the hook is not resumed, and the log line is a fixed code and the run id", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => void unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    const warned: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void warned.push(a.map(String).join(" ")));
    try {
      const resumed: HookResult[] = [];
      const harness = createSandboxTargetHarness(db.runWriterPool, [result]);
      const real = harness.deps.sandboxPort;
      class FailingFinalize extends SandboxTarget {
        override async finalize(): Promise<never> {
          throw new Error("finalize failed: model said sk-secret-text");
        }
      }
      const target = new FailingFinalize({
        ...harness.deps,
        finalizeBeforeResume: true,
        hooks: { resume: async (_t, r) => void resumed.push(r) },
        // The stream aborts: this is the branch that used to end in an unhandled rejection.
        sandboxPort: { ...real, startDetached: (h, o) => ({ ...real.startDetached(h, o), hookFired: Promise.reject(new Error("stream aborted")) }) },
      });
      const i = await input();
      const started = await startAgentRun(db.runWriterPool, { sandbox: target }, i);
      if (started.status !== "running") throw new Error("setup");
      await new Promise((r) => setTimeout(r, 500));
      expect(unhandled).toEqual([]);
      expect(await statusOf(started.id)).toBe("running");
      expect(resumed).toEqual([]);
      expect(warned).toEqual([JSON.stringify({ event: "run.finalize_or_resume_failed", run_id: started.id })]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      vi.restoreAllMocks();
    }
  });

  it("the default is pinned: a target built with NO flag finalizes before it resumes the hook", async () => {
    const seen: string[] = [];
    const harness = createSandboxTargetHarness(db.runWriterPool, [result]);
    const { finalizeBeforeResume: _off, ...withoutFlag } = harness.deps; // the harness turns it off; take that away
    const target = new SandboxTarget({
      ...withoutFlag,
      hooks: { resume: async (_t, r) => void seen.push(`${r.status}:${await statusOf(r.runId)}:${Object.keys(r).sort().join("+")}`) },
    });
    const started = await startAgentRun(db.runWriterPool, { sandbox: target }, await input());
    if (started.status !== "running") throw new Error("setup");
    await settle(() => seen.length > 0);
    expect(seen).toEqual(["succeeded:succeeded:runId+status"]);
  });

  it("nothing but the test harnesses ever turns the flag off: no non-test source under apps or packages mentions it outside the target", () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (["node_modules", ".next", "dist", "test", "tests"].includes(name)) continue;
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\./.test(name) && readFileSync(full, "utf8").includes("finalizeBeforeResume")) hits.push(path.relative(root, full));
      }
    };
    for (const top of ["apps", "packages"]) walk(path.join(root, top));
    expect(hits).toEqual(["packages/runner/src/targets/sandboxTarget.ts"]);
  });
});
