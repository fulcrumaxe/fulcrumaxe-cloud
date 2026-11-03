// S2d: the destination is a constant two-host table keyed by the connection's provider -- never a
// URL, host or base_url from the row. Parity with runner/networkPolicy.ts: test/hosts.test.ts.
export const MODEL_HOSTS = Object.freeze({ ai_gateway: 'ai-gateway.vercel.sh', anthropic: 'api.anthropic.com' });
type Provider = keyof typeof MODEL_HOSTS;
const DEFAULT_MODEL: Record<Provider, string> = { ai_gateway: 'anthropic/claude-sonnet-5.5', anthropic: 'claude-sonnet-5-5' };
export const DEFAULT_GATEWAY_MODEL = DEFAULT_MODEL.ai_gateway;
// Each id maps to its own plan-data price row or to nothing: a sibling's price is never borrowed (an id with no exact row is `unpriced_model`).

export interface ProviderMessage {
  role: 'user' | 'assistant';
  content: string;
}
export interface RequestParams {
  system: string;
  messages: ProviderMessage[];
  maxOutputTokens: number;
  model?: string;
}

export function hostFor(provider: string): string {
  // Object.hasOwn: "constructor"/"__proto__" must not resolve to an inherited member.
  if (!Object.hasOwn(MODEL_HOSTS, provider)) throw new Error(`model-call: unknown provider "${provider}"`);
  return MODEL_HOSTS[provider as Provider];
}

/** The one no-tools, no-streaming request. Called only from inside the key-holding closure (keyUse.ts). */
export function requestFor(provider: string, key: string, p: RequestParams): { url: string; headers: Record<string, string>; body: string } {
  const host = hostFor(provider);
  const model = p.model ?? DEFAULT_MODEL[provider as Provider];
  if (provider === 'anthropic') {
    return {
      url: `https://${host}/v1/messages`,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: p.maxOutputTokens, system: p.system, messages: p.messages }),
    };
  }
  return {
    url: `https://${host}/v1/chat/completions`,
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: p.maxOutputTokens, messages: [{ role: 'system', content: p.system }, ...p.messages] }),
  };
}

export interface StreamToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
export type StreamContent = string | Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown } | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }>;
export interface StreamMessage {
  role: 'user' | 'assistant';
  content: StreamContent;
}
export interface StreamRequestParams extends Omit<RequestParams, 'messages'> {
  messages: StreamMessage[];
  tools: StreamToolDef[];
}

/**
 * The one table from a gateway model id to the priced model id of the plan-data price source (no price is compiled in: the id is the key).
 * An id that is not here is unpriced: the caller answers `assistant_unpriced` and no call is made (R-597-C2-5).
 */
const GATEWAY_PRICED_MODEL: Readonly<Record<string, string>> = Object.freeze({
  'anthropic/claude-haiku-4.5': 'haiku-4.5',
  'anthropic/claude-sonnet-5': 'sonnet-5',
  // Its own exact key, never the sonnet-5 row: with no 'sonnet-5.5' row in the plan data the caller's price lookup misses and the turn is unpriced.
  'anthropic/claude-sonnet-5.5': 'sonnet-5.5',
  'anthropic/claude-opus-5': 'opus-5',
});
export function gatewayPricedModel(gatewayModelId: string): string | null {
  return Object.hasOwn(GATEWAY_PRICED_MODEL, gatewayModelId) ? GATEWAY_PRICED_MODEL[gatewayModelId]! : null;
}

const STREAM_UA = 'fulcrumaxe-cloud-model-call/0.1';

// The chat-completions form of a messages list: tool_use blocks become assistant tool_calls, tool_result blocks become role "tool" messages.
function gatewayMessages(system: string, messages: StreamMessage[]): unknown[] {
  const out: unknown[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      const calls = m.content.flatMap((b) => (b.type === 'tool_use' ? [{ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } }] : []));
      out.push({ role: 'assistant', content: text === '' && calls.length > 0 ? null : text, ...(calls.length > 0 ? { tool_calls: calls } : {}) });
      continue;
    }
    for (const b of m.content) {
      if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content });
      else if (b.type === 'text') out.push({ role: 'user', content: b.text });
    }
  }
  return out;
}

/** The streaming, tool-carrying request for either provider shape. Called only inside the key-holding closure. Null when the gateway model id has no priced mapping. */
export function streamRequestFor(provider: string, key: string, p: StreamRequestParams): { url: string; headers: Record<string, string>; body: string } | null {
  // Only the two shapes with a streaming path; any other provider row (openai, an OAuth kind, an unknown name) sends nothing.
  if (provider !== 'anthropic' && provider !== 'ai_gateway') return null;
  const host = hostFor(provider);
  if (provider === 'anthropic') {
    return {
      url: `https://${host}/v1/messages`,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'user-agent': STREAM_UA, accept: 'text/event-stream' },
      body: JSON.stringify({ model: p.model ?? DEFAULT_MODEL.anthropic, max_tokens: p.maxOutputTokens, system: p.system, messages: p.messages, stream: true, ...(p.tools.length > 0 ? { tools: p.tools } : {}) }),
    };
  }
  const model = p.model ?? DEFAULT_MODEL.ai_gateway;
  if (gatewayPricedModel(model) === null) return null;
  const tools = p.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  return {
    url: `https://${host}/v1/chat/completions`,
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json', 'user-agent': STREAM_UA, accept: 'text/event-stream' },
    body: JSON.stringify({ model, max_tokens: p.maxOutputTokens, messages: gatewayMessages(p.system, p.messages), stream: true, stream_options: { include_usage: true }, ...(tools.length > 0 ? { tools } : {}) }),
  };
}

/** Assistant text and token usage from either provider's response JSON; null if the shape is wrong. */
export function replyFrom(provider: string, json: unknown) {
  const j = (json ?? {}) as { content?: { type?: string; text?: string }[]; choices?: { message?: { content?: string } }[]; usage?: Record<string, number> };
  const u = j.usage ?? {};
  const text = provider === 'anthropic' ? j.content?.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('') : j.choices?.[0]?.message?.content;
  if (typeof text !== 'string') return null;
  return { text, usage: { inputTokens: Number(u.input_tokens ?? u.prompt_tokens) || 0, outputTokens: Number(u.output_tokens ?? u.completion_tokens) || 0 } };
}
