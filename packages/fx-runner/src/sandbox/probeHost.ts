/**
 * The real machine behind the sandbox probe (D#6 R4a-5): the process start is the engine kit's bounded, shell-less capture (this file
 * starts no process of its own), and the file reads are small and bounded. Only `bin/fx-runner.mjs` calls this.
 */
import { readFileSync, statSync } from "node:fs";
import type { SandboxHost } from "./probe.js";

const READ_MAX_BYTES = 64 * 1024;
const SYSCTL_PATH = "/usr/sbin:/sbin:/usr/bin:/bin:/run/current-system/sw/bin";
const SYSCTL_TIMEOUT_MS = 5_000;

export function createSandboxHost(run: SandboxHost["run"]): SandboxHost {
  const stat = (target: string): ReturnType<typeof statSync> | undefined => {
    try {
      return statSync(target);
    } catch {
      // fx-swallow-ok: a path that is not there or cannot be read simply is not a directory or a file
      return undefined;
    }
  };
  return {
    run,
    sysctl: async (name) => {
      if (!/^[a-z_]{1,32}(?:\.[a-z_]{1,48}){1,3}$/.test(name)) return undefined;
      // The settings are read with the system's own `sysctl` (never a path into the process table), from the directories it lives in.
      const out = await run("sysctl", ["-n", name], { PATH: SYSCTL_PATH, LC_ALL: "C" }, SYSCTL_TIMEOUT_MS);
      return out.code === 0 && !out.timedOut ? out.stdout : undefined;
    },
    isDir: (target) => stat(target)?.isDirectory() === true,
    isFile: (target) => stat(target)?.isFile() === true,
    readText: (target) => {
      try {
        // A /proc file reports size 0, so only a file that claims to be large is refused.
        if ((stat(target)?.size ?? 0) > READ_MAX_BYTES) return undefined;
        return readFileSync(target, "utf8");
      } catch {
        // fx-swallow-ok: a file that cannot be read is the same as one that is not there for the checks that ask
        return undefined;
      }
    },
  };
}
