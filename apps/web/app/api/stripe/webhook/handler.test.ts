import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { StripeWebhookDeps, WebhookResponse } from "@fx/billing";
import { MAX_STRIPE_WEBHOOK_BODY_BYTES, defaultStripeWebhookDeps, stripeWebhookHandler } from "./handler";

/**
 * Route-layer plumbing only: raw body threading, header extraction, and
 * status/body passthrough. The real signature-verification, dispatch and
 * idempotency logic is @fx/billing's own (packages/billing/test/
 * webhook.test.ts, against real Postgres per the H10 brief) -- this file
 * stays a thin translation test, matching
 * apps/web/app/api/auth/github/callback/handler.test.ts's own pattern of
 * injecting fakes rather than standing up a second Postgres harness here.
 *
 * Security-review fix round 2 (PR #53, finding #6) moved the missing-
 * signature check and the body-size cap into this route layer, BEFORE
 * @fx/billing's `handle` is ever called -- the tests below were updated
 * to match: a missing signature or an oversized body is now rejected
 * without reading/threading the body at all, so `handle` must not be
 * invoked for either case.
 */
function fakeDeps(): StripeWebhookDeps {
  return {
    stripe: {
      webhooks: { constructEvent: vi.fn() },
      billingPortal: { sessions: { create: vi.fn() } },
      checkout: { sessions: { create: vi.fn() } },
      subscriptions: { retrieve: vi.fn(), cancel: vi.fn() },
    },
    webhookSecret: "whsec_unused_in_this_test",
    platformOpsPool: {} as never,
    livemode: false,
  };
}

function requestWithBody(body: string, signature?: string | null, extraHeaders?: Record<string, string>): NextRequest {
  const headers = new Headers(extraHeaders);
  if (signature !== null) {
    headers.set("stripe-signature", signature ?? "v1=fake,t=1");
  }
  return new NextRequest("https://example.test/api/stripe/webhook", {
    method: "POST",
    headers,
    body,
  });
}

describe("POST /api/stripe/webhook", () => {
  it("reads the raw body and the Stripe-Signature header, and passes both through unchanged", async () => {
    const handle = vi.fn(async (rawBody: string, signature: string | null): Promise<WebhookResponse> => {
      expect(rawBody).toBe('{"id":"evt_1"}');
      expect(signature).toBe("v1=abc,t=123");
      return { status: 200, body: { received: true, handled: true, deduped: false } };
    });

    const req = requestWithBody('{"id":"evt_1"}', "v1=abc,t=123");
    const res = await stripeWebhookHandler(req, fakeDeps(), handle);

    expect(handle).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, handled: true, deduped: false });
  });

  it("rejects a missing signature header with 400 BEFORE reading the body, and never calls handle", async () => {
    const handle = vi.fn(async (): Promise<WebhookResponse> => {
      throw new Error("must never be called when the signature header is missing");
    });

    const req = requestWithBody('{"id":"evt_2"}', null);
    const res = await stripeWebhookHandler(req, fakeDeps(), handle);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_signature" });
    expect(handle).not.toHaveBeenCalled();
  });

  it("maps @fx/billing's status/body straight onto the NextResponse", async () => {
    const handle = vi.fn(async (): Promise<WebhookResponse> => ({ status: 400, body: { error: "invalid_signature" } }));
    const req = requestWithBody('{"id":"evt_3"}', "v1=bad,t=1");
    const res = await stripeWebhookHandler(req, fakeDeps(), handle);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_signature" });
  });

  describe("livemode (B3, B19)", () => {
    it.each([
      ["sk_live_FAKE_TEST_ONLY", true],
      ["rk_live_FAKE_TEST_ONLY", true],
      ["sk_test_FAKE_TEST_ONLY", false],
    ])("the default deps derive livemode from the configured key (%s)", (key, expected) => {
      vi.stubEnv("STRIPE_SECRET_KEY", key);
      vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_FAKE_TEST_ONLY");
      vi.stubEnv("DATABASE_URL_PLATFORM_OPS", "postgres://unused.invalid/none");
      expect(defaultStripeWebhookDeps().livemode).toBe(expected);
      vi.unstubAllEnvs();
    });
  });

  describe("body-size cap (finding #6)", () => {
    it("rejects an oversized body with 413 via content-length, and never calls handle", async () => {
      const handle = vi.fn(async (): Promise<WebhookResponse> => {
        throw new Error("must never be called for an oversized body");
      });
      const bigBody = "x".repeat(MAX_STRIPE_WEBHOOK_BODY_BYTES + 1);
      const req = requestWithBody(bigBody, "v1=abc,t=123", {
        "content-length": String(bigBody.length),
      });
      const res = await stripeWebhookHandler(req, fakeDeps(), handle);
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "payload_too_large" });
      expect(handle).not.toHaveBeenCalled();
    });

    it("rejects an oversized body even without a content-length header (streamed check)", async () => {
      const handle = vi.fn(async (): Promise<WebhookResponse> => {
        throw new Error("must never be called for an oversized body");
      });
      const bigBody = "y".repeat(MAX_STRIPE_WEBHOOK_BODY_BYTES + 1);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(bigBody));
          controller.close();
        },
      });
      const req = new NextRequest(
        "https://example.test/api/stripe/webhook",
        {
          method: "POST",
          headers: { "stripe-signature": "v1=abc,t=123" },
          body: stream,
          // `duplex: "half"` is required by undici for a streamed body but is missing from Next's RequestInit type.
          duplex: "half",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see comment above
        } as any,
      );
      const res = await stripeWebhookHandler(req, fakeDeps(), handle);
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "payload_too_large" });
      expect(handle).not.toHaveBeenCalled();
    });

    it("accepts a body right at the cap", async () => {
      const handle = vi.fn(async (): Promise<WebhookResponse> => ({ status: 200, body: { received: true, handled: true, deduped: false } }));
      const body = "z".repeat(MAX_STRIPE_WEBHOOK_BODY_BYTES);
      const req = requestWithBody(body, "v1=abc,t=123", { "content-length": String(body.length) });
      const res = await stripeWebhookHandler(req, fakeDeps(), handle);
      expect(res.status).toBe(200);
      expect(handle).toHaveBeenCalledTimes(1);
    });
  });
});
