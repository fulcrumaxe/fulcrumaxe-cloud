import { afterEach, describe, expect, it, vi } from "vitest";
import { RUN_LIMIT_BOUNDS, type RunLimitKey } from "@fx/core/src/run-limits/limits.js";
import { ROLE_MANIFEST } from "@fx/roles";
import { CLAUDE_CLI_VERSION, SANDBOX_TIMEOUT_MARGIN_MS, buildExecutionRun, createVercelSandboxPort, type ExecutionRun, type ExtensionPolicy, type StartAgentRunInput } from "@fx/runner";
import { reserve } from "@fx/spend";
import { buildSandboxEnv } from "../../runner/src/sandboxEnv.js";
import { networkPolicy } from "../../runner/src/networkPolicy.js";
import { retentionPolicyFor } from "../../runner/src/sandboxNaming.js";
import { keyedPolicy } from "../../runner/test/helpers/keyedPolicy.js";
import { sdkSessionStubs } from "../../runner/test/helpers/sdkSession.js";
import { noGhWriteCounter, createExtensionPolicyFor } from "../src/extensionPolicy.js";
import { RUN_TIME_CEILING_MS, runnerLimitsFrom, sandboxTimeFor } from "../src/seat.js";

// The reservation itself is proved on real Postgres (extensionPolicy.pg.test.ts); here it is a recorder.
vi.mock("@fx/spend", async (original) => ({ ...(await original<typeof import("@fx/spend")>()), reserve: vi.fn(async () => ({ decision: "admit", reservations: [{ id: "r1" }] })) }));

const MIN = 60_000;
const DEFAULTS = Object.fromEntries(Object.entries(RUN_LIMIT_BOUNDS).map(([k, b]) => [k, b.default])) as Record<RunLimitKey, number>;
const seat = runnerLimitsFrom({ ...DEFAULTS, max_extensions: 2 });
const SPEND = { plan: "starter", purpose: "run", trigger: "foreground", estimateModelUsd: 50, estimateComputeUsd: 1, monthlyModelBudgetUsd: 500, perSpawnCapUsd: 50 } as const;
const input = (over: Partial<StartAgentRunInput> = {}): StartAgentRunInput =>
  ({ accountId: "acct-1", workItemId: "wi-1", role: "executor", product: "team", roleCard: "c", prompt: "go", model: "sonnet-5", capUsd: 50, timeoutMs: sandboxTimeFor(seat.limits, 2).timeoutMs, limits: seat.limits, maxExtensions: 2, spend: SPEND, ...over }) as StartAgentRunInput;
const runOf = (over: Partial<StartAgentRunInput> = {}): ExecutionRun => buildExecutionRun("run-1", input(over));
const policyFor = createExtensionPolicyFor({ pool: {} as never, resolvePayer: () => "payer-1" });

describe("extension policy: what the runner is handed", () => {
  it("1: the run's own extension count, the platform ceilings read from the bounds, a writing executor, and a named-zero write counter", () => {
    const p = policyFor(runOf())!;
    expect(p.maxExtensions).toBe(2);
    expect(p.ceilings).toEqual({
      runMs: Math.min(RUN_TIME_CEILING_MS, sandboxTimeFor(seat.limits, 2).timeoutMs - SANDBOX_TIMEOUT_MARGIN_MS),
      modelCalls: RUN_LIMIT_BOUNDS.max_model_calls.ceiling,
      usd: RUN_LIMIT_BOUNDS.per_run_usd.ceiling,
    });
    expect(p.roleWrites).toBe(true);
    expect(p.ghWrites()).toBe(0);
    expect(p.ghWrites).toBe(noGhWriteCounter);
    expect(p).not.toHaveProperty("disposition");
    // A run with no recorded sandbox timeout is held to the platform ceiling alone.
    expect(policyFor(runOf({ timeoutMs: undefined }))!.ceilings.runMs).toBe(RUN_TIME_CEILING_MS);
  });

  it("2: roleWrites comes from the manifest: a writing role true, a read-only role false, an unknown role not answered at all", () => {
    const readOnly = ROLE_MANIFEST.find((r) => !r.writeAccess)!.name;
    expect(policyFor(runOf({ role: "executor" as never }))!.roleWrites).toBe(true);
    expect(policyFor(runOf({ role: readOnly as never }))!.roleWrites).toBe(false);
    expect(policyFor(runOf({ role: "code-reviewer" as never }))!.roleWrites).toBe(false);
    const unknown = policyFor(runOf({ role: "no-such-role" as never }))!;
    expect(Object.hasOwn(unknown, "roleWrites")).toBe(false);
  });

  it("3: a continuation gets the resolved count again, not what is left of it", () => {
    const continuation = runOf({ parentRunId: "run-0" });
    expect(policyFor(continuation)!.maxExtensions).toBe(2);
    expect(policyFor(runOf({ parentRunId: "run-0", maxExtensions: 4 }))!.maxExtensions).toBe(4);
  });

  it("4: a run without a seat's count, or with none to spend, is not extendable", () => {
    expect(policyFor(runOf({ maxExtensions: undefined }))).toBeUndefined();
    expect(policyFor(runOf({ maxExtensions: 0 }))).toBeUndefined();
  });

  it("5 (unit): the reservation names the payer's account, this run and its spend facts, with the extension's estimate and no compute", async () => {
    const p = policyFor(runOf())!;
    expect(await p.reserveExtension(3)).toBe(true);
    expect(vi.mocked(reserve)).toHaveBeenLastCalledWith(expect.anything(), { accountId: "payer-1", runId: "run-1", ...SPEND, estimateModelUsd: 3, estimateComputeUsd: 0 });
    vi.mocked(reserve).mockResolvedValueOnce({ decision: "deny", reason: "monthly_budget" } as never);
    expect(await p.reserveExtension(3)).toBe(false);
    // An admit that recorded no reservation held nothing, so it is not an extension.
    vi.mocked(reserve).mockResolvedValueOnce({ decision: "admit", reservations: [] } as never);
    expect(await p.reserveExtension(0)).toBe(false);
  });
});

describe("extension policy: the operator subscription holds no model money", () => {
  const operatorPolicy = (decide: (accountId: string, payer: string) => string | undefined) =>
    createExtensionPolicyFor({ pool: {} as never, resolvePayer: () => "payer-1", operatorToken: decide });

  it("an operator run's extension is granted without a reservation, for a real estimate only; the run's extension count still bounds it", async () => {
    vi.mocked(reserve).mockClear();
    const seen: Array<[string, string]> = [];
    const p = operatorPolicy((a, payer) => (seen.push([a, payer]), "token-never-used-here"))(runOf())!;
    expect(await p.reserveExtension(3)).toBe(true);
    expect(await p.reserveExtension(0)).toBe(false);
    expect(await p.reserveExtension(Number.NaN)).toBe(false);
    expect(vi.mocked(reserve)).not.toHaveBeenCalled();
    expect(seen[0]).toEqual(["acct-1", "payer-1"]); // the decision is asked about the run's account AND its payer
    expect(p.maxExtensions).toBe(2);
    expect(operatorPolicy(() => "t")(runOf({ maxExtensions: 0 }))).toBeUndefined();
  });

  it("a customer run still reserves as before, and a spend fact that claims the broker is stripped before reserve()", async () => {
    vi.mocked(reserve).mockClear();
    const claimed = runOf({ spend: { ...SPEND, modelBrokeredBy: "operator_subscription" } as never });
    const p = operatorPolicy(() => undefined)(claimed)!;
    expect(await p.reserveExtension(3)).toBe(true);
    const sent = vi.mocked(reserve).mock.calls.at(-1)![1] as { modelBrokeredBy?: string };
    expect(sent.modelBrokeredBy).toBeUndefined();
    expect(vi.mocked(reserve)).toHaveBeenCalledTimes(1);
  });
});

describe("extension policy: end to end on the fake SDK port (9)", () => {
  const T0 = Date.parse("2030-01-01T00:00:00Z");
  const NAME = "rn-8-reviewer-run-1";
  const assistant = (id: string) => JSON.stringify({ type: "assistant", message: { id, content: [], usage: { input_tokens: 1 } } });
  afterEach(() => vi.useRealTimers());

  /** The fake SDK port over a held command; resolves to the run's outcome and the policy's recorder once the command is running. */
  async function held(lines: string[], role: string, limits: { maxRunMs?: number; maxModelCalls?: number }, hold: boolean) {
    const sandbox = {
      name: NAME,
      async runCommand(params: { args?: string[] }) {
        const text = params.args?.[2] === "fx-pin" ? `${CLAUDE_CLI_VERSION}\n` : undefined;
        return {
          async *logs() {
            if (text) yield { stream: "stdout", data: text };
            else {
              for (const line of lines) {
                yield { stream: "stdout", data: `${line}\n` };
                await new Promise((r) => setImmediate(r));
              }
              if (hold) await new Promise<void>(() => undefined);
            }
          },
          wait: async () => ({ exitCode: 0 }),
          kill: async () => undefined,
        };
      },
      writeFiles: async () => undefined,
      updateNetworkPolicy: async () => undefined,
      extendTimeout: async () => undefined,
      stop: async () => undefined,
      delete: async () => undefined,
      ...sdkSessionStubs(),
    };
    const get = async () => sandbox as never;
    const port = createVercelSandboxPort({ teamId: "t", projectId: "p", getToken: async () => "tok", sdk: { create: get, get }, limits });
    const handle = await port.createSandbox({ sandboxName: NAME, retention: retentionPolicyFor("reviewer"), timeoutMs: 80_000_000 });
    const onExtended = vi.fn();
    const extension: ExtensionPolicy = { ...policyFor(runOf({ role: role as never }))!, meteredUsd: () => 1, onExtended };
    const started = port.startDetached(handle, {
      runId: "run-1", role: "reviewer", roleCard: "card", prompt: "go", model: "sonnet-5", workdir: "/vercel/sandbox/repo", capUsd: 5,
      networkPolicy: keyedPolicy(networkPolicy("reviewer", "team", { provider: "ai_gateway", githubForwardHost: "gh-proxy.fulcrumaxe.app" })),
      env: buildSandboxEnv("reviewer"), onEvent: () => undefined, extension,
    });
    started.hookFired.catch(() => undefined);
    return { ended: started.hookFired, onExtended };
  }
  const settle = async () => {
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
  };

  it("a default executor reaching run_time with usage rising is extended once; the second run_time hit has no GitHub write, so the run ends", async () => {
    vi.useFakeTimers({ now: T0, toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { ended, onExtended } = await held([assistant("m1")], "executor", { maxRunMs: 4 * MIN }, true);
    await settle();
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(onExtended).toHaveBeenCalledTimes(1);
    expect(onExtended).toHaveBeenCalledWith({ kind: "run_time", extensionsUsed: 1, newLimit: 6 * MIN, progress: { usage_rose: true, gh_writes: 0, new_message_ids: 1 } });
    await vi.advanceTimersByTimeAsync(2 * MIN);
    await expect(ended).rejects.toMatchObject({ limit: { kind: "run_time", limit: 6 * MIN } });
    expect(onExtended).toHaveBeenCalledTimes(1);
  });

  it("a read-only role with five new message ids is extended a second time", async () => {
    const ids = Array.from({ length: 16 }, (_, i) => assistant(`m${i + 1}`));
    const { ended, onExtended } = await held(ids, "code-reviewer", { maxModelCalls: 10 }, false);
    await ended;
    expect(onExtended.mock.calls.map(([e]) => e.extensionsUsed)).toEqual([1, 2]);
  });
});
