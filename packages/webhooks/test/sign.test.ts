import { describe, expect, it } from 'vitest';
import { Webhook } from 'standardwebhooks';
import { DEFAULT_TIMESTAMP_TOLERANCE_SECONDS, signWebhookPayload, verifyWebhookSignature } from '../src/sign.js';
import { generateWebhookSecret } from '../src/secrets.js';

/**
 * D#31 API-4b, criterion 3: "each delivery verifies with the
 * standardwebhooks reference verifier using the revealed whsec_ secret."
 * These tests run the REAL `standardwebhooks` package against this
 * module's output, in both directions, so agreement is proven, not
 * assumed.
 */
describe('sign: Standard Webhooks signing', () => {
  it('a signature this module produces verifies with the standardwebhooks reference library', () => {
    const secret = generateWebhookSecret();
    const id = 'evt_11111111-1111-4111-8111-111111111111';
    const now = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ id, type: 'endpoint.test', created_at: new Date().toISOString(), data: {} });

    const headers = signWebhookPayload([secret], id, now, body);

    const wh = new Webhook(secret);
    expect(() => wh.verify(body, headers)).not.toThrow();
    expect(wh.verify(body, headers)).toEqual(JSON.parse(body));
  });

  it('a signature the standardwebhooks reference library produces verifies with this module', () => {
    const secret = generateWebhookSecret();
    const id = 'evt_22222222-2222-4222-8222-222222222222';
    const timestamp = new Date();
    const body = JSON.stringify({ id, type: 'pr.opened', created_at: timestamp.toISOString(), data: {} });

    const wh = new Webhook(secret);
    const signature = wh.sign(id, timestamp, body);

    const ok = verifyWebhookSignature([secret], { 'webhook-id': id, 'webhook-timestamp': String(Math.floor(timestamp.getTime() / 1000)), 'webhook-signature': signature }, body);
    expect(ok).toBe(true);
  });

  it('verification fails under the wrong secret', () => {
    const secret = generateWebhookSecret();
    const wrongSecret = generateWebhookSecret();
    const id = 'evt_33333333-3333-4333-8333-333333333333';
    const now = Math.floor(Date.now() / 1000);
    const body = '{"hello":"world"}';

    const headers = signWebhookPayload([secret], id, now, body);
    expect(() => new Webhook(wrongSecret).verify(body, headers)).toThrow();
    expect(verifyWebhookSignature([wrongSecret], headers, body)).toBe(false);
  });

  it('verification fails if the body is tampered with after signing', () => {
    const secret = generateWebhookSecret();
    const id = 'evt_44444444-4444-4444-8444-444444444444';
    const now = Math.floor(Date.now() / 1000);
    const body = '{"amount":1}';
    const tampered = '{"amount":9999}';

    const headers = signWebhookPayload([secret], id, now, body);
    expect(() => new Webhook(secret).verify(tampered, headers)).toThrow();
    expect(verifyWebhookSignature([secret], headers, tampered)).toBe(false);
  });

  describe('criterion 3: rotation dual-signature, 24h overlap (fake clock)', () => {
    it('signing with [current, previous] produces a header both secrets independently verify', () => {
      const currentSecret = generateWebhookSecret();
      const previousSecret = generateWebhookSecret();
      const id = 'evt_55555555-5555-4555-8555-555555555555';
      const now = Math.floor(Date.now() / 1000);
      const body = '{"during":"overlap"}';

      const headers = signWebhookPayload([currentSecret, previousSecret], id, now, body);
      expect(headers['webhook-signature'].split(' ')).toHaveLength(2);

      expect(verifyWebhookSignature([currentSecret], headers, body)).toBe(true);
      expect(verifyWebhookSignature([previousSecret], headers, body)).toBe(true);
      // The standardwebhooks reference verifier accepts EITHER secret against the same header too.
      expect(() => new Webhook(currentSecret).verify(body, headers)).not.toThrow();
      expect(() => new Webhook(previousSecret).verify(body, headers)).not.toThrow();
    });

    it('after the 24h overlap, signing with only the current secret means the OLD secret no longer verifies', () => {
      const currentSecret = generateWebhookSecret();
      const previousSecret = generateWebhookSecret();
      const id = 'evt_66666666-6666-4666-8666-666666666666';
      const now = Math.floor(Date.now() / 1000);
      const body = '{"after":"overlap"}';

      // The caller (dispatcher.ts's activeSecrets) is what decides whether
      // to include the previous secret at all -- this test proves the
      // signing/verification primitive's OWN behavior once that decision
      // has already excluded it.
      const headers = signWebhookPayload([currentSecret], id, now, body);
      expect(headers['webhook-signature'].split(' ')).toHaveLength(1);
      expect(verifyWebhookSignature([currentSecret], headers, body)).toBe(true);
      expect(verifyWebhookSignature([previousSecret], headers, body)).toBe(false);
    });
  });

  describe('SHOULD 4: timestamp-tolerance window (replay protection)', () => {
    it('a signature with a timestamp older than the tolerance window no longer verifies (replay refused)', () => {
      const secret = generateWebhookSecret();
      const id = 'evt_77777777-7777-4777-8777-777777777777';
      const body = '{"replayed":true}';
      const originalTimestamp = 1_000_000; // fixed epoch seconds, deliberately far from "now"
      const headers = signWebhookPayload([secret], id, originalTimestamp, body);

      // The exact same (id, timestamp, signature, body) presented again
      // long after the tolerance window has passed -- a captured valid
      // triple must not verify forever.
      const nowSeconds = originalTimestamp + DEFAULT_TIMESTAMP_TOLERANCE_SECONDS + 1;
      expect(verifyWebhookSignature([secret], headers, body, { nowSeconds })).toBe(false);
    });

    it('a signature within the tolerance window still verifies', () => {
      const secret = generateWebhookSecret();
      const id = 'evt_88888888-8888-4888-8888-888888888888';
      const body = '{"fresh":true}';
      const originalTimestamp = 1_000_000;
      const headers = signWebhookPayload([secret], id, originalTimestamp, body);

      const nowSeconds = originalTimestamp + DEFAULT_TIMESTAMP_TOLERANCE_SECONDS - 1;
      expect(verifyWebhookSignature([secret], headers, body, { nowSeconds })).toBe(true);
    });

    it('a timestamp in the future beyond the tolerance window is also refused', () => {
      const secret = generateWebhookSecret();
      const id = 'evt_99999999-9999-4999-9999-999999999999';
      const body = '{"future":true}';
      const originalTimestamp = 1_000_000;
      const headers = signWebhookPayload([secret], id, originalTimestamp, body);

      const nowSeconds = originalTimestamp - DEFAULT_TIMESTAMP_TOLERANCE_SECONDS - 1;
      expect(verifyWebhookSignature([secret], headers, body, { nowSeconds })).toBe(false);
    });

    it('a custom toleranceSeconds overrides the default', () => {
      const secret = generateWebhookSecret();
      const id = 'evt_00000000-0000-4000-8000-000000000000';
      const body = '{"custom":true}';
      const originalTimestamp = 1_000_000;
      const headers = signWebhookPayload([secret], id, originalTimestamp, body);

      // 10s past the timestamp: refused under a 5s custom tolerance...
      expect(verifyWebhookSignature([secret], headers, body, { nowSeconds: originalTimestamp + 10, toleranceSeconds: 5 })).toBe(
        false,
      );
      // ...but accepted under a 20s custom tolerance.
      expect(verifyWebhookSignature([secret], headers, body, { nowSeconds: originalTimestamp + 10, toleranceSeconds: 20 })).toBe(
        true,
      );
    });
  });

  it('generateWebhookSecret produces a whsec_-prefixed, base64-decodable secret', () => {
    const secret = generateWebhookSecret();
    expect(secret.startsWith('whsec_')).toBe(true);
    // Constructing a real Webhook instance is itself a validity check --
    // it throws if the decoded key is empty or malformed.
    expect(() => new Webhook(secret)).not.toThrow();
  });
});
