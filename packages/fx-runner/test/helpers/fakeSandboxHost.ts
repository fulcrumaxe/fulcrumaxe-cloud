import { PROBE_MARKER, type SandboxHost } from "../../src/sandbox/probe.js";

export interface RunCall {
  command: string;
  args: readonly string[];
  env: Record<string, string>;
  timeoutMs: number;
}

type Outcome = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

export const PASSING: Outcome = { code: 0, stdout: PROBE_MARKER, stderr: "", timedOut: false };
export const failing = (stderr: string, code: number | null = 1): Outcome => ({ code, stdout: "", stderr, timedOut: false });

export interface FakeSandboxHost extends SandboxHost {
  calls: RunCall[];
}

/** A machine that exists only in the test: the files and directories it has, and what the sandbox tool answers. No process is started. */
export function fakeSandboxHost(over: { files?: Record<string, string>; sysctls?: Record<string, string>; dirs?: readonly string[]; outcome?: Outcome } = {}): FakeSandboxHost {
  const files = over.files ?? {};
  const dirs = new Set(over.dirs ?? []);
  const calls: RunCall[] = [];
  return {
    calls,
    run: async (command, args, env, timeoutMs) => {
      calls.push({ command, args, env, timeoutMs });
      return over.outcome ?? PASSING;
    },
    sysctl: async (name) => (over.sysctls !== undefined && Object.hasOwn(over.sysctls, name) ? over.sysctls[name] : undefined),
    isDir: (target) => dirs.has(target),
    isFile: (target) => Object.hasOwn(files, target),
    readText: (target) => (Object.hasOwn(files, target) ? files[target] : undefined),
  };
}
