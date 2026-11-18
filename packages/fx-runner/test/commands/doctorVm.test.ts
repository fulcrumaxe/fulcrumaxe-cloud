import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveRegistration } from "../../src/config.js";
import type { CommandContext } from "../../src/context.js";
import { doctorCommand, type DoctorHost } from "../../src/commands/doctor.js";
import { createClaudeKit } from "../../src/engines/claude/kit.js";
import { generateRunnerKey, saveRunnerKey } from "../../src/keys.js";
import { setSetting } from "../../src/runnerSettings.js";
import type { ScopeSupport } from "../../src/sandbox/jobLimits.js";
import type { VmHostFacts } from "../../src/vm/limits.js";
import { makeFake, type Fake } from "../engines/claude/harness.js";
import { fakeSandboxHost } from "../helpers/fakeSandboxHost.js";
import { testLaunch } from "../helpers/launch.js";

const SCOPES_OK: ScopeSupport = { ok: true, tools: { systemdRun: "/x/systemd-run", systemctl: "/x/systemctl", env: "/x/env" }, runtimeDir: "/run/user/1000" };
const HOST_PATH = process.env.PATH ?? "";
const GIB = 1024 ** 3;

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

async function doctor(vm: VmHostFacts | undefined, platform: NodeJS.Platform = "linux"): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const ctx: CommandContext = { stateDir, uid: process.getuid?.(), out: (l) => lines.push(l), err: (l) => lines.push(l), now: () => new Date(), fetchFn: (async () => new Response("", { status: 200 })) as typeof fetch };
  const host: DoctorHost = { platform, shellVars: [], engine: createClaudeKit(spawn, { launch: testLaunch() }), home: root, sandbox: fakeSandboxHost(), scopeSupport: SCOPES_OK, vm };
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

describe("doctor: microvm mode", () => {
  it("a fully set up host prints microvm, the limits beside the host's totals, and passes", async () => {
    enableMicrovm();
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
