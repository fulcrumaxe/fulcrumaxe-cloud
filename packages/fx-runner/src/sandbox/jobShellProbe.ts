/**
 * D#6 C44-2: what the job's shell sees, as opposed to what the runner's own PATH holds.
 *
 * The agent CLI starts its Bash tool through the user's login shell, and the user's start-up files can reset PATH there (C44-1). This runs that
 * shell, inside the same sandbox rules a job gets, twice and with the clean environment:
 *  - plain, which is the shell as the user's files leave it;
 *  - with the per-job env file's lines run first thing in the command, which is what the CLI does after the shell has started (it reads the file
 *    on the host and puts the lines in front of the command, so the sandbox itself never needs to see the file).
 *
 * The home directory is hidden inside the sandbox, so the shell's own start-up files are laid back read-only, one file each (they are what the CLI's
 * login-shell snapshot carries into a job). Nothing else of the home directory is opened. No process is started here: the host does that.
 */
import path from "node:path";
import { printable } from "../commands/logs.js";
import { cacheRootsFor } from "../daemon/mirror.js";
import { SUBSCRIPTION_TOKEN_VAR, cleanEnv } from "../job/cleanEnv.js";
import { JobEnvFileRefused, jobEnvFileText } from "./jobEnvFile.js";
import { probeSettings, sandboxLaunch, type SandboxHost, type SandboxProbeInput } from "./probe.js";

/** The start-up files a login shell reads from the home directory. */
export const SHELL_STARTUP_FILES: readonly string[] = Object.freeze([".bash_profile", ".bash_login", ".profile", ".bashrc", ".zshenv", ".zprofile", ".zshrc", ".zlogin"]);

/** The one line the shell runs: it prints what it resolved and its PATH, one marked line each. */
export const JOB_SHELL_COMMAND = `printf 'fx-node=%s\\nfx-pnpm=%s\\nfx-path=%s\\n' "$(command -v node)" "$(command -v pnpm)" "$PATH"`;

const TIMEOUT_MS = 10_000;
const PATH_SHOWN_MAX = 300;

export interface JobShellSeen {
  node: string | undefined;
  pnpm: string | undefined;
  /** The PATH the shell had, cut and cleaned for display. */
  path: string | undefined;
}

/** One run: what the shell printed, or why it could not be run at all. */
export type JobShellRun = { ran: true; seen: JobShellSeen } | { ran: false; detail: string };

export interface JobShellResult {
  /** The shell as the user's start-up files leave it. */
  plain: JobShellRun;
  /** The same shell with the env file's lines run before the command. */
  withEnvFile: JobShellRun;
}

export interface JobShellInput extends SandboxProbeInput {
  /** The user's login shell, an absolute path. */
  shell: string;
  /** The env file's text (`jobEnvFileText`). */
  envFileText: string;
  /** The clean environment the shell starts with: no credential, `HOME`, `PATH`, `FX_RUNNER_JOB` and the rest of the job's names. */
  env: Record<string, string>;
}

function value(output: string, name: string): string | undefined {
  const prefix = `${name}=`;
  const found = output.split("\n").find((line) => line.startsWith(prefix));
  if (found === undefined) return undefined;
  const text = found.slice(prefix.length).trim();
  return text === "" ? undefined : text;
}

function parse(output: string): JobShellSeen {
  const shown = value(output, "fx-path");
  return { node: value(output, "fx-node"), pnpm: value(output, "fx-pnpm"), path: shown === undefined ? undefined : printable(shown, PATH_SHOWN_MAX) };
}

async function once(input: JobShellInput, command: string, host: SandboxHost): Promise<JobShellRun> {
  const settings = probeSettings(input);
  const files = SHELL_STARTUP_FILES.map((name) => path.join(input.home, name));
  const launch = sandboxLaunch(input, settings, input.env.PATH ?? "", [input.shell, "-l", "-c", command], host, files);
  if (!launch.ok) return { ran: false, detail: launch.result.ok ? "" : launch.result.detail };
  const outcome = await host.run(launch.tool, launch.args, input.env, TIMEOUT_MS);
  if (outcome.timedOut) return { ran: false, detail: "the login shell did not finish in 10 seconds" };
  const seen = parse(outcome.stdout);
  // A shell that printed nothing of ours and failed did not run: say that, rather than "node is missing". One that printed our lines but exited non-zero (a start-up file's
  // last command) is read as it is. A shell whose start-up file replaced it before our command ran prints nothing and exits 0: that is a finding, not a failure to run.
  if (seen.node === undefined && seen.pnpm === undefined && seen.path === undefined && outcome.code !== 0) return { ran: false, detail: outcome.code === null ? "the login shell could not be started" : "the login shell exited without running the check" };
  return { ran: true, seen };
}

/** Runs the check twice, in order: plain, then with the env file's lines in front. Never throws for what the machine does. */
export async function probeJobShell(input: JobShellInput, host: SandboxHost): Promise<JobShellResult> {
  const plain = await once(input, JOB_SHELL_COMMAND, host);
  const withEnvFile = await once(input, `${input.envFileText}${JOB_SHELL_COMMAND}`, host);
  return { plain, withEnvFile };
}

const NO_NODE = "node was not found";

/** What `doctor` knows about the machine for this check. */
export interface JobShellFacts {
  platform: NodeJS.Platform;
  home: string | undefined;
  /** The user's login shell, when the caller knows it. */
  shell: string | undefined;
  stateDir: string;
  binaryPath: string | undefined;
  xdgCacheHome?: string | undefined;
}

type Line = (level: "PASS" | "WARN" | "FAIL" | "INFO", label: string, detail: string) => void;

/** What one run found, in words. */
function runDetail(run: Extract<JobShellRun, { ran: true }>): string {
  const { node, pnpm } = run.seen;
  return node === undefined ? NO_NODE : `node found at ${node}${pnpm === undefined ? "; pnpm was not found" : ", pnpm found"}`;
}

/**
 * The `Job shell` lines for `doctor`: the login shell runs in the job's sandbox rules with the clean environment, once as the user's start-up files leave it
 * (node missing: WARN, the runner restores it) and once with the per-job env file's lines in front (node still missing: FAIL, with the PATH the shell had).
 * Only node decides; pnpm is shown. The shell never gets the subscription token, and TMPDIR is the probe's own temp directory as it is for a job.
 */
export async function checkJobShell(facts: JobShellFacts, host: SandboxHost, line: Line): Promise<void> {
  const label = "Job shell";
  const { home, shell } = facts;
  if (shell === undefined || !path.isAbsolute(shell)) return line("INFO", label, "not checked: the login shell is not known (no SHELL variable)");
  if (home === undefined || !path.isAbsolute(home)) return line("INFO", label, "not checked: the home directory is not known");
  const env = cleanEnv({ mode: "subscription" });
  delete env[SUBSCRIPTION_TOKEN_VAR];
  env.HOME = home;
  env.TMPDIR = path.join(cacheRootsFor({ home, platform: facts.platform, xdgCacheHome: facts.xdgCacheHome }).tempRoot, "fx-probe");
  let envFileText: string;
  try {
    envFileText = jobEnvFileText({ PATH: env.PATH, TMPDIR: env.TMPDIR });
  } catch (error) {
    if (!(error instanceof JobEnvFileRefused)) throw error;
    return line("FAIL", `${label} env`, "job_env_unsafe: the runner PATH holds a character the job's env file cannot carry, so jobs would refuse to start");
  }
  const binaryDir = facts.binaryPath === undefined ? path.join(facts.stateDir, "engine") : path.dirname(facts.binaryPath);
  const result = await probeJobShell({ platform: facts.platform, home, stateDir: facts.stateDir, binaryDir, xdgCacheHome: facts.xdgCacheHome, shell, envFileText, env }, host);
  if (!result.plain.ran) return line("WARN", label, `not checked: ${result.plain.detail}`);
  if (!result.withEnvFile.ran) return line("WARN", label, `not checked: ${result.withEnvFile.detail}`);
  if (result.plain.seen.node !== undefined) line("PASS", label, runDetail(result.plain));
  else line("WARN", label, "your shell start-up files reset PATH inside jobs; fx-runner restores it");
  if (result.withEnvFile.seen.node !== undefined) line("PASS", `${label} env`, `with the job's env file: ${runDetail(result.withEnvFile)}`);
  else line("FAIL", `${label} env`, `${NO_NODE} even with the job's env file; the job shell's PATH was ${result.withEnvFile.seen.path ?? "not reported (a start-up file replaced the shell)"}`);
}
