import { describe, expect, it } from "vitest";
import { emptyFakeState, type FakeState } from "@fx/hetzner";
import { completeEnv } from "../../../../../test/support/envFixtures";
import { healthResponse } from "../../../health/handler";
import { FakeProviderStateFull } from "@fx/db/src/fakeProviderState";
import { MAX_BODY_BYTES, fakeHetznerHandler, type FakeRouteDeps } from "./handler";

const BASE = "https://staging.example/api/_fake/hetzner/v1";
const AUTH = { authorization: "Bearer fxtest-token-0123456789" };
const store = (env: FakeRouteDeps["env"]): FakeRouteDeps & { calls: number } => {
  const state: FakeState = emptyFakeState();
  const deps = { env, calls: 0, run: async <T,>(fn: (s: FakeState) => T): Promise<T> => { deps.calls++; return fn(state); } };
  return deps;
};
const call = (deps: FakeRouteDeps, path: string, init: RequestInit = {}) => fakeHetznerHandler(new Request(`${BASE}${path}`, { headers: AUTH, ...init }), deps);
const post = (deps: FakeRouteDeps, path: string, body: unknown) => call(deps, path, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("/api/_fake/hetzner (D#845 MC-13a)", () => {
  it("answers 404 in production, with the switch on or off, and never touches the store", async () => {
    for (const env of [{ FX_DEPLOY_KIND: "production", FX_MACHINE_PROVIDER_FAKE: "1" }, { FX_MACHINE_PROVIDER_FAKE: "1" }, { FX_DEPLOY_KIND: "staging" }, { VERCEL_ENV: "production" }, {}]) {
      const deps = store(env);
      const res = await call(deps, "/servers");
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: "not_found", message: "not found" } });
      expect((await post(deps, "/servers", { name: "x" })).status).toBe(404);
      expect(deps.calls).toBe(0);
    }
  });

  it("serves the contract when allowed: create, list by label, error bodies, auth", async () => {
    const deps = store({ FX_MACHINE_PROVIDER_FAKE: "1", FX_DEPLOY_KIND: "staging", VERCEL_ENV: "production" });
    const body = { name: "s1", server_type: "cx22", location: "fsn1", image: "ubuntu-24.04", labels: { a: "b" } };
    const made = await post(deps, "/servers", body);
    expect(made.status).toBe(201);
    expect((await (await call(deps, "/servers?label_selector=a%3Db")).json() as { servers: unknown[] }).servers).toHaveLength(1);
    const dup = await post(deps, "/servers", body);
    expect([dup.status, ((await dup.json()) as { error: { code: string } }).error.code]).toEqual([409, "uniqueness_error"]);
    expect((await post(deps, "/servers", { ...body, name: "s2", bogus: 1 })).status).toBe(422);
    expect((await call(deps, "/servers/999")).status).toBe(404);
    expect((await fakeHetznerHandler(new Request(`${BASE}/servers`), deps)).status).toBe(401);
    expect((await call(deps, "/servers", { headers: { authorization: `Bearer ${"a".repeat(64)}` } })).status).toBe(401);
    const noJson = await call(deps, "/servers", { method: "POST", headers: AUTH, body: "{}" });
    expect([noJson.status, ((await noJson.json()) as { error: { code: string } }).error.code]).toEqual([400, "json_error"]);
  });
});

describe("/api/_fake/hetzner: bounds", () => {
  const ON = { FX_MACHINE_PROVIDER_FAKE: "1", FX_DEPLOY_KIND: "staging" };

  it("checks the bearer before the store is opened: a 401 costs no connection and no lock", async () => {
    const deps = store(ON);
    for (const headers of [{}, { authorization: "Bearer " }, { authorization: "Basic abc" }, { authorization: `Bearer ${"a".repeat(64)}` }]) {
      expect((await fakeHetznerHandler(new Request(`${BASE}/servers`, { headers }), deps)).status).toBe(401);
      expect((await fakeHetznerHandler(new Request(`${BASE}/servers`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" }), deps)).status).toBe(401);
    }
    expect(deps.calls).toBe(0);
  });

  it("refuses a body over 64 KiB with 413 before parsing it, and takes one at the limit", async () => {
    const deps = store(ON);
    const big = JSON.stringify({ name: "x", pad: "a".repeat(MAX_BODY_BYTES) });
    const res = await post(deps, "/servers", JSON.parse(big));
    expect([res.status, ((await res.json()) as { error: { code: string } }).error.code]).toEqual([413, "request_entity_too_large"]);
    const declared = await call(deps, "/servers", { method: "POST", headers: { ...AUTH, "content-type": "application/json", "content-length": String(MAX_BODY_BYTES + 1) }, body: "{}" });
    expect(declared.status).toBe(413);
    expect(deps.calls).toBe(0);
    expect((await post(deps, "/servers", { name: "ok", server_type: "cx22", location: "fsn1", image: "ubuntu-24.04" })).status).toBe(201);
  });

  it("answers 403 resource_limit_exceeded, not 500, when the stored document is at its size limit", async () => {
    const deps = { ...store(ON), run: async () => { throw new FakeProviderStateFull("full"); } };
    const res = await post(deps, "/servers", { name: "x", server_type: "cx22", location: "fsn1", image: "ubuntu-24.04" });
    expect([res.status, ((await res.json()) as { error: { code: string } }).error.code]).toEqual([403, "resource_limit_exceeded"]);
    const broken = { ...store(ON), run: async () => { throw new Error("db down"); } };
    expect((await call(broken, "/servers")).status).toBe(500);
  });
});

describe("/api/health and the fake provider switch", () => {
  const OPERATOR = "operator-secret-0123456789-abcdefghij";
  const detail = async (env: Record<string, string | undefined>) => ((await healthResponse(env, `Bearer ${OPERATOR}`).json()) as { unconfigured: string[] }).unconfigured;

  it("names fake_provider_in_production for the operator when the variable is set off staging (an unset kind included), and only then", async () => {
    const base = { ...completeEnv("production"), CRON_SECRET: OPERATOR };
    const named = "fake_provider_in_production";
    expect(await detail({ ...base, FX_DEPLOY_KIND: "production", FX_MACHINE_PROVIDER_FAKE: "1" })).toContain(named);
    expect(await detail({ ...base, FX_DEPLOY_KIND: undefined, FX_MACHINE_PROVIDER_FAKE: "1" })).toContain(named);
    expect(await detail(base)).not.toContain(named);
    expect(await detail({ ...base, FX_DEPLOY_KIND: "staging", VERCEL_ENV: "production", FX_MACHINE_PROVIDER_FAKE: "1" })).not.toContain(named);
    expect(JSON.stringify(await healthResponse({ ...base, FX_MACHINE_PROVIDER_FAKE: "1" }, null).json())).not.toContain("fake_provider");
  });
});
