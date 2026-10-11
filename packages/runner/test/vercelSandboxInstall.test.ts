import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLAUDE_CLI_VERSION,
  PROMPT_WRAPPER,
  createVercelSandboxPort,
  type SdkCommand,
  type SdkCreateParams,
  type SdkSandbox,
  type VercelSandboxSdk,
} from "../src/vercelSandboxPort.js";
import type { SandboxHandle, StartDetachedOptions } from "../src/sandboxPort.js";
import { FORBIDDEN_ENV_NAME_PATTERN, buildSandboxEnv } from "../src/sandboxEnv.js";
import { networkPolicy } from "../src/networkPolicy.js";
import { retentionPolicyFor } from "../src/sandboxNaming.js";
import { FX_AGENT_MCP_PATH, FX_AGENT_SETTINGS_PATH, FX_LIMIT_HOOK_PATH, FX_RUN_LIMITS_PATH } from "../src/agentConfig.js";
import {
  DETECT_TOO_BIG,
  MAX_LOCKFILE_BYTES,
  registryOnly,
  DEPS_FAILED_LINE,
  DEPS_INSTALLED_LINE,
  DETECT_NONE,
  DETECT_NPM,
  DETECT_PNPM,
  DETECT_SCRIPT,
  DETECT_SKIP,
  INSTALL_SCRIPT,
  installEnv,
} from "../src/depsInstall.js";
import { keyedPolicy } from "./helpers/keyedPolicy.js";

/**
 * D#6 C44-6b: the cloud install phase. The fake below is strict about the order the real platform enforces: it tracks the
 * network policy in force and REFUSES an agent command while the install policy is active, and an install command that runs
 * under the run policy cannot reach the registry (exit 1). The detect and install scripts are also run for real, in `sh`.
 */

const NAME = "rn-8-reviewer-run-1";
const WORKDIR = "/vercel/sandbox/repo";
const REGISTRY = "registry.npmjs.org";
const GH_PROXY = "gh-proxy.fulcrumaxe.app";

type Lock = "pnpm" | "npm" | "none" | "installed";
interface Knobs {
  lock?: Lock;
  installExit?: number;
  installHangs?: boolean;
  /** 1-based index of the policy update that throws, and for how many consecutive updates. */
  failUpdate?: { at: number; times: number };
  /** A simulated postinstall run as the agent's own user: it rewrites a config file and/or replaces the CLI. */
  tamper?: { config?: boolean; cli?: boolean };
}

function fakeSdk(knobs: Knobs = {}) {
  const log: string[] = [];
  const envs: Record<string, Record<string, string> | undefined> = {};
  const writes: { path: string; content: string }[] = [];
  const killed: string[] = [];
  /** Config/pin events in order, kept apart from `log` so the order tests can see them. */
  const trace: string[] = [];
  /** The sandbox's files as they are on disk now; the agent command snapshots them when it is issued. */
  const disk: Record<string, string> = {};
  let agentSawDisk: Record<string, string> | undefined;
  let cliReplaced = false;
  let active: "run" | "install" | "unset" = "unset";
  let updates = 0;
  let failedInARow = 0;
  const sandbox: SdkSandbox = {
    name: NAME,
    status: "running",
    currentSession: () => ({ sessionId: "sess-1" }),
    async runCommand(params): Promise<SdkCommand> {
      const name = params.args?.[2];
      const isAgent = params.args?.[1] === PROMPT_WRAPPER;
      const label = isAgent ? "agent" : (name ?? "?");
      if (isAgent && active === "install") throw new Error("strict fake: an agent command was issued while the install policy is active");
      log.push(`cmd:${label}`);
      trace.push(`cmd:${label}`);
      if (isAgent) agentSawDisk = { ...disk };
      envs[label] = params.env;
      let exitCode = 0;
      let hang = false;
      let out = "";
      if (name === "fx-deps-detect") {
        const lock = knobs.lock ?? "none";
        // "installed" is a workspace carrying the marker: honoured on resume only (args: workdir, mode).
        const resume = params.args?.[4] === "resume";
        exitCode = lock === "pnpm" ? DETECT_PNPM : lock === "npm" ? DETECT_NPM : lock === "installed" ? (resume ? DETECT_SKIP : DETECT_PNPM) : DETECT_NONE;
      } else if (name === "fx-deps-install") {
        // The registry is reachable only under the install policy.
        exitCode = active === "install" ? (knobs.installExit ?? 0) : 1;
        hang = knobs.installHangs === true;
        if (knobs.tamper?.config) {
          disk[FX_AGENT_SETTINGS_PATH] = "TAMPERED";
          disk[FX_LIMIT_HOOK_PATH] = "TAMPERED";
        }
        if (knobs.tamper?.cli) cliReplaced = true;
        out = exitCode === 0 ? "" : `ERR_PNPM_FETCH_FAIL token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 registry unreachable\n`;
      }
      return {
        async *logs() {
          if (name === "fx-pin") yield { stream: "stdout", data: cliReplaced ? "0.0.1-evil\n" : `${CLAUDE_CLI_VERSION}\n` };
          if (hang) await new Promise(() => undefined);
          if (out !== "") yield { stream: "stderr", data: out };
          if (isAgent) await new Promise(() => undefined);
        },
        wait: async () => ({ exitCode }),
        kill: async () => {
          killed.push(label);
        },
      };
    },
    writeFiles: async (files) => {
      for (const f of files) {
        writes.push({ path: f.path, content: f.content });
        disk[f.path] = f.content;
      }
      trace.push("write:batch");
    },
    updateNetworkPolicy: async (policy) => {
      updates += 1;
      if (knobs.failUpdate && updates >= knobs.failUpdate.at && failedInARow < knobs.failUpdate.times) {
        failedInARow += 1;
        throw Object.assign(new Error("boom"), { response: { status: 500 } });
      }
      failedInARow = 0;
      const allow = typeof policy === "object" && policy.allow && !Array.isArray(policy.allow) ? Object.keys(policy.allow) : [];
      active = allow.includes(REGISTRY) ? "install" : "run";
      log.push(`firewall:${active}`);
    },
    extendTimeout: async () => undefined,
    stop: async () => undefined,
    delete: async () => undefined,
    listSessions: async () => ({ sessions: [], pagination: { next: null } }),
  };
  const sdk: VercelSandboxSdk = { create: async (params: SdkCreateParams) => (void params, sandbox), get: async () => sandbox };
  return { sdk, log, envs, writes, killed, trace, agentSaw: () => agentSawDisk };
}

const newPort = (sdk: VercelSandboxSdk, installTimeoutMs?: number) =>
  createVercelSandboxPort({ teamId: "t", projectId: "p", getToken: async () => "tok", sdk, measureRetryDelayMs: 0, ...(installTimeoutMs !== undefined && { installTimeoutMs }) });

const conn = { provider: "ai_gateway", githubForwardHost: GH_PROXY } as const;

function startOpts(overrides: Partial<StartDetachedOptions> = {}): StartDetachedOptions {
  return {
    runId: "run-1",
    role: "reviewer",
    roleCard: "card",
    prompt: "go",
    model: "sonnet-5",
    capUsd: 5,
    workdir: WORKDIR,
    networkPolicy: keyedPolicy(networkPolicy("reviewer", "team", conn)),
    installPolicy: async () => keyedPolicy(networkPolicy("reviewer", "team", conn, "install")),
    env: buildSandboxEnv("reviewer"),
    onEvent: () => {},
    ...overrides,
  };
}

async function launch(f: ReturnType<typeof fakeSdk>, overrides: Partial<StartDetachedOptions> = {}, installTimeoutMs?: number) {
  const port = newPort(f.sdk, installTimeoutMs);
  const made = await port.createSandbox({ sandboxName: NAME, retention: retentionPolicyFor("reviewer"), timeoutMs: 7_200_000 });
  const stages: string[] = [];
  const installs: unknown[] = [];
  const run = port.startDetached(made as SandboxHandle, startOpts({ onStage: (s) => void stages.push(s), onInstall: (r) => void installs.push(r), ...overrides }));
  return { run, stages, installs };
}

const registryRules = async () => registryOnly(keyedPolicy(networkPolicy("reviewer", "team", conn, "install")));
const sequence = (log: string[]): string[] => log.filter((l) => !l.startsWith("cmd:fx-pin"));
const lastPrompt = (f: ReturnType<typeof fakeSdk>): string => f.writes.filter((w) => w.path.startsWith("/tmp/fx-prompt-")).at(-1)!.content;

describe("order of the install phase", () => {
  it("pnpm lockfile: firewall(install), install, firewall(run), agent -- and the agent is never issued under the install policy", async () => {
    const f = fakeSdk({ lock: "pnpm" });
    const { run, stages, installs } = await launch(f);
    await run.launched;
    expect(sequence(f.log)).toEqual(["firewall:run", "cmd:fx-deps-detect", "firewall:install", "cmd:fx-deps-install", "firewall:run", "cmd:agent"]);
    expect(stages).toEqual(["sandbox_ready", "deps_installed"]);
    expect(installs).toEqual([{ outcome: "installed" }]);
    expect(lastPrompt(f)).toContain(DEPS_INSTALLED_LINE);
    expect(lastPrompt(f)).not.toContain("deps_install_failed");
  });

  it("npm lockfile runs the same sequence", async () => {
    const f = fakeSdk({ lock: "npm" });
    const { run } = await launch(f);
    await run.launched;
    expect(sequence(f.log)).toEqual(["firewall:run", "cmd:fx-deps-detect", "firewall:install", "cmd:fx-deps-install", "firewall:run", "cmd:agent"]);
  });

  it("the fake itself refuses an agent under the install policy (it cannot be looser than the platform)", async () => {
    const f = fakeSdk();
    const made = await newPort(f.sdk).createSandbox({ sandboxName: NAME, retention: retentionPolicyFor("reviewer"), timeoutMs: 7_200_000 });
    void made;
    const sandbox = await f.sdk.get({ name: NAME } as never);
    await sandbox.updateNetworkPolicy({ allow: { [REGISTRY]: [] } } as never);
    await expect(sandbox.runCommand({ cmd: "sh", args: ["-c", PROMPT_WRAPPER, "x"], detached: true })).rejects.toThrow(/strict fake/);
  });

  it("no lockfile: no install command and the firewall is never set to install", async () => {
    const f = fakeSdk({ lock: "none" });
    const { run, stages, installs } = await launch(f);
    await run.launched;
    expect(sequence(f.log)).toEqual(["firewall:run", "cmd:fx-deps-detect", "cmd:agent"]);
    expect(stages).toEqual(["sandbox_ready"]);
    expect(installs).toEqual([]);
    expect(lastPrompt(f)).not.toContain("ependencies were");
  });

  it("a run without an installPolicy does no detect and no install", async () => {
    const f = fakeSdk({ lock: "pnpm" });
    const { run } = await launch(f, { installPolicy: undefined });
    await run.launched;
    expect(sequence(f.log)).toEqual(["firewall:run", "cmd:agent"]);
  });

  it("a resumed workspace already installed from the same lockfile skips the install and the policy change", async () => {
    const f = fakeSdk({ lock: "installed" });
    const port = newPort(f.sdk);
    const made = await port.createSandbox({ sandboxName: NAME, retention: retentionPolicyFor("reviewer"), timeoutMs: 7_200_000 });
    const stages: string[] = [];
    const run = port.resume(made as SandboxHandle, "cc-session-1", "again", startOpts({ onStage: (s) => void stages.push(s) }));
    await run.launched;
    expect(sequence(f.log)).toEqual(["firewall:run", "cmd:fx-deps-detect", "cmd:agent"]);
    expect(stages).toEqual(["sandbox_ready", "deps_installed"]);
    expect(lastPrompt(f)).toContain(DEPS_INSTALLED_LINE);
  });

  it("the marker is not honoured on a fresh run: a repo that ships its own marker is still installed from", async () => {
    const f = fakeSdk({ lock: "installed" });
    const { run } = await launch(f);
    await run.launched;
    expect(sequence(f.log)).toEqual(["firewall:run", "cmd:fx-deps-detect", "firewall:install", "cmd:fx-deps-install", "firewall:run", "cmd:agent"]);
  });

  it("the install policy is built only when an install is due", async () => {
    let built = 0;
    const installPolicy = async () => (built++, keyedPolicy(networkPolicy("reviewer", "team", conn, "install")));
    const none = fakeSdk({ lock: "none" });
    await (await launch(none, { installPolicy })).run.launched;
    expect(built).toBe(0);
    const pnpm = fakeSdk({ lock: "pnpm" });
    await (await launch(pnpm, { installPolicy })).run.launched;
    expect(built).toBe(1);
  });
});

describe("the agent is started from what the runner wrote, not from what the install left", () => {
  const CONFIG_PATHS = [FX_AGENT_SETTINGS_PATH, FX_AGENT_MCP_PATH, FX_LIMIT_HOOK_PATH, FX_RUN_LIMITS_PATH];

  it("after the install, and before the agent: the CLI pin is checked again and the whole config batch is written again", async () => {
    const f = fakeSdk({ lock: "pnpm" });
    const { run } = await launch(f);
    await run.launched;
    const afterInstall = f.trace.slice(f.trace.indexOf("cmd:fx-deps-install") + 1);
    expect(afterInstall).toEqual(["cmd:fx-pin", "write:batch", "cmd:agent"]);
    // The batch written after the install carries every config path and the prompt.
    const lastBatch = f.writes.slice(-CONFIG_PATHS.length - 1);
    expect(lastBatch.map((w) => w.path).filter((p) => CONFIG_PATHS.includes(p)).sort()).toEqual([...CONFIG_PATHS].sort());
    expect(lastBatch.some((w) => w.path.startsWith("/tmp/fx-prompt-"))).toBe(true);
  });

  it("a postinstall that rewrites the settings and the limit hook: the agent command sees the runner's versions", async () => {
    const f = fakeSdk({ lock: "pnpm", tamper: { config: true } });
    const { run } = await launch(f);
    await run.launched;
    const seen = f.agentSaw()!;
    expect(seen[FX_AGENT_SETTINGS_PATH]).not.toBe("TAMPERED");
    expect(seen[FX_LIMIT_HOOK_PATH]).not.toBe("TAMPERED");
    expect(JSON.parse(seen[FX_AGENT_SETTINGS_PATH]!)).toBeTypeOf("object");
  });

  it("a postinstall that replaces the CLI: the pin check fails, the launch is refused and no agent command is issued", async () => {
    const f = fakeSdk({ lock: "pnpm", tamper: { cli: true } });
    const { run } = await launch(f);
    await expect(run.launched).rejects.toBeTruthy();
    await expect(run.hookFired).rejects.toBeTruthy();
    expect(f.log).not.toContain("cmd:agent");
    expect(f.log.filter((l) => l.startsWith("firewall:")).at(-1)).toBe("firewall:run"); // the run firewall was back before the refusal
  });

  it("a failed install gets the same re-check and rewrite", async () => {
    const f = fakeSdk({ lock: "pnpm", installExit: 1, tamper: { config: true } });
    const { run } = await launch(f);
    await run.launched;
    expect(f.trace.slice(f.trace.indexOf("cmd:fx-deps-install") + 1)).toEqual(["cmd:fx-pin", "write:batch", "cmd:agent"]);
    expect(f.agentSaw()![FX_AGENT_SETTINGS_PATH]).not.toBe("TAMPERED");
  });

  it("no lockfile: nothing ran, so no second pin check and no second write", async () => {
    const f = fakeSdk({ lock: "none" });
    const { run } = await launch(f);
    await run.launched;
    expect(f.trace.filter((t) => t === "write:batch")).toHaveLength(1);
    expect(f.trace.filter((t) => t === "cmd:fx-pin")).toHaveLength(1);
  });
});

describe("the install-phase firewall is the registries only", () => {
  it("registryOnly drops the model host (with its key) and the GitHub proxy", () => {
    const rules = keyedPolicy(networkPolicy("reviewer", "team", conn, "install"));
    expect(rules.some((r) => r.purpose === "model")).toBe(true);
    const only = registryOnly(rules);
    expect(only.length).toBeGreaterThan(0);
    expect(only.every((r) => r.purpose === "package_registry")).toBe(true);
    expect(only.map((r) => r.host)).toContain(REGISTRY);
  });

  it("the port applies exactly the rules it is given: the install policy reaches the sandbox without the model host or the proxy", async () => {
    const applied: string[][] = [];
    const f = fakeSdk({ lock: "pnpm" });
    const sandbox = await f.sdk.get({ name: NAME } as never);
    const original = sandbox.updateNetworkPolicy.bind(sandbox);
    sandbox.updateNetworkPolicy = async (policy, o) => {
      applied.push(typeof policy === "object" && policy.allow && !Array.isArray(policy.allow) ? Object.keys(policy.allow) : []);
      return original(policy, o);
    };
    const { run } = await launch(f, { installPolicy: registryRules });
    await run.launched;
    expect(applied).toHaveLength(3);
    expect(applied[1]).toContain(REGISTRY);
    expect(applied[1]).not.toContain("api.anthropic.com");
    expect(applied[1]).not.toContain("api.github.com");
    expect(applied[0]).toContain("api.github.com"); // the run policy still has them
  });
});

describe("the install command's environment", () => {
  it("holds no model-key, token or secret name, none of the run env's values, and keeps its caches inside the workspace", async () => {
    const f = fakeSdk({ lock: "pnpm" });
    const { run } = await launch(f);
    await run.launched;
    const env = f.envs["fx-deps-install"]!;
    expect(env).toBeDefined();
    for (const name of Object.keys(env)) expect(FORBIDDEN_ENV_NAME_PATTERN.test(name), name).toBe(false);
    expect(Object.keys(env)).not.toContain("ANTHROPIC_API_KEY");
    expect(Object.keys(env)).not.toContain("ANTHROPIC_AUTH_TOKEN");
    const values = Object.values(env).join("\n");
    expect(values).not.toContain("brokered-at-firewall");
    expect(f.envs["fx-deps-detect"]).toEqual(env);
  });

  it("installEnv puts the store and cache under the workspace and stops pnpm fetching another pnpm", () => {
    const env = installEnv(WORKDIR);
    expect(env.npm_config_store_dir.startsWith(`${WORKDIR}/node_modules/`)).toBe(true);
    expect(env.npm_config_cache.startsWith(`${WORKDIR}/node_modules/`)).toBe(true);
    expect(env.npm_config_manage_package_manager_versions).toBe("false");
  });
});

describe("a failed install is a named outcome and never leaves the install firewall open", () => {
  it("non-zero exit: firewall back to run before the agent, deps_install_failed to the agent, the stage and the observer", async () => {
    const f = fakeSdk({ lock: "pnpm", installExit: 1 });
    const { run, stages, installs } = await launch(f);
    await run.launched;
    expect(sequence(f.log)).toEqual(["firewall:run", "cmd:fx-deps-detect", "firewall:install", "cmd:fx-deps-install", "firewall:run", "cmd:agent"]);
    expect(stages).toEqual(["sandbox_ready", "deps_install_failed"]);
    expect(lastPrompt(f)).toContain(DEPS_FAILED_LINE);
    expect(lastPrompt(f)).toContain("deps_install_failed");
    const r = installs[0] as { outcome: string; exitCode: number; tail: string };
    expect(r.outcome).toBe("failed");
    expect(r.exitCode).toBe(1);
    // The held tail is redacted and capped before it goes anywhere.
    expect(r.tail).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(r.tail.length).toBeLessThanOrEqual(500);
  });

  it("timeout: the install command is killed, the firewall is put back, the agent still starts", async () => {
    const f = fakeSdk({ lock: "pnpm", installHangs: true });
    const { run, stages } = await launch(f, {}, 25);
    await run.launched;
    expect(f.killed).toContain("fx-deps-install");
    expect(sequence(f.log)).toEqual(["firewall:run", "cmd:fx-deps-detect", "firewall:install", "cmd:fx-deps-install", "firewall:run", "cmd:agent"]);
    expect(stages).toEqual(["sandbox_ready", "deps_install_failed"]);
    expect(lastPrompt(f)).toContain(DEPS_FAILED_LINE);
  });

  it("the install firewall cannot be applied: reported as failed, run firewall restored, agent still starts", async () => {
    // Updates: 1 = initial run policy, 2 = install policy (throws), 3 = run policy restored.
    const f = fakeSdk({ lock: "pnpm", failUpdate: { at: 2, times: 1 } });
    const { run, stages } = await launch(f);
    await run.launched;
    expect(sequence(f.log)).toEqual(["firewall:run", "cmd:fx-deps-detect", "firewall:run", "cmd:agent"]);
    expect(stages).toEqual(["sandbox_ready", "deps_install_failed"]);
  });

  it("the install policy cannot be built: no firewall change, reported as failed", async () => {
    const f = fakeSdk({ lock: "pnpm" });
    const { run, stages } = await launch(f, { installPolicy: async () => Promise.reject(new Error("dns")) });
    await run.launched;
    expect(sequence(f.log)).toEqual(["firewall:run", "cmd:fx-deps-detect", "cmd:agent"]);
    expect(stages).toEqual(["sandbox_ready", "deps_install_failed"]);
  });

  it("the run firewall cannot be restored (twice): the launch fails and no agent command is ever issued", async () => {
    // Updates: 1 = run, 2 = install, 3 and 4 = the restore and its one retry (both throw).
    const f = fakeSdk({ lock: "pnpm", failUpdate: { at: 3, times: 2 } });
    const { run } = await launch(f);
    await expect(run.launched).rejects.toBeTruthy();
    await expect(run.hookFired).rejects.toBeTruthy();
    expect(f.log).not.toContain("cmd:agent");
  });

  it("the restore succeeding on its retry carries on", async () => {
    const f = fakeSdk({ lock: "pnpm", failUpdate: { at: 3, times: 1 } });
    const { run } = await launch(f);
    await run.launched;
    expect(sequence(f.log).at(-2)).toBe("firewall:run");
    expect(sequence(f.log).at(-1)).toBe("cmd:agent");
  });
});

describe("the fixed scripts, run for real in sh", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = (): string => {
    const d = mkdtempSync(path.join(tmpdir(), "c446b-"));
    dirs.push(d);
    return d;
  };
  const detect = (ws: string, mode = "fresh"): number => {
    try {
      execFileSync("sh", ["-c", DETECT_SCRIPT, "fx-deps-detect", ws, mode], { stdio: "pipe" });
      return 0;
    } catch (err) {
      return (err as { status: number }).status;
    }
  };

  it("detects pnpm first, then npm, ignoring empty files, links, and a missing workspace", () => {
    const ws = tmp();
    expect(detect(ws)).toBe(DETECT_NONE);
    expect(detect(path.join(ws, "missing"))).toBe(DETECT_NONE);
    writeFileSync(path.join(ws, "pnpm-lock.yaml"), "");
    expect(detect(ws)).toBe(DETECT_NONE);
    writeFileSync(path.join(ws, "package-lock.json"), "{}");
    expect(detect(ws)).toBe(DETECT_NPM);
    writeFileSync(path.join(ws, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    expect(detect(ws)).toBe(DETECT_PNPM);
    rmSync(path.join(ws, "pnpm-lock.yaml"));
    rmSync(path.join(ws, "package-lock.json"));
    writeFileSync(path.join(ws, "real"), "lockfileVersion: 9\n");
    symlinkSync(path.join(ws, "real"), path.join(ws, "pnpm-lock.yaml"));
    expect(detect(ws)).toBe(DETECT_NONE);
  });

  it("installs with the frozen commands, leaves the marker, and skips when the lockfile is unchanged; a changed lockfile installs again", () => {
    const ws = tmp();
    const bin = tmp();
    const calls = path.join(bin, "calls.txt");
    for (const tool of ["pnpm", "npm"]) {
      writeFileSync(path.join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "${calls}"\n`);
      chmodSync(path.join(bin, tool), 0o755);
    }
    const run = (script: string, ...args: string[]): number => {
      try {
        execFileSync("sh", ["-c", script, "x", ...args], { env: { PATH: `${bin}:${process.env.PATH ?? ""}` }, stdio: "pipe" });
        return 0;
      } catch (err) {
        return (err as { status: number }).status;
      }
    };
    writeFileSync(path.join(ws, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    expect(run(DETECT_SCRIPT, ws, "fresh")).toBe(DETECT_PNPM);
    expect(run(INSTALL_SCRIPT, ws, "pnpm")).toBe(0);
    const pnpmCall = readFileSync(calls, "utf8").trim();
    expect(pnpmCall).toContain("pnpm install --frozen-lockfile");
    expect(pnpmCall).toContain("--config.manage-package-manager-versions=false");
    expect(pnpmCall).toContain(`--config.store-dir=${ws}/node_modules/.pnpm-store`);
    expect(pnpmCall).toContain(`--config.cache-dir=${ws}/node_modules/.pnpm-cache`);
    expect(readFileSync(path.join(ws, "node_modules/.fx-lockhash"), "utf8")).toMatch(/^pnpm:[0-9a-f]{64}$/);
    // The marker counts on a resumed workspace only.
    expect(run(DETECT_SCRIPT, ws, "resume")).toBe(DETECT_SKIP);
    expect(run(DETECT_SCRIPT, ws, "fresh")).toBe(DETECT_PNPM);
    writeFileSync(path.join(ws, "pnpm-lock.yaml"), "lockfileVersion: 9\nchanged: true\n");
    expect(run(DETECT_SCRIPT, ws, "resume")).toBe(DETECT_PNPM);
    // npm: `npm ci`, never `npm install`.
    const ws2 = tmp();
    writeFileSync(path.join(ws2, "package-lock.json"), "{}");
    expect(run(INSTALL_SCRIPT, ws2, "npm")).toBe(0);
    const npmCall = readFileSync(calls, "utf8").trim().split("\n").at(-1)!;
    expect(npmCall).toContain("npm ci");
    expect(npmCall).toContain(`--cache ${ws2}/node_modules/.npm-cache`);
    // An unknown manager is refused, and a failing install leaves no marker.
    expect(run(INSTALL_SCRIPT, ws2, "yarn")).toBe(2);
    const ws3 = tmp();
    writeFileSync(path.join(ws3, "pnpm-lock.yaml"), "x: 1\n");
    writeFileSync(path.join(bin, "pnpm"), "#!/bin/sh\nexit 3\n");
    expect(run(INSTALL_SCRIPT, ws3, "pnpm")).toBe(3);
    expect(() => readFileSync(path.join(ws3, "node_modules/.fx-lockhash"))).toThrow();
  });

  it("a lockfile over the size bound is not read or installed from", () => {
    const ws = tmp();
    writeFileSync(path.join(ws, "pnpm-lock.yaml"), Buffer.alloc(MAX_LOCKFILE_BYTES + 1, 97));
    expect(detect(ws)).toBe(DETECT_TOO_BIG);
    writeFileSync(path.join(ws, "pnpm-lock.yaml"), Buffer.alloc(MAX_LOCKFILE_BYTES, 97));
    expect(detect(ws)).toBe(DETECT_PNPM);
  });

  it("writes nothing but under the workspace's node_modules: no home, no absolute path other than the workspace", () => {
    for (const script of [DETECT_SCRIPT, INSTALL_SCRIPT]) {
      expect(script).not.toMatch(/\$HOME|~|\/tmp|\/usr|\/opt|\/root/);
    }
  });
});
