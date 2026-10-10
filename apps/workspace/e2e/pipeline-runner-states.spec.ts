// apps/workspace/e2e/pipeline-runner-states.spec.ts
//
// D#6 C42-4: the Pipeline run section of a run on the person's own machine, in every state the cloud can report, at desktop, tablet and
// phone (the three Playwright projects run every test here). The replies are the real route outputs pinned against Postgres
// (packages/api/fixtures/v1/getWorkItemActivity/200-runner-*.json), not hand-written JSON, served under the production CSP and Trusted
// Types directives. For each state the visible text is asserted, nothing prints null, undefined or NaN, and nothing sticks out.
// The item's own-plan cost states (C42-5) are in pipeline-runner-usage.spec.ts.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { RUNS } from "./helpers/runner-states.mjs";
import { openPipelineDetail } from "./helpers/pipeline-open";

const V1 = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "api", "fixtures", "v1");
const readFixture = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const WIN = `#windows-container .fulc-window[data-app-id="pipeline"]`;
const tid = (page: Page, id: string) => page.locator(`${WIN} [data-testid="${id}"]`);
const HOLE = /\b(null|undefined|NaN)\b/;
const NOT_PRICED_NOTE = "The tokens were recorded, but there is no API price for this run's model, so no dollar estimate is shown. That is not the same as $0.";
const NOT_RECORDED_NOTE = "This run ended without reporting how many tokens it used, so there is no cost estimate. That is not the same as $0.";

test.use({ timezoneId: "UTC" });

const files = readdirSync(join(V1, "getWorkItemActivity")).filter((f) => f.startsWith("200-runner-")).sort();

test.describe("D#6 C42-4: every state of a run on the person's own machine in the Pipeline run section (real route outputs)", () => {
  test("every pinned state has an expectation", () => {
    expect(Object.keys(RUNS).sort()).toEqual(files);
  });

  for (const file of files) {
    test(file.replace(/^200-runner-|\.json$/g, ""), async ({ page }) => {
      const activity = readFixture("getWorkItemActivity", file);
      const run = activity.runs[0];
      const want = (RUNS as Record<string, { wait: string | null; checkedIn?: string; attach?: boolean }>)[file];
      const { errors, tt } = await openPipelineDetail(page, activity);
      const section = tid(page, "pl-ins-run").first();
      // a finished run's section starts closed: open it the way a person does
      if (await section.evaluate((el) => !(el as HTMLDetailsElement).open)) {
        if (test.info().project.name === "phone") await section.locator("summary").tap();
        else await section.locator("summary").click();
      }

      // why a queued run is not running yet
      if (want.wait) await expect(section.locator('[data-testid="pl-run-wait"]')).toHaveText(want.wait);
      else await expect(section.locator('[data-testid="pl-run-wait"]')).toHaveCount(0);

      // cost: the usage line or the state's own words; a missing figure is never $0, and a run still going shows none
      const cost = section.locator('[data-testid="pl-run-cost"]');
      const note = section.locator('[data-testid="pl-run-cost-note"]');
      const head = (await section.locator("summary").innerText()).trim();
      switch (run.runner_usage_state) {
        case "recorded":
          await expect(cost).toHaveText("On your Claude plan · API-equivalent $0.01 · 1,000 in / 200 out tokens");
          await expect(note).toHaveCount(0);
          break;
        case "not_priced":
          await expect(cost).toHaveText("On your Claude plan · no API price for this model · 500 in / 100 out tokens");
          await expect(note).toHaveText(NOT_PRICED_NOTE);
          break;
        case "not_recorded":
          await expect(cost).toHaveText("Cost not recorded");
          await expect(note).toHaveText(NOT_RECORDED_NOTE);
          break;
        default:
          await expect(cost).toHaveCount(0);
          await expect(note).toHaveCount(0);
      }
      // the head carries no dollar figure for a run on the person's machine (its spend is not the figure)
      expect(head).not.toMatch(/\$\d/);

      // live: when the runner last checked in, and how to watch the run on the machine
      if (want.checkedIn) await expect(section.locator('[data-testid="pl-run-checkin"]')).toHaveText("Runner checked in " + want.checkedIn);
      else await expect(section.locator('[data-testid="pl-run-checkin"]')).toHaveCount(0);
      if (want.attach) await expect(section.locator('[data-testid="pl-run-attach"]')).toHaveText("You can also watch this run on the runner machine with `fx-runner attach`.");
      else await expect(section.locator('[data-testid="pl-run-attach"]')).toHaveCount(0);

      // the activity: the lines the cloud returned, or what an empty one says
      const lines: Array<{ text: string }> = run.lines;
      const live = run.status === "pending" || run.status === "running";
      if (lines.length > 0) {
        await expect(section.locator('[data-testid="pl-feed"] li')).toHaveCount(lines.length);
        await expect(section.locator('[data-testid="pl-feed"] li').first()).toHaveText(lines[0].text);
        await expect(section.locator('[data-testid="pl-feed"] li').last()).toHaveText(lines[lines.length - 1].text);
      } else if (!live) {
        await expect(section.locator('[data-testid="pl-no-activity"]')).toHaveText("No activity recorded for this run yet.");
      } else if (run.status === "running") {
        await expect(section.locator('[data-testid="pl-no-activity"]')).toHaveText("Your runner has started; nothing recorded yet");
      } else {
        // queued: the wait sentence above speaks for it
        await expect(section.locator('[data-testid="pl-no-activity"]')).toHaveCount(0);
      }

      // no hole anywhere on the screen, nothing wider than the detail, no policy violation
      expect(await tid(page, "pl-live").innerText()).not.toMatch(HOLE);
      const wide = await tid(page, "pl-detail").evaluate((el) => {
        const right = el.getBoundingClientRect().right;
        return [...el.querySelectorAll("*")].filter((n) => n.getBoundingClientRect().width > 0 && n.getBoundingClientRect().right > right + 1).length;
      });
      expect(wide).toBe(0);
      expect(await tt()).toEqual([]);
      expect(errors).toEqual([]);
    });
  }

  test("a hostile line is text: markup in an activity line becomes no element", async ({ page }) => {
    const base = readFixture("getWorkItemActivity", "200-runner-running-activity.json");
    const activity = { ...base, runs: [{ ...base.runs[0], lines: [...base.runs[0].lines, { at: base.runs[0].lines[0].at, text: "Ran: <img src=x onerror=alert(1)>" }] }] };
    await openPipelineDetail(page, activity);
    await expect(tid(page, "pl-feed")).toContainText("Ran: <img src=x onerror=alert(1)>");
    await expect(tid(page, "pl-live").locator("img")).toHaveCount(0);
  });
});
