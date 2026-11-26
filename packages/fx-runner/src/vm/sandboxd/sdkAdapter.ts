/**
 * The `VercelSandboxSdk` / `SdkSandbox` slice on top of `fx-sandboxd` (D#587 B-5a), so `vercelSandboxPort` runs on a microVM engine unchanged.
 * It translates; it decides nothing the layers below do not already decide. The daemon's checks (id pattern, boot gate, vsock directory,
 * file path and size bounds, helper refusals) still run on every call, and a refusal reaches the port as the same HTTP-shaped error the real
 * SDK throws (`response.status`, `json.error.code`), because the port reads exactly those two fields.
 *
 * Choices that are the adapter's own:
 *  - Names. A port name is `ex-...`, `rn-...` or `pp-...` with up to 200 characters; a daemon name is the helper's id (40 lowercase characters at most).
 *    The id is `sb-` and the first 32 hex digits of the name's SHA-256. The adapter keeps the id-to-name table, so `list` answers in port names and
 *    two names that ever hashed alike are refused rather than merged.
 *  - Network policy. The port never creates a sandbox without one. The adapter needs a `PolicyPort` to put it in force, and refuses to build
 *    without one; a sandbox whose policy could not be applied is deleted before the caller sees it. What the policy port does (the egress proxy and
 *    the reverse endpoint) is B-5b. Until then the VM's only path out is the helper's fixed proxy address.
 *  - Sessions. Everything that changes a sandbox's session (create, wake, stop, delete, a timed stop, a policy change, an extension) runs one at a
 *    time per id, in the order asked. Nothing is armed or released out of turn, so a stop or delete that arrives while a policy is being put in force
 *    runs after it, and a timer that fires then stops a sandbox that is fully up. The timer is armed only once the policy is in force. A call whose
 *    signal aborts does not abandon a boot or a policy half way: it leaves the sandbox as it was (a wake that was given up on is stopped again).
 *  - A failed policy. When `apply` rejects, the VM is destroyed (or stopped again, on a wake) and `release` is still called, because an `apply` that
 *    failed part way (one listener up, the next refused) may have left something in force. A `PolicyPort` therefore accepts a `release` after a failed `apply`.
 *  - Persistence. The daemon keeps no disk across a stop (B-3), so `persistent` is only echoed back; a resumed sandbox boots fresh.
 *  - Timeout. The sandbox is stopped when its timeout runs out, and `extendTimeout` moves that. Without it a VM nobody stops would hold its slot forever.
 *  - Usage. Memory, duration and region are reported; CPU time and egress bytes are left out, never reported as 0 (not measured yet).
 */
import { createHash } from "node:crypto";
import type { SdkCommand, SdkCreateParams, SdkListedSandbox, SdkSandbox, SdkSession, SdkSessionPage, SdkSandboxListPage, VercelSandboxSdk } from "./sdkSlice.js";
import type { SandboxdCommand } from "./command.js";
import { AgentError } from "./agentError.js";
import { SandboxdError, type Sandbox, type Sandboxd } from "./sandboxd.js";

type ListedStatus = SdkListedSandbox["status"];

/** What puts a sandbox's network policy in force. `apply` resolves only once it is in force; `release` ends it with the sandbox. */
export interface PolicyPort {
  apply(sandboxId: string, policy: unknown): Promise<void>;
  release(sandboxId: string): Promise<void>;
}

export interface AdapterConfig {
  daemon: Sandboxd;
  policy: PolicyPort;
  /** The template id a VM boots from. Never taken from the port's `image` (a job names a template, not an image). */
  template: string;
  memMb: number;
  now?: () => number;
  /** Test seam: the name-to-id map. Production leaves it unset. */
  idOf?: (name: string) => string;
}

/** The error shape the port reads from the real SDK: `response.status`, and a short fixed `json.error.code`. */
export class SandboxdSdkError extends Error {
  readonly response: { status: number };
  readonly json: { error: { code: string } };
  constructor(status: number, code: string) {
    super(`fx-sandboxd adapter: ${code}`);
    this.name = "SandboxdSdkError";
    this.response = { status };
    this.json = { error: { code } };
  }
}

/** The daemon id a sandbox name maps to (the adapter keys everything by it; `deleteById` and the inventory speak in it). */
export const sandboxIdOf = (name: string): string => `sb-${createHash("sha256").update(name).digest("hex").slice(0, 32)}`;

const RUNNER_ID_PREFIX = /^sb-[0-9a-f]{10}-$/;
/** True for a prefix made by `runnerIdPrefix`. */
export function isRunnerIdPrefix(prefix: string): boolean {
  return RUNNER_ID_PREFIX.test(prefix);
}
/**
 * The marker one runner puts on every VM it creates (FU-177): `sb-` and 10 hex digits of the SHA-256 of its home, then `-`. The helper carries no label and lists only ids, so the marker
 * lives in the id. Two runners of one user with different homes never share it, and an unmarked id (`sandboxIdOf`'s 32 hex digits, no `-` at that place) never matches it.
 */
export function runnerIdPrefix(runnerHome: string): string {
  return `sb-${createHash("sha256").update(runnerHome).digest("hex").slice(0, 10)}-`;
}
/** The id a name maps to for the runner that owns `prefix`: the prefix, then 22 hex digits of the name's SHA-256 (36 characters in all, under the helper's 40). */
export function idOfRunner(prefix: string): (name: string) => string {
  if (!isRunnerIdPrefix(prefix)) throw new Error("bad_runner_id_prefix");
  return (name) => `${prefix}${createHash("sha256").update(name).digest("hex").slice(0, 22)}`;
}
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
/** The most a timer may be asked to wait: `setTimeout` overflows past 2^31-1 ms and would fire at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** A daemon refusal keeps its status and fixed code; a guest agent failure is a 502 with `guest_<its closed code>`; anything else is a 500 with no text. */
export function translated(err: unknown): SandboxdSdkError {
  if (err instanceof SandboxdSdkError) return err;
  if (err instanceof SandboxdError) return new SandboxdSdkError(err.status, err.code);
  if (err instanceof AgentError) return new SandboxdSdkError(502, `guest_${err.code}`);
  return new SandboxdSdkError(500, "internal");
}
const translate = (err: unknown): never => {
  throw translated(err);
};

/** Rejects with the signal's reason when it aborts first, as the real SDK's calls do. The work is not cancelled; its result is dropped. */
function raced<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

interface Session { id: string; startedAt: number; endedAt?: number }
interface Meta {
  name: string;
  persistent: boolean;
  image: string;
  vcpus: number;
  timeoutMs: number;
  sessions: Session[];
  commands: Map<string, SandboxdCommand>;
  updatedAt: number;
  timer?: NodeJS.Timeout;
  deadline?: number;
  /** False from the start of a session until its network policy is in force: nothing runs in it before that. */
  ready: boolean;
}

/** What the runner's own inventory and lifecycle read, by daemon id. They go through the adapter so its tables, timers and policy stay in step with the daemon. */
export interface ManagedSandbox { id: string; state: "pending" | "running" | "stopping" | "stopped"; createdAtMs: number; lastUsedAtMs: number }
/**
 * What the microVM port needs beyond the real SDK's own calls, by sandbox name: the VM's limit as an absolute value. `extendTimeout` only ever adds
 * (to the running total a wake re-arms from), so a port that topped a timer up for idle time through it would make that total grow over a sandbox's life.
 */
export interface LimitControl {
  /** Sets the total a woken VM's timer is armed with. The live timer is not touched. */
  setTimeoutMs(name: string, totalMs: number): Promise<void>;
  /** Re-arms the live timer to fire `remainingMs` from now. The total a wake re-arms from is not touched; a VM with no live timer is left alone. */
  armTimeoutAt(name: string, remainingMs: number): Promise<void>;
}

export interface DaemonSdk extends VercelSandboxSdk, LimitControl {
  managed(): ManagedSandbox[];
  /** A sandbox that is not there is done, for the three of these (idempotent, as on Vercel). A running one is never touched by `reapStopped`. */
  stopById(id: string): Promise<void>;
  deleteById(id: string): Promise<void>;
  reapStopped(): Promise<number>;
}

export function createDaemonSdk(config: AdapterConfig): DaemonSdk {
  const { daemon, policy, template, memMb } = config;
  const now = config.now ?? Date.now;
  const idFor = config.idOf ?? sandboxIdOf;
  const metas = new Map<string, Meta>(); // id -> meta
  if (policy === undefined) throw new Error("createDaemonSdk: a network policy port is required");

  const metaOf = (id: string): Meta => {
    const meta = metas.get(id);
    if (meta === undefined) throw new SandboxdSdkError(404, "not_found");
    return meta;
  };

  function disarm(meta: Meta): void {
    if (meta.timer !== undefined) clearTimeout(meta.timer);
    delete meta.timer;
    delete meta.deadline;
  }
  function endSession(meta: Meta): void {
    const last = meta.sessions[meta.sessions.length - 1];
    if (last !== undefined && last.endedAt === undefined) last.endedAt = now();
    meta.commands.clear();
    disarm(meta);
  }
  function arm(id: string, meta: Meta, wanted: number): void {
    disarm(meta);
    const ms = Math.min(Math.max(wanted, 0), MAX_TIMER_MS);
    meta.deadline = now() + ms;
    meta.timer = setTimeout(() => void wrap(id).stop().catch(() => undefined), ms); // fx-swallow-ok: a failed timed stop leaves the sandbox for the next stop or the daemon teardown
    meta.timer.unref();
  }
  function beginSession(id: string, meta: Meta): void {
    meta.ready = false;
    meta.sessions.push({ id: `${id}-${meta.sessions.length + 1}`, startedAt: now() });
  }
  /** One id's session-changing work runs one at a time, in the order asked; a failure does not hold up the next. */
  const chains = new Map<string, Promise<unknown>>();
  function exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    const run = (chains.get(id) ?? Promise.resolve()).then(work, work);
    const tail = run.then(() => undefined, () => undefined);
    chains.set(id, tail);
    void tail.then(() => (chains.get(id) === tail ? chains.delete(id) : undefined));
    return run;
  }
  const stoppedNow = (id: string): boolean => {
    try {
      return daemon.stateOf(id) === "stopped";
    } catch {
      // fx-swallow-ok: a record the daemon no longer has is not a stopped sandbox
      return false;
    }
  };
  /** After a failed `apply`: whatever it left in force goes, and a failing `release` does not hide the error the caller must see. */
  const releaseQuietly = (id: string): Promise<void> => policy.release(id).catch(() => undefined); // fx-swallow-ok: the apply failure is the error the caller gets; the listeners' own close is retried by the next release

  function wrap(id: string): SdkSandbox {
    const meta = metaOf(id);
    const live = (): Promise<Sandbox> => (meta.ready ? daemon.get(id).catch(translate) : Promise.reject(new SandboxdSdkError(409, "not_running")));
    const session = () => {
      const last = meta.sessions[meta.sessions.length - 1];
      if (last === undefined) throw new SandboxdSdkError(404, "not_found");
      return {
        sessionId: last.id,
        getCommand: async (cmdId: string): Promise<SdkCommand> => {
          const command = meta.commands.get(cmdId);
          if (command === undefined) throw new SandboxdSdkError(404, "not_found");
          return commandOf(command);
        },
      };
    };
    return {
      name: meta.name,
      get status() {
        return meta.ready ? statusOf(daemon.stateOf(id)) : "pending";
      },
      persistent: meta.persistent,
      image: meta.image,
      vcpus: meta.vcpus,
      get timeout() {
        return meta.timeoutMs;
      },
      currentSession: session,
      async runCommand(params) {
        meta.updatedAt = now();
        try {
          const command = await (await live()).runCommand({ cmd: params.cmd, ...(params.args && { args: params.args }), ...(params.cwd !== undefined && { cwd: params.cwd }), ...(params.env && { env: params.env }), ...(params.signal && { signal: params.signal }) });
          meta.commands.set(command.cmdId, command);
          void command.wait().then(() => undefined, () => undefined); // a command that ends is kept for `getCommand` until the session ends
          return commandOf(command);
        } catch (err) {
          throw translated(err);
        }
      },
      async writeFiles(files, opts) {
        meta.updatedAt = now();
        await raced((async () => (await live()).writeFiles(files.map((f) => ({ path: f.path, content: Buffer.from(f.content, "utf8"), ...(f.mode !== undefined && { mode: f.mode }) }))))().catch(translate), opts?.signal);
      },
      async updateNetworkPolicy(next, opts) {
        meta.updatedAt = now();
        await raced(
          exclusive(id, async () => {
            // a handle to a deleted sandbox must never put a policy on whatever is later created under the same name
            if (metas.get(id) !== meta) throw new SandboxdSdkError(404, "not_found");
            if (!meta.ready || daemon.stateOf(id) !== "running") throw new SandboxdSdkError(409, "not_running");
            await policy.apply(id, next);
          }).catch(translate),
          opts?.signal,
        );
      },
      async extendTimeout(durationMs, opts) {
        await raced(
          exclusive(id, async () => {
            if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || meta.deadline === undefined) throw new SandboxdSdkError(400, "bad_request");
            meta.timeoutMs += durationMs;
            arm(id, meta, meta.deadline - now() + durationMs);
          }).catch(translate),
          opts?.signal,
        );
      },
      async stop(opts) {
        await raced(
          exclusive(id, async () => {
            if (metas.get(id) !== meta) throw new SandboxdSdkError(404, "not_found");
            await daemon.stop(id);
            endSession(meta);
            await policy.release(id);
          }).catch(translate),
          opts?.signal,
        );
      },
      async delete(opts) {
        await raced(
          exclusive(id, async () => {
            if (metas.get(id) !== meta) return; // already deleted: the second delete is a no-op, as on Vercel
            await daemon.delete(id);
            endSession(meta);
            metas.delete(id);
            await policy.release(id);
          }).catch(translate),
          opts?.signal,
        );
      },
      async listSessions(): Promise<SdkSessionPage> {
        const sessions: SdkSession[] = meta.sessions
          .map((s) => ({ id: s.id, memory: memMb, region: "microvm", duration: Math.max(0, (s.endedAt ?? now()) - s.startedAt) }))
          .reverse();
        return { sessions, pagination: { next: null } };
      },
    };
  }

  function bring(params: SdkCreateParams, id: string): Promise<SdkSandbox> {
    const meta: Meta = { name: params.name, persistent: params.persistent, image: params.image, vcpus: params.resources.vcpus, timeoutMs: params.timeout, sessions: [], commands: new Map(), updatedAt: now(), ready: false };
    if (metas.has(id)) throw new SandboxdSdkError(400, "bad_request"); // a taken name, as the daemon answers it; the existing entry is left alone
    metas.set(id, meta); // before the boot, so a list or get during it sees the sandbox as pending
    return exclusive(id, async () => {
      try {
        await daemon.create({ name: id, template, vcpus: params.resources.vcpus, memMb });
      } catch (err) {
        metas.delete(id);
        throw translated(err);
      }
      beginSession(id, meta);
      try {
        await policy.apply(id, params.networkPolicy);
      } catch {
        // fx-swallow-ok: the sandbox is never handed out without its policy; the create fails with a fixed error whatever the policy port said
        await daemon.delete(id).catch(() => undefined); // fx-swallow-ok: the daemon teardown still holds the id if this delete fails
        endSession(meta);
        metas.delete(id);
        await releaseQuietly(id); // after the VM is gone: an apply that failed part way may have left a listener
        throw new SandboxdSdkError(502, "policy_failed");
      }
      arm(id, meta, meta.timeoutMs); // only now: nothing can stop a sandbox whose policy is not yet in force
      meta.ready = true;
      return wrap(id);
    });
  }

  /** Wakes a stopped sandbox: boot, then a closed policy, then ready. Runs to its end whatever the caller's signal does; a wake nobody is waiting for is stopped again. */
  function wake(id: string, meta: Meta, signal: AbortSignal | undefined): Promise<void> {
    return exclusive(id, async () => {
      if (metas.get(id) !== meta) throw new SandboxdSdkError(404, "not_found");
      if (!stoppedNow(id)) return; // running already, or being made: nothing to wake
      meta.ready = false; // from the first moment of the boot: nothing runs in the new session before its policy is in force
      try {
        await daemon.get(id, { resume: true });
      } catch (err) {
        if (!stoppedNow(id)) await daemon.stop(id).catch(() => undefined); // fx-swallow-ok: a boot that failed must not be left running; the daemon teardown holds the id otherwise
        meta.ready = stoppedNow(id); // ready is only ever set for a stopped sandbox, or one whose policy is in force
        throw translated(err);
      }
      beginSession(id, meta);
      try {
        await policy.apply(id, "deny-all"); // a woken sandbox starts closed; the port puts its own policy in force before any caller gets the handle
      } catch {
        // fx-swallow-ok: a sandbox that could not be closed is stopped again, and the wake fails with a fixed error
        await daemon.stop(id).catch(() => undefined); // fx-swallow-ok: as above, the teardown holds it
        endSession(meta);
        await releaseQuietly(id);
        meta.ready = stoppedNow(id);
        throw new SandboxdSdkError(502, "policy_failed");
      }
      arm(id, meta, meta.timeoutMs);
      meta.ready = true;
      if (signal?.aborted === true) {
        // the caller gave up while the boot ran: put the sandbox back as it was, so nothing is left running that nobody holds
        await daemon.stop(id).catch(() => undefined); // fx-swallow-ok: the next stop or the daemon teardown holds it
        endSession(meta);
        await releaseQuietly(id);
        meta.ready = stoppedNow(id);
      }
    });
  }

  const sdk: VercelSandboxSdk = {
    async create(params) {
      if (params.networkPolicy === undefined) throw new SandboxdSdkError(400, "bad_request"); // never an unpolicied sandbox, even if the port were to ask for one
      if (!NAME.test(params.name)) throw new SandboxdSdkError(400, "bad_request");
      const id = idFor(params.name);
      const work = bring(params, id);
      // a create the caller gave up on (its signal aborted first) must not leave a VM nobody holds a handle to
      if (params.signal !== undefined) work.then((made) => params.signal?.aborted === true ? made.delete().catch(() => undefined) : undefined, () => undefined); // fx-swallow-ok: the caller got the abort; a failed cleanup leaves the id to the daemon teardown
      return raced(work, params.signal);
    },
    async get(params) {
      if (!NAME.test(params.name)) throw new SandboxdSdkError(404, "not_found");
      const id = idFor(params.name);
      const meta = metaOf(id);
      if (meta.name !== params.name) throw new SandboxdSdkError(404, "not_found");
      if (params.resume === true) await raced(wake(id, meta, params.signal).catch(translate), params.signal);
      return wrap(id);
    },
    async list(params): Promise<SdkSandboxListPage> {
      const byId = new Map(daemon.list().map((row) => [row.name, row]));
      const sandboxes: SdkListedSandbox[] = [];
      for (const [id, meta] of metas) {
        const row = byId.get(id);
        if (row === undefined || !meta.name.startsWith(params.namePrefix)) continue;
        sandboxes.push({ name: meta.name, persistent: meta.persistent, createdAt: row.createdAt * 1000, updatedAt: meta.updatedAt, status: meta.ready ? statusOf(row.state) : "pending" });
      }
      return { sandboxes, pagination: { next: null } };
    },
  };
  const present = (id: string): boolean => metas.has(id);
  /** A sandbox still being made, or woken, is in use: a typed command is refused for it, never queued behind a boot that may be 30 s long. */
  const busy = (id: string): string => {
    if (!metas.get(id)?.ready) throw new SandboxdSdkError(409, "conflict");
    return id;
  };
  return {
    ...sdk,
    async setTimeoutMs(name, totalMs) {
      if (!NAME.test(name) || !Number.isSafeInteger(totalMs) || totalMs <= 0 || totalMs > MAX_TIMER_MS) throw new SandboxdSdkError(400, "bad_request");
      const id = idFor(name);
      const meta = metaOf(id);
      await exclusive(id, async () => {
        if (metas.get(id) !== meta) throw new SandboxdSdkError(404, "not_found");
        meta.timeoutMs = totalMs;
      }).catch(translate);
    },
    async armTimeoutAt(name, remainingMs) {
      if (!NAME.test(name) || !Number.isSafeInteger(remainingMs) || remainingMs <= 0 || remainingMs > MAX_TIMER_MS) throw new SandboxdSdkError(400, "bad_request");
      const id = idFor(name);
      const meta = metaOf(id);
      await exclusive(id, async () => {
        if (metas.get(id) !== meta) throw new SandboxdSdkError(404, "not_found");
        if (meta.deadline !== undefined) arm(id, meta, remainingMs); // no live timer (stopped, or not yet armed): the next arm decides
      }).catch(translate);
    },
    managed: () => managedRows(),
    async stopById(id) {
      if (present(id)) await wrap(busy(id)).stop();
    },
    async deleteById(id) {
      if (present(id)) await wrap(busy(id)).delete();
    },
    async reapStopped() {
      let reaped = 0;
      for (const row of managedRows()) {
        if (row.state !== "stopped") continue;
        const id = row.id;
        const meta = metas.get(id);
        if (meta === undefined) continue;
        // the check and the delete are ONE turn on this id: a wake queued ahead of this has finished by now, and a sandbox it brought up is left alone
        const gone = await exclusive(id, async () => {
          if (metas.get(id) !== meta || !meta.ready || !stoppedNow(id)) return false;
          await daemon.delete(id);
          endSession(meta);
          metas.delete(id);
          await policy.release(id);
          return true;
        }).catch(translate);
        if (gone) reaped += 1;
      }
      return reaped;
    },
  };
  function managedRows(): ManagedSandbox[] {
    const rows = new Map(daemon.list().map((r) => [r.name, r]));
    const out: ManagedSandbox[] = [];
    for (const [id, meta] of metas) {
      const row = rows.get(id);
      if (row !== undefined) out.push({ id, state: meta.ready ? (statusOf(row.state) as ManagedSandbox["state"]) : "pending", createdAtMs: row.createdAt * 1000, lastUsedAtMs: meta.updatedAt });
    }
    return out;
  }
}

function statusOf(state: ReturnType<Sandboxd["stateOf"]>): ListedStatus {
  return state === "creating" ? "pending" : state;
}

/** The daemon's command as the port reads it: `wait` and `logs` reject or end with the signal's reason when it aborts first. */
function commandOf(command: SandboxdCommand): SdkCommand {
  return {
    cmdId: command.cmdId,
    wait: (params) => raced(command.wait(), params?.signal),
    kill: (signal) => command.kill(signal ?? "SIGTERM"),
    logs: (opts) => ({
      async *[Symbol.asyncIterator]() {
        for await (const chunk of command.logs()) {
          if (opts?.signal?.aborted === true) return;
          yield chunk;
        }
      },
    }),
  };
}
