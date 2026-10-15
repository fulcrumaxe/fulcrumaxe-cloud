import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextResponse } from "next/server";
import { csrfRefusal } from "../lib/csrf";
import { OPS_SESSION_COOKIE, signOpsSession } from "../lib/session";
import { isPublicPath, middleware } from "../middleware";
import { ORIGIN, req, useOpsEnv } from "./support/env";

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app");
const STAFF = "7d6e3f0a-1b2c-4d5e-8f90-a1b2c3d4e5f6";

/** Every page and route handler under app/, as a URL path (dynamic segments filled with a sample). */
function discoverRoutes(dir = APP_DIR, prefix = ""): { path: string; kind: "page" | "route" }[] {
  const out: { path: string; kind: "page" | "route" }[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...discoverRoutes(path.join(dir, e.name), `${prefix}/${e.name.replace(/^\[(.+)\]$/, "sample")}`));
    else if (/^page\.tsx?$/.test(e.name)) out.push({ path: prefix || "/", kind: "page" });
    else if (/^route\.tsx?$/.test(e.name)) out.push({ path: prefix, kind: "route" });
  }
  return out;
}

describe("the staff gate in middleware", () => {
  let restore: () => void;
  let ops: string;
  beforeAll(async () => {
    restore = useOpsEnv();
    ops = await signOpsSession(STAFF);
  });
  afterAll(() => restore());

  // A tenant-style cookie: a well-formed JWT, signed with some other secret, under the tenant cookie name.
  const tenantCookie = { "__Host-fx_session": "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ1IiwiYWNjb3VudElkIjoiYSJ9.c2ln" };

  it("finds the routes this app has (sanity), and every one outside the public list answers 401 or a redirect to /login with only a tenant cookie", async () => {
    const routes = discoverRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(8);
    const gated = routes.filter((r) => !isPublicPath(r.path));
    expect(gated.map((r) => r.path)).toContain("/");
    for (const r of [...gated, { path: "/tenants", kind: "page" as const }, { path: "/api/anything", kind: "route" as const }]) {
      const res = await middleware(req(r.path, { cookies: tenantCookie }));
      if (r.path.startsWith("/api/")) expect(res.status, r.path).toBe(401);
      else {
        expect(res.status, r.path).toBe(307);
        expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
      }
    }
    // The public list is exactly these.
    expect(routes.filter((r) => isPublicPath(r.path)).map((r) => r.path).sort()).toEqual(
      ["/api/auth/enroll/options", "/api/auth/enroll/verify", "/api/auth/login/options", "/api/auth/login/verify", "/api/auth/logout", "/api/health", "/enroll", "/login"],
    );
  });

  it("does not let a path trick reach the public list (dot segments, trailing slash, prefix lookalikes)", async () => {
    for (const p of ["/api/auth/%2e%2e/secret", "/api/auth/../secret", "/loginx", "/login/../", "/api/healthz", "/enrollment"]) {
      const res = await middleware(req(p));
      expect([401, 307], p).toContain(res.status);
    }
    expect(isPublicPath("/login/")).toBe(true);
  });

  it("lets a valid ops session through, and slides the cookie forward", async () => {
    const res = await middleware(req("/", { cookies: { [OPS_SESSION_COOKIE]: ops } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-request-x-fx-staff-id")).toBe(STAFF);
    expect(res.cookies.get(OPS_SESSION_COOKIE)?.value).toBeTruthy();
    expect(res.headers.get("set-cookie")).toMatch(/SameSite=strict/i);
  });

  it("deletes inbound x-fx-staff-* headers before any step, and a spoofed one never replaces the verified id", async () => {
    const spoof = { "x-fx-staff-id": "00000000-0000-4000-8000-000000000000", "X-FX-STAFF-role": "admin" };
    const anon = await middleware(req("/login", { headers: spoof }));
    expect(anon.headers.get("x-middleware-override-headers") ?? "").not.toMatch(/x-fx-staff/);
    expect(anon.headers.get("x-middleware-request-x-fx-staff-id")).toBeNull();
    expect(anon.headers.get("x-middleware-request-x-fx-staff-role")).toBeNull();
    expect((await middleware(req("/", { headers: spoof }))).status).toBe(307);
    const real = await middleware(req("/", { headers: spoof, cookies: { [OPS_SESSION_COOKIE]: ops } }));
    expect(real.headers.get("x-middleware-request-x-fx-staff-id")).toBe(STAFF);
    expect(real.headers.get("x-middleware-request-x-fx-staff-role")).toBeNull();
  });

  it("puts the security headers on every kind of response, with a fresh nonce and no CORS header", async () => {
    const responses: NextResponse[] = [
      await middleware(req("/", { cookies: { [OPS_SESSION_COOKIE]: ops } })), // pass-through
      await middleware(req("/")), // redirect
      await middleware(req("/api/x")), // 401
      await middleware(req("/api/x", { method: "POST", json: {} })), // 403 (no session)
      await middleware(req("/login")),
    ];
    const nonces = new Set<string>();
    for (const res of responses) {
      const csp = res.headers.get("content-security-policy")!;
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      const script = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src"))!;
      expect(script).not.toContain("'unsafe-inline'");
      nonces.add(/'nonce-([^']+)'/.exec(script)![1]!);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect([...res.headers.keys()].filter((k) => k.startsWith("access-control-"))).toEqual([]);
    }
    expect(nonces.size).toBe(responses.length);
    // The request side carries the same CSP for Next to read the nonce from.
    const pass = responses[0]!;
    expect(pass.headers.get("x-middleware-request-content-security-policy")).toBe(pass.headers.get("content-security-policy"));
  });

  it("refuses a cross-origin preflight and strips an Access-Control header if one were ever set", async () => {
    const pre = await middleware(req("/api/anything", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } }));
    expect(pre.status).toBe(403);
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("the CSRF rule (OPS-C2-9)", () => {
  const env = { FX_OPS_ORIGIN: ORIGIN };
  const base = { method: "POST", pathname: "/api/things", origin: ORIGIN, contentType: "application/json", hasSession: true };

  it("lets a mutation through only with the exact Origin, a JSON body and a session", () => {
    expect(csrfRefusal(base, env)).toBeNull();
    expect(csrfRefusal({ ...base, contentType: "application/json; charset=utf-8" }, env)).toBeNull();
    expect(csrfRefusal({ ...base, origin: "https://evil.example" }, env)).toBe("origin_mismatch");
    expect(csrfRefusal({ ...base, origin: `${ORIGIN}/` }, env)).toBe("origin_mismatch");
    expect(csrfRefusal({ ...base, origin: null }, env)).toBe("origin_mismatch");
    expect(csrfRefusal({ ...base, contentType: "text/plain" }, env)).toBe("content_type");
    expect(csrfRefusal({ ...base, contentType: "application/x-www-form-urlencoded" }, env)).toBe("content_type");
    expect(csrfRefusal({ ...base, contentType: null }, env)).toBe("content_type");
    expect(csrfRefusal({ ...base, hasSession: false }, env)).toBe("no_session");
    for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"]) expect(csrfRefusal({ ...base, method, hasSession: false }, env), method).toBe("no_session");
  });

  it("fails closed when FX_OPS_ORIGIN is not set, and leaves reads and pages alone", () => {
    expect(csrfRefusal(base, {})).toBe("origin_unconfigured");
    expect(csrfRefusal({ ...base, method: "GET", origin: null, hasSession: false }, env)).toBeNull();
    expect(csrfRefusal({ ...base, pathname: "/login", method: "POST", origin: null, contentType: null }, env)).toBeNull();
  });

  it("applies Origin and JSON to /api/auth/* too, but needs no session there (a single-use challenge guards them)", () => {
    const auth = { ...base, pathname: "/api/auth/login/verify", hasSession: false };
    expect(csrfRefusal(auth, env)).toBeNull();
    expect(csrfRefusal({ ...auth, origin: "https://evil.example" }, env)).toBe("origin_mismatch");
    expect(csrfRefusal({ ...auth, contentType: "text/plain" }, env)).toBe("content_type");
  });

  it("answers 403 from middleware for a refused mutation, with no CORS header", async () => {
    const restore = useOpsEnv();
    try {
      const wrongOrigin = await middleware(req("/api/auth/login/options", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" } }));
      expect(wrongOrigin.status).toBe(403);
      const formPost = await middleware(req("/api/auth/login/options", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" } }));
      expect(formPost.status).toBe(403);
      const ok = await middleware(req("/api/auth/login/options", { json: {} }));
      expect(ok.status).toBe(200);
    } finally {
      restore();
    }
  });
});
