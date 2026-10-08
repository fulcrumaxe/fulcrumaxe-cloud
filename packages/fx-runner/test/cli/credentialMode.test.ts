import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KEY_FILE, REGISTRATION_FILE } from "../../src/config.js";
import { CODE, useRig } from "./harness.js";

/** D#6 C20 section 1: the local credential mode comes from the cloud's reply, and a mismatch is undone. */
const rig = useRig();
const stateFiles = (): string[] => (existsSync(rig.dir) ? readdirSync(rig.dir).sort() : []);
const ARGV = (): string[] => ["register", "--code", CODE, "--credential-mode", "subscription", "--cloud-url", rig.cloud.origin];
const RUNNER = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e";
const ACCOUNT = "6b1e2f30-1a2b-4c3d-8e4f-5a6b7c8d9e0f";

/** A fetch that answers every call with `status` and `body`, and counts the calls. */
function canned(status: number, body: unknown): { fetchFn: typeof fetch; calls: () => number } {
  let n = 0;
  const fetchFn = (async () => {
    n += 1;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchFn, calls: () => n };
}

describe("a reply whose mode matches", () => {
  it("writes the registration with the account and the mode the cloud reported", async () => {
    for (const mode of ["subscription", "api_key"] as const) {
      const result = await rig.register(mode);
      expect(result.code, mode).toBe(0);
      const saved = JSON.parse(readFileSync(path.join(rig.dir, REGISTRATION_FILE), "utf8")) as Record<string, string>;
      expect(saved.credential_mode, mode).toBe(mode);
      expect(saved.account_id).toBe(rig.cloud.accountId);
      expect(saved.runner_id).toBe([...rig.cloud.runners.values()].at(-1)!.runnerId);
      expect((await rig.run(["status"])).out).toContain(`Account:         ${rig.cloud.accountId}`);
      await rig.run(["revoke", "--local"]);
      rig.cloud.validCodes.add(CODE);
    }
  });
});

describe("a reply whose mode differs from --credential-mode", () => {
  for (const [flag, server] of [["subscription", "api_key"], ["api_key", "subscription"]] as const) {
    it(`flag ${flag} against a ${server} code: one signed self-revoke, nothing written, non-zero exit`, async () => {
      const result = await rig.register(flag, server);
      expect(result.code).not.toBe(0);
      expect(result.err).toContain(`This code was made for ${server} runners, not ${flag}. Ask an owner or admin for a new code.`);
      expect(result.out).toBe("");
      // zero files: no key, no registration (the state directory may exist, empty)
      expect(stateFiles()).toEqual([]);
      // exactly the registration and one revoke, the revoke signed by the key the registration used
      expect(rig.cloud.seen.map((r) => r.path)).toEqual(["/api/runner/register", "/api/runner/revoke"]);
      const revoke = rig.cloud.seen[1]!;
      expect(revoke.headers["signature-input"]).toMatch(/keyid="[A-Za-z0-9_-]{43}"/);
      expect(JSON.parse(revoke.body)).toEqual({ reason: "credential mode did not match the registration code" });
      expect([...rig.cloud.runners.values()].map((r) => r.revoked)).toEqual([true]);
      expect(result.err).not.toContain(CODE);
      // the code was spent, so the user's next try needs a new one, and a machine with no registration may try again
      rig.cloud.validCodes.add(CODE);
      expect((await rig.register(flag, flag)).code).toBe(0);
    });
  }

  it("when the self-revoke is refused it still writes nothing, and prints the runner id so an owner can revoke it", async () => {
    rig.cloud.force.push("key_too_old"); // the revoke (not the register) is the request that gets this refusal
    const result = await rig.register("subscription", "api_key");
    expect(result.code).not.toBe(0);
    expect(stateFiles()).toEqual([]);
    const runnerId = [...rig.cloud.runners.values()][0]!.runnerId;
    expect(result.err).toContain("This code was made for api_key runners, not subscription.");
    expect(result.err).toContain(runnerId);
    expect(result.err).toContain("runner screen");
    expect([...rig.cloud.runners.values()][0]!.revoked).toBe(false);
  });

  it("when the self-revoke cannot reach the cloud it still writes nothing, and prints the runner id", async () => {
    rig.cloud.codeModes.set(CODE, "api_key");
    let calls = 0;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls > 1) throw new TypeError("offline");
      return fetch(input, init);
    }) as typeof fetch;
    const result = await rig.run(ARGV(), { fetchFn });
    expect(result.code).not.toBe(0);
    expect(stateFiles()).toEqual([]);
    expect(calls).toBe(2);
    expect(result.err).toContain([...rig.cloud.runners.values()][0]!.runnerId);
  });
});

/** The real stand-in cloud, except that the registration reply goes through `reshape` on its way back. */
function reshaping(reshape: (body: Record<string, unknown>) => unknown): { fetchFn: typeof fetch; paths: string[] } {
  const paths: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    paths.push(url.pathname);
    const real = await fetch(input, init);
    if (url.pathname !== "/api/runner/register") return real;
    return new Response(JSON.stringify(reshape((await real.json()) as Record<string, unknown>)), { status: real.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchFn, paths };
}

describe("a reply that does not parse as the protocol's RegisterResponse", () => {
  const good = { runner_id: RUNNER, account_id: ACCOUNT, credential_mode: "subscription" };
  const bads: Array<[string, unknown]> = [
    ["no runner_id", { account_id: ACCOUNT, credential_mode: "subscription" }],
    ["a runner_id that is not a uuid", { runner_id: "runner-1", account_id: ACCOUNT, credential_mode: "subscription" }],
    ["a runner_id that is not a string", { runner_id: 7, account_id: ACCOUNT, credential_mode: "subscription" }],
    ["not an object", [good]],
  ];
  for (const [name, reply] of bads) {
    it(`${name}: refused, nothing written, no revoke is sent`, async () => {
      const { fetchFn, calls } = canned(201, reply);
      const result = await rig.run(ARGV(), { fetchFn });
      expect(result.code).toBe(1);
      expect(result.err).toContain("the cloud's reply was not understood");
      expect(result.err).not.toContain("runner screen");
      expect(stateFiles()).toEqual([]);
      expect(calls()).toBe(1);
    });
  }

  const shapes: Array<[string, (body: Record<string, unknown>) => unknown]> = [
    ["no account_id", ({ account_id: _a, ...rest }) => rest],
    ["no credential_mode", ({ credential_mode: _m, ...rest }) => rest],
    ["only runner_id (the reply of a cloud before the mode was added)", ({ runner_id }) => ({ runner_id })],
    ["a mode that is not one of the two", (body) => ({ ...body, credential_mode: "both" })],
    ["an account that is not a uuid", (body) => ({ ...body, account_id: "acct" })],
    ["an extra member", (body) => ({ ...body, extra: 1 })],
  ];
  for (const [name, reshape] of shapes) {
    it(`${name}, with a runner_id: one signed self-revoke, the runner is revoked, nothing written, non-zero exit`, async () => {
      rig.cloud.codeModes.set(CODE, "subscription");
      const { fetchFn, paths } = reshaping(reshape);
      const result = await rig.run(ARGV(), { fetchFn });
      expect(result.code).toBe(1);
      expect(result.err).toContain("the cloud's reply was not understood");
      expect(result.err).not.toContain("runner screen"); // the revoke worked, so there is nothing left to do by hand
      expect(result.out).toBe("");
      expect(stateFiles()).toEqual([]);
      expect(paths).toEqual(["/api/runner/register", "/api/runner/revoke"]);
      expect(rig.cloud.seen.map((r) => r.path)).toEqual(["/api/runner/register", "/api/runner/revoke"]);
      const revoke = rig.cloud.seen[1]!;
      expect(revoke.headers["signature-input"]).toMatch(/keyid="[A-Za-z0-9_-]{43}"/);
      expect(JSON.parse(revoke.body)).toEqual({ reason: "the registration reply was not understood" });
      expect([...rig.cloud.runners.values()].map((r) => r.revoked)).toEqual([true]);
    });
  }

  it("when that revoke is refused, nothing is written and the runner id and the runner screen are named", async () => {
    rig.cloud.codeModes.set(CODE, "subscription");
    rig.cloud.force.push("key_too_old"); // the revoke (not the register) is the request that gets this refusal
    const { fetchFn } = reshaping(({ runner_id }) => ({ runner_id }));
    const result = await rig.run(ARGV(), { fetchFn });
    const runner = [...rig.cloud.runners.values()][0]!;
    expect(result.code).toBe(1);
    expect(stateFiles()).toEqual([]);
    expect(result.err).toContain(runner.runnerId);
    expect(result.err).toContain("runner screen");
    expect(runner.revoked).toBe(false);
  });

  it("when that revoke cannot reach the cloud, nothing is written and the runner id and the runner screen are named", async () => {
    rig.cloud.codeModes.set(CODE, "subscription");
    const inner = reshaping(({ runner_id }) => ({ runner_id })).fetchFn;
    let calls = 0;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls > 1) throw new TypeError("offline");
      return inner(input, init);
    }) as typeof fetch;
    const result = await rig.run(ARGV(), { fetchFn });
    expect(result.code).toBe(1);
    expect(stateFiles()).toEqual([]);
    expect(calls).toBe(2);
    expect(result.err).toContain([...rig.cloud.runners.values()][0]!.runnerId);
    expect(result.err).toContain("runner screen");
  });

  it("a good reply from a stand-in cloud is accepted and saved (the stand-ins above fail only for their shape)", async () => {
    const { fetchFn } = canned(201, good);
    const result = await rig.run(ARGV(), { fetchFn });
    expect(result.code).toBe(0);
    expect(stateFiles()).toEqual([REGISTRATION_FILE, KEY_FILE].sort());
    expect(JSON.parse(readFileSync(path.join(rig.dir, REGISTRATION_FILE), "utf8"))).toMatchObject({ runner_id: RUNNER, account_id: ACCOUNT, credential_mode: "subscription" });
  });
});
