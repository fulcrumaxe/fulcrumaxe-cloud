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
