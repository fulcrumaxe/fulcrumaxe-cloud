import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FX_LIMIT_HOOK_SCRIPT, FX_RUN_LIMITS_PATH, LIMIT_WARNING_CODES, LIMIT_WARNING_TEXT, limitWarningText, runLimitsFileContent } from "../src/agentConfig.js";
import { CLAUDE_CLI_VERSION, createVercelSandboxPort, type SdkCommand, type SdkSandbox } from "../src/vercelSandboxPort.js";
import type { RunLimits } from "../src/meteringGuard.js";
import type { StartDetachedOptions } from "../src/sandboxPort.js";
import type { ExtensionPolicy } from "../src/runLimitDecision.js";
import { RunLimitError } from "../src/meteringGuard.js";
import { buildSandboxEnv } from "../src/sandboxEnv.js";
import { networkPolicy } from "../src/networkPolicy.js";
import { keyedPolicy } from "./helpers/keyedPolicy.js";
import { sdkSessionStubs } from "./helpers/sdkSession.js";
import { retentionPolicyFor } from "../src/sandboxNaming.js";
import { buildTerminalReport } from "../src/targets/sandboxTarget.js";
import type { NormalizedEvent } from "../src/types.js";

// D#600 CX-6a: lets one test make the price table report no window for the model (the real lookup is tested in packages/spend).
const noWindow = vi.hoisted(() => ({ on: false }));
vi.mock("@fx/spend", async (importOriginal) => {
  const real = await importOriginal<typeof import("@fx/spend")>();
  return { ...real, contextWindowTokensFor: (model: string) => (noWindow.on ? undefined : real.contextWindowTokensFor(model)) };
});

const NAME = "rn-8-reviewer-run-1";
const T0 = Date.parse("2030-01-01T00:00:00Z");
const assistant = (id: string) => JSON.stringify({ type: "assistant", message: { id, content: [], usage: { input_tokens: 1 } } });
const assistantCtx = (id: string, input: number, extra: { read?: number; write?: number; sub?: boolean } = {}) =>
  JSON.stringify({
    type: "assistant",
    ...(extra.sub ? { parent_tool_use_id: "toolu_1" } : {}),
    message: { id, content: [], usage: { input_tokens: input, cache_read_input_tokens: extra.read ?? 0, cache_creation_input_tokens: extra.write ?? 0 } },
  });
const finalResult = (text: string) => JSON.stringify({ type: "result", is_error: false, result: text });
const checkpointEnvelope = (summary: unknown) =>
  `stop\n<!-- AGENT_OUTPUT -->\n\`\`\`json\n${JSON.stringify({ verdict: "checkpoint", summary })}\n\`\`\`\n<!-- /AGENT_OUTPUT -->`;

type Write = { path: string; content: string; mode?: number };
type Step = { at: "lines" | "write"; lines?: string[]; files?: Write[] };

/** A sandbox that prints the given lines and records every file write in order relative to them. */
function harness(lines: string[], hold?: Promise<void>) {
  const steps: Step[] = [];
  const done = (): SdkCommand => ({
    async *logs() {
      for (const line of lines) {
        steps.push({ at: "lines", lines: [line] });
        yield { stream: "stdout", data: `${line}\n` };
        await new Promise((r) => setImmediate(r)); // let a fire-and-forget write land
      }
      await hold;
    },
    wait: async () => ({ exitCode: 0 }),
    kill: async () => undefined,
  });
  const sandbox: SdkSandbox = {
    name: NAME,
    async runCommand(params) {
      if (params.args?.[2] === "fx-pin") {
        return { async *logs() { yield { stream: "stdout", data: `${CLAUDE_CLI_VERSION}\n` }; }, wait: async () => ({ exitCode: 0 }), kill: async () => undefined };
      }
      return done();
    },
    async writeFiles(files) {
      steps.push({ at: "write", files });
    },
    updateNetworkPolicy: async () => undefined,
    extendTimeout: async () => undefined,
    stop: async () => undefined,
    delete: async () => undefined,
    ...sdkSessionStubs(),
  };
  const get = async () => sandbox;
  const events: NormalizedEvent[] = [];
  const opts: StartDetachedOptions = {
    runId: "run-1",
    role: "code-reviewer",
    roleCard: "card",
    prompt: "go",
    model: "sonnet-5",
    workdir: "/vercel/sandbox/repo",
    capUsd: 5,
    networkPolicy: keyedPolicy(networkPolicy("code-reviewer", "team", { provider: "ai_gateway", githubForwardHost: "gh-proxy.fulcrumaxe.app" })),
    env: buildSandboxEnv("code-reviewer"),
    onEvent: (e) => void events.push(e),
  };
  /** `restarted`: the port never created this sandbox (a worker restart); the SDK reports `sdkTimeoutMs` for it, or nothing. */
  const run = async (limits: Partial<RunLimits>, resumeId?: string, extension?: ExtensionPolicy, restarted?: { sdkTimeoutMs?: number; perRun?: Partial<RunLimits> }) => {
    const port = createVercelSandboxPort({ teamId: "t", projectId: "p", getToken: async () => "tok", sdk: { create: get, get }, limits });
    (sandbox as { timeout?: number }).timeout = restarted?.sdkTimeoutMs;
    const handle = restarted
      ? { runId: "", sandboxName: NAME }
      : await port.createSandbox({ sandboxName: NAME, retention: retentionPolicyFor("code-reviewer"), timeoutMs: 80_000_000 });
    const o = { ...opts, extension, ...(restarted?.perRun && { limits: restarted.perRun }) };
    const started = resumeId ? port.resume(handle, resumeId, "next", o) : port.startDetached(handle, o);
    return started.hookFired;
  };
  const limitFiles = () =>
    steps.flatMap((s) => (s.files ?? []).filter((f) => f.path === FX_RUN_LIMITS_PATH)).map((f) => ({ ...f, json: JSON.parse(f.content) as Record<string, number> }));
  return { run, steps, limitFiles, events };
}

describe("W-1: the time-remaining file", () => {
  beforeEach(() => vi.useFakeTimers({ now: T0, toFake: ["Date"] }));
  afterEach(() => vi.useRealTimers());

  it("is written 0444 before the command with the absolute deadline and no secret, and again (new deadline) on resume", async () => {
    const h = harness([]);
    await h.run({ maxRunMs: 600_000 });
    vi.setSystemTime(T0 + 90_000);
    await h.run({ maxRunMs: 600_000 }, "sess-9");
    const files = h.limitFiles();
    expect(files.map((f) => f.mode)).toEqual([0o444, 0o444]);
    expect(files[0]!.json).toEqual({ started_epoch_s: T0 / 1000, deadline_epoch_s: T0 / 1000 + 600, max_model_calls: 300 });
    expect(files[1]!.json.deadline_epoch_s).toBe(T0 / 1000 + 690);
    for (const f of files) for (const secret of Object.values(buildSandboxEnv("code-reviewer")).filter((v) => v.length > 3)) expect(f.content).not.toContain(secret);
  });

  it("the runner's own clock rewrites the file once at 80% of the window with the minutes left; no clock is read by the hook", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ now: T0, toFake: ["Date", "setTimeout", "clearTimeout"] });
    let release!: () => void;
    const h = harness([assistant("m1")], new Promise<void>((r) => (release = r)));
    const ended = h.run({ maxRunMs: 600_000 });
    while (!h.steps.some((s) => s.at === "lines")) await new Promise((r) => setImmediate(r)); // the command is running
    await vi.advanceTimersByTimeAsync(479_000);
    expect(h.limitFiles()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await new Promise((r) => setImmediate(r));
    const files = h.limitFiles();
    expect(files).toHaveLength(2);
    expect(files[1]).toMatchObject({ mode: 0o444, json: { deadline_epoch_s: T0 / 1000 + 600, time_warning_minutes: 2 } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.limitFiles()).toHaveLength(2); // once
    release();
    await ended;
  });

  it("MP-SRC: the runner only ever writes the file; it has no read path for it", () => {
    const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/vercelSandboxPort.ts"), "utf8");
    const uses = src.split("\n").filter((l) => l.includes("FX_RUN_LIMITS_PATH") && !l.trim().startsWith("//"));
    expect(uses.every((l) => /^\s*(FX_RUN_LIMITS_PATH,|.*\{ path: FX_RUN_LIMITS_PATH, content:)/.test(l))).toBe(true);
    expect(src).not.toMatch(/readFile|readFileToBuffer/);
  });
});

describe("the hook script (real /bin/sh)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fx-limit-hook-"));
  const run = (fileBody: string | undefined) => {
    const limits = path.join(dir, "run-limits.json");
    if (fileBody !== undefined) writeFileSync(limits, fileBody);
    const script = path.join(dir, "hook.sh");
    writeFileSync(script, FX_LIMIT_HOOK_SCRIPT.replace(FX_RUN_LIMITS_PATH, fileBody === undefined ? path.join(dir, "absent.json") : limits));
    return spawnSync("/bin/sh", [script], { encoding: "utf8" });
  };
  /** Prints nothing at all, on stdout or stderr, and exits 0. */
  const silent = (body: string | undefined) => {
    const r = run(body);
    expect({ status: r.status, stdout: r.stdout, stderr: r.stderr }).toEqual({ status: 0, stdout: "", stderr: "" });
  };
  /** Valid hook JSON, and nothing on stderr. */
  const speaks = (body: string): string => {
    const r = run(body);
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    const out = JSON.parse(r.stdout);
    expect(Object.keys(out)).toEqual(["hookSpecificOutput"]);
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    return out.hookSpecificOutput.additionalContext as string;
  };
  const file = (extra: { timeWarningMinutes?: number; modelCallsRemaining?: number } = {}) =>
    runLimitsFileContent({ startedMs: T0, deadlineMs: T0 + 600_000, maxModelCalls: 300, ...extra });

  it("says nothing until the runner has recorded a warning", () => {
    silent(file());
  });

  it("W-1: a time_warning_minutes value gives the minutes left and the checkpoint instruction", () => {
    expect(speaks(file({ timeWarningMinutes: 10 }))).toMatch(/^About 10 minutes remain.*checkpoint/);
    expect(speaks(file({ timeWarningMinutes: 0 }))).toMatch(/^About 0 minutes remain/);
  });

  it("W-2: model_calls_remaining is surfaced the same way, and both together give one message", () => {
    const only = speaks(file({ modelCallsRemaining: 60 }));
    expect(only).toMatch(/Only 60 model calls remain.*checkpoint/);
    expect(only).not.toMatch(/minutes remain/);
    expect(speaks(file({ timeWarningMinutes: 3, modelCallsRemaining: 60 }))).toMatch(/About 3 minutes.*Only 60 model calls/);
  });

  it("fail-silent: a missing file, empty, garbage, hostile text, a leading zero, a huge, signed or non-numeric value all print nothing and exit 0", () => {
    for (const body of [
      undefined,
      "",
      "not json",
      "\u0000\u0001 {{{",
      '{"time_warning_minutes":"$(touch /tmp/x)"}',
      '{"time_warning_minutes":08}',
      '{"time_warning_minutes":00}',
      '{"time_warning_minutes":99999999999999999999999}',
      '{"time_warning_minutes":1234567890}',
      '{"model_calls_remaining":-5}',
      '{"model_calls_remaining":}',
      '{"model_calls_remaining":"7"}',
    ]) {
      silent(body);
    }
  });

  it("uses the first occurrence of a repeated key, and the output stays valid JSON", () => {
    const text = speaks('{"model_calls_remaining":7,"model_calls_remaining":8,"time_warning_minutes":4,"time_warning_minutes":9}');
    expect(text).toMatch(/About 4 minutes.*Only 7 model calls/);
    silent('{"time_warning_minutes":08,"time_warning_minutes":9}');
  });

  it("an invalid value is dropped on its own without silencing a valid one", () => {
    expect(speaks('{"time_warning_minutes":08,"model_calls_remaining":5}')).toMatch(/^ Only 5 model calls/);
  });
});

describe("CX-6a: the context line of the hook (real shell)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fx-limit-hook-ctx-"));
  const script = path.join(dir, "hook.sh");
  const limits = path.join(dir, "run-limits.json");
  writeFileSync(script, FX_LIMIT_HOOK_SCRIPT.replace(FX_RUN_LIMITS_PATH, limits));
  const run = (body: string) => {
    writeFileSync(limits, body);
    return spawnSync("sh", [script], { encoding: "utf8" });
  };
  const said = (body: string): string | undefined => {
    const r = run(body);
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    return r.stdout === "" ? undefined : (JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string);
  };

  it("acceptance 1: {context_pct:72} prints the context line; 69, a leading zero and a 10-digit value print nothing", () => {
    expect(said('{"context_pct":72}')).toBe(` ${limitWarningText("context_warning", 72)}.`);
    expect(said('{"context_pct":72}')).toContain("Context is at 72% of the window: finish, or end with a checkpoint envelope");
    expect(said('{"context_pct":69}')).toBeUndefined();
    expect(said('{"context_pct":072}')).toBeUndefined();
    expect(said('{"context_pct":0072}')).toBeUndefined();
    expect(said('{"context_pct":1234567890}')).toBeUndefined();
  });

  it("the edges: 70, 100 and 999 speak; 1000, a 9-digit value, signed, quoted, empty, hostile and zero are silent", () => {
    expect(said('{"context_pct":70}')).toContain("Context is at 70%");
    expect(said('{"context_pct":100}')).toContain("Context is at 100%");
    expect(said('{"context_pct":999}')).toContain("Context is at 999%");
    for (const body of ['{"context_pct":1000}', '{"context_pct":123456789}', '{"context_pct":-80}', '{"context_pct":"80"}', '{"context_pct":}', '{"context_pct":$(id)}', '{"context_pct":0}']) {
      expect(said(body), body).toBeUndefined();
    }
  });

  it("the first occurrence wins, and the context line sits beside the time and call lines without hiding either", () => {
    expect(said('{"context_pct":69,"context_pct":90}')).toBeUndefined();
    const all = said('{"time_warning_minutes":3,"model_calls_remaining":9,"context_pct":88}')!;
    expect(all).toMatch(/About 3 minutes.*Only 9 model calls.*Context is at 88%/);
  });

  it("acceptance 4: three warnings, three distinct codes and three distinct strings; each is what the hook prints for its own key", () => {
    const codes = Object.values(LIMIT_WARNING_CODES);
    expect(new Set(codes).size).toBe(3);
    expect(new Set(Object.values(LIMIT_WARNING_TEXT)).size).toBe(3);
    expect(Object.keys(LIMIT_WARNING_TEXT).sort()).toEqual([...codes].sort());
    const printed = {
      time_warning: said('{"time_warning_minutes":11}')!,
      calls_warning: said('{"model_calls_remaining":11}')!,
      context_warning: said('{"context_pct":81}')!,
    };
    for (const code of codes) {
      expect(printed[code]).toContain(limitWarningText(code, code === "context_warning" ? 81 : 11));
      for (const other of codes.filter((c) => c !== code)) expect(printed[code]).not.toContain(LIMIT_WARNING_TEXT[other].replace("{N}", "").slice(0, 20));
    }
    // a text goes into a shell string and a JSON string unescaped
    for (const t of Object.values(LIMIT_WARNING_TEXT)) expect(t).not.toMatch(/["\\$`\n]/);
  });

  it("acceptance 2: over 1,000 runs the hook costs at most 10 ms at p99 above an empty script's own start-up", () => {
    writeFileSync(limits, '{"time_warning_minutes":3,"model_calls_remaining":9,"context_pct":88}');
    const empty = path.join(dir, "empty.sh");
    writeFileSync(empty, "exit 0\n");
    const time = (file: string): number[] => {
      const out: number[] = [];
      for (let i = 0; i < 1000; i++) {
        const t0 = process.hrtime.bigint();
        spawnSync("sh", [file]);
        out.push(Number(process.hrtime.bigint() - t0) / 1e6);
      }
      return out.sort((a, b) => a - b);
    };
    const p99 = (xs: number[]): number => xs[Math.floor(xs.length * 0.99)]!;
    const base = time(empty);
    const hook = time(script);
    // The harness spawns a process per run, so the empty script's own p99 is subtracted: that leaves the hook's cost.
    expect(p99(hook) - p99(base)).toBeLessThanOrEqual(10);
  }, 60_000);
});

describe("CX-6a: the runner writes context_pct from the latest turn against the model's window", () => {
  // sonnet-5: a 200,000-token window in the price table.
  it("is absent below 70%, present at 70% and above (input + cache read + cache write of the LAST turn), as a whole percent", async () => {
    const h = harness([assistantCtx("m1", 100_000), assistantCtx("m2", 139_999), assistantCtx("m3", 40_000, { read: 100_000, write: 1_000 })]);
    await h.run({});
    const files = h.limitFiles();
    expect(files).toHaveLength(2); // the start, then m3 (70.5% -> 70); m1 (50%) and m2 (69.99% -> 69) write nothing
    expect(files[0]!.json.context_pct).toBeUndefined();
    expect(files[1]!.json.context_pct).toBe(70);
    expect(files[1]!.mode).toBe(0o444);
  });

  it("a figure that changes is rewritten, an unchanged one is not, and a compaction (the next turn is small) takes it away again", async () => {
    const h = harness([assistantCtx("m1", 150_000), assistantCtx("m2", 150_500), assistantCtx("m3", 180_000), assistantCtx("m4", 30_000)]);
    await h.run({});
    expect(h.limitFiles().map((f) => f.json.context_pct)).toEqual([undefined, 75, 90, undefined]);
  });

  it("over the window is 100, never more", async () => {
    const h = harness([assistantCtx("m1", 350_000)]);
    await h.run({});
    expect(h.limitFiles().at(-1)!.json.context_pct).toBe(100);
  });

  it("a subagent's turn is not the main thread's context", async () => {
    const h = harness([assistantCtx("m1", 20_000), assistantCtx("s1", 190_000, { sub: true })]);
    await h.run({});
    expect(h.limitFiles()).toHaveLength(1);
  });

  it("a model with no window figure writes no context_pct, however full the context is, and the hook stays silent", async () => {
    noWindow.on = true;
    try {
      const h = harness([assistantCtx("m1", 190_000), assistantCtx("m2", 199_000)]);
      await h.run({});
      const files = h.limitFiles();
      expect(files).toHaveLength(1); // the start only
      expect(files.every((f) => f.json.context_pct === undefined)).toBe(true);
      const dir = mkdtempSync(path.join(tmpdir(), "fx-limit-hook-nowin-"));
      const limits = path.join(dir, "run-limits.json");
      const script = path.join(dir, "hook.sh");
      writeFileSync(limits, files[0]!.content);
      writeFileSync(script, FX_LIMIT_HOOK_SCRIPT.replace(FX_RUN_LIMITS_PATH, limits));
      const r = spawnSync("sh", [script], { encoding: "utf8" });
      expect({ status: r.status, stdout: r.stdout, stderr: r.stderr }).toEqual({ status: 0, stdout: "", stderr: "" });
    } finally {
      noWindow.on = false;
    }
  });

  it("the call warning keeps the context figure when it rewrites the file", async () => {
    const h = harness([assistantCtx("m1", 160_000), ...Array.from({ length: 8 }, (_, i) => assistantCtx(`n${i}`, 160_000))]);
    await h.run({ maxModelCalls: 10 });
    expect(h.limitFiles().at(-1)!.json).toMatchObject({ context_pct: 80, model_calls_remaining: 2 });
  });
});

describe("W-2: the model-call warning", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => assistant(`m${i + 1}`));

  it("rewrites the file once with model_calls_remaining at 80% of maxModelCalls, not before", async () => {
    const h = harness(ids(9));
    await h.run({ maxModelCalls: 10 });
    const files = h.limitFiles();
    expect(files).toHaveLength(2);
    expect(files[0]!.json.model_calls_remaining).toBeUndefined();
    expect(files[1]).toMatchObject({ mode: 0o444, json: { max_model_calls: 10, model_calls_remaining: 2 } });
    // The rewrite lands right after the 8th message, before the 9th is printed.
    const writeAt = h.steps.findIndex((s) => s.files?.some((f) => f.path === FX_RUN_LIMITS_PATH && f.content.includes("remaining")));
    expect(h.steps.slice(0, writeAt).filter((s) => s.at === "lines")).toHaveLength(8);
  });

  it("writes nothing extra below 80%", async () => {
    const h = harness(ids(7));
    await h.run({ maxModelCalls: 10 });
    expect(h.limitFiles()).toHaveLength(1);
  });
});

describe("W-3: the agent's checkpoint", () => {
  const resultEvent = (agentOutput: Record<string, unknown> | undefined, extra: Partial<NormalizedEvent> = {}): NormalizedEvent =>
    ({ runId: "r", role: "code-reviewer", seq: 1, type: "result", ts: "t", agentOutput, ...extra }) as NormalizedEvent;

  it("a final checkpoint envelope ends the run as timed_out, carrying the summary", () => {
    const report = buildTerminalReport(resultEvent({ verdict: "checkpoint", summary: "done A, left B" }), "cc-1", 1.5);
    expect(report).toMatchObject({ status: "timed_out", sessionId: "cc-1", usd: 1.5, agentCheckpoint: { summary: "done A, left B" }, envelope: { verdict: "checkpoint" } });
    expect(report.limit).toBeUndefined();
  });

  it.each([["a number", 7], ["missing", undefined], ["an object", { a: 1 }]])("a checkpoint whose summary is %s is not a checkpoint", (_l, summary) => {
    expect(buildTerminalReport(resultEvent({ verdict: "checkpoint", summary }), "cc-1", 0).status).toBe("succeeded");
  });

  it("an error result carrying a checkpoint envelope is a failure, not a resumable end", () => {
    const err = resultEvent({ verdict: "checkpoint", summary: "x" }, { type: "error", isError: true });
    expect(buildTerminalReport(err, "cc-1", 0)).toMatchObject({ status: "failed" });
    expect(buildTerminalReport(err, "cc-1", 0).agentCheckpoint).toBeUndefined();
  });

  it("only ends a run: the port never rewrites the deadline or a limit after it, and the report has no limit or extension", async () => {
    const h = harness([assistant("m1"), finalResult(checkpointEnvelope("won't finish"))]);
    const last = await h.run({ maxModelCalls: 10, maxRunMs: 600_000 });
    expect(h.limitFiles()).toHaveLength(1);
    const report = buildTerminalReport(last, "cc-1", 0.1);
    expect(report.status).toBe("timed_out");
    expect(report.limit).toBeUndefined();
    expect(JSON.stringify(report)).not.toMatch(/extension|extend/i);
  });
});

describe("X-4: in-run extension at the port (run_time and model_calls)", () => {
  const MIN = 60_000;
  const policy = (over: Partial<ExtensionPolicy> = {}): ExtensionPolicy => ({
    maxExtensions: 2,
    roleWrites: false,
    ceilings: { runMs: 240 * MIN, modelCalls: 1500, usd: 200 },
    meteredUsd: () => 1,
    ghWrites: () => 0,
    reserveExtension: vi.fn(async () => true),
    onExtended: vi.fn(),
    ...over,
  });
  const ids = (n: number) => Array.from({ length: n }, (_, i) => assistant(`m${i + 1}`));
  /** Runs against a held command with the runner's clock faked; returns once the command is running. */
  async function held(lines: string[], limits: Partial<RunLimits>, extension?: ExtensionPolicy, restarted?: { sdkTimeoutMs?: number }) {
    vi.useFakeTimers({ now: T0, toFake: ["Date", "setTimeout", "clearTimeout"] });
    const h = harness(lines, new Promise<void>(() => undefined));
    const ended = h.run(limits, undefined, extension, restarted);
    ended.catch(() => undefined);
    while (!h.steps.some((s) => s.at === "write")) await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); // the command is running
    return { h, ended };
  }
  afterEach(() => vi.useRealTimers());

  it("absent policy: the limit ends the run at its original value (today's behaviour)", async () => {
    const { ended } = await held([assistant("m1")], { maxRunMs: 4 * MIN });
    await vi.advanceTimersByTimeAsync(4 * MIN);
    await expect(ended).rejects.toMatchObject({ limit: { kind: "run_time", limit: 4 * MIN } });
  });

  it("R-UNK: a sandbox this port did not create takes its timeout from the SDK, and extends under it", async () => {
    const p = policy();
    const { ended } = await held([assistant("m1")], { maxRunMs: 4 * MIN }, p, { sdkTimeoutMs: 20 * MIN });
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(p.reserveExtension).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    await expect(ended).rejects.toMatchObject({ limit: { kind: "run_time", limit: 6 * MIN } });
  });

  it("R-UNK: a sandbox whose timeout nobody can tell fails closed: no extension, the limit ends the run as it stands", async () => {
    const p = policy();
    const { ended } = await held([assistant("m1")], { maxRunMs: 4 * MIN }, p, {});
    await vi.advanceTimersByTimeAsync(4 * MIN);
    await expect(ended).rejects.toMatchObject({ limit: { kind: "run_time", limit: 4 * MIN } });
    expect(p.reserveExtension).not.toHaveBeenCalled();
  });

  it("R-UNK: ... and a run longer than the port's default is refused rather than guessed at; one at the default runs", async () => {
    const h = harness([]);
    await expect(h.run({}, undefined, undefined, { perRun: { maxRunMs: 90 * MIN } })).rejects.toThrow(/less than the sandbox timeoutMs/);
    await expect(h.run({}, undefined, undefined, { perRun: { maxRunMs: 60 * MIN } })).resolves.toMatchObject({ runId: "run-1" });
  });

  it("R-UNK: the SDK's timeout is enforced like a recorded one (a run that would outlive it is refused)", async () => {
    const h = harness([]);
    await expect(h.run({ maxRunMs: 30 * MIN }, undefined, undefined, { sdkTimeoutMs: 30 * MIN })).rejects.toThrow(/less than the sandbox timeoutMs/);
  });

  it("run_time: usage rose, so it extends by half, rewrites the deadline, re-warns, records the event, then ends at the new limit", async () => {
    const p = policy();
    const { h, ended } = await held([assistant("m1")], { maxRunMs: 4 * MIN }, p);
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(p.reserveExtension).toHaveBeenCalledTimes(1);
    expect(p.onExtended).toHaveBeenCalledWith({ kind: "run_time", extensionsUsed: 1, newLimit: 6 * MIN, progress: { usage_rose: true, gh_writes: 0, new_message_ids: 1 } });
    expect(h.limitFiles().at(-1)!.json.deadline_epoch_s).toBe(T0 / 1000 + 360);
    await vi.advanceTimersByTimeAsync(2 * MIN - 1);
    expect(h.limitFiles().at(-1)!.json).toMatchObject({ deadline_epoch_s: T0 / 1000 + 360, time_warning_minutes: 2 }); // warned again, from the new window
    await vi.advanceTimersByTimeAsync(1);
    // A second extension needs a write or 5 new ids: neither, so the run ends at the extended limit.
    await expect(ended).rejects.toMatchObject({ limit: { kind: "run_time", limit: 6 * MIN } });
    expect(p.reserveExtension).toHaveBeenCalledTimes(1);
  });

  it("ghAtLast: a writing role's next extension needs a GitHub write since the LAST one, not since the start", async () => {
    let writes = 0;
    const p = policy({ roleWrites: true, maxExtensions: 3, ghWrites: () => writes });
    const { ended } = await held([assistant("m1")], { maxRunMs: 2 * MIN }, p);
    await vi.advanceTimersByTimeAsync(2 * MIN); // first extension: no write needed (limit 3 min)
    expect(p.onExtended).toHaveBeenCalledTimes(1);
    writes = 1; // one write lands in the extended window
    await vi.advanceTimersByTimeAsync(1 * MIN);
    expect(p.onExtended).toHaveBeenLastCalledWith(expect.objectContaining({ extensionsUsed: 2, newLimit: 4 * MIN, progress: expect.objectContaining({ gh_writes: 1 }) }));
    // The running total is still 1, but nothing was written since the second extension: it must not count twice.
    await vi.advanceTimersByTimeAsync(1 * MIN);
    await expect(ended).rejects.toMatchObject({ limit: { kind: "run_time", limit: 4 * MIN } });
    expect(p.onExtended).toHaveBeenCalledTimes(2);
  });

  it("E3: a stalled run (no usage rise) is not extended and reserves nothing", async () => {
    const p = policy();
    const { ended } = await held([], { maxRunMs: 4 * MIN }, p);
    await vi.advanceTimersByTimeAsync(4 * MIN);
    await expect(ended).rejects.toBeInstanceOf(RunLimitError);
    expect(p.reserveExtension).not.toHaveBeenCalled();
    expect(p.onExtended).not.toHaveBeenCalled();
  });

  it("E4: reserve() denying ends the run with no event", async () => {
    const p = policy({ reserveExtension: vi.fn(async () => false) });
    const { ended } = await held([assistant("m1")], { maxRunMs: 4 * MIN }, p);
    await vi.advanceTimersByTimeAsync(4 * MIN);
    await expect(ended).rejects.toMatchObject({ limit: { kind: "run_time", limit: 4 * MIN } });
    expect(p.reserveExtension).toHaveBeenCalledTimes(1);
    expect(p.onExtended).not.toHaveBeenCalled();
  });

  it("model_calls: extends past the count, rewrites max_model_calls, and the next hit needs progress", async () => {
    vi.useRealTimers();
    const p = policy();
    const h = harness(ids(7));
    await expect(h.run({ maxModelCalls: 4 }, undefined, p)).rejects.toMatchObject({ limit: { kind: "model_calls", limit: 6, observed: 7 } });
    expect(p.onExtended).toHaveBeenCalledTimes(1);
    expect(p.onExtended).toHaveBeenCalledWith({ kind: "model_calls", extensionsUsed: 1, newLimit: 6, progress: { usage_rose: true, gh_writes: 0, new_message_ids: 5 } });
    expect(h.limitFiles().some((f) => f.json.max_model_calls === 6)).toBe(true);
  });

  it("apply first, record only if applied: silence ending the run during a pending decision records no extension", async () => {
    let admit!: (ok: boolean) => void;
    const p = policy({ reserveExtension: vi.fn(() => new Promise<boolean>((r) => (admit = r))) });
    const { ended } = await held([assistant("m1")], { maxRunMs: 4 * MIN, meteringSilenceMs: 4.5 * MIN }, p);
    await vi.advanceTimersByTimeAsync(4 * MIN); // the run-time limit asks; the reservation is still pending
    expect(p.reserveExtension).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0.5 * MIN); // no usage rise: silence ends the run
    await expect(ended).rejects.toMatchObject({ limit: { kind: "silence" } });
    admit(true); // the reservation lands too late
    await vi.advanceTimersByTimeAsync(0);
    expect(p.onExtended).not.toHaveBeenCalled(); // no limit_extended row, extensions_used unchanged
  });

  it("roleWrites left out is a writing role: five new ids alone do not earn a second extension; roleWrites false does", async () => {
    vi.useRealTimers();
    const fromRoot = policy();
    delete fromRoot.roleWrites;
    const failClosed = harness(ids(16));
    await expect(failClosed.run({ maxModelCalls: 10 }, undefined, fromRoot)).rejects.toMatchObject({ limit: { kind: "model_calls", limit: 15, observed: 16 } });
    expect(fromRoot.onExtended).toHaveBeenCalledTimes(1);
    const readOnly = policy({ roleWrites: false });
    await harness(ids(16)).run({ maxModelCalls: 10 }, undefined, readOnly);
    expect(readOnly.onExtended).toHaveBeenCalledTimes(2);
  });

  it("a checkpoint never extends: a final checkpoint envelope reserves nothing, extends nothing and moves no deadline", async () => {
    vi.useRealTimers();
    const p = policy();
    const h = harness([...ids(2), finalResult(checkpointEnvelope("won't finish"))]);
    const last = await h.run({ maxModelCalls: 2, maxRunMs: 600_000 }, undefined, p);
    expect(buildTerminalReport(last, "cc-1", 0.1)).toMatchObject({ status: "timed_out", agentCheckpoint: { summary: "won't finish" } });
    expect(p.reserveExtension).not.toHaveBeenCalled();
    expect(p.onExtended).not.toHaveBeenCalled();
    expect(new Set(h.limitFiles().map((f) => `${f.json.deadline_epoch_s}/${f.json.max_model_calls}`)).size).toBe(1);
  });

  it("extensions_used reaches the report only when an extension happened", () => {
    const ev = { runId: "r", role: "code-reviewer", seq: 1, type: "result", ts: "t", agentOutput: { verdict: "checkpoint", summary: "s" } } as NormalizedEvent;
    const snap = (extensionsUsed: number) => ({ tokens: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }, flags: [], extensionsUsed });
    expect(buildTerminalReport(ev, "cc", 0, snap(2)).extensionsUsed).toBe(2);
    expect(buildTerminalReport(ev, "cc", 0, snap(0))).not.toHaveProperty("extensionsUsed");
  });

  it("MP-SRC/X-2: the port's decision reads nothing from the VM (only writes the file)", () => {
    const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/vercelSandboxPort.ts"), "utf8");
    const decide = src.slice(src.indexOf("const extension = extPolicy"), src.indexOf("const guard = createRunGuard("));
    expect(decide.length).toBeGreaterThan(500);
    expect(decide).not.toMatch(/FX_RUN_LIMITS_PATH|readFile|agentOutput|sandbox\./);
  });
});
