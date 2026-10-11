import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

export interface GroupResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the per-spawn timeout fired and the whole group was killed. */
  timedOut: boolean;
}

/** Every process group a test started and has not seen finish, so a hook can sweep what a failed or timed-out test left behind. */
const live = new Set<number>();

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // the group is already gone
  }
}

/**
 * Runs `file` in its own process group, with a deadline that is shorter than the test's, and always kills the whole group
 * afterwards: a grandchild that outlives its parent (a fake tool spinning under a shell that has exited, or one that
 * never exits at all) must not outlive the test. Never rejects on a timeout: the result says `timedOut`.
 */
export function runGrouped(file: string, args: string[], env: Record<string, string>, opts: { stdin?: string; timeoutMs?: number } = {}): Promise<GroupResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, detached: true, stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const pid = child.pid;
    if (pid !== undefined) live.add(pid);
    if (opts.stdin !== undefined) {
      child.stdin?.on("error", () => undefined); // the child may exit before it has read everything
      child.stdin?.end(opts.stdin);
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      timedOut = true;
      if (pid !== undefined) killGroup(pid);
    }, opts.timeoutMs ?? 20_000);
    const finish = (): void => {
      clearTimeout(timer);
      if (pid !== undefined) {
        killGroup(pid);
        live.delete(pid);
      }
    };
    child.on("error", (e) => {
      finish();
      reject(e);
    });
    // `close` waits for every holder of the output pipes, so a grandchild that outlives its parent would keep this pending
    // until the deadline; kill the group as soon as the child itself has exited (what was written is still in the pipe).
    child.on("exit", () => {
      if (pid !== undefined) killGroup(pid);
    });
    child.on("close", (code) => {
      finish();
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** Kills every group `runGrouped` started that is still recorded. Call from afterEach. */
export function killAllGroups(): void {
  for (const pid of live) killGroup(pid);
  live.clear();
}

/** PIDs whose command line contains `needle`, read from /proc (no `pgrep` needed), excluding this process. Empty where /proc is absent. */
export function pidsWithCommandLine(needle: string): number[] {
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return [];
  }
  const found: number[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${name}/cmdline`, "utf8").includes(needle)) found.push(Number(name));
    } catch {
      // gone, or not ours to read
    }
  }
  return found;
}
