import { SandboxInventory, type MachineJob, type SandboxInventoryRow } from "@fulcrumaxe/runner-protocol";
import type { MachineJobClaimResult, MachineJobProgressResult } from "../../src/daemon/client.js";
import { createMachineJobDispatcher, type MachineJobEvent } from "../../src/daemon/machineJobs.js";
import path from "node:path";
import { createEngineSessionHandlers, sessionNameOf, type EngineSessionDeps, type SessionStopReport } from "../../src/engineSession/lifecycle.js";
import type { RepoTokenRefresher } from "../../src/engineSession/repoToken.js";
import type { FakeChannel } from "../helpers/fakeChannel.js";
import { createOperateMark, type OperateMarkEvent } from "../../src/engineSession/operateMark.js";
import { SandboxNotFoundError, type SandboxComputeState } from "../../src/sandbox/port.js";
import { buildWorkspaceArchive } from "../../src/daemon/vmArchive.js";
import { VmRegistry } from "../../src/vm/jobLifecycle.js";
import type { ResumableVmPort } from "../../src/vm/sandboxd/vmPort.js";
import { JOB_KEYRING, RUNNER_ID, jobOf, signedJob } from "../helpers/machineJobFixture.js";
import { tempDir } from "../helpers/tempTree.js";
import { fixtureRepo, hostDeps, localGuest, scratchDir, type LocalGuest } from "../vm/workspace/helpers.js";

/**
 * A machine of fakes for the session handlers: a VM factory whose disks are real directories (a stop keeps the directory, an eviction removes it), a guest that really runs the workspace
 * unpack, the real operate mark on a temporary state directory, the real dispatcher over signed jobs, and a cloud that records every report (strict on the body).
 */
export const GIB = 1024 ** 3;
export interface Machine {
  state: "running" | "stopped";
  root: string;
  guest: LocalGuest;
}
export interface Rig {
  log: string[];
  machines: Map<string, Machine>;
  snapshots: Map<string, number>;
  reports: Array<Record<string, unknown> & { job_id: string }>;
  events: MachineJobEvent[];
  markEvents: OperateMarkEvent[];
  factoryOptions: Array<{ timeoutMs: number; runId: string; persistent: true }>;
  registry: VmRegistry;
  repo: ReturnType<typeof fixtureRepo>;
  markDir: string;
  /** Names `state` answers wrongly, to model a disk that vanished between the state read and the wake. */
  lie: Map<string, SandboxComputeState>;
  fail: { stop?: boolean; delete?: boolean; create?: boolean; repoOf?: boolean; repoOpen?: boolean };
  freeBytes: { value: number };
  inventory(): SandboxInventoryRow[];
  evict(name: string): void;
  /** A runner restart: the process forgets every VM it held (the port's entries and the table), the VMs stay up. */
  restart(): void;
  /** Runs the jobs in order through the real dispatcher, one claim each; answers what the handler's reports left. */
  run(...jobs: MachineJob[]): Promise<void>;
  makeDeps(): EngineSessionDeps;
  /** ON-13b2: set one and every VM the factory makes has a channel to it, and the deps carry the runner's credential source (`token`) and a stop report sink. */
  channel: FakeChannel | undefined;
  token: string | undefined;
  /** ON-18: the repo token refresh loop the deps carry (a spy in the tests). */
  repoToken: RepoTokenRefresher | undefined;
  /** Every buffer the credential source handed out, to see each one zeroed. */
  issued: Buffer[];
  tier: "vm_stop" | "unit" | undefined;
  stopReports: SessionStopReport[];
}

export function sessionRig(): Rig {
  const log: string[] = [];
  const machines = new Map<string, Machine>();
  const snapshots = new Map<string, number>();
  const reports: Rig["reports"] = [];
  const events: MachineJobEvent[] = [];
  const markEvents: OperateMarkEvent[] = [];
  const factoryOptions: Rig["factoryOptions"] = [];
  const registry = new VmRegistry();
  const repo = fixtureRepo();
  const host = hostDeps();
  const markDir = tempDir("fx-mark-");
  const lie = new Map<string, SandboxComputeState>();
  const fail: Rig["fail"] = {};
  const freeBytes = { value: 16 * GIB };
  const newest: { current?: Machine } = {};
  /** The ids this process's port holds: only a create or a wake puts one in, and a stop of any other id does nothing (as the real port). */
  const held = new Set<string>();

  /** The guest, with every effect noted in the one call log in the order it happened. */
  const noted = (name: string, guest: LocalGuest): LocalGuest => {
    const g = guest.guest as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    for (const method of ["updateNetworkPolicy", "writeFiles", "runCommand"] as const) {
      const original = g[method] as (...a: unknown[]) => Promise<unknown>;
      g[method] = (...a: unknown[]) => (log.push(`guest.${method} ${name}`), original.apply(guest.guest, a));
    }
    return guest;
  };
  const port = (options: { timeoutMs: number; runId: string; persistent: true }): ResumableVmPort => {
    factoryOptions.push(options);
    return {
      async create(id) {
        log.push(`create ${id}`);
        if (fail.create === true) throw new Error("boom");
        if (machines.has(id)) throw new Error("sandbox_exists");
        const root = scratchDir("fx-session-vm-");
        const made: Machine = { state: "running", root, guest: noted(id, localGuest(root)) };
        machines.set(id, made);
        held.add(id);
        newest.current = made;
      },
      async resume(id) {
        log.push(`resume ${id}`);
        const m = machines.get(id);
        if (m === undefined) throw new SandboxNotFoundError(id);
        m.state = "running";
        held.add(id);
      },
      ...(rig.channel === undefined ? {} : { channel: () => (rig.channel as FakeChannel).connect() }),
      async startEgress(id) {
        log.push(`startEgress ${id}`);
        if (machines.get(id)?.state !== "running") throw new Error("egress_down");
      },
      async waitGuest(id) {
        log.push(`waitGuest ${id}`);
        if (machines.get(id)?.state !== "running") throw new Error("guest_not_ready");
      },
      async releaseEgress(id) {
        log.push(`releaseEgress ${id}`);
      },
      async stop(id) {
        log.push(`stop ${id}`);
        if (fail.stop === true) throw new Error("snapshot_refused");
        const m = machines.get(id);
        if (m === undefined || !held.has(id)) return;
        m.state = "stopped";
        snapshots.set(id, (snapshots.get(id) ?? 0) + 1);
      },
      async destroy(id) {
        log.push(`destroy ${id}`);
        machines.delete(id);
      },
      async delete(id) {
        log.push(`delete ${id}`);
        if (fail.delete === true) throw new Error("helper_failed");
        machines.delete(id);
        snapshots.delete(id);
      },
    };
  };
  const makeDeps = (): EngineSessionDeps => ({
    vm: {
      guestOf: async (handle) => {
        const m = machines.get(handle.sandboxName);
        if (m === undefined) throw new SandboxNotFoundError(handle.sandboxName);
        if (m.state !== "running") throw new Error("not_running");
        return m.guest.guest;
      },
      quiesce: async (handle) => void log.push(`quiesce ${handle.sandboxName}`),
      lifecycle: { port: undefined as never, registry, caps: { maxVms: 2, maxVcpus: 2, maxMemoryMb: 16384, snapshotDir: "/srv/fixture-snaps", snapshotQuotaBytes: 1 }, request: { vcpus: 1, memoryMb: 512 }, readMemAvailableBytes: () => freeBytes.value },
    },
    port,
    state: async (name) => lie.get(name) ?? (machines.get(name)?.state ?? "gone"),
    repos: {
      async open({ baseSha, repoId }) {
        log.push(`repos.open ${String(repoId)} ${baseSha === repo.commit ? "at_sha" : "other"}`);
        if (fail.repoOpen === true) throw new Error("mirror_failed");
        return { mirrorDir: repo.mirror, workspace: "/srv/fixture-host-copy", archive: await buildWorkspaceArchive(host, repo.mirror, baseSha), release: async () => void log.push("repos.release") };
      },
    },
    repoOf: async () => (fail.repoOf === true ? undefined : { owner: "acme", name: "widgets" }),
    mark: createOperateMark({ stateDir: markDir, uid: process.getuid!(), log: (e) => markEvents.push(e) }),
    runnerId: RUNNER_ID,
    supervisorExit: { totalMs: 300, pollMs: 10 }, // short: a test that never sees the program go waits this long
    cloudOrigin: "https://cloud.fictional.invalid",
    ...(rig.token === undefined
      ? {}
      : {
          readToken: () => {
            const fresh = Buffer.from(rig.token as string, "latin1");
            rig.issued.push(fresh);
            return fresh;
          },
        }),
    ...(rig.repoToken === undefined ? {} : { repoToken: rig.repoToken }),
    ...(rig.tier === undefined ? {} : { tier: rig.tier }),
    stopped: (report) => void rig.stopReports.push(report),
    get engineDir() {
      return path.join((newest.current as Machine).root, "sandbox", ".fx-engine");
    },
    // the guest's paths are directories of the test's own (the real unpack runs there); a machine's are its own root's, so every machine is given its guest's
    get paths() {
      return (newest.current as Machine).guest.paths;
    },
  });

  const rig: Rig = {
    log, machines, snapshots, reports, events, markEvents, factoryOptions, registry, repo, markDir, lie, fail, freeBytes,
    inventory: () => [...machines].map(([name, m]) => ({ name, state: m.state, created_at: "2026-11-23T10:00:00Z", last_used_at: null, disk_bytes: 1, snapshot_count: snapshots.get(name) ?? 0, snapshot_age_s: (snapshots.get(name) ?? 0) > 0 ? 5 : null })),
    evict: (name) => void (machines.delete(name), snapshots.delete(name)),
    restart: () => {
      held.clear();
      for (const id of registry.ids()) registry.remove(id);
    },
    async run(...jobs) {
      const claims: MachineJobClaimResult[] = jobs.map((j) => ({ kind: "job", signedJob: signedJob(j) }));
      const client = {
        async machineJobClaim(): Promise<MachineJobClaimResult> {
          return claims.shift() ?? { kind: "none", retryAfter: 60 };
        },
        async setupProgress(): Promise<never> {
          throw new Error("a session job never reports on a setup");
        },
        async machineJobProgress(jobId: string, body: unknown): Promise<MachineJobProgressResult> {
          reports.push({ ...(body as object), job_id: jobId });
          return { kind: "recorded" };
        },
      };
      const deps = makeDeps();
      const dispatcher = createMachineJobDispatcher({ client, keyring: JOB_KEYRING, runnerId: RUNNER_ID, now: () => new Date(), handlers: createEngineSessionHandlers(deps), sandboxEngine: () => "microvm", log: (e) => events.push(e) });
      for (let i = 0; i < jobs.length; i++) expect_handled(await dispatcher.run());
    },
    makeDeps,
    channel: undefined,
    token: undefined,
    repoToken: undefined,
    issued: [],
    tier: undefined,
    stopReports: [],
  };
  return rig;
}

function expect_handled(result: "handled" | "none"): void {
  if (result !== "handled") throw new Error("the dispatcher took no job");
}

export const SESSION_REPO = 77;
export const NAME = sessionNameOf(SESSION_REPO);
type Kind = "engine_session_start" | "engine_session_stop" | "engine_session_delete";
export function sessionJob(kind: Kind, args: Record<string, unknown>, over: Record<string, unknown> = {}): MachineJob {
  return { ...jobOf({ kind, setup_id: undefined, requires_engine: "microvm", repo_gh_id: SESSION_REPO, ...over }), args } as MachineJob;
}
export const start = (at_sha: string, resume: boolean, operate_epoch = 1, over: Record<string, unknown> = {}): MachineJob => sessionJob("engine_session_start", { at_sha, resume, operate_epoch }, over);
export const stop = (operate_epoch = 1, reason = "person", over: Record<string, unknown> = {}): MachineJob => sessionJob("engine_session_stop", { reason, operate_epoch }, over);
export const del = (operate_epoch = 1, over: Record<string, unknown> = {}): MachineJob => sessionJob("engine_session_delete", { operate_epoch }, over);

/** `step:state[:code][/reason][@mode]` per report. */
export const compactSession = (reports: Rig["reports"]): string[] =>
  reports.map((r) => `${String(r["step"])}:${String(r["state"])}${r["failure_code"] === undefined ? "" : `:${String(r["failure_code"])}`}${r["failure_reason"] === undefined ? "" : `/${String(r["failure_reason"])}`}${r["start_mode"] === undefined ? "" : `@${String(r["start_mode"])}`}`);

export const inventoryOk = (rows: SandboxInventoryRow[]): boolean => SandboxInventory.safeParse(rows).success;
