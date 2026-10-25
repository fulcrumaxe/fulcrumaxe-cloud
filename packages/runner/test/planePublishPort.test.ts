import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AgentRuntime } from "../src/types.js";
import { createFakeSandbox, assertSandboxEnvMatchesRole } from "../src/fakeSandbox.js";
import { SANDBOX_VCPUS, PLANE_PUBLISH_VCPUS, LISTABLE_PREFIXES, type RunCommandOptions, type SandboxHandle } from "../src/sandboxPort.js";
import { SandboxNameConflictError, SandboxPortError, createVercelSandboxPort, type SdkCommand, type SdkCreateParams, type SdkSandbox } from "../src/vercelSandboxPort.js";
import { PLANE_PUBLISH_ROLE, parseSandboxName, sandboxNameFor } from "../src/sandboxNaming.js";
import { SANDBOX_CA_ENV, buildSandboxEnv } from "../src/sandboxEnv.js";
import { buildPublishFirewallPolicy } from "../src/firewallPolicy.js";
import { loadGithubForwardConfig } from "../src/githubForwardConfig.js";
import { RUN_COMMAND_MAX_OUTPUT_CHARS, PublishSandboxAgentRefused } from "../src/runCommand.js";
import { PLANE_PUBLISH_HOOK_PATH, PLANE_PUBLISH_INPUT_PATH, parsePhaseOutput, phaseLine, type PlanePublishInput } from "../src/planePublish/protocol.js";
import { runPublishSandbox } from "../src/planePublish/run.js";
import type { NetworkPolicyRule } from "../src/networkPolicy.js";

/**
 * D#598 P1f-5a: the sandbox side of the publish step. The fake and the real adapter are held to the same contract: the publish role, the one env,
 * the proxy-only policy, files only for a `pp-` sandbox, arguments as a list. Items 26 and 27's sandbox half (1 vCPU, no model connection,
 * deletion on every outcome) are checked here; the hook's own refusals (item 27) are in planePublishHook.test.ts.
 */
const ATTEMPT = "11111111-2222-4333-8444-555555555555";
const NAME = `pp-${ATTEMPT}`;
const POLICY: NetworkPolicyRule[] = [{ host: "gh-proxy.fulcrumaxe.app", purpose: "github_proxy" }];
const noRuntime = { start: async () => undefined, stop: async () => undefined, resume: async () => undefined } as unknown as AgentRuntime;
const INPUT: PlanePublishInput = {
  own: { owner: "acme", name: "widgets-private" },
  codeRepo: "acme/widgets",
  privateBase: "a".repeat(40),
  privateHead: "b".repeat(40),
  privateDefaultTip: "a".repeat(40),
  branch: "fx/p-1",
  title: "Change from a run",
  body: "Opened by a run.",
  identity: { name: "Bot", email: "bot@example.test" },
  commitTime: 1_700_000_000,
  pairing: { overlayGlobs: ["docs/"], identifierRulesPath: null, planDataRulesPath: null },
};
const baseRun = (over: Partial<RunCommandOptions> = {}): RunCommandOptions => ({
  role: PLANE_PUBLISH_ROLE,
  cmd: "node",
  args: [PLANE_PUBLISH_HOOK_PATH],
  env: buildSandboxEnv(PLANE_PUBLISH_ROLE),
  networkPolicy: POLICY,
  timeoutMs: 60_000,
  ...over,
});
const created = async (f = createFakeSandbox(noRuntime)) => {
  const handle = await f.port.createSandbox({ sandboxName: NAME, retention: { persistent: false }, timeoutMs: 600_000, vcpus: PLANE_PUBLISH_VCPUS });
  return { f, handle };
};

describe("naming, env and policy of the publish role", () => {
  it("names a publish sandbox pp-<attempt id>: never an ex- or rn- name, and needs a UUID", () => {
    expect(sandboxNameFor({ role: PLANE_PUBLISH_ROLE, runId: "x", attemptId: ATTEMPT })).toBe(NAME);
    expect(() => sandboxNameFor({ role: PLANE_PUBLISH_ROLE, runId: "x" })).toThrow(/attemptId/);
    expect(() => sandboxNameFor({ role: PLANE_PUBLISH_ROLE, runId: "x", attemptId: "../x" })).toThrow(/UUID/);
    expect(NAME.startsWith("ex-") || NAME.startsWith("rn-")).toBe(false);
    expect(parseSandboxName(NAME)).toEqual({ kind: "publish", attemptId: ATTEMPT }); // pp- is read back by shape (the inventory lists it)
    expect(LISTABLE_PREFIXES).toEqual(["ex-", "rn-", "pp-"]); // added by P1f-5r; asserted here so a change to it is seen
  });

  it("the role string equals the gh-policy constant the proxy keys on", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(new URL("../../gh-policy/src/planePublish.ts", import.meta.url), "utf8")).toContain(`PLANE_PUBLISH_ROLE = "${PLANE_PUBLISH_ROLE}"`);
  });

  it("the env is the CA paths and nothing else: no model variable, no operator mode, no token-shaped name", () => {
    const env = buildSandboxEnv(PLANE_PUBLISH_ROLE);
    expect(env).toEqual({ ...SANDBOX_CA_ENV });
    expect(Object.keys(env).some((k) => /ANTHROPIC|OAUTH|CLAUDE/.test(k))).toBe(false);
    expect(() => buildSandboxEnv(PLANE_PUBLISH_ROLE, "operator_subscription")).toThrow();
    expect(() => assertSandboxEnvMatchesRole(PLANE_PUBLISH_ROLE, env)).not.toThrow();
    expect(() => assertSandboxEnvMatchesRole(PLANE_PUBLISH_ROLE, { ...env, ANTHROPIC_API_KEY: "" })).toThrow(/extra keys/);
    expect(() => assertSandboxEnvMatchesRole(PLANE_PUBLISH_ROLE, { ...env, CLAUDE_CODE_OAUTH_TOKEN: "x" })).toThrow(/extra keys/);
    // An agent role's env does not pass for the publish role either.
    expect(() => assertSandboxEnvMatchesRole(PLANE_PUBLISH_ROLE, buildSandboxEnv("executor"))).toThrow();
  });

  it("the policy is the GitHub proxy rule alone, built through the same forward-host checks as the agent policies", async () => {
    const githubForward = loadGithubForwardConfig({ FX_GH_FORWARD_SUFFIX: "gh-proxy.fulcrumaxe.app", FX_GH_FORWARD_HOST: "gh-proxy.fulcrumaxe.app" });
    const rules = await buildPublishFirewallPolicy({ githubForward, lookup: async () => [{ address: "140.82.112.3", family: 4 }] });
    expect(rules).toEqual([{ host: "gh-proxy.fulcrumaxe.app", purpose: "github_proxy" }]);
    await expect(buildPublishFirewallPolicy({ githubForward, lookup: async () => [{ address: "10.0.0.1", family: 4 }] })).rejects.toMatchObject({ name: "GithubForwardHostRefusedError" });
  });
});

describe("the fake port enforces the real contract (items 26)", () => {
  it("creates a pp- sandbox with 1 vCPU only, never persistent; no other sandbox may take the 1-vCPU figure", async () => {
    const f = createFakeSandbox(noRuntime);
    await expect(f.port.createSandbox({ sandboxName: NAME, retention: { persistent: false }, timeoutMs: 600_000 })).rejects.toThrow(/1 vCPU/);
    await expect(f.port.createSandbox({ sandboxName: NAME, retention: { persistent: true, keepLastSnapshots: 1 }, timeoutMs: 600_000, vcpus: 1 })).rejects.toThrow(/1 vCPU/);
    await expect(f.port.createSandbox({ sandboxName: "rn-8-reviewer-run-1", retention: { persistent: false }, timeoutMs: 600_000, vcpus: 1 })).rejects.toThrow(/only a pp- sandbox/);
    await f.port.createSandbox({ sandboxName: NAME, retention: { persistent: false }, timeoutMs: 600_000, vcpus: 1 });
    expect(f.state.created).toHaveLength(1);
    expect(SANDBOX_VCPUS).toBe(2);
  });

  it("a second create of a live pp- name answers the way Vercel does for a taken name: 400 bad_request", async () => {
    const { f } = await created();
    await expect(f.port.createSandbox({ sandboxName: NAME, retention: { persistent: false }, timeoutMs: 600_000, vcpus: 1 })).rejects.toMatchObject({ status: 400, json: { error: { code: "bad_request" } } });
  });

  it("runCommand: the publish role, node, the one proxy rule, the one env; an argument is one literal element", async () => {
    const { f, handle } = await created();
    const nasty = ["a;b", "$(touch /tmp/x)", "line1\nline2", "`id`", "--flag=\"q\" 'r'"];
    await f.port.runCommand(handle, baseRun({ args: nasty }));
    expect(f.state.commands).toHaveLength(1);
    expect(f.state.commands[0]).toMatchObject({ sandboxName: NAME, cmd: "node", args: nasty, policyPurposes: ["github_proxy"] });
    const bad: Array<[string, Partial<RunCommandOptions>]> = [
      ["another role", { role: "executor", env: buildSandboxEnv("executor") }],
      ["a shell", { cmd: "sh" }],
      ["a path as the program", { cmd: "/bin/sh" }],
      ["a NUL in an argument", { args: ["a\0b"] }],
      ["an empty argument", { args: [""] }],
      ["nine arguments", { args: Array.from({ length: 9 }, () => "x") }],
      ["a model rule", { networkPolicy: [{ host: "api.anthropic.com", purpose: "model", authHeader: "x-api-key" }] }],
      ["a second rule", { networkPolicy: [...POLICY, { host: "registry.npmjs.org", purpose: "package_registry" }] }],
      ["no rule", { networkPolicy: [] }],
      ["a model env", { env: buildSandboxEnv("executor") }],
      ["a 0 timeout", { timeoutMs: 0 }],
      ["a 1 hour timeout", { timeoutMs: 3_600_000 }],
    ];
    for (const [why, over] of bad) await expect(f.port.runCommand(handle, baseRun(over)), why).rejects.toThrow();
    expect(f.state.commands).toHaveLength(1);
  });

  it("runCommand: only a running pp- sandbox; a non-zero exit is a result; a hang is a timeout; a cut stream is flagged; a provider failure throws", async () => {
    const f = createFakeSandbox(noRuntime);
    await expect(f.port.runCommand({ runId: "", sandboxName: NAME }, baseRun())).rejects.toMatchObject({ status: 404 });
    await expect(f.port.runCommand({ runId: "", sandboxName: "rn-8-reviewer-run-1" }, baseRun())).rejects.toThrow(/pp-/);
    const { handle } = await created(f);
    f.scriptCommand(NAME, { exitCode: 3, stdout: "out", stderr: "err" });
    expect(await f.port.runCommand(handle, baseRun())).toMatchObject({ exitCode: 3, timedOut: false, stdout: "out", stderr: "err", truncated: false });
    f.scriptCommand(NAME, { hang: true });
    expect(await f.port.runCommand(handle, baseRun())).toMatchObject({ exitCode: null, timedOut: true });
    f.scriptCommand(NAME, { exitCode: 0, stdout: "x".repeat(RUN_COMMAND_MAX_OUTPUT_CHARS + 5) });
    const cut = await f.port.runCommand(handle, baseRun());
    expect(cut.truncated).toBe(true);
    expect(cut.stdout).toHaveLength(RUN_COMMAND_MAX_OUTPUT_CHARS);
    f.scriptCommand(NAME, { failStatus: 503 });
    await expect(f.port.runCommand(handle, baseRun())).rejects.toMatchObject({ status: 503 });
    await f.port.stop(handle);
    await expect(f.port.runCommand(handle, baseRun())).rejects.toMatchObject({ status: 409 });
  });

  it("writeFiles: a pp- sandbox only, directly under the publish directory; the mode and the bytes are recorded (hash); an agent sandbox never receives the file", async () => {
    const { f, handle } = await created();
    const hook = "export {};\n// bundled bytes\n";
    await f.port.writeFiles(handle, [{ path: PLANE_PUBLISH_HOOK_PATH, content: hook, mode: 0o555 }]);
    expect(f.state.writtenFiles).toEqual([{ sandboxName: NAME, path: PLANE_PUBLISH_HOOK_PATH, mode: 0o555, sha256: createHash("sha256").update(hook).digest("hex"), content: hook }]);
    for (const path of ["/fx/plane-publish/../x", "/fx/agent-config/hook.mjs", "/tmp/hook.mjs", "/fx/plane-publish/sub/hook.mjs", "/fx/plane-publish/"]) {
      await expect(f.port.writeFiles(handle, [{ path, content: "x" }]), path).rejects.toThrow();
    }
    await expect(f.port.writeFiles(handle, [{ path: PLANE_PUBLISH_HOOK_PATH, content: "x", mode: 0o4755 }])).rejects.toThrow(/mode/);
    for (const agent of ["ex-11111111-2222-4333-8444-555555555555-66666666-2222-4333-8444-555555555555-7", "rn-8-reviewer-run-1"]) {
      await expect(f.port.writeFiles({ runId: "", sandboxName: agent }, [{ path: PLANE_PUBLISH_HOOK_PATH, content: "x" }])).rejects.toThrow(/pp-/);
    }
    expect(f.state.writtenFiles).toHaveLength(1);
  });

  it("never launches an agent in a pp- sandbox, whatever the role or env (start and resume), and sends no command", async () => {
    const { f, handle } = await created();
    const agentOpts = { runId: "r", role: "executor", roleCard: "c", prompt: "p", model: "sonnet-5", capUsd: 1, networkPolicy: POLICY, env: buildSandboxEnv("executor"), onEvent: () => {} };
    expect(() => f.port.startDetached(handle, agentOpts)).toThrow(PublishSandboxAgentRefused);
    expect(() => f.port.resume(handle, "s", "p", agentOpts)).toThrow(PublishSandboxAgentRefused);
    expect(f.state.commands).toEqual([]);
  });

  it("never launches an agent for the publish role, with or without a model env", async () => {
    const { f, handle } = await created();
    const opts = { runId: "r", role: PLANE_PUBLISH_ROLE, roleCard: "", prompt: "", model: "sonnet-5", capUsd: 1, networkPolicy: POLICY, env: buildSandboxEnv(PLANE_PUBLISH_ROLE), onEvent: () => {} };
    expect(() => f.port.startDetached(handle, opts)).toThrow(PublishSandboxAgentRefused);
    expect(() => f.port.resume(handle, "s", "p", opts)).toThrow(PublishSandboxAgentRefused);
  });
});

describe("runPublishSandbox: deleted on every outcome (item 26)", () => {
  const ok = phaseLine({ phase: "pr_opened", branch: "fx/p-1", head_sha: "c".repeat(40), tip_sha: "d".repeat(40), pr_number: 7 });
  const run = (f: ReturnType<typeof createFakeSandbox>) => runPublishSandbox(f.port, { sandboxName: NAME, hook: "// hook", input: INPUT, networkPolicy: POLICY });
  const gone = (f: ReturnType<typeof createFakeSandbox>): void => {
    expect(f.state.stopped.map((h) => h.sandboxName)).toEqual([NAME]);
    expect(f.state.deleted.map((h) => h.sandboxName)).toEqual([NAME]);
  };

  it("success: 1 vCPU, no model connection, hook mode 0555 and input 0444, then stop and delete", async () => {
    const f = createFakeSandbox(noRuntime);
    f.scriptCommand(NAME, { exitCode: 0, stdout: `${phaseLine({ phase: "building" })}\nnoise\n${ok}\n` });
    const r = await run(f);
    expect(r).toMatchObject({ kind: "finished", terminal: { phase: "pr_opened", pr_number: 7 } });
    expect(f.state.created[0]).toMatchObject({ sandboxName: NAME, vcpus: 1, retention: { persistent: false } });
    expect(f.state.writtenFiles.map((w) => [w.path, w.mode])).toEqual([[PLANE_PUBLISH_HOOK_PATH, 0o555], [PLANE_PUBLISH_INPUT_PATH, 0o444]]);
    const cmd = f.state.commands[0]!;
    expect(cmd.env).toEqual({ ...SANDBOX_CA_ENV });
    expect(cmd.policyPurposes).toEqual(["github_proxy"]);
    expect(JSON.stringify([cmd.args, cmd.env])).not.toMatch(/ghs_|Bearer|token/i);
    gone(f);
  });

  it("refusal: a terminal refused line is a finished run, and the sandbox is still deleted", async () => {
    const f = createFakeSandbox(noRuntime);
    f.scriptCommand(NAME, { exitCode: 0, stdout: `${phaseLine({ phase: "refused", code: "scan_refused", refusals: [{ kind: "overlay_path", place: "docs/ops/plan.md", rule_key: "docs/ops/" }] })}\n` });
    expect(await run(f)).toMatchObject({ kind: "finished", terminal: { phase: "refused", code: "scan_refused" } });
    gone(f);
  });

  it("crash, timeout, cut output and a missing terminal line are all `crashed`, never read as success; each deletes", async () => {
    const cases: Array<[string, Parameters<ReturnType<typeof createFakeSandbox>["scriptCommand"]>[1], string]> = [
      ["non-zero exit", { exitCode: 1, stdout: `${ok}\n` }, "exit"],
      ["timeout", { hang: true }, "timeout"],
      ["cut output", { exitCode: 0, stdout: `${ok}\n${"x".repeat(RUN_COMMAND_MAX_OUTPUT_CHARS)}` }, "truncated"],
      ["no terminal line", { exitCode: 0, stdout: `${phaseLine({ phase: "building" })}\n` }, "no_terminal"],
      ["two terminal lines", { exitCode: 0, stdout: `${ok}\n${ok}\n` }, "no_terminal"],
    ];
    for (const [name, script, why] of cases) {
      const f = createFakeSandbox(noRuntime);
      f.scriptCommand(NAME, script);
      expect(await run(f), name).toMatchObject({ kind: "crashed", why });
      gone(f);
    }
  });

  it("a provider failure on the command, or on the file write, still stops and deletes, and the error reaches the caller", async () => {
    const f = createFakeSandbox(noRuntime);
    f.scriptCommand(NAME, { failStatus: 502 });
    await expect(run(f)).rejects.toMatchObject({ status: 502 });
    gone(f);
    const g = createFakeSandbox(noRuntime);
    await expect(runPublishSandbox(g.port, { sandboxName: NAME, hook: "x".repeat(9 * 1024 * 1024), input: INPUT, networkPolicy: POLICY })).rejects.toThrow(/too large/);
    expect(g.state.deleted.map((h) => h.sandboxName)).toEqual([NAME]);
  });

  it("a stop that throws still deletes, on a clean run and on a crash, and the result is not lost", async () => {
    for (const [script, kind] of [[{ exitCode: 0, stdout: `${ok}\n` }, "finished"], [{ exitCode: 1 }, "crashed"]] as const) {
      const f = createFakeSandbox(noRuntime);
      f.scriptCommand(NAME, script);
      const port = { ...f.port, stop: async () => { throw new Error("stop failed"); } };
      expect(await runPublishSandbox(port, { sandboxName: NAME, hook: "// hook", input: INPUT, networkPolicy: POLICY })).toMatchObject({ kind });
      expect(f.state.deleted.map((h) => h.sandboxName)).toEqual([NAME]);
    }
  });

  it("a second create for the same name is refused, and does not touch the first sandbox", async () => {
    const f = createFakeSandbox(noRuntime);
    await created(f);
    await expect(run(f)).rejects.toMatchObject({ status: 400 });
    expect(f.state.deleted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The real adapter, on a fake SDK
// ---------------------------------------------------------------------------------------------------------------------------------
function sdkFake() {
  const seen = { created: [] as SdkCreateParams[], commands: [] as Array<{ cmd: string; args?: string[]; env?: Record<string, string> }>, files: [] as Array<{ path: string; mode?: number }[]>, policies: [] as unknown[], killed: 0 };
  const knobs = { running: true, stdout: [] as Array<{ stream: string; data: unknown }>, exit: 0, hang: false, createStatus: undefined as number | undefined };
  const sandbox: SdkSandbox = {
    name: NAME,
    get status() {
      return knobs.running ? "running" : "stopped";
    },
    currentSession: () => ({ sessionId: "sess-1" }),
    async runCommand(params): Promise<SdkCommand> {
      seen.commands.push({ cmd: params.cmd, args: params.args, env: params.env });
      return {
        async *logs() {
          for (const e of knobs.stdout) yield e;
          if (knobs.hang) await new Promise<never>(() => undefined);
        },
        wait: async () => ({ exitCode: knobs.exit }),
        kill: async () => void seen.killed++,
      };
    },
    writeFiles: async (files) => void seen.files.push(files.map(({ path, mode }) => ({ path, mode }))),
    updateNetworkPolicy: async (p) => void seen.policies.push(p),
    extendTimeout: async () => undefined,
    stop: async () => undefined,
    delete: async () => undefined,
    async listSessions() {
      return { sessions: [], pagination: { next: null } };
    },
  };
  const sdk = {
    create: async (params: SdkCreateParams) => {
      if (knobs.createStatus) throw Object.assign(new Error("x"), { response: { status: knobs.createStatus } });
      seen.created.push(params);
      return sandbox;
    },
    get: async () => sandbox,
  };
  return { sdk, seen, knobs };
}
const adapter = (f: ReturnType<typeof sdkFake>, callTimeoutMs?: number) => createVercelSandboxPort({ teamId: "t", projectId: "p", getToken: async () => "tok", sdk: f.sdk, callTimeoutMs });
const handleOf = (): SandboxHandle => ({ runId: "", sandboxName: NAME });

describe("the real adapter on a fake SDK", () => {
  it("creates a pp- sandbox with resources.vcpus 1, non-persistent, no ports; an agent sandbox keeps 2", async () => {
    const f = sdkFake();
    await adapter(f).createSandbox({ sandboxName: NAME, retention: { persistent: false }, timeoutMs: 4_500_000, vcpus: 1 });
    expect(f.seen.created[0]).toMatchObject({ name: NAME, persistent: false, resources: { vcpus: 1 } });
    expect(f.seen.created[0]).not.toHaveProperty("ports");
    await expect(adapter(f).createSandbox({ sandboxName: NAME, retention: { persistent: false }, timeoutMs: 4_500_000 })).rejects.toThrow(/1 vCPU/);
  });

  it("a taken name (400 bad_request, and the name exists) is the busy error, not a reuse", async () => {
    const f = sdkFake();
    f.knobs.createStatus = 400;
    await expect(adapter(f).createSandbox({ sandboxName: NAME, retention: { persistent: false }, timeoutMs: 4_500_000, vcpus: 1 })).rejects.toBeInstanceOf(SandboxNameConflictError);
  });

  it("runCommand: policy first, then the program with its argv list; each argument is one literal element; both streams are read", async () => {
    const f = sdkFake();
    f.knobs.stdout = [{ stream: "stdout", data: "o1" }, { stream: "stderr", data: "e1" }, { stream: "stdout", data: 5 }];
    const nasty = ["a;b", "$(x)", "l1\nl2"];
    const r = await adapter(f).runCommand(handleOf(), baseRun({ args: nasty }));
    expect(r).toEqual({ exitCode: 0, timedOut: false, stdout: "o1", stderr: "e1", truncated: false, sessionId: "sess-1" });
    expect(f.seen.commands).toEqual([{ cmd: "node", args: nasty, env: { ...SANDBOX_CA_ENV } }]);
    expect(f.seen.policies).toHaveLength(1);
    expect(JSON.stringify(f.seen.policies[0])).toContain("https://gh-proxy.fulcrumaxe.app/api/gh-proxy");
    expect(JSON.stringify(f.seen.policies[0])).not.toMatch(/anthropic|ai-gateway/);
  });

  it("runCommand: a non-zero exit is a result; a cut stream is flagged; a hang is killed and reported as a timeout", async () => {
    const f = sdkFake();
    f.knobs.exit = 7;
    expect(await adapter(f).runCommand(handleOf(), baseRun())).toMatchObject({ exitCode: 7, timedOut: false });
    f.knobs.stdout = [{ stream: "stderr", data: "y".repeat(RUN_COMMAND_MAX_OUTPUT_CHARS + 1) }];
    const cut = await adapter(f).runCommand(handleOf(), baseRun());
    expect(cut.truncated).toBe(true);
    expect(cut.stderr).toHaveLength(RUN_COMMAND_MAX_OUTPUT_CHARS);
    f.knobs.stdout = [];
    f.knobs.hang = true;
    const hung = await adapter(f).runCommand(handleOf(), baseRun({ timeoutMs: 1_000 }));
    expect(hung).toMatchObject({ exitCode: null, timedOut: true });
    expect(f.seen.killed).toBe(1);
  });

  it("refuses what the fake refuses, and never wakes a stopped sandbox", async () => {
    const f = sdkFake();
    const port = adapter(f);
    await expect(port.runCommand(handleOf(), baseRun({ cmd: "sh" }))).rejects.toThrow(/program/);
    await expect(port.runCommand(handleOf(), baseRun({ networkPolicy: [] }))).rejects.toThrow(/proxy rule/);
    await expect(port.runCommand({ runId: "", sandboxName: "rn-8-reviewer-run-1" }, baseRun())).rejects.toThrow(/pp-/);
    f.knobs.running = false;
    await expect(port.runCommand(handleOf(), baseRun())).rejects.toBeInstanceOf(SandboxPortError);
    await expect(port.writeFiles(handleOf(), [{ path: PLANE_PUBLISH_HOOK_PATH, content: "x" }])).rejects.toBeInstanceOf(SandboxPortError);
    expect(f.seen.commands).toEqual([]);
  });

  it("writeFiles: the provider's file call, with the mode; an agent sandbox and a stray path are refused before any call", async () => {
    const f = sdkFake();
    const port = adapter(f);
    await port.writeFiles(handleOf(), [{ path: PLANE_PUBLISH_HOOK_PATH, content: "x", mode: 0o555 }, { path: PLANE_PUBLISH_INPUT_PATH, content: "{}" }]);
    expect(f.seen.files).toEqual([[{ path: PLANE_PUBLISH_HOOK_PATH, mode: 0o555 }, { path: PLANE_PUBLISH_INPUT_PATH, mode: undefined }]]);
    await expect(port.writeFiles({ runId: "", sandboxName: "rn-8-reviewer-run-1" }, [{ path: PLANE_PUBLISH_HOOK_PATH, content: "x" }])).rejects.toThrow(/pp-/);
    await expect(port.writeFiles(handleOf(), [{ path: "/tmp/x", content: "x" }])).rejects.toThrow(/publish directory/);
    expect(f.seen.files).toHaveLength(1);
  });

  it("never launches an agent in a pp- sandbox whatever the role (start and resume): no SDK call is made", async () => {
    const f = sdkFake();
    const agentOpts = { runId: "r", role: "executor", roleCard: "c", prompt: "p", model: "sonnet-5", capUsd: 1, networkPolicy: POLICY, env: buildSandboxEnv("executor"), onEvent: () => {} };
    expect(() => adapter(f).startDetached(handleOf(), agentOpts)).toThrow(PublishSandboxAgentRefused);
    expect(() => adapter(f).resume(handleOf(), "s", "p", agentOpts)).toThrow(PublishSandboxAgentRefused);
    expect(f.seen.commands).toEqual([]);
    expect(f.seen.files).toEqual([]);
  });

  it("never launches an agent for the publish role", () => {
    const f = sdkFake();
    const opts = { runId: "r", role: PLANE_PUBLISH_ROLE, roleCard: "", prompt: "", model: "sonnet-5", capUsd: 1, networkPolicy: POLICY, env: buildSandboxEnv(PLANE_PUBLISH_ROLE), onEvent: () => {} };
    expect(() => adapter(f).startDetached(handleOf(), opts)).toThrow(PublishSandboxAgentRefused);
  });

  it("the fake and the adapter have exactly the same method set (N5)", () => {
    const real = Object.keys(adapter(sdkFake())).sort();
    const fake = Object.keys(createFakeSandbox(noRuntime).port).sort();
    expect(fake).toEqual(real);
    expect(real).toEqual(expect.arrayContaining(["runCommand", "writeFiles"]));
  });
});

describe("a refused marked line makes the run a crash (D#598 P1f-5b)", () => {
  const TERMINAL = phaseLine({ phase: "no_change" });
  const BAD = '{"fx":"plane_publish","phase":"building","diff":"secret"}';
  const run = async (stdout: string) => {
    const f = createFakeSandbox(noRuntime);
    const port = { ...f.port, createSandbox: async (o: Parameters<typeof f.port.createSandbox>[0]) => { const h = await f.port.createSandbox(o); f.scriptCommand(o.sandboxName, { exitCode: 0, stdout }); return h; } };
    const r = await runPublishSandbox(port as typeof f.port, { sandboxName: NAME, hook: "// hook", input: INPUT, networkPolicy: POLICY });
    expect(f.state.deleted.map((h) => h.sandboxName)).toEqual([NAME]);
    return r;
  };

  it("the parser counts marked lines it refuses (unknown field, bad value, not JSON, past the cap) and drops unmarked noise silently", () => {
    expect(parsePhaseOutput(`${TERMINAL}\nnoise\n${BAD}\n{"fx":"plane_publish",oops\n`)).toMatchObject({ rejected: 2, lines: [{ phase: "no_change" }] });
    const many = Array.from({ length: 22 }, () => phaseLine({ phase: "building" })).join("\n");
    expect(parsePhaseOutput(many)).toMatchObject({ rejected: 2 });
    expect(parsePhaseOutput(`${TERMINAL}\nplain log line\n`).rejected).toBe(0);
  });

  it("a valid terminal line beside a refused marked line is crashed, never finished; the sandbox is still deleted", async () => {
    const r = await run(`${TERMINAL}\n${BAD}\n`);
    expect(r).toMatchObject({ kind: "crashed", why: "rejected_line" });
    expect(await run(`${TERMINAL}\n`)).toMatchObject({ kind: "finished" });
  });
});
