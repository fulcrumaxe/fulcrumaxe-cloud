import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROBE_MARKER, bwrapArgs, probeSandbox, probeSettings, seatbeltProfile, type SandboxProbeInput, type SandboxProbeResult } from "../src/sandbox/probe.js";
import { sandboxSettings } from "../src/sandbox/sandboxSettings.js";
import { PASSING, failing, fakeSandboxHost } from "./helpers/fakeSandboxHost.js";

// The real builder, wrapped so a test can see that the probe calls it and can hand the probe a different answer.
vi.mock("../src/sandbox/sandboxSettings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sandbox/sandboxSettings.js")>();
  return { ...actual, sandboxSettings: vi.fn(actual.sandboxSettings) };
});

const HOME = "/home/jane";
const INPUT: SandboxProbeInput = { platform: "linux", home: HOME, stateDir: "/home/jane/.fx-runner", binaryDir: "/home/jane/.local/bin" };
const FAKE_TOKEN = ["sk-ant-", "oat01-", "fake-probe-token-0123456789"].join("");

let tools: string;
beforeEach(() => {
  tools = mkdtempSync(path.join(tmpdir(), "fxr-probe-"));
  vi.stubEnv("PATH", tools);
  vi.mocked(sandboxSettings).mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tools, { recursive: true, force: true });
});

function install(...names: string[]): void {
  for (const name of names) {
    writeFileSync(path.join(tools, name), "#!/bin/sh\n");
    chmodSync(path.join(tools, name), 0o755);
  }
}

const reasonOf = (result: SandboxProbeResult): string => (result.ok ? "pass" : result.reason);

describe("the probe builds its rules with the job's own function", () => {
  it("calls sandboxSettings once, and the sandbox tool's arguments come from what it returned", async () => {
    install("bwrap", "socat");
    const marked = { filesystem: { allowWrite: ["/marked/write-here"], allowRead: ["/marked/read-here"], denyRead: ["/marked/hidden"], denyWrite: [] } };
    vi.mocked(sandboxSettings).mockReturnValueOnce(marked);
    const host = fakeSandboxHost({ dirs: ["/marked/hidden"] });
    expect(reasonOf(await probeSandbox(INPUT, host))).toBe("pass");
    expect(sandboxSettings).toHaveBeenCalledTimes(1);
    expect(host.calls).toHaveLength(1);
    const args = host.calls[0]!.args;
    expect(args).toEqual(expect.arrayContaining(["--tmpfs", "/marked/hidden", "--ro-bind-try", "/marked/read-here", "--bind-try", "/marked/write-here"]));
  });

  it("passes the job's real home, state and binary directories and a workspace and temp directory under the runner's own roots", () => {
    probeSandbox(INPUT, fakeSandboxHost()).catch(() => undefined);
    const call = vi.mocked(sandboxSettings).mock.calls[0]![0];
    expect(call).toMatchObject({ home: HOME, stateDir: INPUT.stateDir, binaryDir: INPUT.binaryDir });
    expect(call.workspace).toBe("/home/jane/.cache/fx-runner/workspaces/fx-probe");
    expect(call.tempDir).toBe("/home/jane/.cache/fx-runner/tmp/fx-probe");
  });
});

describe("the translation to the machine's own sandbox tool", () => {
  const settings = (): Record<string, unknown> => probeSettings(INPUT);

  it("bubblewrap: read-only machine, no network, the home directory hidden, then the allowed reads and writes laid back over it", () => {
    const args = bwrapArgs(settings(), (dir) => dir === HOME || dir === INPUT.stateDir);
    expect(args.slice(0, 5)).toEqual(["--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid", "--unshare-net"]);
    expect(args).toEqual(expect.arrayContaining(["--ro-bind", "/", "/"]));
    // The state directory is under the home directory, so hiding the home directory hides it too: one tmpfs.
    expect(args.filter((arg) => arg === "--tmpfs")).toHaveLength(1);
    expect(args).toContain(HOME);
    const hide = args.indexOf("--tmpfs");
    const write = args.indexOf("--bind-try");
    expect(hide).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(hide);
    expect(args.slice(write, write + 3)).toEqual(["--bind-try", "/home/jane/.cache/fx-runner/workspaces/fx-probe", "/home/jane/.cache/fx-runner/workspaces/fx-probe"]);
    // Nothing is writable that the job's settings do not make writable, and the probe never writes to the machine's root.
    expect(args).not.toContain("--bind");
  });

  it("bubblewrap: starts its own user namespace and mounts a fresh process table, as the installed agent CLI does (pinned)", () => {
    for (const isDir of [() => false, () => true]) {
      const args = bwrapArgs(settings(), isDir);
      expect(args).toContain("--unshare-user");
      const proc = args.indexOf("--proc");
      expect(proc).toBeGreaterThan(-1);
      expect(args.slice(proc, proc + 2)).toEqual(["--proc", "/proc"]);
      // The process table is mounted after the root it sits on, and before the job's own paths are laid over it.
      expect(proc).toBeGreaterThan(args.indexOf("--ro-bind"));
      expect(proc).toBeLessThan(args.indexOf("--bind-try"));
    }
  });

  it("bubblewrap: a directory that is not there is not hidden, so the probe creates nothing", () => {
    expect(bwrapArgs(settings(), () => false)).not.toContain("--tmpfs");
  });

  it("Seatbelt: no network, no writes outside the allowed ones, the home directory denied and the allowed reads laid over it", () => {
    const profile = seatbeltProfile(settings());
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain('(allow file-write* (subpath "/home/jane/.cache/fx-runner/workspaces/fx-probe")');
    expect(profile.indexOf('(deny file-read* (subpath "/home/jane")')).toBeGreaterThan(-1);
    expect(profile.indexOf("(allow file-read*", profile.indexOf("(deny file-read*"))).toBeGreaterThan(profile.indexOf("(deny file-read*"));
  });

  it("Seatbelt: a quote or backslash in a path cannot end the string it is written in", () => {
    const profile = seatbeltProfile({ filesystem: { allowWrite: ['/tmp/a"b\\c'], allowRead: [], denyRead: [] } });
    expect(profile).toContain('(subpath "/tmp/a\\"b\\\\c")');
  });
});

describe("each outcome", () => {
  it("pass: the marker comes back from the sandbox tool, and the tool is the one on the search path", async () => {
    install("bwrap", "socat");
    const host = fakeSandboxHost();
    expect(await probeSandbox(INPUT, host)).toEqual({ ok: true, tool: "bubblewrap" });
    expect(host.calls[0]!.command).toBe(path.join(tools, "bwrap"));
    expect(host.calls[0]!.args.slice(-4)).toEqual(["--", "/bin/sh", "-c", `printf %s ${PROBE_MARKER}`]);
  });

  it("bwrap_missing and socat_missing: nothing is started", async () => {
    const host = fakeSandboxHost();
    expect(reasonOf(await probeSandbox(INPUT, host))).toBe("bwrap_missing");
    install("bwrap");
    expect(reasonOf(await probeSandbox(INPUT, host))).toBe("socat_missing");
    expect(host.calls).toEqual([]);
  });

  it("userns_disabled: the kernel setting is 0, either the standard one or the older Debian one", async () => {
    install("bwrap", "socat");
    for (const name of ["user.max_user_namespaces", "kernel.unprivileged_userns_clone"]) {
      const host = fakeSandboxHost({ sysctls: { [name]: "0\n" }, outcome: failing("bwrap: No permissions to create new namespace") });
      expect(reasonOf(await probeSandbox(INPUT, host)), name).toBe("userns_disabled");
    }
  });

  it("apparmor_userns_restricted: the Ubuntu restriction is on and the tool was refused a namespace", async () => {
    install("bwrap", "socat");
    const sysctls = { "user.max_user_namespaces": "63704\n", "kernel.apparmor_restrict_unprivileged_userns": "1\n" };
    const mapRefused = await probeSandbox(INPUT, fakeSandboxHost({ sysctls, outcome: failing("bwrap: setting up uid map: Permission denied") }));
    expect(reasonOf(mapRefused)).toBe("apparmor_userns_restricted");
    // The result carries the bubblewrap that was run, for the profile to name.
    expect(mapRefused).toMatchObject({ bwrapPath: path.join(tools, "bwrap") });
    // A generic refusal with the switch on is not called an AppArmor restriction.
    for (const stderr of ["bwrap: Permission denied", "bwrap: No permissions to create new namespace", "bwrap: Can't mount proc on /newroot/proc: Operation not permitted", "bwrap: Can't read /nonexistent: Permission denied"]) {
      expect(reasonOf(await probeSandbox(INPUT, fakeSandboxHost({ sysctls, outcome: failing(stderr) }))), stderr).toBe("probe_failed_other");
    }
    // The restriction on, but a failure that is about something else, is not blamed on it.
    expect(reasonOf(await probeSandbox(INPUT, fakeSandboxHost({ sysctls, outcome: failing("bwrap: execvp /bin/sh: No such file or directory") })))).toBe("probe_failed_other");
  });

  it("probe_failed_other: carries the first error line, redacted, cut and without control characters", async () => {
    install("bwrap", "socat");
    const stderr = `\n\u001b[31mbwrap: boom ${FAKE_TOKEN}\u001b[0m\nsecond line`;
    const result = await probeSandbox(INPUT, fakeSandboxHost({ outcome: failing(stderr) }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("probe_failed_other");
    expect(result.detail).toContain("bwrap: boom");
    expect(result.detail).not.toContain(FAKE_TOKEN);
    expect(result.detail).not.toContain("second line");
    expect(result.detail).not.toMatch(/[\u0000-\u001f]/);
    // Bidirectional overrides and isolates, and zero-width characters, are dropped too (built from code points, so this file holds none).
    const hidden = [0x202e, 0x202a, 0x2066, 0x2069, 0x200b, 0x200f, 0x061c, 0xfeff].map((code) => String.fromCharCode(code)).join("");
    const bidi = await probeSandbox(INPUT, fakeSandboxHost({ outcome: failing(`bwrap: ${hidden}evil${hidden} text`) }));
    expect(bidi.ok ? "" : bidi.detail).toBe("bwrap: evil text");
    const long = await probeSandbox(INPUT, fakeSandboxHost({ outcome: failing("x".repeat(5000)) }));
    expect(long.ok ? "" : long.detail.length).toBeLessThan(200);
  });

  it("a tool that prints nothing, never starts, runs too long, or exits 0 without the marker is a failure, never a pass", async () => {
    install("bwrap", "socat");
    expect(reasonOf(await probeSandbox(INPUT, fakeSandboxHost({ outcome: failing("") })))).toBe("probe_failed_other");
    expect(reasonOf(await probeSandbox(INPUT, fakeSandboxHost({ outcome: failing("", null) })))).toBe("probe_failed_other");
    expect(reasonOf(await probeSandbox(INPUT, fakeSandboxHost({ outcome: { ...failing(""), timedOut: true } })))).toBe("probe_failed_other");
    expect(reasonOf(await probeSandbox(INPUT, fakeSandboxHost({ outcome: { ...PASSING, stdout: "something else" } })))).toBe("probe_failed_other");
  });

  it("a platform the runner does not support is a failure with a reason", async () => {
    const result = await probeSandbox({ ...INPUT, platform: "win32" }, fakeSandboxHost());
    expect(result).toMatchObject({ ok: false, reason: "probe_failed_other" });
  });
});

describe("macOS", () => {
  const MAC: SandboxProbeInput = { ...INPUT, platform: "darwin", home: "/Users/jane", stateDir: "/Users/jane/.fx-runner", binaryDir: "/Users/jane/.local/bin" };

  it("pass: runs the test command under sandbox-exec with the profile built from the job's rules", async () => {
    const host = fakeSandboxHost({ files: { "/usr/bin/sandbox-exec": "" } });
    expect(await probeSandbox(MAC, host)).toEqual({ ok: true, tool: "seatbelt" });
    expect(host.calls[0]!.command).toBe("/usr/bin/sandbox-exec");
    expect(host.calls[0]!.args.slice(0, 1)).toEqual(["-p"]);
    expect(host.calls[0]!.args[1]).toContain("(deny network*)");
    expect(host.calls[0]!.args.slice(2)).toEqual(["/bin/sh", "-c", `printf %s ${PROBE_MARKER}`]);
  });

  it("failure: the reason is the tool's first error line; a missing sandbox-exec starts nothing", async () => {
    const host = fakeSandboxHost({ files: { "/usr/bin/sandbox-exec": "" }, outcome: failing("sandbox-exec: sandbox_apply: Operation not permitted") });
    expect(await probeSandbox(MAC, host)).toEqual({ ok: false, reason: "probe_failed_other", detail: "sandbox-exec: sandbox_apply: Operation not permitted" });
    const none = fakeSandboxHost();
    expect(reasonOf(await probeSandbox(MAC, none))).toBe("probe_failed_other");
    expect(none.calls).toEqual([]);
  });
});

describe("no fallback, no network, no secret", () => {
  it("on every failure, the only process ever started is the sandbox tool itself, with the network unshared: never the test command bare", async () => {
    install("bwrap", "socat");
    const outcomes = [failing("x"), failing("", null), { ...failing(""), timedOut: true }, { ...PASSING, stdout: "no" }];
    for (const outcome of outcomes) {
      const host = fakeSandboxHost({ outcome });
      expect((await probeSandbox(INPUT, host)).ok).toBe(false);
      for (const call of host.calls) {
        expect(call.command).toBe(path.join(tools, "bwrap"));
        expect(call.args).toContain("--unshare-net");
        expect(call.args.indexOf("--")).toBeGreaterThan(-1);
        expect(call.args.indexOf("/bin/sh")).toBeGreaterThan(call.args.indexOf("--"));
      }
    }
  });

  it("the sandbox tool gets the search path and nothing else of this shell: no token, key or home variable", async () => {
    install("bwrap", "socat");
    vi.stubEnv("ANTHROPIC_API_KEY", FAKE_TOKEN);
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", FAKE_TOKEN);
    const host = fakeSandboxHost();
    await probeSandbox(INPUT, host);
    expect(Object.keys(host.calls[0]!.env).sort()).toEqual(["LC_ALL", "PATH"]);
    expect(JSON.stringify(host.calls[0])).not.toContain(FAKE_TOKEN);
  });
});
