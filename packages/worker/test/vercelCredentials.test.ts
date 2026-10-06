import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import type { SdkCreateParams, SdkSandbox, VercelSandboxSdk } from "@fx/runner";
import { buildWorker } from "../src/compositionRoot.js";
import type { WorkerPools } from "../src/pools.js";
import { MARGIN_SECONDS, MAX_INVOCATION_SECONDS, MIN_REMAINING_SECONDS, SDK_REFRESH_BUFFER_SECONDS, productionVercelCredentials, VercelCredentialsUnavailableError } from "../src/vercelCredentials.js";
import { RUNNER_LOGIN_NAME } from "./support/scanRunnerLoginReaders.js";

const TEAM = "team_fixture";
const PROJECT = "prj_fixture";
const ENV = { VERCEL_TEAM_ID: TEAM, VERCEL_PROJECT_ID: PROJECT };
const NOT_CONFIGURED = "worker: Vercel credentials are not configured";
const NO_TOKEN = "worker: no usable Vercel OIDC token in this invocation";
const NOW = 1_800_000_000_000;
const NOW_S = NOW / 1000;

function jwt(claims: Record<string, unknown>, marker = "m"): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ ...claims, marker })}.c2lnbmF0dXJl`;
}
const goodClaims = { owner_id: TEAM, project_id: PROJECT, exp: NOW_S + 3600 };

type Headers = Record<string, string | string[] | undefined>;
/** A request context the test swaps between calls, as two invocations sharing one worker would see. */
function contexts() {
  const state: { current: { headers?: Headers } | undefined } = { current: undefined };
  return { state, deps: { getContext: () => state.current, now: () => NOW } };
}
const withToken = (token: string | undefined) => ({ headers: { "x-vercel-oidc-token": token } });

describe("P2: missing or blank ids fail closed, with a fixed message that holds no value", () => {
  const SENTINEL = "sentinel-id-value-7781";
  const cases: [string, Record<string, string | undefined>][] = [
    ["no team id", { VERCEL_PROJECT_ID: SENTINEL }],
    ["empty team id", { VERCEL_TEAM_ID: "", VERCEL_PROJECT_ID: SENTINEL }],
    ["whitespace team id", { VERCEL_TEAM_ID: " \t ", VERCEL_PROJECT_ID: SENTINEL }],
    ["no project id", { VERCEL_TEAM_ID: SENTINEL }],
    ["empty project id", { VERCEL_TEAM_ID: SENTINEL, VERCEL_PROJECT_ID: "" }],
    ["whitespace project id", { VERCEL_TEAM_ID: SENTINEL, VERCEL_PROJECT_ID: "  " }],
  ];
  for (const [name, env] of cases) {
    it(name, () => {
      let error: unknown;
      try {
        productionVercelCredentials(env);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(VercelCredentialsUnavailableError);
      expect((error as Error).message).toBe(NOT_CONFIGURED);
      expect((error as Error).message).not.toContain(SENTINEL);
    });
  }

  it("takes the ids from the named variables", () => {
    const creds = productionVercelCredentials({ VERCEL_TEAM_ID: ` ${TEAM} `, VERCEL_PROJECT_ID: PROJECT });
    expect([creds.teamId, creds.projectId]).toEqual([TEAM, PROJECT]);
  });
});

describe("P3: the token is the current invocation's own, read on every call", () => {
  it("returns the header token when its claims match and it expires more than the floor ahead", async () => {
    const { state, deps } = contexts();
    const token = jwt({ ...goodClaims, exp: NOW_S + MIN_REMAINING_SECONDS + 1 });
    state.current = withToken(token);
    await expect(productionVercelCredentials(ENV, deps).getToken()).resolves.toBe(token);
  });

  it("two contexts, one credentials object: each call returns its own context's token (nothing is cached)", async () => {
    const { state, deps } = contexts();
    const creds = productionVercelCredentials(ENV, deps);
    const a = jwt(goodClaims, "a");
    const b = jwt(goodClaims, "b");
    state.current = withToken(a);
    expect(await creds.getToken()).toBe(a);
    state.current = withToken(b);
    expect(await creds.getToken()).toBe(b);
    state.current = withToken(undefined);
    await expect(creds.getToken()).rejects.toThrow(NO_TOKEN);
  });
});

describe("P4: anything but a matching, unexpired header token is refused with a fixed error", () => {
  const TOKEN_TEXT = "secret-token-text-4412";
  const cases: [string, { headers?: Headers } | undefined][] = [
    ["no context", undefined],
    ["an empty context", {}],
    ["no header", { headers: {} }],
    ["an empty header", withToken("")],
    ["a header array", { headers: { "x-vercel-oidc-token": [jwt(goodClaims)] } }],
    ["a non-JWT", withToken(TOKEN_TEXT)],
    ["a JWT whose payload is not JSON", withToken(`a.${Buffer.from(TOKEN_TEXT).toString("base64url")}.c`)],
    ["a different team", withToken(jwt({ ...goodClaims, owner_id: "team_other" }, TOKEN_TEXT))],
    ["a different project", withToken(jwt({ ...goodClaims, project_id: "prj_other" }, TOKEN_TEXT))],
    ["no team claim", withToken(jwt({ project_id: PROJECT, exp: NOW_S + 3600 }, TOKEN_TEXT))],
    ["no expiry claim", withToken(jwt({ owner_id: TEAM, project_id: PROJECT }, TOKEN_TEXT))],
    ["a string expiry", withToken(jwt({ ...goodClaims, exp: String(NOW_S + 3600) }, TOKEN_TEXT))],
    ["an expired token", withToken(jwt({ ...goodClaims, exp: NOW_S - 1 }, TOKEN_TEXT))],
    ["a token expiring in exactly the floor", withToken(jwt({ ...goodClaims, exp: NOW_S + MIN_REMAINING_SECONDS }, TOKEN_TEXT))],
    ["a token with 331 s left (the previous floor)", withToken(jwt({ ...goodClaims, exp: NOW_S + 331 }, TOKEN_TEXT))],
    ["a token with 301 s left (past the SDK's 300 s refresh buffer)", withToken(jwt({ ...goodClaims, exp: NOW_S + 301 }, TOKEN_TEXT))],
    ["a token with 61 s left", withToken(jwt({ ...goodClaims, exp: NOW_S + 61 }, TOKEN_TEXT))],
    ["a token expiring in 30 s", withToken(jwt({ ...goodClaims, exp: NOW_S + 30 }, TOKEN_TEXT))],
  ];
  for (const [name, context] of cases) {
    it(name, async () => {
      const { state, deps } = contexts();
      state.current = context;
      const error = await productionVercelCredentials(ENV, deps).getToken().then(() => undefined, (e: unknown) => e);
      expect(error).toBeInstanceOf(VercelCredentialsUnavailableError);
      expect((error as Error).message).toBe(NO_TOKEN);
      expect(String((error as Error).stack)).not.toContain(TOKEN_TEXT);
    });
  }
});

describe("the expiry floor stays above the SDK's own refresh buffer", () => {
  it("is greater than expirationBufferMs in the installed @vercel/sandbox (whose refresh path uses the CLI login)", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sdk = readFileSync(path.join(here, "..", "..", "runner", "node_modules", "@vercel", "sandbox", "dist", "api-client", "api-client.js"), "utf8");
    const match = /expirationBufferMs:\s*(\d+)\s*\*\s*1e3/.exec(sdk);
    expect(match, "the SDK's buffer literal moved; re-measure it").not.toBeNull();
    expect(MIN_REMAINING_SECONDS).toBeGreaterThan(Number(match![1]));
  });
});

describe("the floor covers how long one invocation can keep using the token", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const apiDir = path.join(here, "..", "..", "..", "apps", "web", "app", "api");
  const routes = (readdirSync(apiDir, { recursive: true, encoding: "utf8" }) as string[]).filter((f) => /(^|\/)route\.ts$/.test(f));

  it("is the SDK buffer plus the longest invocation plus a margin", () => {
    expect(MIN_REMAINING_SECONDS).toBe(SDK_REFRESH_BUFFER_SECONDS + MAX_INVOCATION_SECONDS + MARGIN_SECONDS);
    expect(MIN_REMAINING_SECONDS).toBe(1160);
  });

  it("every route's maxDuration export, plus the SDK buffer, fits under the floor", () => {
    const durations = routes.flatMap((f) => {
      const m = /export const maxDuration\s*=\s*(\d+)/.exec(readFileSync(path.join(apiDir, f), "utf8"));
      return m ? [[f, Number(m[1])] as const] : [];
    });
    expect(durations.length).toBeGreaterThanOrEqual(3);
    for (const [f, seconds] of durations) expect(seconds + SDK_REFRESH_BUFFER_SECONDS, f).toBeLessThanOrEqual(MIN_REMAINING_SECONDS);
    expect(MAX_INVOCATION_SECONDS).toBeGreaterThanOrEqual(Math.max(...durations.map(([, s]) => s)));
  });

  it("no route sets a maxDuration the scan cannot read as a number", () => {
    for (const f of routes) {
      const src = readFileSync(path.join(apiDir, f), "utf8");
      if (/export const maxDuration/.test(src)) expect(/export const maxDuration\s*=\s*\d+/.test(src), f).toBe(true);
    }
  });
});

describe("P5: there is no environment fallback and no refresh", () => {
  const KEY = Symbol.for("@vercel/request-context");
  const holder = globalThis as unknown as Record<symbol, unknown>;
  const saved = process.env.VERCEL_OIDC_TOKEN;
  afterEach(() => {
    delete holder[KEY];
    if (saved === undefined) delete process.env.VERCEL_OIDC_TOKEN;
    else process.env.VERCEL_OIDC_TOKEN = saved;
  });

  it("a valid-looking VERCEL_OIDC_TOKEN and no header still rejects (the real @vercel/oidc context reader)", async () => {
    process.env.VERCEL_OIDC_TOKEN = jwt({ ...goodClaims, exp: Date.now() / 1000 + 3600 });
    const creds = productionVercelCredentials(ENV);
    await expect(creds.getToken()).rejects.toThrow(NO_TOKEN);
    holder[KEY] = { get: () => ({ headers: {} }) };
    await expect(creds.getToken()).rejects.toThrow(NO_TOKEN);
  });

  it("the real @vercel/oidc context reader does find the header of a registered request context", async () => {
    const token = jwt({ ...goodClaims, exp: Date.now() / 1000 + 3600 });
    holder[KEY] = { get: () => ({ headers: { "x-vercel-oidc-token": token } }) };
    await expect(productionVercelCredentials(ENV).getToken()).resolves.toBe(token);
  });

  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "vercelCredentials.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("the source never calls the library's token getters (the refresh path reads the Vercel CLI login)", () => {
    expect(code).not.toMatch(/getVercelOidcToken|getVercelToken|refreshToken/);
    expect(code).not.toContain("VERCEL_OIDC_TOKEN");
    expect(code.match(/from "@vercel\/oidc"/g)).toHaveLength(1);
    expect(code).toContain('import { getContext } from "@vercel/oidc"');
  });

  it("P7: it reads two named keys, never enumerates env and never touches process.env", () => {
    expect(code).not.toMatch(/process\.env/);
    expect(code).not.toMatch(/Object\.(keys|entries|values|assign)\(|for\s*\(.*\b(in|of)\b.*env|\.\.\.\s*env/);
    expect([...code.matchAll(/\benv\.([A-Z_]+)/g)].map((m) => m[1]).sort()).toEqual(["VERCEL_PROJECT_ID", "VERCEL_TEAM_ID"]);
  });

  it("P8: it does not name the runner login", () => {
    expect(source).not.toContain(RUNNER_LOGIN_NAME);
  });
});

describe("P6: the builder feeds the worker's real sandbox port", () => {
  function fakes() {
    const gets: { teamId: string; projectId: string; token: string; name: string }[] = [];
    const created: SdkCreateParams[] = [];
    const sandbox = (name: string): SdkSandbox => ({ name, stop: async () => undefined }) as unknown as SdkSandbox;
    const sdk: VercelSandboxSdk = {
      async create(params) {
        created.push(params);
        return sandbox(params.name);
      },
      async get(params) {
        gets.push({ teamId: params.teamId, projectId: params.projectId, token: params.token, name: params.name });
        return sandbox(params.name);
      },
    };
    const pools: WorkerPools = { runnerPool: {} as Pool, platformOpsPool: {} as Pool, close: async () => {} };
    return { sdk, gets, created, pools };
  }
  const base = { env: { FX_GH_FORWARD_SUFFIX: "fixture.test", FX_GH_FORWARD_HOST: "gh-proxy.fixture.test" } };
  const ports = {
    decryptTenantKey: async () => "k",
    modelConnection: { get: async () => { throw new Error("unused"); } },
    connectionStatus: { markBroken: async () => {} },
    hooks: { resume: async () => {} },
  };

  it("a stop() call reaches the SDK with the ids from the env and the header token of that call's context", async () => {
    const { state, deps } = contexts();
    const { sdk, gets, pools } = fakes();
    const worker = await buildWorker({ ...base, sdk, ports, createPools: async () => pools, vercel: productionVercelCredentials(ENV, deps) });
    const first = jwt(goodClaims, "first");
    const second = jwt(goodClaims, "second");
    state.current = withToken(first);
    await worker.sandboxPort.stop({ sandboxName: "rn-1-r1" } as never);
    state.current = withToken(second);
    await worker.sandboxPort.stop({ sandboxName: "rn-1-r1" } as never);
    expect(gets).toEqual([
      { teamId: TEAM, projectId: PROJECT, token: first, name: "rn-1-r1" },
      { teamId: TEAM, projectId: PROJECT, token: second, name: "rn-1-r1" },
    ]);
  });

  it("with no usable token the SDK is never reached and the failure carries no token text", async () => {
    const { state, deps } = contexts();
    const { sdk, gets, pools } = fakes();
    const worker = await buildWorker({ ...base, sdk, ports, createPools: async () => pools, vercel: productionVercelCredentials(ENV, deps) });
    state.current = withToken(jwt({ ...goodClaims, owner_id: "team_other" }, "leak-check-9921"));
    const error = await worker.sandboxPort.stop({ sandboxName: "rn-1-r1" } as never).then(() => undefined, (e: unknown) => e);
    expect(error).toMatchObject({ name: "SandboxPortError" });
    expect(String((error as Error).stack) + (error as Error).message).not.toContain("leak-check-9921");
    expect(gets).toEqual([]);
  });
});
