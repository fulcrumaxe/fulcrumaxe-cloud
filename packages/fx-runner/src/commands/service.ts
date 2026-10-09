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
 * The command the unit runs comes from the program's entry point as a list of absolute paths, plus the shell's PATH so the unit can
 * find the agent CLI. Every value that is written into the unit is restricted to a plain character set, so a path with a space, a
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

export const SYSTEMD_UNIT_NAME = "fx-runner.service";
export const LAUNCHD_LABEL = "dev.fulcrumaxe.fx-runner";
/** The first line of a file this command wrote (inside a comment, in both formats). */
export const SERVICE_MARKER = "Managed by fx-runner service install.";
/** Set to 1 in the unit: `run` then asks the service manager to start it again (exit 75) after it switched to a new version. */
export const SERVICE_ENV_NAME = "FX_RUNNER_SERVICE";

/** What `service` needs from the machine. Only `bin/fx-runner.mjs` fills it in. */
export interface ServiceHost {
  home: string | undefined;
  platform: NodeJS.Platform;
  /** `XDG_CONFIG_HOME`, looked up by name by the caller. */
  xdgConfigHome?: string | undefined;
  /** What the unit runs: the program's absolute path(s), then `run`. */
  command: readonly string[];
  /** The shell's PATH, looked up by name by the caller; its plain absolute entries go into the unit. */
  path: string | undefined;
  /** Where this program really is. When it is a file under `<state dir>/versions/`, the unit runs the stable path `<state dir>/bin/fx-runner` instead of `command`, so an update takes effect at the next restart. */
  execPath?: string | undefined;
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
}

export function renderSystemdUnit(input: UnitInput): string {
  const lines = [
    `# ${SERVICE_MARKER} Run it again to rewrite this file; fx-runner service uninstall removes it.`,
    "[Unit]",
    "Description=fulcrumaxe local runner",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${input.command.join(" ")}`,
  ];
  if (input.pathEntries.length > 0) lines.push(`Environment="PATH=${input.pathEntries.join(":")}"`);
  lines.push(`Environment="${SERVICE_ENV_NAME}=1"`);
  if (input.stateDir !== undefined) lines.push(`Environment="FX_RUNNER_HOME=${input.stateDir}"`);
  if (input.bypassFile !== undefined) lines.push(`Environment="${BYPASS_ENV_NAME}=${input.bypassFile}"`);
  lines.push("Restart=on-failure", "RestartSec=30", "TimeoutStopSec=20", "", "[Install]", "WantedBy=default.target", "");
  return lines.join("\n");
}

const xml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderLaunchdPlist(input: UnitInput): string {
  const env: string[] = [];
  if (input.pathEntries.length > 0) env.push(`    <key>PATH</key>\n    <string>${xml(input.pathEntries.join(":"))}</string>`);
  env.push(`    <key>${SERVICE_ENV_NAME}</key>\n    <string>1</string>`);
  if (input.stateDir !== undefined) env.push(`    <key>FX_RUNNER_HOME</key>\n    <string>${xml(input.stateDir)}</string>`);
  if (input.bypassFile !== undefined) env.push(`    <key>${BYPASS_ENV_NAME}</key>\n    <string>${xml(input.bypassFile)}</string>`);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<!-- ${SERVICE_MARKER} Run it again to rewrite this file; fx-runner service uninstall removes it. -->`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${LAUNCHD_LABEL}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...input.command.map((arg) => `    <string>${xml(arg)}</string>`),
    `  </array>`,
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

function targetFor(host: ServiceHost, home: string): Target {
  if (host.platform === "linux") {
    const config = host.xdgConfigHome !== undefined && path.isAbsolute(host.xdgConfigHome) ? host.xdgConfigHome : path.join(home, ".config");
    return {
      file: path.join(config, "systemd", "user", SYSTEMD_UNIT_NAME),
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

export function serviceCommand(action: string | undefined, ctx: CommandContext, host: ServiceHost): number {
  if (action !== "install" && action !== "uninstall") throw new CliError("usage: fx-runner service install | uninstall", 2);
  const home = host.home;
  if (home === undefined || !path.isAbsolute(home)) throw new CliError("cannot find your home directory");
  const target = targetFor(host, home);
  const existing = inspectExisting(target.file);
  if (existing.kind === "foreign") throw new CliError(`service_unit_foreign: ${target.file} was not written by fx-runner, so it is left alone`);

  if (action === "uninstall") {
    if (existing.kind === "none") {
      ctx.out("Not installed: there is no service file to remove.");
      return 0;
    }
    rmSync(target.file);
    ctx.out(`Removed ${target.file}`);
    ctx.out("If it is running, stop it with:");
    for (const step of target.stop) ctx.out(`  ${step}`);
    return 0;
  }

  const chosen = serviceCommandFor(host, ctx.stateDir);
  if (chosen.length < 2 || chosen[chosen.length - 1] !== "run") throw new CliError("service_path_unsupported: the service command must end with run");
  const command = chosen.map((arg, i) => (i === chosen.length - 1 ? arg : plainPath(arg, "the command the service runs")));
  const stateDir = ctx.stateDir === path.join(home, STATE_DIR_NAME) ? undefined : plainPath(ctx.stateDir, "the state directory");
  const bypassFile = ctx.bypassFile === undefined || ctx.bypassFile === "" ? undefined : plainPath(ctx.bypassFile, BYPASS_ENV_NAME);
  const pathEntries = (host.path ?? "").split(":").filter((entry) => path.isAbsolute(entry) && PLAIN.test(entry));
  const text = target.render({ command, pathEntries, ...(stateDir === undefined ? {} : { stateDir }), ...(bypassFile === undefined ? {} : { bypassFile }), logFile: path.join(ctx.stateDir, "service.log") });

  if (existing.kind === "ours" && existing.text === text) {
    ctx.out(`Already installed: ${target.file} is up to date.`);
  } else {
    mkdirSync(path.dirname(target.file), { recursive: true });
    const temp = `${target.file}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(temp, text, { flag: "wx", mode: 0o644 });
      renameSync(temp, target.file);
    } finally {
      rmSync(temp, { force: true });
    }
    ctx.out(`${existing.kind === "ours" ? "Updated" : "Wrote"} ${target.file}`);
  }
  ctx.out("It runs one instance for this user: fx-runner run. Start it now, and at every login, with:");
  for (const step of target.start) ctx.out(`  ${step}`);
  if (!loadRegistration(ctx.stateDir)) ctx.out("This machine is not registered yet; run: fx-runner register --code <code> --credential-mode <mode> --cloud-url <url>");
  if (host.platform === "darwin") ctx.out(MACOS_PREVIEW_NOTICE);
  return 0;
}
