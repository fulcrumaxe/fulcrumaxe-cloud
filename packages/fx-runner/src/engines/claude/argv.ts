import { isBrowserJobRole, isMcpToolName, type BrowserMethod } from "@fulcrumaxe/runner-protocol";

export interface ArgvInput {
  /** The CLI's own name for the model. */
  cliModel: string;
  /** The role's entries, as written in the settings file (`Bash(git:*)`). */
  roleTools: readonly string[];
  /** The allow rules the settings file holds (`confineFileTools` of the role's entries), declared again on the command line. */
  allowRules: readonly string[];
  settingsPath: string;
  mcpPath: string;
  /**
   * D#749 V2b: true only for the browser role (the deploy verifier). The command line then carries `--chrome` (the CLI reaches the Claude in Chrome extension
   * through that flag; the MCP file stays empty). Every other role carries `--no-chrome`, so a person's own "Chrome on by default" setting cannot bring the
   * browser tools to a job that does not hold them.
   */
  chrome?: boolean;
  /** Present on a resume. */
  resumeSessionId?: string;
}

/** Every flag `claudeArgv` uses. The binary's `--help` must list each one; a test keeps this and the argument list in step. */
export const REQUIRED_FLAGS: readonly string[] = Object.freeze([
  "-p", "--output-format", "--verbose", "--setting-sources", "--settings", "--strict-mcp-config", "--mcp-config", "--tools",
  "--allowedTools", "--disallowedTools", "--permission-prompts", "--disable-slash-commands", "--model", "--resume", "--chrome", "--no-chrome",
]);

/**
 * The distinct base tool names of a role's entries, in first-seen order: `Bash(git:*)` and `Bash(ls:*)` give one `Bash`. An MCP tool is not one of the CLI's built-in tools,
 * which is what `--tools` lists; it is granted by its allow rule alone, so it is left out here.
 */
export function baseToolNames(entries: readonly string[]): string[] {
  return [...new Set(entries.filter((entry) => !isMcpToolName(entry)).map((entry) => entry.replace(/\(.*$/, "")))];
}

/**
 * Whether the CLI is started with `--chrome`: only for the browser role, and only when its method drives the Claude in Chrome extension. A playwright job reaches its browser through
 * the `fxverify` server in the MCP file, so it carries `--no-chrome` and never `--chrome` (a person's own "Chrome on by default" setting cannot add the extension's tools to it).
 */
export const chromeFlagFor = (role: string, method: BrowserMethod | undefined): boolean => isBrowserJobRole(role) && method !== "playwright_runner";

/**
 * The agent's argument list. The prompt is never in it (it goes to standard input), and neither is any credential.
 * The variadic flags (`--mcp-config`, `--allowedTools`, `--disallowedTools`) are each followed by another flag, which ends them.
 *
 * No `--permission-mode`: the runner always sets `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, and with it set the CLI uses mode
 * `default` whatever is asked for, and prints "Permission mode forced to default" when a non-default one was. So the
 * allowed tools are declared explicitly instead (`--allowedTools`, the same rules as the settings file), and
 * `--permission-prompts none` denies everything that would otherwise ask. The engine refuses a job whose stderr
 * carries that warning (`PERMISSION_MODE_FORCED`).
 * Not used, on purpose: the bare mode (it never reads a subscription login), the flag that makes a session
 * unresumable, the one that forks a session, and any flag that skips permission checks.
 */
export function claudeArgv(input: ArgvInput): string[] {
  return [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--setting-sources", "",
    "--settings", input.settingsPath,
    "--strict-mcp-config",
    "--mcp-config", input.mcpPath,
    input.chrome === true ? "--chrome" : "--no-chrome",
    "--tools", baseToolNames(input.roleTools).join(","),
    ...(input.allowRules.length === 0 ? [] : ["--allowedTools", ...input.allowRules]),
    "--disallowedTools", "WebFetch", "WebSearch",
    "--permission-prompts", "none",
    "--disable-slash-commands",
    "--model", input.cliModel,
    ...(input.resumeSessionId === undefined ? [] : ["--resume", input.resumeSessionId]),
  ];
}
