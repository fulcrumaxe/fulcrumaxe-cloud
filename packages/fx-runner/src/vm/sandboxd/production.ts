/**
 * Production wiring of `fx-sandboxd` (D#587 B-2b-iii-b): the real `inspectDir` and the dependency set a daemon process builds. Nothing here
 * decides policy; every check is in sandboxd.ts and runs on what these adapters report.
 */
import net from "node:net";
import type { Duplex } from "node:stream";
import { agentAtVsockDir } from "./guestAgent.js";
import { createHelperClient } from "./helperClient.js";
import { Sandboxd, type SandboxdDeps } from "./sandboxd.js";
import type { SnapshotDeps } from "./snapshots.js";
import { fdInspectDir, hasForeignListener, realFdOps, removeOwnVsockSocket, type FdOps, type HostFacts } from "./vsockFd.js";

const connectUnix = (file: string) => (): Promise<Duplex> =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection(file);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
  });

/** The fd operations for this host, or undefined where there are none (not Linux, or no euid): then nothing is inspected and nothing connects. */
function fdOps(host: HostFacts): FdOps | undefined {
  try {
    return realFdOps(host);
  } catch {
    // fx-swallow-ok: no fd operations on this host; the callers answer "not inspectable" or refuse the connect
    return undefined;
  }
}

/** Where there are no fd operations, a connect is refused at its first step. */
export const REFUSING_OPS: FdOps = {
  euid: -1,
  open: () => {
    throw new Error("no descriptor operations on this host");
  },
  fstat: () => {
    throw new Error("no descriptor operations on this host");
  },
  close: () => undefined,
  unlink: () => {
    throw new Error("no descriptor operations on this host");
  },
  dial: () => {
    throw new Error("no descriptor operations on this host");
  },
};

export interface ProductionConfig {
  /** The helper's socket, from the runner's config. */
  helperSocket: string;
  /** The runner's effective user id (`process.geteuid()`, undefined where there is none) and platform, read once by the caller and passed in. */
  host: HostFacts;
  /** Signed-metadata gate input: which targets are listed, and the digests a template boots from (B-2a-2's pinned manifest). */
  boot: SandboxdDeps["boot"];
  bootTimeoutMs?: number;
  helperTimeoutMs?: number;
  /** `microvm.snapshot_dir` and `microvm.snapshot_quota_bytes`, the caller's free-space reader (statfs, built outside `src`) and the daemon's 0700 state directory. Absent: no sandbox may be persistent. */
  snapshots?: SnapshotDeps;
}

/** The dependency set a daemon process builds: the real euid, the O_PATH fd inspection, helper socket, Firecracker vsock and clock. */
export function productionDeps(config: ProductionConfig): SandboxdDeps {
  return {
    euid: config.host.euid,
    helper: createHelperClient(connectUnix(config.helperSocket), config.helperTimeoutMs),
    boot: config.boot,
    inspectDir: (dir) => {
      const ops = fdOps(config.host);
      return ops === undefined ? undefined : fdInspectDir(dir, ops);
    },
    hasForeignListener: (dir) => {
      const ops = fdOps(config.host);
      return ops === undefined ? true : hasForeignListener(dir, ops);
    },
    agentFor: (dir) => agentAtVsockDir(dir, fdOps(config.host) ?? REFUSING_OPS),
    removeVsockSocket: (dir) => removeOwnVsockSocket(dir, fdOps(config.host) ?? REFUSING_OPS),
    ...(config.snapshots === undefined ? {} : { snapshots: config.snapshots }),
    now: () => Math.floor(Date.now() / 1000),
    ...(config.bootTimeoutMs === undefined ? {} : { bootTimeoutMs: config.bootTimeoutMs }),
  };
}

/** The daemon as a process builds it. Throws if run as root, or where the euid is unknown. */
export function createProductionSandboxd(config: ProductionConfig): Sandboxd {
  return new Sandboxd(productionDeps(config));
}
