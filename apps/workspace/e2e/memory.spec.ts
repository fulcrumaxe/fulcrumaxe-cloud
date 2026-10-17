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
const groupBadge = (page: Page, scope: "repo" | "item") => page.locator(`${WIN} [data-testid="mem-group"][data-scope="${scope}"] [data-testid="mem-badge"]`).first();

test.describe("D#601 MEM-4a3: Memory app, all memory (mocked routes)", () => {
  test("states: loading, then the groups, the rows and the badges; no null or undefined text anywhere", async ({ page }) => {
    const { errors, tt } = await setup(page, (m) => (m.delayMs = 400));
    await expect(tid(page, "mem-status")).toHaveText("Loading memory…");
    await expect(tid(page, "mem-row")).toHaveCount(8);
    await expect(tid(page, "mem-status")).toBeHidden();
    const text = await page.locator(WIN).innerText();
    expect(text).not.toMatch(/\bnull\b|\bundefined\b|NaN/);
    expect(errors).toEqual([]);
    expect(await tt()).toEqual([]);
  });

  test("states: nothing yet is words, not a blank", async ({ page }) => {
    await setup(page, (m) => {
      m.cards = [];
      m.rows = [];
    });
    await expect(tid(page, "mem-group-empty").first()).toHaveText("No memory here yet.");
    expect(await page.locator(WIN).innerText()).not.toMatch(/\bnull\b|\bundefined\b/);
  });

  test("states: an unavailable list says so and Try again recovers", async ({ page }) => {
    const { mock } = await setup(page, (m) => (m.listStatus = 500));
    await expect(tid(page, "mem-status")).toHaveText("Memory isn't available right now.");
    mock.listStatus = 200;
    await press(page, tid(page, "mem-retry"));
    await expect(tid(page, "mem-row")).toHaveCount(8);
    expect(await page.locator(WIN).innerText()).not.toContain("Memory isn't available");
  });

  test("states: a counts failure says the count is unavailable, never a number made up", async ({ page }) => {
    await setup(page, (m) => (m.countsStatus = 500));
    await expect(groupBadge(page, "repo")).toHaveText("Count unavailable");
  });

  test("Acceptance 5 (headers): the badge on the repo header and on the item equals the pending count from the route, and follows it after a decision and a reload", async ({ page }) => {
    const { mock } = await setup(page);
    const badges = async () => ({ repo: await groupBadge(page, "repo").getAttribute("data-count"), item: await groupBadge(page, "item").getAttribute("data-count") });
    await expect(tid(page, "mem-row")).toHaveCount(8);
    expect({ repo: repoCards(mock).length, item: itemCards(mock).length }).toEqual({ repo: 4, item: 1 });
    expect(await badges()).toEqual({ repo: "4", item: "1" });
    await expect(groupBadge(page, "repo")).toHaveText("4 waiting");
    // a decision is made elsewhere (the review queue): after a reload the badge is the route's new number
    mock.cards = mock.cards.filter((c) => c.id !== uuid(3));
    await page.reload();
    await waitForDesktop(page);
    await openMemory(page);
    await expect(tid(page, "mem-row")).toHaveCount(7);
    expect(await badges()).toEqual({ repo: "3", item: "1" });
    const counts = mock.requests.filter((r) => r.startsWith("GET /api/v1/memory/pending-counts"));
    expect(counts.length).toBeGreaterThan(1);
    expect(counts.at(-1)).toContain(`repo_ids=${REPO_ID}`);
    expect(counts.at(-1)).toContain(`item_ids=${ITEM_ID}`);
  });

  test("Acceptance 3 (rows): status is text plus an icon on every row, and axe finds no serious or critical violation", async ({ page }) => {
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
