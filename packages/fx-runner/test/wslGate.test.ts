import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { SandboxRefused, detectPlatform, wslFacts } from "../src/sandbox/platform.js";
import { sandboxSettings } from "../src/sandbox/sandboxSettings.js";
import { bwrapArgs } from "../src/sandbox/probe.js";
import { WSL_CODES, wslDenyPaths, wslChecks } from "../src/sandbox/wslChecks.js";
import { CANARY_DIR, CMD_EXE, WSL_PROBE_CODES, clearWsl, type WslGateFacts, type WslGateResult } from "../src/sandbox/wslGate.js";
import { PACKAGE_DIR } from "./helpers/srcFiles.js";
import { ROOT_MOUNT, WSL2_KERNEL, fakeWslMachine, toolDir, type WslMachineOptions } from "./helpers/fakeWslMachine.js";

let searchPath: string;
beforeAll(() => {
  searchPath = toolDir();
});

const facts = (host: ReturnType<typeof fakeWslMachine>, over: Partial<WslGateFacts> = {}): WslGateFacts => ({ platform: "linux", osrelease: WSL2_KERNEL, home: "/home/dev", stateDir: "/home/dev/.local/state/fx", binaryPath: undefined, xdgCacheHome: undefined, searchPath, host, ...over });
const gate = async (options: WslMachineOptions = {}, over: Partial<WslGateFacts> = {}): Promise<{ host: ReturnType<typeof fakeWslMachine>; result: WslGateResult }> => {
  const host = fakeWslMachine(options);
  return { host, result: await clearWsl(facts(host, over)) };
};
const failures = (result: WslGateResult): string[] => result.items.filter((item) => !item.ok).map((item) => item.code);

describe("a WSL2 machine set up as the README says", () => {
  it("is cleared: every check and probe passes, in order, and the machine carries the clearance", async () => {
    const { host, result } = await gate();
    expect(result).toMatchObject({ wsl2: true, cleared: true, loopback: false });
    expect(result.items.map((item) => item.code)).toEqual([...WSL_CODES, "wsl_canary_readable", "wsl_exe_launchable"]);
    expect(host.wsl?.clearance?.denyPaths).toEqual(["/mnt", "/mnt/c", "/run/WSL"]);
    expect(detectPlatform({ platform: "linux", osrelease: WSL2_KERNEL, ...wslFacts(host.wsl) })).toBe("linux");
  });

  it("allows a loopback bind only when wslinfo says NAT; mirrored, anything else and no answer all refuse it", async () => {
    expect((await gate({ networking: "nat" })).result.loopback).toBe(true);
    for (const networking of ["mirrored", "virtioproxy", "", undefined]) expect((await gate({ networking })).result).toMatchObject({ cleared: true, loopback: false });
    expect((await gate({ networking: "nat", networkingExit: 1 })).result.loopback).toBe(false);
    expect((await gate({ networking: "nat" })).host.wsl?.clearance?.loopback).toBe(true);
    expect((await gate({ networking: "mirrored" })).host.wsl?.clearance?.loopback).toBe(false);
  });

  it("asks the canary and the program-launch probe through the sandbox tool, and the controls outside it", async () => {
    const { host } = await gate();
    const sandboxed = host.calls.filter((call) => call.command.endsWith("/bwrap"));
    expect(sandboxed).toHaveLength(3);
    const outside = host.calls.filter((call) => call.command === "/bin/sh").map((call) => call.args[1]);
    expect(outside).toEqual([`ls -A ${CANARY_DIR}`, `test -f ${CMD_EXE} && readlink -f ${CMD_EXE}`, "wslinfo --networking-mode"]);
  });
});

describe("the deny list is what makes the canary unreadable", () => {
  it("with no Windows drive in the mount table, /mnt alone hides the canary", async () => {
    const { result } = await gate({ mountinfo: ROOT_MOUNT });
    expect(result.cleared).toBe(true);
  });

  it("a sandbox that ignores its denies reads the canary: wsl_canary_readable, not cleared, no clearance left behind", async () => {
    const { host, result } = await gate({ honoursDenies: false });
    expect(failures(result)).toEqual(["wsl_canary_readable"]);
    expect(result.cleared).toBe(false);
    expect(host.wsl?.clearance).toBeUndefined();
  });

  it("denies /mnt, the /run/WSL host sockets and every Windows mount for both reads and writes, and hides each in bubblewrap", () => {
    const denyPaths = wslDenyPaths(fakeWslMachine().wsl);
    expect(denyPaths).toEqual(["/mnt", "/mnt/c", "/run/WSL"]);
    const settings = sandboxSettings({ workspace: "/home/dev/.cache/w/a", tempDir: "/home/dev/.cache/t/a", home: "/home/dev", stateDir: "/home/dev/.local/state/fx", binaryDir: "/home/dev/.local/bin", workspaceRoot: "/home/dev/.cache/w", tempRoot: "/home/dev/.cache/t", wslDenyPaths: denyPaths });
    const fs = settings.filesystem as { denyRead: string[]; denyWrite: string[] };
    for (const entry of denyPaths) {
      expect(fs.denyRead).toContain(entry);
      expect(fs.denyWrite).toContain(entry);
    }
    const args = bwrapArgs(settings, (target) => ["/mnt", "/run/WSL"].includes(target));
    expect(args.join(" ")).toContain("--tmpfs /mnt");
    expect(args.join(" ")).toContain("--tmpfs /run/WSL");
  });

  it("without the WSL input the lists hold none of it, and a bad or overlapping one is refused", () => {
    const base = { workspace: "/home/dev/.cache/w/a", tempDir: "/home/dev/.cache/t/a", home: "/home/dev", stateDir: "/home/dev/.local/state/fx", binaryDir: "/home/dev/.local/bin", workspaceRoot: "/home/dev/.cache/w", tempRoot: "/home/dev/.cache/t" };
    expect(JSON.stringify(sandboxSettings(base).filesystem)).not.toContain("/run/WSL");
    expect(() => sandboxSettings({ ...base, wslDenyPaths: ["mnt"] })).toThrow(/normalised absolute/);
    expect(() => sandboxSettings({ ...base, wslDenyPaths: ["/home/dev/.cache/w"] })).toThrow(/Windows-side/);
  });

  it("follows a symlinked /mnt: where it really is gets the same deny", () => {
    const wsl = fakeWslMachine({ links: { "/mnt": "/drives" } }).wsl;
    expect(wslDenyPaths(wsl)).toEqual(["/drives", "/mnt", "/mnt/c", "/run/WSL"]);
  });
});

describe("the real-path check on the /mnt directories", () => {
  const input = (links: Record<string, string>) => ({ fs: { readText: () => undefined, wsl: fakeWslMachine({ links }).wsl }, denyRead: ["/mnt"], denyWrite: ["/mnt"], directories: [["workspace directory", "/home/dev/ws"]] as Array<[string, string]> });

  it("a directory that is a link into /mnt fails wsl_mnt_path, and one that is not does not", () => {
    expect(wslChecks(input({ "/home/dev/ws": "/mnt/c/ws" })).find((finding) => finding.code === "wsl_mnt_path")).toMatchObject({ ok: false });
    expect(wslChecks(input({ "/home/dev/ws": "/srv/ws" })).find((finding) => finding.code === "wsl_mnt_path")).toMatchObject({ ok: true });
  });
});

describe("every probe and every control refuses when it does not hold", () => {
  it.each([
    ["no Windows drive to read outside the sandbox", { drive: false }, "wsl_no_windows_drive"],
    ["cmd.exe is not a file", { cmdExe: false }, "wsl_no_windows_drive"],
    ["cmd.exe is a link that lands elsewhere", { cmdRealPath: "/mnt/c/elsewhere/cmd.exe" }, "wsl_no_windows_drive"],
    ["the sandbox's marker command fails", { wrapperBroken: true }, "wsl_probe_unrun"],
    ["the sandbox prints nothing for a probe (no exit status)", { silentProbes: true }, "wsl_probe_unrun"],
    ["the drive listing outside the sandbox is empty and exits 0 (a hollow control)", { driveEmpty: true }, "wsl_no_windows_drive"],
    ["the drive lists but the listing fails", { driveExit: 1 }, "wsl_no_windows_drive"],
    ["a probe times out after printing its answer", { probesTimeOut: true }, "wsl_probe_unrun"],
    ["only the canary probe prints nothing", { silentOnly: "canary" }, "wsl_probe_unrun"],
    ["only the program-launch probe prints nothing", { silentOnly: "cmd" }, "wsl_probe_unrun"],
    ["ls answers 127 (the shell found no ls) for the canary", { canaryStatus: 127 }, "wsl_probe_unrun"],
    ["ls answers 126 for the canary", { canaryStatus: 126 }, "wsl_probe_unrun"],
    ["ls answers a minor status (1) for the canary", { canaryStatus: 1 }, "wsl_probe_unrun"],
    ["ls does not run at all in the sandbox", { lsMissing: true }, "wsl_probe_unrun"],
    ["the sandbox stands an empty directory at the canary (exit 0, empty listing)", { hollowCanary: true }, "wsl_canary_readable"],
    ["a process cannot be started", { throws: true }, "wsl_probe_unrun"],
    ["the sandbox times out", { timesOut: true }, "wsl_probe_unrun"],
    ["the sandbox ignores its denies and cmd.exe runs", { interopLive: true, honoursDenies: false }, "wsl_exe_launchable"],
  ] as Array<[string, WslMachineOptions, string]>)("%s", async (_name, options, code) => {
    const { host, result } = await gate(options);
    expect(failures(result)).toContain(code);
    expect(result.cleared).toBe(false);
    expect(host.wsl?.clearance).toBeUndefined();
    expect(() => detectPlatform({ platform: "linux", osrelease: WSL2_KERNEL, ...wslFacts(host.wsl) })).toThrow(SandboxRefused);
  });

  it("cmd.exe starting through a live interop is wsl_exe_launchable, even though the canary is hidden", async () => {
    const machine = fakeWslMachine({ interopLive: true });
    const inner = machine.run;
    // The canary stays hidden, but the program-launch probe is answered as if the interop reached out of the sandbox.
    machine.run = async (command, args, env, timeoutMs) => {
      const out = await inner(command, args, env, timeoutMs);
      return args[args.length - 1]?.includes("fx-wsl-cmd") === true ? { ...out, stdout: "fx-wsl-cmd\nfx-exit:0" } : out;
    };
    const result = await clearWsl(facts(machine));
    expect(failures(result)).toEqual(["wsl_exe_launchable"]);
    expect(machine.wsl?.clearance).toBeUndefined();
  });

  it("cmd.exe's own output in the sandbox is a failure even when the exit status is not zero", async () => {
    const machine = fakeWslMachine();
    const inner = machine.run;
    machine.run = async (command, args, env, timeoutMs) => {
      const out = await inner(command, args, env, timeoutMs);
      return args[args.length - 1]?.includes("fx-wsl-cmd") === true ? { ...out, stdout: "fx-wsl-cmd\nfx-exit:1" } : out;
    };
    expect(failures(await clearWsl(facts(machine)))).toEqual(["wsl_exe_launchable"]);
  });

  it("cmd.exe exiting zero is a failure even with no output at all", async () => {
    const machine = fakeWslMachine();
    const inner = machine.run;
    machine.run = async (command, args, env, timeoutMs) => {
      const out = await inner(command, args, env, timeoutMs);
      return args[args.length - 1]?.includes("fx-wsl-cmd") === true ? { ...out, stdout: "fx-exit:0" } : out;
    };
    expect(failures(await clearWsl(facts(machine)))).toEqual(["wsl_exe_launchable"]);
  });

  it("a clearance left from an earlier start is dropped when the machine is no longer WSL2", async () => {
    const host = fakeWslMachine();
    host.wsl!.clearance = { denyPaths: ["/mnt"], loopback: true };
    await clearWsl(facts(host, { osrelease: "6.6.0-generic" }));
    expect(host.wsl?.clearance).toBeUndefined();
  });

  it("a /mnt entry in the live PATH fails wsl_append_windows_path even when wsl.conf says false, and a Linux-only PATH does not", async () => {
    const { host, result } = await gate({}, { searchPath: `${searchPath}:/mnt/c/Windows/System32:/usr/bin` });
    expect(failures(result)).toEqual(["wsl_append_windows_path"]);
    expect(result.items.find((item) => !item.ok)?.detail).toContain("/mnt/c/Windows/System32");
    expect(host.calls).toEqual([]);
    expect((await gate({}, { searchPath: `${searchPath}:/usr/bin` })).result.cleared).toBe(true);
  });

  it("the shared machine object carries no clearance at any moment while the gate runs, and gets one only at the end of a full pass", async () => {
    const machine = fakeWslMachine();
    const seen: Array<unknown> = [];
    const inner = machine.run;
    machine.run = async (command, args, env, timeoutMs) => {
      seen.push(machine.wsl?.clearance);
      return inner(command, args, env, timeoutMs);
    };
    expect((await clearWsl(facts(machine))).cleared).toBe(true);
    expect(seen.length).toBeGreaterThan(4);
    expect(seen.every((value) => value === undefined)).toBe(true);
    expect(machine.wsl?.clearance).toBeDefined();
  });

  it("a failure at the very last probe still leaves no clearance, even when an earlier start left one", async () => {
    const machine = fakeWslMachine({ interopLive: true, honoursDenies: true });
    machine.wsl!.clearance = { denyPaths: ["/mnt"], loopback: true };
    const inner = machine.run;
    machine.run = async (command, args, env, timeoutMs) => {
      const out = await inner(command, args, env, timeoutMs);
      return args[args.length - 1]?.includes("fx-wsl-cmd") === true ? { ...out, stdout: "fx-wsl-cmd\nfx-exit:0" } : out;
    };
    expect((await clearWsl(facts(machine))).cleared).toBe(false);
    expect(machine.wsl?.clearance).toBeUndefined();
  });

  it("a failing check stops the gate before any process starts", async () => {
    const { host, result } = await gate({ files: { "/etc/wsl.conf": "" } });
    expect(failures(result)).toEqual(["wsl_interop_enabled", "wsl_append_windows_path"]);
    expect(host.calls).toEqual([]);
  });

  it("a mount table that cannot be read refuses (no vacuous pass)", async () => {
    const host = fakeWslMachine();
    host.wsl = { ...host.wsl!, mountinfo: () => undefined };
    const result = await clearWsl(facts(host));
    // #1063's check names it first (an unreadable table fails wsl_drvfs_exposed); the gate's own guard behind it is defence in depth.
    expect(failures(result)).toEqual(["wsl_drvfs_exposed"]);
    expect(host.calls).toEqual([]);
    expect(result.cleared).toBe(false);
  });

  it("an unknown home directory refuses", async () => {
    const { result } = await gate({}, { home: undefined });
    expect(result.cleared).toBe(false);
  });

  it("clears a clearance from an earlier start before deciding afresh", async () => {
    const host = fakeWslMachine({ drive: false });
    host.wsl!.clearance = { denyPaths: ["/mnt"], loopback: true };
    expect((await clearWsl(facts(host))).cleared).toBe(false);
    expect(host.wsl?.clearance).toBeUndefined();
  });

  it("anything that is not WSL2 is left alone: no process, nothing checked", async () => {
    for (const over of [{ osrelease: "6.6.0-generic" }, { platform: "darwin" as const }]) {
      const host = fakeWslMachine();
      expect(await clearWsl(facts(host, over))).toEqual({ wsl2: false, cleared: false, items: [], loopback: false });
      expect(host.calls).toEqual([]);
    }
  });
});

describe("WSL2 is refused without the clearance", () => {
  it("detectPlatform throws wsl2_unsupported unless wslCleared is true, for both ways of finding WSL2", () => {
    for (const probe of [{ osrelease: WSL2_KERNEL }, { osrelease: "6.6.0-custom", wslInterop: true }]) {
      expect(() => detectPlatform({ platform: "linux", ...probe })).toThrow(/^wsl2_unsupported: /);
      expect(() => detectPlatform({ platform: "linux", ...probe, wslCleared: false })).toThrow(SandboxRefused);
      expect(detectPlatform({ platform: "linux", ...probe, wslCleared: true })).toBe("linux");
    }
  });

  it("the clearance never lifts WSL1 or native Windows", () => {
    expect(() => detectPlatform({ platform: "linux", osrelease: "4.4.0-19041-Microsoft", wslCleared: true })).toThrow(/^wsl1_unsupported: /);
    expect(() => detectPlatform({ platform: "win32", wslCleared: true })).toThrow(/^windows_unsupported: /);
  });
});

describe("the README names every closed code", () => {
  it("probe codes too", () => {
    const readme = readFileSync(path.join(PACKAGE_DIR, "README.md"), "utf8");
    for (const code of WSL_PROBE_CODES) expect(readme).toContain(`\`${code}\``);
    expect(readme).toContain("`WSL2: VM mode not supported`");
  });
});
