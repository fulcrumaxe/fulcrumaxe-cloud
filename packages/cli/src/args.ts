import { parseArgs } from "node:util";
import { CliExit, usage } from "./errors.js";

export interface Parsed {
  command: string | undefined;
  rest: string[];
  profile: string | undefined;
  baseUrl: string | undefined;
  json: boolean;
  debug: boolean;
  help: boolean;
  all: boolean;
  /** Page size / item cap for list commands; undefined means the server's default. */
  limit: number | undefined;
}

/** A credential option, or anything shaped like a token, on the command line is refused with a fixed message that does not echo it. */
const IN_ARGV = /^-{1,2}(t|token|api-?key|key|secret|password)(=|$)/i;

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^[1-9]\d{0,2}$/.test(raw)) throw usage("--limit is a whole number from 1 to 999");
  return Number(raw);
}

export function parseCommandLine(argv: readonly string[]): Parsed {
  if (argv.some((a) => IN_ARGV.test(a) || a.includes("fxat_"))) throw usage("a token must never be passed on the command line: pipe it to `fx login`, or set FX_TOKEN");
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        profile: { type: "string" },
        "base-url": { type: "string" },
        json: { type: "boolean" },
        debug: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        all: { type: "boolean" },
        limit: { type: "string" },
      },
    });
    return {
      command: positionals[0],
      rest: positionals.slice(1),
      profile: values.profile,
      baseUrl: values["base-url"],
      json: values.json === true,
      debug: values.debug === true,
      help: values.help === true,
      all: values.all === true,
      limit: parseLimit(values.limit),
    };
  } catch (e) {
    if (e instanceof CliExit) throw e;
    // fx-swallow-ok: the parser's own text can quote the argument
    throw usage("unknown option, or an option is missing its value: see `fx --help`");
  }
}
