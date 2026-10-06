import { randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bypassRouteHandler, type RouteLike } from "../fixtures/bypass.js";
import {
  BYPASS_HEADER,
  bypassHeadersFor,
  ClientError,
  createClient,
  isDeploymentWall,
  isTargetOrigin,
  MAX_REDIRECTS,
  SET_COOKIE_HEADER,
} from "../src/client.js";

// A run-time secret: nothing here is a real value and nothing is committed.
const SECRET = `t1b${randomBytes(12).toString("hex")}`;

interface Seen {
  path: string;
  headers: IncomingHttpHeaders;
}

function listen(handler: (path: string, send: (status: number, location?: string, cookie?: string) => void) => void, seen: Seen[]): Promise<Server> {
  const server = createServer((req, res) => {
    seen.push({ path: req.url ?? "", headers: req.headers });
    handler(req.url ?? "", (status, location, cookie) => {
      res.writeHead(status, { ...(location === undefined ? {} : { location }), ...(cookie === undefined ? {} : { "set-cookie": cookie }) });
      res.end(status === 200 ? "ok" : "");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const originOf = (s: Server): string => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

describe("exact-origin bypass against local servers", () => {
  const seenA: Seen[] = [];
  const seenB: Seen[] = [];
  let a: Server;
  let b: Server;

  beforeAll(async () => {
    // B is "the second origin": the same host on another port.
    b = await listen((_p, send) => send(200), seenB);
    a = await listen((path, send) => {
      if (path === "/plain") send(200);
      else if (path === "/to-b") send(302, `${originOf(b)}/landed`);
      else if (path === "/to-self") send(302, "/plain");
      else if (path === "/loop") send(302, "/loop");
      else send(404);
    }, seenA);
  });
  afterAll(() => {
    a.close();
    b.close();
  });

  it("a request to the target origin carries the header", async () => {
    seenA.length = 0;
    const client = createClient({ origin: originOf(a), bypassSecret: SECRET });
    const res = await client.get("/plain");
    expect(res.status).toBe(200);
    expect(seenA[0]?.headers[BYPASS_HEADER]).toBe(SECRET);
    expect(res.hops).toEqual([{ url: `${originOf(a)}/plain`, status: 200, bypass: true }]);
  });

  it("a same-origin redirect keeps the header", async () => {
    seenA.length = 0;
    const res = await createClient({ origin: originOf(a), bypassSecret: SECRET }).get("/to-self");
    expect(res.status).toBe(200);
    expect(seenA.map((s) => s.headers[BYPASS_HEADER])).toEqual([SECRET, SECRET]);
  });

  it("a target response that 302s to the same host on another port yields a follow-up WITHOUT the header", async () => {
    seenA.length = 0;
    seenB.length = 0;
    const client = createClient({ origin: originOf(a), bypassSecret: SECRET });
    const res = await client.get("/to-b", { headers: { authorization: "Bearer x", cookie: "k=v" } });
    expect(res.status).toBe(200);
    expect(seenA[0]?.headers[BYPASS_HEADER]).toBe(SECRET);
    expect(seenB).toHaveLength(1);
    expect(seenB[0]?.headers[BYPASS_HEADER]).toBeUndefined();
    // Credentials the caller supplied do not follow either.
    expect(seenB[0]?.headers.authorization).toBeUndefined();
    expect(seenB[0]?.headers.cookie).toBeUndefined();
    expect(res.hops.map((h) => h.bypass)).toEqual([true, false]);
  });

  it("redirect: manual returns the 3xx and sends nothing further", async () => {
    seenB.length = 0;
    const res = await createClient({ origin: originOf(a), bypassSecret: SECRET }).get("/to-b", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${originOf(b)}/landed`);
    expect(seenB).toHaveLength(0);
  });

  it("a redirect loop stops after MAX_REDIRECTS", async () => {
    await expect(createClient({ origin: originOf(a), bypassSecret: SECRET }).get("/loop")).rejects.toThrow(`more than ${MAX_REDIRECTS} redirects`);
  });
});

describe("the origin rule, case by case", () => {
  const ORIGIN = "https://app.example.test";

  it("matches scheme, host and port exactly", () => {
    expect(isTargetOrigin(`${ORIGIN}/x?y=1`, ORIGIN)).toBe(true);
    expect(isTargetOrigin("https://app.example.test:443/x", ORIGIN)).toBe(true);
    for (const other of [
      "https://app.example.test.evil.test/x",
      "https://evilapp.example.test/x",
      "https://app.example.test:8443/x",
      "http://app.example.test/x",
      "https://app.example.test@evil.test/x",
      "not a url",
    ]) {
      expect(isTargetOrigin(other, ORIGIN), other).toBe(false);
      expect(bypassHeadersFor(other, ORIGIN, SECRET), other).toEqual({});
    }
  });

  it("gives no header without a secret", () => {
    expect(bypassHeadersFor(`${ORIGIN}/x`, ORIGIN, undefined)).toEqual({});
    expect(bypassHeadersFor(`${ORIGIN}/x`, ORIGIN, "")).toEqual({});
  });

  it("a redirect to <target host>.evil.test gets no header, and a caller-supplied one is dropped there", async () => {
    const sent: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (url: string, init: { headers: Record<string, string> }) => {
      sent.push({ url, headers: init.headers });
      return sent.length === 1
        ? new Response(null, { status: 302, headers: { location: "https://app.example.test.evil.test/x" } })
        : new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const client = createClient({ origin: ORIGIN, bypassSecret: SECRET, fetchImpl });
    await client.get("/start", { headers: { [BYPASS_HEADER]: "caller-value", "x-keep": "1" } });
    expect(sent[0]?.headers[BYPASS_HEADER]).toBe(SECRET);
    expect(sent[1]?.url).toBe("https://app.example.test.evil.test/x");
    expect(sent[1]?.headers[BYPASS_HEADER]).toBeUndefined();
    expect(sent[1]?.headers["x-keep"]).toBe("1");
  });

  it("an anonymous client never sends the header", async () => {
    const sent: Array<Record<string, string>> = [];
    const fetchImpl = (async (_u: string, init: { headers: Record<string, string> }) => {
      sent.push(init.headers);
      return new Response("ok");
    }) as unknown as typeof fetch;
    await createClient({ origin: ORIGIN, fetchImpl }).get("/", { headers: { [BYPASS_HEADER]: "caller-value" } });
    expect(sent[0]?.[BYPASS_HEADER]).toBeUndefined();
  });

  it("refuses a path that is not on the target, and any write", async () => {
    const client = createClient({ origin: ORIGIN, bypassSecret: SECRET, fetchImpl: (() => Promise.reject(new Error("must not be called"))) as typeof fetch });
    for (const path of ["//evil.test/x", "https://evil.test/x", "x", "/\\evil.test"]) {
      await expect(client.get(path), path).rejects.toThrow(ClientError);
    }
    await expect(client.request("/x", { method: "POST" })).rejects.toThrow("reads only");
  });
});

describe("browser route handler (stand-in route)", () => {
  function fakeRoute(url: string) {
    const fetched: Array<{ headers: Record<string, string>; maxRedirects: number }> = [];
    const fulfilled: unknown[] = [];
    let continued = 0;
    let continuedWith: unknown;
    const route: RouteLike<string> = {
      request: () => ({ url: () => url, headers: () => ({ accept: "*/*" }) }),
      continue: async (o) => {
        continued += 1;
        continuedWith = o;
      },
      fetch: async (o) => {
        fetched.push(o);
        return "response";
      },
      fulfill: async (o) => {
        fulfilled.push(o.response);
      },
    };
    return { route, fetched, fulfilled, continues: () => ({ continued, continuedWith }) };
  }

  it("fetches the target origin with the header and no redirects, then fulfils; never continues with headers", async () => {
    const handler = bypassRouteHandler<string>("https://app.example.test", SECRET);
    const on = fakeRoute("https://app.example.test/api/health");
    await handler(on.route);
    expect(on.fetched).toEqual([{ headers: { accept: "*/*", [BYPASS_HEADER]: SECRET, [SET_COOKIE_HEADER]: "true" }, maxRedirects: 0 }]);
    expect(on.fulfilled).toEqual(["response"]);
    expect(on.continues().continued).toBe(0);
  });

  it("continues everything else untouched", async () => {
    const handler = bypassRouteHandler<string>("https://app.example.test", SECRET);
    for (const url of ["https://github.com/login", "https://app.example.test.evil.test/", "https://app.example.test:8443/"]) {
      const off = fakeRoute(url);
      await handler(off.route);
      expect(off.fetched, url).toEqual([]);
      expect(off.continues(), url).toEqual({ continued: 1, continuedWith: undefined });
    }
  });

  it("does nothing special without a secret", async () => {
    const r = fakeRoute("https://app.example.test/");
    await bypassRouteHandler<string>("https://app.example.test", undefined)(r.route);
    expect(r.fetched).toEqual([]);
    expect(r.continues().continued).toBe(1);
  });
});

describe("browser route handler in real Chromium, two local origins", () => {
  const seenA: Seen[] = [];
  const seenB: Seen[] = [];
  let a: Server;
  let b: Server;
  let browser: Browser;

  beforeAll(async () => {
    b = await listen((_p, send) => send(200), seenB);
    a = await listen((path, send) => {
      if (path === "/to-b") send(302, `${originOf(b)}/landed`);
      // What Vercel does for `x-vercel-set-bypass-cookie`: answer the first request with a cookie that stands in
      // for the header on later requests to the same deployment.
      else if (path === "/to-self") send(302, "/plain", "bypass=1; Path=/");
      else if (path === "/plain") send(200);
      else send(404);
    }, seenA);
    browser = await chromium.launch();
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    a.close();
    b.close();
  });

  async function visit(path: string): Promise<void> {
    const context = await browser.newContext();
    try {
      await context.route("**/*", bypassRouteHandler(originOf(a), SECRET));
      const page = await context.newPage();
      await page.goto(`${originOf(a)}${path}`);
    } finally {
      await context.close();
    }
  }

  it("a navigation that 302s from the target to another origin reaches it WITHOUT the header", async () => {
    seenA.length = 0;
    seenB.length = 0;
    await visit("/to-b");
    expect(seenA[0]?.headers[BYPASS_HEADER]).toBe(SECRET);
    expect(seenB).toHaveLength(1);
    expect(seenB[0]?.headers[BYPASS_HEADER]).toBeUndefined();
  }, 60_000);

  it("a same-origin redirect hop is not routed, so it travels on the bypass cookie the first answer set, not on the header", async () => {
    seenA.length = 0;
    await visit("/to-self");
    expect(seenA.map((s) => s.headers[BYPASS_HEADER])).toEqual([SECRET, undefined]);
    expect(seenA[0]?.headers[SET_COOKIE_HEADER]).toBe("true");
    expect(seenA[1]?.headers.cookie).toContain("bypass=1");
  }, 60_000);
});

describe("isDeploymentWall", () => {
  const res = (status: number, location?: string) => ({ status, headers: new Headers(location ? { location } : {}) });
  it("recognises a 401 and a redirect to vercel.com, nothing else", () => {
    expect(isDeploymentWall(res(401))).toBe(true);
    expect(isDeploymentWall(res(307, "https://vercel.com/sso-api?url=x"))).toBe(true);
    expect(isDeploymentWall(res(302, "https://sub.vercel.com/x"))).toBe(true);
    expect(isDeploymentWall(res(200))).toBe(false);
    expect(isDeploymentWall(res(404))).toBe(false);
    expect(isDeploymentWall(res(302, "https://vercel.com.evil.test/x"))).toBe(false);
    expect(isDeploymentWall(res(302, "/relative"))).toBe(false);
    expect(isDeploymentWall(res(302))).toBe(false);
  });
});
