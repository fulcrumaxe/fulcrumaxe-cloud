/**
 * `fx-runner doctor` (D#6 R4a-4): one PASS, WARN or FAIL line per check, so a machine that cannot run jobs says why. It checks the
 * registration and its key, that the cloud answers, the installed agent CLI (found on the search path, version against the
 * minimum, every flag the engine passes), whether a login of the right kind exists, and the shell variables that would outrank
 * a subscription login. It also runs the sandbox probe (D#6 R4a-5, C16): a test command in the sandbox a job gets, and on a failure the
 * exact fix for this machine's distro. Exit code 0 unless a check FAILs.
 *
 * It makes no model request (the CLI is only asked `--version`, `--help` and `auth status`, through the engine kit) and prints
 * no secret: the shell variables arrive as names only, the CLI's answers are cut down to a version, a flag list and a short
 * method label, and the only text from the cloud is its status being "an answer".
 */
import { KEY_MAX_AGE_DAYS, loadRegistration, type Registration } from "../config.js";
import { CliError } from "../cliError.js";
import type { CommandContext } from "../context.js";
import type { EngineKit } from "../daemon/engineKit.js";
import { ApiKeyError, readApiKey } from "../credentials.js";
import { cleanEnv } from "../job/cleanEnv.js";
import { isProtectedDeployment, readCapped } from "../cloud.js";
import { loadRunnerKey } from "../keys.js";
import { BYPASS_ENV_NAME, bypassHeaders, bypassSecret, bypassRefusalText } from "../protectionBypass.js";
import { MACOS_PREVIEW_NOTICE, platformRow } from "../platformSupport.js";
import { UNENFORCED_LINE, detectScopeSupport, type ScopeSupport } from "../sandbox/jobLimits.js";
import { SandboxRefused, detectPlatform, wslFacts } from "../sandbox/platform.js";
import { probeMachine, type SandboxHost } from "../sandbox/probe.js";
import { clearWsl } from "../sandbox/wslGate.js";
import { detectDistro, sandboxFixLines } from "../sandbox/sandboxFix.js";
import { checkJobShell } from "../sandbox/jobShellProbe.js";
import { toolchainReport } from "../sandbox/toolchain.js";
import { findCliStubs } from "../daemon/cliStubs.js";
import { ENGINE_LINES, engineLineOf, missingCaps, type VmHostFacts } from "../vm/limits.js";
import { vmTokenLine, vmTokenStatus } from "../credentials/vmToken.js";
import { gateEngine, loadSettings, omitsDevToken } from "../runnerSettings.js";
import { vmInstallChecks, type VmInstallFacts } from "../vm/doctorChecks.js";
import { VM_CHECKS, fixText, preflightChecks, probeNetwork, type NetworkPorts, type PreflightFacts } from "../daemon/preflight.js";
import { updatesLine } from "./update.js";
import { userUnitInstalled } from "./service.js";
import { cacheRootsFor } from "../daemon/mirror.js";
import { DEFAULT_RETENTION_DAYS, formatBytes, freeFractionOf, retentionFor, summariseWorkspaces } from "../job/workspacePrune.js";

const OS_RELEASE = "/etc/os-release";
const NIXOS_MARKER = "/etc/NIXOS";
const DAY_MS = 86_400_000;
const CLOUD_TIMEOUT_MS = 10_000;

/** What `doctor` needs from the machine. Only `bin/fx-runner.mjs` fills it in. */
export interface DoctorHost {
  platform: NodeJS.Platform;
  /** The names among `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` that are set in the shell. Names only: the values never enter the command. */
  shellVars: readonly string[];
  engine: Pick<EngineKit, "locate" | "inspect">;
  /** The user's home directory, looked up by name by the caller. Without it the sandbox probe cannot be set up and says so. */
  home: string | undefined;
  /** D#587 B-2a-2 PR-4: what the runner's own user can read about the installed VM helper (no root call). Left out, the VM install checks are not printed. */
  vmInstall?: (() => Promise<VmInstallFacts>) | undefined;
  /** The directory `doctor` was started in, where the CLI placeholders check also looks (D#6 RUNNER-CWD-1). */
  cwd?: string | undefined;
  xdgCacheHome?: string | undefined;
  /** The free fraction of the disk the workspaces are on, for the retention in force; read from the disk when absent (a test seam). */
  workspaceFreeFraction?: (() => number | undefined) | undefined;
  /** The user's login shell (an absolute path, from the SHELL variable): what the agent CLI starts its Bash tool through. Without it the job-shell check says it was not run. */
  shell?: string | undefined;
  /** The machine behind the sandbox probe: the process start and the file reads. */
  sandbox: SandboxHost;
  /** The kernel release string; the machine's own when left out. Tests set it. */
  osrelease?: string | undefined;
  /** The user id and `XDG_RUNTIME_DIR`, looked up by name by the caller: where the per-job limits (D#6 C43-5) find the user's systemd manager. */
  uid?: number | undefined;
  xdgRuntimeDir?: string | undefined;
  /** Replaceable by a test only: the answer to "can scopes be made here" instead of trying a real one. */
  scopeSupport?: ScopeSupport | undefined;
  /** `XDG_CONFIG_HOME` and the account name, looked up by the caller: where a per-user service unit would be, and the name the lingering advice uses. */
  xdgConfigHome?: string | undefined;
  userName?: string | undefined;
  /** D#587 B-6a: what the machine says about KVM, the VM helper's socket and memory. Left out means every one of them is unreadable, which never reads as available. */
  vm?: VmHostFacts | undefined;
  /** D#587 B-6-VMTOKEN: whether the dev token variable (the subscription token's name, looked up by the entry point) is set in this shell (a boolean; the value never enters the command). It counts only while the token file is missing. */
  vmEnvToken?: boolean | undefined;
  /** D#587 B-5b-3a: whether this build composed a live microVM stack (`liveMicrovmComplete`). Anything but `true` is "not wired", which fails a runner set to `microvm`, never passes it. */
  microvmWired?: boolean | undefined;
  /** D#845 ON-21: where the preflight list reads the kernel (the bin edge) and resolves names. Left out, no preflight line is printed. */
  preflight?: { kernel: (input: { uid: number | undefined; stateDir: string }) => Pick<PreflightFacts, "kvm" | "vt" | "cgroup" | "cgroupDelegated" | "diskFreeBytes" | "memAvailableBytes">; lookup: NetworkPorts["lookup"]; /** Replaceable by a test only. */ urls?: NetworkPorts["urls"] } | undefined;
  /** The cloud origin to reach when the machine is not registered yet (`setup` passes the one it was given). A registration's own origin wins. */
  cloudOrigin?: string | undefined;
  /** This program's version and real path, for the Updates line. Absent in tests that do not care. */
  update?: { version?: string | undefined; execPath?: string | undefined } | undefined;
}

type Level = "PASS" | "WARN" | "FAIL" | "INFO";

/** The sandbox line, and under a failure the fix for this machine. A probe that cannot be set up is a failure too: there is no unsandboxed way to run. */
async function sandboxCheck(ctx: CommandContext, host: DoctorHost, binaryPath: string | undefined, line: (level: Level, label: string, detail: string) => void): Promise<boolean> {
  try {
    detectPlatform({ platform: host.platform, osrelease: host.osrelease, ...wslFacts(host.sandbox.wsl) });
  } catch (error) {
    if (!(error instanceof SandboxRefused)) throw error;
    line("FAIL", "Sandbox", `${error.code}: ${error.message.slice(error.code.length + 2)}`);
    return false;
  }
  let result;
  try {
    result = await probeMachine({ platform: host.platform, home: host.home, stateDir: ctx.stateDir, binaryPath, xdgCacheHome: host.xdgCacheHome }, host.sandbox);
  } catch {
    // fx-swallow-ok: a probe that cannot even be set up is reported as the failed check it is; the error text is not shown
    line("FAIL", "Sandbox", "probe_failed_other: the sandbox test could not be set up on this machine");
    return false;
  }
  if (result.ok) {
    line("PASS", "Sandbox", `a test command ran inside the job's sandbox rules (${result.tool})`);
    return true;
  }
  line("FAIL", "Sandbox", `${result.reason}: ${result.detail}`);
  const distro = detectDistro({ platform: host.platform, osRelease: host.sandbox.readText(OS_RELEASE), nixosMarker: host.sandbox.isFile(NIXOS_MARKER) });
  for (const text of sandboxFixLines(distro, result.reason, result.bwrapPath)) ctx.out(text === "" ? "" : `      ${text}`);
  return false;
}

/**
 * On WSL2, the gate (D#587 B-9b): one line per check and live probe, each failure with its closed code and the fix, then the VM-mode line. It runs before the
 * sandbox line because a cleared machine is what lets that line pass; anywhere else it prints nothing.
 */
async function wslCheck(ctx: CommandContext, host: DoctorHost, binaryPath: string | undefined, line: (level: Level, label: string, detail: string) => void): Promise<void> {
  const gate = await clearWsl({ platform: host.platform, osrelease: host.osrelease, home: host.home, stateDir: ctx.stateDir, binaryPath, xdgCacheHome: host.xdgCacheHome, searchPath: cleanEnv({ mode: "subscription" }).PATH ?? "", host: host.sandbox, engine: gateEngine(ctx.stateDir) });
  if (!gate.wsl2) return;
  for (const item of gate.items) line(item.ok ? "PASS" : "FAIL", "WSL2", item.ok ? item.detail : `${item.code}: ${item.detail}`);
  if (gate.cleared) line("INFO", "WSL2", gate.loopback ? "networking mode is NAT: loopback allowances are granted as asked" : "networking mode is mirrored or not known: jobs may not ask for a loopback bind");
  line("INFO", "WSL2", platformRow("wsl2").vmNotice ?? "");
}

/** Whether each job can run under hard memory and process limits here (D#6 C43-5), tried with a real throw-away scope. When it cannot, the runner holds back and this says so. */
async function limitsCheck(host: DoctorHost, line: (level: Level, label: string, detail: string) => void): Promise<void> {
  const support = host.scopeSupport ?? await detectScopeSupport({
    platform: host.platform,
    uid: host.uid,
    runtimeDir: host.xdgRuntimeDir,
    searchPath: cleanEnv({ mode: "subscription" }).PATH ?? "",
    capture: host.sandbox.run,
    isDir: host.sandbox.isDir,
    readText: host.sandbox.readText,
  });
  if (support.ok) line("PASS", "Job limits", "each job runs in its own systemd scope with a memory and a process limit");
  else line("WARN", "Job limits", `${UNENFORCED_LINE} (${support.reason})`);
}

const MIB = 1024 ** 2;

/**
 * D#587 B-6a: the `sandbox_engine:` line, from the closed set in `vm/limits.ts`, and in `microvm` mode the limits and the host memory reading. The engine
 * line is printed whatever the mode; the checks after it can FAIL only when the person asked for `microvm`, and then the runner claims nothing. A fact that could
 * not be read is a failure there, never a pass.
 */
function vmEngineCheck(ctx: CommandContext, host: DoctorHost, mode: Registration["credential_mode"] | undefined, line: (level: Level, label: string, detail: string) => void): void {
  const settings = loadSettings(ctx.stateDir);
  const engine = settings.unreadable === true ? "invalid" : (settings.sandboxEngine ?? "os_sandbox");
  const text = engineLineOf({ platform: host.platform, engine, caps: settings.microvm, facts: host.vm });
  ctx.out(`INFO  sandbox_engine: ${text}`);
  if (engine === "invalid") {
    line("FAIL", "microvm", settings.unreadable === true ? "the settings file cannot be read (damaged, too large or not a regular file); nothing is claimed. Fix or remove it, then run: fx-runner config set sandbox_engine os_sandbox|microvm" : "sandbox_engine in the settings file is neither os_sandbox nor microvm; nothing is claimed. Fix it with: fx-runner config set sandbox_engine os_sandbox|microvm");
    return;
  }
  // D#587 B-6-VMTOKEN: the token a VM job is handed. FAIL in microvm mode when it is missing or unsafe (the runner then claims nothing); INFO only in os_sandbox mode, and for an
  // API-key runner, which sends no subscription token to a VM. Derived from the file on every run of doctor; never shows any part of it.
  const tokenStatus = vmTokenStatus(ctx.stateDir, host.uid);
  const tokenLine = vmTokenLine(tokenStatus, host.vmEnvToken === true);
  const tokenNeeded = engine === "microvm" && mode !== "api_key";
  line(tokenNeeded ? tokenLine.level : "INFO", "VM model token", tokenLine.detail);
  if (engine !== "microvm") return;
  const missing = missingCaps(settings.microvm);
  if (missing.length > 0) line("FAIL", "microvm limits", `missing or invalid: ${missing.join(", ")}; nothing is claimed. Set each with: fx-runner config set <key> <value>`);
  if (text !== ENGINE_LINES.microvm && text !== ENGINE_LINES.limitsMissing) line("FAIL", "microvm", `microvm_unavailable: ${text}; nothing is claimed and the runner does not fall back to os_sandbox`);
  if (host.microvmWired !== true) line("FAIL", "microvm", "microvm_build_unwired: this build cannot start jobs in a microVM yet; nothing is claimed and the runner does not fall back to os_sandbox");
  const caps = settings.microvm;
  if (missing.length > 0 || caps === undefined) return;
  const vm = host.vm;
  const totalMb = vm?.totalMemMb;
  const cpus = vm?.cpus;
  if (totalMb === undefined || cpus === undefined || !Number.isFinite(totalMb) || !Number.isFinite(cpus)) {
    line("FAIL", "microvm limits", "the host's total memory or core count could not be read, so the limits cannot be compared with it");
  } else {
    const over: string[] = [];
    if ((caps.maxMemoryMb ?? 0) > totalMb) over.push(`max_memory_mb ${caps.maxMemoryMb} is over the host's ${totalMb} MiB`);
    if ((caps.maxVcpus ?? 0) > cpus) over.push(`max_vcpus ${caps.maxVcpus} is over the host's ${cpus} cores`);
    if (over.length > 0) line("FAIL", "microvm limits", over.join("; "));
    else line("PASS", "microvm limits", `max_vms ${caps.maxVms}, max_vcpus ${caps.maxVcpus} (host ${cpus}), max_memory_mb ${caps.maxMemoryMb} (host ${totalMb}), snapshot_dir ${caps.snapshotDir}, snapshot_quota_bytes ${caps.snapshotQuotaBytes}`);
  }
  let available: number | undefined;
  try {
    available = vm?.readMemAvailableBytes();
  } catch {
    // fx-swallow-ok: a reader that throws is a reading that could not be made, reported below
    available = undefined;
  }
  if (typeof available !== "number" || !Number.isFinite(available) || available < 0) line("FAIL", "Host memory", "available memory could not be read; every VM would be refused");
  else line("INFO", "Host memory", `${Math.floor(available / MIB)} MiB available`);
}

/** The environment `loginctl` is started with: a fixed search path, no locale. */
const LOGINCTL_ENV = { PATH: "/usr/bin:/bin:/run/current-system/sw/bin", LC_ALL: "C" };
const LOGINCTL_TIMEOUT_MS = 5_000;
const LOGINCTL = "loginctl";

/**
 * D#605 FL-7: a per-user service stops when its user logs out unless systemd keeps their manager running (lingering). Only when this
 * command wrote a user unit does it matter, so only then is `loginctl show-user` asked. The reading is `Linger=yes|no`; an answer that is
 * neither is reported as unchecked, never as a pass.
 */
type Linger = "yes" | "no" | "unknown";
/** `loginctl show-user`'s `Linger=` reading; an answer that is neither yes nor no is unknown. Asked at most once per `doctor` run. */
function lingerReader(host: DoctorHost): () => Promise<Linger> {
  let asked: Promise<Linger> | undefined;
  return () => {
    asked ??= (async (): Promise<Linger> => {
      if (host.platform !== "linux" || host.uid === undefined) return "unknown";
      const result = await host.sandbox.run(LOGINCTL, ["show-user", String(host.uid), "--property=Linger"], LOGINCTL_ENV, LOGINCTL_TIMEOUT_MS);
      const linger = result.code === 0 && !result.timedOut ? result.stdout.match(/^Linger=(yes|no)$/m)?.[1] : undefined;
      return linger === "yes" || linger === "no" ? linger : "unknown";
    })();
    return asked;
  };
}

/** Whether this command wrote a user unit: the only case in which logging out stops the runner. */
function userUnitHere(host: DoctorHost): boolean {
  if (host.platform !== "linux" || host.home === undefined || host.uid === undefined) return false;
  try {
    return userUnitInstalled(host.home, host.xdgConfigHome);
  } catch {
    // fx-swallow-ok: a location that cannot be read is the same as no unit for this advisory check
    return false;
  }
}

async function lingerCheck(host: DoctorHost, read: () => Promise<Linger>, line: (level: Level, label: string, detail: string) => void): Promise<void> {
  if (!userUnitHere(host)) return;
  const linger = await read();
  if (linger === "no") line("WARN", "Service", `Stops when you log out: run loginctl enable-linger ${host.userName ?? "<user>"} or use service install --system`);
  else if (linger === "yes") line("PASS", "Service", "the user service keeps running after you log out (lingering is on)");
  else line("INFO", "Service", "a user service is installed; whether it survives a logout could not be checked (loginctl did not answer)");
}

/**
 * D#845 ON-21: the preflight list (`daemon/preflight.ts`) as doctor lines: one INFO line with the count, then one line per check that is not `ok`, each as
 * `<code>: <fix>`. A check about running a microVM is a WARN unless the settings ask for the microVM engine (then it is a FAIL), so a machine without KVM
 * keeps the exit code it had; a check about reaching the cloud, names, time or disk is a FAIL. Lingering is left to the Service line when a user unit is
 * installed, which says the same thing. Only the codes and the fixed fix lines are printed: no host name, address or path.
 */
async function preflightCheck(ctx: CommandContext, host: DoctorHost, origin: string | undefined, readLinger: () => Promise<Linger>, line: (level: Level, label: string, detail: string) => void): Promise<void> {
  if (host.platform !== "linux" || host.preflight === undefined) return;
  let kernel: ReturnType<NonNullable<DoctorHost["preflight"]>["kernel"]>;
  try {
    kernel = host.preflight.kernel({ uid: host.uid, stateDir: ctx.stateDir });
  } catch {
    // fx-swallow-ok: a reader that throws is a set of readings that could not be made; each check then says it was not run
    kernel = { kvm: "unknown", vt: "unknown", cgroup: "unknown", cgroupDelegated: "unknown", diskFreeBytes: undefined, memAvailableBytes: undefined };
  }
  const network = await probeNetwork({ fetchFn: ctx.fetchFn, lookup: host.preflight.lookup, now: ctx.now, cloudOrigin: origin, urls: host.preflight.urls });
  const items = preflightChecks({ ...kernel, ...network, linger: await readLinger() });
  const microvm = loadSettings(ctx.stateDir).sandboxEngine === "microvm";
  const kept = items.filter((item) => item.level !== "ok" && !(item.check === "linger" && userUnitHere(host)));
  line("INFO", "Preflight", `${items.filter((item) => item.level === "ok").length} of ${items.length} checks ok${kept.length === 0 ? "" : `, ${kept.length} to look at`}`);
  for (const item of kept) {
    const level: Level = item.level === "fail" && (!VM_CHECKS.has(item.check) || microvm) ? "FAIL" : "WARN";
    line(level, "Preflight", `${item.code}: ${fixText(item, host.userName)}`);
  }
}

/**
 * D#6 RUNNER-CWD-1: the empty placeholder files and directories the Claude CLI makes when it starts (`cliStubs.ts`), where they sit in the home
 * directory or in the directory `doctor` was started in. Older runners started the CLI there. Reported as a warning; nothing is deleted.
 */
function cliStubsCheck(host: DoctorHost, line: (level: Level, label: string, detail: string) => void): void {
  const places: Array<[string, string | undefined, "home" | "cwd"]> = [["Your home directory", host.home, "home"], ["The directory doctor runs in", host.cwd, "cwd"]];
  for (const [where, dir, kind] of places) {
    if (dir === undefined || !dir.startsWith("/")) continue;
    const names = findCliStubs(dir, kind);
    if (names.length > 0) line("WARN", "CLI stubs", `${where} (${dir}) holds empty files the Claude CLI makes when it starts: ${names.join(", ")}. fx-runner did not delete them; remove the ones you did not make yourself.`);
  }
}

/** The API key file (D#6 R5b-3): whether it is there and safe, never its value. A subscription runner does not use it. */
function apiKeyCheck(ctx: CommandContext, mode: Registration["credential_mode"] | undefined, line: (level: Level, label: string, detail: string) => void): void {
  if (mode === "subscription") {
    line("INFO", "API key", "not used in subscription mode");
    return;
  }
  try {
    readApiKey(ctx.stateDir, ctx.uid);
  } catch (error) {
    if (!(error instanceof ApiKeyError)) throw error;
    if (mode === undefined && error.code === "api_key_not_configured") return;
    line(mode === undefined ? "WARN" : "FAIL", "API key", error.message);
    return;
  }
  if (mode === undefined) line("INFO", "API key", "stored, but this machine has no registration (revoke leaves the file); to remove it run: fx-runner credentials clear-api-key");
  else line("PASS", "API key", "stored (a plain file at mode 0600 in a private directory, owned by you, starting with sk-ant-)");
}

/** `doctor --sandbox-only` (the probe `install.sh` runs, C16 section 2): just the sandbox line and its fix. It reads no registration and makes no network call. */
async function sandboxOnly(ctx: CommandContext, host: DoctorHost, line: (level: Level, label: string, detail: string) => void): Promise<void> {
  let binaryPath: string | undefined;
  try {
    binaryPath = host.engine.locate(cleanEnv({ mode: "subscription" }).PATH ?? "");
  } catch (error) {
    // fx-swallow-ok: the probe runs without the Claude CLI's folder; a missing CLI is the full doctor's finding, not this check's
    if (!(error instanceof Error) || error.name !== "EngineRefusal") throw error;
  }
  await wslCheck(ctx, host, binaryPath, line);
  await sandboxCheck(ctx, host, binaryPath, line);
}

export async function doctorCommand(ctx: CommandContext, host: DoctorHost, options: { sandboxOnly?: boolean } = {}): Promise<number> {
  let failed = 0;
  const line = (level: Level, label: string, detail: string): void => {
    if (level === "FAIL") failed++;
    ctx.out(`${level.padEnd(4)}  ${`${label}:`.padEnd(19)}${detail}`);
  };
  if (options.sandboxOnly === true) {
    await sandboxOnly(ctx, host, line);
    return failed === 0 ? 0 : 1;
  }

  // A refusal from the loaders carries its own fixed text with the right remedy (chmod for a file others can read, revoke for a damaged one), so it is shown as it is.
  const refusal = (error: unknown): string => {
    if (error instanceof CliError) return error.message;
    throw error;
  };
  let registration: Registration | undefined;
  let registrationFailed = false;
  try {
    registration = loadRegistration(ctx.stateDir);
  } catch (error) {
    // fx-swallow-ok: the refusal is reported as the failed check it is
    registrationFailed = true;
    line("FAIL", "Registration", refusal(error));
  }
  if (registration === undefined) {
    if (!registrationFailed) line("FAIL", "Registration", "not registered; run: fx-runner register --code-stdin --credential-mode <mode> --cloud-url <url>");
  } else {
    let key: ReturnType<typeof loadRunnerKey>;
    let keyRefusal: string | undefined;
    try {
      key = loadRunnerKey(ctx.stateDir);
    } catch (error) {
      // fx-swallow-ok: the refusal is reported as the failed check it is, and the remaining checks still run
      keyRefusal = refusal(error);
    }
    const ageDays = Math.max(0, Math.floor((ctx.now().getTime() - Date.parse(registration.registered_at)) / DAY_MS));
    if (keyRefusal !== undefined) line("FAIL", "Registration", keyRefusal);
    else if (!key || key.jkt !== registration.jkt) line("FAIL", "Registration", "the runner key is missing or does not match; run: fx-runner revoke --local, then register again");
    else if (ageDays >= KEY_MAX_AGE_DAYS) line("FAIL", "Registration", `the key is ${ageDays} days old and the cloud refuses keys over ${KEY_MAX_AGE_DAYS}; revoke and register again`);
    else line("PASS", "Registration", `runner ${registration.runner_id}, ${registration.credential_mode} mode, key ${ageDays} days old`);

    try {
      // Any answer at all means the cloud is reachable. On a 401 a small part of the body is read, only to tell Vercel's own protected-deployment answer from the cloud's; it is never shown.
      const secret = bypassSecret(ctx.bypass);
      const url = `${registration.cloud_origin}/`;
      const response = await ctx.fetchFn(url, { method: "GET", headers: { accept: "application/json", ...bypassHeaders(secret, registration.cloud_origin, url) }, redirect: "manual", signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS) });
      let body: unknown;
      if (response.status === 401) {
        try {
          body = JSON.parse(await readCapped(response, 8192));
        } catch {
          // fx-swallow-ok: a body that cannot be read or is not JSON is not Vercel's protection answer
          body = undefined;
        }
      } else {
        await response.body?.cancel();
      }
      if (isProtectedDeployment(response.status, response.headers.get("server"), body)) {
        const why = secret === undefined ? `${BYPASS_ENV_NAME} is not set` : `the secret in the file ${BYPASS_ENV_NAME} names was not accepted`;
        line("FAIL", "Cloud", `${registration.cloud_origin} answers Vercel's protected-deployment 401: ${why}. For staging or a protected preview, set ${BYPASS_ENV_NAME} to a file holding the Protection Bypass for Automation secret`);
      } else {
        line("PASS", "Cloud", `${registration.cloud_origin} answers`);
      }
    } catch {
      // fx-swallow-ok: the point of the check is the yes or no; the error text may carry an address
      line("FAIL", "Cloud", `${registration.cloud_origin} is not reachable`);
    }
  }

  // The value is never shown: only whether it is set and the file passed its checks.
  if (ctx.bypass?.kind === "ok") line("PASS", "Protection bypass", "set (file ok)");
  else if (ctx.bypass?.kind === "refused") line("FAIL", "Protection bypass", bypassRefusalText(ctx.bypass.code));
  else line("INFO", "Protection bypass", "not set");

  const mode = registration?.credential_mode;
  let binaryPath: string | undefined;
  try {
    binaryPath = host.engine.locate(cleanEnv({ mode: "subscription" }).PATH ?? "");
    line("PASS", "Claude CLI", binaryPath);
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "EngineRefusal") throw error;
    line("FAIL", "Claude CLI", "not found; install Claude Code, then run doctor again");
  }

  if (binaryPath !== undefined) {
    // In microvm mode the probes run without the dev token variable (it is for VM jobs only, from the file).
    const report = await host.engine.inspect({ binaryPath, envOptions: { omitSubscriptionToken: omitsDevToken(ctx.stateDir) }, stateDir: ctx.stateDir, loginMode: mode === "subscription" ? "subscription" : undefined });
    if (report.version === undefined) line("FAIL", "Claude version", `could not be read; upgrade Claude Code to ${report.minimumVersion} or newer`);
    else if (!report.versionSupported) line("FAIL", "Claude version", `${report.version}, at least ${report.minimumVersion}: no; upgrade Claude Code`);
    else line("PASS", "Claude version", `${report.version}, at least ${report.minimumVersion}: yes`);

    if (!report.versionSupported) line("WARN", "Claude flags", "not checked until the version is supported");
    else if (report.missingFlags === undefined) line("FAIL", "Claude flags", "the CLI's --help could not be read");
    else if (report.missingFlags.length > 0) line("FAIL", "Claude flags", `missing ${report.missingFlags.join(", ")}; upgrade Claude Code`);
    else line("PASS", "Claude flags", "every flag the runner passes is listed");

    const method = report.authMethod === undefined ? "" : ` (${report.authMethod})`;
    if (report.login === "yes") line("PASS", "Claude login", `yes${method}`);
    else if (report.login === "no") line("FAIL", "Claude login", `no${method}; sign in with Claude Code on this machine`);
    else if (mode === undefined) line("WARN", "Claude login", "unknown: not registered, so the credential mode is not known");
    else if (mode !== "subscription") line("WARN", "Claude login", "unknown: an API key is not tested here (doctor makes no model request)");
    else line("WARN", "Claude login", "unknown: the CLI did not answer `auth status`");
  }

  apiKeyCheck(ctx, mode, line);
  cliStubsCheck(host, line);

  await wslCheck(ctx, host, binaryPath, line);
  const sandboxOk = await sandboxCheck(ctx, host, binaryPath, line);
  await limitsCheck(host, line);
  vmEngineCheck(ctx, host, mode, line);
  const readLinger = lingerReader(host);
  await preflightCheck(ctx, host, registration?.cloud_origin ?? host.cloudOrigin, readLinger, line);
  await lingerCheck(host, readLinger, line);
  if (host.vmInstall !== undefined) for (const c of vmInstallChecks(await host.vmInstall(), { microvm: loadSettings(ctx.stateDir).sandboxEngine === "microvm" })) line(c.level, c.label, c.detail);

  // What a job's agent can run for a project's own tests (D#6 R4d-3), on the runner's own PATH. Missing node is a warning, not a failure: not every repository needs it.
  // What the job's login shell finds is the next check (D#6 C44-2), and it only means something when the runner's PATH has node and the sandbox runs.
  const toolchain = toolchainReport(cleanEnv({ mode: "subscription" }).PATH ?? "", { home: host.home, stateDir: ctx.stateDir, binaryPath, platform: host.platform, xdgCacheHome: host.xdgCacheHome });
  if (toolchain !== undefined) {
    line(toolchain.level, "Runner PATH", toolchain.line);
    for (const warning of toolchain.warnings) line("WARN", "Runner PATH", warning);
  }
  if (sandboxOk) {
    if (toolchain?.hasNode === true) await checkJobShell({ platform: host.platform, home: host.home, shell: host.shell, stateDir: ctx.stateDir, binaryPath, xdgCacheHome: host.xdgCacheHome }, host.sandbox, line);
    else line("INFO", "Job shell", "not checked: node is not on the runner PATH");
  }

  if (mode === "subscription") {
    if (host.shellVars.length === 0) line("PASS", "Shell variables", "no Anthropic key or token is set");
    for (const name of host.shellVars) line("WARN", "Shell variable", `${name} is set in this shell; it would outrank your Claude login. fx-runner removes it from jobs.`);
  }
  // FU-318: what finished runs leave on the disk, so a full disk has an explanation before it is a problem.
  if (host.home !== undefined) {
    const workspaceRoot = cacheRootsFor({ home: host.home, platform: host.platform, xdgCacheHome: host.xdgCacheHome }).workspaceRoot;
    const summary = await summariseWorkspaces(workspaceRoot, ctx.now());
    if (summary !== undefined) {
      // The retention in force is the configured one, cut to a day while the disk is under 10% free (the prune's own rule), so a short retention is explained.
      const configured = loadSettings(ctx.stateDir).workspaceRetentionDays ?? DEFAULT_RETENTION_DAYS;
      const inForce = retentionFor(configured, host.workspaceFreeFraction === undefined ? freeFractionOf(workspaceRoot) : host.workspaceFreeFraction());
      const oldest = summary.oldestIdleDays;
      const days = (n: number): string => `${n} day${n === 1 ? "" : "s"}`;
      const kept = `kept ${days(configured)}${inForce.pressure && inForce.days !== configured ? `, but ${days(inForce.days)} now: the disk is under 10% free` : ""}`;
      const text = `${summary.directories} run workspace${summary.directories === 1 ? "" : "s"}, ${summary.partial ? "at least " : ""}${formatBytes(summary.bytes)}${oldest === undefined ? "" : `; oldest untouched ${days(oldest)}`}; ${kept}`;
      if (oldest !== undefined && oldest > inForce.days * 2) line("WARN", "Workspaces", `${text}; the runner prunes while it runs, or run: fx-runner prune`);
      else line("INFO", "Workspaces", text);
    }
  }
  // Self-update (D#6 R6-2a, R6-2b): off, and said so, until the build carries a release root; then the pin, the switch and the last check.
  const updates = updatesLine(ctx.stateDir, host.update);
  line(updates.level, "Updates", updates.detail);

  if (host.platform === "darwin") line("INFO", "macOS", MACOS_PREVIEW_NOTICE);

  ctx.out(failed === 0 ? "All checks passed." : `${failed} check${failed === 1 ? "" : "s"} failed.`);
  return failed === 0 ? 0 : 1;
}
