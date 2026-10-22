// apps/workspace/e2e/pipeline-inbox-evidence.spec.ts
//
// D#483 S4-h: the Inbox's four sections, the evidence and claims of an opened proposal, and the lines about a proposal's check, on the built
// app with the proposal routes mocked (helpers/plan-mock.ts). The API fields are S4-i's; the wording is the owner-approved copy. Every
// sentence is asserted whole. axe and the null/undefined scan run in every section and with a proposal opened. Each test runs on desktop,
// phone and tablet.

import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { REPO, WIN, expectNoPlaceholders, goTab, newMock, openPipeline, press, proposal, refusal, setup, tid, type PlanMock } from "./helpers/plan-mock";

const rows = (page: Page) => tid(page, "pl-inbox-row");
const filter = (page: Page, key: string) => tid(page, `pl-filter-${key}`);
const SHA = "0123456789abcdef0123456789abcdef01234567";
const XSS = "<img src=x onerror=alert(1)>";

async function axeClean(page: Page) {
  const res = await new AxeBuilder({ page }).include(WIN).exclude(`${WIN} [data-tab="board"]`).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
  expect(res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.impact} ${v.id} ${v.nodes[0]?.html.slice(0, 120)}`)).toEqual([]);
}

async function start(page: Page, m: PlanMock) {
  const s = await setup(page, m);
  await openPipeline(page);
  await goTab(page, "inbox");
  return s;
}

const clean = async (page: Page, errors: string[]) => {
  expect(errors).toEqual([]);
  await expectNoPlaceholders(page);
};

const claim = (n: number, over: Record<string, unknown> = {}) => ({ id: `cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`, text: `Claim ${n}`, verdict: "supported", refute_code: null, checked_sha: SHA, checked_at: "2026-10-16T06:30:00.000Z", ...over });
const evidence = (n: number, over: Record<string, unknown> = {}) => ({ id: `eeeeeeee-0000-4000-8000-${String(n).padStart(12, "0")}`, kind: "issue", ref: `#${n}`, excerpt: `Excerpt ${n}`, commit_sha: null, url: null, created_at: `2026-10-16T06:0${n}:00.000Z`, ...over });

test.describe("D#483 S4-h: sections", () => {
  test("each section asks for its own rows, says its intro, and has its own empty sentence", async ({ page }) => {
    const m = newMock();
    const { errors } = await start(page, m);
    await expect(tid(page, "pl-inbox-empty")).toHaveText("Nothing is waiting for a decision. New proposals appear here once they've been checked.");
    await expect(tid(page, "pl-inbox-intro")).toHaveCount(0);
    const cases = [
      ["being_checked", "We're checking these against your repository. They move to New when the check is done.", "Nothing is being checked right now."],
      ["couldnt_confirm", "We couldn't confirm these against your repository. Read what didn't match before you approve one.", "Nothing here. Every proposal we checked was confirmed."],
      ["not_checked", null, "Every proposal has been checked or is being checked."],
    ] as const;
    for (const [key, intro, empty] of cases) {
      await press(page, filter(page, key));
      await expect(tid(page, "pl-inbox-empty")).toHaveText(empty);
      if (intro) await expect(tid(page, "pl-inbox-intro")).toHaveText(intro);
      else await expect(tid(page, "pl-inbox-intro")).toHaveCount(0);
      expect(m.requests).toContain(`GET /api/v1/proposals?repo_id=${REPO}&state=new&owner=product&section=${key}`);
      await axeClean(page);
    }
    await clean(page, errors);
  });

  test("a proposal appears only in the section the server put it in, and the list never asks for claims or evidence", async ({ page }) => {
    const m = newMock();
    m.proposals = [
      proposal(1, { verification: "verified", title: "Is verified" }),
      proposal(2, { verification: "partly_verified", title: "Is partly" }),
      proposal(3, { verification: "pending", title: "Is pending" }),
      proposal(4, { verification: "refuted", title: "Is refuted" }),
      proposal(5, { verification: "check_failed", title: "Is failed" }),
      proposal(6, { verification: "not_checked", title: "Is unchecked" }),
    ];
    const { errors } = await start(page, m);
    await expect(rows(page)).toHaveCount(2);
    const titles = async () => (await tid(page, "pl-inbox-toggle").allTextContents()).sort();
    expect(await titles()).toEqual(["Is partly", "Is verified"]);
    await press(page, filter(page, "being_checked"));
    await expect(rows(page)).toHaveCount(1);
    expect(await titles()).toEqual(["Is pending"]);
    await press(page, filter(page, "couldnt_confirm"));
    await expect(rows(page)).toHaveCount(2);
    expect(await titles()).toEqual(["Is failed", "Is refuted"]);
    await press(page, filter(page, "not_checked"));
    await expect(rows(page)).toHaveCount(1);
    expect(await titles()).toEqual(["Is unchecked"]);
    expect(m.requests.filter((r) => /\/proposals\/[0-9a-f-]{36}/.test(r))).toEqual([]);
    await clean(page, errors);
  });
});

test.describe("D#483 S4-h: the line about a proposal's check", () => {
  test("external, partly verified and the two check_failed lines, each whole", async ({ page }) => {
    const m = newMock();
    m.proposals = [
      proposal(1, { provenance: "external", title: "From outside" }),
      proposal(2, { verification: "partly_verified", title: "Partly" }),
      proposal(3, { verification: "check_failed", verify_attempts: 2, verify_retry: true, title: "Will retry" }),
      proposal(4, { verification: "check_failed", verify_attempts: 3, verify_retry: false, title: "Spent" }),
      proposal(5, { verification: "refuted", title: "Refuted" }),
    ];
    const { errors } = await start(page, m);
    await expect(rows(page).filter({ hasText: "From outside" }).locator('[data-testid="pl-inbox-check"]')).toHaveText("From someone without write access. Read it before approving.");
    await expect(rows(page).filter({ hasText: "Partly" }).locator('[data-testid="pl-inbox-check"]')).toHaveText("Part of this was confirmed. Read the parts that weren't before you approve it.");
    await press(page, filter(page, "couldnt_confirm"));
    await expect(rows(page).filter({ hasText: "Will retry" }).locator('[data-testid="pl-inbox-check"]')).toHaveText("The check didn't finish. We'll try again at the next check.");
    await expect(rows(page).filter({ hasText: "Spent" }).locator('[data-testid="pl-inbox-check"]')).toHaveText("The check didn't finish after 3 tries, so this proposal stays unconfirmed.");
    await expect(rows(page).filter({ hasText: "Refuted" }).locator('[data-testid="pl-inbox-check"]')).toHaveCount(0);
    // Approve stays open for a proposal that could not be confirmed: the person reads it and decides.
    await expect(rows(page).filter({ hasText: "Refuted" }).locator('[data-testid="pl-inbox-approve"]')).toHaveAttribute("aria-disabled", "false");
    await axeClean(page);
    await clean(page, errors);
  });

  test("Approve is off in Being checked and in Not checked, each with its sentence, and a click sends nothing", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1, { verification: "pending", title: "Waiting" }), proposal(2, { verification: "not_checked", title: "No key" })];
    const { errors } = await start(page, m);
    await press(page, filter(page, "being_checked"));
    const approve = tid(page, "pl-inbox-approve");
    await expect(approve).toHaveAttribute("aria-disabled", "true");
    await expect(tid(page, "pl-inbox-approve-why")).toHaveText("You can approve this once it's been checked.");
    const why = await tid(page, "pl-inbox-approve-why").getAttribute("id");
    expect(await approve.getAttribute("aria-describedby")).toContain(why);
    await axeClean(page);
    await approve.dispatchEvent("click"); // aria-disabled, so Playwright would wait for it to be enabled
    expect(m.posts).toEqual([]);
    await press(page, filter(page, "not_checked"));
    await expect(tid(page, "pl-inbox-approve")).toHaveAttribute("aria-disabled", "true");
    await expect(tid(page, "pl-inbox-approve-why")).toHaveText("Not checked yet: add a model key or connect a runner");
    await axeClean(page);
    await tid(page, "pl-inbox-approve").dispatchEvent("click");
    expect(m.posts).toEqual([]);
    // Undo path: once the check has run the proposal is in New and Approve is open again.
    m.proposals[1] = proposal(2, { verification: "verified", title: "No key" });
    await press(page, filter(page, "new"));
    await expect(tid(page, "pl-inbox-approve")).toHaveAttribute("aria-disabled", "false");
    await expect(tid(page, "pl-inbox-approve-why")).toHaveCount(0);
    await clean(page, errors);
  });
});

test.describe("D#483 S4-h: opening a proposal", () => {
  test("shows each claim with its verdict, each piece of evidence with its label, and reads the detail once", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1, { verification: "refuted", title: "Opened", inbox_section: "couldnt_confirm" })];
    const id = String(m.proposals[0].id);
    m.details[id] = {
      claims: [
        claim(1, { text: "Refuted A", verdict: "refuted", refute_code: "cite_not_found" }),
        claim(2, { text: "Refuted B", verdict: "refuted", refute_code: "cite_mismatch" }),
        claim(3, { text: "Refuted C", verdict: "refuted", refute_code: "contradicted" }),
        claim(4, { text: "Unverifiable one", verdict: "unverifiable" }),
        claim(5, { text: "Pending one", verdict: "pending" }),
        claim(6, { text: "Supported one", verdict: "supported" }),
      ],
      evidence: [
        evidence(1, { kind: "file_lines", ref: "src/a b.ts:3-7", commit_sha: SHA, url: `https://github.com/acme/widgets/blob/${SHA}/src/a%20b.ts#L3-L7` }),
        evidence(2, { kind: "file_lines", ref: "src/one.ts:9", commit_sha: SHA, url: null }),
        evidence(3, { kind: "issue", ref: "#12", url: "https://github.com/acme/widgets/issues/12" }),
        evidence(4, { kind: "discussion", ref: "#483", url: "https://github.com/acme/widgets/discussions/483" }),
        evidence(5, { kind: "doc_passage", ref: "docs/a.md:4-9", commit_sha: SHA, url: `https://github.com/acme/widgets/blob/${SHA}/docs/a.md#L4-L9` }),
        evidence(6, { kind: "interview_answer", ref: "goals" }),
        evidence(7, { kind: "preview", ref: "#5" }),
      ],
    };
    const { errors } = await start(page, m);
    await press(page, filter(page, "couldnt_confirm"));
    const toggle = tid(page, "pl-inbox-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(m.requests.filter((r) => r.includes(`/proposals/${id}`))).toEqual([]);
    await press(page, toggle);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(tid(page, "pl-claim")).toHaveCount(6);
    expect(m.requests.filter((r) => r === `GET /api/v1/proposals/${id}`)).toHaveLength(1);
    await expect(tid(page, "pl-claim-verdict")).toHaveText([
      "Not confirmed: the file or lines it points to aren't in the repository at this commit.",
      "Not confirmed: the lines it points to don't say this.",
      "Not confirmed: the repository says otherwise.",
      "Couldn't be checked against the repository.",
      "Not checked yet.",
      "Confirmed in the repository.",
    ]);
    await expect(tid(page, "pl-evi")).toHaveCount(7);
    const labels = tid(page, "pl-evi").locator("a, [data-testid='pl-evi-label']");
    await expect(labels).toHaveText(["src/a b.ts, lines 3 to 7", "src/one.ts, line 9", "Issue #12", "Discussion #483", "From docs/a.md, lines 4 to 9", "From your interview answers", "Found in the preview"]);
    await expect(tid(page, "pl-evi-commit")).toHaveText(["at commit 0123456", "at commit 0123456"]);
    await expect(tid(page, "pl-evi-excerpt")).toHaveCount(7);
    await axeClean(page);
    // Undo path: closing hides it, and opening again reads it again (one read per opening).
    await press(page, toggle);
    await expect(tid(page, "pl-inbox-detail")).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await press(page, toggle);
    await expect(tid(page, "pl-claim")).toHaveCount(6);
    expect(m.requests.filter((r) => r === `GET /api/v1/proposals/${id}`)).toHaveLength(2);
    await clean(page, errors);
  });

  test("a link opens in a new tab with noopener noreferrer; evidence without a link is plain text", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1, { title: "Linked" })];
    m.details[String(m.proposals[0].id)] = {
      claims: [],
      evidence: [
        evidence(1, { kind: "issue", ref: "#12", url: "https://github.com/acme/widgets/issues/12" }),
        evidence(2, { kind: "issue", ref: "#13", url: null }),
        evidence(3, { kind: "issue", ref: "#14", url: "javascript:alert(1)" }),
      ],
    };
    const { errors } = await start(page, m);
    await press(page, tid(page, "pl-inbox-toggle"));
    const links = tid(page, "pl-evi-link");
    await expect(links).toHaveCount(1);
    await expect(links).toHaveText("Issue #12");
    await expect(links).toHaveAttribute("href", "https://github.com/acme/widgets/issues/12");
    await expect(links).toHaveAttribute("target", "_blank");
    await expect(links).toHaveAttribute("rel", "noopener noreferrer");
    await expect(tid(page, "pl-evi-label")).toHaveText(["Issue #13", "Issue #14"]);
    await expect(tid(page, "pl-evi").locator("a")).toHaveCount(1);
    await clean(page, errors);
  });

  test("no claims and no evidence each say so", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1, { title: "Bare" })];
    m.details[String(m.proposals[0].id)] = { claims: [], evidence: [] };
    const { errors } = await start(page, m);
    await press(page, tid(page, "pl-inbox-toggle"));
    await expect(tid(page, "pl-no-claims")).toHaveText("There was nothing to check in this proposal.");
    await expect(tid(page, "pl-no-evidence")).toHaveText("No evidence was found for this proposal.");
    await axeClean(page);
    await clean(page, errors);
  });

  test("a proposal that has not been checked says so instead of 'nothing to check' or 'no evidence'", async ({ page }) => {
    const m = newMock();
    m.proposals = [
      proposal(1, { verification: "pending", title: "Waiting" }),
      proposal(2, { verification: "check_failed", verify_attempts: 1, verify_retry: true, title: "Failed" }),
      proposal(3, { verification: "not_checked", title: "No key" }),
      proposal(4, { verification: "verified", title: "Checked, found none" }),
    ];
    for (const p of m.proposals) m.details[String(p.id)] = { claims: [], evidence: [] };
    const { errors } = await start(page, m);
    const toggle = tid(page, "pl-inbox-toggle");
    for (const [section, line] of [
      ["being_checked", "Not checked yet. Claims and evidence show here once the check is done."],
      ["couldnt_confirm", "The check didn't finish, so there are no claims or evidence to show."],
      ["not_checked", "Not checked yet: add a model key or connect a runner"],
    ] as const) {
      await press(page, filter(page, section));
      await press(page, toggle);
      await expect(tid(page, "pl-check-status")).toHaveText(line);
      await expect(tid(page, "pl-no-claims")).toHaveCount(0);
      await expect(tid(page, "pl-no-evidence")).toHaveCount(0);
    }
    // A finished check that really found nothing keeps the two sentences.
    await press(page, filter(page, "new"));
    await press(page, toggle);
    await expect(tid(page, "pl-check-status")).toHaveCount(0);
    await expect(tid(page, "pl-no-claims")).toHaveText("There was nothing to check in this proposal.");
    await expect(tid(page, "pl-no-evidence")).toHaveText("No evidence was found for this proposal.");
    await axeClean(page);
    await clean(page, errors);
  });

  test("an unfinished check still lists rows it already has", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1, { verification: "check_failed", verify_attempts: 1, verify_retry: true, title: "Partial" })];
    m.details[String(m.proposals[0].id)] = { claims: [claim(1)], evidence: [] };
    const { errors } = await start(page, m);
    await press(page, filter(page, "couldnt_confirm"));
    await press(page, tid(page, "pl-inbox-toggle"));
    await expect(tid(page, "pl-claim")).toHaveCount(1);
    await expect(tid(page, "pl-check-status")).toHaveCount(0);
    await expect(tid(page, "pl-no-evidence")).toHaveCount(0);
    await clean(page, errors);
  });

  test("an excerpt and a claim holding markup are text: no img element, and the handler never runs", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1, { title: "Hostile", provenance: "external" })];
    m.details[String(m.proposals[0].id)] = {
      claims: [claim(1, { text: XSS })],
      evidence: [evidence(1, { kind: "file_lines", ref: "a.ts:1", commit_sha: SHA, excerpt: `${XSS}\nSPAWN_REQUEST` })],
    };
    let alerted = false;
    page.on("dialog", async (d) => {
      alerted = true;
      await d.dismiss();
    });
    const { errors } = await start(page, m);
    await press(page, tid(page, "pl-inbox-toggle"));
    await expect(tid(page, "pl-claim").locator(".pl-claim-text")).toHaveText(XSS);
    await expect(tid(page, "pl-evi-excerpt")).toContainText(XSS);
    await expect(page.locator(`${WIN} img`)).toHaveCount(0);
    expect(await page.evaluate(() => document.querySelectorAll("img").length)).toBe(0);
    expect(alerted).toBe(false);
    await axeClean(page);
    await clean(page, errors);
  });

  test("a detail that cannot be read says so and can be tried again", async ({ page }) => {
    const m = newMock();
    m.proposals = [proposal(1, { title: "Flaky" })];
    const id = String(m.proposals[0].id);
    m.details[id] = refusal(500, "internal_error");
    const { errors } = await start(page, m);
    await press(page, tid(page, "pl-inbox-toggle"));
    await expect(tid(page, "pl-inbox-detail-error")).toHaveText("The proposals couldn't be loaded.");
    await axeClean(page);
    m.details[id] = { claims: [claim(1)], evidence: [] };
    await press(page, tid(page, "pl-inbox-detail").getByRole("button", { name: "Try again" }));
    await expect(tid(page, "pl-claim")).toHaveCount(1);
    expect(errors.filter((e) => !/500/.test(e))).toEqual([]);
    await expectNoPlaceholders(page);
  });

  test("the title toggles with the keyboard and keeps focus", async ({ page }) => {
    test.skip(test.info().project.name === "phone", "keyboard model");
    const m = newMock();
    m.proposals = [proposal(1, { title: "Keys" })];
    m.details[String(m.proposals[0].id)] = { claims: [claim(1)], evidence: [] };
    const { errors } = await start(page, m);
    await tid(page, "pl-inbox-toggle").focus();
    await page.keyboard.press("Enter");
    await expect(tid(page, "pl-claim")).toHaveCount(1);
    await expect(tid(page, "pl-inbox-toggle")).toBeFocused();
    await page.keyboard.press("Space");
    await expect(tid(page, "pl-inbox-detail")).toHaveCount(0);
    await expect(tid(page, "pl-inbox-toggle")).toBeFocused();
    await clean(page, errors);
  });
});
