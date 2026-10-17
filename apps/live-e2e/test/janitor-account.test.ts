/**
 * The account janitor (T6a) against the strict stand-in in janitor-helpers.ts: the `janitor-account-in-use` refusal,
 * every allowlist boundary of the three destructive calls (each proves the guard stops the call before a request is
 * made, and each has a control showing the stand-in WOULD have accepted it), dry-run, and the caps baseline only ever
 * lowering spend. Offline: no real account, no network.
 */
import { describe, expect, it } from "vitest";
import { createClient } from "../src/client.js";
import { BASELINE_LIMITS, BASELINE_MONTHLY_USD } from "../src/janitor/baseline.js";
import {
  guardWrite,
  pathAllowed,
  planBaseline,
  readObserved,
  runAccountJanitor,
  sendWrites,
  wireOf,
  type JanitorResult,
  type Scope,
  type Write,
} from "../src/janitor/account.js";
import { BYPASS_VALUE, signSession } from "./session-helpers.js";
import { makeTarget } from "./helpers.js";
import { FakeProduct, FIXTURE, FIXTURE_ID, ORG, OTHER_ORG_REPO_ID, SECOND_ORG_REPO_ID, freshState, nonGets, repo, snapshot, spendyState, type State } from "./janitor-helpers.js";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const ORIGIN = "https://staging.example.test";
const COOKIE = signSession({ sid: "s1", sessionStart: NOW - 2 * 86_400_000, lastSeenAt: NOW - 3_600_000 });

function rig(state: State = spendyState()) {
  const app = new FakeProduct(ORIGIN, () => NOW, state);
  const client = createClient({
    origin: ORIGIN,
    bypassSecret: BYPASS_VALUE,
    fence: { target: "staging", targetOrigin: ORIGIN, productionOrigin: "https://production.example.test" },
    fetchImpl: app.fetch,
    ambientHeaders: { cookie: `__Host-fx_session=${COOKIE}` },
  });
  const lines: string[] = [];
  const target = makeTarget();
  const run = (over: Partial<Parameters<typeof runAccountJanitor>[0]> = {}): Promise<JanitorResult> => runAccountJanitor({ target, client, fixtureRepo: FIXTURE, say: (l) => lines.push(l), ...over });
  const scope = async (over: Partial<Scope> = {}): Promise<Scope> => ({
    target: "staging",
    testOrg: ORG,
    fixtureName: FIXTURE,
    fixtureId: FIXTURE_ID,
    outside: 0,
    observed: await readObserved(client, FIXTURE_ID),
    ...over,
  });
  return { app, client, lines, run, scope, state };
}

/** The account with the fixture, one more repo in the test org, and (when asked) the owner's own repo outside it. */
function withRepos(...extra: { id: string; full_name: string | null; install_state?: "installed" | "not_installed" }[]): State {
  const s = spendyState();
  for (const e of extra) {
    s.repos.push({ ...repo(e.id, e.full_name, s.repos.length + 1), ...(e.install_state ? { install_state: e.install_state } : {}) });
    s.models.set(e.id, new Map([["executor", "opus-5"]]));
  }
  return s;
}

const refusedWith = (r: JanitorResult, reason: string): void => {
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toBe(reason);
};

describe("REFUSED janitor-account-in-use", () => {
  const outsiders: [string, { id: string; full_name: string | null; install_state?: "installed" | "not_installed" }][] = [
    ["a repo of another owner", { id: OTHER_ORG_REPO_ID, full_name: "personal-login/cloud" }],
    ["a look-alike org that starts with the test org name", { id: OTHER_ORG_REPO_ID, full_name: `${ORG}-evil/x` }],
    ["a look-alike org that ends with the test org name", { id: OTHER_ORG_REPO_ID, full_name: `evil-${ORG}/x` }],
    ["the test org name as a repo name under another owner", { id: OTHER_ORG_REPO_ID, full_name: `someone/${ORG}` }],
    ["a repo whose full_name is just the org name (no slash)", { id: OTHER_ORG_REPO_ID, full_name: ORG }],
    ["a repo the app names no owner for", { id: OTHER_ORG_REPO_ID, full_name: null }],
    ["a repo whose app is not installed (still connected)", { id: OTHER_ORG_REPO_ID, full_name: "personal-login/cloud", install_state: "not_installed" }],
  ];
  for (const [name, row] of outsiders) {
    it(`${name}: refuses, writes nothing, and reads nothing but the repo list`, async () => {
      const r = rig(withRepos(row));
      const before = snapshot(r.state);
      const out = await r.run({ apply: true });
      refusedWith(out, "janitor-account-in-use");
      if (!out.ok) expect(out.written).toBe(0);
      expect(nonGets(r.app)).toEqual([]);
      expect(snapshot(r.state)).toBe(before);
      // The check comes first: no limits, budget or role read was made either.
      expect(r.app.seen.map((s) => new URL(s.url).pathname)).toEqual(["/api/v1/repos"]);
    });
  }

  it("refuses in dry-run mode too (the dry-run says so instead of planning)", async () => {
    const r = rig(withRepos({ id: OTHER_ORG_REPO_ID, full_name: "personal-login/cloud" }));
    refusedWith(await r.run(), "janitor-account-in-use");
  });

  it("finds the outside repo on a later page", async () => {
    const r = rig(withRepos({ id: SECOND_ORG_REPO_ID, full_name: `${ORG}/a` }, { id: OTHER_ORG_REPO_ID, full_name: "personal-login/cloud" }));
    r.app.pageSize = 1;
    refusedWith(await r.run({ apply: true }), "janitor-account-in-use");
    expect(nonGets(r.app)).toEqual([]);
    expect(r.app.seen.filter((s) => s.url.includes("/api/v1/repos?")).length).toBe(3);
  });

  for (const shape of ["missing", "renamed", "number", "empty"] as const) {
    it(`outside repo on page 2 with the cursor ${shape}: refuses as unreadable, sends no write, leaves the account unchanged`, async () => {
      const r = rig(withRepos({ id: SECOND_ORG_REPO_ID, full_name: `${ORG}/a` }, { id: OTHER_ORG_REPO_ID, full_name: "personal-login/cloud" }));
      r.app.pageSize = 2;
      r.app.cursorShape = shape;
      const before = snapshot(r.state);
      const out = await r.run({ apply: true });
      refusedWith(out, "janitor-unreadable");
      if (!out.ok) expect(out.written).toBe(0);
      expect(nonGets(r.app)).toEqual([]);
      expect(snapshot(r.state)).toBe(before);
    });
  }

  it("does not name the outside repo (the line is a count)", async () => {
    const r = rig(withRepos({ id: OTHER_ORG_REPO_ID, full_name: "personal-login/cloud" }));
    const out = await r.run();
    expect(JSON.stringify(out)).not.toContain("personal-login");
    expect(r.lines.join("\n")).not.toContain("personal-login");
  });

  it("does not refuse for repos that are all in the test org, whatever the letter case", async () => {
    const r = rig(withRepos({ id: SECOND_ORG_REPO_ID, full_name: "TEST-ORG/e2e-tmp-x" }));
    expect((await r.run()).ok).toBe(true);
  });

  it("a repo list that never ends is unreadable, not trusted (fail closed, nothing written)", async () => {
    const r = rig();
    r.app.endlessRepos = true;
    r.app.pageSize = 1;
    refusedWith(await r.run({ apply: true }), "janitor-unreadable");
    expect(nonGets(r.app)).toEqual([]);
  });

  it("a repo list that cannot be read is unreadable (nothing written)", async () => {
    const r = rig();
    r.app.failRead = "/api/v1/repos";
    refusedWith(await r.run({ apply: true }), "janitor-unreadable");
    expect(nonGets(r.app)).toEqual([]);
  });
});

describe("other refusals leave the account as it was", () => {
  it("no fixture variable, or one that is not owner/name: no test org, nothing requested", async () => {
    for (const fixtureRepo of [undefined, "", "no-slash", "a/b/c", "bad owner/x", "../x/y"]) {
      const r = rig();
      refusedWith(await r.run({ fixtureRepo, apply: true }), "janitor-no-test-org");
      expect(r.app.seen).toEqual([]);
    }
  });

  it("production (or any target but staging) is refused before any request", async () => {
    const r = rig();
    refusedWith(await r.run({ target: makeTarget({ name: "production", origin: "https://production.example.test" }), apply: true }), "janitor-not-staging");
    expect(r.app.seen).toEqual([]);
  });

  it("a fixture repo the account has not connected is refused, nothing written", async () => {
    const r = rig();
    refusedWith(await r.run({ fixtureRepo: `${ORG}/not-connected`, apply: true }), "janitor-no-fixture");
    expect(nonGets(r.app)).toEqual([]);
  });

  it("a read that fails or comes back malformed is refused before any write", async () => {
    for (const path of ["/api/v1/run-limits", "/api/v1/budgets", `/api/v1/repos/${FIXTURE_ID}/roles`]) {
      const r = rig();
      r.app.failRead = path;
      const out = await r.run({ apply: true });
      refusedWith(out, "janitor-unreadable");
      expect(nonGets(r.app)).toEqual([]);
    }
    const r = rig();
    // The stand-in re-registers its routes on every read, so the malformed body is made at the wire.
    const wire = r.app.fetch;
    r.app.fetch = async (input, init) => {
      const res = await wire(input, init);
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname !== "/api/v1/budgets") return res;
      return new Response(JSON.stringify({ model_usd_month: "30" }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = createClient({ origin: ORIGIN, bypassSecret: BYPASS_VALUE, fence: { target: "staging", targetOrigin: ORIGIN, productionOrigin: "https://production.example.test" }, fetchImpl: r.app.fetch, ambientHeaders: { cookie: `__Host-fx_session=${COOKIE}` } });
    refusedWith(await r.run({ client, apply: true }), "janitor-unreadable");
    expect(nonGets(r.app)).toEqual([]);
  });

  it("a role the baseline cannot be applied to refuses before any write", async () => {
    const r = rig();
    const wire = r.app.fetch;
    r.app.fetch = async (input, init) => {
      const res = await wire(input, init);
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (!url.pathname.endsWith("/roles")) return res;
      const body = (await res.json()) as { data: { role: string; allowed_models: string[] }[] };
      for (const d of body.data) if (d.role === "executor") d.allowed_models = ["opus-5"];
      return new Response(JSON.stringify(body), { status: 200, headers: res.headers });
    };
    const client = createClient({ origin: ORIGIN, bypassSecret: BYPASS_VALUE, fence: { target: "staging", targetOrigin: ORIGIN, productionOrigin: "https://production.example.test" }, fetchImpl: r.app.fetch, ambientHeaders: { cookie: `__Host-fx_session=${COOKIE}` } });
    refusedWith(await r.run({ client, apply: true }), "janitor-baseline-unreachable");
    expect(nonGets(r.app)).toEqual([]);
  });
});

describe("dry-run", () => {
  it("is the default: only GETs are sent, the account is unchanged, and each change is printed as 'would set'", async () => {
    const r = rig();
    const before = snapshot(r.state);
    const out = await r.run();
    expect(out).toMatchObject({ ok: true, applied: false });
    expect(nonGets(r.app)).toEqual([]);
    expect(snapshot(r.state)).toBe(before);
    expect(r.lines).toEqual([
      `janitor account (dry-run): target staging, test org ${ORG}`,
      `janitor account: 1 connected repo(s), all in ${ORG}`,
      "janitor account: would set run-limits/default: per_run_usd 40 -> 3, max_model_calls 300 -> 60, max_run_minutes 60 -> 20, max_extensions 2 -> 0, max_resumes 2 -> 0",
      "janitor account: would set budgets: model_usd_month 100 -> 30",
      "janitor account: would set roles/code-reviewer: model sonnet-5 -> haiku-4.5",
      "janitor account: would set roles/executor: model opus-5 -> haiku-4.5",
      "janitor account: would set roles/project-manager: model (routing table) -> haiku-4.5",
      "janitor account: would set roles/security-reviewer: model opus-5 -> sonnet-5",
      "janitor account: dry-run, 6 change(s) planned, nothing written",
    ]);
  });

  it("an explicit apply:false is the same dry-run", async () => {
    const r = rig();
    await r.run({ apply: false });
    expect(nonGets(r.app)).toEqual([]);
  });

  it("says so when there is nothing to change", async () => {
    const r = rig();
    await r.run({ apply: true });
    r.lines.length = 0;
    const again = await r.run();
    expect(again).toMatchObject({ ok: true, applied: false, changes: [] });
    expect(r.lines.at(-1)).toBe("janitor account: baseline already met, nothing to change");
  });

  it("prints no credential: not the cookie, not the bypass value", async () => {
    const r = rig();
    await r.run({ apply: true });
    const all = r.lines.join("\n");
    expect(all).not.toContain(COOKIE);
    expect(all).not.toContain(BYPASS_VALUE);
  });
});

describe("apply", () => {
  it("brings the account to the baseline, with the CSRF headers the app requires, and reads it back", async () => {
    const r = rig();
    const out = await r.run({ apply: true });
    expect(out).toMatchObject({ ok: true, applied: true });
    const def = r.state.limitRows.get("default");
    expect(def).toEqual({ max_run_minutes: 20, max_model_calls: 60, per_run_usd: 3, max_extensions: 0, max_resumes: 0 });
    expect(r.state.monthly).toBe(30);
    expect([...(r.state.models.get(FIXTURE_ID) ?? [])]).toEqual([
      ["executor", "haiku-4.5"],
      ["code-reviewer", "haiku-4.5"],
      ["project-manager", "haiku-4.5"],
      ["security-reviewer", "sonnet-5"],
      ["security-expert", "sonnet-5"],
    ]);
    expect(r.app.writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      "PUT /api/v1/run-limits/default",
      "PATCH /api/v1/budgets",
      `PATCH /api/v1/repos/${FIXTURE_ID}/roles/code-reviewer`,
      `PATCH /api/v1/repos/${FIXTURE_ID}/roles/executor`,
      `PATCH /api/v1/repos/${FIXTURE_ID}/roles/project-manager`,
      `PATCH /api/v1/repos/${FIXTURE_ID}/roles/security-reviewer`,
    ]);
    for (const w of nonGets(r.app)) expect(r.app.seen.find((s) => s === w)).toBeDefined();
  });

  it("is idempotent: a second run writes nothing", async () => {
    const r = rig();
    await r.run({ apply: true });
    const writes = r.app.writes.length;
    expect(await r.run({ apply: true })).toMatchObject({ ok: true, changes: [] });
    expect(r.app.writes.length).toBe(writes);
  });

  it("the account then satisfies the same limits `caps-set` reads (run minutes, monthly budget, role models)", async () => {
    const r = rig();
    await r.run({ apply: true });
    const o = await readObserved(r.client, FIXTURE_ID);
    expect(o.limits.get("default")?.resolved.max_run_minutes).toBeLessThanOrEqual(60);
    expect(o.monthly).toBeLessThanOrEqual(30);
    expect(o.models.get("security-expert")?.model).toBe("sonnet-5");
    expect(o.models.get("executor")?.model).toBe("haiku-4.5");
  });

  it("stops at the first failed write: nothing after it is sent, and the error body is not echoed", async () => {
    const r = rig();
    r.app.failWrites = { status: 422, code: "validation_failed", message: `planted secret ${BYPASS_VALUE}` };
    const out = await r.run({ apply: true });
    refusedWith(out, "janitor-write-failed");
    expect(r.app.writes).toHaveLength(1);
    expect(JSON.stringify(out)).not.toContain(BYPASS_VALUE);
    expect(JSON.stringify(out)).toContain("422 validation_failed");
  });

  it("a write answered with a redirect is a failure, never followed", async () => {
    const r = rig();
    const wire = r.app.fetch;
    r.app.fetch = async (input, init) => ((init?.method ?? "GET") === "GET" ? wire(input, init) : new Response(null, { status: 307, headers: { location: "https://elsewhere.example.test/x" } }));
    const client = createClient({ origin: ORIGIN, bypassSecret: BYPASS_VALUE, fence: { target: "staging", targetOrigin: ORIGIN, productionOrigin: "https://production.example.test" }, fetchImpl: r.app.fetch, ambientHeaders: { cookie: `__Host-fx_session=${COOKIE}` } });
    const out = await r.run({ client, apply: true });
    refusedWith(out, "janitor-write-failed");
    expect(r.app.seen.some((s) => s.url.startsWith("https://elsewhere"))).toBe(false);
  });

  it("a 200 that did not take effect is caught by the read-back (janitor-verify-failed)", async () => {
    const r = rig();
    r.app.ignoreWrites = true;
    refusedWith(await r.run({ apply: true }), "janitor-verify-failed");
  });

  it("a request the app's CSRF rule would turn away is a failure, not a silent success (no Origin header)", async () => {
    const r = rig();
    const res = await r.client.request("/api/v1/budgets", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ model_usd_month: 30 }) });
    expect(res.status).toBe(403);
    expect(r.state.monthly).toBe(100);
  });
});

describe("the caps baseline only ever lowers spend", () => {
  it("leaves every value already at or below the baseline alone", async () => {
    const s = freshState();
    s.limitRows.set("default", { per_run_usd: 2, max_model_calls: 30, max_run_minutes: 10, max_extensions: 0, max_resumes: 0 });
    s.monthly = 12;
    s.models.set(FIXTURE_ID, new Map<string, string | null>([["executor", "haiku-4.5"], ["code-reviewer", "haiku-4.5"], ["project-manager", "haiku-4.5"], ["security-reviewer", "sonnet-5"], ["security-expert", "sonnet-5"]]));
    const r = rig(s);
    const before = snapshot(s);
    expect(await r.run({ apply: true })).toMatchObject({ ok: true, changes: [] });
    expect(r.app.writes).toEqual([]);
    expect(snapshot(s)).toBe(before);
  });

  it("a monthly budget of 0 ('not set') is left alone, not raised to 30", async () => {
    const s = spendyState();
    s.monthly = 0;
    const r = rig(s);
    await r.run({ apply: true });
    expect(s.monthly).toBe(0);
    expect(r.app.writes.some((w) => w.path === "/api/v1/budgets")).toBe(false);
  });

  it("lowers only the keys above the baseline, leaving a stricter sibling alone", async () => {
    const s = spendyState();
    s.limitRows.set("default", { per_run_usd: 2, max_model_calls: 300 });
    const r = rig(s);
    await r.run({ apply: true });
    expect(s.limitRows.get("default")).toEqual({ per_run_usd: 2, max_model_calls: 60, max_run_minutes: 20, max_extensions: 0, max_resumes: 0 });
  });

  it("a role row that stores a value above the baseline is lowered; one below it, or inheriting, is untouched", async () => {
    const s = spendyState();
    s.limitRows.set("default", { per_run_usd: 3, max_model_calls: 60, max_run_minutes: 20, max_extensions: 0, max_resumes: 0 });
    s.limitRows.set("executor", { per_run_usd: 50 });
    s.limitRows.set("code-reviewer", { per_run_usd: 1 });
    s.limitRows.set("project-manager", {});
    const r = rig(s);
    await r.run({ apply: true });
    expect(s.limitRows.get("executor")).toEqual({ per_run_usd: 3 });
    expect(s.limitRows.get("code-reviewer")).toEqual({ per_run_usd: 1 });
    expect(s.limitRows.get("project-manager")).toEqual({});
    expect(r.app.writes.filter((w) => w.path.startsWith("/api/v1/run-limits/")).map((w) => w.path)).toEqual(["/api/v1/run-limits/executor"]);
  });

  it("clamps a baseline value up to the product's floor, and still only lowers", async () => {
    const s = spendyState();
    s.bounds = { ...s.bounds, per_run_usd: { default: 40, floor: 5, ceiling: 200 } };
    const r = rig(s);
    await r.run({ apply: true });
    expect(s.limitRows.get("default")?.per_run_usd).toBe(5);
    // A value between the baseline and the floor-clamped target is not 'lowered' to the target: it would be a raise.
    const s2 = spendyState();
    s2.bounds = { ...s2.bounds, per_run_usd: { default: 40, floor: 5, ceiling: 200 } };
    s2.limitRows.set("default", { per_run_usd: 4 });
    const r2 = rig(s2);
    await r2.run({ apply: true });
    expect(s2.limitRows.get("default")?.per_run_usd).toBe(4);
  });

  it("the plan never contains a write that raises anything, over a spread of starting values", async () => {
    for (const per of [undefined, 0, 1, 2, 3, 4, 40, 200]) {
      for (const monthly of [0, 1, 29, 30, 31, 500]) {
        for (const model of [null, "haiku-4.5", "sonnet-5", "opus-5"]) {
          const s = freshState();
          if (per !== undefined) s.limitRows.set("default", { per_run_usd: per });
          s.monthly = monthly;
          s.models.set(FIXTURE_ID, new Map<string, string | null>([["executor", model], ["security-reviewer", model]]));
          const r = rig(s);
          const o = await readObserved(r.client, FIXTURE_ID);
          const scope = await r.scope();
          const { planned, problems } = planBaseline(o, FIXTURE_ID);
          // A floored role the product shows under its floor cannot be fixed by lowering: the janitor refuses instead of raising it.
          expect(problems.length > 0, `${model}`).toBe(model === "haiku-4.5");
          for (const p of planned) {
            expect(() => guardWrite(p.write, scope), p.line).not.toThrow();
            if (p.write.kind === "budgets") expect(monthly).toBeGreaterThan(30);
            if (p.write.kind === "run-limits" && p.write.body.per_run_usd !== undefined) expect(p.write.body.per_run_usd).toBeLessThan(per ?? 40);
          }
        }
      }
    }
  });

  it("the guard refuses a write that would raise: limits, the monthly budget, and a model tier", async () => {
    const s = freshState();
    s.limitRows.set("default", { per_run_usd: 2, max_extensions: 0 });
    s.limitRows.set("executor", { per_run_usd: 2 });
    s.monthly = 12;
    s.models.set(FIXTURE_ID, new Map<string, string | null>([["executor", "haiku-4.5"], ["code-reviewer", "haiku-4.5"], ["project-manager", "haiku-4.5"], ["security-reviewer", "haiku-4.5"], ["security-expert", "sonnet-5"]]));
    const r = rig(s);
    const scope = await r.scope();
    const raises: Write[] = [
      { kind: "run-limits", role: "default", body: { per_run_usd: 3 } },
      { kind: "run-limits", role: "default", body: { max_extensions: 0 } },
      { kind: "run-limits", role: "executor", body: { per_run_usd: 3 } },
      { kind: "budgets", body: { model_usd_month: 30 } },
      // A floored role the product somehow shows below its floor: setting its floor would be a raise.
      { kind: "role-model", repoId: FIXTURE_ID, role: "security-reviewer", body: { model: "sonnet-5" } },
    ];
    for (const w of raises) expect(() => guardWrite(w, scope), JSON.stringify(w)).toThrow();
    const sent = await sendWrites(raises, scope, r.client, ORIGIN);
    expect(sent).toMatchObject({ written: 0, reason: "janitor-out-of-allowlist" });
    expect(nonGets(r.app)).toEqual([]);
  });

  it("the baseline figures are the Spec's (4d, CA2)", () => {
    expect(BASELINE_LIMITS).toEqual({ per_run_usd: 3, max_model_calls: 60, max_run_minutes: 20, max_extensions: 0, max_resumes: 0 });
    expect(BASELINE_MONTHLY_USD).toBe(30);
  });
});

/**
 * Every destructive call, and what stops it from touching anything outside the allowlist. Each case is sent through
 * `sendWrites`, the one place a non-GET is made: the guard must refuse it, no request may leave, and the account must be
 * unchanged. The controls after the table show that the stand-in itself would have accepted the same requests.
 */
describe("allowlist boundaries: a destructive call cannot reach outside the allowlist", () => {
  const roleWrite = (over: Partial<Extract<Write, { kind: "role-model" }>> = {}): Write => ({ kind: "role-model", repoId: FIXTURE_ID, role: "executor", body: { model: "haiku-4.5" }, ...over }) as Write;
  const limitWrite = (role: string, body: Record<string, number>): Write => ({ kind: "run-limits", role, body }) as Write;
  const cases: [string, Write][] = [
    // PUT /api/v1/run-limits/{role}
    ["run-limits: a manifest role the app did not list as a row", limitWrite("code-reviewer", { per_run_usd: 3 })],
    ["run-limits: a path escape in the role", limitWrite("../budgets", { per_run_usd: 3 })],
    ["run-limits: an encoded slash in the role", limitWrite("default%2F..%2Fbudgets", { per_run_usd: 3 })],
    ["run-limits: a slash in the role", limitWrite("default/x", { per_run_usd: 3 })],
    ["run-limits: an upper-case role", limitWrite("DEFAULT", { per_run_usd: 3 })],
    ["run-limits: an empty role", limitWrite("", { per_run_usd: 3 })],
    ["run-limits: a role longer than any name", limitWrite("a".repeat(65), { per_run_usd: 3 })],
    ["run-limits: a key outside the baseline", limitWrite("default", { max_turns: 10 })],
    ["run-limits: auto_resume (not part of the baseline)", { kind: "run-limits", role: "default", body: { auto_resume: false } as never }],
    ["run-limits: a value that is not the baseline", limitWrite("default", { per_run_usd: 4 })],
    ["run-limits: a baseline key with a value below the baseline", limitWrite("default", { per_run_usd: 1 })],
    ["run-limits: an empty body", limitWrite("default", {})],
    // PATCH /api/v1/budgets
    ["budgets: a compute budget key", { kind: "budgets", body: { compute_cap_usd_month: 1 } as never }],
    ["budgets: an extra key beside model_usd_month", { kind: "budgets", body: { model_usd_month: 30, compute_cap_usd_month: 1 } as never }],
    ["budgets: a value above the baseline", { kind: "budgets", body: { model_usd_month: 31 } }],
    ["budgets: a value below the baseline", { kind: "budgets", body: { model_usd_month: 5 } }],
    // PATCH /api/v1/repos/{id}/roles/{role}
    ["role-model: another repo of the test org", roleWrite({ repoId: SECOND_ORG_REPO_ID })],
    ["role-model: the owner's repo outside the test org", roleWrite({ repoId: OTHER_ORG_REPO_ID })],
    ["role-model: an id that is not a UUID", roleWrite({ repoId: "../repos" })],
    ["role-model: the fixture id in another letter case plus a suffix", roleWrite({ repoId: `${FIXTURE_ID}/../x` })],
    ["role-model: a role the app did not list", roleWrite({ role: "not-a-role" })],
    ["role-model: a path escape in the role", roleWrite({ role: "executor/../../x" })],
    ["role-model: mode instead of model", roleWrite({ body: { mode: "off" } as never })],
    ["role-model: a model that is not the baseline for the role", roleWrite({ body: { model: "opus-5" } })],
    ["role-model: the floor model on a role that is not floored", roleWrite({ body: { model: "sonnet-5" } })],
    ["role-model: haiku on a floored role", roleWrite({ role: "security-reviewer", body: { model: "haiku-4.5" } })],
    ["role-model: a null model (clearing the override)", roleWrite({ body: { model: null } as never })],
  ];

  const world = () => {
    const s = withRepos({ id: SECOND_ORG_REPO_ID, full_name: `${ORG}/e2e-tmp-x` });
    // The outside repo is NOT on the account list the janitor sees; the stand-in still knows it, so a stray write would land.
    s.models.set(OTHER_ORG_REPO_ID, new Map([["executor", "opus-5"]]));
    s.limitRows.set("executor", { per_run_usd: 50 });
    s.limitRows.delete("executor");
    return s;
  };

  for (const [name, w] of cases) {
    it(`${name}: refused by the guard, no request leaves, the account is unchanged`, async () => {
      const r = rig(world());
      const scope = await r.scope();
      const before = snapshot(r.state);
      expect(() => guardWrite(w, scope)).toThrow();
      const out = await sendWrites([w], scope, r.client, ORIGIN);
      expect(out).toMatchObject({ written: 0, reason: "janitor-out-of-allowlist" });
      expect(nonGets(r.app)).toEqual([]);
      expect(r.app.writes).toEqual([]);
      expect(snapshot(r.state)).toBe(before);
    });
  }

  it("a good write in the same list still goes through (the table is not refusing everything)", async () => {
    const r = rig(world());
    const scope = await r.scope();
    const out = await sendWrites([roleWrite()], scope, r.client, ORIGIN);
    expect(out).toEqual({ written: 1 });
    expect(r.state.models.get(FIXTURE_ID)?.get("executor")).toBe("haiku-4.5");
  });

  it("a refusal in the middle stops the rest: nothing after it is sent", async () => {
    const r = rig(world());
    const scope = await r.scope();
    const out = await sendWrites([roleWrite(), roleWrite({ repoId: SECOND_ORG_REPO_ID }), roleWrite({ role: "code-reviewer" })], scope, r.client, ORIGIN);
    expect(out).toMatchObject({ written: 1, reason: "janitor-out-of-allowlist" });
    expect(r.app.writes).toHaveLength(1);
  });

  it("the global conditions: not staging, an outside repo present, or a fixture outside the test org", async () => {
    const r = rig(world());
    const good = roleWrite();
    for (const over of [{ target: "production" }, { outside: 1 }, { testOrg: "personal-login" }, { testOrg: "" }, { fixtureName: "personal-login/cloud" }] as Partial<Scope>[]) {
      const scope = await r.scope(over);
      expect(() => guardWrite(good, scope), JSON.stringify(over)).toThrow();
      expect(await sendWrites([good], scope, r.client, ORIGIN)).toMatchObject({ written: 0, reason: "janitor-out-of-allowlist" });
    }
    expect(nonGets(r.app)).toEqual([]);
  });

  it("controls: the stand-in accepts every one of these requests when sent directly, so only the guard stands in the way", async () => {
    const r = rig(world());
    const send = (w: Write) => {
      const { method, path, body } = wireOf(w);
      return r.client.request(path, { method, headers: { origin: ORIGIN, "content-type": "application/json" }, body });
    };
    expect((await send(roleWrite({ repoId: SECOND_ORG_REPO_ID }))).status).toBe(200);
    expect(r.state.models.get(SECOND_ORG_REPO_ID)?.get("executor")).toBe("haiku-4.5");
    expect((await send(roleWrite({ repoId: OTHER_ORG_REPO_ID }))).status).toBe(200);
    expect(r.state.models.get(OTHER_ORG_REPO_ID)?.get("executor")).toBe("haiku-4.5");
    expect((await send(limitWrite("code-reviewer", { per_run_usd: 3 }))).status).toBe(200);
    expect(r.state.limitRows.get("code-reviewer")).toEqual({ per_run_usd: 3 });
    expect((await send({ kind: "budgets", body: { model_usd_month: 5 } })).status).toBe(200);
    expect(r.state.monthly).toBe(5);
  });

  it("every path shape: the three the tool sends are allowed, and nothing else", () => {
    expect(pathAllowed("PUT", "/api/v1/run-limits/default")).toBe(true);
    expect(pathAllowed("PUT", "/api/v1/run-limits/code-reviewer")).toBe(true);
    expect(pathAllowed("PATCH", "/api/v1/budgets")).toBe(true);
    expect(pathAllowed("PATCH", `/api/v1/repos/${FIXTURE_ID}/roles/executor`)).toBe(true);
    for (const [m, p] of [
      ["DELETE", "/api/v1/run-limits/default"],
      ["DELETE", `/api/v1/repos/${FIXTURE_ID}`],
      ["PUT", "/api/v1/budgets"],
      ["PATCH", "/api/v1/run-limits/default"],
      ["PUT", "/api/v1/run-limits/default/x"],
      ["PUT", "/api/v1/run-limits/"],
      ["PUT", "/api/v1/run-limits/../budgets"],
      ["PUT", "/api/v1/run-limits/default?x=1"],
      ["PATCH", "/api/v1/budgets/x"],
      ["PATCH", "/api/v1/repos/x/roles/executor"],
      ["PATCH", `/api/v1/repos/${FIXTURE_ID}/settings`],
      ["PATCH", `/api/v1/repos/${FIXTURE_ID}/roles/executor/x`],
      ["PATCH", `/api/v1/repos/${FIXTURE_ID}/roles/Executor`],
      ["POST", "/api/v1/account"],
      ["POST", "/api/v1/billing/portal-session"],
      ["GET", "/api/v1/budgets"],
    ] as const) {
      expect(pathAllowed(m, p), `${m} ${p}`).toBe(false);
    }
  });

  /** An app that lists hostile role names: the plan then contains a write whose path would leave the three shapes. */
  async function hostileApp(rewrite: (url: URL, body: Record<string, unknown>) => void) {
    const r = rig(world());
    const wire = r.app.fetch;
    r.app.fetch = async (input, init) => {
      const res = await wire(input, init);
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if ((init?.method ?? "GET") !== "GET" || res.status !== 200 || !/\/(run-limits|roles)$/.test(url.pathname)) return res;
      const body = (await res.json()) as Record<string, unknown>;
      rewrite(url, body);
      return new Response(JSON.stringify(body), { status: 200, headers: res.headers });
    };
    const client = createClient({ origin: ORIGIN, bypassSecret: BYPASS_VALUE, fence: { target: "staging", targetOrigin: ORIGIN, productionOrigin: "https://production.example.test" }, fetchImpl: r.app.fetch, ambientHeaders: { cookie: `__Host-fx_session=${COOKIE}` } });
    return { ...r, client };
  }

  it("a role row the app names '../budgets' is never written to, even though the app listed it", async () => {
    const h = await hostileApp((url, body) => {
      if (!url.pathname.endsWith("/run-limits")) return;
      const stored = { max_run_minutes: null, max_model_calls: null, per_run_usd: 50, max_turns: null, silence_minutes: null, max_extensions: null, max_resumes: null, auto_resume: null };
      (body["roles"] as unknown[]).push({ role: "../budgets", stored, resolved: { ...stored, max_run_minutes: 60, max_model_calls: 300, max_turns: 100, silence_minutes: 15, max_extensions: 2, max_resumes: 2, auto_resume: true } });
    });
    const out = await h.run({ client: h.client, apply: true });
    refusedWith(out, "janitor-out-of-allowlist");
    expect(h.app.writes.every((w) => w.path === "/api/v1/run-limits/default")).toBe(true);
    expect(h.app.writes.some((w) => w.path.includes("budgets") || w.path.includes(".."))).toBe(false);
  });

  it("a fixture role the app names with a slash is never written to", async () => {
    const h = await hostileApp((url, body) => {
      if (!url.pathname.endsWith("/roles")) return;
      (body["data"] as Record<string, unknown>[]).push({ role: "executor/../../../budgets", model: "opus-5", model_floor: null, allowed_models: ["haiku-4.5", "sonnet-5", "opus-5"] });
    });
    const out = await h.run({ client: h.client, apply: true });
    refusedWith(out, "janitor-out-of-allowlist");
    expect(h.app.writes.some((w) => w.path.includes(".."))).toBe(false);
  });

  it("no write is ever aimed at GitHub, Stripe, Vercel or the production host (every request goes to the target origin)", async () => {
    const r = rig();
    await r.run({ apply: true });
    for (const s of r.app.seen) expect(new URL(s.url).origin).toBe(ORIGIN);
  });
});
