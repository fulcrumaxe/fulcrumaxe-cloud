// apps/workspace/e2e/memory-undo.spec.ts
//
// D#601 MEM-4b3: undo, delete and restore, history and export in the Memory app, with real clicks, against a small stateful mock of the memory routes
// (the 4b2 routes' answers and refusals: a revert whose entry already moved answers 422 invalid_transition, a restore after 30 days is refused, and
// restore-previous answers 409 when the entry changed). Every test runs under the desktop, phone and tablet projects.

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
const REPO_ID = REPOS.data[0].id as string;
const REPO_NAME = REPOS.data[0].full_name as string;
const ITEM_ID = "5a2d9e18-7c3b-4f61-8e04-b6d2c1a97f35";
const DAY = 86400000;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const iso = "2026-10-16T07:00:00.000Z";

interface E {
  id: string;
  scope: "repo" | "item" | "account";
  status: string;
  title: string;
  version: number;
  before?: string;
  deletedDaysAgo?: number;
}
interface Mock {
  requests: string[];
  entries: E[];
  admin: boolean;
  revertError: { status: number; code: string } | null;
  previousError: { status: number; code: string } | null;
  omitted: number;
  purged: boolean;
  revertDelayMs: number;
  meDelayMs: number;
  meFails: boolean;
  meCalls: number;
}
const initial = (): Mock => ({
  requests: [],
  entries: [
    { id: uuid(1), scope: "repo", status: "proposed", title: "The build needs Node 24", version: 1 },
    { id: uuid(2), scope: "repo", status: "proposed", title: "Run pnpm install before pnpm test", version: 1 },
    { id: uuid(3), scope: "repo", status: "proposed", title: "Use the staging database for live checks", version: 1 },
    { id: uuid(20), scope: "repo", status: "approved", title: "pnpm test --run", version: 1 },
    { id: uuid(21), scope: "repo", status: "approved", title: "Deploys go through the merge wrapper", version: 2 },
    { id: uuid(22), scope: "repo", status: "rejected", title: "Rejected idea", version: 1 },
    { id: uuid(23), scope: "repo", status: "expired", title: "Expired idea", version: 1 },
    { id: uuid(24), scope: "repo", status: "retired", title: "Retired idea", version: 1 },
    { id: uuid(26), scope: "item", status: "approved", title: "The migration runs first", version: 1 },
    { id: uuid(30), scope: "repo", status: "deleted", title: "Deleted five days ago", version: 1, before: "approved", deletedDaysAgo: 5 },
    { id: uuid(31), scope: "repo", status: "deleted", title: "Deleted thirty-one days ago", version: 1, before: "approved", deletedDaysAgo: 31 },
  ],
  admin: true,
  revertError: null,
  previousError: null,
  omitted: 0,
  purged: false,
  revertDelayMs: 0,
  meDelayMs: 0,
  meFails: false,
  meCalls: 0,
});

async function mockApi(page: Page, mock: Mock) {
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  const err = (code: string) => ({ error: { code, message: "server text that must never be shown", request_id: "req_1" } });
  const entryDto = (e: E) => ({ id: e.id, scope: e.scope, kind: "fact", body: e.title, why: null, author_kind: "agent", status: e.status, version: e.version, content_sha256: "0".repeat(64), created_at: iso, updated_at: iso, approved_at: null, expires_at: null });
  const label: Record<string, string> = { proposed: "Proposed", approved: "Approved", rejected: "Rejected", expired: "Expired", retired: "Retired", deleted: "Deleted" };
  const icon: Record<string, string> = { proposed: "inbox", approved: "check", rejected: "cross", expired: "clock", retired: "pause", deleted: "trash" };
  const rowDto = (e: E) => ({ id: e.id, scope: e.scope, kind: "fact", kind_label: "Fact", status: e.status, status_label: label[e.status], status_icon: icon[e.status], title: e.title, author_kind: "agent", source: "Proposed by an agent", version: e.version, created_at: iso, deleted_at: e.status === "deleted" ? new Date(Date.now() - (e.deletedDaysAgo ?? 0) * DAY).toISOString() : null, age: "2 days ago", runs: 0, runs_label: "Not used yet" });
  const cardDto = (e: E) => ({ entry: entryDto(e), title: e.title, kind_label: "Fact", source: "Proposed by an agent", proposed_by: "Proposed by agent (run 8b2c5e74)", evidence: "", age: "2 hours ago", open_state: "not_required", scope_label: REPO_NAME });
  const byId = (id: string) => mock.entries.find((e) => e.id === id);
  const START: Record<string, [string, string]> = { undo_approve: ["approved", "proposed"], reconsider: ["rejected", "proposed"], renew: ["expired", "proposed"], restore_retired: ["retired", "approved"], retire: ["approved", "retired"] };

  await page.route((u) => u.pathname === "/api/cloud/auth/me", async (route) => {
    if (mock.meDelayMs) await new Promise((r) => setTimeout(r, mock.meDelayMs));
    if (mock.meFails && ++mock.meCalls > 1) return json(route, 500, err("internal_error"));
    const res = await route.fetch();
    await json(route, 200, { ...(await res.json()), is_admin: mock.admin });
  });
  await page.route((u) => u.pathname.startsWith("/api/v1/repos"), (route) => json(route, 200, REPOS));
  await page.route((u) => u.pathname.startsWith("/api/v1/memory"), async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const body = req.postData() ? JSON.parse(req.postData()!) : undefined;
    mock.requests.push(`${req.method()} ${url.pathname}${url.search}${body === undefined ? "" : " " + JSON.stringify(body)}`);
    const path = url.pathname.replace("/api/v1/memory", "");
    const ok = (b: unknown) => json(route, 200, b);
    const refuse = (status: number, code: string) => json(route, status, err(code));
    if (path === "" && req.method() === "GET") {
      const want = (url.searchParams.get("status") ?? "proposed,approved,rejected,expired,retired").split(",");
      const groups = (["repo", "item", "account"] as const)
        .map((scope) => ({ scope, label: scope === "repo" ? REPO_NAME : scope === "item" ? "#42 Add the thing" : "Account", target_id: scope === "repo" ? REPO_ID : scope === "item" ? ITEM_ID : null, entries: mock.entries.filter((e) => e.scope === scope && want.includes(e.status)).map(rowDto) }))
        .filter((g) => g.entries.length > 0 || g.scope === "repo");
      return ok({ groups, truncated: false });
    }
    if (path === "/queue") return ok({ cards: mock.entries.filter((e) => e.status === "proposed").map(cardDto), truncated: false });
    if (path === "/pending-counts") return ok({ repos: { [REPO_ID]: mock.entries.filter((e) => e.status === "proposed").length }, items: {} });
    if (path === "/decide-batch") {
      for (const id of body.ids) byId(id)!.status = body.to;
      return ok({ decided: body.ids.length, entries: [] });
    }
    if (path === "/revert") {
      if (mock.revertDelayMs) await new Promise((r) => setTimeout(r, mock.revertDelayMs));
      if (mock.revertError) return refuse(mock.revertError.status, mock.revertError.code);
      const [from, to] = START[body.action];
      if (body.ids.some((id: string) => byId(id)?.status !== from)) return refuse(422, "invalid_transition");
      for (const id of body.ids) byId(id)!.status = to;
      return ok({ changed: body.ids.length, entries: body.ids.map((id: string) => entryDto(byId(id)!)) });
    }
    if (path === "/export") {
      const f = url.searchParams.get("format") === "claude" ? "CLAUDE.md" : "AGENTS.md";
      return ok({ format: url.searchParams.get("format"), filename: f, content: `# ${f}\n\n- Run pnpm test --run\n`, entries: 2, omitted: mock.omitted });
    }
    const m = /^\/([0-9a-f-]{36})\/(decide|delete|restore|restore-previous|history)$/.exec(path);
    const e = m ? byId(m[1]) : undefined;
    if (!m || !e) return refuse(404, "not_found");
    switch (m[2]) {
      case "decide":
        e.status = body.to;
        return ok({ outcome: "decided", entry: entryDto(e) });
      case "delete":
        e.before = e.status;
        e.status = "deleted";
        e.deletedDaysAgo = 0;
        return ok({ outcome: "deleted", entry: entryDto(e) });
      case "restore":
        if (e.status !== "deleted") return ok({ outcome: "not_deleted", entry: entryDto(e) });
        if ((e.deletedDaysAgo ?? 0) >= 30) return refuse(422, "invalid_transition");
        e.status = e.before ?? "approved";
        return ok({ outcome: "restored", entry: entryDto(e) });
      case "restore-previous":
        if (mock.previousError) return refuse(mock.previousError.status, mock.previousError.code);
        e.version += 1;
        return ok({ entry: entryDto(e), previous_id: uuid(900) });
      default: {
        const ev = (action: string, lbl: string, v: number, to: string, at: number, actor = "A member") => ({ at: new Date(at).toISOString(), action, label: lbl, entry_id: e.id, version: v, from_status: null, to_status: to, actor_kind: "person", actor_user_id: null, actor_label: actor });
        const events = [ev("memory.proposed", "Proposed", 1, "proposed", Date.now() - 40 * DAY, "The pipeline"), ev("memory.approved", "Approved", 1, "approved", Date.now() - 39 * DAY)];
        if (e.status === "deleted") events.push(ev("memory.deleted", "Deleted", e.version, "deleted", Date.now() - (e.deletedDaysAgo ?? 0) * DAY));
        return ok({ events, versions: mock.purged ? [] : [entryDto(e)] });
      }
    }
  });
  await page.route("**/api/v1/events", () => new Promise<void>(() => {}));
}

async function setup(page: Page, tweak?: (m: Mock) => void, clock = false) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => window.addEventListener("focus", (e) => e.stopImmediatePropagation(), true));
  const mock = initial();
  tweak?.(mock);
  await mockApi(page, mock);
  if (clock) await page.clock.install();
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  await page.goto("/");
  await waitForDesktop(page);
  await page.locator('.dock-icon[data-app-id="memory"]').click();
  await expect(page.locator(WIN)).toBeVisible();
  await expect(page.locator(WIN)).not.toHaveClass(/opening/);
  await expect(tid(page, "mem-group").first()).toBeVisible();
  return { mock, errors };
}
async function press(page: Page, locator: ReturnType<typeof tid>) {
  if (test.info().project.name === "phone") await locator.tap();
  else await locator.click();
}
/** A click on a control that says it is disabled (aria-disabled): Playwright will not click it unless forced, and nothing may happen. */
const pressDisabled = (locator: ReturnType<typeof tid>) => (test.info().project.name === "phone" ? locator.tap({ force: true }) : locator.click({ force: true }));
const row = (page: Page, n: number) => page.locator(`${WIN} [data-testid="mem-row"][data-id="${uuid(n)}"]`);
const act = (page: Page, n: number, key: string) => row(page, n).locator(`[data-testid="mem-act-${key}"]`);
const card = (page: Page, n: number) => page.locator(`${WIN} [data-card="${uuid(n)}"]`);
const toast = (page: Page) => tid(page, "mem-toast-text").last();
const statusOf = (page: Page, n: number) => row(page, n).getAttribute("data-status");
const showDeleted = async (page: Page) => {
  await tid(page, "mem-filter-status").selectOption("deleted");
  await expect(tid(page, "mem-deleted-note")).toBeVisible();
};

test.describe("D#601 MEM-4b3: undo, delete and restore, history, export", () => {
  test("Acceptance 2: approve shows an Undo toast; Undo puts the entry back to proposed and the card returns to the queue", async ({ page }) => {
    const { mock, errors } = await setup(page);
    await expect(tid(page, "mem-card")).toHaveCount(3);
    await press(page, card(page, 1).locator('[data-testid="mem-approve"]'));
    await expect(toast(page)).toHaveText("Approved 1 card.");
    await expect(tid(page, "mem-card")).toHaveCount(2);
    await expect(tid(page, "mem-undo")).toBeVisible();
    await press(page, tid(page, "mem-undo"));
    await expect(toast(page)).toHaveText("Put back in the review queue.");
    await expect(tid(page, "mem-card")).toHaveCount(3);
    await expect(card(page, 1)).toBeVisible();
    await expect(tid(page, "mem-undo")).toHaveCount(0);
    expect(mock.requests).toContain(`POST /api/v1/memory/revert {"ids":["${uuid(1)}"],"action":"undo_approve"}`);
    expect(mock.entries.find((e) => e.id === uuid(1))!.status).toBe("proposed");
    expect(errors).toEqual([]);
  });

  test("a batch approve has one Undo that carries every id", async ({ page }) => {
    const { mock } = await setup(page);
    await press(page, page.locator(`${WIN} [data-testid="mem-batch-approve"]`).first());
    await press(page, page.locator('[data-testid="mem-batch-confirm"]'));
    await expect(toast(page)).toHaveText("Approved 3 cards.");
    await expect(tid(page, "mem-undo")).toHaveCount(1);
    await expect(tid(page, "mem-card")).toHaveCount(0);
    await press(page, tid(page, "mem-undo"));
    await expect(tid(page, "mem-card")).toHaveCount(3);
    expect(mock.requests).toContain(`POST /api/v1/memory/revert {"ids":["${uuid(1)}","${uuid(2)}","${uuid(3)}"],"action":"undo_approve"}`);
  });

  test("after 30 seconds the Undo is gone from the page, so a late click is not possible", async ({ page }) => {
    const { mock } = await setup(page, undefined, true);
    await press(page, card(page, 1).locator('[data-testid="mem-approve"]'));
    await expect(tid(page, "mem-undo")).toBeVisible();
    await page.clock.fastForward(29_000);
    await expect(tid(page, "mem-undo")).toBeVisible();
    await page.clock.fastForward(2_000);
    await expect(tid(page, "mem-undo")).toHaveCount(0);
    await expect(tid(page, "mem-toast")).toHaveCount(0);
    expect(mock.requests.filter((r) => r.includes("/revert"))).toEqual([]);
  });

  test("a stale Undo (the route refuses it) shows the refusal's words and changes nothing", async ({ page }) => {
    const { mock } = await setup(page);
    await press(page, card(page, 1).locator('[data-testid="mem-approve"]'));
    await expect(tid(page, "mem-undo")).toBeVisible();
    mock.revertError = { status: 422, code: "invalid_transition" };
    await press(page, tid(page, "mem-undo"));
    await expect(toast(page)).toHaveText("That entry has already changed, so this can't be done now. The list was refreshed.");
    expect(mock.entries.find((e) => e.id === uuid(1))!.status).toBe("approved");
    expect(await page.locator(WIN).innerText()).not.toMatch(/server text that must never be shown|\bnull\b|\bundefined\b/);
  });

  test("Retire has an Undo; Reconsider, Renew and Restore move the entry and say where it went", async ({ page }) => {
    const { mock } = await setup(page);
    await press(page, act(page, 20, "retire"));
    await expect(toast(page)).toHaveText("Retired. It is no longer used in runs.");
    await expect.poll(() => statusOf(page, 20)).toBe("retired");
    await press(page, tid(page, "mem-undo"));
    await expect.poll(() => statusOf(page, 20)).toBe("approved");
    await press(page, act(page, 22, "reconsider"));
    await expect(toast(page)).toHaveText("Back in the review queue.");
    await expect(tid(page, "mem-card")).toHaveCount(4);
    await press(page, act(page, 23, "renew"));
    await expect(toast(page)).toHaveText("Renewed. It is waiting for review again for 14 days.");
    await press(page, act(page, 24, "restore_retired"));
    await expect.poll(() => statusOf(page, 24)).toBe("approved");
    expect(mock.requests.filter((r) => r.includes("/revert")).map((r) => /"action":"(\w+)"/.exec(r)![1])).toEqual(["retire", "restore_retired", "reconsider", "renew", "restore_retired"]);
  });

  test("Acceptance 3: Delete, then Restore from the Deleted view with the days left; the entry is back in the list", async ({ page }) => {
    const { mock } = await setup(page);
    await press(page, act(page, 20, "delete"));
    await expect(toast(page)).toHaveText("Deleted. You can restore it for 30 days.");
    await expect(row(page, 20)).toHaveCount(0);
    await showDeleted(page);
    await expect(act(page, 20, "restore")).toHaveText("Restore (30 days left)");
    await press(page, act(page, 20, "restore"));
    await expect(toast(page)).toHaveText("Restored.");
    await expect(row(page, 20)).toHaveCount(0);
    await tid(page, "mem-filter-status").selectOption("");
    await expect.poll(() => statusOf(page, 20)).toBe("approved");
    expect(mock.requests.filter((r) => r.endsWith("/delete") || r.endsWith("/restore"))).toEqual([`POST /api/v1/memory/${uuid(20)}/delete`, `POST /api/v1/memory/${uuid(20)}/restore`]);
  });

  test("the Undo on a delete restores the entry", async ({ page }) => {
    await setup(page);
    await press(page, act(page, 21, "delete"));
    await press(page, tid(page, "mem-undo"));
    await expect(toast(page)).toHaveText("Restored.");
    await expect.poll(() => statusOf(page, 21)).toBe("approved");
  });

  test("Acceptance 3: deleted 29 days ago can be restored (days left shown); deleted 31 days ago cannot, and says why", async ({ page }) => {
    const { mock } = await setup(page, (m) => (m.entries.find((e) => e.id === uuid(30))!.deletedDaysAgo = 29));
    await showDeleted(page);
    await expect(act(page, 30, "restore")).toHaveText("Restore (1 day left)");
    await expect(act(page, 30, "restore")).toHaveAttribute("aria-disabled", "false");
    await expect(act(page, 31, "restore")).toHaveAttribute("aria-disabled", "true");
    await expect(row(page, 31).locator('[data-testid="mem-reason"]')).toHaveText("Deleted more than 30 days ago, so it can't be restored.");
    await pressDisabled(act(page, 31, "restore"));
    expect(mock.requests.filter((r) => r.endsWith(`${uuid(31)}/restore`))).toEqual([]);
    await press(page, act(page, 30, "restore"));
    await expect(toast(page)).toHaveText("Restored.");
  });

  test("Restore previous version: disabled with its reason when there is no earlier version; a 409 says the entry changed since", async ({ page }) => {
    const { mock } = await setup(page);
    await expect(act(page, 20, "restore_previous")).toHaveAttribute("aria-disabled", "true");
    await expect(row(page, 20).locator('[data-testid="mem-reason"]')).toHaveText("This entry was never edited, so there is no earlier version.");
    await expect(act(page, 21, "restore_previous")).toHaveAttribute("aria-disabled", "false");
    mock.previousError = { status: 409, code: "conflict" };
    await press(page, act(page, 21, "restore_previous"));
    await expect(row(page, 21).locator('[data-testid="mem-row-error"]')).toHaveText("This entry was changed since you opened this page, so nothing was changed. The list was refreshed.");
    mock.previousError = null;
    await press(page, act(page, 21, "restore_previous"));
    await expect(toast(page)).toHaveText("The earlier version is the current one again.");
    await expect(row(page, 21).locator('[data-testid="mem-row-error"]')).toHaveCount(0);
  });

  test("a member cannot act on repo entries and sees why; an item entry is left to the route", async ({ page }) => {
    const { mock } = await setup(page, (m) => (m.admin = false));
    await expect(act(page, 20, "retire")).toHaveAttribute("aria-disabled", "true");
    await expect(row(page, 20).locator('[data-testid="mem-reason"]')).toContainText("Only an owner or admin can change repo, account and role memory.");
    await pressDisabled(act(page, 20, "retire"));
    expect(mock.requests.filter((r) => r.includes("/revert"))).toEqual([]);
    await expect(act(page, 26, "retire")).toHaveAttribute("aria-disabled", "false");
    await expect(row(page, 26).locator('[data-testid="mem-history-toggle"]')).toBeVisible();
  });

  test("History: fixed labels, who did it and the versions; after a purge the events stay and the missing text is explained", async ({ page }) => {
    const { mock } = await setup(page, (m) => (m.purged = true));
    await press(page, row(page, 21).locator('[data-testid="mem-history-toggle"]'));
    const events = row(page, 21).locator('[data-testid="mem-event"]');
    await expect(events).toHaveCount(2);
    await expect(events.first()).toContainText("Proposed (version 1) · The pipeline");
    await expect(events.nth(1)).toContainText("Approved (version 1) · A member");
    await expect(row(page, 21).locator('[data-testid="mem-no-versions"]')).toContainText("no longer stored");
    mock.purged = false;
    await press(page, row(page, 21).locator('[data-testid="mem-history-toggle"]'));
    await expect(tid(page, "mem-history")).toHaveCount(0);
    await press(page, row(page, 21).locator('[data-testid="mem-history-toggle"]'));
    await expect(row(page, 21).locator('[data-testid="mem-version"]')).toContainText("Deploys go through the merge wrapper");
    expect(await page.locator(WIN).innerText()).not.toMatch(/\bnull\b|\bundefined\b/);
  });

  test("Acceptance 4: Export makes AGENTS.md or CLAUDE.md for a repo, says how many were left out, and downloads or copies the text", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);
    const { mock } = await setup(page, (m) => (m.omitted = 2));
    await tid(page, "mem-export-format").selectOption("claude");
    await press(page, tid(page, "mem-export-go"));
    await expect(tid(page, "mem-export-count")).toHaveText("2 approved entries in CLAUDE.md.");
    await expect(tid(page, "mem-export-omitted")).toHaveText("2 entries were left out because they look like they hold a secret.");
    await expect(tid(page, "mem-export-text")).toHaveValue("# CLAUDE.md\n\n- Run pnpm test --run\n");
    expect(mock.requests).toContain(`GET /api/v1/memory/export?repo_id=${REPO_ID}&format=claude`);
    const [download] = await Promise.all([page.waitForEvent("download"), press(page, tid(page, "mem-export-download"))]);
    expect(download.suggestedFilename()).toBe("CLAUDE.md");
    await expect(tid(page, "mem-export-note")).toHaveText("Downloaded CLAUDE.md.");
    await press(page, tid(page, "mem-export-copy"));
    await expect(tid(page, "mem-export-note")).toHaveText(/^(Copied\.|Copying isn't allowed here\.)/);
    mock.omitted = 0;
    await tid(page, "mem-export-format").selectOption("agents");
    await press(page, tid(page, "mem-export-go"));
    await expect(tid(page, "mem-export-count")).toHaveText("2 approved entries in AGENTS.md.");
    await expect(tid(page, "mem-export-omitted")).toHaveCount(0);
  });

  test("a slow Undo keeps its toast past 30 seconds and shows its error words", async ({ page }) => {
    const { mock } = await setup(page, undefined, true);
    await press(page, card(page, 1).locator('[data-testid="mem-approve"]'));
    await expect(tid(page, "mem-undo")).toBeVisible();
    await page.clock.fastForward(20_000);
    mock.revertDelayMs = 3000;
    mock.revertError = { status: 422, code: "invalid_transition" };
    await press(page, tid(page, "mem-undo"));
    await page.clock.fastForward(15_000); // past the 30 seconds from the toast, while the answer is still on its way
    await expect(tid(page, "mem-undo")).toHaveCount(1);
    await expect(toast(page)).toHaveText("That entry has already changed, so this can't be done now. The list was refreshed.");
  });

  test("toasts whose Undo is still live are never pushed out: five approvals keep five Undo buttons", async ({ page }) => {
    await setup(page, (m) => {
      for (let i = 4; i <= 6; i++) m.entries.push({ id: uuid(i), scope: "repo", status: "proposed", title: "Extra " + i, version: 1 });
    });
    for (const n of [1, 2, 3, 4, 5]) await press(page, card(page, n).locator('[data-testid="mem-approve"]'));
    await expect(tid(page, "mem-undo")).toHaveCount(5);
    await expect(tid(page, "mem-toasts")).toHaveAttribute("aria-live", "polite");
  });

  test("the notices come before the list in the page order, so a keyboard user reaches Undo first", async ({ page }) => {
    await setup(page);
    const before = await page.locator(`${WIN} [data-testid="mem-toasts"]`).evaluate((el) => !!(el.compareDocumentPosition(document.querySelector('#windows-container .fulc-window[data-app-id="memory"] [data-testid="mem-list"]')!) & Node.DOCUMENT_POSITION_FOLLOWING));
    expect(before).toBe(true);
  });

  test("while access is being checked every action is off with a neutral sentence; if the check fails it says so", async ({ page }) => {
    await setup(page, (m) => (m.meDelayMs = 1500));
    await expect(act(page, 20, "retire")).toHaveAttribute("aria-disabled", "true");
    await expect(row(page, 20).locator('[data-testid="mem-reason"]')).toHaveText("Checking your access…");
    await expect(act(page, 20, "retire")).toHaveAttribute("aria-disabled", "false");
  });

  test("when the access check fails, actions stay off and the sentence says it could not be checked", async ({ page }) => {
    await setup(page, (m) => (m.meFails = true));
    await expect(row(page, 20).locator('[data-testid="mem-reason"]')).toHaveText("Your access couldn't be checked, so changes are turned off. Reload to try again.");
    await expect(act(page, 26, "retire")).toHaveAttribute("aria-disabled", "true");
  });

  test("sixty deleted entries all show their days left with no per-row history calls; restore then delete again reads 30 days left", async ({ page }) => {
    const { mock } = await setup(page, (m) => {
      for (let i = 0; i < 60; i++) m.entries.push({ id: uuid(100 + i), scope: "repo", status: "deleted", title: "Old " + i, version: 1, before: "approved", deletedDaysAgo: 10 });
    });
    await showDeleted(page);
    await expect(act(page, 159, "restore")).toHaveText("Restore (20 days left)");
    await expect(page.locator(`${WIN} [data-testid="mem-act-restore"]`)).toHaveCount(62);
    expect(mock.requests.filter((r) => r.includes("/history"))).toEqual([]);
    await press(page, act(page, 30, "restore"));
    await expect(toast(page)).toHaveText("Restored.");
    await tid(page, "mem-filter-status").selectOption("");
    await press(page, act(page, 30, "delete"));
    await showDeleted(page);
    await expect(act(page, 30, "restore")).toHaveText("Restore (30 days left)");
  });

  test("accessibility: the rows with actions, an open history and a toast have no serious violations", async ({ page }) => {
    await setup(page);
    await press(page, row(page, 21).locator('[data-testid="mem-history-toggle"]'));
    await press(page, act(page, 20, "delete"));
    await expect(tid(page, "mem-toast")).toBeVisible();
    const res = await new AxeBuilder({ page }).include(WIN).exclude(`${WIN} .window-titlebar`).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
    expect(res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
  });
});
