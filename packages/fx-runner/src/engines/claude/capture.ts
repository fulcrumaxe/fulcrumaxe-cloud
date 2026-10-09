import type { spawn } from "node:child_process";

export type SpawnFn = typeof spawn;

const DEFAULT_CAPTURE_CHARS = 64 * 1024;

export interface Captured {
  code: number | null;
  stdout: string;
  /** Only filled when the caller asked for it (`stderrChars` above 0); empty otherwise. */
  stderr?: string;
  timedOut: boolean;
}

/**
 * Runs `command args` with an explicit environment, no shell and a time limit, and returns its exit code and the first
 * `maxChars` (64 K by default) of its output (and, only when `stderrChars` is above 0, that many characters of its error output). Used for the short questions asked of the pinned binary (`--version`, `auth status`); a model
 * run uses the engine's own spawn.
 */
export function runCapture(spawnFn: SpawnFn, command: string, args: readonly string[], env: Record<string, string>, timeoutMs: number, maxChars: number = DEFAULT_CAPTURE_CHARS, stderrChars = 0): Promise<Captured> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    const child = spawnFn(command, [...args], { env, shell: false, stdio: ["ignore", "pipe", stderrChars > 0 ? "pipe" : "ignore"] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < maxChars) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < stderrChars) stderr += chunk.toString("utf8").slice(0, stderrChars - stderr.length);
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

/**
 * Runs `command args` in the foreground with the terminal's own streams, an explicit environment and no shell, and resolves with its exit
 * code (null when it could not start or was killed). For the two interactive commands: the tmux client of `attach`, and the agent a take-over resumes.
 */
export function runForeground(spawnFn: SpawnFn, command: string, args: readonly string[], env: Record<string, string>, cwd?: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawnFn(command, [...args], { cwd, env, shell: false, stdio: "inherit" });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  });
}
