// apps/workspace/e2e/onboarding-install.spec.ts
//
// D#845 ON-20b: the install step's inline summary and merge, on the built cloud dist behind fixture-server.mjs. Every API answer is a page.route() mock shaped like ON-20a's two routes
// and the onboarding read; nothing reaches GitHub. One test per state: ready, member, changed (rebuild), files differ, blocked, already merged, a closed or merged pull request, hostile text.
// Desktop, tablet and phone all run every test; an axe scan covers the panel in its states.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";
import { engineTrack, withEngine } from "./helpers/onboarding-body";

const DIR = dirname(fileURLToPath(import.meta.url));
const fx = (...p: string[]) => JSON.parse(readFileSync(join(DIR, "..", "..", "..", "packages", "api", "fixtures", "v1", ...p), "utf8"));
const PLANS = JSON.parse(readFileSync(join(DIR, "plans-fixture.json"), "utf8"));
const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const PLACEHOLDER = /\b(null|undefined|nan)\b/i;
const SETUP = "3c1c0b7e-5f0a-4c1e-9b1f-0a1b2c3d4e5f";
const PR_URL = "https://github.com/acme/api/pull/12";
const SERVER_BLOCKED = "GitHub will not merge this yet; it may need a passing check or a review first. Finish those on GitHub, then try again";
const MEMBER = "Only an owner or admin can merge this. Copy the link and send it to someone who can.";
const DIFFER = "The pull request no longer holds the files we prepared, so it was not merged. Open it on GitHub to see what changed, or remove the project and start the install again.";

type Json = Record<string, unknown>;
const err = (status: number, code: string, message = "SERVER WORDS") => ({ status, json: { error: { code, message, request_id: "r" } } });
const cat = (id: string, label: string, files: number, added: number, changed: number, additions: number, deletions: number) => ({ id, label, files, added_files: added, changed_files: changed, additions, deletions });
/** ON-20a's summary body: the six fixed categories, each with files. */
const summary = (over: Json = {}): Json => ({
  setup_id: SETUP, pr_number: 12, head_sha: "a".repeat(40), merged: false, pr_url: PR_URL,
  totals: { files: 14, added_files: 13, changed_files: 1, additions: 410, deletions: 3 },
  categories: [
    cat("plan", "Your project plan (`docs/PRD.md`, roadmap, 2 epics)", 4, 4, 0, 120, 0),
    cat("team", "The team's settings (`.autonomous-team/`)", 2, 2, 0, 40, 0),
    cat("scripts", "5 helper scripts (`scripts/`)", 5, 5, 0, 200, 0),
    cat("agents", "The agents' instructions (`CLAUDE.md`, `.claude/`)", 1, 0, 1, 30, 3),
    cat("hook", "The sandbox hook", 1, 1, 0, 15, 0),
    cat("other", "1 other files", 1, 1, 0, 5, 0),
  ],
  paths: [".autonomous-team/config.json", ".autonomous-team/roadmap.json", "CLAUDE.md", "docs/PRD.md", "epics/one.md", "epics/two.md", "hooks/sandbox.py", "scripts/a.sh", "scripts/b.sh", "scripts/c.sh", "scripts/d.sh", "scripts/e.sh", "tools/x.txt", "docs/extra.md"],
  ...over,
});
interface Mock {
  admin: boolean; onboarding: Json; summaries: Array<Json | { status: number; json: unknown }>; merge: { status: number; json: unknown }[]; gets: number; merges: string[]; requests: string[];
}
const mock = (o: Partial<Mock> = {}): Mock => ({
  admin: true, summaries: [summary()], merge: [{ status: 200, json: { setup_id: SETUP, pr_number: 12, merged: true, already: false } }], gets: 0, merges: [], requests: [],
  onboarding: withEngine(fx("getOnboarding", "200-new.json"), engineTrack({ machine: "done", claude: "done", github_app: "done", project: "done", plan: "done", install: "active" }, { tier: "microvm", install: { setup_id: SETUP, pr_number: 12, pr_state: "open" } })),
  ...o,
});

async function setup(page: Page, m: Mock) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/")) m.requests.push(`${r.method()} ${u.pathname}`); });
  await page.addInitScript(() => { (window as unknown as { copied: string[] }).copied = []; Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t: string) => { (window as unknown as { copied: string[] }).copied.push(t); } }, configurable: true }); });
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  await page.route("**/api/cloud/auth/me", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), workspace_access: "no_subscription", is_admin: m.admin } });
  });
  await page.route((u) => u.pathname === "/api/v1/onboarding", (route) => route.fulfill({ json: m.onboarding }));
  await page.route("**/api/plans", (route) => route.fulfill({ json: { ...PLANS, plans: PLANS.plans, viewer: { is_owner: true, partner_billed: false } } }));
  await page.route((u) => u.pathname === "/api/runners", (route) => route.fulfill({ json: { runners: [] } }));
  await page.route((u) => u.pathname === "/api/machines", (route) => route.fulfill({ json: { machines: [] } }));
  await page.route((u) => u.pathname === `/api/v1/setups/${SETUP}/install/summary`, (route) => {
    const next = m.summaries[Math.min(m.gets++, m.summaries.length - 1)]!;
    return route.fulfill("status" in next ? { status: (next as { status: number }).status, json: (next as { json: unknown }).json } : { json: next });
  });
  await page.route((u) => u.pathname === `/api/v1/setups/${SETUP}/install/merge`, (route) => {
    m.merges.push(route.request().method());
    return route.fulfill(m.merge[Math.min(m.merges.length - 1, m.merge.length - 1)]!);
  });
  await page.route("https://github.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>github</title>" }));
  return problems;
}
const ob = (page: Page) => page.locator('.fulc-window[data-app-id="onboarding"]');
const t = (page: Page, id: string) => ob(page).locator(`[data-testid="ob-install-${id}"]`);
const boot = async (page: Page, m: Mock) => { const problems = await setup(page, m); await bootToDesktop(page); return problems; };
const copied = (page: Page) => page.evaluate(() => (window as unknown as { copied: string[] }).copied);
const noOverflow = async (page: Page) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await ob(page).locator('[data-testid="ob-app"]').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
};
const panel = (page: Page) => ob(page).locator('[data-testid="ob-install"]');
const scan = async (page: Page) =>
  (await new AxeBuilder({ page }).include('.fulc-window[data-app-id="onboarding"]').exclude(".window-titlebar").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze()).violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);

test.describe("the install step's summary and merge (D#845 ON-20b)", () => {
  test("an owner sees the six categories with counts, every path on request, the undo copy, and the three actions; nothing merges until the click", async ({ page }) => {
    const m = mock();
    const problems = await boot(page, m);
    await expect(panel(page)).toHaveAttribute("data-stage", "ready");
    await expect(t(page, "cat")).toHaveCount(6);
    await expect(t(page, "cat-label")).toHaveText([
      "Your project plan (`docs/PRD.md`, roadmap, 2 epics)", "The team's settings (`.autonomous-team/`)", "5 helper scripts (`scripts/`)", "The agents' instructions (`CLAUDE.md`, `.claude/`)", "The sandbox hook", "1 other files",
    ]);
    await expect(t(page, "cat").nth(3)).toContainText("1 file: 0 added, 1 changed (+30 -3 lines)");
    await expect(ob(page).getByText("What merging changes")).toBeVisible();
    await expect(ob(page).getByText("How to undo it")).toBeVisible();
    await expect(t(page, "undo")).toHaveText("Remove the project, or revert the merge on GitHub");
    await expect(t(page, "paths")).not.toHaveAttribute("open", "");
    await t(page, "paths").locator("summary").click();
    await expect(t(page, "paths").locator("li")).toHaveCount(14);
    await expect(t(page, "paths")).toContainText("hooks/sandbox.py");
    await expect(t(page, "merge")).toBeEnabled();
    await expect(t(page, "copy")).toHaveText("Copy a link for someone who can merge");
    await expect(t(page, "view")).toHaveAttribute("href", PR_URL);
    await expect(t(page, "view")).toHaveAttribute("target", "_blank");
    await expect(t(page, "view")).toHaveAttribute("rel", /noopener/);
    await expect(t(page, "member")).toHaveCount(0);
    await noOverflow(page);
    expect(await panel(page).innerText()).not.toMatch(PLACEHOLDER);
    expect(m.merges).toEqual([]);
    expect(await scan(page)).toEqual([]);
    expect(problems).toEqual([]);
  });

  test("Merge and continue posts once to the setup's merge route, says so, and the step re-reads", async ({ page }) => {
    const m = mock();
    await boot(page, m);
    await t(page, "merge").click();
    await expect(panel(page)).toHaveAttribute("data-stage", "merged");
    await expect(t(page, "note")).toHaveText("Merged. This step finishes when GitHub confirms it.");
    await expect(t(page, "merge")).toHaveCount(0);
    await expect(t(page, "view")).toBeVisible();
    expect(m.merges).toEqual(["POST"]);
    expect(m.requests.filter((r) => r === "GET /api/v1/onboarding").length).toBeGreaterThanOrEqual(2);
    expect(await scan(page)).toEqual([]);
  });

  test("a member sees Merge disabled with the reason, and can still copy the link and view the pull request", async ({ page }) => {
    const m = mock({ admin: false });
    await boot(page, m);
    await expect(panel(page)).toHaveAttribute("data-stage", "ready");
    await expect(t(page, "merge")).toBeDisabled();
    await expect(t(page, "member")).toHaveText(MEMBER);
    await t(page, "copy").click();
    expect(await copied(page)).toEqual([PR_URL]);
    await expect(ob(page).locator('[data-testid="ob-live"]')).toHaveText("Copied");
    await expect(t(page, "view")).toHaveAttribute("href", PR_URL);
    expect(m.merges).toEqual([]);
    await noOverflow(page);
    expect(await scan(page)).toEqual([]);
  });

  test("install_pr_changed rebuilds the summary from a new read and says why; the person then merges what they see", async ({ page }) => {
    const m = mock({
      summaries: [summary(), summary({ totals: { files: 1, added_files: 1, changed_files: 0, additions: 1, deletions: 0 }, categories: [cat("other", "1 other files", 1, 1, 0, 1, 0)], paths: ["only.txt"] })],
      merge: [err(409, "install_pr_changed"), { status: 200, json: { setup_id: SETUP, pr_number: 12, merged: true, already: false } }],
    });
    await boot(page, m);
    await t(page, "merge").click();
    await expect(t(page, "cat")).toHaveCount(1);
    await expect(t(page, "note")).toHaveText("The pull request changed on GitHub, so the summary was read again. Look it over, then merge.");
    await expect(panel(page)).not.toContainText("SERVER WORDS");
    expect(m.gets).toBe(2);
    await t(page, "merge").click();
    await expect(panel(page)).toHaveAttribute("data-stage", "merged");
    expect(m.merges).toEqual(["POST", "POST"]);
  });

  test("install_pr_files_differ shows our plain line, never the server's, and merges nothing", async ({ page }) => {
    const m = mock({ merge: [err(409, "install_pr_files_differ")] });
    await boot(page, m);
    await t(page, "merge").click();
    await expect(t(page, "error")).toHaveText(DIFFER);
    await expect(panel(page)).not.toContainText("SERVER WORDS");
    await expect(t(page, "view")).toBeVisible();
    await noOverflow(page);
    expect(await scan(page)).toEqual([]);
  });

  test("install_pr_blocked shows the server's sentence, keeps the summary, and offers the link for someone who can merge", async ({ page }) => {
    const m = mock({ admin: true, merge: [err(409, "install_pr_blocked", SERVER_BLOCKED)] });
    await boot(page, m);
    await t(page, "merge").click();
    await expect(t(page, "error")).toHaveText(SERVER_BLOCKED);
    await expect(t(page, "cat")).toHaveCount(6);
    await expect(t(page, "merge")).toBeEnabled();
    await t(page, "copy").click();
    expect(await copied(page)).toEqual([PR_URL]);
    expect(await scan(page)).toEqual([]);
  });

  test("a pull request already merged on GitHub shows its summary with no Merge button", async ({ page }) => {
    const m = mock({ summaries: [summary({ merged: true })] });
    await boot(page, m);
    await expect(panel(page)).toHaveAttribute("data-stage", "merged");
    await expect(t(page, "note")).toHaveText("This pull request is already merged. This step finishes when GitHub confirms it.");
    await expect(t(page, "merge")).toHaveCount(0);
    await expect(t(page, "copy")).toHaveCount(0);
    await expect(t(page, "view")).toBeVisible();
  });

  test("a summary that cannot be read says so with Try again, and a second read recovers", async ({ page }) => {
    const m = mock({ summaries: [err(502, "github_unavailable"), summary()] });
    await boot(page, m);
    await expect(panel(page)).toHaveAttribute("data-stage", "failed");
    await expect(t(page, "error")).toHaveText("The summary couldn't be loaded. Try again.");
    await expect(panel(page)).not.toContainText("SERVER WORDS");
    await t(page, "retry").click();
    await expect(panel(page)).toHaveAttribute("data-stage", "ready");
    expect(await scan(page)).toEqual([]);
  });

  test("a closed or merged pull request has no panel, and no summary is read", async ({ page }) => {
    for (const state of ["merged", "closed"]) {
      const m = mock({ onboarding: withEngine(fx("getOnboarding", "200-new.json"), engineTrack({ machine: "done", claude: "done", github_app: "done", project: "done", plan: "done", install: state === "merged" ? "done" : "active" }, { tier: "microvm", install: { setup_id: SETUP, pr_number: 12, pr_state: state } })) });
      const p = await page.context().newPage();
      await boot(p, m);
      await expect(ob(p).locator('[data-testid="ob-track-engine"]')).toBeVisible();
      await expect(ob(p).locator('[data-testid="ob-install"]')).toHaveCount(0);
      expect(m.gets).toBe(0);
      await p.close();
    }
  });

  test("the server's labels and paths are text: markup in them is shown as typed and creates no element", async ({ page }) => {
    const evil = "<img src=x onerror=window.__pwned=1>";
    const m = mock({ summaries: [summary({ categories: [cat("plan", evil, 1, 1, 0, 1, 0)], paths: [evil, "<b>bold</b>.md"], totals: { files: 2, added_files: 2, changed_files: 0, additions: 2, deletions: 0 } })] });
    const problems = await boot(page, m);
    await expect(t(page, "cat-label")).toHaveText(evil);
    await t(page, "paths").locator("summary").click();
    await expect(t(page, "paths")).toContainText("<b>bold</b>.md");
    await expect(panel(page).locator("img, b")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(problems).toEqual([]);
  });

  test("a link that is not a github.com address is never offered", async ({ page }) => {
    const m = mock({ summaries: [summary({ pr_url: "javascript:alert(1)" })] });
    await boot(page, m);
    await expect(panel(page)).toHaveAttribute("data-stage", "failed");
    await expect(ob(page).locator('a[href^="javascript:"]')).toHaveCount(0);
  });
});
