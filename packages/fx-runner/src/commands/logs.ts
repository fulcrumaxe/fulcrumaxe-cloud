/**
 * `fx-runner logs <run>`: prints a run's local transcript, the file `<state dir>/logs/<run>.jsonl`, which is the runner's own 0600 capture, which
 * the engine already scrubs of credential values as it writes. It never reads Claude Code's own project logs. The lines are
 * rendered with the same event mapper the engine used (`normalizeMessage`): agent text, the tools it used, results, and the
 * stderr and engine notes. Every printed line goes through the shared redactor once more and loses control characters, so a
 * hostile transcript cannot drive the terminal.
 */
import { statSync } from "node:fs";
import path from "node:path";
import { normalizeMessage, redactText } from "@fulcrumaxe/runner-protocol";
import { CliError } from "../cliError.js";
import { readPrivateFile } from "../config.js";
import type { CommandContext } from "../context.js";

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 20_000;
const LINE_BREAKS = /[\n\u2028\u2029]/;
// Controls (newline and tab kept), the zero-width characters U+200B to U+200D, the bidirectional marks U+200E, U+200F, U+061C, the overrides and embeddings U+202A to U+202E, the isolates U+2066 to U+2069, and U+FEFF.
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
/** The whole file is read at once, so a transcript past this is refused with a plain message. */
const MAX_LOG_BYTES = 64 * 1024 * 1024;

/**
 * What may reach the terminal. Control characters (keeping newline and tab) are dropped first, so none can split a secret the
 * redactor would otherwise match; then the redactor runs; then a long line is cut. The bidirectional overrides and isolates and the
 * zero-width characters go with the control characters, so a line cannot be shown reordered or with text hidden in it. Shared with the
 * sandbox probe's one-line reason in `doctor`.
 */
export function printable(text: string, maxChars: number = MAX_TEXT): string {
  const clean = redactText(text.replace(INVISIBLE, ""), []);
  return clean.length > maxChars ? `${clean.slice(0, maxChars)}... (cut)` : clean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The lines to print for one agent output line: what the shared mapper makes of it. */
function renderAgentLine(runId: string, line: string): string[] {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    // fx-swallow-ok: a line that is not JSON is printed as the text it is
    return [line];
  }
  if (!isRecord(message)) return [line];
  const event = normalizeMessage({ runId, role: "agent" }, message, 0);
  const out: string[] = [];
  if (event.type === "assistant") {
    if (event.text) out.push(`assistant: ${event.text}`);
    for (const use of event.toolUses ?? []) out.push(`  tool: ${[use.tool ?? "tool", use.path ?? use.command ?? use.pattern].filter((part) => part !== undefined).join(" ")}`);
  } else if (event.type === "user") {
    for (const result of event.toolResults ?? []) out.push(`  tool result: ${result.ok ? "ok" : "failed"}`);
  } else if (event.type === "result" || event.type === "error") {
    out.push(`${event.type}: ${event.text ?? ""}`.trimEnd());
    if (typeof event.costUsd === "number") out.push(`  cost: $${event.costUsd.toFixed(4)}`);
  }
  return out;
}

/**
 * One line of the local log file as the lines to print for it: nothing for a damaged line or one of a kind that is not shown. `fx-runner logs`
 * prints them all at once; a tmux watch pane (`__watch`, D#6 R4a-7) prints them as the file grows, with this same function.
 */
export function renderLogRecord(runId: string, raw: string): string[] {
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    // fx-swallow-ok: a damaged line in a local log is skipped; the rest of the transcript is still shown
    return [];
  }
  if (!isRecord(record) || typeof record.line !== "string") return [];
  const lines = record.kind === "stdout" ? renderAgentLine(runId, record.line) : record.kind === "stderr" || record.kind === "meta" ? [`${record.kind}: ${record.line}`] : [];
  // An embedded newline must not start a line that looks like one of ours (`meta:`, `result:`): continuation lines are marked.
  return lines.flatMap((line) => printable(line).split(LINE_BREAKS).map((part, i) => (i === 0 ? part : `  | ${part}`)));
}

export function logsCommand(run: string | undefined, ctx: CommandContext): number {
  if (run === undefined) throw new CliError("usage: fx-runner logs <run id>", 2);
  if (!RUN_ID.test(run)) throw new CliError("run_id_invalid: a run id looks like 3f6c1a52-8d0e-4b7a-9c14-0a5e6d2b7f38", 2);
  const logDir = path.join(ctx.stateDir, "logs");
  let size = 0;
  try {
    size = statSync(path.join(logDir, `${run}.jsonl`)).size;
  } catch {
    // fx-swallow-ok: a missing file is reported by the reader below, with its own message
  }
  if (size > MAX_LOG_BYTES) throw new CliError("this run's local log is too large to print (over 64 MiB); open the file in the logs directory with a pager instead");
  const text = readPrivateFile(logDir, `${run}.jsonl`);
  if (text === undefined) throw new CliError("run_log_missing: this machine has no local log for that run");
  for (const raw of text.split("\n")) if (raw !== "") for (const line of renderLogRecord(run, raw)) ctx.out(line);
  return 0;
}
