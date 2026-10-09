// apps/workspace/e2e/pipeline-runner-usage.spec.ts
//
// D#6 R2b-5b: the Pipeline detail's Runs section shows a run on the person's own machine with its usage line, and the item's
// separate own-plan total. A sandbox run has no usage line. Mocked replies on the contract fixtures; the production CSP.
// The wording is pinned in test/runner-events.test.mjs; this file covers the real DOM.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";

const V1 = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "api", "fixtures", "v1");
const fx = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const LIST = fx("listWorkItems", "200-page.json");
const REPOS = fx("listRepos", "200-page.json");
const TIMELINE = fx("getWorkItemTimeline", "200-ok.json");
const WORK = fx("listRuns", "200-work-item.json");
const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const WIN = `#windows-container .fulc-window[data-app-id="pipeline"]`;
const tid = (page: Page, id: string) => page.locator(`${WIN} [data-testid="${id}"]`);

const usage = (over: Record<string, unknown> = {}) => ({ credential_mode: "subscription", model: "claude-sonnet-4-5", tokens_in: 182000, tokens_out: 9400, cache_read_tokens: 0, cache_write_tokens: 0, api_equivalent_usd: 1.2345, price_table_version: "v1", ...over });

async function start(page: Page, runs: unknown[], ownPlan: number | undefined) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  const send = (route: Route, status: number, json: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(json) });
  await page.route((u) => u.pathname.startsWith("/api/v1/") && u.pathname !== "/api/v1/events", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === "/api/v1/work-items") return send(route, 200, { data: [{ ...LIST.data[0], stage: "in_progress", ...(ownPlan === undefined ? {} : { own_plan_api_equivalent_usd: ownPlan }) }], next_cursor: null });
    if (p === "/api/v1/repos") return send(route, 200, REPOS);
    if (p.endsWith("/timeline")) return send(route, 200, TIMELINE);
    if (p === "/api/v1/runs") return send(route, 200, { ...WORK, data: runs });
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
  await expect(tid(page, "pl-card")).toHaveCount(1);
  if (test.info().project.name === "phone") await tid(page, "pl-card").first().tap();
  else await tid(page, "pl-card").first().click();
  await expect(tid(page, "pl-run")).toHaveCount(runs.length);
  return errors;
}

const base = WORK.data[0];
const runner = (id: string, over: Record<string, unknown>) => ({ ...base, id, status: "succeeded", runtime: "runner", ...over });

test.describe("D#6 R2b-5b: usage in the Pipeline Runs section (mocked API)", () => {
  test("a priced plan run, an unpriced one, an API-key one, a run with no usage yet and a sandbox run", async ({ page }) => {
    const ids = ["aaaaaaaa-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-000000000002", "aaaaaaaa-0000-4000-8000-000000000003", "aaaaaaaa-0000-4000-8000-000000000004", "aaaaaaaa-0000-4000-8000-000000000005"];
    const runs = [
      runner(ids[0], { runner_usage: usage() }),
      runner(ids[1], { runner_usage: usage({ api_equivalent_usd: null }) }),
      runner(ids[2], { runner_usage: usage({ credential_mode: "api_key" }) }),
      runner(ids[3], { runner_usage: null }),
      { ...base, id: ids[4], status: "succeeded", runtime: "production", usd: 0.5 },
    ];
    const errors = await start(page, runs, 3.5);
    const rowOf = (i: number) => tid(page, "pl-run").nth(i);
    await expect(rowOf(0).locator('[data-testid="pl-run-usage"]')).toHaveText("On your Claude plan · API-equivalent $1.23 · 182,000 in / 9,400 out tokens");
    await expect(rowOf(1).locator('[data-testid="pl-run-usage"]')).toHaveText("On your Claude plan · no API price for this model · 182,000 in / 9,400 out tokens");
    await expect(rowOf(2).locator('[data-testid="pl-run-usage"]')).toHaveText("On your own API key · $1.23 at API prices · 182,000 in / 9,400 out tokens");
    await expect(rowOf(3).locator('[data-testid="pl-run-usage"]')).toHaveCount(0);
    await expect(rowOf(4).locator('[data-testid="pl-run-usage"]')).toHaveCount(0);
    await expect(rowOf(4)).toContainText("$0.50");
    await expect(tid(page, "pl-own-plan")).toHaveText("On your own plan (API-equivalent): $3.50");
    // the tool's two-word name does not appear, and nothing says "runner event"
    const text = (await tid(page, "pl-runs").innerText()).toLowerCase();
    expect(text).not.toContain("runner event");
    expect(text).not.toMatch(/claude[\s_\-. ]*code/);
    // nothing sticks out of the section
    const over = await tid(page, "pl-runs").evaluate((el) => {
      const r = el.getBoundingClientRect().right;
      return [...el.querySelectorAll("*")].filter((n) => n.getBoundingClientRect().width > 0 && n.getBoundingClientRect().right > r + 1).length;
    });
    expect(over).toBe(0);
    expect(errors).toEqual([]);
  });

  test("an item with no runner usage shows no own-plan line", async ({ page }) => {
    await start(page, [{ ...base, runtime: "production" }], 0);
    await expect(tid(page, "pl-own-plan")).toHaveCount(0);
    await expect(tid(page, "pl-run-usage")).toHaveCount(0);
  });

  test("an item whose reply has no own-plan figure (older server) shows no own-plan line", async ({ page }) => {
    await start(page, [{ ...base, runtime: "production" }], undefined);
    await expect(tid(page, "pl-own-plan")).toHaveCount(0);
  });
});
