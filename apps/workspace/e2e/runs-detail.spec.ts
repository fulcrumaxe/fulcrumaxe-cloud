// apps/workspace/e2e/runs-detail.spec.ts
//
// D#483 P5: the Runs detail's outcome, cost, activity and run facts, on mocked replies from the repo's contract
// fixtures (packages/api/fixtures/v1/getRunInsight, plus getRun and listRuns for the run row). The built cloud dist is
// served by fixture-server.mjs. The document carries the production CSP and Trusted Types directives. Every test runs
// on desktop, phone and tablet.
//
// The logic half (titles, verdict words, cost wording, links, what a malformed reply is reduced to) is in
// test/runs-detail.test.mjs; this file covers what needs a real DOM: collapsing, hostile text, every state, and that
// nothing overflows.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const V1 = join(SCRIPT_DIR, "..", "..", "..", "packages", "api", "fixtures", "v1");
const readFixture = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const LIST = readFixture("listRuns", "200-page.json");
const RUN = readFixture("getRun", "200-running.json");
const EVENTS = readFixture("listRunEvents", "200-page.json");
const REVIEW = readFixture("getRunInsight", "200-review-needs-fix.json");
const EXEC = readFixture("getRunInsight", "200-executor-done.json");
const BARE = readFixture("getRunInsight", "200-running-bare.json");

const ID = LIST.data[0].id as string;
const SERVER_TEXT = "server text that must never be shown";
const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const WIN = `#windows-container .fulc-window[data-app-id="runs"]`;
const tid = (page: Page, id: string) => page.locator(`${WIN} [data-testid="${id}"]`);
const CLAUDE_CODE_RE = /claude[\s_\-. ]*code/i;

interface Mock {
  requests: string[];
  runStatus: string;
  insight: { status: number; json: unknown };
  linked: Record<string, unknown>;
  /** The run stream's whole reply; idle by default. */
  stream: string;
  /** Insight replies handed out in order before `insight` (the running run's later reads). */
  insightQueue: unknown[];
}

async function mockApi(page: Page, insight: { status: number; json: unknown }, runStatus: string): Promise<Mock> {
  const mock: Mock = { requests: [], runStatus, insight, linked: {}, stream: "event: idle\ndata: {}\n\n", insightQueue: [] };
  const send = (route: Route, status: number, json: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(json) }).catch(() => undefined);
  await page.route((u) => u.pathname.startsWith("/api/v1/runs"), async (route) => {
    if ((route.request().headers()["accept"] ?? "").includes("text/event-stream")) {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: mock.stream }).catch(() => undefined);
    }
    const url = new URL(route.request().url());
    const p = url.pathname;
    mock.requests.push(`${route.request().method()} ${p}`);
    if (p === "/api/v1/runs") return send(route, 200, { data: [{ ...RUN, id: ID, status: mock.runStatus }], next_cursor: null });
    if (p.endsWith("/insight")) {
      const id = p.split("/")[4];
      if (id !== ID && mock.linked[id!]) return send(route, 200, mock.linked[id!]);
      if (mock.insightQueue.length) return send(route, 200, mock.insightQueue.shift());
      return send(route, mock.insight.status, mock.insight.json);
    }
    if (p.endsWith("/events")) {
      const from = Number(url.searchParams.get("cursor") ?? 0);
      const data = EVENTS.data.filter((e: { seq: number }) => e.seq > from).slice(0, Number(url.searchParams.get("limit") ?? 50));
      return send(route, 200, { data, next_cursor: data.length ? String(data[data.length - 1].seq) : String(from) });
    }
    return send(route, 200, { ...RUN, id: p.split("/").pop(), status: mock.runStatus });
  });
  await page.route("**/api/v1/events", () => new Promise<void>(() => {}));
  return mock;
}

async function setup(page: Page, insight: { status: number; json: unknown }, runStatus = "succeeded") {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    window.addEventListener("focus", (e) => e.stopImmediatePropagation(), true);
    (window as unknown as { __tt: string[] }).__tt = [];
    document.addEventListener("securitypolicyviolation", (e) => (window as unknown as { __tt: string[] }).__tt.push(e.violatedDirective));
  });
  const mock = await mockApi(page, insight, runStatus);
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  await page.goto("/");
  await page.waitForFunction(() => (window as unknown as { currentStep?: string }).currentStep === "DESKTOP", null, { timeout: 30_000 });
  await page.locator('.dock-icon[data-app-id="runs"]').click();
  await expect(page.locator(WIN)).toBeVisible();
  await expect(page.locator(WIN)).not.toHaveClass(/opening/);
  return { errors, mock, tt: () => page.evaluate(() => (window as unknown as { __tt: string[] }).__tt) };
}

async function press(page: Page, locator: ReturnType<Page["locator"]>) {
  if (test.info().project.name === "phone") await locator.tap();
  else await locator.click();
}

async function openRun(page: Page) {
  await expect(tid(page, "runs-row")).toHaveCount(1);
  await press(page, tid(page, "runs-row").first());
  await expect(tid(page, "runs-head")).toBeVisible();
}

/** No horizontal overflow in the detail, and nothing inside it sticks out past the detail's right edge. */
async function expectNoOverflow(page: Page) {
  const r = await tid(page, "runs-detail").evaluate((el) => {
    const box = el as HTMLElement;
    const right = box.getBoundingClientRect().right;
    const wide = [...box.querySelectorAll("*")]
      .filter((n) => n.getBoundingClientRect().width > 0 && n.getBoundingClientRect().right > right + 1 && !n.closest("pre"))
      .map((n) => n.tagName + "." + (n as HTMLElement).className);
    return { scrollW: box.scrollWidth, clientW: box.clientWidth, wide };
  });
  expect(r.scrollW).toBeLessThanOrEqual(r.clientW + 1);
  expect(r.wide).toEqual([]);
}

const isOpen = (loc: ReturnType<Page["locator"]>) => loc.evaluate((e) => (e as HTMLDetailsElement).open);

test.describe("D#483 P5: the run detail (mocked API)", () => {
  test("a reviewer's run: header, verdict, findings, summary, cost split, timeline with commands, facts collapsed", async ({ page }) => {
    const { errors, mock, tt } = await setup(page, { status: 200, json: REVIEW });
    await openRun(page);
    await expect(tid(page, "runs-head").locator("h3")).toHaveText("Review · Code reviewer");
    await expect(tid(page, "runs-head-meta")).toHaveText("Took 12m 30s");
    // links: the work item (an app button) and the issue and PR on GitHub
    await expect(tid(page, "runs-open-item")).toBeVisible();
    const gh = tid(page, "runs-gh");
    await expect(gh).toHaveCount(2);
    expect(await gh.evaluateAll((els) => els.map((e) => [e.textContent, e.getAttribute("href"), e.getAttribute("rel")]))).toEqual([
      ["Issue #42 on GitHub", "https://github.com/acme/docs/issues/42", "noopener noreferrer"],
      ["PR #57 on GitHub", "https://github.com/acme/docs/pull/57", "noopener noreferrer"],
    ]);
    // outcome
    await expect(tid(page, "runs-summary")).toContainText("Two problems need a fix before merge.");
    await expect(tid(page, "runs-verdict")).toHaveText("Needs fix");
    await expect(tid(page, "runs-verdict")).toHaveAttribute("data-verdict", "needs-fix");
    await expect(tid(page, "runs-finding")).toHaveText(["The verdict chip is not announced to screen readers.", "A run with no findings shows an empty list."]);
    // cost: two separate lines, each with whose bill
    await expect(tid(page, "runs-cost-model")).toContainText("Model usage");
    await expect(tid(page, "runs-cost-model")).toContainText("$1.23");
    await expect(tid(page, "runs-cost-model")).toContainText("On your Anthropic key");
    await expect(tid(page, "runs-cost-model")).toContainText("182,000 in, 9,400 out");
    await expect(tid(page, "runs-cost-compute")).toContainText("Sandbox compute");
    await expect(tid(page, "runs-cost-compute")).toContainText("$0.04");
    // the timeline: the same lines as the Pipeline app, with times
    await expect(tid(page, "runs-act")).toHaveCount(3);
    await expect(tid(page, "runs-act").nth(1)).toContainText("Ran tests: pnpm --filter @fx/workspace test");
    await expect(tid(page, "runs-act").nth(2)).toContainText("Ran: git diff --stat origin/main");
    await expect(tid(page, "runs-act").nth(1).locator("time")).toHaveCount(1);
    await expect(tid(page, "runs-activity-more")).toHaveCount(0); // short: nothing to fold
    // run facts: collapsed by default; opening shows the facts and the continuation link
    expect(await isOpen(tid(page, "runs-facts"))).toBe(false);
    await press(page, tid(page, "runs-facts").locator("summary"));
    await expect(tid(page, "runs-facts")).toContainText("sonnet-5");
    await expect(tid(page, "runs-facts")).toContainText("9b708c1");
    await expect(tid(page, "runs-facts")).toContainText("Time 60 min");
    await expect(tid(page, "runs-linked")).toHaveText("Continues: Review · Code reviewer, failed");
    await expectNoOverflow(page);
    expect(mock.requests.filter((r) => r.endsWith("/insight"))).toEqual([`GET /api/v1/runs/${ID}/insight`]);
    expect(await tt()).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("a continuation link opens that run", async ({ page }) => {
    const { mock } = await setup(page, { status: 200, json: REVIEW });
    mock.linked[REVIEW.parent.id] = { ...EXEC, run: { ...EXEC.run, id: REVIEW.parent.id } };
    await openRun(page);
    await press(page, tid(page, "runs-facts").locator("summary"));
    await press(page, tid(page, "runs-linked"));
    await expect(tid(page, "runs-head").locator("h3")).toHaveText("Build · Executor");
    expect(mock.requests).toContain(`GET /api/v1/runs/${REVIEW.parent.id}/insight`);
  });

  test("an executor's run shows its branch and PR, and an operator-subscription run has no per-token charge", async ({ page }) => {
    await setup(page, { status: 200, json: EXEC });
    await openRun(page);
    await expect(tid(page, "runs-head").locator("h3")).toHaveText("Build · Executor");
    await expect(tid(page, "runs-summary")).toHaveText("Added the run insight route and the Runs detail.");
    await expect(tid(page, "runs-branch")).toHaveText("Branch: runs-detail");
    await expect(tid(page, "runs-pr")).toHaveText("Pull request: #57");
    await expect(tid(page, "runs-findings")).toHaveCount(0); // findings belong to reviewers
    await expect(tid(page, "runs-cost-model")).toContainText("No per-token charge");
    await expect(tid(page, "runs-cost-model")).toContainText("On the operator's subscription");
    await expect(tid(page, "runs-cost-compute")).toContainText("$0.04");
    await press(page, tid(page, "runs-facts").locator("summary"));
    await expect(tid(page, "runs-linked")).toHaveText("Continued by: Review · Code reviewer, running");
    await expectNoOverflow(page);
  });

  test("a running run with no result yet: counting, no outcome, no links, and its event log still shows", async ({ page }) => {
    await setup(page, { status: 200, json: BARE }, "running");
    await openRun(page);
    await expect(tid(page, "runs-head").locator('[data-testid="runs-chip"]')).toHaveText("Running");
    await expect(tid(page, "runs-head-meta")).toContainText("Running for 29m 40s");
    await expect(tid(page, "runs-head-meta")).toContainText("This run is still going.");
    await expect(tid(page, "runs-no-outcome")).toHaveText("No result yet. The agent reports one when it finishes.");
    await expect(tid(page, "runs-cost-model")).toContainText("Counting…");
    await expect(tid(page, "runs-cost-compute")).toContainText("Settled when the run ends");
    await expect(tid(page, "runs-no-activity")).toBeVisible();
    await expect(tid(page, "runs-open-item")).toHaveCount(0);
    await expect(tid(page, "runs-gh")).toHaveCount(0);
    await expect(tid(page, "run-event")).toHaveCount(9);
    await expectNoOverflow(page);
  });

  for (const status of ["failed", "timed_out", "killed_spend", "refused_spend", "cancelled"]) {
    test(`a ${status} run with no envelope says it reported no result`, async ({ page }) => {
      const body = { ...BARE, run: { ...BARE.run, status, ended_at: "2026-10-03T10:05:00.000Z" } };
      await setup(page, { status: 200, json: body }, status);
      await openRun(page);
      await expect(tid(page, "runs-no-outcome")).toHaveText("This run did not report a result.");
      await expect(tid(page, "runs-head").locator('[data-testid="runs-chip"]')).toHaveAttribute("data-status", status);
      await expect(tid(page, "runs-cost-model")).toContainText("Not recorded");
      await expect(tid(page, "runs-head-meta")).toHaveText("Took 4m 40s");
      await expectNoOverflow(page);
    });
  }

  test("a failed run says why, in plain text, and links no pull request equal to its issue", async ({ page }) => {
    const body = {
      ...BARE,
      run: { ...BARE.run, role: "executor", status: "failed", ended_at: "2026-10-03T10:05:00.000Z" },
      work_item: { id: BARE.run.id, stage: "needs_human", issue_number: 64, repo: { owner: "acme", name: "docs" } },
      pr_number: 64,
      failure_reason: "sandbox_busy",
    };
    await setup(page, { status: 200, json: body }, "failed");
    await openRun(page);
    await expect(tid(page, "runs-failure")).toHaveText("Another build is still using this item's sandbox. Wait for it to finish, then build again.");
    await expect(tid(page, "runs-gh")).toHaveCount(1);
    await expect(tid(page, "runs-gh")).toHaveText("Issue #64 on GitHub");
    await expectNoOverflow(page);
  });

  test("a reviewer with no findings says so, and a verdict of pass is a pass", async ({ page }) => {
    const body = { ...REVIEW, outcome: { ...REVIEW.outcome, verdict: "pass", findings: [] } };
    await setup(page, { status: 200, json: body });
    await openRun(page);
    await expect(tid(page, "runs-verdict")).toHaveText("Pass");
    await expect(tid(page, "runs-no-findings")).toHaveText("No findings reported.");
    await expect(tid(page, "runs-findings")).toHaveCount(0);
  });

  test("a reviewer's envelope with a summary only and an envelope with nothing in it are both drawn", async ({ page }) => {
    const body = { ...REVIEW, outcome: { summary: null, verdict: null, findings: [], findings_truncated: false, branch: null } };
    await setup(page, { status: 200, json: body });
    await openRun(page);
    await expect(tid(page, "runs-verdict")).toHaveCount(0);
    await expect(tid(page, "runs-no-findings")).toBeVisible();
  });

  test("very long text and a long timeline wrap and fold: no horizontal overflow, the rest behind Show more", async ({ page }) => {
    const long = "L".repeat(1000);
    const lines = Array.from({ length: 30 }, (_, i) => ({ at: `2026-10-03T10:${String(i).padStart(2, "0")}:00.000Z`, text: `Ran: ${"x".repeat(i === 0 ? 190 : 20)} ${i}` }));
    const body = {
      ...REVIEW,
      outcome: { ...REVIEW.outcome, summary: "S".repeat(4000), findings: [long, long, "short"] },
      lines,
      lines_truncated: true,
      run: { ...REVIEW.run, model: "m".repeat(80) },
    };
    await setup(page, { status: 200, json: body });
    await openRun(page);
    const shown = page.locator(`${WIN} [data-testid="runs-act"]:visible`);
    await expect(shown).toHaveCount(12);
    await expect(tid(page, "runs-activity")).toContainText("Only the latest activity is shown.");
    expect(await isOpen(tid(page, "runs-activity-more"))).toBe(false);
    await press(page, tid(page, "runs-activity-more").locator("summary"));
    await expect(shown).toHaveCount(30);
    await press(page, tid(page, "runs-facts").locator("summary"));
    await expectNoOverflow(page);
  });

  test("a fold the person opened stays open when the detail is redrawn", async ({ page }) => {
    await setup(page, { status: 200, json: REVIEW });
    await openRun(page);
    await press(page, tid(page, "runs-facts").locator("summary"));
    expect(await isOpen(tid(page, "runs-facts"))).toBe(true);
    // The event log fold is the other one the app draws; closing it and reopening the run's detail resets both.
    await press(page, tid(page, "runs-eventlog").locator("summary"));
    expect(await isOpen(tid(page, "runs-eventlog"))).toBe(false);
    expect(await isOpen(tid(page, "runs-facts"))).toBe(true);
    await expect(tid(page, "run-event").first()).toBeHidden();
  });

  test("hostile model text is shown as text only under the production CSP, and the tool's name is never drawn", async ({ page }) => {
    const hostile = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
    const body = {
      ...REVIEW,
      outcome: { ...REVIEW.outcome, summary: `${hostile} Claude Code did this`, findings: [hostile, "Claude", "Code is the name"], branch: null },
      lines: [{ at: "2026-10-03T10:00:00.000Z", text: `Ran: echo ${hostile} claude_code` }],
    };
    const { tt, errors } = await setup(page, { status: 200, json: body });
    await openRun(page);
    await expect(tid(page, "runs-summary")).toContainText(hostile.slice(0, 20));
    expect(await tid(page, "runs-insight").locator("img, script").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    const text = await page.locator("body").innerText();
    expect(text).not.toMatch(CLAUDE_CODE_RE);
    expect(await tt()).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("when the insight can't be read the events still show, with one plain message and none of the server's text", async ({ page }) => {
    await setup(page, { status: 500, json: { error: { code: "internal_error", message: SERVER_TEXT, request_id: "req_1" } } });
    await openRun(page);
    await expect(tid(page, "runs-insight-error")).toHaveText("What this run did isn't available right now. Its events are below.");
    await expect(tid(page, "run-event")).toHaveCount(9);
    expect(await page.locator("body").innerText()).not.toContain(SERVER_TEXT);
  });

  test("a reply that is not an insight is treated as unavailable, not drawn", async ({ page }) => {
    await setup(page, { status: 200, json: RUN });
    await openRun(page);
    await expect(tid(page, "runs-insight-error")).toBeVisible();
    await expect(tid(page, "runs-cost")).toHaveCount(0);
  });

  test("a running run is read again when it ends: the outcome appears", async ({ page }) => {
    const finished = { ...REVIEW, run: { ...REVIEW.run, status: "succeeded" } };
    const { mock } = await setup(page, { status: 200, json: finished }, "running");
    mock.insightQueue = [BARE]; // the first read, while it runs
    mock.stream = `event: end\ndata: ${JSON.stringify({ status: "succeeded" })}\n\n`;
    await openRun(page);
    await expect(tid(page, "runs-head").locator('[data-testid="runs-chip"]')).toHaveText("Succeeded");
    await expect(tid(page, "runs-verdict")).toHaveText("Needs fix"); // the second read, after the end frame
    expect(mock.requests.filter((r) => r.endsWith("/insight"))).toHaveLength(2);
    await expect(tid(page, "runs-head").locator("h3")).toHaveText("Review · Code reviewer");
    await expectNoOverflow(page);
  });

  test("the detail fits the window on this form factor", async ({ page }) => {
    await setup(page, { status: 200, json: REVIEW });
    await openRun(page);
    await press(page, tid(page, "runs-facts").locator("summary"));
    await expectNoOverflow(page);
    const app = (await page.locator(`${WIN} [data-testid="runs-app"]`).boundingBox())!;
    const detail = (await tid(page, "runs-detail").boundingBox())!;
    expect(detail.width).toBeLessThanOrEqual(app.width + 1);
    // Every control in the detail is at least 44px tall: it is used by touch on the phone and tablet.
    const small = await tid(page, "runs-detail").evaluate((el) =>
      [...el.querySelectorAll("button, a, summary")].filter((c) => c.getBoundingClientRect().height < 43.5).map((c) => c.tagName + "." + (c as HTMLElement).className)
    );
    expect(small).toEqual([]);
  });
});
