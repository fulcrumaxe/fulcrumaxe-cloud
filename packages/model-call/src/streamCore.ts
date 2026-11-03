import { ModelCallError } from './keyUse.js';
import { SseParser, type SseEvent } from './sse.js';
import type { RejectedToolCall, StreamTurnResult, ToolCall, ToolCallRejectReason } from './streamTurn.js';

export type StreamOut = StreamTurnResult;

export const MAX_STREAM_BYTES = 4 * 1024 * 1024;

// The provider's error types we echo; anything else is "unknown" so provider text never reaches a message.
const ERROR_TYPES = ['overloaded_error', 'api_error', 'rate_limit_error', 'invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error', 'request_too_large'];
export const providerErrorKind = (t: unknown): string => (typeof t === 'string' && ERROR_TYPES.includes(t) ? t : 'unknown');

/** A caller may lower the byte cap, never raise it: anything past 4 MB, non-finite or not positive gets the ceiling. */
export function clampStreamBytes(requested: number | undefined): number {
  return typeof requested === 'number' && Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), MAX_STREAM_BYTES) : MAX_STREAM_BYTES;
}

/** Holds a turn's tool_use blocks to the offered tools, in one place for both provider shapes. Rejections carry fixed words only. */
export class ToolVetter {
  poisoned = false;
  private blocks = 0;
  private readonly offered: Set<string>;
  private readonly usedIds = new Set<string>();
  constructor(
    private readonly out: { toolCalls: ToolCall[]; rejectedCalls: RejectedToolCall[] },
    offeredNames: string[],
  ) {
    this.offered = new Set(offeredNames);
  }

  /** One closed block: its id, name and the argument text the provider streamed. */
  close(id: string, name: string, json: string): void {
    this.blocks++;
    const reject = (reason: ToolCallRejectReason): void => {
      this.out.rejectedCalls.push({ code: 'tool_call_rejected', reason, index: this.blocks - 1 });
    };
    let input: unknown;
    try {
      input = JSON.parse(json === '' ? '{}' : json);
    } catch {
      // fx-swallow-ok: an argument string that is not JSON is not a call; reported as rejected and the turn is marked incomplete
      this.poisoned = true;
      return reject('input_not_json');
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return reject('input_not_object');
    if (!this.offered.has(name)) return reject('unknown_tool');
    if (id === '') return reject('bad_id');
    if (this.usedIds.has(id)) return reject('duplicate_id');
    this.usedIds.add(id);
    this.out.toolCalls.push({ id, name, input });
  }
}

/**
 * The read loop both shapes share: bytes in, whole SSE events to `handle`, the byte cap enforced (clamped to 4 MB), the reader always cancelled.
 * A ModelCallError from `handle` propagates; a cut read is reported through `out`, not thrown.
 */
export async function pumpSse(body: ReadableStream<Uint8Array> | null, maxStreamBytes: number | undefined, out: StreamOut, handle: (e: SseEvent) => void, stopped: () => boolean): Promise<void> {
  if (!body) return;
  const parser = new SseParser();
  const cap = clampStreamBytes(maxStreamBytes);
  const reader = body.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > cap) {
        out.endedBy = 'size_cap';
        break;
      }
      for (const e of parser.push(value)) handle(e);
      if (stopped()) break;
    }
  } catch (e) {
    if (e instanceof ModelCallError) throw e;
    // fx-swallow-ok: a read cut short (reset, timeout) is reported as an incomplete turn with what arrived, never a half call
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
