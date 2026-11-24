/**
 * D#845 ON-13a3: an engine session on the standard tier (a machine with no microVM). The lifecycle handlers (`lifecycle.ts`) are the same; this file is the "VM" under them: a persistent root on this machine, the
 * egress proxy and forwarder, and ONE held program in a systemd user scope named in EB-12a's pattern (`fx-engine-host-<repo id>`), started through the runner's own `sandboxLaunch` (the host guest, ON-8e). The policy is
 * `ENGINE_SESSION_NETWORK` (the one constant, via `engineSessionPolicy`). Until ON-13b1 puts the supervisor there, the held program is an idle `sleep infinity`; the unit, stop and sentinel do not change when it does.
 *
 * THREAT MODEL. As the host guest's: the adversary is the repository and what the engine runs; at risk are the person's home directory, the runner's state directory (its keys and cloud credential) and the network.
 * The program runs under the host guest's sandbox (reads of home, state and the agent binary's directory denied; the only writes are its own root) and its only way out is the forwarder to the proxy on the closed policy.
 *  - The session outlives its job: the root, the proxy and the scope are kept by session id (the sandbox's own name, `fx-engine-<repo id>`), and the root stays until delete. Stop closes the proxy and ends the scope, and
 *    "ended" is the manager's word (`ActiveState` gone, so its `cgroup.procs` is gone); a scope that will not end is an error, never `ok`.
 *  - A scope this runner does not hold (it started before a restart) is never adopted: a resume ends it first, so the program in it never outlives the proxy it was given.
 *  - The repository token file is `$XDG_RUNTIME_DIR/fx-engine-session/<session id>/repo-token`: tmpfs only (a start refuses without it), directory 0700, file 0600, made empty and emptied again at every start and stop;
 *    ON-18 and ON-19 write its content. The path is the program's `FX_ENGINE_REPO_TOKEN_FILE`; the sandbox hides the user runtime directory and shows that one directory back read-only.
 *  - Nothing is read from the root: a link a session leaves in it is never followed (the host guest's no-follow file operations).
 */
import { lstatSync, statfsSync } from "node:fs";
import path from "node:path";
import type { JobHandlerDeps } from "../daemon/jobHandler.js";
import type { GitCapture } from "../daemon/git.js";
import { engineHostUnit } from "../engineHost/supervisor.js";
import { USER_RUNTIME_ROOT } from "../sandbox/hostSandbox.js";
import { SandboxNotFoundError, type SandboxComputeState } from "../sandbox/port.js";
import { createHostGuest, ensureRunnerDir, pathsOfRoot, putFile, removeRoot, rootNameOf, type HostGuest, type HostGuestDeps } from "../setup/hostGuest.js";
import { VmRegistry } from "../vm/jobLifecycle.js";
import type { ResumableVmPort } from "../vm/sandboxd/vmPort.js";
import type { GuestPaths } from "../vm/workspace/guestWorkspace.js";
import { SESSION_PREFIX, SESSION_VM_LIMIT_MS, type createEngineSessionHandlers } from "./lifecycle.js";

/** A refusal of the standard tier. Closed set; the lifecycle reports every one as the failed step's own word. */
export class StandardSessionRefused extends Error {
  constructor(readonly code: "runtime_dir_unusable" | "session_name" | "holder_failed" | "scope_not_ended" | "scope_state_unknown" | "scope_unavailable") {
    super(code);
    this.name = "StandardSessionRefused";
  }
}

const TMPFS_MAGIC = 0x01021994;
const TOKEN_DIR = "fx-engine-session";
const TOKEN_FILE = "repo-token";
const READY = "fx-engine-session-ready";
const BOOT_MS = 30_000;
const SCOPE_POLL_MS = 100;
const SCOPE_POLLS = 100;

/** Whether a directory is on a tmpfs (statfs magic number). */
export const onTmpfs = (dir: string): boolean => {
  try {
    return Number(statfsSync(dir).type) === TMPFS_MAGIC;
  } catch {
    // fx-swallow-ok: a directory that cannot be looked at is not shown to be tmpfs
    return false;
  }
};

export interface StandardSessionDeps {
  /** The host guest's parts. `jobsRoot` is the sessions' own root directory (its sibling egress directory must not be the setup's); `scope` is required. */
  guest: HostGuestDeps;
  /** `XDG_RUNTIME_DIR` as the runner has it (undefined: no start). */
  xdgRuntimeDir: string | undefined;
  isTmpfs?: (dir: string) => boolean;
  /** Runs `systemctl --user` (and nothing else). */
  capture: GitCapture;
  sleep?: (ms: number) => Promise<void>;
  holderLimitMs?: number;
}

export type StandardSessionParts = {
  vm: Pick<NonNullable<JobHandlerDeps["vm"]>, "guestOf" | "quiesce" | "lifecycle">;
  port: ResumableVmPort;
  /** The workspace and stage directories of the session a start has just made or woken (the seed step reads them right after). */
  paths: () => GuestPaths;
  state: (name: string) => Promise<SandboxComputeState>;
  /** Empties the session's token file (a stop that finds no scope up calls it: the content must not outlive the program that read it). */
  wipeToken: (name: string) => Promise<void>;
};

const isDir = (target: string): boolean => {
  try {
    return lstatSync(target).isDirectory();
  } catch {
    // fx-swallow-ok: "no such entry" is the answer
    return false;
  }
};

export function createStandardSessionParts(deps: StandardSessionDeps): StandardSessionParts {
  const scope = deps.guest.scope;
  if (scope === undefined) throw new StandardSessionRefused("scope_unavailable");
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const tmpfs = deps.isTmpfs ?? onTmpfs;
  let latest: GuestPaths | undefined;
  const kept = new Map<string, { guest: HostGuest; command?: Awaited<ReturnType<HostGuest["hold"]>> }>();

  const unitOf = (name: string): string => {
    const id = name.startsWith(SESSION_PREFIX) ? name.slice(SESSION_PREFIX.length).match(/^\d{1,15}$/) : null;
    if (id === null) throw new StandardSessionRefused("session_name");
    return engineHostUnit(id[0]);
  };
  const rootOf = (name: string): string => path.join(deps.guest.jobsRoot, rootNameOf(name));
  const tokenDirOf = (name: string): string => {
    if (deps.xdgRuntimeDir === undefined || !path.isAbsolute(deps.xdgRuntimeDir)) throw new StandardSessionRefused("runtime_dir_unusable");
    return path.join(deps.xdgRuntimeDir, TOKEN_DIR, name);
  };
  const ctl = (...args: string[]) => deps.capture(scope.tools.systemctl, ["--user", ...args], { XDG_RUNTIME_DIR: scope.runtimeDir }, 5_000);
  const scopeActive = async (name: string): Promise<boolean> => {
    const shown = await ctl("show", `${unitOf(name)}.scope`, "-p", "ActiveState");
    if (shown.code !== 0) throw new StandardSessionRefused("scope_state_unknown");
    return ["active", "activating", "deactivating"].includes(shown.stdout.match(/^ActiveState=(\S*)/m)?.[1] ?? "");
  };
  /** Ends the scope and everything in it, and returns only when the manager says it is gone (its cgroup, and so its `cgroup.procs`, with it). */
  async function endScope(name: string): Promise<void> {
    const unit = `${unitOf(name)}.scope`;
    for (let i = 0; i < SCOPE_POLLS && (await scopeActive(name)); i++) {
      if (i % 10 === 0) await ctl("kill", "--signal=SIGKILL", unit);
      await sleep(SCOPE_POLL_MS);
    }
    if (await scopeActive(name)) throw new StandardSessionRefused("scope_not_ended");
    await ctl("reset-failed", unit).catch(() => undefined); // fx-swallow-ok: a scope that is gone has nothing to clear
  }
  /**
   * The token never reaches a disk and never lands in a directory somebody else chose: the runtime directory must be a normalized absolute tmpfs path, and it must be this user's own
   * runtime directory (or below it), so a mistaken or hostile `XDG_RUNTIME_DIR` cannot point the token at a shared tmpfs such as `/tmp` or `/dev/shm`.
   */
  function checkRuntime(): string {
    const dir = deps.xdgRuntimeDir;
    const uid = deps.guest.uid;
    if (dir === undefined || uid === undefined || !path.isAbsolute(dir) || path.normalize(dir) !== dir) throw new StandardSessionRefused("runtime_dir_unusable");
    const own = path.join(USER_RUNTIME_ROOT, String(uid));
    if (dir !== own && !dir.startsWith(`${own}${path.sep}`)) throw new StandardSessionRefused("runtime_dir_unusable");
    if (!tmpfs(dir)) throw new StandardSessionRefused("runtime_dir_unusable");
    return dir;
  }
  /** The token file, made empty (0600) in its own 0700 directory. */
  function emptyToken(name: string): string {
    ensureRunnerDir(path.join(checkRuntime(), TOKEN_DIR), deps.guest.uid);
    ensureRunnerDir(tokenDirOf(name), deps.guest.uid);
    putFile(tokenDirOf(name), path.join(tokenDirOf(name), TOKEN_FILE), "", 0o600);
    return path.join(tokenDirOf(name), TOKEN_FILE);
  }
  /** A guest over the session's root (made 0700 when it is new; a kept root that is not this user's, or not 0700, refuses). */
  function guestFor(name: string): void {
    ensureRunnerDir(deps.guest.jobsRoot, deps.guest.uid);
    ensureRunnerDir(rootOf(name), deps.guest.uid);
    kept.set(name, { guest: createHostGuest(deps.guest, name, rootOf(name)).guest });
    latest = pathsOfRoot(rootOf(name));
  }
  const entry = (name: string) => {
    const found = kept.get(name);
    if (found === undefined) throw new SandboxNotFoundError(name);
    return found;
  };
  async function stop(name: string): Promise<void> {
    const held = kept.get(name);
    await held?.command?.kill();
    if (held !== undefined) delete held.command;
    await endScope(name);
  }
  async function remove(name: string): Promise<void> {
    await stop(name);
    await kept.get(name)?.guest.close();
    kept.delete(name);
    removeRoot(rootOf(name));
    if (deps.xdgRuntimeDir !== undefined) removeRoot(tokenDirOf(name));
  }

  const port: ResumableVmPort = {
    async create(name) {
      unitOf(name);
      checkRuntime();
      await remove(name); // a start that asks for no resume replaces whatever was kept
      guestFor(name);
      emptyToken(name);
    },
    async resume(name) {
      if (!isDir(rootOf(name))) throw new SandboxNotFoundError(name);
      if (kept.get(name)?.command !== undefined) return; // a session this runner holds is simply taken again
      await endScope(name);
      guestFor(name);
      emptyToken(name);
    },
    startEgress: async () => undefined, // the proxy starts when the closed policy is given (`updateNetworkPolicy`)
    async waitGuest(name, signal) {
      const held = entry(name);
      if (held.command !== undefined && (await scopeActive(name))) return;
      if (held.command !== undefined) await stop(name); // the program ended on its own: it is started again
      const command = (held.command = await held.guest.hold({ cmd: "sh", args: ["-c", `echo ${READY}; exec sleep infinity`], unit: unitOf(name), env: { FX_ENGINE_REPO_TOKEN_FILE: path.join(tokenDirOf(name), TOKEN_FILE) }, readPaths: [tokenDirOf(name)], limitMs: deps.holderLimitMs ?? SESSION_VM_LIMIT_MS }));
      // booted is the program's own word: it is inside the sandbox, past the forwarder's start, and about to idle (the supervisor, ON-13b1, says the same line)
      const said = (async () => {
        for await (const chunk of command.logs()) if (chunk.stream === "stdout" && typeof chunk.data === "string" && chunk.data.includes(READY)) return true;
        return false;
      })();
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<false>((resolve) => void (timer = setTimeout(() => resolve(false), BOOT_MS)));
      const aborted = new Promise<false>((resolve) => signal.addEventListener("abort", () => resolve(false), { once: true }));
      const up = await Promise.race([said, late, aborted]);
      clearTimeout(timer);
      if (!up || !(await scopeActive(name))) {
        await stop(name).catch(() => undefined); // fx-swallow-ok: the failure below is the word; a scope still up is the next stop's
        throw new StandardSessionRefused("holder_failed");
      }
    },
    releaseEgress: async (name) => void (await kept.get(name)?.guest.close()),
    stop,
    destroy: remove,
    delete: remove,
  };
  /** A stop that finds the scope already gone: whatever a token file still holds is wiped all the same (the file and its directory stay, empty; nothing is made when the session has none). */
  const wipeToken = async (name: string): Promise<void> => {
    unitOf(name);
    if (deps.xdgRuntimeDir !== undefined && isDir(tokenDirOf(name))) emptyToken(name);
  };

  return {
    port,
    wipeToken,
    paths: () => {
      if (latest === undefined) throw new StandardSessionRefused("session_name");
      return latest;
    },
    state: async (name) => {
      try {
        if (await scopeActive(name)) return "running";
        return isDir(rootOf(name)) ? "stopped" : "gone";
      } catch {
        // fx-swallow-ok: the lifecycle reports an unknown state as its own failure word
        return "unknown";
      }
    },
    vm: {
      guestOf: async (handle) => entry(handle.sandboxName).guest,
      quiesce: async (handle) => void emptyToken(handle.sandboxName), // the token's content is wiped before every stop; the file stays, empty
      lifecycle: {
        port,
        registry: new VmRegistry(),
        caps: { maxVms: 1, maxVcpus: 1, maxMemoryMb: 256, snapshotDir: deps.guest.jobsRoot, snapshotQuotaBytes: 1 },
        request: { vcpus: 1, memoryMb: 1 },
        readMemAvailableBytes: () => Number.MAX_SAFE_INTEGER,
      },
    },
  };
}

type SessionHandlers = ReturnType<typeof createEngineSessionHandlers>;

/**
 * The handlers for each job's engine (`sandbox_engine`, asked again for every job, as the setup's are): a microVM runner uses the VM stack, any other the standard tier. A tier this build has none of is the
 * closed `engine_unsupported` on the first step, and nothing is started. Undefined when neither exists, so the dispatcher reports `kind_unsupported`.
 */
export function sessionHandlersFor(handlers: { microvm: SessionHandlers | undefined; standard: SessionHandlers | undefined }, engine: () => "microvm" | "os_sandbox"): SessionHandlers | undefined {
  if (handlers.microvm === undefined && handlers.standard === undefined) return undefined;
  const pick = <K extends keyof SessionHandlers>(kind: K): SessionHandlers[K] =>
    (async (context: Parameters<SessionHandlers[K]>[0]) => {
      const chosen = (engine() === "microvm" ? handlers.microvm : handlers.standard)?.[kind] as ((context: unknown) => Promise<void>) | undefined;
      if (chosen === undefined) await context.reporter.report({ step: "admission", state: "failed", failure_code: "engine_unsupported", failure_reason: "no_guest" });
      else await chosen(context);
    }) as SessionHandlers[K];
  return { engine_session_start: pick("engine_session_start"), engine_session_stop: pick("engine_session_stop"), engine_session_delete: pick("engine_session_delete") };
}
