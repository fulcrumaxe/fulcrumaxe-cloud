// S2d: the destination is a constant two-host table keyed by the connection's provider -- never a
// URL, host or base_url from the row. Parity with runner/networkPolicy.ts: test/hosts.test.ts.
export const MODEL_HOSTS = Object.freeze({ ai_gateway: 'ai-gateway.vercel.sh', anthropic: 'api.anthropic.com' });
type Provider = keyof typeof MODEL_HOSTS;
const DEFAULT_MODEL: Record<Provider, string> = { ai_gateway: 'anthropic/claude-sonnet-5.5', anthropic: 'claude-sonnet-5-5' };

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

/** The streaming, tool-carrying request (Anthropic messages shape only; the gateway shape is CC-5b). Called only inside the key-holding closure. */
export function streamRequestFor(provider: string, key: string, p: StreamRequestParams): { url: string; headers: Record<string, string>; body: string } | null {
  if (provider !== 'anthropic') return null;
  return {
    url: `https://${hostFor(provider)}/v1/messages`,
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'user-agent': 'fulcrumaxe-cloud-model-call/0.1', accept: 'text/event-stream' },
    body: JSON.stringify({ model: p.model ?? DEFAULT_MODEL.anthropic, max_tokens: p.maxOutputTokens, system: p.system, messages: p.messages, stream: true, ...(p.tools.length > 0 ? { tools: p.tools } : {}) }),
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
