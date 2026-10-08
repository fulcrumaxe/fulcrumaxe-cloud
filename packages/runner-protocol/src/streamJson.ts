import { extractAgentOutputEnvelope } from "./envelope.js";
import { extractToolResults, extractToolUses } from "./toolActivity.js";
import type { NormalizedEvent, NormalizedUsage, StartOptions } from "./agentRuntime.js";

/**
 * D#2 H14c-5a (C44 R2): the pure mapper from one raw Claude Code
 * `stream-json` message onto `NormalizedEvent`. It imports no SDK, so the
 * local runtime, the local runner (`@fulcrumaxe/fx-runner`, which this file moved here for, D#6 R4b1-2) and the sandbox port (which reads the CLI's stdout from
 * outside the VM) normalize identically. `runId`, `role` and `seq` always
 * come from the caller, never from the message.
 */

/** The `type` values of a `stream-json` message that we map. */
const STREAM_JSON_TYPES: ReadonlySet<string> = new Set(["system", "assistant", "user", "result"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The opening marker of the result envelope the agent ends its final message with. */
const RESULT_MARKER_RE = /<!--\s*AGENT_OUTPUT\s*-->/;

/** A message id longer than this is not a real one (they are ~30 chars). */
const MAX_MESSAGE_ID_CHARS = 200;
/** A `message.model` longer than this is not kept (real ones are ~30 chars). */
const MAX_MESSAGE_MODEL_CHARS = 128;

/**
 * True for an `assistant` line the sandbox port must drop and count instead
 * of mapping (D#2 H14c-5b-1, criteria 1-a and MP-MSG):
 *  - `message` is present but not an object, or its `content` is not an
 *    array, or any block in it is not an object; or
 *  - it carries `usage` but no usable string `message.id`, so nothing could
 *    key it in the meter.
 * A line with no `message` at all has neither text nor usage and stays a
 * plain display event.
 */
export function isMalformedAssistant(message: Record<string, unknown>): boolean {
  if (message.type !== "assistant" || message.message === undefined) return false;
  const inner = message.message;
  if (!isRecord(inner) || !Array.isArray(inner.content) || !inner.content.every(isRecord)) return true;
  if (inner.usage === undefined) return false;
  return typeof inner.id !== "string" || inner.id === "" || inner.id.length > MAX_MESSAGE_ID_CHARS;
}

export function isKnownStreamJsonType(message: Record<string, unknown>): boolean {
  return typeof message.type === "string" && STREAM_JSON_TYPES.has(message.type);
}

function toNormalizedUsage(usage: {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}): NormalizedUsage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
  };
}

/** Map one raw stream-json message onto our normalized event shape. */
export function normalizeMessage(
  opts: Pick<StartOptions, "runId" | "role"> & { backend?: string },
  message: Record<string, unknown>,
  seq: number,
  /** The repository root inside the sandbox; tool paths under it are reported relative to it, any other absolute path is dropped. */
  repoRoot?: string,
): NormalizedEvent {
  const ts = new Date().toISOString();
  const sessionId = typeof message.session_id === "string" ? message.session_id : undefined;
  const base: NormalizedEvent = {
    runId: opts.runId,
    role: opts.role,
    seq,
    type: "system",
    ts,
    sessionId,
    ...(opts.backend !== undefined && { backend: opts.backend }),
  };

  if (message.type === "assistant") {
    // `message.message` comes from a process that may be hostile, so it is
    // never assumed to have a shape: a non-array `content` or a non-object
    // block yields no text instead of a throw (see `isMalformedAssistant`,
    // which the sandbox port uses to drop such a line and count it).
    const inner = isRecord(message.message) ? message.message : undefined;
    const content = Array.isArray(inner?.content) ? inner.content : undefined;
    const text = content
      ?.filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("");
    const usage = inner?.usage;
    const toolUses = extractToolUses(content, repoRoot);
    return {
      ...base,
      type: "assistant",
      text,
      ...(toolUses.length > 0 && { toolUses }),
      ...(text !== undefined && RESULT_MARKER_RE.test(text) && { writesResult: true as const }),
      messageId: typeof inner?.id === "string" ? inner.id : undefined,
      messageModel:
        typeof inner?.model === "string" && inner.model !== "" && inner.model.length <= MAX_MESSAGE_MODEL_CHARS ? inner.model : undefined,
      usage: isRecord(usage) ? toNormalizedUsage(usage) : undefined,
    };
  }

  if (message.type === "result") {
    const isError = Boolean(message.is_error);
    const resultText = typeof message.result === "string" ? message.result : undefined;
    const usage = message.usage as Parameters<typeof toNormalizedUsage>[0] | undefined;
    return {
      ...base,
      type: isError ? "error" : "result",
      text: resultText,
      isError,
      costUsd: typeof message.total_cost_usd === "number" ? message.total_cost_usd : undefined,
      usage: usage ? toNormalizedUsage(usage) : undefined,
      agentOutput: resultText ? extractAgentOutputEnvelope(resultText) : undefined,
    };
  }

  if (message.type === "user") {
    const inner = isRecord(message.message) ? message.message : undefined;
    const toolResults = extractToolResults(inner?.content);
    return { ...base, type: "user", ...(toolResults.length > 0 && { toolResults }) };
  }

  return base;
}
