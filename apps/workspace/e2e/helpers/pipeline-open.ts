// apps/workspace/e2e/helpers/pipeline-open.ts
//
// D#6 C42-4: open the Pipeline app on one work item whose activity body is given, with every reply mocked, under the production CSP and
// Trusted Types directives. Shared by the Pipeline specs that draw runner runs (state by state, and against a sandbox run).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { bootToDesktop } from "./boot";

const V1 = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "packages", "api", "fixtures", "v1");
const fx = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const LIST = fx("listWorkItems", "200-page.json");
const REPOS = fx("listRepos", "200-page.json");
const TIMELINE = fx("getWorkItemTimeline", "200-ok.json");
const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const WIN = `#windows-container .fulc-window[data-app-id="pipeline"]`;
const tid = (page: Page, id: string) => page.locator(`${WIN} [data-testid="${id}"]`);

export async function openPipelineDetail(page: Page, activity: unknown, item: Record<string, unknown> = {}) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    (window as unknown as { __tt: string[] }).__tt = [];
    document.addEventListener("securitypolicyviolation", (e) => (window as unknown as { __tt: string[] }).__tt.push(e.violatedDirective));
  });
  const send = (route: Route, status: number, json: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(json) });
  await page.route((u) => u.pathname.startsWith("/api/v1/") && u.pathname !== "/api/v1/events", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === "/api/v1/work-items") return send(route, 200, { data: [{ ...LIST.data[0], stage: "in_progress", ...item }], next_cursor: null });
    if (p === "/api/v1/repos") return send(route, 200, REPOS);
    if (p.endsWith("/timeline")) return send(route, 200, TIMELINE);
    if (p.endsWith("/activity")) return send(route, 200, activity);
    if (p === "/api/v1/runs") return send(route, 200, { data: [], next_cursor: null });
    return send(route, 404, { error: { code: "not_found", message: "x", request_id: "r" } });
  });
  await page.route("**/api/v1/events", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", headers: { "cache-control": "no-store" }, body: "event: idle\ndata: {}\n\n" }));
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  await bootToDesktop(page);
  await page.evaluate(async () => (await import(new URL("core/cloud-live.js", document.baseURI).href)).default.start());
  await page.evaluate(() => (window as unknown as { FULCWM: Record<string, (id: string) => void> }).FULCWM.open("pipeline"));
  await expect(page.locator(WIN)).toBeVisible();
  await expect(page.locator(WIN)).not.toHaveClass(/opening/);
  await expect(tid(page, "pl-card")).toHaveCount(1);
  if (test.info().project.name === "phone") await tid(page, "pl-card").first().tap();
  else await tid(page, "pl-card").first().click();
  await expect(tid(page, "pl-ins-run").first()).toBeVisible();
  return { errors, tt: () => page.evaluate(() => (window as unknown as { __tt: string[] }).__tt) };
}
