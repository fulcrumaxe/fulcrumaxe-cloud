import type { AgentBackend, BackendArgvInput } from "./types.js";

/**
 * D#221 R1a: Claude Code in print mode, as a backend descriptor. This is the command line the sandbox port built
 * itself before the seam existed, moved here byte for byte (no behaviour change).
 *
 * C59: the empty `--setting-sources` loads no user, project or local settings file, `--settings` names the runner's
 * file, and `--strict-mcp-config` ignores every MCP config but the runner's. `--mcp-config` is variadic, so a
 * following flag must always end it (`buildArgv` always appends one).
 *
 * The pin (`cliVersion`, `cliSha256`) and the two config paths are inputs, not constants here: the runner owns
 * the lockfile and the config directory, and this package must not reach into it.
 */
export interface ClaudeCodeBackendConfig {
  cliVersion: string;
  cliSha256: string;
  settingsPath: string;
  mcpPath: string;
}

export function createClaudeCodeBackend(config: ClaudeCodeBackendConfig): AgentBackend {
  const baseArgv = [
    "claude",
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--setting-sources",
    "",
    "--settings",
    config.settingsPath,
    "--strict-mcp-config",
    "--mcp-config",
    config.mcpPath,
  ] as const;
  return {
    name: "claude-code",
    cli: "claude",
    cliVersion: config.cliVersion,
    cliSha256: config.cliSha256,
    baseArgv,
    hostileConfig: {
      requiredArgv: [["--setting-sources", ""], ["--settings", config.settingsPath], ["--strict-mcp-config"], ["--mcp-config", config.mcpPath]],
    },
    buildArgv(input: BackendArgvInput): string[] {
      return [
        ...baseArgv,
        "--max-turns",
        String(input.maxTurns),
        "--max-budget-usd",
        String(input.capUsd),
        "--model",
        input.cliModel,
        ...(input.resumeSessionId === undefined ? [] : ["--resume", input.resumeSessionId]),
      ];
    },
  };
}
