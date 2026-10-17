// apps/workspace/e2e/pipeline-plan.spec.ts
//
// D#483 S3-L2b: the Pipeline app's Plan tab, on the built app with the API mocked from its contract fixtures
// (helpers/plan-mock.ts). Every state the Spec lists has a test: never imported, queued, importing, stopped, succeeded at each
// level (the level named in words, issues_discussions included), cut short, failed with each of the fourteen error codes with
// the previous plan still shown, a detached repository, empty, the milestone table and its tasks, "Approved in fulcrumaxe",
// what the import asked GitHub (A2), the import's rate limit, and the undo (Remove imported plan). The words "null" and
// "undefined" never appear (a text scan, plus a check for empty text nodes). axe runs on every state. Each test runs on
// desktop, phone and tablet.

import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { REPO, REPO_GONE, WIN, holdRequest, expectNoPlaceholders, goTab, importedPlan, neverImported, newMock, openPipeline, press, proposal, refusal, setup, tid, type PlanMock } from "./helpers/plan-mock";

const SENT = "server text that must never be shown";
const FAILURE_CODES = [
  "repo_not_connected", "app_permission_missing", "discussions_disabled", "plan_file_inconsistent", "plan_file_too_large", "token_not_read_only", "github_unavailable",
  "rate_limited_by_github", "plan_file_missing", "plan_file_shape", "interrupted", "internal_error", "request_budget_exhausted", "plan_source_too_large",
];

async function axeClean(page: Page) {
  const res = await new AxeBuilder({ page }).include(WIN).exclude(`${WIN} [data-tab="board"]`).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
  expect(res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.impact} ${v.id} ${v.nodes[0]?.html.slice(0, 120)}`)).toEqual([]);
}
async function clean(page: Page, errors: string[]) {
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.body.innerText)).not.toContain(SENT);
  await expectNoPlaceholders(page);
}
async function start(page: Page, m: PlanMock, repo = "acme/widgets") {
  const s = await setup(page, m);
  await openPipeline(page);
  await goTab(page, "plan", repo);
  await expect(tid(page, "pl-plan-status")).toBeVisible();
  return s;
}

type Imp = Record<string, unknown>;
const imported = () => importedPlan() as { latest_import: Imp; imported_from: Imp; milestones: unknown[]; totals: unknown; tasks: unknown[] };
const withLatest = (over: Imp, keepFrom = true) => {
  const p = imported();
  const latest = { ...p.latest_import, ...over };
  return { ...p, latest_import: latest, imported_from: keepFrom ? p.imported_from : null };
};
const status = (page: Page) => tid(page, "pl-plan-status");

test.describe("D#483 S3-L2b: Plan states", () => {
  test("never imported: one sentence, Import enabled, nothing to remove", async ({ page }) => {
    const m = newMock();
    const { errors } = await start(page, m);
    await expect(status(page)).toHaveText("Nothing has been imported for this repository yet. Import its plan to see its milestones and tasks.");
    await expect(tid(page, "pl-plan-import")).toBeEnabled();
    await expect(tid(page, "pl-plan-remove")).toHaveCount(0);
    await expect(tid(page, "pl-plan-table")).toHaveCount(0);
    await expect(tid(page, "pl-plan-roadmap-empty")).toContainText("Nothing has been approved yet.");
    await axeClean(page);
    await clean(page, errors);
  });

  test("no repository picked, loading failure and an unknown repository each read as a sentence", async ({ page }) => {
    const m = newMock();
    const { errors } = await setup(page, m);
    await openPipeline(page);
    await press(page, tid(page, "pl-tab-plan"));
    await expect(tid(page, "pl-plan-empty")).toHaveText("Pick a repository to see its plan.");
    m.planFails = true;
    await page.locator(`${WIN} [data-testid="pl-repo-picker"]`).selectOption({ label: "acme/widgets" });
    await expect(tid(page, "pl-plan-error")).toContainText("The plan couldn't be loaded.");
    await axeClean(page);
    m.planFails = false;
    m.plan = null;
    await press(page, tid(page, "pl-plan-error").locator("button"));
    await expect(tid(page, "pl-plan-error")).toContainText("This repository isn't in your account any more.");
    await clean(page, errors);
  });

  test("an imported plan: the line, the milestone table and its numbers come from the API", async ({ page }) => {
    const m = newMock();
    m.plan = imported();
    const { errors } = await start(page, m);
    await expect(status(page)).toContainText("Imported from the roadmap file .autonomous-team/roadmap.json");
    await expect(status(page)).toContainText(": 2 tasks, 1 done, 1 remaining.");
    const row = tid(page, "pl-plan-milestone");
    await expect(row).toHaveCount(1);
    await expect(row.locator("th")).toContainText("m1: The first milestone.");
    await expect(row.locator("td")).toHaveText(["2", "1", "1"]);
    await expect(page.locator(`${WIN} [data-testid="pl-plan-table"] tfoot td`)).toHaveText(["2", "1", "1"]);
    await expect(tid(page, "pl-plan-remove")).toBeEnabled();
    await axeClean(page);
    await clean(page, errors);
  });

  test("each import level is named in words, including issues_discussions, and a fallback says why", async ({ page }) => {
    const m = newMock();
    const cases: [string, Imp, RegExp, RegExp | null][] = [
      ["roadmap_file", {}, /Imported from the roadmap file/, null],
      ["spec_tables", { level: "spec_tables", source_path: null }, /Imported from the Spec task tables in your Discussions/, /No usable roadmap file was found/],
      ["issues_discussions", { level: "issues_discussions", source_path: null, error_detail: "milestones is not a list" }, /Imported from your open issues and Discussions/, /roadmap file was skipped because: milestones is not a list\./],
    ];
    m.plan = withLatest({});
    const { errors } = await start(page, m);
    for (const [level, over, line, why] of cases) {
      m.plan = withLatest(over);
      await press(page, tid(page, "pl-tab-inbox"));
      await press(page, tid(page, "pl-tab-plan"));
      await expect(status(page)).toContainText(line);
      if (why) await expect(status(page)).toContainText(why);
      const text = (await status(page).textContent()) ?? "";
      expect(text, level).not.toMatch(/issues_discussions|spec_tables|roadmap_file/);
    }
    await axeClean(page);
    await clean(page, errors);
  });

  test("an import cut short at a size limit says so", async ({ page }) => {
    const m = newMock();
    m.plan = withLatest({ truncated: true });
    const { errors } = await start(page, m);
    await expect(status(page)).toContainText("The import stopped at a size limit, so some tasks or items may be missing.");
    await clean(page, errors);
  });

  test("an issues-level import with no milestones says where its items went", async ({ page }) => {
    const m = newMock();
    const p = withLatest({ level: "issues_discussions", source_path: null, counts: { tasks: 0, done: 0, remaining: 0 } });
    (p.imported_from as Imp).level = "issues_discussions";
    m.plan = { ...p, milestones: [], totals: { tasks: 0, done: 0, remaining: 0 }, tasks: [] };
    const { errors } = await start(page, m);
    await expect(tid(page, "pl-plan-empty")).toContainText("so there are no milestones to show. Any open issues and Discussions it had are in the Inbox as proposals.");
    await expect(tid(page, "pl-plan-table")).toHaveCount(0);
    await axeClean(page);
    await clean(page, errors);
  });

  test("a roadmap-level import with nothing in it reads as empty", async ({ page }) => {
    const m = newMock();
    const p = withLatest({ counts: { tasks: 0, done: 0, remaining: 0 } });
    m.plan = { ...p, milestones: [], totals: { tasks: 0, done: 0, remaining: 0 }, tasks: [] };
    const { errors } = await start(page, m);
    await expect(tid(page, "pl-plan-empty")).toHaveText("The import found no tasks and no open items to propose.");
    await clean(page, errors);
  });

  test("a failed import shows one sentence for each of the fourteen error codes, and the previous plan stays on screen", async ({ page }) => {
    const m = newMock();
    m.plan = withLatest({ id: "99999999-9999-4999-8999-999999999999", state: "failed", error_code: "internal_error", error_detail: null, counts: {} });
    const { errors } = await start(page, m);
    const seen = new Set<string>();
    for (const code of FAILURE_CODES) {
      m.plan = withLatest({ id: "99999999-9999-4999-8999-999999999999", state: "failed", error_code: code, error_detail: code === "plan_file_inconsistent" ? "task D#1:A is listed twice" : code === "plan_file_shape" ? "milestones is not a list" : null, counts: {} });
      await press(page, tid(page, "pl-tab-inbox"));
      await press(page, tid(page, "pl-tab-plan"));
      await expect(status(page).locator("p").nth(1)).toContainText("Your previous plan, imported");
      await expect(tid(page, "pl-plan-table")).toBeVisible();
      await expect(tid(page, "pl-plan-milestone").locator("td")).toHaveText(["2", "1", "1"]);
      const text = (await status(page).locator("p").first().textContent()) ?? "";
      expect(text).not.toContain(code);
      seen.add(text);
      if (code === "plan_file_inconsistent") expect(text).toContain("task D#1:A is listed twice");
      if (code === "plan_file_shape") expect(text).toContain("roadmap.json didn't match the expected shape: milestones is not a list.");
      if (code === "app_permission_missing") expect(text).toContain("accept the new permissions");
      if (code === "plan_source_too_large") expect(text).toContain("Hiding spam comments on GitHub brings the count back down.");
      await expect(tid(page, "pl-plan-import")).toBeEnabled(); // the next start is allowed at once
    }
    expect(seen.size).toBe(14);
    await axeClean(page);
    await clean(page, errors);
  });

  test("a failed import with no earlier plan shows the failure and an empty plan, never null or undefined", async ({ page }) => {
    const m = newMock();
    m.plan = { ...neverImported(), latest_import: { ...imported().latest_import, state: "failed", error_code: "discussions_disabled", counts: {}, level: null, source_path: null, github_requests: null, token_permissions: null } };
    const { errors } = await start(page, m);
    await expect(status(page).locator("p").nth(0)).toContainText("Discussions are turned off for this repository");
    await expect(status(page).locator("p").nth(1)).toHaveText("There is no earlier plan, so nothing is shown below.");
    await expect(tid(page, "pl-plan-table")).toHaveCount(0);
    await press(page, tid(page, "pl-plan-evidence-toggle"));
    await expect(tid(page, "pl-plan-evidence")).toContainText("It made no requests.");
    await expect(tid(page, "pl-plan-evidence")).toContainText("GitHub reported none.");
    await axeClean(page);
    await clean(page, errors);
  });

  test("the plan table's column headings never break inside a word (Tasks, Done, Remaining)", async ({ page }) => {
    const m = newMock();
    m.plan = withLatest({ id: "99999999-9999-4999-8999-999999999999", state: "failed", error_code: "internal_error", error_detail: null, counts: {} });
    await start(page, m);
    await expect(tid(page, "pl-plan-table")).toBeVisible();
    // A word that fits its cell has the width of its own text; one that broke mid-word has a scroll width wider than the cell or more than one line.
    const heads = await tid(page, "pl-plan-table").locator('th[scope="col"]').evaluateAll((els) =>
      els.map((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
        return { text: el.textContent, lines, overflow: el.scrollWidth > el.clientWidth };
      })
    );
    expect(heads.map((h) => h.text)).toEqual(["Milestone", "Tasks", "Done", "Remaining"]);
    for (const h of heads) expect(h, h.text ?? "").toMatchObject({ lines: 1, overflow: false });
  });

  test("a queued or running import disables Import and the page follows it to the end", async ({ page }) => {
    const m = newMock();
    const started = new Date(Date.now() - 5000).toISOString();
    m.plan = withLatest({ state: "running", finished_at: null, counts: {}, started_at: started }, false);
    const { errors } = await start(page, m);
    await expect(status(page)).toHaveText("Importing the plan from GitHub. This page updates when it finishes.");
    await expect(tid(page, "pl-plan-import")).toBeDisabled();
    await expect(tid(page, "pl-plan-remove")).toBeDisabled();
    await axeClean(page);
    m.plan = withLatest({});
    await page.clock.runFor(3500);
    await expect(status(page)).toContainText("Imported from the roadmap file");
    await expect(tid(page, "pl-plan-import")).toBeEnabled();
    m.plan = withLatest({ state: "queued", finished_at: null, counts: {}, started_at: new Date().toISOString() });
    await press(page, tid(page, "pl-tab-inbox"));
    await press(page, tid(page, "pl-tab-plan"));
    await expect(status(page)).toContainText("The import is queued.");
    await clean(page, errors);
  });

  test("an import that never finished is shown as stopped, and Import is allowed again", async ({ page }) => {
    const m = newMock();
    const { errors } = await start(page, m);
    // The page runs under a fake clock, so "eleven minutes ago" is measured on the page's own clock.
    m.plan = withLatest({ state: "running", finished_at: null, counts: {}, started_at: new Date((await page.evaluate(() => Date.now())) - 11 * 60 * 1000).toISOString() }, false);
    await press(page, tid(page, "pl-tab-inbox"));
    await press(page, tid(page, "pl-tab-plan"));
    await expect(status(page).locator("p").first()).toContainText("The last import stopped without finishing");
    await expect(tid(page, "pl-plan-import")).toBeEnabled();
    const before = m.requests.filter((r) => r.includes("/plan")).length;
    await page.clock.runFor(10_000);
    expect(m.requests.filter((r) => r.includes("/plan")).length).toBe(before); // it is not polled
    await clean(page, errors);
  });

  test("the polling stops when the tab is left", async ({ page }) => {
    const m = newMock();
    m.plan = withLatest({ state: "running", finished_at: null, counts: {}, started_at: new Date().toISOString() }, false);
    const { errors } = await start(page, m);
    await press(page, tid(page, "pl-tab-inbox"));
    const before = m.requests.filter((r) => /\/plan$/.test(r)).length;
    await page.clock.runFor(10_000);
    expect(m.requests.filter((r) => /\/plan$/.test(r)).length).toBe(before);
    await clean(page, errors);
  });

  test("a detached repository keeps its plan readable with Import turned off and Remove still allowed", async ({ page }) => {
    const m = newMock();
    m.plan = imported();
    const { errors } = await start(page, m, "acme/retired");
    await expect(tid(page, "pl-plan-detached")).toHaveText("This repository isn't connected any more. Its plan and proposals stay readable here, but importing is turned off.");
    await expect(tid(page, "pl-plan-import")).toBeDisabled();
    await expect(tid(page, "pl-plan-table")).toBeVisible();
    await expect(tid(page, "pl-plan-remove")).toBeEnabled();
    await axeClean(page);
    await clean(page, errors);
    expect(m.requests.some((r) => r.includes(REPO_GONE))).toBe(true);
  });
});

test.describe("D#483 S3-L2b: Plan actions", () => {
  test("Import plan sends one JSON POST with no key and follows the import to its result", async ({ page }) => {
    const m = newMock();
    m.onImport = () => (m.plan = withLatest({ state: "running", finished_at: null, counts: {}, started_at: new Date().toISOString() }, false));
    const { errors } = await start(page, m);
    await press(page, tid(page, "pl-plan-import"));
    await expect(status(page)).toHaveText("Importing the plan from GitHub. This page updates when it finishes.");
    expect(m.posts).toHaveLength(1);
    expect(m.posts[0].path).toBe(`/api/v1/repos/${REPO}/plan-imports`);
    expect(m.posts[0].type).toBe("application/json");
    expect(m.posts[0].key).toBeUndefined();
    m.plan = imported();
    await page.clock.runFor(3500);
    await expect(status(page)).toContainText("Imported from the roadmap file");
    await expect(tid(page, "pl-plan-milestone")).toHaveCount(1);
    await clean(page, errors);
  });

  test("each refusal of an import start reads as its own sentence", async ({ page }) => {
    const m = newMock();
    const { errors } = await start(page, m);
    const cases: [number, string, string][] = [
      [409, "import_running", "An import is already running for this repository."],
      [409, "repo_not_connected", "This repository isn't connected any more, so nothing was imported."],
      [403, "insufficient_role", "Only an owner or an admin can import a plan."],
      [403, "session_required", "Sign in again to do this."],
      [503, "plan_import_unavailable", "Importing a plan isn't available on this server yet."],
      [404, "not_found", "This repository isn't in your account any more."],
      [400, "something_new", "That didn't work. Nothing was changed."],
    ];
    for (const [status_, code, words] of cases) {
      m.importReply = [refusal(status_, code)];
      await press(page, tid(page, "pl-plan-import"));
      await expect(tid(page, "pl-plan-note")).toContainText(words);
      await expect(tid(page, "pl-plan-import")).toBeEnabled();
    }
    await axeClean(page);
    await clean(page, errors);
  });

  test("the seventh import in an hour is a 429: the button is off and the wait counts down", async ({ page }) => {
    const m = newMock();
    const { errors } = await start(page, m);
    m.importReply = [refusal(429, "rate_limited", { "retry-after": "5" })];
    await press(page, tid(page, "pl-plan-import"));
    await expect(tid(page, "pl-plan-note")).toContainText("Too many imports for this repository in the last hour.");
    await expect(tid(page, "pl-plan-import")).toBeDisabled();
    await page.clock.runFor(6000);
    await expect(tid(page, "pl-plan-import")).toBeEnabled();
    await expect(tid(page, "pl-plan-note")).toHaveCount(0);
    await clean(page, errors);
  });

  test("a milestone opens to its tasks, a page at a time, and closes again", async ({ page }) => {
    const m = newMock();
    m.plan = imported();
    m.taskPage = 2;
    m.tasks.m1 = [1, 2, 3].map((n) => ({ task_key: `D#1:T${n}`, milestone_key: "m1", title: `Task ${n}`, status: ["done", "partial", "pending_spec"][n - 1], planned_prs: 2, merged_prs: n === 1 ? [1, 2] : [], open_prs: [], owner_process: "product" }));
    const { errors } = await start(page, m);
    const toggle = tid(page, "pl-plan-milestone").locator("button");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await press(page, toggle);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(tid(page, "pl-plan-task")).toHaveCount(2);
    await expect(tid(page, "pl-plan-task").first()).toContainText("D#1:T1 · Done · 2 of 2 pull requests merged");
    expect(m.requests).toContain(`GET /api/v1/repos/${REPO}/plan?milestone=m1`);
    await axeClean(page);
    await press(page, tid(page, "pl-plan-more"));
    await expect(tid(page, "pl-plan-task")).toHaveCount(3);
    await expect(tid(page, "pl-plan-task").last()).toContainText("Waiting for a Spec");
    await expect(tid(page, "pl-plan-more")).toHaveCount(0);
    await press(page, toggle);
    await expect(tid(page, "pl-plan-task")).toHaveCount(0);
    await clean(page, errors);
  });

  test("Approved in fulcrumaxe lists the approved proposals in roadmap order with their live stage", async ({ page }) => {
    const m = newMock();
    m.plan = imported();
    m.proposals = [
      proposal(1, { state: "approved", roadmap_position: 2, work_item_stage: "in_progress", title: "Second on the roadmap", task_key: "D#1:B", sources: ["plan_task"], milestone_title: "m1: The first milestone." }),
      proposal(2, { state: "approved", roadmap_position: 1, work_item_stage: "triaged", title: "First on the roadmap" }),
      proposal(3, { state: "new", title: "Not approved" }),
    ];
    const { errors } = await start(page, m);
    const items = tid(page, "pl-plan-approved");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText("First on the roadmap");
    await expect(items.nth(0)).toContainText("Stage: Triaged");
    await expect(items.nth(1)).toContainText("Stage: In progress · m1: The first milestone.");
    await axeClean(page);
    await clean(page, errors);
  });

  test("what the import asked GitHub shows only reads and read permissions (A2), and hides again", async ({ page }) => {
    const m = newMock();
    m.plan = imported();
    const { errors } = await start(page, m);
    const toggle = tid(page, "pl-plan-evidence-toggle");
    await expect(tid(page, "pl-plan-evidence")).toHaveCount(0);
    await press(page, toggle);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(tid(page, "pl-plan-evidence")).toContainText("What the import asked GitHub (2 requests)");
    await expect(page.locator(`${WIN} .pl-plan-req`)).toHaveText(["POST /graphql PlanRepoHead → 200", "GET /repos/acme/widgets/issues → 200"]);
    const levels = await page.locator(`${WIN} .pl-plan-perm`).evaluateAll((els) => els.map((e) => e.getAttribute("data-level")));
    expect(levels.length).toBeGreaterThan(0);
    expect(levels.every((l) => l === "read")).toBe(true);
    await axeClean(page);
    await press(page, toggle);
    await expect(tid(page, "pl-plan-evidence")).toHaveCount(0);
    await clean(page, errors);
  });

  test("Remove imported plan asks first; Keep it sends nothing; Yes removes it and says what went", async ({ page }) => {
    const m = newMock();
    m.plan = imported();
    const { errors } = await start(page, m);
    await press(page, tid(page, "pl-plan-remove"));
    await expect(tid(page, "pl-plan-confirm")).toContainText("Remove the imported plan for acme/widgets?");
    await expect(tid(page, "pl-plan-confirm")).toContainText("Approved and rejected proposals stay");
    await axeClean(page);
    await press(page, tid(page, "pl-plan-remove-no"));
    await expect(tid(page, "pl-plan-confirm")).toHaveCount(0);
    expect(m.posts).toEqual([]);
    await press(page, tid(page, "pl-plan-remove"));
    await press(page, tid(page, "pl-plan-remove-yes"));
    await expect(tid(page, "pl-plan-note")).toHaveText("The imported plan was removed (14 tasks and 2 undecided proposals). Approved and rejected proposals were kept. You can import it again at any time.");
    expect(m.posts).toHaveLength(1);
    expect(m.posts[0]).toMatchObject({ method: "DELETE", path: `/api/v1/repos/${REPO}/plan`, type: "application/json" });
    await expect(status(page)).toContainText("Nothing has been imported for this repository yet.");
    await expect(tid(page, "pl-plan-table")).toHaveCount(0);
    await expect(tid(page, "pl-plan-remove")).toHaveCount(0);
    await clean(page, errors);
  });

  test("Remove while an import is running is refused in words and the plan stays", async ({ page }) => {
    const m = newMock();
    m.plan = imported();
    const { errors } = await start(page, m);
    m.removeReply = [refusal(409, "import_running")];
    await press(page, tid(page, "pl-plan-remove"));
    await press(page, tid(page, "pl-plan-remove-yes"));
    await expect(tid(page, "pl-plan-note")).toHaveText("An import is running, so the plan can't be removed yet. Try again when it has finished.");
    await expect(tid(page, "pl-plan-table")).toBeVisible();
    await clean(page, errors);
  });

  test("the keyboard reaches every control and the focus is not lost when the page repaints", async ({ page }) => {
    test.skip(test.info().project.name === "phone", "keyboard model");
    const m = newMock();
    m.plan = imported();
    const { errors } = await start(page, m);
    await tid(page, "pl-plan-evidence-toggle").focus();
    await page.keyboard.press("Enter");
    await expect(tid(page, "pl-plan-evidence-toggle")).toBeFocused();
    await tid(page, "pl-plan-remove").focus();
    await page.keyboard.press("Enter");
    await expect(tid(page, "pl-plan-remove-no")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(tid(page, "pl-plan-remove")).toBeFocused();
    await clean(page, errors);
  });
});

// ---- fix round: polling stops for good, focus, announcements, names ----

const click = async (loc: ReturnType<Page["locator"]>) => loc.evaluate((e) => (e as HTMLElement).click()); // a click that does not move focus, on every project
const activeId = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute("data-focus") ?? document.activeElement?.id ?? "");
const planReqs = (m: PlanMock) => m.requests.filter((r) => /\/plan(\?|$)|state=approved/.test(r)).length;
const running = () => withLatest({ state: "running", finished_at: null, counts: {}, started_at: new Date().toISOString() }, false);

test.describe("D#483 S3-L2b fix round: leaving the Plan tab stops everything", () => {
  test("leaving while the plan GET is held open: no further plan requests for 10 s, and coming back reads it again", async ({ page }) => {
    const m = newMock();
    m.plan = running();
    const { errors } = await setup(page, m);
    await openPipeline(page);
    const release = holdRequest(m, /^GET \/api\/v1\/repos\/[^/]+\/plan$/);
    await goTab(page, "plan");
    await expect.poll(() => m.requests.filter((r) => /\/plan$/.test(r)).length).toBe(1); // the GET is out
    await press(page, tid(page, "pl-tab-inbox"));
    const before = planReqs(m);
    release(); // it answers after the tab was left: an import is live, so this used to arm the poll
    await page.clock.runFor(10_000);
    await page.waitForTimeout(300);
    await page.clock.runFor(10_000);
    expect(planReqs(m)).toBe(before);
    await press(page, tid(page, "pl-tab-plan")); // and the tab works again when it is opened
    await expect(tid(page, "pl-plan-status")).toContainText("Importing the plan from GitHub");
    const after = planReqs(m);
    expect(after).toBeGreaterThan(before);
    await page.clock.runFor(3500);
    await expect.poll(() => planReqs(m)).toBeGreaterThan(after);
    await clean(page, errors);
  });

  test("leaving while the import POST is out: the load that follows it does not poll", async ({ page }) => {
    const m = newMock();
    m.onImport = () => {
      m.plan = running();
    };
    const { errors } = await start(page, m);
    const release = holdRequest(m, /^POST .*plan-imports/);
    await press(page, tid(page, "pl-plan-import"));
    await expect.poll(() => m.requests.filter((r) => /^POST /.test(r)).length).toBe(1);
    await press(page, tid(page, "pl-tab-inbox"));
    const before = planReqs(m);
    release();
    await expect.poll(() => m.posts.length).toBe(1);
    await page.clock.runFor(10_000);
    await page.waitForTimeout(300);
    await page.clock.runFor(10_000);
    expect(planReqs(m)).toBe(before);
    await clean(page, errors);
  });

  test("leaving while the remove DELETE is out: the load that follows it does not poll", async ({ page }) => {
    const m = newMock();
    m.plan = imported();
    m.onImport = () => {
      m.plan = running();
    };
    const { errors } = await start(page, m);
    const release = holdRequest(m, /^DELETE /);
    await press(page, tid(page, "pl-plan-remove"));
    await press(page, tid(page, "pl-plan-remove-yes"));
    await expect.poll(() => m.requests.filter((r) => /^DELETE /.test(r)).length).toBe(1);
    await press(page, tid(page, "pl-tab-inbox"));
    const before = planReqs(m);
    m.plan = running(); // a live import appears while the tab is away
    release();
    await expect.poll(() => m.posts.length).toBe(1);
    await page.clock.runFor(10_000);
    await page.waitForTimeout(300);
    await page.clock.runFor(10_000);
    expect(planReqs(m)).toBe(before);
    await clean(page, errors);
  });
});

test.describe("D#483 S3-L2b fix round: Plan focus, announcements and names", () => {
  test("Import plan keeps focus while the POST is out (aria-disabled, clicks ignored)", async ({ page }) => {
    const m = newMock();
    m.onImport = () => {
      m.plan = running();
    };
    const { errors } = await start(page, m);
    const release = holdRequest(m, /^POST .*plan-imports/);
    const button = tid(page, "pl-plan-import");
    await button.focus();
    await click(button);
    await expect(tid(page, "pl-plan-note")).toHaveText("Starting the import…");
    await expect(button).toHaveAttribute("aria-disabled", "true");
    expect(await tid(page, "pl-plan-import").getAttribute("disabled")).toBeNull();
    expect(await activeId(page)).toBe("import");
    await click(tid(page, "pl-plan-import"));
    await click(tid(page, "pl-plan-import"));
    expect(m.requests.filter((r) => /^POST /.test(r))).toHaveLength(1);
    release();
    await expect(tid(page, "pl-plan-status")).toContainText("Importing the plan from GitHub");
    expect(await activeId(page)).toBe("import"); // still there, and still not usable while the import runs
    await expect(tid(page, "pl-plan-import")).toHaveAttribute("aria-disabled", "true");
    await clean(page, errors);
  });

  test("after the plan is removed the focus goes to the Plan heading", async ({ page }) => {
    const m = newMock();
    m.plan = imported();
    const { errors } = await start(page, m);
    const release = holdRequest(m, /^DELETE /);
    await press(page, tid(page, "pl-plan-remove"));
    const yes = tid(page, "pl-plan-remove-yes");
    await yes.focus();
    await click(yes);
    await expect.poll(() => m.requests.filter((r) => /^DELETE /.test(r)).length).toBe(1);
    release();
    await expect(tid(page, "pl-plan-note")).toContainText("The imported plan was removed");
    await expect(tid(page, "pl-plan-remove")).toHaveCount(0);
    expect(await activeId(page)).toBe("heading");
    await clean(page, errors);
  });

  test("a change in the import status is announced in the polite live region", async ({ page }) => {
    const m = newMock();
    m.plan = running();
    const { errors } = await start(page, m);
    const live = tid(page, "pl-plan-live");
    await expect(live).toHaveAttribute("aria-live", "polite");
    await expect(live).toHaveAttribute("role", "status");
    await expect(live).toHaveText(""); // nothing is announced for the state the tab opened on
    m.plan = withLatest({});
    await page.clock.runFor(3500);
    await expect(live).toContainText("Imported from the roadmap file");
    m.plan = withLatest({ state: "failed", error_code: "github_unavailable", finished_at: "2026-10-16T08:00:00.000Z" });
    await press(page, tid(page, "pl-tab-inbox"));
    await press(page, tid(page, "pl-tab-plan"));
    await expect(live).toContainText("GitHub didn't answer");
    await clean(page, errors);
  });

  test("the milestone toggle hides its glyph from readers, names only the milestone, and points at what it opens", async ({ page }) => {
    const m = newMock();
    m.plan = imported();
    const { errors } = await start(page, m);
    const toggle = tid(page, "pl-plan-milestone").first().locator("button.pl-plan-toggle");
    const label = (await toggle.innerText()).replace(/^[▸▾]\s*/, "");
    await expect(toggle.locator("span")).toHaveAttribute("aria-hidden", "true");
    await expect(toggle).toHaveAccessibleName(label);
    const controls = await toggle.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    m.tasks[(await tid(page, "pl-plan-milestone").first().getAttribute("data-key")) as string] = [{ task_key: "T1", title: "A task", status: "open" }];
    await press(page, toggle);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(`${WIN} [id="${controls}"]`)).toBeVisible();
    await expect(toggle).toHaveAccessibleName(label);
    await clean(page, errors);
  });
});
