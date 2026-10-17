// apps/workspace/e2e/memory.spec.ts
//
// D#601 MEM-4a3: the Memory app (review queue and all memory), against a small stateful mock of the memory routes. The built cloud dist is served
// by fixture-server.mjs; the routes' answers are built from the same shapes the contract fixtures hold, and a decision changes the mock's state, so a
// reload shows the result. The document carries the production CSP and Trusted Types directives, so a sink in the app fails here for real.
// Every test runs under the desktop, phone and tablet projects. Each C2 acceptance item of MEM-4a3 has a test whose name carries "Acceptance N".

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page, type Route } from "@playwright/test";
import { waitForDesktop } from "./helpers/boot";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const V1 = join(SCRIPT_DIR, "..", "..", "..", "packages", "api", "fixtures", "v1");
const readFixture = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const REPOS = readFixture("listRepos", "200-page.json");
const RUN = { ...readFixture("getRun", "200-running.json") };

const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const WIN = `#windows-container .fulc-window[data-app-id="memory"]`;
const tid = (page: Page, id: string) => page.locator(`${WIN} [data-testid="${id}"]`);
const REPO_ID = REPOS.data[0].id as string;
const REPO_NAME = REPOS.data[0].full_name as string;
const ITEM_ID = "5a2d9e18-7c3b-4f61-8e04-b6d2c1a97f35";
const ITEM_LABEL = "#42 Add the thing";
const RUN_A = "8b2c5e74-1f3a-4d96-a0b7-6c4e2d1f9a38";
const RUN_B = "3e9d7a10-5b2c-4c48-8e61-0f7a9b3c2d54";

type Author = "import" | "agent" | "runner_agent";
interface Card {
  id: string;
  scope: "repo" | "item";
  author: Author;
  body: string;
  kind?: string;
  why?: string | null;
  opened?: boolean;
  runId?: string;
  version?: number;
}
interface Row {
  id: string;
  scope: "repo" | "account";
  title: string;
  status?: string;
  runs: string[];
}
interface Mock {
  requests: string[];
  cards: Card[];
  rows: Row[];
  listStatus: number;
  queueStatus: number;
  countsStatus: number;
  batchError: { status: number; code: string; message: string } | null;
  editError: { status: number; code: string } | null;
  delayMs: number;
  nextId: number;
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const iso = "2026-10-16T07:00:00.000Z";

function entryDto(c: Card, status = "proposed") {
  return {
    id: c.id,
    scope: c.scope,
    kind: c.kind ?? "fact",
    body: c.body,
    why: c.why ?? null,
    author_kind: c.author,
    status,
    version: c.version ?? 1,
    content_sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    created_at: iso,
    updated_at: iso,
    approved_at: status === "approved" ? iso : null,
    expires_at: status === "proposed" ? "2026-10-30T07:00:00.000Z" : null,
  };
}
const sourceOf = (c: Card) => (c.author === "import" ? "Imported from CLAUDE.md" : c.author === "runner_agent" ? "Proposed on a runner" : "Proposed by an agent");
const proposedBy = (c: Card) => (c.author === "agent" ? `Proposed by agent (run ${c.runId ?? "8b2c5e74"})` : c.author === "runner_agent" ? "Proposed by a runner agent" : "Imported from CLAUDE.md at abcdef0");
function cardDto(c: Card) {
  const gated = c.author !== "agent";
  return {
    entry: entryDto(c),
    title: c.body.slice(0, 60),
    kind_label: "Fact",
    source: sourceOf(c),
    proposed_by: proposedBy(c),
    evidence: c.author === "agent" ? "Seen in two runs of the same item" : "",
    age: "2 hours ago",
    open_state: !gated ? "not_required" : c.opened ? "opened" : "unopened",
    scope_label: c.scope === "repo" ? REPO_NAME : ITEM_LABEL,
  };
}
const repoCards = (m: Mock) => m.cards.filter((c) => c.scope === "repo");
const itemCards = (m: Mock) => m.cards.filter((c) => c.scope === "item");

const initial = (): Mock => ({
  requests: [],
  cards: [
    { id: uuid(1), scope: "repo", author: "import", body: "The build needs Node 24" },
    { id: uuid(2), scope: "repo", author: "import", body: "Run pnpm install before pnpm test" },
    { id: uuid(3), scope: "repo", author: "agent", body: "The retry test is flaky on the first run", why: "It warms a cache", runId: "run-77" },
    { id: uuid(4), scope: "repo", author: "agent", body: "Use the staging database for live checks" },
    { id: uuid(5), scope: "item", author: "agent", body: "The migration must run before the seed" },
  ],
  rows: [
    { id: uuid(20), scope: "repo", title: "pnpm test --run", runs: [RUN_A, RUN_B] },
    { id: uuid(21), scope: "repo", title: "Deploys go through the merge wrapper", runs: [RUN_A] },
    { id: uuid(22), scope: "account", title: "Keep answers short", runs: [] },
  ],
  listStatus: 200,
  queueStatus: 200,
  countsStatus: 200,
  batchError: null,
  editError: null,
  delayMs: 0,
  nextId: 100,
});

async function mockApi(page: Page, mock: Mock) {
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  const err = (code: string, message = "server text that must never be shown") => ({ error: { code, message, request_id: "req_1" } });
  const rowDto = (r: Row) => ({
    id: r.id,
    scope: r.scope,
    kind: "command",
    kind_label: "Command",
    status: r.status ?? "approved",
    status_label: "Approved",
    status_icon: "check",
    title: r.title,
    author_kind: "person",
    source: "Written by a person",
    version: 1,
    created_at: iso,
    age: "2 days ago",
    runs: r.runs.length,
    runs_label: r.runs.length === 0 ? "Not used yet" : `Used in ${r.runs.length} runs`,
  });
  await page.route((u) => u.pathname.startsWith("/api/v1/repos"), (route) => json(route, 200, REPOS));
  await page.route((u) => u.pathname.startsWith("/api/v1/memory"), async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const body = req.postData() ? JSON.parse(req.postData()!) : undefined;
    mock.requests.push(`${req.method()} ${url.pathname}${url.search}${body === undefined ? "" : " " + JSON.stringify(body)}`);
    if (mock.delayMs) await new Promise((r) => setTimeout(r, mock.delayMs));
    const path = url.pathname.replace("/api/v1/memory", "");
    const respond = (status: number, b: unknown) => json(route, status, b).catch(() => undefined);
    if (path === "" && req.method() === "GET") {
      if (mock.listStatus !== 200) return respond(mock.listStatus, err("internal_error"));
      const groups: unknown[] = [];
      const repoRows = mock.rows.filter((r) => r.scope === "repo").map(rowDto);
      const proposedRepo = repoCards(mock).map((c) => ({ ...rowDto({ id: c.id, scope: "repo", title: c.body, runs: [] }), status: "proposed", status_label: "Proposed", status_icon: "inbox" }));
      if (repoRows.length + proposedRepo.length > 0) groups.push({ scope: "repo", label: REPO_NAME, target_id: REPO_ID, entries: [...repoRows, ...proposedRepo] });
      if (itemCards(mock).length > 0) groups.push({ scope: "item", label: ITEM_LABEL, target_id: ITEM_ID, entries: itemCards(mock).map((c) => ({ ...rowDto({ id: c.id, scope: "repo", title: c.body, runs: [] }), scope: "item", status: "proposed", status_label: "Proposed", status_icon: "inbox" })) });
      const acct = mock.rows.filter((r) => r.scope === "account").map(rowDto);
      groups.push({ scope: "account", label: "Account", target_id: null, entries: acct });
      return respond(200, { groups, truncated: false });
    }
    if (path === "/queue") {
      if (mock.queueStatus !== 200) return respond(mock.queueStatus, err("internal_error"));
      return respond(200, { cards: mock.cards.map(cardDto), truncated: false });
    }
    if (path === "/pending-counts") {
      if (mock.countsStatus !== 200) return respond(mock.countsStatus, err("internal_error"));
      return respond(200, { repos: { [REPO_ID]: repoCards(mock).length }, items: { [ITEM_ID]: itemCards(mock).length } });
    }
    const m = /^\/([0-9a-f-]{36})\/(open|decide|edit|runs)$/.exec(path);
    if (path === "/decide-batch") {
      if (mock.batchError) return respond(mock.batchError.status, err(mock.batchError.code, mock.batchError.message));
      mock.cards = mock.cards.filter((c) => !body.ids.includes(c.id));
      return respond(200, { decided: body.ids.length, entries: [] });
    }
    if (m) {
      const [, id, action] = m;
      const card = mock.cards.find((c) => c.id === id);
      if (action === "runs") {
        const row = mock.rows.find((r) => r.id === id);
        const runs = (row?.runs ?? []).map((r) => ({ id: r, recorded_at: iso }));
        return respond(200, { total: runs.length, truncated: false, runs });
      }
      if (!card) return respond(404, err("not_found"));
      if (action === "open") {
        card.opened = true;
        return respond(200, { opened: card.author !== "agent" });
      }
      if (action === "decide") {
        mock.cards = mock.cards.filter((c) => c.id !== id);
        return respond(200, { outcome: "decided", entry: entryDto(card, body.to) });
      }
      if (mock.editError) return respond(mock.editError.status, err(mock.editError.code));
      const next: Card = { ...card, id: uuid(mock.nextId++), body: body.body, why: body.why, version: (card.version ?? 1) + 1, opened: false };
      mock.cards = mock.cards.map((c) => (c.id === id ? next : c));
      return respond(200, { entry: entryDto(next), previous_id: id });
    }
    return respond(404, err("not_found"));
  });
  await page.route("**/api/v1/events", () => new Promise<void>(() => {}));
  await page.route((u) => u.pathname.startsWith("/api/v1/runs"), async (route) => {
    if ((route.request().headers()["accept"] ?? "").includes("text/event-stream")) return route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: idle\ndata: {}\n\n" });
    const url = new URL(route.request().url());
    mock.requests.push(`GET ${url.pathname}`);
    if (url.pathname === "/api/v1/runs") return json(route, 200, { data: [], next_cursor: null });
    if (url.pathname.endsWith("/events")) return json(route, 200, { data: [], next_cursor: "0" });
    return json(route, 200, { ...RUN, id: url.pathname.split("/").pop() });
  });
}

async function boot(page: Page) {
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  await page.goto("/");
  await waitForDesktop(page);
}
async function openMemory(page: Page) {
  await page.locator('.dock-icon[data-app-id="memory"]').click();
  await expect(page.locator(WIN)).toBeVisible();
  await expect(page.locator(WIN)).not.toHaveClass(/opening/);
}
async function setup(page: Page, tweak?: (m: Mock) => void) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    window.addEventListener("focus", (e) => e.stopImmediatePropagation(), true);
    (window as unknown as { __tt: string[] }).__tt = [];
    document.addEventListener("securitypolicyviolation", (e) => (window as unknown as { __tt: string[] }).__tt.push(e.violatedDirective));
  });
  const mock = initial();
  tweak?.(mock);
  await mockApi(page, mock);
  await boot(page);
  await openMemory(page);
  return { mock, errors, tt: () => page.evaluate(() => (window as unknown as { __tt: string[] }).__tt) };
}
async function press(page: Page, locator: ReturnType<typeof tid>) {
  if (test.info().project.name === "phone") await locator.tap();
  else await locator.click();
}
/** The batch dialog is a modal <dialog> on the document body, outside the window. */
const gid = (page: Page, id: string) => page.locator(`[data-testid="${id}"]`);
const cardOf = (page: Page, id: string) => page.locator(`${WIN} [data-card="${id}"]`);
const scopeOf = (page: Page, label: string) => page.locator(`${WIN} [data-testid="mem-queue-scope"][aria-label="${label}"]`);

test.describe("D#601 MEM-4a3: Memory app (mocked routes)", () => {
  test("states: loading, then the queue, the lists and the badges; no null or undefined text anywhere", async ({ page }) => {
    const { mock, errors, tt } = await setup(page, (m) => (m.delayMs = 400));
    await expect(tid(page, "mem-status")).toHaveText("Loading memory…");
    await expect(tid(page, "mem-card")).toHaveCount(5);
    await expect(tid(page, "mem-status")).toBeHidden();
    expect(mock.requests.some((r) => r.startsWith("GET /api/v1/memory/queue"))).toBe(true);
    const text = await page.locator(WIN).innerText();
    expect(text).not.toMatch(/\bnull\b|\bundefined\b|NaN/);
    expect(errors).toEqual([]);
    expect(await tt()).toEqual([]);
  });

  test("states: nothing yet is words, not a blank; an empty queue says so", async ({ page }) => {
    await setup(page, (m) => {
      m.cards = [];
      m.rows = [];
    });
    await expect(tid(page, "mem-queue-state")).toHaveText("Nothing is waiting for review.");
    await expect(tid(page, "mem-group-empty").first()).toHaveText("No memory here yet.");
    expect(await page.locator(WIN).innerText()).not.toMatch(/\bnull\b|\bundefined\b/);
  });

  test("states: an unavailable list and queue say so and Try again recovers", async ({ page }) => {
    const { mock } = await setup(page, (m) => {
      m.listStatus = 500;
      m.queueStatus = 500;
    });
    await expect(tid(page, "mem-status")).toHaveText("Memory isn't available right now.");
    await expect(tid(page, "mem-queue-state")).toHaveText("Memory isn't available right now.");
    mock.listStatus = 200;
    mock.queueStatus = 200;
    await press(page, tid(page, "mem-retry"));
    await expect(tid(page, "mem-card")).toHaveCount(5);
    expect(await page.locator(WIN).innerText()).not.toContain("Memory isn't available");
  });

  test("states: a counts failure says the count is unavailable, never a number made up", async ({ page }) => {
    await setup(page, (m) => (m.countsStatus = 500));
    await expect(scopeOf(page, REPO_NAME).locator('[data-testid="mem-badge"]')).toHaveText("Count unavailable");
  });

  test("Acceptance 5: the badge on the repo header and on the item equals the pending count from the route, before and after a decision and a reload", async ({ page }) => {
    const { mock } = await setup(page);
    const countsNow = () => ({ repo: repoCards(mock).length, item: itemCards(mock).length });
    const badges = async () => ({
      queueRepo: await scopeOf(page, REPO_NAME).locator('[data-testid="mem-badge"]').getAttribute("data-count"),
      queueItem: await scopeOf(page, ITEM_LABEL).locator('[data-testid="mem-badge"]').getAttribute("data-count"),
      listRepo: await page.locator(`${WIN} [data-testid="mem-group"][data-scope="repo"] [data-testid="mem-badge"]`).first().getAttribute("data-count"),
      listItem: await page.locator(`${WIN} [data-testid="mem-group"][data-scope="item"] [data-testid="mem-badge"]`).first().getAttribute("data-count"),
    });
    await expect(tid(page, "mem-card")).toHaveCount(5);
    let c = countsNow();
    expect(c).toEqual({ repo: 4, item: 1 });
    expect(await badges()).toEqual({ queueRepo: "4", queueItem: "1", listRepo: "4", listItem: "1" });
    await scopeOf(page, REPO_NAME).locator('[data-testid="mem-approve"]').first().click();
    await expect(tid(page, "mem-card")).toHaveCount(4);
    c = countsNow();
    expect(await badges()).toEqual({ queueRepo: String(c.repo), queueItem: String(c.item), listRepo: String(c.repo), listItem: String(c.item) });
    expect(c.repo).toBe(3);
    // after a reload of the whole page the badges are the route's number again
    await page.reload();
    await waitForDesktop(page);
    await openMemory(page);
    await expect(tid(page, "mem-card")).toHaveCount(4);
    expect(await badges()).toEqual({ queueRepo: "3", queueItem: "1", listRepo: "3", listItem: "1" });
    const counts = mock.requests.filter((r) => r.startsWith("GET /api/v1/memory/pending-counts"));
    expect(counts.length).toBeGreaterThan(0);
    expect(counts.at(-1)).toContain(`repo_ids=${REPO_ID}`);
  });

  test("Approve, Reject: one call each, the card leaves the queue, focus moves to the next card, and a reload keeps the result", async ({ page }) => {
    const { mock } = await setup(page);
    await expect(tid(page, "mem-card")).toHaveCount(5);
    const first = cardOf(page, uuid(3));
    await press(page, first.locator('[data-testid="mem-approve"]'));
    await expect(cardOf(page, uuid(3))).toHaveCount(0);
    expect(mock.requests).toContain(`POST /api/v1/memory/${uuid(3)}/decide {"to":"approved"}`);
    await expect(cardOf(page, uuid(4))).toBeFocused();
    await press(page, cardOf(page, uuid(4)).locator('[data-testid="mem-reject"]'));
    await expect(cardOf(page, uuid(4))).toHaveCount(0);
    expect(mock.requests).toContain(`POST /api/v1/memory/${uuid(4)}/decide {"to":"rejected"}`);
    await page.reload();
    await waitForDesktop(page);
    await openMemory(page);
    await expect(tid(page, "mem-card")).toHaveCount(3);
    await expect(cardOf(page, uuid(3))).toHaveCount(0);
  });

  test("Acceptance 1: A, E and R act on the focused card and focus moves to the next; the dialog returns focus", async ({ page }) => {
    test.skip(test.info().project.name === "phone", "keyboard shortcuts need a hardware keyboard");
    const { mock } = await setup(page);
    await expect(tid(page, "mem-card")).toHaveCount(5);
    await cardOf(page, uuid(3)).focus();
    await page.keyboard.press("a");
    await expect(cardOf(page, uuid(3))).toHaveCount(0);
    expect(mock.requests).toContain(`POST /api/v1/memory/${uuid(3)}/decide {"to":"approved"}`);
    await expect(cardOf(page, uuid(4))).toBeFocused();
    await page.keyboard.press("r");
    await expect(cardOf(page, uuid(4))).toHaveCount(0);
    expect(mock.requests).toContain(`POST /api/v1/memory/${uuid(4)}/decide {"to":"rejected"}`);
    await expect(cardOf(page, uuid(5))).toBeFocused();
    await page.keyboard.press("e");
    await expect(tid(page, "mem-editor")).toBeVisible();
    await expect(tid(page, "mem-edit-body")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(tid(page, "mem-editor")).toHaveCount(0);
    await expect(cardOf(page, uuid(5))).toBeFocused();
    // typing in the editor does not trigger a shortcut
    await page.keyboard.press("e");
    await page.keyboard.type("arar");
    await expect(tid(page, "mem-edit-body")).toHaveValue(/^arar/);
    expect(mock.requests.filter((r) => r.includes("/decide"))).toHaveLength(2);
    await page.keyboard.press("Escape");

    // the batch dialog returns focus to the button that opened it
    await cardOf(page, uuid(1)).focus();
    await page.keyboard.press("a"); // the first key on a card nobody opened opens it
    await expect(cardOf(page, uuid(1))).toHaveAttribute("data-open-state", "opened");
    await cardOf(page, uuid(2)).focus();
    await page.keyboard.press("a");
    await expect(cardOf(page, uuid(2))).toHaveAttribute("data-open-state", "opened");
    const approveAll = tid(page, "mem-batch-approve").first();
    await expect(approveAll).toHaveText("Approve all 2");
    await approveAll.focus();
    await page.keyboard.press("Enter");
    await expect(gid(page, "mem-batch-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(gid(page, "mem-batch-dialog")).toHaveCount(0);
    await expect(approveAll).toBeFocused();
  });

  test("Edit then approve: the edit is saved as a new version, then that new version is approved; Escape and Cancel leave nothing behind", async ({ page }) => {
    const { mock } = await setup(page);
    const card = cardOf(page, uuid(4));
    await press(page, card.locator('[data-testid="mem-edit"]'));
    await expect(tid(page, "mem-edit-body")).toHaveValue("Use the staging database for live checks");
    await press(page, tid(page, "mem-edit-cancel"));
    await expect(tid(page, "mem-editor")).toHaveCount(0);
    expect(mock.requests.filter((r) => r.includes("/edit"))).toEqual([]);
    await press(page, card.locator('[data-testid="mem-edit"]'));
    await tid(page, "mem-edit-body").fill("Use the staging database for live checks, never production");
    await tid(page, "mem-edit-why").fill("Production is read only");
    await press(page, tid(page, "mem-edit-approve"));
    await expect(cardOf(page, uuid(4))).toHaveCount(0);
    const edit = mock.requests.findIndex((r) => r.startsWith(`POST /api/v1/memory/${uuid(4)}/edit `));
    expect(edit).toBeGreaterThan(-1);
    expect(mock.requests[edit]).toContain('"body":"Use the staging database for live checks, never production"');
    expect(mock.requests[edit]).toContain('"why":"Production is read only"');
    // the approve is on the id the edit answered with, and comes after it
    expect(mock.requests[edit + 1]).toBe(`POST /api/v1/memory/${uuid(100)}/decide {"to":"approved"}`);
  });

  test("Acceptance 4: editing an agent proposal still shows 'Proposed by agent (run <id>)'", async ({ page }) => {
    await setup(page);
    const card = cardOf(page, uuid(3));
    await expect(card.locator('[data-testid="mem-card-proposed-by"]')).toHaveText("Proposed by agent (run run-77)");
    await press(page, card.locator('[data-testid="mem-edit"]'));
    await tid(page, "mem-edit-body").fill("The retry test is flaky on the first run of the day");
    await press(page, tid(page, "mem-edit-save"));
    const edited = cardOf(page, uuid(100));
    await expect(edited).toBeVisible();
    await expect(edited.locator('[data-testid="mem-card-body"]')).toHaveText("The retry test is flaky on the first run of the day");
    await expect(edited.locator('[data-testid="mem-card-proposed-by"]')).toHaveText("Proposed by agent (run run-77)");
  });

  test("Edit: a text over the limit is refused on the screen before any call, and a secret the server refuses is a visible sentence", async ({ page }) => {
    const { mock } = await setup(page);
    await press(page, cardOf(page, uuid(3)).locator('[data-testid="mem-edit"]'));
    await tid(page, "mem-edit-body").fill("x".repeat(1025));
    await press(page, tid(page, "mem-edit-save"));
    await expect(tid(page, "mem-edit-error")).toContainText("at most 1024 bytes");
    expect(mock.requests.filter((r) => r.includes("/edit"))).toEqual([]);
    mock.editError = { status: 422, code: "secret_detected" };
    await tid(page, "mem-edit-body").fill("a perfectly fine memory");
    await press(page, tid(page, "mem-edit-save"));
    await expect(cardOf(page, uuid(3)).locator('[data-testid="mem-card-error"]')).toContainText("looks like it holds a credential");
    await expect(cardOf(page, uuid(3))).toHaveCount(1); // nothing changed
  });

  test("Acceptance 2: the batch button for imported cards is disabled with 'Open each card first (2 left)' and enabled when none is left; forced, the server's must_open_first is shown", async ({ page }) => {
    const { mock } = await setup(page);
    const bar = (source: string) => page.locator(`${WIN} [data-testid="mem-batch"][data-source="${source}"]`);
    const approve = bar("Imported from CLAUDE.md").locator('[data-testid="mem-batch-approve"]');
    await expect(approve).toHaveText("Open each card first (2 left)");
    await expect(approve).toBeDisabled();
    // a card nobody opened shows its title only, with its state as text
    await expect(cardOf(page, uuid(1)).locator('[data-testid="mem-open-state"]')).toHaveText(/Not opened yet/);
    await expect(cardOf(page, uuid(1)).locator('[data-testid="mem-card-body"]')).toHaveCount(0);
    await press(page, cardOf(page, uuid(1)).locator('[data-testid="mem-open"]'));
    await expect(approve).toHaveText("Open each card first (1 left)");
    await expect(cardOf(page, uuid(1)).locator('[data-testid="mem-open-state"]')).toHaveText(/Opened/);
    await expect(cardOf(page, uuid(1)).locator('[data-testid="mem-card-body"]')).toHaveText("The build needs Node 24");
    expect(mock.requests).toContain(`POST /api/v1/memory/${uuid(1)}/open`);
    await press(page, cardOf(page, uuid(2)).locator('[data-testid="mem-open"]'));
    await expect(approve).toHaveText("Approve all 2");
    await expect(approve).toBeEnabled();

    // a stale screen: the server still says an imported card was not opened. The screen shows the server's sentence and changes nothing.
    mock.batchError = { status: 422, code: "must_open_first", message: "2 of these cards have not been opened yet; open each one first" };
    await press(page, approve);
    await expect(gid(page, "mem-batch-dialog")).toBeVisible();
    await expect(gid(page, "mem-batch-dialog")).toContainText("Approve 2 cards from Imported from CLAUDE.md?");
    await press(page, gid(page, "mem-batch-confirm"));
    await expect(gid(page, "mem-batch-error")).toHaveText("2 of these cards have not been opened yet; open each one first");
    await expect(tid(page, "mem-card")).toHaveCount(5);
    mock.batchError = null;
    await press(page, gid(page, "mem-batch-confirm"));
    await expect(gid(page, "mem-batch-dialog")).toHaveCount(0);
    await expect(cardOf(page, uuid(1))).toHaveCount(0);
    expect(mock.requests).toContain(`POST /api/v1/memory/decide-batch {"ids":["${uuid(1)}","${uuid(2)}"],"to":"approved"}`);
  });

  test("a batch is one source: the agent cards have their own batch, which needs no open record, and the dialog names the count and the source", async ({ page }) => {
    const { mock } = await setup(page);
    const agentBar = page.locator(`${WIN} [data-testid="mem-batch"][data-source="Proposed by an agent"]`);
    await expect(agentBar).toContainText("2 cards");
    await expect(agentBar.locator('[data-testid="mem-batch-reject"]')).toHaveText("Reject all 2");
    await press(page, agentBar.locator('[data-testid="mem-batch-reject"]'));
    await expect(gid(page, "mem-batch-dialog")).toContainText("Reject 2 cards from Proposed by an agent?");
    await press(page, gid(page, "mem-batch-cancel"));
    await expect(gid(page, "mem-batch-dialog")).toHaveCount(0);
    await expect(agentBar.locator('[data-testid="mem-batch-reject"]')).toBeFocused();
    expect(mock.requests.filter((r) => r.includes("decide-batch"))).toEqual([]);
    await press(page, agentBar.locator('[data-testid="mem-batch-reject"]'));
    await press(page, gid(page, "mem-batch-confirm"));
    await expect(cardOf(page, uuid(3))).toHaveCount(0);
    expect(mock.requests).toContain(`POST /api/v1/memory/decide-batch {"ids":["${uuid(3)}","${uuid(4)}"],"to":"rejected"}`);
  });

  test("a refusal of a single decision is a sentence on the card, and the card stays", async ({ page }) => {
    const { mock } = await setup(page);
    await page.route((u) => u.pathname === `/api/v1/memory/${uuid(3)}/decide`, (route) => route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "forbidden", message: "server text that must never be shown", request_id: "r" } }) }));
    await press(page, cardOf(page, uuid(3)).locator('[data-testid="mem-approve"]'));
    await expect(cardOf(page, uuid(3)).locator('[data-testid="mem-card-error"]')).toHaveText("Only an owner or admin can do that for this memory.");
    await expect(cardOf(page, uuid(3))).toHaveCount(1);
    expect(mock.cards.some((c) => c.id === uuid(3))).toBe(true);
  });

  test("Acceptance 3: status is text plus an icon on every row, and axe finds no serious or critical violation", async ({ page }) => {
    await setup(page);
    const statuses = tid(page, "mem-row-status");
    await expect(statuses.first()).toBeVisible();
    for (const s of await statuses.all()) {
      const t = (await s.innerText()).trim();
      expect(t).toMatch(/^[▤✓✗◷‖⌫▣↻?]\s*\S+/u);
      await expect(s.locator('[aria-hidden="true"]')).toHaveCount(1);
    }
    const res = await new AxeBuilder({ page }).include(WIN).exclude(`${WIN} .window-titlebar`).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
    expect(res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
    // the open dialog and an open editor too
    await press(page, cardOf(page, uuid(3)).locator('[data-testid="mem-edit"]'));
    const editing = await new AxeBuilder({ page }).include(WIN).exclude(`${WIN} .window-titlebar`).analyze();
    expect(editing.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(tid(page, "mem-editor")).toHaveCount(0);
    // the open batch dialog, which sits on the document body outside the window
    const agentBar = page.locator(`${WIN} [data-testid="mem-batch"][data-source="Proposed by an agent"]`);
    await press(page, agentBar.locator('[data-testid="mem-batch-reject"]'));
    await expect(gid(page, "mem-batch-dialog")).toBeVisible();
    const dialogRes = await new AxeBuilder({ page }).include('[data-testid="mem-batch-dialog"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
    expect(dialogRes.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
    await press(page, gid(page, "mem-batch-cancel"));
    await expect(gid(page, "mem-batch-dialog")).toHaveCount(0);
  });

  test("a memory body that holds markup is shown as text: no element is created from it and nothing runs", async ({ page }) => {
    const payload = "<img src=x onerror=alert(1)>";
    let alerted = false;
    page.on("dialog", (d) => {
      alerted = true;
      void d.dismiss();
    });
    const { errors } = await setup(page, (m) => {
      m.cards.push({ id: uuid(6), scope: "repo", author: "agent", body: payload });
    });
    const body = cardOf(page, uuid(6)).locator('[data-testid="mem-card-body"]');
    await expect(body).toHaveText(payload);
    await expect(page.locator(`${WIN} img`)).toHaveCount(0);
    await expect(body.locator("*")).toHaveCount(0);
    // an edit opens the same words in a field, still not markup
    await press(page, cardOf(page, uuid(6)).locator('[data-testid="mem-edit"]'));
    await expect(tid(page, "mem-edit-body")).toHaveValue(payload);
    await expect(page.locator(`${WIN} img`)).toHaveCount(0);
    await page.waitForTimeout(300); // an onerror handler would fire on the next task, so give it that
    expect(alerted).toBe(false);
    expect(errors).toEqual([]);
  });

  test("Acceptance 6: 'Used in N runs' shows 0 when none, goes straight to a single run's page, and lists several", async ({ page }) => {
    const { mock } = await setup(page);
    const runsOf = (rowId: string) => page.locator(`${WIN} [data-testid="mem-row"][data-id="${rowId}"] [data-testid="mem-runs"]`);
    await expect(runsOf(uuid(22))).toHaveText("Used in 0 runs");
    await expect(runsOf(uuid(22))).toHaveAttribute("data-runs", "0");
    expect(await runsOf(uuid(22)).evaluate((e) => e.tagName)).not.toBe("BUTTON");
    // several: a short list of specific runs, each a link to its run page
    await press(page, runsOf(uuid(20)));
    await expect(tid(page, "mem-run-link")).toHaveCount(2);
    await expect(tid(page, "mem-run-link").first()).toHaveAttribute("data-run-id", RUN_A);
    await expect(tid(page, "mem-run-link").first()).toContainText("Run 8b2c5e74");
    expect(mock.requests.some((r) => r.startsWith(`GET /api/v1/memory/${uuid(20)}/runs`))).toBe(true);
    await press(page, tid(page, "mem-run-link").nth(1));
    await expect(page.locator(`#windows-container .fulc-window[data-app-id="runs"]`)).toBeVisible();
    await expect.poll(() => mock.requests.some((r) => r === `GET /api/v1/runs/${RUN_B}`)).toBe(true);
    // one run: no list, the run page opens at once
    mock.requests.length = 0;
    await page.evaluate(() => (window as unknown as { FULCWM: { close: (id: string) => void } }).FULCWM.close("runs"));
    await expect(page.locator(`#windows-container .fulc-window[data-app-id="runs"]`)).toHaveCount(0);
    // On a phone only one window is up at a time: bring Memory back if closing Runs did not.
    if (!(await page.locator(WIN).isVisible())) await page.locator('.dock-icon[data-app-id="memory"]').click();
    await expect(page.locator(WIN)).toBeVisible();
    await press(page, runsOf(uuid(21)));
    await expect.poll(() => mock.requests.some((r) => r === `GET /api/v1/runs/${RUN_A}`)).toBe(true);
  });

  test("the list filters by kind and status with the route's own query", async ({ page }) => {
    const { mock } = await setup(page);
    await tid(page, "mem-filter-kind").selectOption("command");
    await expect.poll(() => mock.requests.some((r) => r === "GET /api/v1/memory?kind=command")).toBe(true);
    await tid(page, "mem-filter-status").selectOption("approved");
    await expect.poll(() => mock.requests.some((r) => r === "GET /api/v1/memory?kind=command&status=approved")).toBe(true);
  });
});
