// apps/workspace/e2e/pipeline-insight.spec.ts
//
// D#483 P4: the Pipeline detail's "What's happening" section, on mocked replies from the repo's contract fixtures
// (packages/api/fixtures/v1/getWorkItemActivity). The built cloud dist is served by fixture-server.mjs and booted
// under the page clock, so the 10 s refresh is driven with page.clock.runFor(). The document carries the production
// CSP and Trusted Types directives. Every test runs on desktop, phone and tablet.
//
// The logic half (rounds, phases, banner wording, redraw rules) is in test/pipeline-insight.test.mjs; this file covers
// what needs a real DOM: collapsing, what survives a refresh, hostile model text, and that nothing overflows.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const V1 = join(SCRIPT_DIR, "..", "..", "..", "packages", "api", "fixtures", "v1");
const fx = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const LIST = fx("listWorkItems", "200-page.json");
const REPOS = fx("listRepos", "200-page.json");
const TIMELINE = fx("getWorkItemTimeline", "200-ok.json");
const OK = fx("getWorkItemActivity", "200-ok.json");
const REVIEW_PASSED = fx("getWorkItemActivity", "200-review-passed.json");
const EMPTY = fx("getWorkItemActivity", "200-empty.json");
const NOT_FEASIBLE = fx("getWorkItemActivity", "200-not-feasible.json");
const NEEDS_HUMAN = fx("getWorkItemActivity", "200-needs-human.json");
const CHECK_FAILED = fx("getWorkItemActivity", "200-check-failed.json");
const WORK_RUNS = fx("listRuns", "200-work-item.json");

const ITEM = LIST.data[0].id as string;
const SERVER_TEXT = "server text that must never be shown";
const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const WIN = `#windows-container .fulc-window[data-app-id="pipeline"]`;
const tid = (page: Page, id: string) => page.locator(`${WIN} [data-testid="${id}"]`);
const run = (page: Page, i: number) => tid(page, "pl-ins-run").nth(i);

interface Mock {
  requests: string[];
  stage: string;
  activity: { status: number; json: unknown };
  /** The runs the Runs section reads (empty: nothing is running). */
  runs: unknown;
  /** Every approve request: the path and whether it carried a body. */
  approvals: { path: string; body: string | null }[];
}

async function mockApi(page: Page, initial: { status: number; json: unknown }, stage = "pr_opened"): Promise<Mock> {
  const mock: Mock = { requests: [], stage, activity: initial, runs: { data: [], next_cursor: null }, approvals: [] };
  const send = (route: Route, status: number, json: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(json) });
  await page.route((u) => u.pathname.startsWith("/api/v1/") && u.pathname !== "/api/v1/events", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    mock.requests.push(`${route.request().method()} ${p}`);
    if (route.request().method() === "POST" && p.endsWith("/approve")) {
      mock.approvals.push({ path: p, body: route.request().postData() });
      return send(route, 202, { action_id: "77777777-7777-4777-8777-777777777777", state: "accepted" });
    }
    if (p.startsWith("/api/v1/run-actions/")) return send(route, 200, { action_id: "77777777-7777-4777-8777-777777777777", kind: "advance_work_item", target_id: ITEM, state: "done", outcome: null, error_code: null, created_at: "2026-10-03T10:00:00.000Z", finished_at: "2026-10-03T10:00:01.000Z" });
    if (p === "/api/v1/work-items") return send(route, 200, { data: [{ ...LIST.data[0], stage: mock.stage }], next_cursor: null });
    if (p === "/api/v1/repos") return send(route, 200, REPOS);
    if (p.endsWith("/timeline")) return send(route, 200, TIMELINE);
    if (p.endsWith("/activity")) return send(route, mock.activity.status, mock.activity.json);
    if (p === "/api/v1/runs") return send(route, 200, mock.runs);
    return send(route, 404, { error: { code: "not_found", message: SERVER_TEXT, request_id: "req_1" } });
  });
  await page.route("**/api/v1/events", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", headers: { "cache-control": "no-store" }, body: "event: idle\ndata: {}\n\n" }));
  return mock;
}

async function setup(page: Page, initial: { status: number; json: unknown }, stage?: string) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    (window as unknown as { __tt: string[] }).__tt = [];
    document.addEventListener("securitypolicyviolation", (e) => (window as unknown as { __tt: string[] }).__tt.push(e.violatedDirective));
  });
  const mock = await mockApi(page, initial, stage);
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
  return { errors, mock };
}

async function press(page: Page, locator: ReturnType<Page["locator"]>) {
  if (test.info().project.name === "phone") await locator.tap();
  else await locator.click();
}

async function openDetail(page: Page) {
  await press(page, tid(page, "pl-card").first());
  await expect(tid(page, "pl-live")).toBeVisible();
}

/** No horizontal overflow in the detail, and nothing inside it sticks out past the detail's right edge. */
async function expectNoOverflow(page: Page) {
  const r = await tid(page, "pl-detail").evaluate((el) => {
    const box = el as HTMLElement;
    const right = box.getBoundingClientRect().right;
    const wide = [...box.querySelectorAll("*")].filter((n) => n.getBoundingClientRect().width > 0 && n.getBoundingClientRect().right > right + 1).map((n) => n.tagName + "." + (n as HTMLElement).className);
    return { scrollW: box.scrollWidth, clientW: box.clientWidth, wide };
  });
  expect(r.scrollW).toBeLessThanOrEqual(r.clientW + 1);
  expect(r.wide).toEqual([]);
}

test.describe("D#483 P4: what the pipeline is doing (mocked API)", () => {
  test("every agent run is listed oldest first under its phase; running is open, finished is closed; one activity request on open", async ({ page }) => {
    const { errors, mock } = await setup(page, { status: 200, json: OK });
    await openDetail(page);
    await expect(tid(page, "pl-ins-run")).toHaveCount(6);
    const phases = await tid(page, "pl-ins-run").evaluateAll((els) => els.map((e) => e.getAttribute("data-phase")));
    expect(phases).toEqual(["Triage & Spec", "Panel", "Panel", "Panel", "Build", "Review"]);
    const open = await tid(page, "pl-ins-run").evaluateAll((els) => els.map((e) => (e as HTMLDetailsElement).open));
    expect(open).toEqual([false, false, false, false, false, true]);
    await expect(run(page, 5)).toContainText("Code reviewer (running)");
    await expect(run(page, 5)).toContainText("Ran: git diff origin/main --stat");
    await expect(tid(page, "pl-running")).toHaveText("Running now: Code reviewer");
    await expect(tid(page, "pl-totals")).toHaveText("5 agent runs finished · $1.97 so far");
    // The executor's summary is at the top of its run.
    await press(page, run(page, 4).locator("summary"));
    await expect(run(page, 4).locator('[data-testid="pl-ins-run-summary"]')).toContainText("Added the activity route and the panel. Tests pass.");
    await expect(run(page, 4)).toContainText("Ran tests: pnpm vitest run");
    expect(mock.requests.filter((r) => r.endsWith("/activity"))).toEqual([`GET /api/v1/work-items/${ITEM}/activity`]);
    expect(errors).toEqual([]);
  });

  test("the panel discussion is grouped by round with one collapsible row per role; the Spec is collapsible", async ({ page }) => {
    await setup(page, { status: 200, json: OK });
    await openDetail(page);
    const panel = tid(page, "pl-panel");
    await expect(panel).toContainText("Panel discussion · 5 comments");
    expect(await panel.evaluate((e) => (e as HTMLDetailsElement).open)).toBe(false);
    await press(page, panel.locator("summary").first());
    await expect(tid(page, "pl-round")).toHaveCount(2);
    await expect(tid(page, "pl-round").nth(0).locator("h4")).toHaveText("Round 1 (3)");
    await expect(tid(page, "pl-round").nth(1).locator("h4")).toHaveText("Challenge round (2)");
    const first = tid(page, "pl-comment").first();
    await expect(first.locator("summary")).toContainText("Technical architect — Round 1. The change fits the existing route layer.");
    expect(await first.evaluate((e) => (e as HTMLDetailsElement).open)).toBe(false);
    await press(page, first.locator("summary"));
    await expect(first).toContainText("No new table is needed.");
    // The multi-line body keeps its line break.
    expect(await first.locator("pre").evaluate((e) => getComputedStyle(e).whiteSpace)).toBe("pre-wrap");
    const spec = tid(page, "pl-spec");
    await expect(spec.locator("summary")).toContainText("Spec · version 2");
    expect(await spec.evaluate((e) => (e as HTMLDetailsElement).open)).toBe(false);
    await press(page, spec.locator("summary"));
    await expect(spec).toContainText("The detail panel lists every agent run.");
    await press(page, spec.locator("summary"));
    expect(await spec.evaluate((e) => (e as HTMLDetailsElement).open)).toBe(false);
  });

  test("what was opened or closed survives the periodic refresh, new activity appears, and a quiet refresh changes nothing", async ({ page }) => {
    const { mock } = await setup(page, { status: 200, json: OK });
    await openDetail(page);
    await press(page, tid(page, "pl-panel").locator("summary").first());
    await press(page, tid(page, "pl-spec").locator("summary"));
    await press(page, run(page, 4).locator("summary")); // open the executor's finished run
    await press(page, run(page, 5).locator("summary")); // close the running review
    const sig = async () =>
      page.evaluate(() => ({
        panel: (document.querySelector('[data-testid="pl-panel"]') as HTMLDetailsElement).open,
        spec: (document.querySelector('[data-testid="pl-spec"]') as HTMLDetailsElement).open,
        runs: [...document.querySelectorAll('[data-testid="pl-ins-run"]')].map((e) => (e as HTMLDetailsElement).open),
      }));
    const chosen = { panel: true, spec: true, runs: [false, false, false, false, true, false] };
    expect(await sig()).toEqual(chosen);
    const before = mock.requests.filter((r) => r.endsWith("/activity")).length;
    // A refresh with the same answer: no redraw, so the DOM node is the very same one.
    await page.evaluate(() => ((window as unknown as { __run0: Element }).__run0 = document.querySelector('[data-testid="pl-ins-run"]')!));
    await page.clock.runFor(10_000);
    await expect.poll(() => mock.requests.filter((r) => r.endsWith("/activity")).length).toBe(before + 1);
    expect(await page.evaluate(() => (window as unknown as { __run0: Element }).__run0.isConnected)).toBe(true);
    // A refresh with news: the reviewer wrote another line, and a new run started.
    const next = structuredClone(OK);
    next.runs[5].lines.push({ at: "2026-10-03T10:02:00.000Z", text: "Reading packages/core/src/work-items/activity.ts" });
    next.runs.push({ ...next.runs[4], id: "66666666-6666-4666-8666-000000000099", role: "security-reviewer", status: "running", summary: null, lines: [] });
    mock.activity = { status: 200, json: next };
    await page.clock.runFor(10_000);
    await expect(tid(page, "pl-ins-run")).toHaveCount(7);
    expect(await sig()).toEqual({ panel: true, spec: true, runs: [false, false, false, false, true, false, true] });
    await press(page, run(page, 5).locator("summary"));
    await expect(run(page, 5)).toContainText("Reading packages/core/src/work-items/activity.ts");
  });

  test("a finished run stays on the list: a run that ends moves to finished and collapses, it does not disappear", async ({ page }) => {
    const { mock } = await setup(page, { status: 200, json: OK });
    await openDetail(page);
    const done = structuredClone(OK);
    done.runs[5].status = "succeeded";
    done.runs[5].usd = 0.3;
    mock.activity = { status: 200, json: done };
    await page.clock.runFor(10_000);
    await expect(run(page, 5)).toContainText("Code reviewer (finished)");
    await expect(tid(page, "pl-ins-run")).toHaveCount(6);
    expect(await run(page, 5).evaluate((e) => (e as HTMLDetailsElement).open)).toBe(false);
    await expect(tid(page, "pl-running")).toHaveText("Nothing is running right now.");
    await expect(tid(page, "pl-totals")).toHaveText("6 agent runs finished · $2.27 so far");
  });

  test("Ready to merge shows only at review passed, with the repo's real auto-merge state and a link to the pull request", async ({ page }) => {
    const { mock } = await setup(page, { status: 200, json: REVIEW_PASSED }, "review_passed");
    await openDetail(page);
    const banner = tid(page, "pl-ready");
    await expect(banner).toContainText("Ready to merge.");
    await expect(tid(page, "pl-ready-merge")).toHaveAttribute("data-auto-merge", "on");
    await expect(banner).toContainText("Auto-merge is on for this repo");
    const link = tid(page, "pl-ready-link");
    await expect(link).toHaveAttribute("href", "https://github.com/acme/docs/pull/57");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await expect(link).toHaveAttribute("target", "_blank");
    // The repo turns auto-merge off: the banner follows the record, not the stage.
    mock.activity = { status: 200, json: { ...REVIEW_PASSED, auto_merge: false } };
    await page.clock.runFor(10_000);
    await expect(tid(page, "pl-ready-merge")).toHaveAttribute("data-auto-merge", "off");
    await expect(banner).toContainText("Auto-merge is off for this repo: a person merges the pull request on GitHub.");
    await expect(banner).not.toContainText("is on");
    // The recorded merge-gate step is shown with its fixed reason codes, in words.
    await expect(tid(page, "pl-step")).toHaveCount(2);
    await expect(tid(page, "pl-step").nth(1)).toContainText("Merge gate: not merged, a person merges");
    await expect(tid(page, "pl-step").nth(1)).toContainText("CI is not green; auto-merge is not allowed");
    // Any other stage: no banner.
    mock.activity = { status: 200, json: { ...REVIEW_PASSED, stage: "merged" } };
    await page.clock.runFor(10_000);
    await expect(banner).toHaveCount(0);
  });

  test("every empty state is a sentence: no runs, no panel, no Spec, no steps; and nothing says null or undefined", async ({ page }) => {
    await setup(page, { status: 200, json: EMPTY }, "triaged");
    await openDetail(page);
    await expect(tid(page, "pl-no-runs")).toHaveText("No agent has run on this item yet.");
    await expect(tid(page, "pl-no-panel")).toHaveText("No panel discussion yet.");
    await expect(tid(page, "pl-no-spec")).toHaveText("No Spec yet.");
    await expect(tid(page, "pl-running")).toHaveText("Nothing is running right now.");
    await expect(tid(page, "pl-steps")).toHaveCount(0);
    await expect(tid(page, "pl-ready")).toHaveCount(0);
    expect(await tid(page, "pl-live").innerText()).not.toMatch(/null|undefined|NaN/);
  });

  test("a failed read is one fixed sentence (never the server's text), a failed refresh keeps the last answer", async ({ page }) => {
    const { mock } = await setup(page, { status: 500, json: { error: { code: "internal", message: SERVER_TEXT, request_id: "r" } } });
    await openDetail(page);
    await expect(tid(page, "pl-live-state")).toHaveText("What the pipeline is doing isn't available right now.");
    await expect(page.locator(WIN)).not.toContainText(SERVER_TEXT);
    mock.activity = { status: 200, json: OK };
    await page.clock.runFor(10_000);
    await expect(tid(page, "pl-ins-run")).toHaveCount(6);
    mock.activity = { status: 500, json: { error: { code: "internal", message: SERVER_TEXT, request_id: "r" } } };
    await page.clock.runFor(10_000);
    await expect(tid(page, "pl-live-state")).toHaveText("Couldn't refresh just now. Showing the last update.");
    await expect(tid(page, "pl-ins-run")).toHaveCount(6);
    await expect(page.locator(WIN)).not.toContainText(SERVER_TEXT);
  });

  test("model text is only text: markup in a comment, the Spec, a summary and an activity line is shown literally and runs nothing", async ({ page }) => {
    const payload = '<img src=x onerror="window.__pwn=1"><script>window.__pwn=1</script><a href="javascript:window.__pwn=1">x</a>';
    const hostile = structuredClone(OK);
    hostile.comments[0].body = payload;
    hostile.spec.body = payload;
    hostile.runs[4].summary = payload;
    hostile.runs[5].lines[0].text = payload;
    const { errors } = await setup(page, { status: 200, json: hostile });
    await openDetail(page);
    await press(page, tid(page, "pl-panel").locator("summary").first());
    await press(page, tid(page, "pl-comment").first().locator("summary"));
    await press(page, tid(page, "pl-spec").locator("summary"));
    await press(page, run(page, 4).locator("summary"));
    expect(await tid(page, "pl-live").locator("img, script, iframe, object, embed").count()).toBe(0);
    expect(await tid(page, "pl-live").locator("a").count()).toBe(0);
    await expect(tid(page, "pl-comment").first().locator("pre")).toHaveText(payload);
    await expect(tid(page, "pl-spec").locator("pre")).toHaveText(payload);
    await expect(run(page, 4).locator('[data-testid="pl-ins-run-summary"] pre')).toHaveText(payload);
    await expect(run(page, 5).locator("li").first()).toHaveText(payload);
    expect(await page.evaluate(() => (window as unknown as { __pwn?: number }).__pwn)).toBeUndefined();
    expect(await page.evaluate(() => (window as unknown as { __tt: string[] }).__tt)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("long text never widens the panel: an unbroken Spec, comment, summary and command line wrap inside the window", async ({ page }) => {
    const unbroken = "W".repeat(5000);
    const longCommand = "Ran: " + "pnpm-".repeat(40);
    const wide = structuredClone(OK);
    wide.comments[0].body = unbroken + "\n" + "words ".repeat(400);
    wide.spec.body = unbroken;
    wide.runs[4].summary = unbroken;
    wide.runs[5].lines.push({ at: "2026-10-03T10:03:00.000Z", text: longCommand });
    wide.runs[5].lines.push({ at: "2026-10-03T10:04:00.000Z", text: "Reading " + "d/".repeat(45) + "file.ts" });
    wide.runs_truncated = true;
    wide.comments_truncated = true;
    await setup(page, { status: 200, json: wide });
    await openDetail(page);
    await press(page, tid(page, "pl-panel").locator("summary").first());
    await press(page, tid(page, "pl-comment").first().locator("summary"));
    await press(page, tid(page, "pl-spec").locator("summary"));
    await press(page, run(page, 4).locator("summary"));
    await expect(tid(page, "pl-spec").locator("pre")).toBeVisible();
    await expectNoOverflow(page);
    // The one-line preview of a long first line is cut, not wrapped across the page.
    const preview = await tid(page, "pl-comment").first().locator("summary").innerText();
    expect(preview.length).toBeLessThan(160);
    await expect(page.locator(WIN)).toContainText("Older runs aren't shown.");
    await expect(page.locator(WIN)).toContainText("Older comments aren't shown.");
  });

  test("the layout holds on every viewport: summaries are touch-sized and the page does not scroll sideways", async ({ page }) => {
    await setup(page, { status: 200, json: OK });
    await openDetail(page);
    const heights = await tid(page, "pl-live").locator("summary").evaluateAll((els) => els.map((e) => (e as HTMLElement).offsetHeight));
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
    await expectNoOverflow(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test("a long detail scrolls: the last History row and the end of the Spec can be reached and seen", async ({ page }) => {
    const longSpec = Array.from({ length: 120 }, (_, i) => `Spec line ${i + 1}`).join("\n") + "\nSPEC-END-MARKER";
    const long = structuredClone(OK);
    long.spec.body = longSpec;
    for (let i = 0; i < 6; i++) long.runs.push({ ...long.runs[4], id: `66666666-6666-4666-8666-0000000001${i}0`, summary: "Extra run " + i, lines: [] });
    const transitions = Array.from({ length: 7 }, (_, i) => ({
      from_stage: "triaged", to_stage: i === 6 ? "merged" : "discussing", reviewer: null, at: `2026-09-01T0${i}:00:00.000Z`, source: "control_plane", run_id: null,
    }));
    await setup(page, { status: 200, json: long });
    // Registered after setup's own routes, so it wins for the timeline.
    await page.route((u) => u.pathname.endsWith("/timeline"), (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...TIMELINE, transitions, truncated: false }) }),
    );
    await openDetail(page);
    await expect(tid(page, "pl-history-row")).toHaveCount(7);
    await press(page, tid(page, "pl-spec").locator("summary"));
    const detail = tid(page, "pl-detail");
    // The detail is its own scroll container, bounded by the window.
    const info = await detail.evaluate((el) => ({ scrolls: el.scrollHeight > el.clientHeight, oy: getComputedStyle(el).overflowY }));
    expect(info.scrolls).toBe(true);
    expect(info.oy).toMatch(/auto|scroll/);
    // Only the fit provides this: the detail is capped to the visible screen below its own top edge.
    const cap = await detail.evaluate((el) => ({ maxHeight: (el as HTMLElement).style.maxHeight, top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom, vh: window.innerHeight }));
    expect(cap.maxHeight).toMatch(/^\d+px$/);
    expect(parseInt(cap.maxHeight, 10)).toBeLessThanOrEqual(cap.vh - Math.floor(cap.top) + 1);
    expect(cap.bottom).toBeLessThanOrEqual(cap.vh + 1);
    // Scroll to the very end, then the last History row must sit fully inside both the detail and the viewport.
    await detail.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const last = tid(page, "pl-history-row").last();
    await expect(last).toBeInViewport({ ratio: 1 });
    const box = await last.evaluate((el) => {
      const d = (el.closest('[data-testid="pl-detail"]') as HTMLElement).getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { insideDetail: r.top >= d.top - 1 && r.bottom <= d.bottom + 1, viewportBottom: window.innerHeight, rowBottom: r.bottom, detailBottom: d.bottom };
    });
    expect(box.insideDetail).toBe(true);
    expect(box.detailBottom).toBeLessThanOrEqual(box.viewportBottom + 1);
    // The end of the Spec, scrolled to inside the detail, is reachable too, and the page never scrolls sideways.
    await tid(page, "pl-spec").locator("pre").evaluate((el) => el.scrollIntoView({ block: "end" }));
    await expect(tid(page, "pl-spec").locator("pre")).toContainText("SPEC-END-MARKER");
    const specEnd = await tid(page, "pl-spec").locator("pre").evaluate((el) => {
      const d = (el.closest('[data-testid="pl-detail"]') as HTMLElement).getBoundingClientRect();
      return el.getBoundingClientRect().bottom <= d.bottom + 1;
    });
    expect(specEnd).toBe(true);
    await expectNoOverflow(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test("a window taller than the visible screen (browser bars, keyboard) still lets the whole detail be reached", async ({ page }) => {
    const long = structuredClone(OK);
    long.spec.body = Array.from({ length: 120 }, (_, i) => `Spec line ${i + 1}`).join("\n") + "\nSPEC-END-MARKER";
    const transitions = Array.from({ length: 7 }, (_, i) => ({
      from_stage: "triaged", to_stage: i === 6 ? "merged" : "discussing", reviewer: null, at: `2026-09-01T0${i}:00:00.000Z`, source: "control_plane", run_id: null,
    }));
    await setup(page, { status: 200, json: long });
    await page.route((u) => u.pathname.endsWith("/timeline"), (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...TIMELINE, transitions, truncated: false }) }),
    );
    await openDetail(page);
    await expect(tid(page, "pl-history-row")).toHaveCount(7);
    // Make the window 400px taller than the screen, as a phone's dynamic toolbars do, and tell the app the viewport changed.
    await page.evaluate((extra) => {
      const w = document.querySelector('#windows-container .fulc-window[data-app-id="pipeline"]') as HTMLElement;
      w.style.height = window.innerHeight + extra + "px";
      window.dispatchEvent(new Event("resize"));
    }, 400);
    const detail = tid(page, "pl-detail");
    await detail.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const last = tid(page, "pl-history-row").last();
    await expect(last).toBeInViewport({ ratio: 1 });
    const r = await detail.evaluate((el) => ({ bottom: el.getBoundingClientRect().bottom, vh: window.innerHeight }));
    expect(r.bottom).toBeLessThanOrEqual(r.vh + 1);
  });

  test("a refresh with changed data keeps the scroll position and the focus while a running run's activity grows", async ({ page }) => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => ({ at: `2026-10-03T10:${String(i % 60).padStart(2, "0")}:00.000Z`, text: `Reading src/file-${i}.ts` }));
    const base = structuredClone(OK);
    base.runs[5].lines = lines(40);
    const { mock } = await setup(page, { status: 200, json: base });
    await openDetail(page);
    const running = run(page, 5);
    expect(await running.evaluate((e) => (e as HTMLDetailsElement).open)).toBe(true);
    const detail = tid(page, "pl-detail");
    await running.locator("summary").focus();
    // Model a layout pass between the old content leaving and the new content arriving, which is when a browser clamps
    // the scroll of every scrolled ancestor: the section's children are cleared, layout is forced, then refilled.
    await tid(page, "pl-live").evaluate((el) => {
      const original = el.replaceChildren.bind(el);
      el.replaceChildren = (...nodes: (Node | string)[]) => {
        original();
        void (el as HTMLElement).offsetHeight;
        original(...nodes);
      };
    });
    // Scrolled to the very end, so that clamping is certain to move it.
    await detail.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const before = await detail.evaluate((el) => el.scrollTop);
    expect(before).toBeGreaterThan(100);
    const key = await running.getAttribute("data-key");
    expect(key).not.toBeNull();
    const requests = () => mock.requests.filter((r) => r.endsWith("/activity")).length;
    for (let tick = 1; tick <= 3; tick++) {
      const n = requests();
      const next = structuredClone(OK);
      next.runs[5].lines = lines(40 + tick * 5); // the running run keeps writing, so the data differs on every tick
      mock.activity = { status: 200, json: next };
      await page.clock.runFor(10_000);
      await expect.poll(requests).toBe(n + 1);
      await expect(running.locator("li").last()).toHaveText(`Reading src/file-${39 + tick * 5}.ts`);
      const after = await detail.evaluate((el) => el.scrollTop);
      expect(Math.abs(after - before)).toBeLessThanOrEqual(4);
      const focusKey = await page.evaluate(() => (document.activeElement?.closest("details[data-key]") as HTMLElement | null)?.getAttribute("data-key") ?? null);
      expect(focusKey).toBe(key);
    }
    // An unchanged answer is not redrawn at all.
    await page.evaluate(() => ((window as unknown as { __n: Element }).__n = document.querySelector('[data-testid="pl-ins-run"]')!));
    const n = requests();
    await page.clock.runFor(10_000);
    await expect.poll(requests).toBe(n + 1);
    expect(await page.evaluate(() => (window as unknown as { __n: Element }).__n.isConnected)).toBe(true);
    expect(Math.abs((await detail.evaluate((el) => el.scrollTop)) - before)).toBeLessThanOrEqual(4);
  });

  test("closing the detail stops the refresh: no activity request after Back", async ({ page }) => {
    const { mock } = await setup(page, { status: 200, json: OK });
    await openDetail(page);
    await press(page, tid(page, "pl-back"));
    await expect(tid(page, "pl-detail")).toBeHidden();
    const n = mock.requests.filter((r) => r.endsWith("/activity")).length;
    await page.clock.runFor(35_000);
    expect(mock.requests.filter((r) => r.endsWith("/activity")).length).toBe(n);
  });

  test("the panel's source has no HTML sink and makes no direct network call", async () => {
    const code = readFileSync(join(SCRIPT_DIR, "..", "apps", "pipeline", "pipeline-insight.js"), "utf8");
    expect(code).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
    expect(code).not.toMatch(/fetch\(/);
  });
});

// Behaviours the owner approved on live staging (D#483) and the permanent driver had not carried over.
test.describe("D#483 live parity: the notice, Check the build, the board's polling fallback and the pull request link", () => {
  test("the notice banner: the project manager's reason when a request can't be built as written, shown as text", async ({ page }) => {
    const { errors } = await setup(page, { status: 200, json: NOT_FEASIBLE }, "triaged");
    await openDetail(page);
    const banner = tid(page, "pl-not-feasible");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Stopped before building.");
    await expect(banner).toContainText("The project manager says this can't be built as written:");
    await expect(banner).toContainText("Edit the issue on GitHub and approve again, or close it.");
    // The reason is model text with markup in it: its characters are shown, no element was made from them.
    await expect(tid(page, "pl-notice-reason")).toHaveText(NOT_FEASIBLE.notice.reason);
    expect(await banner.locator("b, img, script, a").count()).toBe(0);
    await expect(tid(page, "pl-needs-human")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __tt: string[] }).__tt)).toEqual([]);
    expect(errors).toEqual([]);
    await expectNoOverflow(page);
  });

  test("the notice banner: at Needs a person, the executor's own account of a build that ended without a pull request, as text", async ({ page }) => {
    const { mock, errors } = await setup(page, { status: 200, json: NEEDS_HUMAN }, "needs_human");
    await openDetail(page);
    const banner = tid(page, "pl-needs-human");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Needs a person.");
    await expect(banner).toContainText("The build stopped without a pull request. The executor's own account:");
    await expect(banner.locator("pre")).toHaveText(NEEDS_HUMAN.notice.reason);
    expect(await banner.locator("img, script, a").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __pwn?: number }).__pwn)).toBeUndefined();
    await expect(tid(page, "pl-not-feasible")).toHaveCount(0);
    expect(errors).toEqual([]);
    // The notice follows the record: once the server has none, the banner goes.
    mock.activity = { status: 200, json: { ...NEEDS_HUMAN, notice: null } };
    await page.clock.runFor(10_000);
    await expect(banner).toHaveCount(0);
    await expectNoOverflow(page);
  });

  test('the notice banner: when "Check the build" could not decide, the card says so and keeps the button, and the banner goes once the server has none', async ({ page }) => {
    const { mock } = await setup(page, { status: 200, json: CHECK_FAILED }, "in_progress");
    await openDetail(page);
    const banner = tid(page, "pl-check-failed");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Couldn't check the build.");
    await expect(banner).toContainText("Couldn't check the build right now. Try again in a moment.");
    // The stage did not move, so the button to try again is still there.
    await expect(tid(page, "pl-approve-btn")).toHaveText("Check the build");
    mock.activity = { status: 200, json: { ...CHECK_FAILED, notice: null } };
    await page.clock.runFor(10_000);
    await expect(banner).toHaveCount(0);
    await expectNoOverflow(page);
  });

  test("no notice, no banner", async ({ page }) => {
    await setup(page, { status: 200, json: OK });
    await openDetail(page);
    await expect(tid(page, "pl-not-feasible")).toHaveCount(0);
    await expect(tid(page, "pl-needs-human")).toHaveCount(0);
  });

  test('"Check the build": an item at In progress with nothing running offers it, and one click asks the server to approve, with no body', async ({ page }) => {
    const { mock } = await setup(page, { status: 200, json: OK }, "in_progress");
    await openDetail(page);
    const button = tid(page, "pl-approve-btn");
    await expect(button).toHaveText("Check the build");
    await expect(tid(page, "pl-approve-hint")).toContainText("Checks whether the build opened a pull request");
    await press(page, button);
    await expect(tid(page, "pl-approve-note")).toHaveText("Started. The pipeline is checking whether the build opened a pull request, and the card moves when it knows.");
    expect(mock.approvals).toEqual([{ path: `/api/v1/work-items/${ITEM}/approve`, body: null }]);
    await expect(button).toBeDisabled();
  });

  test('"Check the build" is not offered while a run of the item is live, nor at a stage the server does not advance', async ({ page }) => {
    const { mock } = await setup(page, { status: 200, json: OK }, "in_progress");
    mock.runs = WORK_RUNS; // a running run of this item
    await openDetail(page);
    await expect(tid(page, "pl-runs")).toBeVisible();
    await expect(tid(page, "pl-approve-btn")).toHaveCount(0);
    expect(mock.approvals).toEqual([]);
  });

  test("the Ready to merge link opens the real pull request when the issue number and the PR number differ, never the issue", async ({ page }) => {
    expect(REVIEW_PASSED.issue_number).not.toBe(REVIEW_PASSED.pr_number);
    const { mock } = await setup(page, { status: 200, json: REVIEW_PASSED }, "review_passed");
    await openDetail(page);
    const link = tid(page, "pl-ready-link");
    await expect(link).toHaveAttribute("href", `https://github.com/acme/docs/pull/${REVIEW_PASSED.pr_number}`);
    expect(await link.getAttribute("href")).not.toContain(`/pull/${REVIEW_PASSED.issue_number}`);
    // The issue's number leaking into the PR field is not linked as a pull request: the search for the branch is.
    mock.activity = { status: 200, json: { ...REVIEW_PASSED, pr_number: REVIEW_PASSED.issue_number } };
    await page.clock.runFor(10_000);
    await expect(link).toHaveAttribute("href", `https://github.com/acme/docs/pulls?q=is%3Apr+head%3Afx%2Fissue-${REVIEW_PASSED.issue_number}`);
    // No PR number at all: the same search.
    mock.activity = { status: 200, json: { ...REVIEW_PASSED, pr_number: null } };
    await page.clock.runFor(10_000);
    await expect(link).toHaveAttribute("href", `https://github.com/acme/docs/pulls?q=is%3Apr+head%3Afx%2Fissue-${REVIEW_PASSED.issue_number}`);
  });

  test("the board re-reads itself every 20 s while an item is mid-pipeline: with no live event, a stage change on the next read moves the card", async ({ page }) => {
    // The events stream says nothing at all (setup routes it to an idle stream).
    const { mock } = await setup(page, { status: 200, json: OK }, "pr_opened");
    const listReads = () => mock.requests.filter((r) => r === "GET /api/v1/work-items").length;
    await expect(page.locator(`${WIN} [data-testid="pl-col-pr_opened"] [data-testid="pl-card"]`)).toHaveCount(1);
    const before = listReads();
    // Nothing changed: the board is read again but not redrawn (the very same card node stays).
    await page.evaluate(() => ((window as unknown as { __card: Element }).__card = document.querySelector('[data-testid="pl-card"]')!));
    await page.clock.runFor(20_000);
    await expect.poll(listReads).toBe(before + 1);
    expect(await page.evaluate(() => (window as unknown as { __card: Element }).__card.isConnected)).toBe(true);
    // The stage changes on the server and no event says so; the next poll moves the card.
    mock.stage = "needs_human";
    await page.clock.runFor(20_000);
    await expect(page.locator(`${WIN} [data-testid="pl-col-needs_human"] [data-testid="pl-card"]`)).toHaveCount(1);
    await expect(page.locator(`${WIN} [data-testid="pl-col-pr_opened"] [data-testid="pl-card"]`)).toHaveCount(0);
  });

  test("a stage change found by the poll keeps the open detail's scroll position and the folds the reader opened", async ({ page }) => {
    const long = structuredClone(OK);
    long.spec.body = Array.from({ length: 120 }, (_, i) => `Spec line ${i + 1}`).join("\n") + "\nSPEC-END-MARKER";
    const { mock } = await setup(page, { status: 200, json: long }, "pr_opened");
    await openDetail(page);
    await press(page, tid(page, "pl-spec").locator("summary"));
    await press(page, tid(page, "pl-panel").locator("summary").first());
    const detail = tid(page, "pl-detail");
    // Model the layout pass between the old content leaving and the new arriving, when a browser clamps the scroll of the
    // detail and of the board: the children are cleared, layout is forced, then refilled.
    await page.evaluate(() => {
      for (const el of [document.querySelector('[data-testid="pl-detail"]')!, document.querySelector('[data-testid="pl-columns"]')!]) {
        const original = el.replaceChildren.bind(el);
        el.replaceChildren = (...nodes: (Node | string)[]) => {
          original();
          void (el as HTMLElement).offsetHeight;
          original(...nodes);
        };
      }
    });
    await detail.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    expect(await detail.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
    // What the reader is looking at: the last History row, measured against the detail's own top edge.
    const seen = () =>
      page.evaluate(() => {
        const d = document.querySelector('[data-testid="pl-detail"]')!.getBoundingClientRect();
        const rows = document.querySelectorAll('[data-testid="pl-history-row"]');
        return Math.round(rows[rows.length - 1]!.getBoundingClientRect().top - d.top);
      });
    const before = await seen();
    const reads = () => mock.requests.filter((r) => r === "GET /api/v1/work-items").length;
    const n = reads();
    mock.stage = "spec_ready";
    await page.clock.runFor(20_000);
    await expect.poll(reads).toBe(n + 1);
    await expect(page.locator(`${WIN} [data-testid="pl-col-spec_ready"] [data-testid="pl-card"]`)).toHaveCount(1);
    await expect(tid(page, "pl-detail")).toContainText("Spec ready");
    // The redraw added the approve box above the History; the reader's view of the History did not move.
    expect(Math.abs((await seen()) - before)).toBeLessThanOrEqual(4);
    expect(await detail.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
    expect(await tid(page, "pl-spec").evaluate((e) => (e as HTMLDetailsElement).open)).toBe(true);
    expect(await tid(page, "pl-panel").evaluate((e) => (e as HTMLDetailsElement).open)).toBe(true);
  });
});
