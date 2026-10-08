import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { LocalOnlyEvent, normalizeRepoPath, redactText, type NormalizedEvent } from "@fulcrumaxe/runner-protocol";

const MAX_LINE_CHARS = 4 * 1024 * 1024;
const TOOL_NAME = /^[A-Za-z0-9_:.-]{1,64}$/;

/** Splits a byte stream into lines. A line longer than the cap is dropped whole, so one hostile line cannot grow memory. */
export class LineBuffer {
  private pending = "";
  private dropping = false;

  push(chunk: string): string[] {
    const parts = (this.pending + chunk).split("\n");
    this.pending = parts.pop() ?? "";
    const lines: string[] = [];
    for (const part of parts) {
      if (!this.dropping && part.length <= MAX_LINE_CHARS) lines.push(part);
      this.dropping = false;
    }
    if (this.pending.length > MAX_LINE_CHARS) {
      this.pending = "";
      this.dropping = true;
    }
    return lines;
  }

  end(): string[] {
    const rest = this.dropping ? "" : this.pending;
    this.pending = "";
    this.dropping = false;
    return rest === "" ? [] : [rest];
  }
}

/** The run's raw transcript: `<dir>/<run>.jsonl`, 0600, every line scrubbed before it is written. */
export function createRunLog(dir: string, runId: string, secrets: readonly string[]): { write(kind: "stdout" | "stderr" | "meta", line: string): void; file: string } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${runId}.jsonl`);
  appendFileSync(file, "", { mode: 0o600 });
  chmodSync(file, 0o600);
  return {
    file,
    write(kind, line) {
      // A stdout line is already JSON, but only the scrubbed text is kept, so a value cannot hide inside an escape.
      appendFileSync(file, `${JSON.stringify({ kind, line: redactText(line, secrets) })}\n`);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The metadata-only events the cloud may see for one stream line: tool name and repo-relative path for a tool use, a
 * changed file for a write, and the run's token and cost totals from the final `result` line. There is no field for
 * model text, tool input or tool output, and every event is parsed by the shared schema before it is returned.
 */
export function projectLocalOnly(message: Record<string, unknown>, normalized: NormalizedEvent, nextSeq: () => number, repoRoot: string): LocalOnlyEvent[] {
  const events: LocalOnlyEvent[] = [];
  const names = new Map<string, string>();
  const writtenPaths = new Map<string, string | undefined>();
  const inner = isRecord(message.message) ? message.message : undefined;
  if (message.type === "assistant" && Array.isArray(inner?.content)) {
    for (const block of inner.content) {
      if (isRecord(block) && block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string" && TOOL_NAME.test(block.name)) {
        names.set(block.id, block.name);
        const input = isRecord(block.input) ? block.input : {};
        writtenPaths.set(block.id, normalizeRepoPath(input.file_path ?? input.notebook_path, repoRoot));
      }
    }
  }
  for (const use of normalized.toolUses ?? []) {
    const toolName = names.get(use.id);
    if (toolName === undefined) continue;
    events.push(LocalOnlyEvent.parse({ seq: nextSeq(), ts: normalized.ts, type: "tool_use", tool_name: toolName, ...(use.path === undefined ? {} : { file_path: use.path }), ...(use.writes && writtenPaths.get(use.id) ? { file_path: writtenPaths.get(use.id) } : {}) }));
    const changed = use.writes ? writtenPaths.get(use.id) : undefined;
    if (use.writes) events.push(LocalOnlyEvent.parse({ seq: nextSeq(), ts: normalized.ts, type: "file_changed", ...(changed ? { file_path: changed } : {}) }));
  }
  if (message.type === "result" && normalized.usage !== undefined) {
    const usd = normalized.costUsd;
    events.push(
      LocalOnlyEvent.parse({
        seq: nextSeq(),
        ts: normalized.ts,
        type: "usage",
        usage: { input: normalized.usage.inputTokens, output: normalized.usage.outputTokens, ...(typeof usd === "number" && Number.isFinite(usd) && usd >= 0 ? { usd } : {}) },
      }),
    );
  }
  return events;
}
