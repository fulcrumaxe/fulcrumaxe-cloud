import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CONFINED_READ_ROLES, excludeDenyRules, verifierReadGuardHook } from "@fulcrumaxe/runner-protocol";
import { roleToolsFor } from "../../job/roleTools.js";
import type { ProtectedPaths } from "../../sandbox/sandboxSettings.js";
import { anchored, checkCommandDenyRules, confineFileTools, denyRules, readRulesFor, workspaceProtectedEditRules } from "./filePermissions.js";
import { EngineRefusal } from "./refusal.js";

/**
 * The runner's settings file for one role. No hooks (they run outside the shell sandbox), no `env`, no key helper, no
 * model and no status line. `defaultMode` is set here and only here (the command line has no `--permission-mode`), so a resumed run, which does not
 * inherit the mode it started with, gets it too. File tools are confined to the workspace (allow), the protected paths are denied
 * (deny outranks allow) and reads outside the working directory are refused. The bytes depend only on the role, the
 * workspace and the sandbox block, so a fresh run and a resume get the same file.
 */
export function settingsFor(role: string, sandbox: Record<string, unknown>, workspace: string, protectedList: ProtectedPaths, excludes: readonly string[] = [], spillDir?: string, checkArgv?: readonly string[]): Record<string, unknown> {
  if (CONFINED_READ_ROLES.has(role)) return verifierSettings(role, sandbox, workspace, protectedList, excludes);
  return {
    disableAllHooks: true,
    // D#600 CX-4b: the run's spill directory is read-only to the file tools: a `Read` rule for it, and no `Edit` rule (the bare file tools of the role are confined to the workspace).
    // D#6 RUNNER-AGENT-NO-FULLCHECK: the job's approved check is denied to the agent's shell (the runner runs it after the agent); a job without one adds nothing.
    permissions: { defaultMode: "dontAsk", allow: [...confineFileTools(roleToolsFor(role), workspace), ...(spillDir === undefined ? [] : readRulesFor(spillDir))], deny: [...denyRules(protectedList), ...workspaceProtectedEditRules(workspace), ...excludeRules(excludes), ...checkCommandDenyRules(checkArgv)], blockReadsOutsideWorkingDirectories: true },
    sandbox,
  };
}

/** The checkout's own files the verifier never reads, whatever its allow rule says (the cloud sandbox's list, `VERIFIER_DENY`, under this checkout). */
const VERIFIER_CHECKOUT_DENY = [".git", ".git/**", "**/.git", "**/.git/**", ".env*", "**/.env*"] as const;

/**
 * D#483 S4-b2c: the claim verifier's settings (S4-f4: and the discovery analyst's, the same confinement). Its prompt holds an outsider's text and its claims are stored and shown, so whatever it can read
 * it can leak. Read, Glob and Grep only (the role entry), confined to the checkout three ways, as in the cloud's sandbox:
 *  - the allow rules name the checkout only, and reads outside the working directory are refused;
 *  - deny rules (which win over any allow) cover the checkout's `.git` and `.env*` files, plus the runner's protected paths;
 *  - exactly one hook, the shared read guard (`verifierReadGuardHook`), as PreToolUse on Read, Glob and Grep: the CLI does not confine Glob and
 *    Grep to a path by rule, so the hook is what keeps them in the tree. Every other role runs with all hooks off; this is the only exception,
 *    and `--setting-sources ""` keeps the person's own hooks out. The hook runs outside the shell sandbox, so it is a fixed script of shell
 *    built-ins with the checkout as its one argument. A checkout the command cannot carry unquoted refuses the start.
 */
function verifierSettings(role: string, sandbox: Record<string, unknown>, workspace: string, protectedList: ProtectedPaths, excludes: readonly string[]): Record<string, unknown> {
  let guard: ReturnType<typeof verifierReadGuardHook>;
  try {
    guard = verifierReadGuardHook(workspace);
  } catch {
    // fx-swallow-ok: the closed refusal below is the report; the path is not repeated
    throw new EngineRefusal("bad_start_options", "the checkout path cannot be given to the read guard");
  }
  const root = anchored(workspace);
  return {
    disableAllHooks: false,
    hooks: { PreToolUse: [guard] },
    permissions: {
      defaultMode: "dontAsk",
      allow: confineFileTools(roleToolsFor(role), workspace),
      deny: [...VERIFIER_CHECKOUT_DENY.map((p) => `Read(${root}/${p})`), ...denyRules(protectedList), ...excludeRules(excludes)],
      blockReadsOutsideWorkingDirectories: true,
    },
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

function realpathOrNull(dir: string): string | null {
  try {
    return realpathSync(dir);
  } catch {
    // fx-swallow-ok: a checkout that cannot be resolved refuses the start (the caller compares and refuses)
    return null;
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
export function writeJobFiles(jobDir: string, workspace: string, role: string, sandbox: Record<string, unknown>, protectedList: ProtectedPaths, excludes: readonly string[] = [], spillDir?: string, checkArgv?: readonly string[]): { settingsPath: string; mcpPath: string; settings: Record<string, unknown> } {
  const rel = path.relative(path.resolve(workspace), path.resolve(jobDir));
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) throw new EngineRefusal("bad_start_options", "job directory is inside the workspace");
  // The read guard compares the agent's absolute paths with the checkout it is given, so the checkout must be its own real path (a link on the way
  // to it would make the guard refuse every absolute path, or compare against a name that is not the tree).
  if (CONFINED_READ_ROLES.has(role) && realpathOrNull(workspace) !== path.resolve(workspace)) throw new EngineRefusal("bad_start_options", "the checkout is not its own real path");
  mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  const settingsPath = path.join(jobDir, "settings.json");
  const mcpPath = path.join(jobDir, "mcp.json");
  const settings = settingsFor(role, sandbox, path.resolve(workspace), protectedList, excludes, spillDir, checkArgv);
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(mcpPath, `${JSON.stringify(mcpConfigFor({ role }), null, 2)}\n`, { mode: 0o600 });
  return { settingsPath, mcpPath, settings };
}
