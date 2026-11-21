/**
 * D#845 ON-21b: what `fx-runner run` tells the cloud about the machine's preflight (`preflight.ts`): the closed codes of the checks that are not `ok`, on the hello, and nothing else. No host name, address, path
 * or fix text leaves the machine: the cloud holds the fixed line for each code itself. The reading is made once per start and again at most once an hour; between readings the last one stands, and a reading that
 * fails leaves it as it was (never a guess). It is sent only after a hello reply that listed `preflight` (see `commands/run.ts`).
 */
import { isPreflightCode, type PreflightCode } from "@fulcrumaxe/runner-protocol";
import type { SandboxHost } from "../sandbox/probe.js";
import { preflightChecks, probeNetwork, type NetworkPorts, type PreflightFacts, type PreflightItem } from "./preflight.js";

/** The codes of the checks that are not ok, each once, in the check order; a code outside the closed set is dropped (it could not be stored by the cloud). */
export function reportedCodes(items: readonly PreflightItem[]): PreflightCode[] {
  const out: PreflightCode[] = [];
  for (const item of items) if (item.level !== "ok" && item.code !== undefined && isPreflightCode(item.code) && !out.includes(item.code)) out.push(item.code);
  return out;
}

export type LingerReading = PreflightFacts["linger"];

const LOGINCTL = "loginctl";
const LOGINCTL_ENV = { PATH: "/usr/bin:/bin:/run/current-system/sw/bin", LC_ALL: "C" };
/** `loginctl show-user`'s `Linger=` reading, as `doctor` asks it; an answer that is neither yes nor no is unknown. */
export async function readLinger(host: Pick<SandboxHost, "run">, uid: number | undefined): Promise<LingerReading> {
  if (uid === undefined) return "unknown";
  const result = await host.run(LOGINCTL, ["show-user", String(uid), "--property=Linger"], LOGINCTL_ENV, 5_000);
  const linger = result.code === 0 && !result.timedOut ? result.stdout.match(/^Linger=(yes|no)$/m)?.[1] : undefined;
  return linger === "yes" || linger === "no" ? linger : "unknown";
}

export interface PreflightReporterPorts {
  /** The kernel's answers (the bin edge's `kernelFacts`). */
  kernel: () => Pick<PreflightFacts, "kvm" | "vt" | "cgroup" | "cgroupDelegated" | "diskFreeBytes" | "memAvailableBytes">;
  linger: () => Promise<LingerReading>;
  network: Pick<NetworkPorts, "fetchFn" | "lookup" | "now" | "urls">;
  /** The registered cloud origin. */
  cloudOrigin: string;
  /** The clock in milliseconds. */
  nowMs: () => number;
}

export const PREFLIGHT_REFRESH_MS = 60 * 60 * 1000;

export interface PreflightReporter {
  /** The last reading's codes, or undefined while there has been none. */
  codes(): PreflightCode[] | undefined;
  /** Makes a reading when none has been made or the last is older than an hour; never throws, never runs two at once. */
  refresh(): Promise<void>;
}

export function createPreflightReporter(ports: PreflightReporterPorts): PreflightReporter {
  let last: PreflightCode[] | undefined;
  let at = Number.NEGATIVE_INFINITY;
  let running: Promise<void> | undefined;
  const read = async (): Promise<void> => {
    try {
      const network = await probeNetwork({ ...ports.network, cloudOrigin: ports.cloudOrigin });
      last = reportedCodes(preflightChecks({ ...ports.kernel(), ...network, linger: await ports.linger() }));
    } catch {
      // fx-swallow-ok: a reading that cannot be made leaves the last one in place and is asked for again in five minutes; nothing about the failure is sent
      at = ports.nowMs() - PREFLIGHT_REFRESH_MS + 5 * 60 * 1000;
    }
  };
  return {
    codes: () => last,
    refresh() {
      if (running !== undefined) return running;
      if (ports.nowMs() - at < PREFLIGHT_REFRESH_MS) return Promise.resolve();
      at = ports.nowMs();
      running = read().finally(() => {
        running = undefined;
      });
      return running;
    },
  };
}
