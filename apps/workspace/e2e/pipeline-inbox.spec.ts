// apps/workspace/e2e/pipeline-inbox.spec.ts
//
// D#483 S3-L2b: the Pipeline app's tabs and Inbox, on the built app with the API mocked from its contract fixtures
// (helpers/plan-mock.ts). Every state the Spec lists has a test: the five filters, each button and its sentence while sending
// and after each refusal, the 429 countdown, the replayed Idempotency-Key, a detached repository, a loop-owned row with no
// buttons, paging, a failed load. The L3 parity checklist items are here: tabs, the picker hidden on Board, five filters, one
// sentence per refusal, no null/undefined text. axe runs on every state. Each test runs on desktop, phone and tablet.

import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { REPO, REPO_GONE, WIN, fx, holdRequest, expectNoPlaceholders, goTab, isUuid, newMock, openPipeline, press, proposal, refusal, setup, tid, type PlanMock } from "./helpers/plan-mock";

const rows = (page: Page) => tid(page, "pl-inbox-row");
const filter = (page: Page, key: string) => tid(page, `pl-filter-${key}`);

async function axeClean(page: Page) {
  // The Board tab keeps its own accessibility record (its status line and scroll region are older than this PR); this scope is the tab bar, the picker and the two new panels.
  const res = await new AxeBuilder({ page }).include(WIN).exclude(`${WIN} [data-tab="board"]`).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
  expect(res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.impact} ${v.id} ${v.nodes[0]?.html.slice(0, 120)}`)).toEqual([]);
}

async function start(page: Page, m: PlanMock, tab: "inbox" | "plan" | "board" = "inbox") {
  const s = await setup(page, m);
  await openPipeline(page);
  await goTab(page, tab);
  return s;
}

const SENT = "server text that must never be shown";
const clean = async (page: Page, errors: string[]) => {
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.body.innerText)).not.toContain(SENT);
  await expectNoPlaceholders(page);
};

test.describe("D#483 S3-L2b: tabs and picker", () => {
  test("Board, Inbox and Plan are tabs; the picker shows owner/name and is hidden on Board", async ({ page }) => {
    const m = newMock();
    const { errors } = await setup(page, m);
    await openPipeline(page);
    await expect(tid(page, "pl-tab-board")).toHaveAttribute("aria-selected", "true");
    await expect(tid(page, "pl-repo-row")).toBeHidden();
    await press(page, tid(page, "pl-tab-inbox"));
    await expect(tid(page, "pl-tab-inbox")).toHaveAttribute("aria-selected", "true");
    await expect(tid(page, "pl-repo-row")).toBeVisible();
    await expect(page.locator(`${WIN} [data-testid="pl-repo-picker"] option`)).toHaveText(["Choose a repository", "acme/widgets", "acme/retired"]);
    await expect(tid(page, "pl-inbox-empty")).toHaveText("Pick a repository to see its proposals.");
    await press(page, tid(page, "pl-tab-plan"));
    await expect(tid(page, "pl-repo-row")).toBeVisible();
    await press(page, tid(page, "pl-tab-board"));
    await expect(tid(page, "pl-repo-row")).toBeHidden();
    await clean(page, errors);
  });

  test("the arrow keys, Home and End move between the tabs, and only the selected tab is a tab stop", async ({ page }) => {
    test.skip(test.info().project.name === "phone", "keyboard model");
    const { errors } = await setup(page, newMock());
    await openPipeline(page);
    await tid(page, "pl-tab-board").focus();
    await page.keyboard.press("ArrowRight");
    await expect(tid(page, "pl-tab-inbox")).toHaveAttribute("aria-selected", "true");
    await expect(tid(page, "pl-tab-inbox")).toBeFocused();
    await expect(tid(page, "pl-tab-board")).toHaveAttribute("tabindex", "-1");
    await page.keyboard.press("End");
    await expect(tid(page, "pl-tab-plan")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowRight");
    await expect(tid(page, "pl-tab-board")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowLeft");
    await expect(tid(page, "pl-tab-plan")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Home");
    await expect(tid(page, "pl-tab-board")).toHaveAttribute("aria-selected", "true");
    await clean(page, errors);
  });

  test("a single repository is picked for you", async ({ page }) => {
    const m = newMock();
    m.repos = { data: [(m.repos as { data: unknown[] }).data[0]], next_cursor: null };
    m.proposals = [proposal(1)];
    await setup(page, m);
    await openPipeline(page);
    await press(page, tid(page, "pl-tab-inbox"));
    await expect(rows(page)).toHaveCount(1);
  });

  test("repositories that cannot be listed, or none, each read as a sentence in the picker", async ({ page }) => {
    const m = newMock();
    m.repos = { data: [], next_cursor: null };
    await setup(page, m);
    await openPipeline(page);
    await press(page, tid(page, "pl-tab-inbox"));
    await expect(page.locator(`${WIN} [data-testid="pl-repo-picker"] option`)).toHaveText(["No repositories are connected yet"]);
    await expect(tid(page, "pl-repo-picker")).toBeDisabled();
  });

  test("axe finds nothing serious on the three tabs", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1)];
    await start(page, m);
    await expect(rows(page)).toHaveCount(1);
    await axeClean(page);
    await goTab(page, "plan");
    await expect(tid(page, "pl-plan-status")).toBeVisible();
    await axeClean(page);
  });
});

test.describe("D#483 S3-L2b: Inbox rows and filters", () => {
  test("the five filters ask the server for the right rows, and each row shows what it has", async ({ page }) => {
    const m = newMock();
    m.proposals = [
      proposal(1, { sources: ["github_issue", "preview"], category_hint: "bug", estimate_usd: 1.5, milestone_key: "M1", milestone_title: "M1: First steps" }),
      proposal(2, { sources: ["plan_task"], gh_number: null, task_key: "D#2:H14a", title: "A planned task" }),
      proposal(3, { sources: ["github_discussion"], gh_number: null, discussion_number: 483, title: "A Discussion" }),
      proposal(4, { state: "approved", decided_at: "2026-10-16T06:05:00.000Z", roadmap_position: 1, work_item_id: "77777777-7777-4777-8777-777777777777", work_item_stage: "in_progress", title: "Approved one" }),
      proposal(5, { state: "rejected", decided_at: "2026-10-16T06:06:00.000Z", reject_note: "Not now", title: "Rejected one" }),
      proposal(6, { state: "withdrawn", title: "Closed one" }),
      proposal(7, { owner_process: "internal_loop", title: "Loop one" }),
      proposal(8, { sources: ["github_issue", "docs"], title: "Merged with docs" }),
      proposal(9, { sources: ["docs", "code"], gh_number: null, dedupe_key: "src:0123456789abcdef", title: "From the repository" }),
    ];
    const { errors } = await start(page, m);
    await expect(rows(page)).toHaveCount(5);
    const first = rows(page).filter({ hasText: "Issue number 1" });
    await expect(first.locator('[data-testid="pl-inbox-badges"]')).toHaveText("Issue #1 · Preview");
    await expect(first.locator('[data-testid="pl-inbox-details"]')).toHaveText("bug · Estimate $1.50 · M1: First steps");
    await expect(rows(page).filter({ hasText: "A planned task" }).locator('[data-testid="pl-inbox-badges"]')).toHaveText("Task D#2 · H14a");
    await expect(rows(page).filter({ hasText: "A planned task" }).locator('[data-testid="pl-inbox-details"]')).toHaveCount(0);
    await expect(rows(page).filter({ hasText: "A Discussion" }).locator('[data-testid="pl-inbox-badges"]')).toHaveText("Discussion #483");
    await expect(rows(page).filter({ hasText: "Merged with docs" }).locator('[data-testid="pl-inbox-badges"]')).toHaveText("Issue #8 · Docs");
    await expect(rows(page).filter({ hasText: "From the repository" }).locator('[data-testid="pl-inbox-badges"]')).toHaveText("Docs · Code");
    expect(m.requests).toContain(`GET /api/v1/proposals?repo_id=${REPO}&state=new&owner=product&section=new`);
    await axeClean(page);

    await press(page, filter(page, "approved"));
    await expect(rows(page)).toHaveCount(1);
    await expect(tid(page, "pl-inbox-approved")).toHaveText("On the roadmap at position 1. Stage: In progress.");
    await expect(tid(page, "pl-inbox-open")).toBeVisible();
    await expect(tid(page, "pl-inbox-withdraw-approval")).toHaveCount(0); // the work item is past Triaged
    await axeClean(page);

    await press(page, filter(page, "rejected"));
    await expect(rows(page)).toHaveCount(1);
    await expect(tid(page, "pl-inbox-rejected")).toContainText("Note: Not now");
    await expect(tid(page, "pl-inbox-restore")).toHaveText("Move back to inbox");
    await axeClean(page);

    await press(page, filter(page, "withdrawn"));
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).locator("button:not([data-testid='pl-inbox-toggle'])")).toHaveCount(0);
    await expect(tid(page, "pl-inbox-gone")).toContainText("Closed or finished at its source");

    await press(page, filter(page, "own_loop"));
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).locator("button:not([data-testid='pl-inbox-toggle'])")).toHaveCount(0);
    await expect(tid(page, "pl-inbox-loop")).toHaveText("Your own development loop handles this. fulcrumaxe only shows it.");
    expect(m.requests).toContain(`GET /api/v1/proposals?repo_id=${REPO}&owner=internal_loop`);
    await axeClean(page);
    await clean(page, errors);
  });

  test("every filter has its own empty sentence", async ({ page }) => {
    const m = newMock();
    const { errors } = await start(page, m);
    await expect(tid(page, "pl-inbox-empty")).toContainText("Nothing is waiting for a decision");
    for (const [key, text] of [["approved", "Nothing has been approved yet."], ["rejected", "Nothing has been rejected."], ["withdrawn", "Nothing has been closed or finished at its source"], ["own_loop", "None of this repository's items belong to your own development loop."]] as const) {
      await press(page, filter(page, key));
      await expect(tid(page, "pl-inbox-empty")).toContainText(text);
    }
    await axeClean(page);
    await clean(page, errors);
  });

  test("a malformed row is left out rather than drawn with holes", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1), proposal(2, { title: null }), proposal(3, { sources: null }), proposal(4, { state: "odd" })];
    const { errors } = await start(page, m);
    await expect(rows(page)).toHaveCount(1);
    await clean(page, errors);
  });

  test("a long list loads a page at a time", async ({ page }) => {
    const m = newMock();
    m.pageSize = 2;
    m.proposals = [1, 2, 3, 4, 5].map((n) => proposal(n));
    const { errors } = await start(page, m);
    await expect(rows(page)).toHaveCount(2);
    await press(page, tid(page, "pl-inbox-more"));
    await expect(rows(page)).toHaveCount(4);
    await press(page, tid(page, "pl-inbox-more"));
    await expect(rows(page)).toHaveCount(5);
    await expect(tid(page, "pl-inbox-more")).toHaveCount(0);
    await clean(page, errors);
  });

  test("a list that cannot be loaded says so and loads on Try again", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1)];
    m.listFails = true;
    const { errors } = await start(page, m);
    await expect(tid(page, "pl-inbox-error")).toContainText("The proposals couldn't be loaded.");
    await axeClean(page);
    m.listFails = false;
    await press(page, tid(page, "pl-inbox-error").locator("button"));
    await expect(rows(page)).toHaveCount(1);
    await clean(page, errors);
  });

  test("switching repository reads that repository's proposals", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1), proposal(2, { repo_id: REPO_GONE, title: "Retired repo item" })];
    const { errors } = await start(page, m);
    await expect(rows(page)).toHaveCount(1);
    await page.locator(`${WIN} [data-testid="pl-repo-picker"]`).selectOption({ label: "acme/retired" });
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page)).toContainText("Retired repo item");
    await clean(page, errors);
  });
});

test.describe("D#483 S3-L2b: decisions", () => {
  test("Approve sends one POST with a fresh UUID key and reads the outcome; the row leaves New", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1), proposal(2)];
    const { errors } = await start(page, m);
    await expect(rows(page)).toHaveCount(2);
    await press(page, rows(page).first().locator('[data-testid="pl-inbox-approve"]'));
    await expect(tid(page, "pl-inbox-note-line")).toContainText("Approved and started.");
    await expect(rows(page)).toHaveCount(1);
    expect(m.posts).toHaveLength(1);
    expect(m.posts[0].path).toMatch(/\/approve$/);
    expect(isUuid(m.posts[0].key)).toBe(true);
    expect(m.posts[0].type).toBe("application/json");
    await press(page, filter(page, "approved"));
    await expect(rows(page)).toHaveCount(1);
    await expect(tid(page, "pl-inbox-approved")).toContainText("On the roadmap at position 1. Stage: Triaged.");
    await clean(page, errors);
  });

  test("an approval that does not start says why, in one sentence for each reason", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1), proposal(2), proposal(3)];
    const { errors } = await start(page, m);
    const cases: [string, string | null, string][] = [
      ["no_write_install", "no_write_install", "no write-access GitHub App installed"],
      ["not_issue_backed", "not_issue_backed", "starts once the pipeline can take a Discussion or a task as its input"],
      ["owned_by_internal_loop", "owned_by_internal_loop", "owns this item"],
    ];
    for (const [, reason, words] of cases) {
      m.started = { started: false, not_started_reason: reason };
      await press(page, rows(page).first().locator('[data-testid="pl-inbox-approve"]'));
      await expect(tid(page, "pl-inbox-note-line")).toContainText(words);
    }
    await clean(page, errors);
  });

  test("the button shows a sentence while sending", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1)];
    const { errors } = await start(page, m);
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    await page.route((u) => u.pathname.endsWith("/approve"), async (route) => {
      await held;
      await route.fallback();
    });
    await press(page, tid(page, "pl-inbox-approve"));
    await expect(tid(page, "pl-inbox-sentence")).toHaveText("Approving…");
    await expect(tid(page, "pl-inbox-approve")).toBeDisabled();
    release();
    await expect(tid(page, "pl-inbox-note-line")).toContainText("Approved and started.");
    await clean(page, errors);
  });

  test("each refusal reads as its own sentence, never the server's words", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1)];
    const { errors } = await start(page, m);
    const cases: [number, string, string][] = [
      [409, "owned_by_internal_loop", "Your own development loop handles this."],
      [409, "repo_not_connected", "This repository isn't connected any more"],
      [409, "work_item_wrong_repo", "belongs to another repository"],
      [409, "work_item_wrong_stage", "already moved past Triaged"],
      [403, "insufficient_role", "Only an owner or an admin can decide proposals."],
      [403, "session_required", "Sign in again to do this."],
      [503, "run_actions_unavailable", "Starting work isn't available right now"],
      [400, "something_new", "That didn't work. Nothing was changed."],
    ];
    for (const [status, code, words] of cases) {
      m.decide = [refusal(status, code)];
      await press(page, tid(page, "pl-inbox-approve"));
      await expect(tid(page, "pl-inbox-sentence")).toContainText(words);
      await expect(tid(page, "pl-inbox-approve")).toBeEnabled();
    }
    await axeClean(page);
    await clean(page, errors);
  });

  test("a 409 that means the list is out of date re-reads it and keeps the sentence", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1)];
    const { errors } = await start(page, m);
    await expect(rows(page)).toHaveCount(1);
    // Another tab rejected it first.
    m.proposals[0].state = "rejected";
    m.decide = [refusal(409, "not_new")];
    await press(page, tid(page, "pl-inbox-approve"));
    await expect(rows(page)).toHaveCount(0);
    await expect(tid(page, "pl-inbox-note-line")).toContainText("isn't waiting for a decision any more");
    await clean(page, errors);
  });

  test("a network failure keeps the Idempotency-Key, so the next click replays the same decision", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1)];
    const { errors } = await start(page, m);
    m.decide = [{ status: 0, abort: true }];
    await press(page, tid(page, "pl-inbox-approve"));
    await expect(tid(page, "pl-inbox-sentence")).toContainText("Couldn't reach the server");
    await press(page, tid(page, "pl-inbox-approve"));
    await expect(tid(page, "pl-inbox-note-line")).toContainText("Approved and started.");
    expect(m.posts).toHaveLength(2);
    expect(isUuid(m.posts[0].key)).toBe(true);
    expect(m.posts[1].key).toBe(m.posts[0].key);
    await clean(page, errors);
  });

  test("a refusal drops the key, so the next decision is a new one", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1)];
    const { errors } = await start(page, m);
    m.decide = [refusal(409, "repo_not_connected")];
    await press(page, tid(page, "pl-inbox-approve"));
    await expect(tid(page, "pl-inbox-sentence")).toBeVisible();
    await press(page, tid(page, "pl-inbox-approve"));
    await expect(tid(page, "pl-inbox-note-line")).toContainText("Approved");
    expect(m.posts[1].key).not.toBe(m.posts[0].key);
    await clean(page, errors);
  });

  test("a 429 disables every decision button and counts down from Retry-After", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1), proposal(2)];
    const { errors } = await start(page, m);
    m.decide = [refusal(429, "rate_limited", { "retry-after": "5" })];
    await press(page, rows(page).first().locator('[data-testid="pl-inbox-approve"]'));
    await expect(tid(page, "pl-inbox-sentence")).toContainText("You're changing things too fast. Try again in 5 seconds.");
    await expect(tid(page, "pl-inbox-approve").first()).toBeDisabled();
    await expect(tid(page, "pl-inbox-reject").last()).toBeDisabled();
    await page.clock.runFor(2000);
    await expect(tid(page, "pl-inbox-sentence")).toContainText("Try again in 3 seconds.");
    await page.clock.runFor(4000);
    await expect(tid(page, "pl-inbox-sentence")).toHaveCount(0);
    await expect(tid(page, "pl-inbox-approve").first()).toBeEnabled();
    await clean(page, errors);
  });

  test("Reject sends the typed note (or none), and Move back to inbox undoes it", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1), proposal(2)];
    const { errors } = await start(page, m);
    await rows(page).filter({ hasText: "Issue number 1" }).locator('[data-testid="pl-inbox-note"]').fill("Not now");
    await press(page, rows(page).filter({ hasText: "Issue number 1" }).locator('[data-testid="pl-inbox-reject"]'));
    await expect(tid(page, "pl-inbox-note-line")).toContainText("Rejected.");
    await press(page, rows(page).first().locator('[data-testid="pl-inbox-reject"]'));
    await expect(rows(page)).toHaveCount(0);
    expect(m.posts.map((p) => JSON.parse(p.body ?? "{}"))).toEqual([{ note: "Not now" }, { note: null }]);
    await press(page, filter(page, "rejected"));
    await expect(rows(page)).toHaveCount(2);
    await expect(rows(page).filter({ hasText: "Issue number 1" }).locator('[data-testid="pl-inbox-rejected"]')).toContainText("Note: Not now");
    await axeClean(page);
    await press(page, rows(page).filter({ hasText: "Issue number 1" }).locator('[data-testid="pl-inbox-restore"]'));
    await expect(tid(page, "pl-inbox-note-line")).toHaveText("Moved back to the inbox.");
    await expect(rows(page)).toHaveCount(1);
    await press(page, filter(page, "new"));
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).locator('[data-testid="pl-inbox-note"]')).toHaveValue("");
    await clean(page, errors);
  });

  test("a note being typed survives a repaint of the list", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1), proposal(2)];
    const { errors } = await start(page, m);
    const note = rows(page).filter({ hasText: "Issue number 1" }).locator('[data-testid="pl-inbox-note"]');
    await note.fill("typing in progress");
    m.decide = [refusal(409, "repo_not_connected")];
    await press(page, rows(page).filter({ hasText: "Issue number 2" }).locator('[data-testid="pl-inbox-approve"]'));
    await expect(tid(page, "pl-inbox-sentence")).toBeVisible();
    await expect(note).toHaveValue("typing in progress");
    await clean(page, errors);
  });

  test("Withdraw approval is offered only at Triaged; it returns the proposal to New; after work starts it is refused in words", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1)];
    const { errors } = await start(page, m);
    await press(page, tid(page, "pl-inbox-approve"));
    await expect(tid(page, "pl-inbox-note-line")).toContainText("Approved");
    await press(page, filter(page, "approved"));
    await expect(tid(page, "pl-inbox-withdraw-approval")).toBeVisible();
    // The item moved on after the page loaded: the server refuses, the row re-reads and shows the live stage.
    m.proposals[0].work_item_stage = "in_progress";
    await press(page, tid(page, "pl-inbox-withdraw-approval"));
    await expect(tid(page, "pl-inbox-sentence")).toContainText("Work has already started on this item, so the approval can't be withdrawn.");
    await expect(tid(page, "pl-inbox-approved")).toContainText("Stage: In progress");
    await expect(tid(page, "pl-inbox-withdraw-approval")).toHaveCount(0);
    m.proposals[0].work_item_stage = "triaged";
    await press(page, filter(page, "new"));
    await press(page, filter(page, "approved"));
    await press(page, tid(page, "pl-inbox-withdraw-approval"));
    await expect(tid(page, "pl-inbox-note-line")).toContainText("Approval withdrawn.");
    await expect(rows(page)).toHaveCount(0);
    await press(page, filter(page, "new"));
    await expect(rows(page)).toHaveCount(1);
    await clean(page, errors);
  });

  test("Open in Pipeline goes to the Board", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1, { state: "approved", roadmap_position: 1, work_item_id: "77777777-7777-4777-8777-777777777777", work_item_stage: "triaged" })];
    const { errors } = await start(page, m);
    await press(page, filter(page, "approved"));
    await press(page, tid(page, "pl-inbox-open"));
    await expect(tid(page, "pl-tab-board")).toHaveAttribute("aria-selected", "true");
    await expect(tid(page, "pl-repo-row")).toBeHidden();
    await expect(page.locator(`${WIN} [data-tab="inbox"]`)).toBeHidden();
    await clean(page, errors);
  });

  test("a detached repository keeps its proposals readable, with Approve disabled and a sentence", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1, { repo_id: REPO_GONE })];
    const { errors } = await setup(page, m);
    await openPipeline(page);
    await goTab(page, "inbox", "acme/retired");
    await expect(rows(page)).toHaveCount(1);
    await expect(tid(page, "pl-inbox-approve")).toBeDisabled();
    await expect(tid(page, "pl-inbox-detached")).toHaveText("This repository isn't connected any more, so it can't be approved. Its proposals stay readable.");
    await expect(tid(page, "pl-inbox-reject")).toBeEnabled();
    await axeClean(page);
    await clean(page, errors);
  });

  test("the tab leaves nothing behind when the window closes", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1)];
    const { errors } = await start(page, m);
    await page.evaluate(() => (window as unknown as { FULCWM: Record<string, (id: string) => void> }).FULCWM.close("pipeline"));
    await expect(page.locator(WIN)).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

// ---- fix round: Show more, focus, announcements, picker, contrast, reflow ----

const click = async (loc: ReturnType<Page["locator"]>) => loc.evaluate((e) => (e as HTMLElement).click()); // a click that does not move focus, on every project
const activeId = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute("data-focus") ?? document.activeElement?.id ?? "");
const oneRepo = () => ({ data: [{ id: REPO, product: "web", gh_repo_id: 1, install_state: "installed", app_kind: "team", full_name: "acme/widgets" }], next_cursor: null });

test.describe("D#483 S3-L2b fix round: Show more", () => {
  test("switching the filter during a held Show more does not leave the button disabled on the new list", async ({ page }) => {
    const m = newMock();
    m.pageSize = 2;
    m.proposals = [1, 2, 3].map((n) => proposal(n)).concat([4, 5, 6, 7, 8].map((n) => proposal(n, { state: "rejected", decided_at: "2026-10-16T06:06:00.000Z", title: `Rejected ${n}` })));
    const { errors } = await start(page, m);
    await expect(rows(page)).toHaveCount(2);
    const release = holdRequest(m, /cursor=/);
    await press(page, tid(page, "pl-inbox-more"));
    await expect(tid(page, "pl-inbox-more")).toHaveAttribute("aria-disabled", "true");
    await expect.poll(() => m.requests.filter((r) => /cursor=/.test(r)).length).toBe(1);
    await press(page, filter(page, "rejected"));
    await expect(rows(page).first()).toContainText("Rejected");
    await expect(tid(page, "pl-inbox-more")).toHaveText("Show more");
    await expect(tid(page, "pl-inbox-more")).toHaveAttribute("aria-disabled", "false");
    release(); // the old list's answer arrives late and is dropped
    await press(page, tid(page, "pl-inbox-more"));
    await expect(rows(page)).toHaveCount(4);
    await press(page, tid(page, "pl-inbox-more"));
    await expect(rows(page)).toHaveCount(5);
    await expect(tid(page, "pl-inbox-more-failed")).toHaveCount(0);
    await clean(page, errors);
  });
});

test.describe("D#483 S3-L2b fix round: focus, announcements and names", () => {
  test("Approve keeps focus while it is in flight (aria-disabled, clicks ignored); the focus then moves to the next row, and to the heading after the last", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1), proposal(2)];
    const { errors } = await start(page, m);
    await expect(rows(page)).toHaveCount(2);
    const release = holdRequest(m, /^POST .*\/approve/);
    const first = rows(page).first().locator('[data-testid="pl-inbox-approve"]');
    await first.focus();
    await click(first);
    await expect(tid(page, "pl-inbox-sentence")).toContainText("Approving");
    const sending = rows(page).first().locator('[data-testid="pl-inbox-approve"]');
    await expect(sending).toHaveAttribute("aria-disabled", "true");
    expect(await sending.getAttribute("disabled")).toBeNull();
    expect(await activeId(page)).toBe(`${proposal(1).id}:approve`);
    await click(sending);
    await click(sending);
    expect(m.requests.filter((r) => /^POST .*approve/.test(r))).toHaveLength(1);
    release();
    await expect(rows(page)).toHaveCount(1);
    expect(await activeId(page)).toBe(`${proposal(2).id}:approve`);
    await click(rows(page).first().locator('[data-testid="pl-inbox-approve"]'));
    await expect(tid(page, "pl-inbox-empty")).toBeVisible();
    expect(await activeId(page)).toBe("heading");
    await clean(page, errors);
  });

  test("the same refusal twice is announced twice: the live region is emptied, then set on the next frame", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1)];
    const { errors } = await start(page, m);
    await page.evaluate((sel) => {
      const w = window as unknown as { __said: string[] };
      w.__said = [];
      const live = document.querySelector(sel)!;
      new MutationObserver(() => w.__said.push(live.textContent ?? "")).observe(live, { childList: true, characterData: true, subtree: true });
    }, `${WIN} [data-testid="pl-inbox-live"]`);
    m.decide = [refusal(403, "insufficient_role"), refusal(403, "insufficient_role")];
    const approve = tid(page, "pl-inbox-approve");
    await press(page, approve);
    await expect(tid(page, "pl-inbox-sentence")).toBeVisible();
    const sentence = (await tid(page, "pl-inbox-sentence").textContent()) ?? "";
    await expect.poll(() => page.evaluate((t) => (window as unknown as { __said: string[] }).__said.filter((s) => s === t).length, sentence)).toBe(1);
    await press(page, approve);
    await expect.poll(() => page.evaluate((t) => (window as unknown as { __said: string[] }).__said.filter((s) => s === t).length, sentence)).toBe(2);
    const said = await page.evaluate(() => (window as unknown as { __said: string[] }).__said);
    expect(said.filter((s) => s === "").length).toBeGreaterThan(0); // cleared between the two
    await expect(tid(page, "pl-inbox-live")).toHaveAttribute("aria-live", "polite");
    await clean(page, errors);
  });

  test("Approve and Reject are described by the row title, and the Inbox heading can take focus", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1, { title: "Make the widgets round" })];
    await start(page, m);
    for (const id of ["pl-inbox-approve", "pl-inbox-reject"]) {
      const b = tid(page, id);
      const target = await b.getAttribute("aria-describedby");
      expect(target).toBeTruthy();
      expect(await page.locator(`${WIN} [id="${target}"]`).textContent()).toBe("Make the widgets round");
      await expect(b).toHaveAccessibleDescription("Make the widgets round");
    }
    await expect(page.locator(`${WIN} #pl-inbox-h`)).toHaveAttribute("tabindex", "-1");
  });

  test("a repository list that fails reads as an alert with Try again; none connected reads as a status with Try again", async ({ page }) => {
    const m = newMock();
    m.reposFail = true;
    const { errors } = await setup(page, m);
    await openPipeline(page);
    await press(page, tid(page, "pl-tab-inbox"));
    const text = tid(page, "pl-repo-status-text");
    await expect(text).toHaveText("The repositories couldn't be loaded.");
    await expect(text).toHaveAttribute("role", "alert");
    await axeClean(page);
    m.reposFail = false;
    m.repos = { data: [], next_cursor: null };
    await press(page, tid(page, "pl-repo-again"));
    await expect(text).toHaveText("No repositories are connected yet.");
    await expect(text).toHaveAttribute("role", "status");
    await expect(tid(page, "pl-repo-again")).toBeVisible();
    m.repos = oneRepo();
    await press(page, tid(page, "pl-repo-again"));
    await expect(tid(page, "pl-repo-status")).toBeHidden();
    await expect(page.locator(`${WIN} [data-testid="pl-repo-picker"] option`)).toHaveText(["Choose a repository", "acme/widgets"]);
    await press(page, tid(page, "pl-tab-board"));
    await expect(tid(page, "pl-repo-status")).toBeHidden();
    await clean(page, errors);
  });

  test("the form fields have a border of at least 3:1 against their background", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1)];
    await start(page, m);
    for (const sel of ["pl-repo-picker", "pl-inbox-note"]) {
      const res = await tid(page, sel).evaluate((el) => {
        const cs = getComputedStyle(el);
        const rgb = (v: string) => (v.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number);
        const lum = (c: number[]) => {
          const [r, g, b] = c.slice(0, 3).map((x) => ((x /= 255) <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const border = rgb(cs.borderTopColor);
        const bg = rgb(cs.backgroundColor);
        const [a, b] = [lum(border), lum(bg)].sort((x, y) => y - x);
        return { opaque: (border[3] ?? 1) === 1, ratio: (a + 0.05) / (b + 0.05) };
      });
      expect(res.opaque).toBe(true); // opaque, so the ratio is the real one
      expect(res.ratio).toBeGreaterThanOrEqual(3);
    }
  });

  test("at 320px a long repository name does not overflow the window", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    const m = newMock();
    const long = `an-organisation-with-a-long-name/${"a-very-long-repository-name-".repeat(3)}end`;
    m.repos = { data: [{ ...oneRepo().data[0], full_name: long }], next_cursor: null };
    m.proposals = [proposal(1)];
    await setup(page, m);
    await openPipeline(page);
    await press(page, tid(page, "pl-tab-inbox"));
    await page.locator(`${WIN} [data-testid="pl-repo-picker"]`).selectOption({ label: long });
    await expect(rows(page)).toHaveCount(1);
    const box = await page.evaluate((sel) => {
      const shell = document.querySelector(sel + " .pl-shell") as HTMLElement;
      const pick = document.querySelector(sel + " .pl-repo-picker") as HTMLElement;
      const s = shell.getBoundingClientRect();
      const p = pick.getBoundingClientRect();
      return { shellRight: s.right, pickRight: p.right, pickLeft: p.left, shellLeft: s.left, scrollW: shell.scrollWidth, clientW: shell.clientWidth, panelScroll: [...shell.querySelectorAll<HTMLElement>(".pl-tab-panel")].map((e) => e.scrollWidth - e.clientWidth) };
    }, WIN);
    expect(box.pickRight).toBeLessThanOrEqual(box.shellRight + 0.5);
    expect(box.pickLeft).toBeGreaterThanOrEqual(box.shellLeft - 0.5);
    expect(box.scrollW).toBeLessThanOrEqual(box.clientW + 1);
    for (const extra of box.panelScroll) expect(extra).toBeLessThanOrEqual(1);
  });
});

test.describe("D#483 S5-b1a-2: the Inbox says why nothing starts on its own", () => {
  const OFF = { ...fx("getAutostartEnvelope", "200-off.json") };
  const ON = { ...fx("getAutostartEnvelope", "200-on.json") };

  const withNew = (autostart: Record<string, unknown> | null) => {
    const m = newMock();
    m.proposals = [proposal(1)];
    m.autostart = autostart;
    return m;
  };

  test("while the weekly auto-start limit is off, the New list carries the server's sentence", async ({ page }) => {
    const { errors } = await start(page, withNew(OFF));
    await expect(rows(page)).toHaveCount(1);
    await expect(tid(page, "pl-inbox-autostart-off")).toHaveText(`${OFF.off_sentence}.`);
    await expectNoPlaceholders(page);
    expect(errors).toEqual([]);
  });

  test("with a limit set, the sentence is not shown", async ({ page }) => {
    await start(page, withNew(ON));
    await expect(rows(page)).toHaveCount(1);
    await expect(tid(page, "pl-inbox-autostart-off")).toHaveCount(0);
  });

  test("when the limit cannot be read, the sentence is not shown", async ({ page }) => {
    await start(page, withNew(null));
    await expect(rows(page)).toHaveCount(1);
    await expect(tid(page, "pl-inbox-autostart-off")).toHaveCount(0);
  });

  const ITEM = "00000000-0000-4000-8000-0000000000aa";
  // The page runs under the fake clock the e2e helpers install (2026-01-01T00:00Z), so "days ago" is counted from that, not from this machine's clock.
  const PAGE_NOW = Date.parse("2026-01-01T00:00:00Z");
  const ago = (days: number) => new Date(PAGE_NOW - days * 86_400_000).toISOString();
  test("an item the dial started on its own and announced gets one plain line naming it, with a way to its card; started by a person, or on act, gets none", async ({ page }) => {
    const m = newMock();
    m.proposals = [
      proposal(1, { state: "approved", inbox_section: null, work_item_id: ITEM, work_item_stage: "triaged", roadmap_position: 1, decided_at: ago(2), auto_started: true }),
      proposal(2, { state: "approved", inbox_section: null, work_item_id: "00000000-0000-4000-8000-0000000000bb", work_item_stage: "triaged", roadmap_position: 2, decided_at: "2026-10-20T11:00:00.000Z", auto_started: false }),
      proposal(3),
    ];
    const { errors } = await start(page, m);
    await expect(rows(page)).toHaveCount(1);
    const lines = page.locator(`${WIN} [data-testid="pl-inbox-autostarted-line"]`);
    await expect(lines).toHaveCount(1);
    await expect(lines).toContainText("Started on its own under your setting: Issue number 1.");
    await expectNoPlaceholders(page);
    await press(page, tid(page, "pl-inbox-autostarted-open"));
    await expect(tid(page, "pl-tab-board")).toHaveAttribute("aria-selected", "true");
    expect(errors).toEqual([]);
  });

  test("only items auto-started in the last 7 days are named: 6 days ago is, 8 days ago is not, and a time in the future is not", async ({ page }) => {
    const m = newMock();
    const at = (n: number, decided_at: string) => proposal(n, { state: "approved", inbox_section: null, work_item_id: `00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`, work_item_stage: "triaged", roadmap_position: n, decided_at, auto_started: true });
    m.proposals = [at(1, ago(6)), at(2, ago(8)), at(3, ago(-1)), proposal(4)];
    await start(page, m);
    await expect(rows(page)).toHaveCount(1);
    const lines = page.locator(`${WIN} [data-testid="pl-inbox-autostarted-line"]`);
    await expect(lines).toHaveCount(1);
    await expect(lines).toContainText("Issue number 1.");
  });

  test("with nothing auto-started there is no such line", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1)];
    await start(page, m);
    await expect(rows(page)).toHaveCount(1);
    await expect(tid(page, "pl-inbox-autostarted")).toHaveCount(0);
  });

  test("an empty New list has no sentence to give", async ({ page }) => {
    const m = newMock();
    m.autostart = OFF;
    await start(page, m);
    await expect(tid(page, "pl-inbox-autostart-off")).toHaveCount(0);
  });
});

test.describe("D#483 S5-e1: the limit a person gives an item as they approve it", () => {
  const AMOUNT_SENTENCE = "Set a limit for this item: we can't estimate it yet";
  const amount = (page: Page) => tid(page, "pl-inbox-amount");
  const bodyOf = (m: PlanMock, i: number) => JSON.parse(m.posts[i].body ?? "{}");
  const rowOf = (page: Page, n: number) => page.locator(`${WIN} [data-id="${proposal(n).id}"]`);

  test("no estimate: the Spec sentence and an empty field; nothing is sent until a valid limit is typed, then approve sends amount_usd", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1)];
    m.estimates = { [proposal(1).id]: { basis: "none", total_usd: null } };
    const { errors } = await start(page, m);
    await expect(tid(page, "pl-inbox-amount-line")).toHaveText(AMOUNT_SENTENCE);
    await expect(page.locator(`${WIN} label.pl-inbox-amountlabel`)).toContainText("Limit for this item (USD)");
    await expect(amount(page)).toHaveValue("");
    await axeClean(page);
    // Empty, not a number, zero, and more than the account can still spend: each says what to fix and sends nothing.
    await press(page, tid(page, "pl-inbox-approve"));
    await expect(tid(page, "pl-inbox-sentence")).toHaveText(AMOUNT_SENTENCE);
    for (const [typed, words] of [["abc", "Enter a limit in dollars"], ["0", "Enter a limit above $0."], ["438", "Enter a limit of $437.00 or less"]] as const) {
      await amount(page).fill(typed);
      await press(page, tid(page, "pl-inbox-approve"));
      await expect(tid(page, "pl-inbox-sentence")).toContainText(words);
    }
    expect(m.posts).toHaveLength(0);
    await amount(page).fill("25.50");
    await press(page, tid(page, "pl-inbox-approve"));
    await expect(tid(page, "pl-inbox-note-line")).toContainText("Approved and started.");
    expect(m.posts).toHaveLength(1);
    expect(bodyOf(m, 0)).toEqual({ amount_usd: 25.5 });
    await clean(page, errors);
  });

  test("with an estimate the field is pre-filled from it (total x margin, capped at the remaining budget) and the person can change it", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1), proposal(2), proposal(3)];
    m.estimates = {
      [proposal(1).id]: { basis: "seed", total_usd: 100 },
      [proposal(2).id]: { basis: "seed", total_usd: 1000 },
      [proposal(3).id]: { basis: "history", total_usd: 3 },
    };
    const { errors } = await start(page, m);
    await expect(rows(page)).toHaveCount(3);
    const field = (n: number) => rowOf(page, n).locator('[data-testid="pl-inbox-amount"]');
    await expect(field(1)).toHaveValue("120");
    await expect(field(2)).toHaveValue("437"); // 1,200 capped at what the account can still spend
    await expect(field(3)).toHaveValue("3.6");
    await expect(tid(page, "pl-inbox-amount-line")).toHaveCount(0);
    // Sent as it stands.
    await press(page, rowOf(page, 1).locator('[data-testid="pl-inbox-approve"]'));
    await expect(tid(page, "pl-inbox-note-line")).toContainText("Approved and started.");
    expect(bodyOf(m, 0)).toEqual({ amount_usd: 120 });
    // Changed.
    await field(3).fill("7");
    await press(page, rowOf(page, 3).locator('[data-testid="pl-inbox-approve"]'));
    await expect(tid(page, "pl-inbox-note-line")).toContainText("Approved and started.");
    expect(bodyOf(m, 1)).toEqual({ amount_usd: 7 });
    await clean(page, errors);
  });

  test("rows on the second page get their estimate and pre-fill too", async ({ page }) => {
    const m = newMock();
    m.pageSize = 2;
    m.proposals = [proposal(1), proposal(2), proposal(3)];
    m.estimates = {
      [proposal(1).id]: { basis: "seed", total_usd: 10 },
      [proposal(2).id]: { basis: "seed", total_usd: 20 },
      [proposal(3).id]: { basis: "seed", total_usd: 100 },
    };
    const { errors } = await start(page, m);
    await expect(rows(page)).toHaveCount(2);
    await expect(rowOf(page, 2).locator('[data-testid="pl-inbox-amount"]')).toHaveValue("24");
    await press(page, tid(page, "pl-inbox-more"));
    await expect(rows(page)).toHaveCount(3);
    await expect(rowOf(page, 3).locator('[data-testid="pl-inbox-amount"]')).toHaveValue("120");
    await clean(page, errors);
  });

  test("when what is left this month is below the first run's cost the refusal says to raise the monthly budget", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1)];
    m.estimates = { [proposal(1).id]: { basis: "none", total_usd: null } };
    m.estimateMeta = { margin_pct: 20, remaining_budget_usd: 4, first_run_usd: 10 };
    const { errors } = await start(page, m);
    await amount(page).fill("3");
    m.decide = [refusal(409, "envelope_below_first_run")];
    await press(page, tid(page, "pl-inbox-approve"));
    await expect(tid(page, "pl-inbox-sentence")).toHaveText("Your remaining budget this month is lower than the cost of the first run. Raise the monthly budget to approve this.");
    await expect(amount(page)).toHaveValue("3");
    await axeClean(page);
    await clean(page, errors);
  });

  test("the server's refusals read as their own sentences, keep the typed limit and let the person try again", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1)];
    m.estimates = { [proposal(1).id]: { basis: "none", total_usd: null } };
    const { errors } = await start(page, m);
    await amount(page).fill("1");
    const cases: [number, string, string][] = [
      [409, "envelope_below_first_run", "That limit is too low to start this item. Enter a higher one."],
      [409, "over_account_budget", "That limit is more than this account can still spend this month."],
      [400, "amount_required", AMOUNT_SENTENCE],
    ];
    for (const [status, code, words] of cases) {
      m.decide = [refusal(status, code)];
      await press(page, tid(page, "pl-inbox-approve"));
      await expect(tid(page, "pl-inbox-sentence")).toHaveText(words);
      await expect(amount(page)).toHaveValue("1");
      await expect(tid(page, "pl-inbox-approve")).toBeEnabled();
    }
    await axeClean(page);
    // Changing the limit after an unknown outcome is a new request: it gets a new key.
    m.decide = [{ status: 0, abort: true }];
    await press(page, tid(page, "pl-inbox-approve"));
    await expect(tid(page, "pl-inbox-sentence")).toBeVisible();
    const firstKey = m.posts.at(-1)?.key;
    await amount(page).fill("40");
    await press(page, tid(page, "pl-inbox-approve"));
    await expect(tid(page, "pl-inbox-note-line")).toContainText("Approved and started.");
    expect(m.posts.at(-1)?.key).not.toBe(firstKey);
    expect(bodyOf(m, m.posts.length - 1)).toEqual({ amount_usd: 40 });
    await clean(page, errors);
  });

  test("when the estimate cannot be read the field stays, blank and optional, and approve sends no body", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1)];
    const { errors } = await start(page, m);
    await expect(amount(page)).toHaveValue("");
    await expect(tid(page, "pl-inbox-amount-line")).toHaveCount(0);
    await press(page, tid(page, "pl-inbox-approve"));
    await expect(tid(page, "pl-inbox-note-line")).toContainText("Approved and started.");
    expect(m.posts[0].body).toBeNull();
    await clean(page, errors);
  });
});
