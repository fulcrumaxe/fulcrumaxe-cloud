/**
 * D#600 CX-1a: the context ledger's closed vocabularies and the pure capture that measures one run's stream.
 *
 * The capture reads raw Claude Code `stream-json` lines (from the sandbox, where anything inside the VM can write them, so
 * every field is bounds-checked and nothing is trusted) and keeps integers only: no text, no path, no tool input leaves it.
 * It is pure and imports nothing, so the sandbox port now and the local runner's daemon (CX-1b) measure identically.
 *
 * What it measures, per assistant message id (a message's content blocks repeat its usage, so one id is one turn):
 *  - the context of a turn: input + cache read + cache write tokens;
 *  - the first turn's context, and the largest turn's context (the peak);
 *  - cache read and cache write tokens, summed over turns;
 *  - tool output bytes by tool (the UTF-8 size of each `tool_result`'s text, keyed by the tool that was asked);
 *  - `compact_boundary` system events.
 * A run in which no turn reported usage is `partial`, never a row of zeros.
 */

/** The sections an assembled prompt is made of (D#600 Spec). A closed enum: the definer refuses any other code. */
export const CONTEXT_SECTION_CODES = [
  "card",
  "boundary",
  "map",
  "memory_stable",
  "memory_item",
  "spec",
  "note",
  "corrections",
  "findings",
  "output",
  "repo_instructions",
] as const;
export type ContextSectionCode = (typeof CONTEXT_SECTION_CODES)[number];

/** The tools a tool result is attributed to; anything else is `other`. */
export const CONTEXT_TOOL_ENUM = [
  "Read",
  "Grep",
  "Glob",
  "LS",
  "Bash",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
  "TodoWrite",
  "other",
] as const;
export type ContextTool = (typeof CONTEXT_TOOL_ENUM)[number];

export interface ContextSection {
  code: ContextSectionCode;
  /** Bytes the section holds in the prompt. */
  bytes: number;
  /** Hex sha256 of the section text. */
  sha256: string;
  /** Bytes cut from the section (CX-4); 0 when nothing was. */
  trimmed_bytes: number;
}

export type ContextLedgerBasis = "measured" | "partial";

/** What the capture reports; a figure it could not measure is `null` ("Not recorded"), never 0. */
export interface ContextLedgerMeasure {
  basis: ContextLedgerBasis;
  first_turn_input_tokens: number | null;
  peak_context_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  tool_output_bytes: Partial<Record<ContextTool, number>>;
  compactions: number;
}

/** A count above this is not a real one (a run does not reach a thousandth of it); the field is ignored. */
export const CONTEXT_MAX_COUNT = 1_000_000_000_000;
/** Distinct turns and tool calls tracked per run; past them the run is `partial` rather than approximate. */
const MAX_TRACKED_TURNS = 20_000;
const MAX_TRACKED_TOOL_CALLS = 20_000;
const MAX_ID_CHARS = 200;
const MAX_BLOCKS_PER_LINE = 64;

const TOOLS: ReadonlySet<string> = new Set(CONTEXT_TOOL_ENUM);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= CONTEXT_MAX_COUNT ? value : undefined;
}

function toolOf(name: unknown): ContextTool {
  return typeof name === "string" && TOOLS.has(name) && name !== "other" ? (name as ContextTool) : "other";
}

/** The UTF-8 size of a `tool_result`'s text: a string, or the text blocks of an array. Other block kinds (images) count 0. */
function resultBytes(content: unknown): number {
  if (typeof content === "string") return Buffer.byteLength(content, "utf8");
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content.slice(0, MAX_BLOCKS_PER_LINE)) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") total += Buffer.byteLength(block.text, "utf8");
  }
  return total;
}

export class ContextLedgerCapture {
  private firstId: string | undefined;
  private firstContext = 0;
  private peak = 0;
  private readonly turns = new Map<string, { read: number; write: number }>();
  private cacheRead = 0;
  private cacheWrite = 0;
  private overflow = false;
  private readonly toolById = new Map<string, ContextTool>();
  private readonly toolBytes = new Map<ContextTool, number>();
  private compactions = 0;

  /** Feed one parsed stream-json line (any shape). Never throws. */
  observe(line: unknown): void {
    if (!isRecord(line)) return;
    if (line.type === "assistant") this.assistant(line);
    else if (line.type === "user") this.user(line);
    else if (line.type === "system" && line.subtype === "compact_boundary") this.compactions = Math.min(this.compactions + 1, CONTEXT_MAX_COUNT);
  }

  private assistant(line: Record<string, unknown>): void {
    const message = line.message;
    if (!isRecord(message)) return;
    const content = Array.isArray(message.content) ? message.content.slice(0, MAX_BLOCKS_PER_LINE) : [];
    for (const block of content) {
      if (!isRecord(block) || block.type !== "tool_use" || typeof block.id !== "string" || block.id === "" || block.id.length > MAX_ID_CHARS) continue;
      if (this.toolById.size >= MAX_TRACKED_TOOL_CALLS) break;
      this.toolById.set(block.id, toolOf(block.name));
    }
    const usage = message.usage;
    const id = message.id;
    if (!isRecord(usage) || typeof id !== "string" || id === "" || id.length > MAX_ID_CHARS) return;
    const input = count(usage.input_tokens);
    const read = count(usage.cache_read_input_tokens) ?? 0;
    const write = count(usage.cache_creation_input_tokens) ?? 0;
    if (input === undefined) return;
    const known = this.turns.get(id);
    if (known === undefined && this.turns.size >= MAX_TRACKED_TURNS) {
      this.overflow = true;
      return;
    }
    // A repeat of a message id replaces that turn's cache figures (they are the same turn), so a sum never counts a turn twice.
    this.cacheRead += read - (known?.read ?? 0);
    this.cacheWrite += write - (known?.write ?? 0);
    this.turns.set(id, { read, write });
    const context = input + read + write;
    if (this.firstId === undefined) this.firstId = id;
    if (id === this.firstId) this.firstContext = context;
    if (context > this.peak) this.peak = context;
  }

  private user(line: Record<string, unknown>): void {
    const message = line.message;
    const content = isRecord(message) && Array.isArray(message.content) ? message.content.slice(0, MAX_BLOCKS_PER_LINE) : [];
    for (const block of content) {
      if (!isRecord(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const tool = this.toolById.get(block.tool_use_id) ?? "other";
      const next = (this.toolBytes.get(tool) ?? 0) + resultBytes(block.content);
      this.toolBytes.set(tool, Math.min(next, CONTEXT_MAX_COUNT));
    }
  }

  snapshot(): ContextLedgerMeasure {
    const measured = this.firstId !== undefined && !this.overflow;
    const tool_output_bytes: Partial<Record<ContextTool, number>> = {};
    for (const tool of CONTEXT_TOOL_ENUM) {
      const bytes = this.toolBytes.get(tool);
      if (bytes !== undefined) tool_output_bytes[tool] = bytes;
    }
    return {
      basis: measured ? "measured" : "partial",
      first_turn_input_tokens: measured ? this.firstContext : null,
      peak_context_tokens: measured ? this.peak : null,
      cache_read_tokens: measured ? Math.min(this.cacheRead, CONTEXT_MAX_COUNT) : null,
      cache_write_tokens: measured ? Math.min(this.cacheWrite, CONTEXT_MAX_COUNT) : null,
      tool_output_bytes,
      compactions: this.compactions,
    };
  }
}

/**
 * Folds the measure of a later command of the same run (a resume starts a new stream) into the earlier one: the first turn stays the
 * first, the peak is the larger, sums add, and a run is `measured` only when every part was.
 */
export function mergeContextLedgerMeasures(a: ContextLedgerMeasure | undefined, b: ContextLedgerMeasure): ContextLedgerMeasure {
  if (a === undefined) return b;
  const add = (x: number | null, y: number | null): number | null => (x === null ? y : y === null ? x : Math.min(x + y, CONTEXT_MAX_COUNT));
  const tool_output_bytes: Partial<Record<ContextTool, number>> = { ...a.tool_output_bytes };
  for (const tool of CONTEXT_TOOL_ENUM) {
    const y = b.tool_output_bytes[tool];
    if (y !== undefined) tool_output_bytes[tool] = Math.min((tool_output_bytes[tool] ?? 0) + y, CONTEXT_MAX_COUNT);
  }
  return {
    basis: a.basis === "measured" && b.basis === "measured" ? "measured" : "partial",
    first_turn_input_tokens: a.first_turn_input_tokens ?? b.first_turn_input_tokens,
    peak_context_tokens:
      a.peak_context_tokens === null ? b.peak_context_tokens : b.peak_context_tokens === null ? a.peak_context_tokens : Math.max(a.peak_context_tokens, b.peak_context_tokens),
    cache_read_tokens: add(a.cache_read_tokens, b.cache_read_tokens),
    cache_write_tokens: add(a.cache_write_tokens, b.cache_write_tokens),
    tool_output_bytes,
    compactions: Math.min(a.compactions + b.compactions, CONTEXT_MAX_COUNT),
  };
}
