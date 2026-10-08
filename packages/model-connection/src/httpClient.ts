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
  // 401 is a rejected key for both providers. 403 is a rejected key only for Anthropic (a `permission_error`). On the
  // gateway the credits endpoint answers 403 for a plan restriction, not a bad key, so it can only be "couldn't confirm".
  if (status === 401 || (status === 403 && provider === 'anthropic')) {
    return {
      kind: 'rejected',
      code: String(status),
      message: `${provider}: key rejected (HTTP ${status}) -- check the key and its account permissions`,
    };
  }
  // Any other status (402, 429, 5xx, a gateway 403, unexpected 4xx) is treated the same as a
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
 * exact call; until it does, this uses the models-listing shape). Goes over `fetch`, already blocked for
 * these two hosts by test-guard whenever FX_FORBID_MODEL_CALLS=1 -- so
 * unreachable from this package's own test suite.
 */
export function fetchValidationHttpClient(
  timeoutMs = 5000,
  /** Test seam: a `fetch`-shaped transport. Production leaves it unset and uses the global `fetch`. */
  transport?: typeof fetch,
): ValidationHttpClient {
  return {
    async validate({ provider, plaintextKey }: ValidationRequest): Promise<ValidationOutcome> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const { url, method, headers, redirect } = requestFor(provider, plaintextKey);
        // redirect: 'error' (security review finding 6) -- a models-listing
        // call has no reason to redirect, and Node keeps custom headers
        // (x-api-key) on a cross-origin redirect even though it strips
        // Authorization, so following one would leak the key off-host.
        const response = await (transport ?? fetch)(url, {
          method,
          headers,
          signal: controller.signal,
          redirect,
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

/** What requestFor() decides; the fetch uses exactly these fields. */
export interface ValidationRequestShape {
  url: string;
  method: 'GET';
  headers: Record<string, string>;
  redirect: 'error';
}

/**
 * The one request that proves a key, shared by connect(), the "Test key" button (test()) and the health job.
 * It never generates anything: a GET on a read endpoint, and only the status code is used (the body is never read).
 *
 * Gateway: `/v1/credits`, which needs a valid key. `/v1/models` is never used for a gateway key, because the docs
 * say that endpoint ignores authentication. Reading of the docs (our words, fetched 2026-10-06):
 * vercel.com/docs/ai-gateway/sdks-and-apis/rest-api lists credits as an authenticated read with no charge, and
 * platform.claude.com/docs/en/api/rate-limits defines its limits for the Messages API only, with the models listing
 * naming no model and using no tokens.
 */
export function requestFor(provider: Provider, plaintextKey: string): ValidationRequestShape {
  if (provider === 'ai_gateway') {
    return {
      url: 'https://ai-gateway.vercel.sh/v1/credits',
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: `Bearer ${plaintextKey}` },
    };
  }
  return {
    url: 'https://api.anthropic.com/v1/models',
    method: 'GET',
    redirect: 'error',
    headers: { 'x-api-key': plaintextKey, 'anthropic-version': '2023-06-01' },
  };
}
