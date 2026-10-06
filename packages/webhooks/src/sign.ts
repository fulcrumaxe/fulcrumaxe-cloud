import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * D#31 API-4b, criterion 3: Standard Webhooks signing
 * (https://www.standardwebhooks.com/) -- `webhook-id`, `webhook-timestamp`
 * and `webhook-signature: v1,<base64 HMAC-SHA256>` headers, verifiable by
 * the `standardwebhooks` reference library (packages/webhooks/test/
 * sign.test.ts does exactly that).
 */
export const WEBHOOK_SIGNATURE_VERSION = 'v1';

/** Standard Webhooks' own documented default tolerance
 * (https://www.standardwebhooks.com/) for how far a `webhook-timestamp`
 * may drift from "now" and still verify. D#31 fix round 2, SHOULD 4:
 * without this, a captured valid (signature, payload, timestamp) triple
 * verifies forever, i.e. replays indefinitely. */
export const DEFAULT_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

/** The Standard Webhooks convention: the text after `whsec_` IS the
 * base64-encoded HMAC key, not a further encoded token. A bare secret
 * with no prefix is accepted unchanged (defensive -- every secret this
 * package generates has the prefix; nothing requires it). */
function keyBytesFromSecret(secret: string): Buffer {
  const withoutPrefix = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  return Buffer.from(withoutPrefix, 'base64');
}

function signOne(secret: string, id: string, timestampSeconds: number, body: string): string {
  const signedContent = `${id}.${timestampSeconds}.${body}`;
  const digest = createHmac('sha256', keyBytesFromSecret(secret)).update(signedContent, 'utf8').digest('base64');
  return `${WEBHOOK_SIGNATURE_VERSION},${digest}`;
}

export interface WebhookSignatureHeaders {
  'webhook-id': string;
  'webhook-timestamp': string;
  'webhook-signature': string;
}

/**
 * `secrets`: the endpoint's current secret, plus (only during a 24h
 * rotation overlap) its previous one -- criterion 3: "after rotate-secret,
 * the header carries two v1, signatures for 24h, then only the new one."
 * Order is current-first, but `verifyWebhookSignature` (and every real
 * verifier) checks the whole space-separated list regardless of order.
 */
export function signWebhookPayload(
  secrets: readonly string[],
  id: string,
  timestampSeconds: number,
  body: string,
): WebhookSignatureHeaders {
  if (secrets.length === 0) {
    throw new Error('signWebhookPayload: at least one secret is required');
  }
  const signatures = secrets.map((secret) => signOne(secret, id, timestampSeconds, body));
  return {
    'webhook-id': id,
    'webhook-timestamp': String(timestampSeconds),
    'webhook-signature': signatures.join(' '),
  };
}

/**
 * This module's own verifier -- used by dispatcher.test.ts/sign.test.ts to
 * prove agreement with the `standardwebhooks` reference implementation,
 * and available to any future inbound-verification path. Constant-time
 * per candidate signature (never short-circuits on length before
 * comparing equal-length candidates), true if ANY of `secrets` produces a
 * signature present in the header's space-separated list.
 */
export function verifyWebhookSignature(
  secrets: readonly string[],
  headers: WebhookSignatureHeaders,
  body: string,
  options?: {
    /** Overrides `DEFAULT_TIMESTAMP_TOLERANCE_SECONDS` -- tests use this to
     * probe the boundary without waiting on a real clock. */
    toleranceSeconds?: number;
    /** Overrides "now" (epoch seconds) -- tests use this for a
     * deterministic replay check instead of a real 5-minute sleep. */
    nowSeconds?: number;
  },
): boolean {
  const id = headers['webhook-id'];
  const timestamp = Number(headers['webhook-timestamp']);
  const toleranceSeconds = options?.toleranceSeconds ?? DEFAULT_TIMESTAMP_TOLERANCE_SECONDS;
  const nowSeconds = options?.nowSeconds ?? Math.floor(Date.now() / 1000);
  // Standard Webhooks replay protection: a timestamp too far in the past
  // OR the future is refused before any HMAC comparison happens at all --
  // a stale or malformed timestamp is never worth spending the constant-time
  // compare on.
  if (!Number.isFinite(timestamp) || Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    return false;
  }
  const provided = headers['webhook-signature']
    .split(' ')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const secret of secrets) {
    const expected = Buffer.from(signOne(secret, id, timestamp, body));
    for (const candidate of provided) {
      const candidateBuf = Buffer.from(candidate);
      if (candidateBuf.length === expected.length && timingSafeEqual(candidateBuf, expected)) {
        return true;
      }
    }
  }
  return false;
}
