import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from '../src/webhookSignature.js';

const SECRET = 'test-webhook-secret';
const BODY = JSON.stringify({ action: 'opened', number: 1 });

function sign(body: string, secret: string = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * D#2 H13a body criterion 1, failing-first: written before
 * webhookSignature.ts existed as anything but a stub -- every case here
 * must fail against an always-true or always-false implementation, and
 * the "accepts a validly signed body" case is what proves that.
 */
describe('verifyWebhookSignature (D#2 H13a body criterion 1)', () => {
  it('accepts a validly signed body', () => {
    expect(verifyWebhookSignature(BODY, sign(BODY), SECRET)).toBe(true);
  });

  it.each([
    ['wrong secret', sign(BODY, 'wrong-secret')],
    ['missing header', null],
    ['undefined header', undefined],
    ['empty header', ''],
    ['no sha256= prefix', 'not-a-signature'],
    ['garbage hex, right prefix', 'sha256=deadbeef'],
    ['sha1 prefix instead of sha256', `sha1=${'a'.repeat(40)}`],
    ['wrong length', 'sha256=abc'],
    ['same-length but wrong digest (proves timingSafeEqual, not a short-circuit)', `sha256=${'0'.repeat(64)}`],
  ] as const)('rejects: %s -- returns false, never throws', (_label, signature) => {
    expect(() => verifyWebhookSignature(BODY, signature, SECRET)).not.toThrow();
    expect(verifyWebhookSignature(BODY, signature, SECRET)).toBe(false);
  });

  it('rejects a signature computed over a different body (tampered payload)', () => {
    const tampered = JSON.stringify({ action: 'closed' });
    expect(verifyWebhookSignature(tampered, sign(BODY), SECRET)).toBe(false);
  });

  it('rejects when the configured secret is empty (misconfiguration fails closed, never open)', () => {
    expect(verifyWebhookSignature(BODY, sign(BODY, ''), '')).toBe(false);
  });
});
