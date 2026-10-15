import type { Parsed } from "../args.js";
import type { Io } from "../context.js";
import { readCredentials, writeCredentials } from "../credentials.js";
import { CliExit, EXIT, usage } from "../errors.js";
import type { Output } from "../output.js";
import { checkProfileName, DEFAULT_ORIGIN, DEFAULT_PROFILE, normaliseOrigin, readProfiles, writeProfiles } from "../profiles.js";
import { TOKEN_RE } from "../session.js";

const MAX_INPUT = 256;

/** Reads one secret from standard input. Piped input is read to its end. On a terminal the prompt goes to stderr and echo is off while the person types. */
function readSecret(io: Io, out: Output): Promise<string> {
  const stream = io.stdin;
  const tty = stream.isTTY === true;
  if (tty && typeof stream.setRawMode !== "function") return Promise.reject(usage("this terminal cannot switch off echo, so the token will not be read from it: pipe it on standard input instead"));
  return new Promise((resolve, reject) => {
    let text = "";
    const finish = (error?: CliExit): void => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      if (tty) {
        stream.setRawMode!(false);
        out.err("\n");
      }
      stream.pause();
      if (error === undefined) resolve(text);
      else reject(error);
    };
    const onData = (chunk: Buffer | string): void => {
      for (const char of chunk.toString()) {
        if (tty && (char === "\r" || char === "\n" || char === "\u0004")) return finish();
        if (tty && char === "\u0003") return finish(new CliExit(130, "cancelled", "cancelled"));
        if (tty && (char === "\u007f" || char === "\b")) text = text.slice(0, -1);
        else text += char;
      }
      if (text.length > MAX_INPUT) finish(usage("that is not a fulcrumaxe token"));
    };
    const onEnd = (): void => finish();
    const onError = (): void => finish(new CliExit(EXIT.unexpected, "stdin", "standard input could not be read"));
    if (tty) {
      out.err("Token (what you type is not shown): ");
      stream.setRawMode!(true);
    }
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
    stream.resume();
  });
}

/** `fx login [--profile p] [--base-url u]`: the token comes from standard input only, and is saved bound to the origin it was entered for. */
export async function login(io: Io, out: Output, args: Parsed): Promise<void> {
  if (io.platform === "win32") throw usage("a stored login is not supported on Windows: set FX_TOKEN and FX_BASE_URL");
  const profile = checkProfileName(args.profile ?? (io.env["FX_PROFILE"] || DEFAULT_PROFILE));
  const profiles = readProfiles(io);
  const given = args.baseUrl ?? profiles.get(profile) ?? DEFAULT_ORIGIN;
  if (given === undefined) throw usage("say where to sign in: fx login --base-url https://<your fulcrumaxe address>");
  const origin = normaliseOrigin(given);
  out.note(`Signing in to ${origin} as profile "${profile}". The token will be saved for that origin only.`);
  const token = (await readSecret(io, out)).replace(/\r?\n$/, "");
  if (!TOKEN_RE.test(token)) throw usage("that is not a fulcrumaxe token (it starts with fxat_ and has 49 letters or digits after that)");
  const creds = readCredentials(io);
  creds[profile] = { origin, token, saved_at: new Date().toISOString() };
  writeCredentials(io, creds);
  profiles.set(profile, origin);
  writeProfiles(io, profiles);
  out.say(`Saved. Profile "${profile}" is bound to ${origin}. Run \`fx whoami\` to check that it works.`);
  out.success({ profile, origin });
}
