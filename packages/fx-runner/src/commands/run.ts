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
import { BYPASS_ENV_NAME, requireUsable } from "../protectionBypass.js";
import { loadRegistration, type Registration } from "../config.js";
import type { CommandContext } from "../context.js";
import { ApiKeyError, perJobApiKey, readApiKey } from "../credentials.js";
import { createAdmission } from "../daemon/admission.js";
import { createUsageGate } from "../daemon/usageGate.js";
import { createFootprintStore } from "../daemon/footprints.js";
import { machineMemoryBytes, realResourceProbe, type ResourceProbe } from "../daemon/resources.js";
import { CANARY_BLOCK_HINT, claimBlockReason, ensureInstructionCanary } from "../instructionCanaryState.js";
import { isDraining, isPaused, loadSettings, setDraining } from "../runnerSettings.js";
import { completeCaps, engineLineOf, engineMismatchClaimBlock, limitsClaimBlock, type ClaimBlock, type SandboxEngine, type VmHostFacts } from "../vm/limits.js";
import { createLiveMicrovm, type LiveMicrovm, type LiveMicrovmParts } from "../vm/sandboxd/live.js";
import { createVmClaimGuard, createVmJobDeps, runEventHooks, type VmRunBlock } from "../daemon/vmJobDeps.js";
import { daemonInventorySource, daemonSandboxLifecycle } from "../vm/sandboxd/management.js";
import { createMicrovmGate } from "../daemon/microvmGate.js";
import { budgetsOf, capUnenforced, setUpJobLimits, UNENFORCED_LINE, type Budgets, type JobLimits } from "../sandbox/jobLimits.js";
import { createJobsInHand } from "../daemon/jobsInHand.js";
import { readVerifyAnswer } from "../daemon/answerFile.js";
import { createVerifyLocal } from "../daemon/verifyLocal.js";
import { readSignInState } from "../daemon/signInState.js";
import { readHostFacts } from "../hostFacts.js";
import { chooseEngine, reasonChangeLine, RESTART_LINE, selectSandbox, UNWIRED_LINE } from "../vm/engineGate.js";
import { RUNNER_BUILD_CAPABILITIES, RUNNER_PROTOCOL_VERSION, RUNNER_VERSION } from "../version.js";
import { createSandboxCommandReceiver } from "../daemon/sandboxCommands.js";
import { createInventoryReporter } from "../daemon/sandboxInventory.js";
import { createBridgeApply, type EngineBridgeCommandOptions } from "./engineBridge.js";
import { createHostLoadReporter } from "../daemon/hostLoad.js";
import { startEngineBridge, type EngineBridge, type EngineBridgePorts } from "../engineBridge/daemon.js";
import { createEventsUploader } from "../engineBridge/upload.js";
import { createRunnerClient } from "../daemon/client.js";
import { createSandboxGate } from "../daemon/sandboxGate.js";
import type { EngineKit } from "../daemon/engineKit.js";
import { createGitPath } from "../daemon/gitPath.js";
import { createGitPathA } from "../daemon/gitPathA.js";
import { createSandboxedPurge } from "../daemon/resumePurgeSandbox.js";
import { createJobHandler } from "../daemon/jobHandler.js";
import { createMemoryOffer, type MemoryOfferDeps } from "../memoryOffer.js";
import { computeConflictAttestation } from "../daemon/conflictAttest.js";
import { createPlaneBaseLedger, createPlanePushHook, type PlaneBaseLedger } from "../daemon/planePush.js";
import { createPlanePushGithub } from "../daemon/planePushGithub.js";
import { createPlaneMergeHandler } from "../daemon/planeMerge.js";
import { CONFLICT_FACTS_CAPABILITY, ENGINE_BRIDGE_CAPABILITY, KVM_FACT_HELLO_CAPABILITY, MEMORY_LIMIT_CAPABILITY, ORDERED_FACTS_CAPABILITY, OVERLAP_FACTS_CAPABILITY, PROJECT_SETUP_CAPABILITY, SANDBOX_COMMAND_CAPABILITY, TIP_PUBLISH_CAPABILITY, MEM_PROPOSAL_CAPABILITY, type LimitedBy } from "@fulcrumaxe/runner-protocol";
import { createGitTransport, createPublicHeadsReader } from "@fulcrumaxe/runner-protocol/planePush";
import { createNixShell, findNix, findTool, identityVia } from "../daemon/nixShell.js";
import { createDepsInstaller } from "../daemon/depsInstall.js";
import { createLockfileSync, type LockfileSync } from "../daemon/lockfileSync.js";
import { createBaseFile, createChangedFiles, createCheckStep, createImportScope,createHeadBlob, createIndexHidesChanges, createTrackedFiles, createVcsState } from "../daemon/checkStep.js";
import { createJobWatch } from "../daemon/watch.js";
import { createEventRelay, realClock, type Clock } from "../daemon/lease.js";
import { createAutoUpdate, type UpdateHost } from "../update/updater.js";
import { createUpdater, type UpdateHooks } from "./update.js";
import { createFileLedger, LedgerLockedError, type FileLedger, type LedgerOptions } from "../daemon/ledger.js";
import { createPushLog, PUSH_LOG_FILE, type PushLog } from "../daemon/pushLog.js";
import { cacheRootsFor, mirrorKeepClear, type RepoRef } from "../daemon/mirror.js";
import { LaunchRefused, prepareDaemonDir } from "../launchDir.js";
import { abortOnSignals, pollLoop, type PollEvent } from "../daemon/pollLoop.js";
import { WakeTracker } from "../daemon/wake.js";
import { removeStaleLedgerTemp } from "../daemon/staleTemp.js";
import { spillRootFor, sweepStaleSpill } from "../job/spillFiles.js";
import { cleanEnv, type CleanEnvOptions, type CredentialMode } from "../job/cleanEnv.js";
import { createWorkspaceStore } from "../job/workspace.js";
import { loadRunnerKey } from "../keys.js";
import { gitProxyHashFor, keyringFor, type PinnedGitProxies, type PinnedKeyrings } from "../keyring.js";
import { createHostSandbox } from "../sandbox/hostSandbox.js";
import { SandboxRefused, wslFacts } from "../sandbox/platform.js";
import { clearWsl } from "../sandbox/wslGate.js";
import { refusalNotice } from "../platformSupport.js";
import { probeMachine, type SandboxHost } from "../sandbox/probe.js";
import { pathsOverlap } from "../sandbox/sandboxSettings.js";
import { commandOnPath, resolveSandboxTools, sandboxToolDirs, selectTier } from "../sandbox/select.js";
import { describeToolchain, resolveToolchain, toolchainPathDirs, toolchainReadPaths } from "../sandbox/toolchain.js";
import { socketPath } from "../watch/layout.js";
import { MAX_SOCKET_PATH_BYTES, findTmux, tmuxEnv } from "../watch/tmux.js";

export const LEDGER_FILE = "jobs.ledger";
const DEFAULT_MODEL = "sonnet";
/** The most one reading of the CLI's sign-in may take, whatever its probes do (FU-174). */
const MODEL_AUTH_LIMIT_MS = 12_000;

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
  /**
   * Changes this process's working directory (D#6 RUNNER-CWD-1). `run` calls it once, before it starts anything, with its own empty directory under
   * the launch root, so nothing it starts inherits the directory it was started in (a service's is the home directory, a person's may be a checkout).
   */
  chdir: (dir: string) => void;
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
  /** D#601 MEM-6: one line from the terminal within `timeoutMs`, or undefined (timeout, closed input). Only a memory-proposal offer uses it; absent means those proposals are never asked about. */
  askTimed?: ((question: string, timeoutMs: number, signal?: AbortSignal) => Promise<string | undefined>) | undefined;
  /** `XDG_RUNTIME_DIR`, looked up by name by the caller: where the user's systemd manager listens (per-job limits, D#6 C43-5). */
  xdgRuntimeDir?: string | undefined;
  /** D#749 V2b: the user name the machine's Chrome bridge directory is named for, and the daemon's environment, of which a deploy command gets a short allowlist (deployOrder.ts). Absent: no browser job and no deploy order is served. */
  username?: string | undefined;
  env?: Readonly<Record<string, string | undefined>> | undefined;
  /** D#842 EB-3c: the engine bridge's halt path and ceiling keeper, bound by the entry point (`engineBridge/ports.ts`). Absent: the bridge never starts. */
  engineBridge?: EngineBridgePorts | undefined;
  /** D#587 B-5a part 3: what the machine says about KVM, the helper's socket and what the helper answered, read by the entry point. Absent: a runner set to `microvm` has no facts, which closes its gate (no KVM). */
  vmFacts?: (() => Promise<VmHostFacts | undefined>) | undefined;
  /** D#587 B-5b-3a: the parts of the live microVM stack this build has, read by the entry point (the uid, the helper's socket). `createLiveMicrovm` wires them only when every part is there; absent or incomplete, a runner set to `microvm` claims nothing (`microvm_build_unwired`) and never runs a job in the OS sandbox instead. */
  microvm?: LiveMicrovmParts | undefined;
  /** D#845 ON-BR-2: what the machine gives the runner's own Connect handling (home, the engine's state directory variable, discovery roots). Absent: `bridge_enable` and `bridge_disable` are not pulled. */
  engineBridgeOptions?: EngineBridgeCommandOptions | undefined;
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
  /** Whether per-job limits are enforced, and the limits to start jobs under (default: tried on the real machine through the engine's process start). */
  jobLimits?: { enforced: boolean; limits?: JobLimits; reason?: string };
  /** A test seam: handed the live microVM stack exactly as the command composed it (only when every part was there), so a test can start a VM through its port. */
  onMicrovmBuilt?: (live: LiveMicrovm) => void;
  /** A test seam: told, once the hello is answered, whether the conflict verdict may be sent on a merge report. */
  onConflictFactsAccepted?: (accepted: boolean) => void;
  /** A test seam: told, once the hello is answered, whether the ordering fact may be computed and sent on a merge order. */
  onOrderedFactsAccepted?: (accepted: boolean) => void;
  /** A test seam: told, once the hello is answered, whether the overlap verdict may be sent on a verify message. */
  onOverlapFactsAccepted?: (accepted: boolean) => void;
  /** A test seam: told, once the hello is answered, whether a fix round that added no commit may ask to publish the branch tip. */
  onTipPublishAccepted?: (accepted: boolean) => void;
  /** A test seam: told, once the hello is answered, whether a finished run's memory proposals may be offered to the person. */
  onMemProposalAccepted?: (accepted: boolean) => void;
  /** A test seam: handed the memory-offer dependencies exactly as the command built them, so a test can call the wired `enabled`. */
  onMemoryOfferBuilt?: (deps: MemoryOfferDeps) => void;
  /** A test seam: handed the plane-push hook exactly as the command built it, so a test can drive the real construction (the `tipPublish` it was given included). */
  onPlanePushBuilt?: (planePush: { baseLedger: PlaneBaseLedger; run: ReturnType<typeof createPlanePushHook> }) => void;
}

/** Whether a process with this pid exists: ESRCH means gone; success and EPERM (another user's process) mean it is there. */
/** The push log under the state directory, with one line at start when it is damaged and closed (the way back: remove the moved-aside file). */
export function openPushLog(stateDir: string, options: LedgerOptions, out: (line: string) => void): PushLog {
  const file = path.join(stateDir, PUSH_LOG_FILE);
  removeStaleLedgerTemp(file, options.now?.() ?? new Date());
  const log = createPushLog(file, options);
  if (log.closed) out(`fx-runner: the push log is damaged and closed (see ${PUSH_LOG_FILE}.damaged-* in the state directory); it reopens empty once that file is removed`);
  return log;
}

/** D#587 B-6a: why the configured engine and limits forbid claiming right now, read again at every claim. Undefined in `os_sandbox` mode, whatever the limits say. */
export function vmLimitsBlock(stateDir: string): ClaimBlock | undefined {
  const settings = loadSettings(stateDir);
  // A settings file that is there and cannot be read is never taken as `os_sandbox` (nor as an old `microvm`): the claim stops, as for an invalid engine value.
  if (settings.unreadable === true) return "engine_setting_invalid";
  return limitsClaimBlock(settings.sandboxEngine ?? "os_sandbox", settings.microvm);
}

/**
 * D#587 B-5b-3a: every reason this runner may not claim for its engine setting, read again at every claim. `vmLimitsBlock`'s (an unreadable settings file included), then, for a live
 * setting of `microvm` while this run's engine (`engine`, chosen once at start) is not `microvm`, `microvm_build_unwired` (`wired` false) or `microvm_restart_needed`. Local only: it pauses the claim
 * like `engine_setting_invalid` does and sends no reason to the cloud.
 */
export function vmClaimBlock(stateDir: string, engine: SandboxEngine, wired: boolean): ClaimBlock | undefined {
  return vmLimitsBlock(stateDir) ?? engineMismatchClaimBlock(loadSettings(stateDir).sandboxEngine ?? "os_sandbox", engine, wired);
}

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
    return sandboxToolDirs(resolveSandboxTools(searchPath, { platform: host.platform, ...wslFacts(host.sandbox.wsl) }));
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
      selectTier({ platform: host.platform, osrelease: host.osrelease, ...wslFacts(host.sandbox.wsl), hasCommand: (name) => commandOnPath(name, searchPath) });
    } catch (error) {
      if (!(error instanceof SandboxRefused && (error.code === "bubblewrap_missing" || error.code === "socat_missing"))) throw error;
    }
    return { binaryPath: host.engine.locate(searchPath), toolDirs: sandboxDirs(host, searchPath) };
  } catch (error) {
    if (error instanceof SandboxRefused || (error instanceof Error && error.name === "EngineRefusal")) throw new CliError(`${error.message}; fx-runner cannot run jobs here`);
    throw error;
  }
}

/** The agent CLI's path when it can be found; the WSL2 checks only use it to name the directory they keep clear. */
function locateOrUndefined(host: RunHost, searchPath: string): string | undefined {
  try {
    return host.engine.locate(searchPath);
  } catch (error) {
    // fx-swallow-ok: a missing CLI is refused by localTools right after, with its own message
    if (error instanceof Error && error.name === "EngineRefusal") return undefined;
    throw error;
  }
}

const HELD_WORDS: Readonly<Record<LimitedBy, string>> = {
  memory: "memory is short",
  cpu: "the CPU is busy",
  disk: "disk space is low",
  paused: "claiming is paused",
  usage_limit: "the plan's usage limit is reached",
  ceiling: "at the job limit",
};

/** The one journal line for a change in what the machine holds back: which classes, and why. Nothing held back says so too. */
export function describeHeld(light: LimitedBy | null, heavy: LimitedBy | null, near = false, cpu?: { low: boolean; ioHigh: boolean }): string {
  // Measured CPU use is low yet the CPU holds: the cores are kept back (the person's reserve, jobs still starting), so "the CPU is busy" would be wrong. Disk busyness is only mentioned, never a reason.
  const cpuWords = cpu === undefined || !cpu.low ? HELD_WORDS.cpu : `cores are kept free for you or for jobs still starting${cpu.ioHigh ? " (disk is busy, informational)" : ""}`;
  const words = (by: LimitedBy): string => (by === "usage_limit" && near ? "near the plan's usage limit, so one job at a time (the limit itself is not reached)" : by === "cpu" ? cpuWords : HELD_WORDS[by]);
  if (light === null && heavy === null) return "taking all kinds of jobs again";
  if (light !== null && heavy !== null && light === heavy) return `holding back all new jobs: ${words(light)}`;
  if (light !== null && heavy !== null) return `holding back all new jobs: ${words(light)} (heavy jobs: ${words(heavy)})`;
  return light === null ? `holding back heavy jobs (reviews and builds): ${words(heavy!)}; light jobs are still taken` : `holding back light jobs: ${words(light)}`;
}

function describePoll(event: PollEvent): string | undefined {
  if (event.event === "held") return describeHeld(event.light, event.heavy, event.near === true, event.cpu);
  if (event.event === "idle" || event.event === "rate_limited") return undefined;
  if (event.event === "sandbox_unavailable") return undefined;
  if (event.event === "error") return `cloud error ${event.status}${event.code === undefined ? "" : ` ${event.code}`}`;
  if (event.event === "refused") return `refused ${event.runId} (${event.reason})`;
  // A wake check that says "claim" is routine; only the fallback is worth a line.
  if (event.event === "wake_claim") return undefined;
  if (event.event === "wake_fallback") return "the cloud's wake check failed 3 times; checking for work every minute until it answers again";
  return event.event === "claimed" || event.event === "discarded" ? `${event.event} ${event.runId}` : event.event;
}

/** The exit code that asks a service manager to start the program again, on the version the stable link now names (`EX_TEMPFAIL`). */
/**
 * D#6 BUILD-LOCKFILE-ON-DEP-ADD: the job handler's `lockfileSync` entry, wired only where the engine offers the process-group capture and the large capture (for the guarded git
 * listing); `{}` otherwise, so a machine without them runs jobs as before.
 */
export function lockfileSyncFor(engine: Pick<EngineKit, "installCapture" | "captureLarge">, envOptions: CleanEnvOptions, say: (line: string) => void, scratchRoot: string): { lockfileSync?: LockfileSync } {
  if (engine.installCapture === undefined || engine.captureLarge === undefined) return {};
  return { lockfileSync: createLockfileSync({ capture: engine.installCapture, envOptions, say, scratchRoot, changedFiles: createChangedFiles(engine.captureLarge, envOptions) }) };
}

export const EXIT_RESTART_FOR_UPDATE = 75;

export async function runCommand(ctx: CommandContext, host: RunHost, hooks: RunHooks = {}, updateHost?: UpdateHost): Promise<number> {
  const registration = loadRegistration(ctx.stateDir);
  if (!registration) throw new CliError("not registered; run: fx-runner register --code-stdin --credential-mode <mode> --cloud-url <url>");
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
  // D#6 RUNNER-CWD-1: into the daemon's own empty directory before anything is started. One that cannot be made stops the command: fail closed.
  try {
    host.chdir(prepareDaemonDir({ root: cacheRootsFor({ home, platform: host.platform, xdgCacheHome: host.xdgCacheHome }).launchRoot, home, uid: host.uid }));
  } catch (error) {
    if (!(error instanceof LaunchRefused)) throw error;
    throw new CliError("the runner's own working directory under its cache directory could not be made, so nothing is started");
  }

  const searchPath = hooks.searchPath ?? cleanEnv(credentials).PATH ?? "";
  // D#587 B-9b: on WSL2 every check and live probe runs now, before any claim; a probe that cannot run is a refusal. A no-op anywhere else.
  // Failures are said one per line; the refusal itself is the one `localTools` gives next, because the machine is then not cleared.
  const wsl = await clearWsl({ platform: host.platform, osrelease: host.osrelease, home, stateDir: ctx.stateDir, binaryPath: locateOrUndefined(host, searchPath), xdgCacheHome: host.xdgCacheHome, searchPath, host: host.sandbox });
  for (const item of wsl.items) if (!item.ok) ctx.out(`fx-runner: WSL2 ${item.code}: ${item.detail}`);
  // An explicit refusal, not left to `detectPlatform` alone: a WSL2 machine that is not cleared starts nothing.
  if (wsl.wsl2 && !wsl.cleared) throw new CliError(`wsl2_unsupported: ${refusalNotice("wsl2")}; fx-runner cannot run jobs here`);
  const { binaryPath, toolDirs } = localTools(host, searchPath);
  // The minimum toolchain for a project's own tests (D#6 R4d-3): found once here, its directories at the end of the agent's PATH, and the
  // install prefixes under the home directory as read-only grants. A tool that is not found is skipped; one that may not be granted is left out.
  const { mirrorsRoot, workspaceRoot, tempRoot, spillRoot } = cacheRootsFor({ home, platform: host.platform, xdgCacheHome: host.xdgCacheHome });
  const toolchain = resolveToolchain(searchPath, { home, stateDir: ctx.stateDir, binaryDir: path.dirname(binaryPath), jobAreas: [mirrorsRoot, workspaceRoot, tempRoot, spillRoot] });
  const toolchainDirs = toolchainPathDirs(toolchain);
  toolDirs.push(...toolchainDirs.filter((dir) => !toolDirs.includes(dir)));
  const envOptions = { extraPathDirs: toolDirs };

  // The runner's own directories. The state directory is private; the workspaces, temp directories and mirrors sit beside each other in the cache directory.
  const stateDir = ctx.stateDir;
  const keepClear = mirrorKeepClear({ home, stateDir, binaryDir: path.dirname(binaryPath), workspaceRoot, tempRoot, spillRoot });
  if (keepClear.some((other) => pathsOverlap(mirrorsRoot, other))) throw new CliError("mirrors_root_overlap: the repo mirrors directory overlaps the runner's state, binary, workspace or temp directory");

  // Per-job hard limits (D#6 C43-5): tried once here. Without them the runner holds back (2 jobs, 1 heavy) and says so.
  const footprints = createFootprintStore(stateDir);
  const budgets = (): Budgets => budgetsOf(loadSettings(stateDir), footprints.classEstimate("heavy").memBytes, hooks.probe?.read().totalMemBytes ?? machineMemoryBytes());
  const { enforced, limits, reason } = hooks.jobLimits ?? (await setUpJobLimits({ platform: host.platform, uid: host.uid, runtimeDir: host.xdgRuntimeDir, searchPath, capture: host.engine.capture, isDir: host.sandbox.isDir, readText: host.sandbox.readText }, budgets));
  if (!enforced) ctx.out(`fx-runner: ${UNENFORCED_LINE}${reason === undefined ? "" : ` (${reason})`}`);

  const ledgerFile = path.join(stateDir, LEDGER_FILE);
  removeStaleLedgerTemp(ledgerFile, ctx.now());
  let ledger: FileLedger;
  try {
    ledger = createFileLedger(ledgerFile, { pid: host.pid, isAlive: (pid) => pidIsAlive(host.kill, pid), now: ctx.now });
    // This daemon holds the ledger lock, so a drain marker left over from a drain that nobody was running for is not for it.
    setDraining(stateDir, false);
  } catch (error) {
    if (error instanceof LedgerLockedError) throw new CliError("another fx-runner run is using this state directory");
    throw error;
  }
  // D#600 CX-4b: spill directories a crash or kill left behind hold cut prompt text and have no run to end them. They are swept only now that this daemon holds the ledger lock (a second
  // start on the same state directory exits above and touches nothing), and only in this state directory's own spill root, so another daemon's live runs are never reached.
  const ownSpillRoot = spillRootFor(spillRoot, stateDir);
  sweepStaleSpill(ownSpillRoot);
  let pushLog: PushLog | undefined;
  try {
    // Closed (damaged or quarantined): nothing that is not on the ledger runs, so no claim is made. One message, one exit, no polling.
    if (ledger.closed) throw new CliError("ledger_closed: the job ledger is damaged and was moved aside (see jobs.ledger.damaged-* in the state directory), so no job can be claimed");

    // The runner's push log (D#519 MQ4-RUNNER-PUSH-LOG): kept in the state directory, which no job can reach. A damaged one is closed, not fatal: pushes still run and nothing is recorded.
    pushLog = openPushLog(stateDir, { pid: host.pid, isAlive: (pid) => pidIsAlive(host.kill, pid), now: ctx.now }, ctx.out);
    const clock = hooks.clock ?? realClock;
    const relay = createEventRelay();
    // Claim gating on the plan's usage limit (D#6 C43-6): reads every job's metadata events, so one job's limit holds back the claims of all. A runner on an API key has no plan window.
    const usage = createUsageGate({ credentialMode: registration.credential_mode === "subscription" ? "subscription" : "api_key", now: () => clock.now().getTime() });
    const stopped = new AbortController();
    let memoryLimitAccepted = false;
    /** D#519 MQ4-e2-a: set once the hello is answered; a merge report carries a conflict verdict only when the cloud kept `conflict_facts_v1`. */
    let conflictFactsAccepted = false;
    /** D#483 S5-j2c2: set once the hello is answered; a merge order's verify carries an ordering fact only when the cloud kept `ordered_facts_v1`. */
    let orderedFactsAccepted = false;
    /** D#483 S5-j2e-RUNNER: set once the hello is answered; a verify that names an overlap carries the overlap verdict only when the cloud kept `overlap_facts_v1`. */
    let overlapFactsAccepted = false;
    /** D#598 P1g-3a-3: set once the hello is answered; a fix round that added no commit asks to publish the branch tip only when the cloud kept `tip_publish_v1`. */
    let tipPublishAccepted = false;
    /** What the plane-push hook reads before it asks for the branch tip. The test seam below reads this same function, so a hook given anything else is caught. */
    const tipPublish = (): boolean => tipPublishAccepted;
    /** D#601 MEM-6: set once the hello is answered; a finished run's memory proposals are offered at a terminal only when the cloud kept `mem_proposal_v1`. */
    let memProposalAccepted = false;
    /** D#842 EB-3c: set once the hello is answered; the engine bridge starts only when the cloud kept `engine_bridge_v1`. */
    let engineBridgeAccepted = false;
    // D#845 watch mode: true once a hello reply listed the `watch_mode` capability (not a protocol number: clouds at 23 and 24 exist that cannot take the slim status).
    let cloudWatchMode = false;
    // D#845 ON-6c: true once a hello reply listed the `kvm_fact` capability; only then does a hello carry `facts.kvm`.
    let cloudKvmFact = false;
    // D#749 VERIFY-SIGNIN-EXPIRY: each ordinary claim says whether the saved verify sign-in is still good (dates only; nothing of the sign-in itself is read). Nothing is said while no verify address is set here.
    // D#587 B-7a: a runner that boots VMs reports its sandboxes (an empty list until the VM helper provides a source); one that does not says nothing, so its claim body is unchanged.
    // D#587 B-5b-3a: the one engine this run reports, gates jobs by and runs them in, decided once here from the machine's engine line and whether this build composed a live microVM stack.
    const built = createLiveMicrovm(host.microvm, stateDir);
    if (built !== undefined) hooks.onMicrovmBuilt?.(built);
    const settingsAtStart = loadSettings(stateDir);
    const engineFacts = await host.vmFacts?.().catch(() => undefined); // fx-swallow-ok: facts that cannot be read are "unreadable" in the engine line, which is not microvm
    const engine = chooseEngine(engineLineOf({ platform: host.platform, engine: settingsAtStart.unreadable === true ? "invalid" : (settingsAtStart.sandboxEngine ?? "os_sandbox"), caps: settingsAtStart.microvm, facts: engineFacts }), built !== undefined);
    /** The live stack only when this run's engine is `microvm`: an `os_sandbox` runner reports no inventory and takes no signed VM command. */
    const vm = engine === "microvm" ? built : undefined;
    const client = createRunnerClient({ origin: registration.cloud_origin, key, now: ctx.now, fetchFn: ctx.fetchFn, bypass: requireUsable(ctx.bypass), protocolVersion: RUNNER_PROTOCOL_VERSION, sandboxCommands: createSandboxCommandReceiver({ keyring, runnerId: registration.runner_id, now: ctx.now, log: (line) => ctx.out(line), statePath: path.join(ctx.stateDir, "sandbox-commands-state.json"), uid: ctx.uid, ...(vm === undefined ? {} : { lifecycle: daemonSandboxLifecycle(vm.sdk) }) }), ...(vm !== undefined && readHostFacts(engine)?.sandbox_engine === "microvm" ? { sandboxInventory: createInventoryReporter({ source: daemonInventorySource(vm.sdk), now: ctx.now }) } : {}),
      // D#845 ON-1b: the machine's load rides the claim, but only for a build that advertises `project_setup_v1` (none does yet, so today the claim body is unchanged). No setup runs here yet: the count is 0.
      ...((RUNNER_BUILD_CAPABILITIES as readonly string[]).includes(PROJECT_SETUP_CAPABILITY) ? { hostLoad: createHostLoadReporter({ probe: hooks.probe ?? realResourceProbe({ platform: host.platform, diskPaths: [workspaceRoot, path.dirname(mirrorsRoot)], vmStatText: () => vmStat }), setupsRunning: () => 0, now: ctx.now }) } : {}), verifySignIn: () => readSignInState({ settings: () => loadSettings(stateDir).verify, home, now: () => ctx.now().getTime() }) });
    // macOS: a resumed workspace's ignored build output is purged in a child under sandbox-exec that can write below the workspace only (D#6 RESUME-CLEAN-MAC).
    const sandboxedPurge = host.platform === "darwin" && host.selfCommand !== undefined ? createSandboxedPurge({ capture: host.engine.capture, selfCommand: host.selfCommand, stateDir, isFile: host.sandbox.isFile }) : undefined;
    const git = createGitPath({ platform: host.platform, pushLog, ...(sandboxedPurge === undefined ? {} : { sandboxedPurge }), capture: host.engine.capture, ...(host.engine.captureLarge === undefined ? {} : { captureLarge: host.engine.captureLarge }), envOptions, mirrorsRoot, stateDir, keepClear, signal: stopped.signal, log: (line) => ctx.out(line), ...(hooks.remoteUrl === undefined ? {} : { remoteUrl: hooks.remoteUrl }) });
    // Path A (cloud-verified jobs) exists only where this build pins a GitHub proxy for the cloud; a verified job elsewhere ends `git_proxy_unpinned`.
    const gitA = gitProxyHashFor(registration.cloud_origin, hooks.gitProxies) === undefined ? undefined : createGitPathA({ pushLog, capture: host.engine.capture, ...(host.engine.captureLarge === undefined ? {} : { captureLarge: host.engine.captureLarge }), envOptions, mirrorsRoot, stateDir, keepClear, signal: stopped.signal, log: (line) => ctx.out(line), cloudOrigin: registration.cloud_origin, platform: host.platform, ...(sandboxedPurge === undefined ? {} : { sandboxedPurge }), mintTicket: (runId, generation) => client.gitTicket(runId, generation), ...(hooks.gitProxies === undefined ? {} : { pinned: hooks.gitProxies }) });
    const packageStoreRoot = path.join(path.dirname(mirrorsRoot), "pnpm-store");
    // D#587 B-5b: `selectSandbox` is the only place a port is picked; `microvm` without a live port is an error, never the OS sandbox.
    const sandbox = selectSandbox(engine, { ...(built === undefined ? {} : { microvm: built.port }), os_sandbox: createHostSandbox({
      credentials,
      platform: host.platform,
      wsl: host.sandbox.wsl,
      envOptions,
      home,
      tempRoot,
      workspaceRoot,
      stateDir,
      binaryDir: path.dirname(binaryPath),
      mirrorsRoot,
      // D#600 CX-4b: the root a run's spill directory sits under: denied whole, with the run's own directory the one read grant under it.
      spillRoot,
      toolchainReadPaths: toolchainReadPaths(toolchain),
      packageStoreRoot,
      makeRuntime: (sandboxSettings, protectedPaths, jobEnv, runId) => host.engine.makeRuntime({ binaryPath, credentials, envOptions, sandboxSettings, protectedPaths, stateDir, onLocalEvent: (event) => (usage.observe(event), relay.emit(runId, event)), onNearLimit: (info) => usage.warn(info), ...(jobEnv === undefined ? {} : { jobEnv }), ...(limits === undefined ? {} : { limits }), verifyServer: () => verifyLocal.verifyServer() }),
    }) });
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
    // D#6 C44-4: the host-side dependency install, wired only where the engine offers the process-group capture.
    const depsInstall = host.engine.installCapture === undefined ? undefined : createDepsInstaller({ capture: host.engine.installCapture, envOptions, say: (line) => ctx.out(line) });
    // D#598 P1f-3: the run-end hook for a repository paired with a public repository. It enters only for a fresh executor run the cloud says is paired.
    const planeBase = createPlaneBaseLedger();
    const planePush = {
      baseLedger: planeBase,
      run: createPlanePushHook({ client, github: createPlanePushGithub(), transport: createGitTransport(), baseLedger: planeBase, workRoot: path.join(stateDir, "plane-push"), uid: host.uid, tipPublish, say: (line) => ctx.out(line) }),
    };
    hooks.onPlanePushBuilt?.(planePush);
    // D#6 PUBLIC-MERGE PR3: a paired item's public pull request is merged here, with the cloud-minted single-use credential; the order is claimed only after a claim reply says one waits.
    const planeMerge = createPlaneMergeHandler({
      client,
      github: createPlanePushGithub(),
      reader: createPublicHeadsReader(),
      syncMirror: async (repo) => {
        if (git.syncMirror === undefined) throw new Error("no mirror");
        return git.syncMirror(repo);
      },
      workRoot: path.join(stateDir, "plane-merge"),
      sendConflictFacts: () => conflictFactsAccepted,
      sendOrderedFacts: () => orderedFactsAccepted,
      sendOverlapFacts: () => overlapFactsAccepted,
      ...(pushLog === undefined ? {} : { pushLog }),
      uid: host.uid,
      say: (line) => ctx.out(line),
    });
    // D#601 MEM-6: a service has no terminal, so it never asks and never sends; a person who started `run` on a terminal is asked once per proposal, after the run ended. Ctrl-C ends an open question as no.
    // An unattended question holds its run's handler up to the question's time limit (120 seconds) before the proposal is kept as no.
    const memoryOfferDeps: MemoryOfferDeps = { stateDir, enabled: () => memProposalAccepted, interactive: host.interactive === true, ask: host.askTimed, signal: stopped.signal, say: (line) => ctx.out(line), send: (message) => client.memoryProposals(message) };
    hooks.onMemoryOfferBuilt?.(memoryOfferDeps);
    // D#749 V2b: the local half of the post-merge verify stage. Off until the owner sets `verify.*` on this machine; what it advertises is decided by those settings and the probe.
    const verifyLocal = createVerifyLocal({ stateDir, uid: host.uid ?? -1, username: host.username ?? "", env: host.env ?? {}, platform: host.platform, capture: host.engine.installCapture, signal: stopped.signal, say: (line) => ctx.out(line), home, selfCommand: host.selfCommand, ...(ctx.bypass?.kind === "ok" && ctx.bypassFile !== undefined ? { bypass: { file: ctx.bypassFile, cloudOrigin: registration.cloud_origin } } : {}) });
    // D#587 3c-iii: a microVM run's guest events go to the run's own usage gate and relay, exactly as the OS-sandbox path's do (below, `makeRuntime`). Attached before any VM can be made.
    built?.runHooks.attach(runEventHooks({ usage, relay }));
    // D#587 B-5b-3c-iii: a microVM run's crossing, archive, bundle apply, fresh check and lifecycle, joined over the one live stack. An `os_sandbox` run has none of it.
    const vmDeps = vm === undefined ? undefined : createVmJobDeps({ live: vm, stateDir, capture: host.engine.capture, captureLarge: host.engine.captureLarge, envOptions, now: ctx.now, caps: () => completeCaps(loadSettings(stateDir).microvm), readMemAvailableBytes: engineFacts?.readMemAvailableBytes ?? (() => undefined), subscription: registration.credential_mode === "subscription" });
    // the claim loop's own part: no claim on an API key, while startup reaping is held, or at the VM cap (the lifecycle's own registry)
    const vmGuard = vm === undefined || vmDeps === undefined ? undefined : createVmClaimGuard({ live: vm, vm: vmDeps, subscription: registration.credential_mode === "subscription" });
    const handle = createJobHandler({
      engine,
      browserReady: (method) => verifyLocal.browserReady(method),
      verifyAnswer: (runId) => readVerifyAnswer(path.join(ctx.stateDir, "jobs"), runId, host.uid),
      memoryOffer: createMemoryOffer(memoryOfferDeps),
      // D#519 MQ4-e2-c1: a conflict round's attestation; the handler is handed the function and never the log it reads.
      conflictAttest: (input) => computeConflictAttestation({ ...input, scratchRoot: path.join(ctx.stateDir, "conflict-attest"), pushLog }),
      planePush,
      // D#6 CARD-OOM-CAUSE-WORDS: the scope's own cap goes on a `resource_limit` end, to a cloud whose hello kept `memory_limit_v1` (set below, once the hello is answered).
      ...(limits?.memoryCap === undefined ? {} : { memoryLimitBytes: (runId: string) => limits.memoryCap?.(runId), sendMemoryLimit: () => memoryLimitAccepted }),
      ...(depsInstall === undefined ? {} : { depsInstall, packageStoreRoot }),
      // D#6 BUILD-LOCKFILE-ON-DEP-ADD: the offline lockfile update after the agent's turn; needs the process-group capture and the guarded git listing.
      ...lockfileSyncFor(host.engine, envOptions, (line) => ctx.out(line), path.join(ctx.stateDir, "lock-sync")),
      // D#6 R-CHK-2: the job's approved check, run under the job's own sandbox rules; wired only where the engine offers the process-group capture and the large capture.
      ...(host.engine.installCapture === undefined || host.engine.captureLarge === undefined ? {} : { checkStep: createCheckStep({ capture: host.engine.installCapture, now: ctx.now, vcsState: createVcsState(host.engine.captureLarge, envOptions), changedFiles: createChangedFiles(host.engine.captureLarge, envOptions), trackedFiles: createTrackedFiles(host.engine.captureLarge, envOptions), importScope: createImportScope(createTrackedFiles(host.engine.captureLarge, envOptions)) }), baseFile: createBaseFile(host.engine.captureLarge, envOptions), changedFiles: createChangedFiles(host.engine.captureLarge, envOptions), headBlob: createHeadBlob(host.engine.captureLarge, envOptions), indexHidesChanges: createIndexHidesChanges(host.engine.captureLarge, envOptions), checkLaunch: (target: Parameters<typeof sandbox.checkLaunch>[0], argv: readonly string[], devShell: boolean) => sandbox.checkLaunch(target, argv, devShell), checkHome: home }),
      onDepsDetail: (detail: string) => ctx.out(`fx-runner: dependencies for this job (${detail})`),
      onStep: (line: string) => ctx.out(line),
      ...(nix === undefined ? {} : { nix, onNixSkip: (skip: string) => ctx.out(`fx-runner: no Nix dev shell for this job (${skip})`), onNixDetail: (detail: string) => ctx.out(`fx-runner: Nix dev shell for this job (${detail})`) }),
      // The interrupt serves a take-over (with a watch) and a handoff's checkpoint turn (always): both end the agent's turn with SIGINT.
      ...(watch === undefined ? {} : { watch }),
      interrupt: (job) => sandbox.interrupt(job),
      ...(host.engine.sessionOfRun === undefined ? {} : { sessionOfRun: (runId: string) => host.engine.sessionOfRun!(stateDir, runId) }),
      client,
      keyring,
      clock,
      ledger,
      ...(live === undefined ? {} : { credentialsReady: () => readyOrCode(() => live.refresh(), ctx) }),
      git,
      ...(gitA === undefined ? {} : { gitA }),
      sandbox,
      ...(vmDeps === undefined ? {} : { vm: vmDeps }),
      events: relay,
      shutdown: stopped.signal,
      spillRoot: ownSpillRoot,
      run: { workspaces: createWorkspaceStore(workspaceRoot), credentials, envOptions, planSession: (continues) => host.engine.planSession(stateDir, continues), defaultModel: DEFAULT_MODEL },
      recordSession: (sessionId, workspace) => host.engine.recordSession(stateDir, sessionId, workspace),
    });

    // The claim gate (C16 section 1.3). Each probe first looks for bubblewrap and socat again, so a tool installed while the daemon runs is found
    // (the directories are updated in place: every user of `envOptions` reads them when it builds an environment).
    const osGate = createSandboxGate({
      now: ctx.now,
      probe: () => {
        const found = sandboxDirs(host, searchPath);
        toolDirs.splice(0, toolDirs.length, ...found, ...toolchainDirs.filter((dir) => !found.includes(dir)));
        return probeMachine({ platform: host.platform, home, stateDir, binaryPath, xdgCacheHome: host.xdgCacheHome, searchPath }, host.sandbox);
      },
    });
    // D#587 B-5a part 3: a runner set to `microvm` that cannot start a VM names one of four `microvm_*` reasons and takes no job; it never falls back to the OS sandbox.
    const gate = createMicrovmGate({ engine: () => loadSettings(stateDir).sandboxEngine ?? "os_sandbox", facts: host.vmFacts, now: ctx.now, limitsBlocked: () => vmLimitsBlock(stateDir) !== undefined, inner: osGate });
    let lastReason: string | undefined;
    // The two local-only engine blocks are said once each time they begin (the claim loop's own lines are about the sandbox gate's reasons).
    let lastVmBlock: ClaimBlock | VmRunBlock | undefined;
    const noteVmBlock = (block: ClaimBlock | VmRunBlock | undefined): void => {
      if (block === lastVmBlock) return;
      lastVmBlock = block;
      if (block === "microvm_build_unwired") ctx.out(UNWIRED_LINE);
      else if (block === "microvm_restart_needed") ctx.out(RESTART_LINE);
      else if (block === "microvm_api_key_unsupported") ctx.out("fx-runner: a runner on an API key cannot run jobs in a microVM yet (microvm_api_key_unsupported), so it claims nothing, and the OS sandbox is not used instead. Sign in with a subscription, or set the engine to os_sandbox");
      else if (block === "vm_reap_pending") ctx.out("fx-runner: microVMs left by an earlier run could not all be ended (vm_reap_pending), so nothing is claimed until they are. Run: fx-runner doctor");
    };
    const vmBlocked = (): boolean => {
      const block = vmClaimBlock(stateDir, engine, built !== undefined) ?? vmGuard?.block();
      noteVmBlock(block);
      return block !== undefined;
    };
    // Self-update (D#6 R6-2b): checked at the top of the claim loop, and never while any job is in hand. A count, so one job ending does not clear the others (C43-3).
    const jobs = createJobsInHand();
    const updater = updateHost === undefined ? undefined : createUpdater(ctx, updateHost, hooks.updateTuf === undefined ? {} : { tuf: hooks.updateTuf });
    const autoUpdate = updater === undefined ? undefined : createAutoUpdate({ updater, hasLease: () => jobs.any(), now: ctx.now });
    const detach = abortOnSignals(stopped, host.signals);
    let bridge: EngineBridge | undefined;
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
      // D#601 MEM-7: before the first claim, prove this build keeps a repo's instruction file out of runs. A block is stored, shown by `status`, and holds claiming.
      if (host.engine.instructionCanary !== undefined && host.engine.instructionCanaryKey !== undefined) {
        const version = (await host.engine.inspect({ binaryPath, envOptions, stateDir, loginMode: undefined }).catch(() => undefined))?.version;
        const blocked = await ensureInstructionCanary({
          stateDir,
          binaryPath,
          binaryVersion: version,
          argv: host.engine.instructionCanaryKey(),
          now: ctx.now,
          check: () => host.engine.instructionCanary!({ binaryPath, credentials, envOptions }),
        });
        if (blocked !== undefined) ctx.out(`fx-runner: ${blocked}: ${CANARY_BLOCK_HINT[blocked]}`);
      }
      const first = await gate.check();
      if (!first.open) ctx.out(first.reason.startsWith("microvm_") ? `fx-runner: this machine cannot start the microVM engine you chose (${first.reason}); no job will be claimed until it can, and the OS sandbox is not used instead. Run: fx-runner doctor` : `fx-runner: the sandbox does not work on this machine (${first.reason}); no job will be claimed until it does. Run: fx-runner doctor`);
      lastReason = first.open ? undefined : first.reason;
      noteVmBlock(vmClaimBlock(stateDir, engine, built !== undefined));
      // D#605 FL-2: say what this build and machine are, once per start, before the first claim. Best effort and no gate: a cloud that is older, a network
      // that is down or a 426 changes nothing here (the claim loop answers all of them in its own words), and no job decision reads the facts.
      // D#845 ON-6c: `facts.kvm` goes only on a hello after a reply that listed `kvm_fact` (a cloud built before it refuses the field); the first hello never carries it.
      const factsPlain = readHostFacts(engine);
      const factsWithKvm = readHostFacts(engine, engineFacts?.kvm);
      let kvmSent = false;
      // D#749 V2b: the build's capabilities and, only while their settings and probe pass, `browser_chrome_v1` and `deploy_order_v1`. Said again when that set changes (see `betweenJobs`).
      // D#845 ON-6b: whether the machine holds model credentials. An API key is held by definition. A subscription runner holds them while the doctor's own Claude check passes
      // (the CLI is there, its version is supported and `auth status` says signed in); the same `inspect` answers both. Read at most once a minute (it starts the CLI), and a
      // reading that fails counts as not ready (fail closed). `betweenJobs` compares it with what the last hello said, so a sign-in or sign-out is said on the next check.
      let modelAuthAt = Number.NEGATIVE_INFINITY;
      let modelAuthValue = false;
      const modelAuth = async (): Promise<boolean> => {
        if (credentials.mode === "api_key") return true;
        const nowMs = clock.now().getTime();
        if (nowMs - modelAuthAt < 60_000) return modelAuthValue;
        modelAuthAt = nowMs;
        // One limit over the whole reading (FU-174): `inspect` runs up to three probes of 10 s each, which on a hung CLI would hold the hello and the claim loop for ~30 s once a minute.
        const limit = new AbortController();
        try {
          const outcome = await Promise.race([
            host.engine.inspect({ binaryPath, envOptions, stateDir, loginMode: "subscription" }),
            clock.sleep(MODEL_AUTH_LIMIT_MS, limit.signal).then(() => "timed_out" as const),
          ]);
          modelAuthValue = outcome !== "timed_out" && outcome.versionSupported && outcome.login === "yes";
        } catch {
          // fx-swallow-ok: a reading that cannot be made is "not signed in as far as we know"; the next minute asks again
          modelAuthValue = false;
        } finally {
          limit.abort();
        }
        return modelAuthValue;
      };
      const helloMessage = async () => {
        const facts = cloudKvmFact ? factsWithKvm : factsPlain;
        kvmSent = facts?.kvm !== undefined;
        return helloBody(facts);
      };
      // `kvm_fact_v1` is declared only by a runner that has a KVM reading to send (a plain present or absent), so a runner without one says what it always said.
      const capabilityList = async () => [...RUNNER_BUILD_CAPABILITIES, SANDBOX_COMMAND_CAPABILITY, ...(factsWithKvm?.kvm === undefined ? [] : [KVM_FACT_HELLO_CAPABILITY]), ...(await verifyLocal.capabilities())];
      const helloBody = async (facts: typeof factsPlain) => ({ protocol_version: RUNNER_PROTOCOL_VERSION, binary_version: RUNNER_VERSION, model_auth_present: await modelAuth(), isolation: "host_sandbox" as const, ...(facts === undefined ? {} : { facts }), capabilities: await capabilityList() });
      const firstHello = await helloMessage();
      let advertised = JSON.stringify(firstHello.capabilities);
      let advertisedAuth = firstHello.model_auth_present;
      let advertCheckedAt = clock.now().getTime();
      const hello = await client.hello(firstHello).catch(() => undefined);
      // D#6 RUNNER-WAKE: the hello's grant, if the cloud sent one, seeds the wake state; every claim reply refreshes it.
      const wake = new WakeTracker(hello?.kind === "ok" ? hello.wake : undefined);
      // What the hello's answer decides. An answer that failed, or one that dropped the capability, leaves the field unsent: the card then keeps its plain sentence.
      const takeHello = (answer: typeof hello): void => {
        const dropped = answer?.kind === "ok" ? (answer.dropped ?? []) : undefined;
        verifyLocal.refuse(dropped ?? []);
        memoryLimitAccepted = dropped !== undefined && !dropped.includes(MEMORY_LIMIT_CAPABILITY);
        conflictFactsAccepted = dropped !== undefined && !dropped.includes(CONFLICT_FACTS_CAPABILITY);
        hooks.onConflictFactsAccepted?.(conflictFactsAccepted);
        orderedFactsAccepted = dropped !== undefined && !dropped.includes(ORDERED_FACTS_CAPABILITY);
        hooks.onOrderedFactsAccepted?.(orderedFactsAccepted);
        overlapFactsAccepted = dropped !== undefined && !dropped.includes(OVERLAP_FACTS_CAPABILITY);
        hooks.onOverlapFactsAccepted?.(overlapFactsAccepted);
        tipPublishAccepted = dropped !== undefined && !dropped.includes(TIP_PUBLISH_CAPABILITY);
        hooks.onTipPublishAccepted?.(tipPublish());
        memProposalAccepted = dropped !== undefined && !dropped.includes(MEM_PROPOSAL_CAPABILITY);
        hooks.onMemProposalAccepted?.(memProposalAccepted);
        engineBridgeAccepted = dropped !== undefined && !dropped.includes(ENGINE_BRIDGE_CAPABILITY);
        if (answer?.kind === "ok") cloudWatchMode = answer.watchMode === true;
        if (answer?.kind === "ok") cloudKvmFact = answer.kvmFact === true;
      };
      takeHello(hello);
      // A hello that was not answered (a 5xx, a network failure) is said again before a later claim, on the poll loop's own pace, until one is answered. The cloud may still list
      // the capability from an earlier start, so until then the fact stays off and a merge order stops there (fail closed). The answer sets every value the first one would have
      // (the memory cap and the conflict verdict too). It takes no wake grant: the tracker was built from the first hello, and the next claim reply brings the grant, as for a runner whose hello had none. The first pass is skipped: the hello was just said.
      let helloAnswered = hello?.kind === "ok";
      let passes = 0;
      // D#483 S5-j2f: a definite refusal (a 4xx that is not a throttle or a timeout) goes out as the whole ladder of dropped capabilities, up to eight POSTs; said on every pass it is a flood. After one the retry
      // skips 1, 2, 4 ... up to 32 passes (a count of passes, the loop's own pace), so a cloud that is fixed later still gets its hello.
      let skip = 0;
      let backoff = 1;
      const sayHelloAgain = async (): Promise<void> => {
        if (helloAnswered || passes++ === 0) return;
        if (skip > 0) return void skip--;
        const resent = await helloMessage();
        advertised = JSON.stringify(resent.capabilities);
        const again = await client.hello(resent).catch(() => undefined);
        if (again?.kind === "error" && again.status >= 400 && again.status < 500 && again.status !== 408 && again.status !== 429) {
          skip = backoff;
          backoff = Math.min(backoff * 2, 32);
        }
        if (again?.kind !== "ok") return;
        helloAnswered = true;
        takeHello(again);
      };
      const deployOrder = verifyLocal.deployOrderHandler(client);
      // D#842 EB-3c: the engine bridge runs beside the claim loop, never under it: it is started here, nothing below awaits it, and it ends only when `finally` stops it.
      if (host.engineBridge !== undefined) {
        const cloud = { origin: registration.cloud_origin, key, now: ctx.now, fetchFn: ctx.fetchFn, bypass: requireUsable(ctx.bypass) };
        bridge = startEngineBridge({
          runnerStateDir: stateDir,
          uid: host.uid,
          clock,
          runnerVersion: RUNNER_VERSION,
          cloud,
          keyring,
          runnerId: registration.runner_id,
          send: createEventsUploader(cloud),
          wakeEpoch: () => wake.seenEpoch(),
          accepted: () => engineBridgeAccepted,
          cloudWatchMode: () => cloudWatchMode,
          xdgRuntimeDir: host.xdgRuntimeDir,
          secrets: () => (credentials.mode === "api_key" ? [credentials.apiKey] : []),
          ports: host.engineBridge,
          ...(host.engineBridgeOptions === undefined ? {} : { bridgeApply: createBridgeApply({ stateDir, uid: host.uid, now: ctx.now, options: host.engineBridgeOptions }) }),
          log: (line) => ctx.out(`fx-runner: ${line}`),
        });
      }
      // D#587 3c-iii: the VMs an earlier process left are ended before the first claim; a failed pass holds claiming (`vm_reap_pending`) and each claim check tries once more.
      await vmGuard?.start();
      const end = await pollLoop({
        client,
        wake,
        clock,
        gate,
        signal: stopped.signal,
        // Several runs at once while the machine has room (D#6 C43-4). Settings and the pause are read again before every claim.
        admission: createAdmission({
          probe: hooks.probe ?? realResourceProbe({ platform: host.platform, diskPaths: [workspaceRoot, path.dirname(mirrorsRoot)], vmStatText: () => vmStat }),
          footprints,
          ...(limits?.peak === undefined ? {} : { scopePeak: (runId: string) => limits.peak?.(runId), releaseScope: (runId: string) => limits.release?.(runId) }),
          settings: () => capUnenforced(loadSettings(stateDir), enforced),
          heavyBudgetBytes: () => budgets().heavy.memoryBytes,
          paused: () => isPaused(stateDir) || isDraining(stateDir) || claimBlockReason(stateDir) !== undefined || vmBlocked(),
          usage: () => usage.state(),
          now: () => clock.now().getTime(),
        }),
        draining: () => isDraining(stateDir),
        onClaimed: (claimed) => jobs.track(() => handle(claimed)),
        onMergeOrder: async () => ((await jobs.track(() => planeMerge())) === "none" ? "none" : "handled"),
        ...(deployOrder === undefined ? {} : { onDeployOrder: async () => ((await jobs.track(() => deployOrder())) === "none" ? "none" : "handled") }),
        betweenJobs: async () => {
          await sayHelloAgain();
          // D#749 V2b: the capabilities depend on the machine now (Chrome started or closed, a setting changed), so a changed set is said on a new hello. A hello that gets no answer is
          // left for `sayHelloAgain`, which resends the current set; one the cloud answers is final until the set changes again.
          // Looked at most every 30 seconds: the check lists this user's processes.
          const nowMs = clock.now().getTime();
          const due = helloAnswered && nowMs - advertCheckedAt >= 30_000;
          if (due) advertCheckedAt = nowMs;
          // D#845 ON-6c: the reply to an earlier hello changed whether `facts.kvm` may be sent (it listed `kvm_fact`, or a later one stopped listing it): say so at once, not on the 30 second check.
          const kvmStale = helloAnswered && (cloudKvmFact && factsWithKvm?.kvm !== undefined) !== kvmSent;
          if (kvmStale || (due && (JSON.stringify(await capabilityList()) !== advertised || (await modelAuth()) !== advertisedAuth))) {
            const changed = await helloMessage();
            advertised = JSON.stringify(changed.capabilities);
            advertisedAuth = changed.model_auth_present;
            const answer = await client.hello(changed).catch(() => undefined);
            if (answer?.kind === "ok") takeHello(answer);
            else helloAnswered = false;
          }
          if (autoUpdate === undefined || updateHost === undefined) return undefined;
          const outcome = await autoUpdate.tick();
          if (outcome.kind !== "applied") return undefined;
          if (updateHost.inService) {
            ctx.out(`fx-runner: updated to ${outcome.version}; restarting on it`);
            return "restart" as const;
          }
          ctx.out(`Updated to ${outcome.version}. Restart \`fx-runner run\` to use it.`);
          return undefined;
        },
        log: (event) => {
          // Said when the answer changes, not on every poll.
          const reason = event.event === "sandbox_unavailable" ? event.reason : event.event === "idle" || event.event === "rate_limited" ? undefined : lastReason;
          if (reason !== lastReason) ctx.out(reasonChangeLine(reason));
          lastReason = reason;
          const line = describePoll(event);
          if (line !== undefined) ctx.out(`fx-runner: ${line}`);
        },
      });
      if (end === "drained") {
        // The marker is removed here, so the next start (by hand or by the service manager) claims again.
        setDraining(stateDir, false);
        ctx.out("fx-runner: drained: no job is in hand and none was claimed since the drain was asked for; exiting");
        return 0;
      }
      if (end === "restart") return EXIT_RESTART_FOR_UPDATE;
      if (end === "unauthorized") throw new CliError("the cloud no longer accepts this runner's key; run: fx-runner revoke --local, then register again");
      // Vercel's Deployment Protection answered, not the cloud: the key is fine, so this says what to set and never to revoke. The process ends, as for a refused key.
      if (end === "protected") throw new CliError(`Vercel Deployment Protection refused the request before it reached the runner API, so the runner's key was not judged and must not be revoked: ${ctx.bypass?.kind === "ok" ? `the secret in the file ${BYPASS_ENV_NAME} names was not accepted` : `${BYPASS_ENV_NAME} is not set`}. Set it to a file holding the project's Protection Bypass for Automation secret, then start fx-runner again (run: fx-runner doctor)`);
      return 0;
    } finally {
      await bridge?.stop();
      if (vmStatTimer !== undefined) clearInterval(vmStatTimer);
      detach();
    }
  } finally {
    pushLog?.close();
    ledger.close();
  }
}
