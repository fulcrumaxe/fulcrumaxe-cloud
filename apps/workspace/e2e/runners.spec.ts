// apps/workspace/e2e/runners.spec.ts
//
// D#605 FL-9: the Runners app (the fleet page) on the built cloud dist, served by fixture-server.mjs. Every call the window makes is answered by
// page.route(). The logic half (one request per click, the sentences, the account line, the commands) is in test/runners-fleet.test.mjs; this file
// covers what needs the real DOM: that no state is shown by colour alone, every control is keyboard-reachable and focus comes back after each dialog
// (axe, under every theme), a double click is one POST, a disabled control shows its reason, a secret is shown once, and that no null, undefined or id
// reaches the page.

import { test, expect, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { waitForDesktop } from "./helpers/boot";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// D#845 MC-10b1: the Servers tab's answers are the contract fixtures (packages/api/fixtures/v1/**, checked against each route's schema by packages/api/test/contract.test.ts).
const V1 = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "api", "fixtures", "v1");
const fx = (op: string, name: string) => JSON.parse(readFileSync(join(V1, op, name), "utf8")) as Record<string, unknown>;

const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const SERVER_TEXT = "server text that must never be shown";
const ME = "33333333-3333-4333-8333-333333333333";
const R1 = "44444444-4444-4444-8444-444444444441";
const R2 = "44444444-4444-4444-8444-444444444442";
const R3 = "44444444-4444-4444-8444-444444444443";
const REPO_WEB = "99999999-9999-4999-8999-999999999991";
const REPO_API = "99999999-9999-4999-8999-999999999992";
const TOKEN = ["fxrp", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0"].join("_"); // gitleaks:allow
const ok = { allowed: true, reason: null };
const OWN = { pause: ok, drain: ok, resume: { allowed: false, reason: "Not paused." }, rename: ok, remove: ok };
const NOT_MINE = "Only the person who registered this runner, or an owner or admin, can do this.";
const THEMES = ["classic-crt", "retro-amber", "nord", "corporate", "modern-flat", "crystal", "orchard", "cyberpunk"];

const runner = (over: Record<string, unknown> = {}) => ({
  id: R1, credential_mode: "api_key", registered_by: { id: ME, name: "Ada Admin" }, binary_version: "0.9.1", last_seen_at: "2026-10-15T11:59:00.000Z", state: "online_idle", state_note: null,
  revoked_reason: null, sandbox_unavailable: null, plan_consent: { granted: false, changed_at: null }, can_change_plan_consent: false, repos: [{ id: REPO_WEB, name: "acme/web" }, { id: REPO_API, name: "acme/api" }],
  running: { light: 1, heavy: 0 }, capacity: { light: { limit: 8, in_use: 1 }, heavy: { limit: 4, in_use: 0 }, total_limit: 8, limited_by: null }, load_label: null, provisioning: null,
  name: "Desktop", has_name: true, labels: ["gpu"], facts: { os: "macos", arch: "arm64", engine: "os_sandbox" }, current_runs: [], paused: false, draining: false, controls: OWN, register_again: null, ...over,
});
const REPOS = {
  data: [
    { id: REPO_WEB, product: "web", gh_repo_id: 1, install_state: "installed", app_kind: "team", full_name: "acme/web" },
    { id: REPO_API, product: "api", gh_repo_id: 2, install_state: "installed", app_kind: "team", full_name: "acme/api" },
  ],
  next_cursor: null,
};

const sbBox = (name: string, over: Record<string, unknown> = {}) => ({ name, state: "stopped", created_at: "2026-10-13T12:00:00.000Z", last_used_at: null, disk_bytes: 1500000000, snapshot_count: 2, snapshot_newest_secs: 7200, ...over });
const cmd = (n: number, state: string, over: Record<string, unknown> = {}) => ({ id: `77777777-7777-4777-8777-77777777770${n}`, kind: "delete_sandbox", name: "web-2", state, refusal: null, issued_at: "2026-10-15T11:58:00.000Z", expires_at: "2026-10-15T12:03:00.000Z", ...over });
const sandboxView = (over: Record<string, unknown> = {}) => ({
  status: "current", seen_at: "2026-10-15T11:55:00.000Z", can_command: true, limits: { vms: 4, vcpus: 16, memory_mb: 32768, templates: ["base-a"] },
  sandboxes: [sbBox("web-1", { state: "running", last_used_at: "2026-10-15T11:00:00.000Z" }), sbBox("web-2")], commands: [], ...over,
});

interface Mock {
  runners: unknown[];
  role: "owner" | "admin" | "member";
  account: Record<string, unknown>;
  tokens: Array<Record<string, unknown>>;
  posts: Array<{ path: string; body: unknown }>;
  deletes: string[];
  mintStatus: number;
  mintDelay: number;
  runFetches: string[];
  isAdmin: boolean;
  /** PING-UX: how many times the fleet was read, and whether the next reads fail. */
  gets: number;
  getFails: boolean;
  /** PING-UX: what the runner reads after a Check runner now press (and after each later read). */
  checkReplies: Array<Record<string, unknown>>;
  /** D#587 B-7b-ii: when set, a POST to a sandbox-commands route is refused with this status and code instead of queuing a command. */
  sandboxRefusal: { status: number; code: string } | null;
  /** D#845 MC-10a: what GET /api/machines answers, and whether it fails. */
  machines: unknown[];
  machinesFail: boolean;
  /** D#845 MC-10b1: the Hetzner credential, the servers, the catalog and the quote, and what the app sent. */
  hz: Hz;
}
interface Answer { status: number; code: string; retryAfter?: number }
interface Hz {
  credential: Record<string, unknown>;
  credentialFail: number;
  servers: unknown[];
  serversFail: boolean;
  catalogFail: boolean;
  quoteFail: boolean;
  quoteDelay: number;
  /** How long a create waits before it answers, and how many times the server list was read. */
  createDelay: number;
  listReads: number;
  /** Fields of the quote the cloud answers (a live price that moved). */
  quotePatch: Record<string, unknown>;
  /** The refusal the next connect gets; null connects. */
  connect: Answer | null;
  /** The refusals the next creates get, one each; empty creates. */
  creates: Answer[];
  removeFail: number;
  connects: Array<{ token?: string }>;
  created: Array<{ body: { quoted?: { monthly_gross?: string } }; key: string | undefined }>;
  removes: number;
  quotes: string[];
  /** D#845 MC-10b2: every server action, sign-in step and move the app sent; the refusals the next ones get (one each); what a runner's sign-in read answers. */
  acts: Array<{ method: string; path: string; body: unknown }>;
  actRefusals: Answer[];
  login: Record<string, unknown>;
}
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const hzDefaults = (): Hz => ({
  credential: fx("getHetznerCredential", "200-none.json"), credentialFail: 0, servers: (fx("listHetznerServers", "200-list.json").servers as unknown[]).slice(1), serversFail: false, catalogFail: false, quoteFail: false, quoteDelay: 0, createDelay: 0, listReads: 0, quotePatch: {},
  connect: null, creates: [], removeFail: 0, connects: [], created: [], removes: 0, quotes: [], acts: [], actRefusals: [], login: {},
});
const refusal = (route: Route, status: number, code: string, retryAfter?: number) =>
  route.fulfill({ status, contentType: "application/json", headers: retryAfter ? { "Retry-After": String(retryAfter) } : {}, body: JSON.stringify({ error: { code, message: SERVER_TEXT, request_id: "r" } }) });

async function setup(page: Page, tweak: Omit<Partial<Mock>, "hz"> & { hz?: Partial<Hz> } = {}) {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP ${e.violatedDirective}`)));
  const mock: Mock = {
    runners: [runner()], role: "admin", account: { limit: 16, capacity: 8, running: 1, runner_count: 1, runner_limit: 5 }, tokens: [], posts: [], deletes: [], mintStatus: 201, mintDelay: 0, runFetches: [], isAdmin: true, gets: 0, getFails: false, checkReplies: [], sandboxRefusal: null, machines: [], machinesFail: false, ...tweak, hz: { ...hzDefaults(), ...tweak.hz },
  };
  const hz = mock.hz;
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  await page.route("**/api/cloud/auth/me", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), is_admin: mock.isAdmin } });
  });
  await page.route("**/api/v1/events", () => new Promise<void>(() => {}));
  await page.route((u) => u.pathname.startsWith("/api/runners") || u.pathname === "/api/machines" || (u.pathname.startsWith("/api/v1/") && u.pathname !== "/api/v1/events"), async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if ((req.headers()["accept"] ?? "").includes("text/event-stream")) return route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: idle\ndata: {}\n\n" });
    if (p.startsWith("/api/v1/runs/")) mock.runFetches.push(p.split("/")[4]!);
    if (p === "/api/v1/repos") return json(route, 200, REPOS);
    if (p === "/api/machines") return mock.machinesFail ? json(route, 503, { error: { code: "unavailable", message: SERVER_TEXT, request_id: "r" } }) : json(route, 200, { machines: mock.machines });
    if (p === "/api/v1/machine-credentials/hetzner") {
      if (req.method() === "GET") return hz.credentialFail ? refusal(route, hz.credentialFail, hz.credentialFail === 403 ? "forbidden" : "unavailable") : json(route, 200, hz.credential);
      if (req.method() === "DELETE") {
        hz.removes++;
        if (hz.removeFail) return refusal(route, hz.removeFail, "server_error");
        hz.credential = fx("getHetznerCredential", "200-none.json");
        return route.fulfill({ status: 204 });
      }
      hz.connects.push(JSON.parse(req.postData() ?? "{}"));
      if (hz.connect) return refusal(route, hz.connect.status, hz.connect.code, hz.connect.retryAfter);
      hz.credential = fx("getHetznerCredential", "200-connected.json");
      return json(route, 201, fx("connectHetznerCredential", "201-connected.json"));
    }
    if (p === "/api/v1/machine-servers" && req.method() === "GET") hz.listReads++;
    if (p === "/api/v1/machine-servers" && req.method() === "GET") return hz.serversFail ? refusal(route, 503, "unavailable") : json(route, 200, { servers: hz.servers });
    if (p === "/api/v1/machine-servers" && req.method() === "POST") {
      hz.created.push({ body: JSON.parse(req.postData() ?? "{}"), key: req.headers()["idempotency-key"] });
      const answer = hz.creates.shift();
      if (hz.createDelay) await new Promise((r) => setTimeout(r, hz.createDelay));
      if (answer && answer.status === 0) return route.abort("connectionreset"); // the answer never arrives: an unknown outcome
      if (answer) return refusal(route, answer.status, answer.code, answer.retryAfter);
      hz.servers = [fx("createHetznerServer", "201-creating.json"), ...hz.servers];
      return json(route, 201, hz.servers[0]);
    }
    if (p === "/api/v1/machine-servers/catalog") {
      if (hz.catalogFail) return refusal(route, 503, "hetzner_unavailable");
      const where = new URL(req.url()).searchParams.get("location");
      return json(route, 200, fx("getHetznerCatalog", where === "fsn1" || where === "nbg1" ? `200-${where}.json` : "200-all-locations.json"));
    }
    if (p === "/api/v1/machine-servers/quote") {
      const q = new URL(req.url()).searchParams;
      hz.quotes.push(`${q.get("server_type")} ${q.get("location")}`);
      if (hz.quoteDelay) await new Promise((r) => setTimeout(r, hz.quoteDelay));
      return hz.quoteFail ? refusal(route, 503, "price_unavailable") : json(route, 200, { ...fx("quoteHetznerServer", "200-cx32-fsn1.json"), server_type: q.get("server_type"), location: q.get("location"), ...hz.quotePatch });
    }
    // D#845 MC-10b2: the server actions, the Claude sign-in and move. Each is recorded; the next queued refusal answers it instead.
    const sa = p.match(/^\/api\/v1\/machine-servers\/([^/]+)(?:\/(reboot|keep|delete-orphan))?$/);
    const ra = p.match(/^\/api\/runners\/([^/]+)\/(claude-login|claude-login\/code|claude-logout)$/);
    if (ra && req.method() === "GET") return json(route, 200, hz.login[ra[1]!] ?? { request: null });
    if ((sa && req.method() !== "GET") || ra || /^\/api\/runners\/repos\/[^/]+\/move$/.test(p)) {
      hz.acts.push({ method: req.method(), path: p + new URL(req.url()).search, body: req.postData() ? JSON.parse(req.postData()!) : undefined });
      const no = hz.actRefusals.shift();
      if (no) return refusal(route, no.status, no.code, no.retryAfter);
      if (sa) hz.servers = hz.servers.map((s) => ((s as { id: string }).id !== sa[1] ? s : sa[2] === "keep" ? { ...(s as object), kept: true } : sa[2] === "reboot" ? s : { ...(s as object), status: "deleting" }));
      if (ra && ra[2] !== "claude-logout") hz.login[ra[1]!] = { request: { request_id: "66666666-6666-4666-8666-666666666666", status: ra[2] === "claude-login" ? "pending" : "code_ready", expires_at: "2099-01-01T00:00:00.000Z", auth_url: null, failure_code: null } };
      return json(route, 200, {});
    }
    if (p === "/api/runners") {
      mock.gets++;
      if (mock.getFails) return json(route, 503, { error: { code: "unavailable", message: SERVER_TEXT, request_id: "r" } });
      // A press of Check runner now queued replies: each read after it takes the next one (the last one stays).
      const reply = mock.checkReplies.length > 1 ? mock.checkReplies.shift() : mock.checkReplies[0];
      if (reply) mock.runners = mock.runners.map((r) => ({ ...(r as object), ...reply }));
    }
    if (p === "/api/runners") return json(route, 200, { runners: mock.runners, viewer: { role: mock.role }, account: mock.account, copy: {} });
    if (p === "/api/runners/provisioning-tokens") {
      if (req.method() === "GET") return json(route, 200, { tokens: mock.tokens, limit: 5 });
      const body = JSON.parse(req.postData() ?? "{}");
      mock.posts.push({ path: p, body });
      if (mock.mintDelay > 0) await new Promise((r) => setTimeout(r, mock.mintDelay));
      if (mock.mintStatus !== 201) return json(route, mock.mintStatus, { error: { code: "token_limit", message: SERVER_TEXT, request_id: "r" } });
      mock.tokens.push({ id: "55555555-5555-4555-8555-555555555555", name: body.name ?? null, labels: body.labels, credential_mode: body.credential_mode, allowed_repo_ids: body.allowed_repo_ids, minted_by: { id: ME, name: "Ada Admin" }, created_at: "2026-10-15T12:00:00.000Z", expires_at: "2026-10-15T13:00:00.000Z" });
      return json(route, 201, { id: "55555555-5555-4555-8555-555555555555", token: TOKEN, expires_at: "2026-10-15T13:00:00.000Z", name: body.name ?? null });
    }
    if (p === "/api/runners/registration-codes") {
      mock.posts.push({ path: p, body: JSON.parse(req.postData() ?? "{}") });
      return json(route, 201, { code: ["fxrr", "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2H1g0"].join("_"), expires_at: "2026-10-15T12:10:00.000Z" }); // gitleaks:allow
    }
    const del = p.match(/^\/api\/runners\/provisioning-tokens\/([^/]+)$/);
    if (del && req.method() === "DELETE") {
      mock.deletes.push(del[1]!);
      mock.tokens = mock.tokens.filter((t) => t.id !== del[1]);
      return json(route, 200, { id: del[1], revoked: true });
    }
    if (/^\/api\/runners\/[^/]+\/check$/.test(p) && req.method() === "POST") {
      mock.posts.push({ path: p, body: JSON.parse(req.postData() ?? "{}") });
      return json(route, 200, { runner_id: p.split("/")[3], sent_at: "2026-10-15T12:00:00.000Z" });
    }
    const sbx = p.match(/^\/api\/runners\/([^/]+)\/sandbox-commands$/);
    if (sbx && req.method() === "POST") {
      const body = JSON.parse(req.postData() ?? "{}");
      mock.posts.push({ path: p, body });
      await new Promise((r) => setTimeout(r, 150)); // long enough that a second click lands while the first is in flight
      if (mock.sandboxRefusal) return json(route, mock.sandboxRefusal.status, { error: { code: mock.sandboxRefusal.code, message: SERVER_TEXT, request_id: "r" } });
      mock.runners = mock.runners.map((r) => {
        const v = r as { id: string; sandboxes?: { commands: unknown[] } };
        if (v.id !== sbx[1] || !v.sandboxes) return r;
        return { ...(r as object), sandboxes: { ...v.sandboxes, commands: [{ id: "77777777-7777-4777-8777-77777777777" + v.sandboxes.commands.length, kind: body.kind, name: body.name ?? null, state: "pending", refusal: null, issued_at: "2026-10-15T12:00:00.000Z", expires_at: "2026-10-15T12:05:00.000Z" }, ...v.sandboxes.commands] } };
      });
      return json(route, 200, { command_id: "77777777-7777-4777-8777-777777777770", runner_id: sbx[1], kind: body.kind, state: "pending", expires_at: "2026-10-15T12:05:00.000Z" });
    }
    const act = p.match(/^\/api\/runners\/([^/]+)\/(pause|drain|resume|rename|remove)$/);
    if (act && req.method() === "POST") {
      const body = JSON.parse(req.postData() ?? "{}");
      mock.posts.push({ path: p, body });
      await new Promise((r) => setTimeout(r, 150)); // long enough that a second click lands while the first is in flight
      mock.runners = mock.runners.map((r) => {
        if ((r as { id: string }).id !== act[1]) return r;
        if (act[2] === "pause") return { ...(r as object), state: "paused", state_note: "Resumes within 5 min", paused: true, controls: { ...OWN, pause: { allowed: false, reason: "Already paused." }, resume: ok } };
        if (act[2] === "rename" && body.name === null) return { ...(r as object), name: "Unnamed runner (Ada Admin)", has_name: false };
        if (act[2] === "rename") return { ...(r as object), name: body.name, has_name: true };
        if (act[2] === "remove") return { ...(r as object), state: "revoked", controls: null, capacity: null, repos: [] };
        return r;
      });
      return json(route, 200, { runner_id: act[1] });
    }
    return json(route, 404, { error: { code: "not_found", message: SERVER_TEXT, request_id: "r" } });
  });
  await page.goto("/");
  await waitForDesktop(page);
  return { mock, errors };
}

const WIN = `#windows-container .fulc-window[data-app-id="runners"]`;
const t = (page: Page, id: string) => page.locator(`${WIN} [data-testid="${id}"]`);
const open = async (page: Page) => {
  await page.locator('.dock-icon[data-app-id="runners"]').click();
  const win = page.locator(WIN);
  await expect(win).toBeVisible();
  await expect(win).not.toHaveClass(/opening/);
  await press(t(page, "runners-tab-fleet")); // D#845 MC-10a: the app opens on Machines; the fleet page is its third tab
  await expect(t(page, "runners-account")).toBeVisible();
  return win;
};
const press = async (loc: ReturnType<Page["locator"]>) => {
  if (test.info().project.name === "phone") await loc.tap();
  else await loc.click();
};
const sheet = (page: Page) => page.locator('dialog:has([data-testid="runners-sheet"])');
async function clean(page: Page, errors: string[]) {
  expect(errors).toEqual([]);
  const text = await page.evaluate(() => document.body.innerText);
  expect(text).not.toMatch(/\bnull\b|undefined|NaN|ApiError/);
  expect(text).not.toContain(SERVER_TEXT);
  expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i); // no id stands in for a name
}
async function applyTheme(page: Page, theme: string) {
  await page.evaluate(async (id) => {
    const m = await import(new URL("core/theme-manager.js", document.baseURI).href);
    await m.FULCTheme.apply(id);
  }, theme);
}
async function axeSeriousOrCritical(page: Page, scope: string) {
  const res = await new AxeBuilder({ page }).include(scope).exclude(`${WIN} .window-titlebar`).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
  return res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}

test.describe("D#605 FL-9: the fleet page", () => {
  test("a row shows every part by name and words: state, version, runs, capacity, check-in, repos, mode, labels, facts, and the account line", async ({ page }) => {
    const { errors } = await setup(page, {
      runners: [
        runner({ current_runs: [{ id: "88888888-8888-4888-8888-888888888881", label: "fulcrumaxe executor · acme/web" }], state: "busy", load_label: "Busy · 1 of 8", facts: { os: "macos", arch: "arm64", engine: "os_sandbox", preflight: [{ code: "dns_failed", fix: "This machine can't resolve names. Check `/etc/resolv.conf`" }] } }),
        runner({ id: R2, name: "Unnamed runner (Bo Builder)", has_name: false, registered_by: { id: ME, name: "Bo Builder" }, labels: [], facts: null, binary_version: null, last_seen_at: null, capacity: null, state: "offline", provisioning: { minted_by: { id: ME, name: "Ada Admin" }, first_ip: "203.0.113.9" } }),
        runner({ id: R3, name: "Old box", state: "outdated", binary_version: "0.1.0", draining: false, facts: { os: "linux", arch: "x64", engine: "microvm", preflight: [] } }),
      ],
      account: { limit: 16, capacity: 20, running: 1, runner_count: 3, runner_limit: 5 },
    });
    await open(page);
    await expect(t(page, "runners-account")).toHaveText("Capacity 16 of account limit 16 · 1 running"); // never 20
    const rows = t(page, "runners-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("Desktop");
    await expect(rows.nth(0)).toContainText("Registered by Ada Admin");
    await expect(rows.nth(0).locator('[data-testid="runners-state"]')).toHaveText(/Busy · 1 of 8/);
    await expect(rows.nth(0)).toContainText("0.9.1");
    await expect(rows.nth(0)).toContainText("Light 1 of 8 · Heavy 0 of 4");
    await expect(rows.nth(0)).toContainText("acme/web, acme/api");
    await expect(rows.nth(0)).toContainText("API key");
    await expect(rows.nth(0)).toContainText("gpu");
    await expect(rows.nth(0)).toContainText("macos · arm64 · OS sandbox");
    await expect(rows.nth(0).locator('[data-testid="runners-run"]')).toHaveText("fulcrumaxe executor · acme/web");
    await expect(rows.nth(1).locator('[data-testid="runners-name"]')).toHaveText("Unnamed runner (Bo Builder)");
    await expect(rows.nth(1)).toContainText("Not reported yet");
    await expect(rows.nth(1)).toContainText("Capacity unknown");
    await expect(rows.nth(1)).toContainText("Never");
    await expect(rows.nth(1).locator('[data-testid="runners-prov"]')).toHaveText("Made from a token by Ada Admin · first seen at 203.0.113.9");
    await expect(rows.nth(2)).toContainText("0.1.0 · Update needed");
    // D#845 ON-21b: the preflight line of the Machines row: a reported code with the cloud's fixed line, every check passing, and a machine that has not said.
    await expect(rows.nth(0).locator('[data-testid="runners-preflight"]')).toHaveText("This machine can't resolve names. Check `/etc/resolv.conf`");
    await expect(rows.nth(2)).toContainText("All checks passed");
    await expect(rows.nth(2).locator('[data-testid="runners-preflight"]')).toHaveCount(0);
    await expect(rows.nth(1).locator('[data-testid="runners-preflight"]')).toHaveCount(0);
    await clean(page, errors);
  });

  test("Pause on a double click sends one request, and the row reads Paused with its note after the refresh", async ({ page }) => {
    const { mock, errors } = await setup(page);
    await open(page);
    const pause = t(page, "runners-pause");
    await pause.dblclick();
    await expect(t(page, "runners-state")).toHaveText(/Paused · Resumes within 5 min/);
    expect(mock.posts.filter((p) => p.path.endsWith("/pause"))).toHaveLength(1);
    await expect(t(page, "runners-resume")).toBeVisible();
    await clean(page, errors);
  });

  // PING-UX (D#6 RUNNER-PING follow-up): real clicks on "Check runner now".
  const NOT_RESPONDING = { state: "not_responding", state_note: "no reply in 60 s", check: { status: "no_reply", sent_at: "2026-10-15T12:00:00.000Z" }, controls: { ...OWN, check: ok } };

  test("PING-UX (a): Check runner now on a runner that already reads Not responding shows Checking… and then the same answer, with the button usable throughout", async ({ page }) => {
    const { mock, errors } = await setup(page, { runners: [runner(NOT_RESPONDING)] });
    await open(page);
    await expect(t(page, "runners-state")).toHaveText(/Not responding — no reply in 60 s/);
    // The press queues a check; the next read shows it waiting, the one after answers (no reply again).
    mock.checkReplies = [{ ...NOT_RESPONDING, check: { status: "checking", sent_at: "2026-10-15T12:00:30.000Z" } }, NOT_RESPONDING];
    await press(t(page, "runners-check"));
    await expect(t(page, "runners-state")).toHaveText(/Checking…/);
    expect(mock.posts.filter((p) => p.path.endsWith("/check"))).toHaveLength(1);
    await expect(t(page, "runners-state")).toHaveText(/Not responding — no reply in 60 s/);
    await expect(t(page, "runners-check")).toHaveAttribute("aria-disabled", "false");
    await clean(page, errors);
  });

  test("PING-UX (b): when the fleet cannot be read while a check waits, the re-reads stop, the row says it could not check, and pressing again works", async ({ page }) => {
    const { mock, errors } = await setup(page, { runners: [runner({ controls: { ...OWN, check: ok } })] });
    await open(page);
    mock.checkReplies = [{ check: { status: "checking", sent_at: "2026-10-15T12:00:00.000Z" } }];
    await press(t(page, "runners-check"));
    await expect(t(page, "runners-state")).toHaveText(/Checking…/);
    mock.getFails = true;
    await expect(t(page, "runners-row-error")).toHaveText("Couldn't check the runner. Try again.");
    await expect(t(page, "runners-state")).not.toHaveText(/Checking…/);
    // No more reads after the failed one: wait past two poll intervals and count.
    const reads = mock.gets;
    await page.waitForTimeout(11_000);
    expect(mock.gets).toBe(reads);
    await expect(t(page, "runners-check")).toHaveAttribute("aria-disabled", "false");
    // Pressing again sends a new check; the fleet reads again and the message is gone.
    mock.getFails = false;
    await press(t(page, "runners-check"));
    await expect(t(page, "runners-state")).toHaveText(/Checking…/);
    await expect(t(page, "runners-row-error")).toHaveCount(0);
    expect(mock.posts.filter((p) => p.path.endsWith("/check"))).toHaveLength(2);
    expect(errors.filter((e) => !/503|Failed to load/.test(e))).toEqual([]);
  });

  test("a draining runner reads Finishing current work, and a member sees every control disabled with its reason", async ({ page }) => {
    const none = { allowed: false, reason: NOT_MINE };
    const { mock, errors } = await setup(page, {
      role: "member",
      runners: [runner({ state: "draining", draining: true, state_note: "Resumes within 5 min", controls: { pause: none, drain: none, resume: none, rename: none, remove: none } })],
    });
    await open(page);
    await expect(t(page, "runners-state")).toHaveText(/Finishing current work/);
    for (const c of ["resume", "rename", "remove"]) {
      const b = t(page, "runners-" + c);
      await expect(b).toHaveAttribute("aria-disabled", "true");
      await expect(b).not.toHaveAttribute("disabled", /.*/);
      await b.click({ force: true }); // aria-disabled stays clickable for a screen reader; the click must do nothing
    }
    await expect(t(page, "runners-reason")).toHaveCount(4); // three controls, and the Add a runner button
    await expect(t(page, "runners-reason").nth(1)).toHaveText(NOT_MINE);
    await expect(t(page, "runners-add")).toHaveAttribute("aria-disabled", "true");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    expect(mock.posts).toEqual([]);
    await clean(page, errors);
  });

  test("a runner revoked because its registrant left reads Revoked: registrant left, has no controls, and offers Register this machine again to owners and admins only", async ({ page }) => {
    const gone = runner({ state: "revoked", state_note: "Revoked: registrant left", revoked_reason: "registrant_left", controls: null, capacity: null, repos: [], name: "Old laptop", register_again: { name: "Old laptop", labels: ["gpu"], repo_ids: [REPO_API] } });
    const { errors } = await setup(page, { runners: [gone] });
    await open(page);
    await expect(t(page, "runners-state")).toHaveText(/Revoked: registrant left/);
    for (const c of ["pause", "drain", "resume", "rename", "remove"]) await expect(t(page, "runners-" + c)).toHaveCount(0);
    await press(t(page, "runners-again"));
    await expect(sheet(page)).toBeVisible();
    await expect(page.locator("#runners-sheet-path-token")).toBeChecked();
    await expect(page.locator("#runners-sheet-name")).toHaveValue("Old laptop");
    await expect(page.locator("#runners-sheet-labels")).toHaveValue("gpu");
    await expect(page.locator(`#runners-repo-${REPO_API}`)).toBeChecked();
    await expect(page.locator(`#runners-repo-${REPO_WEB}`)).not.toBeChecked();
    await clean(page, errors);
  });

  test("a member sees a removed registrant's runner with its state and no action", async ({ page }) => {
    const gone = runner({ state: "revoked", state_note: "Revoked: registrant left", revoked_reason: "registrant_left", controls: null, capacity: null, repos: [], register_again: null });
    const { errors } = await setup(page, { role: "member", runners: [gone] });
    await open(page);
    await expect(t(page, "runners-state")).toHaveText(/Revoked: registrant left/);
    await expect(t(page, "runners-again")).toHaveCount(0);
    await expect(page.locator(`${WIN} .runners-controls`)).toHaveCount(0);
    await clean(page, errors);
  });

  test("a named runner can go back to unnamed: Remove the name sends { name: null }, the row reads Unnamed again, and the button is gone after a reload", async ({ page }) => {
    const { mock, errors } = await setup(page);
    await open(page);
    await expect(t(page, "runners-name")).toHaveText("Desktop");
    await press(t(page, "runners-rename"));
    await press(page.locator('[data-testid="runners-rename-clear"]'));
    await expect(t(page, "runners-name")).toHaveText(/^Unnamed runner \(/);
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    expect(mock.posts.filter((p) => p.path.endsWith("/rename")).map((p) => p.body)).toEqual([{ name: null }]);
    await page.reload();
    await open(page);
    await expect(t(page, "runners-name")).toHaveText(/^Unnamed runner \(/);
    await expect(t(page, "runners-rename")).toBeEnabled();
    await press(t(page, "runners-rename"));
    await expect(page.locator("#runners-rename-input")).toHaveValue("");
    await expect(page.locator('[data-testid="runners-rename-clear"]')).toHaveCount(0);
    await clean(page, errors);
  });

  test("Rename and Remove ask first, send one request, and focus returns to where it was", async ({ page }) => {
    const { mock, errors } = await setup(page);
    await open(page);
    await press(t(page, "runners-rename"));
    const input = page.locator("#runners-rename-input");
    await expect(input).toBeFocused();
    await input.fill("Workstation");
    await press(page.locator('[data-testid="runners-rename-save"]'));
    await expect(t(page, "runners-name")).toHaveText("Workstation");
    await expect(t(page, "runners-rename")).toBeFocused();
    expect(mock.posts.filter((p) => p.path.endsWith("/rename")).map((p) => p.body)).toEqual([{ name: "Workstation" }]);
    await press(t(page, "runners-remove"));
    await expect(page.locator("dialog[open]")).toContainText("Remove Workstation?");
    // Cancel and Escape both go back to the Remove button that opened the dialog, and send nothing.
    await press(page.getByRole("button", { name: "Cancel" }));
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(t(page, "runners-remove")).toBeFocused();
    await press(t(page, "runners-remove"));
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(t(page, "runners-remove")).toBeFocused();
    expect(mock.posts.filter((p) => p.path.endsWith("/remove"))).toHaveLength(0);
    await press(t(page, "runners-remove"));
    await press(page.locator('[data-testid="runners-remove-confirm"]'));
    await expect(t(page, "runners-state")).toHaveText(/Revoked/);
    await expect(t(page, "runners-add")).toBeFocused();
    expect(mock.posts.filter((p) => p.path.endsWith("/remove"))).toHaveLength(1);
    await clean(page, errors);
  });

  test("Add a runner: the token is shown once with a --code-stdin command; reopening shows only its name and expiry; Revoke removes it", async ({ page }) => {
    const { mock, errors } = await setup(page);
    await open(page);
    await press(t(page, "runners-add"));
    await expect(sheet(page)).toBeVisible();
    await expect(page.locator("#runners-sheet-path-code")).toBeFocused();
    await page.locator("#runners-sheet-path-token").check();
    await page.locator("#runners-sheet-name").fill("VPS");
    await page.locator("#runners-sheet-labels").fill("gpu, big-box");
    await page.locator(`#runners-repo-${REPO_WEB}`).check();
    await press(page.locator('[data-testid="runners-sheet-make"]'));
    const secret = page.locator('[data-testid="runners-secret"]');
    await expect(secret).toHaveValue(TOKEN);
    await expect(page.locator('[data-testid="runners-register-command"]')).toContainText("fx-runner register --code-stdin --credential-mode api_key");
    await expect(page.locator('[data-testid="runners-register-command"]')).toContainText("--name 'VPS'");
    expect(mock.posts).toEqual([{ path: "/api/runners/provisioning-tokens", body: { credential_mode: "api_key", allowed_repo_ids: [REPO_WEB], labels: ["gpu", "big-box"], ttl_seconds: 3600, name: "VPS" } }]);
    await press(page.locator('[data-testid="runners-sheet-done"]'));
    await expect(sheet(page)).toHaveCount(0);
    await expect(t(page, "runners-add")).toBeFocused();
    expect(await page.evaluate(() => document.body.innerHTML)).not.toContain("A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0");
    await press(t(page, "runners-add"));
    await expect(page.locator('[data-testid="runners-tokens"] li')).toHaveCount(1);
    await expect(page.locator('[data-testid="runners-tokens"] li')).toContainText("VPS");
    await expect(page.locator('[data-testid="runners-tokens"] li')).toContainText("expires");
    expect(await page.evaluate(() => document.body.innerHTML)).not.toContain("A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0");
    await press(page.getByRole("button", { name: "Revoke VPS" }));
    await expect(page.locator('[data-testid="runners-tokens"] li')).toHaveCount(0);
    expect(mock.deletes).toEqual(["55555555-5555-4555-8555-555555555555"]);
    await press(page.locator("#runners-sheet-close"));
    await expect(t(page, "runners-add")).toBeFocused();
    await clean(page, errors);
  });

  test("closing the sheet while Make is still in flight leaves no secret on the page when the reply arrives", async ({ page }) => {
    const { mock, errors } = await setup(page, { mintDelay: 1500 });
    await open(page);
    await press(t(page, "runners-add"));
    await page.locator("#runners-sheet-path-token").check();
    await page.locator(`#runners-repo-${REPO_WEB}`).check();
    await press(page.locator('[data-testid="runners-sheet-make"]'));
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect.poll(() => mock.posts.length).toBe(1);
    await page.waitForTimeout(2500); // the reply has arrived by now
    expect(await page.evaluate(() => document.body.innerHTML)).not.toContain("A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await clean(page, errors);
  });

  test("a run listed on a row opens in the Runs app; the id it sends is the run's", async ({ page }) => {
    const RUN = "88888888-8888-4888-8888-888888888881";
    const { mock } = await setup(page, { runners: [runner({ current_runs: [{ id: RUN, label: "fulcrumaxe executor · acme/web" }] })] });
    await open(page);
    await press(t(page, "runners-run"));
    await expect(page.locator(`#windows-container .fulc-window[data-app-id="runs"]`)).toBeVisible();
    await expect.poll(() => mock.runFetches.includes(RUN)).toBe(true);
  });

  test("a one-time code, and the sheet's refusals: no repo picked, and a sixth token", async ({ page }) => {
    const { mock, errors } = await setup(page, { mintStatus: 409 });
    await open(page);
    await press(t(page, "runners-add"));
    await press(page.locator('[data-testid="runners-sheet-make"]'));
    await expect(page.locator("#runners-sheet-error")).toHaveText("Pick at least one repo for it to work on.");
    expect(mock.posts).toEqual([]);
    await page.locator("#runners-sheet-path-token").check();
    await page.locator(`#runners-repo-${REPO_API}`).check();
    await press(page.locator('[data-testid="runners-sheet-make"]'));
    await expect(page.locator("#runners-sheet-error")).toHaveText("You already have 5 unused tokens. Revoke one first.");
    await page.locator("#runners-sheet-path-code").check();
    await press(page.locator('[data-testid="runners-sheet-make"]'));
    await expect(page.locator('[data-testid="runners-register-command"]')).toContainText("--code-stdin");
    await expect(page.locator('[data-testid="runners-secret"]')).toHaveValue(/^fxrr_/);
    await clean(page, errors);
  });

  test("a member cannot open the sheet, and the empty fleet says how to start", async ({ page }) => {
    const { errors } = await setup(page, { role: "member", runners: [], account: { limit: 16, capacity: 0, running: 0, runner_count: 0, runner_limit: 5 } });
    await open(page);
    await expect(t(page, "runners-empty")).toContainText("No runners yet");
    await t(page, "runners-add").click({ force: true });
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(t(page, "runners-reason")).toHaveText("Only owners and admins can add a runner.");
    await clean(page, errors);
  });

  // One test per theme: eight themes, three axe scans each, in one test cost more than the test timeout when the machine is busy. Each theme
  // still gets every scan; none is dropped.
  for (const theme of THEMES) test(`keyboard: every control is a focusable button or field (none uses the disabled attribute), and the list and the sheet pass axe under ${theme}`, async ({ page }) => {
    const none = { allowed: false, reason: NOT_MINE };
    await setup(page, {
      runners: [
        runner({ current_runs: [{ id: "88888888-8888-4888-8888-888888888881", label: "fulcrumaxe executor · acme/web" }], state: "busy", load_label: "Busy · 1 of 8" }),
        runner({ id: R2, state: "paused", state_note: "Resumes within 5 min", paused: true, controls: { ...OWN, pause: none, resume: none } }),
        runner({ id: R3, state: "revoked", state_note: "Revoked: registrant left", revoked_reason: "registrant_left", controls: null, register_again: { name: "Old", labels: [], repo_ids: [REPO_WEB] } }),
      ],
      account: { limit: 16, capacity: 8, running: 1, runner_count: 3, runner_limit: 3 },
    });
    await open(page);
    await applyTheme(page, theme);
    expect(await page.locator(`${WIN} button[disabled], ${WIN} input[disabled]`).count()).toBe(0);
    expect(await page.locator(`${WIN} button[tabindex="-1"]`).count()).toBe(0);
    await expect(t(page, "runners-limit-note")).toBeVisible();
    expect(await axeSeriousOrCritical(page, WIN)).toEqual([]);
    await press(t(page, "runners-add"));
    await expect(sheet(page)).toBeVisible();
    expect(await axeSeriousOrCritical(page, "dialog[open]")).toEqual([]);
    await page.locator("#runners-sheet-path-token").check();
    await page.locator(`#runners-repo-${REPO_WEB}`).check();
    await press(page.locator('[data-testid="runners-sheet-make"]'));
    await expect(page.locator('[data-testid="runners-secret"]')).toBeVisible();
    expect(await axeSeriousOrCritical(page, "dialog[open]")).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(t(page, "runners-add")).toBeFocused();
  });
});

// D#587 B-7b-ii: each runner's sandboxes, the host quota, and Stop, Delete and Reap. The words are in runners-fleet.js and tested in test/runners-sandboxes.test.mjs.
test.describe("D#587 B-7b-ii: the sandboxes of a runner", () => {
  const sb = (page: Page) => t(page, "runners-sandboxes");
  const noBrowserDialog = (page: Page) => page.on("dialog", (d) => { throw new Error("a browser " + d.type() + " dialog opened: " + d.message()); });

  test("shows each sandbox with its state, ages and disk, the quota against the limits, how old the report is, and every command state in words", async ({ page }) => {
    noBrowserDialog(page);
    const { errors } = await setup(page, {
      runners: [
        runner({ sandboxes: sandboxView({ commands: [cmd(1, "pending"), cmd(2, "delivered", { kind: "stop_sandbox", name: "web-1" }), cmd(3, "applied", { kind: "reap_sandboxes", name: null }), cmd(4, "refused", { refusal: "in_use" }), cmd(5, "expired"), cmd(6, "unanswered")] }) }),
        runner({ id: R2, name: "Back on the host sandbox", sandboxes: sandboxView({ status: "stale_engine", can_command: false }) }),
        runner({ id: R3, name: "Never reported", sandboxes: sandboxView({ status: "never", seen_at: null, can_command: false, sandboxes: [], limits: { vms: null, vcpus: null, memory_mb: null, templates: [] } }) }),
      ],
    });
    await open(page);
    const first = sb(page).nth(0);
    await expect(first.locator('[data-testid="runners-sandbox"]')).toHaveCount(2);
    await expect(first.locator('[data-testid="runners-sandbox"]').nth(0)).toContainText("web-1");
    await expect(first.locator('[data-testid="runners-sandbox-state"]').nth(0)).toHaveText("Running");
    await expect(first.locator('[data-testid="runners-sandbox"]').nth(1)).toContainText("1.5 GB · 2 snapshots, newest 2 h old");
    await expect(first.locator('[data-testid="runners-sandbox"]').nth(1)).toContainText("Never used");
    await expect(first.locator('[data-testid="runners-sandbox-quota"]')).toContainText("Running: 1 of 4 allowed");
    await expect(first.locator('[data-testid="runners-sandbox-quota"]')).toContainText("vCPU limit: 16 · Memory limit: 32 GB");
    await expect(first.locator('[data-testid="runners-sandbox-status"]')).toContainText("Reported");
    const lines = first.locator('[data-testid="runners-sandbox-command"]');
    await expect(lines).toHaveCount(6);
    for (const [n, words] of [[0, "Waiting for the runner"], [1, "Sent, waiting for the runner's answer"], [2, "Done"], [3, "Refused (it is in use)"], [4, "Expired before the runner took it"], [5, "Unanswered: the runner never replied"]] as const) await expect(lines.nth(n)).toContainText(words);
    // A list the runner no longer reports says it is out of date, and its buttons are off with that reason.
    const stale = sb(page).nth(1);
    await expect(stale.locator('[data-testid="runners-sandbox-status"]')).toContainText("Out of date");
    await expect(stale.locator('[data-testid="runners-sandbox-delete_sandbox"]').first()).toHaveAttribute("aria-disabled", "true");
    await expect(stale.locator('[data-testid="runners-reason"]').first()).toContainText("Out of date");
    await expect(sb(page).nth(2).locator('[data-testid="runners-sandbox-status"]')).toHaveText("This runner hasn't reported any sandboxes.");
    await clean(page, errors);
  });

  test("a member sees the list and every button off with the reason, and a click sends nothing", async ({ page }) => {
    noBrowserDialog(page);
    const { mock, errors } = await setup(page, { role: "member", runners: [runner({ sandboxes: sandboxView() })] });
    await open(page);
    const buttons = sb(page).locator("button");
    await expect(buttons).toHaveCount(5); // Stop and Delete for web-1, Stop and Delete for web-2, Reap
    for (let n = 0; n < 5; n++) {
      await expect(buttons.nth(n)).toHaveAttribute("aria-disabled", "true");
      await buttons.nth(n).click({ force: true });
    }
    await expect(sb(page).locator('[data-testid="runners-reason"]').first()).toHaveText("Only owners and admins can change a runner's sandboxes.");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    expect(mock.posts).toEqual([]);
    await clean(page, errors);
  });

  test("Stop sends one request on a double click and the command reads Waiting for the runner after the refresh; Stop is off on a stopped sandbox", async ({ page }) => {
    noBrowserDialog(page);
    const { mock, errors } = await setup(page, { runners: [runner({ sandboxes: sandboxView() })] });
    await open(page);
    const stop = sb(page).locator('[data-testid="runners-sandbox-stop_sandbox"]');
    await expect(stop.nth(1)).toHaveAttribute("aria-disabled", "true"); // web-2 is stopped
    // Two presses in the same tick on every device (two taps one after the other can land after the first answer, and are then two honest requests).
    await stop.nth(0).evaluate((el: HTMLElement) => { el.click(); el.click(); });
    await expect(sb(page).locator('[data-testid="runners-sandbox-command"]')).toHaveText(/Stop sandbox web-1: Waiting for the runner/);
    expect(mock.posts.filter((p) => p.path.endsWith("/sandbox-commands")).map((p) => p.body)).toEqual([{ kind: "stop_sandbox", name: "web-1" }]);
    await clean(page, errors);
  });

  test("Delete and Reap ask in the page first: Cancel and Escape send nothing and return focus, Confirm sends one request", async ({ page }) => {
    noBrowserDialog(page);
    const { mock, errors } = await setup(page, { runners: [runner({ sandboxes: sandboxView() })] });
    await open(page);
    const posts = () => mock.posts.filter((p) => p.path.endsWith("/sandbox-commands")).map((p) => p.body);
    const del = sb(page).locator('[data-testid="runners-sandbox-delete_sandbox"]').nth(1);
    await press(del);
    await expect(page.locator("dialog[open]")).toContainText("Delete web-2?");
    await press(page.locator('[data-testid="runners-sandbox-cancel"]'));
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(del).toBeFocused();
    await press(del);
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    expect(posts()).toEqual([]);
    await press(del);
    await press(page.locator('[data-testid="runners-sandbox-confirm"]'));
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(sb(page).locator('[data-testid="runners-sandbox-command"]')).toHaveText(/Delete sandbox web-2: Waiting for the runner/);
    expect(posts()).toEqual([{ kind: "delete_sandbox", name: "web-2" }]);
    const reap = sb(page).locator('[data-testid="runners-sandbox-reap_sandboxes"]');
    await press(reap);
    await expect(page.locator("dialog[open]")).toContainText("Reap stopped sandboxes?");
    await press(page.locator('[data-testid="runners-sandbox-confirm"]'));
    await expect(sb(page).locator('[data-testid="runners-sandbox-command"]').first()).toHaveText(/Reap stopped sandboxes: Waiting for the runner/);
    expect(posts()).toEqual([{ kind: "delete_sandbox", name: "web-2" }, { kind: "reap_sandboxes" }]);
    await clean(page, errors);
  });

  test("a refusal keeps the confirmation open with its own sentence and never the server's text: 429 too many, 409 removed", async ({ page }) => {
    noBrowserDialog(page);
    const { mock, errors } = await setup(page, { runners: [runner({ sandboxes: sandboxView() })], sandboxRefusal: { status: 429, code: "too_many" } });
    await open(page);
    const del = sb(page).locator('[data-testid="runners-sandbox-delete_sandbox"]').nth(1);
    await press(del);
    await press(page.locator('[data-testid="runners-sandbox-confirm"]'));
    await expect(page.locator("dialog[open] [role=alert]")).toContainText("Too many sandbox requests are waiting for this runner");
    mock.sandboxRefusal = { status: 409, code: "runner_revoked" };
    await press(page.locator('[data-testid="runners-sandbox-confirm"]'));
    await expect(page.locator("dialog[open] [role=alert]")).toHaveText("That runner was removed.");
    await press(page.locator('[data-testid="runners-sandbox-cancel"]'));
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await clean(page, errors);
  });

  test("the sandboxes section and its confirmation pass axe under two themes", async ({ page }) => {
    const { errors } = await setup(page, { runners: [runner({ sandboxes: sandboxView({ commands: [cmd(1, "refused", { refusal: "in_use" }), cmd(2, "unanswered")] }) })] });
    await open(page);
    for (const theme of ["classic-crt", "nord"]) {
      await applyTheme(page, theme);
      expect(await axeSeriousOrCritical(page, WIN), theme).toEqual([]);
    }
    await press(sb(page).locator('[data-testid="runners-sandbox-delete_sandbox"]').nth(0));
    expect(await axeSeriousOrCritical(page, "dialog[open]"), "confirmation").toEqual([]);
    await press(page.locator('[data-testid="runners-sandbox-cancel"]'));
    await clean(page, errors);
  });
});

const machine = (over: Record<string, unknown> = {}) => ({ id: R1, name: "Desktop", tier: "microvm", live: true, claude: true, running: null, ...over });
const openMachines = async (page: Page) => {
  await page.locator('.dock-icon[data-app-id="runners"]').click();
  await expect(page.locator(WIN)).toBeVisible();
  await expect(page.locator(WIN)).not.toHaveClass(/opening/);
};

test.describe("D#845 MC-10a: the Machines app", () => {
  test("opens on Machines with three tabs, and every row shows kind, tier, liveness, Claude and capacity by name", async ({ page }) => {
    const { errors } = await setup(page, {
      machines: [
        machine({ running: { repo_id: REPO_WEB, name: "acme/web" } }),
        machine({ id: R2, name: "", tier: "standard", kvm: "absent", live: false, claude: false }),
        machine({ id: R3, name: "\u202Eevil", tier: null }),
      ],
    });
    await openMachines(page);
    await expect(page.locator(`${WIN} [role=tab]`)).toHaveText(["Machines", "Servers", "Fleet"]);
    await expect(t(page, "runners-tab-machines")).toHaveAttribute("aria-selected", "true");
    const rows = t(page, "runners-machine");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("MicroVM isolation");
    await expect(rows.nth(0)).toContainText("Online");
    await expect(rows.nth(0)).toContainText("Running acme/web");
    await expect(rows.nth(1)).toContainText("Unnamed machine");
    await expect(rows.nth(1)).toContainText("Standard isolation: one project on this machine (no KVM)");
    await expect(rows.nth(1)).toContainText("Offline");
    await expect(rows.nth(1).locator('[data-testid="runners-machine-capacity"]')).toHaveText("Free");
    await expect(rows.nth(2)).toContainText("Isolation not reported yet");
    await expect(page.locator(`${WIN} [data-testid="runners-machine-name"] bdi`)).toHaveCount(3);
    await clean(page, errors);
  });

  test("a standard machine says no KVM only when it reported none; with KVM it shows the vm-install command to copy; one that never reported says nothing about KVM (FU-225)", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const { errors } = await setup(page, {
      machines: [
        machine({ id: R1, name: "NoKvm", tier: "standard", kvm: "absent" }),
        machine({ id: R2, name: "HasKvm", tier: "standard", kvm: "present" }),
        machine({ id: R3, name: "Unreported", tier: "standard" }),
      ],
    });
    await openMachines(page);
    const rows = t(page, "runners-machine");
    await expect(rows).toHaveCount(3);
    const tier = (i: number) => rows.nth(i).locator('[data-testid="runners-machine-tier"]');
    const hint = (i: number) => rows.nth(i).locator('[data-testid="runners-machine-vminstall"]');
    await expect(tier(0)).toHaveText("Standard isolation: one project on this machine (no KVM)");
    await expect(hint(0)).toHaveCount(0);
    await expect(tier(1)).toHaveText("Standard isolation: one project on this machine");
    await expect(hint(1)).toContainText("HasKvm can run microVMs. Run sudo fx-runner vm install on it.");
    await expect(hint(1).locator("pre")).toHaveText("sudo fx-runner vm install");
    await press(rows.nth(1).locator('[data-testid="runners-machine-vminstall-copy"]'));
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("sudo fx-runner vm install");
    await expect(tier(2)).toHaveText("Standard isolation: one project on this machine");
    await expect(hint(2)).toHaveCount(0);
    await expect(rows.nth(2)).not.toContainText("KVM");
    expect(await page.locator(WIN).innerText()).not.toMatch(/undefined|null/);
    await clean(page, errors);
  });

  test("a microVM machine with no Claude token shows the token notice with a command to copy; nothing new with the token, a standard machine or an unknown engine", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const { errors } = await setup(page, {
      machines: [
        machine({ name: "NoToken", claude: false }),
        machine({ id: R2, name: "HasToken", claude: true }),
        machine({ id: R3, name: "Plain", tier: "standard", claude: false }),
        machine({ id: "00000000-0000-4000-8000-0000000000a4", name: "Unknown", tier: null, claude: false }),
      ],
    });
    await openMachines(page);
    const rows = t(page, "runners-machine");
    await expect(rows).toHaveCount(4);
    const notice = t(page, "runners-machine-vmtoken");
    await expect(notice).toHaveCount(1);
    await expect(rows.nth(0).locator('[data-testid="runners-machine-vmtoken"]')).toHaveCount(1);
    await expect(notice).toContainText("Virtual machine mode needs a Claude token on this machine. On that machine run fx-runner credentials set-vm-token.");
    await expect(notice).toContainText("The token stays on that machine and is never sent to us.");
    await expect(notice.locator("pre")).toHaveText("fx-runner credentials set-vm-token");
    await expect(notice.locator("input, textarea")).toHaveCount(0);
    await expect(rows.nth(0)).toContainText("Claude token");
    await press(t(page, "runners-machine-vmtoken-copy"));
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("fx-runner credentials set-vm-token");
    for (const i of [1, 2, 3]) await expect(rows.nth(i).locator('[data-testid="runners-machine-vmtoken"]')).toHaveCount(0);
    expect(await page.locator(WIN).innerText()).not.toMatch(/undefined|null/);
    await clean(page, errors);
  });

  test("empty, load error with Retry, the tab keys, and a member told why they cannot add", async ({ page }) => {
    const { mock, errors } = await setup(page, { machinesFail: true, role: "member", isAdmin: false });
    await openMachines(page);
    await expect(t(page, "runners-machines-error")).toHaveText("Machines couldn't be loaded");
    mock.machinesFail = false;
    await press(t(page, "runners-machines-retry"));
    await expect(t(page, "runners-machines-empty")).toHaveText("No machines yet");
    await expect(t(page, "runners-addm-open")).toHaveAttribute("aria-disabled", "true");
    await expect(t(page, "runners-reason")).toHaveText("Only owners and admins can add a machine.");
    await t(page, "runners-tab-machines").focus();
    await page.keyboard.press("ArrowRight");
    await expect(t(page, "runners-cred-text")).toHaveText("Only owners and admins can connect Hetzner."); // a member reads the servers but cannot connect
    await page.keyboard.press("ArrowRight");
    await expect(t(page, "runners-account")).toBeVisible();
    await clean(page, errors);
  });

  test("Add a machine offers two choices; the Hetzner choice goes to Servers", async ({ page }) => {
    const { errors } = await setup(page);
    await openMachines(page);
    await press(t(page, "runners-addm-open"));
    const dlg = page.locator("dialog[open]");
    await expect(dlg.locator("h3")).toHaveText(["A computer or server I have", "A new Hetzner Cloud server"]);
    await expect(dlg).toContainText("fx-runner setup --cloud-url");
    await expect(page.locator('dialog [data-testid="runners-addm-kvm"]')).toContainText("sudo fx-runner vm install");
    expect(await axeSeriousOrCritical(page, "dialog[open]")).toEqual([]);
    await press(page.locator('dialog [data-testid="runners-addm-servers"]'));
    await expect(t(page, "runners-cred")).toBeVisible();
    await expect(t(page, "runners-tab-servers")).toBeFocused();
    await clean(page, errors);
  });
});

// ── D#845 MC-10b1: Servers part 1, the Hetzner credential and the create dialog ──
const HZ_TOKEN = ["hz", "Qm9bT1x7Yw3nKd82LfRp5uJc0VtAe4Sg6Zi1HoNy", "a1b2"].join("_"); // gitleaks:allow
const CONNECTED = fx("getHetznerCredential", "200-connected.json");
const TIER = fx("quoteHetznerServer", "200-cx32-fsn1.json").tier_notice as string;
const FSN1 = "Falkenstein, DE (fsn1)";
const openServers = async (page: Page) => {
  await openMachines(page);
  await press(t(page, "runners-tab-servers"));
};
const dlgOf = (page: Page) => page.locator("dialog[open]");
const go = (page: Page) => dlgOf(page).locator('[data-testid="runners-create-go"]');
const openCreate = async (page: Page) => {
  await press(t(page, "runners-srv-create"));
  await expect(go(page)).toHaveText(/^Create server, /);
};

test.describe("D#845 MC-10b1: the Hetzner credential", () => {
  test("Connect Hetzner: the four steps, then read only, refused and down each say so and save nothing, then connected; the token is sent once per press and never shown", async ({ page }) => {
    const { mock, errors } = await setup(page);
    await openServers(page);
    await expect(t(page, "runners-cred-text")).toHaveText("No Hetzner token is connected.");
    await expect(t(page, "runners-srv-create")).toHaveAttribute("aria-disabled", "true");
    await expect(t(page, "runners-reason")).toHaveText("Connect Hetzner first.");
    await press(t(page, "runners-hz-connect"));
    const dlg = dlgOf(page);
    await expect(dlg.locator("ol li")).toHaveCount(4);
    await expect(dlg.locator("ol li").nth(3)).toHaveText("You can revoke it in Hetzner at any time. Removing it here deletes our copy.");
    const input = dlg.locator('[data-testid="runners-hz-token"]');
    await expect(input).toHaveAttribute("type", "password");
    await expect(input).toHaveAttribute("autocomplete", "off");
    await expect(input).toBeFocused();
    const send = async () => {
      await input.fill(HZ_TOKEN);
      await press(dlg.locator('[data-testid="runners-hz-save"]'));
    };
    for (const [answer, words] of [
      [{ status: 422, code: "token_read_only" }, "This token is Read only. Nothing was saved. Make a Read & Write token and try again"],
      [{ status: 422, code: "token_invalid" }, "Hetzner refused this token. It may have been revoked"],
      [{ status: 503, code: "provider_unreachable" }, "Hetzner didn't answer. Try again in a minute"],
    ] as const) {
      mock.hz.connect = answer;
      await send();
      await expect(dlg.locator('[data-testid="runners-hz-error"]')).toHaveText(words);
      await expect(input).toHaveValue(""); // cleared after sending, whatever the answer
      await expect(dlg).toHaveCount(1);
    }
    await expect(t(page, "runners-cred-text")).toHaveText("No Hetzner token is connected."); // nothing was saved
    mock.hz.connect = null;
    await send();
    await expect(dlg).toHaveCount(0);
    await expect(t(page, "runners-cred-text")).toHaveText("Connected (token …a1b2)");
    await expect(t(page, "runners-hz-unlabelled")).toHaveText("This Hetzner project has 2 servers we didn't create. We never change them.");
    await expect(t(page, "runners-srv-create")).toHaveAttribute("aria-disabled", "false");
    await expect(t(page, "runners-srv-create")).toBeFocused();
    expect(mock.hz.connects.map((c) => c.token)).toEqual([HZ_TOKEN, HZ_TOKEN, HZ_TOKEN, HZ_TOKEN]);
    expect(await page.content()).not.toContain(HZ_TOKEN);
    expect(await page.evaluate(() => document.body.innerText)).not.toContain(HZ_TOKEN);
    await clean(page, errors);
  });

  test("a rate-limited connect keeps Check and save off for the wait; an empty box asks for the token and sends nothing", async ({ page }) => {
    const { mock, errors } = await setup(page, { hz: { connect: { status: 429, code: "rate_limited", retryAfter: 2 } } });
    await openServers(page);
    await press(t(page, "runners-hz-connect"));
    const dlg = dlgOf(page);
    const save = dlg.locator('[data-testid="runners-hz-save"]');
    await press(save);
    await expect(dlg.locator('[data-testid="runners-hz-error"]')).toHaveText("Paste your Hetzner token first.");
    expect(mock.hz.connects).toHaveLength(0);
    await dlg.locator('[data-testid="runners-hz-token"]').fill(HZ_TOKEN);
    await press(save);
    await expect(dlg.locator('[data-testid="runners-hz-error"]')).toHaveText("That was too fast.");
    await expect(save).toHaveAttribute("aria-disabled", "true");
    await expect(dlg.locator('[data-testid="runners-hz-status"]')).toHaveText(/^Try again in [12] seconds?\.$/);
    await expect(save).toHaveAttribute("aria-disabled", "false", { timeout: 6000 });
    await clean(page, errors);
  });

  test("Remove asks first, says so when it fails, and then Hetzner can be connected again; Cancel changes nothing", async ({ page }) => {
    const { mock, errors } = await setup(page, { hz: { credential: CONNECTED, removeFail: 500 } });
    await openServers(page);
    await expect(t(page, "runners-cred-text")).toHaveText("Connected (token …a1b2)");
    await press(t(page, "runners-hz-remove"));
    const dlg = dlgOf(page);
    await expect(dlg).toContainText("This deletes our copy of the token. Servers already made stay at Hetzner.");
    await press(dlg.locator("#runners-hz-remove-cancel"));
    await expect(dlg).toHaveCount(0);
    expect(mock.hz.removes).toBe(0);
    await expect(t(page, "runners-hz-remove")).toBeFocused();
    await press(t(page, "runners-hz-remove"));
    await press(dlg.locator('[data-testid="runners-hz-remove-confirm"]'));
    await expect(dlg.locator('[data-testid="runners-hz-remove-error"]')).toHaveText("That token couldn't be removed. Try again.");
    await expect(t(page, "runners-cred-text")).toHaveText("Connected (token …a1b2)"); // nothing was claimed removed
    mock.hz.removeFail = 0;
    await press(dlg.locator('[data-testid="runners-hz-remove-confirm"]'));
    await expect(dlg).toHaveCount(0);
    expect(mock.hz.removes).toBe(2);
    await expect(t(page, "runners-cred-text")).toHaveText("No Hetzner token is connected.");
    await expect(t(page, "runners-hz-connect")).toBeFocused();
    await expect(t(page, "runners-srv-create")).toHaveAttribute("aria-disabled", "true");
    await clean(page, errors);
  });

  test("a refused token is told so with Remove, a failed read has Retry, and a 403 reads as owners and admins only", async ({ page }) => {
    const { mock, errors } = await setup(page, { hz: { credential: fx("getHetznerCredential", "200-invalid.json") } });
    await openServers(page);
    await expect(t(page, "runners-cred-text")).toHaveText("Hetzner refused this token. It may have been revoked");
    await expect(t(page, "runners-hz-remove")).toBeVisible();
    await expect(t(page, "runners-srv-create")).toHaveAttribute("aria-disabled", "true");
    mock.hz.credentialFail = 503;
    await press(t(page, "runners-servers-refresh"));
    await expect(t(page, "runners-cred-text")).toHaveText("Hetzner refused this token. It may have been revoked"); // the last good read stays
    await page.reload();
    await waitForDesktop(page);
    await openServers(page);
    await expect(t(page, "runners-cred-text")).toHaveText("Hetzner status couldn't be loaded");
    mock.hz.credentialFail = 0;
    mock.hz.credential = CONNECTED;
    await press(t(page, "runners-cred-retry"));
    await expect(t(page, "runners-cred-text")).toHaveText("Connected (token …a1b2)");
    mock.hz.credentialFail = 403;
    await press(t(page, "runners-servers-refresh"));
    await expect(t(page, "runners-cred-text")).toHaveText("Only owners and admins can connect Hetzner.");
    await expect(t(page, "runners-reason")).toHaveText("Only owners and admins can create a server.");
    await clean(page, errors);
  });
});

test.describe("D#845 MC-10b1: the server list and the create dialog", () => {
  test("the list shows names, words and the size and place; empty and failed reads say so", async ({ page }) => {
    const { mock, errors } = await setup(page, { hz: { credential: CONNECTED, servers: fx("listHetznerServers", "200-list.json").servers as unknown[] } });
    await openServers(page);
    const rows = t(page, "runners-server");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).locator('[data-testid="runners-server-status"]')).toHaveText("Installing");
    await expect(rows.nth(0)).toContainText("cx32 in fsn1");
    await expect(rows.nth(1).locator('[data-testid="runners-server-status"]')).toHaveText("Ready");
    await expect(page.locator(`${WIN} [data-testid="runners-server-name"] bdi`)).toHaveText(["fx-5d1e7a32", "fx-7a2c9e10"]);
    mock.hz.servers = [];
    await press(t(page, "runners-servers-refresh"));
    await expect(t(page, "runners-servers-empty")).toHaveText("No servers yet");
    mock.hz.serversFail = true;
    await page.reload();
    await waitForDesktop(page);
    await openServers(page);
    await expect(t(page, "runners-servers-error")).toHaveText("Servers couldn't be loaded");
    mock.hz.serversFail = false;
    await press(t(page, "runners-servers-retry"));
    await expect(t(page, "runners-servers-empty")).toBeVisible();
    await clean(page, errors);
  });

  test("a failed server says why in words, as text only", async ({ page }) => {
    const base = fx("listHetznerServers", "200-list.json").servers as Record<string, unknown>[];
    const failed = [
      { ...base[0], status: "failed", failure_code: "credential_changed" },
      { ...base[1], status: "failed", failure_code: "<img src=x onerror=alert(1)>" },
    ];
    const { errors } = await setup(page, { hz: { credential: CONNECTED, servers: failed } });
    await openServers(page);
    const why = page.locator('[data-testid="runners-server-why"]');
    await expect(why).toHaveText([
      "The Hetzner token that made this server is no longer connected. Connect it again, then press Delete",
      "This server failed. Press Delete to try again",
    ]);
    await expect(page.locator(`${WIN} [data-testid="runners-server"] img`)).toHaveCount(0);
    await clean(page, errors);
  });

  test("Create a server: the standard-tier sentence before the price, live sizes, the total on the button, and a create with exactly the quoted price", async ({ page }) => {
    const { mock, errors } = await setup(page, { hz: { credential: CONNECTED, servers: [] } });
    await openServers(page);
    await openCreate(page);
    const dlg = dlgOf(page);
    await expect(dlg.locator('[data-testid="runners-create-tier"]')).toHaveText(TIER);
    expect(await dlg.locator('[data-testid="runners-create-tier"]').evaluate((el) => !!(el.compareDocumentPosition(document.querySelector('dialog [data-testid="runners-create-price"]')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    await expect(dlg.locator("#runners-create-loc option")).toHaveText([FSN1, "Nuremberg, DE (nbg1)", "Helsinki, FI (hel1)"]);
    await expect(dlg.locator("#runners-size-cx32")).toBeChecked(); // Small: the cheapest available x86 shared type with 4 vCPU and 8 GB, picked by the cloud
    await expect(dlg.locator('label[for="runners-size-cx32"]')).toContainText("Small · CX32 · 4 vCPU, 8 GB memory, 80 GB disk, x86");
    await expect(dlg.locator('label[for="runners-size-cx42"]')).toContainText("Medium · CX42 · 8 vCPU, 16 GB memory");
    await expect(dlg.locator('[data-testid="runners-create-price"]')).toHaveText("€4.5101 a month for the server and €0.595 a month for its IPv4. Hetzner bills you directly");
    await expect(go(page)).toHaveText("Create server, €5.1051 a month");
    await press(dlg.locator("#runners-size-cx42"));
    await expect(dlg.locator("#runners-size-cx42")).toBeChecked();
    expect(mock.hz.quotes.at(-1)).toBe("cx42 fsn1");
    await press(dlg.locator('[data-testid="runners-create-all"]'));
    await expect(dlg.locator('[data-testid="runners-create-types"] input')).toHaveCount(3); // the rest: CX22, CCX13, CAX21
    await expect(dlg.locator('[data-testid="runners-create-all"]')).toHaveAttribute("aria-expanded", "true");
    await dlg.locator("#runners-create-loc").selectOption("nbg1");
    await expect(dlg.locator('[data-testid="runners-size-none"]')).toHaveText("Medium: not available in Nuremberg, DE (nbg1)");
    await expect(dlg.locator("#runners-size-cx42")).toBeDisabled(); // offered there but full
    await expect(dlg.locator("#runners-size-cx32")).toBeChecked(); // the choice moved to Small
    await dlg.locator("#runners-create-loc").selectOption("fsn1");
    await press(dlg.locator("#runners-size-cx32"));
    await expect(go(page)).toHaveText("Create server, €5.1051 a month");
    await press(go(page));
    await expect(dlg).toHaveCount(0);
    expect(mock.hz.created).toHaveLength(1);
    expect(mock.hz.created[0]!.body).toEqual({ server_type: "cx32", location: "fsn1", quoted: { currency: "EUR", hourly_gross: "0.0070", monthly_gross: "4.5101", ipv4_monthly_gross: "0.5950" } });
    expect(mock.hz.created[0]!.key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await expect(t(page, "runners-servers-created")).toBeVisible();
    await expect(t(page, "runners-server").first().locator('[data-testid="runners-server-status"]')).toHaveText("Creating");
    await expect(t(page, "runners-srv-create")).toBeFocused();
    await clean(page, errors);
  });

  test("the button is off while the price loads and when it failed, and a full size says so; nothing is guessed", async ({ page }) => {
    const { mock, errors } = await setup(page, { hz: { credential: CONNECTED, quoteDelay: 2500 } });
    await openServers(page);
    await press(t(page, "runners-srv-create"));
    await expect(go(page)).toHaveText("Loading price…");
    await expect(go(page)).toHaveAttribute("aria-disabled", "true");
    await go(page).dispatchEvent("click"); // a press while the price is still loading
    expect(mock.hz.created).toHaveLength(0);
    await expect(go(page)).toHaveText(/^Create server, €/);
    await press(dlgOf(page).locator('[data-testid="runners-create-cancel"]'));
    mock.hz.quoteDelay = 0;
    mock.hz.quoteFail = true;
    await press(t(page, "runners-srv-create"));
    await expect(dlgOf(page).locator('[data-testid="runners-create-price"]')).toContainText("Prices couldn't be loaded");
    await expect(go(page)).toHaveText("Create server");
    await expect(go(page)).toHaveAttribute("aria-disabled", "true");
    expect(await dlgOf(page).innerText()).not.toContain("€");
    mock.hz.quoteFail = false;
    await press(dlgOf(page).locator('[data-testid="runners-create-requote"]'));
    await expect(go(page)).toHaveAttribute("aria-disabled", "false");
    mock.hz.quotePatch = { available: false };
    await press(dlgOf(page).locator("#runners-size-cx42"));
    await expect(dlgOf(page).locator('[data-testid="runners-create-price"]')).toHaveText(`That size isn't available in ${FSN1} right now. Choose another size or location`);
    await expect(go(page)).toHaveAttribute("aria-disabled", "true");
    expect(mock.hz.created).toHaveLength(0);
    await clean(page, errors);
  });

  test("locations that cannot be read say so with Retry", async ({ page }) => {
    const { mock, errors } = await setup(page, { hz: { credential: CONNECTED, catalogFail: true } });
    await openServers(page);
    await press(t(page, "runners-srv-create"));
    await expect(dlgOf(page).locator('[data-testid="runners-create-error"]')).toHaveText("Locations couldn't be loaded");
    await expect(go(page)).toHaveAttribute("aria-disabled", "true");
    mock.hz.catalogFail = false;
    await press(dlgOf(page).locator('[data-testid="runners-create-retry"]'));
    await expect(go(page)).toHaveText(/^Create server, €/);
    await clean(page, errors);
  });

  test("after a price change nothing is created and the new price shows; the second click creates at that price", async ({ page }) => {
    const { mock, errors } = await setup(page, { hz: { credential: CONNECTED, servers: [], creates: [{ status: 409, code: "price_changed" }] } });
    await openServers(page);
    await openCreate(page);
    mock.hz.quotePatch = { monthly_gross: "5.0000" }; // Hetzner moved the price after it was shown
    await press(go(page));
    await expect(dlgOf(page).locator('[data-testid="runners-create-error"]')).toHaveText("The price changed. Check the new price and confirm again");
    await expect(go(page)).toHaveText("Create server, €5.595 a month");
    await expect(go(page)).toHaveAttribute("aria-disabled", "false");
    await expect(go(page)).toBeFocused();
    expect(mock.hz.created).toHaveLength(1); // the refused press made nothing, and nothing was sent by itself
    await press(go(page));
    await expect(dlgOf(page)).toHaveCount(0);
    expect(mock.hz.created).toHaveLength(2);
    expect(mock.hz.created[1]!.body.quoted.monthly_gross).toBe("5.0000");
    await clean(page, errors);
  });

  test("every refusal of a create is its own sentence, leaves the dialog open, and a rate limit holds the button for the wait", async ({ page }) => {
    const { mock, errors } = await setup(page, { hz: { credential: CONNECTED, servers: [] } });
    await openServers(page);
    await openCreate(page);
    for (const [answer, words] of [
      [{ status: 409, code: "hetzner_resource_limit_exceeded" }, "Hetzner's server limit for your Hetzner account was reached. Ask Hetzner to raise it, or delete a server"],
      [{ status: 409, code: "hetzner_resource_unavailable" }, `That size isn't available in ${FSN1} right now. Choose another size or location`],
      [{ status: 409, code: "hetzner_unauthorized" }, "Hetzner refused this token. It may have been revoked. Remove it and add a new one"],
      [{ status: 409, code: "hetzner_forbidden" }, "The Hetzner token can't do that. It needs Read & Write access"],
    ] as const) {
      mock.hz.creates = [answer];
      const before = mock.hz.created.length;
      await press(go(page));
      await expect(dlgOf(page).locator('[data-testid="runners-create-error"]')).toHaveText(words);
      expect(mock.hz.created).toHaveLength(before + 1);
      await expect(go(page)).toHaveAttribute("aria-disabled", "false");
    }
    expect(mock.hz.created[0]!.key).not.toBe(mock.hz.created[1]!.key); // an answer ends the key
    // A 429 is not an answer from the create: it may have come from in front of one that landed, so the key and the lock stay, even on a first press.
    mock.hz.creates = [{ status: 429, code: "rate_limited", retryAfter: 2 }];
    const before = mock.hz.created.length;
    await press(go(page));
    await expect(dlgOf(page).locator('[data-testid="runners-create-error"]')).toHaveText(/^That was too fast\. Try again in [12] seconds?\.$/);
    await expect(go(page)).toHaveAttribute("aria-disabled", "true");
    await expect(go(page)).toHaveAttribute("aria-disabled", "false", { timeout: 6000 });
    await expect(dlgOf(page).locator('[data-testid="runners-create-error"]')).toHaveText("Too many tries, wait a moment, then press Create again."); // the wait is over; the key was kept
    await press(go(page));
    await expect(dlgOf(page)).toHaveCount(0);
    expect(mock.hz.created).toHaveLength(before + 2);
    expect(mock.hz.created[before + 1]!.key).toBe(mock.hz.created[before]!.key);
    await clean(page, errors);
  });

  test("Cancel and Escape make nothing and return focus; both dialogs pass axe under two themes and fit the window", async ({ page }) => {
    const { mock, errors } = await setup(page, { hz: { credential: fx("getHetznerCredential", "200-none.json") } });
    await openServers(page);
    for (const theme of ["classic-crt", "nord"]) {
      await applyTheme(page, theme);
      expect(await axeSeriousOrCritical(page, WIN), theme).toEqual([]);
      await press(t(page, "runners-hz-connect"));
      expect(await axeSeriousOrCritical(page, "dialog[open]"), `connect ${theme}`).toEqual([]);
      expect(await dlgOf(page).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.keyboard.press("Escape");
      await expect(dlgOf(page)).toHaveCount(0);
      await expect(t(page, "runners-hz-connect")).toBeFocused();
    }
    mock.hz.credential = CONNECTED;
    await press(t(page, "runners-servers-refresh"));
    for (const theme of ["classic-crt", "nord"]) {
      await applyTheme(page, theme);
      await press(t(page, "runners-srv-create"));
      await expect(go(page)).toHaveText(/^Create server, €/);
      await press(dlgOf(page).locator('[data-testid="runners-create-all"]'));
      expect(await axeSeriousOrCritical(page, "dialog[open]"), `create ${theme}`).toEqual([]);
      expect(await dlgOf(page).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.keyboard.press("Escape");
      await expect(dlgOf(page)).toHaveCount(0);
      await expect(t(page, "runners-srv-create")).toBeFocused();
    }
    expect(mock.hz.created).toHaveLength(0);
    expect(await axeSeriousOrCritical(page, WIN)).toEqual([]);
    expect(await page.locator(`${WIN} .runners-app`).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await clean(page, errors);
  });
});

const UNKNOWN = "We couldn't tell whether your last server was made. Check the list below before trying again.";
test.describe("D#845 MC-10b1: a create whose outcome is unknown", () => {
  test("a lost answer, then 409 in progress, then more presses: one key, one body, the size and place locked, the list read again, and the one that settles it closes the dialog", async ({ page }) => {
    const { mock, errors } = await setup(page, { hz: { credential: CONNECTED, servers: [], creates: [{ status: 0, code: "" }, { status: 409, code: "idempotency_in_progress" }, { status: 500, code: "server_error" }] } });
    await openServers(page);
    await openCreate(page);
    const dlg = dlgOf(page);
    const reads = mock.hz.listReads;
    await press(go(page));
    await expect(dlg.locator('[data-testid="runners-create-error"]')).toHaveText(UNKNOWN);
    await expect.poll(() => mock.hz.listReads).toBeGreaterThan(reads); // the list is read again at once
    await expect(dlg.locator("#runners-create-loc")).toBeDisabled();
    await expect(dlg.locator("#runners-size-cx42")).toBeDisabled();
    await expect(dlg.locator("#runners-size-cx32")).toBeDisabled();
    for (let i = 0; i < 2; i++) {
      await press(go(page));
      await expect(dlg.locator('[data-testid="runners-create-error"]')).toHaveText(UNKNOWN);
      expect(mock.hz.created).toHaveLength(i + 2);
    }
    await press(go(page)); // nothing left to refuse: made
    await expect(dlg).toHaveCount(0);
    expect(mock.hz.created).toHaveLength(4);
    expect(new Set(mock.hz.created.map((c) => c.key)).size).toBe(1);
    expect(new Set(mock.hz.created.map((c) => JSON.stringify(c.body))).size).toBe(1);
    await clean(page, errors);
  });

  test("a lost answer, then a 429: the button waits, and the next press sends the SAME key and body", async ({ page }) => {
    const { mock, errors } = await setup(page, { hz: { credential: CONNECTED, servers: [], creates: [{ status: 0, code: "" }, { status: 429, code: "rate_limited", retryAfter: 2 }] } });
    await openServers(page);
    await openCreate(page);
    await press(go(page));
    await expect(dlgOf(page).locator('[data-testid="runners-create-error"]')).toHaveText(UNKNOWN);
    await press(go(page));
    await expect(dlgOf(page).locator('[data-testid="runners-create-error"]')).toHaveText(/^That was too fast\. Try again in [12] seconds?\.$/);
    await expect(go(page)).toHaveAttribute("aria-disabled", "true");
    await expect(go(page)).toHaveAttribute("aria-disabled", "false", { timeout: 6000 });
    await expect(dlgOf(page).locator('[data-testid="runners-create-error"]')).toHaveText("Too many tries, wait a moment, then press Create again."); // the wait is over; the key was kept
    await press(go(page));
    await expect(dlgOf(page)).toHaveCount(0);
    expect(mock.hz.created).toHaveLength(3);
    expect(new Set(mock.hz.created.map((c) => c.key)).size).toBe(1);
    expect(new Set(mock.hz.created.map((c) => JSON.stringify(c.body))).size).toBe(1);
    await clean(page, errors);
  });

  test("hetzner_locked on a first press keeps the key and the lock: the next press sends the same key", async ({ page }) => {
    const { mock, errors } = await setup(page, { hz: { credential: CONNECTED, servers: [], creates: [{ status: 409, code: "hetzner_locked" }] } });
    await openServers(page);
    await openCreate(page);
    await press(go(page));
    await expect(dlgOf(page).locator('[data-testid="runners-create-error"]')).toHaveText(UNKNOWN);
    await expect(dlgOf(page).locator("#runners-create-loc")).toBeDisabled();
    await press(go(page));
    await expect(dlgOf(page)).toHaveCount(0);
    expect(mock.hz.created).toHaveLength(2);
    expect(mock.hz.created[1]!.key).toBe(mock.hz.created[0]!.key);
    await clean(page, errors);
  });

  test("Cancel and Escape after a lost answer keep the key: the reopened dialog is locked to the same size and says so, and its press sends the same key", async ({ page }) => {
    const { mock, errors } = await setup(page, { hz: { credential: CONNECTED, servers: [], creates: [{ status: 0, code: "" }] } });
    await openServers(page);
    await openCreate(page);
    await press(dlgOf(page).locator("#runners-size-cx42"));
    await expect(go(page)).toHaveText(/^Create server, /);
    await press(go(page));
    await expect(dlgOf(page).locator('[data-testid="runners-create-error"]')).toHaveText(UNKNOWN);
    await press(dlgOf(page).locator('[data-testid="runners-create-cancel"]'));
    await expect(dlgOf(page)).toHaveCount(0);
    await openCreate(page);
    await expect(dlgOf(page).locator("#runners-size-cx42")).toBeChecked();
    await expect(dlgOf(page).locator("#runners-size-cx42")).toBeDisabled();
    await expect(dlgOf(page).locator('[data-testid="runners-create-error"]')).toHaveText(UNKNOWN);
    await page.keyboard.press("Escape");
    await expect(dlgOf(page)).toHaveCount(0);
    await openCreate(page);
    await press(go(page));
    await expect(dlgOf(page)).toHaveCount(0);
    expect(mock.hz.created).toHaveLength(2);
    expect(mock.hz.created[1]!.key).toBe(mock.hz.created[0]!.key);
    expect(mock.hz.created[1]!.body).toEqual(mock.hz.created[0]!.body);
    await clean(page, errors);
  });

  test("a key reused is never answered with a new key: the person is told to check the list and chooses Create a new one", async ({ page }) => {
    const { mock, errors } = await setup(page, { hz: { credential: CONNECTED, servers: [], creates: [{ status: 0, code: "" }, { status: 422, code: "idempotency_key_reused" }] } });
    await openServers(page);
    await openCreate(page);
    await press(go(page));
    await press(go(page));
    await expect(dlgOf(page).locator('[data-testid="runners-create-error"]')).toHaveText(UNKNOWN);
    await expect(go(page)).toHaveAttribute("aria-disabled", "true");
    expect(mock.hz.created).toHaveLength(2);
    await press(dlgOf(page).locator('[data-testid="runners-create-new"]'));
    await expect(dlgOf(page).locator('[data-testid="runners-create-error"]')).toHaveCount(0);
    await expect(dlgOf(page).locator("#runners-size-cx42")).toBeEnabled();
    await expect(go(page)).toHaveText(/^Create server, /);
    await expect(go(page)).toHaveAttribute("aria-disabled", "false");
    await press(go(page));
    await expect(dlgOf(page)).toHaveCount(0);
    expect(mock.hz.created).toHaveLength(3);
    expect(mock.hz.created[2]!.key).not.toBe(mock.hz.created[0]!.key);
    await clean(page, errors);
  });

  test("a late 201 for a dialog that was cancelled and reopened closes it with the notice: no Create button is live and nothing is sent again", async ({ page }) => {
    const { mock, errors } = await setup(page, { hz: { credential: CONNECTED, servers: [], createDelay: 5000 } });
    await openServers(page);
    await openCreate(page);
    await press(go(page));
    await expect(go(page)).toHaveText("Creating…");
    await press(dlgOf(page).locator('[data-testid="runners-create-cancel"]'));
    await expect(dlgOf(page)).toHaveCount(0);
    await press(t(page, "runners-srv-create"));
    await expect(go(page)).toHaveText("Creating…"); // the attempt is still in the air; a press cannot send a second
    await go(page).dispatchEvent("click"); // Playwright would wait for aria-disabled to clear, so the press is sent as an event
    expect(mock.hz.created).toHaveLength(1);
    await expect(dlgOf(page)).toHaveCount(0, { timeout: 15000 }); // the answer arrived: the reopened dialog is closed by it
    await expect(t(page, "runners-servers-created")).toHaveCount(1); // with the normal notice
    await expect(t(page, "runners-server")).toHaveCount(1); // and the list was read
    await expect(go(page)).toHaveCount(0); // no Create button is live
    await page.waitForTimeout(300);
    expect(mock.hz.created).toHaveLength(1); // and nothing was sent after the answer
    await clean(page, errors);
  });
});

test.describe("D#845 MC-10b1: a member on the Servers tab", () => {
  test("a member is told only owners and admins can see servers, and the credential and the list are never asked for", async ({ page }) => {
    const asked: string[] = [];
    page.on("request", (r) => /\/api\/v1\/machine-/.test(r.url()) && asked.push(r.url()));
    const { errors } = await setup(page, { role: "member", isAdmin: false });
    await openServers(page);
    await expect(t(page, "runners-servers-forbidden")).toHaveText("Only owners and admins can see servers.");
    await expect(t(page, "runners-cred-text")).toHaveText("Only owners and admins can connect Hetzner.");
    await expect(t(page, "runners-srv-create")).toHaveAttribute("aria-disabled", "true");
    await expect(t(page, "runners-reason")).toHaveText("Only owners and admins can create a server.");
    await expect(t(page, "runners-server")).toHaveCount(0);
    expect(asked).toEqual([]);
    expect(await axeSeriousOrCritical(page, WIN)).toEqual([]);
    await clean(page, errors);
  });

  test("when the fleet read fails nobody's role is known: the failure shows with Retry, no machine read is made, and a good read then loads the Servers", async ({ page }) => {
    const asked: string[] = [];
    page.on("request", (r) => /\/api\/v1\/machine-/.test(r.url()) && asked.push(r.url()));
    const { mock, errors } = await setup(page, { role: "member", isAdmin: false, getFails: true, hz: { credential: CONNECTED, servers: [] } });
    await openServers(page);
    await expect(t(page, "runners-servers-fleet-error")).toHaveText("Runners aren't available right now.");
    await expect(t(page, "runners-srv-create")).toHaveAttribute("aria-disabled", "true");
    await page.waitForTimeout(500);
    expect(asked).toEqual([]);
    mock.getFails = false;
    mock.role = "admin";
    await press(t(page, "runners-servers-fleet-retry"));
    await expect(t(page, "runners-servers-empty")).toBeVisible();
    expect(asked.length).toBeGreaterThan(0);
    await clean(page, errors);
  });
});

// ── D#845 MC-10b2: Servers part 2, the elapsed-time states, the server actions, the Claude sign-in and move ──
const BASE_SERVERS = fx("listHetznerServers", "200-list.json").servers as Record<string, unknown>[];
const RUN = "3c9a1f52-6d84-4e07-b2a1-8f5d0c7e9a13"; // the runner of the fixture's ready server
const RUN2 = "55555555-aaaa-4aaa-8aaa-555555555552";
const RUN3 = "55555555-aaaa-4aaa-8aaa-555555555553";
const RUN4 = "55555555-aaaa-4aaa-8aaa-555555555554";
const LINK = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&scope=user%3Ainference";
const farFuture = "2099-01-01T00:00:00.000Z";
const ago = (n: number) => new Date(Date.now() - n * 60000).toISOString();
const sv = (n: number, over: Record<string, unknown> = {}) => ({ ...BASE_SERVERS[1], id: `aaaaaaaa-0000-4000-8000-00000000000${n}`, name: `fx-s${n}`, runner_id: null, claude_signed_in: null, last_seen_at: null, placed_projects: [], price: BASE_SERVERS[0]!.price, ...over });
const mach = (id: string, name: string, over: Record<string, unknown> = {}) => ({ id, name, tier: "microvm", kvm: "present", live: true, claude: true, running: null, ...over });
const request = (status: string, over: Record<string, unknown> = {}) => ({ request: { request_id: "66666666-6666-4666-8666-666666666666", status, expires_at: farFuture, auth_url: null, failure_code: null, ...over } });
const row = (page: Page, i: number) => t(page, "runners-server").nth(i);
const refresh = (page: Page) => press(t(page, "runners-servers-refresh"));
const yes = (page: Page) => dlgOf(page).locator('[data-testid="runners-confirm-yes"]');
const DELETE_DISK = "This deletes the server and its firewall at Hetzner, and everything on its disk. It can't be undone.";

test.describe("D#845 MC-10b2: the elapsed-time states", () => {
  test("a step past 5, 10, 25 and 35 minutes (creating, booting, installing, registering) says 'Taking longer than usual' and offers Delete and retry; one just under does not", async ({ page }) => {
    const states: Array<[string, number, boolean]> = [["creating", 3, false], ["creating", 6, true], ["booting", 9, false], ["booting", 11, true], ["installing", 24, false], ["installing", 26, true], ["registering", 34, false], ["registering", 36, true]];
    const { mock, errors } = await setup(page, { hz: { credential: CONNECTED, servers: states.map(([status, m], i) => sv(i + 1, { status, status_at: ago(m) })) } });
    await openServers(page);
    for (const [i, [status, m, slow]] of states.entries()) {
      const r = row(page, i);
      await expect(r.locator('[data-testid="runners-server-status"]')).toHaveText({ creating: "Creating", booting: "Starting up", installing: "Installing", registering: "Registering" }[status]!);
      await expect(r.locator('[data-testid="runners-server-line"]').first()).toHaveText(m === 3 ? /^This step started [23] min ago$/ : new RegExp(`^This step started ${m} min ago$`));
      await expect(r.locator('[data-testid="runners-server-line"]')).toHaveCount(slow ? 2 : 1);
      if (slow) await expect(r.locator('[data-testid="runners-server-line"]').nth(1)).toHaveText("Taking longer than usual");
      await expect(r.locator('[data-testid="runners-srv-retry"]')).toHaveCount(slow ? 1 : 0);
      await expect(r.locator('[data-testid="runners-srv-reboot"]')).toHaveCount(0); // a server still being made is not rebooted
    }
    // Delete and retry: the name is typed first, nothing is sent until it matches, and the list then says how to try again.
    await press(row(page, 1).locator('[data-testid="runners-srv-retry"]'));
    const dlg = dlgOf(page);
    await expect(dlg.locator("h2")).toHaveText("Delete and retry fx-s2?");
    await expect(dlg).toContainText(DELETE_DISK + " It stops costing €5.1051 a month.");
    await expect(yes(page)).toHaveText("Delete and retry");
    await expect(yes(page)).toHaveAttribute("aria-disabled", "true");
    await expect(dlg.locator('[data-testid="runners-del-why"]')).toHaveText("Type the server's name to confirm.");
    await yes(page).dispatchEvent("click"); // a disabled button sends nothing
    expect(mock.hz.acts).toEqual([]);
    const typed = dlg.locator('[data-testid="runners-del-name"]');
    await expect(typed).toHaveAttribute("autocomplete", "off");
    await typed.fill("fx-s");
    await expect(yes(page)).toHaveAttribute("aria-disabled", "true");
    await typed.fill("fx-s2");
    await expect(yes(page)).toHaveAttribute("aria-disabled", "false");
    await press(yes(page));
    await expect(dlg).toHaveCount(0);
    expect(mock.hz.acts).toEqual([{ method: "DELETE", path: "/api/v1/machine-servers/aaaaaaaa-0000-4000-8000-000000000002", body: undefined }]);
    await expect(row(page, 1).locator('[data-testid="runners-server-note"]')).toHaveText("Deleted. Press Create server to try again.");
    await expect(row(page, 1).locator('[data-testid="runners-server-status"]')).toHaveText("Deleting…");
    await expect(t(page, "runners-srv-create")).toBeFocused();
    await clean(page, errors);
  });

  test("a ready server whose machine is offline says Offline and when it was last seen, and offers Reboot; a live one says neither", async ({ page }) => {
    const { errors } = await setup(page, {
      machines: [mach(RUN, "fx-s1", { live: false }), mach(RUN2, "fx-s2")],
      hz: { credential: CONNECTED, servers: [sv(1, { runner_id: RUN, last_seen_at: ago(9) }), sv(2, { runner_id: RUN2, last_seen_at: ago(0) }), sv(3, { runner_id: null, status: "ready" })] },
    });
    await openServers(page);
    await expect(row(page, 0).locator('[data-testid="runners-server-status"]')).toHaveText("Offline");
    await expect(row(page, 0).locator('[data-testid="runners-server-line"]')).toHaveText("Last seen 9 min ago");
    await expect(row(page, 0).locator('[data-testid="runners-srv-reboot"]')).toBeVisible();
    await expect(row(page, 1).locator('[data-testid="runners-server-status"]')).toHaveText("Ready");
    await expect(row(page, 1).locator('[data-testid="runners-server-line"]')).toHaveCount(0);
    await expect(row(page, 1).locator('[data-testid="runners-srv-reboot"]')).toBeVisible();
    await expect(row(page, 2).locator('[data-testid="runners-server-line"]')).toHaveCount(0); // no runner is linked, so liveness is not known and nothing is claimed
    await clean(page, errors);
  });
});

test.describe("D#845 MC-10b2: reboot, delete, keep and delete-orphan", () => {
  test("Reboot says what it does, a refusal is a sentence and keeps the sheet, Cancel sends nothing, and focus returns", async ({ page }) => {
    const { mock, errors } = await setup(page, { machines: [mach(RUN, "fx-s1")], hz: { credential: CONNECTED, servers: [sv(1, { runner_id: RUN, last_seen_at: ago(0) })] } });
    await openServers(page);
    const reboot = row(page, 0).locator('[data-testid="runners-srv-reboot"]');
    await press(reboot);
    const dlg = dlgOf(page);
    await expect(dlg.locator("h2")).toHaveText("Reboot fx-s1?");
    await expect(dlg).toContainText("Hetzner restarts this server now. Work running on it stops and starts again when it is back, usually within a few minutes. Nothing is deleted and the price doesn't change.");
    await press(dlg.locator('[data-testid="runners-confirm-cancel"]'));
    await expect(dlg).toHaveCount(0);
    await expect(reboot).toBeFocused();
    expect(mock.hz.acts).toEqual([]);
    await press(reboot);
    mock.hz.actRefusals = [{ status: 409, code: "server_not_rebootable" }, { status: 409, code: "hetzner_locked" }];
    await press(yes(page));
    await expect(dlg.locator('[data-testid="runners-confirm-error"]')).toHaveText("This server can't be restarted in its current state");
    await press(yes(page));
    await expect(dlg.locator('[data-testid="runners-confirm-error"]')).toHaveText("Hetzner reports the item is busy. Try again in a minute");
    await press(yes(page));
    await expect(dlg).toHaveCount(0);
    expect(mock.hz.acts.map((a) => `${a.method} ${a.path}`)).toEqual(Array(3).fill("POST /api/v1/machine-servers/aaaaaaaa-0000-4000-8000-000000000001/reboot"));
    await expect(row(page, 0).locator('[data-testid="runners-server-note"]')).toHaveText("Reboot sent to Hetzner.");
    await expect(reboot).toBeFocused();
    await clean(page, errors);
  });

  test("a server with projects lists them, needs the box ticked, and sends remove_projects; one with none says 'No projects' and its price", async ({ page }) => {
    const placed = [{ repo_id: REPO_WEB, name: "acme/web" }, { repo_id: REPO_API, name: "acme/api" }];
    const { mock, errors } = await setup(page, { machines: [mach(RUN, "fx-s1"), mach(RUN2, "fx-s2")], hz: { credential: CONNECTED, servers: [sv(1, { runner_id: RUN, last_seen_at: ago(0), placed_projects: placed }), sv(2, { runner_id: RUN2, last_seen_at: ago(0) })] } });
    await openServers(page);
    await expect(row(page, 0).locator('[data-testid="runners-srv-projects"] li bdi')).toHaveText(["acme/web", "acme/api"]);
    await expect(row(page, 1).locator('[data-testid="runners-srv-noprojects"]')).toHaveText("No projects · €5.1051 a month");
    await press(row(page, 0).locator('[data-testid="runners-srv-delete"]'));
    const dlg = dlgOf(page);
    await expect(dlg.locator("h2")).toHaveText("Delete fx-s1?");
    await expect(dlg.locator('[data-testid="runners-del-projects-list"] li')).toHaveText(["acme/web", "acme/api"]);
    await expect(dlg).toContainText("It stops costing €5.1051 a month.");
    await dlg.locator('[data-testid="runners-del-name"]').fill("fx-s1");
    await expect(yes(page)).toHaveAttribute("aria-disabled", "true"); // the name matches but its projects are neither moved nor ticked
    await expect(dlg.locator('[data-testid="runners-del-why"]')).toHaveText("Tick the box to remove its projects with it, or move them to another machine first.");
    await press(dlg.locator('[data-testid="runners-del-projects"]'));
    await expect(yes(page)).toHaveAttribute("aria-disabled", "false");
    mock.hz.actRefusals = [{ status: 409, code: "project_removal_unavailable" }];
    await press(yes(page));
    await expect(dlg.locator('[data-testid="runners-confirm-error"]')).toHaveText("Removing projects together with a server isn't available yet. Move them to another machine first");
    await press(yes(page));
    await expect(dlg).toHaveCount(0);
    expect(mock.hz.acts.map((a) => `${a.method} ${a.path}`)).toEqual(Array(2).fill("DELETE /api/v1/machine-servers/aaaaaaaa-0000-4000-8000-000000000001?remove_projects=true"));
    // The server with none: no list, no box, and the plain delete (no query).
    await press(row(page, 1).locator('[data-testid="runners-srv-delete"]'));
    await expect(dlg.locator('[data-testid="runners-del-projects"]')).toHaveCount(0);
    await dlg.locator('[data-testid="runners-del-name"]').fill("fx-s2");
    await press(yes(page));
    await expect(dlg).toHaveCount(0);
    expect(mock.hz.acts.at(-1)).toEqual({ method: "DELETE", path: "/api/v1/machine-servers/aaaaaaaa-0000-4000-8000-000000000002", body: undefined });
    await clean(page, errors);
  });

  test("a failed server offers Delete; an orphan offers Keep it and Delete it in Hetzner, and Keep it is shown as done from `kept`", async ({ page }) => {
    const { mock, errors } = await setup(page, { hz: { credential: CONNECTED, servers: [sv(1, { status: "failed", failure_code: "delete_failed" }), sv(2, { status: "orphaned", price: null, name: "fx-orphan" })] } });
    await openServers(page);
    await expect(row(page, 0).locator('[data-testid="runners-srv-delete"]')).toHaveText("Delete server");
    await expect(row(page, 0).locator('[data-testid="runners-srv-reboot"]')).toHaveCount(0);
    await expect(row(page, 1).locator('[data-testid="runners-server-status"]')).toHaveText("A server we created that isn't linked any more");
    await expect(row(page, 1).locator("button")).toHaveText(["Keep it", "Delete it in Hetzner"]);
    await press(row(page, 1).locator('[data-testid="runners-srv-keep"]'));
    await expect(row(page, 1).locator('[data-testid="runners-server-line"]')).toHaveText("You chose to keep it. We leave it alone.");
    await expect(row(page, 1).locator('[data-testid="runners-srv-keep"]')).toHaveCount(0);
    await expect(row(page, 1).locator('[data-testid="runners-srv-delete-orphan"]')).toBeFocused();
    expect(mock.hz.acts).toEqual([{ method: "POST", path: "/api/v1/machine-servers/aaaaaaaa-0000-4000-8000-000000000002/keep", body: undefined }]);
    await page.reload(); // kept is read from the cloud, so it is still shown after a reload
    await waitForDesktop(page);
    await openServers(page);
    await expect(row(page, 1).locator('[data-testid="runners-server-line"]')).toHaveText("You chose to keep it. We leave it alone.");
    await press(row(page, 1).locator('[data-testid="runners-srv-delete-orphan"]'));
    const dlg = dlgOf(page);
    await expect(dlg).toContainText("This deletes the server and its firewall at Hetzner, and everything on its disk. It can't be undone.");
    await expect(dlg).not.toContainText("stops costing"); // an orphan was never priced
    await dlg.locator('[data-testid="runners-del-name"]').fill("fx-orphan");
    mock.hz.actRefusals = [{ status: 409, code: "credential_changed" }];
    await press(yes(page));
    await expect(dlg.locator('[data-testid="runners-confirm-error"]')).toHaveText("The Hetzner token that made this server isn't the connected one. Connect that token, then try again");
    await press(yes(page));
    await expect(dlg).toHaveCount(0);
    expect(mock.hz.acts.at(-1)).toEqual({ method: "POST", path: "/api/v1/machine-servers/aaaaaaaa-0000-4000-8000-000000000002/delete-orphan", body: undefined });
    await clean(page, errors);
  });

  test("a failed keep says so in a sentence and leaves the card as it was", async ({ page }) => {
    const { mock, errors } = await setup(page, { hz: { credential: CONNECTED, servers: [sv(1, { status: "orphaned", price: null })] } });
    await openServers(page);
    mock.hz.actRefusals = [{ status: 409, code: "not_an_orphan" }];
    await press(row(page, 0).locator('[data-testid="runners-srv-keep"]'));
    await expect(row(page, 0).locator('[data-testid="runners-server-note"]')).toHaveText("This server isn't an orphan any more. Refresh the list");
    await expect(row(page, 0).locator('[data-testid="runners-srv-keep"]')).toBeVisible();
    await clean(page, errors);
  });
});

test.describe("D#845 MC-10b2: the Claude sign-in", () => {
  test("a server with no runner yet says it has not connected; one with a runner signs in on that runner's id, step by step, and the code is cleared once sent", async ({ page }) => {
    const { mock, errors } = await setup(page, { hz: { credential: CONNECTED, servers: [sv(1, { status: "needs_claude_login", name: "fx-s1" })] } });
    await openServers(page);
    await expect(t(page, "runners-signin-wait")).toHaveText("fx-s1 has not connected yet. Sign-in opens once it has.");
    await expect(t(page, "runners-signin-start")).toHaveCount(0);
    mock.hz.servers = [sv(1, { status: "needs_claude_login", runner_id: RUN, name: "A name that is not the runner's" })];
    await refresh(page);
    await expect(t(page, "runners-signin-start")).toHaveText("Sign in to Claude on A name that is not the runner's");
    await press(t(page, "runners-signin-start"));
    await expect(t(page, "runners-signin-status")).toHaveText("Starting the sign-in on A name that is not the runner's…");
    expect(mock.hz.acts).toEqual([{ method: "POST", path: `/api/runners/${RUN}/claude-login`, body: undefined }]); // the runner's id, never a name
    mock.hz.login[RUN] = request("awaiting_code", { auth_url: LINK });
    await refresh(page);
    const open = t(page, "runners-signin-open");
    await expect(open).toHaveText("Open Claude sign-in");
    await expect(open).toHaveAttribute("href", LINK);
    await expect(open).toHaveAttribute("target", "_blank");
    await expect(open).toHaveAttribute("rel", /noopener/);
    const code = t(page, "runners-signin-code");
    await expect(code).toHaveAttribute("autocomplete", "off");
    await expect(code).not.toHaveAttribute("type", "password");
    await code.fill("abc-123_XYZ");
    await refresh(page); // a read in the middle of typing keeps what was typed
    await expect(code).toHaveValue("abc-123_XYZ");
    await press(t(page, "runners-signin-send"));
    await expect(t(page, "runners-signin-status")).toHaveText("Code sent. Waiting for A name that is not the runner's…");
    expect(mock.hz.acts.at(-1)).toEqual({ method: "POST", path: `/api/runners/${RUN}/claude-login/code`, body: { code: "abc-123_XYZ" } });
    expect(await page.evaluate(() => document.body.innerText + [...document.querySelectorAll("input")].map((i) => i.value).join(" "))).not.toContain("abc-123_XYZ");
    await clean(page, errors);
  });

  test("a refused code, an expired link and any other failure each say so in one sentence with Start again; a hostile link is never offered", async ({ page }) => {
    const { mock, errors } = await setup(page, { hz: { credential: CONNECTED, servers: [sv(1, { status: "needs_claude_login", runner_id: RUN })] } });
    await openServers(page);
    for (const [reply, words] of [
      [request("failed", { failure_code: "invalid_code" }), "Claude didn't accept that code. Start again"],
      [request("expired"), "That sign-in link expired. Start again"],
      [request("failed", { failure_code: "no_link" }), "The sign-in didn't finish. Start again"],
    ] as const) {
      mock.hz.login[RUN] = reply;
      await refresh(page);
      await expect(t(page, "runners-signin-words")).toHaveText(words);
      await expect(t(page, "runners-signin-start")).toHaveText("Start again");
    }
    const before = mock.hz.acts.length;
    await press(t(page, "runners-signin-start"));
    await expect(t(page, "runners-signin-status")).toHaveText(/^Starting the sign-in on /);
    expect(mock.hz.acts).toHaveLength(before + 1);
    mock.hz.login[RUN] = request("awaiting_code", { auth_url: "javascript:alert(1)" });
    await refresh(page);
    await expect(t(page, "runners-signin-nolink")).toHaveText("Waiting for the link…");
    await expect(page.locator(`${WIN} a[href^="javascript"]`)).toHaveCount(0);
    mock.hz.actRefusals = [{ status: 409, code: "no_login_waiting" }];
    await t(page, "runners-signin-code").fill("zzz");
    await press(t(page, "runners-signin-send"));
    await expect(t(page, "runners-signin-error")).toHaveText("No sign-in is waiting for a code. Start again");
    mock.hz.login[RUN] = request("failed", { failure_code: "invalid_code", expires_at: "2000-01-01T00:00:00.000Z" }); // older than the server's state: history, not shown again
    await refresh(page);
    await expect(t(page, "runners-signin-words")).toHaveCount(0);
    await expect(t(page, "runners-signin-start")).toHaveText(/^Sign in to Claude on /);
    await clean(page, errors);
  });

  test("a signed-in server offers Sign out of Claude behind a sheet that says what follows, and sends it on the runner's id", async ({ page }) => {
    const { mock, errors } = await setup(page, { machines: [mach(RUN, "fx-s1")], hz: { credential: CONNECTED, servers: [sv(1, { runner_id: RUN, claude_signed_in: true, last_seen_at: ago(0) })] } });
    await openServers(page);
    await expect(t(page, "runners-signin")).toHaveCount(0);
    await press(t(page, "runners-srv-signout"));
    const dlg = dlgOf(page);
    await expect(dlg.locator("h2")).toHaveText("Sign fx-s1 out of Claude?");
    await expect(dlg).toContainText("Claude is signed out on this server when it next checks in. Work that needs Claude waits until you sign in again.");
    await press(yes(page));
    await expect(dlg).toHaveCount(0);
    expect(mock.hz.acts).toEqual([{ method: "POST", path: `/api/runners/${RUN}/claude-logout`, body: undefined }]);
    await expect(t(page, "runners-server-note")).toHaveText("Sign-out sent. This updates when the server next reports.");
    mock.hz.servers = [sv(1, { runner_id: RUN, claude_signed_in: false, last_seen_at: ago(0) })]; // the machine's next report: the panel is back
    await refresh(page);
    await expect(t(page, "runners-signin-start")).toHaveText("Sign in to Claude on fx-s1");
    // The server's last sign-in request is still the newest one and finished as done: it is history, so Start is offered, in this session and after a reload.
    mock.hz.login[RUN] = request("done");
    await refresh(page);
    await expect(t(page, "runners-signin-start")).toHaveText("Sign in to Claude on fx-s1");
    await expect(t(page, "runners-signin-status")).toHaveCount(0);
    await page.reload();
    await waitForDesktop(page);
    await openServers(page);
    await expect(t(page, "runners-signin-start")).toHaveText("Sign in to Claude on fx-s1");
    await expect(t(page, "runners-signin-status")).toHaveCount(0);
    await press(t(page, "runners-signin-start")); // and signing in again works
    await expect(t(page, "runners-signin-status")).toHaveText("Starting the sign-in on fx-s1…");
    mock.hz.login[RUN] = request("done");
    mock.hz.servers = [sv(1, { runner_id: RUN, claude_signed_in: true, last_seen_at: ago(0) })];
    await refresh(page);
    await expect(t(page, "runners-signin")).toHaveCount(0);
    await expect(t(page, "runners-srv-signout")).toBeVisible();
    await clean(page, errors);
  });
});

test.describe("D#845 MC-10b2: move to another machine", () => {
  const placed = [{ repo_id: REPO_WEB, name: "acme/web" }];
  test("lists only online machines with room, says what happens, sends { to_runner_id }, and a refusal is a sentence", async ({ page }) => {
    const { mock, errors } = await setup(page, {
      machines: [mach(RUN, "fx-s1"), mach(RUN2, "Laptop"), mach(RUN3, "Old box", { live: false }), mach(RUN4, "Busy one", { tier: "standard", running: { repo_id: REPO_API, name: "acme/api" } })],
      hz: { credential: CONNECTED, servers: [sv(1, { runner_id: RUN, last_seen_at: ago(0), placed_projects: placed })] },
    });
    await openServers(page);
    const move = t(page, "runners-srv-move");
    await expect(move).toHaveText("Move to another machine");
    await press(move);
    const dlg = dlgOf(page);
    await expect(dlg.locator("h2")).toHaveText("Move acme/web to another machine?");
    await expect(dlg).toContainText("acme/web stops running on fx-s1 and starts on the machine you choose. Its team memory is not carried along; it starts fresh there.");
    await expect(dlg.locator('[data-testid="runners-move-to"] option')).toHaveText(["Laptop"]);
    mock.hz.actRefusals = [{ status: 409, code: "machine_single_project" }];
    await press(yes(page));
    await expect(dlg.locator('[data-testid="runners-confirm-error"]')).toHaveText("That machine uses Standard isolation and already hosts a project");
    await press(yes(page));
    await expect(dlg).toHaveCount(0);
    expect(mock.hz.acts.at(-1)).toEqual({ method: "POST", path: `/api/runners/repos/${REPO_WEB}/move`, body: { to_runner_id: RUN2 } });
    await expect(t(page, "runners-server-note")).toHaveText("acme/web was moved.");
    await clean(page, errors);
  });

  test("with no other machine to take it, the sheet says so and Move project is off", async ({ page }) => {
    const { mock, errors } = await setup(page, { machines: [mach(RUN, "fx-s1")], hz: { credential: CONNECTED, servers: [sv(1, { runner_id: RUN, last_seen_at: ago(0), placed_projects: placed })] } });
    await openServers(page);
    await press(t(page, "runners-srv-move"));
    await expect(dlgOf(page).locator('[data-testid="runners-move-none"]')).toHaveText("No other machine is online with room for it. Add a machine first.");
    await expect(yes(page)).toHaveAttribute("aria-disabled", "true");
    await yes(page).dispatchEvent("click");
    expect(mock.hz.acts).toEqual([]);
    await clean(page, errors);
  });
});

test.describe("D#845 MC-10b2: text only, members, and the whole tab under axe", () => {
  test("names and project names are rendered as text, never as markup", async ({ page }) => {
    const { errors } = await setup(page, { machines: [mach(RUN, "x")], hz: { credential: CONNECTED, servers: [sv(1, { runner_id: RUN, name: "<img src=x onerror=alert(1)>", last_seen_at: ago(0), placed_projects: [{ repo_id: REPO_WEB, name: "<b>bold</b>" }] })] } });
    await openServers(page);
    await expect(page.locator(`${WIN} [data-testid="runners-server-name"] bdi`)).toHaveText("<img src=x onerror=alert(1)>");
    await expect(page.locator(`${WIN} [data-testid="runners-srv-projects"] bdi`)).toHaveText("<b>bold</b>");
    await expect(page.locator(`${WIN} .runners-row img, ${WIN} .runners-row b`)).toHaveCount(0);
    await press(t(page, "runners-srv-move"));
    await expect(dlgOf(page).locator("h2")).toHaveText("Move <b>bold</b> to another machine?");
    await expect(dlgOf(page).locator("b, img")).toHaveCount(0);
    await clean(page, errors);
  });

  test("a member sees no server action and sends no sign-in or move request", async ({ page }) => {
    const asked: string[] = [];
    page.on("request", (r) => /\/api\/runners\/[^/]+\/claude-|\/move$/.test(r.url()) && asked.push(r.url()));
    const { errors } = await setup(page, { role: "member", isAdmin: false, hz: { credential: CONNECTED, servers: [sv(1, { status: "needs_claude_login", runner_id: RUN })] } });
    await openServers(page);
    await expect(t(page, "runners-servers-forbidden")).toHaveText("Only owners and admins can see servers.");
    await expect(page.locator(`${WIN} [data-testid^="runners-srv-"][data-testid$="reboot"], ${WIN} [data-testid="runners-signin"]`)).toHaveCount(0);
    expect(asked).toEqual([]);
    await clean(page, errors);
  });

  test("every state at once passes axe under two themes, with the sheets open, fits the window, and shows no id or null", async ({ page }) => {
    const { errors } = await setup(page, {
      machines: [mach(RUN, "fx-s1", { live: false }), mach(RUN2, "Laptop")],
      hz: {
        credential: CONNECTED,
        servers: [
          sv(1, { runner_id: RUN, last_seen_at: ago(9), placed_projects: [{ repo_id: REPO_WEB, name: "acme/web" }] }), sv(2, { status: "needs_claude_login", runner_id: RUN3 }), sv(3, { status: "creating", status_at: ago(2) }), sv(4, { status: "booting", status_at: ago(12) }),
          sv(5, { status: "failed", failure_code: "delete_failed" }), sv(6, { status: "orphaned", price: null }), sv(7, { status: "orphaned", price: null, kept: true }), sv(8, { status: "deleting" }), sv(9, { status: "needs_claude_login" }),
        ],
      },
    });
    await openServers(page);
    for (const theme of ["classic-crt", "nord"]) {
      await applyTheme(page, theme);
      expect(await axeSeriousOrCritical(page, WIN), theme).toEqual([]);
      for (const [from, sheetName] of [[row(page, 0).locator('[data-testid="runners-srv-delete"]'), "delete"], [row(page, 0).locator('[data-testid="runners-srv-move"]'), "move"], [row(page, 0).locator('[data-testid="runners-srv-reboot"]'), "reboot"]] as const) {
        await press(from);
        expect(await axeSeriousOrCritical(page, "dialog[open]"), `${sheetName} ${theme}`).toEqual([]);
        expect(await dlgOf(page).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        await page.keyboard.press("Escape");
        await expect(dlgOf(page)).toHaveCount(0);
        await expect(from).toBeFocused();
      }
    }
    expect(await page.locator(`${WIN} .runners-app`).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await clean(page, errors);
  });
});
