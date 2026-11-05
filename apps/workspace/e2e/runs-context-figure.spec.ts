// apps/workspace/e2e/runs-context-figure.spec.ts
//
// D#600 CX-9b: how full the run's context window is. Two places, on mocked replies from the repo's contract fixtures (getRunContext, listWorkItems): the
// near-limit banner on the run (a role="status" message with a Dismiss button) and the chip on the item's card in the Pipeline board. Every test runs on
// desktop, phone and tablet. The words of every state are in test/runs-context-figure.test.mjs; this file covers the real DOM, axe and the layout.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page, type Route } from "@playwright/test";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const V1 = join(SCRIPT_DIR, "..", "..", "..", "packages", "api", "fixtures", "v1");
const readFixture = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const RUN_LIST = readFixture("listRuns", "200-page.json");
const RUN = readFixture("getRun", "200-running.json");
const EVENTS = readFixture("listRunEvents", "200-page.json");
const INSIGHT = readFixture("getRunInsight", "200-executor-done.json");
const CTX = {
  live75: readFixture("getRunContext", "200-running-figure.json"),
  ended71: readFixture("getRunContext", "200-measured.json"),
  unknown: readFixture("getRunContext", "200-window-unknown.json"),
  none: readFixture("getRunContext", "200-running-not-recorded.json"),
};
const ITEMS = readFixture("listWorkItems", "200-page.json");
const REPOS = readFixture("listRepos", "200-page.json");

const RUN_ID = RUN_LIST.data[0].id as string;
const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const RUNS_WIN = `#windows-container .fulc-window[data-app-id="runs"]`;
const PL_WIN = `#windows-container .fulc-window[data-app-id="pipeline"]`;
const THEMES = ["classic-crt", "retro-amber", "nord", "corporate", "modern-flat", "crystal", "orchard", "cyberpunk"];
const isPhone = () => test.info().project.name === "phone";

async function boot(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    window.addEventListener("focus", (e) => e.stopImmediatePropagation(), true);
  });
  await page.route("**/api/v1/events", () => new Promise<void>(() => {}));
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  return errors;
}
const send = (route: Route, status: number, json: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(json) }).catch(() => undefined);

interface RunsOpts {
  /** The context route's answer for its nth request (1-based); a promise holds that answer until it settles. Default: the same body every time. */
  contextFor?: (n: number) => unknown | Promise<unknown>;
  /** The run's event stream: held until this resolves, then served as the body (frames). Default: an idle frame. */
  stream?: Promise<string>;
}

async function runsSetup(page: Page, context: unknown, runStatus: string, opts: RunsOpts = {}) {
  const errors = await boot(page);
  let contextRequests = 0;
  await page.route((u) => u.pathname.startsWith("/api/v1/runs"), async (route) => {
    if ((route.request().headers()["accept"] ?? "").includes("text/event-stream")) {
      const body = opts.stream ? await opts.stream : "event: idle\ndata: {}\n\n";
      return route.fulfill({ status: 200, contentType: "text/event-stream", body }).catch(() => undefined);
    }
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (p === "/api/v1/runs") return send(route, 200, { data: [{ ...RUN, id: RUN_ID, status: runStatus }], next_cursor: null });
    if (p.endsWith("/context")) {
      const n = ++contextRequests;
      return send(route, 200, opts.contextFor ? await opts.contextFor(n) : context);
    }
    if (p.endsWith("/insight")) return send(route, 200, INSIGHT);
    if (p.endsWith("/events")) {
      const from = Number(url.searchParams.get("cursor") ?? 0);
      const data = EVENTS.data.filter((e: { seq: number }) => e.seq > from).slice(0, Number(url.searchParams.get("limit") ?? 50));
      return send(route, 200, { data, next_cursor: data.length ? String(data[data.length - 1].seq) : String(from) });
    }
    return send(route, 200, { ...RUN, id: p.split("/").pop(), status: runStatus });
  });
  await page.goto("/");
  await page.waitForFunction(() => (window as unknown as { currentStep?: string }).currentStep === "DESKTOP", null, { timeout: 30_000 });
  await page.locator('.dock-icon[data-app-id="runs"]').click();
  await expect(page.locator(RUNS_WIN)).toBeVisible();
  await expect(page.locator(RUNS_WIN)).not.toHaveClass(/opening/);
  const row = page.locator(`${RUNS_WIN} [data-testid="runs-row"]`);
  await expect(row).toHaveCount(1);
  if (isPhone()) await row.first().tap();
  else await row.first().click();
  await expect(page.locator(`${RUNS_WIN} [data-testid="runs-head"]`)).toBeVisible();
  return errors;
}

async function axeSeriousOrCritical(page: Page, include: string) {
  const found: string[] = [];
  for (const theme of THEMES) {
    await page.evaluate(async (id) => {
      const m = await import(new URL("core/theme-manager.js", document.baseURI).href);
      await m.FULCTheme.apply(id);
    }, theme);
    const res = await new AxeBuilder({ page }).include(include).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
    found.push(...res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `[${theme}] ${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`));
  }
  return found;
}

async function insideWindow(page: Page, win: string, selector: string) {
  const r = await page.evaluate(
    ([w, s]) => {
      const box = document.querySelector(w!)!.getBoundingClientRect();
      const el = document.querySelector(`${w} ${s}`)!;
      const b = el.getBoundingClientRect();
      return { left: b.left >= box.left - 1, right: b.right <= box.right + 1, scroll: el.scrollWidth <= (el as HTMLElement).clientWidth + 1 };
    },
    [win, selector],
  );
  expect(r).toEqual({ left: true, right: true, scroll: true });
}

test.describe("D#600 CX-9b: the near-limit banner on the run (mocked API)", () => {
  test("a run at 75%: a status message names the percent; Dismiss removes it and nothing else; axe is clean; it fits the window", async ({ page }) => {
    const errors = await runsSetup(page, CTX.live75, "running");
    const banner = page.locator(`${RUNS_WIN} [data-testid="runs-ctx-banner"]`);
    await expect(banner).toBeVisible();
    const text = banner.locator('[data-testid="runs-ctx-banner-text"]');
    await expect(text).toHaveAttribute("role", "status");
    await expect(text).toHaveText("This run's context is at 75% of the window.");
    await expect(page.locator(`${RUNS_WIN} [data-testid="runs-ctx-now"]`)).toContainText("150,000 tokens of a 200,000-token window (75%)");
    await insideWindow(page, RUNS_WIN, '[data-testid="runs-ctx-banner"]');
    expect(await axeSeriousOrCritical(page, `${RUNS_WIN} [data-testid="runs-ctx-banner"]`)).toEqual([]);
    // The button is a real target on a phone (44 px), reachable by keyboard.
    const dismiss = banner.locator('[data-testid="runs-ctx-banner-dismiss"]');
    const box = (await dismiss.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(isPhone() ? 40 : 20);
    await dismiss.focus();
    await page.keyboard.press("Enter");
    await expect(banner).toHaveCount(0);
    // Only the banner went: the Context section still has its figure.
    await expect(page.locator(`${RUNS_WIN} [data-testid="runs-ctx-now"]`)).toContainText("(75%)");
    expect(errors).toEqual([]);
  });

  test("an ended run that reached 71% says so in past tense", async ({ page }) => {
    await runsSetup(page, CTX.ended71, "succeeded");
    await expect(page.locator(`${RUNS_WIN} [data-testid="runs-ctx-banner-text"]`)).toHaveText("This run's context was at 71% of the window when it ended.");
    await expect(page.locator(`${RUNS_WIN} [data-testid="runs-ctx-facts"]`)).toContainText("Context at the end");
  });

  test("window not known for the model: the tokens and the words say so, and there is no banner and no percent", async ({ page }) => {
    await runsSetup(page, CTX.unknown, "succeeded");
    await expect(page.locator(`${RUNS_WIN} [data-testid="runs-ctx-facts"]`)).toContainText("54,000 tokens (window not known for this model)");
    await expect(page.locator(`${RUNS_WIN} [data-testid="runs-ctx-banner"]`)).toHaveCount(0);
    await expect(page.locator(`${RUNS_WIN} [data-testid="runs-context"]`)).not.toContainText(/null|undefined|NaN|%\)/);
  });

  test("a run with no figure yet: no banner, and the section says it is not recorded yet", async ({ page }) => {
    await runsSetup(page, CTX.none, "running");
    await expect(page.locator(`${RUNS_WIN} [data-testid="runs-ctx-now"]`)).toContainText("Not recorded yet.");
    await expect(page.locator(`${RUNS_WIN} [data-testid="runs-ctx-banner"]`)).toHaveCount(0);
  });
});

test.describe("D#600 CX-9b: the context read while a run goes on never replaces the end-of-run read (mocked API)", () => {
  test("a live re-read that answers AFTER the end-of-run read leaves the ended figure: no 'is at 75%' on an ended run", async ({ page }) => {
    let endStream!: (body: string) => void;
    const stream = new Promise<string>((resolve) => (endStream = resolve));
    let releaseLive!: () => void;
    const liveHeld = new Promise<void>((resolve) => (releaseLive = resolve));
    const ended = { ...CTX.ended71, context_last_tokens: 80_000, context_pct: 40 };
    // Request 1 (the first read) and request 2 (the re-read the live event asks for) are the live figure, the second held; request 3 is the read the end asks for.
    const contextFor = async (n: number) => {
      if (n === 1) return CTX.live75;
      if (n === 2) {
        await liveHeld;
        return CTX.live75;
      }
      return ended;
    };
    const errors = await runsSetup(page, CTX.live75, "running", { contextFor, stream });
    await expect(page.locator(`${RUNS_WIN} [data-testid="runs-ctx-banner-text"]`)).toHaveText("This run's context is at 75% of the window.");
    // The re-read is coalesced to one per 5 s, so the first live event after that window asks for one at once.
    await page.waitForTimeout(5300);
    const event = { seq: 999, kind: "agent.output", at: "2026-09-18T12:00:00.000Z", payload: { text: "working" } };
    endStream(`id: 999\nevent: run_event\ndata: ${JSON.stringify(event)}\n\nevent: end\ndata: ${JSON.stringify({ status: "succeeded" })}\n\n`);
    // The end read answers first: the run is over and says what it reached.
    await expect(page.locator(`${RUNS_WIN} [data-testid="runs-ctx-facts"]`)).toContainText("Context at the end80,000 tokens of a 200,000-token window (40%)");
    await expect(page.locator(`${RUNS_WIN} [data-testid="runs-ctx-banner"]`)).toHaveCount(0);
    // Now the stale live answer arrives. It must change nothing.
    releaseLive();
    await page.waitForTimeout(800);
    await expect(page.locator(`${RUNS_WIN} [data-testid="runs-ctx-banner"]`)).toHaveCount(0);
    await expect(page.locator(`${RUNS_WIN} [data-testid="runs-ctx-facts"]`)).toContainText("Context at the end80,000 tokens of a 200,000-token window (40%)");
    await expect(page.locator(`${RUNS_WIN} [data-testid="runs-context"]`)).not.toContainText("Context now");
    expect(errors).toEqual([]);
  });
});

test.describe("D#600 CX-9b: the chip on the item card (mocked API)", () => {
  test("the card of an item whose running run is at 82% carries a 'Context 82%' chip; the others have none; it fits the card and passes axe", async ({ page }) => {
    const errors = await boot(page);
    const second = { ...ITEMS.data[0], id: "55555555-5555-4555-8555-555555555551", issue_number: 8, title: "Second item", context_pct: null };
    const list = { data: [{ ...ITEMS.data[0], context_pct: 82 }, second], next_cursor: null };
    await page.route((u) => u.pathname.startsWith("/api/v1/work-items") || u.pathname === "/api/v1/repos", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/v1/repos") return send(route, 200, REPOS);
      if (url.pathname === "/api/v1/work-items") return send(route, 200, url.searchParams.get("stage") === "needs_human" ? { data: [], next_cursor: null } : list);
      return send(route, 404, { error: { code: "not_found", message: "x", request_id: "r" } });
    });
    await page.goto("/");
    await page.waitForFunction(() => (window as unknown as { currentStep?: string }).currentStep === "DESKTOP", null, { timeout: 30_000 });
    await page.locator('.dock-icon[data-app-id="pipeline"]').click();
    await expect(page.locator(PL_WIN)).toBeVisible();
    await expect(page.locator(`${PL_WIN} [data-testid="pl-card"]`)).toHaveCount(2);
    const chips = page.locator(`${PL_WIN} [data-testid="pl-ctx-chip"]`);
    await expect(chips).toHaveCount(1);
    await expect(chips).toHaveText("Context 82%");
    await expect(page.locator(`${PL_WIN} [data-testid="pl-card"][data-id="${ITEMS.data[0].id}"] [data-testid="pl-ctx-chip"]`)).toHaveCount(1);
    await expect(page.locator(`${PL_WIN} [data-testid="pl-card"][data-id="${second.id}"] [data-testid="pl-ctx-chip"]`)).toHaveCount(0);
    await expect(page.locator(PL_WIN)).not.toContainText(/null|undefined|NaN/);
    // The chip stays inside its card (phone included) and the state is words, not colour.
    const fits = await page.evaluate((id) => {
      const card = document.querySelector(`#windows-container .fulc-window[data-app-id="pipeline"] [data-testid="pl-card"][data-id="${id}"]`)!.getBoundingClientRect();
      const chip = document.querySelector('#windows-container .fulc-window[data-app-id="pipeline"] [data-testid="pl-ctx-chip"]')!.getBoundingClientRect();
      return chip.left >= card.left - 1 && chip.right <= card.right + 1;
    }, ITEMS.data[0].id);
    expect(fits).toBe(true);
    expect(await axeSeriousOrCritical(page, `${PL_WIN} [data-testid="pl-card"][data-id="${ITEMS.data[0].id}"]`)).toEqual([]);
    expect(errors).toEqual([]);
  });
});
