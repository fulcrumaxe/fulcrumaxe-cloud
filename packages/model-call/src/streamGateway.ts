import { ModelCallError } from './keyUse.js';
import type { StreamTurnParams, StreamTurnResult } from './streamTurn.js';
import { providerErrorKind, pumpSse, ToolVetter, type StreamOut } from './streamCore.js';
/**
 * Fixed allowance for the provider's own tool preamble, which the request bytes do not show (the gateway adds a system block per request that carries tools).
 * Added to the estimate only when tools are sent, so a small tool request is never metered below the real input.
 */
export const TOOL_PREAMBLE_OVERHEAD_TOKENS = 1500;


const STOP_REASONS: Record<string, string> = { stop: 'end_turn', tool_calls: 'tool_use', length: 'max_tokens' };

/** The AI Gateway (chat-completions) stream: `data:` chunks with choices[0].delta, tool_calls fragments joined by index, a final usage chunk, `[DONE]`. */
export async function readGatewayStream(body: ReadableStream<Uint8Array> | null, signal: AbortSignal, p: StreamTurnParams): Promise<StreamTurnResult> {
  const out: StreamOut = { text: '', toolCalls: [], rejectedCalls: [], endedBy: null, stopReason: null, usage: { inputTokens: 0, outputTokens: 0 }, incomplete: true };
  let done = false;
  let finished = false;
  let usageSeen = false;
  const pending = new Map<number, { id: string; name: string; json: string }>();
  const vetter = new ToolVetter(out, p.tools.map((t) => t.name));
  const fail = (kind: string) => new ModelCallError('stream_error', `model-call (${p.role}): the provider stream ${kind}`);
  const handle = (data: string): void => {
    if (data === '[DONE]') {
      done = true;
      return;
    }
    let ev: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      ev = JSON.parse(data);
    } catch {
      throw fail('sent an unreadable event');
    }
    if (ev === null || typeof ev !== 'object') throw fail('sent an unreadable event');
    if (ev.error !== undefined) throw fail(`ended with an error (${providerErrorKind(ev.error?.type)})`);
    if (ev.usage && typeof ev.usage === 'object') {
      usageSeen = true;
      out.usage = { inputTokens: Number(ev.usage.prompt_tokens) || 0, outputTokens: Number(ev.usage.completion_tokens) || 0 };
    }
    const choice = Array.isArray(ev.choices) ? ev.choices[0] : undefined;
    const delta = choice?.delta;
    if (typeof delta?.content === 'string' && delta.content !== '') {
      out.text += delta.content;
      try {
        p.onText?.(delta.content);
      } catch {
        throw new ModelCallError('fetch_failed', `model-call (${p.role}): the stream consumer failed`);
      }
    }
    if (Array.isArray(delta?.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const index = Number(tc?.index);
        if (!Number.isInteger(index) || index < 0) continue;
        const t = pending.get(index) ?? { id: '', name: '', json: '' };
        if (typeof tc.id === 'string' && tc.id !== '') t.id = tc.id;
        if (typeof tc.function?.name === 'string') t.name += tc.function.name;
        if (typeof tc.function?.arguments === 'string') t.json += tc.function.arguments;
        pending.set(index, t);
      }
    }
    if (typeof choice?.finish_reason === 'string') {
      finished = true;
      out.stopReason = STOP_REASONS[choice.finish_reason] ?? choice.finish_reason;
      // Only a finish_reason closes the arguments: a stream cut before it leaves them truncated, and a truncated string is never a call.
      for (const index of [...pending.keys()].sort((a, b) => a - b)) {
        const t = pending.get(index)!;
        vetter.close(t.id, t.name, t.json);
      }
      pending.clear();
    }
  };
  await pumpSse(body, p.maxStreamBytes, out, (e) => e.data !== '' && handle(e.data), () => done);
  out.incomplete = !done || !finished || vetter.poisoned;
  if (!done && out.endedBy === null) out.endedBy = signal.aborted ? 'deadline' : 'cut';
  if (!usageSeen) {
    // No usage chunk: meter the turn at its worst case, the request's size as input tokens (a token is never more than a byte, so bytes bound the tokens from above) plus the tool preamble allowance and the full output allowance.
    out.usage = { inputTokens: Buffer.byteLength(JSON.stringify([p.system, p.messages, p.tools])) + (p.tools.length > 0 ? TOOL_PREAMBLE_OVERHEAD_TOKENS : 0), outputTokens: p.maxOutputTokens };
    out.usageEstimated = true;
  }
  return out;
}
