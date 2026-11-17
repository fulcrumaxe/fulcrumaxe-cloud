// apps/workspace/e2e/helpers/journey.ts
//
// What the operate journeys share: the mode (a dry run on the fixture server, or a live run on a deployed app), the ledger, the numbers only the
// runner's machine can give, and FakeCloud, a stateful stand-in for the engine routes (dry run only; a live run routes nothing). It answers in the
// documented shapes and moves a command pending -> delivered -> applied (or refused) on timers, so the same clicks run in both modes.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { Page, Route } from "@playwright/test";
import { REPO_A, makeFixtures } from "../../test/fixtures/team/fixtures.mjs";
export const LIVE = process.env.JOURNEY_LIVE === "1";
/** How long a live wait may take (a command is applied within minutes, an agent within 15); a dry run waits seconds. */
export const WAIT = LIVE ? Number(process.env.JOURNEY_WAIT_MS ?? 20 * 60_000) : 20_000;
type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
/** The only places a live run may point at: the cloud-staging project's own host and its preview deployments. Never production, never another project. */
const STAGING_HOST = /^cloud-staging\.vercel\.app$|^cloud-staging-([a-z0-9]{9}|git-[a-z0-9-]+)-formalhosting\.vercel\.app$/;
export function isStagingHost(host: string): boolean {
  return STAGING_HOST.test(host);
}
/** A live run needs the origin named twice (so a stray variable can never point it at the wrong place) and it must be a staging host, whatever is typed twice. */
export function liveOrigin(): string | null {
  if (!LIVE) return null;
  const o = process.env.JOURNEY_ORIGIN ?? "";
  if (o === "" || o !== process.env.JOURNEY_CONFIRM_ORIGIN) throw new Error("a live run needs JOURNEY_ORIGIN and the same value in JOURNEY_CONFIRM_ORIGIN");
  let u: URL;
  try { u = new URL(o); } catch { throw new Error("JOURNEY_ORIGIN is not a URL"); }
  if (u.protocol !== "https:" || u.port !== "" || u.origin !== o || !isStagingHost(u.hostname)) throw new Error(`refusing ${u.hostname}: a live run goes only to cloud-staging.vercel.app or a *-formalhosting.vercel.app preview of the cloud-staging project, as a bare https origin`);
  return o;
}
/** The saved sign-in must be a real file, so a typo fails at the start and not as a signed-out page. */
export function storageStateFile(): string {
  const f = process.env.JOURNEY_STORAGE_STATE ?? "";
  if (f === "" || !existsSync(f) || !statSync(f).isFile()) throw new Error("JOURNEY_STORAGE_STATE must name an existing saved sign-in file");
  return f;
}
/** The repository a live run works on, as the Team picker names it. */
export const repoName = () => process.env.JOURNEY_REPO ?? "fulcrumaxe/cloud";
/** A step nothing takes back by itself (a halt, a stop, operate off) needs the repository's name typed again. A dry run touches nothing real and needs none. */
export function confirmDestructive(step: string): void {
  if (LIVE && process.env.JOURNEY_CONFIRM_REPO !== repoName()) throw new Error(`${step} is destructive: set JOURNEY_CONFIRM_REPO to the repository name (${repoName()}) to run it live`);
}
const LEDGER = process.env.JOURNEY_LEDGER ?? "test-results/journey-ledger.jsonl";
/** One ledger row: the journey, the number's name and its value. Rows are appended as JSON lines and echoed. */
export function ledger(journey: string, name: string, value: number | string | boolean, source: "ui" | "machine" | "fixture" = "ui"): void {
  const row = JSON.stringify({ at: new Date().toISOString(), mode: LIVE ? "live" : "dry", journey, name, value, source });
  mkdirSync(dirname(LEDGER), { recursive: true });
  appendFileSync(LEDGER, row + "\n");
  console.log("LEDGER " + row);
}
/** A number only the machine can give (ticks, systemd-cgls counts, event rows). Live: read from JOURNEY_MACHINE_FILE, and its absence fails the journey. Dry: the fixture's value. */
export function machine(journey: string, name: string, dry: number | string): number | string {
  let v: number | string = dry;
  if (LIVE) {
    const file = process.env.JOURNEY_MACHINE_FILE ?? "";
    const given = file === "" ? undefined : (JSON.parse(readFileSync(file, "utf8")) as Obj)[`${journey}.${name}`];
    if (given === undefined) throw new Error(`machine number ${journey}.${name} was not supplied in JOURNEY_MACHINE_FILE`);
    v = given;
  }
  ledger(journey, name, v, LIVE ? "machine" : "fixture");
  return v;
}
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const err = (route: Route, status: number, code: string) => json(route, status, { error: { code, message: "server text that must never be shown", request_id: "r" } });
export class FakeCloud {
  F = makeFixtures(Date.now());
  settings = this.F.settings({ operate_enabled: true });
  repo = this.F.repo({ operate_enabled: true });
  commands: Obj[] = [];
  dials = this.F.dials();
  agents: Obj[] = [this.F.agent({ agent_id: "b2c3d4e5f6071829", role: "code-reviewer", discussion: 43 })];
  asks: Obj[] = [{ ask_id: "0123456789abcdef", ask_kind: "owner_decision", source: "team_log", discussion: 42, pr: 7, raised_at: new Date(Date.now() - 3600_000).toISOString(), cleared_at: null, how: null }];
  /** Every POST to the command or dial route, and every halt: what a locked control must leave unchanged. */
  posts: Obj[] = [];
  halts: string[] = [];
  /** The next command is refused with this code; `hold` keeps new commands pending (the runner is away). */
  refuse: string | null = null;
  hold = false;
  deliverMs = 300;
  applyMs = 700;
  private frame: string | null = null;
  private timers: NodeJS.Timeout[] = [];
  private envelope = (items: Obj[]) => this.F.envelope(items);
  private change() { this.frame = `id: c-${Date.now()}\nevent: engine.changed\ndata: ${JSON.stringify({ id: "e1", type: "engine.changed", created_at: new Date().toISOString(), data: { repo_id: REPO_A, session_id: REPO_A, last_seq: 9 } })}\n\n`; }
  private later(ms: number, fn: () => void) { this.timers.push(setTimeout(() => { fn(); this.change(); }, ms)); }
  private mutate(id: string, over: Obj) { this.commands = this.commands.map((c) => (c.id === id ? { ...c, ...over } : c)); }
  /** Whether a live engine session exists for the repo (the real route answers 409 `engine_not_connected` without one). */
  connected = true;
  /** The real route's refusals (engine-commands.ts), in its order: operate off, no engine session, twenty waiting (counted before the insert), then a halt (the insert's trigger refuses it). Null means the command is accepted. */
  private conflict(kind: string): string | null {
    if (!this.settings.operate_enabled || !this.repo.operate_enabled) return "operate_off";
    if (!this.connected) return "engine_not_connected";
    if (this.commands.filter((c) => c.state === "pending" && new Date(c.expires_at).getTime() > Date.now()).length >= 20) return "too_many_pending";
    if (this.repo.halted && ["start_day", "resume_loop", "request_spawn", "set_dial"].includes(kind)) return "halted";
    return null;
  }
  private issue(route: Route, body: Obj) {
    const refused = this.conflict(body.kind);
    if (refused) return err(route, 409, refused);
    const id = `c0000000-0000-4000-8000-${String(this.commands.length + 1).padStart(12, "0")}`;
    const expires = new Date(Date.now() + 600_000).toISOString();
    this.commands = [this.F.command({ id, kind: body.kind, args: body.args, expires_at: expires }), ...this.commands];
    if (this.hold) return json(route, 201, { command_id: id, state: "pending", expires_at: expires });
    const refusal = this.refuse;
    this.refuse = null;
    this.later(this.deliverMs, () => this.mutate(id, { state: "delivered", delivered_at: new Date().toISOString() }));
    this.later(this.applyMs, () => {
      const at = new Date().toISOString();
      if (refusal) return this.mutate(id, { state: "refused", refusal, acked_at: at });
      this.mutate(id, { state: "applied", acked_at: at });
      if (body.kind === "request_spawn") this.agents = [...this.agents, this.F.agent({ agent_id: "d4e5f6a7b8091021", role: body.args.role, discussion: body.args.discussion })];
      if (body.kind === "stop_agent") this.agents = this.agents.filter((a) => a.agent_id !== body.args.agent_id);
      if (body.kind === "answer_ask") this.asks = [];
    });
    return json(route, 201, { command_id: id, state: "pending", expires_at: expires });
  }
  async install(page: Page): Promise<void> {
    // The live stream: a queued frame is handed over once, and a poke makes the page reopen the stream (the same trick the other Team specs use).
    await page.route("**/api/v1/events", (route) => {
      // With nothing queued the stream answers "idle" and closes, so a poke can reopen it (a request left hanging would never see the next frame).
      const body = this.frame ?? "event: idle\ndata: {}\n\n";
      this.frame = null;
      return route.fulfill({ status: 200, contentType: "text/event-stream", headers: { "cache-control": "no-store" }, body });
    });
    this.timers.push(setInterval(() => { if (this.frame !== null) page.evaluate(() => window.dispatchEvent(new Event("pointerdown"))).catch(() => {}); }, 250));
    await page.route((u) => u.pathname.startsWith("/api/v1/repos/") && u.pathname.includes("/decision-settings"), (route) => {
      const req = route.request();
      if (req.method() === "GET") return json(route, 200, this.dials);
      const body = req.postDataJSON() as Obj;
      this.posts.push({ path: new URL(req.url()).pathname, body });
      this.dials = { ...this.dials, dials: this.dials.dials.map((d: Obj) => (d.decision_type === body.decision_type ? { ...d, disposition: body.disposition } : d)) };
      return json(route, 200, this.dials);
    });
    await page.route((u) => u.pathname.startsWith("/api/v1/engine/"), (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const p = url.pathname;
      const post = req.method() === "POST" || req.method() === "PUT" ? ((req.postDataJSON() ?? {}) as Obj) : {};
      if (req.method() === "GET") {
        const reads: Obj = { settings: this.settings, repos: this.envelope([this.repo]), commands: { commands: this.commands }, agents: this.envelope(this.agents), asks: this.envelope(this.asks), lanes: this.envelope([]), gates: this.envelope([]) };
        const body = reads[p.slice(p.lastIndexOf("/") + 1)];
        if (body) return json(route, 200, body);
      }
      if (req.method() === "PUT" && p.endsWith("/settings")) {
        const on = (post as Obj).operate_enabled;
        if (typeof on === "boolean") { this.settings = { ...this.settings, operate_enabled: on }; this.repo = { ...this.repo, operate_enabled: on }; }
        return json(route, 200, { ok: true });
      }
      if (req.method() === "POST" && p.endsWith("/commands")) {
        this.posts.push({ path: p, body: post });
        return this.issue(route, post);
      }
      if (req.method() === "DELETE") {
        const c = this.commands.find((x) => p.endsWith("/" + x.id));
        if (!c || c.state !== "pending") return err(route, 409, "already_delivered");
        this.mutate(c.id, { state: "cancelled" });
        return json(route, 200, { command_id: c.id, state: "cancelled" });
      }
      const h = p.match(/\/halt(\/clear)?$/);
      if (req.method() === "POST" && h) {
        this.halts.push(h[1] ? "clear" : "halt");
        this.repo = { ...this.repo, halted: !h[1], halt_pending: !h[1] };
        if (!h[1]) this.later(this.applyMs, () => { this.repo = { ...this.repo, halt_pending: false }; });
        return json(route, 200, h[1] ? { halt_epoch: 1, halted: false } : { halt_epoch: 1, halted: true, applied: false });
      }
      return err(route, 404, "not_found");
    });
    await page.route((u) => u.pathname.startsWith("/api/v1/") && !u.pathname.startsWith("/api/v1/engine/") && !u.pathname.includes("decision-settings") && u.pathname !== "/api/v1/events", (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p === "/api/v1/setup-requests") return json(route, 200, { requests: [], truncated: false });
      if (p === "/api/v1/merge-ready" || p === "/api/v1/stalled-items") return json(route, 200, { items: [], not_shown: 0 });
      if (p === "/api/v1/verify-sign-in") return json(route, 200, { items: [] });
      return json(route, 200, { data: [], next_cursor: null });
    });
  }
  dispose(): void { for (const t of this.timers) { clearTimeout(t); clearInterval(t); } this.timers = []; }
}
