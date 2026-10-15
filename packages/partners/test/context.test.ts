import { describe, expect, it } from "vitest";
import { PartnerOverride } from "@fx/design";
import {
  BRANDING_RESPONSE_HEADERS,
  ENVELOPE_KEYS,
  PartnerBrandingEnvelope,
  STATIC_BRAND,
  brandingBodyFor,
  resolvePartnerContext,
  suspendedEnvelope,
} from "../src/context/index.js";
import { UNKNOWN_HOST, type HostResolver, type ResolvedHost } from "../src/host/index.js";

const PARTNER_ID = "22222222-2222-4222-8222-222222222222";
const ENV_ON = { FX_PARTNER_LAYER: "on", FX_APP_ORIGIN: "https://cloud.fulcrumaxe.example" };

function row(overrides: Partial<ResolvedHost> = {}): ResolvedHost {
  return {
    partnerId: PARTNER_ID,
    productName: "Acme Build",
    logoUrl: "partners/acme/logo.png",
    colorPrimary: "#112233",
    colorAccent: "#445566",
    supportEmail: "help@acme.example",
    termsUrl: "https://acme.example/terms",
    privacyUrl: "https://acme.example/privacy",
    state: "active",
    ...overrides,
  };
}

function spy(answer: ResolvedHost | (() => ResolvedHost)): HostResolver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async resolve(host) {
      calls.push(host);
      return typeof answer === "function" ? answer() : answer;
    },
  };
}

describe("resolvePartnerContext", () => {
  it("returns a partner context with the fixed envelope for an active partner host", async () => {
    const resolver = spy(row());
    const ctx = await resolvePartnerContext({ hostHeader: "Build.Acme.example.:443", env: ENV_ON, resolver });
    expect(resolver.calls).toEqual(["build.acme.example"]);
    expect(ctx.kind).toBe("partner");
    const body = brandingBodyFor(ctx);
    expect(Object.keys(body)).toEqual([...ENVELOPE_KEYS]);
    expect(body).toEqual({
      page_title: "Acme Build",
      product_name: "Acme Build",
      os_name: "Acme Build",
      system_tag: "Acme Build",
      copyright: "© Acme Build",
      welcome_message: "Welcome to Acme Build.",
      logo_url: null,
      support_email: "help@acme.example",
      terms_url: "https://acme.example/terms",
      privacy_url: "https://acme.example/privacy",
      state: "active",
      colors: { accent: "#112233", accentFaint: "#445566" },
    });
  });

  it("emits logo_url null whatever key is stored (no URL is invented before logo serving exists)", async () => {
    const ctx = await resolvePartnerContext({ hostHeader: "a.example.com", env: ENV_ON, resolver: spy(row({ logoUrl: "k/logo.png" })) });
    expect((brandingBodyFor(ctx) as PartnerBrandingEnvelope).logo_url).toBeNull();
  });

  it("the payload validates against PartnerOverride for its colours and against the strict envelope as a whole", async () => {
    const ctx = await resolvePartnerContext({ hostHeader: "a.example.com", env: ENV_ON, resolver: spy(row()) });
    const body = brandingBodyFor(ctx) as PartnerBrandingEnvelope;
    expect(() => PartnerOverride.parse(body.colors)).not.toThrow();
    expect(() => PartnerBrandingEnvelope.parse(body)).not.toThrow();
    expect(() => PartnerBrandingEnvelope.parse({ ...body, extra: 1 })).toThrow();
    expect(() => PartnerBrandingEnvelope.parse({ ...body, colors: { danger: "#fff" } })).toThrow();
  });

  it("drops a colour that is not a hex colour, and a support email that is not an address", async () => {
    const resolver = spy(row({ colorPrimary: "red; background:url(//evil)", colorAccent: "#abc", supportEmail: "not an email" }));
    const ctx = await resolvePartnerContext({ hostHeader: "a.example.com", env: ENV_ON, resolver });
    const body = brandingBodyFor(ctx) as PartnerBrandingEnvelope;
    expect(body.colors).toEqual({ accentFaint: "#abc" });
    expect(body.support_email).toBeNull();
  });

  it.each([
    ["javascript: terms", { termsUrl: "javascript:alert(1)" }],
    ["http privacy", { privacyUrl: "http://acme.example/privacy" }],
    ["userinfo in terms", { termsUrl: "https://user:pw@acme.example/terms" }],
    ["a missing terms_url", { termsUrl: null }],
    ["a missing privacy_url", { privacyUrl: null }],
    ["a missing product name", { productName: null }],
    ["a blank product name", { productName: "   " }],
  ])("falls back to our static brand when an active row has %s", async (_name, patch) => {
    const ctx = await resolvePartnerContext({ hostHeader: "a.example.com", env: ENV_ON, resolver: spy(row(patch)) });
    expect(ctx.kind).toBe("direct");
    expect(brandingBodyFor(ctx)).toEqual(STATIC_BRAND);
  });

  it("an unknown host gets our static brand", async () => {
    const ctx = await resolvePartnerContext({ hostHeader: "nobody.example.com", env: ENV_ON, resolver: spy(UNKNOWN_HOST) });
    expect(ctx.kind).toBe("direct");
    expect(JSON.stringify(brandingBodyFor(ctx))).toBe(JSON.stringify(STATIC_BRAND));
  });

  it("a suspended partner's host is told state suspended, with our brand and none of the partner's text or colours", async () => {
    const resolver = spy({ ...UNKNOWN_HOST, partnerId: PARTNER_ID, state: "suspended" });
    const ctx = await resolvePartnerContext({ hostHeader: "a.example.com", env: ENV_ON, resolver });
    expect(ctx).toEqual({ kind: "suspended", partnerId: PARTNER_ID, host: "a.example.com" });
    const body = brandingBodyFor(ctx);
    expect(body).toEqual(suspendedEnvelope());
    expect(body).toMatchObject({ state: "suspended", product_name: STATIC_BRAND.product_name, colors: {}, terms_url: null });
  });

  it("calls the resolver 0 times when the layer is unset, off, or anything but on, and answers our static brand", async () => {
    for (const value of [undefined, "off", "", "ON", "1", "true", "on "]) {
      const resolver = spy(row());
      const ctx = await resolvePartnerContext({ hostHeader: "a.example.com", env: { ...ENV_ON, FX_PARTNER_LAYER: value }, resolver });
      expect(resolver.calls, String(value)).toEqual([]);
      expect(brandingBodyFor(ctx), String(value)).toEqual(STATIC_BRAND);
    }
  });

  it("does not call the resolver for our own host or for a Host that is not a hostname", async () => {
    const resolver = spy(row());
    for (const host of ["cloud.fulcrumaxe.example", "CLOUD.fulcrumaxe.example:443", null, "", "a.example.com, b.example.com", "[::1]"]) {
      const ctx = await resolvePartnerContext({ hostHeader: host, env: ENV_ON, resolver });
      expect(ctx.kind, String(host)).toBe("direct");
    }
    expect(resolver.calls).toEqual([]);
  });

  it("lets a resolver failure propagate instead of turning it into a brand", async () => {
    const resolver: HostResolver = {
      async resolve() {
        throw new Error("db down");
      },
    };
    await expect(resolvePartnerContext({ hostHeader: "a.example.com", env: ENV_ON, resolver })).rejects.toThrow("db down");
  });

  it("states the cache headers every answer carries", () => {
    expect(BRANDING_RESPONSE_HEADERS).toEqual({ "Cache-Control": "private, no-store", Vary: "Host" });
  });
});

describe("the strict envelope", () => {
  it("pins the exact key set", () => {
    expect([...ENVELOPE_KEYS].sort()).toEqual(
      [
        "colors",
        "copyright",
        "logo_url",
        "os_name",
        "page_title",
        "privacy_url",
        "product_name",
        "state",
        "support_email",
        "system_tag",
        "terms_url",
        "welcome_message",
      ].sort(),
    );
    expect(Object.keys(PartnerBrandingEnvelope.shape).sort()).toEqual([...ENVELOPE_KEYS].sort());
  });
});
