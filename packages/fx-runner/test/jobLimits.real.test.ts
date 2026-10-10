/**
 * D#6 C43-5, the real contract: the scopes are made by the real `systemd-run --user --scope` and the memory limit is enforced by the real kernel.
 * Nothing here fakes systemd. A machine without a systemd user manager with memory and pids delegated (a hosted CI container, say) cannot make a
 * scope at all, and then these tests are skipped by name; the unit tests in jobLimits.test.ts cover the command line and the verdict logic.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { GitCapture } from "../src/daemon/git.js";
import { createScopeLimits, detectScopeSupport, type JobLimits } from "../src/sandbox/jobLimits.js";

const MB = 1024 * 1024;
const capture: GitCapture = (command, args, env, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], { env, shell: false, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", () => resolve({ code: null, stdout: "", timedOut: false }));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, timedOut: false });
    });
  });

const support = await detectScopeSupport({
  platform: process.platform,
  uid: process.getuid?.(),
  runtimeDir: process.env.XDG_RUNTIME_DIR,
  searchPath: process.env.PATH ?? "",
  capture,
  isDir: () => true,
  readText: (file) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  },
});

/** Every unit a test started: a child that cannot get a thread under a tight TasksMax hangs instead of failing, so each scope is stopped at the end of its test. */
const started: string[] = [];
/** A process that cannot get a thread aborts and may leave a core file in its working directory: that directory is a throw-away one, never the package. */
const scratch = mkdtempSync(path.join(tmpdir(), "c435-real-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(async () => {
  if (!support.ok) return;
  for (const unit of started.splice(0)) await capture(support.tools.systemctl, ["--user", "stop", `${unit}.scope`], { XDG_RUNTIME_DIR: support.runtimeDir }, 10_000);
});

/** Runs `script` under node inside a scope with these budgets and says how it ended. */
function startUnderScope(limits: JobLimits, runId: string, script: string): { unit: string; ended: Promise<{ code: number | null; signal: NodeJS.Signals | null; unit: string }> } {
  const wrapped = limits.wrap({ runId, role: "executor" }, process.execPath, ["-e", script], {});
  const unit = wrapped.args.find((arg) => arg.startsWith("--unit="))!.slice("--unit=".length);
  started.push(unit);
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null; unit: string }>((resolve) => {
    const child = spawn(wrapped.command, wrapped.args, { env: wrapped.env, shell: false, stdio: "ignore", detached: true, cwd: scratch });
    child.on("close", (code, signal) => resolve({ code, signal, unit }));
  });
  return { unit, ended };
}
const runUnderScope = (limits: JobLimits, runId: string, script: string) => startUnderScope(limits, runId, script).ended;

const HOG = "const keep=[];setInterval(()=>keep.push(Buffer.alloc(32*1048576,1)),20);";
const WELL_BEHAVED = "const a=Buffer.alloc(40*1048576,1);setTimeout(()=>process.exit(a.length>0?0:1),2500);";
const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "22222222-2222-4222-8222-222222222222";
const RUN_C = "33333333-3333-4333-8333-333333333333";

describe.skipIf(!support.ok)(`per-job scopes on this machine (${support.ok ? "systemd user manager with memory and pids" : (support as { reason: string }).reason})`, () => {
  const limits = (memoryMb: number, tasks: number): JobLimits => {
    if (!support.ok) throw new Error("skipped");
    const budget = { memoryBytes: memoryMb * MB, tasks };
    return createScopeLimits({ tools: support.tools, runtimeDir: support.runtimeDir, budgets: () => ({ light: budget, heavy: budget }), capture });
  };

  it("a job that allocates past its MemoryMax is OOM-killed and named resource_limit's cause; the job beside it keeps going and finishes", async () => {
    const l = limits(300, 400);
    const [hog, calm] = await Promise.all([runUnderScope(l, RUN_A, HOG), runUnderScope(l, RUN_B, WELL_BEHAVED)]);
    expect(hog.signal).toBe("SIGKILL");
    expect(calm).toMatchObject({ code: 0, signal: null });
    expect(await l.exceeded(RUN_A)).toBe(true);
    expect(await l.exceeded(RUN_B)).toBe(false);
  }, 60_000);

  it("the killed job's failed scope is cleared: nothing stays loaded in the manager", async () => {
    const l = limits(300, 400);
    const hog = await runUnderScope(l, RUN_A, HOG);
    expect(await l.exceeded(RUN_A)).toBe(true);
    const shown = await capture(support.ok ? support.tools.systemctl : "", ["--user", "show", `${hog.unit}.scope`, "-p", "LoadState"], { XDG_RUNTIME_DIR: support.ok ? support.runtimeDir : "" }, 5000);
    expect(shown.stdout).toContain("LoadState=not-found");
  }, 60_000);

  it("while a job runs, its scope carries exactly the budget: MemoryMax, no swap, TasksMax", async () => {
    if (!support.ok) return;
    const l = limits(300, 400);
    const job = startUnderScope(l, RUN_C, WELL_BEHAVED);
    // The unit exists as soon as the start has moved the process in; poll for it.
    let text = "";
    for (let i = 0; i < 40 && !text.includes("MemoryMax=314572800"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      text = (await capture(support.tools.systemctl, ["--user", "show", `${job.unit}.scope`, "-p", "MemoryMax", "-p", "MemorySwapMax", "-p", "TasksMax"], { XDG_RUNTIME_DIR: support.runtimeDir }, 5000)).stdout;
    }
    expect(text).toContain("MemoryMax=314572800");
    expect(text).toContain("MemorySwapMax=0");
    expect(text).toContain("TasksMax=400");
    expect((await job.ended).code).toBe(0);
    expect(await l.exceeded(RUN_C)).toBe(false);
  }, 60_000);

  it("a job past its TasksMax cannot start more processes, and that is not called a memory kill", async () => {
    const l = limits(300, 24);
    const script = "const {spawn}=require('node:child_process');let failed=0;for(let i=0;i<40;i++){const c=spawn(process.execPath,['-e','setTimeout(()=>{},1500)'],{stdio:'ignore'});c.on('error',()=>{failed++});}setTimeout(()=>process.exit(failed>0?7:0),600);";
    const result = await runUnderScope(l, RUN_A, script);
    expect(result.code).toBe(7);
    expect(await l.exceeded(RUN_A)).toBe(false);
  }, 60_000);
});
