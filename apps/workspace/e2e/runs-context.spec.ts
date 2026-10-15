// apps/workspace/e2e/runs-context.spec.ts
//
// D#600 CX-8: the Runs detail's context panel, on mocked replies from the repo's contract fixtures (packages/api/fixtures/v1/getRunContext,
// plus getRunInsight, getRun and listRuns for the run itself). The built cloud dist is served by fixture-server.mjs, with the production CSP
// and Trusted Types directives. Every test runs on desktop, phone and tablet.
//
// The logic half (sizes, shares, every state's words) is in test/runs-context.test.mjs; this file covers what needs a real DOM: the bars
// and their text, axe in every theme, the Retry, the run opened from another app, and that nothing overflows.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page, type Route } from "@playwright/test";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const V1 = join(SCRIPT_DIR, "..", "..", "..", "packages", "api", "fixtures", "v1");
const readFixture = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const LIST = readFixture("listRuns", "200-page.json");
const RUN = readFixture("getRun", "200-running.json");
const EVENTS = readFixture("listRunEvents", "200-page.json");
const INSIGHT = readFixture("getRunInsight", "200-executor-done.json");
const CTX = {
  measured: readFixture("getRunContext", "200-measured.json"),
  partial: readFixture("getRunContext", "200-partial-gateway.json"),
  runner: readFixture("getRunContext", "200-runner.json"),
  none: readFixture("getRunContext", "200-not-recorded.json"),
  live: readFixture("getRunContext", "200-running-not-recorded.json"),
};

const ID = LIST.data[0].id as string;
const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const WIN = `#windows-container .fulc-window[data-app-id="runs"]`;
const PANEL = `${WIN} [data-testid="runs-context"]`;
const tid = (page: Page, id: string) => page.locator(`${WIN} [data-testid="${id}"]`);
const THEMES = ["classic-crt", "retro-amber", "nord", "corporate", "modern-flat", "crystal", "orchard", "cyberpunk"];

interface Mock {
  requests: string[];
  /** Replies handed out in order for the context route; the last one repeats. */
  context: { status: number; json: unknown }[];
}

async function setup(page: Page, context: Mock["context"], runStatus = "succeeded") {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    window.addEventListener("focus", (e) => e.stopImmediatePropagation(), true);
  });
  const mock: Mock = { requests: [], context: [...context] };
  const send = (route: Route, status: number, json: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(json) }).catch(() => undefined);
  await page.route((u) => u.pathname.startsWith("/api/v1/runs"), async (route) => {
    if ((route.request().headers()["accept"] ?? "").includes("text/event-stream")) {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: idle\ndata: {}\n\n" }).catch(() => undefined);
    }
    const url = new URL(route.request().url());
    const p = url.pathname;
    mock.requests.push(`${route.request().method()} ${p}`);
    if (p === "/api/v1/runs") return send(route, 200, { data: [{ ...RUN, id: ID, status: runStatus }], next_cursor: null });
    if (p.endsWith("/context")) {
      const r = mock.context.length > 1 ? mock.context.shift()! : mock.context[0]!;
      return send(route, r.status, r.json);
    }
    if (p.endsWith("/insight")) return send(route, 200, INSIGHT);
    if (p.endsWith("/events")) {
      const from = Number(url.searchParams.get("cursor") ?? 0);
      const data = EVENTS.data.filter((e: { seq: number }) => e.seq > from).slice(0, Number(url.searchParams.get("limit") ?? 50));
      return send(route, 200, { data, next_cursor: data.length ? String(data[data.length - 1].seq) : String(from) });
    }
    return send(route, 200, { ...RUN, id: p.split("/").pop(), status: runStatus });
  });
  await page.route("**/api/v1/events", () => new Promise<void>(() => {}));
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  await page.goto("/");
  await page.waitForFunction(() => (window as unknown as { currentStep?: string }).currentStep === "DESKTOP", null, { timeout: 30_000 });
  return { errors, mock };
}

async function openFromDock(page: Page) {
  await page.locator('.dock-icon[data-app-id="runs"]').click();
  await expect(page.locator(WIN)).toBeVisible();
  await expect(page.locator(WIN)).not.toHaveClass(/opening/);
  await expect(tid(page, "runs-row")).toHaveCount(1);
  if (test.info().project.name === "phone") await tid(page, "runs-row").first().tap();
  else await tid(page, "runs-row").first().click();
  await expect(tid(page, "runs-head")).toBeVisible();
}

async function expectNoOverflow(page: Page) {
  const r = await page.locator(PANEL).evaluate((el) => {
    const box = el as HTMLElement;
    const right = box.getBoundingClientRect().right;
    const wide = [...box.querySelectorAll("*")].filter((n) => n.getBoundingClientRect().width > 0 && n.getBoundingClientRect().right > right + 1).map((n) => n.tagName + "." + (n as HTMLElement).className);
    return { scrollW: box.scrollWidth, clientW: box.clientWidth, wide };
  });
  expect(r.scrollW).toBeLessThanOrEqual(r.clientW + 1);
  expect(r.wide).toEqual([]);
}

async function axeSeriousOrCritical(page: Page) {
  const found: string[] = [];
  for (const theme of THEMES) {
    await page.evaluate(async (id) => {
      const m = await import(new URL("core/theme-manager.js", document.baseURI).href);
      await m.FULCTheme.apply(id);
    }, theme);
    const res = await new AxeBuilder({ page })
      .include(PANEL)
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
      .analyze();
    const brief = (v: (typeof res.violations)[number]) => `[${theme}] ${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`;
    found.push(...res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map(brief));
  }
  return found;
}

test.describe("D#600 CX-8: the run's context panel (mocked API)", () => {
  test("a measured run: every row has a bar and its share as text, the cache line, tools, memory, and no axe violation in any theme", async ({ page }) => {
    const { errors, mock } = await setup(page, [{ status: 200, json: CTX.measured }]);
    await openFromDock(page);
    await expect(page.locator(PANEL)).toHaveAttribute("data-state", "ready");
    expect(mock.requests.filter((r) => r.endsWith("/context"))).toEqual([`GET /api/v1/runs/${ID}/context`]);
    const rows = page.locator(`${PANEL} [data-testid="runs-ctx-row"]`);
    expect(await rows.count()).toBeGreaterThan(8);
    // A bar is never alone: each row with a bar says its share in words, and the bar is a named meter.
    const shown = await page.locator(`${PANEL} [data-testid="runs-ctx-sections"] [data-testid="runs-ctx-row"]`).evaluateAll((els) =>
      els.map((e) => ({ pct: e.querySelector('[data-testid="runs-ctx-pct"]')?.textContent ?? "", meter: e.querySelector("meter")?.getAttribute("aria-label") ?? "" })),
    );
    for (const r of shown) {
      expect(r.pct).toMatch(/^(<1|\d+)%/);
      expect(r.meter).toMatch(/ share$/);
    }
    await expect(page.locator(`${PANEL} [data-testid="runs-ctx-cache"]`)).toHaveText("4,200,000 of 4,510,000 tokens from cache");
    await expect(page.locator(`${PANEL} [data-testid="runs-ctx-trim"]`).first()).toContainText("Trimmed");
    await expect(page.locator(`${PANEL} [data-testid="runs-ctx-memory"]`)).toContainText("Migrations are numbered in order");
    await expect(page.locator(PANEL)).not.toContainText(/null|undefined|NaN/);
    await expectNoOverflow(page);
    expect(await axeSeriousOrCritical(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("a partial run says estimated; a run with no ledger says Not recorded; both pass axe", async ({ page }) => {
    const { errors } = await setup(page, [{ status: 200, json: CTX.partial }]);
    await openFromDock(page);
    await expect(page.locator(PANEL)).toHaveAttribute("data-state", "partial");
    await expect(page.locator(`${PANEL} [data-testid="runs-ctx-estimated"]`)).toHaveAttribute("role", "status");
    await expect(page.locator(`${PANEL} [data-testid="runs-ctx-cache"]`)).toHaveText("Cache use: Not recorded");
    await expect(page.locator(PANEL)).not.toContainText(/null|undefined|NaN/);
    expect(await axeSeriousOrCritical(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("not recorded", async ({ page }) => {
    const { errors } = await setup(page, [{ status: 200, json: CTX.none }]);
    await openFromDock(page);
    await expect(page.locator(PANEL)).toHaveAttribute("data-state", "none");
    await expect(page.locator(`${PANEL} [data-testid="runs-ctx-empty"]`)).toContainText("Not recorded for this run.");
    expect(await axeSeriousOrCritical(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("a runner run is labelled and shows sizes and counts only", async ({ page }) => {
    const { errors } = await setup(page, [{ status: 200, json: CTX.runner }]);
    await openFromDock(page);
    await expect(page.locator(`${PANEL} [data-testid="runs-ctx-runner"]`)).toContainText("Contents stayed on your machine");
    const text = await page.locator(PANEL).innerText();
    expect(text).not.toMatch(/[\\/]/);
    await expect(page.locator(`${PANEL} [data-testid="runs-ctx-memory"]`)).toHaveCount(0);
    expect(await axeSeriousOrCritical(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("an unreadable reply shows one plain message with Retry; Retry reads again and draws the panel", async ({ page }) => {
    const { errors, mock } = await setup(page, [
      { status: 500, json: { error: "boom: server text that must never be shown" } },
      { status: 200, json: CTX.measured },
    ]);
    await openFromDock(page);
    await expect(page.locator(PANEL)).toHaveAttribute("data-state", "error");
    await expect(page.locator(PANEL)).not.toContainText("server text");
    await expect(page.locator(PANEL)).toContainText("isn't available right now");
    expect(await axeSeriousOrCritical(page)).toEqual([]);
    const retry = page.locator(`${PANEL} [data-testid="runs-ctx-retry"]`);
    if (test.info().project.name === "phone") await retry.tap();
    else await retry.click();
    await expect(page.locator(PANEL)).toHaveAttribute("data-state", "ready");
    expect(mock.requests.filter((r) => r.endsWith("/context"))).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  test("a live run that has no ledger yet says it is recorded when the run ends", async ({ page }) => {
    const { errors } = await setup(page, [{ status: 200, json: CTX.live }], "running");
    await openFromDock(page);
    await expect(page.locator(PANEL)).toHaveAttribute("data-state", "live");
    await expect(page.locator(PANEL)).toContainText("Recorded when this run ends.");
    expect(errors).toEqual([]);
  });

  test("asked for by another app (Pipeline's link), the Runs app opens that run's detail", async ({ page }) => {
    const { errors } = await setup(page, [{ status: 200, json: CTX.measured }]);
    const open = (runId: string) => page.evaluate((id) => (window as unknown as { FULCWM: { open: (a: string, arg: unknown) => void } }).FULCWM.open("runs", { runId: id }), runId);
    // an argument that is not a run id is ignored: the list shows, no detail opens
    await open("../../etc/passwd");
    await expect(tid(page, "runs-row")).toHaveCount(1);
    await expect(tid(page, "runs-head")).toHaveCount(0);
    await open(ID);
    await expect(tid(page, "runs-head")).toBeVisible();
    await expect(page.locator(PANEL)).toHaveAttribute("data-state", "ready");
    expect(errors).toEqual([]);
  });
});
