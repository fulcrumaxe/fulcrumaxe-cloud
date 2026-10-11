/**
 * D#605 FL-2: what this machine is, as the `facts` of a `hello` and the default name of a registration. Read from the operating system,
 * never from the environment or a file the person edits. Facts are claims: the cloud uses them to route and to show, never to decide
 * who may do what, so a wrong figure can send work to a poor fit and nothing more.
 */
import os from "node:os";
import { RUNNER_MEM_GB_BUCKETS, RUNNER_NAME_MAX, isValidRunnerName, type RunnerFacts } from "@fulcrumaxe/runner-protocol";

export interface HostFactsInput {
  /** `os.platform()` */
  platform: NodeJS.Platform;
  /** `os.arch()` */
  arch: string;
  totalMemBytes: number;
  /** `os.availableParallelism()` */
  cpus: number;
}

const GIB = 1024 ** 3;

/** The largest reportable memory bucket that the machine's rounded-up gigabytes reach; a machine under 4 GB reports the smallest bucket. */
export function memBucketOf(totalMemBytes: number): (typeof RUNNER_MEM_GB_BUCKETS)[number] {
  const gb = Number.isFinite(totalMemBytes) && totalMemBytes > 0 ? Math.ceil(totalMemBytes / GIB) : 0;
  let bucket: (typeof RUNNER_MEM_GB_BUCKETS)[number] = RUNNER_MEM_GB_BUCKETS[0];
  for (const candidate of RUNNER_MEM_GB_BUCKETS) if (candidate <= gb) bucket = candidate;
  return bucket;
}

/**
 * The facts for a machine, or undefined when it is not one the protocol names (the runner supports Linux and macOS on x64 and arm64, so this is
 * the unsupported case, which sends a hello with no facts rather than a wrong one). This build runs jobs in the operating-system sandbox only.
 */
export function hostFactsOf(input: HostFactsInput): RunnerFacts | undefined {
  const osName = input.platform === "linux" ? "linux" : input.platform === "darwin" ? "macos" : undefined;
  const arch = input.arch === "x64" ? "x64" : input.arch === "arm64" ? "arm64" : undefined;
  if (osName === undefined || arch === undefined) return undefined;
  const cpus = Math.min(256, Math.max(1, Number.isFinite(input.cpus) ? Math.trunc(input.cpus) : 1));
  return { os: osName, arch, mem_gb_bucket: memBucketOf(input.totalMemBytes), cpus, sandbox_engine: "os_sandbox" };
}

export const readHostFacts = (): RunnerFacts | undefined => hostFactsOf({ platform: os.platform(), arch: os.arch(), totalMemBytes: os.totalmem(), cpus: os.availableParallelism() });

/**
 * The machine's host name as the default runner name: characters the name rule refuses are dropped (a host name is rarely anything but letters,
 * digits, dots and hyphens), the ends are trimmed, and it is cut to 64 characters. Undefined when nothing printable is left, so the register
 * request carries no name and the row reads as unnamed.
 */
export function defaultRunnerName(hostname: string): string | undefined {
  const kept = [...hostname].filter((ch) => isValidRunnerName(ch) || ch === " ").join("").trim();
  const cut = [...kept].slice(0, RUNNER_NAME_MAX).join("").trim();
  return isValidRunnerName(cut) ? cut : undefined;
}
export const readHostname = (): string => os.hostname();
