import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { SESSION_ID_PATTERN } from "@fulcrumaxe/runner-protocol";
import { roleToolsFor } from "../../job/roleTools.js";
import { baseToolNames } from "./argv.js";
import { jobDirFor } from "./engine.js";
import { EngineRefusal } from "./refusal.js";
import { readSessionIndex } from "./session.js";

/** The session a run was in, from the first stream line of its own transcript that names one. */
export function sessionOfRun(logFile: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(logFile, "utf8");
  } catch {
    // fx-swallow-ok: no transcript means no session to resume
    return undefined;
  }
  for (const line of text.split("\n")) {
    if (!line.includes("session_id")) continue;
    try {
      const entry = JSON.parse(line) as { kind?: unknown; line?: unknown };
      const message = entry.kind === "stdout" && typeof entry.line === "string" ? (JSON.parse(entry.line) as { session_id?: unknown }) : undefined;
      if (typeof message?.session_id === "string" && SESSION_ID_PATTERN.test(message.session_id) && !message.session_id.startsWith("-")) return message.session_id;
    } catch {
      // fx-swallow-ok: a line that is not JSON names no session
    }
  }
  return undefined;
}

/**
 * The interactive resume of a taken-over run (D#6 R4a-7): the same job settings file (which carries the sandbox), the same MCP file and tool
 * list, no `-p`, and `--permission-mode default` so the person approves each action. The workspace is the one the session index recorded.
 */
export function takeoverCommand(input: { stateDir: string; runId: string; role: string }): { argv: string[]; cwd: string } {
  const jobDir = jobDirFor(path.join(input.stateDir, "jobs"), input.runId);
  const settingsPath = path.join(jobDir, "settings.json");
  const mcpPath = path.join(jobDir, "mcp.json");
  const sessionId = sessionOfRun(path.join(input.stateDir, "logs", `${input.runId}.jsonl`));
  if (sessionId === undefined || !existsSync(settingsPath) || !existsSync(mcpPath)) throw new EngineRefusal("bad_start_options", "this run has no session or settings to resume");
  const known = readSessionIndex(path.join(input.stateDir, "sessions.json"))[sessionId];
  if (known === undefined || !existsSync(known.workspace)) throw new EngineRefusal("bad_start_options", "this run's workspace is gone");
  const argv = [
    "--resume", sessionId,
    "--setting-sources", "",
    "--settings", settingsPath,
    "--strict-mcp-config",
    "--mcp-config", mcpPath,
    "--tools", baseToolNames(roleToolsFor(input.role)).join(","),
    "--disallowedTools", "WebFetch", "WebSearch",
    "--disable-slash-commands",
    "--permission-mode", "default",
  ];
  return { argv, cwd: known.workspace };
}
