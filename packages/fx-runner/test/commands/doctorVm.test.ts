import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveRegistration } from "../../src/config.js";
import type { CommandContext } from "../../src/context.js";
import { doctorCommand, type DoctorHost } from "../../src/commands/doctor.js";
import { createClaudeKit } from "../../src/engines/claude/kit.js";
import { generateRunnerKey, saveRunnerKey } from "../../src/keys.js";
import { cleanEnv } from "../../src/job/cleanEnv.js";
import { VM_TOKEN_DIR, VM_TOKEN_FILE, writeVmToken } from "../../src/credentials/vmToken.js";
import { SETTINGS_FILE, setSetting } from "../../src/runnerSettings.js";
import type { ScopeSupport } from "../../src/sandbox/jobLimits.js";
import type { VmHostFacts } from "../../src/vm/limits.js";
import { makeFake, type Fake } from "../engines/claude/harness.js";
import { fakeSandboxHost } from "../helpers/fakeSandboxHost.js";
import { testLaunch } from "../helpers/launch.js";

const SCOPES_OK: ScopeSupport = { ok: true, tools: { systemdRun: "/x/systemd-run", systemctl: "/x/systemctl", env: "/x/env" }, runtimeDir: "/run/user/1000" };
const HOST_PATH = process.env.PATH ?? "";
const GIB = 1024 ** 3;
// A fake token, assembled from fragments so no token-shaped literal sits in the source.
const FAKE_TOKEN = ["sk-ant-", "oat01-", "DOCTORFAKE0123456789abcd"].join("");

let root: string;
let stateDir: string;
let fake: Fake;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fxr-doctorvm-"));
  stateDir = path.join(root, "state");
  const toolbin = path.join(root, "toolbin");
  mkdirSync(toolbin);
  fake = makeFake();
  symlinkSync(fake.binary, path.join(toolbin, "claude"));
  for (const name of ["bwrap", "socat"]) {
    writeFileSync(path.join(toolbin, name), "#!/bin/sh\n");
    chmodSync(path.join(toolbin, name), 0o755);
  }
  vi.stubEnv("PATH", `${toolbin}:${HOST_PATH}`);
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) vi.stubEnv(name, "");
  const key = generateRunnerKey();
  saveRunnerKey(stateDir, key);
  saveRegistration(stateDir, { version: 1, cloud_origin: "https://cloud.example.test", runner_id: randomUUID(), account_id: randomUUID(), credential_mode: "subscription", jkt: key.jkt, registered_at: new Date().toISOString() });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  rmSync(fake.dir, { recursive: true, force: true });
});

const facts = (over: Partial<VmHostFacts> = {}): VmHostFacts => ({ kvm: "present", helperSocket: "present", helperSocketPath: "/fake/helper.sock", totalMemMb: 16384, cpus: 8, readMemAvailableBytes: () => 8 * GIB, ...over });

async function doctor(vm: VmHostFacts | undefined, platform: NodeJS.Platform = "linux", wired: boolean | "absent" = true, extra: Partial<DoctorHost> = {}): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const ctx: CommandContext = { stateDir, uid: process.getuid?.(), out: (l) => lines.push(l), err: (l) => lines.push(l), now: () => new Date(), fetchFn: (async () => new Response("", { status: 200 })) as typeof fetch };
  const host: DoctorHost = { platform, shellVars: [], engine: createClaudeKit(spawn, { launch: testLaunch() }), home: root, sandbox: fakeSandboxHost(), scopeSupport: SCOPES_OK, vm, microvmWired: wired === "absent" ? undefined : wired, uid: process.getuid?.(), ...extra };
  const code = await doctorCommand(ctx, host);
  return { code, out: lines.join("\n") };
}
const levelOf = (out: string, label: string): string | undefined => out.split("\n").find((l) => l.includes(`${label}:`) && !l.startsWith("INFO  sandbox_engine"))?.slice(0, 4).trim();
const engineLine = (out: string): string | undefined => out.split("\n").find((l) => l.includes("sandbox_engine:"));
const enableMicrovm = (skip: string[] = []): void => {
  setSetting(stateDir, "sandbox_engine", "microvm");
  for (const [key, value] of [["microvm.max_vms", "2"], ["microvm.max_vcpus", "4"], ["microvm.max_memory_mb", "4096"], ["microvm.snapshot_dir", "/srv/fx/snaps"], ["microvm.snapshot_quota_bytes", "8589934592"]] as const) if (!skip.includes(key)) setSetting(stateDir, key, value);
};

describe("doctor: the sandbox_engine line", () => {
  it("without /dev/kvm: sandbox_engine: os_sandbox (no KVM)", async () => {
    const result = await doctor(facts({ kvm: "absent" }));
    expect(engineLine(result.out)).toBe("INFO  sandbox_engine: os_sandbox (no KVM)");
    expect(result.code).toBe(0);
  });

  it("without the helper's socket: sandbox_engine: os_sandbox (vm helper not installed)", async () => {
    const result = await doctor(facts({ helperSocket: "absent" }));
    expect(engineLine(result.out)).toBe("INFO  sandbox_engine: os_sandbox (vm helper not installed)");
    expect(result.code).toBe(0);
  });

  it("KVM and the helper present but microvm not enabled: says so, and passes", async () => {
    const result = await doctor(facts());
    expect(engineLine(result.out)).toBe("INFO  sandbox_engine: os_sandbox (microvm not enabled)");
    expect(result.code).toBe(0);
  });

  it("an unreadable fact, or none at all, never reads as available", async () => {
    for (const vm of [facts({ kvm: "unreadable" }), facts({ helperSocket: "unreadable" }), undefined]) {
      const result = await doctor(vm);
      expect(engineLine(result.out), JSON.stringify(vm)).toBe("INFO  sandbox_engine: os_sandbox (vm state unreadable)");
    }
  });

  it("macOS: VM mode not available in this version", async () => {
    const result = await doctor(facts(), "darwin");
    expect(engineLine(result.out)).toContain("macOS: VM mode not available in this version");
  });

  it("never prints null or undefined", async () => {
    for (const vm of [facts(), facts({ kvm: "absent" }), undefined]) expect((await doctor(vm)).out).not.toMatch(/\bnull\b|\bundefined\b/);
  });
});

describe("doctor: a build that cannot start a VM yet (D#587 B-5b-3a)", () => {
  it("microvm mode on an unwired build FAILs with microvm_build_unwired, whatever else passes, and an absent flag reads as unwired", async () => {
    enableMicrovm();
    for (const wired of [false, "absent"] as const) {
      const result = await doctor(facts(), "linux", wired);
      expect(result.code).not.toBe(0);
      expect(levelOf(result.out, "microvm")).toBe("FAIL");
      expect(result.out).toContain("microvm_build_unwired");
      expect(result.out).toContain("does not fall back to os_sandbox");
      expect(engineLine(result.out)).toBe("INFO  sandbox_engine: microvm");
    }
    expect((await doctor(facts(), "linux", true)).out).not.toContain("microvm_build_unwired");
  });

  it("os_sandbox mode never prints the line, wired or not", async () => {
    for (const wired of [true, false]) expect((await doctor(facts(), "linux", wired)).out).not.toContain("microvm_build_unwired");
  });

  it("a settings file that cannot be read FAILs in plain words, and is never read as os_sandbox", async () => {
    writeFileSync(path.join(stateDir, SETTINGS_FILE), "{broken");
    const result = await doctor(facts());
    expect(result.code).not.toBe(0);
    expect(result.out).toContain("the settings file cannot be read");
    expect(levelOf(result.out, "microvm")).toBe("FAIL");
  });
});

describe("doctor: microvm mode", () => {
  it("a fully set up host prints microvm, the limits beside the host's totals, and passes", async () => {
    enableMicrovm();
    writeVmToken(stateDir, process.getuid?.(), FAKE_TOKEN);
    const result = await doctor(facts());
    expect(engineLine(result.out)).toBe("INFO  sandbox_engine: microvm");
    expect(levelOf(result.out, "microvm limits")).toBe("PASS");
    expect(result.out).toContain("max_vcpus 4 (host 8)");
    expect(result.out).toContain("max_memory_mb 4096 (host 16384)");
    expect(result.out).toContain("Host memory:       8192 MiB available");
    expect(result.code).toBe(0);
  });

  it("each missing limit fails doctor and is named", async () => {
    for (const key of ["microvm.max_vms", "microvm.max_vcpus", "microvm.max_memory_mb", "microvm.snapshot_dir", "microvm.snapshot_quota_bytes"]) {
      rmSync(path.join(stateDir, "runner-settings.json"), { force: true });
      enableMicrovm([key]);
      const result = await doctor(facts());
      expect(levelOf(result.out, "microvm limits"), key).toBe("FAIL");
      expect(result.out).toContain(`missing or invalid: ${key};`);
      expect(engineLine(result.out)).toContain("os_sandbox (microvm limits missing)");
      expect(result.code, key).toBe(1);
    }
  });

  it("os_sandbox ignores the limits: nothing is checked and a missing limit does not fail", async () => {
    setSetting(stateDir, "microvm.max_vms", "2");
    const result = await doctor(facts());
    expect(result.out).not.toContain("microvm limits");
    expect(result.code).toBe(0);
  });

  it("no KVM, no helper, or an unreadable fact fails in microvm mode with microvm_unavailable, and never falls back silently", async () => {
    enableMicrovm();
    for (const [vm, text] of [[facts({ kvm: "absent" }), "os_sandbox (no KVM)"], [facts({ helperSocket: "absent" }), "os_sandbox (vm helper not installed)"], [facts({ kvm: "unreadable" }), "os_sandbox (vm state unreadable)"], [undefined, "os_sandbox (vm state unreadable)"]] as const) {
      const result = await doctor(vm);
      expect(engineLine(result.out)).toBe(`INFO  sandbox_engine: ${text}`);
      expect(levelOf(result.out, "microvm"), text).toBe("FAIL");
      expect(result.out).toContain(`microvm_unavailable: ${text}`);
      expect(result.code).toBe(1);
    }
  });

  it("a limit over the host's total fails and prints both numbers", async () => {
    enableMicrovm();
    const memory = await doctor(facts({ totalMemMb: 2048 }));
    expect(memory.out).toContain("max_memory_mb 4096 is over the host's 2048 MiB");
    const cores = await doctor(facts({ cpus: 2 }));
    expect(cores.out).toContain("max_vcpus 4 is over the host's 2 cores");
    expect(memory.code).toBe(1);
    expect(cores.code).toBe(1);
  });

  it("host totals that cannot be read fail rather than pass", async () => {
    enableMicrovm();
    const result = await doctor(facts({ totalMemMb: undefined }));
    expect(levelOf(result.out, "microvm limits")).toBe("FAIL");
    expect(result.out).toContain("could not be read");
    expect(result.code).toBe(1);
  });

  it("an unreadable memory table fails; a reader that throws does too", async () => {
    enableMicrovm();
    for (const reader of [() => undefined, () => Number.NaN, () => -5, () => { throw new Error("EACCES /secret/path"); }]) {
      const result = await doctor(facts({ readMemAvailableBytes: reader as () => number | undefined }));
      expect(levelOf(result.out, "Host memory")).toBe("FAIL");
      expect(result.out).not.toContain("/secret/path");
      expect(result.code).toBe(1);
    }
  });

  it("a stored engine that is neither value fails doctor", async () => {
    writeFileSync(path.join(stateDir, "runner-settings.json"), JSON.stringify({ sandboxEngine: "Microvm" }), { mode: 0o600 });
    const result = await doctor(facts());
    expect(levelOf(result.out, "microvm")).toBe("FAIL");
    expect(result.out).toContain("neither os_sandbox nor microvm");
    expect(result.code).toBe(1);
  });
});

describe("doctor: the VM model token line (D#587 B-6-VMTOKEN)", () => {
  const tokenFile = (): string => path.join(stateDir, VM_TOKEN_DIR, VM_TOKEN_FILE);
  const lineOf = (out: string): string | undefined => out.split("\n").find((l) => l.includes("VM model token:"));
  const mint = (): void => writeVmToken(stateDir, process.getuid?.(), FAKE_TOKEN);

  it("a stored token in microvm mode: PASS, with its age and source, and doctor passes", async () => {
    enableMicrovm();
    mint();
    const result = await doctor(facts());
    expect(lineOf(result.out)).toMatch(/^PASS\s+VM model token:\s+present \(file, set 0 days ago\)$/);
    expect(result.code).toBe(0);
  });

  it("no file but the dev variable set: present (env, dev), PASS", async () => {
    enableMicrovm();
    const result = await doctor(facts(), "linux", true, { vmEnvToken: true });
    expect(lineOf(result.out)).toMatch(/^PASS\s+VM model token:\s+present \(env, dev\)$/);
    expect(result.code).toBe(0);
  });

  it("no file and no variable: FAIL naming the fix, and doctor fails", async () => {
    enableMicrovm();
    const result = await doctor(facts());
    expect(levelOf(result.out, "VM model token")).toBe("FAIL");
    expect(lineOf(result.out)).toContain("missing; run: fx-runner credentials set-vm-token");
    expect(result.code).toBe(1);
  });

  it("an unsafe file (group-readable) is FAIL unsafe, and the dev variable is NOT a fallback", async () => {
    enableMicrovm();
    mint();
    chmodSync(tokenFile(), 0o640);
    const result = await doctor(facts(), "linux", true, { vmEnvToken: true });
    expect(levelOf(result.out, "VM model token")).toBe("FAIL");
    expect(lineOf(result.out)).toContain("unsafe");
    expect(lineOf(result.out)).not.toContain("env");
    expect(result.code).toBe(1);
  });

  it("a symlink in place of the file is unsafe too", async () => {
    enableMicrovm();
    mint();
    const elsewhere = path.join(root, "elsewhere");
    writeFileSync(elsewhere, FAKE_TOKEN, { mode: 0o600 });
    rmSync(tokenFile());
    symlinkSync(elsewhere, tokenFile());
    const result = await doctor(facts());
    expect(levelOf(result.out, "VM model token")).toBe("FAIL");
    expect(lineOf(result.out)).toContain("unsafe");
  });

  it("a file older than 300 days warns (by mtime) but still passes doctor; at 299 days it does not", async () => {
    enableMicrovm();
    mint();
    const old = new Date(Date.now() - 301 * 86_400_000);
    utimesSync(tokenFile(), old, old);
    const stale = await doctor(facts());
    expect(levelOf(stale.out, "VM model token")).toBe("WARN");
    expect(lineOf(stale.out)).toContain("set over 300 days ago; a minted token lasts about a year");
    expect(stale.code).toBe(0);
    const edge = new Date(Date.now() - 299 * 86_400_000);
    utimesSync(tokenFile(), edge, edge);
    expect(levelOf((await doctor(facts())).out, "VM model token")).toBe("PASS");
  });

  it("in os_sandbox mode the line is INFO only, even with no token", async () => {
    const result = await doctor(facts());
    expect(levelOf(result.out, "VM model token")).toBe("INFO");
    expect(result.code).toBe(0);
  });

  it("an API-key runner in microvm mode sends no subscription token, so a missing token is INFO", async () => {
    enableMicrovm();
    const key = generateRunnerKey();
    saveRunnerKey(stateDir, key);
    saveRegistration(stateDir, { version: 1, cloud_origin: "https://cloud.example.test", runner_id: randomUUID(), account_id: randomUUID(), credential_mode: "api_key", jkt: key.jkt, registered_at: new Date().toISOString() });
    const result = await doctor(facts());
    expect(levelOf(result.out, "VM model token")).toBe("INFO");
  });

  it("never prints any part of the token", async () => {
    enableMicrovm();
    mint();
    const result = await doctor(facts(), "linux", true, { vmEnvToken: true });
    expect(result.out).not.toContain("DOCTORFAKE");
    expect(result.out).not.toContain("sk-ant");
  });

  describe("the inspect probe never gets the dev token variable in microvm mode (or when the settings are unreadable)", () => {
    const probeEnvs = async (): Promise<Array<Record<string, string>>> => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "dev-exported-value");
      const seen: Array<Record<string, string>> = [];
      const real = createClaudeKit(spawn, { launch: testLaunch() });
      const engine = { ...real, inspect: (async (input: Parameters<typeof real.inspect>[0]) => { seen.push(cleanEnv({ mode: "subscription" }, input.envOptions)); return real.inspect(input); }) as typeof real.inspect };
      await doctor(facts(), "linux", true, { engine });
      return seen;
    };
    it("microvm mode: the probe's environment holds no token", async () => {
      enableMicrovm();
      const seen = await probeEnvs();
      expect(seen.length).toBeGreaterThan(0);
      for (const env of seen) expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    });
    it("unreadable settings fail closed: no token either", async () => {
      writeFileSync(path.join(stateDir, SETTINGS_FILE), "{broken");
      const seen = await probeEnvs();
      expect(seen.length).toBeGreaterThan(0);
      for (const env of seen) expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    });
    it("control, os_sandbox mode: the probe gets the variable as before", async () => {
      const seen = await probeEnvs();
      expect(seen.length).toBeGreaterThan(0);
      for (const env of seen) expect(env).toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN", "dev-exported-value");
    });
  });

  it("removing the file flips the line from present to missing on the next run (derived, not stamped)", async () => {
    enableMicrovm();
    mint();
    expect(levelOf((await doctor(facts())).out, "VM model token")).toBe("PASS");
    rmSync(tokenFile());
    expect(levelOf((await doctor(facts())).out, "VM model token")).toBe("FAIL");
  });
});
