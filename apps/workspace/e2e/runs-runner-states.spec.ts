// apps/workspace/e2e/runs-runner-states.spec.ts
//
// D#6 C42-4: the Runs detail of a run on the person's own machine, in every state the cloud can report, at desktop, tablet and phone
// (the three Playwright projects run every test here). The replies are the real route outputs pinned against Postgres
// (packages/api/fixtures/v1/getRunInsight/200-runner-*.json), not hand-written JSON, served under the production CSP and Trusted Types
// directives. For each state the visible text is asserted, nothing prints null, undefined or NaN, and nothing sticks out of the detail.
// The expectations are the table in helpers/runner-states.mjs, shared with test/runner-parity.test.mjs.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { RUNS } from "./helpers/runner-states.mjs";
import { openRunsDetail } from "./helpers/runs-open";

const V1 = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "api", "fixtures", "v1");
const readFixture = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const WIN = `#windows-container .fulc-window[data-app-id="runs"]`;
const tid = (page: Page, id: string) => page.locator(`${WIN} [data-testid="${id}"]`);
const HOLE = /\b(null|undefined|NaN)\b/;

// The check-in time is the viewer's clock; pin it so the expected HH:MM:SS is the fixture's.
test.use({ timezoneId: "UTC" });

const files = readdirSync(join(V1, "getRunInsight")).filter((f) => f.startsWith("200-runner-")).sort();

test.describe("D#6 C42-4: every state of a run on the person's own machine in the Runs detail (real route outputs)", () => {
  test("every pinned state has an expectation", () => {
    expect(Object.keys(RUNS).sort()).toEqual(files);
  });

  for (const file of files) {
    test(file.replace(/^200-runner-|\.json$/g, ""), async ({ page }) => {
      const insight = readFixture("getRunInsight", file);
      const want = (RUNS as Record<string, { wait: string | null; cost: { value: string; detail: string | null }; checkedIn?: string; attach?: boolean; empty?: { testid: string; text: string } | null }>)[file];
      const { errors, tt } = await openRunsDetail(page, insight);

      // why a queued run is not running yet
      if (want.wait) await expect(tid(page, "runs-wait")).toHaveText(want.wait);
      else await expect(tid(page, "runs-wait")).toHaveCount(0);

      // the activity: the lines the cloud returned (the first twelve show; the rest fold away), or what an empty one says
      const lines: Array<{ text: string }> = insight.lines;
      if (lines.length > 0) {
        await expect(tid(page, "runs-activity").locator(".runs-acts").first().locator('[data-testid="runs-act"]')).toHaveCount(Math.min(lines.length, 12));
        if (lines.length > 12) await expect(tid(page, "runs-activity-more")).toContainText("Show " + (lines.length - 12) + " more");
        await expect(tid(page, "runs-act").first().locator(".runs-act-text")).toHaveText(lines[0].text);
        await expect(tid(page, "runs-no-activity")).toHaveCount(0);
        await expect(tid(page, "runs-nothing-yet")).toHaveCount(0);
      } else if (want.empty) {
        await expect(tid(page, want.empty.testid)).toHaveText(want.empty.text);
        // "No activity recorded." appears only for a run that has finished
        if (want.empty.testid === "runs-no-activity") expect(["pending", "running"]).not.toContain(insight.run.status);
      } else {
        await expect(tid(page, "runs-no-activity")).toHaveCount(0);
        await expect(tid(page, "runs-nothing-yet")).toHaveCount(0);
      }

      // live: when the runner last checked in, and how to watch the run on the machine
      if (want.checkedIn) await expect(tid(page, "runs-checked-in")).toHaveText("Runner last checked in " + want.checkedIn);
      else await expect(tid(page, "runs-checked-in")).toHaveCount(0);
      if (want.attach) await expect(tid(page, "runs-attach-hint")).toHaveText("You can also watch this run on the runner machine with `fx-runner attach`.");
      else await expect(tid(page, "runs-attach-hint")).toHaveCount(0);

      // cost: the usage line or the state's own words, never a $0 for a figure that is missing
      await expect(tid(page, "runs-cost-model")).toContainText(want.cost.value);
      if (want.cost.detail) await expect(tid(page, "runs-cost-model")).toContainText(want.cost.detail);
      if (want.cost.value === "Not recorded" || want.cost.value === "Counting…" || /no API price/.test(want.cost.value)) expect(await tid(page, "runs-cost-model").innerText()).not.toMatch(/\$\d+\.\d/);

      // a run that failed says why in plain words (a lost lease included)
      if (insight.run.status === "failed" || insight.run.status === "timed_out") await expect(tid(page, "runs-failure")).toBeVisible();
      if (insight.failure_reason === "runner_lost") await expect(tid(page, "runs-failure")).toHaveText("The runner running this was lost.");

      // the facts (a closed fold): where it ran, and the live check-in
      await tid(page, "runs-facts").locator("summary").click();
      await expect(tid(page, "runs-facts")).toContainText("Runs on");
      await expect(tid(page, "runs-facts")).toContainText("your runner");
      if (want.checkedIn) await expect(tid(page, "runs-facts")).toContainText("Runner last checked in" + want.checkedIn);
      else await expect(tid(page, "runs-facts")).not.toContainText("Runner last checked in");

      // no hole anywhere on the screen, nothing wider than the detail, no policy violation
      expect(await tid(page, "runs-detail").innerText()).not.toMatch(HOLE);
      const wide = await tid(page, "runs-detail").evaluate((el) => {
        const right = el.getBoundingClientRect().right;
        return [...el.querySelectorAll("*")].filter((n) => n.getBoundingClientRect().width > 0 && n.getBoundingClientRect().right > right + 1).length;
      });
      expect(wide).toBe(0);
      expect(await tt()).toEqual([]);
      expect(errors).toEqual([]);
    });
  }

  test("a hostile line is text: markup in an activity line becomes no element", async ({ page }) => {
    const base = readFixture("getRunInsight", "200-runner-running-activity.json");
    const insight = { ...base, lines: [...base.lines, { at: base.lines[0].at, text: "Ran: <img src=x onerror=alert(1)>" }] };
    await openRunsDetail(page, insight);
    await expect(tid(page, "runs-activity")).toContainText("Ran: <img src=x onerror=alert(1)>");
    await expect(tid(page, "runs-detail").locator("img")).toHaveCount(0);
  });
});
