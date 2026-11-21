/**
 * D#845 ON-21: the preflight list of `fx-runner doctor` and `setup`: can this machine run a microVM (KVM, virtualization, cgroups, lingering), reach what a
 * runner needs (the cloud, GitHub, the model API, the package registries), resolve names, keep time and hold a project. Pure over `PreflightFacts`: the kernel's
 * answers are read at the bin edge (`scripts/preflight-facts.mjs`), the network's by `probeNetwork` below through two injected functions, so a test hands in
 * fakes and `src/` names no kernel path.
 *
 * Every check ends `ok`, `warn` or `fail`, with a closed code and a fixed fix line. A fact that could not be read is never `ok`: it is a `warn` with the
 * code `unchecked:<check>`. Nothing in an item carries a host name, an address or a path of this machine: the codes are enums, the fix lines are fixed
 * text, and the only place a name appears is the fixed table of what a runner needs to reach.
 */

export type PreflightLevel = "ok" | "warn" | "fail";
export type PreflightCheck = "kvm_device" | "kvm_access" | "kvm_vt" | "cgroup_v2" | "cgroup_delegate" | "linger" | "net_cloud" | "net_github" | "net_model_api" | "net_registry_npm" | "net_registry_pypi" | "net_ipv4" | "dns" | "clock" | "disk" | "memory";

/** The places a runner must reach. `cloud` is the account's own origin; the others are fixed. */
export const NET_HOSTS = {
  cloud: { check: "net_cloud", name: "the cloud" },
  github: { check: "net_github", name: "github.com" },
  model_api: { check: "net_model_api", name: "api.anthropic.com" },
  registry_npm: { check: "net_registry_npm", name: "registry.npmjs.org" },
  registry_pypi: { check: "net_registry_pypi", name: "pypi.org" },
} as const;
export type NetHost = keyof typeof NET_HOSTS;
export const NET_HOST_KEYS = Object.keys(NET_HOSTS) as NetHost[];
/** The URL asked for each fixed host; `cloud` is the registered origin and is added by the caller. */
export const NET_URLS: Readonly<Record<Exclude<NetHost, "cloud">, string>> = {
  github: "https://github.com/",
  model_api: "https://api.anthropic.com/",
  registry_npm: "https://registry.npmjs.org/",
  registry_pypi: "https://pypi.org/",
};

export const CLOCK_SKEW_MAX_MS = 30_000;
export const DISK_FREE_MIN_BYTES = 10 * 1024 ** 3;
export const MEMORY_FREE_MIN_BYTES = 4 * 1024 ** 3;
const NET_PROBE_TIMEOUT_MS = 8_000;

export type Reading<T> = T | "unknown";

export interface PreflightFacts {
  /** `present`: the device is there and this user can open it for reading and writing. `no_access`: it is there and this user cannot. */
  kvm: Reading<"present" | "absent" | "no_access">;
  /** Whether the processor lists `vmx` or `svm`. */
  vt: Reading<"yes" | "no">;
  cgroup: Reading<"v2" | "v1">;
  /** Whether the user's systemd manager has been handed the memory and process controllers. */
  cgroupDelegated: Reading<"yes" | "no">;
  linger: Reading<"yes" | "no">;
  net: Readonly<Record<NetHost, Reading<"ok" | "blocked">>>;
  ipv4: Reading<"ok" | "v6_only">;
  dns: Reading<"ok" | "failed">;
  /** Machine clock minus the cloud's, in milliseconds. */
  clockSkewMs: number | undefined;
  diskFreeBytes: number | undefined;
  memAvailableBytes: number | undefined;
}

export interface PreflightItem {
  readonly check: PreflightCheck;
  readonly level: PreflightLevel;
  /** Absent when the check is `ok`. */
  readonly code?: string;
  /** Absent when the check is `ok`. */
  readonly fix?: string;
}

/** The closed codes and their fix lines. `<user>` is replaced by the account name at print time, never by anything the cloud sent. */
export const FIX_LINES = {
  kvm_absent: "No KVM on this machine. It will use Standard isolation. On a VPS, ask your provider for nested virtualization, or use a dedicated server",
  kvm_no_access: "Run `sudo usermod -aG kvm <user>`, then sign out and back in",
  kvm_no_vt: "Turn on virtualization (VT-x / AMD-V) in the BIOS or with your provider",
  cgroup_v1: "This system uses cgroup v1. Boot with `systemd.unified_cgroup_hierarchy=1`",
  cgroup_no_delegate: "Run `sudo fx-runner vm install` again; it sets up delegation",
  linger_off: "Run `sudo loginctl enable-linger <user>`",
  net_ipv6_only: "GitHub needs IPv4. Add an IPv4 address or NAT64",
  dns_failed: "This machine can't resolve names. Check `/etc/resolv.conf`",
  clock_skew: "This machine's clock is off. Turn on time sync (`timedatectl set-ntp true`)",
  disk_low: "This machine has less than 10 GB free; a project needs 10 GB. Free some space",
  vm_memory_low: "This machine has less than 4 GB of free memory; an engine needs 4 GB. Stop another engine or add memory",
} as const;
export type FixCode = keyof typeof FIX_LINES;

export const netBlockedFix = (host: NetHost): string => `${NET_HOSTS[host].name} can't be reached from this machine. Check its firewall or proxy`;

const ok = (check: PreflightCheck): PreflightItem => ({ check, level: "ok" });
const unchecked = (check: PreflightCheck): PreflightItem => ({ check, level: "warn", code: `unchecked:${check}`, fix: "This check could not be run on this machine" });
const bad = (check: PreflightCheck, level: "warn" | "fail", code: FixCode): PreflightItem => ({ check, level, code, fix: FIX_LINES[code] });

/** Every check, in a fixed order. */
export function preflightChecks(f: PreflightFacts): PreflightItem[] {
  const out: PreflightItem[] = [];
  out.push(f.kvm === "unknown" ? unchecked("kvm_device") : f.kvm === "absent" ? bad("kvm_device", "fail", "kvm_absent") : ok("kvm_device"));
  // Only a device that is there can be one this user cannot open; with none, the line above already said what is wrong.
  out.push(f.kvm === "unknown" ? unchecked("kvm_access") : f.kvm === "no_access" ? bad("kvm_access", "fail", "kvm_no_access") : ok("kvm_access"));
  out.push(f.vt === "unknown" ? unchecked("kvm_vt") : f.vt === "no" ? bad("kvm_vt", "fail", "kvm_no_vt") : ok("kvm_vt"));
  out.push(f.cgroup === "unknown" ? unchecked("cgroup_v2") : f.cgroup === "v1" ? bad("cgroup_v2", "fail", "cgroup_v1") : ok("cgroup_v2"));
  // Delegation is a property of cgroup v2: on v1 the first check already said what to do.
  out.push(f.cgroup === "v1" ? ok("cgroup_delegate") : f.cgroupDelegated === "unknown" ? unchecked("cgroup_delegate") : f.cgroupDelegated === "no" ? bad("cgroup_delegate", "warn", "cgroup_no_delegate") : ok("cgroup_delegate"));
  out.push(f.linger === "unknown" ? unchecked("linger") : f.linger === "no" ? bad("linger", "warn", "linger_off") : ok("linger"));
  // When names cannot be resolved nothing can be reached, so one finding says it and the per-host answers are not trusted.
  const dnsDown = f.dns === "failed";
  for (const host of NET_HOST_KEYS) {
    const { check } = NET_HOSTS[host];
    const state = f.net[host];
    if (dnsDown) out.push(unchecked(check));
    else if (state === "unknown") out.push(unchecked(check));
    else if (state === "blocked") out.push({ check, level: "fail", code: `net_blocked:${host}`, fix: netBlockedFix(host) });
    else out.push(ok(check));
  }
  out.push(dnsDown ? unchecked("net_ipv4") : f.ipv4 === "unknown" ? unchecked("net_ipv4") : f.ipv4 === "v6_only" ? bad("net_ipv4", "fail", "net_ipv6_only") : ok("net_ipv4"));
  out.push(f.dns === "unknown" ? unchecked("dns") : dnsDown ? bad("dns", "fail", "dns_failed") : ok("dns"));
  out.push(f.clockSkewMs === undefined || !Number.isFinite(f.clockSkewMs) ? unchecked("clock") : Math.abs(f.clockSkewMs) > CLOCK_SKEW_MAX_MS ? bad("clock", "fail", "clock_skew") : ok("clock"));
  out.push(f.diskFreeBytes === undefined || !Number.isFinite(f.diskFreeBytes) ? unchecked("disk") : f.diskFreeBytes < DISK_FREE_MIN_BYTES ? bad("disk", "fail", "disk_low") : ok("disk"));
  out.push(f.memAvailableBytes === undefined || !Number.isFinite(f.memAvailableBytes) ? unchecked("memory") : f.memAvailableBytes < MEMORY_FREE_MIN_BYTES ? bad("memory", "fail", "vm_memory_low") : ok("memory"));
  return out;
}

/** The checks that only matter for running a microVM (and so are warnings, never a failed doctor, unless the person asked for the microVM engine). */
export const VM_CHECKS: ReadonlySet<PreflightCheck> = new Set<PreflightCheck>(["kvm_device", "kvm_access", "kvm_vt", "cgroup_v2", "cgroup_delegate", "memory"]);
export const KVM_CHECKS: ReadonlySet<PreflightCheck> = new Set<PreflightCheck>(["kvm_device", "kvm_access", "kvm_vt"]);

/** The fix line with the account name filled in; a machine that could not name its user shows `<user>` as it is. */
export const fixText = (item: PreflightItem, userName: string | undefined): string => (item.fix ?? "").replaceAll("<user>", userName !== undefined && /^[a-z_][a-z0-9_.-]{0,31}$/i.test(userName) ? userName : "<user>");

// ---- the network readings ----

export interface NetworkPorts {
  fetchFn: typeof fetch;
  /** `dns.lookup(name, { all: true, family })`: rejects when nothing resolves. */
  lookup: (name: string, family: 0 | 4) => Promise<unknown>;
  now: () => Date;
  /** The registered cloud origin, or undefined where the machine is not registered yet (`setup` passes the one it was given). */
  cloudOrigin: string | undefined;
  /** Replaceable by a test only: the URL asked for each fixed host. */
  urls?: Readonly<Record<Exclude<NetHost, "cloud">, string>> | undefined;
}

export type NetworkFacts = Pick<PreflightFacts, "net" | "ipv4" | "dns" | "clockSkewMs">;

/** One request that only has to get an answer: any HTTP status means the host is reachable. Returns the `Date` header's reading as well. */
async function reach(fetchFn: typeof fetch, url: string): Promise<{ state: "ok" | "blocked"; date: string | null }> {
  try {
    const response = await fetchFn(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(NET_PROBE_TIMEOUT_MS) });
    await response.body?.cancel();
    return { state: "ok", date: response.headers.get("date") };
  } catch {
    // fx-swallow-ok: the point of the check is the yes or no; the error text may carry an address
    return { state: "blocked", date: null };
  }
}

async function resolves(lookup: NetworkPorts["lookup"], family: 0 | 4): Promise<boolean> {
  try {
    await lookup("github.com", family);
    return true;
  } catch {
    // fx-swallow-ok: a failed lookup is the answer; its error text is not shown
    return false;
  }
}

/** Asks every place a runner needs, the resolver and the cloud's clock. Nothing is sent but an empty HEAD request per host. */
export async function probeNetwork(ports: NetworkPorts): Promise<NetworkFacts> {
  const urls = ports.urls ?? NET_URLS;
  const origin = ports.cloudOrigin;
  const targets: Array<[NetHost, string | undefined]> = NET_HOST_KEYS.map((host) => [host, host === "cloud" ? origin : urls[host]]);
  const [any, v4, ...results] = await Promise.all([resolves(ports.lookup, 0), resolves(ports.lookup, 4), ...targets.map(([, url]) => (url === undefined ? Promise.resolve(undefined) : reach(ports.fetchFn, url)))]);
  const net = {} as Record<NetHost, Reading<"ok" | "blocked">>;
  targets.forEach(([host], i) => {
    net[host] = results[i]?.state ?? "unknown";
  });
  const cloudDate = results[targets.findIndex(([host]) => host === "cloud")]?.date;
  const cloudMs = cloudDate === null || cloudDate === undefined ? NaN : Date.parse(cloudDate);
  return {
    net,
    dns: any ? "ok" : "failed",
    ipv4: !any ? "unknown" : v4 ? "ok" : "v6_only",
    // The header has one-second resolution, so a skew under the limit is never mistaken for one over it by more than that second.
    clockSkewMs: Number.isFinite(cloudMs) ? ports.now().getTime() - cloudMs : undefined,
  };
}
