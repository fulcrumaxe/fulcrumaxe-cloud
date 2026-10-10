import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient, type Claimed } from "../../src/daemon/client.js";
import { createJobHandler, type JobHandlerDeps } from "../../src/daemon/jobHandler.js";
import { createEventRelay, type Clock } from "../../src/daemon/lease.js";
import { createFileLedger } from "../../src/daemon/ledger.js";
import { recordSession } from "../../src/engines/claude/session.js";
import { generateRunnerKey } from "../../src/keys.js";
import type { DepsInstaller, DepsOutcome } from "../../src/daemon/depsInstall.js";
import { DEPS_FAILED_NOTE, DEPS_INSTALLED_NOTE, DEPS_REGISTRY_NOTE } from "../../src/job/prompt.js";
import { roleToolsDigest } from "../../src/job/roleTools.js";
import { runJob, type RunJobDeps } from "../../src/job/runJob.js";
import { createWorkspaceStore } from "../../src/job/workspace.js";
import type { SandboxPort, StartDetachedOptions } from "../../src/sandbox/port.js";
import { fakeGitPath } from "../helpers/fakeGitPath.js";
import { ledgerOptions } from "../helpers/ledgerOptions.js";
import { jobFor, KEYRING, signRaw } from "../helpers/signedJob.js";
import { startStrictRunnerCloud, type StrictRunnerCloud } from "../helpers/strictRunnerCloud.js";

/** D#6 C44-4: the closed `deps_registry_not_allowed` detail and its one fixed prompt line, through the real job handler and prompt. */
const NPM = [{ kind: "domain", value: "registry.npmjs.org", access: "connect", reason: "install" }];
const OTHER = [{ kind: "domain", value: "example.com", access: "connect", reason: "docs" }];
const allowances = (entries: unknown[]) => ({ sandbox_allowances: { entries, command_timeout_s: 600 } as never });

let cloud: StrictRunnerCloud;
let root: string;
beforeEach(async () => {
  cloud = await startStrictRunnerCloud();
  root = mkdtempSync(path.join(tmpdir(), "fxc444-handler-"));
});
afterEach(async () => {
  await cloud.close();
  rmSync(root, { recursive: true, force: true });
});

const clock: Clock = { now: () => new Date(), sleep: (ms, signal) => new Promise<void>((resolve) => { if (signal.aborted) return resolve(); const t = setTimeout(resolve, Math.min(ms, 1)); signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true }); }) };

function rig(lockfile: ((workspace: string) => void) | undefined, kept?: string, depsInstall?: DepsInstaller) {
  const key = generateRunnerKey();
  cloud.trust(key.publicJwk);
  const client = createRunnerClient({ origin: cloud.origin, key, now: () => new Date(), fetchFn: fetch });
  const starts: StartDetachedOptions[] = [];
  const details: string[] = [];
  const port: SandboxPort = {
    async createSandbox(opts) { return { runId: "", sandboxName: opts.sandboxName }; },
    startDetached: (handle, opts) => {
      starts.push(opts);
      const event: NormalizedEvent = { runId: opts.runId, role: "executor", seq: 1, type: "result", ts: "2026-10-08T12:00:00.000Z", sessionId: "s1", agentOutput: { verdict: "done" } };
      return { handle, hookFired: Promise.resolve(event) };
    },
    resume: (handle, _sessionId, prompt, opts) => {
      starts.push({ ...opts, prompt } as StartDetachedOptions);
      const event: NormalizedEvent = { runId: opts.runId, role: "executor", seq: 1, type: "result", ts: "2026-10-08T12:00:00.000Z", sessionId: "s1", agentOutput: { verdict: "done" } };
      return { handle, hookFired: Promise.resolve(event) };
    },
    async extendTimeout() {}, async stop() {}, async deleteSandbox() {}, async measure() { return []; }, async readCounters() { return undefined; }, async sandboxExists() { return true; },
  };
  const run: Omit<RunJobDeps, "sandbox" | "ledger"> = { workspaces: createWorkspaceStore(path.join(root, "work")), credentials: { mode: "subscription" }, planSession: () => (kept === undefined ? { kind: "fresh", branch: null } : { kind: "resume", sessionId: "s1", workspace: kept }), defaultModel: "sonnet" };
  const git = fakeGitPath({ resume: async () => ({ base: "c".repeat(40) }), prepare: async (_job, _claimed, workspace) => { lockfile?.(workspace); return { base: "c".repeat(40) }; } });
  const deps: JobHandlerDeps = {
    client, keyring: KEYRING, clock, run, sandbox: port, ledger: createFileLedger(path.join(root, "jobs.json"), ledgerOptions()), git, events: createEventRelay(),
    recordSession: (id, workspace) => recordSession(path.join(root, "sessions.json"), id, workspace), heartbeatMs: 1e9, flushMs: 1e9, runJobFn: runJob,
    onDepsDetail: (detail) => details.push(detail),
    ...(depsInstall === undefined ? {} : { depsInstall, packageStoreRoot: path.join(root, "stores") }),
  };
  const handle = createJobHandler(deps);
  return {
    starts, details,
    stages: (): string[] => [...cloud.runs.values()].flatMap((run) => run.events).filter((e) => e.type === "stage").map((e) => String(e.stage)),
    async go(over: Parameters<typeof jobFor>[0]) {
      const role = over?.role ?? "executor";
      cloud.enqueue(signRaw(jobFor({ ...over, role_tools_sha256: roleToolsDigest(role) })) as never);
      const claimed = await client.claim();
      if (claimed.kind !== "claimed") throw new Error("expected a claim");
      return handle(claimed as Claimed);
    },
  };
}

const pnpmLock = (workspace: string): void => writeFileSync(path.join(workspace, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

describe("D#6 C44-4: deps_registry_not_allowed", () => {
  it("a lockfile and no registry host in the domains: the detail is recorded and the prompt gets the one fixed line; the job still runs", async () => {
    const r = rig(pnpmLock);
    expect((await r.go({ ...allowances(OTHER) })).status).toBe("completed");
    expect(r.details).toEqual(["deps_registry_not_allowed"]);
    expect(r.starts[0]!.prompt.split(DEPS_REGISTRY_NOTE).length - 1).toBe(1);
    expect(r.starts[0]!.prompt.indexOf(DEPS_REGISTRY_NOTE)).toBeLessThan(r.starts[0]!.prompt.indexOf("<untrusted>"));
  });

  it("a job with no signed allowances has no domains at all, so it gets the detail too", async () => {
    const r = rig(pnpmLock);
    expect((await r.go({})).status).toBe("completed");
    expect(r.details).toEqual(["deps_registry_not_allowed"]);
  });

  it("registry.npmjs.org allowed: neither the detail nor the line", async () => {
    const r = rig(pnpmLock);
    expect((await r.go({ ...allowances(NPM) })).status).toBe("completed");
    expect(r.details).toEqual([]);
    expect(r.starts[0]!.prompt).not.toContain(DEPS_REGISTRY_NOTE);
  });

  it("no lockfile: neither", async () => {
    const r = rig(undefined);
    expect((await r.go({ ...allowances(OTHER) })).status).toBe("completed");
    expect(r.details).toEqual([]);
    expect(r.starts[0]!.prompt).not.toContain(DEPS_REGISTRY_NOTE);
  });

  it("an empty lockfile (the sandbox's own stub) is not a lockfile", async () => {
    const empty = rig((workspace) => writeFileSync(path.join(workspace, "pnpm-lock.yaml"), ""));
    expect((await empty.go({ ...allowances(OTHER) })).status).toBe("completed");
    expect(empty.details).toEqual([]);
  });

  it("a lockfile that is a link is not followed, so it is not a lockfile", async () => {
    const linked = rig((workspace) => {
      writeFileSync(path.join(root, "elsewhere.yaml"), "lockfileVersion: '9.0'\n");
      symlinkSync(path.join(root, "elsewhere.yaml"), path.join(workspace, "pnpm-lock.yaml"));
    });
    expect((await linked.go({ ...allowances(OTHER) })).status).toBe("completed");
    expect(linked.details).toEqual([]);
  });

  it("package-lock.json counts as a lockfile", async () => {
    const r = rig((workspace) => writeFileSync(path.join(workspace, "package-lock.json"), "{}\n"));
    expect((await r.go({ ...allowances(OTHER) })).status).toBe("completed");
    expect(r.details).toEqual(["deps_registry_not_allowed"]);
  });

  it("a fix round that resumes its kept workspace gets the detail and the line too", async () => {
    const kept = path.join(root, "work", "kept");
    mkdirSync(kept, { recursive: true });
    pnpmLock(kept);
    const r = rig(undefined, kept);
    const continues = { parent_run_id: "33333333-3333-4333-8333-333333333333", session_id: "s1", branch: "fx/33333333-3333-4333-8333-333333333333-g1" };
    expect((await r.go({ ...allowances(OTHER), continues })).status).toBe("completed");
    expect(r.details).toEqual(["deps_registry_not_allowed"]);
    expect(r.starts[0]!.prompt).toContain(DEPS_REGISTRY_NOTE);
  });

  it("a role that does not run tests gets neither", async () => {
    const r = rig(pnpmLock);
    expect((await r.go({ role: "project-manager", ...allowances(OTHER) })).status).toBe("completed");
    expect(r.details).toEqual([]);
    expect(r.starts[0]!.prompt).not.toContain(DEPS_REGISTRY_NOTE);
  });
});

/** D#6 C44-4 (G-C44-7): the host-side install, through the real handler: the install runs after the clone and before the agent starts, marks one closed stage, and tells the agent in one fixed line. */
describe("D#6 C44-4: the host-side dependency install", () => {
  function installer(outcome: DepsOutcome) {
    const calls: Array<{ workspace: string; registryHost: string; storeDir: string }> = [];
    const stub: DepsInstaller = { async run(input) { calls.push({ workspace: input.workspace, registryHost: input.registryHost, storeDir: input.storeDir }); return outcome; } };
    return { stub, calls };
  }

  it("installed: runs once on the job workspace with the allowed registry host; stages go workspace_ready, cloned, deps_installed; the agent is told the install happened and scripts did not run", async () => {
    const { stub, calls } = installer({ kind: "installed" });
    const r = rig(pnpmLock, undefined, stub);
    expect((await r.go({ ...allowances(NPM) })).status).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.registryHost).toBe("registry.npmjs.org");
    // The job's own package store: the directory the host sandbox gives the agent as its store, so a later `pnpm exec` finds the same one.
    expect(path.dirname(calls[0]!.storeDir)).toBe(path.join(root, "stores"));
    expect(path.basename(calls[0]!.storeDir)).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.stages()).toEqual(["workspace_ready", "cloned", "deps_installed"]);
    const prompt = r.starts[0]!.prompt;
    expect(prompt.split(DEPS_INSTALLED_NOTE).length - 1).toBe(1);
    expect(prompt).not.toContain(DEPS_FAILED_NOTE);
    expect(prompt.indexOf(DEPS_INSTALLED_NOTE)).toBeLessThan(prompt.indexOf("<untrusted>"));
    expect(r.details).toEqual([]);
  });

  it("failed: stage deps_install_failed, the fixed failure line, and the run still completes", async () => {
    const { stub } = installer({ kind: "failed", why: "exit" });
    const r = rig(pnpmLock, undefined, stub);
    expect((await r.go({ ...allowances(NPM) })).status).toBe("completed");
    expect(r.stages()).toEqual(["workspace_ready", "cloned", "deps_install_failed"]);
    expect(r.starts[0]!.prompt).toContain(DEPS_FAILED_NOTE);
    expect(r.starts[0]!.prompt).not.toContain(DEPS_INSTALLED_NOTE);
  });

  it("refused: the closed detail deps_lockfile_refused, the failure stage and line; the run still completes", async () => {
    const { stub } = installer({ kind: "refused", reason: "other_host_tarball" });
    const r = rig(pnpmLock, undefined, stub);
    expect((await r.go({ ...allowances(NPM) })).status).toBe("completed");
    expect(r.details).toEqual(["deps_lockfile_refused"]);
    expect(r.stages()).toEqual(["workspace_ready", "cloned", "deps_install_failed"]);
    expect(r.starts[0]!.prompt).toContain(DEPS_FAILED_NOTE);
  });

  it("no lockfile: the installer says none, so no stage and no line", async () => {
    const { stub } = installer({ kind: "none" });
    const r = rig(undefined, undefined, stub);
    expect((await r.go({ ...allowances(NPM) })).status).toBe("completed");
    expect(r.stages()).toEqual(["workspace_ready", "cloned"]);
    expect(r.starts[0]!.prompt).not.toContain(DEPS_INSTALLED_NOTE);
    expect(r.starts[0]!.prompt).not.toContain(DEPS_FAILED_NOTE);
  });

  it("no registry host in the domains: the installer is not called, and the registry line stays (nothing downloads without an approved registry)", async () => {
    const { stub, calls } = installer({ kind: "installed" });
    const r = rig(pnpmLock, undefined, stub);
    expect((await r.go({ ...allowances(OTHER) })).status).toBe("completed");
    expect(calls).toHaveLength(0);
    expect(r.details).toEqual(["deps_registry_not_allowed"]);
    expect(r.stages()).toEqual(["workspace_ready", "cloned"]);
  });

  it("a role that does not run tests never installs", async () => {
    const { stub, calls } = installer({ kind: "installed" });
    const r = rig(pnpmLock, undefined, stub);
    expect((await r.go({ role: "project-manager", ...allowances(NPM) })).status).toBe("completed");
    expect(calls).toHaveLength(0);
    expect(r.stages()).toEqual(["workspace_ready", "cloned"]);
  });

  it("a fix round that resumes its kept workspace installs there too", async () => {
    const kept = path.join(root, "work", "kept");
    mkdirSync(kept, { recursive: true });
    pnpmLock(kept);
    const { stub, calls } = installer({ kind: "installed" });
    const r = rig(undefined, kept, stub);
    const continues = { parent_run_id: "33333333-3333-4333-8333-333333333333", session_id: "s1", branch: "fx/33333333-3333-4333-8333-333333333333-g1" };
    expect((await r.go({ ...allowances(NPM), continues })).status).toBe("completed");
    expect(calls.map((c) => c.workspace)).toEqual([kept]);
    expect(r.stages()).toEqual(["workspace_ready", "cloned", "deps_installed"]);
  });
});
