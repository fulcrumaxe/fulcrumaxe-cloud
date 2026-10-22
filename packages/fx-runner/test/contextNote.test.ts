import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONTEXT_WARNING_CODE, CONTEXT_WARNING_TEXT, CONTEXT_WARN_PCT, contextLedgerToWire, contextNoteLine, type Job } from "@fulcrumaxe/runner-protocol";
import { LIMIT_WARNING_CODES, LIMIT_WARNING_TEXT, limitWarningText } from "@fx/runner";
import { runCheckpointTurn } from "../src/daemon/checkpointTurn.js";
import { createClaudeEngine } from "../src/engines/claude/engine.js";
import { readSessionIndex } from "../src/engines/claude/session.js";
import { createMemoryLedger, runJob, type RunJobResult } from "../src/job/runJob.js";
import { createWorkspaceStore } from "../src/job/workspace.js";
import { createHostSandbox } from "../src/sandbox/hostSandbox.js";
import type { SandboxPort } from "../src/sandbox/port.js";
import { RUN_ID, fixtureText, makeFake, makeRig } from "./engines/claude/rig.js";
import { jobFor } from "./helpers/signedJob.js";

/**
 * D#600 CX-6b: the local runner computes how full the agent's context is from the stream's per-turn usage, and puts one line ahead of the prompt of the next turn it
 * starts (a resume of the session, which is what a fix round and a checkpoint continuation are). No hook runs. The streams are the recorded real-CLI stream
 * (claude 2.1.289, `stream.subscription.jsonl`) with only the usage counts changed to the figure under test.
 */
const WINDOW = 200_000;
const FIRST_FIXED = 9 + 4875; // the recorded turn's uncached input and cache-write tokens; the cache-read figure is what each stream sets

type Line = Record<string, unknown>;
/** The recorded stream with every main-thread assistant turn's usage set so its context (input + cache read + cache write) is `tokens`, or edited by `mutate`. */
function streamAt(tokens: number | undefined, mutate?: (usage: Line) => void): string {
  return fixtureText("stream.subscription.jsonl")
    .split("\n")
    .filter((l) => l !== "")
    .map((raw) => {
      const line = JSON.parse(raw) as Line;
      if (line.type === "assistant") {
        const message = line.message as Line;
        if (tokens === undefined) delete message.usage;
        else {
          const usage = message.usage as Line;
          usage.cache_read_input_tokens = tokens - FIRST_FIXED;
          mutate?.(usage);
        }
      }
      return JSON.stringify(line);
    })
    .join("\n")
    .concat("\n");
}

const NOTE = (pct: number): string => `Context is at ${pct}% of the window: finish, or end with a checkpoint envelope.`;

/** A rig whose commands run through the real job runner, the real engine and the host tier; each `step` is one command of the same session. */
function session() {
  const fake = makeFake({ stream: streamAt(144_000) });
  const rig = makeRig({ fake });
  const host = createHostSandbox({
    credentials: { mode: "subscription" },
    makeRuntime: (sandbox, protectedList) => createClaudeEngine({ ...rig.config, sandboxSettings: sandbox, protectedPaths: protectedList }),
    home: rig.root,
    stateDir: path.join(rig.root, "state"),
    binaryDir: path.dirname(fake.binary),
    tempRoot: path.join(rig.root, "tmp"),
    workspaceRoot: path.join(rig.root, "work"),
  });
  const workspaces = createWorkspaceStore(path.join(rig.root, "work"));
  let n = 0;
  let previous: RunJobResult | undefined;
  /** Runs one command with `stream` on the end of the session so far (the first is a fresh start) and returns what the agent was sent on standard input. */
  async function step(stream: string, over: Partial<Job> = {}, prompt = "Implement the change.\n"): Promise<{ stdin: string; out: RunJobResult }> {
    fake.set("stream.jsonl", stream);
    n += 1;
    const resumed = previous?.status === "done" ? previous : undefined;
    const job = jobFor({ job_id: `00000000-0000-4000-8000-00000000000${n}`, run_id: RUN_ID, continues: resumed ? { parent_run_id: "33333333-3333-4333-8333-333333333333", session_id: resumed.sessionId!, branch: "fx/x-g1" } : null, model_hint: null, ...over, task: { ...jobFor().task, prompt, prompt_sha256: jobFor({ task: { ...jobFor().task, prompt } }).task.prompt_sha256 } });
    const out = await runJob(job, {
      sandbox: host,
      workspaces,
      ledger: createMemoryLedger(),
      credentials: { mode: "subscription" },
      planSession: () => (resumed ? { kind: "resume", sessionId: resumed.sessionId!, workspace: resumed.workspace } : { kind: "fresh", branch: null }),
      defaultModel: "sonnet",
    });
    previous = out;
    return { stdin: fake.stdin(), out };
  }
  return { fake, rig, step };
}

describe("D#600 CX-6b: the context note at the next turn", () => {
  it("acceptance 1: last-turn context at 72% of 200,000 makes the next turn start with the note and the value 72; the first turn has none", async () => {
    const s = session();
    const first = await s.step(streamAt(144_000), { context_window: WINDOW });
    expect(first.out.status).toBe("done");
    expect(first.stdin).not.toContain("Context is at");
    const second = await s.step(streamAt(144_000), { context_window: WINDOW });
    expect(second.stdin.startsWith(`${NOTE(72)}\n\n`)).toBe(true);
    expect(second.stdin.split("Context is at")).toHaveLength(2);
    // The note carries one integer and nothing else.
    expect(second.stdin.split("\n")[0]!.replace("72", "N")).toBe(NOTE(0).replace("0", "N"));
  });

  it("acceptance 1: at 69%, or with a stream that carries no usage, the next turn has no note; 70% is the first value that does", async () => {
    for (const [tokens, expected] of [[138_000, false], [139_999, false], [140_000, true], [undefined, false]] as const) {
      const s = session();
      await s.step(streamAt(tokens), { context_window: WINDOW });
      const next = await s.step(streamAt(tokens), { context_window: WINDOW });
      expect(next.stdin.includes("Context is at"), String(tokens)).toBe(expected);
    }
  });

  it("acceptance 2: delivered once per value; a changed value is delivered again; a fall below 70 clears it", async () => {
    const s = session();
    await s.step(streamAt(144_000), { context_window: WINDOW });
    expect((await s.step(streamAt(144_000), { context_window: WINDOW })).stdin).toContain(NOTE(72));
    // The second command also ended at 72: nothing changed since delivery, so a third start does not repeat it.
    expect((await s.step(streamAt(144_000), { context_window: WINDOW })).stdin).not.toContain("Context is at");
    // It grew: a new value, a new note.
    expect((await s.step(streamAt(170_000), { context_window: WINDOW })).stdin).not.toContain("Context is at");
    expect((await s.step(streamAt(100_000), { context_window: WINDOW })).stdin).toContain(NOTE(85));
    // The last command ended at 50% (a compaction, say): the next turn starts clear.
    expect((await s.step(streamAt(100_000), { context_window: WINDOW })).stdin).not.toContain("Context is at");
    // A value that returns to a number once delivered is a change from the last one, and is told again.
    await s.step(streamAt(144_000), { context_window: WINDOW });
    expect((await s.step(streamAt(144_000), { context_window: WINDOW })).stdin).toContain(NOTE(72));
  });

  it("once per rise: 72, a fall to 50, then 72 again is told twice", async () => {
    const s = session();
    await s.step(streamAt(144_000), { context_window: WINDOW });
    expect((await s.step(streamAt(100_000), { context_window: WINDOW })).stdin).toContain(NOTE(72));
    expect((await s.step(streamAt(144_000), { context_window: WINDOW })).stdin).not.toContain("Context is at");
    expect((await s.step(streamAt(144_000), { context_window: WINDOW })).stdin).toContain(NOTE(72));
  });

  it("a job whose model has no window figure computes nothing and never notes, however full the context is", async () => {
    const s = session();
    await s.step(streamAt(199_000));
    const next = await s.step(streamAt(199_000));
    expect(next.stdin).not.toContain("Context is at");
    expect(Object.values(readSessionIndex(s.rig.config.sessionsFile)).every((e) => e.contextPct === undefined)).toBe(true);
  });

  it("acceptance 5: malformed usage never yields a note (strings, negatives, fractions, a ten-digit count), and a tampered index entry is not delivered", async () => {
    const bad: Array<(usage: Line) => void> = [
      (u) => (u.cache_read_input_tokens = "144000"),
      (u) => (u.cache_read_input_tokens = -144_000),
      (u) => (u.cache_read_input_tokens = 143_999.5),
      (u) => (u.cache_read_input_tokens = 1_234_567_890_123),
      (u) => (u.input_tokens = "072"),
    ];
    for (const mutate of bad) {
      const s = session();
      await s.step(streamAt(144_000, mutate), { context_window: WINDOW });
      const next = await s.step(streamAt(144_000, mutate), { context_window: WINDOW });
      expect(next.stdin).not.toContain("Context is at");
    }
    // An index entry edited by hand: only a whole number from 0 to 100 is read back at all.
    for (const tampered of ["072", 72.5, 101, -1, 1_234_567_890, "72", null]) {
      const s = session();
      const first = await s.step(streamAt(100_000), { context_window: WINDOW });
      if (first.out.status !== "done") throw new Error("expected done");
      const file = s.rig.config.sessionsFile;
      const index = JSON.parse(readFileSync(file, "utf8")) as Record<string, Line>;
      index[first.out.sessionId!]!.contextPct = tampered;
      writeFileSync(file, JSON.stringify(index));
      expect((await s.step(streamAt(100_000), { context_window: WINDOW })).stdin, String(tampered)).not.toContain("Context is at");
    }
  });

  it("acceptance 3: hooks stay off in the daemon's settings and no hook file is written", async () => {
    const s = session();
    await s.step(streamAt(144_000), { context_window: WINDOW });
    await s.step(streamAt(144_000), { context_window: WINDOW });
    const dir = path.join(s.rig.config.jobsDir, RUN_ID);
    const settings = JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8")) as Line;
    expect(settings.disableAllHooks).toBe(true);
    expect("hooks" in settings).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(["mcp.json", "settings.json"]);
    expect(JSON.stringify(settings)).not.toContain("Context is at");
  });

  it("acceptance 4: the note text is not in the done body; the ledger body carries the integers it always did and no stream text", async () => {
    const s = session();
    const first = await s.step(streamAt(144_000), { context_window: WINDOW });
    const second = await s.step(streamAt(144_000), { context_window: WINDOW });
    if (second.out.status !== "done" || second.out.contextLedger === undefined) throw new Error("expected a ledger");
    const body = JSON.stringify(contextLedgerToWire(second.out.contextLedger, []));
    expect(body).not.toContain("Context is at");
    expect(body).not.toContain("context_pct");
    expect(first.out.status).toBe("done");
    // The stored percentage is in the session index on this machine, nowhere else.
    expect(Object.values(readSessionIndex(s.rig.config.sessionsFile)).map((e) => e.contextPct)).toEqual([72]);
  });

  it("acceptance 2: the note is the context warning's line from the sandbox hook, and differs from the time and call warnings in code and text", () => {
    expect(contextNoteLine(72)).toBe(`${limitWarningText("context_warning", 72)}.`);
    expect(CONTEXT_WARNING_TEXT).toBe(LIMIT_WARNING_TEXT.context_warning);
    expect(CONTEXT_WARNING_CODE).toBe(LIMIT_WARNING_CODES.context);
    const codes = Object.values(LIMIT_WARNING_CODES);
    expect(new Set(codes).size).toBe(3);
    const texts = Object.values(LIMIT_WARNING_TEXT);
    expect(new Set(texts).size).toBe(3);
    for (const other of [LIMIT_WARNING_TEXT.time_warning, LIMIT_WARNING_TEXT.calls_warning]) expect(contextNoteLine(72)).not.toContain(other.replace("{N}", "72"));
    expect(CONTEXT_WARN_PCT).toBe(70);
  });

  it("a checkpoint turn is told the job's window, so the session it resumes is measured too", async () => {
    const seen: Array<{ contextWindowTokens?: number | undefined }> = [];
    const sandbox = {
      createSandbox: async () => ({ runId: "", sandboxName: "x", sessionId: "x" }),
      resume: (_h: unknown, _s: string, _p: string, opts: { contextWindowTokens?: number }) => {
        seen.push(opts);
        return { handle: { runId: RUN_ID }, hookFired: Promise.resolve(undefined) };
      },
      stop: async () => undefined,
      deleteSandbox: async () => undefined,
    } as unknown as SandboxPort;
    const job = jobFor({ context_window: WINDOW });
    const run = (j: typeof job) =>
      runCheckpointTurn({ job: j, sandbox, credentials: { mode: "subscription" }, defaultModel: "sonnet", workspace: "/tmp/x", sessionId: "sess-1", signal: new AbortController().signal, limitMs: 1000 });
    await run(job);
    const { context_window: _drop, ...without } = job;
    void _drop;
    await run(without as typeof job);
    expect(seen[0]!.contextWindowTokens).toBe(WINDOW);
    expect("contextWindowTokens" in seen[1]!).toBe(false);
  });
});
