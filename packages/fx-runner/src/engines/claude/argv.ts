export interface ArgvInput {
  /** The CLI's own name for the model. */
  cliModel: string;
  /** The role's entries, as written in the settings file (`Bash(git:*)`). */
  roleTools: readonly string[];
  /** The allow rules the settings file holds (`confineFileTools` of the role's entries), declared again on the command line. */
  allowRules: readonly string[];
  settingsPath: string;
  mcpPath: string;
  /** Present on a resume. */
  resumeSessionId?: string;
}

/** Every flag `claudeArgv` uses. The binary's `--help` must list each one; a test keeps this and the argument list in step. */
export const REQUIRED_FLAGS: readonly string[] = Object.freeze([
  "-p", "--output-format", "--verbose", "--setting-sources", "--settings", "--strict-mcp-config", "--mcp-config", "--tools",
  "--allowedTools", "--disallowedTools", "--permission-prompts", "--disable-slash-commands", "--model", "--resume",
]);

/** The distinct base tool names of a role's entries, in first-seen order: `Bash(git:*)` and `Bash(ls:*)` give one `Bash`. */
export function baseToolNames(entries: readonly string[]): string[] {
  return [...new Set(entries.map((entry) => entry.replace(/\(.*$/, "")))];
}

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
    "--tools", baseToolNames(input.roleTools).join(","),
    ...(input.allowRules.length === 0 ? [] : ["--allowedTools", ...input.allowRules]),
    "--disallowedTools", "WebFetch", "WebSearch",
    "--permission-prompts", "none",
    "--disable-slash-commands",
    "--model", input.cliModel,
    ...(input.resumeSessionId === undefined ? [] : ["--resume", input.resumeSessionId]),
  ];
}
