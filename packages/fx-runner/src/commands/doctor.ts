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
import { MACOS_PREVIEW_NOTICE } from "../platformSupport.js";
import { UNENFORCED_LINE, detectScopeSupport, type ScopeSupport } from "../sandbox/jobLimits.js";
import { SandboxRefused, detectPlatform } from "../sandbox/platform.js";
import { probeMachine, type SandboxHost } from "../sandbox/probe.js";
import { detectDistro, sandboxFixLines } from "../sandbox/sandboxFix.js";
import { checkJobShell } from "../sandbox/jobShellProbe.js";
import { toolchainReport } from "../sandbox/toolchain.js";
import { updatesLine } from "./update.js";

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
  xdgCacheHome?: string | undefined;
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
  /** This program's version and real path, for the Updates line. Absent in tests that do not care. */
  update?: { version?: string | undefined; execPath?: string | undefined } | undefined;
}

type Level = "PASS" | "WARN" | "FAIL" | "INFO";

/** The sandbox line, and under a failure the fix for this machine. A probe that cannot be set up is a failure too: there is no unsandboxed way to run. */
async function sandboxCheck(ctx: CommandContext, host: DoctorHost, binaryPath: string | undefined, line: (level: Level, label: string, detail: string) => void): Promise<boolean> {
  try {
    detectPlatform({ platform: host.platform, osrelease: host.osrelease });
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
    if (!registrationFailed) line("FAIL", "Registration", "not registered; run: fx-runner register --code <code> --credential-mode <mode> --cloud-url <url>");
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
    const report = await host.engine.inspect({ binaryPath, envOptions: {}, stateDir: ctx.stateDir, loginMode: mode === "subscription" ? "subscription" : undefined });
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

  const sandboxOk = await sandboxCheck(ctx, host, binaryPath, line);
  await limitsCheck(host, line);

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
  // Self-update (D#6 R6-2a, R6-2b): off, and said so, until the build carries a release root; then the pin, the switch and the last check.
  const updates = updatesLine(ctx.stateDir, host.update);
  line(updates.level, "Updates", updates.detail);

  if (host.platform === "darwin") line("INFO", "macOS", MACOS_PREVIEW_NOTICE);

  ctx.out(failed === 0 ? "All checks passed." : `${failed} check${failed === 1 ? "" : "s"} failed.`);
  return failed === 0 ? 0 : 1;
}
