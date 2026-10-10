// apps/workspace/e2e/helpers/runs-open.ts
//
// D#6 C42-4: open the Runs app on one run whose insight is given, with every reply mocked, under the production CSP and Trusted Types
// directives. Shared by the Runs specs that draw runner runs (state by state, and against a sandbox run).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";

const V1 = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "packages", "api", "fixtures", "v1");
const RUN = JSON.parse(readFileSync(join(V1, "getRun", "200-running.json"), "utf8"));
const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const WIN = `#windows-container .fulc-window[data-app-id="runs"]`;
const tid = (page: Page, id: string) => page.locator(`${WIN} [data-testid="${id}"]`);

export async function openRunsDetail(page: Page, insight: { run: { id: string; status: string } }) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    window.addEventListener("focus", (e) => e.stopImmediatePropagation(), true);
    (window as unknown as { __tt: string[] }).__tt = [];
    document.addEventListener("securitypolicyviolation", (e) => (window as unknown as { __tt: string[] }).__tt.push(e.violatedDirective));
  });
  const send = (route: Route, json: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) }).catch(() => undefined);
  const ID = insight.run.id;
  await page.route((u) => u.pathname.startsWith("/api/v1/runs"), async (route) => {
    if ((route.request().headers()["accept"] ?? "").includes("text/event-stream")) return route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: idle\ndata: {}\n\n" }).catch(() => undefined);
    const p = new URL(route.request().url()).pathname;
    if (p === "/api/v1/runs") return send(route, { data: [{ ...RUN, id: ID, status: insight.run.status }], next_cursor: null });
    if (p.endsWith("/insight")) return send(route, insight);
    if (p.endsWith("/events")) return send(route, { data: [], next_cursor: "0" });
    return send(route, { ...RUN, id: ID, status: insight.run.status });
  });
  await page.route("**/api/v1/events", () => new Promise<void>(() => {}));
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  await page.goto("/");
  await page.waitForFunction(() => (window as unknown as { currentStep?: string }).currentStep === "DESKTOP", null, { timeout: 30_000 });
  await page.locator('.dock-icon[data-app-id="runs"]').click();
  await expect(page.locator(WIN)).toBeVisible();
  await expect(page.locator(WIN)).not.toHaveClass(/opening/);
  await expect(tid(page, "runs-row")).toHaveCount(1);
  if (test.info().project.name === "phone") await tid(page, "runs-row").first().tap();
  else await tid(page, "runs-row").first().click();
  await expect(tid(page, "runs-head")).toBeVisible();
  await expect(tid(page, "runs-activity")).toBeVisible();
  return { errors, tt: () => page.evaluate(() => (window as unknown as { __tt: string[] }).__tt) };
}
