import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { excludeDenyRules } from "@fulcrumaxe/runner-protocol";
import { roleToolsFor } from "../../job/roleTools.js";
import type { ProtectedPaths } from "../../sandbox/sandboxSettings.js";
import { confineFileTools, denyRules } from "./filePermissions.js";
import { EngineRefusal } from "./refusal.js";

/**
 * The runner's settings file for one role. No hooks (they run outside the shell sandbox), no `env`, no key helper, no
 * model and no status line. `defaultMode` is set here and only here (the command line has no `--permission-mode`), so a resumed run, which does not
 * inherit the mode it started with, gets it too. File tools are confined to the workspace (allow), the protected paths are denied
 * (deny outranks allow) and reads outside the working directory are refused. The bytes depend only on the role, the
 * workspace and the sandbox block, so a fresh run and a resume get the same file.
 */
export function settingsFor(role: string, sandbox: Record<string, unknown>, workspace: string, protectedList: ProtectedPaths, excludes: readonly string[] = []): Record<string, unknown> {
  return {
    disableAllHooks: true,
    permissions: { defaultMode: "dontAsk", allow: confineFileTools(roleToolsFor(role), workspace), deny: [...denyRules(protectedList), ...excludeRules(excludes)], blockReadsOutsideWorkingDirectories: true },
    sandbox,
  };
}

/**
 * D#600 CX-5c: the deny entries for the job's excluded paths, the same ones the cloud's sandbox writes (`excludeDenyRules`: `Read(<path>)`, `Read(<path>/**)` and bare `Grep` and `Glob`).
 * A path that cannot be written as a rule refuses the start, so the agent never runs with a rule missing (fail closed).
 */
function excludeRules(excludes: readonly string[]): string[] {
  try {
    return excludeDenyRules(excludes);
  } catch {
    // fx-swallow-ok: the closed refusal below is the report; the path is job content and is not repeated
    throw new EngineRefusal("bad_start_options", "an excluded path cannot be written as a permission rule");
  }
}

/** The MCP file. No server in v1; this one function is where a later, job-provided server list would come from. */
export function mcpConfigFor(_job: { role: string }): { mcpServers: Record<string, never> } {
  return { mcpServers: {} };
}

/**
 * Writes `settings.json` and `mcp.json` (0600) into `jobDir` (0700) and returns their paths. `jobDir` must be outside
 * the workspace: a file inside it would be readable and writable by the agent.
 */
export function writeJobFiles(jobDir: string, workspace: string, role: string, sandbox: Record<string, unknown>, protectedList: ProtectedPaths, excludes: readonly string[] = []): { settingsPath: string; mcpPath: string } {
  const rel = path.relative(path.resolve(workspace), path.resolve(jobDir));
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) throw new EngineRefusal("bad_start_options", "job directory is inside the workspace");
  mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  const settingsPath = path.join(jobDir, "settings.json");
  const mcpPath = path.join(jobDir, "mcp.json");
  writeFileSync(settingsPath, `${JSON.stringify(settingsFor(role, sandbox, path.resolve(workspace), protectedList, excludes), null, 2)}\n`, { mode: 0o600 });
  writeFileSync(mcpPath, `${JSON.stringify(mcpConfigFor({ role }), null, 2)}\n`, { mode: 0o600 });
  return { settingsPath, mcpPath };
}
