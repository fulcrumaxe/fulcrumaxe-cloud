// apps/workspace/e2e/runs-check.spec.ts
//
// D#6 R-CHK-3b: the Check block of the Runs detail in a browser, one test per state, on the bodies the real route produced (the getRunInsight
// check fixtures, pinned by packages/api/test/run-check-states.test.ts), with the production CSP and Trusted Types directives and an axe pass.
// The model half is checked as data in test/runs-check.test.mjs.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const V1 = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "api", "fixtures", "v1");
const readFixture = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const LIST = readFixture("listRuns", "200-page.json");
const RUN = readFixture("getRun", "200-running.json");
const ID = LIST.data[0].id as string;
const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const WIN = `#windows-container .fulc-window[data-app-id="runs"]`;
const tid = (page: Page, id: string) => page.locator(`${WIN} [data-testid="${id}"]`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;
const NAMES = readdirSync(join(V1, "getRunInsight")).filter((f) => f.startsWith("200-check-")).map((f) => f.slice(4, -5));

/** What each state draws: the chip's label, and what the block must (not) contain. */
const WANT: Record<string, { state: string; label: string; text: RegExp; output: boolean }> = {
  "check-not-set": { state: "not_set", label: "Not set", text: /no approved check/, output: false },
  "check-not-run": { state: "not_run", label: "Not run", text: /ended before the check ran/, output: false },
  "check-running": { state: "running", label: "Not finished", text: /after the agent finishes/, output: false },
  "check-passed": { state: "passed", label: "Passed", text: /Exit status 0 · Took 1m 35s · Skipped tests: 3/, output: true },
  "check-failed": { state: "failed", label: "Failed", text: /Exit status 1 · Took 1m 01s · Skipped tests: Not recorded/, output: true },
  "check-timed-out": { state: "timed_out", label: "Timed out", text: /Took 30m 00s/, output: true },
  "check-no-dev-shell": { state: "no_dev_shell", label: "No dev shell", text: /none was built/, output: false },
  "check-not-safe": { state: "unsafe", label: "Could not run safely", text: /would not run it with weaker rules/, output: true },
  "check-runner-too-old": { state: "runner_too_old", label: "Runner too old", text: /Update your runner to run this repository's check\./, output: false },
};

async function setup(page: Page, insight: Body) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    window.addEventListener("focus", (e) => e.stopImmediatePropagation(), true);
    (window as unknown as { __tt: string[] }).__tt = [];
    document.addEventListener("securitypolicyviolation", (e) => (window as unknown as { __tt: string[] }).__tt.push(e.violatedDirective));
  });
  const row = { status: insight.run.status, runtime: "runner" };
  const send = (route: Route, json: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) }).catch(() => undefined);
  await page.route((u) => u.pathname.startsWith("/api/v1/runs"), async (route) => {
    if ((route.request().headers()["accept"] ?? "").includes("text/event-stream")) return route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: idle\ndata: {}\n\n" }).catch(() => undefined);
    const p = new URL(route.request().url()).pathname;
    if (p === "/api/v1/runs") return send(route, { data: [{ ...RUN, id: ID, ...row }], next_cursor: null });
    if (p.endsWith("/insight")) return send(route, { ...insight, run: { ...insight.run, id: ID } });
    if (p.endsWith("/events")) return send(route, { data: [], next_cursor: "0" });
    return send(route, { ...RUN, id: ID, ...row });
  });
  await page.route("**/api/v1/events", () => new Promise<void>(() => {}));
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  await page.goto("/");
  await page.mouse.move(300, 300);
  await page.waitForFunction(() => (window as unknown as { currentStep?: string }).currentStep === "DESKTOP", null, { timeout: 30_000 });
  await page.evaluate(() => (window as unknown as { FULCWM: { open: (id: string) => void } }).FULCWM.open("runs"));
  await expect(page.locator(WIN)).toBeVisible();
  await expect(page.locator(WIN)).not.toHaveClass(/opening/);
  await expect(tid(page, "runs-row")).toHaveCount(1);
  if (test.info().project.name === "phone") await tid(page, "runs-row").first().tap();
  else await tid(page, "runs-row").first().click();
  await expect(tid(page, "runs-head")).toBeVisible();
  return { errors, tt: () => page.evaluate(() => (window as unknown as { __tt: string[] }).__tt) };
}

async function axeSeriousOrCritical(page: Page) {
  const res = await new AxeBuilder({ page }).include(WIN).exclude(`${WIN} .window-titlebar`).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
  return res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}

test.describe("D#6 R-CHK-3b: the Check block, every state (contract fixtures)", () => {
  test("every fixture has a test below", () => {
    expect([...NAMES].sort()).toEqual(Object.keys(WANT).sort());
  });

  for (const name of Object.keys(WANT)) {
    test(name, async ({ page }) => {
      const insight = readFixture("getRunInsight", `200-${name}.json`);
      const want = WANT[name]!;
      const { errors, tt } = await setup(page, insight);
      const block = tid(page, "runs-check");
      await expect(block).toBeVisible();
      await expect(tid(page, "runs-check-state")).toHaveAttribute("data-state", want.state);
      await expect(tid(page, "runs-check-state")).toContainText(want.label);
      await expect(block).toContainText(want.text);
      // the command, as approved, with every space marked
      if (insight.check) {
        await expect(tid(page, "runs-check-arg")).toHaveCount(insight.check.argv.length);
        await expect(tid(page, "runs-check-arg").last()).toHaveText('"a␣␣b"');
      } else await expect(tid(page, "runs-check-argv")).toHaveCount(0);
      // the output is text in a focusable region; a state with none draws none
      await expect(tid(page, "runs-check-output")).toHaveCount(want.output ? 1 : 0);
      if (want.output) await expect(tid(page, "runs-check-output")).toHaveAttribute("tabindex", "0");
      // the first line "check files changed by this branch: …" is set apart, and only when it is there
      if (name === "check-passed") await expect(tid(page, "runs-check-changed")).toHaveText("check files changed by this branch: scripts/check.sh");
      else await expect(tid(page, "runs-check-changed")).toHaveCount(0);
      // no hole on the screen
      expect(await block.innerText()).not.toMatch(/(^|[^A-Za-z])(null|undefined|NaN)([^A-Za-z]|$)/);
      expect(await axeSeriousOrCritical(page)).toEqual([]);
      expect(await tt()).toEqual([]);
      expect(errors).toEqual([]);
    });
  }

  test("output is drawn as literal text, never as an element", async ({ page }) => {
    const insight = readFixture("getRunInsight", "200-check-failed.json");
    await setup(page, insight);
    await expect(tid(page, "runs-check-output")).toContainText("<b>x</b>");
    await expect(tid(page, "runs-check")).not.toContainText("undefined");
    await expect(tid(page, "runs-check").locator("b, img")).toHaveCount(0);
  });

  test("a sandbox run has no Check block", async ({ page }) => {
    const insight = readFixture("getRunInsight", "200-executor-done.json");
    await setup(page, insight);
    await expect(tid(page, "runs-check")).toHaveCount(0);
  });
});
