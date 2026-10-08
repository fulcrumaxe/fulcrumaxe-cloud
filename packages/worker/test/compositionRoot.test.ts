import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  SWEEP_RUN_WORST_CASE_MS,
  SWEEP_TIME_BUDGET_MS,
  UnknownExecutionModeError,
  resolveExecutionTarget,
  type ExecutionRun,
  type SdkCreateParams,
  type SdkSandbox,
  type VercelSandboxSdk,
} from "@fx/runner";
import { buildWorker, createWorker, assertWorkdirAllowed, type BuildWorkerOptions, type WorkerPorts } from "../src/compositionRoot.js";
import { StartupGuardError, type WorkerPools } from "../src/pools.js";

const FORWARD_ENV = { FX_GH_FORWARD_SUFFIX: "fixture.test", FX_GH_FORWARD_HOST: "gh-proxy.fixture.test" };

const ports: WorkerPorts = {
  decryptTenantKey: async () => "fake-key",
  modelConnection: { get: async () => { throw new Error("not used"); } },
  connectionStatus: { markBroken: async () => {} },
  hooks: { resume: async () => {} },
};

function fakePools(): WorkerPools & { closed: number } {
  const state = { closed: 0 };
  return {
    runnerPool: { tag: "runner" } as unknown as Pool,
    platformOpsPool: { tag: "ops" } as unknown as Pool,
    async close() {
      state.closed++;
    },
    get closed() {
      return state.closed;
    },
  };
}

function sdkFake(): { sdk: VercelSandboxSdk; created: SdkCreateParams[] } {
  const created: SdkCreateParams[] = [];
  const sandbox = (name: string): SdkSandbox => ({ name, currentSession: () => ({ sessionId: "sess-1" }) }) as unknown as SdkSandbox;
  return {
    created,
    sdk: {
      async create(params) {
        created.push(params);
        return sandbox(params.name);
      },
      async get(params) {
        return sandbox(params.name);
      },
    },
  };
}

function options(over: Partial<BuildWorkerOptions> = {}): BuildWorkerOptions {
  return {
    env: FORWARD_ENV,
    vercel: { teamId: "team_1", projectId: "prj_1", getToken: async () => "tok" },
    ports,
    createPools: async () => fakePools(),
    ...over,
  };
}

const RUN = { id: "r1", accountId: "a1", role: "executor", product: "team" } as unknown as ExecutionRun;

describe("buildWorker (C15 / C26 / C59 §5)", () => {
  it("builds the production registry: the 'sandbox' and 'runner_local' targets, resolvable, nothing else", async () => {
    const worker = await buildWorker(options());
    expect(Object.keys(worker.registry)).toEqual(["sandbox", "runner_local"]);
    expect(resolveExecutionTarget("sandbox", worker.registry).runtime).toBe("production");
    expect(resolveExecutionTarget("runner_local", worker.registry).runtime).toBe("runner");
    expect(() => resolveExecutionTarget("runner", worker.registry)).toThrow(UnknownExecutionModeError);
    expect(() => resolveExecutionTarget("runner_verified", worker.registry)).toThrow(UnknownExecutionModeError);
    expect(Object.isFrozen(worker.registry)).toBe(true);
  });

  it("D#6 R3a: the runner target is built from the injected ports, and without them it fails closed", async () => {
    const issued: string[] = [];
    const wired = await buildWorker(
      options({
        ports: { ...ports, jobIssuer: { issue: async ({ run }) => void issued.push(run.id) }, repoVisibility: { visibility: async () => "private" } },
      }),
    );
    expect(await resolveExecutionTarget("runner_local", wired.registry).dispatch(RUN)).toEqual({ queued: true });
    expect(issued).toEqual(["r1"]);

    // No issuer wired: a dispatch fails rather than report a run queued with no job behind it. No visibility port wired:
    // admit would read every repo as unknown (that needs the pool, which this test's fake pools do not have).
    const bare = await buildWorker(options());
    await expect(resolveExecutionTarget("runner_local", bare.registry).dispatch(RUN)).rejects.toThrow(/no job issuer is wired/);
    expect(await resolveExecutionTarget("runner_local", bare.registry).cancel(RUN)).toEqual({ settled_usd: 0, released_usd: 0 });
  });

  it("D#6 R3b: with the job-signing key in the environment the worker builds the real issuer, which asks the visibility port first and refuses a public repo or one it cannot read", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const env = { ...FORWARD_ENV, FX_RUNNER_JOB_SIGNING_KEY_PEM: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), FX_RUNNER_JOB_SIGNER_ID: "job-key-1" };
    const run = { ...RUN, repoId: "repo-1", role: "code-reviewer" } as unknown as ExecutionRun;
    // No visibility port: the real issuer is there (not the unwired one) and reads the repo as unknown.
    const unknown = await buildWorker(options({ env }));
    await expect(resolveExecutionTarget("runner_local", unknown.registry).dispatch(run)).rejects.toMatchObject({ name: "JobIssueError", code: "repo_visibility_unknown" });
    const pub = await buildWorker(options({ env, ports: { ...ports, repoVisibility: { visibility: async () => "public" } } }));
    await expect(resolveExecutionTarget("runner_local", pub.registry).dispatch(run)).rejects.toMatchObject({ name: "JobIssueError", code: "public_repo" });
  });

  it("D#6 R3b: half a job-signing setting, or a key that is not Ed25519, is a startup error and the pools are closed", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    for (const extra of [{ FX_RUNNER_JOB_SIGNING_KEY_PEM: pem }, { FX_RUNNER_JOB_SIGNER_ID: "job-key-1" }, { FX_RUNNER_JOB_SIGNING_KEY_PEM: "not a key", FX_RUNNER_JOB_SIGNER_ID: "job-key-1" }]) {
      const pools = fakePools();
      await expect(buildWorker(options({ env: { ...FORWARD_ENV, ...extra }, createPools: async () => pools }))).rejects.toMatchObject({ name: "JobSignerConfigError" });
      expect(pools.closed).toBe(1);
    }
  });

  it("C26: the one forward config comes from the env, is frozen, and is the exact object the target is built with", async () => {
    const worker = await buildWorker(options());
    expect(worker.githubForward.host).toBe("gh-proxy.fixture.test");
    expect(Object.isFrozen(worker.githubForward)).toBe(true);
    expect(worker.targetDeps.githubForward).toBe(worker.githubForward);
  });

  it("the operator exception: the target is handed a decision over the worker's own env, and only an admitted account gets the token", async () => {
    const OPERATOR = "11111111-1111-4111-8111-111111111111";
    const CUSTOMER = "22222222-2222-4222-8222-222222222222";
    const TOKEN = "sk-ant-oat01-FAKE-OPERATOR-TOKEN-FOR-TEST-ONLY";
    const env = { ...FORWARD_ENV, FX_OPERATOR_SUBSCRIPTION: "on", FX_OPERATOR_ACCOUNT_IDS: OPERATOR, FX_OPERATOR_CLAUDE_OAUTH_TOKEN: TOKEN };
    const worker = await buildWorker(options({ env }));
    const decide = worker.targetDeps.operatorToken!;
    expect(decide(OPERATOR, OPERATOR)).toBe(TOKEN);
    expect(decide(CUSTOMER, CUSTOMER)).toBeUndefined();
    expect(decide(CUSTOMER, OPERATOR)).toBeUndefined();
    expect(decide(OPERATOR, CUSTOMER)).toBeUndefined();
    // Without the settings, the same worker admits nobody.
    const off = (await buildWorker(options({ env: FORWARD_ENV }))).targetDeps.operatorToken!;
    expect(off(OPERATOR, OPERATOR)).toBeUndefined();
  });

  it("C26: no forward variable means no worker (the config loader refuses), and the pools are closed", async () => {
    const pools = fakePools();
    await expect(buildWorker(options({ env: {}, createPools: async () => pools }))).rejects.toThrow();
    expect(pools.closed).toBe(1);
  });

  it("C15: one port for the process, built with the credentials as constructor arguments", async () => {
    const fake = sdkFake();
    let tokenCalls = 0;
    const worker = await buildWorker(
      options({ sdk: fake.sdk, vercel: { teamId: "team_1", projectId: "prj_1", getToken: async () => `tok${++tokenCalls}` } }),
    );
    expect(worker.targetDeps.sandboxPort).toBe(worker.sandboxPort);
    const retention = { persistent: false } as never;
    await worker.sandboxPort.createSandbox({ sandboxName: "rn-1-r1", retention, timeoutMs: 7_200_000 });
    await worker.sandboxPort.createSandbox({ sandboxName: "rn-1-r2", retention, timeoutMs: 7_200_000 });
    expect(fake.created.map((p) => [p.teamId, p.projectId])).toEqual([
      ["team_1", "prj_1"],
      ["team_1", "prj_1"],
    ]);
    expect(fake.created.map((p) => p.token)).toEqual(["tok1", "tok2"]);
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "compositionRoot.ts"), "utf8");
    expect(source.match(/createVercelSandboxPort\(/g)).toHaveLength(1);
  });

  it("the target runs over the runner login's pool, not the platform_ops one", async () => {
    const worker = await buildWorker(options());
    expect(worker.targetDeps.pool).toBe(worker.pools.runnerPool);
  });

  it("CS-2b-2: sweepComputeSettle runs one tick over the runner login's pool, never the platform_ops one", async () => {
    const queries: { pool: string; sql: string }[] = [];
    const pool = (tag: string) => ({ tag, query: async (sql: string) => (queries.push({ pool: tag, sql }), { rows: [] }) }) as unknown as Pool;
    const pools = { ...fakePools(), runnerPool: pool("runner"), platformOpsPool: pool("ops") };
    const worker = await buildWorker(options({ createPools: async () => pools }));
    expect(await worker.sweepComputeSettle()).toEqual({ listed: 0, settled: 0, deleted: 0, failed: 0, skipped: 0, lost: { listed: 0, young: 0, stale: 0, settled: 0, alive: 0, unknown: 0, failed: 0, skipped: 0 }, outside: { listed: 0, waiting: 0, read: 0, final: 0, unavailable: 0, failed: 0, skipped: 0 } });
    // The lost-run list first (runs whose sandbox went away), then the compute settle's: both on the runner login.
    expect(queries.map((q) => q.pool)).toEqual(["runner", "runner", "runner", "runner"]);
    expect(queries[0]?.sql).toContain("agent_run_list_running");
    expect(queries[1]?.sql).toContain("compute_settle_list_due");
    // D#221 OM-2b: the outside meter rides the same tick, on the same login.
    expect(queries[2]?.sql).toContain("outside_meter_list_due");
  });

  it("a pool guard refusal stops the worker before anything else is built", async () => {
    await expect(
      buildWorker(options({ createPools: async () => { throw new StartupGuardError("OPS-4"); } })),
    ).rejects.toMatchObject({ rule: "OPS-4" });
  });

  it("keeps the retry author-check port it was given (the same function), and defaults to no check", async () => {
    const check = () => null;
    expect((await buildWorker(options({ ports: { ...ports, authorCheck: check } }))).authorCheck).toBe(check);
    expect((await buildWorker(options())).authorCheck()).toBeNull();
  });

  it("close() closes the pools", async () => {
    const pools = fakePools();
    const worker = await buildWorker(options({ createPools: async () => pools }));
    await worker.close();
    expect(pools.closed).toBe(1);
  });
});

describe("H14c-3-3a: a preview is ready only when its seat, starter and prompt builder are all wired", () => {
  const follow = async (): Promise<void> => undefined;
  const previewPrompt = (repo: { owner: string; name: string }): string => `${repo.owner}/${repo.name}`;

  it("all three: previewReady() is true on the built worker", async () => {
    expect((await buildWorker(options({ ports: { ...ports, follow }, previewPrompt }))).previewReady()).toBe(true);
  });

  it("no previewPrompt: promptFor is null and previewReady() is false", async () => {
    expect((await buildWorker(options({ ports: { ...ports, follow } }))).previewReady()).toBe(false);
  });

  it("no follower: there is no starter, and previewReady() is false", async () => {
    expect((await buildWorker(options({ previewPrompt }))).previewReady()).toBe(false);
  });

  it("neither: the default build can start no preview", async () => {
    expect((await buildWorker(options())).previewReady()).toBe(false);
  });
});

describe("H14c-3-2c: the current KEK must exist before the worker builds", () => {
  const { decryptTenantKey: _injected, ...noDecrypt } = ports;
  void _injected;
  const key = (n = 32) => Buffer.alloc(n, 7).toString("base64");
  const build = (env: Record<string, string>) => buildWorker(options({ env: { ...FORWARD_ENV, ...env }, ports: noDecrypt }));
  const message = (env: Record<string, string>) => build(env).then(() => undefined, (e: Error) => e.message);

  it("refuses a missing or wrong-length current key, naming the variable, never the value, before any pool opens", async () => {
    let opened = 0;
    await expect(buildWorker(options({ ports: noDecrypt, createPools: async () => (opened++, fakePools()) }))).rejects.toThrow(
      "worker: FX_KEK_V1 must be set to a base64-encoded 32-byte key",
    );
    expect(opened).toBe(0);
    expect(await message({ FX_KEK_V1: key(16) })).toBe("worker: FX_KEK_V1 must be set to a base64-encoded 32-byte key");
  });

  it("checks the CURRENT version only: V2 missing fails even when V1 is fine; a missing old version is checked lazily", async () => {
    expect(await message({ FX_KEK_CURRENT_VERSION: "2", FX_KEK_V1: key() })).toContain("FX_KEK_V2");
    await expect(build({ FX_KEK_CURRENT_VERSION: "2", FX_KEK_V2: key() })).resolves.toBeDefined();
    await expect(build({ FX_KEK_V1: key() })).resolves.toBeDefined();
  });

  it("createWorker refuses the same way", async () => {
    await expect(
      createWorker({ env: FORWARD_ENV, vercel: { teamId: "t", projectId: "p", getToken: async () => "x" }, ports: noDecrypt }),
    ).rejects.toThrow("FX_KEK_V1");
  });
});

describe("C59 §5: a run's workdir is never the agent-config directory or under it", () => {
  it("assertWorkdirAllowed refuses the directory, anything under it, a traversal into it, and a parent of it", () => {
    for (const bad of ["/fx/agent-config", "/fx/agent-config/x", "/work/../fx/agent-config/settings.json", "/fx/agent-config/", "/", "/fx"]) {
      expect(() => assertWorkdirAllowed(bad), bad).toThrow(/agent config/);
    }
    for (const ok of [undefined, "/vercel/sandbox", "/fx/agent-configs", "/workspace/repo"]) {
      expect(() => assertWorkdirAllowed(ok), String(ok)).not.toThrow();
    }
  });

  it("the registry target refuses such a run before it reaches the port", async () => {
    const fake = sdkFake();
    const worker = await buildWorker(options({ sdk: fake.sdk }));
    const target = resolveExecutionTarget("sandbox", worker.registry);
    await expect(target.dispatch({ ...RUN, workdir: "/fx/agent-config/evil" })).rejects.toThrow(/agent config/);
    await expect(target.resume({ ...RUN, workdir: "/fx/agent-config" }, "s1")).rejects.toThrow(/agent config/);
    expect(fake.created).toEqual([]);
  });

  it("the runner target is guarded the same way", async () => {
    const worker = await buildWorker(options());
    const target = resolveExecutionTarget("runner_local", worker.registry);
    await expect(target.dispatch({ ...RUN, workdir: "/fx/agent-config/evil" })).rejects.toThrow(/agent config/);
    await expect(target.resume({ ...RUN, workdir: "/fx/agent-config" }, "s1")).rejects.toThrow(/agent config/);
  });
});

describe("CS-2b-2: the compute-settle cron route's time limit", () => {
  // Lives here, not in apps/web: the request path may not value-import @fx/runner (packages/api/test/run-actions-boundary.test.ts).
  it("maxDuration (seconds) outlasts the sweep's time budget plus one run's worst case", () => {
    const route = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../apps/web/app/api/cron/compute-settle-sweep/route.ts");
    const match = /^export const maxDuration = (\d+);$/m.exec(readFileSync(route, "utf8"));
    expect(match, "route.ts must export maxDuration as a number literal").not.toBeNull();
    expect(Number(match?.[1]) * 1000).toBeGreaterThan(SWEEP_TIME_BUDGET_MS + SWEEP_RUN_WORST_CASE_MS);
  });
});
