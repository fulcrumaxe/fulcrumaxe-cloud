// apps/workspace/e2e/onboarding-plan.spec.ts
//
// D#845 ON-11b: the plan review, on the built cloud dist behind fixture-server.mjs. Every API answer is a page.route() mock shaped like the real routes' (the draft read, the write, approve, discard, blank
// and restart); no request leaves the page. Desktop, tablet and phone all run every test, and each state has a fixture: loading, failed, none, draft (standard and public), saving, saved, conflict,
// approved, discarded, a member, and every refusal in words.

import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";
import { engineTrack, withEngine } from "./helpers/onboarding-body";

const DIR = dirname(fileURLToPath(import.meta.url));
const fx = (...p: string[]) => JSON.parse(readFileSync(join(DIR, "..", "..", "..", "packages", "api", "fixtures", "v1", ...p), "utf8"));
const PLANS = JSON.parse(readFileSync(join(DIR, "plans-fixture.json"), "utf8"));
const PLACEHOLDER = /\b(null|undefined|nan)\b/i;
const S1 = "55555555-5555-4555-8555-555555555555";
const D1 = "66666666-6666-4666-8666-666666666666";
const BANNER = "Drafted from a public repo. Anyone can propose changes to its files, so read every item before you approve.";
const MEMBER = "Only owners and admins can edit or approve the plan.";

type Json = Record<string, unknown>;
type Reply = { status?: number; json: unknown };
const err = (status: number, code: string, extra: Json = {}): Reply => ({ status, json: { error: { code, message: "SERVER WORDS <b>x</b>" }, ...extra } });
const row = (key: string, over: Json = {}) => ({ row_key: key, title: `Row ${key}`, summary: `Does ${key}`, size: "S", depends_on: [], keep: true, ...over });
const draftBody = (over: Json = {}, draft: Json = {}, setup: Json = {}) => ({
  setup: { phase: "plan", state: "ok", ...setup },
  draft: { id: D1, version: 4, source: "survey", status: "draft", prd_md: "# Plan\n\nBuild the thing.", roadmap: [row("A1"), row("B2", { depends_on: ["A1"], size: "M" })], created_at: "2026-11-24T10:00:00.000Z", ...draft },
  review_mode: "standard",
  ...over,
});
interface Mock {
  admin: boolean;
  saved: { version: number; prd_md: string; roadmap: unknown[] };
  get: () => Reply;
  put: (b: Json) => Reply;
  post: (action: string, b: unknown) => Reply;
  calls: { method: string; action: string; body: unknown }[];
  reads: number;
  onboardingReads: number;
  setupPhase: string;
}
// The default draft is stateful, like the server: a save changes what the next read returns and moves the version.
const mock = (o: Partial<Mock> = {}): Mock => {
  const m: Mock = {
    admin: true,
    saved: { version: 4, prd_md: "# Plan\n\nBuild the thing.", roadmap: [row("A1"), row("B2", { depends_on: ["A1"], size: "M" })] },
    get: () => ({ json: draftBody({}, m.saved) }),
    put: (b) => { m.saved = { version: (b.version as number) + 1, prd_md: b.prd_md as string, roadmap: b.roadmap as unknown[] }; return { json: { version: m.saved.version } }; },
    post: (action) => ({ json: action === "approve" ? { approved: true, draft_id: D1, version: m.saved.version, review_mode: "standard", install: { job_id: "j1", attempt: 1 }, gate: null, install_error: null } : { ok: true } }),
    calls: [], reads: 0, onboardingReads: 0, setupPhase: "plan", ...o,
  };
  return m;
};

async function setup(page: Page, m: Mock) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("dialog", (d) => { problems.push("dialog: " + d.message()); void d.dismiss(); });
  await page.route("**/api/cloud/auth/me", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), workspace_access: "no_subscription", is_admin: m.admin } });
  });
  await page.route((u) => u.pathname === "/api/v1/onboarding", (route) => {
    m.onboardingReads++;
    const body = withEngine(fx("getOnboarding", "200-new.json"), engineTrack({ machine: "done", claude: "done", github_app: "done", project: "done", plan: "active" }, { tier: "microvm" }));
    return route.fulfill({ json: { ...body, tracks: [body.tracks[0], { ...body.tracks[1], setup: { id: S1, phase: m.setupPhase, state: "ok" } }] } });
  });
  await page.route("**/api/plans", (route) => route.fulfill({ json: { ...PLANS, plans: PLANS.plans, viewer: { is_owner: true, partner_billed: false } } }));
  await page.route((u) => u.pathname === "/api/runners", (route) => route.fulfill({ json: { runners: [] } }));
  await page.route((u) => u.pathname.startsWith(`/api/v1/setups/${S1}/draft`), (route) => {
    const req = route.request();
    const action = new URL(req.url()).pathname.slice(`/api/v1/setups/${S1}/draft`.length).replace(/^\//, "");
    const body = req.method() === "GET" ? null : req.postDataJSON();
    if (req.method() === "GET") m.reads++; else m.calls.push({ method: req.method(), action, body });
    const r = req.method() === "GET" ? m.get() : req.method() === "PUT" ? m.put(body as Json) : m.post(action, body);
    return route.fulfill({ status: r.status ?? 200, json: r.json });
  });
  return problems;
}
const ob = (page: Page) => page.locator('.fulc-window[data-app-id="onboarding"]');
const t = (page: Page, id: string) => ob(page).locator(`[data-testid="ob-plan-${id}"]`);
const rowAt = (page: Page, i: number) => ob(page).locator('[data-testid="ob-plan-row"]').nth(i);
const boot = async (page: Page, m: Mock) => {
  const problems = await setup(page, m);
  await bootToDesktop(page, { url: "/" });
  await page.evaluate(() => { (window as unknown as { fulcConfirm: () => Promise<boolean> }).fulcConfirm = async () => true; });
  return problems;
};
const noOverflow = async (page: Page) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await ob(page).locator('[data-testid="ob-app"]').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
};
const clean = async (page: Page) => expect(await ob(page).locator('[data-testid="ob-plan"]').innerText()).not.toMatch(PLACEHOLDER);
const axe = async (page: Page) => {
  const res = await new AxeBuilder({ page }).include('.fulc-window[data-app-id="onboarding"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
  expect(res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
};
const planPanel = (page: Page) => ob(page).locator('[data-testid="ob-plan"]');

test.describe("the plan review (D#845 ON-11b)", () => {
  test("a standard draft: the PRD with its live count, every row's fields, save, approve, and nothing is sent until the buttons are used", async ({ page }) => {
    const m = mock();
    const problems = await boot(page, m);
    await expect(t(page, "prd")).toHaveValue("# Plan\n\nBuild the thing.");
    await expect(t(page, "count")).toHaveText("24 of 200,000 characters");
    await expect(t(page, "banner")).toHaveCount(0);
    await expect(ob(page).locator('[data-testid="ob-plan-row"]')).toHaveCount(2);
    await expect(rowAt(page, 1).locator('[data-testid="ob-plan-key"]')).toHaveValue("B2");
    await expect(rowAt(page, 1).locator('[data-testid="ob-plan-title"]')).toHaveValue("Row B2");
    await expect(rowAt(page, 1).locator('[data-testid="ob-plan-summary"]')).toHaveValue("Does B2");
    await expect(rowAt(page, 1).locator('[data-testid="ob-plan-size"]')).toHaveValue("M");
    await expect(rowAt(page, 1).locator('[data-testid="ob-plan-deps"]')).toHaveValue("A1");
    await expect(rowAt(page, 1).locator('[data-testid="ob-plan-keep"]')).toBeChecked();
    await expect(rowAt(page, 0).locator('[data-testid="ob-plan-row-read"]')).toHaveCount(0);
    await expect(t(page, "save")).toBeDisabled();
    await expect(t(page, "approve")).toBeEnabled();
    expect(m.calls).toEqual([]);
    await noOverflow(page);
    await clean(page);
    await axe(page);

    await t(page, "prd").fill("# Plan\n\nBuild the thing, then ship it.");
    await expect(t(page, "count")).toHaveText("38 of 200,000 characters");
    await rowAt(page, 0).locator('[data-testid="ob-plan-title"]').fill("First row");
    await expect(t(page, "status")).toHaveText("Unsaved changes");
    await expect(t(page, "approve")).toBeDisabled();
    await expect(t(page, "hint")).toHaveText("Save your changes before you approve.");
    await t(page, "save").click();
    await expect(t(page, "status")).toHaveText(/^Saved \d/);
    expect(m.calls).toEqual([{ method: "PUT", action: "", body: { version: 4, prd_md: "# Plan\n\nBuild the thing, then ship it.", roadmap: [
      { row_key: "A1", title: "First row", summary: "Does A1", size: "S", depends_on: [], keep: true }, { row_key: "B2", title: "Row B2", summary: "Does B2", size: "M", depends_on: ["A1"], keep: true }] } }]);
    await expect(t(page, "approve")).toBeEnabled();
    // The install is issued, so the setup is at the install step on the next read and the panel gives way to it.
    m.post = () => { m.setupPhase = "install"; return { json: { approved: true, draft_id: D1, version: 5, review_mode: "standard", install: { job_id: "j1", attempt: 1 }, gate: null, install_error: null } }; };
    await t(page, "approve").click();
    await expect(ob(page).locator('[data-testid="ob-live"]')).toHaveText("Approved. The install has started.");
    expect(m.calls[1]).toEqual({ method: "POST", action: "approve", body: { version: 5 } });
    await expect(planPanel(page)).toHaveCount(0);
    await expect(ob(page).locator('[data-testid="ob-engine-plan"]')).toBeVisible();
    expect(problems).toEqual([]);
  });

  test("editing rows: add, drop, remove, depend; a kept row on a dropped one and a missing key are said in words, and Save and Approve follow", async ({ page }) => {
    const m = mock();
    await boot(page, m);
    await t(page, "add").click();
    await expect(ob(page).locator('[data-testid="ob-plan-row"]')).toHaveCount(3);
    await expect(rowAt(page, 2).locator('[data-testid="ob-plan-key"]')).toHaveValue("R1");
    await expect(t(page, "problems")).toContainText("R1: the title needs 1 to 120 characters.");
    await expect(t(page, "save")).toBeDisabled();
    await rowAt(page, 2).locator('[data-testid="ob-plan-title"]').fill("Third");
    await rowAt(page, 2).locator('[data-testid="ob-plan-deps"]').fill("ZZ9");
    await expect(t(page, "problems")).toContainText("R1 depends on ZZ9, which isn't a row in this plan.");
    await rowAt(page, 2).locator('[data-testid="ob-plan-deps"]').fill("B2");
    await rowAt(page, 1).locator('[data-testid="ob-plan-keep"]').uncheck();
    await expect(t(page, "problems")).toContainText("R1 is kept but depends on B2, which you dropped.");
    await expect(t(page, "save")).toBeEnabled();
    await expect(t(page, "approve")).toBeDisabled();
    await rowAt(page, 2).locator('[data-testid="ob-plan-remove"]').click();
    await expect(ob(page).locator('[data-testid="ob-plan-row"]')).toHaveCount(2);
    await rowAt(page, 0).locator('[data-testid="ob-plan-keep"]').uncheck();
    await expect(t(page, "problems")).toHaveText("Keep at least one row");
    await expect(t(page, "approve")).toBeDisabled();
    await expect(t(page, "save")).toBeEnabled();
    await noOverflow(page);
    await axe(page);
  });

  test("the PRD limit: a PRD past 200,000 characters is said, cannot be saved, and a PRD past 64 KiB previews with a note and is kept whole", async ({ page }) => {
    const m = mock();
    await boot(page, m);
    await t(page, "prd").fill("x".repeat(70000));
    await expect(t(page, "count")).toHaveText("70,000 of 200,000 characters");
    await t(page, "preview").click();
    await expect(t(page, "cut")).toHaveText("The preview stops at 64 KiB. The whole text is kept.");
    await t(page, "preview").click();
    await expect(t(page, "prd")).toHaveValue("x".repeat(70000));
    await t(page, "prd").fill("x".repeat(200001));
    await expect(t(page, "count")).toHaveText("200,001 of 200,000 characters");
    await expect(t(page, "problems")).toContainText("The PRD must be between 1 and 200,000 characters.");
    await expect(t(page, "save")).toBeDisabled();
    await t(page, "prd").fill("");
    await expect(t(page, "problems")).toContainText("The PRD must be between 1 and 200,000 characters.");
    expect(m.calls).toEqual([]);
  });

  test("a public repo's draft: the banner, a Reviewed tick on every row and on the PRD, and Approve stays off until all are ticked; an edit clears its own tick", async ({ page }) => {
    const m = mock();
    m.get = () => ({ json: draftBody({ review_mode: "public" }, m.saved) });
    await boot(page, m);
    const storage = () => page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
    const storedBefore = await storage();
    await expect(t(page, "banner")).toHaveText(BANNER);
    await expect(ob(page).locator('[data-testid="ob-plan-row-read"]')).toHaveCount(2);
    await expect(t(page, "approve")).toBeDisabled();
    await expect(t(page, "hint")).toHaveText("Tick every item as read to approve.");
    await t(page, "prd-read").check();
    await rowAt(page, 0).locator('[data-testid="ob-plan-row-read"]').check();
    await expect(t(page, "approve")).toBeDisabled();
    await rowAt(page, 1).locator('[data-testid="ob-plan-row-read"]').check();
    await expect(t(page, "approve")).toBeEnabled();
    await rowAt(page, 1).locator('[data-testid="ob-plan-title"]').fill("Changed");
    await expect(rowAt(page, 1).locator('[data-testid="ob-plan-row-read"]')).not.toBeChecked();
    await expect(rowAt(page, 0).locator('[data-testid="ob-plan-row-read"]')).toBeChecked();
    await t(page, "save").click();
    await expect(t(page, "status")).toHaveText(/^Saved/);
    await expect(t(page, "approve")).toBeDisabled();
    await rowAt(page, 1).locator('[data-testid="ob-plan-row-read"]').check();
    await t(page, "approve").click();
    await expect(t(page, "result")).toBeVisible();
    expect(m.calls.at(-1)).toEqual({ method: "POST", action: "approve", body: { version: 5, reviewed_row_keys: ["A1", "B2"], prd_reviewed: true } });
    await noOverflow(page);
    await axe(page);
    expect(await storage()).toBe(storedBefore); // ticks and edits live on the page only
  });

  test("a public repo's plan that the server says is not fully read: the missing count in words", async ({ page }) => {
    const m = mock({ get: () => ({ json: draftBody({ review_mode: "public" }) }), post: () => err(409, "plan_not_reviewed", { missing: 2 }) });
    await boot(page, m);
    await t(page, "prd-read").check();
    await rowAt(page, 0).locator('[data-testid="ob-plan-row-read"]').check();
    await rowAt(page, 1).locator('[data-testid="ob-plan-row-read"]').check();
    await t(page, "approve").click();
    await expect(t(page, "error")).toHaveText("Read every item before you approve. 2 items are still to mark as read.");
    await expect(ob(page)).not.toContainText("SERVER WORDS");
  });

  test("a stale save says the plan changed in another window; Load theirs takes the other version, Keep mine keeps the edits on the new version", async ({ page }) => {
    let version = 4;
    let theirs = false; // the other window's text is what the server holds once it has saved
    const m = mock({
      get: () => ({ json: draftBody({}, { version, prd_md: theirs ? "# Theirs\n\nChanged elsewhere." : "# Mine\n\nBase." }) }),
      put: (b) => { if (b.version !== version) return err(409, "draft_conflict", { version }); version += 1; return { json: { version } }; },
    });
    await boot(page, m);
    await t(page, "prd").fill("# Mine\n\nMy edit.");
    version = 7; theirs = true; // the other window saves after this one began editing (a re-read skips a screen with unsaved edits)
    await t(page, "save").click();
    await expect(t(page, "error")).toHaveText("This plan changed in another window");
    await expect(t(page, "theirs")).toBeVisible();
    await expect(t(page, "mine")).toBeVisible();
    await expect(t(page, "save")).toBeDisabled();
    await expect(t(page, "prd")).toHaveValue("# Mine\n\nMy edit.");
    await t(page, "mine").click();
    await expect(t(page, "error")).toHaveCount(0);
    await expect(t(page, "prd")).toHaveValue("# Mine\n\nMy edit.");
    await expect(t(page, "status")).toHaveText("Unsaved changes");
    await t(page, "save").click();
    await expect(t(page, "status")).toHaveText(/^Saved/);
    expect((m.calls.at(-1)!.body as Json).version).toBe(7);
    expect(version).toBe(8);
    // The same again, taking theirs.
    await t(page, "prd").fill("# Mine again");
    version = 12;
    await t(page, "save").click();
    await expect(t(page, "error")).toHaveText("This plan changed in another window");
    await t(page, "theirs").click();
    await expect(t(page, "prd")).toHaveValue("# Theirs\n\nChanged elsewhere.");
    await expect(t(page, "error")).toHaveCount(0);
    await expect(t(page, "save")).toBeDisabled();
    await axe(page);
  });

  test("every refusal is said in its own words and the server's text never shows", async ({ page }) => {
    const cases: [Reply, RegExp | string][] = [
      [err(409, "plan_invalid", { reason: "no_kept_rows" }), "Keep at least one row"],
      [err(409, "plan_invalid", { reason: "prd_length" }), "The PRD must be between 1 and 200,000 characters."],
      [err(409, "plan_invalid", { reason: "dependency_dropped" }), "A kept row depends on a row you dropped. Keep that row too, or take the dependency out."],
      [err(409, "plan_not_reviewed", { missing: 1 }), "Read every item before you approve. 1 item is still to mark as read."],
      [err(403, "forbidden"), MEMBER],
      [err(400, "invalid_message"), /^The plan has a value that can't be kept/],
      [err(409, "survey_running"), "A survey is running now. Wait for it to finish."],
      [err(429, "rate_limited"), "That didn't go through. Try again."],
      [err(500, "boom"), "Something went wrong on our side. Try again in a moment."],
    ];
    const m = mock();
    await boot(page, m);
    for (const [reply, words] of cases) {
      m.post = () => reply;
      await t(page, "approve").click();
      await expect(t(page, "error")).toHaveText(words);
      await expect(ob(page)).not.toContainText("SERVER WORDS");
      await expect(t(page, "approve")).toBeEnabled();
    }
    const before = m.onboardingReads;
    m.post = () => err(409, "setup_phase");
    await t(page, "approve").click();
    await expect(t(page, "error")).toHaveText("This setup has moved on, so the plan can't be changed here. Reloading.");
    await expect.poll(() => m.onboardingReads).toBeGreaterThan(before);
  });

  test("Start over on a public or unchecked repo is refused in words, and a start that works says so", async ({ page }) => {
    const m = mock({ post: () => err(409, "public_repo") });
    await boot(page, m);
    await t(page, "restart").click();
    await expect(t(page, "error")).toHaveText("This repo is public, so the survey can't run again. Write your own plan instead.");
    m.post = () => err(409, "repo_visibility_unknown");
    await t(page, "restart").click();
    await expect(t(page, "error")).toHaveText("We couldn't tell whether this repo is private, so the survey can't run. Try again in a minute, or write your own plan.");
    m.post = () => ({ json: { job_id: "x" } });
    await t(page, "restart").click();
    await expect(ob(page).locator('[data-testid="ob-live"]')).toHaveText("The survey started again.");
    expect(m.calls.map((c) => c.action)).toEqual(["restart", "restart", "restart"]);
  });

  test("Approve with no Engine plan: approved, the gate in words, and the purchase button; an install that could not be issued says why and Start the install tries again", async ({ page }) => {
    const m = mock();
    await boot(page, m);
    // The draft reads as approved only from the moment Approve is answered, as on the server.
    m.post = () => { m.get = () => ({ json: draftBody({}, { status: "approved" }) }); return { json: { approved: true, draft_id: D1, version: 4, review_mode: "standard", install: null, gate: { code: "plan_required", message: "SERVER WORDS" }, install_error: null } }; };
    await t(page, "approve").click();
    await expect(t(page, "result").nth(0)).toHaveText("Approved. The install starts once the Engine plan covers this project.");
    await expect(t(page, "result").nth(1)).toContainText("Pick the Engine plan to run the engine");
    await expect(t(page, "buy-choose_plan")).toBeVisible();
    await expect(ob(page)).not.toContainText("SERVER WORDS");
    await noOverflow(page);
    // Approved and still waiting: Start the install sends only the version and says why it failed this time.
    m.post = () => ({ json: { approved: true, draft_id: D1, version: 4, review_mode: "standard", install: null, gate: null, install_error: { code: "github_unavailable", message: "SERVER WORDS" } } });
    await t(page, "install").click();
    await expect(t(page, "result")).toHaveText("Approved. GitHub couldn't be reached. Start the install again in a minute. Choose Start the install to try again.");
    expect(m.calls.at(-1)).toEqual({ method: "POST", action: "approve", body: { version: 4 } });
    await expect(t(page, "install")).toBeVisible();
    // FU-307: a public repo's install refusal speaks of the install and its private repo, never of the survey.
    m.post = () => ({ json: { approved: true, draft_id: D1, version: 4, review_mode: "standard", install: null, gate: null, install_error: { code: "public_repo", message: "SERVER WORDS" } } });
    await t(page, "install").click();
    await expect(t(page, "result")).toHaveText("Approved. This repo is public, so the engine installs into its private repo instead. Set that up first, then start the install again. Choose Start the install to try again.");
    await expect(ob(page)).not.toContainText("survey");
    await axe(page);
  });

  test("Discard and Write my own: a discarded plan says there is none and offers Write my own; the empty plan says Keep at least one row and has no rows", async ({ page }) => {
    let draft: Reply = { json: draftBody() };
    const m = mock({ get: () => draft });
    await boot(page, m);
    draft = err(404, "not_found");
    await t(page, "discard").click();
    await expect(t(page, "none")).toHaveText("There is no plan to review. Write your own.");
    expect(m.calls.map((c) => c.action)).toEqual(["discard"]);
    // The setup is still at the plan step, so Start over shows beside Write my own and reaches the server's restart.
    await expect(t(page, "restart")).toBeVisible();
    m.post = () => ({ json: { job_id: "x" } });
    await t(page, "restart").click();
    await expect(ob(page).locator('[data-testid="ob-live"]')).toHaveText("The survey started again.");
    expect(m.calls.map((c) => c.action)).toEqual(["discard", "restart"]);
    draft = { json: draftBody({}, { source: "blank", prd_md: "", roadmap: [], version: 6 }) };
    await t(page, "blank").click();
    await expect(t(page, "no-rows")).toHaveText("There are no rows yet.");
    await expect(t(page, "problems")).toContainText("The PRD must be between 1 and 200,000 characters.");
    await expect(t(page, "problems")).toContainText("Keep at least one row");
    await expect(t(page, "approve")).toBeDisabled();
    expect(m.calls.map((c) => c.action)).toEqual(["discard", "restart", "blank"]);
    await axe(page);
  });

  test("a PRD and rows full of markup are text, never elements: no script, no image, no javascript link, and nothing runs", async ({ page }) => {
    const prd = "# Plan\n\n<script>window.__pwned = 1</script>\n\n[click](javascript:window.__pwned=2)\n\n<img src=x onerror=\"window.__pwned=3\">\n\n[docs](https://example.com/docs)";
    const evil = [row("A1", { title: "<img src=x onerror=\"window.__pwned=4\">", summary: "<script>window.__pwned=5</script> [x](javascript:alert(1))" })];
    const m = mock({ admin: false, get: () => ({ json: draftBody({}, { prd_md: prd, roadmap: evil }) }) });
    const problems = await boot(page, m);
    const view = ob(page).locator('[data-testid="ob-plan-prd-view"]');
    await expect(view).toContainText("<script>window.__pwned = 1</script>");
    await expect(view).toContainText("[click](javascript:window.__pwned=2)");
    await expect(rowAt(page, 0)).toContainText('<img src=x onerror="window.__pwned=4">');
    await expect(rowAt(page, 0)).toContainText("<script>window.__pwned=5</script>");
    expect(await planPanel(page).locator("script, img, iframe, [onerror]").count()).toBe(0);
    expect(await planPanel(page).locator('a[href^="javascript:"]').count()).toBe(0);
    expect(await planPanel(page).locator("a").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href))).toEqual(["https://example.com/docs"]);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(problems).toEqual([]);
  });

  test("a member reads the plan, with the reason, and has no editing control; with no plan there is only the reason", async ({ page }) => {
    const m = mock({ admin: false });
    await boot(page, m);
    await expect(t(page, "member")).toHaveText(MEMBER);
    await expect(ob(page).locator('[data-testid="ob-plan-prd-view"]')).toContainText("Build the thing.");
    await expect(ob(page).locator('[data-testid="ob-plan-row"]')).toHaveCount(2);
    for (const id of ["prd", "save", "approve", "discard", "blank", "restart", "add", "install", "title"]) await expect(t(page, id)).toHaveCount(0);
    await expect(ob(page).locator("textarea, input[type=text]")).toHaveCount(0);
    await noOverflow(page);
    await axe(page);
    const none = await page.context().newPage();
    const m2 = mock({ admin: false, get: () => err(404, "not_found") });
    await boot(none, m2);
    await expect(t(none, "none")).toHaveText("There is no plan to review. Write your own.");
    await expect(t(none, "member")).toHaveText(MEMBER);
    await expect(t(none, "blank")).toHaveCount(0);
    expect(m.calls).toEqual([]);
    expect(m2.calls).toEqual([]);
  });

  test("a plan that cannot be read says so and Try again reads it; an approved plan waiting for its install offers Start the install", async ({ page }) => {
    let fail = true;
    const m = mock({ get: () => (fail ? err(500, "boom") : { json: draftBody({}, { status: "approved", approved_by: "Ada Admin", approved_at: "2026-11-25T14:05:00.000Z" }) }) });
    await boot(page, m);
    await expect(t(page, "load-failed")).toHaveText("The plan couldn't be loaded.");
    fail = false;
    await t(page, "retry").click();
    await expect(t(page, "approved")).toHaveText(/^Approved \d{1,2}:\d{2}(\s?[AP]M)? by Ada Admin$/);
    await expect(t(page, "install")).toBeVisible();
    await expect(t(page, "save")).toHaveCount(0);
    await axe(page);
  });

  test("the panel goes when the setup moves on to the install", async ({ page }) => {
    const m = mock();
    await boot(page, m);
    await expect(planPanel(page)).toBeVisible();
    m.setupPhase = "install";
    await t(page, "approve").click(); // Approve re-reads the steps, and the setup is at the install now
    await expect(planPanel(page)).toHaveCount(0);
    await expect(ob(page).locator('[data-testid="ob-engine-plan"]')).toBeVisible();
  });
});
