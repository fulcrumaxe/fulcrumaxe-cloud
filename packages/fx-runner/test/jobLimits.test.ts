import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GitCaptured } from "../src/daemon/git.js";
import { GIB } from "../src/daemon/footprints.js";
import { DEFAULT_SETTINGS, DEFAULT_BUDGET, type RunnerSettings } from "../src/runnerSettings.js";
import { UNENFORCED_HEAVY, UNENFORCED_LINE, UNENFORCED_TOTAL, budgetsOf, capUnenforced, createScopeLimits, detectScopeSupport } from "../src/sandbox/jobLimits.js";

const RUN = "3f6c1a52-8d0e-4b7a-9c14-0a5e6d2b7f38";
const TOOLS = { systemdRun: "/bin/systemd-run", systemctl: "/bin/systemctl", env: "/bin/env" };
const settings = (over: Partial<RunnerSettings> = {}): RunnerSettings => ({ ...DEFAULT_SETTINGS, budget: { light: { ...DEFAULT_BUDGET.light }, heavy: { ...DEFAULT_BUDGET.heavy } }, ...over });

describe("budgets and the unenforced cap", () => {
  it("the defaults are light 2 GB / 512 tasks and heavy 6 GB / 4096, and a changed setting changes the bytes", () => {
    expect(budgetsOf(settings())).toEqual({ light: { memoryBytes: 2 * GIB, tasks: 512 }, heavy: { memoryBytes: 6 * GIB, tasks: 4096 } });
    const changed = settings();
    changed.budget.heavy.memoryGb = 12;
    expect(budgetsOf(changed).heavy.memoryBytes).toBe(12 * GIB);
  });

  it("without enforcement the ceilings drop to total 2 and heavy 1, and never rise above the person's own lower setting", () => {
    expect(capUnenforced(settings(), true)).toEqual(settings());
    expect(capUnenforced(settings(), false)).toMatchObject({ ceilingTotal: UNENFORCED_TOTAL, ceilingHeavy: UNENFORCED_HEAVY });
    expect(capUnenforced(settings({ ceilingTotal: 1, ceilingHeavy: 1 }), false)).toMatchObject({ ceilingTotal: 1, ceilingHeavy: 1 });
    expect(UNENFORCED_LINE).toBe("per-job limits not enforced on this machine; concurrency capped (heavy 1, total 2)");
  });
});

describe("the scope's command line", () => {
  const limits = (budgets = budgetsOf(settings())) => createScopeLimits({ tools: TOOLS, runtimeDir: "/run/user/1000", budgets: () => budgets, capture: async () => ({ code: 0, stdout: "", timedOut: false }) });

  it("a heavy job gets MemoryMax and TasksMax equal to the heavy budget, a light job the light one", () => {
    const heavy = limits().wrap({ runId: RUN, role: "executor" }, "/opt/claude", ["--print"], { PATH: "/usr/bin" });
    expect(heavy.command).toBe(TOOLS.systemdRun);
    expect(heavy.args).toEqual([
      "--user", "--scope", "--quiet", expect.stringMatching(new RegExp(`^--unit=fxr-${RUN}-[a-z0-9]+1$`)),
      "-p", `MemoryMax=${6 * GIB}`, "-p", "MemorySwapMax=0", "-p", "TasksMax=4096", "-p", "CPUWeight=100", "-p", "OOMPolicy=kill",
      "--", "/bin/env", "-u", "XDG_RUNTIME_DIR", "-u", "DBUS_SESSION_BUS_ADDRESS", "/opt/claude", "--print",
    ]);
    const light = limits().wrap({ runId: RUN, role: "docs-writer" }, "/opt/claude", [], {});
    expect(light.args).toContain(`MemoryMax=${2 * GIB}`);
    expect(light.args).toContain("TasksMax=512");
  });

  it("only the start needs the user bus: the job's own variables are kept and the bus directory is added for the start alone", () => {
    const wrapped = limits().wrap({ runId: RUN, role: "executor" }, "/opt/claude", [], { PATH: "/usr/bin", HOME: "/home/a" });
    expect(wrapped.env).toEqual({ PATH: "/usr/bin", HOME: "/home/a", XDG_RUNTIME_DIR: "/run/user/1000" });
    expect(wrapped.args).toEqual(expect.arrayContaining(["-u", "XDG_RUNTIME_DIR"]));
  });

  it("the budgets are read for each job, and each start gets a unit name of its own", () => {
    let current = budgetsOf(settings());
    const l = createScopeLimits({ tools: TOOLS, runtimeDir: "/run/user/1000", budgets: () => current, capture: async () => ({ code: 0, stdout: "", timedOut: false }) });
    const first = l.wrap({ runId: RUN, role: "executor" }, "c", [], {});
    const lowered = settings();
    lowered.budget.heavy.memoryGb = 3;
    current = budgetsOf(lowered);
    const second = l.wrap({ runId: RUN, role: "executor" }, "c", [], {});
    expect(first.args).toContain(`MemoryMax=${6 * GIB}`);
    expect(second.args).toContain(`MemoryMax=${3 * GIB}`);
    expect(second.args.find((arg) => arg.startsWith("--unit="))).toMatch(new RegExp(`^--unit=fxr-${RUN}-[a-z0-9]+2$`));
  });

  it("a run id that is not a uuid is refused: it would name a unit", () => {
    expect(() => limits().wrap({ runId: "x; rm -rf", role: "executor" }, "c", [], {})).toThrow(TypeError);
  });
});

describe("the verdict after a job ended", () => {
  function rig(replies: string[]) {
    const calls: string[][] = [];
    const capture = async (_command: string, args: readonly string[]): Promise<GitCaptured> => {
      calls.push([...args]);
      return { code: 0, stdout: args.includes("show") ? (replies.shift() ?? "ActiveState=inactive\nResult=success\n") : "", timedOut: false };
    };
    const l = createScopeLimits({ tools: TOOLS, runtimeDir: "/run/user/1000", budgets: () => budgetsOf(settings()), capture, sleep: async () => undefined });
    l.wrap({ runId: RUN, role: "executor" }, "c", [], {});
    return { l, calls };
  }

  it("oom-kill is the budget; the failed scope is cleared afterwards", async () => {
    const { l, calls } = rig(["ActiveState=failed\nResult=oom-kill\n"]);
    expect(await l.exceeded(RUN)).toBe(true);
    expect(calls.at(-1)).toEqual(["--user", "reset-failed", expect.stringMatching(new RegExp(`^fxr-${RUN}-[a-z0-9]+1\\.scope$`))]);
  });

  it("success is not the budget, and nothing is reset", async () => {
    const { l, calls } = rig(["ActiveState=inactive\nResult=success\n"]);
    expect(await l.exceeded(RUN)).toBe(false);
    expect(calls.some((c) => c.includes("reset-failed"))).toBe(false);
  });

  it("another failure is not the budget either, but is cleared", async () => {
    const { l, calls } = rig(["ActiveState=failed\nResult=signal\n"]);
    expect(await l.exceeded(RUN)).toBe(false);
    expect(calls.some((c) => c.includes("reset-failed"))).toBe(true);
  });

  it("waits while the manager still shows the scope active, then reads the result", async () => {
    const { l, calls } = rig(["ActiveState=active\nResult=success\n", "ActiveState=deactivating\nResult=success\n", "ActiveState=failed\nResult=oom-kill\n"]);
    expect(await l.exceeded(RUN)).toBe(true);
    expect(calls.filter((c) => c.includes("show"))).toHaveLength(3);
  });

  it("asks once per start: a second question, or a run that never started a scope, is no", async () => {
    const { l } = rig(["ActiveState=failed\nResult=oom-kill\n"]);
    expect(await l.exceeded(RUN)).toBe(true);
    expect(await l.exceeded(RUN)).toBe(false);
    expect(await l.exceeded("00000000-0000-4000-8000-000000000000")).toBe(false);
  });
});

describe("whether scopes work here", () => {
  let tools: string;
  beforeAll(() => {
    tools = mkdtempSync(path.join(tmpdir(), "c435-tools-"));
    for (const name of ["systemd-run", "systemctl", "env"]) writeFileSync(path.join(tools, name), "#!/bin/sh\n", { mode: 0o755 });
  });
  afterAll(() => rmSync(tools, { recursive: true, force: true }));
  const base = () => ({ platform: "linux" as const, uid: 1000, searchPath: tools, fallbackDirs: [] as string[], isDir: () => true, readText: () => "cpu io memory pids\n" });
  const capture = (code: number | null) => async (): Promise<GitCaptured> => ({ code, stdout: "", timedOut: false });

  it("macOS is not Linux: nothing to enforce", async () => {
    expect(await detectScopeSupport({ ...base(), platform: "darwin", capture: capture(0) })).toEqual({ ok: false, reason: "this is not Linux" });
  });

  it("each missing piece says which: a tool, the user manager, the delegation, or a test scope that will not start", async () => {
    expect(await detectScopeSupport({ ...base(), searchPath: "/nonexistent-c435", capture: capture(0) })).toMatchObject({ ok: false, reason: expect.stringMatching(/not found|^systemd-run/) });
    expect(await detectScopeSupport({ ...base(), isDir: () => false, capture: capture(0) })).toEqual({ ok: false, reason: "no systemd user manager is running for this user" });
    expect(await detectScopeSupport({ ...base(), uid: undefined, capture: capture(0) })).toEqual({ ok: false, reason: "no systemd user manager is running for this user" });
    expect(await detectScopeSupport({ ...base(), readText: () => "cpu io\n", capture: capture(0) })).toEqual({ ok: false, reason: "the memory and pids controllers are not delegated to the user manager" });
    expect(await detectScopeSupport({ ...base(), readText: () => undefined, capture: capture(0) })).toMatchObject({ ok: false });
    expect(await detectScopeSupport({ ...base(), capture: capture(1) })).toEqual({ ok: false, reason: "a test scope could not be started" });
  });

  it("when everything is there, the test scope carries both limits and the tools are the ones found", async () => {
    const seen: string[][] = [];
    const result = await detectScopeSupport({ ...base(), capture: async (_c, args) => (seen.push([...args]), { code: 0, stdout: "", timedOut: false }) });
    expect(result).toEqual({ ok: true, tools: { systemdRun: path.join(tools, "systemd-run"), systemctl: path.join(tools, "systemctl"), env: path.join(tools, "env") }, runtimeDir: "/run/user/1000" });
    expect(seen[0]).toEqual(expect.arrayContaining(["--user", "--scope", "MemoryMax=64M", "TasksMax=64"]));
  });
});
