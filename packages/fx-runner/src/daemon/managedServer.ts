/**
 * D#845 MC-8b: whether this machine is a server the cloud itself set up (rented and installed by the cloud-init bootstrap), the only kind that may run the Claude sign-in link.
 *
 * The fact is the bootstrap's own last marker: it runs as root and writes `done` into `/var/lib/fx/stage` only after every stage (the runner's install and registration included) has passed. The runner
 * runs as an ordinary user and cannot write there, so a person's laptop or a hand-installed server never has it. It is accepted only as the bootstrap leaves it: a plain file (a link is not followed),
 * and it and the two directories above it owned by root and not writable by anyone else. Anything else, including a path that cannot be read, is "not managed" (fail closed). It is read on every
 * question, so the answer follows the machine: the runner starts before the marker exists, and the capability appears once it does.
 */
import { lstatSync, type Stats } from "node:fs";

export const MANAGED_SERVER_MARKER_DIRS: readonly string[] = Object.freeze(["/var/lib/fx", "/var/lib/fx/stage"]);
export const MANAGED_SERVER_MARKER = "/var/lib/fx/stage/done";

export type LstatPort = (path: string) => Pick<Stats, "isFile" | "isDirectory" | "uid" | "mode"> | undefined;

/** The real lstat: a missing path is `undefined`; any other error propagates and is read as "not managed" by the caller. */
export const realLstat: LstatPort = (p) => lstatSync(p, { throwIfNoEntry: false });

const rootOnly = (st: Pick<Stats, "uid" | "mode">): boolean => st.uid === 0 && (st.mode & 0o022) === 0;

export function isManagedServer(lstat: LstatPort = realLstat): boolean {
  try {
    for (const dir of MANAGED_SERVER_MARKER_DIRS) {
      const st = lstat(dir);
      if (st === undefined || !st.isDirectory() || !rootOnly(st)) return false;
    }
    const marker = lstat(MANAGED_SERVER_MARKER);
    return marker !== undefined && marker.isFile() && rootOnly(marker);
  } catch {
    // fx-swallow-ok: a marker that cannot be read is "not managed", the closed answer
    return false;
  }
}
