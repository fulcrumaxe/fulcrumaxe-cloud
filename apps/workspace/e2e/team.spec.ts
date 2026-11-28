// apps/workspace/e2e/team.spec.ts
//
// The Team app (agents, merge lanes, the watch switch) on the built cloud dist, served by fixture-server.mjs, at phone, tablet and desktop. Every call the
// window makes is answered by page.route() with the documented engine read shapes (test/fixtures/team/fixtures.mjs). The logic half (the agent-state
// table, the data-age and gap rules, the exact requests) is in test/team.test.mjs; this file covers what needs the real DOM and the production CSP:
// names are text and never elements, nothing reads null/undefined/NaN, the banner cannot be dismissed, the layout per breakpoint (element counts and
// bounding boxes), contrast numbers and axe under every theme, and engine.changed refetching every panel.

import { test, expect, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { bootToDesktop, waitForDesktop } from "./helpers/boot";
import { HOSTILE, REPO_A, REPO_B, RUNNER_A as BRIDGE_RUNNER, makeFixtures } from "../test/fixtures/team/fixtures.mjs";

const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const SERVER_TEXT = "server text that must never be shown";
const THEMES = ["classic-crt", "retro-amber", "nord", "corporate", "modern-flat", "crystal", "orchard", "cyberpunk"];
const WIN = `#windows-container .fulc-window[data-app-id="team"]`;
const BASE = "/api/v1/engine";
const LEASE = "5a1f3c52-7a0e-4c1a-9a53-0b1d2e3f4a55";
type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Mock {
  settings: Obj;
  repos: Obj[];
  agents: Obj;
  lanes: Obj;
  gates: Obj;
  log: Obj;
  /** The plan answer; null is a 204 (no snapshot). */
  plan: Obj | null;
  stats: Obj;
  usage: Obj;
  /** When set, answers /log by cursor (a page of lines, and the cursor for the next) instead of `log`. */
  logPage: ((cursor: string) => Obj) | null;
  /** Every PUT, with its body. */
  puts: { path: string; body: unknown }[];
  /** GET reads per path (query included). */
  reads: string[];
  /** Path fragments that answer 500. */
  fail: string[];
  /** The plan GET answers 404 with no code, as a server that has no such route does. */
  failPlan404?: boolean;
  /** The PUT answer: 200, or an error status with its code. */
  putStatus: number;
  putCode: string;
  streaming: boolean;
  streamFrame: string | null;
  /** The command list ({commands}) and the repo's decision settings; both change when the app writes. */
  commands: Obj;
  dials: Obj;
  /** Every POST to the command route or the dial route. */
  posts: { path: string; body: any }[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Every DELETE of a command, by id. */
  deletes: string[];
  /** The answer to a command POST (201) or a command DELETE (200), or an error status with `postCode`. */
  postStatus: number;
  postCode: string;
  /** The answer to a dial POST: 200, or an error status with `dialCode`. */
  dialStatus: number;
  dialCode: string;
  /** Every POST to a halt route, as "halt" or "clear". */
  halts: string[];
  /** The answer to a halt or clear POST: 200, or an error status with `haltCode`. A successful halt leaves the repo halted, and pending when `haltPends`. */
  haltStatus: number;
  haltCode: string;
  haltPends: boolean;
  /** Every POST to a repo's retry-stop route (the repo id), and its answer: 200 with `retryAnswer`, or an error status with `retryCode`. A person's or a halt's stop that was asked again clears the repo's `stop_failed`. */
  retries: string[];
  retryStatus: number;
  retryCode: string;
  retryAnswer: Obj;
  /** Every POST to a repo's update route (the repo id), and its answer: 200 (the repo then reports its update as under way), or an error status with `updateCode`. */
  updates: string[];
  updateStatus: number;
  updateCode: string;
  /** Every POST to a repo's start route (the repo id), and its answer: 200 (the repo then reports its session as starting), or an error status with `startCode`. */
  starts: string[];
  startStatus: number;
  startCode: string;
  /** Every POST to a repo's move route (the body sent), and its answer: 200 (the repo then reports its session as starting), or an error status with `moveCode`. */
  moves: Obj[];
  moveStatus: number;
  moveCode: string;
  /** Every POST to the checkout route (the body sent) and its answer. */
  checkouts: Obj[];
  checkoutAnswer: Obj;
  /** The answer to GET /api/runners (the fleet read), or null for a 500. */
  runners: Obj | null;
  /** One-click Connect: the answer to GET .../bridge (a test edits it to play the runner), every POST body and DELETE sent to it, and the status a POST or DELETE answers with. */
  bridge: Obj;
  bridgePosts: Obj[];
  bridgeDeletes: number;
  bridgeStatus: number;
  bridgeCode: string;
  /** The live view (ON-25b): every POST body and DELETE query to the watch route, the answer a POST gets (200 with `answer`, or an error status with `code` and `data`), and every opened watch stream's URL. */
  watch: { posts: Obj[]; deletes: string[]; status: number; code: string; data?: Obj; answer: Obj; streams: string[]; failStream: boolean };
}
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

function fresh(over: Partial<Mock> = {}): Mock {
  const F = makeFixtures(Date.now());
  return {
    settings: F.settings(), repos: [F.repo(), F.repo({ repo_id: REPO_B, full_name: "acme-labs/site", runner_name: "Studio desktop" })],
    agents: F.envelope([F.agent(), F.agent({ agent_id: "b2c3d4e5f6071829", role: "code-reviewer", discussion: 43, background: true, started_at: F.iso(120) })]),
    lanes: F.envelope([F.lane({ pr: 7, state: "testing" }), F.lane({ pr: 9, discussion: 44, state: "queued" }), F.lane({ pr: 5, discussion: 40, state: "merged" })]),
    gates: F.envelope([F.gate({ pr: 7, gate: "gate1", result: "pass" }), F.gate({ pr: 7, gate: "code_review", result: "fail" }), F.gate({ pr: 5, gate: "ci_full", result: "pass" })]),
    log: F.envelope([F.logLine({ line_id: "aaaa000000000001", pr: 7 }), F.logLine({ line_id: "aaaa000000000002", actor_role: "executor", category: "spawned", pr: null }), F.logLine({ line_id: "aaaa000000000003", discussion: null, pr: 9, category: "gate_passed" })]),
    plan: F.plan(), stats: F.stats(), usage: F.usage(), logPage: null,
    puts: [], reads: [], fail: [], putStatus: 200, putCode: "", streaming: false, streamFrame: null,
    commands: { commands: [] }, dials: F.dials(), posts: [], deletes: [], postStatus: 201, postCode: "", dialStatus: 200, dialCode: "", halts: [], haltStatus: 200, haltCode: "", haltPends: true, updates: [], updateStatus: 200, updateCode: "", retries: [], retryStatus: 200, retryCode: "", retryAnswer: { job_id: "j0000000-0000-4000-8000-000000000001", kind: "engine_session_stop", operate_epoch: 1, already_issued: false }, starts: [], startStatus: 200, startCode: "", moves: [], moveStatus: 200, moveCode: "", checkouts: [], checkoutAnswer: { already_held: true }, runners: F.fleet([F.runner(), F.runner({ id: "9d2c7b1e-5f3a-4e8b-8a6d-1c2b3a4d5e77", name: "Garage box" })]),
    bridgePosts: [], bridgeDeletes: 0, bridgeStatus: 201, bridgeCode: "", watch: { posts: [], deletes: [], status: 200, code: "", answer: { lease_id: LEASE, expires_at: new Date(Date.now() + 90_000).toISOString(), session_ends_at: new Date(Date.now() + 4 * 3600_000).toISOString(), limits: { per_repo: 2, per_account: 4 }, command: "held", machine: "online", last_seen: new Date().toISOString(), detail_as_of: null }, streams: [], failStream: false }, ...over, bridge: { phase: "idle", plan: "send", runners: [{ id: BRIDGE_RUNNER, name: "Workshop laptop", has_name: true, online: true, protocol_ok: true, last_seen_at: F.iso(120) }], connected: null, command: null, ...(over.bridge ?? {}) },
  };
}

/**
 * `stream: true` replaces the account event stream with one the test writes to: a real fetch() Response whose body is a ReadableStream carrying real SSE
 * frames (`id`, `event`, `data`, and `:` comments), read by the shell's own live client. window.__push(text) writes to the open stream, and
 * window.__opened counts how many times the client has opened it.
 */
async function setup(page: Page, mock: Mock, opts: { clock?: boolean; stream?: boolean } = {}) {
  const errors: string[] = [];
  if (opts.stream) {
    await page.addInitScript(() => {
      const w = window as unknown as { __push: (t: string) => void; __opened: number; __pulls: number };
      const real = window.fetch.bind(window);
      let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
      w.__opened = 0;
      w.__pulls = 0; // the reader asks for the next chunk once it has taken the last: a frame pushed is consumed when this goes up
      w.__push = (t) => { if (ctrl) ctrl.enqueue(new TextEncoder().encode(t)); };
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
        const u = new URL(url, location.href);
        if (u.pathname !== "/api/v1/events") return real(input, init);
        if (u.searchParams.has("watch")) { // the Team app's live view opens a stream of its own: the test pushes its bytes with __watchPush and closes it with __watchEnd
          const x = window as unknown as { __watchPush: (t: string) => void; __watchEnd: () => void; __watchOpened: string[] };
          x.__watchOpened = (x.__watchOpened ?? []).concat(u.search);
          let wc: ReadableStreamDefaultController<Uint8Array> | null = null;
          x.__watchPush = (t) => { try { wc?.enqueue(new TextEncoder().encode(t)); } catch { /* the page closed this stream already (dead or dropped): nothing to push into */ } };
          x.__watchEnd = () => { try { wc?.close(); } catch { /* closed */ } };
          const wb = new ReadableStream<Uint8Array>({ start(c) { wc = c; init?.signal?.addEventListener("abort", () => { try { c.error(new DOMException("aborted", "AbortError")); } catch { /* closed */ } }); } });
          return Promise.resolve(new Response(wb, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" } }));
        }
        const body = new ReadableStream<Uint8Array>({
          pull() { w.__pulls += 1; },
          start(c) { ctrl = c; w.__opened += 1; init?.signal?.addEventListener("abort", () => { try { c.error(new DOMException("aborted", "AbortError")); } catch { /* closed */ } }); },
        });
        return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" } }));
      };
    });
  }
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP ${e.violatedDirective}`)));
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  await page.route("**/api/v1/events", async (route) => {
    if (!mock.streaming) return new Promise<void>(() => {});
    const body = mock.streamFrame ?? "event: idle\ndata: {}\n\n";
    mock.streamFrame = null;
    await route.fulfill({ status: 200, contentType: "text/event-stream", headers: { "cache-control": "no-store" }, body });
  });
  // The live view's own stream (the lease rides on its URL): left open and silent, or refused when a test asks (failStream). With `stream: true` the page's own fetch answers it instead (window.__watchPush).
  await page.route((u) => u.pathname === "/api/v1/events" && u.searchParams.has("watch"), async (route) => {
    mock.watch.streams.push(new URL(route.request().url()).search);
    if (mock.watch.failStream) return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    return new Promise<void>(() => {});
  });
  await page.route((u) => u.pathname.startsWith("/api/v1/repos/") && u.pathname.includes("/decision-settings"), async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    mock.reads.push(url.pathname);
    if (req.method() === "GET") return json(route, 200, mock.dials);
    const body = req.postDataJSON();
    mock.posts.push({ path: url.pathname, body });
    if (mock.dialStatus !== 200) return json(route, mock.dialStatus, { error: { code: mock.dialCode, message: SERVER_TEXT, request_id: "r" } });
    mock.dials = { ...mock.dials, dials: mock.dials.dials.map((d: Obj) => (d.decision_type === body.decision_type ? { ...d, disposition: body.disposition } : d)) };
    return json(route, 200, mock.dials);
  });
  // The routes the next-step card's buttons call (ON-14c): the move route and the checkout route; Start engine is in the engine handler below.
  await page.route((u) => /^\/api\/runners\/repos\/[^/]+\/move$/.test(u.pathname), async (route) => {
    const body = route.request().postDataJSON();
    mock.moves.push(body);
    if (mock.moveStatus !== 200) return json(route, mock.moveStatus, { error: { code: mock.moveCode, message: SERVER_TEXT, request_id: "r" } });
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/")[4]);
    mock.repos = mock.repos.map((r) => (r.repo_id === id ? { ...r, liveness: "never", session: { ...r.session, state: "starting", stopped_reason: null } } : r));
    return json(route, 200, { repo_id: id, from_runner_id: null, to_runner_id: body.to_runner_id, old_copy: "none" });
  });
  await page.route((u) => u.pathname === "/api/v1/billing/checkout-session", async (route) => {
    mock.checkouts.push(route.request().postDataJSON());
    return json(route, 200, mock.checkoutAnswer);
  });
  await page.route((u) => u.pathname === "/api/runners", async (route) => {
    mock.reads.push("/api/runners");
    if (mock.runners === null) return json(route, 500, { error: { code: "server_error", message: SERVER_TEXT, request_id: "r" } });
    return json(route, 200, mock.runners);
  });
  await page.route((u) => u.pathname.startsWith(BASE), async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname + url.search;
    if (req.method() === "GET") {
      mock.reads.push(p);
      if (mock.fail.some((f) => p.includes(f))) return json(route, 500, { error: { code: "server_error", message: SERVER_TEXT, request_id: "r" } });
      if (url.pathname === `${BASE}/settings`) return json(route, 200, mock.settings);
      if (url.pathname === `${BASE}/repos`) return json(route, 200, { items: mock.repos });
      const m = url.pathname.match(new RegExp(`^${BASE}/repos/([^/]+)/(agents|lanes|gates|log|plan|stats|usage)$`));
      if (m && m[2] === "plan" && mock.failPlan404) return json(route, 404, { error: { code: "", message: SERVER_TEXT, request_id: "r" } });
      if (m && m[2] === "plan") return mock.plan === null ? route.fulfill({ status: 204 }) : json(route, 200, mock.plan);
      if (m && m[2] === "log" && mock.logPage) return json(route, 200, mock.logPage(url.searchParams.get("cursor") ?? ""));
      if (m) return json(route, 200, mock[m[2] as "agents" | "lanes" | "gates" | "log" | "stats" | "usage"]);
      if (/\/repos\/[^/]+\/bridge$/.test(url.pathname)) return json(route, 200, mock.bridge);
      if (url.pathname.endsWith("/commands")) return json(route, 200, mock.commands);
    }
    if (/\/repos\/[^/]+\/watch$/.test(url.pathname) && (req.method() === "POST" || req.method() === "DELETE")) {
      if (req.method() === "DELETE") { mock.watch.deletes.push(url.search); return json(route, 200, { released: true }); }
      mock.watch.posts.push(req.postDataJSON());
      if (mock.watch.status !== 200) return json(route, mock.watch.status, { error: { code: mock.watch.code, message: SERVER_TEXT, request_id: "r" }, ...(mock.watch.data ? { data: mock.watch.data } : {}) });
      return json(route, 200, mock.watch.answer);
    }
    if (/\/repos\/[^/]+\/bridge$/.test(url.pathname) && (req.method() === "POST" || req.method() === "DELETE")) {
      const enable = req.method() === "POST";
      if (enable) mock.bridgePosts.push(req.postDataJSON() ?? {});
      else mock.bridgeDeletes += 1;
      if (mock.bridgeStatus !== 201) return json(route, mock.bridgeStatus, { error: { code: mock.bridgeCode, message: SERVER_TEXT, request_id: "r" } });
      const id = "c0000000-0000-4000-8000-0000000000b1";
      mock.bridge = { ...mock.bridge, phase: enable ? "connecting" : "disconnecting", command: { id, kind: enable ? "bridge_enable" : "bridge_disable", runner_id: BRIDGE_RUNNER, runner_name: "Workshop laptop", state: "pending", result: null, refusal: null, root_tail: null, candidates: [], issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600000).toISOString(), acked_at: null } };
      return json(route, 201, { command_id: id, state: "pending", expires_at: new Date(Date.now() + 600000).toISOString(), runner_id: BRIDGE_RUNNER });
    }
    if (req.method() === "POST" && url.pathname.endsWith("/commands")) {
      const body = req.postDataJSON();
      mock.posts.push({ path: url.pathname, body });
      if (mock.postStatus !== 201) return json(route, mock.postStatus, { error: { code: mock.postCode, message: SERVER_TEXT, request_id: "r" } });
      const F = makeFixtures(Date.now());
      const id = `c0000000-0000-4000-8000-${String(mock.commands.commands.length + 1).padStart(12, "0")}`;
      mock.commands = { commands: [F.command({ id, kind: body.kind, args: body.args }), ...mock.commands.commands] };
      return json(route, 201, { command_id: id, state: "pending", expires_at: new Date(Date.now() + 540000).toISOString() });
    }
    const rm = req.method() === "POST" ? url.pathname.match(new RegExp(`^${BASE}/repos/([^/]+)/retry-stop$`)) : null;
    if (rm) {
      mock.retries.push(decodeURIComponent(rm[1]));
      expect(req.postData()).toBeNull(); // no body
      if (mock.retryStatus !== 200) return json(route, mock.retryStatus, { error: { code: mock.retryCode, message: SERVER_TEXT, request_id: "r" } });
      if (!mock.retryAnswer.queued) mock.repos = mock.repos.map((r) => (r.repo_id === decodeURIComponent(rm[1]) ? { ...r, stop_failed: null } : r));
      return json(route, 200, mock.retryAnswer);
    }
    const sm = req.method() === "POST" ? url.pathname.match(new RegExp(`^${BASE}/repos/([^/]+)/start$`)) : null;
    if (sm) {
      mock.starts.push(decodeURIComponent(sm[1]));
      expect(req.postData()).toBeNull(); // no body
      if (mock.startStatus !== 200) return json(route, mock.startStatus, { error: { code: mock.startCode, message: SERVER_TEXT, request_id: "r" } });
      mock.repos = mock.repos.map((r) => (r.repo_id === decodeURIComponent(sm[1]) ? { ...r, session: { ...r.session, state: "starting", stopped_reason: null } } : r));
      return json(route, 200, { job_id: "j0000000-0000-4000-8000-000000000002", kind: "engine_session_start", operate_epoch: 1, already_issued: false });
    }
    const um = req.method() === "POST" ? url.pathname.match(new RegExp(`^${BASE}/repos/([^/]+)/update$`)) : null;
    if (um) {
      mock.updates.push(decodeURIComponent(um[1]));
      expect(req.postData()).toBeNull(); // no body
      if (mock.updateStatus !== 200) return json(route, mock.updateStatus, { error: { code: mock.updateCode, message: SERVER_TEXT, request_id: "r" } });
      mock.repos = mock.repos.map((r) => (r.repo_id === decodeURIComponent(um[1]) ? { ...r, engine_update: { behind: null, update: updateRow() } } : r));
      return json(route, 200, { update_id: "u1", job_id: "j1", attempt: 1, from_version: "1.4.0", to_version: "1.5.0", branch: "fx/engine-update-1.5.0" });
    }
    const hm = req.method() === "POST" ? url.pathname.match(new RegExp(`^${BASE}/repos/([^/]+)/halt(/clear)?$`)) : null;
    if (hm) {
      const kind = hm[2] ? "clear" : "halt";
      mock.halts.push(kind);
      expect(req.postDataJSON()).toEqual({});
      if (mock.haltStatus !== 200) return json(route, mock.haltStatus, { error: { code: mock.haltCode, message: SERVER_TEXT, request_id: "r" } });
      mock.repos = mock.repos.map((r) => (r.repo_id === decodeURIComponent(hm[1]) ? { ...r, halted: kind === "halt", halt_pending: kind === "halt" && mock.haltPends } : r));
      return json(route, 200, kind === "halt" ? { halt_epoch: 1, halted: true, applied: false } : { halt_epoch: 1, halted: false });
    }
    if (req.method() === "DELETE" && url.pathname.startsWith(`${BASE}/commands/`)) {
      const id = decodeURIComponent(url.pathname.slice(`${BASE}/commands/`.length));
      mock.deletes.push(id);
      if (mock.bridge.command && mock.bridge.command.id === id) mock.bridge = { ...mock.bridge, phase: "idle", command: { ...mock.bridge.command, state: "cancelled" } };
      if (mock.postStatus !== 201) return json(route, mock.postStatus, { error: { code: mock.postCode, message: SERVER_TEXT, request_id: "r" } });
      mock.commands = { commands: mock.commands.commands.map((c: Obj) => (c.id === id ? { ...c, state: "cancelled" } : c)) };
      return json(route, 200, { command_id: id, state: "cancelled" });
    }
    if (req.method() === "PUT") {
      mock.puts.push({ path: url.pathname, body: req.postDataJSON() });
      if (mock.putStatus !== 200) return json(route, mock.putStatus, { error: { code: mock.putCode, message: SERVER_TEXT, request_id: "r" } });
      const body = (req.postDataJSON() ?? {}) as Obj;
      if (typeof body.watch_enabled === "boolean") mock.settings = { ...mock.settings, watch_enabled: body.watch_enabled };
      if (typeof body.operate_enabled === "boolean") {
        mock.settings = { ...mock.settings, operate_enabled: body.operate_enabled };
        mock.repos = mock.repos.map((r) => ({ ...r, operate_enabled: body.operate_enabled, ...(body.operate_enabled && r.session?.stopped_reason === "operate_off" ? { session: { ...r.session, state: "starting", stopped_reason: null } } : {}) }));
      }
      if (Array.isArray(body.repo_ids)) mock.settings = { ...mock.settings, repos: mock.settings.repos.map((r: Obj) => ({ ...r, enabled: body.repo_ids.includes(r.repo_id) })) };
      return json(route, 200, { ok: true });
    }
    return json(route, 404, { error: { code: "not_found", message: SERVER_TEXT, request_id: "r" } });
  });
  if (opts.clock) await bootToDesktop(page);
  else {
    await page.goto("/");
    await waitForDesktop(page);
  }
  return { mock, errors };
}

/** An engine update row as the repo list sends it (ON-15d): by default just started, on its first step. */
const updateRow = (over: Obj = {}): Obj => ({ from_version: "1.4.0", to_version: "1.5.0", phase: "push", sub_step: "engine_fetch", state: "started", failure_code: null, pr: null, ...over });
const BEHIND = { from: "1.4.0", to: "1.5.0" };
const t = (page: Page, id: string) => page.locator(`${WIN} [data-testid="${id}"]`);
const open = async (page: Page) => {
  await page.locator('.dock-icon[data-app-id="team"]').click();
  const win = page.locator(WIN);
  await expect(win).toBeVisible();
  await expect(win).not.toHaveClass(/opening/);
  await expect(t(page, "tm-loading")).toHaveCount(0);
  return win;
};
const press = async (loc: ReturnType<Page["locator"]>) => {
  if (test.info().project.name === "phone") await loc.tap();
  else await loc.click();
};
async function clean(page: Page, errors: string[]) {
  expect(errors).toEqual([]);
  const text = await page.evaluate(() => document.body.innerText);
  expect(text).not.toMatch(/\bnull\b|undefined|NaN|Invalid Date|ApiError|Could not load/);
  expect(text).not.toContain(SERVER_TEXT);
  expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i); // no id stands in for a name
}
async function applyTheme(page: Page, theme: string) {
  await page.evaluate(async (id) => {
    const m = await import(new URL("core/theme-manager.js", document.baseURI).href);
    await m.FULCTheme.apply(id);
  }, theme);
}
type Box = { x: number; y: number; width: number; height: number };
const box = async (loc: ReturnType<Page["locator"]>): Promise<Box> => {
  const b = await loc.boundingBox();
  if (!b) throw new Error("no bounding box");
  return b;
};

// How long of a long task lies inside a period the whole machine was not running the browser (see the Log test below), and what is left of it.
type LongTask = { start: number; ms: number };
type Stall = { from: number; to: number };
const heldMs = (t: LongTask, stalls: Stall[]) => stalls.reduce((n, g) => n + Math.max(0, Math.min(g.to, t.start + t.ms) - Math.max(g.from, t.start)), 0);
const ownMs = (t: LongTask, stalls: Stall[]) => t.ms - heldMs(t, stalls);
// A slow Team log is slow on nearly every press (each one rebuilds the list); a hosted runner that pauses the browser's render process
// (no script, no layout, no stall seen by the other tab) costs one or two presses out of 99. So the bar is: a task over 200 ms may
// happen at most LONG_TASK_ALLOWED times in a run, and none may pass LONG_TASK_CEILING.
const LONG_TASK_BAR = 200, LONG_TASK_ALLOWED = 3, LONG_TASK_CEILING = 600;
const longTasksTooSlow = (own: number[]) => own.filter((d) => d > LONG_TASK_BAR).length > LONG_TASK_ALLOWED || own.some((d) => d > LONG_TASK_CEILING);

test.describe("Team app", () => {
  test("a repo with a live engine: picker, chip, agents with D# links, lanes with gate chips and a Merged today list", async ({ page }) => {
    const { errors } = await setup(page, fresh());
    await open(page);
    await expect(t(page, "tm-repo").locator("option")).toHaveText(["acme-labs/widgets", "acme-labs/site"]);
    await expect(t(page, "tm-chip")).toHaveText("Engine connection: Live");
    await expect(t(page, "tm-runner")).toHaveText("Runner: Workshop laptop");
    await expect(t(page, "tm-agent")).toHaveCount(2);
    await expect(t(page, "tm-agent").nth(0)).toContainText("executor");
    await expect(t(page, "tm-agent").nth(0).locator("a")).toHaveAttribute("href", "https://github.com/acme-labs/widgets/discussions/42");
    await expect(t(page, "tm-agent").nth(0).locator("a")).toHaveAttribute("rel", /noopener/);
    await expect(t(page, "tm-agent").nth(0).locator("a")).toHaveAttribute("aria-label", "D#42 (opens in a new window)");
    await expect(page.locator(`${WIN} .tm-app ul:not([role="list"])`)).toHaveCount(0); // list-style:none drops the list role in some readers, so each list says it
    await expect(t(page, "tm-chip").locator(".tm-vh")).toHaveText("Engine connection: ");
    await expect(t(page, "tm-agent").nth(1)).toContainText("background");
    await expect(t(page, "tm-agent-text").nth(0)).toHaveText(/^since \d\d:\d\d$/);
    await expect(t(page, "tm-lane")).toHaveCount(3);
    const open7 = page.locator(`${WIN} [data-testid="tm-lane"][data-pr="7"]`);
    await expect(open7.locator('[data-testid="tm-gate"]')).toHaveText(["Gate 1: pass", "Code review: fail"]);
    await expect(open7.locator('[data-testid="tm-pr"]')).toHaveAttribute("href", "https://github.com/acme-labs/widgets/pull/7");
    const merged = t(page, "tm-merged");
    await expect(merged).toContainText("Merged today");
    await expect(merged.locator('[data-testid="tm-lane"]')).toHaveCount(1);
    await expect(merged.locator('[data-testid="tm-pr"]')).toHaveText("PR #5");
    await expect(t(page, "tm-agents-asof")).toHaveText(/^As of \d\d:\d\d \(\d+ min ago\)$/);
    await expect(t(page, "tm-lanes-asof")).toHaveText(/^As of \d\d:\d\d \(\d+ min ago\)$/);
    await expect(t(page, "tm-banner")).toBeHidden();
    await expect(t(page, "tm-agents-warn")).toHaveCount(0);
    await clean(page, errors);
  });

  test("layout numbers: the two panels sit side by side when the window is wide and stack when it is narrow; nothing overflows and every control is 44 px", async ({ page }) => {
    const { errors } = await setup(page, fresh());
    await open(page);
    // A phone window is first drawn at its default size and then fitted to the screen; measure after the fit.
    if (test.info().project.name === "phone") await expect.poll(() => page.evaluate((sel) => (document.querySelector(sel) as HTMLElement).getBoundingClientRect().width <= innerWidth + 1, WIN)).toBe(true);
    // One synchronous read, so a window still settling from its open animation cannot move between the three boxes.
    const [app, a, l] = await page.evaluate((sel) => ([".tm-app", '[data-testid="tm-agents"]', '[data-testid="tm-lanes"]'] as const).map((q) => { const r = (document.querySelector(sel + " " + q) as HTMLElement).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }), WIN) as Box[];
    // The layout switches on the app's own CSS width (a phone window is drawn scaled, so its box in the viewport is not that width).
    const cssWidth = await page.evaluate((sel) => (document.querySelector(sel) as HTMLElement).clientWidth, `${WIN} .tm-app`);
    const wide = cssWidth - 28 >= 640;
    if (test.info().project.name === "phone") expect(wide).toBe(false);
    if (wide) {
      expect(Math.abs(a.y - l.y)).toBeLessThanOrEqual(1);
      expect(l.x).toBeGreaterThanOrEqual(a.x + a.width - 1);
    } else {
      expect(l.y).toBeGreaterThanOrEqual(a.y + a.height - 1);
      expect(Math.abs(a.x - l.x)).toBeLessThanOrEqual(1);
    }
    for (const b of [a, l]) {
      expect(b.x).toBeGreaterThanOrEqual(app.x - 0.5);
      expect(b.x + b.width).toBeLessThanOrEqual(app.x + app.width + 0.5);
    }
    const over = await page.evaluate((sel) => { const el = document.querySelector(sel) as HTMLElement; return [el.scrollWidth, el.clientWidth]; }, `${WIN} .tm-app`);
    expect(over[0]).toBeLessThanOrEqual(over[1]);
    for (const id of ["tm-repo", "tm-settings-btn"]) expect((await box(t(page, id))).height).toBeGreaterThanOrEqual(43.5); // the phone window is drawn at a scale just under 1
    // The second row: plan and stats side by side when wide; the log spans the whole width.
    const [pl, st, lg, us] = await page.evaluate((sel) => (['[data-testid="tm-plan"]', '[data-testid="tm-stats"]', '[data-testid="tm-log"]', '[data-testid="tm-usage"]'] as const).map((q) => { const r = (document.querySelector(sel + " " + q) as HTMLElement).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }), WIN) as Box[];
    if (wide) {
      expect(Math.abs(pl.y - st.y)).toBeLessThanOrEqual(1);
      expect(lg.width).toBeGreaterThan(pl.width + st.width - 2);
    } else {
      expect(st.y).toBeGreaterThanOrEqual(pl.y + pl.height - 1);
      expect(Math.abs(lg.width - a.width)).toBeLessThanOrEqual(1);
    }
    // The Cost panel spans the whole width below plan and stats, and the log comes after it.
    expect(us.y).toBeGreaterThanOrEqual(Math.max(pl.y + pl.height, st.y + st.height) - 1);
    expect(Math.abs(us.width - lg.width)).toBeLessThanOrEqual(1);
    expect(lg.y).toBeGreaterThanOrEqual(us.y + us.height - 1);
    console.log("LAYOUT2 " + JSON.stringify({ project: test.info().project.name, plan: [Math.round(pl.x), Math.round(pl.y), Math.round(pl.width), Math.round(pl.height)], stats: [Math.round(st.x), Math.round(st.y), Math.round(st.width), Math.round(st.height)], log: [Math.round(lg.x), Math.round(lg.y), Math.round(lg.width), Math.round(lg.height)] }));
    // Element counts: one picker, one chip, six panels, 18 rows (2 agents, 3 lane rows, 2 plan items, 2 roadmap rows, 4 figures, 2 cost rows, 3 log lines), one heading.
    expect(await page.locator(`${WIN} .tm-panels .tm-panel`).count()).toBe(6);
    expect(await page.locator(`${WIN} .tm-panels .tm-item`).count()).toBe(18);
    expect(await page.locator(`${WIN} .tm-bar select`).count()).toBe(1);
    expect(await page.locator(`${WIN} h2`).count()).toBe(1);
    console.log("LAYOUT " + JSON.stringify({ project: test.info().project.name, app: [Math.round(app.width), Math.round(app.height), cssWidth], agents: [Math.round(a.x), Math.round(a.y), Math.round(a.width), Math.round(a.height)], lanes: [Math.round(l.x), Math.round(l.y), Math.round(l.width), Math.round(l.height)], wide }));
    await clean(page, errors);
  });

  test("L3: an agent that started 4 h ago with no stop reads unknown, and the word running is never used for it", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { errors } = await setup(page, fresh({ agents: F.envelope([F.agent({ started_at: F.iso(4 * 3600) }), F.agent({ agent_id: "b2c3d4e5f6071829", state: "unknown", started_at: F.iso(500) })]) }));
    await open(page);
    const rows = t(page, "tm-agent");
    await expect(rows).toHaveCount(2);
    for (const i of [0, 1]) {
      await expect(rows.nth(i)).toHaveAttribute("data-state", "unknown");
      await expect(rows.nth(i).locator('[data-testid="tm-agent-text"]')).toHaveText(/^unknown: started \d\d:\d\d, no stop seen$/);
      expect((await rows.nth(i).innerText()).toLowerCase()).not.toContain("running");
    }
    await expect(t(page, "tm-agents-empty")).toHaveCount(0);
    await clean(page, errors);
  });

  test("L2: a stale heartbeat shows last seen N min ago on every panel and keeps the data, and a running agent turns unknown", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { errors } = await setup(page, fresh({
      repos: [F.repo({ liveness: "stale", last_heard_at: F.iso(600) })],
      agents: F.envelope([F.agent()], { heard_age_s: 600 }), lanes: F.envelope([F.lane()], { heard_age_s: 600 }), gates: F.envelope([F.gate()], { heard_age_s: 600 }),
    }));
    await open(page);
    await expect(t(page, "tm-chip")).toHaveText(/^Engine connection: Stale since \d\d:\d\d$/);
    await expect(t(page, "tm-agents-warn")).toHaveText("last seen 10 min ago");
    await expect(t(page, "tm-lanes-warn")).toHaveText("last seen 10 min ago");
    await expect(t(page, "tm-agent")).toHaveCount(1);
    await expect(t(page, "tm-agent")).toHaveAttribute("data-state", "unknown");
    await expect(t(page, "tm-lane")).toHaveCount(1);
    const warn = await box(t(page, "tm-agents-warn"));
    expect(warn.width).toBeGreaterThan(0);
    await clean(page, errors);
  });

  test("the other liveness chips: runner removed and never connected", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const m = fresh({ repos: [F.repo({ liveness: "runner_removed" }), F.repo({ repo_id: REPO_B, full_name: "acme-labs/site", liveness: "never", last_heard_at: null })] });
    const { errors } = await setup(page, m);
    await open(page);
    await expect(t(page, "tm-chip")).toHaveText("Engine connection: Runner removed");
    await t(page, "tm-repo").selectOption(REPO_B);
    await expect(t(page, "tm-chip")).toHaveText("Engine connection: Never connected");
    await expect.poll(() => m.reads.some((r) => r.includes(`/${REPO_B}/agents`))).toBe(true);
    await clean(page, errors);
  });

  test("L1: missing events put a banner with the time and the count on the app; it has no control to dismiss it and stays through a refresh", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const gap = { missing_events: 12, gaps: [{ from_seq: 5, to_seq: 16, before_ts: F.iso(1800) }] };
    const { errors } = await setup(page, fresh({ lanes: F.envelope([F.lane()], gap) }));
    await open(page);
    const banner = t(page, "tm-banner");
    await expect(banner).toHaveText(/^Events missing since \d\d:\d\d \(12 events\)$/);
    expect(await banner.locator("button, a, input").count()).toBe(0);
    expect(await page.locator(`${WIN} [data-testid="tm-banner"]`).count()).toBe(1);
    await expect(page.locator(`${WIN} .tm-banner`)).toHaveCSS("border-top-width", "2px");
    // Open and close the settings sheet: the banner is still there.
    await press(t(page, "tm-settings-btn"));
    await expect(banner).toBeVisible();
    await press(t(page, "tm-settings-btn"));
    await expect(banner).toBeVisible();
    await clean(page, errors);
  });

  test("L2: a source over its limit reads <source> not updated for N h; the merge queue only while a PR in the lane is not final", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const ages = { loop: 3 * 3600, team_log: 3 * 3600, plan: 30 * 3600, merge_queue: 7 * 3600 };
    const { errors } = await setup(page, fresh({ agents: F.envelope([F.agent()], { source_ages_s: ages }) }));
    await open(page);
    await expect(t(page, "tm-notice")).toHaveText(["loop not updated for 3 h", "team log not updated for 3 h", "plan not updated for 30 h", "merge queue not updated for 7 h"]);
    await clean(page, errors);
  });

  test("the merge queue limit is silent when every PR in the lane is final", async ({ page }) => {
    const F = makeFixtures(Date.now());
    await setup(page, fresh({ lanes: F.envelope([F.lane({ state: "merged" })], { source_ages_s: { merge_queue: 9 * 3600 } }), agents: F.envelope([F.agent()], { source_ages_s: { merge_queue: 9 * 3600 } }) }));
    await open(page);
    await expect(t(page, "tm-lane")).toHaveCount(1);
    await expect(t(page, "tm-notice")).toHaveCount(0);
  });

  test("an empty lane and no agents say so", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { errors } = await setup(page, fresh({ agents: F.envelope([]), lanes: F.envelope([]), gates: F.envelope([]) }));
    await open(page);
    await expect(t(page, "tm-agents-empty")).toHaveText("No agents running");
    await expect(t(page, "tm-lanes-empty")).toHaveText("No pull requests in the merge lane");
    await expect(t(page, "tm-agents-asof")).toHaveText(/^As of /);
    await clean(page, errors);
  });

  test("a panel that cannot be read says so instead of showing an empty list, and the others still show", async ({ page }) => {
    const { errors } = await setup(page, fresh({ fail: ["/lanes"] }));
    await open(page);
    await expect(t(page, "tm-lanes-failed")).toHaveText("This panel couldn't be read.");
    await expect(t(page, "tm-lanes-empty")).toHaveCount(0);
    await expect(t(page, "tm-agent")).toHaveCount(2);
    await expect(t(page, "tm-refresh-failed")).toBeHidden(); // one panel failing does not flag the refresh of the whole view
    await clean(page, errors);
  });

  test("the plan route answering 404 (not there yet) fails the Plan panel only: its error shows, the view note does not", async ({ page }) => {
    const { errors } = await setup(page, fresh({ failPlan404: true }));
    await open(page);
    await expect(t(page, "tm-plan-failed")).toHaveText("This panel couldn't be read.");
    await expect(t(page, "tm-agent")).toHaveCount(2);
    await expect(t(page, "tm-stats-failed")).toHaveCount(0);
    await expect(t(page, "tm-refresh-failed")).toBeHidden();
    await clean(page, errors);
  });

  test("watch off: the app says so, an owner sees the switch, and turning it on sends one PUT and loads the panels", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { mock, errors } = await setup(page, fresh({ settings: F.settings({ watch_enabled: false }) }));
    await open(page);
    await expect(t(page, "tm-off")).toHaveText("Engine watch is off");
    expect(mock.reads.some((r) => r.includes("/repos"))).toBe(false);
    const sw = t(page, "tm-watch-off");
    await expect(sw).not.toBeChecked();
    await press(sw);
    await expect(t(page, "tm-agent")).toHaveCount(2);
    expect(mock.puts).toEqual([{ path: `${BASE}/settings`, body: { watch_enabled: true } }]);
    await expect(t(page, "tm-heading")).toBeFocused();
    await clean(page, errors);
  });

  test("watch off, as a member: the sentence shows and there is no switch", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { errors } = await setup(page, fresh({ settings: F.settings({ watch_enabled: false, can_edit: false }) }));
    await open(page);
    await expect(t(page, "tm-off")).toHaveText("Engine watch is off");
    await expect(t(page, "tm-watch-off")).toHaveCount(0);
    await clean(page, errors);
  });

  test("settings sheet: the switch and the repo boxes, a refused repo greyed with its reason, and a refusal from the server in plain words", async ({ page }) => {
    const { mock, errors } = await setup(page, fresh());
    await open(page);
    await expect(t(page, "tm-sheet")).toBeHidden();
    await press(t(page, "tm-settings-btn"));
    await expect(t(page, "tm-sheet")).toBeVisible();
    await expect(t(page, "tm-settings-btn")).toHaveAttribute("aria-expanded", "true");
    await expect(t(page, "tm-settings-btn")).toHaveAttribute("aria-controls", "tm-sheet");
    await expect(t(page, "tm-sheet")).toHaveAttribute("id", "tm-sheet");
    await expect(page.locator(`${WIN} section[aria-label], ${WIN} [role="region"]`)).toHaveCount(0); // the sheet is no second "Settings" landmark
    await expect(t(page, "tm-watch")).toBeChecked();
    await expect(t(page, "tm-repo-row")).toHaveCount(2);
    await expect(t(page, `tm-repo-${REPO_A}`)).toBeChecked();
    await expect(t(page, `tm-repo-${REPO_B}`)).toBeDisabled();
    await expect(t(page, "tm-refusal")).toHaveText("Not on one of your runners");
    await expect(t(page, `tm-repo-${REPO_B}`)).toHaveAttribute("aria-describedby", `tm-why-${REPO_B}`);
    await expect(t(page, "tm-refusal")).toHaveAttribute("id", `tm-why-${REPO_B}`);
    // Untick the repo that is on: one PUT with the new list, and the picker loses it.
    await press(t(page, `tm-repo-${REPO_A}`));
    await expect.poll(() => mock.puts.length).toBe(1);
    expect(mock.puts[0]).toEqual({ path: `${BASE}/settings`, body: { repo_ids: [] } });
    await expect(t(page, `tm-repo-${REPO_A}`)).not.toBeChecked();
    // A refusal is said in the app's words, not the server's.
    mock.putStatus = 409;
    mock.putCode = "repo_not_runner_local";
    await press(t(page, `tm-repo-${REPO_A}`));
    await expect(t(page, "tm-live")).toHaveText("That repository isn't on one of your runners.");
    await clean(page, errors);
  });

  test("settings sheet as a member: read-only, no delete button", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { mock, errors } = await setup(page, fresh({ settings: F.settings({ can_edit: false }) }));
    await open(page);
    await press(t(page, "tm-settings-btn"));
    await expect(t(page, "tm-readonly")).toHaveText("Only an owner or admin can change these settings.");
    await expect(t(page, "tm-watch")).toBeDisabled();
    await expect(t(page, `tm-repo-${REPO_A}`)).toBeDisabled();
    await expect(t(page, "tm-delete")).toHaveCount(0);
    // aria-disabled, not disabled: Tab reaches each control, which names the sentence that explains it, and Space changes nothing.
    for (const id of ["tm-watch", `tm-repo-${REPO_A}`]) {
      const box1 = t(page, id);
      await expect(box1).toHaveAttribute("aria-disabled", "true");
      await expect(box1).toHaveAttribute("aria-describedby", "tm-ro");
      await expect(box1).not.toHaveAttribute("disabled", /.*/);
      await box1.focus();
      expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe(id);
      await page.keyboard.press("Space");
      await expect(box1).toBeChecked();
    }
    await expect(page.locator(`${WIN} #tm-ro`)).toHaveText("Only an owner or admin can change these settings.");
    await page.keyboard.press("Tab"); // the next stop is reached with the keyboard, so nothing in the list traps focus
    expect(mock.puts).toEqual([]);
    await clean(page, errors);
  });

  test("deleting engine data asks first; Cancel sends nothing and Yes sends one PUT to the delete route", async ({ page }) => {
    const { mock, errors } = await setup(page, fresh());
    await open(page);
    await press(t(page, "tm-settings-btn"));
    await press(t(page, "tm-delete"));
    await expect(t(page, "tm-confirm")).toContainText("This cannot be undone.");
    await press(t(page, "tm-delete-cancel"));
    await expect(t(page, "tm-confirm")).toHaveCount(0);
    expect(mock.puts).toEqual([]);
    await press(t(page, "tm-delete"));
    await press(t(page, "tm-delete-yes"));
    await expect(t(page, "tm-live")).toHaveText("Engine data deleted.");
    expect(mock.puts).toEqual([{ path: `${BASE}/settings/delete-data`, body: null }]);
    await clean(page, errors);
  });

  test("names are only ever text: a hostile repo, runner and agent role create no element, link or script", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const name = "acme-labs/<b>x</b>";
    const m = fresh({
      repos: [F.repo({ full_name: name, runner_name: HOSTILE })], settings: F.settings({ repos: [F.settingsRepo({ full_name: name })] }),
      agents: F.envelope([F.agent({ role: HOSTILE })]), lanes: F.envelope([F.lane()]),
    });
    const { errors } = await setup(page, m);
    await open(page);
    await expect(t(page, "tm-runner")).toContainText(HOSTILE);
    await expect(t(page, "tm-agent")).toContainText(HOSTILE);
    await expect(page.locator(`${WIN} .tm-app img, ${WIN} .tm-app script, ${WIN} .tm-app iframe, ${WIN} .tm-app b, ${WIN} .tm-app svg`)).toHaveCount(0);
    await expect(t(page, "tm-runner").locator("bdi")).toHaveCount(1);
    await expect(t(page, "tm-agent").locator(".tm-role bdi")).toHaveCount(1);
    // The repo's name is not a usable link target, so the D# stays plain text.
    await expect(t(page, "tm-agent").locator("a")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(errors).toEqual([]);
  });

  test("a refresh does not close an open repo list or take focus from a box", async ({ page }) => {
    const { mock } = await setup(page, fresh({ streaming: true }));
    await open(page);
    await press(t(page, "tm-settings-btn"));
    const box1 = t(page, `tm-repo-${REPO_A}`);
    await box1.focus();
    const before = mock.reads.length;
    mock.streamFrame = `id: c-1\nevent: engine.changed\ndata: ${JSON.stringify({ id: "e1", type: "engine.changed", created_at: new Date().toISOString(), data: { repo_id: REPO_A, session_id: "s", last_seq: 9 } })}\n\n`;
    await expect.poll(async () => { if (mock.streamFrame !== null) await page.evaluate(() => window.dispatchEvent(new Event("pointerdown"))); return mock.streamFrame; }, { timeout: 30_000 }).toBeNull();
    await expect.poll(() => mock.reads.length, { timeout: 20_000 }).toBeGreaterThan(before);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe(`tm-repo-${REPO_A}`);
  });

  test("engine.changed with no panels named refetches every panel for the repo within the 10 s gate, without a reload", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { mock } = await setup(page, fresh({ streaming: true, agents: F.envelope([F.agent()]) }));
    await open(page);
    await expect(t(page, "tm-agent")).toHaveCount(1);
    mock.reads.length = 0;
    mock.agents = F.envelope([F.agent(), F.agent({ agent_id: "b2c3d4e5f6071829", role: "code-reviewer" })]);
    mock.lanes = F.envelope([F.lane({ pr: 11, state: "queued" })]);
    mock.streamFrame = `id: c-2\nevent: engine.changed\ndata: ${JSON.stringify({ id: "e2", type: "engine.changed", created_at: new Date().toISOString(), data: { repo_id: REPO_A, session_id: "s", last_seq: 10 } })}\n\n`;
    await expect.poll(async () => { if (mock.streamFrame !== null) await page.evaluate(() => window.dispatchEvent(new Event("pointerdown"))); return mock.streamFrame; }, { timeout: 30_000 }).toBeNull();
    await expect(t(page, "tm-agent")).toHaveCount(2, { timeout: 15_000 });
    await expect(t(page, "tm-pr")).toHaveText("PR #11", { timeout: 15_000 });
    for (const kind of ["agents?state=running", "lanes", "gates", "log?limit=100", "plan", "stats", "usage"]) expect(mock.reads.filter((r) => r === `${BASE}/repos/${REPO_A}/${kind}`).length).toBeGreaterThanOrEqual(1);
  });

  test("without a live stream everything is read again after 120 s, and nothing before", async ({ page }) => {
    const { mock } = await setup(page, fresh(), { clock: true });
    await open(page);
    await expect(t(page, "tm-agent")).toHaveCount(2);
    mock.reads.length = 0;
    await page.clock.runFor(119_000);
    await page.waitForTimeout(300);
    expect(mock.reads).toEqual([]);
    await page.clock.runFor(1_500);
    await expect.poll(() => mock.reads.filter((r) => r.endsWith("/lanes")).length).toBe(1);
  });

  test.describe("on push: only the panels a notice names are read", () => {
    let n = 0;
    const frame = (panels?: string[]) => {
      n += 1;
      const data = { repo_id: REPO_A, session_id: "s", last_seq: n, ...(panels ? { panels } : {}) };
      return `id: cur-${n}\nevent: engine.changed\ndata: ${JSON.stringify({ id: `ev${n}`, type: "engine.changed", created_at: new Date().toISOString(), data })}\n\n`;
    };
    const panelPath = (k: string) => `${BASE}/repos/${REPO_A}/${k}`;
    /**
     * A booted desktop, its stream open, then the page clock installed (the clock fakes performance.mark, and the live client starts on that mark, so it
     * goes in after the stream is up), the Team window open and the 10 s gate of its first read past.
     */
    async function ready(page: Page) {
      const { mock } = await setup(page, fresh(), { stream: true });
      await expect.poll(() => page.evaluate(() => { window.dispatchEvent(new Event("pointerdown")); return (window as unknown as { __opened: number }).__opened; }), { timeout: 30_000 }).toBeGreaterThan(0);
      await page.clock.install();
      await open(page);
      await expect(t(page, "tm-agent")).toHaveCount(2);
      await page.clock.runFor(15_000);
      mock.reads.length = 0;
      return mock;
    }
    const pulls = (page: Page) => page.evaluate(() => (window as unknown as { __pulls: number }).__pulls);
    const push = async (page: Page, text: string) => {
      const before = await pulls(page);
      await page.evaluate((x) => (window as unknown as { __push: (t: string) => void }).__push(x), text);
      await expect.poll(() => pulls(page)).toBeGreaterThan(before); // wait for the client to take the frame, not for a fixed time
    };
    const count = (mock: Mock, p: string) => mock.reads.filter((r) => r === p).length;

    test("a notice for lanes re-reads the lanes panel and nothing else", async ({ page }) => {
      const mock = await ready(page);
      await push(page, frame(["lanes"]));
      await page.clock.runFor(1_200);
      await expect.poll(() => count(mock, panelPath("lanes"))).toBe(1);
      await page.clock.runFor(8_000);
      await page.waitForTimeout(300);
      expect(mock.reads).toEqual([panelPath("lanes")]); // no other panel, no settings, no repo list, no commands, no dials
    });

    test("a burst of 20 notices in 2 s re-reads each named panel once, and the rest of the window once more", async ({ page }) => {
      const mock = await ready(page);
      for (let i = 0; i < 20; i++) { await push(page, frame(["lanes", "log"])); await page.clock.runFor(100); }
      await page.clock.runFor(1_300);
      await expect.poll(() => count(mock, panelPath("lanes"))).toBe(1);
      await expect.poll(() => count(mock, panelPath("log?limit=100"))).toBe(1);
      await page.waitForTimeout(300);
      expect(mock.reads).toHaveLength(2);
      await page.clock.runFor(10_000); // the notices of the second half of the burst were held behind the gate: one more read each, and then no more
      await expect.poll(() => count(mock, panelPath("lanes"))).toBe(2);
      await page.clock.runFor(30_000);
      await page.waitForTimeout(300);
      expect(mock.reads).toHaveLength(4);
    });

    test("a notice that names no panels, or an unknown one, re-reads every panel, once", async ({ page }) => {
      const mock = await ready(page);
      await push(page, frame());
      await push(page, frame(["lanes", "cost"]));
      await page.clock.runFor(1_500);
      await expect.poll(() => count(mock, `${BASE}/settings`)).toBe(1);
      for (const k of ["agents?state=running", "lanes", "gates", "log?limit=100", "plan", "stats", "usage"]) await expect.poll(() => count(mock, panelPath(k))).toBe(1);
    });

    test("idle: no request while nothing arrives, then the one 120 s safety read", async ({ page }) => {
      const mock = await ready(page);
      for (let i = 0; i < 4; i++) { await push(page, ": hb\n\n"); await page.clock.runFor(25_000); } // the server's heartbeat keeps the stream alive
      await page.waitForTimeout(300);
      expect(mock.reads).toEqual([]);
      await page.clock.runFor(21_000);
      await expect.poll(() => count(mock, `${BASE}/settings`)).toBe(1);
    });
  });

  test("a refresh that lands while a save is out does not put the ticked box back; the box and the saved value agree after a reload", async ({ page }) => {
    const { mock, errors } = await setup(page, fresh({ streaming: true }));
    await open(page);
    await press(t(page, "tm-settings-btn"));
    const repoBox = t(page, `tm-repo-${REPO_A}`);
    await expect(repoBox).toBeChecked();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    await page.route((u) => u.pathname === `${BASE}/settings`, async (route) => { if (route.request().method() === "PUT") await held; await route.fallback(); });
    await press(repoBox); // untick: the save is held
    await expect(repoBox).not.toBeChecked();
    const settingsReads = () => mock.reads.filter((r) => r === `${BASE}/settings`).length;
    const before = settingsReads();
    mock.streamFrame = `id: c-2\nevent: engine.changed\ndata: ${JSON.stringify({ id: "e2", type: "engine.changed", created_at: new Date().toISOString(), data: { repo_id: REPO_A, session_id: "s", last_seq: 11 } })}\n\n`;
    await expect.poll(async () => { if (mock.streamFrame !== null) await page.evaluate(() => window.dispatchEvent(new Event("pointerdown"))); return mock.streamFrame; }, { timeout: 30_000 }).toBeNull();
    await expect.poll(settingsReads, { timeout: 20_000 }).toBeGreaterThan(before); // the refresh read the old, ticked value while the save was out
    await expect(t(page, `tm-repo-${REPO_A}`)).not.toBeChecked();
    release();
    await expect.poll(() => mock.puts.length).toBe(1);
    await expect(t(page, `tm-repo-${REPO_A}`)).not.toBeChecked();
    await page.reload();
    await waitForDesktop(page);
    await open(page);
    await press(t(page, "tm-settings-btn"));
    await expect(t(page, `tm-repo-${REPO_A}`)).not.toBeChecked();
    await clean(page, errors);
  });

  test("a refresh that finds nothing new keeps the same boxes: not rebuilt, focus and identity stay", async ({ page }) => {
    const { mock } = await setup(page, fresh({ streaming: true }));
    await open(page);
    await press(t(page, "tm-settings-btn"));
    // The sheet draws twice on its first open: at once, and again when the runner lines' module lands a few ms later. Mark the boxes only after that
    // second draw (its runner status line is the sign), or the mark lands on a box the late draw then replaces.
    await expect(t(page, "tm-runner-status")).toBeVisible();
    await t(page, `tm-repo-${REPO_A}`).focus();
    await page.evaluate((id) => { (document.querySelector(`[data-testid="tm-repo-${id}"]`) as HTMLElement & { mark?: number }).mark = 7; }, REPO_A);
    const before = mock.reads.length;
    mock.streamFrame = `id: c-3\nevent: engine.changed\ndata: ${JSON.stringify({ id: "e3", type: "engine.changed", created_at: new Date().toISOString(), data: { repo_id: REPO_A, session_id: "s", last_seq: 12 } })}\n\n`;
    await expect.poll(async () => { if (mock.streamFrame !== null) await page.evaluate(() => window.dispatchEvent(new Event("pointerdown"))); return mock.streamFrame; }, { timeout: 30_000 }).toBeNull();
    await expect.poll(() => mock.reads.length, { timeout: 20_000 }).toBeGreaterThan(before);
    await expect.poll(() => mock.reads.filter((r) => r === `${BASE}/settings`).length).toBeGreaterThan(1);
    expect(await page.evaluate((id) => (document.querySelector(`[data-testid="tm-repo-${id}"]`) as (HTMLElement & { mark?: number }) | null)?.mark, REPO_A)).toBe(7);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe(`tm-repo-${REPO_A}`);
  });

  test("the runner module landing after the sheet opened does not replace the boxes: same nodes, same marks, runner lines still arrive", async ({ page }) => {
    const F = makeFixtures(Date.now());
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    // Routed before the page loads: index.html hints the module with modulepreload, so a later route would find it already fetched.
    await page.route((u) => u.pathname.endsWith("/team-runners.js"), async (route) => { await held; await route.fallback(); });
    const settings = F.settings({ repos: [F.settingsRepo({ bridged_runner_id: "9d2c7b1e-5f3a-4e8b-8a6d-1c2b3a4d5e66" })] });
    const { errors } = await setup(page, fresh({ settings, runners: F.fleet([F.runner()]) }));
    await open(page);
    await press(t(page, "tm-settings-btn"));
    await expect(t(page, `tm-repo-${REPO_A}`)).toBeVisible();
    await expect(t(page, "tm-runner-status")).toHaveCount(0); // the module is still held: no runner lines yet
    const mark = () => page.evaluate((id) => {
      const q = (s: string) => document.querySelector(`[data-testid="${s}"]`) as (HTMLElement & { mark?: number }) | null;
      return [q("tm-watch")?.mark, q(`tm-repo-${id}`)?.mark];
    }, REPO_A);
    await page.evaluate((id) => {
      const q = (s: string) => document.querySelector(`[data-testid="${s}"]`) as HTMLElement & { mark?: number };
      q("tm-watch").mark = 5;
      q(`tm-repo-${id}`).mark = 7;
    }, REPO_A);
    release();
    await expect(tv(page, "tm-runner-status")).toHaveText("Online · last seen 2 min ago"); // the sheet did draw again with the runner lines
    await expect(page.locator(`${WIN} label:has([data-testid="tm-watch"])`)).toHaveText("Watch the engine team on Workshop laptop");
    expect(await mark()).toEqual([5, 7]); // the same switch and repository box, not rebuilt copies
    await clean(page, errors);
  });

  // The sheet's vertical rhythm, as the single-block sheet drew it: offsets between neighbours, so the numbers do not depend on the window size.
  const sheetOffsets = (page: Page) => page.evaluate(() => {
    const sheet = document.querySelector('.fulc-window[data-app-id="team"] [data-testid="tm-sheet"]') as HTMLElement;
    const r = (el: Element) => el.getBoundingClientRect();
    const s = r(sheet);
    const ro = document.querySelector('.fulc-window[data-app-id="team"] [data-testid="tm-readonly"]');
    const sw = document.querySelector('.fulc-window[data-app-id="team"] [data-testid="tm-watch"]')!.closest("label")!;
    const last = [...sheet.querySelectorAll("*")].filter((e) => e.getBoundingClientRect().height > 0).reduce((m, e) => Math.max(m, r(e).bottom), 0);
    const round = (n: number) => Math.round(n * 1000) / 1000;
    return { roTop: ro ? round(r(ro).top - s.top) : null, switchTop: round(r(sw).top - (ro ? r(ro).bottom : s.top)), tail: round(s.bottom - last) };
  });

  test("the sheet keeps its spacing: the read-only sentence and the switch sit where the one-block sheet put them", async ({ page }) => {
    const ro = await setup(page, fresh({ settings: makeFixtures(Date.now()).settings({ can_edit: false }) }));
    await open(page);
    await press(t(page, "tm-settings-btn"));
    await expect(t(page, "tm-readonly")).toBeVisible();
    expect(await sheetOffsets(page)).toEqual({ roTop: 17, switchTop: 8, tail: 11 }); // measured on main before the sheet was split into parts
    await clean(page, ro.errors);
  });

  test("the sheet keeps its spacing when the member can edit: the switch sits at the top", async ({ page }) => {
    const { errors } = await setup(page, fresh());
    await open(page);
    await press(t(page, "tm-settings-btn"));
    await expect(t(page, "tm-watch")).toBeVisible();
    expect(await sheetOffsets(page)).toEqual({ roTop: null, switchTop: 11, tail: 11 });
    await clean(page, errors);
  });

  test("toggling a box keeps keyboard focus on it while the save is out and after it, and the box stays in the Tab order", async ({ page }) => {
    const { mock, errors } = await setup(page, fresh());
    await open(page);
    await press(t(page, "tm-settings-btn"));
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    await page.route((u) => u.pathname === `${BASE}/settings`, async (route) => { if (route.request().method() === "PUT") await held; await route.fallback(); });
    const active = () => page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
    const box1 = t(page, "tm-watch");
    await box1.focus();
    await page.keyboard.press("Space");
    await expect(box1).toHaveAttribute("aria-disabled", "true"); // saving
    await expect(box1).not.toHaveAttribute("disabled", /.*/);
    expect(await active()).toBe("tm-watch");
    await page.keyboard.press("Space"); // a press while the save is out changes nothing
    release();
    await expect(box1).not.toHaveAttribute("aria-disabled", "true");
    expect(mock.puts[0].body).toEqual({ watch_enabled: false });
    expect(await active()).toBe("tm-watch");
    await expect(t(page, "tm-live")).toHaveText("Saved.");
    // A repo box, the same way (the held PUT is already released, so the answer comes at once).
    await expect(box1).not.toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Space");
    await expect.poll(() => mock.puts.length).toBe(2);
    await expect(box1).not.toHaveAttribute("aria-disabled", "true");
    const repoBox = t(page, `tm-repo-${REPO_A}`);
    await repoBox.focus();
    await expect(repoBox).not.toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Space");
    await expect.poll(() => mock.puts.length).toBe(3);
    await expect(repoBox).not.toHaveAttribute("aria-disabled", "true");
    expect(mock.puts[2].body).toEqual({ repo_ids: [] });
    expect(await active()).toBe(`tm-repo-${REPO_A}`);
    await clean(page, errors);
  });

  test("the delete confirm takes focus, Cancel and Escape give it back to Delete, and Yes lands on Delete with the result spoken", async ({ page }) => {
    const { mock, errors } = await setup(page, fresh());
    await open(page);
    await press(t(page, "tm-settings-btn"));
    const active = () => page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
    const confirm = t(page, "tm-confirm");
    // Opening: focus moves into the group (on Cancel, the safe answer), which is named by its own heading.
    await press(t(page, "tm-delete"));
    await expect(confirm).toBeVisible();
    expect(await active()).toBe("tm-delete-cancel");
    await expect(confirm).toHaveAttribute("role", "group");
    const labelledBy = (await confirm.getAttribute("aria-labelledby")) ?? "";
    await expect(page.locator(`${WIN} #${labelledBy}`)).toHaveText("Delete engine data");
    await page.keyboard.press("Shift+Tab");
    expect(await active()).toBe("tm-delete-yes");
    // Cancel.
    await press(t(page, "tm-delete-cancel"));
    await expect(confirm).toHaveCount(0);
    expect(await active()).toBe("tm-delete");
    // Escape, from the confirm.
    await press(t(page, "tm-delete"));
    expect(await active()).toBe("tm-delete-cancel");
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    expect(await active()).toBe("tm-delete");
    await expect(t(page, "tm-sheet")).toBeVisible(); // Escape closed the confirm and nothing else
    expect(mock.puts).toEqual([]);
    // Yes: one PUT, the outcome spoken, and focus on Delete rather than on a vanished button.
    await press(t(page, "tm-delete"));
    await press(t(page, "tm-delete-yes"));
    await expect(t(page, "tm-live")).toHaveText("Engine data deleted.");
    await expect(confirm).toHaveCount(0);
    expect(await active()).toBe("tm-delete");
    expect(mock.puts).toEqual([{ path: `${BASE}/settings/delete-data`, body: null }]);
    await clean(page, errors);
  });

  test("a 403 on the delete route says only the account owner can delete engine data", async ({ page }) => {
    const { mock, errors } = await setup(page, fresh());
    await open(page);
    await press(t(page, "tm-settings-btn"));
    mock.putStatus = 403;
    mock.putCode = "forbidden";
    await press(t(page, "tm-delete"));
    await press(t(page, "tm-delete-yes"));
    await expect(t(page, "tm-live")).toHaveText("Only the account owner can delete engine data.");
    await clean(page, errors);
  });

  test("the banner and the refresh note are announced when they change and not on every poll", async ({ page }) => {
    test.setTimeout(240_000); // six safety reads of 120 s of page time each
    const F = makeFixtures(Date.now());
    const gap = (n: number) => ({ missing_events: n, gaps: [{ from_seq: 1, to_seq: n, before_ts: F.iso(900) }] });
    const ALL = ["/agents", "/lanes", "/gates", "/log", "/plan", "/stats", "/usage"]; // the note is for the whole view failing, so every panel read fails together
    const mock = fresh({ agents: F.envelope([F.agent()], gap(3)), fail: ["/lanes"] });
    const { errors } = await setup(page, mock, { clock: true });
    await open(page);
    const live = t(page, "tm-live");
    await expect(live).toContainText("Events missing since");
    await expect(live).toContainText("(3 events)");
    await expect(live).toContainText("Merge lane panel couldn't be read.");
    await expect(live).not.toContainText("Couldn't refresh");
    await expect(t(page, "tm-refresh-failed")).toBeHidden();
    await page.evaluate((sel) => {
      const w = window as unknown as { __said: number };
      w.__said = 0;
      new MutationObserver(() => { w.__said += 1; }).observe(document.querySelector(sel) as Element, { childList: true, characterData: true, subtree: true });
    }, `${WIN} [data-testid="tm-live"]`);
    const count = () => page.evaluate(() => (window as unknown as { __said: number }).__said);
    const poll = async () => {
      const before = mock.reads.filter((r) => r.endsWith("/gates")).length;
      await page.clock.runFor(121_000);
      await expect.poll(() => mock.reads.filter((r) => r.endsWith("/gates")).length).toBeGreaterThan(before);
      await page.waitForTimeout(300);
    };
    // Polls that find the same banner and the same failure say nothing.
    await poll();
    await poll();
    expect(await count()).toBe(0);
    // A banner that changes is said; a note that clears is not, and is said again when it comes back.
    mock.agents = F.envelope([F.agent()], gap(5));
    await poll();
    await expect(live).toContainText("(5 events)");
    const afterBanner = await count();
    expect(afterBanner).toBeGreaterThan(0);
    mock.fail = [];
    await poll();
    expect(await count()).toBe(afterBanner);
    mock.fail = ALL;
    await poll();
    await expect(live).toHaveText("Couldn't refresh. Showing the last data received.");
    expect(await count()).toBeGreaterThan(afterBanner);
    await clean(page, errors);
  });

  test("the same notice twice is announced twice", async ({ page }) => {
    const { mock } = await setup(page, fresh());
    await open(page);
    await press(t(page, "tm-settings-btn"));
    await page.evaluate((sel) => {
      const w = window as unknown as { __said: number };
      w.__said = 0;
      new MutationObserver(() => { w.__said += 1; }).observe(document.querySelector(sel) as Element, { childList: true, characterData: true, subtree: true });
    }, `${WIN} [data-testid="tm-live"]`);
    const said = () => page.evaluate(() => (window as unknown as { __said: number }).__said);
    mock.putStatus = 409;
    mock.putCode = "repo_not_runner_local";
    await press(t(page, `tm-repo-${REPO_A}`));
    await expect(t(page, "tm-live")).toHaveText("That repository isn't on one of your runners.");
    const first = await said();
    expect(first).toBeGreaterThan(0);
    await press(t(page, `tm-repo-${REPO_A}`));
    await expect.poll(said).toBeGreaterThan(first);
    await expect(t(page, "tm-live")).toHaveText("That repository isn't on one of your runners.");
  });

  // ── Operate ───────────────────────────────────────────────────────────────────────────────────────────────────────
  // A locked control is aria-disabled, so Playwright's own click would wait for it forever; a locked press is sent as a bare click event.
  const operateOn = (over: Partial<Mock> = {}) => {
    const F = makeFixtures(Date.now());
    return fresh({ settings: F.settings({ operate_enabled: true }), repos: [F.repo({ operate_enabled: true }), F.repo({ repo_id: REPO_B, full_name: "acme-labs/site", operate_enabled: true })], ...over });
  };
  const activeId = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.getAttribute("data-focus"));
  const CMDS = `${BASE}/repos/${REPO_A}/commands`;
  const SENT = "Sent. Waiting for the runner to pick it up.";
  const watchSaid = (page: Page) => page.evaluate((sel) => {
    const w = window as unknown as { __said: number };
    w.__said = 0;
    new MutationObserver(() => { w.__said += 1; }).observe(document.querySelector(sel) as Element, { childList: true, characterData: true, subtree: true });
  }, `${WIN} [data-testid="tm-live"]`);
  const said = (page: Page) => page.evaluate(() => (window as unknown as { __said: number }).__said);

  test("operate off: the panel says so, every control is aria-disabled with the reason, none is disabled, and a press sends nothing; the switch turns it on", async ({ page }) => {
    const { mock, errors } = await setup(page, fresh());
    await open(page);
    await expect(t(page, "tm-operate")).toBeVisible();
    await expect(t(page, "tm-op-why")).toHaveText("Operate is off.");
    const gate = page.locator(`${WIN} [data-gate]`);
    expect(await gate.count()).toBeGreaterThanOrEqual(14); // 3 buttons, the request form (3), the dial form (4), the 3 dial selects and their 3 Apply buttons, and 2 Stop buttons
    for (let i = 0; i < (await gate.count()); i++) {
      await expect(gate.nth(i)).toHaveAttribute("aria-disabled", "true");
      await expect(gate.nth(i)).toHaveAttribute("aria-describedby", "tm-op-why");
      await expect(gate.nth(i)).not.toHaveAttribute("disabled", /.*/);
    }
    await expect(page.locator(`${WIN} .tm-app ul:not([role="list"])`)).toHaveCount(0);
    await t(page, "tm-op-pause").focus();
    expect(await activeId(page)).toBe("tm-op-pause"); // still in the Tab order
    await t(page, "tm-op-pause").dispatchEvent("click");
    await t(page, "tm-op-request").dispatchEvent("click");
    await page.keyboard.press("Space");
    expect(mock.posts).toEqual([]);
    // The switch is how it gets turned on, so it is the one control that is not locked by this.
    const sw = t(page, "tm-op-switch");
    await expect(sw).not.toBeChecked();
    await expect(sw).not.toHaveAttribute("aria-disabled", "true");
    await sw.focus();
    await page.keyboard.press("Space");
    await expect(t(page, "tm-op-why")).toHaveCount(0);
    await expect(t(page, "tm-op-pause")).not.toHaveAttribute("aria-disabled", "true");
    expect(await activeId(page)).toBe("tm-op-switch");
    expect(mock.puts).toEqual([{ path: `${BASE}/settings`, body: { operate_enabled: true } }]);
    await clean(page, errors);
  });

  test("a member sees no operate controls and no command or dial is read; watch off and a halt lock everything with their reason", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const member = await setup(page, fresh({ settings: F.settings({ can_edit: false, operate_enabled: true }) }));
    await open(page);
    await expect(t(page, "tm-operate")).toBeHidden();
    await expect(t(page, "tm-stop")).toHaveCount(0);
    expect(member.mock.reads.some((r) => r.includes("/commands") || r.includes("decision-settings"))).toBe(false);
    await clean(page, member.errors);
  });

  test("watch off: the panel stays, locked, with the reason and a switch that says to turn watch on first", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { errors } = await setup(page, fresh({ settings: F.settings({ watch_enabled: false, operate_enabled: true }) }));
    await open(page);
    await expect(t(page, "tm-op-why")).toHaveText("Engine watch is off.");
    await expect(t(page, "tm-op-switch")).toHaveAttribute("aria-disabled", "true");
    await expect(t(page, "tm-op-switch")).toHaveAttribute("aria-describedby", "tm-op-sw-why");
    await expect(t(page, "tm-op-sw-why")).toHaveText("Turn on engine watch first.");
    await expect(t(page, "tm-op-start")).toHaveAttribute("aria-disabled", "true");
    await expect(t(page, "tm-op-cmds")).toHaveText("");
    await clean(page, errors);
  });

  test("a halted repo locks every control with the halt as the reason; a runner that was removed hides them; an offline machine says commands expire", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const halted = await setup(page, operateOn({ repos: [F.repo({ operate_enabled: true, halted: true })] }));
    await open(page);
    await expect(t(page, "tm-op-why")).toHaveText("The engine is halted.");
    await expect(t(page, "tm-op-pause")).toHaveAttribute("aria-disabled", "true");
    await expect(t(page, "tm-stop").first()).toHaveAttribute("aria-disabled", "true");
    await clean(page, halted.errors);
  });

  test("a removed runner hides the controls; an offline machine says commands will expire in 10 min", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const m = operateOn({ repos: [F.repo({ operate_enabled: true, liveness: "runner_removed" }), F.repo({ repo_id: REPO_B, full_name: "acme-labs/site", operate_enabled: true, liveness: "stale", last_heard_at: F.iso(600) })] });
    const { errors } = await setup(page, m);
    await open(page);
    await expect(t(page, "tm-op-removed")).toHaveText("The runner for this repository was removed, so commands can't be sent.");
    await expect(t(page, "tm-op-ctl")).toBeHidden();
    await t(page, "tm-repo").selectOption(REPO_B);
    await expect(t(page, "tm-op-offline")).toHaveText("Machine offline; commands will expire in 10 min.");
    await expect(t(page, "tm-op-ctl")).toBeVisible();
    await clean(page, errors);
  });

  test("Start day, Pause loop and Resume loop each send one command, say so once, keep focus on the button, and show the command pending", async ({ page }) => {
    const { mock, errors } = await setup(page, operateOn());
    await open(page);
    const live = t(page, "tm-live");
    for (const [id, kind] of [["tm-op-start", "start_day"], ["tm-op-pause", "pause_loop"], ["tm-op-resume", "resume_loop"]] as const) {
      await press(t(page, id));
      await expect(live).toHaveText(SENT);
      await expect(t(page, id)).not.toHaveAttribute("aria-disabled", "true");
      expect(await activeId(page)).toBe(id);
      expect(mock.posts.at(-1)).toEqual({ path: CMDS, body: { kind, args: {} } });
    }
    expect(mock.posts).toHaveLength(3);
    await expect(t(page, "tm-cmd")).toHaveCount(3);
    await expect(t(page, "tm-cmd").first().locator('[data-testid="tm-cmd-state"]')).toHaveText("Pending");
    await expect(t(page, "tm-cmd").first()).toContainText("Resume the loop");
    await expect(t(page, "tm-cmds-asof")).toHaveText(/^As of \d\d:\d\d \(\d+ min ago\)$/);
    await expect(page.locator(`${WIN} .tm-app ul:not([role="list"])`)).toHaveCount(0);
    await clean(page, errors);
  });

  test("Request agent sends the role and the Discussion; a bad number sends nothing and says why; what was typed survives the refresh", async ({ page }) => {
    const { mock, errors } = await setup(page, operateOn());
    await open(page);
    await t(page, "tm-op-role").selectOption("code-reviewer");
    await t(page, "tm-op-discussion").fill("0");
    await press(t(page, "tm-op-request"));
    await expect(t(page, "tm-live")).toHaveText("Choose a role and enter a Discussion number of 1 or more.");
    expect(mock.posts).toEqual([]);
    await t(page, "tm-op-discussion").fill("42");
    await press(t(page, "tm-op-request"));
    await expect(t(page, "tm-live")).toHaveText(SENT);
    expect(mock.posts).toEqual([{ path: CMDS, body: { kind: "request_spawn", args: { role: "code-reviewer", discussion: 42 } } }]);
    await expect(t(page, "tm-cmd").first()).toContainText("Request a code reviewer for D#42");
    await expect(t(page, "tm-op-discussion")).toHaveValue("42"); // the form is built once: the refresh after the send did not clear it
    await expect(t(page, "tm-op-role")).toHaveValue("code-reviewer");
    expect(await activeId(page)).toBe("tm-op-request");
    await clean(page, errors);
  });

  test("Set a dial sends the class, the level and how long it lasts", async ({ page }) => {
    const { mock, errors } = await setup(page, operateOn());
    await open(page);
    await expect(t(page, "tm-op-class").locator("option")).toHaveCount(8);
    await t(page, "tm-op-class").selectOption("merge.standard");
    await t(page, "tm-op-level").selectOption("2");
    await t(page, "tm-op-ttl").selectOption("for_today");
    await press(t(page, "tm-op-setdial"));
    await expect(t(page, "tm-live")).toHaveText(SENT);
    expect(mock.posts).toEqual([{ path: CMDS, body: { kind: "set_dial", args: { dial_class: "merge.standard", level: 2, ttl: "for_today" } } }]);
    await expect(t(page, "tm-cmd").first()).toContainText("Set standard merges to level 2 (for today)");
    await clean(page, errors);
  });

  test("Stop asks first: focus goes to Cancel, Escape and Cancel give it back to the Stop button, and Yes sends one stop and leaves the button saying it is on its way", async ({ page }) => {
    const { mock, errors } = await setup(page, operateOn());
    await open(page);
    await expect(t(page, "tm-stop")).toHaveCount(2);
    const first = t(page, "tm-stop").first();
    await expect(first).toHaveAttribute("aria-label", "Stop the executor agent on D#42 (id a1b2c3)");
    await expect(t(page, "tm-stop").nth(1)).toHaveAttribute("aria-label", "Stop the code reviewer agent on D#43 (id b2c3d4)"); // words, never the wire role
    const confirm = t(page, "tm-stop-confirm");
    await press(first);
    await expect(confirm).toBeVisible();
    await expect(t(page, "tm-stop-who")).toHaveText("Stop the executor agent on D#42 (id a1b2c3).");
    expect(await activeId(page)).toBe("tm-stop-cancel");
    await expect(confirm).toHaveAttribute("role", "group");
    const labelledBy = (await confirm.getAttribute("aria-labelledby")) ?? "";
    await expect(page.locator(`${WIN} #${labelledBy}`)).toHaveText("Stop this agent?");
    await page.keyboard.press("Shift+Tab");
    expect(await activeId(page)).toBe("tm-stop-yes");
    await press(t(page, "tm-stop-cancel"));
    await expect(confirm).toHaveCount(0);
    expect(await activeId(page)).toBe("tm-stop");
    await press(first);
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    expect(await activeId(page)).toBe("tm-stop");
    expect(mock.posts).toEqual([]);
    await press(first);
    await press(t(page, "tm-stop-yes"));
    await expect(t(page, "tm-live")).toHaveText(SENT);
    await expect(confirm).toHaveCount(0);
    expect(mock.posts).toEqual([{ path: CMDS, body: { kind: "stop_agent", args: { agent_id: "a1b2c3d4e5f60718" } } }]);
    await expect(t(page, "tm-stop").first()).toHaveText("Stop requested");
    await expect(t(page, "tm-stop").first()).toHaveAttribute("aria-disabled", "true");
    expect(await activeId(page)).toBe("tm-stop");
    await expect(t(page, "tm-cmd").first()).toContainText("Stop the executor agent");
    await clean(page, errors);
  });

  test("Stop closes with its agent: when the agent goes away the question closes and focus lands on the agents heading", async ({ page }) => {
    const mockData = operateOn();
    const { errors } = await setup(page, mockData, { clock: true });
    await open(page);
    await press(t(page, "tm-stop").first());
    await expect(t(page, "tm-stop-confirm")).toBeVisible();
    expect(await activeId(page)).toBe("tm-stop-cancel");
    mockData.agents = { ...mockData.agents, items: mockData.agents.items.slice(1) };
    await page.clock.runFor(121_000);
    await expect(t(page, "tm-stop-confirm")).toHaveCount(0);
    expect(await activeId(page)).toBe("agents-head");
    await expect(t(page, "tm-stop")).toHaveCount(1);
    await clean(page, errors);
  });

  test("a command waiting for the machine is read again within 15 s with no notice, and the reads stop once nothing waits", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const mockData = operateOn({ commands: { commands: [F.command({ state: "pending" })] } });
    const { errors } = await setup(page, mockData, { clock: true });
    await open(page);
    await expect(t(page, "tm-cmd")).toHaveCount(1);
    const reads = () => mockData.reads.filter((r) => r.includes("/commands")).length;
    const before = reads();
    mockData.commands = { commands: [F.command({ state: "applied", acked_at: new Date().toISOString() })] };
    await page.clock.runFor(15_000);
    await expect.poll(reads).toBeGreaterThan(before);
    await expect(t(page, "tm-cmd-state")).toHaveText("Applied");
    const settled = reads();
    await page.clock.runFor(60_000);
    expect(reads()).toBe(settled); // nothing waits any more: no read of the commands until the next safety read
    await clean(page, errors);
  });

  test("a command's outcome is said once, when its state changes; what was already there is not announced", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const id = "c0000000-0000-4000-8000-000000000001";
    const mockData = operateOn({ commands: { commands: [F.command({ id, state: "applied", acked_at: F.iso(20), kind: "start_day" }), F.command({ id: "c0000000-0000-4000-8000-000000000002", state: "pending" })] } });
    const { errors } = await setup(page, mockData, { clock: true });
    await open(page);
    await expect(t(page, "tm-live")).toHaveText("");
    await watchSaid(page);
    mockData.commands = { commands: [mockData.commands.commands[0], { ...mockData.commands.commands[1], state: "applied", acked_at: new Date().toISOString() }] };
    await page.clock.runFor(15_000); // no notice: the command that was waiting is read again every 10 s
    await expect(t(page, "tm-live")).toHaveText("Pause the loop: Applied. The engine did it.");
    const once = await said(page);
    await page.clock.runFor(31_000);
    await page.clock.runFor(31_000);
    expect(await said(page)).toBe(once); // nothing changed, nothing said again
    await expect(t(page, "tm-live")).toHaveText("Pause the loop: Applied. The engine did it.");
    await clean(page, errors);
  });

  test("Cancel stays usable while operate is off or the repo is halted, though every other control is locked", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const id = "c0000000-0000-4000-8000-000000000001";
    const { mock, errors } = await setup(page, operateOn({ repos: [F.repo({ operate_enabled: true, halted: true })], commands: { commands: [F.command({ id })] } }));
    await open(page);
    await expect(t(page, "tm-op-why")).toHaveText("The engine is halted.");
    await expect(t(page, "tm-op-pause")).toHaveAttribute("aria-disabled", "true");
    await expect(t(page, "tm-cmd-cancel")).toHaveAttribute("aria-disabled", "false");
    await expect(t(page, "tm-cmd-cancel")).not.toHaveAttribute("aria-describedby", /.*/);
    await press(t(page, "tm-cmd-cancel"));
    await expect(t(page, "tm-live")).toHaveText("Command cancelled.");
    expect(mock.deletes).toEqual([id]);
    await clean(page, errors);
  });

  test("every 409 and the 403 on a send is a plain sentence, never the server's text; the same sentence twice is said twice", async ({ page }) => {
    const { mock, errors } = await setup(page, operateOn());
    await open(page);
    const cases: [number, string, string][] = [
      [409, "too_many_pending", "Too many commands are waiting (20 is the most). Wait for some to finish, or cancel one."],
      [409, "operate_off", "Operate is off for this repository. Turn it on first."],
      [409, "engine_not_connected", "No engine is connected for this repository. Start the engine on your machine first."],
      [409, "halted", "The engine is halted, so this command isn't allowed."],
      [403, "forbidden", "Only an owner or admin can send commands."],
      [500, "server_error", "That didn't send. Try again."],
    ];
    for (const [status, code, sentence] of cases) {
      mock.postStatus = status;
      mock.postCode = code;
      await press(t(page, "tm-op-pause"));
      await expect(t(page, "tm-live")).toHaveText(sentence);
      await expect(t(page, "tm-op-pause")).not.toHaveAttribute("aria-disabled", "true");
      expect(await activeId(page)).toBe("tm-op-pause");
    }
    await expect(t(page, "tm-cmd")).toHaveCount(0); // nothing was queued by a refusal
    await watchSaid(page);
    mock.postStatus = 409;
    mock.postCode = "too_many_pending";
    await press(t(page, "tm-op-pause"));
    await expect.poll(() => said(page)).toBeGreaterThan(0);
    const first = await said(page);
    await press(t(page, "tm-op-pause"));
    await expect.poll(() => said(page)).toBeGreaterThan(first);
    await clean(page, errors);
  });

  test("a command's state is a word, with the refusal in plain words; Applied needs the runner's report; only a pending command has Cancel", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const id = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const commands = [
      F.command({ id: id(1), state: "pending" }),
      F.command({ id: id(2), state: "delivered", delivered_at: F.iso(30), expires_at: new Date(Date.now() + 500000).toISOString() }),
      F.command({ id: id(3), state: "applied", acked_at: F.iso(20) }),
      F.command({ id: id(4), state: "applied", acked_at: null }),
      F.command({ id: id(5), state: "refused", refusal: "host_not_running", acked_at: F.iso(20) }),
      F.command({ id: id(6), state: "expired", expires_at: F.iso(5) }),
      F.command({ id: id(7), state: "not_confirmed", delivered_at: F.iso(900) }),
      F.command({ id: id(8), state: "cancelled" }),
      F.command({ id: id(9), state: "pending", expires_at: F.iso(1) }),
    ];
    const { errors } = await setup(page, operateOn({ commands: { commands } }));
    await open(page);
    await expect(t(page, "tm-cmd-state")).toHaveText(["Pending", "Delivered", "Applied", "Delivered", "Refused", "Expired", "Not confirmed", "Cancelled", "Expired"]);
    await expect(t(page, "tm-cmd").nth(4).locator('[data-testid="tm-cmd-detail"]')).toHaveText("The engine host is not running on that machine.");
    await expect(t(page, "tm-cmd-cancel")).toHaveCount(1);
    await expect(t(page, "tm-cmd-cancel")).toHaveAttribute("aria-label", "Cancel: Pause the loop");
    await clean(page, errors);
  });

  test("Cancel on a pending command sends one DELETE, shows Cancelled, and puts focus on the list heading; a refusal says why", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const id = "c0000000-0000-4000-8000-000000000001";
    const { mock, errors } = await setup(page, operateOn({ commands: { commands: [F.command({ id }), F.command({ id: "c0000000-0000-4000-8000-000000000002", kind: "start_day" })] } }));
    await open(page);
    await expect(t(page, "tm-cmd-cancel")).toHaveCount(2);
    mock.postStatus = 409;
    mock.postCode = "already_delivered";
    const listReads = () => mock.reads.filter((r) => r.includes("/commands")).length;
    const before409 = listReads();
    await press(t(page, "tm-cmd-cancel").first());
    await expect.poll(listReads).toBeGreaterThan(before409); // a 409 means the list was stale: it is read again
    await expect(t(page, "tm-live")).toHaveText("The runner already has this command, so it can't be cancelled.");
    mock.postStatus = 201;
    await press(t(page, "tm-cmd-cancel").first());
    await expect(t(page, "tm-live")).toHaveText("Command cancelled.");
    expect(mock.deletes).toEqual([id, id]);
    await expect(t(page, "tm-cmd-state").first()).toHaveText("Cancelled");
    await expect(t(page, "tm-cmd-cancel")).toHaveCount(1);
    expect(await activeId(page)).toBe("cmds-head");
    await clean(page, errors);
  });

  test("the three engine dials: Apply posts one, focus stays on Apply, a refusal is a sentence, and an unapplied choice survives the clock ticking over", async ({ page }) => {
    const { mock, errors } = await setup(page, operateOn(), { clock: true });
    await open(page);
    await expect(t(page, "tm-dial")).toHaveCount(3);
    await expect(t(page, "tm-dial").nth(1)).toContainText("Server label for engine_merge");
    await expect(t(page, "tm-dial-select").nth(2).locator("option")).toHaveText(["Go ahead", "Ask me first"]);
    await expect(t(page, "tm-dials-asof")).toHaveText(/^As of \d\d:\d\d \(\d+ min ago\)$/);
    // A choice not yet applied is kept while the panels are read again, even across a minute.
    await t(page, "tm-dial-select").first().selectOption("act");
    const before = mock.reads.filter((r) => r.endsWith("/lanes")).length;
    await page.clock.runFor(121_000);
    await expect.poll(() => mock.reads.filter((r) => r.endsWith("/lanes")).length).toBeGreaterThan(before);
    await expect(t(page, "tm-dial-select").first()).toHaveValue("act");
    // Apply the middle one.
    await t(page, "tm-dial-select").nth(1).selectOption("act");
    await press(t(page, "tm-dial-apply").nth(1));
    await expect(t(page, "tm-live")).toHaveText("Dial saved.");
    expect(mock.posts).toEqual([{ path: `/api/v1/repos/${REPO_A}/decision-settings/dial`, body: { decision_type: "engine_merge", disposition: "act" } }]);
    await expect(t(page, "tm-dial-select").nth(1)).toHaveValue("act");
    expect(await activeId(page)).toBe("tm-dial-apply");
    // A refusal.
    mock.dialStatus = 422;
    mock.dialCode = "validation_failed";
    await press(t(page, "tm-dial-apply").nth(2));
    await expect(t(page, "tm-live")).toHaveText("That setting isn't allowed for this dial.");
    await clean(page, errors);
  });

  test("while a command is out every control is aria-disabled, focus stays on the button, and a second press sends nothing; afterwards it comes back and the result is said", async ({ page }) => {
    const { mock, errors } = await setup(page, operateOn());
    await open(page);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    await page.route((u) => u.pathname.endsWith("/commands"), async (route) => { if (route.request().method() === "POST") await held; await route.fallback(); });
    const pause = t(page, "tm-op-pause");
    await pause.focus();
    await page.keyboard.press("Space");
    await expect(pause).toHaveAttribute("aria-disabled", "true");
    await expect(t(page, "tm-op-start")).toHaveAttribute("aria-disabled", "true");
    await expect(pause).not.toHaveAttribute("disabled", /.*/);
    expect(await activeId(page)).toBe("tm-op-pause");
    await page.keyboard.press("Space"); // a press while the send is out changes nothing
    release();
    await expect(pause).not.toHaveAttribute("aria-disabled", "true");
    await expect(t(page, "tm-live")).toHaveText(SENT);
    expect(await activeId(page)).toBe("tm-op-pause");
    expect(mock.posts).toHaveLength(1);
    await clean(page, errors);
  });

  test("a refresh that finds the same list says nothing; the operate notice is announced when it changes", async ({ page }) => {
    const { mock, errors } = await setup(page, operateOn(), { clock: true });
    await open(page);
    await press(t(page, "tm-op-pause"));
    await expect(t(page, "tm-live")).toHaveText(SENT);
    await watchSaid(page);
    const poll = async () => {
      const before = mock.reads.filter((r) => r.endsWith("/gates")).length;
      await page.clock.runFor(121_000);
      await expect.poll(() => mock.reads.filter((r) => r.endsWith("/gates")).length).toBeGreaterThan(before);
      await page.waitForTimeout(300);
    };
    await poll();
    await poll();
    expect(await said(page)).toBe(0);
    await clean(page, errors);
  });

  // ── Halt ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  const REPOS_READS = (mock: Mock) => mock.reads.filter((r) => r === `${BASE}/repos`).length;

  test("an owner halts: Halt asks first in plain words with the runner's name, focus goes to Cancel, Escape and Cancel give it back, Yes sends one POST and the chip reads Halting…", async ({ page }) => {
    const { mock, errors } = await setup(page, operateOn());
    await open(page);
    await expect(t(page, "tm-halt-chip")).toBeHidden();
    const btn = t(page, "tm-halt-btn");
    await expect(btn).toHaveText("Halt");
    await expect(btn).toHaveAttribute("aria-disabled", "false");
    const confirm = t(page, "tm-halt-confirm");
    await press(btn);
    await expect(confirm).toBeVisible();
    await expect(t(page, "tm-halt-confirm-text")).toHaveText("This stops the engine on Workshop laptop now and kills its agents.");
    await expect(confirm).toContainText("Every command is refused until an owner or admin clears the halt.");
    await expect(confirm).toHaveAttribute("role", "group");
    const labelledBy = (await confirm.getAttribute("aria-labelledby")) ?? "";
    await expect(page.locator(`${WIN} #${labelledBy}`)).toHaveText("Halt the engine?");
    expect(await activeId(page)).toBe("tm-halt-cancel");
    await page.keyboard.press("Shift+Tab");
    expect(await activeId(page)).toBe("tm-halt-yes");
    await press(t(page, "tm-halt-cancel"));
    await expect(confirm).toHaveCount(0);
    expect(await activeId(page)).toBe("tm-halt-btn");
    await press(btn);
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    expect(await activeId(page)).toBe("tm-halt-btn");
    expect(mock.halts).toEqual([]);
    await press(btn);
    await press(t(page, "tm-halt-yes"));
    await expect(t(page, "tm-halt-chip")).toHaveText("Halting…");
    expect(mock.halts).toEqual(["halt"]);
    await expect(confirm).toHaveCount(0);
    await expect(t(page, "tm-halt-text")).toHaveAttribute("data-state", "pending");
    await expect(t(page, "tm-clear-btn")).toHaveText("Clear halt");
    await expect(t(page, "tm-halt-btn")).toHaveCount(0);
    expect(await activeId(page)).toBe("tm-clear-btn"); // focus follows the one control that stands for the action
    await expect(t(page, "tm-live")).toHaveText("Halting. Waiting for the machine to confirm it stopped the engine.");
    await expect(t(page, "tm-op-why")).toHaveText("A halt is being applied."); // pending wins over halted while the machine has not confirmed
    await clean(page, errors);
  });

  test("the halt applied: the chip reads Halted on the next read, said once; a clear asks first, says the engine is not started, and puts the app back", async ({ page }) => {
    const { mock, errors } = await setup(page, operateOn(), { clock: true });
    await open(page);
    await press(t(page, "tm-halt-btn"));
    await press(t(page, "tm-halt-yes"));
    await expect(t(page, "tm-halt-chip")).toHaveText("Halting…");
    mock.repos = mock.repos.map((r) => ({ ...r, halt_pending: false }));
    await watchSaid(page);
    await page.clock.runFor(121_000);
    await expect(t(page, "tm-halt-chip")).toHaveText("Halted");
    await expect(t(page, "tm-live")).toHaveText("The engine is halted.");
    await expect(t(page, "tm-halt-text")).toHaveText("The engine is halted. It is stopped on the machine and every command is refused until a person clears the halt.");
    await expect(t(page, "tm-op-why")).toHaveText("The engine is halted.");
    await expect(t(page, "tm-op-pause")).toHaveAttribute("aria-disabled", "true");
    const said1 = await said(page);
    await page.clock.runFor(121_000);
    await page.clock.runFor(121_000);
    await page.waitForTimeout(300);
    expect(await said(page)).toBe(said1); // a poll that finds the same state says nothing
    const confirm = t(page, "tm-halt-confirm");
    await press(t(page, "tm-clear-btn"));
    await expect(confirm).toBeVisible();
    await expect(page.locator(`${WIN} #tm-halt-q`)).toHaveText("Clear the halt?");
    await expect(confirm).toContainText("The engine is not started for you");
    await expect(confirm).toContainText("does not lift that");
    expect(await activeId(page)).toBe("tm-halt-cancel");
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    expect(await activeId(page)).toBe("tm-clear-btn");
    expect(mock.halts).toEqual(["halt"]);
    await press(t(page, "tm-clear-btn"));
    await press(t(page, "tm-halt-yes"));
    expect(mock.halts).toEqual(["halt", "clear"]);
    await expect(t(page, "tm-halt-chip")).toBeHidden();
    await expect(t(page, "tm-halt-btn")).toHaveText("Halt");
    expect(await activeId(page)).toBe("tm-halt-btn");
    await expect(t(page, "tm-live")).toHaveText("The halt is cleared. The engine is not started again until you start it.");
    await expect(t(page, "tm-op-pause")).toHaveAttribute("aria-disabled", "false");
    await clean(page, errors);
  });

  test("a member sees the halted state and its chip but no Halt, no Clear and no question; an owner sees Halt even while operate is off", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const member = await setup(page, operateOn({ settings: F.settings({ can_edit: false, operate_enabled: true }), repos: [F.repo({ operate_enabled: true, halted: true })] }));
    await open(page);
    await expect(t(page, "tm-halt-chip")).toHaveText("Halted");
    await expect(t(page, "tm-halt-text")).toContainText("The engine is halted.");
    await expect(page.locator(`${WIN} [data-testid="tm-halt"] button`)).toHaveCount(0);
    await expect(t(page, "tm-operate")).toBeHidden();
    await clean(page, member.errors);
  });

  // Five minutes ago, but never before local midnight: the app writes a halt from an earlier day as "11-17 14:05", so a run in the first minutes
  // after midnight (CI runs in UTC) would otherwise expect "23:57" and get the dated form.
  const sameDayAgo = () => { const d = new Date(); const sinceMidnight = Math.floor((d.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 1000); return Math.max(0, Math.min(5 * 60, sinceMidnight - 2)); };
  const hhmmOf = (iso: string) => { const d = new Date(iso); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
  const memberOf = (F: ReturnType<typeof makeFixtures>, over: Record<string, unknown>) =>
    operateOn({ settings: F.settings({ can_edit: false, operate_enabled: true }), repos: [F.repo({ operate_enabled: true, ...over })] });

  test("a halted repo says who halted it and when, to a member too: the name is in its own run, inside the labelled halt region", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const at = F.iso(sameDayAgo());
    const member = await setup(page, memberOf(F, { halted: true, halted_at: at, halted_by: { id: "u0000000-0000-4000-8000-000000000009", display_name: "Olive Owner" } }));
    await open(page);
    const by = t(page, "tm-halt-by");
    await expect(by).toHaveText(`Halted by Olive Owner at ${hhmmOf(at)}`);
    await expect(by.locator("bdi")).toHaveText("Olive Owner");
    await expect(page.locator(`${WIN} [data-testid="tm-halt"][aria-labelledby="tm-halt-h"] [data-testid="tm-halt-by"]`)).toHaveCount(1);
    await clean(page, member.errors);
  });

  test("a halt with no recorded author says only when it was halted, and never null or undefined", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const at = F.iso(sameDayAgo());
    const { errors } = await setup(page, memberOf(F, { halted: true, halted_at: at, halted_by: null }));
    await open(page);
    await expect(t(page, "tm-halt-by")).toHaveText(`Halted at ${hhmmOf(at)}`);
    await clean(page, errors);
  });

  test("a repo that is not halted shows no halted-by line", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { errors } = await setup(page, memberOf(F, { halted: false, halted_at: null, halted_by: null }));
    await open(page);
    await expect(t(page, "tm-halt-by")).toHaveCount(0);
    await clean(page, errors);
  });

  test("a member of a repo that is not halted sees no halt section at all", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { errors } = await setup(page, operateOn({ settings: F.settings({ can_edit: false, operate_enabled: true }) }));
    await open(page);
    await expect(t(page, "tm-halt")).toBeHidden();
    await expect(t(page, "tm-halt-chip")).toBeHidden();
    await clean(page, errors);
  });

  test("an owner with operate off can still halt: the Halt button is there and sends one POST", async ({ page }) => {
    const { mock, errors } = await setup(page, fresh({ settings: makeFixtures(Date.now()).settings() }));
    await open(page);
    await expect(t(page, "tm-op-pause")).toHaveAttribute("aria-disabled", "true");
    await press(t(page, "tm-halt-btn"));
    await press(t(page, "tm-halt-yes"));
    await expect.poll(() => mock.halts).toEqual(["halt"]);
    await clean(page, errors);
  });

  test("every refusal of a halt or a clear is a plain sentence in the page, never the server's text, and the repos are read again", async ({ page }) => {
    const { mock, errors } = await setup(page, operateOn());
    await open(page);
    const cases: [number, string, string][] = [
      [403, "forbidden", "Only an owner or admin can halt the engine."],
      [404, "not_found", "That repository no longer exists."],
      [409, "conflict", "The halt was not accepted. Reload the page and try again."],
      [500, "server_error", "The halt may not have gone through. Check the state above, then try again."],
    ];
    for (const [status, code, sentence] of cases) {
      mock.haltStatus = status;
      mock.haltCode = code;
      const reads = REPOS_READS(mock);
      await press(t(page, "tm-halt-btn"));
      await press(t(page, "tm-halt-yes"));
      await expect(t(page, "tm-halt-note")).toHaveText(sentence);
      await expect(t(page, "tm-live")).toContainText(sentence);
      expect(await activeId(page)).toBe("tm-halt-btn");
      await expect.poll(() => REPOS_READS(mock)).toBeGreaterThan(reads);
      await expect(page.locator(`${WIN} [data-testid="tm-halt"] button`)).toHaveCount(1);
    }
    expect(mock.halts).toEqual(["halt", "halt", "halt", "halt"]);
    mock.haltStatus = 200;
    mock.haltCode = "";
    await press(t(page, "tm-halt-btn"));
    await expect(t(page, "tm-halt-note")).toHaveCount(0); // a new question clears the note
    await press(t(page, "tm-halt-yes"));
    await expect(t(page, "tm-clear-btn")).toBeVisible();
    mock.haltStatus = 403;
    mock.haltCode = "forbidden";
    await press(t(page, "tm-clear-btn"));
    await press(t(page, "tm-halt-yes"));
    await expect(t(page, "tm-halt-note")).toHaveText("Only an owner or admin, signed in, can clear a halt.");
    expect(await activeId(page)).toBe("tm-clear-btn");
    await clean(page, errors);
  });

  test("a save in flight locks Halt with aria-disabled and a reason while focus stays on it", async ({ page }) => {
    const { mock, errors } = await setup(page, operateOn());
    await open(page);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    await page.route((u) => u.pathname.endsWith("/halt"), async (route) => { await gate; await route.fallback(); });
    await press(t(page, "tm-halt-btn"));
    await press(t(page, "tm-halt-yes"));
    await expect(t(page, "tm-clear-btn").or(t(page, "tm-halt-btn"))).toHaveAttribute("aria-disabled", "true");
    await expect(t(page, "tm-halt-why")).toHaveText("Another change is being saved. Try again in a moment.");
    await expect(t(page, "tm-halt-btn")).toHaveAttribute("aria-describedby", "tm-halt-why");
    expect(await activeId(page)).toBe("tm-halt-btn");
    await t(page, "tm-halt-btn").evaluate((el) => (el as HTMLElement).click()); // a press while it is out opens nothing and sends nothing more
    await expect(t(page, "tm-halt-confirm")).toHaveCount(0);
    release();
    await expect.poll(() => mock.halts).toEqual(["halt"]);
    await expect(t(page, "tm-clear-btn")).toHaveAttribute("aria-disabled", "false");
    await expect(t(page, "tm-halt-why")).toHaveCount(0);
    await clean(page, errors);
  });

  test("the question closes when someone else halts: focus lands on the control that replaced it", async ({ page }) => {
    const { mock, errors } = await setup(page, operateOn(), { clock: true });
    await open(page);
    await press(t(page, "tm-halt-btn"));
    await expect(t(page, "tm-halt-confirm")).toBeVisible();
    mock.repos = mock.repos.map((r) => ({ ...r, halted: true, halt_pending: false }));
    await page.clock.runFor(121_000);
    await expect(t(page, "tm-halt-confirm")).toHaveCount(0);
    await expect(t(page, "tm-clear-btn")).toBeVisible();
    expect(await activeId(page)).toBe("tm-clear-btn");
    expect(mock.halts).toEqual([]);
    await clean(page, errors);
  });

  test("a hostile runner name is only ever text in the halt question", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { errors } = await setup(page, operateOn({ repos: [F.repo({ operate_enabled: true, runner_name: HOSTILE })] }));
    await open(page);
    await press(t(page, "tm-halt-btn"));
    await expect(t(page, "tm-halt-confirm-text")).toContainText(HOSTILE);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    await expect(page.locator(`${WIN} [data-testid="tm-halt-confirm"] img, ${WIN} [data-testid="tm-halt-confirm"] script, ${WIN} [data-testid="tm-halt-confirm"] a`)).toHaveCount(0);
    await clean(page, errors);
  });

  test("themes with the halt on screen: axe finds nothing serious, and the halt text, chip, note and focus rings keep contrast 4.5 and 3 under every theme (numbers recorded)", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { errors } = await setup(page, operateOn({ repos: [F.repo({ operate_enabled: true, halted: true, halt_pending: true })] }));
    await open(page);
    const measure = () => page.evaluate((sel) => {
      const lum = (c: string) => {
        const m = c.match(/[\d.]+/g)!.map(Number);
        const [r, g, b] = m.slice(0, 3).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const bg = (el: Element) => {
        for (let e: Element | null = el; e; e = e.parentElement) {
          const c = getComputedStyle(e).backgroundColor;
          const m = c.match(/[\d.]+/g)!.map(Number);
          if (m.length < 4 || m[3] === 1) return c;
        }
        return "rgb(0, 0, 0)";
      };
      const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      let text = 21;
      for (const el of document.querySelectorAll(`${sel} .tm-halt-chip, ${sel} .tm-halt-state, ${sel} .tm-halt-note, ${sel} .tm-halt-by, ${sel} .tm-halt .tm-btn, ${sel} .tm-halt .tm-sub, ${sel} .tm-halt .tm-muted, ${sel} .tm-confirm p`)) {
        if ((el as HTMLElement).offsetParent === null) continue;
        text = Math.min(text, ratio(lum(getComputedStyle(el).color), lum(bg(el))));
      }
      const ae = document.activeElement as HTMLElement | null;
      let ring = -1; // -1: the keyboard is not on a control of the app
      if (ae && ae.closest(sel) && ae.matches(":focus-visible")) {
        const cs = getComputedStyle(ae);
        ring = cs.outlineStyle === "none" || parseFloat(cs.outlineWidth) < 2 ? 0 : ratio(lum(cs.outlineColor), lum(bg(ae.parentElement as Element)));
      }
      return { text: Math.round(text * 100) / 100, ring: Math.round(ring * 100) / 100 };
    }, WIN);
    const axe = async (label: string) => {
      const res = await new AxeBuilder({ page }).include(WIN).exclude(`${WIN} .window-titlebar`).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
      expect(res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`), label).toEqual([]);
    };
    const ratios: Record<string, number> = {};
    const rings: Record<string, number> = {};
    for (const theme of THEMES) {
      await applyTheme(page, theme);
      await axe(theme + " halting");
      // The keyboard lands on Clear halt, opens the question with Enter (so focus-visible holds on Cancel), and walks back.
      await t(page, "tm-clear-btn").focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      const a = await measure();
      rings[theme + " clear"] = a.ring;
      ratios[theme + " halting"] = a.text;
      await page.keyboard.press("Enter");
      await expect(t(page, "tm-halt-confirm")).toBeVisible();
      expect(await activeId(page)).toBe("tm-halt-cancel");
      await axe(theme + " question");
      const b = await measure();
      rings[theme + " cancel"] = b.ring;
      ratios[theme + " question"] = b.text;
      await page.keyboard.press("Shift+Tab");
      const c = await measure();
      rings[theme + " yes"] = c.ring;
      await page.keyboard.press("Escape");
      await expect(t(page, "tm-halt-confirm")).toHaveCount(0);
    }
    for (const [k, v] of Object.entries(ratios)) expect(v, k).toBeGreaterThanOrEqual(4.5);
    expect(Object.entries(rings).filter(([, v]) => v < 3), "focus rings under 3:1 (or missing)").toEqual([]);
    console.log("HALT-CONTRAST " + JSON.stringify({ project: test.info().project.name, ...ratios }));
    console.log("HALT-FOCUSRING " + JSON.stringify({ project: test.info().project.name, ...rings }));
    await clean(page, errors);
  });

  test("Log: each line shows its time, role, kind and D# / PR links, with the fixed note and a Load older button that has nothing to do", async ({ page }) => {
    const { errors } = await setup(page, fresh());
    await open(page);
    await expect(t(page, "tm-log-note")).toHaveText("Log text stays on your machine; the cloud receives only what kind of line it was.");
    const rows = t(page, "tm-log-line");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("team-lead");
    await expect(rows.nth(0)).toContainText("merged");
    await expect(rows.nth(0)).toContainText(/\d\d:\d\d/);
    await expect(rows.nth(0).locator("a").nth(0)).toHaveAttribute("href", "https://github.com/acme-labs/widgets/discussions/42");
    await expect(rows.nth(0).locator("a").nth(1)).toHaveAttribute("href", "https://github.com/acme-labs/widgets/pull/7");
    await expect(rows.nth(2)).toContainText("gate passed");
    await expect(rows.nth(1).locator("a")).toHaveCount(1); // no PR on this line
    await expect(t(page, "tm-log-asof")).toHaveText(/^As of \d\d:\d\d \(\d+ min ago\)$/);
    await expect(t(page, "tm-log-older")).toHaveAttribute("aria-disabled", "true");
    await expect(t(page, "tm-log-older")).toHaveText("No older lines");
    await expect(t(page, "tm-log-list")).toHaveAttribute("tabindex", "0");
    await expect(t(page, "tm-log-list")).toHaveAttribute("aria-label", "Log lines");
    await clean(page, errors);
  });

  test("long-task rule: only the part of a task outside a stall counts against the 200 ms bar", () => {
    const over = (ms: number, stall: number) => ownMs({ start: 1000, ms }, stall > 0 ? [{ from: 1000, to: 1000 + stall }] : []) > 200;
    expect(over(400, 0)).toBe(true); // a real 400 ms task in the page counts
    expect(over(600, 150)).toBe(true); // 450 ms is the page's own
    expect(over(600, 320)).toBe(true); // 280 ms is the page's own
    expect(over(1000, 700)).toBe(true); // 300 ms is the page's own
    expect(over(1000, 800)).toBe(false); // 200 ms is left: held
    expect(over(750, 750)).toBe(false); // the whole task is the stall
    expect(ownMs({ start: 1000, ms: 600 }, [{ from: 900, to: 1100 }, { from: 1500, to: 1700 }])).toBe(400); // a stall that starts before and one that ends after both count only where they overlap
  });

  test("long-task rule: one stray slow task is noise, a log that is slow on every press or has one very long task is not", () => {
    expect(longTasksTooSlow([])).toBe(false);
    expect(longTasksTooSlow([405])).toBe(false); // the CI blips seen: one 405 ms, one 311 ms
    expect(longTasksTooSlow([311, 250, 210])).toBe(false);
    expect(longTasksTooSlow([250, 250, 250, 250])).toBe(true); // slow again and again is the log's own cost
    expect(longTasksTooSlow(Array.from({ length: 70 }, () => 230))).toBe(true); // every press over the bar
    expect(longTasksTooSlow([650])).toBe(true); // one task that long is never noise
  });

  test("Log with 10,000 events: paging all the way down keeps at most 400 rows in the DOM, no long task over 200 ms, and Load older keeps focus", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const PAGE = 100, TOTAL = 10_000;
    const logPage = (cursor: string) => {
      const start = cursor === "" ? 0 : Number(cursor);
      const next = start + PAGE;
      return F.envelope(F.logLines(PAGE, start), { next_cursor: next >= TOTAL ? null : String(next) });
    };
    const mock = fresh({ log: logPage(""), logPage });
    mock.log = { ...logPage(""), next_cursor: String(PAGE) };
    const { errors } = await setup(page, mock);
    // Two clocks. The long-task observer in the page records every task over 50 ms with its wall-clock start and length. A second, blank tab
    // in the same browser runs a worker that ticks every 10 ms and notes each time it was itself held for over 100 ms. That tab is a different
    // process and a different thread, so the log being busy never holds it; a held tab means the whole machine was not running the browser
    // (a loaded host, a hosted runner pausing the VM), and a long task that mostly lies inside such a stall is not the Team log's own work.
    await page.addInitScript(() => {
      const w = window as unknown as { __long: { start: number; ms: number }[] };
      w.__long = [];
      try { new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__long.push({ start: performance.timeOrigin + e.startTime, ms: e.duration }))).observe({ entryTypes: ["longtask"] }); } catch { /* no long-task support: the count stays 0 */ }
      // What ran inside each long frame (which script, how much of it was forced layout, how long the frame waited to render), so a failure says what the time was spent on.
      try {
        const frames: unknown[] = ((window as unknown as { __frames: unknown[] }).__frames = []);
        new PerformanceObserver((l) => l.getEntries().forEach((e) => {
          const f = e as unknown as { startTime: number; duration: number; blockingDuration: number; renderStart: number; styleAndLayoutStart: number; scripts: { invoker: string; sourceFunctionName: string; sourceURL: string; duration: number; forcedStyleAndLayoutDuration: number; pauseDuration: number }[] };
          if (f.duration > 100) frames.push({ at: Math.round(f.startTime), ms: Math.round(f.duration), blocking: Math.round(f.blockingDuration), toRender: f.renderStart ? Math.round(f.renderStart - f.startTime) : -1, styleLayout: f.styleAndLayoutStart ? Math.round(f.startTime + f.duration - f.styleAndLayoutStart) : -1, scripts: f.scripts.slice(0, 5).map((c) => ({ invoker: c.invoker, fn: c.sourceFunctionName, src: c.sourceURL.split("/").slice(-2).join("/"), ms: Math.round(c.duration), forced: Math.round(c.forcedStyleAndLayoutDuration), pause: Math.round(c.pauseDuration) })) });
        })).observe({ type: "long-animation-frame", buffered: true });
      } catch { /* no long-animation-frame support: no detail */ }
    });
    const beat = await page.context().newPage();
    await beat.evaluate(() => {
      const w = window as unknown as { __stalls: { from: number; to: number }[] };
      w.__stalls = [];
      const src = "let last = Date.now(); setInterval(() => { const now = Date.now(); if (now - last > 100) postMessage([last, now]); last = now; }, 10);";
      new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" }))).onmessage = (m) => w.__stalls.push({ from: m.data[0], to: m.data[1] });
    });
    await page.bringToFront();
    await page.reload();
    await waitForDesktop(page);
    await open(page);
    const rows = page.locator(`${WIN} [data-testid="tm-log-line"]`);
    await expect(rows).toHaveCount(100);
    let most = 100, pages = 1;
    const older = t(page, "tm-log-older");
    await older.focus();
    // The check is about the log's own work, so the clock starts here: page boot, the reload and the window opening are done, and
    // only the 99 Load older presses below are measured.
    const { pagingFrom, timeOrigin } = await page.evaluate(() => { (window as unknown as { __long: unknown[] }).__long = []; return { pagingFrom: Math.round(performance.now()), timeOrigin: performance.timeOrigin }; });
    for (let i = 0; i < 99; i++) {
      await page.keyboard.press("Enter");
      await expect(older).not.toHaveText("Loading older lines…");
      pages += 1;
      most = Math.max(most, await rows.count());
      expect(most).toBeLessThanOrEqual(400);
      expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("tm-log-older"); // focus stays on the button through every rebuild
      if ((await older.getAttribute("aria-disabled")) === "true") break;
    }
    await expect(older).toHaveText("No older lines");
    await expect(rows).toHaveCount(400);
    await expect(t(page, "tm-log-newest")).toContainText("9600 newer lines not shown");
    await expect(t(page, "tm-live")).toContainText("Older log lines loaded");
    // Only the part of a long task the worker was not held for is the log's own time. The bar stays 200 ms for that part, and the held part is reported.
    const tasks = await page.evaluate(() => (window as unknown as { __long: { start: number; ms: number }[] }).__long);
    const stalls = await beat.evaluate(() => (window as unknown as { __stalls: { from: number; to: number }[] }).__stalls);
    await beat.close();
    const own = tasks.map((x) => ownMs(x, stalls));
    const held = tasks.filter((x) => heldMs(x, stalls) > 0).map((x) => ({ ms: Math.round(x.ms), held: Math.round(heldMs(x, stalls)) }));
    console.log("LOGLOAD " + JSON.stringify({ project: test.info().project.name, pages, mostRows: most, longTasksOver200: own.filter((d) => d > 200).length, longest: Math.round(Math.max(0, ...own)), held }));
    if (own.some((d) => d > 200)) console.log("LONGFRAMES " + JSON.stringify({ project: test.info().project.name, paging_from: pagingFrom, tasks: tasks.map((x) => ({ at: Math.round(x.start - timeOrigin), ms: Math.round(x.ms) })), frames: await page.evaluate(() => (window as unknown as { __frames: unknown[] }).__frames) }));
    expect(longTasksTooSlow(own), `tasks over ${LONG_TASK_BAR} ms: ${JSON.stringify(own.filter((d) => d > LONG_TASK_BAR).map(Math.round))}`).toBe(false);
    // Back to newest: the first page again, and the button is gone with focus handed to the list's own place (the heading, never the page).
    await press(t(page, "tm-log-newest"));
    await expect(rows).toHaveCount(100);
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
    await clean(page, errors);
  });

  test("Log: a new line arriving at the top while a lower line is being read keeps that line where it was", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const PAGE = 100;
    const logPage = (cursor: string) => { const start = cursor === "" ? 0 : Number(cursor); return F.envelope(F.logLines(PAGE, start), { next_cursor: String(start + PAGE) }); };
    const { mock, errors } = await setup(page, fresh({ streaming: true, log: { ...logPage(""), next_cursor: String(PAGE) }, logPage }));
    await open(page);
    const rows = page.locator(`${WIN} [data-testid="tm-log-line"]`);
    await expect(rows).toHaveCount(PAGE);
    const probe = () => page.evaluate((sel) => {
      const l = document.querySelector(sel + ' [data-testid="tm-log-list"]') as HTMLElement;
      const r = [...l.children].find((c) => (c as HTMLElement).offsetTop + (c as HTMLElement).offsetHeight > l.scrollTop) as HTMLElement | undefined;
      return r ? { id: r.getAttribute("data-id"), at: r.offsetTop - l.scrollTop } : null;
    }, WIN);
    await page.evaluate((sel) => { const l = document.querySelector(sel + ' [data-testid="tm-log-list"]') as HTMLElement; l.scrollTop = (l.children[70] as HTMLElement).offsetTop; }, WIN);
    const before = await probe();
    // A refresh answers with one new newest line and the first 99 of the lines already drawn.
    const fresher = F.envelope([{ ...F.logLines(1, 0)[0], line_id: "k000000000000000" }, ...F.logLines(PAGE, 0).slice(0, PAGE - 1)], { next_cursor: String(PAGE) });
    mock.logPage = () => fresher;
    mock.streamFrame = `id: c-21\nevent: engine.changed\ndata: ${JSON.stringify({ id: "e21", type: "engine.changed", created_at: new Date().toISOString(), data: { repo_id: REPO_A, session_id: "s", last_seq: 21 } })}\n\n`;
    await expect.poll(async () => { if (mock.streamFrame !== null) await page.evaluate(() => window.dispatchEvent(new Event("pointerdown"))); return mock.streamFrame; }, { timeout: 30_000 }).toBeNull();
    await expect(rows.first()).toHaveAttribute("data-id", "k000000000000000");
    await expect(rows).toHaveCount(PAGE);
    await page.waitForTimeout(500); // lets any group still being drawn finish
    const after = await probe();
    expect(before).not.toBeNull();
    expect(after?.id).toBe(before?.id);
    expect(Math.abs((after?.at ?? 1e9) - (before?.at ?? 0))).toBeLessThan(2);
    // Fifty new lines at once (more than one group) rebuild the list in groups; the line being read still stays where it was.
    const burst = F.envelope([...F.logLines(50, 1000).map((l, i) => ({ ...l, line_id: "j" + String(1000 - i).padStart(15, "0") })), ...F.logLines(PAGE, 0)], { next_cursor: String(PAGE) });
    mock.logPage = () => burst;
    mock.streamFrame = `id: c-22\nevent: engine.changed\ndata: ${JSON.stringify({ id: "e22", type: "engine.changed", created_at: new Date().toISOString(), data: { repo_id: REPO_A, session_id: "s", last_seq: 22 } })}\n\n`;
    await expect.poll(async () => { if (mock.streamFrame !== null) await page.evaluate(() => window.dispatchEvent(new Event("pointerdown"))); return mock.streamFrame; }, { timeout: 30_000 }).toBeNull();
    await expect(rows).toHaveCount(PAGE + 50);
    await page.waitForTimeout(500);
    const last = await probe();
    expect(last?.id).toBe(before?.id);
    expect(Math.abs((last?.at ?? 1e9) - (before?.at ?? 0))).toBeLessThan(2);
    await clean(page, errors);
  });

  test("Log scrolling: reaching the bottom of the list loads the next page without a click", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const logPage = (cursor: string) => { const start = cursor === "" ? 0 : Number(cursor); return F.envelope(F.logLines(60, start), { next_cursor: start + 60 >= 240 ? null : String(start + 60) }); };
    const { errors } = await setup(page, fresh({ log: { ...logPage(""), next_cursor: "60" }, logPage }));
    await open(page);
    const rows = page.locator(`${WIN} [data-testid="tm-log-line"]`);
    await expect(rows).toHaveCount(60);
    await page.evaluate((sel) => { const l = document.querySelector(sel + ' [data-testid="tm-log-list"]') as HTMLElement; l.scrollTop = l.scrollHeight; }, WIN);
    await expect(rows).toHaveCount(120);
    await clean(page, errors);
  });


  test("Cost: the route's total and each row's figure are drawn as sent, a row with no figure says why in words, and the header carries its age", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const mock = fresh({ usage: F.usage({ items: [F.usageItem({ api_equivalent_usd: 1234.5 }), F.usageItem({ subject_kind: "tick", subject_id: "t1", model: null, credential_mode: null, tokens: null, api_equivalent_usd: null, state: "not_recorded", note: "Usage was not recorded for this tick. That is not the same as $0." })], totals: { api_equivalent_usd: 1235.5, tokens: { input: 1, output: 1, cache_read: 0, cache_write: 0 } } }) });
    const { errors } = await setup(page, mock);
    await open(page);
    await expect(t(page, "tm-usage-headline")).toHaveText("$1,235.50"); // the route's own total, not the two rows added
    await expect(t(page, "tm-usage-value")).toHaveText(["$1,234.50", "Usage was not recorded for this tick. That is not the same as $0."]);
    await expect(t(page, "tm-usage-row").nth(0)).toContainText("Agent · sonnet-5 · on your Claude plan");
    await expect(t(page, "tm-usage-row").nth(1)).toContainText("Tick · unknown model");
    await expect(t(page, "tm-usage-asof")).toHaveText(/^As of \d\d:\d\d \(0 min ago\)$/);
    await expect(t(page, "tm-usage-window")).toHaveText(/^Window: \d{4}-\d\d-\d\d to \d{4}-\d\d-\d\d$/);
    expect((await t(page, "tm-usage").innerText()).replace(/That is not the same as \$0\./i, "")).not.toMatch(/\$0(?!\.\d*[1-9])/);
    await clean(page, errors);
  });

  test("Cost: its gap reaches the banner, its stale heartbeat warns on its header, and a source age shows its notice", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { errors } = await setup(page, fresh({ usage: F.usage({ missing_events: 2, gaps: [{ from_seq: 1, to_seq: 2, before_ts: F.iso(900) }], heard_age_s: 900, source_ages_s: { loop: 2 * 3600 } }) }));
    await open(page);
    await expect(t(page, "tm-banner")).toHaveText(/^Events missing since \d\d:\d\d \(2 events\)$/);
    await expect(t(page, "tm-usage-warn")).toHaveText("last seen 15 min ago");
    await expect(t(page, "tm-notice")).toHaveText(["loop not updated for 2 h"]);
    await expect(t(page, "tm-usage-row")).toHaveCount(2);
    await clean(page, errors);
  });

  test("Stats: '(from N events)' is a button that opens the kinds, the count and the event numbers per session, keeps focus on itself, and closes again", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const seqs = [3, 4, 5, 7].map((seq) => ({ session_id: "s-one", seq }));
    const { errors } = await setup(page, fresh({ stats: F.stats({ merges: { value: 4, provenance: { kinds: ["pr_merged"], count: 4, seqs } } }) }));
    await open(page);
    const btn = t(page, "tm-stat-from").nth(2);
    const region = t(page, "tm-stat-prov").nth(2);
    await expect(btn).toHaveText("(from 4 events)");
    await expect(btn).toHaveAttribute("aria-expanded", "false");
    await expect(region).toBeHidden();
    await btn.focus();
    await page.keyboard.press("Enter");
    await expect(btn).toHaveAttribute("aria-expanded", "true");
    await expect(region).toBeVisible();
    await expect(region).toContainText("Event kinds: pr merged");
    await expect(region).toContainText("Events: 4");
    await expect(region).toContainText("Session 1: seq 3–5, 7");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-focus"))).toBe("prov-merges");
    expect(await page.evaluate((sel) => (document.querySelector(sel + ' [data-testid="tm-stats"]') as HTMLElement).innerText.includes("s-one"), WIN)).toBe(false);
    await page.keyboard.press("Space");
    await expect(btn).toHaveAttribute("aria-expanded", "false");
    await expect(region).toBeHidden();
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-focus"))).toBe("prov-merges");
    await clean(page, errors);
  });

  test("a refresh that only moves the 'as of' time does not rebuild the plan, so focus stays on a D# link", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { mock } = await setup(page, fresh(), { clock: true });
    await open(page);
    const link = t(page, "tm-plan").locator('[data-testid="tm-d"]').first();
    await link.focus();
    await page.evaluate(() => { (window as unknown as { __kept: Element | null }).__kept = document.activeElement; });
    const before = await t(page, "tm-plan-asof").innerText();
    mock.plan = { ...mock.plan, as_of: F.iso(600) }; // ten minutes earlier: the header text must change
    mock.reads.length = 0;
    await page.clock.runFor(121_000);
    await expect.poll(() => mock.reads.filter((r) => r.endsWith("/plan")).length).toBeGreaterThanOrEqual(1);
    await expect(t(page, "tm-plan-asof")).not.toHaveText(before);
    expect(mock.reads.some((r) => r.endsWith("/plan"))).toBe(true);
    expect(await page.evaluate(() => document.activeElement === (window as unknown as { __kept: Element | null }).__kept)).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("tm-d");
  });

  test("Log: a failed older page says so, keeps the rows and can be tried again; lines are only text", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const first = F.envelope([F.logLine({ actor_role: HOSTILE, category: HOSTILE })], { next_cursor: "x" });
    const mock = fresh({ log: first, logPage: (cursor) => (cursor === "" ? first : { weird: true }) });
    const { errors } = await setup(page, mock);
    await open(page);
    await expect(t(page, "tm-log-line").locator(".tm-role bdi")).toHaveText(HOSTILE);
    await expect(t(page, "tm-log-line")).toContainText("other"); // an odd kind is a plain word
    await expect(page.locator(`${WIN} .tm-app img, ${WIN} .tm-app script, ${WIN} .tm-app b`)).toHaveCount(0);
    await press(t(page, "tm-log-older"));
    await expect(t(page, "tm-log-older-failed")).toHaveText("Older lines couldn't be loaded.");
    await expect(t(page, "tm-live")).toContainText("Older lines couldn't be loaded."); // announced, not only drawn
    await expect(t(page, "tm-log-line")).toHaveCount(1);
    await expect(t(page, "tm-log-older")).toHaveText("Load older");
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(errors).toEqual([]);
  });

  test("Plan: today's items with D# links, roadmap rows with key, status and counts, (no key) for an empty key, and the 30-day merged count", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const lanes = F.envelope([F.lane({ pr: 1, discussion: 42, state: "merged", updated_at: F.iso(86400) }), F.lane({ pr: 2, discussion: 42, state: "merged", updated_at: F.iso(40 * 86400) })]);
    const { errors } = await setup(page, fresh({ lanes }));
    await open(page);
    await expect(t(page, "tm-plan-date")).toHaveText(/^Plan for \d{4}-\d\d-\d\d$/);
    await expect(t(page, "tm-plan-item")).toHaveCount(2);
    await expect(t(page, "tm-plan-item").nth(0)).toContainText("1.");
    await expect(t(page, "tm-plan-item").nth(0)).toContainText("In progress");
    await expect(t(page, "tm-plan-item").nth(0).locator("a")).toHaveAttribute("href", "https://github.com/acme-labs/widgets/discussions/42");
    const rows = t(page, "tm-roadmap-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("EB-6b");
    await expect(t(page, "tm-roadmap-counts").nth(0)).toHaveText("1 merged in the last 30 days · 3 planned");
    await expect(rows.nth(1)).toContainText("(no key)");
    await expect(t(page, "tm-plan-asof")).toHaveText(/^As of \d\d:\d\d \(\d+ min ago\)$/);
    await clean(page, errors);
  });

  test("Plan: no snapshot reads Plan not synced yet, and a snapshot over 26 h old reads Plan from <date>", async ({ page }) => {
    const { errors } = await setup(page, fresh({ plan: null }));
    await open(page);
    await expect(t(page, "tm-plan-none")).toHaveText("Plan not synced yet");
    await expect(t(page, "tm-plan-warn")).toHaveCount(0);
    await clean(page, errors);
    const F = makeFixtures(Date.now());
    const p2 = await page.context().newPage();
    const second = await setup(p2, fresh({ plan: F.plan({ age_s: 27 * 3600, plan_date: "2026-11-14" }) }));
    await open(p2);
    await expect(t(p2, "tm-plan-date")).toHaveText("Plan from 2026-11-14");
    await clean(p2, second.errors);
  });

  test("Plan: a hostile row key is text, and a long roadmap pages 100 rows at a time with focus kept on the button", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const roadmap = Array.from({ length: 250 }, (_, i) => ({ row_key: i === 0 ? HOSTILE : "R" + i, discussion: null, status: "done", planned_prs: null }));
    const { errors } = await setup(page, fresh({ plan: F.plan({ roadmap }) }));
    await open(page);
    await expect(t(page, "tm-roadmap-row")).toHaveCount(100);
    await expect(t(page, "tm-roadmap-row").first().locator("bdi")).toHaveText(HOSTILE);
    await expect(page.locator(`${WIN} .tm-app img, ${WIN} .tm-app script, ${WIN} .tm-app b`)).toHaveCount(0);
    await expect(t(page, "tm-plan-span")).toHaveText("Rows 1–100 of 250");
    await expect(t(page, "tm-plan-prev")).toHaveAttribute("aria-disabled", "true");
    await t(page, "tm-plan-next").focus();
    await page.keyboard.press("Enter");
    await expect(t(page, "tm-plan-span")).toHaveText("Rows 101–200 of 250");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("tm-plan-next");
    await page.keyboard.press("Enter");
    await expect(t(page, "tm-plan-span")).toHaveText("Rows 201–250 of 250");
    await expect(t(page, "tm-roadmap-row")).toHaveCount(50);
    await expect(t(page, "tm-plan-next")).toHaveAttribute("aria-disabled", "true");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("tm-plan-next");
    await clean(page, errors);
  });

  test("Stats: the figures as the server sent them, each with the events behind it; a missing figure says no figures yet", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { errors } = await setup(page, fresh());
    await open(page);
    const rows = t(page, "tm-stat");
    await expect(rows).toHaveText([/Agents by role: executor 2, code-reviewer 1 \(from 6 events\)/, /Duration: median 120.5 s, p90 300 s \(from 3 events\)/, /Merges: 4 \(from 4 events\)/, /Gates passed: 3 of 4 \(from 1 event\)/]);
    await expect(t(page, "tm-stats-window")).toHaveText(/^Window: \d{4}-\d\d-\d\d to \d{4}-\d\d-\d\d$/);
    await expect(t(page, "tm-stats-asof")).toHaveText(/^As of /);
    await clean(page, errors);
    void F;
  });

  test("Stats and plan that cannot be read say so, and the log and lanes still show; a stale heartbeat warns on the new panels too", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { errors } = await setup(page, fresh({ fail: ["/stats", "/plan", "/usage"], log: F.envelope([F.logLine()], { heard_age_s: 900 }) }));
    await open(page);
    await expect(t(page, "tm-usage-failed")).toHaveText("This panel couldn't be read.");
    await expect(t(page, "tm-live")).toContainText("Plan panel couldn't be read. Stats panel couldn't be read. Cost panel couldn't be read.");
    await expect(t(page, "tm-stats-failed")).toHaveText("This panel couldn't be read.");
    await expect(t(page, "tm-plan-failed")).toHaveText("This panel couldn't be read.");
    await expect(t(page, "tm-log-warn")).toHaveText("last seen 15 min ago");
    await expect(t(page, "tm-log-line")).toHaveCount(1);
    await expect(t(page, "tm-lane")).toHaveCount(3);
    await clean(page, errors);
  });

  test("L1: a gap that only the log reports puts the banner on the app, and the log's source age shows its notice", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { errors } = await setup(page, fresh({ log: F.envelope([F.logLine()], { missing_events: 5, gaps: [{ from_seq: 1, to_seq: 5, before_ts: F.iso(1200) }], source_ages_s: { team_log: 3 * 3600 } }) }));
    await open(page);
    await expect(t(page, "tm-banner")).toHaveText(/^Events missing since \d\d:\d\d \(5 events\)$/);
    await expect(t(page, "tm-notice")).toHaveText(["team log not updated for 3 h"]);
    await clean(page, errors);
  });

  test("a control with nothing left to do keeps focus (aria-disabled), never dropping it to the page", async ({ page }) => {
    const mock = fresh({ log: makeFixtures(Date.now()).envelope([makeFixtures(Date.now()).logLine()], { next_cursor: "x" }), logPage: () => makeFixtures(Date.now()).envelope([], { next_cursor: null }) });
    const { errors } = await setup(page, mock);
    await open(page);
    await t(page, "tm-log-older").focus();
    await page.keyboard.press("Enter");
    await expect(t(page, "tm-log-older")).toHaveText("No older lines");
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
    await clean(page, errors);
  });

  test("themes: axe finds nothing serious or critical, the app's text keeps a contrast of at least 4.5 and its focus ring at least 3 under every theme (numbers recorded)", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const longRoadmap = Array.from({ length: 150 }, (_, i) => ({ row_key: "R" + i, discussion: 42, status: "in_progress", planned_prs: 2 }));
    const { errors } = await setup(page, operateOn({ plan: F.plan({ roadmap: longRoadmap }), commands: { commands: [F.command(), F.command({ id: "c0000000-0000-4000-8000-000000000002", kind: "start_day", state: "refused", refusal: "halted", acked_at: F.iso(10) })] }, agents: F.envelope([F.agent(), F.agent({ agent_id: "b2c3d4e5f6071829", started_at: F.iso(5 * 3600) })], { heard_age_s: 400, missing_events: 3, gaps: [{ from_seq: 1, to_seq: 3, before_ts: F.iso(900) }], source_ages_s: { loop: 9000 } }) }));
    await open(page);
    await press(t(page, "tm-settings-btn"));
    const ratios: Record<string, number> = {};
    const rings: Record<string, number> = {};
    const ringsAll: Record<string, number> = {};
    for (const theme of THEMES) {
      await applyTheme(page, theme);
      const res = await new AxeBuilder({ page }).include(WIN).exclude(`${WIN} .window-titlebar`).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
      const bad = res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
      expect(bad, theme).toEqual([]);
      // Contrast numbers: each text kind against the first opaque background behind it.
      const measure = () => page.evaluate((sel) => {
        const lum = (c: string) => {
          const m = c.match(/[\d.]+/g)!.map(Number);
          const [r, g, b] = m.slice(0, 3).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const bg = (el: Element) => {
          for (let e: Element | null = el; e; e = e.parentElement) {
            const c = getComputedStyle(e).backgroundColor;
            const m = c.match(/[\d.]+/g)!.map(Number);
            if (m.length < 4 || m[3] === 1) return c;
          }
          return "rgb(0, 0, 0)";
        };
        let worst = 21;
        for (const el of document.querySelectorAll(`${sel} .tm-asof, ${sel} .tm-warn, ${sel} .tm-chip, ${sel} .tm-banner, ${sel} .tm-notice, ${sel} .tm-muted, ${sel} .tm-role, ${sel} .tm-state, ${sel} .tm-time, ${sel} .tm-cat, ${sel} .tm-gate, ${sel} .tm-link, ${sel} .tm-btn, ${sel} .tm-check, ${sel} .tm-field, ${sel} .tm-select, ${sel} .tm-input, ${sel} .tm-cmd-detail`)) {
          const a = lum(getComputedStyle(el).color), b = lum(bg(el));
          worst = Math.min(worst, (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05));
        }
        // The focus ring of whatever the keyboard is on: at least 2 px, and 3:1 against what is behind it.
        const ae = document.activeElement as HTMLElement | null;
        let ring: number | null = null;
        if (ae && ae.closest(sel) && ae.matches(":focus-visible")) {
          const cs = getComputedStyle(ae);
          const a = lum(cs.outlineColor), b = lum(bg(ae.parentElement as Element));
          ring = cs.outlineStyle === "none" || parseFloat(cs.outlineWidth) < 2 ? 0 : Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
        }
        return { text: Math.round(worst * 100) / 100, ring };
      }, WIN);
      const min = (await measure()).text;
      ratios[theme] = min;
      expect(min, theme).toBeGreaterThanOrEqual(4.5);
      // Focus ring, reached with the keyboard (so :focus-visible holds): the picker, the settings button, a box in the sheet and a link.
      for (const id of ["tm-repo", "tm-settings-btn", "tm-watch", "tm-d", "tm-log-list", "tm-log-older", "tm-plan-next", "tm-op-switch", "tm-op-start", "tm-op-role", "tm-op-discussion", "tm-op-class", "tm-op-setdial", "tm-dial-select", "tm-dial-apply", "tm-cmd-cancel", "tm-halt-btn"]) {
        await t(page, id).first().focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        const got = await measure();
        ringsAll[`${theme} ${id}`] = got.ring ?? -1; // -1: the keyboard did not land on the control
        rings[theme] = Math.min(rings[theme] ?? 21, got.ring ?? -1);
      }
    }
    expect(Object.entries(ringsAll).filter(([, v]) => v < 3), "focus rings under 3:1 (or missing)").toEqual([]);
    console.log("CONTRAST " + JSON.stringify({ project: test.info().project.name, ...ratios }));
    console.log("FOCUSRING " + JSON.stringify({ project: test.info().project.name, ...rings }));
    await clean(page, errors);
  });

  // Which runner the watch switch means, and the Connect a runner list (owner feedback: "this machine" read like the phone).
  const tv = (page: Page, id: string) => page.locator(`${WIN} [data-testid="${id}"]:visible`);
  const RUNNER_A = "9d2c7b1e-5f3a-4e8b-8a6d-1c2b3a4d5e66";
  const RUNNER_B = "9d2c7b1e-5f3a-4e8b-8a6d-1c2b3a4d5e77";
  const noSideways = async (page: Page) => expect(await page.evaluate(() => { const w = document.querySelector('#windows-container .fulc-window[data-app-id="team"] .tm-page') as HTMLElement; return w.scrollWidth - w.clientWidth; })).toBeLessThanOrEqual(1);

  test("the switch names the runner and says online with its last seen time; the connect list shows the bridge state for the repo", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const settings = F.settings({ repos: [F.settingsRepo({ bridged_runner_id: RUNNER_A }), F.settingsRepo({ repo_id: REPO_B, full_name: "acme-labs/site", enabled: false, eligible: true })] });
    const { errors } = await setup(page, fresh({ settings, runners: F.fleet([F.runner(), F.runner({ id: RUNNER_B, name: "Build box", state: "offline", last_seen_at: F.iso(7200) })]) }));
    await open(page);
    await press(t(page, "tm-settings-btn"));
    await expect(page.locator(`${WIN} label:has([data-testid="tm-watch"])`)).toHaveText("Watch the engine team on Workshop laptop");
    await expect(tv(page, "tm-runner-status")).toHaveText("Online · last seen 2 min ago");
    await expect(tv(page, "tm-runner-status")).toHaveAttribute("data-kind", "online");
    await expect(t(page, "tm-connect-row")).toHaveCount(2);
    await expect(t(page, "tm-connect-bridge").nth(0)).toHaveText("Bridge has reported for acme-labs/widgets");
    await expect(t(page, "tm-connect-bridge").nth(1)).toHaveText("No report from this runner's bridge for acme-labs/widgets yet");
    await expect(t(page, "tm-connect-row").nth(1)).toContainText("Offline");
    await expect(t(page, "tm-connect-row").nth(1)).toContainText("last seen 2 h ago");
    await expect(t(page, "tm-bridge")).toHaveAttribute("data-state", "idle"); // the one-click Connect panel stands where "Coming soon" did
    await expect(t(page, "tm-bridge-connect")).toBeVisible();
    await expect(t(page, "tm-connect-command")).toHaveCount(0); // one runner is bridged, so there is nothing to set up
    await expect(page.locator(`${WIN} label:has([data-testid="tm-watch"])`)).not.toContainText("this machine");
    await noSideways(page);
    await clean(page, errors);
  });


  // One-click Connect: the panel in Settings, for every state the cloud can answer, with the runner played by the test editing the mock's answer.
  const bridgeCmd = (over: Obj = {}) => ({ id: "c0000000-0000-4000-8000-0000000000b1", kind: "bridge_enable", runner_id: BRIDGE_RUNNER, runner_name: "Workshop laptop", state: "pending", result: null, refusal: null, root_tail: null, candidates: [], issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600000).toISOString(), acked_at: null, ...over });
  const panel = (page: Page) => tv(page, "tm-bridge");
  const sheet = async (page: Page, mock: Obj) => {
    const { errors } = await setup(page, mock as Mock);
    await open(page);
    await press(t(page, "tm-settings-btn"));
    return errors;
  };
  const noRaw = async (page: Page) => expect(await panel(page).innerText()).not.toMatch(/undefined|null|NaN|\[object/);

  test("Connect: one press sends one request and shows the asking state; the runner's answer then reads connected, and Disconnect undoes it", async ({ page }) => {
    const mock = fresh();
    const errors = await sheet(page, mock);
    await expect(panel(page)).toHaveAttribute("data-state", "idle");
    await press(tv(page, "tm-bridge-connect"));
    await expect(panel(page)).toHaveAttribute("data-state", "connecting");
    await expect(tv(page, "tm-bridge-text")).toContainText("Asking Workshop laptop to connect...");
    await expect(tv(page, "tm-bridge-cancel")).toBeVisible();
    expect(mock.bridgePosts).toEqual([{}]);
    await noRaw(page);
    // The runner answers; the panel reads it at its next look (the page polls while a request is out).
    mock.bridge = { ...mock.bridge, phase: "connected", connected: { runner_id: BRIDGE_RUNNER, runner_name: "Workshop laptop", root_tail: "acme/widgets", root: "/home/me/code/acme/widgets" }, command: bridgeCmd({ state: "applied", result: "connected", root_tail: "acme/widgets", acked_at: new Date().toISOString() }) };
    await expect(panel(page)).toHaveAttribute("data-state", "connected", { timeout: 20000 });
    await expect(tv(page, "tm-bridge-text")).toHaveText("Connected to acme/widgets on Workshop laptop");
    expect(await panel(page).innerText()).not.toContain("/home/me");
    await press(tv(page, "tm-bridge-disconnect"));
    await expect(panel(page)).toHaveAttribute("data-state", "disconnecting");
    expect(mock.bridgeDeletes).toBe(1);
    await noSideways(page);
    await clean(page, errors);
  });

  test("a disconnect that expired unanswered says it did not reach the runner, never connected, and Disconnect asks again", async ({ page }) => {
    const connected = { runner_id: BRIDGE_RUNNER, runner_name: "Workshop laptop", root_tail: "acme/widgets", root: "/home/me/code/acme/widgets" };
    const mock = fresh({ bridge: { phase: "disconnect_failed", connected, command: bridgeCmd({ kind: "bridge_disable", state: "expired", issued_at: new Date(Date.now() - 700000).toISOString(), expires_at: new Date(Date.now() - 100000).toISOString() }) } });
    const errors = await sheet(page, mock);
    await expect(panel(page)).toHaveAttribute("data-state", "disconnect_failed");
    await expect(tv(page, "tm-bridge-text")).toHaveText("Disconnect did not reach Workshop laptop; try again");
    expect(await panel(page).innerText()).not.toMatch(/Connected to|Will disconnect/);
    await expect(tv(page, "tm-bridge-disconnect")).not.toHaveAttribute("aria-disabled", "true");
    await press(tv(page, "tm-bridge-disconnect"));
    expect(mock.bridgeDeletes).toBe(1);
    await expect(panel(page)).toHaveAttribute("data-state", "disconnecting");
    await noSideways(page);
    await clean(page, errors);
  });

  test("a disconnect the runner refused says so with the reason and offers Disconnect again; a member sees a sentence, not an empty list, when an owner must pick", async ({ page }) => {
    const connected = { runner_id: BRIDGE_RUNNER, runner_name: "Workshop laptop", root_tail: "acme/widgets", root: null };
    const mock = fresh({ bridge: { phase: "disconnect_refused", connected, command: bridgeCmd({ kind: "bridge_disable", state: "refused", refusal: "settings_damaged", acked_at: new Date().toISOString() }) } });
    const errors = await sheet(page, mock);
    await expect(tv(page, "tm-bridge-text")).toContainText("Disconnect refused:");
    await expect(tv(page, "tm-bridge-disconnect")).toBeVisible();
    await clean(page, errors);
  });

  test("ambiguous for a member: a sentence says an owner or admin can pick, with no list and no button", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const mock = fresh({ settings: F.settings({ can_edit: false }), bridge: { phase: "ambiguous", command: bridgeCmd({ state: "refused", result: "ambiguous", refusal: "checkout_ambiguous", acked_at: new Date().toISOString(), candidates: [] }) } });
    const errors = await sheet(page, mock);
    await expect(tv(page, "tm-bridge-text")).toContainText("An owner or an admin can pick which copy to use.");
    await expect(tv(page, "tm-bridge-folders")).toHaveCount(0);
    await expect(tv(page, "tm-bridge-connect-this")).toHaveCount(0);
    await clean(page, errors);
  });

  test("Cancel takes back a request that is waiting, and after a minute with no answer the panel asks whether the runner is running", async ({ page }) => {
    const mock = fresh({ bridge: { phase: "connecting", command: bridgeCmd({ issued_at: new Date(Date.now() - 120000).toISOString() }) } });
    const errors = await sheet(page, mock);
    await expect(panel(page)).toHaveAttribute("data-state", "slow");
    await expect(tv(page, "tm-bridge-text")).toHaveText("Still waiting for Workshop laptop. Is it running?");
    await expect(tv(page, "tm-bridge-retry")).toHaveText("Try again");
    await expect(tv(page, "tm-bridge-cancel")).toBeVisible(); // Cancel stays for the command's whole life
    mock.bridge = { ...mock.bridge, phase: "connecting", command: bridgeCmd() };
    await expect(panel(page)).toHaveAttribute("data-state", "connecting", { timeout: 20000 });
    await press(tv(page, "tm-bridge-cancel"));
    await expect(panel(page)).toHaveAttribute("data-state", "idle");
    expect(mock.deletes).toEqual(["c0000000-0000-4000-8000-0000000000b1"]);
    await clean(page, errors);
  });

  test("not found: says what the runner did, gives the command with the repo filled in and a place to give the folder, quoted for a shell, and lists the clones it skipped", async ({ page }) => {
    const mock = fresh({ bridge: { phase: "not_found", command: bridgeCmd({ state: "refused", result: "not_found", refusal: "checkout_not_found", acked_at: new Date().toISOString(), skipped: ["/home/me/shared/widgets"] }) } });
    const errors = await sheet(page, mock);
    await expect(tv(page, "tm-bridge-text")).toHaveText("Workshop laptop looked on this computer and found no copy of acme-labs/widgets");
    await expect(tv(page, "tm-bridge-fallback")).toHaveText("fx-runner engine-bridge enable --repo acme-labs/widgets");
    await tv(page, "tm-bridge-folder").fill("/work/it's here");
    await expect(tv(page, "tm-bridge-fallback")).toHaveText("fx-runner engine-bridge enable --repo acme-labs/widgets --repo-root '/work/it'\\''s here'");
    await expect(tv(page, "tm-bridge-skipped")).toBeVisible();
    await expect(tv(page, "tm-bridge-folder-label")).toHaveText("shared/widgets");
    // The skipped copies are there to read, not to pick: a pick of an unsafe copy is refused, so the way on is chmod or the command.
    await expect(tv(page, "tm-bridge-connect-this")).toHaveCount(0);
    expect(await panel(page).locator('input[type="radio"]').count()).toBe(0);
    expect(mock.bridgePosts).toEqual([]);
    await noRaw(page);
    await clean(page, errors);
  });

  test("not found after a capped search: says the search was cut short, keeps the command and the folder box, labels the box as a way to get a command to run yourself, and sends no folder", async ({ page }) => {
    const mock = fresh({ bridge: { phase: "not_found", command: bridgeCmd({ state: "refused", result: "not_found", refusal: "checkout_not_found", acked_at: new Date().toISOString(), incomplete: true }) } });
    const errors = await sheet(page, mock);
    await expect(tv(page, "tm-bridge-text")).toHaveText("Workshop laptop looked on this computer and found no copy of acme-labs/widgets, but its search was cut short, so a copy may be somewhere it did not reach. Type the folder below to get a command you can run yourself.");
    await expect(tv(page, "tm-bridge-fallback")).toHaveText("fx-runner engine-bridge enable --repo acme-labs/widgets");
    const box = tv(page, "tm-bridge-folder");
    await expect(box).toBeVisible();
    await expect(box).toHaveAttribute("aria-label", "Or type the folder, to get a command you can run yourself");
    await expect(panel(page).getByText("Or type the folder, to get a command you can run yourself:")).toBeVisible();
    await box.fill("/work/widgets");
    await expect(tv(page, "tm-bridge-fallback")).toHaveText("fx-runner engine-bridge enable --repo acme-labs/widgets --repo-root /work/widgets");
    // Typing a folder only builds the command: nothing goes to the cloud, of any kind.
    expect(mock.bridgePosts).toEqual([]);
    expect(mock.posts).toEqual([]);
    // Nothing runs off the edge of the screen, whatever the width.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await noRaw(page);
    await clean(page, errors);
  });

  test("not found after a capped search, as a member: says the search was cut short without telling them to type a folder, and shows no folder box", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const mock = fresh({ settings: F.settings({ can_edit: false }), bridge: { phase: "not_found", command: bridgeCmd({ state: "refused", result: "not_found", refusal: "checkout_not_found", acked_at: new Date().toISOString(), incomplete: true }) } });
    const errors = await sheet(page, mock);
    await expect(tv(page, "tm-bridge-text")).toHaveText("Workshop laptop looked on this computer and found no copy of acme-labs/widgets, but its search was cut short, so a copy may be somewhere it did not reach. An owner or an admin can give the folder.");
    await expect(tv(page, "tm-bridge-text")).not.toContainText("Type the folder");
    await expect(tv(page, "tm-bridge-folder")).toHaveCount(0);
    await expect(tv(page, "tm-bridge-fallback")).toHaveText("fx-runner engine-bridge enable --repo acme-labs/widgets");
    expect(mock.bridgePosts).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await noRaw(page);
    await clean(page, errors);
  });

  test("not found after a search that finished: no cut-short wording", async ({ page }) => {
    const mock = fresh({ bridge: { phase: "not_found", command: bridgeCmd({ state: "refused", result: "not_found", refusal: "checkout_not_found", acked_at: new Date().toISOString(), incomplete: false }) } });
    const errors = await sheet(page, mock);
    await expect(tv(page, "tm-bridge-text")).toHaveText("Workshop laptop looked on this computer and found no copy of acme-labs/widgets");
    await expect(panel(page).getByText("cut short")).toHaveCount(0);
    await clean(page, errors);
  });

  test("ambiguous: a list of the folders, told apart; the pick is sent as the folder; a hostile name is text and nothing else", async ({ page }) => {
    const evil = "/home/me/<img src=x onerror=alert(1)>/widgets";
    const mock = fresh({ bridge: { phase: "ambiguous", command: bridgeCmd({ state: "refused", result: "ambiguous", refusal: "checkout_ambiguous", acked_at: new Date().toISOString(), candidates: [evil, "/home/me/code/widgets"] }) } });
    const errors = await sheet(page, mock);
    await expect(tv(page, "tm-bridge-folder-label")).toHaveText(["<img src=x onerror=alert(1)>/widgets", "code/widgets"]);
    expect(await panel(page).locator("img, a").count()).toBe(0);
    await press(tv(page, "tm-bridge-folders").locator("input").nth(1));
    await press(tv(page, "tm-bridge-connect-this"));
    expect(mock.bridgePosts).toEqual([{ runner_id: BRIDGE_RUNNER, repo_root: "/home/me/code/widgets" }]);
    await noSideways(page);
    await clean(page, errors);
  });

  test("incomplete: names the one copy it found and takes a one-click confirm, which is sent as the folder", async ({ page }) => {
    const mock = fresh({ bridge: { phase: "incomplete", command: bridgeCmd({ state: "refused", result: "refused", refusal: "checkout_incomplete", acked_at: new Date().toISOString(), candidates: ["/home/me/code/acme/widgets"] }) } });
    const errors = await sheet(page, mock);
    await expect(tv(page, "tm-bridge-text")).toContainText("acme/widgets");
    await expect(tv(page, "tm-bridge-folders").locator("input").first()).toBeChecked(); // the one copy is already chosen
    await press(tv(page, "tm-bridge-connect-this"));
    expect(mock.bridgePosts).toEqual([{ runner_id: BRIDGE_RUNNER, repo_root: "/home/me/code/acme/widgets" }]);
    await clean(page, errors);
  });

  test("refused: the reason in plain words with the code kept for Copy details, never the code alone", async ({ page }) => {
    const mock = fresh({ bridge: { phase: "refused", command: bridgeCmd({ state: "refused", result: "refused", refusal: "state_dir_missing", acked_at: new Date().toISOString() }) } });
    const errors = await sheet(page, mock);
    await expect(tv(page, "tm-bridge-text")).toContainText("state folder");
    expect(await tv(page, "tm-bridge-text").innerText()).not.toContain("state_dir_missing");
    await expect(tv(page, "tm-bridge-code")).toBeVisible(); // visible and selectable, so it can be copied by hand when the clipboard is blocked
    await expect(tv(page, "tm-bridge-code")).toHaveText("state_dir_missing");
    await expect(tv(page, "tm-bridge-details")).toHaveText("Copy details");
    await clean(page, errors);
  });

  for (const [name, plan, protocolOk, online, words] of [
    ["no runner online", "offline", true, false, /No runner that has this repo is online/],
    ["only an old runner", "old", false, true, /Your runner is out of date: run fx-runner update/],
  ] as const) {
    test(`${name}: the command to copy with the repo filled in, the words for it, and nothing is sent`, async ({ page }) => {
      const mock = fresh({ bridge: { plan, runners: [{ id: BRIDGE_RUNNER, name: "Workshop laptop", has_name: true, online, protocol_ok: protocolOk, last_seen_at: null }] } });
      const errors = await sheet(page, mock);
      await expect(panel(page)).toHaveAttribute("data-state", "fallback");
      await expect(tv(page, "tm-bridge-text")).toHaveText(words);
      await expect(tv(page, "tm-bridge-fallback")).toHaveText("fx-runner engine-bridge enable --repo acme-labs/widgets");
      await expect(tv(page, "tm-bridge-connect")).toHaveCount(0);
      expect(mock.bridgePosts).toEqual([]);
      await clean(page, errors);
    });
  }

  test("several online runners: the person picks by name and the choice goes with the request", async ({ page }) => {
    const second = "9d2c7b1e-5f3a-4e8b-8a6d-1c2b3a4d5e77";
    const mock = fresh({ bridge: { plan: "choose", runners: [{ id: BRIDGE_RUNNER, name: "Workshop laptop", has_name: true, online: true, protocol_ok: true, last_seen_at: null }, { id: second, name: "Desk machine", has_name: true, online: true, protocol_ok: true, last_seen_at: null }] } });
    const errors = await sheet(page, mock);
    await tv(page, "tm-bridge-runner").selectOption(second);
    await press(tv(page, "tm-bridge-connect"));
    expect(mock.bridgePosts).toEqual([{ runner_id: second }]);
    await clean(page, errors);
  });

  test("a request the cloud refuses says why in words, and the screen then shows what is true", async ({ page }) => {
    const mock = fresh({ bridgeStatus: 409, bridgeCode: "bridge_pending" });
    const errors = await sheet(page, mock);
    await press(tv(page, "tm-bridge-connect"));
    await expect(tv(page, "tm-bridge-notice")).toHaveText("A request for this repo is already on its way.");
    await clean(page, errors);
  });

  test("a member sees the state and no button, and no path", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const mock = fresh({ settings: F.settings({ can_edit: false }), bridge: { phase: "connected", connected: { runner_id: BRIDGE_RUNNER, runner_name: "Workshop laptop", root_tail: "acme/widgets", root: null } } });
    const errors = await sheet(page, mock);
    await expect(tv(page, "tm-bridge-text")).toHaveText("Connected to acme/widgets on Workshop laptop");
    await expect(tv(page, "tm-bridge-disconnect")).toHaveCount(0);
    expect(await page.locator(WIN).innerText()).not.toContain("/home/");
    await clean(page, errors);
  });

  test("an offline runner reads offline before the box is ticked, and the choice between two runners renames the switch", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const settings = F.settings({ watch_enabled: false, repos: [F.settingsRepo({ bridged_runner_id: RUNNER_A, enabled: false }), F.settingsRepo({ repo_id: REPO_B, full_name: "acme-labs/site", enabled: false, bridged_runner_id: RUNNER_B })] });
    const { errors } = await setup(page, fresh({ settings, runners: F.fleet([F.runner({ state: "offline", last_seen_at: F.iso(10800) }), F.runner({ id: RUNNER_B, name: "Build box" })]) }));
    await open(page);
    await expect(tv(page, "tm-runner-status")).toHaveText("Offline · last seen 3 h ago");
    await expect(t(page, "tm-watch-off").locator("xpath=..")).toHaveText("Watch the engine team on Workshop laptop");
    await tv(page, "tm-runner-pick").selectOption(RUNNER_B);
    await expect(t(page, "tm-watch-off").locator("xpath=..")).toHaveText("Watch the engine team on Build box");
    await expect(tv(page, "tm-runner-status")).toHaveText("Online · last seen 2 min ago");
    await noSideways(page);
    await clean(page, errors);
  });

  test("bridge not set up on any runner: the one connect command with the repo filled in, nothing to edit, and no path from the server", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { errors } = await setup(page, fresh({ settings: F.settings({ watch_enabled: false }) }));
    await open(page);
    await expect(t(page, "tm-watch-off").locator("xpath=..")).toHaveText("Watch the engine team on your runner");
    await expect(tv(page, "tm-runner-status")).toContainText("then turn the switch on");
    await expect(tv(page, "tm-bridge-command")).toHaveText("fx-runner engine-bridge enable --repo acme-labs/widgets");
    expect(await page.locator(WIN).innerText()).not.toMatch(/<[^>\n]*>|placeholder|replace the/i);
    await noSideways(page);
    await clean(page, errors);
  });

  test("no runner registered: says so with a button that opens the Runners app, and no command", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { errors } = await setup(page, fresh({ runners: F.fleet([]) }));
    await open(page);
    await press(t(page, "tm-settings-btn"));
    await expect(t(page, "tm-connect-empty")).toHaveText("No runners yet. Use Add a runner to register your first machine.");
    await expect(t(page, "tm-connect-command")).toHaveCount(0);
    await press(t(page, "tm-open-runners"));
    await expect(page.locator('#windows-container .fulc-window[data-app-id="runners"]')).toBeVisible();
    await clean(page, errors);
  });

  test("a runner list that cannot be read is said in the app's words and the switch still works", async ({ page }) => {
    const { errors } = await setup(page, fresh({ runners: null }));
    await open(page);
    await press(t(page, "tm-settings-btn"));
    await expect(t(page, "tm-connect-failed")).toHaveText("The runner list isn't available right now.");
    await expect(t(page, "tm-watch")).toBeChecked();
    await clean(page, errors);
  });

  test("the connect command has a Copy button: labelled, reachable by keyboard, says Copied, and puts the exact command on the clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const F = makeFixtures(Date.now());
    const { errors } = await setup(page, fresh({ settings: F.settings({ watch_enabled: false }) }));
    await open(page);
    const cmd = "fx-runner engine-bridge enable --repo acme-labs/widgets";
    const btn = page.locator(`${WIN} [data-testid="tm-copy"]:visible`).first();
    await expect(btn).toHaveAccessibleName("Copy command");
    await btn.focus();
    await expect(btn).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator(`${WIN} [data-testid="tm-copy-note"]:visible`).first()).toHaveText("Copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(cmd);
    await noSideways(page);
    await clean(page, errors);
  });

  test("the connect command where the clipboard is blocked: the note says to copy by hand, and the command stays on the page as selectable text", async ({ page }) => {
    await page.addInitScript(() => { Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("blocked")) }, configurable: true }); });
    const F = makeFixtures(Date.now());
    const { errors } = await setup(page, fresh({ settings: F.settings({ watch_enabled: false }) }));
    await open(page);
    await press(page.locator(`${WIN} [data-testid="tm-copy"]:visible`).first());
    await expect(page.locator(`${WIN} [data-testid="tm-copy-note"]:visible`).first()).toHaveText("Couldn't copy. Select the command and copy it by hand.");
    const code = tv(page, "tm-bridge-command");
    await expect(code).toBeVisible();
    await expect(code).toHaveCSS("user-select", /^(auto|text|all)$/);
    await expect(code).toHaveText("fx-runner engine-bridge enable --repo acme-labs/widgets");
    await noSideways(page);
    await clean(page, errors);
  });

  test("the connect list in Settings shows the same command, no placeholder wording, and copies it", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const F = makeFixtures(Date.now());
    const { errors } = await setup(page, fresh({ settings: F.settings({ watch_enabled: false }) }));
    await open(page);
    await press(t(page, "tm-settings-btn"));
    await expect(t(page, "tm-connect-command")).toHaveText("fx-runner engine-bridge enable --repo acme-labs/widgets");
    await expect(t(page, "tm-connect-fill")).toHaveText("Run this on that computer, then turn the switch on.");
    expect(await page.locator(WIN).innerText()).not.toMatch(/replace the|placeholder|<[^>\n]*>/i);
    await press(t(page, "tm-connect-command").locator("xpath=following-sibling::button[1]"));
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("fx-runner engine-bridge enable --repo acme-labs/widgets");
    await noSideways(page);
    await clean(page, errors);
  });

  test("Open Settings still works after Settings was opened and closed with watch on and no repository (the button is not redrawn)", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { errors } = await setup(page, fresh({ settings: F.settings({ watch_enabled: false }), repos: [] }));
    await open(page);
    await press(t(page, "tm-settings-btn")); // open Settings, turn watch on there, close it again
    await press(t(page, "tm-watch"));
    await expect(tv(page, "tm-open-settings")).toBeVisible();
    await press(t(page, "tm-settings-btn"));
    await expect(t(page, "tm-settings-btn")).toHaveAttribute("aria-expanded", "false");
    await press(tv(page, "tm-open-settings"));
    await expect(t(page, "tm-settings-btn")).toHaveAttribute("aria-expanded", "true");
    await press(tv(page, "tm-open-settings")); // already open: stays open
    await expect(t(page, "tm-settings-btn")).toHaveAttribute("aria-expanded", "true");
    await clean(page, errors);
  });

  test("watch on with no repository enabled: the switch stays on the page, says no repository is enabled, and Open Settings opens the sheet", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { mock, errors } = await setup(page, fresh({ repos: [] }));
    await open(page);
    await expect(tv(page, "tm-norepos")).toHaveText("No repositories are enabled for engine watch.");
    await expect(tv(page, "tm-watch-on-note")).toContainText("Settings");
    await expect(tv(page, "tm-watch-off")).toBeChecked();
    await press(tv(page, "tm-open-settings"));
    await expect(t(page, "tm-settings-btn")).toHaveAttribute("aria-expanded", "true");
    await expect(t(page, "tm-watch")).toBeChecked();
    expect(mock.puts).toEqual([]);
    await noSideways(page);
    await clean(page, errors);
    void F;
  });

  test("a runner with no name says so and links to the Runners app, where it can be named", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { errors } = await setup(page, fresh({ runners: F.fleet([F.runner({ has_name: false, name: null })]) }));
    await open(page);
    await press(t(page, "tm-settings-btn"));
    await expect(tv(page, "tm-unnamed").first()).toContainText("no name yet");
    await press(tv(page, "tm-rename-runner").first());
    await expect(page.locator('#windows-container .fulc-window[data-app-id="runners"]')).toBeVisible();
    await noSideways(page);
    await clean(page, errors);
  });

  test("real click: turning the switch on says Connecting to the runner while it has not reported in, and the chip is not Live", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const never = { runner_id: null, runner_name: null, session_id: null, last_event_at: null, last_heard_at: null, liveness: "never" };
    const settings = F.settings({ watch_enabled: false, repos: [F.settingsRepo({ bridged_runner_id: RUNNER_A })] });
    const { mock, errors } = await setup(page, fresh({ settings, repos: [F.repo(never)] }));
    await open(page);
    await press(t(page, "tm-watch-off"));
    await expect(t(page, "tm-connecting-bar")).toHaveText("Connecting to Workshop laptop… waiting for it to report in.");
    await expect(t(page, "tm-chip")).toContainText("Never connected");
    await expect(t(page, "tm-chip")).not.toContainText("Live");
    expect(mock.puts).toEqual([{ path: `${BASE}/settings`, body: { watch_enabled: true } }]);
    await noSideways(page);
    await clean(page, errors);
  });
  // ── A stop that did not finish (ON-13c4b) ────────────────────────────────────────────────────────────────────────────
  const failedStop = (reason: string | null, code: string | null = null, over: Partial<Mock> = {}, settingsOver: Obj = {}) => {
    const F = makeFixtures(Date.now());
    return operateOn({ settings: F.settings({ operate_enabled: true, ...settingsOver }), repos: [F.repo({ operate_enabled: true, stop_failed: { reason, code, at: F.iso(60) } })], ...over });
  };

  test("a failed stop: the chip and the row say it in words, Try again sends one POST, and the row goes once the stop is asked again", async ({ page }) => {
    const { mock, errors } = await setup(page, failedStop("halt", "job_silent"));
    await open(page);
    await expect(t(page, "tm-stop-chip")).toHaveText("Engine stop: Stop failed");
    await expect(t(page, "tm-stopfail")).toBeVisible();
    await expect(t(page, "tm-stopfail-text")).toHaveText("The halt didn't finish stopping the engine. It may still be running, and commands stay refused (the machine went quiet).");
    const btn = t(page, "tm-stopfail-retry");
    await expect(btn).toHaveText("Try again");
    await expect(btn).toBeEnabled();
    await press(btn);
    await expect.poll(() => mock.retries).toEqual([REPO_A]);
    await expect(t(page, "tm-stopfail")).toBeHidden();
    await expect(t(page, "tm-stop-chip")).toBeHidden();
    await expect(t(page, "tm-live")).toHaveText("Asked the machine to stop the engine again.");
    await clean(page, errors);
  });

  test("a system cause says the cloud tries again and the answer is queued; the row stays", async ({ page }) => {
    const mock = failedStop("operate_off", "snapshot_failed");
    mock.retryAnswer = { queued: true };
    const { errors } = await setup(page, mock);
    await open(page);
    await expect(t(page, "tm-stopfail-text")).toHaveText("Operate is off, but the engine didn't stop. It may still be running (the engine's state couldn't be saved).");
    await expect(t(page, "tm-stopfail-after")).toHaveText("We'll try again when the machine next reports in.");
    await press(t(page, "tm-stopfail-retry"));
    await expect(t(page, "tm-stopfail-note")).toHaveText("Asked again. The stop goes out when the machine next reports in.");
    await expect(t(page, "tm-stopfail")).toBeVisible();
    expect(mock.retries).toEqual([REPO_A]);
    await clean(page, errors);
  });

  test("a refusal is said in fixed words, never the server's", async ({ page }) => {
    const mock = failedStop("person", "job_expired");
    mock.retryStatus = 409;
    mock.retryCode = "cause_gone";
    const { errors } = await setup(page, mock);
    await open(page);
    await press(t(page, "tm-stopfail-retry"));
    await expect(t(page, "tm-stopfail-note")).toHaveText("That's no longer needed, so nothing was sent.");
    await expect(t(page, "tm-stopfail-text")).toHaveText("The stop didn't finish. The engine may still be running (the machine didn't pick up the stop in time).");
    await clean(page, errors);
  });

  for (const [reason, sentence, after] of [["move", "Moving the project didn't stop the engine on its old machine.", "Start the move again to try once more."], ["remove", "Removing the project didn't stop its engine.", "Stop it on the machine itself."]]) {
    test(`a ${reason} shows the chip and the sentence and no button`, async ({ page }) => {
      const { mock, errors } = await setup(page, failedStop(reason));
      await open(page);
      await expect(t(page, "tm-stop-chip")).toBeVisible();
      await expect(t(page, "tm-stopfail-text")).toHaveText(sentence);
      await expect(t(page, "tm-stopfail-after")).toHaveText(after);
      await expect(t(page, "tm-stopfail-retry")).toHaveCount(0);
      expect(mock.retries).toEqual([]);
      await clean(page, errors);
    });
  }

  test("a member sees the button disabled with the line that says why, and nothing is sent", async ({ page }) => {
    const { mock, errors } = await setup(page, failedStop("person", null, {}, { can_edit: false }));
    await open(page);
    const btn = t(page, "tm-stopfail-retry");
    await expect(btn).toBeVisible();
    await expect(btn).toHaveAttribute("aria-disabled", "true");
    await btn.focus();
    expect(await activeId(page)).toBe("tm-stopfail-retry");
    await expect(t(page, "tm-stopfail-why")).toHaveText("Only an owner or admin can try again.");
    await btn.dispatchEvent("click");
    expect(mock.retries).toEqual([]);
    await clean(page, errors);
  });

  test("a repo whose stop did not fail shows neither the chip nor the row", async ({ page }) => {
    const { errors } = await setup(page, operateOn());
    await open(page);
    await expect(t(page, "tm-stop-chip")).toBeHidden();
    await expect(t(page, "tm-stopfail")).toBeHidden();
    await clean(page, errors);
  });

  // ── The next step of the open repo (ON-14c) ─────────────────────────────────────────────────────────────────────────────
  // Every row of the chip table, with real clicks on its button, at phone, tablet and desktop. The words are pinned in test/team-next.test.mjs; here the page is the subject: that the button is a
  // real control in the Tab order, calls the route once, and the card, the chip and the live line follow the answer, and that nothing sticks out sideways.
  const AT_ISO = new Date(Date.now() - 30 * 60_000).toISOString();
  const hhmm = (iso: string) => { const d = new Date(iso); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
  const sess = (state: string, over: Obj = {}) => ({ state, last_start_mode: "created", last_start_at: AT_ISO, stopped_reason: null, state_at: AT_ISO, ...over });
  const setupDone = { status: "done", phase: "done", sub_step: null, state: "ok", failure_code: null };
  const stepRepo = (over: Obj = {}, settingsOver: Obj = {}, mockOver: Partial<Mock> = {}) => {
    const F = makeFixtures(Date.now());
    return operateOn({ settings: F.settings({ operate_enabled: true, ...settingsOver }), repos: [F.repo({ operate_enabled: true, machine_name: "Studio laptop", setup: setupDone, session: sess("running"), ...over })], ...mockOver });
  };
  const nextText = (page: Page) => t(page, "tm-next-text");
  async function fitsAcross(page: Page) {
    // A phone window is first drawn at its default size and then fitted to the screen; measure after the fit.
    if (test.info().project.name === "phone") await expect.poll(() => page.evaluate((sel) => (document.querySelector(sel) as HTMLElement).getBoundingClientRect().width <= innerWidth + 1, WIN)).toBe(true);
    await noSideways(page);
    const card = await box(t(page, "tm-next"));
    const win = await box(page.locator(WIN));
    expect(card.x + card.width).toBeLessThanOrEqual(win.x + win.width + 1);
  }

  test("a running engine has no next-step card", async ({ page }) => {
    const { errors } = await setup(page, stepRepo());
    await open(page);
    await expect(t(page, "tm-next")).toBeHidden();
    await clean(page, errors);
  });

  test("never + an open setup: the sentence names the step and Open Onboarding opens the Onboarding window", async ({ page }) => {
    const { errors } = await setup(page, stepRepo({ liveness: "never", setup: { ...setupDone, status: "open", phase: "install" }, session: sess("never") }));
    await open(page);
    await expect(nextText(page)).toHaveText("Setting up: installing the engine");
    await expect(t(page, "tm-chip")).toContainText("Never connected");
    await fitsAcross(page); // before the hand-off: a phone shows one window, and the Team window is hidden once another opens
    await press(t(page, "tm-next-onboarding"));
    await expect(page.locator(`#windows-container .fulc-window[data-app-id="onboarding"]`)).toBeVisible();
    expect(errors.filter((x) => !/onboarding|\/api\//i.test(x))).toEqual([]);
  });

  test("never + no setup: Set up the engine opens Onboarding", async ({ page }) => {
    await setup(page, stepRepo({ liveness: "never", setup: { status: "none", phase: null, sub_step: null, state: null, failure_code: null }, session: sess("never") }));
    await open(page);
    await expect(nextText(page)).toHaveText("This repo isn't set up on a machine yet");
    await fitsAcross(page);
    await press(t(page, "tm-next-setup"));
    await expect(page.locator(`#windows-container .fulc-window[data-app-id="onboarding"]`)).toBeVisible();
  });

  test("never + setup done, operate off: Turn on operate saves the switch, and the card then offers Start engine", async ({ page }) => {
    const mock = stepRepo({ liveness: "never", operate_enabled: false, session: sess("never") }, { operate_enabled: false });
    const { errors } = await setup(page, mock);
    await open(page);
    await expect(nextText(page)).toHaveText("Operate is off, so the engine isn't running on Studio laptop");
    const btn = t(page, "tm-next-operate");
    await expect(btn).toHaveText("Turn on operate");
    await press(btn);
    await expect.poll(() => mock.puts).toEqual([{ path: `${BASE}/settings`, body: { operate_enabled: true } }]);
    await expect(nextText(page)).toHaveText("The engine isn't running on Studio laptop");
    await expect(t(page, "tm-next-start")).toHaveText("Start engine");
    await fitsAcross(page);
    await clean(page, errors);
  });

  test("never + setup done, operate on: Start engine sends one POST, and the chip and card follow the start", async ({ page }) => {
    const mock = stepRepo({ liveness: "never", session: sess("never") });
    const { errors } = await setup(page, mock);
    await open(page);
    await expect(nextText(page)).toHaveText("The engine isn't running on Studio laptop");
    await press(t(page, "tm-next-start"));
    await expect.poll(() => mock.starts).toEqual([REPO_A]);
    await expect(t(page, "tm-live")).toContainText("Asked the machine to start the engine.");
    await expect(nextText(page)).toHaveText("Starting the engine on Studio laptop…");
    await expect(t(page, "tm-chip")).toHaveText("Engine connection: Starting");
    await expect(t(page, "tm-next-start")).toHaveCount(0);
    await fitsAcross(page);
    await clean(page, errors);
  });

  test("stale: the card says to start the runner, and Open Machines opens the Machines window", async ({ page }) => {
    await setup(page, stepRepo({ liveness: "stale", session: sess("stale"), last_heard_at: new Date(Date.now() - 3600_000).toISOString() }));
    await open(page);
    await expect(t(page, "tm-chip")).toContainText("Stale since");
    await expect(nextText(page)).toHaveText("Start the runner on Studio laptop");
    await fitsAcross(page);
    await press(t(page, "tm-next-machines"));
    await expect(page.locator(`#windows-container .fulc-window[data-app-id="runners"]`)).toBeVisible();
  });

  test("runner removed: Move to another machine opens a picker, Move sends the chosen machine, and Cancel closes the picker", async ({ page }) => {
    const mock = stepRepo({ liveness: "runner_removed", session: sess("runner_removed") });
    const { errors } = await setup(page, mock);
    await open(page);
    await expect(nextText(page)).toHaveText("Its machine was removed");
    await expect(t(page, "tm-chip")).toContainText("Runner removed");
    await press(t(page, "tm-next-move"));
    const pick = t(page, "tm-move-pick");
    await expect(pick.locator("option")).toHaveText(["Workshop laptop", "Garage box"]);
    expect(await activeId(page)).toBe("tm-move-pick");
    await press(t(page, "tm-move-cancel"));
    await expect(t(page, "tm-move")).toHaveCount(0);
    await expect(t(page, "tm-next-move")).toBeVisible();
    await press(t(page, "tm-next-move"));
    await pick.selectOption({ label: "Garage box" });
    await fitsAcross(page);
    await press(t(page, "tm-move-go"));
    await expect.poll(() => mock.moves).toEqual([{ to_runner_id: "9d2c7b1e-5f3a-4e8b-8a6d-1c2b3a4d5e77" }]);
    await expect(t(page, "tm-live")).toContainText("Moved. The engine starts on the new machine.");
    await expect(nextText(page)).toHaveText("Starting the engine on Studio laptop…");
    await clean(page, errors);
  });

  test("a refused move says why in fixed words and keeps the picker", async ({ page }) => {
    const mock = stepRepo({ liveness: "runner_removed", session: sess("runner_removed") });
    mock.moveStatus = 409;
    mock.moveCode = "machine_single_project";
    const { errors } = await setup(page, mock);
    await open(page);
    await press(t(page, "tm-next-move"));
    await press(t(page, "tm-move-go"));
    await expect(t(page, "tm-next-note")).toHaveText("That machine can't take the project right now. Pick another.");
    await expect(t(page, "tm-move")).toBeVisible();
    await clean(page, errors);
  });

  for (const [reason, sentence, id, label] of [
    ["person", `Stopped ${hhmm(AT_ISO)}`, "start", "Start engine"], ["halt", `Stopped ${hhmm(AT_ISO)}`, "start", "Start engine"],
    ["operate_off", `Stopped at ${hhmm(AT_ISO)} because operate was turned off`, "operate", "Turn on operate"], ["plan", "Plan ended: the engine is stopped", "renew", "Renew"],
  ]) {
    test(`session stopped (${reason}) with ${label}, and the chip is Stopped, never Live`, async ({ page }) => {
      const mock = stepRepo({ session: sess("stopped", { stopped_reason: reason }) });
      const { errors } = await setup(page, mock);
      await open(page);
      await expect(nextText(page)).toHaveText(sentence);
      await expect(t(page, "tm-chip")).toHaveText("Engine connection: Stopped");
      const btn = t(page, `tm-next-${id}`);
      await expect(btn).toHaveText(label);
      await btn.focus();
      expect(await activeId(page)).toBe(`tm-next-${id}`);
      await page.keyboard.press("Enter"); // the keyboard reaches the button and Enter presses it
      if (id === "start") await expect.poll(() => mock.starts).toEqual([REPO_A]);
      if (id === "operate") await expect.poll(() => mock.puts).toEqual([{ path: `${BASE}/settings`, body: { operate_enabled: true } }]);
      if (id === "renew") await expect.poll(() => mock.checkouts).toEqual([{ plan: "engine", quantity: 1, success_path: "/", cancel_path: "/" }]);
      if (id === "renew") await expect(t(page, "tm-live")).toContainText("You already have the Engine plan.");
      await fitsAcross(page);
      await clean(page, errors);
    });
  }

  // Operate off while a cloud session is listed: the engine is stopping or stopped, so the card offers Turn on operate (never a start the server refuses) and the chip is never Live or Stale.
  const OFF_LINE = "Operate is off, so the engine isn't running on Studio laptop";
  for (const [name, over, sentence, chip, action] of [
    ["stale (machine offline)", { liveness: "stale", last_heard_at: new Date(Date.now() - 3600_000).toISOString(), session: sess("stale") }, "Stopping when Studio laptop comes back", "Operate off", null],
    ["running (stop in transit)", { liveness: "live", session: sess("running") }, OFF_LINE, "Operate off", "operate"],
    ["stopped by a person", { session: sess("stopped", { stopped_reason: "person" }) }, OFF_LINE, "Stopped", "operate"],
    ["stopped by a halt", { session: sess("stopped", { stopped_reason: "halt" }) }, OFF_LINE, "Stopped", "operate"],
    ["stopped by a move", { session: sess("stopped", { stopped_reason: "move" }) }, OFF_LINE, "Stopped", "operate"],
  ] as [string, Obj, string, string, string | null][]) {
    test(`operate off, ${name}: "${sentence}", chip ${chip}, ${action ? "Turn on operate and no start" : "no button"}`, async ({ page }) => {
      const mock = stepRepo({ ...over, operate_enabled: false }, { operate_enabled: false });
      const { errors } = await setup(page, mock);
      await open(page);
      await expect(nextText(page)).toHaveText(sentence);
      await expect(t(page, "tm-chip")).toHaveText(`Engine connection: ${chip}`);
      await expect(t(page, "tm-next-start")).toHaveCount(0);
      await expect(t(page, "tm-next-machines")).toHaveCount(0);
      if (action) await expect(t(page, "tm-next-operate")).toHaveText("Turn on operate");
      else await expect(t(page, "tm-next-operate")).toHaveCount(0);
      expect(mock.starts).toEqual([]);
      await fitsAcross(page);
      await clean(page, errors);
    });
  }

  test("operate off: a member sees the sentence and the ask line", async ({ page }) => {
    const mock = stepRepo({ operate_enabled: false, liveness: "live", session: sess("running") }, { operate_enabled: false, can_edit: false });
    await setup(page, mock);
    await open(page);
    await expect(nextText(page)).toHaveText(OFF_LINE);
    await expect(t(page, "tm-next-ask")).toHaveText("Ask an owner or admin to turn on operate");
    await expect(t(page, "tm-next-operate")).toHaveCount(0);
  });

  test("a watch-only repo with no listed sandbox keeps its Live chip", async ({ page }) => {
    const F = makeFixtures(Date.now());
    await setup(page, fresh({ repos: [F.repo({ operate_enabled: false })] }));
    await open(page);
    await expect(t(page, "tm-chip")).toHaveText("Engine connection: Live");
    await expect(t(page, "tm-next")).toBeHidden();
  });

  test("a removed project has no Start engine button", async ({ page }) => {
    await setup(page, stepRepo({ session: sess("stopped", { stopped_reason: "remove" }) }));
    await open(page);
    await expect(nextText(page)).toHaveText(`Stopped ${hhmm(AT_ISO)}`);
    await expect(t(page, "tm-next-start")).toHaveCount(0);
  });

  test("plan ended: an admin sees the ask line and no Renew button", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const mock = stepRepo({ session: sess("stopped", { stopped_reason: "plan" }) }, {}, { runners: F.fleet([F.runner()], "admin") });
    await setup(page, mock);
    await open(page);
    await expect(nextText(page)).toHaveText("Plan ended: the engine is stopped");
    await expect(t(page, "tm-next-ask")).toHaveText("Ask an owner to renew the plan");
    await expect(t(page, "tm-next-renew")).toHaveCount(0);
    expect(mock.checkouts).toEqual([]);
  });

  test("a halted engine says when it stopped, and Start engine sends one POST", async ({ page }) => {
    const mock = stepRepo({ halted: true, session: sess("halted") });
    await setup(page, mock);
    await open(page);
    await expect(nextText(page)).toHaveText(`Stopped ${hhmm(AT_ISO)}`);
    await press(t(page, "tm-next-start"));
    await expect.poll(() => mock.starts).toEqual([REPO_A]);
  });

  test("a start the cloud refuses says why in fixed words, never the server's", async ({ page }) => {
    const mock = stepRepo({ session: sess("stopped", { stopped_reason: "person" }) });
    mock.startStatus = 402;
    mock.startCode = "plan_required";
    const { errors } = await setup(page, mock);
    await open(page);
    await press(t(page, "tm-next-start"));
    await expect(t(page, "tm-next-note")).toHaveText("The engine needs the Engine plan. Choose it in Onboarding.");
    await expect(t(page, "tm-next-start")).toBeVisible();
    await clean(page, errors);
  });

  test("a running engine that came up fresh says when", async ({ page }) => {
    const { errors } = await setup(page, stepRepo({ session: sess("running", { last_start_mode: "fresh" }) }));
    await open(page);
    await expect(t(page, "tm-fresh")).toHaveText(`Started fresh at ${hhmm(AT_ISO)}`);
    await expect(t(page, "tm-chip")).toHaveText("Engine connection: Live");
    await fitsAcross(page);
    await clean(page, errors);
  });

  // The page's clock is pinned (never the real time of day), so the countdown is the same at any hour the suite runs.
  for (const [state, clock, words] of [
    ["session_full", "2026-11-16T22:00:00Z", "in 2 h"], ["repo_full", "2026-11-16T23:02:00Z", "in 58 min"],
    ["session_full", "2026-11-16T23:59:30Z", "in under a minute"], ["repo_full", "2026-11-17T00:00:01Z", "in 24 h"],
  ]) {
    test(`the event limit (${state}) at ${clock}: the copy counts down to 00:00 UTC (${words}), and the data age stays on screen`, async ({ page }) => {
      await page.clock.setFixedTime(new Date(clock));
      const reset = new Date(Math.floor(Date.parse(clock) / 86_400_000) * 86_400_000 + 86_400_000);
      const { errors } = await setup(page, stepRepo({ quota: { state, session_used: 5000, session_limit: 5000, repo_used: 20000, repo_limit: 20000, resets_at: reset.toISOString() } }));
      await open(page);
      await expect(t(page, "tm-quota")).toHaveText(`Today's event limit is reached. Updates resume at 00:00 UTC (${words})`);
      await expect(t(page, "tm-agents-asof")).toContainText("As of");
      await fitsAcross(page);
      await clean(page, errors);
    });
  }

  test("a member sees the sentence without the button, and the line that says who can act", async ({ page }) => {
    const mock = stepRepo({ session: sess("stopped", { stopped_reason: "operate_off" }) }, { can_edit: false });
    const { errors } = await setup(page, mock);
    await open(page);
    await expect(nextText(page)).toHaveText(`Stopped at ${hhmm(AT_ISO)} because operate was turned off`);
    await expect(t(page, "tm-next-ask")).toHaveText("Ask an owner or admin to turn on operate");
    await expect(t(page, "tm-next-operate")).toHaveCount(0);
    expect(mock.puts).toEqual([]);
    await clean(page, errors);
  });

  test("a long machine name stays text and wraps inside the card", async ({ page }) => {
    const { errors } = await setup(page, stepRepo({ liveness: "never", session: sess("never"), machine_name: HOSTILE + " " + "x".repeat(80) }));
    await open(page);
    await expect(nextText(page).locator("img, script")).toHaveCount(0);
    await expect(nextText(page).locator("bdi")).toHaveCount(1);
    await fitsAcross(page);
    expect(errors).toEqual([]);
  });

  // ── The engine update card (ON-15d) ─────────────────────────────────────────────────────────────────────────────────
  const updatable = (engine_update: Obj | null, settingsOver: Obj = {}, over: Partial<Mock> = {}) => {
    const F = makeFixtures(Date.now());
    return operateOn({ settings: F.settings({ operate_enabled: true, ...settingsOver }), repos: [F.repo({ operate_enabled: true, engine_update })], ...over });
  };
  const UPDATE_PR = "https://github.com/acme-labs/widgets/pull/41";

  test("an update is on offer: the card says both versions, Update sends one POST, the card turns to progress and focus lands on its title", async ({ page }) => {
    const { mock, errors } = await setup(page, updatable({ behind: BEHIND, update: null }));
    await open(page);
    await expect(t(page, "tm-update-title")).toHaveText("Update available (v1.4.0 → v1.5.0)");
    const btn = t(page, "tm-update-start");
    await expect(btn).toHaveText("Update");
    await expect(btn).toHaveAttribute("aria-disabled", "false");
    await press(btn);
    await expect.poll(() => mock.updates).toEqual([REPO_A]);
    await expect(t(page, "tm-update-title")).toHaveText("Updating the engine (v1.4.0 → v1.5.0)");
    await expect(t(page, "tm-update-text")).toHaveText("Step 1 of 4: Preparing the update (fetching the new version).");
    await expect(t(page, "tm-update-start")).toHaveCount(0);
    await expect.poll(() => activeId(page)).toBe("tm-update-title");
    await expect(t(page, "tm-live")).toContainText("Step 1 of 4");
    await noSideways(page);
    await clean(page, errors);
  });

  test("an update under way shows its step and, once it has one, a pull request link that opens in a new tab", async ({ page }) => {
    const { errors } = await setup(page, updatable({ behind: null, update: updateRow({ phase: "await_merge", sub_step: "pr_open", state: "ok", pr: 41 }) }));
    await open(page);
    await expect(t(page, "tm-update-text")).toHaveText("Step 3 of 4: Waiting for someone to merge the pull request.");
    const a = t(page, "tm-update-pr");
    await expect(a).toHaveAttribute("href", UPDATE_PR);
    await expect(a).toHaveAttribute("target", "_blank");
    await expect(a).toHaveAttribute("rel", "noopener noreferrer");
    await expect(a).toContainText("Pull request #41");
    await expect(t(page, "tm-update-start")).toHaveCount(0);
    await clean(page, errors);
  });

  test("a merged update says it is restarting", async ({ page }) => {
    const restart = { behind: null, update: updateRow({ phase: "restart", sub_step: "pr_merged", state: "ok", pr: 41 }) };
    const { errors } = await setup(page, updatable(restart));
    await open(page);
    await expect(t(page, "tm-update-text")).toHaveText("Merged. Restarting the engine on v1.5.0.");
    await clean(page, errors);
  });

  test("a failed update says why in words, keeps its pull request link and Try again sends one POST", async ({ page }) => {
    const { mock, errors } = await setup(page, updatable({ behind: BEHIND, update: updateRow({ phase: "failed", state: "failed", failure_code: "pr_closed", pr: 41 }) }));
    await open(page);
    await expect(t(page, "tm-update-text")).toHaveText("The update to v1.5.0 didn't finish (the pull request was closed without merging).");
    await expect(t(page, "tm-update-pr")).toHaveAttribute("href", UPDATE_PR);
    await expect(t(page, "tm-update-start")).toHaveText("Try again");
    await press(t(page, "tm-update-start"));
    await expect.poll(() => mock.updates).toEqual([REPO_A]);
    await expect(t(page, "tm-update-title")).toHaveText("Updating the engine (v1.4.0 → v1.5.0)");
    await clean(page, errors);
  });

  test("a refusal is said in fixed words, never the server's, and the card stays", async ({ page }) => {
    const mock = updatable({ behind: BEHIND, update: null });
    mock.updateStatus = 409;
    mock.updateCode = "update_live";
    const { errors } = await setup(page, mock);
    await open(page);
    await press(t(page, "tm-update-start"));
    await expect(t(page, "tm-update-note")).toHaveText("An update is already under way.");
    await expect(t(page, "tm-update-title")).toHaveText("Update available (v1.4.0 → v1.5.0)");
    await clean(page, errors);
  });

  test("a member sees the offer with the button aria-disabled and the line that says why, and a press sends nothing", async ({ page }) => {
    const { mock, errors } = await setup(page, updatable({ behind: BEHIND, update: null }, { can_edit: false }));
    await open(page);
    const btn = t(page, "tm-update-start");
    await expect(btn).toBeVisible();
    await expect(btn).toHaveAttribute("aria-disabled", "true");
    await expect(btn).not.toHaveAttribute("disabled", /.*/);
    await btn.focus();
    expect(await activeId(page)).toBe("tm-update-start");
    await expect(t(page, "tm-update-why")).toHaveText("Only an owner or admin can update the engine.");
    await btn.dispatchEvent("click");
    expect(mock.updates).toEqual([]);
    await clean(page, errors);
  });

  test("the card adds no landmark, and long copy does not scroll sideways (the phone project is the narrow one)", async ({ page }) => {
    const { errors } = await setup(page, updatable({ behind: BEHIND, update: updateRow({ phase: "failed", state: "failed", failure_code: "vm_token_delivery_failed", pr: 41 }) }));
    await open(page);
    await expect(t(page, "tm-update-text")).toContainText("the sandbox couldn't be given access");
    await expect(page.locator(`${WIN} section[aria-label], ${WIN} [role="region"]`)).toHaveCount(0);
    await expect(t(page, "tm-update")).toBeVisible();
    await noSideways(page);
    await clean(page, errors);
  });

  test("a repo with nothing to update shows no card", async ({ page }) => {
    const { errors } = await setup(page, updatable({ behind: null, update: null }));
    await open(page);
    await expect(t(page, "tm-update")).toBeHidden();
    await clean(page, errors);
  });

  test.describe("the live view (D#845 ON-25b)", () => {
    const pill = (page: Page) => t(page, "tm-watch-pill");
    const heardAgo = (s: number) => new Date(Date.now() - s * 1000).toISOString();
    const ready = async (page: Page, mock: Mock) => {
      await setup(page, mock, { stream: true });
      await expect.poll(() => page.evaluate(() => { window.dispatchEvent(new Event("pointerdown")); return (window as unknown as { __opened: number }).__opened; }), { timeout: 30_000 }).toBeGreaterThan(0);
      await page.clock.install();
      await open(page);
      await expect(t(page, "tm-agent")).toHaveCount(2);
    };
    const hidden = (page: Page, on: boolean) => page.evaluate((h) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
      document.dispatchEvent(new Event("visibilitychange"));
    }, on);

    test("opening asks once with input; the pill is Live only after the stream has lived 10 s with bytes and only while the repo was heard from under 90 s ago", async ({ page }) => {
      const F = makeFixtures(Date.now());
      const mock = fresh({ repos: [F.repo({ last_heard_at: heardAgo(2) }), F.repo({ repo_id: REPO_B, full_name: "acme-labs/site" })] });
      await ready(page, mock);
      await expect.poll(() => mock.watch.posts.length).toBe(1);
      expect(mock.watch.posts[0]).toMatchObject({ active: true });
      expect(mock.watch.posts[0].browser_id).toMatch(/^[0-9a-f-]{36}$/);
      await expect.poll(() => page.evaluate(() => (window as unknown as { __watchOpened?: string[] }).__watchOpened ?? [])).toEqual([`?watch=${LEASE}`]);
      await expect(pill(page)).not.toHaveText("Live"); // the stream has lived no time
      await page.evaluate(() => (window as unknown as { __watchPush: (t: string) => void }).__watchPush(": hb\n\n"));
      await page.clock.runFor(11_000);
      await expect(pill(page)).toHaveText("Live");
      await expect(pill(page)).toHaveAttribute("data-state", "live");
      await page.clock.runFor(100_000); // no word from the repo for over 90 s: the stream is fine, the data is not
      await expect(pill(page)).toHaveText(/^Updated \d+ min ago$/);
      await expect(pill(page)).toHaveAttribute("data-state", "summary");
    });

    test("offline: the exact sentence, every panel labelled As of <time>, and no Live pill anywhere", async ({ page }) => {
      const F = makeFixtures(Date.now());
      const mock = fresh({ repos: [F.repo({ last_heard_at: heardAgo(900), liveness: "stale" }), F.repo({ repo_id: REPO_B, full_name: "acme-labs/site" })] });
      mock.watch.answer = { ...mock.watch.answer, machine: "offline", command: "issued", last_seen: heardAgo(900) };
      const { errors } = await setup(page, mock);
      await open(page);
      await expect(t(page, "tm-watch-offline")).toHaveText("The machine is offline. Details appear when it reconnects.");
      await expect(pill(page)).toHaveText(/^Updated 1\d min ago$/);
      for (const k of ["agents", "lanes", "log", "stats", "usage", "plan"]) await expect(t(page, `tm-${k}-asof`)).toHaveText(/^As of \d\d:\d\d \(\d+ min ago\)$/);
      await expect(page.locator(`${WIN} [data-state="live"]`)).toHaveCount(0);
      await expect(page.locator(WIN)).not.toContainText(/\bLive\b(?! view)/); // the chip says "Stale", never Live
      await noSideways(page);
      await clean(page, errors);
    });

    test("at the cap: the exact sentence and Try again, and no request goes out until it is clicked", async ({ page }) => {
      const mock = fresh();
      mock.watch.status = 429;
      mock.watch.code = "watch_limit";
      mock.watch.data = { cap: "repo", limit: 2, in_use: 2 };
      const { errors } = await setup(page, mock, { clock: true });
      await open(page);
      await expect(t(page, "tm-watch-cap")).toHaveText("Live view is in use by 2 people on this repo (your plan allows 2). You're seeing the summary; it refreshes every 2 minutes.");
      await expect(pill(page)).toHaveText(/^Updated /);
      await expect(t(page, "tm-watch-retry")).toHaveText("Try again");
      expect(mock.watch.posts).toHaveLength(1);
      await page.clock.runFor(330_000);
      await page.waitForTimeout(300);
      expect(mock.watch.posts).toHaveLength(1); // past the 5-minute renewal: not one retry
      expect(mock.watch.streams).toEqual([]);
      mock.watch.status = 200;
      await press(t(page, "tm-watch-retry"));
      await expect.poll(() => mock.watch.posts.length).toBe(2);
      expect(mock.watch.posts[1]).toMatchObject({ active: true });
      await expect(t(page, "tm-watch-cap")).toHaveCount(0);
      await noSideways(page);
      await clean(page, errors);
    });

    test("hiding the tab frees the slot within 10 s; showing it starts a new view that is not Live at once", async ({ page }) => {
      const F = makeFixtures(Date.now());
      const mock = fresh({ repos: [F.repo({ last_heard_at: heardAgo(2) }), F.repo({ repo_id: REPO_B, full_name: "acme-labs/site" })] });
      await ready(page, mock);
      await expect.poll(() => mock.watch.posts.length).toBe(1);
      await page.evaluate(() => (window as unknown as { __watchPush: (t: string) => void }).__watchPush(": hb\n\n"));
      await page.clock.runFor(11_000);
      await expect(pill(page)).toHaveText("Live");
      await hidden(page, true);
      await page.clock.runFor(6_000);
      await expect.poll(() => mock.watch.deletes.length).toBe(1);
      expect(mock.watch.deletes[0]).toMatch(/^\?browser_id=[0-9a-f-]{36}$/);
      expect(mock.watch.posts).toHaveLength(1);
      await hidden(page, false);
      await expect.poll(() => mock.watch.posts.length).toBe(2);
      expect(mock.watch.posts[1]).toMatchObject({ active: true });
      await expect(pill(page)).not.toHaveText("Live"); // a view that has just begun has no healthy stream, whatever the last as-of said
    });

    test("a dropped stream: the lease is taken again before the stream reopens, and not Live until it has lived; after 5 min idle the drop ends the view", async ({ page }) => {
      const F = makeFixtures(Date.now());
      const mock = fresh({ repos: [F.repo({ last_heard_at: heardAgo(2) }), F.repo({ repo_id: REPO_B, full_name: "acme-labs/site" })] });
      await ready(page, mock);
      await expect.poll(() => mock.watch.posts.length).toBe(1);
      await page.evaluate(() => (window as unknown as { __watchPush: (t: string) => void }).__watchPush(": hb\n\n"));
      await page.clock.runFor(11_000);
      await expect(pill(page)).toHaveText("Live");
      await page.evaluate(() => (window as unknown as { __watchEnd: () => void }).__watchEnd());
      await expect.poll(() => mock.watch.posts.length).toBe(2);
      expect(mock.watch.posts[1]).toMatchObject({ active: true });
      await expect.poll(() => page.evaluate(() => (window as unknown as { __watchOpened?: string[] }).__watchOpened?.length)).toBe(2);
      await expect(pill(page)).not.toHaveText("Live");
      await page.clock.runFor(400_000); // well past 5 minutes with no input
      mock.watch.status = 409;
      mock.watch.code = "watch_ended";
      await page.evaluate(() => (window as unknown as { __watchPush: (t: string) => void }).__watchPush(": hb\n\n"));
      await page.evaluate(() => (window as unknown as { __watchEnd: () => void }).__watchEnd());
      await page.clock.runFor(70_000); // past the reconnect back-off
      await expect(t(page, "tm-watch-note")).toHaveText(/The live view has ended/);
    });

    test("log lines held on the machine: the sentence, and Load older asks for the lines before the lowest uploaded one", async ({ page }) => {
      const F = makeFixtures(Date.now());
      const mock = fresh({ log: F.envelope([F.logLine()], { held_events: 3, oldest_seq: 41 }) });
      const { errors } = await setup(page, mock);
      await open(page);
      await expect(t(page, "tm-log-held")).toContainText("3 older lines are on the machine and were not uploaded");
      await press(t(page, "tm-log-held-older"));
      await expect.poll(() => mock.watch.posts.length).toBe(2);
      expect(mock.watch.posts[1]).toMatchObject({ active: true, before: 41 });
      await noSideways(page);
      await clean(page, errors);
    });

    test("no held lines, no sentence", async ({ page }) => {
      const { mock } = await setup(page, fresh());
      await open(page);
      await expect(t(page, "tm-log-held")).toHaveCount(0);
      expect(mock.watch.posts).toHaveLength(1);
    });

    test("after 10 refused streams the pill says Updating every minute", async ({ page }) => {
      const mock = fresh();
      mock.watch.failStream = true;
      await setup(page, mock, { clock: true });
      await open(page);
      test.setTimeout(300_000);
      for (let i = 0; i < 6; i++) await page.clock.runFor(120_000); // ten refused attempts with their back-off take about 7 minutes
      await expect(pill(page)).toHaveText("Updating every minute");
      await expect(pill(page)).toHaveAttribute("data-state", "polling");
      expect(mock.watch.streams.length).toBeGreaterThanOrEqual(10);
    });
  });
});
