import { describe, expect, it } from "vitest";
import {
  DEFAULT_HELPER_SOCKET,
  ENGINE_LINES,
  HEADROOM_BYTES,
  admitVm,
  completeCaps,
  engineLineOf,
  limitsClaimBlock,
  missingCaps,
  parseCap,
  parseMemAvailableBytes,
  type MicrovmCaps,
  type VmHostFacts,
} from "../../src/vm/limits.js";

const MIB = 1024 ** 2;
const CAPS: MicrovmCaps = { maxVms: 2, maxVcpus: 4, maxMemoryMb: 4096, snapshotDir: "/srv/fx/snaps", snapshotQuotaBytes: 8 * 1024 ** 3 };
const facts = (over: Partial<VmHostFacts> = {}): VmHostFacts => ({ kvm: "present", helperSocket: "present", helperSocketPath: "/x/helper.sock", totalMemMb: 16384, cpus: 8, readMemAvailableBytes: () => 8 * 1024 ** 3, ...over });

describe("the five caps", () => {
  it("are all required: each one missing is named, and a full set completes", () => {
    expect(missingCaps(undefined)).toHaveLength(5);
    expect(completeCaps(CAPS)).toEqual(CAPS);
    for (const field of Object.keys(CAPS) as Array<keyof MicrovmCaps>) {
      const partial = { ...CAPS };
      delete partial[field];
      expect(missingCaps(partial), field).toHaveLength(1);
      expect(completeCaps(partial), field).toBeUndefined();
    }
  });

  it("an out-of-range or mistyped value is absent", () => {
    const bad: Array<[keyof MicrovmCaps, unknown]> = [
      ["maxVms", 0], ["maxVms", 65], ["maxVms", 1.5], ["maxVms", "2"], ["maxVms", Number.NaN],
      ["maxVcpus", 0], ["maxVcpus", 257],
      ["maxMemoryMb", 255], ["maxMemoryMb", 4_194_305],
      ["snapshotQuotaBytes", 0], ["snapshotQuotaBytes", -1], ["snapshotQuotaBytes", Number.MAX_SAFE_INTEGER + 2],
      ["snapshotDir", "relative/dir"], ["snapshotDir", "/a/../b"], ["snapshotDir", "/a/./b"], ["snapshotDir", "/a//b"], ["snapshotDir", "/a/b/"], ["snapshotDir", "/a/b\n"], ["snapshotDir", "/"], ["snapshotDir", 7],
    ];
    for (const [field, value] of bad) expect(parseCap(field, value), `${field}=${String(value)}`).toBeUndefined();
    expect(parseCap("maxVms", 1)).toBe(1);
    expect(parseCap("maxVms", 64)).toBe(64);
    expect(parseCap("snapshotDir", "/srv/fx/snaps")).toBe("/srv/fx/snaps");
  });
});

describe("the claim block", () => {
  it("microvm with a missing limit claims nothing; os_sandbox ignores the limits whatever they are", () => {
    expect(limitsClaimBlock("microvm", undefined)).toBe("microvm_limits_missing");
    expect(limitsClaimBlock("microvm", { ...CAPS, maxVms: undefined })).toBe("microvm_limits_missing");
    expect(limitsClaimBlock("microvm", CAPS)).toBeUndefined();
    expect(limitsClaimBlock("os_sandbox", undefined)).toBeUndefined();
    expect(limitsClaimBlock("os_sandbox", { maxVms: 2 })).toBeUndefined();
    expect(limitsClaimBlock("invalid", CAPS)).toBe("engine_setting_invalid");
  });
});

describe("parseMemAvailableBytes", () => {
  it("reads exactly one well-formed MemAvailable line, in bytes", () => {
    expect(parseMemAvailableBytes("MemTotal: 100 kB\nMemAvailable:   2048 kB\nBuffers: 1 kB\n")).toBe(2048 * 1024);
  });
  it("anything else is unreadable", () => {
    for (const text of [undefined, "", "MemTotal: 1 kB\n", "MemAvailable: abc kB\n", "MemAvailable: 5 MB\n", "MemAvailable: -5 kB\n", "MemAvailable: 1 kB\nMemAvailable: 2 kB\n", "MemAvailable: 99999999999999999 kB\n", " MemAvailable: 1 kB\n"]) expect(parseMemAvailableBytes(text), String(text)).toBeUndefined();
  });
});

describe("admission", () => {
  const request = { vcpus: 2, memoryMb: 2048 };
  const need = 2048 * MIB + 1073741824;
  it("the helper socket path is the one the helper pins", () => expect(DEFAULT_HELPER_SOCKET).toBe("/run/fx-vmhelper/helper.sock"));
  it("the headroom is 1 GiB", () => expect(HEADROOM_BYTES).toBe(1073741824));
  const admit = (over: Partial<Parameters<typeof admitVm>[0]> = {}) => admitVm({ caps: CAPS, running: [], request, readMemAvailableBytes: () => need, ...over });
  const code = (over: Partial<Parameters<typeof admitVm>[0]> = {}) => {
    const result = admit(over);
    return result.admit ? "admit" : result.code;
  };

  it("admits at exactly the request plus 1 GiB and refuses one byte under", () => {
    expect(code()).toBe("admit");
    expect(code({ readMemAvailableBytes: () => need - 1 })).toBe("mem_low");
    expect(code({ readMemAvailableBytes: () => need + 1 })).toBe("admit");
  });

  it("refuses when the memory table cannot be read: undefined, NaN, negative, or a reader that throws", () => {
    for (const reader of [() => undefined, () => Number.NaN, () => -1, () => Number.POSITIVE_INFINITY, () => { throw new Error("EACCES"); }]) expect(code({ readMemAvailableBytes: reader as () => number | undefined })).toBe("mem_unreadable");
  });

  it("counts each running VM at its full configured RAM, not what it uses", () => {
    const running = [{ vcpus: 1, memoryMb: 1024 }];
    expect(code({ running, readMemAvailableBytes: () => need })).toBe("mem_low");
    expect(code({ running, readMemAvailableBytes: () => need + 1024 * MIB })).toBe("admit");
  });

  it("refuses at max_vms, over max_vcpus and over max_memory_mb, and never queues (the answer is immediate and final)", () => {
    expect(code({ running: [request, request] })).toBe("vm_cap_reached");
    expect(code({ running: [request] })).toBe("mem_low");
    expect(code({ request: { vcpus: 5, memoryMb: 2048 } })).toBe("vcpu_cap_exceeded");
    expect(code({ request: { vcpus: 4, memoryMb: 2048 } })).toBe("admit");
    expect(code({ request: { vcpus: 2, memoryMb: 4097 }, readMemAvailableBytes: () => 64 * 1024 ** 3 })).toBe("memory_cap_exceeded");
    expect(code({ request: { vcpus: 2, memoryMb: 4096 }, readMemAvailableBytes: () => 64 * 1024 ** 3 })).toBe("admit");
  });

  it("refuses with no limits, and a request that is not a whole positive number", () => {
    expect(code({ caps: undefined })).toBe("limits_missing");
    for (const bad of [{ vcpus: 0, memoryMb: 1 }, { vcpus: 1, memoryMb: 0 }, { vcpus: 1.5, memoryMb: 1 }, { vcpus: 1, memoryMb: Number.NaN }]) expect(code({ request: bad })).toBe("bad_request");
  });

  it("does not read the memory table when a limit already refuses", () => {
    let reads = 0;
    admit({ running: [request, request], readMemAvailableBytes: () => (reads++, need) });
    expect(reads).toBe(0);
  });
});

describe("the engine line", () => {
  const line = (over: Partial<Parameters<typeof engineLineOf>[0]> = {}) => engineLineOf({ platform: "linux", engine: "microvm", caps: CAPS, facts: facts(), ...over });

  it("is microvm only when it is configured, KVM and the helper are there, and every limit is set", () => {
    expect(line()).toBe("microvm");
    expect(line({ engine: "os_sandbox" })).toBe("os_sandbox (microvm not enabled)");
    expect(line({ caps: { ...CAPS, snapshotDir: undefined } })).toBe("os_sandbox (microvm limits missing)");
  });

  it("names the missing piece, KVM before the helper", () => {
    expect(line({ facts: facts({ kvm: "absent" }) })).toBe("os_sandbox (no KVM)");
    expect(line({ facts: facts({ helperSocket: "absent" }) })).toBe("os_sandbox (vm helper not installed)");
    expect(line({ facts: facts({ kvm: "absent", helperSocket: "absent" }) })).toBe("os_sandbox (no KVM)");
  });

  it("a fact that could not be read, or no facts at all, is never microvm", () => {
    expect(line({ facts: facts({ kvm: "unreadable" }) })).toBe("os_sandbox (vm state unreadable)");
    expect(line({ facts: facts({ helperSocket: "unreadable" }) })).toBe("os_sandbox (vm state unreadable)");
    expect(line({ facts: undefined })).toBe("os_sandbox (vm state unreadable)");
  });

  it("macOS says VM mode is not available", () => {
    expect(line({ platform: "darwin" })).toBe(ENGINE_LINES.mac);
  });

  it("the set is closed: every line the function can return is in ENGINE_LINES, and none holds null or undefined", () => {
    const seen = new Set<string>();
    for (const platform of ["linux", "darwin"]) for (const engine of ["os_sandbox", "microvm", "invalid"] as const) for (const kvm of ["present", "absent", "unreadable"] as const) for (const helperSocket of ["present", "absent", "unreadable"] as const) for (const caps of [CAPS, undefined]) for (const f of [facts({ kvm, helperSocket }), undefined]) seen.add(engineLineOf({ platform, engine, caps, facts: f }));
    expect([...seen].sort()).toEqual(Object.values(ENGINE_LINES).sort());
    for (const text of seen) expect(text).not.toMatch(/null|undefined/);
  });
});
