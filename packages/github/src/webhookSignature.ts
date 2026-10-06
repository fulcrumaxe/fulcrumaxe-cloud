import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * D#2 H13a, body criterion 1: "Webhook HMAC (`X-Hub-Signature-256`)
 * verified with a constant-time compare. A bad signature gets 401 (fixture
 * payloads)."
 *
 * GitHub signs the exact raw request body with HMAC-SHA256 over the
 * webhook's configured secret, and sends it as `sha256=<hex digest>` in
 * the `X-Hub-Signature-256` header
 * (https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).
 * `rawBody` MUST be the literal bytes GitHub sent -- never a re-serialized
 * `JSON.stringify(JSON.parse(rawBody))`, which is not guaranteed to
 * round-trip byte-for-byte (key order, whitespace, unicode escaping) and
 * would make a genuine signature fail to verify.
 */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!secret) return false;
  if (!signatureHeader) return false;

  const expectedHex = createHmac('sha256', secret).update(rawBody).digest('hex');
  const expected = `sha256=${expectedHex}`;

  // Constant-time compare (criterion 1's own words). `timingSafeEqual`
  // throws on a buffer-length mismatch rather than returning false, so an
  // attacker-controlled header of the wrong length must be rejected
  // BEFORE the call, not inside a try/catch that could mask a real bug --
  // this length check is not itself a timing side-channel: it only
  // reveals that the guess has the wrong _length_, which GitHub's own
  // fixed-format `sha256=<64 hex chars>` signature already exposes to
  // anyone, not anything about the secret or the digest bytes.
  const expectedBuf = Buffer.from(expected, 'utf8');
  const receivedBuf = Buffer.from(signatureHeader, 'utf8');
  if (expectedBuf.length !== receivedBuf.length) return false;

  return timingSafeEqual(expectedBuf, receivedBuf);
}
