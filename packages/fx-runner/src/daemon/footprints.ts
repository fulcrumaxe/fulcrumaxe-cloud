/**
 * What a job of each kind has needed in memory (D#6 C43-4). A new job class starts at a default; every finished job adds its measured peak, kept
 * per repo and role, and the estimate moves toward the rolling p90 of the last samples. The store is one small file inside the runner's own state
 * directory: written through a temporary file and a rename (never through a link), read only when it is a plain file, and a damaged or odd file is
 * the same as no file.
 */
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { jobClassOfRole, type JobClass } from "@fulcrumaxe/runner-protocol";
import { writePrivateFile } from "../config.js";

export const GIB = 1024 ** 3;
export const FOOTPRINT_FILE = "footprints.json";
/** Defaults before anything is learned: light 1 GB and half a core, heavy 3 GB and two cores. */
export const DEFAULT_FOOTPRINT: Readonly<Record<JobClass, { memBytes: number; cores: number }>> = { light: { memBytes: 1 * GIB, cores: 0.5 }, heavy: { memBytes: 3 * GIB, cores: 2 } };
const SAMPLES_KEPT = 20;
const KEYS_KEPT = 200;
const MIN_ESTIMATE = GIB / 4;
const MAX_ESTIMATE = 64 * GIB;
const MAX_FILE_BYTES = 256 * 1024;

export interface Footprint {
  memBytes: number;
  cores: number;
}

export interface FootprintStore {
  /** The estimate for one repo and role: the default pulled toward the p90 of what its finished jobs measured. */
  estimate(repo: string, role: string): Footprint;
  /** The estimate a claim is admitted by, before the job's repo and role are known: the largest estimate seen for the class, else the default. */
  classEstimate(cls: JobClass): Footprint;
  /** Adds a finished job's measured peak (bytes) and saves. */
  record(repo: string, role: string, peakBytes: number): void;
}

function load(file: string): Map<string, number[]> {
  const entries = new Map<string, number[]>();
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return entries;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { entries?: Record<string, unknown> };
    for (const [key, value] of Object.entries(parsed.entries ?? {})) {
      if (Array.isArray(value)) entries.set(key, value.filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0).slice(-SAMPLES_KEPT));
    }
  } catch {
    // fx-swallow-ok: a missing or damaged footprint file is the same as none; the defaults apply and the next record starts it again
  }
  return entries;
}

/** The p90 (nearest rank) of a non-empty list. */
export function p90(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)]!;
}

export function createFootprintStore(stateDir: string): FootprintStore {
  const file = path.join(stateDir, FOOTPRINT_FILE);
  const key = (repo: string, role: string): string => `${repo}|${role}`;
  const estimateFrom = (samples: readonly number[] | undefined, cls: JobClass): Footprint => {
    const base = DEFAULT_FOOTPRINT[cls];
    if (samples === undefined || samples.length === 0) return base;
    // The more samples, the more the p90 counts: one sample moves a third of the way, ten move five sixths.
    const weight = samples.length / (samples.length + 2);
    const mem = base.memBytes * (1 - weight) + p90(samples) * weight;
    return { memBytes: Math.min(MAX_ESTIMATE, Math.max(MIN_ESTIMATE, Math.round(mem))), cores: base.cores };
  };
  return {
    estimate: (repo, role) => estimateFrom(load(file).get(key(repo, role)), jobClassOfRole(role)),
    classEstimate(cls) {
      let largest = DEFAULT_FOOTPRINT[cls];
      for (const [name, samples] of load(file)) {
        const role = name.slice(name.lastIndexOf("|") + 1);
        if (jobClassOfRole(role) !== cls) continue;
        const estimate = estimateFrom(samples, cls);
        if (estimate.memBytes > largest.memBytes) largest = estimate;
      }
      return largest;
    },
    record(repo, role, peakBytes) {
      if (!Number.isFinite(peakBytes) || peakBytes <= 0) return;
      const entries = load(file);
      const name = key(repo, role);
      const samples = [...(entries.get(name) ?? []), Math.round(peakBytes)].slice(-SAMPLES_KEPT);
      entries.delete(name);
      entries.set(name, samples);
      const kept = [...entries].slice(-KEYS_KEPT);
      try {
        writePrivateFile(stateDir, FOOTPRINT_FILE, `${JSON.stringify({ version: 1, entries: Object.fromEntries(kept) })}\n`);
      } catch {
        // fx-swallow-ok: learning is best effort; a failed save leaves the estimate where it was and never touches the job
      }
    },
  };
}
