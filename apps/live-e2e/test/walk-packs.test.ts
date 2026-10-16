// The T7 walk packs (shell, api-contract, auth, auth-scripted): what they declare, how plan treats them, that the
// post-deploy argument list names them, and the pure rules their specs use. Offline: no staging or production credential.
import { randomBytes } from "node:crypto";
import { cpSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { accessViolations, badStatusEvent, clip, labelUrl, maskUrls, ONBOARDING_APPS, problemLines } from "../packs/shell/expected.js";
import {
  authorizeViolations,
  entitlementsViolations,
  identityViolations,
  isGithubHost,
  plansViolations,
  stateCookieViolations,
} from "../packs/auth/expected.js";
import {
  concretePath,
  errorEnvelopeViolations,
  listGetOperations,
  MUST_ANSWER_200,
  retryDelayMs,
  type Schema,
  schemaViolations,
  signedInViolations,
  signedOutViolations,
  ZERO_UUID,
} from "../packs/api-contract/expected.js";
import { main, parseArgs, type Io } from "../src/cli.js";
import { createClient } from "../src/client.js";
import { loadPacks } from "../src/manifest.js";
import { select } from "../src/select.js";
import type { Plan } from "../src/plan.js";
import { BYPASS_ENV } from "../src/needs.js";
import type { Invocation } from "../src/run.js";
import { putRole, storePath } from "../src/store.js";
import { BYPASS_VALUE, FakeApp, signSession } from "./session-helpers.js";
import { makeIo, PACKAGE_ROOT, scratchRoot, tmpDir } from "./helpers.js";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const D = 86_400_000;
const STAGING = "https://staging.example.test";
const keyBytes = randomBytes(32);

const packs = loadPacks(join(PACKAGE_ROOT, "packs"));
const byId = (id: string) => {
  const p = packs.find((x) => x.id === id);
  if (p === undefined) throw new Error(`pack ${id} missing`);
  return p;
};
const WALK = ["shell", "api-contract", "auth"];
const fixture = JSON.parse(readFileSync(join(PACKAGE_ROOT, "test", "fixtures", "workflow-args.json"), "utf8")) as Record<string, string[]>;

async function plan(args: string[]): Promise<{ code: number; plan: Plan | null; out: string; err: string }> {
  const scratch = scratchRoot([]);
  const { io, out, err } = makeIo(PACKAGE_ROOT, { [BYPASS_ENV]: "present" });
  io.cwd = scratch;
  const code = await main(["plan", ...args], io);
  let parsed: Plan | null = null;
  try {
    parsed = JSON.parse(readFileSync(join(scratch, "plan.json"), "utf8")) as Plan;
  } catch {
    parsed = null;
  }
  return { code, plan: parsed, out: out.join("\n"), err: err.join("\n") };
}

describe("what the walk packs declare", () => {
  it("shell, api-contract and auth: standard tier, staging only, read-only, as the owner session", () => {
    expect(byId("shell").rows).toEqual(["W1", "W2"]);
    expect(byId("api-contract").rows).toEqual(["W21"]);
    expect(byId("auth").rows).toEqual(["A1", "A7"]);
    for (const id of WALK) {
      const p = byId(id);
      expect(p.tier, id).toBe("standard");
      expect(p.targets, id).toEqual(["staging"]);
      expect(p.destructive, id).toBe(false);
      expect(p.model_spend, id).toBe(false);
      expect(p.needs, id).toEqual(["bypass", "session:owner"]);
      expect(p.cost, id).toEqual({ class: "free", est_usd: 0, est_sandbox_min: 0 });
    }
  });

  it("the ui packs run on all three devices; the api-only pack on desktop and carries no ui tag", () => {
    for (const id of ["shell", "auth"]) expect(byId(id).projects, id).toEqual(["desktop", "phone", "tablet"]);
    expect(byId("api-contract").projects).toEqual(["desktop"]);
    expect(byId("api-contract").tags).toEqual(["@api"]);
  });

  it("auth-scripted holds A2, A3 and A6 behind signin:scripted, and is destructive (A6 writes a membership)", () => {
    const p = byId("auth-scripted");
    expect(p.rows).toEqual(["A2", "A3", "A6"]);
    expect(p.needs).toContain("signin:scripted");
    expect(p.destructive).toBe(true);
    expect(p.targets).toEqual(["staging"]);
  });

  it("every row of the T7 task is held by exactly one pack", () => {
    const rows = ["A1", "A2", "A3", "A6", "A7", "W1", "W2", "W21"];
    for (const row of rows) {
      const holders = packs.filter((p) => p.rows.includes(row)).map((p) => p.id);
      // A7 is shared on purpose: signed out in auth-negative, signed in in auth.
      expect(holders, row).toEqual(row === "A7" ? ["auth", "auth-negative"] : [expect.any(String)]);
    }
  });
});

describe("plan", () => {
  it("is offline: every walk pack is listed SKIPPED-NEED (the session is probed only by run), and auth-scripted names signin:scripted", async () => {
    const r = await plan(["--target", "staging", "--pack", [...WALK, "auth-scripted"].join(",")]);
    expect(r.code).toBe(0);
    expect(r.plan?.skipped.map((s) => `${s.id}:${s.need}`)).toEqual(["api-contract:session:owner", "auth:session:owner", "auth-scripted:signin:scripted", "shell:session:owner"]);
  });

  it("run with a stored owner session starts the three walk packs, hands them the session key, and skips auth-scripted green", async () => {
    const home = tmpDir();
    await putRole(storePath(home, "staging"), "staging", keyBytes, "owner", signSession({ sid: "s1", sessionStart: NOW - D, lastSeenAt: NOW - 3_600_000 }));
    const app = new FakeApp(STAGING, () => NOW);
    app.open["/api/health"] = () => ({ ok: true, deploy_env: "staging", project_id: "prj_Staging1", commit: "abcdef1" });
    const root = scratchRoot([]);
    cpSync(join(PACKAGE_ROOT, "packs"), join(root, "packs"), { recursive: true });
    const started: Invocation[] = [];
    const { io } = makeIo(root, { HOME: home, LIVE_E2E_SESSION_KEY: keyBytes.toString("base64"), VERCEL_AUTOMATION_BYPASS_SECRET: BYPASS_VALUE });
    const full: Io = { ...io, fetch: app.fetch, now: () => NOW, cli: "/pw/cli.js", exec: async (inv) => (started.push(inv), { code: 0, output: "" }) };
    expect(await main(["run", "--target", "staging", "--tier", "smoke", "--trigger", "deploy", "--pack", "shell,api-contract,auth"], full)).toBe(0);
    const out = JSON.parse(readFileSync(join(root, "plan.json"), "utf8")) as Plan;
    expect(out.packs.filter((p) => WALK.includes(p.id)).map((p) => `${p.id}:${p.outcome}`).sort()).toEqual(["api-contract:RUN", "auth:RUN", "shell:RUN"]);
    expect(started.map((i) => i.packId).sort()).toEqual(["api-contract", "auth", "auth-negative", "platform", "shell"]);
    for (const i of started.filter((x) => WALK.includes(x.packId))) expect(i.env["LIVE_E2E_SESSION_KEY"], i.packId).toBe(keyBytes.toString("base64"));
    for (const i of started.filter((x) => !WALK.includes(x.packId))) expect(i.env["LIVE_E2E_SESSION_KEY"], i.packId).toBeUndefined();
    // Named alongside, auth-scripted is skipped on its need and never started.
    const both = await main(["run", "--target", "staging", "--pack", "auth,auth-scripted"], full);
    expect(both).toBe(0);
    expect(started.filter((i) => i.packId === "auth-scripted")).toEqual([]);
  });

  it("refuses every walk pack on production, whatever the tier, and exits non-zero when named", async () => {
    for (const id of [...WALK, "auth-scripted"]) {
      const r = await plan(["--target", "production", "--pack", id]);
      expect(r.code, id).toBe(1);
      expect(r.plan?.selected, id).toEqual([]);
      expect(r.plan?.refused.map((x) => x.id), id).toEqual([id]);
    }
  });

  it("leaves the smoke tier alone: a production smoke plan still selects exactly the two prod-safe packs", async () => {
    const r = await plan(["--target", "production", "--tier", "smoke"]);
    expect(r.code).toBe(0);
    expect(r.plan?.selected.map((s) => s.id)).toEqual(["auth-negative", "platform"]);
  });
});

describe("the post-deploy argument list", () => {
  it("names exactly the three walk packs, so a deploy runs them without moving them into the smoke tier", () => {
    const args = parseArgs(fixture["deploy"] ?? []);
    expect(args.trigger).toBe("deploy");
    expect(args.tier).toBe("smoke");
    expect(args.tag).toBeUndefined();
    expect([...args.packs].sort()).toEqual([...WALK].sort());
  });

  it("selects every smoke pack and the three walk packs, and not auth-scripted", () => {
    const args = parseArgs(fixture["deploy"] ?? []);
    const sel = select({ packs, ...(args.tier !== undefined ? { tier: args.tier } : {}), named: args.packs });
    const ids = sel.packs.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["auth-negative", "platform", ...WALK]));
    expect(ids).not.toContain("auth-scripted");
  });

  it("a pack that does not exist in the list is refused by the manifest, not ignored (the list cannot name a pack early)", async () => {
    const r = await plan(["--target", "staging", "--tier", "smoke", "--trigger", "deploy", "--pack", "shell,no-such-pack"]);
    expect(r.code).not.toBe(0);
  });
});

// A1 through a real client over a fake network, so the hop log comes from the code the pack runs on.
describe("authorizeViolations", () => {
  const ORIGIN = "https://staging.example.test";
  const STATE = "3f1c2a52-8d4b-4c63-9a0e-5b7d1e2f3a4b";
  const authorize = (over: Record<string, string> = {}) => {
    const u = new URL("https://github.com/login/oauth/authorize");
    const p = { client_id: "Iv1.abc", redirect_uri: `${ORIGIN}/api/auth/github/callback`, scope: "read:user user:email", state: STATE, ...over };
    for (const [k, v] of Object.entries(p)) if (v !== "") u.searchParams.set(k, v);
    return u.toString();
  };
  async function hopsFor(location: string, secret: string | undefined = "bypass-secret-for-tests") {
    const seen: { url: string; bypass: boolean }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const h = new Headers(init.headers);
      seen.push({ url, bypass: h.has("x-vercel-protection-bypass") });
      return url.startsWith(ORIGIN) ? new Response(null, { status: 307, headers: { location } }) : new Response("login", { status: 200 });
    }) as unknown as typeof fetch;
    const client = createClient({ origin: ORIGIN, bypassSecret: secret, fetchImpl, fence: { target: "staging", targetOrigin: ORIGIN, productionOrigin: "https://production.example.test" } });
    const res = await client.get("/api/auth/github");
    return { res, seen };
  }

  it("passes for the redirect the app sends, and the client sent no bypass header to github.com", async () => {
    const { res, seen } = await hopsFor(authorize());
    expect(authorizeViolations(res.hops, ORIGIN)).toEqual([]);
    expect(seen.map((s) => s.bypass)).toEqual([true, false]);
  });

  it.each([
    ["a wrong scope", { scope: "repo" }, "scope is not the documented one"],
    ["a missing client id", { client_id: "" }, "client_id is missing"],
    ["a state that is not random", { state: "fixed" }, "state is not a fresh random identifier"],
    ["a callback on another path", { redirect_uri: `${ORIGIN}/other` }, "redirect_uri is not the sign-in callback path"],
    ["a callback on another origin", { redirect_uri: "https://other.example.test/api/auth/github/callback" }, "redirect_uri is on a different origin than the host that issued the redirect"],
    ["an http callback", { redirect_uri: `http://staging.example.test/api/auth/github/callback` }, "redirect_uri is not https"],
  ])("reports %s", async (_name, over, message) => {
    const { res } = await hopsFor(authorize(over));
    expect(authorizeViolations(res.hops, ORIGIN)).toContain(message);
  });

  it("goes red when the bypass header reaches github.com (mutation: a hop list that says it did)", async () => {
    const { res } = await hopsFor(authorize());
    const leaked = res.hops.map((h) => (isGithubHost(h.url) ? { ...h, bypass: true } : h));
    expect(authorizeViolations(leaked, ORIGIN)).toContain("a request to another origin carried the bypass header");
  });

  it("goes red when the first hop carried no bypass header, or never reached github.com, or was not a redirect", async () => {
    const { res } = await hopsFor(authorize());
    expect(authorizeViolations(res.hops.map((h, i) => (i === 0 ? { ...h, bypass: false } : h)), ORIGIN).join()).toContain("did not carry the bypass header");
    expect(authorizeViolations([res.hops[0] as (typeof res.hops)[number]], ORIGIN)).toContain("the redirect never reached github.com");
    expect(authorizeViolations([{ url: `${ORIGIN}/api/auth/github`, status: 200, bypass: true }, ...res.hops.slice(1)], ORIGIN)).toContain("the sign-in path answered 200, not a redirect");
    expect(authorizeViolations([], ORIGIN)).toEqual(["the first request was not the sign-in path"]);
  });

  it("goes red when the bypass header reaches any hop off the target origin, not only github.com", async () => {
    const { res } = await hopsFor(authorize());
    const other = [...res.hops, { url: "https://elsewhere.example.test/x", status: 200, bypass: true }];
    expect(authorizeViolations(other, ORIGIN)).toContain("a request to another origin carried the bypass header");
  });

  it("matches github.com and its subdomains exactly, never a longer host", () => {
    expect(isGithubHost("https://github.com/x")).toBe(true);
    expect(isGithubHost("https://api.github.com/x")).toBe(true);
    expect(isGithubHost("https://github.com.evil.test/x")).toBe(false);
    expect(isGithubHost("https://notgithub.com/x")).toBe(false);
  });
});

// A1 cookie binding: the attributes the app's sign-in handler really sets (httpOnly, secure, sameSite lax, path /, maxAge 600).
describe("stateCookieViolations", () => {
  const STATE = "3f1c2a52-8d4b-4c63-9a0e-5b7d1e2f3a4b";
  const GOOD = `fx_oauth_state=${STATE}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=lax`;

  it("passes for the cookie the app sets (attribute names in any case, other cookies alongside)", () => {
    expect(stateCookieViolations([GOOD], STATE)).toEqual([]);
    expect(stateCookieViolations(["other=1; Path=/", GOOD], STATE)).toEqual([]);
    expect(stateCookieViolations([`fx_oauth_state=${STATE}; path=/; max-age=300; httponly; secure; samesite=Lax`], STATE)).toEqual([]);
  });

  it.each([
    ["no cookie at all", [], "no fx_oauth_state cookie was set"],
    ["only another cookie", ["session=abc; Path=/"], "no fx_oauth_state cookie was set"],
    ["a value that is not the state", [GOOD.replace(STATE, "00000000-0000-4000-8000-000000000000")], "the fx_oauth_state cookie value is not the state sent to GitHub"],
    ["no HttpOnly", [GOOD.replace("; HttpOnly", "")], "the fx_oauth_state cookie is not HttpOnly"],
    ["no Secure", [GOOD.replace("; Secure", "")], "the fx_oauth_state cookie is not Secure"],
    ["SameSite=None", [GOOD.replace("SameSite=lax", "SameSite=None")], "the fx_oauth_state cookie is not SameSite=Lax"],
    ["SameSite=Strict", [GOOD.replace("SameSite=lax", "SameSite=Strict")], "the fx_oauth_state cookie is not SameSite=Lax"],
    ["no SameSite", [GOOD.replace("; SameSite=lax", "")], "the fx_oauth_state cookie is not SameSite=Lax"],
    ["a narrower path", [GOOD.replace("Path=/", "Path=/api")], "the fx_oauth_state cookie is not Path=/"],
    ["a Domain attribute", [`${GOOD}; Domain=example.test`], "the fx_oauth_state cookie has a Domain attribute"],
    ["a Max-Age that is too long", [GOOD.replace("Max-Age=600", "Max-Age=601")], "the fx_oauth_state cookie Max-Age is over 600 seconds"],
    ["no Max-Age", [GOOD.replace("; Max-Age=600", "")], "the fx_oauth_state cookie has no Max-Age"],
  ])("reports %s", (_name, cookies, message) => {
    expect(stateCookieViolations(cookies, STATE)).toContain(message);
  });

  it("reports a redirect with no state, and never prints a value", () => {
    expect(stateCookieViolations([GOOD], "")).toContain("the redirect carried no state to bind the cookie to");
    expect(stateCookieViolations([GOOD.replace(STATE, "SECRETVALUE")], STATE).join()).not.toContain("SECRETVALUE");
  });

  it("goes red when the cookie is not HttpOnly (mutation: the rule must notice)", () => {
    const notHttpOnly = `fx_oauth_state=${STATE}; Path=/; Max-Age=600; Secure; SameSite=Lax`;
    expect(stateCookieViolations([notHttpOnly], STATE)).not.toEqual([]);
  });
});

describe("A7 signed-in shapes", () => {
  const me = { username: "someone", email: "a@b.test", is_admin: true, id: "Zm9vYmFyYmF6", storage_ns: "ns1", workspace_access: "open" };

  it("accepts the documented identity and names (not echoes) each problem", () => {
    expect(identityViolations(me, "owner")).toEqual([]);
    expect(identityViolations({ ...me, id: "1" }, "owner")).toEqual(["id is not an opaque identifier"]);
    expect(identityViolations({ ...me, id: "12345678" }, "owner")).toEqual(["id is not an opaque identifier"]);
    expect(identityViolations({ ...me, username: "" }, "owner")).toEqual(["username is not a non-empty string"]);
    expect(identityViolations({ ...me, is_admin: false }, "owner")).toEqual(["is_admin does not match the owner role"]);
    expect(identityViolations({ ...me, workspace_access: "weird" }, "owner")).toEqual(["workspace_access is not one of the documented values"]);
    expect(identityViolations({ ...me, extra: 1 }, "owner")[0]).toContain("unexpected fields");
    expect(identityViolations(null, "owner")).toEqual(["body is not an object"]);
    expect(JSON.stringify(identityViolations({ ...me, id: "1" }, "owner"))).not.toContain("a@b.test");
  });

  it("entitlements allow exactly when the workspace is open", () => {
    expect(entitlementsViolations({ entitlements: {}, default: "allow" }, "open")).toEqual([]);
    expect(entitlementsViolations({ entitlements: {}, default: "deny" }, "no_subscription")).toEqual([]);
    expect(entitlementsViolations({ entitlements: {}, default: "allow" }, "subscription_ended")).toEqual(["default is not deny for workspace_access subscription_ended"]);
    expect(entitlementsViolations({ entitlements: { x: 1 }, default: "allow" }, "open")).toEqual(["entitlements is not an empty map"]);
  });

  it("plans carry the published fields and the viewer's role", () => {
    const body = { plans: [{ id: "solo", price_usd_month: 20, repo_limit: 3 }], viewer: { is_owner: true, partner_billed: false } };
    expect(plansViolations(body, "owner")).toEqual([]);
    expect(plansViolations({ ...body, viewer: { is_owner: false, partner_billed: false } }, "owner")).toEqual(["viewer.is_owner does not match the owner role"]);
    expect(plansViolations({ ...body, plans: [] }, "owner")).toEqual(["plans is empty"]);
    expect(plansViolations({ ...body, plans: [{ id: "solo" }] }, "owner")).toEqual(["plans[0] lacks a numeric price_usd_month or repo_limit"]);
    expect(plansViolations({}, "owner")).toEqual(["body has no plans list"]);
  });
});

/** A value that satisfies a schema, built from its own type, enum and properties. */
function sample(schema: Schema | undefined): unknown {
  if (schema === undefined) return null;
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (schema.enum !== undefined) return schema.enum[0];
  switch (type) {
    case "object":
      return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, v]) => [k, sample(v)]));
    case "array":
      return [];
    case "boolean":
      return false;
    case "number":
    case "integer":
      return 1;
    case "null":
      return null;
    default:
      return "x";
  }
}

describe("api-contract rules, against the committed OpenAPI document", () => {
  const doc = JSON.parse(readFileSync(join(PACKAGE_ROOT, "..", "..", "packages", "api", "openapi.json"), "utf8")) as unknown;
  const ops = listGetOperations(doc);

  it("lists every documented GET with its statuses and JSON schema (so the sweep is not vacuous)", () => {
    expect(ops.length).toBeGreaterThanOrEqual(40);
    expect(ops.every((o) => o.template.startsWith("/api/v1/"))).toBe(true);
    expect(ops.every((o) => o.documented.includes(401))).toBe(true);
    const json = ops.filter((o) => o.json);
    expect(json.length).toBeGreaterThanOrEqual(40);
    expect(json.every((o) => o.okSchema !== undefined)).toBe(true);
    expect(ops.filter((o) => !o.json).map((o) => o.template)).toEqual(["/api/v1/runs/{id}/events/export"]);
    expect(ops.filter((o) => !o.hasPathParam && !o.hasRequiredQuery && o.json).length).toBeGreaterThanOrEqual(20);
  });

  it("every collection read that must answer 200 is documented and has no id", () => {
    for (const t of MUST_ANSWER_200) {
      const op = ops.find((o) => o.template === t);
      expect(op, t).toBeDefined();
      expect(op?.hasPathParam, t).toBe(false);
      expect(op?.documented, t).toContain(200);
    }
  });

  it("concretePath turns every id into the all-zero id the API's own id pattern accepts", () => {
    expect(concretePath("/api/v1/runs/{id}/events")).toBe(`/api/v1/runs/${ZERO_UUID}/events`);
    expect(concretePath("/api/v1/runs")).toBe("/api/v1/runs");
    for (const o of ops) expect(concretePath(o.template)).not.toContain("{");
    // The app's own id check, read from its source (packages/core/src/runs/read.ts) so the test cannot drift from it.
    const source = readFileSync(join(PACKAGE_ROOT, "..", "..", "packages", "core", "src", "runs", "read.ts"), "utf8");
    const found = /const UUID_RE = \/(.+)\/(i?);/.exec(source);
    if (found === null) throw new Error("the runs reader no longer declares UUID_RE; update this test");
    expect(new RegExp(found[1] as string, found[2]).test(ZERO_UUID)).toBe(true);
  });

  it("signed out: 401 with the envelope passes; any other status, a missing envelope field or a non-JSON body is named", () => {
    const op = ops.find((o) => o.template === "/api/v1/account");
    if (op === undefined) throw new Error("no account op");
    const good = JSON.stringify({ error: { code: "unauthenticated", message: "m", request_id: "r" } });
    expect(signedOutViolations(op, { status: 401, body: good })).toEqual([]);
    expect(signedOutViolations(op, { status: 200, body: "{}" })).toEqual(["getAccount: answered 200, expected 401"]);
    expect(signedOutViolations(op, { status: 401, body: JSON.stringify({ error: { code: "x", message: "m" } }) })).toEqual(["getAccount: error.request_id is not a non-empty string"]);
    expect(signedOutViolations(op, { status: 401, body: "<html>" })).toEqual(["getAccount: 401 body is not JSON"]);
  });

  it("signed in: a documented status and shape passes; a 5xx, an unlisted status, a wrong shape and a missing 200 are named", () => {
    const op = ops.find((o) => o.template === "/api/v1/account");
    if (op === undefined) throw new Error("no account op");
    const okSchema = op.okSchema as { required?: string[] };
    const required = okSchema.required ?? [];
    expect(required.length).toBeGreaterThan(0);
    const full = sample(op.okSchema) as Record<string, unknown>;
    expect(schemaViolations(op.okSchema, full)).toEqual([]);
    expect(signedInViolations(op, { status: 200, body: JSON.stringify(full) }, true)).toEqual([]);
    expect(signedInViolations(op, { status: 500, body: "{}" }, false)).toEqual(["getAccount: answered 500"]);
    expect(signedInViolations(op, { status: 418, body: "{}" }, false)).toEqual(["getAccount: answered 418, which the document does not list"]);
    expect(signedInViolations(op, { status: 404, body: JSON.stringify({ error: { code: "not_found", message: "m", request_id: "r" } }) }, true)).toEqual(["getAccount: answered 404, expected 200"]);
    expect(signedInViolations(op, { status: 404, body: JSON.stringify({ error: { code: "not_found", message: "m", request_id: "r" } }) }, false)).toEqual([]);
    expect(signedInViolations(op, { status: 404, body: "{}" }, false)).toEqual(["getAccount: body has no error object"]);
    const [first] = required;
    const missing = signedInViolations(op, { status: 200, body: JSON.stringify(Object.fromEntries(Object.entries(full).filter(([k]) => k !== first))) }, true);
    expect(missing).toEqual([`getAccount: $.${first}: missing`]);
  });

  it("a real list schema from the document checks the first items of a list and their enums and types", () => {
    const onboarding = ops.find((o) => o.template === "/api/v1/onboarding");
    if (onboarding === undefined) throw new Error("no onboarding op");
    const body = { started_at: "t", steps: [{ step: "model_key", completed_at: null, skipped: false }] };
    expect(schemaViolations(onboarding.okSchema, body)).toEqual([]);
    expect(schemaViolations(onboarding.okSchema, { ...body, steps: [{ step: "nope", completed_at: null, skipped: false }] })).toEqual(["$.steps[0].step: not one of the documented values"]);
    expect(schemaViolations(onboarding.okSchema, { ...body, steps: [{ step: "pay", completed_at: 3, skipped: false }] })).toEqual(["$.steps[0].completed_at: expected string or null"]);
    expect(schemaViolations(onboarding.okSchema, [])).toEqual(["$: expected object"]);
  });

  it("the error envelope check and the 429 wait", () => {
    expect(errorEnvelopeViolations({ error: { code: "c", message: "m", request_id: "r" } })).toEqual([]);
    expect(errorEnvelopeViolations({})).toEqual(["body has no error object"]);
    expect(retryDelayMs("3")).toBe(3000);
    expect(retryDelayMs("9999")).toBe(65_000);
    expect(retryDelayMs(null)).toBe(15_000);
    expect(retryDelayMs("x")).toBe(15_000);
  });

  it("listGetOperations refuses a document with no paths", () => {
    expect(() => listGetOperations({})).toThrow("no paths");
  });
});

describe("shell rules", () => {
  it("labels a URL without its query and clips long browser text", () => {
    expect(labelUrl("https://x.example.test/api/a?code=secret#frag")).toBe("https://x.example.test/api/a");
    expect(labelUrl("not a url")).toBe("(unparsable url)");
    expect(clip("a\n  b   c", 5)).toBe("a b c");
    expect(clip("x".repeat(300)).length).toBe(163);
    // Console text is masked, not only clipped: a URL keeps its origin and path and loses query and fragment.
    const masked = clip("Failed to load https://x.example.test/cb?code=SECRET123&state=abc#frag (net::ERR)");
    expect(masked).toBe("Failed to load https://x.example.test/cb (net::ERR)");
    expect(masked).not.toContain("SECRET123");
    expect(maskUrls("no url here")).toBe("no url here");
  });

  it("only a 4xx or 5xx on the target origin is a problem, and its query never reaches the report", () => {
    const origin = "https://x.example.test";
    expect(badStatusEvent(200, "GET", `${origin}/a`, origin)).toBeNull();
    expect(badStatusEvent(404, "GET", "https://elsewhere.example.test/a", origin)).toBeNull();
    expect(badStatusEvent(404, "GET", `${origin}/a?token=abc`, origin)).toEqual({ kind: "bad-status", detail: `404 GET ${origin}/a` });
    expect(badStatusEvent(500, "POST", `${origin}.evil.test/a`, origin)).toBeNull();
    expect(problemLines([{ kind: "console-error", detail: "boom" }])).toEqual(["console-error: boom"]);
  });

  it("W2: each access value has one right screen", () => {
    const all = ["onboarding", "model-key", "repos", "themes", "pipeline"];
    expect(accessViolations("open", { gate: false, desktop: true, dockApps: all })).toEqual([]);
    expect(accessViolations("open", { gate: true, desktop: false, dockApps: [] })).toEqual(["the subscription gate showed on an open workspace", "the desktop did not come up on an open workspace"]);
    expect(accessViolations("no_subscription", { gate: true, desktop: false, dockApps: [] })).toEqual([]);
    expect(accessViolations("no_subscription", { gate: false, desktop: true, dockApps: [...ONBOARDING_APPS] })).toEqual([]);
    expect(accessViolations("no_subscription", { gate: false, desktop: true, dockApps: all })).toEqual(["the dock holds apps outside onboarding: pipeline"]);
    expect(accessViolations("no_subscription", { gate: false, desktop: false, dockApps: [] })).toEqual(["neither the gate nor the desktop showed"]);
    expect(accessViolations("no_subscription", { gate: true, desktop: true, dockApps: [] }).join()).toContain("both the gate and the desktop showed");
    expect(accessViolations("subscription_ended", { gate: true, desktop: false, dockApps: [] })).toEqual([]);
    expect(accessViolations("subscription_ended", { gate: false, desktop: true, dockApps: all })).toEqual(["the gate did not show after the subscription ended", "the desktop came up after the subscription ended"]);
    expect(accessViolations("weird", { gate: true, desktop: false, dockApps: [] })).toEqual(["workspace_access weird is not a documented value"]);
  });

  it("the onboarding app list is the one the shell restricts to", () => {
    const text = readFileSync(join(PACKAGE_ROOT, "..", "workspace", "shell", "core", "onboarding-mode.js"), "utf8");
    const m = /ONBOARDING_APPS = Object\.freeze\(\[([^\]]*)\]\)/.exec(text);
    expect(m).not.toBeNull();
    expect((m?.[1] ?? "").split(",").map((s) => s.trim().replace(/"/g, ""))).toEqual([...ONBOARDING_APPS]);
  });
});
