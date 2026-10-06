import type { Pool } from "pg";
import { NextRequest, NextResponse } from "next/server";
import { createPool } from "@fx/db/src/pool";
import {
  defaultStripeClient,
  handleStripeWebhookRequest,
  stripeKeyIsLive,
  stripeSecretKeyFromEnv,
  stripeWebhookSecretFromEnv,
  type StripeLike,
  type StripeWebhookDeps,
} from "@fx/billing";

/**
 * The internal Stripe-to-us webhook (D#2605 H10). Stays a plain route,
 * not part of the public API. Every piece of actual logic -- signature
 * verification, event dispatch, the idempotent DB write -- lives in
 * @fx/billing's handleStripeWebhookRequest; this file only translates
 * NextRequest/NextResponse and supplies real deps from env, matching the
 * apps/web/app/api/auth/**\/handler.ts pattern (injectable deps, real
 * ones only constructed lazily and never reached by a test).
 *
 * Reads the RAW body via a capped stream read rather than req.text() --
 * Stripe's signature is computed over the exact bytes it sent;
 * re-serializing a parsed JSON body would break verification for almost
 * any payload.
 *
 * Security-review fix round 2 (PR #53, finding #6): two changes from the
 * reviewed version --
 *  - the `Stripe-Signature` header is checked for presence BEFORE the
 *    body is read at all (Route handlers have no default body-size cap,
 *    so an unauthenticated caller could otherwise make this function
 *    buffer an arbitrarily large body before ever being rejected);
 *  - the body is capped at `MAX_STRIPE_WEBHOOK_BODY_BYTES` (1 MB --
 *    Stripe events are well under this) both via `content-length`, when
 *    present, and while actually reading the stream (a missing or
 *    understated `content-length` must not bypass the cap).
 */
let cachedPlatformOpsPool: Pool | undefined;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

export function defaultStripeWebhookDeps(): StripeWebhookDeps {
  if (!cachedPlatformOpsPool) {
    cachedPlatformOpsPool = createPool(requireEnv("DATABASE_URL_PLATFORM_OPS"));
  }
  return {
    stripe: defaultStripeClient() as StripeLike,
    webhookSecret: stripeWebhookSecretFromEnv(),
    platformOpsPool: cachedPlatformOpsPool,
    livemode: stripeKeyIsLive(stripeSecretKeyFromEnv()),
  };
}

/** Stripe's own webhook payloads are well under this; anything larger is refused rather than buffered. */
export const MAX_STRIPE_WEBHOOK_BODY_BYTES = 1_000_000;

class BodyTooLargeError extends Error {}

/** Reads `req`'s body as text, refusing (by throwing `BodyTooLargeError`)
 * once more than `maxBytes` have been read -- enforced against the
 * actual bytes streamed, not just a trusted `content-length` header. */
async function readBodyCapped(req: NextRequest, maxBytes: number): Promise<string> {
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export async function stripeWebhookHandler(
  req: NextRequest,
  deps: StripeWebhookDeps = defaultStripeWebhookDeps(),
  handle = handleStripeWebhookRequest,
): Promise<NextResponse> {
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "missing_signature" }, { status: 400 });
  }

  const contentLengthHeader = req.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isFinite(contentLength) || contentLength > MAX_STRIPE_WEBHOOK_BODY_BYTES) {
      return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
    }
  }

  let rawBody: string;
  try {
    rawBody = await readBodyCapped(req, MAX_STRIPE_WEBHOOK_BODY_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
    }
    throw err;
  }

  const result = await handle(rawBody, signature, deps);
  return NextResponse.json(result.body, { status: result.status });
}
