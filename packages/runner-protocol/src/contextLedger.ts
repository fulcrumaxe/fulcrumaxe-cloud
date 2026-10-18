/**
 * D#600 CX-1a: the context ledger's closed vocabularies and the pure capture that measures one run's stream.
 *
 * The capture reads raw Claude Code `stream-json` lines (from the sandbox, where anything inside the VM can write them, so
 * every field is bounds-checked and nothing is trusted) and keeps integers only: no text, no path, no tool input leaves it.
 * It is pure and imports nothing, so the sandbox port now and the local runner's daemon (CX-1b) measure identically.
 *
 * What it measures, per assistant message id (a message's content blocks repeat its usage, so one id is one turn):
 *  - the context of a turn: input + cache read + cache write tokens (clamped to CONTEXT_MAX_COUNT), main thread only: a line that
 *    carries `parent_tool_use_id` is a subagent's, whose context is its own, so it counts toward the cache sums and tool bytes but
 *    not toward the first turn or the peak;
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
  // D#600 CX-4a: files a person pinned (CX-5 supplies them). Never cut.
  "pinned",
] as const;
export type ContextSectionCode = (typeof CONTEXT_SECTION_CODES)[number];

/**
 * Why a section was cut (D#600 CX-4a), a closed enum the definer checks: the findings caps, the memory slot's size, or the run's context budget.
 * CX-5b adds two notes about pinned files, which are never cut. Each is one `pinned` entry that carries a figure, not text, in `bytes`: `pin_missing`
 * (how many pinned files the run could not read: deleted, renamed, not text, or GitHub unreachable), `pin_too_large` (how many were over the run-time cap of
 * 190,000 characters, below the 200,000 the prompt fence can hold, so they were skipped rather than cut), `pin_excluded` (how many sat under an exclude, which wins
 * over a pin, and were never fetched) and `pins_over_budget` (how many bytes the pins stand over the repository's budget; they are still included in full).
 */
export const CONTEXT_TRIMMED_REASONS = ["findings_cap", "memory_slot", "over_budget", "pin_missing", "pins_over_budget", "pin_too_large", "pin_excluded"] as const;
export type ContextTrimmedReason = (typeof CONTEXT_TRIMMED_REASONS)[number];

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
  /** Why it was cut. Absent on a section that was not cut. */
  trimmed_reason?: ContextTrimmedReason;
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
  /**
   * D#600 CX-5b: tool calls the CLI refused for a permission rule, counted from the stream. Sandbox runs only: the sandbox port sets it (0 when none), the
   * runner daemon's measure and the runner wire never carry it, so a runner row stays null ("Not recorded").
   */
  denied_tool_calls?: number;
  /**
   * D#600 CX-10a: tool calls the run made, by tool (a count of the stream's `tool_use` blocks, each call once), over the same closed list as `tool_output_bytes`.
   * A measure from a capture always has it ({} when the run called nothing); absent on a measure that did not come from a stream ("Not recorded").
   */
  tool_call_counts?: Partial<Record<ContextTool, number>>;
}

/** Calls counted per tool: the store refuses a figure above this. */
export const CONTEXT_MAX_TOOL_CALLS = 1_000_000;

/** A count above this is not a real one (a run does not reach a thousandth of it); the field is ignored. */
export const CONTEXT_MAX_COUNT = 1_000_000_000_000;
/** Distinct turns and tool calls tracked per run; past them the run is `partial` rather than approximate. */
const MAX_TRACKED_TURNS = 20_000;
const MAX_TRACKED_TOOL_CALLS = 20_000;
const MAX_ID_CHARS = 200;
const MAX_BLOCKS_PER_LINE = 64;
const MAX_TRACKED_DENIALS = 20_000;
/** The tools whose permission refusals are counted: the file tools an exclude denies. */
const DENIABLE_TOOLS: ReadonlySet<ContextTool> = new Set<ContextTool>(["Read", "Grep", "Glob", "LS"]);
/**
 * What the CLI's refusal reads like in a `tool_result` ("Permission to use Read has been denied", "... denied by your permission settings"). A shell or
 * filesystem error such as EACCES says "permission denied" and is not a refusal by a rule, so it is not matched.
 */
const DENIAL_TEXT = /\bhas been denied\b|\bdenied by your permission|\brequested permissions to use\b|\bpermission to use\b/i;

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

/** The text of a `tool_result` (a string, or the text blocks of an array), bounded; used only to recognise a refusal, never kept. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content.slice(0, 2000);
  if (!Array.isArray(content)) return "";
  return content
    .slice(0, MAX_BLOCKS_PER_LINE)
    .map((b) => (isRecord(b) && b.type === "text" && typeof b.text === "string" ? b.text.slice(0, 2000) : ""))
    .join("\n");
}

/**
 * A tool our settings turn off is not refused by a rule: the CLI answers `Error: No such tool available: Grep. ...` (seen from CLI 2.1.302). That counts as a
 * refusal only for a tool the caller says it disabled, and only when the text names that very tool right after the phrase.
 */
const noSuchTool = (tool: ContextTool): RegExp => new RegExp(`No such tool available: ${tool}\\b`);

export class ContextLedgerCapture {
  /** @param disabledTools the tools the run's settings turn off (D#600 CX-5b: Grep and Glob when the run has excludes). Only these can be counted by the "No such tool" wording. */
  private readonly disabledTools: readonly ContextTool[];
  constructor(disabledTools: readonly ContextTool[] = []) {
    this.disabledTools = disabledTools;
  }

  private firstId: string | undefined;
  private firstContext = 0;
  private peak = 0;
  /** The main thread's most recent turn's context (input + cache read + cache write), for the window warning. */
  private lastContext = 0;
  private readonly turns = new Map<string, { read: number; write: number }>();
  private cacheRead = 0;
  private cacheWrite = 0;
  private overflow = false;
  private readonly toolById = new Map<string, ContextTool>();
  private readonly toolBytes = new Map<ContextTool, number>();
  private readonly toolCalls = new Map<ContextTool, number>();
  private compactions = 0;
  /** Tool call ids the CLI refused for a permission rule: from a refused `tool_result` and from the final `result`'s `permission_denials`; one id counts once. */
  private readonly denied = new Set<string>();

  /** Feed one parsed stream-json line (any shape). Never throws. */
  observe(line: unknown): void {
    if (!isRecord(line)) return;
    if (line.type === "assistant") this.assistant(line);
    else if (line.type === "user") this.user(line);
    else if (line.type === "system" && line.subtype === "compact_boundary") this.compactions = Math.min(this.compactions + 1, CONTEXT_MAX_COUNT);
    else if (line.type === "result" && Array.isArray(line.permission_denials)) {
      // Only the file tools an exclude concerns: under dontAsk every tool off the role's list is refused and listed here too (WebFetch, Task, a Bash prefix), and those are not this count.
      for (const d of line.permission_denials.slice(0, MAX_TRACKED_DENIALS)) if (isRecord(d) && DENIABLE_TOOLS.has(toolOf(d.tool_name))) this.deny(d.tool_use_id);
    }
  }

  private deny(id: unknown): void {
    if (typeof id === "string" && id !== "" && id.length <= MAX_ID_CHARS && this.denied.size < MAX_TRACKED_DENIALS) this.denied.add(id);
  }

  /** How many tool calls the CLI refused for a permission rule so far. An integer; no tool input, path or text is kept. */
  deniedToolCalls(): number {
    return this.denied.size;
  }

  private assistant(line: Record<string, unknown>): void {
    const message = line.message;
    if (!isRecord(message)) return;
    const content = Array.isArray(message.content) ? message.content.slice(0, MAX_BLOCKS_PER_LINE) : [];
    for (const block of content) {
      if (!isRecord(block) || block.type !== "tool_use" || typeof block.id !== "string" || block.id === "" || block.id.length > MAX_ID_CHARS) continue;
      if (this.toolById.size >= MAX_TRACKED_TOOL_CALLS) break;
      // A call id seen again (the same block repeated in a later line) is one call.
      if (this.toolById.has(block.id)) continue;
      const tool = toolOf(block.name);
      this.toolById.set(block.id, tool);
      this.toolCalls.set(tool, Math.min((this.toolCalls.get(tool) ?? 0) + 1, CONTEXT_MAX_TOOL_CALLS));
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
    // A subagent (Task) thread has a context of its own: its turns are costs (the sums above) but not the main thread's context.
    if (typeof line.parent_tool_use_id === "string") return;
    // Three fields each up to the cap can sum past it, and the store refuses a figure above it: clamp, so one huge turn never costs the row.
    const context = Math.min(input + read + write, CONTEXT_MAX_COUNT);
    if (this.firstId === undefined) this.firstId = id;
    if (id === this.firstId) this.firstContext = context;
    if (context > this.peak) this.peak = context;
    this.lastContext = context;
  }

  /** The context of the main thread's latest turn, in tokens (0 before any turn). Not the peak: after a compaction it falls. */
  lastContextTokens(): number {
    return this.lastContext;
  }

  private user(line: Record<string, unknown>): void {
    const message = line.message;
    const content = isRecord(message) && Array.isArray(message.content) ? message.content.slice(0, MAX_BLOCKS_PER_LINE) : [];
    for (const block of content) {
      if (!isRecord(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const tool = this.toolById.get(block.tool_use_id) ?? "other";
      if (block.is_error === true && DENIABLE_TOOLS.has(tool)) {
        const text = resultText(block.content);
        if (DENIAL_TEXT.test(text) || (this.disabledTools.includes(tool) && noSuchTool(tool).test(text))) this.deny(block.tool_use_id);
      }
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
    const tool_call_counts: Partial<Record<ContextTool, number>> = {};
    for (const tool of CONTEXT_TOOL_ENUM) {
      const calls = this.toolCalls.get(tool);
      if (calls !== undefined) tool_call_counts[tool] = calls;
    }
    return {
      basis: measured ? "measured" : "partial",
      first_turn_input_tokens: measured ? this.firstContext : null,
      peak_context_tokens: measured ? this.peak : null,
      cache_read_tokens: measured ? Math.min(this.cacheRead, CONTEXT_MAX_COUNT) : null,
      cache_write_tokens: measured ? Math.min(this.cacheWrite, CONTEXT_MAX_COUNT) : null,
      tool_output_bytes,
      compactions: this.compactions,
      tool_call_counts,
    };
  }
}

function addToolCalls(a: Partial<Record<ContextTool, number>> | undefined, b: Partial<Record<ContextTool, number>> | undefined): Partial<Record<ContextTool, number>> {
  const out: Partial<Record<ContextTool, number>> = {};
  for (const tool of CONTEXT_TOOL_ENUM) {
    const x = a?.[tool];
    const y = b?.[tool];
    if (x !== undefined || y !== undefined) out[tool] = Math.min((x ?? 0) + (y ?? 0), CONTEXT_MAX_TOOL_CALLS);
  }
  return out;
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
    ...(a.tool_call_counts === undefined && b.tool_call_counts === undefined ? {} : { tool_call_counts: addToolCalls(a.tool_call_counts, b.tool_call_counts) }),
    ...(a.denied_tool_calls === undefined && b.denied_tool_calls === undefined ? {} : { denied_tool_calls: Math.min((a.denied_tool_calls ?? 0) + (b.denied_tool_calls ?? 0), 1_000_000) }),
  };
}

/** The body of a runner's `done.context_ledger` (a strict schema in messages.ts) and how it maps to and from a measure. A figure not measured is absent. */
export interface ContextLedgerWire {
  basis: ContextLedgerBasis;
  sections: ContextSection[];
  first_turn_input?: number;
  peak_context?: number;
  cache_read?: number;
  cache_write?: number;
  memory?: number;
  tool_output_bytes: Partial<Record<ContextTool, number>>;
  /** D#600 CX-10a: tool calls by tool; absent when the measure carries none. */
  tool_call_counts?: Partial<Record<ContextTool, number>>;
  compactions: number;
}

export function contextLedgerToWire(measure: ContextLedgerMeasure, sections: readonly ContextSection[] = [], memoryTokens?: number): ContextLedgerWire {
  const keep = <K extends string>(key: K, value: number | null | undefined): { [P in K]?: number } => (value === null || value === undefined ? {} : ({ [key]: value } as { [P in K]?: number }));
  return {
    basis: measure.basis,
    sections: [...sections],
    ...keep("first_turn_input", measure.first_turn_input_tokens),
    ...keep("peak_context", measure.peak_context_tokens),
    ...keep("cache_read", measure.cache_read_tokens),
    ...keep("cache_write", measure.cache_write_tokens),
    ...keep("memory", memoryTokens),
    tool_output_bytes: { ...measure.tool_output_bytes },
    ...(measure.tool_call_counts === undefined ? {} : { tool_call_counts: { ...measure.tool_call_counts } }),
    compactions: measure.compactions,
  };
}

/** What the cloud stores for a runner that sent no ledger (an older runner): a `partial` row with nothing measured, never zeros. */
export const NOT_RECORDED_MEASURE: ContextLedgerMeasure = Object.freeze({
  basis: "partial",
  first_turn_input_tokens: null,
  peak_context_tokens: null,
  cache_read_tokens: null,
  cache_write_tokens: null,
  tool_output_bytes: Object.freeze({}),
  compactions: 0,
}) as ContextLedgerMeasure;

export function contextLedgerFromWire(wire: ContextLedgerWire): { measure: ContextLedgerMeasure; sections: ContextSection[]; memoryTokens?: number } {
  return {
    measure: {
      basis: wire.basis,
      first_turn_input_tokens: wire.first_turn_input ?? null,
      peak_context_tokens: wire.peak_context ?? null,
      cache_read_tokens: wire.cache_read ?? null,
      cache_write_tokens: wire.cache_write ?? null,
      tool_output_bytes: { ...wire.tool_output_bytes },
      compactions: wire.compactions,
      ...(wire.tool_call_counts === undefined ? {} : { tool_call_counts: { ...wire.tool_call_counts } }),
    },
    sections: wire.sections,
    ...(wire.memory === undefined ? {} : { memoryTokens: wire.memory }),
  };
}
