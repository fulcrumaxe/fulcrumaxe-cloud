import type http from 'node:http';

/**
 * D#597 CC-5b: the POST /v1/chat/completions route of the strict AI Gateway fake (strictProviders.ts mounts it behind `chat.enabled`).
 *
 * Enforced like the real gateway (OpenAI-compatible): `Authorization: Bearer <known key>` (401 authentication_error), a JSON content type, a
 * valid body (model, max_tokens, roles system/user/assistant/tool, string or null content, `tools` as {type:"function", function:{name, parameters}}
 * with `parameters` an object schema, `stream_options` only with `stream: true`, every assistant tool_call answered by role "tool" messages that
 * name its id, and no tool message without a call before it). Errors use the real body shape `{"error":{"message","type"}}`; 429 carries
 * retry-after; a stream may carry an in-band `{"error":...}` chunk. One rule is OURS, stricter than the real gateway: a missing User-Agent is
 * refused, so a client that forgets it fails the suite.
 *
 * Not faked faithfully (the PR says so): the model's wording, token counts (scripted), rate-limit thresholds, which model ids the real gateway
 * serves, and the exact validation wording. The real streamed shape is checked by hand on staging with the free credit (R-597-C2-6).
 */
export type ChatChunk = unknown | '[DONE]';
export type ChatReply =
  | { kind: 'stream'; chunks: ChatChunk[]; /** Destroy the connection after this many whole chunks. */ cutAfter?: number; /** Destroy halfway through the next chunk's bytes. */ cutMidEvent?: boolean; /** After the chunks, keep sending SSE comment keep-alives until the client hangs up (an endless stream; no finish and no [DONE]). */ endless?: boolean }
  | { kind: 'status'; status: number; errorType: string; message?: string; headers?: Record<string, string> };

export interface ChatCall {
  headers: Record<string, string>;
  bodyText: string;
  refusal: { status: number; type: string; message: string } | null;
}
export interface ChatFake {
  enabled: boolean;
  replies: ChatReply[];
  calls: ChatCall[];
  unscripted: number;
  /** Write the stream in slices of this many bytes (0 = one write per chunk), so chunks split mid-event and mid-JSON-string. */
  chunkBytes: number;
  /** Endless streams the client hung up on (the provider request was aborted). */
  hangups: number;
}
export const newChatFake = (): ChatFake => ({ enabled: false, replies: [], calls: [], unscripted: 0, chunkBytes: 0, hangups: 0 });

type Refusal = { status: number; type: string; message: string };
const bad = (message: string): Refusal => ({ status: 400, type: 'invalid_request_error', message });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export function validateChatRequest(headers: Record<string, string>, bodyText: string, knownKeys: Set<string>): Refusal | null {
  const auth = headers['authorization'] ?? '';
  const key = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  if (!key || !knownKeys.has(key)) return { status: 401, type: 'authentication_error', message: 'Invalid API key' };
  if (!(headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return bad('Content-Type must be application/json');
  if (!(headers['user-agent'] ?? '').trim()) return bad('fake rule: a User-Agent header is required');
  let b: unknown;
  try {
    b = JSON.parse(bodyText);
  } catch {
    return bad('The request body is not valid JSON');
  }
  if (!isObj(b)) return bad('The request body must be a JSON object');
  if (typeof b.model !== 'string' || b.model === '') return bad('model: Field required');
  if (!Array.isArray(b.messages) || b.messages.length === 0) return bad('messages: Field required (a non-empty array)');
  if (!Number.isInteger(b.max_tokens) || (b.max_tokens as number) < 1) return bad('max_tokens: must be an integer greater than or equal to 1');
  if (b.stream !== undefined && typeof b.stream !== 'boolean') return bad('stream: must be a boolean');
  if (b.stream_options !== undefined && (b.stream !== true || !isObj(b.stream_options))) return bad('stream_options: only allowed when stream is true');
  if (b.tools !== undefined) {
    if (!Array.isArray(b.tools) || b.tools.length === 0) return bad('tools: must be a non-empty array when present');
    const seen = new Set<string>();
    for (const [i, t] of b.tools.entries()) {
      const f = isObj(t) ? t.function : undefined;
      if (!isObj(t) || t.type !== 'function' || !isObj(f)) return bad(`tools.${i}: type must be "function" with a function object`);
      if (typeof f.name !== 'string' || !NAME.test(f.name)) return bad(`tools.${i}.function.name: must match ^[a-zA-Z0-9_-]{1,64}$`);
      if (seen.has(f.name)) return bad(`tools: duplicate function name ${f.name}`);
      seen.add(f.name);
      if (!isObj(f.parameters) || f.parameters.type !== 'object') return bad(`tools.${i}.function.parameters: must be a JSON schema object with type "object"`);
    }
  }
  let open: string[] = []; // ids of the previous assistant message's tool_calls that no tool message has answered yet
  for (const [i, m] of b.messages.entries()) {
    if (!isObj(m) || !['system', 'user', 'assistant', 'tool'].includes(m.role as string)) return bad(`messages.${i}.role: must be system, user, assistant or tool`);
    if (m.role === 'tool') {
      const id = m.tool_call_id;
      if (typeof id !== 'string' || !open.includes(id)) return bad(`messages.${i}: tool message with no matching tool_call_id in the assistant message before it`);
      if (typeof m.content !== 'string') return bad(`messages.${i}.content: must be a string`);
      open = open.filter((x) => x !== id);
      continue;
    }
    if (open.length > 0) return bad(`messages.${i}: tool_calls were not answered by tool messages: ${open.join(', ')}`);
    const calls = m.role === 'assistant' && m.tool_calls !== undefined ? m.tool_calls : [];
    if (m.role !== 'assistant' && m.tool_calls !== undefined) return bad(`messages.${i}: tool_calls belong in an assistant message`);
    if (!Array.isArray(calls)) return bad(`messages.${i}.tool_calls: must be an array`);
    if (m.content === null ? !(m.role === 'assistant' && calls.length > 0) : typeof m.content !== 'string' || (m.content === '' && calls.length === 0)) return bad(`messages.${i}.content: must be a non-empty string (null only for an assistant message with tool_calls)`);
    for (const c of calls) {
      const f = isObj(c) ? c.function : undefined;
      if (!isObj(c) || typeof c.id !== 'string' || c.type !== 'function' || !isObj(f) || typeof f.name !== 'string' || typeof f.arguments !== 'string') return bad(`messages.${i}.tool_calls: each needs a string id, type "function" and function {name, arguments as a string}`);
      open.push(c.id);
    }
  }
  if (open.length > 0) return bad('messages: the last assistant message holds unanswered tool_calls');
  return null;
}

const sse = (c: ChatChunk): string => `data: ${c === '[DONE]' ? '[DONE]' : JSON.stringify(c)}\n\n`;
const pause = () => new Promise<void>((r) => setTimeout(r, 2));

/** Answers one POST /v1/chat/completions. */
export async function answerChat(fake: ChatFake, knownKeys: Set<string>, headers: Record<string, string>, bodyText: string, res: http.ServerResponse): Promise<void> {
  const refusal = validateChatRequest(headers, bodyText, knownKeys);
  fake.calls.push({ headers, bodyText, refusal });
  const fail = (r: Refusal, extra: Record<string, string> = {}) => {
    res.writeHead(r.status, { 'content-type': 'application/json', ...extra });
    res.end(JSON.stringify({ error: { message: r.message, type: r.type } }));
  };
  if (refusal) return fail(refusal);
  const reply = fake.replies.shift();
  if (!reply) {
    fake.unscripted++;
    return fail({ status: 500, type: 'api_error', message: 'fake: nothing scripted' });
  }
  if (reply.kind === 'status') return fail({ status: reply.status, type: reply.errorType, message: reply.message ?? reply.errorType }, reply.headers ?? (reply.status === 429 ? { 'retry-after': '7' } : {}));
  res.socket?.setNoDelay(true);
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
  const chunks = reply.cutAfter === undefined ? reply.chunks : reply.chunks.slice(0, reply.cutAfter);
  for (const c of chunks) {
    const wire = Buffer.from(sse(c));
    if (fake.chunkBytes > 0) {
      for (let i = 0; i < wire.length; i += fake.chunkBytes) {
        res.write(wire.subarray(i, i + fake.chunkBytes));
        await pause();
      }
    } else {
      res.write(wire);
      await pause();
    }
  }
  if (reply.endless) {
    let closed = false;
    res.on('close', () => ((closed = true), fake.hangups++));
    while (!closed && !res.destroyed) {
      res.write(': keep-alive\n\n');
      await pause();
    }
    return;
  }
  if (reply.cutMidEvent) {
    const next = reply.chunks[chunks.length];
    if (next !== undefined) res.write(sse(next).slice(0, 20));
    await pause();
    return void res.destroy();
  }
  if (reply.cutAfter !== undefined) return void res.destroy();
  res.end();
}

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ id: 'gen_01', object: 'chat.completion.chunk', model: 'anthropic/claude-sonnet-5.5', choices: [{ index: 0, delta, finish_reason: finish }] });

/** A real-order turn: a role chunk, content deltas, tool_calls fragments (id and name first, then argument pieces), a finish chunk, a usage-only chunk, [DONE]. */
export function chatTurnChunks(o: { text?: string[]; tools?: Array<{ id: string; name: string; input: unknown }>; promptTokens?: number; completionTokens?: number; noUsage?: boolean } = {}): ChatChunk[] {
  const out: ChatChunk[] = [chunk({ role: 'assistant', content: '' })];
  for (const t of o.text ?? []) out.push(chunk({ content: t }));
  (o.tools ?? []).forEach((t, index) => {
    const json = JSON.stringify(t.input);
    const cut = Math.max(1, Math.floor(json.length / 3));
    out.push(chunk({ tool_calls: [{ index, id: t.id, type: 'function', function: { name: t.name, arguments: '' } }] }));
    for (const part of [json.slice(0, cut), json.slice(cut, cut * 2), json.slice(cut * 2)]) out.push(chunk({ tool_calls: [{ index, function: { arguments: part } }] }));
  });
  out.push(chunk({}, o.tools?.length ? 'tool_calls' : 'stop'));
  if (!o.noUsage) out.push({ id: 'gen_01', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: o.promptTokens ?? 25, completion_tokens: o.completionTokens ?? 12, total_tokens: (o.promptTokens ?? 25) + (o.completionTokens ?? 12) } });
  out.push('[DONE]');
  return out;
}
