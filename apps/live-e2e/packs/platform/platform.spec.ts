// platform pack, rows P1-P3: the shell index, its immutable assets and the static contract routes.
// Runs on every device project; the browser boot is the part that differs per device.
import { expect, test } from "../../fixtures/bypass.js";
import { EXPECTED_BODIES, EXPECTED_SHELL_HEADERS, IMMUTABLE_CACHE_CONTROL, shellAssetPaths } from "./expected.js";

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

  test("/api/health answers ok with a config verdict and no setting names", async ({ api }) => {
    const res = await api.get("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, config: "ok" });
    expect(["ok", "missing"]).toContain(body.planData);
    expect(Object.keys(body).sort()).toEqual(["config", "ok", "planData"]);
  });
});
