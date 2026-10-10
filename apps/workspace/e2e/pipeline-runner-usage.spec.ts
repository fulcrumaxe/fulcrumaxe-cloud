// apps/workspace/e2e/pipeline-runner-usage.spec.ts
//
// D#6 R2b-5b: the Pipeline detail's Runs section shows a run on the person's own machine with its usage line, and the item's
// separate own-plan total. A sandbox run has no usage line. Mocked replies on the contract fixtures; the production CSP.
// The wording is pinned in test/runner-events.test.mjs; this file covers the real DOM.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";
import { MAX_DIFF_FRACTION, isolatedShot, pixelDiff } from "./helpers/pixel";

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

// ── D#6 C42-4: every state of a runner run in the Pipeline run section, from the bodies the real route produced (the pinned contract fixtures) ──
const ACT_STATES = readdirSync(join(V1, "getWorkItemActivity")).filter((f) => f.startsWith("200-runner-")).map((f) => f.slice(4, -5));
const activityOf = (name: string) => fx("getWorkItemActivity", `200-${name}.json`);
// A contract fixture body: the shape is the API's, read by the assertions below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;
const BAD_TEXT = /(^|[^A-Za-z])(null|undefined|NaN)([^A-Za-z]|$)/;

/** Starts the Pipeline with one item whose activity is `activity` and whose Runs list holds that activity's runs. */
async function startState(page: Page, activity: Body, itemOver: Record<string, unknown> = {}, tapless = false) {
  const runs = (activity.runs as Body[]).map((r) => ({ ...base, id: r.id, status: r.status, runtime: r.runtime ?? "production", usd: r.runtime === "runner" ? 0 : r.usd, runner_usage: r.runner_usage ?? null }));
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  const send = (route: Route, status: number, json: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(json) });
  await page.route((u) => u.pathname.startsWith("/api/v1/") && u.pathname !== "/api/v1/events", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === "/api/v1/work-items") return send(route, 200, { data: [{ ...LIST.data[0], stage: "in_progress", ...itemOver }], next_cursor: null });
    if (p === "/api/v1/repos") return send(route, 200, REPOS);
    if (p.endsWith("/timeline")) return send(route, 200, TIMELINE);
    if (p.endsWith("/activity")) return send(route, 200, activity);
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
  if (test.info().project.name === "phone" && !tapless) await tid(page, "pl-card").first().tap();
  else await tid(page, "pl-card").first().click();
  await expect(tid(page, "pl-run")).toHaveCount(runs.length);
  await expect(tid(page, "pl-ins-run")).toHaveCount(runs.length);
  return errors;
}

/** Opens a run section (a finished one starts closed) and returns it. */
async function openRunSection(page: Page) {
  const sec = tid(page, "pl-ins-run").first();
  if ((await sec.getAttribute("open")) === null) await sec.locator("summary").click();
  await expect(sec).toHaveAttribute("open", "");
  return sec;
}

const HEAD_COST: Record<string, string> = {
  "runner-succeeded-with-pr": "≈ $0.01 at API prices · on your plan",
  "runner-usage-not-priced": "usage not priced",
};

test.describe("D#6 C42-4: every runner state in the Pipeline run section (contract fixtures)", () => {
  for (const name of ACT_STATES) {
    test(name, async ({ page }) => {
      const act = activityOf(name);
      const run = act.runs[0];
      const errors = await startState(page, act);
      const sec = await openRunSection(page);
      const live = run.status === "pending" || run.status === "running";
      // the server's lines, in order
      const lines = (run.lines as Array<{ text: string }>).map((l) => l.text);
      if (lines.length) expect(await sec.locator('[data-testid="pl-feed"] li').allTextContents()).toEqual(lines);
      else await expect(sec.locator('[data-testid="pl-run-no-activity"]')).toHaveText(run.status === "running" ? "Your runner has started; nothing recorded yet" : run.status === "pending" ? "Not started yet; nothing recorded yet." : "No activity recorded.");
      // cost: the estimate or the state, never the null spend as $0
      // The summary is set in capitals by the page's style; the words are compared without regard to case.
      const head = (await sec.locator("summary").innerText()).toLowerCase();
      expect(head).not.toMatch(/\$0(\.00)?(?![\d.])/);
      const want = HEAD_COST[name] ?? (run.runner_usage_state === "not_recorded" ? "usage not recorded" : null);
      if (want) expect(head).toContain(want.toLowerCase());
      else expect(head).not.toMatch(/at API prices|usage not/);
      if (run.runner_usage_state === "not_priced" || run.runner_usage_state === "not_recorded") await expect(sec.locator('[data-testid="pl-run-cost-note"]')).toHaveText(run.runner_usage_note);
      else await expect(sec.locator('[data-testid="pl-run-cost-note"]')).toHaveCount(0);
      // wait, check-in and the hint
      if (run.status === "pending" && run.wait) await expect(sec.locator('[data-testid="pl-run-wait"]')).toHaveText(run.wait.text);
      else await expect(sec.locator('[data-testid="pl-run-wait"]')).toHaveCount(0);
      if (run.status === "running" && run.runner_checked_in_at) await expect(sec.locator('[data-testid="pl-run-checkin"]')).toHaveText(/^Runner checked in \d\d:\d\d:\d\d UTC$/);
      else await expect(sec.locator('[data-testid="pl-run-checkin"]')).toHaveCount(0);
      if (live) await expect(sec.locator('[data-testid="pl-run-attach-hint"]')).toHaveText("You can also watch this run on the runner machine with fx-runner attach.");
      else await expect(sec.locator('[data-testid="pl-run-attach-hint"]')).toHaveCount(0);
      // the Runs list row never shows the runner's null spend as $0
      await expect(tid(page, "pl-run").first()).not.toContainText(/\$0(\.00)?(?![\d.])/);
      expect(await tid(page, "pl-ins-run").first().innerText()).not.toMatch(BAD_TEXT);
      expect(await page.locator(WIN).innerText()).not.toMatch(BAD_TEXT);
      expect(errors).toEqual([]);
    });
  }

  test("the item's own-plan line says not recorded and not priced in words, apart from $0", async ({ page }) => {
    const act = activityOf("runner-usage-not-recorded");
    await startState(page, act, { own_plan_api_equivalent_usd: null, own_plan_usage_state: "not_recorded", own_plan_tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 } });
    await expect(tid(page, "pl-own-plan")).toHaveText("On your own plan: usage was not recorded for a finished run. That is not the same as $0.");
  });
  test("not priced shows the tokens", async ({ page }) => {
    await startState(page, activityOf("runner-usage-not-priced"), { own_plan_api_equivalent_usd: null, own_plan_usage_state: "not_priced", own_plan_tokens: { input: 182000, output: 9400, cache_read: 0, cache_write: 0 } });
    await expect(tid(page, "pl-own-plan")).toHaveText("On your own plan: 182,000 in / 9,400 out tokens, with no API price for the model. That is not the same as $0.");
  });
  test("a recorded figure reads as before, and a real zero shows no line", async ({ page }) => {
    await startState(page, activityOf("runner-succeeded-with-pr"), { own_plan_api_equivalent_usd: 3.5, own_plan_usage_state: "recorded", own_plan_tokens: { input: 1, output: 1, cache_read: 0, cache_write: 0 } });
    await expect(tid(page, "pl-own-plan")).toHaveText("On your own plan (API-equivalent): $3.50");
  });
  test("a command in a line is literal text", async ({ page }) => {
    const act = activityOf("runner-running-activity");
    const hostile = "Ran: <img src=x onerror=alert(1)>";
    act.runs[0].lines = [...act.runs[0].lines, { at: "2026-10-03T10:00:09.000Z", text: hostile }];
    await startState(page, act);
    const sec = await openRunSection(page);
    await expect(sec.locator('[data-testid="pl-feed"] li').last()).toHaveText(hostile);
    await expect(sec.locator("img")).toHaveCount(0);
  });
});

// ── the pixel check: the run section's feed of a runner run against a sandbox run with the same lines ───────────────────────────────────
test.describe("D#6 C42-4: pixel check, runner run against sandbox run (Pipeline feed, same lines)", () => {
  for (const name of ["runner-running-activity", "runner-succeeded-with-pr", "runner-failed-agent-failed"]) {
    test(name, async ({ page }, info) => {
      const act = activityOf(name);
      const twin = (over: (l: Array<{ at: string; text: string }>) => Array<{ at: string; text: string }> = (l) => l) => {
        const { runner_usage, runner_usage_state, runner_usage_note, runner_checked_in_at, wait, ...rest } = act.runs[0];
        void runner_usage; void runner_usage_state; void runner_usage_note; void runner_checked_in_at; void wait;
        return { ...act, runs: [{ ...rest, runtime: "production", lines: over(rest.lines) }] };
      };
      const shotOf = async (activity: Body) => {
        const own = await page.context().newPage();
        try {
          await startState(own, activity, {}, true);
          const sec = await openRunSection(own);
          return await isolatedShot(own, sec.locator('[data-testid="pl-feed"]'));
        } finally {
          await own.close();
        }
      };
      const runnerShot = await shotOf(act);
      const sandboxShot = await shotOf(twin());
      const controlShot = await shotOf(twin((l) => l.map((x, i) => (i === l.length - 1 ? { ...x, text: x.text + " (changed)" } : x))));
      const same = await pixelDiff(page, runnerShot, sandboxShot);
      const control = await pixelDiff(page, controlShot, sandboxShot);
      const line = `${info.project.name} pipeline ${name}: runner vs sandbox ${same.differing}/${same.total} px differ (sizes ${same.sizes.join("x")}); control ${control.differing}/${control.total} px differ`;
      console.log("PIXELDIFF " + line);
      info.annotations.push({ type: "pixel-diff", description: line });
      expect(same.sameSize).toBe(true);
      expect(same.differing / same.total).toBeLessThanOrEqual(MAX_DIFF_FRACTION);
      expect(control.differing).toBeGreaterThan(0);
      expect(control.differing).toBeGreaterThan(same.differing);
    });
  }
});
