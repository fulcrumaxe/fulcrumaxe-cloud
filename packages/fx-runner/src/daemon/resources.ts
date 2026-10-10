/**
 * What this machine has free right now (D#6 C43-4): memory, CPU load and disk. One synchronous reading, taken before each claim. Nothing is
 * cached here, so a person who starts heavy work is seen on the very next claim. The reading is a port: the admission logic and its tests use a fake.
 *
 * Memory: on Linux `os.freemem()` is MemAvailable (libuv reads it that way), the memory a new program can use without swapping. On macOS libuv
 * counts only free pages, which is far too low (the system keeps its caches in inactive pages), so the caller supplies the latest `vm_stat` text
 * and the free + inactive + speculative pages are used instead. This file starts no program and reads no `/proc` file.
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
  cores: number;
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
}

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
  return {
    read: () => ({ totalMemBytes: os.totalmem(), availMemBytes: availMem(), load1: os.loadavg()[0] ?? 0, cores: Math.max(1, os.availableParallelism()), freeDiskBytes: freeDisk() }),
  };
}
