import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cgroupReading, delegationReading, diskFreeBytes, kvmReading, vtReading } from "../../scripts/preflight-facts.mjs";
import { CLOCK_SKEW_MAX_MS, DISK_FREE_MIN_BYTES, FIX_LINES, MEMORY_FREE_MIN_BYTES, NET_HOST_KEYS, NET_URLS, fixText, netBlockedFix, preflightChecks, probeNetwork, type NetHost, type PreflightFacts, type PreflightItem } from "../../src/daemon/preflight.js";

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
const codes = (items: readonly PreflightItem[]): Array<string | undefined> => items.filter((i) => i.level !== "ok").map((i) => i.code);
const find = (items: readonly PreflightItem[], check: string): PreflightItem => items.find((i) => i.check === check) as PreflightItem;

describe("preflightChecks: every closed code, from faked facts", () => {
  it("a machine that passes everything is all ok, with no code and no fix", () => {
    const items = preflightChecks(allOk());
    expect(items.every((i) => i.level === "ok" && i.code === undefined && i.fix === undefined)).toBe(true);
    expect(items).toHaveLength(16);
  });

  const cases: Array<[string, Partial<PreflightFacts>, string, "warn" | "fail", string]> = [
    ["kvm_absent", { kvm: "absent" }, "kvm_device", "fail", FIX_LINES.kvm_absent],
    ["kvm_no_access", { kvm: "no_access" }, "kvm_access", "fail", FIX_LINES.kvm_no_access],
    ["kvm_no_vt", { vt: "no" }, "kvm_vt", "fail", FIX_LINES.kvm_no_vt],
    ["cgroup_v1", { cgroup: "v1" }, "cgroup_v2", "fail", FIX_LINES.cgroup_v1],
    ["cgroup_no_delegate", { cgroupDelegated: "no" }, "cgroup_delegate", "warn", FIX_LINES.cgroup_no_delegate],
    ["linger_off", { linger: "no" }, "linger", "warn", FIX_LINES.linger_off],
    ["net_blocked:github", { net: { ...allOk().net, github: "blocked" } }, "net_github", "fail", netBlockedFix("github")],
    ["net_blocked:cloud", { net: { ...allOk().net, cloud: "blocked" } }, "net_cloud", "fail", netBlockedFix("cloud")],
    ["net_blocked:model_api", { net: { ...allOk().net, model_api: "blocked" } }, "net_model_api", "fail", netBlockedFix("model_api")],
    ["net_blocked:registry_npm", { net: { ...allOk().net, registry_npm: "blocked" } }, "net_registry_npm", "fail", netBlockedFix("registry_npm")],
    ["net_blocked:registry_pypi", { net: { ...allOk().net, registry_pypi: "blocked" } }, "net_registry_pypi", "fail", netBlockedFix("registry_pypi")],
    ["net_ipv6_only", { ipv4: "v6_only" }, "net_ipv4", "fail", FIX_LINES.net_ipv6_only],
    ["dns_failed", { dns: "failed", ipv4: "unknown" }, "dns", "fail", FIX_LINES.dns_failed],
    ["clock_skew (ahead)", { clockSkewMs: CLOCK_SKEW_MAX_MS + 1 }, "clock", "fail", FIX_LINES.clock_skew],
    ["clock_skew (behind)", { clockSkewMs: -(CLOCK_SKEW_MAX_MS + 1) }, "clock", "fail", FIX_LINES.clock_skew],
    ["disk_low", { diskFreeBytes: DISK_FREE_MIN_BYTES - 1 }, "disk", "fail", FIX_LINES.disk_low],
    ["vm_memory_low", { memAvailableBytes: MEMORY_FREE_MIN_BYTES - 1 }, "memory", "fail", FIX_LINES.vm_memory_low],
  ];
  it.each(cases)("%s", (code, over, check, level, fix) => {
    const items = preflightChecks(allOk(over));
    const item = find(items, check);
    expect(item).toMatchObject({ level, fix });
    expect(item.code).toBe(code.replace(/ \(.*\)$/, ""));
    // A dead resolver also leaves every per-host answer unchecked (said in its own test below); every other case is the only finding.
    if (item.code !== "dns_failed") expect(codes(items)).toEqual([item.code]);
  });

  it("the limits are inclusive: exactly 30 s of skew, 10 GB of disk and 4 GB of memory pass", () => {
    expect(codes(preflightChecks(allOk({ clockSkewMs: CLOCK_SKEW_MAX_MS, diskFreeBytes: DISK_FREE_MIN_BYTES, memAvailableBytes: MEMORY_FREE_MIN_BYTES })))).toEqual([]);
  });

  it("dns_failed is the one finding when names do not resolve: the per-host answers are not trusted", () => {
    const items = preflightChecks(allOk({ dns: "failed", ipv4: "unknown", net: { cloud: "blocked", github: "blocked", model_api: "blocked", registry_npm: "blocked", registry_pypi: "blocked" } }));
    expect(find(items, "dns")).toMatchObject({ level: "fail", code: "dns_failed", fix: FIX_LINES.dns_failed });
    expect(codes(items).filter((c) => c?.startsWith("net_"))).toEqual([]);
  });

  it("cgroup v1 reports cgroup_v1 once, not a second finding about delegation", () => {
    expect(codes(preflightChecks(allOk({ cgroup: "v1", cgroupDelegated: "no" })))).toEqual(["cgroup_v1"]);
  });

  it("a fact that could not be read is a warning that says so, never ok", () => {
    const items = preflightChecks(allOk({ kvm: "unknown", vt: "unknown", cgroup: "unknown", cgroupDelegated: "unknown", linger: "unknown", ipv4: "unknown", dns: "unknown", clockSkewMs: undefined, diskFreeBytes: undefined, memAvailableBytes: undefined, net: { cloud: "unknown", github: "unknown", model_api: "unknown", registry_npm: "unknown", registry_pypi: "unknown" } }));
    expect(items.every((i) => i.level === "warn" && i.code === `unchecked:${i.check}`)).toBe(true);
    expect(items.some((i) => i.level === "ok")).toBe(false);
  });

  it("NaN readings are unchecked, not passes", () => {
    const items = preflightChecks(allOk({ clockSkewMs: Number.NaN, diskFreeBytes: Number.NaN, memAvailableBytes: Number.NaN }));
    expect(codes(items)).toEqual(["unchecked:clock", "unchecked:disk", "unchecked:memory"]);
  });

  it("no code or fix line carries a host name, an address or a path of this machine (criterion 5)", () => {
    const worst = preflightChecks(allOk({ kvm: "absent", vt: "no", cgroup: "v1", linger: "no", ipv4: "v6_only", clockSkewMs: 1e9, diskFreeBytes: 0, memAvailableBytes: 0, net: { cloud: "blocked", github: "blocked", model_api: "blocked", registry_npm: "blocked", registry_pypi: "blocked" } }));
    for (const item of worst.filter((i) => i.level !== "ok")) {
      expect(item.code ?? "").toMatch(/^[a-z0-9_:]+$/);
      expect(item.fix ?? "").not.toMatch(/\d+\.\d+\.\d+\.\d+|https?:|\/home\/|\/Users\//);
    }
  });

  it("every code in the closed table has a check that can produce it", () => {
    const produced = new Set<string>();
    for (const [, over] of cases.map((c) => [c[0], c[1]] as const)) for (const i of preflightChecks(allOk(over))) if (i.code !== undefined) produced.add(i.code);
    for (const code of Object.keys(FIX_LINES)) expect(produced.has(code), code).toBe(true);
  });

  it("<user> is filled in only from a plain account name", () => {
    const item = find(preflightChecks(allOk({ linger: "no" })), "linger");
    expect(fixText(item, "alex")).toBe("Run `sudo loginctl enable-linger alex`");
    expect(fixText(item, undefined)).toBe(FIX_LINES.linger_off);
    expect(fixText(item, "a b; rm -rf /")).toBe(FIX_LINES.linger_off);
  });
});

describe("faked /proc and /sys readers (scripts/preflight-facts.mjs)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "fxr-preflight-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const write = (rel: string, text: string): string => {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    return file;
  };

  it("vt: vmx or svm in a flags line is yes, neither is no, an unreadable table is unknown, other architectures are not held to it", () => {
    expect(vtReading("x64", write("a", "processor : 0\nflags\t\t: fpu vme vmx sse\n"))).toBe("yes");
    expect(vtReading("x64", write("b", "flags : fpu svm sse\n"))).toBe("yes");
    expect(vtReading("x64", write("c", "flags : fpu vme sse2 xvmx\n"))).toBe("no");
    expect(vtReading("x64", write("d", "model name : x\n"))).toBe("unknown");
    expect(vtReading("x64", path.join(root, "missing"))).toBe("unknown");
    expect(vtReading("arm64", path.join(root, "missing"))).toBe("yes");
  });

  it("cgroup: the unified controllers file means v2, a bare mount v1, nothing unknown", () => {
    const v2 = path.join(root, "v2");
    write("v2/cgroup.controllers", "cpu memory pids\n");
    const v1 = path.join(root, "v1");
    mkdirSync(v1);
    expect(cgroupReading(v2)).toBe("v2");
    expect(cgroupReading(v1)).toBe("v1");
    expect(cgroupReading(path.join(root, "none"))).toBe("unknown");
  });

  it("delegation: the user's manager needs memory and pids; no manager is no; no uid is unknown", () => {
    const cg = path.join(root, "cg");
    write("cg/user.slice/user-1000.slice/user@1000.service/cgroup.controllers", "cpu memory pids\n");
    write("cg/user.slice/user-1001.slice/user@1001.service/cgroup.controllers", "cpu\n");
    expect(delegationReading(1000, cg)).toBe("yes");
    expect(delegationReading(1001, cg)).toBe("no");
    expect(delegationReading(1002, cg)).toBe("no");
    expect(delegationReading(undefined, cg)).toBe("unknown");
  });

  it("kvm: no such device is absent, a plain file is not a device (unknown); a real run on this host reads one of the four answers", () => {
    expect(kvmReading(path.join(root, "kvm"))).toBe("absent");
    expect(kvmReading(write("kvm-file", ""))).toBe("unknown");
    chmodSync(root, 0o700);
    expect(["present", "absent", "no_access", "unknown"]).toContain(kvmReading());
  });

  it("disk: free bytes of the nearest folder that exists, undefined for no folder at all", () => {
    expect(diskFreeBytes(path.join(root, "not", "yet", "made"))).toBeGreaterThan(0);
    expect(diskFreeBytes("/")).toBeGreaterThan(0);
  });
});

describe("probeNetwork through the real connection path", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  });
  const listen = async (handler: Parameters<typeof createServer>[1]): Promise<string> => {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  };
  const urls = (over: Partial<Record<Exclude<NetHost, "cloud">, string>>): Record<Exclude<NetHost, "cloud">, string> => ({ ...NET_URLS, ...over });
  const lookupOk = async (): Promise<unknown> => [{ address: "192.0.2.1", family: 4 }];

  it("a host that answers with any status is ok (a 401 and a 404 are answers); one that refuses the connection is blocked; the cloud's Date header gives the skew", async () => {
    const answers = await listen((_req, res) => {
      res.setHeader("date", new Date(Date.now() - 5_000).toUTCString());
      res.statusCode = 401;
      res.end();
    });
    const notFound = await listen((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    const dead = await listen((_req, res) => res.end());
    await new Promise<void>((resolve) => servers.pop()?.close(() => resolve()));
    const facts = await probeNetwork({ fetchFn: fetch, lookup: lookupOk, now: () => new Date(), cloudOrigin: answers, urls: urls({ github: notFound, model_api: dead, registry_npm: notFound, registry_pypi: notFound }) });
    expect(facts.net).toEqual({ cloud: "ok", github: "ok", model_api: "blocked", registry_npm: "ok", registry_pypi: "ok" });
    expect(facts.dns).toBe("ok");
    expect(facts.ipv4).toBe("ok");
    expect(facts.clockSkewMs).toBeGreaterThan(3_000);
    expect(facts.clockSkewMs).toBeLessThan(8_000);
  });

  it("no registered origin leaves the cloud check and the skew unread, never ok", async () => {
    const up = await listen((_req, res) => res.end());
    const facts = await probeNetwork({ fetchFn: fetch, lookup: lookupOk, now: () => new Date(), cloudOrigin: undefined, urls: urls({ github: up, model_api: up, registry_npm: up, registry_pypi: up }) });
    expect(facts.net.cloud).toBe("unknown");
    expect(facts.clockSkewMs).toBeUndefined();
  });

  it("a reply without a usable Date header leaves the skew unread", async () => {
    const up = await listen((_req, res) => {
      res.setHeader("date", "not a date");
      res.end();
    });
    const facts = await probeNetwork({ fetchFn: fetch, lookup: lookupOk, now: () => new Date(), cloudOrigin: up, urls: urls({ github: up, model_api: up, registry_npm: up, registry_pypi: up }) });
    expect(facts.clockSkewMs).toBeUndefined();
  });

  it("names that do not resolve are dns failed and the IPv4 answer is unknown; an IPv4-less answer is v6_only", async () => {
    const up = await listen((_req, res) => res.end());
    const common = { fetchFn: fetch, now: () => new Date(), cloudOrigin: up, urls: urls({ github: up, model_api: up, registry_npm: up, registry_pypi: up }) };
    const down = await probeNetwork({ ...common, lookup: async () => Promise.reject(new Error("ENOTFOUND")) });
    expect(down).toMatchObject({ dns: "failed", ipv4: "unknown" });
    const v6 = await probeNetwork({ ...common, lookup: async (_name, family) => (family === 4 ? Promise.reject(new Error("ENODATA")) : [{ address: "2001:db8::1", family: 6 }]) });
    expect(v6).toMatchObject({ dns: "ok", ipv4: "v6_only" });
  });

  it("sends only an empty HEAD request, and follows no redirect", async () => {
    const seen: Array<{ method: string | undefined; body: number }> = [];
    const url = await listen((req, res) => {
      let n = 0;
      req.on("data", (c: Buffer) => (n += c.length));
      req.on("end", () => {
        seen.push({ method: req.method, body: n });
        res.statusCode = 302;
        res.setHeader("location", "http://127.0.0.1:1/never");
        res.end();
      });
    });
    const facts = await probeNetwork({ fetchFn: fetch, lookup: lookupOk, now: () => new Date(), cloudOrigin: url, urls: urls({ github: url, model_api: url, registry_npm: url, registry_pypi: url }) });
    expect(Object.values(facts.net).every((s) => s === "ok")).toBe(true);
    expect(seen.length).toBe(NET_HOST_KEYS.length);
    expect(seen.every((s) => s.method === "HEAD" && s.body === 0)).toBe(true);
  });
});
