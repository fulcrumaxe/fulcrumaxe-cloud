import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { AppCredentialsSource, GithubWebhookDbDeps, HandleWebhookResult } from "@fx/github";
import { MAX_GITHUB_WEBHOOK_BODY_BYTES, defaultGithubWebhookDeps, githubWebhookHandler, type GithubWebhookHandlerDeps } from "./handler";
import { setIntakeAllowlistForTests } from "../../../../lib/github/intakeTrust";

/**
 * Route-layer plumbing only: raw body threading, HMAC verification
 * (D#2 H13a body criterion 1), header extraction, unhandled-event
 * acknowledgment, and status/body passthrough. The real event-mapping,
 * tenant-resolution and database-write logic is @fx/github's own
 * (packages/github/test/eventMapper.test.ts and .pg.test.ts) -- this file
 * stays a thin translation test, matching
 * apps/web/app/api/stripe/webhook/handler.test.ts's own pattern of
 * injecting a fake `handle` rather than standing up a second Postgres
 * harness here.
 */
const SECRET = "test-github-webhook-secret";

function sign(body: string, secret: string = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

// H13e-2: the delivery's target-id header picks the App; the existing tests run as the `team` App.
const TEAM_APP_ID = "111";

/** A source with only the `team` kind configured, as the deployment had before H13e. */
function teamOnlyCredentials(secret: string = SECRET): AppCredentialsSource {
  return (kind) => {
    if (kind !== "team") throw new Error("not_configured");
    return { appId: TEAM_APP_ID, privateKeyPem: "unused", webhookSecret: secret };
  };
}

function fakeDeps(overrides: Partial<GithubWebhookHandlerDeps> = {}): GithubWebhookHandlerDeps {
  return { appCredentials: teamOnlyCredentials(), appUserPool: {} as never, platformOpsPool: {} as never, hooks: {}, ...overrides };
}

function requestWithBody(
  body: string,
  opts: { signature?: string | null; event?: string | null; delivery?: string | null; extraHeaders?: Record<string, string> } = {},
): NextRequest {
  const headers = new Headers({ "x-github-hook-installation-target-id": TEAM_APP_ID, ...opts.extraHeaders });
  if (opts.signature !== null) headers.set("x-hub-signature-256", opts.signature ?? sign(body));
  if (opts.event !== null) headers.set("x-github-event", opts.event ?? "issues");
  if (opts.delivery !== null) headers.set("x-github-delivery", opts.delivery ?? "11111111-1111-1111-1111-111111111111");
  return new NextRequest("https://example.test/api/github/webhook", { method: "POST", headers, body });
}

function neverCalled(): ReturnType<typeof vi.fn> {
  return vi.fn(async (): Promise<HandleWebhookResult> => {
    throw new Error("must never be called for a rejected request");
  });
}

describe("POST /api/github/webhook", () => {
  it("verifies the HMAC and calls handle with the parsed event/payload/deliveryId", async () => {
    const body = JSON.stringify({ action: "opened", issue: { number: 1 } });
    const handle = vi.fn(async (_deps: GithubWebhookDbDeps, eventName, payload, deliveryId): Promise<HandleWebhookResult> => {
      expect(eventName).toBe("issues");
      expect(payload).toEqual(JSON.parse(body));
      expect(deliveryId).toBe("delivery-abc");
      return { handled: true, result: { applied: "skipped", reason: "test" } };
    });

    const req = requestWithBody(body, { signature: sign(body), event: "issues", delivery: "delivery-abc" });
    const res = await githubWebhookHandler(req, fakeDeps(), handle);

    expect(handle).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ handled: true, result: { applied: "skipped", reason: "test" } });
  });

  it("rejects a missing signature header with 401 BEFORE reading the body, and never calls handle", async () => {
    const handle = neverCalled();
    const res = await githubWebhookHandler(requestWithBody('{"action":"opened"}', { signature: null }), fakeDeps(), handle);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "missing_signature" });
    expect(handle).not.toHaveBeenCalled();
  });

  it("rejects a bad signature with 401 (body criterion 1) and never calls handle", async () => {
    const handle = neverCalled();
    const body = JSON.stringify({ action: "opened" });
    const req = requestWithBody(body, { signature: sign(body, "wrong-secret"), event: "issues", delivery: "d1" });
    const res = await githubWebhookHandler(req, fakeDeps(), handle);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_signature" });
    expect(handle).not.toHaveBeenCalled();
  });

  // H2-5 (the one authorized assertion change): an unconfigured kind's webhooks now get a generic 401, not a 500.
  it("rejects when the webhook secret is not configured, with a generic 401 that doesn't name the secret, and never calls handle", async () => {
    const handle = neverCalled();
    const body = JSON.stringify({ action: "opened" });
    const req = requestWithBody(body, { signature: sign(body), event: "issues", delivery: "d1" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    const noApps: AppCredentialsSource = () => {
      throw new Error("not_configured");
    };
    const res = await githubWebhookHandler(req, fakeDeps({ appCredentials: noApps }), handle);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_signature" });
    expect(handle).not.toHaveBeenCalled();
    const output = JSON.stringify([...errors.mock.calls, ...logged.mock.calls]);
    expect(output).not.toContain("WEBHOOK_SECRET");
    expect(output).not.toContain(SECRET);
    errors.mockRestore();
    logged.mockRestore();
  });

  it("rejects missing X-GitHub-Event or X-GitHub-Delivery headers with 400, and never calls handle", async () => {
    const handle = neverCalled();
    const body = JSON.stringify({ action: "opened" });
    const noEvent = requestWithBody(body, { signature: sign(body), event: null, delivery: "d1" });
    expect((await githubWebhookHandler(noEvent, fakeDeps(), handle)).status).toBe(400);
    const noDelivery = requestWithBody(body, { signature: sign(body), event: "issues", delivery: null });
    expect((await githubWebhookHandler(noDelivery, fakeDeps(), handle)).status).toBe(400);
    expect(handle).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON with 400, and never calls handle", async () => {
    const handle = neverCalled();
    const body = "{not json";
    const req = requestWithBody(body, { signature: sign(body), event: "issues", delivery: "d1" });
    expect((await githubWebhookHandler(req, fakeDeps(), handle)).status).toBe(400);
    expect(handle).not.toHaveBeenCalled();
  });

  it("acknowledges an out-of-scope event type (e.g. star) with 200 and never calls handle", async () => {
    const handle = neverCalled();
    const body = JSON.stringify({ action: "created" });
    const req = requestWithBody(body, { signature: sign(body), event: "star", delivery: "d1" });
    const res = await githubWebhookHandler(req, fakeDeps(), handle);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ handled: false, reason: "unhandled_event_type" });
    expect(handle).not.toHaveBeenCalled();
  });

  describe("per-App verification (H13e-2)", () => {
    const APPS = { team: "111", team_readonly: "222", sitekit: "333" } as const;
    const secretOf = (kind: keyof typeof APPS) => `secret-for-${kind}-`.padEnd(40, "x");
    const three: AppCredentialsSource = (kind) => {
      if (kind !== "team" && kind !== "team_readonly" && kind !== "sitekit") throw new Error("unknown");
      return { appId: APPS[kind], privateKeyPem: "unused", webhookSecret: secretOf(kind) };
    };
    const kinds = Object.keys(APPS) as (keyof typeof APPS)[];
    const body = JSON.stringify({ action: "opened" });

    for (const sender of kinds) {
      it(`accepts a delivery from ${sender} signed with its own secret and hands its kind to handle`, async () => {
        const handle = vi.fn(async (..._args: unknown[]): Promise<HandleWebhookResult> => ({ handled: false, reason: "x" }));
        const req = requestWithBody(body, {
          signature: sign(body, secretOf(sender)),
          extraHeaders: { "x-github-hook-installation-target-id": APPS[sender] },
        });
        const res = await githubWebhookHandler(req, fakeDeps({ appCredentials: three }), handle);
        expect(res.status).toBe(200);
        expect(handle.mock.calls[0]?.[4]).toBe(sender);
      });
      for (const claimed of kinds.filter((k) => k !== sender)) {
        it(`rejects a body signed by ${sender} that claims ${claimed}'s App id`, async () => {
          const handle = neverCalled();
          const req = requestWithBody(body, {
            signature: sign(body, secretOf(sender)),
            extraHeaders: { "x-github-hook-installation-target-id": APPS[claimed] },
          });
          const res = await githubWebhookHandler(req, fakeDeps({ appCredentials: three }), handle);
          expect(res.status).toBe(401);
          expect(handle).not.toHaveBeenCalled();
        });
      }
    }

    // Reading the body needs a reader on the stream, and an HMAC needs the body: an unlocked stream proves neither happened.
    it("401s a missing, unknown or non-decimal target id without reading the body or computing an HMAC", async () => {
      for (const id of [null, "999", "0111", "111.0", "abc"]) {
        const headers = new Headers({ "x-hub-signature-256": sign(body, secretOf("team")) });
        if (id !== null) headers.set("x-github-hook-installation-target-id", id);
        const req = new NextRequest("https://example.test/api/github/webhook", { method: "POST", headers, body });
        const res = await githubWebhookHandler(req, fakeDeps({ appCredentials: three }), neverCalled());
        expect(res.status, String(id)).toBe(401);
        expect(req.body?.locked, String(id)).toBe(false);
        expect(req.bodyUsed, String(id)).toBe(false);
      }
    });
  });

  describe("body-size cap", () => {
    it("rejects an oversized body with 413 via content-length, and never calls handle", async () => {
      const handle = neverCalled();
      const bigBody = "x".repeat(MAX_GITHUB_WEBHOOK_BODY_BYTES + 1);
      const req = requestWithBody(bigBody, {
        signature: sign(bigBody),
        event: "issues",
        delivery: "d1",
        extraHeaders: { "content-length": String(bigBody.length) },
      });
      expect((await githubWebhookHandler(req, fakeDeps(), handle)).status).toBe(413);
      expect(handle).not.toHaveBeenCalled();
    });

    it("rejects an oversized body even without a content-length header (streamed check)", async () => {
      const handle = neverCalled();
      const bigBody = "y".repeat(MAX_GITHUB_WEBHOOK_BODY_BYTES + 1);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(bigBody));
          controller.close();
        },
      });
      const req = new NextRequest("https://example.test/api/github/webhook", {
        method: "POST",
        headers: {
          "x-github-hook-installation-target-id": TEAM_APP_ID,
          "x-hub-signature-256": sign(bigBody),
          "x-github-event": "issues",
          "x-github-delivery": "d1",
        },
        body: stream,
        // `duplex: "half"` is required by undici for a streamed body but is missing from Next's RequestInit type.
        duplex: "half",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see comment above
      } as any);
      expect((await githubWebhookHandler(req, fakeDeps(), handle)).status).toBe(413);
      expect(handle).not.toHaveBeenCalled();
    });
  });
});

// D#2 H17e: the installer record is written only for a VERIFIED installation delivery.
describe("installation deliveries record the installer (H17e)", () => {
  function recordingPool() {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return { rows: [{ installer_gh_user_id: "7001" }], rowCount: 1 };
      }),
      release: vi.fn(),
    };
    return { pool: { connect: async () => client } as never, queries };
  }
  const created = JSON.stringify({ action: "created", installation: { id: 42 }, sender: { id: 7001 } });
  const handle = () => vi.fn(async (): Promise<HandleWebhookResult> => ({ handled: false, reason: "inert_app_kind" }));

  it("a forged installation.created (bad signature) reaches neither the database nor handle", async () => {
    const { pool, queries } = recordingPool();
    const h = neverCalled();
    const req = requestWithBody(created, { signature: sign(created, "wrong-secret"), event: "installation" });
    const res = await githubWebhookHandler(req, fakeDeps({ platformOpsPool: pool }), h);
    expect(res.status).toBe(401);
    expect(queries).toEqual([]);
    expect(h).not.toHaveBeenCalled();
  });

  it("a delivery aimed at an unconfigured App (unknown target id) is refused and records nothing", async () => {
    const { pool, queries } = recordingPool();
    const req = requestWithBody(created, { event: "installation", extraHeaders: { "x-github-hook-installation-target-id": "999" } });
    expect((await githubWebhookHandler(req, fakeDeps({ platformOpsPool: pool }), neverCalled())).status).toBe(401);
    expect(queries).toEqual([]);
  });

  it("a verified installation.created records the installer, then still goes to handle", async () => {
    const { pool, queries } = recordingPool();
    const h = handle();
    const res = await githubWebhookHandler(requestWithBody(created, { event: "installation" }), fakeDeps({ platformOpsPool: pool }), h);
    expect(res.status).toBe(200);
    expect(queries.some((q) => q.includes("INSERT INTO installation_installers"))).toBe(true);
    expect(h).toHaveBeenCalledTimes(1);
  });

  it("other events never touch the installer record", async () => {
    const { pool, queries } = recordingPool();
    await githubWebhookHandler(requestWithBody(created, { event: "issues" }), fakeDeps({ platformOpsPool: pool }), handle());
    expect(queries).toEqual([]);
  });
});

describe("the intake allowlist source (D#31 AUTHOR-CHECK-WIRE)", () => {
  it("is the shared one: no list configured means the deps carry none, a configured list is passed through", () => {
    vi.stubEnv("DATABASE_URL_APP_USER", "postgres://u:p@127.0.0.1:1/none");
    vi.stubEnv("DATABASE_URL_PLATFORM_OPS", "postgres://u:p@127.0.0.1:1/none");
    try {
      expect(defaultGithubWebhookDeps().allowlist).toBeUndefined();
      setIntakeAllowlistForTests(["Alice"]);
      expect(defaultGithubWebhookDeps().allowlist).toEqual(["Alice"]);
    } finally {
      setIntakeAllowlistForTests();
      vi.unstubAllEnvs();
    }
  });
});
