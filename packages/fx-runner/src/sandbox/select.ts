import { accessSync, constants } from "node:fs";
import path from "node:path";
import type { IsolationTier } from "@fulcrumaxe/runner-protocol";
import { SandboxRefused, detectPlatform, type PlatformProbe } from "./platform.js";

/** Whether `name` is an executable in one of the directories of `pathValue` (a PATH string, taken by the caller from the clean environment). */
export function commandOnPath(name: string, pathValue: string): boolean {
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir === "") continue;
    try {
      accessSync(path.join(dir, name), constants.X_OK);
      return true;
    } catch {
      // fx-swallow-ok: not executable in this directory; the next one may be
    }
  }
  return false;
}

export interface SelectDeps extends PlatformProbe {
  /** Whether a command is installed; the daemon passes `(name) => commandOnPath(name, pathValue)`. */
  hasCommand: (name: string) => boolean;
}

/**
 * The isolation tier for this machine. Only tier (d) exists in this build, so the answer is `host_sandbox` or a
 * `SandboxRefused`: there is no `none`, and no unsandboxed path. The shell sandbox needs bubblewrap and socat on Linux
 * and WSL2; macOS has its own built in.
 */
export function selectTier(deps: SelectDeps): IsolationTier {
  const platform = detectPlatform(deps);
  if (platform !== "macos") {
    const has = deps.hasCommand;
    if (!has("bwrap")) throw new SandboxRefused("bubblewrap_missing");
    if (!has("socat")) throw new SandboxRefused("socat_missing");
  }
  return "host_sandbox";
}
