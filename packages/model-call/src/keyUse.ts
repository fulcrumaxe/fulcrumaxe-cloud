import { withOpenedKey, type KeyAccessCtx } from '@fx/model-connection/keyAccess';
import { matchesShape, redactText, SK_ANT_OAT_PATTERN_SOURCE } from '@fx/runtime/src/redact.js';
import { requestFor, type RequestParams } from './hosts.js';

export type ModelCallErrorCode = 'forbidden' | 'subscription_credential' | 'key_rejected' | 'timeout' | 'fetch_failed' | 'http_error';

/** Every message is fixed text or redacted provider text -- never the key, never a raw fetch/undici error. */
export class ModelCallError extends Error {
  constructor(
    public readonly code: ModelCallErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ModelCallError';
  }
}

const MAX_ERROR_BODY_CHARS = 500;

/**
 * S2c: the plaintext key lives only inside this callback's closure -- it builds the request,
 * sends it, and is gone. No module-level state (S2b).
 */
export async function callWithKey(ctx: KeyAccessCtx, fetchImpl: typeof fetch, timeoutMs: number, p: RequestParams) {
  return withOpenedKey(ctx, async ({ provider, key }) => {
    // S2g: no API-side subscription path -- an OAuth-token-shaped credential is never sent.
    if (matchesShape(key, SK_ANT_OAT_PATTERN_SOURCE)) {
      throw new ModelCallError('subscription_credential', 'model-call: subscription credentials are not accepted (bring your own API key)');
    }
    const req = requestFor(provider, key, p);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // S2e: redirect 'error' -- Node keeps x-api-key on a cross-origin redirect.
      const res = await fetchImpl(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: controller.signal, redirect: 'error' });
      const raw = await res.text();
      // Redact BEFORE truncating: cutting first could split the key and dodge the exact-match redaction.
      const text = res.ok ? raw : redactText(raw, [key]).slice(0, MAX_ERROR_BODY_CHARS);
      return { provider, status: res.status, text };
    } catch {
      // Never interpolate the underlying error: undici embeds header values (the key) in some messages.
      if (controller.signal.aborted) throw new ModelCallError('timeout', `model-call: provider call exceeded ${timeoutMs} ms`);
      throw new ModelCallError('fetch_failed', 'model-call: provider request failed');
    } finally {
      clearTimeout(timer);
    }
  });
}
