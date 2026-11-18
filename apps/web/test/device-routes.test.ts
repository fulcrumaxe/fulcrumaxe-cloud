import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RateLimitStore } from "@fx/api/src/ratelimit/store.js";
import LinkPage from "../app/link/page";
import { DEVICE_POLL_LIMIT_PER_IP_PER_MINUTE, makePollHandler } from "../app/api/runner/device/poll/handler";
import { DEVICE_START_LIMIT_PER_IP_PER_MINUTE, makeStartHandler } from "../app/api/runner/device/start/handler";

const ORIGIN = "https://runner.example.test";
const LINK_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app", "link");
/** The source with comments removed, so a sentence about a query string is not mistaken for code that reads one. */
const code = (file: string): string => readFileSync(path.join(LINK_DIR, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("/link never fills the code in (phishing resistance)", () => {
  it("renders an empty field whatever the address carries, and shows no code from it anywhere", () => {
    const plain = renderToStaticMarkup(createElement(LinkPage));
    // Next hands a page its query string as a prop; the page takes no props, so it cannot read it. Passing one anyway changes nothing.
    const withQuery = renderToStaticMarkup((LinkPage as (props?: object) => ReturnType<typeof LinkPage>)({ searchParams: { code: "BCDF-GHJK", user_code: "BCDF-GHJK" } }));
    expect(withQuery).toBe(plain);
    expect(plain).toContain('name="code"');
    expect(plain).toMatch(/<input[^>]*name="code"[^>]*value=""/);
    expect(plain).not.toContain("BCDF-GHJK");
    expect(LinkPage.length).toBe(0);
  });

  it("has no way to read a value into the field: no query, address, storage, cookie or default value in either file", () => {
    for (const file of ["page.tsx", "LinkForm.tsx"]) {
      expect(code(file), file).not.toMatch(/searchParams|useSearchParams|URLSearchParams|location\b|localStorage|sessionStorage|document\.cookie|defaultValue|hash\b/);
    }
    // The field's value comes from one place: the person's own typing.
    expect(code("LinkForm.tsx")).toMatch(/useState\(""\)/);
  });

  it("shows the lookup's facts and the fixed warning only after a lookup, and the KVM line says yes or no", () => {
    expect(renderToStaticMarkup(createElement(LinkPage))).not.toMatch(/KVM|Link this machine/);
    const form = code("LinkForm.tsx");
    expect(form).toContain('f.facts.kvm ? "yes" : "no"');
    expect(form).toContain("f.warning");
  });
});

describe("the device routes' edge", () => {
  const KEYS = ["DATABASE_URL_PLATFORM_OPS", "DATABASE_URL_APP_USER", "FX_APP_ORIGIN", "FX_DEVICE_CODE_KEY"] as const;
  const saved = KEYS.map((key) => [key, process.env[key]] as const);
  afterAll(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  beforeAll(() => {
    // Pools connect lazily; none of these requests reaches a query.
    process.env.DATABASE_URL_PLATFORM_OPS = "postgres://unused:unused@127.0.0.1:1/unused";
    process.env.DATABASE_URL_APP_USER = "postgres://unused:unused@127.0.0.1:1/unused";
    process.env.FX_APP_ORIGIN = ORIGIN;
    process.env.FX_DEVICE_CODE_KEY = "k".repeat(32);
  });

  function fakeStore(): RateLimitStore & { keys: string[] } {
    const counts = new Map<string, number>();
    const keys: string[] = [];
    return {
      keys,
      checkAndIncrement: async (key, limit) => {
        keys.push(key);
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return { allowed: n <= limit, retryAfterSeconds: 11 };
      },
    };
  }
  const from = (route: string, ip: string, extra: Record<string, string> = {}) => new NextRequest(`${ORIGIN}/api/runner/device/${route}`, { method: "POST", headers: { "x-real-ip": ip, ...extra }, body: "not json" });

  it.each([
    ["start", makeStartHandler, DEVICE_START_LIMIT_PER_IP_PER_MINUTE, "runner-device-start"],
    ["poll", makePollHandler, DEVICE_POLL_LIMIT_PER_IP_PER_MINUTE, "runner-device-poll"],
  ] as const)("%s: lets an address through to the handler up to its per-minute cap, then 429 with Retry-After; another address has its own", async (route, make, limit, bucket) => {
    const store = fakeStore();
    const handler = make(() => store);
    for (let i = 0; i < limit; i++) expect((await handler(from(route, "203.0.113.7"))).status, `request ${i + 1}`).toBe(400); // the handler ran and refused the body
    const limited = await handler(from(route, "203.0.113.7"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("11");
    expect((await handler(from(route, "203.0.113.8"))).status).toBe(400);
    expect(new Set(store.keys)).toEqual(new Set([`anon:${bucket}:203.0.113.7`, `anon:${bucket}:203.0.113.8`]));
  });

  it("start fails closed when the limiter is down, and reads no session or token: a cookie or a bearer changes nothing", async () => {
    const down: RateLimitStore = { checkAndIncrement: () => Promise.reject(new Error("db down")) };
    expect((await makeStartHandler(() => down)(from("start", "203.0.113.9"))).status).toBe(500);
    const handler = makeStartHandler(() => fakeStore());
    const bare = await handler(from("start", "203.0.113.10"));
    const withCredentials = await handler(from("start", "203.0.113.11", { cookie: "__Host-fx_session=anything", authorization: "Bearer fxat_notarealtoken" }));
    expect([bare.status, withCredentials.status]).toEqual([400, 400]);
    expect(await withCredentials.json()).toEqual(await bare.json());
  });

  it("answers 503 not_configured when the server key is missing, before any database is touched", async () => {
    delete process.env.FX_DEVICE_CODE_KEY;
    try {
      const res = await makeStartHandler(() => fakeStore())(from("start", "203.0.113.12"));
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: { code: "not_configured" } });
    } finally {
      process.env.FX_DEVICE_CODE_KEY = "k".repeat(32);
    }
  });
});
