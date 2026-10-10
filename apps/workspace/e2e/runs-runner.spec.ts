// apps/workspace/e2e/runs-runner.spec.ts
//
// D#6 R2b-5b: the Runs detail of a run on the person's own machine: a typed line for each runner event (never "runner event"),
// the usage line in the cost block and the "Ran on your machine" compute row. A sandbox run is unchanged. Mocked replies on the
// contract fixtures, the production CSP and Trusted Types directives. The wording is pinned in test/runner-events.test.mjs.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { MAX_DIFF_FRACTION, isolatedShot, pixelDiff } from "./helpers/pixel";

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

async function setup(page: Page, insight: unknown, events: unknown[], row: Record<string, unknown> = {}, tapless = false) {
  const rid = ((insight as { run?: { id?: string } }).run?.id) ?? ID;
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
    if (p === "/api/v1/runs") return send(route, { data: [{ ...RUN, id: rid, status: "succeeded", ...row }], next_cursor: null });
    if (p.endsWith("/insight")) return send(route, insight);
    if (p.endsWith("/events")) {
      const from = Number(url.searchParams.get("cursor") ?? 0);
      const data = events.filter((e) => (e as { seq: number }).seq > from);
      return send(route, { data, next_cursor: data.length ? String((data[data.length - 1] as { seq: number }).seq) : String(from) });
    }
    return send(route, { ...RUN, id: rid, status: "succeeded", ...row });
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
  // A tap leaves the browser's own tap highlight on the row, which fades on its own clock and can land on a shot taken soon after; the pixel check opens the run by click.
  if (test.info().project.name === "phone" && !tapless) await tid(page, "runs-row").first().tap();
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

// ── D#6 C42-4: every state of a runner run, from the bodies the real routes produced (the pinned contract fixtures) ──────────────────
const STATES = readdirSync(join(V1, "getRunInsight")).filter((f) => f.startsWith("200-runner-")).map((f) => f.slice(4, -5));
const insightOf = (name: string) => readFixture("getRunInsight", `200-${name}.json`);
const COST: Record<string, [string, string | RegExp]> = {
  "runner-succeeded-with-pr": ["On your Claude plan · API-equivalent $0.01 · 1,000 in / 200 out tokens", "Estimate, priced at this run's model"],
  "runner-usage-not-priced": ["On your Claude plan · no API price for this model · 500 in / 100 out tokens", /not the same as \$0/],
  "runner-usage-not-recorded": ["Not recorded", /not the same as \$0/],
  "runner-running-activity": ["Counting…", ""],
  "runner-waiting": ["Counting…", ""],
};
const BAD_TEXT = /(^|[^A-Za-z])(null|undefined|NaN)([^A-Za-z]|$)/;

async function noOverflow(page: Page) {
  const bad = await tid(page, "runs-detail").evaluate((el) => {
    const r = el.getBoundingClientRect().right;
    return [...el.querySelectorAll("*")].filter((n) => !n.closest("[hidden]") && n.getBoundingClientRect().width > 0 && n.getBoundingClientRect().right > r + 1 && getComputedStyle(n).position !== "fixed").length;
  });
  expect(bad).toBe(0);
}

test.describe("D#6 C42-4: every runner state in the Runs detail (contract fixtures)", () => {
  for (const name of STATES) {
    test(name, async ({ page }) => {
      const insight = insightOf(name);
      const live = insight.run.status === "pending" || insight.run.status === "running";
      const { errors, tt } = await setup(page, insight, [], { status: insight.run.status, runtime: "runner" });
      await expect(tid(page, "runs-cost-model")).toBeVisible();
      // cost: the usage state and its sentence, never a bare $0
      const want = COST[name];
      if (want) {
        await expect(tid(page, "runs-cost-model")).toContainText(want[0]);
        if (want[1] instanceof RegExp) await expect(tid(page, "runs-cost-model")).toContainText(want[1]);
      }
      expect(await tid(page, "runs-cost-model").innerText()).not.toMatch(/\$0(\.00)?(?![\d.])/);
      // the head says whose plan, not "$0.00"
      await expect(tid(page, "runs-head-usd")).toHaveText("Your plan");
      // activity: the server's lines, in order, plus the lost-runner line
      const lines = (insight.lines as Array<{ text: string }>).map((l) => l.text);
      if (insight.failure_reason === "runner_lost") lines.push("Your runner stopped checking in, so this run was ended. Build again to retry.");
      if (lines.length === 0) {
        await expect(tid(page, "runs-no-activity")).toHaveText(insight.run.status === "running" ? "Your runner has started; nothing recorded yet" : insight.run.status === "pending" ? "Not started yet; nothing recorded yet." : "No activity recorded.");
      } else {
        if (lines.length > 12) await tid(page, "runs-activity-more").locator("summary").click();
        await expect(tid(page, "runs-activity").locator(".runs-act-text").first()).toBeVisible();
        expect(await tid(page, "runs-activity").locator(".runs-act-text").allTextContents()).toEqual(lines);
      }
      // wait, check-in and the hint belong to the live states
      if (insight.run.status === "pending" && insight.wait) {
        await expect(tid(page, "runs-wait")).toHaveText(insight.wait.text);
        await expect(tid(page, "runs-wait")).toHaveAttribute("data-reason", insight.wait.reason);
      } else await expect(tid(page, "runs-wait")).toHaveCount(0);
      if (insight.run.status === "running" && insight.runner_checked_in_at) await expect(tid(page, "runs-checkin")).toHaveText(/^Runner last checked in \d\d:\d\d:\d\d UTC$/);
      else await expect(tid(page, "runs-checkin")).toHaveCount(0);
      if (live) await expect(tid(page, "runs-attach-hint")).toHaveText("You can also watch this run on the runner machine with fx-runner attach.");
      else await expect(tid(page, "runs-attach-hint")).toHaveCount(0);
      // facts
      await tid(page, "runs-facts").locator("summary").click();
      await expect(tid(page, "runs-facts")).toContainText("Runs onYour runner");
      if (insight.runner_checked_in_at) await expect(tid(page, "runs-facts")).toContainText(/Runner last checked in\d\d:\d\d:\d\d UTC/);
      // no hole anywhere on the screen
      expect(await tid(page, "runs-detail").innerText()).not.toMatch(BAD_TEXT);
      await noOverflow(page);
      expect(await tt()).toEqual([]);
      expect(errors).toEqual([]);
    });
  }

  test("a command is drawn as literal text, never as an element", async ({ page }) => {
    const insight = insightOf("runner-running-activity");
    const hostile = "Ran: <img src=x onerror=alert(1)>";
    await setup(page, { ...insight, lines: [...insight.lines, { at: at(30), text: hostile }] }, [ev(1, { type: "tool_use", activity: { tool: "command", command: "<img src=x onerror=alert(1)>" } })], { status: "running", runtime: "runner" });
    await expect(tid(page, "runs-activity").locator(".runs-act-text").last()).toHaveText(hostile);
    await expect(tid(page, "run-event-text").first()).toHaveText(hostile);
    await expect(tid(page, "runs-detail").locator("img")).toHaveCount(0);
  });
});

// ── the pixel check: the Activity section of a runner run against a sandbox run with the same lines ──────────────────────────────────────
// A contract fixture body: the shape is the API's, read by the assertions below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;
const sandboxTwin = (insight: Body) => {
  const { runner_usage, runner_usage_state, runner_usage_note, runner_checked_in_at, wait, ...rest } = insight;
  void runner_usage; void runner_usage_state; void runner_usage_note; void runner_checked_in_at; void wait;
  return { ...rest, run: { ...insight.run, runtime: "production", execution_mode: null } };
};

test.describe("D#6 C42-4: pixel check, runner run against sandbox run (Activity section, same lines)", () => {
  for (const name of ["runner-running-activity", "runner-succeeded-with-pr", "runner-capped", "runner-failed-agent-failed"]) {
    test(name, async ({ page }, info) => {
      const insight = insightOf(name);
      // Each shot is taken on a page of its own, so nothing one run left on the screen (a pointer, a scroll) reaches the next.
      const shotOf = async (body: unknown, row: Record<string, unknown>) => {
        const own = await page.context().newPage();
        try {
          await setup(own, body, [], row, true);
          await expect(tid(own, "runs-activity")).toBeVisible();
          if (name === "runner-capped") await tid(own, "runs-activity").locator("summary").click();
          return await isolatedShot(own, tid(own, "runs-activity"));
        } finally {
          await own.close();
        }
      };
      const runnerShot = await shotOf(insight, { status: insight.run.status, runtime: "runner" });
      const sandboxShot = await shotOf(sandboxTwin(insight), { status: insight.run.status, runtime: "production" });
      // control: the same sandbox run with one line's text changed must differ, or this check could not fail
      const changed = sandboxTwin(insight) as Body;
      changed.lines = changed.lines.map((l: { at: string; text: string }, i: number) => (i === changed.lines.length - 1 ? { ...l, text: l.text + " (changed)" } : l));
      const controlShot = await shotOf(changed, { status: insight.run.status, runtime: "production" });
      const same = await pixelDiff(page, runnerShot, sandboxShot);
      const control = await pixelDiff(page, controlShot, sandboxShot);
      const line = `${info.project.name} ${name}: runner vs sandbox ${same.differing}/${same.total} px differ (sizes ${same.sizes.join("x")}); control ${control.differing}/${control.total} px differ`;
      console.log("PIXELDIFF " + line);
      info.annotations.push({ type: "pixel-diff", description: line });
      expect(same.sameSize).toBe(true);
      expect(same.differing / same.total).toBeLessThanOrEqual(MAX_DIFF_FRACTION);
      expect(control.differing).toBeGreaterThan(0);
      expect(control.differing).toBeGreaterThan(same.differing);
    });
  }
});
