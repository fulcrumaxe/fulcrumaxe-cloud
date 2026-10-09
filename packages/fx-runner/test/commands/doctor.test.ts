import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveRegistration } from "../../src/config.js";
import type { CommandContext } from "../../src/context.js";
import { doctorCommand, type DoctorHost } from "../../src/commands/doctor.js";
import { createClaudeKit } from "../../src/engines/claude/kit.js";
import { MIN_CLAUDE_VERSION } from "../../src/engines/claude/pin.js";
import { generateRunnerKey, saveRunnerKey } from "../../src/keys.js";
import { runCli } from "../../src/cli.js";
import { MACOS_PREVIEW_NOTICE } from "../../src/platformSupport.js";
import { FULL_HELP, authText, helpWithout, makeFake, type Fake } from "../engines/claude/harness.js";
import { failing, fakeSandboxHost } from "../helpers/fakeSandboxHost.js";

let root: string;
let stateDir: string;
let toolbin: string;
let fake: Fake;
const HOST_PATH = process.env.PATH ?? "";
const ORIGIN = "https://cloud.example.test";
const SECRETS = { ANTHROPIC_API_KEY: "sk-ant-fake-shell-key-0123456789", ANTHROPIC_AUTH_TOKEN: "fake-shell-auth-token-0123456789", CLAUDE_CODE_OAUTH_TOKEN: ["sk-ant-", "oat01-", "fake-oauth-0123456789"].join("") };

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fxr-doctor-"));
  stateDir = path.join(root, "state");
  toolbin = path.join(root, "toolbin");
  mkdirSync(toolbin);
  fake = makeFake();
  symlinkSync(fake.binary, path.join(toolbin, "claude"));
  // The sandbox probe looks for the two tools on the search path; the fake sandbox host answers for them.
  for (const name of ["bwrap", "socat"]) {
    writeFileSync(path.join(toolbin, name), "#!/bin/sh\n");
    chmodSync(path.join(toolbin, name), 0o755);
  }
  // The fake is a shell script, so it needs the system tools too; the fake CLI comes first.
  vi.stubEnv("PATH", `${toolbin}:${HOST_PATH}`);
  for (const name of Object.keys(SECRETS)) vi.stubEnv(name, "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  rmSync(fake.dir, { recursive: true, force: true });
});

function register(mode: "subscription" | "api_key" = "subscription", registeredAt = new Date()): void {
  const key = generateRunnerKey();
  saveRunnerKey(stateDir, key);
  saveRegistration(stateDir, { version: 1, cloud_origin: ORIGIN, runner_id: randomUUID(), account_id: randomUUID(), credential_mode: mode, jkt: key.jkt, registered_at: registeredAt.toISOString() });
}

interface Result {
  code: number;
  out: string;
}

async function doctor(over: { host?: Partial<DoctorHost>; fetchFn?: typeof fetch; now?: () => Date } = {}): Promise<Result> {
  const lines: string[] = [];
  const ctx: CommandContext = { stateDir, out: (l) => lines.push(l), err: (l) => lines.push(l), now: over.now ?? (() => new Date()), fetchFn: over.fetchFn ?? ((async () => new Response("", { status: 200 })) as typeof fetch) };
  const host: DoctorHost = { platform: "linux", shellVars: [], engine: createClaudeKit(spawn), home: root, sandbox: fakeSandboxHost(), ...over.host };
  const code = await doctorCommand(ctx, host);
  return { code, out: lines.join("\n") };
}

const levelOf = (out: string, label: string): string | undefined => out.split("\n").find((line) => line.includes(`${label}:`))?.slice(0, 4).trim();

describe("a healthy machine", () => {
  it("passes every check, exits 0, and asks the CLI only for its version, its help and its auth status", async () => {
    register();
    const result = await doctor();
    expect(result.code).toBe(0);
    for (const label of ["Registration", "Cloud", "Claude CLI", "Claude version", "Claude flags", "Claude login", "Sandbox", "Shell variables"]) expect(levelOf(result.out, label), label).toBe("PASS");
    expect(result.out).toContain(fake.binary);
    expect(result.out).toContain(`at least ${MIN_CLAUDE_VERSION}: yes`);
    expect(result.out).toContain("Claude login:      yes (claude.ai)");
    expect(result.out).toContain("All checks passed.");
    // No model request: the three questions, and no run.
    expect(fake.calls()).toEqual(["--version ", "--help ", "auth status"]);
  });
});

describe("each check fails on its own", () => {
  it("not registered", async () => {
    const result = await doctor();
    expect(result.code).toBe(1);
    expect(levelOf(result.out, "Registration")).toBe("FAIL");
    expect(levelOf(result.out, "Cloud")).toBeUndefined();
    expect(levelOf(result.out, "Claude login")).toBe("WARN");
    expect(result.out).toContain("not registered");
  });

  it("a key over 90 days old", async () => {
    register("subscription", new Date(Date.now() - 100 * 86_400_000));
    const result = await doctor();
    expect(levelOf(result.out, "Registration")).toBe("FAIL");
    expect(result.out).toContain("100 days old");
    expect(result.code).toBe(1);
  });

  it("a cloud that does not answer", async () => {
    register();
    const result = await doctor({ fetchFn: (async () => { throw new Error(`connect ECONNREFUSED ${ORIGIN} secret-detail`); }) as typeof fetch });
    expect(levelOf(result.out, "Cloud")).toBe("FAIL");
    expect(result.out).toContain("is not reachable");
    expect(result.out).not.toContain("secret-detail");
    expect(result.code).toBe(1);
  });

  it("no claude on the search path", async () => {
    register();
    rmSync(path.join(toolbin, "claude"));
    vi.stubEnv("PATH", toolbin); // the host may have a real CLI of its own on its search path
    const result = await doctor();
    expect(levelOf(result.out, "Claude CLI")).toBe("FAIL");
    expect(levelOf(result.out, "Claude version")).toBeUndefined();
    expect(result.code).toBe(1);
  });

  it("a version below the minimum: FAIL, and the flags are not checked", async () => {
    register();
    const old = makeFake({ version: "2.1.293 (Claude Code)" });
    rmSync(path.join(toolbin, "claude"));
    symlinkSync(old.binary, path.join(toolbin, "claude"));
    const result = await doctor();
    expect(levelOf(result.out, "Claude version")).toBe("FAIL");
    expect(result.out).toContain("2.1.293, at least 2.1.294: no");
    expect(levelOf(result.out, "Claude flags")).toBe("WARN");
    expect(old.calls()).toEqual(["--version ", "auth status"]);
    expect(result.code).toBe(1);
    rmSync(old.dir, { recursive: true, force: true });
  });

  it("a version that does not parse", async () => {
    register();
    const odd = makeFake({ version: "not a version" });
    rmSync(path.join(toolbin, "claude"));
    symlinkSync(odd.binary, path.join(toolbin, "claude"));
    const result = await doctor();
    expect(levelOf(result.out, "Claude version")).toBe("FAIL");
    expect(result.out).toContain("could not be read");
    rmSync(odd.dir, { recursive: true, force: true });
  });

  it("a CLI whose help lacks a flag the runner passes names the flag", async () => {
    register();
    const missing = makeFake({ help: helpWithout(FULL_HELP, "--strict-mcp-config") });
    rmSync(path.join(toolbin, "claude"));
    symlinkSync(missing.binary, path.join(toolbin, "claude"));
    const result = await doctor();
    expect(levelOf(result.out, "Claude flags")).toBe("FAIL");
    expect(result.out).toContain("missing --strict-mcp-config");
    expect(result.code).toBe(1);
    rmSync(missing.dir, { recursive: true, force: true });
  });

  it("no login: FAIL; a login of another kind: FAIL and the method label; a CLI that does not answer: WARN", async () => {
    register();
    fake.set("auth.json", authText("auth.none.json"));
    fake.set("auth.fail", "1");
    let result = await doctor();
    expect(levelOf(result.out, "Claude login")).toBe("FAIL");
    expect(result.out).toContain("no (none)");
    expect(result.code).toBe(1);

    fake.set("auth.json", authText("auth.api_key.json"));
    rmSync(path.join(fake.dir, "auth.fail"));
    result = await doctor();
    expect(levelOf(result.out, "Claude login")).toBe("FAIL");
    expect(result.out).toContain("no (api_key)");

    fake.set("auth.json", "this is not json");
    result = await doctor();
    expect(levelOf(result.out, "Claude login")).toBe("WARN");
    expect(result.out).toContain("unknown");
    expect(result.code).toBe(0);
  });

  it("an api_key registration cannot check a login yet: WARN, not a pass", async () => {
    register("api_key");
    const result = await doctor();
    expect(levelOf(result.out, "Claude login")).toBe("WARN");
    expect(result.out).toContain("api_key mode has no local key file yet");
    expect(result.out).not.toContain("Shell variable");
    expect(fake.calls()).toEqual(["--version ", "--help "]);
  });
});

describe("files other users can read are a permission fix, not a damaged registration", () => {
  it("a registration file at 0644 says chmod, never revoke, and the later checks still run", async () => {
    register();
    chmodSync(path.join(stateDir, "registration.json"), 0o644);
    const result = await doctor();
    expect(levelOf(result.out, "Registration")).toBe("FAIL");
    expect(result.out).toMatch(/can be read by other users; run: chmod 600 .*registration\.json/);
    expect(result.out).not.toMatch(/damaged|revoke --local/);
    expect(levelOf(result.out, "Claude version")).toBe("PASS");
    expect(result.code).toBe(1);
  });

  it("a runner key at 0644 is a FAIL line with the chmod hint, and the cloud, CLI, version, flags and login checks still run", async () => {
    register();
    chmodSync(path.join(stateDir, "runner-key.pem"), 0o644);
    const result = await doctor();
    expect(levelOf(result.out, "Registration")).toBe("FAIL");
    expect(result.out).toMatch(/can be read by other users; run: chmod 600 .*runner-key\.pem/);
    for (const label of ["Cloud", "Claude CLI", "Claude version", "Claude flags", "Claude login"]) expect(levelOf(result.out, label), label).toBe("PASS");
    expect(result.code).toBe(1);
  });

  it.skipIf(process.getuid?.() === 0)("a registration file the owner cannot read (mode 0000) is a FAIL line with a chmod hint, not a thrown error, and the later checks still run", async () => {
    register();
    chmodSync(path.join(stateDir, "registration.json"), 0);
    const result = await doctor();
    expect(levelOf(result.out, "Registration")).toBe("FAIL");
    expect(result.out).toMatch(/registration\.json cannot be read by this user \(permission denied\); check who owns it, then run: chmod 600 .*registration\.json/);
    for (const label of ["Claude CLI", "Claude version", "Claude flags", "Sandbox"]) expect(levelOf(result.out, label), label).toBe("PASS");
    expect(result.code).toBe(1);
  });

  it.skipIf(process.getuid?.() === 0)("a runner key the owner cannot read is the same kind of FAIL line", async () => {
    register();
    chmodSync(path.join(stateDir, "runner-key.pem"), 0);
    const result = await doctor();
    expect(levelOf(result.out, "Registration")).toBe("FAIL");
    expect(result.out).toMatch(/runner-key\.pem cannot be read by this user \(permission denied\)/);
    expect(levelOf(result.out, "Cloud")).toBe("PASS");
    expect(result.code).toBe(1);
  });

  it("a registration that really is damaged still says so", async () => {
    register();
    writeFileSync(path.join(stateDir, "registration.json"), "{ not json", { mode: 0o600 });
    const result = await doctor();
    expect(result.out).toContain("is damaged; run: fx-runner revoke --local");
    expect(result.out.match(/Registration:/g)).toHaveLength(1);
  });
});

describe("shell variables and secrets", () => {
  it("warns by name for each Anthropic variable set in the shell in subscription mode, with the spec's wording", async () => {
    register();
    const result = await doctor({ host: { shellVars: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] } });
    expect(result.out).toContain("ANTHROPIC_API_KEY is set in this shell; it would outrank your Claude login. fx-runner removes it from jobs.");
    expect(result.out).toContain("ANTHROPIC_AUTH_TOKEN is set in this shell; it would outrank your Claude login. fx-runner removes it from jobs.");
    expect(result.out.split("\n").filter((l) => l.startsWith("WARN")).length).toBe(2);
    expect(result.code).toBe(0);
  });

  it("with fake token values in the environment, the output holds none of them, nor anything of the CLI's account fields", async () => {
    register();
    for (const [name, value] of Object.entries(SECRETS)) vi.stubEnv(name, value);
    fake.set("auth.json", JSON.stringify({ loggedIn: true, authMethod: "oauth_token", email: "someone@example.test", orgName: "Some Org", apiKey: SECRETS.ANTHROPIC_API_KEY }));
    const result = await doctor({ host: { shellVars: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] } });
    for (const value of Object.values(SECRETS)) expect(result.out).not.toContain(value);
    expect(result.out).not.toMatch(/someone@example|Some Org|fake-shell|fake-oauth/);
    expect(result.out).toContain("yes (oauth_token)");
  });

  it("through the command line the host's variables arrive as names only", async () => {
    register();
    let out = "";
    const code = await runCli({
      argv: ["doctor"],
      home: root,
      stateDirOverride: stateDir,
      stdout: (t) => (out += t),
      stderr: (t) => (out += t),
      fetchFn: (async () => new Response("")) as typeof fetch,
      doctorHost: { platform: "linux", shellVars: ["ANTHROPIC_API_KEY"], engine: createClaudeKit(spawn), home: root, sandbox: fakeSandboxHost() },
    });
    expect(code).toBe(0);
    expect(out).toContain("ANTHROPIC_API_KEY is set");
    expect(await runCli({ argv: ["doctor"], home: root, stateDirOverride: stateDir, stdout: () => undefined, stderr: () => undefined })).toBe(1);
  });
});

describe("macOS", () => {
  it("prints the preview notice on darwin and not on linux", async () => {
    register();
    expect((await doctor({ host: { platform: "darwin" } })).out).toContain(MACOS_PREVIEW_NOTICE);
    expect((await doctor({ host: { platform: "linux" } })).out).not.toContain("not yet verified");
  });
});

describe("the sandbox check", () => {
  const OS = (...lines: string[]): Record<string, string> => ({ "/etc/os-release": `${lines.join("\n")}\n` });
  const sandboxLines = (out: string): string[] => out.split("\n").filter((line) => line.includes("Sandbox:"));

  it("PASS names the tool that ran the test command, and the CLI is still asked only its three questions", async () => {
    register();
    const host = fakeSandboxHost();
    const result = await doctor({ host: { sandbox: host } });
    expect(sandboxLines(result.out)).toEqual(["PASS  Sandbox:           a test command ran inside the job's sandbox rules (bubblewrap)"]);
    expect(host.calls).toHaveLength(1);
    expect(fake.calls()).toEqual(["--version ", "--help ", "auth status"]);
  });

  it("macOS PASS names Seatbelt and keeps the preview notice", async () => {
    register();
    const result = await doctor({ host: { platform: "darwin", sandbox: fakeSandboxHost({ files: { "/usr/bin/sandbox-exec": "" } }) } });
    expect(levelOf(result.out, "Sandbox")).toBe("PASS");
    expect(result.out).toContain("(seatbelt)");
    expect(result.out).toContain(MACOS_PREVIEW_NOTICE);
  });

  type Case = [name: string, files: Record<string, string>, sysctls: Record<string, string>, stderr: string, line: string, fix: string];
  const cases: Case[] = [
    ["userns_disabled", OS("ID=debian"), { "user.max_user_namespaces": "0\n" }, "bwrap: No permissions to create new namespace", "userns_disabled: this kernel has unprivileged user namespaces switched off", "sudo sysctl -w user.max_user_namespaces=15000"],
    ["apparmor_userns_restricted on Ubuntu", OS("ID=ubuntu"), { "kernel.apparmor_restrict_unprivileged_userns": "1\n" }, "bwrap: setting up uid map: Permission denied", "apparmor_userns_restricted: AppArmor restricts", "sudo apparmor_parser -r /etc/apparmor.d/bwrap"],
    ["probe_failed_other on Fedora", OS("ID=fedora"), {}, "bwrap: odd failure", "probe_failed_other: bwrap: odd failure", "Run: sudo dnf install -y bubblewrap socat"],
    ["probe_failed_other on NixOS", { "/etc/NIXOS": "" }, {}, "bwrap: odd failure", "probe_failed_other: bwrap: odd failure", "environment.systemPackages = [ pkgs.bubblewrap pkgs.socat ];"],
  ];
  for (const [name, files, sysctls, stderr, line, fix] of cases) {
    it(`${name}: a FAIL line with the code and reason, the fix for the distro under it, and exit code 1`, async () => {
      register();
      const result = await doctor({ host: { sandbox: fakeSandboxHost({ files, sysctls, outcome: failing(stderr) }) } });
      expect(levelOf(result.out, "Sandbox")).toBe("FAIL");
      expect(result.out).toContain(line);
      expect(result.out).toContain(fix);
      expect(result.out).toContain("1 check failed.");
      expect(result.code).toBe(1);
    });
  }

  it("a missing bubblewrap is bwrap_missing with the install line for the distro, and nothing is started", async () => {
    register();
    const sysbin = path.join(root, "sysbin");
    mkdirSync(sysbin);
    // The fake CLI is a shell script that needs `cat`; the host's own search path (which may hold a real bwrap) is left out.
    symlinkSync(execFileSync("which", ["cat"], { encoding: "utf8" }).trim(), path.join(sysbin, "cat"));
    rmSync(path.join(toolbin, "bwrap"));
    vi.stubEnv("PATH", `${toolbin}:${sysbin}`);
    const host = fakeSandboxHost({ files: OS('ID="arch"') });
    const result = await doctor({ host: { sandbox: host } });
    expect(result.out).toContain("FAIL  Sandbox:           bwrap_missing: bubblewrap (bwrap) is not installed");
    expect(result.out).toContain("      Run: sudo pacman -S --needed bubblewrap socat");
    expect(host.calls).toEqual([]);
  });

  it("with no HOME the sandbox cannot be set up: FAIL, and nothing is started", async () => {
    register();
    const host = fakeSandboxHost();
    const result = await doctor({ host: { home: undefined, sandbox: host } });
    expect(levelOf(result.out, "Sandbox")).toBe("FAIL");
    expect(result.out).toContain("HOME is not set");
    expect(host.calls).toEqual([]);
  });

  it("a failing sandbox stops no other check, and the run is not reported as passed", async () => {
    register();
    const result = await doctor({ host: { sandbox: fakeSandboxHost({ outcome: failing("boom") }) } });
    for (const label of ["Registration", "Cloud", "Claude CLI", "Claude version", "Claude flags", "Claude login"]) expect(levelOf(result.out, label), label).toBe("PASS");
    expect(result.out).not.toContain("All checks passed.");
  });

  it("with fake token values in the shell and in the tool's error text, doctor's output holds none of them", async () => {
    register();
    for (const [name, value] of Object.entries(SECRETS)) vi.stubEnv(name, value);
    const host = fakeSandboxHost({ outcome: failing(`bwrap: failed with ${SECRETS.CLAUDE_CODE_OAUTH_TOKEN} and ${SECRETS.ANTHROPIC_API_KEY}`) });
    const result = await doctor({ host: { sandbox: host, shellVars: ["ANTHROPIC_API_KEY"] } });
    expect(levelOf(result.out, "Sandbox")).toBe("FAIL");
    for (const value of Object.values(SECRETS)) expect(result.out).not.toContain(value);
    expect(JSON.stringify(host.calls)).not.toContain(SECRETS.CLAUDE_CODE_OAUTH_TOKEN);
  });
});
