import type { NetworkPolicy } from "@vercel/sandbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_CLI_VERSION, SandboxPolicyRequiredError, createVercelSandboxPort, sdkNetworkPolicy, type SdkCommand, type SdkCreateParams, type SdkSandbox, type VercelSandboxSdk } from "../src/vercelSandboxPort.js";
import { PLANE_PUBLISH_VCPUS, type CreateSandboxOptions } from "../src/sandboxPort.js";
import { PLANE_PUBLISH_ROLE, retentionPolicyFor, sandboxNameFor } from "../src/sandboxNaming.js";
import { buildSandboxEnv } from "../src/sandboxEnv.js";
import { networkPolicy, type NetworkPolicyRule } from "../src/networkPolicy.js";
import { keyedPolicy } from "./helpers/keyedPolicy.js";
import { sdkSessionStubs } from "./helpers/sdkSession.js";

/**
 * A sandbox is never allow-all, not for the moment between its creation and a policy update (the platform default is allow-all, and an
 * update is not guaranteed to be enforced when its call returns). The fake below models that: it is typed against the real SDK surface
 * (`SdkCreateParams` carries the SDK's own create-time `networkPolicy`, `updateNetworkPolicy` takes the SDK's `NetworkPolicy`), a create
 * with no policy would start allow-all, and an update takes effect only after a delay while the call itself returns at once.
 */
const ACCOUNT = "11111111-2222-4333-8444-555555555555";
const REPO = "99999999-2222-4333-8444-555555555555";
const GH_HOST = "gh-proxy.fulcrumaxe.app";
const PROXY_ONLY: NetworkPolicyRule[] = [{ host: GH_HOST, purpose: "github_proxy" }];
const APPLY_DELAY_MS = 40;

type Effective = "allow-all" | NetworkPolicy;

function strictFake() {
  const creates: SdkCreateParams[] = [];
  const unenforcedCommands: string[] = [];
  const everAllowAll: string[] = [];
  const commands: Array<{ name: string; args: string[]; policy: Effective }> = [];
  const state = new Map<string, { effective: Effective; status: string; params: SdkCreateParams }>();
  let getCalls = 0;

  function sandboxFor(name: string): SdkSandbox {
    const entry = state.get(name)!;
    return {
      name,
      async runCommand(params) {
        // A command that starts while the sandbox is allow-all is the hole this file is about.
        if (entry.effective === "allow-all") unenforcedCommands.push(`${params.cmd} ${(params.args ?? []).join(" ").slice(0, 40)}`);
        commands.push({ name, args: params.args ?? [], policy: entry.effective });
        const isPin = params.args?.[2] === "fx-pin";
        const cmd: SdkCommand = {
          async *logs() {
            if (isPin) yield { stream: "stdout", data: `${CLAUDE_CLI_VERSION} (Claude Code)\n` };
            else yield { stream: "stdout", data: `${JSON.stringify({ type: "result", is_error: false, result: "done", session_id: "s1" })}\n` };
          },
          wait: async () => ({ exitCode: 0 }),
          kill: async () => undefined,
        };
        return cmd;
      },
      async writeFiles() {},
      async updateNetworkPolicy(policy) {
        // Returns at once; the platform enforces it later. Until then the previous policy stays in force.
        setTimeout(() => {
          entry.effective = policy;
          if (policy === "allow-all") everAllowAll.push(name);
        }, APPLY_DELAY_MS);
        return policy;
      },
      async extendTimeout() {},
      async stop() {},
      async delete() {
        state.delete(name);
      },
      ...sdkSessionStubs(),
      get status() {
        return entry.status;
      },
      persistent: entry.params.persistent,
      image: entry.params.image,
      vcpus: entry.params.resources.vcpus,
      timeout: entry.params.timeout,
      keepLastSnapshots: entry.params.keepLastSnapshots,
    };
  }

  const sdk: VercelSandboxSdk = {
    async create(params) {
      creates.push(params);
      if (state.has(params.name)) throw Object.assign(new Error("taken"), { response: { status: 409 } });
      // The platform default for a create with no policy.
      const effective: Effective = (params as { networkPolicy?: NetworkPolicy }).networkPolicy ?? "allow-all";
      state.set(params.name, { effective, status: "running", params });
      return sandboxFor(params.name);
    },
    async get(params) {
      getCalls++;
      const entry = state.get(params.name);
      if (!entry) throw Object.assign(new Error("not found"), { response: { status: 404 } });
      if (params.resume === true && entry.status === "stopped") {
        entry.status = "running";
        entry.effective = "allow-all"; // a new session starts from whatever the last one left; here, the worst case
      }
      return sandboxFor(params.name);
    },
  };
  return { sdk, creates, unenforcedCommands, everAllowAll, commands, state, getCalls: () => getCalls };
}

const port = (sdk: VercelSandboxSdk) => createVercelSandboxPort({ teamId: "t", projectId: "p", getToken: async () => "tok", sdk });
const agentPolicy = () => keyedPolicy(networkPolicy("code-reviewer", "team", { provider: "ai_gateway", githubForwardHost: GH_HOST }));

const KINDS: Array<{ kind: string; opts: CreateSandboxOptions }> = [
  { kind: "build (executor, persistent)", opts: { sandboxName: sandboxNameFor({ role: "executor", runId: "r1", accountId: ACCOUNT, repoId: REPO, pr: 7 }), retention: retentionPolicyFor("executor"), timeoutMs: 7_200_000, networkPolicy: agentPolicy() } },
  { kind: "review", opts: { sandboxName: sandboxNameFor({ role: "code-reviewer", runId: "r2" }), retention: retentionPolicyFor("code-reviewer"), timeoutMs: 7_200_000, networkPolicy: agentPolicy() } },
  { kind: "agent (researcher)", opts: { sandboxName: sandboxNameFor({ role: "researcher", runId: "r3" }), retention: retentionPolicyFor("researcher"), timeoutMs: 7_200_000, networkPolicy: agentPolicy() } },
  { kind: "preview", opts: { sandboxName: sandboxNameFor({ role: "browser-tester", runId: "r4" }), retention: retentionPolicyFor("browser-tester"), timeoutMs: 7_200_000, networkPolicy: agentPolicy() } },
  { kind: "publish (pp-)", opts: { sandboxName: sandboxNameFor({ role: PLANE_PUBLISH_ROLE, runId: "x", attemptId: ACCOUNT }), retention: { persistent: false }, timeoutMs: 4_500_000, vcpus: PLANE_PUBLISH_VCPUS, networkPolicy: PROXY_ONLY } },
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("every sandbox is created with its network policy", () => {
  it.each(KINDS)("$kind: the create call carries exactly the SDK form of the policy", async ({ opts }) => {
    const fake = strictFake();
    await port(fake.sdk).createSandbox(opts);
    expect(fake.creates).toHaveLength(1);
    expect(fake.creates[0]!.networkPolicy).toEqual(sdkNetworkPolicy(opts.networkPolicy!));
    expect(fake.state.get(opts.sandboxName)!.effective).not.toBe("allow-all");
    // GitHub is forwarded from the first instant, with no direct route.
    const allow = (fake.creates[0]!.networkPolicy as { allow: Record<string, Array<{ forwardURL?: string }>> }).allow;
    expect(allow["github.com"]?.[0]?.forwardURL).toContain(GH_HOST);
    expect(allow["api.github.com"]?.[0]?.forwardURL).toContain(GH_HOST);
  });

  it("an empty rule list is created as deny-all, never as the default", async () => {
    const fake = strictFake();
    await port(fake.sdk).createSandbox({ ...KINDS[1]!.opts, networkPolicy: [] });
    expect(fake.creates[0]!.networkPolicy).toBe("deny-all");
  });

  it.each(KINDS)("$kind: a create with no policy throws a typed error before the SDK is called", async ({ opts }) => {
    const fake = strictFake();
    const { networkPolicy: _dropped, ...without } = opts;
    await expect(port(fake.sdk).createSandbox(without)).rejects.toBeInstanceOf(SandboxPolicyRequiredError);
    expect(fake.creates).toEqual([]);
    expect(fake.getCalls()).toBe(0);
    expect(fake.state.size).toBe(0);
  });

  it("a woken persistent sandbox has the run's policy applied and confirmed before the handle is returned", async () => {
    const fake = strictFake();
    const p = port(fake.sdk);
    const exec = KINDS[0]!.opts;
    await p.createSandbox(exec);
    fake.state.get(exec.sandboxName)!.status = "stopped"; // the first build ended; fix rounds wake it
    const woken = p.createSandbox(exec);
    await vi.advanceTimersByTimeAsync(APPLY_DELAY_MS * 3);
    await woken;
    expect(fake.creates).toHaveLength(2); // the second create was refused as taken; the sandbox itself was reused
    expect(fake.state.get(exec.sandboxName)!.effective).toEqual(sdkNetworkPolicy(exec.networkPolicy!));
  });
});

describe("zero commands run unenforced", () => {
  it("publish: the hook's first command runs under the proxy-only policy even while an update is still pending", async () => {
    const fake = strictFake();
    const p = port(fake.sdk);
    const handle = await p.createSandbox(KINDS[4]!.opts);
    const run = p.runCommand(handle, { role: PLANE_PUBLISH_ROLE, cmd: "node", args: ["/fx/hook.mjs"], env: buildSandboxEnv(PLANE_PUBLISH_ROLE), networkPolicy: PROXY_ONLY, timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(APPLY_DELAY_MS * 3);
    await run;
    expect(fake.commands).toHaveLength(1);
    expect(fake.unenforcedCommands).toEqual([]);
    expect(fake.everAllowAll).toEqual([]);
    expect(fake.commands[0]!.policy).toEqual(sdkNetworkPolicy(PROXY_ONLY));
  });

  it("publish: a run policy that differs from the create-time one is applied first; the command never sees allow-all", async () => {
    const fake = strictFake();
    const p = port(fake.sdk);
    const handle = await p.createSandbox({ ...KINDS[4]!.opts, networkPolicy: [] }); // deny-all at create
    const run = p.runCommand(handle, { role: PLANE_PUBLISH_ROLE, cmd: "node", args: ["/fx/hook.mjs"], env: buildSandboxEnv(PLANE_PUBLISH_ROLE), networkPolicy: PROXY_ONLY, timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(APPLY_DELAY_MS * 3);
    await run;
    expect(fake.unenforcedCommands).toEqual([]);
    expect(fake.everAllowAll).toEqual([]);
  });

  it("build: no command (pin check, agent) runs while the sandbox is allow-all, with the launch update still pending", async () => {
    const fake = strictFake();
    const p = port(fake.sdk);
    const opts = KINDS[1]!.opts;
    const handle = await p.createSandbox(opts);
    const started = await Promise.resolve(
      p.startDetached(handle, {
        runId: "run-1",
        role: "code-reviewer",
        roleCard: "card",
        prompt: "go",
        model: "sonnet-5",
        capUsd: 5,
        networkPolicy: opts.networkPolicy!,
        env: buildSandboxEnv("code-reviewer"),
        onEvent: () => {},
      }),
    );
    await vi.advanceTimersByTimeAsync(APPLY_DELAY_MS * 3);
    await started.hookFired;
    expect(fake.commands.length).toBeGreaterThan(0);
    expect(fake.unenforcedCommands).toEqual([]);
    expect(fake.everAllowAll).toEqual([]);
  });
});

describe("the callers hand the policy to the create", () => {
  it("runPublishSandbox creates the pp- sandbox with the proxy-only policy it will run under", async () => {
    const { runPublishSandbox } = await import("../src/planePublish/run.js");
    const seen: CreateSandboxOptions[] = [];
    const stub = {
      createSandbox: async (o: CreateSandboxOptions) => {
        seen.push(o);
        throw new Error("stop here");
      },
    } as unknown as Parameters<typeof runPublishSandbox>[0];
    await expect(runPublishSandbox(stub, { sandboxName: KINDS[4]!.opts.sandboxName, hook: "", input: {} as never, networkPolicy: PROXY_ONLY })).rejects.toThrow("stop here");
    expect(seen[0]!.networkPolicy).toBe(PROXY_ONLY);
  });
});
