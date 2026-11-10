import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { BROWSER_CHROME_CAPABILITY, DEPLOY_ORDER_CAPABILITY, DEPLOY_VERIFIER_BROWSER_TOOLS, DEPLOY_VERIFIER_DENIED_BROWSER_TOOLS, DEPLOY_VERIFIER_ROLE, VERIFIER_READ_GUARD_SCRIPT } from "@fulcrumaxe/runner-protocol";
import { createAdmission } from "../src/daemon/admission.js";
import { pollLoop, type PollEvent } from "../src/daemon/pollLoop.js";
import { instantClock } from "./helpers/manualClock.js";
import { OPEN_GATE } from "./helpers/openGate.js";
import type { Claimed } from "../src/daemon/client.js";
import { createVerifyLocal } from "../src/daemon/verifyLocal.js";
import { mcpConfigFor, settingsFor, writeJobFiles } from "../src/engines/claude/settingsFile.js";
import { roleToolsFor } from "../src/job/roleTools.js";
import { protectedPaths } from "../src/sandbox/sandboxSettings.js";
import { setSetting } from "../src/runnerSettings.js";
import { signedJob, jobFor } from "./helpers/signedJob.js";
import { socketTmpRoot } from "./helpers/tmpRoot.js";

/** D#749 V2b: the capability decision, the role's settings file, and the one-browser-job admission rule. */
const UID = process.getuid?.() ?? 0;
const root = mkdtempSync(path.join(socketTmpRoot(), "dv-local-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe("capabilities are advertised only when configured AND the check passes", () => {
  let stateDir: string;
  let tmp: string;
  let running: Array<{ pid: number; comm: string; args: string }>;
  let checkout: string;
  beforeEach(() => {
    const base = mkdtempSync(path.join(root, "c-"));
    stateDir = path.join(base, "state");
    tmp = path.join(base, "t");
    running = [];
    checkout = path.join(base, "repo");
    for (const dir of [stateDir, tmp, checkout]) mkdirSync(dir, { mode: 0o755 });
    writeFileSync(path.join(checkout, "deploy.sh"), "#!/bin/sh\n", { mode: 0o755 });
  });
  const local = (capture = true) => createVerifyLocal({ stateDir, uid: UID, username: "tester", env: {}, capture: capture ? (async () => ({ code: 0, tail: "", timedOut: false, aborted: false })) : undefined, platform: "linux", probe: { tmpRoot: tmp, processes: async () => running } });
  async function chromeUp(): Promise<void> {
    running = [{ pid: 1, comm: "chrome", args: "chrome" }, { pid: 2, comm: "claude", args: "claude --chrome-native-host" }];
    mkdirSync(path.join(tmp, "claude-mcp-browser-bridge-tester"), { mode: 0o700 });
    const server = net.createServer();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(path.join(tmp, "claude-mcp-browser-bridge-tester", "2.sock"), resolve));
  }

  it("nothing is advertised until the owner sets something, and a browser job is refused with the closed code", async () => {
    expect(await local().capabilities()).toEqual([]);
    expect(await local().browserReady()).toBe("browser_not_connected");
  });

  it("the deploy order needs the command, the checkout and a script that passes; the browser needs the account and a connected Chrome", async () => {
    const v = local();
    setSetting(stateDir, "verify.deploy_argv", '["sh","deploy.sh"]');
    expect(await v.capabilities()).toEqual([]);
    setSetting(stateDir, "verify.deploy_dir", checkout);
    expect(await v.capabilities()).toEqual([DEPLOY_ORDER_CAPABILITY]);
    expect(await local(false).capabilities()).toEqual([]);
    setSetting(stateDir, "verify.deploy_argv", '["sh","missing.sh"]');
    expect(await v.capabilities()).toEqual([]);
    setSetting(stateDir, "verify.deploy_argv", '["sh","deploy.sh"]');
    setSetting(stateDir, "verify.test_account", "fx-test-user");
    expect(await v.capabilities()).toEqual([DEPLOY_ORDER_CAPABILITY]);
    expect(await v.probe()).toEqual({ ok: false, reason: "chrome_not_running" });
    await chromeUp();
    expect(await v.capabilities()).toEqual([BROWSER_CHROME_CAPABILITY, DEPLOY_ORDER_CAPABILITY]);
    expect(await v.browserReady()).toBeUndefined();
  });

  it("a capability the cloud refused is not offered again, and the other stays", async () => {
    await chromeUp();
    setSetting(stateDir, "verify.test_account", "fx-test-user");
    setSetting(stateDir, "verify.deploy_argv", '["sh","deploy.sh"]');
    setSetting(stateDir, "verify.deploy_dir", checkout);
    const v = local();
    v.refuse([BROWSER_CHROME_CAPABILITY]);
    expect(await v.capabilities()).toEqual([DEPLOY_ORDER_CAPABILITY]);
  });

  it("the handler exists only where the engine has a process-group capture", () => {
    const client = { deployOrderClaim: async () => ({ kind: "none" as const, retryAfter: 1 }), deployOrderReport: async () => ({ kind: "recorded" as const }) };
    expect(local(true).deployOrderHandler(client)).toBeTypeOf("function");
    expect(local(false).deployOrderHandler(client)).toBeUndefined();
  });
});

describe("the deploy verifier's settings file", () => {
  const SANDBOX = { enabled: true, filesystem: { denyRead: ["~"] } };
  const protectedList = protectedPaths({ home: path.join(root, "home"), stateDir: path.join(root, "home", ".fx-runner"), binaryDir: path.join(root, "bin") });
  const ws = path.join(root, "ws");
  const settings = () => settingsFor(DEPLOY_VERIFIER_ROLE, SANDBOX, ws, protectedList) as { disableAllHooks: boolean; hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> }; permissions: { allow: string[]; deny: string[] } };

  it("allows the confined reads and the nine browser tools, and no shell, edit, write or web tool", () => {
    const { allow } = settings().permissions;
    expect(allow).toEqual([`Read(/${ws})`, `Read(/${ws}/**)`, ...DEPLOY_VERIFIER_BROWSER_TOOLS]);
    expect(allow.join(" ")).not.toMatch(/Bash|Edit|Write|NotebookEdit|WebFetch|WebSearch/);
  });

  it("denies the checkout's dot-git and dot-env files, and the five extension tools it is never given", () => {
    const { deny } = settings().permissions;
    expect(deny).toEqual(expect.arrayContaining([`Read(/${ws}/.git)`, `Read(/${ws}/.git/**)`, `Read(/${ws}/.env*)`, `Read(/${ws}/**/.env*)`, ...DEPLOY_VERIFIER_DENIED_BROWSER_TOOLS]));
    for (const never of DEPLOY_VERIFIER_DENIED_BROWSER_TOOLS) expect(settings().permissions.allow).not.toContain(never);
  });

  it("runs the shared read guard as its one hook, like the other confined roles", () => {
    const s = settings();
    expect(s.disableAllHooks).toBe(false);
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.PreToolUse[0]!.matcher).toBe("Read|Glob|Grep");
    expect(s.hooks.PreToolUse[0]!.hooks[0]!.command).toContain(VERIFIER_READ_GUARD_SCRIPT.slice(0, 40));
  });

  it("every other role gets an empty MCP file, this one included; the browser comes by the command-line flag", () => {
    for (const role of ["executor", "code-reviewer", DEPLOY_VERIFIER_ROLE]) expect(mcpConfigFor({ role })).toEqual({ mcpServers: {} });
    mkdirSync(ws, { recursive: true });
    const files = writeJobFiles(path.join(root, "job"), ws, DEPLOY_VERIFIER_ROLE, SANDBOX, protectedList);
    expect(files.settings["permissions"]).toBeDefined();
    expect(roleToolsFor(DEPLOY_VERIFIER_ROLE).length).toBe(3 + DEPLOY_VERIFIER_BROWSER_TOOLS.length);
  });
});

describe("a machine holds one browser job at a time", () => {
  const claimed = (role: string): Claimed => {
    const signed = role === DEPLOY_VERIFIER_ROLE ? signedJob({ role, task: jobFor().task, review: { head_sha: "b".repeat(40) } }) : signedJob();
    return { kind: "claimed", signedJob: signed, runId: signed.job.run_id, leaseGeneration: 1 };
  };
  const admission = () =>
    createAdmission({
      probe: { read: () => ({ totalMemBytes: 64 * 2 ** 30, availMemBytes: 60 * 2 ** 30, cores: 16, load1: 0, load5: 0, freeDiskBytes: undefined }) } as never,
      footprints: { classEstimate: () => ({ memBytes: 2 ** 30, cores: 1 }), estimate: () => ({ memBytes: 2 ** 30, cores: 1 }), record: () => undefined } as never,
      settings: () => ({ ceilingTotal: 8, ceilingHeavy: 4, budget: { light: { memoryGb: 2, tasks: 512 }, heavy: { memoryGb: 6, tasks: 4096 } } }),
      paused: () => false,
      now: () => 0,
      every: () => () => undefined,
    });

  it("the second browser job is full while one is in hand; a job of another role never is; the slot frees when the first ends", () => {
    const a = admission();
    const first = claimed(DEPLOY_VERIFIER_ROLE);
    expect(a.browserSlotFull!(first)).toBe(false);
    const end = a.begin(first);
    expect(a.browserSlotFull!(claimed(DEPLOY_VERIFIER_ROLE))).toBe(true);
    expect(a.browserSlotFull!(claimed("executor"))).toBe(false);
    end();
    expect(a.browserSlotFull!(claimed(DEPLOY_VERIFIER_ROLE))).toBe(false);
  });
});

describe("the poll loop refuses a second browser job while one is in hand", () => {
  const browser = () => {
    const signed = signedJob({ role: DEPLOY_VERIFIER_ROLE, task: jobFor().task, review: { head_sha: "b".repeat(40) } });
    return { kind: "claimed" as const, signedJob: signed, runId: signed.job.run_id, leaseGeneration: 1 };
  };
  const admission = () =>
    createAdmission({
      probe: { read: () => ({ totalMemBytes: 64 * 2 ** 30, availMemBytes: 60 * 2 ** 30, cores: 16, load1: 0, load5: 0, freeDiskBytes: undefined }) } as never,
      footprints: { classEstimate: () => ({ memBytes: 2 ** 30, cores: 1 }), estimate: () => ({ memBytes: 2 ** 30, cores: 1 }), record: () => undefined } as never,
      settings: () => ({ ceilingTotal: 8, ceilingHeavy: 4, budget: { light: { memoryGb: 2, tasks: 512 }, heavy: { memoryGb: 6, tasks: 4096 } } }),
      paused: () => false,
      now: () => 0,
      every: () => () => undefined,
    });

  async function loop(held: boolean) {
    const a = admission();
    if (held) a.begin(browser());
    const controller = new AbortController();
    const replies = [browser()];
    const log: PollEvent[] = [];
    const started: string[] = [];
    const client = { async claim() { const next = replies.shift(); if (next === undefined) { controller.abort(); return { kind: "idle" as const, retryAfter: 1 }; } return next; } };
    await pollLoop({ client, clock: instantClock(), gate: OPEN_GATE, signal: controller.signal, admission: a, onClaimed: async (c) => void started.push(c.runId), log: (e) => log.push(e), random: () => 1 });
    return { log, started };
  }

  it("with a browser job already in hand the second is logged refused/browser_slot_full and never started", async () => {
    const r = await loop(true);
    expect(r.log.filter((e) => e.event === "refused")).toEqual([{ event: "refused", runId: expect.any(String), reason: "browser_slot_full" }]);
    expect(r.started).toEqual([]);
  });

  it("control: with none in hand the same claim is started", async () => {
    const r = await loop(false);
    expect(r.started).toHaveLength(1);
    expect(r.log.some((e) => e.event === "refused")).toBe(false);
  });
});
