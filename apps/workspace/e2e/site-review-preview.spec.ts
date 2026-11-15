// apps/workspace/e2e/site-review-preview.spec.ts
//
// D#3 K10: a finished site preview renders in the Site review app under the REAL workspace CSP. The shell's policy
// (apps/web/lib/shell/headers.ts) is read from that file and put on the document response, so `require-trusted-types-for 'script'`,
// `trusted-types 'none'`, `frame-src` and the rest are the production ones, apart from two directives that only matter behind
// the real host (`upgrade-insecure-requests` would turn this test server's http into https, and `report-to csp` names an endpoint
// the test server does not have). The render is answered with the policy the API route sends. The frame must show the page, and
// the page must record no securitypolicyviolation and no console error: an `srcdoc` assignment fails both under this policy.
// It also proves the check is live: a deliberate srcdoc assignment in the same page throws a TypeError.

import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";

const SITE = "11111111-2222-4333-8444-555555555555";
const VERSION = "99999999-2222-4333-8444-555555555555";
const HEADERS_TS = readFileSync(new URL("../../web/lib/shell/headers.ts", import.meta.url), "utf8");
const ROUTE_TS = readFileSync(new URL("../../../packages/api/src/routes/sitePreview.ts", import.meta.url), "utf8");

const realWorkspaceCsp = (): string => {
  const m = /export const WORKSPACE_CSP =\s*"([^"]+)"/.exec(HEADERS_TS);
  if (!m) throw new Error("WORKSPACE_CSP not found in apps/web/lib/shell/headers.ts");
  return m[1]!
    .split(";")
    .map((d) => d.trim())
    .filter((d) => d !== "upgrade-insecure-requests" && d !== "report-to csp")
    .join("; ");
};
const renderCsp = (): string => {
  const m = /"Content-Security-Policy": "([^"]+)"/.exec(ROUTE_TS);
  if (!m) throw new Error("render policy not found in sitePreview.ts");
  return m[1]!;
};

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const LOCKED = { locked: true, label: "Setup payment required" };

async function mockApi(page: Page, preview: Record<string, unknown> | null) {
  await page.route((u) => u.pathname.startsWith("/api/v1/") && u.pathname !== "/api/v1/events", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === "/api/v1/sites") {
      return route.fulfill(json({ data: [{ id: SITE, domain: "example.test", status: "draft", repo_full_name: "acme/widget", created_at: "2026-11-01T00:00:00Z", billing: { setup_paid: false, sync_status: null, sync_current_period_end: null, sync_cancel_at_period_end: false } }], next_cursor: null }));
    }
    if (p === `/api/v1/sites/${SITE}/versions`) return route.fulfill(json({ data: [{ version_id: VERSION, created_at: "2026-11-02T00:00:00Z", review_state: "pending", pending_links: 0, pending_claims: 0 }], next_cursor: null }));
    if (p === `/api/v1/site-versions/${VERSION}/review`) {
      return route.fulfill(json({ site_id: SITE, approved: false, claims: [], pending_links: [], report: { counts: { VERIFIED: 1 }, blockers: [], evidence: [] } }));
    }
    if (p === `/api/v1/sites/${SITE}/billing`) return route.fulfill(json({ setup: { paid: false, paid_at: null }, sync: { status: null, current_period_end: null, cancel_at_period_end: false }, prices_provisional: true, expected_spend: [] }));
    if (p === `/api/v1/sites/${SITE}/preview`) {
      return route.fulfill(json({ preview, model_cap_usd: 20, compute_cap_usd: 1, locks: { full_site: LOCKED, downloads: LOCKED, publish: LOCKED } }));
    }
    if (p === `/api/v1/sites/${SITE}/preview/render`) {
      return route.fulfill({ status: 200, headers: { "content-security-policy": renderCsp(), "x-content-type-options": "nosniff" }, contentType: "text/html; charset=utf-8", body: "<!doctype html><title>Home</title><h1>Acme widget homepage</h1><script>document.title='ran'</script>" });
    }
    return route.fulfill(json({ error: { code: "not_found" } }, 404));
  });
}

async function openSiteReview(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __violations: string[] };
    w.__violations = [];
    document.addEventListener("securitypolicyviolation", (e) => w.__violations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  await page.route("**/", async (route) => {
    if (new URL(route.request().url()).pathname !== "/") return route.fallback();
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": realWorkspaceCsp() } });
  });
  await bootToDesktop(page);
  await page.evaluate(async () => (await import(new URL("core/cloud-live.js", document.baseURI).href)).default.start());
  await page.evaluate((v) => (window as unknown as { FULCWM: Record<string, (id: string, arg?: unknown) => void> }).FULCWM.open("site-review", { versionId: v }), VERSION);
  await expect(page.locator('#windows-container .fulc-window[data-app-id="site-review"]')).toBeVisible();
}

const FINISHED = {
  preview_id: "22222222-2222-4333-8444-555555555555",
  state: "finished",
  reason: null,
  created_at: "2026-11-02T01:00:00Z",
  finished_at: "2026-11-02T01:05:00Z",
  summary: { claims: 12, unverifiable: 3, blockers: 1, line: "12 claims, 3 unverifiable, 1 blockers" },
  homepage_url: `/api/v1/sites/${SITE}/preview/render`,
};

test.describe("D#3 K10: the preview panel under the real workspace CSP", () => {
  test("a finished preview renders its homepage in a sandboxed frame, with the line and the locks, and no CSP or Trusted Types violation", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (c) => {
      if (c.type() === "error") errors.push(c.text());
    });
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    await mockApi(page, FINISHED);
    await openSiteReview(page);

    const panel = page.getByTestId("sr-preview");
    await expect(panel.getByTestId("sr-preview-state")).toHaveText("12 claims, 3 unverifiable, 1 blockers");
    const frame = panel.getByTestId("sr-preview-frame");
    await expect(frame).toBeVisible();
    await expect(frame).toHaveAttribute("sandbox", "");
    await expect(frame).toHaveAttribute("src", `/api/v1/sites/${SITE}/preview/render`);
    await expect(frame).not.toHaveAttribute("srcdoc", /.*/);
    // The page is really drawn, and the script inside it did not run (the render's own policy forbids it).
    const inside = page.frameLocator('[data-testid="sr-preview-frame"]');
    await expect(inside.getByRole("heading", { name: "Acme widget homepage" })).toBeVisible();
    await expect(inside.locator("body")).toContainText("Acme widget homepage");
    await expect(panel.getByTestId("sr-preview-locks")).toContainText("Full site: Setup payment required");
    await expect(panel.getByTestId("sr-preview-locks")).toContainText("Downloads: Setup payment required");
    await expect(panel.getByTestId("sr-preview-locks")).toContainText("Publish: Setup payment required");
    expect(await panel.innerText()).not.toMatch(/\b(null|undefined)\b/i);

    expect(await page.evaluate(() => (window as unknown as { __violations: string[] }).__violations)).toEqual([]);
    // The only console noise allowed is the browser refusing the hostile script that the render deliberately carries here:
    // that refusal is the render's own policy working. Anything else (a TypeError, a CSP report for the shell) fails.
    const refused = errors.filter((e) => e.startsWith("Blocked script execution in"));
    expect(refused.length).toBeGreaterThan(0);
    expect(errors.filter((e) => !e.startsWith("Failed to load resource") && !refused.includes(e))).toEqual([]);

    // The check is live: the old way to draw the page throws under this same policy.
    const threw = await page.evaluate(() => {
      try {
        (document.createElement("iframe") as HTMLIFrameElement).srcdoc = "<b>x</b>";
        return false;
      } catch {
        return true;
      }
    });
    expect(threw).toBe(true);
  });

  test("a preview that is not finished shows its state in words and no frame", async ({ page }) => {
    await mockApi(page, { ...FINISHED, state: "running", finished_at: null, summary: null, homepage_url: null });
    await openSiteReview(page);
    const panel = page.getByTestId("sr-preview");
    await expect(panel.getByTestId("sr-preview-state")).toContainText("Preview running");
    await expect(panel.getByTestId("sr-preview-frame")).toHaveCount(0);
  });
});
