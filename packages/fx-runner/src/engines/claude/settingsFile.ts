import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { roleToolsFor } from "../../job/roleTools.js";
import { EngineRefusal } from "./refusal.js";

/**
 * The runner's settings file for one role. No hooks (they run outside the shell sandbox), no `env`, no key helper, no
 * model and no status line. `defaultMode` is set here as well as on the command line, because a resumed run does not
 * inherit the mode it started with. The bytes depend only on the role and the sandbox block, so a fresh run and a resume
 * get the same file.
 */
export function settingsFor(role: string, sandbox: Record<string, unknown>): Record<string, unknown> {
  return { disableAllHooks: true, permissions: { defaultMode: "dontAsk", allow: [...roleToolsFor(role)], deny: [] as string[] }, sandbox };
}

/** The MCP file. No server in v1; this one function is where a later, job-provided server list would come from. */
export function mcpConfigFor(_job: { role: string }): { mcpServers: Record<string, never> } {
  return { mcpServers: {} };
}

/**
 * Writes `settings.json` and `mcp.json` (0600) into `jobDir` (0700) and returns their paths. `jobDir` must be outside
 * the workspace: a file inside it would be readable and writable by the agent.
 */
export function writeJobFiles(jobDir: string, workspace: string, role: string, sandbox: Record<string, unknown>): { settingsPath: string; mcpPath: string } {
  const rel = path.relative(path.resolve(workspace), path.resolve(jobDir));
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) throw new EngineRefusal("bad_start_options", "job directory is inside the workspace");
  mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  const settingsPath = path.join(jobDir, "settings.json");
  const mcpPath = path.join(jobDir, "mcp.json");
  writeFileSync(settingsPath, `${JSON.stringify(settingsFor(role, sandbox), null, 2)}\n`, { mode: 0o600 });
  writeFileSync(mcpPath, `${JSON.stringify(mcpConfigFor({ role }), null, 2)}\n`, { mode: 0o600 });
  return { settingsPath, mcpPath };
}
