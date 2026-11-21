import { describe, expect, it } from "vitest";
import { PREFLIGHT_CODES, PREFLIGHT_FIX, isPreflightCode } from "@fulcrumaxe/runner-protocol";
import { FIX_LINES, NET_HOST_KEYS, netBlockedFix, preflightChecks, type PreflightFacts, type PreflightItem } from "../../src/daemon/preflight.js";
import { PREFLIGHT_REFRESH_MS, createPreflightReporter, readLinger, reportedCodes } from "../../src/daemon/preflightReport.js";

const GIB = 1024 ** 3;
const allOk = (over: Partial<PreflightFacts> = {}): PreflightFacts => ({
  kvm: "present",
  vt: "yes",
  cgroup: "v2",
  cgroupDelegated: "yes",
  linger: "yes",
  net: { cloud: "ok", github: "ok", model_api: "ok", registry_npm: "ok", registry_pypi: "ok" },
  ipv4: "ok",
  dns: "ok",
  clockSkewMs: 0,
  diskFreeBytes: 50 * GIB,
  memAvailableBytes: 16 * GIB,
  ...over,
});
const allUnknown: PreflightFacts = {
  kvm: "unknown",
  vt: "unknown",
  cgroup: "unknown",
  cgroupDelegated: "unknown",
  linger: "unknown",
  net: { cloud: "unknown", github: "unknown", model_api: "unknown", registry_npm: "unknown", registry_pypi: "unknown" },
  ipv4: "unknown",
  dns: "unknown",
  clockSkewMs: undefined,
  diskFreeBytes: undefined,
  memAvailableBytes: undefined,
};

describe("the codes a runner reports are exactly the closed set the cloud stores (D#845 ON-21b)", () => {
  it("every code the doctor's checks can produce is in the protocol's list, and every code in the list is producible", () => {
    const produced = new Set<string>();
    const scenarios: Array<Partial<PreflightFacts>> = [
      { kvm: "absent" }, { kvm: "no_access" }, { vt: "no" }, { cgroup: "v1" }, { cgroupDelegated: "no" }, { linger: "no" }, { ipv4: "v6_only" }, { dns: "failed", ipv4: "unknown" }, { clockSkewMs: 1e9 }, { diskFreeBytes: 1 }, { memAvailableBytes: 1 },
      ...NET_HOST_KEYS.map((host) => ({ net: { ...allOk().net, [host]: "blocked" as const } })),
    ];
    for (const over of [...scenarios, allUnknown]) for (const item of preflightChecks(allOk(over))) if (item.code !== undefined) produced.add(item.code);
    for (const item of preflightChecks(allUnknown)) if (item.code !== undefined) produced.add(item.code);
    expect([...produced].sort()).toEqual([...PREFLIGHT_CODES].sort());
  });

  it("the cloud's fixed line for a code is the very line the doctor prints", () => {
    for (const [code, fix] of Object.entries(FIX_LINES)) expect(PREFLIGHT_FIX[code as keyof typeof PREFLIGHT_FIX], code).toBe(fix);
    for (const host of NET_HOST_KEYS) expect(PREFLIGHT_FIX[`net_blocked:${host}` as const], host).toBe(netBlockedFix(host));
    for (const item of preflightChecks(allUnknown)) expect(PREFLIGHT_FIX[item.code as keyof typeof PREFLIGHT_FIX], item.code).toBe(item.fix);
  });
});

describe("reportedCodes", () => {
  it("lists the codes of the checks that are not ok, each once, in the check order; ok checks and fix text are not in it", () => {
    expect(reportedCodes(preflightChecks(allOk()))).toEqual([]);
    expect(reportedCodes(preflightChecks(allOk({ kvm: "absent", dns: "failed", ipv4: "unknown" })))).toEqual(["kvm_absent", "unchecked:net_cloud", "unchecked:net_github", "unchecked:net_model_api", "unchecked:net_registry_npm", "unchecked:net_registry_pypi", "unchecked:net_ipv4", "dns_failed"]);
    const twice: PreflightItem[] = [{ check: "dns", level: "fail", code: "dns_failed", fix: "x" }, { check: "dns", level: "fail", code: "dns_failed", fix: "x" }];
    expect(reportedCodes(twice)).toEqual(["dns_failed"]);
  });

  it("drops a code outside the closed set, and an item with none", () => {
    const items: PreflightItem[] = [{ check: "dns", level: "fail", code: "dns_failed", fix: "x" }, { check: "disk", level: "fail", code: "net_blocked:internal.example", fix: "x" }, { check: "memory", level: "warn" }, { check: "clock", level: "fail", code: "/var/lib/state" }];
    expect(reportedCodes(items)).toEqual(["dns_failed"]);
    expect(isPreflightCode("net_blocked:internal.example")).toBe(false);
  });
});

describe("the reporter", () => {
  const ports = (over: { kernel?: () => Pick<PreflightFacts, "kvm" | "vt" | "cgroup" | "cgroupDelegated" | "diskFreeBytes" | "memAvailableBytes">; lookup?: () => Promise<unknown>; fetchFn?: typeof fetch; now?: { ms: number } } = {}) => {
    const clock = over.now ?? { ms: 1_000_000 };
    const calls = { kernel: 0, fetch: 0 };
    return {
      calls,
      clock,
      value: {
        kernel: () => {
          calls.kernel += 1;
          return (over.kernel ?? kernelOk)();
        },
        linger: async () => "yes" as const,
        network: {
          fetchFn: (over.fetchFn ?? (async () => {
            calls.fetch += 1;
            return new Response(null, { status: 200, headers: { date: new Date(clock.ms).toUTCString() } });
          })) as typeof fetch,
          lookup: over.lookup ?? (async () => [{ address: "192.0.2.1", family: 4 }]),
          now: () => new Date(clock.ms),
        },
        cloudOrigin: "https://cloud.example.test",
        nowMs: () => clock.ms,
      },
    };
  };
  const kernelOk = () => ({ kvm: "present" as const, vt: "yes" as const, cgroup: "v2" as const, cgroupDelegated: "yes" as const, diskFreeBytes: 50 * GIB, memAvailableBytes: 16 * GIB });

  it("has no reading until the first refresh, then holds the codes of what it found", async () => {
    const p = ports({ kernel: () => ({ ...kernelOk(), kvm: "absent" as const }) });
    const reporter = createPreflightReporter(p.value);
    expect(reporter.codes()).toBeUndefined();
    await reporter.refresh();
    expect(reporter.codes()).toEqual(["kvm_absent"]);
  });

  it("a machine that passes everything reads as an empty list, not as no reading", async () => {
    const reporter = createPreflightReporter(ports().value);
    await reporter.refresh();
    expect(reporter.codes()).toEqual([]);
  });

  it("reads again only after an hour, and never twice at once", async () => {
    const p = ports();
    const reporter = createPreflightReporter(p.value);
    await Promise.all([reporter.refresh(), reporter.refresh(), reporter.refresh()]);
    expect(p.calls.kernel).toBe(1);
    await reporter.refresh();
    p.clock.ms += PREFLIGHT_REFRESH_MS - 1;
    await reporter.refresh();
    expect(p.calls.kernel).toBe(1);
    p.clock.ms += 1;
    await reporter.refresh();
    expect(p.calls.kernel).toBe(2);
  });

  it("a reading that throws leaves the last one in place, says nothing about the failure, and is asked for again in five minutes", async () => {
    let fail = false;
    const p = ports({ kernel: () => {
      if (fail) throw new Error("kernel reader failed at fictional-dir/file");
      return { ...kernelOk(), kvm: "absent" as const };
    } });
    const reporter = createPreflightReporter(p.value);
    await reporter.refresh();
    fail = true;
    p.clock.ms += PREFLIGHT_REFRESH_MS;
    await reporter.refresh();
    expect(reporter.codes()).toEqual(["kvm_absent"]);
    fail = false;
    p.clock.ms += 5 * 60 * 1000 - 1;
    await reporter.refresh();
    expect(p.calls.kernel).toBe(2);
    p.clock.ms += 1;
    await reporter.refresh();
    expect(p.calls.kernel).toBe(3);
  });

  it("what it holds is only closed codes, whatever the network and the resolver say", async () => {
    const reporter = createPreflightReporter(ports({ lookup: async () => { throw new Error("resolver 192.0.2.7 at fictional-dir/resolv"); }, fetchFn: (async () => { throw new Error("connect to 198.51.100.4 refused"); }) as typeof fetch }).value);
    await reporter.refresh();
    expect(reporter.codes()!.length).toBeGreaterThan(0);
    for (const code of reporter.codes()!) expect(isPreflightCode(code), code).toBe(true);
    expect(JSON.stringify(reporter.codes())).not.toMatch(/192\.0|198\.51|fictional|refused/);
  });
});

describe("readLinger", () => {
  const run = (code: number | null, stdout: string, timedOut = false) => ({ run: async () => ({ code, stdout, stderr: "", timedOut }) });
  it("reads yes and no, and anything else (a failure, a timeout, another answer, no uid) as unknown", async () => {
    expect(await readLinger(run(0, "Linger=yes\n"), 1000)).toBe("yes");
    expect(await readLinger(run(0, "Linger=no\n"), 1000)).toBe("no");
    expect(await readLinger(run(1, "Linger=yes\n"), 1000)).toBe("unknown");
    expect(await readLinger(run(0, "Linger=yes\n", true), 1000)).toBe("unknown");
    expect(await readLinger(run(0, "Linger=maybe\n"), 1000)).toBe("unknown");
    expect(await readLinger(run(0, "Linger=yes\n"), undefined)).toBe("unknown");
  });
});
