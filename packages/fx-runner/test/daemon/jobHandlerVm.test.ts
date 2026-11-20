import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient } from "../../src/daemon/client.js";
import type { CheckStepInput } from "../../src/daemon/checkStep.js";
import { createJobHandler, type JobHandlerDeps } from "../../src/daemon/jobHandler.js";
import { createEventRelay, type Clock } from "../../src/daemon/lease.js";
import { createFileLedger } from "../../src/daemon/ledger.js";
import { runJob, type RunJobDeps } from "../../src/job/runJob.js";
import { roleToolsDigest } from "../../src/job/roleTools.js";
import { createWorkspaceStore } from "../../src/job/workspace.js";
import { generateRunnerKey } from "../../src/keys.js";
import type { SandboxPort, StartDetachedOptions } from "../../src/sandbox/port.js";
import type { WorkspaceSource } from "../../src/vm/workspace/crossing.js";
import type { WorkspaceArchive } from "../../src/vm/workspace/guestWorkspace.js";
import { fakeGitPath } from "../helpers/fakeGitPath.js";
import { ledgerOptions } from "../helpers/ledgerOptions.js";
import { jobFor, KEYRING, signedJob } from "../helpers/signedJob.js";
import { startStrictRunnerCloud, type StrictRunnerCloud } from "../helpers/strictRunnerCloud.js";

const clock: Clock = { now: () => new Date(), sleep: (_ms, signal) => new Promise<void>((resolve) => (signal.aborted ? resolve() : setTimeout(resolve, 1))) };
const TIP = "a".repeat(40);
const CHECK = { argv: ["sh", "scripts/check.sh"], dev_shell: false, timeout_s: 60 };

let cloud: StrictRunnerCloud;
let root: string;
let rigs = 0;
beforeEach(async () => {
  cloud = await startStrictRunnerCloud();
  root = mkdtempSync(path.join(tmpdir(), "fxr-handler-vm-"));
});
afterEach(async () => {
  await cloud.close();
  rmSync(root, { recursive: true, force: true });
});

/** A port that records every call into `log` under its own name. */
function recordingPort(name: string, log: string[], starts: StartDetachedOptions[] = []): SandboxPort {
  const handle = { runId: "", sandboxName: `${name}-sb` };
  const event = (runId: string): NormalizedEvent => ({ runId, role: "executor", seq: 1, type: "result", ts: "2026-10-08T12:00:00.000Z", sessionId: "s", agentOutput: { verdict: "done" } });
  return {
    async createSandbox(opts) {
      log.push(`${name}.create`);
      return { ...handle, sandboxName: opts.sandboxName };
    },
    startDetached: (h, opts) => (log.push(`${name}.agent`), starts.push(opts), { handle: h, hookFired: Promise.resolve(event(opts.runId)) }),
    resume: () => {
      throw new Error("not used");
    },
    async extendTimeout() {},
    async stop() {
      log.push(`${name}.stop`);
    },
    async deleteSandbox() {
      log.push(`${name}.delete`);
    },
    async measure() {
      return [];
    },
    async readCounters() {
      return undefined;
    },
    async writeFiles() {},
    async runCommand(): Promise<never> {
      throw new Error("not used");
    },
    async sandboxExists() {
      return true;
    },
  };
}

function rig(over: { engine?: "microvm" | "os_sandbox"; noHost?: boolean; noVm?: boolean; withCheck?: boolean; tip?: string | null } = {}) {
  const key = generateRunnerKey();
  cloud.trust(key.publicJwk);
  const client = createRunnerClient({ origin: cloud.origin, key, now: () => new Date(), fetchFn: fetch });
  const log: string[] = [];
  const vmStarts: StartDetachedOptions[] = [];
  const hostStarts: StartDetachedOptions[] = [];
  const sources: Array<{ runId: string; source: WorkspaceSource }> = [];
  const archives: Array<{ mirror: string; commit: string }> = [];
  const checks: CheckStepInput[] = [];
  const makeGit = (name: string) => {
    const git = fakeGitPath({ readGrants: () => [`/mirrors/${name}/objects`] });
    git.mirrorDir = (job) => `/mirrors/${name}/${job.repo.id}.git`;
    git.tip = async (_job, workspace) => (log.push(`${name}.tip`), workspace === "" ? null : over.tip === undefined ? TIP : over.tip);
    git.checkBase = async () => "b".repeat(40);
    return git;
  };
  const vmPort = recordingPort("vm", log, vmStarts);
  const hostPort = recordingPort("host", log, hostStarts);
  const run: Omit<RunJobDeps, "sandbox" | "ledger"> = { workspaces: createWorkspaceStore(path.join(root, "work")), credentials: { mode: "subscription" }, planSession: () => ({ kind: "fresh", branch: null }), defaultModel: "sonnet" };
  const archive = { gz: Buffer.alloc(0), commit: TIP, commitText: Buffer.alloc(0), tree: "c".repeat(40), items: [] } as WorkspaceArchive;
  const deps: JobHandlerDeps = {
    client, keyring: KEYRING, clock, run, sandbox: vmPort, ledger: createFileLedger(path.join(root, `jobs-${++rigs}.json`), ledgerOptions()), git: makeGit("b"), gitA: makeGit("a"), events: createEventRelay(),
    recordSession: async () => {}, heartbeatMs: 1e9, flushMs: 1e9, runJobFn: runJob, browserReady: () => undefined,
    ...(over.engine === undefined ? { engine: "microvm" as const } : { engine: over.engine }),
    ...(over.noHost === true ? {} : { hostSandbox: hostPort }),
    ...(over.noVm === true ? {} : {
      vm: {
        crossing: { bind: (runId: string, source: WorkspaceSource) => (log.push("bind"), sources.push({ runId, source })), unbind: () => void log.push("unbind") },
        archive: async (mirror: string, commit: string) => (archives.push({ mirror, commit }), archive),
        quiesce: async () => void log.push("vm.quiesce"),
      },
    }),
    ...(over.withCheck === true ? {
      checkStep: async (input: CheckStepInput) => (log.push("check"), checks.push(input), { passed: true, body: { exit_code: 0, duration_ms: 1, timed_out: false, skipped_tests: null, summary: "" } }),
      checkLaunch: () => ({ tool: "guest", args: [], env: {} }),
      baseFile: async () => null,
    } : {}),
  };
  return {
    handler: createJobHandler(deps), log, vmStarts, hostStarts, sources, archives, checks,
    async claim(job: ReturnType<typeof jobFor>) {
      cloud.enqueue(signedJob(job));
      const claimed = await client.claim();
      if (claimed.kind !== "claimed") throw new Error("expected a claim");
      return claimed;
    },
  };
}
const verifier = () => jobFor({ role: "deploy-verifier", task: jobFor().task, role_tools_sha256: roleToolsDigest("deploy-verifier", "chrome_runner"), review: { head_sha: "d".repeat(40) } });

describe("a microVM runner: where each kind of job runs", () => {
  it("an executor job runs in the VM: the port is the microVM's, and the host port is never touched", async () => {
    const r = rig();
    expect((await r.handler(await r.claim(jobFor()))).status).toBe("completed");
    expect(r.log).toContain("vm.create");
    expect(r.log).toContain("vm.agent");
    expect(r.log.filter((l) => l.startsWith("host."))).toEqual([]);
  });

  it("a deploy-verifier job (it carries a browser method) goes to the host sandbox and never to the engine, and no workspace is bound", async () => {
    const r = rig();
    expect((await r.handler(await r.claim(verifier()))).status).toBe("completed");
    expect(r.log).toContain("host.create");
    expect(r.log).toContain("host.agent");
    expect(r.log.filter((l) => l.startsWith("vm.") || l === "bind")).toEqual([]);
    expect(r.hostStarts).toHaveLength(1);
    expect(r.vmStarts).toHaveLength(0);
  });

  it("with no host sandbox wired, a deploy-verifier job is refused (browser_not_connected) and nothing starts in either port", async () => {
    const r = rig({ noHost: true });
    expect(await r.handler(await r.claim(verifier()))).toEqual({ status: "failed", reason: "browser_not_connected" });
    expect(r.log).toEqual([]);
  });

  it("on an OS-sandbox runner nothing changes: one port runs every job, the mirror is a read grant, and no workspace is bound", async () => {
    const r = rig({ engine: "os_sandbox" });
    expect((await r.handler(await r.claim(jobFor()))).status).toBe("completed");
    expect(r.log.filter((l) => l.startsWith("host."))).toEqual([]);
    expect(r.vmStarts[0]?.extraReadPaths).toEqual(["/mirrors/b/objects"]);
    expect(r.log.includes("bind")).toBe(false);
  });

  it("a microVM runner built without the VM's workspace step refuses the job before any sandbox exists", async () => {
    const r = rig({ noVm: true });
    expect(await r.handler(await r.claim(jobFor()))).toEqual({ status: "failed", reason: "workspace_failed" });
    expect(r.log).toEqual([]);
  });
});

describe("the working copy's source for a microVM job", () => {
  it("is bound by run id before the VM exists, released when the run ends, and the mirror is not a read grant", async () => {
    const r = rig();
    const claimed = await r.claim(jobFor());
    await r.handler(claimed);
    expect(r.log.indexOf("bind")).toBeGreaterThanOrEqual(0);
    expect(r.log.indexOf("bind")).toBeLessThan(r.log.indexOf("vm.create"));
    expect(r.log.at(-1)).toBe("unbind");
    expect(r.sources[0]?.runId).toBe(claimed.runId);
    expect(r.vmStarts[0]?.extraReadPaths).toBeUndefined();
  });

  it("reads the start commit from the git path the way the push does, and builds the archive from that path's own mirror", async () => {
    const r = rig();
    await r.handler(await r.claim(jobFor()));
    const source = r.sources[0]?.source as WorkspaceSource;
    expect(await source.startCommit("/host/workspace")).toBe(TIP);
    await source.archive(TIP);
    expect(r.archives).toEqual([{ mirror: expect.stringMatching(/^\/mirrors\/b\//) as string, commit: TIP }]);
  });

  it("is the same for both runner modes: a local job and a verified job make the same calls, each through its own git path", async () => {
    const calls = async (mode: "local" | "verified") => {
      const r = rig();
      await r.handler(await r.claim(jobFor({ mode })));
      const source = r.sources[0]?.source as WorkspaceSource;
      await source.startCommit("/host/workspace");
      await source.archive(TIP);
      return { log: r.log.map((l) => l.replace(/^[ab]\./, "g.")), mirror: r.archives[0]?.mirror.split("/")[2] };
    };
    const local = await calls("local");
    const verified = await calls("verified");
    expect(local.mirror).toBe("b");
    expect(verified.mirror).toBe("a");
    expect(verified.log).toEqual(local.log);
  });

  it("a start commit that is not a full id, or that cannot be read, is refused rather than archived", async () => {
    for (const tip of ["main", "short", null]) {
      const r = rig({ tip });
      await r.handler(await r.claim(jobFor()));
      const source = r.sources[0]?.source as WorkspaceSource;
      await expect(source.startCommit("/host/workspace"), String(tip)).rejects.toMatchObject({ code: "workspace_failed" });
    }
  });
});

const bodies = (suffix: string): Array<Record<string, unknown>> => cloud.seen.filter((s) => s.path.endsWith(suffix)).map((s) => s.body as Record<string, unknown>);

describe("the approved check in a microVM job", () => {
  it("is closed with a fixed code: the check step is never called, so nothing runs in the agent's VM; the agent is quiesced (the VM kept) and the VM is stopped and deleted after", async () => {
    const r = rig({ withCheck: true });
    await r.handler(await r.claim(jobFor({ check: CHECK })));
    const order = r.log.filter((l) => ["vm.agent", "vm.quiesce", "check", "vm.stop", "vm.delete"].includes(l));
    expect(order).toEqual(["vm.agent", "vm.quiesce", "vm.stop", "vm.delete"]);
    expect(r.checks).toEqual([]);
    expect(bodies("/done")[0]?.check).toMatchObject({ exit_code: null, timed_out: false, reason: "not_set_up" });
    // the agent got the same vector as a deny entry, on its start
    expect(r.vmStarts[0]?.checkArgv).toEqual(CHECK.argv);
  });

  it("on an OS-sandbox runner the agent is stopped before the check, and the check runs, as before", async () => {
    const r = rig({ withCheck: true, engine: "os_sandbox" });
    await r.handler(await r.claim(jobFor({ check: CHECK })));
    const order = r.log.filter((l) => ["vm.agent", "vm.quiesce", "check", "vm.stop"].includes(l));
    expect(order).toEqual(["vm.agent", "vm.stop", "check", "vm.stop"]);
    expect(bodies("/done")[0]?.check).toMatchObject({ exit_code: 0 });
  });
});
