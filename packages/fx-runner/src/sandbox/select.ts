import { accessSync, constants, statSync } from "node:fs";
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
 * `SandboxRefused`: there is no `none`, and no unsandboxed path. The shell sandbox needs bubblewrap and socat on Linux;
 * macOS has its own built in.
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

/** The shell sandbox's own tools, as absolute paths found at setup. */
export interface SandboxTools {
  bwrap: string;
  socat: string;
}

/** The first absolute directory of `searchPath` that holds an executable file called `name`, joined to it; undefined when none does. */
function findExecutable(name: string, searchPath: string): string | undefined {
  for (const dir of searchPath.split(path.delimiter)) {
    if (dir === "" || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // fx-swallow-ok: not an executable file in this directory; the next one may be
    }
  }
  return undefined;
}

/**
 * Setup time only (next to `resolveClaudePath`): where bubblewrap and socat are, as absolute paths to store with the
 * binary's own. Claude Code's shell sandbox starts `bwrap` and `socat` by name from the agent's PATH, and its own
 * settings keys for them (`sandbox.bwrapPath`, `sandbox.socatPath`) are honoured from managed settings only, so a
 * runner cannot hand them over in the per-job settings file. What it can do is put their directories on the agent's
 * PATH: pass `sandboxToolDirs(tools)` as `extraPathDirs` wherever `cleanEnv` is called. macOS needs neither
 * (`undefined`). A missing tool is the same refusal `selectTier` gives, so setup and the tier check agree.
 */
export function resolveSandboxTools(searchPath: string, probe: PlatformProbe = {}): SandboxTools | undefined {
  if (detectPlatform(probe) === "macos") return undefined;
  const bwrap = findExecutable("bwrap", searchPath);
  if (bwrap === undefined) throw new SandboxRefused("bubblewrap_missing");
  const socat = findExecutable("socat", searchPath);
  if (socat === undefined) throw new SandboxRefused("socat_missing");
  return { bwrap, socat };
}

/** The distinct directories holding the tools, in order: what goes on the agent's PATH. Empty when there are no tools to reach. */
export function sandboxToolDirs(tools: SandboxTools | undefined): string[] {
  return tools === undefined ? [] : [...new Set([path.dirname(tools.bwrap), path.dirname(tools.socat)])];
}
