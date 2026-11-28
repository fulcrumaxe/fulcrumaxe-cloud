/**
 * D#845 ON-8e: the standard tier's guest. A project setup on a machine with no microVM runs the SAME three fixed guest commands, the unpack script and the bundle script that the microVM runs: `runInGuest`, `sendWorkspace`,
 * `sendSetupInputs` and `pullBundle` only need the slice of the SDK sandbox below (`runCommand` detached with `logs`, `wait` and `kill`, and `writeFiles`), and this file gives them a directory on this machine.
 *
 * THREAT MODEL. The adversary is the repository and the engine's own scripts (the guest commands run untrusted project code: the install steps run its scripts). At risk: the person's home directory, the runner's state directory (keys,
 * the cloud credential), other jobs, and the network. What holds, in order:
 *  - Every command starts through the runner's own `sandboxLaunch` (bubblewrap, or Seatbelt on macOS) under `sandboxSettings`: reads of the home directory, the state directory, the agent binary's directory and the
 *    shared temp directories are denied, and the ONLY writes are this job's own root (a fresh 0700 directory below a dedicated root of the runner's cache directory). Nothing the person or the cloud grants is added.
 *  - The command's environment is the microVM table's (`microvmEnvAllowed`: a closed list of names, the pinned proxy variables) with the host's own PATH, a HOME and TMPDIR inside the root; no credential name can be in it.
 *  - Network: the sandbox has none (`--unshare-net`; on macOS the profile denies it). Its only way out is `127.0.0.1:5253`, a forwarder (the runner's own program, `__egress-serve`) that relays to ONE Unix socket in the job
 *    socket: the runner's egress proxy for this job, with the closed `project_setup` policy object the microVM gets (`vm/egress/proxy.ts`: plain DNS names in the policy, port 443, every resolved address public). The proxy holds no policy
 *    until `updateNetworkPolicy` gives it one, so a command run before that has no way out.
 *  - That socket is NOT in the job root. The guest runs as the runner's own uid and can write the whole root, so a socket there could be deleted, renamed or replaced by a link to any socket the forwarder can reach (a container runtime's),
 *    and the forwarder would follow it. It is in the runner's own directory (`egressRootOf`, a sibling of the jobs root), one 01770 directory per job, and the sandbox sees that directory READ-ONLY: it is the one read grant
 *    under a read-denied root, and no write grant covers it, so unlink, rename, link and create all fail with a read-only file system. A connect to a socket on a read-only mount still works.
 *  - The command runs in its own process-id namespace, so it cannot see, signal or trace the forwarder.
 *  - Files go in through `writeFiles` only below the root, never through a link (each parent is lstat'd, the last name is opened O_NOFOLLOW). The root is removed with the guest; a root left by a crash is swept before the next is made.
 * The macOS profile is the same rules plus loopback and that one socket; it is built by the same function as the probe's, and has no real-Seatbelt test here (the macOS path is a preview).
 */
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { InstallCapture } from "../daemon/engineKit.js";
import type { JobHandlerDeps } from "../daemon/jobHandler.js";
import { unixSocketFilter } from "../sandbox/checkSeccomp.js";
import { USER_RUNTIME_ROOT } from "../sandbox/hostSandbox.js";
import { quoted, sandboxLaunch, type SandboxHost, type SandboxProbeInput } from "../sandbox/probe.js";
import { scopedLaunch, type Budget, type ScopeTools } from "../sandbox/jobLimits.js";
import { assertEnabledSandbox, sandboxSettings } from "../sandbox/sandboxSettings.js";
import { wslDenyPaths } from "../sandbox/wslChecks.js";
import type { WslMachine } from "../sandbox/platform.js";
import type { SandboxHandle } from "../sandbox/port.js";
import { egressSocketPath, startEgressProxy, type EgressProxy, type EgressProxyOptions } from "../vm/egress/proxy.js";
import { VmRegistry, type VmPort } from "../vm/jobLifecycle.js";
import { microvmEnvAllowed } from "../vm/sandboxd/guestEnv.js";
import type { SdkCommand, SdkSandbox } from "../vm/sandboxd/sdkSlice.js";
import type { GuestPaths } from "../vm/workspace/guestWorkspace.js";
import { EGRESS_FORWARD_PORT } from "./egressServe.js";

/** Why the host guest refused. Closed set; no value of a job is in it. */
export class HostGuestRefused extends Error {
  constructor(readonly code: "env_refused" | "path_refused" | "sandbox_unavailable" | "closed" | "root_unusable" | "command_alive" | "wsl_mirrored_networking") {
    super(code);
    this.name = "HostGuestRefused";
  }
}

export interface HostGuestDeps {
  /** The engine kit's process-group start (`installCapture`): ends the whole group on the signal. */
  start: InstallCapture;
  /** The machine behind the sandbox probe: only its file questions are asked. */
  host: SandboxHost;
  platform: NodeJS.Platform;
  home: string;
  stateDir: string;
  binaryDir: string;
  /** The dedicated directory every job root is made under (absolute, outside the state directory). */
  jobsRoot: string;
  /**
   * The runner's cache directory (absolute, normalised): the directory the mirrors, workspaces, tmp, spill and launch directories live in, as `cacheRootsFor` gives it wherever `XDG_CACHE_HOME`
   * put it. It is denied for reads whole. It is named by the caller and never worked out from the jobs root's own path: a session's jobs root is nested below it (`engine-sessions/roots`), so a parent of that
   * path would be a different directory and would leave the mirrors readable.
   */
  cacheDir: string;
  /** Where bubblewrap and socat are looked for, and the guest commands' own PATH. */
  searchPath: string;
  /** This program's own command (`host.selfCommand`): `<words> __egress-serve <socket>` is the forwarder. */
  selfCommand: readonly string[];
  /** The runner's own uid: the egress directory and its socket must belong to it. */
  uid: number | undefined;
  /** WSL2: the Windows side is denied exactly as the host sandbox denies it, and a machine whose clearance went away refuses. */
  wsl?: WslMachine | undefined;
  /** Where a held command (`hold`) is started: a transient systemd user scope of its own, with this budget. Absent: `hold` refuses. */
  scope?: { tools: ScopeTools; runtimeDir: string; budget: Budget } | undefined;
  /** Test seams of the egress proxy (the resolver and the upstream connect). */
  egress?: Pick<EgressProxyOptions, "lookup" | "connect" | "ownAddresses" | "onDecision">;
}

/** A held command: one process that outlives the job that started it, in the scope `unit`. `env` is added after the table's check (the table is the closed list a job may name); `readPaths` are shown back read-only inside the hidden user runtime directory. */
export interface HoldParams {
  cmd: string;
  args: readonly string[];
  unit: string;
  limitMs: number;
  env?: Record<string, string>;
  readPaths?: readonly string[];
}
export type HostGuest = SdkSandbox & { close(): Promise<void>; hold(params: HoldParams): Promise<SdkCommand> };

const COMMAND_LIMIT_MS = 4 * 60 * 60_000;
/** How long `close` waits for an aborted command's process group to be gone before it refuses to let the root be removed. */
const COMMAND_END_WAIT_MS = 20_000;
const quote = (word: string): string => `'${word.replace(/'/g, "'\\''")}'`;

/**
 * `$1` socket, then (bubblewrap only) `$2` the bubblewrap program, then the command. The runner's own words are the only text spliced in, single-quoted.
 *
 * The forwarder needs a Unix-domain socket (its one upstream is the proxy's socket) and the seccomp filter the command runs under refuses every Unix-domain `socket` call, so the two cannot share a filtered process tree.
 * The forwarder is therefore started HERE, in the outer sandbox, which has no filter: a sibling of the command in the same namespaces (same network namespace, so `127.0.0.1:5253` is its own loopback). The command is
 * then started by a second bubblewrap whose only job is to load the filter (`--seccomp 3`; fd 3 is the filter the runner feeds) over the very same view: `--dev-bind / /` keeps every mount, hidden directory and
 * read-only flag the outer sandbox set, and no `--unshare-net` keeps the network namespace. The filter applies to that second bubblewrap's child and everything below it, never to the forwarder.
 * `--unshare-pid` and a fresh `--proc` put the command in a process-id namespace of its own: the forwarder (a sibling, outside the filter) is not in it, so the command cannot see it, kill it or trace it.
 * Readiness is asked of the loopback port itself (`__egress-wait`), not of a file: a file the forwarder can write is a file the command can write.
 */
const wrapper = (self: readonly string[], filtered: boolean): string =>
  [
    "set -u",
    filtered ? "SOCK=$1; BW=$2; shift 2" : "SOCK=$1; shift 1",
    // fd 3 (the filter) is the command's alone: the forwarder does not inherit it
    `${self.map(quote).join(" ")} __egress-serve "$SOCK" >/dev/null 2>&1 3<&- &`,
    "FWD=$!",
    // the port answers, and the forwarder that was started is still the one running
    `if ! ${self.map(quote).join(" ")} __egress-wait >/dev/null 2>&1 3<&- || ! kill -0 "$FWD" 2>/dev/null; then echo "fx-runner: the egress forwarder did not start" >&2; kill "$FWD" 2>/dev/null; exit 125; fi`,
    filtered ? '"$BW" --seccomp 3 --die-with-parent --unshare-pid --dev-bind / / --proc /proc -- "$@"; RC=$?' : '"$@"; RC=$?',
    'kill "$FWD" 2>/dev/null',
    'exit "$RC"',
  ].join("\n");

const lstatOrUndefined = (target: string): ReturnType<typeof lstatSync> | undefined => {
  try {
    return lstatSync(target);
  } catch {
    // fx-swallow-ok: "no such entry" is the answer
    return undefined;
  }
};
const inside = (root: string, target: string): boolean => {
  const rel = path.relative(root, target);
  return target === path.normalize(target) && path.isAbsolute(target) && rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

/** One file below `root`: every parent a real directory (made 0700 when missing), the last name opened without following a link. */
export function putFile(root: string, file: string, content: string, mode: number): void {
  if (!inside(root, file)) throw new HostGuestRefused("path_refused");
  let dir = root;
  for (const part of path.relative(root, path.dirname(file)).split(path.sep).filter((p) => p !== "")) {
    dir = path.join(dir, part);
    if (lstatOrUndefined(dir) === undefined) mkdirSync(dir, { mode: 0o700 });
    if (lstatSync(dir).isDirectory() !== true) throw new HostGuestRefused("path_refused");
  }
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW | constants.O_NONBLOCK, mode & 0o777);
  try {
    if (!fstatSync(fd).isFile()) throw new HostGuestRefused("path_refused");
    fchmodSync(fd, mode & 0o777);
    writeFileSync(fd, Buffer.from(content, "utf8"));
  } finally {
    closeSync(fd);
  }
}

/** Where a job root's workspace and stage directories are: the guest paths of every command and file of the job. */
export const pathsOfRoot = (root: string): GuestPaths => ({ workspace: path.join(root, "work"), stage: path.join(root, "stage") });

/** A guest over a fresh job root. `root` exists (0700) and is a direct child of `deps.jobsRoot`. */
export function createHostGuest(deps: HostGuestDeps, name: string, root: string): { guest: HostGuest; paths: GuestPaths; egressDir: string } {
  const tempDir = path.join(root, "tmp");
  // the proxy's socket lives OUTSIDE the root the guest can write (see the threat model): a runner-owned directory per job, sandboxed read-only
  const egressRoot = egressRootOf(deps.jobsRoot);
  ensureRunnerDir(egressRoot, deps.uid);
  // The runner's whole cache directory (mirrors, workspaces, tmp, spill, launch, setup-guests, setup-egress) wherever `XDG_CACHE_HOME` put it: denied for reads, so
  // naming only the home directory would leave other repos' mirrors and other jobs' files readable when the cache sits outside it. Its own root and egress directory are
  // the narrower grants (a narrower allow wins).
  const cacheDir = path.normalize(deps.cacheDir);
  const egressDir = path.join(egressRoot, path.basename(root));
  removeRoot(egressDir); // a directory a crashed run left under this name
  const socket = egressSocketPath(egressDir);
  mkdirSync(tempDir, { mode: 0o700, recursive: true }); // a session's root is kept between jobs: its tmp may exist
  mkdirSync(egressDir, { mode: 0o700 });
  chmodSync(egressDir, 0o1770); // the mode the proxy's own check demands: owner and group, sticky
  const paths = pathsOfRoot(root);
  const input: SandboxProbeInput = { platform: deps.platform, home: deps.home, stateDir: deps.stateDir, binaryDir: deps.binaryDir, searchPath: deps.searchPath };
  const filteredProgram = wrapper(deps.selfCommand, true);
  const plainProgram = wrapper(deps.selfCommand, false);
  /** Each running command's abort and the promise that settles once its process group has ended. */
  const running = new Map<AbortController, Promise<unknown>>();
  let proxy: EgressProxy | undefined;
  let closed = false;

  /** The rules, built fresh for each command so a WSL2 clearance that went away is seen at once. */
  const settingsNow = (): Record<string, unknown> => {
    let wslDeny: string[] | undefined;
    if (deps.wsl?.clearance !== undefined) {
      // D#587 B-9d: the host guest runs a machine job in the host's own sandbox, so a clearance that was not granted for NAT networking refuses it, as for an ordinary job.
      if (!deps.wsl.clearance.nat) throw new HostGuestRefused("wsl_mirrored_networking");
      const table = deps.wsl.mountinfo();
      if (deps.wsl.interopEntry() || table === undefined || table.trim() === "") throw new HostGuestRefused("sandbox_unavailable");
      wslDeny = [...new Set([...deps.wsl.clearance.denyPaths, ...wslDenyPaths(deps.wsl)])];
    }
    const settings = sandboxSettings({ workspace: root, tempDir, home: deps.home, stateDir: deps.stateDir, binaryDir: deps.binaryDir, workspaceRoot: deps.jobsRoot, tempRoot: deps.jobsRoot, spillRoot: egressRoot, extraReadPaths: [egressDir], denyReadRoots: [cacheDir], ...(wslDeny === undefined ? {} : { wslDenyPaths: wslDeny }) });
    assertEnabledSandbox(settings);
    return settings;
  };
  /** The microVM table's names and pinned values, with this machine's own PATH, HOME and TMPDIR (the guest's own values are the VM's). */
  const envOf = (given: Record<string, string> | undefined): Record<string, string> => {
    if (!microvmEnvAllowed(given ?? {})) throw new HostGuestRefused("env_refused");
    const env: Record<string, string> = { ...(given ?? {}), PATH: deps.searchPath, HOME: tempDir, TMPDIR: tempDir };
    delete env["USER"];
    delete env["LOGNAME"];
    return env;
  };

  const guest = {
    name,
    status: "running",
    async updateNetworkPolicy(policy: unknown): Promise<unknown> {
      if (closed || deps.uid === undefined) throw new HostGuestRefused("closed");
      const old = proxy;
      proxy = undefined;
      await old?.close();
      // a policy the proxy cannot read throws here, before any socket exists: the guest keeps no way out
      proxy = await startEgressProxy({ vsockDir: egressDir, sandboxId: path.basename(egressDir), uid: deps.uid, policy, ...(deps.egress ?? {}), ownerOnly: true });
      return undefined;
    },
    async writeFiles(files: { path: string; content: string; mode?: number }[]): Promise<void> {
      if (closed) throw new HostGuestRefused("closed");
      for (const file of files) putFile(root, file.path, file.content, file.mode ?? 0o644);
    },
    /** One process that outlives the job that started it (D#845 ON-13a3): the same sandbox, forwarder and filter as `runCommand`, started in a scope of its own. */
    hold: (params: HoldParams): Promise<SdkCommand> => (guest.runCommand as unknown as (p: { cmd: string; args: string[] }, h: HoldParams) => Promise<SdkCommand>)({ cmd: params.cmd, args: [...params.args] }, params),
    async runCommand(params: { cmd: string; args?: string[]; cwd?: string; env?: Record<string, string>; signal?: AbortSignal }, hold?: HoldParams): Promise<SdkCommand> {
      if (closed) throw new HostGuestRefused("closed");
      const cwd = params.cwd ?? root;
      if (cwd !== root && !inside(root, cwd)) throw new HostGuestRefused("path_refused");
      if (hold !== undefined && (deps.scope === undefined || deps.platform !== "linux")) throw new HostGuestRefused("sandbox_unavailable");
      const env = { ...envOf(params.env), ...(hold?.env ?? {}) };
      const files = deps.selfCommand.filter((word) => path.isAbsolute(word) && deps.host.isFile(word));
      const settings = settingsNow();
      // which tool this machine uses is asked first (the command is only a placeholder): a bubblewrap one gets the filtered wrapper with the tool's own path as an argument
      const probe = sandboxLaunch(input, settings, deps.searchPath, ["true"], deps.host, files);
      if (!probe.ok) throw new HostGuestRefused("sandbox_unavailable");
      const bubblewrap = probe.kind === "bubblewrap";
      // a machine with no filter program for its architecture fails closed: the command never runs without the filter
      const filter = bubblewrap ? unixSocketFilter() : undefined;
      if (bubblewrap && filter === undefined) throw new HostGuestRefused("sandbox_unavailable");
      const launch = sandboxLaunch(input, settings, deps.searchPath, ["sh", "-c", bubblewrap ? filteredProgram : plainProgram, "fx-egress", socket, ...(bubblewrap ? [probe.tool] : []), params.cmd, ...(params.args ?? [])], deps.host, files);
      if (!launch.ok) throw new HostGuestRefused("sandbox_unavailable");
      let argv: string[];
      if (launch.kind === "seatbelt") {
        // macOS: the profile denies the network whole; the forwarder's one loopback port and the proxy's one socket are laid over it
        const port = `localhost:${String(EGRESS_FORWARD_PORT)}`;
        argv = launch.args.map((arg, i) => (i === 1 ? `${arg}(allow network* (local ip "${port}") (remote ip "${port}"))(allow network-outbound (remote unix-socket (path-literal ${quoted(socket)})))` : arg));
      } else {
        // the user's runtime directory holds the session bus and other sockets that start programs as the person; it is hidden whole, exactly as the check's sandbox does (`hostSandbox.ts`)
        const split = launch.args.indexOf("--");
        // a held command's own paths (the token directory) are put back after that, read-only
        argv = [...launch.args.slice(0, split), ...(deps.host.isDir(USER_RUNTIME_ROOT) ? ["--tmpfs", USER_RUNTIME_ROOT] : []), ...(hold?.readPaths ?? []).flatMap((p) => ["--ro-bind", p, p]), ...launch.args.slice(split)];
      }
      let program = launch.tool;
      let programArgs = argv;
      let programEnv = env;
      if (hold !== undefined && deps.scope !== undefined) {
        const scoped = scopedLaunch(deps.scope.tools, hold.unit, deps.scope.budget, launch.tool, argv);
        program = scoped.command;
        programArgs = scoped.args;
        programEnv = { ...env, XDG_RUNTIME_DIR: deps.scope.runtimeDir };
      }
      const abort = new AbortController();
      params.signal?.addEventListener("abort", () => abort.abort(), { once: true });
      const queue: { stream: string; data: string }[] = [];
      const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
      let wake: (() => void) | undefined;
      let over = false;
      const done = deps
        .start(program, programArgs, programEnv, cwd, hold?.limitMs ?? COMMAND_LIMIT_MS, 1, abort.signal, filter, undefined, (stream, chunk) => {
          const data = decoders[stream].write(chunk);
          if (data !== "") queue.push({ stream, data });
          wake?.();
        })
        .then((result) => ({ exitCode: result.code ?? 137 }))
        .finally(() => {
          running.delete(abort);
          for (const stream of ["stdout", "stderr"] as const) {
            const rest = decoders[stream].end();
            if (rest !== "") queue.push({ stream, data: rest });
          }
          over = true;
          wake?.();
        });
      done.catch(() => undefined); // fx-swallow-ok: `wait` reports it; an unread rejection is not an unhandled one
      running.set(abort, done);
      return {
        async *logs() {
          for (;;) {
            while (queue.length > 0) yield queue.shift() as { stream: string; data: string };
            if (over) return;
            await new Promise<void>((resolve) => void (wake = resolve));
          }
        },
        wait: () => done,
        kill: async () => abort.abort(),
      };
    },
    async extendTimeout(): Promise<void> {},
    async stop(): Promise<void> {},
    async delete(): Promise<void> {
      await guest.close();
    },
    currentSession: () => {
      throw new HostGuestRefused("closed");
    },
    listSessions: () => {
      throw new HostGuestRefused("closed");
    },
    async close(): Promise<void> {
      closed = true;
      for (const abort of running.keys()) abort.abort();
      const old = proxy;
      proxy = undefined;
      await old?.close();
      // the root is removed after this returns: nothing of the command may still be writing in it. A command that does not end in time is an error, and the caller leaves the root for the next sweep
      const ended = Promise.allSettled([...running.values()]).then(() => true);
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<false>((resolve) => void (timer = setTimeout(() => resolve(false), COMMAND_END_WAIT_MS)));
      const settled = await Promise.race([ended, late]);
      clearTimeout(timer);
      if (!settled) throw new HostGuestRefused("command_alive");
      removeRoot(egressDir); // the proxy is closed and every command is gone: nothing is using this directory
    },
  } as unknown as HostGuest;
  return { guest, paths, egressDir };
}

/**
 * Removes a root the sandbox wrote in: every directory is given its owner's access back first (a package manager leaves read-only ones). Only called once the guest's commands have ended (`close` waits for them), so
 * nothing swaps an entry between the look and the change. No link is followed: an entry is looked at with `lstat`, only a real directory is opened up and entered, and a link is unlinked itself (a link left in the
 * root would otherwise be a way to make the runner change the mode of, or list, anything its owner can reach).
 */
export function removeRoot(root: string): void {
  const reopen = (entry: string): void => {
    const info = lstatOrUndefined(entry);
    if (info === undefined) return;
    if (info.isSymbolicLink()) {
      unlinkSync(entry);
      return;
    }
    if (!info.isDirectory()) return;
    chmodSync(entry, 0o700);
    for (const name of readdirSync(entry)) reopen(path.join(entry, name));
  };
  reopen(root);
  rmSync(root, { recursive: true, force: true });
}

/** The directory of one job's guest, named from the sandbox name (a name is never a path). */
export const rootNameOf = (name: string): string => `g-${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;

/** The runner's own directory of per-job egress directories: next to the jobs root, never inside a job root. */
export const egressRootOf = (jobsRoot: string): string => path.join(path.dirname(jobsRoot), "setup-egress");

/** A runner-owned directory (the jobs root, the egress root): a real directory, 0700, made if missing; anything else refuses. */
export function ensureRunnerDir(dir: string, uid: number | undefined): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || (uid !== undefined && info.uid !== uid)) throw new HostGuestRefused("root_unusable");
}

/**
 * The standard tier's `vm` slice for the project setup handler (`ProjectSetupDeps.vm`): the same `runVmJob` lifecycle, over a factory whose "VM" is a job root and whose guest is `createHostGuest`. The caps are the one-at-a-time
 * of the dispatcher (there is no VM to size), so admission only refuses a second guest while one is up.
 */
export function createHostSetupVm(deps: HostGuestDeps): Pick<NonNullable<JobHandlerDeps["vm"]>, "guestOf" | "lifecycle"> & { pathsOf(name: string): GuestPaths } {
  const guests = new Map<string, { guest: HostGuest; root: string }>();
  const entry = (id: string): { guest: HostGuest; root: string } => {
    const found = guests.get(id);
    if (found === undefined) throw new HostGuestRefused("closed");
    return found;
  };
  const end = async (id: string): Promise<void> => {
    const found = guests.get(id);
    if (found === undefined) return;
    await found.guest.close();
    removeRoot(found.root);
    guests.delete(id);
  };
  const port: VmPort = {
    async create(id) {
      ensureRunnerDir(deps.jobsRoot, deps.uid);
      // a root a crashed run left is swept now: this daemon holds the ledger lock and runs one setup at a time
      const keep = new Set([...guests.values()].map((g) => path.basename(g.root)));
      for (const stale of readdirSync(deps.jobsRoot)) if (!keep.has(stale)) removeRoot(path.join(deps.jobsRoot, stale));
      const egressRoot = egressRootOf(deps.jobsRoot);
      ensureRunnerDir(egressRoot, deps.uid);
      for (const stale of readdirSync(egressRoot)) if (!keep.has(stale)) removeRoot(path.join(egressRoot, stale));
      const root = path.join(deps.jobsRoot, rootNameOf(id));
      mkdirSync(root, { mode: 0o700 });
      guests.set(id, { guest: createHostGuest(deps, id, root).guest, root });
    },
    // the proxy starts when the closed policy is given (`updateNetworkPolicy`); until then the guest has no way out
    startEgress: async () => undefined,
    // one trivial command under the real rules: a machine that cannot start the sandbox ends here as a boot failure, not as a workspace failure
    async waitGuest(id, signal) {
      const command = await entry(id).guest.runCommand({ cmd: "true", detached: true, signal });
      if ((await command.wait()).exitCode !== 0) throw new HostGuestRefused("sandbox_unavailable");
    },
    releaseEgress: (id) => entry(id).guest.close(),
    stop: async () => undefined,
    destroy: end,
    delete: end,
  };
  return {
    guestOf: async (handle: SandboxHandle) => entry(handle.sandboxName).guest,
    // the root's name comes from the sandbox name alone, so the handler knows the guest's paths before the guest exists
    pathsOf: (name: string) => pathsOfRoot(path.join(deps.jobsRoot, rootNameOf(name))),
    lifecycle: {
      port,
      registry: new VmRegistry(),
      caps: { maxVms: 1, maxVcpus: 1, maxMemoryMb: 256, snapshotDir: deps.jobsRoot, snapshotQuotaBytes: 1 },
      request: { vcpus: 1, memoryMb: 1 },
      readMemAvailableBytes: () => Number.MAX_SAFE_INTEGER,
    },
  };
}
