/**
 * D#2 RLR-5: how a deployment reads its runs' logs, decided once from its settings and handed to the sandbox target (this package reads no `process.env`;
 * the worker passes the settings in).
 *
 * `FX_READER_SLICE_MS` turns the sliced reader on and sets how long one slice may read. Without it a run is read by the invocation that started it, as before.
 * `FX_READER_CRASH` and `FX_RECORDER_TAMPER` are fault flags for the staging smoke: the first makes the reader of one chosen slice die between two saves (a
 * takeover), the second empties the record file the way a hostile agent could. They are refused on any other deployment, at startup, never ignored.
 */

/** The shortest and longest slice a setting may ask for, and the default when the setting is a valid number below or above them it is clamped. */
export const READER_SLICE_MIN_MS = 10_000;
export const READER_SLICE_MAX_MS = 600_000;
/** Left of the invocation's own deadline for what follows the read: the exit sequence, the stop, the measure and the settle. */
export const SLICE_EXIT_RESERVE_MS = 150_000;

export interface ReaderFaults {
  /** The slice whose lease epoch this is dies between two saves, once (epochs only rise, so no later slice matches). */
  crashAtEpoch?: number;
  /** The slice after the first empties the record file before it reads (it has a consumed prefix to lose by then). */
  tamper?: boolean;
}

export interface ReaderConfig {
  sliceMs: number;
  faults: ReaderFaults;
}

export class ReaderFaultRefusedError extends Error {
  constructor(public readonly flag: "FX_READER_CRASH" | "FX_RECORDER_TAMPER") {
    super(`${flag} is a staging-only fault flag and this deployment is not staging`);
    this.name = "ReaderFaultRefusedError";
  }
}

const positiveInt = (v: string | undefined): number | undefined => {
  const t = v?.trim();
  if (t === undefined || !/^[0-9]{1,9}$/.test(t)) return undefined;
  const n = Number(t);
  return n > 0 ? n : undefined;
};

/**
 * Undefined when `FX_READER_SLICE_MS` is not a positive integer (the feature is off, and fault flags have nothing to act on). A fault flag set anywhere but on
 * a deployment whose `FX_DEPLOY_KIND` is `staging` throws `ReaderFaultRefusedError`, whether or not the reader is on.
 */
export function readerConfigFromEnv(env: Readonly<Record<string, string | undefined>>): ReaderConfig | undefined {
  const crash = positiveInt(env.FX_READER_CRASH);
  const tamper = env.FX_RECORDER_TAMPER?.trim() === "1";
  // Staging runs in Vercel's Production environment of the staging project, which says FX_DEPLOY_ENV=staging. A Vercel production deployment that does not say so
  // (or says production) is refused even if its FX_DEPLOY_KIND reads staging, so one mistyped kind cannot arm a fault on the real project.
  const vercelProduction = env.VERCEL_ENV?.trim() === "production";
  const staging = env.FX_DEPLOY_KIND?.trim() === "staging" && env.FX_DEPLOY_ENV?.trim() !== "production" && (!vercelProduction || env.FX_DEPLOY_ENV?.trim() === "staging");
  if (!staging) {
    if (env.FX_READER_CRASH !== undefined && env.FX_READER_CRASH.trim() !== "") throw new ReaderFaultRefusedError("FX_READER_CRASH");
    if (env.FX_RECORDER_TAMPER !== undefined && env.FX_RECORDER_TAMPER.trim() !== "") throw new ReaderFaultRefusedError("FX_RECORDER_TAMPER");
  }
  const ms = positiveInt(env.FX_READER_SLICE_MS);
  if (ms === undefined) return undefined;
  return { sliceMs: Math.min(Math.max(ms, READER_SLICE_MIN_MS), READER_SLICE_MAX_MS), faults: { ...(crash !== undefined && { crashAtEpoch: crash }), ...(tamper && { tamper: true }) } };
}

/**
 * The end of one slice: its length, held to what is left of the invocation. The reserve covers the exit sequence and the finalize that follow a read that ends
 * the run. With no deadline known (a long-lived process) the slice is its full length.
 */
export function sliceEndMs(cfg: ReaderConfig, nowMs: number, deadlineMs: number | undefined): number {
  const own = nowMs + cfg.sliceMs;
  if (deadlineMs === undefined) return own;
  return Math.min(own, Math.max(deadlineMs - SLICE_EXIT_RESERVE_MS, nowMs + READER_SLICE_MIN_MS / 2));
}
