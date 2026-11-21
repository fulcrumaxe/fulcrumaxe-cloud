/**
 * D#587 B-5b-3b: one job's life around its microVMs, in a fixed order, with teardown on every way out. Nothing here starts a process or reads `process.*`;
 * every effect arrives through `VmPort` (the VM factory), the step bodies (B-5b's archive in, bundle out, host apply and the fresh-VM check) and the token slot (3c).
 *
 *   admit -> register -> create -> egress -> guest ready -> workspace in -> token -> run agent -> quiesce -> bundle out -> stop agent VM
 *     -> host apply -> (admit, register, create, egress, ready) the check VM -> check -> teardown
 *
 *  - A step never starts before the one above it reported success. The agent's VM is registered before it is created, so a crash between the two leaves a name the reaper knows.
 *  - The agent's VM is stopped before the check VM is created, and the cap counts running VMs (the check's included), so a cap of one VM never deadlocks (Ruling 13).
 *  - The check never runs in the agent's VM; it runs in a VM made after the agent's stopped.
 *  - Teardown runs for both VMs on every path (finish, error, abort, a step that hangs, a failed create). Each teardown step runs even when the one before failed; a VM
 *    whose teardown did not finish stays in the registry as a `leftover` for the reaper, and the job reports it (`teardownIncomplete`).
 *  - Every way to end without a result is one word from a closed set. Nothing about the job, the machine or an error travels: the record holds the code, the engine, the step,
 *    counts and whole milliseconds.
 *  - FU-155 (decided here): a wipe the guest did not confirm ends the VM with `destroy` (no snapshot, earlier snapshots kept), never `delete`. The root disk is read-only and the
 *    writable state is tmpfs, so an earlier snapshot was wiped before it was taken and holds nothing of this run; deleting it would only cost a resume. `delete` is for a job that is over.
 */
import { admitVm, type MemAvailableReader, type MicrovmCaps, type VmRequest } from "./limits.js";
import { CHECK_CLOSED } from "./sandboxd/live.js";
import { isRunnerIdPrefix } from "./sandboxd/sdkAdapter.js";
import type { SandboxHandle, SandboxPort } from "../sandbox/port.js";

export const VM_JOB_CODES = ["vm_admission_refused", "vm_boot_failed", "vm_egress_unavailable", "vm_token_delivery_failed", "vm_workspace_failed", "vm_teardown_incomplete"] as const;
export type VmJobCode = (typeof VM_JOB_CODES)[number];
export const VM_STEPS = ["admit", "register", "create", "egress", "guest_ready", "workspace_in", "token", "run", "quiesce", "bundle_out", "stop_agent", "host_apply", "check_vm", "check", "teardown"] as const;
export type VmStep = (typeof VM_STEPS)[number];
export type VmKind = "agent" | "check";

/** The VM factory: what a job needs from the engine, one id (a sandbox name) at a time. Every method may be called again after a failure. */
export interface VmPort {
  create(id: string, kind: VmKind): Promise<void>;
  /** The CONNECT proxy and the reverse endpoint on this VM's vsock directory, closed policy. */
  startEgress(id: string): Promise<void>;
  waitGuest(id: string, signal: AbortSignal): Promise<void>;
  releaseEgress(id: string): Promise<void>;
  /** Stops the VM (a snapshot where the sandbox is persistent). */
  stop(id: string): Promise<void>;
  /** Ends the VM with no snapshot; earlier snapshots stay. */
  destroy(id: string): Promise<void>;
  /** Ends the VM and every snapshot of it. Safe to repeat. */
  delete(id: string): Promise<void>;
}

/** The token step (3c fills it, over the job-token module): `deliver` reads and sends the credential, `wipe` resolves only when the guest confirmed that none is left. */
export interface TokenSlot {
  deliver(signal: AbortSignal): Promise<void>;
  wipe(): Promise<void>;
}

/** A step body refuses with one fixed word (`[a-z][a-z0-9_]*`); anything else it throws becomes the step's own code. */
export class StepRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "StepRefusal";
  }
}

export interface VmJobSteps<Agent, Bundle, Applied, Checked> {
  workspaceIn(vm: string, signal: AbortSignal): Promise<void>;
  runAgent(vm: string, signal: AbortSignal): Promise<Agent>;
  bundleOut(vm: string, signal: AbortSignal): Promise<Bundle>;
  /** On the host: applies the bundle to the host copy and runs every host step. */
  hostApply(bundle: Bundle, signal: AbortSignal): Promise<Applied>;
  /** The approved check, in the fresh VM. Absent until B-5b's fresh-VM check merges: the job then ends with `CHECK_CLOSED`. */
  runCheck?(vm: string, applied: Applied, signal: AbortSignal): Promise<Checked>;
  /** False when the host steps left nothing to check (no check on the job, out of scope, no change): the check VM is then never made. Absent: always checked. */
  needsCheck?(applied: Applied): boolean;
}

interface Entry { kind: VmKind; request: VmRequest; state: "running" | "stopped"; leftover: boolean }

/** The teardown table: every VM id a job made, from before its create until its teardown is confirmed. */
export class VmRegistry {
  private readonly vms = new Map<string, Entry>();
  add(id: string, kind: VmKind, request: VmRequest): void {
    if (this.vms.has(id)) throw new Error("vm_registered");
    this.vms.set(id, { kind, request, state: "running", leftover: false });
  }
  get(id: string): Entry | undefined { return this.vms.get(id); }
  markStopped(id: string): void { const e = this.vms.get(id); if (e !== undefined) e.state = "stopped"; }
  markLeftover(id: string): void { const e = this.vms.get(id); if (e !== undefined) e.leftover = true; }
  remove(id: string): void { this.vms.delete(id); }
  ids(): string[] { return [...this.vms.keys()]; }
  leftovers(): string[] { return [...this.vms].filter(([, e]) => e.leftover).map(([id]) => id); }
  /** Running VMs only: a stopped one holds no RAM, and the agent's stopped VM must not block its own check. */
  running(): VmRequest[] { return [...this.vms.values()].filter((e) => e.state === "running").map((e) => e.request); }
}

/** The claim loop's closed block: no claim while the cap is reached. */
export function vmCapBlock(registry: VmRegistry, caps: MicrovmCaps | undefined): "vm_cap_reached" | undefined {
  return caps !== undefined && registry.running().length >= caps.maxVms ? "vm_cap_reached" : undefined;
}

/** What may be recorded or sent about a job's end. Nothing else. */
export interface VmJobRecord {
  engine: "microvm";
  ok: boolean;
  step?: VmStep;
  code?: string;
  teardownIncomplete: boolean;
  vms: number;
  durationMs: number;
}

export type VmJobOutcome<Agent, Applied, Checked> =
  | { ok: true; agent: Agent; applied: Applied; check: Checked | undefined; record: VmJobRecord }
  | { ok: false; step: VmStep; code: string; teardownIncomplete: boolean; record: VmJobRecord };

export interface VmJobDeps<Agent, Bundle, Applied, Checked> {
  /** The sandbox names of the agent's VM and the check VM. */
  names: { agent: string; check: string };
  port: VmPort;
  registry: VmRegistry;
  steps: VmJobSteps<Agent, Bundle, Applied, Checked>;
  token?: TokenSlot | undefined;
  needsToken: boolean;
  caps: MicrovmCaps | undefined;
  request: VmRequest;
  readMemAvailableBytes: MemAvailableReader;
  /** Fields a VM run cannot carry yet (Ruling 11): present means refused at admission. */
  needs?: { allowances?: unknown; extraReadPaths?: readonly string[]; spillDir?: unknown } | undefined;
  signal: AbortSignal;
  /** Keep the agent's VM stopped (snapshot) for a resume instead of deleting it. */
  keepAgentVm?: boolean;
  /** The most any setup step may take (create, egress, guest ready, workspace in, token). Default 120 s. */
  stepTimeoutMs?: number;
  now?: () => number;
  log?: (event: { step: VmStep; phase: "start" | "ok" | "fail" }) => void;
  /** One fixed operator line; never a value from the job. */
  operatorLine?: (line: string) => void;
}

const REFUSAL_WORD = /^[a-z][a-z0-9_]{0,63}$/;
const DEFAULT_STEP_MS = 120_000;
export const OPERATOR_LINE_UNSUPPORTED_FIELDS = "a job run in a microVM may not carry sandbox allowances, extra read paths or a spill directory yet; the run was refused";

class Failed extends Error {
  constructor(readonly step: VmStep, readonly code: string) {
    super(code);
    this.name = "Failed";
  }
}

const quiet = (): void => {
  // fx-swallow-ok: marks a promise as handled; the race that owns it has already settled
};

/** The closed word for whatever a step threw: a refusal word, a closed VM code (the token module's), or the step's own default. Never the error's text. */
function codeOf(err: unknown, fallback: string): string {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  if (err instanceof StepRefusal && REFUSAL_WORD.test(err.code)) return err.code;
  if (typeof code === "string" && (VM_JOB_CODES as readonly string[]).includes(code)) return code;
  return fallback;
}

export async function runVmJob<Agent, Bundle, Applied, Checked>(deps: VmJobDeps<Agent, Bundle, Applied, Checked>): Promise<VmJobOutcome<Agent, Applied, Checked>> {
  const { port, registry, steps, signal } = deps;
  const now = deps.now ?? Date.now;
  const started = now();
  const stepMs = deps.stepTimeoutMs ?? DEFAULT_STEP_MS;
  let made = 0;
  let tokenTouched = false;
  let wiped = false;
  let wipeFailed = false;
  let quiesceOver = false;
  /** The ids this run registered: teardown ends these and no other, so a name another job holds is never touched. */
  const registered = new Set<string>();

  /** One step: not before the abort, bounded in time unless `ms` is 0, and every failure becomes `Failed` with a closed word. */
  async function step<T>(name: VmStep, fallback: string, work: () => Promise<T>, ms = stepMs): Promise<T> {
    if (signal.aborted) throw new Failed(name, "aborted");
    deps.log?.({ step: name, phase: "start" });
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const running = work();
      running.catch(quiet);
      const racers: Promise<never>[] = [
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new Failed(name, "aborted"));
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ];
      if (ms > 0) racers.push(new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Failed(name, fallback)), ms))));
      const value = await Promise.race([running, ...racers]);
      deps.log?.({ step: name, phase: "ok" });
      return value;
    } catch (err) {
      deps.log?.({ step: name, phase: "fail" });
      throw err instanceof Failed ? err : new Failed(name, codeOf(err, fallback));
    } finally {
      clearTimeout(timer);
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
  }

  async function wipeOnce(): Promise<void> {
    if (!tokenTouched || wiped) return;
    wipeFailed = true; // unconfirmed until the guest says otherwise: a wipe that is still pending when its bound or the abort ends the step counts as not done
    try {
      await deps.token?.wipe();
      if (quiesceOver) return; // answered after the step ended: teardown has already taken the unconfirmed path
      wiped = true;
      wipeFailed = false;
    } catch {
      // fx-swallow-ok: replaced by the fixed code the caller raises; the VM is then destroyed, never stopped or snapshotted
      wipeFailed = true;
      throw new Error("wipe_unconfirmed");
    }
  }

  /** Brings one VM up: registered first, then created, egress, guest. A failed create leaves the registered name for teardown to delete. */
  async function bringUp(id: string, kind: VmKind, steps3: readonly [VmStep, VmStep, VmStep]): Promise<void> {
    const [create, egress, ready] = steps3;
    await step(create, "vm_boot_failed", async () => {
      made++;
      await port.create(id, kind);
    });
    await step(egress, "vm_egress_unavailable", () => port.startEgress(id));
    await step(ready, "vm_boot_failed", () => port.waitGuest(id, signal));
  }

  function admit(kind: VmKind): void {
    const verdict = admitVm({ caps: deps.caps, running: registry.running(), request: deps.request, readMemAvailableBytes: deps.readMemAvailableBytes });
    if (!verdict.admit) throw new Failed(kind === "agent" ? "admit" : "check_vm", "vm_admission_refused");
  }

  /** Ends one VM: its listeners, then the VM. Every part runs whatever an earlier part did. A VM that is not fully gone stays in the table as a leftover. */
  async function teardownVm(id: string): Promise<boolean> {
    const entry = registry.get(id);
    if (entry === undefined) return true;
    let complete = true;
    try {
      await port.releaseEgress(id);
    } catch {
      // fx-swallow-ok: reported as an incomplete teardown below; the leftover is retried by the reaper
      complete = false;
    }
    const kept = entry.kind === "agent" && deps.keepAgentVm === true && entry.state === "stopped" && !wipeFailed;
    try {
      if (!kept) await (wipeFailed && entry.kind === "agent" ? port.destroy(id) : port.delete(id));
    } catch {
      // fx-swallow-ok: reported as an incomplete teardown below
      complete = false;
    }
    if (complete) registry.remove(id);
    else registry.markLeftover(id);
    return complete;
  }

  const record = (ok: boolean, extra: { step?: VmStep; code?: string; teardownIncomplete: boolean }): VmJobRecord => ({
    engine: "microvm",
    ok,
    ...(extra.step === undefined ? {} : { step: extra.step }),
    ...(extra.code === undefined ? {} : { code: extra.code }),
    teardownIncomplete: extra.teardownIncomplete,
    vms: made,
    durationMs: Math.max(0, Math.trunc(now() - started)),
  });

  let result: { agent: Agent; applied: Applied; check: Checked | undefined } | undefined;
  let failure: Failed | undefined;
  try {
    await step("admit", "vm_admission_refused", async () => {
      const needs = deps.needs;
      if (needs !== undefined && (needs.allowances !== undefined || (needs.extraReadPaths?.length ?? 0) > 0 || needs.spillDir !== undefined)) {
        deps.operatorLine?.(OPERATOR_LINE_UNSUPPORTED_FIELDS);
        throw new StepRefusal("vm_admission_refused");
      }
      admit("agent");
    });
    await step("register", "vm_boot_failed", async () => {
      registry.add(deps.names.agent, "agent", deps.request);
      registered.add(deps.names.agent);
    });
    await bringUp(deps.names.agent, "agent", ["create", "egress", "guest_ready"]);
    await step("workspace_in", "vm_workspace_failed", () => steps.workspaceIn(deps.names.agent, signal));
    if (deps.needsToken) {
      await step("token", "vm_token_delivery_failed", async () => {
        if (deps.token === undefined) throw new StepRefusal("vm_token_delivery_failed"); // 3b leaves the slot; 3c fills it
        tokenTouched = true; // before the put: a put that is abandoned in flight may still land
        await deps.token.deliver(signal);
      });
    }
    const agent = await step("run", "agent_failed", () => steps.runAgent(deps.names.agent, signal), 0);
    let quiesceWipeRan = false;
    try {
      // bounded like every other step: no answer in time is an unconfirmed wipe
      await step("quiesce", "vm_teardown_incomplete", () => {
        quiesceWipeRan = true;
        return wipeOnce();
      });
    } finally {
      // only a wipe that actually started can answer late; an abort set before the step began never reached it, and teardown wipes instead
      if (quiesceWipeRan) quiesceOver = true;
    }
    const bundle = await step("bundle_out", "vm_workspace_failed", () => steps.bundleOut(deps.names.agent, signal));
    await step("stop_agent", "vm_teardown_incomplete", () => port.stop(deps.names.agent));
    registry.markStopped(deps.names.agent);
    const applied = await step("host_apply", "vm_workspace_failed", () => steps.hostApply(bundle, signal));
    let check: Checked | undefined;
    if (steps.needsCheck === undefined || steps.needsCheck(applied)) {
      if (steps.runCheck === undefined) throw new Failed("check", CHECK_CLOSED);
      const runCheck = steps.runCheck.bind(steps);
      await step("check_vm", "vm_admission_refused", async () => {
        admit("check");
        registry.add(deps.names.check, "check", deps.request);
        registered.add(deps.names.check);
      });
      await bringUp(deps.names.check, "check", ["check_vm", "check_vm", "check_vm"]);
      check = await step("check", "vm_workspace_failed", () => runCheck(deps.names.check, applied, signal), 0);
    }
    result = { agent, applied, check };
  } catch (err) {
    // fx-swallow-ok: the error is replaced by its closed code (`Failed`), and teardown below runs whatever it was; no text of it may travel
    failure = err instanceof Failed ? err : new Failed("teardown", "vm_teardown_incomplete");
  }

  // teardown, on every path: the check VM first (never kept), then the agent's
  let incomplete = false;
  deps.log?.({ step: "teardown", phase: "start" });
  // A job that ended before its quiesce still wipes, before its VM is ended (criterion 24): bounded, and not by the abort that may have ended the job. An unconfirmed wipe
  // is the same state as at quiesce: the VM is destroyed, never kept.
  if (tokenTouched && !wiped && !wipeFailed) {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([wipeOnce(), new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("wipe_unconfirmed")), stepMs)))]);
    } catch {
      // fx-swallow-ok: wipeOnce has already latched `wipeFailed`; teardown below destroys the VM instead of keeping it
      quiesceOver = true; // an answer that comes later must not clear the unconfirmed state teardown is acting on
      wipeFailed = true;
    } finally {
      clearTimeout(timer);
    }
  }
  for (const id of [deps.names.check, deps.names.agent]) if (registered.has(id)) incomplete = !(await teardownVm(id)) || incomplete;
  deps.log?.({ step: "teardown", phase: incomplete || wipeFailed ? "fail" : "ok" });

  if (failure === undefined && result !== undefined && !incomplete && !wipeFailed) return { ok: true, ...result, record: record(true, { teardownIncomplete: false }) };
  const ended = failure ?? new Failed("teardown", "vm_teardown_incomplete");
  // an unconfirmed token wipe ends the job vm_teardown_incomplete whatever else ended it (criterion 24)
  const code = failure === undefined || wipeFailed ? "vm_teardown_incomplete" : ended.code;
  const teardownIncomplete = incomplete || wipeFailed;
  return { ok: false, step: ended.step, code, teardownIncomplete, record: record(false, { step: ended.step, code, teardownIncomplete }) };
}

/**
 * Start-up (and retry) reaping: deletes every listed VM carrying `prefix` (the runner's id marker, `runnerIdPrefix`) that the registry does not hold as a live job's, and every leftover.
 * The registry holds sandbox NAMES and the helper knows only ids, so `idOf` (the runner's own name-to-id map, `idOfRunner(prefix)`) maps every registry entry before it is compared with the list
 * or handed to `releaseEgress` and `delete`.
 * A listed VM without the prefix is another runner's, or not ours at all, and is never touched, whatever its name looks like. An unusable prefix reaps nothing from the list. Never throws; counts what it could not remove.
 * An agent VM kept for a resume leaves the table once it is kept, so this deletes it too: nothing resumes a VM across a runner restart yet, and a kept one that
 * survives a restart is a leak. Resume wiring must keep its own record before this runs.
 */
export async function reapVms(deps: { prefix: string; idOf: (name: string) => string; list(): Promise<readonly string[]>; port: Pick<VmPort, "releaseEgress" | "delete">; registry: VmRegistry }): Promise<{ reaped: number; failed: number }> {
  const leftovers = deps.registry.leftovers();
  const live = new Set(deps.registry.ids().filter((name) => !leftovers.includes(name)).map((name) => deps.idOf(name)));
  const nameOfId = new Map(leftovers.map((name) => [deps.idOf(name), name] as const));
  let ids: readonly string[] = [];
  try {
    ids = await deps.list();
  } catch {
    // fx-swallow-ok: an unreadable list reaps only the table's own leftovers
  }
  let reaped = 0;
  let failed = 0;
  const mine = isRunnerIdPrefix(deps.prefix) ? ids.filter((id) => id.startsWith(deps.prefix)) : [];
  for (const id of new Set([...mine, ...nameOfId.keys()])) {
    if (live.has(id)) continue;
    let ok = true;
    for (const end of [() => deps.port.releaseEgress(id), () => deps.port.delete(id)]) {
      try {
        await end();
      } catch {
        // fx-swallow-ok: counted as failed; the name stays in the table for the next pass
        ok = false;
      }
    }
    const name = nameOfId.get(id);
    if (ok) {
      if (name !== undefined) deps.registry.remove(name);
      reaped++;
    } else {
      if (name !== undefined) deps.registry.markLeftover(name);
      failed++;
    }
  }
  return { reaped, failed };
}

/** The VM factory over the runner's sandbox port; the parts only the bin edge can provide (egress listeners, the guest wait, a snapshot-free destroy) are passed in. */
export function vmPortOf(parts: {
  sandbox: Pick<SandboxPort, "createSandbox" | "stop" | "deleteSandbox">;
  timeoutMs: number;
  startEgress(id: string): Promise<void>;
  releaseEgress(id: string): Promise<void>;
  waitGuest(id: string, signal: AbortSignal): Promise<void>;
  destroy(id: string): Promise<void>;
}): VmPort {
  const handles = new Map<string, SandboxHandle>();
  const handleOf = (id: string): SandboxHandle => handles.get(id) ?? { runId: "", sandboxName: id, sessionId: "" };
  return {
    async create(id) {
      handles.set(id, await parts.sandbox.createSandbox({ sandboxName: id, retention: { persistent: false }, timeoutMs: parts.timeoutMs }));
    },
    startEgress: parts.startEgress,
    releaseEgress: parts.releaseEgress,
    waitGuest: parts.waitGuest,
    stop: (id) => parts.sandbox.stop(handleOf(id)),
    destroy: parts.destroy,
    async delete(id) {
      await parts.sandbox.deleteSandbox(handleOf(id));
      handles.delete(id);
    },
  };
}
