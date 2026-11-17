// apps/workspace/e2e/journey-engine-operate.spec.ts
//
// The operate journeys O1 to O9, the cancel journey (OC) and the operate-off journey (OF). Each acts only through the app's buttons and forms with real
// clicks, reloads and checks what it did, and undoes it; numbers go to the ledger (journey.ts). With no JOURNEY_LIVE it is a dry run on the built dist
// against FakeCloud; with JOURNEY_LIVE=1 it runs through playwright.journeys.config.ts on staging. e2e/engine-operate-journeys.md lists the prerequisites
// and, for a failed undo, the commands that put each state back.
import { test, expect, type Page } from "@playwright/test";
import { waitForDesktop } from "./helpers/boot";
import { FakeCloud, LIVE, WAIT, confirmDestructive, ledger, machine, repoName } from "./helpers/journey";
const WIN = `#windows-container .fulc-window[data-app-id="team"]`;
const NY = `#windows-container .fulc-window[data-app-id="needs-you"]`;
const t = (page: Page, id: string) => page.locator(`${WIN} [data-testid="${id}"]`);
const REFUSAL_SENTENCES = /could not verify|different runner|different repository|expired|newer command|engine is halted|Operate is off|host is not running|no longer open|not running|ceiling|runner refused it/;
// The sentences the app gives for a refusal the cloud's command route answers with a 409 (engine-commands.ts), so a fake that drifts from it shows here.
const SAID_HALTED = "The engine is halted, so this command isn't allowed.";
const SAID_OPERATE_OFF = "Operate is off for this repository. Turn it on first.";
let fake: FakeCloud;
/** Undo steps, run last-in first after each journey, whatever happened (a halt or a dial left behind would poison the next journey). `failed` is whether the journey failed. */
interface Undo { name: string; run: (failed: boolean) => Promise<void> }
let undo: Undo[] = [];
const onUndo = (name: string, run: Undo["run"]) => undo.push({ name, run });
/** The agent O4 asked for, handed to O5 (which stops it). Null once it has been stopped. */
let spawned: string | null = null;
test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "one device is enough for a journey; the Team specs cover the three");
  undo = [];
  fake = new FakeCloud();
  if (!LIVE) await fake.install(page);
  await page.goto("/");
  await waitForDesktop(page);
});
test.afterEach(async ({}, info) => {
  // Every undo step runs in its own try, so one that fails never hides the rest, and the fake is always disposed. Then they are named together.
  const failures: string[] = [];
  try {
    for (const step of [...undo].reverse()) {
      try { await step.run(info.status !== info.expectedStatus); } catch (e) { failures.push(`${step.name}: ${e instanceof Error ? e.message : String(e)}`); }
    }
  } finally {
    fake?.dispose();
  }
  if (failures.length > 0) throw new Error(`${failures.length} undo step(s) failed, so the state may be left changed (see "Failed undo recovery" in engine-operate-journeys.md):\n- ${failures.join("\n- ")}`);
});
/** Opens the Team window (a reload may restore it) on the journey's repo. */
async function team(page: Page): Promise<void> {
  if (!(await page.locator(WIN).isVisible())) await page.locator('.dock-icon[data-app-id="team"]').click();
  await expect(page.locator(WIN)).toBeVisible();
  await expect(page.locator(WIN)).not.toHaveClass(/opening/);
  await expect(t(page, "tm-loading")).toHaveCount(0);
  if (LIVE) await t(page, "tm-repo").selectOption({ label: repoName() });
  await expect(t(page, "tm-operate")).toBeVisible();
}
async function reload(page: Page): Promise<void> {
  await page.reload();
  await waitForDesktop(page);
  await team(page);
}
const cmdRow = (page: Page, text: RegExp) => page.locator(`${WIN} [data-testid="tm-cmd"]`).filter({ hasText: text }).first();
/** Waits for a command row to reach a state and returns the seconds it took. */
async function reaches(page: Page, text: RegExp, state: string): Promise<number> {
  const t0 = Date.now();
  await expect(cmdRow(page, text).locator('[data-testid="tm-cmd-state"]')).toHaveText(state, { timeout: WAIT });
  return Math.round((Date.now() - t0) / 1000);
}
/** Presses a send button; `onSent` runs the moment the command is on its way, before any wait, so an undo knows what to take back. */
async function sendAndSee(page: Page, button: string, row: RegExp, journey: string, name: string, onSent?: () => void): Promise<void> {
  await t(page, button).click();
  await expect(t(page, "tm-live")).toContainText("Sent");
  onSent?.();
  ledger(journey, name, await reaches(page, row, "Applied"));
  await reload(page);
  await expect(cmdRow(page, row).locator('[data-testid="tm-cmd-state"]')).toHaveText("Applied"); // the reload keeps the state
}
const reviewerStops = (page: Page) => t(page, "tm-agent").filter({ hasText: /code.?reviewer/i }).locator('[data-testid="tm-stop"]');
/** The stop buttons' focus keys ("stop-<agent id>") of the code reviewers now listed: the agent's id as the page knows it. */
const reviewerKeys = async (page: Page): Promise<string[]> => (await reviewerStops(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-focus") ?? ""))).filter((k) => k !== "");
/** Stops the agent with this key through the confirm step and waits until it is gone. */
async function stopByKey(page: Page, key: string): Promise<void> {
  const button = page.locator(`${WIN} [data-testid="tm-stop"][data-focus="${key}"]`);
  await button.click();
  await t(page, "tm-stop-yes").click();
  await expect(button).toHaveCount(0, { timeout: WAIT });
}
test("O1 pause the loop, then resume it", async ({ page }) => {
  await team(page);
  let paused = false;
  onUndo("resume the loop", async () => { if (paused) { await t(page, "tm-op-resume").click(); await expect(t(page, "tm-live")).toContainText("Sent"); } }); // a failure anywhere after the pause is sent leaves the loop running again
  await sendAndSee(page, "tm-op-pause", /Pause the loop/, "O1", "pause_applied_s", () => { paused = true; }); // set before the wait: a pause that never shows applied may still land
  machine("O1", "loop_ticks_in_20_min", 0);
  await sendAndSee(page, "tm-op-resume", /Resume the loop/, "O1", "resume_applied_s");
  paused = false;
  machine("O1", "loop_ticks_within_2_min_of_resume", 1);
});
test("O2 start the day", async ({ page }) => {
  await team(page);
  await sendAndSee(page, "tm-op-start", /Start the day/, "O2", "start_day_applied_s");
  machine("O2", "start_day_tick_ran", 1);
  machine("O2", "plan_received_at_updated", 1); // no undo: a started day is a day
});
test("O3 answer an engine ask from Needs-you with a note", async ({ page }) => {
  // Decided before any wait, so the serial group never fails on it: the answer buttons (EB-13b part 2) are not in this tree yet. Live runs happen after they merge.
  test.skip(!LIVE, "the answer buttons on engine asks (EB-13b part 2) are not in this tree yet");
  await page.locator('.dock-icon[data-app-id="needs-you"]').click();
  const row = page.locator(`${NY} [data-testid="ny-row"][data-kind="engine"]`).first();
  await expect(row).toBeVisible({ timeout: WAIT });
  const approve = row.getByRole("button", { name: /^Approve/ });
  await row.getByRole("textbox").fill("approved from the journey");
  await approve.click();
  await expect(row).toContainText("sent");
  await expect(row).toHaveCount(0, { timeout: WAIT }); // applied: the ask is gone
  await page.reload();
  await waitForDesktop(page);
  await page.locator('.dock-icon[data-app-id="needs-you"]').click();
  await expect(page.locator(`${NY} [data-testid="ny-row"][data-kind="engine"]`)).toHaveCount(0);
  ledger("O3", "ask_rows_after_reload", 0);
  machine("O3", "command_state_applied", 1);
  machine("O3", "note_text_in_engine_events_rows", 0);
});
test("O4 request an agent, then see it run", async ({ page }) => {
  await team(page);
  const d = process.env.JOURNEY_SPAWN_DISCUSSION ?? "43";
  const before = await reviewerKeys(page);
  let sent = false;
  // The agent is named by the page only once it runs, so what is recorded at send time is "something was asked for, and these were there before". The undo then
  // stops whatever new code reviewer appears (waiting for it, up to the live limit), and fails loudly if none ever does while the request may still land.
  onUndo("stop the agent O4 requested", async (failed) => {
    if (!sent || !failed) return; // a pass hands the agent to O5, which stops it (and takes it back itself if it fails first)
    await expect.poll(async () => (await reviewerKeys(page)).filter((k) => !before.includes(k)).length, { timeout: WAIT, message: "the requested agent never appeared, so it could not be stopped; check the runner and stop it by hand" }).toBeGreaterThan(0);
    for (const key of (await reviewerKeys(page)).filter((k) => !before.includes(k))) await stopByKey(page, key);
  });
  await t(page, "tm-op-role").selectOption("code-reviewer");
  await t(page, "tm-op-discussion").fill(d);
  await sendAndSee(page, "tm-op-request", new RegExp(`Request a code reviewer for D#${d}`), "O4", "spawn_applied_s", () => { sent = true; });
  await expect.poll(async () => (await reviewerKeys(page)).filter((k) => !before.includes(k)).length, { timeout: WAIT }).toBeGreaterThan(0);
  spawned = (await reviewerKeys(page)).filter((k) => !before.includes(k))[0] ?? null;
  ledger("O4", "code_reviewer_rows", await t(page, "tm-agent").filter({ hasText: /code.?reviewer/i }).count());
  machine("O4", "agent_started_within_15_min", 1);
  machine("O4", "decide_receipt_answered_by_owner", 1);
});
test("O5 stop that agent", async ({ page }) => {
  confirmDestructive("O5 (stop an agent)");
  await team(page);
  const key = LIVE && spawned ? spawned : (await reviewerKeys(page))[0]; // a dry run starts each journey on a fresh fake, so O4's agent is not there
  expect(key, "no code reviewer is running to stop").toBeTruthy();
  const button = page.locator(`${WIN} [data-testid="tm-stop"][data-focus="${key}"]`);
  let stopped = false;
  onUndo("stop the agent O4 requested", async () => { if (!stopped && LIVE && spawned) await stopByKey(page, spawned); });
  await expect(button).toBeVisible({ timeout: WAIT });
  await button.click();
  await expect(t(page, "tm-stop-who")).toContainText("code reviewer");
  await t(page, "tm-stop-yes").click();
  ledger("O5", "stop_applied_s", await reaches(page, /Stop (the code reviewer agent|an agent)/, "Applied")); // once it has stopped, the row can no longer name it
  stopped = true;
  spawned = null;
  await reload(page);
  await expect(page.locator(`${WIN} [data-testid="tm-stop"][data-focus="${key}"]`)).toHaveCount(0, { timeout: WAIT });
  machine("O5", "agent_stopped_within_10_min", 1);
});
test("O6 set the merge dial to ask first, then set a dial by command", async ({ page }) => {
  await team(page);
  const merge = page.locator(`${WIN} [data-dial="engine_merge"]`);
  const select = merge.locator('[data-testid="tm-dial-select"]');
  const before = await select.inputValue();
  let restored = false;
  onUndo("put the merge dial back", async () => { if (!restored) { await select.selectOption(before); await merge.locator('[data-testid="tm-dial-apply"]').click(); } });
  await select.selectOption("ask");
  await merge.locator('[data-testid="tm-dial-apply"]').click();
  await expect(t(page, "tm-live")).toContainText("Dial saved");
  await reload(page);
  await expect(select).toHaveValue("ask");
  ledger("O6", "merge_dial_after_reload_is_ask", 1);
  machine("O6", "decision_asks_after_merge_attempt", 1);
  await t(page, "tm-op-class").selectOption("agent.spawn");
  await t(page, "tm-op-level").selectOption("3");
  await t(page, "tm-op-ttl").selectOption("for_today");
  await sendAndSee(page, "tm-op-setdial", /Set starting agents to level 3/, "O6", "set_dial_applied_s");
  await select.selectOption(before); // put the merge dial back
  await merge.locator('[data-testid="tm-dial-apply"]').click();
  await reload(page);
  await expect(select).toHaveValue(before);
  restored = true;
});
test("O7 let the engine mark a Spec ready: ask first, then go ahead", async ({ page }) => {
  await team(page);
  const row = page.locator(`${WIN} [data-dial="engine_spec_ready"]`);
  const select = row.locator('[data-testid="tm-dial-select"]');
  const before = await select.inputValue();
  let restored = false;
  onUndo("put the Spec-ready dial back", async () => { if (!restored) { await select.selectOption(before); await row.locator('[data-testid="tm-dial-apply"]').click(); } });
  for (const [value, journeyName, asks] of [["ask", "balanced_flip_asks", 1], ["act", "autonomous_flip_status_ready", 1]] as const) {
    await select.selectOption(value);
    await row.locator('[data-testid="tm-dial-apply"]').click();
    await expect(t(page, "tm-live")).toContainText("Dial saved");
    await reload(page);
    await expect(select).toHaveValue(value);
    machine("O7", journeyName, asks);
  }
  await select.selectOption(before);
  await row.locator('[data-testid="tm-dial-apply"]').click();
  await reload(page);
  await expect(select).toHaveValue(before);
  restored = true;
});
test("O8 halt, see it applied, check a command is refused, clear it", async ({ page }) => {
  confirmDestructive("O8 (halt the engine)");
  await team(page);
  let haltSent = false;
  let cleared = false;
  onUndo("clear the halt", async () => {
    if (cleared || !haltSent) return;
    // A journey that failed after the halt was cleared (the later reload or Resume checks) has nothing to undo: the chip is empty, not "Halting…".
    if (!(await t(page, "tm-clear-btn").count()) && !(await t(page, "tm-halt-chip").innerText()).trim()) return;
    if (await t(page, "tm-halt-cancel").count()) await t(page, "tm-halt-cancel").click(); // a confirm left open by a failure
    // The clear button shows once the halt is on its way. If it never does, the halt may still land later: say so loudly rather than leave it.
    await expect(t(page, "tm-clear-btn"), "HALT NOT CLEARED: the halt was sent but no Clear halt button appeared within the halt-apply wait; clear it by hand").toBeVisible({ timeout: WAIT });
    await t(page, "tm-clear-btn").click();
    await t(page, "tm-halt-yes").click();
    await expect(t(page, "tm-halt-chip")).toHaveText("", { timeout: WAIT });
  });
  await t(page, "tm-halt-btn").click();
  await expect(t(page, "tm-halt-confirm-text")).toContainText("now and kills its agents.");
  const t0 = Date.now();
  await t(page, "tm-halt-yes").click();
  haltSent = true;
  await expect(t(page, "tm-halt-chip")).toHaveText("Halting…");
  await expect(t(page, "tm-halt-chip")).toHaveText(/^Halted/, { timeout: WAIT });
  ledger("O8", "halt_applied_s", Math.round((Date.now() - t0) / 1000));
  machine("O8", "survivors", 0);
  machine("O8", "systemd_cgls_processes", 0);
  const posts = fake?.posts.length ?? 0;
  await expect(t(page, "tm-op-resume")).toHaveAttribute("aria-disabled", "true"); // Resume is refused while halted
  await expect(t(page, "tm-op-why")).toHaveText("The engine is halted.");
  if (!LIVE) expect(fake.posts.length).toBe(posts);
  await reload(page);
  await expect(t(page, "tm-halt-chip")).toHaveText(/^Halted/);
  await t(page, "tm-clear-btn").click();
  await t(page, "tm-halt-yes").click();
  await expect(t(page, "tm-halt-chip")).toHaveText("");
  await reload(page);
  await expect(t(page, "tm-halt-chip")).toHaveText("");
  await expect(t(page, "tm-op-resume")).toHaveAttribute("aria-disabled", "false");
  cleared = true;
  ledger("O8", "halt_cleared_after_reload", 1);
  machine("O8", "host_runs_again_after_start", 1);
  if (!LIVE) {
    // A halt the page has not seen yet: the cloud refuses the send with 409 `halted`, and the page says it in the route's own words.
    fake.repo = { ...fake.repo, halted: true };
    const before = fake.posts.length;
    await t(page, "tm-op-start").click();
    await expect(t(page, "tm-live")).toContainText(SAID_HALTED);
    expect(fake.posts.length).toBe(before + 1);
    expect(fake.commands.some((c) => c.kind === "start_day")).toBe(false);
    fake.repo = { ...fake.repo, halted: false };
  }
});
test("O9 a refused command shows its sentence", async ({ page }) => {
  await team(page);
  if (fake) fake.refuse = "ceiling";
  await t(page, "tm-op-role").selectOption("code-reviewer");
  await t(page, "tm-op-discussion").fill(process.env.JOURNEY_REFUSED_DISCUSSION ?? "999999999");
  await t(page, "tm-op-request").click();
  const row = page.locator(`${WIN} [data-testid="tm-cmd"]`).filter({ hasText: /Request a code reviewer/ }).first();
  await expect(row.locator('[data-testid="tm-cmd-state"]')).toHaveText("Refused", { timeout: WAIT });
  await expect(row.locator('[data-testid="tm-cmd-detail"]')).toHaveText(LIVE ? REFUSAL_SENTENCES : "A ceiling set in the cloud does not allow that.");
  await reload(page);
  await expect(page.locator(`${WIN} [data-testid="tm-cmd-detail"]`).first()).toHaveText(LIVE ? REFUSAL_SENTENCES : "A ceiling set in the cloud does not allow that.");
  ledger("O9", "refusal_sentence_shown", 1);
  machine("O9", "merge_refused_exit_code", 5);
  machine("O9", "fixed_line_in_team_log", 1);
});
test("OC cancel a command that is still pending", async ({ page }) => {
  test.skip(LIVE && process.env.JOURNEY_RUNNER_AWAY !== "1", "a live cancel needs the bridge stopped first (JOURNEY_RUNNER_AWAY=1)");
  if (fake) fake.hold = true;
  await team(page);
  await t(page, "tm-op-start").click();
  const row = cmdRow(page, /Start the day/);
  await expect(row.locator('[data-testid="tm-cmd-state"]')).toHaveText("Pending");
  await row.locator('[data-testid="tm-cmd-cancel"]').click();
  await expect(row.locator('[data-testid="tm-cmd-state"]')).toHaveText("Cancelled");
  await reload(page);
  await expect(cmdRow(page, /Start the day/).locator('[data-testid="tm-cmd-state"]')).toHaveText("Cancelled");
  await expect(cmdRow(page, /Start the day/).locator('[data-testid="tm-cmd-cancel"]')).toHaveCount(0);
  ledger("OC", "pending_cancelled_after_reload", 1);
});
test("ORD the cloud refuses in the route's own order when two conditions hold", async ({ page }) => {
  test.skip(LIVE, "a dry check of the fake's refusal order; nothing to do on a live account");
  await team(page);
  const send = async (): Promise<number> => {
    const before = fake.posts.length;
    await t(page, "tm-op-start").click();
    await expect.poll(() => fake.posts.length).toBe(before + 1);
    return fake.commands.length;
  };
  const waiting = Array.from({ length: 20 }, (_, i) => fake.F.command({ id: `c1000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, kind: "start_day", args: {}, state: "pending", expires_at: new Date(Date.now() + 600_000).toISOString() }));
  // Halted and twenty waiting: the count is checked before the insert, and the halt comes from the insert's trigger, so the answer is too_many_pending.
  fake.repo = { ...fake.repo, halted: true };
  fake.commands = waiting;
  await send();
  await expect(t(page, "tm-live")).toContainText("Too many commands are waiting");
  await expect(t(page, "tm-live")).not.toContainText(SAID_HALTED);
  expect(fake.commands.length).toBe(20);
  // No engine session as well: that is checked first of the three.
  fake.connected = false;
  await send();
  await expect(t(page, "tm-live")).toContainText("No engine is connected for this repository");
  expect(fake.commands.length).toBe(20);
  // Operate off beats all of them (the page was not told).
  fake.repo = { ...fake.repo, operate_enabled: false };
  await send();
  await expect(t(page, "tm-live")).toContainText(SAID_OPERATE_OFF);
  expect(fake.commands.length).toBe(20);
  // Only the halt left: now it is `halted`.
  fake.repo = { ...fake.repo, operate_enabled: true };
  fake.connected = true;
  fake.commands = [];
  await send();
  await expect(t(page, "tm-live")).toContainText(SAID_HALTED);
  expect(fake.commands.length).toBe(0);
  ledger("ORD", "refusal_order_checked", 1, "fixture");
});
test("OF operate off locks every control, and turning it on again frees them", async ({ page }) => {
  confirmDestructive("OF (switch operate off)");
  await team(page);
  const controls = ["tm-op-start", "tm-op-pause", "tm-op-resume", "tm-op-request", "tm-op-setdial"];
  const sw = t(page, "tm-op-switch");
  onUndo("switch operate back on", async () => { if (!(await sw.isChecked())) await sw.click(); });
  await sw.click();
  await expect(t(page, "tm-op-why")).toHaveText("Operate is off.");
  const posts = fake?.posts.length ?? 0;
  for (const id of controls) { await expect(t(page, id)).toHaveAttribute("aria-disabled", "true"); await t(page, id).click({ force: true }); }
  for (const id of ["tm-op-role", "tm-op-discussion", "tm-op-class", "tm-op-level", "tm-op-ttl"]) await expect(t(page, id)).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator(`${WIN} [data-testid="tm-dial-apply"][aria-disabled="false"]`)).toHaveCount(0);
  if (!LIVE) expect(fake.posts.length).toBe(posts); // a click on a locked control sends nothing
  await reload(page);
  await expect(t(page, "tm-op-why")).toHaveText("Operate is off.");
  ledger("OF", "locked_controls", controls.length + 5);
  await sw.click();
  await reload(page);
  for (const id of controls) await expect(t(page, id)).toHaveAttribute("aria-disabled", "false");
  if (!LIVE) {
    // Operate switched off behind the page's back: the cloud refuses the send with 409 `operate_off`, in the route's own words.
    fake.repo = { ...fake.repo, operate_enabled: false };
    const before = fake.posts.length;
    await t(page, "tm-op-start").click();
    await expect(t(page, "tm-live")).toContainText(SAID_OPERATE_OFF);
    expect(fake.posts.length).toBe(before + 1);
    expect(fake.commands.some((c) => c.kind === "start_day")).toBe(false);
    fake.repo = { ...fake.repo, operate_enabled: true };
  }
});
