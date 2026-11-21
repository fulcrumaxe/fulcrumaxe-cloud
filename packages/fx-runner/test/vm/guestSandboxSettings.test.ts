import { describe, expect, it } from "vitest";
import { EngineRefusal } from "../../src/engines/claude/refusal.js";
import { GUEST_BIN_DIR, GUEST_HOME, guestProtectedPaths, guestSandboxSettings, type GuestLayout } from "../../src/vm/guestSandboxSettings.js";
import { guestJobFiles } from "../../src/vm/sandboxd/guestJobFiles.js";
import { GUEST_JOBS_DIR } from "../../src/vm/sandboxd/guestRuntime.js";
import { RUN_ID } from "../engines/claude/harness.js";

/**
 * D#587 B-5a-RT-3, the guest's own sandbox block: the working directory is held to what the host builder's `assertGrantable` holds a workspace to, and the
 * whole block for the image's layout is pinned key for key, so a loosened key (a local bind, a shared temp directory no longer read-denied, a writable tool
 * directory) fails here and not only in a review.
 */
const WORKDIR = "/vercel/sandbox/work";
const layout = (over: Partial<GuestLayout> = {}): GuestLayout => ({ workdir: WORKDIR, tempDir: `/tmp/fx-${RUN_ID}`, jobsDir: GUEST_JOBS_DIR, ...over });

describe("the guest working directory", () => {
  it("is refused unless it is a plain, strict child of the image's workspace root clear of every protected location", () => {
    const refused: Array<[string, string]> = [
      ["/vercel/.claude", "a credential-floor directory under the guest home"],
      ["/vercel/.config", "a directory holding the floor's config entries"],
      ["/vercel/.ssh", "a credential-floor directory"],
      ["/vercel/.ssh/keys", "below a credential-floor directory"],
      ["/vercel/.bashrc", "a persistence target"],
      ["/etc", "a system directory"],
      ["/root", "the root user's home"],
      ["/", "the file system root"],
      ["/vercel", "the guest home"],
      ["/vercel/sandbox", "the workspace root itself"],
      ["/vercel/sandbox/", "the workspace root with a trailing slash"],
      ["/vercel/sandbox/../.ssh", "a .. traversal out of the root"],
      ["/vercel/sandbox/work/../../.ssh", "a deeper .. traversal"],
      ["/vercel/sandbox/./work", "a . segment"],
      ["/vercel/sandboxx", "a sibling that only starts like the root"],
      ["/vercel/sandbox/.fx-stage", "the workspace builder's staging directory"],
      ["/vercel/sandbox/.fx-stage/x", "below the staging directory"],
      ["/vercel/fx-job", "the settings directory"],
      ["/opt/fx/bin", "the tool directory"],
      ["/tmp/work", "a shared temp directory"],
      ["work", "a relative path"],
    ];
    for (const [workdir, why] of refused) {
      expect(() => guestSandboxSettings(layout({ workdir })), `${workdir} (${why})`).toThrow(EngineRefusal);
    }
  });

  it("a refusal is bad_start_options, and no job file is built for it", () => {
    for (const workdir of ["/vercel/.ssh", "/etc", "/root", "/vercel/sandbox"]) {
      try {
        guestJobFiles({ jobsDir: GUEST_JOBS_DIR, runId: RUN_ID, role: "executor", workdir });
        expect.unreachable(workdir);
      } catch (error) {
        expect(error).toBeInstanceOf(EngineRefusal);
        expect((error as EngineRefusal).code).toBe("bad_start_options");
      }
    }
  });

  it("a good child of the workspace root is granted, and is what the block writes to", () => {
    for (const workdir of [WORKDIR, "/vercel/sandbox/project", "/vercel/sandbox/a/b-c_d.e"]) {
      const block = guestSandboxSettings(layout({ workdir })) as { filesystem: { allowWrite: string[] } };
      expect(block.filesystem.allowWrite, workdir).toEqual([workdir, `/tmp/fx-${RUN_ID}`]);
    }
  });

  it("no accepted working directory overlaps what guestProtectedPaths lists", () => {
    const listed = guestProtectedPaths(layout());
    for (const guarded of [...listed.noAccess, ...listed.noEdit]) {
      expect(() => guestSandboxSettings(layout({ workdir: guarded })), guarded).toThrow(EngineRefusal);
      expect(() => guestSandboxSettings(layout({ workdir: `${guarded}/child` })), guarded).toThrow(EngineRefusal);
    }
  });
});

/** The block for the image's layout, written out: a change to any key is a change to this literal, made on purpose. */
const GOLDEN = {
  enabled: true,
  failIfUnavailable: true,
  allowUnsandboxedCommands: false,
  excludedCommands: [] as string[],
  autoAllowBashIfSandboxed: false,
  enableWeakerNestedSandbox: false,
  enableWeakerNetworkIsolation: false,
  filesystem: {
    disabled: false,
    allowWrite: [WORKDIR, `/tmp/fx-${RUN_ID}`],
    denyWrite: [GUEST_JOBS_DIR, GUEST_BIN_DIR],
    denyRead: [GUEST_HOME, GUEST_JOBS_DIR, GUEST_BIN_DIR, "/tmp", "/var/tmp", "/dev/shm"],
    allowRead: [WORKDIR, `/tmp/fx-${RUN_ID}`],
  },
  credentials: {
    files: [".ssh", ".aws", ".config/gh", ".kube", ".docker", ".gnupg", ".netrc", ".npmrc", ".claude", ".claude.json", ".config/fx-runner", ".local/share/keyrings", "Library/Keychains"].map((entry) => ({ path: `/vercel/${entry}`, mode: "deny" })),
    envVars: [] as unknown[],
  },
  network: { allowedDomains: ["api.anthropic.com"], strictAllowlist: true, allowLocalBinding: false },
};

describe("the whole guest sandbox block", () => {
  it("is exactly the pinned block for the image's layout", () => {
    expect(guestSandboxSettings(layout())).toEqual(GOLDEN);
  });

  it("is what the settings file written to the guest carries, with nothing of the host in it", () => {
    const files = guestJobFiles({ jobsDir: GUEST_JOBS_DIR, runId: RUN_ID, role: "executor", workdir: WORKDIR });
    const settings = JSON.parse(files.files[0]!.content) as { sandbox: unknown };
    expect(settings.sandbox).toEqual(GOLDEN);
    expect(files.files[0]!.mode).toBe(0o600);
  });

  it("keeps the shared temp directories read-denied and the tool and settings directories write-denied and unreadable", () => {
    const block = guestSandboxSettings(layout()) as { filesystem: { denyRead: string[]; denyWrite: string[]; allowRead: string[]; allowWrite: string[] }; network: { allowLocalBinding: boolean } };
    for (const dir of ["/tmp", "/var/tmp", "/dev/shm", GUEST_HOME, GUEST_BIN_DIR, GUEST_JOBS_DIR]) expect(block.filesystem.denyRead).toContain(dir);
    for (const dir of [GUEST_BIN_DIR, GUEST_JOBS_DIR]) expect(block.filesystem.denyWrite).toContain(dir);
    expect(block.network.allowLocalBinding).toBe(false);
  });
});
