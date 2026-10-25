/**
 * Resource-aware admission (D#6 C43-4): before each claim the runner works out, from what the machine has free right now, how many more jobs of
 * each class it could take, and says so on the claim as `capacity`. A claim is offered a slot only when the class's footprint fits the headroom:
 *  - memory: MemAvailable minus a reserve for the person's own work (25% of RAM, at least 2 GB, or the person's setting);
 *  - CPU: the sustained load (the smaller of the 1-minute and 5-minute averages, so a brief spike does not zero the heavy class) against the cores
 *    minus a reserve for the person (20% of the cores, or the person's `cpu-reserve`), plus the cores of jobs still starting up;
 *  - disk: the workspace and store volumes keep a minimum free;
 *  - safety ceilings (total 8, heavy 4 by default, lowered by the person) and the person's pause.
 * Progress floor: with no job in hand (and not paused, disk fine) one light job is always admitted, so a busy machine cannot starve the runner.
 * Jobs that started only moments ago have not yet grown into their footprint, so their footprint is held back from the headroom until they
 * have (the ramp) or have used it. Nothing here stops a job: when the headroom shrinks the runner only stops asking for more.
 * A finished job's measured peak (its own scope's, else the machine-wide drop) feeds the footprint store.
 */
import { MAX_HEAVY_CAPACITY, MAX_LIGHT_CAPACITY, jobClassOfRole, type LimitedBy, type ClaimCapacity, type JobClass } from "@fulcrumaxe/runner-protocol";
import type { Claimed } from "./client.js";
import { GIB, type Footprint, type FootprintStore } from "./footprints.js";
import type { ResourceProbe, ResourceReading } from "./resources.js";
import type { RunnerSettings } from "../runnerSettings.js";
import type { UsageState } from "./usageGate.js";

export interface AdmissionConfig {
  /** Fraction of RAM kept free for the person (default 0.25). */
  reserveFraction: number;
  minReserveBytes: number;
  /** Sustained load per core above which no job is claimed (default 0.8); the person's `cpu-reserve` replaces the margin it leaves. */
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
  /** What stops the next job of each class (null: one fits). Both classes, where `limitedBy` names the machine-wide one only. */
  limits: Record<JobClass, LimitedBy | null>;
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
  runId: string;
  /** Largest machine-wide memory drop attributed to this job so far: the fallback for a job with no readable scope. */
  drop: number;
  /** The job's own scope peak, once the scope has been read at all (then the drop is never used). */
  scopePeak: number | undefined;
}

/** What the job has needed: its own scope's peak where there is one, else the shared machine drop. */
const peakOf = (job: InHand): number => job.scopePeak ?? job.drop;

export interface AdmissionDeps {
  probe: ResourceProbe;
  footprints: FootprintStore;
  settings: () => RunnerSettings;
  paused: () => boolean;
  /** The heavy class's memory budget in bytes (C43-5); absent: no such check. Read for every claim. */
  heavyBudgetBytes?: () => number;
  /** The plan's usage limit (D#6 C43-6): blocked claims nothing; single claims only with no job in hand. Absent: neither (an `api_key` runner). */
  usage?: () => UsageState;
  /** The job's own peak memory from its cgroup scope (D#6 RUNNER-FOOTPRINT-POLLUTION); undefined: not readable (no scope, macOS), and the shared machine drop is used for that job. */
  scopePeak?: (runId: string) => number | undefined;
  /** Called once the job's peak has been recorded. */
  releaseScope?: (runId: string) => void;
  now: () => number;
  /** Starts a repeating call and returns how to stop it. Default: an unref'd interval. */
  every?: (fn: () => void, ms: number) => () => void;
  config?: Partial<AdmissionConfig>;
}

const clamp = (value: number, max: number): number => Math.max(0, Math.min(max, Math.floor(value)));

export function reserveBytesOf(reading: ResourceReading, config: AdmissionConfig, settings: RunnerSettings): number {
  return settings.reserveGb === undefined ? Math.max(reading.totalMemBytes * config.reserveFraction, config.minReserveBytes) : settings.reserveGb * GIB;
}

/** Cores kept free for the person: their `cpu-reserve`, else the share the load-per-core threshold leaves (20% of the cores). */
export function cpuReserveOf(reading: ResourceReading, config: AdmissionConfig, settings: RunnerSettings): number {
  return settings.cpuReserve === undefined ? reading.cores * (1 - config.loadPerCore) : settings.cpuReserve;
}

/** The load that counts (note: min(load1, load5) can admit for about a minute at the start of an outside CPU burst, until the 1-minute figure catches up): the smaller of the 1-minute and 5-minute averages, so a spike that just began (5 minutes still low) or one that just ended (1 minute already low) does not block. */
export const sustainedLoad = (reading: ResourceReading): number => Math.min(reading.load1, reading.load5 ?? reading.load1);

export function createAdmission(deps: AdmissionDeps): Admission {
  const config: AdmissionConfig = { ...DEFAULT_ADMISSION, ...deps.config };
  const inHand = new Set<InHand>();
  let stopTimer: (() => void) | undefined;

  const sample = (): void => {
    if (inHand.size === 0) return;
    const share = inHand.size;
    const avail = deps.probe.read().availMemBytes;
    // A job in its own scope is measured by that scope. Only a job without one falls back to the machine-wide drop since it started, shared by the jobs in
    // hand: that cannot tell the job from its neighbours or from outside work (builds, CI), so it overstates.
    for (const job of inHand) {
      const own = deps.scopePeak?.(job.runId);
      if (own !== undefined) job.scopePeak = Math.max(job.scopePeak ?? 0, own);
      else job.drop = Math.max(job.drop, (job.baseline - avail) / share);
    }
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
        heldMem += Math.max(0, job.footprint.memBytes - Math.max(0, peakOf(job)));
        heldCores += job.footprint.cores;
      }
    }
    const headMem = reading.availMemBytes - reserveBytesOf(reading, config, settings) - heldMem;
    const headCores = reading.cores - cpuReserveOf(reading, config, settings) - sustainedLoad(reading) - heldCores;
    const diskOk = reading.freeDiskBytes === undefined || reading.freeDiskBytes >= config.minFreeDiskBytes;
    const paused = deps.paused();
    const usage = deps.usage?.() ?? { blocked: false, single: false };
    // Near the plan's limit the runner takes one job at a time: nothing while a job is in hand, and at most one when none is.
    const usageHeld = usage.blocked || (usage.single && inHand.size > 0);
    const totalRoom = Math.max(0, settings.ceilingTotal - used.light - used.heavy);

    /** More jobs of one class that fit, and what stops the next one. */
    const fit = (cls: JobClass): { count: number; limit: LimitedBy | null } => {
      const footprint = deps.footprints.classEstimate(cls);
      const classRoom = cls === "heavy" ? Math.max(0, settings.ceilingHeavy - used.heavy) : totalRoom;
      // A heavy job is also held back while the machine's free memory is below the heavy job's hard budget (C43-5): it could be given the whole budget.
      const belowBudget = cls === "heavy" && deps.heavyBudgetBytes !== undefined && reading.availMemBytes < deps.heavyBudgetBytes();
      const byMem = belowBudget ? 0 : Math.floor(Math.max(0, headMem) / footprint.memBytes);
      const byCpu = Math.floor(Math.max(0, headCores) / footprint.cores);
      const count = paused || usageHeld || !diskOk ? 0 : Math.min(totalRoom, classRoom, byMem, byCpu, usage.single ? 1 : Infinity);
      if (count > 0) return { count, limit: null };
      if (paused) return { count: 0, limit: "paused" };
      if (usageHeld) return { count: 0, limit: "usage_limit" };
      if (Math.min(totalRoom, classRoom) === 0) return { count: 0, limit: "ceiling" };
      if (!diskOk) return { count: 0, limit: "disk" };
      return { count: 0, limit: byMem === 0 ? "memory" : "cpu" };
    };
    const light = fit("light");
    const heavy = fit("heavy");
    // Progress floor: a runner with no job in hand that is neither paused nor out of disk may take ONE light job even when memory or CPU headroom is short,
    // so a busy machine never starves the runner for good. Heavy stays at 0 until the headroom is there.
    if (inHand.size === 0 && !paused && !usageHeld && diskOk && totalRoom > 0 && light.count === 0 && heavy.count === 0) light.count = 1;
    const ceilingLight = Math.min(MAX_LIGHT_CAPACITY, light.count + used.light);
    const ceilingHeavy = Math.min(MAX_HEAVY_CAPACITY, heavy.count + used.heavy);
    // Named only when nothing at all can be claimed; the light class is the one that fits most easily, so its reason is the binding one.
    const limitedBy = light.count === 0 && heavy.count === 0 ? light.limit : null;
    // What the claim reports is wider: also the heavy reason when only the heavy class is held back. A heavy run waits on a runner that still shows free
    // light slots, and without this the cloud could not say why (a light run never reads it: it has a free slot).
    const reported = limitedBy ?? (heavy.count === 0 && light.count > 0 ? heavy.limit : null);
    return {
      limits: { light: light.count > 0 ? null : light.limit, heavy: heavy.count > 0 ? null : heavy.limit },
      capacity: {
        light: { limit: ceilingLight, in_use: clamp(used.light, MAX_LIGHT_CAPACITY) },
        heavy: { limit: ceilingHeavy, in_use: clamp(used.heavy, MAX_HEAVY_CAPACITY) },
        limited_by: reported,
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
      const entry: InHand = { cls: jobClassOfRole(job.role), repo, role: job.role, startedAt: deps.now(), footprint: deps.footprints.estimate(repo, job.role), baseline: deps.probe.read().availMemBytes, runId: claimed.runId, drop: 0, scopePeak: undefined };
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
        deps.footprints.record(entry.repo, entry.role, peakOf(entry));
        deps.releaseScope?.(entry.runId);
      };
    },
  };
}
