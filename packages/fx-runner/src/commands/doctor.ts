/**
 * `fx-runner doctor` (D#6 R4a-4): one PASS, WARN or FAIL line per check, so a machine that cannot run jobs says why. It checks the
 * registration and its key, that the cloud answers, the installed agent CLI (found on the search path, version against the
 * minimum, every flag the engine passes), whether a login of the right kind exists, and the shell variables that would outrank
 * a subscription login. Exit code 0 unless a check FAILs.
 *
 * It makes no model request (the CLI is only asked `--version`, `--help` and `auth status`, through the engine kit) and prints
 * no secret: the shell variables arrive as names only, the CLI's answers are cut down to a version, a flag list and a short
 * method label, and the only text from the cloud is its status being "an answer".
 */
import { KEY_MAX_AGE_DAYS, loadRegistration, type Registration } from "../config.js";
import { CliError } from "../cliError.js";
import type { CommandContext } from "../context.js";
import type { EngineKit } from "../daemon/engineKit.js";
import { cleanEnv } from "../job/cleanEnv.js";
import { loadRunnerKey } from "../keys.js";
import { MACOS_PREVIEW_NOTICE } from "../platformSupport.js";

const DAY_MS = 86_400_000;
const CLOUD_TIMEOUT_MS = 10_000;

/** What `doctor` needs from the machine. Only `bin/fx-runner.mjs` fills it in. */
export interface DoctorHost {
  platform: NodeJS.Platform;
  /** The names among `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` that are set in the shell. Names only: the values never enter the command. */
  shellVars: readonly string[];
  engine: Pick<EngineKit, "locate" | "inspect">;
}

type Level = "PASS" | "WARN" | "FAIL" | "INFO";

export async function doctorCommand(ctx: CommandContext, host: DoctorHost): Promise<number> {
  let failed = 0;
  const line = (level: Level, label: string, detail: string): void => {
    if (level === "FAIL") failed++;
    ctx.out(`${level.padEnd(4)}  ${`${label}:`.padEnd(19)}${detail}`);
  };

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
      // Any answer at all means the cloud is reachable; the status, headers and body are not read.
      const response = await ctx.fetchFn(`${registration.cloud_origin}/`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS) });
      await response.body?.cancel();
      line("PASS", "Cloud", `${registration.cloud_origin} answers`);
    } catch {
      // fx-swallow-ok: the point of the check is the yes or no; the error text may carry an address
      line("FAIL", "Cloud", `${registration.cloud_origin} is not reachable`);
    }
  }

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
    else if (mode !== "subscription") line("WARN", "Claude login", "unknown: api_key mode has no local key file yet, so there is nothing to check");
    else line("WARN", "Claude login", "unknown: the CLI did not answer `auth status`");
  }

  if (mode === "subscription") {
    if (host.shellVars.length === 0) line("PASS", "Shell variables", "no Anthropic key or token is set");
    for (const name of host.shellVars) line("WARN", "Shell variable", `${name} is set in this shell; it would outrank your Claude login. fx-runner removes it from jobs.`);
  }
  if (host.platform === "darwin") line("INFO", "macOS", MACOS_PREVIEW_NOTICE);

  ctx.out(failed === 0 ? "All checks passed." : `${failed} check${failed === 1 ? "" : "s"} failed.`);
  return failed === 0 ? 0 : 1;
}
