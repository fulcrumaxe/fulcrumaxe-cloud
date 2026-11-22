/**
 * D#845 ON-21b: the preflight codes a runner reports and the one fixed fix line each one is shown with. The set is closed: it is the whole of what a machine's preflight
 * can say to the cloud (no host name, address or path), it is what the cloud stores and what every screen renders from, and the copy lives only here so a screen never
 * retypes it. `<user>` stays as written: the cloud does not know the machine's account name.
 */

/** The checks a preflight runs; `unchecked:<check>` says one of them could not be run. */
export const PREFLIGHT_CHECKS = ["kvm_device", "kvm_access", "kvm_vt", "cgroup_v2", "cgroup_delegate", "linger", "net_cloud", "net_github", "net_model_api", "net_registry_npm", "net_registry_pypi", "net_ipv4", "dns", "clock", "disk", "memory"] as const;
/** The places a runner must reach; `net_blocked:<host>` names the one it could not. */
export const PREFLIGHT_NET_HOSTS = ["cloud", "github", "model_api", "registry_npm", "registry_pypi"] as const;

const NET_NAME: Readonly<Record<(typeof PREFLIGHT_NET_HOSTS)[number], string>> = { cloud: "the cloud", github: "github.com", model_api: "api.anthropic.com", registry_npm: "registry.npmjs.org", registry_pypi: "pypi.org" };
const UNCHECKED_FIX = "This check could not be run on this machine";

const FIXED = {
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

const blocked = Object.fromEntries(PREFLIGHT_NET_HOSTS.map((h) => [`net_blocked:${h}`, `${NET_NAME[h]} can't be reached from this machine. Check its firewall or proxy`])) as Record<`net_blocked:${(typeof PREFLIGHT_NET_HOSTS)[number]}`, string>;
const unchecked = Object.fromEntries(PREFLIGHT_CHECKS.map((c) => [`unchecked:${c}`, UNCHECKED_FIX])) as Record<`unchecked:${(typeof PREFLIGHT_CHECKS)[number]}`, string>;

/** Every code and its fix line. */
export const PREFLIGHT_FIX: Readonly<Record<keyof typeof FIXED | keyof typeof blocked | keyof typeof unchecked, string>> = { ...FIXED, ...blocked, ...unchecked };
export type PreflightCode = keyof typeof PREFLIGHT_FIX;
/** The closed list, in a fixed order: the schema's enum, the database's CHECK and the screens' keys. */
export const PREFLIGHT_CODES = Object.keys(PREFLIGHT_FIX) as [PreflightCode, ...PreflightCode[]];

export const isPreflightCode = (value: unknown): value is PreflightCode => typeof value === "string" && Object.hasOwn(PREFLIGHT_FIX, value);

/** What a screen shows for a stored list: only members of the closed set, each once, with its fixed line. Anything else is dropped, never shown. */
export function preflightView(stored: unknown): Array<{ code: PreflightCode; fix: string }> {
  if (!Array.isArray(stored)) return [];
  const seen = new Set<PreflightCode>();
  for (const code of stored) if (isPreflightCode(code)) seen.add(code);
  return PREFLIGHT_CODES.filter((code) => seen.has(code)).map((code) => ({ code, fix: PREFLIGHT_FIX[code] }));
}
