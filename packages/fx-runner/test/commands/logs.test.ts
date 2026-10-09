import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError } from "../../src/cliError.js";
import type { CommandContext } from "../../src/context.js";
import { logsCommand } from "../../src/commands/logs.js";
import { runCli } from "../../src/cli.js";
import { createRunLog } from "../../src/engines/claude/stream.js";
import { fixtureText } from "../engines/claude/harness.js";

const RUN = "3f6c1a52-8d0e-4b7a-9c14-0a5e6d2b7f38";
let root: string;
let stateDir: string;
let logDir: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fxr-logs-"));
  stateDir = path.join(root, "state");
  logDir = path.join(stateDir, "logs");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function print(run: string | undefined): { code: number; lines: string[] } {
  const lines: string[] = [];
  const ctx: CommandContext = { stateDir, out: (l) => lines.push(l), err: (l) => lines.push(l), now: () => new Date(), fetchFn: fetch };
  return { code: logsCommand(run, ctx), lines };
}

/** The engine's own log writer, so the file is exactly what a run leaves. */
function writeRun(secrets: string[], records: Array<["stdout" | "stderr" | "meta", string]>): string {
  const log = createRunLog(logDir, RUN, secrets);
  for (const [kind, line] of records) log.write(kind, line);
  return log.file;
}

const assistant = (blocks: unknown[]): string => JSON.stringify({ type: "assistant", session_id: "s1", message: { id: "m1", content: blocks } });

describe("what is printed", () => {
  it("renders agent text, tool uses, tool results, the result and the engine notes from a real captured stream", () => {
    const records: Array<["stdout" | "stderr" | "meta", string]> = [["meta", JSON.stringify({ engine_version: "2.1.294" })], ...fixtureText("stream.tooluse.synthetic.jsonl").split("\n").filter(Boolean).map((l): ["stdout", string] => ["stdout", l]), ["stderr", "a warning on stderr"]];
    writeRun([], records);
    const { code, lines } = print(RUN);
    expect(code).toBe(0);
    expect(lines).toContain('meta: {"engine_version":"2.1.294"}');
    expect(lines).toContain("stderr: a warning on stderr");
    expect(lines.some((l) => l.startsWith("assistant: "))).toBe(true);
    expect(lines.some((l) => l.startsWith("  tool: "))).toBe(true);
    expect(lines.some((l) => l.startsWith("result: "))).toBe(true);
  });

  it("shows a tool use as the shared mapper reduces it, never the tool's other input; a file path outside any known repo root is dropped", () => {
    writeRun([], [["stdout", assistant([
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "echo hi", secret_field: "do-not-print" } },
      { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/work/repo/src/a.ts" } },
    ])]]);
    const lines = print(RUN).lines;
    expect(lines).toEqual(["  tool: command echo hi"]);
  });

  it("prints a line that is not JSON as it is, and skips a damaged record", () => {
    const file = writeRun([], [["stdout", "plain text from the agent"]]);
    writeFileSync(file, "this is not a record\n", { flag: "a" });
    expect(print(RUN).lines).toEqual(["plain text from the agent"]);
  });
});

describe("secrets and the terminal", () => {
  it("a credential value is gone from the file already, and a token shape that slipped in is redacted again on the way out", () => {
    const known = ["sk-ant-", "oat01-", "known-secret-value-0123456789"].join("");
    const file = writeRun([known], [["stdout", assistant([{ type: "text", text: `token ${known}` }])]]);
    expect(file).toBeDefined();
    // A value no run knew about, written straight into the file (as a bug or an old build might have left it).
    const unknown = ["sk-ant-", "api03-", "unknown-0123456789abcdefghijklmnop"].join("");
    writeFileSync(file, `${JSON.stringify({ kind: "stderr", line: `leaked ${unknown}` })}\n`, { flag: "a" });
    const out = print(RUN).lines.join("\n");
    expect(out).not.toContain(known);
    expect(out).not.toContain(unknown);
    expect(out).toContain("assistant: token ");
  });

  it("control characters and escape sequences are dropped, newlines and tabs stay, and a secret split by one is still redacted", () => {
    const secret = ["sk-ant-", "a", "pi03-", "split0123456789abcdefghijklmnopqrstuv"].join("");
    const split = `${secret.slice(0, 8)}\u0000${secret.slice(8)}`;
    writeRun([], [["stdout", assistant([{ type: "text", text: `a\u001b[31mred\u001b[0m\u0007 b\tc\nsecond ${split}` }])]]);
    const out = print(RUN).lines.join("\n");
    expect(out).toContain("a[31mred[0m b\tc\n  | second");
    expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(out).not.toContain(secret);
  });

  it("a newline inside agent text cannot make a line that looks like ours: continuation lines are marked", () => {
    writeRun([], [["stdout", assistant([{ type: "text", text: "first\nmeta: {\"engine_version\":\"9.9.9\"}\nresult: all good" }])]]);
    const lines = print(RUN).lines;
    expect(lines).toEqual(["assistant: first", '  | meta: {"engine_version":"9.9.9"}', "  | result: all good"]);
    expect(lines.filter((l) => /^(meta|result|stderr):/.test(l))).toEqual([]);
  });

  it("U+2028 and U+2029 split a line like a newline does, in agent text and in stderr and meta lines, so a viewer shows no faked meta: or result: line", () => {
    const ls = String.fromCharCode(0x2028);
    const ps = String.fromCharCode(0x2029);
    writeRun([], [
      ["stdout", assistant([{ type: "text", text: `first${ls}meta: {"engine_version":"9.9.9"}${ps}result: all good` }])],
      ["stderr", `warn${ls}result: faked`],
      ["meta", `{"a":1}${ps}stderr: faked`],
    ]);
    const lines = print(RUN).lines;
    expect(lines).toEqual([
      "assistant: first", '  | meta: {"engine_version":"9.9.9"}', "  | result: all good",
      "stderr: warn", "  | result: faked",
      'meta: {"a":1}', "  | stderr: faked",
    ]);
    expect(lines.join("\n")).not.toContain(ls);
    expect(lines.join("\n")).not.toContain(ps);
    expect(lines.filter((l) => /^(meta|result):/.test(l))).toEqual(['meta: {"a":1}']);
  });

  it("a transcript over 64 MiB is refused with a plain message before it is read", () => {
    const file = writeRun([], [["stdout", "x"]]);
    truncateSync(file, 64 * 1024 * 1024 + 1);
    expect(() => print(RUN)).toThrow(/too large to print/);
  });

  it("a very long line is cut", () => {
    writeRun([], [["stdout", assistant([{ type: "text", text: "x".repeat(100_000) }])]]);
    const out = print(RUN).lines.join("\n");
    expect(out.length).toBeLessThan(21_000);
    expect(out).toContain("(cut)");
  });
});

describe("which file it reads", () => {
  it("refuses a run id that is not a uuid before touching the disk, so no path can be reached through it", () => {
    for (const bad of ["../registration", "..", "a/b", "3f6c1a52", `${RUN}.jsonl`, "", " "]) expect(() => print(bad), bad).toThrow(/run_id_invalid/);
    expect(() => print(undefined)).toThrow(expect.objectContaining({ exitCode: 2 }));
  });

  it("says plainly when this machine has no log for the run", () => {
    expect(() => print(RUN)).toThrow(/run_log_missing/);
    mkdirSync(logDir, { recursive: true });
    expect(() => print(RUN)).toThrow(CliError);
  });

  it("refuses a log other users can read, and a link in its place", () => {
    const file = writeRun([], [["stdout", "x"]]);
    chmodSync(file, 0o644);
    expect(() => print(RUN)).toThrow(/can be read by other users/);
    rmSync(file);
    const elsewhere = path.join(root, "elsewhere.jsonl");
    writeFileSync(elsewhere, `${JSON.stringify({ kind: "stdout", line: "from elsewhere" })}\n`, { mode: 0o600 });
    symlinkSync(elsewhere, file);
    expect(() => print(RUN)).toThrow(/not a plain file/);
  });

  it("reads only the runner's own log directory: Claude Code's project logs are never opened", () => {
    writeRun([], [["stdout", "x"]]);
    const projects = path.join(root, "home", ".claude", "projects");
    mkdirSync(projects, { recursive: true });
    writeFileSync(path.join(projects, `${RUN}.jsonl`), `${JSON.stringify({ kind: "stdout", line: "claude's own" })}\n`, { mode: 0o600 });
    expect(print(RUN).lines).toEqual(["x"]);
  });
});

describe("through the command line", () => {
  it("prints the transcript, and rejects a missing or extra argument with exit 2", async () => {
    writeRun([], [["stdout", "hello from the agent"]]);
    let out = "";
    const io = { home: root, stateDirOverride: stateDir, stdout: (t: string) => (out += t), stderr: () => undefined };
    expect(await runCli({ ...io, argv: ["logs", RUN] })).toBe(0);
    expect(out).toBe("hello from the agent\n");
    expect(await runCli({ ...io, argv: ["logs"] })).toBe(2);
    expect(await runCli({ ...io, argv: ["logs", RUN, "extra"] })).toBe(2);
    expect(await runCli({ ...io, argv: ["logs", "../x"] })).toBe(2);
    expect(await runCli({ ...io, argv: ["logs", "00000000-0000-4000-8000-000000000000"] })).toBe(1);
  });
});
