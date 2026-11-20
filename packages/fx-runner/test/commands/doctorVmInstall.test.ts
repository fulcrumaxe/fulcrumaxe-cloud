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
import type { ScopeSupport } from "../../src/sandbox/jobLimits.js";
import type { VmInstallFacts } from "../../src/vm/doctorChecks.js";
import { makeFake, type Fake } from "../engines/claude/harness.js";
import { fakeSandboxHost } from "../helpers/fakeSandboxHost.js";
import { testLaunch } from "../helpers/launch.js";

/** D#587 B-2a-2 PR-4: how `doctor` prints the VM install checks. The checks themselves are in test/vm/doctorChecks.test.ts. */
const SCOPES_OK: ScopeSupport = { ok: true, tools: { systemdRun: "/x/systemd-run", systemctl: "/x/systemctl", env: "/x/env" }, runtimeDir: "/run/user/1000" };
const HOST_PATH = process.env.PATH ?? "";

let root: string;
let stateDir: string;
let fake: Fake;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fxr-doctorvminst-"));
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

const levelOf = (out: string, label: string): string | undefined => out.split("\n").find((l) => l.includes(`${label}:`))?.slice(0, 4).trim();

describe("doctor: the installed helper's checks", () => {
  const sha = "c".repeat(64);
  const installed = { unit: "active", socket: "answers", binary: { state: "ok", value: sha }, signed: { state: "ok", value: sha }, config: { state: "ok", value: { kind: "file", uid: 0, gid: 0, mode: 0o600 } }, jailRoot: { state: "ok", value: { kind: "dir", uid: 0, gid: 0, mode: 0o711 } }, group: { user: "alice", exists: true, member: true, active: true } } as const;
  const full: VmInstallFacts = { ...installed, kvm: "present" };
  async function withInstall(vmInstall: DoctorHost["vmInstall"]): Promise<{ code: number; out: string }> {
    const lines: string[] = [];
    const ctx: CommandContext = { stateDir, uid: process.getuid?.(), out: (l) => lines.push(l), err: (l) => lines.push(l), now: () => new Date(), fetchFn: (async () => new Response("", { status: 200 })) as typeof fetch };
    const host: DoctorHost = { platform: "linux", shellVars: [], engine: createClaudeKit(spawn, { launch: testLaunch() }), home: root, sandbox: fakeSandboxHost(), scopeSupport: SCOPES_OK, vmInstall };
    return { code: await doctorCommand(ctx, host), out: lines.join("\n") };
  }

  it("prints seven separate lines for an installed host, and a FAIL fails doctor", async () => {
    const ok = await withInstall(async () => full);
    for (const label of ["VM unit", "VM helper", "VM binary", "VM config", "VM jail root", "VM group", "VM KVM"]) expect(levelOf(ok.out, label), label).toBe("PASS");
    expect(ok.code).toBe(0);
    const bad = await withInstall(async () => ({ ...full, unit: "inactive", kvm: "absent" }));
    expect(levelOf(bad.out, "VM unit")).toBe("FAIL");
    expect(levelOf(bad.out, "VM KVM")).toBe("FAIL");
    expect(bad.code).toBe(1);
  });

  it("a host with nothing installed prints one INFO line and still passes; a warning does not fail doctor", async () => {
    const none = await withInstall(async () => ({ ...full, unit: "absent", binary: { state: "absent" }, config: { state: "absent" }, jailRoot: { state: "absent" }, group: { user: "alice", exists: false, member: false, active: false } }));
    expect(levelOf(none.out, "VM helper")).toBe("INFO");
    expect(none.out).not.toContain("VM unit:");
    expect(none.code).toBe(0);
    const warn = await withInstall(async () => ({ ...full, kvm: "unreadable" }));
    expect(levelOf(warn.out, "VM KVM")).toBe("WARN");
    expect(warn.code).toBe(0);
  });

  it("is silent when the host supplies no install facts, and prints neither null nor undefined", async () => {
    expect((await withInstall(undefined)).out).not.toContain("VM unit:");
    expect((await withInstall(async () => ({ ...full, signed: { state: "absent" } }))).out).not.toMatch(/\bnull\b|\bundefined\b/);
  });
});
