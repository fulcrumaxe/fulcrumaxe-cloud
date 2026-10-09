import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError } from "../../src/cliError.js";
import type { CommandContext } from "../../src/context.js";
import { LAUNCHD_LABEL, SERVICE_MARKER, SYSTEMD_UNIT_NAME, renderLaunchdPlist, renderSystemdUnit, serviceCommand, type ServiceHost } from "../../src/commands/service.js";
import { runCli } from "../../src/cli.js";
import { MACOS_PREVIEW_NOTICE } from "../../src/platformSupport.js";

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fxr-service-"));
  home = path.join(root, "home");
  mkdirSync(home);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const COMMAND = ["/opt/node/bin/node", "/opt/fx-runner/bin/fx-runner.mjs", "run"];
const hostOf = (over: Partial<ServiceHost> = {}): ServiceHost => ({ home, platform: "linux", xdgConfigHome: undefined, command: COMMAND, path: "/usr/bin:/home/someone/.local/bin", ...over });

function run(action: string | undefined, over: { host?: Partial<ServiceHost>; stateDir?: string; bypassFile?: string } = {}): { code: number; out: string } {
  const lines: string[] = [];
  const ctx: CommandContext = { stateDir: over.stateDir ?? path.join(home, ".fx-runner"), out: (l) => lines.push(l), err: (l) => lines.push(l), now: () => new Date(), fetchFn: fetch, ...(over.bypassFile === undefined ? {} : { bypassFile: over.bypassFile }) };
  const code = serviceCommand(action, ctx, hostOf(over.host));
  return { code, out: lines.join("\n") };
}

const linuxFile = (): string => path.join(home, ".config", "systemd", "user", SYSTEMD_UNIT_NAME);
const macFile = (): string => path.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);

describe("the generated text, exactly", () => {
  it("systemd unit with the default state directory", () => {
    expect(renderSystemdUnit({ command: COMMAND, pathEntries: ["/usr/bin", "/home/someone/.local/bin"], logFile: "/home/someone/.fx-runner/service.log" })).toBe(
      [
        "# Managed by fx-runner service install. Run it again to rewrite this file; fx-runner service uninstall removes it.",
        "[Unit]",
        "Description=fulcrumaxe local runner",
        "",
        "[Service]",
        "Type=simple",
        "ExecStart=/opt/node/bin/node /opt/fx-runner/bin/fx-runner.mjs run",
        'Environment="PATH=/usr/bin:/home/someone/.local/bin"',
        "Restart=on-failure",
        "RestartSec=30",
        "TimeoutStopSec=20",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n"),
    );
  });

  it("systemd unit with another state directory and no PATH", () => {
    const text = renderSystemdUnit({ command: COMMAND, pathEntries: [], stateDir: "/srv/fx", logFile: "/srv/fx/service.log" });
    expect(text).toContain('Environment="FX_RUNNER_HOME=/srv/fx"');
    expect(text).not.toContain("PATH=");
  });

  it("launchd agent", () => {
    expect(renderLaunchdPlist({ command: COMMAND, pathEntries: ["/usr/bin", "/opt/homebrew/bin"], logFile: "/Users/someone/.fx-runner/service.log" })).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        "<!-- Managed by fx-runner service install. Run it again to rewrite this file; fx-runner service uninstall removes it. -->",
        '<plist version="1.0">',
        "<dict>",
        "  <key>Label</key>",
        "  <string>dev.fulcrumaxe.fx-runner</string>",
        "  <key>ProgramArguments</key>",
        "  <array>",
        "    <string>/opt/node/bin/node</string>",
        "    <string>/opt/fx-runner/bin/fx-runner.mjs</string>",
        "    <string>run</string>",
        "  </array>",
        "  <key>EnvironmentVariables</key>",
        "  <dict>",
        "    <key>PATH</key>",
        "    <string>/usr/bin:/opt/homebrew/bin</string>",
        "  </dict>",
        "  <key>RunAtLoad</key>",
        "  <true/>",
        "  <key>KeepAlive</key>",
        "  <dict>",
        "    <key>SuccessfulExit</key>",
        "    <false/>",
        "  </dict>",
        "  <key>ThrottleInterval</key>",
        "  <integer>30</integer>",
        "  <key>StandardOutPath</key>",
        "  <string>/Users/someone/.fx-runner/service.log</string>",
        "  <key>StandardErrorPath</key>",
        "  <string>/Users/someone/.fx-runner/service.log</string>",
        "</dict>",
        "</plist>",
        "",
      ].join("\n"),
    );
  });

  it("both formats open with the marker the uninstall path looks for", () => {
    expect(renderSystemdUnit({ command: COMMAND, pathEntries: [], logFile: "/l" })).toContain(SERVICE_MARKER);
    expect(renderLaunchdPlist({ command: COMMAND, pathEntries: [], logFile: "/l" })).toContain(SERVICE_MARKER);
  });
});

describe("the protection bypass file's path in the unit", () => {
  const FILE = "/srv/runner/bypass-file";

  it("systemd carries the path as an Environment line, and launchd as an EnvironmentVariables entry", () => {
    expect(renderSystemdUnit({ command: COMMAND, pathEntries: [], bypassFile: FILE, logFile: "/l" })).toContain(`Environment="FX_RUNNER_PROTECTION_BYPASS_FILE=${FILE}"`);
    const plist = renderLaunchdPlist({ command: COMMAND, pathEntries: [], bypassFile: FILE, logFile: "/l" });
    expect(plist).toContain(`<key>FX_RUNNER_PROTECTION_BYPASS_FILE</key>\n    <string>${FILE}</string>`);
  });

  it("without the variable neither unit mentions it", () => {
    expect(renderSystemdUnit({ command: COMMAND, pathEntries: [], logFile: "/l" })).not.toContain("PROTECTION_BYPASS");
    expect(renderLaunchdPlist({ command: COMMAND, pathEntries: [], logFile: "/l" })).not.toContain("PROTECTION_BYPASS");
  });

  it("install writes the path, never the secret: the file is not even read", () => {
    const file = path.join(root, "bypass");
    // Built at run time, so a secret scanner finds no literal that looks like a live key.
    const value = ["the", "bypass", "value", "0123"].join("-");
    writeFileSync(file, `${value}\n`, { mode: 0o600 });
    expect(run("install", { bypassFile: file }).code).toBe(0);
    const text = readFileSync(linuxFile(), "utf8");
    expect(text).toContain(`Environment="FX_RUNNER_PROTECTION_BYPASS_FILE=${file}"`);
    expect(text).not.toContain(value);
    expect(run("install", { host: { platform: "darwin" }, bypassFile: file }).code).toBe(0);
    const plist = readFileSync(macFile(), "utf8");
    expect(plist).toContain(file);
    expect(plist).not.toContain(value);
  });

  it("an empty variable adds nothing, a changed path rewrites the same unit, and removing it rewrites it without", () => {
    run("install", { bypassFile: "" });
    expect(readFileSync(linuxFile(), "utf8")).not.toContain("PROTECTION_BYPASS");
    run("install", { bypassFile: "/srv/a" });
    expect(readFileSync(linuxFile(), "utf8")).toContain("PROTECTION_BYPASS_FILE=/srv/a");
    run("install", { bypassFile: "/srv/b" });
    const text = readFileSync(linuxFile(), "utf8");
    expect(text).toContain("PROTECTION_BYPASS_FILE=/srv/b");
    expect(text).not.toContain("/srv/a");
    run("install");
    expect(readFileSync(linuxFile(), "utf8")).not.toContain("PROTECTION_BYPASS");
  });

  it("a relative path, or one with a space or quote, is refused and nothing is written", () => {
    for (const bad of ["relative/file", "/srv/has space", '/srv/q"uote']) {
      expect(() => run("install", { bypassFile: bad }), bad).toThrow(/service_path_unsupported/);
    }
    expect(existsSync(linuxFile())).toBe(false);
  });

  it("through the command line the variable reaches the unit", async () => {
    const file = path.join(root, "cli-bypass");
    const code = await runCli({ argv: ["service", "install"], home, stateDirOverride: path.join(home, ".fx-runner"), stdout: () => undefined, stderr: () => undefined, protectionBypassFile: file, serviceHost: hostOf() });
    expect(code).toBe(0);
    expect(readFileSync(linuxFile(), "utf8")).toContain(`FX_RUNNER_PROTECTION_BYPASS_FILE=${file}`);
  });
});

describe("install on Linux", () => {
  it("writes the user unit under ~/.config/systemd/user and prints the command that starts it, without starting anything", () => {
    const result = run("install");
    expect(result.code).toBe(0);
    expect(existsSync(linuxFile())).toBe(true);
    const text = readFileSync(linuxFile(), "utf8");
    expect(text).toContain("ExecStart=/opt/node/bin/node /opt/fx-runner/bin/fx-runner.mjs run");
    expect(text).toContain('Environment="PATH=/usr/bin:/home/someone/.local/bin"');
    expect(text).not.toContain("FX_RUNNER_HOME");
    expect(result.out).toContain("systemctl --user enable --now fx-runner.service");
    expect(result.out).toContain("not registered yet");
  });

  it("honours an absolute XDG_CONFIG_HOME and ignores a relative one", () => {
    const xdg = path.join(root, "xdg");
    run("install", { host: { xdgConfigHome: xdg } });
    expect(existsSync(path.join(xdg, "systemd", "user", SYSTEMD_UNIT_NAME))).toBe(true);
    expect(existsSync(linuxFile())).toBe(false);
    run("install", { host: { xdgConfigHome: "relative/dir" } });
    expect(existsSync(linuxFile())).toBe(true);
  });

  it("is idempotent: the same install again leaves the file byte for byte and says so", () => {
    run("install");
    const before = readFileSync(linuxFile());
    const mtime = lstatSync(linuxFile()).mtimeMs;
    const again = run("install");
    expect(again.out).toContain("Already installed");
    expect(readFileSync(linuxFile()).equals(before)).toBe(true);
    expect(lstatSync(linuxFile()).mtimeMs).toBe(mtime);
    expect(readdirSync(path.dirname(linuxFile()))).toEqual([SYSTEMD_UNIT_NAME]);
  });

  it("allows exactly one instance per user: a different command or state directory rewrites the same file, never adds a second", () => {
    run("install");
    const second = run("install", { host: { command: ["/opt/node/bin/node", "/opt/other/fx-runner.mjs", "run"] }, stateDir: path.join(root, "other-state") });
    expect(second.out).toContain("Updated");
    expect(readdirSync(path.dirname(linuxFile()))).toEqual([SYSTEMD_UNIT_NAME]);
    const text = readFileSync(linuxFile(), "utf8");
    expect(text).toContain("/opt/other/fx-runner.mjs");
    expect(text).not.toContain("/opt/fx-runner/bin");
    expect(text).toContain(`FX_RUNNER_HOME=${path.join(root, "other-state")}`);
    expect(text.match(/ExecStart=/g)).toHaveLength(1);
    expect(text).not.toMatch(/%i|@\./);
  });

  it("drops PATH entries that are relative or not plain", () => {
    run("install", { host: { path: "/usr/bin:relative/bin::/has space/bin:/ok/bin" } });
    expect(readFileSync(linuxFile(), "utf8")).toContain('Environment="PATH=/usr/bin:/ok/bin"');
  });
});

describe("install on macOS", () => {
  it("writes the launch agent under ~/Library/LaunchAgents, prints the bootstrap command and the preview notice", () => {
    const result = run("install", { host: { platform: "darwin" } });
    expect(readFileSync(macFile(), "utf8")).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(result.out).toContain(`launchctl bootstrap gui/$(id -u) "${macFile()}"`);
    expect(result.out).toContain(MACOS_PREVIEW_NOTICE);
    expect(existsSync(linuxFile())).toBe(false);
  });

  it("is idempotent and keeps one agent", () => {
    run("install", { host: { platform: "darwin" } });
    expect(run("install", { host: { platform: "darwin" } }).out).toContain("Already installed");
    expect(readdirSync(path.dirname(macFile()))).toEqual([`${LAUNCHD_LABEL}.plist`]);
  });
});

describe("uninstall", () => {
  it("removes the file this command wrote, prints how to stop the running service, and is idempotent", () => {
    run("install");
    const result = run("uninstall");
    expect(existsSync(linuxFile())).toBe(false);
    expect(result.out).toContain("systemctl --user disable --now fx-runner.service");
    const again = run("uninstall");
    expect(again.code).toBe(0);
    expect(again.out).toContain("Not installed");
  });

  it("removes the macOS agent and prints bootout", () => {
    run("install", { host: { platform: "darwin" } });
    const result = run("uninstall", { host: { platform: "darwin" } });
    expect(existsSync(macFile())).toBe(false);
    expect(result.out).toContain(`launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL}`);
  });
});

describe("a file this command did not write is never touched", () => {
  const refuses = (action: string): void => {
    expect(() => run(action)).toThrow(CliError);
    expect(() => run(action)).toThrow(/service_unit_foreign/);
  };

  it("a plain file without the marker: install and uninstall both refuse, and it stays as it was", () => {
    mkdirSync(path.dirname(linuxFile()), { recursive: true });
    writeFileSync(linuxFile(), "[Service]\nExecStart=/bin/true\n");
    refuses("install");
    refuses("uninstall");
    expect(readFileSync(linuxFile(), "utf8")).toBe("[Service]\nExecStart=/bin/true\n");
  });

  it("a file that only mentions the marker further down is not ours", () => {
    mkdirSync(path.dirname(linuxFile()), { recursive: true });
    const text = `[Service]\nExecStart=/opt/x\n\n\n# ${SERVICE_MARKER}\n`;
    writeFileSync(linuxFile(), text);
    refuses("install");
    refuses("uninstall");
    expect(readFileSync(linuxFile(), "utf8")).toBe(text);
  });

  it("a link at the unit's path (a dotfile manager's) is refused, and its target is not written through", () => {
    mkdirSync(path.dirname(linuxFile()), { recursive: true });
    const target = path.join(root, "managed.service");
    writeFileSync(target, "managed\n");
    symlinkSync(target, linuxFile());
    refuses("install");
    refuses("uninstall");
    expect(readFileSync(target, "utf8")).toBe("managed\n");
    expect(lstatSync(linuxFile()).isSymbolicLink()).toBe(true);
  });
});

describe("refusals", () => {
  it("a platform with no service manager here", () => {
    expect(() => run("install", { host: { platform: "win32" } })).toThrow(/service_unsupported/);
    expect(() => run("install", { host: { platform: "freebsd" } })).toThrow(/service_unsupported/);
  });

  it.each(["/has space/node", "/has\"quote/node", "/pct%i/node", "/dollar$HOME/node", "/new\nline/node", "relative/node"])("a command path the unit cannot hold plainly is refused: %j", (bad) => {
    expect(() => run("install", { host: { command: [bad, "/opt/fx-runner/bin/fx-runner.mjs", "run"] } })).toThrow(/service_path_unsupported/);
    expect(existsSync(linuxFile())).toBe(false);
  });

  it("a state directory with an odd character is refused, and a command that does not end in run is refused", () => {
    expect(() => run("install", { stateDir: path.join(root, "has space") })).toThrow(/service_path_unsupported/);
    expect(() => run("install", { host: { command: ["/opt/node/bin/node", "/opt/x.mjs"] } })).toThrow(/must end with run/);
    expect(() => run("install", { host: { command: ["/opt/node/bin/node", "/opt/x.mjs", "status"] } })).toThrow(/must end with run/);
  });

  it("no action, or an unknown one, is a usage error", () => {
    for (const action of [undefined, "start", "Install"]) expect(() => run(action)).toThrow(expect.objectContaining({ exitCode: 2 }));
  });
});

describe("through the command line", () => {
  const cli = async (argv: string[], serviceHost?: ServiceHost): Promise<{ code: number; err: string }> => {
    let err = "";
    const code = await runCli({ argv, home, stateDirOverride: path.join(home, ".fx-runner"), stdout: () => undefined, stderr: (t) => (err += t), ...(serviceHost === undefined ? {} : { serviceHost }) });
    return { code, err };
  };

  it("installs, and refuses a second positional argument", async () => {
    expect((await cli(["service", "install"], hostOf())).code).toBe(0);
    expect(existsSync(linuxFile())).toBe(true);
    expect((await cli(["service", "install", "extra"], hostOf())).code).toBe(2);
    expect((await cli(["service", "install", "--now"], hostOf())).code).toBe(2);
  });

  it("is available only from the program's entry point", async () => {
    const result = await cli(["service", "install"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("only available from the fx-runner program");
    expect(existsSync(linuxFile())).toBe(false);
  });
});
