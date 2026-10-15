import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandContext } from "../../src/context.js";
import { LAUNCHD_LABEL, SYSTEMD_UNIT_NAME, SYSTEM_PATH_ENTRIES, renderLaunchdPlist, renderSystemdUnit, serviceCommand, type ServiceHost, type UnitInput } from "../../src/commands/service.js";
import { runCli } from "../../src/cli.js";

// Every file here is written under a throwaway root directory (`ServiceHost.root`); nothing under the real /etc, /Library or home is read or written.
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const golden = (name: string): string => readFileSync(path.join(FIXTURES, name), "utf8");

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fxr-sysservice-"));
  home = path.join(root, "home");
  mkdirSync(home);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const COMMAND = ["/opt/fx-runner/bin/node", "/opt/fx-runner/bin/fx-runner.mjs", "run"];
const PATH_VALUE = "/usr/bin:/opt/fx-runner/bin:/home/someone/.local/bin";
const PASSWD = ["root:x:0:0:root:/root:/bin/bash", "alex:x:1000:1000:Alex:/home/alex:/bin/bash", "fxrunner:x:998:998::/var/lib/fx-runner:/usr/sbin/nologin", "toor:x:0:0:second root:/root:/bin/sh", ""].join("\n");

/** Every path is a root-owned 0755 directory or file unless a test says otherwise. */
const SAFE_MODE = 0o755;
function hostOf(over: Partial<ServiceHost> = {}): ServiceHost {
  return {
    home,
    platform: "linux",
    command: COMMAND,
    path: PATH_VALUE,
    root: path.join(root, "fs"),
    passwd: () => PASSWD,
    lstat: () => ({ mode: SAFE_MODE, isSymbolicLink: false }),
    accountUid: (name) => (name === "fxrunner" ? 501 : name === "toor" ? 0 : null),
    ...over,
  };
}

function run(action: string | undefined, over: { host?: Partial<ServiceHost>; user?: string | undefined; bypassFile?: string } = {}): { code: number; out: string } {
  const lines: string[] = [];
  const ctx: CommandContext = { stateDir: path.join(home, ".fx-runner"), out: (l) => lines.push(l), err: (l) => lines.push(l), now: () => new Date(), fetchFn: fetch, ...(over.bypassFile === undefined ? {} : { bypassFile: over.bypassFile }) };
  const code = serviceCommand(action, ctx, hostOf(over.host), { system: true, user: "user" in over ? over.user : "fxrunner" });
  return { code, out: lines.join("\n") };
}

const unitFile = (): string => path.join(root, "fs", "etc", "systemd", "system", SYSTEMD_UNIT_NAME);
const daemonFile = (): string => path.join(root, "fs", "Library", "LaunchDaemons", `${LAUNCHD_LABEL}.plist`);

describe("the system unit (Linux)", () => {
  it("equals the pinned golden file: User=, NoNewPrivileges=yes, ProtectSystem=strict, ProtectHome=yes, a writable state directory only", () => {
    expect(run("install").code).toBe(0);
    const text = readFileSync(unitFile(), "utf8");
    expect(text).toBe(golden("fx-runner.system.service"));
    for (const line of ["User=fxrunner", "NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=yes", "StateDirectory=fx-runner", "WantedBy=multi-user.target"]) expect(text.split("\n")).toContain(line);
    // Nothing under /home reaches the unit, and none of the installing environment's PATH does.
    expect(text).not.toContain("/home/");
  });

  it("does not inherit the installing environment's PATH: any PATH there is gives the same fixed one", () => {
    for (const hostPath of [PATH_VALUE, "/tmp/evil:/var/tmp:relative/bin", undefined, ""]) {
      run("install", { host: { path: hostPath } });
      const line = readFileSync(unitFile(), "utf8").split("\n").find((l) => l.startsWith('Environment="PATH='));
      expect(line).toBe(`Environment="PATH=${SYSTEM_PATH_ENTRIES.join(":")}"`);
    }
  });

  it("is the render function's output, so the golden file pins the real code path", () => {
    const input: UnitInput = { command: COMMAND, pathEntries: SYSTEM_PATH_ENTRIES, stateDir: "/var/lib/fx-runner", logFile: "/var/lib/fx-runner/service.log", system: { user: "fxrunner" } };
    expect(renderSystemdUnit(input)).toBe(golden("fx-runner.system.service"));
  });

  it("the per-user unit is unchanged: no User=, no hardening lines, default.target", () => {
    const text = renderSystemdUnit({ command: COMMAND, pathEntries: [], logFile: "/x/service.log" });
    expect(text).not.toMatch(/^User=|NoNewPrivileges|ProtectSystem|ProtectHome|StateDirectory/m);
    expect(text).toContain("WantedBy=default.target");
  });

  it("prints how to create the state directory, register as the account and start it, and starts nothing itself", () => {
    const result = run("install");
    expect(result.out).toContain("install -d -m 0700 -o fxrunner /var/lib/fx-runner");
    expect(result.out).toContain("sudo -u fxrunner env FX_RUNNER_HOME=/var/lib/fx-runner fx-runner register --code-stdin");
    expect(result.out).toContain("systemctl enable --now fx-runner.service");
    expect(result.out).not.toContain("systemctl --user");
    // Only the one unit file was written, and no state directory.
    expect(readdirSync(path.dirname(unitFile()))).toEqual([SYSTEMD_UNIT_NAME]);
    expect(existsSync(path.join(root, "fs", "var"))).toBe(false);
  });

  it("is idempotent: the same file again changes nothing", () => {
    run("install");
    const before = lstatSync(unitFile()).mtimeMs;
    expect(run("install").out).toContain("Already installed");
    expect(lstatSync(unitFile()).mtimeMs).toBe(before);
  });

  it.skipIf(process.getuid?.() === 0)("a root directory this user cannot write answers service_needs_root, not a bare permission error", () => {
    mkdirSync(path.join(root, "fs"), { mode: 0o500 });
    expect(() => run("install")).toThrow(/service_needs_root.*sudo/);
  });

  it("uninstall --system removes the file it wrote, and says so when there is none", () => {
    expect(run("uninstall").out).toContain("Not installed");
    run("install");
    const removed = run("uninstall");
    expect(removed.out).toContain("Removed");
    expect(removed.out).toContain("systemctl disable --now fx-runner.service");
    expect(existsSync(unitFile())).toBe(false);
  });

  it("never overwrites or removes a file it did not write, or a link", () => {
    mkdirSync(path.dirname(unitFile()), { recursive: true });
    writeFileSync(unitFile(), "[Unit]\nDescription=mine\n");
    expect(() => run("install")).toThrow(/service_unit_foreign/);
    expect(() => run("uninstall")).toThrow(/service_unit_foreign/);
    expect(readFileSync(unitFile(), "utf8")).toBe("[Unit]\nDescription=mine\n");
    rmSync(unitFile());
    symlinkSync(path.join(root, "elsewhere"), unitFile());
    expect(() => run("install")).toThrow(/service_unit_foreign/);
  });
});

describe("the account", () => {
  it("--system without --user refuses, whoever runs it, and writes nothing", () => {
    for (const user of [undefined, ""]) {
      expect(() => run("install", { user })).toThrow(/service_user_required/);
    }
    expect(existsSync(path.join(root, "fs"))).toBe(false);
  });

  it("refuses root by name or by user id 0, an unknown account, and a name that is not a plain account name", () => {
    expect(() => run("install", { user: "root" })).toThrow(/service_user_root/);
    expect(() => run("install", { user: "toor" })).toThrow(/user id 0/);
    expect(() => run("install", { user: "nobody-here" })).toThrow(/service_user_unknown.*useradd --system/);
    for (const bad of ["Alex", "a b", "x;y", "../x", "a\nUser=root", "-x", "x".repeat(33)]) expect(() => run("install", { user: bad })).toThrow(/service_user_invalid/);
    expect(existsSync(path.join(root, "fs"))).toBe(false);
  });

  it("refuses when the account list cannot be read", () => {
    expect(() => run("install", { host: { passwd: () => undefined } })).toThrow(/service_user_unchecked/);
    expect(() => run("install", { host: { passwd: undefined } })).toThrow(/service_user_unchecked/);
  });

  it("the command line carries the same checks (exit code 2 for a missing account, --user only with --system)", async () => {
    const lines: string[] = [];
    const base = { home, stateDirOverride: path.join(home, ".fx-runner"), stdout: (t: string) => lines.push(t), stderr: (t: string) => lines.push(t), serviceHost: hostOf() };
    expect(await runCli({ ...base, argv: ["service", "install", "--system"] })).toBe(2);
    expect(await runCli({ ...base, argv: ["service", "install", "--user", "fxrunner"] })).toBe(2);
    expect(await runCli({ ...base, argv: ["service", "install", "--system", "--user", "root"] })).toBe(2);
    expect(await runCli({ ...base, argv: ["service", "install", "--system", "--user", "fxrunner"] })).toBe(0);
    expect(readFileSync(unitFile(), "utf8")).toBe(golden("fx-runner.system.service"));
    expect(lines.join("")).toContain("service_user_required");
  });
});

describe("paths a system service cannot see", () => {
  it("refuses a program under /home or /root, and says where to install it instead", () => {
    for (const bad of ["/home/alex/.fx-runner/bin/fx-runner", "/root/fx/fx-runner", "/run/user/1000/x"]) {
      expect(() => run("install", { host: { command: [bad, "run"] } })).toThrow(/service_path_unsupported.*cannot see \/home or \/root.*\/opt\/fx-runner/);
    }
    expect(existsSync(path.join(root, "fs"))).toBe(false);
  });

  it("does not run the stable path of the person who installs it: an installed version under their home is refused, not rewritten to ~/.fx-runner/bin", () => {
    const stateDir = path.join(home, ".fx-runner");
    const versioned = path.join(stateDir, "versions", "1.2.3", "fx-runner");
    // The per-user service would run `<state dir>/bin/fx-runner`; a system service runs the command as given, and refuses one under /home.
    expect(() => run("install", { host: { execPath: "/home/alex/.fx-runner/versions/1.2.3/fx-runner", command: ["/home/alex/.fx-runner/versions/1.2.3/fx-runner", "run"] } })).toThrow(/service_path_unsupported/);
    run("install", { host: { execPath: versioned, command: COMMAND } });
    const unit = readFileSync(unitFile(), "utf8");
    expect(unit).toContain("ExecStart=/opt/fx-runner/bin/node /opt/fx-runner/bin/fx-runner.mjs run");
    expect(unit).not.toContain(".fx-runner");
  });

  it("refuses a protection bypass file under /home, and writes a bypass file elsewhere into the unit as a path only", () => {
    expect(() => run("install", { bypassFile: "/home/alex/bypass" })).toThrow(/service_path_unsupported.*bypass/i);
    run("install", { bypassFile: "/etc/fx-runner/bypass" });
    expect(readFileSync(unitFile(), "utf8")).toContain('Environment="FX_RUNNER_PROTECTION_BYPASS_FILE=/etc/fx-runner/bypass"');
  });

  it("refuses a program that a group or everyone can write, in the file or in any directory above it, and one it cannot examine", () => {
    const only = (bad: string, mode: number) => (file: string) => ({ mode: file === bad ? mode : SAFE_MODE, isSymbolicLink: false });
    for (const [where, mode] of [["/opt/fx-runner/bin/fx-runner.mjs", 0o666], ["/opt/fx-runner/bin/node", 0o775], ["/opt/fx-runner/bin", 0o770], ["/opt/fx-runner", 0o757], ["/opt", 0o777], ["/", 0o775]] as const) {
      expect(() => run("install", { host: { lstat: only(where, mode) } }), `${where} ${mode.toString(8)}`).toThrow(/service_program_unsafe.*group or by everyone/);
    }
    expect(() => run("install", { host: { lstat: (file) => ({ mode: SAFE_MODE, isSymbolicLink: file === "/opt/fx-runner" }) } })).toThrow(/service_program_unsafe.*is a link/);
    expect(() => run("install", { host: { lstat: (file) => (file === "/opt" ? undefined : { mode: SAFE_MODE, isSymbolicLink: false }) } })).toThrow(/service_program_unchecked/);
    expect(() => run("install", { host: { lstat: undefined } })).toThrow(/service_program_unchecked/);
    expect(existsSync(path.join(root, "fs"))).toBe(false);
  });

  it("the check reads the real file system the way the program does: a group-writable directory is named and refused", () => {
    const dir = path.join(root, "fs-real");
    mkdirSync(dir);
    const program = path.join(dir, "fx-runner.mjs");
    writeFileSync(program, "");
    chmodSync(program, 0o644);
    const real = (file: string) => {
      const info = lstatSync(file);
      return { mode: info.mode, isSymbolicLink: info.isSymbolicLink() };
    };
    // Only the directory made here is toggled (the temporary directory above it is not this test's to judge), so the error must name it.
    chmodSync(dir, 0o775);
    expect(() => run("install", { host: { command: [program, "run"], lstat: real } })).toThrow(new RegExp(`service_program_unsafe: ${dir}`));
  });

  it("still refuses a path with a space, a quote or a dollar sign", () => {
    for (const bad of ["/opt/fx runner/x", '/opt/a"b/x', "/opt/$x/x", "/opt/a%b/x"]) {
      expect(() => run("install", { host: { command: [bad, "run"] } })).toThrow(/service_path_unsupported/);
    }
  });
});

describe("the LaunchDaemon (macOS)", () => {
  it("equals the pinned golden file and has UserName", () => {
    expect(run("install", { host: { platform: "darwin" } }).code).toBe(0);
    const text = readFileSync(daemonFile(), "utf8");
    expect(text).toBe(golden("fx-runner.system.plist"));
    expect(text).toContain("<key>UserName</key>\n  <string>fxrunner</string>");
  });

  it("is the render function's output", () => {
    const input: UnitInput = { command: COMMAND, pathEntries: SYSTEM_PATH_ENTRIES, stateDir: "/usr/local/var/fx-runner", logFile: "/Library/Logs/fx-runner/service.log", system: { user: "fxrunner" } };
    expect(renderLaunchdPlist(input)).toBe(golden("fx-runner.system.plist"));
  });

  it("the per-user agent has no UserName", () => {
    expect(renderLaunchdPlist({ command: COMMAND, pathEntries: [], logFile: "/x/service.log" })).not.toContain("UserName");
  });

  it("refuses root by name, writes into LaunchDaemons and prints the system launchctl commands", () => {
    expect(() => run("install", { host: { platform: "darwin" }, user: "root" })).toThrow(/service_user_root/);
    const result = run("install", { host: { platform: "darwin" } });
    expect(result.out).toContain(`launchctl bootstrap system "${daemonFile()}"`);
    expect(result.out).toContain("install -d -m 0700 -o fxrunner /usr/local/var/fx-runner");
    expect(run("uninstall", { host: { platform: "darwin" } }).out).toContain(`launchctl bootout system/${LAUNCHD_LABEL}`);
  });

  it("uses a root-owned log directory, not the account's state directory, and tells the person to create it", () => {
    const result = run("install", { host: { platform: "darwin" } });
    const text = readFileSync(daemonFile(), "utf8");
    expect(text).toContain("<key>StandardOutPath</key>\n  <string>/Library/Logs/fx-runner/service.log</string>");
    expect(text).toContain("<key>StandardErrorPath</key>\n  <string>/Library/Logs/fx-runner/service.log</string>");
    expect(text).not.toContain("/usr/local/var/fx-runner/service.log");
    expect(result.out).toContain("install -d -m 0755 -o root -g wheel /Library/Logs/fx-runner");
  });

  it("checks the account through the lookup: unknown, user id 0 and a failed lookup are refused before anything is written", () => {
    const calls: string[] = [];
    const lookup = (value: number | null | undefined) => (name: string) => {
      calls.push(name);
      return value;
    };
    expect(() => run("install", { host: { platform: "darwin", accountUid: lookup(null) } })).toThrow(/service_user_unknown/);
    expect(() => run("install", { host: { platform: "darwin", accountUid: lookup(0) } })).toThrow(/service_user_root.*user id 0/);
    expect(() => run("install", { host: { platform: "darwin", accountUid: lookup(undefined) } })).toThrow(/service_user_unchecked/);
    expect(() => run("install", { host: { platform: "darwin", accountUid: undefined } })).toThrow(/service_user_unchecked/);
    expect(calls).toEqual(["fxrunner", "fxrunner", "fxrunner"]);
    expect(existsSync(path.join(root, "fs"))).toBe(false);
    expect(run("install", { host: { platform: "darwin", accountUid: lookup(501) } }).code).toBe(0);
  });

  it("passes plutil -lint (on a Mac this must run: a missing plutil there is a failure, not a skip)", () => {
    const probe = spawnSync("plutil", ["-help"], { encoding: "utf8" });
    if (probe.error !== undefined) {
      // Not a Mac: the golden file test above pins the text. On a Mac, silence would hide a leg that did not run.
      expect(process.platform, "plutil is missing on macOS, so the LaunchDaemon file was not linted").not.toBe("darwin");
      return;
    }
    run("install", { host: { platform: "darwin" } });
    const lint = spawnSync("plutil", ["-lint", daemonFile()], { encoding: "utf8" });
    expect(lint.status, lint.stdout + lint.stderr).toBe(0);
  });
});

describe("systemd-analyze verify", () => {
  it("accepts the system unit's syntax and directives where systemd-analyze exists (the Linux CI leg)", () => {
    const probe = spawnSync("systemd-analyze", ["--version"], { encoding: "utf8" });
    if (probe.error !== undefined || probe.status !== 0) return;
    run("install", { host: { command: ["/bin/sh", "run"] } });
    const verify = spawnSync("systemd-analyze", ["verify", unitFile()], { encoding: "utf8" });
    // Only the properties are judged: the account and the program are not on this machine, which verify reports separately.
    const complaints = (verify.stdout + verify.stderr).split("\n").filter((l) => /Unknown (key|section|lvalue)|Invalid|not a valid|Failed to parse|bad (setting|unit)/i.test(l));
    expect(complaints).toEqual([]);
  });
});
