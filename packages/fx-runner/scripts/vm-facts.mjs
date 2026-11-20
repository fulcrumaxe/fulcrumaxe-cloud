// The real machine behind `doctor`'s sandbox-engine line and the VM admission guard (D#587 B-6a, `VmHostFacts` in src/vm/limits.ts). It lives here, not in
// src/, because src/ never names a device or a kernel file: it is handed these answers. A fact that cannot be read is "unreadable", never "present".
import { accessSync, constants, lstatSync, readFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { DEFAULT_HELPER_SOCKET, parseMemAvailableBytes } from "../src/vm/limits.js";
import { askHelperState } from "../src/vm/helperProbe.js";
import { HELPER_PROTOCOL } from "../src/vm/sandboxd/helperClient.js";

/** Whether a path is there: "absent" for a plain not-found answer, "unreadable" for any other error, and for a path the user cannot use. */
function presence(file, kind, needReadWrite) {
  try {
    const info = lstatSync(file);
    if (kind === "char" ? !info.isCharacterDevice() : !info.isSocket()) return "unreadable";
    if (needReadWrite) accessSync(file, constants.R_OK | constants.W_OK);
    return "present";
  } catch (error) {
    return error?.code === "ENOENT" || error?.code === "ENOTDIR" ? "absent" : "unreadable";
  }
}

/** The kernel's memory table, in bytes of MemAvailable; undefined when it cannot be read or is not well formed. */
export function readMemAvailableBytes(table = "/proc/meminfo") {
  try {
    return parseMemAvailableBytes(readFileSync(table, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * The machine's facts with what the helper answered added (D#587 B-5a part 3), for the claim gate of a runner set to `microvm`. The helper is asked only when its socket is
 * there and usable; otherwise the state is left out (the gate has its own word for each missing piece). One attempt, with the helper's own time limit.
 * @param {string} [socketPath] the helper's socket; the unit's runtime directory by default
 */
export async function vmHostFactsWithHelper(socketPath = DEFAULT_HELPER_SOCKET) {
  const facts = vmHostFacts(socketPath);
  if (facts.kvm !== "present" || facts.helperSocket !== "present") return facts;
  return { ...facts, helperState: await askHelperState(socketPath, HELPER_PROTOCOL) };
}

/** @param {string} [socketPath] the helper's socket; the unit's runtime directory by default */
export function vmHostFacts(socketPath = DEFAULT_HELPER_SOCKET) {
  return {
    kvm: presence("/dev/kvm", "char", true),
    helperSocket: presence(socketPath, "socket", false),
    helperSocketPath: socketPath,
    totalMemMb: Math.floor(totalmem() / 1024 ** 2),
    cpus: availableParallelism(),
    readMemAvailableBytes: () => readMemAvailableBytes(),
  };
}
