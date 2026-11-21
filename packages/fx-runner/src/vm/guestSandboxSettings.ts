/**
 * The `sandbox` block of the settings file for an agent that runs INSIDE a microVM guest (D#587 B-5a-RT-3). The host's builder (`sandboxSettings`)
 * is a function of the host's home, state directory and temp roots and reads the host's file system to resolve links; none of that exists in a guest, and
 * nothing of the host may leak into a guest file. So the guest has its own builder, over the guest's own fixed layout: home `/vercel`, the
 * job's working copy, a per-run directory under `/tmp`, and the image's own tool directory. It makes the same block, key for key: the shell sandbox on,
 * writes only in the working copy and the run's temp directory, reads of the home directory and the shared temp directories denied with those two
 * re-allowed, every credential location of the floor denied, the model host the only network name, and no way out of the sandbox.
 *
 * The CLI starts its Bash tool under bubblewrap in its own PID namespace (`--unshare-pid`), which is what keeps the CLI's own process environment (the
 * subscription token) away from the tool; `test/vm/vmToken.real.test.ts` checks that against the real image, and `failIfUnavailable` ends a run in which
 * bubblewrap cannot start rather than letting the tool run unconfined.
 */
import { CREDENTIAL_FLOOR, MODEL_HOST, SHARED_TEMP_DIRS, protectedPaths, type ProtectedPaths } from "../sandbox/sandboxSettings.js";
import { EngineRefusal } from "../engines/claude/refusal.js";
import { GUEST_STAGE } from "./workspace/guestWorkspace.js";

/** The guest agent user's home, as the image gives it (and `MICROVM_GUEST_ENV.HOME` says). */
export const GUEST_HOME = "/vercel";
/** The directory the image puts the pinned `claude` in. */
export const GUEST_BIN_DIR = "/opt/fx/bin";

/** The image-owned directory (made for the agent user at every boot) a working copy lives in. The working directory must be strictly below it. */
export const GUEST_WORKSPACE_ROOT = "/vercel/sandbox";
/** Places that are never granted, whatever the caller says (the host builder's list, plus the guest root user's home and the other system trees). */
const NEVER_GRANTED: readonly string[] = ["/", "/etc", "/root", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/var", "/opt", "/sys", "/dev", "/boot", "/run", "/home"];

export interface GuestLayout {
  /** The job's working copy, absolute. */
  workdir: string;
  /** The run's own temp directory, absolute, under `/tmp`. */
  tempDir: string;
  /** Where the run's settings files are kept (denied to the tool). */
  jobsDir: string;
}

const PLAIN = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
const inside = (parent: string, child: string): boolean => child === parent || child.startsWith(`${parent}/`);

/** A path the sandbox block may be built from: plain, normalised (no `.`, `..` or doubled slash) and clear of every location the guest keeps for itself. */
function assertGuestPath(label: string, value: string, ...clearOf: readonly string[]): void {
  if (!PLAIN.test(value) || value.split("/").some((part) => part === "." || part === "..")) throw new EngineRefusal("bad_start_options", `${label} is not a plain absolute path`);
  for (const other of clearOf) if (inside(other, value) || inside(value, other)) throw new EngineRefusal("bad_start_options", `${label} overlaps a protected location`);
}

/** The protected paths of a guest run: the credential floor under the guest home, the settings directory and the tool directory. */
export function guestProtectedPaths(layout: GuestLayout): ProtectedPaths {
  return protectedPaths({ home: GUEST_HOME, stateDir: layout.jobsDir, binaryDir: GUEST_BIN_DIR });
}

/**
 * The working directory is the one write grant of the block besides the temp directory, so it is held to the host builder's `assertGrantable`: strictly
 * below the image's workspace root (never the root itself), not a system directory, `/root` or the guest home, and overlapping neither the credential floor,
 * the persistence targets, the settings directory nor the tool directory (`guestProtectedPaths`), nor the staging directory the workspace builder uses.
 */
function assertGuestWorkdir(layout: GuestLayout): void {
  const { workdir } = layout;
  if (!inside(GUEST_WORKSPACE_ROOT, workdir) || workdir === GUEST_WORKSPACE_ROOT) throw new EngineRefusal("bad_start_options", "working directory is not strictly below the image's workspace root");
  if (NEVER_GRANTED.includes(workdir) || workdir === GUEST_HOME || workdir.endsWith(".sock")) throw new EngineRefusal("bad_start_options", "working directory may not be the home directory, a system directory or a socket");
  const listed = guestProtectedPaths(layout);
  for (const guarded of [...listed.noAccess, ...listed.noEdit, GUEST_STAGE]) if (inside(guarded, workdir) || inside(workdir, guarded)) throw new EngineRefusal("bad_start_options", "working directory overlaps a protected location");
}

export function guestSandboxSettings(layout: GuestLayout): Record<string, unknown> {
  const { workdir, tempDir, jobsDir } = layout;
  assertGuestPath("working directory", workdir, jobsDir, GUEST_BIN_DIR, ...SHARED_TEMP_DIRS);
  assertGuestWorkdir(layout);
  assertGuestPath("job directory", jobsDir, tempDir, workdir);
  assertGuestPath("temp directory", tempDir, workdir, jobsDir, GUEST_BIN_DIR);
  if (!inside("/tmp", tempDir) || tempDir === "/tmp" || workdir === GUEST_HOME) throw new EngineRefusal("bad_start_options", "the guest layout is not the image's");
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    excludedCommands: [] as string[],
    autoAllowBashIfSandboxed: false,
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    filesystem: {
      disabled: false,
      allowWrite: [workdir, tempDir],
      denyWrite: [jobsDir, GUEST_BIN_DIR],
      denyRead: [GUEST_HOME, jobsDir, GUEST_BIN_DIR, ...SHARED_TEMP_DIRS],
      allowRead: [workdir, tempDir],
    },
    credentials: { files: CREDENTIAL_FLOOR.map((entry) => ({ path: `${GUEST_HOME}/${entry}`, mode: "deny" })), envVars: [] as unknown[] },
    network: { allowedDomains: [MODEL_HOST], strictAllowlist: true, allowLocalBinding: false },
  };
}
