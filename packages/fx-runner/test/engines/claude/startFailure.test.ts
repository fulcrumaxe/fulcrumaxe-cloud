import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { outcomeOf } from "../../../src/engines/claude/engine.js";
import { TAIL_CHARS, describeStartFailure, earlyExit, redactedTail } from "../../../src/sandbox/startFailure.js";
import type { SpawnFn } from "../../../src/engines/claude/capture.js";
import { AgentRunFailed, failureOf, startFailureOf } from "../../../src/sandbox/agentOutcome.js";
import { createClaudeEngine } from "../../../src/engines/claude/engine.js";
import { makeFake, makeRig } from "./rig.js";

// A token-shaped string built at run time, so no secret-looking literal sits in the source.
const TOKEN = `sk-ant-${"api03"}-${"A1b2C3d4E5".repeat(4)}`;

describe("an agent that fails to start says why (cause, exit, stderr tail)", () => {
  it("a shim that exits 3 with stderr boom and no output: exited_early, exit 3, boom in the tail", async () => {
    const fake = makeFake({ stream: "" });
    fake.set("stderr.txt", "boom\n");
    fake.set("exit-code", "3");
    const rig = makeRig({ fake });
    const { handle } = await createClaudeEngine(rig.config).start(rig.startOptions());
    const outcome = await outcomeOf(handle);
    expect(outcome.failureReason).toBe("agent_exit");
    expect(outcome.startFailure).toMatchObject({ cause: "exited_early", exitCode: 3 });
    expect(outcome.startFailure?.tail).toContain("boom");
    expect(describeStartFailure(outcome.startFailure!)).toBe('cause=exited_early exit=3 stderr_tail="boom\\n"');
  });

  it("the diagnostic reaches the job's error: AgentRunFailed carries it, and the reported code stays the closed reason", async () => {
    const fake = makeFake({ stream: "" });
    fake.set("stderr.txt", "boom\n");
    fake.set("exit-code", "3");
    const rig = makeRig({ fake });
    const { handle } = await createClaudeEngine(rig.config).start(rig.startOptions());
    const outcome = await outcomeOf(handle);
    const error = new AgentRunFailed(failureOf(outcome)!, startFailureOf(outcome));
    expect(error.code).toBe("agent_exit");
    expect(error.startFailure?.exitCode).toBe(3);
  });

  it("a binary that is gone when the run starts: spawn_failed with ENOENT, and the missing path is not left in the home form it had", async () => {
    const fake = makeFake({ stream: "" });
    const rig = makeRig({ fake });
    // The probes (--version, --help, auth status) reach the real shim; only the agent run itself is pointed at a path that does not exist.
    const probing = new Set(["--version", "--help", "auth"]);
    const spawnFn = ((command: string, args: readonly string[], options: unknown) => (probing.has(args[0] ?? "") ? spawn(command, args, options as never) : spawn("/home/nobody-fx/missing-agent", args, options as never))) as unknown as SpawnFn;
    const { handle } = await createClaudeEngine({ ...rig.config, spawn: spawnFn }).start(rig.startOptions());
    const outcome = await outcomeOf(handle);
    expect(outcome.failureReason).toBe("agent_exit");
    expect(outcome.startFailure).toMatchObject({ cause: "spawn_failed", errno: "ENOENT" });
    expect(outcome.startFailure?.tail).not.toContain("nobody-fx");
  });

  it("a token-shaped string in stderr is redacted", async () => {
    const fake = makeFake({ stream: "" });
    fake.set("stderr.txt", `auth failed for ${TOKEN} at /home/someone/.config/x\n`);
    fake.set("exit-code", "1");
    const rig = makeRig({ fake });
    const { handle } = await createClaudeEngine(rig.config).start(rig.startOptions());
    const tail = (await outcomeOf(handle)).startFailure?.tail ?? "";
    expect(tail).toContain("auth failed for");
    expect(tail).not.toContain(TOKEN);
    expect(tail).not.toContain("A1b2C3d4E5");
    expect(tail).not.toContain("someone");
  });

  it("a run that produced output and then failed has no start failure", async () => {
    const fake = makeFake();
    fake.set("exit-code", "1");
    const rig = makeRig({ fake });
    const { handle } = await createClaudeEngine(rig.config).start(rig.startOptions());
    expect((await outcomeOf(handle)).startFailure).toBeUndefined();
  });
});

/** More than 8 KB of repeated credentials whose last 8192 characters start 20 characters into one of them. */
function windowedStderr(): string {
  for (let n = 200; n < 400; n += 1) {
    const raw = `x${` ${TOKEN}`.repeat(n)} yyyy`;
    if (raw.slice(-8192).startsWith(TOKEN.slice(20) + " ")) return raw;
  }
  throw new Error("no fixture length found");
}

describe("the tail", () => {
  it("is capped at 2 KB, taken from the end, and a token cut by the cap is still redacted whole", () => {
    const raw = `first-line-should-go\n${"x".repeat(5000)}${TOKEN} ${"y".repeat(2040)}`;
    const tail = redactedTail(raw, []);
    expect(tail.length).toBeLessThanOrEqual(TAIL_CHARS);
    expect(tail).not.toContain("first-line-should-go");
    expect(tail).not.toContain("A1b2C3d4E5");
    expect(tail.endsWith("y".repeat(100))).toBe(true);
  });

  it("blanks known secret values, the home directory, other users' home paths and control characters", () => {
    const text = redactedTail("key=hunter2-value /srv/h/jane/x /home/bob/y C:\\Users\\al\\z \u001b[31mred", ["hunter2-value"], "/srv/h/jane");
    expect(text).not.toMatch(/hunter2|jane|bob|\\al\\|\u001b/);
    expect(text).toContain("~");
  });

  it("a token straddling the start of the 8 KB window leaves no fragment", () => {
    const raw = windowedStderr();
    expect(raw.length).toBeGreaterThan(8192);
    expect(raw.slice(-8192).startsWith(TOKEN.slice(20))).toBe(true);
    // The window is full of credentials that shrink under redaction, so its first fragment would land inside the 2 KB tail if it were kept.
    const tail = redactedTail(raw, []);
    expect(tail).toContain("[redacted]");
    expect(tail).not.toContain(TOKEN.slice(20, 40));
    // the caller's own rolling window (already cut, and not longer than the window) is handled the same way
    const cutTail = redactedTail(raw.slice(-8192), [], undefined, true);
    expect(cutTail).not.toContain(TOKEN.slice(20, 40));
  });

  it("the stream path drops the cut token's fragment: a CLI writing more than 8 KB of stderr that starts mid-token leaves none in the tail", async () => {
    const fake = makeFake({ stream: "" });
    fake.set("stderr.txt", windowedStderr());
    fake.set("exit-code", "3");
    const rig = makeRig({ fake });
    const { handle } = await createClaudeEngine(rig.config).start(rig.startOptions());
    const tail = (await outcomeOf(handle)).startFailure?.tail ?? "";
    expect(tail).toContain("[redacted]");
    expect(tail).not.toContain(TOKEN.slice(20, 40));
  });

  it("a repeated credential that shrinks under redaction leaves no fragment", () => {
    const raw = `${TOKEN} `.repeat(300);
    expect(raw.length).toBeGreaterThan(8192);
    const tail = redactedTail(raw, []);
    expect(tail).not.toContain("A1b2C3d4E5");
    expect(tail).not.toMatch(/sk-ant|4E5A1b2/);
    expect(tail).toContain("[redacted]");
  });

  it.each([["C1 control", "\u0085"], ["C1 end", "\u009f"], ["LRM", "\u200e"], ["RLM", "\u200f"], ["LRE", "\u202a"], ["RLO", "\u202e"], ["LRI", "\u2066"], ["PDI", "\u2069"], ["line separator", "\u2028"], ["paragraph separator", "\u2029"]])("%s is blanked", (_name, ch) => {
    const tail = redactedTail(`a${ch}b`, []);
    expect(tail).toBe("a b");
  });

  it("secrets are redacted before home paths are blanked, and a lowercase Windows home matches", () => {
    // the secret spans a home path's name and the next segment: blanking the path first would split it and leave "hunter2"
    expect(redactedTail("x /home/bob/hunter2 y", ["bob/hunter2"])).toBe("x ~ y");
    expect(redactedTail("c:\\users\\al\\z", [])).not.toContain("al");
  });

  it("a signal end is cause signal, with the signal name and no code", () => {
    expect(earlyExit({ code: null, signal: "SIGSEGV" }, "oops", [])).toEqual({ cause: "signal", signal: "SIGSEGV", tail: "oops" });
  });
});
