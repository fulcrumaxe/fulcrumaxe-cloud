/**
 * `fx-runner service install | uninstall` (D#6 R4a-4): writes, or removes, the per-user unit that keeps `fx-runner run` going: a systemd
 * user unit on Linux, a launchd agent on macOS. It only writes the file and prints the command that starts it; it starts no
 * program itself, so nothing is installed into the service manager until the user runs that command.
 *
 * One instance per user: the unit has one fixed name (no template, no per-state-directory name), so a second `install` rewrites
 * the same file instead of adding another, and `run` itself refuses a second copy on the same state directory. `install` is
 * idempotent (the same file again changes nothing), and a file at the unit's path that this command did not write (no marker line,
 * or a link) is never overwritten or removed.
 *
 * `--system --user <account>` (D#605 FL-7) writes a system service instead: a systemd system unit in /etc/systemd/system, or a
 * LaunchDaemon in /Library/LaunchDaemons, so the runner starts at boot with nobody logged in. It runs as the dedicated non-root account
 * `--user` names (never root, never a default), with `NoNewPrivileges=yes`, `ProtectSystem=strict` and `ProtectHome=yes` on Linux, so
 * its one writable place is its own state directory outside /home, and with `UserName` on macOS. A system service cannot see /home
 * or /root, so a program path there is refused rather than written into a unit that could never start.
 *
 * The command the unit runs comes from the program's entry point as a list of absolute paths. A per-user unit also gets the shell's PATH
 * so it can find the agent CLI; a system service never inherits the installing environment's PATH (it gets a fixed one), and the program
 * it runs, with every directory above it, must not be writable by a group or by everyone, or whoever can write there would run code as the
 * service account. Every value that is written into the unit is restricted to a plain character set, so a path with a space, a
 * quote, `%` or `$` is refused instead of escaped.
 */
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliError } from "../cliError.js";
import { STATE_DIR_NAME, loadRegistration } from "../config.js";
import type { CommandContext } from "../context.js";
import { MACOS_PREVIEW_NOTICE } from "../platformSupport.js";
import { BYPASS_ENV_NAME } from "../protectionBypass.js";
import { cacheRootsFor } from "../daemon/mirror.js";
import { daemonDirOf } from "../launchDir.js";

export const SYSTEMD_UNIT_NAME = "fx-runner.service";
export const LAUNCHD_LABEL = "dev.fulcrumaxe.fx-runner";
/** The first line of a file this command wrote (inside a comment, in both formats). */
export const SERVICE_MARKER = "Managed by fx-runner service install.";
/** Set to 1 in the unit: `run` then asks the service manager to start it again (exit 75) after it switched to a new version. */
export const SERVICE_ENV_NAME = "FX_RUNNER_SERVICE";

/** The state directory of a system service: outside /home (which `ProtectHome=yes` hides) and owned by the service account. It is also that service's HOME. */
export const SYSTEM_STATE_DIR = { linux: "/var/lib/fx-runner", darwin: "/usr/local/var/fx-runner" } as const;
/** The name under /var/lib that systemd creates for the unit (`StateDirectory=`); the last part of `SYSTEM_STATE_DIR.linux`. */
export const SYSTEMD_STATE_DIRECTORY = "fx-runner";
const ACCOUNT = /^[a-z_][a-z0-9_-]{0,31}$/;
/** What `ProtectHome=yes` hides from a system service. */
const HIDDEN_FROM_SERVICE = /^\/(home|root|run\/user)(\/|$)/;
/** The PATH of every system service: fixed, never the installing person's. The last entry is where the program itself is installed. */
export const SYSTEM_PATH_ENTRIES: readonly string[] = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin", "/opt/fx-runner/bin"];
/** Where a macOS system service's output goes: a root-owned directory, not the account-owned state directory (the account could otherwise plant a link there). */
export const SYSTEM_LOG_DIR_DARWIN = "/Library/Logs/fx-runner";

/** What `service` needs from the machine. Only `bin/fx-runner.mjs` fills it in. */
export interface ServiceHost {
  home: string | undefined;
  platform: NodeJS.Platform;
  /** `XDG_CONFIG_HOME`, looked up by name by the caller. */
  xdgConfigHome?: string | undefined;
  /** `XDG_CACHE_HOME`, looked up by name by the caller: where a per-user service's working directory is (`<cache>/fx-runner/launch/daemon`). */
  xdgCacheHome?: string | undefined;
  /** What the unit runs: the program's absolute path(s), then `run`. */
  command: readonly string[];
  /** The shell's PATH, looked up by name by the caller; its plain absolute entries go into the unit. */
  path: string | undefined;
  /** Where this program really is. When it is a file under `<state dir>/versions/`, the unit runs the stable path `<state dir>/bin/fx-runner` instead of `command`, so an update takes effect at the next restart. */
  execPath?: string | undefined;
  /** Where the system service files go: `/` unless a test points it at a throwaway directory. */
  root?: string | undefined;
  /** The text of /etc/passwd, read by the caller, to check that the service account exists and is not root. Without it `--system` on Linux refuses. */
  passwd?: (() => string | undefined) | undefined;
  /** What `lstat` says about one path (its mode bits and whether it is a link), or undefined when it cannot be read. Without it `--system` refuses: the program's directories cannot be checked. */
  lstat?: ((file: string) => { mode: number; isSymbolicLink: boolean } | undefined) | undefined;
  /** macOS only: the user id of a local account (`dscl . -read /Users/<name> UniqueID`, fixed arguments), null when there is no such account, undefined when the lookup itself failed. */
  accountUid?: ((name: string) => number | null | undefined) | undefined;
}

/** What the caller asked for beyond the per-user default. */
export interface ServiceOptions {
  system: boolean;
  /** The account a system service runs as. */
  user?: string | undefined;
}

/** `[<state dir>/bin/fx-runner, "run"]` when the running program is an installed version; otherwise the command the entry point gave. */
export function serviceCommandFor(host: ServiceHost, stateDir: string): readonly string[] {
  const versions = path.join(stateDir, "versions") + path.sep;
  return host.execPath !== undefined && path.resolve(host.execPath).startsWith(versions) ? [path.join(stateDir, "bin", "fx-runner"), "run"] : host.command;
}

const PLAIN = /^[A-Za-z0-9_.\/@+=-]+$/;

function plainPath(value: string, what: string): string {
  if (!path.isAbsolute(value) || !PLAIN.test(value)) throw new CliError(`service_path_unsupported: ${what} must be an absolute path made only of letters, digits and _ . / @ + = -`);
  return value;
}

export interface UnitInput {
  command: readonly string[];
  /** Absolute, plain PATH entries; empty leaves PATH to the service manager. */
  pathEntries: readonly string[];
  /** Set when the state directory is not the default `~/.fx-runner`. */
  stateDir?: string;
  /** Set when `FX_RUNNER_PROTECTION_BYPASS_FILE` is set: the PATH of the file, never its content. */
  bypassFile?: string;
  /** Where `run`'s output goes (launchd only; systemd uses the journal). */
  logFile: string;
  /** Set for a system service: the account it runs as. `stateDir` is then always set, and is also the service's HOME. */
  system?: { user: string };
  /**
   * D#6 RUNNER-CWD-1: the service's working directory, the runner's own empty `<launch root>/daemon`, never the home directory the service manager
   * would use otherwise. The agent CLI writes placeholder files into the directory it starts in; `run` changes there itself too, before it starts anything.
   */
  workingDirectory: string;
}

export function renderSystemdUnit(input: UnitInput): string {
  const system = input.system;
  const lines = [
    `# ${SERVICE_MARKER} Run it again to rewrite this file; fx-runner service uninstall${system === undefined ? "" : " --system"} removes it.`,
    "[Unit]",
    "Description=fulcrumaxe local runner",
    ...(system === undefined ? [] : ["After=network-online.target", "Wants=network-online.target"]),
    "",
    "[Service]",
    "Type=simple",
    ...(system === undefined ? [] : [`User=${system.user}`]),
    `ExecStart=${input.command.join(" ")}`,
    // `-`: a directory that is not there yet is not an error; `run` makes it and changes into it before it starts anything.
    `WorkingDirectory=-${input.workingDirectory}`,
  ];
  if (input.pathEntries.length > 0) lines.push(`Environment="PATH=${input.pathEntries.join(":")}"`);
  lines.push(`Environment="${SERVICE_ENV_NAME}=1"`);
  if (system !== undefined && input.stateDir !== undefined) lines.push(`Environment="HOME=${input.stateDir}"`);
  if (input.stateDir !== undefined) lines.push(`Environment="FX_RUNNER_HOME=${input.stateDir}"`);
  if (input.bypassFile !== undefined) lines.push(`Environment="${BYPASS_ENV_NAME}=${input.bypassFile}"`);
  // The one writable place is the account's own state directory: systemd creates it owned by the account, and everything else is read-only.
  if (system !== undefined) lines.push(`StateDirectory=${SYSTEMD_STATE_DIRECTORY}`, "StateDirectoryMode=0700", "NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=yes", "PrivateTmp=yes");
  lines.push("Restart=on-failure", "RestartSec=30", "TimeoutStopSec=20", "", "[Install]", `WantedBy=${system === undefined ? "default.target" : "multi-user.target"}`, "");
  return lines.join("\n");
}

const xml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderLaunchdPlist(input: UnitInput): string {
  const env: string[] = [];
  if (input.system !== undefined && input.stateDir !== undefined) env.push(`    <key>HOME</key>\n    <string>${xml(input.stateDir)}</string>`);
  if (input.pathEntries.length > 0) env.push(`    <key>PATH</key>\n    <string>${xml(input.pathEntries.join(":"))}</string>`);
  env.push(`    <key>${SERVICE_ENV_NAME}</key>\n    <string>1</string>`);
  if (input.stateDir !== undefined) env.push(`    <key>FX_RUNNER_HOME</key>\n    <string>${xml(input.stateDir)}</string>`);
  if (input.bypassFile !== undefined) env.push(`    <key>${BYPASS_ENV_NAME}</key>\n    <string>${xml(input.bypassFile)}</string>`);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<!-- ${SERVICE_MARKER} Run it again to rewrite this file; fx-runner service uninstall${input.system === undefined ? "" : " --system"} removes it. -->`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${LAUNCHD_LABEL}</string>`,
    ...(input.system === undefined ? [] : [`  <key>UserName</key>`, `  <string>${xml(input.system.user)}</string>`]),
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...input.command.map((arg) => `    <string>${xml(arg)}</string>`),
    `  </array>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${xml(input.workingDirectory)}</string>`,
    ...(env.length === 0 ? [] : [`  <key>EnvironmentVariables</key>`, `  <dict>`, ...env, `  </dict>`]),
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <dict>`,
    `    <key>SuccessfulExit</key>`,
    `    <false/>`,
    `  </dict>`,
    `  <key>ThrottleInterval</key>`,
    `  <integer>30</integer>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${xml(input.logFile)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${xml(input.logFile)}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

interface Target {
  file: string;
  render: (input: UnitInput) => string;
  start: string[];
  stop: string[];
}

/** The per-user unit file's path on Linux (the one `doctor` looks for when it checks lingering). */
export function userUnitPath(home: string, xdgConfigHome: string | undefined): string {
  const config = xdgConfigHome !== undefined && path.isAbsolute(xdgConfigHome) ? xdgConfigHome : path.join(home, ".config");
  return path.join(config, "systemd", "user", SYSTEMD_UNIT_NAME);
}

function targetFor(host: ServiceHost, home: string): Target {
  if (host.platform === "linux") {
    return {
      file: userUnitPath(home, host.xdgConfigHome),
      render: renderSystemdUnit,
      start: ["systemctl --user daemon-reload", `systemctl --user enable --now ${SYSTEMD_UNIT_NAME}`],
      stop: [`systemctl --user disable --now ${SYSTEMD_UNIT_NAME}`, "systemctl --user daemon-reload"],
    };
  }
  if (host.platform === "darwin") {
    const file = path.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    return { file, render: renderLaunchdPlist, start: [`launchctl bootstrap gui/$(id -u) "${file}"`], stop: [`launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL}`] };
  }
  throw new CliError("service_unsupported: a service can be installed on Linux (systemd) and macOS (launchd) only; Windows, including WSL2, is not supported yet");
}

/** The system service's file (under `host.root`) and the commands the person runs; nothing here depends on a home directory. */
function systemTargetFor(host: ServiceHost): Target {
  const root = host.root ?? "/";
  if (host.platform === "linux") {
    return {
      file: path.join(root, "etc", "systemd", "system", SYSTEMD_UNIT_NAME),
      render: renderSystemdUnit,
      start: ["systemctl daemon-reload", `systemctl enable --now ${SYSTEMD_UNIT_NAME}`],
      stop: [`systemctl disable --now ${SYSTEMD_UNIT_NAME}`, "systemctl daemon-reload"],
    };
  }
  if (host.platform === "darwin") {
    const file = path.join(root, "Library", "LaunchDaemons", `${LAUNCHD_LABEL}.plist`);
    return { file, render: renderLaunchdPlist, start: [`launchctl bootstrap system "${file}"`], stop: [`launchctl bootout system/${LAUNCHD_LABEL}`] };
  }
  throw new CliError("service_unsupported: a service can be installed on Linux (systemd) and macOS (launchd) only; Windows, including WSL2, is not supported yet");
}

/** Refuses an account that is not a dedicated, existing, non-root user. The name is only ever written into the unit after this. */
function checkAccount(host: ServiceHost, user: string | undefined): string {
  if (user === undefined || user === "") {
    throw new CliError("service_user_required: --system needs --user <account>, the dedicated non-root account the service runs as (it is never root and never the account you run this as by default)", 2);
  }
  if (!ACCOUNT.test(user)) throw new CliError("service_user_invalid: --user must be a plain account name (lowercase letters, digits, _ and -)", 2);
  if (user === "root") throw new CliError("service_user_root: the service must not run as root; give a dedicated non-root account", 2);
  const hint = `create it first, for example: useradd --system --home-dir ${SYSTEM_STATE_DIR.linux} --no-create-home --shell /usr/sbin/nologin ${user}`;
  if (host.platform === "linux") {
    const passwd = host.passwd?.();
    if (passwd === undefined) throw new CliError("service_user_unchecked: the account list could not be read, so the account cannot be checked");
    const entry = passwd.split("\n").map((line) => line.split(":")).find((fields) => fields[0] === user);
    if (entry === undefined) throw new CliError(`service_user_unknown: there is no account named ${user} on this machine; ${hint}`);
    if (Number(entry[2]) === 0) throw new CliError(`service_user_root: ${user} has user id 0; the service must not run as root`, 2);
  } else if (host.platform === "darwin") {
    const uid = host.accountUid?.(user);
    if (uid === undefined) throw new CliError("service_user_unchecked: the account could not be looked up, so the account cannot be checked");
    if (uid === null) throw new CliError(`service_user_unknown: there is no account named ${user} on this machine; create it first (for example with sysadminctl)`);
    if (uid === 0) throw new CliError(`service_user_root: ${user} has user id 0; the service must not run as root`, 2);
  }
  return user;
}

/** Refuses a program that a group or everyone can replace: the file and each directory above it must be readable, not links, and not group- or world-writable. */
function checkProgramLocation(host: ServiceHost, programs: readonly string[]): void {
  if (host.lstat === undefined) throw new CliError("service_program_unchecked: the program's location could not be checked, so a system service is not written");
  const checked = new Set<string>();
  for (const program of programs) {
    for (let current = program; ; current = path.dirname(current)) {
      if (!checked.has(current)) {
        checked.add(current);
        const info = host.lstat(current);
        if (info === undefined) throw new CliError(`service_program_unchecked: ${current} could not be examined, so a system service is not written`);
        if (info.isSymbolicLink) throw new CliError(`service_program_unsafe: ${current} is a link; name the real path of the program so every directory above it can be checked`);
        if ((info.mode & 0o022) !== 0) throw new CliError(`service_program_unsafe: ${current} can be changed by a group or by everyone, and the service would run what is in it; install fx-runner in a directory only root can write (for example /opt/fx-runner)`);
      }
      if (path.dirname(current) === current) break;
    }
  }
}

type Existing = { kind: "none" } | { kind: "ours"; text: string } | { kind: "foreign" };

function inspectExisting(file: string): Existing {
  let info;
  try {
    info = lstatSync(file);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return { kind: "none" };
    throw new CliError("cannot read the service file's location");
  }
  if (!info.isFile()) return { kind: "foreign" };
  const text = readFileSync(file, "utf8");
  // The marker is the file's first line (systemd) or sits right after the XML declaration and doctype (launchd): the first three lines.
  return text.split("\n", 3).some((first) => first.includes(SERVICE_MARKER)) ? { kind: "ours", text } : { kind: "foreign" };
}

/** True when a per-user unit written by this command is at the per-user path. `doctor` uses it to decide whether lingering matters. */
export function userUnitInstalled(home: string, xdgConfigHome: string | undefined): boolean {
  return inspectExisting(userUnitPath(home, xdgConfigHome)).kind === "ours";
}

/** Writing under /etc or /Library needs root; say so instead of showing a bare permission error. */
function rootError(error: unknown, file: string): unknown {
  const code = (error as { code?: string }).code;
  return code === "EACCES" || code === "EPERM" ? new CliError(`service_needs_root: ${file} cannot be changed by this user; run the same command with sudo`) : error;
}

export function serviceCommand(action: string | undefined, ctx: CommandContext, host: ServiceHost, options: ServiceOptions = { system: false }): number {
  if (action !== "install" && action !== "uninstall") throw new CliError("usage: fx-runner service install | uninstall [--system --user <account>]", 2);
  const system = options.system;
  const home = host.home;
  if (!system && (home === undefined || !path.isAbsolute(home))) throw new CliError("cannot find your home directory");
  // A system service has no home directory of its own: its state directory is the fixed one below, whoever runs this command.
  const target = system ? systemTargetFor(host) : targetFor(host, home!);
  const existing = inspectExisting(target.file);
  if (existing.kind === "foreign") throw new CliError(`service_unit_foreign: ${target.file} was not written by fx-runner, so it is left alone`);

  if (action === "uninstall") {
    if (existing.kind === "none") {
      ctx.out("Not installed: there is no service file to remove.");
      return 0;
    }
    try {
      rmSync(target.file);
    } catch (error) {
      throw rootError(error, target.file);
    }
    ctx.out(`Removed ${target.file}`);
    ctx.out("If it is running, stop it with:");
    for (const step of target.stop) ctx.out(`  ${step}`);
    return 0;
  }

  const account = system ? checkAccount(host, options.user) : undefined;
  const stateRoot = system ? (host.platform === "darwin" ? SYSTEM_STATE_DIR.darwin : SYSTEM_STATE_DIR.linux) : ctx.stateDir;
  // A system service runs the program as it is: the stable `<state dir>/bin` path belongs to the person who runs this, under their home.
  const chosen = system ? host.command : serviceCommandFor(host, ctx.stateDir);
  if (chosen.length < 2 || chosen[chosen.length - 1] !== "run") throw new CliError("service_path_unsupported: the service command must end with run");
  const command = chosen.map((arg, i) => (i === chosen.length - 1 ? arg : plainPath(arg, "the command the service runs")));
  if (system) {
    const hidden = command.slice(0, -1).find((arg) => HIDDEN_FROM_SERVICE.test(arg));
    if (hidden !== undefined) {
      throw new CliError(`service_path_unsupported: a system service cannot see /home or /root, and ${hidden} is there; install fx-runner somewhere shared (for example /opt/fx-runner), then run service install --system from there`);
    }
    checkProgramLocation(host, command.slice(0, -1));
  }
  const stateDir = system ? stateRoot : ctx.stateDir === path.join(home!, STATE_DIR_NAME) ? undefined : plainPath(ctx.stateDir, "the state directory");
  const bypassFile = ctx.bypassFile === undefined || ctx.bypassFile === "" ? undefined : plainPath(ctx.bypassFile, BYPASS_ENV_NAME);
  if (system && bypassFile !== undefined && HIDDEN_FROM_SERVICE.test(bypassFile)) {
    throw new CliError(`service_path_unsupported: ${BYPASS_ENV_NAME} names a file under /home or /root, which a system service cannot see; move the file out of there`);
  }
  // A system service gets a fixed PATH: the installing person's (often sudo's, or one with a user-writable directory in it) is not inherited.
  const pathEntries = system ? SYSTEM_PATH_ENTRIES : (host.path ?? "").split(":").filter((entry) => path.isAbsolute(entry) && PLAIN.test(entry));
  // The service's working directory: under the launch root of the HOME the service runs with (the state directory for a system service).
  const workingDirectory = plainPath(daemonDirOf(cacheRootsFor({ home: system ? stateRoot : home!, platform: host.platform, xdgCacheHome: system ? undefined : host.xdgCacheHome }).launchRoot), "the service's working directory");
  const text = target.render({
    workingDirectory,
    command,
    pathEntries,
    ...(stateDir === undefined ? {} : { stateDir }),
    ...(bypassFile === undefined ? {} : { bypassFile }),
    logFile: system && host.platform === "darwin" ? path.posix.join(SYSTEM_LOG_DIR_DARWIN, "service.log") : path.join(stateRoot, "service.log"),
    ...(account === undefined ? {} : { system: { user: account } }),
  });

  // A per-user service's working directory is made now (0700, owned by this user), so launchd can change into it at the first start.
  if (!system) mkdirSync(workingDirectory, { recursive: true, mode: 0o700 });
  if (existing.kind === "ours" && existing.text === text) {
    ctx.out(`Already installed: ${target.file} is up to date.`);
  } else {
    try {
      mkdirSync(path.dirname(target.file), { recursive: true });
      const temp = `${target.file}.${randomBytes(8).toString("hex")}.tmp`;
      try {
        writeFileSync(temp, text, { flag: "wx", mode: 0o644 });
        renameSync(temp, target.file);
      } finally {
        rmSync(temp, { force: true });
      }
    } catch (error) {
      throw rootError(error, target.file);
    }
    ctx.out(`${existing.kind === "ours" ? "Updated" : "Wrote"} ${target.file}`);
  }
  if (system) {
    const darwin = host.platform === "darwin";
    ctx.out(`It runs one instance as ${account}, with its files in ${stateRoot}, and starts at boot. Nothing is started yet. Create the state directory, register as ${account}, then start it:`);
    ctx.out(`  install -d -m 0700 -o ${account} ${stateRoot}`);
    if (darwin) ctx.out(`  install -d -m 0755 -o root -g wheel ${SYSTEM_LOG_DIR_DARWIN}`);
    if (darwin) ctx.out(`  install -d -m 0700 -o ${account} ${workingDirectory}`);
    ctx.out(`  sudo -u ${account} env FX_RUNNER_HOME=${stateRoot} fx-runner register --code-stdin --credential-mode <mode> --cloud-url <url>`);
    for (const step of target.start) ctx.out(`  ${step}`);
    if (darwin) ctx.out(MACOS_PREVIEW_NOTICE);
    return 0;
  }
  ctx.out("It runs one instance for this user: fx-runner run. Start it now, and at every login, with:");
  for (const step of target.start) ctx.out(`  ${step}`);
  if (!loadRegistration(ctx.stateDir)) ctx.out("This machine is not registered yet; run: fx-runner register --code-stdin --credential-mode <mode> --cloud-url <url>");
  if (host.platform === "darwin") ctx.out(MACOS_PREVIEW_NOTICE);
  return 0;
}
