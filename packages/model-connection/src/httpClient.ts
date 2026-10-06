import { reportError } from '@fx/telemetry';
import type { Provider } from './types.js';

/**
 * Criterion 3's discriminated validation result. Three outcomes, not
 * two: "ok"/"the key is bad"/"we couldn't tell" are handled completely
 * differently by the caller (store as ok / store nothing / store as
 * unvalidated).
 */
export type ValidationOutcome =
  | { kind: 'ok' }
  | { kind: 'rejected'; code: string; message: string }
  | { kind: 'network_error'; code: string; message: string };

/** The one-call-per-provider "prove the key works" request -- deliberately carries no accountId/connectionId. */
export interface ValidationRequest {
  provider: Provider;
  plaintextKey: string;
}

/** Criterion 3's injectable HTTP client. The real impl (below) and the test fake implement this same interface. */
export interface ValidationHttpClient {
  validate(req: ValidationRequest): Promise<ValidationOutcome>;
}

function outcomeFromStatus(status: number, provider: Provider): ValidationOutcome {
  if (status >= 200 && status < 300) {
    return { kind: 'ok' };
  }
  if (status === 401 || status === 403) {
    return {
      kind: 'rejected',
      code: String(status),
      message: `${provider}: key rejected (HTTP ${status}) -- check the key and its account permissions`,
    };
  }
  // Any other status (429, 5xx, unexpected 4xx) is treated the same as a
  // network error: it doesn't prove the key is bad, only that this
  // attempt couldn't confirm the key is good.
  return {
    kind: 'network_error',
    code: String(status),
    message: `${provider}: validation call returned HTTP ${status}`,
  };
}

/**
 * The cheapest-call-per-provider real implementation (spike S7 picks the
 * exact call; until it does, this uses the models-listing shape the Spec
 * names as its own example). Goes over `fetch`, already blocked for
 * these two hosts by test-guard whenever FX_FORBID_MODEL_CALLS=1 -- so
 * unreachable from this package's own test suite.
 */
export function fetchValidationHttpClient(timeoutMs = 5000): ValidationHttpClient {
  return {
    async validate({ provider, plaintextKey }: ValidationRequest): Promise<ValidationOutcome> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const { url, headers } = requestFor(provider, plaintextKey);
        // redirect: 'error' (security review finding 6) -- a models-listing
        // call has no reason to redirect, and Node keeps custom headers
        // (x-api-key) on a cross-origin redirect even though it strips
        // Authorization, so following one would leak the key off-host.
        const response = await fetch(url, {
          method: 'GET',
          headers,
          signal: controller.signal,
          redirect: 'error',
        });
        return outcomeFromStatus(response.status, provider);
      } catch (err) {
        reportError(err, { stage: "model_key.validate" });
        // Security review finding 1: never interpolate the underlying
        // fetch/undici error into the outcome. A plaintext key with an
        // embedded CR/LF/NUL makes `fetch` throw an error whose message
        // contains the entire "Bearer <key>" header value -- a fixed
        // code and message keep that out of ValidationOutcome (and out
        // of anything that logs or returns it) no matter what `fetch`
        // throws or why.
        return {
          kind: 'network_error',
          code: 'fetch_failed',
          message: `${provider}: validation request failed`,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function requestFor(provider: Provider, plaintextKey: string): { url: string; headers: Record<string, string> } {
  if (provider === 'ai_gateway') {
    return {
      url: 'https://ai-gateway.vercel.sh/v1/models',
      headers: { Authorization: `Bearer ${plaintextKey}` },
    };
  }
  return {
    url: 'https://api.anthropic.com/v1/models',
    headers: { 'x-api-key': plaintextKey, 'anthropic-version': '2023-06-01' },
  };
}
