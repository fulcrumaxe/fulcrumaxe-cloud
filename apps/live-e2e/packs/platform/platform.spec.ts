// platform pack, rows P1-P5, P7-P10 and P13: the shell index, its immutable assets, the static contract routes,
// the edge's refusals and the site-kit skeleton. Runs on every device project; the browser boot is the part that
// differs per device. Everything here reaches the app through the fixtures and the shared client only
// (test/pack-lint.test.ts); a test tagged @staging-only writes and never runs against production.
import { expect, test } from "../../fixtures/bypass.js";
import { declaredProbes, expectedStatuses, runProbe } from "../../src/probes.js";
import { EXPECTED_BODIES, EXPECTED_SHELL_HEADERS, healthViolations, IMMUTABLE_CACHE_CONTROL, shellAssetPaths } from "./expected.js";

const probes = declaredProbes(import.meta.url);
test.use({ packProbes: { list: probes } });

test.describe("P1 shell index", () => {
  test("/ answers 200 text/html, no-cache, with the exact security headers", async ({ api }) => {
    const res = await api.get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    for (const [name, value] of Object.entries(EXPECTED_SHELL_HEADERS)) expect(res.headers.get(name), name).toBe(value);
  });

  test("an unauthenticated visitor reaches the sign-in screen", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#cloud-login-screen")).toBeVisible();
    const link = page.locator("#cloud-login-screen a");
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute("href", "/api/auth/github");
  });
});

test.describe("P2 static shell assets", () => {
  test("every asset the index references is 200 and immutable", async ({ api }) => {
    const index = await api.get("/");
    const assets = shellAssetPaths(index.body, index.url);
    expect(assets.length, "the index references no /s/ asset").toBeGreaterThan(0);
    for (const path of assets) {
      const res = await api.get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control"), path).toBe(IMMUTABLE_CACHE_CONTROL);
    }
  });
});

test.describe("P3 contract routes", () => {
  for (const [path, body] of Object.entries(EXPECTED_BODIES)) {
    test(`${path} answers its exact body`, async ({ api }) => {
      const res = await api.get(path);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual(body);
    });
  }

  test("/api/health answers ok with a config verdict, no setting names and the deployment's identity", async ({ api, target }) => {
    const res = await api.get("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(healthViolations(JSON.parse(res.body), target)).toEqual([]);
  });
});

// P4, P5, P7, P8, P9, P13: each declared probe is sent from a fresh state and must be refused with a 4xx the pack
// expects. P9's routes are listed from the built output (workflow-routes.json); a test pins them to the probes.
test.describe("refusal probes", () => {
  for (const probe of probes) {
    test(`${probe.method} ${probe.path} is refused (${expectedStatuses(probe).join(" or ")})`, async ({ api }) => {
      const result = await runProbe(api, probe);
      expect(result.refused, `answered ${result.status}`).toBe(true);
    });
  }
});

test.describe("P4 telemetry sinks", () => {
  test("a valid CSP report is accepted @staging-only", async ({ api, target }) => {
    test.skip(target.name !== "staging", "writes; staging only");
    const body = JSON.stringify([{ type: "csp-violation", url: "https://example.test/", body: { effectiveDirective: "script-src" } }]);
    const res = await api.request("/api/csp-report", { method: "POST", headers: { "content-type": "application/reports+json" }, body });
    expect(res.status).toBe(204);
  });

  test("an oversize CSP report is refused @staging-only", async ({ api, target }) => {
    test.skip(target.name !== "staging", "writes; staging only");
    const res = await api.request("/api/csp-report", { method: "POST", headers: { "content-type": "application/csp-report" }, body: "x".repeat(16 * 1024 + 1) });
    expect(res.status).toBe(413);
  });
});

test.describe("P5 request guards", () => {
  test("/api/* carries the shell security headers", async ({ api }) => {
    const res = await api.get("/api/mode");
    for (const [name, value] of Object.entries(EXPECTED_SHELL_HEADERS)) expect(res.headers.get(name), name).toBe(value);
  });

  test("principal headers sent by the client have no effect", async ({ api }) => {
    const headers = { "x-fx-user-id": "u", "x-fx-account-id": "a", "x-fx-token-id": "t", "x-fx-scopes": "admin", "x-fx-principal-id": "p" };
    const res = await api.get("/api/v1/budgets", { headers });
    expect(res.status).toBe(401);
  });

  test("a cross-origin write that carries a session cookie is refused @staging-only", async ({ api, target }) => {
    test.skip(target.name !== "staging", "writes; staging only");
    // The cookie value is a placeholder, not a credential: the guard decides on the cookie's presence alone.
    const headers = { cookie: "__Host-fx_session=placeholder", origin: "https://other-origin.example.test", "content-type": "application/json" };
    const res = await api.request("/api/v1/budgets", { method: "PATCH", headers, body: "{}" });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("csrf_rejected");
  });
});

test.describe("P10 site kit", () => {
  test("/site-kit answers 200 with the skeleton heading", async ({ api }) => {
    const res = await api.get("/site-kit");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.body).toContain("<h1>fulcrumaxe site kit</h1>");
  });
});

test.describe("P13 gh-proxy route inside the app", () => {
  test("a request with no OIDC header is refused, never served", async ({ api }) => {
    const res = await api.get("/api/gh-proxy/probe/probe");
    expect([401, 421], `answered ${res.status}`).toContain(res.status);
    if (res.status === 401) expect(JSON.parse(res.body)).toEqual({ error: "missing_oidc_token" });
  });
});
