/**
 * D#6 C44-1: the per-job env file named in `CLAUDE_ENV_FILE`.
 *
 * The agent CLI starts its Bash tool through the user's login shell. A user rc file can reset PATH there (on NixOS, by unsetting the
 * `__NIXOS_SET_ENVIRONMENT_DONE` marker and re-sourcing `/etc/profile`), which drops the toolchain directories the runner added, and the
 * profile directories it falls back to sit under the home directory the sandbox hides. The CLI sources the file named in `CLAUDE_ENV_FILE`
 * after that shell has started, so putting `PATH` and `TMPDIR` in it restores both whatever the rc files did.
 *
 * The file holds `export` lines for those two names only, each value single-quoted. A value with a quote, a newline, a NUL or any other control
 * character is refused before anything is written.
 *
 * The CLI reads the file in its own process, on the host and following links, so it must sit where the job cannot write: a per-job directory (0700)
 * under the runner's state directory, which the sandbox neither writes nor reads. In the job's own temp directory the job could swap the file for a link to
 * a host file the sandbox cannot read, and the CLI would run that file's lines as shell. The directory goes with the sandbox.
 * It is written with no-follow file operations: a link planted at the path is unlinked as a link, never written through.
 */
import { chmodSync, closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

/** File name inside the job temp directory. */
export const JOB_ENV_FILE_NAME = "claude-env.sh";

/** The per-job directory (0700) for the file, made under `root` (made too, 0700). An existing directory of that name (a resumed run) is reused if it is a real directory. */
export function makeJobEnvDir(root: string, dir: string): void {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new JobEnvFileRefused();
    chmodSync(dir, 0o700);
  } catch {
    throw new JobEnvFileRefused();
  }
}

/** Why the file was not written. Closed: carries no value. */
export class JobEnvFileRefused extends Error {
  constructor() {
    super("job_env_unsafe");
    this.name = "JobEnvFileRefused";
  }
}

/** A value that is safe inside single quotes of a POSIX shell: no quote, no control character (newline and NUL included). */
function quotable(value: string): boolean {
  return value !== "" && !/['\u0000-\u001f\u007f]/.test(value);
}

/** The file's text for `values` (name -> value). Throws `JobEnvFileRefused` for a name that is not a plain identifier or a value that cannot be quoted. */
export function jobEnvFileText(values: Readonly<Record<string, string | undefined>>): string {
  const lines: string[] = [];
  for (const name of Object.getOwnPropertyNames(values)) {
    const value = values[name];
    if (value === undefined) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !quotable(value)) throw new JobEnvFileRefused();
    lines.push(`export ${name}='${value}'`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Writes the file at `<dir>/claude-env.sh` (0600) and returns its path. `tempDir` (the per-job env directory) must be a real directory (not a link). The text is built
 * and checked first, so a refused value leaves nothing on disk. An earlier file of the same name (a resumed run) is unlinked, then created
 * exclusively with no-follow.
 */
export function writeJobEnvFile(tempDir: string, values: Readonly<Record<string, string | undefined>>): string {
  const text = jobEnvFileText(values);
  if (!path.isAbsolute(tempDir)) throw new JobEnvFileRefused();
  let dir;
  try {
    dir = lstatSync(tempDir);
  } catch {
    throw new JobEnvFileRefused();
  }
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw new JobEnvFileRefused();
  const file = path.join(tempDir, JOB_ENV_FILE_NAME);
  try {
    unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new JobEnvFileRefused();
  }
  let fd: number;
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch {
    throw new JobEnvFileRefused();
  }
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  return file;
}
