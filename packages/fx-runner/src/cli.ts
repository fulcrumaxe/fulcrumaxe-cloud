/**
 * The `fx-runner` command line. `runCli` takes everything it needs as arguments (the arguments, the two values read from
 * the shell by name, the streams, the clock and the network) and returns the exit code, so nothing here touches the
 * host environment; `bin/fx-runner.mjs` is the one place that reads it.
 */
import { CliError } from "./cliError.js";
import { stateDirFor } from "./config.js";
import type { CommandContext, Flags } from "./context.js";
import { attachCommand } from "./commands/attach.js";
import { claimingCommand, runnerSettingCommand, runnerUnsetCommand } from "./commands/claiming.js";
import { SETTING_KEYS } from "./runnerSettings.js";
import { registerCommand } from "./commands/register.js";
import { loadBypass, requireUsable } from "./protectionBypass.js";
import { credentialsCommand } from "./commands/credentials.js";
import { revokeCommand } from "./commands/revoke.js";
import { doctorCommand, type DoctorHost } from "./commands/doctor.js";
import { versionLine } from "./version.js";
import { logsCommand } from "./commands/logs.js";
import { runCommand, type RunHost } from "./commands/run.js";
import { serviceCommand, type ServiceHost } from "./commands/service.js";
import { statusCommand } from "./commands/status.js";
import { takeoverPaneCommand, watchCommand } from "./commands/watchPane.js";
import { configCommand, updateCommand } from "./commands/update.js";
import type { UpdateHost } from "./update/updater.js";

export interface CliIo {
  /** The arguments after the program name. */
  argv: readonly string[];
  /** The user's home directory, looked up by name by the caller. */
  home: string | undefined;
  /** `FX_RUNNER_HOME`, looked up by name by the caller: a state directory other than `~/.fx-runner`. */
  stateDirOverride?: string | undefined;
  /** `FX_RUNNER_PROTECTION_BYPASS_FILE`, looked up by name by the caller: a file holding the Vercel protection bypass secret (staging only). */
  protectionBypassFile?: string | undefined;
  /** The user id the process runs as, for the owner check on that file. */
  uid?: number | undefined;
  /** The platform and `XDG_CACHE_HOME`, looked up by name by the caller: where the runner's cache directories are, which that file must stay out of. */
  platform?: NodeJS.Platform | undefined;
  xdgCacheHome?: string | undefined;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  now?: () => Date;
  fetchFn?: typeof fetch;
  /** What `run` needs from the machine. Only `bin/fx-runner.mjs` supplies it. */
  host?: RunHost;
  /** What `doctor` needs from the machine. Only `bin/fx-runner.mjs` supplies it. */
  doctorHost?: DoctorHost;
  /** What `service` needs from the machine. Only `bin/fx-runner.mjs` supplies it. */
  serviceHost?: ServiceHost;
  /** What `update`, `config` and the daemon's self-update need from the machine. Only `bin/fx-runner.mjs` supplies it. */
  updateHost?: UpdateHost;
  /** Reads the API key from standard input (no echo on a terminal). Only `bin/fx-runner.mjs` supplies it. */
  readSecret?: () => Promise<string>;
}

const USAGE = `Usage: fx-runner <command> [options]

Commands:
  register --code <code> --credential-mode <subscription|api_key> --cloud-url <url>
                     Register this machine as a runner. The code comes from the workspace, works once and expires in 10 minutes.
  status             Show this machine's registration. Makes no network call.
  run                Claim and run jobs from the cloud on this machine until stopped (Ctrl-C).
  attach [<run|short id>|--latest] [--take-over]
                     List this machine's running jobs, or watch one read-only. --take-over stops the agent and hands the session to you.
  revoke [--reason <text>] [--local]
                     Revoke this runner and delete its key. --local only deletes the local files.
  doctor [--sandbox-only]
                     Check this machine: registration, cloud, the Claude CLI (version, flags, login) and shell variables. Makes no model request. --sandbox-only runs only the sandbox test.
  --version          Print the version.
  logs <run id>      Print the local transcript of a run on this machine.
  credentials set-api-key | clear-api-key | status
                     Store (from standard input only), remove or check the API key of an api_key runner. status prints "stored" or "not stored".
  service install | uninstall
                     Write (or remove) the per-user service file that keeps "fx-runner run" going: a systemd user unit on Linux, a launchd agent on macOS.
  update --check | --pin <version> | --unpin | --rollback
                     --check shows the current and the available version. --pin holds a version (installing it now, older ones included). --rollback returns to the kept previous version.
  config set auto-update on|off
                     Turn automatic updates, which happen between jobs only, on or off.
  config set concurrency.total <1-8> | concurrency.heavy <1-4> | reserve-gb <1-256|auto>
  config set budget.light.memory <1-8 GB> | budget.heavy.memory <2-32 GB> | budget.light.tasks | budget.heavy.tasks <64-65536>
  config unset concurrency.total | concurrency.heavy | reserve-gb | budget.<class>.memory | budget.<class>.tasks
                     Return a setting to its automatic default.
                     Lower the most jobs held at once, or set the memory kept free for your own work. A change applies from the next claim; running jobs are never stopped.
                     The budget is the hard limit one job runs under (memory and processes); a job past it is stopped on its own, others go on.
  pause | resume     Stop claiming new jobs (running ones finish), or start again. The runner stays registered and keeps its place.
`;

/** Which flags each command takes, and which of them are switches. */
const COMMANDS: Readonly<Record<string, { flags: readonly string[]; switches: readonly string[]; positionals?: number }>> = {
  register: { flags: ["code", "credential-mode", "cloud-url"], switches: [] },
  status: { flags: [], switches: [] },
  run: { flags: [], switches: [] },
  revoke: { flags: ["reason"], switches: ["local"] },
  attach: { flags: [], switches: ["take-over", "latest"], positionals: 1 },
  // The two commands a tmux pane runs; not in --help.
  __watch: { flags: [], switches: [], positionals: 1 },
  __takeover: { flags: [], switches: [], positionals: 1 },
  doctor: { flags: [], switches: ["sandbox-only"] },
  logs: { flags: [], switches: [], positionals: 1 },
  service: { flags: [], switches: [], positionals: 1 },
  update: { flags: ["pin"], switches: ["check", "unpin", "rollback"] },
  config: { flags: [], switches: [], positionals: 3 },
  pause: { flags: [], switches: [] },
  resume: { flags: [], switches: [] },
  credentials: { flags: [], switches: [] },
};

function parseFlags(command: string, rest: readonly string[]): { flags: Flags; positionals: string[] } {
  const spec = COMMANDS[command]!;
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) {
      if (positionals.length >= (spec.positionals ?? 0)) throw new CliError(`unexpected argument for ${command}`, 2);
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    const isSwitch = spec.switches.includes(name);
    if (!isSwitch && !spec.flags.includes(name)) throw new CliError(`unknown option --${name} for ${command}`, 2);
    if (flags.has(name)) throw new CliError(`--${name} was given twice`, 2);
    if (isSwitch) {
      if (eq !== -1) throw new CliError(`--${name} takes no value`, 2);
      flags.set(name, true);
    } else if (eq !== -1) {
      flags.set(name, arg.slice(eq + 1));
    } else {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--")) throw new CliError(`--${name} needs a value`, 2);
      flags.set(name, value);
      i++;
    }
  }
  return { flags, positionals };
}

export async function runCli(io: CliIo): Promise<number> {
  const [command, ...rest] = io.argv;
  try {
    if (command === "--version" || command === "-V") {
      io.stdout(`${versionLine()}\n`);
      return 0;
    }
    if (command === undefined || command === "--help" || command === "-h" || command === "help") {
      io.stdout(USAGE);
      return command === undefined ? 2 : 0;
    }
    if (!Object.hasOwn(COMMANDS, command)) throw new CliError(`unknown command ${command.slice(0, 40)}; run fx-runner --help`, 2);
    const parsed = command === "credentials" ? undefined : parseFlags(command, rest);
    const ctx: CommandContext = {
      stateDir: stateDirFor(io.home, io.stateDirOverride),
      out: (line) => io.stdout(`${line}\n`),
      err: (line) => io.stderr(`${line}\n`),
      now: io.now ?? (() => new Date()),
      fetchFn: io.fetchFn ?? fetch,
      bypass: loadBypass(io.protectionBypassFile, io.uid, { home: io.home, platform: io.platform ?? "linux", xdgCacheHome: io.xdgCacheHome }),
      bypassFile: io.protectionBypassFile,
      uid: io.uid,
    };
    // A bypass file that cannot be used stops a command that calls the cloud before any request; `doctor` reports it instead.
    if (command === "register" || command === "revoke" || command === "run") requireUsable(ctx.bypass);
    // Its words are never echoed or parsed as options: one of them could be a key typed in the wrong place.
    if (command === "credentials") return await credentialsCommand(rest, ctx, io.readSecret);
    const { flags, positionals } = parsed!;
    if (command === "register") return await registerCommand(flags, ctx);
    if (command === "revoke") return await revokeCommand(flags, ctx);
    if (command === "run") {
      if (io.host === undefined) throw new CliError("run is only available from the fx-runner program");
      return await runCommand(ctx, io.host, {}, io.updateHost);
    }
    if (command === "attach" || command === "__takeover" || command === "__watch") {
      if (io.host === undefined) throw new CliError(`${command} is only available from the fx-runner program`);
      // The run named on the command line travels with the flags, under the name the three commands read it by.
      const named: Flags = positionals[0] === undefined ? flags : new Map([...flags, ["run", positionals[0]]]);
      if (command === "attach") return await attachCommand(named, ctx, io.host);
      return command === "__watch" ? await watchCommand(named, ctx) : await takeoverPaneCommand(named, ctx, io.host);
    }
    if (command === "doctor") {
      if (io.doctorHost === undefined) throw new CliError("doctor is only available from the fx-runner program");
      return await doctorCommand(ctx, io.doctorHost, { sandboxOnly: flags.has("sandbox-only") });
    }
    if (command === "pause" || command === "resume") return claimingCommand(command, ctx);
    if (command === "config" && positionals[0] === "unset" && positionals[1] !== undefined && SETTING_KEYS.includes(positionals[1])) return runnerUnsetCommand(positionals[1], ctx);
    if (command === "config" && positionals[0] === "set" && positionals[1] !== undefined && SETTING_KEYS.includes(positionals[1])) return runnerSettingCommand(positionals[1], positionals[2], ctx);
    if (command === "update" || command === "config") {
      if (io.updateHost === undefined) throw new CliError(`${command} is only available from the fx-runner program`);
      return command === "update" ? await updateCommand(flags, ctx, io.updateHost) : configCommand(positionals, ctx, io.updateHost);
    }
    if (command === "logs") return logsCommand(positionals[0], ctx);
    if (command === "service") {
      if (io.serviceHost === undefined) throw new CliError("service is only available from the fx-runner program");
      return serviceCommand(positionals[0], ctx, io.serviceHost);
    }
    return await statusCommand(ctx);
  } catch (error) {
    if (error instanceof CliError) {
      io.stderr(`fx-runner: ${error.message}\n`);
      return error.exitCode;
    }
    // fx-swallow-ok: reported on stderr by class name and exit code 1; the message may carry a path or a value, so it is not shown
    // Anything else is a bug here.
    io.stderr(`fx-runner: unexpected ${error instanceof Error ? error.name : "failure"}\n`);
    return 1;
  }
}
