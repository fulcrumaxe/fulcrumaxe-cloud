/**
 * The `fx-runner` command line. `runCli` takes everything it needs as arguments (the arguments, the two values read from
 * the shell by name, the streams, the clock and the network) and returns the exit code, so nothing here touches the
 * host environment; `bin/fx-runner.mjs` is the one place that reads it.
 */
import { CliError } from "./cliError.js";
import { stateDirFor } from "./config.js";
import type { CommandContext, Flags } from "./context.js";
import { registerCommand } from "./commands/register.js";
import { revokeCommand } from "./commands/revoke.js";
import { doctorCommand, type DoctorHost } from "./commands/doctor.js";
import { logsCommand } from "./commands/logs.js";
import { runCommand, type RunHost } from "./commands/run.js";
import { serviceCommand, type ServiceHost } from "./commands/service.js";
import { statusCommand } from "./commands/status.js";

export interface CliIo {
  /** The arguments after the program name. */
  argv: readonly string[];
  /** The user's home directory, looked up by name by the caller. */
  home: string | undefined;
  /** `FX_RUNNER_HOME`, looked up by name by the caller: a state directory other than `~/.fx-runner`. */
  stateDirOverride?: string | undefined;
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
}

const USAGE = `Usage: fx-runner <command> [options]

Commands:
  register --code <code> --credential-mode <subscription|api_key> --cloud-url <url>
                     Register this machine as a runner. The code comes from the workspace, works once and expires in 10 minutes.
  status             Show this machine's registration. Makes no network call.
  run                Claim and run jobs from the cloud on this machine until stopped (Ctrl-C).
  revoke [--reason <text>] [--local]
                     Revoke this runner and delete its key. --local only deletes the local files.
  doctor             Check this machine: registration, cloud, the Claude CLI (version, flags, login) and shell variables. Makes no model request.
  logs <run id>      Print the local transcript of a run on this machine.
  service install | uninstall
                     Write (or remove) the per-user service file that keeps "fx-runner run" going: a systemd user unit on Linux, a launchd agent on macOS.
`;

/** Which flags each command takes, and which of them are switches. */
const COMMANDS: Readonly<Record<string, { flags: readonly string[]; switches: readonly string[]; positionals?: number }>> = {
  register: { flags: ["code", "credential-mode", "cloud-url"], switches: [] },
  status: { flags: [], switches: [] },
  run: { flags: [], switches: [] },
  revoke: { flags: ["reason"], switches: ["local"] },
  doctor: { flags: [], switches: [] },
  logs: { flags: [], switches: [], positionals: 1 },
  service: { flags: [], switches: [], positionals: 1 },
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
    if (command === undefined || command === "--help" || command === "-h" || command === "help") {
      io.stdout(USAGE);
      return command === undefined ? 2 : 0;
    }
    if (!Object.hasOwn(COMMANDS, command)) throw new CliError(`unknown command ${command.slice(0, 40)}; run fx-runner --help`, 2);
    const { flags, positionals } = parseFlags(command, rest);
    const ctx: CommandContext = {
      stateDir: stateDirFor(io.home, io.stateDirOverride),
      out: (line) => io.stdout(`${line}\n`),
      err: (line) => io.stderr(`${line}\n`),
      now: io.now ?? (() => new Date()),
      fetchFn: io.fetchFn ?? fetch,
    };
    if (command === "register") return await registerCommand(flags, ctx);
    if (command === "revoke") return await revokeCommand(flags, ctx);
    if (command === "run") {
      if (io.host === undefined) throw new CliError("run is only available from the fx-runner program");
      return await runCommand(ctx, io.host);
    }
    if (command === "doctor") {
      if (io.doctorHost === undefined) throw new CliError("doctor is only available from the fx-runner program");
      return await doctorCommand(ctx, io.doctorHost);
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
