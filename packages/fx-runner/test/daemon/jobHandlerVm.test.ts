import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient } from "../../src/daemon/client.js";
import type { CheckOutcome, CheckStepInput } from "../../src/daemon/checkStep.js";
import type { FreshCheckInput } from "../../src/vm/workspace/guestCheck.js";
import { createJobHandler, type JobHandlerDeps } from "../../src/daemon/jobHandler.js";
import { createEventRelay, type Clock } from "../../src/daemon/lease.js";
import { createFileLedger } from "../../src/daemon/ledger.js";
import { DEFAULT_WALL_CLOCK_MS, runJob, SANDBOX_MARGIN_MS, type RunJobDeps } from "../../src/job/runJob.js";
import { roleToolsDigest } from "../../src/job/roleTools.js";
import { createWorkspaceStore } from "../../src/job/workspace.js";
import { VmRegistry } from "../../src/vm/jobLifecycle.js";
import { createMicrovmVmPort } from "../../src/vm/sandboxd/vmPort.js";
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

/** What the VM side of the rig can be made to do wrong. A create fails for the agent's VM (`rn-`) or the check VM (`rc-`). */
interface Faults {
  create?: "agent" | "check";
  state?: "stopped";
  guest?: true;
  stop?: true;
  deleteAgent?: true;
  agentFails?: true;
  hang?: () => void;
  quiesce?: true;
  release?: true;
  teardownOk?: false;
}

/** A port that records every call into `log` under its own name. */
function recordingPort(name: string, log: string[], starts: StartDetachedOptions[] = [], retentions: boolean[] = [], faults: Faults = {}): SandboxPort {
  const handle = { runId: "", sandboxName: `${name}-sb` };
  const event = (runId: string): NormalizedEvent => ({ runId, role: "executor", seq: 1, type: "result", ts: "2026-10-08T12:00:00.000Z", sessionId: "s", agentOutput: { verdict: "done" } });
  return {
    async createSandbox(opts) {
      log.push(`${name}.create`);
      retentions.push(opts.retention.persistent);
      if (faults.create !== undefined && opts.sandboxName.startsWith(faults.create === "agent" ? "rn-" : "rc-")) throw new Error("/home/sentinel/secret refused");
      return { ...handle, sandboxName: opts.sandboxName };
    },
    startDetached: (h, opts) => {
      log.push(`${name}.agent`);
      starts.push(opts);
      if (faults.hang !== undefined) {
        faults.hang();
        return { handle: h, hookFired: new Promise<never>(() => undefined) };
      }
      return { handle: h, hookFired: faults.agentFails === true ? Promise.reject(new Error("agent died")) : Promise.resolve(event(opts.runId)) };
    },
    resume: (h, _s, _p, opts) => (log.push(`${name}.resume`), { handle: h, hookFired: Promise.resolve(event(opts.runId)) }),
    async extendTimeout() {},
    async stop() {
      log.push(`${name}.stop`);
      if (faults.stop === true) throw new Error("stop refused");
    },
    async deleteSandbox(h) {
      log.push(`${name}.delete`);
      if (faults.deleteAgent === true && h.sandboxName.startsWith("rn-")) throw new Error("delete refused");
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
    async sandboxState() {
      return faults.state ?? "running";
    },
    async guestOf() {
      if (faults.guest === true) throw new Error("no guest");
      return { name: "guest" } as never;
    },
  } as SandboxPort & { guestOf: () => Promise<never> };
}

function rig(over: { portTimeouts?: number[]; portRunIds?: string[]; wallClockMs?: number; engine?: "microvm" | "os_sandbox"; noHost?: boolean; noVm?: boolean; withCheck?: boolean; tip?: string | null; bundle?: Buffer; collectError?: string; persistent?: boolean; faults?: Faults; maxVms?: number; shutdown?: AbortSignal; token?: { needed: () => boolean; slot: (vm: string, log: string[]) => { deliver(): Promise<void>; wipe(): Promise<void> } | undefined }; resume?: boolean; fresh?: "pass" | "fail" | "none"; changed?: string[] | null; derived?: { table: unknown; files: Record<string, string> }; steps?: string[]; sleeps?: number[]; lockSeen?: Array<{ manifest: string | null; placeholderPresent: boolean }> } = {}) {
  const key = generateRunnerKey();
  cloud.trust(key.publicJwk);
  const client = createRunnerClient({ origin: cloud.origin, key, now: () => new Date(), fetchFn: fetch });
  const log: string[] = [];
  const vmStarts: StartDetachedOptions[] = [];
  const hostStarts: StartDetachedOptions[] = [];
  const sources: Array<{ runId: string; source: WorkspaceSource }> = [];
  const archives: Array<{ mirror: string; commit: string }> = [];
  const checks: CheckStepInput[] = [];
  const freshChecks: FreshCheckInput[] = [];
  const freshHandles: string[] = [];
  const applied: Array<{ bundle: Buffer; base: string; mirrorDir: string; workspace: string }> = [];
  const gits: Array<ReturnType<typeof fakeGitPath>> = [];
  const makeGit = (name: string) => {
    const git = fakeGitPath({ readGrants: () => [`/mirrors/${name}/objects`] });
    git.mirrorDir = (job) => `/mirrors/${name}/${job.repo.id}.git`;
    git.tip = async (_job, workspace) => (log.push(`${name}.tip`), workspace === "" ? null : over.tip === undefined ? TIP : over.tip);
    git.checkBase = async () => "b".repeat(40);
    gits.push(git);
    return git;
  };
  const retentions: boolean[] = [];
  const faults: Faults = over.faults ?? {};
  const vmPort = recordingPort("vm", log, vmStarts, retentions, faults);
  const hostPort = recordingPort("host", log, hostStarts);
  // the production VM factory over the recording port: every VM the lifecycle makes, stops and ends shows in `log` as `vm.create`, `vm.stop`, `vm.delete`
  const factory = (timeoutMs: number) => createMicrovmVmPort({ sandbox: vmPort as never, daemon: { teardown: async () => (log.push("vm.teardown"), faults.teardownOk !== false), get: async () => ({}) as never }, bindings: { bind: (name: string) => (log.push(`bind:${name.slice(0, 3)}`), {} as never), unbind: (name: string) => void log.push(`unbind:${name.slice(0, 3)}`) }, policy: { release: async (id: string) => { log.push(`release:${id.slice(0, 3)}`); if (faults.release === true) throw new Error("socket stuck"); } }, idOf: (name) => name, timeoutMs, ...(over.persistent === true ? { persistent: true } : {}) });
  const lifecycle = {
    // a function when the test watches the per-job limit the handler asks the factory for; the plain port otherwise (both shapes are the handler's to take)
    port: over.portTimeouts === undefined ? factory(60_000) : (options: { timeoutMs: number; runId: string }) => (over.portTimeouts?.push(options.timeoutMs), over.portRunIds?.push(options.runId), factory(options.timeoutMs)),
    registry: new VmRegistry(),
    caps: { maxVms: over.maxVms ?? 2, maxVcpus: 4, maxMemoryMb: 4096, snapshotDir: "/var/lib/fx/snap", snapshotQuotaBytes: 10 ** 12 },
    request: { vcpus: 1, memoryMb: 1024 },
    readMemAvailableBytes: () => 16 * 1024 ** 3,
    ...(over.token === undefined ? {} : { token: { needed: over.token.needed, slot: (vm: string) => over.token?.slot(vm, log) } }),
  };
  const run: Omit<RunJobDeps, "sandbox" | "ledger"> = { ...(over.wallClockMs === undefined ? {} : { wallClockMs: over.wallClockMs }), workspaces: createWorkspaceStore(path.join(root, "work")), credentials: { mode: "subscription" }, planSession: () => (over.resume === true ? { kind: "resume", sessionId: "old", workspace: path.join(root, "work", "old") } : { kind: "fresh", branch: null }), defaultModel: "sonnet" };
  const archive = { gz: Buffer.alloc(0), commit: TIP, commitText: Buffer.alloc(0), tree: "c".repeat(40), items: [] } as WorkspaceArchive;
  const rigClock: Clock = over.sleeps === undefined ? clock : { now: clock.now, sleep: (ms, signal) => (over.sleeps?.push(ms), clock.sleep(ms, signal)) };
  const deps: JobHandlerDeps = {
    client, keyring: KEYRING, clock: rigClock, run, sandbox: vmPort, ledger: createFileLedger(path.join(root, `jobs-${++rigs}.json`), ledgerOptions()), git: makeGit("b"), gitA: makeGit("a"), events: createEventRelay(),
    recordSession: async () => {}, heartbeatMs: 1e9, flushMs: 1e9, runJobFn: runJob, browserReady: () => undefined,
    ...(over.steps === undefined ? {} : { onStep: (line: string) => void over.steps?.push(line) }),
    ...(over.shutdown === undefined ? {} : { shutdown: over.shutdown }),
    ...(over.engine === undefined ? { engine: "microvm" as const } : { engine: over.engine }),
    ...(over.noHost === true ? {} : { hostSandbox: hostPort }),
    ...(over.noVm === true ? {} : {
      vm: {
        crossing: { bind: (runId: string, source: WorkspaceSource) => (log.push("bind"), sources.push({ runId, source })), unbind: () => void log.push("unbind"), collect: async () => {
          log.push("collect");
          if (over.collectError !== undefined) throw Object.assign(new Error("refused"), { code: over.collectError });
          return over.bundle === undefined ? null : { bundle: over.bundle, base: TIP };
        } },
        guestOf: async () => ({ name: "guest" }) as never,
        apply: async (input: { bundle: Buffer; base: string; mirrorDir: string; workspace: string }) => {
          log.push("apply");
          applied.push(input);
          // what the agent's commits brought: the generated files named by the test sit in the host workspace
          if (over.lockSeen !== undefined) {
            // the commits' manifest, and an empty placeholder the CLI's scrubbing made (a name the stub clearing removes when it is empty and was not there before the run)
            writeFileSync(path.join(input.workspace, "package.json"), '{"name":"from-the-agent"}\n');
            writeFileSync(path.join(input.workspace, ".npmrc"), "");
          }
          for (const [rel, text] of Object.entries(over.derived?.files ?? {})) {
            mkdirSync(path.dirname(path.join(input.workspace, rel)), { recursive: true });
            writeFileSync(path.join(input.workspace, rel), text);
          }
          return { tip: "f".repeat(40), commits: 1 };
        },
        archive: async (mirror: string, commit: string) => (archives.push({ mirror, commit }), archive),
        quiesce: async () => {
          log.push("vm.quiesce");
          if (faults.quiesce === true) throw new Error("agent would not stop");
        },
        lifecycle,
        ...(over.persistent === true ? { persistent: true } : {}),
        ...(over.withCheck === true && over.fresh !== "none" ? { freshCheck: async (input: FreshCheckInput, vm: { sandboxName: string }): Promise<CheckOutcome> => (log.push("fresh_check"), freshChecks.push(input), freshHandles.push(vm.sandboxName), over.fresh === "fail" ? { passed: false, body: { exit_code: 1, duration_ms: 2, timed_out: false, skipped_tests: null, summary: "failed in the fresh VM" } } : { passed: true, body: { exit_code: 0, duration_ms: 1, timed_out: false, skipped_tests: null, summary: "" } }) } : {}),
      },
    }),
    ...(over.lockSeen === undefined ? {} : {
      lockfileSync: { run: async (input: { workspace: string }) => (log.push("lockfile"), over.lockSeen?.push({ manifest: existsSync(path.join(input.workspace, "package.json")) ? readFileSync(path.join(input.workspace, "package.json"), "utf8") : null, placeholderPresent: existsSync(path.join(input.workspace, ".npmrc")) }), { kind: "none" as const }) },
    }),
    ...(over.withCheck === true ? {
      checkStep: async (input: CheckStepInput) => (log.push("check"), checks.push(input), { passed: true, body: { exit_code: 0, duration_ms: 1, timed_out: false, skipped_tests: null, summary: "" } }),
      checkLaunch: () => ({ tool: "guest", args: [], env: {} }),
      baseFile: async (_dir: string, _base: string, relative: string) => (over.derived !== undefined && relative === ".fulcrumaxe/derived-files.json" ? Buffer.from(JSON.stringify(over.derived.table)) : null),
    } : {}),
    ...(over.derived === undefined ? {} : { headBlob: async (_workspace: string, relative: string) => (over.derived?.files[relative] === undefined ? null : Buffer.from(over.derived.files[relative] as string)), indexHidesChanges: async () => false }),
    ...(over.changed === undefined ? {} : { changedFiles: async (workspace: string, base: string) => (base === "HEAD" ? [] : (log.push(`changed:${workspace}`), over.changed ?? null)) }),
  };
  return {
    handler: createJobHandler(deps), log, lifecycle, retentions, gits, vmStarts, hostStarts, sources, archives, checks, freshChecks, freshHandles, applied,
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

describe("the approved check in a microVM job runs in a fresh VM, after the host has the agent's commits", () => {
  const BUNDLE = Buffer.from("bundle");

  it("the agent is quiesced, its commits are read out, its VM is stopped, the commits are brought in, then the check runs in a fresh VM; the host check step is never called, and both VMs are deleted after", async () => {
    const r = rig({ withCheck: true, bundle: BUNDLE });
    await r.handler(await r.claim(jobFor({ check: CHECK })));
    const order = r.log.filter((l) => ["vm.create", "vm.agent", "vm.quiesce", "collect", "apply", "fresh_check", "check", "vm.stop", "vm.delete"].includes(l));
    // the agent's VM is stopped before the check VM exists (so a cap of one VM never deadlocks); the check VM is the second create
    expect(order).toEqual(["vm.create", "vm.agent", "vm.quiesce", "collect", "vm.stop", "apply", "vm.create", "fresh_check", "vm.delete", "vm.delete"]);
    expect(r.checks).toEqual([]);
    expect(bodies("/done")[0]?.check).toMatchObject({ exit_code: 0, timed_out: false });
    // the agent got the same vector as a deny entry, on its start
    expect(r.vmStarts[0]?.checkArgv).toEqual(CHECK.argv);
  });

  it("is given the host's own facts and nothing of the agent's VM: the run id, the host workspace and its tip (read by the host), the check, and the network rules the agent had", async () => {
    const r = rig({ withCheck: true, bundle: BUNDLE });
    const claimed = await r.claim(jobFor({ check: CHECK }));
    await r.handler(claimed);
    expect(r.freshChecks).toHaveLength(1);
    const input = r.freshChecks[0] as FreshCheckInput;
    expect(input.runId).toBe(claimed.runId);
    expect(input.tip).toBe(TIP);
    expect(input.repoDir).toContain(path.join(root, "work"));
    expect(input.check.argv).toEqual(CHECK.argv);
    expect(input.networkPolicy).toEqual(r.vmStarts[0]?.networkPolicy);
    expect(input.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(Object.keys(input).sort())).toBe(JSON.stringify(["baseFile", "check", "networkPolicy", "repoDir", "runId", "signal", "tip"]));
  });

  it("the host decides: a check that fails in the fresh VM is the job's failed check, and one that passes is its pass", async () => {
    const bad = rig({ withCheck: true, bundle: BUNDLE, fresh: "fail" });
    await bad.handler(await bad.claim(jobFor({ check: CHECK })));
    expect(bodies("/done")[0]?.check).toMatchObject({ exit_code: 1, summary: "failed in the fresh VM" });
  });

  it("with no way to run it the check is closed (not_set_up): nothing runs in the agent's VM or on the host", async () => {
    const r = rig({ withCheck: true, bundle: BUNDLE, fresh: "none" });
    await r.handler(await r.claim(jobFor({ check: CHECK })));
    expect(r.checks).toEqual([]);
    expect(r.freshChecks).toEqual([]);
    expect(bodies("/done")[0]?.check).toMatchObject({ exit_code: null, timed_out: false, reason: "not_set_up" });
  });

  it("a tip the host cannot read as a full commit id is start_failed and the check is not run", async () => {
    for (const tip of ["main", null]) {
      const r = rig({ withCheck: true, bundle: BUNDLE, tip });
      await r.handler(await r.claim(jobFor({ check: CHECK })));
      expect(r.freshChecks, String(tip)).toEqual([]);
      expect(bodies("/done").at(-1)?.check, String(tip)).toMatchObject({ exit_code: null, reason: "start_failed" });
    }
  });

  it("the host steps read the host copy the commits were brought into: a VM job whose commits change a file outside the Spec's list ends out_of_scope and no check is run", async () => {
    const r = rig({ withCheck: true, bundle: BUNDLE, changed: ["src/a.ts", "infra/prod/plan.tf"] });
    await r.handler(await r.claim(jobFor({ check: CHECK, scope: ["src/**"] })));
    expect(bodies("/done")[0]?.check).toMatchObject({ reason: "out_of_scope", summary: "the check was not run: 1 changed file is outside the Spec's file list" });
    expect(r.freshChecks).toEqual([]);
    // the listing was made after the commits were brought in, on the host workspace
    expect(r.log.findIndex((l) => l.startsWith("changed:"))).toBeGreaterThan(r.log.indexOf("apply"));
    expect(r.log.find((l) => l.startsWith("changed:"))).toContain(path.join(root, "work"));
    // and inside the list the check runs
    const inside = rig({ withCheck: true, bundle: BUNDLE, changed: ["src/a.ts"] });
    await inside.handler(await inside.claim(jobFor({ check: CHECK, scope: ["src/**"] })));
    expect(inside.freshChecks).toHaveLength(1);
  });

  it("a generated file beside a listed route is never lifted out of the scope count in a VM run: its generators would run in a VM whose output stays there", async () => {
    const ROUTE = "api/src/routes/runs.ts";
    const table = { version: 1, rules: [{ id: "routes", kind: "generated", inputs: ["api/src/routes/**"], outputs: ["api/openapi.json"], generators: [["gen-openapi"]] }] };
    const steps: string[] = [];
    const r = rig({ withCheck: true, bundle: BUNDLE, steps, changed: [ROUTE, "api/openapi.json"], derived: { table, files: { "api/openapi.json": "doc\n" } } });
    await r.handler(await r.claim(jobFor({ check: CHECK, scope: [ROUTE] })));
    expect(r.checks).toEqual([]);
    expect(r.freshChecks).toEqual([]);
    expect(r.log).not.toContain("check");
    expect(steps.some((l) => l.includes("generated files not lifted"))).toBe(true);
    expect(bodies("/done")[0]?.check).toMatchObject({ reason: "out_of_scope", summary: "the check was not run: 1 changed file is outside the Spec's file list" });
  });

  it("a review-fix round that did commit is not no_change (the tip is read after the commits came in); one that did not is", async () => {
    const continues = { parent_run_id: "22222222-2222-4222-8222-222222222222", session_id: null, branch: "fx/issue-12", pr_number: 7 };
    const fix = () => jobFor({ check: CHECK, continues, task: { ...jobFor().task, kind: "fix" }, fix_round_kind: "review_fix" } as never);
    const committed = rig({ withCheck: true, bundle: BUNDLE, tip: TIP });
    await committed.handler(await committed.claim(fix()));
    expect(committed.freshChecks).toHaveLength(1);
    const idle = rig({ withCheck: true, tip: "0".repeat(40) });
    await idle.handler(await idle.claim(fix()));
    expect(idle.freshChecks).toEqual([]);
    expect(bodies("/done").at(-1)?.check).toMatchObject({ reason: "no_change" });
  });

  it("on an OS-sandbox runner the agent is stopped before the check, and the host check runs, as before", async () => {
    const r = rig({ withCheck: true, engine: "os_sandbox" });
    await r.handler(await r.claim(jobFor({ check: CHECK })));
    const order = r.log.filter((l) => ["vm.agent", "vm.quiesce", "fresh_check", "check", "vm.stop"].includes(l));
    expect(order).toEqual(["vm.agent", "vm.stop", "check", "vm.stop"]);
    expect(bodies("/done")[0]?.check).toMatchObject({ exit_code: 0 });
  });
});

describe("the agent's commits come out of the guest before anything on the host reads the workspace", () => {
  const BUNDLE = Buffer.from("bundle");

  it("the agent is quiesced, then the bundle is collected and applied to the host workspace against the commit the run started from, then the check runs", async () => {
    const r = rig({ withCheck: true, bundle: BUNDLE });
    await r.handler(await r.claim(jobFor({ check: CHECK })));
    expect(r.log.filter((l) => ["vm.agent", "vm.quiesce", "collect", "apply", "fresh_check", "vm.stop", "vm.delete"].includes(l))).toEqual(["vm.agent", "vm.quiesce", "collect", "vm.stop", "apply", "fresh_check", "vm.delete", "vm.delete"]);
    expect(r.applied).toHaveLength(1);
    expect(r.applied[0]).toMatchObject({ bundle: BUNDLE, base: TIP, mirrorDir: expect.stringMatching(/^\/mirrors\/b\//) as string });
    expect(r.applied[0]?.workspace).toContain(path.join(root, "work"));
  });

  it("the stub clearing and the lockfile update act on the tree the commits were brought into, not the one before: both run after apply", async () => {
    const lockSeen: Array<{ manifest: string | null; placeholderPresent: boolean }> = [];
    const r = rig({ withCheck: true, bundle: BUNDLE, lockSeen });
    await r.handler(await r.claim(jobFor({ check: CHECK })));
    expect(r.log.indexOf("lockfile")).toBeGreaterThan(r.log.indexOf("apply"));
    // the update saw the manifest the commits brought in, and the placeholder made by that step was already cleared
    expect(lockSeen).toEqual([{ manifest: '{"name":"from-the-agent"}\n', placeholderPresent: false }]);
  });

  it("with no check the commits still come out: a run that publishes needs them", async () => {
    const r = rig({ bundle: BUNDLE });
    await r.handler(await r.claim(jobFor()));
    expect(r.log.filter((l) => ["vm.agent", "vm.quiesce", "collect", "apply"].includes(l))).toEqual(["vm.agent", "vm.quiesce", "collect", "apply"]);
  });

  it("a guest that committed nothing is not applied", async () => {
    const r = rig();
    await r.handler(await r.claim(jobFor()));
    expect(r.log).toContain("collect");
    expect(r.log).not.toContain("apply");
  });

  it("a bundle the host refuses ends the run with that closed code: the check is not run, no check VM is made, and the agent's VM is still deleted", async () => {
    const r = rig({ withCheck: true, collectError: "bundle_tree" });
    expect(await r.handler(await r.claim(jobFor({ check: CHECK })))).toMatchObject({ status: "failed", reason: "bundle_tree" });
    expect(r.log).not.toContain("fresh_check");
    expect(r.log).not.toContain("apply");
    expect(r.log.slice(-4)).toEqual(["release:rn-", "vm.delete", "unbind:rn-", "unbind"]);
    expect(r.log.filter((l) => l === "vm.create")).toHaveLength(1);
    expect(r.lifecycle.registry.ids()).toEqual([]);
  });

  it("a fix round starts a fresh VM from the branch tip, never a resume of an earlier session; an OS-sandbox runner resumes as before", async () => {
    const continues = { parent_run_id: "22222222-2222-4222-8222-222222222222", session_id: null, branch: "fx/issue-12", pr_number: 7 };
    const vm = rig({ resume: true });
    await vm.handler(await vm.claim(jobFor({ continues, task: { ...jobFor().task, kind: "fix" } })));
    expect(vm.log).toContain("vm.agent");
    expect(vm.log).not.toContain("vm.resume");
    expect(vm.gits[0]?.calls.some((c) => c.startsWith("resume"))).toBe(false);
    const os = rig({ resume: true, engine: "os_sandbox" });
    await os.handler(await os.claim(jobFor({ continues, task: { ...jobFor().task, kind: "fix" } })));
    expect(os.gits[0]?.calls.some((c) => c.startsWith("resume"))).toBe(true);
  });

  it("the agent's VM is persistent only when the wiring says so; either way it is stopped before the host steps and deleted when the job ends (resume is not wired, so none is kept)", async () => {
    const off = rig();
    await off.handler(await off.claim(jobFor()));
    expect(off.retentions).toEqual([false]);
    expect(off.log).toContain("vm.stop");
    const on = rig({ persistent: true });
    await on.handler(await on.claim(jobFor()));
    expect(on.retentions).toEqual([true]);
    expect(on.log.filter((l) => l === "vm.stop")).toHaveLength(1);
    expect(on.log).toContain("vm.delete");
    expect(on.lifecycle.registry.ids()).toEqual([]);
  });
});

/** What a job's whole life looks like at the end: every VM ended, no listener, nothing left in the teardown table. */
const clean = (r: ReturnType<typeof rig>): void => {
  expect(r.lifecycle.registry.ids()).toEqual([]);
  expect(r.log.filter((l) => l.startsWith("host."))).toEqual([]);
};
const created = (r: ReturnType<typeof rig>): number => r.log.filter((l) => l === "vm.create").length;
const deleted = (r: ReturnType<typeof rig>): number => r.log.filter((l) => l === "vm.delete").length;

describe("a microVM job runs through runVmJob: every way it can end tears every VM down", () => {
  const BUNDLE = Buffer.from("bundle");
  const withCheck = { withCheck: true, bundle: BUNDLE } as const;

  it("the full order of one job, from a recorded log: admit and create, egress and guest checks, the agent, quiesce, bundle out, stop, apply, the check VM, the check, then both VMs end", async () => {
    const r = rig(withCheck);
    expect((await r.handler(await r.claim(jobFor({ check: CHECK })))).status).toBe("completed");
    const steps = ["bind", "vm.create", "vm.agent", "vm.quiesce", "collect", "release:rn-", "vm.stop", "apply", "fresh_check", "unbind"];
    expect(r.log.filter((l) => steps.includes(l) || l.startsWith("release:") || l === "vm.create" || l === "vm.delete")).toEqual(["bind", "vm.create", "vm.agent", "vm.quiesce", "collect", "vm.stop", "apply", "vm.create", "fresh_check", "release:rc-", "vm.delete", "release:rn-", "vm.delete", "unbind"]);
    clean(r);
  });

  it("with max_vms = 1 the check never deadlocks on the cap: the agent's VM is stopped before the check VM is made", async () => {
    const r = rig({ ...withCheck, maxVms: 1 });
    expect((await r.handler(await r.claim(jobFor({ check: CHECK })))).status).toBe("completed");
    expect(created(r)).toBe(2);
    expect(r.freshChecks).toHaveLength(1);
    clean(r);
  });

  it("a job with no check never makes a check VM, and neither does a check the host steps decided not to run", async () => {
    const none = rig({ bundle: BUNDLE });
    await none.handler(await none.claim(jobFor()));
    expect(created(none)).toBe(1);
    const outside = rig({ ...withCheck, changed: ["infra/prod/plan.tf"] });
    await outside.handler(await outside.claim(jobFor({ check: CHECK, scope: ["src/**"] })));
    expect(created(outside)).toBe(1);
    expect(bodies("/done").at(-1)?.check).toMatchObject({ reason: "out_of_scope" });
    clean(none);
    clean(outside);
  });

  it("each job's VM factory is made for that job's own wall clock plus the sandbox margin, the number runJob asks the sandbox for (3c-iii, the per-job limit)", async () => {
    const seen: number[] = [];
    const runIds: string[] = [];
    const custom = rig({ portTimeouts: seen, portRunIds: runIds, wallClockMs: 90 * 60_000 });
    const customJob = jobFor();
    await custom.handler(await custom.claim(customJob));
    const plain = rig({ portTimeouts: seen, portRunIds: runIds });
    const plainJob = jobFor();
    await plain.handler(await plain.claim(plainJob));
    expect(seen).toEqual([90 * 60_000 + SANDBOX_MARGIN_MS, DEFAULT_WALL_CLOCK_MS + SANDBOX_MARGIN_MS]);
    // the run id goes with it: the factory finds that run's usage and relay sinks by it (3c-iii)
    expect(runIds).toEqual([customJob.run_id, plainJob.run_id]);
    clean(custom);
    clean(plain);
  });

  it("a VM that cannot be created ends the job sandbox_unavailable on no other sandbox: nothing starts, nothing is left in the table", async () => {
    const r = rig({ faults: { create: "agent" } });
    expect(await r.handler(await r.claim(jobFor()))).toEqual({ status: "failed", reason: "sandbox_unavailable" });
    expect(r.vmStarts).toEqual([]);
    expect(r.log).toContain("vm.delete");
    clean(r);
  });

  it("egress that is not up, a guest that does not answer and a cap that is reached each end the job sandbox_unavailable and delete the VM they made", async () => {
    for (const faults of [{ state: "stopped" }, { guest: true }] as const) {
      const r = rig({ faults });
      expect(await r.handler(await r.claim(jobFor())), JSON.stringify(faults)).toEqual({ status: "failed", reason: "sandbox_unavailable" });
      expect(r.vmStarts).toEqual([]);
      expect(deleted(r)).toBe(1);
      clean(r);
    }
    const capped = rig({ maxVms: 1 });
    capped.lifecycle.registry.add("held-by-another-job", "agent", { vcpus: 1, memoryMb: 1024 });
    expect(await capped.handler(await capped.claim(jobFor()))).toEqual({ status: "failed", reason: "sandbox_unavailable" });
    expect(created(capped)).toBe(0);
    expect(capped.lifecycle.registry.ids()).toEqual(["held-by-another-job"]);
  });

  it("an agent that fails ends the job with the agent's own reason; the VM is deleted and no bundle is read", async () => {
    const r = rig({ ...withCheck, faults: { agentFails: true } });
    expect((await r.handler(await r.claim(jobFor({ check: CHECK })))).status).toBe("failed");
    expect(r.log).not.toContain("collect");
    expect(created(r)).toBe(1);
    expect(deleted(r)).toBe(1);
    clean(r);
  });

  it("an agent that will not stop (quiesce fails) ends the job before any bundle is read; the VM is deleted", async () => {
    const r = rig({ ...withCheck, faults: { quiesce: true } });
    expect((await r.handler(await r.claim(jobFor({ check: CHECK })))).status).toBe("failed");
    expect(r.log).not.toContain("collect");
    expect(r.log).not.toContain("apply");
    expect(deleted(r)).toBe(1);
    clean(r);
  });

  it("a cancel from the cloud or a daemon stop in the middle of the agent's turn ends the job aborted: the VM is ended and nothing is pushed or checked", async () => {
    const stop = new AbortController();
    const r = rig({ ...withCheck, shutdown: stop.signal, faults: { hang: () => queueMicrotask(() => stop.abort()) } });
    expect((await r.handler(await r.claim(jobFor({ check: CHECK })))).status).toBe("aborted");
    expect(r.log).not.toContain("collect");
    expect(r.freshChecks).toEqual([]);
    expect(deleted(r)).toBe(1);
    clean(r);
  });

  it("a stop that fails after the bundle is out ends the job and still deletes the VM; the host steps and the check never ran", async () => {
    const r = rig({ ...withCheck, faults: { stop: true } });
    expect((await r.handler(await r.claim(jobFor({ check: CHECK })))).status).toBe("failed");
    expect(r.log).not.toContain("apply");
    expect(r.freshChecks).toEqual([]);
    expect(deleted(r)).toBe(1);
    clean(r);
  });

  it("a check VM that cannot be made ends the job and deletes the agent's VM and the one it tried", async () => {
    const r = rig({ ...withCheck, faults: { create: "check" } });
    expect((await r.handler(await r.claim(jobFor({ check: CHECK })))).status).toBe("failed");
    expect(r.freshChecks).toEqual([]);
    expect(created(r)).toBe(2);
    expect(deleted(r)).toBe(2);
    clean(r);
  });

  it("a delete that fails is reported, not hidden: the job fails, the other VM is still deleted, and the leftover stays in the table for the reaper", async () => {
    const r = rig({ ...withCheck, faults: { deleteAgent: true } });
    expect((await r.handler(await r.claim(jobFor({ check: CHECK })))).status).toBe("failed");
    expect(deleted(r)).toBe(2);
    expect(r.lifecycle.registry.leftovers()).toHaveLength(1);
    expect(r.lifecycle.registry.ids()).toEqual(r.lifecycle.registry.leftovers());
  });

  it("an agent that fails and a token wipe that fails end the job vm_teardown_incomplete, not the agent's reason; the VM is destroyed, never kept or deleted", async () => {
    const wipeFails = { needed: () => true, slot: (_vm: string, log: string[]) => ({ deliver: async () => void log.push("deliver"), wipe: async () => { log.push("wipe"); throw new Error("unconfirmed"); } }) };
    const r = rig({ ...withCheck, persistent: true, faults: { agentFails: true }, token: wipeFails });
    expect(await r.handler(await r.claim(jobFor({ check: CHECK })))).toEqual({ status: "failed", reason: "vm_teardown_incomplete" });
    expect(r.log).toContain("wipe");
    expect(r.log).not.toContain("collect");
    expect(r.log).not.toContain("vm.stop");
    expect(r.freshChecks).toEqual([]);
  });

  it("an agent that fails and a delete of its VM that fails end the job vm_teardown_incomplete, and the leftover stays for the reaper", async () => {
    const steps: string[] = [];
    const r = rig({ ...withCheck, steps, faults: { agentFails: true, deleteAgent: true } });
    expect(await r.handler(await r.claim(jobFor({ check: CHECK })))).toEqual({ status: "failed", reason: "vm_teardown_incomplete" });
    expect(r.lifecycle.registry.leftovers()).toHaveLength(1);
    expect(steps.some((l) => l.includes("microVM teardown incomplete (a leftover is kept for the reaper)"))).toBe(true);
  });

  it("an agent that fails with a teardown that completed keeps the agent's own reason, and no teardown line is journaled", async () => {
    const steps: string[] = [];
    const r = rig({ ...withCheck, steps, faults: { agentFails: true } });
    const out = await r.handler(await r.claim(jobFor({ check: CHECK })));
    expect(out).toMatchObject({ status: "failed" });
    expect(out).not.toMatchObject({ reason: "vm_teardown_incomplete" });
    expect(steps.some((l) => l.includes("teardown incomplete"))).toBe(false);
  });

  it("the check runs in the check VM (rc-<run>), never in the agent's VM (rn-<run>)", async () => {
    const r = rig(withCheck);
    const job = jobFor({ check: CHECK });
    expect((await r.handler(await r.claim(job))).status).toBe("completed");
    expect(r.freshHandles).toEqual([`rc-${job.run_id}`]);
  });

  it("the handler gives the agent step a bounded moment to unwind after its VM is ended (AGENT_UNWIND_MS)", async () => {
    const sleeps: number[] = [];
    const r = rig({ sleeps });
    expect((await r.handler(await r.claim(jobFor()))).status).toBe("completed");
    expect(sleeps).toContain(5_000);
  });

  it("a listener that will not close is reported the same way, and the VM is still deleted", async () => {
    const r = rig({ faults: { release: true } });
    expect((await r.handler(await r.claim(jobFor()))).status).toBe("failed");
    expect(deleted(r)).toBe(1);
    expect(r.lifecycle.registry.leftovers()).toHaveLength(1);
  });

  it("the token step is a slot between the guest check and the agent: delivered before the agent starts, wiped after it ends and before the bundle is read", async () => {
    const r = rig({ token: { needed: () => true, slot: (_vm, log) => ({ deliver: async () => void log.push("deliver"), wipe: async () => void log.push("wipe") }) } });
    expect((await r.handler(await r.claim(jobFor()))).status).toBe("completed");
    const order = r.log.filter((l) => ["vm.create", "deliver", "vm.agent", "vm.quiesce", "wipe", "collect"].includes(l));
    expect(order).toEqual(["vm.create", "deliver", "vm.agent", "vm.quiesce", "wipe", "collect"]);
    clean(r);
  });

  it("a job that needs a token while none is wired ends vm_token_delivery_failed: the agent never starts and the VM is deleted", async () => {
    const r = rig({ token: { needed: () => true, slot: () => undefined } });
    expect(await r.handler(await r.claim(jobFor()))).toEqual({ status: "failed", reason: "vm_token_delivery_failed" });
    expect(r.vmStarts).toEqual([]);
    expect(deleted(r)).toBe(1);
    clean(r);
  });

  it("a token the guest could not wipe ends the VM with no snapshot (destroy) and the job fails", async () => {
    const wiped: string[] = [];
    const r = rig({ persistent: true, token: { needed: () => true, slot: () => ({ deliver: async () => void wiped.push("deliver"), wipe: async () => { wiped.push("wipe"); throw new Error("token still there"); } }) } });
    expect((await r.handler(await r.claim(jobFor()))).status).toBe("failed");
    expect(wiped).toEqual(["deliver", "wipe"]);
    expect(r.log).toContain("vm.teardown");
    expect(r.log).not.toContain("vm.stop");
    clean(r);
  });

  it("the OS-sandbox path never touches the lifecycle: no VM is registered, made or ended by it", async () => {
    const r = rig({ engine: "os_sandbox", withCheck: true });
    await r.handler(await r.claim(jobFor({ check: CHECK })));
    expect(r.lifecycle.registry.ids()).toEqual([]);
    expect(r.log.filter((l) => l.startsWith("release:") || l === "vm.teardown")).toEqual([]);
  });
});
