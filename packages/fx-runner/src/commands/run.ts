/**
 * `fx-runner run`: the daemon's composition root (D#6 R4a-2b, correction C26 section 2). It joins the parts that exist on their own:
 * the signed client, `verifyJob` against the keys pinned in the build, the job ledger, git path B, the agent engine inside the host
 * sandbox tier, the job handler and the claim loop. It opens no listening socket, starts no program itself (the entry point hands in
 * the engine kit, which holds the process start) and names no engine.
 *
 * Before the first claim, in this order, each failure stops the command with a non-zero exit and a fixed message:
 *  - this machine is registered and its key matches (as `status` checks);
 *  - the build pins job-signing keys for the registration's cloud address (`job_keyring_missing`);
 *  - the machine can sandbox a job and the agent CLI is found (looked up once, here: a job never consults the search path);
 *  - the mirrors directory overlaps none of the runner's own directories, also through a link (`mirrors_root_overlap`);
 *  - stale leftovers next to the ledger are removed, then the ledger is taken (another `run` holds it: exit non-zero);
 *  - the ledger is not closed by damage (`ledger_closed`): nothing that is not on the ledger runs, so no claim is made.
 * SIGINT or SIGTERM stops the job in hand (the sandbox stops its agent, 3 seconds of grace at most) and reports `runner_shutdown`.
 */
import path from "node:path";
import { CliError } from "../cliError.js";
import { loadRegistration, type Registration } from "../config.js";
import type { CommandContext } from "../context.js";
import { createRunnerClient } from "../daemon/client.js";
import type { EngineKit } from "../daemon/engineKit.js";
import { createGitPath } from "../daemon/gitPath.js";
import { createJobHandler } from "../daemon/jobHandler.js";
import { createEventRelay, realClock, type Clock } from "../daemon/lease.js";
import { createFileLedger, LedgerLockedError, type FileLedger } from "../daemon/ledger.js";
import { mirrorKeepClear, mirrorsRootFor, type RepoRef } from "../daemon/mirror.js";
import { abortOnSignals, pollLoop, type PollEvent } from "../daemon/pollLoop.js";
import { removeStaleLedgerTemp } from "../daemon/staleTemp.js";
import { cleanEnv, type CredentialMode } from "../job/cleanEnv.js";
import { createWorkspaceStore } from "../job/workspace.js";
import { loadRunnerKey } from "../keys.js";
import { keyringFor, type PinnedKeyrings } from "../keyring.js";
import { createHostSandbox } from "../sandbox/hostSandbox.js";
import { SandboxRefused } from "../sandbox/platform.js";
import { pathsOverlap } from "../sandbox/sandboxSettings.js";
import { commandOnPath, resolveSandboxTools, sandboxToolDirs, selectTier } from "../sandbox/select.js";

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
}

/** Replaceable by a test only: `runCli` never passes any, and nothing in the environment or on the command line can. */
export interface RunHooks {
  keyrings?: PinnedKeyrings;
  clock?: Clock;
  /** The search path for the agent CLI, bubblewrap and socat. Default: the PATH of the clean environment. */
  searchPath?: string;
  remoteUrl?: (repo: RepoRef) => string;
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

function credentialsOf(registration: Registration): CredentialMode {
  if (registration.credential_mode === "subscription") return { mode: "subscription" };
  // An API key comes from a local config file that no command writes yet. Until one does, such a runner is refused, never run on a guess.
  throw new CliError("api_key_not_configured: this runner is registered for api_key mode, and no local API key file is supported yet");
}

/** The sandbox tier, bubblewrap and socat (Linux), and the agent CLI, or the refusal that says which is missing. */
function localTools(host: RunHost, searchPath: string): { binaryPath: string; toolDirs: string[] } {
  try {
    selectTier({ platform: host.platform, hasCommand: (name) => commandOnPath(name, searchPath) });
    const toolDirs = sandboxToolDirs(resolveSandboxTools(searchPath, { platform: host.platform }));
    return { binaryPath: host.engine.locate(searchPath), toolDirs };
  } catch (error) {
    if (error instanceof SandboxRefused || (error instanceof Error && error.name === "EngineRefusal")) throw new CliError(`${error.message}; fx-runner cannot run jobs here`);
    throw error;
  }
}

function describePoll(event: PollEvent): string | undefined {
  if (event.event === "idle" || event.event === "rate_limited") return undefined;
  if (event.event === "error") return `cloud error ${event.status}${event.code === undefined ? "" : ` ${event.code}`}`;
  return event.event === "claimed" || event.event === "discarded" ? `${event.event} ${event.runId}` : event.event;
}

export async function runCommand(ctx: CommandContext, host: RunHost, hooks: RunHooks = {}): Promise<number> {
  const registration = loadRegistration(ctx.stateDir);
  if (!registration) throw new CliError("not registered; run: fx-runner register --code <code> --credential-mode <mode> --cloud-url <url>");
  const key = loadRunnerKey(ctx.stateDir);
  if (!key || key.jkt !== registration.jkt) throw new CliError("the runner key is missing or does not match the registration; run: fx-runner revoke --local, then register again");
  const keyring = keyringFor(registration.cloud_origin, hooks.keyrings);
  if (keyring === undefined) throw new CliError("job_keyring_missing: this build pins no job-signing keys for the cloud this runner is registered with, so it will claim nothing");
  const credentials = credentialsOf(registration);
  const home = host.home;
  if (home === undefined || !path.isAbsolute(home)) throw new CliError("cannot find your home directory");

  const { binaryPath, toolDirs } = localTools(host, hooks.searchPath ?? cleanEnv(credentials).PATH ?? "");
  const envOptions = { extraPathDirs: toolDirs };

  // The runner's own directories. The state directory is private; the workspaces, temp directories and mirrors sit beside each other in the cache directory.
  const stateDir = ctx.stateDir;
  const mirrorsRoot = mirrorsRootFor({ home, platform: host.platform, xdgCacheHome: host.xdgCacheHome });
  const cacheDir = path.dirname(mirrorsRoot);
  const workspaceRoot = path.join(cacheDir, "workspaces");
  const tempRoot = path.join(cacheDir, "tmp");
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
    const stopped = new AbortController();
    const client = createRunnerClient({ origin: registration.cloud_origin, key, now: ctx.now, fetchFn: ctx.fetchFn });
    const git = createGitPath({ capture: host.engine.capture, envOptions, mirrorsRoot, stateDir, keepClear, ...(hooks.remoteUrl === undefined ? {} : { remoteUrl: hooks.remoteUrl }) });
    const sandbox = createHostSandbox({
      credentials,
      envOptions,
      home,
      tempRoot,
      workspaceRoot,
      stateDir,
      binaryDir: path.dirname(binaryPath),
      mirrorsRoot,
      makeRuntime: (sandboxSettings, protectedPaths) => host.engine.makeRuntime({ binaryPath, credentials, envOptions, sandboxSettings, protectedPaths, stateDir, onLocalEvent: relay.emit }),
    });
    const handle = createJobHandler({
      client,
      keyring,
      clock,
      ledger,
      git,
      sandbox,
      events: relay,
      shutdown: stopped.signal,
      run: { workspaces: createWorkspaceStore(workspaceRoot), credentials, envOptions, planSession: (continues) => host.engine.planSession(stateDir, continues), defaultModel: DEFAULT_MODEL },
      recordSession: (sessionId, workspace) => host.engine.recordSession(stateDir, sessionId, workspace),
    });

    const detach = abortOnSignals(stopped, host.signals);
    try {
      ctx.out(`fx-runner: running as runner ${registration.runner_id}; stop with Ctrl-C`);
      const end = await pollLoop({
        client,
        clock,
        signal: stopped.signal,
        onClaimed: handle,
        log: (event) => {
          const line = describePoll(event);
          if (line !== undefined) ctx.out(`fx-runner: ${line}`);
        },
      });
      if (end === "unauthorized") throw new CliError("the cloud no longer accepts this runner's key; run: fx-runner revoke --local, then register again");
      return 0;
    } finally {
      detach();
    }
  } finally {
    ledger.close();
  }
}
