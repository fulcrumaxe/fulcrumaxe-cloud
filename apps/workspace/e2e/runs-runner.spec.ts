// apps/workspace/e2e/runs-runner.spec.ts
//
// D#6 R2b-5b: the Runs detail of a run on the person's own machine: a typed line for each runner event (never "runner event"),
// the usage line in the cost block and the "Ran on your machine" compute row. A sandbox run is unchanged. Mocked replies on the
// contract fixtures, the production CSP and Trusted Types directives. The wording is pinned in test/runner-events.test.mjs.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";

const V1 = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "api", "fixtures", "v1");
const readFixture = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const LIST = readFixture("listRuns", "200-page.json");
const RUN = readFixture("getRun", "200-running.json");
const EXEC = readFixture("getRunInsight", "200-executor-done.json");
const ID = LIST.data[0].id as string;
const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const WIN = `#windows-container .fulc-window[data-app-id="runs"]`;
const tid = (page: Page, id: string) => page.locator(`${WIN} [data-testid="${id}"]`);

const at = (n: number) => new Date(Date.UTC(2026, 9, 9, 12, 0, n)).toISOString();
const ev = (seq: number, payload: Record<string, unknown>) => ({ seq, kind: "runner.event", at: at(seq), payload });
const EVENTS = [
  ev(1, { type: "engine_version", engine_version: "2.1.0" }),
  ev(2, { type: "tool_use", tool_name: "Edit", file_path: "src/a.ts" }),
  ev(3, { type: "file_changed", file_path: "src/a.ts" }),
  ev(4, { type: "command_exit", exit_code: 0, duration_ms: 3200 }),
  ev(5, { type: "usage", usage: { input: 1000, output: 200 } }),
  ev(6, { type: "usage_limit_reached", reset_at: "2026-10-09T18:30:00.000Z" }),
  ev(7, { type: "credential_mismatch" }),
  ev(8, { type: "taken_over" }),
  ev(9, { type: "run_ended", reason: "agent_failed" }),
  ev(10, { type: "a_type_from_a_newer_runner" }),
  ev(11, { type: "tool_use", tool_name: "<b>x</b>", file_path: "<img src=x onerror=alert(1)>" }),
];
const usage = (over: Record<string, unknown> = {}) => ({ credential_mode: "subscription", model: "claude-sonnet-4-5", tokens_in: 182000, tokens_out: 9400, cache_read_tokens: 0, cache_write_tokens: 0, api_equivalent_usd: 1.2345, price_table_version: "v1", ...over });
const runnerInsight = (over: Record<string, unknown>) => ({
  ...EXEC,
  run: { ...EXEC.run, id: ID, runtime: "runner", execution_mode: "runner_local" },
  cost: { model: { usd: null, source: null, tokens_in: null, tokens_out: null }, compute: { usd: null, source: null } },
  ...over,
});

async function setup(page: Page, insight: unknown, events: unknown[]) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    window.addEventListener("focus", (e) => e.stopImmediatePropagation(), true);
    (window as unknown as { __tt: string[] }).__tt = [];
    document.addEventListener("securitypolicyviolation", (e) => (window as unknown as { __tt: string[] }).__tt.push(e.violatedDirective));
  });
  const send = (route: Route, json: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) }).catch(() => undefined);
  await page.route((u) => u.pathname.startsWith("/api/v1/runs"), async (route) => {
    if ((route.request().headers()["accept"] ?? "").includes("text/event-stream")) return route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: idle\ndata: {}\n\n" }).catch(() => undefined);
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (p === "/api/v1/runs") return send(route, { data: [{ ...RUN, id: ID, status: "succeeded" }], next_cursor: null });
    if (p.endsWith("/insight")) return send(route, insight);
    if (p.endsWith("/events")) {
      const from = Number(url.searchParams.get("cursor") ?? 0);
      const data = events.filter((e) => (e as { seq: number }).seq > from);
      return send(route, { data, next_cursor: data.length ? String((data[data.length - 1] as { seq: number }).seq) : String(from) });
    }
    return send(route, { ...RUN, id: ID, status: "succeeded" });
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
  return { errors, tt: () => page.evaluate(() => (window as unknown as { __tt: string[] }).__tt) };
}

test.describe("D#6 R2b-5b: a run on the person's own machine (mocked API)", () => {
  test("every runner event is a typed line, and the page never says 'runner event'", async ({ page }) => {
    const { errors, tt } = await setup(page, runnerInsight({ runner_usage: usage() }), EVENTS);
    await expect(tid(page, "run-event")).toHaveCount(EVENTS.length);
    const lines = await tid(page, "run-event-text").allTextContents();
    expect(lines).toEqual([
      "Claude 2.1.0",
      "Used Edit · src/a.ts",
      "Changed src/a.ts",
      "Command exited 0 after 3.2s",
      "1,000 in / 200 out tokens",
      "Plan usage limit reached; resumes at 2026-10-09 18:30 UTC",
      "The sign-in on your runner is not the one this run was set up with.",
      "Taken over on the machine",
      "The agent stopped without finishing. Retry, or open the run for details.",
      "Runner step",
      "Used <b>x</b> · <img src=x onerror=alert(1)>",
    ]);
    // markup stayed text: no element was made from it
    await expect(tid(page, "runs-detail").locator("img, b")).toHaveCount(0);
    const pageText = (await page.locator(WIN).innerText()).toLowerCase();
    expect(pageText).not.toContain("runner event");
    expect(pageText).not.toMatch(/claude[\s_\-. ]*code/);
    expect(await tt()).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("the cost block: priced plan run, with the compute row", async ({ page }) => {
    await setup(page, runnerInsight({ runner_usage: usage() }), EVENTS);
    await expect(tid(page, "runs-cost-model")).toContainText("On your Claude plan · API-equivalent $1.23 · 182,000 in / 9,400 out tokens");
    await expect(tid(page, "runs-cost-compute")).toContainText("Ran on your machine: no sandbox compute");
    const cost = (await tid(page, "runs-cost").innerText()).toLowerCase();
    expect(cost).not.toMatch(/spend|spent|charge|fulfil/);
  });

  test("unpriced model", async ({ page }) => {
    await setup(page, runnerInsight({ runner_usage: usage({ api_equivalent_usd: null }) }), EVENTS);
    await expect(tid(page, "runs-cost-model")).toContainText("On your Claude plan · no API price for this model · 182,000 in / 9,400 out tokens");
  });

  test("API-key mode", async ({ page }) => {
    await setup(page, runnerInsight({ runner_usage: usage({ credential_mode: "api_key" }) }), EVENTS);
    await expect(tid(page, "runs-cost-model")).toContainText("On your own API key · $1.23 at API prices · 182,000 in / 9,400 out tokens");
  });

  test("a run with no usage recorded", async ({ page }) => {
    await setup(page, runnerInsight({ runner_usage: null }), EVENTS.slice(0, 2));
    await expect(tid(page, "runs-cost-model")).toContainText("Not recorded");
    await expect(tid(page, "runs-cost-compute")).toContainText("Ran on your machine: no sandbox compute");
  });

  test("a sandbox run has no usage line and keeps its sandbox compute row", async ({ page }) => {
    await setup(page, EXEC, EVENTS.slice(0, 2));
    await expect(tid(page, "runs-cost-compute")).toContainText("Sandbox compute");
    await expect(tid(page, "runs-cost")).not.toContainText("Ran on your machine");
    await expect(tid(page, "runs-cost")).not.toContainText("API-equivalent");
  });
});
