// apps/workspace/e2e/memory-role-lessons.spec.ts
//
// D#601 MEM-9: an agent-proposed role lesson in the Memory app's review queue, against a small mock of the memory routes. A lesson with evidence from
// one repo has its Approve control disabled (aria-disabled, so it stays in the tab order) with the words "Needs evidence from a second repo" beside it;
// pressing it or the A key changes nothing; a lesson with two repos approves; a role scope never offers a batch. The document carries the production CSP.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page, type Route } from "@playwright/test";
import { waitForDesktop } from "./helpers/boot";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const V1 = join(SCRIPT_DIR, "..", "..", "..", "packages", "api", "fixtures", "v1");
const REPOS = JSON.parse(readFileSync(join(V1, "listRepos", "200-page.json"), "utf8"));
const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const WIN = `#windows-container .fulc-window[data-app-id="memory"]`;
const tid = (page: Page, id: string) => page.locator(`${WIN} [data-testid="${id}"]`);
const iso = "2026-10-16T07:00:00.000Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

interface Lesson {
  id: string;
  body: string;
  repos: number;
}

function card(l: Lesson) {
  return {
    entry: {
      id: l.id, scope: "role", kind: "convention", body: l.body, why: null, author_kind: "agent", status: "proposed", version: 1,
      content_sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", created_at: iso, updated_at: iso, approved_at: null, expires_at: "2026-10-30T07:00:00.000Z",
    },
    title: l.body, kind_label: "Convention", source: "Agent (run 8b2c5e74) in acme/widgets", proposed_by: "Proposed by agent (run 8b2c5e74) in acme/widgets (from a failed run)",
    evidence: "", age: "2 hours ago", open_state: "not_required", scope_label: "executor", evidence_repos: l.repos, needs_second_repo: l.repos < 2,
  };
}

async function setup(page: Page, lessons: Lesson[]) {
  const requests: string[] = [];
  let open = [...lessons];
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }).catch(() => undefined);
  await page.route((u) => u.pathname.startsWith("/api/v1/repos"), (route) => json(route, 200, REPOS));
  await page.route((u) => u.pathname.startsWith("/api/v1/memory"), async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace("/api/v1/memory", "");
    requests.push(`${req.method()} ${path}`);
    if (path === "" && req.method() === "GET") return json(route, 200, { groups: [], truncated: false });
    if (path === "/queue") return json(route, 200, { cards: open.map(card), truncated: false });
    if (path === "/pending-counts") return json(route, 200, { repos: {}, items: {} });
    const m = /^\/([0-9a-f-]{36})\/decide$/.exec(path);
    if (m) {
      open = open.filter((l) => l.id !== m[1]);
      return json(route, 200, { outcome: "decided", entry: { ...card(lessons.find((l) => l.id === m[1])!).entry, status: "approved" } });
    }
    return json(route, 404, { error: { code: "not_found", message: "x", request_id: "r" } });
  });
  await page.route("**/api/v1/events", () => new Promise<void>(() => {}));
  await page.route((u) => u.pathname.startsWith("/api/v1/runs"), (route) => json(route, 200, { data: [], next_cursor: null }));
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  await page.goto("/");
  await waitForDesktop(page);
  await page.locator('.dock-icon[data-app-id="memory"]').click();
  await expect(page.locator(WIN)).toBeVisible();
  await expect(page.locator(WIN)).not.toHaveClass(/opening/);
  return { requests };
}

test.describe("D#601 MEM-9: agent-proposed role lessons in the queue", () => {
  test("one repo of evidence: Approve is disabled with the words, stays focusable, and does nothing; two repos approve; no batch for a role", async ({ page }) => {
    const one = { id: uuid(1), body: "Run the linter before a pull request", repos: 1 };
    const two = { id: uuid(2), body: "Read the Spec before writing code", repos: 2 };
    const { requests } = await setup(page, [one, two]);
    await expect(tid(page, "mem-card")).toHaveCount(2);

    const first = page.locator(`${WIN} [data-card="${one.id}"]`);
    const approve = first.locator('[data-testid="mem-approve"]');
    await expect(approve).toHaveAttribute("aria-disabled", "true");
    await expect(first.locator('[data-testid="mem-need-repo"]')).toHaveText("Needs evidence from a second repo");
    await expect(approve).toHaveAccessibleDescription("Needs evidence from a second repo");
    await expect(first.locator('[data-testid="mem-card-proposed-by"]')).toContainText("in acme/widgets (from a failed run)");
    await approve.focus();
    await expect(approve).toBeFocused();
    const border = () => approve.evaluate((el) => getComputedStyle(el).borderTopColor);
    const resting = await border();
    await approve.hover();
    expect(await border()).toBe(resting); // no hover accent on a blocked control
    await expect(tid(page, "mem-status")).toHaveText("");
    await approve.click({ force: true }); // aria-disabled: Playwright would wait for "enabled" otherwise
    await expect(tid(page, "mem-status")).toHaveText("Needs evidence from a second repo");
    await page.evaluate(() => { document.querySelector('[data-testid="mem-status"]')!.textContent = ""; });
    await first.focus();
    await page.keyboard.press("a");
    await expect(tid(page, "mem-status")).toHaveText("Needs evidence from a second repo"); // the A key says the same
    expect(requests.filter((r) => r.includes("decide"))).toEqual([]);
    await expect(tid(page, "mem-card")).toHaveCount(2);
    // The batch bar stays for the two agent cards, with Reject only: role lessons are approved one at a time.
    await expect(page.locator(`${WIN} [data-testid="mem-batch"]`)).toHaveCount(1);
    await expect(page.locator(`${WIN} [data-testid="mem-batch-approve"]`)).toHaveCount(0);
    await expect(page.locator(`${WIN} [data-testid="mem-batch-reject"]`)).toHaveCount(1);
    // The reason sits in the same row as Approve.
    await expect(first.locator('.mem-actions [data-testid="mem-need-repo"]')).toHaveText("Needs evidence from a second repo");

    const ok = page.locator(`${WIN} [data-card="${two.id}"] [data-testid="mem-approve"]`);
    await expect(ok).not.toHaveAttribute("aria-disabled", "true");
    await ok.click();
    await expect(tid(page, "mem-card")).toHaveCount(1);
    expect(requests.filter((r) => r.includes("decide"))).toEqual([`POST /${two.id}/decide`]);

    const res = await new AxeBuilder({ page }).include(WIN).exclude(`${WIN} .window-titlebar`).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
    expect(res.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
    expect(await page.locator(WIN).innerText()).not.toMatch(/\bnull\b|\bundefined\b|NaN/);
  });
});
