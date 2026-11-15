/**
 * What this machine has free right now (D#6 C43-4): memory, CPU load and disk. One synchronous reading, taken before each claim. Nothing is
 * cached here, so a person who starts heavy work is seen on the very next claim. The reading is a port: the admission logic and its tests use a fake.
 *
 * Memory: on Linux `os.freemem()` is MemAvailable (libuv reads it that way), the memory a new program can use without swapping. On macOS libuv
 * counts only free pages, which is far too low (the system keeps its caches in inactive pages), so the caller supplies the latest `vm_stat` text
 * and the free + inactive + speculative pages are used instead. This file starts no program.
 *
 * CPU: the load average also counts tasks stuck in uninterruptible disk wait, so swap or IO makes an idle CPU look busy. On Linux the probe therefore
 * also reports the cores actually busy: the change in `os.cpus()` busy time (user + nice + sys + irq, which libuv reads from the kernel's counters; idle
 * and disk wait are not in it) divided by the wall time between two readings. The previous sample lives in the probe. Where that cannot be read (not
 * Linux, no cores listed, no earlier sample yet, a clock that did not advance) the field is absent and admission falls back to the load average.
 */
import { existsSync, statfsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ResourceReading {
  totalMemBytes: number;
  /** Memory a new program could use without pushing the machine to swap. */
  availMemBytes: number;
  /** The 1-minute load average. */
  load1: number;
  /** The 5-minute load average; absent (a fake reading) reads as the 1-minute one. */
  load5?: number;
  cores: number;
  /** Cores actually busy since the previous reading (Linux, from the kernel's CPU time counters); absent: not measurable, and the load average is used instead. */
  cpuBusyCores?: number;
  /** The smallest free space of the volumes jobs write to (workspaces and the package store); undefined when it cannot be read. */
  freeDiskBytes: number | undefined;
}

export interface ResourceProbe {
  read(): ResourceReading;
}

/** Free + inactive + speculative pages of `vm_stat`, in bytes (the macOS equivalent of MemAvailable); undefined when the text has no page size. */
export function parseVmStat(vmStat: string): number | undefined {
  const pageSize = Number(vmStat.match(/page size of (\d+) bytes/)?.[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return undefined;
  const pages = (name: string): number => Number(vmStat.match(new RegExp(`^Pages ${name}:\\s+(\\d+)\\.`, "m"))?.[1] ?? 0);
  return (pages("free") + pages("inactive") + pages("speculative")) * pageSize;
}

export interface RealProbeOptions {
  platform: NodeJS.Platform;
  /** Directories whose volumes must have room (the workspace root and the cache root). A directory not made yet counts as its nearest existing parent. */
  diskPaths: readonly string[];
  /** macOS only: the latest output of `vm_stat`, run by the caller through the engine's process start. Absent or unreadable: the free-page count. */
  vmStatText?: () => string | undefined;
  /** Linux only: the per-core CPU times, as `os.cpus()` gives them (ms); throws or returns nothing when unreadable. A test seam. */
  cpuTimes?: () => ReadonlyArray<{ times: { user: number; nice: number; sys: number; irq: number } }>;
  /** The clock, in ms. A test seam. */
  nowMs?: () => number;
  /** Test seam: the core count. Default: the machine's. */
  cores?: () => number;
}

/** A window shorter than this (ms) is too noisy to read: the last good figure stands and the sample is kept. */
const MIN_WINDOW_MS = 300;

/** The directory itself, or its nearest ancestor that exists: a workspace root is made on first use, but its volume is the one that counts. */
function nearestExisting(dir: string): string {
  let current = dir;
  while (!existsSync(current) && path.dirname(current) !== current) current = path.dirname(current);
  return current;
}

export function realResourceProbe(options: RealProbeOptions): ResourceProbe {
  const availMem = (): number => {
    if (options.platform === "darwin") {
      const text = options.vmStatText?.();
      const fromPages = text === undefined ? undefined : parseVmStat(text);
      if (fromPages !== undefined) return fromPages;
    }
    return os.freemem();
  };
  const freeDisk = (): number | undefined => {
    let least: number | undefined;
    for (const dir of options.diskPaths) {
      try {
        const stats = statfsSync(nearestExisting(dir));
        const free = stats.bavail * stats.bsize;
        if (least === undefined || free < least) least = free;
      } catch {
        // fx-swallow-ok: a volume that cannot be read is not counted; with none readable the disk check is skipped
      }
    }
    return least;
  };
  const coreCount = (): number => Math.max(1, options.cores?.() ?? os.availableParallelism());
  let prev: { busyMs: number; at: number } | undefined;
  let lastBusyCores: number | undefined;
  const busyCores = (): number | undefined => {
    if (options.platform !== "linux") return undefined;
    let sample: { busyMs: number; at: number } | undefined;
    try {
      const cpus = options.cpuTimes?.() ?? os.cpus();
      if (cpus.length > 0) sample = { busyMs: cpus.reduce((sum, c) => sum + c.times.user + c.times.nice + c.times.sys + c.times.irq, 0), at: (options.nowMs ?? Date.now)() };
    } catch {
      // fx-swallow-ok: no readable CPU times means the load average is used, which errs on the careful side
      sample = undefined;
    }
    if (sample === undefined) {
      prev = undefined;
      lastBusyCores = undefined;
      return undefined;
    }
    if (prev === undefined) {
      prev = sample;
      return undefined;
    }
    const wall = sample.at - prev.at;
    if (wall < 0 || sample.busyMs < prev.busyMs) {
      prev = sample; // the clock or the counters went backwards: start again
      lastBusyCores = undefined;
      return undefined;
    }
    if (wall >= MIN_WINDOW_MS) {
      lastBusyCores = Math.min(coreCount(), (sample.busyMs - prev.busyMs) / wall);
      prev = sample;
    }
    return lastBusyCores;
  };
  return {
    read: () => {
      const cores = coreCount();
      const busy = busyCores();
      return { totalMemBytes: os.totalmem(), availMemBytes: availMem(), load1: os.loadavg()[0] ?? 0, load5: os.loadavg()[1] ?? 0, cores, ...(busy === undefined ? {} : { cpuBusyCores: busy }), freeDiskBytes: freeDisk() };
    },
  };
}

/** The machine's total memory, for callers that may not name a node built-in themselves. */
export const machineMemoryBytes = (): number => os.totalmem();
