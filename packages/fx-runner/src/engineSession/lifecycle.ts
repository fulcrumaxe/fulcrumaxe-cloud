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
          copy = await deps.repos.open({ repoId: job.repo_gh_id, owner: (who as { owner: string }).owner, name: (who as { name: string }).name, baseSha: job.args.at_sha, signal }).catch(() => p.fail("seed", "vm_workspace_failed", "repo"));
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
