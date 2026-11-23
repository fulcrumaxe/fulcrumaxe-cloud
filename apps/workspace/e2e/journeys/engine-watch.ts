// apps/workspace/e2e/journeys/engine-watch.ts
//
// What the engine-watch journeys (../engine-watch-journeys.spec.ts) stand on: a stateful stand-in for the cloud's engine routes, the operator who does what
// a person does outside the browser (spawns an agent, posts a log line, stops the bridge), and the ledger of numbers. The same journeys run in two modes:
//   dry   (default)  against the fixture server: the stand-in answers, and the operator changes its state.
//   live             against a deployed staging app; see engine-watch.md. Nothing is stubbed and the operator only says what to do.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, type Route } from "@playwright/test";
import { REPO_A, REPO_B, SESSION, makeFixtures } from "../../test/fixtures/team/fixtures.mjs";

export const LIVE = process.env.JOURNEY_MODE === "live";
/** The only hosts a live run may point at: the staging app, and preview deployments of the cloud-staging project. Anything else (production included) is refused, however many times it is named. */
export const STAGING_HOST = /^(?:cloud-staging\.vercel\.app|cloud-staging-[a-z0-9-]+-formalhosting\.vercel\.app)$/;
export function stagingOrigin(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  return u.protocol === "https:" && u.username === "" && u.password === "" && u.port === "" && STAGING_HOST.test(u.hostname) && u.origin === raw.replace(/\/+$/, "") ? u.origin : null;
}
export const WIN = (id: string) => `#windows-container .fulc-window[data-app-id="${id}"]`;
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The cloud as the Team app sees it. Times are held as epoch ms so a test can say "the bridge went quiet 5 min ago". */
export class Engine {
  F = makeFixtures(Date.now());
  watch = true;
  repos = [{ id: REPO_A, name: "acme-labs/widgets", on: true, ok: true }, { id: REPO_B, name: "acme-labs/site", on: false, ok: false }];
  heardAt = Date.now() - 20_000;
  agents: Obj[] = [];
  lanes: Obj[] = [];
  logTotal = 3;
  planItems = 2;
  asks: Obj[] = [];
  missing = 0;
  usd = 1234.5678;
  queued = 0;
  streaming = true;
  frame: string | null = null;
  get heard() { return Math.floor((Date.now() - this.heardAt) / 1000); }
  private env(items: unknown[], over: Obj = {}) { return this.F.envelope(items, { heard_age_s: this.heard, missing_events: this.missing, gaps: this.missing ? [{ before_ts: this.F.iso(600) }] : [], ...over }); }
  /** One page of the log: 100 lines from the cursor (an offset), newest first. Ids count up with time, so a new event is a new first id, as on the real log. */
  private page(n: number, cursor: string) { const from = Number(cursor || 0); return { from, rows: Array.from({ length: Math.max(0, Math.min(100, n - from)) }, (_, i) => this.F.logLine({ line_id: "l" + String(Math.max(0, n - 1 - (from + i))).padStart(15, "0"), ts: this.F.iso(60 + (from + i) * 2) })), more: from + 100 < n }; }
  /** The answer to one engine read, or null for a path this stand-in does not know. */
  read(path: string, q: URLSearchParams): Obj | null | undefined {
    const F = this.F;
    if (path === "settings") return F.settings({ watch_enabled: this.watch, repos: this.repos.map((r) => F.settingsRepo({ repo_id: r.id, full_name: r.name, enabled: r.on, eligible: r.ok, refusal: r.ok ? null : "public_repo" })) });
    if (path === "repos") return { ...this.env([]), items: this.repos.filter((r) => r.on).map((r) => F.repo({ repo_id: r.id, full_name: r.name, liveness: this.heard > 180 ? "stale" : "live", last_heard_at: new Date(this.heardAt).toISOString(), session_id: SESSION })) };
    const kind = path.split("/")[2];
    if (kind === "agents") return this.env(this.agents.filter((a) => !a.stopped).map((a) => F.agent({ agent_id: a.id, role: a.role, discussion: a.d, started_at: new Date(a.at).toISOString() })));
    if (kind === "lanes") return this.env(this.lanes.map((l) => F.lane({ pr: l.pr, discussion: l.d, state: l.state })));
    if (kind === "gates") return this.env(this.lanes.flatMap((l) => Array.from({ length: l.gates }, (_, i) => F.gate({ pr: l.pr, gate: ["gate1", "code_review", "ci_full"][i % 3] }))));
    if (kind === "log") { const p = this.page(this.logTotal, q.get("cursor") ?? ""); return this.env(p.rows, { next_cursor: p.more ? String(p.from + 100) : null }); }
    if (kind === "plan") return this.planItems < 0 ? undefined : F.plan({ items: Array.from({ length: this.planItems }, (_, i) => ({ discussion: 100 + i, ordinal: i + 1, state: "planned" })), roadmap: [], heard_age_s: this.heard, missing_events: this.missing });
    if (kind === "stats") return F.stats({ heard_age_s: this.heard, missing_events: this.missing, agents_by_role: { value: {}, provenance: F.prov(0) }, merges: { value: this.lanes.filter((l) => l.state === "merged").length, provenance: F.prov(0) } });
    if (kind === "usage") return F.usage({ heard_age_s: this.heard, items: this.usd === 0 ? [] : [F.usageItem({ api_equivalent_usd: this.usd })], totals: { api_equivalent_usd: this.usd, tokens: { input: 1, output: 1, cache_read: 0, cache_write: 0 } } });
    if (kind === "asks") return this.env(this.asks.map((a) => ({ ask_id: a.id, ask_kind: "owner_decision", source: "team_log", discussion: a.d, pr: null, raised_at: F.iso(120), cleared_at: null, how: null })));
    return null;
  }
  write(path: string, body: Obj): void {
    if (path === "settings") {
      if (typeof body.watch_enabled === "boolean") { this.watch = body.watch_enabled; if (this.watch) { this.logTotal += this.queued; this.queued = 0; } }
      if (Array.isArray(body.repo_ids)) for (const r of this.repos) r.on = body.repo_ids.includes(r.id);
    } else if (path === "settings/delete-data") { this.agents = []; this.lanes = []; this.logTotal = 0; this.planItems = -1; this.usd = 0; this.asks = []; this.missing = 0; }
  }
}

/** Every call the page makes to /api/v1, answered from `engine` (dry mode only). */
export async function serve(page: Page, engine: Engine) {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  if (LIVE) return errors;
  const fx = (n: string) => JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "packages", "api", "fixtures", "v1", n, "200-ok.json"), "utf8"));
  await page.route("**/api/cloud/auth/me", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), is_admin: true } });
  });
  await page.route("**/api/v1/events", async (route) => {
    if (!engine.streaming) return new Promise<void>(() => {});
    const body = engine.frame ?? "event: idle\ndata: {}\n\n";
    engine.frame = null;
    await route.fulfill({ status: 200, contentType: "text/event-stream", headers: { "cache-control": "no-store" }, body });
  });
  await page.route((u) => u.pathname.startsWith("/api/v1/") && u.pathname !== "/api/v1/events", async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname.slice("/api/v1/".length);
    if (/^engine\/repos\/[^/]+\/watch$/.test(p) && (req.method() === "POST" || req.method() === "DELETE")) { // the Team app's live view: a slot is always free in the stand-in
      const now = Date.now();
      return json(route, 200, req.method() === "DELETE" ? { released: true } : { lease_id: "5a1f3c52-7a0e-4c1a-9a53-0b1d2e3f4a55", expires_at: new Date(now + 90_000).toISOString(), session_ends_at: new Date(now + 4 * 3600_000).toISOString(), limits: { per_repo: 2, per_account: 4 }, command: "held", machine: "online", last_seen: new Date(now).toISOString(), detail_as_of: null });
    }
    if (p.startsWith("engine/")) {
      if (req.method() === "PUT") { engine.write(p.slice(7), (req.postDataJSON() ?? {}) as Obj); return json(route, 200, { ok: true }); }
      const body = engine.read(p.slice(7), u.searchParams);
      return body === undefined ? route.fulfill({ status: 204 }) : body === null ? json(route, 404, { error: { code: "not_found", message: "x", request_id: "r" } }) : json(route, 200, body);
    }
    if (p === "usage") return json(route, 200, { ...fx("getUsage"), engine_api_equivalent_usd: engine.usd, own_plan_api_equivalent_usd: 0 });
    if (p === "budgets" || p === "account") return json(route, 200, fx(p === "budgets" ? "getBudgets" : "getAccount"));
    const other: Obj = { "setup-requests": { requests: [], truncated: false }, "merge-ready": { items: [], not_shown: 0 }, "stalled-items": { items: [], not_shown: 0 }, "verify-sign-in": { items: [] }, "decision-asks": { data: [], next_cursor: null }, "work-items": { data: [], next_cursor: null } };
    if (p in other) return json(route, 200, other[p]);
    return json(route, 404, { error: { code: "not_found", message: "x", request_id: "r" } });
  });
  return errors;
}

/** What a person (or the Team Lead) does outside the browser. Dry: change the stand-in. Live: say what to do, and the journey waits for the screen to change. */
export class Operator {
  constructor(private page: Page, readonly engine: Engine) {}
  /** Words a log line carries on the engine's machine; they are never given to the stand-in, so a page-text check for them means something only in live mode. */
  readonly secret = "zebra-quartz-ledger";
  async do(what: string, change: () => void) {
    if (LIVE) { console.log(`OPERATOR: ${what}`); return; }
    change();
    // The same signal the cloud sends: engine.changed, ids only. The page reads again a second later.
    const e = this.engine;
    e.streaming = true;
    e.frame = `id: c-${Math.random().toString(36).slice(2)}\nevent: engine.changed\ndata: ${JSON.stringify({ id: "e1", type: "engine.changed", created_at: new Date().toISOString(), data: { repo_id: REPO_A, session_id: SESSION, last_seq: 9 } })}\n\n`;
    await expect.poll(async () => { if (e.frame !== null) await this.page.evaluate(() => window.dispatchEvent(new Event("pointerdown"))); return e.frame; }, { timeout: 30_000 }).toBeNull();
  }
}

/** The numbers each journey records: printed, and attached to the test so a run's report carries them. */
export function record(test: { info(): { annotations: { type: string; description?: string }[] } }, id: string, label: string, value: string | number) {
  test.info().annotations.push({ type: `${id} ${label}`, description: String(value) });
  console.log(`LEDGER ${LIVE ? "live" : "dry"} ${id} ${label} = ${value}`);
}

/** The ids of the log rows now drawn, newest first. The panel draws at most 100 rows, so a row count cannot show that events arrived; ids can. */
export const logIds = (page: Page) => page.locator(`${WIN("team")} [data-testid="tm-log-line"]`).evaluateAll((els) => els.map((e) => e.getAttribute("data-id") ?? ""));

type Clock = { at: number | null; t: ReturnType<typeof setInterval> };
/** Starts a clock that runs from the first change on screen, not from the moment the operator step is printed. The Team window's text is compared with its ages and clock times removed (they tick on their own), polled in the page. Call before the operator step; the returned function reads the seconds. */
export async function armClock(page: Page, app = "team") {
  await page.evaluate((sel) => {
    const w = window as unknown as { __clk?: Clock };
    if (w.__clk) clearInterval(w.__clk.t);
    const sig = () => (document.querySelector(sel) as HTMLElement | null)?.innerText.replace(/\b\d+\s?(?:s|sec|seconds?|m|min|minutes?|h|hours?)\b(?: ago)?/gi, "").replace(/\d{1,2}:\d{2}/g, "") ?? "";
    const first = sig();
    const clk: Clock = { at: null, t: setInterval(() => { if (clk.at === null && sig() !== first) clk.at = Date.now(); }, 100) };
    w.__clk = clk;
  }, WIN(app));
  return () => page.evaluate(() => {
    const clk = (window as unknown as { __clk?: Clock }).__clk;
    const at = clk?.at ?? Date.now(); // never seen to change before the target showed: it all arrived at once, so 0 s
    if (clk) clearInterval(clk.t);
    return Math.round((Date.now() - at) / 1000);
  });
}

/** Records every merge-lane state the page shows, so a state that flashes past between two reads is still known to have been seen. */
export async function watchLane(page: Page) {
  await page.evaluate((sel) => {
    const w = window as unknown as { __laneSeen?: string[] };
    const seen: string[] = (w.__laneSeen = []);
    const scan = () => document.querySelectorAll(`${sel} [data-testid="tm-lane-state"]`).forEach((n) => { const v = (n.textContent ?? "").trim(); if (v && !seen.includes(v)) seen.push(v); });
    new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, characterData: true });
    scan();
  }, WIN("team"));
  return () => page.evaluate(() => (window as unknown as { __laneSeen?: string[] }).__laneSeen ?? []);
}
