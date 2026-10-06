import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GH_PROXY_METHODS, gateRequest, type GateRequest } from "../gate";
import { middleware } from "../middleware";

const HOST = "gh-proxy.fixture.test";

function gateReq(overrides: Partial<GateRequest> = {}): GateRequest {
  return {
    method: "GET",
    url: `https://${HOST}/api/gh-proxy/repos/acme/widgets/issues/5`,
    host: HOST,
    xForwardedHost: null,
    ...overrides,
  };
}

describe("gate: the one request shape that passes", () => {
  it("allows the configured host, the /api/gh-proxy/ prefix and each of the six methods", () => {
    expect(GH_PROXY_METHODS).toEqual(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
    for (const method of GH_PROXY_METHODS) {
      expect(gateRequest(gateReq({ method }), HOST)).toEqual({ allow: true });
    }
  });

  it("allows git smart-HTTP paths, a query string and a trailing slash", () => {
    for (const path of ["/api/gh-proxy/acme/widgets.git/info/refs?service=git-upload-pack", "/api/gh-proxy/acme/widgets.git/", "/api/gh-proxy/a%20b/c"]) {
      expect(gateRequest(gateReq({ url: `https://${HOST}${path}` }), HOST)).toEqual({ allow: true });
    }
  });

  it("allows an X-Forwarded-Host that agrees with the host", () => {
    expect(gateRequest(gateReq({ xForwardedHost: HOST }), HOST)).toEqual({ allow: true });
  });
});

describe("gate: host", () => {
  it.each([
    ["another host", "attacker.example"],
    ["a deployment URL", "gh-proxy-abc123-acme.vercel.app"],
    ["upper case", HOST.toUpperCase()],
    ["a trailing dot", `${HOST}.`],
    ["a port", `${HOST}:443`],
    ["a longer host", `x.${HOST}`],
    ["empty", ""],
  ])("refuses %s", (_label, host) => {
    expect(gateRequest(gateReq({ host }), HOST)).toMatchObject({ allow: false, status: 404 });
  });

  it("refuses a missing Host and a disagreeing X-Forwarded-Host", () => {
    expect(gateRequest(gateReq({ host: null }), HOST)).toMatchObject({ allow: false, status: 404 });
    expect(gateRequest(gateReq({ xForwardedHost: "attacker.example" }), HOST)).toMatchObject({ allow: false, status: 404 });
  });

  it("refuses everything when FX_GH_PROXY_PUBLIC_HOST is unset or empty (fail closed)", () => {
    expect(gateRequest(gateReq(), undefined)).toMatchObject({ allow: false, status: 404, reason: "public_host_unset" });
    expect(gateRequest(gateReq({ host: "" }), "")).toMatchObject({ allow: false, status: 404 });
  });
});

describe("gate: path", () => {
  it.each([
    "/",
    "/api",
    "/api/gh-proxy",
    "/api/gh-proxy/",
    "/api/health",
    "/api/GH-PROXY/repos/a/b",
    "/API/gh-proxy/repos/a/b",
    "/api/gh-proxyx/repos/a/b",
    "/x/api/gh-proxy/repos/a/b",
    "/_next/static/chunk.js",
    "/api/gh-proxy/../health",
    "/api/gh-proxy/a/../../health",
    "/api/gh-proxy/./a",
    "/api/gh-proxy/a//b",
    "/api/gh-proxy/%2e%2e/health",
    "/api/gh-proxy/%2E%2E/health",
    "/api/gh-proxy/a%2fb",
    "/api/gh-proxy/a%5Cb",
    "/api/gh-proxy/a\\b",
    "/api/gh-proxy/a%00b",
  ])("refuses %s", (path) => {
    expect(gateRequest(gateReq({ url: `https://${HOST}${path}` }), HOST)).toMatchObject({ allow: false, status: 404 });
  });

  it("refuses a URL that is not absolute", () => {
    expect(gateRequest(gateReq({ url: "/api/gh-proxy/repos/a/b" }), HOST)).toMatchObject({ allow: false, status: 404 });
  });
});

describe("gate: method", () => {
  it.each(["OPTIONS", "TRACE", "CONNECT", "PROPFIND", "get", "Get", ""])("refuses %j", (method) => {
    expect(gateRequest(gateReq({ method }), HOST)).toMatchObject({ allow: false, status: 404 });
  });
});

describe("middleware: refusals are bare 404s, never redirects or rewrites", () => {
  const saved = process.env.FX_GH_PROXY_PUBLIC_HOST;
  afterEach(() => {
    if (saved === undefined) delete process.env.FX_GH_PROXY_PUBLIC_HOST;
    else process.env.FX_GH_PROXY_PUBLIC_HOST = saved;
    vi.restoreAllMocks();
  });

  function run(url: string, init: { method?: string; host?: string | null; xfh?: string } = {}) {
    process.env.FX_GH_PROXY_PUBLIC_HOST = HOST;
    const headers = new Headers();
    if (init.host !== null) headers.set("host", init.host ?? HOST);
    if (init.xfh) headers.set("x-forwarded-host", init.xfh);
    return middleware(new NextRequest(url, { method: init.method ?? "GET", headers }));
  }

  it("lets a good request through untouched (next(), no rewrite, no redirect, no location)", () => {
    const res = run(`https://${HOST}/api/gh-proxy/repos/acme/widgets/issues/5`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(res.headers.get("location")).toBeNull();
  });

  it("does not redirect a trailing-slash path or a path without one", () => {
    for (const path of ["/api/gh-proxy/acme/widgets.git/", "/api/gh-proxy/acme/widgets.git"]) {
      const res = run(`https://${HOST}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it.each([
    ["/", {}],
    ["/api/health", {}],
    ["/api/gh-proxy", {}],
    ["/api/gh-proxy/repos/a/b", { host: "attacker.example" }],
    ["/api/gh-proxy/repos/a/b", { method: "OPTIONS" }],
    ["/api/gh-proxy/repos/a/b", { xfh: "attacker.example" }],
    ["/api/gh-proxy/%2e%2e/health", {}], // NextRequest resolves the dots first, so this is a prefix failure
  ])("answers %s %j with an empty 404", async (path, init) => {
    const res = run(`https://${HOST}${path}`, init);
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(res.headers.get("x-middleware-next")).toBeNull();
    expect(await res.text()).toBe("");
  });

  it("answers an empty 404, not a throw, when reading the request fails", async () => {
    process.env.FX_GH_PROXY_PUBLIC_HOST = HOST;
    const broken = { method: "GET", url: `https://${HOST}/api/gh-proxy/a`, headers: { get: () => { throw new Error("boom"); } } };
    const res = middleware(broken as unknown as NextRequest);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });

  it("answers 404 and logs when FX_GH_PROXY_PUBLIC_HOST is unset", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.FX_GH_PROXY_PUBLIC_HOST;
    const res = middleware(new NextRequest(`https://${HOST}/api/gh-proxy/repos/a/b`, { headers: { host: HOST } }));
    expect(res.status).toBe(404);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
