import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NormalizedEvent } from "@fulcrumaxe/runner-protocol";
import { cleanEnv } from "../src/job/cleanEnv.js";
import { createMemoryLedger, runJob, type RunJobDeps, type RunnableJob, type SessionPlan } from "../src/job/runJob.js";
import type { SandboxHandle, SandboxPort, StartDetachedOptions, StartDetachedResult } from "../src/sandbox/port.js";
import { PACKAGE_DIR } from "./helpers/srcFiles.js";
import { sampleJob } from "./helpers/sampleJob.js";

const RUN = "11111111-1111-4111-8111-111111111111";
const result = (over: Partial<NormalizedEvent> = {}): NormalizedEvent => ({ runId: RUN, role: "executor", seq: 1, type: "result", ts: "2026-10-08T00:00:00.000Z", sessionId: "sess-9", agentOutput: { verdict: "done" }, ...over });

function jobWith(over: Partial<RunnableJob> = {}): RunnableJob {
  return { ...sampleJob(), job_id: "22222222-2222-4222-8222-222222222222", run_id: RUN, continues: null, model_hint: null, ...over };
}

/** A port that records every call and ends each run the way the test says. */
function recordingPort(end: () => Promise<NormalizedEvent | undefined> = async () => result()) {
  const calls: string[] = [];
  const started: StartDetachedOptions[] = [];
  const handle: SandboxHandle = { runId: "", sandboxName: `rn-${RUN}` };
  const launch = (opts: StartDetachedOptions): StartDetachedResult => {
    started.push(opts);
    return { handle, hookFired: end() };
  };
  const port: SandboxPort = {
    async createSandbox(opts) {
      calls.push(`create:${opts.sandboxName}:${opts.timeoutMs}`);
      return handle;
    },
    startDetached: (_h, opts) => (calls.push("start"), launch(opts)),
    resume: (_h, sessionId, _prompt, opts) => (calls.push(`resume:${sessionId}`), launch(opts)),
    async extendTimeout() {},
    async stop() {
      calls.push("stop");
    },
    async deleteSandbox() {
      calls.push("delete");
    },
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
  return { port, calls, started };
}

function depsFor(port: SandboxPort, over: Partial<RunJobDeps> = {}) {
  const created: string[] = [];
  const discarded: string[] = [];
  const deps: RunJobDeps = {
    sandbox: port,
    workspaces: {
      async create(runId) {
        created.push(runId);
        return `/work/${runId}`;
      },
      owns: (dir) => path.dirname(path.resolve(dir)) === "/work" && dir === path.resolve(dir),
      async discard(dir) {
        discarded.push(dir);
      },
    },
    ledger: createMemoryLedger(),
    credentials: { mode: "subscription" },
    planSession: (): SessionPlan => ({ kind: "fresh", branch: null }),
    defaultModel: "sonnet",
    ...over,
  };
  return { deps, created, discarded };
}

afterEach(() => vi.useRealTimers());

describe("runJob: one path through the port", () => {
  it("creates, starts, waits, then stops and deletes; the run reports done with the session and the envelope", async () => {
    const { port, calls, started } = recordingPort();
    const { deps, created } = depsFor(port);
    const out = await runJob(jobWith(), deps);
    expect(out).toEqual({ status: "done", workspace: `/work/${RUN}`, sessionId: "sess-9", agentOutput: { verdict: "done" } });
    expect(calls).toEqual([`create:rn-${RUN}:${2 * 60 * 60_000 + 10 * 60_000}`, "start", "stop", "delete"]);
    expect(created).toEqual([RUN]);
    expect(started[0]).toMatchObject({ runId: RUN, role: "executor", model: "sonnet", workdir: `/work/${RUN}`, networkPolicy: [{ host: "api.anthropic.com", purpose: "model" }] });
    expect(started[0]!.env).toEqual(cleanEnv({ mode: "subscription" }));
    expect(started[0]!.prompt).toContain("Implement the change.");
  });

  it("hands the sandbox the clean environment with the configured extra PATH directories", async () => {
    const { port, started } = recordingPort();
    const envOptions = { extraPathDirs: ["/nix/store/aaa-bubblewrap/bin"] };
    await runJob(jobWith(), { ...depsFor(port).deps, envOptions });
    expect(started[0]!.env).toEqual(cleanEnv({ mode: "subscription" }, envOptions));
    expect(started[0]!.env.PATH).toContain("/nix/store/aaa-bubblewrap/bin");
  });

  it("uses the job's model hint over the default", async () => {
    const { port, started } = recordingPort();
    await runJob(jobWith({ model_hint: "opus" }), depsFor(port).deps);
    expect(started[0]!.model).toBe("opus");
  });

  it("resumes a session this machine holds, in its own workspace, and creates no workspace", async () => {
    const { port, calls, started } = recordingPort();
    const { deps, created } = depsFor(port, { planSession: () => ({ kind: "resume", sessionId: "sess-7", workspace: "/work/old" }) });
    const out = await runJob(jobWith({ continues: { parent_run_id: RUN, session_id: "sess-7", branch: "fx/x" } }), deps);
    expect(out).toMatchObject({ status: "done", workspace: "/work/old" });
    expect(calls).toContain("resume:sess-7");
    expect(created).toEqual([]);
    expect(started[0]!.workdir).toBe("/work/old");
  });

  it("does not resume in a recorded workspace that is not directly under the workspace root: it starts fresh in a new one", async () => {
    for (const recorded of ["/home/jane/.ssh", "/work", "/work/a/b", "/elsewhere/old", "/work/../etc"]) {
      const { port, calls, started } = recordingPort();
      const { deps, created } = depsFor(port, { planSession: () => ({ kind: "resume", sessionId: "sess-7", workspace: recorded }) });
      const out = await runJob(jobWith({ continues: { parent_run_id: RUN, session_id: "sess-7", branch: "fx/x" } }), deps);
      expect(out, recorded).toMatchObject({ status: "done", workspace: `/work/${RUN}` });
      expect(calls.some((c) => c.startsWith("resume:")), recorded).toBe(false);
      expect(created, recorded).toEqual([RUN]);
      expect(started[0]!.workdir, recorded).toBe(`/work/${RUN}`);
    }
  });

  it("passes the plan's choice the job's own continues value", async () => {
    const seen: unknown[] = [];
    const { port } = recordingPort();
    const continues = { parent_run_id: RUN, session_id: "sess-7", branch: "fx/x" };
    await runJob(jobWith({ continues }), depsFor(port, { planSession: (c) => (seen.push(c), { kind: "fresh", branch: "fx/x" }) }).deps);
    expect(seen).toEqual([continues]);
  });
});

describe("runJob: refusals start nothing", () => {
  it.each([
    ["a prompt that does not match its digest", (j: RunnableJob) => ({ ...j, task: { ...j.task, prompt: "changed" } }), "task_prompt_hash_mismatch"],
    ["a role card that does not match", (j: RunnableJob) => ({ ...j, role_card: { ...j.role_card, text: "changed" } }), "role_card_hash_mismatch"],
    ["a tool digest that is not this runner's", (j: RunnableJob) => ({ ...j, role_tools_sha256: "0".repeat(64) }), "role_tools_mismatch"],
    ["a role this runner does not know", (j: RunnableJob) => ({ ...j, role: "ghost" }), "unknown_role"],
  ])("%s: no workspace, no sandbox, no process", async (_label, mutate, reason) => {
    const { port, calls } = recordingPort();
    const { deps, created } = depsFor(port);
    const out = await runJob(mutate(jobWith()) as RunnableJob, deps);
    expect(out).toMatchObject({ status: "refused", reasons: expect.arrayContaining([reason]) });
    expect(calls).toEqual([]);
    expect(created).toEqual([]);
  });
});

describe("runJob: the same job id never starts twice (C9 section 5)", () => {
  it("a second call with the same job_id starts nothing, whether the first is finished or still running", async () => {
    let finish: (e: NormalizedEvent) => void = () => undefined;
    const { port, calls } = recordingPort(() => new Promise((resolve) => (finish = resolve)));
    const { deps, created } = depsFor(port);
    const first = runJob(jobWith(), deps);
    await vi.waitFor(() => expect(calls).toContain("start"));
    expect(await runJob(jobWith(), deps)).toEqual({ status: "duplicate" });
    finish(result());
    expect((await first).status).toBe("done");
    expect(await runJob(jobWith(), deps)).toEqual({ status: "duplicate" });
    expect(calls.filter((c) => c === "start")).toHaveLength(1);
    expect(created).toHaveLength(1);
  });

  it("a different job id for the same run is a different job", async () => {
    const { port, calls } = recordingPort();
    const { deps } = depsFor(port);
    await runJob(jobWith(), deps);
    await runJob(jobWith({ job_id: "33333333-3333-4333-8333-333333333333" }), deps);
    expect(calls.filter((c) => c === "start")).toHaveLength(2);
  });

  it("a refused job's id is spent too", async () => {
    const { port } = recordingPort();
    const { deps } = depsFor(port);
    expect((await runJob(jobWith({ role: "ghost" as RunnableJob["role"] }), deps)).status).toBe("refused");
    expect(await runJob(jobWith(), deps)).toEqual({ status: "duplicate" });
  });
});

describe("runJob: how a run ends", () => {
  it("an error result, no result at all, and a rejected hook are failures (a coded one, from the tier or engine, is covered end to end in runJobEngine.test.ts), and the sandbox is still stopped and deleted", async () => {
    for (const [end, reason] of [
      [async () => result({ type: "error" }), "agent_error"],
      [async () => undefined, "no_result"],
      [async () => { throw new Error("secret detail"); }, "agent_exit"],
    ] as const) {
      const { port, calls } = recordingPort(end);
      const out = await runJob(jobWith(), depsFor(port).deps);
      expect(out).toMatchObject({ status: "failed", reason });
      expect(JSON.stringify(out)).not.toContain("secret detail");
      expect(calls.slice(-2)).toEqual(["stop", "delete"]);
    }
  });

  it("the wall clock stops a run whose hook never fires", async () => {
    vi.useFakeTimers();
    const { port, calls } = recordingPort(() => new Promise(() => undefined));
    const pending = runJob(jobWith(), depsFor(port, { wallClockMs: 5_000 }).deps);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await pending).toMatchObject({ status: "failed", reason: "wall_clock" });
    expect(calls.slice(-2)).toEqual(["stop", "delete"]);
  });

  it("a sandbox that cannot be created fails the job and removes the workspace it made", async () => {
    const { port } = recordingPort();
    port.createSandbox = async () => {
      throw new Error("no sandbox");
    };
    const { deps, discarded } = depsFor(port);
    expect(await runJob(jobWith(), deps)).toEqual({ status: "failed", reason: "sandbox_unavailable" });
    expect(discarded).toEqual([`/work/${RUN}`]);
  });

  it("a start that throws at once (a refused start) is a failure with its code", async () => {
    const { port, calls } = recordingPort();
    port.startDetached = () => {
      throw Object.assign(new Error("env_not_clean"), { code: "env_not_clean" });
    };
    expect(await runJob(jobWith(), depsFor(port).deps)).toMatchObject({ status: "failed", reason: "env_not_clean" });
    expect(calls.slice(-2)).toEqual(["stop", "delete"]);
  });
});

describe("runJob knows no engine", () => {
  it("imports nothing from the engines directory or the Claude-specific modules", () => {
    const text = readFileSync(path.join(PACKAGE_DIR, "src", "job", "runJob.ts"), "utf8");
    expect(text).not.toMatch(/engines\/|claude/i);
    expect(text).not.toMatch(/hostSandbox/);
  });
});
