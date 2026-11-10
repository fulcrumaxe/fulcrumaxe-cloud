import { tmpdir } from "node:os";

/**
 * Where these tests make their scratch directories: the process's own temp directory (`os.tmpdir()`, which follows `TMPDIR`), not a
 * hard-coded `/tmp`. Inside a runner job `/tmp` is read-only and only the job's own `TMPDIR` is writable.
 *
 * The allowance floor takes a write entry only below `/tmp`, so a temp directory somewhere else (macOS keeps it under `/var/folders`)
 * falls back to `/tmp` itself: those hosts have a writable `/tmp`, and the floor tests need a name the floor accepts.
 */
export function tmpRoot(): string {
  const dir = tmpdir().replace(/\/+$/, "");
  return dir.startsWith("/tmp/") ? dir : "/tmp";
}

/** The longest temp base a Unix-socket fixture may sit under: `sun_path` holds 107 bytes, and the deepest fixtures add about 75 of their own. */
export const SOCKET_BASE_MAX = 30;

/**
 * Where a test builds a directory that will hold a real Unix socket: `tmpRoot()`, unless that is so deeply nested (a nix-shell inside a probe
 * directory, as the check gate runs it) that `listen()` would fail with EINVAL on the path length; then the short `/tmp` itself.
 */
export function socketTmpRoot(): string {
  const dir = tmpRoot();
  return dir.length <= SOCKET_BASE_MAX ? dir : "/tmp";
}
