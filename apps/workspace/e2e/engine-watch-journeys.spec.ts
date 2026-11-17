// apps/workspace/e2e/engine-watch-journeys.spec.ts
//
// The engine-watch journeys W1 to W11: each acts through the app's own buttons (real clicks), reads the result back after a reload, and puts things back.
// Every one records a number. Dry mode (the default) runs them on the built dist against the fixture server with a stand-in for the cloud
// (journeys/engine-watch.ts); live mode runs the same steps on a deployed staging app. Prerequisites and how to run live: journeys/engine-watch.md.
import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { waitForDesktop } from "./helpers/boot";
import { Engine, LIVE, Operator, WIN, armClock, logIds, record, serve, stagingOrigin, watchLane } from "./journeys/engine-watch";

if (LIVE) {
  const origin = process.env.JOURNEY_BASE_URL ?? "";
  // Never against anything but staging: the origin is named twice, the same both times, and is on the staging allowlist (see stagingOrigin).
  if (!stagingOrigin(origin) || stagingOrigin(origin) !== stagingOrigin(process.env.JOURNEY_STAGING_ORIGIN ?? "") || !process.env.JOURNEY_STORAGE_STATE || !process.env.JOURNEY_REPO) throw new Error("live journeys need JOURNEY_BASE_URL equal to JOURNEY_STAGING_ORIGIN, both a staging host (cloud-staging.vercel.app or a cloud-staging preview), plus JOURNEY_STORAGE_STATE and JOURNEY_REPO");
  test.use({ baseURL: origin, storageState: process.env.JOURNEY_STORAGE_STATE });
}
test.describe.configure({ mode: "serial" });
// What an operator step takes on a real machine is minutes; in dry mode the stand-in answers at once.
const WAIT = LIVE ? 20 * 60_000 : 20_000;
const t = (page: Page, id: string, app = "team") => page.locator(`${WIN(app)} [data-testid="${id}"]`);
// The bridged repo, found by its full name (JOURNEY_REPO live; the stand-in's first repo in a dry run), never as "the first box".
const REPO = LIVE ? process.env.JOURNEY_REPO! : "acme-labs/widgets";
const repoBox = (page: Page) => page.locator(`${WIN("team")} [data-testid="tm-repo-row"]`).filter({ has: page.locator("bdi", { hasText: new RegExp(`^${REPO.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) }).locator('input[data-testid^="tm-repo-"]');

async function start(page: Page, tweak: (e: Engine) => void = () => {}) {
  test.setTimeout(LIVE ? 3_600_000 : 90_000);
  const engine = new Engine();
  tweak(engine);
  const errors = await serve(page, engine);
  await page.goto("/");
  await waitForDesktop(page);
  await page.locator('.dock-icon[data-app-id="team"]').click();
  await ready(page);
  return { engine, errors, op: new Operator(page, engine) };
}
async function ready(page: Page) {
  await expect(page.locator(WIN("team"))).toBeVisible();
  await expect(page.locator(WIN("team"))).not.toHaveClass(/opening/);
  await expect(t(page, "tm-loading")).toHaveCount(0);
}
/** The reload half of every journey: the page is read from scratch, so only what the cloud kept can be on screen. */
async function reload(page: Page, app = "team") {
  await page.reload();
  await waitForDesktop(page);
  // The desktop is "up" 200 ms before the shell puts the windows from the saved layout back (script.js showDesktop sets a 200 ms timer in the same task
  // that sets currentStep). A person sees the windows return before tapping anything, so wait for that too: a timer of our own with the same delay is
  // queued behind it, so when it fires the restore has run, however loaded the machine is. Otherwise the late restore re-focuses the restored window,
  // which on a phone (one window shown at a time) hides whatever the journey opened in the meantime.
  await page.evaluate(() => new Promise<void>((done) => setTimeout(done, 200)));
  await page.evaluate((id) => (window as unknown as { FULCWM: { open: (a: string) => void } }).FULCWM.open(id), app);
  await expect(page.locator(WIN(app))).toBeVisible();
  if (app === "team") await ready(page);
}
async function clean(page: Page, errors: string[]) {
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.body.innerText)).not.toMatch(/\bnull\b|undefined|NaN|Invalid Date|ApiError/);
}
const sheet = async (page: Page) => { if (!(await t(page, "tm-sheet").isVisible())) await t(page, "tm-settings-btn").click(); await expect(t(page, "tm-sheet")).toBeVisible(); };
const needsYouHasEngine = (page: Page) => page.evaluate(async () => (await fetch(new URL("apps/needs-you/needs-you-model.js", document.baseURI))).text().then((s) => s.includes("engine.changed")));

test("a live run is only ever pointed at staging", () => {
  for (const ok of ["https://cloud-staging.vercel.app", "https://cloud-staging.vercel.app/", "https://cloud-staging-git-feature-x-formalhosting.vercel.app"]) expect(stagingOrigin(ok)).not.toBeNull();
  for (const bad of ["", "not a url", "https://app.fulcrumaxe.com", "https://cloud.vercel.app", "http://cloud-staging.vercel.app", "https://cloud-staging.vercel.app.evil.test", "https://evil-formalhosting.vercel.app", "https://u:p@cloud-staging.vercel.app", "https://cloud-staging.vercel.app:8443", "https://cloud-staging.vercel.app/x"]) expect(stagingOrigin(bad)).toBeNull();
});

test.describe("engine watch journeys", () => {
  test("W1 the watch switch and the repo tick persist, and are put back", async ({ page }) => {
    const { errors } = await start(page);
    await sheet(page);
    await t(page, "tm-watch").click(); // off
    await expect(t(page, "tm-off")).toHaveText("Engine watch is off");
    await reload(page);
    await expect(t(page, "tm-off")).toBeVisible();
    await t(page, "tm-watch-off").click(); // undo
    await expect(t(page, "tm-repo")).toBeVisible();
    await sheet(page);
    await repoBox(page).click(); // untick the repo
    await expect(repoBox(page)).not.toBeChecked();
    // Live, another repo may still be ticked, so the empty-state words are only expected when this was the only one.
    if (!LIVE) await expect(t(page, "tm-norepos")).toHaveText("No repositories are enabled for engine watch.");
    await reload(page);
    await sheet(page);
    await expect(repoBox(page)).not.toBeChecked();
    await repoBox(page).click(); // undo
    await reload(page);
    await sheet(page);
    await expect(t(page, "tm-watch")).toBeChecked();
    await expect(repoBox(page)).toBeChecked();
    record(test, "W1", "toggle and tick persisted (toggle, tick)", `${await t(page, "tm-watch").isChecked() ? 1 : 0} and ${await repoBox(page).isChecked() ? 1 : 0}`);
    await clean(page, errors);
  });

  test("W2 an agent appears with its role and D#, and leaves when it ends", async ({ page }) => {
    const { engine, errors, op } = await start(page);
    const before = await t(page, "tm-agent").count();
    const since = await armClock(page); // the clock starts at the first change on screen after the operator acts, not while the person is still at the terminal
    await op.do("spawn one real agent", () => engine.agents.push({ id: "a1b2c3d4e5f60718", role: "executor", d: 42, at: Date.now() }));
    await expect(t(page, "tm-agent")).toHaveCount(before + 1, { timeout: WAIT });
    await expect(t(page, "tm-agent").last().locator("[data-testid=tm-d]")).toHaveText(/^D#\d+$/);
    const s = await since();
    if (LIVE) expect(s).toBeLessThanOrEqual(60);
    record(test, "W2", "seconds until the Agents panel shows the agent", s);
    await reload(page);
    await expect(t(page, "tm-agent")).toHaveCount(before + 1);
    await op.do("let the agent finish", () => { engine.agents[0]!.stopped = true; });
    await expect(t(page, "tm-agent")).toHaveCount(before, { timeout: WAIT });
    await reload(page);
    await expect(t(page, "tm-agent")).toHaveCount(before); // the Agents panel lists running agents only; a stopped agent's verdict is not drawn anywhere (see the runbook)
    await clean(page, errors);
  });

  test("W3 a pull request goes through the merge lane to merged, with its gate chips", async ({ page }) => {
    const { engine, errors, op } = await start(page);
    const lane = page.locator(`${WIN("team")} [data-testid="tm-lane"]`);
    const seenNow = await watchLane(page); // a state can flash past between two reads, so every state shown is recorded as it appears
    // Dry: the stand-in is moved one state at a time. Live: one real PR goes through on its own, and may pass Queued or Testing quickly.
    const steps = LIVE ? ([["merged", "Merged", 3]] as const) : ([["queued", "Queued", 0], ["testing", "Testing", 2], ["merged", "Merged", 3]] as const);
    for (const [state, words, gates] of steps) {
      await op.do(LIVE ? "queue a real ready PR and let it go through to merged" : `queue a real ready PR, then wait for it to reach ${words}`, () => { engine.lanes = [{ pr: 7, d: 42, state, gates }]; });
      await expect(lane.first().locator('[data-testid="tm-lane-state"]')).toHaveText(words, { timeout: WAIT });
    }
    const seen = await seenNow();
    expect(seen).toContain("Merged");
    expect(seen.some((w) => w === "Queued" || w === "Testing")).toBe(true); // at least one earlier state was on screen at some point
    expect(await lane.first().locator('[data-testid="tm-gate"]').count()).toBeGreaterThan(0);
    const chips = await lane.first().locator('[data-testid="tm-gate"]').count();
    await reload(page);
    await expect(t(page, "tm-merged").locator('[data-testid="tm-pr"]')).toHaveCount(1); // a merge is history: nothing to undo, and it is still listed after a reload
    record(test, "W3", "lane states in order, gate chips", `${seen.join(" > ")}, ${chips}`);
    await clean(page, errors);
  });

  test("W4 a log line adds one row and none of its words reach the page", async ({ page }) => {
    const { engine, errors, op } = await start(page);
    // The Log panel draws at most 100 rows, so rows are not counted: a new line is a first row with an id that was not on screen before.
    const before = new Set(await logIds(page));
    const added = async () => (await logIds(page)).filter((id) => !before.has(id));
    await op.do(`post a team-log line containing "${op.secret}"`, () => { engine.logTotal += 1; });
    await expect.poll(async () => (await added()).length, { timeout: WAIT }).toBeGreaterThanOrEqual(1);
    if (!LIVE) expect(await added()).toHaveLength(1);
    const fresh = await added();
    const text = await page.locator(WIN("team")).innerText();
    for (const w of op.secret.split("-")) expect(text).not.toContain(w);
    await reload(page);
    const after = await logIds(page);
    for (const id of fresh) expect(after).toContain(id);
    record(test, "W4", "new log rows (by id)", fresh.length);
    await clean(page, errors);
  });

  test("W5 the Plan panel lists as many items as today's plan file has D#s", async ({ page }) => {
    const { engine, errors, op } = await start(page);
    const plan = LIVE ? readFileSync(process.env.JOURNEY_PLAN_FILE ?? "", "utf8") : "1. D#100 first\n2. D#101 second\n3. D#102 third (see D#100)\n";
    await op.do("run start-the-day.sh", () => { engine.planItems = 3; });
    const want = new Set(plan.match(/D#\d+/g)).size;
    await expect(t(page, "tm-plan-item")).toHaveCount(want, { timeout: WAIT });
    await reload(page);
    await expect(t(page, "tm-plan-item")).toHaveCount(want);
    record(test, "W5", "plan items = D# in the plan file", `${await t(page, "tm-plan-item").count()} = ${want}`);
    await clean(page, errors);
  });

  test("W6 a needs-boss line adds an engine row in Needs you, and clearing it removes the row without a reload", async ({ page }) => {
    const { engine, errors, op } = await start(page);
    test.skip(!(await needsYouHasEngine(page)), "the Needs-you engine rows are not in this build yet");
    await page.locator('.dock-icon[data-app-id="needs-you"]').click();
    const h2 = page.locator(`${WIN("needs-you")} h2`);
    await expect(h2).toHaveText(/^Needs you \(\d+\)$/);
    const n = Number((await h2.innerText()).match(/\d+/)![0]);
    await op.do("post a needs-boss line for a D#", () => { engine.asks = [{ id: "0123456789abcdef", d: 42 }]; });
    await expect(h2).toHaveText(`Needs you (${n + 1})`, { timeout: WAIT });
    await expect(page.locator(`${WIN("needs-you")} [data-testid^="ny-engine-link-"]`).first()).toHaveText(/^D#\d+( \(opens in a new tab\))?$/);
    await reload(page, "needs-you");
    await expect(h2).toHaveText(`Needs you (${n + 1})`);
    await op.do("clear the ask on GitHub", () => { engine.asks = []; });
    await expect(h2).toHaveText(`Needs you (${n})`, { timeout: WAIT }); // no reload since the check above
    record(test, "W6", "engine rows added, then cleared", "+1 and -1");
    await clean(page, errors);
  });

  test("W7 a stopped runner reads stale and a started one reads live", async ({ page }) => {
    const { engine, errors, op } = await start(page);
    const sinceStop = await armClock(page);
    await op.do("stop the runner", () => { engine.heardAt = Date.now() - 300_000; });
    await expect(t(page, "tm-chip")).toHaveText(/^Engine connection: Stale since \d\d:\d\d$/, { timeout: WAIT });
    const stale = await sinceStop();
    await reload(page);
    await expect(t(page, "tm-chip")).toHaveText(/Stale since/);
    const sinceStart = await armClock(page);
    await op.do("start the runner", () => { engine.heardAt = Date.now(); });
    await expect(t(page, "tm-chip")).toHaveText("Engine connection: Live", { timeout: WAIT });
    const live = await sinceStart();
    if (LIVE) { expect(stale).toBeLessThanOrEqual(240); expect(live).toBeLessThanOrEqual(120); }
    record(test, "W7", "seconds to stale, seconds to live (from the first change on screen)", `${stale}, ${live}`);
    await clean(page, errors);
  });

  test("W9 with only the bridge stopped every panel says last seen, keeps its data, and the agent reads unknown", async ({ page }) => {
    const { engine, errors, op } = await start(page, (e) => { e.agents = [{ id: "a1b2c3d4e5f60718", role: "executor", d: 42, at: Date.now() - 600_000 }]; e.lanes = [{ pr: 7, d: 42, state: "testing", gates: 1 }]; e.asks = [{ id: "0123456789abcdef", d: 42 }]; });
    await expect(t(page, "tm-agent")).toHaveAttribute("data-state", "running");
    await op.do("stop only the bridge while the engine keeps working", () => { engine.heardAt = Date.now() - 360_000; });
    const panels = ["agents", "lanes", "log", "plan"];
    for (const k of panels) await expect(t(page, `tm-${k}-warn`)).toHaveText(/^last seen \d+ min ago$/, { timeout: WAIT });
    await expect(t(page, "tm-agent")).toHaveAttribute("data-state", "unknown");
    expect((await t(page, "tm-agent").innerText()).toLowerCase()).not.toContain("running");
    await expect(t(page, "tm-lane")).toHaveCount(1); // the earlier data stays
    await reload(page);
    await expect(t(page, "tm-log-warn")).toBeVisible();
    if (await needsYouHasEngine(page)) {
      await page.locator('.dock-icon[data-app-id="needs-you"]').click();
      await expect(page.locator(`${WIN("needs-you")} [data-testid="ny-machine"]`)).toBeVisible({ timeout: WAIT });
      await page.evaluate(() => (window as unknown as { FULCWM: { close: (a: string) => void } }).FULCWM.close("needs-you"));
    }
    await op.do("restart the bridge", () => { engine.heardAt = Date.now(); });
    for (const k of panels) await expect(t(page, `tm-${k}-warn`)).toHaveCount(0, { timeout: WAIT });
    record(test, "W9", "panels showing last seen, then back to as of", `${panels.length}, 0`);
    await clean(page, errors);
  });

  test("W10 a gap shows its banner, and 10,000 log events never draw more than 400 rows", async ({ page }) => {
    const { engine, errors, op } = await start(page);
    await op.do("make the emitter skip 5 seq values (the staging-only hook)", () => { engine.missing = 5; });
    await expect(t(page, "tm-banner")).toHaveText(/^Events missing since \d\d:\d\d \(5 events\)$/, { timeout: WAIT });
    await expect(t(page, "tm-banner").locator("button")).toHaveCount(0); // no way to dismiss it
    await reload(page);
    await expect(t(page, "tm-banner")).toBeVisible();
    await op.do("load the 10,000-event fixture session", () => { engine.logTotal = 10_000; engine.missing = 0; });
    await page.evaluate(() => { // a frame clock: the longest gap between two animation frames while the log is scrolled
      const w = window as unknown as { __gap: number };
      let last = performance.now();
      w.__gap = 0;
      const tick = (now: number) => { w.__gap = Math.max(w.__gap, now - last); last = now; requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    const [list, rows, older] = [t(page, "tm-log-list"), t(page, "tm-log-line"), t(page, "tm-log-older")];
    let most = 0, pages = 0;
    for (let i = 0; i < 400; i++) {
      most = Math.max(most, await rows.count());
      if ((await older.getAttribute("aria-disabled")) === "true" && i > 2) break;
      const last = await rows.last().getAttribute("data-id");
      await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await expect.poll(async () => (await rows.last().getAttribute("data-id")) !== last || (await older.getAttribute("aria-disabled")) === "true", { timeout: 15_000 }).toBe(true);
      pages += 1;
    }
    const gap = Math.round(await page.evaluate(() => (window as unknown as { __gap: number }).__gap));
    expect(most).toBeLessThanOrEqual(400);
    expect(pages).toBeGreaterThan(50);
    if (LIVE) expect(gap).toBeLessThanOrEqual(200); // a shared test machine stalls frames for reasons of its own, so the dry run records the figure and the live run holds it
    record(test, "W10", "gap banner shown, most log rows drawn, longest frame gap ms", `5 events, ${most}, ${gap}`);
    await clean(page, errors);
  });

  test("W11 the Team cost total equals the engine line on Budget & billing", async ({ page }) => {
    const { errors } = await start(page);
    const team = await t(page, "tm-usage-headline").innerText();
    await page.evaluate(() => (window as unknown as { FULCWM: { open: (a: string) => void } }).FULCWM.open("budget-billing"));
    const line = page.locator(`${WIN("budget-billing")} [data-testid="bb-engine-value"]`);
    await expect(line).toBeVisible();
    const billing = await line.innerText();
    expect(team).toBe(billing);
    await reload(page, "budget-billing"); await expect(line).toHaveText(billing);
    record(test, "W11", "Team cost, Budget & billing line", `${team}, ${billing}`);
    await clean(page, errors);
  });

  test("W8 off, five events, on: the five arrive with no gap, and deleting the data empties every panel", async ({ page }) => {
    const { engine, errors, op } = await start(page);
    const before = new Set(await logIds(page)); // ids, not a row count: the panel draws at most 100 rows
    const added = async () => (await logIds(page)).filter((id) => !before.has(id));
    await sheet(page);
    await t(page, "tm-watch").click();
    await expect(t(page, "tm-off")).toBeVisible();
    await op.do("emit 5 engine events while watch is off", () => { engine.queued += 5; });
    await t(page, "tm-watch-off").click(); // on again
    await expect.poll(async () => (await added()).length, { timeout: WAIT }).toBeGreaterThanOrEqual(5);
    if (!LIVE) expect(await added()).toHaveLength(5);
    const fresh = await added();
    await expect(t(page, "tm-banner")).toBeHidden(); // no gap
    await reload(page);
    const after = await logIds(page);
    for (const id of fresh.slice(0, 5)) expect(after).toContain(id);
    // Delete engine data cannot be undone and the staging repo can hold real history, so live it needs a second, explicit opt-in naming the repo.
    const confirmed = !LIVE || process.env.JOURNEY_CONFIRM_DELETE === REPO;
    if (!confirmed) {
      record(test, "W8", "events arrived, gaps (delete NOT run)", "5, 0");
      console.log(`W8: Delete engine data was not run: set JOURNEY_CONFIRM_DELETE=${REPO} to allow it.`);
      await clean(page, errors);
      test.skip(true, `the delete step needs JOURNEY_CONFIRM_DELETE=${REPO}; the five-events check passed and the delete was not run`);
    }
    await sheet(page);
    await t(page, "tm-delete").click();
    await t(page, "tm-delete-yes").click();
    const empties = ["tm-agents-empty", "tm-lanes-empty", "tm-log-empty", "tm-plan-none", "tm-usage-empty"];
    for (const id of empties) await expect(t(page, id)).toBeVisible();
    await reload(page); // the deletion is final: this is the last journey that needs data
    for (const id of empties) await expect(t(page, id)).toBeVisible();
    record(test, "W8", "events arrived, gaps, empty panels after delete", `5, 0, ${empties.length}`);
    await clean(page, errors);
  });
});
