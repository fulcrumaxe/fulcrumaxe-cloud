import type { spawn } from "node:child_process";

export type SpawnFn = typeof spawn;

const DEFAULT_CAPTURE_CHARS = 64 * 1024;

export interface Captured {
  code: number | null;
  stdout: string;
  timedOut: boolean;
}

/**
 * Runs `command args` with an explicit environment, no shell and a time limit, and returns its exit code and the first
 * `maxChars` (64 K by default) of its output. Used for the short questions asked of the pinned binary (`--version`, `auth status`); a model
 * run uses the engine's own spawn.
 */
export function runCapture(spawnFn: SpawnFn, command: string, args: readonly string[], env: Record<string, string>, timeoutMs: number, maxChars: number = DEFAULT_CAPTURE_CHARS): Promise<Captured> {
  return new Promise((resolve) => {
    let stdout = "";
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, timedOut });
    };
    const child = spawnFn(command, [...args], { env, shell: false, stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < maxChars) stdout += chunk.toString("utf8");
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}
