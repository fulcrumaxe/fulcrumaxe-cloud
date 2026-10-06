import type { Pool } from "pg";
import { NextRequest, NextResponse } from "next/server";
import { createPool } from "@fx/db/src/pool";
import {
  handleGithubWebhookEventForApp,
  isHandledEventName,
  loadAppCredentials,
  recordInstallationLifecycle,
  selectWebhookApp,
  verifyWebhookSignature,
  type ApplyHooks,
  type AppCredentialsSource,
  type GithubWebhookDbDeps,
  type GithubWebhookPayload,
  type HandleWebhookResult,
} from "@fx/github";
import { buildSyncRepos } from "../../../../lib/github/repoSync";
import { intakeAllowlist } from "../../../../lib/github/intakeTrust";
import { issueAuthorPermission } from "../../../../lib/github/issueAuthorPermission";
import { emitDomainEvent } from "@fx/core/src/domain-events/emit.js";

/**
 * D#2 H13a: GitHub App webhook intake. Every piece of actual logic --
 * signature verification (body criterion 1), event mapping (body
 * criterion 2), tenant resolution, and the database write (C18, C7, C25
 * item 2) -- lives in @fx/github's handleGithubWebhookEvent; this file
 * only translates NextRequest/NextResponse and supplies real deps from
 * env, matching apps/web/app/api/stripe/webhook/handler.ts's pattern
 * (injectable deps + an injectable `handle`, so handler.test.ts stays a
 * thin route-layer test with no real Postgres).
 *
 * Reads the RAW body via a capped stream read -- GitHub's signature is
 * computed over the exact bytes sent, and Route handlers have no default
 * body-size cap (same reasoning as the Stripe handler's own fix round 2).
 */

/** GitHub webhook payloads are well under this; anything larger is refused rather than buffered. */
export const MAX_GITHUB_WEBHOOK_BODY_BYTES = 5_000_000;

class BodyTooLargeError extends Error {}

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

export interface GithubWebhookHandlerDeps extends GithubWebhookDbDeps {
  /** Per-App credentials; the delivery's target-id header picks which kind's webhook secret verifies it. */
  appCredentials: AppCredentialsSource;
}

let cachedAppUserPool: Pool | undefined;
let cachedPlatformOpsPool: Pool | undefined;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

export function defaultGithubWebhookDeps(): GithubWebhookHandlerDeps {
  if (!cachedAppUserPool) {
    cachedAppUserPool = createPool(requireEnv("DATABASE_URL_APP_USER"));
  }
  if (!cachedPlatformOpsPool) {
    cachedPlatformOpsPool = createPool(requireEnv("DATABASE_URL_PLATFORM_OPS"));
  }
  // C7 / C25 item 2 hook points. D#31 API-4a wires the real
  // `emitDomainEvent` here (comment 18587796: "API-4 wires the real
  // emitDomainEvent into H13a's hook point with one registration line").
  // `syncDefaultBranchMcpConfig` (D#47 M12) is still unwired.
  //
  // eventMapper.ts's `EmitDomainEvent` returns Promise<void>; @fx/core's
  // `emitDomainEvent` returns Promise<EmittedDomainEvent> (the caller
  // rarely needs the generated id back). TypeScript's "a function
  // returning anything is assignable where void is expected" leniency
  // only applies to the return value itself, not through a Promise's type
  // parameter -- Promise<EmittedDomainEvent> is not assignable to
  // Promise<void> -- so this one-line adapter discards it explicitly.
  const hooks: ApplyHooks = {
    emitDomainEvent: async (client, event) => {
      await emitDomainEvent(client, event);
    },
  };
  return {
    appCredentials: loadAppCredentials(process.env),
    appUserPool: cachedAppUserPool,
    platformOpsPool: cachedPlatformOpsPool,
    hooks,
    allowlist: intakeAllowlist() ?? undefined,
    issueAuthorPermission,
    syncRepos: buildSyncRepos({
      platformOpsPool: cachedPlatformOpsPool,
      appUserPool: cachedAppUserPool,
      appCredentials: loadAppCredentials(process.env),
    }),
  };
}

export async function githubWebhookHandler(
  req: NextRequest,
  deps: GithubWebhookHandlerDeps = defaultGithubWebhookDeps(),
  handle = handleGithubWebhookEventForApp,
): Promise<NextResponse> {
  // Body criterion 1: signature presence is checked BEFORE the body is
  // read -- an unauthenticated caller must not be able to make this
  // function buffer an arbitrarily large body before ever being rejected.
  const signatureHeader = req.headers.get("x-hub-signature-256");
  if (!signatureHeader) {
    return NextResponse.json({ error: "missing_signature" }, { status: 401 });
  }
  // D#2 H13e-2: the sending App is chosen by GitHub's target-id header,
  // BEFORE the body is read or any HMAC is computed. An absent or unknown
  // id (including a kind that is not configured) gets the same generic 401
  // as a bad signature; the secrets are never tried in turn.
  const app = selectWebhookApp(deps.appCredentials, req.headers.get("x-github-hook-installation-target-id"));
  if (!app) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  const contentLengthHeader = req.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isFinite(contentLength) || contentLength > MAX_GITHUB_WEBHOOK_BODY_BYTES) {
      return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
    }
  }

  let rawBody: string;
  try {
    rawBody = await readBodyCapped(req, MAX_GITHUB_WEBHOOK_BODY_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
    }
    throw err;
  }

  // Body criterion 1: constant-time compare, 401 on a bad signature --
  // BEFORE anything else touches the payload or the database.
  if (!verifyWebhookSignature(rawBody, signatureHeader, app.webhookSecret)) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  const eventName = req.headers.get("x-github-event");
  const deliveryId = req.headers.get("x-github-delivery");
  if (!eventName || !deliveryId) {
    return NextResponse.json({ error: "missing_event_headers" }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!isHandledEventName(eventName)) {
    // Out-of-scope event (e.g. star, fork, ping): acknowledged and
    // ignored, same shape as the Stripe handler's own out-of-scope
    // events -- GitHub retries on anything but 2xx.
    return NextResponse.json({ handled: false, reason: "unhandled_event_type" }, { status: 200 });
  }

  // D#2 H17e: the verified delivery records who installed the App (and its
  // deleted/suspended state) before the per-kind gate decides anything else.
  if (eventName === "installation") {
    await recordInstallationLifecycle(deps, app.kind, payload);
  }

  const result: HandleWebhookResult = await handle(deps, eventName, payload as GithubWebhookPayload, deliveryId, app.kind);
  return NextResponse.json(result, { status: 200 });
}
