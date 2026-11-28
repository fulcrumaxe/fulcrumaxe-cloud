import { spawnSync, type SpawnSyncReturns } from "node:child_process";

/**
 * The RAM-snapshot search of the real supervisor test, as root through `sudo -n`, for the host whose helper keeps its snapshots in a root-only directory (`FX_VM_SNAPSHOT_SEARCH_SUDO=1`). It
 * changes no permission of anything: granting the test user a read ACL made the helper refuse the resume of a snapshot whose files were touched (and gave a new file no usable mask), so the
 * search goes through `sudo -n find` and `sudo -n grep` with a fixed argv and no shell, and the directory stays exactly as the helper made it.
 */
export type Run = (file: string, args: string[]) => Pick<SpawnSyncReturns<Buffer>, "status" | "stdout" | "error">;
const real: Run = (file, args) => spawnSync(file, args, { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 2 ** 20 });

/** The argv of the file listing: every regular file under `dir`, NUL separated (a name may hold a newline); links are not followed and not listed. */
export function sudoFindArgv(dir: string): string[] {
  return ["-n", "find", dir, "-type", "f", "-print0"];
}

/**
 * The argv of a fixed-string search of one file; exit 0 = found, 1 = not found. The needle is an argv element after `--`, so a leading dash is not an option. A needle `grep -F` would read as more than one
 * pattern (it holds a newline), or that cannot be an argv element (it holds a NUL, or is not text that survives a round trip through UTF-8), is refused here rather than searched wrongly.
 */
export function sudoGrepArgv(file: string, needle: Buffer): string[] {
  const text = needle.toString("utf8");
  if (needle.length === 0 || needle.includes(0) || needle.includes(0x0a) || !Buffer.from(text, "utf8").equals(needle)) throw new Error("the search needle cannot be passed as one argv string");
  return ["-n", "grep", "-qF", "--", text, file];
}

/** Every regular file under `dir`, or undefined when `sudo -n` is not usable or the listing fails. */
export function sudoListFiles(dir: string, run: Run = real): string[] | undefined {
  const r = run("sudo", sudoFindArgv(dir));
  if (r.error !== undefined || r.status !== 0) return undefined;
  return r.stdout.toString("utf8").split("\0").filter((f) => f !== "");
}

/** True when the file holds `needle`; exit 1 is "not found"; anything else (sudo refused, the file unreadable, a failed spawn) throws. */
export function sudoFileHolds(file: string, needle: Buffer, run: Run = real): boolean {
  const r = run("sudo", sudoGrepArgv(file, needle));
  if (r.error !== undefined) throw new Error("the sudo search could not be run");
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  throw new Error(`the sudo search failed (exit ${String(r.status)})`);
}
