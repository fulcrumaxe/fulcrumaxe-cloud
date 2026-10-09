import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SandboxGrantRefused, assertEnabledSandbox, sandboxSettings } from "../src/sandbox/sandboxSettings.js";

const HOME = "/home/jane";
const STATE = "/home/jane/.fx-runner";
const BIN = "/home/jane/.local/bin";
const base = { workspace: "/home/jane/work/run-1", tempDir: "/tmp/fx-run-1", home: HOME, stateDir: STATE, binaryDir: BIN, workspaceRoot: "/home/jane/work", tempRoot: "/tmp" };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const block = (over: Partial<Parameters<typeof sandboxSettings>[0]> = {}) => sandboxSettings({ ...base, ...over }) as Record<string, any>;

describe("R4b1-4: the sandbox hardening the security review asked for", () => {
  it("does not auto-allow Bash, and the guard refuses a block that does", () => {
    expect(block().autoAllowBashIfSandboxed).toBe(false);
    expect(() => assertEnabledSandbox({ ...block(), autoAllowBashIfSandboxed: true })).toThrow(TypeError);
    expect(() => assertEnabledSandbox({ ...block(), autoAllowBashIfSandboxed: undefined })).toThrow(TypeError);
  });

  it("names the state directory and the binary directory in denyRead, not only the home directory", () => {
    expect(block().filesystem.denyRead).toEqual([HOME, STATE, BIN, base.workspaceRoot, base.tempRoot]);
  });

  it("is an allowlist: a workspace, temp directory or extra path outside every runner-owned root is refused", () => {
    expect(() => block({ workspace: "/home/jane/elsewhere/run-1" })).toThrow(SandboxGrantRefused);
    expect(() => block({ tempDir: "/var/tmp/x" })).toThrow(SandboxGrantRefused);
    expect(() => block({ extraReadPaths: ["/opt/cache"] })).toThrow(SandboxGrantRefused);
    expect(() => block({ extraWritePaths: ["/home/jane/work/run-1/out"], extraReadPaths: ["/tmp/fx-run-1/c"] })).not.toThrow();
    expect(() => block({ extraRoots: ["/opt"], extraReadPaths: ["/opt/cache"] })).not.toThrow();
  });

  it("refuses a grant over the persistence targets, and a named root over the floor", () => {
    expect(() => block({ extraRoots: [`${HOME}/.ssh`] })).toThrow(SandboxGrantRefused);
    expect(() => block({ extraRoots: [`${HOME}/stuff`], extraWritePaths: [`${HOME}/.bashrc`] })).toThrow(/protected location/);
    expect(() => block({ workspace: `${HOME}/.config/systemd/user/x`, workspaceRoot: HOME })).toThrow(SandboxGrantRefused);
  });

  it("compares the floor case-insensitively, as a case-insensitive volume would", () => {
    for (const grant of [`${HOME}/.SSH/ws`, `${HOME}/.Fx-Runner/ws`, `${BIN.toUpperCase()}/ws`, `${HOME}/.BashRC`]) {
      expect(() => block({ workspace: grant, workspaceRoot: HOME }), grant).toThrow(SandboxGrantRefused);
    }
  });

  it("folds case only in the protected-overlap test: a case variant of a runner-owned root is not under it", () => {
    expect(() => block({ workspace: "/home/jane/Work/run-1" })).toThrow(/not under a runner-owned root/);
    expect(() => block({ tempDir: "/TMP/fx-run-1" })).toThrow(/not under a runner-owned root/);
    expect(() => block({ extraRoots: ["/opt"], extraReadPaths: ["/OPT/cache"] })).toThrow(/not under a runner-owned root/);
    expect(() => block()).not.toThrow();
  });

  it("requires a strict child: a grant equal to a root is refused, an extra named root is its own root", () => {
    expect(() => block({ workspace: "/home/jane/work" })).toThrow(/not under a runner-owned root/);
    expect(() => block({ workspace: "/home/jane/work/" })).toThrow(/not under a runner-owned root/);
    expect(() => block({ tempDir: "/tmp" })).toThrow(/not under a runner-owned root/);
    expect(() => block({ extraWritePaths: [base.workspace] })).toThrow(/not under a runner-owned root/);
    expect(() => block({ extraRoots: ["/opt"], extraReadPaths: ["/opt"] })).toThrow(/not under a runner-owned root/);
    expect(() => block({ extraRoots: ["/opt"] })).not.toThrow();
  });

  it("follows symlinks: a grant that is, or sits in, a link into a protected place is refused, and so is a link out of its root", () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "tr_link-")));
    const home = path.join(root, "home");
    mkdirSync(path.join(home, ".ssh"), { recursive: true });
    mkdirSync(path.join(root, "ws"));
    mkdirSync(path.join(root, "outside"));
    symlinkSync(path.join(home, ".ssh"), path.join(root, "ws", "link"));
    symlinkSync(path.join(root, "outside"), path.join(root, "ws", "out"));
    const input = {
      workspace: path.join(root, "ws", "run"), tempDir: path.join(root, "tmp", "t"), home,
      stateDir: path.join(home, ".fx-runner"), binaryDir: path.join(root, "bin"), workspaceRoot: path.join(root, "ws"), tempRoot: path.join(root, "tmp"),
    };
    expect(() => sandboxSettings(input)).not.toThrow();
    expect(() => sandboxSettings({ ...input, workspace: path.join(root, "ws", "link") })).toThrow(SandboxGrantRefused);
    expect(() => sandboxSettings({ ...input, workspace: path.join(root, "ws", "link", "deep") })).toThrow(SandboxGrantRefused);
    expect(() => sandboxSettings({ ...input, workspace: path.join(root, "ws", "out", "run") })).toThrow(SandboxGrantRefused);
  });
});
