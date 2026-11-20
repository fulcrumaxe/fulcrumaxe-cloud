/**
 * What comes OUT of a guest, and how a stopped guest's working copy is found again (D#587 B-5b).
 *
 *  - `pullBundle` asks the guest to bundle what its work directory's HEAD has that the start commit does not, and reads it as base64 on the command's own
 *    output. The size is held three times: the guest says how big the file is before any of it is sent (over the cap: nothing is transferred), the reader
 *    stops the command the moment more than the cap's worth has arrived, and the decoded length must equal the size the guest named. Everything the guest
 *    sends is untrusted: `applyBundle` (the host side, `src/daemon/vmBundle.ts`) parses and checks it before git sees it.
 *  - `reopenWorkspace` answers whether the guest still holds this run's working copy: the staging marker names the commit the copy started from, and that
 *    must be the commit this run sent. After a stop that kept a snapshot it is still there; after an eviction (a fresh boot) it is not.
 */
import type { SdkSandbox } from "../sandboxd/sdkSlice.js";
import { MAX_BUNDLE_BYTES } from "./bundleHeader.js";
import { DEFAULT_GUEST_PATHS, runInGuest, type GuestPaths } from "./guestWorkspace.js";

export class BundlePullError extends Error {
  constructor(readonly code: "bundle_too_large" | "bundle_pull_failed" | "bundle_size_mismatch") {
    super(code);
    this.name = "BundlePullError";
  }
}

const COUNT = ['set -eu', 'cd "$1"', 'git rev-list --count "$2..HEAD"'].join("\n");
const MAKE = ['set -eu', 'cd "$1"', 'rm -f "$3/out.bundle"', 'git bundle create "$3/out.bundle" HEAD "^$2" >/dev/null 2>&1', 'wc -c <"$3/out.bundle"'].join("\n");
const REOPEN = ['set -eu', '[ -d "$1/.git" ]', '[ "$(cat "$2/base")" = "$3" ]'].join("\n");

/** The bundle of what the guest's HEAD has beyond `base`, or null when it has nothing new. */
export async function pullBundle(guest: SdkSandbox, base: string, options: { paths?: GuestPaths; maxBytes?: number } = {}): Promise<Buffer | null> {
  const paths = options.paths ?? DEFAULT_GUEST_PATHS;
  const maxBytes = options.maxBytes ?? MAX_BUNDLE_BYTES;
  const step = (script: string, name: string, args: string[], keep = 64): ReturnType<typeof runInGuest> => runInGuest(guest, { cmd: "sh", args: ["-c", script, name, ...args] }, 5 * 60_000, keep).catch(() => {
    // fx-swallow-ok: replaced by the closed code; the daemon's error text could hold a path
    throw new BundlePullError("bundle_pull_failed");
  });
  const counted = await step(COUNT, "fx-count", [paths.workspace, base]);
  const commits = Number(counted.stdout.trim());
  if (counted.exitCode !== 0 || !Number.isSafeInteger(commits) || commits < 0) throw new BundlePullError("bundle_pull_failed");
  if (commits === 0) return null;
  const made = await step(MAKE, "fx-bundle", [paths.workspace, base, paths.stage]);
  const size = Number(made.stdout.trim());
  if (made.exitCode !== 0 || !Number.isSafeInteger(size) || size <= 0) throw new BundlePullError("bundle_pull_failed");
  if (size > maxBytes) throw new BundlePullError("bundle_too_large");
  const ceiling = Math.ceil(size / 3) * 4 + 8;
  const chunks: string[] = [];
  let have = 0;
  const sent = await runInGuest(guest, { cmd: "base64", args: ["-w0", `${paths.stage}/out.bundle`] }, 10 * 60_000, 64, (stream, text) => {
    if (stream !== "stdout") return undefined;
    have += text.length;
    if (have > ceiling) return "stop";
    chunks.push(text);
    return undefined;
  }).catch(() => {
    // fx-swallow-ok: replaced by the closed code
    throw new BundlePullError("bundle_pull_failed");
  });
  await step('rm -f "$1/out.bundle"', "fx-clean", [paths.stage]).catch(() => undefined); // fx-swallow-ok: a left file is overwritten by the next run and removed with the sandbox
  if (sent.stopped === true) throw new BundlePullError("bundle_size_mismatch");
  if (sent.exitCode !== 0 || sent.timedOut) throw new BundlePullError("bundle_pull_failed");
  const text = chunks.join("");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new BundlePullError("bundle_pull_failed");
  const bytes = Buffer.from(text, "base64");
  if (bytes.length !== size) throw new BundlePullError("bundle_size_mismatch");
  return bytes;
}

/** True when the guest still holds the working copy this run started at the commit `base`. */
export async function reopenWorkspace(guest: SdkSandbox, base: string, paths: GuestPaths = DEFAULT_GUEST_PATHS): Promise<boolean> {
  const ran = await runInGuest(guest, { cmd: "sh", args: ["-c", REOPEN, "fx-reopen", paths.workspace, paths.stage, base] }, 60_000).catch(() => undefined); // fx-swallow-ok: a guest that cannot answer holds no copy we can vouch for
  return ran?.exitCode === 0;
}
