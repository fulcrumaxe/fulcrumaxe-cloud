// apps/workspace/e2e/roles-autonomy.spec.ts
//
// D#7 DP10b: the Roles app's Autonomy view. The built cloud dist is served by fixture-server.mjs; the six v1 calls the view makes are
// answered by page.route() from fixtures that packages/api/test/contract.test.ts validates against the real response schemas (and that
// were dumped from the real routes), so the fake cannot drift from the contract. What the server decides (the preset's moves, what is in
// effect, the refusals) is proved against real Postgres in packages/api/test/ask-settings.test.ts and decision-settings.test.ts; here the
// subject is the page: what it shows, the one request each action sends, and every state, including the way back.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page, type Route } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const V1 = join(SCRIPT_DIR, "..", "..", "..", "packages", "api", "fixtures", "v1");
const fx = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const REPOS = fx("listRepos", "200-page.json");
const DIALS = fx("getDecisionSettings", "200-ok.json");
// The class-2 (`human_over_the_loop`) entries of catalogue v4 (packages/decisions/src/catalogue.ts), in catalogue order. This list is the
// criterion, written out here and not read from the fixture the page renders, so a page that shows the wrong dials fails.
const CLASS2 = [
  "nonbreaking_refactor_approach",
  "test_strategy_choice",
  "runner_run_on_member_plan",
  "start_work_small",
  "start_work_bug",
  "start_work_doc",
  "launch_sub_item",
  "publish_deprecation_notice",
];
const ADJUSTABLE = CLASS2.length;
const ASK = fx("getAskSettings", "200-ok.json");
const ASK_BALANCED = fx("getAskSettings", "200-balanced.json");
const PREVIEW = fx("previewDecisionPreset", "200-ok.json");
const APPLIED = fx("applyDecisionPreset", "200-ok.json");
const DIAL_SET = fx("setDecisionDial", "200-ok.json");
const DIAL_RESET = DIAL_SET; // the reset answers in the same shape as a dial write
const ASK_SET = fx("setAskSetting", "200-ok.json");
const member = <T extends object>(v: T) => ({ ...v, can_change: false });

const WIN = `#windows-container .fulc-window[data-app-id="roles"]`;
const tid = (page: Page, id: string) => page.locator(`${WIN} [data-testid="${id}"]`);
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const wm = (page: Page, act: "open" | "close") =>
  page.evaluate((a) => (window as unknown as { FULCWM: Record<string, (id: string) => void> }).FULCWM[a]("roles"), act);
const askRow = (page: Page, type: string) => page.locator(`${WIN} [data-testid="au-ask"][data-ask="${type}"]`);
const dialRow = (page: Page, type: string) => page.locator(`${WIN} [data-testid="au-dial"][data-dial="${type}"]`);
const online = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("online")));

interface Opts {
  dials?: unknown;
  /** The ask-settings reply, or a function of the read's number (1 is the first). */
  ask?: unknown | ((n: number) => unknown);
  /** Answers a POST; the default echoes the matching fixture. */
  post?: (route: Route, tail: string, body: Record<string, unknown>) => Promise<void> | void;
}
interface Seen {
  gets: { dials: number; ask: number };
  posts: { tail: string; body: Record<string, unknown> }[];
  appErrors: string[];
}

async function boot(page: Page, opts: Opts = {}): Promise<Seen> {
  const seen: Seen = { gets: { dials: 0, ask: 0 }, posts: [], appErrors: [] };
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && seen.appErrors.push(m.text()));
  page.on("pageerror", (e) => seen.appErrors.push(`pageerror: ${e.message}`));
  await page.route("**/api/v1/repos**", async (route) => {
    const url = new URL(route.request().url());
    const m = url.pathname.match(/^\/api\/v1\/repos\/([^/]+)\/(.+)$/);
    if (!m) return json(route, 200, REPOS);
    const tail = m[2];
    if (route.request().method() === "GET") {
      if (tail === "decision-settings") {
        seen.gets.dials++;
        return json(route, 200, opts.dials ?? DIALS);
      }
      if (tail === "ask-settings") {
        seen.gets.ask++;
        return json(route, 200, typeof opts.ask === "function" ? (opts.ask as (n: number) => unknown)(seen.gets.ask) : (opts.ask ?? ASK));
      }
      return json(route, 200, { data: [] }); // the Roles tab's own read
    }
    const body = route.request().postDataJSON();
    seen.posts.push({ tail, body });
    if (opts.post) return opts.post(route, tail, body);
    const reply: Record<string, unknown> = {
      "decision-settings/preset/preview": PREVIEW,
      "decision-settings/preset": APPLIED,
      "decision-settings/dial": DIAL_SET,
      "decision-settings/reset": DIAL_RESET,
      "ask-settings": ASK_SET,
    };
    return json(route, 200, reply[tail]);
  });
  await bootToDesktop(page);
  await wm(page, "open");
  await expect(page.locator(WIN)).toBeVisible();
  return seen;
}

async function openAutonomy(page: Page) {
  await tid(page, "roles-tab-autonomy").click();
  await expect(tid(page, "au-levels")).toBeVisible();
}

test.describe("D#7 DP10b: Roles, Autonomy", () => {
  test("a third tab; nothing is read until it opens; then one read of each store", async ({ page }) => {
    const seen = await boot(page);
    await expect(page.locator(`${WIN} [role="tablist"] [role="tab"]`)).toHaveText(["Roles", "Run limits", "Autonomy"]);
    expect(seen.gets).toEqual({ dials: 0, ask: 0 });
    await openAutonomy(page);
    await expect(tid(page, "au-dial")).toHaveCount(ADJUSTABLE);
    expect(await tid(page, "au-dial").evaluateAll((els) => els.map((e) => e.getAttribute("data-dial")))).toEqual(CLASS2);
    expect(seen.gets).toEqual({ dials: 1, ask: 1 });
    expect(seen.posts).toEqual([]);
    expect(seen.appErrors).toEqual([]);
  });

  test("one page: the dials and the answer settings together, the two oversight levels stated, names and no ids", async ({ page }) => {
    await boot(page);
    await openAutonomy(page);
    await expect(tid(page, "au-levels")).toContainText("the team acts and you monitor it");
    await expect(tid(page, "au-levels")).toContainText("the team never goes ahead without your approval");
    await expect(tid(page, "au-roles-pointer")).toHaveText("To set the mode for each role, use the Roles tab.");
    await expect(tid(page, "au-active")).toHaveText("Right now: the default settings.");
    await expect(tid(page, "au-preset-cautious").locator(".au-preset-role")).toHaveText("you approve");
    await expect(dialRow(page, "test_strategy_choice")).toContainText("How to test a change");
    await expect(dialRow(page, "test_strategy_choice").getByTestId("au-dial-select")).toHaveValue("ask");
    await expect(dialRow(page, "test_strategy_choice")).toContainText("Default");
    await expect(askRow(page, "test_strategy_choice")).toContainText("In effect: 1 day, then keep waiting and flag it as overdue");
    await expect(askRow(page, "*")).toContainText("Every decision type");
    await expect(tid(page, "au-notify")).toHaveValue("email");
    // Class 3 and class 1 are listed, with no control at all.
    await expect(tid(page, "au-fixed-human_in_the_loop")).toContainText("Publishing a release: the team always asks you first");
    await expect(tid(page, "au-fixed-automated_with_monitoring").locator("li")).toHaveCount(2);
    await expect(page.locator(`${WIN} [data-testid^="au-fixed-"] :is(button, input, select)`)).toHaveCount(0);
    // No internal id and no "null" or "undefined" anywhere on the page, in text or in any option.
    const text = await tid(page, "au-body").innerText();
    expect(text).not.toMatch(/[a-z]+_[a-z]+|undefined|null/);
    const options = await page.locator(`${WIN} [data-testid="au-body"] option`).allInnerTexts();
    for (const o of options) expect(o, o).not.toMatch(/[a-z]+_[a-z]+|undefined|null/);
  });

  test("the fixed rules are a plain list from the server's own: no control inside it, and each one named", async ({ page }) => {
    await boot(page);
    await openAutonomy(page);
    const items = tid(page, "au-invariant");
    await expect(items).toHaveCount(DIALS.invariants.length);
    await expect(items).toHaveText(DIALS.invariants.map((i: { label: string }) => i.label));
    await expect(page.locator(`${WIN} [data-testid="au-invariants"] :is(button, input, select, textarea, [role="switch"], [role="checkbox"], a)`)).toHaveCount(0);
    await expect(page.locator(`${WIN} h3`).filter({ hasText: "Fixed rules, not settings" })).toBeVisible();
  });

  test("a preset shows exactly the dials it moves before anything is written; cancelling writes nothing and returns focus", async ({ page }) => {
    const seen = await boot(page, { post: (route, tail) => json(route, 200, tail.endsWith("preview") ? PREVIEW : APPLIED) });
    await openAutonomy(page);
    await tid(page, "au-preset-balanced").click();
    await expect(tid(page, "au-preview")).toBeVisible();
    await expect(tid(page, "au-move")).toHaveText([
      "How to restructure code without changing what it does: Ask me first to Go ahead and tell me",
      "How to test a change: Ask me first to Go ahead and tell me",
      "Starting a small piece of work: Ask me first to Go ahead and tell me",
      "Starting a bug fix: Ask me first to Go ahead and tell me",
      "Starting a documentation change: Ask me first to Go ahead and tell me",
      "Starting one part of a larger piece of work: Ask me first to Go ahead and tell me",
    ]);
    await expect(page.locator(`${WIN} #au-preview-h`)).toBeFocused();
    expect(seen.posts.map((p) => p.tail)).toEqual(["decision-settings/preset/preview"]);
    expect(seen.posts[0].body).toEqual({ preset: "balanced" });
    await tid(page, "au-preview-cancel").click();
    await expect(tid(page, "au-preview")).toHaveCount(0);
    await expect(tid(page, "au-preset-balanced")).toBeFocused();
    expect(seen.posts).toHaveLength(1);
  });

  test("confirming a preset sends one write, shows what the server answered, and says how many decisions changed", async ({ page }) => {
    const seen = await boot(page, {
      post: (route, tail) => json(route, 200, tail.endsWith("preview") ? PREVIEW : APPLIED),
      ask: (n: number) => (n === 1 ? ASK : ASK_BALANCED),
    });
    await openAutonomy(page);
    await tid(page, "au-preset-balanced").click();
    await tid(page, "au-preview-apply").click();
    await expect(tid(page, "au-status")).toHaveText("Balanced applied. 6 decisions changed.");
    expect(seen.posts.map((p) => p.tail)).toEqual(["decision-settings/preset/preview", "decision-settings/preset"]);
    expect(seen.posts[1].body).toEqual({ preset: "balanced" });
    await expect(tid(page, "au-active")).toHaveText("Right now: Balanced");
    await expect(tid(page, "au-preset-balanced")).toHaveAttribute("aria-pressed", "true");
    await expect(dialRow(page, "test_strategy_choice").getByTestId("au-dial-select")).toHaveValue("announce");
    await expect(dialRow(page, "test_strategy_choice")).toContainText("From the Balanced preset");
    await expect(tid(page, "au-preview")).toHaveCount(0);
    // WCAG 2.4.3: the Switch button left the page with the preview, so focus returns to the preset button that opened it, not to the page.
    await expect(tid(page, "au-preset-balanced")).toBeFocused();
    // What is in effect is re-read after the preset, so the answer settings follow the new dials.
    await expect(askRow(page, "test_strategy_choice")).toContainText("then go ahead with the agent's recommendation");
    await expect(askRow(page, "publish_release_artifact")).toContainText("then keep waiting and flag it as overdue");
  });

  test("a preset the repo already matches says nothing changes", async ({ page }) => {
    await boot(page, { post: (route) => json(route, 200, { ...PREVIEW, moves: [] }) });
    await openAutonomy(page);
    await tid(page, "au-preset-balanced").click();
    await expect(tid(page, "au-preview-none")).toHaveText("Nothing changes. These decisions already match Balanced.");
    await expect(tid(page, "au-move")).toHaveCount(0);
  });

  test("a dial change is one write of the chosen value, only the adjustable (class 2) dials have a control, and each offers only what its entry allows", async ({ page }) => {
    const seen = await boot(page);
    await openAutonomy(page);
    await expect(tid(page, "au-dial-select")).toHaveCount(ADJUSTABLE);
    expect(await tid(page, "au-dial-select").evaluateAll((els) => els.map((e) => e.closest('[data-testid="au-dial"]')?.getAttribute("data-dial")))).toEqual(CLASS2);
    const onMemberPlan = dialRow(page, "runner_run_on_member_plan").getByTestId("au-dial-select");
    expect(await onMemberPlan.locator("option").allInnerTexts()).toEqual(DIALS.dials.find((d: { decision_type: string }) => d.decision_type === "runner_run_on_member_plan").allowed_dispositions.map((v: string) => ({ ask: "Ask me first", announce: "Go ahead and tell me", act: "Go ahead" })[v]));
    const select = dialRow(page, "test_strategy_choice").getByTestId("au-dial-select");
    await select.selectOption("act");
    expect(seen.posts).toEqual([]); // choosing is not saving
    await dialRow(page, "test_strategy_choice").getByTestId("au-dial-apply").click();
    await expect(tid(page, "au-status")).toHaveText("How to test a change: Go ahead. Saved.");
    expect(seen.posts).toEqual([{ tail: "decision-settings/dial", body: { decision_type: "test_strategy_choice", disposition: "act" } }]);
    await expect(dialRow(page, "test_strategy_choice").getByTestId("au-dial-apply")).toBeVisible();
  });

  test("the way back for a dial: 'Use the default' appears only on a dial someone set, sends one reset, and the row reads Default after a reload", async ({ page }) => {
    const changed = {
      ...DIALS,
      dials: DIALS.dials.map((d: { decision_type: string }) => (d.decision_type === "test_strategy_choice" ? { ...d, disposition: "act", source: "override", version: 1 } : d)),
    };
    const reset = {
      ...DIALS,
      dials: DIALS.dials.map((d: { decision_type: string }) => (d.decision_type === "test_strategy_choice" ? { ...d, source: "default", preset: null } : d)),
    };
    let current = changed;
    const seen = await boot(page, {
      post: async (route, tail) => {
        if (tail === "decision-settings/reset") current = reset;
        return json(route, 200, current);
      },
    });
    // The read answers from `current`, so the reload below sees what the reset wrote.
    await page.route("**/api/v1/repos/*/decision-settings", (route) => (route.request().method() === "GET" ? json(route, 200, current) : route.fallback()));
    await page.reload();
    await bootToDesktop(page);
    await wm(page, "open");
    await openAutonomy(page);
    const row = dialRow(page, "test_strategy_choice");
    await expect(row.getByTestId("au-dial-reset")).toHaveText("Use the default");
    await expect(dialRow(page, "nonbreaking_refactor_approach").getByTestId("au-dial-reset")).toHaveCount(0);
    await row.getByTestId("au-dial-reset").click();
    await expect(tid(page, "au-status")).toHaveText("How to test a change: back to the default. Saved.");
    expect(seen.posts).toEqual([{ tail: "decision-settings/reset", body: { decision_type: "test_strategy_choice" } }]);
    await expect(row.getByTestId("au-dial-reset")).toHaveCount(0);
    await page.reload();
    await bootToDesktop(page);
    await wm(page, "open");
    await openAutonomy(page);
    await expect(dialRow(page, "test_strategy_choice")).toContainText("Default");
    await expect(dialRow(page, "test_strategy_choice").getByTestId("au-dial-reset")).toHaveCount(0);
  });

  test("a dial change that fails shows the server's reason on its row (422), a fixed sentence otherwise, and keeps the typed choice", async ({ page }) => {
    let status = 422;
    await boot(page, {
      post: (route) =>
        json(route, status, { error: { code: status === 422 ? "invalid_input" : "boom", message: status === 422 ? "this decision type allows only: ask" : "SECRET internals", request_id: "r1" }, details: [{ path: "disposition", code: "not_allowed" }] }),
    });
    await openAutonomy(page);
    const row = dialRow(page, "test_strategy_choice");
    await row.getByTestId("au-dial-select").selectOption("act");
    await row.getByTestId("au-dial-apply").click();
    await expect(row.getByTestId("au-error")).toHaveText("this decision type allows only: ask");
    await expect(row.getByTestId("au-dial-select")).toHaveValue("act");
    await expect(row.getByTestId("au-dial-select")).toHaveAttribute("aria-invalid", "true");
    for (const [code, text] of [[403, "Only owners and admins can change these settings."], [500, "That change couldn't be saved. Try again."]] as const) {
      status = code;
      await row.getByTestId("au-dial-apply").click();
      await expect(row.getByTestId("au-error")).toHaveText(text);
    }
    await expect(page.locator(`${WIN}`)).not.toContainText("SECRET");
  });

  test("answer settings: the window and the outcome are one write with the other values kept; the outcome list is the entry's own", async ({ page }) => {
    const seen = await boot(page);
    await openAutonomy(page);
    const refactor = askRow(page, "nonbreaking_refactor_approach");
    expect(await refactor.getByTestId("au-outcome").locator("option").allInnerTexts()).toEqual([
      "Use the default",
      "Keep waiting and flag it as overdue",
      "Go ahead with the agent's recommendation",
    ]);
    const release = askRow(page, "publish_release_artifact");
    expect(await release.getByTestId("au-outcome").locator("option").allInnerTexts()).toEqual(["Use the default", "Keep waiting and flag it as overdue"]);
    await refactor.getByTestId("au-window").fill("90");
    await refactor.getByTestId("au-outcome").selectOption("proceed_recommended");
    expect(seen.posts).toEqual([]);
    await refactor.getByTestId("au-ask-save").click();
    await expect(tid(page, "au-status")).toContainText("saved.");
    expect(seen.posts).toEqual([
      { tail: "ask-settings", body: { scope: "account", decision_type: "nonbreaking_refactor_approach", answer_window_minutes: 90, timeout_outcome: "proceed_recommended", notify: null } },
    ]);
  });

  test("a window outside the bounds, or not a whole number, is refused on the spot with nothing sent; empty means the default", async ({ page }) => {
    const seen = await boot(page);
    await openAutonomy(page);
    const row = askRow(page, "test_strategy_choice");
    for (const bad of ["14", "20161", "1.5", "abc", "-5"]) {
      await row.getByTestId("au-window").fill(bad);
      await row.getByTestId("au-ask-save").click();
      await expect(row.getByTestId("au-error")).toHaveText("Enter whole minutes from 15 to 20160, or leave it empty.");
      await expect(row.getByTestId("au-window")).toBeFocused();
      await expect(row.getByTestId("au-window")).toHaveAttribute("aria-invalid", "true");
    }
    expect(seen.posts).toEqual([]);
    await row.getByTestId("au-window").fill("");
    await row.getByTestId("au-ask-save").click();
    expect(seen.posts).toEqual([
      { tail: "ask-settings", body: { scope: "account", decision_type: "test_strategy_choice", answer_window_minutes: null, timeout_outcome: null, notify: null } },
    ]);
  });

  test("changing only the outcome keeps the stored window, and changing only the window keeps the stored outcome", async ({ page }) => {
    const seen = await boot(page, { ask: ASK_SET });
    await openAutonomy(page);
    const row = askRow(page, "test_strategy_choice");
    await expect(row.getByTestId("au-outcome")).toHaveValue("proceed_recommended");
    await row.getByTestId("au-outcome").selectOption("stop_and_flag");
    await row.getByTestId("au-ask-save").click();
    await expect(tid(page, "au-status")).toContainText("saved.");
    await row.getByTestId("au-window").fill("120");
    await row.getByTestId("au-ask-save").click();
    await expect.poll(() => seen.posts.length).toBe(2);
    expect(seen.posts.map((p) => p.body)).toEqual([
      { scope: "account", decision_type: "test_strategy_choice", answer_window_minutes: 90, timeout_outcome: "stop_and_flag", notify: null },
      { scope: "account", decision_type: "test_strategy_choice", answer_window_minutes: 120, timeout_outcome: "proceed_recommended", notify: null },
    ]);
  });

  test("the way back: 'Use the default' hands a setting back with one write, and the earlier values stay in the server's history", async ({ page }) => {
    const seen = await boot(page, { ask: ASK_SET, post: (route) => json(route, 200, ASK) });
    await openAutonomy(page);
    const row = askRow(page, "test_strategy_choice");
    await expect(row.getByTestId("au-window")).toHaveValue("90");
    await row.getByTestId("au-ask-clear").click();
    await expect(tid(page, "au-status")).toContainText("using the default");
    expect(seen.posts).toEqual([
      { tail: "ask-settings", body: { scope: "account", decision_type: "test_strategy_choice", answer_window_minutes: null, timeout_outcome: null, notify: null } },
    ]);
    await expect(row.getByTestId("au-window")).toHaveValue("");
    await expect(row.getByTestId("au-outcome")).toHaveValue("");
  });

  test("scope: 'This repo' writes a repo override, and the repo's own values are the ones shown", async ({ page }) => {
    const repoStored = { ...ASK_SET, rows: ASK_SET.rows.map((r: { decision_type: string }) => (r.decision_type === "test_strategy_choice" ? { ...r, account: null, repo: ASK_SET.rows.find((x: { decision_type: string }) => x.decision_type === "test_strategy_choice").account } : r)) };
    const seen = await boot(page, { ask: repoStored });
    await openAutonomy(page);
    const row = askRow(page, "test_strategy_choice");
    await expect(row.getByTestId("au-window")).toHaveValue(""); // account scope: nothing stored there
    await tid(page, "au-scope").selectOption("repo");
    await expect(row.getByTestId("au-window")).toHaveValue("90");
    await row.getByTestId("au-window").fill("45");
    await row.getByTestId("au-ask-save").click();
    expect(seen.posts[0].body).toMatchObject({ scope: "repo", decision_type: "test_strategy_choice", answer_window_minutes: 45, timeout_outcome: "proceed_recommended" });
  });

  test("notify is an account setting: one write on the * key, keeping that key's window and outcome", async ({ page }) => {
    const star = { ...ASK.rows[0], account: { answer_window_minutes: 120, timeout_outcome: "stop_and_flag", notify: null, version: 1 } };
    const seen = await boot(page, { ask: { ...ASK, rows: [star, ...ASK.rows.slice(1)] } });
    await openAutonomy(page);
    await tid(page, "au-notify").selectOption("none");
    await tid(page, "au-notify-apply").click();
    await expect(tid(page, "au-status")).toHaveText("Don't email me. Saved.");
    expect(seen.posts).toEqual([
      { tail: "ask-settings", body: { scope: "account", decision_type: "*", answer_window_minutes: 120, timeout_outcome: "stop_and_flag", notify: "none" } },
    ]);
  });

  test("a plain member sees the same page with no control, and the reason", async ({ page }) => {
    const seen = await boot(page, { dials: member(DIALS), ask: member(ASK) });
    await openAutonomy(page);
    await expect(tid(page, "au-readonly")).toHaveText("Only owners and admins can change these settings.");
    await expect(page.locator(`${WIN} [data-testid="au-body"] :is(button, input, select)`)).toHaveCount(0);
    await expect(dialRow(page, "test_strategy_choice").getByTestId("au-dial-value")).toHaveText("Ask me first");
    await expect(askRow(page, "test_strategy_choice")).toContainText("In effect: 1 day");
    await expect(tid(page, "au-notify-value")).toHaveText("Notifications: Email me");
    await expect(tid(page, "au-levels")).toBeVisible();
    await expect(tid(page, "au-invariant")).toHaveCount(DIALS.invariants.length);
    expect(seen.posts).toEqual([]);
  });

  test("a 409 says the settings changed and shows the latest; a failed read shows the app's own sentence", async ({ page }) => {
    const seen = await boot(page, {
      post: (route) => json(route, 409, { error: { code: "ask_setting_changed", message: "server words", request_id: "r1" } }),
    });
    await openAutonomy(page);
    const row = askRow(page, "test_strategy_choice");
    await row.getByTestId("au-window").fill("60");
    await row.getByTestId("au-ask-save").click();
    await expect(row.getByTestId("au-error")).toHaveText("That changed while you were saving. The latest settings are shown.");
    // The error is drawn first and the reload is sent right after it, so the second read is not yet counted when the sentence appears.
    await expect.poll(() => seen.gets.ask).toBe(2); // the reload after the conflict
    expect(seen.posts).toHaveLength(1);
  });

  test("live: a refresh reloads both reads, and a typed, unsaved change survives it", async ({ page }) => {
    // The shell's account stream stays open and silent for this test (the request is never answered). With the fixture's default answer,
    // an `idle` frame, the stream closes, and the click that opens the tab wakes it: the reopen then lets a refresh through at a moment
    // that depends on network timing, on either side of the view's first read. Here the only refreshes are the ones the test sends.
    await page.route("**/api/v1/events", () => {});
    const seen = await boot(page);
    await page.evaluate(async () => (await import(new URL("core/cloud-live.js", document.baseURI).href)).default.start());
    await openAutonomy(page);
    await page.clock.runFor(60_000); // the shell's backstop lets one refresh through a minute apart
    await online(page);
    await expect.poll(() => seen.gets).toEqual({ dials: 2, ask: 2 });
    const row = askRow(page, "test_strategy_choice");
    await row.getByTestId("au-window").fill("77");
    await page.clock.runFor(60_000);
    await online(page);
    await expect.poll(() => seen.gets).toEqual({ dials: 3, ask: 3 });
    await expect(row.getByTestId("au-window")).toHaveValue("77");
  });

  test("keyboard: tab order reaches the presets, every dial and every answer setting, and a preset opens with Enter", async ({ page }) => {
    await boot(page, { post: (route) => json(route, 200, PREVIEW) });
    await openAutonomy(page);
    await tid(page, "au-preset-cautious").focus();
    await page.keyboard.press("Tab");
    await expect(tid(page, "au-preset-balanced")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(tid(page, "au-preview")).toBeVisible();
    await expect(page.locator(`${WIN} #au-preview-h`)).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(tid(page, "au-preview-apply")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(tid(page, "au-preview-cancel")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(tid(page, "au-preset-balanced")).toBeFocused();
  });

  test("no accessibility violation (serious or critical) in the owner view, the preview or the member view", async ({ page }) => {
    await boot(page, { post: (route) => json(route, 200, PREVIEW) });
    await openAutonomy(page);
    const scan = async () =>
      (await new AxeBuilder({ page }).include(WIN).exclude(`${WIN} .window-titlebar`).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze()).violations.filter(
        (v) => v.impact === "serious" || v.impact === "critical"
      );
    expect((await scan()).map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
    await tid(page, "au-preset-balanced").click();
    await expect(tid(page, "au-preview")).toBeVisible();
    expect((await scan()).map((v) => v.id)).toEqual([]);
  });

  test("the view source has no sink and no direct fetch, and makes only the seven calls the API defines", () => {
    const src = readFileSync(join(SCRIPT_DIR, "..", "apps", "roles", "roles-autonomy.js"), "utf8");
    expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(src).not.toMatch(/\bfetch\(/);
    expect(src).not.toMatch(/"(PATCH|DELETE)"/);
    // The only PUTs are the S5-h section's (builds at once, auto-start limit, margin, discovery); the dial and answer stores are POST only.
    expect([...src.matchAll(/api\("PUT", (repoPath\(repoId, "[a-z/-]+"\)|[^,]+)/g)].map((m) => m[1]).sort()).toEqual(['ACCOUNT + "autostart-envelope"', 'ACCOUNT + "envelope-margin"', "base", 'repoPath(repoId, "discovery")']);
    expect(src.match(/"PUT"/g)).toHaveLength(4); // no indirect method: the literal appears exactly where the four calls are
    expect(src).not.toMatch(/FULC\.(state|config|window|backend|events)/);
    const paths = [...new Set([...src.matchAll(/api\("(GET|POST)", repoPath\(repoId, "([a-z/-]+)"\)/g)].map((m) => `${m[1]} ${m[2]}`))].sort();
    expect(paths).toEqual(
      ["GET ask-settings", "GET decision-settings", "POST ask-settings", "POST decision-settings/dial", "POST decision-settings/preset", "POST decision-settings/preset/preview", "POST decision-settings/reset"].sort()
    );
  });

  test("phone: a dial row and an answer row stack and stay reachable", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "phone", "phone project only");
    await boot(page);
    await openAutonomy(page);
    await dialRow(page, "test_strategy_choice").scrollIntoViewIfNeeded();
    await expect(dialRow(page, "test_strategy_choice").getByTestId("au-dial-apply")).toBeVisible();
    await askRow(page, "test_strategy_choice").scrollIntoViewIfNeeded();
    await expect(askRow(page, "test_strategy_choice").getByTestId("au-ask-save")).toBeVisible();
  });
});
