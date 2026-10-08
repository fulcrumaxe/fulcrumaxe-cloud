/**
 * The tool-activity reducers. They moved, unchanged, to `@fulcrumaxe/runner-protocol` (D#6 R4b1-2) because the stream
 * mapper that uses them moved too; this file only re-exports them, so every existing import still resolves.
 */
export {
  CREDENTIALED_URL_RE,
  TOOL_ACTIVITY_LIMITS,
  commandIsClean,
  extractToolResults,
  extractToolUses,
  normalizePattern,
  normalizeRepoPath,
  shellCommandLine,
  type ActivityTool,
  type ToolResult,
  type ToolUse,
} from "@fulcrumaxe/runner-protocol/toolActivity";
