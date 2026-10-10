// apps/workspace/e2e/runner-parity-pixels.spec.ts
//
// D#6 C42-4: a run on the person's own machine is drawn the way a sandbox run is. For each matching state the Activity of a runner run
// and of a sandbox run with the SAME lines and status are screenshotted at the same viewport and compared pixel by pixel, in the browser
// (a canvas decode of both PNGs: no dependency). The numbers are printed and attached for every comparison:
//   PIXELS <app> <state> <project>: differing <n> of <w>x<h> = <total> pixels, max channel delta <d>
// The tolerance is none: the two go through one code path, so every pixel must be equal (differing 0, max delta 0). Each element is drawn alone
// at the corner of a blank page on the app's own stylesheets (see isolatedShot), because where it sits in the app, and the desktop behind it,
// differ between a runner run and a sandbox run for reasons that are not the code path under test.
//
// Controls, so a pass means something:
//  - the same runner element screenshotted twice differs by 0 (the capture itself is stable);
//  - a sandbox run whose lines differ by ONE word differs by more than 0 (the comparison can see a difference);
//  - a sandbox run with one more line differs in size (the comparison can see a different layout).
// A live runner run also draws its wait, check-in and hint above the lines; those are compared in the state specs, so here the line
// list alone is compared for a live run and the whole Activity section for a finished one.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Browser, type Locator, type Page } from "@playwright/test";
import { openRunsDetail } from "./helpers/runs-open";
import { openPipelineDetail } from "./helpers/pipeline-open";

const V1 = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "api", "fixtures", "v1");
const readFixture = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const SANDBOX = readFixture("getRunInsight", "200-executor-done.json");
const RUNS_WIN = `#windows-container .fulc-window[data-app-id="runs"]`;
const PL_WIN = `#windows-container .fulc-window[data-app-id="pipeline"]`;

test.use({ timezoneId: "UTC" });

interface Diff {
  sameSize: boolean;
  w: number;
  h: number;
  w2: number;
  h2: number;
  total: number;
  differing: number;
  maxDelta: number;
}

/** Decodes both PNGs on a blank page (no CSP) and counts the pixels where any channel differs. */
async function compare(blank: Page, a: Buffer, b: Buffer): Promise<Diff> {
  return blank.evaluate(
    async ([x, y]) => {
      const decode = async (b64: string) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const canvas = new OffscreenCanvas(bmp.width, bmp.height);
        const g = canvas.getContext("2d")!;
        g.drawImage(bmp, 0, 0);
        return { w: bmp.width, h: bmp.height, d: g.getImageData(0, 0, bmp.width, bmp.height).data };
      };
      const A = await decode(x);
      const B = await decode(y);
      if (A.w !== B.w || A.h !== B.h) return { sameSize: false, w: A.w, h: A.h, w2: B.w, h2: B.h, total: 0, differing: -1, maxDelta: 255 };
      let differing = 0;
      let maxDelta = 0;
      for (let i = 0; i < A.d.length; i += 4) {
        let m = 0;
        for (let k = 0; k < 4; k++) m = Math.max(m, Math.abs(A.d[i + k] - B.d[i + k]));
        if (m > 0) differing++;
        maxDelta = Math.max(maxDelta, m);
      }
      return { sameSize: true, w: A.w, h: A.h, w2: B.w, h2: B.h, total: A.w * A.h, differing, maxDelta };
    },
    [a.toString("base64"), b.toString("base64")],
  );
}

function report(app: string, state: string, d: Diff) {
  const line = d.sameSize
    ? `PIXELS ${app} ${state} ${test.info().project.name}: differing ${d.differing} of ${d.w}x${d.h} = ${d.total} pixels, max channel delta ${d.maxDelta}`
    : `PIXELS ${app} ${state} ${test.info().project.name}: SIZE DIFFERS ${d.w}x${d.h} vs ${d.w2}x${d.h2}`;
  console.log(line);
  test.info().annotations.push({ type: "pixels", description: line });
}

const SHOT = { animations: "disabled", caret: "hide" } as const;

/** A page in a context of its own with the project's viewport and touch settings (a second page in one context would restore the first one's windows). */
async function freshPage(browser: Browser): Promise<Page> {
  const use = test.info().project.use as Record<string, unknown>;
  const context = await browser.newContext({
    baseURL: use.baseURL as string,
    viewport: use.viewport as { width: number; height: number },
    deviceScaleFactor: use.deviceScaleFactor as number | undefined,
    isMobile: use.isMobile as boolean | undefined,
    hasTouch: use.hasTouch as boolean | undefined,
    userAgent: use.userAgent as string | undefined,
    timezoneId: "UTC",
  });
  return context.newPage();
}

/**
 * Draws the element alone and returns its screenshot. The element is serialised out of the app's page and stood at the top-left corner of a blank page
 * (served from the same origin so the app's own stylesheets load) in a box of its own width, on an opaque backdrop, with the text settings it inherited.
 * Where an element sits in the app depends on what is above it, and the desktop behind it moves, scans and rains: a runner run's extra lines put the
 * Activity on a different fraction of a pixel than a sandbox run's, which on a phone's 2.6x screen changes the antialiasing. That is the page, not the
 * code path under test. At the same corner on the same backdrop both captures have the same raster; every rule the element is drawn with is a plain
 * class rule and the classes come along, so nothing it is drawn with is lost.
 */
async function isolatedShot(page: Page, target: Locator): Promise<Buffer> {
  const snap = await target.evaluate((el) => {
    const from = getComputedStyle(el.parentElement as Element);
    const attrs = (n: Element) => [...n.attributes].map((a) => [a.name, a.value] as [string, string]);
    return {
      html: el.outerHTML,
      width: el.getBoundingClientRect().width,
      links: [...document.querySelectorAll("link[rel=stylesheet]")].map((l) => (l as HTMLLinkElement).href),
      viewport: document.querySelector("meta[name=viewport]")?.getAttribute("content") ?? "width=device-width, initial-scale=1",
      htmlAttrs: attrs(document.documentElement),
      bodyAttrs: attrs(document.body),
      inherited: { color: from.color, fontFamily: from.fontFamily, fontSize: from.fontSize, lineHeight: from.lineHeight, letterSpacing: from.letterSpacing, fontWeight: from.fontWeight },
    };
  });
  const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const attrText = (list: Array<[string, string]>) => list.map(([k, v]) => ` ${k}="${esc(v)}"`).join("");
  const css = Object.entries(snap.inherited).map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}:${v}`).join(";");
  const doc = `<!doctype html><html${attrText(snap.htmlAttrs)}><head><meta charset="utf-8"><meta name="viewport" content="${esc(snap.viewport)}">${snap.links.map((h) => `<link rel="stylesheet" href="${esc(h)}">`).join("")}</head>` +
    `<body${attrText(snap.bodyAttrs)} style="margin:0;padding:0;overflow:visible;height:auto;background:rgb(16,20,24)"><div id="fx-shot" style="width:${snap.width}px;display:flow-root;background:rgb(16,20,24);${css}">${snap.html}</div></body></html>`;
  const harness = await page.context().newPage();
  await harness.route("**/fx-harness.html", (route) => route.fulfill({ status: 200, contentType: "text/html", body: doc }));
  await harness.goto("/fx-harness.html");
  await harness.evaluate(() => document.fonts.ready.then(() => undefined));
  const png = await harness.locator("#fx-shot").screenshot(SHOT);
  await harness.close();
  return png;
}

async function runsShot(browser: Browser, insight: { run: { id: string; status: string } }, part: "section" | "list"): Promise<Buffer> {
  const page = await freshPage(browser);
  await openRunsDetail(page, insight);
  const section = page.locator(`${RUNS_WIN} [data-testid="runs-activity"]`);
  const target = part === "section" ? section : section.locator(".runs-acts").first();
  const png = await isolatedShot(page, target);
  await page.context().close();
  return png;
}

/** The sandbox run a runner run is compared with: same lines, same status, same cut, none of the runner's fields. */
function sandboxInsight(runner: { run: { id: string; status: string; started_at: string | null; ended_at: string | null }; lines: unknown[]; lines_truncated: boolean }, over: Record<string, unknown> = {}) {
  return { ...SANDBOX, run: { ...SANDBOX.run, id: runner.run.id, status: runner.run.status, started_at: runner.run.started_at, ended_at: runner.run.ended_at }, lines: runner.lines, lines_truncated: runner.lines_truncated, ...over };
}

const FINISHED = ["succeeded-with-pr", "failed-agent-failed", "failed-push-rejected", "failed-wall-clock", "lease-lost", "taken-over", "usage-limit", "usage-not-recorded", "usage-not-priced"];
const LIVE = ["running-activity", "capped"];

test.describe("D#6 C42-4: the Runs Activity of a runner run is pixel-identical to a sandbox run's with the same lines", () => {
  for (const state of [...FINISHED, ...LIVE]) {
    test(state, async ({ browser }) => {
      const runner = readFixture("getRunInsight", `200-runner-${state}.json`);
      const part = LIVE.includes(state) ? "list" : "section";
      const a = await runsShot(browser, runner, part);
      const b = await runsShot(browser, sandboxInsight(runner), part);
      const blank = await freshPage(browser);
      const d = await compare(blank, a, b);
      await blank.context().close();
      report("runs", state, d);
      expect(d.sameSize).toBe(true);
      expect(d.differing).toBe(0);
      expect(d.maxDelta).toBe(0);
      expect(d.total).toBeGreaterThan(1000);
    });
  }

  test("controls: the capture is stable, and the comparison sees a changed word and a changed layout", async ({ browser }) => {
    const runner = readFixture("getRunInsight", "200-runner-succeeded-with-pr.json");
    const blank = await freshPage(browser);
    const first = await runsShot(browser, runner, "section");
    // 1. the same element captured again: zero difference
    const again = await runsShot(browser, runner, "section");
    const stable = await compare(blank, first, again);
    report("runs", "control-same-element-twice", stable);
    expect(stable.differing).toBe(0);
    // 2. one word changed in one line: a difference the comparison must see
    const changed = sandboxInsight(runner, { lines: runner.lines.map((l: { at: string; text: string }, i: number) => (i === 1 ? { ...l, text: l.text.replace("Reading", "Searching") } : l)) });
    const word = await compare(blank, first, await runsShot(browser, changed, "section"));
    report("runs", "control-one-word-changed", word);
    expect(word.sameSize).toBe(true);
    expect(word.differing).toBeGreaterThan(50);
    // 3. one line more: a different layout, which the comparison reports as a size difference
    const longer = sandboxInsight(runner, { lines: [...runner.lines, { at: runner.lines[0].at, text: "One more line" }] });
    const layout = await compare(blank, first, await runsShot(browser, longer, "section"));
    report("runs", "control-one-line-more", layout);
    expect(layout.sameSize).toBe(false);
    await blank.context().close();
  });
});

async function pipelineShot(browser: Browser, activity: { runs: Array<{ status: string }> }): Promise<Buffer> {
  const page = await freshPage(browser);
  await openPipelineDetail(page, activity);
  const section = page.locator(`${PL_WIN} [data-testid="pl-ins-run"]`).first();
  if (await section.evaluate((el) => !(el as HTMLDetailsElement).open)) await section.locator("summary").click();
  const feed = section.locator('[data-testid="pl-feed"]');
  const png = await isolatedShot(page, feed);
  await page.context().close();
  return png;
}

/** The sandbox run a runner run is compared with in the Pipeline: the same run with the runner's fields taken away. */
function sandboxActivity(activity: { runs: Array<Record<string, unknown>> }, over: Record<string, unknown> = {}) {
  const { runner_usage, runner_usage_state, runner_usage_note, runner_checked_in_at, wait, ...rest } = activity.runs[0];
  void runner_usage; void runner_usage_state; void runner_usage_note; void runner_checked_in_at; void wait;
  return { ...activity, runs: [{ ...rest, runtime: "production", ...over }] };
}

test.describe("D#6 C42-4: the Pipeline feed of a runner run is pixel-identical to a sandbox run's with the same lines", () => {
  for (const state of [...FINISHED, ...LIVE]) {
    test(state, async ({ browser }) => {
      const runner = readFixture("getWorkItemActivity", `200-runner-${state}.json`);
      const a = await pipelineShot(browser, runner);
      const b = await pipelineShot(browser, sandboxActivity(runner));
      const blank = await freshPage(browser);
      const d = await compare(blank, a, b);
      await blank.context().close();
      report("pipeline", state, d);
      expect(d.sameSize).toBe(true);
      expect(d.differing).toBe(0);
      expect(d.maxDelta).toBe(0);
      expect(d.total).toBeGreaterThan(1000);
    });
  }

  test("controls: the capture is stable, and the comparison sees a changed word and a changed layout", async ({ browser }) => {
    const runner = readFixture("getWorkItemActivity", "200-runner-succeeded-with-pr.json");
    const blank = await freshPage(browser);
    const first = await pipelineShot(browser, runner);
    const again = await pipelineShot(browser, runner);
    const stable = await compare(blank, first, again);
    report("pipeline", "control-same-element-twice", stable);
    expect(stable.differing).toBe(0);
    const lines = runner.runs[0].lines as Array<{ at: string; text: string }>;
    const word = await compare(blank, first, await pipelineShot(browser, sandboxActivity(runner, { lines: lines.map((l, i) => (i === 1 ? { ...l, text: l.text.replace("Reading", "Searching") } : l)) })));
    report("pipeline", "control-one-word-changed", word);
    expect(word.sameSize).toBe(true);
    expect(word.differing).toBeGreaterThan(50);
    const layout = await compare(blank, first, await pipelineShot(browser, sandboxActivity(runner, { lines: [...lines, { at: lines[0].at, text: "One more line" }] })));
    report("pipeline", "control-one-line-more", layout);
    expect(layout.sameSize).toBe(false);
    await blank.context().close();
  });
});
