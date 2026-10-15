// apps/web/test/branding-partner.test.ts
//
// D#4 P02a: the partner branding path. `GET /api/branding` stays the static, byte-identical route (apps/web/test/branding.test.ts
// pins its body); `GET /api/branding/partner` is dynamic and answers per Host. These tests drive the route handler with a fake
// resolver (the real database functions are exercised in packages/partners/test/pg/live.test.ts and packages/db/test/resolve-host.test.ts).

import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { PartnerOverride } from "@fx/design";
import { PartnerBrandingEnvelope, STATIC_BRAND } from "@fx/partners/context";
import { UNKNOWN_HOST, type HostResolver, type ResolvedHost } from "@fx/partners/host";
import * as staticRoute from "../app/api/branding/route";
import * as partnerRoute from "../app/api/branding/partner/route";
import { partnerBrandingResponse } from "../app/api/branding/partner/handler";

const OUR_HOST = "cloud.fulcrumaxe.example";
const ENV_ON = { FX_PARTNER_LAYER: "on", FX_APP_ORIGIN: `https://${OUR_HOST}` };
const PARTNER_ID = "44444444-4444-4444-8444-444444444444";

function active(patch: Partial<ResolvedHost> = {}): ResolvedHost {
  return {
    partnerId: PARTNER_ID,
    productName: "Acme Build",
    logoUrl: "k/logo.png",
    colorPrimary: "#112233",
    colorAccent: "#445566",
    supportEmail: "help@acme.example",
    termsUrl: "https://acme.example/terms",
    privacyUrl: "https://acme.example/privacy",
    state: "active",
    ...patch,
  };
}

function resolverFor(answers: Record<string, ResolvedHost>): HostResolver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async resolve(host) {
      calls.push(host);
      return answers[host] ?? UNKNOWN_HOST;
    },
  };
}

async function call(host: string | null, env: Record<string, string | undefined>, resolver: HostResolver) {
  const res = await partnerBrandingResponse(host, env, resolver);
  const text = await res.text();
  const headers = Object.fromEntries([...res.headers.entries()].filter(([k]) => k !== "date"));
  return { status: res.status, text, headers };
}

describe("D#4 P02a criterion 1: our own host and the static route", () => {
  it("GET /api/branding still exports force-static, and the partner path is dynamic", () => {
    expect(staticRoute.dynamic).toBe("force-static");
    expect(partnerRoute.dynamic).toBe("force-dynamic");
  });

  it("the static route reads no request: GET takes no argument, so it cannot depend on a host or a header", () => {
    expect(staticRoute.GET.length).toBe(0);
  });

  it("on the FX_APP_ORIGIN host the partner path sends the same bytes as the static route, without asking the resolver", async () => {
    const resolver = resolverFor({ [OUR_HOST]: active() });
    const ours = await call(OUR_HOST, ENV_ON, resolver);
    expect(ours.text).toBe(JSON.stringify(await staticRoute.GET().json()));
    expect(ours.status).toBe(200);
    expect(resolver.calls).toEqual([]);
  });
});

describe("D#4 P02a criterion 2: an approved partner host", () => {
  it("returns a payload that validates against PartnerOverride and the fixed envelope, with private, no-store", async () => {
    const resolver = resolverFor({ "build.acme.example": active() });
    const res = await call("Build.Acme.example.:443", ENV_ON, resolver);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.headers["vary"]).toBe("Host");
    const body = JSON.parse(res.text) as Record<string, unknown>;
    expect(() => PartnerBrandingEnvelope.parse(body)).not.toThrow();
    expect(() => PartnerOverride.parse(body.colors)).not.toThrow();
    expect(Object.keys(body)).toEqual([
      "page_title",
      "product_name",
      "os_name",
      "system_tag",
      "copyright",
      "welcome_message",
      "logo_url",
      "support_email",
      "terms_url",
      "privacy_url",
      "state",
      "colors",
    ]);
    expect(body).toMatchObject({ product_name: "Acme Build", logo_url: null, state: "active", colors: { accent: "#112233", accentFaint: "#445566" } });
    expect(resolver.calls).toEqual(["build.acme.example"]);
  });
});

describe("D#4 P02a criterion 3: every other host looks the same", () => {
  const STATIC_TEXT = JSON.stringify(STATIC_BRAND);

  const cases: [string, Record<string, ResolvedHost>, string | null][] = [
    ["an unknown host", {}, "nobody.example.com"],
    ["an unverified, unattached or detached host (the database answers unknown)", { "gone.example.com": UNKNOWN_HOST }, "gone.example.com"],
    ["a pending partner (unknown)", { "pending.example.com": UNKNOWN_HOST }, "pending.example.com"],
    ["unapproved branding (unknown)", { "draft.example.com": UNKNOWN_HOST }, "draft.example.com"],
    ["an active row with no terms_url", { "noterms.example.com": active({ termsUrl: null }) }, "noterms.example.com"],
    ["an active row with no privacy_url", { "nopriv.example.com": active({ privacyUrl: null }) }, "nopriv.example.com"],
    ["no Host header at all", {}, null],
    ["a Host that is not a hostname", {}, "ours@evil.example"],
  ];

  it.each(cases)("%s: status 200, the static brand's exact bytes, and the same headers as our own host", async (_name, answers, host) => {
    const ours = await call(OUR_HOST, ENV_ON, resolverFor({}));
    const res = await call(host, ENV_ON, resolverFor(answers));
    expect(res.status).toBe(200);
    expect(res.text).toBe(STATIC_TEXT);
    expect(res.headers).toEqual(ours.headers);
  });

  it("a suspended partner's host is told state suspended, in our brand, with the same headers", async () => {
    const ours = await call(OUR_HOST, ENV_ON, resolverFor({}));
    const res = await call("susp.example.com", ENV_ON, resolverFor({ "susp.example.com": { ...UNKNOWN_HOST, partnerId: PARTNER_ID, state: "suspended" } }));
    expect(res.status).toBe(200);
    expect(res.headers).toEqual(ours.headers);
    expect(JSON.parse(res.text)).toMatchObject({ state: "suspended", product_name: STATIC_BRAND.product_name, colors: {}, terms_url: null });
  });
});

describe("D#4 P02a criterion 4: only the Host header names the host", () => {
  it("ignores X-Forwarded-Host and Forwarded: the route reads the Host header and nothing else", async () => {
    // The handler takes the Host value as its only host input; the route passes req.headers.get("host") alone.
    const source = readFileSync(path.join(__dirname, "..", "app", "api", "branding", "partner", "route.ts"), "utf8");
    expect(source).toContain('req.headers.get("host")');
    expect(source).not.toMatch(/forwarded/i);
    const handler = readFileSync(path.join(__dirname, "..", "app", "api", "branding", "partner", "handler.ts"), "utf8");
    expect(handler).not.toMatch(/forwarded/i);
  });

  it("with a conflicting X-Forwarded-Host and Forwarded the answer follows the Host header", async () => {
    const resolver = resolverFor({ "real.acme.example": active(), "victim.example": active({ productName: "Victim" }) });
    const req = new NextRequest("https://real.acme.example/api/branding/partner", {
      headers: { host: "real.acme.example", "x-forwarded-host": "victim.example", forwarded: "host=victim.example" },
    });
    const res = await partnerBrandingResponse(req.headers.get("host"), ENV_ON, resolver);
    expect(((await res.json()) as { product_name: string }).product_name).toBe("Acme Build");
    expect(resolver.calls).toEqual(["real.acme.example"]);
  });

  it("the real route function is wired to the Host header: with the layer off it answers the static brand without touching the database", async () => {
    const saved = process.env.FX_PARTNER_LAYER;
    delete process.env.FX_PARTNER_LAYER;
    try {
      const req = new NextRequest("https://real.acme.example/api/branding/partner", {
        headers: { host: "real.acme.example", "x-forwarded-host": "victim.example" },
      });
      const res = await partnerRoute.GET(req);
      expect(await res.text()).toBe(JSON.stringify(STATIC_BRAND));
    } finally {
      if (saved !== undefined) process.env.FX_PARTNER_LAYER = saved;
    }
  });
});

describe("D#4 P02a criterion 5: FX_PARTNER_LAYER unset or off", () => {
  it.each([undefined, "off", "", "ON", "1", "true"])("FX_PARTNER_LAYER=%s: the resolver is called 0 times and every host gets our static brand", async (value) => {
    const resolver = resolverFor({ "build.acme.example": active() });
    const res = await call("build.acme.example", { ...ENV_ON, FX_PARTNER_LAYER: value }, resolver);
    expect(resolver.calls).toEqual([]);
    expect(res.text).toBe(JSON.stringify(STATIC_BRAND));
    expect(res.status).toBe(200);
  });
});

describe("a failed lookup is an outage, not a brand", () => {
  it("answers 503 with the same no-store headers, and does not show our name to a partner's customers", async () => {
    const failing: HostResolver = {
      async resolve() {
        throw new Error("db down");
      },
    };
    const ours = await call(OUR_HOST, ENV_ON, resolverFor({}));
    const res = await call("build.acme.example", ENV_ON, failing);
    expect(res.status).toBe(503);
    expect(res.headers["cache-control"]).toBe(ours.headers["cache-control"]);
    expect(res.headers["vary"]).toBe(ours.headers["vary"]);
    expect(res.text).not.toMatch(/fulcrumaxe/i);
    expect(res.text).not.toContain("db down");
  });
});
