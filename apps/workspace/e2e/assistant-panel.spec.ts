// apps/workspace/e2e/assistant-panel.spec.ts
//
// D#597 CC-6a-2: the assistant panel in the Pipeline item detail and in the Runs detail, on mocked replies. The built cloud dist is
// served by fixture-server.mjs; every /api/v1 call is answered by page.route() from the repo's contract fixtures
// (packages/api/fixtures/v1/**). The messages route answers as an event stream built from the SAME fixtures the JSON form is checked against
// (the route's own turn: `conversation`, `text`, `done`), framed exactly as packages/api/src/sse/views.ts frame() writes them. page.route()
// cannot send a body in pieces; the split-mid-event and dropped-connection cases are in test/assistant-panel.test.mjs. The document
// carries the production CSP and Trusted Types directives. Every test runs on desktop, phone and tablet; each one prints the panel's size
// and its count of focusable controls (MEASURE lines) so the PR can quote numbers.
//
// One test per state: empty, off, no key, working (with Stop), a stopped stream, cap reached, unpriced, unavailable, a failed turn and its
// retry, no run data; and the draft cards: accept, reject, undo, a plain member, Ask why, two tabs, after a reload.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const V1 = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "api", "fixtures", "v1");
const fx = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const LIST = fx("listWorkItems", "200-page.json");
const REPOS = fx("listRepos", "200-page.json");
const TIMELINE = fx("getWorkItemTimeline", "200-ok.json");
const WORK_RUNS = fx("listRuns", "200-work-item.json");
const ROLES = fx("listRoles", "200-ok.json");
const RUN_LIST = fx("listRuns", "200-page.json");
const RUN = fx("getRun", "200-running.json");
const EVENTS = fx("listRunEvents", "200-page.json").data as Ev[];
const DRAFTS = fx("listCorrections", "200-drafts.json").data as Corr[];
const SENT = {
  ok: fx("sendAssistantMessage", "200-ok.json"),
  no_key: fx("sendAssistantMessage", "200-no_key.json"),
  unconfigured: fx("sendAssistantMessage", "200-unconfigured.json"),
  budget_reached: fx("sendAssistantMessage", "200-budget_reached.json"),
  unpriced: fx("sendAssistantMessage", "200-unpriced.json"),
  unavailable: fx("sendAssistantMessage", "200-unavailable.json"),
} as Record<string, Sent>;
const ALREADY = fx("acceptCorrection", "409-already_decided.json");

const ITEM = LIST.data[0].id as string;
const REPO = LIST.data[0].repo_id as string;
const RUN_ID = RUN_LIST.data[0].id as string;
const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const PL = `#windows-container .fulc-window[data-app-id="pipeline"]`;
const RN = `#windows-container .fulc-window[data-app-id="runs"]`;
const BARE = /\b(undefined|null|NaN)\b/;
const NEW_ID = "3f2b8c1e-5a4d-4e2b-9c6a-1d7e8f9a0b99";

interface Ev { seq: number; kind: string; at: string; payload: unknown }
interface Corr { id: string; work_item_id: string; origin: string; kind: string; body: string; status: string; content_hash: string; created_by_name: string; [k: string]: unknown }
interface Sent { conversation_id?: string; state: string; code?: string; text: string; spent_micro_usd?: number; cap_micro_usd?: number }
type Turn = { sse: string[]; before?: () => void } | { hold: true } | { drop: true };

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
/** The stream form of a JSON answer, as turn.ts emits it: conversation, the text (a state's fixed sentence arrives as text too), then done. */
function streamOf(s: Sent, extra: string[] = []): string[] {
  const words = s.text.split(" ");
  const half = s.state === "ok" ? [words.slice(0, 4).join(" "), " " + words.slice(4).join(" ")] : [s.text];
  return [
    ...(s.conversation_id ? [frame("conversation", { conversation_id: s.conversation_id })] : []),
    ...extra,
    ...half.map((delta) => frame("text", { delta })),
    frame("done", { state: s.state, ...(s.code ? { code: s.code } : {}), ...(s.spent_micro_usd !== undefined ? { spent_micro_usd: s.spent_micro_usd, cap_micro_usd: s.cap_micro_usd } : {}) }),
  ];
}
const ok = (text?: string): Turn => ({ sse: streamOf(text ? { ...SENT.ok, text } : SENT.ok) });

interface World {
  admin: boolean;
  corrections: Corr[];
  turns: Turn[];
  messages: { conversation_id?: string; repo_id?: string; work_item_id?: string; messages: { role: string; content: string }[] }[];
  decisions: { id: string; verb: string; body: unknown; status: number }[];
  runEvents: Ev[];
  holdStream: boolean;
  held: Route | null;
  requests: string[];
  /** When set, the item's timeline answers only after it resolves (so the detail redraws later, with Back focused). */
  timelineGate?: Promise<void>;
}
const newWorld = (): World => ({ admin: true, corrections: structuredClone(DRAFTS), turns: [], messages: [], decisions: [], runEvents: EVENTS.slice(0, 2), holdStream: false, held: null, requests: [] });

async function mockApi(page: Page, w: World) {
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  const err = (code: string) => ({ error: { code, message: "server text that must never be shown", request_id: "r" } });
  // Whether the page aborted the request is read from the signal it passed to fetch (a held route reports no failure).
  await page.addInitScript(() => {
    const real = window.fetch;
    const signals: AbortSignal[] = [];
    (window as unknown as { __asstSignals: AbortSignal[] }).__asstSignals = signals;
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      if (String(input).includes("/api/v1/assistant/messages") && init?.signal) signals.push(init.signal);
      return real.call(window, input, init);
    };
  });
  await page.route("**/api/cloud/auth/me", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), is_admin: w.admin } });
  });
  await page.route((u) => u.pathname.startsWith("/api/v1/") && u.pathname !== "/api/v1/events", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    w.requests.push(`${req.method()} ${p}${url.search}`);
    if (p === "/api/v1/assistant/messages") {
      w.messages.push(JSON.parse(req.postData() ?? "{}"));
      const t = w.turns.shift();
      if (!t) return json(route, 500, err("internal_error"));
      if ("hold" in t) return; // the answer never comes: the person has to press Stop
      if ("drop" in t) return route.abort("failed");
      t.before?.();
      return route.fulfill({ status: 200, contentType: "text/event-stream; charset=utf-8", headers: { "x-accel-buffering": "no" }, body: t.sse.join("") });
    }
    const dec = /^\/api\/v1\/corrections\/([^/]+)\/(accept|reject)$/.exec(p);
    if (dec && req.method() === "POST") {
      const row = w.corrections.find((c) => c.id === dec[1]);
      const verb = dec[2]!;
      if (!row) return json(route, 404, err("not_found"));
      const can = row.status === "proposed" || (verb === "reject" && row.status === "accepted");
      if (!can) { w.decisions.push({ id: row.id, verb, body: JSON.parse(req.postData() ?? "null"), status: 409 }); return json(route, 409, ALREADY); }
      row.status = verb === "accept" ? (row.kind === "run_note" ? "accepted" : "applied") : "rejected";
      w.decisions.push({ id: row.id, verb, body: JSON.parse(req.postData() ?? "null"), status: 200 });
      return json(route, 200, row);
    }
    if (p === `/api/v1/work-items/${ITEM}/corrections`) return json(route, 200, { data: w.corrections });
    if (p === `/api/v1/work-items/${ITEM}`) return json(route, 200, { ...LIST.data[0], stage: "in_progress" });
    if (p === "/api/v1/work-items") return json(route, 200, { data: [{ ...LIST.data[0], stage: "in_progress" }], next_cursor: null });
    if (p === "/api/v1/repos") return json(route, 200, REPOS);
    if (p.endsWith("/timeline")) { await w.timelineGate; return json(route, 200, TIMELINE); }
    if (p.endsWith("/roles")) return json(route, 200, ROLES);
    if (p === "/api/v1/runs") return json(route, 200, url.searchParams.get("work_item_id") ? WORK_RUNS : { data: [{ ...RUN_LIST.data[0] }], next_cursor: "" });
    if (p === `/api/v1/runs/${RUN_ID}/events`) {
      if ((req.headers()["accept"] ?? "").includes("text/event-stream")) {
        if (w.holdStream) { w.held = route; return; }
        return route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
      }
      const after = Number(url.searchParams.get("after_seq") ?? url.searchParams.get("cursor") ?? 0);
      const data = w.runEvents.filter((e) => e.seq > after).slice(0, Number(url.searchParams.get("limit") ?? 50));
      return json(route, 200, { data, next_cursor: data.length ? String(data[data.length - 1]!.seq) : String(after) });
    }
    if (p === `/api/v1/runs/${RUN_ID}`) return json(route, 200, { ...RUN, id: RUN_ID, status: "running" });
    return json(route, 404, err("not_found"));
  });
  await page.route("**/api/v1/events", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", headers: { "cache-control": "no-store" }, body: "event: idle\ndata: {}\n\n" }));
}

async function watch(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("dialog", (d) => { errors.push(`dialog: ${d.message()}`); void d.dismiss(); }); // an alert() from injected text would land here
  return errors;
}

async function boot(page: Page) {
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  await page.goto("/");
  await page.waitForFunction(() => (window as unknown as { currentStep?: string }).currentStep === "DESKTOP", null, { timeout: 30_000 });
}

const wm = (page: Page, fn: "open" | "close", id: string, arg?: unknown) =>
  page.evaluate(([f, i, a]) => (window as unknown as { FULCWM: Record<string, (id: string, arg?: unknown) => void> }).FULCWM[f as string]!(i as string, a), [fn, id, arg] as const);
const at = (page: Page, win: string, id: string) => page.locator(`${win} [data-testid="${id}"]`);
const press = async (page: Page, locator: ReturnType<Page["locator"]>) => (test.info().project.name === "phone" ? locator.tap() : locator.click());

/** Pipeline with the item's detail open. */
async function openItem(page: Page, w: World, tweak?: (w: World) => void) {
  const errors = await watch(page);
  tweak?.(w);
  await mockApi(page, w);
  await boot(page);
  await wm(page, "open", "pipeline");
  await expect(page.locator(PL)).toBeVisible();
  await expect(page.locator(PL)).not.toHaveClass(/opening/);
  await press(page, at(page, PL, "pl-card").first());
  await expect(at(page, PL, "asst")).toBeVisible();
  await expect(at(page, PL, "asst-cards-status")).not.toHaveText("Loading drafts…");
  return errors;
}
const P = (page: Page, id: string) => at(page, PL, id);
const typeAndSend = async (page: Page, text: string, win = PL) => {
  await at(page, win, "asst-input").fill(text);
  await press(page, at(page, win, "asst-send"));
};

/** The panel's rendered size and focusable controls, printed for the PR. */
async function measure(page: Page, label: string, win = PL) {
  const m = await page.evaluate(([sel]) => {
    const panel = document.querySelector(`${sel} [data-testid="asst"]`) as HTMLElement;
    const r = panel.getBoundingClientRect();
    const scroller = panel.closest(".pl-detail, .runs-detail") as HTMLElement;
    const focusable = panel.querySelectorAll('button:not([disabled]), textarea:not([disabled]), [tabindex="0"], a[href]').length;
    return { w: Math.round(r.width), h: Math.round(r.height), focusable, panelOverflow: panel.scrollWidth - panel.clientWidth, detailOverflow: scroller.scrollWidth - scroller.clientWidth, pageOverflow: document.documentElement.scrollWidth - window.innerWidth, vw: window.innerWidth };
  }, [win] as const);
  process.stdout.write(`MEASURE ${test.info().project.name} ${label} ${JSON.stringify(m)}\n`);
  expect(m.panelOverflow, label + ": the panel does not scroll sideways").toBeLessThanOrEqual(0);
  expect(m.detailOverflow, label + ": the detail does not scroll sideways").toBeLessThanOrEqual(0);
  expect(m.pageOverflow, label + ": the page does not scroll sideways").toBeLessThanOrEqual(0);
  return m;
}
async function clean(page: Page, errors: string[], win = PL) {
  expect(errors).toEqual([]);
  const text = await page.locator(`${win} [data-testid="asst"]`).innerText();
  expect(text).not.toMatch(BARE);
  expect(text).not.toContain("server text that must never be shown");
}

test.describe("D#597 CC-6a-2: the assistant panel on a Pipeline item", () => {
  test("empty: the first sentence, an open composer, the drafts waiting, and the panel is where the item's other sections are", async ({ page }) => {
    const w = newWorld();
    const errors = await openItem(page, w);
    await expect(P(page, "asst-empty")).toHaveText("Ask about this item: its Spec, verdicts, runs or the plan. I can read and propose a correction; a person decides.");
    await expect(P(page, "asst-input")).toBeEnabled();
    await expect(P(page, "asst-stop")).toBeHidden();
    await expect(P(page, "asst-new")).toBeHidden();
    await expect(P(page, "asst-card")).toHaveCount(2);
    await measure(page, "empty");
    await clean(page, errors);
    expect(w.messages).toEqual([]); // nothing is sent until a person sends it
  });

  test("an answer: the request names the repository and the item, the text arrives, the spend shows, and a second message names the conversation", async ({ page }) => {
    const w = newWorld();
    const errors = await openItem(page, w, (x) => x.turns.push(ok(), ok("Second answer.")));
    await typeAndSend(page, "What is blocking this?");
    await expect(P(page, "asst-text").last()).toHaveText(SENT.ok!.text);
    await expect(P(page, "asst-usage")).toHaveText("Used $0.42 of $2.00 in this conversation.");
    await expect(P(page, "asst-notice")).toHaveAttribute("data-state", "ready");
    expect(w.messages[0]).toEqual({ repo_id: REPO, work_item_id: ITEM, messages: [{ role: "user", content: "What is blocking this?" }] });
    await typeAndSend(page, "And the plan?");
    await expect(P(page, "asst-text").last()).toHaveText("Second answer.");
    expect(w.messages[1]).toEqual({ conversation_id: SENT.ok!.conversation_id, messages: [{ role: "user", content: "What is blocking this?" }, { role: "assistant", content: SENT.ok!.text }, { role: "user", content: "And the plan?" }] });
    await measure(page, "answer");
    await clean(page, errors);
  });

  test("working with Stop, then stopped: the request is aborted, what arrived stays, Retry sends the same message again", async ({ page }) => {
    const w = newWorld();
    const errors = await openItem(page, w, (x) => x.turns.push({ hold: true }, ok()));
    await typeAndSend(page, "Explain the verdicts");
    await expect(P(page, "asst-stop")).toBeVisible();
    await expect(P(page, "asst-notice")).toHaveText("The assistant is answering.");
    await expect(P(page, "asst-log")).toHaveAttribute("aria-busy", "true");
    await expect(P(page, "asst-send")).toBeDisabled();
    await measure(page, "working");
    await press(page, P(page, "asst-stop"));
    await expect(P(page, "asst-notice")).toHaveText("Stopped.");
    expect(await page.evaluate(() => (window as unknown as { __asstSignals: AbortSignal[] }).__asstSignals.map((s) => s.aborted))).toEqual([true]);
    await expect(P(page, "asst-stop")).toBeHidden();
    await expect(P(page, "asst-input")).toBeEnabled();
    await measure(page, "stopped");
    await press(page, P(page, "asst-retry"));
    await expect(P(page, "asst-text").last()).toHaveText(SENT.ok!.text);
    expect(w.messages).toHaveLength(2);
    expect(w.messages[1]!.messages).toEqual(w.messages[0]!.messages); // the same message, not a second copy
    await clean(page, errors);
  });

  test("off: the route's unconfigured answer shows the panel as off, with nothing else to set; a reload asks the route again", async ({ page }) => {
    const w = newWorld();
    const errors = await openItem(page, w, (x) => x.turns.push({ sse: streamOf(SENT.unconfigured!) }));
    await typeAndSend(page, "Hello?");
    await expect(P(page, "asst-notice")).toHaveText("The assistant is not available right now.");
    await expect(P(page, "asst-input")).toBeDisabled();
    await expect(P(page, "asst-send")).toBeDisabled();
    await expect(P(page, "asst-retry")).toHaveCount(0);
    await measure(page, "off");
    await clean(page, errors);
    await page.reload();
    await page.waitForFunction(() => (window as unknown as { currentStep?: string }).currentStep === "DESKTOP", null, { timeout: 30_000 });
    await wm(page, "open", "pipeline");
    await press(page, at(page, PL, "pl-card").first());
    await expect(P(page, "asst-input")).toBeEnabled(); // not remembered: the answer comes from the route each time
  });

  test("no key: the fixed sentence and a way to the key screen; the composer stays open for after the key is added", async ({ page }) => {
    const w = newWorld();
    const errors = await openItem(page, w, (x) => x.turns.push({ sse: streamOf(SENT.no_key!) }));
    await typeAndSend(page, "Hello?");
    await expect(P(page, "asst-notice")).toHaveText("Add a model key to use the assistant");
    await expect(P(page, "asst-input")).toBeEnabled();
    await measure(page, "no key");
    await press(page, P(page, "asst-keys"));
    await expect(page.locator(`#windows-container .fulc-window[data-app-id="model-key"]`)).toBeVisible();
    await clean(page, errors);
  });

  test("cap reached: the fixed sentence, the spend, a disabled composer, and New conversation starts clean", async ({ page }) => {
    const w = newWorld();
    const errors = await openItem(page, w, (x) => x.turns.push({ sse: streamOf(SENT.budget_reached!) }));
    await typeAndSend(page, "One more");
    await expect(P(page, "asst-notice")).toHaveText("This conversation has reached its spending limit. Start a new conversation to continue.");
    await expect(P(page, "asst-usage")).toHaveText("Used $1.99 of $2.00 in this conversation.");
    await expect(P(page, "asst-input")).toBeDisabled();
    await expect(P(page, "asst-text").last()).not.toContainText("spending limit"); // the sentence is the notice's, not a message
    await measure(page, "cap reached");
    await press(page, P(page, "asst-fresh"));
    await expect(P(page, "asst-empty")).toBeVisible();
    await expect(P(page, "asst-input")).toBeEnabled();
    await expect(P(page, "asst-input")).toBeFocused(); // the button left the page: focus went to the composer, not the document
    await expect(P(page, "asst-usage")).toBeHidden();
    await clean(page, errors);
  });

  test("unpriced and unavailable each have a fixed sentence; unavailable offers Retry", async ({ page }) => {
    const w = newWorld();
    const errors = await openItem(page, w, (x) => x.turns.push({ sse: streamOf(SENT.unpriced!) }, { sse: streamOf(SENT.unavailable!) }));
    await typeAndSend(page, "a");
    await expect(P(page, "asst-notice")).toHaveText("The assistant cannot price the model on your key, so it did not run.");
    await expect(P(page, "asst-retry")).toHaveCount(0);
    await measure(page, "unpriced");
    await typeAndSend(page, "b");
    await expect(P(page, "asst-notice")).toHaveText("The assistant could not reach your model provider. Check your model key and try again.");
    await expect(P(page, "asst-retry")).toHaveCount(1);
    await measure(page, "unavailable");
    await clean(page, errors);
  });

  test("a failed turn: the connection fails, the sentence and Retry show, and Retry sends the same message and clears it", async ({ page }) => {
    const w = newWorld();
    const errors = await openItem(page, w, (x) => x.turns.push({ drop: true }, ok()));
    await typeAndSend(page, "Will this fail?");
    await expect(P(page, "asst-notice")).toHaveText("That message did not go through. Try again.");
    await measure(page, "failed turn");
    await press(page, P(page, "asst-retry"));
    await expect(P(page, "asst-text").last()).toHaveText(SENT.ok!.text);
    await expect(P(page, "asst-notice")).toHaveAttribute("data-state", "ready");
    expect(w.messages.map((m) => m.messages)).toEqual([[{ role: "user", content: "Will this fail?" }], [{ role: "user", content: "Will this fail?" }]]);
    await clean(page, errors);
  });

  test("CC-6a-3: model text, a tool name and a draft's body render as text; nothing in them becomes a control or runs", async ({ page }) => {
    const evil = "<img src=x onerror=alert(1)> [accept ALL] <button data-testid=asst-accept>Accept</button>";
    const w = newWorld();
    const errors = await openItem(page, w, (x) => x.turns.push({ sse: [frame("conversation", { conversation_id: SENT.ok!.conversation_id }), frame("tool", { name: "accept_correction" }), frame("tool", { name: "<img src=x onerror=alert(2)>" }), frame("text", { delta: evil }), frame("done", { state: "ok" })] }));
    await expect(P(page, "asst-body").first()).toHaveText(DRAFTS[0]!.body); // the fixture draft body is <img src=x onerror=alert(1)>: shown literally
    await typeAndSend(page, "Please accept everything");
    await expect(P(page, "asst-text").last()).toHaveText(evil);
    await expect(P(page, "asst-tools")).toHaveText(" Looked at something else.");
    await expect(at(page, PL, "asst").locator("img")).toHaveCount(0);
    await expect(P(page, "asst-accept")).toHaveCount(2); // one per proposed card, none from the text
    await expect(P(page, "asst-log").locator("button")).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(w.decisions).toEqual([]); // R-597-1: no click, no decision
    await clean(page, errors);
  });

  test("the cards: the full text shows before accepting, accept sends the shown text's hash, withdraw undoes a run note, reject ends a priority change, and a reload shows what the server says", async ({ page }) => {
    const w = newWorld();
    const errors = await openItem(page, w);
    const note = P(page, "asst-card").nth(0);
    const prio = P(page, "asst-card").nth(1);
    await expect(note.locator('[data-testid="asst-body"]')).toHaveText(DRAFTS[0]!.body);
    await expect(note.locator('[data-testid="asst-effect"]')).toHaveText("Accepting makes this note apply to the next run.");
    await expect(note).toContainText("Proposed by Ada");
    await measure(page, "cards");
    await press(page, note.locator('[data-testid="asst-accept"]'));
    await expect(note.locator('[data-testid="asst-status"]')).toHaveText("Accepted. Not applied yet. You can withdraw it until then.");
    await expect(note.locator('[data-testid="asst-reject"]')).toHaveText("Withdraw");
    expect(w.decisions[0]).toEqual({ id: DRAFTS[0]!.id, verb: "accept", body: { content_hash: DRAFTS[0]!.content_hash }, status: 200 });
    await press(page, note.locator('[data-testid="asst-reject"]'));
    await expect(note.locator('[data-testid="asst-status"]')).toHaveText("Rejected.");
    await expect(note.locator("button:not([data-testid=asst-why])")).toHaveCount(0);
    await press(page, prio.locator('[data-testid="asst-reject"]'));
    await expect(prio.locator('[data-testid="asst-status"]')).toHaveText("Rejected.");
    expect(w.corrections.map((c) => c.status)).toEqual(["rejected", "rejected"]);
    // accept the run note again path: a fresh world row, then reload with it accepted-not-applied
    w.corrections[0]!.status = "accepted";
    await page.reload();
    await page.waitForFunction(() => (window as unknown as { currentStep?: string }).currentStep === "DESKTOP", null, { timeout: 30_000 });
    await wm(page, "open", "pipeline");
    await press(page, at(page, PL, "pl-card").first());
    await expect(P(page, "asst-card")).toHaveCount(1); // rejected rows are not listed; the accepted one still is, with Withdraw
    await expect(P(page, "asst-status")).toHaveText("Accepted. Not applied yet. You can withdraw it until then.");
    await expect(P(page, "asst-reject")).toHaveText("Withdraw");
    await clean(page, errors);
  });

  test("a plain member sees each draft read-only with the fixed line, and no Accept or Reject control", async ({ page }) => {
    const w = newWorld();
    const errors = await openItem(page, w, (x) => { x.admin = false; });
    await expect(P(page, "asst-member-line")).toHaveCount(2);
    await expect(P(page, "asst-member-line").first()).toHaveText("An owner or admin can accept or reject this.");
    await expect(P(page, "asst-accept")).toHaveCount(0);
    await expect(P(page, "asst-reject")).toHaveCount(0);
    await measure(page, "member cards");
    await clean(page, errors);
  });

  test("Ask why sends the fixed question naming the card's item and correction into the same conversation, and adds no request of its own", async ({ page }) => {
    const w = newWorld();
    const errors = await openItem(page, w, (x) => x.turns.push(ok(), ok("Because the note was missing.")));
    await typeAndSend(page, "Hi");
    await expect(P(page, "asst-text").last()).toHaveText(SENT.ok!.text);
    const before = w.requests.length;
    await press(page, P(page, "asst-card").nth(0).locator('[data-testid="asst-why"]'));
    await expect(P(page, "asst-text").last()).toHaveText("Because the note was missing.");
    const asked = w.messages[1]!;
    expect(asked.conversation_id).toBe(SENT.ok!.conversation_id);
    expect(asked.messages.at(-1)).toEqual({ role: "user", content: `Why did you draft correction ${DRAFTS[0]!.id} for work item ${ITEM}? Please explain what in the item or its runs led to it.` });
    expect(asked.messages.at(-1)!.content).not.toContain("onerror"); // nothing from the card's text
    const sent = w.requests.slice(before).filter((r) => r.startsWith("POST"));
    expect(sent).toEqual(["POST /api/v1/assistant/messages"]);
    await clean(page, errors);
  });

  test("a draft is labelled from its own origin: the assistant's draft after a turn, after a reload and in a second admin's session; a colleague's draft arriving mid-turn is not", async ({ page, browser }) => {
    const w = newWorld();
    const mine = { ...DRAFTS[0]!, id: NEW_ID, origin: "agent", kind: "question", body: "Is the toggle meant to follow the system theme?", content_hash: "3".repeat(64), created_by_name: "Ada" };
    const colleague = { ...DRAFTS[0]!, id: "3f2b8c1e-5a4d-4e2b-9c6a-1d7e8f9a0b98", origin: "person", kind: "question", body: "Can you also check the print styles?", content_hash: "4".repeat(64), created_by_name: "Cy" };
    const errors = await openItem(page, w, (x) => x.turns.push({
      before: () => x.corrections.push(mine, colleague), // both arrive while the turn runs
      sse: streamOf(SENT.ok!, [frame("tool", { name: "draft_correction" })]),
    }));
    await typeAndSend(page, "Draft a question for the author");
    const card = (id: string) => P(page, "asst-card").and(page.locator(`[data-id="${id}"]`));
    await expect(card(NEW_ID)).toContainText("Drafted by the assistant");
    await expect(card(NEW_ID)).toHaveAttribute("data-by", "assistant");
    await expect(card(NEW_ID).locator('[data-testid="asst-why"]')).toHaveCount(1);
    await expect(card(colleague.id)).toContainText("Proposed by Cy");
    await expect(card(colleague.id)).not.toContainText("Drafted by the assistant");
    await expect(P(page, "asst-card").nth(0)).toContainText("Proposed by Ada");
    await expect(P(page, "asst-tools")).toHaveText(" Looked at a draft correction.");
    // a reload: no turn happened in this page, and the label is still there
    await page.reload();
    await page.waitForFunction(() => (window as unknown as { currentStep?: string }).currentStep === "DESKTOP", null, { timeout: 30_000 });
    await wm(page, "open", "pipeline");
    await press(page, at(page, PL, "pl-card").first());
    await expect(card(NEW_ID)).toContainText("Drafted by the assistant");
    await expect(card(colleague.id)).toContainText("Proposed by Cy");
    await clean(page, errors);
    // a second admin, in a session that never saw the turn
    const other = await browser.newPage();
    const errors2 = await openItem(other, { ...newWorld(), corrections: structuredClone(w.corrections) });
    await expect(at(other, PL, "asst-card").and(other.locator(`[data-id="${NEW_ID}"]`))).toContainText("Drafted by the assistant");
    await expect(at(other, PL, "asst-card").and(other.locator(`[data-id="${colleague.id}"]`))).toContainText("Proposed by Cy");
    expect(errors2).toEqual([]);
    await other.close();
  });

  test("a new_item and a priority draft show the parsed fields under what accepting does; an escape shows decoded; a body the server would refuse has a fixed sentence and no Accept", async ({ page }) => {
    const w = newWorld();
    const base = { ...DRAFTS[0]!, origin: "agent", kind: "new_item", created_by_name: "Ada" };
    const dup = '{"title":"Fix typo","kind":"task","body":"Small","body":"HOSTILE"}';
    w.corrections.push(
      { ...base, id: "3f2b8c1e-5a4d-4e2b-9c6a-1d7e8f9a0c01", body: '{"title":"Fix typo \\u00e9","kind":"task","body":"Small"}', content_hash: "5".repeat(64) },
      { ...base, id: "3f2b8c1e-5a4d-4e2b-9c6a-1d7e8f9a0c02", body: dup, content_hash: "6".repeat(64) },
      { ...base, id: "3f2b8c1e-5a4d-4e2b-9c6a-1d7e8f9a0c03", body: "just words", content_hash: "7".repeat(64) },
    );
    const errors = await openItem(page, w);
    const prio = P(page, "asst-card").nth(1);
    await expect(prio.locator('[data-testid="asst-effect"]')).toHaveText("Accepting changes the priority to this");
    await expect(prio.locator('[data-testid="asst-field"]')).toHaveText("high");
    const good = P(page, "asst-card").nth(2);
    await expect(good.locator('[data-testid="asst-effect"]')).toHaveText("Accepting creates this");
    await expect(good.locator('[data-testid="asst-field"]')).toHaveText(["Fix typo é", "task", "Small"]);
    await expect(good.locator('[data-testid="asst-accept"]')).toHaveCount(1);
    for (const n of [3, 4]) {
      const bad = P(page, "asst-card").nth(n);
      await expect(bad.locator('[data-testid="asst-unparsed"]')).toHaveText("This draft can't be applied as written. Reject it instead.");
      await expect(bad.locator('[data-testid="asst-accept"]')).toHaveCount(0);
      await expect(bad.locator('[data-testid="asst-reject"]')).toHaveCount(1);
      await expect(bad.locator('[data-testid="asst-field"]')).toHaveCount(0);
    }
    await expect(P(page, "asst-card").nth(3).locator('[data-testid="asst-body"]')).toHaveText(dup); // the raw text is still shown in full
    await measure(page, "parsed fields");
    await clean(page, errors);
  });

  test("hidden characters show as markers with a warning, in the raw text and in parsed fields; the request still carries the stored hash", async ({ page }) => {
    const w = newWorld();
    const base = { ...DRAFTS[0]!, origin: "agent", created_by_name: "Ada" };
    const raw = "ok ‮ evil ​ ­ ️ \u{e0041} ㅤ ⠀ \u{e0100} \u0007 end\nsecond\tline";
    w.corrections.push(
      { ...base, id: "3f2b8c1e-5a4d-4e2b-9c6a-1d7e8f9a0d01", kind: "question", body: raw, content_hash: "8".repeat(64) },
      { ...base, id: "3f2b8c1e-5a4d-4e2b-9c6a-1d7e8f9a0d02", kind: "new_item", body: '{"title":"a\\u202eb","kind":"task","body":"c\\u200bd"}', content_hash: "9".repeat(64) },
    );
    const errors = await openItem(page, w);
    const q = P(page, "asst-card").nth(2);
    const body = q.locator('[data-testid="asst-body"]');
    await expect(body).toHaveText("ok [U+202E] evil [U+200B] [U+00AD] [U+FE0F] [U+E0041] [U+3164] [U+2800] [U+E0100] [U+0007] end\nsecond\tline");
    await expect(q.locator('[data-testid="asst-hidden"]')).toHaveText("This text has hidden characters. They are shown as [U+XXXX] markers. Read it with care before you decide.");
    await expect(body).toHaveCSS("unicode-bidi", "isolate");
    const f = P(page, "asst-card").nth(3);
    await expect(f.locator('[data-testid="asst-field"]')).toHaveText(["a[U+202E]b", "task", "c[U+200B]d"]);
    await expect(f.locator('[data-testid="asst-hidden"]')).toHaveCount(1);
    await expect(P(page, "asst-card").nth(0).locator('[data-testid="asst-hidden"]')).toHaveCount(0); // plain text: no warning
    const shown = await page.evaluate((id) => document.querySelector(`[data-id="${id}"] [data-testid="asst-body"]`)!.textContent!.includes("‮"), "3f2b8c1e-5a4d-4e2b-9c6a-1d7e8f9a0d01");
    expect(shown, "no bidi control reaches the page").toBe(false);
    await press(page, f.locator('[data-testid="asst-accept"]'));
    expect(w.decisions[0]).toMatchObject({ verb: "accept", body: { content_hash: "9".repeat(64) } }); // display only: the hash is the stored text's
    await clean(page, errors);
  });

  test("Stop and Try again by keyboard leave focus in the composer, not on the page", async ({ page }) => {
    const w = newWorld();
    const errors = await openItem(page, w, (x) => x.turns.push({ hold: true }, { drop: true }, ok()));
    await typeAndSend(page, "Slow one");
    await expect(P(page, "asst-stop")).toBeVisible();
    await P(page, "asst-stop").focus();
    await page.keyboard.press("Enter");
    await expect(P(page, "asst-notice")).toHaveText("Stopped.");
    await expect(P(page, "asst-input")).toBeFocused();
    await expect(P(page, "asst-retry")).toBeVisible();
    await P(page, "asst-retry").focus();
    await page.keyboard.press("Enter"); // the retry is the dropped connection: a failed turn, with Try again again
    await expect(P(page, "asst-notice")).toHaveText("That message did not go through. Try again.");
    await expect(P(page, "asst-input")).toBeFocused();
    await P(page, "asst-retry").focus();
    await page.keyboard.press("Enter");
    await expect(P(page, "asst-text").last()).toHaveText(SENT.ok!.text);
    await expect(P(page, "asst-input")).toBeFocused();
    await clean(page, errors);
  });

  test("Back keeps focus when the history arrives and the detail redraws around an open assistant panel", async ({ page }) => {
    const w = newWorld();
    let release!: () => void;
    const errors = await openItem(page, w, (x) => { x.timelineGate = new Promise<void>((r) => { release = r; }); });
    await expect(P(page, "pl-back")).toBeFocused(); // opening a card puts focus on Back
    release(); // the history loads: the detail is drawn again, with the panel in it
    await expect(P(page, "pl-history-error").or(page.locator(`${PL} .pl-detail h3:has-text("History")`))).toBeVisible();
    await page.waitForTimeout(300);
    await expect(P(page, "asst")).toBeVisible();
    await expect(P(page, "pl-back")).toBeFocused();
    await clean(page, errors);
  });

  test("keyboard: Ctrl+Enter sends, focus stays in the box, and a redraw of the detail (a run changing) does not take focus or the typed text", async ({ page }) => {
    test.skip(test.info().project.name === "phone", "no hardware keyboard on the phone profile");
    const w = newWorld();
    const errors = await openItem(page, w, (x) => x.turns.push(ok()));
    await P(page, "asst-input").focus();
    await page.keyboard.type("typed by keyboard");
    await page.evaluate(async () => {
      const ns = await import(new URL("core/storage-ns.js", document.baseURI).href);
      const ch = new BroadcastChannel("fx-live-" + (ns.getNamespace() || "default"));
      ch.postMessage({ type: "event", event: { id: "e-1", type: "run.status_changed", created_at: new Date().toISOString(), data: { runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", from: "running", to: "succeeded" } } });
      ch.close();
    });
    await page.waitForTimeout(500);
    await expect(P(page, "asst-input")).toBeFocused();
    await expect(P(page, "asst-input")).toHaveValue("typed by keyboard");
    await page.keyboard.press("Control+Enter");
    await expect(P(page, "asst-text").last()).toHaveText(SENT.ok!.text);
    await expect(P(page, "asst-input")).toBeFocused();
    await expect(P(page, "asst-input")).toHaveValue("");
    await clean(page, errors);
  });

  test("axe finds nothing in the Pipeline window with a conversation and the drafts open", async ({ page }) => {
    const w = newWorld();
    const errors = await openItem(page, w, (x) => x.turns.push(ok()));
    await typeAndSend(page, "Axe check");
    await expect(P(page, "asst-text").last()).toHaveText(SENT.ok!.text);
    const res = await new AxeBuilder({ page }).include(PL).exclude(`${PL} .window-titlebar`).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
    expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
    await clean(page, errors);
  });

  test("two tabs: the second Accept on the same draft says it was already decided and changes nothing", async ({ page, context }) => {
    const w = newWorld();
    const errors = await openItem(page, w);
    const second = await context.newPage();
    const errorsB = await watch(second);
    await mockApi(second, w);
    await boot(second);
    await wm(second, "open", "pipeline");
    await press(second, at(second, PL, "pl-card").first());
    await expect(at(second, PL, "asst-card")).toHaveCount(2);
    const first = P(page, "asst-card").nth(1);
    await press(page, first.locator('[data-testid="asst-accept"]'));
    await expect(first.locator('[data-testid="asst-status"]')).toHaveText("Accepted and applied.");
    // the other tab still shows Accept (it has not re-read): pressing it must not change anything
    const stale = at(second, PL, "asst-card").nth(1);
    await expect(stale.locator('[data-testid="asst-accept"]')).toBeVisible();
    await press(second, stale.locator('[data-testid="asst-accept"]'));
    await expect(stale.locator('[data-testid="asst-card-note"]')).toHaveText("Someone already decided this. Nothing was changed.");
    await expect(stale.locator('[data-testid="asst-status"]')).toHaveText("Accepted and applied.");
    await expect(stale.locator('[data-testid="asst-accept"]')).toHaveCount(0);
    expect(w.decisions.map((d) => [d.verb, d.status])).toEqual([["accept", 200], ["accept", 409]]);
    expect(w.corrections[1]!.status).toBe("applied"); // one decision took effect; the second changed nothing
    expect(errorsB).toEqual([]);
    await clean(second, errors);
  });

  test("375 px: long unbroken text in a message and a draft does not widen the panel", async ({ page }) => {
    test.skip(test.info().project.name !== "phone", "the 375 px viewport is the phone profile's");
    await page.setViewportSize({ width: 375, height: 812 });
    const w = newWorld();
    const long = "x".repeat(400);
    const errors = await openItem(page, w, (x) => { x.corrections[0]!.body = long + " " + long; x.turns.push({ sse: [frame("conversation", { conversation_id: SENT.ok!.conversation_id }), frame("text", { delta: long }), frame("done", { state: "ok" })] }); });
    await typeAndSend(page, long);
    await expect(P(page, "asst-text").last()).toHaveText(long);
    const m = await measure(page, "375px");
    expect(m.vw).toBe(375);
    await clean(page, errors);
  });
});

test.describe("D#597 CC-6a-2: the assistant panel on a run", () => {
  async function openRun(page: Page, w: World, tweak?: (w: World) => void) {
    const errors = await watch(page);
    tweak?.(w);
    await mockApi(page, w);
    await boot(page);
    await wm(page, "open", "runs");
    await expect(page.locator(RN)).toBeVisible();
    await expect(page.locator(RN)).not.toHaveClass(/opening/);
    await press(page, at(page, RN, "runs-row").first());
    await expect(at(page, RN, "asst")).toBeVisible();
    return errors;
  }
  const R = (page: Page, id: string) => at(page, RN, id);

  test("no run data: a run with no events says run details are not available yet, then the live rows replace it", async ({ page }) => {
    const w = newWorld();
    const errors = await openRun(page, w, (x) => { x.holdStream = true; x.runEvents = []; });
    await expect(R(page, "asst-run")).toHaveText("Run details aren't available here yet. I can see the Spec and verdicts.");
    await expect(R(page, "asst-run")).toHaveAttribute("data-state", "no_data");
    await measure(page, "no run data", RN);
    // the open run stream (the one Runs already holds; the panel opens none) delivers an agent.activity row written for a runner run
    const row: Ev = { seq: 9, kind: "agent.activity", at: "2026-09-18T12:01:00.000Z", payload: { tool: "read", path: "src/theme.ts" } };
    await expect.poll(() => w.held !== null).toBe(true);
    await w.held!.fulfill({ status: 200, contentType: "text/event-stream", body: `id: 9\nevent: run_event\ndata: ${JSON.stringify(row)}\n\n` });
    await expect(R(page, "asst-run")).toHaveText("Run activity: 1 step so far. Latest: Reading files.");
    await clean(page, errors, RN);
  });

  test("a run with other events but no activity rows does not claim details are missing: it says no steps were recorded", async ({ page }) => {
    const w = newWorld();
    const errors = await openRun(page, w, (x) => { x.holdStream = true; }); // the default events are not agent.activity rows
    await expect(R(page, "asst-run")).toHaveText("No step-by-step activity has been recorded for this run. I can see the Spec and verdicts.");
    await expect(R(page, "asst-run")).toHaveAttribute("data-state", "no_activity");
    await clean(page, errors, RN);
  });

  test("a run whose events already hold activity rows shows their count and the latest kind; a conversation here starts on the run's item", async ({ page }) => {
    const w = newWorld();
    const act = (seq: number, tool: string): Ev => ({ seq, kind: "agent.activity", at: "2026-09-18T12:00:30.000Z", payload: { tool } });
    const errors = await openRun(page, w, (x) => { x.runEvents = [...EVENTS.slice(0, 2), act(5, "read"), act(6, "test")]; x.turns.push(ok()); });
    await expect(R(page, "asst-run")).toHaveText("Run activity: 2 steps so far. Latest: Running tests.");
    await typeAndSend(page, "Why did this run read those files?", RN);
    await expect(R(page, "asst-text").last()).toHaveText(SENT.ok!.text);
    expect(w.messages[0]).toEqual({ repo_id: REPO, work_item_id: ITEM, messages: [{ role: "user", content: "Why did this run read those files?" }] });
    expect(w.requests).toContain(`GET /api/v1/work-items/${ITEM}`); // the repository is read from the item, only when a conversation starts
    await measure(page, "run answer", RN);
    await clean(page, errors, RN);
  });

  test("typing survives the run detail redrawing around the panel (a live event repaints it)", async ({ page }) => {
    test.skip(test.info().project.name === "phone", "no hardware keyboard on the phone profile");
    const w = newWorld();
    const errors = await openRun(page, w, (x) => { x.holdStream = true; });
    await R(page, "asst-input").focus();
    await page.keyboard.type("half a thought");
    await expect.poll(() => w.held !== null).toBe(true);
    const row: Ev = { seq: 10, kind: "agent.activity", at: "2026-09-18T12:02:00.000Z", payload: { tool: "command", command: "pnpm test" } };
    await w.held!.fulfill({ status: 200, contentType: "text/event-stream", body: `id: 10\nevent: run_event\ndata: ${JSON.stringify(row)}\n\n` });
    await expect(R(page, "asst-run")).toContainText("Latest: Running a command.");
    await expect(R(page, "asst-input")).toBeFocused();
    await expect(R(page, "asst-input")).toHaveValue("half a thought");
    await clean(page, errors, RN);
  });
});

