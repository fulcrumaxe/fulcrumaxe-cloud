/**
 * Resource-aware admission (D#6 C43-4): before each claim the runner works out, from what the machine has free right now, how many more jobs of
 * each class it could take, and says so on the claim as `capacity`. A claim is offered a slot only when the class's footprint fits the headroom:
 *  - memory: MemAvailable minus a reserve for the person's own work (25% of RAM, at least 2 GB, or the person's setting);
 *  - CPU: the 1-minute load per core against a threshold (0.8), plus the cores of jobs still starting up;
 *  - disk: the workspace and store volumes keep a minimum free;
 *  - safety ceilings (total 8, heavy 4 by default, lowered by the person) and the person's pause.
 * Progress floor: with no job in hand (and not paused, disk fine) one light job is always admitted, so a busy machine cannot starve the runner.
 * Jobs that started only moments ago have not yet grown into their footprint, so their footprint is held back from the headroom until they
 * have (the ramp) or have used it. Nothing here stops a job: when the headroom shrinks the runner only stops asking for more.
 * A finished job's measured peak feeds the footprint store.
 */
import { MAX_HEAVY_CAPACITY, MAX_LIGHT_CAPACITY, jobClassOfRole, type LimitedBy, type ClaimCapacity, type JobClass } from "@fulcrumaxe/runner-protocol";
import type { Claimed } from "./client.js";
import { GIB, type Footprint, type FootprintStore } from "./footprints.js";
import type { ResourceProbe, ResourceReading } from "./resources.js";
import type { RunnerSettings } from "../runnerSettings.js";

export interface AdmissionConfig {
  /** Fraction of RAM kept free for the person (default 0.25). */
  reserveFraction: number;
  minReserveBytes: number;
  /** 1-minute load per core above which no job is claimed (default 0.8). */
  loadPerCore: number;
  /** Free space the workspace and store volumes keep (default 5 GB). */
  minFreeDiskBytes: number;
  /** How long a new job's footprint is held back from the headroom (default 90 s). */
  rampMs: number;
  /** How often the peak of the jobs in hand is sampled. */
  sampleMs: number;
}

export const DEFAULT_ADMISSION: AdmissionConfig = { reserveFraction: 0.25, minReserveBytes: 2 * GIB, loadPerCore: 0.8, minFreeDiskBytes: 5 * GIB, rampMs: 90_000, sampleMs: 5_000 };

export interface Snapshot {
  capacity: ClaimCapacity;
  /** More jobs of each class that fit right now. */
  free: Record<JobClass, number>;
  limitedBy: LimitedBy | null;
}

export interface Admission {
  /** Reads the machine and the settings now. Called before every claim. */
  snapshot(): Snapshot;
  /** The class a claimed run counts as, from its role. A role the table lacks is heavy. */
  classOf(claimed: Claimed): JobClass;
  /** Counts the run as in hand from now; the returned function ends it and records its measured peak. */
  begin(claimed: Claimed): () => void;
  /** Takes one peak sample of every job in hand (also done on a timer while any is). */
  sample(): void;
}

interface InHand {
  cls: JobClass;
  repo: string;
  role: string;
  startedAt: number;
  footprint: Footprint;
  baseline: number;
  /** Largest memory drop attributed to this job so far. */
  peak: number;
}

export interface AdmissionDeps {
  probe: ResourceProbe;
  footprints: FootprintStore;
  settings: () => RunnerSettings;
  paused: () => boolean;
  now: () => number;
  /** Starts a repeating call and returns how to stop it. Default: an unref'd interval. */
  every?: (fn: () => void, ms: number) => () => void;
  config?: Partial<AdmissionConfig>;
}

const clamp = (value: number, max: number): number => Math.max(0, Math.min(max, Math.floor(value)));

export function reserveBytesOf(reading: ResourceReading, config: AdmissionConfig, settings: RunnerSettings): number {
  return settings.reserveGb === undefined ? Math.max(reading.totalMemBytes * config.reserveFraction, config.minReserveBytes) : settings.reserveGb * GIB;
}

export function createAdmission(deps: AdmissionDeps): Admission {
  const config: AdmissionConfig = { ...DEFAULT_ADMISSION, ...deps.config };
  const inHand = new Set<InHand>();
  let stopTimer: (() => void) | undefined;

  const sample = (): void => {
    if (inHand.size === 0) return;
    const share = inHand.size;
    const avail = deps.probe.read().availMemBytes;
    // The machine does not say which job used the memory, so the drop since each job started is shared by the jobs in hand. The per-job limits of C43-5 will give exact figures.
    for (const job of inHand) job.peak = Math.max(job.peak, (job.baseline - avail) / share);
  };

  function snapshot(): Snapshot {
    const settings = deps.settings();
    const reading = deps.probe.read();
    const now = deps.now();
    const used: Record<JobClass, number> = { light: 0, heavy: 0 };
    let heldMem = 0;
    let heldCores = 0;
    for (const job of inHand) {
      used[job.cls] += 1;
      if (now - job.startedAt < config.rampMs) {
        heldMem += Math.max(0, job.footprint.memBytes - Math.max(0, job.peak));
        heldCores += job.footprint.cores;
      }
    }
    const headMem = reading.availMemBytes - reserveBytesOf(reading, config, settings) - heldMem;
    const headCores = reading.cores * config.loadPerCore - reading.load1 - heldCores;
    const diskOk = reading.freeDiskBytes === undefined || reading.freeDiskBytes >= config.minFreeDiskBytes;
    const paused = deps.paused();
    const totalRoom = Math.max(0, settings.ceilingTotal - used.light - used.heavy);

    /** More jobs of one class that fit, and what stops the next one. */
    const fit = (cls: JobClass): { count: number; limit: LimitedBy | null } => {
      const footprint = deps.footprints.classEstimate(cls);
      const classRoom = cls === "heavy" ? Math.max(0, settings.ceilingHeavy - used.heavy) : totalRoom;
      const byMem = Math.floor(Math.max(0, headMem) / footprint.memBytes);
      const byCpu = Math.floor(Math.max(0, headCores) / footprint.cores);
      const count = paused || !diskOk ? 0 : Math.min(totalRoom, classRoom, byMem, byCpu);
      if (count > 0) return { count, limit: null };
      if (paused) return { count: 0, limit: "paused" };
      if (Math.min(totalRoom, classRoom) === 0) return { count: 0, limit: "ceiling" };
      if (!diskOk) return { count: 0, limit: "disk" };
      return { count: 0, limit: byMem === 0 ? "memory" : "cpu" };
    };
    const light = fit("light");
    const heavy = fit("heavy");
    // Progress floor: a runner with no job in hand that is neither paused nor out of disk may take ONE light job even when memory or CPU headroom is short,
    // so a busy machine never starves the runner for good. Heavy stays at 0 until the headroom is there.
    if (inHand.size === 0 && !paused && diskOk && totalRoom > 0 && light.count === 0 && heavy.count === 0) light.count = 1;
    const ceilingLight = Math.min(MAX_LIGHT_CAPACITY, light.count + used.light);
    const ceilingHeavy = Math.min(MAX_HEAVY_CAPACITY, heavy.count + used.heavy);
    // Named only when nothing at all can be claimed; the light class is the one that fits most easily, so its reason is the binding one.
    const limitedBy = light.count === 0 && heavy.count === 0 ? light.limit : null;
    return {
      capacity: {
        light: { limit: ceilingLight, in_use: clamp(used.light, MAX_LIGHT_CAPACITY) },
        heavy: { limit: ceilingHeavy, in_use: clamp(used.heavy, MAX_HEAVY_CAPACITY) },
        limited_by: limitedBy,
      },
      free: { light: light.count, heavy: heavy.count },
      limitedBy,
    };
  }

  const every = deps.every ?? ((fn, ms) => {
    const timer = setInterval(fn, ms);
    timer.unref();
    return () => clearInterval(timer);
  });

  return {
    snapshot,
    sample,
    classOf: (claimed) => jobClassOfRole(claimed.signedJob.job.role),
    begin(claimed) {
      const job = claimed.signedJob.job;
      const repo = `${job.repo.owner}/${job.repo.name}`;
      const entry: InHand = { cls: jobClassOfRole(job.role), repo, role: job.role, startedAt: deps.now(), footprint: deps.footprints.estimate(repo, job.role), baseline: deps.probe.read().availMemBytes, peak: 0 };
      inHand.add(entry);
      stopTimer ??= every(sample, config.sampleMs);
      return () => {
        if (!inHand.has(entry)) return;
        sample();
        inHand.delete(entry);
        if (inHand.size === 0) {
          stopTimer?.();
          stopTimer = undefined;
        }
        deps.footprints.record(entry.repo, entry.role, entry.peak);
      };
    },
  };
}
