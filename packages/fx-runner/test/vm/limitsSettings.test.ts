import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vmLimitsBlock } from "../../src/commands/run.js";
import { SETTINGS_FILE, SETTING_KEYS, loadSettings, setSetting, unsetSetting } from "../../src/runnerSettings.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fxr-vmset-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ALL: Array<[string, string]> = [["microvm.max_vms", "2"], ["microvm.max_vcpus", "4"], ["microvm.max_memory_mb", "4096"], ["microvm.snapshot_dir", "/srv/fx/snaps"], ["microvm.snapshot_quota_bytes", "8589934592"]];

describe("the engine and limit settings", () => {
  it("are config keys, and a fresh state directory has the default engine and no limits", () => {
    for (const [key] of ALL) expect(SETTING_KEYS).toContain(key);
    expect(SETTING_KEYS).toContain("sandbox_engine");
    const settings = loadSettings(dir);
    expect(settings.sandboxEngine).toBeUndefined();
    expect(settings.microvm).toBeUndefined();
    expect(vmLimitsBlock(dir)).toBeUndefined();
  });

  it("round-trip through the file, and are cleared one at a time", () => {
    setSetting(dir, "sandbox_engine", "microvm");
    for (const [key, value] of ALL) setSetting(dir, key, value);
    expect(loadSettings(dir).sandboxEngine).toBe("microvm");
    expect(loadSettings(dir).microvm).toEqual({ maxVms: 2, maxVcpus: 4, maxMemoryMb: 4096, snapshotDir: "/srv/fx/snaps", snapshotQuotaBytes: 8589934592 });
    expect(vmLimitsBlock(dir)).toBeUndefined();
    unsetSetting(dir, "microvm.max_vcpus");
    expect(loadSettings(dir).microvm?.maxVcpus).toBeUndefined();
    expect(vmLimitsBlock(dir)).toBe("microvm_limits_missing");
    unsetSetting(dir, "sandbox_engine");
    expect(vmLimitsBlock(dir)).toBeUndefined();
  });

  it("each missing limit blocks a microvm runner, one at a time, and none blocks an os_sandbox runner", () => {
    setSetting(dir, "sandbox_engine", "microvm");
    for (const [key, value] of ALL) setSetting(dir, key, value);
    for (const [key] of ALL) {
      const keep = loadSettings(dir).microvm;
      unsetSetting(dir, key);
      expect(vmLimitsBlock(dir), key).toBe("microvm_limits_missing");
      setSetting(dir, "sandbox_engine", "os_sandbox");
      expect(vmLimitsBlock(dir), `${key} in os_sandbox`).toBeUndefined();
      setSetting(dir, "sandbox_engine", "microvm");
      const value = ALL.find(([k]) => k === key)?.[1] as string;
      setSetting(dir, key, value);
      expect(loadSettings(dir).microvm).toEqual(keep);
    }
  });

  it("refuse a value out of range and write nothing", () => {
    const bad: Array<[string, string]> = [["sandbox_engine", "vm"], ["sandbox_engine", ""], ["microvm.max_vms", "0"], ["microvm.max_vms", "65"], ["microvm.max_vms", "2.5"], ["microvm.max_vcpus", "-1"], ["microvm.max_memory_mb", "100"], ["microvm.snapshot_quota_bytes", "0"], ["microvm.snapshot_quota_bytes", "abc"], ["microvm.snapshot_dir", "rel"], ["microvm.snapshot_dir", "/a/../b"]];
    for (const [key, value] of bad) expect(() => setSetting(dir, key, value), `${key}=${value}`).toThrow();
    expect(loadSettings(dir).sandboxEngine).toBeUndefined();
    expect(loadSettings(dir).microvm).toBeUndefined();
  });

  it("a stored value that is not valid reads as missing; a stored engine that is neither value claims nothing in any mode", () => {
    writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify({ sandboxEngine: "microvm", microvm: { maxVms: 0, maxVcpus: "4", maxMemoryMb: 4096, snapshotDir: "/a/../b", snapshotQuotaBytes: 1 } }), { mode: 0o600 });
    expect(loadSettings(dir).microvm).toEqual({ maxMemoryMb: 4096, snapshotQuotaBytes: 1 });
    expect(vmLimitsBlock(dir)).toBe("microvm_limits_missing");
    writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify({ sandboxEngine: "Microvm", microvm: {} }), { mode: 0o600 });
    expect(loadSettings(dir).sandboxEngine).toBe("invalid");
    expect(vmLimitsBlock(dir)).toBe("engine_setting_invalid");
  });

  it("keep the other settings when written, and they keep these", () => {
    setSetting(dir, "concurrency.total", "3");
    setSetting(dir, "microvm.max_vms", "2");
    setSetting(dir, "concurrency.heavy", "1");
    expect(loadSettings(dir).ceilingTotal).toBe(3);
    expect(loadSettings(dir).microvm?.maxVms).toBe(2);
  });
});
