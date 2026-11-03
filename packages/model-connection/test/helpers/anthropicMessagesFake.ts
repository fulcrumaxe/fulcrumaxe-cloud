import type http from 'node:http';

/**
 * D#597 CC-5a: the POST /v1/messages route of the strict Anthropic fake (see strictProviders.ts, which mounts it behind `messages.enabled`).
 *
 * Enforced like the real API: x-api-key must be a known key (401 authentication_error), anthropic-version must be present, the body must be
 * JSON of a valid messages request (model, max_tokens, roles, non-empty content, tool names and input_schema, tool_result ids that match a
 * tool_use in the message before, and every tool_use answered in the next user message). Errors use the real body shape
 * `{"type":"error","error":{"type","message"},"request_id"}`; 429 carries retry-after; a stream may carry an in-band `error` event.
 * One rule is OURS, stricter than the real API: a missing User-Agent is refused (the PR says so), so a client that forgets it fails the suite.
 *
 * Not faked faithfully: the model's wording, token counts (scripted), rate-limit thresholds, and the real API's exact message text for
 * every validation error. The real streamed shape is checked by hand on staging (R-597-C2-6).
 */
export type FakeEvent = { event: string; data: unknown };
export type MessagesReply =
  | { kind: 'stream'; events: FakeEvent[]; /** Destroy the connection after this many whole events. */ cutAfter?: number; /** Destroy halfway through the next event's bytes. */ cutMidEvent?: boolean; /** After the events, keep sending pings until the client hangs up (an endless stream). */ endless?: boolean }
  | { kind: 'status'; status: number; errorType: string; message?: string; headers?: Record<string, string> };

export interface MessagesCall {
  headers: Record<string, string>;
  bodyText: string;
  /** What the fake answered: null for a stream, else the refusal. */
  refusal: { status: number; type: string; message: string } | null;
}
export interface MessagesFake {
  enabled: boolean;
  /** Scripted answers, consumed in order. An accepted request with nothing scripted gets a 500 and lands in `unscripted`. */
  replies: MessagesReply[];
  calls: MessagesCall[];
  unscripted: number;
  /** Write the stream in slices of this many bytes (0 = one write per event), so events split mid-event and mid-JSON-string. */
  chunkBytes: number;
}
export const newMessagesFake = (): MessagesFake => ({ enabled: false, replies: [], calls: [], unscripted: 0, chunkBytes: 0 });

const NAME = /^[a-zA-Z0-9_-]{1,64}$/;
type Refusal = { status: number; type: string; message: string };
const bad = (message: string): Refusal => ({ status: 400, type: 'invalid_request_error', message });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const blocksOf = (content: unknown): unknown[] => (Array.isArray(content) ? content : []);

export function validateMessagesRequest(headers: Record<string, string>, bodyText: string, knownKeys: Set<string>): Refusal | null {
  const key = headers['x-api-key'] ?? '';
  if (!key || !knownKeys.has(key)) return { status: 401, type: 'authentication_error', message: 'invalid x-api-key' };
  if (!headers['anthropic-version']) return bad('anthropic-version: header is required');
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
  if (!Number.isInteger(b.max_tokens) || (b.max_tokens as number) < 1) return bad('max_tokens: Input should be a valid integer greater than or equal to 1');
  if (b.stream !== undefined && typeof b.stream !== 'boolean') return bad('stream: Input should be a valid boolean');
  if (b.system !== undefined && typeof b.system !== 'string' && !Array.isArray(b.system)) return bad('system: Input should be a valid string');
  if (b.tools !== undefined) {
    if (!Array.isArray(b.tools)) return bad('tools: Input should be a valid list');
    const seen = new Set<string>();
    for (const [i, t] of b.tools.entries()) {
      if (!isObj(t) || typeof t.name !== 'string' || !NAME.test(t.name)) return bad(`tools.${i}.name: String should match pattern '^[a-zA-Z0-9_-]{1,64}$'`);
      if (seen.has(t.name)) return bad(`tools: Tool names must be unique. Found multiple tools named ${t.name}`);
      seen.add(t.name);
      if (t.description !== undefined && typeof t.description !== 'string') return bad(`tools.${i}.description: Input should be a valid string`);
      if (!isObj(t.input_schema) || t.input_schema.type !== 'object') return bad(`tools.${i}.input_schema.type: Input should be 'object'`);
    }
  }
  if (!Array.isArray(b.messages) || b.messages.length === 0) return bad('messages: at least one message is required');
  let prevUseIds: string[] = [];
  for (const [i, m] of b.messages.entries()) {
    if (!isObj(m) || (m.role !== 'user' && m.role !== 'assistant')) return bad(`messages.${i}.role: Input should be 'user' or 'assistant'`);
    if (i === 0 && m.role !== 'user') return bad('messages: first message must use the "user" role');
    if (typeof m.content === 'string' ? m.content === '' : !Array.isArray(m.content) || m.content.length === 0) return bad(`messages.${i}: content must be a non-empty string or list of blocks`);
    const blocks = blocksOf(m.content);
    const results = blocks.filter((x) => isObj(x) && x.type === 'tool_result');
    if (m.role === 'assistant' && results.length > 0) return bad(`messages.${i}: tool_result blocks belong in a user message`);
    // A user message after tool_use blocks must answer every one, and nothing else.
    if (m.role === 'user' && prevUseIds.length > 0) {
      const answered = results.map((x) => (x as Record<string, unknown>).tool_use_id);
      const missing = prevUseIds.filter((id) => !answered.includes(id));
      if (missing.length > 0) return bad(`messages.${i}: tool_use ids were found without tool_result blocks immediately after: ${missing.join(', ')}. Each tool_use block must have a corresponding tool_result block in the next message.`);
    }
    for (const r of results) {
      const id = (r as Record<string, unknown>).tool_use_id;
      if (typeof id !== 'string' || !prevUseIds.includes(id)) return bad(`messages.${i}: unexpected tool_use_id found in tool_result blocks: ${String(id)}. Each tool_result block must have a corresponding tool_use block in the previous message.`);
    }
    if (results.length > 0 && blocks.slice(0, results.length).some((x) => !(isObj(x) && x.type === 'tool_result'))) return bad(`messages.${i}: tool_result blocks must come first in the content`);
    prevUseIds = [];
    for (const x of blocks) {
      if (!isObj(x) || x.type !== 'tool_use') continue;
      if (m.role !== 'assistant') return bad(`messages.${i}: tool_use blocks belong in an assistant message`);
      if (typeof x.id !== 'string' || typeof x.name !== 'string' || !isObj(x.input)) return bad(`messages.${i}: tool_use needs a string id, a string name and an object input`);
      prevUseIds.push(x.id);
    }
  }
  if (prevUseIds.length > 0) return bad('messages: the last message must not be an assistant message holding unanswered tool_use blocks');
  return null;
}

const sse = (e: FakeEvent): string => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
const pause = () => new Promise<void>((r) => setTimeout(r, 2));

/** Answers one POST /v1/messages. The caller has already read the body and recorded nothing yet. */
export async function answerMessages(fake: MessagesFake, knownKeys: Set<string>, headers: Record<string, string>, bodyText: string, res: http.ServerResponse): Promise<void> {
  const refusal = validateMessagesRequest(headers, bodyText, knownKeys);
  fake.calls.push({ headers, bodyText, refusal });
  const requestId = 'req_' + 'x'.repeat(8);
  const fail = (r: Refusal, extra: Record<string, string> = {}) => {
    res.writeHead(r.status, { 'content-type': 'application/json', 'request-id': requestId, ...extra });
    res.end(JSON.stringify({ type: 'error', error: { type: r.type, message: r.message }, request_id: requestId }));
  };
  if (refusal) return fail(refusal);
  const reply = fake.replies.shift();
  if (!reply) {
    fake.unscripted++;
    return fail({ status: 500, type: 'api_error', message: 'fake: nothing scripted' });
  }
  if (reply.kind === 'status') {
    return fail({ status: reply.status, type: reply.errorType, message: reply.message ?? reply.errorType }, reply.headers ?? (reply.status === 429 ? { 'retry-after': '7' } : {}));
  }
  res.socket?.setNoDelay(true);
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'request-id': requestId });
  const events = reply.cutAfter === undefined ? reply.events : reply.events.slice(0, reply.cutAfter);
  for (const e of events) {
    const wire = Buffer.from(sse(e)); // sliced as bytes, so a multi-byte character can split across writes
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
    res.on('close', () => (closed = true));
    while (!closed && !res.destroyed) {
      res.write(sse({ event: 'ping', data: { type: 'ping' } }));
      await pause();
    }
    return;
  }
  if (reply.cutMidEvent) {
    const next = reply.events[events.length];
    if (next) res.write(sse(next).slice(0, 25));
    await pause();
    return void res.destroy();
  }
  if (reply.cutAfter !== undefined) return void res.destroy();
  res.end();
}

/** A real-order turn: message_start, ping, text block(s), tool_use block(s) with input_json_delta fragments, message_delta, message_stop. */
export function turnEvents(o: { text?: string[]; tools?: Array<{ id: string; name: string; input: unknown }>; inputTokens?: number; outputTokens?: number; stopReason?: string } = {}): FakeEvent[] {
  const ev: FakeEvent[] = [
    { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_01', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: o.inputTokens ?? 25, output_tokens: 1 } } } },
  ];
  let index = 0;
  if (o.text) {
    ev.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } }, { event: 'ping', data: { type: 'ping' } });
    for (const t of o.text) ev.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: t } } });
    ev.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
    index++;
  }
  for (const t of o.tools ?? []) {
    const json = JSON.stringify(t.input);
    const cut = Math.max(1, Math.floor(json.length / 3));
    ev.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'tool_use', id: t.id, name: t.name, input: {} } } });
    for (const part of [json.slice(0, cut), json.slice(cut, cut * 2), json.slice(cut * 2)]) {
      ev.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: part } } });
    }
    ev.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
    index++;
  }
  ev.push(
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: o.stopReason ?? (o.tools?.length ? 'tool_use' : 'end_turn'), stop_sequence: null }, usage: { output_tokens: o.outputTokens ?? 12 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  );
  return ev;
}
