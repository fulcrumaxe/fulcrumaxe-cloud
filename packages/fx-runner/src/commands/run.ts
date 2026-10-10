/**
 * `fx-runner run`: the daemon's composition root (D#6 R4a-2b, correction C26 section 2). It joins the parts that exist on their own:
 * the signed client, `verifyJob` against the keys pinned in the build, the job ledger, git path B, the agent engine inside the host
 * sandbox tier, the job handler and the claim loop. It opens no listening socket, starts no program itself (the entry point hands in
 * the engine kit, which holds the process start) and names no engine.
 *
 * Before the first claim, in this order, each failure stops the command with a non-zero exit and a fixed message:
 *  - this machine is registered and its key matches (as `status` checks);
 *  - an `api_key` runner has a usable key file (`api_key_not_configured`, `api_key_unsafe`, `api_key_format`); the file is read again at the start of each job;
 *  - the build pins job-signing keys for the registration's cloud address (`job_keyring_missing`);
 *  - the platform has a sandbox tier and the agent CLI is found (looked up once, here: a job never consults the search path). A machine whose
 *    sandbox does not start is NOT a stop (D#6 R4a-6, C16 section 1.3): the sandbox probe runs here and again before each claim while it
 *    fails (at most every 5 minutes), the daemon claims nothing while it fails and tells the cloud the reason code on each poll, and it
 *    recovers without a restart when the machine is fixed. There is no unsandboxed path;
 *  - the mirrors directory overlaps none of the runner's own directories, also through a link (`mirrors_root_overlap`);
 *  - stale leftovers next to the ledger are removed, then the ledger is taken (another `run` holds it: exit non-zero);
 *  - the ledger is not closed by damage (`ledger_closed`): nothing that is not on the ledger runs, so no claim is made.
 * SIGINT or SIGTERM stops the job in hand (the sandbox stops its agent, 3 seconds of grace at most) and reports `runner_shutdown`.
 * With tmux on the machine, each job also gets a watch session the owner can `attach` to (D#6 R4a-7); without it jobs run unwatched.
 */
import path from "node:path";
import { CliError } from "../cliError.js";
import { requireUsable } from "../protectionBypass.js";
import { loadRegistration, type Registration } from "../config.js";
import type { CommandContext } from "../context.js";
import { ApiKeyError, perJobApiKey, readApiKey } from "../credentials.js";
import { createAdmission } from "../daemon/admission.js";
import { createUsageGate } from "../daemon/usageGate.js";
import { createFootprintStore } from "../daemon/footprints.js";
import { realResourceProbe, type ResourceProbe } from "../daemon/resources.js";
import { isPaused, loadSettings } from "../runnerSettings.js";
import { createJobsInHand } from "../daemon/jobsInHand.js";
import { createRunnerClient } from "../daemon/client.js";
import { createSandboxGate } from "../daemon/sandboxGate.js";
import type { EngineKit } from "../daemon/engineKit.js";
import { createGitPath } from "../daemon/gitPath.js";
import { createGitPathA } from "../daemon/gitPathA.js";
import { createJobHandler } from "../daemon/jobHandler.js";
import { createNixShell, findNix, findTool, identityVia } from "../daemon/nixShell.js";
import { createJobWatch } from "../daemon/watch.js";
import { createEventRelay, realClock, type Clock } from "../daemon/lease.js";
import { createAutoUpdate, type UpdateHost } from "../update/updater.js";
import { createUpdater, type UpdateHooks } from "./update.js";
import { createFileLedger, LedgerLockedError, type FileLedger } from "../daemon/ledger.js";
import { cacheRootsFor, mirrorKeepClear, type RepoRef } from "../daemon/mirror.js";
import { abortOnSignals, pollLoop, type PollEvent } from "../daemon/pollLoop.js";
import { removeStaleLedgerTemp } from "../daemon/staleTemp.js";
import { cleanEnv, type CredentialMode } from "../job/cleanEnv.js";
import { createWorkspaceStore } from "../job/workspace.js";
import { loadRunnerKey } from "../keys.js";
import { gitProxyHashFor, keyringFor, type PinnedGitProxies, type PinnedKeyrings } from "../keyring.js";
import { createHostSandbox } from "../sandbox/hostSandbox.js";
import { SandboxRefused } from "../sandbox/platform.js";
import { probeMachine, type SandboxHost } from "../sandbox/probe.js";
import { pathsOverlap } from "../sandbox/sandboxSettings.js";
import { commandOnPath, resolveSandboxTools, sandboxToolDirs, selectTier } from "../sandbox/select.js";
import { describeToolchain, resolveToolchain, toolchainPathDirs, toolchainReadPaths } from "../sandbox/toolchain.js";
import { socketPath } from "../watch/layout.js";
import { MAX_SOCKET_PATH_BYTES, findTmux, tmuxEnv } from "../watch/tmux.js";

export const LEDGER_FILE = "jobs.ledger";
const DEFAULT_MODEL = "sonnet";

/** What `run` needs from the machine it runs on. Only `bin/fx-runner.mjs` fills it in, from the real program. */
export interface RunHost {
  home: string | undefined;
  platform: NodeJS.Platform;
  /** `XDG_CACHE_HOME`, looked up by name by the caller. */
  xdgCacheHome?: string | undefined;
  /** Where SIGINT and SIGTERM arrive. */
  signals: Pick<NodeJS.Process, "once" | "off">;
  /** This program's pid, which the ledger's lock carries. */
  pid: number;
  /** `kill(pid, 0)`: throws `ESRCH` for a program that is gone, `EPERM` for one that belongs to another user. */
  kill: (pid: number, signal: 0) => unknown;
  engine: EngineKit;
  /** The machine behind the sandbox probe (the same host `doctor` uses): the process start and the file reads. */
  sandbox: SandboxHost;
  /** The kernel release string; the machine's own when left out. Tests set it. */
  osrelease?: string | undefined;
  /** How this program starts itself again (runtime, its flags, script), for a watch pane. Absent: no watch. */
  selfCommand?: readonly string[] | undefined;
  /** `TERM`, looked up by name by the caller: the terminal type the tmux client attaches with. */
  term?: string | undefined;
  /** Asks the person one question on the terminal and gives the answer line. Only `attach --take-over` uses it. */
  ask?: ((question: string) => Promise<string>) | undefined;
  /** The user id this program runs as, looked up by the caller: the tmux socket and its directory must belong to it. */
  uid?: number | undefined;
  /** Whether standard input is a terminal. */
  interactive?: boolean | undefined;
}

/** Replaceable by a test only: `runCli` never passes any, and nothing in the environment or on the command line can. */
export interface RunHooks {
  keyrings?: PinnedKeyrings;
  /** The pinned GitHub proxies for path A (default: the build's `PINNED_GIT_PROXIES`). */
  gitProxies?: PinnedGitProxies;
  clock?: Clock;
  /** The search path for the agent CLI, bubblewrap and socat. Default: the PATH of the clean environment. */
  searchPath?: string;
  remoteUrl?: (repo: RepoRef) => string;
  /** The release client for self-update (default: the build's). */
  updateTuf?: UpdateHooks["tuf"];
  /** What the machine has free (default: the real one). */
  probe?: ResourceProbe;
}

/** Whether a process with this pid exists: ESRCH means gone; success and EPERM (another user's process) mean it is there. */
export function pidIsAlive(kill: RunHost["kill"], pid: number): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    // fx-swallow-ok: the answer is the point; only ESRCH is a process that is gone
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** The credentials for one use now (the take-over pane): an API key is read from its file once, here. The daemon reads it again for every job instead. */
export function credentialsOf(registration: Registration, ctx: Pick<CommandContext, "stateDir" | "uid">): CredentialMode {
  return registration.credential_mode === "subscription" ? { mode: "subscription" } : { mode: "api_key", apiKey: readApiKey(ctx.stateDir, ctx.uid) };
}

/** Reads the key for the job about to start. A problem is said on the terminal in fixed words and ends the job `api_key_not_configured`, before anything starts. */
export function readyOrCode(refresh: () => void, ctx: CommandContext): string | undefined {
  try {
    refresh();
    return undefined;
  } catch (error) {
    if (!(error instanceof ApiKeyError)) throw error;
    ctx.out(`fx-runner: ${error.message}`);
    return "api_key_not_configured";
  }
}

/** Where bubblewrap and socat are, as the directories to put on the agent's PATH. Empty when a tool is missing: the probe says so, and the gate holds. */
function sandboxDirs(host: RunHost, searchPath: string): string[] {
  try {
    return sandboxToolDirs(resolveSandboxTools(searchPath, { platform: host.platform }));
  } catch (error) {
    if (error instanceof SandboxRefused && (error.code === "bubblewrap_missing" || error.code === "socat_missing")) return [];
    throw error;
  }
}

/**
 * The agent CLI and the sandbox tools' directories, or the refusal for a platform that has no sandbox at all (Windows, WSL1, WSL2, anything
 * else). A machine that only lacks bubblewrap or socat gets no refusal here: it starts, reports the reason and claims nothing.
 */
export function localTools(host: RunHost, searchPath: string): { binaryPath: string; toolDirs: string[] } {
  try {
    try {
      selectTier({ platform: host.platform, osrelease: host.osrelease, hasCommand: (name) => commandOnPath(name, searchPath) });
    } catch (error) {
      if (!(error instanceof SandboxRefused && (error.code === "bubblewrap_missing" || error.code === "socat_missing"))) throw error;
    }
    return { binaryPath: host.engine.locate(searchPath), toolDirs: sandboxDirs(host, searchPath) };
  } catch (error) {
    if (error instanceof SandboxRefused || (error instanceof Error && error.name === "EngineRefusal")) throw new CliError(`${error.message}; fx-runner cannot run jobs here`);
    throw error;
  }
}

function describePoll(event: PollEvent): string | undefined {
  if (event.event === "idle" || event.event === "rate_limited") return undefined;
  if (event.event === "sandbox_unavailable") return undefined;
  if (event.event === "error") return `cloud error ${event.status}${event.code === undefined ? "" : ` ${event.code}`}`;
  if (event.event === "refused") return `refused ${event.runId} (${event.reason})`;
  return event.event === "claimed" || event.event === "discarded" ? `${event.event} ${event.runId}` : event.event;
}

/** The exit code that asks a service manager to start the program again, on the version the stable link now names (`EX_TEMPFAIL`). */
export const EXIT_RESTART_FOR_UPDATE = 75;

export async function runCommand(ctx: CommandContext, host: RunHost, hooks: RunHooks = {}, updateHost?: UpdateHost): Promise<number> {
  const registration = loadRegistration(ctx.stateDir);
  if (!registration) throw new CliError("not registered; run: fx-runner register --code <code> --credential-mode <mode> --cloud-url <url>");
  const key = loadRunnerKey(ctx.stateDir);
  if (!key || key.jkt !== registration.jkt) throw new CliError("the runner key is missing or does not match the registration; run: fx-runner revoke --local, then register again");
  const keyring = keyringFor(registration.cloud_origin, hooks.keyrings);
  if (keyring === undefined) throw new CliError("job_keyring_missing: this build pins no job-signing keys for the cloud this runner is registered with, so it will claim nothing");
  // An api_key runner needs its key file before it claims anything; each job reads the file again (the daemon holds no key between jobs).
  const live = registration.credential_mode === "api_key" ? perJobApiKey(ctx.stateDir, ctx.uid) : undefined;
  live?.refresh();
  const credentials: CredentialMode = live?.credentials ?? { mode: "subscription" };
  const home = host.home;
  if (home === undefined || !path.isAbsolute(home)) throw new CliError("cannot find your home directory");

  const searchPath = hooks.searchPath ?? cleanEnv(credentials).PATH ?? "";
  const { binaryPath, toolDirs } = localTools(host, searchPath);
  // The minimum toolchain for a project's own tests (D#6 R4d-3): found once here, its directories at the end of the agent's PATH, and the
  // install prefixes under the home directory as read-only grants. A tool that is not found is skipped; one that may not be granted is left out.
  const { mirrorsRoot, workspaceRoot, tempRoot } = cacheRootsFor({ home, platform: host.platform, xdgCacheHome: host.xdgCacheHome });
  const toolchain = resolveToolchain(searchPath, { home, stateDir: ctx.stateDir, binaryDir: path.dirname(binaryPath), jobAreas: [mirrorsRoot, workspaceRoot, tempRoot] });
  const toolchainDirs = toolchainPathDirs(toolchain);
  toolDirs.push(...toolchainDirs.filter((dir) => !toolDirs.includes(dir)));
  const envOptions = { extraPathDirs: toolDirs };

  // The runner's own directories. The state directory is private; the workspaces, temp directories and mirrors sit beside each other in the cache directory.
  const stateDir = ctx.stateDir;
  const keepClear = mirrorKeepClear({ home, stateDir, binaryDir: path.dirname(binaryPath), workspaceRoot, tempRoot });
  if (keepClear.some((other) => pathsOverlap(mirrorsRoot, other))) throw new CliError("mirrors_root_overlap: the repo mirrors directory overlaps the runner's state, binary, workspace or temp directory");

  const ledgerFile = path.join(stateDir, LEDGER_FILE);
  removeStaleLedgerTemp(ledgerFile, ctx.now());
  let ledger: FileLedger;
  try {
    ledger = createFileLedger(ledgerFile, { pid: host.pid, isAlive: (pid) => pidIsAlive(host.kill, pid), now: ctx.now });
  } catch (error) {
    if (error instanceof LedgerLockedError) throw new CliError("another fx-runner run is using this state directory");
    throw error;
  }
  try {
    // Closed (damaged or quarantined): nothing that is not on the ledger runs, so no claim is made. One message, one exit, no polling.
    if (ledger.closed) throw new CliError("ledger_closed: the job ledger is damaged and was moved aside (see jobs.ledger.damaged-* in the state directory), so no job can be claimed");

    const clock = hooks.clock ?? realClock;
    const relay = createEventRelay();
    // Claim gating on the plan's usage limit (D#6 C43-6): reads every job's metadata events, so one job's limit holds back the claims of all. A runner on an API key has no plan window.
    const usage = createUsageGate({ credentialMode: registration.credential_mode === "subscription" ? "subscription" : "api_key", now: () => clock.now().getTime() });
    const stopped = new AbortController();
    const client = createRunnerClient({ origin: registration.cloud_origin, key, now: ctx.now, fetchFn: ctx.fetchFn, bypass: requireUsable(ctx.bypass) });
    const git = createGitPath({ capture: host.engine.capture, envOptions, mirrorsRoot, stateDir, keepClear, signal: stopped.signal, ...(hooks.remoteUrl === undefined ? {} : { remoteUrl: hooks.remoteUrl }) });
    // Path A (cloud-verified jobs) exists only where this build pins a GitHub proxy for the cloud; a verified job elsewhere ends `git_proxy_unpinned`.
    const gitA = gitProxyHashFor(registration.cloud_origin, hooks.gitProxies) === undefined ? undefined : createGitPathA({ capture: host.engine.capture, envOptions, mirrorsRoot, stateDir, keepClear, signal: stopped.signal, cloudOrigin: registration.cloud_origin, platform: host.platform, mintTicket: (runId, generation) => client.gitTicket(runId, generation), ...(hooks.gitProxies === undefined ? {} : { pinned: hooks.gitProxies }) });
    const sandbox = createHostSandbox({
      credentials,
      envOptions,
      home,
      tempRoot,
      workspaceRoot,
      stateDir,
      binaryDir: path.dirname(binaryPath),
      mirrorsRoot,
      toolchainReadPaths: toolchainReadPaths(toolchain),
      packageStoreRoot: path.join(path.dirname(mirrorsRoot), "pnpm-store"),
      makeRuntime: (sandboxSettings, protectedPaths, jobEnv) => host.engine.makeRuntime({ binaryPath, credentials, envOptions, sandboxSettings, protectedPaths, stateDir, onLocalEvent: (event) => (usage.observe(event), relay.emit(event)), onNearLimit: (info) => usage.warn(info), ...(jobEnv === undefined ? {} : { jobEnv }) }),
    });
    const socketTooLong = Buffer.byteLength(socketPath(stateDir)) > MAX_SOCKET_PATH_BYTES;
    const tmuxBinary = host.selfCommand === undefined || socketTooLong ? undefined : findTmux(searchPath);
    if (host.selfCommand !== undefined && socketTooLong) ctx.out("fx-runner: the state directory path is too long for a tmux socket; jobs run without a watch session");
    else if (host.selfCommand !== undefined && tmuxBinary === undefined) ctx.out("fx-runner: tmux not found; jobs run without a watch session");
    const watch =
      tmuxBinary === undefined || host.selfCommand === undefined
        ? undefined
        : createJobWatch({ clock, tmux: { binary: tmuxBinary, stateDir, capture: host.engine.capture, env: tmuxEnv({ home, path: searchPath, stateDir, term: host.term }), selfCommand: host.selfCommand } });
    // D#6 R7c: the dev shell step. Wired only where the engine offers the large capture; it still skips each job without a `nix` on the search path.
    const nix =
      host.engine.captureLarge === undefined
        ? undefined
        : createNixShell({ nixBin: findNix(searchPath), bwrapBin: findTool("bwrap", searchPath), ...(findTool("git", searchPath) === undefined ? {} : { gitBin: findTool("git", searchPath) }), capture: host.engine.captureLarge, dataDir: path.join(path.dirname(mirrorsRoot), "nix-shell"), identity: identityVia(host.engine.capture), signal: stopped.signal });
    const handle = createJobHandler({
      ...(nix === undefined ? {} : { nix, onNixSkip: (skip: string) => ctx.out(`fx-runner: no Nix dev shell for this job (${skip})`), onNixDetail: (detail: string) => ctx.out(`fx-runner: Nix dev shell for this job (${detail})`) }),
      ...(watch === undefined ? {} : { watch, interrupt: (job) => sandbox.interrupt(job) }),
      client,
      keyring,
      clock,
      ledger,
      ...(live === undefined ? {} : { credentialsReady: () => readyOrCode(() => live.refresh(), ctx) }),
      git,
      ...(gitA === undefined ? {} : { gitA }),
      sandbox,
      events: relay,
      shutdown: stopped.signal,
      run: { workspaces: createWorkspaceStore(workspaceRoot), credentials, envOptions, planSession: (continues) => host.engine.planSession(stateDir, continues), defaultModel: DEFAULT_MODEL },
      recordSession: (sessionId, workspace) => host.engine.recordSession(stateDir, sessionId, workspace),
    });

    // The claim gate (C16 section 1.3). Each probe first looks for bubblewrap and socat again, so a tool installed while the daemon runs is found
    // (the directories are updated in place: every user of `envOptions` reads them when it builds an environment).
    const gate = createSandboxGate({
      now: ctx.now,
      probe: () => {
        const found = sandboxDirs(host, searchPath);
        toolDirs.splice(0, toolDirs.length, ...found, ...toolchainDirs.filter((dir) => !found.includes(dir)));
        return probeMachine({ platform: host.platform, home, stateDir, binaryPath, xdgCacheHome: host.xdgCacheHome, searchPath }, host.sandbox);
      },
    });
    let lastReason: string | undefined;
    // Self-update (D#6 R6-2b): checked at the top of the claim loop, and never while any job is in hand. A count, so one job ending does not clear the others (C43-3).
    const jobs = createJobsInHand();
    const updater = updateHost === undefined ? undefined : createUpdater(ctx, updateHost, hooks.updateTuf === undefined ? {} : { tuf: hooks.updateTuf });
    const autoUpdate = updater === undefined ? undefined : createAutoUpdate({ updater, hasLease: () => jobs.any(), now: ctx.now });
    const detach = abortOnSignals(stopped, host.signals);
    // macOS only: libuv's free-memory figure counts free pages alone, so the latest `vm_stat` (run through the engine's process start) gives the usable memory.
    let vmStat: string | undefined;
    const refreshVmStat = async (): Promise<void> => {
      try {
        const result = await host.engine.capture("/usr/bin/vm_stat", [], {}, 2000);
        if (result.code === 0) vmStat = result.stdout;
      } catch {
        // fx-swallow-ok: without a reading the probe uses the operating system's free-page count, which is lower, so admission errs on the careful side
      }
    };
    const vmStatTimer = host.platform === "darwin" && hooks.probe === undefined ? setInterval(() => void refreshVmStat(), 5000) : undefined;
    vmStatTimer?.unref();
    try {
      // A previous run that stopped between staging and switching left a partial version directory: gone before anything else.
      await updater?.cleanup().catch(() => undefined);
      ctx.out(`fx-runner: running as runner ${registration.runner_id}; stop with Ctrl-C`);
      const described = describeToolchain(toolchain);
      ctx.out(`fx-runner: toolchain: ${described.line}`);
      for (const warning of described.warnings) ctx.out(`fx-runner: ${warning}`);
      if (vmStatTimer !== undefined) await refreshVmStat();
      const first = await gate.check();
      if (!first.open) ctx.out(`fx-runner: the sandbox does not work on this machine (${first.reason}); no job will be claimed until it does. Run: fx-runner doctor`);
      lastReason = first.open ? undefined : first.reason;
      const end = await pollLoop({
        client,
        clock,
        gate,
        signal: stopped.signal,
        // Several runs at once while the machine has room (D#6 C43-4). Settings and the pause are read again before every claim.
        admission: createAdmission({
          probe: hooks.probe ?? realResourceProbe({ platform: host.platform, diskPaths: [workspaceRoot, path.dirname(mirrorsRoot)], vmStatText: () => vmStat }),
          footprints: createFootprintStore(stateDir),
          settings: () => loadSettings(stateDir),
          paused: () => isPaused(stateDir),
          usage: () => usage.state(),
          now: () => clock.now().getTime(),
        }),
        onClaimed: (claimed) => jobs.track(() => handle(claimed)),
        ...(autoUpdate === undefined || updateHost === undefined
          ? {}
          : {
              betweenJobs: async () => {
                const outcome = await autoUpdate.tick();
                if (outcome.kind !== "applied") return undefined;
                if (updateHost.inService) {
                  ctx.out(`fx-runner: updated to ${outcome.version}; restarting on it`);
                  return "restart" as const;
                }
                ctx.out(`Updated to ${outcome.version}. Restart \`fx-runner run\` to use it.`);
                return undefined;
              },
            }),
        log: (event) => {
          // Said when the answer changes, not on every poll.
          const reason = event.event === "sandbox_unavailable" ? event.reason : event.event === "idle" || event.event === "rate_limited" ? undefined : lastReason;
          if (reason !== lastReason) ctx.out(reason === undefined ? "fx-runner: the sandbox works again; claiming jobs" : `fx-runner: the sandbox does not work on this machine (${reason}); no job will be claimed. Run: fx-runner doctor`);
          lastReason = reason;
          const line = describePoll(event);
          if (line !== undefined) ctx.out(`fx-runner: ${line}`);
        },
      });
      if (end === "restart") return EXIT_RESTART_FOR_UPDATE;
      if (end === "unauthorized") throw new CliError("the cloud no longer accepts this runner's key; run: fx-runner revoke --local, then register again");
      return 0;
    } finally {
      if (vmStatTimer !== undefined) clearInterval(vmStatTimer);
      detach();
    }
  } finally {
    ledger.close();
  }
}
