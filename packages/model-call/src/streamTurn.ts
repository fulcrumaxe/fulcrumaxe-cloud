import { streamRequestFor, type StreamRequestParams } from './hosts.js';
import { ModelCallError, streamWithKey } from './keyUse.js';
import { failOnStatus } from './providerStatus.js';
import { SseParser } from './sse.js';
import type { ModelCallCtx } from './completeJson.js';

export interface StreamTurnParams extends StreamRequestParams {
  /** The caller's role; appears in error text only. */
  role: string;
  timeoutMs: number;
  /** Called with each text fragment as it arrives (inside the key-holding closure; never given the key). */
  onText?: (delta: string) => void;
  /** Tests lower the byte cap to stay fast; the wall-time deadline is `timeoutMs` (capped at 2 minutes). */
  maxStreamBytes?: number;
}

/** Why a tool_use block was dropped. Fixed words only: nothing the model wrote (name, id, input) is carried. */
export type ToolCallRejectReason = 'input_not_json' | 'input_not_object' | 'unknown_tool' | 'bad_id' | 'duplicate_id';
export interface RejectedToolCall {
  code: 'tool_call_rejected';
  reason: ToolCallRejectReason;
  /** The block's position among this turn's tool_use blocks. */
  index: number;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface StreamTurnResult {
  text: string;
  /** Only blocks closed by the provider with a JSON-object input, an offered tool name and a unique non-empty id: never a half or invented call. */
  toolCalls: ToolCall[];
  /** Blocks that were dropped, each with a fixed code and reason, so the caller can see the refusal. */
  rejectedCalls: RejectedToolCall[];
  /** Why the stream stopped early: the wall-time deadline, the byte cap, or a cut connection. null when it ended with message_stop. */
  endedBy: 'deadline' | 'size_cap' | 'cut' | null;
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
  /** True when the stream ended (cut, timed out, over the size cap) before message_stop. */
  incomplete: boolean;
}

const STREAM_HARD_TIMEOUT_MS = 120_000;
const MAX_STREAM_BYTES = 4 * 1024 * 1024;
// The provider's error types we echo; anything else is "unknown" so provider text never reaches a message.
const ERROR_TYPES = ['overloaded_error', 'api_error', 'rate_limit_error', 'invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error', 'request_too_large'];

/**
 * One streaming, tool-carrying model turn over the account's own key (Anthropic messages shape). Inert: nothing in production calls it yet.
 * Same rules as completeJson: key only inside the closure, constant host, redirect refused, redacted errors, no OAuth-shaped credential.
 */
export async function streamTurn(ctx: ModelCallCtx, p: StreamTurnParams): Promise<StreamTurnResult> {
  if (process.env.FX_FORBID_MODEL_CALLS === '1' && !ctx.fetchImpl) throw new ModelCallError('forbidden', 'model-call: FX_FORBID_MODEL_CALLS is set');
  const res = await streamWithKey(
    ctx,
    ctx.fetchImpl ?? globalThis.fetch,
    Math.min(p.timeoutMs, STREAM_HARD_TIMEOUT_MS),
    (provider, key) => streamRequestFor(provider, key, p),
    (body, signal) => readAnthropicStream(body, signal, p),
  );
  await failOnStatus(ctx, p.role, res);
  return res.value!;
}

async function readAnthropicStream(body: ReadableStream<Uint8Array> | null, signal: AbortSignal, p: StreamTurnParams): Promise<StreamTurnResult> {
  const out: StreamTurnResult = { text: '', toolCalls: [], rejectedCalls: [], endedBy: null, stopReason: null, usage: { inputTokens: 0, outputTokens: 0 }, incomplete: true };
  const parser = new SseParser();
  let stopped = false;
  let poisoned = false;
  const tools = new Map<number, { id: string; name: string; json: string }>();
  const offered = new Set(p.tools.map((t) => t.name));
  const usedIds = new Set<string>();
  let blocks = 0;
  const reject = (reason: ToolCallRejectReason): void => {
    out.rejectedCalls.push({ code: 'tool_call_rejected', reason, index: blocks - 1 });
  };
  const fail = (kind: string) => new ModelCallError('stream_error', `model-call (${p.role}): the provider stream ${kind}`);
  const handle = (data: string): void => {
    let ev: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      ev = JSON.parse(data);
    } catch {
      throw fail('sent an unreadable event');
    }
    switch (ev.type) {
      case 'message_start':
        out.usage.inputTokens = Number(ev.message?.usage?.input_tokens) || 0;
        out.usage.outputTokens = Number(ev.message?.usage?.output_tokens) || 0;
        break;
      case 'content_block_start': {
        const b = ev.content_block;
        if (b?.type === 'tool_use') tools.set(Number(ev.index), { id: typeof b.id === 'string' ? b.id : '', name: typeof b.name === 'string' ? b.name : '', json: '' });
        break;
      }
      case 'content_block_delta': {
        const d = ev.delta;
        if (d?.type === 'text_delta' && typeof d.text === 'string') {
          out.text += d.text;
          try {
            p.onText?.(d.text);
          } catch {
            // A consumer fault is not a cut stream: surface it with fixed text (its own message could carry anything).
            throw new ModelCallError('fetch_failed', `model-call (${p.role}): the stream consumer failed`);
          }
        } else if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          const t = tools.get(Number(ev.index));
          if (t) t.json += d.partial_json;
        }
        break;
      }
      case 'content_block_stop': {
        const t = tools.get(Number(ev.index));
        if (!t) break;
        tools.delete(Number(ev.index));
        blocks++;
        let input: unknown;
        try {
          input = JSON.parse(t.json === '' ? '{}' : t.json);
        } catch {
          // fx-swallow-ok: an argument string that is not JSON is not a call; reported as rejected and the turn is marked incomplete
          poisoned = true;
          reject('input_not_json');
          break;
        }
        if (typeof input !== 'object' || input === null || Array.isArray(input)) {
          reject('input_not_object');
          break;
        }
        if (!offered.has(t.name)) {
          reject('unknown_tool');
          break;
        }
        if (t.id === '') {
          reject('bad_id');
          break;
        }
        if (usedIds.has(t.id)) {
          reject('duplicate_id');
          break;
        }
        usedIds.add(t.id);
        out.toolCalls.push({ id: t.id, name: t.name, input });
        break;
      }
      case 'message_delta':
        if (typeof ev.delta?.stop_reason === 'string') out.stopReason = ev.delta.stop_reason;
        if (ev.usage?.output_tokens !== undefined) out.usage.outputTokens = Number(ev.usage.output_tokens) || 0;
        break;
      case 'message_stop':
        stopped = true;
        break;
      case 'error': {
        const kind = ERROR_TYPES.includes(ev.error?.type) ? ev.error.type : 'unknown';
        throw fail(`ended with an error (${kind})`);
      }
    }
  };
  if (body) {
    const reader = body.getReader();
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > (p.maxStreamBytes ?? MAX_STREAM_BYTES)) {
          out.endedBy = 'size_cap';
          break;
        }
        for (const e of parser.push(value)) if (e.data !== '') handle(e.data);
        if (stopped) break;
      }
    } catch (e) {
      if (e instanceof ModelCallError) throw e;
      // fx-swallow-ok: a read cut short (reset, timeout) is reported as an incomplete turn with what arrived, never a half call
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
  out.incomplete = !stopped || poisoned;
  if (!stopped && out.endedBy === null) out.endedBy = signal.aborted ? 'deadline' : 'cut';
  return out;
}
