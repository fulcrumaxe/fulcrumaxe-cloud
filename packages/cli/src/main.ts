import { parseCommandLine, type Parsed } from "./args.js";
import { logout, profiles, whoami } from "./commands/account.js";
import { login } from "./commands/login.js";
import { readCommand } from "./commands/read.js";
import type { Io } from "./context.js";
import { CliExit, EXIT, EXIT_TABLE, usage } from "./errors.js";
import { Output } from "./output.js";

const HELP = `fx (fulcrumaxe): your account from a terminal

  fx login [--profile p] [--base-url url]   read a token from standard input (never from an argument) and save it for that origin
  fx logout [--profile p] [--all]           forget the saved token on this machine (it does not revoke it)
  fx whoami [--profile p]                   show the account the token belongs to
  fx profiles                               list profiles

  fx runs list | show <id>                  runs, with their work item's title
  fx work-items list | show <id> | timeline <id>
  fx discussions list | show <id> | comments <id>
  fx repos list | show <id>
  fx webhooks list | show <id> | deliveries <id>
  fx usage                                  spend this month against the limits
  fx budgets                                the monthly limits for your plan
  Lists show one page: --limit n sets its size, --all follows every page.
  Changing things (webhooks add, sites, runs retry, work-items approve|close|reopen|respec, budgets set, tokens) is not available to a token: those
  commands print a workspace link and exit 6 without sending anything.

Options: --json (one {"v":1,...} envelope on stdout), --debug (method, path, status and timing on stderr; the token is redacted), --help
Environment: FX_TOKEN (CI), FX_BASE_URL, FX_PROFILE, XDG_CONFIG_HOME

Exit codes:
${EXIT_TABLE.map(([code, meaning]) => `  ${String(code).padStart(2)}  ${meaning}`).join("\n")}
`;

async function run(io: Io, out: Output, args: Parsed): Promise<void> {
  switch (args.command) {
    case "login":
      return login(io, out, args);
    case "logout":
      return logout(io, out, args);
    case "whoami":
      return whoami(io, out, args);
    case "profiles":
      return profiles(io, out);
    default:
      if (await readCommand(io, out, args)) return;
      throw usage(args.command === undefined ? "no command given: see `fx --help`" : "unknown command: see `fx --help`");
  }
}

/** Runs one command line and returns its exit code. Nothing is thrown: every failure is reported through `Output`, which scrubs it. */
export async function main(argv: readonly string[], io: Io): Promise<number> {
  const out = new Output(io, argv.includes("--json"), argv.includes("--debug"));
  try {
    const args = parseCommandLine(argv);
    if (args.help || args.command === "help") {
      io.stdout.write(HELP);
      return EXIT.ok;
    }
    await run(io, out, args);
    return EXIT.ok;
  } catch (e) {
    // fx-swallow-ok: reported through Output (scrubbed) and turned into the exit code
    const failure = e instanceof CliExit ? e : new CliExit(EXIT.unexpected, "unexpected", "unexpected error: run again with --debug for details");
    if (!(e instanceof CliExit)) out.trace(String(e instanceof Error ? (e.stack ?? e.message) : e));
    out.failure(failure);
    return failure.exit;
  }
}
