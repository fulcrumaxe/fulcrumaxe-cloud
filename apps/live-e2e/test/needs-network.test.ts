/**
 * The network needs against the app stand-in (session-helpers.ts: session cookie contract, empty 401, the wall) and,
 * for `test-repo`, a strict local GitHub over real TLS. The v1 bodies below are shaped like packages/api/openapi.json
 * (only the fields the probe reads). Not faked: the real onboarding and billing state machines behind the bodies.
 */
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { startStrictGithubServer, type LocalTlsServer } from "../../../packages/github/test/helpers/localTlsServer.js";
import { ghError, type GhReply, type GhRequest } from "../../../packages/github/test/helpers/strictGithub.js";
import { join } from "node:path";
import { CHEAPEST_MODEL, FIXTURE_BASELINE_TAG, isNetworkNeed, MAX_RUN_MINUTES, MONTHLY_MODEL_CEILING_USD, resolveNetworkNeeds, type NetworkDeps } from "../src/needs-network.js";
import { parseClaims } from "../src/sessions.js";
import { putRole, readStore, storePath } from "../src/store.js";
import { BYPASS_VALUE, FakeApp, signSession } from "./session-helpers.js";
import { makeTarget, PACKAGE_ROOT, tmpDir } from "./helpers.js";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const D = 86_400_000;
const H = 3_600_000;
const keyBytes = randomBytes(32);
const mk = (startAgo: number, seenAgo: number, sid = "s1") => signSession({ sid, sessionStart: NOW - startAgo, lastSeenAt: NOW - seenAgo });
const FIXTURE = "test-org/fixture";
const REPO_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN_ENV = ["fixture", "token", "for", "tests", "0001"].join("-"); // gitleaks:allow

interface World {
  repos: unknown[];
  model: unknown;
  limits: unknown;
  budgets: unknown;
  roles: unknown;
  account: unknown;
  onboarding: unknown;
}
const good = (): World => ({
  repos: [{ id: REPO_ID, product: "p", gh_repo_id: 1, install_state: "installed", app_kind: "team", full_name: FIXTURE }],
  model: { provider: "anthropic", fingerprint: "fp", status: "ok", last_validated_at: null, last_error_code: null, outside_meter: null },
  limits: { default: { role: "default", stored: {}, resolved: { per_run_usd: 3, max_run_minutes: 20 } }, roles: [{ role: "executor", stored: {}, resolved: { per_run_usd: 3, max_run_minutes: 20 } }] },
  budgets: { model_usd_month: 30, foreground_compute_usd_month: 0, background_compute_usd_month: 0, compute_cap_usd_month: 0, plan: "p" },
  roles: { data: [{ role: "executor", model: CHEAPEST_MODEL, model_floor: null }, { role: "security-reviewer", model: "sonnet-5", model_floor: "sonnet-5" }, { role: "security-expert", model: "sonnet-5", model_floor: "sonnet-5" }] },
  account: { id: "a", plan: "p", status: "unsubscribed" },
  onboarding: { started_at: "x", steps: ["model_key", "readonly_app", "preview", "pay", "write_app", "first_pr"].map((step) => ({ step, completed_at: null, skipped: false })) },
});

const openServers: LocalTlsServer[] = [];
afterEach(async () => {
  await Promise.all(openServers.splice(0).map((s) => s.close()));
});

/** `caps-set` and `sandbox` need `test-repo` met: a local TLS stand-in for the code host that has the baseline tag, with the token in the env. */
async function withTestRepo(): Promise<{ env: Record<string, string>; githubCa: string }> {
  const server = await startStrictGithubServer((req: GhRequest): GhReply =>
    req.headers["authorization"] !== `Bearer ${TOKEN_ENV}` ? ghError(401, "Bad credentials") : req.path === `/repos/${FIXTURE}/git/ref/tags/${FIXTURE_BASELINE_TAG}` ? { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ref: `refs/tags/${FIXTURE_BASELINE_TAG}` }) } : ghError(404, "Not Found"));
  openServers.push(server);
  return { env: { LIVE_E2E_FIXTURE_REPO_TOKEN: TOKEN_ENV, GITHUB_API_URL: `https://127.0.0.1:${server.port}` }, githubCa: server.ca };
}

async function rig(world: World = good(), opts: { cookie?: string; env?: Record<string, string | undefined>; testRepo?: boolean } = {}) {
  const home = tmpDir();
  const target = makeTarget();
  const file = storePath(home, "staging");
  const cookie = opts.cookie ?? mk(2 * D, 3 * H);
  if (cookie !== "none") await putRole(file, "staging", keyBytes, "owner", cookie);
  const app = new FakeApp(target.origin, () => NOW);
  const state = { world };
  app.api["/api/v1/repos"] = (u) => {
    const cursor = u.searchParams.get("cursor");
    const rows = state.world.repos;
    return cursor === null ? { data: rows.slice(0, 1), next_cursor: rows.length > 1 ? "c2" : null } : { data: rows.slice(1), next_cursor: null };
  };
  app.api["/api/v1/model-connection"] = () => state.world.model;
  app.api["/api/v1/run-limits"] = () => state.world.limits;
  app.api["/api/v1/budgets"] = () => state.world.budgets;
  app.api[`/api/v1/repos/${REPO_ID}/roles`] = () => state.world.roles;
  app.api["/api/v1/account"] = () => state.world.account;
  app.api["/api/v1/onboarding"] = () => state.world.onboarding;
  const gh = opts.testRepo === true ? await withTestRepo() : undefined;
  const env = { HOME: home, LIVE_E2E_SESSION_KEY: keyBytes.toString("base64"), VERCEL_AUTOMATION_BYPASS_SECRET: BYPASS_VALUE, LIVE_E2E_PRODUCTION_ORIGIN: "https://production.example.test", LIVE_E2E_FIXTURE_REPO: FIXTURE, ...gh?.env, ...opts.env };
  // The run budget the cost engine will pass as --budget-usd; without it the effective budget is the target's default (zero).
  const deps: NetworkDeps = { target, targetsDir: join(PACKAGE_ROOT, "targets"), env, now: NOW, fetchImpl: app.fetch, budgetUsd: 3, ...(gh ? { githubCa: gh.githubCa } : {}) };
  return { app, deps, file, state, resolve: (needs: string[], extra: Partial<NetworkDeps> = {}) => resolveNetworkNeeds(needs, { ...deps, ...extra }) };
}

const met = (r: { met: boolean } | undefined) => r?.met === true;

describe("which needs are network needs", () => {
  it("is the closed vocabulary of T3, and leaves the env needs and T9's alone", () => {
    for (const n of ["session:owner", "github-app:team", "fresh-state:unpaid", "model-key", "test-repo", "caps-set", "sandbox"]) expect(isNetworkNeed(n), n).toBe(true);
    for (const n of ["bypass", "stripe-test", "host-capacity", "signin:scripted", "webhook-sink", "api-token:read"]) expect(isNetworkNeed(n), n).toBe(false);
  });
});

describe("session:<role>", () => {
  it("is met by a usable session the app answers 200 for, and writes the refreshed cookie back", async () => {
    const r = await rig();
    expect(met((await r.resolve(["session:owner"]))["session:owner"])).toBe(true);
    expect(parseClaims(readStore(r.file, "staging", keyBytes)["owner"] as string)?.lastSeenAt).toBe(NOW);
  });

  it("does not replace a newer stored cookie with the refresh it got (the store changed while /me was in flight)", async () => {
    const r = await rig();
    const newer = mk(2 * D, -H, "newer");
    const inner = r.deps.fetchImpl as typeof fetch;
    const racing: typeof fetch = async (input, init) => {
      const res = await inner(input, init);
      await putRole(r.file, "staging", keyBytes, "owner", newer);
      return res;
    };
    const out = await resolveNetworkNeeds(["session:owner"], { ...r.deps, fetchImpl: racing });
    expect(met(out["session:owner"])).toBe(true);
    expect(readStore(r.file, "staging", keyBytes)["owner"]).toBe(newer);
  });

  it("is unmet for a role not stored, an unknown role, an idle one, one past the 30-day limit, and one the app turns away", async () => {
    for (const cookie of ["none", mk(2 * D, 25 * H), mk(31 * D, H)]) {
      const r = await rig(good(), { cookie });
      expect(met((await r.resolve(["session:owner"]))["session:owner"]), cookie.slice(0, 8)).toBe(false);
    }
    const r = await rig();
    r.app.revoked.add("s1");
    const out = await r.resolve(["session:owner", "session:member", "session:root"]);
    expect(Object.values(out).every((v) => !v.met)).toBe(true);
  });

  it("is unmet (not a crash) without the bypass secret, with the wrong key, or while the app is down", async () => {
    const r = await rig();
    expect(met((await r.resolve(["session:owner"], { env: { ...r.deps.env, VERCEL_AUTOMATION_BYPASS_SECRET: undefined } }))["session:owner"])).toBe(false);
    expect(met((await r.resolve(["session:owner"], { env: { ...r.deps.env, LIVE_E2E_SESSION_KEY: randomBytes(32).toString("base64") } }))["session:owner"])).toBe(false);
    r.app.outage = 502;
    expect(met((await r.resolve(["session:owner"]))["session:owner"])).toBe(false);
  });

  it("asks the app for /me once however many needs use the session", async () => {
    const r = await rig();
    await r.resolve(["session:owner", "github-app:team", "model-key", "fresh-state:unpaid"]);
    expect(r.app.seen.filter((s) => s.url.endsWith("/api/cloud/auth/me"))).toHaveLength(1);
  });
});

describe("github-app:<kind>", () => {
  it("is met when the fixture repo shows installed for exactly that kind, across pages and in any letter case", async () => {
    const w = good();
    w.repos = [{ ...(w.repos[0] as object), full_name: "other/repo", app_kind: "team" }, { ...(w.repos[0] as object), full_name: FIXTURE.toUpperCase(), app_kind: "team_readonly" }];
    const r = await rig(w);
    const out = await r.resolve(["github-app:team_readonly", "github-app:team", "github-app:sitekit", "github-app:nonsense"]);
    expect([out["github-app:team_readonly"], out["github-app:team"], out["github-app:sitekit"], out["github-app:nonsense"]].map(met)).toEqual([true, false, false, false]);
  });

  it("is unmet when the app is not installed, or when no fixture repo is named", async () => {
    const w = good();
    (w.repos[0] as Record<string, unknown>)["install_state"] = "not_installed";
    expect(met((await (await rig(w)).resolve(["github-app:team"]))["github-app:team"])).toBe(false);
    const r = await rig(good(), { env: { LIVE_E2E_FIXTURE_REPO: undefined } });
    expect(met((await r.resolve(["github-app:team"]))["github-app:team"])).toBe(false);
  });
});

describe("model-key and fresh-state:<name>", () => {
  it("model-key is met only by a connection that reports ok", async () => {
    for (const [status, expected] of [["ok", true], ["unvalidated", false], ["broken", false]] as const) {
      const w = good();
      (w.model as Record<string, unknown>)["status"] = status;
      expect(met((await (await rig(w)).resolve(["model-key"]))["model-key"]), status).toBe(expected);
    }
  });

  it("unpaid, preview-unused and first-sign-in read the account and the onboarding steps", async () => {
    const r = await rig();
    expect((await r.resolve(["fresh-state:unpaid", "fresh-state:preview-unused", "fresh-state:first-sign-in", "fresh-state:other"]) as Record<string, { met: boolean }>)["fresh-state:other"]?.met).toBe(false);
    const all = await r.resolve(["fresh-state:unpaid", "fresh-state:preview-unused", "fresh-state:first-sign-in"]);
    expect(Object.values(all).map(met)).toEqual([true, true, true]);
    const w = good();
    (w.account as Record<string, unknown>)["status"] = "active";
    (w.onboarding as { steps: Record<string, unknown>[] }).steps[2] = { step: "preview", completed_at: "2026-10-19T00:00:00Z", skipped: false };
    const used = await (await rig(w)).resolve(["fresh-state:unpaid", "fresh-state:preview-unused", "fresh-state:first-sign-in"]);
    expect(Object.values(used).map(met)).toEqual([false, false, false]);
  });
});

describe("test-repo", () => {
  let server: LocalTlsServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });
  const route = (tag: string) => (req: GhRequest): GhReply =>
    req.headers["authorization"] !== `Bearer ${TOKEN_ENV}` ? ghError(401, "Bad credentials") : req.path === `/repos/${FIXTURE}/git/ref/tags/${tag}` ? { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ref: `refs/tags/${tag}` }) } : ghError(404, "Not Found");

  it("needs the token, the repo name and the baseline tag, read with the fixture token over TLS", async () => {
    server = await startStrictGithubServer(route(FIXTURE_BASELINE_TAG));
    const r = await rig();
    const env = { ...r.deps.env, LIVE_E2E_FIXTURE_REPO_TOKEN: TOKEN_ENV, GITHUB_API_URL: `https://127.0.0.1:${server.port}` };
    expect(met((await r.resolve(["test-repo"], { env, githubCa: server.ca }))["test-repo"])).toBe(true);
    expect(server.seen.every((s) => s.headers["user-agent"] === "live-e2e")).toBe(true);
    expect(met((await r.resolve(["test-repo"], { env: { ...env, LIVE_E2E_FIXTURE_REPO_TOKEN: undefined }, githubCa: server.ca }))["test-repo"])).toBe(false);
    expect(met((await r.resolve(["test-repo"], { env: { ...env, LIVE_E2E_FIXTURE_REPO: undefined }, githubCa: server.ca }))["test-repo"])).toBe(false);
    expect(met((await r.resolve(["test-repo"], { env: { ...env, LIVE_E2E_FIXTURE_REPO_TOKEN: "wrong" }, githubCa: server.ca }))["test-repo"])).toBe(false);
  });

  it("is unmet when the baseline tag does not exist", async () => {
    server = await startStrictGithubServer(route("some-other-tag"));
    const r = await rig();
    const env = { ...r.deps.env, LIVE_E2E_FIXTURE_REPO_TOKEN: TOKEN_ENV, GITHUB_API_URL: `https://127.0.0.1:${server.port}` };
    expect(met((await r.resolve(["test-repo"], { env, githubCa: server.ca }))["test-repo"])).toBe(false);
  });
});

describe("caps-set: REFUSED caps on any excess, never a skip", () => {
  const caps = async (mutate: (w: World) => void, extra: Partial<NetworkDeps> = {}) => {
    const w = good();
    mutate(w);
    return (await (await rig(w, { testRepo: true })).resolve(["caps-set"], extra))["caps-set"];
  };
  const refused = (r: unknown) => (r as { met: boolean; refuse?: string }).met === false && (r as { refuse?: string }).refuse === "caps";
  type Limits = { default: { resolved: Record<string, unknown> }; roles: { resolved: Record<string, unknown> }[] };
  const limits = (w: World) => w.limits as Limits;
  const roles = (w: World) => (w.roles as { data: Record<string, unknown>[] }).data;

  it("is met by the baseline the janitor writes: a low per-run cap and run time, the monthly ceiling, the cheapest tier (the two security roles at their floor)", async () => {
    expect(met(await caps(() => undefined))).toBe(true);
  });

  it("with no --budget-usd the effective budget is the target's default of zero: every account is refused, so no model-spending pack can start", async () => {
    const r = await rig(good(), { testRepo: true });
    expect(r.deps.target.budget_usd.default).toBe(0);
    const { budgetUsd: _given, ...withoutBudget } = r.deps;
    void _given;
    expect(refused((await resolveNetworkNeeds(["caps-set", "sandbox"], withoutBudget))["caps-set"])).toBe(true);
    expect(refused((await resolveNetworkNeeds(["sandbox"], withoutBudget))["sandbox"])).toBe(true);
  });

  it("refuses a per-run cap above the budget, on the default or on any one role, by a hair; accepts exactly the budget (and not the target's maximum)", async () => {
    expect(refused(await caps((w) => (limits(w).default.resolved["per_run_usd"] = 40)))).toBe(true);
    expect(refused(await caps((w) => (limits(w).roles[0]!.resolved["per_run_usd"] = 3.01)))).toBe(true);
    expect(refused(await caps((w) => (limits(w).default.resolved["per_run_usd"] = 8)))).toBe(true);
    expect(met(await caps((w) => (limits(w).default.resolved["per_run_usd"] = 3)))).toBe(true);
    expect(met(await caps((w) => (limits(w).default.resolved["per_run_usd"] = 8), { budgetUsd: 8 }))).toBe(true);
  });

  it("refuses run minutes above 60 on the default or any one role, and accepts exactly 60", async () => {
    expect(refused(await caps((w) => (limits(w).default.resolved["max_run_minutes"] = 61)))).toBe(true);
    expect(refused(await caps((w) => (limits(w).roles[0]!.resolved["max_run_minutes"] = 61)))).toBe(true);
    expect(met(await caps((w) => (limits(w).default.resolved["max_run_minutes"] = MAX_RUN_MINUTES)))).toBe(true);
  });

  it("refuses a monthly model budget above the ceiling and accepts exactly the ceiling", async () => {
    expect(MONTHLY_MODEL_CEILING_USD).toBe(30);
    expect(refused(await caps((w) => ((w.budgets as Record<string, number>)["model_usd_month"] = 30.01)))).toBe(true);
    expect(refused(await caps((w) => ((w.budgets as Record<string, unknown>)["model_usd_month"] = "30")))).toBe(true);
    expect(met(await caps((w) => ((w.budgets as Record<string, number>)["model_usd_month"] = 30)))).toBe(true);
  });

  it("refuses a role not pinned to the cheapest tier; the two security roles must equal their floor, a floor on any other role does not excuse it", async () => {
    expect(refused(await caps((w) => (roles(w)[0]!["model"] = "sonnet-5")))).toBe(true);
    expect(refused(await caps((w) => (roles(w)[0]!["model"] = "opus-5")))).toBe(true);
    expect(refused(await caps((w) => (roles(w)[0]!["model"] = null)))).toBe(true);
    expect(refused(await caps((w) => ((roles(w)[0]!["model"] = "sonnet-5"), (roles(w)[0]!["model_floor"] = "sonnet-5"))))).toBe(true);
    expect(refused(await caps((w) => (roles(w)[1]!["model"] = "opus-5")))).toBe(true);
    expect(refused(await caps((w) => (roles(w)[2]!["model"] = CHEAPEST_MODEL)))).toBe(true);
    expect(refused(await caps((w) => ((w.roles as { data: unknown[] }).data = [])))).toBe(true);
  });

  it("refuses when any read fails or is missing a field (fail closed), or the fixture repo is not among the repos", async () => {
    for (const path of ["/api/v1/run-limits", "/api/v1/budgets"]) {
      const r = await rig(good(), { testRepo: true });
      r.app.api[path] = () => {
        throw new Error("boom");
      };
      expect(refused((await r.resolve(["caps-set"]))["caps-set"]), path).toBe(true);
    }
    expect(refused(await caps((w) => (w.repos = [])))).toBe(true);
    expect(refused(await caps((w) => (w.limits = { default: {}, roles: [] })))).toBe(true);
    expect(refused(await caps((w) => delete limits(w).default.resolved["max_run_minutes"]))).toBe(true);
    expect(refused(await caps((w) => delete limits(w).roles[0]!.resolved["per_run_usd"]))).toBe(true);
    expect(refused(await caps((w) => delete (w.budgets as Record<string, unknown>)["model_usd_month"]))).toBe(true);
    expect(refused(await caps((w) => delete roles(w)[0]!["role"]))).toBe(true);
    const down = await rig(good(), { testRepo: true });
    down.app.api[`/api/v1/repos/${REPO_ID}/roles`] = () => {
      throw new Error("down");
    };
    expect(refused((await down.resolve(["caps-set"]))["caps-set"])).toBe(true);
  });

  it("puts the repo id the app answered with into the roles path as ONE encoded segment", async () => {
    const id = "a/b?x=1#frag";
    const w = good();
    (w.repos[0] as Record<string, unknown>)["id"] = id;
    const r = await rig(w, { testRepo: true });
    const seenPaths: string[] = [];
    r.app.api[`/api/v1/repos/${encodeURIComponent(id)}/roles`] = () => {
      seenPaths.push(encodeURIComponent(id));
      return r.state.world.roles;
    };
    expect(met((await r.resolve(["caps-set"]))["caps-set"])).toBe(true);
    expect(seenPaths).toHaveLength(1);
    // No request left the app's own repo-roles path shape.
    expect(r.app.seen.filter((s) => s.url.includes("/roles")).map((s) => new URL(s.url).pathname)).toEqual([`/api/v1/repos/${encodeURIComponent(id)}/roles`]);
  });

  it("is a skip (unmet, not refused) when there is no owner session to read with, or no fixture repo is named", async () => {
    // R-441-T3-21: no read attempted is never "met", and not one request is made.
    const noSession = await rig(good(), { cookie: "none", testRepo: true });
    expect((await noSession.resolve(["caps-set", "sandbox"]))["caps-set"]).toEqual({ met: false });
    expect(noSession.app.seen).toEqual([]);
    const unnamedRig = await rig(good(), { env: { LIVE_E2E_FIXTURE_REPO: undefined }, testRepo: true });
    expect((await unnamedRig.resolve(["caps-set"]))["caps-set"]).toEqual({ met: false });
    expect(unnamedRig.app.seen.filter((s) => /run-limits|budgets|roles/.test(s.url))).toEqual([]);
    expect(unnamedRig.app.seen).toEqual([]);
  });
});

describe("sandbox", () => {
  it("is met when model-key and caps-set are", async () => {
    const out = await (await rig(good(), { testRepo: true })).resolve(["sandbox"]);
    expect(met(out["sandbox"])).toBe(true);
  });

  it("carries the caps refusal, and is a plain skip when only the model key is missing", async () => {
    const w = good();
    (w.budgets as Record<string, number>)["model_usd_month"] = 99;
    expect((await (await rig(w, { testRepo: true })).resolve(["sandbox"]))["sandbox"]).toEqual({ met: false, refuse: "caps", detail: "model_usd_month: 99 above 30" });
    const x = good();
    (x.model as Record<string, unknown>)["status"] = "broken";
    expect((await (await rig(x, { testRepo: true })).resolve(["sandbox"]))["sandbox"]).toEqual({ met: false });
  });
});

describe("a deployment that did not identify as staging", () => {
  it("refuses every network need with that reason and sends no request", async () => {
    const r = await rig();
    const out = await r.resolve(["session:owner", "model-key", "caps-set", "bypass"], { identityRefusal: "layer2-project-id-mismatch" });
    expect(out).toEqual({ "session:owner": { met: false, refuse: "layer2-project-id-mismatch" }, "model-key": { met: false, refuse: "layer2-project-id-mismatch" }, "caps-set": { met: false, refuse: "layer2-project-id-mismatch" } });
    expect(r.app.seen).toEqual([]);
  });
});
