import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveRegistration } from "../../src/config.js";
import type { CommandContext } from "../../src/context.js";
import { doctorCommand, type DoctorHost } from "../../src/commands/doctor.js";
import { FIX_LINES, NET_HOST_KEYS, NET_URLS, netBlockedFix, type NetHost, type PreflightFacts } from "../../src/daemon/preflight.js";
import { createClaudeKit } from "../../src/engines/claude/kit.js";
import { generateRunnerKey, saveRunnerKey } from "../../src/keys.js";
import { setSetting } from "../../src/runnerSettings.js";
import type { ScopeSupport } from "../../src/sandbox/jobLimits.js";
import { makeFake, type Fake } from "../engines/claude/harness.js";
import { fakeSandboxHost } from "../helpers/fakeSandboxHost.js";
import { testLaunch } from "../helpers/launch.js";

/** D#845 ON-21: the preflight lines of the real doctor over faked kernel readings and a faked network. No real host is asked. */
const SCOPES_OK: ScopeSupport = { ok: true, tools: { systemdRun: "/x/systemd-run", systemctl: "/x/systemctl", env: "/x/env" }, runtimeDir: "/run/user/1000" };
const HOST_PATH = process.env.PATH ?? "";
const GIB = 1024 ** 3;
const ORIGIN = "https://cloud.example.test";

type Kernel = Pick<PreflightFacts, "kvm" | "vt" | "cgroup" | "cgroupDelegated" | "diskFreeBytes" | "memAvailableBytes">;
const GOOD: Kernel = { kvm: "present", vt: "yes", cgroup: "v2", cgroupDelegated: "yes", diskFreeBytes: 80 * GIB, memAvailableBytes: 16 * GIB };

let root: string;
let stateDir: string;
let fake: Fake;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fxr-preflight-doctor-"));
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
  saveRegistration(stateDir, { version: 1, cloud_origin: ORIGIN, runner_id: randomUUID(), account_id: randomUUID(), credential_mode: "subscription", jkt: key.jkt, registered_at: new Date().toISOString() });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  rmSync(fake.dir, { recursive: true, force: true });
});

interface Net {
  blocked?: readonly NetHost[];
  dns?: "ok" | "failed";
  v4?: boolean;
  /** The cloud's clock minus this machine's, in ms. */
  cloudAheadMs?: number;
}

async function doctor(kernel: Kernel | "throws" | "off", net: Net = {}, over: { engine?: "microvm"; linger?: string; platform?: NodeJS.Platform } = {}): Promise<{ code: number; out: string; asked: string[] }> {
  const lines: string[] = [];
  const asked: string[] = [];
  const hostOf = new Map<string, NetHost>([["cloud.example.test", "cloud"], ...NET_HOST_KEYS.filter((h): h is Exclude<NetHost, "cloud"> => h !== "cloud").map((h) => [new URL(NET_URLS[h]).hostname, h] as [string, NetHost])]);
  const now = new Date("2026-11-21T12:00:00.000Z");
  const fetchFn = (async (url: string) => {
    const host = hostOf.get(new URL(String(url)).hostname);
    asked.push(`${host}`);
    if (host !== undefined && net.blocked?.includes(host)) throw new TypeError("fetch failed");
    return new Response("", { status: 200, headers: { date: new Date(now.getTime() + (host === "cloud" ? (net.cloudAheadMs ?? 0) : 0)).toUTCString() } });
  }) as unknown as typeof fetch;
  const ctx: CommandContext = { stateDir, uid: process.getuid?.(), out: (l) => lines.push(l), err: (l) => lines.push(l), now: () => now, fetchFn };
  if (over.engine === "microvm") setSetting(stateDir, "sandbox_engine", "microvm");
  const host: DoctorHost = {
    platform: over.platform ?? "linux",
    shellVars: [],
    engine: createClaudeKit(spawn, { launch: testLaunch() }),
    home: root,
    uid: 1000,
    userName: "alex",
    sandbox: fakeSandboxHost({ outcome: { code: 0, stdout: over.linger ?? "Linger=yes\n", stderr: "", timedOut: false } }),
    scopeSupport: SCOPES_OK,
    ...(kernel === "off"
      ? {}
      : {
          preflight: {
            kernel: () => {
              if (kernel === "throws") throw new Error("boom /secret/path");
              return kernel;
            },
            lookup: async (_name: string, family: 0 | 4) => {
              if (net.dns === "failed") throw new Error("ENOTFOUND");
              if (family === 4 && net.v4 === false) throw new Error("ENODATA");
              return [{ address: "192.0.2.1", family: 4 }];
            },
          },
        }),
  };
  const code = await doctorCommand(ctx, host);
  return { code, out: lines.join("\n"), asked };
}
const preflight = (out: string): string[] => out.split("\n").filter((l) => /^(INFO|PASS|WARN|FAIL)\s+Preflight:/.test(l));

describe("doctor: preflight lines", () => {
  it("a host that passes everything prints one INFO line with the count and no other preflight line", async () => {
    const { out } = await doctor(GOOD);
    expect(preflight(out)).toEqual(["INFO  Preflight:         16 of 16 checks ok"]);
  });

  it("a doctor with no preflight host prints no preflight line and asks the network nothing beyond its own Cloud check (the shape every other doctor test keeps)", async () => {
    const { out, asked } = await doctor("off");
    expect(preflight(out)).toEqual([]);
    expect(asked).toEqual(["cloud"]); // only the doctor's own Cloud check
  });

  it("not on Linux nothing is printed and no probe is made", async () => {
    const { out, asked } = await doctor(GOOD, {}, { platform: "darwin" });
    expect(preflight(out)).toEqual([]);
    expect(asked).toEqual(["cloud"]); // only the doctor's own Cloud check
  });

  it("no KVM is a WARN with its fix, and the exit code is the one a machine without KVM already had", async () => {
    const withKvm = await doctor(GOOD);
    const without = await doctor({ ...GOOD, kvm: "absent", vt: "no" });
    expect(preflight(without.out)).toEqual([`INFO  Preflight:         14 of 16 checks ok, 2 to look at`, `WARN  Preflight:         kvm_absent: ${FIX_LINES.kvm_absent}`, `WARN  Preflight:         kvm_no_vt: ${FIX_LINES.kvm_no_vt}`]);
    expect(without.code).toBe(withKvm.code);
    expect(without.out).not.toMatch(/^FAIL\s+Preflight/m);
  });

  it("a KVM device this user cannot open names the user in the fix", async () => {
    const { out } = await doctor({ ...GOOD, kvm: "no_access" });
    expect(preflight(out)).toContain("WARN  Preflight:         kvm_no_access: Run `sudo usermod -aG kvm alex`, then sign out and back in");
  });

  it("the cgroup findings: v1, and a user manager without delegation", async () => {
    expect(preflight((await doctor({ ...GOOD, cgroup: "v1" })).out)).toContain(`WARN  Preflight:         cgroup_v1: ${FIX_LINES.cgroup_v1}`);
    expect(preflight((await doctor({ ...GOOD, cgroupDelegated: "no" })).out)).toContain(`WARN  Preflight:         cgroup_no_delegate: ${FIX_LINES.cgroup_no_delegate}`);
  });

  it("with sandbox_engine set to microvm the same VM checks are failures and the exit code is 1", async () => {
    const { out, code } = await doctor({ ...GOOD, kvm: "absent", memAvailableBytes: 1 * GIB }, {}, { engine: "microvm" });
    expect(preflight(out)).toContain(`FAIL  Preflight:         kvm_absent: ${FIX_LINES.kvm_absent}`);
    expect(preflight(out)).toContain(`FAIL  Preflight:         vm_memory_low: ${FIX_LINES.vm_memory_low}`);
    expect(code).toBe(1);
  });

  it("lingering off is a WARN, filled with the account name, and counted once", async () => {
    const { out } = await doctor(GOOD, {}, { linger: "Linger=no\n" });
    expect(preflight(out)).toContain("WARN  Preflight:         linger_off: Run `sudo loginctl enable-linger alex`");
  });

  it("every blocked place is a FAIL with its closed code, and the exit code is 1", async () => {
    const { out, code } = await doctor(GOOD, { blocked: ["github", "model_api", "registry_npm", "registry_pypi", "cloud"] });
    for (const host of ["github", "model_api", "registry_npm", "registry_pypi", "cloud"] as const) expect(preflight(out)).toContain(`FAIL  Preflight:         net_blocked:${host}: ${netBlockedFix(host)}`);
    expect(code).toBe(1);
  });

  it("an IPv6-only machine, a dead resolver and a wrong clock are failures", async () => {
    expect(preflight((await doctor(GOOD, { v4: false })).out)).toContain(`FAIL  Preflight:         net_ipv6_only: ${FIX_LINES.net_ipv6_only}`);
    const down = await doctor(GOOD, { dns: "failed", blocked: ["github"] });
    expect(preflight(down.out)).toContain(`FAIL  Preflight:         dns_failed: ${FIX_LINES.dns_failed}`);
    expect(down.out).not.toContain("net_blocked");
    expect(preflight((await doctor(GOOD, { cloudAheadMs: -120_000 })).out)).toContain(`FAIL  Preflight:         clock_skew: ${FIX_LINES.clock_skew}`);
    expect(preflight((await doctor(GOOD, { cloudAheadMs: 29_000 })).out)).toEqual(["INFO  Preflight:         16 of 16 checks ok"]);
  });

  it("low disk is a FAIL, and the kernel reader throwing is 'not run' for each of its checks, with no text from the error", async () => {
    expect(preflight((await doctor({ ...GOOD, diskFreeBytes: 9 * GIB })).out)).toContain(`FAIL  Preflight:         disk_low: ${FIX_LINES.disk_low}`);
    const { out } = await doctor("throws");
    expect(preflight(out)).toContain("WARN  Preflight:         unchecked:kvm_device: This check could not be run on this machine");
    expect(out).not.toContain("secret");
  });

  it("nothing printed names a host, an address or a path: only codes and fixed lines", async () => {
    const { out } = await doctor({ kvm: "absent", vt: "no", cgroup: "v1", cgroupDelegated: "no", diskFreeBytes: 0, memAvailableBytes: 0 }, { blocked: ["github", "cloud"], v4: false, cloudAheadMs: 3_600_000 }, { linger: "Linger=no\n" });
    const text = preflight(out).join("\n");
    expect(text).not.toMatch(/\d+\.\d+\.\d+\.\d+|example\.test|https?:|\/home\/|\/tmp\//);
  });

  it("an installed user unit leaves lingering to the Service line and asks loginctl once", async () => {
    const unit = path.join(root, ".config", "systemd", "user");
    mkdirSync(unit, { recursive: true });
    const { serviceCommand } = await import("../../src/commands/service.js");
    serviceCommand("install", { stateDir, uid: 1000, out: () => undefined, err: () => undefined, now: () => new Date(), fetchFn: fetch }, { home: root, platform: "linux", command: ["/opt/fxr/node", "/opt/fxr/cli.js", "run"], path: "/opt/fxr/bin" });
    const sandbox = fakeSandboxHost({ outcome: { code: 0, stdout: "Linger=no\n", stderr: "", timedOut: false } });
    const lines: string[] = [];
    const host: DoctorHost = { platform: "linux", shellVars: [], engine: createClaudeKit(spawn, { launch: testLaunch() }), home: root, uid: 1000, userName: "alex", sandbox, scopeSupport: SCOPES_OK, preflight: { kernel: () => GOOD, lookup: async () => [{ address: "192.0.2.1", family: 4 }] } };
    await doctorCommand({ stateDir, uid: 1000, out: (l) => lines.push(l), err: (l) => lines.push(l), now: () => new Date(), fetchFn: (async () => new Response("", { status: 200 })) as typeof fetch }, host);
    const text = lines.join("\n");
    expect(text).toContain("Stops when you log out: run loginctl enable-linger alex");
    expect(text).not.toContain("linger_off");
    expect(sandbox.calls.filter((c) => c.command === "loginctl")).toHaveLength(1);
  });
});
