/**
 * D#587 B-6a: the limits a runner in `microvm` mode must have, the host-memory guard that runs before a VM is admitted, and the closed set of
 * lines `doctor` prints for the sandbox engine. Pure: nothing here reads a file, a device or a socket. The machine's answers (does `/dev/kvm` exist,
 * is the helper's socket there, what does the memory table say) arrive through `VmHostFacts`, which only `bin/fx-runner.mjs` fills in, so a test
 * hands in fakes and `src/` carries no path of the kernel's.
 */

export const SANDBOX_ENGINES = ["os_sandbox", "microvm"] as const;
export type SandboxEngine = (typeof SANDBOX_ENGINES)[number];

/** The setting that picks the engine. Absent means `os_sandbox`; a value that is neither is refused, never read as `os_sandbox`. */
export const SANDBOX_ENGINE_KEY = "sandbox_engine";
export const MICROVM_KEYS = ["microvm.max_vms", "microvm.max_vcpus", "microvm.max_memory_mb", "microvm.snapshot_dir", "microvm.snapshot_quota_bytes"] as const;
export type MicrovmKey = (typeof MICROVM_KEYS)[number];

/** The runner-side caps. Every field is required in `microvm` mode and there is no default for any of them. */
export interface MicrovmCaps {
  maxVms: number;
  maxVcpus: number;
  /** Per VM, in MiB. */
  maxMemoryMb: number;
  snapshotDir: string;
  snapshotQuotaBytes: number;
}
export type PartialMicrovmCaps = Partial<MicrovmCaps>;

const CAP_FIELD: Readonly<Record<MicrovmKey, keyof MicrovmCaps>> = {
  "microvm.max_vms": "maxVms",
  "microvm.max_vcpus": "maxVcpus",
  "microvm.max_memory_mb": "maxMemoryMb",
  "microvm.snapshot_dir": "snapshotDir",
  "microvm.snapshot_quota_bytes": "snapshotQuotaBytes",
};
export const capFieldOf = (key: MicrovmKey): keyof MicrovmCaps => CAP_FIELD[key];

const CAP_RANGE: Readonly<Record<"maxVms" | "maxVcpus" | "maxMemoryMb" | "snapshotQuotaBytes", readonly [number, number]>> = {
  maxVms: [1, 64],
  maxVcpus: [1, 256],
  maxMemoryMb: [256, 4_194_304],
  snapshotQuotaBytes: [1, Number.MAX_SAFE_INTEGER],
};
export const capRangeOf = (field: keyof typeof CAP_RANGE): readonly [number, number] => CAP_RANGE[field];

/** An absolute path written plainly: no `.` or `..` part, no doubled or trailing slash, no control character, at most 1024 characters. */
export function isPlainAbsolutePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 2 || value.length > 1024 || !value.startsWith("/") || value.endsWith("/")) return false;
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value)) return false;
  return value.slice(1).split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** One stored cap, or undefined when it is missing or out of range. An invalid value is absent: doctor then reports it as missing and nothing is claimed. */
export function parseCap(field: keyof MicrovmCaps, value: unknown): number | string | undefined {
  if (field === "snapshotDir") return isPlainAbsolutePath(value) ? value : undefined;
  const [min, max] = CAP_RANGE[field];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}

/** The names of the caps that are not set, in the order the settings are listed. */
export function missingCaps(caps: PartialMicrovmCaps | undefined): MicrovmKey[] {
  return MICROVM_KEYS.filter((key) => caps?.[CAP_FIELD[key]] === undefined);
}

/** All five caps, or undefined when any one is missing. */
export function completeCaps(caps: PartialMicrovmCaps | undefined): MicrovmCaps | undefined {
  if (caps === undefined || missingCaps(caps).length > 0) return undefined;
  return caps as MicrovmCaps;
}

/**
 * Whether this runner may claim, as far as its configured engine and limits go. Only `microvm` mode with an incomplete set of limits, or an engine
 * setting that is neither value, blocks. `os_sandbox` ignores the caps, even bad ones.
 */
export type ClaimBlock = "engine_setting_invalid" | "microvm_limits_missing";
export function limitsClaimBlock(engine: SandboxEngine | "invalid", caps: PartialMicrovmCaps | undefined): ClaimBlock | undefined {
  if (engine === "invalid") return "engine_setting_invalid";
  if (engine === "microvm" && missingCaps(caps).length > 0) return "microvm_limits_missing";
  return undefined;
}

// ---- admission (the B-0 guard) ----

export const HEADROOM_BYTES = 1024 ** 3;
const MIB = 1024 ** 2;

/** Bytes of memory the host can give a new VM, or undefined when it could not be read. */
export type MemAvailableReader = () => number | undefined;

/** The value of the `MemAvailable` line of the kernel's memory table, in bytes. Undefined unless exactly one well-formed line is there. */
export function parseMemAvailableBytes(text: string | undefined): number | undefined {
  if (typeof text !== "string") return undefined;
  const lines = text.split("\n").filter((l) => l.startsWith("MemAvailable:"));
  if (lines.length !== 1) return undefined;
  const match = (lines[0] as string).match(/^MemAvailable:[ \t]+(\d{1,15})[ \t]+kB$/);
  if (match === null) return undefined;
  const bytes = Number(match[1]) * 1024;
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}

export interface VmRequest {
  vcpus: number;
  memoryMb: number;
}
export type AdmissionRefusal = "limits_missing" | "bad_request" | "vm_cap_reached" | "vcpu_cap_exceeded" | "memory_cap_exceeded" | "mem_unreadable" | "mem_low";
export type Admission = { admit: true } | { admit: false; code: AdmissionRefusal; detail: string };

/**
 * Whether one more VM may start now. It refuses and never queues. Each running VM counts at its full configured RAM, never its resident size
 * (an idle guest was measured at 97 MB with a 1.27 GB peak that is not given back). The new VM needs its own RAM and 1 GiB of headroom to be free
 * on top of what the running guests may still take, so with none running the rule is "MemAvailable at least the request plus 1 GiB". A memory table
 * that cannot be read refuses.
 */
export function admitVm(input: { caps: MicrovmCaps | undefined; running: readonly VmRequest[]; request: VmRequest; readMemAvailableBytes: MemAvailableReader }): Admission {
  const { caps, running, request } = input;
  if (caps === undefined) return { admit: false, code: "limits_missing", detail: "the microvm limits are not all set" };
  if (!Number.isSafeInteger(request.vcpus) || request.vcpus < 1 || !Number.isSafeInteger(request.memoryMb) || request.memoryMb < 1) return { admit: false, code: "bad_request", detail: "a VM needs a whole number of vCPUs and MiB, at least 1 each" };
  if (running.length >= caps.maxVms) return { admit: false, code: "vm_cap_reached", detail: `${running.length} VMs are running; the limit is ${caps.maxVms}` };
  if (request.vcpus > caps.maxVcpus) return { admit: false, code: "vcpu_cap_exceeded", detail: `${request.vcpus} vCPUs asked; the limit is ${caps.maxVcpus}` };
  if (request.memoryMb > caps.maxMemoryMb) return { admit: false, code: "memory_cap_exceeded", detail: `${request.memoryMb} MiB asked; the limit is ${caps.maxMemoryMb}` };
  let available: number | undefined;
  try {
    available = input.readMemAvailableBytes();
  } catch {
    // fx-swallow-ok: a reader that throws is the same as one that cannot read; both refuse below
    available = undefined;
  }
  if (typeof available !== "number" || !Number.isFinite(available) || available < 0) return { admit: false, code: "mem_unreadable", detail: "the host's available memory could not be read" };
  let committed = 0;
  for (const vm of running) committed += vm.memoryMb;
  const need = (committed + request.memoryMb) * MIB + HEADROOM_BYTES;
  if (available < need) return { admit: false, code: "mem_low", detail: `${Math.floor(available / MIB)} MiB available; ${Math.ceil(need / MIB)} MiB needed (${request.memoryMb} requested, ${committed} for running VMs, 1024 headroom)` };
  return { admit: true };
}

// ---- doctor's engine line ----

export type Presence = "present" | "absent" | "unreadable";

/** What the machine says, filled in by `bin/fx-runner.mjs`. A fact the caller could not read is `unreadable` (or left out), never `present`. */
export interface VmHostFacts {
  /** The device the hypervisor needs. */
  kvm: Presence;
  /** The helper's socket (`fx-runner vm install` makes it). */
  helperSocket: Presence;
  /** Where the socket is looked for, for the message. */
  helperSocketPath: string;
  /** Total memory in MiB and the core count, to print beside the limits. */
  totalMemMb?: number | undefined;
  cpus?: number | undefined;
  readMemAvailableBytes: MemAvailableReader;
}

/** The default place for the helper's socket: the systemd runtime directory the helper's unit owns. Config, not a constant of the protocol. */
// Pinned by the helper's hardening file: runtime_directory "fx-vmhelper" and socket_name "helper.sock". Not settable.
export const DEFAULT_HELPER_SOCKET = "/run/fx-vmhelper/helper.sock";

/** Every engine line `doctor` can print. The test enumerates this set; nothing else is printed after `sandbox_engine:`. */
export const ENGINE_LINES = {
  microvm: "microvm",
  noKvm: "os_sandbox (no KVM)",
  helperMissing: "os_sandbox (vm helper not installed)",
  unreadable: "os_sandbox (vm state unreadable)",
  notEnabled: "os_sandbox (microvm not enabled)",
  limitsMissing: "os_sandbox (microvm limits missing)",
  mac: "macOS: VM mode not available in this version",
} as const;
export type EngineLine = (typeof ENGINE_LINES)[keyof typeof ENGINE_LINES];

/** The engine this runner would register as, with the reason when it is not `microvm`. `microvm` only when it is configured, KVM and the helper are there, and every limit is set. */
export function engineLineOf(input: { platform: string; engine: SandboxEngine | "invalid"; caps: PartialMicrovmCaps | undefined; facts: VmHostFacts | undefined }): EngineLine {
  if (input.platform === "darwin") return ENGINE_LINES.mac;
  const { facts } = input;
  if (facts === undefined || facts.kvm === "unreadable" || facts.helperSocket === "unreadable") return ENGINE_LINES.unreadable;
  if (facts.kvm === "absent") return ENGINE_LINES.noKvm;
  if (facts.helperSocket === "absent") return ENGINE_LINES.helperMissing;
  if (input.engine !== "microvm") return ENGINE_LINES.notEnabled;
  if (missingCaps(input.caps).length > 0) return ENGINE_LINES.limitsMissing;
  return ENGINE_LINES.microvm;
}
