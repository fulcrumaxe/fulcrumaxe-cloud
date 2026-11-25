/**
 * D#845 ON-13a1: the runner's side of an engine session on the microVM tier: the handlers of `engine_session_start`, `_stop` and `_delete` (the dispatcher's, ON-8c). One persistent microVM per repository,
 * named `fx-engine-<repo_gh_id>`, made through the VM factory with `persistent: true` so a stop keeps a snapshot (B-3) and a later start wakes the same disk.
 *
 *   start:  admission -> session_create -> seed -> session_boot -> [credentials, supervisor: ON-13b1, skipped here] -> done
 *   stop:   admission -> session_stop -> snapshot -> done
 *   delete: admission -> session_delete -> done
 *
 * A start ends at `done` once the VM has booted: the session outlives the job, so the runner's one job slot is free for the next stop. Its `done` carries `start_mode`: `created` (no resume was asked, an old sandbox
 * of the name is replaced), `resumed` (the kept disk woke) or `fresh` (a resume was asked but nothing was kept, so a new VM was seeded again at `at_sha`).
 *
 * THREAT MODEL. The adversary is a compromised cloud or a replayed job; at risk is this machine's memory and a person's repository copy. A job is verified before it reaches here. Admission raises the persisted
 * operate mark first and refuses a start below it (`operate_stale`); a stop or delete is never refused for staleness. Admission then refuses a second engine on the machine (`machine_single_project`) and a host with
 * too little memory (`vm_memory_low`), and never queues. The guest starts `deny-all` and is given `engineSessionPolicy()` and awaited before anything is sent into it. The repository goes in as the host's own
 * archive of `at_sha`, through the setup's crossing, and the host never reads the guest's files. Everything reported or kept about a session is the closed words of the protocol and the sandbox's own name (an id).
 */
import type { MachineJobOf, SessionJobKind, SessionJobProgressBody } from "@fulcrumaxe/runner-protocol";
import type { JobHandlerDeps } from "../daemon/jobHandler.js";
import type { MachineJobHandler, SessionReporter } from "../daemon/machineJobs.js";
import { SandboxNotFoundError, type SandboxComputeState, type SandboxHandle } from "../sandbox/port.js";
import type { SetupRepoCopy, SetupRepos } from "../setup/projectSetup.js";
import { admitVm } from "../vm/limits.js";
import { DEFAULT_GUEST_PATHS, GuestWorkspaceError, sendWorkspace, type GuestPaths } from "../vm/workspace/guestWorkspace.js";
import type { ResumableVmPort } from "../vm/sandboxd/vmPort.js";
import type { OperateMark } from "./operateMark.js";
import { engineSessionPolicy } from "./sessionPolicy.js";

type FailureCode = NonNullable<SessionJobProgressBody["failure_code"]>;
type StartMode = NonNullable<SessionJobProgressBody["start_mode"]>;

/** The sandbox name of a repository's session: an id and a number, nothing a person typed. */
export const SESSION_PREFIX = "fx-engine-";
export const sessionNameOf = (repoGhId: number): string => `${SESSION_PREFIX}${repoGhId}`;
/** A session VM's wall-clock limit; the supervisor (ON-13b1) extends it while the engine runs. */
export const SESSION_VM_LIMIT_MS = 7 * 24 * 3_600_000;
/** The guest RAM a start needs the host to be able to give (B-6's guard adds its own headroom on top); a smaller template does not lower it. */
export const SESSION_MIN_GUEST_MB = 4096;

export interface EngineSessionDeps {
  vm: Pick<NonNullable<JobHandlerDeps["vm"]>, "guestOf" | "quiesce" | "lifecycle">;
  /** The persistent VM factory for one job (`live.vmPort({ ..., persistent: true })`). */
  port: (options: { timeoutMs: number; runId: string; persistent: true }) => ResumableVmPort;
  /** The compute state of a sandbox by name: `gone` for a name the daemon does not hold. */
  state: (name: string) => Promise<SandboxComputeState>;
  /** The standard tier only: empties the session's token file when a stop finds nothing running (the running path wipes it through `vm.quiesce`). */
  wipeToken?: (name: string) => Promise<void>;
  /** The host copy of the repository at a commit, as a setup makes it (ON-8d). */
  repos: SetupRepos;
  /** Who a repository id is on this machine (from the mirror this machine made for it); undefined when it is not known. */
  repoOf: (repoGhId: number) => Promise<{ owner: string; name: string } | undefined>;
  mark: OperateMark;
  runnerId: string;
  paths?: GuestPaths;
  minGuestMb?: number;
}

/** A failure already reported: it unwinds the handler and nothing more is said. */
class Reported extends Error {}
const handleOf = (name: string): SandboxHandle => ({ runId: "", sandboxName: name, sessionId: "" });
const FALLBACK: Readonly<Record<string, FailureCode>> = { session_create: "vm_boot_failed", seed: "vm_workspace_failed", session_boot: "vm_boot_failed", session_stop: "vm_teardown_incomplete", snapshot: "snapshot_failed", session_delete: "vm_teardown_incomplete" };

export function createEngineSessionHandlers(deps: EngineSessionDeps): { engine_session_start: MachineJobHandler<"engine_session_start">; engine_session_stop: MachineJobHandler<"engine_session_stop">; engine_session_delete: MachineJobHandler<"engine_session_delete"> } {
  const life = deps.vm.lifecycle;
  const request = () => ({ vcpus: life.request.vcpus, memoryMb: Math.max(life.request.memoryMb, deps.minGuestMb ?? SESSION_MIN_GUEST_MB) });
  const stateOf = (id: string) => life.registry.get(id)?.state;

  /** One job's shared parts: the step reports (a failure reports itself and unwinds) and the guard every kind begins with. */
  function run(job: MachineJobOf<SessionJobKind>, reporter: SessionReporter, signal: AbortSignal, body: (it: Parts) => Promise<void>): Promise<void> {
    const name = sessionNameOf(job.repo_gh_id);
    let current: SessionJobProgressBody["step"] = "admission";
    const port = deps.port({ timeoutMs: SESSION_VM_LIMIT_MS, runId: job.job_id, persistent: true });
    const say = async (step: SessionJobProgressBody["step"], state: SessionJobProgressBody["state"], more: { start_mode?: StartMode } = {}): Promise<void> => {
      current = step;
      await reporter.report({ step, state, ...more });
    };
    const fail = async (step: SessionJobProgressBody["step"], code: FailureCode, reason?: string): Promise<never> => {
      await reporter.report({ step, state: "failed", failure_code: code, ...(reason === undefined ? {} : { failure_reason: reason }) });
      throw new Reported();
    };
    return (async () => {
      try {
        await body({ name, port, signal, say, fail });
      } catch (error) {
        // fx-swallow-ok: a failure already reported ends here; any other error (its text could hold a path) is reported as a failure of the current step in that step's one word, unless the job is already over
        if (!(error instanceof Reported) && !reporter.closed && !signal.aborted) await reporter.report({ step: current, state: "failed", failure_code: FALLBACK[current] ?? "vm_boot_failed" });
      }
    })();
  }

  interface Parts {
    name: string;
    port: ResumableVmPort;
    signal: AbortSignal;
    say(step: SessionJobProgressBody["step"], state: SessionJobProgressBody["state"], more?: { start_mode?: StartMode }): Promise<void>;
    fail(step: SessionJobProgressBody["step"], code: FailureCode, reason?: string): Promise<never>;
  }

  /** Puts the VM's name in the table as running (a replaced entry is the same VM, woken or made again). */
  function track(name: string): void {
    if (life.registry.get(name) !== undefined) life.registry.remove(name);
    life.registry.add(name, "agent", request());
  }
  /** Ends a VM and every snapshot of it, its egress listeners first; a VM that is not fully gone stays in the table as a leftover for the reaper. */
  async function endVm(port: ResumableVmPort, name: string): Promise<boolean> {
    let ok = true;
    for (const end of [() => port.releaseEgress(name), () => port.delete(name)]) {
      try {
        await end();
      } catch {
        // fx-swallow-ok: reported as an incomplete teardown by the caller; the leftover is retried by the reaper
        ok = false;
      }
    }
    if (ok) life.registry.remove(name);
    else if (life.registry.get(name) !== undefined) life.registry.markLeftover(name);
    return ok;
  }

  async function admit(job: MachineJobOf<SessionJobKind>, p: Parts): Promise<void> {
    await p.say("admission", "started");
    // the mark is raised first, by every verified job; only a start is refused for being below it
    const seen = deps.mark.observe(deps.runnerId, job.args.operate_epoch);
    if (job.kind === "engine_session_start") {
      if (!seen.ok || job.args.operate_epoch < seen.prior) await p.fail("admission", "operate_stale", seen.ok ? undefined : "mark_unsafe");
      const others = life.registry.ids().filter((id) => id !== p.name && id.startsWith(SESSION_PREFIX) && stateOf(id) === "running");
      if (others.length > 0) await p.fail("admission", "machine_single_project");
      const running = life.registry.ids().filter((id) => id !== p.name && stateOf(id) === "running").map((id) => (life.registry.get(id) as NonNullable<ReturnType<typeof life.registry.get>>).request);
      const verdict = admitVm({ caps: life.caps, running, request: request(), readMemAvailableBytes: life.readMemAvailableBytes });
      if (!verdict.admit) {
        const memory = verdict.code === "mem_low" || verdict.code === "mem_unreadable" || verdict.code === "memory_cap_exceeded";
        await p.fail("admission", memory ? "vm_memory_low" : "vm_admission_refused", memory ? undefined : verdict.code);
      }
    }
    await p.say("admission", "ok");
  }

  const start: MachineJobHandler<"engine_session_start"> = ({ job, reporter, signal }) =>
    run(job, reporter, signal, async (p) => {
      const { name, port } = p;
      let made: "none" | "new" | "woken" = "none";
      let copy: SetupRepoCopy | undefined;
      try {
        await admit(job, p);
        await p.say("session_create", "started");
        let mode: StartMode = job.args.resume ? "fresh" : "created";
        const known = await deps.state(name);
        if (known === "unknown") await p.fail("session_create", "vm_boot_failed", "state");
        // a start that asks for no resume replaces whatever the name kept: the disk it kept is not wanted
        if (!job.args.resume && known !== "gone" && !(await endVm(port, name))) await p.fail("session_create", "vm_teardown_incomplete");
        if (job.args.resume && (known === "running" || known === "stopped")) {
          // a VM that is already up is taken into the port too: the wake is what makes this process hold it (after a runner restart it holds nothing), and a later stop acts only on what the port holds
          track(name);
          made = known === "stopped" ? "woken" : "none";
          try {
            await port.resume(name);
            mode = "resumed";
          } catch (error) {
            // fx-swallow-ok: only a name the daemon no longer holds means nothing was kept; any other failure ends the start below
            made = "none";
            life.registry.remove(name);
            if (!(error instanceof SandboxNotFoundError)) await p.fail("session_create", "vm_boot_failed");
          }
        }
        if (mode !== "resumed") {
          track(name);
          made = "new";
          await port.create(name, "agent");
        }
        await port.startEgress(name).catch(() => p.fail("session_create", "vm_egress_unavailable", "egress"));
        const guest = await deps.vm.guestOf(handleOf(name));
        // the closed template goes in force, and is awaited, before a byte is sent in
        await guest.updateNetworkPolicy(engineSessionPolicy()).catch(() => p.fail("session_create", "vm_egress_unavailable", "policy"));
        await p.say("session_create", "ok");

        if (mode === "resumed") await p.say("seed", "skipped");
        else {
          await p.say("seed", "started");
          const who = await deps.repoOf(job.repo_gh_id);
          if (who === undefined) await p.fail("seed", "vm_workspace_failed", "repo");
          copy = await deps.repos.open({ repoId: job.repo_gh_id, owner: (who as { owner: string }).owner, name: (who as { name: string }).name, baseSha: job.args.at_sha, mode: "pr", signal }).catch(() => p.fail("seed", "vm_workspace_failed", "repo"));
          await sendWorkspace(guest, (copy as SetupRepoCopy).archive, deps.paths ?? DEFAULT_GUEST_PATHS).catch((error: unknown) => p.fail("seed", "vm_workspace_failed", error instanceof GuestWorkspaceError ? error.code : "workspace"));
          await p.say("seed", "ok");
        }

        await p.say("session_boot", "started");
        await port.waitGuest(name, signal).catch(() => p.fail("session_boot", "vm_boot_failed", "guest"));
        await p.say("session_boot", "ok");
        // the session now outlives this job (credentials and the supervisor are ON-13b1's steps, skipped here)
        await p.say("done", "ok", { start_mode: mode });
        made = "none";
      } finally {
        await copy?.release().catch(() => undefined); // fx-swallow-ok: a host copy that cannot be removed now is swept with the runner's other workspaces
        // a start that did not reach `done` leaves nothing running: a VM it made is ended, a kept one it woke is stopped again (its snapshot is the disk it woke from)
        if (made === "new") await endVm(port, name);
        else if (made === "woken") {
          await port.stop(name).catch(() => undefined); // fx-swallow-ok: a VM that will not stop stays in the table; the reaper and the next stop job handle it
          await port.releaseEgress(name).catch(() => undefined); // fx-swallow-ok: as above
          life.registry.markStopped(name);
        }
      }
    });

  const stop: MachineJobHandler<"engine_session_stop"> = ({ job, reporter, signal }) =>
    run(job, reporter, signal, async (p) => {
      const { name, port } = p;
      await admit(job, p);
      const known = await deps.state(name);
      if (known === "unknown") await p.fail("session_stop", "vm_teardown_incomplete", "state");
      if (known !== "running") {
        // nothing is up: already stopped, or never kept (the next start takes the fresh path). A tier that keeps a secret beside the session wipes it here too: a scope that ended on its own
        // (a crash, a reboot of the user manager) must not leave the token behind just because there was nothing to stop.
        await deps.wipeToken?.(name).catch(() => p.fail("session_stop", "vm_teardown_incomplete", "token"));
        await p.say("session_stop", "skipped");
        await p.say("snapshot", "skipped");
      } else {
        await p.say("session_stop", "started");
        await deps.vm.quiesce(handleOf(name));
        await p.say("session_stop", "ok");
        await p.say("snapshot", "started");
        await port.stop(name).catch(() => p.fail("snapshot", "snapshot_failed"));
        // a stop the port did not act on (it holds no entry for the VM) answers ok too: only the daemon's own word says the VM is down
        if ((await deps.state(name).catch(() => "unknown")) !== "stopped") await p.fail("snapshot", "snapshot_failed", "state");
        life.registry.markStopped(name);
        await port.releaseEgress(name).catch(() => p.fail("snapshot", "vm_teardown_incomplete", "egress"));
        await p.say("snapshot", "ok");
      }
      if (life.registry.get(name) !== undefined) life.registry.markStopped(name);
      await p.say("done", "ok");
    });

  const del: MachineJobHandler<"engine_session_delete"> = ({ job, reporter, signal }) =>
    run(job, reporter, signal, async (p) => {
      await admit(job, p);
      await p.say("session_delete", "started");
      // the VM, its egress listeners and every snapshot go; the job says `ok` only when the daemon no longer holds the name
      if (!(await endVm(p.port, p.name)) || (await deps.state(p.name)) !== "gone") await p.fail("session_delete", "vm_teardown_incomplete");
      await p.say("session_delete", "ok");
      await p.say("done", "ok");
    });

  return { engine_session_start: start, engine_session_stop: stop, engine_session_delete: del };
}

/** How long past its `until` a lease may go unrenewed before the runner stops its own session, and how often the guard looks. */
export const LEASE_GRACE_MS = 60_000;
export const LEASE_CHECK_MS = 30_000;

/** The id the runner's own stop carries: it names no job of the cloud's, and the stop reports to no one. */
const SELF_STOP_JOB_ID = "00000000-0000-4000-8000-000000000000";

/** The runner's own stop of a session: true when the stop job's steps all ended well (a session that was not up counts: nothing is left running). `still` is asked once the session's turn comes; false skips the stop (it counts as ended well). */
export type SessionStopper = (repoGhId: number, still?: () => boolean) => Promise<boolean>;

/** Runs the work of one session name after the work already queued for it: a stop and a start (or two stops) of the same `fx-engine-<gh>` never overlap, and two names never wait on each other. */
export type SessionLock = <T>(repoGhId: number, work: () => Promise<T>) => Promise<T>;

export function createSessionLock(): SessionLock {
  const tails = new Map<number, Promise<unknown>>();
  return (repoGhId, work) => {
    const before = tails.get(repoGhId) ?? Promise.resolve();
    const turn = before.then(work, work);
    const tail = turn.then(() => undefined, () => undefined); // fx-swallow-ok: the tail only orders the next turn; the caller of this turn gets its real result or error through its own promise
    tails.set(repoGhId, tail);
    void tail.then(() => {
      if (tails.get(repoGhId) === tail) tails.delete(repoGhId);
    });
    return turn;
  };
}

type SessionHandlerSet = { engine_session_start: MachineJobHandler<"engine_session_start">; engine_session_stop: MachineJobHandler<"engine_session_stop">; engine_session_delete: MachineJobHandler<"engine_session_delete"> };

/** The dispatcher's three handlers, each taking its session's turn on the shared lock (the same one the runner's own stop takes). */
export function lockSessionHandlers(handlers: SessionHandlerSet, lock: SessionLock): SessionHandlerSet {
  return {
    engine_session_start: (context) => lock(context.job.repo_gh_id, () => handlers.engine_session_start(context)),
    engine_session_stop: (context) => lock(context.job.repo_gh_id, () => handlers.engine_session_stop(context)),
    engine_session_delete: (context) => lock(context.job.repo_gh_id, () => handlers.engine_session_delete(context)),
  };
}

/**
 * D#845 ON-13c3: the stop the runner issues to itself, through the very handler a signed stop job runs, so the stop, the snapshot and the token wipe are one path. The job is unsigned and local, and carries operate epoch 0: it can
 * never raise the operate mark (a stop is never refused for staleness), and its reason is the closest closed word, `operate_off`; the runner's own reason, `lease_expired`, is the one it logs.
 * With a `lock` it takes the session's turn, so it never overlaps a cloud stop, start or delete of the same session (the unlocked handler goes here, the locked ones to the dispatcher).
 */
export function sessionStopperOf(stop: MachineJobHandler<"engine_session_stop">, lock?: SessionLock): SessionStopper {
  const once = async (repoGhId: number): Promise<boolean> => {
    let ok = true;
    const reporter: SessionReporter = {
      closed: false,
      report: async (step) => {
        if (step.state === "failed") ok = false;
        return "recorded";
      },
    };
    const job = { v: 1, kind: "engine_session_stop", job_id: SELF_STOP_JOB_ID, repo_gh_id: repoGhId, args: { reason: "operate_off", operate_epoch: 0 } } as unknown as MachineJobOf<"engine_session_stop">;
    await stop({ job, reporter, signal: new AbortController().signal });
    return ok;
  };
  return (repoGhId, still) => {
    const turn = async (): Promise<boolean> => (still !== undefined && !still() ? true : once(repoGhId));
    return lock === undefined ? turn() : lock(repoGhId, turn);
  };
}

export interface EngineLeaseGuard {
  /** What the latest answered hello said: true when it echoed `engine_lease` (Ruling 15, the two-way handshake). Leases are taken and acted on only then; an answer without the echo clears every lease held. */
  echoed(on: boolean): void;
  /** True while a lease is held that has not been stopped for: the inventory then goes on every claim and heartbeat, so each one renews. */
  holding(): boolean;
  /** What a claim or heartbeat reply carried. Ignored unless the latest answered hello echoed, so a cloud that never does never stops a session here. */
  receive(lease: { repo_gh_id: number; operate_epoch: number; until: string }): void;
  /** Gives the guard the stop path; with none it stops nothing. */
  bind(stop: SessionStopper | undefined): void;
  /** Stops every session whose lease ended more than `LEASE_GRACE_MS` ago. A stop that did not end well is tried again on the next look. */
  check(): Promise<void>;
  /** Looks every `LEASE_CHECK_MS` until `signal` aborts. */
  run(clock: { now(): Date; sleep(ms: number, signal: AbortSignal): Promise<void> }, signal: AbortSignal): Promise<void>;
}

export function createEngineLeaseGuard(deps: { now: () => Date; log: (line: string) => void }): EngineLeaseGuard {
  const until = new Map<number, number>();
  /** The `until` of a lease already stopped for: a later reply that still says it (the cloud answers a lease until its own clock ends it) is not waited for again. */
  const stoppedFor = new Map<number, number>();
  let stop: SessionStopper | undefined;
  let busy = false;
  let echo = false;
  const guard: EngineLeaseGuard = {
    echoed(on) {
      echo = on;
      if (!on) {
        until.clear();
        stoppedFor.clear();
      }
    },
    holding: () => echo && until.size > 0,
    receive(lease) {
      if (!echo) return;
      const end = Date.parse(lease.until);
      if (!Number.isFinite(end) || end <= (stoppedFor.get(lease.repo_gh_id) ?? 0)) return;
      until.set(lease.repo_gh_id, Math.max(until.get(lease.repo_gh_id) ?? 0, end));
    },
    bind(next) {
      stop = next;
    },
    async check() {
      if (busy || stop === undefined || !echo) return;
      busy = true;
      try {
        for (const [repo, end] of [...until]) {
          const due = (): boolean => echo && until.get(repo) === end && deps.now().getTime() > end + LEASE_GRACE_MS;
          if (!due()) continue;
          deps.log(`fx-runner: engine lease for repository ${repo} ended and was not renewed; stopping its session (lease_expired)`);
          // `due` is asked again when the session's turn comes: a renewal, or a hello that withdrew the lease, that arrived while a cloud job held the session cancels the stop
          if (await stop(repo, due).catch(() => false)) { // fx-swallow-ok: a stop that threw ended nothing, so the lease stays and the next look tries again
            if (until.get(repo) === end) {
              until.delete(repo);
              stoppedFor.set(repo, end);
            }
          }
        }
      } finally {
        busy = false;
      }
    },
    async run(clock, signal) {
      while (!signal.aborted) {
        await clock.sleep(LEASE_CHECK_MS, signal);
        if (!signal.aborted) await guard.check();
      }
    },
  };
  return guard;
}
