/**
 * The needs that are decided by asking the deployed app or GitHub (T3; 2b). `run` probes them once per run, for the
 * packs it is about to start, and hands the answers to the plan; `plan` is offline and never calls this.
 *
 * Every probe is a GET. The reads that need a login use the `owner` role's stored session through the shared client
 * (so the fence and the exact-origin bypass rule apply), and each answered request writes the refreshed cookie back.
 * A need that cannot be proven is unmet (the pack is skipped, named). Two things are never a skip:
 *  - `caps-set`: a limit, budget or role model above the ceiling, or caps that cannot be read although the app
 *    answered, is `REFUSED caps` (CA1). The product default `per_run_usd` is high, so an account the janitor never
 *    reached is refused, not trusted. When no read can be attempted (no owner session, or no fixture repo named) it is
 *    a skip and no request is made (R-441-T3-21); it is "met" only after all three reads succeeded.
 *  - a deployment that did not identify itself as staging: `run` passes that refusal in as `identityRefusal`.
 */
import { request as githubRequest, GithubError } from "./issues.js";
import type { MaskRegistry } from "./mask.js";
import { FRESH_STATES } from "./manifest.js";
import type { NeedResult } from "./needs.js";
import { ME_PATH, sessionClient, sessionStatus, type SessionClient } from "./sessions.js";
import { isRole, parseKey, putRole, readStore, storePath, type Roles } from "./store.js";
import type { EnvSource, Target } from "./targets.js";

export const FIXTURE_REPO_ENV = "LIVE_E2E_FIXTURE_REPO";
export const FIXTURE_TOKEN_ENV = "LIVE_E2E_FIXTURE_REPO_TOKEN";
/** The tag the repo janitor (T6b) resets the fixture repo to; `test-repo` needs it to exist. */
export const FIXTURE_BASELINE_TAG = "e2e-baseline";
/** The role whose session reads the account (the machine accounts keep the same baseline, so one is enough). */
export const READ_ROLE = "owner";
/** Q2(d): the account's monthly model budget, and the cheapest model tier every role is pinned to. */
export const MONTHLY_MODEL_CEILING_USD = 30;
export const CHEAPEST_MODEL = "haiku-4.5";
const APP_KINDS = ["team", "team_readonly", "sitekit"];
/** `owner/name`: a GitHub owner has no dots or underscores and at most 39 characters. */
export const FIXTURE_REPO_PATTERN = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
/** Run minutes above this are over the 60 sandbox-minute ceiling (4d, Q2 c). */
export const MAX_RUN_MINUTES = 60;
/** The two roles the product holds at their `sonnet-5` floor; every other role the pipeline uses is pinned to the cheapest tier. */
const FLOORED_ROLES = ["security-reviewer", "security-expert"];
const FLOOR_MODEL = "sonnet-5";
const MAX_PAGES = 10;

const NETWORK_BARE = ["model-key", "test-repo", "caps-set", "sandbox"];
const NETWORK_PREFIXES = ["session:", "github-app:", "fresh-state:"];
export const isNetworkNeed = (need: string): boolean => NETWORK_BARE.includes(need) || NETWORK_PREFIXES.some((p) => need.startsWith(p));

export interface NetworkDeps {
  target: Target;
  targetsDir: string;
  env: EnvSource;
  now: number;
  /**
   * The run budget in USD (`--budget-usd`, which arrives with the cost engine). Until it is given the effective budget
   * is the target file's default, which is zero: every account is refused, because the product's floor per run is above it.
   */
  budgetUsd?: number;
  fetchImpl?: typeof fetch;
  /** Extra trust root for a local TLS fake of the GitHub API. */
  githubCa?: string;
  mask?: MaskRegistry;
  /** Set when the origin did not identify as staging (layer 2): every need then refuses with this reason, probing nothing. */
  identityRefusal?: string;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const MET: NeedResult = { met: true };
const UNMET: NeedResult = { met: false };

class Unreadable extends Error {}

/** App-supplied strings echoed into a REFUSED detail line: short and plain, else a fixed placeholder. */
const SHOWN = /^[A-Za-z0-9._-]{1,64}$/;
const shown = (v: string): string => (SHOWN.test(v) ? v : "<invalid>");

export async function resolveNetworkNeeds(needs: readonly string[], d: NetworkDeps): Promise<Record<string, NeedResult>> {
  const out: Record<string, NeedResult> = {};
  const wanted = [...new Set(needs.filter(isNetworkNeed))];
  if (d.identityRefusal !== undefined) {
    for (const n of wanted) out[n] = { met: false, refuse: d.identityRefusal };
    return out;
  }
  const probe = new Probe(d);
  for (const need of wanted) {
    try {
      out[need] = await probe.need(need);
    } catch {
      out[need] = UNMET;
    }
  }
  return out;
}

class Probe {
  private roles: Roles | undefined;
  private sessions = new Map<string, SessionClient | null>();
  private cache = new Map<string, Promise<NeedResult>>();

  constructor(private d: NetworkDeps) {}

  need(need: string): Promise<NeedResult> {
    let r = this.cache.get(need);
    if (r === undefined) {
      r = this.decide(need);
      this.cache.set(need, r);
    }
    return r;
  }

  private async decide(need: string): Promise<NeedResult> {
    if (need.startsWith("session:")) return (await this.session(need.slice(8))) === null ? UNMET : MET;
    if (need.startsWith("github-app:")) return this.githubApp(need.slice(11));
    if (need.startsWith("fresh-state:")) return this.freshState(need.slice(12));
    switch (need) {
      case "model-key":
        return this.modelKey();
      case "test-repo":
        return this.testRepo();
      case "caps-set":
        return this.capsSet();
      case "sandbox": {
        const [key, caps] = [await this.need("model-key"), await this.need("caps-set")];
        return key.met && caps.met ? MET : !caps.met && caps.refuse !== undefined ? caps : UNMET;
      }
      default:
        return UNMET;
    }
  }

  /** A usable, answered session for the role, or null. The first call asks `/me` and writes the refreshed cookie back. */
  private async session(role: string): Promise<SessionClient | null> {
    if (this.sessions.has(role)) return this.sessions.get(role) ?? null;
    let found: SessionClient | null = null;
    try {
      if (isRole(role)) {
        const key = parseKey(this.d.env["LIVE_E2E_SESSION_KEY"]);
        const home = this.d.env["HOME"];
        if (home === undefined) throw new Unreadable();
        const file = storePath(home, this.d.target.name);
        this.roles ??= readStore(file, this.d.target.name, key);
        const cookie = this.roles[role];
        if (cookie !== undefined && sessionStatus(cookie, this.d.now).state === "ok") {
          this.d.mask?.register(cookie);
          const s = sessionClient(this.d.target, this.d.targetsDir, this.d.env, cookie, this.d.fetchImpl);
          if ((await s.client.get(ME_PATH, { redirect: "manual" })).status === 200) {
            const next = s.refreshed();
            if (next !== undefined) {
              this.d.mask?.register(next);
              await putRole(file, this.d.target.name, key, role, next);
            }
            found = s;
          }
        }
      }
    } catch {
      found = null;
    }
    this.sessions.set(role, found);
    return found;
  }

  private async json(path: string): Promise<Json> {
    const owner = await this.session(READ_ROLE);
    if (owner === null) throw new Unreadable();
    const res = await owner.client.get(path, { redirect: "manual" });
    if (res.status !== 200) throw new Unreadable();
    const body: unknown = JSON.parse(res.body);
    if (!isObj(body)) throw new Unreadable();
    return body;
  }

  private repoPromise: Promise<Json[]> | undefined;
  private repos(): Promise<Json[]> {
    this.repoPromise ??= (async () => {
      const rows: Json[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const body = await this.json(`/api/v1/repos?limit=100${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`);
        if (!Array.isArray(body["data"])) throw new Unreadable();
        rows.push(...(body["data"] as unknown[]).filter(isObj));
        cursor = typeof body["next_cursor"] === "string" ? body["next_cursor"] : null;
        if (cursor === null) return rows;
      }
      throw new Unreadable();
    })();
    return this.repoPromise;
  }

  private fixtureName(): string | null {
    const name = this.d.env[FIXTURE_REPO_ENV];
    return name !== undefined && FIXTURE_REPO_PATTERN.test(name) ? name : null;
  }

  private async fixtureRow(): Promise<Json | undefined> {
    const name = this.fixtureName();
    return (await this.repos()).find((r) => typeof r["full_name"] === "string" && r["full_name"].toLowerCase() === name?.toLowerCase());
  }

  private async githubApp(kind: string): Promise<NeedResult> {
    if (!APP_KINDS.includes(kind) || this.fixtureName() === null) return UNMET;
    const row = await this.fixtureRow();
    return row?.["install_state"] === "installed" && row["app_kind"] === kind ? MET : UNMET;
  }

  private async modelKey(): Promise<NeedResult> {
    return (await this.json("/api/v1/model-connection"))["status"] === "ok" ? MET : UNMET;
  }

  private async freshState(name: string): Promise<NeedResult> {
    if (!(FRESH_STATES as readonly string[]).includes(name)) return UNMET;
    if (name === "unpaid") return (await this.json("/api/v1/account"))["status"] === "unsubscribed" ? MET : UNMET;
    const steps = (await this.json("/api/v1/onboarding"))["steps"];
    if (!Array.isArray(steps)) throw new Unreadable();
    const untouched = (s: unknown): boolean => isObj(s) && s["completed_at"] === null && s["skipped"] === false;
    const preview = steps.filter((s) => isObj(s) && s["step"] === "preview");
    if (name === "preview-unused") return preview.length > 0 && preview.every(untouched) ? MET : UNMET;
    return steps.length > 0 && steps.every(untouched) ? MET : UNMET;
  }

  private async testRepo(): Promise<NeedResult> {
    const token = this.d.env[FIXTURE_TOKEN_ENV];
    const name = this.fixtureName();
    if (token === undefined || token === "" || name === null) return UNMET;
    this.d.mask?.register(token);
    const api = this.d.env["GITHUB_API_URL"];
    try {
      await githubRequest({ token, ...(api ? { apiBase: api } : {}), ...(this.d.githubCa !== undefined ? { ca: this.d.githubCa } : {}) }, "GET", `/repos/${name}/git/ref/tags/${FIXTURE_BASELINE_TAG}`);
      return MET;
    } catch (err) {
      if (err instanceof GithubError) return UNMET;
      throw err;
    }
  }

  /**
   * Reads the run limits, the monthly budget and the role models, and refuses (never skips) when any of these holds:
   * a per-run cap above the effective budget, run minutes above the ceiling, a monthly model budget above its ceiling,
   * a role not pinned to the cheapest tier (the two security roles to their floor), or any read that fails or lacks a
   * field. Fail closed: an account the janitor has not reached is refused, not trusted.
   */
  private async capsSet(): Promise<NeedResult> {
    const refuse = (detail: string): NeedResult => ({ met: false, refuse: "caps", detail });
    const failed = (endpoint: string): NeedResult => refuse(`read failed: ${endpoint}`);
    // No read can be attempted without the fixture repo, a met test-repo need and the owner session: a skip, and not one
    // request to the app is made (R-441-T3-21: the three reads happen only when session:owner and test-repo are both met).
    if (this.fixtureName() === null || !(await this.need("test-repo")).met || (await this.session(READ_ROLE)) === null) return UNMET;
    // The endpoints named in the summary are fixed text (the repo id is a placeholder, never the id the app answered with).
    // The path is built inside the guard, so an id that cannot be encoded is a failed read (a refusal), not a crash.
    const read = async (path: () => string): Promise<Json | null> => {
      try {
        return await this.json(path());
      } catch {
        return null;
      }
    };
    const budget = this.d.budgetUsd ?? this.d.target.budget_usd.default;
    const limits = await read(() => "/api/v1/run-limits");
    if (limits === null || !Array.isArray(limits["roles"])) return failed("/api/v1/run-limits");
    const resolved = [limits["default"], ...limits["roles"]].map((e) => (isObj(e) && isObj(e["resolved"]) ? e["resolved"] : undefined));
    for (const r of resolved) {
      if (r === undefined || typeof r["per_run_usd"] !== "number" || typeof r["max_run_minutes"] !== "number") return failed("/api/v1/run-limits");
      if (r["per_run_usd"] > budget) return refuse(`per_run_usd: ${r["per_run_usd"]} above ${budget}`);
      if (r["max_run_minutes"] > MAX_RUN_MINUTES) return refuse(`max_run_minutes: ${r["max_run_minutes"]} above ${MAX_RUN_MINUTES}`);
    }
    const monthly = (await read(() => "/api/v1/budgets"))?.["model_usd_month"];
    if (typeof monthly !== "number") return failed("/api/v1/budgets");
    if (monthly > MONTHLY_MODEL_CEILING_USD) return refuse(`model_usd_month: ${monthly} above ${MONTHLY_MODEL_CEILING_USD}`);
    let row: Json | undefined;
    try {
      row = await this.fixtureRow();
    } catch {
      return failed("/api/v1/repos");
    }
    if (row === undefined || typeof row["id"] !== "string") return failed("/api/v1/repos");
    // The id comes from the app's own answer; it is encoded so it can only ever be one path segment.
    const rowId = row["id"];
    const roles = (await read(() => `/api/v1/repos/${encodeURIComponent(rowId)}/roles`))?.["data"];
    if (!Array.isArray(roles) || roles.length === 0) return failed("/api/v1/repos/{id}/roles");
    for (const r of roles) {
      if (!isObj(r) || typeof r["role"] !== "string") return failed("/api/v1/repos/{id}/roles");
      const expected = FLOORED_ROLES.includes(r["role"]) ? FLOOR_MODEL : CHEAPEST_MODEL;
      if (r["model"] !== expected) return refuse(`role ${shown(r["role"])}: model ${typeof r["model"] === "string" ? shown(r["model"]) : "unset"} above ${expected}`);
    }
    return MET;
  }
}
