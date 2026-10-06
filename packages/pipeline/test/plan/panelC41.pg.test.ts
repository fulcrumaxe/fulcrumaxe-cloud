import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "@fx/core/src/tenancy/errors.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { seedAccount } from "../build/helpers/seed.js";
import { runPanel, type PanelDeps, type PanelRunner } from "../../src/plan/panel.js";
import { checkPanelRunnerContract } from "../../src/plan/runnerContract.js";
import { discussingItem, FixtureRunner, seedRun } from "./helpers/panelFixtures.js";

// Lets a test make the store's signed-comment write throw, keyed on the comment text.
const hooks: { error: (body: string) => Error | null } = { error: () => null };
vi.mock("@fx/discussions/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fx/discussions/server")>();
  return {
    ...actual,
    postAgentComment: vi.fn(async (...args: Parameters<typeof actual.postAgentComment>) => {
      const err = hooks.error(args[1].body);
      if (err) throw err;
      return actual.postAgentComment(...args);
    }),
  };
});

const h = pgHarness();
beforeEach(() => {
  hooks.error = () => null;
});

const TEXT = { title: "Rotate the credentials store", body: "the secret token", category: "critical" as const };

async function tenant(): Promise<string> {
  const id = randomUUID();
  await seedAccount(h.admin, id);
  return id;
}
const deps = (accountId: string, runner: PanelRunner, timeoutMs?: number): PanelDeps => ({
  pool: h.runWriterPool,
  accountId,
  runner,
  ...(timeoutMs === undefined ? {} : { timeoutMs }),
});
const signedRoles = async (discussionId: string): Promise<string[]> =>
  (await h.admin.query<{ role: string }>(`SELECT role FROM discussion_comments WHERE discussion_id = $1 AND system_signed = true ORDER BY role`, [discussionId])).rows.map((r) => r.role);

describe("C41 H15c-MISS 3: an unexpected error fails the step; a store refusal is a missing seat", () => {
  it("a plain Error from postAgentComment (a transient database failure) rejects runPanel: nothing is recorded as DID NOT POST", async () => {
    const accountId = await tenant();
    const { workItemId } = await discussingItem(h.runWriterPool, accountId, TEXT);
    const runner = new FixtureRunner(h.admin, accountId);
    runner.script["security-expert"] = { output: () => ({ comment: "BOOM connection reset" }) };
    hooks.error = (body) => (body.includes("BOOM") ? new Error("connection reset by peer") : null);
    await expect(runPanel(deps(accountId, runner), { workItemId })).rejects.toThrow("connection reset by peer");
  });

  it("a store ForbiddenError is post_refused: the seat is missing and the panel completes", async () => {
    const accountId = await tenant();
    const { workItemId } = await discussingItem(h.runWriterPool, accountId, TEXT);
    const runner = new FixtureRunner(h.admin, accountId);
    runner.script["security-expert"] = { output: () => ({ comment: "FORBID me" }) };
    hooks.error = (body) => (body.includes("FORBID") ? new ForbiddenError("nope") : null);
    const out = await runPanel(deps(accountId, runner), { workItemId });
    if (out.status !== "completed") throw new Error("unreachable");
    expect(out.round1.find((s) => s.role === "security-expert")).toEqual({ role: "security-expert", status: "missing", reason: "post_refused" });
    expect(out.missingRoles).toEqual(["security-expert"]);
    expect(out.missingReasons).toEqual({ "security-expert": "post_refused" });
  });
});

describe("C41 H15c-MISS 4 and status/completeness agreement", () => {
  it("a seat handed a run of the wrong role is missing in round1, and its challenge:true does not start Round 2", async () => {
    const accountId = await tenant();
    const { workItemId, discussionId } = await discussingItem(h.runWriterPool, accountId, TEXT);
    const runner = new FixtureRunner(h.admin, accountId);
    runner.script["cost-analyst"] = { runRole: "executor", output: () => ({ comment: "I insist.", challenge: true, stance: "disagree" }) };
    const out = await runPanel(deps(accountId, runner), { workItemId });
    if (out.status !== "completed") throw new Error("unreachable");
    expect(out.round1.find((s) => s.role === "cost-analyst")).toEqual({ role: "cost-analyst", status: "missing", reason: "wrong_run" });
    expect(out.challengeTrigger).toBeNull();
    expect(out.round2).toEqual([]);
    expect(out.round2Ran).toBe(false);
    expect(out.missingRoles).toEqual(["cost-analyst"]);
    expect(await signedRoles(discussionId)).toEqual(["security-expert", "technical-architect"]);
  });

  it("a run handed to two seats backs only the first; the other is missing (wrong_run), never posted", async () => {
    const accountId = await tenant();
    const { workItemId, discussionId } = await discussingItem(h.runWriterPool, accountId, TEXT);
    // One run whose role is cost-analyst is returned for BOTH the cost-analyst and the security-expert seat.
    const shared = await seedRun(h.admin, accountId, workItemId, "cost-analyst");
    const runner = new FixtureRunner(h.admin, accountId);
    runner.script["cost-analyst"] = { runId: shared };
    runner.script["security-expert"] = { runId: shared };
    const out = await runPanel(deps(accountId, runner), { workItemId });
    if (out.status !== "completed") throw new Error("unreachable");
    // security-expert is refused on role alone; the shared run backs cost-analyst exactly once.
    expect(out.round1.find((s) => s.role === "security-expert")).toMatchObject({ status: "missing", reason: "wrong_run" });
    expect(out.round1.find((s) => s.role === "cost-analyst")).toEqual({ role: "cost-analyst", status: "posted" });
    expect(await signedRoles(discussionId)).toEqual(["cost-analyst", "technical-architect"]);
  });

  it("the same run handed to two seats of the SAME role across rounds is refused in round 2", async () => {
    const accountId = await tenant();
    const { workItemId } = await discussingItem(h.runWriterPool, accountId, TEXT);
    const runner = new FixtureRunner(h.admin, accountId);
    const r1 = await seedRun(h.admin, accountId, workItemId, "technical-architect");
    runner.script["technical-architect"] = { runId: r1, output: () => ({ comment: "Challenge!", challenge: true }) };
    const out = await runPanel(deps(accountId, runner), { workItemId });
    if (out.status !== "completed") throw new Error("unreachable");
    expect(out.round2Ran).toBe(true);
    expect(out.round2.find((s) => s.role === "technical-architect")).toMatchObject({ status: "missing", reason: "wrong_run" });
    // Round 1's signed row still stands, so the role is not missing overall.
    expect(out.missingRoles).toEqual([]);
  });
});

describe("C41 section 4: the runner is cancellable and its contract is testable", () => {
  it("the panel aborts the seat's signal when the round deadline passes, and no signed row is written for it", async () => {
    const accountId = await tenant();
    const { workItemId, discussionId } = await discussingItem(h.runWriterPool, accountId, TEXT);
    const runner = new FixtureRunner(h.admin, accountId);
    runner.script["cost-analyst"] = { hang: true };
    const out = await runPanel(deps(accountId, runner, 150), { workItemId });
    if (out.status !== "completed") throw new Error("unreachable");
    expect(out.round1.find((s) => s.role === "cost-analyst")).toEqual({ role: "cost-analyst", status: "missing", reason: "timed_out" });
    expect(runner.aborted).toEqual([`panel:${discussionId}:r1:cost-analyst`]);
    expect(await signedRoles(discussionId)).toEqual(["security-expert", "technical-architect"]);
  });

  it("D#6 C12 A3: a seat whose run waits pending (paused clock) is not timed out by that wait, and is judged on its own clock, not another seat's", async () => {
    const accountId = await tenant();
    const { workItemId, discussionId } = await discussingItem(h.runWriterPool, accountId, TEXT);
    const fixture = new FixtureRunner(h.admin, accountId);
    const direct: PanelRunner = {
      runSeat: async (req, signal, clock) => {
        if (req.role === "cost-analyst") {
          // Pending for 600 ms: four times the 150 ms deadline, with the clock stopped. Then the run works and answers.
          clock?.pause();
          await new Promise((resolve) => setTimeout(resolve, 600));
          clock?.resume();
        }
        if (req.role === "security-expert") {
          // Works (clock running) for longer than the deadline: this one IS timed out.
          await new Promise((resolve) => setTimeout(resolve, 600));
        }
        return fixture.runSeat(req, signal);
      },
    };
    const out = await runPanel(deps(accountId, direct, 150), { workItemId });
    if (out.status !== "completed") throw new Error("unreachable");
    expect(out.round1.find((s) => s.role === "cost-analyst")).toEqual({ role: "cost-analyst", status: "posted" });
    expect(out.round1.find((s) => s.role === "security-expert")).toEqual({ role: "security-expert", status: "missing", reason: "timed_out" });
    expect(await signedRoles(discussionId)).toContain("cost-analyst");
  });

  it("CODE SHOULD-2: a runner that rejects synchronously in its abort listener is timed_out, not runner_failed; a genuine failure still is runner_failed", async () => {
    const accountId = await tenant();
    const { workItemId } = await discussingItem(h.runWriterPool, accountId, TEXT);
    const fixture = new FixtureRunner(h.admin, accountId);
    const direct: PanelRunner = {
      // Not an async function: the rejection is queued inside abort(), before the deadline promise resolves.
      runSeat: (req, signal) =>
        req.role === "cost-analyst"
          ? new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
          : req.role === "security-expert"
            ? Promise.reject(new Error("exploded"))
            : fixture.runSeat(req, signal),
    };
    const out = await runPanel(deps(accountId, direct, 150), { workItemId });
    if (out.status !== "completed") throw new Error("unreachable");
    expect(out.round1.find((s) => s.role === "cost-analyst")).toEqual({ role: "cost-analyst", status: "missing", reason: "timed_out" });
    expect(out.round1.find((s) => s.role === "security-expert")).toEqual({ role: "security-expert", status: "missing", reason: "runner_failed" });
    expect(out.missingReasons).toEqual({ "cost-analyst": "timed_out", "security-expert": "runner_failed" });
  });

  it("a completed round aborts nothing", async () => {
    const accountId = await tenant();
    const { workItemId } = await discussingItem(h.runWriterPool, accountId, TEXT);
    const runner = new FixtureRunner(h.admin, accountId);
    await runPanel(deps(accountId, runner, 5000), { workItemId });
    expect(runner.aborted).toEqual([]);
  });

  it("the contract helper passes the fixture runner (sequential, concurrent, different key, one start each)", async () => {
    const accountId = await tenant();
    const { workItemId, discussionId } = await discussingItem(h.runWriterPool, accountId, TEXT);
    const runner = new FixtureRunner(h.admin, accountId);
    const violations = await checkPanelRunnerContract(runner, {
      request: (idempotencyKey) => ({ workItemId, discussionId, role: "technical-architect", round: 1, prompt: "p", idempotencyKey }),
      startedRuns: async (key) => runner.started.get(key) ?? 0,
    });
    expect(violations).toEqual([]);
  });

  it("the helper can fail: a runner that starts a fresh run per call violates all of it", async () => {
    const accountId = await tenant();
    const { workItemId, discussionId } = await discussingItem(h.runWriterPool, accountId, TEXT);
    const starts = new Map<string, number>();
    let tail: Promise<unknown> = Promise.resolve(); // the admin connection is a single client
    const leaky: PanelRunner = {
      runSeat: (req) => {
        starts.set(req.idempotencyKey, (starts.get(req.idempotencyKey) ?? 0) + 1);
        const next = tail.then(() => seedRun(h.admin, accountId, workItemId, "technical-architect"));
        tail = next;
        return next.then((agentRunId) => ({ agentRunId, agentOutput: { comment: "x" } }));
      },
    };
    const violations = await checkPanelRunnerContract(leaky, {
      request: (idempotencyKey) => ({ workItemId, discussionId, role: "technical-architect", round: 1, prompt: "p", idempotencyKey }),
      startedRuns: async (key) => starts.get(key) ?? 0,
    });
    expect(violations).toEqual(
      expect.arrayContaining([
        "two sequential calls with one key returned different runs",
        "five concurrent calls with one key returned more than one run",
        "sequential calls with one key started more than one run",
      ]),
    );
  });

  it("the helper flags a runner that never settles for an aborted signal", async () => {
    const accountId = await tenant();
    const { workItemId, discussionId } = await discussingItem(h.runWriterPool, accountId, TEXT);
    const run = await seedRun(h.admin, accountId, workItemId, "technical-architect");
    const stuck: PanelRunner = {
      runSeat: (req) => (req.idempotencyKey.endsWith(":aborted") ? new Promise(() => undefined) : Promise.resolve({ agentRunId: `${req.idempotencyKey}-${run}`, agentOutput: {} })),
    };
    const violations = await checkPanelRunnerContract(stuck, {
      request: (idempotencyKey) => ({ workItemId, discussionId, role: "technical-architect", round: 1, prompt: "p", idempotencyKey }),
      startedRuns: async () => 1,
    });
    expect(violations).toContain("runSeat did not settle for an already-aborted signal");
  });

  it("SECURITY SHOULD-2: the run-count probe is required: a runner that starts a run per call but returns cached ids fails", async () => {
    const accountId = await tenant();
    const { workItemId, discussionId } = await discussingItem(h.runWriterPool, accountId, TEXT);
    const byKey = new Map<string, string>();
    const starts = new Map<string, number>();
    const run = await seedRun(h.admin, accountId, workItemId, "technical-architect");
    const cachedIdsButPaysEveryCall: PanelRunner = {
      runSeat: async (req) => {
        starts.set(req.idempotencyKey, (starts.get(req.idempotencyKey) ?? 0) + 1); // every call starts (and pays for) a run
        const id = byKey.get(req.idempotencyKey) ?? `${req.idempotencyKey}:${run}`;
        byKey.set(req.idempotencyKey, id);
        return { agentRunId: id, agentOutput: { comment: "x" } };
      },
    };
    const request = (idempotencyKey: string) => ({ workItemId, discussionId, role: "technical-architect" as const, round: 1 as const, prompt: "p", idempotencyKey });
    // Without a probe the helper cannot tell, so it reports a violation instead of passing.
    const noProbe = await checkPanelRunnerContract(cachedIdsButPaysEveryCall, { request } as never);
    expect(noProbe.some((v) => v.includes("startedRuns"))).toBe(true);
    // With the probe it is caught by the counts, although every returned id is stable.
    const withProbe = await checkPanelRunnerContract(cachedIdsButPaysEveryCall, { request, startedRuns: async (k) => starts.get(k) ?? 0 });
    expect(withProbe).toEqual(
      expect.arrayContaining(["sequential calls with one key started more than one run", "concurrent calls with one key started more than one run"]),
    );
    expect(withProbe).not.toContain("two sequential calls with one key returned different runs");
  });
});
