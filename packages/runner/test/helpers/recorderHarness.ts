import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FX_RECORDER_SCRIPT } from "../../src/agentConfig.js";
import { acceptRecords, type Accepted } from "../../src/recordParser.js";

/** A throwaway directory holding the real recorder script, one per test. */
export function recorderDir(): { dir: string; script: string; rec: string; procs: ChildProcess[]; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "rlr3a-"));
  const script = join(dir, "recorder.mjs");
  writeFileSync(script, FX_RECORDER_SCRIPT, { mode: 0o444 });
  const procs: ChildProcess[] = [];
  /** Leave nothing running, even when a test failed half way: the recorders, and any pid a child wrote into this directory. */
  const done = (): void => {
    for (const p of procs) if (p.pid !== undefined) kill9(p.pid);
    for (const f of ["kid.pid", "kid.pid.child", "orphan.pid"]) {
      const file = join(dir, f);
      if (existsSync(file)) kill9(Number(readFileSync(file, "utf8").trim()));
    }
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, script, rec: join(dir, "run.rec"), procs, done };
}

function kill9(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (e) {
    // The process exited between the check and the kill: that is the outcome cleanup wants. Anything else is real.
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }
}

export interface RecorderRun {
  proc: ChildProcess;
  /** Resolves when the recorder's stdout and stderr have closed (the Vercel command is over). */
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }>;
  out: () => Buffer;
  err: () => string;
}

/** Spawn the real recorder over `cmd`. */
export function startRecorder(d: { script: string; rec: string; procs?: ChildProcess[] }, cmd: string[], runId = "run-x"): RecorderRun {
  const t0 = Date.now();
  const proc = spawn(process.execPath, [d.script, d.rec, runId, "--", ...cmd], { stdio: ["ignore", "pipe", "pipe"] });
  d.procs?.push(proc);
  const outs: Buffer[] = [];
  let err = "";
  proc.stdout!.on("data", (c: Buffer) => outs.push(c));
  proc.stderr!.setEncoding("utf8").on("data", (c: string) => (err += c));
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }>((res) =>
    proc.on("close", (code, signal) => res({ code, signal, ms: Date.now() - t0 })),
  );
  return { proc, closed, out: () => Buffer.concat(outs), err: () => err };
}

/** Run the recorder to the end. */
export async function runRecorder(d: { script: string; rec: string; procs?: ChildProcess[] }, cmd: string[]): Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number; echo: Buffer; err: string; file: Buffer; parsed: Accepted }> {
  const r = startRecorder(d, cmd);
  const end = await r.closed;
  const file = existsSync(d.rec) ? readFileSync(d.rec) : Buffer.alloc(0);
  return { ...end, echo: r.out(), err: r.err(), file, parsed: acceptRecords(file, 0) };
}

/** A node child as a command: `node -e <js>`. */
export const nodeCmd = (js: string, ...args: string[]): string[] => [process.execPath, "-e", js, ...args];

export const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Wait until `f` is true, polling. */
export async function until(f: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error("until: timed out");
    await sleep(25);
  }
}
