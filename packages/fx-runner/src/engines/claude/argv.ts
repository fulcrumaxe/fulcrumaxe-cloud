export interface ArgvInput {
  /** The CLI's own name for the model. */
  cliModel: string;
  /** The role's entries, as written in the settings file (`Bash(git:*)`). */
  roleTools: readonly string[];
  settingsPath: string;
  mcpPath: string;
  /** Present on a resume. */
  resumeSessionId?: string;
}

/** Every flag `claudeArgv` uses. The binary's `--help` must list each one; a test keeps this and the argument list in step. */
export const REQUIRED_FLAGS: readonly string[] = Object.freeze([
  "-p", "--output-format", "--verbose", "--setting-sources", "--settings", "--strict-mcp-config", "--mcp-config", "--tools",
  "--disallowedTools", "--permission-mode", "--permission-prompts", "--disable-slash-commands", "--model", "--resume",
]);

/** The distinct base tool names of a role's entries, in first-seen order: `Bash(git:*)` and `Bash(ls:*)` give one `Bash`. */
export function baseToolNames(entries: readonly string[]): string[] {
  return [...new Set(entries.map((entry) => entry.replace(/\(.*$/, "")))];
}

/**
 * The agent's argument list. The prompt is never in it (it goes to standard input), and neither is any credential.
 * The two variadic flags (`--mcp-config`, `--disallowedTools`) are each followed by another flag, which ends them.
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
    "--disallowedTools", "WebFetch", "WebSearch",
    "--permission-mode", "dontAsk",
    "--permission-prompts", "none",
    "--disable-slash-commands",
    "--model", input.cliModel,
    ...(input.resumeSessionId === undefined ? [] : ["--resume", input.resumeSessionId]),
  ];
}
