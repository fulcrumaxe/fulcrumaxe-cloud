// The kernel's answers behind `doctor`'s preflight list (D#845 ON-21, `src/daemon/preflight.ts`). It lives here, not in src/, because src/ never names a device or a
// kernel file: it is handed these answers. A fact that cannot be read is "unknown", never a pass. Nothing here writes, and nothing is sent anywhere.
import { accessSync, constants, existsSync, lstatSync, readFileSync, statfsSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { dirname } from "node:path";

const KVM_DEVICE = "/dev/kvm";
const CPUINFO = "/proc/cpuinfo";
const CGROUP_ROOT = "/sys/fs/cgroup";
const DELEGATED_CONTROLLERS = ["memory", "pids"];

/** The device: absent, there and usable by this user, there and not usable by this user, or not readable at all. */
export function kvmReading(device = KVM_DEVICE) {
  try {
    const info = lstatSync(device);
    if (!info.isCharacterDevice()) return "unknown";
    accessSync(device, constants.R_OK | constants.W_OK);
    return "present";
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return "absent";
    return error?.code === "EACCES" || error?.code === "EPERM" ? "no_access" : "unknown";
  }
}

/** Whether the processor lists the virtualization extension. Other architectures have no such flag, so they are not held to it. */
export function vtReading(arch = process.arch, cpuinfo = CPUINFO) {
  if (arch !== "x64") return "yes";
  try {
    const flags = readFileSync(cpuinfo, "utf8").split("\n").filter((line) => line.startsWith("flags"));
    if (flags.length === 0) return "unknown";
    return flags.some((line) => /\s(vmx|svm)(\s|$)/.test(line)) ? "yes" : "no";
  } catch {
    // fx-swallow-ok: a table that cannot be read is an unknown reading, reported as such
    return "unknown";
  }
}

export function cgroupReading(root = CGROUP_ROOT) {
  try {
    if (existsSync(`${root}/cgroup.controllers`)) return "v2";
    return existsSync(root) ? "v1" : "unknown";
  } catch {
    // fx-swallow-ok: see above
    return "unknown";
  }
}

/** Whether the user's systemd manager owns the memory and process controllers, which is what lets the runner's own user cap a job. */
export function delegationReading(uid, root = CGROUP_ROOT) {
  if (typeof uid !== "number") return "unknown";
  try {
    const text = readFileSync(`${root}/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`, "utf8");
    const have = text.trim().split(/\s+/);
    return DELEGATED_CONTROLLERS.every((name) => have.includes(name)) ? "yes" : "no";
  } catch (error) {
    return error?.code === "ENOENT" || error?.code === "ENOTDIR" ? "no" : "unknown";
  }
}

/** Free bytes where the runner keeps its work: the state directory, or the nearest folder above it that exists. */
export function diskFreeBytes(dir) {
  let at = dir;
  for (let i = 0; i < 16; i++) {
    try {
      const fs = statfsSync(at);
      return Number(fs.bavail) * Number(fs.bsize);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") return undefined;
      const up = dirname(at);
      if (up === at) return undefined;
      at = up;
    }
  }
  return undefined;
}

/** @param {{ uid: number | undefined, stateDir: string, readMemAvailableBytes: () => number | undefined }} input `readMemAvailableBytes` is the one `vm-facts.mjs` already has. */
export function kernelFacts(input) {
  return {
    kvm: kvmReading(),
    vt: vtReading(),
    cgroup: cgroupReading(),
    cgroupDelegated: delegationReading(input.uid),
    diskFreeBytes: diskFreeBytes(input.stateDir),
    memAvailableBytes: input.readMemAvailableBytes(),
  };
}

/** The resolver the network probe uses: every address family by default, or IPv4 only. */
export const resolver = (name, family) => lookup(name, { all: true, family });
