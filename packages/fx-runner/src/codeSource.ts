/**
 * Where `fx-runner register` gets its secret from (D#605 FL-7): standard input (`--code-stdin`) or a file (`--code-file <path>`), so the
 * code or token never sits in the process list. `--code <value>` still works for one release and prints a deprecation line.
 *
 * The file is opened without following a link, and every check runs on the open descriptor, so the file that was checked is the file
 * that is read: a regular file, owned by the person running the command, with no access for group or others (0600), and small. A
 * refusal names the file and its mode, never a byte of its content.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { CliError } from "./cliError.js";
import type { CommandContext, Flags } from "./context.js";

/** A registration secret is at most 133 characters (`REGISTRATION_CODE_PATTERN`). */
export const CODE_MAX_BYTES = 133;
/** A file holding one is a few hundred bytes at most, newline included. */
const CODE_FILE_MAX_BYTES = 512;

export const CODE_DEPRECATION =
  "warning: --code puts the code in the process list, where other users on this machine can read it, and will be removed in a later release; use --code-stdin or --code-file <path>";

/** Reads a code file as above. Throws a `CliError` with exit code 2 for every refusal. */
export function readCodeFile(file: string, uid: number | undefined): string {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    // fx-swallow-ok: the failure is reported by its class; the system's text is not shown
    const code = (error as { code?: string }).code;
    throw new CliError(code === "ELOOP" ? `--code-file ${file} is a link, which is refused; name the file itself` : code === "ENOENT" ? `--code-file ${file} does not exist` : `--code-file ${file} cannot be opened`, 2);
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new CliError(`--code-file ${file} is not a regular file`, 2);
    if ((info.mode & 0o077) !== 0) {
      throw new CliError(`--code-file ${file} has mode ${(info.mode & 0o777).toString(8).padStart(4, "0")}; it must be 0600 (no access for group or others); run: chmod 600 ${file}`, 2);
    }
    if (uid === undefined || info.uid !== uid) throw new CliError(`--code-file ${file} must be owned by the user running fx-runner`, 2);
    if (info.size === 0 || info.size > CODE_FILE_MAX_BYTES) throw new CliError(`--code-file ${file} must hold the code or token and nothing else`, 2);
    const buffer = Buffer.alloc(info.size);
    let filled = 0;
    while (filled < buffer.length) {
      const read = readSync(fd, buffer, filled, buffer.length - filled, null);
      if (read === 0) break;
      filled += read;
    }
    return buffer.subarray(0, filled).toString("utf8").trim();
  } finally {
    closeSync(fd);
  }
}

/** The code or token from the one source the flags name; exactly one of the three must be given. */
export async function readRegistrationCode(flags: Flags, ctx: CommandContext): Promise<string> {
  const stdin = flags.has("code-stdin");
  const file = flags.get("code-file");
  const argv = flags.get("code");
  if ([stdin, file !== undefined, argv !== undefined].filter(Boolean).length > 1) throw new CliError("give only one of --code-stdin, --code-file and --code", 2);
  if (stdin) {
    if (ctx.readCode === undefined) throw new CliError("--code-stdin is only available from the fx-runner program");
    const text = (await ctx.readCode()).trim();
    if (text === "") throw new CliError("--code-stdin: nothing was read from standard input", 2);
    return text;
  }
  if (file !== undefined) {
    if (typeof file !== "string" || file === "") throw new CliError("--code-file needs a path", 2);
    return readCodeFile(file, ctx.uid);
  }
  if (typeof argv !== "string" || argv === "") throw new CliError("the code or token is required: pipe it to --code-stdin, or name a 0600 file with --code-file <path>", 2);
  ctx.err(`fx-runner: ${CODE_DEPRECATION}`);
  return argv;
}
