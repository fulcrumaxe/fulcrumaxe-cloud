import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DRAIN_QUIET_MS, askOnTerminal, type TerminalIn } from "../src/ttyAsk.js";

/** A stream that says it is a terminal. */
const terminal = (): PassThrough & TerminalIn => Object.assign(new PassThrough(), { isTTY: true as const });
/** Waits until the question has been drawn (the stream was quiet for the drain period), as a person who reads it first would. */
const drawn = async (out: string[]): Promise<void> => {
  for (let i = 0; i < 200 && out.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
};

describe("askOnTerminal: the answer comes from the terminal only", () => {
  it("draws the question as given and returns the first line typed, without its line end", async () => {
    const input = terminal();
    const out: string[] = [];
    const answer = askOnTerminal(input, (t) => out.push(t), "Send? [y/N] ", 5_000);
    await drawn(out);
    input.write("yes\r\nsecond line\n");
    expect(await answer).toBe("yes");
    expect(out).toEqual(["Send? [y/N] "]);
  });

  it("a stream that is not a terminal (a pipe, a file) is never read and the answer is undefined, even if it holds a y", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: false });
    input.write("y\n");
    const out: string[] = [];
    expect(await askOnTerminal(input, (t) => out.push(t), "Send? ", 50)).toBeUndefined();
    expect(out).toEqual([]);
    expect(input.readableLength).toBeGreaterThan(0);
    expect(await askOnTerminal(new PassThrough(), () => undefined, "Send? ", 50)).toBeUndefined();
  });

  it("a timeout, an input that ends, an input that closes and an error are all undefined, never a line", async () => {
    expect(await askOnTerminal(terminal(), () => undefined, "q ", 20)).toBeUndefined();
    const ended = terminal();
    const a = askOnTerminal(ended, () => undefined, "q ", 5_000);
    ended.end();
    expect(await a).toBeUndefined();
    const closed = terminal();
    const b = askOnTerminal(closed, () => undefined, "q ", 5_000);
    closed.destroy();
    expect(await b).toBeUndefined();
    const broken = terminal();
    const c = askOnTerminal(broken, () => undefined, "q ", 5_000);
    broken.destroy(new Error("EIO"));
    expect(await c).toBeUndefined();
  });

  it("a partial line is not an answer, and an endless line is cut off as no answer", async () => {
    const input = terminal();
    const outA: string[] = [];
    const a = askOnTerminal(input, (t) => outA.push(t), "q ", DRAIN_QUIET_MS + 150);
    await drawn(outA);
    input.write("y");
    expect(await a).toBeUndefined();
    const long = terminal();
    const outB: string[] = [];
    const b = askOnTerminal(long, (t) => outB.push(t), "q ", 5_000);
    await drawn(outB);
    long.write("y".repeat(300));
    expect(await b).toBeUndefined();
  });

  it("keys typed before the question is drawn answer nothing: they are thrown away, held in the stream or arriving while it is being drawn", async () => {
    const held = terminal();
    held.write("y\ny\n");
    const out: string[] = [];
    const a = askOnTerminal(held, (t) => out.push(t), "Q? ", DRAIN_QUIET_MS + 300);
    expect(await a).toBeUndefined();
    expect(out.join("")).toBe("Q? \n");
    // Typed while the drain is running (after the call, before the question is drawn).
    const late = terminal();
    const outLate: string[] = [];
    const b = askOnTerminal(late, (t) => outLate.push(t), "Q? ", 5_000);
    late.write("y\n");
    await new Promise((resolve) => setTimeout(resolve, DRAIN_QUIET_MS / 2));
    late.write("y\n");
    await drawn(outLate);
    late.write("n\n");
    expect(await b).toBe("n");
  });

  it("an abort (Ctrl-C) ends the open question as no at once, and a question asked after an abort or after the input ended does not wait", async () => {
    const input = terminal();
    const controller = new AbortController();
    const out: string[] = [];
    const a = askOnTerminal(input, (t) => out.push(t), "Q? ", 60_000, controller.signal);
    await drawn(out);
    const started = Date.now();
    controller.abort();
    expect(await a).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await askOnTerminal(terminal(), () => undefined, "Q? ", 60_000, controller.signal)).toBeUndefined();
    const ended = terminal();
    ended.end();
    ended.resume();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const t0 = Date.now();
    expect(await askOnTerminal(ended, () => undefined, "Q? ", 60_000)).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("a Ctrl-D (end of input) on one question makes the next return at once rather than wait out its time", async () => {
    const input = terminal();
    const out: string[] = [];
    const first = askOnTerminal(input, (t) => out.push(t), "Q? ", 60_000);
    await drawn(out);
    input.end();
    expect(await first).toBeUndefined();
    const t0 = Date.now();
    expect(await askOnTerminal(input, () => undefined, "Q? ", 60_000)).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("takes no argument that the agent could fill: only the stream, the writer, the question, the time and the abort signal", () => {
    expect(askOnTerminal.length).toBe(5);
  });
});

/**
 * A real pseudo-terminal: python's pty module runs a child with the pty as its controlling terminal, and the child asks the question with this module through
 * Node's own type stripping. Skipped where there is no python3 with the pty module (Windows) or no Node that runs TypeScript.
 */
const python = spawnSync("python3", ["-c", "import pty, os"], { encoding: "utf8" });
const havePty = process.platform !== "win32" && python.status === 0;
describe.skipIf(!havePty)("askOnTerminal on a real pseudo-terminal", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "fxr-pty-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const ttyAsk = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "ttyAsk.ts");
  const child = `
import { writeFileSync } from "node:fs";
import { askOnTerminal } from ${JSON.stringify(ttyAsk)};
const answer = await askOnTerminal(process.stdin, (t) => process.stdout.write(t), "Q? ", Number(process.argv[3]));
writeFileSync(process.argv[2], JSON.stringify({ isTTY: process.stdin.isTTY === true, answer: answer ?? null }));
`;
  // The parent plays the person: it types `typed` (if any) into the pty after the child has drawn its question, and reports what the child wrote.
  const driver = `
import os, pty, sys, time, select
script, out, typed, wait_ms, early = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[6]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[5], [sys.argv[5], "--no-warnings", script, out, wait_ms])
if early:
    os.write(fd, early.encode().decode("unicode_escape").encode())
seen = b""
deadline = time.time() + 20
typed_done = False
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try:
            chunk = os.read(fd, 1024)
        except OSError:
            break
        if not chunk:
            break
        seen += chunk
        if typed and not typed_done and b"Q? " in seen:
            os.write(fd, typed.encode().decode("unicode_escape").encode())
            typed_done = True
    done, status = os.waitpid(pid, os.WNOHANG)
    if done:
        break
sys.stdout.write("drawn:" + ("Q? " in seen.decode(errors="replace")).__str__())
`;
  const run = (typed: string, waitMs: number, early = ""): { drawn: boolean; result: { isTTY: boolean; answer: string | null } } => {
    writeFileSync(path.join(dir, "child.ts"), child);
    writeFileSync(path.join(dir, "driver.py"), driver);
    const outFile = path.join(dir, "out.json");
    const res = spawnSync("python3", ["-I", path.join(dir, "driver.py"), path.join(dir, "child.ts"), outFile, typed, String(waitMs), process.execPath, early], { encoding: "utf8", timeout: 30_000 });
    return { drawn: /drawn:True/.test(res.stdout), result: JSON.parse(readFileSync(outFile, "utf8")) };
  };

  it("the child sees a terminal, draws the question on it, and returns what the person typed", () => {
    const { drawn, result } = run("y\\r", 15_000);
    expect(drawn).toBe(true);
    expect(result).toEqual({ isTTY: true, answer: "y" });
  });

  it("keys typed before the question is drawn (y, Enter, y, Enter) answer nothing", () => {
    const { drawn: wasDrawn, result } = run("", 1_200, "y\\ny\\n");
    expect(wasDrawn).toBe(true);
    expect(result).toEqual({ isTTY: true, answer: null });
  });

  it("with nobody typing, the question times out as no answer", () => {
    const { result } = run("", 300);
    expect(result).toEqual({ isTTY: true, answer: null });
  });
});
