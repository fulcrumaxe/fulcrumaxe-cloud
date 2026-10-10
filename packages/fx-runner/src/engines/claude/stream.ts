import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { LocalOnlyEvent, normalizeRepoPath, redactText, type NormalizedEvent } from "@fulcrumaxe/runner-protocol";
import { activityOf } from "./activity.js";
import { isInitLine, isKnownKeySource } from "./credentialCheck.js";

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

const KEY_SOURCE_FIELD = /"apiKeySource":"([^"\\]*)"/g;

/**
 * The redactor blanks any value whose key name contains a credential word, and `apiKeySource` is one. Its value is the NAME of where the
 * binary found its credential (`none`, `ANTHROPIC_API_KEY`), not a credential, and the init line is the record of which one it was. So on the
 * init line only, and only when the field occurs once and holds a name from the closed set the credential check knows, that one field is kept
 * and the text on both sides of it is redacted as usual. Any other value, or any other line, is redacted whole. This changes only the
 * transcript: the engine's credential check reads the parsed line before it is logged.
 */
export function redactLogLine(kind: "stdout" | "stderr" | "meta", line: string, secrets: readonly string[]): string {
  if (kind !== "stdout") return redactText(line, secrets);
  const matches = [...line.matchAll(KEY_SOURCE_FIELD)];
  if (matches.length !== 1 || !isKnownKeySource(matches[0]![1])) return redactText(line, secrets);
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // fx-swallow-ok: a line that is not JSON is not an init line; it is redacted whole
    return redactText(line, secrets);
  }
  if (!isRecord(parsed) || !isInitLine(parsed) || parsed.apiKeySource !== matches[0]![1]) return redactText(line, secrets);
  const start = matches[0]!.index;
  const end = start + matches[0]![0].length;
  return redactText(line.slice(0, start), secrets) + matches[0]![0] + redactText(line.slice(end), secrets);
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
      appendFileSync(file, `${JSON.stringify({ kind, line: redactLogLine(kind, line, secrets) })}\n`);
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
/** A cache token count the CLI reported, as an event field; absent when it sent none or something that is not a count. */
const tokenCount = <K extends "cache_read" | "cache_write">(key: K, n: number | undefined): { [P in K]?: number } =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? ({ [key]: n } as { [P in K]?: number }) : {};

/** Which once-per-run marks this run has sent. The engine owns one per run. */
export interface StageMarks {
  writingResult: boolean;
}

/**
 * `secrets` are the run's real credential values (the API key, the subscription token): a tool use's activity is rechecked against them
 * before it is attached (D#6 C42-2). `marks` makes `writing_result` go out once, on the first write tool or the first line of the envelope.
 */
export function projectLocalOnly(message: Record<string, unknown>, normalized: NormalizedEvent, nextSeq: () => number, repoRoot: string, secrets: readonly string[] = [], marks: StageMarks = { writingResult: false }): LocalOnlyEvent[] {
  const events: LocalOnlyEvent[] = [];
  if (!marks.writingResult && (normalized.writesResult === true || (normalized.toolUses ?? []).some((use) => use.writes))) {
    marks.writingResult = true;
    events.push(LocalOnlyEvent.parse({ seq: nextSeq(), ts: normalized.ts, type: "stage", stage: "writing_result" }));
  }
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
    const activity = activityOf(use, secrets);
    events.push(LocalOnlyEvent.parse({ seq: nextSeq(), ts: normalized.ts, type: "tool_use", tool_name: toolName, ...(use.path === undefined ? {} : { file_path: use.path }), ...(use.writes && writtenPaths.get(use.id) ? { file_path: writtenPaths.get(use.id) } : {}), ...(activity === undefined ? {} : { activity }) }));
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
        usage: { input: normalized.usage.inputTokens, output: normalized.usage.outputTokens, ...tokenCount("cache_read", normalized.usage.cacheReadTokens), ...tokenCount("cache_write", normalized.usage.cacheWriteTokens), ...(typeof usd === "number" && Number.isFinite(usd) && usd >= 0 ? { usd } : {}) },
      }),
    );
  }
  return events;
}
