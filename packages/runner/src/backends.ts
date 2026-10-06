import { createClaudeCodeBackend } from "@fx/runtime/src/backends/claudeCode.js";
import { createBackendRegistry } from "@fx/runtime/src/backends/registry.js";
import { FX_AGENT_MCP_PATH, FX_AGENT_SETTINGS_PATH } from "./agentConfig.js";
import { CLAUDE_CLI_SHA256, CLAUDE_CLI_VERSION } from "./sandboxRuntime.js";

/**
 * D#221 R1a: the runner's backends. The Claude Code descriptor is built here because the runner owns what it needs
 * (the lockfile's pin and the config directory); `@fx/runtime` holds only the pure shape.
 *
 * Adding a backend (D#221 R2, R3) means adding it to the list below AND registering it with
 * `runHostileConfigContract` in `test/hostileConfig.test.ts`; the parity test there fails the first without the second.
 */
export const CLAUDE_CODE_BACKEND = createClaudeCodeBackend({
  cliVersion: CLAUDE_CLI_VERSION,
  cliSha256: CLAUDE_CLI_SHA256,
  settingsPath: FX_AGENT_SETTINGS_PATH,
  mcpPath: FX_AGENT_MCP_PATH,
});

/** Every selectable backend. */
export const BACKENDS = createBackendRegistry([CLAUDE_CODE_BACKEND]);
