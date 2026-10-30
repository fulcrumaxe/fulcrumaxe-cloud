/**
 * A stand-in for the product's account surface that the account janitor touches, strict about what the real routes
 * enforce (packages/api/src/routes/{repos,run-limits,billing,roles}.ts, apps/web/lib/shell/csrf.ts):
 *
 *  - reads and writes need the session cookie; a cookie write needs a same-origin `Origin` (or `Sec-Fetch-Site:
 *    same-origin`) and a JSON content type, else 403 `csrf_rejected`; a cookie together with an Authorization header is
 *    400 `ambiguous_credentials`;
 *  - `PUT /api/v1/run-limits/{role}`: `default` or a manifest role (else 404); strict body; whole numbers within the
 *    product's floor and ceiling (else 422); per_run_usd at most 2 decimals; `null` clears a key;
 *  - `PATCH /api/v1/budgets`: only `model_usd_month`, 1.00 to 100000.00 (a `compute_*` key is 422 `not_settable`);
 *  - `PATCH /api/v1/repos/{id}/roles/{role}`: a UUID id of a known repo and a manifest role (else 404), exactly one of
 *    `mode` or `model`, a model of the three ids, and never below a role's floor (422);
 *  - errors are `{ error: { code, message, request_id } }`; reads page repos with `limit` and `cursor`.
 *
 * What it cannot fake: the database transactions, audit rows and the rate classes behind these routes, role checks
 * (the session is always an admin), and the real shape of the 26-role list (a handful of real role names are used).
 */
import { ghError, type GhReply, type GhRequest } from "../../../packages/github/test/helpers/strictGithub.js";
import { signSession, FakeApp, BYPASS_VALUE } from "./session-helpers.js";

export const ORG = "test-org";
export const FIXTURE = `${ORG}/fixture`;
export const FIXTURE_ID = "11111111-1111-4111-8111-111111111111";
export const OTHER_ORG_REPO_ID = "22222222-2222-4222-8222-222222222222";
export const SECOND_ORG_REPO_ID = "33333333-3333-4333-8333-333333333333";
export const MANIFEST_ROLES = ["executor", "code-reviewer", "project-manager", "security-reviewer", "security-expert"] as const;
const FLOORS: Record<string, string> = { "security-reviewer": "sonnet-5", "security-expert": "sonnet-5" };
const MODELS = ["haiku-4.5", "sonnet-5", "opus-5"];

export const LIMIT_KEYS = ["max_run_minutes", "max_model_calls", "per_run_usd", "max_turns", "silence_minutes", "max_extensions", "max_resumes"] as const;
type LimitKey = (typeof LIMIT_KEYS)[number];
/** The product's bounds (RUN_LIMIT_BOUNDS): default, floor, ceiling. per_run_usd's default comes from the product's plan data; the figure here is a stand-in well above the baseline. */
export const BOUNDS: Record<LimitKey, { default: number; floor: number; ceiling: number }> = {
  max_run_minutes: { default: 60, floor: 5, ceiling: 240 },
  max_model_calls: { default: 300, floor: 20, ceiling: 1500 },
  per_run_usd: { default: 40, floor: 1, ceiling: 200 },
  max_turns: { default: 100, floor: 10, ceiling: 500 },
  silence_minutes: { default: 15, floor: 11, ceiling: 30 },
  max_extensions: { default: 2, floor: 0, ceiling: 4 },
  max_resumes: { default: 2, floor: 0, ceiling: 5 },
};

export interface RepoRow {
  id: string;
  product: string;
  gh_repo_id: number;
  install_state: "installed" | "not_installed";
  app_kind: "team" | "team_readonly" | "sitekit" | null;
  full_name: string | null;
}
type Stored = Partial<Record<LimitKey | "auto_resume", number | boolean | null>>;

export interface State {
  repos: RepoRow[];
  /** `default` plus any role that has its own row. */
  limitRows: Map<string, Stored>;
  monthly: number;
  /** Per repo id, per role: the stored model override (null follows the routing table). */
  models: Map<string, Map<string, string | null>>;
  bounds: typeof BOUNDS;
}

export const repo = (id: string, full_name: string | null, n = 1): RepoRow => ({ id, product: "p", gh_repo_id: n, install_state: "installed", app_kind: "team", full_name });

/** A fresh account as the product leaves it: no limits stored, no budget set, no model override anywhere. */
export function freshState(): State {
  return {
    repos: [repo(FIXTURE_ID, FIXTURE, 1)],
    limitRows: new Map([["default", {}]]),
    monthly: 0,
    models: new Map([[FIXTURE_ID, new Map(MANIFEST_ROLES.map((r) => [r, null] as [string, string | null]))]]),
    bounds: BOUNDS,
  };
}

/** The account the janitor is for: the product defaults everywhere and a high monthly budget, so every part of the baseline has work to do. */
export function spendyState(): State {
  const s = freshState();
  s.monthly = 100;
  s.models.set(FIXTURE_ID, new Map<string, string | null>([["executor", "opus-5"], ["code-reviewer", "sonnet-5"], ["project-manager", null], ["security-reviewer", "opus-5"], ["security-expert", "sonnet-5"]]));
  return s;
}

const json = (status: number, body: unknown, extra: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });
const err = (status: number, code: string, message: string): { status: number; body: unknown } => ({ status, body: { error: { code, message, request_id: "req-1" } } });
const whole = (v: number): boolean => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;

export class FakeProduct extends FakeApp {
  /** Every request that changed or tried to change something (any method but GET), with its parsed body. */
  writes: { method: string; path: string; body: unknown }[] = [];
  /** Answer a write with this status and error code instead of applying it. */
  failWrites: { status: number; code: string; message?: string } | undefined;
  /** Accept writes (200) without applying them. */
  ignoreWrites = false;
  /** Rows per repos page; a small number makes the client page. */
  pageSize = 100;
  /** Make the repos list never end (a cursor on every page). */
  endlessRepos = false;
  /** Send the repos list's cursor in a shape the real route never uses (contract break). */
  cursorShape: "missing" | "renamed" | "number" | "empty" | undefined;
  /** Fail reads of this path with 500. */
  failRead: string | undefined;

  constructor(
    origin: string,
    now: () => number,
    readonly state: State = spendyState(),
  ) {
    super(origin, now, true);
    this.open["/api/health"] = () => ({ ok: true, deploy_env: "staging", project_id: "prj_Staging1", commit: "abcdef1" });
    const read = this.fetch;
    this.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET") {
        if (this.failRead !== undefined && url.pathname === this.failRead && this.verifyRequest(init) !== null) return new Response("boom", { status: 500 });
        this.routeReads();
        return read(input, init);
      }
      return this.write(url, method, init);
    };
  }

  /** Registers the read routes from the current state (repos' role lists are per repo id). */
  private routeReads(): void {
    this.api["/api/v1/repos"] = (url) => this.reposPage(url);
    this.api["/api/v1/run-limits"] = () => this.limitsBody();
    this.api["/api/v1/budgets"] = () => this.budgetsBody();
    for (const id of this.state.models.keys()) this.api[`/api/v1/repos/${id}/roles`] = () => ({ data: this.rolesBody(id) });
  }

  private verifyRequest(init: RequestInit | undefined): { sid: string; sessionStart: number; lastSeenAt: number } | null {
    const headers = this.lower(init);
    const cookie = /(?:^|;\s*)__Host-fx_session=([^;]+)/.exec(headers["cookie"] ?? "")?.[1];
    return cookie === undefined ? null : this.verify(cookie);
  }

  private lower(init: RequestInit | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) out[k.toLowerCase()] = v;
    return out;
  }

  private reposPage(url: URL): unknown {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? this.pageSize), this.pageSize);
    const start = Number(url.searchParams.get("cursor") ?? 0);
    const rows = this.state.repos.slice(start, start + limit);
    const more = this.endlessRepos || start + limit < this.state.repos.length;
    const cursor = more ? String(start + limit) : null;
    if (this.cursorShape === "missing") return { data: rows };
    if (this.cursorShape === "renamed") return { data: rows, nextCursor: cursor };
    if (this.cursorShape === "number") return { data: rows, next_cursor: more ? start + limit : null };
    // Like the real route, an empty `cursor=` is read as no cursor (restart at page 1). Page 1 answers "" and the `cursor=` request answers null.
    if (this.cursorShape === "empty") return { data: rows, next_cursor: url.searchParams.has("cursor") ? null : more ? "" : null };
    return { data: rows, next_cursor: cursor };
  }

  private resolved(role: string): Record<string, number | boolean> {
    const own = this.state.limitRows.get(role) ?? {};
    const acct = this.state.limitRows.get("default") ?? {};
    const out: Record<string, number | boolean> = {};
    for (const k of LIMIT_KEYS) out[k] = ((role === "default" ? undefined : own[k]) ?? acct[k] ?? this.state.bounds[k].default) as number;
    out["auto_resume"] = ((role === "default" ? undefined : own["auto_resume"]) ?? acct["auto_resume"] ?? true) as boolean;
    return out;
  }

  private entry(role: string): unknown {
    const own = this.state.limitRows.get(role) ?? {};
    const stored: Record<string, number | boolean | null> = {};
    for (const k of [...LIMIT_KEYS, "auto_resume"]) stored[k] = own[k as LimitKey] ?? null;
    return { role, stored, resolved: this.resolved(role) };
  }

  private limitsBody(): unknown {
    const bounds: Record<string, unknown> = {};
    for (const k of LIMIT_KEYS) bounds[k] = this.state.bounds[k];
    bounds["auto_resume"] = { default: true };
    return { default: this.entry("default"), roles: [...this.state.limitRows.keys()].filter((r) => r !== "default").map((r) => this.entry(r)), bounds };
  }

  private budgetsBody(): unknown {
    return { model_usd_month: this.state.monthly, foreground_compute_usd_month: 0, background_compute_usd_month: 0, compute_cap_usd_month: 0, plan: "p" };
  }

  private roleItem(id: string, role: string): unknown {
    const floor = FLOORS[role] ?? null;
    const allowed = MODELS.filter((m) => floor === null || MODELS.indexOf(m) >= MODELS.indexOf(floor));
    return {
      role,
      mode: "auto",
      allowed_modes: ["auto"],
      model: this.state.models.get(id)?.get(role) ?? null,
      model_floor: floor,
      allowed_models: allowed,
      expected_spend: { text: "x", monthly_usd: 0, runs_per_month: 0, median_cost_per_run_usd: 0, median_source: "seed", caveat: "" },
    };
  }

  private rolesBody(id: string): unknown[] {
    return MANIFEST_ROLES.map((r) => this.roleItem(id, r));
  }

  private async write(url: URL, method: string, init: RequestInit | undefined): Promise<Response> {
    const headers = this.lower(init);
    let body: unknown;
    try {
      body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    } catch {
      body = "<not json>";
    }
    this.writes.push({ method, path: url.pathname + url.search, body });
    this.seen.push({ method, url: url.href, headers });
    if (url.origin !== this.origin) return new Response("not this app", { status: 404 });
    if (headers["x-vercel-protection-bypass"] !== BYPASS_VALUE) return new Response("<html>Authentication Required</html>", { status: 401, headers: { "content-type": "text/html" } });
    const claims = this.verifyRequest(init);
    if (claims === null) return new Response(null, { status: 401 });
    if ("authorization" in headers) return json(400, err(400, "ambiguous_credentials", "both").body);
    if (!(headers["sec-fetch-site"] === "same-origin" || headers["origin"] === this.origin)) return json(403, err(403, "csrf_rejected", "missing or mismatched Origin/Sec-Fetch-Site").body);
    if (!(headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return json(403, err(403, "csrf_rejected", "mutations require Content-Type: application/json").body);
    const answered = this.failWrites !== undefined ? err(this.failWrites.status, this.failWrites.code, this.failWrites.message ?? "failed") : this.apply(url.pathname, method, body);
    const next = signSession({ sid: claims.sid, sessionStart: claims.sessionStart, lastSeenAt: this.now() });
    return json(answered.status, answered.body, { "set-cookie": `__Host-fx_session=${next}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=lax` });
  }

  private apply(path: string, method: string, body: unknown): { status: number; body: unknown } {
    const limits = /^\/api\/v1\/run-limits\/([^/]+)$/.exec(path);
    if (limits !== null && method === "PUT") return this.putLimits(decodeURIComponent(limits[1] as string), body);
    if (path === "/api/v1/budgets" && method === "PATCH") return this.patchBudgets(body);
    const role = /^\/api\/v1\/repos\/([^/]+)\/roles\/([^/]+)$/.exec(path);
    if (role !== null && method === "PATCH") return this.patchRole(decodeURIComponent(role[1] as string), decodeURIComponent(role[2] as string), body);
    return err(404, "not_found", "no such route");
  }

  private putLimits(role: string, body: unknown): { status: number; body: unknown } {
    if (role !== "default" && !(MANIFEST_ROLES as readonly string[]).includes(role)) return err(404, "not_found", `role ${role} not found`);
    if (typeof body !== "object" || body === null || Array.isArray(body)) return err(422, "validation_failed", "body");
    const row = { ...(this.state.limitRows.get(role) ?? {}) };
    for (const [k, v] of Object.entries(body)) {
      if (![...LIMIT_KEYS, "auto_resume"].includes(k)) return err(422, "validation_failed", `unrecognized key ${k}`);
      if (v === null) {
        delete row[k as LimitKey];
        continue;
      }
      if (k === "auto_resume") {
        if (typeof v !== "boolean") return err(422, "validation_failed", k);
        row[k] = v;
        continue;
      }
      const b = this.state.bounds[k as LimitKey];
      if (typeof v !== "number" || v < b.floor || v > b.ceiling) return err(422, "validation_failed", `${k} outside ${b.floor}..${b.ceiling}`);
      if (k === "per_run_usd" ? !whole(v) : !Number.isInteger(v)) return err(422, "validation_failed", `${k} has too many decimals`);
      row[k as LimitKey] = v;
    }
    if (!this.ignoreWrites) this.state.limitRows.set(role, row);
    return { status: 200, body: this.entry(role) };
  }

  private patchBudgets(body: unknown): { status: number; body: unknown } {
    if (typeof body !== "object" || body === null || Array.isArray(body)) return err(422, "validation_failed", "body");
    for (const k of Object.keys(body)) if (k !== "model_usd_month") return err(422, k.startsWith("compute_") ? "not_settable" : "unrecognized_keys", k);
    const v = (body as { model_usd_month?: unknown }).model_usd_month;
    if (typeof v !== "number" || v < 1 || v > 100000 || !whole(v)) return err(422, "validation_failed", "model_usd_month");
    if (!this.ignoreWrites) this.state.monthly = v;
    return { status: 200, body: this.budgetsBody() };
  }

  private patchRole(id: string, role: string, body: unknown): { status: number; body: unknown } {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || !this.state.models.has(id)) return err(404, "not_found", `repos ${id} not found`);
    if (!(MANIFEST_ROLES as readonly string[]).includes(role)) return err(404, "not_found", `role ${role} not found`);
    if (typeof body !== "object" || body === null || Array.isArray(body)) return err(422, "validation_failed", "body");
    const keys = Object.keys(body);
    if (keys.length !== 1 || !(keys[0] === "mode" || keys[0] === "model")) return err(422, "validation_failed", "send exactly one of mode or model");
    if (keys[0] === "mode") return err(422, "validation_failed", "mode not modelled");
    const model = (body as { model: unknown }).model;
    if (model !== null && (typeof model !== "string" || !MODELS.includes(model))) return err(422, "validation_failed", "model");
    const floor = FLOORS[role];
    if (typeof model === "string" && floor !== undefined && MODELS.indexOf(model) < MODELS.indexOf(floor)) return err(422, "validation_failed", `${role} is held at ${floor}`);
    if (!this.ignoreWrites) this.state.models.get(id)?.set(role, model as string | null);
    return { status: 200, body: this.roleItem(id, role) };
  }
}

/** A deep copy of the parts of the state a write could change, to prove a refusal left the account as it was. */
export function snapshot(s: State): string {
  return JSON.stringify({ repos: s.repos, limits: [...s.limitRows], monthly: s.monthly, models: [...s.models].map(([id, m]) => [id, [...m]]) });
}

export const nonGets = (app: FakeApp): { method: string; url: string }[] => app.seen.filter((r) => r.method !== "GET");

// A strict GitHub stand-in for the fixture-repo janitor (T6b), served over real TLS by startStrictGithubServer (which
// already refuses a request with no User-Agent). Also strict about: Bearer token (else 401), only the one repo (else 404),
// lists cut at 100 a page and open items only, no deleting the default branch (422), a force move onto a protected branch
// is the real 422. Cannot fake: rate limits and the full object shapes (only the fields the janitor reads).
export const GH_TOKEN = ["fixture", "repo", "token", "not", "real", "0001"].join("-"); // gitleaks:allow
export const GH_REPO = "test-org/fixture";
export const BASE_SHA = "b".repeat(40);
export const OLD_SHA = "a".repeat(40);
export const RUN_TAG = "e2e-20261016t184837z-a1b2c3-smoke";
const TAG_OBJ = "d".repeat(40);
const ok = (body: unknown, status = 200): GhReply => ({ status, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });

export class FakeRepo {
  defaultBranch = "main";
  branches = new Map<string, string>([["main", OLD_SHA]]);
  /** The commit `e2e-baseline` names; null means the tag does not exist. */
  baseline: string | null = BASE_SHA;
  /** Name the tag through an annotated tag object instead of directly. */
  annotated = false;
  protectedDefault = false;
  items: { number: number; title: string; pr?: { ref: string; repo: string }; state: "open" | "closed" }[] = [];
  /** Every request that was not a GET. */
  writes: { method: string; path: string; body: string }[] = [];

  issue(number: number, title: string): void {
    this.items.push({ number, title, state: "open" });
  }
  pull(number: number, title: string, ref: string, repo = GH_REPO): void {
    this.items.push({ number, title, state: "open", pr: { ref, repo } });
  }

  route = (req: GhRequest): GhReply => {
    if (req.headers["authorization"] !== `Bearer ${GH_TOKEN}`) return ghError(401, "Bad credentials");
    if (req.method !== "GET") this.writes.push({ method: req.method, path: req.path, body: req.body });
    const m = new RegExp(`^/repos/${GH_REPO}(/.*)?$`).exec(req.path);
    if (m === null) return ghError(404, "Not Found");
    const sub = m[1] ?? "";
    const q = new URLSearchParams(req.query ?? "");
    const [per, pg] = [Math.min(100, Number(q.get("per_page") ?? 30)), Number(q.get("page") ?? 1)];
    const page = (rows: unknown[]): GhReply => ok(rows.slice((pg - 1) * per, pg * per));
    const body = req.body === "" ? {} : (JSON.parse(req.body) as Record<string, unknown>);
    const open = this.items.filter((i) => i.state === "open");
    if (sub === "" && req.method === "GET") return ok({ full_name: GH_REPO, default_branch: this.defaultBranch });
    if (sub === "/git/ref/tags/e2e-baseline") return this.baseline === null ? ghError(404, "Not Found") : ok({ object: this.annotated ? { type: "tag", sha: TAG_OBJ } : { type: "commit", sha: this.baseline } });
    if (sub === `/git/tags/${TAG_OBJ}` && this.annotated) return ok({ object: { type: "commit", sha: this.baseline } });
    if (sub === "/issues" && req.method === "GET") return page(open.map((i) => ({ number: i.number, title: i.title, ...(i.pr ? { pull_request: {} } : {}) })));
    if (sub === "/pulls" && req.method === "GET") return page(open.filter((i) => i.pr).map((i) => ({ number: i.number, title: i.title, head: { ref: i.pr?.ref, repo: { full_name: i.pr?.repo } } })));
    if (sub === "/branches" && req.method === "GET") return page([...this.branches].map(([name, sha]) => ({ name, commit: { sha } })));
    const item = /^\/(issues|pulls)\/(\d+)$/.exec(sub);
    if (item !== null && req.method === "PATCH") {
      const found = open.find((i) => i.number === Number(item[2]) && (item[1] === "issues" || i.pr));
      if (found === undefined) return ghError(404, "Not Found");
      if (body["state"] !== "closed") return ghError(422, "Validation Failed");
      found.state = "closed";
      return ok({ number: found.number });
    }
    const ref = /^\/git\/refs\/heads\/(.+)$/.exec(sub);
    if (ref !== null) {
      const branch = decodeURIComponent(ref[1] as string);
      if (!this.branches.has(branch)) return ghError(422, "Reference does not exist");
      if (req.method === "DELETE") {
        if (branch === this.defaultBranch) return ghError(422, "Cannot delete the default branch");
        this.branches.delete(branch);
        return { status: 204, headers: {}, body: "" };
      }
      if (req.method === "PATCH") {
        if (body["force"] !== true || typeof body["sha"] !== "string") return ghError(422, "Update is not a fast forward");
        if (this.protectedDefault && branch === this.defaultBranch) return ghError(422, "Cannot force-push to a protected branch");
        this.branches.set(branch, body["sha"]);
        return ok({ ref: `refs/heads/${branch}` });
      }
    }
    return ghError(405, "Method Not Allowed");
  };
}
