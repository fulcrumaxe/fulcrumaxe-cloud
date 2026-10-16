/**
 * The account janitor (T6a; 4c, 4d). It puts the owner account's staging settings back to the declared spend
 * baseline through the product's own API and the stored `owner` session, and it runs only when a destructive pack is
 * about to run (`run`) or when the owner asks for it (`live-e2e janitor account`).
 *
 * What it writes (4d, CA2), and nothing else:
 *  - run limits (account default, and each role row that holds a value above the baseline):
 *    per_run_usd 3, max_model_calls 60, max_run_minutes 20, max_extensions 0, max_resumes 0, each clamped up to the
 *    product's own floor;
 *  - the monthly model budget, 30;
 *  - the model of every role of the fixture repo: `haiku-4.5`, and `sonnet-5` for the two floored security roles.
 *
 * It only ever LOWERS spend. A value already at or below the baseline is left alone (a stricter owner setting is not
 * raised), a monthly budget of 0 ("not set") is left alone, and the guard below refuses any write that would raise a
 * value, however the plan came to contain it.
 *
 * Fail closed:
 *  - Nothing is written unless EVERY read succeeded and every repo the account has connected belongs to the test org
 *    (the owner of `LIVE_E2E_FIXTURE_REPO`). One repo outside it (the owner's own work, the D#483 import), or one whose
 *    owner the app does not name, is `REFUSED janitor-account-in-use`: no write is attempted at all (the account's repo
 *    list is read first, and the check is repeated by the guard on every write).
 *  - Every write goes through `guardWrite`, which checks it against what was read (method and path shapes, the fixture
 *    repo id, the role names the app listed, the exact keys and values, lowering only). A write that fails the guard is
 *    never sent.
 *  - Staging only. The target is checked here, and `run` / the command have already passed layer 2.
 *
 * Dry-run is the default (`apply: false`): only GETs are sent and the changes are printed as "would set". No account
 * data is deleted by this tool, and no GitHub or Stripe call is made.
 */
import type { ApiClient } from "../client.js";
import { BASELINE_LIMITS, BASELINE_MONTHLY_USD, LIMIT_KEYS, type LimitKey } from "./baseline.js";
import { CHEAPEST_MODEL, FIXTURE_REPO_PATTERN, FLOOR_MODEL, FLOORED_ROLES, MAX_PAGES, READ_ROLE } from "../needs-network.js";
import { ME_PATH, sessionClient, sessionStatus, type SessionClient } from "../sessions.js";
import { isRole, parseKey, putRole, readStore, storePath } from "../store.js";
import type { EnvSource, Target } from "../targets.js";
import type { MaskRegistry } from "../mask.js";

export const REASONS = [
  "janitor-account-in-use",
  "janitor-not-staging",
  "janitor-no-test-org",
  "janitor-no-fixture",
  "janitor-no-session",
  "janitor-unreadable",
  "janitor-baseline-unreachable",
  "janitor-out-of-allowlist",
  "janitor-write-failed",
  "janitor-verify-failed",
] as const;
export type JanitorReason = (typeof REASONS)[number];

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Model tiers, weakest (cheapest) first. A model outside this list is unknown and ranks as the most expensive. */
const MODEL_ORDER = ["haiku-4.5", "sonnet-5", "opus-5"] as const;
const rank = (model: string): number => {
  const i = (MODEL_ORDER as readonly string[]).indexOf(model);
  return i < 0 ? MODEL_ORDER.length : i;
};
/** The model the baseline pins a role to. */
export const expectedModel = (role: string): string => (FLOORED_ROLES.includes(role) ? FLOOR_MODEL : CHEAPEST_MODEL);

/** A role name or `default` as it may appear in a path: lower-case words and digits joined by dashes, never a slash, dot or escape. */
const ROLE_PARAM = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ROLE_PARAM = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** App-supplied strings echoed into a line: short and plain, else a fixed placeholder. */
const SHOWN = /^[A-Za-z0-9._-]{1,64}$/;
const shown = (v: string): string => (SHOWN.test(v) ? v : "<invalid>");

export type Write =
  | { kind: "run-limits"; role: string; body: Partial<Record<LimitKey, number>> }
  | { kind: "budgets"; body: { model_usd_month: number } }
  | { kind: "role-model"; repoId: string; role: string; body: { model: string } };

export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardError";
  }
}

/** One role row of the run limits as read: what it stores (null inherits), what a run would get, and the product's bounds. */
export interface LimitEntry {
  stored: Record<LimitKey, number | null>;
  resolved: Record<LimitKey, number>;
}
export interface Observed {
  limits: Map<string, LimitEntry>;
  floors: Record<LimitKey, number>;
  monthly: number;
  models: Map<string, { model: string | null; allowed: string[] }>;
}

/** Everything a write is checked against. Built once from the reads. */
export interface Scope {
  target: string;
  testOrg: string;
  fixtureName: string;
  fixtureId: string;
  /** Repos of the account whose owner is not the test org; the janitor does not run unless this is 0. */
  outside: number;
  observed: Observed;
}

const sameOrg = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
export const ownerOf = (fullName: string): string => fullName.split("/")[0] ?? "";
/** A row is inside only when its full_name is owner/name and the owner is the test org. */
const isInside = (fullName: unknown, testOrg: string): boolean =>
  typeof fullName === "string" && FIXTURE_REPO_PATTERN.test(fullName) && sameOrg(ownerOf(fullName), testOrg);

/** The value the baseline asks for, clamped up to the product's floor. */
const targetOf = (key: LimitKey, floors: Record<LimitKey, number>): number => Math.max(BASELINE_LIMITS[key], floors[key]);

/** The value a write would lower: the stored one, or what the account row resolves to when it stores none. */
function currentLimit(entry: LimitEntry, key: LimitKey): number {
  return entry.stored[key] ?? entry.resolved[key];
}

/**
 * The allowlist. Throws GuardError unless `w` is exactly one of the three writes this tool makes, on the fixture repo
 * and the roles the app listed, with keys and values from the baseline, and strictly lowering what was read.
 */
export function guardWrite(w: Write, s: Scope): void {
  const bad = (why: string): never => {
    throw new GuardError(why);
  };
  if (s.target !== "staging") bad("target is not staging");
  if (s.outside !== 0) bad("the account has a repo outside the test org");
  if (s.testOrg === "" || !sameOrg(ownerOf(s.fixtureName), s.testOrg)) bad("the fixture repo is not in the test org");
  if (w.kind === "run-limits") {
    if (w.role.length > MAX_ROLE_PARAM || !ROLE_PARAM.test(w.role)) bad("run-limits role is not a plain name");
    const entry = s.observed.limits.get(w.role);
    if (entry === undefined) bad("run-limits role is not a row the app listed");
    const keys = Object.keys(w.body);
    if (keys.length === 0) bad("run-limits write is empty");
    for (const k of keys) {
      if (!(LIMIT_KEYS as string[]).includes(k)) bad(`run-limits key ${shown(k)} is not in the baseline`);
      const key = k as LimitKey;
      const value = w.body[key];
      if (value !== targetOf(key, s.observed.floors)) bad(`run-limits ${key} is not the baseline value`);
      const current = entry === undefined ? Infinity : currentLimit(entry, key);
      if (!(value !== undefined && value < current)) bad(`run-limits ${key} would not lower spend`);
      // A role row that stores nothing inherits the account row; writing it would pin a value the owner never set.
      if (w.role !== "default" && entry?.stored[key] === null) bad(`run-limits ${key} on a role row that inherits`);
    }
    return;
  }
  if (w.kind === "budgets") {
    const keys = Object.keys(w.body);
    if (keys.length !== 1 || keys[0] !== "model_usd_month") bad("budgets write is not model_usd_month alone");
    if (w.body.model_usd_month !== BASELINE_MONTHLY_USD) bad("budgets value is not the baseline");
    // 0 means "not set": it is left alone, and a value at or below the baseline is never raised.
    if (!(s.observed.monthly > BASELINE_MONTHLY_USD)) bad("budgets write would not lower spend");
    return;
  }
  if (!UUID.test(w.repoId) || w.repoId.toLowerCase() !== s.fixtureId.toLowerCase()) bad("role write is not on the fixture repo");
  if (w.role.length > MAX_ROLE_PARAM || !ROLE_PARAM.test(w.role)) bad("role is not a plain name");
  const entry = s.observed.models.get(w.role);
  if (entry === undefined) bad("role is not one the app listed for the fixture repo");
  const keys = Object.keys(w.body);
  if (keys.length !== 1 || keys[0] !== "model") bad("role write is not model alone");
  if (w.body.model !== expectedModel(w.role)) bad("role model is not the baseline for that role");
  if (entry !== undefined && entry.model === w.body.model) bad("role model is already the baseline");
  if (entry?.model != null && rank(entry.model) < rank(w.body.model)) bad("role write would raise the model tier");
}

/** The method, path and body of a write. The path is built from validated parts only (guardWrite has run). */
export function wireOf(w: Write): { method: "PUT" | "PATCH"; path: string; body: string } {
  if (w.kind === "run-limits") return { method: "PUT", path: `/api/v1/run-limits/${w.role}`, body: JSON.stringify(w.body) };
  if (w.kind === "budgets") return { method: "PATCH", path: "/api/v1/budgets", body: JSON.stringify(w.body) };
  return { method: "PATCH", path: `/api/v1/repos/${w.repoId}/roles/${w.role}`, body: JSON.stringify(w.body) };
}

/** The shapes of the paths this tool may ever send to: a second, independent list that the sender checks. */
const ALLOWED_PATHS: { method: string; pattern: RegExp }[] = [
  { method: "PUT", pattern: /^\/api\/v1\/run-limits\/[a-z0-9]+(?:-[a-z0-9]+)*$/ },
  { method: "PATCH", pattern: /^\/api\/v1\/budgets$/ },
  { method: "PATCH", pattern: /^\/api\/v1\/repos\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/roles\/[a-z0-9]+(?:-[a-z0-9]+)*$/ },
];

/** Whether a method and path are one of the three shapes this tool may send. Independent of `guardWrite`, which checks values and scope. */
export const pathAllowed = (method: string, path: string): boolean => ALLOWED_PATHS.some((a) => a.method === method && a.pattern.test(path));

class Unreadable extends Error {}

export interface JanitorDeps {
  target: Target;
  client: ApiClient;
  /** `LIVE_E2E_FIXTURE_REPO`: its owner is the test org. */
  fixtureRepo: string | undefined;
  /** False (the default) reads and reports; true writes. */
  apply?: boolean;
  say?: (line: string) => void;
}

export type JanitorResult =
  | { ok: true; applied: boolean; changes: string[] }
  | { ok: false; reason: JanitorReason; detail?: string; written: number };

async function getJson(client: ApiClient, path: string): Promise<Json> {
  const res = await client.get(path, { redirect: "manual" });
  if (res.status !== 200) throw new Unreadable();
  const body: unknown = JSON.parse(res.body);
  if (!isObj(body)) throw new Unreadable();
  return body;
}

async function readRepos(client: ApiClient): Promise<Json[]> {
  const rows: Json[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await getJson(client, `/api/v1/repos?limit=100${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`);
    if (!Array.isArray(body["data"])) throw new Unreadable();
    for (const r of body["data"] as unknown[]) {
      if (!isObj(r)) throw new Unreadable();
      rows.push(r);
    }
    // The route always sends next_cursor as a string or null. Any other shape is a contract break: it cannot be read as "last page".
    const next: unknown = body["next_cursor"];
    if (!("next_cursor" in body) || (next !== null && typeof next !== "string")) throw new Unreadable();
    // "" is never a next page: the route reads an empty cursor as "no cursor" and restarts at page 1, which would drop the later pages.
    if (next === "") throw new Unreadable();
    cursor = next;
    if (cursor === null) return rows;
  }
  // More pages than the cap: the list cannot be proven complete, so it is unreadable.
  throw new Unreadable();
}

function limitEntry(raw: unknown): LimitEntry {
  if (!isObj(raw) || !isObj(raw["stored"]) || !isObj(raw["resolved"])) throw new Unreadable();
  const stored = {} as Record<LimitKey, number | null>;
  const resolved = {} as Record<LimitKey, number>;
  for (const k of LIMIT_KEYS) {
    const s = raw["stored"][k];
    const r = raw["resolved"][k];
    if (!(s === null || isNum(s)) || !isNum(r)) throw new Unreadable();
    stored[k] = s;
    resolved[k] = r;
  }
  return { stored, resolved };
}

export async function readObserved(client: ApiClient, fixtureId: string): Promise<Observed> {
  const limitsBody = await getJson(client, "/api/v1/run-limits");
  const limits = new Map<string, LimitEntry>();
  limits.set("default", limitEntry(limitsBody["default"]));
  if (!Array.isArray(limitsBody["roles"])) throw new Unreadable();
  for (const e of limitsBody["roles"] as unknown[]) {
    const role = isObj(e) ? e["role"] : undefined;
    if (typeof role !== "string" || role === "default" || limits.has(role)) throw new Unreadable();
    limits.set(role, limitEntry(e));
  }
  const bounds = limitsBody["bounds"];
  if (!isObj(bounds)) throw new Unreadable();
  const floors = {} as Record<LimitKey, number>;
  for (const k of LIMIT_KEYS) {
    const b = bounds[k];
    if (!isObj(b) || !isNum(b["floor"])) throw new Unreadable();
    floors[k] = b["floor"];
  }
  const monthly = (await getJson(client, "/api/v1/budgets"))["model_usd_month"];
  if (!isNum(monthly)) throw new Unreadable();
  const rolesBody = await getJson(client, `/api/v1/repos/${encodeURIComponent(fixtureId)}/roles`);
  if (!Array.isArray(rolesBody["data"]) || rolesBody["data"].length === 0) throw new Unreadable();
  const models = new Map<string, { model: string | null; allowed: string[] }>();
  for (const r of rolesBody["data"] as unknown[]) {
    if (!isObj(r) || typeof r["role"] !== "string" || models.has(r["role"])) throw new Unreadable();
    const model = r["model"];
    const allowed = r["allowed_models"];
    if (!(model === null || typeof model === "string") || !Array.isArray(allowed) || !allowed.every((a) => typeof a === "string")) throw new Unreadable();
    models.set(r["role"], { model, allowed: allowed as string[] });
  }
  return { limits, floors, monthly, models };
}

interface Planned {
  write: Write;
  line: string;
}

/**
 * The writes that bring `o` to the baseline, lowering only, and the problems that stop the janitor (a role the baseline
 * cannot be applied to). Pure.
 */
export function planBaseline(o: Observed, fixtureId: string): { planned: Planned[]; problems: string[] } {
  const planned: Planned[] = [];
  const problems: string[] = [];
  for (const [role, entry] of o.limits) {
    const body: Partial<Record<LimitKey, number>> = {};
    const parts: string[] = [];
    for (const k of LIMIT_KEYS) {
      const target = targetOf(k, o.floors);
      // A role row that stores nothing inherits the account row, which is fixed on its own turn.
      if (role !== "default" && entry.stored[k] === null) continue;
      const current = currentLimit(entry, k);
      if (current > target) {
        body[k] = target;
        parts.push(`${k} ${current} -> ${target}`);
      }
    }
    if (parts.length > 0) planned.push({ write: { kind: "run-limits", role, body }, line: `run-limits/${role}: ${parts.join(", ")}` });
  }
  if (o.monthly > BASELINE_MONTHLY_USD) {
    planned.push({ write: { kind: "budgets", body: { model_usd_month: BASELINE_MONTHLY_USD } }, line: `budgets: model_usd_month ${o.monthly} -> ${BASELINE_MONTHLY_USD}` });
  }
  for (const [role, entry] of [...o.models].sort(([a], [b]) => a.localeCompare(b))) {
    const want = expectedModel(role);
    if (!entry.allowed.includes(want)) {
      problems.push(`role ${shown(role)} cannot be set to ${want}`);
      continue;
    }
    if (entry.model === want) continue;
    // Below the role's own baseline (a floored role the product shows under its floor): the janitor only lowers, so it stops.
    if (entry.model !== null && rank(entry.model) < rank(want)) {
      problems.push(`role ${shown(role)} is below its baseline model`);
      continue;
    }
    // A model above the baseline tier, or none stored (the routing table decides), is set to the baseline.
    planned.push({ write: { kind: "role-model", repoId: fixtureId, role, body: { model: want } }, line: `roles/${shown(role)}: model ${entry.model === null ? "(routing table)" : shown(entry.model)} -> ${want}` });
  }
  return { planned, problems };
}

/**
 * Sends the writes in order. Each one goes through the guard and the path allowlist first; the first refusal or
 * failure stops everything, and nothing after it is sent. This is the only place a non-GET request is made.
 */
export async function sendWrites(writes: readonly Write[], scope: Scope, client: ApiClient, origin: string): Promise<{ written: number } | { written: number; reason: JanitorReason; detail: string }> {
  let written = 0;
  for (const write of writes) {
    try {
      guardWrite(write, scope);
    } catch (err) {
      if (!(err instanceof GuardError)) throw err;
      return { written, reason: "janitor-out-of-allowlist", detail: err.message };
    }
    const wire = wireOf(write);
    if (!pathAllowed(wire.method, wire.path)) {
      return { written, reason: "janitor-out-of-allowlist", detail: "path is not on the allowlist" };
    }
    // The app's CSRF rule for a cookie session: a same-origin Origin and a JSON body.
    let res;
    try {
      res = await client.request(wire.path, { method: wire.method, headers: { origin, "content-type": "application/json" }, body: wire.body, redirect: "manual" });
    } catch {
      // The shared client refuses a redirect on a write and a fenced origin; its message names a path, which is not echoed.
      return { written, reason: "janitor-write-failed", detail: `${write.kind} request refused or unreachable` };
    }
    if (res.status !== 200) {
      let code = "";
      try {
        const e = (JSON.parse(res.body) as Json)["error"];
        if (isObj(e) && typeof e["code"] === "string") code = shown(e["code"]);
      } catch {
        code = "";
      }
      return { written, reason: "janitor-write-failed", detail: `${write.kind} answered ${res.status}${code === "" ? "" : ` ${code}`}` };
    }
    written += 1;
  }
  return { written };
}

/**
 * Runs the janitor. See the header for what it does and refuses. `deps.apply` is false unless the caller says
 * otherwise; with it false no request but a GET is sent.
 */
export async function runAccountJanitor(d: JanitorDeps): Promise<JanitorResult> {
  const say = d.say ?? (() => undefined);
  const apply = d.apply === true;
  const refuse = (reason: JanitorReason, detail?: string, written = 0): JanitorResult => ({ ok: false, reason, ...(detail !== undefined ? { detail } : {}), written });
  if (d.target.name !== "staging") return refuse("janitor-not-staging");
  const fixture = d.fixtureRepo;
  if (fixture === undefined || fixture === "") return refuse("janitor-no-test-org", "LIVE_E2E_FIXTURE_REPO is not set (its owner is the test org)");
  if (!FIXTURE_REPO_PATTERN.test(fixture)) return refuse("janitor-no-test-org", "LIVE_E2E_FIXTURE_REPO is not owner/name");
  const testOrg = ownerOf(fixture);
  say(`janitor account (${apply ? "apply" : "dry-run"}): target ${d.target.name}, test org ${testOrg}`);

  let repos: Json[];
  try {
    repos = await readRepos(d.client);
  } catch {
    return refuse("janitor-unreadable", "/api/v1/repos");
  }
  // The account-in-use check comes before any other read and any write. A repo whose owner the app does not name counts as outside.
  const outside = repos.filter((r) => !isInside(r["full_name"], testOrg)).length;
  if (outside > 0) return refuse("janitor-account-in-use", `${outside} connected repo(s) outside ${testOrg}`);
  say(`janitor account: ${repos.length} connected repo(s), all in ${testOrg}`);
  const row = repos.find((r) => typeof r["full_name"] === "string" && r["full_name"].toLowerCase() === fixture.toLowerCase());
  if (row === undefined || typeof row["id"] !== "string" || !UUID.test(row["id"])) return refuse("janitor-no-fixture", "the fixture repo is not connected to the account");
  const fixtureId = row["id"];

  const observe = async (): Promise<Observed | null> => {
    try {
      return await readObserved(d.client, fixtureId);
    } catch {
      return null;
    }
  };
  const observed = await observe();
  if (observed === null) return refuse("janitor-unreadable", "run-limits, budgets or the fixture repo's roles");
  const { planned, problems } = planBaseline(observed, fixtureId);
  if (problems.length > 0) return refuse("janitor-baseline-unreachable", problems[0]);
  const scope: Scope = { target: d.target.name, testOrg, fixtureName: fixture, fixtureId, outside: 0, observed };
  const changes = planned.map((p) => p.line);
  if (!apply) {
    for (const c of changes) say(`janitor account: would set ${c}`);
    say(changes.length === 0 ? "janitor account: baseline already met, nothing to change" : `janitor account: dry-run, ${changes.length} change(s) planned, nothing written`);
    return { ok: true, applied: false, changes };
  }
  const sent = await sendWrites(planned.map((p) => p.write), scope, d.client, d.target.origin);
  if ("reason" in sent) return refuse(sent.reason, sent.detail, sent.written);
  for (const c of changes) say(`janitor account: set ${c}`);
  // Read it back: the baseline must hold now, or the run is not trusted to spend.
  const after = await observe();
  if (after === null || planBaseline(after, fixtureId).planned.length > 0) return refuse("janitor-verify-failed", "the baseline did not hold after the writes", sent.written);
  say(changes.length === 0 ? "janitor account: baseline already met, nothing to change" : `janitor account: ${sent.written} change(s) applied and read back`);
  return { ok: true, applied: true, changes };
}

export interface OwnerSession {
  session: SessionClient;
  /** Writes the refreshed cookie back to the store. Call once, when the janitor is done. */
  commit(): Promise<void>;
}

/**
 * The stored `owner` session as a shared-client session, proven with `/me`. Null when the store, the key or the cookie
 * is missing or lapsed, or the app turns it away: the caller refuses, it does not guess.
 */
export async function openOwnerSession(d: { target: Target; targetsDir: string; env: EnvSource; now: number; fetchImpl?: typeof fetch; mask?: MaskRegistry }): Promise<OwnerSession | null> {
  try {
    if (!isRole(READ_ROLE)) return null;
    const key = parseKey(d.env["LIVE_E2E_SESSION_KEY"]);
    const home = d.env["HOME"];
    if (home === undefined) return null;
    const file = storePath(home, d.target.name);
    const cookie = readStore(file, d.target.name, key)[READ_ROLE];
    if (cookie === undefined || sessionStatus(cookie, d.now).state !== "ok") return null;
    d.mask?.register(cookie);
    const session = sessionClient(d.target, d.targetsDir, d.env, cookie, d.fetchImpl);
    if ((await session.client.get(ME_PATH, { redirect: "manual" })).status !== 200) return null;
    return {
      session,
      async commit() {
        const next = session.refreshed();
        if (next === undefined) return;
        d.mask?.register(next);
        await putRole(file, d.target.name, key, READ_ROLE, next);
      },
    };
  } catch {
    return null;
  }
}
